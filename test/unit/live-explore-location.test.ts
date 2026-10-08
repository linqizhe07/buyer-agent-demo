import { describe, expect, it } from "vitest";
import { exploreAcross, type ExploreVenue } from "../../src/portfolio/live/explore.ts";
import { exchangeTickers, hyperliquidPreIpoPublic, hyperliquidPublic, preIpoPublic, type Listing, type PublicSource } from "../../src/portfolio/live/public-markets.ts";
import type { LiveTrader, Market } from "../../src/portfolio/live/trade.ts";
import { BINANCE_451_BODY, BINANCE_SAID, BN_DAY, BN_INFO, BN_MARK, BY_PAGES, BY_PAGE, BY_TICK, BYBIT_403_BODY, BYBIT_SAID, binance451, bybit403, hip3Net, json, MIN, network, NOW, refusing, UNIT, venueOf } from "./live-public-markets-fixtures.ts";

/** Markets, wherever this machine is: the pre-IPO company row across the eight exchanges and Hyperliquid's HIP-3 deployers (one line each,
 * each in its own unit, the median guard on the implied valuation), and the venues that do not serve this location in `missing`, in their
 * own words, without holding up the read. Real sources over stand-in networks and a stand-in exchange library (the fixtures say which
 * answers are documented shapes and which are Hyperliquid's live answers of 2026-10-08); nothing leaves the process, no key exists here. */

const clock = () => NOW;
const OKX_UNIT = "OKX: a price of $1 stands for $10,000,000,000 of implied company valuation since its 10:1 rebase of 30 June 2026";
const anthropic = { id: "preipo:anthropic", title: "Anthropic" };
const eligibility = "Anthropic, 29 June 2026: unapproved transfers are void";

/** one of the six venues read from this machine, as public-markets.ts lists its Anthropic contract (their prices of 2026-10-08) */
function six(id: string, name: string, symbol: string, base: string, quote: string, price: number, perPoint: number, volume: number): PublicSource {
  const listing: Listing = { symbol, name: `Anthropic pre-IPO perpetual on ${name}`, kind: "perp", base, quote, price, open: true, types: [], volumeUsd24h: volume, changePct24h: -2.5, category: "Pre-IPO", group: anthropic, implied: { perPoint, unit: perPoint === 1e10 ? OKX_UNIT : UNIT, usd: Math.round(price * perPoint) }, issuer: "Anthropic", eligibility };
  const venue = id.replace(/-preipo$/, "");
  return { id, name, kind: "exchange", connectTo: venue, connector: `live:exchange:${venue}`, listings: async () => [listing] };
}
const SIX = (): PublicSource[] => [
  six("okx-preipo", "OKX", "ANTHROPIC/USDT:USDT", "ANTHROPIC", "USDT", 204.38, 1e10, 0),
  six("gate-preipo", "Gate", "ANTHROPIC/USDT:USDT", "ANTHROPIC", "USDT", 2036.51, 1e9, 651_204),
  six("krakenfutures-preipo", "Kraken Futures", "ANTHROPICX/USD:USD", "ANTHROPICx", "USD", 1977.62, 1e9, 139_436),
  six("deribit-preipo", "Deribit", "ANTH/USDC:USDC", "ANTH", "USDC", 1979.86, 1e9, 330_972),
  six("kucoinfutures-preipo", "KuCoin Futures", "ANTHROPIC/USDT:USDT", "ANTHROPIC", "USDT", 1987.72, 1e9, 1_686_152),
  six("mexc-preipo", "MEXC", "ANTHROPIC/USDT:USDT", "ANTHROPIC", "USDT", 1977.51, 1e9, 626_470),
];

