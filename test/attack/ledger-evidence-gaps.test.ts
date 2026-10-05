/** AN ATTACK THAT MUST FAIL (found by an independent review on 2026-10-04, written as it succeeded then, and run with `it.fails`:
 * this test passes only while the attack below does NOT go through) — invariant 7: "the ledger rows are evidence: hash chain, embedded envelopes".
 *
 * The door logs the signed envelope for a transfer, a swap, a single payment and every refusal. Three kinds of accepted, signed agent
 * instruction leave rows with NO envelope and NO signer, so nothing on the ledger proves which key asked:
 *   · `agentExecute` / `agentOrder` that went through (the rows are the older path's `intent` and `venue`);
 *   · every call inside a payment session after the first (`mpp voucher`) — each is its own signed `agentPay`, and each moves money;
 *   · closing a session (`escrow.close`).
 * (And because `rememberNonces` rebuilds the nonce books from rows that carry an envelope, these instructions are also not remembered across
 * a restart — an agent's typed data admits no fractional nonce, so that replay is blocked only by the ten-minute lifetime.) */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isRefusal } from "../../src/core/errors.ts";
import { cardHash, type Outcome } from "../../src/portfolio/account/exchange.ts";
import { signAgent, signOwner, simKey, type AgentAction, type OwnerAction } from "../../src/portfolio/account/sign.ts";
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

describe("the ledger does not hold the signed instruction behind every accepted write", () => {
  it.fails("a trade through agentExecute, a session's later calls and its close: rows without an envelope or a signer", async () => {
    let t = START;
    let n = 0;
    const home = mkdtempSync(join(tmpdir(), "attack-evidence-"));
    homes.push(home);
    const svc = await PortfolioService.create({ home, now: () => new Date(t).toISOString(), venues: "frontline", account: { owners: [{ id: owner.address, kind: "eoa", label: "owner", addedAt: new Date(START).toISOString() }] } });
    const engine = svc.account!;
    const own = async (a: Record<string, unknown>) => svc.exchange(await signOwner(owner, { ...a, nonce: t + ++n } as OwnerAction));
    const ag = async (a: Record<string, unknown>) => svc.exchange(await signAgent(cc, { ...a, nonce: t + ++n } as AgentAction));
    const pay = (extra: Record<string, unknown> = {}) => ag({ type: "agentPay", url: STREAM, maxAmount: "0.05", fromSubAccount: "research", ...extra });
    await own({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: t + 30 * DAY });
    await own({ type: "createSubAccount", name: "research", agent: cc.address, float: "60" });
    const fund = { destination: "self", sourceDex: "metamask", destinationDex: "sub:research", token: "USDC", amount: "50" };
    const route = await engine.resolve(fund, "owner");
    if (isRefusal(route)) throw new Error(route.message);
    await own({ type: "sendAsset", ...fund, fromSubAccount: "", route: route.route.hash, maxFee: String(route.route.feeUsd), deadline: route.route.arrivalMs + MIN });
    t += 2 * MIN;
    await engine.settle();
    await own({ type: "approveSpend", agent: cc.address, scope: "payees", allow: "infer.sim", perPayment: "30", budget: "40", windowHours: 0, validUntil: t + 30 * DAY });
    /** the rows an instruction left behind, as `kind/tool/outcome`, and whether any of them can prove who asked */
    const rowsOf = async (act: () => Promise<Outcome>) => {
      const from = svc.rows().length;
      const out = await act();
      const rows = svc.rows().slice(from);
      return { out, rows: rows.map((r) => `${r.kind}/${r.tool ?? ""}/${r.outcome ?? ""}`), proof: rows.some((r) => r.envelope !== undefined || r.signer !== undefined) };
    };

    // 1 · a trade under the agent's key
    const trade = await rowsOf(() => ag({ type: "agentExecute", account: "binance", intent: { kind: "trade", symbol: "BTCUSDT", side: "buy", qty: 0.001 } }));
    expect((trade.out as { result: { status: string } }).result.status).toBe("filled");
    expect([trade.rows, trade.proof]).toEqual([["note//", "intent/portfolio_trade/", "venue/portfolio_trade/filled"], false]);

    // the session's first call does carry its envelope (through the card)
    const first = await pay();
    if (isRefusal(first) || first.kind !== "card") throw new Error(`expected a card, got ${code(first)}`);
    expect(code(await own({ type: "approveCard", card: first.card.id, action: cardHash(first.card), decision: "approve" }))).toBe("payment");

    // 2 · the second call: money moves on the agent's signature, and the ledger keeps no signature
    const second = await rowsOf(() => pay());
    expect(code(second.out)).toBe("payment");
    expect([second.rows, second.proof]).toEqual([["note//", "payment/mpp voucher/accepted"], false]);

    // 3 · closing the session
    const closed = await rowsOf(() => pay({ maxAmount: "0", close: true }));
    expect(code(closed.out)).toBe("payment");
    expect([closed.rows, closed.proof]).toEqual([["note//", "payment/escrow.close/settled"], false]);

    expect(svc.verifyChain().ok).toBe(true);
  });
});
