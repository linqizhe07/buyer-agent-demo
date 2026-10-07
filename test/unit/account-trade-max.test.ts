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
import type { LiveTrader, Market, OrderChange, OrderRequest, OrderState, Position } from "../../src/portfolio/live/trade.ts";
import { PortfolioService } from "../../src/portfolio/service.ts";

/** The whole action space of the order door, against a stand-in venue that takes all of it: stop and stop-limit orders, times in force,
 * post-only and reduce-only, an order changed in place, positions and their close, leverage. What is tested is the door's rule for each:
 * what is checked before the venue is asked, what a limit counts, when a card is raised. */
type NoNonce<T> = T extends unknown ? Omit<T, "nonce"> : never;
const START = Date.parse("2026-10-05T14:00:00.000Z");
const DAY = 86_400_000;
const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));
const owner = simKey("owner");
const cc = simKey("agent:claude-code");

const PERP: Market = { symbol: "ETH/USDT:USDT", name: "ETH perpetual", kind: "perp", base: "ETH", quote: "USDT", price: 3000, bid: 2999, ask: 3001, minQty: 0.01, qtyStep: 0.01, priceStep: 0.1, open: true, types: ["market", "limit", "stop", "stop_limit"], tifs: ["gtc", "ioc", "fok"], postOnly: true, reduceOnly: true, maxLeverage: 50 };
const SPOT: Market = { ...PERP, symbol: "ETH/USDT", name: "ETH/USDT", kind: "spot", types: ["market", "limit", "stop"], tifs: ["gtc", "day"], tifsByType: { limit: ["gtc"] }, postOnly: false, reduceOnly: false, maxLeverage: undefined };
/** a prediction market's shares: no reduce-only flag, but a sell can only sell what is held */
const EVENT: Market = { symbol: "FED-CUT:YES", name: "Fed cuts in December · Yes", kind: "event", base: "YES", quote: "USD", price: 0.6, bid: 0.59, ask: 0.61, minQty: 1, qtyStep: 1, priceStep: 0.01, open: true, types: ["market", "limit"], sellsReduce: true };
/** a perpetual elsewhere with neither: closing it here could open a position the other way */
const BARE: Market = { ...PERP, symbol: "SOL/USDT:USDT", name: "SOL perpetual", reduceOnly: false };

function standIn(o: { nativeClose?: boolean; amend?: boolean } = {}) {
  const v = { placed: [] as OrderRequest[], amended: [] as Array<{ ref: string; change: OrderChange }>, closed: [] as Array<{ symbol: string; qty: number }>, leverage: [] as Array<{ symbol: string; leverage: number; marginMode?: string | undefined }>, positions: [{ symbol: PERP.symbol, name: PERP.name, kind: "perp", side: "long", qty: 0.5, entryPrice: 2900, markPrice: 3000, usd: 1500, leverage: 3, native: {} }, { symbol: EVENT.symbol, name: EVENT.name, kind: "event", side: "long", qty: 10, native: {} }, { symbol: BARE.symbol, name: BARE.name, kind: "perp", side: "short", qty: 2, native: {} }] as Position[], states: new Map<string, OrderState>() };
  const trader: LiveTrader = {
    can: true,
    what: "spot and perpetuals",
    async markets() {
      return [PERP, SPOT];
    },
    async market(symbol) {
      const m = [PERP, SPOT, EVENT, BARE].find((x) => x.symbol === symbol);
      return m ? { ...m } : no("E_VENUE_REJECTED", { venue: "ex", message: `no market ${symbol}` });
    },
    async place(r) {
      v.placed.push(r);
      const ref = `x-${v.placed.length}`;
      const s: OrderState = r.type === "market" ? { ref, status: "filled", filledQty: r.qty, avgPrice: r.side === "buy" ? 3001 : 2999, native: {} } : { ref, status: "open", filledQty: 0, native: {} };
      v.states.set(ref, s);
      return s;
    },
    async cancel(ref) {
      const s = { ...v.states.get(ref)!, status: "canceled" as const };
      v.states.set(ref, s);
      return s;
    },
    async status(ref) {
      return v.states.get(ref)!;
    },
    ...(o.amend === false
      ? {}
      : {
          async amend(ref: string, _symbol: string, change: OrderChange) {
            v.amended.push({ ref, change });
            return { ...v.states.get(ref)!, native: { amended: change } };
          },
        }),
    async positions() {
      return v.positions;
    },
    ...(o.nativeClose
      ? {
          async close(symbol: string, qty: number) {
            v.closed.push({ symbol, qty });
            return { ref: `close-${v.closed.length}`, status: "filled" as const, filledQty: qty, avgPrice: 2999, native: {} };
          },
        }
      : {}),
    async setLeverage(symbol, leverage, marginMode) {
      v.leverage.push({ symbol, leverage, marginMode });
      return { leverage, ...(marginMode ? { marginMode } : {}), native: {} };
    },
  };
  return { v, trader };
}

