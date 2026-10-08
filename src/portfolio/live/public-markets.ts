/** MARKETS THE OWNER HAS NOT CONNECTED: what a venue's own public market data says, read without a key, so the Markets screen shows real
 * prices from venues that are not connected yet — each marked "Connect to trade" — beside the ones that are.
 *
 * Every source here only reads: no key, no sign-in, nothing signed, no order. What each one asks, and which of the venue's own fields it
 * keeps (docs.kraken.com, docs.cdp.coinbase.com, the exchange library's own parsers, docs.kalshi.com and docs.polymarket.com, read
 * 2026-10-05 and 2026-10-06, and their live public answers those days):
 *
 *   Kraken, Coinbase,   the unified exchange library's keyless client (prices.ts) and fetchTickers, for well-known coins priced in dollars
 *   OKX, Binance,       (USD, USDT, USDC) or the coins a query names. The 24-hour figures are read from each exchange's own answer (the
 *   Bybit               ticker's `info`), never from what the library works out from it:
 *                         Kraken    c (the last trade), and v and p for the last 24 hours: the volume times its average price is the
 *                                   dollars traded. Its o is TODAY's open ("Today's opening price"), not the price a day ago, so no 24-hour
 *                                   change is shown for Kraken
 *                         Coinbase  price, price_percentage_change_24h, and approximate_quote_24h_volume — Coinbase's own figure, its
 *                                   24-hour volume at the current price
 *                         OKX       last, bidPx, askPx, open24h (the price 24 hours ago: the change is last − open24h), volCcy24h (a spot
 *                                   pair's volume in its quote currency)
 *                         Binance   lastPrice, bidPrice, askPrice, priceChange, priceChangePercent, quoteVolume
 *                         Bybit     lastPrice, bid1Price, ask1Price, prevPrice24h (the change is last − prevPrice24h), turnover24h
 *                       All five are read wherever this machine is: none is left out for where the developer sits. One that does not
 *                       serve this location answers with its own rule, which is shown as that, in its own words, and holds the whole
 *                       source back (holdBackMs: ten minutes; every query, its 24 hours and its bars, not only the read that met it). From
 *                       the developer's machine on 2026-10-08: Binance's HTTP 451, "Service unavailable from a restricted location
 *                       according to 'b. Eligibility' in https://www.binance.com/en/terms…", and Bybit's 403 from its CloudFront edge,
 *                       "{ error:The Amazon CloudFront distribution is configured to block access from your country }" (96 bytes), which the
 *                       library labels RateLimitExceeded: the words decide, not the label (exchange.ts, and exchangeNo here, which reads
 *                       the whole message). Either answers in one round trip, well inside the Markets read's four seconds. Nothing here
 *                       looks for another way in.
 *   Kalshi              a few of its busiest SERIES, not its whole list (the owner asked for a few hot markets, not every bet): for each
 *                       series in KALSHI_SERIES (categories.ts) one GET /trade-api/v2/events?series_ticker=&status=open&
 *                       with_nested_markets=true&limit=6 — the series' nearest open events, each with its markets, 15 KB to 600 KB a
 *                       series (the bitcoin ladder is the big one) — and from each series the busiest market of the event with the most
 *                       24-hour contracts. GET /markets?status=open&limit=1000 lists the NEWEST thousand markets, which is why the Fed
 *                       decision (151,859 contracts a day on 2026-10-06) never appeared in it: it is not read any more. A market is listed
 *                       as its YES and its NO leg. volume_24h_fp counts CONTRACTS (each pays $1 at settlement), not dollars: it is carried
 *                       as `contracts24h` and never as dollars. The change is last_price_dollars − previous_price_dollars (the last trade a
 *                       day ago), in dollars per contract, the NO leg's the other way. A search reaches every market of every event read.
 *                       The two IPO series (Anthropic, OpenAI) are read the same way; their legs carry Kalshi's own series tags ("IPOs",
 *                       "Companies") beside the event's category, and read "IPOs" (categories.ts)
 *   Polymarket          GET gamma /events, its twenty busiest open events by volume24hr with Gamma asked to leave sports out
 *                       (exclude_tag_id=1, the Sports tag every sports and esports event carries), 2.9 MB; then every event filed under an
 *                       excluded word (categories.ts: weather, entertainment, celebrities, awards, "will X say or post" …) and every hourly
 *                       or shorter "Up or Down" market is left out, and the ten busiest that remain are shown, each as its busiest
 *                       market — outcomes and outcomePrices, bestBid and bestAsk and oneDayPriceChange (all three the first outcome's),
 *                       volume24hr (dollars), endDate — with the event's tags for its category, in the order of the EVENT's volume24hr
 *                       (how hot the question is, which is what Polymarket orders by; the Fed decision is one hot event spread over five
 *                       markets), carried as `eventVolumeUsd24h` only to order. A second GET of the same shape with tag_slug=ipo reads
 *                       its five busiest IPO questions (290 KB; "Anthropic IPO by __?" $40,704 a day on 2026-10-06), of which the three
 *                       busiest are shown beside the ten, each reading "IPO". A search reaches every market of every event read. What
 *                       closes within a day is read off the same list: no second request
 *   Polymarket US       Polymarket US's own exchange (QCX LLC, a CFTC-designated contract market), not polymarket.com's: its public gateway,
 *                       gateway.polymarket.us ("No API key needed"; polymarket-us.ts, its shapes checked live and keyless 2026-10-08). For
 *                       each of six of its categories — politics, finance, crypto, macro, geopolitics, technology (its sports and culture
 *                       are excluded words) — GET /v1/markets?active=true&closed=false&categories=<c>&orderBy=volume&orderDirection=desc&
 *                       limit=6, 13–32 KB each, the categories in turn, each market as its YES and NO leg (`<market slug>:YES`). Its lists
 *                       carry no volume figure at all (`orderBy=volume` orders by one it does not return; volume24hr and volumeNum order
 *                       nothing), so no volume and no 24-hour change are said. The prices are its bestBidQuote and bestAskQuote, the YES
 *                       contract's (NO's are 1 − them, the other way round); its outcomes and outcomePrices strings do not follow one
 *                       order (["No","Yes"] beside ["0.6030","0.398"]) and are not read. A search is its own GET /v1/search?query=, events
 *                       with their markets, which reaches every market it lists. Its rows trade through live:polymarket-us
 *   Pre-IPO perpetuals  contracts on a venue's estimate of a PRIVATE company's valuation (live/preipo.ts: what they are, the unit each
 *                       venue prices them in, the flag each venue's own record carries), at eight exchanges our exchange connector reaches,
 *                       one source each, and at Hyperliquid's HIP-3 deployers (below): the venue's instrument list, kept ten minutes
 *                       (LIST_MS, like the Stock Token list; a venue's list changes rarely), then one or two small price requests a
 *                       contract, kept KEEP_MS. The first six read 2026-10-06, keyless, from this machine (bodies, and on the wire — Node's
 *                       fetch asks for gzip and undoes it):
 *                         OKX             /api/v5/public/instruments?instType=SWAP (537 KB, 38 KB) → ruleType pre_market; a contract's
 *                                         /api/v5/market/ticker?instId= (last, bidPx, askPx, open24h; 332 B) and /api/v5/public/funding-rate
 *                                         ?instId= (fundingRate, fundingTime; 505 B). Its volCcy24h for a swap counts the base currency,
 *                                         not dollars, so no dollar volume is said
 *                         Gate            its full list is 1.3 MB and its server does not compress, so each company's contract is asked by
 *                                         name — /api/v4/futures/usdt/contracts/<NAME>_USDT (1.3 KB; is_pre_market AND contract_type
 *                                         "stocks", leverage_max, quanto_multiplier, funding_rate, funding_next_apply; a name it does not
 *                                         list answers HTTP 400 CONTRACT_NOT_FOUND) — and its /api/v4/futures/usdt/tickers?contract= (last,
 *                                         highest_bid, lowest_ask, change_percentage, volume_24h_quote; 472 B)
 *                         Kraken Futures  /derivatives/api/v3/instruments (848 KB, 21 KB) → category "Pre-IPO"; a contract's
 *                                         /derivatives/api/v3/tickers/<symbol> (last, markPrice, bid, ask, change24h in percent,
 *                                         volumeQuote in dollars, relativeFundingRate — the rate as Kraken gives it, no next time; 678 B)
 *                         Deribit         /api/v2/public/get_instruments?currency=any&kind=future (188 KB, 12 KB) → underlying_type
 *                                         preipo, perpetual, linear; /api/v2/public/ticker?instrument_name= (last_price, mark_price,
 *                                         best_bid_price, best_ask_price, stats.price_change in percent, stats.volume_usd, funding_8h —
 *                                         Deribit's funding accrues continuously, so no next time; 697 B). deribit.com redirects: www
 *                         KuCoin Futures  /api/v1/contracts/active (1.4 MB, 140 KB) → marketStage PRE_MARKET AND assetClass STOCK; a
 *                                         contract's /api/v1/contracts/<symbol> (lastTradePrice, markPrice, priceChgPct, turnoverOf24h in
 *                                         USDT, fundingFeeRate, nextFundingRateDateTime; 2.1 KB; no book, so no bid or ask)
 *                         MEXC            /api/v1/contract/detail (2.3 MB, 170 KB) → conceptPlate mc-trade-zone-preipo; a contract's
 *                                         /api/v1/contract/ticker?symbol= (lastPrice, bid1, ask1, riseFallRate, amount24 in USDT,
 *                                         fundingRate; 544 B)
 *                       and two this machine cannot read (Binance 451, Bybit 403), built from their own docs and the library's parsers,
 *                       read 2026-10-08; neither documents a pre-IPO flag, so a perpetual named for a company, matched whole, is one:
 *                         Binance         USDⓈ-M futures (developers.binance.com): fapi.binance.com/fapi/v1/exchangeInfo → a perpetual
 *                                         (contractType PERPETUAL or TRADIFI_PERPETUAL, or the 2100-12-25 delivery date Binance gives every
 *                                         perpetual) settled in its quote; a contract's /fapi/v1/ticker/24hr?symbol= (lastPrice, priceChange,
 *                                         priceChangePercent, quoteVolume in USDT; no book, so no bid or ask) and /fapi/v1/premiumIndex
 *                                         ?symbol= (markPrice, lastFundingRate, nextFundingTime)
 *                         Bybit           v5 (bybit-exchange.github.io/docs/v5): api.bybit.com/v5/market/instruments-info?category=linear
 *                                         &limit=1000, page by page while it gives a nextPageCursor (three at most) → contractType
 *                                         LinearPerpetual settled in its quote, leverageFilter.maxLeverage; a contract's /v5/market/tickers
 *                                         ?category=linear&symbol= (lastPrice, bid1Price, ask1Price, prevPrice24h, turnover24h in USDT,
 *                                         fundingRate, nextFundingTime). A retCode other than 0 is a no in its retMsg, even under HTTP 200
 *                       Each contract is a perpetual (`kind: "perp"`) under the category "Pre-IPO", with its company (`group`:
 *                       preipo:<slug>, the company's name — so one company is one row across venues), the valuation its price implies
 *                       (`implied`: price × the venue's unit, and that unit in words), and for Anthropic and OpenAI the issuer's own words
 *                       on transfers of its stock. Named as the unified library names it (ANTHROPIC/USDT:USDT, ANTH/USDC:USDC), so a key
 *                       connected at the venue trades the same row. A venue's refusal of this location is its own rule, shown as that.
 *                       No price history yet from these sources (a connected key's comes through the library)
 *   Hyperliquid         POST api.hyperliquid.xyz/info {"type":"metaAndAssetCtxs"} — through its own guard (hyperliquidInfo), like every POST
 *                       here: every perpetual of its first dex with its day (midPx or markPx, prevDayPx for the change, dayNtlVlm in
 *                       dollars, funding, maxLeverage), 72 KB, each as `<COIN>-PERP`. They are placed through Hyperliquid's connection to
 *                       trade, live:hyperliquid-trade (an API wallet that places orders and cannot withdraw), so the Perps tab is real
 *                       prices marked "Connect to trade"
 *   Hyperliquid HIP-3   the pre-IPO perpetuals its deployers list (hyperliquidPreIpoPublic; hyperliquid.gitbook.io …/info-endpoint/perpetuals,
 *                       read 2026-10-08): POST {"type":"perpDexs"} (21.5 KB; ten dexes that day) and {"type":"perpCategories"} (5 KB:
 *                       Hyperliquid's category for each market, "preipo" among them), then {"type":"metaAndAssetCtxs","dex":<name>} for
 *                       every dex (5 to 59 KB each, 131 KB in all: Hyperliquid does not compress), all kept ten minutes; between those,
 *                       every ninety seconds, only the dexes that hold one (io and xyz, 64 KB). A market is listed when its name is a
 *                       company's (live/preipo.ts) and Hyperliquid files it under no other category, it is not delisted, and someone holds
 *                       or trades it (openInterest or dayNtlVlm above 0): anyone may deploy one. Each is `<dex>:<COIN>-PERP` (io:ANTH-PERP),
 *                       its line named for Hyperliquid and the deployer's dex ("Hyperliquid · io", `venueName`), with the deployer's mid
 *                       (its mark when there is none), the change from prevDayPx, dayNtlVlm in the dex's collateral (USDC for io and xyz),
 *                       the hourly funding and maxLeverage; traded through the same connection. Live that day: io:ANTH ($11.8M a day),
 *                       io:OAI ($5.9M), xyz:OURA ($17.7K); vntl:ANTHROPIC, vntl:OPENAI, para:ANTH and xyz:YMTC delisted
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
 *   Polymarket US       GET gateway.polymarket.us/v1/price-history?symbol=<market slug>&fixedInterval=&fidelity= (its fixed profiles: five-
 *                       minute points for a day, three-hour points for a week or a month): its "book-derived Yes and No display prices",
 *                       longPrice from the best ask and shortPrice from one minus the best bid — not trades — folded into bars, no volume
 *   Hyperliquid         POST /info {"type":"candleSnapshot","req":{coin,interval,startTime,endTime}}: its bars of 5m, 1h or 1d, at most 300;
 *                       a HIP-3 market by its dex-prefixed coin ("io:ANTH" answers its bars; the bare "ANTH" HTTP 500, live 2026-10-08)
 *   Stock Tokens        none: Robinhood publishes no history for them
 *
 * A request goes only to those fixed hosts, as a GET over https (Hyperliquid's info endpoint: a POST of one of five bodies, each built
 * here from its fields, through its own guard), with a time limit (the exchange library's clients go only to their own exchange's hosts).
 * An answer is kept ninety seconds (the Stock Token list ten minutes, a token's price one), so a page that asks every few
 * seconds does not ask the venue every time, and the price of a public market is as old as that. A refusal is kept only when it says the
 * venue cannot be asked just now — ten minutes when the venue does not serve this location, twenty seconds when it is rate-limiting or not
 * answering (`holdBackMs`, the one rule for this file and the service's own cache) — so a venue that has said no is not asked again on every
 * poll. A public listing's markets carry no order types: nothing is ordered through one. Each source says in a sentence or two what its
 * list is made of (`notes`), shown under the list. Keep one set of sources for the life of the service, so what they keep is kept.
 */
