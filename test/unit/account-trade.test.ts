import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isRefusal, type Refusal } from "../../src/core/errors.ts";
import { no } from "../../src/portfolio/refuse.ts";
import { cardHash, type Outcome } from "../../src/portfolio/account/exchange.ts";
import type { LiveOrder } from "../../src/portfolio/account/live-orders.ts";
import { signAgent, signOwner, simKey, type AgentAction, type OwnerAction } from "../../src/portfolio/account/sign.ts";
import { register, type LiveDeps } from "../../src/portfolio/live/index.ts";
import type { LiveTrader, Market, OrderRequest, OrderState } from "../../src/portfolio/live/trade.ts";
import { PortfolioService } from "../../src/portfolio/service.ts";

/** ORDERS at venues connected live, against a stand-in venue that answers like a real one would and remembers every order it is asked to
 * place. The engine's rules are what is tested here — the switch, the cap, the market's own steps, the owner's signature, the agent's
 * trading limit, the two modes, cancelling, and what became of an order. Each venue's own language is tested in its own file. */
type NoNonce<T> = T extends unknown ? Omit<T, "nonce"> : never;
const START = Date.parse("2026-10-05T14:00:00.000Z");
const DAY = 86_400_000;
const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));
const owner = simKey("owner");
const cc = simKey("agent:claude-code");
const other = simKey("agent:other-seat");

interface Venue {
  trader: LiveTrader;
  placed: OrderRequest[];
  canceled: string[];
  markets: Record<string, Market>;
  /** what the venue says about an order the next time it is asked */
  next: Record<string, Partial<OrderState>>;
  can: boolean | "unknown";
}

const BTC: Market = { symbol: "BTC/USDT", name: "BTC/USDT", kind: "spot", base: "BTC", quote: "USDT", price: 60_000, bid: 59_990, ask: 60_010, minQty: 0.0001, qtyStep: 0.0001, priceStep: 0.1, open: true, types: ["market", "limit"] };
const ETHBTC: Market = { ...BTC, symbol: "ETH/BTC", name: "ETH/BTC", base: "ETH", quote: "BTC", price: 0.05, bid: 0.05, ask: 0.05 };
const CLOSED: Market = { ...BTC, symbol: "AAPL", name: "Apple", kind: "stock", base: "AAPL", quote: "USD", price: 200, bid: 199.9, ask: 200.1, minQty: 1, qtyStep: 1, priceStep: 0.01, open: false, note: "the stock market opens at 9:30 New York" };

function standIn(): Venue {
  const v: Venue = { placed: [], canceled: [], markets: { [BTC.symbol]: { ...BTC }, [ETHBTC.symbol]: ETHBTC, [CLOSED.symbol]: CLOSED }, next: {}, can: true, trader: undefined as never };
  const states = new Map<string, OrderState>();
  v.trader = {
    get can() {
      return v.can;
    },
    what: "spot",
    async markets(q) {
      return Object.values(v.markets).filter((m) => m.symbol.startsWith(q.toUpperCase()));
    },
    async market(symbol) {
      return v.markets[symbol] ? { ...v.markets[symbol]! } : no("E_VENUE_REJECTED", { venue: "standin", message: `no market ${symbol}` });
    },
    async place(o) {
      v.placed.push(o);
      const ref = `x-${v.placed.length}`;
      const s: OrderState = o.type === "market" ? { ref, status: "filled", filledQty: o.qty, avgPrice: o.side === "buy" ? 60_010 : 59_990, feeUsd: 0.06, native: { id: ref } } : { ref, status: "open", filledQty: 0, native: { id: ref } };
      states.set(ref, s);
      return s;
    },
    async cancel(ref) {
      v.canceled.push(ref);
      const s = { ...states.get(ref)!, status: "canceled" as const };
      states.set(ref, s);
      return s;
    },
    async status(ref) {
      const s = { ...states.get(ref)!, ...(v.next[ref] ?? {}) };
      states.set(ref, s);
      return s;
    },
  };
  return v;
}

let current: Venue | undefined;
register({ kind: "standin-trade", label: "a venue that trades", needs: "key-file", example: "", venues: [], async open(req) {
  const v = current!;
  return { source: { name: req.label || "Stand-in", kind: "cex", reference: "standin", via: "a stand-in", probe: { can: ["read", "trade"], note: "" }, read: async () => [{ asset: "USDT", amount: 500, usd: 500 }], trader: v.trader, readOnlyBecause: "the stand-in moves no money" }, first: [{ asset: "USDT", amount: 500, usd: 500 }], summary: "connected" };
} });

