import { describe, expect, it } from "vitest";
import { isRefusal } from "../../src/core/errors.ts";
import type { ExchangeClient, OpenExchange } from "../../src/portfolio/live/exchange.ts";
import { no } from "../../src/portfolio/refuse.ts";
import { KALSHI_SERIES } from "../../src/portfolio/live/categories.ts";
import { PRE_IPO_ISSUERS, PRE_IPO_NAMES } from "../../src/portfolio/live/preipo.ts";
import { exchangeTickers, fixedHosts, holdBackMs, hyperliquidPublic, kalshiPublic, KEEP_MS, LIST_MS, polymarketPublic, PRE_IPO_VENUES, preIpoPublic, publicSources, stockTokensPublic, type Listing } from "../../src/portfolio/live/public-markets.ts";
import { STOCK_TOKEN_ISSUER, STOCK_TOKEN_TERMS } from "../../src/portfolio/live/robinhood.ts";
import type { Candle } from "../../src/portfolio/live/trade.ts";
import type { Http, HttpReply } from "../../src/portfolio/live/types.ts";

/** Public market data, read without a key, against stand-ins: a stand-in exchange library whose tickers carry each exchange's own raw
 * answer (`info`) in the shapes the library's parsers document, and a stand-in network answering Kalshi, Polymarket's Gamma and Robinhood's
 * /rhj/ in the shapes their docs and their live public answers showed on 2026-10-05 and 2026-10-06. Every request is recorded; nothing
 * leaves the process, and no key is used anywhere. */

const NOW = Date.parse("2026-10-05T14:00:00.000Z");
const HOUR = 3_600_000;
const json = (body: unknown, status = 200): HttpReply => ({ status, body, text: JSON.stringify(body) });

type Rec = Record<string, unknown>;

/** a stand-in exchange library: one client with `markets`, answering fetchTickers from `tickers` (or throwing what `fail` says) */
function library(markets: Record<string, Rec>, tickers: Record<string, Rec>, o: { fail?: Error } = {}) {
  const calls: string[] = [];
  const opened: string[] = [];
  const client: ExchangeClient = {
    id: "x",
    markets,
    async loadMarkets(reload?: boolean) {
      calls.push(`loadMarkets${reload ? ":reload" : ""}`);
      if (o.fail) throw o.fail;
      return markets;
    },
    async fetchBalance() {
      throw new Error("a public source never reads a balance");
    },
    async fetchTickers(symbols?: string[]) {
      calls.push(`fetchTickers:${(symbols ?? []).join(",")}`);
      return Object.fromEntries((symbols ?? []).filter((s) => tickers[s]).map((s) => [s, tickers[s]!])) as Record<string, { last?: number }>;
    },
  };
  const open: OpenExchange = async (id, key) => {
    opened.push(`${id}:${JSON.stringify(key)}`);
    return { ...client, id };
  };
  return { open, calls, opened };
}
const spot = (base: string, quote: string, extra: Rec = {}): Rec => ({ symbol: `${base}/${quote}`, base, quote, spot: true, active: true, ...extra });

/** a stand-in network: answers by URL from `routes` (the first whose key the URL contains), records every request */
function network(routes: Array<[string, HttpReply | ((url: string) => HttpReply)]>) {
  const sent: Array<{ url: string; method: string; headers: Record<string, string>; timeoutMs?: number | undefined }> = [];
  const http: Http = async (url, init = {}) => {
    sent.push({ url, method: init.method ?? "GET", headers: init.headers ?? {}, timeoutMs: init.timeoutMs });
    const hit = routes.find(([k]) => url.includes(k));
    if (!hit) return json({ error: "not found" }, 404);
    return typeof hit[1] === "function" ? hit[1](url) : hit[1];
  };
  return { http, sent };
}
const query = (url: string): Record<string, string> => Object.fromEntries(new URL(url).searchParams.entries());

describe("exchanges, keyless, through the unified library", () => {
  it("keeps Kraken's last trade and its 24-hour dollar volume, and shows no 24-hour change: Kraken's o is today's open", async () => {
    const lib = library(
      { "BTC/USD": spot("BTC", "USD"), "BTC/USDT": spot("BTC", "USDT"), "ETH/USD": spot("ETH", "USD"), "ETH/BTC": spot("ETH", "BTC") },
      {
        // the library's own `percentage` (worked out from today's open) is there, and is not used
        "BTC/USD": { last: 100_000, percentage: 4.2, info: { a: ["100010.0", "1", "1.000"], b: ["99990.0", "2", "2.000"], c: ["100000.0", "0.01"], v: ["800.5", "1500.25"], p: ["99000.0", "98000.0"], o: "96000.0" } },
        "BTC/USDT": { last: 100_005, info: { a: ["100015.0"], b: ["99995.0"], c: ["100005.0", "0.1"], v: ["10", "20"], p: ["99000", "98500"], o: "96100" } },
        "ETH/USD": { last: 3_000, info: { a: ["3000.5"], b: ["2999.5"], c: ["3000.0"], v: ["100", "200"], p: ["2900", "2950"], o: "2800" } },
      },
    );
    const kraken = exchangeTickers("kraken", { open: lib.open, clock: () => NOW });
    const got = (await kraken.listings({ limit: 10 })) as Listing[];
    expect(lib.opened).toEqual(['kraken:{"apiKey":"","secret":""}']);
    expect(lib.calls).toEqual(["loadMarkets", "fetchTickers:BTC/USD,BTC/USDT,ETH/USD"]);
    expect(got[0]).toEqual({ symbol: "BTC/USD", name: "BTC / USD", kind: "spot", base: "BTC", quote: "USD", price: 100_000, bid: 99_990, ask: 100_010, open: true, types: [], volumeUsd24h: 1500.25 * 98_000 });
    expect(got.every((m) => m.changePct24h === undefined && m.change24h === undefined)).toBe(true);
    expect(kraken).toMatchObject({ id: "kraken", name: "Kraken", kind: "exchange", connectTo: "kraken", connector: "live:exchange:kraken" });
  });

  it("reads each exchange's own 24-hour fields: OKX against its open24h, Coinbase's own percent and approximate volume, Binance's as given", async () => {
    const okx = library({ "SOL/USDT": spot("SOL", "USDT") }, { "SOL/USDT": { last: 105, percentage: 99, info: { instType: "SPOT", instId: "SOL-USDT", last: "105", bidPx: "104.9", askPx: "105.1", open24h: "100", volCcy24h: "12345678.9", vol24h: "117000", sodUtc0: "101" } } });
    expect(await exchangeTickers("okx", { open: okx.open }).listings({ limit: 5 })).toEqual([{ symbol: "SOL/USDT", name: "SOL / USDT", kind: "spot", base: "SOL", quote: "USDT", price: 105, bid: 104.9, ask: 105.1, open: true, types: [], changePct24h: 5, change24h: 5, volumeUsd24h: 12345678.9 }]);

    const cb = library({ "ETH/USD": spot("ETH", "USD"), "BTC/USD": spot("BTC", "USD") }, { "ETH/USD": { last: 3000, info: { product_id: "ETH-USD", price: "3000", price_percentage_change_24h: "-1.25", volume_24h: "87329.9", approximate_quote_24h_volume: "261989700.5", trading_disabled: false } }, "BTC/USD": { last: 1, info: { product_id: "BTC-USD", price: "100000", price_percentage_change_24h: "0.5", approximate_quote_24h_volume: "1000", trading_disabled: true } } });
    const coinbase = (await exchangeTickers("coinbase", { open: cb.open }).listings({ limit: 5 })) as Listing[];
    expect(coinbase.find((m) => m.symbol === "ETH/USD")).toEqual({ symbol: "ETH/USD", name: "ETH / USD", kind: "spot", base: "ETH", quote: "USD", price: 3000, open: true, types: [], changePct24h: -1.25, volumeUsd24h: 261989700.5 });
    expect(coinbase.find((m) => m.symbol === "BTC/USD")).toMatchObject({ price: 100_000, open: false });

    const bn = library({ "BNB/USDT": spot("BNB", "USDT") }, { "BNB/USDT": { last: 600, info: { symbol: "BNBUSDT", lastPrice: "600.5", bidPrice: "600.4", askPrice: "600.6", priceChange: "-12.3", priceChangePercent: "-2.007", quoteVolume: "450000000.12" } } });
    expect(await exchangeTickers("binance", { open: bn.open }).listings({ limit: 5 })).toEqual([{ symbol: "BNB/USDT", name: "BNB / USDT", kind: "spot", base: "BNB", quote: "USDT", price: 600.5, bid: 600.4, ask: 600.6, open: true, types: [], changePct24h: -2.007, change24h: -12.3, volumeUsd24h: 450000000.12 }]);
  });

  it("asks for the coins a query names in dollars, spot only, the exact name first", async () => {
    const lib = library({ "PENGU/USDT": spot("PENGU", "USDT"), "PENGU/USD": spot("PENGU", "USD"), "PENGU/BTC": spot("PENGU", "BTC"), "PENGU/USDT:USDT": { symbol: "PENGU/USDT:USDT", base: "PENGU", quote: "USDT", spot: false, active: true }, "PENDLE/USDT": spot("PENDLE", "USDT"), "PEN/USDT": spot("PEN", "USDT", { active: false }) }, {});
    await exchangeTickers("okx", { open: lib.open }).listings({ q: "pen", limit: 5 });
    expect(lib.calls.at(-1)).toBe("fetchTickers:PENGU/USD,PENGU/USDT,PENDLE/USDT");
  });

  it("passes Binance's 451 and Bybit's 403 on as the venue's own rule, with the exchange's whole sentence, and loads the markets afresh the next time", async () => {
    // Binance's words run past the 240 characters the account keeps of what an exchange said: its sentence stays whole all the same
    const said451 = `binance GET https://api.binance.com/api/v3/exchangeInfo 451  {"code":0,"msg":"Service unavailable from a restricted location according to 'b. Eligibility' in https://www.binance.com/en/terms. Please contact customer service if you believe you received this message in error."}`;
    const bn = library({}, {}, { fail: Object.assign(new Error(said451), { name: "ExchangeNotAvailable" }) });
    const binance = exchangeTickers("binance", { open: bn.open });
    const r = await binance.listings({ limit: 5 });
    expect(isRefusal(r) && r).toMatchObject({ code: "E_VENUE_GEOBLOCKED", venue: "binance", message: "Binance does not serve this location: that is its own rule, and the account does not look for a way around it", native: { error: "ExchangeNotAvailable", said: expect.stringContaining("Please contact customer service if you believe you received this message in error.") } });
    // a geoblock is held ten minutes: the exchange is not asked again on the next poll
    await binance.listings({ limit: 5 });
    expect(bn.calls).toEqual(["loadMarkets"]);

    const by = library({}, {}, { fail: Object.assign(new Error("bybit GET https://api.bybit.com/v5/market/instruments-info 403 Forbidden The Amazon CloudFront distribution is configured to block access from your country."), { name: "ExchangeNotAvailable" }) });
    expect(await exchangeTickers("bybit", { open: by.open }).listings({ limit: 5 })).toMatchObject({ code: "E_VENUE_GEOBLOCKED", message: expect.stringMatching(/^Bybit does not serve this location/) });
  });

  it("keeps an answer ninety seconds, and gives stats by symbol from the same tickers", async () => {
    let now = NOW;
    const lib = library({ "BTC/USDT": spot("BTC", "USDT") }, { "BTC/USDT": { info: { last: "100", open24h: "90", volCcy24h: "5" } } });
    const okx = exchangeTickers("okx", { open: lib.open, clock: () => now });
    await okx.listings({ limit: 5 });
    await okx.listings({ limit: 5 });
    now += KEEP_MS - 1_000;
    await okx.listings({ limit: 5 });
    expect(lib.calls.filter((c) => c.startsWith("fetchTickers"))).toHaveLength(1);
    now += 2_000;
    await okx.listings({ limit: 5 });
    expect(lib.calls.filter((c) => c.startsWith("fetchTickers"))).toHaveLength(2);
    const stats = await okx.stats!(["BTC/USDT", "NOPE/USDT"]);
    expect(stats instanceof Map && stats.get("BTC/USDT")).toEqual({ price: 100, changePct24h: 11.1111, change24h: 10, volumeUsd24h: 5 });
    expect(lib.calls.at(-1)).toBe("fetchTickers:BTC/USDT");
  });

  it("asks for the coin before a slash, the pair written whole first (BTC/USD finds BTC); a stablecoin is no coin, so usdg finds USDGO", async () => {
    const lib = library({ "BTC/USD": spot("BTC", "USD"), "BTC/USDT": spot("BTC", "USDT"), "BTCDOM/USDT": spot("BTCDOM", "USDT"), "USDG/USD": spot("USDG", "USD"), "USDGO/USD": spot("USDGO", "USD") }, {});
    const kraken = exchangeTickers("kraken", { open: lib.open });
    await kraken.listings({ q: "BTC/USD", limit: 5 });
    expect(lib.calls.at(-1)).toBe("fetchTickers:BTC/USD,BTC/USDT,BTCDOM/USDT");
    await kraken.listings({ q: "usdg", limit: 5 });
    expect(lib.calls.at(-1)).toBe("fetchTickers:USDGO/USD");
  });
});

