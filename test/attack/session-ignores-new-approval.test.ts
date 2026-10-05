/** AN ATTACK THAT MUST FAIL (found by an independent review on 2026-10-04, written as it succeeded then, and run with `it.fails`:
 * this test passes only while the attack below does NOT go through) — attacker A, an agent with an open payment session.
 *
 * The owner replaces the spending approval while a session is open (here: cuts it to $5 a payment, $6 in all). Vouchers on the open session
 * are judged `inSession`: no budget line ("the budget was set aside when the deposit went in") and no card. But the deposit was set aside in
 * the OLD approval; the instruction is judged against the NEW one, which set nothing aside and has no pinned address for this payee. The
 * agent goes on spending the deposit: $25 on a $6 budget, to an address the owner never approved under this approval, without being asked. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isRefusal } from "../../src/core/errors.ts";
import { cardHash, type Outcome } from "../../src/portfolio/account/exchange.ts";
import { signAgent, signOwner, simKey, ZERO, type AgentAction, type OwnerAction } from "../../src/portfolio/account/sign.ts";
import { PortfolioService } from "../../src/portfolio/service.ts";

const START = Date.parse("2026-10-05T14:00:00.000Z");
const MIN = 60_000;
const DAY = 86_400_000;
const STREAM = "https://infer.sim/v1/stream";
const owner = simKey("owner");
const cc = simKey("agent:claude-code");
const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));
const code = (o: Outcome): string => (isRefusal(o) ? o.code : o.kind);

/** an account with one agent key, a float of $50 called `research`, and a payees approval for infer.sim: $30 a payment, $40 in all */
async function boot() {
  let t = START;
  let n = 0;
  const home = mkdtempSync(join(tmpdir(), "attack-session-budget-"));
  homes.push(home);
  const svc = await PortfolioService.create({ home, now: () => new Date(t).toISOString(), venues: "frontline", account: { owners: [{ id: owner.address, kind: "eoa", label: "owner", addedAt: new Date(START).toISOString() }] } });
  const engine = svc.account!;
  const own = async (a: Record<string, unknown>) => svc.exchange(await signOwner(owner, { ...a, nonce: t + ++n } as OwnerAction));
  const pay = async (maxAmount: string, close = false) => svc.exchange(await signAgent(cc, { type: "agentPay", url: STREAM, maxAmount, fromSubAccount: "research", ...(close ? { close: true } : {}), nonce: t + ++n } as AgentAction));
  /** pay, and — when the account asks the owner first — approve */
  const payOk = async (maxAmount: string) => {
    const r = await pay(maxAmount);
    return !isRefusal(r) && r.kind === "card" ? own({ type: "approveCard", card: r.card.id, action: cardHash(r.card), decision: "approve" }) : r;
  };
  const pass = async (ms: number) => {
    t += ms;
    await engine.settle();
  };
  await own({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: t + 90 * DAY });
  await own({ type: "createSubAccount", name: "research", agent: cc.address, float: "60" });
  const fund = { destination: "self", sourceDex: "metamask", destinationDex: "sub:research", token: "USDC", amount: "50" };
  const route = await engine.resolve(fund, "owner");
  if (isRefusal(route)) throw new Error(route.message);
  await own({ type: "sendAsset", ...fund, fromSubAccount: "", route: route.route.hash, maxFee: String(route.route.feeUsd), deadline: route.route.arrivalMs + MIN });
  await pass(2 * MIN);
  await own({ type: "approveSpend", agent: cc.address, scope: "payees", allow: "infer.sim", perPayment: "30", budget: "40", windowHours: 0, validUntil: t + 90 * DAY });
  const float = () => engine.sub("research")!.balanceMicro;
  const spend = () => engine.state.spends.find((s) => s.scope === "payees" && s.revokedAt === undefined)!;
  return { svc, engine, world: svc.payees!, own, pay, payOk, pass, float, spend, start: float(), now: () => t };
}

describe("A · an open session does not notice that the owner cut the budget", () => {
  it.fails("the owner cuts the budget to $6 while a session is open: $25 more is spent under it, with no card", async () => {
    const x = await boot();
    x.world.infer.depositMicro = 30_000_000;
    x.world.infer.unitMicro = 5_000_000;
    expect(code(await x.payOk("5"))).toBe("payment");
    // the owner thinks again: $5 a payment, $6 in all. A new approval starts with no pinned address
    expect(code(await x.own({ type: "approveSpend", agent: cc.address, scope: "payees", allow: "infer.sim", perPayment: "5", budget: "6", windowHours: 0, validUntil: x.now() + DAY }))).toBe("account");
    expect([x.spend().budgetMicro, x.spend().spentMicro, x.spend().payTo]).toEqual([6_000_000, 0, {}]);
    // five more calls on the open session: no card for the first payment under the new approval, no budget line
    const more: string[] = [];
    for (let i = 0; i < 5; i++) more.push(code(await x.pay("5")));
    expect(more).toEqual(["payment", "payment", "payment", "payment", "payment"]);
    const spentBeyondBudget = x.spend().spentMicro > x.spend().budgetMicro;
    expect([x.spend().budgetMicro, x.spend().spentMicro, spentBeyondBudget]).toEqual([6_000_000, 25_000_000, true]);
    // and the new approval still has no address the owner approved for this payee
    expect(x.spend().payTo).toEqual({});
  });
});
