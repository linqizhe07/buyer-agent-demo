/** ATTACKS THAT MUST FAIL (found by an independent review on 2026-10-05, against the account's restore after a restart): each test below
 * is the attack as it went through then, and asserts that it no longer does.
 *
 *   R1  a second device added, then a stolen one removed: the restart put the stolen one back as the owner, and revoked agents with it
 *   R2  an owner let in without a code (a read-only run) owned the trading account after a restart
 *   R3  an ended session came back after a restart; any restart lengthened a session
 *   R4  an owner's real-money move, signed once, ran again after a restart (its envelope was not on the record)
 *   R8  one instruction skipped on restore shifted every later limit's id: usage landed on the wrong limit
 *   R13 a signed row copied in again was taken again (Beast re-opened); an unsigned dial row raised the agents' leverage
 *   R14 the newest run was the newest file NAME: after the clock was set back, later runs were left out of the restore */
import { chmodSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Ledger } from "../../src/agent/ledger.ts";
import { isRefusal } from "../../src/core/errors.ts";
import { kidOf, signOwner, simKey, type OwnerAction } from "../../src/portfolio/account/sign.ts";
import { agentStatus } from "../../src/portfolio/account/state.ts";
import { register } from "../../src/portfolio/live/index.ts";
import type { ChainReader } from "../../src/portfolio/live/chain.ts";
import type { LiveWriter } from "../../src/portfolio/live/writes.ts";
import { loadOpenness } from "../../src/portfolio/service.ts";
import { browser, cc, CODE, codeOf, DAY, fresh, HOUR, laptop, ok, owner, run, START } from "./account-runs.ts";

const ZERO = "0x0000000000000000000000000000000000000000";
const dev = (k: { jwk: Parameters<typeof kidOf>[0] }) => `device:${kidOf(k.jwk)}`;
const ledgers = (home: string) => readdirSync(join(home, "portfolio")).filter((f) => /^ledger-.*\.jsonl$/.test(f)).sort();

describe("R1 · a change of signers survives a restart", () => {
  it("the browser lets the laptop in, the laptop removes the (stolen) browser and revokes the agent: after a restart it is still so", async () => {
    const home = fresh();
    const a = await run(home, 0);
    expect(a.engine.pairDevice(browser.jwk, "browser", CODE)).toMatchObject({ role: "owner" });
    ok(await a.own({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: START + 30 * DAY }));
    expect(a.engine.pairDevice(laptop.jwk, "laptop")).toMatchObject({ role: "pending" });
    const both = [dev(browser), dev(laptop)].sort();
    ok(await a.own({ type: "convertToMultiSigUser", signers: JSON.stringify({ authorizedUsers: both, threshold: 1 }) }));
    ok(await a.own({ type: "convertToMultiSigUser", signers: JSON.stringify({ authorizedUsers: [dev(laptop)], threshold: 1 }) }, laptop));
    ok(await a.own({ type: "approveAgent", agentAddress: ZERO, agentName: "Claude Code", validUntil: 0 }, laptop));
    expect(agentStatus(a.engine.state, cc.address, a.now())).not.toBe("ok");

    const b = await run(home, HOUR);
    expect(b.engine.state.owners.map((o) => o.id)).toEqual([dev(laptop)]);
    expect(agentStatus(b.engine.state, cc.address, b.now())).not.toBe("ok");
    expect(b.engine.pairDevice(browser.jwk, "browser", CODE)).toMatchObject({ role: "pending" });
    expect(b.engine.pairDevice(laptop.jwk, "laptop")).toMatchObject({ role: "owner" });
    expect(b.svc.restored?.skipped).toEqual([]);
  });

  it("a 2-of-2 account comes back 2-of-2: one device alone signs nothing", async () => {
    const home = fresh();
    const a = await run(home, 0);
    a.engine.pairDevice(browser.jwk, "browser", CODE);
    a.engine.pairDevice(laptop.jwk, "laptop");
    ok(await a.own({ type: "convertToMultiSigUser", signers: JSON.stringify({ authorizedUsers: [dev(browser), dev(laptop)].sort(), threshold: 2 }) }));
    const b = await run(home, HOUR);
    expect([b.engine.state.owners.length, b.engine.state.threshold]).toEqual([2, 2]);
    expect(codeOf(await b.own({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: START + 30 * DAY }))).toBe("E_ACCOUNT_THRESHOLD");
    ok(await b.own({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: START + 30 * DAY }, browser, [laptop]));
  });

  it("devices waiting to be let in are capped, and those of an earlier run do not come back unless a signed change named them", async () => {
    const home = fresh();
    const a = await run(home, 0);
    a.engine.pairDevice(browser.jwk, "browser", CODE);
    for (let i = 0; i < 10; i++) expect(a.engine.pairDevice(simKey(`device:asker-${i}`).jwk, "asker")).toMatchObject({ role: "pending" });
    expect(codeOf(a.engine.pairDevice(simKey("device:asker-10").jwk, "asker") as never)).toBe("E_ACCOUNT_OWNER_SURFACE");
    const b = await run(home, HOUR);
    expect(b.engine.state.pendingDevices).toEqual([]);
  });
});

