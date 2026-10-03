/** The agent portfolio manager's account model: every account the user already
 * has — a CEX, a card, a bank, an RWA position, the MetaMask agent wallet — in
 * ONE shape, each carrying the NATIVE SCOPE of its credential: what the venue,
 * the card network, the bank or the issuer lets this credential do at all,
 * independent of anything the wallet says.
 *
 * "Maximally open" is defined against that scope. The wallet never widens it
 * (it cannot: the venue enforces it); it only decides how much of it the agent
 * may use (`openness.ts`). A credential is a REFERENCE here — the value lives
 * in the home directory and no agent-facing view ever carries it.
 */
import type { Refusal } from "../core/errors.ts";

export type AccountKind = "cex" | "card" | "bank" | "agent-wallet" | "rwa";
export type Capability = "read" | "trade" | "move" | "pay" | "subscribe" | "redeem";
export type ScopeEnforcer = "venue" | "network" | "bank" | "issuer" | "metamask";

export interface NativeScope {
  /** what the credential can do at all; the wallet can only shrink this */
  can: Capability[];
  /** the credential's own limits, in the provider's vocabulary */
  limits: string[];
  enforcedBy: ScopeEnforcer;
}

export interface Account {
  id: string;
  name: string;
  kind: AccountKind;
  provider: string;
  /** reference only (`home/credentials/...`); the agent never sees the value */
  credentialRef: string;
  /** what kind of thing the credential is, one line */
  credentialKind: string;
  scope: NativeScope;
  /** how a write settles there */
  settlement: string;
  /** reads and writes reach the real provider (only the MetaMask agent wallet, opt-in) */
  live: boolean;
  /** where money lands when another account sends here (routing); on-chain accounts and issuers have one */
  address?: string | undefined;
  /** home chain of an on-chain account */
  chain?: string | undefined;
}

export type AssetClass = "crypto" | "stable" | "cash" | "rwa" | "credit";

export interface Holding {
  account: string;
  asset: string;
  amount: number;
  usd: number;
  class: AssetClass;
  note?: string | undefined;
}

export type Intent =
  /** at the on-chain wallet a trade is a DEX swap; `chainId` names the chain whose pools take it */
  | { kind: "trade"; symbol: string; side: "buy" | "sell"; qty: number; chainId?: number | undefined }
  | { kind: "move"; asset: string; amount: number; to: string; chainId?: number | undefined; fromChainId?: number | undefined; via?: string | undefined }
  | { kind: "pay"; merchant: string; mcc: string; amountUsd: number }
  | { kind: "subscribe"; fund: string; amountUsd: number }
  | { kind: "redeem"; fund: string; amountUsd: number };

export type ExecStatus = "filled" | "sent" | "authorized" | "minted" | "pending";

export interface ExecOk {
  ok: true;
  account: string;
  status: ExecStatus;
  summary: string;
  usd: number;
  ref: string;
  /** the provider's own receipt, verbatim */
  native?: unknown;
}

export type ExecResult = ExecOk | Refusal;

export interface AccountAdapter {
  readonly account: Account;
  read(): Promise<Holding[]>;
  /** the venue-side write. An adapter applies ONLY the credential's native scope
   * (what the venue itself would do); the wallet's policy lives in openness.ts */
  execute(intent: Intent): Promise<ExecResult>;
  /** money arriving from another account over a rail (a bridge, a transfer): the service calls this after a successful `move` whose destination is this account's address */
  credit?(asset: string, amount: number, chain?: string): void;
  /** candidate routes for an intent, when the provider can quote them itself (the live MetaMask bridge / swap aggregator) */
  quote?(intent: Intent): Promise<RouteQuote[]>;
  /** a real spot price in USD, when the provider has a price feed (the live MetaMask price API) */
  spot?(asset: string): Promise<number | undefined>;
}

/** one way to move money between two places — a bridge, a CEX withdrawal, an ACH, a redemption — with its price and its clock */
export interface RouteQuote {
  id: string;
  label: string;
  feeUsd: number;
  etaSec: number;
  /** the agent may take it now; a closed route still carries its quote (what opening it would buy) */
  open: boolean;
  why?: string | undefined;
  /** `sim` a simulated table · `mm` read from the live MetaMask bridge / swap aggregator */
  source: "sim" | "mm";
  /** what the route delivers in USD, when the provider says so (a live swap quote) */
  outUsd?: number | undefined;
}

/** who is flying: every write belongs to one agent, and every flight number starts with its code */
export interface AgentId {
  id: string;
  name: string;
  /** 2–3 capitals, the airline code of the flight number */
  code: string;
}

/** `claude-code` → CC · `codex` → CO · `Cursor IDE` → CI */
export function agentCode(name: string): string {
  const words = name.split(/[^a-z0-9]+/i).filter(Boolean);
  const code = words.length >= 2 ? words.map((w) => w[0]!).join("").slice(0, 3) : (words[0] ?? "AG").slice(0, 2);
  return code.toUpperCase();
}

