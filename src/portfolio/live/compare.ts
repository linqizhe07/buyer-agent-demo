/** WHERE IT IS CHEAPEST: one thing — BTC, ETH, AAPL — priced at every venue the user has connected live, side by side, so the owner and an
 * agent can see where a buy costs least and a sell fetches most.
 *
 * Each venue calls the same thing by its own name: `BTC/USDT` at an exchange, `BTC-USD` at Robinhood Crypto, `WBTC/USDC@Arbitrum` from a
 * wallet. `normalBase` gives one name to one thing, from the market's own `base` (never by guessing at a symbol where a base is at hand).
 *
 * What a comparison sends, every venue at once:
 *
 *   trader.markets(name)     the venue's markets matching the name ("BTC"): a few letters, as the owner would type them; asked once more
 *                            by the pair's spellings (`UNI/USD`, `UNI-USD`) when a full page of other markets hides the coin's own pair
 *   trader.market(symbol)    a fresh price for each of the best few matches there (at most `perVenue`, three by default)
 *
 * and nothing else: no order, no quote for a size, nothing signed. Each venue has one time limit for both steps (four seconds by default);
 * a venue that refuses, has nothing to compare or does not answer in time is left out and said to be (`missing`), so one slow venue never
 * holds up the rest. A venue's call is not stopped when its time runs out — the trader interface has no way to stop one — its answer is
 * just not waited for.
 *
 * What is compared, and how:
 *   · the same thing priced in DOLLARS (USD or a dollar stablecoin, counted one for one, as the account counts them), in a spot market, a
 *     broker's crypto or stock, a wallet's token or a perpetual. A perpetual stands in only at a venue that lists no spot market for it; a
 *     dated future (its price carries the time to expiry) and an event contract are never compared;
 *   · a coin and a stock that share a ticker are not one thing (BTC and ETH are also the tickers of two US-listed trusts): a well-known
 *     coin's name compares the coin unless `asset: "stock"` is asked; any other name compares what the venues list, and if they list it as
 *     a stock at some and a coin at others, the side more venues list is compared (the coin, at a venue that lists both, and on a tie) and
 *     the rest are said to be missing;
 *   · a buy is priced at the ASK and a sell at the BID, as the account values an order (account/live-orders.ts). A venue that shows no
 *     book (a DEX aggregator's reference price) is priced at its last price, says so (`priceIs: "last"`), and ranks after every venue that
 *     shows the side of the book the order would take;
 *   · ranked best first: a buy by the lowest ask, a sell by the highest bid. A market closed now, a venue whose key may not trade, one
 *     whose own place rule takes no such order from this network (`place`: the account's verdict from the venue's answer, its words in the
 *     row's note), or one whose smallest order is more than `usd` ranks last, after every venue an order could go to now;
 *   · `best` is the first venue an order could go to now; `worse` is how much worse every other venue is than it, in percent (negative:
 *     it looks better, but it is closed, priced at a last price, or cannot take the order). When no venue could take an order now, no row
 *     is best;
 *   · no fee is guessed. A venue that says something about its fees, its slippage or its minimum says it in its market's note, and the note
 *     is passed on as it is. The prices are the top of each venue's book (or a quote for about $100 where a wallet prices by quotes), not
 *     what an order of `usd` would fill at.
 */
import { isRefusal, type Refusal } from "../../core/errors.ts";
import { floorTo, inDollars, type LiveTrader, type Market, type MarketKind, type Side } from "./trade.ts";

/** the same thing under another name: a venue's own spelling (Kraken's XBT), a wrapped or bridged token that is redeemed one for one */
const ALIAS: Readonly<Record<string, string>> = {
  XBT: "BTC",
  XXBT: "BTC",
  WBTC: "BTC",
  CBBTC: "BTC",
  BTCB: "BTC",
  "BTC.B": "BTC",
  "WBTC.E": "BTC",
  WETH: "ETH",
  "WETH.E": "ETH",
  "USDC.E": "USDC",
  USDBC: "USDC",
  "USDT.E": "USDT",
  USDT0: "USDT",
  "USD₮0": "USDT",
  "USD₮": "USDT",
  XDG: "DOGE",
  XXDG: "DOGE",
  WBNB: "BNB",
  WPOL: "POL",
  WAVAX: "AVAX",
  WSOL: "SOL",
};

