/** AN ATTACK THAT MUST FAIL (found by an independent review on 2026-10-04, written as it succeeded then, and run with `it.fails`:
 * this test passes only while the attack below does NOT go through) — no attacker needed: the owner revokes an agent's key (or its approval; or either expires).
 *
 * "A session deposit can only come back to the float or go to the payee up to the vouchers." Closing a session is an AGENT instruction
 * (`agentPay … close`), judged like any other: a revoked or expired key, or a revoked or expired approval, is refused. Nothing else closes a
 * session — `tick()` only withdraws what `close()` already asked back — and the owner has no instruction for it. So the deposit stays in
 * escrow for good. The float's own balance has no way home either: no owner instruction takes money out of a sub-account. */
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
  const home = mkdtempSync(join(tmpdir(), "attack-session-revoke-"));
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

describe("the owner revokes an agent that has a session open", () => {
  it.fails("the owner revokes the agent key with a session open: nobody can close it, and the deposit stays in escrow", async () => {
    const x = await boot();
    x.world.infer.depositMicro = 20_000_000;
    expect(code(await x.payOk("0.05"))).toBe("payment");
    expect(code(await x.own({ type: "approveAgent", agentAddress: ZERO, agentName: "Claude Code", validUntil: 0 }))).toBe("account");
    expect(code(await x.pay("0", true))).toBe("E_ACCOUNT_AGENT_REVOKED");
    await x.pass(60 * DAY);
    const view = await x.engine.view();
    const stuckInEscrow = x.world.chain.balance(x.world.escrow.address);
    expect([stuckInEscrow, view.pay.sessions.map((s) => s.status), x.start - x.float()]).toEqual([20_000_000, ["open"], 20_000_000]);
    // the float's own $29.99 has no way home either: no owner instruction takes money out of a sub-account
    const sweep = await x.engine.resolve({ destination: "self", sourceDex: "sub:research", destinationDex: "metamask", token: "USDC", amount: "10" }, "owner");
    expect(isRefusal(sweep) && sweep.code).toBe("E_WALLET_ACCOUNT_UNKNOWN");
  });
});
