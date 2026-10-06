/** WHAT IS THERE TO TRADE: every market the account can see — at the venues the owner has connected, and from the public market data of
 * venues it has not (public-markets.ts) — as one list, the same thing at several venues being one row, so the owner and an agent can browse
 * what moves, what trades most and what closes soon, and see at a glance where each thing can be traded now and where a connection is
 * needed first.
 *
 * What it asks, every source at once:
 *
 *   a connected venue    trader.markets(query)            what it lists that matches (its own few to start from, when nothing is typed)
 *                        trader.stats(symbols)            the last 24 hours of those of them whose listing carries no 24-hour figure,
 *                                                         where the trader has the call
 *                        trader.events({…})               its event contracts: what closes within the window, and (with no window) its
 *                                                         busiest, where the trader has the call
 *   a public source      source.listings({q, limit})      its well-known or busiest markets, or the ones matching
 *                        source.events({closingWithinMs}) what closes within the window, where it lists events
 *
 * and nothing else: no order, nothing signed. A public source is not asked when the venue it is the public side of is connected: the
 * connected venue speaks for itself. Each source has one time limit for all of its calls (four seconds by default); what has answered when it
 * is up is shown, and the rest is said to be missing (`missing`, with the venue's own words where it gave some), so one slow or refusing venue
 * never holds up the rest — Binance's "restricted location" is shown as exactly that. A call is not stopped when its time runs out (the
 * interfaces have no way to stop one); its answer is just not waited for.
 *
 * What is one row:
 *   · a coin, by normalBase (compare.ts): BTC/USDT at an exchange, BTC-USD at Robinhood Crypto, WBTC from a wallet are one BTC. A stablecoin
 *     is not a row of its own. A dated future is not listed; a perpetual is a row of its own (Perps), by its base;
 *   · a stock, by its ticker; a token that stands for a share or a fund (an RWA), by its symbol: an AAPL Stock Token is not an AAPL share.
 *     A token is an RWA when its source lists such tokens (Robinhood's public Stock Token list) or its market carries the RWA category (a
 *     wallet's tokens an issuer stands behind, dex.ts): a Stock Token from a wallet and from Robinhood's public list is one row (`rwa:NVDA`),
 *     traded at the wallet and priced at both; an Ondo Stock (`rwa:NVDAON`) and an xStock (`rwa:NVDAX`) are rows of their own. Such a
 *     row, and each venue line of it, carries the issuer and the issuer's own eligibility words where the venue's market says them;
 *   · an event contract, by its question: `kalshi:<market ticker>` or `pm:<condition id>`, its legs (YES and NO, or a market's named
 *     outcomes) folded into the one row as `outcomes`;
 *   · each venue appears once in a row, by its most traded market for it (its symbol is the one the account's order there names), and a
 *     price more than 10% from the middle of the others' (three venues or more) may be another token under the same name: it is left out of
 *     the row and said in `missing`, as compareAcross leaves it out of the best.
 * A row's price and 24-hour change are its most traded venue's (`changeFrom` says which venue the change is from). Its volume is counted
 * once per market: venues that read the same exchange's data (two accounts at OKX; MetaMask's mm, Polymarket's CLOB and its public Gamma
 * data, which all report Gamma's volume for one Polymarket market) count it once, the largest figure of them, and different exchanges'
 * are summed; an event's volume is its one market's, whichever venues read it. A venue the owner connected that reads an exchange makes that
 * exchange's public listing of the same thing redundant — it trades there already — so the public line is left out of the row. No figure is
 * estimated: a venue that does not say a 24-hour change gives none (Kraken), and
 * Kalshi's volume, which it counts in contracts, is `contracts24h`, never dollars. Only to ORDER the busiest is a Kalshi contract counted at
 * the dollar it pays at settlement.
 *
 * What is made of the rows:
 *   · tabs: Crypto, Stocks, RWAs, Predictions, Perps, and Macro and Sports from the venues' own categories (categories.ts); Now is what
 *     closes within a day (busiest first), the biggest movers and the most traded. A tab is there only when something is in it;
 *   · movers: coins, stocks, perpetuals and tokens by the size of their 24-hour change, only those whose 24-hour dollar volume is at least
 *     `moversMinUsd` ($1M by default), so that a thin market's jump is not news — one chip per asset: a coin's perpetual is the same asset
 *     as the coin, and the coin's own market is the one shown when it moves enough;
 *   · closing: the busiest events that close within the window (a day by default), the soonest first.
 */
import { isRefusal, type Refusal } from "../../core/errors.ts";
import { isRwaMarket, TABS, tabsOfCategories, type TabId } from "./categories.ts";
import { normalBase, type CompareMissing } from "./compare.ts";
import type { EventsQuery, Listing, PublicSource } from "./public-markets.ts";
import { inDollars, type LiveTrader, type Market, type MarketStats } from "./trade.ts";
import { isStable } from "./types.ts";