/** Binance and Bybit, wherever they serve, answering their documented shapes; `anthropicAt` is Binance's last price for ANTHROPICUSDT */
function binanceAnswering(anthropicAt = "1985.40") {
  return network([
    ["/fapi/v1/exchangeInfo", json(BN_INFO)],
    ["/fapi/v1/ticker/24hr?symbol=ANTHROPICUSDT", json(BN_DAY("ANTHROPICUSDT", anthropicAt, "-41.20", "-2.033", "48210331.55"))],
    ["/fapi/v1/premiumIndex?symbol=ANTHROPICUSDT", json(BN_MARK("ANTHROPICUSDT", anthropicAt))],
    ["/fapi/v1/", { status: 400, body: { code: -1121, msg: "Invalid symbol." }, text: '{"code":-1121,"msg":"Invalid symbol."}' }],
  ]);
}
function bybitAnswering() {
  return network([
    ["/v5/market/instruments-info?category=linear&limit=1000", (url) => json(BY_PAGES[new URL(url).searchParams.get("cursor") ?? ""] ?? BY_PAGE([], ""))],
    ["/v5/market/tickers?category=linear&symbol=ANTHROPICUSDT", json(BY_TICK("ANTHROPICUSDT", "1987.10", "2030.00", "1987.00", "1987.20", "35511230.12"))],
    ["/v5/market/tickers", json({ retCode: 10001, retMsg: "params error: symbol invalid", result: {}, retExtInfo: {}, time: NOW })],
  ]);
}