describe("R2 · an owner let in without the pairing code does not own a run that asks for one", () => {
  it("first come in a read-only run without a code; the trading run that follows asks the owner to pair with its code", async () => {
    const home = fresh();
    const squatter = simKey("device:local-process");
    const a = await run(home, 0, { readOnly: true });
    expect(a.engine.pairDevice(squatter.jwk, "curl")).toMatchObject({ role: "owner" });
    const b = await run(home, HOUR);
    expect(b.svc.restored?.owner).toBe(false);
    expect(b.svc.restored?.skipped.join(" ")).toContain("paired without a pairing code");
    expect(codeOf(await b.own({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: START + 30 * DAY }, squatter))).toBe("E_ACCOUNT_BAD_SIGNATURE");
    expect(b.engine.pairDevice(browser.jwk, "my browser", CODE)).toMatchObject({ role: "owner" });
  });

  it("a read-only run asks for its code too, and an owner paired with it comes back", async () => {
    const home = fresh();
    const a = await run(home, 0, { readOnly: true, readOnlyCode: true });
    expect(a.engine.pairDevice(browser.jwk, "browser")).toMatchObject({ role: "needs-code" });
    expect(a.engine.pairDevice(browser.jwk, "browser", CODE)).toMatchObject({ role: "owner" });
    const b = await run(home, HOUR);
    expect(b.svc.restored?.owner).toBe(true);
  });
});

describe("R3 · the agents' session after a restart", () => {
  const openness = (until: number) => ({ ...(loadOpenness() as object), sessionExpiresAt: new Date(until).toISOString() });

  it("an ended session stays ended, whatever was tightened after it", async () => {
    const home = fresh();
    const a = await run(home, 0, { seedOwner: true, extra: { openness: openness(START + 30 * DAY) } as never });
    a.svc.revokeAll();
    a.svc.setMode("guard");
    a.svc.revoke("somewhere");
    const b = await run(home, HOUR, { seedOwner: true, extra: { openness: openness(START + HOUR + 30 * DAY) } as never });
    expect(Date.parse(b.svc.policy().sessionExpiresAt!)).toBeLessThanOrEqual(START + HOUR);
  });

  it("a restart does not lengthen a session: it keeps the one the account started with", async () => {
    const home = fresh();
    await run(home, 0, { seedOwner: true, extra: { openness: openness(START + 5 * DAY) } as never });
    const b = await run(home, HOUR, { seedOwner: true, extra: { openness: openness(START + HOUR + 30 * DAY) } as never });
    expect(b.svc.policy().sessionExpiresAt).toBe(new Date(START + 5 * DAY).toISOString());
  });
});

