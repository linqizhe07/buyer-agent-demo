import { describe, expect, it } from "vitest";
import { costBasis, ordersOf, type CostBasis, type VenuePosition } from "../../src/portfolio/account/costbasis.ts";
import { byAsset, type HoldingsVenue } from "../../src/portfolio/account/holdings.ts";
import type { LiveOrder } from "../../src/portfolio/account/live-orders.ts";

/** What each asset cost: from the account's own orders as the ledgers log them, and from what venues report about their positions. Every
 * order and position here is written by the test; nothing is placed and no venue is asked. */

const START = Date.parse("2026-10-05T14:00:00.000Z");
let seq = 0;
/** a filled order, placed a minute after the one before it */
function order(o: Partial<LiveOrder> & Pick<LiveOrder, "venue" | "symbol" | "base" | "kind" | "side" | "filledQty">): LiveOrder {
  const n = ++seq;
  const at = new Date(START + n * 60_000).toISOString();
  return { id: `ord-${String(n).padStart(4, "0")}`, clientId: n.toString(16).padStart(32, "0"), at, updatedAt: at, venueName: o.venue, name: o.symbol, type: "market", qty: o.filledQty, price: o.avgPrice ?? 0, usd: 0, status: "filled", ref: `r-${n}`, signer: "0xowner", authority: "owner", note: "", native: {}, ...o };
}
type H = HoldingsVenue["holdings"][number];
const h = (asset: string, amount: number, usd: number, cls: H["class"]): H => ({ asset, amount, usd, class: cls, inTransit: false });
const held = (...v: Array<[string, H[]]>) => byAsset(v.map(([id, holdings]) => ({ id, name: id, holdings }))).rows;
const of = (rows: CostBasis[], key: string): CostBasis => {
  const r = rows.find((x) => x.key === key);
  if (!r) throw new Error(`no row ${key} in ${rows.map((x) => x.key).join(", ")}`);
  return r;
};