describe("a pre-IPO company across every venue, wherever this machine is", () => {
  it("is one row: the six, Binance and Bybit where they serve, and Hyperliquid's io — each line its own contract price and implied valuation, the HIP-3 line named for its dex and traded through Hyperliquid's connection", async () => {
    const bn = binanceAnswering();
    const by = bybitAnswering();
    const hl = hip3Net();
    const sources = [...SIX(), preIpoPublic(venueOf("binance"), { http: bn.http, clock }), preIpoPublic(venueOf("bybit"), { http: by.http, clock }), hyperliquidPreIpoPublic({ http: hl.http, clock })];
    const out = await exploreAcross({ public: sources }, { clock, tab: "preipo" });
    const row = out.items.find((i) => i.key === "preipo:anthropic")!;
    expect(row.at.map((a) => [a.venue, a.venueName, a.symbol, a.price, a.implied?.usd])).toEqual([
      ["binance-preipo", "Binance", "ANTHROPIC/USDT:USDT", 1985.4, 1_985_400_000_000],
      ["bybit-preipo", "Bybit", "ANTHROPIC/USDT:USDT", 1987.1, 1_987_100_000_000],
      ["hyperliquid-preipo", "Hyperliquid · io", "io:ANTH-PERP", 2044.55, 2_044_550_000_000],
      ["kucoinfutures-preipo", "KuCoin Futures", "ANTHROPIC/USDT:USDT", 1987.72, 1_987_720_000_000],
      ["gate-preipo", "Gate", "ANTHROPIC/USDT:USDT", 2036.51, 2_036_510_000_000],
      ["mexc-preipo", "MEXC", "ANTHROPIC/USDT:USDT", 1977.51, 1_977_510_000_000],
      ["deribit-preipo", "Deribit", "ANTH/USDC:USDC", 1979.86, 1_979_860_000_000],
      ["krakenfutures-preipo", "Kraken Futures", "ANTHROPICX/USD:USD", 1977.62, 1_977_620_000_000],
      ["okx-preipo", "OKX", "ANTHROPIC/USDT:USDT", 204.38, 2_043_800_000_000],
    ]);
    // the HIP-3 line: Hyperliquid's own venue for its bars, the deployer's dex in its name, the connection to trade it
    expect(row.at.find((a) => a.venue === "hyperliquid-preipo")).toMatchObject({ connected: false, canTrade: false, public: true, connectTo: "hyperliquid-trade", connector: "live:hyperliquid-trade", implied: { usd: 2_044_550_000_000, unit: UNIT }, issuer: "Anthropic" });
    expect(row.at.find((a) => a.venue === "binance-preipo")).toMatchObject({ connectTo: "binance", connector: "live:exchange:binance" });
    // nine venues, the middle one in billions: Bybit's 1,987.1
    expect(row.implied).toEqual({ usd: 1_987_100_000_000, unit: "the median of 9 venues' implied valuations (each venue's own contract price and unit are on its line)" });
    expect(row.price).toBe(1987.1);
    expect(row.changeFrom).toEqual({ venue: "binance-preipo", venueName: "Binance" });
    expect(out.missing).toEqual([]);
    // OpenAI and Oura are rows of their own (Binance's and Bybit's answer for those two refused here, so they are left out this time)
    const keys = out.items.map((i) => i.key).sort();
    expect(keys).toEqual(["preipo:anthropic", "preipo:openai", "preipo:oura"]);
    expect(out.items.find((i) => i.key === "preipo:oura")!.at.map((a) => a.venueName).sort()).toEqual(["Hyperliquid · xyz"]);
    expect(out.notes).toContain("Hyperliquid · io, xyz: pre-IPO perpetuals on Hyperliquid's HIP-3 markets, which anyone may deploy; shown while someone holds or trades one.");
  });

  it("sets aside a venue whose contract has been resized away from the others (Binance may resize once a filing gives the share count) and says so under the venue's name", async () => {
    // made up: Binance at 1 contract to 1 share of an actual count of 3.5 billion — 567.2 a contract, which its old unit would read as $567B
    const bn = binanceAnswering("567.20");
    const sources = [...SIX(), preIpoPublic(venueOf("binance"), { http: bn.http, clock }), hyperliquidPreIpoPublic({ http: hip3Net().http, clock })];
    const out = await exploreAcross({ public: sources }, { clock, tab: "preipo" });
    const row = out.items.find((i) => i.key === "preipo:anthropic")!;
    expect(row.at.map((a) => a.venue)).not.toContain("binance-preipo");
    expect(row.at).toHaveLength(7);
    expect(out.missing).toEqual([expect.objectContaining({ venue: "binance-preipo", venueName: "Binance", connected: false, symbol: "ANTHROPIC/USDT:USDT", why: expect.stringContaining("an implied 567200000000 in its unit, more than 10% from the other venues'") })]);
  });

  it("says where a move came from by the line's own name when the HIP-3 market is the busiest", async () => {
    const out = await exploreAcross({ public: [...SIX(), hyperliquidPreIpoPublic({ http: hip3Net().http, clock })] }, { clock, tab: "preipo" });
    const row = out.items.find((i) => i.key === "preipo:anthropic")!;
    expect(row.at[0]).toMatchObject({ venue: "hyperliquid-preipo", venueName: "Hyperliquid · io" });
    expect(row.changeFrom).toEqual({ venue: "hyperliquid-preipo", venueName: "Hyperliquid · io" });
    expect(row.changePct24h).toBe(-3.6726);
  });
});

