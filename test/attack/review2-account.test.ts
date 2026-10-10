/** review2 · the account lens: each test asserts what SHOULD hold at the signed door, the limits and the restore. Where one failed, that
 * was the finding (the review's REPORT.md names it by its number here); the fix round made each hold, and added the ones after A7 for the
 * decisions it took. Nothing here touches the network: one stand-in venue that trades spot and a perpetual and earns, which can be made
 * unreachable for a restart, and whose earn can be made slow.
 *
 *   A1  a restart whose venue does not come back: the owner connects the venue again (an order left open there blocks nothing while the
 *       venue is not connected), or cancels the order
 *   A2  a card nobody answers gives back what it held of the limit after its 30 minutes, and is gone from the owner's cards
 *   A3  a finished earn (status `done`) of an earlier run keeps its status
 *   A4  an earn that does not answer in time leaves a net worth point marked `partial`, and its later arrival is not a gain
 *   A5  in Beast, an agent's close of a long holding is a plain sell, and counts against the trading limit's budget as a sell does
 *   A6  revoking a limit (budget "0") closes no ask, and a limit at one venue closes no ask about another
 *   A7  the owner growing an agent's order: the growth is judged against the agent's limit, and refused past it with a way to allow it
 *   A8  an agent's leverage change where a position is open is a card in Guard (at once with no position there); Beast at once
 *       inside the per-order line, a card above it
 *   A9  a trading limit's window is real: one order per window at each venue; a change to an order placed is not a second order
 *   A10 the table of answers keeps an envelope's answer for the nonce window and lets it go after
 *   A11 an order whose venue is not connected, asked to cancel: no longer followed, its share of the limit free, not followed by a later run
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { isRefusal, type Refusal } from "../../src/core/errors.ts";
import { no } from "../../src/portfolio/refuse.ts";
import { cardHash, type Outcome } from "../../src/portfolio/account/exchange.ts";
import { signAgent, signOwner, simKey, type AgentAction, type Envelope, type OwnerAction } from "../../src/portfolio/account/sign.ts";
import type { EarnPosition, EarnProduct, LiveEarner } from "../../src/portfolio/live/earn.ts";
import { register, type LiveDeps } from "../../src/portfolio/live/index.ts";
import type { LiveTrader, Market, OrderRequest, OrderState, Position } from "../../src/portfolio/live/trade.ts";
import { PortfolioService } from "../../src/portfolio/service.ts";

type NoNonce<T> = T extends unknown ? Omit<T, "nonce"> : never;
const START = Date.parse("2026-10-06T09:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const owner = simKey("owner");
const cc = simKey("agent:claude-code");

// ---- one stand-in venue: trades spot and a perpetual, earns, can go down, can answer its earn late ----------------------------------

export const BTC: Market = { symbol: "BTC/USDT", name: "BTC/USDT", kind: "spot", base: "BTC", quote: "USDT", price: 60_000, bid: 59_990, ask: 60_010, minQty: 0.0001, qtyStep: 0.0001, priceStep: 0.1, open: true, types: ["market", "limit"], tifs: ["gtc", "ioc"], sellsReduce: true };
export const PERP: Market = { symbol: "BTC/USDT:USDT", name: "BTC perpetual", kind: "perp", base: "BTC", quote: "USDT", price: 60_000, bid: 59_990, ask: 60_010, minQty: 0.0001, qtyStep: 0.0001, priceStep: 0.1, open: true, types: ["market", "limit"], tifs: ["gtc", "ioc"], reduceOnly: true, maxLeverage: 50 };
const USDT: EarnProduct = { id: "savings:USDT", asset: "USDT", name: "USDT · Flexible", apy: 0.05, rateKind: "apr", lockDays: 0, priceUsd: 1, lands: "the funding account", canSupply: true, canWithdraw: true };
const ex = { down: false, placed: [] as OrderRequest[], states: new Map<string, OrderState>(), positions: [] as Position[], leverage: [] as Array<{ symbol: string; leverage: number; marginMode?: string | undefined }>, held: [] as EarnPosition[], earnDelayMs: 0, earnReads: 0 };
const trader: LiveTrader = {
  can: true,
  what: "spot and perpetuals",
  async markets() {
    return [BTC, PERP];
  },
  async market(symbol) {
    const m = [BTC, PERP].find((x) => x.symbol === symbol);
    return m ? { ...m } : no("E_VENUE_REJECTED", { venue: "ex", message: `no market ${symbol}` });
  },
  async place(o) {
    ex.placed.push(o);
    const ref = `r-${ex.placed.length}`;
    const s: OrderState = o.type === "market" ? { ref, status: "filled", filledQty: o.qty, avgPrice: o.side === "buy" ? 60_010 : 59_990, native: {} } : { ref, status: "open", filledQty: 0, native: {} };
    ex.states.set(ref, s);
    return s;
  },
  async cancel(ref) {
    const s = { ...ex.states.get(ref)!, status: "canceled" as const };
    ex.states.set(ref, s);
    return s;
  },
  async status(ref) {
    return ex.states.get(ref)!;
  },
  async amend(ref, _symbol, _change) {
    return { ...ex.states.get(ref)! };
  },
  async positions() {
    return ex.positions;
  },
  async setLeverage(symbol, leverage, marginMode) {
    ex.leverage.push({ symbol, leverage, marginMode });
    return { leverage, ...(marginMode ? { marginMode } : {}), native: {} };
  },
};
const earner: LiveEarner = {
  can: true,
  what: "a stand-in's earn",
  products: async () => [USDT],
  product: async (id) => (id === USDT.id ? { ...USDT } : no("E_VENUE_REJECTED", { venue: "ex", message: `no product ${id}` })),
  async positions() {
    ex.earnReads++;
    const delay = ex.earnDelayMs;
    ex.earnDelayMs = 0;
    if (delay) await new Promise((r) => setTimeout(r, delay));
    return ex.held.map((h) => ({ ...h }));
  },
  supply: async () => ({ ref: "s-1", status: "done", native: {} }),
  withdraw: async () => ({ ref: "w-1", status: "done", native: {} }),
};
register({ kind: "standin-review2", label: "a venue that trades and earns", needs: "key-file", example: "", venues: [], async open(req) {
  if (ex.down) return no("E_VENUE_UNREACHABLE", { venue: req.venue, message: "the stand-in is down" });
  return { source: { name: req.label || "Stand-in", kind: "cex", reference: "standin", via: "a stand-in", probe: { can: ["read", "trade"], note: "" }, read: async () => [{ asset: "USDT", amount: 500, usd: 500 }], trader, earner, readOnlyBecause: "the stand-in moves no money" } as never, first: [{ asset: "USDT", amount: 500, usd: 500 }], summary: "connected" };
} });

const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));
afterEach(() => {
  ex.down = false;
  ex.positions = [];
  ex.leverage = [];
  ex.held = [];
  ex.earnDelayMs = 0;
});
const fresh = (): string => {
  const h = mkdtempSync(join(tmpdir(), "review2-account-"));
  homes.push(h);
  return h;
};

/** one run of the real account on `home`, `at` ms after the start: the owner an address, both clocks movable (`pass`) */
async function run(home: string, at: number, o: { cap?: number } = {}) {
  let t = START + at;
  let real = 5_000_000 + at;
  let n = 0;
  const liveDeps: Partial<LiveDeps> = { clock: () => real, http: async () => ({ status: 599, body: undefined, text: "" }), price: async () => undefined };
  const svc = await PortfolioService.create({ home, now: () => new Date(t).toISOString(), venues: "frontline", real: true, liveDeps, liveWrites: { capUsd: o.cap ?? 1000, pairingCode: "K7QX-M2PA" }, account: { owners: [{ id: owner.address, kind: "eoa", label: "owner", addedAt: new Date(START).toISOString() }] } });
  await svc.restoring;
  const engine = svc.account!;
  // ten seconds past the clock: never one the engine's own `nextNonce` (used by prepare) hands out
  const nonce = () => t + 10_000 + ++n;
  const signed = async (a: NoNonce<OwnerAction>): Promise<Envelope> => signOwner(owner, { ...a, nonce: nonce() } as OwnerAction);
  const own = async (a: NoNonce<OwnerAction>) => svc.exchange(await signed(a));
  const ag = async (a: NoNonce<AgentAction>) => svc.exchange(await signAgent(cc, { ...a, nonce: nonce() } as AgentAction));
  /** what the page does: prepare, then sign exactly what was prepared */
  const prepared = async (draft: Record<string, unknown>) => {
    const p = await engine.prepare(draft);
    if (isRefusal(p)) throw new Error(`${p.code}: ${p.message}`);
    return svc.exchange(await signOwner(owner, p.action));
  };
  const pass = (ms: number) => {
    t += ms;
    real += ms;
  };
  const connect = () => own({ type: "connectVenue", venue: "ex", connector: "live:standin-review2", label: "Ex", credentialRef: "" });
  const letIn = async (limit: { per: string; budget: string; windowHours?: number }) => {
    ok(await own({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: START + 30 * DAY }));
    return ok(await own({ type: "approveSpend", agent: cc.address, scope: "trade", allow: "ex", perPayment: limit.per, budget: limit.budget, windowHours: limit.windowHours ?? 0, validUntil: START + 7 * DAY }));
  };
  const trade = () => engine.state.spends.find((s) => s.scope === "trade" && s.revokedAt === undefined)!;
  return { svc, engine, own, ag, signed, prepared, pass, connect, letIn, trade, now: () => t };
}

