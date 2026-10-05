/** AN ATTACK THAT MUST FAIL (found by an independent review on 2026-10-04, written as it succeeded then, and run with `it.fails`:
 * this test passes only while the attack below does NOT go through) — attacker B, a payee the owner has approved once.
 *
 * The payee TAKES the payment (the token ledger moves, or the card is charged) and then answers with a receipt the account's code trips over:
 * x402 `payer: 5` (payees.ts `sameAddress(res.payer, …)` calls `.toLowerCase()` on a number), ACP a body of `5` (`"status" in final`), AP2 a
 * receipt that is not a string. The throw is caught in `pay()` and turned into "…could not read: nothing further was sent" — but `book()` never
 * ran: the approval's budget is not charged, no payment row exists, the ledger has no accepted row. The next call passes the same budget check.
 * An agent that retries an error (or one that works with the payee) empties the float past the budget; the books say one payment happened. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isRefusal } from "../../src/core/errors.ts";
import { cardHash, type Outcome } from "../../src/portfolio/account/exchange.ts";
import * as X from "../../src/portfolio/account/protocols.ts";
import { signAgent, signOwner, simKey, type AgentAction, type OwnerAction } from "../../src/portfolio/account/sign.ts";
import { PortfolioService } from "../../src/portfolio/service.ts";

const START = Date.parse("2026-10-05T14:00:00.000Z");
const MIN = 60_000;
const DAY = 86_400_000;
const QUOTE = "https://data.sim/v1/quotes?symbol=NVDA";
const ITEM = "https://shop.sim/items/desk-feed-pro";
const owner = simKey("owner");
const cc = simKey("agent:claude-code");
const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));

interface Call { method: string; url: URL; header(name: string): string | undefined; body: unknown; nowMs: number }
interface Res { status: number; headers: Record<string, string>; body?: unknown }
type Handler = (c: Call) => Promise<Res> | Res;
/** the attacker's seat: whatever a payee host answers */
const hostsOf = (world: unknown) => (world as { hosts: Map<string, Handler> }).hosts;
const code = (o: Outcome): string => (isRefusal(o) ? o.code : o.kind);

/** an account with one agent key, a float of $50 called `research`, and a payees approval: $30 a payment */
async function boot(budget: string) {
  let t = START;
  let n = 0;
  const home = mkdtempSync(join(tmpdir(), "attack-payee-"));
  homes.push(home);
  const svc = await PortfolioService.create({ home, now: () => new Date(t).toISOString(), venues: "frontline", account: { owners: [{ id: owner.address, kind: "eoa", label: "owner", addedAt: new Date(START).toISOString() }] } });
  const engine = svc.account!;
  const own = async (a: Record<string, unknown>) => svc.exchange(await signOwner(owner, { ...a, nonce: t + ++n } as OwnerAction));
  const pay = async (url: string, maxAmount: string, from: string) => svc.exchange(await signAgent(cc, { type: "agentPay", url, maxAmount, fromSubAccount: from, nonce: t + ++n } as AgentAction));
  /** pay, and — when the account asks the owner first — approve */
  const payOk = async (url: string, maxAmount: string, from: string) => {
    const r = await pay(url, maxAmount, from);
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
  await own({ type: "approveSpend", agent: cc.address, scope: "payees", allow: "data.sim,shop.sim", perPayment: "30", budget, windowHours: 0, validUntil: t + 30 * DAY });
  const float = () => engine.sub("research")!.balanceMicro;
  const spend = () => engine.state.spends.find((s) => s.scope === "payees" && s.revokedAt === undefined)!;
  return { svc, engine, world: svc.payees!, pay, payOk, float, spend, start: float() };
}

describe("B · the payee takes the money, then sends a receipt the account cannot read", () => {
  it.fails("x402: four $9 payments leave the float, none is booked, and the $40 budget is passed", async () => {
    const x = await boot("40");
    x.world.data.priceMicro = 9_000_000;
    expect(code(await x.payOk(QUOTE, "9", "research"))).toBe("payment");
    expect([x.start - x.float(), x.spend().spentMicro]).toEqual([9_000_000, 9_000_000]);

    // from here the payee settles honestly and lies only in the shape of its receipt: `payer` is a number
    const honest = x.world.data.handle;
    hostsOf(x.world).set("data.sim", async (c) => {
      const res = await honest(c);
      const receipt = res.headers["payment-response"];
      return receipt ? { ...res, headers: { ...res.headers, "payment-response": X.b64json({ ...X.unb64json<Record<string, unknown>>(receipt)!, payer: 5 }) } } : res;
    });
    const answers: Outcome[] = [];
    for (let i = 0; i < 4; i++) answers.push(await x.pay(QUOTE, "9", "research"));
    // the agent is told nothing was sent
    expect(answers.map(code)).toEqual(["E_PAYEE_UNVERIFIED", "E_PAYEE_UNVERIFIED", "E_PAYEE_UNVERIFIED", "E_PAYEE_UNVERIFIED"]);
    expect(isRefusal(answers[0]!) && answers[0]!.message).toContain("nothing further was sent");

    const leftTheFloat = x.start - x.float();
    const spentBeyondBudget = leftTheFloat > x.spend().budgetMicro;
    expect([leftTheFloat, x.world.chain.balance(x.world.data.payTo), spentBeyondBudget]).toEqual([45_000_000, 45_000_000, true]);
    // and the books know of one payment of $9
    expect(x.spend().spentMicro).toBe(9_000_000);
    expect(x.engine.payments.filter((p) => p.kind === "pay")).toHaveLength(1);
    expect(x.svc.rows().filter((r) => r.tool === "agentPay" && r.outcome === "accepted")).toHaveLength(1);
  });

  it.fails("ACP: the card is charged twice more and neither charge is on the books", async () => {
    const x = await boot("100");
    const available = async () => (await x.svc.read("mastercard"))[0]!.amount;
    const before = await available();
    expect(code(await x.payOk(ITEM, "30", ""))).toBe("payment");
    // the shop completes the checkout (its processor charges the card) and answers 200 with a body that is not an object
    const shop = x.world.shop.handle;
    hostsOf(x.world).set("shop.sim", async (c) => {
      const res = await shop(c);
      return /\/complete$/.test(c.url.pathname) && res.status === 200 ? { ...res, body: 5 } : res;
    });
    expect(code(await x.pay(ITEM, "30", ""))).toBe("E_PAYEE_UNVERIFIED");
    expect(code(await x.pay(ITEM, "30", ""))).toBe("E_PAYEE_UNVERIFIED");

    const charged = before - (await available());
    expect(charged).toBe(87);
    const chargedButNotBooked = charged * 1e6 - x.spend().spentMicro;
    expect([x.spend().spentMicro, chargedButNotBooked]).toEqual([29_000_000, 58_000_000]);
    expect(x.engine.payments.filter((p) => p.protocol === "acp")).toHaveLength(1);
  });
});
