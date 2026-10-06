/** MARKETS THE OWNER HAS NOT CONNECTED: what a venue's own public market data says, read without a key, so the Markets screen shows real
 * prices from venues that are not connected yet — each marked "Connect to trade" — beside the ones that are.
 *
 * Every source here only reads: no key, no sign-in, nothing signed, no order. What each one asks, and which of the venue's own fields it
 * keeps (docs.kraken.com, docs.cdp.coinbase.com, the exchange library's own parsers, docs.kalshi.com and docs.polymarket.com, read
 * 2026-10-05, and their live public answers that day):
 *
 *   Kraken, Coinbase,   the unified exchange library's keyless client (prices.ts) and fetchTickers, for well-known coins priced in dollars
 *   OKX, Binance        (USD, USDT, USDC) or the coins a query names. The 24-hour figures are read from each exchange's own answer (the
 *   (Bybit if asked)    ticker's `info`), never from what the library works out from it:
 *                         Kraken    c (the last trade), and v and p for the last 24 hours: the volume times its average price is the
 *                                   dollars traded. Its o is TODAY's open ("Today's opening price"), not the price a day ago, so no 24-hour
 *                                   change is shown for Kraken
 *                         Coinbase  price, price_percentage_change_24h, and approximate_quote_24h_volume — Coinbase's own figure, its
 *                                   24-hour volume at the current price
 *                         OKX       last, bidPx, askPx, open24h (the price 24 hours ago: the change is last − open24h), volCcy24h (a spot
 *                                   pair's volume in its quote currency)
 *                         Binance   lastPrice, bidPrice, askPrice, priceChange, priceChangePercent, quoteVolume
 *                         Bybit     lastPrice, bid1Price, ask1Price, prevPrice24h (the change is last − prevPrice24h), turnover24h
 *                       Binance answers this machine's location with HTTP 451, Bybit with 403: that is the exchange's own rule, and it is
 *                       reported as that, with the exchange's own words. Nothing here looks for another way in.
 *   Kalshi              GET /trade-api/v2/markets (status=open, combos left out; min_close_ts and max_close_ts for what closes soon) and
 *                       GET /events?tickers= for each market's event, which carries its category. Market data needs no key there. A market
 *                       is listed as its YES and its NO leg. volume_24h_fp counts CONTRACTS (each pays $1 at settlement), not dollars: it is
 *                       carried as `contracts24h` and never as dollars. The change is last_price_dollars − previous_price_dollars (the
 *                       last trade a day ago), in dollars per contract, the NO leg's the other way
 *   Polymarket          GET gamma /events (open ones, busiest first by volume24hr; end_date_min and end_date_max for what closes soon):
 *                       each event's markets — outcomes and outcomePrices, bestBid and bestAsk and oneDayPriceChange (all three the first
 *                       outcome's), volume24hr (dollars), endDate — and the event's tags, for its category
 *   Stock Tokens        GET api.robinhood.com/rhj/assets and /rhj/prices/{symbol}, the reads robinhood.ts makes: each token, and its own bid
 *                       and ask in dollars per token (tokenBid, tokenAsk). The listing itself is only read: the tokens trade from a
 *                       connected wallet on Robinhood Chain, against USDG through LI.FI (dex.ts), where the wallet's own rows offer them
 *
 * PRICE HISTORY (`candles`), keyless too, the same reads the connected traders make (live-checked 2026-10-06 without a key):
 *   the exchanges       the library's fetchOHLCV: the latest bars since the start asked, at most 300, for a pair the exchange lists
 *   Kalshi              GET /trade-api/v2/markets/candlesticks?market_tickers=&start_ts=&end_ts=&period_interval= (1, 60 or 1440 minutes;
 *                       five-minute bars are five one-minute candles folded); the trades' prices, a candle with no trade left out, NO as
 *                       1 − YES
 *   Polymarket          GET gamma /markets/slug/{slug} for the outcome's token id (clobTokenIds, in the order of `outcomes`), then the
 *                       CLOB's GET clob.polymarket.com/prices-history?market=&startTs=&fidelity= — Polymarket's price at moments, folded
 *                       into bars, no volume
 *   Stock Tokens        none: Robinhood publishes no history for them
 *
 * A request goes only to those fixed hosts, as a GET over https, with a time limit (the exchange library's clients go only to their own
 * exchange's hosts). An answer is kept twenty seconds (the Stock Token list ten minutes, a token's price one), so a page that asks every few
 * seconds does not ask the venue every time; a refusal is not kept. A public listing's markets carry no order types: nothing
 * is ordered through one. Keep one set of sources for the life of the service, so what they keep is kept.
 */
import { isRefusal, type Refusal } from "../../core/errors.ts";
import { no } from "../refuse.ts";
import { categoryOf } from "./categories.ts";
import { exchangeSaidNo, openExchange, type ExchangeClient, type OpenExchange } from "./exchange.ts";
import { keylessExchange, PUBLIC_EXCHANGES } from "./prices.ts";
import { STOCK_TOKEN_ISSUER, STOCK_TOKEN_TERMS, stockTokens } from "./robinhood.ts";
import { CANDLE_INTERVALS, inDollars, type Candle, type CandleInterval, type Market, type MarketStats } from "./trade.ts";
import { isStable, realHttp, REGION, unreachable, type Http, type HttpReply } from "./types.ts";

/** a market as a public source lists it: the shared shape, and what only a listing carries */
export type Listing = Market & {
  /** the venue's event the market belongs to, where an event holds several (Polymarket's "Brazil Presidential Election") */
  event?: { id: string; title: string } | undefined;
  /** every category word and tag the venue gives it, for the tabs (categories.ts) */
  tags?: string[] | undefined;
};

