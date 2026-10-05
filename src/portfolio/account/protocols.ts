/** The agent-payment protocols, as messages: what goes on the wire and what is signed.
 *
 * Three protocols sit at two layers (the split the industry itself draws):
 *
 *   settlement  x402 V2, `exact` on EVM    HTTP 402 → an EIP-3009 authorisation in PAYMENT-SIGNATURE → the
 *                                          facilitator verifies and settles → PAYMENT-RESPONSE
 *               MPP, the `Payment` HTTP    402 with a `WWW-Authenticate: Payment` challenge whose id is an HMAC
 *               authentication scheme      over its own parameters → `Authorization: Payment` → `Payment-Receipt`.
 *                                          `charge` pays once; `session` deposits once and then signs a
 *                                          cumulative voucher per call
 *   permission  AP2 v0.2                   an OPEN mandate (constraints, the agent's key in `cnf`) and a
 *                                          CLOSED one the agent signs with that key, chained as SD-JWTs
 *
 * This file is the codecs only — pure functions over real signatures (secp256k1 through viem,
 * ES256 through Node). Who the payees are and how the account answers them is payees.ts.
 * Shapes follow the specifications as read on 2026-10-04: coinbase/x402 specs v2 and
 * scheme_exact_evm.md; paymentauth.org draft-httpauth-payment-01, draft-evm-charge-00 and
 * draft-evm-session-00; ap2-protocol.org v0.2. Where a subset was taken, it is said at the
 * function. (ACP, the card-checkout protocol, is not here: a card has no interface an individual
 * can hand an agent.)
 */
import { createHash, createHmac, randomBytes, type KeyObject } from "node:crypto";
import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, encodePacked, keccak256, parseTransaction, recoverTransactionAddress, recoverTypedDataAddress, type Hex } from "viem";
import { canonical } from "../../core/hash.ts";
import { es256Sign, es256Verify, type Jwk, type SimKey } from "./sign.ts";

const b64u = (b: Uint8Array | string): string => Buffer.from(b).toString("base64url");
const unb64u = (s: string): string => Buffer.from(s, "base64url").toString("utf8");
const sha256u = (s: string): string => createHash("sha256").update(s).digest("base64url");

/** x402 carries its JSON in STANDARD base64 */
export const b64json = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64");
export const unb64json = <T>(s: string): T | null => {
  try {
    return JSON.parse(Buffer.from(s, "base64").toString("utf8")) as T;
  } catch {
    return null;
  }
};
/** MPP carries JCS-serialised JSON in base64url without padding */
export const jcs64 = (o: unknown): string => b64u(canonical(o));
export const unjcs64 = <T>(s: string): T | null => {
  try {
    return JSON.parse(unb64u(s)) as T;
  } catch {
    return null;
  }
};

// ---- x402 V2, scheme `exact`, EVM ------------------------------------------------

/** the simulated chain is Base Sepolia's shape: USDC's EIP-712 domain there is {name: "USDC", version: "2"} (it is "USD Coin" on Base) */
export const X402_USDC = { network: "eip155:84532", chainId: 84532, asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", name: "USDC", version: "2" } as const;

export interface X402Requirements {
  scheme: string;
  network: string;
  /** atomic units, as a string */
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  /** the token's EIP-712 domain name and version, and how the asset is moved (`eip3009`; the specification's other methods are not built) */
  extra: { name: string; version: string; assetTransferMethod?: string | undefined };
}

export interface X402Required {
  x402Version: 2;
  error: string;
  resource: { url: string; description: string; mimeType: string };
  accepts: X402Requirements[];
  extensions: Record<string, unknown>;
}

export interface Eip3009 {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
}

export interface X402Payload {
  x402Version: 2;
  resource?: X402Required["resource"] | undefined;
  accepted: X402Requirements;
  payload: { signature: Hex; authorization: Eip3009 };
  extensions?: Record<string, unknown> | undefined;
}

const TRANSFER_WITH_AUTHORIZATION = { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] } as const;
const chainOf = (network: string) => Number(network.split(":")[1]);
const eip3009Data = (r: Pick<X402Requirements, "network" | "asset" | "extra">, a: Eip3009) => ({ domain: { name: r.extra.name, version: r.extra.version, chainId: chainOf(r.network), verifyingContract: r.asset as Hex }, types: TRANSFER_WITH_AUTHORIZATION, primaryType: "TransferWithAuthorization" as const, message: { from: a.from as Hex, to: a.to as Hex, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce } });

/** The payer's side: an EIP-3009 authorisation for exactly `accepted.amount` to exactly `accepted.payTo`, good until the offer's timeout — or
 * sooner, if the payer says so (`ttlSec`): a signed authorisation is a cheque the payee can cash at any time until it expires. */
export async function x402Authorize(payer: SimKey, accepted: X402Requirements, nowSec: number, nonce: Hex, resource?: X402Required["resource"], ttlSec?: number): Promise<X402Payload> {
  const authorization: Eip3009 = { from: payer.address, to: accepted.payTo, value: accepted.amount, validAfter: "0", validBefore: String(nowSec + Math.min(accepted.maxTimeoutSeconds, ttlSec ?? accepted.maxTimeoutSeconds)), nonce };
  const signature = await payer.account.signTypedData(eip3009Data(accepted, authorization));
  return { x402Version: 2, ...(resource ? { resource } : {}), accepted, payload: { signature, authorization } };
}

/** an EIP-3009 authorisation outside x402 (MPP's `authorization` credential): the same typed data, the caller's own nonce */
export const eip3009Sign = (payer: SimKey, r: Pick<X402Requirements, "network" | "asset" | "extra">, a: Eip3009): Promise<Hex> => payer.account.signTypedData(eip3009Data(r, a));

export async function eip3009Signer(r: Pick<X402Requirements, "network" | "asset" | "extra">, a: Eip3009, signature: Hex): Promise<string | null> {
  try {
    return (await recoverTypedDataAddress({ ...eip3009Data(r, a), signature })).toLowerCase();
  } catch {
    return null;
  }
}

/** what a chain would say: a balance, and whether an authorisation's nonce has been spent */
export interface TokenView {
  balance(address: string): number;
  used(authorizer: string, nonce: string): boolean;
}

/** The facilitator's /verify, in the order the reference implementation checks: scheme, extra, network, signature, recipient, the validity
 * window (six seconds of headroom), the exact value, then what a simulation of the transfer would find (balance, nonce).
 * A subset: an EOA's 65-byte signature only — the ERC-1271 / ERC-6492 path for contract wallets is not built. Reason codes are the
 * specification's where it names one (`insufficient_funds`, `invalid_scheme`, `invalid_network`, `invalid_x402_version`, the
 * `invalid_exact_evm_payload_*` family); the rest are this simulation's. */
export async function x402Verify(p: X402Payload, req: X402Requirements, nowSec: number, token: TokenView): Promise<{ isValid: boolean; invalidReason?: string; payer: string }> {
  const a = p?.payload?.authorization;
  const payer = String(a?.from ?? "").toLowerCase();
  const bad = (invalidReason: string) => ({ isValid: false, invalidReason, payer });
  if (p?.x402Version !== 2) return bad("invalid_x402_version");
  if (!a || !p.payload.signature || !p.accepted) return bad("invalid_payload");
  if (p.accepted.scheme !== "exact" || req.scheme !== "exact") return bad("invalid_scheme");
  if (!req.extra?.name || !req.extra?.version) return bad("invalid_payment_requirements");
  if (p.accepted.network !== req.network) return bad("invalid_network");
  if ((await eip3009Signer(req, a, p.payload.signature)) !== payer) return bad("invalid_exact_evm_payload_signature");
  if (a.to.toLowerCase() !== req.payTo.toLowerCase()) return bad("invalid_exact_evm_payload_recipient_mismatch");
  if (!(Number(a.validBefore) >= nowSec + 6)) return bad("invalid_exact_evm_payload_authorization_valid_before");
  if (!(Number(a.validAfter) <= nowSec)) return bad("invalid_exact_evm_payload_authorization_valid_after");
  if (a.value !== req.amount) return bad("invalid_exact_evm_payload_authorization_value_mismatch");
  if (token.balance(payer) < Number(a.value)) return bad("insufficient_funds");
  if (token.used(payer, a.nonce)) return bad("invalid_transaction_state");
  return { isValid: true, payer };
}