import { isRefusal, type Refusal } from "../../core/errors.ts";
import { no } from "../refuse.ts";
import { categoryOf, isExcludedCategory, isIpoCategory, KALSHI_SERIES, normalWords } from "./categories.ts";
import { exchangeSaidNo, openExchange, type ExchangeClient, type OpenExchange } from "./exchange.ts";
import { PMUS_CATEGORIES, PMUS_GATEWAY, PMUS_PER_CATEGORY, pmusBusiest, pmusCandles, pmusLegs, pmusSearch, type PmusGet } from "./polymarket-us.ts";
import { impliedUsd, PRE_IPO_NAMES, preIpoOf, type PreIpoMark } from "./preipo.ts";
import { keylessExchange, PUBLIC_EXCHANGES } from "./prices.ts";
import { STOCK_TOKEN_ISSUER, STOCK_TOKEN_TERMS, stockTokens } from "./robinhood.ts";
import { CANDLE_INTERVALS, inDollars, type Candle, type CandleInterval, type Market, type MarketStats } from "./trade.ts";
import { isStable, realHttp, REGION, unreachable, type Http, type HttpReply } from "./types.ts";

/** a market as a public source lists it: the shared shape, and what only a listing carries */
export type Listing = Market & {
  /** the venue's event the market belongs to, where an event holds several (Polymarket's "Brazil Presidential Election") */
  event?: { id: string; title: string } | undefined;
  /** the whole event's dollars traded in 24 hours, all its markets together, where the venue reports it (Gamma's volume24hr on the event):
   * how hot the question is, which is what Polymarket itself orders by. Only to ORDER; `volumeUsd24h` stays the market's own */
  eventVolumeUsd24h?: number | undefined;
  /** every category word and tag the venue gives it, for the category shown and the words that leave an event out (categories.ts) */
  tags?: string[] | undefined;
  /** the name of the place it trades, where one source speaks for several (Hyperliquid's HIP-3 deployers: "Hyperliquid · io"): explore.ts
   * names the market's venue line with it; absent, the line is the source's name */
  venueName?: string | undefined;
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
  /** what the owner should know about the listing asked with `q`, each a plain sentence under 160 characters, read after `listings` has
   * answered: what the list is made of, how much of the venue it shows when nothing is searched for ("40 of 194 shown · search for the
   * rest"). The service may answer a listing from what it kept without asking the source again, so the sentences never depend on which
   * call came last */
  notes?(o: { q?: string | undefined }): string[];
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

/** the only hosts a public source's own GETs go to (Hyperliquid's info endpoint, a POST, has its own guard: hyperliquidInfo); the last eight
 * are the pre-IPO perpetuals' venues (Binance's USDⓈ-M futures host and Bybit's v5 host the last two). Polymarket US's public gateway is
 * its keyless market data only: its signed API (api.polymarket.us) is never asked from here */
export const PUBLIC_HOSTS: readonly string[] = ["external-api.kalshi.com", "gamma-api.polymarket.com", "clob.polymarket.com", "gateway.polymarket.us", "api.robinhood.com", "www.okx.com", "api.gateio.ws", "futures.kraken.com", "www.deribit.com", "api-futures.kucoin.com", "contract.mexc.com", "fapi.binance.com", "api.bybit.com"];
const KALSHI = "https://external-api.kalshi.com/trade-api/v2";
const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";
/** how long a list is kept: a public market's price is as old as this */
export const KEEP_MS = 90_000;
const PRICE_MS = 60_000;
/** a venue's list of what it trades changes rarely: a pre-IPO venue's instrument list is kept ten minutes, like the Stock Token list */
export const LIST_MS = 600_000;
/** price history is kept a minute */
const HISTORY_MS = 60_000;
/** the most bars one history reads */
const BARS = 300;
const BAR_MS: Record<CandleInterval, number> = { "5m": 300_000, "1h": 3_600_000, "1d": 86_400_000 };
const TIMEOUT_MS = 8_000;
/** the longest a sentence under the list may be */
export const NOTE_MAX = 160;

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
/** a time the venue wrote, in milliseconds; a time it did not write sorts last */
const whenMs = (v: unknown): number => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
};
/** a moment the venue wrote in milliseconds since the epoch (or seconds, `inSeconds`), as ISO 8601; nothing when it wrote none */
const isoAt = (v: unknown, inSeconds = false): string | undefined => {
  const n = pos(v);
  return n === undefined ? undefined : new Date(inSeconds ? n * 1000 : n).toISOString();
};
/** a fraction the venue wrote (0.015) as a percent (1.5) */
const pct = (v: unknown): number | undefined => {
  const n = fin(v);
  return n === undefined ? undefined : round(n * 100, 4);
};

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

/** what a venue answered, on one line and cut at 220 characters — never inside the sentence it gave in its JSON, which runs to its end (up
 * to 600): Binance's 451 sentence ends past 220, "…if you believe you received this message in error.", and stays whole */
function saidOf(text: string): string {
  const folded = text.replace(/\s+/g, " ").trim();
  const sentence = /"(?:msg|message|retMsg|error_description)"\s*:\s*"(?:[^"\\]|\\.)*"/.exec(folded);
  return folded.slice(0, Math.min(600, Math.max(220, sentence ? sentence.index + sentence[0].length : 0)));
}

/** a public answer that is not a yes, as a refusal with the venue's own words; there is no key, so a 403 is not "the key may not" */
function publicNo(venue: string, name: string, r: HttpReply): Refusal {
  const native = { status: r.status, said: saidOf(r.text) };
  if (r.status === 451 || (r.status !== 200 && REGION.test(r.text))) return no("E_VENUE_GEOBLOCKED", { venue, message: `${name} does not serve this location: that is its own rule, and the account does not look for a way around it`, native });
  if (r.status === 429) return no("E_VENUE_UNREACHABLE", { venue, message: `${name} is rate-limiting this machine: try again in a minute`, native });
  if (r.status >= 500 || r.status === 0) return no("E_VENUE_UNREACHABLE", { venue, message: `${name} did not answer`, native });
  if (r.status === 200) return no("E_VENUE_REJECTED", { venue, message: `${name} answered in a way this could not read`, native: { status: 200 } });
  return no("E_VENUE_REJECTED", { venue, message: `${name} refused the request (HTTP ${r.status})`, native });
}

/** How long a refusal is kept before the venue is asked again, when it says the venue cannot be asked just now: ten minutes for a venue
 * that does not serve this location (its rule will not change within the hour), twenty seconds for one that is rate-limiting (HTTP 429) or
 * not answering, so a page polling every few seconds does not hammer it. Zero for every other refusal: the next ask asks the venue again.
 * The one rule, for this file's keeper and for the service's read cache */
export function holdBackMs(r: Refusal): number {
  if (r.code === "E_VENUE_GEOBLOCKED") return 600_000;
  if (r.code === "E_VENUE_UNREACHABLE" || (r.native as { status?: unknown } | undefined)?.status === 429) return 20_000;
  return 0;
}

/** an answer kept for `ms` from when it was asked (or for what `ms` says of the answer: until it has come, it is waited for up to KEEP_MS),
 * and one asked only once while it is on its way; a refusal is kept for holdBackMs (which is nothing for most), a throw is not kept */
