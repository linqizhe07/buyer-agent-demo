import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Ledger } from "../../src/agent/ledger.ts";
import { isRefusal, type Refusal } from "../../src/core/errors.ts";
import { no } from "../../src/portfolio/refuse.ts";
import type { Outcome } from "../../src/portfolio/account/exchange.ts";
import type { LiveOrder } from "../../src/portfolio/account/live-orders.ts";
import { signAgent, signDevice, signOwner, simKey, type AgentAction, type Envelope, type OwnerAction } from "../../src/portfolio/account/sign.ts";
import { agentStatus } from "../../src/portfolio/account/state.ts";
import { register, type LiveDeps } from "../../src/portfolio/live/index.ts";
import type { LiveTrader, Market, OrderState } from "../../src/portfolio/live/trade.ts";
import { PortfolioService } from "../../src/portfolio/service.ts";

/** The account after a restart: rebuilt from its own ledgers — the owner's device, the venues, the agents, their limits and what they used,
 * the dial, what was in flight — with every owner signature checked again, and nothing older than the chain, or forged into it, brought back. */
type NoNonce<T> = T extends unknown ? Omit<T, "nonce"> : never;
const START = Date.parse("2026-10-05T14:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));
const owner = simKey("owner");
const browser = simKey("device:owner-browser");
const cc = simKey("agent:claude-code");
const intruder = simKey("agent:intruder");

const BTC: Market = { symbol: "BTC/USDT", name: "BTC/USDT", kind: "spot", base: "BTC", quote: "USDT", price: 60_000, bid: 59_990, ask: 60_010, minQty: 0.0001, qtyStep: 0.0001, priceStep: 0.1, open: true, types: ["market", "limit"] };
/** one venue that outlives the runs: what it was asked to place in the first run, it still knows in the second */
const venue = { placed: 0, states: new Map<string, OrderState>(), connects: 0 };
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
    const ref = `r-${++venue.placed}`;
    const s: OrderState = o.type === "market" ? { ref, status: "filled", filledQty: o.qty, avgPrice: 60_010, native: {} } : { ref, status: "open", filledQty: 0, native: {} };
    venue.states.set(ref, s);
    return s;
  },
  async cancel(ref) {
    const s = { ...venue.states.get(ref)!, status: "canceled" as const };
    venue.states.set(ref, s);
    return s;
  },
  async status(ref) {
    return venue.states.get(ref)!;
  },
};
register({ kind: "standin-restore", label: "a venue that trades", needs: "key-file", example: "", venues: [], async open(req) {
  venue.connects++;
  return { source: { name: req.label || "Stand-in", kind: "cex", reference: "standin", via: "a stand-in", probe: { can: ["read", "trade"], note: "" }, read: async () => [{ asset: "USDT", amount: 500, usd: 500 }], trader, readOnlyBecause: "the stand-in moves no money" }, first: [{ asset: "USDT", amount: 500, usd: 500 }], summary: "connected" };
} });

/** one run of the account on `home`, `at` ms after the start (each run has a ledger file of its own) */
async function run(home: string, at: number, o: { seedOwner?: boolean; fresh?: boolean } = {}) {
  let real = 5_000_000 + at;
  let n = 0;
  const liveDeps: Partial<LiveDeps> = { clock: () => real, http: async () => ({ status: 599, body: undefined, text: "" }), price: async () => undefined };
  const svc = await PortfolioService.create({ home, now: () => new Date(START + at).toISOString(), venues: "frontline", real: true, liveDeps, liveWrites: { capUsd: 100, pairingCode: "K7QX-M2PA" }, fresh: o.fresh === true, ...(o.seedOwner ? { account: { owners: [{ id: owner.address, kind: "eoa" as const, label: "owner", addedAt: new Date(START).toISOString() }] } } : {}) });
  await svc.restoring;
  const engine = svc.account!;
  const nonce = () => START + at + ++n;
  /** the owner signs with the browser's device key (paired) or, when the run was seeded with one, the owner's address */
  const own = async (a: NoNonce<OwnerAction>) => {
    const action = { ...a, nonce: nonce() } as OwnerAction;
    const envelope: Envelope = o.seedOwner ? await signOwner(owner, action) : { action, nonce: action.nonce, signature: signDevice(browser, action) };
    return svc.exchange(envelope);
  };
  const ag = async (a: NoNonce<AgentAction>, key = cc) => svc.exchange(await signAgent(key, { ...a, nonce: nonce() } as AgentAction));
  const trade = () => engine.state.spends.find((s) => s.scope === "trade" && s.revokedAt === undefined);
  return { svc, engine, own, ag, trade, now: () => START + at, tick: (ms: number) => (real += ms) };
}

