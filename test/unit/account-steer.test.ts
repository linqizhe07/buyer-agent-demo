import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isRefusal, type Refusal } from "../../src/core/errors.ts";
import { no } from "../../src/portfolio/refuse.ts";
import { tradeKinds } from "../../src/portfolio/accounts.ts";
import { cardHash, type Outcome } from "../../src/portfolio/account/exchange.ts";
import type { Payment } from "../../src/portfolio/account/payments.ts";
import { MONEY_TYPES, shownFields, signAgent, signOwner, simKey, STEER_TYPES, type AgentAction, type OwnerAction, type SimKey } from "../../src/portfolio/account/sign.ts";
import { paymentLine } from "../../src/portfolio/account/statement.ts";
import { ASK_TTL_MS, ASKS_PER_HOUR, cleanName, MAX_INTENTS, MAX_REPORTS, MAX_WATCH, spendFor } from "../../src/portfolio/account/state.ts";
import { register, type LiveDeps } from "../../src/portfolio/live/index.ts";
import type { LiveTrader, Market, OrderState } from "../../src/portfolio/live/trade.ts";
import { PortfolioService } from "../../src/portfolio/service.ts";

/** How the owner steers and the agents answer: a watchlist and intents the owner signs, reports and asks the agents sign. None of it is
 * authority — it never makes or widens a limit — and the account keeps it the way it keeps the rest: signed, re-verified on restore (all but
 * the asks, which live a day in memory). Cards and statement lines say which agent did what. */