function keeper<T>(clock: () => number, ms: number | ((answer: T) => number)): (key: string, run: () => Promise<T | Refusal>) => Promise<T | Refusal> {
  const kept = new Map<string, { until: number; p: Promise<T | Refusal> }>();
  return (key, run) => {
    const now = clock();
    const hit = kept.get(key);
    if (hit && now < hit.until) return hit.p;
    const entry = { until: now + (typeof ms === "number" ? ms : KEEP_MS), p: Promise.resolve() as unknown as Promise<T | Refusal> };
    entry.p = run().then(
      (r) => {
        if (kept.get(key) !== entry) return r;
        if (isRefusal(r)) {
          const hold = holdBackMs(r);
          if (hold > 0) entry.until = clock() + hold;
          else kept.delete(key);
        } else if (typeof ms !== "number") entry.until = now + ms(r);
        return r;
      },
      (err: unknown) => {
        if (kept.get(key) === entry) kept.delete(key);
        throw err;
      },
    );
    kept.set(key, entry);
    if (kept.size > 200) kept.delete(kept.keys().next().value!);
    return entry.p;
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

/** the pairs to ask for: the well-known coins in dollars, or the coins in dollars whose name starts with the query — the query's part before
 * any slash ("BTC/USD" asks for the BTC pairs), a pair written whole first of all, then the coin named exactly, then the shortest names */
function pairsFor(markets: Record<string, unknown> | undefined, q: string | undefined): string[] {
  const all = markets ?? {};
  const live = (s: string): CcxtMarket | undefined => {
    const m = all[s] as CcxtMarket | undefined;
    return m && m.spot !== false && m.active !== false ? m : undefined;
  };
  const Q = (q ?? "").trim().toUpperCase();
  if (!Q) return COINS.flatMap((c) => DOLLARS.map((d) => `${c}/${d}`)).filter((s) => live(s) !== undefined);
  const base = Q.split("/")[0]!.trim();
  if (!base) return [];
  return Object.keys(all)
    .map((s) => ({ s, m: live(s) }))
    .filter((x): x is { s: string; m: CcxtMarket } => x.m !== undefined && typeof x.m.base === "string" && typeof x.m.quote === "string" && inDollars(x.m.quote) && !isStable(x.m.base) && x.m.base.toUpperCase().startsWith(base) && !x.s.includes(":"))
    .sort((a, b) => Number(b.s.toUpperCase() === Q) - Number(a.s.toUpperCase() === Q) || Number(b.m.base!.toUpperCase() === base) - Number(a.m.base!.toUpperCase() === base) || a.m.base!.length - b.m.base!.length || a.s.localeCompare(b.s))
    .slice(0, 45)
    .map((x) => x.s);
}

/** the library's own line before what an exchange answered ("bybit GET https://api.bybit.com/… 403 Forbidden "): the request it made, not
 * the exchange's words */
const LIBRARY_LINE = /^\S+ (?:GET|POST|PUT|DELETE) https?:\/\/\S+ \d{3}\b[^{[<]*(?=[{[<])/;

/** What the exchange library threw, as the exchange's refusal (exchange.ts exchangeSaidNo), carrying the exchange's words without the
 * library's request line. The words decide, read whole: a refusal of this location further in than exchangeSaidNo's first 240 characters
 * (an edge's HTML page, say) is still that, whatever class the library gave it — Bybit's 403 arrives labelled RateLimitExceeded */
export function exchangeNo(id: string, name: string, err: unknown): Refusal {
  const r = exchangeSaidNo(id, name, err, {});
  const n = (r.native ?? {}) as { error?: unknown; said?: unknown };
  const whole = String((err as { message?: unknown } | undefined)?.message ?? err ?? "").replace(/\s+/g, " ").trim();
  if (r.code !== "E_VENUE_GEOBLOCKED" && REGION.test(whole)) {
    const plain = whole.replace(LIBRARY_LINE, "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    const at = Math.max(0, plain.search(REGION));
    return no("E_VENUE_GEOBLOCKED", { venue: id, message: `${name} does not serve this location: that is its own rule, and the account does not look for a way around it`, native: { error: n.error, said: plain.slice(Math.max(0, at - 120), at + 120).trim() } });
  }
  const own = typeof n.said === "string" ? n.said.replace(LIBRARY_LINE, "").trim() : "";
  return own && own !== n.said ? { ...r, native: { ...n, said: own } } : r;
}

/** One exchange's public tickers, keyless, through the unified library. An exchange that does not serve this location answers with its own
 * refusal, which is passed on as it is, in its own words (exchangeNo), and holds back every read of the exchange for as long as holdBackMs
 * says — ten minutes for that refusal — not only the read that met it: another search, the 24 hours, the bars */
export function exchangeTickers(id: string, deps: PublicDeps = {}): PublicSource {
  const reader = EXCHANGES[id];
  const name = reader?.name ?? id;
  const open = deps.open ?? openExchange;
  const clock = deps.clock ?? Date.now;
  const keep = keeper<Listing[]>(clock, KEEP_MS);
  const history = keeper<Candle[]>(clock, HISTORY_MS);
  // the library keeps a failed load of the markets and answers it again: after a failure they are loaded afresh
  let reload = false;
  // the refusal that holds the exchange back, and until when (the service's read cache does the same by venue)
  let held: { until: number; r: Refusal } | undefined;
  const heldBack = (): Refusal | undefined => (held && clock() < held.until ? held.r : undefined);
  const hold = <T>(got: T | Refusal): T | Refusal => {
    if (isRefusal(got) && holdBackMs(got) > 0) held = { until: clock() + holdBackMs(got), r: got };
    return got;
  };
  /** the tickers asked for (or the query's), from the exchange itself */
  const fresh = async (symbols: string[] | undefined, q: string | undefined): Promise<Listing[] | Refusal> => {
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
      return exchangeNo(id, name, err);
    }
  };
  /** the same, kept KEEP_MS by what was asked, and not asked at all while a refusal holds the exchange back */
  const read = (symbols: string[] | undefined, q: string | undefined): Promise<Listing[] | Refusal> => {
    const back = heldBack();
    return back ? Promise.resolve(back) : keep(`${symbols ? symbols.join(",") : ""}|${q ?? ""}`, async () => hold(await fresh(symbols, q)));
  };
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
    candles: (symbol, interval, sinceMs) => {
      const back = heldBack();
      return back ? Promise.resolve(back) : history(`${symbol}|${interval}|${Math.floor(sinceMs / 60_000)}`, async () => {
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
          return hold(exchangeNo(id, name, err));
        }
      });
    },
  };
}

// ---- Kalshi ---------------------------------------------------------------------------------------------------

/** a market Kalshi trades now: active, priced in dollars, not a combo (multivariate event) */
const kalshiLive = (m: Rec): boolean => m.status === "active" && typeof m.ticker === "string" && !m.ticker.startsWith("KXMVE") && ["yes_bid_dollars", "yes_ask_dollars", "last_price_dollars"].some((k) => typeof m[k] === "string");
/** the busier market first: by its 24-hour contracts, then all its contracts, then the nearer close */
const kalshiBusier = (a: Rec, b: Rec): number => (nonNeg(b.volume_24h_fp) ?? 0) - (nonNeg(a.volume_24h_fp) ?? 0) || (nonNeg(b.volume_fp) ?? 0) - (nonNeg(a.volume_fp) ?? 0) || whenMs(a.close_time) - whenMs(b.close_time);
/** Kalshi writes emphasis into some titles ("Will **real GDP** increase by more than 3.5%…"): the stars are markdown, not words */
const unstarred = (s: string | undefined): string | undefined => s?.replace(/\*\*/g, "");
/** how many of a series' open events are read: the nearest few (Kalshi lists them soonest first; the Fed has eleven meetings open, the
 * bitcoin ladder three) */
const SERIES_EVENTS = 6;

/** one of a series' open events, with its markets, as GET /events?with_nested_markets=true answers it */
interface KalshiOpenEvent {
  series: string;
  /** how Kalshi files the series itself, where KALSHI_SERIES carries it (the IPO series: "IPOs", "Companies") */
  tags?: readonly string[] | undefined;
  ticker: string;
  title?: string | undefined;
  category?: string | undefined;
  markets: Rec[];
  /** its markets' 24-hour contracts, summed */
  contracts: number;
  /** when its first market closes */
  closeMs: number;
}

/** one Kalshi market as its two legs, in the names the account's Kalshi trader gives them (`<ticker>:YES`, `<ticker>:NO`). The legs carry
 * the event's category and, where KALSHI_SERIES carries them, Kalshi's own tags for the series, and read the word the table prefers among
 * those (the IPO series: "IPOs" before Companies); a series without tags reads the event's category as it is */
function kalshiLegs(m: Rec, ev: Pick<KalshiOpenEvent, "ticker" | "title" | "category" | "tags">): Listing[] {
  const ticker = String(m.ticker).toUpperCase();
  const title = unstarred(str(m.title)) ?? "";
  const sub = unstarred(str(m.yes_sub_title)) ?? "";
  const words = title ? (sub && !title.includes(sub) ? `${title} (${sub})` : title) : sub || ticker;
  const lastYes = px(m.last_price_dollars);
  const before = px(m.previous_price_dollars);
  const moved = lastYes !== undefined && before !== undefined ? round(lastYes - before, 4) : undefined;
  const tags = [...new Set([...(ev.category ? [ev.category] : []), ...(ev.tags ?? [])])];
  const category = ev.tags?.length ? (categoryOf(tags) ?? ev.category) : ev.category;
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
      ...(category ? { category } : {}),
      ...(tags.length ? { tags } : {}),
      ...(moved !== undefined ? { change24h: yes ? moved : -moved } : {}),
      ...(nonNeg(m.volume_24h_fp) !== undefined ? { contracts24h: nonNeg(m.volume_24h_fp) } : {}),
      ...(ev.title ? { event: { id: ev.ticker, title: ev.title } } : {}),
    };
  });
}

/** Kalshi's busiest markets, keyless, one for each series in KALSHI_SERIES (see the top of this file): the busiest market of the series'
 * busiest open event, with the event's title and category. A search reaches every market of every event read */
export function kalshiPublic(deps: PublicDeps = {}): PublicSource {
  const id = "kalshi";
  const name = "Kalshi";
  const clock = deps.clock ?? Date.now;
  const get = getter(fixedHosts(deps.http ?? realHttp, PUBLIC_HOSTS, deps.timeoutMs ?? TIMEOUT_MS), id, name, clock);
  /** every series' open events with their markets, from the kept bodies: one small request a series, kept KEEP_MS. A series that refuses
   * is left out while the others answer; only when every one refuses is the refusal the answer */
  const load = async (): Promise<{ events: KalshiOpenEvent[]; refused?: Refusal | undefined }> => {
    const bodies = await Promise.all(KALSHI_SERIES.map((s) => get(`${KALSHI}/events?series_ticker=${encodeURIComponent(s.ticker)}&status=open&with_nested_markets=true&limit=${SERIES_EVENTS}`)));
    const events: KalshiOpenEvent[] = [];
    let refused: Refusal | undefined;
    bodies.forEach((body, i) => {
      if (isRefusal(body)) {
        refused ??= body;
        return;
      }
      for (const e of list(rec(body).events).filter(isRec)) {
        const ticker = str(e.event_ticker);
        const markets = list(e.markets).filter(isRec).filter(kalshiLive);
        if (!ticker || !markets.length) continue;
        events.push({ series: KALSHI_SERIES[i]!.ticker, tags: KALSHI_SERIES[i]!.tags, ticker: ticker.toUpperCase(), title: unstarred(str(e.title)), category: str(e.category), markets, contracts: markets.reduce((s, m) => s + (nonNeg(m.volume_24h_fp) ?? 0), 0), closeMs: Math.min(...markets.map((m) => whenMs(m.close_time))) });
      }
    });
    return { events, refused };
  };
  /** the one market shown for a series: the busiest market of its busiest event — the event whose markets traded the most contracts in 24
   * hours, the nearest to close among events that did not trade (Kalshi lists a series' far meetings too, with nothing traded in them) */
  const picks = (events: KalshiOpenEvent[]): Array<{ m: Rec; ev: KalshiOpenEvent }> =>
    KALSHI_SERIES.flatMap((s) => {
      const ev = events.filter((e) => e.series === s.ticker).sort((a, b) => b.contracts - a.contracts || a.closeMs - b.closeMs)[0];
      return ev ? [{ m: [...ev.markets].sort(kalshiBusier)[0]!, ev }] : [];
    });
  const read = async (o: { q?: string | undefined; category?: string | undefined; closingWithinMs?: number | undefined; limit: number }): Promise<Listing[] | Refusal> => {
    const { events, refused } = await load();
    if (!events.length && refused) return refused;
    const Q = (o.q ?? "").trim().toUpperCase();
    const want = o.category?.trim().toLowerCase();
    const window = pos(o.closingWithinMs);
    const now = clock();
    const pool = Q ? events.flatMap((ev) => ev.markets.filter((m) => has(Q, m.ticker, unstarred(str(m.title)), unstarred(str(m.yes_sub_title)), ev.ticker, ev.title)).map((m) => ({ m, ev }))) : picks(events);
    return pool
      .filter(({ ev }) => !want || ev.category?.toLowerCase() === want)
      .filter(({ m }) => !window || (whenMs(m.close_time) > now && whenMs(m.close_time) <= now + window))
      .sort((a, b) => kalshiBusier(a.m, b.m))
      .slice(0, Math.max(1, o.limit))
      .flatMap(({ m, ev }) => kalshiLegs(m, ev));
  };
  return {
    id,
    name,
    kind: "events",
    connectTo: "kalshi",
    connector: "live:kalshi",
    listings: (o) => read(o),
    events: (o) => read(o),
    // the finance series in one sentence (as before), the series Kalshi files under its own tags — the IPO ones — in a second, each under 160
    notes: () => {
      const plain = KALSHI_SERIES.filter((s) => !s.tags?.length);
      const tagged = KALSHI_SERIES.filter((s) => s.tags?.length);
      return [`Kalshi: the busiest market in each of ${plain.length} series — ${plain.map((s) => s.word).join(", ")}.`, ...(tagged.length ? [`Kalshi: and ${tagged.map((s) => s.word).join(", ")} — the busiest market of each.`] : [])];
    },
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

/** Gamma's tag id for Sports, read 2026-10-06 from the tags its events carry (every sports and esports event carries it): Gamma is asked
 * to leave those events out of its answer, so that the twenty events read are twenty that may be shown. The table in categories.ts is
 * still what decides what is left out */
const GAMMA_SPORTS_TAG = 1;
/** how many of Gamma's busiest events are read, and how many of them are shown */
const GAMMA_EVENTS = 20;
const POLYMARKET_SHOWN = 10;
/** Gamma's tag slug for its IPO questions ("Anthropic IPO by __?", "Anthropic IPO Closing Market Cap", "What will OpenAI's IPO valuation
 * be?" on 2026-10-06, $40,704, $20,837 and $4,249 a day — too quiet for the twenty busiest, so they are asked for by tag): how many are read,
 * and how many shown beside the ten */
const GAMMA_IPO_TAG = "ipo";
const GAMMA_IPO_EVENTS = 5;
const POLYMARKET_IPO_SHOWN = 3;
/** an hourly or shorter "Up or Down" market — "Bitcoin Up or Down - October 6, 1PM ET", tagged 1H, 4H or 15M (2026-10-06) — is noise beside
 * the day's ("Bitcoin Up or Down on October 5?"), which stays */
const hourlyUpDown = (title: string, tags: readonly string[]): boolean => /up or down/i.test(title) && (/\b\d{1,2}(:\d{2})?\s*(am|pm)\b/i.test(title) || tags.some((t) => /^\d+ ?[mh]$/.test(normalWords(t))));
const polymarketBusier = (a: Rec, b: Rec): number => (nonNeg(b.volume24hr) ?? 0) - (nonNeg(a.volume24hr) ?? 0);

/** one of Gamma's events that may be shown, with its open markets and its own 24-hour dollars (what Gamma orders events by) */
interface GammaEvent {
  e: Rec;
  tags: string[];
  markets: Rec[];
  volume: number;
  /** an IPO question, by its tags (whichever read listed it): shown among the few IPO rows, not the ten busiest */
  ipo: boolean;
}
/** the hotter question first: the event's dollars, then the market's */
const hotterFirst = (a: { m: Rec; ev: GammaEvent }, b: { m: Rec; ev: GammaEvent }): number => b.ev.volume - a.ev.volume || polymarketBusier(a.m, b.m);

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
  const eventVolume = nonNeg(e.volume24hr);
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
      ...(eventVolume !== undefined ? { eventVolumeUsd24h: eventVolume } : {}),
      ...(eventId && str(e.title) ? { event: { id: eventId, title: str(e.title)! } } : {}),
    };
  });
}