const fresh = () => {
  const h = mkdtempSync(join(tmpdir(), "account-restore-"));
  homes.push(h);
  return h;
};
const ok = (o: Outcome | Refusal) => {
  if (isRefusal(o)) throw new Error(`${o.code}: ${o.message}`);
  return o;
};
const placed = (o: Outcome | Refusal): LiveOrder => {
  const x = ok(o);
  if (x.kind !== "order") throw new Error(`expected an order, got ${x.kind}`);
  return x.order;
};
const ledgers = (home: string) => readdirSync(join(home, "portfolio")).filter((f) => f.startsWith("ledger-")).sort();
const order = { type: "agentLiveOrder" as const, venue: "ex", symbol: "BTC/USDT", side: "buy", orderType: "limit", qty: "0.0005", usd: "", limitPrice: "50000" };

describe("the account after a restart", () => {
  it("is the account it was: the owner's browser, the venue, the agent, its limit and what it used, Beast, the open order", async () => {
    const home = fresh();
    const a = await run(home, 0);
    expect(a.engine.pairDevice(browser.jwk, "this browser", "K7QX-M2PA")).toMatchObject({ role: "owner" });
    ok(await a.own({ type: "connectVenue", venue: "ex", connector: "live:standin-restore", label: "Stand-in", credentialRef: "" }));
    ok(await a.own({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: START + 30 * DAY }));
    ok(await a.own({ type: "approveSpend", agent: cc.address, scope: "trade", allow: "*", perPayment: "50", budget: "100", windowHours: 0, validUntil: START + 7 * DAY }));
    ok(await a.own({ type: "setPolicy", change: "mode", value: "open" }));
    const resting = placed(await a.ag(order));
    expect([resting.id, resting.status, a.trade()!.spentMicro]).toEqual(["ord-0001", "open", 25_000_000]);

    const b = await run(home, HOUR);
    expect(b.svc.restored).toMatchObject({ runs: 1, owner: true, agents: 1, limits: 1, mode: "Beast", venues: [{ venue: "ex", ok: true }], orders: 1, payments: 0, skipped: [], state: "done" });
    // the same browser is the owner without a code; another one waits to be added
    expect(b.engine.pairDevice(browser.jwk)).toMatchObject({ role: "owner" });
    expect(b.engine.pairDevice(simKey("device:another").jwk)).toMatchObject({ role: "pending" });
    expect(agentStatus(b.engine.state, cc.address, b.now())).toBe("ok");
    // the limit over "every venue" is the same list it was, and what it had used is still used
    expect([b.trade()!.allow, b.trade()!.spentMicro]).toEqual([["ex"], 25_000_000]);
    expect(b.svc.policy().mode).toBe("open");
    expect(venue.connects).toBe(2);
    // the order is followed again under its own id, and the agent that placed it can still take it off the book
    expect(b.engine.orders.map((o) => [o.id, o.status, o.clientId])).toEqual([["ord-0001", "open", resting.clientId]]);
    expect(b.svc.statement().map((l) => [l.id, l.status])).toEqual([["ord-0001", "open"]]);
    const off = placed(await b.ag({ type: "agentLiveCancel", venue: "ex", order: "ord-0001" }));
    expect([off.status, b.trade()!.spentMicro]).toEqual(["canceled", 0]);
    // the next order is a new id, not the first run's again
    expect(placed(await b.ag(order)).id).toBe("ord-0002");

    // and a third run continues the second, which continued the first
    const c = await run(home, 2 * HOUR);
    expect(c.svc.restored).toMatchObject({ runs: 2, agents: 1, orders: 1, mode: "Beast" });
    expect(c.engine.orders.map((o) => o.id)).toEqual(["ord-0002"]);
    expect(c.svc.verifyChain().ok).toBe(true);
  });

  it("checks every signature again: a row forged into the ledger, or a dial said to be open without the owner's signature, is not brought back", async () => {
    const home = fresh();
    const a = await run(home, 0, { seedOwner: true });
    ok(await a.own({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: START + 30 * DAY }));
    const file = join(home, "portfolio", ledgers(home)[0]!);
    // someone who can write to the file appends rows that hash correctly: an agent "approved" by a key that is not the owner's, and an open dial
    const forged = { type: "approveAgent", agentAddress: intruder.address, agentName: "Intruder", validUntil: START + 30 * DAY, nonce: START + 999 } as OwnerAction;
    const tamper = new Ledger(file, () => new Date(START + 60_000).toISOString());
    tamper.append({ kind: "action", venue: "*", tool: "approveAgent", signer: intruder.address, envelope: await signOwner(intruder, forged), outcome: "ok", reason: "forged" });
    tamper.append({ kind: "note", venue: "*", reason: "mode → open", detail: { dial: { mode: "open", revoked: [], reach: {} } } });

    const b = await run(home, HOUR, { seedOwner: true });
    expect(agentStatus(b.engine.state, cc.address, b.now())).toBe("ok");
    expect(agentStatus(b.engine.state, intruder.address, b.now())).toBe("unknown");
    expect(b.svc.policy().mode).toBe("guard");
    expect((b.svc.restored as { skipped: string[] }).skipped).toEqual([
      "approveAgent of 2026-10-05T14:01:00.000Z: its signature does not check out against the account's owners",
      "the dial was open, and the owner's signature that opened it is not in the chain: it starts Guard",
    ]);
  });

  it("a ledger whose hash chain breaks is read up to the break, and nothing after it comes back", async () => {
    const home = fresh();
    const a = await run(home, 0, { seedOwner: true });
    ok(await a.own({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: START + 30 * DAY }));
    ok(await a.own({ type: "approveSpend", agent: cc.address, scope: "trade", allow: "ex", perPayment: "50", budget: "100", windowHours: 0, validUntil: START + 7 * DAY }));
    const file = join(home, "portfolio", ledgers(home)[0]!);
    // the limit's row is edited after the fact (a bigger budget): its hash no longer matches
    const rows = readFileSync(file, "utf8").trim().split("\n");
    const i = rows.findIndex((r) => r.includes('"tool":"approveSpend"'));
    rows[i] = rows[i]!.replace('"budget":"100"', '"budget":"9999"');
    writeFileSync(file, `${rows.join("\n")}\n`);

    const b = await run(home, HOUR, { seedOwner: true });
    expect(agentStatus(b.engine.state, cc.address, b.now())).toBe("ok");
    expect(b.trade()).toBeUndefined();
    expect((b.svc.restored as { skipped: string[] }).skipped[0]).toMatch(/its hash chain breaks at row \d+/);
  });

  it("brings back nothing from before the chain: a ledger an older version wrote, or a --fresh start", async () => {
    const home = fresh();
    const a = await run(home, 0, { seedOwner: true });
    ok(await a.own({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: START + 30 * DAY }));
    // --fresh: the agent the owner let in before is not let in now
    const b = await run(home, HOUR, { seedOwner: true, fresh: true });
    expect([b.svc.restored, agentStatus(b.engine.state, cc.address, b.now())]).toEqual([undefined, "unknown"]);
    // and the run after a fresh one continues the fresh one, not what came before it
    const c = await run(home, 2 * HOUR, { seedOwner: true });
    expect([c.svc.restored?.runs, agentStatus(c.engine.state, cc.address, c.now())]).toEqual([1, "unknown"]);

    // a file with no run mark (written before the account kept its runs) is never read back, however valid its signatures
    const old = fresh();
    const legacy = new Ledger(join(old, "portfolio", "ledger-2026-10-01T00-00-00-000Z.jsonl"), () => "2026-10-01T00:00:00.000Z");
    const approve = { type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: START + 30 * DAY, nonce: START - 4 * DAY } as OwnerAction;
    legacy.append({ kind: "action", venue: "*", tool: "approveAgent", signer: owner.address, envelope: await signOwner(owner, approve), outcome: "ok", reason: "before" });
    const d = await run(old, 0, { seedOwner: true });
    expect([d.svc.restored, agentStatus(d.engine.state, cc.address, d.now())]).toEqual([undefined, "unknown"]);
  });

  it("what the owner closed stays closed: a revoked key, an ended session — until the owner signs it open again", async () => {
    const home = fresh();
    const a = await run(home, 0, { seedOwner: true });
    ok(await a.own({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: START + 30 * DAY }));
    ok(await a.own({ type: "approveAgent", agentAddress: "0x0000000000000000000000000000000000000000", agentName: "Claude Code", validUntil: START + 30 * DAY }));
    a.svc.revokeAll();
    const b = await run(home, HOUR, { seedOwner: true });
    expect(agentStatus(b.engine.state, cc.address, b.now())).toBe("revoked");
    expect(Date.parse(b.svc.policy().sessionExpiresAt!)).toBeLessThanOrEqual(START + HOUR);
    // a revoked key is never let in again, after a restart as before it
    expect(refusalOf(await b.own({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: START + 30 * DAY })).code).toBe("E_ACCOUNT_LIMIT");
    ok(await b.own({ type: "setPolicy", change: "session", value: "30d" }));
    const c = await run(home, 2 * HOUR, { seedOwner: true });
    // the session the owner signed open is not ended again by the restart
    expect(Date.parse(c.svc.policy().sessionExpiresAt!)).toBeGreaterThan(START + 2 * HOUR);
  });
});

const refusalOf = (o: Outcome | Refusal): Refusal => {
  if (!isRefusal(o)) throw new Error(`expected a refusal, got ${o.kind}`);
  return o;
};
