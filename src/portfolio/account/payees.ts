/** The other side of a payment, and the account's answer to it.
 *
 * An agent does not pay. It signs "pay for this, up to this much, from this float" (`agentPay`), and the
 * ACCOUNT does the rest: it asks the payee itself, reads what the payee wants out of the payee's own
 * challenge, holds that against what the owner approved, and only then signs the payment with a key the
 * agent never sees. Which protocol is spoken is the payee's choice, found in its answer:
 *
 *   402 + PAYMENT-REQUIRED            x402 V2 `exact`      data.sim    $0.01 a quote
 *   402 + WWW-Authenticate: Payment   MPP `charge`         infer.sim   $0.02 an answer
 *                                     MPP `session`        infer.sim   a deposit once, then a voucher a call
 *   200 + a checkout                  AP2, from a float    shop.sim    two mandates, then an EIP-3009 payment
 *
 * (One protocol per instrument is this demo's pairing, so that each is shown once; neither protocol asks for it.)
 *
 * The order of the checks is the point:
 *   1. the approval     this agent, this host — before one byte goes to the host
 *   2. the source       a float that is this agent's
 *   3. the payee's ask  its price against `maxAmount`; its address against the one pinned for it
 *   4. the limits       per payment, budget, the dial (session, Guard's cap), the float's balance, an app's
 *                       fee against the rate the owner approved for it
 *   5. the owner        the FIRST payment to a payee is a card that shows who is paid, where and how much;
 *                       the owner's signature covers those fields, and approving pins that address. After
 *                       that, a different address is a refusal, not a question
 *   6. the payment      signed by the float's key. The receipt is checked
 *                       against the ledger the money moved on, not taken on the payee's word
 *
 * Everything on the other side is SIMULATED, in this process: the hosts, the facilitator, the token ledger,
 * the escrow contract. The messages and the signatures are real (protocols.ts).
 * No request leaves the process: the `.sim` hosts exist only inside it.
 */
import { keccak256, stringToHex } from "viem";
import { isRefusal, type Refusal } from "../../core/errors.ts";
import { canonical } from "../../core/hash.ts";
import { no } from "../refuse.ts";
import { evaluate } from "../openness.ts";
import { plainRefusal } from "../words.ts";
import { agentIdOf, CARD_TTL_MS, slug, type AccountEngine, type CardLike, type CardOffer, type Outcome, type PayAction, type Payer, type PayView } from "./exchange.ts";
import type { Payment, PaymentLeg } from "./payments.ts";
import * as X from "./protocols.ts";
import { isJwk, micro, simKey, unmicro, ZERO, type Envelope, type Hex, type Jwk } from "./sign.ts";
import { covers, spendFor, type AgentKey, type SpendApproval, type SubAccount } from "./state.ts";

const HUB = "metamask";
const CHAIN = X.X402_USDC;
/** what the page calls the simulated chain */
const NETWORK = "Base Sepolia";
const TOKEN = CHAIN.asset.toLowerCase();
const TERMS = { network: CHAIN.network, asset: CHAIN.asset, extra: { name: CHAIN.name, version: CHAIN.version } };
/** the account's key for the AP2 mandates it issues from an owner's spending approval (the "agent provider" key a merchant is told to trust) */
const ISSUER = simKey("account:mandate-issuer");
const CP_AUD = "credential-provider";
const GRACE_MS = 15 * 60_000;
const LABEL: Record<string, string> = { x402: "x402 · EIP-3009", "mpp-charge": "MPP charge · EIP-3009", "mpp-session": "MPP session · escrow + vouchers", ap2: "AP2 mandates · EIP-3009" };

const usd = (m: number): string => `$${(m / 1e6).toFixed(m % 10_000 === 0 ? 2 : 4)}`;
const short = (a: string): string => (a.startsWith("0x") && a.length > 14 ? `${a.slice(0, 8)}…${a.slice(-4)}` : a);
const iso = (ms: number): string => new Date(ms).toISOString();
const sameAddress = (a: unknown, b: unknown): boolean => typeof a === "string" && typeof b === "string" && a !== "" && a.toLowerCase() === b.toLowerCase();
/** an amount a payee states in token units: a string of digits and nothing else — no sign, no fraction, no exponent */
const units = (v: unknown): number => (typeof v === "string" && /^\d{1,15}$/.test(v) ? Number(v) : Number.NaN);
/** an amount a payee states in minor units of a currency, as a JSON number */
const minor = (v: unknown): number => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 1e12 ? v : Number.NaN);
/** how long a signed authorisation stays good. A payee may ask for longer; it does not get it */
const AUTH_TTL_SEC = 60;
/** the host of a URL a payee supplied — only when it is https at a plain host; anything else (http, userinfo, not a URL) is no host at all */
const hostOf = (url: unknown): string => {
  try {
    const u = new URL(typeof url === "string" ? url : "");
    return u.protocol === "https:" && !u.username && !u.password ? u.host : "";
  } catch {
    return "";
  }
};

// ---- the simulated internet ---------------------------------------------------------------

export interface SimRequest {
  method: "GET" | "POST";
  url: string;
  headers?: Record<string, string> | undefined;
  body?: unknown;
}

export interface SimResponse {
  /** 0: the host did not answer */
  status: number;
  headers: Record<string, string>;
  body?: unknown;
}

interface Call {
  method: string;
  url: URL;
  header(name: string): string | undefined;
  body: unknown;
  nowMs: number;
}

type Handler = (c: Call) => Promise<SimResponse> | SimResponse;
const json = (status: number, body: unknown, headers: Record<string, string> = {}): SimResponse => ({ status, headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])), body });

/** what the token ledger needs to know about a float: its balance lives in the account's own state, in one place */
export interface FloatBook {
  balance(address: string): number | undefined;
  add(address: string, delta: number): void;
}

/** A token ledger: balances, spent authorisation nonces, and every transfer. It stands in for USDC on one chain. */
export class SimChain implements X.TokenView {
  private readonly bal = new Map<string, number>();
  private readonly spent = new Set<string>();
  readonly txs: Array<{ hash: Hex; from: string; to: string; value: number; memo: string }> = [];

  constructor(private readonly floats: FloatBook) {}

  balance(address: string): number {
    const a = address.toLowerCase();
    return this.floats.balance(a) ?? this.bal.get(a) ?? 0;
  }

  used(authorizer: string, nonce: string): boolean {
    return this.spent.has(`${authorizer.toLowerCase()}:${nonce}`);
  }

  private add(address: string, delta: number): void {
    const a = address.toLowerCase();
    if (this.floats.balance(a) !== undefined) this.floats.add(a, delta);
    else this.bal.set(a, (this.bal.get(a) ?? 0) + delta);
  }

  /** `null` when the sender does not hold it: nothing moved */
  transfer(from: string, to: string, value: number, memo: string): Hex | null {
    if (!Number.isInteger(value) || value < 0 || this.balance(from) < value) return null;
    this.add(from, -value);
    this.add(to, value);
    const tx = { hash: keccak256(stringToHex(canonical({ n: this.txs.length + 1, from: from.toLowerCase(), to: to.toLowerCase(), value, memo }))), from: from.toLowerCase(), to: to.toLowerCase(), value, memo };
    this.txs.push(tx);
    return tx.hash;
  }

  /** `transferWithAuthorization`: only inside the authorisation's window (both ends strict, as USDC has it), and the nonce is spent with the
   * transfer, so an authorisation settles once */
  authorized(a: X.Eip3009, nowSec: number): Hex | null {
    if (this.used(a.from, a.nonce) || !(nowSec > Number(a.validAfter)) || !(nowSec < Number(a.validBefore))) return null;
    const hash = this.transfer(a.from, a.to, Number(a.value), "transferWithAuthorization");
    if (hash) this.spent.add(`${a.from.toLowerCase()}:${a.nonce}`);
    return hash;
  }

  tx(hash: unknown): { from: string; to: string; value: number } | undefined {
    return typeof hash === "string" ? this.txs.find((t) => t.hash === hash) : undefined;
  }

  private readonly txNonces = new Set<string>();
  /** A signed transaction is good once, for its sender's nonce. Broadcasting it spends the nonce; so does the sender spending the nonce on
   * something else — which is how a wallet cancels a transaction it handed to someone who did not use it. `false`: already spent. */
  spendTxNonce(from: string, nonce: number): boolean {
    const k = `${from.toLowerCase()}:${nonce}`;
    if (this.txNonces.has(k)) return false;
    this.txNonces.add(k);
    return true;
  }
}

export interface Channel {
  id: Hex;
  payer: string;
  payee: string;
  token: string;
  deposit: number;
  /** what the payee has taken so far */
  settled: number;
  /** whose vouchers count: the payer's, or a signer it delegated to */
  signer: string;
  closeRequestedAt?: number | undefined;
  finalized: boolean;
}

/** The payment-channel escrow of MPP's EVM session method: a deposit goes in once, the payee takes what the highest voucher says, and the
 * rest goes back — when the payee closes, or, without the payee, a grace period after the payer asks. */
export class SimEscrow {
  readonly address = simKey("contract:evm-payment-channel").address;
  readonly chainId = CHAIN.chainId;
  readonly channels = new Map<string, Channel>();

  constructor(private readonly chain: SimChain) {}

  /** A channel is opened by a transaction its payer SIGNED — there is no other way in. Whoever holds that signed transaction can broadcast it,
   * once: it is good for its sender's nonce, and reverts if that nonce is spent (by an earlier broadcast, or by the payer cancelling it). */
  async broadcast(serialized: Hex): Promise<Channel | string> {
    const tx = await X.mppReadOpenTx(serialized);
    if (!tx || tx.to !== this.address || tx.chainId !== this.chainId) return "transaction-reverted";
    if (!this.chain.spendTxNonce(tx.from, tx.nonce)) return "transaction-reverted";
    return this.open(tx.from, tx.open);
  }

  private open(from: string, o: X.EscrowOpen): Channel | string {
    const id = X.mppChannelId(from, o.payee, o.token, o.salt, o.authorizedSigner, this.address, this.chainId);
    if (this.channels.has(id)) return "channel-exists";
    if (!(o.deposit > 0) || !this.chain.transfer(from, this.address, o.deposit, "escrow.open")) return "insufficient-balance";
    const ch: Channel = { id, payer: from, payee: o.payee, token: o.token, deposit: o.deposit, settled: 0, signer: o.authorizedSigner === ZERO ? from : o.authorizedSigner, finalized: false };
    this.channels.set(id, ch);
    return ch;
  }

  async voucher(id: string, cumulative: number, signature: Hex): Promise<Channel | string> {
    const ch = this.channels.get(id);
    if (!ch) return "channel-not-found";
    if (ch.finalized) return "channel-finalized";
    if (!Number.isInteger(cumulative) || cumulative > ch.deposit) return "amount-exceeds-deposit";
    const signer = await X.mppVoucherSigner(this.address, this.chainId, ch.id, cumulative, signature);
    return signer === ch.signer ? ch : signer ? "signer-mismatch" : "invalid-signature";
  }

  /** payee only. `close: false` takes what the voucher says and leaves the channel open; `close: true` also sends the rest back to the payer */
  async settle(caller: string, id: string, cumulative: number, signature: Hex, close: boolean): Promise<{ tx: Hex; paid: number; refund: number } | string> {
    const ch = await this.voucher(id, cumulative, signature);
    if (typeof ch === "string") return ch;
    if (caller !== ch.payee) return "not-payee";
    if (cumulative < ch.settled) return "delta-too-small";
    const paid = cumulative - ch.settled;
    const refund = close ? ch.deposit - cumulative : 0;
    const tx = this.chain.transfer(this.address, ch.payee, paid, close ? "escrow.close" : "escrow.settle")!;
    if (close) this.chain.transfer(this.address, ch.payer, refund, "escrow.close refund");
    ch.settled = cumulative;
    ch.finalized = close;
    return { tx, paid, refund };
  }