export interface ListingsQuery {
  /** a few letters of a symbol or a name; absent: the source's well-known or busiest markets */
  q?: string | undefined;
  /** at most this many markets (an event market counts once, however many outcomes it has) */
  limit: number;
}

export interface EventsQuery {
  /** in the venue's own words ("Economics", "Sports") */
  category?: string | undefined;
  /** closing within this many milliseconds from now */
  closingWithinMs?: number | undefined;
  limit: number;
}

export interface PublicSource {
  id: string;
  name: string;
  /** an exchange's coins, event contracts, or tokens that stand for shares */
  kind: "exchange" | "events" | "tokens";
  /** the venue on the account this is the public side of, as the owner would connect it to trade (`okx`), and the connection that does
   * (`live:exchange:okx`) */
  connectTo: string;
  connector: string;
  /** why nothing is traded through this listing itself, when nothing is (Stock Tokens: they trade from a connected wallet's own rows) */
  readOnly?: string | undefined;
  listings(o: ListingsQuery): Promise<Listing[] | Refusal>;
  /** the last 24 hours of the markets named (absent: the well-known ones), by symbol */
  stats?(symbols?: string[]): Promise<Map<string, MarketStats> | Refusal>;
  /** event contracts, each with its question (`group`), close time and category, busiest first */
  events?(o: EventsQuery): Promise<Listing[] | Refusal>;
  /** one market's price history since `sinceMs`, oldest first: `symbol` as its listing names it */
  candles?(symbol: string, interval: CandleInterval, sinceMs: number): Promise<Candle[] | Refusal>;
}

export interface PublicDeps {
  /** the network (a stand-in in tests); every request still goes through the fixed-host guard below */
  http?: Http | undefined;
  /** the exchange library (a stand-in in tests) */
  open?: OpenExchange | undefined;
  clock?: (() => number) | undefined;
  /** how long one request may take, in milliseconds (8000) */
  timeoutMs?: number | undefined;
}

/** the only hosts a public source's own requests go to */
export const PUBLIC_HOSTS: readonly string[] = ["external-api.kalshi.com", "gamma-api.polymarket.com", "clob.polymarket.com", "api.robinhood.com"];
const KALSHI = "https://external-api.kalshi.com/trade-api/v2";
const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";
const KEEP_MS = 20_000;
const PRICE_MS = 60_000;
/** price history is kept a minute */
const HISTORY_MS = 60_000;
/** the most bars one history reads */
const BARS = 300;
const BAR_MS: Record<CandleInterval, number> = { "5m": 300_000, "1h": 3_600_000, "1d": 86_400_000 };
const TIMEOUT_MS = 8_000;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);
const rec = (v: unknown): Rec => (isRec(v) ? v : {});
/** a list, or a list written as a JSON string (Gamma's outcomes and prices) */
function list(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v === "string" && v.trim().startsWith("[")) {
    try {
      const x: unknown = JSON.parse(v);
      return Array.isArray(x) ? x : [];
    } catch {
      return [];
    }
  }
  return [];
}
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);
/** a finite number, from a number or a numeric string; never 0 for a field that is not there */
const fin = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};
const pos = (v: unknown): number | undefined => {
  const n = fin(v);
  return n !== undefined && n > 0 ? n : undefined;
};
const nonNeg = (v: unknown): number | undefined => {
  const n = fin(v);
  return n !== undefined && n >= 0 ? n : undefined;
};
/** an event contract's price: more than 0 and less than 1 (an empty side of Kalshi's book shows as 0 or 1, and neither is a price) */
const px = (v: unknown): number | undefined => {
  const n = fin(v);
  return n !== undefined && n > 0 && n < 1 ? n : undefined;
};
const round = (x: number, places = 6): number => Number(x.toFixed(places));
const mid = (bid: number | undefined, ask: number | undefined): number | undefined => (bid !== undefined && ask !== undefined && ask >= bid ? round((bid + ask) / 2, 10) : undefined);
const has = (q: string, ...fields: unknown[]): boolean => fields.some((f) => typeof f === "string" && f.toUpperCase().includes(q));

/** The network as a public source uses it: a GET over https to one of `hosts`, on the default port, with no user in the URL, within
 * `timeoutMs`. Anything else is not asked */
export function fixedHosts(http: Http, hosts: readonly string[], timeoutMs: number): Http {
  return async (url, init = {}) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new Error("not a URL: not asked");
    }
    if (u.protocol !== "https:" || u.username || u.password || u.port || !hosts.includes(u.hostname) || (init.method ?? "GET") !== "GET" || init.body !== undefined) throw new Error(`${u.protocol}//${u.host} is not asked: a public market is read with a GET from ${hosts.join(", ")} only`);
    return http(url, { method: "GET", headers: { accept: "application/json", ...(init.headers ?? {}) }, timeoutMs: Math.min(init.timeoutMs ?? timeoutMs, timeoutMs) });
  };
}

/** a public answer that is not a yes, as a refusal with the venue's own words; there is no key, so a 403 is not "the key may not" */
function publicNo(venue: string, name: string, r: HttpReply): Refusal {
  const native = { status: r.status, said: r.text.replace(/\s+/g, " ").trim().slice(0, 220) };
  if (r.status === 451 || (r.status !== 200 && REGION.test(r.text))) return no("E_VENUE_GEOBLOCKED", { venue, message: `${name} does not serve this location: that is its own rule, and the account does not look for a way around it`, native });
  if (r.status === 429) return no("E_VENUE_UNREACHABLE", { venue, message: `${name} is rate-limiting this machine: try again in a minute`, native });
  if (r.status >= 500 || r.status === 0) return no("E_VENUE_UNREACHABLE", { venue, message: `${name} did not answer`, native });
  if (r.status === 200) return no("E_VENUE_REJECTED", { venue, message: `${name} answered in a way this could not read`, native: { status: 200 } });
  return no("E_VENUE_REJECTED", { venue, message: `${name} refused the request (HTTP ${r.status})`, native });
}

