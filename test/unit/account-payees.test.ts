import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isRefusal, type Refusal } from "../../src/core/errors.ts";
import { cardHash, type CardLike, type Outcome } from "../../src/portfolio/account/exchange.ts";
import * as X from "../../src/portfolio/account/protocols.ts";
import { signAgent, signOwner, simKey, type AgentAction, type OwnerAction, type SimKey } from "../../src/portfolio/account/sign.ts";
import { PortfolioService } from "../../src/portfolio/service.ts";

type NoNonce<T> = T extends unknown ? Omit<T, "nonce"> : never;
type PayExtra = Partial<Pick<Extract<AgentAction, { type: "agentPay" }>, "builder" | "cnf" | "mandates" | "close">>;
const START = Date.parse("2026-10-05T14:00:00.000Z");
const MIN = 60_000;
const DAY = 86_400_000;
const QUOTE = "https://data.sim/v1/quotes?symbol=NVDA";
const ANSWER = "https://infer.sim/v1/answers";
const STREAM = "https://infer.sim/v1/stream";
const ITEM = "https://shop.sim/items/desk-feed-pro";
const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));

const owner = simKey("owner");
const cc = simKey("agent:claude-code");
const codex = simKey("agent:codex");

/** an account with one agent key, a funded float called `research`, and a spending approval for the three simulated payees */
async function boot(opts: { perPayment?: string; budget?: string; float?: string; allow?: string } = {}) {
  let t = START;
  let n = 0;
  const home = mkdtempSync(join(tmpdir(), "account-payees-"));
  homes.push(home);
  const svc = await PortfolioService.create({ home, now: () => new Date(t).toISOString(), venues: "frontline", account: { owners: [{ id: owner.address, kind: "eoa", label: "owner", addedAt: new Date(START).toISOString() }] } });
  const engine = svc.account!;
  const world = svc.payees!;
  const nonce = () => t + ++n;
  const own = async (a: NoNonce<OwnerAction>, by: SimKey = owner) => svc.exchange(await signOwner(by, { ...a, nonce: nonce() } as OwnerAction));
  const ag = async (key: SimKey, a: NoNonce<AgentAction>) => svc.exchange(await signAgent(key, { ...a, nonce: nonce() } as AgentAction));
  const pay = (url: string, maxAmount: string, from = "research", extra: PayExtra = {}, key: SimKey = cc) => ag(key, { type: "agentPay", url, maxAmount, fromSubAccount: from, ...extra });
  const answer = (card: CardLike, decision = "approve") => own({ type: "approveCard", card: card.id, action: cardHash(card), decision });
  /** pay, and — when the account asks the owner first — approve */
  const payOk = async (url: string, maxAmount: string, from = "research", extra: PayExtra = {}) => {
    const r = await pay(url, maxAmount, from, extra);
    return !isRefusal(r) && r.kind === "card" ? answer(r.card) : r;
  };
  const pass = async (ms: number) => {
    t += ms;
    await engine.settle();
  };
  const approve = (allow: string, perPayment: string, budget: string, key: SimKey = cc) => own({ type: "approveSpend", agent: key.address, scope: "payees", allow, perPayment, budget, windowHours: 0, validUntil: t + 30 * DAY });
  await own({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: t + 30 * DAY });
  await own({ type: "createSubAccount", name: "research", agent: cc.address, float: "60" });
  const fund = { destination: "self", sourceDex: "metamask", destinationDex: "sub:research", token: "USDC", amount: opts.float ?? "50" };
  const route = await engine.resolve(fund, "owner");
  if (isRefusal(route)) throw new Error(route.message);
  await own({ type: "sendAsset", ...fund, fromSubAccount: "", route: route.route.hash, maxFee: String(route.route.feeUsd), deadline: route.route.arrivalMs + MIN });
  await pass(2 * MIN);
  await approve(opts.allow ?? "data.sim,infer.sim,shop.sim", opts.perPayment ?? "30", opts.budget ?? "40");
  const float = () => engine.sub("research")!.balanceMicro;
  const spend = () => engine.state.spends.find((s) => s.scope === "payees" && s.revokedAt === undefined)!;
  return { svc, engine, world, own, ag, pay, payOk, answer, pass, approve, float, spend, start: float(), now: () => t };
}

const code = (o: Outcome): string => (isRefusal(o) ? o.code : o.kind);
const refusal = (o: Outcome): Refusal => {
  if (!isRefusal(o)) throw new Error(`expected a refusal, got ${o.kind}`);
  return o;
};
const paid = (o: Outcome) => {
  if (isRefusal(o) || o.kind !== "payment") throw new Error(`expected a payment, got ${isRefusal(o) ? `${o.code}: ${o.message}` : o.kind}`);
  return o;
};
const carded = (o: Outcome) => {
  if (isRefusal(o) || o.kind !== "card") throw new Error(`expected a card, got ${isRefusal(o) ? `${o.code}: ${o.message}` : o.kind}`);
  return o.card;
};

