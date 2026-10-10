import ccxt from "ccxt";
import { STATUS_CODES } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { isRefusal, type Refusal } from "../../src/core/errors.ts";
import type { CardLike, Outcome } from "../../src/portfolio/account/exchange.ts";
import { LiveEarns, type AgentLiveEarnAction, type EarnEngine } from "../../src/portfolio/account/live-earn.ts";
import type { LiveMoney } from "../../src/portfolio/account/live-moves.ts";
import { LiveOrders, type AgentLiveOrderAction, type LiveOrder, type OrderEngine } from "../../src/portfolio/account/live-orders.ts";
import type { Envelope } from "../../src/portfolio/account/sign.ts";
import type { AgentKey, SpendApproval } from "../../src/portfolio/account/state.ts";
import { binanceEarner, kucoinEarner, okxEarner, type EarnProduct, type EarnState, type LiveEarner } from "../../src/portfolio/live/earn.ts";
import { exchangeTrader, type ByClient, type OrderHeld } from "../../src/portfolio/live/exchange-trade.ts";
import { guardClient, type ExchangeClient } from "../../src/portfolio/live/exchange.ts";
import type { LiveTrader, Market, OrderState } from "../../src/portfolio/live/trade.ts";
import { bannedNo, edgeWords, ipListWords } from "../../src/portfolio/live/types.ts";
import { no } from "../../src/portfolio/refuse.ts";

/** The IP audit's findings about orders and earn (cluster a, 2026-10-09): what the account does when the user's network turns an answer
 * into something else — a first market load lost, an answer lost on the way back from an order, a change or an earn move, a 200 page or an
 * empty body in the exchange's place, a place rule past the cut, a venue that refuses this network or banned this address, a key bound to
 * other addresses. Exchanges are the real installed library fed canned answers through the account's guard; the doors run on stand-ins.
 * Nothing leaves the process. Addresses are from the documentation ranges (RFC 5737) */
const lib = ccxt as unknown as Record<string, new (o: Record<string, unknown>) => Record<string, unknown>> & { RequestTimeout: new (m: string) => Error; BadResponse: new (m: string) => Error };
type Dict = Record<string, unknown>;
type Canned = { status: number; body?: string; headers?: Record<string, string> } | Error;
const KEY = { apiKey: "made-up-key-0001", secret: "made-up-secret-0001", password: "Made-up-pass-0001!" };
const CID = "0f3a9c01b2d4e6f80a1b2c3d4e5f6071";
const ORD = "312269865356374016";
const PAGE_TEXT = "Web Page Blocked. Access to this site is blocked by your network administrator. Client IP: 203.0.113.9";
const named = (name: string, message: string) => Object.assign(new Error(message), { name });
const json = (status: number, body: unknown): Canned => ({ status, body: JSON.stringify(body) });
const ok = <T>(x: T | Refusal): T => {
  if (isRefusal(x)) throw new Error(`expected an answer, got ${x.code}: ${x.message} ${JSON.stringify(x.detail ?? {})}`);
  return x;
};
const refusal = (x: unknown): Refusal => {
  if (!isRefusal(x)) throw new Error(`expected a refusal, got ${JSON.stringify(x).slice(0, 300)}`);
  return x;
};

afterEach(() => vi.useRealTimers());

const spot = (id: string, base: string, quote: string, extra: Dict = {}): Dict => ({ id, symbol: `${base}/${quote}`, base, quote, baseId: base, quoteId: quote, type: "spot", spot: true, margin: false, swap: false, future: false, option: false, contract: false, active: true, precision: { amount: 0.00000001, price: 0.1 }, limits: { amount: { min: 0.00001 }, cost: {}, price: {} }, info: {}, ...extra });
const OKX_SPOT = spot("BTC-USDT", "BTC", "USDT", { info: { instType: "SPOT", state: "live" } });
const okxRow = (over: Dict = {}): Dict => ({ accFillSz: "0", avgPx: "", cTime: "1791230000123", uTime: "1791230000456", fillTime: "", clOrdId: CID, fee: "0", feeCcy: "BTC", instId: "BTC-USDT", instType: "SPOT", ordId: ORD, ordType: "limit", px: "60000", side: "buy", state: "live", sz: "0.001", tdMode: "cash", tgtCcy: "", reduceOnly: "false", ...over });
const okxOrder = (over: Dict = {}) => json(200, { code: "0", msg: "", data: [okxRow(over)] });

/** a real library client whose network answers what it is told, in turn, through the account's guard */
function real(id: string, markets: Dict[] | undefined, answers: Canned[]) {
  const x = new lib[id]!({ ...KEY, enableRateLimit: false, timeout: 12_000 }) as Dict & { handleRestResponse: (...a: unknown[]) => Promise<unknown>; setMarkets(m: unknown[]): unknown };
  if (markets) x.setMarkets(markets);
  const seen: string[] = [];
  x.fetch = async function (url: string, method = "GET", headers: unknown = {}, body: unknown = undefined) {
    seen.push(`${method} ${url.split("?")[0]}`);
    const c = answers.shift();
    if (!c) throw new Error(`not set up in this test: ${method} ${url}`);
    if (c instanceof Error) throw c;
    const resp = { status: c.status, statusText: STATUS_CODES[c.status] ?? "", headers: c.headers ?? {}, text: async () => c.body ?? "" };
    return x.handleRestResponse(resp, url, method, headers, body);
  };
  return { x: guardClient(x as unknown as ExchangeClient, lib), seen, answers };
}
const okxTrader = (answers: Canned[]) => {
  const v = real("okx", [OKX_SPOT], answers);
  return { ...v, t: exchangeTrader(v.x, "okx", "OKX", Object.values(KEY), { can: ["read", "trade"] }) };
};
const limitBuy = { symbol: "BTC/USDT", side: "buy" as const, type: "limit" as const, qty: 0.001, limitPrice: 60000, clientId: CID };

