/** Before a key is made or a sign-in started: does the venue a connection reaches answer from this machine at all? Each connection's own
 * first, keyless question, asked when the owner opens the list of accounts to connect — so a venue that does not serve this location says
 * so on its tile, in its own words, before the owner makes a key it would refuse. No key, token or address is sent; nothing is registered.
 *
 *   live:exchange:<id>     the exchange's public clock, as exchangeSource asks it first (exchangeClock)
 *   live:alpaca            GET /v2/clock with no key: the 401 it answers is an answer
 *   live:robinhood-crypto  GET /api/v1/crypto/trading/accounts/ with no key: the 400 it answers is an answer
 *   live:kalshi            GET /trade-api/v2/exchange/status, public
 *   live:polymarket-us     GET gateway.polymarket.us/v1/markets?limit=1, its public market data ("No API key needed"): what Polymarket
 *                          US's own servers answer the network the Account runs on, asked there each time. Its terms set who may open an
 *                          account (live/eligibility.ts shows them); this asks only whether it answers here
 *   live:polymarket-trade  Polymarket's location check, as the connection asks it first (it answers blocked or not), read with Polymarket's
 *                          own lists of how far blocked goes: completely, or close-only (the United States among those), or on its website
 *                          alone. The IP and the place it names are never kept
 *   live:hyperliquid-trade Hyperliquid's own line (its Terms of Use §1.6), held to where this user is now (location.ts: the place from
 *                          Polymarket's location check, used for this one answer and never shown): Hyperliquid's API answers from anywhere,
 *                          and its terms are what close it to the United States, Ontario and the sanctioned territories
 *   live:robinhood         the sign-in's discovery: its two public metadata documents, and that a client may register itself (OAuthSignIn)
 *   live:metamask          `mm auth status` on this machine: installed, and signed in
 *
 * The connections read by address (wallet, polymarket, hyperliquid, ondo) make public reads that are the same wherever they are made, and a
 * connection without a question of its own (a test's stand-ins) has nothing to ask: both answer "ok" without asking anything.
 *
 * States: ok · location (the venue does not serve this location: its rule, said in its words; the account looks for no way around it) ·
 * close-only (the venue lets this location close positions and open none: connected, what is held can be sold) · setup (something on this
 * machine first: mm installed, mm signed in) · closed (the venue offers no way in for this account) · unreachable (no answer just now; the
 * connection asks again when it is made).
 *
 * Every answer is the one the venue gives the network this account runs on — the user's own, on the user's machine — asked when it is
 * needed. Nothing a builder's machine was answered is written into the account. */
import type { Refusal } from "../../core/errors.ts";
import { exchangeClock, type OpenExchange } from "./exchange.ts";
import { HYPERLIQUID_RULE, locator } from "./location.ts";
import type { RunMm } from "./metamask.ts";
import { CLOSE_ONLY_WORDS, POLYMARKET_GEOBLOCK, polymarketLocation } from "./polymarket-clob.ts";
import type { OAuthSignIn } from "./signin.ts";
import { unaddressed } from "../refuse.ts";
import { edgeRefused, edgeWords, REGION, type Http, type HttpReply } from "./types.ts";

export type ReachState = "ok" | "location" | "close-only" | "setup" | "closed" | "unreachable";
export interface Reach {
  connector: string;
  state: ReachState;
  /** the account's sentence, and the venue's own words where it said some */
  said?: string | undefined;
  /** when it was asked (ISO) */
  at: string;
}
export interface ReachDeps {
  http: Http;
  clock: () => number;
  open?: OpenExchange | undefined;
  mm: RunMm;
  signIn?: ((kind: string) => OAuthSignIn | undefined) | undefined;
}

