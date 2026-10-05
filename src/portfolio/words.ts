/** The agent's words. A leg on the flight board is a sentence a person reads,
 * never a code: the code stays on the ledger. Shared by the page's scripted
 * agent and by flights that MCP agents fly. English: the interface language. */
import type { Refusal } from "../core/errors.ts";
import type { AskReason } from "./openness.ts";
import { baseOf, CAP_LABEL, chainName, qtyText, type Capability, type ExecOk, type Intent } from "./accounts.ts";
import { parseEventSymbol } from "./events.ts";
import { etaLabel } from "./rails.ts";

export const cents = (n: number): string => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function isBridge(i: Intent): boolean {
  return i.kind === "move" && i.fromChainId !== undefined && i.chainId !== undefined && i.fromChainId !== i.chainId;
}

/** default words for an intent an agent did not describe itself (an MCP flight) */
export function sayOf(i: Intent, name: string): string {
  switch (i.kind) {
    case "trade": {
      const verb = i.side === "sell" ? "Sell" : "Buy";
      const event = parseEventSymbol(i.symbol);
      if (event) return `${verb} ${qtyText(i.qty)} ${event.outcome} · ${name}`;
      return `${verb} ${i.qty} ${baseOf(i.symbol)} · ${i.chainId !== undefined ? `DEX (${chainName(i.chainId)})` : name}`;
    }
    case "move":
      return isBridge(i) ? `Bridge ${i.amount} ${i.asset}: ${chainName(i.fromChainId)} → ${chainName(i.chainId)} → ${i.to}` : `Send ${i.amount} ${i.asset} → ${i.to} · ${name}`;
    case "pay":
      return `Pay ${i.merchant} · ${name}`;
    case "subscribe":
      return `Subscribe ${i.fund} · ${name}`;
    case "redeem":
      return `Redeem ${i.fund} · ${name}`;
  }
}