describe("R1-34 · a first market load that failed is asked again, not kept", () => {
  it("one timeout at the first load refuses that call only: the next asks the exchange, and the library's own calls are not left holding the failure", async () => {
    const x = new lib.okx!({ ...KEY, enableRateLimit: false }) as Dict & { loadMarkets(reload?: boolean): Promise<unknown> };
    let asked = 0;
    x.fetchCurrencies = async () => undefined;
    x.fetchMarkets = async () => {
      asked++;
      if (asked === 1) throw new lib.RequestTimeout("okx GET https://www.okx.com/api/v5/public/instruments request timed out (14000 ms, the answer included)");
      return [{ ...OKX_SPOT, lowercaseId: undefined }];
    };
    const t = exchangeTrader(x as unknown as ExchangeClient, "okx", "OKX", Object.values(KEY), { can: ["read", "trade"] });
    const first = refusal(await t.markets(""));
    expect(first.code).toBe("E_VENUE_UNREACHABLE");
    // the library's own call (createOrder and fetchBalance make it) asks the exchange again rather than handing back the stored failure
    await x.loadMarkets();
    expect(asked).toBe(2);
    expect(ok(await t.markets("")).map((m) => m.symbol)).toEqual(["BTC/USDT"]);
  });
});

describe("R4-5 · Coinbase's place rule past the first 240 characters", () => {
  it("GEOFENCING_RESTRICTION after the message, error_details and preview_failure_reason is still its place rule, and its reason is kept", async () => {
    const body = { success: false, failure_reason: "UNKNOWN_FAILURE_REASON", order_id: "", error_response: { error: "UNKNOWN_FAILURE_REASON", message: "The order could not be placed at this time for this account, please try again later", error_details: "the order could not be created", preview_failure_reason: "UNKNOWN_PREVIEW_FAILURE_REASON", new_order_failure_reason: "GEOFENCING_RESTRICTION" }, order_configuration: null };
    const said = `coinbase ${JSON.stringify(body)}`;
    expect(said.indexOf("GEOFENCING_RESTRICTION")).toBeGreaterThan(240);
    const client = { id: "coinbase", markets: { "BTC/USD": spot("BTC-USD", "BTC", "USD") }, loadMarkets: async () => ({}), fetchBalance: async () => ({}), createOrder: async () => { throw named("ExchangeError", said); } } as unknown as ExchangeClient;
    const t = exchangeTrader(client, "coinbase", "Coinbase", [], { can: ["read", "trade"] });
    const r = refusal(await t.place({ ...limitBuy, symbol: "BTC/USD" }));
    expect([r.code, r.message]).toEqual(["E_VENUE_GEOBLOCKED", "Coinbase does not serve this location: that is its own rule, and the account does not look for a way around it"]);
    expect((r.native as { reason?: string }).reason).toBe("new_order_failure_reason: GEOFENCING_RESTRICTION");
  });
});

describe("R4-2 · R4-3 · a 200 that is not the exchange's answer is never its yes, and never an order's id", () => {
  it("MEXC: a filtering network's plain-text 200 page — which the library takes as the order's id — is 'did not confirm', and the page and its address are kept nowhere", async () => {
    const v = real("mexc", [spot("BTCUSDT", "BTC", "USDT", { precision: { amount: 0.000001, price: 0.01 } })], [{ status: 200, body: PAGE_TEXT }]);
    const t = exchangeTrader(v.x, "mexc", "MEXC", Object.values(KEY), { can: [] });
    const r = refusal(await t.place(limitBuy));
    expect([r.code, r.detail]).toEqual(["E_VENUE_UNREACHABLE", { clientOrderId: CID }]);
    expect(r.message).toContain("MEXC did not confirm the order (what came back named no order): it may or may not have been placed");
    expect(JSON.stringify(r)).not.toMatch(/203\.0\.113\.9|Blocked/);
  });

  it("OKX: a status answered with an empty 200 is no answer — never 'pending, nothing filled' over what the account knew", async () => {
    const { t } = okxTrader([{ status: 200, body: "" }]);
    const r = refusal(await t.status(ORD, "BTC/USDT"));
    expect([r.code, r.detail]).toEqual(["E_VENUE_UNREACHABLE", { order: ORD }]);
  });

  it("OKX: a cancel answered with an empty 200, and the look after it the same, is 'did not confirm the cancel' — not a cancel taken", async () => {
    const { t, seen } = okxTrader([{ status: 200, body: "" }, { status: 200, body: "" }]);
    const r = refusal(await t.cancel(ORD, "BTC/USDT"));
    expect([r.code, r.message, r.detail]).toEqual(["E_VENUE_UNREACHABLE", "OKX did not confirm the cancel: the order may still be open. Look at it at OKX, or cancel it again", { order: ORD, unsure: true }]);
    expect(seen).toEqual(["POST https://www.okx.com/api/v5/trade/cancel-order", "GET https://www.okx.com/api/v5/trade/order"]);
    // the exchange's own yes, naming the order, is still taken when the look after it is not answered
    const again = okxTrader([json(200, { code: "0", msg: "", data: [{ clOrdId: CID, ordId: ORD, sCode: "0", sMsg: "" }] }), { status: 200, body: "" }]);
    expect(ok(await again.t.cancel(ORD, "BTC/USDT")).ref).toBe(ORD);
  });

  it("OKX: after an order call that timed out, a look-up by the account's id answered with an empty 200 cannot tell — never a phantom order with no ref", async () => {
    const { t } = okxTrader([new lib.RequestTimeout("okx POST https://www.okx.com/api/v5/trade/order request timed out (14000 ms, the answer included)"), { status: 200, body: "" }]);
    const r = refusal(await t.place(limitBuy));
    expect([r.code, r.detail]).toEqual(["E_VENUE_UNREACHABLE", { clientOrderId: CID }]);
    expect(r.message).toContain("it may or may not have been placed");
  });

  it("OKX: the look-up by the account's id finds the order that was placed: byClient answers it under its own id", async () => {
    const { t } = okxTrader([okxOrder()]);
    const s = ok(await (t as LiveTrader & { byClient: ByClient }).byClient(CID, "BTC/USDT", "limit"));
    expect([s?.ref, s?.status]).toEqual([ORD, "open"]);
  });
});

