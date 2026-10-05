/** A FINDING OF THE INDEPENDENT REVIEW (2026-10-04), half closed: what is refused now, and what stays true — invariant 4: "a money instruction is good for 10 minutes".
 *
 * The door refuses a money instruction when `now − nonce > 10 min`. Nothing bounds the other side except the nonce window (a day ahead): an
 * instruction signed with a nonce 23 h 59 min in the future is good from the moment it is signed until ten minutes after that nonce — a
 * day and ten minutes, not ten minutes. (An envelope captured in transit, or signed in advance, is good for that long.) */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isRefusal } from "../../src/core/errors.ts";
import type { Outcome } from "../../src/portfolio/account/exchange.ts";
import { MONEY_TTL_MS, signAgent, signOwner, simKey, type AgentAction, type OwnerAction } from "../../src/portfolio/account/sign.ts";
import { PortfolioService } from "../../src/portfolio/service.ts";

const START = Date.parse("2026-10-05T14:00:00.000Z");
const MIN = 60_000;
const DAY = 86_400_000;
const owner = simKey("owner");
const cc = simKey("agent:claude-code");
const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));
const code = (o: Outcome): string => (isRefusal(o) ? o.code : o.kind);

describe("a money instruction dated ahead", () => {
  it("cannot be sent ahead of its date; on its date, post-dated by its own signer, it is taken", async () => {
    let t = START;
    const home = mkdtempSync(join(tmpdir(), "attack-ttl-"));
    homes.push(home);
    const svc = await PortfolioService.create({ home, now: () => new Date(t).toISOString(), venues: "frontline", account: { owners: [{ id: owner.address, kind: "eoa", label: "owner", addedAt: new Date(START).toISOString() }] } });
    await svc.exchange(await signOwner(owner, { type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: t + 30 * DAY, nonce: t + 1 } as OwnerAction));
    await svc.exchange(await signOwner(owner, { type: "approveSpend", agent: cc.address, scope: "venues", allow: "okx,metamask,hyperliquid", perPayment: "600", budget: "2000", windowHours: 0, validUntil: t + 30 * DAY, nonce: t + 2 } as OwnerAction));
    const move = (nonce: number) => signAgent(cc, { type: "agentSendAsset", destination: "self", sourceDex: "okx", destinationDex: "hyperliquid", token: "USDC", amount: "100", fromSubAccount: "", maxFee: "5", nonce } as AgentAction);

    // both are signed now
    const signedAt = t;
    const datedNow = await move(t + 3);
    const datedAhead = await move(t + DAY - MIN);

    // sent now, a day before its date: refused. An instruction may not arrive more than ten minutes ahead of its own date
    expect(code(await svc.exchange(datedAhead))).toBe("E_ACCOUNT_EXPIRED");
    t += DAY - 2 * MIN;
    const age = t - signedAt;
    expect(age).toBeGreaterThan(100 * MONEY_TTL_MS);
    expect(code(await svc.exchange(datedNow))).toBe("E_ACCOUNT_EXPIRED");
    // What no verifier can close: a signature does not say when it was made. The signer itself can date an instruction ahead and send it on
    // that date — which is no more than it could do by signing a new one then. The ten minutes protect a signer from someone ELSE sending
    // an instruction of theirs late; they do not stop a signer from post-dating its own.
    expect(code(await svc.exchange(datedAhead))).toBe("payment");
  });
});
