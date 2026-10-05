import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isRefusal, type Refusal } from "../../src/core/errors.ts";
import { cardHash, type Outcome } from "../../src/portfolio/account/exchange.ts";
import { cosign, signAgent, signDevice, signOwner, simKey, ZERO, type AgentAction, type Hex, type OwnerAction, type SimKey } from "../../src/portfolio/account/sign.ts";
import { PortfolioService } from "../../src/portfolio/service.ts";

type NoNonce<T> = T extends unknown ? Omit<T, "nonce"> : never;
const START = Date.parse("2026-10-03T09:30:00.000Z");
const MIN = 60_000;
const DAY = 86_400_000;
const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));

const owner = simKey("owner");
const cc = simKey("agent:claude-code");
const codex = simKey("agent:codex");

async function boot(opts: { owners?: boolean } = {}) {
  let t = START;
  let n = 0;
  const home = mkdtempSync(join(tmpdir(), "account-exchange-"));
  homes.push(home);
  const svc = await PortfolioService.create({ home, now: () => new Date(t).toISOString(), venues: "frontline", account: opts.owners === false ? {} : { owners: [{ id: owner.address, kind: "eoa", label: "owner", addedAt: new Date(START).toISOString() }] } });
  const engine = svc.account!;
  const nonce = () => t + ++n;
  const own = async (a: NoNonce<OwnerAction>, by: SimKey = owner) => svc.exchange(await signOwner(by, { ...a, nonce: nonce() } as OwnerAction));
  const ag = async (key: SimKey, a: NoNonce<AgentAction>) => svc.exchange(await signAgent(key, { ...a, nonce: nonce() } as AgentAction));
  const pass = async (ms: number) => {
    t += ms;
    await engine.settle();
  };
  /** the owner signs a movement the way the page does: ask for the route, sign its hash, its fee and its arrival */
  const send = async (a: { destination?: string; sourceDex: string; destinationDex: string; token?: string; amount: string }, over: Partial<{ route: Hex; maxFee: string; deadline: number }> = {}) => {
    const base = { destination: a.destination ?? "self", sourceDex: a.sourceDex, destinationDex: a.destinationDex, token: a.token ?? "USDC", amount: a.amount };
    const r = await engine.resolve(base, "owner");
    if (isRefusal(r)) return r;
    return own({ type: "sendAsset", ...base, fromSubAccount: "", route: r.route.hash, maxFee: String(r.route.feeUsd), deadline: r.route.arrivalMs + MIN, ...over });
  };
  const held = async (id: string, asset: string, note?: string) => (await svc.read(id)).filter((h) => h.asset === asset && !h.inTransit && (note === undefined || h.note === note || h.note?.startsWith(note))).reduce((s, h) => s + h.amount, 0);
  const authorise = (key: SimKey, name: string, days = 30) => own({ type: "approveAgent", agentAddress: key.address, agentName: name, validUntil: t + days * DAY });
  const approve = (key: SimKey, allow: string, perPayment: string, budget: string, windowHours = 0, scope = "venues") => own({ type: "approveSpend", agent: key.address, scope, allow, perPayment, budget, windowHours, validUntil: t + 30 * DAY });
  const transfer = (key: SimKey, sourceDex: string, destinationDex: string, amount: string, over: Partial<{ destination: string; maxFee: string; token: string }> = {}) => ag(key, { type: "agentSendAsset", destination: "self", sourceDex, destinationDex, token: "USDC", amount, fromSubAccount: "", maxFee: "5", ...over });
  return { svc, engine, own, ag, pass, send, held, authorise, approve, transfer, nonce, now: () => t, setNow: (ms: number) => void (t = ms) };
}

const code = (o: Outcome): string => (isRefusal(o) ? o.code : o.kind);
const refusal = (o: Outcome): Refusal => {
  if (!isRefusal(o)) throw new Error(`expected a refusal, got ${o.kind}`);
  return o;
};
const paid = (o: Outcome) => {
  if (isRefusal(o) || o.kind !== "payment") throw new Error(`expected a payment, got ${isRefusal(o) ? `${o.code}: ${o.message}` : o.kind}`);
  return o.payment;
};

describe("who may sign", () => {
  it("a key nobody authorised is refused, remembered for the owner, and its nonce is not spent", async () => {
    const x = await boot();
    const env = await signAgent(cc, { type: "agentSendAsset", destination: "self", sourceDex: "okx", destinationDex: "hyperliquid", token: "USDC", amount: "100", fromSubAccount: "", maxFee: "5", nonce: x.nonce() });
    expect(code(await x.svc.exchange(env))).toBe("E_ACCOUNT_UNKNOWN_SIGNER");
    expect(x.engine.state.requests.map((r) => r.address)).toEqual([cc.address]);
    expect(code(await x.authorise(cc, "Claude Code"))).toBe("account");
    expect(x.engine.state.requests).toEqual([]);
    // the very same envelope now gets a real answer (no approval yet), which shows its nonce was still good
    expect(code(await x.svc.exchange(env))).toBe("E_MANDATE_NONE");
  });

  it("an agent key cannot sign what is the owner's: authorising a key, approving spending, changing the account", async () => {
    const x = await boot();
    await x.authorise(cc, "Claude Code");
    expect(code(await x.own({ type: "approveAgent", agentAddress: codex.address, agentName: "Codex", validUntil: x.now() + DAY }, cc))).toBe("E_ACCOUNT_OWNER_ONLY");
    expect(code(await x.own({ type: "approveSpend", agent: cc.address, scope: "venues", allow: "*", perPayment: "1000000", budget: "1000000", windowHours: 0, validUntil: x.now() + DAY }, cc))).toBe("E_ACCOUNT_OWNER_ONLY");
    expect(code(await x.own({ type: "userSetAbstraction", abstraction: "unifiedAccount" }, cc))).toBe("E_ACCOUNT_OWNER_ONLY");
    expect(code(await x.own({ type: "setPolicy", change: "mode", value: "open" }, cc))).toBe("E_ACCOUNT_OWNER_ONLY");
    // and someone who is nobody at all
    expect(code(await x.own({ type: "userSetAbstraction", abstraction: "unifiedAccount" }, simKey("stranger")))).toBe("E_ACCOUNT_UNKNOWN_SIGNER");
  });

  it("a key expires on its date, is revoked by name, and a revoked key never comes back", async () => {
    const x = await boot();
    expect(code(await x.own({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: x.now() + 60 * MIN }))).toBe("account");
    await x.approve(cc, "*", "600", "1000");
    await x.pass(61 * MIN);
    expect(code(await x.transfer(cc, "okx", "hyperliquid", "100"))).toBe("E_ACCOUNT_AGENT_EXPIRED");
    await x.authorise(codex, "Codex");
    // Hyperliquid's way to revoke: approve the zero address under the same name
    expect(code(await x.own({ type: "approveAgent", agentAddress: ZERO, agentName: "Codex", validUntil: 0 }))).toBe("account");
    expect(code(await x.transfer(codex, "okx", "hyperliquid", "100"))).toBe("E_ACCOUNT_AGENT_REVOKED");
    const again = refusal(await x.authorise(codex, "Codex"));
    expect([again.code, again.message]).toEqual(["E_ACCOUNT_LIMIT", "this key was revoked once: a revoked key is never authorised again, generate a new one"]);
  });

  it("the same key approved again, to extend it, stays authorised and stays one key", async () => {
    const x = await boot();
    await x.authorise(cc, "Claude Code", 1);
    await x.approve(cc, "*", "600", "5000");
    expect(code(await x.authorise(cc, "Claude Code", 30))).toBe("account");
    expect(x.engine.state.agents.map((k) => [k.address, k.revokedAt])).toEqual([[cc.address, undefined]]);
    expect(code(await x.transfer(cc, "hyperliquid:perps", "hyperliquid:spot", "10"))).toBe("payment");
    // and after it ran out and was approved again
    await x.pass(31 * DAY);
    expect(code(await x.transfer(cc, "hyperliquid:perps", "hyperliquid:spot", "10"))).toBe("E_ACCOUNT_AGENT_EXPIRED");
    expect(code(await x.authorise(cc, "Claude Code", 30))).toBe("account");
    expect(code(await x.transfer(cc, "hyperliquid:perps", "hyperliquid:spot", "10"))).toBe("E_MANDATE_EXPIRED");
    expect(x.engine.state.tombstones).toEqual([]);
  });

  it("the account's own limits: 180 days, four keys", async () => {
    const x = await boot();
    expect(code(await x.authorise(cc, "Claude Code", 181))).toBe("E_ACCOUNT_LIMIT");
    for (const name of ["a", "b", "c", "d"]) expect(code(await x.authorise(simKey(`agent:${name}`), name))).toBe("account");
    expect(code(await x.authorise(simKey("agent:e"), "e"))).toBe("E_ACCOUNT_LIMIT");
    // the same name again replaces the key, and the old one is gone for good
    expect(code(await x.authorise(simKey("agent:a2"), "a"))).toBe("account");
    expect(x.engine.state.tombstones).toContain(simKey("agent:a").address);
  });
});