describe("R3-25 · R4-2 · an amend whose answer was lost is unsure, and the order says which stands", () => {
  it("a timeout, then the order shows the size asked: the change was made, and the state carries the size the exchange holds", async () => {
    const { t } = okxTrader([new lib.RequestTimeout("okx POST https://www.okx.com/api/v5/trade/amend-order request timed out (14000 ms, the answer included)"), okxOrder({ sz: "0.002" })]);
    const s = ok(await t.amend!(ORD, "BTC/USDT", { qty: 0.002 }, limitBuy)) as OrderState & OrderHeld;
    expect([s.ref, s.status, s.qty]).toEqual([ORD, "open", 0.002]);
  });

  it("a timeout, then the order still at its old size — or not shown at all — is 'did not confirm the change', never 'could not be reached'", async () => {
    const old = okxTrader([new lib.RequestTimeout("okx POST https://www.okx.com/api/v5/trade/amend-order request timed out"), okxOrder()]);
    const r = refusal(await old.t.amend!(ORD, "BTC/USDT", { qty: 0.002 }, limitBuy));
    expect([r.code, r.message, r.detail]).toEqual(["E_VENUE_UNREACHABLE", "OKX did not confirm the change: it may or may not have been made. Look at the order before changing it again", { order: ORD, unsure: true }]);
    // an empty 200 in place of the amend's answer, and of the look after it: the same
    const empty = okxTrader([{ status: 200, body: "" }, { status: 200, body: "" }]);
    expect(refusal(await empty.t.amend!(ORD, "BTC/USDT", { limitPrice: 60100 }, limitBuy)).detail).toEqual({ order: ORD, unsure: true });
  });
});

// ---- the order door, on a stand-in venue -------------------------------------------------------------------------------------------

const NOW = "2026-10-09T14:00:00.000Z";
const AGENT = "0x00000000000000000000000000000000000000a1";
const BTC: Market = { symbol: "BTC/USDT", name: "BTC/USDT", kind: "spot", base: "BTC", quote: "USDT", price: 60_000, bid: 59_990, ask: 60_010, minQty: 0.0001, qtyStep: 0.0001, priceStep: 0.1, open: true, types: ["market", "limit"] };
type Extras = LiveTrader & { byClient?: ByClient; held?(o: { side: "buy" | "sell"; reduceOnly?: boolean | undefined }): Promise<Refusal | undefined> };

function standIn(over: Partial<Extras> = {}): Extras & { calls: string[] } {
  const calls: string[] = [];
  const t: Extras & { calls: string[] } = {
    calls,
    can: true,
    what: "spot",
    markets: async () => [BTC],
    market: async () => (calls.push("market"), { ...BTC }),
    place: async () => (calls.push("place"), { ref: "x-1", status: "open", filledQty: 0, native: {} }),
    cancel: async (ref) => (calls.push("cancel"), { ref, status: "canceled", filledQty: 0, native: {} }),
    status: async (ref) => (calls.push("status"), { ref, status: "open", filledQty: 0, native: {} }),
    ...over,
  };
  return t;
}

function orderDoor(trader: LiveTrader, o: { mode?: "open" | "guard"; windowHours?: number } = {}) {
  let real = Date.parse(NOW);
  let n = 0;
  const logs: Dict[] = [];
  const cards: CardLike[] = [];
  const spend: SpendApproval = { id: "sa-trade", agent: AGENT as Hex, scope: "trade", allow: ["ex"], perPaymentMicro: 50_000_000, budgetMicro: 100_000_000, windowHours: o.windowHours ?? 24, validUntil: Date.parse(NOW) + 86_400_000, spentMicro: 0, reservedMicro: 0, last: {}, payTo: {}, envelope: {} as Envelope, at: NOW };
  const money: LiveMoney = { writes: () => ({ on: true, capUsd: 100, turnOn: "--live" }), venue: (id) => (id === "ex" ? { id: "ex", name: "Ex", kind: "cex", trader, via: "a stand-in" } : undefined), realNow: () => real };
  const e = {
    payments: [],
    orders: [] as LiveOrder[],
    nextOrderId: () => `ord-${String(++n).padStart(4, "0")}`,
    nextPaymentId: () => "pay-0001",
    state: { agents: [{ address: AGENT, name: "Claude Code", code: "CC" }], spends: [spend] },
    stillSigned: async () => true,
    patchSpend(id: string, f: (s: SpendApproval) => SpendApproval) {
      const i = e.state.spends.findIndex((s) => s.id === id);
      e.state.spends[i] = f(e.state.spends[i]!);
    },
    host: {
      now: () => new Date(real).toISOString(),
      log: (row: Dict) => void logs.push(row),
      liveMoney: () => money,
      raiseCard: (flight: string, c: Omit<CardLike, "id" | "status" | "flight">) => {
        const card = { ...c, id: `card-${cards.length + 1}`, status: "pending" as const, flight };
        cards.push(card);
        return card;
      },
      openFlight: () => ({ no: "F-1" }),
      say: () => undefined,
      policy: () => ({ mode: o.mode ?? "open", reach: {}, revoked: [], knownDestinations: [], blocklist: [], guard: {}, sessionExpiresAt: "2099-01-01T00:00:00.000Z" }),
    },
  };
  const engine = e as unknown as OrderEngine;
  return { e: engine, d: new LiveOrders(engine), logs, cards, spend: () => e.state.spends[0]!, tick: (ms: number) => (real += ms) };
}
const who = { signer: AGENT, envelope: {} as Envelope, hash: `0x${"ab".repeat(32)}` as Hex, agent: { address: AGENT, name: "Claude Code", code: "CC" } as unknown as AgentKey };
const owner = { signer: "0x00000000000000000000000000000000000000f0", authority: "owner" as const, envelope: {} as Envelope };
const agentBuy = (over: Dict = {}) => ({ type: "agentLiveOrder", venue: "ex", symbol: "BTC/USDT", side: "buy", orderType: "limit", qty: "0.0005", usd: "", limitPrice: "60000", nonce: 1, ...over }) as unknown as AgentLiveOrderAction;
const placed = (o: Outcome): LiveOrder => {
  if (isRefusal(o) || o.kind !== "order") throw new Error(`expected an order, got ${isRefusal(o) ? `${o.code}: ${o.message}` : o.kind}`);
  return o.order;
};
const lostOrder = () => no("E_VENUE_UNREACHABLE", { venue: "ex", message: "Ex did not confirm the order: it may or may not have been placed", detail: { clientOrderId: "c" } });