async function boot(o: { writes?: boolean; cap?: number } = {}) {
  let real = 5_000_000;
  let n = 0;
  const home = mkdtempSync(join(tmpdir(), "account-trade-"));
  homes.push(home);
  const venue = standIn();
  current = venue;
  const liveDeps: Partial<LiveDeps> = { clock: () => real, http: async () => ({ status: 599, body: undefined, text: "" }), price: async () => undefined };
  const svc = await PortfolioService.create({ home, now: () => new Date(START).toISOString(), venues: "frontline", real: true, liveDeps, ...(o.writes === false ? {} : { liveWrites: { capUsd: o.cap ?? 100, pairingCode: "K7QX-M2PA" } }), account: { owners: [{ id: owner.address, kind: "eoa", label: "owner", addedAt: new Date(START).toISOString() }] } });
  const engine = svc.account!;
  const nonce = () => START + ++n;
  const own = async (a: NoNonce<OwnerAction>) => svc.exchange(await signOwner(owner, { ...a, nonce: nonce() } as OwnerAction));
  const ag = async (a: NoNonce<AgentAction>, key = cc) => svc.exchange(await signAgent(key, { ...a, nonce: nonce() } as AgentAction));
  const connected = await own({ type: "connectVenue", venue: "ex", connector: "live:standin-trade", label: "Stand-in", credentialRef: "" });
  if (isRefusal(connected)) throw new Error(connected.message);
  const prepared = async (draft: Record<string, unknown>) => engine.prepare({ type: "liveOrder", venue: "ex", ...draft });
  /** what the page does: prepare, then sign exactly what came back */
  const order = async (draft: Record<string, unknown>, change: Record<string, unknown> = {}) => {
    const p = await prepared(draft);
    if (isRefusal(p)) return p;
    const { nonce: _n, ...rest } = p.action as Extract<OwnerAction, { type: "liveOrder" }>;
    return own({ ...rest, ...change } as NoNonce<OwnerAction>);
  };
  const letIn = async (limit: { allow?: string; perOrder?: string; budget?: string; scope?: string } = {}, key = cc, name = "Claude Code") => {
    await own({ type: "approveAgent", agentAddress: key.address, agentName: name, validUntil: START + 30 * DAY });
    return own({ type: "approveSpend", agent: key.address, scope: limit.scope ?? "trade", allow: limit.allow ?? "ex", perPayment: limit.perOrder ?? "50", budget: limit.budget ?? "100", windowHours: 0, validUntil: START + 7 * DAY });
  };
  const trade = () => engine.state.spends.find((s) => s.scope === "trade" && s.revokedAt === undefined)!;
  return { svc, engine, venue, own, ag, order, prepared, letIn, trade, tick: (ms: number) => (real += ms), page: async () => (await svc.accountView())! };
}

const code = (o: Outcome | Refusal): string => (isRefusal(o) ? o.code : o.kind);
const refusal = (o: unknown): Refusal => {
  if (!isRefusal(o)) throw new Error(`expected a refusal, got ${JSON.stringify(o).slice(0, 200)}`);
  return o;
};
const placed = (o: Outcome): LiveOrder => {
  if (isRefusal(o) || o.kind !== "order") throw new Error(`expected an order, got ${isRefusal(o) ? `${o.code}: ${o.message}` : o.kind}`);
  return o.order;
};
const ask = (o: Partial<Extract<AgentAction, { type: "agentLiveOrder" }>> = {}) => ({ type: "agentLiveOrder" as const, venue: "ex", symbol: "BTC/USDT", side: "buy", orderType: "market", qty: "", usd: "30", limitPrice: "", ...o });