/** coins well enough known that their name means the coin, not a stock with the same ticker (BTC, ETH, SOL, LINK, NEAR and ATOM are all
 * also US tickers) */
const COINS: ReadonlySet<string> = new Set([
  ...Object.values(ALIAS),
  "XRP", "ADA", "TRX", "TON", "LINK", "DOT", "LTC", "BCH", "ETC", "XLM", "UNI", "AAVE", "OP", "ARB", "SUI", "APT", "NEAR", "ATOM", "FIL",
  "HYPE", "PEPE", "SHIB", "CRV", "MKR", "LDO", "ENA", "TIA", "SEI", "INJ", "WLD", "ONDO", "AERO", "CAKE", "PAXG", "XAUT", "MATIC", "HBAR",
]);

/** One name for one thing. From a market's `base` where there is one (`WBTC`, `XBT`, `cbBTC` → `BTC`; `WETH` → `ETH`; `USDC.e` → `USDC`);
 * from a symbol where there is not (`BTC/USDT`, `BTC/USDT:USDT`, `BTC-USD`, `WBTC/USDC@Arbitrum` → `BTC`). A stock's ticker is as it is
 * (`AAPL`, `BRK.B`). An event contract is not one thing anywhere else: its name is "" */
export function normalBase(symbolOrBase: string, kind: string): string {
  if (kind === "event") return "";
  const s = symbolOrBase.trim();
  if (!s) return "";
  if (kind === "stock") return s.toUpperCase();
  // a wallet's market names its chain after @; an exchange's pair its quote after / (and a contract's settlement after :)
  let base = s.split("@")[0]!.split(/[/:]/)[0]!.trim();
  // Robinhood Crypto and Coinbase write BTC-USD: the part after the last dash is cut only when it is a dollar quote
  const dash = base.lastIndexOf("-");
  if (dash > 0 && inDollars(base.slice(dash + 1))) base = base.slice(0, dash);
  const up = base.toUpperCase();
  return ALIAS[up] ?? up;
}

/** A trading venue's own place rule for this user's network, as the account judged it just now from the venue's answer to that network
 * (the service's verdict for the connection; never what a builder's machine was answered): `closed`, it takes no order from here, so its
 * row is never ready and never best; `close-only`, it takes only orders that close what is held (Polymarket's rule for some places), so a
 * buy is not ready and a sell is. `words` are the rule's own, with no place and no address in them. It holds back nothing the venue's
 * order door would not refuse anyway */
export interface PlaceRule {
  rule: "closed" | "close-only";
  words: string;
}

export interface CompareVenue {
  /** the account's id for the venue */
  id: string;
  name: string;
  trader: LiveTrader;
  /** the venue's place rule for this network, when it has one that bars an order from here (absent: none, or not known) */
  place?: PlaceRule | undefined;
}

export interface CompareOptions {
  /** an order of this many dollars: each venue says how much of the thing it buys or sells there, and whether its smallest order allows it */
  usd?: number | undefined;
  /** how long each venue has to answer both of its calls, in milliseconds (4000) */
  timeoutMs?: number | undefined;
  /** a coin or a stock, for a name that is both; a well-known coin's name means the coin unless "stock" is asked */
  asset?: "crypto" | "stock" | undefined;
  /** how many of a venue's matching markets are priced (3): the best of them is the venue's row */
  perVenue?: number | undefined;
}