const ok = <T extends Outcome | Refusal>(o: T): Exclude<T, Refusal> => {
  if (isRefusal(o)) throw new Error(`${o.code}: ${o.message}`);
  return o as Exclude<T, Refusal>;
};
const codeOf = (o: Outcome | Refusal): string => (isRefusal(o) ? o.code : o.kind);
const words = (o: Outcome | Refusal): string => (isRefusal(o) ? `${o.code}: ${o.message}` : o.kind);
const result = (o: Outcome | Refusal): unknown => (!isRefusal(o) && o.kind === "result" ? o.result : words(o));
const limitOrder = { type: "agentLiveOrder" as const, venue: "ex", symbol: BTC.symbol, side: "buy", orderType: "limit", qty: "0.001", usd: "", limitPrice: "59000" };
const perpLong = (qty: number, usd: number): Position => ({ symbol: PERP.symbol, name: PERP.name, kind: "perp", side: "long", qty, markPrice: 60_000, usd, native: {} });

describe("A1 · a restart whose venue does not come back", () => {
  it("once the venue is reachable again the owner can connect it again, or cancel the order it left open", async () => {
    const home = fresh();
    const r1 = await run(home, 0);
    ok(await r1.connect());
    expect(codeOf(await r1.prepared({ type: "liveOrder", venue: "ex", symbol: BTC.symbol, side: "buy", orderType: "limit", qty: "0.001", limitPrice: "59000" }))).toBe("order");
    expect(r1.engine.orders.map((o) => [o.id, o.status])).toEqual([["ord-0001", "open"]]);
    // the venue is unreachable while the account restarts, and reachable again a moment later
    ex.down = true;
    const r2 = await run(home, HOUR);
    ex.down = false;
    const page = (await r2.svc.accountView())!;
    expect((page.restore as { venues: Array<{ venue: string; ok: boolean }> }).venues.map((v) => [v.venue, v.ok])).toEqual([["ex", false]]);
    expect(r2.engine.orders.map((o) => [o.id, o.status])).toEqual([["ord-0001", "open"]]);
    // what should hold: connecting the venue again goes through (and the order is followed again), or the order can be canceled
    const connect = await r2.connect();
    const cancel = await r2.own({ type: "liveCancel", venue: "ex", order: "ord-0001" });
    expect.soft(words(connect)).toBe("account");
    expect(words(cancel)).toBe("order");
  });
});