describe("R2-33 · an order whose answer was lost is kept, counted, and followed by the account's id", () => {
  it("the agent is told so with the order's id; its budget and its turn in the window stay taken; found by its id, it is followed as any order", async () => {
    let found: OrderState | null | undefined;
    const t = standIn({ place: async () => lostOrder(), byClient: async () => found });
    const { e, d, spend, tick } = orderDoor(t);
    const r = refusal(await d.agent(agentBuy(), who));
    expect([r.code, (r.detail as { order?: string }).order, (r.detail as { unsure?: boolean }).unsure]).toEqual(["E_VENUE_UNREACHABLE", "ord-0001", true]);
    const o = e.orders[0]!;
    expect([o.id, o.ref, o.status, o.unconfirmed, o.usd]).toEqual(["ord-0001", "", "pending", true, 30]);
    expect([spend().spentMicro, spend().last.ex !== undefined]).toEqual([30_000_000, true]);
    // the window's one order is still taken: a second order is refused, not sent
    expect(refusal(await d.agent(agentBuy({ nonce: 2 }), who)).code).toBe("E_MANDATE_RATE");
    // not there yet: kept as it is
    found = null;
    tick(20_000);
    await d.poll();
    expect([o.status, o.unconfirmed, spend().spentMicro]).toEqual(["pending", true, 30_000_000]);
    // there under the account's id: followed by its own id from here
    found = { ref: "x-77", status: "partial", filledQty: 0.0002, avgPrice: 60_000, native: {} };
    tick(20_000);
    await d.poll();
    expect([o.ref, o.status, o.filledQty, o.unconfirmed]).toEqual(["x-77", "partial", 0.0002, undefined]);
    expect(d.openAt("ex")?.id).toBe("ord-0001");
  });

  it("shown as none for longer than an order takes to come through, nothing was placed: canceled, and what it counted goes back", async () => {
    const t = standIn({ place: async () => lostOrder(), byClient: async () => null });
    const { e, d, spend, tick } = orderDoor(t);
    refusal(await d.agent(agentBuy(), who));
    tick(130_000);
    await d.poll();
    const o = e.orders[0]!;
    expect([o.status, o.note]).toEqual(["canceled", "Ex shows no order under the account's id: nothing was placed"]);
    expect(spend().spentMicro).toBe(0);
  });

  it("a venue that cannot be asked by the account's id keeps it counted; the owner's cancel stops following it and frees what it held", async () => {
    const t = standIn({ place: async () => no("E_VENUE_UNREACHABLE", { venue: "ex", message: "Ex did not answer", detail: { placed: "unknown" } }) });
    const { e, d, spend } = orderDoor(t);
    refusal(await d.agent(agentBuy(), who));
    expect(spend().spentMicro).toBe(30_000_000);
    // an agent cannot cancel what the venue has not shown
    expect(refusal(await d.cancel({ venue: "ex", order: "ord-0001" }, { ...who, authority: "agent" })).code).toBe("E_VENUE_UNREACHABLE");
    const o = placed(await d.cancel({ venue: "ex", order: "ord-0001" }, owner));
    expect([o.unfollowed, spend().spentMicro, t.calls.includes("cancel")]).toEqual([true, 0, false]);
    expect(e.orders[0]!.note).toContain("did not confirm it and has not shown it under the account's id");
    // and "nothing was placed" from a venue stays a plain refusal: no order kept, nothing counted
    const none = standIn({ place: async () => no("E_VENUE_UNREACHABLE", { venue: "ex", message: "Ex held no order under the account's id: nothing was placed", detail: { clientOrderId: "c", placed: false } }) });
    const b = orderDoor(none);
    refusal(await b.d.agent(agentBuy(), who));
    expect([b.e.orders.length, b.spend().spentMicro, b.spend().last.ex]).toEqual([0, 0, undefined]);
  });
});

