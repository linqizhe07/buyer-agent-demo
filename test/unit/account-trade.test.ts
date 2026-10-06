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
  /** how many times a market was asked for */
  asked: number;
  /** a test's own answers, in place of the stand-in's */
  onPlace?: (o: OrderRequest, ref: string) => OrderState | undefined;
  onCancel?: (ref: string) => OrderState;
  onStatus?: ((ref: string) => Promise<OrderState> | OrderState) | undefined;
}

const BTC: Market = { symbol: "BTC/USDT", name: "BTC/USDT", kind: "spot", base: "BTC", quote: "USDT", price: 60_000, bid: 59_990, ask: 60_010, minQty: 0.0001, qtyStep: 0.0001, priceStep: 0.1, open: true, types: ["market", "limit"] };
const ETHBTC: Market = { ...BTC, symbol: "ETH/BTC", name: "ETH/BTC", base: "ETH", quote: "BTC", price: 0.05, bid: 0.05, ask: 0.05 };
/** a perpetual whose contract is 1000 coins, and a token swapped from a wallet */
const DOGE: Market = { symbol: "DOGE/USDT:USDT", name: "DOGE perpetual", kind: "perp", base: "DOGE", quote: "USDT", price: 0.15, bid: 0.15, ask: 0.15, minQty: 0.1, qtyStep: 0.1, priceStep: 0.00001, contractSize: 1000, open: true, types: ["market", "limit"] };
const SWAP: Market = { symbol: "WETH/USDC@Base", name: "WETH on Base", kind: "token", base: "WETH", quote: "USDC", price: 3000, bid: 3000, ask: 3000, minQty: 0.0001, qtyStep: 0.0001, open: true, types: ["market"] };
const CLOSED: Market = { ...BTC, symbol: "AAPL", name: "Apple", kind: "stock", base: "AAPL", quote: "USD", price: 200, bid: 199.9, ask: 200.1, minQty: 1, qtyStep: 1, priceStep: 0.01, open: false, note: "the stock market opens at 9:30 New York" };

function standIn(): Venue {
  const v: Venue = { placed: [], canceled: [], markets: { [BTC.symbol]: { ...BTC }, [ETHBTC.symbol]: ETHBTC, [CLOSED.symbol]: CLOSED, [DOGE.symbol]: DOGE, [SWAP.symbol]: SWAP }, next: {}, can: true, asked: 0, trader: undefined as never };
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
      v.asked++;
      return v.markets[symbol] ? { ...v.markets[symbol]! } : no("E_VENUE_REJECTED", { venue: "standin", message: `no market ${symbol}` });
    },
    async place(o) {
      v.placed.push(o);
      const ref = `x-${v.placed.length}`;
      const m = v.markets[o.symbol]!;
      const s: OrderState = v.onPlace?.(o, ref) ?? (o.type === "market" ? { ref, status: "filled", filledQty: o.qty, avgPrice: o.side === "buy" ? (m.ask ?? m.price!) : (m.bid ?? m.price!), feeUsd: 0.06, native: { id: ref } } : { ref, status: "open", filledQty: 0, native: { id: ref } });
      states.set(ref, s);
      return s;
    },
    async cancel(ref) {
      v.canceled.push(ref);
      const s = v.onCancel?.(ref) ?? { ...states.get(ref)!, status: "canceled" as const };
      states.set(ref, s);
      return s;
    },
    async status(ref) {
      if (v.onStatus) return v.onStatus(ref);
      const s = { ...states.get(ref)!, ...(v.next[ref] ?? {}) };
      states.set(ref, s);
      return s;
    },
    async sent(ref, hash) {
      return { ref: hash, status: "pending", filledQty: 0, native: { sent: hash, order: ref } };
    },
  };
  return v;
}

let current: Venue | undefined;
register({ kind: "standin-trade", label: "a venue that trades", needs: "key-file", example: "", venues: [], async open(req) {
  const v = current!;
  return { source: { name: req.label || "Stand-in", kind: "cex", reference: "standin", via: "a stand-in", probe: { can: ["read", "trade"], note: "" }, read: async () => [{ asset: "USDT", amount: 500, usd: 500 }], trader: v.trader, readOnlyBecause: "the stand-in moves no money" }, first: [{ asset: "USDT", amount: 500, usd: 500 }], summary: "connected" };
} });