/** Polymarket's busiest events, keyless, through Gamma (see the top of this file): the ten busiest by 24-hour volume that are not sports,
 * weather, entertainment or the like, each as its busiest market. A search reaches every market of every event read */
export function polymarketPublic(deps: PublicDeps = {}): PublicSource {
  const id = "polymarket";
  const name = "Polymarket";
  const clock = deps.clock ?? Date.now;
  const get = getter(fixedHosts(deps.http ?? realHttp, PUBLIC_HOSTS, deps.timeoutMs ?? TIMEOUT_MS), id, name, clock);
  const clob = getter(fixedHosts(deps.http ?? realHttp, PUBLIC_HOSTS, deps.timeoutMs ?? TIMEOUT_MS), id, name, clock, HISTORY_MS);
  /** the events of one Gamma answer that may be shown: not filed under an excluded word, not an hourly up-or-down, with an open market */
  const parse = (body: unknown): GammaEvent[] | Refusal => {
    if (isRefusal(body)) return body;
    if (!Array.isArray(body)) return no("E_VENUE_REJECTED", { venue: id, message: `${name} answered without its events` });
    const out: GammaEvent[] = [];
    for (const e of body.filter(isRec)) {
      const tagList = list(e.tags).filter(isRec);
      const tags = [...new Set([...tagList.map((t) => str(t.label)), ...tagList.map((t) => str(t.slug))].filter((t): t is string => t !== undefined))];
      if (isExcludedCategory([str(e.category), ...tags]) || hourlyUpDown(str(e.title) ?? "", tags)) continue;
      const markets = list(e.markets).filter(isRec).filter((m) => m.closed !== true && m.active === true);
      if (!markets.length) continue;
      out.push({ e, tags, markets, volume: nonNeg(e.volume24hr) ?? 0, ipo: isIpoCategory([str(e.category), ...tags]) });
    }
    return out;
  };
  /** the busiest events and the IPO questions, from the two kept bodies, an event once (by Gamma's id). One read refusing while the other
   * answers leaves the other's events standing; both refusing is the refusal */
  const load = async (): Promise<GammaEvent[] | Refusal> => {
    const [busiest, ipo] = await Promise.all([
      get(`${GAMMA}/events?active=true&closed=false&archived=false&order=volume24hr&ascending=false&limit=${GAMMA_EVENTS}&exclude_tag_id=${GAMMA_SPORTS_TAG}`).then(parse),
      get(`${GAMMA}/events?active=true&closed=false&archived=false&order=volume24hr&ascending=false&limit=${GAMMA_IPO_EVENTS}&tag_slug=${GAMMA_IPO_TAG}`).then(parse),
    ]);
    if (isRefusal(busiest) && isRefusal(ipo)) return busiest;
    const seen = new Set<string>();
    return [...(isRefusal(busiest) ? [] : busiest), ...(isRefusal(ipo) ? [] : ipo)].filter((ev) => {
      const key = str(ev.e.id) ?? (typeof ev.e.id === "number" ? String(ev.e.id) : str(ev.e.slug) ?? "");
      return !seen.has(key) && seen.add(key) !== undefined;
    });
  };
  const read = async (o: { q?: string | undefined; category?: string | undefined; closingWithinMs?: number | undefined; limit: number }): Promise<Listing[] | Refusal> => {
    const events = await load();
    if (isRefusal(events)) return events;
    const Q = (o.q ?? "").trim().toUpperCase();
    const want = o.category?.trim().toLowerCase();
    const window = pos(o.closingWithinMs);
    const now = clock();
    const busiest = (evs: GammaEvent[], n: number) => [...evs].sort((a, b) => b.volume - a.volume).slice(0, n);
    const pool: Array<{ m: Rec; ev: GammaEvent }> = Q
      ? events.flatMap((ev) => ev.markets.filter((m) => has(Q, m.question, m.slug, ev.e.title, ev.e.slug)).map((m) => ({ m, ev })))
      : [...busiest(events.filter((ev) => !ev.ipo), POLYMARKET_SHOWN), ...busiest(events.filter((ev) => ev.ipo), POLYMARKET_IPO_SHOWN)].map((ev) => ({ m: [...ev.markets].sort(polymarketBusier)[0]!, ev }));
    return pool
      .filter(({ ev }) => !want || ev.tags.some((t) => t.toLowerCase() === want) || str(ev.e.category)?.toLowerCase() === want)
      .filter(({ m, ev }) => {
        if (!window) return true;
        const end = whenMs(m.endDate ?? ev.e.endDate);
        return end > now && end <= now + window;
      })
      .sort(hotterFirst)
      .slice(0, Math.max(1, o.limit))
      .flatMap(({ m, ev }) => polymarketLegs(m, ev.e, ev.tags));
  };
  return {
    id,
    name,
    kind: "events",
    connectTo: "polymarket",
    connector: "live:polymarket-trade",
    listings: (o) => read(o),
    events: (o) => read(o),
    notes: () => [`Polymarket: its ${POLYMARKET_SHOWN} busiest events by 24-hour volume, without sports, esports, weather, entertainment, awards and mentions.`, `Polymarket: and its ${POLYMARKET_IPO_SHOWN} busiest IPO questions (its tag IPO).`],
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

// ---- Polymarket US --------------------------------------------------------------------------------------------

/** Polymarket US's most traded open markets, keyless (see the top of this file): for each of its categories the account shows
 * (PMUS_CATEGORIES), its own most traded, the categories in turn — so one busy category does not fill the list — each market as its YES and
 * its NO leg, named as the account's Polymarket US trader names them (`<market slug>:YES`). Its lists publish no volume, so none is said, and
 * their order is the one Polymarket US gives. A search is its own GET /v1/search, which reaches every market it lists. What closes within a
 * window is read off the same list: no second request */
export function polymarketUsPublic(deps: PublicDeps = {}): PublicSource {
  const id = "polymarket-us";
  const name = "Polymarket US";
  const clock = deps.clock ?? Date.now;
  const get = getter(fixedHosts(deps.http ?? realHttp, PUBLIC_HOSTS, deps.timeoutMs ?? TIMEOUT_MS), id, name, clock);
  const history = getter(fixedHosts(deps.http ?? realHttp, PUBLIC_HOSTS, deps.timeoutMs ?? TIMEOUT_MS), id, name, clock, HISTORY_MS);
  const gw: PmusGet = (path) => get(`${PMUS_GATEWAY}${path}`);
  /** a market's two legs as a listing: the shared shape with no order types (nothing is ordered through a listing), its category word kept */
  const legs = (m: Rec): Listing[] => {
    const word = str(m.category);
    return pmusLegs(m).map((l) => ({ symbol: l.symbol, name: l.name, kind: l.kind, base: l.base, quote: l.quote, price: l.price, bid: l.bid, ask: l.ask, open: l.open, types: [], ...(l.group ? { group: l.group } : {}), ...(l.outcome ? { outcome: l.outcome } : {}), ...(l.closeTime ? { closeTime: l.closeTime } : {}), ...(l.category ? { category: l.category } : {}), ...(word ? { tags: [word] } : {}) }));
  };
  const read = async (o: { q?: string | undefined; category?: string | undefined; closingWithinMs?: number | undefined; limit: number }): Promise<Listing[] | Refusal> => {
    const q = (o.q ?? "").trim();
    const found = q ? await pmusSearch(gw, q) : await pmusBusiest(gw, { perCategory: PMUS_PER_CATEGORY });
    if (isRefusal(found)) return found;
    const want = o.category?.trim().toLowerCase();
    const window = pos(o.closingWithinMs);
    const now = clock();
    return found
      .filter((m) => !want || str(m.category)?.toLowerCase() === want)
      .filter((m) => {
        if (!window) return true;
        const end = whenMs(m.endDate);
        return end > now && end <= now + window;
      })
      .slice(0, Math.max(1, o.limit))
      .flatMap(legs);
  };
  return {
    id,
    name,
    kind: "events",
    connectTo: "polymarket-us",
    connector: "live:polymarket-us",
    listings: (o) => read(o),
    events: (o) => read(o),
    notes: (o) => [o.q?.trim() ? "Polymarket US: its own search, which reaches every market it lists." : `Polymarket US: the most traded open markets of ${PMUS_CATEGORIES.slice(0, -1).join(", ")} and ${PMUS_CATEGORIES.at(-1)}, in turn (its lists give no volume figure).`],
    /** a market's price history, keyless (see the top of this file): `<market slug>:YES` or `<market slug>:NO`, as the listing names it */
    candles: (symbol, interval, sinceMs) => pmusCandles((path) => history(`${PMUS_GATEWAY}${path}`), id, symbol, interval, sinceMs, clock()),
  };
}

// ---- Hyperliquid perpetuals -----------------------------------------------------------------------------------

/** Hyperliquid's info endpoint takes a POST with a JSON `type` (hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint,
 * "No API key or authentication is required", read 2026-10-06; its perpetuals page read 2026-10-08; the account's own Hyperliquid connector
 * reads the same host). Five questions are asked here and nothing else: `metaAndAssetCtxs`, every perpetual of a dex with its day — of the
 * first dex when no `dex` is named, live 2026-10-06 234 of them in 72 KB, 400 ms: [{universe: [{name, szDecimals, maxLeverage,
 * isDelisted?}], collateralToken?}, [{markPx, midPx, prevDayPx, dayNtlVlm, funding, openInterest, impactPxs}]], the two lists in step;
 * `perpDexs`, the HIP-3 dexes ([null, {name, fullName, deployer, …}, …], the first dex as null); `perpCategories`, Hyperliquid's category
 * for each market ([["io:ANTH","preipo"], ["xyz:TSLA","stocks"], …]); and `candleSnapshot` for one coin, [{t, T, s, i, o, c, h, l, v, n}]
 * with the prices as strings */
const HL_INFO = "https://api.hyperliquid.xyz/info";
type HyperliquidAsk =
  | { type: "metaAndAssetCtxs"; dex?: string | undefined }
  | { type: "perpDexs" }
  | { type: "perpCategories" }
  | { type: "candleSnapshot"; req: { coin: string; interval: CandleInterval; startTime: number; endTime: number } };

/** a HIP-3 dex's name as Hyperliquid writes it (xyz, io, vntl, para, mkts): letters and digits */
const HL_DEX = /^[A-Za-z][A-Za-z0-9]{0,15}$/;

/** The network as the Hyperliquid sources use it: a POST of exactly one of the bodies above, built here from its fields, to the one URL,
 * within `timeoutMs`. A dex not named in HIP-3's form is not asked; nothing else is asked */
export function hyperliquidInfo(http: Http, timeoutMs: number): (ask: HyperliquidAsk) => Promise<HttpReply> {
  return async (ask) => {
    let body: Record<string, unknown>;
    if (ask.type === "candleSnapshot") body = { type: "candleSnapshot", req: { coin: ask.req.coin, interval: ask.req.interval, startTime: Math.floor(ask.req.startTime), endTime: Math.floor(ask.req.endTime) } };
    else if (ask.type === "metaAndAssetCtxs") {
      if (ask.dex !== undefined && !HL_DEX.test(ask.dex)) throw new Error(`the dex "${String(ask.dex).slice(0, 20)}" is not asked: a HIP-3 dex is named in letters and digits`);
      body = ask.dex === undefined ? { type: "metaAndAssetCtxs" } : { type: "metaAndAssetCtxs", dex: ask.dex };
    } else body = { type: ask.type === "perpDexs" ? "perpDexs" : "perpCategories" };
    return http(HL_INFO, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(body), timeoutMs });
  };
}

/** a coin as Hyperliquid names it (BTC, kPEPE, HYPE; a HIP-3 market's with its dex: io:ANTH) */
const HL_COIN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,30}$/;
/** Hyperliquid pays funding every hour, on the hour */
const hlNextFunding = (now: number): string => new Date((Math.floor(now / 3_600_000) + 1) * 3_600_000).toISOString();
/** Hyperliquid's connection to trade: an API wallet that places orders and cannot withdraw (the connector live:hyperliquid-trade). Both
 * Hyperliquid listings name it: its perpetuals and its HIP-3 deployers' pre-IPO ones trade there */
