import { describe, expect, it } from "vitest";
import type { Refusal } from "../../src/core/errors.ts";
import { no } from "../../src/portfolio/refuse.ts";
import { compareAcross, normalBase, type CompareVenue } from "../../src/portfolio/live/compare.ts";
import { pick, type LiveTrader, type Market, type MarketKind } from "../../src/portfolio/live/trade.ts";

/** The same thing priced at every venue the user has connected, with every venue a stand-in trader: it lists the markets the test gives
 * it, answers a fresh price from what the test says, and records every call. Nothing leaves the process; no key exists in this file. */

const mk = (symbol: string, kind: MarketKind, base: string, quote: string, extra: Partial<Market> = {}): Market => ({ symbol, name: `${base} / ${quote}`, kind, base, quote, open: true, types: ["market", "limit"], ...extra });

type Answer = Partial<Market> | Refusal | "hang" | "throw";
interface Stand extends LiveTrader {
  calls: string[];
}

/** a trader that lists `listed`, and answers market(symbol) with the listed market and the fresh fields in `fresh` (or a refusal, a throw, or
 * no answer ever); `listing: "hang"` never answers the list */
function stand(listed: Market[], fresh: Record<string, Answer> = {}, o: { listing?: "hang" | Refusal | "throw"; can?: boolean | "unknown"; whyNot?: string } = {}): Stand {
  const calls: string[] = [];
  const never = <T,>() => new Promise<T>(() => undefined);
  return {
    calls,
    can: o.can ?? true,
    ...(o.whyNot ? { whyNot: o.whyNot } : {}),
    what: "stand-in",
    async markets(query) {
      calls.push(`markets:${query}`);
      if (o.listing === "hang") return never<Market[]>();
      if (o.listing === "throw") throw new Error("socket hang up");
      if (o.listing) return o.listing;
      return pick(listed, query);
    },
    async market(symbol) {
      calls.push(`market:${symbol}`);
      const a = fresh[symbol];
      if (a === "hang") return never<Market>();
      if (a === "throw") throw new Error("boom");
      if (a && "ok" in a && a.ok === false) return a as Refusal;
      const m = listed.find((x) => x.symbol === symbol);
      if (!m) return no("E_VENUE_REJECTED", { message: `no market ${symbol}` });
      return { ...m, ...(a as Partial<Market> | undefined) };
    },
    async place() {
      throw new Error("a comparison never places an order");
    },
    async cancel() {
      throw new Error("a comparison never cancels an order");
    },
    async status() {
      throw new Error("a comparison never asks after an order");
    },
  };
}

const venue = (id: string, name: string, trader: LiveTrader): CompareVenue => ({ id, name, trader });

/** three venues, three names for BTC: an exchange's BTC/USDT (and its perpetual), Robinhood Crypto's BTC-USD, a wallet's WBTC on Arbitrum */
function threeBtc() {
  const ex = stand(
    [mk("BTC/USDT", "spot", "BTC", "USDT"), mk("BTC/USDT:USDT", "perp", "BTC", "USDT", { contractSize: 0.001 }), mk("ETH/USDT", "spot", "ETH", "USDT"), mk("BTCDOM/USDT:USDT", "perp", "BTCDOM", "USDT"), mk("BTC/EUR", "spot", "BTC", "EUR")],
    { "BTC/USDT": { bid: 120_990, ask: 121_010, price: 121_000, note: "maker 0.10%, taker 0.10%" }, "BTC/USDT:USDT": { bid: 100_000, ask: 100_001 } },
  );
  const rh = stand([mk("BTC-USD", "crypto", "BTC", "USD"), mk("ETH-USD", "crypto", "ETH", "USD")], { "BTC-USD": { bid: 121_020, ask: 121_060, price: 121_040 } });
  const dex = stand([mk("WBTC/USDC@Arbitrum", "token", "WBTC", "USDC", { types: ["market"] }), mk("cbBTC/USDC@Base", "token", "cbBTC", "USDC", { types: ["market"] })], {
    "WBTC/USDC@Arbitrum": { bid: 120_950, ask: 120_980, note: "prices are for about $100 and include the aggregator's fee, not the network fee" },
    "cbBTC/USDC@Base": { bid: 120_900, ask: 121_100 },
  });
  return { ex, rh, dex, venues: [venue("binance", "Binance", ex), venue("robinhood", "Robinhood", rh), venue("wallet", "MetaMask", dex)] };
}

