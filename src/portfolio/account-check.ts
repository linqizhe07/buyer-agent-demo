/** ACCOUNT CHECK — what the Account can reach from where it runs: run it on the machine the Account runs on, and anyone can see which venues
 * serve them and which do not, in each venue's own words. Nothing in the Account decides that from anywhere else: a venue's location rule is
 * the venue's answer to the network the Account runs on, asked at the time (live/reach.ts), so someone where a venue serves them gets all of
 * it, and someone where it does not is told so before making a key. This prints those answers.
 *
 *   npm run account:check                    every connection's first, keyless question (live/reach.ts) and every public market source
 *                                            (live/public-markets.ts): no key, token or address is sent anywhere
 *   npm run account:check -- --keys          also opens each connection whose key file is in the home, read-only — what the venue says the
 *                                            key may do, the balances it reads, its markets, its earn products — and nothing else: no order,
 *                                            no movement, nothing written to the account's ledger
 *   npm run account:check -- --home <dir>    the home whose key files --keys reads (default $BUYER_HOME or ~/.buyer-agent-demo)
 *   npm run account:check -- --json          the same, as JSON
 *
 * No IP address, country or region is printed or kept: a venue that does not serve the place says so in its own words, and that is all.
 * Its output is meant to be pasted to someone else (a teammate where the venues serve them, or the developer): it holds no key, balance
 * amount or address.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isRefusal, type Refusal } from "../core/errors.ts";
import { defaultHome } from "./home.ts";
import { no } from "./refuse.ts";
import { exchangeList, openExchange } from "./live/exchange.ts";
import { CONNECTORS, openLive, parseConnector, type LiveDeps } from "./live/index.ts";
import { realMm } from "./live/metamask.ts";
import { publicChain } from "./live/chain.ts";
import { WalletProofs } from "./live/proof.ts";
import { publicPrices } from "./live/prices.ts";
import { publicSources, type Listing, type PublicSource } from "./live/public-markets.ts";
import { reachOf, type Reach } from "./live/reach.ts";
import { ROBINHOOD_MCP } from "./live/robinhood.ts";
import { OAuthSignIn } from "./live/signin.ts";
import { realHttp } from "./live/types.ts";

/** the exchanges asked by default: the tiles of Connect an account, and the ones whose public data Markets reads (pre-IPO venues included) */
export const CHECK_EXCHANGES = ["okx", "kraken", "coinbase", "bybit", "binance", "kucoin", "gate", "bitget", "mexc", "deribit", "krakenfutures", "kucoinfutures"];
const SOURCE_MS = 12_000;

export interface CheckReport {
  at: string;
  connections: Array<Reach & { name: string }>;
  sources: Array<{ id: string; name: string; rows?: number | undefined; preIpo?: string[] | undefined; said?: string | undefined; code?: string | undefined }>;
  keys?: Array<{ venue: string; connector: string; can?: string[] | undefined; balances?: number | undefined; markets?: number | undefined; said?: string | undefined; code?: string | undefined }> | undefined;
}

const within = <T>(p: Promise<T>, ms: number, late: T): Promise<T> => {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<T>((r) => (t = setTimeout(() => r(late), ms)))]).finally(() => clearTimeout(t));
};
const lateNo = (what: string): Refusal => no("E_VENUE_UNREACHABLE", { message: `${what} did not answer in ${SOURCE_MS / 1000} s` });

/** every connection's first question, and every public source's listing, from here; with `keys`, each connection whose key file is in
 * `home`, opened read-only */