// ---- MPP: the "Payment" HTTP authentication scheme -----------------------------------

export interface MppChallenge {
  id: string;
  realm: string;
  method: string;
  intent: string;
  /** base64url of the JCS-serialised request object */
  request: string;
  expires?: string | undefined;
  digest?: string | undefined;
  opaque?: string | undefined;
}

/** the id binds the challenge to its own parameters: base64url(HMAC-SHA256(secret, realm|method|intent|request|expires|digest|opaque)), absent ones as empty strings.
 * A subset: the optional `header` auth-param (and its slot in this input) is not built, so of the draft's three vectors only the first is reproduced. */
export function mppChallengeId(secret: string, c: Omit<MppChallenge, "id">): string {
  return createHmac("sha256", secret).update([c.realm, c.method, c.intent, c.request, c.expires ?? "", c.digest ?? "", c.opaque ?? ""].join("|")).digest("base64url");
}

export function mppHeader(c: MppChallenge): string {
  const param = (k: string, v: string | undefined) => (v === undefined ? [] : [`${k}="${v}"`]);
  return `Payment ${[...param("id", c.id), ...param("realm", c.realm), ...param("method", c.method), ...param("intent", c.intent), ...param("expires", c.expires), ...param("digest", c.digest), ...param("opaque", c.opaque), ...param("request", c.request)].join(", ")}`;
}

export function mppParse(header: string | undefined): MppChallenge | null {
  if (!header || !/^Payment\s/.test(header)) return null;
  const out: Record<string, string> = {};
  // auth-param = token "=" ( token / quoted-string )
  for (const m of header.slice(8).matchAll(/([a-z]+)\s*=\s*(?:"([^"]*)"|([^\s,"]+))/g)) out[m[1]!] = m[2] ?? m[3]!;
  return out.id && out.realm && out.method && out.intent && out.request ? (out as unknown as MppChallenge) : null;
}

export interface MppCredential {
  /** the challenge, echoed */
  challenge: MppChallenge;
  /** who pays (a DID is recommended) */
  source?: string | undefined;
  payload: Record<string, unknown>;
}

export interface MppReceipt {
  status: "success";
  method: string;
  timestamp: string;
  reference: string;
  [k: string]: unknown;
}

/** the `charge` request object (draft-payment-intent-charge-00): an amount in base units of a currency, to a recipient */
export interface MppChargeRequest {
  amount: string;
  currency: string;
  recipient: string;
  methodDetails: { chainId: number };
}

/** the EVM method's `authorization` credential is EIP-3009 whose nonce commits to the challenge: keccak256(abi.encodePacked(id, realm)) */
export const mppChargeNonce = (c: Pick<MppChallenge, "id" | "realm">): Hex => keccak256(encodePacked(["string", "string"], [c.id, c.realm]));

/** the `session` request object: a price per unit, a suggested deposit, the escrow that holds it */
export interface MppSessionRequest {
  amount: string;
  unitType: string;
  suggestedDeposit: string;
  currency: string;
  recipient: string;
  methodDetails: { escrowContract: string; chainId: number };
}

const VOUCHER = { Voucher: [{ name: "channelId", type: "bytes32" }, { name: "cumulativeAmount", type: "uint128" }] } as const;
const voucherData = (escrow: string, chainId: number, channelId: Hex, cumulative: number) => ({ domain: { name: "EVM Payment Channel", version: "1", chainId, verifyingContract: escrow as Hex }, types: VOUCHER, primaryType: "Voucher" as const, message: { channelId, cumulativeAmount: BigInt(cumulative) } });

