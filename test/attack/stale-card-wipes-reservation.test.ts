/** AN ATTACK THAT MUST FAIL (found by an independent review on 2026-10-04, written as it succeeded then, and run with `it.fails`:
 * this test passes only while the attack below does NOT go through) — attacker A, an agent inside ordinary approvals; every payee here is honest.
 *
 * A waiting card holds its share of the budget (`reservedMicro`) in the approval it was raised under. When the owner answers it — approve,
 * REJECT, or after it expired — `answerCard`'s `release()` gives that share back to whichever approval is live for that agent NOW
 * (`spends.find(agent, scope, not revoked)`), clamped at zero. If the owner has re-issued the approval in between, the share comes out of
 * money the NEW approval set aside for something else — here an open session's deposit. The budget then has room it should not have:
 * the owner re-issues a $40 approval, rejects the stale card, approves two first payments that each fit — and $59 is spent under it. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isRefusal } from "../../src/core/errors.ts";
import { cardHash, type CardLike, type Outcome } from "../../src/portfolio/account/exchange.ts";
import { signAgent, signOwner, simKey, type AgentAction, type OwnerAction } from "../../src/portfolio/account/sign.ts";
import { PortfolioService } from "../../src/portfolio/service.ts";

const START = Date.parse("2026-10-05T14:00:00.000Z");
const MIN = 60_000;
const DAY = 86_400_000;
const QUOTE = "https://data.sim/v1/quotes?symbol=NVDA";
const STREAM = "https://infer.sim/v1/stream";
const ITEM = "https://shop.sim/items/desk-feed-pro";
const owner = simKey("owner");
const cc = simKey("agent:claude-code");
const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));
const code = (o: Outcome): string => (isRefusal(o) ? o.code : o.kind);
const carded = (o: Outcome): CardLike => {
  if (isRefusal(o) || o.kind !== "card") throw new Error(`expected a card, got ${code(o)}`);
  return o.card;
};

describe("A · a card from before the approval was re-issued", () => {
  it.fails("rejecting it frees budget that an open session had set aside: $59 is spent on a $40 budget, with honest payees", async () => {
    let t = START;
    let n = 0;
    const home = mkdtempSync(join(tmpdir(), "attack-stale-card-"));
    homes.push(home);
    const svc = await PortfolioService.create({ home, now: () => new Date(t).toISOString(), venues: "frontline", account: { owners: [{ id: owner.address, kind: "eoa", label: "owner", addedAt: new Date(START).toISOString() }] } });
    const engine = svc.account!;
    const world = svc.payees!;
    const own = async (a: Record<string, unknown>) => svc.exchange(await signOwner(owner, { ...a, nonce: t + ++n } as OwnerAction));
    const pay = async (url: string, maxAmount: string, from = "research") => svc.exchange(await signAgent(cc, { type: "agentPay", url, maxAmount, fromSubAccount: from, nonce: t + ++n } as AgentAction));
    const answer = (card: CardLike, decision: string) => own({ type: "approveCard", card: card.id, action: cardHash(card), decision });
    const approval = () => own({ type: "approveSpend", agent: cc.address, scope: "payees", allow: "data.sim,infer.sim,shop.sim", perPayment: "30", budget: "40", windowHours: 0, validUntil: t + 30 * DAY });
    await own({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: t + 30 * DAY });
    await own({ type: "createSubAccount", name: "research", agent: cc.address, float: "60" });
    const fund = { destination: "self", sourceDex: "metamask", destinationDex: "sub:research", token: "USDC", amount: "50" };
    const route = await engine.resolve(fund, "owner");
    if (isRefusal(route)) throw new Error(route.message);
    await own({ type: "sendAsset", ...fund, fromSubAccount: "", route: route.route.hash, maxFee: String(route.route.feeUsd), deadline: route.route.arrivalMs + MIN });
    t += 2 * MIN;
    await engine.settle();
    await approval();
    const spend = () => engine.state.spends.find((s) => s.scope === "payees" && s.revokedAt === undefined)!;

    // 1 · the agent asks for a $30 payment: a first-payment card, which holds $30 of approval #1
    world.data.priceMicro = 30_000_000;
    const stale = carded(await pay(QUOTE, "30"));
    expect(spend().reservedMicro).toBe(30_000_000);
    // 2 · the owner re-issues the approval (same terms): approval #2 starts clean
    expect(code(await approval())).toBe("account");
    expect([spend().spentMicro, spend().reservedMicro]).toEqual([0, 0]);
    // 3 · a session under approval #2: $30 deposit, $5 a call. One call made, $25 still set aside
    world.infer.depositMicro = 30_000_000;
    world.infer.unitMicro = 5_000_000;
    expect(code(await answer(carded(await pay(STREAM, "5")), "approve"))).toBe("payment");
    expect([spend().spentMicro, spend().reservedMicro]).toEqual([5_000_000, 25_000_000]);

    // 4 · the owner REJECTS the stale card. Nothing moves — but the session's $25 is no longer set aside
    expect(code(await answer(stale, "reject"))).toBe("result");
    expect([spend().spentMicro, spend().reservedMicro]).toEqual([5_000_000, 0]);

    // 5 · so a $29 purchase by card fits "what is left of $40", and the owner approves it
    expect(code(await answer(carded(await pay(ITEM, "30", "")), "approve"))).toBe("payment");
    // 6 · and the session goes on spending its deposit
    for (let i = 0; i < 5; i++) expect(code(await pay(STREAM, "5"))).toBe("payment");

    const spentBeyondBudget = spend().spentMicro > spend().budgetMicro;
    expect([spend().budgetMicro, spend().spentMicro, spentBeyondBudget]).toEqual([40_000_000, 59_000_000, true]);
  });
});
