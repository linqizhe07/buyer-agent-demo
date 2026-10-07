/** review2 · the account lens, the pure parts: each test asserts what SHOULD hold; where one failed, that was the finding (the review's
 * REPORT.md names it by its number here). The fix round made each hold, and added U5 for the field it introduced.
 *
 *   U1  `micro` answers NaN, not Infinity, for a number too long for a double: a budget of 10^400 is refused, never kept as one that is never used up
 *   U2  a key file's refusal names the key, not the file's path: the home folder's path does not leave the account in a refusal's words
 *   U3  a sub-account's name is held to plain text, and its length is counted in characters
 *   U4  a leverage change is a money instruction: signed once, it is good for ten minutes, not the two days of the nonce window
 *   U5  a spending approval may name the intent it answers: signed with the rest when given, absent from the signature when not, held to
 *       an open intent addressed to the agent, replayed by a restart — and an approval signed before the field existed still verifies
 */
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Ledger } from "../../src/agent/ledger.ts";
import { isRefusal } from "../../src/core/errors.ts";
import { loadOrCreateKey } from "../../src/portfolio/account/keystore.ts";
import { rebuild } from "../../src/portfolio/account/restore.ts";
import { actionHash, malformed, micro, MONEY_TYPES, shownFields, signOwner, simKey, type Hex, type OwnerAction } from "../../src/portfolio/account/sign.ts";
import { applyOwner, charCount, emptyState, isPlain, type AccountState } from "../../src/portfolio/account/state.ts";

type NoNonce<T> = T extends unknown ? Omit<T, "nonce"> : never;
const START = Date.parse("2026-10-06T09:00:00.000Z");
const DAY = 86_400_000;
const owner = simKey("owner");
const cc = simKey("agent:claude-code");
const other = simKey("agent:codex");
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** an account with one agent let in, and a way to apply one more owner action to it (or several, one after the other) */
async function withAgent(): Promise<{ state: AccountState; apply: (a: NoNonce<OwnerAction>) => Promise<AccountState | import("../../src/core/errors.ts").Refusal>; chain: (...actions: NoNonce<OwnerAction>[]) => Promise<AccountState | import("../../src/core/errors.ts").Refusal> }> {
  let n = 0;
  const sign = async (a: NoNonce<OwnerAction>) => {
    const action = { ...a, nonce: START + ++n } as OwnerAction;
    return { action, envelope: await signOwner(owner, action) };
  };
  const first = await sign({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: START + 30 * DAY });
  const state = applyOwner(emptyState(), first.action, first.envelope, START);
  if (isRefusal(state)) throw new Error(state.message);
  const applyTo = async (s: AccountState, a: NoNonce<OwnerAction>) => {
    const x = await sign(a);
    return applyOwner(s, x.action, x.envelope, START, ["ex"], { anyPayee: true, walletAddress: () => `0x${"1".repeat(40)}` as Hex });
  };
  return {
    state,
    apply: (a) => applyTo(state, a),
    chain: async (...actions) => {
      let s: AccountState | import("../../src/core/errors.ts").Refusal = state;
      for (const a of actions) {
        if (isRefusal(s)) return s;
        s = await applyTo(s, a);
      }
      return s;
    },
  };
}

describe("U1 · amounts too long for a double", () => {
  it("micro refuses them (NaN), as it refuses a fraction with 19 places", () => {
    expect(Number.isNaN(micro(`1${"0".repeat(400)}`))).toBe(true);
    // fifteen whole digits is the line; past the safe integers in millionths is NaN too, and ordinary amounts are untouched
    expect([micro("9007199254"), Number.isNaN(micro("9007199255")), Number.isNaN(micro("1234567890123456"))]).toEqual([9_007_199_254_000_000, true, true]);
  });

  it("a spending approval with such a budget is refused, not kept as a budget that is never used up", async () => {
    const x = await withAgent();
    const next = await x.apply({ type: "approveSpend", agent: cc.address, scope: "trade", allow: "ex", perPayment: "100", budget: `1${"0".repeat(400)}`, windowHours: 0, validUntil: START + 7 * DAY });
    expect(isRefusal(next) ? next.code : (next as AccountState).spends.map((s) => [s.budgetMicro, JSON.stringify(s.budgetMicro)])).toBe("E_ACCOUNT_BAD_ACTION");
  });
});

describe("U2 · what a key file's refusal says", () => {
  it("names the key, not the path of the file in the home folder; the path travels in detail", () => {
    const dir = mkdtempSync(join(tmpdir(), "review2-keys-"));
    dirs.push(dir);
    const path = join(dir, "seats", "codex.json");
    const made = loadOrCreateKey(path, "seat", "codex");
    if (isRefusal(made)) throw new Error(made.message);
    chmodSync(path, 0o644);
    const r = loadOrCreateKey(path, "seat", "codex");
    if (!isRefusal(r)) throw new Error("a world-readable key file was accepted");
    expect(r.code).toBe("E_ACCOUNT_CREDENTIAL");
    expect(r.message).not.toContain(dir);
    expect(r.message).toBe('the key file of the agent seat "codex" can be read by other users of this machine (mode 644): make it the user\'s alone (chmod 600) before it is used');
    expect(r.detail).toEqual({ path, mode: "644" });
  });
});