describe("x402: the account answers the payee, the agent only asks", () => {
  it("the first payment to a payee is a card that shows who is paid, where and how much; approving it pays and pins the address", async () => {
    const x = await boot();
    const payTo = x.world.data.payTo;
    const card = carded(await x.pay(QUOTE, "0.05"));
    expect(card.offer).toEqual({ payee: "data.sim", payTo, amount: "0.01 USDC", protocol: "x402 · EIP-3009", network: "Base Sepolia" });
    expect(card.reason).toContain("a first payment to data.sim: $0.01 to");
    // nothing has been paid: only the question went out, and the card holds its share of the budget
    expect(x.world.sent).toEqual([{ method: "GET", host: "data.sim", path: "/v1/quotes", status: 402 }]);
    expect([x.float(), x.spend().reservedMicro, x.spend().spentMicro]).toEqual([x.start, 10_000, 0]);

    const first = paid(await x.answer(card));
    expect(first.data).toEqual({ symbol: "NVDA", price: 150.12, currency: "USD", delayedMin: 15 });
    expect(first.payment).toMatchObject({ kind: "pay", from: "sub:research", to: "data.sim", amountUsd: 0.01, status: "settled", protocol: "x402", authority: "agent", card: card.id, external: { label: "data.sim", address: payTo, chain: "Base Sepolia" } });
    expect([x.start - x.float(), x.world.chain.balance(payTo), x.spend().reservedMicro, x.spend().spentMicro]).toEqual([10_000, 10_000, 0, 10_000]);
    expect(x.spend().payTo).toEqual({ "data.sim": payTo });

    // the second one flows
    const second = paid(await x.pay(QUOTE, "0.05"));
    expect(second.payment.card).toBeUndefined();
    expect(x.world.chain.balance(payTo)).toBe(20_000);
    // the ledger holds the wire: the offer, the signed authorisation, the settlement
    const row = x.svc.rows().filter((r) => r.kind === "action" && r.tool === "agentPay" && r.outcome === "accepted").at(-1)!;
    const native = row.native as { requirements: X.X402Requirements; payload: X.X402Payload; response: { transaction: string } };
    expect(native.requirements.payTo).toBe(payTo);
    expect(native.payload.payload.authorization).toMatchObject({ from: simKey("sub-account:research").address, to: payTo, value: "10000" });
    expect(x.world.chain.tx(native.response.transaction)).toMatchObject({ to: payTo, value: 10_000 });
    expect(x.svc.verifyChain().ok).toBe(true);
  });

  it("nothing is sent to a host the owner did not name; without an approval nothing is sent at all", async () => {
    const x = await boot({ allow: "data.sim" });
    expect(code(await x.pay("https://evil.sim/v1/quotes", "0.05"))).toBe("E_MANDATE_RECIPIENT");
    expect(code(await x.pay(ANSWER, "0.05"))).toBe("E_MANDATE_RECIPIENT");
    expect(code(await x.pay("http://data.sim/v1/quotes", "0.05"))).toBe("E_ACCOUNT_BAD_ACTION");
    expect(code(await x.pay("https://user:pw@data.sim/v1/quotes", "0.05"))).toBe("E_ACCOUNT_BAD_ACTION");
    await x.own({ type: "approveAgent", agentAddress: codex.address, agentName: "Codex", validUntil: x.now() + DAY });
    expect(code(await x.pay(QUOTE, "0.05", "research", {}, codex))).toBe("E_MANDATE_NONE");
    expect(x.world.sent).toEqual([]);
    // an approval never covers every payee
    expect(code(await x.approve("*", "1", "5"))).toBe("E_ACCOUNT_BAD_ACTION");
  });

  it("the payee asks for more than the agent agreed to, or for another address than the one pinned: refused, nothing moves", async () => {
    const x = await boot();
    paid(await x.payOk(QUOTE, "0.05"));
    const before = x.float();
    x.world.data.priceMicro = 500_000;
    const over = refusal(await x.pay(QUOTE, "0.05"));
    expect([over.code, over.message]).toEqual(["E_PAYEE_OVERCHARGE", "data.sim asks $0.50; the agent agreed to $0.05 at most"]);
    x.world.data.priceMicro = 10_000;
    const attacker = simKey("attacker").address;
    const honest = x.world.data.payTo;
    x.world.data.payTo = attacker;
    const changed = refusal(await x.pay(QUOTE, "0.05"));
    expect(changed.code).toBe("E_PAYEE_CHANGED");
    expect(changed.detail).toEqual({ pinned: honest, offered: attacker });
    expect([x.float(), x.world.chain.balance(attacker)]).toEqual([before, 0]);
  });

  it("a redirect is not followed, an offer for another host is not paid, a silent host is a refusal", async () => {
    const x = await boot();
    x.world.data.redirect = "https://evil.sim/pay";
    const r = refusal(await x.pay(QUOTE, "0.05"));
    expect([r.code, r.message]).toEqual(["E_PAYEE_REDIRECT", "data.sim sent the request on to another address: a payment does not follow a redirect"]);
    expect(x.world.sent.map((s) => s.host)).toEqual(["data.sim"]);
    x.world.data.redirect = undefined;
    x.world.data.resourceHost = "evil.sim";
    expect(code(await x.pay(QUOTE, "0.05"))).toBe("E_PAYEE_UNVERIFIED");
    x.world.data.resourceHost = undefined;
    x.world.down.add("data.sim");
    expect(code(await x.pay(QUOTE, "0.05"))).toBe("E_PAYEE_REJECTED");
    expect(x.float()).toBe(x.start);
  });

  it("many small payments cannot add up past the budget, and one cannot pass the per-payment line", async () => {
    const x = await boot({ perPayment: "0.02", budget: "0.05" });
    paid(await x.payOk(QUOTE, "0.02"));
    for (let i = 0; i < 4; i++) paid(await x.pay(QUOTE, "0.02"));
    const sixth = refusal(await x.pay(QUOTE, "0.02"));
    expect([sixth.code, sixth.message]).toEqual(["E_MANDATE_BUDGET", "the spending approval has $0.00 left of $0.05; $0.01 is more than that"]);
    expect(x.start - x.float()).toBe(50_000);
    x.world.data.priceMicro = 30_000;
    expect(code(await x.pay(QUOTE, "0.05"))).toBe("E_MANDATE_PER_ORDER_CAP");
  });

  it("payments sent at the same moment cannot together pass the budget", async () => {
    const x = await boot({ perPayment: "0.02", budget: "0.03" });
    paid(await x.payOk(QUOTE, "0.05"));
    const many = await Promise.all([1, 2, 3, 4, 5].map(() => x.pay(QUOTE, "0.05")));
    expect(many.map(code).sort()).toEqual(["E_MANDATE_BUDGET", "E_MANDATE_BUDGET", "E_MANDATE_BUDGET", "payment", "payment"]);
    expect([x.start - x.float(), x.spend().spentMicro]).toEqual([30_000, 30_000]);
  });

  it("the same signed request again is the first answer: one payment, not two", async () => {
    const x = await boot();
    paid(await x.payOk(QUOTE, "0.05"));
    const env = await signAgent(cc, { type: "agentPay", url: QUOTE, maxAmount: "0.05", fromSubAccount: "research", nonce: x.now() + 500 });
    const first = await x.svc.exchange(env);
    const again = await x.svc.exchange(env);
    expect(again).toBe(first);
    expect(x.start - x.float()).toBe(20_000);
    // and the signed authorisation itself cannot be settled a second time at the payee
    const sent = (x.svc.rows().filter((r) => r.tool === "agentPay" && r.outcome === "accepted").at(-1)!.native as { payload: X.X402Payload }).payload;
    const replay = await x.world.fetch({ method: "GET", url: QUOTE, headers: { "PAYMENT-SIGNATURE": X.b64json(sent) } }, x.now());
    // a failed payment is a 402 whose PAYMENT-RESPONSE says why, with a fresh offer beside it
    expect([replay.status, X.unb64json<{ success: boolean; errorReason: string }>(replay.headers["payment-response"]!), X.unb64json<X.X402Required>(replay.headers["payment-required"]!)?.error]).toEqual([402, expect.objectContaining({ success: false, errorReason: "invalid_transaction_state" }), "invalid_transaction_state"]);
    const garbage = await x.world.fetch({ method: "GET", url: QUOTE, headers: { "PAYMENT-SIGNATURE": "not base64 json" } }, x.now());
    expect(garbage.status).toBe(400);
    expect(x.start - x.float()).toBe(20_000);
  });

  it("the float: another agent's float cannot be named, and an empty one does not pay", async () => {
    const x = await boot({ float: "1" });
    await x.own({ type: "approveAgent", agentAddress: codex.address, agentName: "Codex", validUntil: x.now() + DAY });
    await x.approve("data.sim", "1", "5", codex);
    expect(code(await x.pay(QUOTE, "0.05", "research", {}, codex))).toBe("E_ACCOUNT_SOURCE");
    expect(code(await x.pay(QUOTE, "0.05", "nope"))).toBe("E_WALLET_ACCOUNT_UNKNOWN");
    // the float holds a dollar less the gas of filling it; a 60-cent call fits once
    x.world.data.priceMicro = 600_000;
    paid(await x.payOk(QUOTE, "1"));
    const empty = refusal(await x.pay(QUOTE, "1"));
    expect([empty.code, empty.message]).toEqual(["E_WALLET_INSUFFICIENT", `the float "research" holds $${(x.float() / 1e6).toFixed(2)}; this needs $0.60`]);
    expect(x.start - x.float()).toBe(600_000);
  });

  it("a rejected card moves nothing and frees the budget it held; an offer that changed while the card waited is not what was approved", async () => {
    const x = await boot();
    const card = carded(await x.pay(QUOTE, "0.05"));
    const no = await x.answer(card, "reject");
    expect(!isRefusal(no) && no.kind === "result" && (no.result as Refusal).code).toBe("E_CARD_REJECTED");
    expect([x.float(), x.spend().reservedMicro, x.spend().payTo]).toEqual([x.start, 0, {}]);
    // a second card; the payee raises its price before the owner answers
    const second = carded(await x.pay(QUOTE, "0.05"));
    x.world.data.priceMicro = 40_000;
    expect(code(await x.answer(second))).toBe("E_ACCOUNT_REQUOTE");
    expect([x.float(), x.spend().reservedMicro, x.spend().payTo]).toEqual([x.start, 0, {}]);
    // and an agent cannot answer its own card
    const third = carded(await x.pay(QUOTE, "0.05"));
    expect(code(await x.own({ type: "approveCard", card: third.id, action: cardHash(third), decision: "approve" }, cc))).toBe("E_ACCOUNT_OWNER_ONLY");
  });

  it("a payee that takes the money and sends no receipt: the payment is on the books, and the agent is told it was not verified", async () => {
    const x = await boot();
    paid(await x.payOk(QUOTE, "0.05"));
    x.world.data.mute = true;
    const r = refusal(await x.pay(QUOTE, "0.05"));
    expect(r.code).toBe("E_PAYEE_UNVERIFIED");
    expect(r.detail).toMatchObject({ paid: true });
    expect(x.start - x.float()).toBe(20_000);
    expect(x.engine.payments[0]).toMatchObject({ status: "settled", note: "data.sim took the payment and sent no valid receipt" });
    expect(x.spend().spentMicro).toBe(20_000);
  });

  it("a payee that says the payment failed and keeps the signed authorisation: its amount stays set aside, and if it is cashed later the books show it", async () => {
    const x = await boot();
    paid(await x.payOk(QUOTE, "0.05"));
    x.world.data.stall = true;
    const r = refusal(await x.pay(QUOTE, "0.05"));
    expect([r.code, r.message]).toEqual(["E_PAYEE_REJECTED", "data.sim did not take the payment (settlement_failed): nothing has moved; the signed authorisation stays good for 60 s more, and its $0.01 is set aside until it is used or expires"]);
    expect([x.start - x.float(), x.spend().spentMicro, x.spend().reservedMicro, x.engine.payments.filter((p) => p.kind === "pay").length]).toEqual([10_000, 10_000, 10_000, 1]);
    // half a minute later the payee cashes the cheque it said had bounced
    await x.pass(30_000);
    expect(x.world.chain.authorized(x.world.data.kept[0]!.payload.authorization, Math.floor(x.now() / 1000))).toMatch(/^0x/);
    await x.pass(1000);
    expect([x.start - x.float(), x.spend().spentMicro, x.spend().reservedMicro]).toEqual([20_000, 20_000, 0]);
    expect(x.engine.payments[0]).toMatchObject({ kind: "pay", to: "data.sim", amountUsd: 0.01, status: "settled", note: "data.sim settled this after answering that the payment had failed" });

    // and one that is never cashed expires: a minute later nothing is set aside, and the payee can no longer use it
    const second = refusal(await x.pay(QUOTE, "0.05"));
    expect(second.code).toBe("E_PAYEE_REJECTED");
    expect(x.spend().reservedMicro).toBe(10_000);
    await x.pass(61_000);
    expect([x.spend().reservedMicro, x.start - x.float()]).toEqual([0, 20_000]);
    const late = await X.x402Verify(x.world.data.kept[1]!, x.world.data.requirements(), Math.floor(x.now() / 1000), x.world.chain);
    expect(late.invalidReason).toBe("invalid_exact_evm_payload_authorization_valid_before");
    // and the token itself would not move it either: the window has closed
    expect(x.world.chain.authorized(x.world.data.kept[1]!.payload.authorization, Math.floor(x.now() / 1000))).toBeNull();
    expect(x.svc.rows().some((row) => row.tool === "authorisation expired")).toBe(true);
  });

  it("whatever a payee sends, the door answers with a refusal: an amount that is not a plain number, a year-long time limit", async () => {
    const x = await boot();
    for (const odd of ["1e3", "-5", "0.5", "0x10", " 10000", "10000 ", "99999999999999999999", ""]) {
      x.world.data.rawAmount = odd;
      expect(code(await x.pay(QUOTE, "0.05"))).toBe("E_PAYEE_UNVERIFIED");
    }
    x.world.data.rawAmount = "0";
    expect(code(await x.pay(QUOTE, "0.05"))).toBe("E_PAYEE_UNVERIFIED");
    x.world.data.rawAmount = undefined;
    expect([x.float(), x.spend().reservedMicro, x.engine.host.cards().length]).toEqual([x.start, 0, 0]);
    // the payee asks for an authorisation good for a year: it gets one good for a minute
    x.world.data.timeoutSeconds = 365 * 86_400;
    paid(await x.payOk(QUOTE, "0.05"));
    const sent = (x.svc.rows().filter((row) => row.tool === "agentPay" && row.outcome === "accepted").at(-1)!.native as { payload: X.X402Payload }).payload.payload.authorization;
    expect(Number(sent.validBefore) - Math.floor(x.now() / 1000)).toBe(60);
  });

  it("an app's fee rides along only inside the rate the owner approved for that app", async () => {
    const x = await boot();
    const builder = simKey("builder").address;
    paid(await x.payOk(QUOTE, "0.05"));
    expect(code(await x.pay(QUOTE, "0.05", "research", { builder: { b: builder, f: 50 } }))).toBe("E_ACCOUNT_FEE_CAP");
    await x.own({ type: "approveBuilderFee", builder, maxFeeRate: "0.05%" });
    const over = refusal(await x.pay(QUOTE, "0.05", "research", { builder: { b: builder, f: 100 } }));
    expect([over.code, over.message]).toEqual(["E_ACCOUNT_FEE_CAP", `${builder.slice(0, 8)}…${builder.slice(-4)} asks 0.100%; the owner approved 0.050% at most`]);
    const before = x.float();
    const ok = paid(await x.pay(QUOTE, "0.05", "research", { builder: { b: builder, f: 50 } }));
    // 0.05% of $0.01 is 5 millionths of a dollar
    expect([before - x.float(), x.world.chain.balance(builder), ok.payment.feeUsd]).toEqual([10_005, 5, 0.000005]);
  });

  it("the key, the approval and the dial are all checked at every payment", async () => {
    const x = await boot();
    paid(await x.payOk(QUOTE, "0.05"));
    // Guard's daily cap is a hard line for payments too
    x.svc.setMode("guard");
    paid(await x.pay(QUOTE, "0.05"));
    // the session ends: writes stop
    x.svc.revokeAll();
    expect(code(await x.pay(QUOTE, "0.05"))).toBe("E_WALLET_SESSION_EXPIRED");
    const y = await boot();
    paid(await y.payOk(QUOTE, "0.05"));
    await y.own({ type: "approveSpend", agent: cc.address, scope: "payees", allow: "", perPayment: "0", budget: "0", windowHours: 0, validUntil: 0 });
    expect(code(await y.pay(QUOTE, "0.05"))).toBe("E_MANDATE_NONE");
    await y.approve("data.sim", "1", "5");
    // a new approval starts with no pinned address: the owner is asked again
    expect(code(await y.pay(QUOTE, "0.05"))).toBe("card");
    await y.own({ type: "approveAgent", agentAddress: "0x0000000000000000000000000000000000000000", agentName: "Claude Code", validUntil: 0 });
    expect(code(await y.pay(QUOTE, "0.05"))).toBe("E_ACCOUNT_AGENT_REVOKED");
  });
});

