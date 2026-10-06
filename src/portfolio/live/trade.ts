/** TRADING at a venue connected live: the markets it lists, an order, and what became of it.
 *
 * Every venue speaks its own language — an exchange's unified library, a broker's REST API, a prediction market's signed orders, a DEX
 * aggregator's transaction for the user's own wallet. This file is the one shape the account sees all of them through:
 *
 *   markets(query)      what can be traded there that matches a few letters
 *   market(symbol)      one market, with a fresh price, the smallest order, the steps of size and price, and whether it is open now
 *   place(order)        one order, at the venue, with the account's id for it (the venue's idempotency key, where it takes one):
 *                       market, limit, stop (a market order once a trigger price is reached) or stop-limit, with the time in force,
 *                       post-only and reduce-only flags the venue takes in that market
 *   cancel / status     what became of it: open, partly filled, filled, canceled, rejected
 *   amend               an open order changed in place — its size, its limit, its stop — where the venue can
 *   positions / close   what is held there (perpetuals, shares, event contracts), and a position closed at the venue
 *   setLeverage         a perpetual's leverage and margin mode, where the venue lets it be set
 *
 * A trader offers only what its venue really takes: an option a market does not list (`types`, `tifs`, `postOnly`, `reduceOnly`) is
 * refused by the account before the venue is asked, and a method a trader does not have is a door the account says is closed there.
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
/** market · limit · stop (a market order once the price reaches `stopPrice`) · stop_limit (a limit order at `limitPrice` once it does) */
export type OrderType = "market" | "limit" | "stop" | "stop_limit";
/** how long an order stays: until canceled · what fills at once, the rest canceled · all at once or nothing · until the session's end */
export type TimeInForce = "gtc" | "ioc" | "fok" | "day";
export const ORDER_TYPES: readonly OrderType[] = ["market", "limit", "stop", "stop_limit"];
export const TIFS: readonly TimeInForce[] = ["gtc", "ioc", "fok", "day"];
export type MarketKind = "spot" | "perp" | "future" | "stock" | "crypto" | "event" | "token";

export interface Market {
  /** the account's name for it — what the owner and an agent type: `BTC/USDT` at an exchange, `AAPL` at a broker, `BTC-USD` at Robinhood
   * Crypto, `KXFED-25DEC-T4.00:YES` at Kalshi, `<token id>` or `<slug>:<outcome>` at Polymarket, `WETH/USDC@Base` from a wallet */
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
  /** the times in force it takes here (absent: only its own default, which is not chosen) */
  tifs?: TimeInForce[] | undefined;
  /** where a venue takes a time in force for some order types only (Robinhood: "day" for a crypto stop, not a crypto limit): per type, the
   * ones it takes. A type not named takes all of `tifs` */
  tifsByType?: Partial<Record<OrderType, TimeInForce[]>> | undefined;
  /** a limit order may be post-only here: it rests on the book as a maker, or is refused rather than taking */
  postOnly?: boolean | undefined;
  /** an order may be reduce-only here: it can only shrink a position, never open or grow one */
  reduceOnly?: boolean | undefined;
  /** a sell here can only sell what is held (a prediction market's shares, a cash account's coins): it can never open a short, so a plain
   * sell of what is held closes a long without a reduce-only flag */
  sellsReduce?: boolean | undefined;
  /** the most leverage a perpetual takes here, when the venue says */
  maxLeverage?: number | undefined;
  // ---- what the venue's own listing already says about it (filled only where it does; never estimated) ----
  /** the last 24 hours: the change of the price in percent and in `quote` (an event contract: in dollars per contract, so 0.03 = 3¢), and
   * the value traded, in dollars */
  changePct24h?: number | undefined;
  change24h?: number | undefined;
  volumeUsd24h?: number | undefined;
  /** the last 24 hours' volume where the venue counts it in contracts and not in dollars (Kalshi's `volume_24h_fp`: each pays $1 at
   * settlement) — never turned into dollars */
  contracts24h?: number | undefined;
  /** when it stops trading — an event's close, a dated future's expiry — ISO 8601 */
  closeTime?: string | undefined;
  /** the venue's own category for it, in its own words ("Economics", "Sports", "Crypto") */
  category?: string | undefined;
  /** an event contract's question, which its outcomes share — the venue's id for it (Kalshi's market ticker, Polymarket's condition id) and
   * the question in words — and which outcome this market is ("YES", "NO", a candidate's name) */
  group?: { id: string; title: string } | undefined;
  outcome?: string | undefined;
  /** a perpetual's funding rate per interval (0.0001 = 0.01%) and when it is next paid, ISO 8601 */
  fundingRate?: number | undefined;
  nextFundingAt?: string | undefined;
  /** a token an issuer stands behind (category RWA_CATEGORY, live/categories.ts): who issues it, and whom the issuer says it is not for, in
   * the issuer's own words (dex.ts carries them; a venue that says nothing of it leaves them out) */
  issuer?: string | undefined;
  eligibility?: string | undefined;
}