describe("R3-25 · a change the venue did not confirm keeps its growth counted, and the venue's next answer settles it", () => {
  const unsureAmend = async () => no("E_VENUE_UNREACHABLE", { venue: "ex", message: "Ex did not confirm the change: it may or may not have been made", detail: { order: "x-1", unsure: true } });

  it("made: the order takes the asked size, and the growth stays counted", async () => {
    let size = 0.0005;
    const t = standIn({ amend: unsureAmend, status: async (ref) => ({ ref, status: "open", filledQty: 0, native: {}, qty: size }) as OrderState });
    const { e, d, spend, tick } = orderDoor(t);
    placed(await d.agent(agentBuy(), who));
    expect(spend().spentMicro).toBe(30_000_000);
    const r = refusal(await d.amend({ type: "agentLiveAmend", venue: "ex", order: "ord-0001", qty: "0.0008", limitPrice: "", stopPrice: "", nonce: 2 } as never, { ...who, authority: "agent" }));
    expect((r.detail as { unsure?: boolean }).unsure).toBe(true);
    const o = e.orders[0]!;
    expect([o.qty, o.usd, spend().spentMicro, o.changing?.qty]).toEqual([0.0005, 48, 48_000_000, 0.0008]);
    // a second change waits for the venue to say
    expect(refusal(await d.amend({ type: "agentLiveAmend", venue: "ex", order: "ord-0001", qty: "0.0006", limitPrice: "", stopPrice: "", nonce: 3 } as never, { ...who, authority: "agent" })).code).toBe("E_ACCOUNT_BAD_ACTION");
    size = 0.0008;
    tick(10_000);
    await d.poll();
    expect([o.qty, o.usd, o.changing, spend().spentMicro]).toEqual([0.0008, 48, undefined, 48_000_000]);
  });

  it("not made: the order stands as it was, and what the change would have grown by is free", async () => {
    const t = standIn({ amend: unsureAmend, status: async (ref) => ({ ref, status: "open", filledQty: 0, native: {}, qty: 0.0005 }) as OrderState });
    const { e, d, spend, tick } = orderDoor(t);
    placed(await d.agent(agentBuy(), who));
    refusal(await d.amend({ type: "agentLiveAmend", venue: "ex", order: "ord-0001", qty: "0.0008", limitPrice: "", stopPrice: "", nonce: 2 } as never, { ...who, authority: "agent" }));
    tick(10_000);
    await d.poll();
    const o = e.orders[0]!;
    expect([o.qty, o.usd, o.changing, spend().spentMicro]).toEqual([0.0005, 30, undefined, 30_000_000]);
  });

  it("a definite no still gives the growth back at once", async () => {
    const t = standIn({ amend: async () => no("E_VENUE_REJECTED", { venue: "ex", message: "Ex refused the change" }) });
    const { d, spend } = orderDoor(t);
    placed(await d.agent(agentBuy(), who));
    refusal(await d.amend({ type: "agentLiveAmend", venue: "ex", order: "ord-0001", qty: "0.0008", limitPrice: "", stopPrice: "", nonce: 2 } as never, { ...who, authority: "agent" }));
    expect(spend().spentMicro).toBe(30_000_000);
  });
});

describe("R2-34 · an order at a venue that refuses this network can be let go by the owner", () => {
  it("the owner's cancel refused by the venue's edge stops following the order, frees what it held, and the venue can be disconnected", async () => {
    const page = "<html><head><title>Access Denied</title></head><body>You don't have permission. Reference 203.0.113.9</body></html>";
    const t = standIn({ cancel: async () => no("E_VENUE_GEOBLOCKED", { venue: "ex", message: edgeWords("Ex", 403, page), native: { status: 403, edge: true } }) });
    const { e, d, spend } = orderDoor(t);
    placed(await d.agent(agentBuy(), who));
    expect(d.openAt("ex")?.id).toBe("ord-0001");
    const o = placed(await d.cancel({ venue: "ex", order: "ord-0001" }, owner));
    expect([o.unfollowed, spend().spentMicro, d.openAt("ex")]).toEqual([true, 0, undefined]);
    expect(o.note).toBe("Ex refuses this network, so the account can neither cancel it nor see it fill: it stopped following it, and what it held of a limit beyond what had filled is free. Cancel it at Ex");
    expect(JSON.stringify(e.orders)).not.toContain("203.0.113.9");
  });

  it("the key's IP list and a ban are the same; an agent's cancel stays the venue's answer", async () => {
    const t = standIn({ cancel: async () => no("E_VENUE_PERMISSION", { venue: "ex", message: ipListWords("Ex"), detail: { ipList: true } }) });
    const { d } = orderDoor(t);
    placed(await d.agent(agentBuy(), who));
    expect(refusal(await d.cancel({ venue: "ex", order: "ord-0001" }, { ...who, authority: "agent" })).detail).toEqual({ ipList: true });
    expect(placed(await d.cancel({ venue: "ex", order: "ord-0001" }, owner)).unfollowed).toBe(true);
  });
});

describe("R1-43 · a venue's ban and its place rule hold the order poll back, not only the reads", () => {
  it("a status answered with a ban until 30 minutes from now: the venue's other orders are not asked, nothing is asked before then, and asking resumes after", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse(NOW));
    let banned = true;
    const t = standIn();
    t.status = async (ref) => (t.calls.push("status"), banned ? bannedNo("ex", "Ex", Date.now() + 30 * 60_000, { status: 418 }) : { ref, status: "open", filledQty: 0, native: {} });
    const { d, tick } = orderDoor(t, { windowHours: 0 });
    const later = (ms: number) => {
      tick(ms);
      vi.setSystemTime(Date.now() + ms);
    };
    placed(await d.agent(agentBuy(), who));
    placed(await d.agent(agentBuy({ nonce: 2, limitPrice: "59000" }), who));
    const asked = () => t.calls.filter((c) => c === "status").length;
    later(10_000);
    await d.poll();
    // one order asked; its answer holds the venue back, so the other is not
    expect(asked()).toBe(1);
    for (const step of [60_000, 5 * 60_000, 20 * 60_000]) {
      later(step);
      await d.poll();
    }
    expect(asked()).toBe(1);
    // an agent's new order is answered with the ban, the venue not asked for its market
    const markets = t.calls.filter((c) => c === "market").length;
    const held = refusal(await d.agent(agentBuy({ nonce: 3, limitPrice: "58000" }), who));
    expect([held.code, (held.native as { ban?: boolean }).ban, t.calls.filter((c) => c === "market").length]).toEqual(["E_VENUE_UNREACHABLE", true, markets]);
    // the ban runs out: both orders are asked again
    banned = false;
    later(5 * 60_000);
    await d.poll();
    expect(asked()).toBe(3);
  });

  it("an edge page in answer to a status holds the venue ten minutes; a venue that only did not answer is asked again by the poll's backoff", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse(NOW));
    let answer: Refusal | undefined = no("E_VENUE_GEOBLOCKED", { venue: "ex", message: edgeWords("Ex", 403, "<html><title>Access Denied</title></html>"), native: { status: 403, edge: true } });
    const t = standIn();
    t.status = async (ref) => (t.calls.push("status"), answer ?? { ref, status: "open", filledQty: 0, native: {} });
    const { d, tick } = orderDoor(t);
    const later = (ms: number) => {
      tick(ms);
      vi.setSystemTime(Date.now() + ms);
    };
    placed(await d.agent(agentBuy(), who));
    const asked = () => t.calls.filter((c) => c === "status").length;
    later(10_000);
    await d.poll();
    later(5 * 60_000);
    await d.poll();
    expect(asked()).toBe(1);
    answer = no("E_VENUE_UNREACHABLE", { venue: "ex", message: "Ex could not be reached" });
    later(6 * 60_000);
    await d.poll();
    expect(asked()).toBe(2);
    answer = undefined;
    later(30_000);
    await d.poll();
    expect(asked()).toBe(3);
  });
});