describe("costBasis: the account's own orders", () => {
  it("counts a part fill at its price, with its fee, and says how much of what is held that covers", () => {
    const orders = [order({ venue: "kraken", symbol: "XBT/USD", base: "XBT", kind: "spot", side: "buy", type: "limit", qty: 1, limitPrice: 50_000, filledQty: 0.4, avgPrice: 50_000, feeUsd: 2, status: "partial" })];
    const btc = of(costBasis(orders, held(["kraken", [h("XBT", 1, 60_000, "crypto")]])), "crypto:BTC");
    expect(btc).toMatchObject({ asset: "BTC", coveredQty: 0.4, ofQty: 1, costUsd: 20_002, avgCostUsd: 50_005, unrealizedUsd: 0.4 * 60_000 - 20_002, realizedUsd: 0, source: "account orders", words: "cost known for 0.4 of 1 BTC", orders: 1 });
    expect(btc.unreportedFees).toBeUndefined();
  });

  it("is one pile across venues and names, and a sell realises over the pile's average cost, less its fee", () => {
    const orders = [
      order({ venue: "kraken", symbol: "XBT/USD", base: "XBT", kind: "spot", side: "buy", filledQty: 1, avgPrice: 40_000, feeUsd: 10 }),
      // a wallet's swap: WBTC, and the venue said nothing about a fee
      order({ venue: "wallet", symbol: "WBTC/USDC@Arbitrum", base: "WBTC", kind: "token", side: "buy", filledQty: 1, avgPrice: 50_000 }),
      order({ venue: "coinbase", symbol: "BTC-USD", base: "BTC", kind: "crypto", side: "sell", filledQty: 0.5, avgPrice: 60_000, feeUsd: 5 }),
    ];
    const rows = costBasis(orders, held(["kraken", [h("XBT", 1, 60_000, "crypto")]], ["wallet", [h("WBTC", 0.5, 30_000, "crypto")]]));
    const btc = of(rows, "crypto:BTC");
    const avg = (40_010 + 50_000) / 2;
    expect(btc.avgCostUsd).toBe(avg);
    expect(btc.coveredQty).toBe(1.5);
    expect(btc.ofQty).toBe(1.5);
    expect(btc.realizedUsd).toBe(Number((0.5 * 60_000 - 0.5 * avg - 5).toFixed(2)));
    expect(btc.unrealizedUsd).toBe(Number((1.5 * 60_000 - 1.5 * avg).toFixed(2)));
    expect(btc.orders).toBe(3);
    expect(btc.unreportedFees).toBe(1);
  });

  it("realises nothing for what is sold beyond what the orders bought: that cost was never seen", () => {
    const orders = [
      order({ venue: "kraken", symbol: "ETH/USD", base: "ETH", kind: "spot", side: "buy", filledQty: 0.2, avgPrice: 3000, feeUsd: 0 }),
      order({ venue: "kraken", symbol: "ETH/USD", base: "ETH", kind: "spot", side: "sell", filledQty: 0.5, avgPrice: 4000, feeUsd: 0 }),
    ];
    const eth = of(costBasis(orders, held(["kraken", [h("ETH", 1.5, 6000, "crypto")]])), "crypto:ETH");
    expect(eth.realizedUsd).toBe(0.2 * 4000 - 0.2 * 3000);
    expect(eth.soldUnknownQty).toBe(0.3);
    expect(eth).toMatchObject({ coveredQty: 0, ofQty: 1.5, source: "none", words: "cost known for 0 of 1.5 ETH" });
    expect(eth.avgCostUsd).toBeUndefined();
  });

  it("covers no more than is held, and says nothing is held once it is all gone", () => {
    const orders = [order({ venue: "kraken", symbol: "SOL/USD", base: "SOL", kind: "spot", side: "buy", filledQty: 10, avgPrice: 100, feeUsd: 1 })];
    // 4 of the 10 were moved to a place the account does not see
    const sol = of(costBasis(orders, held(["kraken", [h("SOL", 6, 900, "crypto")]])), "crypto:SOL");
    expect(sol).toMatchObject({ coveredQty: 6, ofQty: 6, avgCostUsd: 100.1, costUsd: 600.6, unrealizedUsd: 900 - 600.6 });
    const gone = of(costBasis(orders, []), "crypto:SOL");
    expect(gone).toMatchObject({ coveredQty: 0, ofQty: 0, words: "nothing held now", source: "none", realizedUsd: 0 });
  });

  it("adds nothing for a fill without a price, and leaves dollars and cash out", () => {
    const orders = [
      order({ venue: "x", symbol: "DOGE/USD", base: "DOGE", kind: "spot", side: "buy", filledQty: 100 }),
      order({ venue: "x", symbol: "USDC/USD", base: "USDC", kind: "spot", side: "buy", filledQty: 100, avgPrice: 1, feeUsd: 0 }),
    ];
    const rows = costBasis(orders, held(["x", [h("DOGE", 100, 12, "crypto"), h("USDC", 100, 100, "stable"), h("USD", 5, 5, "cash")]]));
    expect(rows.map((r) => r.key)).toEqual(["crypto:DOGE"]);
    expect(rows[0]).toMatchObject({ coveredQty: 0, ofQty: 100, unpricedFills: 1, unreportedFees: 1 });
  });

  it("an event contract: contracts bought and sold at its price, held by its symbol", () => {
    const sym = "KXFED-25DEC-T4.00:YES";
    const orders = [
      order({ venue: "kalshi", symbol: sym, base: sym, kind: "event", side: "buy", filledQty: 20, avgPrice: 0.45, feeUsd: 0.3 }),
      order({ venue: "kalshi", symbol: sym, base: sym, kind: "event", side: "sell", filledQty: 5, avgPrice: 0.6, feeUsd: 0.1 }),
    ];
    const ev = of(costBasis(orders, held(["kalshi", [h(sym, 15, 9, "event")]])), `event:${sym}`);
    const avg = (20 * 0.45 + 0.3) / 20;
    expect(ev.coveredQty).toBe(15);
    expect(ev.avgCostUsd).toBeCloseTo(avg, 8);
    expect(ev.realizedUsd).toBe(Number((5 * 0.6 - 5 * avg - 0.1).toFixed(2)));
    expect(ev.unrealizedUsd).toBe(Number((9 - 15 * avg).toFixed(2)));
  });
});

