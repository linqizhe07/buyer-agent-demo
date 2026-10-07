import { describe, expect, it } from "vitest";
import { assetKey, byAsset, change24h, marketKey, type HoldingsVenue } from "../../src/portfolio/account/holdings.ts";

/** What the user owns, by asset: venues as the account page shows them (stand-ins, written here), read as one list. Nothing is asked of a
 * venue: the rows come from the page's own holdings, and the same venues always give the same rows. */

type H = HoldingsVenue["holdings"][number];
const h = (asset: string, amount: number, usd: number, cls: H["class"], extra: Partial<H> = {}): H => ({ asset, amount, usd, class: cls, inTransit: false, ...extra });
const can = (o: Partial<NonNullable<HoldingsVenue["liveCan"]>> = {}): NonNullable<HoldingsVenue["liveCan"]> => ({ withdraw: true, ledgers: ["spot"], transfer: false, swap: false, receive: true, send: false, ...o });

/** an exchange that trades and withdraws; a wallet proven the owner's; a broker that trades but moves money only on its own site; a
 * watched address; Kalshi */
function venues(): HoldingsVenue[] {
  return [
    { id: "live-kraken", name: "Kraken", holdings: [h("XBT", 0.5, 30_000, "crypto"), h("USDT", 1000, 1000, "stable", { note: "spot" }), h("ETH", 2, 6000, "crypto")], trade: { can: true, what: "spot" }, liveCan: can() },
    { id: "live-wallet", name: "Wallet", address: "0xabc", proven: "a signature", holdings: [h("WBTC", 0.25, 15_000, "crypto", { note: "Arbitrum" }), h("USDC", 400, 400, "stable", { note: "Base" }), h("USDC.e", 50, 50, "stable", { note: "Arbitrum" }), h("PEPE", 1_000_000, 0, "crypto", { note: "Base · no price" })], trade: { can: true, what: "tokens" }, liveCan: can({ withdraw: false, send: "wallet" }) },
    { id: "live-alpaca", name: "Alpaca", holdings: [h("USD", 2500, 2500, "cash", { note: "cash" }), h("AAPL", 10, 2300, "equity", { note: "stocks" })], trade: { can: true, what: "US stocks" }, liveCan: can({ withdraw: false }), readOnlyBecause: "Alpaca moves money on its own site" },
    { id: "live-watch", name: "Watched", address: "0xdef", holdings: [h("USDC", 100, 100, "stable", { note: "Ethereum" }), h("ETH", 1, 3000, "crypto", { note: "Ethereum" })] },
    { id: "live-kalshi", name: "Kalshi", holdings: [h("USD", 80, 80, "cash", { note: "cash" }), h("KXFED-25DEC-T4.00:YES", 20, 9, "event", { note: "at cost" })], trade: { can: true, what: "event contracts" }, liveCan: can({ withdraw: false }), stale: "Kalshi did not answer" },
  ];
}