/** an answer kept for `ms`, and one asked only once while it is on its way; a refusal or a throw is not kept */
function keeper<T>(clock: () => number, ms: number): (key: string, run: () => Promise<T | Refusal>) => Promise<T | Refusal> {
  const kept = new Map<string, { at: number; p: Promise<T | Refusal> }>();
  return (key, run) => {
    const now = clock();
    const hit = kept.get(key);
    if (hit && now - hit.at < ms) return hit.p;
    const p: Promise<T | Refusal> = run().then(
      (r) => {
        if (isRefusal(r) && kept.get(key)?.p === p) kept.delete(key);
        return r;
      },
      (err: unknown) => {
        if (kept.get(key)?.p === p) kept.delete(key);
        throw err;
      },
    );
    kept.set(key, { at: now, p });
    if (kept.size > 200) kept.delete(kept.keys().next().value!);
    return p;
  };
}

/** one JSON answer from a fixed host, kept for a while: the body, or the venue's refusal */
function getter(get: Http, venue: string, name: string, clock: () => number, ms = KEEP_MS): (url: string) => Promise<unknown> {
  const keep = keeper<unknown>(clock, ms);
  return (url) =>
    keep(url, async () => {
      let r: HttpReply;
      try {
        r = await get(url);
      } catch (err) {
        return unreachable(venue, name, err);
      }
      return r.status === 200 && r.body !== undefined ? r.body : publicNo(venue, name, r);
    });
}

/** a history's interval and start, held to what a public source takes: one of the three intervals, a start before now */
function badHistory(venue: string, interval: string, sinceMs: number, now: number): Refusal | undefined {
  if (!(CANDLE_INTERVALS as readonly string[]).includes(interval)) return no("E_ACCOUNT_BAD_ACTION", { venue, message: `price history comes in bars of ${CANDLE_INTERVALS.join(", ")}, not "${String(interval).slice(0, 12)}"` });
  if (!(Number.isFinite(sinceMs) && sinceMs >= 0 && sinceMs < now)) return no("E_ACCOUNT_BAD_ACTION", { venue, message: "price history starts before now" });
  return undefined;
}

/** prices at moments (`t` in seconds) folded into bars of `step` ms: open and close the first and last, high and low the extremes */
function foldPoints(points: Array<{ t: number; p: number }>, step: number): Candle[] {
  const bars = new Map<number, Candle>();
  for (const { t, p } of [...points].sort((a, b) => a.t - b.t)) {
    const at = Math.floor((t * 1000) / step) * step;
    const b = bars.get(at);
    if (!b) bars.set(at, { t: at, o: p, h: p, l: p, c: p });
    else {
      b.h = Math.max(b.h, p);
      b.l = Math.min(b.l, p);
      b.c = p;
    }
  }
  return [...bars.values()];
}

// ---- exchanges, through the unified library's keyless client ---------------------------------------------------

/** what the exchange's own ticker says, field by field (see the top of this file) */
interface Said {
  last?: number | undefined;
  bid?: number | undefined;
  ask?: number | undefined;
  changePct?: number | undefined;
  change?: number | undefined;
  quoteVolume?: number | undefined;
  open?: boolean | undefined;
}
/** a change measured from the venue's own price of 24 hours ago */
const since = (last: number | undefined, then: number | undefined): Pick<Said, "change" | "changePct"> => (last !== undefined && then !== undefined ? { change: round(last - then, 10), changePct: round(((last - then) / then) * 100, 4) } : {});

const EXCHANGES: Readonly<Record<string, { name: string; read: (info: Rec) => Said }>> = {
  kraken: {
    name: "Kraken",
    read: (i) => {
      const vol = pos(list(i.v)[1]);
      const vwap = pos(list(i.p)[1]);
      return { last: pos(list(i.c)[0]), bid: pos(list(i.b)[0]), ask: pos(list(i.a)[0]), ...(vol !== undefined && vwap !== undefined ? { quoteVolume: round(vol * vwap, 2) } : {}) };
    },
  },
  coinbase: {
    name: "Coinbase",
    read: (i) => ({ last: pos(i.price), changePct: fin(i.price_percentage_change_24h), quoteVolume: nonNeg(i.approximate_quote_24h_volume), open: i.trading_disabled !== true && i.is_disabled !== true }),
  },
  okx: {
    name: "OKX",
    read: (i) => ({ last: pos(i.last), bid: pos(i.bidPx), ask: pos(i.askPx), ...since(pos(i.last), pos(i.open24h)), quoteVolume: nonNeg(i.volCcy24h) }),
  },
  binance: {
    name: "Binance",
    read: (i) => ({ last: pos(i.lastPrice), bid: pos(i.bidPrice), ask: pos(i.askPrice), change: fin(i.priceChange), changePct: fin(i.priceChangePercent), quoteVolume: nonNeg(i.quoteVolume) }),
  },
  bybit: {
    name: "Bybit",
    read: (i) => ({ last: pos(i.lastPrice), bid: pos(i.bid1Price), ask: pos(i.ask1Price), ...since(pos(i.lastPrice), pos(i.prevPrice24h)), quoteVolume: nonNeg(i.turnover24h) }),
  },
};