type NoNonce<T> = T extends unknown ? Omit<T, "nonce"> : never;
const START = Date.parse("2026-10-05T14:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));
const owner = simKey("owner");
const cc = simKey("agent:claude-code");
const codex = simKey("agent:codex");
const stranger = simKey("agent:stranger");

const BTC: Market = { symbol: "BTC/USDT", name: "BTC/USDT", kind: "spot", base: "BTC", quote: "USDT", price: 60_000, bid: 59_990, ask: 60_010, minQty: 0.0001, qtyStep: 0.0001, priceStep: 0.1, open: true, types: ["market", "limit"] };
const states = new Map<string, OrderState>();
const trader: LiveTrader = {
  can: true,
  what: "spot",
  async markets() {
    return [BTC];
  },
  async market(symbol) {
    return symbol === BTC.symbol ? { ...BTC } : no("E_VENUE_REJECTED", { venue: "ex", message: `no market ${symbol}` });
  },
  async place(o) {
    const s: OrderState = { ref: `r-${states.size + 1}`, status: "open", filledQty: 0, native: {} };
    states.set(s.ref, s);
    return s;
  },
  async cancel(ref) {
    return { ...states.get(ref)!, status: "canceled" };
  },
  async status(ref) {
    return states.get(ref)!;
  },
};
register({ kind: "standin-steer", label: "a venue that trades", needs: "key-file", example: "", venues: [], async open(req) {
  return { source: { name: req.label || "Stand-in", kind: "cex", reference: "standin", via: "a stand-in", probe: { can: ["read", "trade"], note: "" }, read: async () => [{ asset: "USDT", amount: 500, usd: 500 }], trader, readOnlyBecause: "the stand-in moves no money" }, first: [{ asset: "USDT", amount: 500, usd: 500 }], summary: "connected" };
} });

const fresh = () => {
  const h = mkdtempSync(join(tmpdir(), "account-steer-"));
  homes.push(h);
  return h;
};

/** one run of the real account on `home`, `at` ms after the start, the owner an address given at start; its clock can be moved */
async function run(home: string, at = 0, o: { real?: boolean } = {}) {
  let t = START + at;
  let n = 0;
  const liveDeps: Partial<LiveDeps> = { clock: () => t, http: async () => ({ status: 599, body: undefined, text: "" }), price: async () => undefined };
  const real = o.real !== false;
  const svc = await PortfolioService.create({ home, now: () => new Date(t).toISOString(), venues: "frontline", ...(real ? { real: true, liveDeps, liveWrites: { capUsd: 1000, pairingCode: "K7QX-M2PA" } } : {}), account: { owners: [{ id: owner.address, kind: "eoa" as const, label: "owner", addedAt: new Date(START).toISOString() }] } });
  await svc.restoring;
  const engine = svc.account!;
  const nonce = () => t + ++n;
  const own = async (a: NoNonce<OwnerAction>, by: SimKey = owner) => svc.exchange(await signOwner(by, { ...a, nonce: nonce() } as OwnerAction));
  const ag = async (a: NoNonce<AgentAction>, key: SimKey = cc) => svc.exchange(await signAgent(key, { ...a, nonce: nonce() } as AgentAction));
  return { svc, engine, own, ag, page: () => engine.view(), pass: (ms: number) => void (t += ms), now: () => t, nonce };
}

/** an account with the stand-in venue connected and Claude Code let in */
async function account(home = fresh(), at = 0) {
  const x = await run(home, at);
  ok(await x.own({ type: "connectVenue", venue: "ex", connector: "live:standin-steer", label: "Ex", credentialRef: "" }));
  ok(await x.own({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: START + 30 * DAY }));
  return x;
}

const ok = (o: Outcome | Refusal) => {
  if (isRefusal(o)) throw new Error(`${o.code}: ${o.message}`);
  return o;
};
const code = (o: Outcome | Refusal): string => (isRefusal(o) ? o.code : o.kind);
const refusalOf = (o: Outcome | Refusal): Refusal => {
  if (!isRefusal(o)) throw new Error(`expected a refusal, got ${o.kind}`);
  return o;
};
const result = (o: Outcome | Refusal) => {
  const x = ok(o);
  if (x.kind !== "result") throw new Error(`expected a result, got ${x.kind}`);
  return x.result as Record<string, unknown>;
};
const intent = (o: Partial<{ id: string; agent: string; venue: string; symbol: string; side: string; usd: string; text: string; validUntil: number }> = {}) => ({ type: "setIntent" as const, id: "", agent: cc.address as string, venue: "ex", symbol: "BTC/USDT", side: "buy", usd: "50", text: "Buy BTC under 59k this week", validUntil: START + 7 * DAY, ...o });
const report = (o: Partial<{ intent: string; status: string; note: string; refs: string }> = {}) => ({ type: "agentReport" as const, intent: "intent-0001", status: "taking", note: "", refs: "", ...o });
const ask = (o: Partial<{ kind: string; venue: string; usd: string; text: string }> = {}) => ({ type: "agentAsk" as const, kind: "limit", venue: "ex", usd: "100", text: "a trading limit at Ex, please", ...o });

describe("the owner's watchlist", () => {
  it("watches a market at a venue on the account or not, once; stops; at most 50; the page shows it", async () => {
    const x = await account();
    ok(await x.own({ type: "setWatch", venue: "kraken", symbol: "BTC/USD", on: "true" }));
    ok(await x.own({ type: "setWatch", venue: "kraken", symbol: "BTC/USD", on: "true" }));
    ok(await x.own({ type: "setWatch", venue: "ex", symbol: "BTC/USDT", on: "true" }));
    expect((await x.page()).watch.map((w) => `${w.venue} ${w.symbol}`)).toEqual(["kraken BTC/USD", "ex BTC/USDT"]);
    ok(await x.own({ type: "setWatch", venue: "kraken", symbol: "BTC/USD", on: "" }));
    expect(code(await x.own({ type: "setWatch", venue: "kraken", symbol: "BTC/USD", on: "" }))).toBe("E_ACCOUNT_BAD_ACTION");
    expect(code(await x.own({ type: "setWatch", venue: "Kraken!", symbol: "BTC/USD", on: "true" }))).toBe("E_ACCOUNT_BAD_ACTION");
    expect(code(await x.own({ type: "setWatch", venue: "kraken", symbol: "BTC/USD", on: "yes" }))).toBe("E_ACCOUNT_BAD_ACTION");
    for (let i = 1; i < MAX_WATCH; i++) ok(await x.own({ type: "setWatch", venue: "kalshi", symbol: `KX-${i}:YES`, on: "true" }));
    expect(x.engine.state.watch.length).toBe(MAX_WATCH);
    expect(code(await x.own({ type: "setWatch", venue: "kalshi", symbol: "KX-ONE-MORE:YES", on: "true" }))).toBe("E_ACCOUNT_LIMIT");
  });
});

describe("the owner's intents", () => {
  it("an intent takes its id from the account's sequence, is signed field by field, and an edit keeps its id", async () => {
    const x = await account();
    ok(await x.own({ type: "approveSpend", agent: cc.address, scope: "trade", allow: "ex", perPayment: "100", budget: "200", windowHours: 0, validUntil: START + 7 * DAY }));
    ok(await x.own(intent()));
    // spend-0001 took the first number: the intent is the second
    expect(x.engine.state.intents.map((i) => i.id)).toEqual(["intent-0002"]);
    const signed = x.engine.state.intents[0]!.envelope.action as Extract<OwnerAction, { type: "setIntent" }>;
    expect(shownFields(signed).map((f) => f.name)).toEqual(["id", "agent", "venue", "symbol", "side", "usd", "text", "validUntil", "nonce"]);
    ok(await x.own(intent({ id: "intent-0002", text: "Buy BTC under 58k", usd: "" })));
    const page = await x.page();
    expect(page.intents.map((i) => [i.id, i.agentName, i.text, i.usd, i.side])).toEqual([["intent-0002", "Claude Code", "Buy BTC under 58k", "", "buy"]]);
    ok(await x.own(intent({ agent: "*", venue: "", symbol: "", side: "", text: "Keep half in cash" })));
    expect((await x.page()).intents.map((i) => [i.id, i.agent, i.agentName])).toEqual([["intent-0002", cc.address, "Claude Code"], ["intent-0003", "*", "every agent"]]);
  });

  it("validUntil 0 withdraws it: gone from the page, not changeable after; at most 20 open", async () => {
    const x = await account();
    ok(await x.own(intent()));
    ok(await x.own(intent({ id: "intent-0001", validUntil: 0 })));
    expect((await x.page()).intents).toEqual([]);
    expect(code(await x.own(intent({ id: "intent-0001" })))).toBe("E_ACCOUNT_BAD_ACTION");
    expect(code(await x.own(intent({ id: "intent-0001", validUntil: 0 })))).toBe("E_ACCOUNT_BAD_ACTION");
    for (let i = 0; i < MAX_INTENTS; i++) ok(await x.own(intent({ agent: "*", text: `intent ${i}` })));
    expect(code(await x.own(intent({ text: "one more" })))).toBe("E_ACCOUNT_LIMIT");
    ok(await x.own(intent({ id: "intent-0002", validUntil: 0 })));
    ok(await x.own(intent({ text: "one more" })));
    // a lapsed one counts for nothing
    x.pass(8 * DAY);
    expect((await x.page()).intents).toEqual([]);
    ok(await x.own(intent({ text: "after the week", validUntil: x.now() + DAY })));
    expect(x.engine.state.intents.length).toBe(1);
  });

  it("refuses what it cannot keep as signed: an agent not let in, a side, dollars, words over 200, an end in the past or past 180 days", async () => {
    const x = await account();
    expect(code(await x.own(intent({ agent: codex.address })))).toBe("E_ACCOUNT_BAD_ACTION");
    expect(code(await x.own(intent({ agent: "claude" })))).toBe("E_ACCOUNT_BAD_ACTION");
    expect(code(await x.own(intent({ side: "short" })))).toBe("E_ACCOUNT_BAD_ACTION");
    expect(code(await x.own(intent({ usd: "fifty" })))).toBe("E_ACCOUNT_BAD_ACTION");
    expect(code(await x.own(intent({ text: "" })))).toBe("E_ACCOUNT_BAD_ACTION");
    expect(code(await x.own(intent({ text: "x".repeat(201) })))).toBe("E_ACCOUNT_BAD_ACTION");
    expect(code(await x.own(intent({ validUntil: START - 1 })))).toBe("E_ACCOUNT_LIMIT");
    expect(code(await x.own(intent({ validUntil: START + 181 * DAY })))).toBe("E_ACCOUNT_LIMIT");
    ok(await x.own(intent({ text: "x".repeat(200) })));
  });
});

describe("an agent's report", () => {
  it("on an intent addressed to it or to every agent: the latest is the intent's word, with the agent's name", async () => {
    const x = await account();
    ok(await x.own({ type: "approveAgent", agentAddress: codex.address, agentName: "Codex", validUntil: START + 30 * DAY }));
    ok(await x.own(intent()));
    ok(await x.own(intent({ agent: codex.address, text: "Codex: sell ETH" })));
    ok(await x.own(intent({ agent: "*", text: "Anyone: keep cash" })));
    expect(result(await x.ag(report({ status: "taking", note: "watching the book" }))).reports).toBe(1);
    ok(await x.ag(report({ status: "done", note: "bought", refs: "ord-0001, 0xabc123" })));
    // another agent's intent is not this one's to report on; every agent's is
    expect(code(await x.ag(report({ intent: "intent-0002", status: "done" })))).toBe("E_ACCOUNT_BAD_ACTION");
    ok(await x.ag(report({ intent: "intent-0003", status: "note", note: "cash is 40%" })));
    ok(await x.ag(report({ intent: "intent-0003", status: "note", note: "cash is 50%" }), codex));
    expect(code(await x.ag(report({ intent: "intent-0009" })))).toBe("E_ACCOUNT_BAD_ACTION");
    expect(code(await x.ag(report({ status: "finished" })))).toBe("E_ACCOUNT_BAD_ACTION");
    expect(code(await x.ag(report({ refs: "<script>" })))).toBe("E_ACCOUNT_BAD_ACTION");
    const page = await x.page();
    expect(page.intents.map((i) => [i.id, i.reports, i.report?.status, i.report?.byName, i.report?.refs])).toEqual([
      ["intent-0001", 2, "done", "Claude Code", ["ord-0001", "0xabc123"]],
      ["intent-0002", 0, undefined, undefined, undefined],
      ["intent-0003", 2, "note", "Codex", []],
    ]);
  });

  it("a key nobody let in reports nothing, and its nonce is not spent; a revoked one reports nothing", async () => {
    const x = await account();
    ok(await x.own(intent({ agent: "*" })));
    const env = await signAgent(stranger, { ...report(), nonce: x.nonce() });
    expect(code(await x.svc.exchange(env))).toBe("E_ACCOUNT_UNKNOWN_SIGNER");
    expect(x.engine.state.requests.map((r) => [r.address, r.name])).toEqual([[stranger.address, ""]]);
    ok(await x.own({ type: "approveAgent", agentAddress: stranger.address, agentName: "Stranger", validUntil: START + DAY }));
    ok(await x.svc.exchange(env));
    ok(await x.own({ type: "approveAgent", agentAddress: "0x0000000000000000000000000000000000000000", agentName: "Stranger", validUntil: 0 }));
    expect(code(await x.ag(report({ status: "done" }), stranger))).toBe("E_ACCOUNT_AGENT_REVOKED");
  });

  it(`at most ${MAX_REPORTS} on one intent`, async () => {
    const x = await account();
    ok(await x.own(intent()));
    for (let i = 0; i < MAX_REPORTS; i++) ok(await x.ag(report({ status: "note", note: `${i}` })));
    expect(code(await x.ag(report({ status: "done" })))).toBe("E_ACCOUNT_LIMIT");
    expect(x.engine.state.intents[0]!.report?.note).toBe(`${MAX_REPORTS - 1}`);
  });
});

describe("an agent's ask", () => {
  it("waits for the owner with the agent's name; asking again replaces it, under a new id; five an hour; a day at most", async () => {
    const x = await account();
    const first = result(await x.ag(ask())).ask as { id: string };
    // asked again, in its place and under a new id: what the owner answers by id is the words they were shown
    const again = result(await x.ag(ask({ usd: "150", text: "make it 150" }))) as { ask: { id: string }; replaced: boolean };
    expect([again.replaced, again.ask.id === first.id]).toEqual([true, false]);
    let page = await x.page();
    expect(page.asks.map((a) => [a.id, a.agentName, a.kind, a.venue, a.usd, a.text])).toEqual([[again.ask.id, "Claude Code", "limit", "ex", "150", "make it 150"]]);
    for (let i = 2; i < ASKS_PER_HOUR; i++) ok(await x.ag(ask({ kind: "session", venue: "", usd: "", text: `${i}` })));
    expect(code(await x.ag(ask({ kind: "mode", venue: "", usd: "" })))).toBe("E_ACCOUNT_LIMIT");
    x.pass(HOUR);
    ok(await x.ag(ask({ kind: "mode", venue: "", usd: "" })));
    page = await x.page();
    expect(page.asks.map((a) => a.kind)).toEqual(["limit", "session", "mode"]);
    x.pass(ASK_TTL_MS);
    expect((await x.page()).asks).toEqual([]);
  });

  it("refuses what it cannot keep: a kind, a venue that is not an id, dollars, words over 280", async () => {
    const x = await account();
    expect(code(await x.ag(ask({ kind: "money" })))).toBe("E_ACCOUNT_BAD_ACTION");
    expect(code(await x.ag(ask({ kind: "venue", venue: "" })))).toBe("E_ACCOUNT_BAD_ACTION");
    expect(code(await x.ag(ask({ venue: "EX!" })))).toBe("E_ACCOUNT_BAD_ACTION");
    expect(code(await x.ag(ask({ usd: "lots" })))).toBe("E_ACCOUNT_BAD_ACTION");
    expect(code(await x.ag(ask({ text: "y".repeat(281) })))).toBe("E_ACCOUNT_BAD_ACTION");
    expect((await x.page()).asks).toEqual([]);
  });

  it("the owner's signed answer closes it: a limit, a venue connected, a session, a leverage cap, a mode, a key let in again", async () => {
    const x = await account();
    ok(await x.own({ type: "approveAgent", agentAddress: codex.address, agentName: "Codex", validUntil: START + 30 * DAY }));
    ok(await x.ag(ask()));
    ok(await x.ag(ask({ kind: "limit" }), codex));
    ok(await x.ag(ask({ kind: "venue", venue: "kraken", usd: "" })));
    ok(await x.ag(ask({ kind: "session", venue: "", usd: "" })));
    ok(await x.ag(ask({ kind: "session", venue: "", usd: "" }), codex));
    ok(await x.ag(ask({ kind: "leverage", venue: "ex", usd: "" })));
    ok(await x.ag(ask({ kind: "letIn", venue: "", usd: "", text: "another month, please" }), codex));
    ok(await x.ag(ask({ kind: "mode", venue: "", usd: "" }), codex));
    const kinds = async () => (await x.page()).asks.map((a) => `${a.agentName}:${a.kind}`);
    ok(await x.own({ type: "approveSpend", agent: cc.address, scope: "trade", allow: "ex", perPayment: "100", budget: "200", windowHours: 0, validUntil: START + 7 * DAY }));
    expect(await kinds()).toEqual(["Codex:limit", "Claude Code:venue", "Claude Code:session", "Codex:session", "Claude Code:leverage", "Codex:letIn", "Codex:mode"]);
    ok(await x.own({ type: "connectVenue", venue: "kraken", connector: "live:standin-steer", label: "Kraken", credentialRef: "" }));
    ok(await x.own({ type: "setPolicy", change: "session", value: "" }));
    ok(await x.own({ type: "setPolicy", change: "maxLeverage", value: "3" }));
    expect(await kinds()).toEqual(["Codex:limit", "Codex:letIn", "Codex:mode"]);
    ok(await x.own({ type: "approveAgent", agentAddress: codex.address, agentName: "Codex", validUntil: START + 60 * DAY }));
    ok(await x.own({ type: "setPolicy", change: "mode", value: "open" }));
    expect(await kinds()).toEqual(["Codex:limit"]);
    // a refused answer closes nothing
    expect(code(await x.own({ type: "approveSpend", agent: codex.address, scope: "trade", allow: "ex", perPayment: "500", budget: "100", windowHours: 0, validUntil: START + 7 * DAY }))).toBe("E_ACCOUNT_BAD_ACTION");
    expect(await kinds()).toEqual(["Codex:limit"]);
  });

  it("an agent wallet made for the agent closes its top-up ask", async () => {
    const x = await run(fresh(), 0, { real: false });
    ok(await x.own({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: START + 30 * DAY }));
    ok(await x.ag(ask({ kind: "topup", venue: "", usd: "20", text: "a float for API calls" })));
    ok(await x.own({ type: "createSubAccount", name: "Ops", agent: cc.address, float: "20" }));
    expect((await x.page()).asks).toEqual([]);
  });

  it("a key nobody let in may ask to be let in: it is remembered under the name it gave, cleaned, with nothing spent and no ask kept", async () => {
    const x = await account();
    const env = await signAgent(stranger, { ...ask({ kind: "letIn", venue: "", usd: "", text: "  Research\u202e bot\n<b>v2</b>  " }), nonce: x.nonce() });
    const r = await x.svc.exchange(env);
    expect([code(r), (r as Refusal).detail]).toEqual(["E_ACCOUNT_UNKNOWN_SIGNER", { signer: stranger.address, asked: "Research bot <b>v2</b>" }]);
    expect(x.engine.state.requests.map((q) => [q.address, q.name])).toEqual([[stranger.address, "Research bot <b>v2</b>"]]);
    expect((await x.page()).asks).toEqual([]);
    // let in under that name: the very same envelope is now an ask of a key on the account — judged as one (its words are not plain text),
    // not as a nonce spent
    ok(await x.own({ type: "approveAgent", agentAddress: stranger.address, agentName: "Research bot <b>v2</b>", validUntil: START + DAY }));
    expect(x.engine.state.requests).toEqual([]);
    expect((refusalOf(await x.svc.exchange(env))).message).toContain("plain text");
    expect(result(await x.ag(ask({ kind: "letIn", venue: "", usd: "", text: "another day, please" }), stranger)).replaced).toBe(false);
    expect(cleanName("x".repeat(100))).toHaveLength(32);
    // a plain knock before keeps its place and takes the name it asks under later
    const other = simKey("agent:other");
    expect(code(await x.ag(ask(), other))).toBe("E_ACCOUNT_UNKNOWN_SIGNER");
    expect(code(await x.ag(ask({ kind: "letIn", venue: "", usd: "", text: "Other" }), other))).toBe("E_ACCOUNT_UNKNOWN_SIGNER");
    expect(x.engine.state.requests.map((q) => q.name)).toEqual(["Other"]);
  });
});

describe("steering is never authority", () => {
  it("none of the four moves money; an intent's dollars and an ask for a limit leave every limit as it was", async () => {
    expect([...STEER_TYPES].filter((t) => MONEY_TYPES.has(t))).toEqual([]);
    const x = await account();
    // no limit yet: an intent for a million and an ask for one make none
    ok(await x.own(intent({ usd: "1000000" })));
    ok(await x.ag(ask({ usd: "1000000" })));
    ok(await x.ag(report({ status: "taking" })));
    expect(code(spendFor(x.engine.state, cc.address, "trade", x.now()) as Refusal)).toBe("E_MANDATE_NONE");
    expect(code(await x.ag({ type: "agentLiveOrder", venue: "ex", symbol: "BTC/USDT", side: "buy", orderType: "limit", qty: "0.001", usd: "", limitPrice: "50000" }))).toBe("E_MANDATE_NONE");
    // with one: the same limit before and after more steering, and an order past its line is still past it
    ok(await x.own({ type: "approveSpend", agent: cc.address, scope: "trade", allow: "ex", perPayment: "10", budget: "20", windowHours: 0, validUntil: START + 7 * DAY }));
    const before = structuredClone(x.engine.state.spends);
    ok(await x.own(intent({ usd: "1000000", text: "go big" })));
    ok(await x.ag(ask({ kind: "limit", usd: "1000000", venue: "ex" })));
    ok(await x.ag(report({ intent: "intent-0003", status: "taking" })));
    expect(x.engine.state.spends).toEqual(before);
    expect(code(await x.ag({ type: "agentLiveOrder", venue: "ex", symbol: "BTC/USDT", side: "buy", orderType: "limit", qty: "0.001", usd: "", limitPrice: "50000" }))).toBe("E_MANDATE_PER_ORDER_CAP");
  });
});

describe("which agent did it", () => {
  it("a card names the agent and the kind of instruction; the order it releases is the agent's on the statement, the owner's is not", async () => {
    const x = await account();
    ok(await x.own({ type: "approveSpend", agent: cc.address, scope: "trade", allow: "ex", perPayment: "100", budget: "200", windowHours: 0, validUntil: START + 7 * DAY }));
    const asked = ok(await x.ag({ type: "agentLiveOrder", venue: "ex", symbol: "BTC/USDT", side: "buy", orderType: "limit", qty: "0.001", usd: "", limitPrice: "50000" }));
    if (asked.kind !== "card") throw new Error(`expected a card, got ${asked.kind}`);
    expect((await x.page()).cards.map((c) => [c.id, c.kind, c.agent, c.agentName])).toEqual([[asked.card.id, "agentLiveOrder", cc.address, "Claude Code"]]);
    ok(await x.own({ type: "approveCard", card: asked.card.id, action: cardHash(asked.card), decision: "approve" }));
    const prepared = await x.engine.prepare({ type: "liveOrder", venue: "ex", symbol: "BTC/USDT", side: "buy", orderType: "limit", qty: "0.001", limitPrice: "49000" });
    if (isRefusal(prepared)) throw new Error(prepared.message);
    ok(await x.svc.exchange(await signOwner(owner, prepared.action)));
    const lines = x.svc.statement();
    expect(lines.map((l) => [l.id, l.agent, l.agentName, l.by])).toEqual([
      ["ord-0002", undefined, undefined, "You"],
      ["ord-0001", cc.address, "Claude Code", "Claude Code, approved by you"],
    ]);
  });

  it("a payment an agent made carries its key and name on its line", () => {
    const p = { id: "pay-0001", kind: "transfer", at: new Date(START).toISOString(), from: "ex", to: "agent-ops", sourceToken: "USDC", token: "USDC", amountUsd: 20, feeUsd: 0, receiveUsd: 20, legs: [], status: "settled", settlesAt: new Date(START).toISOString(), signer: cc.address, authority: "agent", agent: cc.address } as unknown as Payment;
    const line = paymentLine(p, "run", (id) => id, (a) => (a === cc.address ? "Claude Code" : a));
    expect([line.agent, line.agentName, line.by]).toEqual([cc.address, "Claude Code", "Claude Code, inside its limit"]);
    const mine = paymentLine({ ...p, authority: "owner", agent: undefined, signer: owner.address } as Payment, "run", (id) => id, (a) => a);
    expect([mine.agent, mine.agentName, mine.by]).toEqual([undefined, undefined, "You"]);
  });
});

describe("what each venue's trader offers", () => {
  it("is structured, from the connector the owner signed", async () => {
    expect(tradeKinds("live:exchange:okx", "spot and perpetuals")).toEqual(["spot", "perp"]);
    expect(tradeKinds("live:exchange:kraken", "spot and futures")).toEqual(["spot", "future"]);
    expect(tradeKinds("live:exchange:coinbase", "spot")).toEqual(["spot"]);
    expect(tradeKinds("live:alpaca", "US stocks, ETFs and crypto")).toEqual(["stock", "crypto"]);
    expect(tradeKinds("live:kalshi", "event contracts")).toEqual(["event"]);
    // tokens, event contracts and Hyperliquid's perpetuals, all through mm
    expect(tradeKinds("live:metamask", "")).toEqual(["token", "event", "perp"]);
    expect(tradeKinds("live:wallet", "")).toEqual(["token"]);
    expect(tradeKinds("live:somewhere-new", "spot")).toEqual([]);
    const x = await account();
    expect((await x.page()).venues.find((v) => v.id === "ex")!.trade?.kinds).toEqual([]);
  });
});

describe("after a restart", () => {
  it("the watchlist and the intents come back verified, each with its latest report; the asks do not; ids continue", async () => {
    const home = fresh();
    const a = await account(home);
    ok(await a.own({ type: "setWatch", venue: "kraken", symbol: "BTC/USD", on: "true" }));
    ok(await a.own({ type: "setWatch", venue: "ex", symbol: "BTC/USDT", on: "true" }));
    ok(await a.own({ type: "setWatch", venue: "ex", symbol: "BTC/USDT", on: "" }));
    ok(await a.own(intent()));
    ok(await a.own(intent({ agent: "*", text: "withdrawn later" })));
    ok(await a.own(intent({ id: "intent-0002", validUntil: 0 })));
    ok(await a.ag(report({ status: "taking" })));
    ok(await a.ag(report({ status: "done", note: "bought 0.001", refs: "ord-0001" })));
    ok(await a.ag(ask()));
    expect((await a.page()).asks.length).toBe(1);

    const b = await run(home, HOUR);
    expect(b.svc.restored?.skipped).toEqual([]);
    const page = await b.page();
    expect(page.watch.map((w) => `${w.venue} ${w.symbol}`)).toEqual(["kraken BTC/USD"]);
    expect(page.intents.map((i) => [i.id, i.text, i.reports, i.report?.status, i.report?.note, i.report?.byName])).toEqual([["intent-0001", "Buy BTC under 59k this week", 2, "done", "bought 0.001", "Claude Code"]]);
    expect(page.asks).toEqual([]);
    ok(await b.own(intent({ text: "the next one" })));
    expect(b.engine.state.intents.map((i) => i.id)).toEqual(["intent-0001", "intent-0003"]);
  });
});