describe("a refusal held back", () => {
  it("is kept ten minutes when the venue does not serve this location, twenty seconds when it is rate-limiting or not answering, and not at all otherwise", () => {
    expect(holdBackMs(no("E_VENUE_GEOBLOCKED", { message: "not here" }))).toBe(600_000);
    expect(holdBackMs(no("E_VENUE_UNREACHABLE", { message: "no answer" }))).toBe(20_000);
    expect(holdBackMs(no("E_VENUE_REJECTED", { message: "too many", native: { status: 429 } }))).toBe(20_000);
    expect(holdBackMs(no("E_VENUE_REJECTED", { message: "bad request", native: { status: 400 } }))).toBe(0);
    expect(holdBackMs(no("E_ACCOUNT_BAD_ACTION", { message: "no such interval" }))).toBe(0);
  });
});

describe("the fixed hosts", () => {
  it("asks only a GET over https of a fixed host, with the time limit", async () => {
    const net = network([["", json({ ok: true })]]);
    const get = fixedHosts(net.http, ["gamma-api.polymarket.com"], 5_000);
    await get("https://gamma-api.polymarket.com/events?limit=1", { timeoutMs: 60_000 });
    expect(net.sent).toEqual([{ url: "https://gamma-api.polymarket.com/events?limit=1", method: "GET", headers: { accept: "application/json" }, timeoutMs: 5_000 }]);
    for (const bad of ["http://gamma-api.polymarket.com/events", "https://evil.example/events", "https://gamma-api.polymarket.com:8443/events", "https://user:pw@gamma-api.polymarket.com/events", "not a url"]) await expect(get(bad)).rejects.toThrow(/not asked/);
    await expect(get("https://gamma-api.polymarket.com/events", { method: "POST", body: "{}" })).rejects.toThrow(/not asked/);
    expect(net.sent).toHaveLength(1);
  });
});

const MARKET = (o: Rec): Rec => ({
  ticker: "KXFED-27APR-T4.00",
  event_ticker: "KXFED-27APR",
  market_type: "binary",
  title: "Will the upper bound of the federal funds rate be above 4.00% following the Fed's Apr 28, 2027 meeting?",
  yes_sub_title: "Above 4.00%",
  status: "active",
  yes_bid_dollars: "0.4200",
  yes_ask_dollars: "0.4500",
  no_bid_dollars: "0.5500",
  no_ask_dollars: "0.5800",
  last_price_dollars: "0.4300",
  previous_price_dollars: "0.4000",
  notional_value_dollars: "1.0000",
  close_time: "2027-04-28T17:55:00Z",
  volume_24h_fp: "5120.00",
  volume_fp: "91000.00",
  ...o,
});

/** a Kalshi event as GET /events?with_nested_markets=true answers it (2026-10-06): the event's title and category, its markets nested */
const EVENT = (ticker: string, title: string, category: string, markets: Rec[]): Rec => ({ event_ticker: ticker, series_ticker: ticker.split("-")[0], title, category, mutually_exclusive: true, markets });