/** keccak256(abi.encode(payer, payee, token, salt, authorizedSigner, escrow, chainId)) */
export function mppChannelId(payer: string, payee: string, token: string, salt: Hex, authorizedSigner: string, escrow: string, chainId: number): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }, { type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "uint256" }], [payer as Hex, payee as Hex, token as Hex, salt, authorizedSigner as Hex, escrow as Hex, BigInt(chainId)]));
}

/** a voucher says "the total I owe on this channel is now X": it only ever goes up, and only the last one matters */
export const mppSignVoucher = (signer: SimKey, escrow: string, chainId: number, channelId: Hex, cumulative: number): Promise<Hex> => signer.account.signTypedData(voucherData(escrow, chainId, channelId, cumulative));

/** half the order of secp256k1: a signature whose s is above it is the malleable twin of one below it, and is refused */
const HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/** who signed a voucher — `null` unless the signature is 65 bytes r ‖ s ‖ v with v = 27 | 28 and a low s, as the session method requires */
export async function mppVoucherSigner(escrow: string, chainId: number, channelId: Hex, cumulative: number, signature: Hex): Promise<string | null> {
  if (!/^0x[0-9a-fA-F]{130}$/.test(String(signature))) return null;
  const v = Number.parseInt(signature.slice(130), 16);
  if ((v !== 27 && v !== 28) || BigInt(`0x${signature.slice(66, 130)}`) > HALF_N) return null;
  try {
    return (await recoverTypedDataAddress({ ...voucherData(escrow, chainId, channelId, cumulative), signature })).toLowerCase();
  } catch {
    return null;
  }
}

/** `Authorization: Payment <base64url JSON>` and `Payment-Receipt: <base64url JSON>` */
export const mppAuthorization = (c: MppCredential): string => `Payment ${jcs64(c)}`;
export const mppReadAuthorization = (header: string | undefined): MppCredential | null => (header && /^Payment\s+\S+$/.test(header) ? unjcs64<MppCredential>(header.replace(/^Payment\s+/, "")) : null);

/** the escrow's `open`, as the EVM session method's contract declares it */
export const ESCROW_ABI = [{ type: "function", name: "open", stateMutability: "nonpayable", inputs: [{ name: "payee", type: "address" }, { name: "token", type: "address" }, { name: "deposit", type: "uint128" }, { name: "salt", type: "bytes32" }, { name: "authorizedSigner", type: "address" }], outputs: [{ name: "channelId", type: "bytes32" }] }] as const;

export interface EscrowOpen {
  payee: string;
  token: string;
  deposit: number;
  salt: Hex;
  authorizedSigner: string;
}

/** Opening a channel: the client SIGNS the escrow's `open` transaction and the server broadcasts it. This is a real signed EIP-1559 transaction
 * for the simulated chain id; gas is a placeholder (nothing here is ever broadcast), and the token allowance the escrow needs is assumed. */
export function mppOpenTx(payer: SimKey, escrow: string, chainId: number, o: EscrowOpen, txNonce: number): Promise<Hex> {
  const data = encodeFunctionData({ abi: ESCROW_ABI, functionName: "open", args: [o.payee as Hex, o.token as Hex, BigInt(o.deposit), o.salt, o.authorizedSigner as Hex] });
  return payer.account.signTransaction({ type: "eip1559", chainId, to: escrow as Hex, data, nonce: txNonce, gas: 120_000n, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000n });
}