async function boot(o: { writes?: boolean; cap?: number; home?: string; nonceFrom?: number } = {}) {
  let real = 5_000_000;
  // a second run on the same home signs new instructions, not the first run's again
  let n = o.nonceFrom ?? 0;
  const home = o.home ?? mkdtempSync(join(tmpdir(), "account-trade-"));
  if (!o.home) homes.push(home);
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
  return { svc, engine, venue, home, liveDeps, own, ag, order, prepared, letIn, trade, tick: (ms: number) => (real += ms), page: async () => (await svc.accountView())! };
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
    expect([p.action, p.accountChain, p.quote?.order?.notionalUsd]).toEqual([{ type: "liveOrder", venue: "ex", symbol: "BTC/USDT", side: "buy", orderType: "market", qty: "0.0004", limitPrice: "", stopPrice: "", tif: "", postOnly: "", reduceOnly: "", maxNotional: "24.49", deadline: 5_600_000, nonce: p.action.nonce }, "Live · real money", 24]);
    const o = placed(await x.order({ symbol: "BTC/USDT", side: "buy", orderType: "market", usd: "30" }));
    // the venue gets the worst price it may fill at (2% over the ask, down to the price step) and a client id no other run sends
    expect(x.venue.placed).toEqual([{ symbol: "BTC/USDT", side: "buy", type: "market", qty: 0.0004, worstPrice: 61_210.2, clientId: o.clientId }]);
    expect(o.clientId).toMatch(/^[0-9a-f]{32}$/);
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
    expect(refusal(await x.ag(ask({ usd: "", qty: "0.001" }))).message).toBe("an order of $61.22 is more than the $50.00 an order the trading limit allows");
    expect(x.venue.placed).toHaveLength(0);
  });

  it("Conservative: an agent's order is a card every time; the owner's yes places it, and it counts against the limit", async () => {
    const x = await boot();
    await x.letIn();
    const r = await x.ag(ask());
    if (isRefusal(r) || r.kind !== "card") throw new Error(`expected a card, got ${JSON.stringify(r).slice(0, 200)}`);
    expect([r.card.reason, r.card.usd, r.card.offer?.payTo, x.venue.placed.length]).toEqual(["Claude Code asks to buy 0.0004 BTC at Stand-in · market · about $24.00", 24.49, "BTC/USDT", 0]);
    // the card holds what it shows, to the cent
    expect(x.trade().reservedMicro).toBe(24_490_000);
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
    // and what else it does there: this stand-in lists no positions, changes no order in place, sets no leverage, closes nothing itself
    // (its kinds of market are read from the connector: a stand-in's is one the account names none for)
    expect(v.trade).toEqual({ can: true, what: "spot", kinds: [], positions: false, amend: false, leverage: false, close: false });
    expect(await x.svc.liveMarkets("ex", "btc")).toEqual([BTC]);
    expect(code((await x.svc.liveMarket("nowhere", "BTC/USDT")) as Refusal)).toBe("E_WALLET_ACCOUNT_UNKNOWN");
  });
});