describe("R3-26 · the venue's place rule is asked before a quote or a card", () => {
  const line = async () => no("E_VENUE_GEOBLOCKED", { venue: "ex", message: "Ex does not serve this location: that is its own rule, and the account does not look for a way around it", native: { blocked: true } });

  it("the owner is not quoted, and an agent's Guard card is not raised nor its budget held, for an order the venue's line refuses", async () => {
    const t = standIn({ held: line });
    const { e, d, cards, spend } = orderDoor(t, { mode: "guard" });
    const q = refusal(await d.prepare({ venue: "ex", symbol: "BTC/USDT", side: "buy", orderType: "limit", qty: "0.0005", limitPrice: "60000" }));
    expect(q.code).toBe("E_VENUE_GEOBLOCKED");
    expect(refusal(await d.agent(agentBuy(), who)).code).toBe("E_VENUE_GEOBLOCKED");
    expect([cards.length, spend().reservedMicro, e.orders.length, t.calls.includes("place")]).toEqual([0, 0, 0, false]);
  });

  it("a close-only place lets a close through (asked as reduce-only); a check that does not answer blocks nothing — the order asks again", async () => {
    const asked: Array<{ side: string; reduceOnly?: boolean | undefined }> = [];
    const closeOnly = standIn({ held: async (o) => (asked.push(o), o.reduceOnly || o.side === "sell" ? undefined : line()) });
    const { d } = orderDoor(closeOnly, { mode: "guard" });
    expect(ok(await d.prepare({ venue: "ex", symbol: "BTC/USDT", side: "sell", orderType: "limit", qty: "0.0005", limitPrice: "60000" })).quote.maxUsd).toBeGreaterThan(0);
    const silent = standIn({ held: async () => no("E_VENUE_UNREACHABLE", { venue: "ex", message: "the location check did not answer" }) });
    const g = orderDoor(silent, { mode: "guard" });
    const card = await g.d.agent(agentBuy(), who);
    expect(!isRefusal(card) && card.kind).toBe("card");
  });
});

describe("R4-3 · a ref that is not one is never taken over the order's own", () => {
  it("a status answer carrying a page where the id should be leaves the order's ref as it was, and no address lands on the order", async () => {
    const t = standIn({ status: async () => ({ ref: PAGE_TEXT, status: "open", filledQty: 0, native: {} }) });
    const { e, d, tick } = orderDoor(t);
    placed(await d.agent(agentBuy(), who));
    tick(10_000);
    await d.poll();
    expect(e.orders[0]!.ref).toBe("x-1");
    expect(JSON.stringify(e.orders)).not.toContain("203.0.113.9");
  });
});

describe("R4-28 · a later answer never wipes a known fill, and one read back unread moves the status only to a final one", () => {
  it("a status that says less filled for the same order keeps the fill; an unread answer after a cancel keeps the order open until a final word", async () => {
    let next: OrderState = { ref: "x-1", status: "partial", filledQty: 0.0003, avgPrice: 60_000, native: {} };
    const t = standIn({ status: async () => next, cancel: async (ref) => ({ ref, status: "pending", filledQty: 0.0003, native: { unread: true } }) });
    const { e, d, tick } = orderDoor(t);
    placed(await d.agent(agentBuy(), who));
    const o = e.orders[0]!;
    tick(10_000);
    await d.poll();
    expect([o.status, o.filledQty]).toEqual(["partial", 0.0003]);
    next = { ref: "x-1", status: "open", filledQty: 0, native: {} };
    tick(10_000);
    await d.poll();
    expect(o.filledQty).toBe(0.0003);
    placed(await d.cancel({ venue: "ex", order: "ord-0001" }, owner));
    expect([o.status, o.canceling, o.filledQty]).toEqual(["open", true, 0.0003]);
    next = { ref: "x-1", status: "canceled", filledQty: 0.0003, native: { unread: true } };
    tick(10_000);
    await d.poll();
    expect(o.status).toBe("canceled");
  });
});

// ---- earn ------------------------------------------------------------------------------------------------------------------------

/** an exchange client as the library would be, with only the implicit calls a test sets (as in live-earn.test.ts) */
function earnClient(id: string, calls: Array<[string, Dict]>, answers: Record<string, unknown>): ExchangeClient {
  const c: Dict = { id, fetchBalance: async () => ({}) };
  for (const [name, a] of Object.entries(answers)) {
    c[name] = async (params: Dict) => {
      calls.push([name, params]);
      const next = Array.isArray(a) ? (a.length > 1 ? a.shift() : a[0]) : a;
      if (next instanceof Error) throw next;
      return typeof next === "function" ? (next as (p: unknown) => unknown)(params) : next;
    };
  }
  return c as unknown as ExchangeClient;
}
const USDT: EarnProduct = { id: "savings:USDT", asset: "USDT", name: "USDT · Simple Earn Flexible", lands: "your OKX funding account", canSupply: true, canWithdraw: true };