describe("costBasis: a venue's own number wins where it gives one", () => {
  it("a broker's average entry price for what it holds; the account's orders for what is held elsewhere — not counted twice", () => {
    const orders = [
      order({ venue: "alpaca", symbol: "AAPL", base: "AAPL", kind: "stock", side: "buy", filledQty: 10, avgPrice: 160, feeUsd: 0 }),
      order({ venue: "robinhood", symbol: "AAPL", base: "AAPL", kind: "stock", side: "buy", filledQty: 5, avgPrice: 200, feeUsd: 0 }),
    ];
    const positions: VenuePosition[] = [{ venue: "alpaca", venueName: "Alpaca", symbol: "AAPL", name: "Apple", kind: "stock", side: "long", qty: 10, entryPrice: 150, markPrice: 230, unrealizedUsd: 800, native: {} }];
    const aapl = of(costBasis(orders, held(["alpaca", [h("AAPL", 10, 2300, "equity")]], ["robinhood", [h("AAPL", 5, 1150, "equity")]]), positions), "equity:AAPL");
    expect(aapl.parts).toEqual([
      { source: "venue", venue: "alpaca", venueName: "Alpaca", qty: 10, costUsd: 1500 },
      { source: "account orders", qty: 5, costUsd: 1000 },
    ]);
    expect(aapl).toMatchObject({ coveredQty: 15, ofQty: 15, costUsd: 2500, unrealizedUsd: 800 + (5 * 230 - 1000), source: "venue and account orders", words: "cost known for 15 of 15 AAPL" });
    expect(aapl.avgCostUsd).toBeCloseTo(2500 / 15, 6);
  });

  it("a coin's position at a broker joins the coin's row; a short is a position of its own", () => {
    const positions: VenuePosition[] = [
      { venue: "alpaca", symbol: "BTC/USD", name: "BTC/USD", kind: "crypto", side: "long", qty: 0.1, entryPrice: 50_000, native: {} },
      { venue: "alpaca", symbol: "TSLA", name: "Tesla", kind: "stock", side: "short", qty: 3, entryPrice: 250, markPrice: 240, unrealizedUsd: 30, native: {} },
    ];
    const rows = costBasis([], held(["alpaca", [h("BTC", 0.1, 6000, "crypto")]]), positions);
    expect(of(rows, "crypto:BTC")).toMatchObject({ coveredQty: 0.1, ofQty: 0.1, avgCostUsd: 50_000, unrealizedUsd: 1000, source: "venue" });
    expect(of(rows, "position:alpaca:TSLA")).toMatchObject({ class: "position", side: "short", avgCostUsd: 250, costUsd: 750, coveredQty: 3, ofQty: 3, unrealizedUsd: 30, source: "venue" });
  });
});

describe("costBasis: perpetuals, by contract", () => {
  const perp = (side: "buy" | "sell", filledQty: number, avgPrice: number, feeUsd: number) => order({ venue: "okx", symbol: "BTC/USDT:USDT", base: "BTC", kind: "perp", side, filledQty, avgPrice, feeUsd, contractSize: 0.001 });

  it("counts filledQty × avgPrice × contractSize, closes before it opens, and keeps realised gains", () => {
    const orders = [perp("buy", 10, 60_000, 1), perp("sell", 4, 61_000, 0.5)];
    const open = of(costBasis(orders, []), "position:okx:BTC/USDT:USDT");
    // 10 contracts of 0.001 BTC at 60,000 = 600, and the fee; 4 closed at 61,000: 244 against 4/10 of 601
    expect(open.realizedUsd).toBe(Number((244 - 240.4 - 0.5).toFixed(2)));
    expect(open).toMatchObject({ side: "long", coveredQty: 0, ofQty: 0, words: "6 contracts left open by the account's orders; no position listed at the venue" });
    const withVenue = of(costBasis(orders, [], [{ venue: "okx", symbol: "BTC/USDT:USDT", name: "BTC perpetual", kind: "perp", side: "long", qty: 6, entryPrice: 60_000, markPrice: 61_000, unrealizedUsd: 5.9, native: {} }]), "position:okx:BTC/USDT:USDT");
    expect(withVenue).toMatchObject({ source: "venue", avgCostUsd: 60_000, costUsd: 360, coveredQty: 6, ofQty: 6, unrealizedUsd: 5.9, realizedUsd: 3.1, words: "cost known for 6 of 6 contracts" });
  });

  it("a close the venue gave no price for still closes, and realises nothing", () => {
    const orders = [perp("buy", 10, 60_000, 0), order({ venue: "okx", symbol: "BTC/USDT:USDT", base: "BTC", kind: "perp", side: "sell", filledQty: 4, feeUsd: 0, contractSize: 0.001 })];
    const p = of(costBasis(orders, []), "position:okx:BTC/USDT:USDT");
    expect(p).toMatchObject({ realizedUsd: 0, unpricedFills: 1, words: "6 contracts left open by the account's orders; no position listed at the venue" });
  });

  it("a short closed by a bigger buy realises the short and opens a long at the buy's price", () => {
    const orders = [
      order({ venue: "x", symbol: "ETH/USDT:USDT", base: "ETH", kind: "perp", side: "sell", filledQty: 5, avgPrice: 100, feeUsd: 0, contractSize: 1 }),
      order({ venue: "x", symbol: "ETH/USDT:USDT", base: "ETH", kind: "perp", side: "buy", filledQty: 8, avgPrice: 90, feeUsd: 0, contractSize: 1 }),
    ];
    const pos: VenuePosition = { venue: "x", symbol: "ETH/USDT:USDT", name: "ETH perpetual", kind: "perp", side: "long", qty: 3, markPrice: 95, native: {} };
    const p = of(costBasis(orders, [], [pos]), "position:x:ETH/USDT:USDT");
    expect(p).toMatchObject({ realizedUsd: 50, side: "long", coveredQty: 3, ofQty: 3, avgCostUsd: 90, costUsd: 270, unrealizedUsd: 15, source: "account orders" });
  });
});

