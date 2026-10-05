/** AN ATTACK THAT MUST FAIL (found by an independent review on 2026-10-04, written as it succeeded then, and run with `it.fails`:
 * this test passes only while the attack below does NOT go through) — attacker B, a payee the owner has approved once.
 *
 * To open an MPP session the account SIGNS the escrow's `open` transaction (the deposit) and hands it to the payee to broadcast. If the payee
 * answers 402 and broadcasts nothing, the account says "did not accept it" and forgets the transaction (payees.ts: `if (!chan) return refused(res)`)
 * — nothing is set aside, unlike a refused EIP-3009 authorisation, which is now held until it expires. The payee still holds a signed
 * transaction. Broadcast later, each one moves a deposit out of the float into an escrow channel the account does not know it has: no session,
 * no payment row, no budget used, and nobody ever asks for it back. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isRefusal } from "../../src/core/errors.ts";
import { cardHash, type Outcome } from "../../src/portfolio/account/exchange.ts";
import * as X from "../../src/portfolio/account/protocols.ts";
import { signAgent, signOwner, simKey, type AgentAction, type Hex, type OwnerAction } from "../../src/portfolio/account/sign.ts";
import { PortfolioService } from "../../src/portfolio/service.ts";

const START = Date.parse("2026-10-05T14:00:00.000Z");
const MIN = 60_000;
const DAY = 86_400_000;
const STREAM = "https://infer.sim/v1/stream";
const owner = simKey("owner");
const cc = simKey("agent:claude-code");
const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));

interface Call { method: string; url: URL; header(name: string): string | undefined; body: unknown; nowMs: number }
interface Res { status: number; headers: Record<string, string>; body?: unknown }
type Handler = (c: Call) => Promise<Res> | Res;
const hostsOf = (world: unknown) => (world as { hosts: Map<string, Handler> }).hosts;
const code = (o: Outcome): string => (isRefusal(o) ? o.code : o.kind);

describe("B · a session's signed open transaction, kept by a payee that says no", () => {
  it.fails("two refused opens become $40 locked in escrow two days later: the budget shows nothing, the account knows of no session", async () => {
    let t = START;
    let n = 0;
    const home = mkdtempSync(join(tmpdir(), "attack-open-"));
    homes.push(home);
    const svc = await PortfolioService.create({ home, now: () => new Date(t).toISOString(), venues: "frontline", account: { owners: [{ id: owner.address, kind: "eoa", label: "owner", addedAt: new Date(START).toISOString() }] } });
    const engine = svc.account!;
    const world = svc.payees!;
    const own = async (a: Record<string, unknown>) => svc.exchange(await signOwner(owner, { ...a, nonce: t + ++n } as OwnerAction));
    const pay = async (maxAmount: string, close = false) => svc.exchange(await signAgent(cc, { type: "agentPay", url: STREAM, maxAmount, fromSubAccount: "research", ...(close ? { close: true } : {}), nonce: t + ++n } as AgentAction));
    await own({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: t + 30 * DAY });
    await own({ type: "createSubAccount", name: "research", agent: cc.address, float: "60" });
    const fund = { destination: "self", sourceDex: "metamask", destinationDex: "sub:research", token: "USDC", amount: "50" };
    const route = await engine.resolve(fund, "owner");
    if (isRefusal(route)) throw new Error(route.message);
    await own({ type: "sendAsset", ...fund, fromSubAccount: "", route: route.route.hash, maxFee: String(route.route.feeUsd), deadline: route.route.arrivalMs + MIN });
    t += 2 * MIN;
    await engine.settle();
    await own({ type: "approveSpend", agent: cc.address, scope: "payees", allow: "infer.sim", perPayment: "30", budget: "40", windowHours: 0, validUntil: t + 30 * DAY });
    const float = () => engine.sub("research")!.balanceMicro;
    const spend = () => engine.state.spends.find((s) => s.scope === "payees" && s.revokedAt === undefined)!;
    const start = float();

    // one honest session, so the owner has met the payee and pinned its address; it is closed again
    world.infer.depositMicro = 20_000_000;
    const first = await pay("0.05");
    if (isRefusal(first) || first.kind !== "card") throw new Error(`expected a card, got ${code(first)}`);
    expect(code(await own({ type: "approveCard", card: first.card.id, action: cardHash(first.card), decision: "approve" }))).toBe("payment");
    expect(code(await pay("0", true))).toBe("payment");
    expect([start - float(), spend().spentMicro, spend().reservedMicro]).toEqual([10_000, 10_000, 0]);

    // now the payee answers every `open` with a plain 402 and keeps the signed transaction
    const honest = world.infer.handle;
    const kept: Hex[] = [];
    hostsOf(world).set("infer.sim", async (c) => {
      const payload = X.mppReadAuthorization(c.header("authorization"))?.payload as { action?: string; transaction?: Hex } | undefined;
      if (payload?.action !== "open" || !payload.transaction) return honest(c);
      kept.push(payload.transaction);
      return honest({ ...c, header: () => undefined });
    });
    expect(code(await pay("0.05"))).toBe("E_PAYEE_REJECTED");
    expect(code(await pay("0.05"))).toBe("E_PAYEE_REJECTED");
    // nothing moved, and — unlike a refused authorisation — nothing is set aside
    expect([start - float(), spend().reservedMicro, kept.length]).toEqual([10_000, 0, 2]);

    // later, the payee broadcasts what it was handed
    for (const raw of kept) {
      // (as the signed transaction: there is no other way into the escrow. It reverts — the float's key spent that nonce when the open was refused)
      expect(typeof (await world.escrow.broadcast(raw))).toBe("object");
    }
    t += 2 * DAY;
    const view = await engine.view();
    const lockedInEscrow = world.chain.balance(world.escrow.address);
    const unknownToTheAccount = view.pay.sessions.every((s) => s.status === "closed") && engine.payments.filter((p) => p.protocol === "mpp-session").length === 1;
    expect([start - float(), lockedInEscrow, unknownToTheAccount]).toEqual([40_010_000, 40_000_000, true]);
    // the approval's books: one cent spent, nothing held — while $40 of the float is gone
    expect([spend().spentMicro, spend().reservedMicro]).toEqual([10_000, 0]);
  });
});