let current: ReturnType<typeof standIn> | undefined;
register({ kind: "standin-max", label: "a venue that takes everything", needs: "key-file", example: "", venues: [], async open(req) {
  const s = current!;
  return { source: { name: req.label || "Exchange", kind: "cex", reference: "standin", via: "a stand-in", probe: { can: ["read", "trade"], note: "" }, read: async () => [{ asset: "USDT", amount: 5000, usd: 5000 }], trader: s.trader, readOnlyBecause: "the stand-in moves no money" }, first: [{ asset: "USDT", amount: 5000, usd: 5000 }], summary: "connected" };
} });

async function boot(o: { nativeClose?: boolean; amend?: boolean; cap?: number } = {}) {
  const home = mkdtempSync(join(tmpdir(), "account-trade-max-"));
  homes.push(home);
  let n = 0;
  current = standIn(o);
  const liveDeps: Partial<LiveDeps> = { clock: () => 5_000_000, http: async () => ({ status: 599, body: undefined, text: "" }), price: async () => undefined };
  const svc = await PortfolioService.create({ home, now: () => new Date(START).toISOString(), venues: "frontline", real: true, liveDeps, liveWrites: { capUsd: o.cap ?? 2000, pairingCode: "K7QX-M2PA" }, account: { owners: [{ id: owner.address, kind: "eoa", label: "owner", addedAt: new Date(START).toISOString() }] } });
  const engine = svc.account!;
  const own = async (a: NoNonce<OwnerAction>) => svc.exchange(await signOwner(owner, { ...a, nonce: START + ++n } as OwnerAction));
  const ag = async (a: NoNonce<AgentAction>) => svc.exchange(await signAgent(cc, { ...a, nonce: START + ++n } as AgentAction));
  const connected = await own({ type: "connectVenue", venue: "ex", connector: "live:standin-max", label: "Exchange", credentialRef: "" });
  if (isRefusal(connected)) throw new Error(connected.message);
  await own({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: START + 30 * DAY });
  await own({ type: "approveSpend", agent: cc.address, scope: "trade", allow: "ex", perPayment: "1000", budget: "3000", windowHours: 0, validUntil: START + 7 * DAY });
  const order = (x: Partial<Extract<AgentAction, { type: "agentLiveOrder" }>>) => ag({ type: "agentLiveOrder", venue: "ex", symbol: PERP.symbol, side: "buy", orderType: "limit", qty: "0.1", usd: "", limitPrice: "2900", ...x });
  const spent = () => engine.state.spends.find((s) => s.scope === "trade" && s.revokedAt === undefined)!;
  return { svc, engine, own, ag, order, spent, venue: current };
}

const placed = (o: Outcome | Refusal): LiveOrder => {
  if (isRefusal(o) || o.kind !== "order") throw new Error(`expected an order, got ${isRefusal(o) ? `${o.code}: ${o.message}` : o.kind}`);
  return o.order;
};
const refusal = (o: Outcome | Refusal): Refusal => {
  if (!isRefusal(o)) throw new Error(`expected a refusal, got ${o.kind}`);
  return o;
};