describe("A2 · a card nobody answers", () => {
  it("after its 30 minutes it is gone from the owner's cards and what it held of the limit is free: the agent's next order fits", async () => {
    const x = await run(fresh(), 0);
    ok(await x.connect());
    await x.letIn({ per: "100", budget: "100" });
    expect(codeOf(await x.ag(limitOrder))).toBe("card");
    expect(x.trade().reservedMicro).toBe(59_000_000);
    x.pass(31 * MIN);
    await x.engine.settle();
    const page = await x.engine.view();
    const dead = page.cards.filter((c) => c.expiresAt !== undefined && Date.parse(c.expiresAt) <= x.now());
    expect.soft(dead.map((c) => c.id)).toEqual([]);
    expect.soft(x.trade().reservedMicro).toBe(0);
    // the same order again: the budget is $100, nothing was placed, the dead card holds nothing
    expect(words(await x.ag(limitOrder))).toBe("card");
  });
});

describe("A3 · the statement after a restart", () => {
  it("a finished earn of an earlier run keeps its status, done", async () => {
    const home = fresh();
    const r1 = await run(home, 0);
    ok(await r1.connect());
    expect(codeOf(await r1.prepared({ type: "liveEarn", venue: "ex", kind: "supply", product: USDT.id, asset: "USDT", amount: "10" }))).toBe("result");
    expect(r1.svc.statement().map((l) => [l.type, l.status])).toEqual([["earn", "done"]]);
    const r2 = await run(home, HOUR);
    expect(r2.svc.statement().map((l) => [l.type, l.status])).toEqual([["earn", "done"]]);
  });
});

