/** AN ATTACK THAT MUST FAIL (found by an independent review on 2026-10-04, written as it succeeded then, and run with `it.fails`:
 * this test passes only while the attack below does NOT go through) — attacker A, an agent with an authorised key and an ordinary `venues` approval.
 *
 * exchange.ts says every agent instruction is "inside a spending approval the owner signed … each still judged by the openness dial (Guard's
 * allowance and daily cap, an account switched off, an ended session)". `agentSwap` checks the approval's venue list and its per-payment line
 * and nothing else: it is never counted against the budget, `stillSigned` is not asked, and `evaluate()` is never called. So an agent can swap
 * back and forth without end (each swap costs the user a fee), and it keeps swapping at a venue the owner has switched off and after the
 * owner has ended the agent's session — when `agentSendAsset` at the same venue is refused. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isRefusal } from "../../src/core/errors.ts";
import type { Outcome } from "../../src/portfolio/account/exchange.ts";
import { signAgent, signOwner, simKey, type AgentAction, type OwnerAction } from "../../src/portfolio/account/sign.ts";
import { PortfolioService } from "../../src/portfolio/service.ts";

const START = Date.parse("2026-10-05T14:00:00.000Z");
const DAY = 86_400_000;
const owner = simKey("owner");
const cc = simKey("agent:claude-code");
const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));
const code = (o: Outcome): string => (isRefusal(o) ? o.code : o.kind);

describe("A · a swap is outside the budget and outside the dial", () => {
  it.fails("$4,680 swapped on a $1,000 budget that still reads $0 spent; and it goes on after the venue is switched off and the session is ended", async () => {
    let n = 0;
    const home = mkdtempSync(join(tmpdir(), "attack-swap-"));
    homes.push(home);
    const svc = await PortfolioService.create({ home, now: () => new Date(START).toISOString(), venues: "frontline", account: { owners: [{ id: owner.address, kind: "eoa", label: "owner", addedAt: new Date(START).toISOString() }] } });
    const own = async (a: Record<string, unknown>) => svc.exchange(await signOwner(owner, { ...a, nonce: START + ++n } as OwnerAction));
    const ag = async (a: Record<string, unknown>) => svc.exchange(await signAgent(cc, { ...a, nonce: START + ++n } as AgentAction));
    const swap = (sell: string, buy: string, amount: string) => ag({ type: "agentSwap", venue: "okx", sell, buy, amount, minReceive: "0" });
    const transfer = () => ag({ type: "agentSendAsset", destination: "self", sourceDex: "okx", destinationDex: "hyperliquid", token: "USDC", amount: "100", fromSubAccount: "", maxFee: "5" });
    const stable = async () => (await svc.read("okx")).filter((h) => h.asset === "USDT" || h.asset === "USDC").reduce((s, h) => s + h.amount, 0);
    await own({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: START + 30 * DAY });
    await own({ type: "approveSpend", agent: cc.address, scope: "venues", allow: "okx,metamask,hyperliquid", perPayment: "600", budget: "1000", windowHours: 0, validUntil: START + 30 * DAY });
    const spend = () => svc.account!.state.spends.find((s) => s.scope === "venues" && s.revokedAt === undefined)!;
    const before = await stable();

    // eight swaps, back and forth: $590 one way, $580 back
    for (let i = 0; i < 8; i++) expect(code(await swap(i % 2 ? "USDC" : "USDT", i % 2 ? "USDT" : "USDC", i % 2 ? "580" : "590"))).toBe("payment");
    const swappedUsd = svc.account!.payments.filter((p) => p.kind === "swap" && p.authority === "agent").reduce((s, p) => s + p.amountUsd, 0);
    const beyondBudgetAndUncounted = swappedUsd * 1e6 > spend().budgetMicro && spend().spentMicro === 0;
    expect([swappedUsd, beyondBudgetAndUncounted]).toEqual([4680, true]);
    // every one of them cost the user a fee
    expect(Number((before - (await stable())).toFixed(2))).toBe(0.48);

    // the owner switches OKX off for the agent: a transfer is refused, a swap is not
    svc.revoke("okx");
    expect(code(await transfer())).toBe("E_WALLET_ACCOUNT_REVOKED");
    expect(code(await swap("USDT", "USDC", "100"))).toBe("payment");
    // the owner ends the agent's session ("every write stops"): a transfer is refused, a swap is not
    svc.restore("okx");
    svc.revokeAll();
    expect(code(await transfer())).toBe("E_WALLET_SESSION_EXPIRED");
    expect(code(await swap("USDT", "USDC", "100"))).toBe("payment");
  });
});