const HL_TRADE = { connectTo: "hyperliquid-trade", connector: "live:hyperliquid-trade" } as const;

/** one POST's JSON answer, or Hyperliquid's refusal in its own words */
async function hlAsk(info: ReturnType<typeof hyperliquidInfo>, id: string, name: string, ask: HyperliquidAsk): Promise<unknown> {
  let r: HttpReply;
  try {
    r = await info(ask);
  } catch (err) {
    return unreachable(id, name, err);
  }
  return r.status === 200 && r.body !== undefined && r.body !== null ? r.body : publicNo(id, name, r);
}

/** one Hyperliquid perpetual's bars, keyless: its listing's `<COIN>-PERP` (a HIP-3 market's coin carries its dex: io:ANTH-PERP), the latest
 * at most 300 since the start asked, the volume in the coin; kept a minute. `form`: the coins this source lists */
function hyperliquidBars(info: ReturnType<typeof hyperliquidInfo>, id: string, name: string, clock: () => number, form: { test: (coin: string) => boolean; example: string }): NonNullable<PublicSource["candles"]> {
  const history = keeper<Candle[]>(clock, HISTORY_MS);
  return (symbol, interval, sinceMs) =>
    history(`${symbol}|${interval}|${Math.floor(sinceMs / 60_000)}`, async () => {
      const now = clock();
      const bad = badHistory(id, interval, sinceMs, now);
      if (bad) return bad;
      const k = /^(.+)-PERP$/i.exec(symbol.trim());
      const coin = k?.[1];
      if (!coin || !HL_COIN.test(coin) || !form.test(coin)) return no("E_ACCOUNT_BAD_ACTION", { venue: id, message: `a ${name} perpetual here is ${form.example}, not "${symbol.slice(0, 40)}"` });
      const body = await hlAsk(info, id, name, { type: "candleSnapshot", req: { coin, interval, startTime: Math.max(Math.floor(sinceMs), now - BARS * BAR_MS[interval]), endTime: now } });
      if (isRefusal(body)) return body;
      const bars = new Map<number, Candle>();
      for (const c of list(body).filter(isRec)) {
        const [t, o, h, l, cl, v] = [fin(c.t), pos(c.o), pos(c.h), pos(c.l), pos(c.c), nonNeg(c.v)];
        if (t === undefined || o === undefined || h === undefined || l === undefined || cl === undefined) continue;
        bars.set(t, { t, o, h, l, c: cl, ...(v !== undefined ? { v } : {}) });
      }
      return [...bars.values()].sort((a, b) => a.t - b.t);
    });
}

/** Hyperliquid's perpetuals (its first dex), keyless, busiest first: each `<COIN>-PERP`, placed through Hyperliquid's connection to trade
 * (HL_TRADE) once it is connected — so the Perps tab shows real prices marked "Connect to trade". The price is Hyperliquid's mid (its mark
 * when there is none), the change is from its prevDayPx, the volume its dayNtlVlm, the funding its hourly rate. Hyperliquid's own rule for
 * this machine, if it has one, arrives as its refusal and is shown as that */
export function hyperliquidPublic(deps: PublicDeps = {}): PublicSource {
  const id = "hyperliquid";
  const name = "Hyperliquid";
  const clock = deps.clock ?? Date.now;
  const info = hyperliquidInfo(deps.http ?? realHttp, deps.timeoutMs ?? TIMEOUT_MS);
  const keep = keeper<Listing[]>(clock, KEEP_MS);
  // how much of the list a listing with nothing searched for shows, for the sentence under it
  let shown: { of: number; total: number } | undefined;
  /** every perpetual with its day, from the kept answer */
  const load = (): Promise<Listing[] | Refusal> =>
    keep("metaAndAssetCtxs", async () => {
      const body = await hlAsk(info, id, name, { type: "metaAndAssetCtxs" });
      if (isRefusal(body)) return body;
      const answer = list(body);
      const universe = list(rec(answer[0]).universe).filter(isRec);
      const ctxs = list(answer[1]).filter(isRec);
      if (!universe.length || universe.length !== ctxs.length) return no("E_VENUE_REJECTED", { venue: id, message: `${name} answered without its perpetuals` });
      const nextFundingAt = hlNextFunding(clock());
      const out: Listing[] = [];
      universe.forEach((u, i) => {
        const c = ctxs[i]!;
        const coin = str(u.name);
        if (!coin || !HL_COIN.test(coin) || u.isDelisted === true) return;
        const price = pos(c.midPx) ?? pos(c.markPx);
        if (price === undefined) return;
        const funding = fin(c.funding);
        const volume = nonNeg(c.dayNtlVlm);
        const maxLeverage = pos(u.maxLeverage);
        const day = since(price, pos(c.prevDayPx));
        out.push({
          symbol: `${coin}-PERP`,
          name: `${coin} perpetual on ${name}`,
          kind: "perp",
          base: coin,
          quote: "USDC",
          price,
          open: true,
          types: [],
          ...(day.change !== undefined ? { change24h: day.change, changePct24h: day.changePct } : {}),
          ...(volume !== undefined ? { volumeUsd24h: volume } : {}),
          ...(funding !== undefined ? { fundingRate: funding, nextFundingAt } : {}),
          ...(maxLeverage !== undefined ? { maxLeverage } : {}),
        });
      });
      return out.sort((a, b) => (b.volumeUsd24h ?? -1) - (a.volumeUsd24h ?? -1));
    });
  return {
    id,
    name,
    kind: "exchange",
    ...HL_TRADE,
    async listings(o) {
      const all = await load();
      if (isRefusal(all)) return all;
      const Q = (o.q ?? "").trim().toUpperCase();
      const base = Q.split("/")[0]!.trim();
      const pool = (Q ? all.filter((m) => m.base.toUpperCase().startsWith(base) || m.symbol.toUpperCase().startsWith(Q)) : all).slice(0, Math.max(1, o.limit));
      if (!Q) shown = { of: pool.length, total: all.length };
      return pool;
    },
    candles: hyperliquidBars(info, id, name, clock, { test: (coin) => !coin.includes(":"), example: "<COIN>-PERP (BTC-PERP)" }),
    notes: (o) => (!o.q?.trim() && shown && shown.of < shown.total ? [`${name}: ${shown.of} of ${shown.total} perpetuals shown · search for the rest · traded once Hyperliquid is connected to trade`] : []),
  };
}

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
  // how much of the list a listing with nothing searched for shows, for the sentence under it (a search leaves it as it was)
  let shown: { of: number; total: number } | undefined;
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
      if (!Q) shown = { of: pool.length, total: one.length };
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
    notes: (o) => (!o.q?.trim() && shown && shown.of < shown.total ? [`${name}: ${shown.of} of ${shown.total} shown · search for the rest`] : []),
  };
}