/** coins well enough known to be shown before anything is typed, most valued first */
const COINS = ["BTC", "ETH", "SOL", "XRP", "BNB", "DOGE", "ADA", "TRX", "TON", "LINK", "AVAX", "SUI", "XLM", "HBAR", "DOT", "LTC", "BCH", "SHIB", "UNI", "AAVE", "NEAR", "APT", "ARB", "OP", "PEPE", "ATOM", "FIL", "ETC", "INJ", "ONDO", "HYPE", "ENA", "WLD", "SEI", "TIA", "POL"];
const DOLLARS = ["USD", "USDT", "USDC"];

interface CcxtMarket {
  symbol?: string;
  base?: string;
  quote?: string;
  spot?: boolean;
  active?: boolean;
}
type Tickers = Record<string, { info?: unknown; last?: number; bid?: number; ask?: number } | undefined>;

/** the pairs to ask for: the well-known coins in dollars, or the coins in dollars whose name starts with the query */
function pairsFor(markets: Record<string, unknown> | undefined, q: string | undefined): string[] {
  const all = markets ?? {};
  const live = (s: string): CcxtMarket | undefined => {
    const m = all[s] as CcxtMarket | undefined;
    return m && m.spot !== false && m.active !== false ? m : undefined;
  };
  const Q = (q ?? "").trim().toUpperCase();
  if (!Q) return COINS.flatMap((c) => DOLLARS.map((d) => `${c}/${d}`)).filter((s) => live(s) !== undefined);
  return Object.keys(all)
    .map((s) => ({ s, m: live(s) }))
    .filter((x): x is { s: string; m: CcxtMarket } => x.m !== undefined && typeof x.m.base === "string" && typeof x.m.quote === "string" && inDollars(x.m.quote) && !isStable(x.m.base) && x.m.base.toUpperCase().startsWith(Q) && !x.s.includes(":"))
    .sort((a, b) => Number(b.m.base!.toUpperCase() === Q) - Number(a.m.base!.toUpperCase() === Q) || a.m.base!.length - b.m.base!.length || a.s.localeCompare(b.s))
    .slice(0, 45)
    .map((x) => x.s);
}

/** One exchange's public tickers, keyless, through the unified library. An exchange that does not serve this location answers with its own
 * refusal, which is passed on as it is */
export function exchangeTickers(id: string, deps: PublicDeps = {}): PublicSource {
  const reader = EXCHANGES[id];
  const name = reader?.name ?? id;
  const open = deps.open ?? openExchange;
  const clock = deps.clock ?? Date.now;
  const keep = keeper<Listing[]>(clock, KEEP_MS);
  const history = keeper<Candle[]>(clock, HISTORY_MS);
  // the library keeps a failed load of the markets and answers it again: after a failure they are loaded afresh
  let reload = false;
  const read = (symbols: string[] | undefined, q: string | undefined): Promise<Listing[] | Refusal> =>
    keep(`${symbols ? symbols.join(",") : ""}|${q ?? ""}`, async () => {
      let x: ExchangeClient | undefined;
      try {
        x = await keylessExchange(id, open);
        if (!x) return no("E_WALLET_UNKNOWN_VENUE", { venue: id, message: `the exchange library knows no exchange called "${id}"` });
        if (!x.fetchTickers) return no("E_VENUE_REJECTED", { venue: id, message: `the exchange library reads no tickers from ${name}` });
        await x.loadMarkets?.(reload);
        reload = false;
        const want = (symbols ?? pairsFor(x.markets, q)).filter((s) => x!.markets === undefined || x!.markets[s] !== undefined);
        if (!want.length) return [];
        const tickers = (await x.fetchTickers(want)) as Tickers;
        const out: Listing[] = [];
        for (const s of want) {
          const t = tickers[s];
          if (!t) continue;
          const m = (x.markets?.[s] ?? {}) as CcxtMarket;
          const base = str(m.base) ?? s.split("/")[0]!;
          const quote = str(m.quote) ?? (s.split("/")[1] ?? "").split(":")[0]!;
          if (!inDollars(quote)) continue;
          // an exchange whose answer this file has not read the docs of shows its price and nothing it would have to trust the library for
          const said: Said = reader ? reader.read(rec(t.info)) : { last: pos(t.last), bid: pos(t.bid), ask: pos(t.ask) };
          const price = said.last ?? mid(said.bid, said.ask);
          if (price === undefined) continue;
          out.push({
            symbol: s,
            name: `${base} / ${quote}`,
            kind: "spot",
            base,
            quote,
            price,
            bid: said.bid,
            ask: said.ask,
            open: m.active !== false && said.open !== false,
            types: [],
            ...(said.changePct !== undefined ? { changePct24h: said.changePct } : {}),
            ...(said.change !== undefined ? { change24h: said.change } : {}),
            ...(said.quoteVolume !== undefined ? { volumeUsd24h: said.quoteVolume } : {}),
          });
        }
        return out;
      } catch (err) {
        reload = true;
        return exchangeSaidNo(id, name, err, {});
      }
    });
  return {
    id,
    name,
    kind: "exchange",
    connectTo: id,
    connector: `live:exchange:${id}`,
    async listings(o) {
      const got = await read(undefined, o.q);
      if (isRefusal(got)) return got;
      return [...got].sort((a, b) => (b.volumeUsd24h ?? -1) - (a.volumeUsd24h ?? -1)).slice(0, Math.max(1, o.limit));
    },
    async stats(symbols) {
      const got = await read(symbols?.length ? [...symbols].sort() : undefined, undefined);
      if (isRefusal(got)) return got;
      return new Map(got.map((m) => [m.symbol, { price: m.price, changePct24h: m.changePct24h, change24h: m.change24h, volumeUsd24h: m.volumeUsd24h }]));
    },
    /** fetchOHLCV, keyless: only for a pair the exchange lists (the library is asked for nothing it has not listed), at most 300 bars, the
     * volume in the coin (a spot market's) */
    candles: (symbol, interval, sinceMs) =>
      history(`${symbol}|${interval}|${Math.floor(sinceMs / 60_000)}`, async () => {
        const bad = badHistory(id, interval, sinceMs, clock());
        if (bad) return bad;
        try {
          const x = await keylessExchange(id, open);
          if (!x) return no("E_WALLET_UNKNOWN_VENUE", { venue: id, message: `the exchange library knows no exchange called "${id}"` });
          await x.loadMarkets?.(reload);
          reload = false;
          if (!x.fetchOHLCV) return no("E_VENUE_RAIL_CLOSED", { venue: id, message: `${name} has no price history the library can read` });
          const m = x.markets?.[symbol] as CcxtMarket | undefined;
          if (!m || m.spot === false || !inDollars(str(m.quote) ?? "")) return no("E_VENUE_REJECTED", { venue: id, message: `${name} lists no market ${symbol.slice(0, 40)} priced in dollars` });
          if (x.timeframes !== undefined && rec(x.timeframes)[interval] === undefined) return no("E_VENUE_RAIL_CLOSED", { venue: id, message: `${name} keeps no ${interval} bars` });
          const from = Math.max(Math.floor(sinceMs), clock() - BARS * BAR_MS[interval]);
          const rows = await x.fetchOHLCV(symbol, interval, from, BARS);
          const bars = new Map<number, Candle>();
          for (const r of Array.isArray(rows) ? rows : []) {
            if (!Array.isArray(r)) continue;
            const [t, o, h, l, c, v] = [fin(r[0]), pos(r[1]), pos(r[2]), pos(r[3]), pos(r[4]), nonNeg(r[5])];
            if (t === undefined || t < from || o === undefined || h === undefined || l === undefined || c === undefined) continue;
            bars.set(t, { t, o, h, l, c, ...(v !== undefined ? { v } : {}) });
          }
          return [...bars.values()].sort((a, b) => a.t - b.t);
        } catch (err) {
          reload = true;
          return exchangeSaidNo(id, name, err, {});
        }
      }),
  };
}