describe("Kalshi, keyless", () => {
  /** the network answering each series' open events: by series ticker; a series not named answers with no event at all, as Kalshi does
   * for a series it does not know */
  const seriesNet = (bySeries: Record<string, Rec[]>) => network([["/trade-api/v2/events?", (url) => json({ events: bySeries[query(url).series_ticker ?? ""] ?? [], cursor: "" })]]);
  // the Fed's October meeting, 151,859 contracts on "Fed maintains rate" (live 2026-10-06), and its January one, 83
  const fedOct = EVENT("KXFEDDECISION-26OCT", "Fed decision in Oct 2026?", "Economics", [
    MARKET({ ticker: "KXFEDDECISION-26OCT-H0", event_ticker: "KXFEDDECISION-26OCT", title: "Will the Federal Reserve Hike rates by 0bps at their October 2026 meeting?", yes_sub_title: "Fed maintains rate", volume_24h_fp: "151859.00", volume_fp: "2000000.00", close_time: "2026-10-28T17:59:00Z", last_price_dollars: "0.8300", previous_price_dollars: "0.8000", yes_bid_dollars: "0.8200", yes_ask_dollars: "0.8300", no_bid_dollars: "0.1700", no_ask_dollars: "0.1800" }),
    MARKET({ ticker: "KXFEDDECISION-26OCT-C25", event_ticker: "KXFEDDECISION-26OCT", title: "Will the Federal Reserve Cut rates by 25bps at their October 2026 meeting?", yes_sub_title: "Cut 25bps", volume_24h_fp: "60000.00", close_time: "2026-10-28T17:59:00Z" }),
  ]);
  const fedJan = EVENT("KXFEDDECISION-27JAN", "Fed decision in Jan 2027?", "Economics", [MARKET({ ticker: "KXFEDDECISION-27JAN-H0", event_ticker: "KXFEDDECISION-27JAN", title: "Will the Federal Reserve Hike rates by 0bps at their January 2027 meeting?", yes_sub_title: "Fed maintains rate", volume_24h_fp: "83.00", close_time: "2027-01-27T18:59:00Z" })]);
  // GDP: Kalshi writes markdown into the title, and lists a far release in which nothing traded
  const gdp = EVENT("KXGDP-26OCT30", "US real GDP growth in Q3 2026?", "Economics", [MARKET({ ticker: "KXGDP-26OCT30-T3.5", event_ticker: "KXGDP-26OCT30", title: "Will **real GDP** increase by more than 3.5% in Q3 2026?", yes_sub_title: "Above 3.5%", volume_24h_fp: "260.00", close_time: "2026-10-30T12:29:00Z" })]);
  const gdpFar = EVENT("KXGDP-27JAN28", "US real GDP growth in Q4 2026?", "Economics", [MARKET({ ticker: "KXGDP-27JAN28-T0.0", event_ticker: "KXGDP-27JAN28", title: "Will **real GDP** increase by more than 0.0% in Q4 2026?", yes_sub_title: "Above 0.0%", volume_24h_fp: "0.00", volume_fp: "0.00", close_time: "2027-01-28T13:29:00Z" })]);
  // the bitcoin ladder: one event, many strikes; the busiest strike is the row
  const btc = EVENT("KXBTCD-26OCT0617", "BTC price on Oct 6, 2026 at 5pm EDT?", "Crypto", [
    MARKET({ ticker: "KXBTCD-26OCT0617-T85499.99", event_ticker: "KXBTCD-26OCT0617", title: "Bitcoin price on Oct 6, 2026?", yes_sub_title: "$85,500 or above", volume_24h_fp: "90000.00", close_time: "2026-10-06T13:00:00Z" }),
    MARKET({ ticker: "KXBTCD-26OCT0617-T85999.99", event_ticker: "KXBTCD-26OCT0617", title: "Bitcoin price on Oct 6, 2026?", yes_sub_title: "$86,000 or above", volume_24h_fp: "199396.00", close_time: "2026-10-06T13:00:00Z" }),
    MARKET({ ticker: "KXBTCD-26OCT0617-T99999.99", event_ticker: "KXBTCD-26OCT0617", status: "determined", volume_24h_fp: "999999.00", close_time: "2026-10-06T13:00:00Z" }),
  ]);

  it("reads a few busy series — each one's nearest open events with their markets, never the newest thousand markets — and shows each series' busiest market, busiest first, with Kalshi's close time, change, contracts, event and category, and without Kalshi's markdown", async () => {
    const net = seriesNet({ KXFEDDECISION: [fedOct, fedJan], KXGDP: [gdpFar, gdp], KXBTCD: [btc] });
    const k = kalshiPublic({ http: net.http, clock: () => NOW });
    const got = (await k.listings({ limit: 10 })) as Listing[];
    // one small request a series, every one GET /events for that series' open events with the markets nested; GET /markets is never asked
    expect(net.sent).toHaveLength(KALSHI_SERIES.length);
    expect(net.sent.every((s) => new URL(s.url).host === "external-api.kalshi.com" && new URL(s.url).pathname === "/trade-api/v2/events")).toBe(true);
    expect(net.sent.map((s) => query(s.url).series_ticker)).toEqual(KALSHI_SERIES.map((s) => s.ticker));
    expect(query(net.sent[0]!.url)).toEqual({ series_ticker: "KXFEDDECISION", status: "open", with_nested_markets: "true", limit: "6" });
    // one market a series: bitcoin's $86,000 strike (not the settled one), the Fed's "maintains" (not January's), GDP's nearest release (the far one traded nothing)
    expect(got.filter((m) => m.outcome === "YES").map((m) => m.symbol)).toEqual(["KXBTCD-26OCT0617-T85999.99:YES", "KXFEDDECISION-26OCT-H0:YES", "KXGDP-26OCT30-T3.5:YES"]);
    const title = "Will the Federal Reserve Hike rates by 0bps at their October 2026 meeting? (Fed maintains rate)";
    expect(got[2]).toEqual({ symbol: "KXFEDDECISION-26OCT-H0:YES", name: `${title} · Yes`, kind: "event", base: "KXFEDDECISION-26OCT-H0:YES", quote: "USD", price: 0.83, bid: 0.82, ask: 0.83, open: true, types: [], group: { id: "KXFEDDECISION-26OCT-H0", title }, outcome: "YES", closeTime: "2026-10-28T17:59:00Z", category: "Economics", tags: ["Economics"], change24h: 0.03, contracts24h: 151859, event: { id: "KXFEDDECISION-26OCT", title: "Fed decision in Oct 2026?" } });
    expect(got[3]).toMatchObject({ symbol: "KXFEDDECISION-26OCT-H0:NO", price: 0.17, bid: 0.17, ask: 0.18, outcome: "NO", change24h: -0.03, contracts24h: 151859 });
    // the stars Kalshi writes into a title are not words
    expect(got[4]?.name).toBe("Will real GDP increase by more than 3.5% in Q3 2026? (Above 3.5%) · Yes");
    expect(got[0]?.event).toEqual({ id: "KXBTCD-26OCT0617", title: "BTC price on Oct 6, 2026 at 5pm EDT?" });
    expect(got[0]?.category).toBe("Crypto");
    // contracts are never dollars
    expect(got.every((m) => m.volumeUsd24h === undefined)).toBe(true);
    expect(k).toMatchObject({ id: "kalshi", kind: "events", connectTo: "kalshi", connector: "live:kalshi" });
    // what the list is made of, in a sentence under the list for the finance series and one for the IPO series, each under 160 characters
    const plain = KALSHI_SERIES.filter((s) => !s.tags?.length);
    expect(k.notes!({})).toEqual([`Kalshi: the busiest market in each of ${plain.length} series — ${plain.map((s) => s.word).join(", ")}.`, "Kalshi: and Anthropic IPO, OpenAI IPO — the busiest market of each."]);
    expect(k.notes!({}).every((n) => n.length < 160)).toBe(true);
    // the bodies are kept: a second listing asks nothing
    await k.listings({ limit: 10 });
    expect(net.sent).toHaveLength(KALSHI_SERIES.length);
  });

  it("a search reaches every market of every event read, not only the ones shown, and asks nothing more", async () => {
    const net = seriesNet({ KXFEDDECISION: [fedOct, fedJan], KXGDP: [gdp] });
    const k = kalshiPublic({ http: net.http, clock: () => NOW });
    expect(((await k.listings({ q: "january", limit: 10 })) as Listing[]).map((m) => m.symbol)).toEqual(["KXFEDDECISION-27JAN-H0:YES", "KXFEDDECISION-27JAN-H0:NO"]);
    expect(((await k.listings({ q: "cut", limit: 10 })) as Listing[]).map((m) => m.symbol)).toEqual(["KXFEDDECISION-26OCT-C25:YES", "KXFEDDECISION-26OCT-C25:NO"]);
    expect(((await k.listings({ q: "fed", limit: 10 })) as Listing[]).filter((m) => m.outcome === "YES").map((m) => m.symbol)).toEqual(["KXFEDDECISION-26OCT-H0:YES", "KXFEDDECISION-26OCT-C25:YES", "KXFEDDECISION-27JAN-H0:YES"]);
    expect(await k.listings({ q: "falcons", limit: 10 })).toEqual([]);
    expect(net.sent).toHaveLength(KALSHI_SERIES.length);
  });

  it("what closes within the window, and one category, are drawn from the same list: no request beyond the series'", async () => {
    const net = seriesNet({ KXFEDDECISION: [fedOct], KXBTCD: [btc], KXGDP: [gdp] });
    const k = kalshiPublic({ http: net.http, clock: () => NOW });
    const soon = (await k.events!({ closingWithinMs: 24 * HOUR, limit: 5 })) as Listing[];
    expect(soon.map((m) => m.symbol)).toEqual(["KXBTCD-26OCT0617-T85999.99:YES", "KXBTCD-26OCT0617-T85999.99:NO"]);
    const economics = (await k.events!({ category: "economics", limit: 5 })) as Listing[];
    expect(economics.filter((m) => m.outcome === "YES").map((m) => m.symbol)).toEqual(["KXFEDDECISION-26OCT-H0:YES", "KXGDP-26OCT30-T3.5:YES"]);
    expect(net.sent).toHaveLength(KALSHI_SERIES.length);
  });

  it("refuses in Kalshi's terms only when every series does; a 451 is held ten minutes and a 429 twenty seconds before Kalshi is asked again", async () => {
    let now = NOW;
    const blocked = network([["/trade-api/v2/events?", { status: 451, body: undefined, text: "unavailable" }]]);
    const k = kalshiPublic({ http: blocked.http, clock: () => now });
    expect(await k.listings({ limit: 5 })).toMatchObject({ code: "E_VENUE_GEOBLOCKED" });
    now += 9 * 60_000;
    await k.listings({ limit: 5 });
    expect(blocked.sent).toHaveLength(KALSHI_SERIES.length);
    now += 2 * 60_000;
    await k.listings({ limit: 5 });
    expect(blocked.sent).toHaveLength(2 * KALSHI_SERIES.length);
    let t = NOW;
    const busy = network([["/trade-api/v2/events?", { status: 429, body: undefined, text: "too many requests" }]]);
    const k2 = kalshiPublic({ http: busy.http, clock: () => t });
    expect(await k2.listings({ limit: 5 })).toMatchObject({ code: "E_VENUE_UNREACHABLE", message: "Kalshi is rate-limiting this machine: try again in a minute", native: { status: 429, said: "too many requests" } });
    t += 19_000;
    await k2.listings({ limit: 5 });
    expect(busy.sent).toHaveLength(KALSHI_SERIES.length);
    t += 2_000;
    await k2.listings({ limit: 5 });
    expect(busy.sent).toHaveLength(2 * KALSHI_SERIES.length);
    // one series failing while the others answer: the others are shown
    const half = network([
      ["series_ticker=KXGDP", { status: 500, body: undefined, text: "boom" }],
      ["/trade-api/v2/events?", (url) => json({ events: query(url).series_ticker === "KXFEDDECISION" ? [fedOct] : [], cursor: "" })],
    ]);
    expect(((await kalshiPublic({ http: half.http, clock: () => NOW }).listings({ limit: 5 })) as Listing[]).map((m) => m.symbol)).toEqual(["KXFEDDECISION-26OCT-H0:YES", "KXFEDDECISION-26OCT-H0:NO"]);
    // every series open but empty: nothing, not a refusal
    expect(await kalshiPublic({ http: seriesNet({}).http, clock: () => NOW }).listings({ limit: 5 })).toEqual([]);
  });

  it("the IPO series' legs carry Kalshi's own series tags beside the event's category and read its word IPOs; a series without tags keeps the event's word", async () => {
    // KXIPOANTHROPIC's open event as Kalshi answered it on 2026-10-06: category Companies, the series itself tagged IPOs and Companies
    const ipo = EVENT("KXIPOANTHROPIC-DATE", "When will Anthropic officially announce an IPO?", "Companies", [
      MARKET({ ticker: "KXIPOANTHROPIC-DATE-26DEC01", event_ticker: "KXIPOANTHROPIC-DATE", title: "When will Anthropic officially announce an IPO?", yes_sub_title: "Dec 1, 2026", volume_24h_fp: "4227.37", close_time: "2026-12-01T04:59:00Z", last_price_dollars: "0.6700", previous_price_dollars: "0.6500", yes_bid_dollars: "0.6500", yes_ask_dollars: "0.6700", no_bid_dollars: "0.3300", no_ask_dollars: "0.3500" }),
      MARKET({ ticker: "KXIPOANTHROPIC-DATE-26NOV01", event_ticker: "KXIPOANTHROPIC-DATE", title: "When will Anthropic officially announce an IPO?", yes_sub_title: "Nov 1, 2026", volume_24h_fp: "2294.71", close_time: "2026-11-01T04:59:00Z" }),
    ]);
    const net = seriesNet({ KXIPOANTHROPIC: [ipo], KXFEDDECISION: [fedOct] });
    const got = (await kalshiPublic({ http: net.http, clock: () => NOW }).listings({ limit: 10 })) as Listing[];
    expect(KALSHI_SERIES.find((s) => s.ticker === "KXIPOANTHROPIC")).toEqual({ ticker: "KXIPOANTHROPIC", word: "Anthropic IPO", tags: ["IPOs", "Companies"] });
    expect(got.find((m) => m.symbol === "KXIPOANTHROPIC-DATE-26DEC01:YES")).toMatchObject({ category: "IPOs", tags: ["Companies", "IPOs"], contracts24h: 4227.37, event: { id: "KXIPOANTHROPIC-DATE", title: "When will Anthropic officially announce an IPO?" } });
    expect(got.find((m) => m.symbol === "KXFEDDECISION-26OCT-H0:YES")).toMatchObject({ category: "Economics", tags: ["Economics"] });
  });
});

/** a Gamma event as /events answers it (2026-10-05): outcomes and prices as JSON strings, tags with labels and slugs */
const GAMMA_EVENT = (o: Rec = {}, markets: Rec[] = []): Rec => ({
  id: "909452",
  slug: "nfl-atl-no-2026-10-06",
  title: "Falcons vs. Saints",
  endDate: "2026-10-06T00:15:00Z",
  volume24hr: 8406690.2,
  tags: [
    { id: "100639", label: "Games", slug: "games" },
    { id: "1", label: "Sports", slug: "sports", forceHide: true },
    { id: "450", label: "NFL (All)", slug: "nfl" },
  ],
  markets,
  ...o,
});
const GAMMA_MARKET = (o: Rec = {}): Rec => ({
  id: "3871438",
  conditionId: `0x${"08".repeat(32)}`,
  slug: "nfl-atl-no-2026-10-06",
  question: "Falcons vs. Saints",
  outcomes: '["Falcons", "Saints"]',
  outcomePrices: '["0.915", "0.085"]',
  lastTradePrice: 0.92,
  bestBid: 0.91,
  bestAsk: 0.92,
  volume24hr: 4231519.99,
  oneDayPriceChange: 0.44,
  endDate: "2026-10-06T00:15:00Z",
  active: true,
  closed: false,
  acceptingOrders: true,
  enableOrderBook: true,
  version: "v1",
  ...o,
});

/** Gamma's events of 2026-10-06, as its live answer gave them: the Sports one (every sports and esports event carries the Sports tag),
 * Brazil (Politics), the Fed (Fed, fomc, Trump, Economy, Fed Rates, Recurring), Elon's tweets (Culture, Tweet Markets), an hourly bitcoin
 * up-or-down (1H) and the day's */
