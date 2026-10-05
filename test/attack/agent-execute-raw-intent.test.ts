/** AN ATTACK THAT MUST FAIL (found by an independent review on 2026-10-04, written as it succeeded then, and run with `it.fails`:
 * this test passes only while the attack below does NOT go through) — attacker A, an agent with an authorised key (no spending approval needed).
 *
 * `agentExecute` — the older single-account write, "now under the agent's key" — forwards `action.intent` to the service as it arrived. The
 * route it replaced (`POST /api/execute`) ran `parseIntent`, which refuses a size that is not more than zero; the MCP seat's schema does
 * too, but the agent signs its own envelope and the door checks only that the kind is not `move` or `pay`. A subscription of −$1,000 reaches
 * the venue (which here turns it into an instant redemption, no T+1) and is written to the ledger as −$1,000 moved — which is what Guard's
 * 24-hour cap adds up. The "hard line" now has $1,000 more room, and the agent can give it as much as it likes. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isRefusal } from "../../src/core/errors.ts";
import type { Outcome } from "../../src/portfolio/account/exchange.ts";
import { signAgent, signOwner, simKey, type AgentAction, type OwnerAction } from "../../src/portfolio/account/sign.ts";
import { parseIntent } from "../../src/portfolio/server.ts";
import { PortfolioService } from "../../src/portfolio/service.ts";

const START = Date.parse("2026-10-05T14:00:00.000Z");
const DAY = 86_400_000;
const owner = simKey("owner");
const cc = simKey("agent:claude-code");
const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));
const code = (o: Outcome): string => (isRefusal(o) ? o.code : o.kind);

async function boot() {
  let n = 0;
  const home = mkdtempSync(join(tmpdir(), "attack-execute-"));
  homes.push(home);
  const svc = await PortfolioService.create({ home, now: () => new Date(START).toISOString(), venues: "frontline", account: { owners: [{ id: owner.address, kind: "eoa", label: "owner", addedAt: new Date(START).toISOString() }] } });
  const execute = async (account: string, intent: Record<string, unknown>) => svc.exchange(await signAgent(cc, { type: "agentExecute", account, intent, nonce: START + ++n } as AgentAction));
  await svc.exchange(await signOwner(owner, { type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: START + 30 * DAY, nonce: START + ++n } as OwnerAction));
  return { svc, execute };
}

describe("A · agentExecute forwards whatever intent the agent signed", () => {
  it.fails("a subscription of −$1,000 goes through, and Guard's 24-hour figure goes below zero", async () => {
    const x = await boot();
    x.svc.setMode("guard");
    const intent = { kind: "subscribe", fund: "OUSG", amountUsd: -1000 };
    // the check the unsigned route used to make
    expect(parseIntent(intent)).toBeNull();
    const usdc = async () => (await x.svc.read("ondo")).find((h) => h.asset === "USDC")!.amount;
    const before = await usdc();

    const out = await x.execute("ondo", intent);
    expect(code(out)).toBe("result");
    const result = (out as { result: { ok: boolean; status: string; usd: number } }).result;
    // no card in Guard mode, and the venue took it
    expect([result.ok, result.status, result.usd]).toEqual([true, "minted", -1000]);
    expect((await usdc()) - before).toBe(1000);
    const movedInTheLastDay = x.svc.dailyOutUsd(new Date(START).toISOString());
    const guardCapHasMoreRoomThanTheOwnerSet = movedInTheLastDay < 0;
    expect([movedInTheLastDay, guardCapHasMoreRoomThanTheOwnerSet]).toEqual([-1000, true]);
  });
});