  /** payer only: ask for the deposit back without the payee. It can be withdrawn once the grace period has passed; until then the payee can still settle */
  requestClose(caller: string, id: string, nowMs: number): string | null {
    const ch = this.channels.get(id);
    if (!ch) return "channel-not-found";
    if (ch.finalized) return "channel-finalized";
    if (caller !== ch.payer) return "not-payer";
    ch.closeRequestedAt ??= nowMs;
    return null;
  }

  withdraw(caller: string, id: string, nowMs: number): { tx: Hex; refund: number } | string {
    const ch = this.channels.get(id);
    if (!ch) return "channel-not-found";
    if (ch.finalized) return "channel-finalized";
    if (caller !== ch.payer) return "not-payer";
    if (ch.closeRequestedAt === undefined || nowMs < ch.closeRequestedAt + GRACE_MS) return "grace-period";
    const refund = ch.deposit - ch.settled;
    const tx = this.chain.transfer(this.address, ch.payer, refund, "escrow.withdraw")!;
    ch.finalized = true;
    return { tx, refund };
  }
}

/** data.sim — a quote API that charges per call over x402. The knobs are what a hostile or broken payee would turn. */
class DataApi {
  payTo: string = simKey("payee:data.sim").address;
  priceMicro = 10_000;
  /** answer every request with a redirect */
  redirect: string | undefined;
  /** take the payment and send no receipt */
  mute = false;
  /** name another host in the offer */
  resourceHost: string | undefined;
  /** answer "payment failed" to a good payment, and keep the signed authorisation */
  stall = false;
  /** state the price as something that is not a plain number of token units, and ask for a long time limit */
  rawAmount: string | undefined;
  timeoutSeconds = 60;
  readonly kept: X.X402Payload[] = [];

  constructor(private readonly chain: SimChain) {}

  requirements(): X.X402Requirements {
    return { scheme: "exact", network: CHAIN.network, amount: this.rawAmount ?? String(this.priceMicro), asset: CHAIN.asset, payTo: this.payTo, maxTimeoutSeconds: this.timeoutSeconds, extra: { assetTransferMethod: "eip3009", name: CHAIN.name, version: CHAIN.version } };
  }

  readonly handle: Handler = async (c) => {
    if (this.redirect) return json(302, {}, { location: this.redirect });
    const req = this.requirements();
    const href = this.resourceHost ? c.url.href.replace(c.url.host, this.resourceHost) : c.url.href;
    const required = (error: string): SimResponse => json(402, {}, { "PAYMENT-REQUIRED": X.b64json({ x402Version: 2, error, resource: { url: href, description: "Delayed quote, one symbol", mimeType: "application/json" }, accepts: [req], extensions: {} } satisfies X.X402Required) });
    const header = c.header("payment-signature");
    if (!header) return required("PAYMENT-SIGNATURE header is required");
    const payload = X.unb64json<X.X402Payload>(header);
    // a payload that does not parse is a 400; a payment that fails is a 402 whose PAYMENT-RESPONSE says why, with a fresh offer beside it
    if (!payload?.payload?.authorization || !payload.accepted) return json(400, { error: "invalid_payload" });
    const failed = (errorReason: string): SimResponse => {
      const again = required(errorReason);
      return { ...again, headers: { ...again.headers, "payment-response": X.b64json({ success: false, errorReason, transaction: "", network: req.network, payer: String(payload.payload.authorization.from ?? "").toLowerCase() }) } };
    };
    if (canonical(payload.accepted) !== canonical(req)) return failed("invalid_payment_requirements");
    // the facilitator: verify, then settle
    const nowSec = Math.floor(c.nowMs / 1000);
    const v = await X.x402Verify(payload, req, nowSec, this.chain);
    if (!v.isValid) return failed(v.invalidReason ?? "invalid_payload");
    if (this.stall) {
      this.kept.push(payload);
      return failed("settlement_failed");
    }
    const tx = this.chain.authorized(payload.payload.authorization, nowSec);
    if (!tx) return failed("invalid_transaction_state");
    const symbol = (c.url.searchParams.get("symbol") ?? "SPY").toUpperCase().slice(0, 8);
    if (this.mute) return json(200, { symbol });
    return json(200, { symbol, price: symbol === "NVDA" ? 150.12 : 600.4, currency: "USD", delayedMin: 15 }, { "PAYMENT-RESPONSE": X.b64json({ success: true, payer: v.payer, transaction: tx, network: req.network }) });
  };
}

/** infer.sim — an inference API behind MPP. `/v1/answers` is a `charge` per call; `/v1/stream` is a `session`: a deposit once, a voucher a call. */
class InferApi {
  readonly realm = "infer.sim";
  /** the server's HMAC key for binding a challenge's id to its parameters; a label, like every key here */
  private readonly secret = "infer.sim/challenge-binding";
  recipient: string = simKey("payee:infer.sim").address;
  chargeMicro = 20_000;
  unitMicro = 10_000;
  depositMicro = 500_000;
  /** name another escrow contract in the challenge */
  escrowContract: string | undefined;
  private readonly usedChallenges = new Set<string>();
  private issued = 0;
  /** per channel: the highest voucher this server accepted */
  readonly accepted = new Map<string, { cumulative: number; signature: Hex; calls: number }>();

  constructor(
    private readonly chain: SimChain,
    private readonly escrow: SimEscrow,
  ) {}

  private challenge(intent: "charge" | "session", nowMs: number): X.MppChallenge {
    const request = intent === "charge" ? X.jcs64({ amount: String(this.chargeMicro), currency: CHAIN.asset, recipient: this.recipient, methodDetails: { chainId: CHAIN.chainId } } satisfies X.MppChargeRequest) : X.jcs64({ amount: String(this.unitMicro), unitType: "request", suggestedDeposit: String(this.depositMicro), currency: CHAIN.asset, recipient: this.recipient, methodDetails: { escrowContract: this.escrowContract ?? this.escrow.address, chainId: CHAIN.chainId } } satisfies X.MppSessionRequest);
    // `opaque` is the server's own data, echoed back and covered by the id: here a serial, so that two challenges issued in the same instant differ
    const c = { realm: this.realm, method: "evm", intent, request, expires: iso(nowMs + 5 * 60_000), opaque: X.jcs64({ n: String(++this.issued) }) };
    return { id: X.mppChallengeId(this.secret, c), ...c };
  }

  /** a 402 is always a fresh challenge; when a credential failed, with the reason as a Problem Details body */
  private ask(intent: "charge" | "session", nowMs: number, problem?: [string, string]): SimResponse {
    return json(402, problem ? X.mppProblem(problem[0], problem[1]) : X.mppProblem("payment-required", "payment is required for this resource"), { "WWW-Authenticate": X.mppHeader(this.challenge(intent, nowMs)), "Cache-Control": "no-store" });
  }

  private receipt(fields: Record<string, unknown>, nowMs: number): Record<string, string> {
    return { "Payment-Receipt": X.jcs64({ status: "success", method: "evm", timestamp: iso(nowMs), ...fields }) };
  }

  /** the payee collects what its highest voucher says without closing (what it would do when the payer asks to leave) */
  async collect(channelId: string): Promise<boolean> {
    const a = this.accepted.get(channelId);
    return !!a && typeof (await this.escrow.settle(this.recipient, channelId, a.cumulative, a.signature, false)) !== "string";
  }

  readonly handle: Handler = async (c) => {
    const intent = c.url.pathname === "/v1/answers" ? "charge" : c.url.pathname === "/v1/stream" ? "session" : undefined;
    if (!intent) return json(404, { error: "not found" });
    const cred = X.mppReadAuthorization(c.header("authorization"));
    if (!cred) return this.ask(intent, c.nowMs);
    const ch = cred.challenge;
    // the challenge that comes back must be one this server issued, unchanged: its id is an HMAC over its own parameters
    if (!ch || X.mppChallengeId(this.secret, ch) !== ch.id || ch.intent !== intent) return this.ask(intent, c.nowMs, ["invalid-challenge", "the challenge was not issued by this server, or was changed"]);
    if (!ch.expires || Date.parse(ch.expires) <= c.nowMs) return this.ask(intent, c.nowMs, ["payment-expired", "the challenge has expired"]);
    if (this.usedChallenges.has(ch.id)) return this.ask(intent, c.nowMs, ["verification-failed", "this proof was used before: a proof is usable exactly once"]);
    const p = cred.payload as Record<string, unknown>;

    if (intent === "charge") {
      // the terms are the ones the challenge itself carries (and the HMAC protects), not whatever the server is configured with now
      const req = X.unjcs64<X.MppChargeRequest>(ch.request)!;
      const a = p.authorization as X.Eip3009 | undefined;
      if (p.type !== "authorization" || !a || typeof p.signature !== "string") return this.ask(intent, c.nowMs, ["malformed-credential", "expected an EIP-3009 authorization"]);
      if (a.nonce !== X.mppChargeNonce(ch)) return this.ask(intent, c.nowMs, ["invalid-payload", "the authorization's nonce does not commit to this challenge"]);
      if ((await X.eip3009Signer(TERMS, a, p.signature as Hex)) !== a.from.toLowerCase()) return this.ask(intent, c.nowMs, ["verification-failed", "the signature is not the payer's"]);
      if (!sameAddress(a.to, req.recipient) || a.value !== req.amount || !(Number(a.validBefore) > c.nowMs / 1000)) return this.ask(intent, c.nowMs, ["payment-insufficient", "the authorization is not for this amount to this recipient"]);
      const tx = this.chain.authorized(a, Math.floor(c.nowMs / 1000));
      if (!tx) return this.ask(intent, c.nowMs, ["payment-insufficient", "the transfer would not go through"]);
      this.usedChallenges.add(ch.id);
      return json(200, { answer: "42", model: "sim-1" }, this.receipt({ reference: tx }, c.nowMs));
    }

    const channelId = String(p.channelId ?? "");
    const cumulative = units(p.cumulativeAmount);
    const signature = p.signature as Hex;
    const fail = (code: string): SimResponse => this.ask(intent, c.nowMs, [`session/${code}`, `the ${String(p.action)} was not accepted: ${code}`]);
    if ((p.action !== "open" && p.action !== "voucher" && p.action !== "close") || !Number.isInteger(cumulative) || typeof signature !== "string") return this.ask(intent, c.nowMs, ["malformed-credential", "a session credential is an open, a voucher or a close, with a channel, a cumulative amount and a signature"]);
    const receipt = (reference: string, total: number, extra: Record<string, unknown> = {}) => this.receipt({ intent: "session", reference, challengeId: ch.id, channelId, acceptedCumulative: String(total), spent: String(total), ...extra }, c.nowMs);
    if (p.action === "open") {
      // a channel opens with a voucher for zero; the first call brings the first real voucher
      if (cumulative !== 0) return this.ask(intent, c.nowMs, ["invalid-payload", "a channel opens with a voucher for 0"]);
      const tx = typeof p.transaction === "string" ? await X.mppReadOpenTx(p.transaction as Hex) : null;
      if (!tx || tx.to !== this.escrow.address || tx.chainId !== CHAIN.chainId || !sameAddress(tx.open.payee, this.recipient) || tx.open.token !== TOKEN) return fail("transaction-reverted");
      // the voucher is checked BEFORE the transaction is broadcast: no deposit is taken for a credential that would then be refused
      if (X.mppChannelId(tx.from, tx.open.payee, tx.open.token, tx.open.salt, tx.open.authorizedSigner, this.escrow.address, CHAIN.chainId) !== channelId) return fail("channel-not-found");
      const signer = await X.mppVoucherSigner(this.escrow.address, CHAIN.chainId, channelId as Hex, 0, signature);
      if (signer !== (tx.open.authorizedSigner === ZERO ? tx.from : tx.open.authorizedSigner)) return fail(signer ? "signer-mismatch" : "invalid-signature");
      // the server broadcasts the payer's signed transaction (it reverts if its nonce has been spent)
      const opened = await this.escrow.broadcast(p.transaction as Hex);
      if (typeof opened === "string") return fail(opened);
      this.accepted.set(channelId, { cumulative: 0, signature, calls: 0 });
      this.usedChallenges.add(ch.id);
      return json(200, { opened: true, deposit: String(opened.deposit) }, receipt(channelId, 0));
    }
    const chan = await this.escrow.voucher(channelId, cumulative, signature);
    if (typeof chan === "string") return fail(chan);
    const before = this.accepted.get(channelId);
    if (!before || !sameAddress(chan.payee, this.recipient)) return fail("channel-not-found");
    this.usedChallenges.add(ch.id);
    if (p.action === "close") {
      // what is captured is what was consumed — this server's own highest accepted voucher — whatever larger or smaller total the close names
      const done = await this.escrow.settle(this.recipient, channelId, before.cumulative, before.signature, true);
      if (typeof done === "string") return fail(done);
      return json(200, { closed: true, paid: String(before.cumulative), refunded: String(done.refund) }, receipt(done.tx, before.cumulative));
    }
    // a voucher pays for one call: the total goes up by exactly the unit price
    const delta = cumulative - before.cumulative;
    if (delta < this.unitMicro) return fail("delta-too-small");
    if (delta > this.unitMicro) return this.ask(intent, c.nowMs, ["invalid-payload", "a voucher pays for one call: raise the total by exactly the unit price"]);
    this.accepted.set(channelId, { cumulative, signature, calls: before.calls + 1 });
    return json(200, { chunk: `answer ${before.calls + 1}`, model: "sim-1" }, receipt(channelId, cumulative, { units: 1 }));
  };
}

