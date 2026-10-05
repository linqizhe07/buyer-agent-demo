/** AN ATTACK THAT MUST FAIL (found by an independent review on 2026-10-04, written as it succeeded then, and run with `it.fails`:
 * this test passes only while the attack below does NOT go through) — attacker A, an agent inside an ordinary `venues` approval with a refill window.
 *
 * "A card's approval … is re-judged." When a transfer card is released, `move()` judges it with `covers()`, which answers with the FIRST
 * limit that says no: recipient, per-payment, budget, then the window ("the same destination may be refilled once per window"). A waiting
 * card always trips the budget line when the rest of the budget has been used (its own share is still set aside), and `afterRelease()`
 * then clears that budget refusal — without going on to the window check behind it, or to the source check. So whether a released card
 * respects the window depends on whether the budget happened to be tight:
 *   budget $1,000: card $600, then $400 sent → approving the card sends a SECOND refill inside the 24 h window;
 *   budget $2,000: the very same steps → the card is refused, E_MANDATE_RATE. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isRefusal } from "../../src/core/errors.ts";
import { cardHash, type Outcome } from "../../src/portfolio/account/exchange.ts";
import { signAgent, signOwner, simKey, type AgentAction, type OwnerAction } from "../../src/portfolio/account/sign.ts";
import { PortfolioService } from "../../src/portfolio/service.ts";

const START = Date.parse("2026-10-05T14:00:00.000Z");
const DAY = 86_400_000;
const owner = simKey("owner");
const cc = simKey("agent:claude-code");
const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));
const code = (o: Outcome): string => (isRefusal(o) ? o.code : o.kind);

/** Guard mode; the agent may refill Hyperliquid from OKX once every 24 hours, $600 at a time. A $600 transfer waits on a card; $400 goes at once; then the owner approves the card */
async function run(budget: string) {
  let n = 0;
  const home = mkdtempSync(join(tmpdir(), "attack-window-"));
  homes.push(home);
  const svc = await PortfolioService.create({ home, now: () => new Date(START).toISOString(), venues: "frontline", account: { owners: [{ id: owner.address, kind: "eoa", label: "owner", addedAt: new Date(START).toISOString() }] } });
  const own = async (a: Record<string, unknown>) => svc.exchange(await signOwner(owner, { ...a, nonce: START + ++n } as OwnerAction));
  const transfer = async (amount: string) => svc.exchange(await signAgent(cc, { type: "agentSendAsset", destination: "self", sourceDex: "okx", destinationDex: "hyperliquid", token: "USDC", amount, fromSubAccount: "", maxFee: "5", nonce: START + ++n } as AgentAction));
  await own({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: START + 30 * DAY });
  await own({ type: "approveSpend", agent: cc.address, scope: "venues", allow: "okx,metamask,hyperliquid", perPayment: "600", budget, windowHours: 24, validUntil: START + 30 * DAY });
  svc.setMode("guard");
  const first = await transfer("600");
  if (isRefusal(first) || first.kind !== "card") throw new Error(`expected a card, got ${code(first)}`);
  const second = await transfer("400");
  const released = await own({ type: "approveCard", card: first.card.id, action: cardHash(first.card), decision: "approve" });
  const refillsInsideTheWindow = svc.account!.payments.filter((p) => p.to === "hyperliquid" && p.authority === "agent" && p.status !== "failed").length;
  return { second: code(second), released: code(released), refillsInsideTheWindow };
}

describe("A · a released card and the approval's refill window", () => {
  it.fails("with a tight budget the window is not asked: two refills inside 24 hours; with a roomy one it is", async () => {
    const tight = await run("1000");
    expect(tight).toEqual({ second: "payment", released: "payment", refillsInsideTheWindow: 2 });
    const roomy = await run("2000");
    expect(roomy).toEqual({ second: "payment", released: "E_MANDATE_RATE", refillsInsideTheWindow: 1 });
    const windowSkippedOnRelease = tight.refillsInsideTheWindow > 1;
    expect(windowSkippedOnRelease).toBe(true);
  });
});
