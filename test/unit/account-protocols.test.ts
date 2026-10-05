import { createHash } from "node:crypto";
import { keccak256, stringToHex, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import * as X from "../../src/portfolio/account/protocols.ts";
import { simKey, ZERO } from "../../src/portfolio/account/sign.ts";

const NOW = 1_790_000_000;
const float = simKey("sub-account:test");
const payee = simKey("payee:test").address;
const nonce = (n: number): Hex => keccak256(stringToHex(`nonce-${n}`));
const req = (over: Partial<X.X402Requirements> = {}): X.X402Requirements => ({ scheme: "exact", network: X.X402_USDC.network, amount: "10000", asset: X.X402_USDC.asset, payTo: payee, maxTimeoutSeconds: 60, extra: { name: X.X402_USDC.name, version: X.X402_USDC.version }, ...over });
const rich: X.TokenView = { balance: () => 1_000_000, used: () => false };

describe("x402 V2 · exact on EVM", () => {
  it("the headers carry standard base64 JSON, and a payload verifies against the offer it was signed for", async () => {
    const p = await X.x402Authorize(float, req(), NOW, nonce(1));
    const header = X.b64json(p);
    expect(header).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(X.unb64json<X.X402Payload>(header)).toEqual(p);
    expect(await X.x402Verify(p, req(), NOW, rich)).toEqual({ isValid: true, payer: float.address });
    expect(p.payload.authorization).toMatchObject({ from: float.address, to: payee, value: "10000", validAfter: "0", validBefore: String(NOW + 60) });
  });

  it("the facilitator's checks, in the reference implementation's order, each with its reason", async () => {
    const p = await X.x402Authorize(float, req(), NOW, nonce(2));
    const why = async (payload: X.X402Payload, r: X.X402Requirements, at = NOW, token = rich) => (await X.x402Verify(payload, r, at, token)).invalidReason;
    // another chain: the offer is not the one that was signed
    expect(await why(p, req({ network: "eip155:8453" }))).toBe("invalid_network");
    // the token's name is part of the domain: "USD Coin" (Base) is not "USDC" (Base Sepolia)
    expect(await why(p, req({ extra: { name: "USD Coin", version: "2" } }))).toBe("invalid_exact_evm_payload_signature");
    // any field of the authorisation changed after signing
    expect(await why({ ...p, payload: { ...p.payload, authorization: { ...p.payload.authorization, value: "20000" } } }, req())).toBe("invalid_exact_evm_payload_signature");
    // signed for one recipient, presented to another
    expect(await why(p, req({ payTo: simKey("payee:other").address }))).toBe("invalid_exact_evm_payload_recipient_mismatch");
    // signed for one price, presented for another
    expect(await why(p, req({ amount: "20000" }))).toBe("invalid_exact_evm_payload_authorization_value_mismatch");
    // six seconds of headroom before it expires
    expect(await why(p, req(), NOW + 55)).toBe("invalid_exact_evm_payload_authorization_valid_before");
    expect(await why(p, req(), NOW + 54)).toBeUndefined();
    expect(await why(p, req(), NOW, { balance: () => 9_999, used: () => false })).toBe("insufficient_funds");
    expect(await why(p, req(), NOW, { balance: () => 1_000_000, used: () => true })).toBe("invalid_transaction_state");
    expect(await why({ ...p, accepted: { ...p.accepted, scheme: "upto" } }, req())).toBe("invalid_scheme");
  });
});

describe("MPP · the Payment authentication scheme", () => {
  it("the challenge id is the published HMAC over its own parameters", () => {
    // paymentauth.org draft-httpauth-payment-01, the test vector
    expect(X.jcs64({ amount: "1000000" })).toBe("eyJhbW91bnQiOiIxMDAwMDAwIn0");
    expect(X.mppChallengeId("test-vector-secret", { realm: "api.example.com", method: "tempo", intent: "charge", request: "eyJhbW91bnQiOiIxMDAwMDAwIn0" })).toBe("X6v1eo7fJ76gAxqY0xN9Jd__4lUyDDYmriryOM-5FO4");
  });

  it("changing any bound parameter changes the id; the header round-trips", () => {
    const base = { realm: "infer.sim", method: "evm", intent: "charge", request: X.jcs64({ amount: "20000" }), expires: "2026-10-05T14:05:00.000Z" };
    const id = X.mppChallengeId("s", base);
    for (const k of ["realm", "method", "intent", "request", "expires"] as const) expect(X.mppChallengeId("s", { ...base, [k]: `${base[k]}x` })).not.toBe(id);
    expect(X.mppChallengeId("other", base)).not.toBe(id);
    const header = X.mppHeader({ id, ...base });
    expect(header).toMatch(/^Payment id="[^"]+", realm="infer.sim", method="evm", intent="charge", expires="[^"]+", request="[^"]+"$/);
    expect(X.mppParse(header)).toEqual({ id, ...base });
    expect(X.mppParse('Bearer realm="x"')).toBeNull();
    expect(X.mppParse('Payment realm="x"')).toBeNull();
  });

  it("a credential is base64url JSON after the scheme name; a charge's nonce commits to the challenge", () => {
    const challenge = { id: "abc", realm: "infer.sim", method: "evm", intent: "charge", request: "e30" };
    const header = X.mppAuthorization({ challenge, source: "did:pkh:eip155:84532:0x0", payload: { type: "authorization" } });
    expect(header).toMatch(/^Payment [A-Za-z0-9_-]+$/);
    expect(X.mppReadAuthorization(header)?.challenge).toEqual(challenge);
    expect(X.mppReadAuthorization("Payment")).toBeNull();
    expect(X.mppChargeNonce(challenge)).toBe(keccak256(stringToHex("abcinfer.sim")));
    expect(X.mppChargeNonce({ id: "abd", realm: "infer.sim" })).not.toBe(X.mppChargeNonce(challenge));
  });

  it("a voucher is EIP-712 against the escrow: another escrow, another channel or another total is another signer", async () => {
    const escrow = simKey("contract:test-escrow").address;
    const id = X.mppChannelId(float.address, payee, X.X402_USDC.asset, nonce(3), ZERO, escrow, 84532);
    expect(X.mppChannelId(float.address, payee, X.X402_USDC.asset, nonce(4), ZERO, escrow, 84532)).not.toBe(id);
    const sig = await X.mppSignVoucher(float, escrow, 84532, id, 30_000);
    expect(await X.mppVoucherSigner(escrow, 84532, id, 30_000, sig)).toBe(float.address);
    expect(await X.mppVoucherSigner(escrow, 84532, id, 40_000, sig)).not.toBe(float.address);
    expect(await X.mppVoucherSigner(simKey("contract:other").address, 84532, id, 30_000, sig)).not.toBe(float.address);
    expect(await X.mppVoucherSigner(escrow, 8453, id, 30_000, sig)).not.toBe(float.address);
    expect(await X.mppVoucherSigner(escrow, 84532, id, 30_000, "0x1234")).toBeNull();
  });

  it("a voucher's signature has one form: 65 bytes, v of 27 or 28, a low s", async () => {
    const escrow = simKey("contract:test-escrow").address;
    const id = X.mppChannelId(float.address, payee, X.X402_USDC.asset, nonce(6), ZERO, escrow, 84532);
    const sig = await X.mppSignVoucher(float, escrow, 84532, id, 30_000);
    const v = Number.parseInt(sig.slice(130), 16);
    expect([27, 28]).toContain(v);
    // the same signature with its recovery id written as 0 or 1
    expect(await X.mppVoucherSigner(escrow, 84532, id, 30_000, `${sig.slice(0, 130)}${(v - 27).toString(16).padStart(2, "0")}` as Hex)).toBeNull();
    // and its malleable twin (s → n − s, v flipped), which plain ECDSA would recover to the same key
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const twin = `${sig.slice(0, 66)}${(n - BigInt(`0x${sig.slice(66, 130)}`)).toString(16).padStart(64, "0")}${(v === 27 ? 28 : 27).toString(16)}` as Hex;
    expect(await X.mppVoucherSigner(escrow, 84532, id, 30_000, twin)).toBeNull();
    expect(await X.mppVoucherSigner(escrow, 84532, id, 30_000, sig)).toBe(float.address);
  });

  it("a challenge's parameters may be quoted strings or bare tokens", () => {
    expect(X.mppParse("Payment id=abc, realm=infer.sim, method=evm, intent=charge, request=e30")).toEqual({ id: "abc", realm: "infer.sim", method: "evm", intent: "charge", request: "e30" });
    expect(X.mppParse('Payment id="abc", realm=infer.sim, method="evm", intent=session, request="e30", opaque=eyJuIjoiMSJ9')?.opaque).toBe("eyJuIjoiMSJ9");
  });

  it("opening a channel is a signed transaction a server can read before it broadcasts it", async () => {
    const escrow = simKey("contract:test-escrow").address;
    const open = { payee, token: X.X402_USDC.asset.toLowerCase(), deposit: 500_000, salt: nonce(5), authorizedSigner: ZERO };
    const tx = await X.mppOpenTx(float, escrow, 84532, open, 7);
    expect(tx.startsWith("0x02")).toBe(true);
    expect(await X.mppReadOpenTx(tx)).toEqual({ from: float.address, to: escrow, chainId: 84532, nonce: 7, open });
    expect(await X.mppReadOpenTx("0x02deadbeef")).toBeNull();
  });
});

describe("AP2 v0.2 · mandates", () => {
  const issuer = simKey("account:mandate-issuer");
  const agent = simKey("agent:claude-code");
  const merchant = { id: "merchant_1", name: "Demo Merchant", website: "https://demo-merchant.example" };
  const checkoutJwt = X.jwsSign({ alg: "ES256", typ: "JWT", kid: "merchant-key-1" }, { id: "co_1", totals: [{ type: "total", amount: 2900 }] }, simKey("payee:merchant").p256);
  const openCheckout = X.ap2Open("checkout", [{ type: "checkout.allowed_merchants", allowed: [merchant] }, { type: "checkout.line_items", items: [{ id: "line_1", acceptable_items: [{ id: "feed" }], quantity: 1 }] }], agent.jwk, NOW, NOW + 900, { key: issuer.p256, kid: issuer.kid });
  const constraints: X.Ap2Constraint[] = [{ type: "payment.amount_range", currency: "USD", min: 0, max: 5000 }, { type: "payment.budget", currency: "USD", max: 10_000 }, { type: "payment.allowed_payees", allowed: [merchant] }, { type: "payment.reference", conditional_transaction_id: X.ap2MandateHash(openCheckout) }];
  const openPayment = (c = constraints, exp = NOW + 900) => X.ap2Open("payment", c, agent.jwk, NOW, exp, { key: issuer.p256, kid: issuer.kid });
  const closed = (open: string, over: Record<string, unknown> = {}, bind: Partial<{ aud: string; nonce: string }> = {}, key = agent.p256) => X.ap2Close("payment", { transaction_id: X.ap2CheckoutHash(checkoutJwt), payee: merchant, payment_amount: { amount: 2900, currency: "USD" }, payment_instrument: { id: "float", type: "stablecoin" }, ...over }, { aud: "credential-provider", nonce: "n-1", iat: NOW + 5, ...bind }, open, key);
  const verify = (chain: string, over: Partial<Parameters<typeof X.ap2Verify>[2]> = {}) => X.ap2Verify(chain, "payment", { issuers: [issuer.jwk], aud: "credential-provider", nonce: "n-1", nowSec: NOW + 10, reference: X.ap2MandateHash(openCheckout), ...over });
  const bad = (v: X.Ap2Verdict) => (v.ok ? "ok" : v.error);

  it("an open mandate and the closed one the agent signs, presented as one chain", () => {
    const open = openPayment();
    const chain = X.ap2Chain(open, closed(open));
    // <open SD-JWT>~~<closed KB-SD-JWT>~<disclosure>~ : exactly one empty component between the links
    expect(chain.split("~~")).toHaveLength(2);
    expect(chain.endsWith("~")).toBe(true);
    const v = verify(chain);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.open.vct).toBe("mandate.payment.open.1");
    expect(v.closed).toMatchObject({ vct: "mandate.payment.1", transaction_id: X.ap2CheckoutHash(checkoutJwt), payment_amount: { amount: 2900, currency: "USD" } });
    expect((v.open.cnf as { jwk: unknown }).jwk).toEqual(agent.jwk);
    const kb = X.jwsParse(chain.split("~~")[1]!.split("~")[0]!)!;
    expect(kb.header).toEqual({ alg: "ES256", typ: "kb+sd-jwt" });
    expect(kb.payload.sd_hash).toBe(X.ap2MandateHash(open));
  });

  it("who signed: an issuer the verifier trusts, and the agent key the open mandate names", () => {
    const open = openPayment();
    expect(bad(verify(X.ap2Chain(open, closed(open)), { issuers: [simKey("someone-else").jwk] }))).toBe("invalid_credential");
    // another key signs the closed mandate: not the one in cnf
    expect(bad(verify(X.ap2Chain(open, closed(open, {}, {}, simKey("agent:codex").p256))))).toBe("invalid_credential");
    // an open mandate the agent made for itself
    const self = X.ap2Open("payment", [], agent.jwk, NOW, NOW + 900, { key: agent.p256, kid: agent.kid });
    expect(bad(verify(X.ap2Chain(self, closed(self))))).toBe("invalid_credential");
  });

  it("what it is bound to: this open mandate, this verifier, this exchange", () => {
    const open = openPayment();
    const wider = openPayment([{ type: "payment.amount_range", currency: "USD", min: 0, max: 900_000 }]);
    // a closed mandate made under one open mandate, moved under a more generous one
    expect(bad(verify(X.ap2Chain(wider, closed(open, { payment_amount: { amount: 500_000, currency: "USD" } }))))).toBe("invalid_credential");
    expect(bad(verify(X.ap2Chain(open, closed(open, {}, { aud: "merchant" }))))).toBe("invalid_credential");
    expect(bad(verify(X.ap2Chain(open, closed(open, {}, { nonce: "n-0" }))))).toBe("invalid_credential");
    // a disclosure swapped for one the JWT does not commit to
    const [jwt, , tail] = closed(open).split("~");
    const forged = Buffer.from(JSON.stringify(["salt", { vct: "mandate.payment.1", payment_amount: { amount: 1, currency: "USD" }, payee: merchant }])).toString("base64url");
    expect(bad(verify(`${open}~${jwt}~${forged}~${tail ?? ""}`))).toBe("invalid_credential");
    expect(bad(verify(open))).toBe("invalid_credential");
  });

  it("the constraints: range, budget, payee, the checkout it goes with, expiry — and an unknown one fails", () => {
    const open = openPayment();
    expect(bad(verify(X.ap2Chain(open, closed(open, { payment_amount: { amount: 5001, currency: "USD" } }))))).toBe("invalid_mandate");
    expect(bad(verify(X.ap2Chain(open, closed(open, { payment_amount: { amount: 2900, currency: "EUR" } }))))).toBe("invalid_mandate");
    expect(bad(verify(X.ap2Chain(open, closed(open)), { spentMinor: 7200 }))).toBe("invalid_mandate");
    expect(bad(verify(X.ap2Chain(open, closed(open)), { spentMinor: 7100 }))).toBe("ok");
    expect(bad(verify(X.ap2Chain(open, closed(open, { payee: { id: "merchant_2" } }))))).toBe("invalid_mandate");
    expect(bad(verify(X.ap2Chain(open, closed(open)), { reference: "another-checkout-mandate" }))).toBe("invalid_mandate");
    expect(bad(verify(X.ap2Chain(open, closed(open)), { nowSec: NOW + 901 }))).toBe("invalid_mandate");
    const unknown = openPayment([...constraints, { type: "payment.loyalty_tier", tier: "gold" }]);
    const v = verify(X.ap2Chain(unknown, closed(unknown)));
    expect([bad(v), v.ok ? "" : v.description]).toEqual(["unresolved_constraint", 'this verifier does not know the constraint "payment.loyalty_tier", so it cannot say the mandate holds']);
  });

  it("reads the specification's own shape: several disclosures, an allowed payee as its own disclosure, the checkout JWT attached to the closed mandate", () => {
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const digest = (d: string) => createHash("sha256").update(d).digest("base64url");
    const dPayee = b64(["salt-payee", merchant]);
    const dMain = b64(["salt-main", { vct: "mandate.payment.open.1", constraints: [{ type: "payment.amount_range", currency: "USD", max: 20_000, min: 0 }, { type: "payment.allowed_payees", allowed: [{ "...": digest(dPayee) }] }], cnf: { jwk: agent.jwk }, iat: NOW, exp: NOW + 900 }]);
    const open = `${X.jwsSign({ alg: "ES256", typ: "example+sd-jwt", kid: "agent-provider-key-1" }, { delegate_payload: [{ "...": digest(dMain) }], _sd_alg: "sha-256" }, issuer.p256)}~${dMain}~${dPayee}~`;
    const v = verify(X.ap2Chain(open, closed(open)), { reference: undefined });
    expect(v.ok && (v.open.constraints as Array<{ allowed?: unknown[] }>)[1]!.allowed).toEqual([merchant]);
    // the payee's disclosure withheld: the mandate then allows nobody
    expect(bad(verify(X.ap2Chain(`${open.split("~").slice(0, 2).join("~")}~`, X.ap2Close("payment", { transaction_id: X.ap2CheckoutHash(checkoutJwt), payee: merchant, payment_amount: { amount: 2900, currency: "USD" } }, { aud: "credential-provider", nonce: "n-1", iat: NOW + 5 }, `${open.split("~").slice(0, 2).join("~")}~`, agent.p256)), { reference: undefined }))).toBe("invalid_mandate");
    // a disclosure nothing in the JWT commits to
    expect(bad(verify(X.ap2Chain(`${open}${b64(["salt-x", { id: "merchant_2" }])}~`, closed(open)), { reference: undefined }))).toBe("invalid_credential");
    // the closed checkout mandate carries the merchant's signed checkout as a disclosure of its own
    const co = X.ap2Close("checkout", { checkout_hash: X.ap2CheckoutHash(checkoutJwt) }, { aud: "merchant", nonce: "m-1", iat: NOW + 5 }, openCheckout, agent.p256, { checkout_jwt: checkoutJwt });
    expect(co.split("~").filter(Boolean)).toHaveLength(3);
    const read = X.ap2Verify(X.ap2Chain(openCheckout, co), "checkout", { issuers: [issuer.jwk], aud: "merchant", nonce: "m-1", nowSec: NOW + 10, checkout: { merchant: "merchant_1", items: [{ id: "feed", quantity: 1 }] } });
    expect(read.ok && read.closed.checkout_jwt).toBe(checkoutJwt);
  });

  it("a closed mandate is a key-binding SD-JWT: one signed under another type is not read as one", () => {
    const open = openPayment();
    const d = Buffer.from(JSON.stringify(["salt", { vct: "mandate.payment.1", transaction_id: X.ap2CheckoutHash(checkoutJwt), payee: merchant, payment_amount: { amount: 2900, currency: "USD" } }])).toString("base64url");
    const plain = `${X.jwsSign({ alg: "ES256", typ: "JWT" }, { delegate_payload: [{ "...": createHash("sha256").update(d).digest("base64url") }], iat: NOW + 5, aud: "credential-provider", nonce: "n-1", sd_hash: X.ap2MandateHash(open), _sd_alg: "sha-256" }, agent.p256)}~${d}~`;
    expect(bad(verify(X.ap2Chain(open, plain)))).toBe("invalid_credential");
    // someone the mandate is shown to, but not addressed to, checks everything except audience and nonce
    expect(bad(X.ap2Verify(X.ap2Chain(open, closed(open)), "payment", { issuers: [issuer.jwk], aud: null, nonce: null, nowSec: NOW + 10, reference: X.ap2MandateHash(openCheckout) }))).toBe("ok");
    expect(bad(X.ap2Verify(X.ap2Chain(open, closed(open, {}, {}, simKey("agent:codex").p256)), "payment", { issuers: [issuer.jwk], aud: null, nonce: null, nowSec: NOW + 10, reference: X.ap2MandateHash(openCheckout) }))).toBe("invalid_credential");
  });

  it("a checkout mandate is judged against the checkout its hash resolves to", () => {
    const close = X.ap2Close("checkout", { checkout_hash: X.ap2CheckoutHash(checkoutJwt) }, { aud: "merchant", nonce: "m-1", iat: NOW + 5 }, openCheckout, agent.p256);
    const check = (checkout: { merchant: string; items: Array<{ id: string; quantity: number }> }) => bad(X.ap2Verify(X.ap2Chain(openCheckout, close), "checkout", { issuers: [issuer.jwk], aud: "merchant", nonce: "m-1", nowSec: NOW + 10, checkout }));
    expect(check({ merchant: "merchant_1", items: [{ id: "feed", quantity: 1 }] })).toBe("ok");
    expect(check({ merchant: "merchant_2", items: [{ id: "feed", quantity: 1 }] })).toBe("invalid_mandate");
    expect(check({ merchant: "merchant_1", items: [{ id: "feed", quantity: 2 }] })).toBe("invalid_mandate");
    expect(check({ merchant: "merchant_1", items: [{ id: "feed", quantity: 1 }, { id: "gold-sneaker", quantity: 1 }] })).toBe("invalid_mandate");
    // a payment mandate is not a checkout mandate
    const open = openPayment();
    expect(bad(X.ap2Verify(X.ap2Chain(open, closed(open)), "checkout", { issuers: [issuer.jwk], aud: "credential-provider", nonce: "n-1", nowSec: NOW + 10 }))).toBe("invalid_mandate");
  });

  it("the agent's answer binds both closed mandates to the merchant's signed checkout", () => {
    const hash = X.ap2CheckoutHash(checkoutJwt);
    const needs: X.Ap2Needs = { needs: "mandates", protocol: "ap2", checkout: { id: "co_1", jwt: checkoutJwt, hash, total: { amount: 2900, currency: "USD" }, merchant }, open: { checkout: openCheckout, payment: openPayment() }, sign: { checkout: { aud: "merchant", nonce: "m-1" }, payment: { aud: "credential-provider", nonce: "n-1" } }, instrument: { id: "float:research", type: "stablecoin", description: "USDC float" } };
    const signed = X.ap2Answer(agent.p256, needs, NOW + 5);
    const pay = verify(X.ap2Chain(needs.open.payment, signed.payment));
    const co = X.ap2Verify(X.ap2Chain(needs.open.checkout, signed.checkout), "checkout", { issuers: [issuer.jwk], aud: "merchant", nonce: "m-1", nowSec: NOW + 10, checkout: { merchant: "merchant_1", items: [{ id: "feed", quantity: 1 }] } });
    expect([pay.ok && pay.closed.transaction_id, co.ok && co.closed.checkout_hash]).toEqual([hash, hash]);
    const receipt = X.jwsParse(X.ap2Receipt({ status: "Success", iss: merchant.website, iat: NOW, reference: X.ap2MandateHash(signed.checkout), order_id: "order_1" }, simKey("payee:merchant").p256, "merchant-key-1"))!;
    expect(X.jwsVerify(receipt, simKey("payee:merchant").jwk)).toBe(true);
    expect(X.jwsVerify(receipt, issuer.jwk)).toBe(false);
  });
});