describe("R1-3 · a key bound to other addresses is told as that at the exchanges' earn, not as a missing permission", () => {
  it("OKX 50110 and KuCoin 400006 keep the IP list's words and detail", async () => {
    const okx = okxEarner({ client: earnClient("okx", [], { privateGetFinanceSavingsBalance: named("PermissionDenied", 'okx {"code":"50110","msg":"Your IP 203.0.113.9 is not included in your API key\'s IP whitelist."}') }), venue: "okx", name: "OKX", key: KEY, can: ["read", "trade"] });
    const r = refusal(await okx.positions());
    expect([r.code, r.message, r.detail]).toEqual(["E_VENUE_PERMISSION", ipListWords("OKX"), { ipList: true }]);
    expect(JSON.stringify(r)).not.toContain("203.0.113.9");
    const kucoin = kucoinEarner({ client: earnClient("kucoin", [], { earnPostEarnOrders: named("PermissionDenied", 'kucoin {"code":"400006","msg":"The requested IP address is not in the API whitelist"}') }), venue: "kucoin", name: "KuCoin", key: KEY, can: ["read", "earn"] });
    const k = refusal(await kucoin.supply({ ...USDT, id: "2152", name: "USDT · Savings (flexible)" }, 10, CID));
    expect([k.code, k.message, k.detail]).toEqual(["E_VENUE_PERMISSION", ipListWords("KuCoin"), { ipList: true }]);
  });
});

describe("R3-2 · money put to earn or taken out whose answer was lost is under way, followed, and never sent twice", () => {
  it("OKX: a purchase that timed out is pending under the account's id, the same id is the same request, and what is lent settles it", async () => {
    const calls: Array<[string, Dict]> = [];
    let lent = "100";
    const c = earnClient("okx", calls, {
      privateGetFinanceSavingsBalance: () => ({ code: "0", data: [{ ccy: "USDT", amt: lent, earnings: "0" }] }),
      privatePostFinanceSavingsPurchaseRedempt: [new lib.RequestTimeout("okx POST https://www.okx.com/api/v5/finance/savings/purchase-redempt request timed out (14000 ms, the answer included)")],
    });
    const e = okxEarner({ client: c, venue: "okx", name: "OKX", key: KEY, can: ["read", "trade"] });
    const s = ok(await e.supply(USDT, 25, CID));
    expect([s.ref, s.status, (s.native as { unsure?: boolean; before?: number }).unsure, (s.native as { before?: number }).before]).toEqual([`purchase:savings:USDT:client-${CID}`, "pending", true, 100]);
    expect((s.native as { waiting: string }).waiting).toBe("OKX did not confirm it: it may or may not have moved. Look at OKX before asking again");
    expect(ok(await e.supply(USDT, 25, CID)).ref).toBe(s.ref);
    expect(calls.filter(([n]) => n.startsWith("privatePost"))).toHaveLength(1);
    // nothing to show for it yet: still under way, never "nothing moved"
    const asked = { amount: 25, native: s.native };
    expect(ok(await e.status!(s.ref, USDT, "supply", asked)).status).toBe("pending");
    lent = "125.0004";
    expect(ok(await e.status!(s.ref, USDT, "supply", asked)).status).toBe("done");
  });

  it("KuCoin's purchase and Binance's redemption the same: under way, settled by what is held, or by Binance's redemption record by when and how much", async () => {
    let held = "50";
    const kc = kucoinEarner({ client: earnClient("kucoin", [], { earnGetEarnHoldAssets: () => ({ code: "200000", data: { totalPage: 1, items: [{ orderId: "1", productId: "2152", currency: "USDT", holdAmount: held, redeemingAmount: "0", status: "LOCKED" }] } }), earnPostEarnOrders: named("NetworkError", "kucoin POST https://api.kucoin.com/api/v1/earn/orders socket hang up") }), venue: "kucoin", name: "KuCoin", key: KEY, can: ["read", "earn"] });
    const p = { ...USDT, id: "2152", name: "USDT · Savings (flexible)" };
    const s = ok(await kc.supply(p, 10, CID));
    expect([s.status, (s.native as { before?: number }).before]).toEqual(["pending", 50]);
    held = "60";
    expect(ok(await kc.status!(s.ref, p, "supply", { amount: 10, native: s.native })).status).toBe("done");

    const T0 = Date.parse(NOW);
    const bn = binanceEarner({ client: earnClient("binance", [], { sapiGetSimpleEarnFlexibleList: { rows: [], total: 0 }, sapiGetSimpleEarnFlexiblePosition: { rows: [], total: 0 }, sapiPostSimpleEarnFlexibleSubscribe: {}, sapiPostSimpleEarnFlexibleRedeem: named("RequestTimeout", "binance POST https://api.binance.com/sapi/v1/simple-earn/flexible/redeem request timed out"), sapiGetSimpleEarnFlexibleHistoryRedemptionRecord: [{ rows: [], total: 0 }, { rows: [{ amount: "10", asset: "USDT", time: T0 + 2_000, productId: "USDT001", redeemId: 40608, status: "PAID" }], total: 1 }] }), venue: "binance", name: "Binance", key: KEY, can: ["read", "trade spot and margin"], now: () => T0 });
    const q = { ...USDT, id: "USDT001", name: "USDT · Simple Earn Flexible" };
    const w = ok(await bn.withdraw(q, 10, CID, false));
    expect([w.status, (w.native as { sentAt?: number }).sentAt]).toEqual(["pending", T0]);
    expect(ok(await bn.status!(w.ref, q, "withdraw", { amount: 10, native: w.native })).status).toBe("pending");
    expect(ok(await bn.status!(w.ref, q, "withdraw", { amount: 10, native: w.native })).status).toBe("done");
  });
});