// ---- Kalshi ---------------------------------------------------------------------------------------------------

/** a market Kalshi trades now: active, priced in dollars, not a combo (multivariate event) */
const kalshiLive = (m: Rec): boolean => m.status === "active" && typeof m.ticker === "string" && !m.ticker.startsWith("KXMVE") && ["yes_bid_dollars", "yes_ask_dollars", "last_price_dollars"].some((k) => typeof m[k] === "string");
const kalshiBusier = (a: Rec, b: Rec): number => (nonNeg(b.volume_24h_fp) ?? 0) - (nonNeg(a.volume_24h_fp) ?? 0) || (nonNeg(b.volume_fp) ?? 0) - (nonNeg(a.volume_fp) ?? 0);

interface KalshiEvent {
  title?: string | undefined;
  category?: string | undefined;
}

/** one Kalshi market as its two legs, in the names the account's Kalshi trader gives them (`<ticker>:YES`, `<ticker>:NO`) */
function kalshiLegs(m: Rec, ev: KalshiEvent | undefined): Listing[] {
  const ticker = String(m.ticker).toUpperCase();
  const title = str(m.title) ?? "";
  const sub = str(m.yes_sub_title) ?? "";
  const words = title ? (sub && !title.includes(sub) ? `${title} (${sub})` : title) : sub || ticker;
  const lastYes = px(m.last_price_dollars);
  const before = px(m.previous_price_dollars);
  const moved = lastYes !== undefined && before !== undefined ? round(lastYes - before, 4) : undefined;
  const eventTicker = str(m.event_ticker);
  return (["YES", "NO"] as const).map((outcome): Listing => {
    const yes = outcome === "YES";
    const bid = px(yes ? m.yes_bid_dollars : m.no_bid_dollars);
    const ask = px(yes ? m.yes_ask_dollars : m.no_ask_dollars);
    // every trade is a YES and a NO at prices that make a dollar: the NO leg's last price is the other side of the YES leg's
    const last = lastYes === undefined ? undefined : yes ? lastYes : round(1 - lastYes, 4);
    return {
      symbol: `${ticker}:${outcome}`,
      name: `${words} · ${yes ? "Yes" : "No"}`,
      kind: "event",
      base: `${ticker}:${outcome}`,
      quote: "USD",
      price: last ?? mid(bid, ask),
      bid,
      ask,
      open: m.status === "active",
      types: [],
      group: { id: ticker, title: words },
      outcome,
      ...(str(m.close_time) ? { closeTime: str(m.close_time) } : {}),
      ...(ev?.category ? { category: ev.category, tags: [ev.category] } : {}),
      ...(moved !== undefined ? { change24h: yes ? moved : -moved } : {}),
      ...(nonNeg(m.volume_24h_fp) !== undefined ? { contracts24h: nonNeg(m.volume_24h_fp) } : {}),
      ...(eventTicker && ev?.title ? { event: { id: eventTicker, title: ev.title } } : {}),
    };
  });
}