describe("A4 · an earn that does not answer in time (the known gap)", () => {
  it("the net worth point taken then is `partial`, and the earn's arrival later is not a gain", async () => {
    const x = await run(fresh(), 0);
    ex.held = [{ product: USDT.id, id: USDT.id, asset: "USDT", amount: 90, usd: 90 }];
    // the first read of the earn positions answers after 4.5 seconds: later than the page waits (3 s)
    ex.earnDelayMs = 4_500;
    ok(await x.connect());
    const first = await x.svc.snapshot();
    expect(first).toMatchObject({ written: true });
    // the read answers, and is kept for the next page
    await new Promise((r) => setTimeout(r, 2_500));
    x.pass(5 * MIN);
    const second = await x.svc.snapshot();
    expect(second).toMatchObject({ written: true });
    const h = x.svc.history("1d");
    if (isRefusal(h)) throw new Error(h.message);
    expect.soft(h.points.map((p) => [p.usd, p.partial ?? false])).toEqual([[500, true], [590, false]]);
    expect.soft(h.changeUsd).toBe(0);
    expect(h.partial).toBe(true);
  }, 30_000);
});

describe("A5 · an agent's close of a long holding, in Beast", () => {
  it("is a sell, and counts against the trading limit's budget as a sell order does", async () => {
    const x = await run(fresh(), 0);
    ex.positions = [{ symbol: BTC.symbol, name: BTC.name, kind: "spot", side: "long", qty: 0.01, markPrice: 60_000, usd: 600, native: {} }];
    ok(await x.connect());
    await x.letIn({ per: "100", budget: "100" });
    ok(await x.own({ type: "setPolicy", change: "mode", value: "open" }));
    // each close is a market sell of 0.001 BTC, about $60: the budget is $100 in all
    const close = () => x.ag({ type: "agentLiveClose", venue: "ex", symbol: BTC.symbol, qty: "0.001" });
    expect(codeOf(await close())).toBe("order");
    const second = await close();
    const third = await close();
    expect.soft(x.trade().spentMicro).toBeGreaterThan(0);
    expect([words(second), words(third)].some((w) => w.startsWith("E_MANDATE_BUDGET"))).toBe(true);
    // the refusal says why a close counts
    expect(words(second)).toContain("A close that sells a holding is a sell order, and counts against the trading limit like one");
  });

  it("in Guard it is a card that holds its share of the limit, as an order's card does; over the per-order line it is refused, not carded", async () => {
    const x = await run(fresh(), 0);
    ex.positions = [{ symbol: BTC.symbol, name: BTC.name, kind: "spot", side: "long", qty: 0.01, markPrice: 60_000, usd: 600, native: {} }];
    ok(await x.connect());
    await x.letIn({ per: "100", budget: "100" });
    const asked = await x.ag({ type: "agentLiveClose", venue: "ex", symbol: BTC.symbol, qty: "0.001" });
    if (isRefusal(asked) || asked.kind !== "card") throw new Error(`expected a card, got ${words(asked)}`);
    expect([asked.card.approval, x.trade().reservedMicro]).toEqual([x.trade().id, 59_990_000]);
    const card = x.engine.host.card(asked.card.id)!;
    expect(codeOf(await x.own({ type: "approveCard", card: card.id, action: cardHash(card), decision: "approve" }))).toBe("order");
    expect([x.trade().reservedMicro, x.trade().spentMicro]).toEqual([0, 59_990_000]);
    // all of it, $600: more than one order may be on this limit — a sell order of that size is refused, and so is this
    expect(words(await x.ag({ type: "agentLiveClose", venue: "ex", symbol: BTC.symbol, qty: "" }))).toBe("E_MANDATE_PER_ORDER_CAP: an order of $599.90 is more than the $100.00 an order the trading limit allows. A close that sells a holding is a sell order, and counts against the trading limit like one");
  });
});