export interface ExploreVenue {
  /** the account's id for the venue */
  id: string;
  name: string;
  trader: LiveTrader;
  /** the connection it was made with (`live:exchange:okx`, `live:kalshi`): a public source of the same connection is then not asked */
  connector?: string | undefined;
}

export interface ExploreSources {
  connected?: ExploreVenue[] | undefined;
  public?: PublicSource[] | undefined;
}

export type ExploreKind = "coin" | "stock" | "perp" | "event" | "rwa";
export type ExploreSort = "volume" | "movers" | "closing";

export interface ExploreOptions {
  /** a few letters of a symbol or a name: only the rows that match */
  q?: string | undefined;
  /** only this tab's rows in `items` (absent: every row) */
  tab?: TabId | undefined;
  /** `items` by volume (the default; Now keeps its own order), by the size of the 24-hour change, or by how soon they close */
  sort?: ExploreSort | undefined;
  /** at most this many rows in `items` (60) */
  limit?: number | undefined;
  /** how long each source has for all of its calls, in milliseconds (4000) */
  timeoutMs?: number | undefined;
  /** how many markets each source is asked for (40) */
  perSource?: number | undefined;
  /** how many movers, closing events and parts of Now (8 each) */
  top?: number | undefined;
  /** the least 24-hour dollar volume a mover must have: one figure for every kind, or by kind ($1,000,000) */
  moversMinUsd?: number | Partial<Record<Exclude<ExploreKind, "event">, number>> | undefined;
  /** what "closing soon" means, in milliseconds from now (a day) */
  closingWithinMs?: number | undefined;
  clock?: (() => number) | undefined;
}

/** one venue where a row's thing is listed */
export interface ExploreAt {
  venue: string;
  venueName: string;
  /** the market there: at a connected venue, exactly what the account's order there names; at a public one, what it would name once the
   * venue is connected. An event's is its first outcome's (each outcome's are in `outcomes`) */
  symbol: string;
  /** the owner has connected this venue */
  connected: boolean;
  /** may the connected key or sign-in trade there: what the venue said (`unknown`: its first refusal will say); a public listing: false */
  canTrade: boolean | "unknown";
  /** read from the venue's public market data, without a key */
  public: boolean;
  price?: number | undefined;
  /** the market takes orders now, as the venue says */
  open?: boolean | undefined;
  /** a public listing: the venue to connect to trade it, and the connection that does */
  connectTo?: string | undefined;
  connector?: string | undefined;
  /** why it cannot be traded there (the venue's words), or what the venue says of the market; for a token an issuer stands behind, whom the
   * issuer says it is not for, or the issuer's rule that keeps it from being swapped */
  note?: string | undefined;
  /** a token an issuer stands behind: who issues it, and whom the issuer says it is not for, in the issuer's own words */
  issuer?: string | undefined;
  eligibility?: string | undefined;
}

export interface ExploreOutcome {
  /** "Yes", "No", or the outcome's own name ("Falcons") */
  label: string;
  /** dollars per contract or share, which is the market's probability for it */
  price?: number | undefined;
  bid?: number | undefined;
  ask?: number | undefined;
  /** in dollars per contract over 24 hours (0.03 = 3¢) */
  change24h?: number | undefined;
  /** the outcome's market at each venue that lists it */
  at: Array<{ venue: string; symbol: string }>;
}

export interface ExploreItem {
  /** `coin:BTC`, `stock:AAPL`, `perp:ETH`, `rwa:NVDA`, `kalshi:<market ticker>`, `pm:<condition id>` */
  key: string;
  kind: ExploreKind;
  name: string;
  /** the one name for the thing (BTC, AAPL); an event has none */
  base?: string | undefined;
  /** dollars; an event's is its first outcome's */
  price?: number | undefined;
  changePct24h?: number | undefined;
  change24h?: number | undefined;
  /** the venue whose 24-hour change is shown */
  changeFrom?: { venue: string; venueName: string } | undefined;
  /** the dollars traded in 24 hours: each exchange's market counted once, the exchanges summed (an event: its one market's) */
  volumeUsd24h?: number | undefined;
  /** the event contracts traded in 24 hours, where a venue counts contracts instead of dollars (Kalshi) */
  contracts24h?: number | undefined;
  /** the venue's own words */
  category?: string | undefined;
  closeTime?: string | undefined;
  /** the venue's event an event market belongs to, where an event holds several */
  event?: { id: string; title: string } | undefined;
  /** a perpetual's funding rate per interval and when it is next paid, from its most traded venue that says */
  fundingRate?: number | undefined;
  nextFundingAt?: string | undefined;
  outcomes?: ExploreOutcome[] | undefined;
  /** a token an issuer stands behind (kind rwa): who issues it and whom the issuer says it is not for, from the first venue that says */
  issuer?: string | undefined;
  eligibility?: string | undefined;
  /** the tabs it is in */
  tabs: TabId[];
  at: ExploreAt[];
}

