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
 *   live:hyperliquid-trade Hyperliquid's own answer to this network — POST api.hyperliquid.xyz/info {"type":"meta"}, its public market
 *                          list, read as every keyless answer here is — and, at the same time, its own line (its Terms of Use §1.6) held to
 *                          where this user is now (location.ts: the place from Polymarket's location check, used for this one answer and
 *                          never shown; the service's own place when it gives one). Its terms close it to the United States, Ontario and
 *                          the sanctioned territories; its edge refusing this network, a ban or an outage is said as that
 *   live:robinhood         the sign-in's discovery: its two public metadata documents, and that a client may register itself (OAuthSignIn)
 *   live:metamask          `mm auth status` on this machine: installed, and signed in — a check mm makes with MetaMask's servers each time,
 *                          so a network that does not reach them is no answer just now, not a missing sign-in
 *
 * The connections read by address read public data, but from hosts a network may refuse or filter (Ukraine's order to block
 * polymarket.com), so each asks its host one keyless question too, about nobody — no address of the user's is sent:
 *   live:polymarket        GET data-api.polymarket.com/v2/positions?user=<the zero address>&limit=1
 *   live:hyperliquid       POST api.hyperliquid.xyz/info {"type":"meta"}
 *   live:wallet            eth_chainId at each chain's public endpoint (chain.ts: PORTFOLIO_RPC_<CHAIN>, else the library's default):
 *                          connectable when one answers, the others named
 *   live:ondo              eth_chainId at Ethereum's
 * A connection without a question of its own (a test's stand-ins) has nothing to ask: it answers "ok" without asking anything.
 *
 * States: ok · location (the venue does not serve this location: its rule, said in its words; the account looks for no way around it) ·
 * close-only (the venue lets this location close positions and open none: connected, what is held can be sold) · setup (something on this
 * machine first: mm installed, mm signed in) · closed (the venue offers no way in for this account) · unreachable (no answer just now; the
 * connection asks again when it is made; a venue's ban of this address, or a wait it asked for, is kept until its time: `until`).
 *
 * Every answer is the one the venue gives the network this account runs on — the user's own, on the user's machine — asked when it is
 * needed. Nothing a builder's machine was answered is written into the account. */
import type { Refusal } from "../../core/errors.ts";
import { CHAINS, type ChainName } from "./chain.ts";
import { exchangeClock, type OpenExchange } from "./exchange.ts";
import { HYPERLIQUID_RULE, locator, type Locator } from "./location.ts";
import type { RunMm } from "./metamask.ts";
import { CLOSE_ONLY_WORDS, POLYMARKET_GEOBLOCK, polymarketLocation } from "./polymarket-clob.ts";
import { holdBackMs } from "./public-markets.ts";
import type { OAuthSignIn } from "./signin.ts";
import { unaddressed } from "../refuse.ts";
import { bannedUntil, edgeRefused, edgeWords, notTheApiWords, REGION, venueSaidNo, type Http, type HttpReply } from "./types.ts";

export type ReachState = "ok" | "location" | "close-only" | "setup" | "closed" | "unreachable";
export interface Reach {
  connector: string;
  state: ReachState;
  /** the account's sentence, and the venue's own words where it said some */
  said?: string | undefined;
  /** when it was asked (ISO) */
  at: string;
  /** the venue holds this machine off — a ban of its address for too many requests, or a wait it asked for — until then (milliseconds,
   * the venue's own time or wait; nothing about the place or the address): nothing is asked of it before then (reachKeepMs) */
  until?: number | undefined;
  /** that hold is a ban of this machine's address, which asking again lengthens */
  ban?: true | undefined;
}
export interface ReachDeps {
  http: Http;
  clock: () => number;
  open?: OpenExchange | undefined;
  mm: RunMm;
  signIn?: ((kind: string) => OAuthSignIn | undefined) | undefined;
  /** the account's own place for this network (the service's one Locator, kept in memory as for the list of venues), so a place already
   * learned decides Hyperliquid's line with no second lookup; without it a place is asked for this answer alone */
  where?: Locator | undefined;
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
/** the place's own sources asked in turn, each in its own time — Polymarket's check, the trace on two hosts, the part of the country — so
 * the place is given that long in all, and the fallback is never cut off halfway */
const PLACE_BUDGET_MS = 4 * PROBE_MS + 500;
/** Hyperliquid's public info endpoint, and the keyless read that asks whether it answers this network: its market list */
const HL_INFO = "https://api.hyperliquid.xyz/info";

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

/** A refusal as a state: the venue's location rule, no answer, or no way in. No answer that the venue holds longer than a moment — a ban
 * of this address until its time, a rate limit's wait (holdBackMs, the one hold rule) — carries that time, and is kept until then. The
 * hold is as long as the venue asked; `until` is on the same clock as `at` */
const fromRefusal = (connector: string, r: Refusal, at: string, words = ""): Reach => {
  const state: ReachState = r.code === "E_VENUE_GEOBLOCKED" ? "location" : r.code === "E_VENUE_UNREACHABLE" ? "unreachable" : "closed";
  const hold = state === "unreachable" ? holdBackMs(r) : 0;
  const ban = (r.native as { ban?: unknown } | undefined)?.ban === true;
  return { connector, state, said: `${r.message}${words ? `. It answered: “${words}”` : ""}`, at, ...(hold > 20_000 ? { until: Date.parse(at) + hold, ...(ban ? { ban: true as const } : {}) } : {}) };
};

/** One keyless answer, read the one way for every connection that asks one: the place named (451, or the venue's words), the server in
 * front of it refusing this network, a ban or a rate limit (held until its time), no answer (5xx, or nothing), and a page in place of the
 * API's answer (a filtering network's, a captive portal's: not the venue) — else the venue answered (401, 400, 403 included: the key is
 * what it wants) */
function readReply(connector: string, name: string, r: HttpReply, at: string): Reach {
  if (r.status === 451 || (r.status >= 400 && REGION.test(r.text))) {
    const words = venueWords(r.text);
    return { connector, state: "location", said: `${name} does not serve this location: that is its own rule, and the account does not look for a way around it${words ? `. It answered: “${words}”` : ""}`, at };
  }
  // a page from the server in front of the venue refusing this network is not the API asking for a key: it refuses, and says no more
  if (edgeRefused(r.status, r.text)) return { connector, state: "location", said: edgeWords(name, r.status, r.text), at };
  // this address banned for too many requests, or rate-limited (Cloudflare's 1015 among them): not an answer to connect on, and held until
  // the venue's time — read as the account's other readers read it
  if (r.status === 418 || r.status === 429 || bannedUntil(r.text) !== undefined) return fromRefusal(connector, venueSaidNo(connector, name, r.status, r.text, [], r), at);
  if (r.status >= 500 || r.status === 0) return { connector, state: "unreachable", said: `${name} did not answer just now (HTTP ${r.status}); connecting asks again`, at };
  // a 2xx that is not JSON (a page, an empty body), or a page for "not found": something on this network answered in the venue's place
  const page = /^\s*</.test(String(r.text ?? ""));
  if ((r.status >= 200 && r.status < 300 && r.status !== 204 && r.body === undefined) || (r.status === 404 && page)) return { connector, state: "unreachable", said: `${notTheApiWords(name)}; connecting asks again`, at };
  return { connector, state: "ok", at };
}

/** one keyless question — a GET, or a POST of a JSON body — read as above */
async function answersHere(connector: string, name: string, url: string, deps: ReachDeps, at: string, post?: unknown): Promise<Reach> {
  let r: HttpReply;
  try {
    r = await deps.http(url, post === undefined ? { headers: { accept: "application/json" }, timeoutMs: PROBE_MS } : { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(post), timeoutMs: PROBE_MS });
  } catch {
    return { connector, state: "unreachable", said: `${name} did not answer just now; connecting asks again`, at };
  }
  return readReply(connector, name, r, at);
}

/** nobody's address: what a connection read by address asks its host about, so that no address of the user's is sent to ask */
const NOBODY = "0x0000000000000000000000000000000000000000";
/** a chain's public endpoint, as the chain reader reaches it (chain.ts) */
const endpointOf = (chain: ChainName): string => process.env[CHAINS[chain].env] || CHAINS[chain].chain.rpcUrls.default.http[0]!;
/** the chains' public endpoints asked whether they answer this network: one JSON-RPC eth_chainId each, which names no address. Connectable
 * when one answers (a wallet is read from the chains that do), the ones that did not named; none answering is no answer, or the endpoints'
 * own refusal when every one refused */
async function chainsAnswer(connector: string, chains: ChainName[], deps: ReachDeps, at: string): Promise<Reach> {
  const each = await Promise.all(chains.map((c) => answersHere(connector, `${c}'s public endpoint`, endpointOf(c), deps, at, { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] })));
  const quiet = chains.filter((_, i) => each[i]!.state !== "ok");
  if (quiet.length < chains.length) return { connector, state: "ok", ...(quiet.length ? { said: `${quiet.join(", ")} did not answer just now: read from the others; connecting asks again` } : {}), at };
  if (chains.length === 1 || each.every((r) => r.state === "location")) return each[0]!;
  return { connector, state: "unreachable", said: `none of the chains' public endpoints answered just now (${chains.join(", ")}); connecting asks again`, at };
}

const inTime = <T, L>(p: Promise<T>, late: L, ms = PROBE_MS + 500): Promise<T | L> => {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<L>((r) => (t = setTimeout(() => r(late), ms)))]).finally(() => clearTimeout(t));
};