describe("A6 · the owner's actions that close asks", () => {
  it("revoking a limit does not answer an ask for one", async () => {
    const x = await run(fresh(), 0);
    ok(await x.connect());
    await x.letIn({ per: "100", budget: "100" });
    expect(codeOf(await x.ag({ type: "agentAsk", kind: "limit", venue: "ex2", usd: "1000", text: "a trading limit at ex2, please" }))).toBe("result");
    expect((await x.engine.view()).asks.map((a) => [a.kind, a.venue])).toEqual([["limit", "ex2"]]);
    // the owner REVOKES the trading limit at ex: nothing was granted, and the ask was about ex2 anyway
    ok(await x.own({ type: "approveSpend", agent: cc.address, scope: "trade", allow: "ex", perPayment: "0", budget: "0", windowHours: 0, validUntil: START + 7 * DAY }));
    expect((await x.engine.view()).asks.map((a) => [a.kind, a.venue])).toEqual([["limit", "ex2"]]);
    // a limit granted at ex answers an ask that names no venue, and still not the one about ex2
    expect(codeOf(await x.ag({ type: "agentAsk", kind: "limit", venue: "", usd: "100", text: "a trading limit, please" }))).toBe("result");
    ok(await x.own({ type: "approveSpend", agent: cc.address, scope: "trade", allow: "ex", perPayment: "100", budget: "100", windowHours: 0, validUntil: START + 7 * DAY }));
    expect((await x.engine.view()).asks.map((a) => [a.kind, a.venue])).toEqual([["limit", "ex2"]]);
  });
});

describe("A7 · the owner grows an agent's order", () => {
  it("the growth is judged against the agent's limit, as the agent's own change would be: past the budget it is refused, and the refusal says how to allow it", async () => {
    const x = await run(fresh(), 0);
    ok(await x.connect());
    await x.letIn({ per: "100", budget: "100" });
    ok(await x.own({ type: "setPolicy", change: "mode", value: "open" }));
    // the agent's limit buy, $59 of its $100
    expect(codeOf(await x.ag(limitOrder))).toBe("order");
    expect(x.trade().spentMicro).toBe(59_000_000);
    // the owner changes it to 0.0025 BTC: $147.50, $88.50 more — inside the $100 line, past the $41 the budget has left
    const grown = await x.prepared({ type: "liveAmend", venue: "ex", order: "ord-0001", qty: "0.0025", limitPrice: "", stopPrice: "" });
    expect(words(grown)).toBe("E_MANDATE_BUDGET: the spending approval has $41.00 left of $100.00; $88.50 is more than that. ord-0001 counts against Claude Code's trading limit: give it a bigger limit under Agents, or grow the order by less");
    const t = x.trade();
    expect([t.spentMicro + t.reservedMicro <= t.budgetMicro, x.engine.orders[0]!.qty]).toEqual([true, 0.001]);
    // a change that fits goes through, counted on the agent's limit
    expect(codeOf(await x.prepared({ type: "liveAmend", venue: "ex", order: "ord-0001", qty: "0.0015", limitPrice: "", stopPrice: "" }))).toBe("order");
    expect([x.engine.orders[0]!.qty, x.trade().spentMicro]).toEqual([0.0015, 88_500_000]);
  });
});

