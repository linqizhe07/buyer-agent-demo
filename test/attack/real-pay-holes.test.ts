/** ATTACKS THAT MUST FAIL (found by an independent review on 2026-10-05, against real payments from agent wallets): each test below is the
 * attack as it went through then, and asserts that it no longer does.
 *
 *   R9a an authorisation the payee had cashed was let go unbooked when the chain did not answer at the moment it lapsed
 *   R9b one payment per payee per window was not applied under an approval for every payee
 *   R9c an authorisation the payee still held was forgotten by a restart: its amount freed, and never booked when it was cashed
 *   R10 the payee guard let an IPv4 address written as IPv6 the way a URL writes it (::ffff:7f00:1) reach this machine
 *   R12 two agent wallets whose names differ in case or punctuation were one key: each agent paid from the other's float */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { isRefusal } from "../../src/core/errors.ts";
import * as X from "../../src/portfolio/account/protocols.ts";
import { signAgent, signOwner, simKey, type AgentAction, type OwnerAction } from "../../src/portfolio/account/sign.ts";
import type { ChainReader, ChainSender } from "../../src/portfolio/live/chain.ts";
import { guardedHttp, privateAddress, type PayRequest, type PayResponse } from "../../src/portfolio/live/guarded-http.ts";
import type { LiveDeps } from "../../src/portfolio/live/index.ts";
import { PortfolioService } from "../../src/portfolio/service.ts";

type NoNonce<T> = T extends unknown ? Omit<T, "nonce"> : never;
const START = Date.parse("2026-10-05T14:00:00.000Z");
const DAY = 86_400_000;
const owner = simKey("owner");
const cc = simKey("agent:claude-code");
const other = simKey("agent:other");
const BASE_USDC: Hex = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAYEE: Hex = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));
const flush = () => new Promise((r) => setTimeout(r, 30));
const ok = <T,>(o: T): T => {
  if (isRefusal(o as never)) throw new Error(JSON.stringify(o));
  return o;
};

/** a chain that holds what the test says, whose token records which authorisations were used — and an endpoint that can stop answering */
function standInChain() {
  const c = { usdc: new Map<string, number>(), used: new Set<string>(), down: false };
  const reader: ChainReader = {
    async tokens(holder, refs) {
      return { rows: refs.map((r) => ({ chain: r.chain, asset: r.asset, amount: r.asset === "USDC" && r.chain === "Base" ? (c.usdc.get(holder.toLowerCase()) ?? 0) : 0 })), failed: [] };
    },
    async native(_h, chains) {
      return { rows: chains.map((ch) => ({ chain: ch, asset: "ETH", amount: 0 })), failed: [] };
    },
    async uint() {
      return undefined;
    },
    async decimals() {
      return 6;
    },
    async receipt() {
      return undefined;
    },
    async authorizationUsed(_chain, _token, authorizer, nonce) {
      return c.down ? undefined : c.used.has(`${authorizer.toLowerCase()}:${nonce}`);
    },
  };
  const sender: ChainSender = { async transfer() { return { error: "not here" }; } };
  return { c, reader, sender };
}

