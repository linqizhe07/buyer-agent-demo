import type { ExchangeClient, OpenExchange } from "../../src/portfolio/live/exchange.ts";
import { PRE_IPO_VENUES } from "../../src/portfolio/live/public-markets.ts";
import type { Http, HttpReply } from "../../src/portfolio/live/types.ts";

/** Fixtures for the keyless public market data, wherever this machine is (live-public-markets-location and live-explore-location): what
 * a venue serves here is read, what it refuses here lands in `missing` in its own words and is held back. For stand-ins only — nothing
 * leaves the process, no key exists in this file:
 *   · Binance and Bybit cannot be read from the developer's machine (Binance answers HTTP 451, Bybit's CloudFront edge 403). Their two
 *     refusals below are the bodies they really answered on 2026-10-08; every other Binance and Bybit answer here is a DOCUMENTED SHAPE —
 *     developers.binance.com (USDⓈ-M futures: exchangeInfo, ticker/24hr, premiumIndex) and bybit-exchange.github.io/docs/v5 (market/
 *     instruments-info, market/tickers), read 2026-10-08, with the contract terms of their listing announcements — and the prices in them
 *     are made up near the other venues' of that day, since none could be read;
 *   · Hyperliquid answers from here: its fixtures are its live answers of 2026-10-08 (perpDexs, perpCategories, metaAndAssetCtxs per dex,
 *     candleSnapshot), trimmed to a few markets each, and two markets this file makes up to show the rules no live market did that day
 *     (each marked where it is). */

export const NOW = Date.parse("2026-10-08T18:12:00.000Z");
export const HOUR = 3_600_000;
export const MIN = 60_000;
export const json = (body: unknown, status = 200): HttpReply => ({ status, body, text: JSON.stringify(body) });
export type Rec = Record<string, unknown>;

/** a stand-in network: GETs answered by URL (the first route whose key the URL contains), every request recorded */
export function network(routes: Array<[string, HttpReply | ((url: string) => HttpReply)]>) {
  const sent: Array<{ url: string; method: string; body?: unknown }> = [];
  const http: Http = async (url, init = {}) => {
    sent.push({ url, method: init.method ?? "GET", ...(init.body !== undefined ? { body: JSON.parse(init.body) as unknown } : {}) });
    const hit = routes.find(([k]) => url.includes(k));
    if (!hit) return json({ error: "not found" }, 404);
    return typeof hit[1] === "function" ? hit[1](url) : hit[1];
  };
  return { http, sent };
}

// ---- the two refusals, as answered to the developer's machine on 2026-10-08 ---------------------------------------------------------

/** Binance, GET https://fapi.binance.com/fapi/v1/exchangeInfo (and api.binance.com alike): HTTP 451, 224 bytes */
export const BINANCE_451_BODY = '{\n  "code": 0,\n  "msg": "Service unavailable from a restricted location according to \'b. Eligibility\' in https://www.binance.com/en/terms. Please contact customer service if you believe you received this message in error."\n}';
export const BINANCE_SAID = "Service unavailable from a restricted location according to 'b. Eligibility' in https://www.binance.com/en/terms. Please contact customer service if you believe you received this message in error.";
/** Bybit, GET https://api.bybit.com/v5/market/instruments-info?category=spot: HTTP 403 from its CloudFront edge, 96 bytes, not JSON */
export const BYBIT_403_BODY = "{\n    error:The Amazon CloudFront distribution is configured to block access from your country\n}";
export const BYBIT_SAID = "{ error:The Amazon CloudFront distribution is configured to block access from your country }";
/** what the exchange library throws on each: its request line, then the body (ccxt 4.5.85 handleHttpStatusCode; Bybit maps 403 to
 * RateLimitExceeded, "Forbidden -- You request too many times") */
export const binance451 = () => Object.assign(new Error(`binance GET https://api.binance.com/api/v3/exchangeInfo 451  ${BINANCE_451_BODY}`), { name: "ExchangeNotAvailable" });
export const bybit403 = () => Object.assign(new Error(`bybit GET https://api.bybit.com/v5/market/instruments-info?category=spot 403 Forbidden ${BYBIT_403_BODY}`), { name: "RateLimitExceeded" });