const tagged = (...labels: string[]): Rec[] => labels.map((label, i) => ({ id: String(1000 + i), label, slug: label.toLowerCase().replace(/[^a-z0-9]+/g, "-") }));
const SPORTS = GAMMA_EVENT({}, [GAMMA_MARKET()]);
const BRAZIL = GAMMA_EVENT({ id: "45915", slug: "brazil-presidential-election", title: "Brazil Presidential Election", endDate: "2026-10-05T03:59:00Z", volume24hr: 1_332_667, tags: tagged("Politics", "Macro Election 2", "Main Election") }, [
  GAMMA_MARKET({ conditionId: `0x${"ab".repeat(32)}`, slug: "lula-2026", question: "Will Lula win the 2026 Brazilian presidential election?", outcomes: '["Yes","No"]', outcomePrices: '["0.155","0.845"]', bestBid: 0.15, bestAsk: 0.16, oneDayPriceChange: -0.01, volume24hr: 749_955, endDate: "2026-10-05T03:59:00Z" }),
  GAMMA_MARKET({ conditionId: `0x${"ac".repeat(32)}`, slug: "bolsonaro-2026", question: "Will Bolsonaro win the 2026 Brazilian presidential election?", outcomes: '["Yes","No"]', outcomePrices: '["0.3","0.7"]', bestBid: 0.29, bestAsk: 0.31, volume24hr: 100_000, endDate: "2026-10-05T03:59:00Z" }),
]);
const FED = GAMMA_EVENT({ id: "1", slug: "fed-decision-in-october", title: "Fed Decision in October?", endDate: "2026-10-29T00:00:00Z", volume24hr: 880_418, tags: tagged("Fed", "fomc", "Trump", "Economy", "Fed Rates", "Recurring") }, [GAMMA_MARKET({ conditionId: `0x${"01".repeat(32)}`, slug: "fed-decreases-50", question: "Will the Fed decrease interest rates by 50+ bps after the October meeting?", outcomes: '["Yes","No"]', outcomePrices: '["0.02","0.98"]', bestBid: 0.01, bestAsk: 0.02, volume24hr: 254_692, endDate: "2026-10-29T00:00:00Z" })]);
const TWEETS = GAMMA_EVENT({ id: "7", slug: "elon-tweets", title: "Elon Musk # tweets September 29 - October 6, 2026?", volume24hr: 613_719, tags: tagged("Culture", "Politics", "Tweet Markets", "Recurring") }, [GAMMA_MARKET({ conditionId: `0x${"02".repeat(32)}`, slug: "elon-200-219", question: "Will Elon Musk post 200-219 tweets?", outcomes: '["Yes","No"]', outcomePrices: '["0.2","0.8"]', volume24hr: 206_938 })]);
const HOURLY = GAMMA_EVENT({ id: "8", slug: "btc-updown-1pm", title: "Bitcoin Up or Down - October 6, 1PM ET", volume24hr: 25_561, endDate: "2026-10-06T18:00:00Z", tags: tagged("Crypto", "Crypto Prices", "1H", "Up or Down") }, [GAMMA_MARKET({ conditionId: `0x${"03".repeat(32)}`, slug: "btc-updown-1pm", question: "Bitcoin Up or Down - October 6, 1PM ET", outcomes: '["Up","Down"]', outcomePrices: '["0.5","0.5"]', volume24hr: 25_561, endDate: "2026-10-06T18:00:00Z" })]);
const DAILY = GAMMA_EVENT({ id: "9", slug: "btc-updown-oct5", title: "Bitcoin Up or Down on October 5?", volume24hr: 1_199_135, endDate: "2026-10-05T16:00:00Z", tags: tagged("Crypto", "Crypto Prices", "Recurring", "Hide From New", "Bitcoin", "Up or Down", "Today 🚀", "Daily") }, [GAMMA_MARKET({ conditionId: `0x${"04".repeat(32)}`, slug: "bitcoin-up-or-down-on-october-5", question: "Bitcoin Up or Down on October 5?", outcomes: '["Up","Down"]', outcomePrices: '["0.7","0.3"]', bestBid: 0.69, bestAsk: 0.71, volume24hr: 1_199_135, endDate: "2026-10-05T16:00:00Z" })]);

describe("Polymarket, keyless, through Gamma", () => {
  it("asks Gamma for its twenty busiest events without sports, leaves out every event under an excluded word and the hourly up-or-downs, and shows the rest busiest first, each as its busiest market with the table's word for its category", async () => {
    const net = network([["gamma-api.polymarket.com/events?", json([SPORTS, BRAZIL, DAILY, FED, TWEETS, HOURLY])]]);
    const pm = polymarketPublic({ http: net.http, clock: () => NOW });
    const got = (await pm.listings({ limit: 10 })) as Listing[];
    expect(query(net.sent[0]!.url)).toEqual({ active: "true", closed: "false", archived: "false", order: "volume24hr", ascending: "false", limit: "20", exclude_tag_id: "1" });
    // and the IPO questions by their tag, five of them, in a second request of the same shape
    expect(query(net.sent[1]!.url)).toEqual({ active: "true", closed: "false", archived: "false", order: "volume24hr", ascending: "false", limit: "5", tag_slug: "ipo" });
    expect(net.sent).toHaveLength(2);
    // the hottest event first by the EVENT's volume (Brazil's 32 markets together, then the day's bitcoin up-or-down, then the Fed's five),
    // each as its busiest market (Lula, not Bolsonaro); nothing of sports, the tweets or the hourly
    expect(got.map((m) => m.symbol)).toEqual(["lula-2026:Yes", "lula-2026:No", "bitcoin-up-or-down-on-october-5:Up", "bitcoin-up-or-down-on-october-5:Down", "fed-decreases-50:Yes", "fed-decreases-50:No"]);
    expect(got[0]).toEqual({
      symbol: "lula-2026:Yes",
      name: "Will Lula win the 2026 Brazilian presidential election? · Yes",
      kind: "event",
      base: "Yes",
      quote: "pUSD",
      price: 0.155,
      bid: 0.15,
      ask: 0.16,
      open: true,
      types: [],
      group: { id: `0x${"ab".repeat(32)}`, title: "Will Lula win the 2026 Brazilian presidential election?" },
      outcome: "Yes",
      closeTime: "2026-10-05T03:59:00Z",
      category: "Politics",
      tags: ["Politics", "Macro Election 2", "Main Election", "politics", "macro-election-2", "main-election"],
      change24h: -0.01,
      volumeUsd24h: 749_955,
      eventVolumeUsd24h: 1_332_667,
      event: { id: "45915", title: "Brazil Presidential Election" },
    });
    // the second outcome carries only its own price: Gamma's book and change are the first's
    expect(got[1]).toMatchObject({ price: 0.845, bid: undefined, ask: undefined, volumeUsd24h: 749_955, eventVolumeUsd24h: 1_332_667 });
    expect(got[1]?.change24h).toBeUndefined();
    // the category is the table's word among the event's tags, never Gamma's plumbing: Fed Rates (not Fed, fomc or Recurring), Crypto (not Hide From New)
    expect(got[4]?.category).toBe("Fed Rates");
    expect(got[2]?.category).toBe("Crypto");
    expect(pm).toMatchObject({ id: "polymarket", kind: "events", connectTo: "polymarket", connector: "live:polymarket-trade" });
    expect(pm.notes!({})).toEqual(["Polymarket: its 10 busiest events by 24-hour volume, without sports, esports, weather, entertainment, awards and mentions.", "Polymarket: and its 3 busiest IPO questions (its tag IPO)."]);
    expect(pm.notes!({}).every((n) => n.length < 160)).toBe(true);
  });

  it("a search reaches every market of every event read (not the ones left out), and what closes within the window is read off the same list: the two requests in all", async () => {
    const net = network([["gamma-api.polymarket.com/events?", json([BRAZIL, FED, DAILY, SPORTS])]]);
    const pm = polymarketPublic({ http: net.http, clock: () => NOW });
    await pm.listings({ limit: 10 });
    expect(((await pm.listings({ q: "bolsonaro", limit: 10 })) as Listing[]).map((m) => m.symbol)).toEqual(["bolsonaro-2026:Yes", "bolsonaro-2026:No"]);
    expect(await pm.listings({ q: "falcons", limit: 10 })).toEqual([]);
    // the day's bitcoin market ends two hours from now; Brazil's end date has passed and the Fed's is weeks away
    expect(((await pm.events!({ closingWithinMs: 24 * HOUR, limit: 10 })) as Listing[]).map((m) => m.symbol)).toEqual(["bitcoin-up-or-down-on-october-5:Up", "bitcoin-up-or-down-on-october-5:Down"]);
    expect(((await pm.events!({ category: "politics", limit: 10 })) as Listing[]).map((m) => m.symbol)).toEqual(["lula-2026:Yes", "lula-2026:No"]);
    // the busiest and the IPO tag, each once; the same events in both answers are one event each
    expect(net.sent).toHaveLength(2);
    // a market Gamma says is closed is not shown, and an event with none open is not an event
    const closed = network([["gamma-api.polymarket.com/events?", json([GAMMA_EVENT({ id: "5", slug: "done", title: "Done?", volume24hr: 1e9, tags: tagged("Politics") }, [GAMMA_MARKET({ conditionId: `0x${"10".repeat(32)}`, slug: "done", closed: true, volume24hr: 1e9 })])])]]);
    expect(await polymarketPublic({ http: closed.http, clock: () => NOW }).listings({ limit: 5 })).toEqual([]);
  });

  /** Gamma's IPO events of 2026-10-06, trimmed: each tagged Finance, IPO, IPOs and the company; "Anthropic IPO by __?" $40,704 a day */
  const IPO_EVENT = (id: string, title: string, volume: number, slug: string, question: string, yes: string, condition: string): Rec =>
    GAMMA_EVENT({ id, slug, title, endDate: "2027-01-01T04:59:00Z", volume24hr: volume, tags: [...tagged("Finance", "IPO", "Anthropic IPO", "Anthropic", "IPOs", "Dario"), { id: "9", label: "rewards 100, 4.5, 100 Deprec", slug: "rewards-100-4-5-100-deprec" }] }, [GAMMA_MARKET({ conditionId: condition, slug: `${slug}-m`, question, outcomes: '["Yes", "No"]', outcomePrices: `["${yes}", "${(1 - Number(yes)).toFixed(2)}"]`, bestBid: 0.82, bestAsk: 0.84, volume24hr: Math.round(volume * 0.67), oneDayPriceChange: -0.005, endDate: "2027-01-01T04:59:00Z" })]);
  const IPO = [
    IPO_EVENT("549019", "Anthropic IPO by __?", 40_703.8, "anthropic-ipo-by", "Will Anthropic IPO by December 31, 2026?", "0.83", `0x${"b4".repeat(32)}`),
    IPO_EVENT("548858", "Anthropic IPO Closing Market Cap", 20_837.42, "anthropic-ipo-cap", "Will Anthropic's IPO closing market cap be above $2T?", "0.55", `0x${"b5".repeat(32)}`),
    IPO_EVENT("510690", "Oura IPO Closing Market Cap", 8_479.97, "oura-ipo-cap", "Will Oura's IPO closing market cap be above $50B?", "0.4", `0x${"b6".repeat(32)}`),
    IPO_EVENT("507875", "What will OpenAI's IPO valuation be?", 4_249.05, "openai-ipo-valuation", "Will OpenAI's IPO valuation be above $1.5T?", "0.6", `0x${"b7".repeat(32)}`),
    IPO_EVENT("197776", "Anthropic IPO Closing Market Cap (Lower Brackets)", 3_803.54, "anthropic-ipo-lower", "Will Anthropic's IPO closing market cap be below $1T?", "0.05", `0x${"b8".repeat(32)}`),
  ];

  it("reads its IPO questions by their tag and shows the three busiest beside the ten, each reading IPO; an event in both answers is one; a search reaches them all; the IPO read refusing leaves the busiest standing", async () => {
    const net = network([
      ["tag_slug=ipo", json([...IPO, FED])],
      ["exclude_tag_id=1", json([BRAZIL, FED, DAILY])],
    ]);
    const pm = polymarketPublic({ http: net.http, clock: () => NOW });
    const got = (await pm.listings({ limit: 20 })) as Listing[];
    // the busiest three (Brazil, the day's bitcoin, the Fed — the Fed once, though both answers carried it), then the three busiest IPO questions
    expect(got.filter((m) => m.outcome === "Yes" || m.outcome === "Up").map((m) => [m.symbol, m.category])).toEqual([
      ["lula-2026:Yes", "Politics"],
      ["bitcoin-up-or-down-on-october-5:Up", "Crypto"],
      ["fed-decreases-50:Yes", "Fed Rates"],
      ["anthropic-ipo-by-m:Yes", "IPO"],
      ["anthropic-ipo-cap-m:Yes", "IPO"],
      ["oura-ipo-cap-m:Yes", "IPO"],
    ]);
    expect(got.find((m) => m.symbol === "anthropic-ipo-by-m:Yes")).toMatchObject({ price: 0.83, bid: 0.82, ask: 0.84, volumeUsd24h: 27_272, eventVolumeUsd24h: 40_703.8, event: { id: "549019", title: "Anthropic IPO by __?" }, tags: expect.arrayContaining(["IPO", "IPOs", "Anthropic"]) });
    // the fourth and fifth IPO questions are read, not shown — until searched for
    expect(((await pm.listings({ q: "openai", limit: 10 })) as Listing[]).map((m) => m.symbol)).toEqual(["openai-ipo-valuation-m:Yes", "openai-ipo-valuation-m:No"]);
    expect(net.sent).toHaveLength(2);
    // the IPO read refusing: the ten stand, the IPO rows are simply not there this time
    const half = network([
      ["tag_slug=ipo", { status: 429, body: undefined, text: "too many requests" }],
      ["exclude_tag_id=1", json([BRAZIL, FED])],
    ]);
    expect(((await polymarketPublic({ http: half.http, clock: () => NOW }).listings({ limit: 20 })) as Listing[]).filter((m) => m.outcome === "Yes").map((m) => m.symbol)).toEqual(["lula-2026:Yes", "fed-decreases-50:Yes"]);
    // both refusing is Polymarket's refusal
    const none = network([["gamma-api.polymarket.com/events?", { status: 451, body: undefined, text: "unavailable" }]]);
    expect(await polymarketPublic({ http: none.http, clock: () => NOW }).listings({ limit: 5 })).toMatchObject({ code: "E_VENUE_GEOBLOCKED" });
  });
});