export interface CompareRow {
  venue: string;
  venueName: string;
  /** the market, as the venue's trader names it: what an order there names */
  symbol: string;
  name: string;
  kind: MarketKind;
  /** what the venue calls the thing (`WBTC`), and what it is paid in there (`USDT`) */
  base: string;
  quote: string;
  /** a buy: the ask; a sell: the bid — or the last price where the venue shows no book (`priceIs`) */
  price: number;
  priceIs: "ask" | "bid" | "last";
  bid?: number;
  ask?: number;
  /** (ask − bid) / the middle, in percent */
  spreadPct?: number;
  /** the market takes orders now */
  open: boolean;
  /** may the key or sign-in trade at this venue: what the venue said (`unknown`: its first refusal will say) */
  canTrade: boolean | "unknown";
  /** an order could go here now: the market is open, the key is not known to be barred, and (with `usd`) the order is not under its smallest */
  ready: boolean;
  /** with `usd`: how much of the thing that buys or sells here at `price`, down to the venue's step */
  qty?: number;
  /** with `usd`: the venue takes an order that size; and the smallest order it takes, in dollars at `price` */
  fits?: boolean;
  minUsd?: number;
  /** the venue's own note on the market (its fees, its slippage, why it is closed), passed on as it is */
  note?: string;
  /** the venue's own category for the market, where it says one (RWA for a token an issuer stands behind, dex.ts): the ticket tells a
   * tokenised share from a coin by it */
  category?: string;
  /** how much worse than the best, in percent (negative: it looks better, but no order could go there now, or it is a last price) */
  worse?: number;
  best?: true;
}

export interface CompareMissing {
  venue: string;
  venueName: string;
  /** why it is not compared: the venue's own refusal, no market for it, no price, or no answer in time */
  why: string;
  /** the refusal's code, when the venue refused */
  code?: string;
}

export interface Comparison {
  /** the one name compared, as normalBase gives it */
  base: string;
  side: Side;
  rows: CompareRow[];
  missing: CompareMissing[];
}

type Family = "crypto" | "stock";
const familyOf = (kind: string): Family | undefined => (kind === "stock" ? "stock" : kind === "spot" || kind === "crypto" || kind === "token" || kind === "perp" ? "crypto" : undefined);

interface Want {
  /** the name looked for, for a coin and for a stock (they differ only for a ticker with a dash in it) */
  crypto: string;
  stock: string;
  families: ReadonlySet<Family>;
  /** what is sent to markets() */
  query: string;
}

const pos = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
const round4 = (x: number): number => Math.round(x * 1e4) / 1e4;
const seconds = (ms: number): string => `${Number((ms / 1000).toFixed(3))} s`;
const LATE = Symbol("late");
/** a trader answers at most this many markets for a query (LiveTrader.markets) */
const PAGE = 20;
/** the longest a timer waits: setTimeout fires at once for anything longer */
const MAX_MS = 2_147_483_647;

/** is this market the thing wanted, in a kind that is compared, priced in dollars */
function matches(m: Market, w: Want): boolean {
  const fam = familyOf(m.kind);
  if (!fam || !w.families.has(fam) || !inDollars(String(m.quote ?? ""))) return false;
  return normalBase(String(m.base ?? ""), m.kind) === (fam === "stock" ? w.stock : w.crypto);
}

/** a venue's matching markets, the ones to price first: anything but a perpetual (a perpetual only when there is nothing else), open, under
 * the thing's own name rather than a wrapped one, then the venue's own order */
function candidates(listed: Market[], w: Want, most: number): Market[] {
  const hits = listed.filter((m) => m && typeof m.symbol === "string" && matches(m, w));
  const spot = hits.filter((m) => m.kind !== "perp");
  let pool = spot.length ? spot : hits;
  // a venue that lists the name both as a coin and as a stock: its coin is priced, so that its row is never the cheaper of two things
  if (pool.some((m) => m.kind === "stock") && pool.some((m) => m.kind !== "stock")) pool = pool.filter((m) => m.kind !== "stock");
  const own = (m: Market) => String(m.base).toUpperCase() === (m.kind === "stock" ? w.stock : w.crypto);
  return pool
    .map((m, i) => ({ m, i }))
    .sort((a, b) => Number(b.m.open !== false) - Number(a.m.open !== false) || Number(own(b.m)) - Number(own(a.m)) || a.i - b.i)
    .slice(0, most)
    .map((x) => x.m);
}

