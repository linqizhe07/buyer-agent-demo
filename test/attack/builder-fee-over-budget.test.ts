/** AN ATTACK THAT MUST FAIL (found by an independent review on 2026-10-04, written as it succeeded then, and run with `it.fails`:
 * this test passes only while the attack below does NOT go through) — attacker A, an agent inside an ordinary approval.
 *
 * "Fees … must not get past the budget." `gate()` holds the PAYMENT against the approval's budget; `book()` then adds the payment AND the
 * app's fee to what was spent. A payment that exactly fits the budget leaves the approval overspent by the fee (here 0.1%: $0.029). */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isRefusal } from "../../src/core/errors.ts";
import { cardHash, type Outcome } from "../../src/portfolio/account/exchange.ts";
import { signAgent, signOwner, simKey, type AgentAction, type OwnerAction } from "../../src/portfolio/account/sign.ts";
import { PortfolioService } from "../../src/portfolio/service.ts";

const START = Date.parse("2026-10-05T14:00:00.000Z");
const MIN = 60_000;
const DAY = 86_400_000;
const owner = simKey("owner");
const cc = simKey("agent:claude-code");
const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));
const code = (o: Outcome): string => (isRefusal(o) ? o.code : o.kind);

/** an account with one agent key and a float called `research`: it may hold $60, and holds $50 less the gas of filling it */
async function boot() {
  let t = START;
  let n = 0;
  const home = mkdtempSync(join(tmpdir(), "attack-fee-"));
  homes.push(home);
  const svc = await PortfolioService.create({ home, now: () => new Date(t).toISOString(), venues: "frontline", account: { owners: [{ id: owner.address, kind: "eoa", label: "owner", addedAt: new Date(START).toISOString() }] } });
  const engine = svc.account!;
  const own = async (a: Record<string, unknown>) => svc.exchange(await signOwner(owner, { ...a, nonce: t + ++n } as OwnerAction));
  const ag = async (a: Record<string, unknown>) => svc.exchange(await signAgent(cc, { ...a, nonce: t + ++n } as AgentAction));
  const pass = async (ms: number) => {
    t += ms;
    await engine.settle();
  };
  await own({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: t + 30 * DAY });
  await own({ type: "createSubAccount", name: "research", agent: cc.address, float: "60" });
  const fund = { destination: "self", sourceDex: "metamask", destinationDex: "sub:research", token: "USDC", amount: "50" };
  const route = await engine.resolve(fund, "owner");
  if (isRefusal(route)) throw new Error(route.message);
  await own({ type: "sendAsset", ...fund, fromSubAccount: "", route: route.route.hash, maxFee: String(route.route.feeUsd), deadline: route.route.arrivalMs + MIN });
  await pass(2 * MIN);
  return { svc, engine, world: svc.payees!, own, ag, pass, now: () => t };
}

describe("A · the budget, passed by an app's fee", () => {
  it.fails("a $29 payment on a $29 budget, plus the fee, is $29.029 spent", async () => {
    const x = await boot();
    const builder = simKey("builder").address;
    await x.own({ type: "approveBuilderFee", builder, maxFeeRate: "0.1%" });
    await x.own({ type: "approveSpend", agent: cc.address, scope: "payees", allow: "data.sim", perPayment: "29", budget: "29", windowHours: 0, validUntil: x.now() + 30 * DAY });
    x.world.data.priceMicro = 29_000_000;
    const first = await x.ag({ type: "agentPay", url: "https://data.sim/v1/quotes?symbol=NVDA", maxAmount: "29", fromSubAccount: "research", builder: { b: builder, f: 100 } });
    if (isRefusal(first) || first.kind !== "card") throw new Error(`expected a card, got ${code(first)}`);
    expect(code(await x.own({ type: "approveCard", card: first.card.id, action: cardHash(first.card), decision: "approve" }))).toBe("payment");
    const spend = x.engine.state.spends.find((s) => s.scope === "payees" && s.revokedAt === undefined)!;
    const spentBeyondBudget = spend.spentMicro > spend.budgetMicro;
    expect([spend.budgetMicro, spend.spentMicro, spentBeyondBudget]).toEqual([29_000_000, 29_029_000, true]);
    expect(x.world.chain.balance(builder)).toBe(29_000);
  });
});