describe("ordersOf: every run's orders, from the ledgers' statement rows", () => {
  it("takes the last row written for each order, across runs, and nothing that is not an order", () => {
    const first = order({ venue: "kraken", symbol: "XBT/USD", base: "XBT", kind: "spot", side: "buy", type: "limit", qty: 1, filledQty: 0.4, avgPrice: 50_000, feeUsd: 1, status: "partial" });
    const other = order({ venue: "kraken", symbol: "ETH/USD", base: "ETH", kind: "spot", side: "buy", filledQty: 1, avgPrice: 3000, feeUsd: 1 });
    const runOne = [
      { kind: "order", native: { order: first } },
      { kind: "statement", native: { order: first } },
      { kind: "statement", native: { payment: { id: "pay-0001" }, run: "r1" } },
      { kind: "statement", native: { order: { clientId: "broken" } } },
    ];
    // the second run followed the order again: it filled the rest
    const runTwo = [
      { kind: "statement", native: { order: { ...first, filledQty: 1, avgPrice: 50_500, feeUsd: 2.5, status: "filled", updatedAt: new Date(START + 3_600_000).toISOString() } } },
      { kind: "statement", native: { order: other } },
    ];
    const orders = ordersOf([...runOne, ...runTwo]);
    expect(orders.map((o) => [o.symbol, o.filledQty])).toEqual([["XBT/USD", 1], ["ETH/USD", 1]]);
    const rows = costBasis(orders, held(["kraken", [h("XBT", 1, 60_000, "crypto"), h("ETH", 1, 3500, "crypto"), h("LINK", 3, 45, "crypto")]]));
    expect(of(rows, "crypto:BTC")).toMatchObject({ coveredQty: 1, costUsd: 50_502.5, words: "cost known for 1 of 1 BTC" });
    expect(of(rows, "crypto:ETH")).toMatchObject({ coveredQty: 1, costUsd: 3001 });
    // held, never traded by the account: its coverage is still said
    expect(of(rows, "crypto:LINK")).toMatchObject({ coveredQty: 0, ofQty: 3, source: "none", words: "cost known for 0 of 3 LINK" });
    // largest holding first
    expect(rows.map((r) => r.key)).toEqual(["crypto:BTC", "crypto:ETH", "crypto:LINK"]);
  });
});