/** Kalshi's open markets, keyless: the busiest first, with each one's event (its category) */
export function kalshiPublic(deps: PublicDeps = {}): PublicSource {
  const id = "kalshi";
  const name = "Kalshi";
  const clock = deps.clock ?? Date.now;
  const get = getter(fixedHosts(deps.http ?? realHttp, PUBLIC_HOSTS, deps.timeoutMs ?? TIMEOUT_MS), id, name, clock);
  /** each event's title and category, forty events a request; an event that does not answer leaves its markets without a category */
  const eventsOf = async (tickers: string[]): Promise<Map<string, KalshiEvent>> => {
    const out = new Map<string, KalshiEvent>();
    const all = [...new Set(tickers)].sort();
    const chunks: string[][] = [];
    for (let i = 0; i < all.length; i += 40) chunks.push(all.slice(i, i + 40));
    await Promise.all(
      chunks.map(async (c) => {
        const body = await get(`${KALSHI}/events?tickers=${c.map(encodeURIComponent).join(",")}&limit=200`).catch(() => undefined);
        for (const e of list(rec(body).events).filter(isRec)) {
          const t = str(e.event_ticker);
          if (t) out.set(t, { title: str(e.title), category: str(e.category) });
        }
      }),
    );
    return out;
  };
  const read = async (o: { q?: string | undefined; category?: string | undefined; closingWithinMs?: number | undefined; limit: number }): Promise<Listing[] | Refusal> => {
    const window = pos(o.closingWithinMs);
    // to the minute, so that a page asking every few seconds asks the same question and is answered from what was kept
    const now = Math.floor(clock() / 60_000) * 60;
    const body = await get(`${KALSHI}/markets?status=open&mve_filter=exclude&limit=1000${window ? `&min_close_ts=${now}&max_close_ts=${now + Math.ceil(window / 1000)}` : ""}`);
    if (isRefusal(body)) return body;
    if (!isRec(body) || !Array.isArray(body.markets)) return no("E_VENUE_REJECTED", { venue: id, message: `${name} answered without its markets` });
    const Q = (o.q ?? "").trim().toUpperCase();
    const markets = body.markets.filter(isRec).filter(kalshiLive).filter((m) => !Q || has(Q, m.ticker, m.title, m.yes_sub_title, m.event_ticker)).sort(kalshiBusier);
    const limit = Math.max(1, o.limit);
    // a category is the event's: four times as many markets are looked at when one is asked, since some will be in others
    const pool = markets.slice(0, o.category ? limit * 4 : limit);
    const events = await eventsOf(pool.map((m) => String(m.event_ticker ?? "")).filter(Boolean));
    const want = o.category?.trim().toLowerCase();
    return pool
      .filter((m) => !want || events.get(String(m.event_ticker ?? ""))?.category?.toLowerCase() === want)
      .slice(0, limit)
      .flatMap((m) => kalshiLegs(m, events.get(String(m.event_ticker ?? ""))));
  };
  return {
    id,
    name,
    kind: "events",
    connectTo: "kalshi",
    connector: "live:kalshi",
    listings: (o) => read(o),
    events: (o) => read(o),
    /** a market's price history, keyless (see the top of this file): `<ticker>:YES` or `<ticker>:NO` */
    async candles(symbol, interval, sinceMs) {
      const now = clock();
      const bad = badHistory(id, interval, sinceMs, now);
      if (bad) return bad;
      const k = /^([A-Za-z0-9][A-Za-z0-9._-]{0,80}):(YES|NO)$/i.exec(symbol.trim());
      if (!k) return no("E_ACCOUNT_BAD_ACTION", { venue: id, message: `a Kalshi market here is <ticker>:YES or <ticker>:NO, not "${symbol.slice(0, 40)}"` });
      const ticker = k[1]!.toUpperCase();
      const yes = k[2]!.toUpperCase() === "YES";
      const period = KALSHI_PERIOD[interval];
      const body = await get(`${KALSHI}/markets/candlesticks?market_tickers=${encodeURIComponent(ticker)}&start_ts=${Math.floor(sinceMs / 1000)}&end_ts=${Math.floor(now / 60_000) * 60}&period_interval=${period}`);
      if (isRefusal(body)) return body;
      const row = list(rec(body).markets).filter(isRec).find((x) => String(x.market_ticker ?? "").toUpperCase() === ticker);
      if (!row) return no("E_VENUE_REJECTED", { venue: id, message: `${name} has no market ${ticker}` });
      const fold = interval === "5m" ? 5 * 60_000 : 0;
      const bars = new Map<number, Candle>();
      for (const c of list(row.candlesticks).filter(isRec).sort((a, b) => (fin(a.end_period_ts) ?? 0) - (fin(b.end_period_ts) ?? 0))) {
        const p = rec(c.price);
        const [yo, yh, yl, yc] = [fin(p.open_dollars), fin(p.high_dollars), fin(p.low_dollars), fin(p.close_dollars)];
        const end = fin(c.end_period_ts);
        if (yo === undefined || yh === undefined || yl === undefined || yc === undefined || end === undefined || !(end > 0)) continue;
        const [o, h, l, cl] = yes ? [yo, yh, yl, yc] : [round(1 - yo, 4), round(1 - yl, 4), round(1 - yh, 4), round(1 - yc, 4)];
        const v = nonNeg(c.volume_fp);
        const start = (end - period * 60) * 1000;
        const t = fold ? Math.floor(start / fold) * fold : start;
        const b = bars.get(t);
        if (!b) bars.set(t, { t, o, h, l, c: cl, ...(v !== undefined ? { v } : {}) });
        else {
          b.h = Math.max(b.h, h);
          b.l = Math.min(b.l, l);
          b.c = cl;
          if (v !== undefined) b.v = round((b.v ?? 0) + v, 2);
        }
      }
      return [...bars.values()];
    },
  };
}

/** Kalshi keeps candles of 1, 60 and 1440 minutes: five-minute bars are folded from one-minute candles */
const KALSHI_PERIOD: Record<CandleInterval, number> = { "5m": 1, "1h": 60, "1d": 1440 };

// ---- Polymarket -----------------------------------------------------------------------------------------------