describe("the same instruction never runs twice", () => {
  it("the same envelope again gets the first answer; one payment exists", async () => {
    const x = await boot();
    await x.authorise(cc, "Claude Code");
    await x.approve(cc, "okx,metamask,hyperliquid", "600", "2000");
    const env = await signAgent(cc, { type: "agentSendAsset", destination: "self", sourceDex: "okx", destinationDex: "hyperliquid", token: "USDC", amount: "500", fromSubAccount: "", maxFee: "5", nonce: x.nonce() });
    const first = await x.svc.exchange(env);
    const second = await x.svc.exchange(env);
    expect(second).toBe(first);
    expect(x.engine.payments).toHaveLength(1);
    expect(await x.held("okx", "USDT")).toBe(2000);
  });

  it("a used nonce under a different instruction is refused, and so is a money instruction signed too long ago", async () => {
    const x = await boot();
    const n = x.nonce();
    expect(code(await x.svc.exchange(await signOwner(owner, { type: "userSetAbstraction", abstraction: "unifiedAccount", nonce: n })))).toBe("account");
    expect(code(await x.svc.exchange(await signOwner(owner, { type: "userSetAbstraction", abstraction: "disabled", nonce: n })))).toBe("E_ACCOUNT_NONCE");
    await x.authorise(cc, "Claude Code");
    await x.approve(cc, "*", "600", "2000");
    const stale = await signAgent(cc, { type: "agentSendAsset", destination: "self", sourceDex: "okx", destinationDex: "hyperliquid", token: "USDC", amount: "100", fromSubAccount: "", maxFee: "5", nonce: x.now() - 11 * MIN });
    expect(refusal(await x.svc.exchange(stale)).code).toBe("E_ACCOUNT_EXPIRED");
    // a setting, unlike money, is good for the whole nonce window
    expect(code(await x.svc.exchange(await signOwner(owner, { type: "userSetAbstraction", abstraction: "disabled", nonce: x.now() - 11 * MIN })))).toBe("account");
  });

  it("a changed envelope is somebody else's signature", async () => {
    const x = await boot();
    await x.authorise(cc, "Claude Code");
    await x.approve(cc, "*", "600", "2000");
    const env = await signAgent(cc, { type: "agentSendAsset", destination: "self", sourceDex: "okx", destinationDex: "hyperliquid", token: "USDC", amount: "100", fromSubAccount: "", maxFee: "5", nonce: x.nonce() });
    const forged = { ...env, action: { ...env.action, amount: "600" } as AgentAction };
    expect(code(await x.svc.exchange(forged))).toBe("E_ACCOUNT_UNKNOWN_SIGNER");
    expect(code(await x.svc.exchange({ ...env, nonce: env.nonce + 1 }))).toBe("E_ACCOUNT_BAD_ACTION");
    expect(x.engine.payments).toHaveLength(0);
  });

  it("two instructions sent at the same moment are taken one after the other: together they cannot pass a limit either would pass alone", async () => {
    const x = await boot();
    await x.authorise(cc, "Claude Code");
    await x.approve(cc, "okx,metamask,hyperliquid", "600", "1000");
    const both = await Promise.all([x.transfer(cc, "okx", "hyperliquid", "600"), x.transfer(cc, "okx", "hyperliquid", "600")]);
    expect(both.map(code).sort()).toEqual(["E_MANDATE_BUDGET", "payment"]);
    expect(x.engine.payments).toHaveLength(1);
    // and the very same envelope, twice at once, is still one transfer
    const env = await signAgent(cc, { type: "agentSendAsset", destination: "self", sourceDex: "okx", destinationDex: "hyperliquid", token: "USDC", amount: "300", fromSubAccount: "", maxFee: "5", nonce: x.nonce() });
    const [a, b] = await Promise.all([x.svc.exchange(env), x.svc.exchange(env)]);
    expect(b).toBe(a);
    expect(x.engine.payments).toHaveLength(2);
  });

  it("a signature outlives the process: started again in the same home, the account refuses every envelope its ledgers have seen", async () => {
    const home = mkdtempSync(join(tmpdir(), "account-restart-"));
    homes.push(home);
    const seed = { owners: [{ id: owner.address, kind: "eoa" as const, label: "owner", addedAt: new Date(START).toISOString() }] };
    const first = await PortfolioService.create({ home, now: () => new Date(START).toISOString(), venues: "frontline", account: seed });
    const grant = await signOwner(owner, { type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: START + 30 * DAY, nonce: START + 1 });
    const approval = await signOwner(owner, { type: "approveSpend", agent: cc.address, scope: "venues", allow: "*", perPayment: "600", budget: "5000", windowHours: 0, validUntil: START + 30 * DAY, nonce: START + 2 });
    expect([code(await first.exchange(grant)), code(await first.exchange(approval))]).toEqual(["account", "account"]);
    // the owner changes their mind and revokes the key; then the process ends
    expect(code(await first.exchange(await signOwner(owner, { type: "approveAgent", agentAddress: ZERO, agentName: "Claude Code", validUntil: 0, nonce: START + 3 })))).toBe("account");
    // a minute later a new process starts, empty, in the same home. Anyone who can read the old ledger holds the owner's old signed envelopes
    const second = await PortfolioService.create({ home, now: () => new Date(START + MIN).toISOString(), venues: "frontline", account: seed });
    expect(second.account!.state.agents).toEqual([]);
    expect([code(await second.exchange(grant)), code(await second.exchange(approval))]).toEqual(["E_ACCOUNT_NONCE", "E_ACCOUNT_NONCE"]);
    expect(second.account!.state.agents).toEqual([]);
    // a nonce the old ledgers never saw is as good as ever
    expect(code(await second.exchange(await signOwner(owner, { type: "approveAgent", agentAddress: codex.address, agentName: "Codex", validUntil: START + 30 * DAY, nonce: START + MIN + 1 })))).toBe("account");
    // a scripted run that asks for a fresh ledger declares it starts from nothing: it is not bound by an earlier run's file
    const scripted = await PortfolioService.create({ home, now: () => new Date(START).toISOString(), venues: "frontline", account: seed, freshLedger: true });
    expect(code(await scripted.exchange(grant))).toBe("account");
  });

  it("an instruction is exactly what its signature covers: no fraction in a number, no field its type does not sign", async () => {
    const x = await boot();
    const grant = await signOwner(owner, { type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: x.now() + DAY, nonce: x.nonce() });
    expect(code(await x.svc.exchange(grant))).toBe("account");
    await x.own({ type: "approveAgent", agentAddress: ZERO, agentName: "Claude Code", validUntil: 0 });
    // the typed data signs a nonce as a whole number: 1000.5 would carry the signature made for 1000 and look unused. It is not an instruction at all
    const half = { ...grant, nonce: grant.nonce + 0.5, action: { ...grant.action, nonce: grant.nonce + 0.5 } };
    expect(code(await x.svc.exchange(half))).toBe("E_ACCOUNT_BAD_ACTION");
    x.svc.reset();
    expect(code(await x.svc.exchange(half))).toBe("E_ACCOUNT_BAD_ACTION");
    expect(code(await x.svc.exchange(grant))).toBe("E_ACCOUNT_NONCE");
    expect(x.engine.state.agents).toEqual([]);
    // a field the type does not sign, a field that is missing, a number where text is signed
    const fresh = await signOwner(owner, { type: "userSetAbstraction", abstraction: "unifiedAccount", nonce: x.nonce() });
    expect(code(await x.svc.exchange({ ...fresh, action: { ...fresh.action, also: "something nobody signed" } as never }))).toBe("E_ACCOUNT_BAD_ACTION");
    expect(code(await x.svc.exchange({ ...fresh, action: { type: "userSetAbstraction", nonce: fresh.nonce } as never }))).toBe("E_ACCOUNT_BAD_ACTION");
    expect(code(await x.svc.exchange({ ...fresh, action: { ...fresh.action, abstraction: 7 } as never }))).toBe("E_ACCOUNT_BAD_ACTION");
    expect(code(await x.svc.exchange(fresh))).toBe("account");
  });

  it("two owners' signatures changing places are not a new instruction — in this process, after a reset, or after a restart", async () => {
    const home = mkdtempSync(join(tmpdir(), "account-two-signers-"));
    homes.push(home);
    const second = simKey("co-signer");
    const seed = { owners: [{ id: owner.address, kind: "eoa" as const, label: "owner", addedAt: new Date(START).toISOString() }] };
    const svc = await PortfolioService.create({ home, now: () => new Date(START).toISOString(), venues: "frontline", account: seed });
    let n = 0;
    const both = async (a: NoNonce<OwnerAction>) => {
      const action = { ...a, nonce: START + ++n } as OwnerAction;
      return { ...(await signOwner(owner, action)), cosignatures: [await cosign(second, action)] };
    };
    expect(code(await svc.exchange(await signOwner(owner, { type: "convertToMultiSigUser", signers: JSON.stringify({ authorizedUsers: [owner.address, second.address].sort(), threshold: 2 }), nonce: START + ++n })))).toBe("account");
    await svc.exchange(await both({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: START + 30 * DAY }));
    const approval = await both({ type: "approveSpend", agent: cc.address, scope: "venues", allow: "okx,metamask,hyperliquid", perPayment: "600", budget: "600", windowHours: 0, validUntil: START + 30 * DAY });
    const first = await svc.exchange(approval);
    const swapped = { action: approval.action, nonce: approval.nonce, signature: approval.cosignatures[0]!, cosignatures: [approval.signature] };
    // the same instruction, presented by the other signer: the first answer, and one approval
    expect(await svc.exchange(swapped)).toBe(first);
    expect(svc.account!.state.spends).toHaveLength(1);
    // a reset puts the account back to the one owner it opened with: the co-signer is nobody again, and the owner's own nonce is still spent
    svc.reset();
    expect([code(await svc.exchange(swapped)), code(await svc.exchange(approval))]).toEqual(["E_ACCOUNT_UNKNOWN_SIGNER", "E_ACCOUNT_NONCE"]);
    // a new process in the same home remembers the instruction by what it is, not by who presented it
    const later = await PortfolioService.create({ home, now: () => new Date(START + MIN).toISOString(), venues: "frontline", account: { owners: [...seed.owners, { id: second.address, kind: "eoa" as const, label: "co-signer", addedAt: new Date(START).toISOString() }] } });
    expect([code(await later.exchange(approval)), code(await later.exchange(swapped))]).toEqual(["E_ACCOUNT_NONCE", "E_ACCOUNT_NONCE"]);
  });

  it("a reset starts the simulation over; it does not hand the account to whoever pairs next", async () => {
    const x = await boot({ owners: false });
    const mine = simKey("device:mine");
    const theirs = simKey("device:theirs");
    expect(x.engine.pairDevice(mine.jwk)).toMatchObject({ role: "owner" });
    x.svc.reset();
    expect(x.engine.pairDevice(theirs.jwk)).toMatchObject({ role: "pending" });
    expect(x.engine.pairDevice(mine.jwk)).toMatchObject({ role: "owner" });
  });

  it("a reset forgets the account and remembers the nonces", async () => {
    const x = await boot();
    const env = await signOwner(owner, { type: "userSetAbstraction", abstraction: "unifiedAccount", nonce: x.nonce() });
    expect(code(await x.svc.exchange(env))).toBe("account");
    x.svc.reset();
    expect(x.engine.state.abstraction).toBe("disabled");
    expect(code(await x.svc.exchange(env))).toBe("E_ACCOUNT_NONCE");
  });
});