/** an x402 payee that keeps every authorisation it is given and, unless told to settle, does not use it at once */
function payee(chain: ReturnType<typeof standInChain>) {
  const p = { kept: [] as X.Eip3009[], settle: true };
  const http = async (req: PayRequest): Promise<PayResponse> => {
    const h = Object.fromEntries(Object.entries(req.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const accept = { scheme: "exact", network: "eip155:8453", amount: "400000", asset: BASE_USDC, payTo: PAYEE, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } };
    const sig = h["payment-signature"];
    if (!sig) return { status: 402, headers: { "payment-required": X.b64json({ x402Version: 2, error: "pay", resource: { url: req.url, description: "x", mimeType: "application/json" }, accepts: [accept] }) }, body: {} };
    const a = X.unb64json<X.X402Payload>(sig)!.payload.authorization;
    p.kept.push(a);
    if (p.settle) chain.c.used.add(`${a.from.toLowerCase()}:${a.nonce}`);
    return { status: 200, headers: {}, body: { ok: true } };
  };
  /** the payee cashes an authorisation it kept */
  const cash = (a: X.Eip3009) => {
    chain.c.used.add(`${a.from.toLowerCase()}:${a.nonce}`);
    chain.c.usdc.set(a.from.toLowerCase(), (chain.c.usdc.get(a.from.toLowerCase()) ?? 0) - Number(a.value) / 1e6);
  };
  return { p, http, cash };
}

async function boot(o: { home?: string; at?: number; chain?: ReturnType<typeof standInChain>; allow?: string; windowHours?: number } = {}) {
  const home = o.home ?? mkdtempSync(join(tmpdir(), "attack-pay-"));
  if (!o.home) homes.push(home);
  let real = START + (o.at ?? 0);
  let n = 0;
  const chain = o.chain ?? standInChain();
  const pp = payee(chain);
  const liveDeps: Partial<LiveDeps> = { clock: () => real, chain: chain.reader, sender: chain.sender, http: async () => ({ status: 599, body: undefined, text: "" }), price: async () => undefined };
  const svc = await PortfolioService.create({ home, now: () => new Date(real).toISOString(), venues: "frontline", real: true, liveDeps, payHttp: pp.http, liveWrites: { capUsd: 100, pairingCode: "K7QX-M2PA" }, account: { owners: [{ id: owner.address, kind: "eoa", label: "owner", addedAt: new Date(START).toISOString() }] } });
  await svc.restoring;
  const engine = svc.account!;
  const own = async (a: NoNonce<OwnerAction>) => svc.exchange(await signOwner(owner, { ...a, nonce: real + ++n } as OwnerAction));
  const ag = async (a: NoNonce<AgentAction>, key = cc) => svc.exchange(await signAgent(key, { ...a, nonce: real + ++n } as AgentAction));
  if (!o.home) {
    await own({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: START + 30 * DAY });
    await own({ type: "createSubAccount", name: "research", agent: cc.address, float: "20" });
    chain.c.usdc.set(engine.state.subAccounts[0]!.address, 10);
    await own({ type: "approveSpend", agent: cc.address, scope: "payees", allow: o.allow ?? "*", perPayment: "1", budget: "1", windowHours: o.windowHours ?? 0, validUntil: START + 7 * DAY });
    await own({ type: "setPolicy", change: "mode", value: "open" });
  }
  const pay = (url: string) => ag({ type: "agentPay", url, maxAmount: "1", fromSubAccount: "research" });
  const limit = () => engine.state.spends.find((s) => s.scope === "payees" && s.revokedAt === undefined)!;
  return { svc, engine, home, chain, pp, own, ag, pay, limit, wallet: engine.state.subAccounts[0]!.address, tick: (ms: number) => (real += ms) };
}

describe("R9 · real payments", () => {
  it("a: an authorisation is let go only on the chain's word that it was not used — a chain that does not answer keeps it set aside", async () => {
    const x = await boot();
    x.pp.p.settle = false;
    await x.pay("https://data.example.com/q?i=1");
    expect(x.limit().reservedMicro).toBe(400_000);
    // the payee cashes it within its minute; the endpoint does not answer when the minute (and the grace after it) has passed
    x.pp.cash(x.pp.p.kept.at(-1)!);
    x.chain.c.down = true;
    x.tick(10 * 60_000);
    await x.engine.settle();
    await flush();
    expect([x.limit().reservedMicro, x.limit().spentMicro]).toEqual([400_000, 0]);
    // it answers again: the payment is booked, and nothing more can be paid from the $1 budget than is left
    x.chain.c.down = false;
    await x.engine.settle();
    await flush();
    expect([x.limit().reservedMicro, x.limit().spentMicro]).toEqual([0, 400_000]);
  });

  it("b: one payment per payee per window holds under an approval for every payee, per payee", async () => {
    const x = await boot({ windowHours: 24 });
    expect(isRefusal(await x.pay("https://data.example.com/q?i=1"))).toBe(false);
    expect((await x.pay("https://data.example.com/q?i=2") as { code?: string }).code).toBe("E_MANDATE_RATE");
    expect(isRefusal(await x.pay("https://other.example.com/q"))).toBe(false);
  });

  it("c: an authorisation the payee held across a restart stays set aside, and is booked when it is cashed", async () => {
    const x = await boot();
    x.pp.p.settle = false;
    await x.pay("https://data.example.com/q");
    const y = await boot({ home: x.home, at: 20_000, chain: x.chain });
    expect(y.limit().reservedMicro).toBe(400_000);
    x.pp.cash(x.pp.p.kept.at(-1)!);
    await y.engine.settle();
    await flush();
    expect([y.limit().reservedMicro, y.limit().spentMicro]).toEqual([0, 400_000]);
    // the next one settles at once: $0.80 of the $1 budget is spent, and a third $0.40 does not fit
    expect(isRefusal(await y.pay("https://data.example.com/q2"))).toBe(false);
    expect(y.limit().spentMicro).toBe(800_000);
    expect((await y.pay("https://data.example.com/q3") as { code?: string }).code).toBe("E_MANDATE_BUDGET");
  });
});

describe("R10 · the payee guard and IPv6", () => {
  it("an IPv4 address in any IPv6 spelling, and every IPv6 range outside global unicast, is not a public address", () => {
    for (const a of ["::ffff:127.0.0.1", "::ffff:7f00:1", "0:0:0:0:0:ffff:7f00:1", "::ffff:a9fe:a9fe", "::127.0.0.1", "64:ff9b::7f00:1", "fe80::1%en0", "fd12::1", "ff02::1", "2001:db8::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "2002:7f00:1::"]) expect([a, privateAddress(a)]).toEqual([a, true]);
    for (const a of ["2606:4700:4700::1111", "2a00:1450:4001:82a::200e", "2002:808:808::1"]) expect([a, privateAddress(a)]).toEqual([a, false]);
  });

  it("a payee URL that names this machine that way is refused before anything connects", async () => {
    for (const url of ["https://[::ffff:127.0.0.1]:9/", "https://[0:0:0:0:0:ffff:7f00:1]:9/", "https://[::ffff:169.254.169.254]/latest/meta-data/"]) {
      const r = await guardedHttp({ method: "GET", url });
      expect([url, r.status, /not a public address/.test(r.error ?? "")]).toEqual([url, 0, true]);
    }
  });
});

describe("R12 · one name, one agent wallet", () => {
  it("names that differ only in case or the marks between letters are one key file: a second one is refused; a name needs a letter or a digit", async () => {
    const x = await boot();
    ok(await x.own({ type: "approveAgent", agentAddress: other.address, agentName: "Other", validUntil: START + 30 * DAY }));
    ok(await x.own({ type: "createSubAccount", name: "Ops", agent: cc.address, float: "5" }));
    for (const name of ["ops", "OPS ", "ops!", "-ops-"]) expect([name, (await x.own({ type: "createSubAccount", name, agent: other.address, float: "5" }) as { code?: string }).code]).toEqual([name, "E_ACCOUNT_BAD_ACTION"]);
    ok(await x.own({ type: "createSubAccount", name: "o.p.s", agent: other.address, float: "5" }));
    expect((await x.own({ type: "createSubAccount", name: "o_p_s", agent: other.address, float: "5" }) as { code?: string }).code).toBe("E_ACCOUNT_BAD_ACTION");
    expect((await x.own({ type: "createSubAccount", name: "...", agent: other.address, float: "5" }) as { code?: string }).code).toBe("E_ACCOUNT_BAD_ACTION");
    expect(new Set(x.engine.state.subAccounts.map((s) => s.address)).size).toBe(x.engine.state.subAccounts.length);
  });
});