describe("orders at venues connected live", () => {
  it("places nothing on a server started read-only, and says how to turn trading on", async () => {
    const x = await boot({ writes: false });
    const r = refusal(await x.prepared({ symbol: "BTC/USDT", side: "buy", orderType: "market", usd: "30" }));
    expect([r.code, r.message]).toEqual(["E_WALLET_LIVE_WRITES_OFF", "this server places no orders: it was started read-only. To trade, stop it and start it again with: npm run account"]);
    expect(x.venue.placed).toHaveLength(0);
  });

  it("the owner's order: the exact size, the most it may be worth and ten minutes are what is signed, and the venue gets the account's id for it", async () => {
    const x = await boot();
    const p = await x.prepared({ symbol: "BTC/USDT", side: "buy", orderType: "market", usd: "30" });
    if (isRefusal(p)) throw new Error(p.message);
    // $30 at the ask of 60,010 is 0.000499… BTC, down to the step: 0.0004; worth $24.00, and up to 2% more for a market buy
    expect([p.action, p.accountChain, p.quote?.order?.notionalUsd]).toEqual([{ type: "liveOrder", venue: "ex", symbol: "BTC/USDT", side: "buy", orderType: "market", qty: "0.0004", limitPrice: "", maxNotional: "24.49", deadline: 5_600_000, nonce: p.action.nonce }, "Live · real money", 24]);
    const o = placed(await x.order({ symbol: "BTC/USDT", side: "buy", orderType: "market", usd: "30" }));
    expect(x.venue.placed).toEqual([{ symbol: "BTC/USDT", side: "buy", type: "market", qty: 0.0004, clientId: o.id }]);
    expect([o.id, o.status, o.filledQty, o.avgPrice, o.authority, o.note]).toEqual(["ord-0001", "filled", 0.0004, 60_010, "owner", "filled at 60010 · fee $0.06"]);
    // the page shows it
    expect((await x.page()).orders.map((y) => [y.id, y.status])).toEqual([["ord-0001", "filled"]]);
  });

  it("an order the market cannot take as written is refused before the venue sees it: below the smallest order, off the size step, off the price step", async () => {
    const x = await boot();
    expect(refusal(await x.prepared({ symbol: "BTC/USDT", side: "buy", orderType: "market", usd: "3" })).code).toBe("E_VENUE_ORDER_INVALID");
    expect(refusal(await x.prepared({ symbol: "BTC/USDT", side: "buy", orderType: "market", qty: "0.00015" })).message).toBe("Stand-in: a size in BTC/USDT moves in steps of 0.0001 BTC");
    expect(refusal(await x.prepared({ symbol: "BTC/USDT", side: "buy", orderType: "limit", qty: "0.001", limitPrice: "59000.05" })).message).toBe("Stand-in: a price in BTC/USDT moves in steps of 0.1");
    expect(refusal(await x.prepared({ symbol: "BTC/USDT", side: "buy", orderType: "market", qty: "0.001", usd: "60" })).code).toBe("E_ACCOUNT_BAD_ACTION");
    expect(refusal(await x.prepared({ symbol: "BTC/USDT", side: "buy", orderType: "market", qty: "0.001", limitPrice: "59000" })).code).toBe("E_ACCOUNT_BAD_ACTION");
    expect(x.venue.placed).toHaveLength(0);
  });

  it("only markets priced in dollars, only while they are open, only if the key may trade", async () => {
    const x = await boot();
    expect(refusal(await x.prepared({ symbol: "ETH/BTC", side: "buy", orderType: "market", qty: "1" })).message).toBe("ETH/BTC is priced in BTC: the account trades markets priced in dollars, so that every limit means dollars");
    expect(refusal(await x.prepared({ symbol: "AAPL", side: "buy", orderType: "limit", qty: "1", limitPrice: "190" })).message).toBe("Stand-in: Apple takes no orders now (the stock market opens at 9:30 New York)");
    x.venue.can = false;
    expect(refusal(await x.prepared({ symbol: "BTC/USDT", side: "buy", orderType: "market", usd: "30" })).code).toBe("E_VENUE_PERMISSION");
  });

  it("no order is worth more than the server's cap, valued at the price the venue shows now", async () => {
    const x = await boot({ cap: 50 });
    const r = refusal(await x.prepared({ symbol: "BTC/USDT", side: "sell", orderType: "limit", qty: "0.001", limitPrice: "60000" }));
    expect([r.code, r.message]).toEqual(["E_ACCOUNT_LIMIT", "$60.00 is more than the most one order may be on this server ($50.00). It is set when the server starts: --live-cap"]);
  });

  it("a price that moved past what was signed, or a signature older than ten minutes, places nothing", async () => {
    const x = await boot();
    const p = await x.prepared({ symbol: "BTC/USDT", side: "buy", orderType: "market", qty: "0.0005" });
    if (isRefusal(p)) throw new Error(p.message);
    // the market jumps 5% before the owner signs
    x.venue.markets["BTC/USDT"] = { ...BTC, ask: 63_010, price: 63_000 };
    const { nonce: _n, ...rest } = p.action as Extract<OwnerAction, { type: "liveOrder" }>;
    const moved = refusal(await x.own(rest));
    expect([moved.code, moved.message]).toEqual(["E_ACCOUNT_REQUOTE", "the price moved: at 63010 the order is worth $31.51 now, more than the $30.61 signed for. Nothing was placed"]);
    x.venue.markets["BTC/USDT"] = { ...BTC };
    x.tick(11 * 60_000);
    expect(refusal(await x.own({ ...rest, maxNotional: "40.00" })).code).toBe("E_ACCOUNT_EXPIRED");
    expect(x.venue.placed).toHaveLength(0);
  });

  it("the same signed order twice is one order", async () => {
    const x = await boot();
    const p = await x.prepared({ symbol: "BTC/USDT", side: "sell", orderType: "limit", qty: "0.0005", limitPrice: "65000" });
    if (isRefusal(p)) throw new Error(p.message);
    const envelope = await signOwner(owner, p.action);
    const a = await x.svc.exchange(envelope);
    const b = await x.svc.exchange(envelope);
    expect([placed(a).id, placed(b).id, x.venue.placed.length]).toEqual(["ord-0001", "ord-0001", 1]);
  });

  it("an agent trades only inside the trading limit the owner signed: which venues, how much an order, how much in all", async () => {
    const x = await boot();
    await x.own({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: START + 30 * DAY });
    expect(refusal(await x.ag(ask())).message).toBe("the owner has not approved this agent to trade: it gets a trading limit on the account page (Agents)");
    // a limit to MOVE money is not a limit to trade
    await x.own({ type: "approveSpend", agent: cc.address, scope: "venues", allow: "ex", perPayment: "50", budget: "100", windowHours: 0, validUntil: START + 7 * DAY });
    expect(code(await x.ag(ask()))).toBe("E_MANDATE_NONE");
    await x.letIn({ allow: "ex", perOrder: "50", budget: "100" });
    expect(refusal(await x.ag(ask({ venue: "elsewhere" }))).message).toBe('the trading limit does not cover "elsewhere" (it covers ex)');
    expect(refusal(await x.ag(ask({ usd: "", qty: "0.001" }))).message).toBe("an order of $61.21 is more than the $50.00 an order the trading limit allows");
    expect(x.venue.placed).toHaveLength(0);
  });

  it("Conservative: an agent's order is a card every time; the owner's yes places it, and it counts against the limit", async () => {
    const x = await boot();
    await x.letIn();
    const r = await x.ag(ask());
    if (isRefusal(r) || r.kind !== "card") throw new Error(`expected a card, got ${JSON.stringify(r).slice(0, 200)}`);
    expect([r.card.reason, r.card.usd, r.card.offer?.payTo, x.venue.placed.length]).toEqual(["Claude Code asks to buy 0.0004 BTC at Stand-in · market · about $24.00", 24.49, "BTC/USDT", 0]);
    expect(x.trade().reservedMicro).toBe(24_484_080);
    const yes = await x.own({ type: "approveCard", card: r.card.id, action: cardHash(r.card), decision: "approve" });
    const o = placed(yes);
    expect([o.authority, o.card, o.agent, x.venue.placed.length, x.trade().reservedMicro]).toEqual(["agent", r.card.id, cc.address, 1, 0]);
    // a market order filled at once: what it used is counted, the room for the price to move is given back
    expect(x.trade().spentMicro).toBe(24_004_000);
    // a no places nothing and frees what the card held
    const r2 = await x.ag(ask({ usd: "20" }));
    if (isRefusal(r2) || r2.kind !== "card") throw new Error("expected a card");
    await x.own({ type: "approveCard", card: r2.card.id, action: cardHash(r2.card), decision: "reject" });
    expect([x.venue.placed.length, x.trade().reservedMicro]).toEqual([1, 0]);
  });

  it("Aggressive: inside its limit an agent's order is placed at once, and nothing outside it is", async () => {
    const x = await boot();
    await x.letIn({ perOrder: "50", budget: "60" });
    await x.own({ type: "setPolicy", change: "mode", value: "open" });
    const o = placed(await x.ag(ask({ orderType: "limit", usd: "", qty: "0.0005", limitPrice: "58000" })));
    expect([o.status, o.authority, o.card, o.usd, x.trade().spentMicro]).toEqual(["open", "agent", undefined, 29, 29_000_000]);
    expect(code(await x.ag(ask({ orderType: "limit", usd: "", qty: "0.0006", limitPrice: "58000" })))).toBe("E_MANDATE_BUDGET");
    expect(x.venue.placed).toHaveLength(1);
    // back to Conservative needs no signature, and from then on it is a card again
    x.svc.setMode("guard");
    expect(code(await x.ag(ask({ usd: "10" })))).toBe("card");
  });

  it("cancelling: an agent its own orders, without a card even in Conservative; the owner any; what never filled goes back to the limit", async () => {
    const x = await boot();
    await x.letIn({ perOrder: "50", budget: "100" });
    await x.own({ type: "setPolicy", change: "mode", value: "open" });
    const mine = placed(await x.ag(ask({ orderType: "limit", usd: "", qty: "0.0005", limitPrice: "58000" })));
    const ownersOrder = placed(await x.order({ symbol: "BTC/USDT", side: "sell", orderType: "limit", qty: "0.0005", limitPrice: "70000" }));
    x.svc.setMode("guard");
    // another agent, or this one on the owner's order: not its to cancel
    await x.letIn({}, other, "Other");
    expect(code(await x.ag({ type: "agentLiveCancel", venue: "ex", order: mine.id }, other))).toBe("E_ACCOUNT_ORDER_UNKNOWN");
    expect(refusal(await x.ag({ type: "agentLiveCancel", venue: "ex", order: ownersOrder.id })).message).toBe("ord-0002 was not placed by this agent: an agent cancels only its own orders");
    expect(x.trade().spentMicro).toBe(29_000_000);
    const gone = placed(await x.ag({ type: "agentLiveCancel", venue: "ex", order: mine.id }));
    expect([gone.status, gone.note, x.venue.canceled, x.trade().spentMicro]).toEqual(["canceled", "canceled · nothing filled", ["x-1"], 0]);
    expect(code(await x.ag({ type: "agentLiveCancel", venue: "ex", order: mine.id }))).toBe("E_ACCOUNT_BAD_ACTION");
    expect(placed(await x.own({ type: "liveCancel", venue: "ex", order: ownersOrder.id })).status).toBe("canceled");
  });

  it("what became of an order is asked of the venue: a resting order that fills later shows as filled", async () => {
    const x = await boot();
    const o = placed(await x.order({ symbol: "BTC/USDT", side: "buy", orderType: "limit", qty: "0.0005", limitPrice: "59000" }));
    x.venue.next[o.ref] = { status: "partial", filledQty: 0.0002, avgPrice: 59_000 };
    await x.engine.settle();
    expect((await x.page()).orders[0]!.status).toBe("open");
    x.tick(11_000);
    expect((await x.page()).orders[0]!.note).toBe("0.0002 of 0.0005 filled at 59000");
    x.venue.next[o.ref] = { status: "filled", filledQty: 0.0005, avgPrice: 59_000 };
    x.tick(11_000);
    expect((await x.page()).orders[0]!.status).toBe("filled");
  });

  it("the simulated order routes are refused on a real account: an agent trades with agentLiveOrder", async () => {
    const x = await boot();
    await x.letIn();
    expect(refusal(await x.ag({ type: "agentOrder", base: "BTC", side: "buy", qty: 1 })).detail).toEqual({ use: ["liveOrder", "agentLiveOrder", "liveMove", "agentLiveMove"] });
    expect(code(await x.ag({ type: "agentExecute", account: "ex", intent: { kind: "trade", symbol: "BTC/USDT", side: "buy", qty: 1 } }))).toBe("E_ACCOUNT_BAD_ACTION");
  });

  it("the page knows where orders can be placed and what is traded there", async () => {
    const x = await boot();
    const v = (await x.page()).venues.find((y) => y.id === "ex")!;
    expect(v.trade).toEqual({ can: true, what: "spot" });
    expect(await x.svc.liveMarkets("ex", "btc")).toEqual([BTC]);
    expect(code((await x.svc.liveMarket("nowhere", "BTC/USDT")) as Refusal)).toBe("E_WALLET_ACCOUNT_UNKNOWN");
  });
});