describe("normalBase: one name for one thing", () => {
  it("names a coin the same whatever the venue calls it, from its base or its symbol", () => {
    for (const b of ["BTC", "XBT", "WBTC", "cbBTC", "BTCB", "btc"]) expect(normalBase(b, "spot")).toBe("BTC");
    for (const b of ["ETH", "WETH"]) expect(normalBase(b, "token")).toBe("ETH");
    expect(normalBase("USDC.e", "token")).toBe("USDC");
    expect(normalBase("BTC/USDT", "spot")).toBe("BTC");
    expect(normalBase("BTC/USDT:USDT", "perp")).toBe("BTC");
    expect(normalBase("BTC-USD", "crypto")).toBe("BTC");
    expect(normalBase("WBTC/USDC@Arbitrum", "token")).toBe("BTC");
    expect(normalBase("XBT/USD", "spot")).toBe("BTC");
  });
  it("keeps what is not the same thing apart: staked ETH, another coin, a stock's ticker, an event contract", () => {
    expect(normalBase("stETH", "token")).toBe("STETH");
    expect(normalBase("BTCDOM", "perp")).toBe("BTCDOM");
    expect(normalBase("AAPL", "stock")).toBe("AAPL");
    expect(normalBase("BRK.B", "stock")).toBe("BRK.B");
    expect(normalBase("BTC-PERP", "perp")).toBe("BTC-PERP");
    expect(normalBase("KXBTC-25DEC-T120000:YES", "event")).toBe("");
    expect(normalBase("BTC", "event")).toBe("");
    expect(normalBase("", "spot")).toBe("");
  });
});