export const PAGE_AGENT: AgentId = { id: "page", name: "组合经理（页面脚本）", code: "PM" };
export const SCRIPT_AGENT: AgentId = { id: "demo", name: "终端 demo 脚本", code: "TD" };

export const CHAIN_NAME: Record<number, string> = { 1: "Ethereum", 10: "Optimism", 137: "Polygon", 8453: "Base", 42161: "Arbitrum" };

export function chainName(id: number | undefined): string | undefined {
  return id === undefined ? undefined : (CHAIN_NAME[id] ?? `chain ${id}`);
}

export function chainIdOf(name: string | undefined): number | undefined {
  const hit = Object.entries(CHAIN_NAME).find(([, n]) => n === name);
  return hit ? Number(hit[0]) : undefined;
}

export const KIND_LABEL: Record<AccountKind, string> = {
  cex: "CEX 账户",
  "agent-wallet": "agent 钱包（链上）",
  rwa: "RWA 持仓",
  card: "银行卡",
  bank: "银行账户",
};
export const KIND_ORDER: AccountKind[] = ["cex", "agent-wallet", "rwa", "card", "bank"];
export const CAP_LABEL: Record<Capability, string> = { read: "读", trade: "交易", move: "转出", pay: "支付", subscribe: "申购", redeem: "赎回" };
export const WRITE_CAPS: Capability[] = ["trade", "move", "pay", "subscribe", "redeem"];
export const ENFORCER_LABEL: Record<ScopeEnforcer, string> = {
  venue: "交易所侧（key 权限 · IP · 白名单）",
  network: "卡组织 / 发卡行（token 范围）",
  bank: "银行（聚合 token 只读）",
  issuer: "发行方（转让限制合约）",
  metamask: "MetaMask（Guard 策略 + MFA）",
};
export const CLASS_LABEL: Record<AssetClass, string> = { crypto: "加密资产", stable: "稳定币", cash: "现金", rwa: "RWA", credit: "信用额度" };
export const CLASS_ORDER: AssetClass[] = ["cash", "stable", "crypto", "rwa", "credit"];

/** demo prices, fixed so a run is reproducible; the live MetaMask read brings its own USD values */
export const PRICES: Record<string, number> = { BTC: 62150, ETH: 2440, SOL: 148.3, OUSG: 110.42, USDT: 1, USDC: 1, USD: 1 };

export function priceOf(asset: string): number {
  return PRICES[asset] ?? 0;
}

export function classOf(asset: string): AssetClass {
  if (asset === "USD") return "cash";
  if (asset === "USDT" || asset === "USDC") return "stable";
  if (asset === "OUSG") return "rwa";
  return "crypto";
}

/** `BTCUSDT` → BTC · `ETH-USDT` → ETH */
export function baseOf(symbol: string): string {
  return symbol.split("-")[0]!.replace(/(USDT|USDC|USD)$/, "");
}

export function capabilityOf(i: Intent): Capability {
  return i.kind;
}

/** the notional in USD that caps and cards count */
export function usdOf(i: Intent): number {
  switch (i.kind) {
    case "trade":
      return Number((i.qty * priceOf(baseOf(i.symbol))).toFixed(2));
    case "move":
      return Number((i.amount * priceOf(i.asset)).toFixed(2));
    case "pay":
    case "subscribe":
    case "redeem":
      return Number(i.amountUsd.toFixed(2));
  }
}

/** where the money goes, when an intent has a destination: a `move`'s address, a `pay`'s merchant */
export function destinationOf(i: Intent): string | null {
  return i.kind === "move" ? i.to : i.kind === "pay" ? i.merchant : null;
}

export function describeIntent(i: Intent): string {
  switch (i.kind) {
    case "trade":
      return `${i.side.toUpperCase()} ${i.qty} ${baseOf(i.symbol)} (${i.symbol}${i.chainId !== undefined ? ` @ ${chainName(i.chainId)}` : ""})`;
    case "move":
      return `move ${i.amount} ${i.asset} → ${i.to}${i.fromChainId !== undefined && i.chainId !== undefined && i.fromChainId !== i.chainId ? ` (${chainName(i.fromChainId)} → ${chainName(i.chainId)})` : ""}`;
    case "pay":
      return `pay $${i.amountUsd} → ${i.merchant} (MCC ${i.mcc})`;
    case "subscribe":
      return `subscribe $${i.amountUsd} ${i.fund}`;
    case "redeem":
      return `redeem $${i.amountUsd} ${i.fund}`;
  }
}

export const r2 = (n: number): number => Number(n.toFixed(2));
export const r8 = (n: number): number => Number(n.toFixed(8));

/** a quantity a person reads: `1.5`, `0.15`, `15.8184` — never `1.4999999` */
export function qtyText(n: number): string {
  const a = Math.abs(n);
  return String(Number(n.toFixed(a >= 100 ? 2 : a >= 0.01 ? 4 : 8)));
}