export async function accountCheck(o: { home: string; keys?: boolean; deps?: Partial<LiveDeps> & { sources?: PublicSource[] } } = { home: defaultHome() }): Promise<CheckReport> {
  const http = o.deps?.http ?? realHttp;
  const clock = o.deps?.clock ?? Date.now;
  const open = o.deps?.openExchange ?? openExchange;
  const mm = o.deps?.mm ?? realMm();
  const signIn = new OAuthSignIn({ resource: ROBINHOOD_MCP, name: "Robinhood", venue: "robinhood", http, clock });
  const names = new Map(CONNECTORS.map((c) => [c.kind, c.label.split(" · ")[0]!]));
  // every connection that has a question of its own: each exchange by its id, and every other kind that is not read by address
  const connectors = [...CHECK_EXCHANGES.map((x) => `live:exchange:${x}`), ...CONNECTORS.filter((c) => c.kind !== "exchange" && c.needs !== "address").map((c) => `live:${c.kind}`)];
  const exchanges = await exchangeList().catch(() => []);
  const exName = (id: string) => exchanges.find((x) => x.id === id)?.name ?? id;
  const connections = await Promise.all(
    connectors.map(async (c) => {
      const r = await reachOf(c, { http, clock, open, mm, signIn: (k) => (k === "robinhood" ? signIn : undefined) });
      const p = parseConnector(c);
      return { ...r, name: p?.kind === "exchange" ? exName(p.variant) : names.get(p?.kind ?? "") ?? c };
    }),
  );

  const sources = await Promise.all(
    (o.deps?.sources ?? publicSources({ http, open, clock })).map(async (s) => {
      const got = await within(s.listings({ limit: 200 }).catch((err) => lateNo(`${s.name} (${String((err as Error)?.message ?? err).slice(0, 80)})`)), SOURCE_MS, lateNo(s.name));
      if (isRefusal(got)) return { id: s.id, name: s.name, said: got.message, code: got.code };
      const pre = (got as Listing[]).filter((l) => (l as { implied?: unknown }).implied !== undefined || l.category === "Pre-IPO");
      return { id: s.id, name: s.name, rows: got.length, ...(pre.length ? { preIpo: [...new Set(pre.map((l) => l.group?.title ?? l.name ?? l.symbol))] } : {}) };
    }),
  );

  if (!o.keys) return { at: new Date(clock()).toISOString(), connections, sources };
  // with keys: each key file in the home, opened as the connection that reads it — read-only: nothing is placed, moved or written
  const dir = join(o.home, "credentials");
  const venues = existsSync(dir) ? readdirSync(dir).filter((v) => existsSync(join(dir, v, "api-key.json"))) : [];
  const deps: LiveDeps = { home: o.home, http, clock, mm, openExchange: open, proofs: new WalletProofs(), chain: o.deps?.chain ?? publicChain(), price: o.deps?.price ?? publicPrices({ open }), signIn: (k) => (k === "robinhood" ? signIn : undefined), ...(o.deps ?? {}) } as LiveDeps;
  const keys = await Promise.all(
    venues.map(async (venue) => {
      const kind = CONNECTORS.find((c) => c.kind === venue && c.needs === "key-file")?.kind;
      const connector = kind ? `live:${kind}` : exchanges.some((x) => x.id === venue) ? `live:exchange:${venue}` : "";
      if (!connector) return { venue, connector: "", said: `no connection reads credentials/${venue}/ by itself: connect it from the page, which names its exchange` };
      const opened = await within(openLive({ venue, connector, label: "", reference: "" }, deps), SOURCE_MS * 2, lateNo(venue) as never);
      if (isRefusal(opened)) return { venue, connector, said: opened.message, code: opened.code };
      const markets = opened.source.trader ? await within(opened.source.trader.markets("").then((m) => (isRefusal(m) ? undefined : m.length)), SOURCE_MS, undefined) : undefined;
      return { venue, connector, can: opened.source.probe.can, balances: opened.first.length, markets };
    }),
  );
  return { at: new Date(clock()).toISOString(), connections, sources, keys };
}

const ANSWER: Record<Reach["state"], string> = { ok: "answers", location: "Not served here", setup: "Set up first", closed: "No way in", unreachable: "No answer just now" };
const cell = (s: string | undefined) => String(s ?? "").replace(/\|/g, "/").replace(/\s+/g, " ").trim();

/** the report as Markdown, to paste */
export function checkMarkdown(r: CheckReport): string {
  const out = [`# Account check · ${r.at}`, "", "Asked from the network this machine is on. No IP address, place, key or balance is in here.", "", "## Connections — each venue's first, keyless question", "", "| Connection | Answer | In the venue's words |", "|---|---|---|"];
  for (const c of r.connections) out.push(`| ${cell(c.name)} | ${ANSWER[c.state]} | ${c.state === "ok" ? "" : cell(c.said)} |`);
  out.push("", "## Public market data (Markets: venues not connected)", "", "| Source | Rows | Pre-IPO | Or: what it said |", "|---|---|---|---|");
  // a venue read for its pre-IPO contracts is its own source, beside its tickers: named so
  for (const s of r.sources) out.push(`| ${cell(s.name)}${/preipo/i.test(s.id) ? " (pre-IPO)" : ""} | ${s.rows ?? ""} | ${cell((s.preIpo ?? []).join(", "))} | ${cell(s.said)} |`);
  if (r.keys) {
    out.push("", "## Key files in the home — opened read-only", "");
    if (!r.keys.length) out.push("No key file in the home's credentials/.");
    else {
      out.push("| Key file | Connection | The venue says the key can | Balances read | Markets | Or: what it said |", "|---|---|---|---|---|---|");
      for (const k of r.keys) out.push(`| credentials/${cell(k.venue)}/ | ${cell(k.connector)} | ${cell((k.can ?? []).join(", "))} | ${k.balances ?? ""} | ${k.markets ?? ""} | ${cell(k.said)} |`);
    }
  }
  return `${out.join("\n")}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const at = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const report = await accountCheck({ home: at("--home") ?? defaultHome(), keys: args.includes("--keys") });
  process.stdout.write(args.includes("--json") ? `${JSON.stringify(report, null, 2)}\n` : checkMarkdown(report));
  process.exit(0);
}
