/** AN ATTACK THAT MUST FAIL (found by an independent review on 2026-10-04, written as it succeeded then, and run with `it.fails`:
 * this test passes only while the attack below does NOT go through) — attacker D, someone who can read the ledger file.
 *
 * An owner's signature covers `BigInt(Math.trunc(nonce))` (sign.ts, messageOf); the door only asks that the nonce be a finite number and the
 * nonce book compares the number exactly. So the owner's envelope with nonce N is also a valid, never-seen envelope with nonce N + 0.5.
 * While the account is alive the result table (same signer, same digest) hides this. After `reset()` — and after a restart, where the nonce
 * books are rebuilt from the ledgers — the table is empty and the old approvals run again, with nobody signing anything. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isRefusal } from "../../src/core/errors.ts";
import type { Outcome } from "../../src/portfolio/account/exchange.ts";
import { signAgent, signOwner, simKey, ZERO, type AgentAction, type Envelope, type OwnerAction } from "../../src/portfolio/account/sign.ts";
import { PortfolioService } from "../../src/portfolio/service.ts";

const START = Date.parse("2026-10-05T14:00:00.000Z");
const MIN = 60_000;
const DAY = 86_400_000;
const owner = simKey("owner");
const cc = simKey("agent:claude-code");
const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));

const code = (o: Outcome): string => (isRefusal(o) ? o.code : o.kind);
const seed = { owners: [{ id: owner.address, kind: "eoa" as const, label: "owner", addedAt: new Date(START).toISOString() }] };
const home = () => {
  const h = mkdtempSync(join(tmpdir(), "attack-replay-"));
  homes.push(h);
  return h;
};
/** what the attacker does: read the signed envelopes out of a ledger file */
const envelopesIn = (file: string): Envelope[] =>
  readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { tool?: string; envelope?: Envelope }).filter((r) => r.envelope !== undefined && (r.tool === "approveAgent" || r.tool === "approveSpend")).map((r) => r.envelope!);
/** …and add a half to the nonce. The signature is untouched */
const half = (e: Envelope): Envelope => ({ ...e, nonce: e.nonce + 0.5, action: { ...e.action, nonce: e.action.nonce + 0.5 } as OwnerAction });
const transfer = (nonce: number) => signAgent(cc, { type: "agentSendAsset", destination: "self", sourceDex: "okx", destinationDex: "hyperliquid", token: "USDC", amount: "500", fromSubAccount: "", maxFee: "5", nonce } as AgentAction);

describe("D · an owner's old envelope, with half a millisecond added to its nonce", () => {
  it.fails("after reset(): the agent key and its spending approval come back from the ledger file, and the agent moves money again", async () => {
    const t = START;
    const svc = await PortfolioService.create({ home: home(), now: () => new Date(t).toISOString(), venues: "frontline", account: seed });
    expect(code(await svc.exchange(await signOwner(owner, { type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: t + 30 * DAY, nonce: t + 1 })))).toBe("account");
    expect(code(await svc.exchange(await signOwner(owner, { type: "approveSpend", agent: cc.address, scope: "venues", allow: "okx,metamask,hyperliquid", perPayment: "600", budget: "2000", windowHours: 0, validUntil: t + 30 * DAY, nonce: t + 2 })))).toBe("account");
    const stolen = envelopesIn(svc.ledgerPath());
    expect(stolen.map((e) => e.action.type)).toEqual(["approveAgent", "approveSpend"]);

    svc.reset();
    expect([svc.account!.state.agents.length, svc.account!.state.spends.length]).toEqual([0, 0]);
    expect(code(await svc.exchange(await transfer(t + 10)))).toBe("E_ACCOUNT_UNKNOWN_SIGNER");
    // the defence that exists: the very same envelope is refused
    for (const e of stolen) expect(code(await svc.exchange(e))).toBe("E_ACCOUNT_NONCE");
    // the hole: the same signature under nonce + 0.5
    for (const e of stolen) expect(code(await svc.exchange(half(e)))).toBe("account");

    const reinstatedWithoutTheOwnerSigning = svc.account!.state.agents.some((k) => k.address === cc.address && k.revokedAt === undefined) && svc.account!.state.spends.some((s) => s.agent === cc.address && s.revokedAt === undefined);
    expect(reinstatedWithoutTheOwnerSigning).toBe(true);
    const moved = await svc.exchange(await transfer(t + 11));
    expect(code(moved)).toBe("payment");
  });

  it.fails("after a restart in the same home: a key the owner had REVOKED is live again", async () => {
    const h = home();
    const first = await PortfolioService.create({ home: h, now: () => new Date(START).toISOString(), venues: "frontline", account: seed });
    await first.exchange(await signOwner(owner, { type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: START + 30 * DAY, nonce: START + 1 }));
    await first.exchange(await signOwner(owner, { type: "approveSpend", agent: cc.address, scope: "venues", allow: "*", perPayment: "600", budget: "5000", windowHours: 0, validUntil: START + 30 * DAY, nonce: START + 2 }));
    // the owner changes their mind
    expect(code(await first.exchange(await signOwner(owner, { type: "approveAgent", agentAddress: ZERO, agentName: "Claude Code", validUntil: 0, nonce: START + 3 })))).toBe("account");
    const stolen = envelopesIn(first.ledgerPath()).filter((e) => (e.action as { agentAddress?: string }).agentAddress !== ZERO);

    const second = await PortfolioService.create({ home: h, now: () => new Date(START + MIN).toISOString(), venues: "frontline", account: seed });
    for (const e of stolen) expect(code(await second.exchange(e))).toBe("E_ACCOUNT_NONCE");
    for (const e of stolen) expect(code(await second.exchange(half(e)))).toBe("account");
    const revokedKeyIsLiveAgain = second.account!.state.agents.some((k) => k.address === cc.address && k.revokedAt === undefined);
    expect(revokedKeyIsLiveAgain).toBe(true);
    expect(code(await second.exchange(await transfer(START + MIN + 5)))).toBe("payment");
  });
});