export type Mover = ExploreItem & { changePct24h: number; volumeUsd24h: number };

export interface ExploreMissing extends CompareMissing {
  /** the venue is one the owner connected (false: a public source) */
  connected: boolean;
  /** which of its calls, when the others answered */
  part?: "markets" | "stats" | "events" | undefined;
  /** the venue's own words, when it gave some ("Service unavailable from a restricted location …") */
  said?: string | undefined;
  /** a market left out of a row: its price is far from the other venues' */
  symbol?: string | undefined;
}

export interface Exploration {
  asOf: string;
  tabs: Array<{ id: TabId; label: string; count: number }>;
  items: ExploreItem[];
  movers: Mover[];
  closing: ExploreItem[];
  /** coins, stocks, perpetuals and tokens by their 24-hour dollar volume */
  mostTraded: ExploreItem[];
  missing: ExploreMissing[];
}

/** a source, connected or public, as the aggregator asks it */
interface Reader {
  id: string;
  name: string;
  connected: boolean;
  canTrade: boolean | "unknown";
  whyNot?: string | undefined;
  readOnly?: string | undefined;
  connectTo?: string | undefined;
  connector?: string | undefined;
  /** whose market data it reads: the connection (`live:exchange:okx`, `live:kalshi`), which a connected venue and the public source of the
   * same exchange share; a source nothing is traded through (Stock Tokens) is its own */
  family: string;
  /** its event contracts are Kalshi's, named by market ticker */
  kalshi: boolean;
  /** its tokens stand for shares or funds */
  rwa: boolean;
  markets(q: string): Promise<Market[] | Refusal>;
  stats?: ((symbols: string[]) => Promise<Map<string, MarketStats> | Refusal>) | undefined;
  events?: ((o: EventsQuery) => Promise<Market[] | Refusal>) | undefined;
  /** its busiest events are asked apart from its listing (a trader's few markets to start from may hold none) */
  eventsAlso: boolean;
}

type Part = "markets" | "stats" | "events";
type Got = { r: Reader; m: Listing };

const pos = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
const fin = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const seconds = (ms: number): string => `${Number((ms / 1000).toFixed(3))} s`;
const LATE = Symbol("late");
/** the longest a timer waits: setTimeout fires at once for anything longer */
const MAX_MS = 2_147_483_647;
const DAY_MS = 86_400_000;
const FLOOR_USD = 1_000_000;
const HEX_ID = /^0x[0-9a-f]{64}$/i;

/** a call as an answer, never a throw */
function settle<T>(call: () => Promise<T | Refusal>): Promise<T | Refusal | Error> {
  return Promise.resolve()
    .then(call)
    .catch((err: unknown) => (isRefusal(err) ? err : err instanceof Error ? err : new Error(String(err))));
}