describe("MPP: a charge, and a session with a deposit and vouchers", () => {
  it("a charge: the challenge is answered with an authorisation whose nonce commits to it, and the receipt names a real transfer", async () => {
    const x = await boot();
    const card = carded(await x.pay(ANSWER, "0.05"));
    expect(card.offer).toMatchObject({ payee: "infer.sim", amount: "0.02 USDC", protocol: "MPP charge · EIP-3009" });
    const r = paid(await x.answer(card));
    expect(r.data).toEqual({ answer: "42", model: "sim-1" });
    expect([x.start - x.float(), x.world.chain.balance(x.world.infer.recipient)]).toEqual([20_000, 20_000]);
    const native = x.svc.rows().filter((row) => row.tool === "agentPay" && row.outcome === "accepted").at(-1)!.native as { challenge: X.MppChallenge; credential: X.MppCredential; receipt: X.MppReceipt };
    expect((native.credential.payload as { authorization: X.Eip3009 }).authorization.nonce).toBe(X.mppChargeNonce(native.challenge));
    expect(x.world.chain.tx(native.receipt.reference)).toMatchObject({ to: x.world.infer.recipient, value: 20_000 });

    // at the payee: the same proof is good exactly once, and a challenge that was touched is not this server's
    const again = await x.world.fetch({ method: "GET", url: ANSWER, headers: { Authorization: X.mppAuthorization(native.credential) } }, x.now());
    expect([again.status, (again.body as { title: string }).title]).toEqual([402, "verification-failed"]);
    const cheaper = { ...native.challenge, request: X.jcs64({ ...X.unjcs64<X.MppChargeRequest>(native.challenge.request)!, amount: "1" }) };
    const forged = await x.world.fetch({ method: "GET", url: ANSWER, headers: { Authorization: X.mppAuthorization({ ...native.credential, challenge: cheaper }) } }, x.now());
    expect([forged.status, (forged.body as { title: string }).title]).toEqual([402, "invalid-challenge"]);
    expect(X.mppParse(forged.headers["www-authenticate"])?.intent).toBe("charge");
    expect(x.world.chain.balance(x.world.infer.recipient)).toBe(20_000);
  });

  it("a session: a deposit goes into escrow once, each call signs a higher total, and closing sends the rest home", async () => {
    const x = await boot();
    // the card says what opening the session locks, and where: the owner's signature covers both
    const card = carded(await x.pay(STREAM, "0.05"));
    expect(card.offer).toEqual({ payee: "infer.sim", payTo: x.world.infer.recipient, amount: "0.01 USDC a call", protocol: "MPP session · escrow + vouchers", network: "Base Sepolia", deposit: "up to 0.5 USDC, locked when the session opens; what is not used comes back", escrow: x.world.escrow.address });
    expect(card.reason).toContain("from a deposit of up to $0.50 locked in escrow");
    const first = paid(await x.answer(card));
    expect(first.data).toEqual({ chunk: "answer 1", model: "sim-1" });
    // $0.50 left the float for the escrow; one cent of it is owed so far
    expect([x.start - x.float(), x.world.chain.balance(x.world.escrow.address), x.spend().spentMicro, x.spend().reservedMicro]).toEqual([500_000, 500_000, 10_000, 490_000]);
    paid(await x.pay(STREAM, "0.05"));
    const third = paid(await x.pay(STREAM, "0.05"));
    expect(third.payment).toMatchObject({ status: "pending", protocol: "mpp-session", amountUsd: 0.5, receiveUsd: 0.03, heldUsd: 0.47, note: "3 calls · $0.03 of a $0.50 deposit used" });
    expect(x.engine.payments.filter((p) => p.protocol === "mpp-session")).toHaveLength(1);
    const view = await x.engine.view();
    expect(view.pay.sessions).toMatchObject([{ host: "infer.sim", subAccount: "research", depositUsd: 0.5, spentUsd: 0.03, status: "open" }]);
    // what is left of the deposit is still the user's: it is counted, as held in escrow, not as money in flight
    expect([view.heldUsd, view.inFlightUsd]).toEqual([0.47, 0]);
    // the payee has taken nothing yet: its claim is the last voucher
    expect(x.world.chain.balance(x.world.infer.recipient)).toBe(0);

    const closed = paid(await x.pay(STREAM, "0", "research", { close: true }));
    expect(closed.payment).toMatchObject({ status: "settled", amountUsd: 0.03, receiveUsd: 0.03, note: 'session closed: $0.03 paid for 3 calls, $0.47 back in float "research"' });
    expect(closed.payment.heldUsd).toBeUndefined();
    expect([x.start - x.float(), x.world.chain.balance(x.world.infer.recipient), x.world.chain.balance(x.world.escrow.address), x.spend().spentMicro, x.spend().reservedMicro]).toEqual([30_000, 30_000, 0, 30_000, 0]);
    expect(code(await x.pay(STREAM, "0", "research", { close: true }))).toBe("E_ACCOUNT_BAD_ACTION");
    expect(x.svc.verifyChain().ok).toBe(true);
  });

  it("a deposit is one authorisation: never above the per-payment maximum, the budget or the float — and when it is used up the session says so", async () => {
    const x = await boot({ perPayment: "0.02", budget: "0.03" });
    paid(await x.payOk(STREAM, "0.05"));
    // the payee suggested fifty cents; the owner's per-payment line is two
    expect(x.start - x.float()).toBe(20_000);
    paid(await x.pay(STREAM, "0.05"));
    const used = refusal(await x.pay(STREAM, "0.05"));
    expect([used.code, used.message]).toEqual(["E_WALLET_INSUFFICIENT", "the session at infer.sim has used $0.02 of its $0.02 deposit: close it, and the next call opens another"]);
    paid(await x.pay(STREAM, "0", "research", { close: true }));
    // one cent of budget is left: the next session can lock one cent, and after that nothing
    paid(await x.pay(STREAM, "0.05"));
    expect([x.spend().spentMicro, x.spend().reservedMicro]).toEqual([30_000, 0]);
    paid(await x.pay(STREAM, "0", "research", { close: true }));
    expect(code(await x.pay(STREAM, "0.05"))).toBe("E_MANDATE_BUDGET");
    expect(code(await x.pay(QUOTE, "0.05"))).toBe("E_MANDATE_BUDGET");
    expect(x.start - x.float()).toBe(30_000);
  });

  it("the payee asks for a bigger deposit while the card waits: that is not what the owner approved", async () => {
    const x = await boot();
    const card = carded(await x.pay(STREAM, "0.05"));
    x.world.infer.depositMicro = 5_000_000;
    expect(code(await x.answer(card))).toBe("E_ACCOUNT_REQUOTE");
    expect([x.float(), x.world.chain.balance(x.world.escrow.address)]).toEqual([x.start, 0]);
  });

  it("a payee that goes silent cannot keep the deposit: it is asked back from the escrow and returns after the grace period", async () => {
    const x = await boot();
    paid(await x.payOk(STREAM, "0.05"));
    paid(await x.pay(STREAM, "0.05"));
    x.world.down.add("infer.sim");
    const asked = paid(await x.pay(STREAM, "0", "research", { close: true }));
    expect(asked.payment).toMatchObject({ status: "pending", note: "infer.sim did not close the session; the deposit was asked back from the escrow and returns after 15 min" });
    await x.pass(15 * MIN);
    expect(x.start - x.float()).toBe(500_000);
    // inside the grace period the payee can still collect what the vouchers say — and only that
    expect(await x.world.infer.collect(x.engine.payments[0]!.legs[0]!.ref!)).toBe(true);
    await x.pass(2 * MIN);
    expect([x.start - x.float(), x.world.chain.balance(x.world.infer.recipient), x.spend().spentMicro, x.spend().reservedMicro]).toEqual([20_000, 20_000, 20_000, 0]);
    expect(x.engine.payments[0]).toMatchObject({ status: "settled", amountUsd: 0.02 });
    expect((await x.engine.view()).pay.sessions[0]!.status).toBe("withdrawn");

    // and if it never collects, everything comes back and nothing counts as spent
    const y = await boot();
    paid(await y.payOk(STREAM, "0.05"));
    y.world.down.add("infer.sim");
    paid(await y.pay(STREAM, "0", "research", { close: true }));
    await y.pass(17 * MIN);
    expect([y.start - y.float(), y.spend().spentMicro, y.spend().reservedMicro]).toEqual([0, 0, 0]);
  });

  it("the payee's side keeps the session's rules: no deposit for a bad opening, one call a voucher, and a close captures only what was used", async () => {
    const x = await boot();
    const float = simKey("sub-account:research");
    const escrow = x.world.escrow;
    const challenge = async () => X.mppParse((await x.world.fetch({ method: "GET", url: STREAM }, x.now())).headers["www-authenticate"])!;
    const send = async (payload: Record<string, unknown>) => {
      const r = await x.world.fetch({ method: "GET", url: STREAM, headers: { Authorization: X.mppAuthorization({ challenge: await challenge(), payload }) } }, x.now());
      return [r.status, (r.body as { title?: string }).title ?? r.body];
    };
    const terms = { payee: x.world.infer.recipient, token: X.X402_USDC.asset.toLowerCase(), deposit: 500_000, salt: `0x${"ab".repeat(32)}` as const, authorizedSigner: "0x0000000000000000000000000000000000000000" };
    const id = X.mppChannelId(float.address, terms.payee, terms.token, terms.salt, terms.authorizedSigner, escrow.address, escrow.chainId);
    const transaction = await X.mppOpenTx(float, escrow.address, escrow.chainId, terms, 1);
    const sign = (total: number, by = float) => X.mppSignVoucher(by, escrow.address, escrow.chainId, id, total);
    // an opening whose voucher is not the payer's, or is not for zero: refused, and the deposit never leaves the float
    expect(await send({ action: "open", type: "transaction", channelId: id, transaction, cumulativeAmount: "0", signature: await sign(0, simKey("attacker")) })).toEqual([402, "session/signer-mismatch"]);
    expect(await send({ action: "open", type: "transaction", channelId: id, transaction, cumulativeAmount: "10000", signature: await sign(10_000) })).toEqual([402, "invalid-payload"]);
    expect([x.float(), escrow.channels.size]).toEqual([x.start, 0]);
    expect(await send({ action: "open", type: "transaction", channelId: id, transaction, cumulativeAmount: "0", signature: await sign(0) })).toEqual([200, { opened: true, deposit: "500000" }]);
    expect(x.start - x.float()).toBe(500_000);
    // a voucher pays for one call: not less, not more
    expect(await send({ action: "voucher", channelId: id, cumulativeAmount: "5000", signature: await sign(5000) })).toEqual([402, "session/delta-too-small"]);
    expect(await send({ action: "voucher", channelId: id, cumulativeAmount: "400000", signature: await sign(400_000) })).toEqual([402, "invalid-payload"]);
    for (const total of [10_000, 20_000, 30_000]) expect((await send({ action: "voucher", channelId: id, cumulativeAmount: String(total), signature: await sign(total) }))[0]).toBe(200);
    // a close that names 400,000 where 30,000 was used: 30,000 is captured, the rest goes home
    const closed = await x.world.fetch({ method: "GET", url: STREAM, headers: { Authorization: X.mppAuthorization({ challenge: await challenge(), payload: { action: "close", channelId: id, cumulativeAmount: "400000", signature: await sign(400_000) } }) } }, x.now());
    expect([closed.status, closed.body]).toEqual([200, { closed: true, paid: "30000", refunded: "470000" }]);
    expect([x.start - x.float(), x.world.chain.balance(x.world.infer.recipient)]).toEqual([30_000, 30_000]);
  });

  it("a charge whose authorisation is not valid yet is not a payment", async () => {
    const x = await boot();
    const float = simKey("sub-account:research");
    const ch = X.mppParse((await x.world.fetch({ method: "GET", url: ANSWER }, x.now())).headers["www-authenticate"])!;
    const req = X.unjcs64<X.MppChargeRequest>(ch.request)!;
    const nowSec = Math.floor(x.now() / 1000);
    const authorization: X.Eip3009 = { from: float.address, to: req.recipient, value: req.amount, validAfter: String(nowSec + 3600), validBefore: String(nowSec + 7200), nonce: X.mppChargeNonce(ch) };
    const signature = await X.eip3009Sign(float, { network: X.X402_USDC.network, asset: X.X402_USDC.asset, extra: { name: X.X402_USDC.name, version: X.X402_USDC.version } }, authorization);
    const r = await x.world.fetch({ method: "GET", url: ANSWER, headers: { Authorization: X.mppAuthorization({ challenge: ch, payload: { type: "authorization", authorization, signature } }) } }, x.now());
    expect([r.status, (r.body as { title: string }).title, x.float()]).toEqual([402, "payment-insufficient", x.start]);
  });

  it("no deposit goes into an escrow contract the payee picked; a voucher cannot be replayed or lowered", async () => {
    const x = await boot();
    x.world.infer.escrowContract = simKey("contract:the-payees-own").address;
    const r = refusal(await x.pay(STREAM, "0.05"));
    expect(r.code).toBe("E_PAYEE_UNVERIFIED");
    expect(r.message).toContain("names an escrow contract this account does not know");
    expect(x.float()).toBe(x.start);
    x.world.infer.escrowContract = undefined;
    paid(await x.payOk(STREAM, "0.05"));
    paid(await x.pay(STREAM, "0.05"));
    // the first voucher (one cent), presented again to a fresh challenge: the total did not go up
    const row = x.svc.rows().filter((l) => l.tool === "mpp voucher").at(0)!.native as { voucher: { channelId: string; cumulativeAmount: string; signature: string } };
    const fresh = X.mppParse((await x.world.fetch({ method: "GET", url: STREAM }, x.now())).headers["www-authenticate"])!;
    const replay = await x.world.fetch({ method: "GET", url: STREAM, headers: { Authorization: X.mppAuthorization({ challenge: fresh, payload: { action: "voucher", ...row.voucher } }) } }, x.now());
    expect([replay.status, (replay.body as { title: string }).title]).toEqual([402, "session/delta-too-small"]);
    // a voucher for more than the deposit is not a voucher the escrow honours
    const float = simKey("sub-account:research");
    const big = await X.mppSignVoucher(float, x.world.escrow.address, x.world.escrow.chainId, row.voucher.channelId as `0x${string}`, 900_000);
    expect(await x.world.escrow.voucher(row.voucher.channelId, 900_000, big)).toBe("amount-exceeds-deposit");
    // and only the payer's key signs one
    const forged = await X.mppSignVoucher(simKey("attacker"), x.world.escrow.address, x.world.escrow.chainId, row.voucher.channelId as `0x${string}`, 400_000);
    expect(await x.world.escrow.voucher(row.voucher.channelId, 400_000, forged)).toBe("signer-mismatch");
  });
});