describe("Robinhood Stock Tokens, keyless, read-only", () => {
  const asset = (symbol: string, name: string, address: string): Rec => ({ id: `0x${symbol}`, tokenSymbol: symbol, tokenName: `${name} • Robinhood Token`, status: "ASSET_STATUS_ACTIVE", deployments: [{ contractAddress: address, chainId: 4663, networkName: "Robinhood Chain" }] });
  const quote = (symbol: string, o: Rec = {}): HttpReply => json({ quotes: [{ tokenSymbol: symbol, bid: "230.11", ask: "230.31", currency: "USD", isTradingHalt: false, tokenBid: "230.37", tokenAsk: "230.57", ...o }] });

  it("lists the well-known tokens first, each with its own bid and ask in dollars; the listing is never a place to trade, a connected wallet is", async () => {
    const net = network([
      ["/rhj/assets", json({ assets: [asset("CRM", "Salesforce", "0xd95B44124e475743a7589e68F3D74008A5536D44"), asset("AAPL", "Apple", "0x1111111111111111111111111111111111111111"), asset("HALT", "Halted Co", "0x2222222222222222222222222222222222222222")] })],
      ["/rhj/prices/CRM", quote("CRM")],
      ["/rhj/prices/AAPL", quote("AAPL", { tokenBid: "250", tokenAsk: "251" })],
      ["/rhj/prices/HALT", quote("HALT", { isTradingHalt: true })],
    ]);
    const tokens = stockTokensPublic({ http: net.http, clock: () => NOW });
    const got = (await tokens.listings({ limit: 2 })) as Listing[];
    // each with its issuer and whom the issuer says the tokens are not for, in the issuer's own words
    const issued = { issuer: STOCK_TOKEN_ISSUER, eligibility: STOCK_TOKEN_TERMS };
    expect(got).toEqual([
      { symbol: "AAPL", name: "Apple • Robinhood Token", kind: "token", base: "AAPL", quote: "USD", price: 250.5, bid: 250, ask: 251, open: true, types: [], ...issued },
      { symbol: "CRM", name: "Salesforce • Robinhood Token", kind: "token", base: "CRM", quote: "USD", price: 230.47, bid: 230.37, ask: 230.57, open: true, types: [], ...issued },
    ]);
    expect(net.sent.every((s) => new URL(s.url).host === "api.robinhood.com" && s.method === "GET")).toBe(true);
    expect(tokens).toMatchObject({ kind: "tokens", connectTo: "robinhood-wallet", connector: "live:wallet", readOnly: expect.stringContaining("trades from a connected wallet on Robinhood Chain, against USDG") });
    // how much of the list is shown, for the sentence under it
    expect(tokens.notes!({})).toEqual(["Robinhood Stock Tokens: 2 of 3 shown · search for the rest"]);
    const halted = (await tokens.listings({ q: "halt", limit: 5 })) as Listing[];
    expect(halted).toEqual([expect.objectContaining({ symbol: "HALT", open: false, note: "Robinhood has halted trading in it" })]);
    // a search shows what matches: nothing to say of the rest — and the sentence for the whole list stands whichever call came last
    expect(tokens.notes!({ q: "halt" })).toEqual([]);
    expect(tokens.notes!({})).toEqual(["Robinhood Stock Tokens: 2 of 3 shown · search for the rest"]);
    // the list is kept: asked once for both
    expect(net.sent.filter((s) => s.url.endsWith("/rhj/assets"))).toHaveLength(1);
  });
});

/** Hyperliquid's info endpoint as it answered on 2026-10-06, cut to three perpetuals: the universe and the contexts in step, a delisted one among them */
const HL_META = [
  { universe: [{ szDecimals: 5, name: "BTC", maxLeverage: 40, marginTableId: 56 }, { szDecimals: 4, name: "ETH", maxLeverage: 25 }, { szDecimals: 0, name: "GONE", maxLeverage: 3, isDelisted: true }], marginTables: [], collateralToken: 0 },
  [
    { funding: "0.0000125", openInterest: "41005.04312", prevDayPx: "85434.0", dayNtlVlm: "1820069402.6143524647", premium: "-0.0001516", oraclePx: "85752.0", markPx: "85738.0", midPx: "85738.5", impactPxs: ["85738.0", "85739.0"] },
    { funding: "0.0000125", openInterest: "100.0", prevDayPx: "2706.7", dayNtlVlm: "666077337.1", premium: "0", oraclePx: "2698.0", markPx: "2698.24", midPx: null, impactPxs: ["2698.1", "2698.4"] },
    { funding: "0", openInterest: "0", prevDayPx: "1.0", dayNtlVlm: "0", premium: "0", oraclePx: "1.0", markPx: "1.0", midPx: "1.0", impactPxs: ["1.0", "1.0"] },
  ],
];
/** a stand-in Hyperliquid: answers by the POST body's `type`, records every request with its body */
function hyperliquidNet(candles: Rec[] = []) {
  const sent: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = [];
  const http: Http = async (url, init = {}) => {
    const body: unknown = init.body ? JSON.parse(init.body) : undefined;
    sent.push({ url, method: init.method ?? "GET", headers: init.headers ?? {}, body });
    const type = (body as { type?: string } | undefined)?.type;
    if (type === "metaAndAssetCtxs") return json(HL_META);
    if (type === "candleSnapshot") return json(candles);
    return json({ error: "unknown" }, 422);
  };
  return { http, sent };
}

