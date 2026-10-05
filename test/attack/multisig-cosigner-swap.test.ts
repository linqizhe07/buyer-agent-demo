/** AN ATTACK THAT MUST FAIL (found by an independent review on 2026-10-04, written as it succeeded then, and run with `it.fails`:
 * this test passes only while the attack below does NOT go through) — attacker D, someone who can read the ledger file, on an account that needs two signers.
 *
 * "The same envelope → the same answer" is keyed on `${signer}:${digest}` and the nonce is spent in the PRIMARY signer's book only. A ledger row
 * holds the envelope with its cosignatures. Put the cosigner's signature first and the first signer's signature among the cosignatures: the
 * digest is the same, both signatures are still good, but the key and the nonce book are the other signer's — so the instruction runs again.
 * Shown with a spending approval: replayed, it replaces the spent one with a fresh budget. A `sendAsset` inside its ten minutes would be sent twice. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isRefusal } from "../../src/core/errors.ts";
import type { Outcome } from "../../src/portfolio/account/exchange.ts";
import { cosign, signAgent, signOwner, simKey, type AgentAction, type Envelope, type OwnerAction } from "../../src/portfolio/account/sign.ts";
import { PortfolioService } from "../../src/portfolio/service.ts";

const START = Date.parse("2026-10-05T14:00:00.000Z");
const DAY = 86_400_000;
const owner = simKey("owner");
const second = simKey("co-signer");
const cc = simKey("agent:claude-code");
const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));
const code = (o: Outcome): string => (isRefusal(o) ? o.code : o.kind);

describe("D · a two-signer account: the signature and the cosignature change places", () => {
  it.fails("the owners' one spending approval is taken twice, and the agent spends the budget twice", async () => {
    const home = mkdtempSync(join(tmpdir(), "attack-multisig-"));
    homes.push(home);
    let n = 0;
    const svc = await PortfolioService.create({ home, now: () => new Date(START).toISOString(), venues: "frontline", account: { owners: [{ id: owner.address, kind: "eoa", label: "owner", addedAt: new Date(START).toISOString() }] } });
    const both = async (a: Record<string, unknown>): Promise<Envelope> => {
      const action = { ...a, nonce: START + ++n } as OwnerAction;
      return { ...(await signOwner(owner, action)), cosignatures: [await cosign(second, action)] };
    };
    const move = async () => svc.exchange(await signAgent(cc, { type: "agentSendAsset", destination: "self", sourceDex: "okx", destinationDex: "hyperliquid", token: "USDC", amount: "600", fromSubAccount: "", maxFee: "5", nonce: START + ++n } as AgentAction));

    expect(code(await svc.exchange(await signOwner(owner, { type: "convertToMultiSigUser", signers: JSON.stringify({ authorizedUsers: [owner.address, second.address].sort(), threshold: 2 }), nonce: START + ++n })))).toBe("account");
    expect(code(await svc.exchange(await both({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: START + 30 * DAY })))).toBe("account");
    expect(code(await svc.exchange(await both({ type: "approveSpend", agent: cc.address, scope: "venues", allow: "okx,metamask,hyperliquid", perPayment: "600", budget: "600", windowHours: 0, validUntil: START + 30 * DAY })))).toBe("account");

    expect(code(await move())).toBe("payment");
    expect(code(await move())).toBe("E_MANDATE_BUDGET");

    // the attacker reads the approval's row off the ledger file…
    const row = readFileSync(svc.ledgerPath(), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { tool?: string; envelope?: Envelope }).find((r) => r.tool === "approveSpend")!;
    const seen = row.envelope!;
    // …sent again as it is, it is the first answer and nothing runs
    expect(code(await svc.exchange(seen))).toBe("account");
    expect(code(await move())).toBe("E_MANDATE_BUDGET");
    // …with the two signatures in each other's place, it is a new instruction: same nonce, same digest, nobody signed anything new
    const swapped: Envelope = { action: seen.action, nonce: seen.nonce, signature: seen.cosignatures![0]!, cosignatures: [seen.signature] };
    expect(code(await svc.exchange(swapped))).toBe("account");

    const approvals = svc.account!.state.spends.filter((s) => s.agent === cc.address && s.scope === "venues");
    expect(approvals).toHaveLength(2);
    expect(code(await move())).toBe("payment");
    const movedUsd = svc.account!.payments.filter((p) => p.authority === "agent").reduce((s, p) => s + p.amountUsd, 0);
    const spentBeyondTheOneSignedBudget = movedUsd > 600;
    expect([movedUsd, spentBeyondTheOneSignedBudget]).toEqual([1200, true]);
  });
});