/** a trader's call as an answer, never a throw: a call that throws, or rejects, answers as the refusal it was or as one */
function settle<T>(call: () => Promise<T | Refusal>): Promise<T | Refusal | Error> {
  return Promise.resolve()
    .then(call)
    .catch((err: unknown) => (isRefusal(err) ? err : err instanceof Error ? err : new Error(String(err))));
}

type Outcome = { row: CompareRow } | { missing: CompareMissing };

async function atVenue(v: CompareVenue, w: Want, side: Side, ms: number, most: number, usd: number | undefined): Promise<Outcome> {
  const gone = (why: string, code?: string): Outcome => ({ missing: { venue: v.id, venueName: v.name, why, ...(code ? { code } : {}) } });
  const slow = `did not answer in ${seconds(ms)}`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<typeof LATE>((resolve) => {
    timer = setTimeout(() => resolve(LATE), ms);
  });
  try {
    const listed = await Promise.race([settle(() => v.trader.markets(w.query)), late]);
    if (listed === LATE) return gone(slow, "E_VENUE_UNREACHABLE");
    if (isRefusal(listed)) return gone(listed.message, listed.code);
    if (listed instanceof Error || !Array.isArray(listed)) return gone("answered in a way this comparison could not read");
    let picked = candidates(listed, w, most);
    // a venue answers one page of markets (20): a name that starts many others (UNI: United Airlines, Union Pacific, … at a broker that
    // lists stocks and coins) can fill the page before the coin's own pair. A full page with markets of a compared kind on it but no spot
    // match is asked once more, by the pair's spellings (UNI/USD finds UNI/USD, UNI/USDT, UNI/USDC@Base; UNI-USD finds UNI-USD). A page
    // of event contracts only is not asked again
    if (w.families.has("crypto") && listed.length >= PAGE && !picked.some((m) => m.kind !== "perp") && listed.some((m) => m && familyOf(m.kind) !== undefined)) {
      const more = await Promise.race([Promise.all([`${w.crypto}/USD`, `${w.crypto}-USD`].map((q) => settle(() => v.trader.markets(q)))), late]);
      if (more === LATE) return gone(slow, "E_VENUE_UNREACHABLE");
      const have = new Set(listed.map((m) => m?.symbol));
      const extra: Market[] = [];
      for (const m of more.flatMap((r) => (Array.isArray(r) ? r : []))) {
        if (!m || typeof m.symbol !== "string" || have.has(m.symbol)) continue;
        have.add(m.symbol);
        extra.push(m);
      }
      if (extra.length) picked = candidates([...listed, ...extra], w, most);
    }
    if (!picked.length) {
      const events = listed.some((m) => m?.kind === "event");
      return gone(`lists no ${w.query} market priced in dollars to compare${events ? " (event contracts are not compared)" : ""}`);
    }

    // a fresh price for each, all at once, inside the same time limit: what has answered when the time is up is what is compared
    const got: Array<Market | Refusal | Error | undefined> = picked.map(() => undefined);
    const all = Promise.all(picked.map((c, i) => settle(() => v.trader.market(c.symbol)).then((r) => void (got[i] = r))));
    const done = (await Promise.race([all.then(() => true), late])) === true;
    const answered = got.slice();

    let canTrade: boolean | "unknown" = "unknown";
    try {
      canTrade = v.trader.can;
    } catch {
      canTrade = "unknown";
    }
    // a venue whose own rule takes no order from this network: whatever the key may do, no order goes there from here
    if (v.place?.rule === "closed") canTrade = false;
    const rows: CompareRow[] = [];
    let refusal: Refusal | undefined;
    let unpriced: Market | undefined;
    let unreadable = false;
    let another: Market | undefined;
    for (const [i, r] of answered.entries()) {
      if (r === undefined) continue;
      if (isRefusal(r)) {
        refusal ??= r;
        continue;
      }
      if (r instanceof Error || !r || typeof r !== "object") {
        unreadable = true;
        continue;
      }
      // the fresh answer must still be the thing asked for: a trader may resolve a symbol to another token than the one it listed, a spot
      // market to a perpetual, or a coin to a stock with the same ticker
      if (!matches(r, w) || familyOf(r.kind) !== familyOf(picked[i]!.kind) || (picked[i]!.kind !== "perp" && r.kind === "perp")) {
        another ??= r;
        continue;
      }
      const row = rowOf(v, r, side, canTrade, usd, picked[i]!);
      if (row) rows.push(row);
      else unpriced ??= r;
    }
    if (rows.length) {
      // the venue's row: the best of its markets, an open one before a closed one
      rows.sort((a, b) => Number(b.ready) - Number(a.ready) || Number(a.priceIs === "last") - Number(b.priceIs === "last") || better(side, a, b));
      return { row: rows[0]! };
    }
    if (unpriced) return gone(`shows no price for ${unpriced.symbol} right now`);
    if (refusal) return gone(refusal.message, refusal.code);
    if (another) return gone(`answered ${String(another.symbol)} (${String(another.base)}, ${String(another.kind)}) for a ${w.query} market it listed: not compared`);
    if (unreadable) return gone("answered in a way this comparison could not read");
    return gone(done ? `shows no price for ${w.query} right now` : slow, done ? undefined : "E_VENUE_UNREACHABLE");
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** a buy: the lower ask first · a sell: the higher bid first; then the tighter spread */
function better(side: Side, a: CompareRow, b: CompareRow): number {
  const by = side === "buy" ? a.price - b.price : b.price - a.price;
  return by || (a.spreadPct ?? Number.POSITIVE_INFINITY) - (b.spreadPct ?? Number.POSITIVE_INFINITY);
}

function rowOf(v: CompareVenue, m: Market, side: Side, canTrade: boolean | "unknown", usd: number | undefined, listed: Market): CompareRow | undefined {
  const bid = pos(m.bid);
  const ask = pos(m.ask);
  const book = side === "buy" ? ask : bid;
  const price = book ?? pos(m.price);
  if (price === undefined) return undefined;
  const priceIs: CompareRow["priceIs"] = book !== undefined ? (side === "buy" ? "ask" : "bid") : "last";
  const spreadPct = bid !== undefined && ask !== undefined && ask >= bid ? round4(((ask - bid) / ((ask + bid) / 2)) * 100) : undefined;
  const open = m.open === true;
  let sized: { qty: number; fits: boolean; minUsd?: number } | undefined;
  if (usd !== undefined) {
    const each = price * (pos(m.contractSize) ?? 1);
    const qty = floorTo(usd / each, pos(m.qtyStep));
    const minQty = pos(m.minQty);
    const minNotional = pos(m.minNotional);
    const minUsd = Math.max(minNotional ?? 0, (minQty ?? pos(m.qtyStep) ?? 0) * each);
    const fits = qty > 0 && (minQty === undefined || qty >= minQty - 1e-12) && (minNotional === undefined || qty * each >= minNotional - 1e-9);
    sized = { qty, fits, ...(minUsd > 0 ? { minUsd: round4(minUsd) } : {}) };
  }
  // the venue's place rule for this network, where it bars this order — every order (closed), or one that opens (a buy, close-only): said
  // first, before the market's own note, and the row is not ready
  const barred = v.place && (v.place.rule === "closed" || side === "buy") ? v.place.words : undefined;
  const own = typeof m.note === "string" && m.note ? m.note : listed.note;
  const note = barred ? (own ? `${barred} · ${own}` : barred) : own;
  const category = typeof m.category === "string" && m.category ? m.category : listed.category;
  // the fresh answer's name for the market is what an order there names; the listed one if it gave none
  const symbol = typeof m.symbol === "string" && m.symbol ? m.symbol : listed.symbol;
  return {
    venue: v.id,
    venueName: v.name,
    symbol,
    name: typeof m.name === "string" && m.name ? m.name : symbol,
    kind: m.kind,
    base: String(m.base),
    quote: String(m.quote),
    price,
    priceIs,
    ...(bid !== undefined ? { bid } : {}),
    ...(ask !== undefined ? { ask } : {}),
    ...(spreadPct !== undefined ? { spreadPct } : {}),
    open,
    canTrade,
    ready: !barred && open && canTrade !== false && sized?.fits !== false,
    ...(sized ? { qty: sized.qty, fits: sized.fits, ...(sized.minUsd !== undefined ? { minUsd: sized.minUsd } : {}) } : {}),
    ...(note ? { note } : {}),
    ...(category ? { category } : {}),
  };
}

/** The same thing at every venue given, priced now and ranked: where a buy costs least (by the ask) or a sell fetches most (by the bid).
 * Every venue is asked at once, each inside its own time limit; the ones left out are in `missing`, with why. See the top of this file for
 * what is compared and how it is ranked */
export async function compareAcross(venues: CompareVenue[], base: string, side: Side, opts: CompareOptions = {}): Promise<Comparison> {
  const ms = Math.min(pos(opts.timeoutMs) ?? 4_000, MAX_MS);
  const most = Math.max(1, Math.floor(pos(opts.perVenue) ?? 3));
  const usd = pos(opts.usd);
  const crypto = normalBase(base, "spot");
  const stock = normalBase(base, "stock");
  if (!crypto && !stock) return { base: "", side, rows: [], missing: [] };
  const families: ReadonlySet<Family> = new Set<Family>(opts.asset === "stock" ? ["stock"] : opts.asset === "crypto" || COINS.has(crypto) ? ["crypto"] : ["crypto", "stock"]);
  const only = families.size === 1 ? [...families][0]! : undefined;
  const w: Want = { crypto, stock, families, query: only === "stock" ? stock : crypto };

  const outcomes = await Promise.all(venues.map((v) => atVenue(v, w, side, ms, most, usd)));
  let rows: CompareRow[] = [];
  const missing: CompareMissing[] = [];
  for (const o of outcomes) {
    if ("row" in o) rows.push(o.row);
    else missing.push(o.missing);
  }

  // a name that is a coin at some venues and a stock at others: the side more venues list is compared (the coin, if as many list each)
  const coins = rows.filter((r) => familyOf(r.kind) === "crypto");
  const stocks = rows.filter((r) => familyOf(r.kind) === "stock");
  // the name compared is the one of the side compared: a stock's ticker as it is, a coin's as normalBase gives it
  const compared: Family | undefined = only ?? (stocks.length > coins.length ? "stock" : rows.length ? "crypto" : undefined);
  if (coins.length && stocks.length) {
    const keep = coins.length >= stocks.length ? "crypto" : "stock";
    const more = coins.length === stocks.length ? "as many" : "more";
    for (const r of keep === "crypto" ? stocks : coins) missing.push({ venue: r.venue, venueName: r.venueName, why: `lists ${w.query} as ${keep === "crypto" ? "a stock" : "a coin"}, and ${more} venues list it as ${keep === "crypto" ? "a coin" : "a stock"}: ask for asset "${keep === "crypto" ? "stock" : "crypto"}" to compare those` });
    rows = keep === "crypto" ? coins : stocks;
  }

  // a price far from the others' middle (more than 10%, with three or more venues) may be another token under the same name: not ready, so it
  // is never the best and never one click away
  if (rows.length >= 3) {
    const prices = rows.map((r) => r.price).sort((x, y) => x - y);
    const mid = prices[Math.floor(prices.length / 2)]!;
    for (const r of rows) if (mid > 0 && Math.abs(r.price - mid) / mid > 0.1) Object.assign(r, { ready: false, note: `${r.note ? `${r.note} · ` : ""}far from the other venues' prices: check it is the same thing` });
  }

  // ready venues priced at the book first, then ready venues priced at a last price, then the rest; best first inside each
  const tier = (r: CompareRow) => (!r.ready ? 2 : r.priceIs === "last" ? 1 : 0);
  rows.sort((a, b) => tier(a) - tier(b) || better(side, a, b));
  const top = rows[0];
  if (top && top.ready) {
    top.best = true;
    for (const r of rows.slice(1)) r.worse = round4(((side === "buy" ? r.price - top.price : top.price - r.price) / top.price) * 100);
  }
  return { base: compared === "stock" ? stock : crypto, side, rows, missing };
}