/** what a server reads out of that transaction before it broadcasts it: who signed it, which contract it calls, and with what */
export async function mppReadOpenTx(serialized: Hex): Promise<{ from: string; to: string; chainId: number; nonce: number; open: EscrowOpen } | null> {
  try {
    const tx = parseTransaction(serialized);
    const from = (await recoverTransactionAddress({ serializedTransaction: serialized as `0x02${string}` })).toLowerCase();
    const call = decodeFunctionData({ abi: ESCROW_ABI, data: tx.data ?? "0x" });
    const [payee, token, deposit, salt, authorizedSigner] = call.args;
    return { from, to: String(tx.to).toLowerCase(), chainId: Number(tx.chainId), nonce: Number(tx.nonce), open: { payee: payee.toLowerCase(), token: token.toLowerCase(), deposit: Number(deposit), salt, authorizedSigner: authorizedSigner.toLowerCase() } };
  } catch {
    return null;
  }
}

/** a failed verification is a 402 with a fresh challenge and a Problem Details body */
export const mppProblem = (code: string, detail: string, status = 402) => ({ type: `https://paymentauth.org/problems/${code}`, title: code, status, detail });

// ---- AP2 v0.2: mandates as SD-JWTs ------------------------------------------------------

export interface Jws {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: string;
  signature: string;
}

export function jwsSign(header: Record<string, unknown>, payload: Record<string, unknown>, key: KeyObject): string {
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
  return `${input}.${es256Sign(key, input)}`;
}

export function jwsParse(token: string): Jws | null {
  const [h, p, s, ...rest] = token.split(".");
  if (!h || !p || !s || rest.length) return null;
  try {
    return { header: JSON.parse(unb64u(h)) as Record<string, unknown>, payload: JSON.parse(unb64u(p)) as Record<string, unknown>, signingInput: `${h}.${p}`, signature: s };
  } catch {
    return null;
  }
}

export const jwsVerify = (j: Jws, jwk: Jwk): boolean => j.header.alg === "ES256" && es256Verify(jwk, j.signingInput, j.signature);

/** an SD-JWT disclosure: base64url(JSON [salt, value]) for an array element, [salt, name, value] for an object's property. Its digest is what the JWT carries */
function disclose(salt: string, value: unknown, name?: string): { encoded: string; digest: string } {
  const encoded = b64u(JSON.stringify(name === undefined ? [salt, value] : [salt, name, value]));
  return { encoded, digest: sha256u(encoded) };
}

export type Ap2Constraint =
  | { type: "payment.amount_range"; currency: string; min: number; max: number }
  | { type: "payment.allowed_payees"; allowed: Array<{ id: string; name?: string; website?: string }> }
  | { type: "payment.budget"; currency: string; max: number }
  | { type: "payment.execution_date"; not_before: string; not_after: string }
  /** ties a payment mandate to one open checkout mandate: the hash of that mandate */
  | { type: "payment.reference"; conditional_transaction_id: string }
  | { type: "checkout.allowed_merchants"; allowed: Array<{ id: string; name?: string; website?: string }> }
  | { type: "checkout.line_items"; items: Array<{ id: string; acceptable_items: Array<{ id: string; title?: string }>; quantity: number }> }
  | { type: string; [k: string]: unknown };

export type Ap2Kind = "payment" | "checkout";

export const ap2Salt = (): string => randomBytes(16).toString("base64url");

/** An OPEN mandate: what the agent may do, and which key is the agent (`cnf`). It is signed by the user's credential key or, as here, by the
 * agent provider's key — the account issues it from a spending approval the owner signed. Serialised as an SD-JWT: `<JWT>~<disclosure>~`
 * (the header's `typ` is the one the specification's own example carries).
 * What is written here is a subset: the whole mandate rides in one `delegate_payload` disclosure, where the specification's examples also
 * make each allowed merchant or item its own disclosure. The verifier below reads both shapes. */
export function ap2Open(kind: Ap2Kind, constraints: Ap2Constraint[], agent: Jwk, iat: number, exp: number, issuer: { key: KeyObject; kid: string }, salt = ap2Salt()): string {
  const d = disclose(salt, { vct: `mandate.${kind}.open.1`, constraints, cnf: { jwk: { kty: agent.kty, crv: agent.crv, x: agent.x, y: agent.y } }, iat, exp });
  return `${jwsSign({ alg: "ES256", typ: "example+sd-jwt", kid: issuer.kid }, { delegate_payload: [{ "...": d.digest }], _sd_alg: "sha-256" }, issuer.key)}~${d.encoded}~`;
}