describe("AP2: the agent's own signature on what it commits the user to", () => {
  it("a shop is paid from a float: a payment that names none sends nothing, for there is no card on the account", async () => {
    const x = await boot();
    const r = refusal(await x.pay(ITEM, "30", ""));
    expect([r.code, r.message]).toEqual(["E_PAYEE_UNSUPPORTED", "shop.sim is paid in USDC: name the float that pays"]);
    expect(x.world.sent.map((q) => `${q.method} ${q.host}${q.path}`)).toEqual(["GET shop.sim/items/desk-feed-pro"]);
    expect(x.svc.adapter("mastercard")).toBeUndefined();
  });

  it("open mandates from the owner's approval, closed mandates from the agent's key, receipts from the merchant and its processor", async () => {
    const x = await boot();
    // without its key in the request there is nothing a closed mandate could be checked against
    expect(code(await x.pay(ITEM, "30"))).toBe("E_ACCOUNT_BAD_ACTION");
    const card = carded(await x.pay(ITEM, "30", "research", { cnf: cc.jwk }));
    expect(card.offer).toEqual({ payee: "shop.sim", payTo: x.world.shop.payTo, amount: "29 USDC", protocol: "AP2 mandates · EIP-3009", network: "Base Sepolia" });
    const approved = await x.answer(card);
    if (isRefusal(approved) || approved.kind !== "result") throw new Error("expected the mandates to be asked for");
    const needs = approved.result as X.Ap2Needs;
    expect(needs).toMatchObject({ needs: "mandates", protocol: "ap2", checkout: { id: "co_000001", total: { amount: 2900, currency: "USD" }, merchant: { id: "merchant_shop_sim" } }, sign: { checkout: { aud: "merchant" }, payment: { aud: "credential-provider" } } });
    expect(needs.checkout.hash).toBe(X.ap2CheckoutHash(needs.checkout.jwt));
    expect(x.float()).toBe(x.start);
    // asking again before signing gets the same checkout, not a second one and not a second card
    const again = await x.pay(ITEM, "30", "research", { cnf: cc.jwk });
    expect(!isRefusal(again) && again.kind === "result" && (again.result as X.Ap2Needs).checkout.id).toBe("co_000001");

    const mandates = X.ap2Answer(cc.p256, needs, Math.floor(x.now() / 1000));
    const r = paid(await x.pay(ITEM, "30", "research", { mandates }));
    expect(r.data).toEqual({ order: { id: "order_000001", permalink_url: "https://shop.sim/orders/000001" }, item: { id: "desk-feed-pro", title: "Desk Feed Pro · 30 days", price: { amount: 2900, currency: "usd" } } });
    expect(r.payment).toMatchObject({ from: "sub:research", to: "shop.sim", amountUsd: 29, protocol: "ap2", status: "settled" });
    expect([x.start - x.float(), x.world.chain.balance(x.world.shop.payTo), x.spend().spentMicro]).toEqual([29_000_000, 29_000_000, 29_000_000]);
    const native = x.svc.rows().filter((row) => row.tool === "agentPay" && row.outcome === "accepted").at(-1)!.native as { receipts: { checkout: Record<string, unknown>; payment: Record<string, unknown> } };
    expect(native.receipts.checkout).toMatchObject({ status: "Success", order_id: "order_000001", reference: X.ap2MandateHash(mandates.checkout) });
    expect(native.receipts.payment).toMatchObject({ status: "Success", reference: X.ap2MandateHash(mandates.payment) });
    // the mandates were for that checkout: they buy nothing a second time
    expect(code(await x.pay(ITEM, "30", "research", { mandates }))).toBe("E_ACCOUNT_BAD_ACTION");
  });

  it("mandates signed by another key, or for another amount, do not release a payment", async () => {
    const x = await boot();
    const approved = await x.payOk(ITEM, "30", "research", { cnf: cc.jwk });
    const needs = (approved as { result: X.Ap2Needs }).result;
    const iat = Math.floor(x.now() / 1000);
    // another agent's key signs: the open mandate names cc's
    const stolen = refusal(await x.pay(ITEM, "30", "research", { mandates: X.ap2Answer(codex.p256, needs, iat) }));
    expect([stolen.code, stolen.message]).toEqual(["E_ACCOUNT_BAD_SIGNATURE", "the payment mandate does not hold: the closed mandate is not signed by the agent key the open mandate names"]);
    // the right key, a payment mandate for one cent
    const good = X.ap2Answer(cc.p256, needs, iat);
    const cheap = X.ap2Close("payment", { transaction_id: needs.checkout.hash, payee: needs.checkout.merchant, payment_amount: { amount: 1, currency: "USD" }, payment_instrument: needs.instrument }, { ...needs.sign.payment, iat }, needs.open.payment, cc.p256);
    expect(code(await x.pay(ITEM, "30", "research", { mandates: { checkout: good.checkout, payment: cheap } }))).toBe("E_MANDATE_INVALID");
    // the right payment mandate, a checkout mandate for a checkout the merchant never signed: the merchant refuses, nothing moves
    const other = X.ap2Close("checkout", { checkout_hash: X.ap2CheckoutHash("another.checkout.jwt") }, { ...needs.sign.checkout, iat }, needs.open.checkout, cc.p256);
    const refused = refusal(await x.pay(ITEM, "30", "research", { mandates: { checkout: other, payment: good.payment } }));
    expect([refused.code, refused.message]).toEqual(["E_PAYEE_REJECTED", "shop.sim did not take the checkout (invalid_mandate: the mandate names a different checkout): nothing has moved; the signed authorisation stays good for 60 s more, and its $29.00 is set aside until it is used or expires"]);
    expect([x.float(), x.world.chain.balance(x.world.shop.payTo), x.spend().reservedMicro]).toEqual([x.start, 0, 29_000_000]);
    // the merchant was handed a payment credential with that request: until it expires, the same $29 cannot be promised a second time
    expect(code(await x.pay(ITEM, "30", "research", { mandates: good }))).toBe("E_MANDATE_BUDGET");
    await x.pass(61_000);
    expect(x.spend().reservedMicro).toBe(0);
    // the honest pair still works
    paid(await x.pay(ITEM, "30", "research", { mandates: good }));
    expect([x.start - x.float(), x.world.chain.balance(x.world.shop.payTo)]).toEqual([29_000_000, 29_000_000]);
  });

  it("the merchant's processor signs no receipt for a payment nobody mandated", async () => {
    const x = await boot();
    const issuer = simKey("account:mandate-issuer");
    const nowSec = Math.floor(x.now() / 1000);
    const made = await x.world.fetch({ method: "POST", url: "https://shop.sim/ap2/checkouts", body: { items: [{ id: "desk-feed-pro", quantity: 1 }] } }, x.now());
    const { id, checkout_jwt: jwt, nonce } = made.body as { id: string; checkout_jwt: string; nonce: string };
    const merchant = { id: "merchant_shop_sim", name: "Shop Sim", website: "https://shop.sim" };
    const open = X.ap2Open("checkout", [{ type: "checkout.allowed_merchants", allowed: [merchant] }], cc.jwk, nowSec, nowSec + 900, { key: issuer.p256, kid: issuer.kid });
    const closed = X.ap2Close("checkout", { checkout_hash: X.ap2CheckoutHash(jwt) }, { aud: "merchant", nonce, iat: nowSec }, open, cc.p256, { checkout_jwt: jwt });
    const float = simKey("sub-account:research");
    const requirements: X.X402Requirements = { scheme: "exact", network: X.X402_USDC.network, amount: "29000000", asset: X.X402_USDC.asset, payTo: x.world.shop.payTo, maxTimeoutSeconds: 300, extra: { assetTransferMethod: "eip3009", name: X.X402_USDC.name, version: X.X402_USDC.version } };
    const credential = await X.x402Authorize(float, requirements, nowSec, `0x${"cd".repeat(32)}`);
    // a good checkout mandate and a good payment credential, and no payment mandate at all
    const r = await x.world.fetch({ method: "POST", url: `https://shop.sim/ap2/checkouts/${id}/complete`, body: { checkout_mandate: X.ap2Chain(open, closed), payment_credential: credential } }, x.now());
    const receipt = X.jwsParse((r.body as { checkout_receipt: string }).checkout_receipt)!.payload;
    expect([r.status, receipt.status, receipt.error, (r.body as { payment_receipt?: string }).payment_receipt]).toEqual([400, "Error", "invalid_credential", undefined]);
    expect([x.float(), x.world.chain.balance(x.world.shop.payTo)]).toEqual([x.start, 0]);
  });

  it("the total is the one the merchant signed: a checkout that differs from the page is not paid", async () => {
    const x = await boot();
    x.world.shop.checkoutCents = 2950;
    const card = carded(await x.pay(ITEM, "30", "research", { cnf: cc.jwk }));
    const r = refusal(await x.answer(card));
    expect([r.code, r.message]).toEqual(["E_PAYEE_OVERCHARGE", "shop.sim's signed checkout totals $29.50; its page said $29.00"]);
    expect(x.float()).toBe(x.start);
  });
});