// ---- the earn door, on a stand-in earner ---------------------------------------------------------------------------------------------

function earnDoor(earner: LiveEarner) {
  let real = Date.parse(NOW);
  let n = 0;
  const spend: SpendApproval = { id: "sa-earn", agent: AGENT as Hex, scope: "earn", allow: ["ex"], perPaymentMicro: 50_000_000, budgetMicro: 100_000_000, windowHours: 24, validUntil: Date.parse(NOW) + 86_400_000, spentMicro: 0, reservedMicro: 0, last: {}, payTo: {}, envelope: {} as Envelope, at: NOW };
  const money: LiveMoney = { writes: () => ({ on: true, capUsd: 100, turnOn: "--live" }), venue: (id) => (id === "ex" ? { id: "ex", name: "Ex", kind: "cex", via: "a stand-in" } : undefined), realNow: () => real };
  const e = {
    payments: [],
    earns: [] as unknown[],
    nextEarnId: () => `earn-${String(++n).padStart(4, "0")}`,
    nextPaymentId: () => "pay-0001",
    state: { agents: [{ address: AGENT, name: "Claude Code", code: "CC" }], spends: [spend] },
    stillSigned: async () => true,
    patchSpend(id: string, f: (s: SpendApproval) => SpendApproval) {
      const i = e.state.spends.findIndex((s) => s.id === id);
      e.state.spends[i] = f(e.state.spends[i]!);
    },
    host: {
      now: () => new Date(real).toISOString(),
      log: () => undefined,
      liveMoney: () => money,
      liveEarn: () => ({ earner: (v: string) => (v === "ex" ? earner : undefined) }),
      raiseCard: () => {
        throw new Error("no card in Beast");
      },
      openFlight: () => ({ no: "F-1" }),
      say: () => undefined,
      policy: () => ({ mode: "open", reach: {}, revoked: [], knownDestinations: [], blocklist: [], guard: {}, sessionExpiresAt: "2099-01-01T00:00:00.000Z" }),
    },
  };
  const engine = e as unknown as EarnEngine;
  return { e: engine, d: new LiveEarns(engine), spend: () => e.state.spends[0]!, tick: (ms: number) => (real += ms) };
}
const supplyAsk = (nonce = 1) => ({ type: "agentLiveEarn", venue: "ex", kind: "supply", product: "savings:USDC", asset: "USDC", amount: "10", nonce }) as unknown as AgentLiveEarnAction;
const USDC: EarnProduct = { id: "savings:USDC", asset: "USDC", name: "USDC · flexible", lands: "your Ex funding account", canSupply: true, canWithdraw: true, priceUsd: 1 };
function earnerStandIn(supply: () => Promise<EarnState | Refusal>, status?: LiveEarner["status"]): LiveEarner {
  return { can: true, what: "flexible", products: async () => [USDC], product: async () => USDC, positions: async () => [], supply, withdraw: supply, ...(status ? { status } : {}) };
}

describe("R3-24 · a supply the venue refused for this network does not use up the agent's one supply per window", () => {
  it("refused (its place rule), nothing moved: the budget and the window's turn are as they were, and the next supply goes", async () => {
    let refuse = true;
    const ex = earnerStandIn(async () => (refuse ? no("E_VENUE_GEOBLOCKED", { venue: "ex", message: "Ex does not serve this location: that is its own rule, and the account does not look for a way around it" }) : { ref: "purchase:1", status: "done", native: {} }));
    const { d, spend } = earnDoor(ex);
    expect(refusal(await d.agent(supplyAsk(1), who)).code).toBe("E_VENUE_GEOBLOCKED");
    expect([spend().spentMicro, spend().last]).toEqual([0, {}]);
    refuse = false;
    const out = await d.agent(supplyAsk(2), who);
    expect(isRefusal(out)).toBe(false);
    expect(spend().spentMicro).toBe(10_000_000);
  });
});

describe("R3-2 · R1-43 · the earn door keeps an unsure request counted and followed, and its poll waits out a ban", () => {
  it("an unsure supply is a pending request, counted on the limit; its status is asked with what was asked; a ban holds the poll back", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse(NOW));
    const seen: unknown[] = [];
    let banned = true;
    const ex = earnerStandIn(
      async () => ({ ref: `purchase:savings:USDC:client-${CID}`, status: "pending", native: { unsure: true, waiting: "Ex did not confirm it: it may or may not have moved. Look at Ex before asking again", before: 0 } }),
      async (ref, _p, _k, asked) => (seen.push(asked), banned ? bannedNo("ex", "Ex", Date.now() + 30 * 60_000, { status: 418 }) : { ref, status: "done", native: { ...(asked?.native as Dict), held: 10 } }),
    );
    const { e, d, spend, tick } = earnDoor(ex);
    const later = (ms: number) => {
      tick(ms);
      vi.setSystemTime(Date.now() + ms);
    };
    const out = await d.agent(supplyAsk(), who);
    const earn = (out as { result: { earn: { status: string; note: string } } }).result.earn;
    expect([earn.status, earn.note, spend().spentMicro]).toEqual(["pending", "Ex did not confirm it: it may or may not have moved. Look at Ex before asking again", 10_000_000]);
    later(20_000);
    await d.poll();
    expect(seen).toEqual([{ amount: 10, all: undefined, native: expect.objectContaining({ unsure: true, before: 0 }) }]);
    later(60_000);
    await d.poll();
    expect(seen).toHaveLength(1);
    banned = false;
    later(30 * 60_000);
    await d.poll();
    expect([seen.length, (e.earns[0] as { status: string }).status, spend().spentMicro]).toEqual([2, "done", 10_000_000]);
  });
});