/** the venue's own words in a refusal: the message inside the JSON it answered with, where there is one, else what it said */
function wordsOf(r: Refusal): string | undefined {
  const said = (r.native as { said?: unknown } | undefined)?.said;
  if (typeof said !== "string" || !said.trim()) return undefined;
  const inner = /"(?:msg|message|retMsg|error_description)"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(said);
  return (inner?.[1] ? inner[1].replace(/\\"/g, '"') : said).trim().slice(0, 240) || undefined;
}

function fromVenue(v: ExploreVenue): Reader {
  let canTrade: boolean | "unknown" = "unknown";
  let whyNot: string | undefined;
  try {
    canTrade = v.trader.can;
    whyNot = v.trader.whyNot;
  } catch {
    canTrade = "unknown";
  }
  const t = v.trader;
  return {
    id: v.id,
    name: v.name,
    connected: true,
    canTrade,
    whyNot,
    connector: v.connector,
    family: v.connector ?? v.id,
    kalshi: /kalshi/i.test(v.id) || /^live:kalshi/.test(v.connector ?? ""),
    rwa: false,
    markets: (q) => t.markets(q),
    stats: t.stats ? (s) => t.stats!(s) : undefined,
    events: t.events ? (o) => t.events!(o) : undefined,
    eventsAlso: true,
  };
}

function fromPublic(s: PublicSource, perSource: number): Reader {
  return {
    id: s.id,
    name: s.name,
    connected: false,
    canTrade: false,
    readOnly: s.readOnly,
    connectTo: s.connectTo,
    connector: s.connector,
    family: s.readOnly !== undefined ? s.id : s.connector,
    kalshi: s.connectTo === "kalshi",
    rwa: s.kind === "tokens",
    markets: (q) => s.listings({ q, limit: perSource }),
    stats: s.stats ? (symbols) => s.stats!(symbols) : undefined,
    events: s.events ? (o) => s.events!(o) : undefined,
    // a public source's listing is already its busiest events
    eventsAlso: false,
  };
}

const isMarket = (m: unknown): m is Listing => !!m && typeof m === "object" && typeof (m as Market).symbol === "string" && (m as Market).symbol !== "" && typeof (m as Market).kind === "string";
const noDay = (m: Market): boolean => m.kind !== "event" && m.changePct24h === undefined && m.volumeUsd24h === undefined;

/** one source's markets, inside its time limit; what failed or did not answer in time, said */
async function atSource(r: Reader, o: { q: string; ms: number; perSource: number; closingWithinMs: number }): Promise<{ got: Got[]; missing: ExploreMissing[] }> {
  const slots: Array<{ part: Part; v?: unknown; done: boolean }> = [];
  const run = <T>(part: Part, call: () => Promise<T | Refusal>): Promise<T | Refusal | Error> => {
    const s: { part: Part; v?: unknown; done: boolean } = { part, done: false };
    slots.push(s);
    return settle(call).then((v) => {
      s.v = v;
      s.done = true;
      return v;
    });
  };
  const work: Array<Promise<unknown>> = [
    run("markets", () => r.markets(o.q)).then(async (listed) => {
      if (!Array.isArray(listed) || !r.stats) return;
      const want = [...new Set(listed.filter(isMarket).filter(noDay).map((m) => m.symbol))];
      if (want.length) await run("stats", () => r.stats!(want));
    }),
  ];
  if (r.events) {
    work.push(run("events", () => r.events!({ closingWithinMs: o.closingWithinMs, limit: o.perSource })));
    if (r.eventsAlso) work.push(run("events", () => r.events!({ limit: o.perSource })));
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<typeof LATE>((resolve) => {
    timer = setTimeout(() => resolve(LATE), o.ms);
  });
  try {
    await Promise.race([Promise.all(work), late]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  const seen = slots.map((s) => ({ ...s }));

  // what came back: the listing and the events, one market per symbol (a market both list keeps every field either gave), with the 24-hour
  // figures the stats call gave to those whose listing had none
  const bySymbol = new Map<string, Listing>();
  let stats: Map<string, MarketStats> | undefined;
  for (const s of seen) {
    if (!s.done) continue;
    if (s.part === "stats" && s.v instanceof Map) stats = s.v as Map<string, MarketStats>;
    if (s.part !== "stats" && Array.isArray(s.v))
      for (const m of s.v.filter(isMarket)) {
        const was = bySymbol.get(m.symbol);
        bySymbol.set(m.symbol, was ? fill(was, m) : m);
      }
  }
  const got: Got[] = [...bySymbol.values()].map((m) => {
    const st = stats?.get(m.symbol);
    return { r, m: st && noDay(m) ? fill(m, { price: st.price, changePct24h: st.changePct24h, change24h: st.change24h, volumeUsd24h: st.volumeUsd24h }) : m };
  });

  const gone = (why: string, extra: Partial<ExploreMissing> = {}): ExploreMissing => ({ venue: r.id, venueName: r.name, why, connected: r.connected, ...extra });
  const failed: ExploreMissing[] = [];
  for (const s of seen) {
    if (!s.done) failed.push(gone(`did not answer in ${seconds(o.ms)}`, { code: "E_VENUE_UNREACHABLE", part: s.part }));
    else if (isRefusal(s.v)) {
      const said = wordsOf(s.v);
      failed.push(gone(s.v.message, { code: s.v.code, part: s.part, ...(said ? { said } : {}) }));
    } else if (s.v instanceof Error || (s.part === "stats" ? !(s.v instanceof Map) : !Array.isArray(s.v))) failed.push(gone("answered in a way this could not read", { part: s.part }));
  }
  if (got.length) return { got, missing: dedupe(failed) };
  // nothing to show: the source is missing as a whole, for its listing's reason first
  const first = failed.find((f) => f.part === "markets") ?? failed[0];
  if (!first) return { got, missing: [] };
  const { part: _part, ...whole } = first;
  return { got, missing: [whole] };
}

const dedupe = (list: ExploreMissing[]): ExploreMissing[] => {
  const keys = new Set<string>();
  return list.filter((m) => {
    const k = `${m.venue}|${m.part ?? ""}|${m.why}|${m.symbol ?? ""}`;
    return !keys.has(k) && keys.add(k) !== undefined;
  });
};

/** `a`, with what `b` says where `a` says nothing */
function fill<T extends object>(a: T, b: Partial<T>): T {
  const out = { ...a } as Record<string, unknown>;
  for (const [k, v] of Object.entries(b)) if (v !== undefined && out[k] === undefined) out[k] = v;
  return out as T;
}

function kindOf(m: Market, r: Reader): ExploreKind | undefined {
  switch (m.kind) {
    case "event":
      return "event";
    case "stock":
      return "stock";
    case "perp":
      return "perp";
    case "spot":
    case "crypto":
      return "coin";
    case "token":
      return r.rwa || isRwaMarket(m) ? "rwa" : "coin";
    default:
      // a dated future: its price carries the time to its expiry, so it is not one row with anything else
      return undefined;
  }
}

/** an event market's outcome: the venue's own, else what its symbol ends in */
const outcomeOf = (m: Market): string => m.outcome ?? (m.symbol.includes(":") ? m.symbol.slice(m.symbol.lastIndexOf(":") + 1) : m.base);
/** an event market's question, without the outcome its name ends in */
function titleOf(m: Market): string {
  const tail = ` · ${outcomeOf(m)}`;
  return m.name.toLowerCase().endsWith(tail.toLowerCase()) ? m.name.slice(0, -tail.length) : m.name;
}

/** the question an event market belongs to: the venue's own (`group`), else read from a Kalshi symbol (`<ticker>:YES`), else the symbol's
 * part before its outcome */
function groupOf(m: Market): { id: string; title: string } | undefined {
  if (m.group?.id) return { id: m.group.id, title: m.group.title || titleOf(m) };
  const k = /^([A-Za-z0-9][A-Za-z0-9._-]*):(YES|NO)$/i.exec(m.symbol);
  if (k) return { id: k[1]!.toUpperCase(), title: titleOf(m) };
  const i = m.symbol.lastIndexOf(":");
  return i > 0 ? { id: m.symbol.slice(0, i), title: titleOf(m) } : undefined;
}

function keyOf(m: Market, kind: ExploreKind, r: Reader): string | undefined {
  if (kind === "event") {
    const g = groupOf(m);
    if (!g) return undefined;
    if (HEX_ID.test(g.id)) return `pm:${g.id.toLowerCase()}`;
    return r.kalshi ? `kalshi:${g.id.toUpperCase()}` : `event:${r.id}:${g.id}`;
  }
  if (kind === "stock") {
    const t = normalBase(String(m.base || m.symbol), "stock");
    return t ? `stock:${t}` : undefined;
  }
  if (kind === "rwa") {
    const t = String(m.base || m.symbol).trim().toUpperCase();
    return t ? `rwa:${t}` : undefined;
  }
  const b = normalBase(String(m.base || m.symbol), m.kind);
  if (!b || isStable(b)) return undefined;
  return `${kind}:${b}`;
}

const priceOf = (m: Market): number | undefined => pos(m.price) ?? (pos(m.bid) !== undefined && pos(m.ask) !== undefined ? (m.bid! + m.ask!) / 2 : undefined);
const volumeOf = (i: { volumeUsd24h?: number | undefined; contracts24h?: number | undefined }): number => i.volumeUsd24h ?? i.contracts24h ?? -1;
const closeMs = (i: { closeTime?: string | undefined }): number => (i.closeTime ? Date.parse(i.closeTime) : NaN);

function atOf(r: Reader, m: Market, symbol = m.symbol, price = priceOf(m), open = m.open): ExploreAt {
  // a token an issuer stands behind, at a connected venue: the issuer's own words go with it, and one whose contract moves it only between
  // wallets the issuer approved takes no order there (dex.ts lists it with no order types), whatever the venue may trade
  const rwa = r.connected && isRwaMarket(m) ? m : undefined;
  const ordersTaken = !rwa || !Array.isArray(m.types) || m.types.length > 0;
  const issuerWords = rwa && typeof rwa.eligibility === "string" && rwa.eligibility ? rwa.eligibility : undefined;
  const issuer = typeof m.issuer === "string" && m.issuer ? m.issuer : undefined;
  const eligibility = typeof m.eligibility === "string" && m.eligibility ? m.eligibility : undefined;
  const note = (r.connected && r.canTrade === false ? r.whyNot : undefined) ?? r.readOnly ?? issuerWords ?? (open === false && typeof m.note === "string" && m.note ? m.note : undefined);
  return {
    venue: r.id,
    venueName: r.name,
    symbol,
    connected: r.connected,
    canTrade: r.connected ? (ordersTaken ? r.canTrade : false) : false,
    public: !r.connected,
    ...(price !== undefined ? { price } : {}),
    ...(typeof open === "boolean" ? { open } : {}),
    ...(!r.connected && r.connectTo ? { connectTo: r.connectTo } : {}),
    ...(!r.connected && r.connector ? { connector: r.connector } : {}),
    ...(note ? { note } : {}),
    ...(issuer ? { issuer } : {}),
    ...(eligibility ? { eligibility } : {}),
  };
}

const TAB_OF: Record<Exclude<ExploreKind, "event">, TabId> = { coin: "crypto", stock: "stocks", rwa: "rwas", perp: "perps" };
const displayLabel = (label: string): string => (/^yes$/i.test(label) ? "Yes" : /^no$/i.test(label) ? "No" : label);

/** one row from a thing's markets, venue by venue (connected venues first); markets set aside by the median guard go to `aside` */
function rowOf(key: string, kind: ExploreKind, venues: Map<string, Got[]>, aside: ExploreMissing[]): ExploreItem | undefined {
  const all = [...venues.values()].sort((a, b) => Number(b[0]!.r.connected) - Number(a[0]!.r.connected));
  if (kind === "event") return eventRow(key, all);
  // a public listing of an exchange a connected venue reads already is the same market again: the connected venue speaks for it
  const reads = new Set(all.filter((l) => l[0]!.r.connected).map((l) => l[0]!.r.family));
  const order = all.filter((l) => l[0]!.r.connected || !reads.has(l[0]!.r.family));
  // each venue once, by its most traded market for the thing (an open one before a closed one, then the venue's own order)
  let entries = order.map((list) => [...list].sort((a, b) => (b.m.volumeUsd24h ?? -1) - (a.m.volumeUsd24h ?? -1) || Number(b.m.open !== false) - Number(a.m.open !== false))[0]!);
  const priced = entries.filter((e) => priceOf(e.m) !== undefined);
  if (priced.length >= 3) {
    const prices = priced.map((e) => priceOf(e.m)!).sort((x, y) => x - y);
    const middle = prices[Math.floor(prices.length / 2)]!;
    const far = new Set(priced.filter((e) => Math.abs(priceOf(e.m)! - middle) / middle > 0.1));
    for (const e of far) aside.push({ venue: e.r.id, venueName: e.r.name, connected: e.r.connected, symbol: e.m.symbol, why: `lists ${e.m.symbol} at ${priceOf(e.m)}, more than 10% from the other venues' ${middle} for ${key.slice(key.indexOf(":") + 1)}: it may be another token under the same name, so it is left out of that row` });
    entries = entries.filter((e) => !far.has(e));
  }
  if (!entries.length) return undefined;
  entries.sort((a, b) => (b.m.volumeUsd24h ?? -1) - (a.m.volumeUsd24h ?? -1) || Number(b.r.connected) - Number(a.r.connected));
  const base = key.slice(key.indexOf(":") + 1);
  const priceAt = entries.find((e) => priceOf(e.m) !== undefined);
  const moved = entries.find((e) => fin(e.m.changePct24h) !== undefined);
  // one market's volume once: the largest figure of the venues that read one exchange, then the exchanges summed
  const byFamily = new Map<string, number>();
  for (const e of entries) {
    const v = fin(e.m.volumeUsd24h);
    if (v !== undefined && v >= 0) byFamily.set(e.r.family, Math.max(byFamily.get(e.r.family) ?? 0, v));
  }
  const vols = [...byFamily.values()];
  const funded = entries.find((e) => fin(e.m.fundingRate) !== undefined);
  const named = entries.find((e) => e.m.name && !e.m.name.includes(" / ") && e.m.name.toUpperCase() !== e.m.symbol.toUpperCase());
  const name = kind === "coin" ? base : kind === "perp" ? `${base} perpetual` : (named?.m.name ?? base);
  const category = entries.map((e) => e.m.category).find((c): c is string => typeof c === "string" && c !== "");
  const issued = kind === "rwa" ? entries.find((e) => typeof e.m.issuer === "string" && e.m.issuer !== "") : undefined;
  const eligible = kind === "rwa" ? entries.find((e) => typeof e.m.eligibility === "string" && e.m.eligibility !== "") : undefined;
  return {
    key,
    kind,
    name,
    base,
    ...(priceAt ? { price: priceOf(priceAt.m) } : {}),
    ...(moved ? { changePct24h: moved.m.changePct24h, ...(fin(moved.m.change24h) !== undefined ? { change24h: moved.m.change24h } : {}), changeFrom: { venue: moved.r.id, venueName: moved.r.name } } : {}),
    ...(vols.length ? { volumeUsd24h: vols.reduce((s, v) => s + v, 0) } : {}),
    ...(category ? { category } : {}),
    ...(funded ? { fundingRate: funded.m.fundingRate, ...(funded.m.nextFundingAt ? { nextFundingAt: funded.m.nextFundingAt } : {}) } : {}),
    ...(issued ? { issuer: issued.m.issuer } : {}),
    ...(eligible ? { eligibility: eligible.m.eligibility } : {}),
    tabs: [TAB_OF[kind as Exclude<ExploreKind, "event">]],
    at: entries.map((e) => atOf(e.r, e.m)),
  };
}

/** an event's row: its legs at every venue folded into its outcomes, YES and NO first. A `pm:` or `kalshi:` row is one market at one
 * exchange, so a venue the owner connected that lists it trades it already: the public listing of it is left out */
function eventRow(key: string, every: Got[][]): ExploreItem | undefined {
  const order = every.some((l) => l[0]!.r.connected) ? every.filter((l) => l[0]!.r.connected) : every;
  const outcomes = new Map<string, ExploreOutcome>();
  let changeFrom: { venue: string; venueName: string } | undefined;
  const firstLegs = order.flat();
  if (!firstLegs.length) return undefined;
  for (const list of order)
    for (const { r, m } of list) {
      const label = outcomeOf(m);
      const k = label.toLowerCase();
      const row = outcomes.get(k) ?? { label: displayLabel(label), at: [] };
      if (!row.at.some((a) => a.venue === r.id && a.symbol === m.symbol)) row.at.push({ venue: r.id, symbol: m.symbol });
      const p = priceOf(m);
      if (row.price === undefined && p !== undefined) row.price = p;
      if (row.bid === undefined && pos(m.bid) !== undefined) row.bid = m.bid;
      if (row.ask === undefined && pos(m.ask) !== undefined) row.ask = m.ask;
      if (row.change24h === undefined && fin(m.change24h) !== undefined) row.change24h = m.change24h;
      outcomes.set(k, row);
    }
  const rows = [...outcomes.entries()];
  const rank = (k: string) => (k === "yes" ? 0 : k === "no" ? 1 : 2);
  rows.sort((a, b) => rank(a[0]) - rank(b[0]));
  const out = rows.map(([, o]) => o);
  const lead = out[0]!;
  if (lead.change24h !== undefined) {
    const from = firstLegs.find((g) => outcomeOf(g.m).toLowerCase() === lead.label.toLowerCase() && fin(g.m.change24h) !== undefined);
    if (from) changeFrom = { venue: from.r.id, venueName: from.r.name };
  }
  // a market's volume is the market's, whichever leg and whichever venue carries it: every venue here reads the same one market, so it is
  // counted once — the largest figure any of them gives (the public one included, when a connected venue gives none)
  const legs = every.flat();
  const v = Math.max(...legs.map((g) => fin(g.m.volumeUsd24h) ?? -1));
  const c = Math.max(...legs.map((g) => fin(g.m.contracts24h) ?? -1));
  const usd = v >= 0 ? v : undefined;
  const contracts = c >= 0 ? c : undefined;
  const g0 = firstLegs[0]!.m;
  const words = firstLegs.flatMap((g) => [g.m.category, ...(g.m.tags ?? [])]);
  const category = firstLegs.map((g) => g.m.category).find((c): c is string => typeof c === "string" && c !== "");
  const closeTime = firstLegs.map((g) => g.m.closeTime).find((c): c is string => typeof c === "string" && c !== "");
  const event = firstLegs.map((g) => g.m.event).find((e) => e !== undefined);
  return {
    key,
    kind: "event",
    name: groupOf(g0)?.title ?? titleOf(g0),
    ...(lead.price !== undefined ? { price: lead.price } : {}),
    ...(lead.change24h !== undefined ? { change24h: lead.change24h } : {}),
    ...(changeFrom ? { changeFrom } : {}),
    ...(usd !== undefined ? { volumeUsd24h: usd } : {}),
    ...(contracts !== undefined ? { contracts24h: contracts } : {}),
    ...(category ? { category } : {}),
    ...(closeTime ? { closeTime } : {}),
    ...(event ? { event } : {}),
    outcomes: out,
    tabs: ["predictions", ...tabsOfCategories(words)],
    at: order.map((list) => {
      const lead0 = list.find((g) => outcomeOf(g.m).toLowerCase() === lead.label.toLowerCase()) ?? list[0]!;
      return atOf(lead0.r, lead0.m, lead0.m.symbol, priceOf(lead0.m), list.some((g) => g.m.open === true) ? true : lead0.m.open);
    }),
  };
}

/** a row matches a query by its own words or by any of its markets' symbols and names at any venue */
const matches = (i: ExploreItem, words: string[], q: string): boolean => [i.name, i.base, i.category, i.event?.title, ...words].some((f) => typeof f === "string" && f.toLowerCase().includes(q));

const byVolume = (a: ExploreItem, b: ExploreItem): number => volumeOf(b) - volumeOf(a) || a.name.localeCompare(b.name);
const size = (i: ExploreItem): number => (fin(i.changePct24h) !== undefined ? Math.abs(i.changePct24h!) : -1);
const byMove = (a: ExploreItem, b: ExploreItem): number => size(b) - size(a) || byVolume(a, b);
function byClose(now: number): (a: ExploreItem, b: ExploreItem) => number {
  const at = (i: ExploreItem) => {
    const t = closeMs(i);
    return t > now ? t : Number.POSITIVE_INFINITY;
  };
  return (a, b) => at(a) - at(b) || byVolume(a, b);
}

/** one mover per asset: a coin's perpetual is the coin, so where both moved enough the coin's own market is the chip, and the perpetual
 * only where the coin is not among them. A stock and the token that stands for it are two things, and stay two */
function oneEach(movers: Mover[]): Mover[] {
  const asset = (i: Mover): string => (i.kind === "perp" ? `coin:${i.base ?? i.key.slice(i.key.indexOf(":") + 1)}` : i.key);
  const byAsset = new Map<string, Mover>();
  for (const i of movers) {
    const was = byAsset.get(asset(i));
    if (!was || (was.kind === "perp" && i.kind !== "perp")) byAsset.set(asset(i), i);
  }
  return [...byAsset.values()];
}

/** Every market the sources list, as one list of rows, with its tabs, its movers and what closes soon. Every source is asked at once, each
 * inside its own time limit; what failed is in `missing`, with why. See the top of this file for what is one row and what is made of them */
export async function exploreAcross(sources: ExploreSources, opts: ExploreOptions = {}): Promise<Exploration> {
  const clock = opts.clock ?? Date.now;
  const ms = Math.min(pos(opts.timeoutMs) ?? 4_000, MAX_MS);
  const perSource = Math.max(1, Math.floor(pos(opts.perSource) ?? 40));
  const top = Math.max(1, Math.floor(pos(opts.top) ?? 8));
  const limit = Math.max(1, Math.floor(pos(opts.limit) ?? 60));
  const window = pos(opts.closingWithinMs) ?? DAY_MS;
  const q = (opts.q ?? "").trim();
  const floor = (k: Exclude<ExploreKind, "event">): number => (typeof opts.moversMinUsd === "number" ? opts.moversMinUsd : (opts.moversMinUsd?.[k] ?? FLOOR_USD));

  const connected = sources.connected ?? [];
  // a source nothing is ever traded through (Stock Tokens) is the public side of no connection: it is always asked
  const covered = (s: PublicSource) => s.readOnly === undefined && connected.some((v) => v.id === s.connectTo || (v.connector !== undefined && v.connector === s.connector));
  const readers = [...connected.map(fromVenue), ...(sources.public ?? []).filter((s) => !covered(s)).map((s) => fromPublic(s, perSource))];
  const answers = await Promise.all(readers.map((r) => atSource(r, { q, ms, perSource, closingWithinMs: window })));
  const missing: ExploreMissing[] = answers.flatMap((a) => a.missing);

  // every market to its row, and within its row to its venue
  const rows = new Map<string, { kind: ExploreKind; venues: Map<string, Got[]>; words: string[] }>();
  for (const g of answers.flatMap((a) => a.got)) {
    const kind = kindOf(g.m, g.r);
    if (!kind || !inDollars(String(g.m.quote ?? ""))) continue;
    const key = keyOf(g.m, kind, g.r);
    if (!key) continue;
    const row = rows.get(key) ?? { kind, venues: new Map<string, Got[]>(), words: [] };
    if (row.kind !== kind) continue;
    row.venues.set(g.r.id, [...(row.venues.get(g.r.id) ?? []), g]);
    row.words.push(g.m.symbol, g.m.name, String(g.m.base ?? ""));
    rows.set(key, row);
  }
  const all: ExploreItem[] = [];
  for (const [key, row] of rows) {
    const aside: ExploreMissing[] = [];
    const item = rowOf(key, row.kind, row.venues, aside);
    if (!item || (q && !matches(item, row.words, q.toLowerCase()))) continue;
    all.push(item);
    missing.push(...aside);
  }

  const now = clock();
  const traded = all.filter((i) => i.kind !== "event" && i.volumeUsd24h !== undefined).sort(byVolume);
  const movers = oneEach(all.filter((i): i is Mover => i.kind !== "event" && fin(i.changePct24h) !== undefined && (i.volumeUsd24h ?? -1) >= floor(i.kind as Exclude<ExploreKind, "event">))).sort(byMove).slice(0, top);
  const soon = all.filter((i) => i.kind === "event" && closeMs(i) > now && closeMs(i) <= now + window).sort(byVolume).slice(0, top);
  const closing = [...soon].sort(byClose(now));
  const mostTraded = traded.slice(0, top);
  const nowKeys = new Set<string>();
  const nowList = [...soon, ...movers, ...mostTraded].filter((i) => !nowKeys.has(i.key) && nowKeys.add(i.key) !== undefined);
  for (const i of nowList) i.tabs = ["now", ...i.tabs];

  const tabs = TABS.map((t) => ({ id: t.id, label: t.label, count: t.id === "now" ? nowList.length : all.filter((i) => i.tabs.includes(t.id)).length })).filter((t) => t.count > 0);
  const sorter = opts.sort === "movers" ? byMove : opts.sort === "closing" ? byClose(now) : byVolume;
  const chosen = opts.tab === "now" ? (opts.sort ? [...nowList].sort(sorter) : nowList) : (opts.tab ? all.filter((i) => i.tabs.includes(opts.tab!)) : all).sort(sorter);
  return { asOf: new Date(now).toISOString(), tabs, items: chosen.slice(0, limit), movers, closing, mostTraded, missing: dedupe(missing) };
}