/** a market's last 24 hours, as the venue reports it */
export interface MarketStats {
  price?: number | undefined;
  changePct24h?: number | undefined;
  change24h?: number | undefined;
  volumeUsd24h?: number | undefined;
  high24h?: number | undefined;
  low24h?: number | undefined;
}

export type CandleInterval = "5m" | "1h" | "1d";
export const CANDLE_INTERVALS: readonly CandleInterval[] = ["5m", "1h", "1d"];
/** one bar of price history: its start (ms), open, high, low, close, and the volume when the venue says, in base units */
export interface Candle { t: number; o: number; h: number; l: number; c: number; v?: number | undefined }

export interface OrderRequest {
  symbol: string;
  side: Side;
  type: OrderType;
  /** in base units: coins, shares, contracts */
  qty: number;
  limitPrice?: number | undefined;
  /** a MARKET order: the worst price it may fill at — the most a buy pays, the least a sell takes, per unit. The trader keeps the fill
   * inside it (a marketable limit order that fills at once or not at all, a maximum cost, an aggregator's minimum out); a venue that has no
   * way to bound a market order is sent the limit order instead */
  worstPrice?: number | undefined;
  /** the account's id for this order: the venue's idempotency key where it takes one, so a retry is the same order and not a second one.
   * Thirty-two lower-case hex digits, new for every order in every run of the account */
  clientId: string;
  /** a stop or stop-limit order: the price that triggers it (a buy stop when the price rises to it, a sell stop when it falls to it). A STOP
   * order also carries `worstPrice`: where the venue can, the trader bounds its fill there (a stop-limit at that price) */
  stopPrice?: number | undefined;
  /** only when the market lists it in `tifs`; absent: the venue's own default */
  tif?: TimeInForce | undefined;
  /** only for a limit order, and only where the market says `postOnly` */
  postOnly?: boolean | undefined;
  /** only where the market says `reduceOnly` */
  reduceOnly?: boolean | undefined;
}

/** an open order changed in place: what changes, as the venue would take it (the rest stays) */
export interface OrderChange {
  qty?: number | undefined;
  limitPrice?: number | undefined;
  stopPrice?: number | undefined;
}

/** something held at a venue: a perpetual's position, shares, event contracts */
export interface Position {
  symbol: string;
  name: string;
  kind: MarketKind;
  side: "long" | "short";
  /** in base units, as orders are sized there (contracts for a perpetual) */
  qty: number;
  entryPrice?: number | undefined;
  markPrice?: number | undefined;
  /** what it is worth now, in dollars */
  usd?: number | undefined;
  unrealizedUsd?: number | undefined;
  leverage?: number | undefined;
  marginMode?: "cross" | "isolated" | undefined;
  liquidationPrice?: number | undefined;
  native: unknown;
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
  walletTxs?: Array<{ chainId: number; chainIdHex: `0x${string}`; from: `0x${string}`; to: `0x${string}`; data: `0x${string}`; value: `0x${string}`; /** the gas the route needs, when the venue says: the wallet is given it */ gas?: `0x${string}` | undefined; what: string }> | undefined;
}