describe("R4 · a signed real-money move runs once, across restarts too", () => {
  const withdrawals: Array<{ amount: number; clientId: string }> = [];
  const writer = (addr: `0x${string}`): LiveWriter => ({
    can: { withdraw: true, ledgers: [], transfer: false, swap: false, receive: true, send: false },
    async depositAddress() {
      return { address: addr };
    },
    async withdrawFee() {
      return 0.5;
    },
    async withdraw(r) {
      withdrawals.push({ amount: r.amount, clientId: r.clientId });
      return { ref: `w-${withdrawals.length}`, status: "pending", native: {} };
    },
    async landed() {
      return "pending";
    },
  });
  register({ kind: "standin-writer-r4", label: "an exchange that withdraws", needs: "key-file", example: "", venues: [], async open(req) {
    const addr = (req.venue === "dst" ? "0x00000000000000000000000000000000000000d5" : "0x00000000000000000000000000000000000000a1") as `0x${string}`;
    return { source: { name: req.label || req.venue, kind: "cex", reference: "standin", via: "a stand-in exchange", probe: { can: ["read", "withdraw"], note: "" }, read: async () => [{ asset: "USDC", amount: 1000, usd: 1000 }], writer: writer(addr) }, first: [{ asset: "USDC", amount: 1000, usd: 1000 }], summary: "connected" };
  } });

  it("the same envelope after a restart two minutes later is refused, and the withdrawal ids of two runs differ", async () => {
    const home = fresh();
    const a = await run(home, 0, { seedOwner: true });
    ok(await a.own({ type: "connectVenue", venue: "src", connector: "live:standin-writer-r4", label: "Source", credentialRef: "" }));
    ok(await a.own({ type: "connectVenue", venue: "dst", connector: "live:standin-writer-r4", label: "Destination", credentialRef: "" }));
    const prepared = await a.engine.prepare({ type: "liveMove", kind: "withdraw", from: "src", to: "dst", asset: "USDC", network: "Base", amount: "50" });
    if (isRefusal(prepared)) throw new Error(prepared.message);
    const envelope = await signOwner(owner, { ...prepared.action, nonce: START + 10 } as OwnerAction);
    ok(await a.svc.exchange(envelope));
    const b = await run(home, 2 * 60_000, { seedOwner: true });
    expect(codeOf(await b.svc.exchange(envelope))).toBe("E_ACCOUNT_NONCE");
    expect(withdrawals.length).toBe(1);
    // a new move in the second run: a payment id the first run may have used too, so the exchange's key carries the run as well
    const again = await b.engine.prepare({ type: "liveMove", kind: "withdraw", from: "src", to: "dst", asset: "USDC", network: "Base", amount: "5" });
    if (isRefusal(again)) throw new Error(again.message);
    ok(await b.svc.exchange(await signOwner(owner, { ...again.action, nonce: START + 2 * 60_000 + 10 } as OwnerAction)));
    expect(withdrawals.length).toBe(2);
    expect(withdrawals[0]!.clientId).not.toBe(withdrawals[1]!.clientId);
  });
});

