/** AN ATTACK THAT MUST FAIL (found by an independent review on 2026-10-04, written as it succeeded then, and run with `it.fails`:
 * this test passes only while the attack below does NOT go through) — attacker B, a shop the owner has approved once (plus anyone on the wire).
 *
 * "A payee is reached over https, at a plain host": `pay()` refuses an `http:` URL from the agent. But the URLs a payee then SUPPLIES are
 * only compared by host — `hostOf(acp.sessions)`, `hostOf(acp.delegate_payment)`, `hostOf(ap2.checkouts)` — never by scheme. The processor
 * is now shown on the first card and pinned with the merchant, yet what is pinned is `psp.sim`, not `https://psp.sim`. So after the owner's
 * approval the shop's page can say `http://psp.sim/…` and the card credential (the agentic token's reference and an allowance to charge it)
 * is posted in clear, with no card and no refusal. The same holds for the AP2 payment credential and the ACP checkout calls. */
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
const ITEM = "https://shop.sim/items/desk-feed-pro";
const owner = simKey("owner");
const cc = simKey("agent:claude-code");
const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));

interface Call { method: string; url: URL; header(name: string): string | undefined; body: unknown; nowMs: number }
interface Res { status: number; headers: Record<string, string>; body?: unknown }
type Handler = (c: Call) => Promise<Res> | Res;
const hostsOf = (world: unknown) => (world as { hosts: Map<string, Handler> }).hosts;
const code = (o: Outcome): string => (isRefusal(o) ? o.code : o.kind);

describe("B · the shop's page gives the processor's address as http://", () => {
  it.fails("the card credential is posted in clear: the pin holds the host, not the scheme", async () => {
    let n = 0;
    const home = mkdtempSync(join(tmpdir(), "attack-http-psp-"));
    homes.push(home);
    const svc = await PortfolioService.create({ home, now: () => new Date(START).toISOString(), venues: "frontline", account: { owners: [{ id: owner.address, kind: "eoa", label: "owner", addedAt: new Date(START).toISOString() }] } });
    const world = svc.payees!;
    const own = async (a: Record<string, unknown>) => svc.exchange(await signOwner(owner, { ...a, nonce: START + ++n } as OwnerAction));
    const buy = async (url = ITEM) => svc.exchange(await signAgent(cc, { type: "agentPay", url, maxAmount: "30", fromSubAccount: "", nonce: START + ++n } as AgentAction));
    await own({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: START + 30 * DAY });
    await own({ type: "approveSpend", agent: cc.address, scope: "payees", allow: "shop.sim", perPayment: "30", budget: "100", windowHours: 0, validUntil: START + 30 * DAY });

    // the agent's own URL has to be https
    expect(code(await buy("http://shop.sim/items/desk-feed-pro"))).toBe("E_ACCOUNT_BAD_ACTION");
    // the first purchase: the owner sees the merchant and its processor, and approves
    const first = await buy();
    if (isRefusal(first) || first.kind !== "card") throw new Error(`expected a card, got ${code(first)}`);
    expect(first.card.offer).toMatchObject({ payee: "shop.sim", payTo: "merchant_shop_sim via psp.sim" });
    expect(code(await own({ type: "approveCard", card: first.card.id, action: cardHash(first.card), decision: "approve" }))).toBe("payment");

    // a different processor HOST is now refused…
    world.shop.processorUrl = "https://evil.sim/agentic_commerce/delegate_payment";
    expect(code(await buy())).toBe("E_PAYEE_CHANGED");
    // …the same host over plain http is not
    world.shop.processorUrl = "http://psp.sim/agentic_commerce/delegate_payment";
    const psp = world.psp.handle as unknown as Handler;
    const seen: Array<{ scheme: string; tokenRef: unknown; allowance: unknown }> = [];
    hostsOf(world).set("psp.sim", (c) => {
      const body = c.body as { payment_method?: { token_ref?: unknown }; allowance?: unknown } | undefined;
      seen.push({ scheme: c.url.protocol, tokenRef: body?.payment_method?.token_ref, allowance: body?.allowance });
      return psp(c);
    });
    const second = await buy();
    expect(code(second)).toBe("payment");
    const cardCredentialSentInClear = seen.some((s) => s.scheme === "http:" && s.tokenRef === "home/credentials/mastercard/agentic-token.json");
    expect(seen.map((s) => s.scheme)).toEqual(["http:"]);
    expect(cardCredentialSentInClear).toBe(true);
    expect(seen[0]!.allowance).toMatchObject({ max_amount: 2900, merchant_id: "merchant_shop_sim" });
  });
});