/** a stand-in library client that keeps a failed load of the markets and answers it again, as the library does, until asked to reload;
 * `loads` counts the loads that would go to the exchange */
export function refusing(err: () => Error) {
  let loading: Promise<unknown> | undefined;
  const counts = { loads: 0, reloads: 0, tickers: 0, bars: 0 };
  const loadMarkets = (reload?: boolean): Promise<unknown> => {
    if (!loading || reload) {
      counts.loads++;
      if (reload) counts.reloads++;
      loading = Promise.reject(err());
      loading.catch(() => undefined);
    }
    return loading;
  };
  const client: ExchangeClient = {
    id: "x",
    loadMarkets,
    async fetchBalance() {
      throw new Error("a public source never reads a balance");
    },
    async fetchTickers() {
      counts.tickers++;
      return {};
    },
    async fetchOHLCV() {
      counts.bars++;
      return [];
    },
  };
  const open: OpenExchange = async (id) => ({ ...client, id, loadMarkets });
  return { open, counts };
}

// ---- Binance's and Bybit's pre-IPO perpetuals: documented shapes ---------------------------------------------------------------------

/** Binance GET /fapi/v1/exchangeInfo: the documented record (its example is BLZUSDT), for a coin perpetual, a dated future, three contracts
 * its announcements name (ANTHROPICUSDT from 2026-06-02 04:30 UTC; OPENAIUSDT; OURAUSDT) and SPCXUSDT, made up here to show SpaceX is never
 * one. Which contractType a pre-IPO contract carries is not documented: one is written PERPETUAL, one TRADIFI_PERPETUAL (the docs' other
 * perpetual), one with the perpetual's delivery date alone. What Binance writes in underlyingType for them is not documented: left out */
export const BN_SYMBOL = (symbol: string, base: string, extra: Rec = {}): Rec => ({ symbol, pair: symbol, contractType: "PERPETUAL", deliveryDate: 4133404800000, onboardDate: 1780374600000, status: "TRADING", maintMarginPercent: "2.5000", requiredMarginPercent: "5.0000", baseAsset: base, quoteAsset: "USDT", marginAsset: "USDT", pricePrecision: 2, quantityPrecision: 2, baseAssetPrecision: 8, quotePrecision: 8, settlePlan: 0, triggerProtect: "0.0500", liquidationFee: "0.012500", marketTakeBound: "0.05", filters: [{ filterType: "PRICE_FILTER", minPrice: "0.01", maxPrice: "100000", tickSize: "0.01" }, { filterType: "LOT_SIZE", minQty: "0.01", maxQty: "10000", stepSize: "0.01" }, { filterType: "MIN_NOTIONAL", notional: "5" }], orderTypes: ["LIMIT", "MARKET"], timeInForce: ["GTC", "IOC", "FOK", "GTX"], ...extra });
export const BN_INFO = {
  timezone: "UTC",
  serverTime: NOW,
  futuresType: "U_MARGINED",
  rateLimits: [{ rateLimitType: "REQUEST_WEIGHT", interval: "MINUTE", intervalNum: 1, limit: 2400 }],
  exchangeFilters: [],
  assets: [{ asset: "USDT", marginAvailable: true, autoAssetExchange: "-10000" }],
  symbols: [
    BN_SYMBOL("BTCUSDT", "BTC", { onboardDate: 1569398400000, underlyingType: "COIN", underlyingSubType: ["PoW"] }),
    BN_SYMBOL("BTCUSDT_261225", "BTC", { pair: "BTCUSDT", contractType: "CURRENT_QUARTER", deliveryDate: 1798185600000, underlyingType: "COIN" }),
    BN_SYMBOL("ANTHROPICUSDT", "ANTHROPIC"),
    BN_SYMBOL("OPENAIUSDT", "OPENAI", { contractType: "TRADIFI_PERPETUAL" }),
    BN_SYMBOL("OURAUSDT", "OURA", { contractType: "" }),
    BN_SYMBOL("SPCXUSDT", "SPCX", { contractType: "TRADIFI_PERPETUAL" }),
  ],
};
/** GET /fapi/v1/ticker/24hr?symbol= (the USDⓈ-M shape, as the library's parser documents it: no book) */
export const BN_DAY = (symbol: string, last: string, change: string, pct: string, quoteVolume: string): Rec => ({ symbol, priceChange: change, priceChangePercent: pct, weightedAvgPrice: last, lastPrice: last, lastQty: "0.05", openPrice: String(Number(last) - Number(change)), highPrice: last, lowPrice: last, volume: "24310.11", quoteVolume, openTime: NOW - 24 * HOUR, closeTime: NOW, firstId: 1, lastId: 2, count: 2 });
/** GET /fapi/v1/premiumIndex?symbol=: the latest funding rate and the next time (every eight hours: after 18:12 UTC, midnight) */
export const BN_MARK = (symbol: string, mark: string): Rec => ({ symbol, markPrice: mark, indexPrice: mark, estimatedSettlePrice: mark, lastFundingRate: "0.00005000", interestRate: "0.00005000", nextFundingTime: 1791504000000, time: NOW });

