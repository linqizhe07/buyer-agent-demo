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
    default:
      return "not done";
  }
}