/** A CLOSED mandate: this checkout, this payee, this amount. The agent signs it with the key the open mandate names, and binds it to that open
 * mandate (`sd_hash`), to one verifier (`aud`) and to one exchange (`nonce`). Serialised as a key-binding SD-JWT: `<KB-JWT>~<disclosure>~…~`.
 * `attached` are claims carried as their own disclosures — a closed checkout mandate carries the merchant's signed checkout that way. */
export function ap2Close(kind: Ap2Kind, claims: Record<string, unknown>, bind: { aud: string; nonce: string; iat: number }, open: string, agentKey: KeyObject, attached: Record<string, unknown> = {}): string {
  const extra = Object.entries(attached).map(([name, value]) => disclose(ap2Salt(), value, name));
  const d = disclose(ap2Salt(), { ...(extra.length ? { _sd: extra.map((x) => x.digest) } : {}), vct: `mandate.${kind}.1`, ...claims });
  return `${jwsSign({ alg: "ES256", typ: "kb+sd-jwt" }, { delegate_payload: [{ "...": d.digest }], iat: bind.iat, aud: bind.aud, nonce: bind.nonce, sd_hash: sha256u(open), _sd_alg: "sha-256" }, agentKey)}~${[d, ...extra].map((x) => x.encoded).join("~")}~`;
}

/** the presented chain: `<open SD-JWT>~~<closed KB-SD-JWT>~…~`, exactly one empty component between the links */
export const ap2Chain = (open: string, closed: string): string => `${open}~${closed}`;
/** `checkout_hash` and the payment mandate's `transaction_id`: base64url(sha-256(the merchant's checkout JWT)) */
export const ap2CheckoutHash = (checkoutJwt: string): string => sha256u(checkoutJwt);
/** what `payment.reference` and a closed mandate's `sd_hash` name: the hash of an open mandate as it is presented */
export const ap2MandateHash = (open: string): string => sha256u(open);

/** a receipt: the merchant signs the Checkout Receipt, its payment processor the Payment Receipt. `reference` is the hash of the closed mandate it answers */
export function ap2Receipt(fields: { status: "Success" | "Error"; iss: string; iat: number; reference: string; [k: string]: unknown }, key: KeyObject, kid: string): string {
  return jwsSign({ alg: "ES256", typ: "JWT", kid }, fields, key);
}

export type Ap2Error = "invalid_credential" | "unresolved_constraint" | "invalid_mandate";
export type Ap2Verdict = { ok: true; open: Record<string, unknown>; closed: Record<string, unknown>; reference: string } | { ok: false; error: Ap2Error; description: string };

/** One link of a chain, with its disclosures resolved: every `{"...": digest}` array element and every digest in an object's `_sd` is replaced
 * by what a presented disclosure reveals. A disclosure the JWT does not commit to makes the whole link unreadable. */