/** what shop.sim's item page says: the offer, who the merchant is, and how it can be checked out */
export interface ShopPage {
  item: { id: string; title: string; price: { amount: number; currency: string } };
  merchant: { id: string; name: string; website: string; jwk: Jwk; processor_jwk: Jwk };
  checkout: {
    ap2?: { checkouts: string; settles: Omit<X.X402Requirements, "amount"> } | undefined;
  };
}

/** shop.sim — a merchant selling a data subscription. It takes USDC from an agent that brings AP2 mandates. */
class Shop {
  readonly key = simKey("payee:shop.sim");
  private readonly processor = simKey("payee:shop.sim/processor");
  readonly merchant = { id: "merchant_shop_sim", name: "Shop Sim", website: "https://shop.sim" };
  payTo: string = this.key.address;
  priceCents = 2900;
  /** a different total at checkout than on the page */
  checkoutCents: number | undefined;
  private readonly checkouts = new Map<string, { jwt: string; hash: string; nonce: string; items: Array<{ id: string; quantity: number }>; cents: number; done: boolean }>();
  private seq = 0;

  constructor(
    private readonly chain: SimChain,
    /** the agent providers whose open mandates this merchant accepts */
    private readonly trusted: Jwk[],
  ) {}

  private settles(): Omit<X.X402Requirements, "amount"> {
    return { scheme: "exact", network: CHAIN.network, asset: CHAIN.asset, payTo: this.payTo, maxTimeoutSeconds: 300, extra: { assetTransferMethod: "eip3009", name: CHAIN.name, version: CHAIN.version } };
  }

  private page(id: string): ShopPage {
    return { item: { id, title: "Desk Feed Pro · 30 days", price: { amount: this.priceCents, currency: "usd" } }, merchant: { ...this.merchant, jwk: this.key.jwk, processor_jwk: this.processor.jwk }, checkout: { ap2: { checkouts: "https://shop.sim/ap2/checkouts", settles: this.settles() } } };
  }

  readonly handle: Handler = async (c) => {
    const path = c.url.pathname;
    const item = /^\/items\/([a-z0-9-]+)$/.exec(path);
    if (c.method === "GET" && item) return item[1] === "desk-feed-pro" ? json(200, this.page(item[1])) : json(404, { error: "no such item" });
    if (c.method !== "POST") return json(404, { error: "not found" });
    const items = ((c.body as { items?: Array<{ id?: unknown; quantity?: unknown }> } | undefined)?.items ?? []).map((i) => ({ id: String(i.id), quantity: Number(i.quantity) }));
    const total = this.checkoutCents ?? this.priceCents;

    // ---- AP2: a checkout the merchant signs, then its completion with the agent's mandates and a payment credential
    if (path === "/ap2/checkouts") {
      if (items.length !== 1 || items[0]!.id !== "desk-feed-pro" || items[0]!.quantity !== 1) return json(400, { error: "one desk-feed-pro" });
      const id = `co_${String(++this.seq).padStart(6, "0")}`;
      const iat = Math.floor(c.nowMs / 1000);
      // "outside the scope" of AP2: this is the checkout as this shop writes it
      const jwt = X.jwsSign({ alg: "ES256", typ: "JWT", kid: "merchant-key-1" }, { iss: this.merchant.website, iat, exp: iat + 900, id, merchant: this.merchant, line_items: [{ item: { id: "desk-feed-pro", title: "Desk Feed Pro · 30 days" }, quantity: 1, amount: total }], totals: [{ type: "total", amount: total }], currency: "USD", status: "incomplete" }, this.key.p256);
      const nonce = keccak256(stringToHex(`shop.sim/${id}`)).slice(2, 34);
      this.checkouts.set(id, { jwt, hash: X.ap2CheckoutHash(jwt), nonce, items, cents: total, done: false });
      return json(201, { id, checkout_jwt: jwt, nonce });
    }
    const m = /^\/ap2\/checkouts\/([^/]+)\/complete$/.exec(path);
    if (m) {
      const co = this.checkouts.get(m[1]!);
      if (!co) return json(404, { error: "no such checkout" });
      const b = c.body as { checkout_mandate?: string; payment_mandate?: string; payment_credential?: X.X402Payload } | undefined;
      const nowSec = Math.floor(c.nowMs / 1000);
      const reference = (chain: string | undefined) => X.ap2MandateHash((chain ?? "").split("~~")[1] ?? "");
      const refuse = (error: X.Ap2Error, description: string) => json(400, { checkout_receipt: X.ap2Receipt({ status: "Error", iss: this.merchant.website, iat: nowSec, reference: reference(b?.checkout_mandate), error, error_description: description }, this.key.p256, "merchant-key-1") });
      if (co.done) return refuse("invalid_mandate", "this checkout is already complete");
      // the merchant's own check: is this agent allowed to commit the user to THIS checkout?
      const v = X.ap2Verify(b?.checkout_mandate ?? "", "checkout", { issuers: this.trusted, aud: "merchant", nonce: co.nonce, nowSec, checkout: { merchant: this.merchant.id, items: co.items } });
      if (!v.ok) return refuse(v.error, v.description);
      if (v.closed.checkout_hash !== co.hash || (v.closed.checkout_jwt !== undefined && v.closed.checkout_jwt !== co.jwt)) return refuse("invalid_mandate", "the mandate names a different checkout");
      // the processor is SHOWN the payment mandate (it is addressed to the credential provider, so audience and nonce are not the processor's
      // to check): it reads the chain, and that the payment it authorises is this checkout's
      const openCheckout = (b?.checkout_mandate ?? "").slice(0, (b?.checkout_mandate ?? "").indexOf("~~") + 1);
      const pm = X.ap2Verify(b?.payment_mandate ?? "", "payment", { issuers: this.trusted, aud: null, nonce: null, nowSec, reference: X.ap2MandateHash(openCheckout) });
      if (!pm.ok) return refuse(pm.error, `the payment mandate: ${pm.description}`);
      const due = pm.closed.payment_amount as { amount?: number; currency?: string } | undefined;
      if (pm.closed.transaction_id !== co.hash || (pm.closed.payee as { id?: string } | undefined)?.id !== this.merchant.id || due?.amount !== co.cents || due.currency !== "USD") return refuse("invalid_mandate", "the payment mandate is for another checkout, another payee or another amount");
      // and the payment credential: is it good for this total, to this merchant?
      const req: X.X402Requirements = { ...this.settles(), amount: String(co.cents * 10_000) };
      const pc = b?.payment_credential;
      if (!pc || canonical(pc.accepted) !== canonical(req)) return refuse("invalid_credential", "the payment credential is not for this checkout's total");
      const pv = await X.x402Verify(pc, req, nowSec, this.chain);
      if (!pv.isValid) return refuse("invalid_credential", `the payment credential does not verify: ${pv.invalidReason}`);
      const tx = this.chain.authorized(pc.payload.authorization, nowSec);
      if (!tx) return refuse("invalid_credential", "the payment did not settle");
      co.done = true;
      const order = { id: `order_${m[1]!.slice(3)}`, permalink_url: `https://shop.sim/orders/${m[1]!.slice(3)}` };
      return json(200, {
        order,
        checkout_receipt: X.ap2Receipt({ status: "Success", iss: this.merchant.website, iat: nowSec, reference: reference(b?.checkout_mandate), order_id: order.id }, this.key.p256, "merchant-key-1"),
        payment_receipt: X.ap2Receipt({ status: "Success", iss: `${this.merchant.website}/processor`, iat: nowSec, reference: reference(b?.payment_mandate), payment_id: `pay_${m[1]!.slice(3)}`, network_confirmation_id: tx }, this.processor.p256, "processor-key-1"),
      });
    }
    return json(404, { error: "not found" });
  };
}

/** The hosts an account can reach in the simulation. A test (or the demo) turns a payee's knobs to play the attacker. */
export class PayeeWorld {
  chain!: SimChain;
  escrow!: SimEscrow;
  data!: DataApi;
  infer!: InferApi;
  shop!: Shop;
  /** hosts that have stopped answering */
  readonly down = new Set<string>();
  /** every request the account sent out: the proof that nothing goes to a host the owner did not name */
  readonly sent: Array<{ method: string; host: string; path: string; status: number }> = [];
  /** how long a payee is waited for (real milliseconds); one that takes longer has not answered. Every instruction after this one waits behind it, so it is short */
  timeoutMs = 3000;
  /** a payee that never answers */
  readonly hung = new Set<string>();
  private hosts = new Map<string, Handler>();

  constructor(private readonly floats: FloatBook) {
    this.reset();
  }

  reset(): void {
    this.chain = new SimChain(this.floats);
    this.escrow = new SimEscrow(this.chain);
    this.data = new DataApi(this.chain);
    this.infer = new InferApi(this.chain, this.escrow);
    this.shop = new Shop(this.chain, [ISSUER.jwk]);
    this.hosts = new Map<string, Handler>([["data.sim", this.data.handle], ["infer.sim", this.infer.handle], ["shop.sim", this.shop.handle]]);
    this.down.clear();
    this.hung.clear();
    this.sent.length = 0;
  }

