/** Paying SOMEONE ELSE with real money: an agent's payment for an API call, a metered service, a page — from an agent wallet the account holds
 * the key of (live/agent-wallet.ts), in USDC.
 *
 * The agent signs "pay for this, up to this much, from this agent wallet" (`agentPay`). The ACCOUNT asks the payee, reads what it wants out
 * of its own answer, holds that against the owner's limits, and only then signs — with the agent wallet's key, which the agent never sees:
 *
 *   402 + PAYMENT-REQUIRED (x402 V2)        an EIP-3009 authorisation in PAYMENT-SIGNATURE → PAYMENT-RESPONSE
 *   402 + {x402Version: 1, accepts} (V1)    the same authorisation in X-PAYMENT → X-PAYMENT-RESPONSE
 *   402 + WWW-Authenticate: Payment         an MPP `charge` on the `evm` method: the same authorisation, its nonce bound to the challenge,
 *                                           in Authorization: Payment → Payment-Receipt
 *
 * (coinbase/x402 specs v1 and v2, scheme `exact` on EVM with `eip3009`, as read 2026-10-05; MPP per the drafts payees.ts follows. An MPP
 * session — a deposit locked in an escrow contract — and AP2 are not paid with real money here: they are refused, and say so.)
 *
 * The order of the checks is the simulated payer's (payees.ts), against the real world:
 *   1. the approval     this agent, this host (or any host, if the owner signed `*`) — before one byte goes to the host
 *   2. the source       an agent wallet that is this agent's
 *   3. the payee's ask  its price against `maxAmount`; its receiving address against the one pinned for it; USDC on a chain the account
 *                       knows, at Circle's own address there — never a token the payee names
 *   4. the limits       per payment, budget, the agents' session, the server's cap, what the agent wallet holds on that chain
 *   5. the owner        Guard: every payment is a card. Beast: the first payment to a host is a card — unless the owner
 *                       signed `*`, any host — and later ones go at once. Approving pins the address; a different one later is refused
 *   6. the payment      signed by the agent wallet's key, good for a minute at most. What happened is what the CHAIN says — the token's
 *                       own record of the authorisation's nonce, the transfer in the payee's receipt — not what the payee says. An
 *                       authorisation the payee kept without settling is a cheque it can still cash until it lapses: its amount stays set
 *                       aside until then, and is booked if it is cashed
 */
import { randomBytes } from "node:crypto";
import { decodeEventLog, keccak256, parseAbiItem, stringToHex, type Hex } from "viem";
import { isRefusal, type Refusal } from "../../core/errors.ts";
import { canonical } from "../../core/hash.ts";
import { no } from "../refuse.ts";
import { isExpired } from "../openness.ts";
import { CHAIN_BY_ID, CHAINS, STABLECOINS, type ChainName, type ChainReader } from "../live/chain.ts";
import type { PayHttp, PayResponse } from "../live/guarded-http.ts";
import { edgeRefused, edgeWords, REGION } from "../live/types.ts";
import { agentWalletVenue } from "../live/agent-wallet.ts";
import { agentIdOf, CARD_TTL_MS, slug, type AccountEngine, type CardLike, type CardOffer, type Outcome, type PayAction, type Payer, type PayView } from "./exchange.ts";
import type { Payment, PaymentLeg } from "./payments.ts";
import * as X from "./protocols.ts";
import { paymentLine } from "./statement.ts";
import { micro, unmicro, type Envelope, type SimKey } from "./sign.ts";
import { covers, spendFor, type AgentKey, type SubAccount } from "./state.ts";

export interface RealPayDeps {
  http: PayHttp;
  chain: ChainReader;
  /** the agent wallet's key, by the agent wallet's name */
  wallet(name: string): SimKey | Refusal;
  /** the real clock, ms */
  clock(): number;
  /** the most one payment may be on this server (--live-cap) */
  capUsd(): number;
}

interface Who {
  signer: string;
  agent: AgentKey;
  /** absent for an authorisation a restart followed again: its envelope is on an earlier run's row */
  envelope?: Envelope | undefined;
  hash: Hex;
}

/** what the payee asked for, in the terms every check, card and booking uses */
export interface Offer {
  protocol: "x402" | "mpp-charge";
  version?: 1 | 2 | undefined;
  payTo: string;
  /** USDC's 6 decimals: a token unit is a millionth of a dollar */
  amountMicro: number;
  chain: ChainName;
  token: Hex;
  /** the EIP-712 domain the token signs under */
  domain: { name: string; version: string };
}

interface Ctx {
  action: PayAction;
  who: Who;
  released: CardLike | undefined;
  url: URL;
  host: string;
  method: "GET" | "POST";
  body?: string | undefined;
  contentType?: string | undefined;
  max: number;
  spendId: string;
  sub: SubAccount;
  key: SimKey;
  now: number;
  flight: string;
}

/** what booking a payment needs of the request that made it */
type Booking = Pick<Ctx, "who" | "released" | "host" | "spendId" | "sub" | "flight">;

interface Outstanding {
  c: Booking;
  o: Offer;
  nonce: Hex;
  /** seconds */
  validBefore: number;
  /** the agent wallet that signed it: whose nonce the token is asked about */
  from: Hex;
  native: unknown;
}