/** Bybit GET /v5/market/instruments-info?category=linear&limit=1000, in two pages: the documented record, with its listing announcement's terms
 * for ANTHROPICUSDT and OPENAIUSDT (2026-07-13: 20x, tick 0.01, minimum 0.01, funding every four hours) */
export const BY_INST = (symbol: string, base: string, extra: Rec = {}): Rec => ({ symbol, contractType: "LinearPerpetual", status: "Trading", baseCoin: base, quoteCoin: "USDT", launchTime: "1783929600000", deliveryTime: "0", deliveryFeeRate: "", priceScale: "2", leverageFilter: { minLeverage: "1", maxLeverage: "20.00", leverageStep: "0.01" }, priceFilter: { minPrice: "0.01", maxPrice: "199999.98", tickSize: "0.01" }, lotSizeFilter: { maxOrderQty: "1000.00", maxMktOrderQty: "200.00", minOrderQty: "0.01", qtyStep: "0.01", postOnlyMaxOrderQty: "1000.00", minNotionalValue: "5" }, unifiedMarginTrade: true, fundingInterval: 240, settleCoin: "USDT", copyTrading: "none", upperFundingRate: "0.00005", lowerFundingRate: "-0.00005", isPreListing: false, preListingInfo: null, riskParameters: { priceLimitRatioX: "0.05", priceLimitRatioY: "0.1" }, displayName: "", symbolType: "", ...extra });
export const BY_PAGE = (list: Rec[], nextPageCursor: string): Rec => ({ retCode: 0, retMsg: "OK", result: { category: "linear", list, nextPageCursor }, retExtInfo: {}, time: NOW });
export const BY_PAGES: Record<string, Rec> = {
  "": BY_PAGE([BY_INST("BTCUSDT", "BTC", { launchTime: "1585526400000", fundingInterval: 480, leverageFilter: { minLeverage: "1", maxLeverage: "100.00", leverageStep: "0.01" } }), BY_INST("ANTHROPICUSDT", "ANTHROPIC")], "cursor-2"),
  "cursor-2": BY_PAGE([BY_INST("OPENAIUSDT", "OPENAI"), BY_INST("BTCUSDT-26DEC26", "BTC", { contractType: "LinearFutures", deliveryTime: "1798272000000" }), BY_INST("OURAUSDT", "OURA", { leverageFilter: { minLeverage: "1", maxLeverage: "10.00", leverageStep: "0.01" } })], ""),
};
/** GET /v5/market/tickers?category=linear&symbol=: the documented linear fields (funding every four hours: after 18:12 UTC, 20:00) */
export const BY_TICK = (symbol: string, last: string, prev: string, bid: string, ask: string, turnover: string): Rec => ({ retCode: 0, retMsg: "OK", result: { category: "linear", list: [{ symbol, lastPrice: last, indexPrice: last, markPrice: last, prevPrice24h: prev, price24hPcnt: String(Number(((Number(last) - Number(prev)) / Number(prev)).toFixed(6))), highPrice24h: prev, lowPrice24h: last, prevPrice1h: last, openInterest: "8120.55", openInterestValue: "16136543.21", turnover24h: turnover, volume24h: "17950.12", fundingRate: "0.00005", nextFundingTime: "1791489600000", predictedDeliveryPrice: "", basisRate: "", deliveryFeeRate: "", deliveryTime: "0", ask1Size: "1.25", bid1Price: bid, ask1Price: ask, bid1Size: "2.10", basis: "", preOpenPrice: "", preQty: "", curPreListingPhase: "", fundingIntervalHour: "4", fundingCap: "0.00005" }] }, retExtInfo: {}, time: NOW });