describe("U3 · a sub-account's name", () => {
  it("is plain text, like an agent key's name: a zero-width space in it is refused", async () => {
    const x = await withAgent();
    const name = "Ops​";
    expect(isPlain(name)).toBe(false);
    const next = await x.apply({ type: "createSubAccount", name, agent: cc.address, float: "10" });
    expect(isRefusal(next) ? next.code : (next as AccountState).subAccounts.map((s) => JSON.stringify(s.name))).toBe("E_ACCOUNT_BAD_ACTION");
  });

  it("is counted in characters, as an agent key's name is: nine characters are not seventeen", async () => {
    const x = await withAgent();
    const name = `A${"🅰".repeat(8)}`;
    expect([charCount(name), name.length]).toEqual([9, 17]);
    const next = await x.apply({ type: "createSubAccount", name, agent: cc.address, float: "10" });
    expect(isRefusal(next) ? `${next.code}: ${next.message}` : "kept").toBe("kept");
  });

  it("and so is a destination's label", async () => {
    const x = await withAgent();
    const next = await x.apply({ type: "setDestination", label: "cold​", address: `0x${"a".repeat(40)}`, chain: "Base", token: "USDC" });
    expect(isRefusal(next) ? next.message : "kept").toBe("a destination's label is plain text: no control, line-break, invisible, zero-width or direction-changing characters");
  });
});

describe("U4 · what is good for ten minutes", () => {
  it("a leverage change, like an order: it changes what the position risks", () => {
    expect([...MONEY_TYPES].filter((t) => /leverage/i.test(t)).sort()).toEqual(["agentLiveLeverage", "liveLeverage"]);
  });
});

describe("U5 · a limit that answers an intent", () => {
  const limit = { type: "approveSpend" as const, agent: cc.address, scope: "trade", allow: "ex", perPayment: "100", budget: "100", windowHours: 0, validUntil: START + 7 * DAY };
  const intentFor = (agent: string) => ({ type: "setIntent" as const, id: "", agent, venue: "ex", symbol: "BTC/USDT", side: "buy" as const, usd: "100", text: "buy the dip", validUntil: START + 7 * DAY });

  it("signs the intent's id with the rest when it is given, and nothing more when it is not: a limit without one hashes as it always has", () => {
    const plain = { ...limit, nonce: START + 1 } as OwnerAction;
    const tied = { ...limit, intent: "intent-0002", nonce: START + 1 } as OwnerAction;
    expect(shownFields(plain).map((f) => f.name)).toEqual(["agent", "scope", "allow", "perPayment", "budget", "windowHours", "validUntil", "nonce"]);
    expect(shownFields(tied).map((f) => f.name)).toEqual(["agent", "scope", "allow", "perPayment", "budget", "windowHours", "validUntil", "intent", "nonce"]);
    expect(actionHash(tied)).not.toBe(actionHash(plain));
    expect([malformed(plain), malformed(tied), malformed({ ...limit, intent: 7, nonce: START + 1 } as unknown as OwnerAction)]).toEqual([null, null, '"intent" is text']);
  });

  it("is held to an open intent addressed to this agent, or to every agent", async () => {
    const none = await (await withAgent()).apply({ ...limit, intent: "intent-0001" });
    expect(isRefusal(none) ? none.message : "kept").toBe('there is no open intent "intent-0001" addressed to this agent: a limit answers an intent the owner set for the agent (or for every agent), or names none');
    const mine = await (await withAgent()).chain(intentFor(cc.address), { ...limit, intent: "intent-0001" });
    expect(isRefusal(mine) ? mine.message : mine.spends.map((s) => [s.id, s.intent])).toEqual([["spend-0002", "intent-0001"]]);
    const everyone = await (await withAgent()).chain(intentFor("*"), { ...limit, intent: " intent-0001 " });
    expect(isRefusal(everyone) ? everyone.message : everyone.spends.map((s) => s.intent)).toEqual(["intent-0001"]);
    const theirs = await (await withAgent()).chain({ type: "approveAgent", agentAddress: other.address, agentName: "Codex", validUntil: START + 30 * DAY }, intentFor(other.address), { ...limit, intent: "intent-0001" });
    expect(isRefusal(theirs) ? theirs.code : "kept").toBe("E_ACCOUNT_BAD_ACTION");
    // a limit that names none carries none
    const loose = await (await withAgent()).apply(limit);
    expect(isRefusal(loose) ? loose.message : loose.spends.map((s) => "intent" in s)).toEqual([false]);
  });

  it("a restart replays both: a limit signed without the field, and one signed with it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "review2-restore-"));
    dirs.push(dir);
    const ledger = new Ledger(join(dir, "portfolio", "ledger-2026-10-06T09-00-00-000Z.jsonl"), () => new Date(START).toISOString());
    let n = 0;
    const row = async (a: NoNonce<OwnerAction>) => {
      const action = { ...a, nonce: START + ++n } as OwnerAction;
      ledger.append({ kind: "action", venue: "*", tool: action.type, signer: owner.address, envelope: await signOwner(owner, action), outcome: "ok", reason: action.type });
    };
    await row({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: START + 30 * DAY });
    await row(limit);
    await row(intentFor(cc.address));
    await row({ ...limit, scope: "venues", intent: "intent-0002" });
    const r = await rebuild(ledger.all(), { ...emptyState(), owners: [{ id: owner.address, kind: "eoa", label: "owner", addedAt: new Date(START).toISOString() }] });
    expect(r.skipped).toEqual([]);
    expect(r.state.spends.map((s) => [s.id, s.scope, s.intent ?? null])).toEqual([["spend-0001", "trade", null], ["spend-0003", "venues", "intent-0002"]]);
  });
});