describe("an agent moves money only between the user's own venues, inside an approval", () => {
  it("no approval, no movement", async () => {
    const x = await boot();
    await x.authorise(cc, "Claude Code");
    const r = refusal(await x.transfer(cc, "okx", "hyperliquid", "500"));
    expect([r.code, r.layer]).toEqual(["E_MANDATE_NONE", "MANDATE"]);
  });

  it("OKX → Hyperliquid: four legs on the clock; the money is in no balance while it flies", async () => {
    const x = await boot();
    await x.authorise(cc, "Claude Code");
    await x.approve(cc, "okx,metamask,hyperliquid", "600", "800");
    const p = paid(await x.transfer(cc, "okx", "hyperliquid", "500"));
    expect(p.legs.map((l) => `${l.step}:${l.venue}:${l.status}`)).toEqual(["swap:okx:settled", "out:okx:pending", "out:metamask:waiting", "in:hyperliquid:waiting"]);
    expect([p.status, p.authority, p.kind, p.feeUsd, p.receiveUsd]).toEqual(["pending", "agent", "transfer", 1.07, 498.93]);
    // it has left OKX and is nowhere yet
    expect([await x.held("okx", "USDT"), await x.held("okx", "USDC"), await x.held("hyperliquid", "USDC", "perps"), await x.held("metamask", "USDC", "Arbitrum")]).toEqual([2000, 0, 1500, 800]);
    expect((await x.engine.view()).inFlightUsd).toBe(499.95);
    await x.pass(5 * MIN + 10_000);
    expect(p.legs.map((l) => l.status)).toEqual(["settled", "settled", "pending", "waiting"]);
    await x.pass(70_000);
    expect(p.status).toBe("settled");
    expect(await x.held("hyperliquid", "USDC", "perps")).toBe(1998.93);
    expect(await x.held("metamask", "USDC", "Arbitrum")).toBe(800);
    // a leg lands at its own time, not at the time someone looked
    expect(Date.parse(p.settledAt!) - START).toBeLessThan(6 * MIN + 20_000);
    expect(Date.parse(p.settledAt!) - Date.parse(p.at)).toBe(375_000);
    // the venue's own requests are on the legs: OKX's signed withdrawal, CCTP's burn
    expect((p.legs[1]!.native as { path: string }).path).toBe("/api/v5/asset/withdrawal");
    expect((p.legs[3]!.native as { function: string }).function).toBe("depositForBurnWithHook");
    const flight = x.svc.flights.find((f) => f.no === p.flight)!;
    expect([flight.agent.name, flight.agent.code]).toEqual(["Claude Code", "CC"]);
    expect(flight.legs[flight.legs.length - 1]!.text).toBe("$498.93 USDC landed at Hyperliquid · fees $1.07");
  });

  it("a swap by an agent is inside its approval, its budget and the dial like everything else it does", async () => {
    const x = await boot();
    await x.authorise(cc, "Claude Code");
    await x.approve(cc, "okx,metamask,hyperliquid", "600", "1000");
    const swap = (venue: string, sell: string, buy: string, amount: string) => x.ag(cc, { type: "agentSwap", venue, sell, buy, amount, minReceive: "1" });
    expect(code(await swap("okx", "USDT", "USDC", "590"))).toBe("payment");
    expect(x.engine.state.spends[0]!.spentMicro).toBe(590_000_000);
    // the budget holds $410 more: not $580
    expect(code(await swap("okx", "USDC", "USDT", "580"))).toBe("E_MANDATE_BUDGET");
    expect(code(await swap("okx", "USDC", "USDT", "700"))).toBe("E_MANDATE_PER_ORDER_CAP");
    expect(code(await swap("binance", "USDT", "USDC", "100"))).toBe("E_MANDATE_RECIPIENT");
    // the venue is switched off for the agent; then the session ends
    x.svc.revoke("okx");
    expect(code(await swap("okx", "USDC", "USDT", "100"))).toBe("E_WALLET_ACCOUNT_REVOKED");
    x.svc.restore("okx");
    x.svc.revokeAll();
    expect(code(await swap("okx", "USDC", "USDT", "100"))).toBe("E_WALLET_SESSION_EXPIRED");
  });

  it("the approval's limits: per payment, in all, and which venues", async () => {
    const x = await boot();
    await x.authorise(cc, "Claude Code");
    await x.approve(cc, "okx,metamask,hyperliquid", "600", "800");
    expect(code(await x.transfer(cc, "okx", "hyperliquid", "601"))).toBe("E_MANDATE_PER_ORDER_CAP");
    expect(code(await x.transfer(cc, "okx", "hyperliquid", "500"))).toBe("payment");
    // splitting does not help: the budget is for everything, and $300 is left
    const over = refusal(await x.transfer(cc, "okx", "hyperliquid", "400"));
    expect([over.code, over.message]).toEqual(["E_MANDATE_BUDGET", "the spending approval has $300.00 left of $800.00; $400.00 is more than that"]);
    expect(code(await x.transfer(cc, "okx", "polymarket", "100"))).toBe("E_MANDATE_RECIPIENT");
    expect(code(await x.transfer(cc, "ondo", "hyperliquid", "100"))).toBe("E_MANDATE_RECIPIENT");
    expect(code(await x.transfer(cc, "okx", "hyperliquid", "100", { maxFee: "0.5" }))).toBe("E_ACCOUNT_REQUOTE");
    // the owner revokes it with a budget of zero
    expect(code(await x.own({ type: "approveSpend", agent: cc.address, scope: "venues", allow: "", perPayment: "0", budget: "0", windowHours: 0, validUntil: 0 }))).toBe("account");
    expect(code(await x.transfer(cc, "okx", "hyperliquid", "100"))).toBe("E_MANDATE_NONE");
  });

  it("money can only go home: not to an address, not out of Hyperliquid, not past a key that cannot withdraw", async () => {
    const x = await boot();
    await x.authorise(cc, "Claude Code");
    await x.approve(cc, "*", "600", "5000");
    expect(code(await x.transfer(cc, "metamask", "Base", "100", { destination: "0x7a11000000000000000000000000000000000001" }))).toBe("E_ACCOUNT_NOT_HOME");
    const hl = refusal(await x.transfer(cc, "hyperliquid", "metamask", "100"));
    expect([hl.code, hl.message]).toEqual(["E_ACCOUNT_OWNER_ONLY", "Hyperliquid: only the master account's signature can withdraw"]);
    const bn = refusal(await x.transfer(cc, "binance", "hyperliquid", "100"));
    expect([bn.code, bn.message]).toEqual(["E_VENUE_RAIL_CLOSED", "Binance: this key has no withdraw permission"]);
    expect((bn.detail as { opens: string }).opens).toContain("whitelist");
    expect(code(await x.transfer(cc, "metamask", "alpaca", "100", { token: "USD" }))).toBe("E_VENUE_RAIL_CLOSED");
    expect(code(await x.transfer(cc, "okx", "hyperliquid", "4"))).toBe("E_VENUE_MIN_DEPOSIT");
    expect(code(await x.transfer(cc, "okx", "hyperliquid", "100", { token: "ETH" }))).toBe("E_ACCOUNT_UNPRICED");
    // inside Hyperliquid, perps to spot, is its to do
    const shift = paid(await x.transfer(cc, "hyperliquid:perps", "hyperliquid:spot", "100"));
    expect([shift.status, shift.feeUsd]).toEqual(["settled", 0]);
    expect([await x.held("hyperliquid", "USDC", "perps"), await x.held("hyperliquid", "USDC", "spot")]).toEqual([1400, 600]);
  });

  it("the wallet's own Guard is still the wallet's: over its 24-hour outflow the second leg waits there, and the payment says where the money is", async () => {
    const x = await boot();
    await x.authorise(cc, "Claude Code");
    await x.approve(cc, "*", "2000", "5000");
    const p = paid(await x.transfer(cc, "okx", "hyperliquid", "1600"));
    await x.pass(6 * MIN);
    expect(p.status).toBe("stranded");
    expect(p.note).toContain("USDC is in the wallet on Arbitrum");
    expect(p.note).toContain("It has not reached hyperliquid");
    // nothing is lost: it left OKX, it is in the wallet
    expect(await x.held("metamask", "USDC", "Arbitrum")).toBe(800 + 1599.04);
    expect(await x.held("hyperliquid", "USDC", "perps")).toBe(1500);
  });

  it("what an agent key moved counts towards the day's figure; what the owner signs does not", async () => {
    const x = await boot();
    await x.authorise(cc, "Claude Code");
    await x.approve(cc, "*", "600", "5000");
    await x.transfer(cc, "okx", "hyperliquid", "500");
    expect(x.svc.dailyOutUsd(new Date(x.now()).toISOString())).toBe(500);
    paid(await x.send({ sourceDex: "hyperliquid", destinationDex: "metamask", amount: "200" }));
    expect(x.svc.dailyOutUsd(new Date(x.now()).toISOString())).toBe(500);
  });
});