describe("A8 · an agent's leverage change where a position is open", () => {
  it("Guard: a card, nothing changed until the owner approves exactly it; with no position there, at once", async () => {
    const x = await run(fresh(), 0);
    ok(await x.connect());
    await x.letIn({ per: "100", budget: "100" });
    ok(await x.own({ type: "setPolicy", change: "maxLeverage", value: "5" }));
    // no position in the perpetual: set at once, in Guard too (the next order's card shows the leverage)
    expect(result(await x.ag({ type: "agentLiveLeverage", venue: "ex", symbol: PERP.symbol, leverage: "3", marginMode: "" }))).toEqual({ venue: "ex", symbol: PERP.symbol, leverage: 3 });
    // a position open there — whose, the account cannot tell: its risk changes with the leverage, so the owner is asked
    ex.positions = [perpLong(0.01, 600)];
    const asked = await x.ag({ type: "agentLiveLeverage", venue: "ex", symbol: PERP.symbol, leverage: "5", marginMode: "isolated" });
    if (isRefusal(asked) || asked.kind !== "card") throw new Error(`expected a card, got ${words(asked)}`);
    expect(asked.card.reason).toBe("Claude Code asks to set leverage to 5x on BTC perpetual — a position of 0.01 BTC is open there");
    expect(asked.card.offer).toMatchObject({ payee: "Ex", payTo: PERP.symbol, amount: "leverage 5x · isolated margin", network: "a long position of 0.01 BTC (about $600.00) is open there: its risk changes with the leverage" });
    expect(ex.leverage).toEqual([{ symbol: PERP.symbol, leverage: 3, marginMode: undefined }]);
    const card = x.engine.host.card(asked.card.id)!;
    expect(result(await x.own({ type: "approveCard", card: card.id, action: cardHash(card), decision: "approve" }))).toEqual({ venue: "ex", symbol: PERP.symbol, leverage: 5, marginMode: "isolated" });
    expect(ex.leverage.at(-1)).toEqual({ symbol: PERP.symbol, leverage: 5, marginMode: "isolated" });
  });

  it("Beast: at once while the position is inside the agent's per-order line, a card above it", async () => {
    const x = await run(fresh(), 0);
    ok(await x.connect());
    await x.letIn({ per: "100", budget: "100" });
    ok(await x.own({ type: "setPolicy", change: "maxLeverage", value: "5" }));
    ok(await x.own({ type: "setPolicy", change: "mode", value: "open" }));
    ex.positions = [perpLong(0.001, 60)];
    expect(codeOf(await x.ag({ type: "agentLiveLeverage", venue: "ex", symbol: PERP.symbol, leverage: "2", marginMode: "" }))).toBe("result");
    ex.positions = [perpLong(0.01, 600)];
    expect(codeOf(await x.ag({ type: "agentLiveLeverage", venue: "ex", symbol: PERP.symbol, leverage: "4", marginMode: "" }))).toBe("card");
    expect(ex.leverage.map((l) => l.leverage)).toEqual([2]);
  });
});