/** What an adversarial review of the order door found, each kept as a case that must hold */
describe("orders: what the review found", () => {
  it("a limit sell priced under the bid is valued at the bid, so it cannot slip past the cap or the limit", async () => {
    const x = await boot();
    await x.letIn();
    await x.own({ type: "setPolicy", change: "mode", value: "open" });
    // 0.5 BTC at a limit of 60 would fill at once at the bid of 59,990: it is worth $29,995, not $30
    const r = refusal(await x.ag(ask({ side: "sell", orderType: "limit", usd: "", qty: "0.5", limitPrice: "60" })));
    expect([r.code, x.venue.placed.length]).toEqual(["E_ACCOUNT_LIMIT", 0]);
    // sized in dollars, the size is worked out at the bid too
    const p = await x.prepared({ symbol: "BTC/USDT", side: "sell", orderType: "limit", usd: "30", limitPrice: "0.1" });
    if (isRefusal(p)) throw new Error(p.message);
    expect((p.action as Extract<OwnerAction, { type: "liveOrder" }>).qty).toBe("0.0005");
  });

  it("a contract's size is in what an order is counted at and in what its fill gives back", async () => {
    const x = await boot();
    await x.letIn({ perOrder: "50", budget: "100" });
    await x.own({ type: "setPolicy", change: "mode", value: "open" });
    const o = placed(await x.ag(ask({ symbol: "DOGE/USDT:USDT", usd: "", qty: "0.3" })));
    // 0.3 contracts of 1000 DOGE at 0.15 is $45; filled at once, $45 stays counted
    expect([o.status, x.trade().spentMicro]).toEqual(["filled", 45_000_000]);
    expect(code(await x.ag(ask({ symbol: "DOGE/USDT:USDT", usd: "", qty: "0.3" })))).toBe("order");
    expect(code(await x.ag(ask({ symbol: "DOGE/USDT:USDT", usd: "", qty: "0.3" })))).toBe("E_MANDATE_BUDGET");
  });

  it("a venue that fills worse than the worst price it was given is counted at what it really cost, and the ledger says so", async () => {
    const x = await boot();
    await x.letIn({ perOrder: "50", budget: "100" });
    await x.own({ type: "setPolicy", change: "mode", value: "open" });
    x.venue.onPlace = (o, ref) => ({ ref, status: "filled", filledQty: o.qty, avgPrice: 70_000, native: {} });
    placed(await x.ag(ask({ usd: "", qty: "0.0005" })));
    // 0.0005 BTC at 70,000 is $35, more than the $30.61 the worst price allowed
    expect(x.trade().spentMicro).toBe(35_000_000);
    expect(x.svc.ledgerRows().some((r) => r.kind === "order" && r.outcome === "overrun")).toBe(true);
  });

  it("a signed market sell is held from below: a small rise goes through, a fall of more than 2% does not, and the venue is told the least it may take", async () => {
    const x = await boot();
    const sign = async () => {
      const p = await x.prepared({ symbol: "BTC/USDT", side: "sell", orderType: "market", qty: "0.0015" });
      if (isRefusal(p)) throw new Error(p.message);
      const { nonce: _n, ...rest } = p.action as Extract<OwnerAction, { type: "liveOrder" }>;
      return rest;
    };
    const up = await sign();
    x.venue.markets["BTC/USDT"] = { ...BTC, bid: 60_500 };
    placed(await x.own(up));
    expect(x.venue.placed[0]!.worstPrice).toBe(59_290);
    x.venue.markets["BTC/USDT"] = { ...BTC };
    const down = await sign();
    x.venue.markets["BTC/USDT"] = { ...BTC, bid: 50_000 };
    const r = refusal(await x.own(down));
    expect([r.code, r.message.startsWith("the price fell")]).toEqual(["E_ACCOUNT_REQUOTE", true]);
    expect(x.venue.placed).toHaveLength(1);
  });

  it("the owner's yes places exactly the card: its size and its market, and nothing after the price has moved against it", async () => {
    const x = await boot();
    await x.letIn();
    const r = await x.ag(ask({ side: "sell", usd: "30" }));
    if (isRefusal(r) || r.kind !== "card") throw new Error("expected a card");
    expect(r.card.intent).toEqual({ kind: "trade", symbol: "BTC/USDT", side: "sell", qty: 0.0005 });
    x.venue.markets["BTC/USDT"] = { ...BTC, bid: 50_000 };
    expect(code(await x.own({ type: "approveCard", card: r.card.id, action: cardHash(r.card), decision: "approve" }))).toBe("E_ACCOUNT_REQUOTE");
    x.venue.markets["BTC/USDT"] = { ...BTC };
    const r2 = await x.ag(ask({ side: "sell", usd: "30" }));
    if (isRefusal(r2) || r2.kind !== "card") throw new Error("expected a card");
    // a rise of the bid would buy a smaller size for the same dollars: the card's size is what is placed
    x.venue.markets["BTC/USDT"] = { ...BTC, bid: 61_000 };
    placed(await x.own({ type: "approveCard", card: r2.card.id, action: cardHash(r2.card), decision: "approve" }));
    expect(x.venue.placed.map((o) => o.qty)).toEqual([0.0005]);
  });

  it("an approved card is judged again against the trading limit as it stands: a limit revoked meanwhile places nothing", async () => {
    const x = await boot();
    await x.letIn();
    const r = await x.ag(ask());
    if (isRefusal(r) || r.kind !== "card") throw new Error("expected a card");
    await x.own({ type: "approveSpend", agent: cc.address, scope: "trade", allow: "ex", perPayment: "0", budget: "0", windowHours: 0, validUntil: START + 7 * DAY });
    expect(code(await x.own({ type: "approveCard", card: r.card.id, action: cardHash(r.card), decision: "approve" }))).toBe("E_MANDATE_NONE");
    expect(x.venue.placed).toHaveLength(0);
  });

  it("the dial stops agent orders: a venue switched off for agents, or the agents' session ended", async () => {
    const x = await boot();
    await x.letIn();
    await x.own({ type: "setPolicy", change: "mode", value: "open" });
    x.svc.revoke("ex");
    expect(code(await x.ag(ask()))).toBe("E_WALLET_ACCOUNT_REVOKED");
    x.svc.restore("ex");
    x.svc.revokeAll();
    expect(code(await x.ag(ask()))).toBe("E_WALLET_SESSION_EXPIRED");
    expect(x.venue.placed).toHaveLength(0);
  });

  it("a cancel the venue only took is followed until the venue says the order is gone, and it may still fill on the way", async () => {
    const x = await boot();
    await x.letIn();
    await x.own({ type: "setPolicy", change: "mode", value: "open" });
    const o = placed(await x.ag(ask({ orderType: "limit", usd: "", qty: "0.0005", limitPrice: "58000" })));
    x.venue.onCancel = (ref) => ({ ref, status: "open", filledQty: 0, native: { cancel: "accepted" } });
    const asked = placed(await x.ag({ type: "agentLiveCancel", venue: "ex", order: o.id }));
    expect([asked.status, asked.canceling, x.trade().spentMicro]).toEqual(["open", true, 29_000_000]);
    // it filled before the cancel reached the book: the fill is the answer, and it stays counted
    x.venue.onStatus = (ref) => ({ ref, status: "filled", filledQty: 0.0005, avgPrice: 58_000, native: {} });
    x.tick(11_000);
    expect((await x.page()).orders[0]!.status).toBe("filled");
    expect(x.trade().spentMicro).toBe(29_000_000);
  });

  it("a later run of the account does not take the owner's signed order again", async () => {
    const x = await boot();
    const p = await x.prepared({ symbol: "BTC/USDT", side: "sell", orderType: "limit", qty: "0.0005", limitPrice: "65000" });
    if (isRefusal(p)) throw new Error(p.message);
    const envelope = await signOwner(owner, p.action);
    const first = placed(await x.svc.exchange(envelope));
    const again = await boot({ home: x.home, nonceFrom: 100 });
    expect(code(await again.svc.exchange(envelope))).toBe("E_ACCOUNT_NONCE");
    // and a new order there gets a client id the first run never sent
    const second = placed(await again.order({ symbol: "BTC/USDT", side: "sell", orderType: "limit", qty: "0.0005", limitPrice: "66000" }));
    expect([second.id, second.clientId === first.clientId]).toEqual(["ord-0001", false]);
  });

  it("a venue with an open order is not disconnected until the order is done", async () => {
    const x = await boot();
    const o = placed(await x.order({ symbol: "BTC/USDT", side: "buy", orderType: "limit", qty: "0.0005", limitPrice: "50000" }));
    expect(refusal(await x.own({ type: "disconnectVenue", venue: "ex" })).detail).toEqual({ order: o.id });
    await x.own({ type: "liveCancel", venue: "ex", order: o.id });
    expect(code(await x.own({ type: "disconnectVenue", venue: "ex" }))).toBe("account");
  });

  it("a wallet order: one hash, once; taken back before the wallet sent it and then sent anyway, it is taken on again and counted", async () => {
    const x = await boot();
    await x.letIn();
    await x.own({ type: "setPolicy", change: "mode", value: "open" });
    const tx = { chainId: 8453, chainIdHex: "0x2105" as const, from: "0x00000000000000000000000000000000000000a1" as const, to: "0x00000000000000000000000000000000000000b2" as const, data: "0x" as const, value: "0x0" as const, what: "swap" };
    x.venue.onPlace = () => ({ ref: "", status: "pending", filledQty: 0, native: {}, walletTxs: [tx] });
    const o = placed(await x.ag(ask({ symbol: "WETH/USDC@Base", usd: "", qty: "0.005" })));
    expect(x.trade().spentMicro).toBe(15_300_000);
    expect(placed(await x.ag({ type: "agentLiveCancel", venue: "ex", order: o.id })).status).toBe("canceled");
    expect(x.trade().spentMicro).toBe(0);
    const hash = `0x${"ab".repeat(32)}`;
    const back = placed(await x.engine.trade.sent(o.id, hash));
    expect([back.status, back.ref, x.trade().spentMicro]).toEqual(["pending", hash, 15_300_000]);
    expect(code(await x.engine.trade.sent(o.id, `0x${"cd".repeat(32)}`))).toBe("E_ACCOUNT_ORDER_UNKNOWN");
  });

  it("a venue that throws while it is asked how an order stands does not take the page or a cancel down", async () => {
    const x = await boot();
    const o = placed(await x.order({ symbol: "BTC/USDT", side: "buy", orderType: "limit", qty: "0.0005", limitPrice: "50000" }));
    x.venue.onStatus = () => {
      throw new Error("OrderNotFound");
    };
    x.tick(11_000);
    expect((await x.page()).orders[0]!.status).toBe("open");
    expect(placed(await x.own({ type: "liveCancel", venue: "ex", order: o.id })).status).toBe("canceled");
  });

  it("an answer that arrives after the order changed is dropped: a page read does not undo a cancel", async () => {
    const x = await boot();
    const o = placed(await x.order({ symbol: "BTC/USDT", side: "buy", orderType: "limit", qty: "0.0005", limitPrice: "50000" }));
    let answer: (s: OrderState) => void = () => undefined;
    x.venue.onStatus = () => new Promise<OrderState>((resolve) => (answer = resolve));
    x.tick(11_000);
    const reading = x.page();
    await new Promise((r) => setTimeout(r, 0));
    x.venue.onStatus = undefined;
    await x.own({ type: "liveCancel", venue: "ex", order: o.id });
    answer({ ref: o.ref, status: "open", filledQty: 0, native: {} });
    await reading;
    expect(x.engine.orders[0]!.status).toBe("canceled");
  });

  it("an agent request whose fields are not text is refused at the door, before its nonce is spent", async () => {
    const x = await boot();
    await x.letIn();
    const r = refusal(await x.ag({ ...ask(), qty: 0.001 as unknown as string, usd: "" }));
    expect([r.code, r.message]).toEqual(["E_ACCOUNT_BAD_ACTION", '"qty" is text']);
  });

  it("the order ticket's reads are kept a moment: asking again and again costs the venue one request", async () => {
    const x = await boot();
    const before = x.venue.asked;
    await Promise.all([x.svc.liveMarket("ex", "BTC/USDT"), x.svc.liveMarket("ex", "BTC/USDT"), x.svc.liveMarket("ex", "BTC/USDT")]);
    expect(x.venue.asked - before).toBe(1);
  });
});