/** the venues' names, for the sentences */
const NAMES: Record<string, string> = { alpaca: "Alpaca", "robinhood-crypto": "Robinhood Crypto", kalshi: "Kalshi", "polymarket-us": "Polymarket US", "polymarket-trade": "Polymarket", robinhood: "Robinhood", metamask: "MetaMask Agent Wallet" };
/** the keyless address each HTTP connection asks first */
const FIRST: Record<string, string> = {
  alpaca: "https://api.alpaca.markets/v2/clock",
  "robinhood-crypto": "https://trading.robinhood.com/api/v1/crypto/trading/accounts/",
  kalshi: "https://external-api.kalshi.com/trade-api/v2/exchange/status",
  "polymarket-us": "https://gateway.polymarket.us/v1/markets?limit=1",
};
/** a probe answers in this long, or it counts as no answer just now */
const PROBE_MS = 6000;

/** the venue's own sentence in what it answered: the message of its JSON, else the sentence that names the place; HTML taken out, cut to
 * a sentence a person reads */
export function venueWords(text: string): string {
  const folded = String(text ?? "").replace(/\s+/g, " ");
  const json = /"(?:msg|message|retMsg|error_description|error)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(folded);
  // the address this machine reached the venue from, if the venue repeats it, is never kept
  if (json && json[1]) return unaddressed(json[1].replace(/\\"/g, '"').replace(/\\\//g, "/").slice(0, 300));
  // an answer from a server in front of the venue, its sentence unquoted in braces (Bybit's CloudFront: "{ error:The Amazon CloudFront … }")
  const loose = /\{\s*(?:error|message)\s*:\s*([^{}"]+?)\s*\}/i.exec(folded);
  if (loose && loose[1]) return unaddressed(loose[1].trim().slice(0, 300));
  const plain = folded.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
  const sentence = plain.split(/(?<=[.!?])\s+(?=[A-Z])/).find((s) => REGION.test(s));
  return unaddressed((sentence ?? "").trim().slice(0, 300));
}

/** a refusal as a state: the venue's location rule, no answer, or no way in */
const fromRefusal = (connector: string, r: Refusal, at: string, words = ""): Reach => {
  const state: ReachState = r.code === "E_VENUE_GEOBLOCKED" ? "location" : r.code === "E_VENUE_UNREACHABLE" ? "unreachable" : "closed";
  return { connector, state, said: `${r.message}${words ? `. It answered: “${words}”` : ""}`, at };
};

/** one keyless GET: any answer below 500 that does not name the place is an answer (401, 400, 403 included: the key is what it wants) */
async function answersHere(connector: string, name: string, url: string, deps: ReachDeps, at: string): Promise<Reach> {
  let r: HttpReply;
  try {
    r = await deps.http(url, { headers: { accept: "application/json" }, timeoutMs: PROBE_MS });
  } catch {
    return { connector, state: "unreachable", said: `${name} did not answer just now; connecting asks again`, at };
  }
  if (r.status === 451 || (r.status >= 400 && REGION.test(r.text))) {
    const words = venueWords(r.text);
    return { connector, state: "location", said: `${name} does not serve this location: that is its own rule, and the account does not look for a way around it${words ? `. It answered: “${words}”` : ""}`, at };
  }
  // a page from the server in front of the venue refusing this network is not the API asking for a key: it refuses, and says no more
  if (edgeRefused(r.status, r.text)) return { connector, state: "location", said: edgeWords(name, r.status, r.text), at };
  if (r.status >= 500 || r.status === 0) return { connector, state: "unreachable", said: `${name} did not answer just now (HTTP ${r.status}); connecting asks again`, at };
  return { connector, state: "ok", at };
}

const inTime = <T, L>(p: Promise<T>, late: L): Promise<T | L> => {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<L>((r) => (t = setTimeout(() => r(late), PROBE_MS + 500)))]).finally(() => clearTimeout(t));
};

/** what one connection's venue answers from here, before any key */
export async function reachOf(connector: string, deps: ReachDeps): Promise<Reach> {
  const at = new Date(deps.clock()).toISOString();
  const m = /^live:([a-z0-9-]+)(?::([a-z0-9-]+))?$/.exec(connector);
  if (!m) return { connector, state: "closed", said: `there is no connection called "${connector}"`, at };
  const [kind, variant] = [m[1]!, m[2] ?? ""];
  const late: Reach = { connector, state: "unreachable", said: "no answer just now; connecting asks again", at };
  if (kind === "exchange") {
    if (!variant) return { connector, state: "ok", at };
    const r = await inTime(exchangeClock(variant, variant, deps.open), "late" as const);
    if (r === "late") return late;
    if (!r) return { connector, state: "ok", at };
    return fromRefusal(connector, r, at, venueWords(String((r.native as { said?: unknown } | undefined)?.said ?? "")));
  }
  if (FIRST[kind]) return answersHere(connector, NAMES[kind]!, FIRST[kind]!, deps, at);
  if (kind === "polymarket-trade") {
    let r: HttpReply;
    try {
      r = await deps.http(POLYMARKET_GEOBLOCK, { headers: { accept: "application/json" }, timeoutMs: PROBE_MS });
    } catch {
      return { connector, state: "unreachable", said: "Polymarket's location check did not answer just now; connecting asks it again", at };
    }
    const here = polymarketLocation(r, "polymarket", "Polymarket");
    if (here === "open") return { connector, state: "ok", at };
    // its own sentence only: the place and the IP it names stay out
    if (here === "close-only") return { connector, state: "close-only", said: `${CLOSE_ONLY_WORDS}. Connected, the account sells what the wallet holds there and cancels its orders; it opens nothing`, at };
    return { connector, state: here.code === "E_VENUE_GEOBLOCKED" ? "location" : "unreachable", said: here.code === "E_VENUE_GEOBLOCKED" ? `${here.message}. Its location check answered blocked` : here.message, at };
  }
  if (kind === "hyperliquid-trade") {
    // Hyperliquid's terms, held to where this user is now: the verdict only, never the place
    const v = await inTime(locator({ http: deps.http, clock: deps.clock, timeoutMs: PROBE_MS }).verdict(HYPERLIQUID_RULE), "late" as const);
    if (v === "closed") return { connector, state: "location", said: HYPERLIQUID_RULE.closedWords, at };
    if (v === "served") return { connector, state: "ok", at };
    return { connector, state: "unreachable", said: `where this machine is could not be learned just now, so Hyperliquid's own line (${HYPERLIQUID_RULE.cite}) could not be held to it; connecting asks again`, at };
  }
  if (kind === "robinhood") {
    const s = deps.signIn?.("robinhood");
    if (!s) return { connector, state: "closed", said: "this server has no Robinhood sign-in", at };
    const r = await inTime(s.reachable(), "late" as const);
    if (r === "late") return late;
    return r ? fromRefusal(connector, r, at) : { connector, state: "ok", at };
  }
  if (kind === "metamask") {
    try {
      const st = await deps.mm<{ authenticated?: unknown }>(["auth", "status"], { timeoutMs: PROBE_MS + 2000 });
      if (st && st.authenticated === true) return { connector, state: "ok", at };
      return { connector, state: "setup", said: "mm is not signed in on this machine: run mm login in a terminal, then check again", at };
    } catch (err) {
      const e = err as { code?: string; message?: string };
      if (e?.code === "ENOENT" || /ENOENT|not installed/i.test(String(e?.message))) return { connector, state: "setup", said: "the mm command line is not on this machine: install it with npm install -g @metamask/agent-wallet, sign in with mm login, then check again", at };
      return { connector, state: "setup", said: `mm could not say whether it is signed in: ${String(e?.message ?? err).slice(0, 160)}`, at };
    }
  }
  // read by address, or a connection with no question of its own
  return { connector, state: "ok", at };
}

/** how long an answer is kept: a location rule ten minutes (as public-markets keeps one), a missing setup and no answer a few seconds, an
 * answer two minutes */
export const reachKeepMs = (r: Reach): number => (r.state === "location" || r.state === "close-only" || r.state === "closed" ? 600_000 : r.state === "ok" ? 120_000 : r.state === "setup" ? 5_000 : 20_000);