  /** one request, one answer. A redirect comes back as it is: nothing here follows one */
  async fetch(req: SimRequest, nowMs: number): Promise<SimResponse> {
    const url = new URL(req.url);
    const headers = new Map(Object.entries(req.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const handler = this.down.has(url.host) ? undefined : this.hosts.get(url.host);
    const silence: SimResponse = { status: 0, headers: {}, body: { error: "no answer" } };
    let timer: ReturnType<typeof setTimeout> | undefined;
    // a payee is waited for, not for ever: every instruction after this one is waiting behind it
    const answer = handler ? (this.hung.has(url.host) ? new Promise<SimResponse>(() => undefined) : Promise.resolve(handler({ method: req.method, url, header: (n) => headers.get(n.toLowerCase()), body: req.body, nowMs }))) : Promise.resolve(silence);
    const res = await Promise.race([answer, new Promise<SimResponse>((resolve) => (timer = setTimeout(() => resolve(silence), this.timeoutMs)))]);
    clearTimeout(timer);
    this.sent.push({ method: req.method, host: url.host, path: url.pathname, status: res.status });
    return res;
  }
}

// ---- the account's side -------------------------------------------------------------------------

interface Who {
  signer: string;
  agent: AgentKey;
  envelope: Envelope;
  hash: Hex;
}

interface Ctx {
  action: PayAction;
  who: Who;
  released: CardLike | undefined;
  url: URL;
  host: string;
  /** the most this call may cost, in millionths */
  max: number;
  spendId: string;
  sub: string | undefined;
  now: number;
  flight: string;
  /** a signed authorisation that has been handed to the payee: from here the ledger, not the payee's answer, says whether it was paid */
  handed?: { o: Offer; from: string; nonce: Hex; validBefore: number; native: unknown } | undefined;
}

/** what a payee asked for, in the terms every check and every card uses */
interface Offer {
  protocol: string;
  payTo: string;
  amountMicro: number;
  network: string;
  mcc: string;
  /** a session about to open: the most the payee asks to have locked, and the escrow it goes into */
  depositMicro?: number | undefined;
  escrow?: string | undefined;
}

interface Session {
  id: Hex;
  host: string;
  url: string;
  sub: string;
  agent: string;
  spend: string;
  payment: string;
  deposit: number;
  cumulative: number;
  signature: Hex;
  calls: number;
  status: "open" | "closing" | "closed" | "withdrawn";
  openedAt: string;
  /** when a deposit asked back without the payee can be withdrawn */
  withdrawAt?: number | undefined;
  note?: string | undefined;
}

/** an authorisation that was signed and handed over, and that the ledger does not yet show as used */
interface Outstanding {
  c: Ctx;
  o: Offer;
  from: string;
  nonce: Hex;
  /** seconds */
  validBefore: number;
  native: unknown;
}

interface PendingAp2 {
  /** the spending approval it was made under: a checkout does not outlive it */
  spend: string;
  needs: X.Ap2Needs;
  merchantNonce: string;
  requirements: X.X402Requirements;
  amountMicro: number;
  expiresAt: number;
}

const offerHash = (action: Hex, host: string, o: Offer): Hex => keccak256(stringToHex(canonical({ action, payee: host, payTo: o.payTo.toLowerCase(), amount: unmicro(o.amountMicro), protocol: o.protocol, network: o.network, ...(o.depositMicro !== undefined ? { deposit: unmicro(o.depositMicro), escrow: (o.escrow ?? "").toLowerCase() } : {}) })));

export class SimPayer implements Payer {
  private sessions: Session[] = [];
  private pending = new Map<string, PendingAp2>();
  private paid = new Map<string, { protocol: string; payTo: string; micro: number; payments: number; lastAt: string }>();
  private outstanding: Outstanding[] = [];
  private seq = 0;

  constructor(
    private readonly engine: AccountEngine,
    readonly world: PayeeWorld,
  ) {}

  reset(): void {
    this.sessions = [];
    this.pending = new Map();
    this.paid = new Map();
    this.outstanding = [];
    this.seq = 0;
    this.world.reset();
  }

  /** A signed authorisation the payee did not settle is still a cheque it can cash until it expires. Its amount stays set aside in the approval's
   * budget, and the ledger is asked again later (`tick`): if the payee cashed it after saying the payment had failed, the payment is booked then. */
  private hold(c: Ctx, o: Offer, from: string, nonce: Hex, validBefore: number, native: unknown): string {
    this.outstanding.push({ c, o, from, nonce, validBefore, native });
    this.engine.patchSpend(c.spendId, (x) => ({ ...x, reservedMicro: x.reservedMicro + o.amountMicro }));
    this.engine.host.log({ kind: "payment", venue: c.host, tool: "authorisation outstanding", outcome: "unknown", notionalUsd: o.amountMicro / 1e6, reason: `${c.host} holds a signed authorisation for ${usd(o.amountMicro)} it did not settle: good until ${iso(validBefore * 1000)}, set aside until then`, flight: c.flight, agent: slug(c.who.agent.name), native });
    return `the signed authorisation stays good for ${Math.max(0, validBefore - Math.floor(c.now / 1000))} s more, and its ${usd(o.amountMicro)} is set aside until it is used or expires`;
  }

  view(): PayView {
    return {
      payees: [...this.paid.entries()].map(([host, p]) => ({ host, protocol: p.protocol, payTo: p.payTo, paidUsd: p.micro / 1e6, payments: p.payments, lastAt: p.lastAt })),
      sessions: this.sessions.map((s) => ({ id: s.id, host: s.host, subAccount: s.sub, depositUsd: s.deposit / 1e6, spentUsd: s.cumulative / 1e6, status: s.status, openedAt: s.openedAt, ...(s.note ? { note: s.note } : {}) })),
    };
  }

  private spend(c: Ctx): SpendApproval {
    return this.engine.state.spends.find((s) => s.id === c.spendId)!;
  }

  private float(c: Ctx): SubAccount {
    return this.engine.sub(c.sub ?? "")!;
  }

  private fetch(req: SimRequest, c: Ctx): Promise<SimResponse> {
    return this.world.fetch(req, c.now);
  }

  /** a nonce for an authorisation: unique per instruction and per signature made for it */
  private nonce(c: Ctx): Hex {
    return keccak256(stringToHex(`${c.who.hash}:${++this.seq}`));
  }

  async pay(action: PayAction, who: Who, released?: CardLike): Promise<Outcome> {
    const e = this.engine;
    const now = e.nowMs();
    let url: URL;
    try {
      url = new URL(action.url);
    } catch {
      return no("E_ACCOUNT_BAD_ACTION", { message: "a payment names the URL of what is being paid for" });
    }
    if (url.protocol !== "https:" || url.username || url.password) return no("E_ACCOUNT_BAD_ACTION", { message: "a payee is reached over https, at a plain host" });
    const max = micro(action.maxAmount);
    if (Number.isNaN(max) || (max === 0 && !action.close)) return no("E_ACCOUNT_BAD_ACTION", { message: "maxAmount is a plain decimal, more than zero" });
    // 1 · the approval. Nothing is sent to a host the owner did not name
    const spend = spendFor(e.state, who.signer, "payees", now);
    if (isRefusal(spend)) return spend;
    if (!(await e.stillSigned(spend))) return no("E_ACCOUNT_BAD_SIGNATURE", { message: "the spending approval's own signature no longer checks out against the account's owners", detail: { approval: spend.id } });
    if (!spend.allow.includes(url.host)) return no("E_MANDATE_RECIPIENT", { venue: url.host, message: `"${url.host}" is not a payee the owner approved (${spend.allow.join(", ")}): nothing was sent to it`, detail: { approval: spend.id, allow: spend.allow, host: url.host } });
    // 2 · the source
    const sub = action.fromSubAccount === "" ? undefined : e.sub(action.fromSubAccount);
    if (action.fromSubAccount !== "" && !sub) return no("E_WALLET_ACCOUNT_UNKNOWN", { message: `there is no sub-account "${action.fromSubAccount}"` });
    if (sub && sub.agent !== who.signer) return no("E_ACCOUNT_SOURCE", { message: `the float "${sub.name}" belongs to another agent key`, detail: { subAccount: sub.name } });
    const flight = released?.flight ?? e.host.openFlight(agentIdOf(who.agent), `${action.close ? "Close the session at" : "Pay"} ${url.host}${url.pathname}`).no;
    const c: Ctx = { action, who, released, url, host: url.host, max, spendId: spend.id, sub: sub?.name, now, flight };
    let out: Outcome;
    try {
      out = await (action.close ? this.close(c) : this.ask(c));
    } catch (err) {
      // whatever a payee sends, the door answers with a refusal, never with an exception — and if something had been handed over by then,
      // the ledger is asked what became of it before anything is said
      out = this.afterTrouble(c, err instanceof Error ? err.message.slice(0, 80) : "error");
    }
    if (isRefusal(out) && (out.detail as { paid?: boolean } | undefined)?.paid !== true) e.host.say(flight, `${c.host}: ${plainRefusal(out, (id) => e.name(id))}`, "no");
    return out;
  }

  /** something went wrong while a payee was being answered. If an authorisation was handed over, find out from the ledger whether it was used,
   * and book it or set it aside; only then answer. */
  private afterTrouble(c: Ctx, what: string): Refusal {
    const unread = `${c.host} answered with something this account could not read (${what})`;
    if (c.handed) {
      const h = c.handed;
      if (this.world.chain.used(h.from, h.nonce)) {
        this.book(c, h.o, { ref: h.nonce, native: h.native, note: `${c.host} took the payment and its answer could not be read` });
        return no("E_PAYEE_UNVERIFIED", { venue: c.host, message: `${unread}; it took ${usd(h.o.amountMicro)}, which is on the ledger`, detail: { paid: true, thrown: true } });
      }
      return no("E_PAYEE_UNVERIFIED", { venue: c.host, message: `${unread}; nothing has moved; ${this.hold(c, h.o, h.from, h.nonce, h.validBefore, h.native)}`, detail: { thrown: true } });
    }
    return no("E_PAYEE_UNVERIFIED", { venue: c.host, message: `${unread}: nothing further was sent`, detail: { thrown: true } });
  }

  /** ask the payee, and speak whatever it answers in */
  private async ask(c: Ctx): Promise<Outcome> {
    const first = await this.fetch({ method: "GET", url: c.url.href }, c);
    if (first.status === 0) return no("E_PAYEE_REJECTED", { venue: c.host, message: `${c.host} did not answer` });
    // told by its host only, as the real payer tells it (pay-real.ts): a redirect's path may carry where the user is
    if (first.status >= 300 && first.status < 400) {
      const host = redirectHost(first.headers.location, c.url.href);
      return no("E_PAYEE_REDIRECT", { venue: c.host, message: `${c.host} sent the request on to ${host ?? "another address"}: a payment does not follow a redirect`, detail: { redirectHost: host } });
    }
    if (first.status === 402 && first.headers["payment-required"]) return this.x402(c, first);
    if (first.status === 402 && first.headers["www-authenticate"]) return this.mpp(c, first);
    const page = first.body as Partial<ShopPage> | undefined;
    if (first.status === 200 && page?.checkout && page.item && page.merchant) return c.sub ? this.ap2(c, page as ShopPage) : no("E_PAYEE_UNSUPPORTED", { venue: c.host, message: `${c.host} is paid in USDC: name the float that pays` });
    if (first.status === 200) return { ok: true, kind: "result", result: { paid: false, data: first.body }, flight: c.flight };
    return no("E_PAYEE_UNSUPPORTED", { venue: c.host, message: `${c.host} answered ${first.status} with no payment method this account speaks`, detail: { status: first.status } });
  }

  // ---- the checks every protocol goes through ----------------------------------------------------

  /** `null`: go ahead and pay. Anything else is the answer (a refusal, or a card that now waits for the owner). */
  private gate(c: Ctx, o: Offer, opt: { hold?: number; inSession?: boolean; noCard?: boolean } = {}): Outcome | null {
    const e = this.engine;
    const spend = this.spend(c);
    if (!Number.isInteger(o.amountMicro) || !(o.amountMicro > 0)) return no("E_PAYEE_UNVERIFIED", { venue: c.host, message: `${c.host} asks for an amount that is not a number of token units` });
    if (o.amountMicro > c.max) return no("E_PAYEE_OVERCHARGE", { venue: c.host, message: `${c.host} asks ${usd(o.amountMicro)}; the agent agreed to ${usd(c.max)} at most`, detail: { asked: unmicro(o.amountMicro), maxAmount: c.action.maxAmount } });
    const pinned = spend.payTo[this.pinKey(c)];
    if (pinned !== undefined && pinned !== o.payTo.toLowerCase()) return no("E_PAYEE_CHANGED", { venue: c.host, message: `${c.host} now asks to be paid at ${short(o.payTo)}; the owner approved ${short(pinned)} for it`, detail: { pinned, offered: o.payTo.toLowerCase() } });
    // the approval's own limits. What is about to be committed is the payment — or, when a session opens, its whole deposit: one authorisation,
    // judged as one. Inside a session the budget was set aside when the deposit went in; each voucher still obeys the per-payment line
    // an app's fee, against the rate the owner approved for that app — and inside the same limits as the payment it rides on
    const fee = this.fee(c, o);
    if (isRefusal(fee)) return fee;
    const hold = (opt.hold ?? o.amountMicro) + fee;
    const limit = opt.inSession ? (o.amountMicro > spend.perPaymentMicro ? no("E_MANDATE_PER_ORDER_CAP", { detail: { approval: spend.id, perPayment: spend.perPaymentMicro / 1e6, amount: o.amountMicro / 1e6 } }) : null) : covers(spend, c.host, hold, c.now);
    if (limit) return limit;
    // the dial: an ended session, the wallet switched off, Guard's daily cap — and Guard's allowance, which asks
    const instrument = e.host.adapter(HUB)?.account;
    if (!instrument) return no("E_WALLET_ACCOUNT_UNKNOWN", { venue: HUB });
    const v = evaluate({ intent: { kind: "pay", merchant: c.host, mcc: o.mcc, amountUsd: o.amountMicro / 1e6 }, account: { ...instrument, scope: { ...instrument.scope, can: [...new Set([...instrument.scope.can, "pay" as const])] } }, openness: e.host.policy(), now: e.host.now(), dailyOutUsd: e.host.dailyOutUsd(e.host.now()) });
    if (isRefusal(v)) return v;
    if (c.sub) {
      const have = this.float(c).balanceMicro;
      if (!opt.inSession && hold > have) return no("E_WALLET_INSUFFICIENT", { message: `the float "${c.sub}" holds ${usd(have)}; this needs ${usd(hold)}`, detail: { subAccount: c.sub, balance: have / 1e6, needs: hold / 1e6 } });
    }
    // inside an open session the deposit was the thing the owner (or the pin) cleared: a voucher within it asks nobody
    if (opt.inSession) return null;
    // the owner
    const hash = offerHash(c.who.hash, c.host, o);
    if (c.released) {
      if (c.released.actionHash !== hash) return no("E_ACCOUNT_REQUOTE", { venue: c.host, message: `what ${c.host} asks changed while the card waited: the approval was for something else`, detail: { card: c.released.id } });
      if (pinned === undefined) this.pin(c, o);
      return null;
    }
    if (opt.noCard || (pinned !== undefined && !v.card)) return null;
    const first = pinned === undefined;
    const session = o.depositMicro !== undefined;
    const offer: CardOffer = { payee: c.host, payTo: o.payTo.toLowerCase(), amount: `${unmicro(o.amountMicro)} USDC${session ? " a call" : ""}`, protocol: LABEL[o.protocol] ?? o.protocol, network: o.network, ...(session ? { deposit: `up to ${unmicro(o.depositMicro!)} USDC, locked when the session opens; what is not used comes back`, escrow: (o.escrow ?? "").toLowerCase() } : {}) };
    const reason = first ? `a first payment to ${c.host}: ${usd(o.amountMicro)}${session ? ` a call, from a deposit of up to ${usd(o.depositMicro!)} locked in escrow ${short(o.escrow ?? "")},` : ""} to ${short(o.payTo)} over ${offer.protocol} (${o.network}). Approving it pins that address for ${c.host}` : (v.card?.reason ?? "needs your OK");
    const card = e.host.raiseCard(c.flight, { account: HUB, intent: { kind: "pay", merchant: c.host, mcc: o.mcc, amountUsd: o.amountMicro / 1e6 }, usd: o.amountMicro / 1e6, reason, why: first ? "payee" : "allowance", action: c.action, actionHash: hash, signer: c.who.signer, expiresAt: iso(c.now + CARD_TTL_MS), offer, approval: spend.id });
    // the card holds its share of the budget while it waits
    e.patchSpend(spend.id, (x) => ({ ...x, reservedMicro: x.reservedMicro + o.amountMicro }));
    e.host.log({ kind: "action", venue: c.host, tool: "agentPay", signer: c.who.signer, envelope: c.who.envelope, outcome: "card", notionalUsd: o.amountMicro / 1e6, reason, flight: c.flight, agent: slug(c.who.agent.name), intentId: card.id, detail: offer });
    return { ok: true, kind: "card", pending: true, card, flight: c.flight };
  }

  /** a payee is pinned by its host: the address the floats pay it at */
  private pinKey(c: Ctx): string {
    return c.host;
  }

  /** what a ledger row carries as proof: the agent's own signed envelope — or, when a card released it, the card, whose rows hold the agent's envelope and the owner's */
  private evidence(c: Ctx): { envelope: Envelope } | { intentId: string } {
    return c.released ? { intentId: c.released.id } : { envelope: c.who.envelope };
  }

  private pin(c: Ctx, o: Offer): void {
    const e = this.engine;
    e.patchSpend(c.spendId, (x) => ({ ...x, payTo: { ...x.payTo, [this.pinKey(c)]: o.payTo.toLowerCase() } }));
    if (!e.state.payees.includes(c.host)) e.state = { ...e.state, payees: [...e.state.payees, c.host] };
  }

  /** Hyperliquid's builder fee: `f` tenths of a basis point of the payment, to the app that brought it — only inside a rate the owner approved for that app */
  private fee(c: Ctx, o: Offer): number | Refusal {
    const b = c.action.builder;
    if (!b) return 0;
    if (!c.sub) return no("E_ACCOUNT_BAD_ACTION", { message: "an app's fee is paid from a float" });
    const approval = this.engine.state.fees.find((f) => f.builder === String(b.b).toLowerCase());
    const rate = Number(b.f) / 100_000;
    if (!Number.isInteger(b.f) || b.f < 0) return no("E_ACCOUNT_BAD_ACTION", { message: "a builder fee is a whole number of tenths of a basis point" });
    if (!approval) return no("E_ACCOUNT_FEE_CAP", { message: `the owner has approved no fee for ${short(String(b.b))}`, detail: { builder: b.b } });
    if (rate > approval.maxFeeRate) return no("E_ACCOUNT_FEE_CAP", { message: `${short(String(b.b))} asks ${(rate * 100).toFixed(3)}%; the owner approved ${(approval.maxFeeRate * 100).toFixed(3)}% at most`, detail: { builder: b.b, asked: rate, approved: approval.maxFeeRate } });
    return Math.round(o.amountMicro * rate);
  }

  /** write a payment that happened into the account: the payments list, the approval's budget, the payee's record, the ledger, the flight */
  private book(c: Ctx, o: Offer, r: { ref: string; native: unknown; data?: unknown; note?: string | undefined }): Outcome {
    const e = this.engine;
    const at = e.host.now();
    let feeMicro = 0;
    const fee = this.fee(c, o);
    if (c.sub && typeof fee === "number" && fee > 0 && this.world.chain.transfer(this.float(c).address, c.action.builder!.b, fee, "builder fee")) feeMicro = fee;
    const leg: PaymentLeg = { step: "out", venue: HUB, rail: o.protocol, protocol: LABEL[o.protocol] ?? o.protocol, token: "USDC", chain: o.network, feeUsd: feeMicro / 1e6, etaSec: 0, access: "agent", final: true, status: "settled", startedAt: at, settlesAt: at, ref: r.ref, native: r.native };
    const p: Payment = { id: e.nextPaymentId(), kind: "pay", at, from: `sub:${c.sub}`, to: c.host, external: { label: c.host, address: o.payTo.toLowerCase(), chain: o.network }, sourceToken: leg.token, token: leg.token, amountUsd: o.amountMicro / 1e6, feeUsd: feeMicro / 1e6, receiveUsd: o.amountMicro / 1e6, legs: [leg], status: "settled", settlesAt: at, settledAt: at, signer: c.who.signer, authority: "agent", agent: c.who.agent.address, flight: c.flight, action: c.who.hash, approval: c.spendId, protocol: o.protocol, ...(c.released ? { card: c.released.id } : {}), ...(r.note ? { note: r.note } : {}) };
    e.payments.unshift(p);
    e.patchSpend(c.spendId, (x) => ({ ...x, spentMicro: x.spentMicro + o.amountMicro + feeMicro, last: { ...x.last, [c.host]: c.now } }));
    this.met(c.host, o, o.amountMicro, at);
    const words = `${usd(o.amountMicro)} to ${c.host} · ${leg.protocol} · from float "${c.sub}"${feeMicro ? ` · app fee ${usd(feeMicro)}` : ""}`;
    e.host.log({ kind: "action", venue: c.host, tool: "agentPay", signer: c.who.signer, ...this.evidence(c), outcome: "accepted", notionalUsd: p.amountUsd, reason: `${p.id} · ${words}`, payment: p.id, flight: c.flight, agent: slug(c.who.agent.name), venueOrderId: r.ref, native: r.native });
    e.host.say(c.flight, r.note ? `Paid ${words}, but ${r.note}` : `Paid ${words}`, r.note ? "no" : "ok", { usd: p.amountUsd, account: leg.venue });
    return { ok: true, kind: "payment", payment: p, flight: c.flight, ...(r.data !== undefined ? { data: r.data } : {}) };
  }

  private met(host: string, o: Offer, paidMicro: number, at: string): void {
    const m = this.paid.get(host) ?? { protocol: o.protocol, payTo: o.payTo.toLowerCase(), micro: 0, payments: 0, lastAt: at };
    this.paid.set(host, { protocol: o.protocol, payTo: o.payTo.toLowerCase(), micro: m.micro + paidMicro, payments: m.payments + 1, lastAt: at });
  }

  // ---- x402 -------------------------------------------------------------------------------------

  private async x402(c: Ctx, first: SimResponse): Promise<Outcome> {
    const required = X.unb64json<X.X402Required>(first.headers["payment-required"] ?? "");
    if (!required || required.x402Version !== 2 || !Array.isArray(required.accepts)) return no("E_PAYEE_UNVERIFIED", { venue: c.host, message: `${c.host} sent a PAYMENT-REQUIRED header that is not an x402 V2 offer` });
    const named = hostOf(required.resource?.url);
    // who is being paid is read from the payee's own offer, and it has to be the host that was asked
    if (named !== c.host) return no("E_PAYEE_UNVERIFIED", { venue: c.host, message: `${c.host}'s offer is for a resource at "${named || "?"}": it is not paid`, detail: { resource: required.resource?.url } });
    if (!c.sub) return no("E_PAYEE_UNSUPPORTED", { venue: c.host, message: `${c.host} is paid in USDC: name the float that pays` });
    const accepted = required.accepts.find((a) => a.scheme === "exact" && a.network === CHAIN.network && sameAddress(a.asset, CHAIN.asset) && a.extra?.name === CHAIN.name && a.extra?.version === CHAIN.version && (a.extra.assetTransferMethod ?? "eip3009") === "eip3009");
    if (!accepted) return no("E_PAYEE_UNSUPPORTED", { venue: c.host, message: `${c.host} offers ${required.accepts.map((a) => `${a.scheme} on ${a.network}`).join(", ") || "nothing"}; this account pays "exact" in USDC on ${CHAIN.network}`, detail: { accepts: required.accepts.map((a) => ({ scheme: a.scheme, network: a.network, asset: a.asset })) } });
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(accepted.payTo)) || !Number.isInteger(accepted.maxTimeoutSeconds) || accepted.maxTimeoutSeconds < 10) return no("E_PAYEE_UNVERIFIED", { venue: c.host, message: `${c.host}'s offer names no usable receiving address or time limit` });
    const o: Offer = { protocol: "x402", payTo: accepted.payTo, amountMicro: units(accepted.amount), network: NETWORK, mcc: "4816" };
    const stop = this.gate(c, o);
    if (stop) return stop;
    const float = simKey(`sub-account:${c.sub}`);
    const nonce = this.nonce(c);
    const nowSec = Math.floor(c.now / 1000);
    const payload = await X.x402Authorize(float, accepted, nowSec, nonce, required.resource, AUTH_TTL_SEC);
    c.handed = { o, from: float.address, nonce, validBefore: Number(payload.payload.authorization.validBefore), native: { protocol: "x402", version: 2, requirements: accepted, payload } };
    const paid = await this.fetch({ method: "GET", url: c.url.href, headers: { "PAYMENT-SIGNATURE": X.b64json(payload) } }, c);
    // what happened is what the ledger says, whatever the payee's answer says
    const moved = this.world.chain.used(float.address, nonce);
    const res = X.unb64json<{ success?: boolean; payer?: string; transaction?: string; network?: string; errorReason?: string }>(paid.headers["payment-response"] ?? "");
    const native = { protocol: "x402", version: 2, requirements: accepted, payload, response: res ?? null };
    if (!moved) {
      const why = res?.errorReason ?? X.unb64json<X.X402Required>(paid.headers["payment-required"] ?? "")?.error;
      const held = this.hold(c, o, float.address, nonce, Number(payload.payload.authorization.validBefore), native);
      // served without settling: the payee may settle afterwards, and the ledger will say so
      if (paid.status === 200) return { ok: true, kind: "result", result: { paid: "not yet", data: paid.body, note: `${c.host} answered before settling: ${held}` }, flight: c.flight };
      return no("E_PAYEE_REJECTED", { venue: c.host, message: `${c.host} did not take the payment${why ? ` (${why})` : paid.status === 0 ? " (no answer)" : ""}: nothing has moved; ${held}`, detail: { status: paid.status, ...(why ? { error: why } : {}), outstandingUntil: iso(Number(payload.payload.authorization.validBefore) * 1000) } });
    }
    const tx = this.world.chain.tx(res?.transaction);
    const good = paid.status === 200 && res?.success === true && sameAddress(res.payer, float.address) && res.network === CHAIN.network && !!tx && tx.to === accepted.payTo.toLowerCase() && tx.value === o.amountMicro;
    if (!good) {
      const booked = this.book(c, o, { ref: tx && typeof res?.transaction === "string" ? res.transaction : nonce, native, note: `${c.host} took the payment and sent no valid receipt` });
      return no("E_PAYEE_UNVERIFIED", { venue: c.host, message: `${c.host} took ${usd(o.amountMicro)} and sent no valid receipt: the payment is on the ledger, and this payee should not be paid again`, detail: { paid: true, payment: !isRefusal(booked) && booked.kind === "payment" ? booked.payment.id : undefined } });
    }
    return this.book(c, o, { ref: String(res!.transaction), native, data: paid.body });
  }