export const venueOf = (id: string) => PRE_IPO_VENUES.find((v) => v.id === id)!;
export const UNIT = "a price of $1 stands for $1,000,000,000 of implied company valuation (one contract ≈ one-billionth of the company)";

// ---- Hyperliquid's HIP-3 pre-IPO perpetuals: its live answers of 2026-10-08, trimmed -----------------------------------------------

/** POST /info {"type":"perpDexs"}: the first dex as null, then five of that day's ten HIP-3 dexes — and mkts, whose markets below are made up */
export const HL_DEXES = [null, { name: "xyz", fullName: "XYZ", deployer: "0x88806a71d74ad0a510b350545c9ae490912f0888" }, { name: "flx", fullName: "Felix Exchange", deployer: "0x2fab552502a6d45920d5741a2f3ebf4c35536352" }, { name: "vntl", fullName: "Ventuals", deployer: "0x8888888192a4a0593c13532ba48449fc24c3beda" }, { name: "para", fullName: "Paragon", deployer: "0x8888888c43cbb7e1c4132542e46831bffd866ed3" }, { name: "mkts", fullName: "Markets By Kinetiq", deployer: "0x71f0019cc7fa79e4f42587fb7b9a817d8d2429ec" }, { name: "io", fullName: "EntropyIO", deployer: "0x320c8988e3d1b5198f335802d7bfd2728a8fcac6" }];
/** POST /info {"type":"perpCategories"}: that day's categories for these markets; mkts:KALSHI's is made up, to show a category that rules one out */
export const HL_CATEGORIES = [["flx:TSLA", "stocks"], ["io:ANTH", "preipo"], ["io:OAI", "preipo"], ["io:SNDK", "stocks"], ["para:ANTH", "preipo"], ["para:AVGO", "stocks"], ["vntl:ANTHROPIC", "preipo"], ["vntl:OPENAI", "preipo"], ["vntl:SPACEX", "preipo"], ["xyz:OURA", "preipo"], ["xyz:SPCX", "stocks"], ["xyz:TSLA", "stocks"], ["mkts:KALSHI", "stocks"]];
/** POST /info {"type":"metaAndAssetCtxs","dex":…}: each dex's universe and day, in step */
export const HL_META: Record<string, [Rec, Rec[]]> = {
  io: [
    { universe: [{ name: "io:OAI", szDecimals: 3, maxLeverage: 6, onlyIsolated: true, marginMode: "noCross" }, { name: "io:ANTH", szDecimals: 3, maxLeverage: 6, onlyIsolated: true, marginMode: "strictIsolated" }, { name: "io:SNDK", szDecimals: 4, maxLeverage: 10, onlyIsolated: true, marginMode: "strictIsolated" }, { name: "io:SBE", szDecimals: 2, maxLeverage: 6, onlyIsolated: true, isDelisted: true, marginMode: "strictIsolated" }], marginTables: [], collateralToken: 0 },
    [
      { funding: "0.0000415718", openInterest: "3177.432", prevDayPx: "1731.1", dayNtlVlm: "5859153.8994000005", premium: "0.0039942091", oraclePx: "1640.5", markPx: "1643.4", midPx: "1644.65", impactPxs: ["1644.237", "1649.868"], dayBaseVlm: "3430.958" },
      { funding: "0.0000185782", openInterest: "19475.704", prevDayPx: "2122.5", dayNtlVlm: "11791556.5899999943", premium: "0.0015323766", oraclePx: "2041.6", markPx: "2045.1", midPx: "2044.55", impactPxs: ["2043.842", "2045.615"], dayBaseVlm: "5620.711" },
      { funding: "0.00000625", openInterest: "2477.0012", prevDayPx: "1725.2", dayNtlVlm: "34317738.9263400212", premium: "0.0002271454", oraclePx: "1606.9", markPx: "1606.7", midPx: "1607.35", impactPxs: ["1607.0", "1607.53"], dayBaseVlm: "20472.6702" },
      { funding: "0.0", openInterest: "0.0", prevDayPx: "50.0", dayNtlVlm: "0.0", premium: null, oraclePx: "50.0", markPx: "50.0", midPx: null, impactPxs: null, dayBaseVlm: "0.0" },
    ],
  ],
  xyz: [
    { universe: [{ name: "xyz:TSLA", szDecimals: 3, maxLeverage: 20 }, { name: "xyz:SPCX", szDecimals: 2, maxLeverage: 20 }, { name: "xyz:OURA", szDecimals: 1, maxLeverage: 5, onlyIsolated: true, marginMode: "noCross" }, { name: "xyz:YMTC", szDecimals: 1, maxLeverage: 5, onlyIsolated: true, isDelisted: true, marginMode: "strictIsolated" }], marginTables: [], collateralToken: 0 },
    [
      { funding: "0.00000625", openInterest: "120643.206", prevDayPx: "376.35", dayNtlVlm: "16042154.0029200036", premium: "0.0001510044", oraclePx: "370.85", markPx: "370.94", midPx: "370.91", impactPxs: ["370.875", "370.937"], dayBaseVlm: "42819.742" },
      { funding: "0.00000625", openInterest: "809031.3199999999", prevDayPx: "166.97", dayNtlVlm: "130765387.0174000561", premium: "-0.0002157963", oraclePx: "162.19", markPx: "162.18", midPx: "162.155", impactPxs: ["162.15", "162.16"], dayBaseVlm: "791078.1899999996" },
      { funding: "0.0000011593", openInterest: "16590.4", prevDayPx: "48.931", dayNtlVlm: "17688.0185", premium: "0.00545866", oraclePx: "48.718", markPx: "48.585", midPx: "48.551", impactPxs: ["48.18761", "49.78026"], dayBaseVlm: "363.7" },
      { funding: "0.0", openInterest: "0.0", prevDayPx: "10.0", dayNtlVlm: "0.0", premium: null, oraclePx: "10.0", markPx: "10.0", midPx: null, impactPxs: null, dayBaseVlm: "0.0" },
    ],
  ],
  vntl: [
    { universe: [{ name: "vntl:SPACEX", szDecimals: 3, maxLeverage: 3, onlyIsolated: true, isDelisted: true, marginMode: "strictIsolated" }, { name: "vntl:OPENAI", szDecimals: 3, maxLeverage: 3, onlyIsolated: true, isDelisted: true, marginMode: "strictIsolated" }, { name: "vntl:ANTHROPIC", szDecimals: 3, maxLeverage: 3, onlyIsolated: true, isDelisted: true, marginMode: "strictIsolated" }], marginTables: [], collateralToken: 360 },
    [
      { funding: "0.0", openInterest: "0.0", prevDayPx: "2109.5", dayNtlVlm: "0.0", premium: null, oraclePx: "2417.0", markPx: "2109.5", midPx: null, impactPxs: null, dayBaseVlm: "0.0" },
      { funding: "0.0", openInterest: "0.0", prevDayPx: "1344.5", dayNtlVlm: "0.0", premium: null, oraclePx: "1341.8", markPx: "1336.2", midPx: null, impactPxs: null, dayBaseVlm: "0.0" },
      { funding: "0.0", openInterest: "0.0", prevDayPx: "1619.3", dayNtlVlm: "0.0", premium: null, oraclePx: "1618.9", markPx: "1619.3", midPx: null, impactPxs: null, dayBaseVlm: "0.0" },
    ],
  ],
  para: [
    { universe: [{ name: "para:AVGO", szDecimals: 2, maxLeverage: 10, onlyIsolated: true, marginMode: "noCross" }, { name: "para:ANTH", szDecimals: 3, maxLeverage: 5, onlyIsolated: true, isDelisted: true, marginMode: "strictIsolated" }], marginTables: [], collateralToken: 0 },
    [
      { funding: "-0.0001439185", openInterest: "1424.92", prevDayPx: "374.43", dayNtlVlm: "73392.2648", premium: "-0.0031562336", oraclePx: "361.19", markPx: "361.19", midPx: "360.22", impactPxs: ["358.69", "361.41"], dayBaseVlm: "197.28" },
      { funding: "0.0", openInterest: "0.0", prevDayPx: "2000.0", dayNtlVlm: "0.0", premium: null, oraclePx: "2000.0", markPx: "2000.0", midPx: null, impactPxs: null, dayBaseVlm: "0.0" },
    ],
  ],
  flx: [{ universe: [{ name: "flx:TSLA", szDecimals: 2, maxLeverage: 10, isDelisted: true }], marginTables: [], collateralToken: 360 }, [{ funding: "0.0", openInterest: "0.0", prevDayPx: "395.5", dayNtlVlm: "0.0", premium: null, oraclePx: "400.53", markPx: "395.5", midPx: null, impactPxs: null, dayBaseVlm: "0.0" }]],
  // made up: a company's market nobody holds or trades, and one Hyperliquid files under stocks
  mkts: [
    { universe: [{ name: "mkts:POLYMARKET", szDecimals: 2, maxLeverage: 3 }, { name: "mkts:KALSHI", szDecimals: 2, maxLeverage: 3 }], marginTables: [], collateralToken: 0 },
    [
      { funding: "0.0", openInterest: "0.0", prevDayPx: "9.0", dayNtlVlm: "0.0", premium: null, oraclePx: "9.0", markPx: "9.0", midPx: null, impactPxs: null, dayBaseVlm: "0.0" },
      { funding: "0.00001", openInterest: "120.5", prevDayPx: "11.0", dayNtlVlm: "50000.0", premium: "0.0", oraclePx: "11.2", markPx: "11.2", midPx: "11.2", impactPxs: ["11.1", "11.3"], dayBaseVlm: "4500.0" },
    ],
  ],
};
/** POST /info candleSnapshot {coin: "io:ANTH", interval: "1h"}: two of that day's bars */
export const HL_BARS = [
  { t: 1791460800000, T: 1791464399999, s: "io:ANTH", i: "1h", o: "2102.0", c: "2108.5", h: "2109.3", l: "2101.4", v: "126.631", n: 2587 },
  { t: 1791464400000, T: 1791467999999, s: "io:ANTH", i: "1h", o: "2108.6", c: "2112.9", h: "2113.6", l: "2106.0", v: "145.573", n: 3493 },
];

