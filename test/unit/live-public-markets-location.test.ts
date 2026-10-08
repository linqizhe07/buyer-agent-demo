import { describe, expect, it } from "vitest";
import { isRefusal, type Refusal } from "../../src/core/errors.ts";
import { exchangeSaidNo, type ExchangeClient, type OpenExchange } from "../../src/portfolio/live/exchange.ts";
import { OKX_REBASED_PER_POINT, PRE_IPO_ISSUERS } from "../../src/portfolio/live/preipo.ts";
import { PUBLIC_EXCHANGES, publicPrices } from "../../src/portfolio/live/prices.ts";
import { exchangeNo, exchangeTickers, holdBackMs, hyperliquidPreIpoPublic, hyperliquidPublic, KEEP_MS, LIST_MS, preIpoPublic, PUBLIC_HOSTS, type Listing } from "../../src/portfolio/live/public-markets.ts";
import type { Candle } from "../../src/portfolio/live/trade.ts";
import { BINANCE_451_BODY, BINANCE_SAID, BN_DAY, BN_INFO, BN_MARK, BYBIT_403_BODY, BYBIT_SAID, BY_PAGE, BY_PAGES, BY_TICK, HOUR, MIN, NOW, UNIT, binance451, bybit403, hip3Net, json, network, refusing, venueOf, type Rec } from "./live-public-markets-fixtures.ts";

/** The keyless public market data, wherever this machine is: what a venue serves here is read, what it refuses here lands in `missing` in
 * its own words and is held back — Bybit read by default, Binance's and Bybit's refusals, their pre-IPO perpetuals from their documented
 * shapes, and Hyperliquid's HIP-3 ones from its live answers of 2026-10-08 (live-public-markets-fixtures.ts says which is which). Against
 * stand-ins only: nothing leaves the process, no key exists in this file. */

describe("Bybit, read by default", () => {
  it("is among the exchanges the Markets screen reads keylessly and the prices are asked of, after Binance: one list for both", async () => {
    expect(PUBLIC_EXCHANGES).toEqual(["kraken", "coinbase", "okx", "binance", "bybit"]);
    // a coin the first three do not list, Binance refusing this location: Bybit, where it serves, prices it
    const opened: string[] = [];
    const binance = refusing(binance451);
    const listing = (markets: Record<string, Rec>, last?: number): ExchangeClient => ({
      id: "x",
      markets,
      async loadMarkets() {
        return markets;
      },
      async fetchBalance() {
        throw new Error("no balance");
      },
      async fetchTickers(symbols?: string[]) {
        return Object.fromEntries((symbols ?? []).map((s) => [s, { last }]));
      },
    });
    const open: OpenExchange = async (id) => {
      opened.push(id);
      if (id === "binance") return binance.open(id, { apiKey: "", secret: "" });
      if (id === "bybit") return { ...listing({ "PENGU/USDT": { symbol: "PENGU/USDT" } }, 0.0123), id };
      return { ...listing({ "BTC/USD": { symbol: "BTC/USD" } }, 100_000), id };
    };
    const price = publicPrices({ open, clock: () => NOW });
    expect(await price("PENGU")).toBe(0.0123);
    expect(opened).toEqual(["kraken", "coinbase", "okx", "binance", "bybit"]);
    // Binance said no once: the library keeps that failed load, so the next asset costs it nothing
    expect(await price("NOTLISTED")).toBeUndefined();
    expect(binance.counts.loads).toBe(1);
  });
});