describe("Hyperliquid, keyless", () => {
  it("asks one POST of one fixed body and lists every perpetual busiest first as <COIN>-PERP, with Hyperliquid's own mid, day, funding and leverage, to be placed through Hyperliquid's connection to trade", async () => {
    const net = hyperliquidNet();
    const hl = hyperliquidPublic({ http: net.http, clock: () => NOW });
    const got = (await hl.listings({ limit: 10 })) as Listing[];
    expect(net.sent).toEqual([{ url: "https://api.hyperliquid.xyz/info", method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: { type: "metaAndAssetCtxs" } }]);
    // the delisted one is not listed; ETH has no mid, so its mark is its price
    expect(got.map((m) => m.symbol)).toEqual(["BTC-PERP", "ETH-PERP"]);
    expect(got[0]).toEqual({ symbol: "BTC-PERP", name: "BTC perpetual on Hyperliquid", kind: "perp", base: "BTC", quote: "USDC", price: 85738.5, open: true, types: [], change24h: 304.5, changePct24h: 0.3564, volumeUsd24h: 1820069402.6143524647, fundingRate: 0.0000125, nextFundingAt: "2026-10-05T15:00:00.000Z", maxLeverage: 40 });
    expect(got[1]).toMatchObject({ price: 2698.24, maxLeverage: 25 });
    // traded through the account's Hyperliquid connection: an API wallet that places orders and cannot withdraw
    expect(hl).toMatchObject({ id: "hyperliquid", name: "Hyperliquid", kind: "exchange", connectTo: "hyperliquid-trade", connector: "live:hyperliquid-trade" });
    // the answer is kept: a search and a second listing ask nothing more
    expect(((await hl.listings({ q: "eth", limit: 5 })) as Listing[]).map((m) => m.symbol)).toEqual(["ETH-PERP"]);
    expect(((await hl.listings({ q: "BTC/USD", limit: 5 })) as Listing[]).map((m) => m.symbol)).toEqual(["BTC-PERP"]);
    expect(net.sent).toHaveLength(1);
    // the sentence under the list says how much of the venue is shown, when something is left out
    expect(hl.notes!({})).toEqual([]);
    await hl.listings({ limit: 1 });
    expect(hl.notes!({})).toEqual(["Hyperliquid: 1 of 2 perpetuals shown · search for the rest · traded once Hyperliquid is connected to trade"]);
    expect(hl.notes!({})[0]!.length).toBeLessThan(160);
    expect(hl.notes!({ q: "eth" })).toEqual([]);
  });

  it("reads a perpetual's bars with candleSnapshot, sorted and as numbers, and refuses a name that is not <COIN>-PERP before asking", async () => {
    const net = hyperliquidNet([
      { t: NOW - 2 * HOUR, T: NOW - HOUR - 1, s: "BTC", i: "1h", o: "85425.0", c: "85644.0", h: "85650.0", l: "85330.0", v: "791.9847", n: 10611 },
      { t: NOW - 3 * HOUR, T: NOW - 2 * HOUR - 1, s: "BTC", i: "1h", o: "85400.0", c: "85425.0", h: "85430.0", l: "85390.0", v: "100.5", n: 500 },
    ]);
    const hl = hyperliquidPublic({ http: net.http, clock: () => NOW });
    const bars = (await hl.candles!("BTC-PERP", "1h", NOW - 24 * HOUR)) as Candle[];
    expect(bars).toEqual([
      { t: NOW - 3 * HOUR, o: 85400, h: 85430, l: 85390, c: 85425, v: 100.5 },
      { t: NOW - 2 * HOUR, o: 85425, h: 85650, l: 85330, c: 85644, v: 791.9847 },
    ]);
    expect(net.sent[0]!.body).toEqual({ type: "candleSnapshot", req: { coin: "BTC", interval: "1h", startTime: NOW - 24 * HOUR, endTime: NOW } });
    expect(await hl.candles!("BTC/USDT", "1h", NOW - HOUR)).toMatchObject({ code: "E_ACCOUNT_BAD_ACTION" });
    expect(net.sent).toHaveLength(1);
  });

  it("passes Hyperliquid's own refusal of this location on as its rule, and holds it ten minutes", async () => {
    let now = NOW;
    const sent: string[] = [];
    const http: Http = async (url) => {
      sent.push(url);
      return { status: 403, body: undefined, text: "This service is not available in your region" };
    };
    const hl = hyperliquidPublic({ http, clock: () => now });
    expect(await hl.listings({ limit: 5 })).toMatchObject({ code: "E_VENUE_GEOBLOCKED", venue: "hyperliquid", message: "Hyperliquid does not serve this location: that is its own rule, and the account does not look for a way around it" });
    now += 9 * 60_000;
    await hl.listings({ limit: 5 });
    expect(sent).toHaveLength(1);
  });
});

// ---- Pre-IPO perpetuals: the six venues' own records, trimmed from their live answers of 2026-10-06 --------------------------------------

/** OKX GET /api/v5/public/instruments?instType=SWAP: an ordinary swap and two pre-market ones (ruleType) */
const OKX_INST = [
  { instId: "BTC-USDT-SWAP", instType: "SWAP", ruleType: "normal", ctVal: "0.01", ctValCcy: "BTC", settleCcy: "USDT", quoteCcy: "", uly: "BTC-USDT", lever: "100", state: "live", listTime: "1573557408000", tickSz: "0.1", lotSz: "0.01", minSz: "0.01", ctType: "linear" },
  { instId: "ANTHROPIC-USDT-SWAP", instType: "SWAP", ruleType: "pre_market", ctVal: "1", ctValCcy: "ANTHROPIC", settleCcy: "USDT", quoteCcy: "", uly: "ANTHROPIC-USDT", lever: "10", state: "live", listTime: "1778146200000", tickSz: "0.01", lotSz: "0.001", minSz: "0.001", ctType: "linear" },
  { instId: "MOONSHOT-USDT-SWAP", instType: "SWAP", ruleType: "pre_market", ctVal: "1", ctValCcy: "MOONSHOT", settleCcy: "USDT", quoteCcy: "", uly: "MOONSHOT-USDT", lever: "5", state: "live", listTime: "1786957200000", tickSz: "0.01", lotSz: "0.1", minSz: "0.1", ctType: "linear" },
];
const OKX_TICK = (instId: string, last: string, open24h: string): Rec => ({ code: "0", data: [{ instType: "SWAP", instId, last, lastSz: "0.002", askPx: String(Number(last) + 0.01), askSz: "0.249", bidPx: String(Number(last) - 0.01), bidSz: "0.353", open24h, high24h: last, low24h: open24h, volCcy24h: "2427.289", vol24h: "2427.289", ts: "1791315411374", sodUtc0: "210.13", sodUtc8: "211.07" }], msg: "" });
const OKX_FUNDING = (instId: string): Rec => ({ code: "0", data: [{ formulaType: "withRate", fundingRate: "0.0000000000000000", fundingTime: "1791331200000", instId, instType: "SWAP", nextFundingRate: "", nextFundingTime: "1791360000000", method: "current_period", settState: "settled" }], msg: "" });
/** Gate GET /api/v4/futures/usdt/contracts/<name>: a pre-market stock, and a pre-market GPU-price index */
const GATE_ANTHROPIC: Rec = { name: "ANTHROPIC_USDT", type: "direct", quanto_multiplier: "0.01", leverage_max: "50", mark_price: "2139.8", last_price: "2136.85", funding_rate: "0", funding_next_apply: 1791331200, funding_interval: 28800, in_delisting: false, status: "trading", is_pre_market: true, contract_type: "stocks", launch_time: 1776081600, order_size_min: 1, order_price_round: "0.01" };
const GATE_INDEX: Rec = { name: "FIGUREAI_USDT", type: "direct", quanto_multiplier: "1", leverage_max: "10", mark_price: "5.885", last_price: "5.551", funding_rate: "0", funding_next_apply: 1791331200, in_delisting: false, status: "trading", is_pre_market: true, contract_type: "indices" };
const GATE_TICK = [{ last: "2137.47", low_24h: "2094.75", high_24h: "2143.91", volume_24h: "30810", change_percentage: "1.90", change_price: "39.93", funding_rate_indicative: "0", index_price: "2140.03", volume_24h_base: "308", volume_24h_quote: "651204", contract: "ANTHROPIC_USDT", volume_24h_settle: "651204", funding_rate: "0", mark_price: "2140.03", highest_bid: "2136.85", lowest_ask: "2137.56", quanto_multiplier: "0.01" }];
/** Kraken Futures GET /derivatives/api/v3/instruments: a coin perpetual and a Pre-IPO one */
const KF_INST = {
  result: "success",
  instruments: [
    { symbol: "PF_XBTUSD", type: "flexible_futures", tradeable: true, category: "Layer 1", pair: "BTC:USD", base: "BTC", quote: "USD", contractSize: 1, tickSize: 1, openingDate: "2022-03-22T13:15:36Z", marginLevels: [{ numNonContractUnits: 0, initialMargin: 0.01, maintenanceMargin: 0.005 }], postOnly: false, isExpired: false },
    { symbol: "PF_ANTHROPICXUSD", type: "flexible_futures", tradeable: true, category: "Pre-IPO", pair: "ANTHROPICx:USD", base: "ANTHROPICx", quote: "USD", contractSize: 1, tickSize: 0.01, openingDate: "2026-06-15T11:21:55Z", marginLevels: [{ numNonContractUnits: 0, initialMargin: 0.1, maintenanceMargin: 0.05 }, { numNonContractUnits: 50000, initialMargin: 0.2, maintenanceMargin: 0.1 }], postOnly: false, isExpired: false },
    { symbol: "FI_XBTUSD_261226", type: "futures_inverse", tradeable: true, category: "Layer 1", pair: "BTC:USD", base: "BTC", quote: "USD", contractSize: 1, tickSize: 1, lastTradingTime: "2026-12-26T15:00:00Z", marginLevels: [], postOnly: false, isExpired: false },
  ],
};
const KF_TICK = { result: "success", serverTime: "2026-10-06T19:36:58.582Z", ticker: { symbol: "PF_ANTHROPICXUSD", last: 2078.34, lastTime: "2026-10-06T19:36:57.750716369Z", tag: "perpetual", pair: "ANTHROPICx:USD", markPrice: 2080.995, bid: 2078.26, bidSize: 2.52, ask: 2079.67, askSize: 0.04, vol24h: 68.01, volumeQuote: 139436.0415, openInterest: 41.55, open24h: 2039.58, high24h: 2084.86, low24h: 2032.52, vwap24h: 2050.22851787, lastSize: 0.01, fundingRate: 0.012945165835185125, fundingRatePrediction: 0.0129920317683245, relativeFundingRate: 0.00000625, relativeFundingRatePrediction: 0.00000625, suspended: false, indexPrice: 2080.51651383555, postOnly: false, change24h: 1.9 } };
/** Deribit GET /api/v2/public/get_instruments?currency=any&kind=future: a pre-IPO perpetual, SpaceX now an equity, an inverse coin perpetual */
const DB_INST = {
  jsonrpc: "2.0",
  result: [
    { instrument_name: "ANTH_USDC-PERPETUAL", kind: "future", instrument_type: "linear", underlying_type: "preipo", product_group: "RWA", base_currency: "ANTH", quote_currency: "USDC", settlement_currency: "USDC", settlement_period: "perpetual", contract_size: 0.001, max_leverage: 5, is_active: true, creation_timestamp: 1790595081000, tick_size: 0.01, min_trade_amount: 0.001, price_index: "anth_usdc" },
    { instrument_name: "SPCX_USDC-PERPETUAL", kind: "future", instrument_type: "linear", underlying_type: "equity", product_group: "RWA", base_currency: "SPCX", quote_currency: "USDC", settlement_currency: "USDC", settlement_period: "perpetual", contract_size: 0.0001, max_leverage: 10, is_active: true, creation_timestamp: 1789484962000, tick_size: 0.01, min_trade_amount: 0.0001, price_index: "spcx_usdc" },
    { instrument_name: "BTC-PERPETUAL", kind: "future", instrument_type: "reversed", underlying_type: "crypto", product_group: "BTC", base_currency: "BTC", quote_currency: "USD", settlement_currency: "BTC", settlement_period: "perpetual", contract_size: 10, max_leverage: 50, is_active: true, creation_timestamp: 1534242287000, tick_size: 0.5, min_trade_amount: 10, price_index: "btc_usd" },
  ],
};
const DB_TICK = { jsonrpc: "2.0", result: { timestamp: 1791315418739, state: "open", stats: { high: 2081.14, low: 2036.09, price_change: 1.6926, volume: 161.546, volume_usd: 330972.78, volume_notional: 331006.59186 }, index_price: 2075.5493, instrument_name: "ANTH_USDC-PERPETUAL", last_price: 2078.81, settlement_price: 2041.7393, min_price: 2050.57, max_price: 2113.03, open_interest: 110.779, mark_price: 2081.7972, current_funding: 0.00009, estimated_delivery_price: 2075.5493, funding_8h: 0.00001778, best_ask_price: 2081.3, best_bid_price: 2080.51, best_ask_amount: 0.156, best_bid_amount: 3.917 } };
/** KuCoin Futures GET /api/v1/contracts/active: an ordinary perpetual, a pre-market stock, a pre-market token */
const KC_INST = {
  code: "200000",
  data: [
    { symbol: "XBTUSDTM", rootSymbol: "USDT", type: "FFWCSX", baseCurrency: "XBT", quoteCurrency: "USDT", settleCurrency: "USDT", multiplier: 0.001, maxLeverage: 125, status: "Open", marketStage: "NORMAL", assetClass: "CRYPTO", marketType: "CRYPTO", firstOpenDate: 1585555200000, tickSize: 0.1, lotSize: 1, markPrice: 85503.7, lastTradePrice: 85503.7, priceChgPct: -0.0023, turnoverOf24h: 201048716.065, fundingFeeRate: 0.00005, nextFundingRateDateTime: 1791331200000, indexSymbol: ".KXBTUSDT" },
    { symbol: "ANTHROPICUSDTM", rootSymbol: "USDT", type: "FFWCSX", baseCurrency: "ANTHROPIC", quoteCurrency: "USDT", settleCurrency: "USDT", multiplier: 0.001, maxLeverage: 20, status: "Open", marketStage: "PRE_MARKET", assetClass: "STOCK", marketType: "NASDAQ", firstOpenDate: 1780380000000, tickSize: 0.01, lotSize: 1, markPrice: 2082.39, lastTradePrice: 2083.01, priceChgPct: 0.015, turnoverOf24h: 1686152.13014, fundingFeeRate: 0.00005, nextFundingRateDateTime: 1791331200000, indexSymbol: ".KANTHROPICUSDT" },
    { symbol: "BPUSDTM", rootSymbol: "USDT", type: "FFWCSX", baseCurrency: "BP", quoteCurrency: "USDT", settleCurrency: "USDT", multiplier: 10, maxLeverage: 5, status: "Open", marketStage: "PRE_MARKET", assetClass: "CRYPTO", marketType: "CRYPTO", firstOpenDate: 1773667800000, tickSize: 0.00001, lotSize: 1, markPrice: 1.22468, lastTradePrice: 1.2322, priceChgPct: -0.0142, turnoverOf24h: 39877.8806, fundingFeeRate: 0.00005, nextFundingRateDateTime: 1791331200000, indexSymbol: ".KBPUSDT" },
  ],
};
const KC_ONE = { code: "200000", data: { symbol: "ANTHROPICUSDTM", displaySymbol: "ANTHROPICUSDTM", rootSymbol: "USDT", type: "FFWCSX", baseCurrency: "ANTHROPIC", quoteCurrency: "USDT", settleCurrency: "USDT", lotSize: 1, tickSize: 0.01, multiplier: 0.001, status: "Open", fundingFeeRate: 0.00005, openInterest: "237850", turnoverOf24h: 1686152.13014, volumeOf24h: 823.342, markPrice: 2082.39, indexPrice: 2083.01, lastTradePrice: 2083.01, nextFundingRateDateTime: 1791331200000, maxLeverage: 20, lowPrice: 2030.48, highPrice: 2086.95, priceChgPct: 0.015, priceChg: 30.94, marketStage: "PRE_MARKET", marketType: "NASDAQ", assetClass: "STOCK", subMarketType: "US.STOCK" } };
/** MEXC GET /api/v1/contract/detail: BTC, Anthropic, and Moonshot AI under MEXC's name KIMISTOCK (its displayNameEn says MOONSHOT) */
const MX_INST = {
  success: true,
  code: 0,
  data: [
    { symbol: "BTC_USDT", displayNameEn: "BTC_USDT PERPETUAL", baseCoin: "BTC", quoteCoin: "USDT", settleCoin: "USDT", contractSize: 0.0001, maxLeverage: 500, state: 0, apiAllowed: true, conceptPlate: ["mc-trade-zone-mainly", "mc-trade-zone-layer2", "mc-trade-zone-pow"], createTime: 1591242684000, priceUnit: 0.1, minVol: 1, futureType: 1, type: 1 },
    { symbol: "ANTHROPIC_USDT", displayNameEn: "ANTHROPIC_USDT PERPETUAL", baseCoin: "ANTHROPIC", quoteCoin: "USDT", settleCoin: "USDT", contractSize: 0.001, maxLeverage: 50, state: 0, apiAllowed: true, conceptPlate: ["mc-trade-zone-Stock", "mc-trade-zone-preipo", "mc-trade-zone-0fees", "mc-trade-zone-tradfi"], createTime: 1776135866000, priceUnit: 0.01, minVol: 1, futureType: 1, type: 1 },
    { symbol: "KIMISTOCK_USDT", displayNameEn: "MOONSHOT_USDT PERPETUAL", baseCoin: "KIMISTOCK", quoteCoin: "USDT", settleCoin: "USDT", contractSize: 0.1, maxLeverage: 20, state: 0, apiAllowed: true, conceptPlate: ["mc-trade-zone-Stock", "mc-trade-zone-preipo", "mc-trade-zone-tradfi"], createTime: 1785984696000, priceUnit: 0.01, minVol: 1, futureType: 1, type: 1 },
  ],
};
const MX_TICK = (symbol: string, last: number, bid1: number, ask1: number): Rec => ({ success: true, code: 0, data: { contractId: 1845, symbol, lastPrice: last, bid1, ask1, volume24: 307944, amount24: 626470.24446, holdVol: 8041414, lower24Price: 2024.34, high24Price: 2077.73, riseFallRate: 0.0171, riseFallValue: 35, indexPrice: 2070.13, fairPrice: 2073.51, fundingRate: 0.00005, timestamp: 1791315419416 } });