describe("byAsset: one row for one thing", () => {
  it("merges a coin across venues by its one name, and keeps each venue's line", () => {
    const { rows } = byAsset(venues(), { writes: true });
    const btc = rows.find((r) => r.key === "crypto:BTC")!;
    expect(btc.asset).toBe("BTC");
    expect(btc.amount).toBe(0.75);
    expect(btc.usd).toBe(45_000);
    expect(btc.price).toBe(60_000);
    expect(btc.venues.map((l) => [l.venueName, l.amount, l.note])).toEqual([["Kraken", 0.5, undefined], ["Wallet", 0.25, "Arbitrum"]]);
    const eth = rows.find((r) => r.key === "crypto:ETH")!;
    expect(eth.amount).toBe(3);
    // the watched address's ETH is in the row, and says it is watched
    expect(eth.venues.find((l) => l.venue === "live-watch")?.watched).toBe(true);
    // largest first
    expect(rows[0]!.key).toBe("crypto:BTC");
  });

  it("keeps each stablecoin by its own symbol, cash by its currency, an event by its symbol, a stock by its ticker", () => {
    const { rows } = byAsset(venues(), { writes: true });
    const keys = rows.map((r) => r.key);
    expect(keys).toContain("stable:USDT");
    expect(keys).toContain("stable:USDC");
    expect(keys).toContain("stable:USDC.E");
    expect(keys).toContain("event:KXFED-25DEC-T4.00:YES");
    expect(keys).toContain("equity:AAPL");
    const usdc = rows.find((r) => r.key === "stable:USDC")!;
    expect(usdc.amount).toBe(500);
    expect(usdc.venues.map((l) => l.venue)).toEqual(["live-wallet", "live-watch"]);
    const usd = rows.find((r) => r.key === "cash:USD")!;
    expect(usd.amount).toBe(2580);
    // a stale venue's line says its number is the last good one
    expect(usd.venues.find((l) => l.venue === "live-kalshi")?.stale).toBe(true);
  });

  it("counts no dollars for what has no price, and prices the row from the lines that are priced", () => {
    const v: HoldingsVenue[] = [
      { id: "a", name: "A", holdings: [h("SOL", 10, 1500, "crypto")] },
      { id: "b", name: "B", holdings: [h("WSOL", 5, 0, "crypto", { note: "Solana · no price" })] },
    ];
    const sol = byAsset(v).rows[0]!;
    expect(sol.key).toBe("crypto:SOL");
    expect(sol.amount).toBe(15);
    expect(sol.usd).toBe(1500);
    expect(sol.price).toBe(150);
    expect(sol.unpriced).toBe(5);
    expect(sol.venues[1]!.noPrice).toBe(true);
    const pepe = byAsset(venues()).rows.find((r) => r.key === "crypto:PEPE")!;
    expect(pepe.price).toBeUndefined();
    expect(pepe.usd).toBe(0);
  });

  it("names an order's market by the same row: a pair, a wrapped coin, a stock, an event; a perpetual is no row", () => {
    expect(marketKey({ kind: "spot", base: "XBT", symbol: "XBT/USD" })).toBe("crypto:BTC");
    expect(marketKey({ kind: "token", base: "WETH", symbol: "WETH/USDC@Base" })).toBe("crypto:ETH");
    expect(marketKey({ kind: "crypto", base: "BTC-USD", symbol: "BTC-USD" })).toBe("crypto:BTC");
    expect(marketKey({ kind: "stock", base: "aapl", symbol: "AAPL" })).toBe("equity:AAPL");
    expect(marketKey({ kind: "event", base: "KXFED-25DEC-T4.00:YES", symbol: "KXFED-25DEC-T4.00:YES" })).toBe("event:KXFED-25DEC-T4.00:YES");
    expect(marketKey({ kind: "spot", base: "USDC", symbol: "USDC/USD" })).toBe("stable:USDC");
    expect(marketKey({ kind: "perp", base: "BTC", symbol: "BTC/USDT:USDT" })).toBeUndefined();
    expect(assetKey("cbBTC", "crypto")).toBe("crypto:BTC");
  });

  it("puts money on its way in the rows and not in what is ready", () => {
    const v: HoldingsVenue[] = [{ id: "a", name: "A", holdings: [h("USD", 100, 100, "cash"), h("USD", 40, 40, "cash", { inTransit: true, note: "T+1" })], trade: { can: true, what: "stocks" }, liveCan: can() }];
    const { rows, money } = byAsset(v, { writes: true });
    expect(rows[0]!.amount).toBe(140);
    expect(rows[0]!.venues.find((l) => l.inTransit)?.amount).toBe(40);
    expect(money.inTransitUsd).toBe(40);
    expect(money.readyUsd).toBe(100);
  });
});