// ---- Pre-IPO perpetuals: contracts on a private company's implied valuation, at eight exchanges and Hyperliquid's HIP-3 deployers ---

/** one contract on a venue's pre-IPO list, as its reader maps the venue's record (see the top of this file for each venue's fields) */
interface PreIpoInstrument {
  /** the venue's own id for it (ANTHROPIC-USDT-SWAP, ANTHROPIC_USDT, PF_ANTHROPICXUSD, ANTH_USDC-PERPETUAL, ANTHROPICUSDTM) */
  id: string;
  /** the unified exchange library's name for it, which a key connected at the venue names in an order (ANTHROPIC/USDT:USDT) */
  symbol: string;
  base: string;
  quote: string;
  open: boolean;
  maxLeverage?: number | undefined;
  contractSize?: number | undefined;
  /** the venue's record, which carries its flag (live/preipo.ts preIpoFlag) */
  info: Rec;
  /** what the list itself says of the day, where it says (Gate's record: its funding and the next time) */
  day?: PreIpoQuote | undefined;
}
/** one contract's prices now, in the venue's own figures */
interface PreIpoQuote {
  price?: number | undefined;
  bid?: number | undefined;
  ask?: number | undefined;
  changePct24h?: number | undefined;
  change24h?: number | undefined;
  volumeUsd24h?: number | undefined;
  fundingRate?: number | undefined;
  nextFundingAt?: string | undefined;
  open?: boolean | undefined;
}
/** one JSON body from a fixed host, or the venue's refusal; the keeping is the source's (its list ten minutes, its quotes KEEP_MS) */
type Fetch = (url: string) => Promise<unknown>;

/** a venue whose pre-IPO perpetuals are read keyless: the unified library's id for it (the venue to connect), and how its list and one
 * contract's quote are read from its own public endpoints */
export interface PreIpoVenue {
  id: string;
  name: string;
  list(fetch: Fetch): Promise<PreIpoInstrument[] | Refusal>;
  quote(fetch: Fetch, inst: PreIpoInstrument): Promise<PreIpoQuote | Refusal>;
}

/** `b`'s figures over `a`'s, where `b` has one */
const dayOf = (a: PreIpoQuote, b: PreIpoQuote): PreIpoQuote => Object.fromEntries([...Object.entries(a), ...Object.entries(b).filter(([, v]) => v !== undefined)]) as PreIpoQuote;
const bodyOf = (body: unknown): Rec[] | Refusal => (isRefusal(body) ? body : list(rec(body).data).filter(isRec));
/** a venue that answered its list without the rows this file reads */
const noList = (venue: string, name: string): Refusal => no("E_VENUE_REJECTED", { venue, message: `${name} answered without its contracts` });

const okxPreIpo: PreIpoVenue = {
  id: "okx",
  name: "OKX",
  async list(fetch) {
    const rows = bodyOf(await fetch("https://www.okx.com/api/v5/public/instruments?instType=SWAP"));
    if (isRefusal(rows)) return rows;
    if (!rows.length) return noList("okx-preipo", "OKX");
    return rows.flatMap((r): PreIpoInstrument[] => {
      const id = str(r.instId);
      const base = str(r.ctValCcy);
      const settle = str(r.settleCcy);
      if (!id || !base || !settle) return [];
      // a linear swap's quote is its settlement currency: the library names it base/settle:settle
      return [{ id, symbol: `${base}/${settle}:${settle}`, base, quote: settle, open: r.state === "live", maxLeverage: pos(r.lever), contractSize: pos(r.ctVal), info: r }];
    });
  },
  async quote(fetch, inst) {
    const [t, f] = await Promise.all([fetch(`https://www.okx.com/api/v5/market/ticker?instId=${encodeURIComponent(inst.id)}`), fetch(`https://www.okx.com/api/v5/public/funding-rate?instId=${encodeURIComponent(inst.id)}`)]);
    const ticks = bodyOf(t);
    if (isRefusal(ticks)) return ticks;
    const d = rec(ticks[0]);
    const last = pos(d.last);
    // the funding is a second small request: without it the price still stands
    const funding = bodyOf(f);
    const fr = isRefusal(funding) ? {} : rec(funding[0]);
    const day = since(last, pos(d.open24h));
    return { price: last, bid: pos(d.bidPx), ask: pos(d.askPx), changePct24h: day.changePct, change24h: day.change, fundingRate: fin(fr.fundingRate), nextFundingAt: isoAt(fr.fundingTime) };
  },
};

/** Gate answers a name it does not list with HTTP 400 and the label CONTRACT_NOT_FOUND (2026-10-06): that is "not listed", not a refusal */
const gateNotFound = (r: Refusal): boolean => (r.native as { status?: unknown; said?: unknown } | undefined)?.status === 400 && /CONTRACT_NOT_FOUND/.test(String((r.native as { said?: unknown }).said ?? ""));
const gatePreIpo: PreIpoVenue = {
  id: "gate",
  name: "Gate",
  async list(fetch) {
    const answers = await Promise.all(PRE_IPO_NAMES.map((n) => fetch(`https://api.gateio.ws/api/v4/futures/usdt/contracts/${encodeURIComponent(`${n}_USDT`)}`)));
    const out: PreIpoInstrument[] = [];
    let refused: Refusal | undefined;
    for (const a of answers) {
      if (isRefusal(a)) {
        if (!gateNotFound(a)) refused ??= a;
        continue;
      }
      const r = rec(a);
      const id = str(r.name);
      if (!id) continue;
      const base = id.replace(/_USDT$/, "");
      out.push({ id, symbol: `${base}/USDT:USDT`, base, quote: "USDT", open: r.status === "trading" && r.in_delisting !== true, maxLeverage: pos(r.leverage_max), contractSize: pos(r.quanto_multiplier), info: r, day: { fundingRate: fin(r.funding_rate), nextFundingAt: isoAt(r.funding_next_apply, true) } });
    }
    // Gate refusing every name (a geoblock, a rate limit) is Gate's refusal; a name or two failing while the others answer is not
    return !out.length && refused ? refused : out;
  },
  async quote(fetch, inst) {
    const body = await fetch(`https://api.gateio.ws/api/v4/futures/usdt/tickers?contract=${encodeURIComponent(inst.id)}`);
    if (isRefusal(body)) return body;
    const d = rec(list(body)[0]);
    return { price: pos(d.last), bid: pos(d.highest_bid), ask: pos(d.lowest_ask), changePct24h: fin(d.change_percentage), change24h: fin(d.change_price), volumeUsd24h: nonNeg(d.volume_24h_quote), fundingRate: fin(d.funding_rate) };
  },
};

const krakenFuturesPreIpo: PreIpoVenue = {
  id: "krakenfutures",
  name: "Kraken Futures",
  async list(fetch) {
    const body = await fetch("https://futures.kraken.com/derivatives/api/v3/instruments");
    if (isRefusal(body)) return body;
    const rows = list(rec(body).instruments).filter(isRec);
    if (!rows.length) return noList("krakenfutures-preipo", "Kraken Futures");
    return rows.flatMap((r): PreIpoInstrument[] => {
      const id = str(r.symbol);
      // its perpetuals are its flexible futures (PF_…), priced and settled in dollars
      if (!id || r.type !== "flexible_futures") return [];
      // the library names the base from the symbol itself: PF_ANTHROPICXUSD → ANTHROPICX (Kraken's own `base` is ANTHROPICx)
      const tail = id.split("_")[1] ?? "";
      const libBase = tail.slice(0, Math.max(0, tail.length - 3)).toUpperCase();
      const base = str(r.base) ?? libBase;
      if (!libBase) return [];
      const margin = pos(rec(list(r.marginLevels)[0]).initialMargin);
      return [{ id, symbol: `${libBase}/USD:USD`, base, quote: "USD", open: r.tradeable === true, ...(margin !== undefined ? { maxLeverage: Math.round(1 / margin) } : {}), contractSize: pos(r.contractSize), info: r }];
    });
  },
  async quote(fetch, inst) {
    const body = await fetch(`https://futures.kraken.com/derivatives/api/v3/tickers/${encodeURIComponent(inst.id)}`);
    if (isRefusal(body)) return body;
    const t = rec(rec(body).ticker);
    return { price: pos(t.last) ?? pos(t.markPrice), bid: pos(t.bid), ask: pos(t.ask), changePct24h: fin(t.change24h), volumeUsd24h: nonNeg(t.volumeQuote), fundingRate: fin(t.relativeFundingRate), open: t.suspended !== true };
  },
};

const deribitPreIpo: PreIpoVenue = {
  id: "deribit",
  name: "Deribit",
  async list(fetch) {
    const body = await fetch("https://www.deribit.com/api/v2/public/get_instruments?currency=any&kind=future");
    if (isRefusal(body)) return body;
    const rows = list(rec(body).result).filter(isRec);
    if (!rows.length) return noList("deribit-preipo", "Deribit");
    return rows.flatMap((r): PreIpoInstrument[] => {
      const id = str(r.instrument_name);
      const base = str(r.base_currency);
      const quote = str(r.quote_currency);
      const settle = str(r.settlement_currency);
      // a perpetual settled in what it is quoted in (linear); its inverse ones are priced in coin
      if (!id || !base || !quote || !settle || r.settlement_period !== "perpetual" || settle !== quote) return [];
      return [{ id, symbol: `${base}/${quote}:${settle}`, base, quote, open: r.is_active === true, maxLeverage: pos(r.max_leverage), contractSize: pos(r.contract_size), info: r }];
    });
  },
  async quote(fetch, inst) {
    const body = await fetch(`https://www.deribit.com/api/v2/public/ticker?instrument_name=${encodeURIComponent(inst.id)}`);
    if (isRefusal(body)) return body;
    const t = rec(rec(body).result);
    const stats = rec(t.stats);
    return { price: pos(t.last_price) ?? pos(t.mark_price), bid: pos(t.best_bid_price), ask: pos(t.best_ask_price), changePct24h: fin(stats.price_change), volumeUsd24h: nonNeg(stats.volume_usd), fundingRate: fin(t.funding_8h), open: t.state === "open" };
  },
};