describe("what the owner signs", () => {
  it("a withdrawal from Hyperliquid: the owner's signature, five minutes, and the margin stays", async () => {
    const x = await boot();
    const p = paid(await x.send({ sourceDex: "hyperliquid", destinationDex: "metamask", amount: "200" }));
    expect([p.authority, p.kind, p.status, p.feeUsd]).toEqual(["owner", "withdraw", "pending", 0.23]);
    expect(p.legs[0]!.native).toMatchObject({ type: "sendToEvmWithData", token: "USDC", destinationChainId: 3 });
    expect(await x.held("hyperliquid", "USDC", "perps")).toBe(1300);
    await x.pass(5 * MIN);
    expect([p.status, await x.held("metamask", "USDC", "Arbitrum")]).toEqual(["settled", 999.77]);
    const margin = refusal(await x.send({ sourceDex: "hyperliquid", destinationDex: "metamask", amount: "1100" }));
    expect(margin.code).toBe("E_VENUE_INSUFFICIENT");
    expect(margin.message).toContain("margin");
  });

  it("covers the exact route, the most it may cost and the latest it may land", async () => {
    const x = await boot();
    const base = { sourceDex: "hyperliquid", destinationDex: "metamask", amount: "200" };
    expect(code(await x.send(base, { route: `0x${"00".repeat(32)}` }))).toBe("E_ACCOUNT_REQUOTE");
    expect(code(await x.send(base, { maxFee: "0.1" }))).toBe("E_ACCOUNT_REQUOTE");
    expect(code(await x.send(base, { deadline: x.now() + MIN }))).toBe("E_ACCOUNT_REQUOTE");
    expect(x.engine.payments).toHaveLength(0);
    expect(code(await x.send(base))).toBe("payment");
  });

  it("the broker's cash moves only at the broker, by an ACH with the holder's own bank: not even the owner routes money into it or out of it here", async () => {
    const x = await boot();
    for (const r of [refusal(await x.send({ sourceDex: "metamask", destinationDex: "alpaca", token: "USD", amount: "2000" })), refusal(await x.send({ sourceDex: "alpaca", destinationDex: "metamask", token: "USD", amount: "500" }))]) {
      expect([r.code, r.venue]).toEqual(["E_VENUE_RAIL_CLOSED", "alpaca"]);
      expect(r.message).toContain("only by ACH with your own bank, started at Alpaca");
    }
    expect(x.engine.payments).toHaveLength(0);
  });

  it("someone else: an address in the book, on its chain, a day after it was added", async () => {
    const x = await boot();
    const contractor = "0x7A11000000000000000000000000000000000001";
    const to = { destination: contractor, sourceDex: "metamask", destinationDex: "Base", amount: "300" };
    expect(refusal(await x.send(to)).code).toBe("E_ACCOUNT_DESTINATION");
    expect(code(await x.own({ type: "setDestination", label: "contractor", address: "0x7a11…stranger", chain: "Base", token: "USDC" }))).toBe("E_ACCOUNT_DESTINATION");
    expect(code(await x.own({ type: "setDestination", label: "contractor", address: contractor, chain: "Base", token: "USDC" }))).toBe("account");
    const cooling = refusal(await x.send(to));
    expect([cooling.code, cooling.message]).toEqual(["E_ACCOUNT_DEST_COOLING", '"contractor" was added 0 h ago: it can be used from Sun 4 Oct']);
    await x.pass(DAY + MIN);
    // the right address on the wrong chain is a different destination
    const wrongChain = refusal(await x.send({ ...to, destinationDex: "Arbitrum" }));
    expect(wrongChain.message).toBe("that address is in the address book on Base, not on Arbitrum: a destination is an address on a chain");
    const p = paid(await x.send(to));
    expect([p.kind, p.authority, p.external?.label]).toEqual(["send", "owner", "contractor"]);
    await x.pass(MIN);
    expect([p.status, await x.held("metamask", "USDC", "Base")]).toEqual(["settled", 900]);
  });

  it("the blocklist is not fooled by capital letters", async () => {
    const x = await boot();
    const r = refusal(await x.send({ destination: "0xD759…ATTACKER", sourceDex: "metamask", destinationDex: "Base", amount: "10" }));
    expect(r.code).toBe("E_WALLET_BLOCKLIST");
  });

  it("a swap at Hyperliquid: at least 10, and no less than was agreed", async () => {
    const x = await boot();
    expect(code(await x.own({ type: "swap", venue: "hyperliquid", sell: "USDC", buy: "USDT", amount: "9", minReceive: "8" }))).toBe("E_VENUE_MIN_DEPOSIT");
    expect(code(await x.own({ type: "swap", venue: "hyperliquid", sell: "USDC", buy: "USDT", amount: "100", minReceive: "100" }))).toBe("E_ACCOUNT_REQUOTE");
    const p = paid(await x.own({ type: "swap", venue: "hyperliquid", sell: "USDC", buy: "USDT", amount: "100", minReceive: "99.9" }));
    expect([p.kind, p.status, p.receiveUsd]).toEqual(["swap", "settled", 99.99]);
    expect(await x.held("hyperliquid", "USDT")).toBe(99.99);
    expect(code(await x.own({ type: "swap", venue: "alpaca", sell: "USDC", buy: "USDT", amount: "100", minReceive: "1" }))).toBe("E_VENUE_CURRENCY");
  });
});