describe("the whole order space, through one door", () => {
  it("stop and stop-limit orders: valued where they trigger, carried to the venue with their trigger, the time in force and the flags", async () => {
    const x = await boot();
    await x.own({ type: "setPolicy", change: "mode", value: "open" });
    // a buy stop at 3100 is counted at its worst: 2% past the trigger
    const stop = placed(await x.order({ orderType: "stop", limitPrice: "", stopPrice: "3100", qty: "0.1", tif: "gtc" }));
    expect(x.venue.v.placed.at(-1)).toEqual({ symbol: PERP.symbol, side: "buy", type: "stop", qty: 0.1, stopPrice: 3100, worstPrice: 3162, tif: "gtc", clientId: stop.clientId });
    expect([stop.status, stop.note, x.spent().spentMicro]).toEqual(["open", "waiting at Exchange for the price to reach 3100", 316_200_000]);
    // a sell stop-limit with reduce-only: valued at its limit, nothing more ridden along
    const sl = placed(await x.order({ side: "sell", orderType: "stop_limit", limitPrice: "2790", stopPrice: "2800", qty: "0.2", reduceOnly: "true", tif: "ioc" }));
    expect(x.venue.v.placed.at(-1)).toEqual({ symbol: PERP.symbol, side: "sell", type: "stop_limit", qty: 0.2, limitPrice: 2790, stopPrice: 2800, tif: "ioc", reduceOnly: true, clientId: sl.clientId });
    // a post-only limit
    placed(await x.order({ postOnly: "true" }));
    expect(x.venue.v.placed.at(-1)).toMatchObject({ type: "limit", postOnly: true });
  });

  it("refuses before the venue is asked what the market does not take, or what an order type does not have", async () => {
    const x = await boot();
    const before = x.venue.v.placed.length;
    expect(refusal(await x.order({ symbol: SPOT.symbol, orderType: "stop_limit", stopPrice: "3100" })).message).toBe("Exchange takes market, limit, stop orders in ETH/USDT, not stop_limit orders");
    expect(refusal(await x.order({ symbol: SPOT.symbol, tif: "ioc" })).message).toBe("Exchange takes gtc, day in ETH/USDT, not ioc");
    // a time in force for some order types only: "day" for a stop here, not for a limit
    expect(refusal(await x.order({ symbol: SPOT.symbol, tif: "day" })).message).toBe("Exchange takes gtc for a limit order in ETH/USDT, not day");
    expect(refusal(await x.order({ symbol: SPOT.symbol, reduceOnly: "true" })).message).toBe("Exchange takes no reduce-only orders in ETH/USDT");
    expect(refusal(await x.order({ orderType: "market", limitPrice: "", postOnly: "true" })).message).toBe("post-only is for a limit order: it rests on the book as a maker, or is refused");
    expect(refusal(await x.order({ orderType: "stop", limitPrice: "" })).message).toBe("a stop order has a stop price that triggers it: a plain decimal, more than zero");
    expect(refusal(await x.order({ orderType: "limit", stopPrice: "3000" })).message).toBe("a limit order has no stop price");
    expect(refusal(await x.order({ tif: "forever" })).code).toBe("E_ACCOUNT_BAD_ACTION");
    expect(x.venue.v.placed.length).toBe(before);
  });

  it("an amend: smaller goes at once and gives back; bigger is judged like a new order of the difference — a card in Guard", async () => {
    const x = await boot();
    await x.own({ type: "setPolicy", change: "mode", value: "open" });
    const o = placed(await x.order({ qty: "0.3" }));
    expect(x.spent().spentMicro).toBe(870_000_000);
    const smaller = placed(await x.ag({ type: "agentLiveAmend", venue: "ex", order: o.id, qty: "0.2", limitPrice: "", stopPrice: "" }));
    expect([smaller.qty, x.spent().spentMicro, x.venue.v.amended]).toEqual([0.2, 580_000_000, [{ ref: "x-1", change: { qty: 0.2 } }]]);
    // Guard now: a bigger order is a card that shows the order as it would be
    x.svc.setMode("guard");
    const bigger = await x.ag({ type: "agentLiveAmend", venue: "ex", order: o.id, qty: "", limitPrice: "2950", stopPrice: "" });
    if (isRefusal(bigger) || bigger.kind !== "card") throw new Error("expected a card");
    expect(bigger.card.offer).toMatchObject({ payee: "Exchange", amount: `${o.id} → buy 0.2 ETH`, network: "costs at most $590.00 · $10.00 more than now" });
    const card = x.engine.host.card(bigger.card.id)!;
    const done = await x.own({ type: "approveCard", card: card.id, action: cardHash(card), decision: "approve" });
    expect(isRefusal(done)).toBe(false);
    expect([x.engine.orders[0]!.limitPrice, x.spent().spentMicro, x.spent().reservedMicro]).toEqual([2950, 590_000_000, 0]);
    // the owner can change any order; a venue that cannot amend says so
    const y = await boot({ amend: false });
    await y.own({ type: "setPolicy", change: "mode", value: "open" });
    const p = placed(await y.order({}));
    expect(refusal(await y.ag({ type: "agentLiveAmend", venue: "ex", order: p.id, qty: "0.05", limitPrice: "", stopPrice: "" })).message).toBe("Exchange changes no order in place: cancel it and place another");
  });

  it("a stop moved: its worst price is never pulled in, so what it is counted at stays a bound at a venue that keeps the first one", async () => {
    const x = await boot();
    await x.own({ type: "setPolicy", change: "mode", value: "open" });
    const stop = placed(await x.order({ orderType: "stop", limitPrice: "", stopPrice: "3100", qty: "0.1" }));
    expect([stop.worstPrice, x.spent().spentMicro]).toEqual([3162, 316_200_000]);
    // down: 2% past 3000 would be 3060, but a venue that holds the stop as a stop-limit (Alpaca) still has 3162
    const down = placed(await x.ag({ type: "agentLiveAmend", venue: "ex", order: stop.id, qty: "", limitPrice: "", stopPrice: "3000" }));
    expect([down.stopPrice, down.worstPrice, down.usd, x.spent().spentMicro, x.venue.v.amended.at(-1)!.change]).toEqual([3000, 3162, 316.2, 316_200_000, { stopPrice: 3000 }]);
    // up, past it: the new worst price is counted
    const up = placed(await x.ag({ type: "agentLiveAmend", venue: "ex", order: stop.id, qty: "", limitPrice: "", stopPrice: "3200" }));
    expect([up.worstPrice, x.spent().spentMicro]).toEqual([3264, 326_400_000]);
  });

  it("a close of a derivative: not counted against the limit; Guard a card, Beast at once inside the per-order line; reduce-only, or the venue's own. A plain sell of what is held counts like the sell order it is", async () => {
    const x = await boot();
    // Guard: a card, and nothing at the venue until the owner approves what it shows — a position may be the owner's own
    const asked = await x.ag({ type: "agentLiveClose", venue: "ex", symbol: PERP.symbol, qty: "" });
    if (isRefusal(asked) || asked.kind !== "card") throw new Error("expected a card");
    const before = x.venue.v.placed.length;
    const card = x.engine.host.card(asked.card.id)!;
    const c = placed(await x.own({ type: "approveCard", card: card.id, action: cardHash(card), decision: "approve" }));
    expect(x.venue.v.placed.length).toBe(before + 1);
    expect(x.venue.v.placed.at(-1)).toEqual({ symbol: PERP.symbol, side: "sell", type: "market", qty: 0.5, worstPrice: 2939.1, reduceOnly: true, clientId: c.clientId });
    expect([c.status, x.spent().spentMicro]).toEqual(["filled", 0]);
    expect(refusal(await x.ag({ type: "agentLiveClose", venue: "ex", symbol: PERP.symbol, qty: "0.9" })).message).toBe("a close is more than zero and at most the 0.5 held");
    // Beast, inside the $1,000 line: shares that can only be sold as held go at once as a plain market sell — a sell order, counted
    // against the limit as one ($5.90 at the bid); a perpetual with neither guarantee is not closed from here
    await x.own({ type: "setPolicy", change: "mode", value: "open" });
    const ev = placed(await x.ag({ type: "agentLiveClose", venue: "ex", symbol: EVENT.symbol, qty: "" }));
    expect(x.venue.v.placed.at(-1)).toEqual({ symbol: EVENT.symbol, side: "sell", type: "market", qty: 10, worstPrice: 0.58, clientId: ev.clientId });
    expect([ev.approval, ev.usd]).toEqual([undefined, 5.9]);
    expect(refusal(await x.ag({ type: "agentLiveClose", venue: "ex", symbol: BARE.symbol, qty: "" })).message).toBe("Exchange takes no reduce-only order in SOL perpetual, and has no close of its own: close it at the venue, so that nothing opens the other way");
    // above the line, Beast too: a card
    expect((await x.ag({ type: "agentLiveClose", venue: "ex", symbol: PERP.symbol, qty: "" }) as { kind?: string }).kind).toBe("card");
    const y = await boot({ nativeClose: true });
    await y.own({ type: "setPolicy", change: "mode", value: "open" });
    placed(await y.ag({ type: "agentLiveClose", venue: "ex", symbol: PERP.symbol, qty: "0.2" }));
    expect([y.venue.v.closed, y.venue.v.placed.length]).toEqual([[{ symbol: PERP.symbol, qty: 0.2 }], 0]);
    // positions, as the venue lists them
    expect(((await y.engine.trade.positions("ex")) as Position[])[0]).toMatchObject({ symbol: PERP.symbol, side: "long", qty: 0.5 });
  });

  it("leverage: an agent up to what the owner signed for agents (1x until then), a card where a position is open, the owner up to the venue's own most", async () => {
    const x = await boot();
    expect(refusal(await x.ag({ type: "agentLiveLeverage", venue: "ex", symbol: PERP.symbol, leverage: "5", marginMode: "isolated" })).message).toBe("the owner lets agents use at most 1x leverage: 5x is the owner's to set, or to allow");
    await x.own({ type: "setPolicy", change: "maxLeverage", value: "5" });
    // a position is open in ETH perpetual (0.5 ETH, $1,500 — over the $1,000 line in either mode): the change alters what it risks, and the
    // position may be the owner's own, so the owner is asked; the yes sets exactly what the card showed
    const asked = await x.ag({ type: "agentLiveLeverage", venue: "ex", symbol: PERP.symbol, leverage: "5", marginMode: "isolated" });
    if (isRefusal(asked) || asked.kind !== "card") throw new Error(`expected a card, got ${isRefusal(asked) ? asked.message : asked.kind}`);
    expect([asked.card.reason, x.venue.v.leverage]).toEqual(["Claude Code asks to set leverage to 5x on ETH perpetual — a position of 0.5 ETH is open there", []]);
    const card = x.engine.host.card(asked.card.id)!;
    const r = await x.own({ type: "approveCard", card: card.id, action: cardHash(card), decision: "approve" });
    expect(!isRefusal(r) && r.kind === "result" && r.result).toEqual({ venue: "ex", symbol: PERP.symbol, leverage: 5, marginMode: "isolated" });
    // no position in the market: at once, in Guard too
    x.venue.v.positions = x.venue.v.positions.filter((p) => p.symbol !== PERP.symbol);
    const again = await x.ag({ type: "agentLiveLeverage", venue: "ex", symbol: PERP.symbol, leverage: "3", marginMode: "" });
    expect(!isRefusal(again) && again.kind === "result" && again.result).toEqual({ venue: "ex", symbol: PERP.symbol, leverage: 3 });
    expect(refusal(await x.own({ type: "liveLeverage", venue: "ex", symbol: PERP.symbol, leverage: "75", marginMode: "" })).message).toBe("Exchange takes at most 50x in ETH perpetual");
    expect(refusal(await x.own({ type: "liveLeverage", venue: "ex", symbol: SPOT.symbol, leverage: "2", marginMode: "" })).message).toBe("leverage is set on a perpetual or a future; ETH/USDT is spot");
    expect(x.venue.v.leverage).toEqual([{ symbol: PERP.symbol, leverage: 5, marginMode: "isolated" }, { symbol: PERP.symbol, leverage: 3, marginMode: undefined }]);
  });
});