/** one short detail after the words: the fill and what it netted, the route and what it cost, a NAV, a settlement */
export function detailOf(i: Intent, r: ExecOk): string {
  const n = (r.native ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  switch (i.kind) {
    case "trade": {
      const price = num(n.price);
      const net = num(n.netUsd);
      if (price === undefined || net === undefined) return ` @ ${Math.round(r.usd / i.qty).toLocaleString("en-US")}`;
      return ` @ ${price.toLocaleString("en-US", { maximumFractionDigits: 4 })} · ${i.side === "sell" ? "net" : "cost"} ${cents(net)}`;
    }
    case "subscribe":
      return typeof n.minted === "number" ? ` · ${n.minted.toFixed(2)} ${i.fund} @ NAV ${String(n.nav)}` : "";
    case "redeem":
      return r.status === "pending" ? " · settles T+1" : " · paid out";
    case "pay":
      return " · authorized";
    case "move": {
      if (r.status === "pending") return " · waiting for the other side to confirm";
      const fee = num(n.feeUsd);
      const eta = num(n.etaSec);
      if (n.bridge === true && typeof n.label === "string" && fee !== undefined && eta !== undefined) return ` · ${n.label} · fee ${cents(fee)} · ${etaLabel(eta)}`;
      return isBridge(i) ? " · arrived" : " · sent";
    }
  }
}

/** a DEX swap's route, from its receipt: which pools took it and the gas — `Route: Aerodrome 15.8 + Uniswap v3 0.05% 5.2 · gas $0.05` */
export function routeLine(native: unknown): string | undefined {
  const n = (native ?? {}) as { route?: unknown; gasUsd?: unknown };
  if (!Array.isArray(n.route) || !n.route.length) return undefined;
  const pools = n.route.filter((p): p is { dex: string; qty: number } => typeof p === "object" && p !== null && typeof (p as { dex?: unknown }).dex === "string" && typeof (p as { qty?: unknown }).qty === "number");
  if (!pools.length) return undefined;
  const names = pools.length === 1 ? pools[0]!.dex : pools.map((p) => `${p.dex} ${qtyText(p.qty)}`).join(" + ");
  return `Route: ${names}${typeof n.gasUsd === "number" ? ` · gas ${cents(n.gasUsd)}` : ""}`;
}

export function waitWords(why: AskReason): string {
  if (why === "stranger") return "a new address, needs your OK";
  if (why === "awaiting") return "this market is past its close and not yet resolved, needs your OK";
  if (why === "payee") return "a first payment to this payee, needs your OK";
  return "above the no-ask limit, needs your OK";
}

/** a refusal in the user's words */
export function plainRefusal(r: Refusal, nameOf: (id: string) => string): string {
  const who = r.venue ? nameOf(r.venue) : "the account";
  const want = (r.detail as { want?: Capability } | undefined)?.want;
  switch (r.code) {
    case "E_WALLET_SCOPE":
      return `the ${who} credential can't ${want ? CAP_LABEL[want] : "do this"}; not done`;
    case "E_WALLET_ACCOUNT_REVOKED":
      return `${who} is switched off; not done`;
    case "E_WALLET_REACH":
      return "you haven't opened this action to me; not done";
    case "E_WALLET_BLOCKLIST":
      return "the address is on your blocklist; not done";
    case "E_WALLET_SESSION_EXPIRED":
      return "the session has ended; not done";
    case "E_WALLET_DAILY_CAP":
      return "over today's cap; not done";
    case "E_WALLET_LIVE_WRITES_OFF":
      return "real-money writes are off; not done";
    case "E_WALLET_ACCOUNT_UNKNOWN":
      return "no such account";
    case "E_VENUE_PERMISSION":
      return `${who} refused: this credential lacks the permission`;
    case "E_VENUE_WITHDRAW_WHITELIST":
      return `${who} refused: the address is not on its withdrawal whitelist`;
    case "E_VENUE_CARD_DECLINED":
      return "the card issuer declined";
    case "E_VENUE_TRANSFER_RESTRICTED":
      return "the token contract refused: the recipient is not on the issuer's allowlist";
    case "E_VENUE_INSUFFICIENT":
      return `not enough balance at ${who}; not done`;
    case "E_VENUE_GEOBLOCKED":
      return `${who} refused: it takes no orders from this region`;
    case "E_VENUE_MARKET_CLOSED":
      return `${who} refused: this market takes no more orders`;
    case "E_VENUE_REJECTED":
      return `${who} rejected it`;
    case "E_CARD_REJECTED":
      return "you rejected it; nothing moved";
    case "E_VENUE_AGENT_NO_WITHDRAW":
      return `${who} lets only you withdraw; not done`;
    case "E_VENUE_MIN_DEPOSIT":
      return `below ${who}'s minimum, so it was not sent`;
    case "E_VENUE_RAIL_CLOSED":
      return `that runway at ${who} is closed; not done`;
    case "E_VENUE_CURRENCY":
      return `${who} doesn't take that currency; swap first`;
    case "E_VENUE_UNSETTLED":
      return `that cash at ${who} hasn't settled yet; not done`;
    case "E_VENUE_RETURNED":
      return "the bank returned it; the money is back where it started";
    case "E_ACCOUNT_UNKNOWN_SIGNER":
      return "this key isn't authorised on your account; not done";
    case "E_ACCOUNT_AGENT_EXPIRED":
      return "this agent's key has expired; not done";
    case "E_ACCOUNT_AGENT_REVOKED":
      return "this agent's key was revoked; not done";
    case "E_ACCOUNT_OWNER_ONLY":
    case "E_ACCOUNT_OWNER_SURFACE":
      return "that one is yours to sign; not done";
    case "E_ACCOUNT_NOT_HOME":
      return "I can only move money between your own accounts; not done";
    case "E_ACCOUNT_NONCE":
    case "E_ACCOUNT_EXPIRED":
    case "E_ACCOUNT_BAD_SIGNATURE":
      return "the request was stale or didn't check out; not done";
    case "E_ACCOUNT_THRESHOLD":
      return "it needs another signer; not done";
    case "E_ACCOUNT_FEE_CAP":
      return "the fee is above what you approved; not done";
    case "E_ACCOUNT_DESTINATION":
      return "that address isn't in your address book for this chain; not done";
    case "E_ACCOUNT_DEST_COOLING":
      return "that address is too new to use yet; not done";
    case "E_ACCOUNT_SOURCE":
      return "no open source for the money; not done";
    case "E_ACCOUNT_REQUOTE":
      return "the route changed since it was signed; it needs signing again";
    case "E_ACCOUNT_CARD_EXPIRED":
      return "the card expired; nothing moved";
    case "E_ACCOUNT_UNPRICED":
      return "no price for that asset here; not done";
    case "E_MANDATE_NONE":
      return "you haven't approved this kind of spending; not done";
    case "E_MANDATE_EXPIRED":
      return "the spending approval has expired; not done";
    case "E_MANDATE_RECIPIENT":
      return "that payee isn't in the spending approval; not done";
    case "E_MANDATE_PER_ORDER_CAP":
      return "above the per-payment limit you approved; not done";
    case "E_MANDATE_RATE":
      return "too soon after the last refill; not done";
    case "E_MANDATE_BUDGET":
      return "the budget you approved is used up; not done";
    case "E_MANDATE_INVALID":
      return "the mandate for this purchase didn't check out; not paid";
    case "E_WALLET_FLOAT_CAP":
      return "over the float you gave this agent; not done";
    case "E_WALLET_INSUFFICIENT":
      return "not enough in the agent's float; not done";
    case "E_PAYEE_CHANGED":
      return "the payee's address changed; not paid";
    case "E_PAYEE_OVERCHARGE":
      return "the payee asked for more than agreed; not paid";
    case "E_PAYEE_REJECTED":
      return "the payee turned the payment down";
    case "E_PAYEE_UNVERIFIED":
      return "the payee's request didn't check out; not paid";
    case "E_PAYEE_UNSUPPORTED":
      return "the payee takes no payment method I have; not paid";
    case "E_PAYEE_REDIRECT":
      return "the payee sent me somewhere else; not paid";
    default:
      return "not done";
  }
}