  // ---- MPP --------------------------------------------------------------------------------------

  private async mpp(c: Ctx, first: SimResponse): Promise<Outcome> {
    const ch = X.mppParse(first.headers["www-authenticate"]);
    if (!ch) return no("E_PAYEE_UNVERIFIED", { venue: c.host, message: `${c.host} sent a Payment challenge that does not parse` });
    if (ch.realm !== c.host) return no("E_PAYEE_UNVERIFIED", { venue: c.host, message: `${c.host}'s challenge is for the realm "${ch.realm}": it is not paid`, detail: { realm: ch.realm } });
    if (ch.expires !== undefined && Date.parse(ch.expires) <= c.now) return no("E_PAYEE_UNVERIFIED", { venue: c.host, message: `${c.host}'s challenge has already expired` });
    if (ch.method !== "evm" || (ch.intent !== "charge" && ch.intent !== "session")) return no("E_PAYEE_UNSUPPORTED", { venue: c.host, message: `${c.host} asks for "${ch.method}" / "${ch.intent}"; this account pays the "evm" method, as a charge or a session`, detail: { method: ch.method, intent: ch.intent } });
    if (!c.sub) return no("E_PAYEE_UNSUPPORTED", { venue: c.host, message: `${c.host} is paid in USDC: name the float that pays` });
    const req = X.unjcs64<X.MppChargeRequest & X.MppSessionRequest>(ch.request);
    if (!req || !sameAddress(req.currency, CHAIN.asset) || req.methodDetails?.chainId !== CHAIN.chainId || !/^0x[0-9a-fA-F]{40}$/.test(req.recipient ?? "")) return no("E_PAYEE_UNSUPPORTED", { venue: c.host, message: `${c.host} asks for a token or a chain this account does not pay in`, detail: { currency: req?.currency, chainId: req?.methodDetails?.chainId } });
    return ch.intent === "charge" ? this.charge(c, ch, req) : this.voucher(c, ch, req);
  }

