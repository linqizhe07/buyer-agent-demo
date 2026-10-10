import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeAbiParameters, encodeEventTopics, parseAbiItem, type Hex } from "viem";
import { afterAll, describe, expect, it } from "vitest";
import { isRefusal, type Refusal } from "../../src/core/errors.ts";
import { cardHash, type Outcome } from "../../src/portfolio/account/exchange.ts";
import * as X from "../../src/portfolio/account/protocols.ts";
import { signAgent, signOwner, simKey, type AgentAction, type OwnerAction } from "../../src/portfolio/account/sign.ts";
import { guardedHttp, privateAddress, type PayRequest, type PayResponse } from "../../src/portfolio/live/guarded-http.ts";
import type { ChainName, ChainReader, ChainSender, Mined } from "../../src/portfolio/live/chain.ts";
import { register, type LiveDeps } from "../../src/portfolio/live/index.ts";
import type { LiveWriter } from "../../src/portfolio/live/writes.ts";
import { PortfolioService } from "../../src/portfolio/service.ts";

/** An agent pays someone else with REAL money, from an agent wallet the account holds the key of: x402 (V2 and V1) and an MPP charge, against
 * stand-in payees that check the signature the way a facilitator would, and a stand-in chain that says what moved. */
type NoNonce<T> = T extends unknown ? Omit<T, "nonce"> : never;
const START = Date.parse("2026-10-05T14:00:00.000Z");
const DAY = 86_400_000;
const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));
const owner = simKey("owner");
const cc = simKey("agent:claude-code");
const BASE_USDC: Hex = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAYEE: Hex = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const OTHER: Hex = "0x7A11000000000000000000000000000000000001";
const DEPOSIT: Hex = "0x00000000000000000000000000000000000d3905";
const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

/** a chain that answers from tables: balances, spent authorisations, mined transfers */
function standInChain() {
  const c = { usdc: new Map<string, number>(), gas: new Map<string, number>(), used: new Set<string>(), mined: new Map<string, Mined>(), sent: [] as Array<{ chain: ChainName; token: Hex; to: Hex; units: bigint; from: string }> };
  const reader: ChainReader = {
    async tokens(holder, refs) {
      return { rows: refs.map((r) => ({ chain: r.chain, asset: r.asset, amount: r.asset === "USDC" && r.chain === "Base" ? (c.usdc.get(holder.toLowerCase()) ?? 0) : 0 })), failed: [] };
    },
    async native(holder, chains) {
      return { rows: chains.map((ch) => ({ chain: ch, asset: "ETH", amount: ch === "Base" ? (c.gas.get(holder.toLowerCase()) ?? 0) : 0 })), failed: [] };
    },
    async uint() {
      return undefined;
    },
    async decimals() {
      return 6;
    },
    async receipt(_chain, hash) {
      return c.mined.get(hash);
    },
    async authorizationUsed(_chain, _token, authorizer, nonce) {
      return c.used.has(`${authorizer.toLowerCase()}:${nonce}`);
    },
  };
  /** a transfer of USDC on chain: the balance moves, and its receipt names it */
  const transfer = (from: string, to: string, units: number, hash: Hex) => {
    c.usdc.set(from.toLowerCase(), (c.usdc.get(from.toLowerCase()) ?? 0) - units / 1e6);
    c.usdc.set(to.toLowerCase(), (c.usdc.get(to.toLowerCase()) ?? 0) + units / 1e6);
    c.mined.set(hash, { status: "success", from: from as Hex, to: BASE_USDC, logs: [{ address: BASE_USDC, topics: encodeEventTopics({ abi: [TRANSFER], eventName: "Transfer", args: { from: from as Hex, to: to as Hex } }) as Hex[], data: encodeAbiParameters([{ type: "uint256" }], [BigInt(units)]) }] });
  };
  const sender: ChainSender = {
    async transfer(r) {
      c.sent.push({ ...r, from: r.account.address.toLowerCase() });
      const hash = `0x${String(c.sent.length).padStart(64, "5")}` as Hex;
      transfer(r.account.address, r.to, Number(r.units), hash);
      return { hash };
    },
  };
  return { c, reader, sender, transfer };
}