const venueOf = (id: string) => PRE_IPO_VENUES.find((v) => v.id === id)!;
const nextFunding = new Date(1791331200000).toISOString();

describe("Pre-IPO perpetuals, keyless, at six venues", () => {
  it("OKX: its swaps once, the pre-market ones by its ruleType, each with its ticker and funding; ANTHROPIC in its $10B unit since the rebase, MOONSHOT in the $1B unit everyone else uses; the list kept ten minutes, the prices ninety seconds", async () => {
    let now = NOW;
    const net = network([
      ["/api/v5/public/instruments?instType=SWAP", json({ code: "0", data: OKX_INST, msg: "" })],
      ["/api/v5/market/ticker?instId=ANTHROPIC-USDT-SWAP", json(OKX_TICK("ANTHROPIC-USDT-SWAP", "214", "209.67"))],
      ["/api/v5/market/ticker?instId=MOONSHOT-USDT-SWAP", json(OKX_TICK("MOONSHOT-USDT-SWAP", "68.18", "67.09"))],
      ["/api/v5/public/funding-rate?instId=ANTHROPIC-USDT-SWAP", json(OKX_FUNDING("ANTHROPIC-USDT-SWAP"))],
      ["/api/v5/public/funding-rate?instId=MOONSHOT-USDT-SWAP", json(OKX_FUNDING("MOONSHOT-USDT-SWAP"))],
    ]);
    const okx = preIpoPublic(venueOf("okx"), { http: net.http, clock: () => now });
    expect(okx).toMatchObject({ id: "okx-preipo", name: "OKX", kind: "exchange", connectTo: "okx", connector: "live:exchange:okx" });
    const got = (await okx.listings({ limit: 10 })) as Listing[];
    // BTC-USDT-SWAP is a normal swap: not listed. Every request a GET to www.okx.com: the list, then a ticker and a funding for each contract
    expect(net.sent.map((s) => new URL(s.url).host)).toEqual(Array(5).fill("www.okx.com"));
    expect(net.sent.every((s) => s.method === "GET")).toBe(true);
    expect(got.map((m) => m.symbol)).toEqual(["ANTHROPIC/USDT:USDT", "MOONSHOT/USDT:USDT"]);
    const anthropic = got[0]!;
    expect(anthropic).toMatchObject({ name: "Anthropic pre-IPO perpetual on OKX", kind: "perp", base: "ANTHROPIC", quote: "USDT", price: 214, bid: 213.99, ask: 214.01, open: true, types: [], change24h: 4.33, fundingRate: 0, nextFundingAt: nextFunding, maxLeverage: 10, contractSize: 1, category: "Pre-IPO", group: { id: "preipo:anthropic", title: "Anthropic" }, issuer: "Anthropic", eligibility: PRE_IPO_ISSUERS.anthropic!.eligibility });
    expect(anthropic.changePct24h).toBeCloseTo(2.0652, 3);
    // the rebased unit: $214 of price is $2.14 trillion of implied valuation
    expect(anthropic.implied).toEqual({ perPoint: 10_000_000_000, usd: 2_140_000_000_000, unit: "OKX: a price of $1 stands for $10,000,000,000 of implied company valuation since its 10:1 rebase of 30 June 2026" });
    // OKX counts a swap's volume in the base currency: no dollar volume is said
    expect(anthropic.volumeUsd24h).toBeUndefined();
    expect(got[1]).toMatchObject({ name: "Moonshot AI (Kimi) pre-IPO perpetual on OKX", group: { id: "preipo:moonshot", title: "Moonshot AI (Kimi)" }, implied: { perPoint: 1_000_000_000, usd: 68_180_000_000 }, maxLeverage: 5 });
    expect(got[1]!.issuer).toBeUndefined();
    // a second listing asks nothing; after ninety seconds the prices are asked again and the list is not; after ten minutes the list too
    await okx.listings({ limit: 10 });
    expect(net.sent).toHaveLength(5);
    now += KEEP_MS + 1_000;
    await okx.listings({ limit: 10 });
    expect(net.sent).toHaveLength(9);
    expect(net.sent.slice(5).some((s) => s.url.includes("/public/instruments"))).toBe(false);
    now += LIST_MS;
    await okx.listings({ limit: 10 });
    expect(net.sent.filter((s) => s.url.includes("/public/instruments"))).toHaveLength(2);
    // a search by the company's name or the venue's symbol
    expect(((await okx.listings({ q: "moon", limit: 10 })) as Listing[]).map((m) => m.symbol)).toEqual(["MOONSHOT/USDT:USDT"]);
    expect(((await okx.listings({ q: "ANTH", limit: 10 })) as Listing[]).map((m) => m.symbol)).toEqual(["ANTHROPIC/USDT:USDT"]);
  });

  it("Gate: each company's contract by name (its list is 1.3 MB uncompressed), a name it does not list answering CONTRACT_NOT_FOUND; its flag is is_pre_market AND contract_type stocks, so a pre-market GPU index is not one; the ticker's own figures", async () => {
    const net = network([
      ["/contracts/ANTHROPIC_USDT", json(GATE_ANTHROPIC)],
      ["/contracts/FIGUREAI_USDT", json(GATE_INDEX)],
      ["/api/v4/futures/usdt/contracts/", { status: 400, body: { label: "CONTRACT_NOT_FOUND" }, text: '{"label":"CONTRACT_NOT_FOUND"}' }],
      ["/api/v4/futures/usdt/tickers?contract=ANTHROPIC_USDT", json(GATE_TICK)],
    ]);
    const gate = preIpoPublic(venueOf("gate"), { http: net.http, clock: () => NOW });
    const got = (await gate.listings({ limit: 10 })) as Listing[];
    expect(net.sent.filter((s) => s.url.includes("/contracts/")).map((s) => s.url.slice(s.url.lastIndexOf("/") + 1))).toEqual(PRE_IPO_NAMES.map((n) => `${n}_USDT`));
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ symbol: "ANTHROPIC/USDT:USDT", name: "Anthropic pre-IPO perpetual on Gate", base: "ANTHROPIC", quote: "USDT", price: 2137.47, bid: 2136.85, ask: 2137.56, open: true, changePct24h: 1.9, change24h: 39.93, volumeUsd24h: 651204, fundingRate: 0, nextFundingAt: nextFunding, maxLeverage: 50, contractSize: 0.01, category: "Pre-IPO", implied: { perPoint: 1_000_000_000, usd: 2_137_470_000_000 } });
    expect(gate).toMatchObject({ id: "gate-preipo", connectTo: "gate", connector: "live:exchange:gate" });
    // Gate refusing every name is Gate's refusal, held back as its words say
    const blocked = network([["api.gateio.ws", { status: 451, body: undefined, text: "unavailable from a restricted location" }]]);
    expect(await preIpoPublic(venueOf("gate"), { http: blocked.http, clock: () => NOW }).listings({ limit: 5 })).toMatchObject({ code: "E_VENUE_GEOBLOCKED", venue: "gate-preipo" });
  });

  it("Kraken Futures: its flexible futures by category Pre-IPO, named as the library names them (ANTHROPICX/USD:USD), with its ticker's percent change, dollar volume and relative funding rate, and the leverage its first margin level allows", async () => {
    const net = network([
      ["/derivatives/api/v3/instruments", json(KF_INST)],
      ["/derivatives/api/v3/tickers/PF_ANTHROPICXUSD", json(KF_TICK)],
    ]);
    const kf = preIpoPublic(venueOf("krakenfutures"), { http: net.http, clock: () => NOW });
    const got = (await kf.listings({ limit: 10 })) as Listing[];
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ symbol: "ANTHROPICX/USD:USD", base: "ANTHROPICx", quote: "USD", price: 2078.34, bid: 2078.26, ask: 2079.67, open: true, changePct24h: 1.9, volumeUsd24h: 139436.0415, fundingRate: 0.00000625, maxLeverage: 10, contractSize: 1, category: "Pre-IPO", group: { id: "preipo:anthropic", title: "Anthropic" }, implied: { perPoint: 1_000_000_000, usd: 2_078_340_000_000 }, issuer: "Anthropic" });
    expect(got[0]!.nextFundingAt).toBeUndefined();
    expect(net.sent).toHaveLength(2);
    expect(kf).toMatchObject({ id: "krakenfutures-preipo", name: "Kraken Futures", connectTo: "krakenfutures", connector: "live:exchange:krakenfutures" });
  });

  it("Deribit: its perpetuals by underlying_type preipo — SpaceX, an equity now, and the inverse BTC perpetual are not — with its ticker's percent change, dollar volume and eight-hour funding", async () => {
    const net = network([
      ["/api/v2/public/get_instruments?currency=any&kind=future", json(DB_INST)],
      ["/api/v2/public/ticker?instrument_name=ANTH_USDC-PERPETUAL", json(DB_TICK)],
    ]);
    const db = preIpoPublic(venueOf("deribit"), { http: net.http, clock: () => NOW });
    const got = (await db.listings({ limit: 10 })) as Listing[];
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ symbol: "ANTH/USDC:USDC", name: "Anthropic pre-IPO perpetual on Deribit", base: "ANTH", quote: "USDC", price: 2078.81, bid: 2080.51, ask: 2081.3, open: true, changePct24h: 1.6926, volumeUsd24h: 330972.78, fundingRate: 0.00001778, maxLeverage: 5, contractSize: 0.001, group: { id: "preipo:anthropic", title: "Anthropic" }, implied: { perPoint: 1_000_000_000, usd: 2_078_810_000_000 } });
    expect(net.sent.every((s) => new URL(s.url).host === "www.deribit.com")).toBe(true);
    expect(db).toMatchObject({ id: "deribit-preipo", connectTo: "deribit", connector: "live:exchange:deribit" });
  });

  it("KuCoin Futures: its contracts by marketStage PRE_MARKET and assetClass STOCK (its pre-market BP token is not one), each contract's own record for its prices, funding and next funding time; no book, so no bid or ask", async () => {
    const net = network([
      ["/api/v1/contracts/active", json(KC_INST)],
      ["/api/v1/contracts/ANTHROPICUSDTM", json(KC_ONE)],
    ]);
    const kc = preIpoPublic(venueOf("kucoinfutures"), { http: net.http, clock: () => NOW });
    const got = (await kc.listings({ limit: 10 })) as Listing[];
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ symbol: "ANTHROPIC/USDT:USDT", base: "ANTHROPIC", price: 2083.01, open: true, changePct24h: 1.5, change24h: 30.94, volumeUsd24h: 1686152.13014, fundingRate: 0.00005, nextFundingAt: nextFunding, maxLeverage: 20, contractSize: 0.001, implied: { perPoint: 1_000_000_000, usd: 2_083_010_000_000 } });
    expect(got[0]!.bid).toBeUndefined();
    expect(net.sent).toHaveLength(2);
    expect(kc).toMatchObject({ id: "kucoinfutures-preipo", name: "KuCoin Futures", connectTo: "kucoinfutures", connector: "live:exchange:kucoinfutures" });
  });

  it("MEXC: its contracts by conceptPlate preipo, KIMISTOCK grouped as Moonshot AI (MEXC's own display name says so), each ticker's own figures; a contract whose ticker refuses is left out while the others answer, and every one refusing is MEXC's refusal", async () => {
    const net = network([
      ["/api/v1/contract/detail", json(MX_INST)],
      ["/api/v1/contract/ticker?symbol=ANTHROPIC_USDT", json(MX_TICK("ANTHROPIC_USDT", 2074.95, 2075.07, 2076.84))],
      ["/api/v1/contract/ticker?symbol=KIMISTOCK_USDT", { status: 429, body: undefined, text: "too many requests" }],
    ]);
    const mx = preIpoPublic(venueOf("mexc"), { http: net.http, clock: () => NOW });
    const got = (await mx.listings({ limit: 10 })) as Listing[];
    expect(got.map((m) => m.symbol)).toEqual(["ANTHROPIC/USDT:USDT"]);
    expect(got[0]).toMatchObject({ price: 2074.95, bid: 2075.07, ask: 2076.84, changePct24h: 1.71, change24h: 35, volumeUsd24h: 626470.24446, fundingRate: 0.00005, maxLeverage: 50, contractSize: 0.001, implied: { perPoint: 1_000_000_000, usd: 2_074_950_000_000 } });
    const all = network([
      ["/api/v1/contract/detail", json(MX_INST)],
      ["/api/v1/contract/ticker?symbol=ANTHROPIC_USDT", json(MX_TICK("ANTHROPIC_USDT", 2074.95, 2075.07, 2076.84))],
      ["/api/v1/contract/ticker?symbol=KIMISTOCK_USDT", json(MX_TICK("KIMISTOCK_USDT", 68.01, 67.98, 68.05))],
    ]);
    const both = (await preIpoPublic(venueOf("mexc"), { http: all.http, clock: () => NOW }).listings({ limit: 10 })) as Listing[];
    expect(both.find((m) => m.symbol === "KIMISTOCK/USDT:USDT")).toMatchObject({ base: "KIMISTOCK", name: "Moonshot AI (Kimi) pre-IPO perpetual on MEXC", group: { id: "preipo:moonshot", title: "Moonshot AI (Kimi)" }, implied: { usd: 68_010_000_000 } });
    const refusing = network([
      ["/api/v1/contract/detail", json(MX_INST)],
      ["/api/v1/contract/ticker", { status: 429, body: undefined, text: "too many requests" }],
    ]);
    expect(await preIpoPublic(venueOf("mexc"), { http: refusing.http, clock: () => NOW }).listings({ limit: 10 })).toMatchObject({ code: "E_VENUE_UNREACHABLE", message: "MEXC is rate-limiting this machine: try again in a minute" });
  });

  it("a venue that does not serve this location answers so once and is not asked again for ten minutes; a venue listing no pre-IPO contract lists nothing, not a refusal", async () => {
    let now = NOW;
    const blocked = network([["futures.kraken.com", { status: 451, body: undefined, text: "unavailable" }]]);
    const kf = preIpoPublic(venueOf("krakenfutures"), { http: blocked.http, clock: () => now });
    expect(await kf.listings({ limit: 5 })).toMatchObject({ code: "E_VENUE_GEOBLOCKED", venue: "krakenfutures-preipo", message: "Kraken Futures does not serve this location: that is its own rule, and the account does not look for a way around it" });
    now += 9 * 60_000;
    await kf.listings({ limit: 5 });
    expect(blocked.sent).toHaveLength(1);
    now += 2 * 60_000;
    await kf.listings({ limit: 5 });
    expect(blocked.sent).toHaveLength(2);
    const plain = network([["/api/v2/public/get_instruments", json({ jsonrpc: "2.0", result: [DB_INST.result[2]] })]]);
    expect(await preIpoPublic(venueOf("deribit"), { http: plain.http, clock: () => NOW }).listings({ limit: 5 })).toEqual([]);
  });
});

describe("every public source", () => {
  it("is the five exchanges (Bybit by default, after Binance), Kalshi, Polymarket, Hyperliquid, the Stock Tokens, the eight exchanges' pre-IPO perpetuals and Hyperliquid's HIP-3 ones, unless other exchanges are named", () => {
    const preipo = ["okx-preipo", "gate-preipo", "krakenfutures-preipo", "deribit-preipo", "kucoinfutures-preipo", "mexc-preipo", "binance-preipo", "bybit-preipo", "hyperliquid-preipo"];
    expect(publicSources().map((s) => s.id)).toEqual(["kraken", "coinbase", "okx", "binance", "bybit", "kalshi", "polymarket", "hyperliquid", "robinhood-stock-tokens", ...preipo]);
    expect(publicSources({ exchanges: ["kraken"] }).map((s) => s.id)).toEqual(["kraken", "kalshi", "polymarket", "hyperliquid", "robinhood-stock-tokens", ...preipo]);
    expect(PRE_IPO_VENUES.map((v) => v.id)).toEqual(["okx", "gate", "krakenfutures", "deribit", "kucoinfutures", "mexc", "binance", "bybit"]);
  });
});