/** an authorisation a payee kept without settling, as the ledger records it: enough for a later run of the account to keep its amount set aside
 * and to ask the chain about it again (account/restore.ts) */
export interface KeptAuthorisation {
  nonce: Hex;
  validBefore: number;
  from: Hex;
  spendId: string;
  host: string;
  sub: string;
  agent: Hex;
  signer: string;
  hash: Hex;
  flight: string;
  offer: Offer;
}

const LABEL: Record<Offer["protocol"], string> = { x402: "x402 · EIP-3009", "mpp-charge": "MPP charge · EIP-3009" };
/** how long a signed authorisation stays good. A payee may ask for longer; it does not get it */
const AUTH_TTL_SEC = 60;
/** how long after an authorisation lapses the chain's "not used" is trusted: a node that is a block or two behind is not taken at its word */
const LAPSE_GRACE_SEC = 120;
const MAX_BODY = 64_000;
/** x402 V1 names its networks; V2 says CAIP-2 */
const V1_NETWORKS: Record<string, ChainName> = { base: "Base", ethereum: "Ethereum", "ethereum-mainnet": "Ethereum", polygon: "Polygon", arbitrum: "Arbitrum", "arbitrum-one": "Arbitrum", optimism: "Optimism" };
/** Circle's USDC on each chain an agent wallet pays on, and the EIP-712 domain it signs under */
const USDC = new Map<ChainName, Hex>(STABLECOINS.filter((t) => t.asset === "USDC" && t.chain !== "BNB Chain").map((t) => [t.chain, t.address]));
const DOMAIN = { name: "USD Coin", version: "2" };
const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

const usd = (m: number): string => `$${(m / 1e6).toFixed(m % 10_000 === 0 ? 2 : 4)}`;
const short = (a: string): string => (a.startsWith("0x") && a.length > 14 ? `${a.slice(0, 8)}…${a.slice(-4)}` : a);
const same = (a: unknown, b: unknown): boolean => typeof a === "string" && typeof b === "string" && a !== "" && a.toLowerCase() === b.toLowerCase();
const units = (v: unknown): number => (typeof v === "string" && /^\d{1,15}$/.test(v) ? Number(v) : Number.NaN);
const isAddr = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
const hostOf = (url: unknown): string => {
  try {
    const u = new URL(typeof url === "string" ? url : "");
    return u.protocol === "https:" && !u.username && !u.password ? u.host : "";
  } catch {
    return "";
  }
};
const offerHash = (action: Hex, host: string, o: Offer): Hex => keccak256(stringToHex(canonical({ action, payee: host, payTo: o.payTo.toLowerCase(), amount: unmicro(o.amountMicro), protocol: o.protocol, chain: o.chain, token: o.token.toLowerCase() })));

export class RealPayer implements Payer {
  private paid = new Map<string, { protocol: string; payTo: string; micro: number; payments: number; lastAt: string }>();
  private outstanding: Outstanding[] = [];
  private ticking = false;
  /** this run of the account: a payment's line on the statement is told apart from another run's payment of the same id */
  private readonly run = randomBytes(6).toString("hex");

  constructor(
    private readonly engine: AccountEngine,
    private readonly deps: RealPayDeps,
  ) {}

  reset(): void {
    this.paid = new Map();
    this.outstanding = [];
  }

  view(): PayView {
    return { payees: [...this.paid.entries()].map(([host, p]) => ({ host, protocol: p.protocol, payTo: p.payTo, paidUsd: p.micro / 1e6, payments: p.payments, lastAt: p.lastAt })), sessions: [] };
  }

  async closeByOwner(): Promise<Refusal> {
    return no("E_PAYEE_UNSUPPORTED", { message: "real money is paid in single payments here: there is no payment session to close" });
  }

  /** an authorisation the payee kept without settling: asked of the chain again, booked if it was used, let go when it lapses */
  tick(nowMs: number): void {
    if (this.ticking || !this.outstanding.length) return;
    this.ticking = true;
    void (async () => {
      try {
        for (const h of [...this.outstanding]) {
          const used = await this.deps.chain.authorizationUsed?.(h.o.chain, h.o.token, h.from, h.nonce);
          if (used) {
            this.outstanding = this.outstanding.filter((x) => x !== h);
            this.engine.patchSpend(h.c.spendId, (x) => ({ ...x, reservedMicro: Math.max(0, x.reservedMicro - h.o.amountMicro) }));
            if (this.engine.state.spends.find((s) => s.id === h.c.spendId)?.payTo[h.c.host] === undefined) this.pin(h.c, h.o);
            this.book(h.c, h.o, { ref: h.nonce, native: h.native, note: `${h.c.host} settled the payment after it had answered`, resolved: h.nonce });
          } else if (used === false && Math.floor(nowMs / 1000) > h.validBefore + LAPSE_GRACE_SEC) {
            // let go only on the chain's own word that it was not used, a little after it could last have been: a chain that does not answer
            // (or a reader that cannot ask) keeps it set aside, and it is asked again
            this.outstanding = this.outstanding.filter((x) => x !== h);
            this.engine.patchSpend(h.c.spendId, (x) => ({ ...x, reservedMicro: Math.max(0, x.reservedMicro - h.o.amountMicro) }));
            this.engine.host.log({ kind: "payment", venue: h.c.host, tool: "authorisation lapsed", outcome: "lapsed", notionalUsd: h.o.amountMicro / 1e6, reason: `${h.c.host} never used the authorisation for ${usd(h.o.amountMicro)}: it lapsed, and its amount is free again`, flight: h.c.flight, agent: slug(h.c.who.agent.name), detail: { resolved: h.nonce } });
          }
        }
      } finally {
        this.ticking = false;
      }
    })();
  }