/** payees at https hosts that check what a facilitator checks: the signature recovers to the payer, the amount and the address are theirs */
function standInPayees(chain: ReturnType<typeof standInChain>) {
  const p = { asked: [] as PayRequest[], payTo: PAYEE as string, amount: "10000", settle: true, asset: BASE_USDC as string, n: 0 };
  const accept = (host: string) => ({ scheme: "exact", network: "eip155:8453", amount: p.amount, asset: p.asset, payTo: p.payTo, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" }, resource: `https://${host}/v1/quote` });
  const pay = async (a: X.Eip3009, signature: Hex, req: { network: string; asset: string; extra: { name: string; version: string } }): Promise<{ ok: boolean; hash?: Hex }> => {
    if ((await X.eip3009Signer(req, a, signature)) !== a.from.toLowerCase() || a.to.toLowerCase() !== p.payTo.toLowerCase() || a.value !== p.amount) return { ok: false };
    if (!p.settle) return { ok: true };
    chain.c.used.add(`${a.from.toLowerCase()}:${a.nonce}`);
    const hash = `0x${String(++p.n).padStart(64, "a")}` as Hex;
    chain.transfer(a.from, a.to, Number(a.value), hash);
    return { ok: true, hash };
  };
  const http = async (req: PayRequest): Promise<PayResponse> => {
    p.asked.push(req);
    const u = new URL(req.url);
    const h = Object.fromEntries(Object.entries(req.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    if (u.host === "data.example.com" || u.host === "free.example.com") {
      if (u.host === "free.example.com") return { status: 200, headers: {}, body: { free: true } };
      const sig = h["payment-signature"];
      if (!sig) return { status: 402, headers: { "payment-required": X.b64json({ x402Version: 2, error: "PAYMENT-SIGNATURE header is required", resource: { url: req.url, description: "a quote", mimeType: "application/json" }, accepts: [accept(u.host)] }) }, body: {} };
      const payload = X.unb64json<X.X402Payload>(sig)!;
      const r = await pay(payload.payload.authorization, payload.payload.signature, payload.accepted);
      if (!r.ok) return { status: 402, headers: { "payment-response": X.b64json({ success: false, errorReason: "invalid_exact_evm_payload_signature", transaction: "", network: "eip155:8453" }) }, body: {} };
      return { status: 200, headers: r.hash ? { "payment-response": X.b64json({ success: true, transaction: r.hash, network: "eip155:8453", payer: payload.payload.authorization.from }) } : {}, body: { symbol: u.searchParams.get("symbol"), price: 150.12 } };
    }
    if (u.host === "v1.example.com") {
      const sig = h["x-payment"];
      const v1 = { scheme: "exact", network: "base", maxAmountRequired: p.amount, asset: p.asset, payTo: p.payTo, resource: req.url, description: "a quote", mimeType: "application/json", maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } };
      if (!sig) return { status: 402, headers: {}, body: { x402Version: 1, error: "payment required", accepts: [v1] } };
      const payload = X.unb64json<{ x402Version: number; network: string; payload: { authorization: X.Eip3009; signature: Hex } }>(sig)!;
      const r = await pay(payload.payload.authorization, payload.payload.signature, { network: "eip155:8453", asset: p.asset, extra: v1.extra });
      return r.ok ? { status: 200, headers: { "x-payment-response": X.b64json({ success: true, transaction: r.hash, network: "base", payer: payload.payload.authorization.from }) }, body: { v: 1, ok: true } } : { status: 402, headers: {}, body: { x402Version: 1, error: "bad payment", accepts: [v1] } };
    }
    if (u.host === "mpp.example.com") {
      const auth = h.authorization;
      const request = X.jcs64({ amount: p.amount, currency: p.asset, recipient: p.payTo, methodDetails: { chainId: 8453 } });
      const ch = { realm: "mpp.example.com", method: "evm", intent: "charge", request };
      const challenge: X.MppChallenge = { id: X.mppChallengeId("secret", ch), ...ch };
      if (!auth) return { status: 402, headers: { "www-authenticate": X.mppHeader(challenge) }, body: { title: "Payment Required" } };
      const cred = X.mppReadAuthorization(auth)!;
      const a = cred.payload.authorization as X.Eip3009;
      if (a.nonce !== X.mppChargeNonce(challenge)) return { status: 402, headers: {}, body: { title: "wrong nonce" } };
      const r = await pay(a, cred.payload.signature as Hex, { network: "eip155:8453", asset: p.asset, extra: { name: "USD Coin", version: "2" } });
      return r.ok ? { status: 200, headers: { "payment-receipt": X.jcs64({ status: "success", method: "evm", timestamp: new Date(START).toISOString(), reference: r.hash }) }, body: { answer: 42 } } : { status: 402, headers: {}, body: { title: "bad" } };
    }
    return { status: 404, headers: {}, body: {} };
  };
  return { p, http };
}

register({ kind: "standin-deposits", label: "an exchange that takes deposits", needs: "key-file", example: "", venues: [], async open(req) {
  const writer: LiveWriter = { can: { withdraw: false, ledgers: [], transfer: false, swap: false, receive: true, send: false }, async depositAddress() { return { address: DEPOSIT }; } };
  return { source: { name: req.label || "Exchange", kind: "cex", reference: "standin", via: "a stand-in", probe: { can: [], note: "" }, read: async () => [], writer }, first: [], summary: "connected" };
} });

async function boot(o: { home?: string; at?: number; chain?: ReturnType<typeof standInChain> } = {}) {
  const home = o.home ?? mkdtempSync(join(tmpdir(), "account-pay-real-"));
  if (!o.home) homes.push(home);
  const at = o.at ?? 0;
  let real = START + at;
  let n = 0;
  const chain = o.chain ?? standInChain();
  const payees = standInPayees(chain);
  const liveDeps: Partial<LiveDeps> = { clock: () => real, chain: chain.reader, sender: chain.sender, http: async () => ({ status: 599, body: undefined, text: "" }), price: async () => undefined };
  const svc = await PortfolioService.create({ home, now: () => new Date(START + at).toISOString(), venues: "frontline", real: true, liveDeps, payHttp: payees.http, liveWrites: { capUsd: 100, pairingCode: "K7QX-M2PA" }, account: { owners: [{ id: owner.address, kind: "eoa", label: "owner", addedAt: new Date(START).toISOString() }] } });
  await svc.restoring;
  const engine = svc.account!;
  const nonce = () => START + at + ++n;
  const own = async (a: NoNonce<OwnerAction>) => svc.exchange(await signOwner(owner, { ...a, nonce: nonce() } as OwnerAction));
  const ag = async (a: NoNonce<AgentAction>) => svc.exchange(await signAgent(cc, { ...a, nonce: nonce() } as AgentAction));
  const ok = async (o: Promise<Outcome>) => {
    const r = await o;
    if (isRefusal(r)) throw new Error(`${r.code}: ${r.message}`);
    return r;
  };
  if (!o.home) {
    await ok(own({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: START + 30 * DAY }));
    await ok(own({ type: "createSubAccount", name: "research", agent: cc.address, float: "20" }));
    chain.c.usdc.set(engine.state.subAccounts[0]!.address, 10);
  }
  const wallet = engine.state.subAccounts[0]!.address;
  const pay = (url: string, maxAmount = "0.05", extra: Record<string, unknown> = {}) => ag({ type: "agentPay", url, maxAmount, fromSubAccount: "research", ...extra });
  const approve = async (id: string) => own({ type: "approveCard", card: id, action: cardHash(engine.host.card(id)!), decision: "approve" });
  const limit = () => engine.state.spends.find((s) => s.scope === "payees" && s.revokedAt === undefined)!;
  return { svc, engine, home, chain, payees, own, ag, ok, pay, approve, limit, wallet, tick: (ms: number) => (real += ms) };
}

const refusal = (o: Outcome | Refusal): Refusal => {
  if (!isRefusal(o)) throw new Error(`expected a refusal, got ${o.kind}`);
  return o;
};
const paid = (o: Outcome | Refusal) => {
  if (isRefusal(o) || o.kind !== "payment") throw new Error(`expected a payment, got ${isRefusal(o) ? `${o.code}: ${o.message}` : o.kind}`);
  return o as Extract<Outcome, { kind: "payment" }> & { data?: unknown };
};

describe("an agent wallet", () => {
  it("is made by the owner's signature: a key of its own in the home, and a place on the account the chains are read for", async () => {
    const x = await boot();
    const path = join(x.home, "agent-wallets", "research.json");
    expect([existsSync(path), statSync(path).mode & 0o777]).toEqual([true, 0o600]);
    expect(x.wallet).not.toBe(simKey("sub-account:research").address);
    // read from the chains like any wallet (a read is kept thirty seconds): the dollars the owner put in it show
    x.tick(31_000);
    const page = (await x.svc.accountView())!;
    const v = page.venues.find((y) => y.id === "agent-research")!;
    expect([v.name, v.usd, v.proven, v.address?.toLowerCase()]).toEqual(["Agent wallet · research", 10, "this account holds its key", x.wallet]);
  });

  it("sends money back to a place of the user's — paying its own gas — and not without gas", async () => {
    const x = await boot();
    await x.ok(x.own({ type: "connectVenue", venue: "ex", connector: "live:standin-deposits", label: "Exchange", credentialRef: "" }));
    const draft = { type: "liveMove", kind: "send", from: "agent-research", to: "ex", asset: "USDC", toAsset: "USDC", network: "Base", amount: "4" };
    const p = await x.engine.prepare(draft);
    if (isRefusal(p)) throw new Error(p.message);
    const { nonce: _n, ...action } = p.action as Extract<OwnerAction, { type: "liveMove" }>;
    expect(refusal(await x.own(action)).code).toBe("E_WALLET_INSUFFICIENT");
    x.chain.c.gas.set(x.wallet, 0.001);
    const out = await x.ok(x.own(action));
    expect(out.kind === "payment" && [out.payment.status, out.payment.live?.txHash]).toEqual(["pending", `0x${"1".padStart(64, "5")}`]);
    expect(x.chain.c.sent).toMatchObject([{ chain: "Base", token: BASE_USDC, to: DEPOSIT, units: 4_000_000n, from: x.wallet }]);
    x.tick(30_000);
    await x.engine.settle();
    expect(x.engine.payments[0]!.status).toBe("settled");
  });
});

describe("an agent pays someone else, from its agent wallet", () => {
  it("x402: Guard asks the owner first; the owner's yes pays exactly what was shown, and the chain is what says it moved", async () => {
    const x = await boot();
    await x.ok(x.own({ type: "approveSpend", agent: cc.address, scope: "payees", allow: "data.example.com", perPayment: "1", budget: "5", windowHours: 0, validUntil: START + 7 * DAY }));
    const first = await x.pay("https://data.example.com/v1/quote?symbol=NVDA");
    if (isRefusal(first) || first.kind !== "card") throw new Error(`expected a card, got ${JSON.stringify(first).slice(0, 200)}`);
    expect(first.card.offer).toMatchObject({ payee: "data.example.com", payTo: PAYEE.toLowerCase(), amount: "0.01 USDC", protocol: "x402 · EIP-3009", network: "Base" });
    const released = await x.approve(first.card.id);
    expect(isRefusal(released)).toBe(false);
    const card = x.engine.host.card(first.card.id)! as unknown as { status: string; outcome?: unknown };
    expect(card.status).toBe("approved");
    const done = paid(card.outcome as Outcome);
    expect([done.payment.amountUsd, done.payment.from, done.payment.to, done.payment.protocol, done.payment.live?.network]).toEqual([0.01, "agent-research", "data.example.com", "x402", "Base"]);
    expect(done.data).toEqual({ symbol: "NVDA", price: 150.12 });
    expect([x.limit().spentMicro, x.limit().reservedMicro, x.limit().payTo]).toEqual([10_000, 0, { "data.example.com": PAYEE.toLowerCase() }]);
    expect(x.chain.c.usdc.get(x.wallet)).toBeCloseTo(9.99, 6);
    expect(x.svc.statement()[0]).toMatchObject({ kind: "pay", type: "transfer", accountName: "Agent wallet · research", status: "settled", amountUsd: 0.01 });
  });

  it("Beast: a payee paid before is paid at once; a changed address, an overcharge, an unnamed host are refused, and the last is never asked", async () => {
    const x = await boot();
    await x.ok(x.own({ type: "approveSpend", agent: cc.address, scope: "payees", allow: "data.example.com", perPayment: "1", budget: "5", windowHours: 0, validUntil: START + 7 * DAY }));
    await x.ok(x.own({ type: "setPolicy", change: "mode", value: "open" }));
    // a first payment is still a card in Beast: the owner pins the payee's address once
    const first = await x.pay("https://data.example.com/v1/quote?symbol=A");
    expect(!isRefusal(first) && first.kind).toBe("card");
    if (!isRefusal(first) && first.kind === "card") await x.approve(first.card.id);
    const again = paid(await x.pay("https://data.example.com/v1/quote?symbol=B"));
    expect(again.data).toEqual({ symbol: "B", price: 150.12 });
    x.payees.p.payTo = OTHER;
    expect(refusal(await x.pay("https://data.example.com/v1/quote?symbol=C")).code).toBe("E_PAYEE_CHANGED");
    x.payees.p.payTo = PAYEE;
    x.payees.p.amount = "90000";
    expect(refusal(await x.pay("https://data.example.com/v1/quote?symbol=D")).code).toBe("E_PAYEE_OVERCHARGE");
    const before = x.payees.p.asked.length;
    expect(refusal(await x.pay("https://evil.example.com/drain")).code).toBe("E_MANDATE_RECIPIENT");
    expect(x.payees.p.asked.length).toBe(before);
  });

  it("any payee, when the owner signed `*`: Beast pays a new host without a card and pins its address; the agent wallet bounds it", async () => {
    const x = await boot();
    await x.ok(x.own({ type: "approveSpend", agent: cc.address, scope: "payees", allow: "*", perPayment: "1", budget: "5", windowHours: 0, validUntil: START + 7 * DAY }));
    await x.ok(x.own({ type: "setPolicy", change: "mode", value: "open" }));
    paid(await x.pay("https://data.example.com/v1/quote?symbol=Z"));
    expect(x.limit().payTo).toEqual({ "data.example.com": PAYEE.toLowerCase() });
    // x402 V1 and an MPP charge, the same way
    expect(paid(await x.pay("https://v1.example.com/v1/quote")).data).toEqual({ v: 1, ok: true });
    expect(paid(await x.pay("https://mpp.example.com/ask")).payment.protocol).toBe("mpp-charge");
    // a page that needs no payment is fetched and nothing is paid
    const free = await x.pay("https://free.example.com/");
    expect(!isRefusal(free) && free.kind === "result" && free.result).toMatchObject({ paid: false, data: { free: true } });
    // more than the agent wallet holds
    x.chain.c.usdc.set(x.wallet, 0.005);
    expect(refusal(await x.pay("https://data.example.com/v1/quote?symbol=Y")).code).toBe("E_WALLET_INSUFFICIENT");
    // a token that is not USDC at Circle's address on the chain
    x.chain.c.usdc.set(x.wallet, 10);
    x.payees.p.asset = OTHER;
    expect(refusal(await x.pay("https://data.example.com/v1/quote?symbol=W")).code).toBe("E_PAYEE_UNSUPPORTED");
    expect(x.limit().spentMicro).toBe(30_000);
  });

  it("an authorisation the payee kept without settling is set aside, and booked when the chain shows it used", async () => {
    const x = await boot();
    await x.ok(x.own({ type: "approveSpend", agent: cc.address, scope: "payees", allow: "*", perPayment: "1", budget: "5", windowHours: 0, validUntil: START + 7 * DAY }));
    await x.ok(x.own({ type: "setPolicy", change: "mode", value: "open" }));
    x.payees.p.settle = false;
    const kept = await x.pay("https://data.example.com/v1/quote?symbol=K");
    expect(!isRefusal(kept) && kept.kind === "result" && (kept.result as { paid: string }).paid).toBe("not yet");
    expect([x.limit().spentMicro, x.limit().reservedMicro]).toEqual([0, 10_000]);
    // the payee cashes it a moment later
    const last = x.payees.p.asked.at(-1)!;
    const payload = X.unb64json<X.X402Payload>(Object.entries(last.headers ?? {}).find(([k]) => k.toLowerCase() === "payment-signature")![1])!;
    x.chain.c.used.add(`${payload.payload.authorization.from.toLowerCase()}:${payload.payload.authorization.nonce}`);
    await x.engine.settle();
    await new Promise((r) => setTimeout(r, 20));
    expect([x.limit().spentMicro, x.limit().reservedMicro]).toEqual([10_000, 0]);
    expect(x.engine.payments[0]).toMatchObject({ kind: "pay", status: "settled", note: "data.example.com settled the payment after it had answered" });
  });
});

describe("after a restart", () => {
  it("the agent wallet is the same wallet, its limit has what it used and the address it pinned, and a paid payee is paid at once again", async () => {
    const x = await boot();
    await x.ok(x.own({ type: "approveSpend", agent: cc.address, scope: "payees", allow: "data.example.com", perPayment: "1", budget: "5", windowHours: 0, validUntil: START + 7 * DAY }));
    await x.ok(x.own({ type: "setPolicy", change: "mode", value: "open" }));
    const first = await x.pay("https://data.example.com/v1/quote?symbol=A");
    if (!isRefusal(first) && first.kind === "card") await x.approve(first.card.id);
    expect(x.limit().spentMicro).toBe(10_000);
    const y = await boot({ home: x.home, at: 3_600_000, chain: x.chain });
    expect([y.wallet, y.svc.restored?.venues]).toEqual([x.wallet, []]);
    expect([y.limit().spentMicro, y.limit().payTo]).toEqual([10_000, { "data.example.com": PAYEE.toLowerCase() }]);
    expect((await y.svc.accountView())!.venues.map((v) => v.id)).toEqual(["agent-research"]);
    // paid before, Beast: no card this time either
    expect(paid(await y.pay("https://data.example.com/v1/quote?symbol=B")).data).toEqual({ symbol: "B", price: 150.12 });
    expect(y.limit().spentMicro).toBe(20_000);
  });
});

describe("the account asks only public https hosts", () => {
  it("never this machine, the local network, link-local or reserved space", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "172.16.0.9", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1"]) expect([a, privateAddress(a)]).toEqual([a, true]);
    for (const a of ["8.8.8.8", "104.18.0.1", "2606:4700::1111"]) expect([a, privateAddress(a)]).toEqual([a, false]);
  });

  it("refuses http, an address on this machine, and a name that resolves to one — before anything is sent", async () => {
    expect((await guardedHttp({ method: "GET", url: "http://example.com/" })).error).toBe("a payee is asked over https, at a plain host");
    expect((await guardedHttp({ method: "GET", url: "https://127.0.0.1:4820/api/account" })).error).toBe("127.0.0.1 is not a public address");
    expect((await guardedHttp({ method: "GET", url: "https://user:pw@example.com/" })).error).toBe("a payee is asked over https, at a plain host");
    // a name that resolves to this machine: said by its kind, never by the address (on a filtering network it is the filter's sinkhole)
    expect((await guardedHttp({ method: "GET", url: "https://localhost:4820/" }))).toMatchObject({ status: 0, kind: "filtered-address", error: "on this network the name resolves to a local or reserved address, so the payee was not asked" });
  });
});
