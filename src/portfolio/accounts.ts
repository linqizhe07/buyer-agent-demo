/** The agent portfolio manager's account model: every account the user already
 * has — a broker, a CEX, a prediction market, an RWA position, the MetaMask
 * agent wallet — in ONE shape, each carrying the NATIVE SCOPE of its credential:
 * what the venue or the issuer lets this credential do at all,
 * independent of anything the wallet says.
 *
 * "Maximally open" is defined against that scope. The wallet never widens it
 * (it cannot: the venue enforces it); it only decides how much of it the agent
 * may use (`openness.ts`). A credential is a REFERENCE here — the value lives
 * in the home directory and no agent-facing view ever carries it.
 */
import type { Refusal } from "../core/errors.ts";
import { eventMark, isEventSymbol } from "./events.ts";

/** `broker`: a stock-market account at a broker · `perp`: an account at a perp DEX (Hyperliquid) */
export type AccountKind = "cex" | "agent-wallet" | "rwa" | "prediction" | "broker" | "perp";
export type Capability = "read" | "trade" | "move" | "pay" | "subscribe" | "redeem";
export type ScopeEnforcer = "venue" | "issuer" | "metamask";

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
  /** a capability this kind of credential normally has that the venue has closed for THIS one, and why — as a phrase after the venue's name (`takes no orders from US-NY`) */
  closed?: Partial<Record<Capability, string>> | undefined;
  /** the venue itself says it does not serve this customer's region. The list is the venue's and it changes, so no region is named here: reads may still work, every door is closed */
  restricted?: string | undefined;
  /** how this venue is reached, when it was plugged in through a connector (account/doors.ts `EXCHANGES`); absent on the venues the simulation starts with */
  connector?: string | undefined;
  /** the owner plugged this venue in after the account was opened: it can be unplugged again */
  plugged?: boolean | undefined;
  /** a LIVE venue, connected read-only: the account shows what the real venue reports and sends it nothing, so every door through it is shut */
  watchOnly?: string | undefined;
  /** when a live venue's balances were last read from it */
  asOf?: string | undefined;
  /** the last refresh of a live venue failed, and why: the balances shown are the ones read at `asOf` */
  stale?: string | undefined;
  /** a live venue reached by address: who showed the address is the user's (the wallet that signed); absent, it is only watched */
  proven?: string | undefined;
  /** what real money can be asked of a live venue, when the server moves real money at all */
  liveCan?: { withdraw: boolean | "unknown"; ledgers: string[]; transfer: boolean | "unknown"; swap: boolean | "unknown"; receive: boolean; send: "wallet" | "mm" | false } | undefined;
  /** a venue connected live where orders can be placed: whether the key may trade (as the venue said), and what is traded there */
  liveTrade?: { can: boolean | "unknown"; what: string; /** what else its trader does there: positions, an order changed in place, leverage, its own close */ positions?: boolean; amend?: boolean; leverage?: boolean; close?: boolean } | undefined;
  /** why no order is placed at this venue from the account, when none is */
  noTradeBecause?: string | undefined;
  /** why a live venue is only ever read */
  readOnlyBecause?: string | undefined;
}

/** `event`: shares of a prediction-market outcome, worth $1 or $0 at settlement */
export type AssetClass = "crypto" | "stable" | "cash" | "rwa" | "event" | "equity";