  private async charge(c: Ctx, ch: X.MppChallenge, req: X.MppChargeRequest): Promise<Outcome> {
    const o: Offer = { protocol: "mpp-charge", payTo: req.recipient, amountMicro: units(req.amount), network: NETWORK, mcc: "4816" };
    const stop = this.gate(c, o);
    if (stop) return stop;
    const float = simKey(`sub-account:${c.sub}`);
    // the authorisation's nonce commits to the challenge: it cannot be lifted into another one
    const authorization: X.Eip3009 = { from: float.address, to: req.recipient, value: req.amount, validAfter: "0", validBefore: String(Math.floor(c.now / 1000) + AUTH_TTL_SEC), nonce: X.mppChargeNonce(ch) };
    const credential: X.MppCredential = { challenge: ch, source: `did:pkh:${CHAIN.network}:${float.address}`, payload: { type: "authorization", authorization, signature: await X.eip3009Sign(float, TERMS, authorization) } };
    c.handed = { o, from: float.address, nonce: authorization.nonce, validBefore: Number(authorization.validBefore), native: { protocol: "mpp", intent: "charge", challenge: ch, request: req, credential } };
    const paid = await this.fetch({ method: "GET", url: c.url.href, headers: { Authorization: X.mppAuthorization(credential) } }, c);
    const receipt = X.unjcs64<X.MppReceipt>(paid.headers["payment-receipt"] ?? "");
    const tx = this.world.chain.tx(receipt?.reference);
    const moved = this.world.chain.used(float.address, authorization.nonce);
    const native = { protocol: "mpp", intent: "charge", challenge: ch, request: req, credential, receipt: receipt ?? null };
    if (!moved) return no("E_PAYEE_REJECTED", { venue: c.host, message: `${c.host} did not take the payment (${(paid.body as { title?: string } | undefined)?.title ?? paid.status}): nothing has moved; ${this.hold(c, o, float.address, authorization.nonce, Number(authorization.validBefore), native)}`, detail: { status: paid.status, problem: paid.body } });
    const good = paid.status === 200 && receipt?.status === "success" && !!tx && tx.from === float.address && tx.to === req.recipient.toLowerCase() && tx.value === o.amountMicro;
    if (!good) {
      this.book(c, o, { ref: authorization.nonce, native, note: `${c.host} took the payment and sent no valid receipt` });
      return no("E_PAYEE_UNVERIFIED", { venue: c.host, message: `${c.host} took ${usd(o.amountMicro)} and sent no valid receipt: the payment is on the ledger`, detail: { paid: true } });
    }
    return this.book(c, o, { ref: String(receipt!.reference), native, data: paid.body });
  }

  /** one call inside a session: the first opens the channel with a deposit, every one signs a voucher for the new running total */
  private async voucher(c: Ctx, ch: X.MppChallenge, req: X.MppSessionRequest): Promise<Outcome> {
    const e = this.engine;
    const escrow = this.world.escrow;
    // a deposit goes only into an escrow contract the account already knows: the payee names it, the payee does not choose it
    if (!sameAddress(req.methodDetails.escrowContract, escrow.address)) return no("E_PAYEE_UNVERIFIED", { venue: c.host, message: `${c.host} names an escrow contract this account does not know (${short(req.methodDetails.escrowContract ?? "?")}): no deposit goes into it`, detail: { escrow: req.methodDetails.escrowContract } });
    if (c.action.builder) return no("E_ACCOUNT_BAD_ACTION", { message: "an app's fee rides on a single payment, not on a session's vouchers" });
    const price = units(req.amount);
    const o: Offer = { protocol: "mpp-session", payTo: req.recipient, amountMicro: price, network: NETWORK, mcc: "4816" };
    const float = simKey(`sub-account:${c.sub}`);
    const open = this.sessions.find((s) => s.host === c.host && s.sub === c.sub && s.status === "open");
    const send = async (payload: Record<string, unknown>) => {
      const res = await this.fetch({ method: "GET", url: c.url.href, headers: { Authorization: X.mppAuthorization({ challenge: ch, source: `did:pkh:${CHAIN.network}:${float.address}`, payload }) } }, c);
      return { res, receipt: X.unjcs64<X.MppReceipt>(res.headers["payment-receipt"] ?? "") };
    };
    const refused = (res: SimResponse) => no("E_PAYEE_REJECTED", { venue: c.host, message: `${c.host} did not accept it (${(res.body as { title?: string } | undefined)?.title ?? (res.status === 0 ? "no answer" : res.status)})`, detail: { status: res.status, problem: res.body } });

    // the payee may have closed the channel itself, and time may have passed
    this.tick(c.now);
    if (open && open.status !== "open") return this.voucher(c, ch, req);
    if (open && open.spend !== c.spendId) return no("E_MANDATE_EXPIRED", { venue: c.host, message: `the session at ${c.host} was opened under a spending approval the owner has since replaced: close it, and the next call opens one under the approval that stands`, detail: { session: open.id, approval: open.spend } });
    if (open) {
      const next = open.cumulative + price;
      if (next > open.deposit) return no("E_WALLET_INSUFFICIENT", { message: `the session at ${c.host} has used ${usd(open.cumulative)} of its ${usd(open.deposit)} deposit: close it, and the next call opens another`, detail: { session: open.id, deposit: open.deposit / 1e6, used: open.cumulative / 1e6 } });
      const stop = this.gate(c, o, { inSession: true });
      if (stop) return stop;
      const signature = await X.mppSignVoucher(float, escrow.address, escrow.chainId, open.id, next);
      const { res, receipt } = await send({ action: "voucher", channelId: open.id, cumulativeAmount: String(next), signature });
      if (res.status !== 200 || receipt?.status !== "success" || receipt.acceptedCumulative !== String(next)) return refused(res);
      Object.assign(open, { cumulative: next, signature, calls: open.calls + 1 });
      // the budget set aside with the deposit becomes spending, one voucher at a time
      e.patchSpend(c.spendId, (x) => ({ ...x, reservedMicro: Math.max(0, x.reservedMicro - price), spentMicro: x.spentMicro + price, last: { ...x.last, [c.host]: c.now } }));
      this.progress(c, open, o, { challenge: ch, voucher: { channelId: open.id, cumulativeAmount: String(next), signature }, receipt });
      return { ok: true, kind: "payment", payment: e.payments.find((p) => p.id === open.payment)!, flight: c.flight, data: res.body };
    }

    // no channel yet: the deposit is the most this payee can ever be owed. It is ONE authorisation — never above the approval's per-payment
    // maximum, never above what is left of the budget or of the float — and the card that asks the owner shows the most the payee wants locked
    const spend = this.spend(c);
    const asked = units(req.suggestedDeposit);
    if (!Number.isInteger(asked) || asked < price) return no("E_PAYEE_UNVERIFIED", { venue: c.host, message: `${c.host} asks for a deposit that is not a number of token units, or is less than one call` });
    const opening: Offer = { ...o, depositMicro: asked, escrow: escrow.address };
    const deposit = Math.min(asked, spend.perPaymentMicro, spend.budgetMicro - spend.spentMicro - spend.reservedMicro, this.float(c).balanceMicro);
    const stop = this.gate(c, opening, { hold: Math.max(deposit, price) });
    if (stop) return stop;
    const salt = this.nonce(c);
    const terms: X.EscrowOpen = { payee: req.recipient.toLowerCase(), token: TOKEN, deposit, salt, authorizedSigner: ZERO };
    const id = X.mppChannelId(float.address, terms.payee, terms.token, salt, ZERO, escrow.address, escrow.chainId);
    const txNonce = this.seq;
    const transaction = await X.mppOpenTx(float, escrow.address, escrow.chainId, terms, txNonce);
    // the channel opens with a voucher for zero: nothing is owed until the first call
    const zero = await X.mppSignVoucher(float, escrow.address, escrow.chainId, id, 0);
    const { res } = await send({ action: "open", type: "transaction", channelId: id, transaction, cumulativeAmount: "0", signature: zero });
    if (!escrow.channels.get(id)) {
      // the payee holds a signed transaction it did not use. It is cancelled — the float's key spends that transaction's nonce — so it cannot be
      // broadcast tomorrow into a channel nobody is watching
      this.world.chain.spendTxNonce(float.address, txNonce);
      e.host.log({ kind: "payment", venue: c.host, tool: "escrow.open cancelled", outcome: "cancelled", reason: `${c.host} did not open the session; the opening transaction it was handed is cancelled (its nonce is spent)`, flight: c.flight, agent: slug(c.who.agent.name), native: { channelId: id, nonce: txNonce } });
      return refused(res);
    }
    // the channel is on the ledger: from here the deposit is in escrow whatever the payee says next
    const at = e.host.now();
    const leg: PaymentLeg = { step: "out", venue: HUB, rail: o.protocol, protocol: LABEL[o.protocol]!, token: "USDC", chain: NETWORK, feeUsd: 0, etaSec: 0, access: "agent", final: false, status: "pending", startedAt: at, ref: id, native: { protocol: "mpp", intent: "session", challenge: ch, request: req, open: { channelId: id, transaction, deposit: String(deposit) } } };
    const p: Payment = { id: e.nextPaymentId(), kind: "pay", at, from: `sub:${c.sub}`, to: c.host, external: { label: c.host, address: terms.payee, chain: NETWORK }, sourceToken: "USDC", token: "USDC", amountUsd: deposit / 1e6, feeUsd: 0, receiveUsd: 0, legs: [leg], status: "pending", settlesAt: at, signer: c.who.signer, authority: "agent", agent: c.who.agent.address, flight: c.flight, action: c.who.hash, approval: c.spendId, protocol: o.protocol, heldUsd: deposit / 1e6, ...(c.released ? { card: c.released.id } : {}) };
    e.payments.unshift(p);
    this.sessions.push({ id, host: c.host, url: c.url.href, sub: c.sub!, agent: c.who.signer, spend: c.spendId, payment: p.id, deposit, cumulative: 0, signature: zero, calls: 0, status: "open", openedAt: at });
    e.patchSpend(c.spendId, (x) => ({ ...x, reservedMicro: x.reservedMicro + deposit }));
    e.host.log({ kind: "action", venue: c.host, tool: "agentPay", signer: c.who.signer, ...this.evidence(c), outcome: "accepted", notionalUsd: 0, reason: `${p.id} · session opened at ${c.host}: ${usd(deposit)} from float "${c.sub}" into escrow ${short(escrow.address)} · ${usd(price)} a call`, payment: p.id, flight: c.flight, agent: slug(c.who.agent.name), venueOrderId: id, native: leg.native });
    e.host.say(c.flight, `Opened a session at ${c.host}: ${usd(deposit)} of float "${c.sub}" is in escrow, ${usd(price)} a call. What is not used comes back when it closes`, "note");
    if (res.status !== 200) return refused(res);
    // the call itself: a fresh challenge, and the first voucher on the channel that is now open
    const next = await this.fetch({ method: "GET", url: c.url.href }, c);
    if (next.status !== 402 || !next.headers["www-authenticate"]) return refused(next);
    return this.mpp(c, next);
  }