describe("a card is answered with the owner's signature, and judged again when it is", () => {
  const guarded = async () => {
    const x = await boot();
    await x.authorise(cc, "Claude Code");
    await x.approve(cc, "okx,metamask,hyperliquid", "700", "1000");
    x.svc.setMode("guard");
    const out = await x.transfer(cc, "okx", "hyperliquid", "600");
    if (isRefusal(out) || out.kind !== "card") throw new Error(`expected a card, got ${code(out)}`);
    const answer = (decision: string, by: SimKey = owner, action: Hex = cardHash(out.card)) => x.own({ type: "approveCard", card: out.card.id, action, decision }, by);
    return { ...x, card: out.card, answer };
  };

  it("Guard asks above the allowance; the waiting card holds its share of the budget", async () => {
    const x = await guarded();
    expect([x.card.status, x.card.usd, x.card.signer]).toEqual(["pending", 600, cc.address]);
    expect(x.engine.payments).toHaveLength(0);
    expect(await x.held("okx", "USDT")).toBe(2500);
    // two cards of $600 would each fit a $1,000 budget and together overrun it: the second is refused now
    expect(code(await x.transfer(cc, "okx", "hyperliquid", "600"))).toBe("E_MANDATE_BUDGET");
    expect((await x.engine.view()).cards.map((c) => [c.id, c.usd, c.hash])).toEqual([[x.card.id, 600, cardHash(x.card)]]);
  });

  it("nobody but the owner answers it", async () => {
    const x = await guarded();
    expect(code(await x.answer("approve", cc))).toBe("E_ACCOUNT_OWNER_ONLY");
    expect(code(await x.answer("approve", simKey("stranger")))).toBe("E_ACCOUNT_UNKNOWN_SIGNER");
    // the older, unsigned way to answer a card does not open this one
    const direct = await x.svc.decide(x.card.id, "approve");
    expect(isRefusal(direct) && direct.code).toBe("E_ACCOUNT_OWNER_SURFACE");
    // and an approval that names a different instruction is not an approval of this one
    expect(code(await x.answer("approve", owner, `0x${"ab".repeat(32)}`))).toBe("E_ACCOUNT_BAD_SIGNATURE");
    expect(x.card.status).toBe("pending");
  });

  it("approved: the instruction runs, on the same flight", async () => {
    const x = await guarded();
    const p = paid(await x.answer("approve"));
    expect([p.status, p.card, p.flight, x.card.status]).toEqual(["pending", x.card.id, x.card.flight, "approved"]);
    await x.pass(7 * MIN);
    expect(await x.held("hyperliquid", "USDC", "perps")).toBe(1500 + 598.92);
    expect(x.engine.state.spends[0]).toMatchObject({ spentMicro: 600_000_000, reservedMicro: 0 });
  });

  it("rejected: nothing moves and the budget is free again", async () => {
    const x = await guarded();
    const out = await x.answer("reject");
    expect(code(out)).toBe("result");
    expect([x.card.status, x.engine.payments.length, x.engine.state.spends[0]!.reservedMicro]).toEqual(["rejected", 0, 0]);
    expect(code(await x.transfer(cc, "okx", "hyperliquid", "400"))).toBe("payment");
  });

  it("approved after the key was revoked: it no longer passes", async () => {
    const x = await guarded();
    await x.own({ type: "approveAgent", agentAddress: ZERO, agentName: "Claude Code", validUntil: 0 });
    expect(code(await x.answer("approve"))).toBe("E_ACCOUNT_AGENT_REVOKED");
    expect([x.card.status, x.engine.payments.length, await x.held("okx", "USDT")]).toEqual(["approved", 0, 2500]);
  });

  it("a card does not wait for ever", async () => {
    const x = await guarded();
    await x.pass(31 * MIN);
    expect(code(await x.answer("approve"))).toBe("E_ACCOUNT_CARD_EXPIRED");
    expect([x.card.status, x.engine.state.spends[0]!.reservedMicro]).toEqual(["rejected", 0]);
  });

  it("a card the older write path raised is answered the same way, and judged again too", async () => {
    const x = await boot();
    // the page's scripted agent asks to send to a never-used address: a card, as before
    const out = await x.svc.execute("ondo", { kind: "move", asset: "USDC", amount: 300, to: "0x7a11…stranger" });
    if (isRefusal(out) || !("pending" in out)) throw new Error("expected a card");
    const card = out.approval;
    expect(card.expiresAt).toBeDefined();
    // the account is switched off before the owner gets to it
    x.svc.revoke("ondo");
    const res = await x.own({ type: "approveCard", card: card.id, action: cardHash(card), decision: "approve" });
    expect(code(res)).toBe("result");
    expect(isRefusal((res as { result: unknown }).result) && ((res as { result: Refusal }).result.code)).toBe("E_WALLET_ACCOUNT_REVOKED");
    expect(await x.held("ondo", "USDC")).toBe(3000);
  });
});

