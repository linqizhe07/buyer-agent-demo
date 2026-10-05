/** AN ATTACK THAT MUST FAIL (found by an independent review on 2026-10-04, written as it succeeded then, and run with `it.fails`:
 * this test passes only while the attack below does NOT go through) — attacker A, an agent inside an ordinary approval.
 *
 * The float's cap is a limit the owner signed (`createSubAccount.float`: "a float of up to $60"). `resolve()` holds a refill against the
 * float's LANDED balance; a refill takes 15 seconds to land, and refills still in flight are not counted. One refill that would pass the
 * cap is refused; five small ones in a row each fit, and together the float holds $99.94. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isRefusal } from "../../src/core/errors.ts";
import type { Outcome } from "../../src/portfolio/account/exchange.ts";
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
  const home = mkdtempSync(join(tmpdir(), "attack-float-"));
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

describe("A · the float's cap, passed by refills that are still in flight", () => {
  it.fails("one refill over the cap is refused; five in a row are not, and a $60 float holds $99.94", async () => {
    const x = await boot();
    // the owner lets the agent top its float up from the wallet: $11 at a time, $100 in all
    await x.own({ type: "approveSpend", agent: cc.address, scope: "venues", allow: "metamask,sub:research", perPayment: "11", budget: "100", windowHours: 0, validUntil: x.now() + 30 * DAY });
    const refill = (amount: string) => x.ag({ type: "agentSendAsset", destination: "self", sourceDex: "metamask", destinationDex: "sub:research", token: "USDC", amount, fromSubAccount: "", maxFee: "5" });
    const sub = () => x.engine.sub("research")!;
    expect([sub().capMicro, sub().balanceMicro]).toEqual([60_000_000, 49_990_000]);
    // the cap holds for one refill that would pass it…
    expect(code(await refill("10.02"))).toBe("E_WALLET_FLOAT_CAP");
    // …and not for five that each fit while the others are in the air
    const answers: string[] = [];
    for (let i = 0; i < 5; i++) answers.push(code(await refill("10")));
    expect(answers).toEqual(["payment", "payment", "payment", "payment", "payment"]);
    await x.pass(MIN);
    const overTheCap = sub().balanceMicro > sub().capMicro;
    expect([sub().balanceMicro, overTheCap]).toEqual([99_940_000, true]);
  });
});
