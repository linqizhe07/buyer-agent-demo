/** The agent's words. A leg on the flight board is a sentence a person reads,
 * never a code: the code stays on the ledger. Shared by the page's scripted
 * agent and by flights that MCP agents fly. */
import type { Refusal } from "../core/errors.ts";
import { baseOf, CAP_LABEL, chainName, qtyText, type Capability, type ExecOk, type Intent } from "./accounts.ts";
import { etaLabel } from "./rails.ts";

export const cents = (n: number): string => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function isBridge(i: Intent): boolean {
  return i.kind === "move" && i.fromChainId !== undefined && i.chainId !== undefined && i.fromChainId !== i.chainId;
}

/** default words for an intent an agent did not describe itself (an MCP flight) */
export function sayOf(i: Intent, name: string): string {
  switch (i.kind) {
    case "trade":
      return `${i.side === "sell" ? "卖出" : "买入"} ${i.qty} ${baseOf(i.symbol)} · ${i.chainId !== undefined ? `DEX（${chainName(i.chainId)}）` : name}`;
    case "move":
      return isBridge(i) ? `跨链 ${i.amount} ${i.asset}：${chainName(i.fromChainId)} → ${chainName(i.chainId)} → ${i.to}` : `转 ${i.amount} ${i.asset} → ${i.to} · ${name}`;
    case "pay":
      return `付 ${i.merchant} · ${name}`;
    case "subscribe":
      return `申购 ${i.fund} · ${name}`;
    case "redeem":
      return `赎回 ${i.fund} · ${name}`;
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
      return ` @ ${price.toLocaleString("en-US")} · ${i.side === "sell" ? "净得" : "共付"} ${cents(net)}`;
    }
    case "subscribe":
      return typeof n.minted === "number" ? ` · ${n.minted.toFixed(2)} 份 @ NAV ${String(n.nav)}` : "";
    case "redeem":
      return " · T+1 到账";
    case "pay":
      return " · 已授权";
    case "move": {
      if (r.status === "pending") return " · 等对方确认";
      const fee = num(n.feeUsd);
      const eta = num(n.etaSec);
      if (n.bridge === true && typeof n.label === "string" && fee !== undefined && eta !== undefined) return ` · ${n.label} · 费 ${cents(fee)} · ${etaLabel(eta)}`;
      return isBridge(i) ? " · 已到" : " · 已发出";
    }
  }
}

/** a DEX swap's route, from its receipt: which pools took it and the gas — `路由：Aerodrome 15.8 + Uniswap v3 0.05% 5.2 · gas $0.05` */
export function routeLine(native: unknown): string | undefined {
  const n = (native ?? {}) as { route?: unknown; gasUsd?: unknown };
  if (!Array.isArray(n.route) || !n.route.length) return undefined;
  const pools = n.route.filter((p): p is { dex: string; qty: number } => typeof p === "object" && p !== null && typeof (p as { dex?: unknown }).dex === "string" && typeof (p as { qty?: unknown }).qty === "number");
  if (!pools.length) return undefined;
  const names = pools.length === 1 ? pools[0]!.dex : pools.map((p) => `${p.dex} ${qtyText(p.qty)}`).join(" + ");
  return `路由：${names}${typeof n.gasUsd === "number" ? ` · gas ${cents(n.gasUsd)}` : ""}`;
}

export function waitWords(stranger: boolean): string {
  return stranger ? "是个新地址，需要你点一下" : "超过免审额度，需要你点一下";
}

/** a refusal in the user's words */
export function plainRefusal(r: Refusal, nameOf: (id: string) => string): string {
  const who = r.venue ? nameOf(r.venue) : "账户";
  const want = (r.detail as { want?: Capability } | undefined)?.want;
  switch (r.code) {
    case "E_WALLET_SCOPE":
      return `${who} 的凭据做不了「${want ? CAP_LABEL[want] : "这个"}」，没做`;
    case "E_WALLET_ACCOUNT_REVOKED":
      return `${who} 你关了，没做`;
    case "E_WALLET_REACH":
      return "这个动作你没开放给我，没做";
    case "E_WALLET_BLOCKLIST":
      return "地址在你的黑名单里，没做";
    case "E_WALLET_SESSION_EXPIRED":
      return "会话已结束，没做";
    case "E_WALLET_DAILY_CAP":
      return "超过今天的上限，没做";
    case "E_WALLET_LIVE_WRITES_OFF":
      return "真钱写操作关着，没做";
    case "E_WALLET_ACCOUNT_UNKNOWN":
      return "没有这个账户";
    case "E_VENUE_PERMISSION":
      return `${who} 拒了：这把 key 没有这个权限`;
    case "E_VENUE_WITHDRAW_WHITELIST":
      return `${who} 拒了：地址不在提币白名单`;
    case "E_VENUE_CARD_DECLINED":
      return "发卡行拒了";
    case "E_VENUE_TRANSFER_RESTRICTED":
      return "链上拒了：收款地址不在发行方白名单";
    case "E_VENUE_INSUFFICIENT":
      return `${who} 余额不够，没做`;
    case "E_CARD_REJECTED":
      return "你拒了，没动";
    default:
      return "没做成";
  }
}