/** a stand-in Hyperliquid: answers each POST by its body, records every one; `fail` answers a body type (or `dex:<name>`) with a refusal */
export function hip3Net(fail: Record<string, HttpReply> = {}) {
  const sent: Array<{ url: string; method: string; body: Rec }> = [];
  const http: Http = async (url, init = {}) => {
    const body = JSON.parse(init.body ?? "{}") as Rec;
    sent.push({ url, method: init.method ?? "GET", body });
    const type = String(body.type);
    const failed = fail[type] ?? (type === "metaAndAssetCtxs" ? fail[`dex:${String(body.dex)}`] : undefined);
    if (failed) return failed;
    if (type === "perpDexs") return json(HL_DEXES);
    if (type === "perpCategories") return json(HL_CATEGORIES);
    if (type === "metaAndAssetCtxs") return HL_META[String(body.dex)] ? json(HL_META[String(body.dex)]) : { status: 500, body: null, text: "null" };
    if (type === "candleSnapshot") return json(HL_BARS);
    return { status: 422, body: undefined, text: "Failed to deserialize the JSON body" };
  };
  const asked = (type: string) => sent.filter((s) => s.body.type === type).map((s) => (s.body.dex === undefined ? type : String(s.body.dex)));
  return { http, sent, asked };
}

