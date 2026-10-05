/** AN ATTACK THAT MUST FAIL (found by an independent review on 2026-10-04, written as it succeeded then, and run with `it.fails`:
 * this test passes only while the attack below does NOT go through) — attacker A, an agent paying through a payment session while the owner has the dial on Guard.
 *
 * Guard's daily cap is "a hard line": USD the agent may move in any rolling 24 hours. `dailyOutUsd()` adds up ledger rows of kind `action`
 * with outcome `accepted`. A session is opened with such a row — for $0 — and every call inside it is logged as kind `payment`
 * (`mpp voucher`). So what a session pays is never part of the day's figure: each voucher is judged against a figure that does not move.
 * With a $2 cap, three single payments of $0.90 stop at the third; ten session calls of $0.90 all go through. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isRefusal } from "../../src/core/errors.ts";
import { cardHash, type Outcome } from "../../src/portfolio/account/exchange.ts";
import { signAgent, signOwner, simKey, type AgentAction, type OwnerAction } from "../../src/portfolio/account/sign.ts";
import { loadOpenness, PortfolioService } from "../../src/portfolio/service.ts";

const START = Date.parse("2026-10-05T14:00:00.000Z");
const MIN = 60_000;
const DAY = 86_400_000;
const QUOTE = "https://data.sim/v1/quotes?symbol=NVDA";
const STREAM = "https://infer.sim/v1/stream";
const owner = simKey("owner");
const cc = simKey("agent:claude-code");
const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));
const code = (o: Outcome): string => (isRefusal(o) ? o.code : o.kind);

/** Guard mode with a daily cap of $2; one agent key, a float of $50, a payees approval of $30 a payment and $40 in all */
async function boot() {
  let t = START;
  let n = 0;
  const home = mkdtempSync(join(tmpdir(), "attack-guard-"));
  homes.push(home);
  const openness = { ...(loadOpenness() as Record<string, unknown>), mode: "guard", guard: { defaultCardAboveUsd: 500, cardAboveUsd: {}, dailyCapUsd: 2 } };
  const svc = await PortfolioService.create({ home, now: () => new Date(t).toISOString(), venues: "frontline", openness, account: { owners: [{ id: owner.address, kind: "eoa", label: "owner", addedAt: new Date(START).toISOString() }] } });
  const engine = svc.account!;
  const own = async (a: Record<string, unknown>) => svc.exchange(await signOwner(owner, { ...a, nonce: t + ++n } as OwnerAction));
  const pay = async (url: string) => svc.exchange(await signAgent(cc, { type: "agentPay", url, maxAmount: "1", fromSubAccount: "research", nonce: t + ++n } as AgentAction));
  /** pay, and — when the account asks the owner first — approve */
  const payOk = async (url: string) => {
    const r = await pay(url);
    return !isRefusal(r) && r.kind === "card" ? own({ type: "approveCard", card: r.card.id, action: cardHash(r.card), decision: "approve" }) : r;
  };
  await own({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: t + 30 * DAY });
  await own({ type: "createSubAccount", name: "research", agent: cc.address, float: "60" });
  const fund = { destination: "self", sourceDex: "metamask", destinationDex: "sub:research", token: "USDC", amount: "50" };
  const route = await engine.resolve(fund, "owner");
  if (isRefusal(route)) throw new Error(route.message);
  await own({ type: "sendAsset", ...fund, fromSubAccount: "", route: route.route.hash, maxFee: String(route.route.feeUsd), deadline: route.route.arrivalMs + MIN });
  t += 2 * MIN;
  await engine.settle();
  await own({ type: "approveSpend", agent: cc.address, scope: "payees", allow: "data.sim,infer.sim", perPayment: "30", budget: "40", windowHours: 0, validUntil: t + 30 * DAY });
  const daily = () => svc.dailyOutUsd(new Date(t).toISOString());
  const spent = () => engine.state.spends.find((s) => s.scope === "payees" && s.revokedAt === undefined)!.spentMicro;
  return { svc, world: svc.payees!, pay, payOk, daily, spent };
}

describe("A · Guard's daily cap does not see what a session pays", () => {
  it.fails("single payments stop at the $2 cap; ten session calls of $0.90 pay $9 and the day's figure stays at $0", async () => {
    // the line as it works for single payments
    const single = await boot();
    single.world.data.priceMicro = 900_000;
    expect(code(await single.payOk(QUOTE))).toBe("payment");
    expect(code(await single.pay(QUOTE))).toBe("payment");
    expect(code(await single.pay(QUOTE))).toBe("E_WALLET_DAILY_CAP");
    expect(single.daily()).toBe(1.8);

    // the same money through a session
    const x = await boot();
    x.world.infer.unitMicro = 900_000;
    x.world.infer.depositMicro = 20_000_000;
    const calls = [code(await x.payOk(STREAM))];
    for (let i = 0; i < 9; i++) calls.push(code(await x.pay(STREAM)));
    expect(calls).toEqual(Array.from({ length: 10 }, () => "payment"));
    const cap = x.svc.policy().guard.dailyCapUsd;
    const paidPastTheDailyCap = x.spent() / 1e6 > cap;
    expect([cap, x.spent(), x.daily(), paidPastTheDailyCap]).toEqual([2, 9_000_000, 0, true]);
  });
});