describe("what the independent review found, kept closed", () => {
  type Handler = (c: { url: URL; header(name: string): string | undefined; body: unknown; method: string; nowMs: number }) => Promise<{ status: number; headers: Record<string, string>; body?: unknown }> | { status: number; headers: Record<string, string>; body?: unknown };
  const hostsOf = (w: unknown) => (w as { hosts: Map<string, Handler> }).hosts;

  it("a payee that takes the money and answers with something unreadable: the payment is booked before anything is said, and the budget still holds", async () => {
    const x = await boot({ perPayment: "10", budget: "25" });
    x.world.data.priceMicro = 9_000_000;
    paid(await x.payOk(QUOTE, "9"));
    // the payee settles, then sends a receipt whose `payer` is a number — the kind of answer that used to throw past the booking
    const honest = x.world.data.handle as unknown as Handler;
    hostsOf(x.world).set("data.sim", async (c) => {
      const r = await honest(c);
      return r.headers["payment-response"] ? { ...r, headers: { ...r.headers, "payment-response": X.b64json({ success: true, payer: 5, transaction: 7, network: null }) } } : r;
    });
    const second = refusal(await x.pay(QUOTE, "9"));
    expect([second.code, (second.detail as { paid?: boolean }).paid]).toEqual(["E_PAYEE_UNVERIFIED", true]);
    expect([x.start - x.float(), x.spend().spentMicro, x.engine.payments.filter((p) => p.kind === "pay").length]).toEqual([18_000_000, 18_000_000, 2]);
    // $7 is left of $25: a third $9 does not go out
    expect(code(await x.pay(QUOTE, "9"))).toBe("E_MANDATE_BUDGET");
    expect(x.start - x.float()).toBe(18_000_000);
  });

  it("an opening transaction a payee kept is cancelled: broadcast later, it reverts", async () => {
    const x = await boot();
    const honest = x.world.infer.handle as unknown as Handler;
    const kept: string[] = [];
    hostsOf(x.world).set("infer.sim", async (c) => {
      const payload = X.mppReadAuthorization(c.header("authorization"))?.payload as { action?: string; transaction?: string } | undefined;
      if (payload?.action !== "open" || !payload.transaction) return honest(c);
      kept.push(payload.transaction);
      return honest({ ...c, header: () => undefined });
    });
    const card = carded(await x.pay(STREAM, "0.05"));
    expect(code(await x.answer(card))).toBe("E_PAYEE_REJECTED");
    expect(kept).toHaveLength(1);
    expect(await x.world.escrow.broadcast(kept[0] as `0x${string}`)).toBe("transaction-reverted");
    expect([x.float(), x.world.chain.balance(x.world.escrow.address), x.spend().reservedMicro]).toEqual([x.start, 0, 0]);
    expect(x.svc.rows().some((row) => row.tool === "escrow.open cancelled")).toBe(true);
  });

  it("a session lives under the approval it was opened under; the owner can always close it; a channel the payee closed is noticed", async () => {
    const x = await boot();
    paid(await x.payOk(STREAM, "0.05"));
    paid(await x.pay(STREAM, "0.05"));
    // the owner cuts the approval while the session is open: its vouchers stop
    await x.approve("infer.sim", "0.02", "0.02");
    const cut = refusal(await x.pay(STREAM, "0.05"));
    expect(cut.code).toBe("E_MANDATE_EXPIRED");
    expect(cut.message).toContain("opened under a spending approval the owner has since replaced");
    // the agent's key is revoked: the deposit is still the owner's, and the owner closes the session
    await x.own({ type: "approveAgent", agentAddress: "0x0000000000000000000000000000000000000000", agentName: "Claude Code", validUntil: 0 });
    const closed = await x.own({ type: "setPolicy", change: "close-session", value: "infer.sim" });
    expect(!isRefusal(closed) && closed.kind === "account" && closed.summary).toBe('session closed: $0.02 paid for 2 calls, $0.48 back in float "research"');
    expect([x.start - x.float(), x.world.chain.balance(x.world.escrow.address)]).toEqual([20_000, 0]);
    expect(code(await x.own({ type: "setPolicy", change: "close-session", value: "infer.sim" }))).toBe("E_ACCOUNT_BAD_ACTION");

    // a payee that closes the channel on its own: the next look at the account sees it
    const y = await boot();
    paid(await y.payOk(STREAM, "0.05"));
    const channel = y.engine.payments[0]!.legs[0]!.ref!;
    const voucher = y.world.infer.accepted.get(channel)!;
    expect(typeof (await y.world.escrow.settle(y.world.infer.recipient, channel, voucher.cumulative, voucher.signature, true))).toBe("object");
    const view = await y.engine.view();
    expect([view.pay.sessions[0]!.status, view.heldUsd, y.spend().reservedMicro, y.start - y.float()]).toEqual(["closed", 0, 0, 10_000]);
    paid(await y.pay(STREAM, "0.05"));
    expect((await y.engine.view()).pay.sessions.map((s) => s.status)).toEqual(["closed", "open"]);
  });

  it("a payee that never answers is waited for, not for ever: the instructions behind it are taken", async () => {
    const x = await boot();
    paid(await x.payOk(QUOTE, "0.05"));
    x.world.timeoutMs = 60;
    x.world.hung.add("data.sim");
    const stuck = x.pay(QUOTE, "0.05");
    const revoke = x.own({ type: "approveAgent", agentAddress: "0x0000000000000000000000000000000000000000", agentName: "Claude Code", validUntil: 0 });
    expect([code(await stuck), code(await revoke)]).toEqual(["E_PAYEE_REJECTED", "account"]);
  });
});

describe("the account after paying", () => {
  it("the page's view names every payee, and a reset forgets them", async () => {
    const x = await boot();
    paid(await x.payOk(QUOTE, "0.05"));
    paid(await x.pay(QUOTE, "0.05"));
    paid(await x.payOk(ANSWER, "0.05"));
    const v = await x.engine.view();
    expect(v.pay.payees).toMatchObject([{ host: "data.sim", protocol: "x402", payTo: x.world.data.payTo, paidUsd: 0.02, payments: 2 }, { host: "infer.sim", protocol: "mpp-charge", paidUsd: 0.02, payments: 1 }]);
    expect(v.payments.filter((p) => p.kind === "pay").map((p) => [p.to, p.amountUsd, p.protocol])).toEqual([["infer.sim", 0.02, "mpp-charge"], ["data.sim", 0.01, "x402"], ["data.sim", 0.01, "x402"]]);
    x.svc.reset();
    expect((await x.engine.view()).pay).toEqual({ payees: [], sessions: [] });
    expect(x.world.chain.balance(x.world.data.payTo)).toBe(0);
  });
});
