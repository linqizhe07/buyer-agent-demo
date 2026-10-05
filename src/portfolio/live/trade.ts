/** TRADING at a venue connected live: the markets it lists, an order, and what became of it.
 *
 * Every venue speaks its own language — an exchange's unified library, a broker's REST API, a prediction market's signed orders, a DEX
 * aggregator's transaction for the user's own wallet. This file is the one shape the account sees all of them through:
 *
 *   markets(query)      what can be traded there that matches a few letters
 *   market(symbol)      one market, with a fresh price, the smallest order, the steps of size and price, and whether it is open now
 *   place(order)        one order, at the venue, with the account's id for it (the venue's idempotency key, where it takes one)
 *   cancel / status     what became of it: open, partly filled, filled, canceled, rejected
 *
 * Nothing here decides WHETHER an order is placed. The account's door does that (account/live-orders.ts): the server's switch and cap, the
 * owner's signature or the agent's limit, the mode. A trader only speaks the venue's language, and its refusal is the venue's own.
 *
 * Every market is priced in DOLLARS (USD or a dollar stablecoin), so that a cap and a budget mean dollars; a market priced in something
 * else is not offered.
 */
import type { Refusal } from "../../core/errors.ts";
import { no } from "../refuse.ts";
import { isStable } from "./types.ts";

export type Side = "buy" | "sell";
export type OrderType = "market" | "limit";
export type MarketKind = "spot" | "perp" | "future" | "stock" | "crypto" | "event" | "token";

export interface Market {
  /** the account's name for it — what the owner and an agent type: `BTC/USDT` at an exchange, `AAPL` at a broker, `BTC-USD` at Robinhood
   * Crypto, `KXFED-25DEC-T4.00:YES` at Kalshi, `<token id>` or `<slug>:<outcome>` at Polymarket, `USDC>WETH@Base` from a wallet */
  symbol: string;
  /** in words */
  name: string;
  kind: MarketKind;
  /** what is bought (BTC, AAPL, one YES contract) and what it is paid in (USDT, USD) */
  base: string;
  quote: string;
  /** what one unit of `base` last traded at, or the middle of the book, in `quote` */
  price?: number | undefined;
  bid?: number | undefined;
  ask?: number | undefined;
  /** the smallest order the venue takes, in base units; the step of a size; the step of a price; the smallest order in dollars */
  minQty?: number | undefined;
  qtyStep?: number | undefined;
  priceStep?: number | undefined;
  minNotional?: number | undefined;
  /** a contract (a perp, a future) is this much base */
  contractSize?: number | undefined;
  /** open for orders now: a stock market at night, an event past its close, a pair the venue halted is not */
  open: boolean;
  /** why not, or what the owner should know (extended hours, a market order queued for the open) */
  note?: string | undefined;
  /** the order types the venue takes here */
  types: OrderType[];
}

export interface OrderRequest {
  symbol: string;
  side: Side;
  type: OrderType;
  /** in base units: coins, shares, contracts */
  qty: number;
  limitPrice?: number | undefined;
  /** the account's id for this order: the venue's idempotency key where it takes one, so a retry is the same order and not a second one */
  clientId: string;
}

/** `pending`: taken by the venue, not yet on its book (or, from a wallet, waiting for the wallet to send it) */
export type OrderStatus = "pending" | "open" | "partial" | "filled" | "canceled" | "rejected" | "expired";
export const DONE: ReadonlySet<OrderStatus> = new Set(["filled", "canceled", "rejected", "expired"]);

export interface OrderState {
  /** the venue's own id for the order */
  ref: string;
  status: OrderStatus;
  /** in base units */
  filledQty: number;
  avgPrice?: number | undefined;
  feeUsd?: number | undefined;
  /** the venue's own answer, with nothing secret in it */
  native: unknown;
  /** a DEX order from a wallet: the transaction(s) the wallet is asked to send, in order (an approval first, when one is needed) */
  walletTxs?: Array<{ chainId: number; chainIdHex: `0x${string}`; from: `0x${string}`; to: `0x${string}`; data: `0x${string}`; value: `0x${string}`; what: string }> | undefined;
}

export interface LiveTrader {
  /** may this key or sign-in trade here: what the venue said, `unknown` where it has no call that says (its first refusal will) */
  can: boolean | "unknown";
  /** what is traded here, in a few words: "spot and perpetuals", "US stocks and ETFs", "event contracts" */
  what: string;
  /** a few markets to start from (query empty), or the ones matching a query; at most 20 */
  markets(query: string): Promise<Market[] | Refusal>;
  /** one market, with a fresh price */
  market(symbol: string): Promise<Market | Refusal>;
  place(order: OrderRequest): Promise<OrderState | Refusal>;
  cancel(ref: string, symbol: string): Promise<OrderState | Refusal>;
  status(ref: string, symbol: string): Promise<OrderState | Refusal>;
  /** a wallet's DEX order: the account hears which transaction the wallet sent (the last one), and asks the chain from then on */
  sent?(ref: string, hash: `0x${string}`): Promise<OrderState | Refusal>;
}

// ---- sizes and prices ------------------------------------------------------------------------------

/** a market priced in dollars: the only kind the account trades, so that every limit means dollars */
export const inDollars = (quote: string): boolean => quote.toUpperCase() === "USD" || isStable(quote);

const decimals = (step: number): number => {
  if (!(step > 0)) return 8;
  const s = step.toExponential();
  const [m, e] = s.split("e");
  const frac = (m!.split(".")[1] ?? "").length;
  return Math.max(0, frac - Number(e));
};

/** down to the step (never up: an order is never bigger than asked), with no binary dust */
export function floorTo(x: number, step: number | undefined): number {
  if (!(step && step > 0)) return x;
  const n = Math.floor(x / step + 1e-9);
  return Number((n * step).toFixed(decimals(step)));
}

/** is `x` a whole number of steps */
export function onStep(x: number, step: number | undefined): boolean {
  if (!(step && step > 0)) return true;
  return Math.abs(x / step - Math.round(x / step)) < 1e-6;
}

/** a number as a venue wants it in JSON: plain decimal, never 1e-7 */
export function plain(x: number, places = 10): string {
  if (!Number.isFinite(x)) return "0";
  const s = x.toFixed(places);
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

/** what an order of `qty` is worth at `price`, in dollars */
export const notionalOf = (m: Pick<Market, "contractSize">, qty: number, price: number): number => qty * price * (m.contractSize ?? 1);

/** the market's own words for an order that it cannot take as written */
export function badOrder(venue: string, name: string, message: string, detail?: Record<string, unknown>): Refusal {
  return no("E_VENUE_ORDER_INVALID", { venue, message: `${name}: ${message}`, ...(detail ? { detail } : {}) });
}

/** a few markets out of many: the ones whose symbol or name starts with the query first, then the ones that contain it */
export function pick<T extends { symbol: string; name: string }>(all: T[], query: string, max = 20): T[] {
  const q = query.trim().toUpperCase();
  if (!q) return all.slice(0, max);
  const starts = all.filter((m) => m.symbol.toUpperCase().startsWith(q) || m.name.toUpperCase().startsWith(q));
  const has = all.filter((m) => !starts.includes(m) && (m.symbol.toUpperCase().includes(q) || m.name.toUpperCase().includes(q)));
  return [...starts, ...has].slice(0, max);
}