/** one Gamma market as its outcomes, in the names the account's Polymarket trader gives them (`<slug>:<outcome>`) */
function polymarketLegs(m: Rec, e: Rec, tags: string[]): Listing[] {
  const slug = str(m.slug);
  const conditionId = str(m.conditionId);
  const names = list(m.outcomes).map((x) => String(x));
  if (!slug || !conditionId || names.length < 2) return [];
  const prices = list(m.outcomePrices).map(fin);
  const question = str(m.question) ?? slug;
  const why = m.closed === true ? "the market is closed" : m.archived === true ? "the market is archived" : m.active !== true ? "the market is not active" : m.enableOrderBook !== true ? "the market has no order book" : m.acceptingOrders !== true ? "Polymarket is not taking orders in it now" : undefined;
  const closeTime = str(m.endDate) ?? str(e.endDate);
  const category = categoryOf([str(e.category), ...tags]);
  const volume = nonNeg(m.volume24hr);
  const eventId = str(e.id) ?? (typeof e.id === "number" ? String(e.id) : undefined);
  return names.map((outcome, i): Listing => {
    const p = prices[i];
    const first = i === 0;
    return {
      symbol: `${slug}:${outcome}`,
      name: `${question} · ${outcome}`,
      kind: "event",
      base: outcome,
      quote: "pUSD",
      price: p !== undefined && p >= 0 && p <= 1 ? p : undefined,
      // Gamma's best bid and ask, and its day's change, are the first outcome's
      bid: first ? px(m.bestBid) : undefined,
      ask: first ? px(m.bestAsk) : undefined,
      open: why === undefined,
      ...(why ? { note: why } : {}),
      types: [],
      group: { id: conditionId, title: question },
      outcome,
      ...(closeTime ? { closeTime } : {}),
      ...(category ? { category } : {}),
      ...(tags.length ? { tags } : {}),
      ...(first && fin(m.oneDayPriceChange) !== undefined ? { change24h: fin(m.oneDayPriceChange) } : {}),
      ...(volume !== undefined ? { volumeUsd24h: volume } : {}),
      ...(eventId && str(e.title) ? { event: { id: eventId, title: str(e.title)! } } : {}),
    };
  });
}

/** Polymarket's open events, keyless, through Gamma: the busiest markets first */
export function polymarketPublic(deps: PublicDeps = {}): PublicSource {
  const id = "polymarket";
  const name = "Polymarket";
  const clock = deps.clock ?? Date.now;
  const get = getter(fixedHosts(deps.http ?? realHttp, PUBLIC_HOSTS, deps.timeoutMs ?? TIMEOUT_MS), id, name, clock);
  const clob = getter(fixedHosts(deps.http ?? realHttp, PUBLIC_HOSTS, deps.timeoutMs ?? TIMEOUT_MS), id, name, clock, HISTORY_MS);
  const read = async (o: { q?: string | undefined; category?: string | undefined; closingWithinMs?: number | undefined; limit: number }): Promise<Listing[] | Refusal> => {
    const window = pos(o.closingWithinMs);
    const now = Math.floor(clock() / 60_000) * 60_000;
    const limit = Math.max(1, o.limit);
    const range = window ? `&end_date_min=${new Date(now).toISOString()}&end_date_max=${new Date(now + window).toISOString()}` : "";
    const body = await get(`${GAMMA}/events?closed=false&active=true&archived=false&order=volume24hr&ascending=false&limit=${Math.min(100, Math.max(20, limit))}${range}`);
    if (isRefusal(body)) return body;
    if (!Array.isArray(body)) return no("E_VENUE_REJECTED", { venue: id, message: `${name} answered without its events` });
    const Q = (o.q ?? "").trim().toUpperCase();
    const want = o.category?.trim().toLowerCase();
    const picked: Array<{ m: Rec; e: Rec; tags: string[] }> = [];
    for (const e of body.filter(isRec)) {
      const tagList = list(e.tags).filter(isRec);
      const tags = [...new Set([...tagList.map((t) => str(t.label)), ...tagList.map((t) => str(t.slug))].filter((t): t is string => t !== undefined))];
      if (want && !tags.some((t) => t.toLowerCase() === want) && str(e.category)?.toLowerCase() !== want) continue;
      for (const m of list(e.markets).filter(isRec)) {
        if (m.closed === true || m.active !== true) continue;
        if (Q && !has(Q, m.question, m.slug, e.title, e.slug)) continue;
        if (window) {
          const end = Date.parse(String(m.endDate ?? e.endDate ?? ""));
          if (!(end > clock() && end <= clock() + window)) continue;
        }
        picked.push({ m, e, tags });
      }
    }
    return picked
      .sort((a, b) => (nonNeg(b.m.volume24hr) ?? 0) - (nonNeg(a.m.volume24hr) ?? 0))
      .slice(0, limit)
      .flatMap((x) => polymarketLegs(x.m, x.e, x.tags));
  };
  return {
    id,
    name,
    kind: "events",
    connectTo: "polymarket",
    connector: "live:polymarket-trade",
    listings: (o) => read(o),
    events: (o) => read(o),
    /** an outcome's price history, keyless (see the top of this file): `<slug>:<outcome>`, as the listing names it */
    async candles(symbol, interval, sinceMs) {
      const now = clock();
      const bad = badHistory(id, interval, sinceMs, now);
      if (bad) return bad;
      const i = symbol.indexOf(":");
      const slug = i > 0 ? symbol.slice(0, i).trim() : "";
      const outcome = i > 0 ? symbol.slice(i + 1).trim() : "";
      if (!/^[a-z0-9][a-z0-9-]{0,200}$/.test(slug) || !outcome || outcome.length > 80) return no("E_ACCOUNT_BAD_ACTION", { venue: id, message: `a Polymarket market here is <slug>:<outcome>, not "${symbol.slice(0, 40)}"` });
      const m = await get(`${GAMMA}/markets/slug/${encodeURIComponent(slug)}`);
      if (isRefusal(m)) return m;
      const names = list(rec(m).outcomes).map((x) => String(x));
      const tokens = list(rec(m).clobTokenIds).map((x) => String(x));
      const at = names.findIndex((n) => n.toLowerCase() === outcome.toLowerCase());
      const token = at >= 0 ? tokens[at] : undefined;
      if (!token || !/^\d{1,90}$/.test(token)) return no("E_VENUE_REJECTED", { venue: id, message: `${name} has no outcome "${outcome.slice(0, 40)}" in ${slug.slice(0, 60)}` });
      // Polymarket refuses a start-to-end range longer than about fifteen days; a longer history is asked from its start alone
      const range = now - sinceMs > 14 * 86_400_000 ? "" : `&endTs=${Math.floor(now / 60_000) * 60}`;
      const body = await clob(`${CLOB}/prices-history?market=${token}&startTs=${Math.floor(sinceMs / 1000)}${range}&fidelity=${POLY_FIDELITY[interval]}`);
      if (isRefusal(body)) return body;
      const points = list(rec(body).history).filter(isRec).map((x) => ({ t: fin(x.t), p: fin(x.p) })).filter((x): x is { t: number; p: number } => x.t !== undefined && x.t > 0 && x.p !== undefined && x.p >= 0 && x.p <= 1);
      return foldPoints(points, BAR_MS[interval]);
    },
  };
}