function opened(part: string): { jws: Jws; content: Record<string, unknown>; raw: string } | null {
  const pieces = part.split("~");
  if (pieces.length < 3 || pieces[pieces.length - 1] !== "") return null;
  const jws = jwsParse(pieces[0]!);
  if (!jws) return null;
  const by = new Map<string, unknown[]>();
  for (const d of pieces.slice(1, -1)) {
    try {
      const v = JSON.parse(unb64u(d)) as unknown;
      if (!Array.isArray(v) || (v.length !== 2 && v.length !== 3)) return null;
      by.set(sha256u(d), v);
    } catch {
      return null;
    }
  }
  const used = new Set<string>();
  const reveal = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      const out: unknown[] = [];
      for (const el of node) {
        const digest = el && typeof el === "object" && !Array.isArray(el) && Object.keys(el).length === 1 ? (el as Record<string, unknown>)["..."] : undefined;
        if (typeof digest !== "string") out.push(reveal(el));
        else if (by.get(digest)?.length === 2) {
          used.add(digest);
          out.push(reveal(by.get(digest)![1]));
        }
      }
      return out;
    }
    if (node && typeof node === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) if (k !== "_sd") o[k] = reveal(v);
      for (const digest of ((node as { _sd?: unknown[] })._sd ?? []).filter((x): x is string => typeof x === "string")) {
        const hit = by.get(digest);
        if (hit?.length === 3) {
          used.add(digest);
          o[String(hit[1])] = reveal(hit[2]);
        }
      }
      return o;
    }
    return node;
  };
  const content = (reveal(jws.payload.delegate_payload) as unknown[] | undefined)?.[0];
  if (used.size !== by.size || typeof content !== "object" || content === null || Array.isArray(content)) return null;
  return { jws, content: content as Record<string, unknown>, raw: part };
}

/** What a verifier does with a chain (a credential provider for a payment mandate, a merchant for a checkout mandate): the open mandate is
 * signed by a key it trusts and has not expired; the closed one is signed by the key the open one names, is bound to that open mandate, to
 * this verifier and to this exchange; and every constraint of the open mandate holds for what the closed one says. A constraint type the
 * verifier does not know FAILS — it does not pass. `aud` and `nonce` are `null` for a party the mandate is shown to but not addressed to
 * (a merchant's processor reading the payment mandate): everything else is still checked. */