describe("a venue that does not serve this location", () => {
  it("lands in missing in its own words — Binance's 451 and Bybit's CloudFront 403, its tickers and its pre-IPO list alike — inside the read's time, and is not asked again for ten minutes", async () => {
    const bnLib = refusing(binance451);
    const byLib = refusing(bybit403);
    const bnNet = network([["fapi.binance.com", { status: 451, body: JSON.parse(BINANCE_451_BODY) as unknown, text: BINANCE_451_BODY }]]);
    const byNet = network([["api.bybit.com", { status: 403, body: undefined, text: BYBIT_403_BODY }]]);
    const kraken: PublicSource = { id: "kraken", name: "Kraken", kind: "exchange", connectTo: "kraken", connector: "live:exchange:kraken", listings: async () => [{ symbol: "BTC/USD", name: "BTC / USD", kind: "spot", base: "BTC", quote: "USD", price: 100_000, open: true, types: [], volumeUsd24h: 1e9 }] };
    let now = NOW;
    const sources = [kraken, exchangeTickers("binance", { open: bnLib.open, clock: () => now }), exchangeTickers("bybit", { open: byLib.open, clock: () => now }), preIpoPublic(venueOf("binance"), { http: bnNet.http, clock: () => now }), preIpoPublic(venueOf("bybit"), { http: byNet.http, clock: () => now })];
    const started = Date.now();
    // the read's own time limit (four seconds by default): the refusals come back in one round trip each
    const out = await exploreAcross({ public: sources }, { clock: () => now });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(out.items.map((i) => i.key)).toEqual(["coin:BTC"]);
    const where = "does not serve this location: that is its own rule, and the account does not look for a way around it";
    expect(out.missing).toEqual([
      { venue: "binance", venueName: "Binance", why: `Binance ${where}`, code: "E_VENUE_GEOBLOCKED", said: BINANCE_SAID, connected: false },
      { venue: "bybit", venueName: "Bybit", why: `Bybit ${where}`, code: "E_VENUE_GEOBLOCKED", said: BYBIT_SAID, connected: false },
      { venue: "binance-preipo", venueName: "Binance", why: `Binance ${where}`, code: "E_VENUE_GEOBLOCKED", said: BINANCE_SAID, connected: false },
      { venue: "bybit-preipo", venueName: "Bybit", why: `Bybit ${where}`, code: "E_VENUE_GEOBLOCKED", said: BYBIT_SAID, connected: false },
    ]);
    // nine minutes on, another search: each is said the same, and none is asked again
    now += 9 * MIN;
    const again = await exploreAcross({ public: sources }, { clock: () => now, q: "anthropic" });
    expect(again.missing.map((m) => m.venue)).toEqual(["binance", "bybit", "binance-preipo", "bybit-preipo"]);
    expect([bnLib.counts.loads, byLib.counts.loads, bnNet.sent.length, byNet.sent.length]).toEqual([1, 1, 1, 1]);
  });

  it("that does not answer at all is said as that when the read's time is up, and the rest is shown", async () => {
    const hang: PublicSource = { id: "bybit", name: "Bybit", kind: "exchange", connectTo: "bybit", connector: "live:exchange:bybit", listings: () => new Promise<never>(() => undefined) };
    const started = Date.now();
    const out = await exploreAcross({ public: [...SIX().slice(1, 2), hang] }, { clock, timeoutMs: 50 });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(out.items.map((i) => i.key)).toEqual(["preipo:anthropic"]);
    expect(out.missing).toEqual([{ venue: "bybit", venueName: "Bybit", why: "did not answer in 0.05 s", code: "E_VENUE_UNREACHABLE", connected: false }]);
  });
});

describe("Hyperliquid connected to trade", () => {
  it("speaks for both Hyperliquid listings: neither its perpetuals nor its HIP-3 pre-IPO ones are asked of the public sources", async () => {
    const net = hip3Net();
    const trader: LiveTrader = {
      can: true,
      what: "Hyperliquid perpetuals and HIP-3 markets",
      markets: async (): Promise<Market[]> => [],
      market: async () => {
        throw new Error("not asked");
      },
      place: async () => {
        throw new Error("not asked");
      },
      cancel: async () => {
        throw new Error("not asked");
      },
      status: async () => {
        throw new Error("not asked");
      },
    };
    const connected: ExploreVenue[] = [{ id: "hyperliquid-trade", name: "Hyperliquid", trader, connector: "live:hyperliquid-trade" }];
    await exploreAcross({ connected, public: [hyperliquidPublic({ http: net.http, clock }), hyperliquidPreIpoPublic({ http: net.http, clock })] }, { clock });
    expect(net.sent).toEqual([]);
    // not connected: both are read
    await exploreAcross({ public: [hyperliquidPublic({ http: net.http, clock }), hyperliquidPreIpoPublic({ http: net.http, clock })] }, { clock });
    expect(net.sent.map((s) => (s.body as { type: string }).type)).toContain("perpDexs");
  });
});