const kucoinFuturesPreIpo: PreIpoVenue = {
  id: "kucoinfutures",
  name: "KuCoin Futures",
  async list(fetch) {
    const rows = bodyOf(await fetch("https://api-futures.kucoin.com/api/v1/contracts/active"));
    if (isRefusal(rows)) return rows;
    if (!rows.length) return noList("kucoinfutures-preipo", "KuCoin Futures");
    return rows.flatMap((r): PreIpoInstrument[] => {
      const id = str(r.symbol);
      const base = str(r.baseCurrency);
      const quote = str(r.quoteCurrency);
      const settle = str(r.settleCurrency);
      if (!id || !base || !quote || !settle) return [];
      return [{ id, symbol: `${base}/${quote}:${settle}`, base, quote, open: r.status === "Open", maxLeverage: pos(r.maxLeverage), contractSize: pos(r.multiplier), info: r }];
    });
  },
  async quote(fetch, inst) {
    const body = await fetch(`https://api-futures.kucoin.com/api/v1/contracts/${encodeURIComponent(inst.id)}`);
    if (isRefusal(body)) return body;
    const d = rec(rec(body).data);
    return { price: pos(d.lastTradePrice) ?? pos(d.markPrice), changePct24h: pct(d.priceChgPct), change24h: fin(d.priceChg), volumeUsd24h: nonNeg(d.turnoverOf24h), fundingRate: fin(d.fundingFeeRate), nextFundingAt: isoAt(d.nextFundingRateDateTime), open: d.status === "Open" };
  },
};

const mexcPreIpo: PreIpoVenue = {
  id: "mexc",
  name: "MEXC",
  async list(fetch) {
    const rows = bodyOf(await fetch("https://contract.mexc.com/api/v1/contract/detail"));
    if (isRefusal(rows)) return rows;
    if (!rows.length) return noList("mexc-preipo", "MEXC");
    return rows.flatMap((r): PreIpoInstrument[] => {
      const id = str(r.symbol);
      const base = str(r.baseCoin);
      const quote = str(r.quoteCoin);
      const settle = str(r.settleCoin);
      if (!id || !base || !quote || !settle) return [];
      // MEXC's state 0 is a contract that trades (its docs: 0 enabled, 1 delivery, 2 completed, 3 offline, 4 paused)
      return [{ id, symbol: `${base}/${quote}:${settle}`, base, quote, open: r.state === 0 && r.apiAllowed !== false, maxLeverage: pos(r.maxLeverage), contractSize: pos(r.contractSize), info: r }];
    });
  },
  async quote(fetch, inst) {
    const body = await fetch(`https://contract.mexc.com/api/v1/contract/ticker?symbol=${encodeURIComponent(inst.id)}`);
    if (isRefusal(body)) return body;
    const d = rec(rec(body).data);
    return { price: pos(d.lastPrice), bid: pos(d.bid1), ask: pos(d.ask1), changePct24h: pct(d.riseFallRate), change24h: fin(d.riseFallValue), volumeUsd24h: nonNeg(d.amount24), fundingRate: fin(d.fundingRate) };
  },
};

/** Binance's USDⓈ-M futures host. Its documented records carry no pre-IPO flag, so a perpetual named for a company is one (live/preipo.ts) */
const BINANCE_FAPI = "https://fapi.binance.com/fapi/v1";
/** the delivery date Binance writes for every perpetual, 2100-12-25 (its exchangeInfo example; the library tells a perpetual by it too) */
const BINANCE_PERPETUAL = 4_133_404_800_000;
const binancePreIpo: PreIpoVenue = {
  id: "binance",
  name: "Binance",
  async list(fetch) {
    const body = await fetch(`${BINANCE_FAPI}/exchangeInfo`);
    if (isRefusal(body)) return body;
    const rows = list(rec(body).symbols).filter(isRec);
    if (!rows.length) return noList("binance-preipo", "Binance");
    return rows.flatMap((r): PreIpoInstrument[] => {
      const id = str(r.symbol);
      const base = str(r.baseAsset);
      const quote = str(r.quoteAsset);
      const settle = str(r.marginAsset);
      const perpetual = r.contractType === "PERPETUAL" || r.contractType === "TRADIFI_PERPETUAL" || fin(r.deliveryDate) === BINANCE_PERPETUAL;
      // a perpetual settled in what it is quoted in, named as the library names it (ANTHROPIC/USDT:USDT); its dated futures are not
      if (!id || !base || !quote || !settle || !perpetual || settle !== quote) return [];
      return [{ id, symbol: `${base}/${quote}:${settle}`, base, quote, open: r.status === "TRADING", info: r }];
    });
  },
  async quote(fetch, inst) {
    const [t, m] = await Promise.all([fetch(`${BINANCE_FAPI}/ticker/24hr?symbol=${encodeURIComponent(inst.id)}`), fetch(`${BINANCE_FAPI}/premiumIndex?symbol=${encodeURIComponent(inst.id)}`)]);
    if (isRefusal(t)) return t;
    const d = rec(t);
    // the mark and the funding are a second small request: without it the price still stands
    const p = isRefusal(m) ? {} : rec(m);
    return { price: pos(d.lastPrice) ?? pos(p.markPrice), changePct24h: fin(d.priceChangePercent), change24h: fin(d.priceChange), volumeUsd24h: nonNeg(d.quoteVolume), fundingRate: fin(p.lastFundingRate), nextFundingAt: isoAt(p.nextFundingTime) };
  },
};

/** Bybit's v5 market host. Its documented records carry no pre-IPO flag either (symbolType has none; isPreListing is its pre-market for coins) */
const BYBIT_MARKET = "https://api.bybit.com/v5/market";
/** how many pages of Bybit's linear list are read at most, a thousand to a page (its own most) */
const BYBIT_PAGES = 3;
/** what Bybit answered inside its envelope, or its no: a retCode other than 0 is a refusal in its own retMsg, whatever the HTTP status */
function bybitResult(body: unknown): Rec | Refusal {
  if (isRefusal(body)) return body;
  const b = rec(body);
  if (b.retCode === 0 || b.retCode === "0") return rec(b.result);
  return no("E_VENUE_REJECTED", { venue: "bybit-preipo", message: `Bybit refused the request (retCode ${String(b.retCode ?? "none").slice(0, 12)})`, native: { status: 200, said: saidOf(JSON.stringify({ retCode: b.retCode ?? null, retMsg: b.retMsg ?? null })) } });
}
const bybitPreIpo: PreIpoVenue = {
  id: "bybit",
  name: "Bybit",
  async list(fetch) {
    const rows: Rec[] = [];
    let cursor = "";
    for (let page = 0; page < BYBIT_PAGES; page++) {
      const got = bybitResult(await fetch(`${BYBIT_MARKET}/instruments-info?category=linear&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`));
      // the first page refusing is Bybit's refusal; a later one leaves the pages read standing
      if (isRefusal(got)) {
        if (!rows.length) return got;
        break;
      }
      rows.push(...list(got.list).filter(isRec));
      cursor = str(got.nextPageCursor) ?? "";
      if (!cursor) break;
    }
    if (!rows.length) return noList("bybit-preipo", "Bybit");
    return rows.flatMap((r): PreIpoInstrument[] => {
      const id = str(r.symbol);
      const base = str(r.baseCoin);
      const quote = str(r.quoteCoin);
      const settle = str(r.settleCoin);
      if (!id || !base || !quote || !settle || r.contractType !== "LinearPerpetual" || settle !== quote) return [];
      return [{ id, symbol: `${base}/${quote}:${settle}`, base, quote, open: r.status === "Trading", maxLeverage: pos(rec(r.leverageFilter).maxLeverage), info: r }];
    });
  },
  async quote(fetch, inst) {
    const got = bybitResult(await fetch(`${BYBIT_MARKET}/tickers?category=linear&symbol=${encodeURIComponent(inst.id)}`));
    if (isRefusal(got)) return got;
    const t = rec(list(got.list)[0]);
    const last = pos(t.lastPrice);
    const day = since(last, pos(t.prevPrice24h));
    return { price: last ?? pos(t.markPrice), bid: pos(t.bid1Price), ask: pos(t.ask1Price), changePct24h: day.changePct, change24h: day.change, volumeUsd24h: nonNeg(t.turnover24h), fundingRate: fin(t.fundingRate), nextFundingAt: isoAt(t.nextFundingTime) };
  },
};

/** the eight exchanges, in the order the Markets screen asks them (Hyperliquid's HIP-3 deployers are their own source: hyperliquidPreIpoPublic) */
export const PRE_IPO_VENUES: readonly PreIpoVenue[] = [okxPreIpo, gatePreIpo, krakenFuturesPreIpo, deribitPreIpo, kucoinFuturesPreIpo, mexcPreIpo, binancePreIpo, bybitPreIpo];

/** one pre-IPO contract as a listing: the venue's own figures for it (`on`: the place it trades, for its name), its company, and the valuation
 * its price implies in its venue's unit; none without a price */
function preIpoListing(i: { symbol: string; base: string; quote: string; open: boolean; maxLeverage?: number | undefined; contractSize?: number | undefined; mark: PreIpoMark }, day: PreIpoQuote, on: string): Listing | undefined {
  const price = day.price;
  if (price === undefined) return undefined;
  return {
    symbol: i.symbol,
    name: `${i.mark.name} pre-IPO perpetual on ${on}`,
    kind: "perp",
    base: i.base,
    quote: i.quote,
    price,
    bid: day.bid,
    ask: day.ask,
    open: i.open && day.open !== false,
    types: [],
    ...(day.changePct24h !== undefined ? { changePct24h: day.changePct24h } : {}),
    ...(day.change24h !== undefined ? { change24h: day.change24h } : {}),
    ...(day.volumeUsd24h !== undefined ? { volumeUsd24h: day.volumeUsd24h } : {}),
    ...(day.fundingRate !== undefined ? { fundingRate: day.fundingRate, ...(day.nextFundingAt ? { nextFundingAt: day.nextFundingAt } : {}) } : {}),
    ...(i.maxLeverage !== undefined ? { maxLeverage: i.maxLeverage } : {}),
    ...(i.contractSize !== undefined ? { contractSize: i.contractSize } : {}),
    category: i.mark.category,
    group: i.mark.group,
    implied: { ...i.mark.implied, usd: impliedUsd(price, i.mark.implied.perPoint) },
    ...(i.mark.issuer ? { issuer: i.mark.issuer, eligibility: i.mark.eligibility } : {}),
  };
}

const busierFirst = (a: Listing, b: Listing): number => (b.volumeUsd24h ?? -1) - (a.volumeUsd24h ?? -1);