  /** a voucher was accepted: the session's one payment row moves on, and the call is a line on the ledger */
  private progress(c: Ctx, s: Session, o: Offer, native: unknown): void {
    const e = this.engine;
    const p = e.payments.find((x) => x.id === s.payment);
    if (p) Object.assign(p, { receiveUsd: s.cumulative / 1e6, heldUsd: (s.deposit - s.cumulative) / 1e6, note: `${s.calls} call${s.calls === 1 ? "" : "s"} · ${usd(s.cumulative)} of a ${usd(s.deposit)} deposit used` });
    this.met(c.host, o, o.amountMicro, e.host.now());
    // a voucher is an instruction of the agent's like any other: on the ledger with the envelope that asked, and counted in the day's figure
    e.host.log({ kind: "action", venue: c.host, tool: "mpp voucher", signer: c.who.signer, ...this.evidence(c), outcome: "accepted", payment: s.payment, notionalUsd: o.amountMicro / 1e6, reason: `${s.payment} · call ${s.calls} at ${c.host}: the voucher now says ${usd(s.cumulative)} of ${usd(s.deposit)}`, flight: c.flight, agent: slug(c.who.agent.name), native });
    e.host.say(c.flight, `Paid ${usd(o.amountMicro)} to ${c.host} · session voucher ${s.calls} · ${usd(s.cumulative)} of ${usd(s.deposit)} used`, "ok", { usd: o.amountMicro / 1e6, account: HUB });
  }

  /** end a session: the payee is asked to close (it takes what the last voucher says, the escrow sends the rest back). If it does not answer, the
   * deposit is asked back from the escrow itself, and comes home after the grace period. */
  private async close(c: Ctx): Promise<Outcome> {
    const e = this.engine;
    this.tick(c.now);
    const s = this.sessions.find((x) => x.host === c.host && x.sub === c.sub && (x.status === "open" || x.status === "closing"));
    if (!s) return no("E_ACCOUNT_BAD_ACTION", { message: `there is no open session at ${c.host} for "${c.action.fromSubAccount}"` });
    const body = await this.closeSession(s, c.now, c.flight);
    e.host.log({ kind: "action", venue: c.host, tool: "mpp close", signer: c.who.signer, ...this.evidence(c), outcome: s.status, payment: s.payment, reason: `${s.payment} · ${c.who.agent.name} asked for the session at ${c.host} to be closed`, flight: c.flight, agent: slug(c.who.agent.name) });
    return { ok: true, kind: "payment", payment: e.payments.find((x) => x.id === s.payment)!, flight: c.flight, ...(body !== undefined ? { data: body } : {}) };
  }

  /** The owner closes a session itself: the agent that opened it may be gone (its key revoked, its approval withdrawn), and the deposit is the owner's. */
  async closeByOwner(id: string): Promise<Refusal | { ok: true; summary: string }> {
    const now = this.engine.nowMs();
    this.tick(now);
    const s = this.sessions.find((x) => (x.id === id || x.host === id) && (x.status === "open" || x.status === "closing"));
    if (!s) return no("E_ACCOUNT_BAD_ACTION", { message: `there is no open session "${id}"` });
    await this.closeSession(s, now, undefined);
    return { ok: true, summary: s.note ?? `the session at ${s.host} is ${s.status}` };
  }

  /** End a session: the payee is asked to close (it takes what the last voucher says, the escrow sends the rest back). If it does not, the deposit
   * is asked back from the escrow itself, and comes home after the grace period. */
  private async closeSession(s: Session, now: number, flight: string | undefined): Promise<unknown> {
    const e = this.engine;
    if (s.status !== "open") return undefined;
    const p = e.payments.find((x) => x.id === s.payment)!;
    const float = simKey(`sub-account:${s.sub}`);
    const escrow = this.world.escrow;
    const first = await this.world.fetch({ method: "GET", url: s.url }, now);
    const ch = first.status === 402 ? X.mppParse(first.headers["www-authenticate"]) : null;
    if (ch && ch.realm === s.host) {
      const res = await this.world.fetch({ method: "GET", url: s.url, headers: { Authorization: X.mppAuthorization({ challenge: ch, source: `did:pkh:${CHAIN.network}:${float.address}`, payload: { action: "close", channelId: s.id, cumulativeAmount: String(s.cumulative), signature: s.signature } }) } }, now);
      const receipt = X.unjcs64<X.MppReceipt>(res.headers["payment-receipt"] ?? "");
      const chan = escrow.channels.get(s.id);
      if (chan?.finalized) {
        this.finish(s, chan.settled, "closed", `session closed: ${usd(chan.settled)} paid for ${s.calls} call${s.calls === 1 ? "" : "s"}, ${usd(s.deposit - chan.settled)} back in float "${s.sub}"`, { protocol: "mpp", intent: "session", close: { channelId: s.id, cumulativeAmount: String(s.cumulative) }, receipt: receipt ?? null }, flight);
        return res.body;
      }
    }
    // the payee is not helping: ask the escrow itself
    const asked = escrow.requestClose(float.address, s.id, now);
    if (asked) return undefined;
    s.status = "closing";
    s.withdrawAt = now + GRACE_MS + 60_000;
    s.note = `${s.host} did not close the session; the deposit was asked back from the escrow and returns after ${GRACE_MS / 60_000} min`;
    p.note = s.note;
    p.settlesAt = iso(s.withdrawAt);
    e.host.log({ kind: "payment", venue: s.host, tool: "escrow.requestClose", outcome: "closing", payment: p.id, reason: `${p.id} · ${s.note}`, ...(flight ? { flight } : {}), native: { channelId: s.id, withdrawAfter: iso(s.withdrawAt) } });
    if (flight) e.host.say(flight, `${s.host} did not answer. The deposit was asked back from the escrow: ${usd(s.deposit - s.cumulative)} returns ${GRACE_MS / 60_000} minutes from now`, "note");
    return undefined;
  }

  /** what time has settled: an authorisation that was cashed late or has expired unused, and a deposit asked back without the payee */
  tick(nowMs: number): void {
    const still: Outstanding[] = [];
    for (const h of this.outstanding) {
      const cashed = this.world.chain.used(h.from, h.nonce);
      if (!cashed && nowMs / 1000 <= h.validBefore) {
        still.push(h);
        continue;
      }
      this.engine.patchSpend(h.c.spendId, (x) => ({ ...x, reservedMicro: Math.max(0, x.reservedMicro - h.o.amountMicro) }));
      if (cashed) this.book(h.c, h.o, { ref: h.nonce, native: h.native, note: `${h.c.host} settled this after answering that the payment had failed` });
      else this.engine.host.log({ kind: "payment", venue: h.c.host, tool: "authorisation expired", outcome: "expired", notionalUsd: h.o.amountMicro / 1e6, reason: `the authorisation ${h.c.host} was handed for ${usd(h.o.amountMicro)} expired unused: nothing moved, and its amount is free again`, flight: h.c.flight });
    }
    this.outstanding = still;
    // a channel the payee closed by itself: what it took is what its last voucher said, and the rest is back in the float already
    for (const s of this.sessions) {
      const chan = this.world.escrow.channels.get(s.id);
      if ((s.status === "open" || s.status === "closing") && chan?.finalized) this.finish(s, chan.settled, "closed", `${s.host} closed the session itself: ${usd(chan.settled)} paid for ${s.calls} call${s.calls === 1 ? "" : "s"}, ${usd(s.deposit - chan.settled)} back in float "${s.sub}"`, { channelId: s.id, closedBy: "payee" }, undefined);
    }
    for (const s of this.sessions) {
      if (s.status !== "closing" || s.withdrawAt === undefined || nowMs < s.withdrawAt) continue;
      const float = simKey(`sub-account:${s.sub}`);
      const out = this.world.escrow.withdraw(float.address, s.id, nowMs);
      const chan = this.world.escrow.channels.get(s.id);
      if (typeof out === "string" || !chan) continue;
      this.finish(s, chan.settled, "withdrawn", `withdrawn from the escrow after the grace period: ${usd(chan.settled)} was collected by ${s.host}, ${usd(out.refund)} is back in float "${s.sub}"`, { channelId: s.id, withdraw: out.tx }, undefined);
    }
  }