describe("the statement", () => {
  it("lists every transaction, one line each, as it stands now — and a later run of the account still lists it", async () => {
    const x = await boot();
    const bought = placed(await x.order({ symbol: "BTC/USDT", side: "buy", orderType: "market", usd: "30" }));
    const resting = placed(await x.order({ symbol: "BTC/USDT", side: "sell", orderType: "limit", qty: "0.0005", limitPrice: "65000" }));
    await x.own({ type: "liveCancel", venue: "ex", order: resting.id });
    const lines = x.svc.statement();
    expect(lines.map((l) => [l.id, l.kind, l.status, l.amountUsd])).toEqual([
      [resting.id, "sell", "canceled", 0],
      [bought.id, "buy", "filled", -24],
    ]);
    expect(lines[1]!.description).toBe("Buy 0.0004 BTC · BTC/USDT · market · at 60010");
    expect([lines[1]!.by, lines[1]!.feeUsd, lines[0]!.worthUsd]).toEqual(["You", 0.06, 32.5]);
    // the ledger outlives the process: a new run on the same home reads the same statement back
    const again = await boot({ home: x.home, nonceFrom: 100 });
    expect(again.svc.statement().map((l) => l.key)).toEqual(lines.map((l) => l.key));
  });
});

describe("the same thing at every venue", () => {
  it("ranks the venues by the price an order would take there, and marks one far from the others", async () => {
    const x = await boot();
    // two more venues of the user's, the same stand-in at other prices
    for (const [venue, ask, bid] of [["ex2", 59_900, 59_880], ["ex3", 40_000, 39_990]] as const) {
      const other = standIn();
      other.markets["BTC/USDT"] = { ...BTC, ask, bid, price: ask };
      current = other;
      const r = await x.own({ type: "connectVenue", venue, connector: "live:standin-trade", label: venue.toUpperCase(), credentialRef: "" });
      if (isRefusal(r)) throw new Error(r.message);
    }
    const c = await x.svc.liveCompare("BTC", "buy");
    if (isRefusal(c)) throw new Error(c.message);
    // the outlier is never the best: it goes last, marked
    expect(c.rows.map((r) => [r.venue, r.price, r.ready, r.best ?? false])).toEqual([["ex2", 59_900, true, true], ["ex", 60_010, true, false], ["ex3", 40_000, false, false]]);
    expect(c.rows[2]!.note).toContain("far from the other venues' prices");
  });
});