  /** an authorisation a payee still held when the last run of the account stopped: its amount set aside again under its limit, and the chain
   * asked about it like any other — booked if it was used, let go once it has lapsed */
  adopt(k: KeptAuthorisation): void {
    const e = this.engine;
    if (this.outstanding.some((h) => h.nonce === k.nonce)) return;
    const sub = e.state.subAccounts.find((x) => x.name === k.sub);
    const agent = e.state.agents.find((x) => x.address === k.agent);
    if (!sub || !agent || !e.state.spends.some((x) => x.id === k.spendId)) {
      e.host.log({ kind: "note", venue: k.host, reason: `an authorisation for ${usd(k.offer.amountMicro)} ${k.host} held when the account stopped is not followed again: its agent wallet, agent or limit is not on the account now` });
      return;
    }
    this.outstanding.push({ c: { who: { signer: k.signer, agent, hash: k.hash }, released: undefined, host: k.host, spendId: k.spendId, sub, flight: k.flight }, o: k.offer, nonce: k.nonce, validBefore: k.validBefore, from: k.from, native: { nonce: k.nonce, adopted: true } });
    e.patchSpend(k.spendId, (x) => ({ ...x, reservedMicro: x.reservedMicro + k.offer.amountMicro }));
  }

  async pay(action: PayAction, who: Who, released?: CardLike): Promise<Outcome> {
    const e = this.engine;
    const now = this.deps.clock();
    let url: URL;
    try {
      url = new URL(action.url);
    } catch {
      return no("E_ACCOUNT_BAD_ACTION", { message: "a payment names the URL of what is being paid for" });
    }
    if (url.protocol !== "https:" || url.username || url.password) return no("E_ACCOUNT_BAD_ACTION", { message: "a payee is reached over https, at a plain host" });
    if (action.close) return no("E_PAYEE_UNSUPPORTED", { venue: url.host, message: "real money is paid in single payments here: there is no payment session to close" });
    if (action.mandates) return no("E_PAYEE_UNSUPPORTED", { venue: url.host, message: "AP2 mandates are not paid with real money here" });
    const max = micro(action.maxAmount);
    if (Number.isNaN(max) || !(max > 0)) return no("E_ACCOUNT_BAD_ACTION", { message: "maxAmount is a plain decimal, more than zero" });
    const method = (action.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "POST") return no("E_ACCOUNT_BAD_ACTION", { message: "a payment asks with GET or POST" });
    if (action.body !== undefined && (method !== "POST" || action.body.length > MAX_BODY)) return no("E_ACCOUNT_BAD_ACTION", { message: `a body goes with a POST, at most ${MAX_BODY / 1000} kB` });
    // 1 · the approval. Nothing is sent to a host the owner did not name (or to any host, when the owner signed every one)
    const spend = spendFor(e.state, who.signer, "payees", Date.parse(e.host.now()));
    if (isRefusal(spend)) return spend;
    if (!(await e.stillSigned(spend))) return no("E_ACCOUNT_BAD_SIGNATURE", { message: "the spending approval's own signature no longer checks out against the account's owners", detail: { approval: spend.id } });
    if (!spend.allow.includes(url.host) && !spend.allow.includes("*")) return no("E_MANDATE_RECIPIENT", { venue: url.host, message: `"${url.host}" is not a payee the owner approved (${spend.allow.join(", ")}): nothing was sent to it`, detail: { approval: spend.id, allow: spend.allow, host: url.host } });
    if (isExpired(e.host.now(), e.host.policy().sessionExpiresAt)) return no("E_WALLET_SESSION_EXPIRED", { message: "the agents' session has ended: every write stops, reads continue" });
    // 2 · the source: an agent wallet of this agent's
    const sub = e.sub(action.fromSubAccount);
    if (!sub) return no("E_WALLET_ACCOUNT_UNKNOWN", { message: action.fromSubAccount ? `there is no agent wallet "${action.fromSubAccount}"` : "name the agent wallet that pays (from)" });
    if (sub.agent !== who.signer) return no("E_ACCOUNT_SOURCE", { message: `the agent wallet "${sub.name}" belongs to another agent key`, detail: { subAccount: sub.name } });
    if (e.host.policy().revoked.includes(agentWalletVenue(sub.name))) return no("E_WALLET_ACCOUNT_REVOKED", { venue: agentWalletVenue(sub.name), message: `the agent wallet "${sub.name}" is switched off for agents` });
    const key = this.deps.wallet(sub.name);
    if (isRefusal(key)) return key;
    if (!same(key.account.address, sub.address)) return no("E_ACCOUNT_CREDENTIAL", { message: `the key file of the agent wallet "${sub.name}" is not the key it was made with: nothing is signed` });
    const flight = released?.flight ?? e.host.openFlight(agentIdOf(who.agent), `Pay ${url.host}${url.pathname} · real money`).no;
    const c: Ctx = { action, who, released, url, host: url.host, method, ...(action.body !== undefined ? { body: action.body } : {}), ...(action.contentType ? { contentType: action.contentType } : {}), max, spendId: spend.id, sub, key, now, flight };
    try {
      return await this.ask(c);
    } catch (err) {
      return no("E_PAYEE_UNVERIFIED", { venue: c.host, message: `${c.host} answered with something this account could not read (${err instanceof Error ? err.message.slice(0, 80) : "error"}): nothing further was sent` });
    }
  }