/** One venue's pre-IPO perpetuals, keyless (see the top of this file): its list kept LIST_MS with the venue's own flag applied
 * (live/preipo.ts), one or two small price requests a contract kept KEEP_MS, each contract a perpetual under the category "Pre-IPO" with its
 * company, its implied valuation in the venue's unit, and the issuer's words where an issuer has given some. The source's id is
 * `<venue>-preipo`, apart from the venue's spot tickers' (the service caches by id); it is the public side of the same connection, so a
 * key connected at the venue replaces it. A venue that does not serve this location says so once, on its list, and is held back ten minutes */
export function preIpoPublic(v: PreIpoVenue, deps: PublicDeps = {}): PublicSource {
  const id = `${v.id}-preipo`;
  const name = v.name;
  const clock = deps.clock ?? Date.now;
  const get = fixedHosts(deps.http ?? realHttp, PUBLIC_HOSTS, deps.timeoutMs ?? TIMEOUT_MS);
  const fetch: Fetch = async (url) => {
    let r: HttpReply;
    try {
      r = await get(url);
    } catch (err) {
      return unreachable(id, name, err);
    }
    return r.status === 200 && r.body !== undefined ? r.body : publicNo(id, name, r);
  };
  type Flagged = PreIpoInstrument & { mark: PreIpoMark };
  const lists = keeper<Flagged[]>(clock, LIST_MS);
  const quotes = keeper<PreIpoQuote>(clock, KEEP_MS);
  /** the venue's list with its flag applied: only the contracts the venue's own record says are pre-IPO, priced in dollars */
  const listed = (): Promise<Flagged[] | Refusal> =>
    lists("list", async () => {
      const got = await v.list(fetch);
      if (isRefusal(got)) return got;
      return got.flatMap((inst): Flagged[] => {
        if (!inDollars(inst.quote)) return [];
        const mark = preIpoOf(v.id, inst.info, inst.base, inst.id);
        return mark ? [{ ...inst, mark }] : [];
      });
    });
  return {
    id,
    name,
    kind: "exchange",
    connectTo: v.id,
    connector: `live:exchange:${v.id}`,
    async listings(o) {
      const insts = await listed();
      if (isRefusal(insts)) return insts;
      const Q = (o.q ?? "").trim().toUpperCase();
      const want = Q ? insts.filter((i) => has(Q, i.base, i.symbol, i.id, i.mark.name, i.mark.slug)) : insts;
      const rows = await Promise.all(want.map(async (i) => ({ i, q: await quotes(i.id, () => v.quote(fetch, i)) })));
      let refused: Refusal | undefined;
      const out: Listing[] = [];
      for (const { i, q } of rows) {
        if (isRefusal(q)) {
          refused ??= q;
          continue;
        }
        const listing = preIpoListing(i, dayOf(i.day ?? {}, q), name);
        if (listing) out.push(listing);
      }
      // every contract refusing is the venue's refusal; one failing while the others answer is left out this time
      if (!out.length && refused) return refused;
      return out.sort(busierFirst).slice(0, Math.max(1, o.limit));
    },
  };
}

// ---- Hyperliquid's HIP-3 pre-IPO perpetuals --------------------------------------------------------------------------------------------

/** a HIP-3 dex's collateral, by its spot token index (POST /info {"type":"spotMeta"}, read 2026-10-08 — 136 KB, so it is not read each time;
 * an index, once given, is that token's for good): 0 USDC (io, xyz, para, mkts, abcd), 235 USDE (hyna), 268 USDT0 (cash), 360 USDH (flx,
 * vntl, km). The docs' example of the first dex gives none, and that dex is USDC's: a dex that names none is read as USDC. A market is
 * listed only where its collateral counts as dollars (types.ts STABLES: USDC and USDT0 do, USDE and USDH do not yet); a dex on a token this
 * table does not name is not listed */
const HL_COLLATERAL: Readonly<Record<number, string>> = { 0: "USDC", 235: "USDE", 268: "USDT0", 360: "USDH" };

/** one HIP-3 market that is a pre-IPO contract: its dex, its coin as Hyperliquid names it (io:ANTH), the company's name in it (ANTH) */
interface Hip3Market {
  dex: string;
  coin: string;
  base: string;
  quote: string;
  mark: PreIpoMark;
}

/** Hyperliquid's HIP-3 pre-IPO perpetuals, keyless (see the top of this file): every dex's list, kept ten minutes, read for markets named
 * for a company that Hyperliquid files under no other category than "preipo", not delisted; then every ninety seconds the dexes that hold
 * one, and each such market someone holds or trades, as `<dex>:<COIN>-PERP` with its line named "Hyperliquid · <dex>", its day, its
 * hourly funding, its leverage and the valuation its price implies. One refusal of perpDexs is Hyperliquid's refusal; a dex that does not
 * answer is left out until it does */
export function hyperliquidPreIpoPublic(deps: PublicDeps = {}): PublicSource {
  const id = "hyperliquid-preipo";
  const name = "Hyperliquid";
  const clock = deps.clock ?? Date.now;
  const info = hyperliquidInfo(deps.http ?? realHttp, deps.timeoutMs ?? TIMEOUT_MS);
  const ask = (q: HyperliquidAsk): Promise<unknown> => hlAsk(info, id, name, q);
  /** one dex's universe and day, kept KEEP_MS: the search for markets (every LIST_MS) and their prices (every KEEP_MS) share it */
  const dexAnswers = keeper<unknown>(clock, KEEP_MS);
  const dexRead = (dex: string): Promise<unknown> => dexAnswers(dex, () => ask({ type: "metaAndAssetCtxs", dex }));
  /** the markets that are pre-IPO contracts, kept LIST_MS — KEEP_MS when a dex or the categories did not answer, so what that missed is
   * looked for again soon */
  const finds = keeper<{ markets: Hip3Market[]; whole: boolean }>(clock, (f) => (f.whole ? LIST_MS : KEEP_MS));
  const found = (): Promise<{ markets: Hip3Market[]; whole: boolean } | Refusal> =>
    finds("markets", async () => {
      const [named, filed] = await Promise.all([ask({ type: "perpDexs" }), ask({ type: "perpCategories" })]);
      if (isRefusal(named)) return named;
      // the first entry is the first dex, written null: its perpetuals are hyperliquidPublic's
      const dexes = [...new Set(list(named).filter(isRec).map((d) => str(d.name)).filter((n): n is string => n !== undefined && HL_DEX.test(n)))];
      // Hyperliquid's category for each market; without that answer, a company's name alone decides this time
      const category = new Map<string, string>();
      if (!isRefusal(filed))
        for (const pair of list(filed)) {
          const [coin, cat] = [str(list(pair)[0]), str(list(pair)[1])];
          if (coin && cat) category.set(coin, cat);
        }
      const answers = await Promise.all(dexes.map(async (dex) => ({ dex, body: await dexRead(dex) })));
      const markets: Hip3Market[] = [];
      let refused: Refusal | undefined;
      for (const { dex, body } of answers) {
        if (isRefusal(body)) {
          refused ??= body;
          continue;
        }
        const meta = rec(list(body)[0]);
        const quote = HL_COLLATERAL[fin(meta.collateralToken) ?? 0];
        if (!quote || !inDollars(quote)) continue;
        for (const u of list(meta.universe).filter(isRec)) {
          const coin = str(u.name);
          if (!coin || !HL_COIN.test(coin) || !coin.startsWith(`${dex}:`) || u.isDelisted === true) continue;
          const base = coin.slice(dex.length + 1);
          const cat = category.get(coin);
          const mark = preIpoOf("hyperliquid", cat !== undefined ? { category: cat } : {}, base, coin);
          if (mark) markets.push({ dex, coin, base, quote, mark });
        }
      }
      // every dex refusing is Hyperliquid's refusal; one failing while the others answer is looked for again soon
      if (dexes.length && answers.every((a) => isRefusal(a.body))) return refused!;
      return { markets, whole: refused === undefined && !isRefusal(filed) };
    });
  // the dexes the last listing with nothing searched for showed, for the sentence under it
  let shown: string[] | undefined;
  return {
    id,
    name,
    kind: "exchange",
    ...HL_TRADE,
    async listings(o) {
      const got = await found();
      if (isRefusal(got)) return got;
      const Q = (o.q ?? "").trim().toUpperCase();
      const want = Q ? got.markets.filter((m) => has(Q, m.base, m.coin, m.mark.name, m.mark.slug)) : got.markets;
      const bodies = new Map(await Promise.all([...new Set(want.map((m) => m.dex))].map(async (dex) => [dex, await dexRead(dex)] as const)));
      const nextFundingAt = hlNextFunding(clock());
      const out: Listing[] = [];
      let refused: Refusal | undefined;
      for (const m of want) {
        const body = bodies.get(m.dex);
        if (isRefusal(body)) {
          refused ??= body;
          continue;
        }
        const answer = list(body);
        const universe = list(rec(answer[0]).universe).filter(isRec);
        const ctxs = list(answer[1]).filter(isRec);
        const at = universe.length === ctxs.length ? universe.findIndex((u) => u.name === m.coin) : -1;
        if (at < 0 || universe[at]!.isDelisted === true) continue;
        const c = ctxs[at]!;
        const volume = nonNeg(c.dayNtlVlm);
        // anyone may deploy a HIP-3 market: one that nobody holds or trades is not shown
        if (!((nonNeg(c.openInterest) ?? 0) > 0 || (volume ?? 0) > 0)) continue;
        const price = pos(c.midPx) ?? pos(c.markPx);
        const day = since(price, pos(c.prevDayPx));
        const venueName = `${name} · ${m.dex}`;
        const listing = preIpoListing({ symbol: `${m.coin}-PERP`, base: m.base, quote: m.quote, open: true, maxLeverage: pos(universe[at]!.maxLeverage), mark: m.mark }, { price, changePct24h: day.changePct, change24h: day.change, volumeUsd24h: volume, fundingRate: fin(c.funding), nextFundingAt }, venueName);
        if (listing) out.push({ ...listing, venueName });
      }
      if (!out.length && refused) return refused;
      const pool = out.sort(busierFirst).slice(0, Math.max(1, o.limit));
      if (!Q) shown = [...new Set(pool.map((l) => l.venueName!.slice(name.length + 3)))];
      return pool;
    },
    candles: hyperliquidBars(info, id, name, clock, { test: (coin) => coin.includes(":"), example: "<dex>:<COIN>-PERP (io:ANTH-PERP)" }),
    notes: (o) => (!o.q?.trim() && shown?.length ? [`${name} · ${shown.join(", ")}: pre-IPO perpetuals on Hyperliquid's HIP-3 markets, which anyone may deploy; shown while someone holds or trades one.`] : []),
  };
}

/** every public source, in the order the Markets screen asks them: the exchanges (PUBLIC_EXCHANGES unless others are named), Kalshi,
 * Polymarket, Polymarket US, Hyperliquid's perpetuals, Robinhood's Stock Tokens, the eight exchanges' pre-IPO perpetuals and Hyperliquid's
 * HIP-3 ones. Made once and kept: what each keeps lives in it */
export function publicSources(deps: PublicDeps & { exchanges?: readonly string[] | undefined } = {}): PublicSource[] {
  return [...(deps.exchanges ?? PUBLIC_EXCHANGES).map((x) => exchangeTickers(x, deps)), kalshiPublic(deps), polymarketPublic(deps), polymarketUsPublic(deps), hyperliquidPublic(deps), stockTokensPublic(deps), ...PRE_IPO_VENUES.map((v) => preIpoPublic(v, deps)), hyperliquidPreIpoPublic(deps)];
}