describe("Unified: the account may pick the source, along routes the owner approved", () => {
  it("Separate refuses a movement with no source; Unified takes the soonest open one the approval names", async () => {
    const x = await boot();
    await x.authorise(cc, "Claude Code");
    await x.approve(cc, "*", "600", "5000", 24);
    expect(code(await x.transfer(cc, "", "hyperliquid", "300"))).toBe("E_ACCOUNT_SOURCE");
    expect((await x.engine.view()).type).toBe("Separate");
    expect(code(await x.own({ type: "userSetAbstraction", abstraction: "unifiedAccount" }))).toBe("account");
    const p = paid(await x.transfer(cc, "", "hyperliquid", "300"));
    // the wallet's USDC on Arbitrum is 75 seconds away; OKX is six minutes, Ondo ninety seconds
    expect([p.from, p.legs.map((l) => l.step).join(","), Date.parse(p.settlesAt) - Date.parse(p.at)]).toEqual(["metamask", "out,in", 75_000]);
    // the same sink cannot be refilled again inside the approval's window: a drained venue is not a tap
    const again = refusal(await x.transfer(cc, "", "hyperliquid", "300"));
    expect(again.code).toBe("E_MANDATE_RATE");
    await x.pass(DAY + MIN);
    expect(code(await x.transfer(cc, "", "hyperliquid", "300"))).toBe("payment");
  });

  it("the owner still names the source: Unified is for the agent, not a blank cheque", async () => {
    const x = await boot();
    await x.own({ type: "userSetAbstraction", abstraction: "unifiedAccount" });
    const r = await x.engine.resolve({ destination: "self", sourceDex: "", destinationDex: "hyperliquid", token: "USDC", amount: "300" }, "owner");
    expect(isRefusal(r) && r.code).toBe("E_ACCOUNT_SOURCE");
  });
});

