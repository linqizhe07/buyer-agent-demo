import { describe, expect, it } from "vitest";
import { isRefusal } from "../../src/core/errors.ts";
import type { ExchangeClient, OpenExchange } from "../../src/portfolio/live/exchange.ts";
import { exchangeTickers, fixedHosts, kalshiPublic, polymarketPublic, publicSources, stockTokensPublic, type Listing } from "../../src/portfolio/live/public-markets.ts";
import { STOCK_TOKEN_ISSUER, STOCK_TOKEN_TERMS } from "../../src/portfolio/live/robinhood.ts";
import type { Http, HttpReply } from "../../src/portfolio/live/types.ts";

/** Public market data, read without a key, against stand-ins: a stand-in exchange library whose tickers carry each exchange's own raw
 * answer (`info`) in the shapes the library's parsers document, and a stand-in network answering Kalshi, Polymarket's Gamma and Robinhood's
 * /rhj/ in the shapes their docs and their live public answers showed on 2026-10-05. Every request is recorded; nothing leaves the
 * process, and no key is used anywhere. */

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

  it("passes Binance's 451 and Bybit's 403 on as the venue's own rule, and loads the markets afresh the next time", async () => {
    const said451 = `binance GET https://api.binance.com/api/v3/exchangeInfo 451  {"code":0,"msg":"Service unavailable from a restricted location according to 'b. Eligibility' in https://www.binance.com/en/terms."}`;
    const bn = library({}, {}, { fail: Object.assign(new Error(said451), { name: "ExchangeNotAvailable" }) });
    const binance = exchangeTickers("binance", { open: bn.open });
    const r = await binance.listings({ limit: 5 });
    expect(isRefusal(r) && r).toMatchObject({ code: "E_VENUE_GEOBLOCKED", venue: "binance", message: "Binance does not serve this location: that is its own rule, and the account does not look for a way around it", native: { error: "ExchangeNotAvailable", said: expect.stringContaining("restricted location") } });
    await binance.listings({ limit: 5 });
    expect(bn.calls).toEqual(["loadMarkets", "loadMarkets:reload"]);

    const by = library({}, {}, { fail: Object.assign(new Error("bybit GET https://api.bybit.com/v5/market/instruments-info 403 Forbidden The Amazon CloudFront distribution is configured to block access from your country."), { name: "ExchangeNotAvailable" }) });
    expect(await exchangeTickers("bybit", { open: by.open }).listings({ limit: 5 })).toMatchObject({ code: "E_VENUE_GEOBLOCKED", message: expect.stringMatching(/^Bybit does not serve this location/) });
  });

  it("keeps an answer twenty seconds, and gives stats by symbol from the same tickers", async () => {
    let now = NOW;
    const lib = library({ "BTC/USDT": spot("BTC", "USDT") }, { "BTC/USDT": { info: { last: "100", open24h: "90", volCcy24h: "5" } } });
    const okx = exchangeTickers("okx", { open: lib.open, clock: () => now });
    await okx.listings({ limit: 5 });
    await okx.listings({ limit: 5 });
    now += 21_000;
    await okx.listings({ limit: 5 });
    expect(lib.calls.filter((c) => c.startsWith("fetchTickers"))).toHaveLength(2);
    const stats = await okx.stats!(["BTC/USDT", "NOPE/USDT"]);
    expect(stats instanceof Map && stats.get("BTC/USDT")).toEqual({ price: 100, changePct24h: 11.1111, change24h: 10, volumeUsd24h: 5 });
    expect(lib.calls.at(-1)).toBe("fetchTickers:BTC/USDT");
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

describe("Kalshi, keyless", () => {
  const routes = (markets: Rec[], events: Rec[] = [{ event_ticker: "KXFED-27APR", title: "Fed decision in April 2027", category: "Economics" }]): Array<[string, HttpReply | ((url: string) => HttpReply)]> => [
    ["/trade-api/v2/markets?", json({ markets, cursor: "next" })],
    ["/trade-api/v2/events?", (url) => json({ events: events.filter((e) => (query(url).tickers ?? "").split(",").includes(String(e.event_ticker))), cursor: "" })],
  ];

  it("lists open markets busiest first as YES and NO legs, with Kalshi's own close time, change, contracts and event category", async () => {
    const net = network(
      routes([
        MARKET({ ticker: "KXQUIET-1", event_ticker: "KXQUIET", volume_24h_fp: "3.00", title: "Quiet?" }),
        MARKET({}),
        MARKET({ ticker: "KXMVECROSS-1", volume_24h_fp: "99999.00" }),
        MARKET({ ticker: "KXDONE-1", status: "determined", volume_24h_fp: "88888.00" }),
      ]),
    );
    const k = kalshiPublic({ http: net.http, clock: () => NOW });
    const got = (await k.listings({ limit: 1 })) as Listing[];
    expect(new URL(net.sent[0]!.url).host).toBe("external-api.kalshi.com");
    expect(query(net.sent[0]!.url)).toEqual({ status: "open", mve_filter: "exclude", limit: "1000" });
    expect(query(net.sent[1]!.url)).toEqual({ tickers: "KXFED-27APR", limit: "200" });
    expect(got).toHaveLength(2);
    const title = "Will the upper bound of the federal funds rate be above 4.00% following the Fed's Apr 28, 2027 meeting? (Above 4.00%)";
    expect(got[0]).toEqual({ symbol: "KXFED-27APR-T4.00:YES", name: `${title} · Yes`, kind: "event", base: "KXFED-27APR-T4.00:YES", quote: "USD", price: 0.43, bid: 0.42, ask: 0.45, open: true, types: [], group: { id: "KXFED-27APR-T4.00", title }, outcome: "YES", closeTime: "2027-04-28T17:55:00Z", category: "Economics", tags: ["Economics"], change24h: 0.03, contracts24h: 5120, event: { id: "KXFED-27APR", title: "Fed decision in April 2027" } });
    expect(got[1]).toMatchObject({ symbol: "KXFED-27APR-T4.00:NO", price: 0.57, bid: 0.55, ask: 0.58, outcome: "NO", change24h: -0.03, contracts24h: 5120 });
    // contracts are never dollars
    expect(got.every((m) => m.volumeUsd24h === undefined)).toBe(true);
    expect(k).toMatchObject({ id: "kalshi", kind: "events", connectTo: "kalshi", connector: "live:kalshi" });
  });

  it("asks what closes within the window with Kalshi's own close-time filters, and keeps one category when asked", async () => {
    const net = network(routes([MARKET({}), MARKET({ ticker: "KXNFL-1", event_ticker: "KXNFL", volume_24h_fp: "9000.00" })], [{ event_ticker: "KXFED-27APR", title: "Fed", category: "Economics" }, { event_ticker: "KXNFL", title: "NFL", category: "Sports" }]));
    const k = kalshiPublic({ http: net.http, clock: () => NOW });
    const got = (await k.events!({ closingWithinMs: 24 * HOUR, category: "economics", limit: 5 })) as Listing[];
    expect(query(net.sent[0]!.url)).toMatchObject({ min_close_ts: String(NOW / 1000), max_close_ts: String(NOW / 1000 + 86_400) });
    expect(got.map((m) => m.symbol)).toEqual(["KXFED-27APR-T4.00:YES", "KXFED-27APR-T4.00:NO"]);
  });

  it("lists a market without a category when its event does not answer, and refuses in Kalshi's terms when the list does not", async () => {
    const net = network([["/trade-api/v2/markets?", json({ markets: [MARKET({})] })], ["/trade-api/v2/events?", json({ error: "boom" }, 500)]]);
    const got = (await kalshiPublic({ http: net.http, clock: () => NOW }).listings({ limit: 5 })) as Listing[];
    expect(got).toHaveLength(2);
    expect(got[0]?.category).toBeUndefined();
    const busy = network([["/trade-api/v2/markets?", { status: 429, body: undefined, text: "too many requests" }]]);
    expect(await kalshiPublic({ http: busy.http }).listings({ limit: 5 })).toMatchObject({ code: "E_VENUE_UNREACHABLE", message: "Kalshi is rate-limiting this machine: try again in a minute", native: { status: 429, said: "too many requests" } });
    const blocked = network([["/trade-api/v2/markets?", { status: 451, body: undefined, text: "unavailable" }]]);
    expect(await kalshiPublic({ http: blocked.http }).listings({ limit: 5 })).toMatchObject({ code: "E_VENUE_GEOBLOCKED" });
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

describe("Polymarket, keyless, through Gamma", () => {
  it("lists the busiest open markets as their outcomes, the first outcome's book and change, the event's tags for its category", async () => {
    const markets = [GAMMA_MARKET(), GAMMA_MARKET({ conditionId: `0x${"09".repeat(32)}`, slug: "nfl-atl-no-spread", question: "Spread: Falcons (-6.5)", outcomes: '["Yes", "No"]', outcomePrices: '["0.4", "0.6"]', volume24hr: 9_000_000, oneDayPriceChange: -0.02, bestBid: 0.39, bestAsk: 0.41 }), GAMMA_MARKET({ conditionId: `0x${"10".repeat(32)}`, slug: "done", closed: true, volume24hr: 1e9 })];
    const net = network([["gamma-api.polymarket.com/events?", json([GAMMA_EVENT({}, markets)])]]);
    const pm = polymarketPublic({ http: net.http, clock: () => NOW });
    const got = (await pm.listings({ limit: 2 })) as Listing[];
    expect(query(net.sent[0]!.url)).toEqual({ closed: "false", active: "true", archived: "false", order: "volume24hr", ascending: "false", limit: "20" });
    expect(got.map((m) => m.symbol)).toEqual(["nfl-atl-no-spread:Yes", "nfl-atl-no-spread:No", "nfl-atl-no-2026-10-06:Falcons", "nfl-atl-no-2026-10-06:Saints"]);
    expect(got[2]).toEqual({
      symbol: "nfl-atl-no-2026-10-06:Falcons",
      name: "Falcons vs. Saints · Falcons",
      kind: "event",
      base: "Falcons",
      quote: "pUSD",
      price: 0.915,
      bid: 0.91,
      ask: 0.92,
      open: true,
      types: [],
      group: { id: `0x${"08".repeat(32)}`, title: "Falcons vs. Saints" },
      outcome: "Falcons",
      closeTime: "2026-10-06T00:15:00Z",
      category: "Sports",
      tags: ["Games", "Sports", "NFL (All)", "games", "sports", "nfl"],
      change24h: 0.44,
      volumeUsd24h: 4231519.99,
      event: { id: "909452", title: "Falcons vs. Saints" },
    });
    // the second outcome carries only its own price: Gamma's book and change are the first's
    expect(got[3]).toMatchObject({ price: 0.085, bid: undefined, ask: undefined, volumeUsd24h: 4231519.99 });
    expect(got[3]?.change24h).toBeUndefined();
    expect(pm).toMatchObject({ id: "polymarket", kind: "events", connectTo: "polymarket", connector: "live:polymarket-trade" });
  });

  it("asks what closes within the window with Gamma's end-date filters, and holds each market to it", async () => {
    const net = network([["gamma-api.polymarket.com/events?", json([GAMMA_EVENT({}, [GAMMA_MARKET(), GAMMA_MARKET({ conditionId: `0x${"11".repeat(32)}`, slug: "later", endDate: "2026-10-09T00:00:00Z" })])])]]);
    const got = (await polymarketPublic({ http: net.http, clock: () => NOW }).events!({ closingWithinMs: 24 * HOUR, limit: 10 })) as Listing[];
    expect(query(net.sent[0]!.url)).toMatchObject({ end_date_min: "2026-10-05T14:00:00.000Z", end_date_max: "2026-10-06T14:00:00.000Z" });
    expect(got.map((m) => m.symbol)).toEqual(["nfl-atl-no-2026-10-06:Falcons", "nfl-atl-no-2026-10-06:Saints"]);
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
    const halted = (await tokens.listings({ q: "halt", limit: 5 })) as Listing[];
    expect(halted).toEqual([expect.objectContaining({ symbol: "HALT", open: false, note: "Robinhood has halted trading in it" })]);
    // the list is kept: asked once for both
    expect(net.sent.filter((s) => s.url.endsWith("/rhj/assets"))).toHaveLength(1);
  });
});

describe("every public source", () => {
  it("is the four exchanges, Kalshi, Polymarket and the Stock Tokens, unless other exchanges are named", () => {
    expect(publicSources().map((s) => s.id)).toEqual(["kraken", "coinbase", "okx", "binance", "kalshi", "polymarket", "robinhood-stock-tokens"]);
    expect(publicSources({ exchanges: ["bybit"] }).map((s) => s.id)).toEqual(["bybit", "kalshi", "polymarket", "robinhood-stock-tokens"]);
  });
});