describe("Bybit's 403, which the library labels RateLimitExceeded", () => {
  it("is Bybit's refusal of this location, by its words — in exchange.ts as in this file — held back ten minutes, in Bybit's words without the library's request line", () => {
    // exchange.ts judges the words before the label: the region sentence is within the first 240 characters it reads
    const byCode = exchangeSaidNo("bybit", "Bybit", bybit403(), {});
    expect(byCode).toMatchObject({ code: "E_VENUE_GEOBLOCKED", venue: "bybit", native: { error: "RateLimitExceeded" } });
    expect(holdBackMs(byCode)).toBe(600_000);
    const own = exchangeNo("bybit", "Bybit", bybit403());
    expect(own).toEqual({ ...byCode, native: { error: "RateLimitExceeded", said: BYBIT_SAID } });
    // Binance's 451: its sentence whole (exchange.ts reads to the end of it), after the library's line
    expect(exchangeNo("binance", "Binance", binance451())).toMatchObject({ code: "E_VENUE_GEOBLOCKED", native: { error: "ExchangeNotAvailable", said: `{ "code": 0, "msg": "${BINANCE_SAID}"` } });
  });

  it("is still a refusal of this location when the edge's words come further in than exchange.ts reads (an HTML page): the words decide, not the label", () => {
    // CloudFront's standard error page, the shape its 403 takes for other sites — made up here: Bybit's own was 96 bytes on 2026-10-08
    const page = `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN" "http://www.w3.org/TR/html4/loose.dtd"><HTML><HEAD><META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=iso-8859-1"><TITLE>ERROR: The request could not be satisfied</TITLE></HEAD><BODY><H1>403 ERROR</H1><H2>The request could not be satisfied.</H2><HR noshade size="1px">The Amazon CloudFront distribution is configured to block access from your country.</BODY></HTML>`;
    const err = () => Object.assign(new Error(`bybit GET https://api.bybit.com/v5/market/instruments-info?category=spot 403 Forbidden ${page}`), { name: "RateLimitExceeded" });
    // exchange.ts alone reads 240 characters, misses the sentence, and the label wins: twenty seconds
    expect(exchangeSaidNo("bybit", "Bybit", err(), {}).code).toBe("E_VENUE_UNREACHABLE");
    const r = exchangeNo("bybit", "Bybit", err());
    expect(r).toMatchObject({ code: "E_VENUE_GEOBLOCKED", message: "Bybit does not serve this location: that is its own rule, and the account does not look for a way around it", native: { error: "RateLimitExceeded", said: expect.stringContaining("The Amazon CloudFront distribution is configured to block access from your country") } });
    expect(String((r.native as { said: string }).said)).not.toMatch(/<|https?:\/\//);
    expect(holdBackMs(r)).toBe(600_000);
  });

  it("holds Bybit's tickers back ten minutes — another search, the 24 hours, the bars: not one more load — and asks again after", async () => {
    let now = NOW;
    const by = refusing(bybit403);
    const bybit = exchangeTickers("bybit", { open: by.open, clock: () => now });
    const first = (await bybit.listings({ limit: 5 })) as Refusal;
    expect(first).toMatchObject({ code: "E_VENUE_GEOBLOCKED", venue: "bybit", message: "Bybit does not serve this location: that is its own rule, and the account does not look for a way around it", native: { error: "RateLimitExceeded", said: BYBIT_SAID } });
    now += 9 * MIN;
    expect(await bybit.listings({ q: "eth", limit: 5 })).toBe(first);
    expect(await bybit.stats!(["BTC/USDT", "ETH/USDT"])).toBe(first);
    expect(await bybit.candles!("BTC/USDT", "1h", now - 24 * HOUR)).toBe(first);
    expect(by.counts).toEqual({ loads: 1, reloads: 0, tickers: 0, bars: 0 });
    // past the ten minutes: asked again, the markets loaded afresh
    now += 2 * MIN;
    await bybit.listings({ q: "eth", limit: 5 });
    expect(by.counts).toMatchObject({ loads: 2, reloads: 1 });
  });
});

describe("pre-IPO perpetuals at Binance and Bybit, from their documented shapes", () => {
  it("Binance: its USDⓈ-M list once, a perpetual named for a company (whatever contractType it carries, never a dated future, never SpaceX), each with its 24 hours and its funding — in the $1,000,000,000 unit", async () => {
    let now = NOW;
    const net = network([
      ["/fapi/v1/exchangeInfo", json(BN_INFO)],
      ["/fapi/v1/ticker/24hr?symbol=ANTHROPICUSDT", json(BN_DAY("ANTHROPICUSDT", "1985.40", "-41.20", "-2.033", "48210331.55"))],
      ["/fapi/v1/ticker/24hr?symbol=OPENAIUSDT", json(BN_DAY("OPENAIUSDT", "1607.10", "-35.60", "-2.167", "21877410.03"))],
      ["/fapi/v1/ticker/24hr?symbol=OURAUSDT", json(BN_DAY("OURAUSDT", "48.62", "-0.31", "-0.634", "311203.80"))],
      ["/fapi/v1/premiumIndex?symbol=ANTHROPICUSDT", json(BN_MARK("ANTHROPICUSDT", "1985.02"))],
      ["/fapi/v1/premiumIndex?symbol=OPENAIUSDT", json(BN_MARK("OPENAIUSDT", "1606.90"))],
      // the funding is a second request: refusing, it leaves the price standing
      ["/fapi/v1/premiumIndex?symbol=OURAUSDT", { status: 429, body: undefined, text: "Too many requests" }],
    ]);
    const bn = preIpoPublic(venueOf("binance"), { http: net.http, clock: () => now });
    expect(bn).toMatchObject({ id: "binance-preipo", name: "Binance", kind: "exchange", connectTo: "binance", connector: "live:exchange:binance" });
    const got = (await bn.listings({ limit: 10 })) as Listing[];
    expect(got.map((m) => m.symbol)).toEqual(["ANTHROPIC/USDT:USDT", "OPENAI/USDT:USDT", "OURA/USDT:USDT"]);
    expect(got[0]).toEqual({ symbol: "ANTHROPIC/USDT:USDT", name: "Anthropic pre-IPO perpetual on Binance", kind: "perp", base: "ANTHROPIC", quote: "USDT", price: 1985.4, bid: undefined, ask: undefined, open: true, types: [], changePct24h: -2.033, change24h: -41.2, volumeUsd24h: 48210331.55, fundingRate: 0.00005, nextFundingAt: "2026-10-09T00:00:00.000Z", category: "Pre-IPO", group: { id: "preipo:anthropic", title: "Anthropic" }, implied: { perPoint: 1_000_000_000, unit: UNIT, usd: 1_985_400_000_000 }, issuer: "Anthropic", eligibility: PRE_IPO_ISSUERS.anthropic!.eligibility });
    expect(got[1]).toMatchObject({ name: "OpenAI pre-IPO perpetual on Binance", implied: { usd: 1_607_100_000_000 }, issuer: "OpenAI" });
    expect(got[2]).toMatchObject({ price: 48.62, group: { id: "preipo:oura" } });
    expect(got[2]!.fundingRate).toBeUndefined();
    // GETs to Binance's futures host only: the list, then two small requests a contract
    expect(net.sent.every((s) => s.method === "GET" && new URL(s.url).host === "fapi.binance.com")).toBe(true);
    expect(net.sent).toHaveLength(7);
    // the list kept ten minutes, the prices ninety seconds
    now += KEEP_MS + 1_000;
    await bn.listings({ limit: 10 });
    expect(net.sent).toHaveLength(13);
    expect(net.sent.filter((s) => s.url.endsWith("/exchangeInfo"))).toHaveLength(1);
    now += LIST_MS;
    await bn.listings({ limit: 10 });
    expect(net.sent.filter((s) => s.url.endsWith("/exchangeInfo"))).toHaveLength(2);
  });

  it("Bybit: its linear list page by page while it gives a cursor, a LinearPerpetual named for a company with its leverage, each with its ticker's book, 24 hours and funding; a retCode other than 0 is a no in its retMsg", async () => {
    const net = network([
      ["/v5/market/instruments-info?category=linear&limit=1000", (url) => json(BY_PAGES[new URL(url).searchParams.get("cursor") ?? ""] ?? BY_PAGE([], ""))],
      ["/v5/market/tickers?category=linear&symbol=ANTHROPICUSDT", json(BY_TICK("ANTHROPICUSDT", "1987.10", "2030.00", "1987.00", "1987.20", "35511230.12"))],
      ["/v5/market/tickers?category=linear&symbol=OPENAIUSDT", json(BY_TICK("OPENAIUSDT", "1605.80", "1650.00", "1605.70", "1605.90", "18204471.40"))],
      ["/v5/market/tickers?category=linear&symbol=OURAUSDT", json({ retCode: 10001, retMsg: "params error: symbol invalid", result: {}, retExtInfo: {}, time: NOW })],
    ]);
    const by = preIpoPublic(venueOf("bybit"), { http: net.http, clock: () => NOW });
    expect(by).toMatchObject({ id: "bybit-preipo", name: "Bybit", connectTo: "bybit", connector: "live:exchange:bybit" });
    const got = (await by.listings({ limit: 10 })) as Listing[];
    // BTCUSDT is no company; BTCUSDT-26DEC26 is a dated future; OURAUSDT's ticker said no, so it is left out while the others answer
    expect(got.map((m) => m.symbol)).toEqual(["ANTHROPIC/USDT:USDT", "OPENAI/USDT:USDT"]);
    expect(got[0]).toMatchObject({ name: "Anthropic pre-IPO perpetual on Bybit", base: "ANTHROPIC", quote: "USDT", price: 1987.1, bid: 1987, ask: 1987.2, open: true, change24h: -42.9, changePct24h: -2.1133, volumeUsd24h: 35511230.12, fundingRate: 0.00005, nextFundingAt: "2026-10-08T20:00:00.000Z", maxLeverage: 20, implied: { perPoint: 1_000_000_000, unit: UNIT, usd: 1_987_100_000_000 }, issuer: "Anthropic" });
    // the two pages, then a ticker for each contract: GETs to Bybit's host only
    expect(net.sent.map((s) => s.url.replace("https://api.bybit.com/v5/market/", ""))).toEqual(["instruments-info?category=linear&limit=1000", "instruments-info?category=linear&limit=1000&cursor=cursor-2", "tickers?category=linear&symbol=ANTHROPICUSDT", "tickers?category=linear&symbol=OPENAIUSDT", "tickers?category=linear&symbol=OURAUSDT"]);
    // a list answered with a retCode is Bybit's refusal, in its own words
    const bad = network([["/v5/market/instruments-info", json({ retCode: 10006, retMsg: "Too many visits!", result: {}, retExtInfo: {}, time: NOW })]]);
    const r = await preIpoPublic(venueOf("bybit"), { http: bad.http, clock: () => NOW }).listings({ limit: 5 });
    expect(r).toMatchObject({ code: "E_VENUE_REJECTED", venue: "bybit-preipo", message: "Bybit refused the request (retCode 10006)", native: { status: 200, said: '{"retCode":10006,"retMsg":"Too many visits!"}' } });
  });

  it("Binance's 451 and Bybit's 403 are each its own refusal of this location, in its own words — Binance's sentence whole — said once and held back ten minutes", async () => {
    let now = NOW;
    const bnNet = network([["fapi.binance.com", { status: 451, body: JSON.parse(BINANCE_451_BODY) as unknown, text: BINANCE_451_BODY }]]);
    const byNet = network([["api.bybit.com", { status: 403, body: undefined, text: BYBIT_403_BODY }]]);
    const bn = preIpoPublic(venueOf("binance"), { http: bnNet.http, clock: () => now });
    const by = preIpoPublic(venueOf("bybit"), { http: byNet.http, clock: () => now });
    const [a, b] = await Promise.all([bn.listings({ limit: 5 }), by.listings({ limit: 5 })]);
    expect(a).toMatchObject({ code: "E_VENUE_GEOBLOCKED", venue: "binance-preipo", message: "Binance does not serve this location: that is its own rule, and the account does not look for a way around it", native: { status: 451, said: `{ "code": 0, "msg": "${BINANCE_SAID}" }` } });
    expect(b).toMatchObject({ code: "E_VENUE_GEOBLOCKED", venue: "bybit-preipo", message: "Bybit does not serve this location: that is its own rule, and the account does not look for a way around it", native: { status: 403, said: BYBIT_SAID } });
    expect(isRefusal(a) && holdBackMs(a)).toBe(600_000);
    // one request each, then nothing for ten minutes — a search included — then asked again
    now += 9 * MIN;
    await Promise.all([bn.listings({ limit: 5 }), by.listings({ q: "anthropic", limit: 5 })]);
    expect([bnNet.sent.length, byNet.sent.length]).toEqual([1, 1]);
    now += 2 * MIN;
    await Promise.all([bn.listings({ limit: 5 }), by.listings({ limit: 5 })]);
    expect([bnNet.sent.length, byNet.sent.length]).toEqual([2, 2]);
  });

  it("asks only the fixed hosts, Binance's futures host and Bybit's v5 host among them", () => {
    expect(PUBLIC_HOSTS.slice(-2)).toEqual(["fapi.binance.com", "api.bybit.com"]);
  });
});

describe("Hyperliquid's HIP-3 pre-IPO perpetuals, keyless", () => {
  it("reads the dexes, Hyperliquid's categories and every dex's list, and lists each market named for a company — not delisted, not filed under another category, held or traded — as <dex>:<COIN>-PERP on a line named for the deployer's dex, with the valuation its price implies", async () => {
    const net = hip3Net();
    const hl = hyperliquidPreIpoPublic({ http: net.http, clock: () => NOW });
    expect(hl).toMatchObject({ id: "hyperliquid-preipo", name: "Hyperliquid", kind: "exchange", connectTo: "hyperliquid-trade", connector: "live:hyperliquid-trade" });
    const got = (await hl.listings({ limit: 10 })) as Listing[];
    // every request a POST of a body built from its fields, to the one URL
    expect(net.sent.every((s) => s.url === "https://api.hyperliquid.xyz/info" && s.method === "POST")).toBe(true);
    expect(net.sent.slice(0, 2).map((s) => s.body)).toEqual([{ type: "perpDexs" }, { type: "perpCategories" }]);
    expect(net.sent.slice(2).map((s) => s.body)).toEqual(["xyz", "flx", "vntl", "para", "mkts", "io"].map((dex) => ({ type: "metaAndAssetCtxs", dex })));
    // io:SNDK names no company; io:SBE, xyz:YMTC, vntl:* and para:ANTH are delisted; xyz:SPCX is SpaceX, public; mkts:POLYMARKET nobody
    // holds or trades; mkts:KALSHI Hyperliquid files under stocks
    expect(got.map((m) => [m.symbol, m.venueName])).toEqual([
      ["io:ANTH-PERP", "Hyperliquid · io"],
      ["io:OAI-PERP", "Hyperliquid · io"],
      ["xyz:OURA-PERP", "Hyperliquid · xyz"],
    ]);
    expect(got[0]).toEqual({ symbol: "io:ANTH-PERP", name: "Anthropic pre-IPO perpetual on Hyperliquid · io", kind: "perp", base: "ANTH", quote: "USDC", price: 2044.55, bid: undefined, ask: undefined, open: true, types: [], changePct24h: -3.6726, change24h: -77.95, volumeUsd24h: Number("11791556.5899999943"), fundingRate: 0.0000185782, nextFundingAt: "2026-10-08T19:00:00.000Z", maxLeverage: 6, category: "Pre-IPO", group: { id: "preipo:anthropic", title: "Anthropic" }, implied: { perPoint: 1_000_000_000, unit: UNIT, usd: 2_044_550_000_000 }, issuer: "Anthropic", eligibility: PRE_IPO_ISSUERS.anthropic!.eligibility, venueName: "Hyperliquid · io" });
    expect(got[1]).toMatchObject({ base: "OAI", price: 1644.65, change24h: -86.45, changePct24h: -4.9939, maxLeverage: 6, group: { id: "preipo:openai", title: "OpenAI" }, implied: { usd: 1_644_650_000_000 }, issuer: "OpenAI" });
    expect(got[2]).toMatchObject({ name: "Oura pre-IPO perpetual on Hyperliquid · xyz", base: "OURA", price: 48.551, change24h: -0.38, changePct24h: -0.7766, volumeUsd24h: 17688.0185, fundingRate: 0.0000011593, maxLeverage: 5, group: { id: "preipo:oura" }, implied: { usd: 48_551_000_000 } });
    expect(hl.notes!({})).toEqual(["Hyperliquid · io, xyz: pre-IPO perpetuals on Hyperliquid's HIP-3 markets, which anyone may deploy; shown while someone holds or trades one."]);
    expect(hl.notes!({})[0]!.length).toBeLessThan(160);
    // a search: the company's name or the coin
    expect(((await hl.listings({ q: "openai", limit: 10 })) as Listing[]).map((m) => m.symbol)).toEqual(["io:OAI-PERP"]);
    expect(((await hl.listings({ q: "xyz:oura", limit: 10 })) as Listing[]).map((m) => m.symbol)).toEqual(["xyz:OURA-PERP"]);
    expect(net.sent).toHaveLength(8);
  });

  it("asks again every ninety seconds only of the dexes that hold one, and reads every dex's list again after ten minutes", async () => {
    let now = NOW;
    const net = hip3Net();
    const hl = hyperliquidPreIpoPublic({ http: net.http, clock: () => now });
    await hl.listings({ limit: 10 });
    await hl.listings({ limit: 10 });
    expect(net.sent).toHaveLength(8);
    now += KEEP_MS + 1_000;
    await hl.listings({ limit: 10 });
    // xyz, mkts (its POLYMARKET is a company's, so it is watched until someone trades it) and io; not the dexes holding none
    expect(net.asked("metaAndAssetCtxs").slice(6)).toEqual(["xyz", "mkts", "io"]);
    expect(net.asked("perpDexs")).toHaveLength(1);
    now += LIST_MS;
    await hl.listings({ limit: 10 });
    expect(net.asked("perpDexs")).toHaveLength(2);
    expect(net.asked("perpCategories")).toHaveLength(2);
  });

  it("without Hyperliquid's categories a company's name alone decides this time, and the lists are read again after ninety seconds; a dex that does not answer is left out while the others stand", async () => {
    let now = NOW;
    const unfiled = hip3Net({ perpCategories: { status: 500, body: null, text: "null" } });
    const hl = hyperliquidPreIpoPublic({ http: unfiled.http, clock: () => now });
    // mkts:KALSHI is filed under stocks only in the answer that did not come: by its name it is Kalshi's
    expect(((await hl.listings({ limit: 10 })) as Listing[]).map((m) => m.symbol)).toEqual(["io:ANTH-PERP", "io:OAI-PERP", "mkts:KALSHI-PERP", "xyz:OURA-PERP"]);
    now += KEEP_MS + 1_000;
    await hl.listings({ limit: 10 });
    expect(unfiled.asked("perpDexs")).toHaveLength(2);

    const ioDown = hip3Net({ "dex:io": { status: 429, body: undefined, text: "Too many requests" } });
    const one = hyperliquidPreIpoPublic({ http: ioDown.http, clock: () => NOW });
    expect(((await one.listings({ limit: 10 })) as Listing[]).map((m) => m.symbol)).toEqual(["xyz:OURA-PERP"]);
  });

  it("Hyperliquid's own refusal of its dex list is its refusal, said once and held back ten minutes", async () => {
    let now = NOW;
    const net = hip3Net({ perpDexs: { status: 403, body: undefined, text: "This service is not available in your country" } });
    const hl = hyperliquidPreIpoPublic({ http: net.http, clock: () => now });
    expect(await hl.listings({ limit: 5 })).toMatchObject({ code: "E_VENUE_GEOBLOCKED", venue: "hyperliquid-preipo", message: "Hyperliquid does not serve this location: that is its own rule, and the account does not look for a way around it", native: { status: 403, said: "This service is not available in your country" } });
    now += 9 * MIN;
    await hl.listings({ q: "anthropic", limit: 5 });
    expect(net.asked("perpDexs")).toHaveLength(1);
  });

  it("reads a HIP-3 market's bars by its dex-prefixed coin, and each Hyperliquid source refuses the other's names before asking", async () => {
    const net = hip3Net();
    const hl = hyperliquidPreIpoPublic({ http: net.http, clock: () => NOW });
    const bars = (await hl.candles!("io:ANTH-PERP", "1h", NOW - 6 * HOUR)) as Candle[];
    expect(net.sent.map((s) => s.body)).toEqual([{ type: "candleSnapshot", req: { coin: "io:ANTH", interval: "1h", startTime: NOW - 6 * HOUR, endTime: NOW } }]);
    expect(bars).toEqual([
      { t: 1791460800000, o: 2102, h: 2109.3, l: 2101.4, c: 2108.5, v: 126.631 },
      { t: 1791464400000, o: 2108.6, h: 2113.6, l: 2106, c: 2112.9, v: 145.573 },
    ]);
    expect(await hl.candles!("BTC-PERP", "1h", NOW - HOUR)).toMatchObject({ code: "E_ACCOUNT_BAD_ACTION", message: 'a Hyperliquid perpetual here is <dex>:<COIN>-PERP (io:ANTH-PERP), not "BTC-PERP"' });
    expect(await hyperliquidPublic({ http: net.http, clock: () => NOW }).candles!("io:ANTH-PERP", "1h", NOW - HOUR)).toMatchObject({ code: "E_ACCOUNT_BAD_ACTION" });
    expect(net.sent).toHaveLength(1);
  });
});

describe("the unit, read against the other venues", () => {
  it("prices Hyperliquid's io:ANTH and io:OAI, Binance's and Bybit's in the $1,000,000,000 unit, and OKX's two rebased swaps in its ×10 one: on 2026-10-08 they agree", () => {
    // the six venues' Anthropic that day, read from this machine: OKX 204.38 (×10), Gate 2,036.51, Kraken 1,977.62, Deribit 1,979.86,
    // KuCoin 1,987.72, MEXC 1,977.51 — implied valuations, in billions
    const six = [204.38 * (OKX_REBASED_PER_POINT / 1e9), 2036.51, 1977.62, 1979.86, 1987.72, 1977.51].sort((a, b) => a - b);
    const median = (six[2]! + six[3]!) / 2;
    expect(median).toBeCloseTo(1983.79, 2);
    // io:ANTH's mid that day, in the $1B unit, is 3% from it; read ×10 or ÷10 it would be nothing like it
    expect(Math.abs(2044.55 / median - 1)).toBeLessThan(0.1);
    expect(Math.abs((2044.55 * 10) / median - 1)).toBeGreaterThan(0.1);
    expect(Math.abs(2044.55 / 10 / median - 1)).toBeGreaterThan(0.1);
  });
});