describe("a sub-account is an agent's float", () => {
  it("is filled from the wallet up to its cap, by the owner or by the agent inside its approval", async () => {
    const x = await boot();
    await x.authorise(cc, "Claude Code");
    expect(code(await x.own({ type: "createSubAccount", name: "cc-float", agent: cc.address, float: "200" }))).toBe("account");
    expect(code(await x.send({ sourceDex: "metamask", destinationDex: "sub:cc-float", amount: "250" }))).toBe("E_WALLET_FLOAT_CAP");
    expect(code(await x.send({ sourceDex: "okx", destinationDex: "sub:cc-float", amount: "50" }))).toBe("E_ACCOUNT_SOURCE");
    const p = paid(await x.send({ sourceDex: "metamask", destinationDex: "sub:cc-float", amount: "150" }));
    expect([p.kind, p.to]).toEqual(["refill", "sub:cc-float"]);
    await x.pass(MIN);
    const v = await x.engine.view();
    expect(v.subAccounts).toMatchObject([{ name: "cc-float", agentName: "Claude Code", capUsd: 200, balanceUsd: 149.99 }]);
    expect(await x.held("metamask", "USDC", "Base")).toBe(1050);
    // the agent tops it up itself only if the owner drew that route
    await x.approve(cc, "metamask,sub:cc-float", "100", "300", 1);
    expect(code(await x.transfer(cc, "metamask", "sub:cc-float", "60"))).toBe("E_WALLET_FLOAT_CAP");
    expect(code(await x.transfer(cc, "metamask", "sub:cc-float", "40"))).toBe("payment");
    expect(code(await x.transfer(cc, "metamask", "sub:cc-float", "5"))).toBe("E_MANDATE_RATE");
  });
});

describe("a float is the owner's money: it has a way home, and a cap that refills in flight cannot pass", () => {
  it("refills launched together stop at the cap; the owner sweeps the float back; the agent cannot", async () => {
    const x = await boot();
    await x.authorise(cc, "Claude Code");
    await x.own({ type: "createSubAccount", name: "cc-float", agent: cc.address, float: "60" });
    await x.approve(cc, "metamask,sub:cc-float", "100", "500");
    // two refills of $40, the second while the first is still on its way: together they would make $80 in a $60 float
    expect(code(await x.transfer(cc, "metamask", "sub:cc-float", "40"))).toBe("payment");
    const over = refusal(await x.transfer(cc, "metamask", "sub:cc-float", "40"));
    expect([over.code, over.message]).toEqual(["E_WALLET_FLOAT_CAP", '"cc-float" may hold $60.00; it holds $0.00, $39.99 is on its way to it, and $40.00 more would pass that']);
    await x.pass(MIN);
    expect(x.engine.sub("cc-float")!.balanceMicro).toBe(39_990_000);
    // the agent's key is revoked: its float does not stay behind. Only the owner brings it home
    expect(code(await x.transfer(cc, "sub:cc-float", "metamask", "10"))).toBe("E_ACCOUNT_OWNER_ONLY");
    await x.own({ type: "approveAgent", agentAddress: ZERO, agentName: "Claude Code", validUntil: 0 });
    const before = await x.held("metamask", "USDC", "Base");
    const p = paid(await x.send({ sourceDex: "sub:cc-float", destinationDex: "metamask", amount: "39.99" }));
    expect([p.kind, p.authority, x.engine.sub("cc-float")!.balanceMicro]).toEqual(["withdraw", "owner", 0]);
    await x.pass(MIN);
    expect([p.status, Math.round(((await x.held("metamask", "USDC", "Base")) - before) * 100)]).toEqual(["settled", 3998]);
    expect(code(await x.send({ sourceDex: "sub:cc-float", destinationDex: "metamask", amount: "1" }))).toBe("E_WALLET_INSUFFICIENT");
  });
});

describe("signers", () => {
  it("an account that needs two signers gets two", async () => {
    const x = await boot();
    const second = simKey("co-signer");
    const users = [owner.address, second.address].sort();
    expect(code(await x.own({ type: "convertToMultiSigUser", signers: JSON.stringify({ authorizedUsers: users, threshold: 2 }) }))).toBe("account");
    const action: OwnerAction = { type: "userSetAbstraction", abstraction: "unifiedAccount", nonce: x.nonce() };
    const one = await signOwner(owner, action);
    expect(code(await x.svc.exchange(one))).toBe("E_ACCOUNT_THRESHOLD");
    // the same signer twice is still one signer
    const twice: OwnerAction = { ...action, nonce: x.nonce() };
    expect(code(await x.svc.exchange({ ...(await signOwner(owner, twice)), cosignatures: [await cosign(owner, twice)] }))).toBe("E_ACCOUNT_THRESHOLD");
    const both: OwnerAction = { ...action, nonce: x.nonce() };
    expect(code(await x.svc.exchange({ ...(await signOwner(owner, both)), cosignatures: [await cosign(second, both)] }))).toBe("account");
    expect((await x.engine.view()).signers).toMatchObject({ threshold: 2, owners: [{ kind: "eoa" }, { kind: "eoa" }] });
  });

  it("the first device to open the account becomes its owner's device; a later one waits to be made a signer", async () => {
    const x = await boot({ owners: false });
    const device = simKey("owner-device");
    const other = simKey("other-device");
    expect(x.engine.pairDevice(device.jwk)).toEqual({ ok: true, kid: device.kid, role: "owner" });
    expect(x.engine.pairDevice(device.jwk)).toMatchObject({ role: "owner" });
    expect(x.engine.pairDevice(other.jwk)).toMatchObject({ role: "pending" });
    expect(isRefusal(x.engine.pairDevice({ kty: "EC", crv: "P-256", x: "AA", y: "AA" }))).toBe(true);
    const action: OwnerAction = { type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: x.now() + DAY, nonce: x.nonce() };
    expect(code(await x.svc.exchange({ action, nonce: action.nonce, signature: signDevice(device, action) }))).toBe("account");
    const second: OwnerAction = { type: "userSetAbstraction", abstraction: "unifiedAccount", nonce: x.nonce() };
    expect(code(await x.svc.exchange({ action: second, nonce: second.nonce, signature: signDevice(other, second) }))).toBe("E_ACCOUNT_BAD_SIGNATURE");
    // a device key cannot sign what an agent signs
    const move: AgentAction = { type: "agentSendAsset", destination: "self", sourceDex: "okx", destinationDex: "hyperliquid", token: "USDC", amount: "1", fromSubAccount: "", maxFee: "5", nonce: x.nonce() };
    expect(code(await x.svc.exchange({ action: move, nonce: move.nonce, signature: { kid: device.kid, es256: signDevice(device, action).es256 } }))).toBe("E_ACCOUNT_BAD_SIGNATURE");
  });

  it("a fee approval is capped the way Hyperliquid caps a builder's", async () => {
    const x = await boot();
    const builder = simKey("builder").address;
    expect(code(await x.own({ type: "approveBuilderFee", builder, maxFeeRate: "0.2%" }))).toBe("E_ACCOUNT_LIMIT");
    expect(code(await x.own({ type: "approveBuilderFee", builder, maxFeeRate: "0.05%" }))).toBe("account");
    expect((await x.engine.view()).fees).toEqual([{ builder, maxFeeRate: "0.05%" }]);
    expect(code(await x.own({ type: "approveBuilderFee", builder, maxFeeRate: "0" }))).toBe("account");
    expect((await x.engine.view()).fees).toEqual([]);
  });
});