export interface Holding {
  account: string;
  asset: string;
  amount: number;
  usd: number;
  class: AssetClass;
  note?: string | undefined;
  /** winning shares of a settled market, waiting to be redeemed at $1 */
  redeemable?: boolean | undefined;
  /** money that is on its way (a T+1 redemption): owned, but not yet anywhere it can be used */
  inTransit?: boolean | undefined;
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

/** one line of a venue's own record of money in and out: what a reconcile reads */
export interface StatementLine {
  id: string;
  at: string;
  direction: "in" | "out";
  asset: string;
  amount: number;
  status: "pending" | "settled";
  native?: unknown;
}

/** a venue-side money action that went through, with whatever the venue says about it */
export interface VenueOk {
  ok: true;
  ref?: string | undefined;
  /** the venue's own request or receipt, verbatim */
  native?: unknown;
  /** when the venue says it lands (ISO), where the venue runs the clock itself */
  settlesAt?: string | undefined;
  counterparty?: string | undefined;
  received?: number | undefined;
  feeUsd?: number | undefined;
}

export type VenueResult = VenueOk | Refusal;

export interface AccountAdapter {
  readonly account: Account;
  read(): Promise<Holding[]>;
  /** the venue-side write. An adapter applies ONLY the credential's native scope
   * (what the venue itself would do); the wallet's policy lives in openness.ts */
  execute(intent: Intent): Promise<ExecResult>;
  /** money arriving from another account over a rail (a bridge, a transfer): the service calls this after a successful `move` whose destination is this account's address */
  credit?(asset: string, amount: number, chain?: string): void;
  /** money leaving under an authority OTHER than the agent's credential — the owner's own signature that the venue accepts (a wallet, Hyperliquid). `execute` is the agent's credential; this is not. The balance rule is still the venue's */
  debit?(asset: string, amount: number, where?: string): VenueResult;
  /** between the venue's own sub-ledgers: perps ⇄ spot, funding ⇄ trading */
  shift?(asset: string, amount: number, from: string, to: string): VenueResult;
  /** one stablecoin into another at the venue */
  convert?(sell: string, buy: string, amount: number): VenueResult;
  /** the venue's record of money in and out */
  statement?(): StatementLine[];
  /** candidate routes for an intent, when the provider can quote them itself (the live MetaMask bridge / swap aggregator) */
  quote?(intent: Intent): Promise<RouteQuote[]>;
  /** a real spot price in USD, when the provider has a price feed (the live MetaMask price API) */
  spot?(asset: string): Promise<number | undefined>;
  /** the real market behind an event contract, when the provider can read it (the live Polymarket book through `mm predict`): top of book and a preview of this order */
  market?(symbol: string, side: "buy" | "sell", qty: number): Promise<LiveMarket | undefined>;
}

export interface LiveMarket {
  question: string;
  bid?: number | undefined;
  ask?: number | undefined;
  /** how many of the requested shares the real book would fill, and at what average price */
  filled?: number | undefined;
  averagePrice?: number | undefined;
  /** what the preview says a buy costs / a sell brings in, before the venue's fee */
  amountUsd?: number | undefined;
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

export const PAGE_AGENT: AgentId = { id: "page", name: "Portfolio manager (page script)", code: "PM" };
export const SCRIPT_AGENT: AgentId = { id: "demo", name: "Terminal demo script", code: "TD" };

export const CHAIN_NAME: Record<number, string> = { 1: "Ethereum", 10: "Optimism", 137: "Polygon", 8453: "Base", 42161: "Arbitrum" };

export function chainName(id: number | undefined): string | undefined {
  return id === undefined ? undefined : (CHAIN_NAME[id] ?? `chain ${id}`);
}

export function chainIdOf(name: string | undefined): number | undefined {
  const hit = Object.entries(CHAIN_NAME).find(([, n]) => n === name);
  return hit ? Number(hit[0]) : undefined;
}

export const KIND_LABEL: Record<AccountKind, string> = {
  cex: "CEX account",
  "agent-wallet": "Agent wallet (on-chain)",
  prediction: "Prediction market",
  rwa: "RWA position",
  broker: "Broker account",
  perp: "Perp DEX account",
};
/** the stock market first, then the exchanges; the six original kinds keep their order */
export const KIND_ORDER: AccountKind[] = ["broker", "cex", "perp", "agent-wallet", "prediction", "rwa"];
export const CAP_LABEL: Record<Capability, string> = { read: "read", trade: "trade", move: "transfer out", pay: "pay", subscribe: "subscribe", redeem: "redeem" };
export const WRITE_CAPS: Capability[] = ["trade", "move", "pay", "subscribe", "redeem"];
export const ENFORCER_LABEL: Record<ScopeEnforcer, string> = {
  venue: "the venue (key permissions · IP · whitelists)",
  issuer: "the issuer (transfer-restriction contract)",
  metamask: "MetaMask (Guard policy + MFA)",
};
export const CLASS_LABEL: Record<AssetClass, string> = { crypto: "Crypto", stable: "Stablecoins", cash: "Cash", rwa: "RWA", event: "Predictions", equity: "Stocks" };
export const CLASS_ORDER: AssetClass[] = ["cash", "stable", "crypto", "equity", "event", "rwa"];

/** demo prices, fixed so a run is reproducible; the live MetaMask read brings its own USD values */
export const PRICES: Record<string, number> = { BTC: 62150, ETH: 2440, SOL: 148.3, OUSG: 110.42, USDT: 1, USDC: 1, pUSD: 1, USD: 1 };

/** an asset's price, or — for a share of a prediction-market outcome (`EVENT:YES`) — its mark in [0, 1] */
export function priceOf(asset: string): number {
  return PRICES[asset] ?? eventMark(asset) ?? 0;
}

export function classOf(asset: string): AssetClass {
  if (asset === "USD") return "cash";
  if (asset === "USDT" || asset === "USDC" || asset === "pUSD") return "stable";
  if (asset === "OUSG") return "rwa";
  if (isEventSymbol(asset)) return "event";
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
      return Number((i.qty * priceOf(isEventSymbol(i.symbol) ? i.symbol : baseOf(i.symbol))).toFixed(2));
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
      if (isEventSymbol(i.symbol)) return `${i.side.toUpperCase()} ${i.qty} ${i.symbol}`;
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
  const digits = a >= 100 ? 2 : a >= 0.01 ? 4 : 8;
  return Number(n.toFixed(digits)).toLocaleString("en-US", { maximumFractionDigits: digits });
}