describe("R8 · a skipped instruction does not shift the ids after it", () => {
  const chain: ChainReader = { async tokens() { return { rows: [], failed: [] }; }, async native() { return { rows: [], failed: [] }; }, async uint() { return undefined; }, async decimals() { return 6; }, async receipt() { return undefined; } };
  const other = simKey("agent:other");

  it("an agent wallet's key file loses its 0600 mode: the wallet is not brought back, and the next limit keeps its id and what it spent", async () => {
    const home = fresh();
    const deps = { extra: { liveDeps: { chain } } };
    const a = await run(home, 0, { seedOwner: true, cap: 1000, ...deps });
    ok(await a.own({ type: "connectVenue", venue: "ex", connector: "live:standin-attack", label: "Ex", credentialRef: "" }));
    ok(await a.own({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: START + 30 * DAY }));
    ok(await a.own({ type: "approveAgent", agentAddress: other.address, agentName: "Other", validUntil: START + 30 * DAY }));
    ok(await a.own({ type: "createSubAccount", name: "ops", agent: other.address, float: "50" }));
    ok(await a.own({ type: "approveSpend", agent: cc.address, scope: "trade", allow: "ex", perPayment: "100", budget: "100", windowHours: 0, validUntil: START + 7 * DAY }));
    ok(await a.own({ type: "setPolicy", change: "mode", value: "open" }));
    ok(await a.ag({ type: "agentLiveOrder", venue: "ex", symbol: "BTC/USDT", side: "buy", orderType: "limit", qty: "0.0018", usd: "", limitPrice: "50000" }));
    const id = a.trade()!.id;
    chmodSync(join(home, "agent-wallets", "ops.json"), 0o644);

    const b = await run(home, HOUR, { seedOwner: true, cap: 1000, ...deps });
    expect(b.svc.restored?.skipped.join(" ")).toContain("createSubAccount");
    expect([b.trade()!.id, b.trade()!.spentMicro]).toEqual([id, 90_000_000]);
    expect(codeOf(await b.ag({ type: "agentLiveOrder", venue: "ex", symbol: "BTC/USDT", side: "buy", orderType: "limit", qty: "0.0018", usd: "", limitPrice: "50000" }))).toBe("E_MANDATE_BUDGET");
  });
});

describe("R13 · rows written into the ledger", () => {
  it("a signed row copied in again is taken once: the owner's Guard stands", async () => {
    const home = fresh();
    const a = await run(home, 0, { seedOwner: true });
    ok(await a.own({ type: "setPolicy", change: "mode", value: "open" }));
    a.svc.setMode("guard");
    const file = join(home, "portfolio", ledgers(home).at(-1)!);
    const opened = new Ledger(file, () => new Date(START).toISOString()).all().find((r) => r.kind === "action" && r.outcome === "ok" && (r.envelope as { action?: { type?: string } } | undefined)?.action?.type === "setPolicy")!;
    const { seq: _s, hash: _h, prev: _p, ...copy } = opened as unknown as Record<string, unknown>;
    new Ledger(file, () => new Date(START + 1000).toISOString()).append(copy as never);
    const b = await run(home, HOUR, { seedOwner: true });
    expect(b.svc.policy().mode).toBe("guard");
    expect(b.svc.restored?.skipped.join(" ")).toContain("the same signed instruction a second time");
  });

  it("a dial row cannot give agents more leverage than the owner signed for", async () => {
    const home = fresh();
    await run(home, 0, { seedOwner: true });
    const file = join(home, "portfolio", ledgers(home).at(-1)!);
    new Ledger(file, () => new Date(START + 1000).toISOString()).append({ kind: "note", venue: "*", reason: "agents may set leverage up to 50x", detail: { dial: { mode: "guard", revoked: [], reach: {}, maxLeverage: 50 } } });
    const b = await run(home, HOUR, { seedOwner: true });
    expect(b.svc.policy().maxLeverage ?? 1).toBe(1);
  });
});

describe("R14 · the newest run is the highest run number, not the newest file name", () => {
  it("a run while the clock was a day ahead, then the clock is corrected and the agent revoked: the next restart keeps it revoked", async () => {
    const home = fresh();
    const ahead = await run(home, DAY, { seedOwner: true });
    ok(await ahead.own({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: START + 30 * DAY }));
    const b = await run(home, HOUR, { seedOwner: true });
    ok(await b.own({ type: "approveAgent", agentAddress: ZERO, agentName: "Claude Code", validUntil: 0 }));
    const c = await run(home, 2 * HOUR, { seedOwner: true });
    expect(agentStatus(c.engine.state, cc.address, c.now())).not.toBe("ok");
    expect(c.svc.restored?.runs).toBe(2);
  });
});