describe("policy, the ledger and the statement", () => {
  it("widening the agent's reach is the owner's to sign", async () => {
    const x = await boot();
    x.svc.setMode("guard");
    expect(code(await x.own({ type: "setPolicy", change: "mode", value: "open" }))).toBe("account");
    expect(x.svc.policy().mode).toBe("open");
    x.svc.revoke("okx");
    expect(code(await x.own({ type: "setPolicy", change: "restore", value: "okx" }))).toBe("account");
    expect(x.svc.policy().revoked).toEqual([]);
    expect(code(await x.own({ type: "setPolicy", change: "mode", value: "anything" }))).toBe("E_ACCOUNT_BAD_ACTION");
  });

  it("an account the user switched off, and an ended session, stop the agent's movements too", async () => {
    const x = await boot();
    await x.authorise(cc, "Claude Code");
    await x.approve(cc, "*", "600", "5000");
    x.svc.revoke("okx");
    expect(code(await x.transfer(cc, "okx", "hyperliquid", "100"))).toBe("E_WALLET_ACCOUNT_REVOKED");
    x.svc.restore("okx");
    x.svc.revokeAll();
    expect(code(await x.transfer(cc, "okx", "hyperliquid", "100"))).toBe("E_WALLET_SESSION_EXPIRED");
    // the owner's own signature is not the agent's session
    expect(code(await x.send({ sourceDex: "hyperliquid", destinationDex: "metamask", amount: "100" }))).toBe("payment");
  });

  it("every accepted instruction is on the hash-chained ledger with its signed envelope, and the file itself verifies", async () => {
    const x = await boot();
    await x.authorise(cc, "Claude Code");
    await x.approve(cc, "*", "600", "5000");
    const p = paid(await x.transfer(cc, "okx", "hyperliquid", "500"));
    await x.pass(7 * MIN);
    const rows = x.svc.rows();
    const accepted = rows.find((r) => r.kind === "action" && r.payment === p.id)!;
    expect([accepted.signer, accepted.agent, accepted.flight]).toEqual([cc.address, "claude-code", p.flight]);
    expect((accepted.envelope as { signature: { r: string } }).signature.r).toMatch(/^0x/);
    expect(rows.filter((r) => r.kind === "payment" && r.payment === p.id).map((r) => r.outcome)).toEqual(["leg started", "leg started", "leg started", "leg started", "settled"]);
    expect(rows.some((r) => r.kind === "account-refusal")).toBe(false);
    expect(x.svc.verifyChain().ok).toBe(true);
    // what is on disk is what is in memory, row for row
    const onDisk = readFileSync(x.svc.ledgerPath(), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { hash: string });
    expect(onDisk.map((r) => r.hash)).toEqual(rows.map((r) => r.hash));
  });

  it("the account's payments and the venue's own statement are compared, and a credit nobody sent is a break", async () => {
    const x = await boot();
    await x.authorise(cc, "Claude Code");
    await x.approve(cc, "*", "600", "5000");
    await x.transfer(cc, "okx", "hyperliquid", "500");
    await x.pass(7 * MIN);
    expect(x.engine.reconcile()).toEqual({ ok: true, matched: 1, breaks: [] });
    x.svc.adapter("hyperliquid")!.credit!("USDC", 77);
    const r = x.engine.reconcile();
    expect([r.ok, r.breaks]).toEqual([false, ["Hyperliquid hl-0002: $77.00 USDC came in and no payment of the account explains it"]]);
  });

  it("the page's view: ten venues with a way in and a way out each", async () => {
    const x = await boot();
    const v = await x.engine.view();
    expect(v.venues.map((r) => [r.name, r.frontLine, r.in.text, r.out.text])).toEqual([
      ["Alpaca", "Stocks", "At Alpaca · Tue 6 Oct", "At Alpaca · Tue 6 Oct"],
      ["Binance", "Exchange", "USDC · USDT · ~2 min", "At Binance · ~5 min"],
      ["OKX", "Exchange", "USDC · USDT · ~2 min", "USDC · USDT · ~5 min"],
      ["Hyperliquid", "Exchange", "CCTP · ~1 min", "Yours to sign · ~5 min"],
      ["MetaMask Agent Wallet", "On-chain", "USDC · USDT · now", "USDC · USDT · now"],
      ["Kalshi", "Prediction", "At Kalshi · Tue 6 Oct", "At Kalshi · Tue 6 Oct"],
      ["Polymarket", "Prediction", "USDC · now", "USDC · ~1 min"],
      ["Ondo · OUSG", "RWA", "USDC · now", "USDC · now"],
    ]);
    expect([v.type, v.signers.threshold, v.activeKeys, v.inFlightUsd]).toEqual(["Separate", 1, 0, 0]);
  });

  it("the clock can be pushed ahead, and what came due lands", async () => {
    const x = await boot();
    const p = paid(await x.send({ sourceDex: "hyperliquid", destinationDex: "metamask", amount: "100" }));
    expect(await x.svc.advance(6 * MIN)).toBe(new Date(START + 6 * MIN).toISOString());
    expect(p.status).toBe("settled");
    x.svc.reset();
    expect(x.svc.now()).toBe(new Date(START).toISOString());
  });
});