/** mm's answers that say MetaMask's servers did not answer this network just now (its sign-in check asks them each time): not a missing
 * sign-in. The runner's own MM_TIMEOUT (mm killed after its time) among them */
const MM_QUIET = new Set(["NETWORK_UNREACHABLE", "NETWORK_TIMEOUT", "RATE_LIMITED", "MM_TIMEOUT", "ABORTED", "INTROSPECT_FAILED"]);

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
    // an edge's refusal of the check itself (edgeWords) is complete as it is: the check did not answer blocked, its edge refused
    const blocked = here.code === "E_VENUE_GEOBLOCKED" && (here.native as { edge?: boolean } | undefined)?.edge !== true;
    return { connector, state: here.code === "E_VENUE_GEOBLOCKED" ? "location" : "unreachable", said: blocked ? `${here.message}. Its location check answered blocked` : here.message, at };
  }
  if (kind === "hyperliquid-trade") {
    // Hyperliquid's own answer to this network, and its terms held to where this user is now (the verdict only, never the place), at once.
    // Its own words or its edge's refusal come first; then its terms; connectable only when it answered AND the terms serve the place
    const where = deps.where ?? locator({ http: deps.http, clock: deps.clock, timeoutMs: PROBE_MS });
    const [api, v] = await Promise.all([
      answersHere(connector, "Hyperliquid", HL_INFO, deps, at, { type: "meta" }),
      inTime(where.verdict(HYPERLIQUID_RULE), "late" as const, PLACE_BUDGET_MS),
    ]);
    if (api.state === "location") return api;
    if (v === "closed") return { connector, state: "location", said: HYPERLIQUID_RULE.closedWords, at };
    if (api.state !== "ok") return api;
    if (v === "served") return { connector, state: "ok", at };
    if (v === "unknown" && where.missing?.() === "part") return { connector, state: "unreachable", said: `where in its country this machine is could not be learned just now (the lookup of the part of the country did not answer), and Hyperliquid's own line (${HYPERLIQUID_RULE.cite}) closes part of that country; connecting asks again`, at };
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
    // `mm auth status` checks mm's sign-in with MetaMask's servers each time: their not answering this network is no answer just now
    const quiet = (code: string): Reach => ({ connector, state: "unreachable", said: `MetaMask's sign-in check did not answer just now (${code}); connecting asks again`, at });
    try {
      const st = await deps.mm<{ authenticated?: unknown; reason?: unknown }>(["auth", "status"], { timeoutMs: PROBE_MS + 2000 });
      if (st && st.authenticated === true) return { connector, state: "ok", at };
      const reason = typeof st?.reason === "string" ? st.reason : "";
      if (MM_QUIET.has(reason)) return quiet(reason);
      // mm does not say whether MetaMask did not answer or the sign-in lapsed: said as that, and asked again soon
      if (reason === "TOKEN_REFRESH_FAILED" || reason === "REFRESH_CLI_TOKEN_FAILED") return { connector, state: "unreachable", said: `mm could not renew its sign-in with MetaMask (${reason}): MetaMask may not have answered, or the sign-in lapsed. Check again, and if it persists run mm login in a terminal`, at };
      return { connector, state: "setup", said: "mm is not signed in on this machine: run mm login in a terminal, then check again", at };
    } catch (err) {
      const e = err as { code?: string; message?: string };
      const code = typeof e?.code === "string" ? e.code : "";
      if (code === "ENOENT" || /ENOENT|not installed/i.test(String(e?.message))) return { connector, state: "setup", said: "the mm command line is not on this machine: install it with npm install -g @metamask/agent-wallet, sign in with mm login, then check again", at };
      if (MM_QUIET.has(code) || (code === "AUTH_ERROR" && /introspect failed with HTTP 5\d\d/i.test(String(e?.message)))) return quiet(code);
      return { connector, state: "setup", said: `mm could not say whether it is signed in: ${String(e?.message ?? err).slice(0, 160)}`, at };
    }
  }
  // read by address: the host asked, about nobody
  if (kind === "polymarket") return answersHere(connector, "Polymarket's data API", `https://data-api.polymarket.com/v2/positions?user=${NOBODY}&limit=1`, deps, at);
  if (kind === "hyperliquid") return answersHere(connector, "Hyperliquid", HL_INFO, deps, at, { type: "meta" });
  if (kind === "wallet") return chainsAnswer(connector, Object.keys(CHAINS) as ChainName[], deps, at);
  if (kind === "ondo") return chainsAnswer(connector, ["Ethereum"], deps, at);
  // a connection with no question of its own
  return { connector, state: "ok", at };
}

/** how long an answer is kept: a location rule ten minutes (as public-markets keeps one), a missing setup and no answer a few seconds — a
 * ban or a rate limit until the venue's time (an hour at most) — an answer two minutes. `now` on the clock the reach was asked with */
export const reachKeepMs = (r: Reach, now: number = Date.now()): number => {
  if (r.state === "unreachable" && r.until !== undefined && r.until > now) return Math.min(r.until - now, 3_600_000);
  return r.state === "location" || r.state === "close-only" || r.state === "closed" ? 600_000 : r.state === "ok" ? 120_000 : r.state === "setup" ? 5_000 : 20_000;
};

/** a venue's running ban of this machine's address, as a reach learned it: until when, or nothing */
export const reachBanUntil = (r: Reach, now: number = Date.now()): number | undefined => (r.ban && r.until !== undefined && r.until > now ? r.until : undefined);