export interface LiveTrader {
  /** may this key or sign-in trade here: what the venue said, `unknown` where it has no call that says (its first refusal will) */
  can: boolean | "unknown";
  /** why it may not, in the venue's terms, when `can` is false (a key without the trading permission; no Agentic account) */
  whyNot?: string | undefined;
  /** what is traded here, in a few words: "spot and perpetuals", "US stocks and ETFs", "event contracts" */
  what: string;
  /** the kinds of market traded here, where the trader says them itself (the mm trader: tokens, event contracts, perpetuals); absent: the
   * account reads them from the connector the owner signed (accounts.ts tradeKinds) */
  kinds?: MarketKind[] | undefined;
  /** a few markets to start from (query empty), or the ones matching a query; at most 20 */
  markets(query: string): Promise<Market[] | Refusal>;
  /** one market, with a fresh price */
  market(symbol: string): Promise<Market | Refusal>;
  place(order: OrderRequest): Promise<OrderState | Refusal>;
  cancel(ref: string, symbol: string): Promise<OrderState | Refusal>;
  status(ref: string, symbol: string): Promise<OrderState | Refusal>;
  /** a wallet's DEX order: the account hears which transaction the wallet sent (the last one); `expected` is the transaction the account
   * built, so the trader can check on chain that the hash is that transaction and not another one; it asks the chain from then on */
  sent?(ref: string, hash: `0x${string}`, expected?: NonNullable<OrderState["walletTxs"]>[number]): Promise<OrderState | Refusal>;
  /** a wallet's DEX order whose approval is now on chain: the swap built again from a fresh quote, held to the same order (its size, side and
   * worst price), so a slow approval does not leave the wallet a stale swap that reverts */
  requote?(order: OrderRequest): Promise<OrderState | Refusal>;
  /** an open order changed in place where the venue can (Alpaca's replace, an exchange's edit, Kalshi's amend). `order` is the order as it
   * was placed, `change` what is to differ. The answer is the order as it stands after: its ref may be new (a replace is a new order) */
  amend?(ref: string, symbol: string, change: OrderChange, order: OrderRequest): Promise<OrderState | Refusal>;
  /** what is held here, where the venue lists positions */
  positions?(): Promise<Position[] | Refusal>;
  /** a position closed by the venue's own call (Alpaca's DELETE /positions); absent: the account closes it with a reduce-only market order */
  close?(symbol: string, qty: number, clientId: string): Promise<OrderState | Refusal>;
  /** a perpetual's leverage, and its margin mode where the venue lets it be set */
  setLeverage?(symbol: string, leverage: number, marginMode?: "cross" | "isolated"): Promise<{ leverage: number; marginMode?: "cross" | "isolated" | undefined; native: unknown } | Refusal>;
  // ---- reading the market (no order, nothing signed) ----
  /** the last 24 hours of many markets in one call where the venue has one: by symbol. `symbols` absent: the venue's well-known markets */
  stats?(symbols?: string[]): Promise<Map<string, MarketStats> | Refusal>;
  /** event contracts, each carrying its `group` (the question), `closeTime` and `category`: the open ones, in one category when asked,
   * closing within `closingWithinMs` when asked, at most `limit`, most traded first */
  events?(o: { category?: string | undefined; closingWithinMs?: number | undefined; limit: number }): Promise<Market[] | Refusal>;
  /** price history since `sinceMs`, oldest first */
  candles?(symbol: string, interval: CandleInterval, sinceMs: number): Promise<Candle[] | Refusal>;
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

/** up to the step (a sell's worst price is never looser than asked) */
export function ceilTo(x: number, step: number | undefined): number {
  if (!(step && step > 0)) return x;
  const n = Math.ceil(x / step - 1e-9);
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