describe("compareAcross: where the same thing is cheapest", () => {
  it("a buy ranks BTC across three venues by the ask, under three names, and marks the best", async () => {
    const { ex, rh, dex, venues } = threeBtc();
    const c = await compareAcross(venues, "BTC", "buy");
    expect(c.base).toBe("BTC");
    expect(c.missing).toEqual([]);
    expect(c.rows.map((r) => [r.venue, r.symbol, r.price, r.priceIs])).toEqual([
      ["wallet", "WBTC/USDC@Arbitrum", 120_980, "ask"],
      ["binance", "BTC/USDT", 121_010, "ask"],
      ["robinhood", "BTC-USD", 121_060, "ask"],
    ]);
    const [best, second, third] = c.rows;
    expect(best!.best).toBe(true);
    expect(best!.worse).toBeUndefined();
    expect(second!.best).toBeUndefined();
    expect(second!.worse).toBeCloseTo(((121_010 - 120_980) / 120_980) * 100, 4);
    expect(third!.worse).toBeCloseTo(((121_060 - 120_980) / 120_980) * 100, 4);
    expect(second!.spreadPct).toBeCloseTo((20 / 121_000) * 100, 4);
    // the venues' own notes pass through, fees and all; nothing is guessed
    expect(second!.note).toBe("maker 0.10%, taker 0.10%");
    expect(best!.note).toMatch(/about \$100/);
    expect(third!.note).toBeUndefined();
    // each venue was asked for its BTC markets and a fresh price for each match, the exchange's spot only (it has one), never an order
    expect(ex.calls).toEqual(["markets:BTC", "market:BTC/USDT"]);
    expect(rh.calls).toEqual(["markets:BTC", "market:BTC-USD"]);
    expect(dex.calls.sort()).toEqual(["market:WBTC/USDC@Arbitrum", "market:cbBTC/USDC@Base", "markets:BTC"]);
  });

  it("a sell ranks by the bid, the highest first", async () => {
    const { venues } = threeBtc();
    const c = await compareAcross(venues, "XBT", "sell");
    expect(c.base).toBe("BTC");
    expect(c.rows.map((r) => [r.venue, r.price, r.priceIs])).toEqual([
      ["robinhood", 121_020, "bid"],
      ["binance", 120_990, "bid"],
      ["wallet", 120_950, "bid"],
    ]);
    expect(c.rows[0]!.best).toBe(true);
    expect(c.rows[2]!.worse).toBeCloseTo(((121_020 - 120_950) / 121_020) * 100, 4);
  });

  it("a slow venue is left out within the time limit and said to be missing; the rest are compared", async () => {
    const { venues } = threeBtc();
    const hangsListing = stand([], {}, { listing: "hang" });
    const hangsPrice = stand([mk("BTC/USD", "spot", "BTC", "USD")], { "BTC/USD": "hang" });
    const t0 = Date.now();
    const c = await compareAcross([...venues, venue("kraken", "Kraken", hangsListing), venue("coinbase", "Coinbase", hangsPrice)], "BTC", "buy", { timeoutMs: 120 });
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(c.rows.map((r) => r.venue)).toEqual(["wallet", "binance", "robinhood"]);
    expect(c.missing).toEqual([
      { venue: "kraken", venueName: "Kraken", why: "did not answer in 0.12 s", code: "E_VENUE_UNREACHABLE" },
      { venue: "coinbase", venueName: "Coinbase", why: "did not answer in 0.12 s", code: "E_VENUE_UNREACHABLE" },
    ]);
  });

  it("a market that answers in time is compared even when another market at the same venue does not", async () => {
    const t = stand([mk("BTC/USDT", "spot", "BTC", "USDT"), mk("BTC/USDC", "spot", "BTC", "USDC")], { "BTC/USDT": "hang", "BTC/USDC": { bid: 100, ask: 101 } });
    const c = await compareAcross([venue("okx", "OKX", t)], "BTC", "buy", { timeoutMs: 80 });
    expect(c.rows.map((r) => r.symbol)).toEqual(["BTC/USDC"]);
    expect(c.missing).toEqual([]);
  });

  it("a venue that refuses, or throws, is left out with its own words", async () => {
    const { venues } = threeBtc();
    const geo = stand([], {}, { listing: no("E_VENUE_GEOBLOCKED", { venue: "bybit", message: "Bybit does not serve this location" }) });
    const broken = stand([], {}, { listing: "throw" });
    const priceNo = stand([mk("BTC/USD", "spot", "BTC", "USD")], { "BTC/USD": no("E_VENUE_UNREACHABLE", { venue: "coinbase", message: "Coinbase is rate-limiting this machine: try again in a minute" }) });
    const priceThrows = stand([mk("BTC/USD", "spot", "BTC", "USD")], { "BTC/USD": "throw" });
    const c = await compareAcross([...venues, venue("bybit", "Bybit", geo), venue("x", "X", broken), venue("coinbase", "Coinbase", priceNo), venue("y", "Y", priceThrows)], "BTC", "buy");
    expect(c.rows).toHaveLength(3);
    expect(c.missing).toEqual([
      { venue: "bybit", venueName: "Bybit", why: "Bybit does not serve this location", code: "E_VENUE_GEOBLOCKED" },
      { venue: "x", venueName: "X", why: "answered in a way this comparison could not read" },
      { venue: "coinbase", venueName: "Coinbase", why: "Coinbase is rate-limiting this machine: try again in a minute", code: "E_VENUE_UNREACHABLE" },
      { venue: "y", venueName: "Y", why: "answered in a way this comparison could not read" },
    ]);
  });

  it("an event market is not compared, even one whose outcome is called BTC", async () => {
    const { venues } = threeBtc();
    const kalshi = stand([mk("KXBTC-25DEC-T120000:YES", "event", "KXBTC-25DEC-T120000:YES", "USD", { bid: 0.41, ask: 0.43 }), mk("btc-up:BTC", "event", "BTC", "pUSD", { bid: 0.5, ask: 0.51 })]);
    const c = await compareAcross([...venues, venue("kalshi", "Kalshi", kalshi)], "BTC", "buy");
    expect(c.rows.map((r) => r.venue)).not.toContain("kalshi");
    expect(c.rows.every((r) => r.kind !== "event")).toBe(true);
    expect(c.missing).toEqual([{ venue: "kalshi", venueName: "Kalshi", why: "lists no BTC market priced in dollars to compare (event contracts are not compared)" }]);
    expect(kalshi.calls).toEqual(["markets:BTC"]);
  });

  it("a perpetual stands in only at a venue that lists no spot market", async () => {
    const both = stand([mk("BTC/USDT:USDT", "perp", "BTC", "USDT", { contractSize: 0.001 }), mk("BTC/USDT", "spot", "BTC", "USDT")], { "BTC/USDT:USDT": { bid: 1, ask: 2 }, "BTC/USDT": { bid: 121_000, ask: 121_005 } });
    const perpsOnly = stand([mk("BTC/USDC:USDC", "perp", "BTC", "USDC", { contractSize: 0.0001 }), mk("BTC/USDC:USDC-261226", "future", "BTC", "USDC")], { "BTC/USDC:USDC": { bid: 120_995, ask: 121_000 }, "BTC/USDC:USDC-261226": { bid: 1, ask: 1 } });
    const c = await compareAcross([venue("binance", "Binance", both), venue("hyperliquid", "Hyperliquid", perpsOnly)], "BTC", "buy");
    expect(both.calls).toEqual(["markets:BTC", "market:BTC/USDT"]);
    // the dated future is never compared, so the perpetual is the venue's only market
    expect(perpsOnly.calls).toEqual(["markets:BTC", "market:BTC/USDC:USDC"]);
    expect(c.rows.map((r) => [r.venue, r.kind, r.price])).toEqual([
      ["hyperliquid", "perp", 121_000],
      ["binance", "spot", 121_005],
    ]);
  });

  it("closed markets, a key that may not trade, and a last price rank after every venue an order could go to now", async () => {
    const closed = stand([mk("BTC/USD", "spot", "BTC", "USD", { open: false, note: "halted" })], { "BTC/USD": { bid: 100, ask: 101 } });
    const barred = stand([mk("BTC/USDT", "spot", "BTC", "USDT")], { "BTC/USDT": { bid: 100, ask: 102 } }, { can: false, whyNot: "the key has no trading permission" });
    const lastOnly = stand([mk("cbBTC/USDC@Base", "token", "cbBTC", "USDC")], { "cbBTC/USDC@Base": { price: 103 } });
    const fine = stand([mk("BTC-USD", "crypto", "BTC", "USD")], { "BTC-USD": { bid: 108, ask: 110 } });
    const c = await compareAcross([venue("a", "A", closed), venue("b", "B", barred), venue("c", "C", lastOnly), venue("d", "D", fine)], "BTC", "buy");
    expect(c.rows.map((r) => [r.venue, r.price, r.priceIs, r.ready])).toEqual([
      ["d", 110, "ask", true],
      ["c", 103, "last", true],
      ["a", 101, "ask", false],
      ["b", 102, "ask", false],
    ]);
    expect(c.rows[0]!.best).toBe(true);
    // cheaper-looking, but no order could go there now, or it is not an ask: worse is negative
    expect(c.rows[1]!.worse).toBeCloseTo(((103 - 110) / 110) * 100, 4);
    expect(c.rows[2]!).toMatchObject({ open: false, note: "halted" });
    expect(c.rows[3]!).toMatchObject({ canTrade: false, open: true });
  });

  it("when no venue could take an order now, no row is best", async () => {
    const closed = stand([mk("AAPL", "stock", "AAPL", "USD", { open: false })], { AAPL: { bid: 230, ask: 230.1 } });
    const c = await compareAcross([venue("alpaca", "Alpaca", closed)], "AAPL", "buy");
    expect(c.rows).toHaveLength(1);
    expect(c.rows[0]!.best).toBeUndefined();
    expect(c.rows[0]!.worse).toBeUndefined();
  });

  it("with a size in dollars, each venue says how much that buys and whether its smallest order allows it", async () => {
    const small = stand([mk("BTC/USDT", "spot", "BTC", "USDT", { qtyStep: 0.00001, minNotional: 5 })], { "BTC/USDT": { bid: 99_990, ask: 100_000 } });
    const big = stand([mk("BTC-USD", "crypto", "BTC", "USD", { qtyStep: 0.001, minQty: 0.001 })], { "BTC-USD": { bid: 99_000, ask: 99_500 } });
    const c = await compareAcross([venue("binance", "Binance", small), venue("rh", "Robinhood", big)], "BTC", "buy", { usd: 50 });
    // Robinhood's ask is lower, but its smallest order is 0.001 BTC ($99.50): $50 cannot go there, so Binance is best
    expect(c.rows.map((r) => [r.venue, r.qty, r.fits, r.minUsd, r.ready])).toEqual([
      ["binance", 0.0005, true, 5, true],
      ["rh", 0, false, 99.5, false],
    ]);
    expect(c.rows[0]!.best).toBe(true);
  });

  it("at one venue, the best of its matching markets is its row, and at most perVenue are priced", async () => {
    const t = stand(
      [mk("BTC/USDT", "spot", "BTC", "USDT"), mk("BTC/USDC", "spot", "BTC", "USDC"), mk("BTC/USD", "spot", "BTC", "USD"), mk("BTC/FDUSD", "spot", "BTC", "FDUSD")],
      { "BTC/USDT": { bid: 100, ask: 103 }, "BTC/USDC": { bid: 100, ask: 101 }, "BTC/USD": { bid: 100, ask: 102 }, "BTC/FDUSD": { bid: 100, ask: 99 } },
    );
    const c = await compareAcross([venue("binance", "Binance", t)], "BTC", "buy", { perVenue: 3 });
    expect(t.calls).toEqual(["markets:BTC", "market:BTC/USDT", "market:BTC/USDC", "market:BTC/USD"]);
    expect(c.rows.map((r) => r.symbol)).toEqual(["BTC/USDC"]);
  });

  it("a fresh answer that is another token than the one listed is not compared", async () => {
    const t = stand([mk("WBTC/USDC@Arbitrum", "token", "WBTC", "USDC")], { "WBTC/USDC@Arbitrum": { base: "WBTCX", bid: 1, ask: 1 } });
    const c = await compareAcross([venue("wallet", "MetaMask", t)], "BTC", "buy");
    expect(c.rows).toEqual([]);
    expect(c.missing).toEqual([{ venue: "wallet", venueName: "MetaMask", why: "answered WBTC/USDC@Arbitrum (WBTCX, token) for a BTC market it listed: not compared" }]);
  });

  it("a venue with no price for the market now is said to have none", async () => {
    const t = stand([mk("BTC-USD", "crypto", "BTC", "USD")], {});
    const c = await compareAcross([venue("rh", "Robinhood", t)], "BTC", "sell");
    expect(c.missing).toEqual([{ venue: "rh", venueName: "Robinhood", why: "shows no price for BTC-USD right now" }]);
  });

  it("a coin's name compares the coin, not the US trust with the same ticker; asset: stock compares the stock", async () => {
    const broker = stand([mk("BTC", "stock", "BTC", "USD"), mk("BTC/USD", "crypto", "BTC", "USD")], { BTC: { bid: 45, ask: 45.02 }, "BTC/USD": { bid: 121_000, ask: 121_050 } });
    const coin = await compareAcross([venue("alpaca", "Alpaca", broker)], "BTC", "buy");
    expect(coin.rows.map((r) => [r.symbol, r.kind])).toEqual([["BTC/USD", "crypto"]]);
    const trust = await compareAcross([venue("alpaca", "Alpaca", stand([mk("BTC", "stock", "BTC", "USD"), mk("BTC/USD", "crypto", "BTC", "USD")], { BTC: { bid: 45, ask: 45.02 } }))], "BTC", "buy", { asset: "stock" });
    expect(trust.rows.map((r) => [r.symbol, r.kind, r.price])).toEqual([["BTC", "stock", 45.02]]);
  });

  it("stocks compare by their ticker across brokers", async () => {
    const alpaca = stand([mk("AAPL", "stock", "AAPL", "USD"), mk("AAPLX/USD", "spot", "AAPLX", "USD")], { AAPL: { bid: 229.9, ask: 230.05 } });
    const rh = stand([mk("AAPL", "stock", "AAPL", "USD")], { AAPL: { bid: 229.95, ask: 230.0 } });
    const c = await compareAcross([venue("alpaca", "Alpaca", alpaca), venue("robinhood", "Robinhood", rh)], "AAPL", "buy");
    expect(c.base).toBe("AAPL");
    expect(c.rows.map((r) => [r.venue, r.price])).toEqual([
      ["robinhood", 230.0],
      ["alpaca", 230.05],
    ]);
    expect(alpaca.calls).toEqual(["markets:AAPL", "market:AAPL"]);
  });

  it("a name listed as a coin at some venues and a stock at others compares the side more venues list", async () => {
    const ex1 = stand([mk("ZZZ/USDT", "spot", "ZZZ", "USDT")], { "ZZZ/USDT": { bid: 1, ask: 1.01 } });
    const ex2 = stand([mk("ZZZ/USDC", "spot", "ZZZ", "USDC")], { "ZZZ/USDC": { bid: 1, ask: 1.02 } });
    const broker = stand([mk("ZZZ", "stock", "ZZZ", "USD")], { ZZZ: { bid: 30, ask: 30.1 } });
    const c = await compareAcross([venue("a", "A", ex1), venue("b", "B", ex2), venue("alpaca", "Alpaca", broker)], "ZZZ", "buy");
    expect(c.rows.map((r) => r.venue)).toEqual(["a", "b"]);
    expect(c.missing).toEqual([{ venue: "alpaca", venueName: "Alpaca", why: 'lists ZZZ as a stock, and more venues list it as a coin: ask for asset "stock" to compare those' }]);
  });

  it("a venue that lists a name both as a coin and as a stock prices its coin, never the cheaper of the two things", async () => {
    const both = stand([mk("ZZZ", "stock", "ZZZ", "USD"), mk("ZZZ-USD", "crypto", "ZZZ", "USD")], { ZZZ: { bid: 0.5, ask: 0.51 }, "ZZZ-USD": { bid: 1, ask: 1.01 } });
    const broker = stand([mk("ZZZ", "stock", "ZZZ", "USD")], { ZZZ: { bid: 30, ask: 30.1 } });
    const c = await compareAcross([venue("rh", "Robinhood", both), venue("alpaca", "Alpaca", broker)], "ZZZ", "buy");
    expect(both.calls).toEqual(["markets:ZZZ", "market:ZZZ-USD"]);
    expect(c.rows.map((r) => [r.venue, r.symbol, r.price])).toEqual([["rh", "ZZZ-USD", 1.01]]);
    expect(c.missing).toEqual([{ venue: "alpaca", venueName: "Alpaca", why: 'lists ZZZ as a stock, and as many venues list it as a coin: ask for asset "stock" to compare those' }]);
  });

  it("a buy and a sell rank the same venues differently when the asks and the bids disagree", async () => {
    const a = stand([mk("ETH/USDT", "spot", "ETH", "USDT")], { "ETH/USDT": { bid: 99, ask: 100 } });
    const b = stand([mk("ETH-USD", "crypto", "ETH", "USD")], { "ETH-USD": { bid: 98, ask: 103 } });
    const c = stand([mk("ETH/USD", "spot", "ETH", "USD")], { "ETH/USD": { bid: 100.5, ask: 101 } });
    const venues = [venue("a", "A", a), venue("b", "B", b), venue("c", "C", c)];
    const buy = await compareAcross(venues, "ETH", "buy");
    expect(buy.rows.map((r) => [r.venue, r.price])).toEqual([["a", 100], ["c", 101], ["b", 103]]);
    // by the bid, the highest first: not the ask's order turned around (that would be b, c, a)
    const sell = await compareAcross(venues, "ETH", "sell");
    expect(sell.rows.map((r) => [r.venue, r.price])).toEqual([["c", 100.5], ["a", 99], ["b", 98]]);
    expect(sell.rows[2]!.worse).toBeCloseTo(((100.5 - 98) / 100.5) * 100, 4);
  });

  it("a full page of other markets that hides the coin's own pair is asked again by the pair's spellings; a page of events is not", async () => {
    // a broker that lists stocks and coins: 25 companies whose names start with UNI sort before UNI/USD, so a search for UNI is all of them
    const companies = Array.from({ length: 25 }, (_, i) => mk(`U${String(i).padStart(2, "0")}`, "stock", `U${String(i).padStart(2, "0")}`, "USD", { name: `United Company ${i}` }));
    const broker = stand([...companies, mk("UNI/USD", "crypto", "UNI", "USD", { name: "Uniswap" })], { "UNI/USD": { bid: 7.1, ask: 7.12 } });
    expect(pick([...companies, mk("UNI/USD", "crypto", "UNI", "USD")], "UNI").map((m) => m.symbol)).not.toContain("UNI/USD");
    const events = stand(Array.from({ length: 25 }, (_, i) => mk(`KXUNI-${i}:YES`, "event", `KXUNI-${i}:YES`, "USD", { name: `UNI above ${i}` })));
    const c = await compareAcross([venue("alpaca", "Alpaca", broker), venue("kalshi", "Kalshi", events)], "UNI", "buy");
    expect(broker.calls).toEqual(["markets:UNI", "markets:UNI/USD", "markets:UNI-USD", "market:UNI/USD"]);
    expect(c.rows.map((r) => [r.venue, r.symbol, r.price])).toEqual([["alpaca", "UNI/USD", 7.12]]);
    expect(events.calls).toEqual(["markets:UNI"]);
    expect(c.missing).toEqual([{ venue: "kalshi", venueName: "Kalshi", why: "lists no UNI market priced in dollars to compare (event contracts are not compared)" }]);
  });

  it("a fresh answer that turns a listed coin into a stock with the same ticker is not compared", async () => {
    const t = stand([mk("ZZZ-USD", "crypto", "ZZZ", "USD")], { "ZZZ-USD": { kind: "stock", bid: 30, ask: 30.1 } });
    const c = await compareAcross([venue("rh", "Robinhood", t)], "ZZZ", "buy");
    expect(c.rows).toEqual([]);
    expect(c.missing).toEqual([{ venue: "rh", venueName: "Robinhood", why: "answered ZZZ-USD (ZZZ, stock) for a ZZZ market it listed: not compared" }]);
  });

  it("a time limit too long for a timer still waits for the venues instead of giving up on all of them at once", async () => {
    // a venue that takes 30 ms to price: a timer past 2^31 - 1 ms would fire at once, long before it answers
    const quick = stand([mk("BTC/USDT", "spot", "BTC", "USDT")], { "BTC/USDT": { bid: 100, ask: 101 } });
    const slowish: LiveTrader = { ...quick, market: (s) => new Promise((resolve) => setTimeout(() => resolve(quick.market(s)), 30)) };
    const c = await compareAcross([venue("binance", "Binance", slowish)], "BTC", "buy", { timeoutMs: 3e9 });
    expect(c.missing).toEqual([]);
    expect(c.rows.map((r) => [r.venue, r.price])).toEqual([["binance", 101]]);
  });

  it("an empty name compares nothing", async () => {
    const { venues } = threeBtc();
    expect(await compareAcross(venues, "", "buy")).toEqual({ base: "", side: "buy", rows: [], missing: [] });
  });
});