export function ap2Verify(chain: string, kind: Ap2Kind, opts: { issuers: Jwk[]; aud: string | null; nonce: string | null; nowSec: number; spentMinor?: number | undefined; /** the hash of the open checkout mandate this payment goes with */ reference?: string | undefined; /** the checkout a closed checkout mandate's hash resolves to, at the merchant */ checkout?: { merchant: string; items: Array<{ id: string; quantity: number }> } | undefined }): Ap2Verdict {
  const no = (error: Ap2Error, description: string): Ap2Verdict => ({ ok: false, error, description });
  const cut = chain.indexOf("~~");
  if (cut < 0) return no("invalid_credential", "not a chain: no open mandate followed by a closed one");
  const o = opened(chain.slice(0, cut + 1));
  const c = opened(chain.slice(cut + 2));
  if (!o || !c) return no("invalid_credential", "a mandate does not parse, or a disclosure is not one its JWT commits to");
  if (!String(o.jws.header.typ ?? "").endsWith("+sd-jwt") || c.jws.header.typ !== "kb+sd-jwt") return no("invalid_credential", "the open mandate is an SD-JWT and the closed one a key-binding SD-JWT: the headers say otherwise");
  if (!opts.issuers.some((k) => jwsVerify(o.jws, k))) return no("invalid_credential", "the open mandate is not signed by a key this verifier trusts");
  if (o.content.vct !== `mandate.${kind}.open.1` || c.content.vct !== `mandate.${kind}.1`) return no("invalid_mandate", `expected an open and a closed ${kind} mandate`);
  if (!(Number(o.content.exp) > opts.nowSec)) return no("invalid_mandate", "the open mandate has expired");
  const cnf = (o.content.cnf as { jwk?: Jwk } | undefined)?.jwk;
  if (!cnf || !jwsVerify(c.jws, cnf)) return no("invalid_credential", "the closed mandate is not signed by the agent key the open mandate names");
  if (c.jws.payload.sd_hash !== sha256u(o.raw)) return no("invalid_credential", "the closed mandate is bound to a different open mandate");
  if ((opts.aud !== null && c.jws.payload.aud !== opts.aud) || (opts.nonce !== null && c.jws.payload.nonce !== opts.nonce)) return no("invalid_credential", "the closed mandate was made for a different verifier or a different exchange");
  const amount = c.content.payment_amount as { amount?: number; currency?: string } | undefined;
  const payee = c.content.payee as { id?: string } | undefined;
  for (const k of (o.content.constraints as Ap2Constraint[] | undefined) ?? []) {
    const t = k as Record<string, unknown> & { type: string };
    if (t.type === "payment.amount_range") {
      if (!amount || amount.currency !== t.currency || !(Number(amount.amount) >= Number(t.min)) || !(Number(amount.amount) <= Number(t.max))) return no("invalid_mandate", `the amount is outside the mandate's range (${String(t.min)}–${String(t.max)} ${String(t.currency)} minor units)`);
    } else if (t.type === "payment.budget") {
      if (!amount || (opts.spentMinor ?? 0) + Number(amount.amount) > Number(t.max)) return no("invalid_mandate", "the mandate's budget would be passed");
    } else if (t.type === "payment.allowed_payees") {
      if (!payee?.id || !(t.allowed as Array<{ id: string }>).some((x) => x.id === payee.id)) return no("invalid_mandate", `"${payee?.id ?? "?"}" is not a payee the mandate allows`);
    } else if (t.type === "payment.reference") {
      if (!opts.reference || t.conditional_transaction_id !== opts.reference) return no("invalid_mandate", "this payment mandate goes with a different checkout mandate");
    } else if (t.type === "checkout.allowed_merchants") {
      if (!opts.checkout || !(t.allowed as Array<{ id: string }>).some((x) => x.id === opts.checkout!.merchant)) return no("invalid_mandate", `"${opts.checkout?.merchant ?? "?"}" is not a merchant the mandate allows`);
    } else if (t.type === "checkout.line_items") {
      const allowed = t.items as Array<{ acceptable_items: Array<{ id: string }>; quantity: number }>;
      const fits = (i: { id: string; quantity: number }) => allowed.some((a) => a.quantity >= i.quantity && a.acceptable_items.some((x) => x.id === i.id));
      if (!opts.checkout || !opts.checkout.items.every(fits)) return no("invalid_mandate", "the checkout holds an item, or a quantity, the mandate does not allow");
    } else if (t.type === "payment.execution_date") {
      if (opts.nowSec < Date.parse(String(t.not_before)) / 1000 || opts.nowSec > Date.parse(String(t.not_after)) / 1000) return no("invalid_mandate", "outside the mandate's execution window");
    } else return no("unresolved_constraint", `this verifier does not know the constraint "${t.type}", so it cannot say the mandate holds`);
  }
  return { ok: true, open: o.content, closed: c.content, reference: sha256u(chain.slice(cut + 2)) };
}

/** what the account hands an agent that is buying under AP2: the merchant's signed checkout, the open mandates, and what the closed ones must be bound to */
export interface Ap2Needs {
  needs: "mandates";
  protocol: "ap2";
  checkout: { id: string; jwt: string; hash: string; total: { amount: number; currency: string }; merchant: { id: string; name: string; website: string } };
  open: { checkout: string; payment: string };
  sign: { checkout: { aud: string; nonce: string }; payment: { aud: string; nonce: string } };
  instrument: { id: string; type: string; description: string };
}

/** The agent's part: two closed mandates signed with ITS key — "this checkout" for the merchant, "this payment" for the credential provider.
 * An agent that signs these has read the total and the payee out of the merchant's own signed checkout, not out of anyone's description of it. */
export function ap2Answer(agentKey: KeyObject, n: Ap2Needs, iat: number): { checkout: string; payment: string } {
  return {
    checkout: ap2Close("checkout", { checkout_hash: n.checkout.hash }, { ...n.sign.checkout, iat }, n.open.checkout, agentKey, { checkout_jwt: n.checkout.jwt }),
    payment: ap2Close("payment", { transaction_id: n.checkout.hash, payee: n.checkout.merchant, payment_amount: n.checkout.total, payment_instrument: n.instrument }, { ...n.sign.payment, iat }, n.open.payment, agentKey),
  };
}
