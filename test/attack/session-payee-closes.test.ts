/** AN ATTACK THAT MUST FAIL (found by an independent review on 2026-10-04, written as it succeeded then, and run with `it.fails`:
 * this test passes only while the attack below does NOT go through) — attacker B, a payee the owner has approved (or simply a payee that tidies up).
 *
 * The payee closes the channel itself — its right under MPP: it settles its highest voucher and the escrow refunds the rest to the float.
 * `close()` in payees.ts only finishes a session when the PAYEE answers the account's close with a 200; here the payee answers
 * "channel-finalized", and `escrow.requestClose` says the same, so the answer is a refusal and nothing is tidied. From then on the session
 * is "open" for ever, its share of the budget stays set aside for ever, the payment row stays "pending", and the statement counts the
 * refunded deposit a second time as money "held". No instruction — the agent's or the owner's — clears it. */
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
  const home = mkdtempSync(join(tmpdir(), "attack-session-close-"));
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

describe("B · the payee closes a session's channel itself", () => {
  it.fails("the payee closes the channel itself: the session is 'open' for ever, its budget stays set aside, and the statement counts the refund twice", async () => {
    const x = await boot();
    x.world.infer.depositMicro = 20_000_000;
    expect(code(await x.payOk("0.05"))).toBe("payment");
    expect(code(await x.pay("0.05"))).toBe("payment");
    const session = x.engine.payments.find((p) => p.protocol === "mpp-session")!;
    const channel = session.legs[0]!.ref!;
    const before = (await x.engine.view()).totalUsd;

    // the payee settles its last voucher and closes: two cents to it, the rest of the deposit back to the float
    const last = x.world.infer.accepted.get(channel)!;
    expect(await x.world.escrow.settle(x.world.infer.recipient, channel, last.cumulative, last.signature, true)).toMatchObject({ paid: 20_000, refund: 19_980_000 });
    expect([x.start - x.float(), x.world.chain.balance(x.world.escrow.address)]).toEqual([20_000, 0]);

    // the agent can neither use the session nor close it
    expect(code(await x.pay("0.05"))).toBe("E_PAYEE_REJECTED");
    expect(code(await x.pay("0", true))).toBe("E_PAYEE_REJECTED");
    await x.pass(5 * DAY);
    const view = await x.engine.view();
    expect(view.pay.sessions.map((s) => s.status)).toEqual(["open"]);
    expect(session.status).toBe("pending");
    // $19.98 of a $40 budget is set aside for a deposit that is already back in the float
    const budgetLockedForEver = x.spend().reservedMicro;
    expect(budgetLockedForEver).toBe(19_980_000);
    // and the statement shows $19.98 more than the user has: once in the float, once as "held"
    expect([view.heldUsd, Number((view.totalUsd - before).toFixed(2))]).toEqual([19.98, 19.98]);
  });
});