  private send(c: Ctx, headers: Record<string, string> = {}): Promise<PayResponse> {
    return this.deps.http({ method: c.method, url: c.url.href, headers: { ...(c.contentType ? { "content-type": c.contentType } : c.body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, ...(c.body !== undefined ? { body: c.body } : {}) });
  }

  /** ask the payee, and speak whatever it answers in */
  private async ask(c: Ctx): Promise<Outcome> {
    const first = await this.send(c);
    if (first.status === 0) {
      // the reason is the guard's own sentence of its kind, never the network's words (a filter's sinkhole address, the names on a certificate
      // an interceptor answered with): those would tell an agent, and the ledger, where the user is
      const why = first.kind && first.error ? ` (${first.error})` : "";
      // this network keeping the request from the payee is said as that, not as the payee failing to answer
      if (first.kind === "filtered-address" || first.kind === "certificate") return no("E_PAYEE_REJECTED", { venue: c.host, message: `this network did not let the request reach ${c.host}${why}: nothing was paid`, detail: { reason: first.kind } });
      return no("E_PAYEE_REJECTED", { venue: c.host, message: `${c.host} did not answer${why}`, ...(first.kind ? { detail: { reason: first.kind } } : {}) });
    }
    if (first.status >= 300 && first.status < 400) {
      // where it pointed, by host only: a geo-redirect's path and query carry the country, the region, even the address
      const to = (() => {
        try {
          return first.headers.location ? new URL(first.headers.location, c.url).host : "";
        } catch {
          return "";
        }
      })();
      // where it pointed is not named: a network's block page or a regional site says roughly where the user is
      return no("E_PAYEE_REDIRECT", { venue: c.host, message: `${c.host} sent the request on to ${to === c.host ? "another page of its own" : "another address"}: a payment does not follow a redirect`, detail: { ownHost: to === c.host } });
    }
    if (first.status === 402 && first.headers["payment-required"]) return this.x402(c, first, 2);
    const v1 = first.body as { x402Version?: unknown; accepts?: unknown } | undefined;
    if (first.status === 402 && v1?.x402Version === 1 && Array.isArray(v1.accepts)) return this.x402(c, first, 1);
    if (first.status === 402 && first.headers["www-authenticate"]) return this.mpp(c, first);
    if (first.status >= 200 && first.status < 300) return { ok: true, kind: "result", result: { paid: false, status: first.status, data: first.body }, flight: c.flight };
    // a payee that does not serve this location (451, or its own words for that), or the server in front of it refusing this network with a
    // page: its rule, said as that — not "no payment method", which would send an agent looking for another way to pay
    const text = typeof first.body === "string" ? first.body : JSON.stringify(first.body ?? "");
    if (first.status === 451 || (first.status >= 400 && first.status !== 402 && REGION.test(text))) return no("E_VENUE_GEOBLOCKED", { venue: c.host, message: `${c.host} does not serve this location: that is its own rule; nothing was paid, and the account does not look for a way around it`, native: { status: first.status } });
    if (edgeRefused(first.status, text)) return no("E_VENUE_GEOBLOCKED", { venue: c.host, message: `${edgeWords(c.host, first.status, text)}. Nothing was paid`, native: { status: first.status, edge: true } });
    if (first.status === 429) return no("E_PAYEE_REJECTED", { venue: c.host, message: `${c.host} is busy (HTTP 429): nothing was paid; try again later`, detail: { status: first.status } });
    if (first.status >= 500) return no("E_PAYEE_REJECTED", { venue: c.host, message: `${c.host} did not answer (HTTP ${first.status}): nothing was paid`, detail: { status: first.status } });
    return no("E_PAYEE_UNSUPPORTED", { venue: c.host, message: `${c.host} answered ${first.status} with no payment method this account speaks`, detail: { status: first.status } });
  }

  // ---- the checks every protocol goes through ----------------------------------------------------

  /** `null`: go ahead and pay. Anything else is the answer: a refusal, or a card that now waits for the owner */
  private async gate(c: Ctx, o: Offer): Promise<Outcome | null> {
    const e = this.engine;
    const spend = e.state.spends.find((s) => s.id === c.spendId)!;
    if (!Number.isInteger(o.amountMicro) || !(o.amountMicro > 0)) return no("E_PAYEE_UNVERIFIED", { venue: c.host, message: `${c.host} asks for an amount that is not a number of token units` });
    if (o.amountMicro > c.max) return no("E_PAYEE_OVERCHARGE", { venue: c.host, message: `${c.host} asks ${usd(o.amountMicro)}; the agent agreed to ${usd(c.max)} at most`, detail: { asked: unmicro(o.amountMicro), maxAmount: c.action.maxAmount } });
    if (o.amountMicro > micro(String(this.deps.capUsd()))) return no("E_ACCOUNT_LIMIT", { venue: c.host, message: `${usd(o.amountMicro)} is more than the most one payment may be on this server (${usd(micro(String(this.deps.capUsd())))}): --live-cap` });
    const pinned = spend.payTo[c.host];
    if (pinned !== undefined && pinned !== o.payTo.toLowerCase()) return no("E_PAYEE_CHANGED", { venue: c.host, message: `${c.host} now asks to be paid at ${short(o.payTo)}; the owner approved ${short(pinned)} for it`, detail: { pinned, offered: o.payTo.toLowerCase() } });
    // the payee by its host, under an approval for every payee too: one payment per payee per window is per payee, not one in all
    const limit = covers(spend, c.host, o.amountMicro, Date.parse(e.host.now()));
    if (limit) return limit;
    // what the agent wallet holds of that token, on that chain, now
    const held = await this.deps.chain.tokens(c.key.account.address as Hex, [{ chain: o.chain, asset: "USDC", address: o.token }]);
    // a chain whose endpoint refused or rate-limited this machine has not said the wallet holds nothing: it did not answer, in its words
    // — and nor has one that answered without USDC's row (its balance call reverted)
    if (held.failed.length || !held.rows.length) return no("E_VENUE_UNREACHABLE", { venue: agentWalletVenue(c.sub.name), message: `${o.chain} did not answer${held.said?.[o.chain] ? ` (${held.said[o.chain]})` : ""}: the agent wallet's balance there is not known, so nothing is signed` });
    const have = Math.round((held.rows[0]?.amount ?? 0) * 1e6);
    if (o.amountMicro > have) return no("E_WALLET_INSUFFICIENT", { venue: agentWalletVenue(c.sub.name), message: `the agent wallet "${c.sub.name}" holds ${usd(have)} USDC on ${o.chain}; this needs ${usd(o.amountMicro)}`, detail: { subAccount: c.sub.name, chain: o.chain, balance: have / 1e6, needs: o.amountMicro / 1e6 } });
    const hash = offerHash(c.who.hash, c.host, o);
    if (c.released) {
      if (c.released.actionHash !== hash) return no("E_ACCOUNT_REQUOTE", { venue: c.host, message: `what ${c.host} asks changed while the card waited: the approval was for something else`, detail: { card: c.released.id } });
      return null;
    }
    const beast = e.host.policy().mode === "open";
    const first = pinned === undefined;
    if (beast && (!first || spend.allow.includes("*"))) return null;
    const offer: CardOffer = { payee: c.host, payTo: o.payTo.toLowerCase(), amount: `${unmicro(o.amountMicro)} USDC`, protocol: LABEL[o.protocol], network: o.chain };
    const reason = `${c.who.agent.name} asks to pay ${c.host} ${usd(o.amountMicro)} in USDC on ${o.chain}, to ${short(o.payTo)}, over ${LABEL[o.protocol]}, from the agent wallet "${c.sub.name}"${first ? `. A first payment to ${c.host}: approving it pins that address for it` : ""}`;
    const card = e.host.raiseCard(c.flight, { account: agentWalletVenue(c.sub.name), intent: { kind: "pay", merchant: c.host, mcc: "4816", amountUsd: o.amountMicro / 1e6 }, usd: o.amountMicro / 1e6, reason, why: "live", action: c.action, actionHash: hash, signer: c.who.signer, expiresAt: new Date(Date.parse(e.host.now()) + CARD_TTL_MS).toISOString(), offer, approval: spend.id });
    e.patchSpend(spend.id, (x) => ({ ...x, reservedMicro: x.reservedMicro + o.amountMicro }));
    e.host.log({ kind: "action", venue: c.host, tool: "agentPay", signer: c.who.signer, envelope: c.who.envelope, outcome: "card", notionalUsd: o.amountMicro / 1e6, reason: `${card.id} · ${reason}`, flight: c.flight, agent: slug(c.who.agent.name), intentId: card.id, detail: offer });
    return { ok: true, kind: "card", pending: true, card, flight: c.flight };
  }

  /** a nonce for an authorisation: never the same twice */
  private nonce(c: Ctx): Hex {
    return keccak256(stringToHex(`${c.who.hash}:${randomBytes(16).toString("hex")}`));
  }

  // ---- x402 -------------------------------------------------------------------------------------

  private async x402(c: Ctx, first: PayResponse, version: 1 | 2): Promise<Outcome> {
    type Required = { x402Version?: unknown; resource?: { url?: string }; accepts?: unknown };
    const required: Required | null = version === 2 ? X.unb64json<Required>(first.headers["payment-required"] ?? "") : (first.body as Required);
    const accepts = Array.isArray(required?.accepts) ? (required!.accepts as Array<Record<string, unknown>>) : [];
    if (!required || (version === 2 && required.x402Version !== 2) || !accepts.length) return no("E_PAYEE_UNVERIFIED", { venue: c.host, message: `${c.host} sent an x402 offer that does not parse` });
    // the chain a payee names, and USDC at Circle's own address there: an offer in anything else is not paid
    const chainOf = (n: unknown): ChainName | undefined => (typeof n !== "string" ? undefined : version === 2 ? (/^eip155:(\d+)$/.test(n) ? CHAIN_BY_ID.get(Number(n.split(":")[1])) : undefined) : V1_NETWORKS[n]);
    const fits = accepts.map((a) => ({ a, chain: chainOf(a.network) })).filter(({ a, chain }) => a.scheme === "exact" && !!chain && USDC.has(chain) && same(a.asset, USDC.get(chain)) && ((a.extra as { assetTransferMethod?: string } | undefined)?.assetTransferMethod ?? "eip3009") === "eip3009");
    if (!fits.length) return no("E_PAYEE_UNSUPPORTED", { venue: c.host, message: `${c.host} offers ${accepts.map((a) => `${String(a.scheme)} on ${String(a.network)}`).join(", ")}; this account pays "exact" in USDC on ${[...USDC.keys()].join(", ")}`, detail: { accepts: accepts.map((a) => ({ scheme: a.scheme, network: a.network, asset: a.asset })) } });
    const pick = fits[0]!;
    const a = pick.a;
    // who is being paid is read from the payee's own offer, and it has to be the host that was asked
    const named = hostOf(version === 2 ? required.resource?.url : a.resource);
    if (named !== c.host) return no("E_PAYEE_UNVERIFIED", { venue: c.host, message: `${c.host}'s offer is for a resource at "${named || "?"}": it is not paid`, detail: { resource: version === 2 ? required.resource?.url : a.resource } });
    const timeout = Number(a.maxTimeoutSeconds);
    if (!isAddr(a.payTo) || !Number.isInteger(timeout) || timeout < 10) return no("E_PAYEE_UNVERIFIED", { venue: c.host, message: `${c.host}'s offer names no usable receiving address or time limit` });
    const extra = (a.extra ?? {}) as { name?: unknown; version?: unknown };
    const o: Offer = { protocol: "x402", version, payTo: a.payTo, amountMicro: units(version === 2 ? a.amount : a.maxAmountRequired), chain: pick.chain!, token: USDC.get(pick.chain!)!, domain: { name: typeof extra.name === "string" && extra.name ? extra.name : DOMAIN.name, version: typeof extra.version === "string" && extra.version ? extra.version : DOMAIN.version } };
    const stop = await this.gate(c, o);
    if (stop) return stop;
    const nowSec = Math.floor(this.deps.clock() / 1000);
    const nonce = this.nonce(c);
    const requirements: X.X402Requirements = { scheme: "exact", network: `eip155:${CHAINS[o.chain].chain.id}`, amount: String(o.amountMicro), asset: o.token, payTo: o.payTo, maxTimeoutSeconds: timeout, extra: o.domain };
    const signed = await X.x402Authorize(c.key, requirements, nowSec, nonce, undefined, AUTH_TTL_SEC);
    const auth = signed.payload;
    // the payload in the version the payee spoke: V2 echoes the offer as it was made, V1 names the scheme and the network
    const header = version === 2 ? { "PAYMENT-SIGNATURE": X.b64json({ x402Version: 2, ...(required.resource ? { resource: required.resource } : {}), accepted: a, payload: auth }) } : { "X-PAYMENT": X.b64json({ x402Version: 1, scheme: "exact", network: a.network, payload: auth }) };
    const paid = await this.send(c, header);
    const res = X.unb64json<{ success?: boolean; payer?: string; transaction?: string; network?: string; errorReason?: string }>(paid.headers[version === 2 ? "payment-response" : "x-payment-response"] ?? "");
    const native = { protocol: "x402", version, requirements: a, authorization: auth.authorization, response: res ?? null };
    return this.settle(c, o, { nonce, validBefore: Number(auth.authorization.validBefore), native, status: paid.status, data: paid.body, txHash: typeof res?.transaction === "string" ? res.transaction : undefined, why: res?.errorReason });
  }

  // ---- MPP charge ---------------------------------------------------------------------------------

  private async mpp(c: Ctx, first: PayResponse): Promise<Outcome> {
    const ch = X.mppParse(first.headers["www-authenticate"]);
    if (!ch) return no("E_PAYEE_UNVERIFIED", { venue: c.host, message: `${c.host} sent a Payment challenge that does not parse` });
    if (ch.realm !== c.host) return no("E_PAYEE_UNVERIFIED", { venue: c.host, message: `${c.host}'s challenge is for the realm "${ch.realm}": it is not paid`, detail: { realm: ch.realm } });
    if (ch.expires !== undefined && Date.parse(ch.expires) <= this.deps.clock()) return no("E_PAYEE_UNVERIFIED", { venue: c.host, message: `${c.host}'s challenge has already expired` });
    if (ch.method !== "evm" || ch.intent !== "charge") return no("E_PAYEE_UNSUPPORTED", { venue: c.host, message: ch.intent === "session" ? `${c.host} asks for a payment session (a deposit locked in an escrow contract): real money is paid here as single charges only` : `${c.host} asks for "${ch.method}" / "${ch.intent}"; this account pays the "evm" method, as a charge`, detail: { method: ch.method, intent: ch.intent } });
    const req = X.unjcs64<X.MppChargeRequest>(ch.request);
    const chain = req ? CHAIN_BY_ID.get(Number(req.methodDetails?.chainId)) : undefined;
    if (!req || !chain || !USDC.has(chain) || !same(req.currency, USDC.get(chain)) || !isAddr(req.recipient)) return no("E_PAYEE_UNSUPPORTED", { venue: c.host, message: `${c.host} asks for a token or a chain this account does not pay in`, detail: { currency: req?.currency, chainId: req?.methodDetails?.chainId } });
    const o: Offer = { protocol: "mpp-charge", payTo: req.recipient, amountMicro: units(req.amount), chain, token: USDC.get(chain)!, domain: DOMAIN };
    const stop = await this.gate(c, o);
    if (stop) return stop;
    const authorization: X.Eip3009 = { from: c.key.account.address, to: req.recipient, value: req.amount, validAfter: "0", validBefore: String(Math.floor(this.deps.clock() / 1000) + AUTH_TTL_SEC), nonce: X.mppChargeNonce(ch) };
    const terms = { network: `eip155:${CHAINS[chain].chain.id}`, asset: o.token, extra: o.domain };
    const credential: X.MppCredential = { challenge: ch, source: `did:pkh:eip155:${CHAINS[chain].chain.id}:${c.key.account.address}`, payload: { type: "authorization", authorization, signature: await X.eip3009Sign(c.key, terms, authorization) } };
    const paid = await this.send(c, { Authorization: X.mppAuthorization(credential) });
    const receipt = X.unjcs64<X.MppReceipt>(paid.headers["payment-receipt"] ?? "");
    const native = { protocol: "mpp", intent: "charge", challenge: ch, request: req, authorization, receipt: receipt ?? null };
    return this.settle(c, o, { nonce: authorization.nonce, validBefore: Number(authorization.validBefore), native, status: paid.status, data: paid.body, txHash: receipt?.status === "success" && typeof receipt.reference === "string" ? receipt.reference : undefined, why: (paid.body as { title?: string } | undefined)?.title });
  }

  // ---- what the chain says ------------------------------------------------------------------------

  /** After the signed authorisation went to the payee: the token's own record of its nonce says whether it was used, and the payee's receipt
   * is held to the transfer it names. Booked, or set aside until it lapses */
  private async settle(c: Ctx, o: Offer, r: { nonce: Hex; validBefore: number; native: unknown; status: number; data: unknown; txHash?: string | undefined; why?: string | undefined }): Promise<Outcome> {
    const from = c.key.account.address as Hex;
    const used = await this.deps.chain.authorizationUsed?.(o.chain, o.token, from, r.nonce);
    // the transfer the receipt names: from the agent wallet, to the address that was approved, of exactly the amount
    // (a chain that does not answer just now proves nothing either way: the authorisation's nonce, above, or a later tick decides)
    const tx = /^0x[0-9a-fA-F]{64}$/.test(r.txHash ?? "") ? await this.deps.chain.receipt(o.chain, r.txHash as Hex).catch(() => undefined) : undefined;
    const proved = !!tx && tx.status === "success" && tx.logs.some((l) => {
      if (!same(l.address, o.token)) return false;
      try {
        const ev = decodeEventLog({ abi: [TRANSFER], topics: l.topics as [Hex, ...Hex[]], data: l.data });
        return same(ev.args.from, from) && same(ev.args.to, o.payTo) && ev.args.value === BigInt(o.amountMicro);
      } catch {
        return false;
      }
    });
    if (used || proved) {
      // the first payment to a host pins the address it was paid at: a different one later is refused
      if (this.engine.state.spends.find((s) => s.id === c.spendId)?.payTo[c.host] === undefined) this.pin(c, o);
      const ok = r.status >= 200 && r.status < 300;
      return this.book(c, o, { ref: proved ? r.txHash! : r.nonce, ...(proved ? { txHash: r.txHash as Hex } : {}), native: r.native, ...(ok ? { data: r.data } : {}), ...(ok && proved ? {} : { note: proved ? `${c.host} answered ${r.status} after it was paid` : `${c.host} took the payment (the chain shows the authorisation used) and sent no receipt that names the transfer` }) });
    }
    // not used (or the chain did not say): a cheque the payee can still cash until it lapses — its amount is set aside until then
    this.outstanding.push({ c, o, nonce: r.nonce, validBefore: r.validBefore, from, native: r.native });
    this.engine.patchSpend(c.spendId, (x) => ({ ...x, reservedMicro: x.reservedMicro + o.amountMicro }));
    const left = Math.max(0, r.validBefore - Math.floor(this.deps.clock() / 1000));
    // on the record with what a restart needs to keep it set aside: a cheque does not stop being cashable because the account restarted
    const kept: KeptAuthorisation = { nonce: r.nonce, validBefore: r.validBefore, from, spendId: c.spendId, host: c.host, sub: c.sub.name, agent: c.who.agent.address, signer: c.who.signer, hash: c.who.hash, flight: c.flight, offer: o };
    this.engine.host.log({ kind: "payment", venue: c.host, tool: "authorisation outstanding", outcome: "unknown", notionalUsd: o.amountMicro / 1e6, reason: `${c.host} holds a signed authorisation for ${usd(o.amountMicro)} it has not used: good for ${left} s more, set aside until then`, flight: c.flight, agent: slug(c.who.agent.name), native: r.native, detail: { kept } });
    const held = `the signed authorisation stays good for ${left} s more, and its ${usd(o.amountMicro)} is set aside until it is used or lapses`;
    if (r.status >= 200 && r.status < 300) return { ok: true, kind: "result", result: { paid: "not yet", data: r.data, note: `${c.host} answered before the payment was settled on ${o.chain}: ${held}` }, flight: c.flight };
    return no("E_PAYEE_REJECTED", { venue: c.host, message: `${c.host} did not take the payment${r.why ? ` (${r.why})` : r.status === 0 ? " (no answer)" : ""}: nothing has moved; ${held}`, detail: { status: r.status, ...(r.why ? { error: r.why } : {}) } });
  }

  private pin(c: Pick<Ctx, "spendId" | "host">, o: Offer): void {
    const e = this.engine;
    e.patchSpend(c.spendId, (x) => ({ ...x, payTo: { ...x.payTo, [c.host]: o.payTo.toLowerCase() } }));
    if (!e.state.payees.includes(c.host)) e.state = { ...e.state, payees: [...e.state.payees, c.host] };
  }

  /** write a payment that happened into the account: the payments, the limit, the payee's record, the ledger, the statement, the flight */
  private book(c: Booking, o: Offer, r: { ref: string; txHash?: Hex | undefined; native: unknown; data?: unknown; note?: string | undefined; resolved?: Hex | undefined }): Outcome {
    const e = this.engine;
    const at = new Date(this.deps.clock()).toISOString();
    const venue = agentWalletVenue(c.sub.name);
    const leg: PaymentLeg = { step: "out", venue, rail: o.protocol, protocol: LABEL[o.protocol], token: "USDC", chain: o.chain, feeUsd: 0, etaSec: 0, access: "agent", final: true, status: "settled", startedAt: at, settlesAt: at, ref: r.ref, native: r.native };
    const p: Payment = { id: e.nextPaymentId(), kind: "pay", at, from: venue, to: c.host, external: { label: c.host, address: o.payTo.toLowerCase(), chain: o.chain }, sourceToken: "USDC", token: "USDC", amountUsd: o.amountMicro / 1e6, feeUsd: 0, receiveUsd: o.amountMicro / 1e6, legs: [leg], status: "settled", settlesAt: at, settledAt: at, signer: c.who.signer, authority: "agent", agent: c.who.agent.address, flight: c.flight, action: c.who.hash, approval: c.spendId, protocol: o.protocol, ...(c.released ? { card: c.released.id } : {}), live: { kind: "pay", toAddress: o.payTo as Hex, network: o.chain, ...(r.txHash ? { txHash: r.txHash } : {}) }, ...(r.note ? { note: r.note } : {}) };
    e.payments.unshift(p);
    e.patchSpend(c.spendId, (x) => ({ ...x, spentMicro: x.spentMicro + o.amountMicro, last: { ...x.last, [c.host]: Date.parse(e.host.now()) } }));
    const m = this.paid.get(c.host) ?? { protocol: o.protocol, payTo: o.payTo.toLowerCase(), micro: 0, payments: 0, lastAt: at };
    this.paid.set(c.host, { protocol: o.protocol, payTo: o.payTo.toLowerCase(), micro: m.micro + o.amountMicro, payments: m.payments + 1, lastAt: at });
    const words = `${usd(o.amountMicro)} to ${c.host} · ${LABEL[o.protocol]} · USDC on ${o.chain} · from the agent wallet "${c.sub.name}"`;
    e.host.log({ kind: "action", venue: c.host, tool: "agentPay", signer: c.who.signer, ...(c.released ? { intentId: c.released.id } : c.who.envelope ? { envelope: c.who.envelope } : {}), outcome: "accepted", notionalUsd: p.amountUsd, reason: `${p.id} · real money · ${words}`, payment: p.id, flight: c.flight, agent: slug(c.who.agent.name), venueOrderId: r.ref, native: r.native, ...(r.resolved ? { detail: { resolved: r.resolved } } : {}) });
    const line = paymentLine(p, this.run, (id) => (id === venue ? `Agent wallet · ${c.sub.name}` : id), (address) => e.state.agents.find((k) => k.address === address)?.name ?? address);
    e.host.log({ kind: "statement", venue, reason: `${line.id} · ${line.description} · ${line.status}`, detail: line, native: { payment: p, run: this.run } });
    e.host.say(c.flight, r.note ? `Paid ${words}, but ${r.note}` : `Paid ${words}`, r.note ? "no" : "ok", { usd: p.amountUsd, account: venue });
    return { ok: true, kind: "payment", payment: p, flight: c.flight, ...(r.data !== undefined ? { data: r.data } : {}) };
  }
}

