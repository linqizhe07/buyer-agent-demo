/** ATTACKS THAT MUST FAIL (found by an independent review on 2026-10-05, against the order door): each test below is the attack as it went
 * through then, and asserts that it no longer does.
 *
 *   R5  an agent grew one order past its per-order line by changing it a little at a time; after the owner replaced its limit, growing an
 *       old order was checked against the new limit but counted on the old one
 *   R6  a SELL stop-limit was valued at its limit price: limited at $1, it sold $600 at the stop while counting as $0.01
 *   R7  an agent's close was neither a card in Guard nor held to its limit, on positions that may be the owner's own */
import { describe, expect, it } from "vitest";
import { isRefusal } from "../../src/core/errors.ts";
import { cardHash } from "../../src/portfolio/account/exchange.ts";
import { BTC, cc, codeOf, DAY, fresh, ok, PERP, run, START, venue } from "./account-runs.ts";

async function account(o: { perPayment: string; budget: string; beast?: boolean; cap?: number }) {
  const x = await run(fresh(), 0, { seedOwner: true, cap: o.cap ?? 1000 });
  ok(await x.own({ type: "connectVenue", venue: "ex", connector: "live:standin-attack", label: "Ex", credentialRef: "" }));
  ok(await x.own({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: START + 30 * DAY }));
  ok(await x.own({ type: "approveSpend", agent: cc.address, scope: "trade", allow: "ex", perPayment: o.perPayment, budget: o.budget, windowHours: 0, validUntil: START + 7 * DAY }));
  if (o.beast) ok(await x.own({ type: "setPolicy", change: "mode", value: "open" }));
  return x;
}
const orderOf = (o: Awaited<ReturnType<Awaited<ReturnType<typeof account>>["ag"]>>) => {
  if (isRefusal(o) || o.kind !== "order") throw new Error(`expected an order, got ${codeOf(o)}`);
  return o.order;
};

describe("R5 · a change cannot grow an order past what the agent may", () => {
  it("one order is held to the per-order line as it stands after the change, not by the step it grows", async () => {
    const x = await account({ perPayment: "50", budget: "500", beast: true });
    const o = orderOf(await x.ag({ type: "agentLiveOrder", venue: "ex", symbol: BTC.symbol, side: "buy", orderType: "limit", qty: "0.001", usd: "", limitPrice: "50000" }));
    const r = await x.ag({ type: "agentLiveAmend", venue: "ex", order: o.id, qty: "0.0011", limitPrice: "", stopPrice: "" });
    expect(codeOf(r)).toBe("E_MANDATE_PER_ORDER_CAP");
    expect([x.engine.orders[0]!.qty, x.trade()!.spentMicro, venue.amended.length]).toEqual([0.001, 50_000_000, 0]);
  });

  it("an order counted on a limit the owner has replaced moves onto the new one when it grows: all of it is counted there", async () => {
    const x = await account({ perPayment: "1000", budget: "1000", beast: true });
    const o1 = orderOf(await x.ag({ type: "agentLiveOrder", venue: "ex", symbol: BTC.symbol, side: "buy", orderType: "limit", qty: "0.0002", usd: "", limitPrice: "50000" }));
    const o2 = orderOf(await x.ag({ type: "agentLiveOrder", venue: "ex", symbol: BTC.symbol, side: "buy", orderType: "limit", qty: "0.0002", usd: "", limitPrice: "50000" }));
    const old = x.trade()!.id;
    ok(await x.own({ type: "approveSpend", agent: cc.address, scope: "trade", allow: "ex", perPayment: "200", budget: "200", windowHours: 0, validUntil: START + 7 * DAY }));
    ok(await x.ag({ type: "agentLiveAmend", venue: "ex", order: o1.id, qty: "0.004", limitPrice: "", stopPrice: "" }));
    expect([x.engine.orders.find((o) => o.id === o1.id)!.approval, x.trade()!.spentMicro]).toEqual([x.trade()!.id, 200_000_000]);
    expect(x.engine.state.spends.find((s) => s.id === old)!.spentMicro).toBe(10_000_000);
    expect(codeOf(await x.ag({ type: "agentLiveAmend", venue: "ex", order: o2.id, qty: "0.004", limitPrice: "", stopPrice: "" }))).toBe("E_MANDATE_BUDGET");
  });
});

describe("R6 · a sell stop-limit is worth what it sells at the stop", () => {
  it("limited at $1 under a stop at 59,000: counted at the stop, so the per-order line and the server's cap see $590", async () => {
    const x = await account({ perPayment: "50", budget: "100", beast: true, cap: 100 });
    const before = venue.placed.length;
    const r = await x.ag({ type: "agentLiveOrder", venue: "ex", symbol: PERP.symbol, side: "sell", orderType: "stop_limit", qty: "0.01", usd: "", limitPrice: "1", stopPrice: "59000" });
    expect(["E_ACCOUNT_LIMIT", "E_MANDATE_PER_ORDER_CAP"]).toContain(codeOf(r));
    expect(venue.placed.length).toBe(before);
    // at a limit above the stop, it is worth its limit
    const y = await account({ perPayment: "1000", budget: "1000", beast: true });
    const o = orderOf(await y.ag({ type: "agentLiveOrder", venue: "ex", symbol: PERP.symbol, side: "sell", orderType: "stop_limit", qty: "0.001", usd: "", limitPrice: "59500", stopPrice: "59000" }));
    expect(o.usd).toBe(59.5);
  });
});

describe("R7 · an agent's close is an order the owner sees", () => {
  it("Guard: a card, nothing placed until the owner approves; then exactly what the card showed", async () => {
    venue.positions = [{ symbol: PERP.symbol, name: PERP.name, kind: "perp", side: "short", qty: 0.015, native: {} }];
    const x = await account({ perPayment: "1", budget: "1" });
    const before = venue.placed.length;
    const r = await x.ag({ type: "agentLiveClose", venue: "ex", symbol: PERP.symbol, qty: "" });
    if (isRefusal(r) || r.kind !== "card") throw new Error(`expected a card, got ${codeOf(r)}`);
    expect(venue.placed.length).toBe(before);
    const card = x.engine.host.card(r.card.id)!;
    const done = await x.own({ type: "approveCard", card: card.id, action: cardHash(card), decision: "approve" });
    expect(codeOf(done)).toBe("order");
    expect(venue.placed.at(-1)).toMatchObject({ symbol: PERP.symbol, side: "buy", type: "market", qty: 0.015, reduceOnly: true });
    expect(x.trade()!.spentMicro).toBe(0);
    venue.positions = [];
  });

  it("Beast: a derivative's reduce-only close at once inside the per-order line; a plain sell of a holding is a sell order, refused over the line", async () => {
    venue.positions = [{ symbol: PERP.symbol, name: PERP.name, kind: "perp", side: "long", qty: 0.0001, native: {} }, { symbol: BTC.symbol, name: BTC.name, kind: "spot", side: "long", qty: 0.015, native: {} }];
    const x = await account({ perPayment: "10", budget: "10", beast: true });
    expect(codeOf(await x.ag({ type: "agentLiveClose", venue: "ex", symbol: PERP.symbol, qty: "" }))).toBe("order");
    // 0.015 BTC is $900: a sell order that size would be refused on a $10 line, and so is the close that sells it (the fix round's decision:
    // a close that only sells a holding counts against the trading limit exactly as a sell order does)
    expect(codeOf(await x.ag({ type: "agentLiveClose", venue: "ex", symbol: BTC.symbol, qty: "" }))).toBe("E_MANDATE_PER_ORDER_CAP");
    venue.positions = [];
  });
});