  private finish(s: Session, paidMicro: number, status: "closed" | "withdrawn", note: string, native: unknown, flight: string | undefined): void {
    const e = this.engine;
    const at = e.host.now();
    s.status = status;
    s.note = note;
    const p = e.payments.find((x) => x.id === s.payment);
    if (p) {
      Object.assign(p, { status: "settled", amountUsd: paidMicro / 1e6, receiveUsd: paidMicro / 1e6, settledAt: at, settlesAt: at, note });
      delete p.heldUsd;
      const leg = p.legs[0]!;
      Object.assign(leg, { status: "settled", settlesAt: at, final: true });
    }
    // what was set aside and not used is free again; a voucher the payee never collected was never spent
    e.patchSpend(s.spend, (x) => ({ ...x, reservedMicro: Math.max(0, x.reservedMicro - (s.deposit - s.cumulative)), spentMicro: x.spentMicro - (s.cumulative - paidMicro) }));
    const met = this.paid.get(s.host);
    if (met) this.paid.set(s.host, { ...met, micro: met.micro - (s.cumulative - paidMicro) });
    e.host.log({ kind: "payment", venue: s.host, tool: status === "closed" ? "escrow.close" : "escrow.withdraw", outcome: "settled", payment: s.payment, notionalUsd: paidMicro / 1e6, reason: `${s.payment} · ${note}`, native, ...(flight ? { flight } : {}) });
    if (flight) e.host.say(flight, note[0]!.toUpperCase() + note.slice(1), "ok", { usd: paidMicro / 1e6, account: HUB });
  }

  // ---- AP2: from a float, with the agent's own signature on what it commits to ---------------------------

  private async ap2(c: Ctx, page: ShopPage): Promise<Outcome> {
    const ap2 = page.checkout.ap2;
    if (!ap2) return no("E_PAYEE_UNSUPPORTED", { venue: c.host, message: `${c.host} takes no AP2 checkout: a float cannot pay here` });
    if (hostOf(ap2.checkouts) !== c.host) return no("E_PAYEE_REDIRECT", { venue: c.host, message: `${c.host}'s checkout lives at another host: not followed`, detail: { checkouts: ap2.checkouts } });
    if (!sameAddress(ap2.settles.asset, CHAIN.asset) || ap2.settles.network !== CHAIN.network || ap2.settles.scheme !== "exact") return no("E_PAYEE_UNSUPPORTED", { venue: c.host, message: `${c.host} settles in a token or on a chain this account does not pay in` });
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(ap2.settles.payTo))) return no("E_PAYEE_UNVERIFIED", { venue: c.host, message: `${c.host} names no usable receiving address` });
    const o: Offer = { protocol: "ap2", payTo: ap2.settles.payTo, amountMicro: minor(page.item?.price?.amount) * 10_000, network: NETWORK, mcc: "5968" };
    const key = `${c.who.signer}|${c.url.href}`;
    let pend = this.pending.get(key);
    if (pend && (pend.spend !== c.spendId || c.now >= pend.expiresAt || pend.amountMicro !== o.amountMicro || !sameAddress(pend.requirements.payTo, o.payTo))) {
      this.pending.delete(key);
      pend = undefined;
    }
    if (!pend && c.action.mandates) return no("E_ACCOUNT_BAD_ACTION", { message: `no checkout at ${c.host} is waiting for these mandates (it expired, or its terms changed): ask again without them` });
    if (!pend && !isJwk(c.action.cnf)) return no("E_ACCOUNT_BAD_ACTION", { message: "an AP2 checkout needs the agent's own P-256 key (`cnf`): the closed mandates are signed with it" });
    // the owner is asked when a checkout is first made; the step that completes it is the same checkout, bound to it below
    const stop = this.gate(c, o, { noCard: pend !== undefined });
    if (stop) return stop;
    const nowSec = Math.floor(c.now / 1000);
    const spend = this.spend(c);

    if (!pend) {
      const cnf = c.action.cnf!;
      const made = await this.fetch({ method: "POST", url: ap2.checkouts, body: { items: [{ id: page.item.id, quantity: 1 }] } }, c);
      const b = made.body as { id?: string; checkout_jwt?: string; nonce?: string } | undefined;
      const jws = X.jwsParse(b?.checkout_jwt ?? "");
      // the total and the payee are read from the checkout the MERCHANT signed, and they must be what its page said
      if (made.status !== 201 || !b?.id || !b.nonce || !jws || !X.jwsVerify(jws, page.merchant.jwk)) return no("E_PAYEE_UNVERIFIED", { venue: c.host, message: `${c.host}'s checkout is not signed by the merchant key its page names` });
      const total = (jws.payload.totals as Array<{ type: string; amount: number }> | undefined)?.find((t) => t.type === "total")?.amount;
      if (total !== page.item.price.amount || (jws.payload.merchant as { id?: string } | undefined)?.id !== page.merchant.id) return no("E_PAYEE_OVERCHARGE", { venue: c.host, message: `${c.host}'s signed checkout totals $${((total ?? 0) / 100).toFixed(2)}; its page said $${(page.item.price.amount / 100).toFixed(2)}`, detail: { page: page.item.price.amount, checkout: total } });
      const merchant = { id: page.merchant.id, name: page.merchant.name, website: page.merchant.website };
      const exp = Math.min(Math.floor(spend.validUntil / 1000), nowSec + 900);
      const issuer = { key: ISSUER.p256, kid: ISSUER.kid };
      // the owner's spending approval, said again as two OPEN mandates a merchant and a credential provider can check for themselves
      const openCheckout = X.ap2Open("checkout", [{ type: "checkout.allowed_merchants", allowed: [merchant] }, { type: "checkout.line_items", items: [{ id: "line_1", acceptable_items: [{ id: page.item.id, title: page.item.title }], quantity: 1 }] }], cnf, nowSec, exp, issuer);
      const openPayment = X.ap2Open("payment", [{ type: "payment.amount_range", currency: "USD", min: 0, max: Math.floor(spend.perPaymentMicro / 10_000) }, { type: "payment.budget", currency: "USD", max: Math.floor(spend.budgetMicro / 10_000) }, { type: "payment.allowed_payees", allowed: [merchant] }, { type: "payment.reference", conditional_transaction_id: X.ap2MandateHash(openCheckout) }], cnf, nowSec, exp, issuer);
      const float = this.float(c);
      pend = {
        spend: c.spendId,
        needs: { needs: "mandates", protocol: "ap2", checkout: { id: b.id, jwt: b.checkout_jwt!, hash: X.ap2CheckoutHash(b.checkout_jwt!), total: { amount: total, currency: "USD" }, merchant }, open: { checkout: openCheckout, payment: openPayment }, sign: { checkout: { aud: "merchant", nonce: b.nonce }, payment: { aud: CP_AUD, nonce: this.nonce(c).slice(2, 34) } }, instrument: { id: `float:${float.name}`, type: "stablecoin", description: `USDC float "${float.name}" ${short(float.address)}` } },
        merchantNonce: b.nonce,
        requirements: { ...ap2.settles, amount: String(o.amountMicro) },
        amountMicro: o.amountMicro,
        expiresAt: exp * 1000,
      };
      this.pending.set(key, pend);
    }
    const m = c.action.mandates;
    if (!m) {
      this.engine.host.say(c.flight, `${c.host} asks for AP2 mandates: the agent signs "this checkout" and "this payment" with its own key, then asks again`, "note");
      return { ok: true, kind: "result", result: pend.needs, flight: c.flight };
    }

    // the account is the credential provider: the payment mandate is its to verify before any credential leaves
    const n = pend.needs;
    const paymentChain = X.ap2Chain(n.open.payment, m.payment);
    const v = X.ap2Verify(paymentChain, "payment", { issuers: [ISSUER.jwk], aud: CP_AUD, nonce: n.sign.payment.nonce, nowSec, spentMinor: Math.round(spend.spentMicro / 10_000), reference: X.ap2MandateHash(n.open.checkout) });
    if (!v.ok) return no(v.error === "invalid_credential" ? "E_ACCOUNT_BAD_SIGNATURE" : "E_MANDATE_INVALID", { message: `the payment mandate does not hold: ${v.description}`, detail: { ap2: v.error } });
    const amount = v.closed.payment_amount as { amount?: number; currency?: string } | undefined;
    if (v.closed.transaction_id !== n.checkout.hash || (v.closed.payee as { id?: string } | undefined)?.id !== n.checkout.merchant.id || amount?.amount !== n.checkout.total.amount || amount.currency !== n.checkout.total.currency) return no("E_MANDATE_INVALID", { message: "the payment mandate is for another checkout, another payee or another amount than the merchant signed", detail: { checkout: n.checkout.id } });
    const float = simKey(`sub-account:${c.sub}`);
    const nonce = this.nonce(c);
    const credential = await X.x402Authorize(float, pend.requirements, nowSec, nonce, undefined, AUTH_TTL_SEC);
    c.handed = { o, from: float.address, nonce, validBefore: Number(credential.payload.authorization.validBefore), native: { protocol: "ap2", version: "0.2", checkout: { id: n.checkout.id, hash: n.checkout.hash, total: n.checkout.total }, credential } };
    const done = await this.fetch({ method: "POST", url: `${ap2.checkouts}/${n.checkout.id}/complete`, body: { checkout_mandate: X.ap2Chain(n.open.checkout, m.checkout), payment_mandate: paymentChain, payment_credential: credential } }, c);
    const b = (done.body !== null && typeof done.body === "object" ? done.body : {}) as { order?: { id: string; permalink_url: string }; checkout_receipt?: unknown; payment_receipt?: unknown };
    const receipt = (jwt: unknown, jwk: Jwk) => {
      const j = typeof jwt === "string" ? X.jwsParse(jwt) : null;
      return j && X.jwsVerify(j, jwk) ? j.payload : undefined;
    };
    const checkoutReceipt = receipt(b?.checkout_receipt, page.merchant.jwk);
    const paymentReceipt = receipt(b?.payment_receipt, page.merchant.processor_jwk);
    const moved = this.world.chain.used(float.address, nonce);
    const native = { protocol: "ap2", version: "0.2", checkout: { id: n.checkout.id, hash: n.checkout.hash, total: n.checkout.total }, mandates: { checkout: X.ap2Chain(n.open.checkout, m.checkout), payment: paymentChain }, credential, receipts: { checkout: checkoutReceipt ?? null, payment: paymentReceipt ?? null } };
    if (!moved) return no("E_PAYEE_REJECTED", { venue: c.host, message: `${c.host} did not take the checkout (${String(checkoutReceipt?.error ?? done.status)}${checkoutReceipt?.error_description ? `: ${String(checkoutReceipt.error_description)}` : ""}): nothing has moved; ${this.hold(c, o, float.address, nonce, Number(credential.payload.authorization.validBefore), native)}`, detail: { status: done.status, receipt: checkoutReceipt ?? null } });
    this.pending.delete(key);
    const good = done.status === 200 && checkoutReceipt?.status === "Success" && paymentReceipt?.status === "Success" && checkoutReceipt.reference === X.ap2MandateHash(m.checkout) && paymentReceipt.reference === X.ap2MandateHash(m.payment) && !!b?.order;
    if (!good) {
      this.book(c, o, { ref: nonce, native, note: `${c.host} took the payment and its receipts do not verify` });
      return no("E_PAYEE_UNVERIFIED", { venue: c.host, message: `${c.host} took ${usd(o.amountMicro)} and its receipts do not verify: the payment is on the ledger`, detail: { paid: true } });
    }
    return this.book(c, o, { ref: String(paymentReceipt.network_confirmation_id), native, data: { order: b.order, item: page.item } });
  }
}

/** Put the simulated payees on an account. What comes back is the other side of the wire: a test or a demo turns its knobs to play the attacker. */
export function mountPayees(engine: AccountEngine): PayeeWorld {
  const floats: FloatBook = {
    balance: (address) => engine.state.subAccounts.find((s) => s.address === address)?.balanceMicro,
    add: (address, delta) => void (engine.state = { ...engine.state, subAccounts: engine.state.subAccounts.map((s) => (s.address === address ? { ...s, balanceMicro: s.balanceMicro + delta } : s)) }),
  };
  const world = new PayeeWorld(floats);
  engine.usePayer(new SimPayer(engine, world));
  return world;
}

/** the host a redirect points at (a relative one is the payee's own) */
function redirectHost(location: string | undefined, from: string): string | undefined {
  if (!location) return undefined;
  try {
    return new URL(location, from).host;
  } catch {
    return undefined;
  }
}