/** the minutes between the prices a Polymarket bar is folded from */
const POLY_FIDELITY: Record<CandleInterval, number> = { "5m": 1, "1h": 5, "1d": 60 };

// ---- Robinhood Stock Tokens -----------------------------------------------------------------------------------

/** shares well enough known to be shown first, before anything is typed */
const SHARES = ["NVDA", "AAPL", "MSFT", "AMZN", "GOOGL", "META", "TSLA", "AVGO", "SPY", "QQQ", "AMD", "NFLX", "COIN", "HOOD", "MSTR", "PLTR"];

/** Robinhood's Stock Tokens, keyless: each token and its own bid and ask in dollars. Read-only */
export function stockTokensPublic(deps: PublicDeps = {}): PublicSource {
  const id = "robinhood-stock-tokens";
  const name = "Robinhood Stock Tokens";
  const clock = deps.clock ?? Date.now;
  // one guarded network for the life of the source: robinhood.ts keeps the token list per network
  const http = fixedHosts(deps.http ?? realHttp, PUBLIC_HOSTS, deps.timeoutMs ?? TIMEOUT_MS);
  const quote = getter(http, id, name, clock, PRICE_MS);
  return {
    id,
    name,
    kind: "tokens",
    connectTo: "robinhood-wallet",
    connector: "live:wallet",
    readOnly: "Robinhood's own prices: a Stock Token trades from a connected wallet on Robinhood Chain, against USDG",
    async listings(o) {
      let tokens: Array<{ symbol: string; name: string }>;
      try {
        tokens = await stockTokens(http, clock());
      } catch (err) {
        return isRefusal(err) ? err : unreachable(id, name, err);
      }
      const seen = new Set<string>();
      const one = tokens.filter((t) => !seen.has(t.symbol) && seen.add(t.symbol));
      const Q = (o.q ?? "").trim().toUpperCase();
      const rank = (s: string) => (SHARES.includes(s) ? SHARES.indexOf(s) : SHARES.length);
      const pool = (Q ? one.filter((t) => has(Q, t.symbol, t.name)).sort((a, b) => Number(b.symbol === Q) - Number(a.symbol === Q) || Number(b.symbol.startsWith(Q)) - Number(a.symbol.startsWith(Q))) : one.map((t, i) => ({ t, i })).sort((a, b) => rank(a.t.symbol) - rank(b.t.symbol) || a.i - b.i).map((x) => x.t)).slice(0, Math.max(1, o.limit));
      // eight at a time: Robinhood allows sixty requests a second
      const quotes = new Map<string, Rec>();
      for (let i = 0; i < pool.length; i += 8)
        await Promise.all(
          pool.slice(i, i + 8).map(async (t) => {
            const body = await quote(`https://api.robinhood.com/rhj/prices/${encodeURIComponent(t.symbol)}`).catch(() => undefined);
            const q = rec(list(rec(body).quotes)[0]);
            if (str(q.currency) === "USD") quotes.set(t.symbol, q);
          }),
        );
      return pool.map((t): Listing => {
        const q = quotes.get(t.symbol);
        const bid = pos(q?.tokenBid);
        const ask = pos(q?.tokenAsk);
        const halted = q?.isTradingHalt === true;
        // the issuer and whom it says the tokens are not for, in its own words (robinhood.ts): Markets shows them beside the price
        return { symbol: t.symbol, name: t.name, kind: "token", base: t.symbol, quote: "USD", price: mid(bid, ask) ?? bid ?? ask, bid, ask, open: q !== undefined && !halted, ...(halted ? { note: "Robinhood has halted trading in it" } : q ? {} : { note: "Robinhood gave no price for it just now" }), types: [], issuer: STOCK_TOKEN_ISSUER, eligibility: STOCK_TOKEN_TERMS };
      });
    },
  };
}

/** every public source, in the order the Markets screen asks them: the exchanges (PUBLIC_EXCHANGES unless others are named), Kalshi,
 * Polymarket, Robinhood's Stock Tokens. Made once and kept: what each keeps lives in it */
export function publicSources(deps: PublicDeps & { exchanges?: readonly string[] | undefined } = {}): PublicSource[] {
  return [...(deps.exchanges ?? PUBLIC_EXCHANGES).map((x) => exchangeTickers(x, deps)), kalshiPublic(deps), polymarketPublic(deps), stockTokensPublic(deps)];
}
