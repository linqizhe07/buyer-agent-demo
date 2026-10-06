/** Attack on the owner's answer to an agent's ask (answerAsk), which is signed by the ask's id:
 *
 *   reworded   the agent asks again — same kind, same venue — while the owner reads the first words: "raise my trading budget to $1,000"
 *              becomes "…to $300, just to finish SOL". Asking again takes a NEW id, so the decline the owner signs for the words they read
 *              is not taken for words they never saw: it is refused, naming the ask that took its place, and that ask stays waiting. A
 *              decline of the new id is taken as usual; and an ask asked again twice is still found from the first id
 *
 * The account runs on a temporary home; nothing leaves the process. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isRefusal, type Refusal } from "../../src/core/errors.ts";
import { signAgent, signOwner, simKey, type AgentAction, type OwnerAction } from "../../src/portfolio/account/sign.ts";
import { PortfolioService } from "../../src/portfolio/service.ts";

type NoNonce<T> = T extends unknown ? Omit<T, "nonce"> : never;
const START = Date.parse("2026-10-06T10:00:00.000Z");
const DAY = 86_400_000;
const owner = simKey("owner");
const cc = simKey("agent:reworded-claude-code");
const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));
const refusal = (r: unknown): Refusal => {
  if (!isRefusal(r)) throw new Error(`expected a refusal, got ${JSON.stringify(r).slice(0, 200)}`);
  return r;
};

async function run() {
  const home = mkdtempSync(join(tmpdir(), "ask-reworded-"));
  homes.push(home);
  let t = START;
  let n = 0;
  const svc = await PortfolioService.create({ home, now: () => new Date(t).toISOString(), venues: "frontline", real: true, liveDeps: { clock: () => t }, liveWrites: { capUsd: 1000, pairingCode: "K7QX-M2PA" }, publicMarkets: [], account: { owners: [{ id: owner.address, kind: "eoa" as const, label: "owner", addedAt: new Date(START).toISOString() }] } });
  await svc.restoring;
  const own = async (a: NoNonce<OwnerAction>) => svc.exchange(await signOwner(owner, { ...a, nonce: t + ++n } as OwnerAction));
  const ag = async (a: NoNonce<AgentAction>) => svc.exchange(await signAgent(cc, { ...a, nonce: t + ++n } as AgentAction));
  const asked = async (usd: string, text: string): Promise<{ id: string; replaced: boolean }> => {
    const r = await ag({ type: "agentAsk", kind: "limit", venue: "", usd, text });
    if (isRefusal(r) || r.kind !== "result") throw new Error("the ask was not taken");
    const res = r.result as { ask: { id: string }; replaced: boolean };
    return { id: res.ask.id, replaced: res.replaced };
  };
  return { svc, engine: svc.account!, own, asked, pass: (ms: number) => void (t += ms) };
}

describe("a decline is of the words the owner was shown", () => {
  it("an ask asked again while the owner reads it takes a new id: the decline of the old words is refused, and the new ask stays", async () => {
    const r = await run();
    await r.own({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: START + 30 * DAY });
    const shown = await r.asked("1000", "Raise my trading budget to $1,000");
    // while the owner's confirm is open, the agent asks again: the same kind and venue, other words, another sum
    r.pass(5_000);
    const now = await r.asked("300", "…to $300, just to finish SOL");
    expect(now.replaced).toBe(true);
    expect(now.id).not.toBe(shown.id);
    expect((await r.engine.view()).asks.map((a) => [a.id, a.usd, a.text])).toEqual([[now.id, "300", "…to $300, just to finish SOL"]]);
    // the owner signs the decline of what they read
    const no = refusal(await r.own({ type: "answerAsk", ask: shown.id, decision: "decline" }));
    expect([no.code, no.detail]).toEqual(["E_ACCOUNT_BAD_ACTION", { ask: shown.id, now: now.id }]);
    expect(no.message).toBe(`Claude Code changed this ask since it was shown (it is ${now.id} now): read it again, then answer that one`);
    const page = await r.engine.view();
    expect([page.asks.map((a) => a.id), page.declinedAsks]).toEqual([[now.id], []]);
    // read again and declined: taken
    expect(await r.own({ type: "answerAsk", ask: now.id, decision: "decline" })).toMatchObject({ ok: true, kind: "account" });
    expect((await r.engine.view()).declinedAsks.map((a) => [a.id, a.usd])).toEqual([[now.id, "300"]]);
  });

  it("asked again twice: the first id still names the ask that waits now; once that is answered, the first id is simply gone", async () => {
    const r = await run();
    await r.own({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: START + 30 * DAY });
    const first = await r.asked("1000", "one");
    const second = await r.asked("600", "two");
    const third = await r.asked("300", "three");
    expect(new Set([first.id, second.id, third.id]).size).toBe(3);
    expect(refusal(await r.own({ type: "answerAsk", ask: first.id, decision: "decline" })).detail).toEqual({ ask: first.id, now: third.id });
    expect(refusal(await r.own({ type: "answerAsk", ask: second.id, decision: "decline" })).detail).toEqual({ ask: second.id, now: third.id });
    expect(await r.own({ type: "answerAsk", ask: third.id, decision: "decline" })).toMatchObject({ ok: true });
    expect(refusal(await r.own({ type: "answerAsk", ask: first.id, decision: "decline" })).message).toMatch(/there is no waiting ask/);
  });
});