describe("byAsset: the ready dollars, split as the Cash ready card splits them", () => {
  it("trades here · moves out · leaves only at its venue, by the page's own rules", () => {
    const { money } = byAsset(venues(), { writes: true });
    // cash: Alpaca 2500 + Kalshi 80; stablecoins: Kraken 1000 + wallet 450 + watched 100
    expect(money.cashUsd).toBe(2580);
    expect(money.stableUsd).toBe(1550);
    expect(money.readyUsd).toBe(4130);
    // trades where it is: Kraken, the wallet, Alpaca, Kalshi (not the watched address)
    expect(money.tradesHereUsd).toBe(1000 + 450 + 2500 + 80);
    // moves out: Kraken (it withdraws) and the wallet (it sends); Kalshi's key lets nothing out, and Alpaca moves money on its own site
    expect(money.canMoveUsd).toBe(1000 + 450);
    expect(money.staysUsd).toBe(4130 - 1450);
    const why = Object.fromEntries(money.venues.map((r) => [r.venue, r.why ?? "moves"]));
    expect(why).toEqual({ "live-alpaca": "moves only at the venue", "live-kraken": "moves", "live-wallet": "moves", "live-watch": "watched", "live-kalshi": "this key only reads" });
    expect(money.venues[0]!.venue).toBe("live-alpaca");
    expect(money.venues.find((r) => r.venue === "live-wallet")!.lines).toEqual([{ asset: "USDC", note: "Base", usd: 400 }, { asset: "USDC.e", note: "Arbitrum", usd: 50 }]);
  });

  it("with the server's writes off, nothing trades or moves from here", () => {
    const { money } = byAsset(venues());
    expect(money.tradesHereUsd).toBe(0);
    expect(money.canMoveUsd).toBe(0);
    expect(money.staysUsd).toBe(money.readyUsd);
    expect(new Set(money.venues.map((r) => r.why))).toEqual(new Set(["this server does not move money"]));
  });

  it("a key that may not trade does not trade here; a wallet watched, not proven, neither trades nor moves", () => {
    const v: HoldingsVenue[] = [
      { id: "x", name: "X", holdings: [h("USDT", 10, 10, "stable")], trade: { can: false, what: "spot" }, liveCan: can() },
      { id: "w", name: "W", address: "0x1", holdings: [h("USDC", 5, 5, "stable")], trade: { can: true, what: "tokens" }, liveCan: can({ send: "wallet" }) },
    ];
    const { money } = byAsset(v, { writes: true });
    expect(money.tradesHereUsd).toBe(0);
    expect(money.canMoveUsd).toBe(10);
    expect(money.venues.find((r) => r.venue === "w")!.why).toBe("watched");
  });
});

describe("change24h: holdings × each market's own 24-hour change", () => {
  it("weighs each row by what it is worth, counts cash and stablecoins as unchanged, and says how much it covers", () => {
    const { rows } = byAsset(venues(), { writes: true });
    const stats = new Map([
      ["crypto:BTC", { changePct24h: 5 }],
      // by the asset's name works too
      ["ETH", { changePct24h: -10 }],
    ]);
    const d = change24h(rows, stats);
    const btcThen = 45_000 / 1.05;
    const ethThen = 9000 / 0.9;
    const expected = 45_000 - btcThen + (9000 - ethThen);
    expect(d.usd).toBeCloseTo(expected, 2);
    // covered: BTC, ETH, and every dollar; not AAPL, not the event, not PEPE (no dollars)
    expect(d.coveredUsd).toBe(45_000 + 9000 + 4130);
    expect(d.ofUsd).toBe(45_000 + 9000 + 4130 + 2300 + 9);
    expect(d.missing.sort()).toEqual(["equity:AAPL", "event:KXFED-25DEC-T4.00:YES"]);
    expect(d.pct).toBeCloseTo((expected / (btcThen + ethThen + 4130)) * 100, 2);
  });

  it("takes a change in price against the venue's own price when there is no percentage, and nothing when there is neither", () => {
    const rows = byAsset([{ id: "a", name: "A", holdings: [h("AAPL", 10, 2000, "equity"), h("TSLA", 1, 300, "equity")] }]).rows;
    const d = change24h(rows, { "equity:AAPL": { change24h: 10, price: 200 }, "equity:TSLA": { volumeUsd24h: 1 } as never });
    // 200 now, 190 a day ago: +5.263…%
    expect(d.usd).toBeCloseTo(2000 - 2000 / (1 + 10 / 190), 2);
    expect(d.missing).toEqual(["equity:TSLA"]);
    expect(d.coveredUsd).toBe(2000);
  });

  it("covers nothing when no market speaks: no percentage, not a zero", () => {
    const rows = byAsset([{ id: "a", name: "A", holdings: [h("AAPL", 10, 2000, "equity")] }]).rows;
    const d = change24h(rows, new Map());
    expect(d).toEqual({ usd: 0, coveredUsd: 0, ofUsd: 2000, missing: ["equity:AAPL"] });
  });
});
