/** AN ATTACK THAT MUST FAIL (found by an independent review on 2026-10-04, written as it succeeded then, and run with `it.fails`:
 * this test passes only while the attack below does NOT go through) — attacker B, a payee the owner has approved once (or simply a payee that is broken).
 *
 * Instructions are now taken one at a time (`exchange()` chains every call on one promise), and a payment waits on the payee inside its turn
 * (`PayeeWorld.fetch` has no time limit). A payee that accepts the request and never answers therefore holds the door shut for everybody:
 * the owner's own instructions — revoke the agent's key, reset — queue behind it and never run. The only controls left are the unsigned
 * tightening routes (`/api/mode`, `/api/revoke`), which do not go through the door. */
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
const QUOTE = "https://data.sim/v1/quotes?symbol=NVDA";
const owner = simKey("owner");
const cc = simKey("agent:claude-code");
const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));
const code = (o: Outcome): string => (isRefusal(o) ? o.code : o.kind);
/** what a caller sees after half a second */
const within = (p: Promise<Outcome>, ms = 500): Promise<string> => Promise.race([p.then(code), new Promise<string>((r) => setTimeout(() => r("NO ANSWER"), ms))]);

describe("B · a payee that never answers", () => {
  it.fails("the agent's payment hangs — and so does every instruction after it, the owner's included", async () => {
    let t = START;
    let n = 0;
    const home = mkdtempSync(join(tmpdir(), "attack-hang-"));
    homes.push(home);
    const svc = await PortfolioService.create({ home, now: () => new Date(t).toISOString(), venues: "frontline", account: { owners: [{ id: owner.address, kind: "eoa", label: "owner", addedAt: new Date(START).toISOString() }] } });
    const engine = svc.account!;
    const own = async (a: Record<string, unknown>) => svc.exchange(await signOwner(owner, { ...a, nonce: t + ++n } as OwnerAction));
    const pay = async () => svc.exchange(await signAgent(cc, { type: "agentPay", url: QUOTE, maxAmount: "0.05", fromSubAccount: "research", nonce: t + ++n } as AgentAction));
    await own({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: t + 30 * DAY });
    await own({ type: "createSubAccount", name: "research", agent: cc.address, float: "60" });
    const fund = { destination: "self", sourceDex: "metamask", destinationDex: "sub:research", token: "USDC", amount: "50" };
    const route = await engine.resolve(fund, "owner");
    if (isRefusal(route)) throw new Error(route.message);
    await own({ type: "sendAsset", ...fund, fromSubAccount: "", route: route.route.hash, maxFee: String(route.route.feeUsd), deadline: route.route.arrivalMs + MIN });
    t += 2 * MIN;
    await engine.settle();
    await own({ type: "approveSpend", agent: cc.address, scope: "payees", allow: "data.sim", perPayment: "30", budget: "40", windowHours: 0, validUntil: t + 30 * DAY });
    const first = await pay();
    if (isRefusal(first) || first.kind !== "card") throw new Error(`expected a card, got ${code(first)}`);
    expect(code(await own({ type: "approveCard", card: first.card.id, action: cardHash(first.card), decision: "approve" }))).toBe("payment");

    // (a payee is waited for three seconds by default; the test does not wait that long)
    svc.payees!.timeoutMs = 100;
    // the payee stops answering: the connection opens, nothing ever comes back
    (svc.payees as unknown as { hosts: Map<string, () => Promise<never>> }).hosts.set("data.sim", () => new Promise<never>(() => {}));
    expect(await within(pay())).toBe("NO ANSWER");

    // the owner wants the agent's key gone. The instruction is signed, sent — and never taken
    const revoke = own({ type: "approveAgent", agentAddress: ZERO, agentName: "Claude Code", validUntil: 0 });
    expect(await within(revoke)).toBe("NO ANSWER");
    const reset = own({ type: "setPolicy", change: "reset", value: "" });
    expect(await within(reset)).toBe("NO ANSWER");
    const ownerLockedOutOfTheDoor = engine.state.agents.some((k) => k.address === cc.address && k.revokedAt === undefined);
    expect(ownerLockedOutOfTheDoor).toBe(true);
  });
});