describe("fills replayed when they happened, not when their order last changed", () => {
  const t = (min: number) => new Date(START + min * 60_000).toISOString();
  const row = (o: LiveOrder) => ({ kind: "statement", native: { order: o } });

  it("a limit buy part-filled, then a sell, then the buy's rest canceled: the sell realises over the buy's fill; what was held before is not the account's", () => {
    // t+1: a limit buy of 1 BTC, 0.5 filled at $100k (logged then); t+2: a market sell of 0.5 at $110k; t+3: the buy's rest canceled
    const buy = order({ venue: "kraken", symbol: "BTC/USD", base: "BTC", kind: "spot", side: "buy", type: "limit", qty: 1, filledQty: 0.5, avgPrice: 100_000, feeUsd: 0, status: "partial", at: t(1), updatedAt: t(1) });
    const sell = order({ venue: "kraken", symbol: "BTC/USD", base: "BTC", kind: "spot", side: "sell", filledQty: 0.5, avgPrice: 110_000, feeUsd: 0, at: t(2), updatedAt: t(2) });
    const orders = ordersOf([row(buy), row(sell), row({ ...buy, status: "canceled", updatedAt: t(3) })]);
    expect(orders.find((o) => o.clientId === buy.clientId)!.steps).toEqual([{ at: t(1), filledQty: 0.5, avgPrice: 100_000, feeUsd: 0 }]);
    // 0.5 BTC held from before the account
    const btc = of(costBasis(orders, held(["kraken", [h("BTC", 0.5, 55_000, "crypto")]])), "crypto:BTC");
    expect(btc).toMatchObject({ realizedUsd: 5_000, coveredQty: 0, ofQty: 0.5, source: "none", words: "cost known for 0 of 0.5 BTC", orders: 2 });
    expect(btc.soldUnknownQty).toBeUndefined();
  });

  it("an order filled over several rows is several fills, each at its own time and worth, its fee shared by what each filled; a fill priced only later keeps its time", () => {
    // a buy: 0.2 at $100k at t+1, then 0.6 in all at an average of $102k at t+5 (so 0.4 more for $41,200), fee $8 in all
    const b1 = order({ venue: "kraken", symbol: "ETH/USD", base: "ETH", kind: "spot", side: "buy", type: "limit", qty: 1, filledQty: 0.2, avgPrice: 100_000, status: "partial", at: t(1), updatedAt: t(1) });
    const b2 = { ...b1, filledQty: 0.6, avgPrice: 102_000, feeUsd: 8, updatedAt: t(5) };
    // a sell at t+3, between the two fills: it sells what the first fill bought
    const s1 = order({ venue: "kraken", symbol: "ETH/USD", base: "ETH", kind: "spot", side: "sell", filledQty: 0.2, avgPrice: 101_000, feeUsd: 0, at: t(3), updatedAt: t(3) });
    const rows = costBasis(ordersOf([row(b1), row(s1), row(b2)]), held(["kraken", [h("ETH", 0.4, 41_000, "crypto")]]));
    const eth = of(rows, "crypto:ETH");
    // the first fill: $20,000 and $8 × 0.2/0.6 of fee; sold at $20,200 → $200 − $2.67 realised; left: 0.4 for $41,200 + $5.33
    expect(eth).toMatchObject({ realizedUsd: 197.33, coveredQty: 0.4, costUsd: 41_205.33, orders: 2 });
    // the venue gave the average only at the next row, the fill unchanged: the fill is priced, at the time it was first seen
    const late = order({ venue: "kraken", symbol: "SOL/USD", base: "SOL", kind: "spot", side: "buy", filledQty: 2, status: "filled", at: t(1), updatedAt: t(1) });
    const steps = ordersOf([row(late), row({ ...late, avgPrice: 150, updatedAt: t(9) })])[0]!.steps;
    expect(steps).toEqual([{ at: t(1), filledQty: 2, avgPrice: 150 }]);
  });

  it("a Polymarket holding named <slug>:<outcome> (live/address.ts) is one row with the account's orders in it", () => {
    const o = order({ venue: "polymarket", symbol: "fed-hikes-25-bps-in-december:Yes", base: "Yes", kind: "event", side: "buy", filledQty: 100, avgPrice: 0.6, feeUsd: 0 });
    const rows = costBasis([o], held(["polymarket", [h("fed-hikes-25-bps-in-december:Yes", 100, 74, "event")]]));
    expect(rows.map((r) => [r.key, r.coveredQty, r.costUsd])).toEqual([["event:FED-HIKES-25-BPS-IN-DECEMBER:YES", 100, 60]]);
  });
});