describe("A9 · a trading limit's window", () => {
  it("one order per window at each venue: the second inside the hour is refused, a change to the first is not, and after the hour an order goes", async () => {
    const x = await run(fresh(), 0);
    ok(await x.connect());
    const made = await x.letIn({ per: "100", budget: "1000", windowHours: 1 });
    expect(made.kind === "account" && made.summary).toContain("one order every 1 h at each venue");
    ok(await x.own({ type: "setPolicy", change: "mode", value: "open" }));
    expect(codeOf(await x.ag(limitOrder))).toBe("order");
    expect(words(await x.ag(limitOrder))).toBe('E_MANDATE_RATE: an order was placed at "ex" 0 min ago; the trading limit allows one order every 1 h at each venue');
    // a change to the order already placed is not a second order
    expect(codeOf(await x.ag({ type: "agentLiveAmend", venue: "ex", order: "ord-0001", qty: "0.0011", limitPrice: "", stopPrice: "" }))).toBe("order");
    x.pass(61 * MIN);
    expect(codeOf(await x.ag(limitOrder))).toBe("order");
    expect(x.engine.orders.map((o) => o.id)).toEqual(["ord-0002", "ord-0001"]);
  });
});

describe("A10 · the table of answers", () => {
  it("the same envelope again gets its first answer inside the nonce window; past it the answer is let go, and the envelope is too old", async () => {
    const x = await run(fresh(), 0);
    const env = await x.signed({ type: "setWatch", venue: "ex", symbol: BTC.symbol, on: "true" });
    const first = ok(await x.svc.exchange(env));
    expect(await x.svc.exchange(env)).toBe(first);
    const table = (x.engine as unknown as { results: Map<string, unknown> }).results;
    expect(table.size).toBe(1);
    x.pass(2 * DAY + MIN);
    expect(words(await x.svc.exchange(env))).toBe("E_ACCOUNT_NONCE: this nonce is more than two days old");
    expect(table.size).toBe(0);
  });
});

describe("A11 · an order whose venue is not connected, asked to cancel", () => {
  it("an agent's cancel waits while the venue is being connected again; the owner's lets it go: what it held of the limit is free, its line says so, the venue can be connected again, and a later run does not follow it", async () => {
    const home = fresh();
    const r1 = await run(home, 0);
    ok(await r1.connect());
    await r1.letIn({ per: "100", budget: "100" });
    ok(await r1.own({ type: "setPolicy", change: "mode", value: "open" }));
    expect(codeOf(await r1.ag(limitOrder))).toBe("order");
    expect(r1.trade().spentMicro).toBe(59_000_000);
    // the account restarts while the venue is down, and the venue stays down
    ex.down = true;
    const r2 = await run(home, HOUR);
    expect([r2.engine.orders.map((o) => [o.id, o.status]), r2.trade().spentMicro]).toEqual([[["ord-0001", "open"]], 59_000_000]);
    // the agent's cancel waits for the venue the account is connecting again: the order may still be live there, so its share of the limit
    // stays held
    const wait = await r2.ag({ type: "agentLiveCancel", venue: "ex", order: "ord-0001" });
    expect([isRefusal(wait) && wait.code, r2.trade().spentMicro]).toEqual(["E_VENUE_UNREACHABLE", 59_000_000]);
    // the owner lets it go
    const gone = await r2.own({ type: "liveCancel", venue: "ex", order: "ord-0001" });
    if (isRefusal(gone) || gone.kind !== "order") throw new Error(`expected an order, got ${words(gone)}`);
    expect([gone.order.unfollowed, gone.order.status, r2.trade().spentMicro]).toEqual([true, "open", 0]);
    expect(gone.order.note).toBe("not followed since a restart: Ex is not connected, so the account can neither cancel it nor see it fill. Cancel it at the venue");
    expect(r2.svc.statement().map((l) => [l.type, l.status])).toEqual([["trade", "not followed since a restart"]]);
    // asked again, there is nothing to do; and the order blocks nothing: the venue, reachable again, is connected again
    expect(words(await r2.own({ type: "liveCancel", venue: "ex", order: "ord-0001" }))).toBe("E_ACCOUNT_BAD_ACTION: ord-0001 is not followed since a restart: Ex is not connected, so it is canceled at the venue");
    ex.down = false;
    expect(words(await r2.connect())).toBe("account");
    // the next run does not follow it either
    const r3 = await run(home, 2 * HOUR);
    expect([r3.engine.orders, r3.trade().spentMicro]).toEqual([[], 0]);
  });
});
