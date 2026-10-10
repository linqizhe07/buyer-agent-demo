/** TRADING at an exchange through the unified exchange library (ccxt): any exchange it covers, on the owner's own API key.
 *
 * Markets are the library's own list (loadMarkets), kept for five minutes: spot markets quoted in dollars or a dollar stablecoin, and LINEAR
 * perpetuals and futures quoted and settled in one. Inverse contracts, options and anything priced in another coin are not offered. A
 * market is named as the library names it: `BTC/USDT` spot, `BTC/USDT:USDT` the perpetual, `BTC/USDT:USDT-251226` a future. A contract
 * market is sized in contracts, and `contractSize` says how much of the coin one contract is. A perpetual the exchange's own record flags
 * as a PRE-IPO contract (live/preipo.ts: OKX's ruleType, Gate's is_pre_market, KuCoin's marketStage, MEXC's conceptPlate, Deribit's
 * underlying_type, Kraken Futures' category, each kept in the library market's `info`) carries the category "Pre-IPO", its company, the
 * valuation its price implies in the exchange's unit and the issuer's words; the start-from list (query empty) carries such perpetuals
 * after the well-known markets, so Markets groups them with the public venues'.
 *
 * An order is one createOrder, then one look at what became of it (fetchOrder, or what the exchange has instead), because most exchanges
 * answer an order with little more than its id. Every later look is the same call.
 *
 * What the library does not do for us, each from its own source or the exchange's own docs:
 *   · a MARKET order is sized in the coin and goes with no price: Binance and Bybit read a market order that carries a price as dollars to
 *     spend. Where the exchange takes a market buy only by what it costs (Coinbase, a classic Bybit account, and the others the library
 *     marks so), a plain market buy is refused rather than turned into a guessed amount of dollars;
 *   · a market order with a worst price goes as a limit order at that price that fills at once (time in force IOC), so its fill stays inside
 *     the price; that is also how a market buy reaches an exchange that sizes market buys in dollars;
 *   · OKX gets banAmend on a spot market order, so it does not quietly cut the size to fit the balance;
 *   · Coinbase takes the account's id as `client_order_id`: the library drops a `clientOrderId` there and writes its own;
 *   · Bybit answers fetchOrder only with `acknowledged: true`, and its closed orders are found through the order history;
 *   · what an order became is read from what filled, not from the status word alone: Bybit closes a partly filled spot order, and an IOC or
 *     market order that expires or is canceled may have filled in part;
 *   · the library's precision helpers cut a size to the step but check no minimum, so the smallest size and worth are checked here too;
 *   · a refusal is judged by what the exchange said, not only by the class the library picked: it files some under the wrong one.
 *
 * Beyond market and limit orders, only where the library and the exchange both take it and the trader has checked how the exchange keeps
 * it afterwards — OKX, Binance, Bybit, Coinbase and Kraken, each against the library's source and the exchange's docs:
 *   · a STOP-LIMIT is the exchange's own (OKX's trigger order, Binance's STOP_LOSS_LIMIT and its futures STOP, Bybit's conditional order,
 *     Coinbase's stop_limit_stop_limit_gtc, Kraken's stop-loss-limit). A STOP with a worst price goes as one whose limit is that worst price
 *     — filled at once and the rest canceled where the exchange takes a time in force on the order a trigger places — the way a market order
 *     with a worst price goes as a limit order there; a stop with none goes as the exchange's stop-market, where it has one;
 *   · OKX keeps trigger orders in a book of their own (algo orders), and so does Binance its futures stops (the algo service): such an
 *     order's ref says so (`trigger:<id>`), so that every later look, cancel and change goes to that book, across restarts of the account
 *     too. Once it fires, the order it placed is followed instead, under that order's own id;
 *   · the times in force and post-only each market takes, as the library lists them for that kind of market; reduce-only only on OKX's,
 *     Binance's and Bybit's perpetuals and futures, where the trader has checked that it reaches the exchange;
 *   · an open order changed in place where the exchange changes it in place (amend: never a cancel-and-replace, which would leave what had
 *     filled with the old order), what is held in perpetuals and futures (positions), and a perpetual's leverage (setLeverage);
 *   · no close of its own: OKX's closes the whole position at the market, with no size and no worst price, and Coinbase's is for its futures,
 *     whose positions are not listed here. The account closes a position with a reduce-only order, which goes inside a worst price.
 *
 * Reading the market (nothing signed, nothing placed), with nothing kept beyond the market list — the account's service keeps the answers:
 *   · a market's last 24 hours — its change, the dollars traded, its high and low — as the exchange's own ticker says them, at the five
 *     exchanges above and at KuCoin, each ticker read against the exchange's docs (dayOf); at any other exchange the library's unified
 *     reading of its ticker (percentage, change, quoteVolume, high, low), marked as the library's word (`statsFrom`), since neither its
 *     24-hour window nor its volume has been checked here; many markets' at once (stats), one fetchTickers per kind of market, Binance
 *     never for its whole list;
 *   · a perpetual's funding rate and when it is next paid (fetchFundingRate; Bybit's ticker carries it already), at OKX, Binance and Bybit;
 *     a dated future's expiry as when it stops trading;
 *   · price history (fetchOHLCV), at most 300 bars of 5 minutes, an hour or a day.
 */
import { isRefusal, type Refusal } from "../../core/errors.ts";
import { no } from "../refuse.ts";
import type { KeyFile } from "./credentials.ts";
import { exchangeSaidNo, isBinance, isBybit, isOkx, thrownHttp, type ExchangeClient } from "./exchange.ts";
import { impliedUsd, PRE_IPO_CATEGORY, preIpoOf } from "./preipo.ts";
import { badOrder, ceilTo, floorTo, inDollars, notionalOf, onStep, pick, plain, CANDLE_INTERVALS, DONE, type Candle, type CandleInterval, type LiveTrader, type Market, type MarketStats, type OrderChange, type OrderRequest, type OrderState, type OrderStatus, type OrderType, type Position, type TimeInForce } from "./trade.ts";
import { num, redact, transportCode, type LiveProbe, type MarginMode, type MarketExtras } from "./types.ts";

type Dict = Record<string, unknown>;
type Kind = "spot" | "perp" | "future";
/** a time in force as the library takes it */
type Tif = "GTC" | "IOC" | "FOK";

/** what the trader uses of the library beyond what a connection reads (exchange.ts): an order changed in place, what is held, a perpetual's
 * leverage and margin mode, and OKX's own call that changes a trigger order (the library's editOrder changes only a take-profit or stop-loss
 * algo order there) */
interface Library extends ExchangeClient {
  editOrder?(id: string, symbol: string, type: string, side: string, amount?: number, price?: number, params?: Dict): Promise<unknown>;
  fetchPositions?(symbols?: string[], params?: Dict): Promise<unknown[]>;
  setLeverage?(leverage: number, symbol?: string, params?: Dict): Promise<unknown>;
  setMarginMode?(marginMode: string, symbol?: string, params?: Dict): Promise<unknown>;
  /** OKX: POST /api/v5/trade/amend-algos */
  privatePostTradeAmendAlgos?(request: Dict): Promise<unknown>;
}

/** the exchanges whose stops, flags, order changes, positions and leverage the trader has checked (see the head of this file) */
type Family = "okx" | "binance" | "bybit" | "coinbase" | "kraken";
const familyOf = (id: string): Family | undefined => (isOkx(id) ? "okx" : isBinance(id) ? "binance" : isBybit(id) ? "bybit" : id === "coinbase" ? "coinbase" : id === "kraken" ? "kraken" : undefined);
/** the exchanges whose 24-hour ticker the trader has read against their docs: the five above, and KuCoin's spot API — GET /api/v1/market/stats
 * and /allTickers: "statistics of the specified ticker in the last 24 hours", changeRate and changePrice over the last 24 hours, high and low,
 * vol in the coin and volValue in the quote (KuCoin's docs, read 2026-10-06), which the library reads as percentage, change, high, low,
 * baseVolume and quoteVolume. Its futures API (kucoinfutures) is another host and another ticker, not read here */
type DayFamily = Family | "kucoin";
const dayFamilyOf = (id: string): DayFamily | undefined => familyOf(id) ?? (id === "kucoin" ? "kucoin" : undefined);

/** an order in an exchange's book of trigger orders, apart from its order book (OKX's algo orders, Binance's futures algo service) */
const TRIGGER = "trigger:";
const triggerId = (ref: string): string | undefined => (ref.startsWith(TRIGGER) && ref.length > TRIGGER.length ? ref.slice(TRIGGER.length) : undefined);

/** an order id as an exchange gives one: letters, digits and a few joiners, with no space and no markup. Anything else where an id should
 * be — MEXC's parser takes any string answer as the order's id, so a filtering network's 200 page would become one — is not an id */
const ID = /^[A-Za-z0-9_:.-]{1,128}$/;

/** What the exchange holds an order at, as it says it: its whole size (in the units it was placed in: coins, or contracts), its limit and its
 * stop. Carried beside trade.ts's OrderState, which names none of them, so the account can tell a change it did not hear confirmed from one
 * the exchange made (account/live-orders.ts) */
export interface OrderHeld {
  qty?: number | undefined;
  limitPrice?: number | undefined;
  stopPrice?: number | undefined;
}

/** an order the account could not hear placed, looked up again by the account's own id for it (account/live-orders.ts follows such an
 * order): its state; `null` when the exchange shows none under that id; `undefined` when it cannot be asked that way through the library */
export type ByClient = (clientId: string, symbol: string, type: OrderType) => Promise<OrderState | null | undefined | Refusal>;

/** how the library counts a precision (base/functions/number.js): a step, a number of decimal places, or a number of significant digits */
const DECIMAL_PLACES = 2;
const SIGNIFICANT_DIGITS = 3;
const TICK_SIZE = 4;

const LIST_MS = 5 * 60_000;
const WELL_KNOWN = ["BTC", "ETH", "SOL", "XRP", "DOGE", "BNB", "ADA", "LINK", "AVAX", "LTC"];
const QUOTES = ["USDT", "USDC", "USD"];
const WORDS: Record<OrderType, string> = { market: "market", limit: "limit", stop: "stop", stop_limit: "stop-limit" };
/** the most markets one stats call reads: Binance's futures are read one ticker at a time (GET /fapi/v1/ticker/24hr?symbol=, weight 1), so
 * forty of them never weigh more than its whole list does (40) */
const STATS_MAX = 40;
/** Binance spot tickers go twenty symbols a call: GET /api/v3/ticker/24hr weighs 2 for 1 to 20 symbols, 40 for 21 to 100, 80 for all */
const BINANCE_SYMBOLS = 20;
/** the kind of market as the library names it, where an exchange lists its tickers by kind */
const LIBRARY_KIND: Record<Kind, string> = { spot: "spot", perp: "swap", future: "future" };
/** the most bars one history reads, in one request: OKX's candles and Coinbase's take at most 300 a call */
const BARS = 300;
const BAR_MS: Record<CandleInterval, number> = { "5m": 300_000, "1h": 3_600_000, "1d": 86_400_000 };

const obj = (v: unknown): Dict => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Dict) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : typeof v === "number" ? String(v) : undefined);
/** the order's id, when it is one (ID) */
const idOf = (o: Dict): string | undefined => {
  const v = str(o.id);
  return v !== undefined && ID.test(v) ? v : undefined;
};
const pos = (v: unknown): number | undefined => (num(v) > 0 ? num(v) : undefined);
const finite = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);
const yes = (v: unknown): boolean => v === true || v === "true";
const positive = (x: number | undefined): x is number => x !== undefined && Number.isFinite(x) && x > 0;
const and = (xs: string[]): string => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
/** a time in milliseconds (a number, or digits in a string) as ISO 8601 */
const isoAt = (v: unknown): string | undefined => {
  const ms = finite(v);
  return ms !== undefined && ms > 0 ? new Date(ms).toISOString() : undefined;
};

/** a precision as the step it stands for; `undefined` when the exchange counts significant digits, which have no fixed step */
function stepOf(p: unknown, mode: number): number | undefined {
  if (p === undefined || p === null || p === "") return undefined;
  if (mode === DECIMAL_PLACES) return Number.isFinite(Number(p)) && Number(p) >= 0 ? Number((10 ** -Number(p)).toFixed(Math.max(0, Number(p)))) : undefined;
  if (mode === SIGNIFICANT_DIGITS) return undefined;
  return pos(p);
}

/** the step of a price of `digits` significant digits around `x` */
function sigStep(x: number, digits: number): number | undefined {
  if (!(x > 0) || !(digits > 0)) return undefined;
  const e = Math.floor(Math.log10(x)) - digits + 1;
  return Number((10 ** e).toFixed(Math.max(0, -e)));
}

// what the library's errors say, where its class is not enough (ccxt.md §6: the classes marked ⚠ there)
const NOT_FOUND = /order (does not|doesn't) exist|unknown order|order not found|order \S+ was not found|"(51603|51400|51401|51402)"|"error"\s*:\s*"NOT_FOUND"|UNKNOWN_CANCEL_ORDER/i;
const INSUFFICIENT = /insufficient|not enough (balance|funds|margin|available)|"(51008|51119|51131|51127)"/i;
const CLOSED = /market is closed|not open yet|not available for api trading|UNTRADABLE_PRODUCT|ORDER_ENTRY_DISABLED|INVALID_FCM_TRADING_SESSION|in (cancel_only|post_only|limit_only|reduce_only) mode|trading (is )?(halted|suspended|paused)|"51022"/i;
const NO_PERMISSION = /EAccount:Invalid permissions|EGeneral:Permission denied|PERMISSION_DENIED|not permitted for this account|may not place or cancel orders|trading is not enabled/i;
const INVALID = /filter failure|too much precision|INVALID_(SIZE|PRICE)_PRECISION|INVALID_LIMIT_PRICE|minimum not met|tick size|invalid price|invalid arguments:(volume|price)|lot size|"(51020|51121|51006|51007|51116|51137|51138)"/i;
const INVALID_KINDS = new Set(["InvalidOrder", "BadSymbol", "DuplicateOrderId", "OrderImmediatelyFillable", "OrderNotFillable", "ContractUnavailable"]);
/** an order call that failed this way may still have reached the exchange (OKX 50004: "does not indicate success or failure of order"),
 * and so may one cut off beneath the library (the names exchange.ts reads as a connection cut) */
const UNSURE = new Set(["RequestTimeout", "NetworkError", "ExchangeNotAvailable", "TimeoutError", "AbortError", "SocketError", "BodyTimeoutError", "HeadersTimeoutError", "RequestAbortedError"]);
/** A write whose answer was lost: what the library threw says the exchange did not answer (never a ban or a wait it asked for), and the
 * call may have reached it — a timeout, a connection cut or reset, a gateway's 5xx, a page answered in the exchange's place. Such a write is
 * never told as refused (live/earn.ts reads its moves by the same rule) */
export function lostAnswer(err: unknown, r: Refusal): boolean {
  if (r.code !== "E_VENUE_UNREACHABLE" || (r.native as { until?: unknown } | undefined)?.until !== undefined) return false;
  const kind = String((err as { name?: string })?.name ?? "");
  const status = thrownHttp(String((err as { message?: string })?.message ?? err))?.status ?? 0;
  // "not available" is the library's name for 4xx answers too (451, 403, 404 …): an exchange that answered with a status said no, and only
  // one with no status, or a 5xx, may have taken the write
  const unsureKind = UNSURE.has(kind) && !(kind === "ExchangeNotAvailable" && status > 0 && status < 500);
  return unsureKind || status >= 500 || transportCode(err) !== undefined || (r.native as { page?: unknown } | undefined)?.page === true;
}
/** a leverage or margin mode that is already what was asked: Binance -4046 "No need to change margin type." (the library's
 * MarginModeAlreadySet), Bybit 110026 (the same class) and 110043 "Set leverage not modified" (filed as a bad request) */
const UNCHANGED = /"?110043"?|leverage not modified|No need to change margin type/i;

class Said extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

/** may this key trade this kind of market, by what the exchange said about it when it was connected (exchange.ts, probe) */
function mayTrade(id: string, said: string[], kind: "spot" | "contract"): boolean | "unknown" {
  if (!said.length) return "unknown";
  const has = (w: string) => said.includes(w);
  if (isBinance(id)) return kind === "spot" ? has("trade spot and margin") : has("trade futures");
  if (isOkx(id)) return has("trade");
  if (isBybit(id)) return kind === "spot" ? has("trade spot") : has("trade contracts");
  if (id === "coinbase") return has("trade");
  if (id === "kucoin") return has("trade (unified account)") || (kind === "spot" ? has("trade spot") : has("trade futures"));
  return said.some((w) => /\btrade\b/.test(w));
}

export function exchangeTrader(client: ExchangeClient, venue: string, name: string, secrets: string[], probe: Pick<LiveProbe, "can">, opts: { now?: () => number } = {}): LiveTrader {
  const now = opts.now ?? Date.now;
  const key: KeyFile = Object.fromEntries(secrets.map((s, i) => [String(i), s]));
  const id = client.id;
  const lib = client as Library;
  const fam = familyOf(id);
  const dayFam = dayFamilyOf(id);
  const mode = typeof client.precisionMode === "number" ? client.precisionMode : TICK_SIZE;
  let loadedAt = 0;
  let all = new Map<string, Dict>();
  let list: Market[] = [];

  const kindOf = (r: Dict): Kind | undefined => {
    if (r.option === true) return undefined;
    if (r.spot === true || r.type === "spot") return "spot";
    if (r.linear !== true) return undefined;
    if (r.swap === true || r.type === "swap") return "perp";
    if (r.future === true || r.type === "future") return "future";
    return undefined;
  };
  const dollars = (r: Dict, kind: Kind) => inDollars(String(r.quote ?? "")) && (kind === "spot" || inDollars(String(r.settle ?? "")));
  const contractsHere = client.has?.swap === true || client.has?.future === true;
  const offersContracts = () => (loadedAt ? list.some((m) => m.kind !== "spot") : contractsHere);
  /** a perpetual's leverage is set from the account here (setLeverage below is attached on the same terms) */
  const leverageHere = (fam === "okx" || fam === "binance" || fam === "bybit") && contractsHere && client.has?.setLeverage === true && typeof lib.setLeverage === "function";
  /** the margin modes a contract's leverage is set with here, where that is known before asking the exchange: Binance sets the margin type per
   * symbol, either; the account's OKX orders go in cross margin, so cross. Bybit's depends on the account — per symbol on a classic one, the
   * whole account's on a unified one — which market() asks (bybitModes) */
  const marginModesOf = (kind: Kind): MarginMode[] | undefined => (!leverageHere || kind === "spot" ? undefined : fam === "okx" ? ["cross"] : fam === "binance" ? ["cross", "isolated"] : undefined);
  let bybitUnified: boolean | undefined;
  const bybitModes = async (kind: Kind): Promise<MarginMode[] | undefined> => {
    if (!leverageHere || fam !== "bybit" || kind === "spot") return undefined;
    if (bybitUnified === undefined) {
      try {
        const u = client.isUnifiedEnabled ? await client.isUnifiedEnabled() : undefined;
        bybitUnified = Array.isArray(u) ? u[0] === true || u[1] === true : undefined;
      } catch {
        bybitUnified = undefined;
      }
    }
    return bybitUnified === undefined ? undefined : bybitUnified ? [] : ["cross", "isolated"];
  };
  const allowed = (kind: Kind) => mayTrade(id, probe.can, kind === "spot" ? "spot" : "contract");
  const feature = (kind: Kind): Dict => {
    const f = obj(client.features);
    return obj(obj(kind === "spot" ? f.spot : obj(f[kind === "perp" ? "swap" : "future"]).linear).createOrder);
  };
  /** the exchange takes a market buy only by what it costs (the library's own flags for it) */
  const buysByCost = (): boolean => {
    const o = obj(client.options);
    return feature("spot").marketBuyRequiresPrice === true || o.createMarketBuyOrderRequiresPrice === true || obj(o.createOrder).createMarketBuyOrderRequiresPrice === true;
  };
  /** Binance lists the order types of each market (exchangeInfo `orderTypes`), and the library refuses one not on the list */
  const orderTypesOf = (r: Dict): string[] | undefined => {
    const t = obj(r.info).orderTypes;
    return Array.isArray(t) ? t.map((x) => String(x).toUpperCase()) : undefined;
  };
  /** the exchange takes a time in force on the limit order a stop places, in this kind of market: Binance on STOP_LOSS_LIMIT and on its
   * futures algo order, Bybit on a conditional order, OKX on its futures' and perpetuals' trigger orders only (advanceOrdType) */
  const childTif = (kind: Kind): boolean => fam === "binance" || fam === "bybit" || (fam === "okx" && kind !== "spot");

  /** what the library threw, as the account's refusal, in the exchange's own words with nothing secret in them. The words are read whole
   * and kept cut: Coinbase's error_response carries its failure reason after the message, preview_failure_reason and error_details, well
   * past the first 240 characters */
  const fail = (err: unknown, ref?: string): Refusal => {
    if (isRefusal(err)) return err;
    const kind = String((err as { name?: string })?.name ?? "");
    const whole = redact(String((err as { message?: string })?.message ?? err), secrets).replace(/\s+/g, " ");
    const said = whole.slice(0, 240);
    const native = { error: kind, said };
    const plainNo = exchangeSaidNo(venue, name, err, key);
    if (plainNo.code === "E_VENUE_GEOBLOCKED") return plainNo;
    // Coinbase's place rule arrives as an order failure reason, which the library files as a plain error (ccxt.md §6, region row); where it
    // lies past the cut, the reason itself is kept with the words
    const fence = /"?(new_order_failure_reason|preview_failure_reason|failure_reason|error)"?\s*:\s*"?GEOFENCING_RESTRICTION/.exec(whole)?.[1];
    if (/GEOFENCING_RESTRICTION/.test(whole)) return no("E_VENUE_GEOBLOCKED", { venue, message: `${name} does not serve this location: that is its own rule, and the account does not look for a way around it`, native: { ...native, ...(said.includes("GEOFENCING_RESTRICTION") ? {} : { reason: `${fence ?? "failure_reason"}: GEOFENCING_RESTRICTION` }) } });
    if (kind === "OrderNotFound" || NOT_FOUND.test(whole)) return no("E_ACCOUNT_ORDER_UNKNOWN", { venue, message: ref ? `${name} has no order ${ref} for this key` : `${name} has no such order for this key`, ...(ref ? { detail: { order: ref } } : {}), native });
    if (kind === "InsufficientFunds" || INSUFFICIENT.test(whole)) return no("E_VENUE_INSUFFICIENT", { venue, message: `${name}: not enough balance there for this order`, native });
    if (kind === "MarketClosed" || CLOSED.test(whole)) return no("E_VENUE_MARKET_CLOSED", { venue, message: `${name} takes no orders in this market now`, native });
    if (NO_PERMISSION.test(whole)) return no("E_VENUE_PERMISSION", { venue, message: `${name} refused: the key lacks the permission for this, or this machine's IP is not on the key's list`, native });
    if (plainNo.code !== "E_VENUE_REJECTED") return plainNo;
    if (INVALID_KINDS.has(kind) || INVALID.test(whole)) return no("E_VENUE_ORDER_INVALID", { venue, message: `${name}: it does not take this order as written (its size, step, price or minimum)`, native });
    return plainNo;
  };
  /** a refusal that is the exchange's own and final, after which nothing more is asked of it */
  const final = (r: Refusal) => r.code === "E_VENUE_PERMISSION" || r.code === "E_VENUE_UNAUTHORIZED" || r.code === "E_VENUE_GEOBLOCKED" || r.code === "E_VENUE_UNREACHABLE";

  /** the library's market list, kept five minutes; a list that cannot be reloaded is used as it was. A load that failed is let go: the
   * library keeps the failed promise and hands it to every later call that does not ask for a reload — its own createOrder and fetchBalance
   * among them — without asking the exchange again (base/Exchange.js loadMarkets), so one timeout or one edge page at the first load would
   * refuse every trade on this client until a restart. Let go, the next call asks the exchange; after a failed reload, the list already
   * loaded answers the library's own calls */
  const load = async (): Promise<Refusal | undefined> => {
    if (loadedAt && now() - loadedAt < LIST_MS) return undefined;
    try {
      await client.loadMarkets?.(loadedAt > 0);
    } catch (err) {
      const kept = client as { marketsLoading?: unknown; reloadingMarkets?: boolean };
      if ("marketsLoading" in kept) {
        kept.marketsLoading = undefined;
        kept.reloadingMarkets = false;
      }
      if (loadedAt) return undefined;
      return fail(err);
    }
    const next = new Map<string, Dict>();
    const offered: Market[] = [];
    for (const v of Object.values(client.markets ?? {})) {
      const raw = obj(v);
      const symbol = str(raw.symbol);
      if (!symbol) continue;
      next.set(symbol, raw);
      const kind = kindOf(raw);
      if (!kind || !dollars(raw, kind)) continue;
      // offered when it takes orders now: by the exchange's own flags, which the library's `active` does not all carry
      const m = toMarket(raw, kind);
      if (m.open) offered.push(m);
    }
    const baseRank = (m: Market) => (WELL_KNOWN.includes(m.base) ? WELL_KNOWN.indexOf(m.base) : WELL_KNOWN.length);
    const kindRank = (m: Market) => ["spot", "perp", "future"].indexOf(m.kind);
    const quoteRank = (m: Market) => (QUOTES.includes(m.quote) ? QUOTES.indexOf(m.quote) : QUOTES.length);
    offered.sort((a, b) => baseRank(a) - baseRank(b) || kindRank(a) - kindRank(b) || quoteRank(a) - quoteRank(b) || a.symbol.localeCompare(b.symbol));
    all = next;
    list = offered;
    loadedAt = now();
    return undefined;
  };

  /** whether the exchange takes orders in it now, and which; the exchange's own flags where the library leaves them in `info`. `held`: the
   * exchange holds the market to limit orders, or to ones that rest on its book */
  const tradable = (r: Dict, symbol: string): { open: boolean; note?: string; types: OrderType[]; held?: "limit_only" | "post_only" } => {
    const info = obj(r.info);
    let types: OrderType[] = ["market", "limit"];
    let held: "limit_only" | "post_only" | undefined;
    const listed = orderTypesOf(r);
    if (listed) types = types.filter((t) => listed.includes(t.toUpperCase()));
    const notes: string[] = [];
    if (id === "coinbase") {
      // Coinbase product flags (GET /api/v3/brokerage/market/products): the library reads only trading_disabled into `active`
      if (yes(info.cancel_only)) return { open: false, note: `${name} takes only cancellations in ${symbol} now`, types };
      if (yes(info.limit_only)) {
        types = ["limit"];
        held = "limit_only";
        notes.push(`${name} takes only limit orders in ${symbol} now`);
      }
      if (yes(info.post_only)) {
        types = ["limit"];
        held = "post_only";
        notes.push(`${name} takes only orders that rest on its book in ${symbol} now: a limit order that would fill at once is refused`);
      }
    }
    if (id === "kraken" && typeof info.status === "string" && info.status !== "online") {
      // Kraken AssetPairs `status`: limit_only and post_only still take limit orders; the library counts only "online" as active
      if (info.status === "limit_only" || info.status === "post_only") return { open: true, note: `${name} has ${symbol} in ${info.status.replace("_", "-")} mode: limit orders only${info.status === "post_only" ? ", and only ones that rest on its book" : ""}`, types: ["limit"], held: info.status };
      return { open: false, note: `${name} has ${symbol} in ${info.status.replace(/_/g, "-")} mode`, types };
    }
    if (r.active === false) {
      const word = str(info.status) ?? str(info.state);
      return { open: false, note: `${name} is not trading ${symbol} now${word ? ` (it says: ${word})` : ""}`, types };
    }
    if (types.includes("market") && r.spot === true && !isBybit(id) && buysByCost()) notes.push(`${name} takes a market buy only by what it costs: a market buy here goes as a limit order at its worst price, filled at once`);
    return { open: true, ...(notes.length ? { note: notes.join(" · ") } : {}), types, ...(held ? { held } : {}) };
  };

  /** the stop orders a market takes through the library, where the trader knows how the exchange keeps them afterwards: OKX's trigger orders
   * and Bybit's conditional orders in every market; Binance's where the market lists the stop-limit (STOP_LOSS_LIMIT in spot, STOP in
   * futures); Coinbase's and Kraken's stop-limits in spot */
  const stopsIn = (r: Dict, kind: Kind): OrderType[] => {
    const listed = orderTypesOf(r) ?? [];
    if (fam === "okx" || fam === "bybit") return ["stop", "stop_limit"];
    if (fam === "binance") return listed.includes(kind === "spot" ? "STOP_LOSS_LIMIT" : "STOP") ? ["stop", "stop_limit"] : [];
    if ((fam === "coinbase" || fam === "kraken") && kind === "spot") return ["stop", "stop_limit"];
    return [];
  };

  /** what a market takes besides market and limit orders: its stops (only where it takes both and is not held to limit orders), the times in
   * force and post-only the library lists for this kind of market (Binance's post-only is LIMIT_MAKER, which a spot market lists or not),
   * reduce-only on a contract where the trader has checked it, the most leverage a contract takes, and whether a sell can only sell what is
   * held (a spot market here trades the account's own coins, with no borrowing: OKX tdMode cash, Bybit isLeverage 0) */
  const options = (r: Dict, kind: Kind, t: { types: OrderType[]; held?: string | undefined }) => {
    const limits = t.types.includes("limit");
    const tif = obj(feature(kind).timeInForce);
    const listed = orderTypesOf(r);
    const types: OrderType[] = [...t.types, ...(t.types.includes("market") && t.held === undefined ? stopsIn(r, kind) : [])];
    const tifs = limits ? (t.held === "post_only" ? ["GTC"] : ["GTC", "IOC", "FOK"]).filter((k) => tif[k] === true).map((k) => k.toLowerCase() as TimeInForce) : [];
    const postOnly = limits && (tif.PO === true || t.held === "post_only") && !(fam === "binance" && kind === "spot" && !(listed ?? []).includes("LIMIT_MAKER"));
    const reduceOnly = kind !== "spot" && (fam === "okx" || fam === "binance" || fam === "bybit");
    const sellsReduce = kind === "spot" && fam !== undefined;
    const maxLeverage = kind !== "spot" ? pos(obj(obj(r.limits).leverage).max) : undefined;
    // the times in force each type takes here, as place holds them (tifOf): a market order fills at once (never gtc), a stop waits until
    // canceled (gtc only), a stop-limit's order takes ioc or fok only where the exchange takes them on the order a stop places
    const tifsByType: Partial<Record<OrderType, TimeInForce[]>> = {};
    if (tifs.length) {
      if (types.includes("market")) tifsByType.market = tifs.filter((x) => x !== "gtc");
      if (types.includes("stop")) tifsByType.stop = tifs.filter((x) => x === "gtc");
      if (types.includes("stop_limit")) tifsByType.stop_limit = childTif(kind) ? tifs : tifs.filter((x) => x === "gtc");
    }
    return { types, tifs, tifsByType, postOnly, reduceOnly, sellsReduce, maxLeverage };
  };

  function toMarket(r: Dict, kind: Kind): Market & MarketExtras {
    const symbol = String(r.symbol);
    const base = String(r.base ?? "");
    const quote = String(r.quote ?? "");
    const settle = str(r.settle);
    const precision = obj(r.precision);
    const limits = obj(r.limits);
    // Kraken's price steps are its pairs' tick_size: the library uses 10^-pair_decimals, which a few pairs do not tick in (ccxt.md §2)
    const priceStep = (id === "kraken" ? pos(obj(r.info).tick_size) : undefined) ?? stepOf(precision.price, mode);
    const qtyStep = stepOf(precision.amount, mode);
    const minQty = pos(obj(limits.amount).min);
    const minNotional = pos(obj(limits.cost).min);
    // a dated future stops trading at its expiry, which the library gives as expiryDatetime (and expiry, in milliseconds)
    const expires = kind === "future" ? (str(r.expiryDatetime) ?? isoAt(r.expiry)) : undefined;
    const expiry = expires?.slice(0, 10);
    const pair = `${base}/${quote}`;
    const label = kind === "spot" ? `${pair} spot` : `${pair} ${kind === "perp" ? "perpetual" : `future${expiry ? ` to ${expiry}` : ""}`}${settle && settle !== quote ? `, settled in ${settle}` : ""}`;
    const t = tradable(r, symbol);
    const more = options(r, kind, t);
    const counting = mode === SIGNIFICANT_DIGITS ? `${name} counts prices here in ${num(precision.price)} significant digits` : undefined;
    const note = [t.note, counting].filter(Boolean).join(" · ");
    const marginModes = marginModesOf(kind);
    // a pre-IPO perpetual, by the exchange's own flag in its record (live/preipo.ts): its company, the unit its price is in, the issuer's words
    const pre = kind === "perp" ? preIpoOf(id, obj(r.info), base, str(r.id) ?? symbol) : undefined;
    return {
      symbol,
      name: label,
      kind,
      base,
      quote,
      ...(minQty !== undefined ? { minQty } : {}),
      ...(qtyStep !== undefined ? { qtyStep } : {}),
      ...(priceStep !== undefined ? { priceStep } : {}),
      ...(minNotional !== undefined ? { minNotional } : {}),
      ...(kind !== "spot" ? { contractSize: pos(r.contractSize) ?? 1 } : {}),
      ...(expires ? { closeTime: expires } : {}),
      open: t.open,
      ...(note ? { note } : {}),
      types: more.types,
      ...(more.tifs.length ? { tifs: more.tifs } : {}),
      ...(Object.keys(more.tifsByType).length ? { tifsByType: more.tifsByType } : {}),
      ...(more.postOnly ? { postOnly: true } : {}),
      ...(more.reduceOnly ? { reduceOnly: true } : {}),
      ...(more.sellsReduce ? { sellsReduce: true } : {}),
      ...(more.maxLeverage !== undefined ? { maxLeverage: more.maxLeverage } : {}),
      ...(marginModes ? { marginModes } : {}),
      ...(pre ? { category: pre.category, group: pre.group, implied: pre.implied, ...(pre.issuer ? { issuer: pre.issuer, eligibility: pre.eligibility } : {}) } : {}),
    };
  }

  /** one market by the library's symbol (any case), or the reason it is not one the account trades. `reading`: only its prices are read,
   * which a key that may not trade it does not stop */
  const find = async (symbol: string, reading = false): Promise<{ m: Market; raw: Dict; kind: Kind } | Refusal> => {
    const failed = await load();
    if (failed) return failed;
    const s = symbol.trim();
    const r = all.get(s) ?? [...all.values()].find((x) => String(x.symbol).toUpperCase() === s.toUpperCase());
    if (!r) return no("E_VENUE_REJECTED", { venue, message: `${name} lists no market "${s}": a market is named as the library names it, BTC/USDT for spot or BTC/USDT:USDT for the perpetual` });
    const sym = String(r.symbol);
    const kind = kindOf(r);
    if (r.option !== true && r.inverse === true) return no("E_ACCOUNT_UNPRICED", { venue, message: `${sym} is an inverse contract, settled in ${String(r.settle ?? r.base)}: the account trades contracts settled in dollars, so that every limit means dollars` });
    if (!kind) return no("E_VENUE_REJECTED", { venue, message: `${sym} is ${r.option === true ? "an option" : `a ${String(r.type ?? "market")} market`} at ${name}: the account trades spot markets and linear perpetuals and futures` });
    if (!inDollars(String(r.quote ?? ""))) return no("E_ACCOUNT_UNPRICED", { venue, message: `${sym} is priced in ${String(r.quote)}: the account trades markets priced in dollars, so that every limit means dollars` });
    if (!dollars(r, kind)) return no("E_ACCOUNT_UNPRICED", { venue, message: `${sym} is settled in ${String(r.settle)}: the account trades contracts settled in dollars, so that every limit means dollars` });
    if (!reading && allowed(kind) === false) return no("E_VENUE_PERMISSION", { venue, message: `${name}: this key may not trade ${kind === "spot" ? "spot markets" : "perpetuals and futures"} (the exchange says it can: ${probe.can.join(", ")}). That is set on the key at the exchange`, detail: { said: probe.can } });
    return { m: toMarket(r, kind), raw: r, kind };
  };

  /** an order as the account keeps it: what filled decides, the status word only where nothing says otherwise; and what the exchange holds
   * it at (OrderHeld) */
  const stateOf = (o: Dict, contractSize: number | undefined, ref?: string): OrderState & OrderHeld => {
    const word = str(o.status);
    const filledKnown = o.filled !== undefined && o.filled !== null;
    const filled = Math.max(0, num(o.filled));
    const amount = num(o.amount);
    const short = amount > 0 && filled < amount * (1 - 1e-9);
    let status: OrderStatus;
    if (word === "closed") status = filledKnown && (filled === 0 || short) ? "canceled" : "filled";
    else if (word === "open") status = filled > 0 ? "partial" : "open";
    else if (word === "canceled" || word === "cancelled") status = "canceled";
    else if (word === "expired") status = "expired";
    else if (word === "rejected") status = "rejected";
    // undefined, PENDING, PENDING_NEW, QUEUED, canceling: taken, not settled yet
    else status = filled > 0 ? "partial" : "pending";
    const average = pos(o.average) ?? (filled > 0 && pos(o.cost) ? num(o.cost) / (filled * (contractSize ?? 1)) : undefined);
    const fee = feeUsd(o);
    const venueWord = venueWordOf(o);
    const native: Dict = { id: idOf(o) ?? ref ?? null, clientOrderId: str(o.clientOrderId) ?? null, symbol: str(o.symbol) ?? null, type: str(o.type) ?? null, side: str(o.side) ?? null, status: word ?? null, ...(venueWord ? { venueStatus: venueWord } : {}), amount: o.amount ?? null, filled: o.filled ?? null, average: o.average ?? null, cost: o.cost ?? null, fees: Array.isArray(o.fees) ? o.fees : [] };
    const qty = pos(o.amount);
    const limitPrice = str(o.type) === "limit" ? pos(o.price) : undefined;
    const stopPrice = pos(o.triggerPrice) ?? pos(o.stopPrice);
    return { ref: idOf(o) ?? ref ?? "", status, filledQty: filled, ...(average !== undefined ? { avgPrice: average } : {}), ...(fee !== undefined ? { feeUsd: fee } : {}), native, ...(qty !== undefined ? { qty } : {}), ...(limitPrice !== undefined ? { limitPrice } : {}), ...(stopPrice !== undefined ? { stopPrice } : {}) };
  };
  /** an answer that is the exchange's about order `id`: it names that order, and says something of it (its status or its size). A page a
   * filtering network answered with, or an empty body, parses into an order with no id — or, at Kraken, with the id that was asked and
   * nothing else — and is not the exchange saying "pending, nothing filled" */
  const theOrder = (o: Dict, id: string): Dict => {
    if (idOf(o) === id && (str(o.status) !== undefined || pos(o.amount) !== undefined)) return o;
    throw no("E_VENUE_UNREACHABLE", { venue, message: `${name} did not answer about order ${id}: what came back names no such order, so it is not taken as ${name}'s answer`, detail: { order: id }, native: { answer: "not the order" } });
  };
  /** the exchange's own status word for an order, from what the library left in `info` (an algo order's `state` at OKX, `algoStatus` at Binance) */
  function venueWordOf(o: Dict): string | undefined {
    const info = obj(o.info);
    return str(info.status) ?? str(info.state) ?? str(info.orderStatus) ?? str(info.algoStatus);
  }

  /** the order's fees in dollars, when every fee it paid was in dollars; read from `fees` (Coinbase's and Kraken's `fee.cost` is a string) */
  function feeUsd(o: Dict): number | undefined {
    const fees = (Array.isArray(o.fees) && o.fees.length ? o.fees : o.fee ? [o.fee] : []).map(obj).filter((f) => f.cost !== undefined && f.cost !== null && f.cost !== "");
    if (!fees.length) return undefined;
    const paid = fees.filter((f) => num(f.cost) !== 0);
    const dollar = (f: Dict) => typeof f.currency === "string" && inDollars(f.currency);
    if (!paid.length) return fees.some(dollar) ? 0 : undefined;
    return paid.every(dollar) ? Number(paid.reduce((s, f) => s + num(f.cost), 0).toFixed(10)) : undefined;
  }

  const able = (m: keyof ExchangeClient): boolean => typeof client[m] === "function" && (client.has === undefined || Boolean(client.has[m]));
  const listed = (rows: unknown, ref: string): Dict | undefined => (Array.isArray(rows) ? rows.map(obj).find((o) => str(o.id) === ref) : undefined);

  /** what became of an order in the exchange's order book: fetchOrder where the exchange has it; elsewhere what it has instead (ccxt.md §5).
   * Bybit's conditional orders are in the same lists: a unified account lists all kinds of order unless told otherwise (v5 Get open orders,
   * orderFilter) */
  const lookup = async (ref: string, symbol: string): Promise<Dict> => {
    if (isBybit(id)) {
      // Bybit: open orders by GET /v5/order/realtime, closed ones by GET /v5/order/history; its fetchOrder wants `acknowledged`
      if (client.fetchOpenOrder) {
        try {
          return obj(await client.fetchOpenOrder(ref, symbol));
        } catch (err) {
          if (String((err as { name?: string })?.name) !== "OrderNotFound") throw err;
        }
      }
      if (client.fetchCanceledAndClosedOrders) {
        const hit = listed(await client.fetchCanceledAndClosedOrders(symbol, undefined, undefined, { orderId: ref }), ref);
        if (hit) return hit;
      }
      if (client.fetchOrder) return obj(await client.fetchOrder(ref, symbol, { acknowledged: true }));
      throw new Said("OrderNotFound", `order ${ref} was not found`);
    }
    if (able("fetchOrder")) return obj(await client.fetchOrder!(ref, symbol));
    let asked = false;
    if (able("fetchOpenOrder")) {
      asked = true;
      try {
        return obj(await client.fetchOpenOrder!(ref, symbol));
      } catch (err) {
        if (String((err as { name?: string })?.name) !== "OrderNotFound") throw err;
      }
    }
    for (const m of ["fetchOpenOrders", "fetchClosedOrders", "fetchCanceledAndClosedOrders", "fetchOrders"] as const) {
      if (!able(m)) continue;
      asked = true;
      const hit = listed(await client[m]!(symbol), ref);
      if (hit) return hit;
    }
    if (!asked) throw no("E_VENUE_REJECTED", { venue, message: `${name} has no call, through the library, that says what became of an order: look at it at the exchange` });
    throw new Said("OrderNotFound", `order ${ref} was not found`);
  };

  /** whether a trigger order has fired, and the order it placed then: OKX's `ordId` (or the first of `ordIdList`) once the algo order is
   * effective (Get algo order details), Binance's `actualOrderId` once the algo order is TRIGGERED, or FINISHED in the order book (Query Algo
   * Order) */
  const firedAs = (algo: Dict): { fired: boolean; child?: string } => {
    const info = obj(algo.info);
    const word = str(info.state) ?? str(info.algoStatus);
    if (word !== "effective" && word !== "partially_effective" && word !== "TRIGGERED" && word !== "FINISHED") return { fired: false };
    const many = Array.isArray(info.ordIdList) ? info.ordIdList.map(str).filter((x): x is string => x !== undefined) : [];
    const child = str(info.ordId) ?? many[0] ?? str(info.actualOrderId);
    return { fired: true, ...(child && ID.test(child) ? { child } : {}) };
  };

  /** a trigger order as its book shows it, when there is no order it placed to read instead */
  const algoState =(algo: Dict, contractSize: number | undefined, ref: string): OrderState & OrderHeld => {
    const s = { ...stateOf(algo, contractSize, ref), ref };
    const word = venueWordOf(algo);
    // fired with the order it placed not named yet, or on its way to the order book (Binance TRIGGERING): taken, not settled. Never filled
    // by the algo order's own word: the library calls an effective one closed and fills it whole, before anything has traded
    if (firedAs(algo).fired || word === "TRIGGERING") return { ref, status: "pending", filledQty: 0, native: s.native };
    // OKX order_failed: it fired and the order it was to place failed (failCode says why, e.g. 51008); the library calls it canceled
    if (word === "order_failed") return { ref, status: "rejected", filledQty: 0, native: { ...(s.native as Dict), failCode: str(obj(algo.info).failCode) ?? null } };
    return s;
  };

  /** what became of an order, under the ref the account follows it by. An order in a trigger book is read there; once it has fired, the order
   * it placed is read instead and answered under its own id, which the account follows from then on. Only an answer about that order is
   * one (theOrder): anything else throws, and the account keeps what it knew */
  const read = async (ref: string, symbol: string, contractSize: number | undefined): Promise<OrderState & OrderHeld> => {
    const t = triggerId(ref);
    if (t === undefined) return stateOf(theOrder(await lookup(ref, symbol), ref), contractSize, ref);
    const algo = theOrder(obj(await client.fetchOrder!(t, symbol, { trigger: true })), t);
    const { child } = firedAs(algo);
    if (child === undefined) return algoState(algo, contractSize, ref);
    const s = stateOf(theOrder(await lookup(child, symbol), child), contractSize, child);
    return { ...s, native: { ...(s.native as Dict), trigger: { id: t, status: venueWordOf(algo) ?? null } } };
  };

  /** an order looked up by the account's id, after an order call that may or may not have reached the exchange (ccxt.md §5, by client id).
   * `null`: looked, and none is there; `undefined`: this exchange cannot be asked that way through the library. `book`: the order went to the
   * exchange's trigger book, where OKX knows it by algoClOrdId and Binance by clientAlgoId (the library maps clientOrderId to both) */
  const byClientId = async (symbol: string, cid: string, book: boolean): Promise<Dict | null | undefined> => {
    // the order the exchange shows under the account's id: one with an id of its own, carrying that client id back (in a trigger book, as
    // OKX's algoClOrdId or Binance's clientAlgoId). An answer that names neither is not "none there" — it cannot tell
    const isMine = (o: Dict) => idOf(o) !== undefined && [o.clientOrderId, ...(book ? [obj(o.info).algoClOrdId, obj(o.info).clientAlgoId] : [])].some((c) => str(c) === cid);
    const mine = (rows: unknown) => (Array.isArray(rows) ? rows.map(obj).find(isMine) : undefined);
    if ((isOkx(id) || isBinance(id)) && client.fetchOrder) {
      try {
        const o = obj(await client.fetchOrder(undefined, symbol, { clientOrderId: cid, ...(book ? { trigger: true } : {}) }));
        return isMine(o) ? o : undefined;
      } catch (err) {
        if (String((err as { name?: string })?.name) === "OrderNotFound") return null;
        throw err;
      }
    }
    if (isBybit(id) && client.fetchOpenOrders && client.fetchCanceledAndClosedOrders) {
      return mine(await client.fetchOpenOrders(symbol, undefined, undefined, { orderLinkId: cid })) ?? mine(await client.fetchCanceledAndClosedOrders(symbol, undefined, undefined, { orderLinkId: cid })) ?? null;
    }
    if (id === "kraken" && client.fetchOpenOrders && client.fetchClosedOrders) {
      // Kraken takes cl_ord_id on OpenOrders and ClosedOrders; its fetchOrder would send it as userref instead
      return mine(await client.fetchOpenOrders(undefined, undefined, undefined, { clientOrderId: cid })) ?? mine(await client.fetchClosedOrders(undefined, undefined, undefined, { clientOrderId: cid })) ?? null;
    }
    return undefined;
  };
  /** an order found by the account's id (byClientId: it has an id of its own), as the account keeps it: under the trigger book's ref when it
   * went there */
  const foundState = (found: Dict, contractSize: number | undefined, book: boolean): OrderState & OrderHeld => {
    if (!book) return stateOf(found, contractSize);
    return algoState(found, contractSize, TRIGGER + idOf(found)!);
  };

  /** the account's id as the exchange takes it: Coinbase as client_order_id; OKX alphanumeric up to 32; Kraken a short UUID (32 hex) or up to
   * 18 characters; Binance and Bybit up to 36 of [A-Za-z0-9_-]. Thirty-two hex digits suit them all */
  const idParam = (clientId: string): { cid: string; params: Dict } => {
    const clean = clientId.replace(/[^A-Za-z0-9]/g, "");
    if (id === "coinbase") return { cid: clean.slice(0, 36), params: { client_order_id: clean.slice(0, 36) } };
    const cid = id === "kraken" ? (/^[0-9a-f]{32}$/i.test(clean) ? clean : clean.slice(0, 18)) : clean.slice(0, 32);
    return { cid, params: { clientOrderId: cid } };
  };

  /** a size or a price on the market's own step, and exactly as the library will send it: an order is never cut or rounded on its way out.
   * Both are asked because they can differ: Kraken's library price is rounded to pair_decimals, Kraken itself takes tick_size */
  const exact = (symbol: string, x: number, what: "size" | "price", step: number | undefined): Refusal | undefined => {
    let sent: string | undefined;
    try {
      sent = what === "size" ? client.amountToPrecision?.(symbol, x) : client.priceToPrecision?.(symbol, x);
    } catch (err) {
      return fail(err);
    }
    const changed = sent !== undefined && Math.abs(Number(sent) - x) > Math.max(1e-12, Math.abs(x) * 1e-9);
    if (onStep(x, step) && !changed) return undefined;
    return badOrder(venue, name, `a ${what} in ${symbol} ${step ? `moves in steps of ${plain(step)}` : "is counted in fewer digits"}${changed ? `: ${plain(x)} would go as ${sent}` : ""}`, { [what]: x, ...(changed ? { wouldSend: sent } : {}), ...(step ? { step } : {}) });
  };

  /** a worst price on the market's tick, never looser than asked: a buy's down to the tick, a sell's up */
  const boundOf = (o: Pick<OrderRequest, "side" | "worstPrice">, m: Market, raw: Dict): { price: number; step: number | undefined } => {
    const worst = o.worstPrice!;
    const step = m.priceStep ?? (mode === SIGNIFICANT_DIGITS ? sigStep(worst, num(obj(raw.precision).price)) : undefined);
    return { price: o.side === "buy" ? floorTo(worst, step) : ceilTo(worst, step), step };
  };

  /** the order's shape against its type and the market's flags, before anything is asked of the exchange */
  const shapeNo = (o: OrderRequest, m: Market): Refusal | undefined => {
    const limited = o.type === "limit" || o.type === "stop_limit";
    const stopped = o.type === "stop" || o.type === "stop_limit";
    const w = WORDS[o.type];
    if (limited ? !positive(o.limitPrice) : o.limitPrice !== undefined) return badOrder(venue, name, limited ? `a ${w} order has a limit price` : `a ${w} order has no limit price`);
    if (stopped ? !positive(o.stopPrice) : o.stopPrice !== undefined) return badOrder(venue, name, stopped ? `a ${w} order has a stop price that triggers it` : `a ${w} order has no stop price`);
    if (o.worstPrice !== undefined && !((o.type === "market" || o.type === "stop") && positive(o.worstPrice))) return badOrder(venue, name, "a worst price belongs to a market or stop order, and is more than zero");
    if (o.postOnly && o.type !== "limit") return badOrder(venue, name, "post-only is for a limit order: it rests on the book as a maker, or is refused");
    if (o.postOnly && !m.postOnly) return badOrder(venue, name, `it takes no post-only orders in ${m.name}`);
    if (o.reduceOnly && !m.reduceOnly) return badOrder(venue, name, `it takes no reduce-only orders in ${m.name}`);
    return undefined;
  };

  /** the time in force an order goes with, as the library takes it; `undefined`: the exchange's own default. Only one the market lists, and
   * only where it means something for this kind of order */
  const timeInForce = (o: OrderRequest, m: Market, kind: Kind): Tif | undefined | Refusal => {
    if (o.tif === undefined) return undefined;
    if (!(m.tifs ?? []).includes(o.tif)) return badOrder(venue, name, m.tifs?.length ? `it takes ${and(m.tifs)} in ${m.name}, not ${o.tif}` : `it takes no time-in-force choice in ${m.name}: its own default applies`);
    if (o.postOnly && o.tif !== "gtc") return badOrder(venue, name, `a post-only order rests on the book until canceled: it takes no ${o.tif}`);
    const tif = o.tif.toUpperCase() as Tif;
    if (o.type === "limit") return tif;
    if (o.type === "market") {
      // a market order fills at once and the rest is canceled: that is IOC already. All or nothing needs a worst price to bound it
      if (o.tif === "ioc") return undefined;
      if (o.tif === "fok" && o.worstPrice !== undefined) return "FOK";
      return badOrder(venue, name, o.tif === "fok" ? "a market order that fills whole or not at all needs a worst price: it then goes as a limit order there, filled at once in full or not at all" : "a market order fills at once: it does not wait until canceled");
    }
    if (o.type === "stop") {
      // a stop waits for its trigger until canceled, and then fills at once
      if (o.tif === "gtc") return undefined;
      return badOrder(venue, name, `a stop waits for its trigger until canceled and then fills at once: it takes no ${o.tif}`);
    }
    if (o.tif === "gtc") return undefined;
    return childTif(kind) ? tif : badOrder(venue, name, `it takes no ${o.tif} on the limit order a stop places in ${m.name}: that order waits on the book until canceled`);
  };

  /** OKX fires a trigger order when the price crosses its trigger from where it is when the order is placed ("place a market or limit order
   * when a specific price level is crossed": Place algo order, Trigger order), and Bybit takes no direction on a spot conditional order
   * (triggerDirection is for linear and inverse only: v5 Place order). So a buy stop goes above the price now and a sell stop below, or it
   * would fire on the move the other way */
  const crossesNo = async (o: OrderRequest, m: Market): Promise<Refusal | undefined> => {
    if (!client.fetchTicker) return badOrder(venue, name, `the account cannot see the price of ${m.name} here, so a stop's side of it cannot be checked`);
    let t: Dict;
    try {
      t = obj(await client.fetchTicker(m.symbol));
    } catch (err) {
      return fail(err);
    }
    const bid = pos(t.bid);
    const ask = pos(t.ask);
    const last = pos(t.last) ?? pos(t.close) ?? (bid !== undefined && ask !== undefined ? (bid + ask) / 2 : undefined);
    if (last === undefined) return badOrder(venue, name, `it shows no price for ${m.name} now, so a stop's side of it cannot be checked`);
    const stop = o.stopPrice!;
    if (o.side === "buy" ? stop > last : stop < last) return undefined;
    return badOrder(venue, name, `a ${o.side} stop goes ${o.side === "buy" ? "above" : "below"} the price now (${plain(last)}): at ${plain(stop)} it would fire when the price ${o.side === "buy" ? "falls" : "rises"} to it`, { price: last, stopPrice: stop });
  };

  /** a stop or a stop-limit as the library sends it to this exchange: its trigger, and the order it places then — a limit order at the
   * stop-limit's limit or at a stop's worst price, or for a stop with none a market order. `book`: the exchange keeps it in its trigger book */
  const stopOrder = async (o: OrderRequest, m: Market, kind: Kind, raw: Dict, tif: Tif | undefined, params: Dict): Promise<{ type: "market" | "limit"; price?: number; sentAs?: string; book: boolean } | Refusal> => {
    const stop = o.stopPrice!;
    const stopNo = exact(m.symbol, stop, "price", m.priceStep);
    if (stopNo) return stopNo;
    let limit: number | undefined;
    let bounded = false;
    if (o.type === "stop_limit") {
      limit = o.limitPrice!;
      const priceNo = exact(m.symbol, limit, "price", m.priceStep);
      if (priceNo) return priceNo;
    } else if (o.worstPrice !== undefined) {
      const b = boundOf(o, m, raw);
      if (!(b.price > 0)) return badOrder(venue, name, `a worst price of ${plain(o.worstPrice)} is under the smallest price step in ${m.name}`);
      const priceNo = exact(m.symbol, b.price, "price", b.step);
      if (priceNo) return priceNo;
      // a worst price lies past the trigger, the way the price moves to reach it: a buy stop's at or above its stop, a sell stop's at or below
      if (o.side === "buy" ? b.price < stop - 1e-12 : b.price > stop + 1e-12) return badOrder(venue, name, `a ${o.side} stop's worst price is at or ${o.side === "buy" ? "above" : "below"} its stop price: ${plain(b.price)} is not, against ${plain(stop)}`, { stopPrice: stop, worstPrice: o.worstPrice });
      limit = b.price;
      bounded = true;
    }
    // the time in force of the order the trigger places: a stop kept inside its worst price fills at once and the rest is canceled, where
    // the exchange takes that there; a stop-limit's is the one asked
    const child: Tif | undefined = bounded ? (childTif(kind) ? "IOC" : undefined) : tif;
    const sentAs = bounded ? `a stop at ${plain(stop)} that places a limit order at ${plain(limit!)}${child === "IOC" ? ", filled at once (IOC)" : ", which rests on the book if it does not fill at once"}: a stop kept inside its worst price` : limit === undefined ? `a stop at ${plain(stop)} that places a market order: it has no worst price` : undefined;
    const done = (book: boolean) => ({ type: limit === undefined ? ("market" as const) : ("limit" as const), ...(limit !== undefined ? { price: limit } : {}), ...(sentAs ? { sentAs } : {}), book });
    const listedTypes = orderTypesOf(raw) ?? [];
    if (fam === "okx") {
      if (o.reduceOnly) return badOrder(venue, name, "OKX lists no reduce-only flag on a trigger order (Place algo order, Trigger order): a stop there cannot be held to shrinking a position");
      if (kind === "spot" && limit === undefined && o.side === "buy") return badOrder(venue, name, `a stop buy in ${m.name} needs a worst price: OKX takes no size unit on a trigger order (error 51281), and reads a spot market buy's size in ${m.quote} to spend`);
      const wrong = await crossesNo(o, m);
      if (wrong) return wrong;
      params.triggerPrice = stop;
      // OKX knows a trigger order by algoClOrdId (Place algo order); the library writes the account's id as clOrdId, which OKX echoes as deprecated
      params.algoClOrdId = params.clientOrderId;
      // OKX refuses tgtCcy on a trigger order (error 51281 "Trigger order do not support the tgtCcy parameter"), and the library adds tgtCcy
      // base_ccy to every spot order; a key set to undefined comes back over it and leaves the request (okx.js createOrderRequest)
      if (kind === "spot") params.tgtCcy = undefined;
      // advanceOrdType: the sub-order of a trigger order, fok or ioc, for futures and perpetuals only (Place algo order)
      else if (child === "IOC" || child === "FOK") params.advanceOrdType = child.toLowerCase();
      return done(true);
    }
    if (fam === "binance") {
      // STOP_LOSS / STOP_LOSS_LIMIT in spot, STOP_MARKET / STOP in futures, the futures ones on the algo service (POST /fapi/v1/algoOrder): a buy
      // fires when the price rises to its stop, a sell when it falls (New order; New Algo Order)
      if (limit === undefined && !listedTypes.includes(kind === "spot" ? "STOP_LOSS" : "STOP_MARKET")) return badOrder(venue, name, `it takes a stop in ${m.name} only as a stop-limit: give the stop a worst price`);
      params.triggerPrice = stop;
      if (limit !== undefined && child) params.timeInForce = child;
      return done(kind !== "spot");
    }
    if (fam === "bybit") {
      if (kind === "spot") {
        // a classic account lists only active spot orders unless told to look for conditional ones (v5 Get open orders, orderFilter), so the
        // account places spot stops on a unified account, where it can follow them
        let unified: unknown;
        try {
          unified = client.isUnifiedEnabled ? await client.isUnifiedEnabled() : undefined;
        } catch (err) {
          return fail(err);
        }
        if (!(Array.isArray(unified) && unified[1] === true)) return badOrder(venue, name, "the account places spot stops at Bybit on a unified account only: a classic account lists them apart from its orders");
        const wrong = await crossesNo(o, m);
        if (wrong) return wrong;
      } else {
        // triggerDirection 1 fires when the price rises to the trigger, 2 when it falls to it (v5 Place order)
        params.triggerDirection = o.side === "buy" ? "ascending" : "descending";
      }
      params.triggerPrice = stop;
      if (limit !== undefined && child) params.timeInForce = child;
      return done(false);
    }
    if (fam === "coinbase") {
      if (limit === undefined) return badOrder(venue, name, "it takes a stop only as a stop-limit (stop_limit_stop_limit_gtc): give the stop a worst price");
      params.triggerPrice = stop;
      // STOP_DIRECTION_STOP_UP fires when the last trade goes above the stop, STOP_DOWN when it goes below (Create order, stop_direction).
      // The library's own default for a stop is the other way round (a buy fires on the way down), so the direction is always sent
      params.stop_direction = o.side === "buy" ? "STOP_DIRECTION_STOP_UP" : "STOP_DIRECTION_STOP_DOWN";
      return done(false);
    }
    if (fam === "kraken") {
      // stop-loss places a market order, stop-loss-limit a limit order at price2, when the price reaches `price` (AddOrder, ordertype); a buy
      // fires on the way up, a sell on the way down
      params.stopLossPrice = stop;
      return done(false);
    }
    return badOrder(venue, name, `it takes no stop orders through the account in ${m.name}`);
  };

  /** Cancel an order where it is: a trigger order in the trigger book. Bybit cancels a spot conditional order only when told it is one
   * (v5 Cancel order: orderFilter StopOrder, Order by default), so a spot order it does not know as a plain one is asked for as that. A
   * trigger order that has fired is the order it placed: that order is canceled instead */
  const cancel = async (ref: string, symbol: string): Promise<OrderState | Refusal> => {
    const f = await find(symbol);
    const cs = isRefusal(f) ? undefined : f.m.contractSize;
    const sym = isRefusal(f) ? symbol : f.m.symbol;
    const t = triggerId(ref);
    const tries: Dict[] = t !== undefined ? [{ trigger: true }] : isBybit(id) && !isRefusal(f) && f.kind === "spot" ? [{}, { trigger: true }] : [{}];
    let answer: Dict | undefined;
    let r: Refusal | undefined;
    for (const params of tries) {
      try {
        answer = obj(await client.cancelOrder!(t ?? ref, sym, params));
        r = undefined;
        break;
      } catch (err) {
        r = fail(err, ref);
        if (r.code !== "E_ACCOUNT_ORDER_UNKNOWN") break;
      }
    }
    if (r || !answer) {
      const refused = r ?? no("E_VENUE_REJECTED", { venue, message: `${name} did not answer the cancel` });
      if (final(refused)) return refused;
      // filled already, canceled already, fired, or not there: what the exchange shows now is the answer
      try {
        const s = await read(ref, sym, cs);
        if (DONE.has(s.status)) return s;
        if (t !== undefined && s.ref !== ref) return cancel(s.ref, symbol);
      } catch {
        // it does not show it either: its refusal stands
      }
      return refused;
    }
    // most exchanges answer a cancel with the id alone (Kraken with a count): the order as it stands is asked again
    try {
      const s = await read(ref, sym, cs);
      // a trigger order that fired on the way: the order it placed is what is canceled now
      if (t !== undefined && s.ref !== ref && !DONE.has(s.status)) return cancel(s.ref, symbol);
      return s;
    } catch {
      // the cancel was taken — the answer names the order, or is Kraken's count of orders canceled — but what became of the order cannot be
      // read now: it is not called canceled with nothing filled (it may have filled in part, or still fill on the way: Bybit and Coinbase
      // cancel later), so the account follows it until the exchange says. An answer that names no order is not the exchange's yes: a page
      // or an empty body in its place, and the order may still be open
      const taken = idOf(answer) === (t ?? ref) || (id === "kraken" && num(obj(obj(answer.info).result).count) > 0);
      if (taken) return { ...stateOf(answer, cs, ref), ref };
      return no("E_VENUE_UNREACHABLE", { venue, message: `${name} did not confirm the cancel: the order may still be open. Look at it at ${name}, or cancel it again`, detail: { order: ref, unsure: true }, native: { answer: "names no order" } });
    }
  };

  /** Change an open order in place, where the exchange changes it in place and keeps its id and what had filled: OKX amend-order (and
   * amend-algos for a trigger order), Binance's futures Modify Order (a limit order), Bybit's v5 amend, Coinbase's Edit order (a limit order)
   * and Kraken's AmendOrder. A size given is the order's new whole size, as each of them takes it */
  const amend = async (ref: string, symbol: string, change: OrderChange, order: OrderRequest): Promise<OrderState | Refusal> => {
    const f = await find(symbol);
    if (isRefusal(f)) return f;
    const { m, kind, raw } = f;
    const sym = m.symbol;
    const t = triggerId(ref);
    const closed = (message: string) => no("E_VENUE_RAIL_CLOSED", { venue, message: `${name} ${message}` });
    if (change.qty === undefined && change.limitPrice === undefined && change.stopPrice === undefined) return badOrder(venue, name, "a change is to the size, the limit or the stop");
    const limited = order.type === "limit" || order.type === "stop_limit";
    const stopped = order.type === "stop" || order.type === "stop_limit";
    if (change.limitPrice !== undefined && !limited) return badOrder(venue, name, `a ${WORDS[order.type]} order has no limit price to change`);
    if (change.stopPrice !== undefined && !stopped) return badOrder(venue, name, `a ${WORDS[order.type]} order has no stop price to change`);
    if (change.qty !== undefined) {
      if (!positive(change.qty)) return badOrder(venue, name, "a size is more than zero");
      const sizeNo = exact(sym, change.qty, "size", m.qtyStep);
      if (sizeNo) return sizeNo;
      if (m.minQty !== undefined && change.qty < m.minQty - 1e-12) return badOrder(venue, name, `the smallest order in ${m.name} is ${plain(m.minQty)} ${kind === "spot" ? m.base : "contracts"}`, { minQty: m.minQty });
    }
    for (const p of [change.limitPrice, change.stopPrice]) {
      if (p === undefined) continue;
      if (!positive(p)) return badOrder(venue, name, "a price is more than zero");
      const priceNo = exact(sym, p, "price", m.priceStep);
      if (priceNo) return priceNo;
    }
    // where a stop waits in a trigger book, an order-book ref means it has fired: the order it placed has no stop left to move
    const fired = stopped && t === undefined && (fam === "okx" || (fam === "binance" && kind !== "spot"));
    if (fired && change.stopPrice !== undefined) return badOrder(venue, name, "this stop has fired: the order it placed has no stop price to change");
    // a stop kept inside its worst price is a stop-limit at that price. A change carries no new worst price, so the stop may move only as
    // far as it: a buy stop up to it, a sell stop down to it
    const bound = order.type === "stop" && order.worstPrice !== undefined ? boundOf(order, m, raw).price : undefined;
    if (bound !== undefined && change.stopPrice !== undefined && (order.side === "buy" ? change.stopPrice > bound + 1e-12 : change.stopPrice < bound - 1e-12)) return badOrder(venue, name, `this ${order.side} stop's worst price is ${plain(bound)}: a stop at ${plain(change.stopPrice)} would be past it. Cancel it and place it again with a new worst price`, { worstPrice: bound });
    const limitNow = change.limitPrice ?? order.limitPrice ?? bound;

    let call: () => Promise<unknown>;
    if (fam === "okx") {
      if (t !== undefined) {
        // POST /api/v5/trade/amend-algos (Amend algo order): a trigger order's newTriggerPx and newOrdPx go together, newSz is its new size;
        // the library's editOrder takes only take-profit and stop-loss algo orders there
        const stop = change.stopPrice ?? order.stopPrice;
        if (stop === undefined) return badOrder(venue, name, "a stop changed in place keeps its stop price: it is not known here");
        const request: Dict = { instId: String(raw.id), algoId: t, ...(change.qty !== undefined ? { newSz: client.amountToPrecision?.(sym, change.qty) ?? plain(change.qty) } : {}), newTriggerPx: client.priceToPrecision?.(sym, stop) ?? plain(stop), newOrdPx: limitNow === undefined ? "-1" : (client.priceToPrecision?.(sym, limitNow) ?? plain(limitNow)) };
        if (!lib.privatePostTradeAmendAlgos) return closed("changes no trigger order in place through the library: cancel it and place it again");
        call = () => lib.privatePostTradeAmendAlgos!(request);
      } else {
        // POST /api/v5/trade/amend-order: newSz is the new whole size, what has filled included (Amend order)
        call = () => lib.editOrder!(ref, sym, "limit", order.side, change.qty, change.limitPrice);
      }
    } else if (fam === "binance") {
      if (kind === "spot") return closed("changes a spot order only by canceling it and placing a new one (its cancel-replace call), which would leave what had filled with the old order: cancel it, and place the new one");
      if (t !== undefined) return closed("changes no stop in its futures algo book in place, through the library: cancel it, and place it again");
      // PUT /fapi/v1/order (Modify Order): limit orders only, the quantity (the new whole size, above what has filled) and the price together
      if (limitNow === undefined) return closed("changes only a limit order in place in its futures");
      call = () => lib.editOrder!(ref, sym, "limit", order.side, change.qty ?? order.qty, limitNow);
    } else if (fam === "bybit") {
      // POST /v5/order/amend: in place, a conditional order too, its qty the new whole size (v5 Amend order)
      call = () => lib.editOrder!(ref, sym, limitNow === undefined ? "market" : "limit", order.side, change.qty, change.limitPrice, change.stopPrice !== undefined ? { triggerPrice: client.priceToPrecision?.(sym, change.stopPrice) ?? plain(change.stopPrice) } : {});
    } else if (fam === "coinbase") {
      if (order.type !== "limit") return closed("changes only limit orders in place (Edit order: ONLY_LIMIT_ORDER_EDITS_SUPPORTED): cancel the stop, and place it again");
      // POST /api/v3/brokerage/orders/edit takes the new size (the whole order, at least what has filled) and the price together
      call = () => lib.editOrder!(ref, sym, "limit", order.side, change.qty ?? order.qty, change.limitPrice ?? order.limitPrice);
    } else if (fam === "kraken") {
      // POST /0/private/AmendOrder: in place, the txid kept; order_qty the new whole size, limit_price, trigger_price (Amend Order)
      call = () => lib.editOrder!(ref, sym, "limit", order.side, change.qty, change.limitPrice, change.stopPrice !== undefined ? { stopLossPrice: change.stopPrice } : {});
    } else return closed("changes no order in place through the account: cancel it and place another");

    /** A change whose answer was lost (the call cut off mid-flight, a gateway's 5xx, an answer that names no order): the exchange may have
     * made it. The order itself is read: where it already holds what was asked, the change was made; otherwise it is said to be unsure —
     * never "could not be reached", after which the account would give back what the change grew by and keep the old size while the
     * exchange may hold the new one */
    const unsure = async (native: unknown): Promise<OrderState | Refusal> => {
      try {
        const s = await read(ref, sym, m.contractSize);
        const near = (a: number | undefined, b: number | undefined) => b === undefined || (a !== undefined && Math.abs(a - b) <= Math.max(1e-12, Math.abs(b) * 1e-9));
        if (s.ref === ref && near(s.qty, change.qty) && near(s.limitPrice, change.limitPrice) && near(s.stopPrice, change.stopPrice)) return { ...s, native: { ...(s.native as Dict), changed: true } };
      } catch {
        // it does not show the order now either
      }
      return no("E_VENUE_UNREACHABLE", { venue, message: `${name} did not confirm the change: it may or may not have been made. Look at the order before changing it again`, detail: { order: ref, unsure: true }, native });
    };
    let answer: Dict;
    try {
      answer = obj(await call());
    } catch (err) {
      const r = fail(err, ref);
      // a ban, a rate limit, the place, the key or its permission: the exchange's own no, and final. A lost answer is not one of them
      if (lostAnswer(err, r)) return unsure(r.native);
      if (final(r)) return r;
      // an order that filled or was canceled before the change reached it, or a stop that fired: said so, and the account's next look shows it
      try {
        const s = await read(ref, sym, m.contractSize);
        if (DONE.has(s.status)) return no("E_VENUE_REJECTED", { venue, message: `${name}: the order is ${s.status} already, so nothing was changed`, detail: { order: ref, status: s.status }, native: r.native });
        if (t !== undefined && s.ref !== ref) return no("E_VENUE_REJECTED", { venue, message: `${name}: this stop has fired, so nothing was changed. The order it placed (${s.ref}) is what stands now: it is followed from the next look, and can be changed then`, detail: { order: ref, placed: s.ref }, native: r.native });
      } catch {
        // it does not show it either: its refusal stands
      }
      return r;
    }
    // Coinbase answers a change it did not make with success false, which the library does not raise (Edit order: errors[].edit_failure_reason)
    const info = obj(answer.info);
    if (fam === "coinbase" && info.success === false) {
      const errors = Array.isArray(info.errors) ? info.errors.map(obj) : [obj(info.errors)];
      const why = errors.map((e) => str(e.edit_failure_reason) ?? str(e.preview_failure_reason)).find((x) => x && !/^UNKNOWN_/.test(x));
      return no("E_VENUE_REJECTED", { venue, message: `${name} did not change the order${why ? ` (${why})` : ""}`, native: { said: why ?? null } });
    }
    // the exchange's yes names the order — Kraken's names the change instead (its amend_id), Coinbase's is success true, OKX's amend-algos
    // answers in its own shape (data[0].algoId, sCode "0"). An answer that says none of these is not a yes: a page or an empty body in its place
    const algo = obj(Array.isArray(answer.data) ? answer.data[0] : undefined);
    const confirmed = idOf(answer) === ref || (fam === "kraken" && ID.test(str(info.amend_id) ?? "")) || (fam === "coinbase" && info.success === true) || (t !== undefined && str(algo.algoId) === t && str(algo.sCode) === "0");
    if (!confirmed) return unsure({ answer: "names no order" });
    // the order as it stands after: under its own ref, which a change in place keeps
    try {
      return await read(ref, sym, m.contractSize);
    } catch {
      return { ref, status: "pending", filledQty: 0, native: { changed: true } };
    }
  };

  /** What is held in perpetuals and futures the account trades (dollar-settled, linear): OKX GET /api/v5/account/positions, Binance GET
   * /fapi/v3/positionRisk (after its leverage brackets), Bybit GET /v5/position/list once per settle coin (it asks for one: USDT, USDC) */
  const positions = async (): Promise<Position[] | Refusal> => {
    const failed = await load();
    if (failed) return failed;
    let rows: unknown[] = [];
    try {
      if (fam === "bybit") for (const settleCoin of ["USDT", "USDC"]) rows = rows.concat(await lib.fetchPositions!(undefined, { settleCoin }));
      else rows = await lib.fetchPositions!();
    } catch (err) {
      return fail(err);
    }
    const out: Position[] = [];
    for (const p of rows.map(obj)) {
      const raw = all.get(str(p.symbol) ?? "");
      const kind = raw ? kindOf(raw) : undefined;
      if (!raw || !kind || kind === "spot" || !dollars(raw, kind)) continue;
      const contracts = num(p.contracts);
      const qty = Math.abs(contracts);
      if (!(qty > 0)) continue;
      const m = toMarket(raw, kind);
      const mark = pos(p.markPrice);
      const usd = pos(Math.abs(num(p.notional))) ?? (mark !== undefined ? Number((qty * (m.contractSize ?? 1) * mark).toFixed(10)) : undefined);
      const mm = p.marginMode === "cross" || p.marginMode === "isolated" ? p.marginMode : undefined;
      out.push({
        symbol: m.symbol,
        name: m.name,
        kind: m.kind,
        side: p.side === "short" || p.side === "long" ? p.side : contracts < 0 ? "short" : "long",
        qty,
        entryPrice: pos(p.entryPrice),
        markPrice: mark,
        usd,
        unrealizedUsd: finite(p.unrealizedPnl),
        leverage: pos(p.leverage),
        marginMode: mm,
        liquidationPrice: pos(p.liquidationPrice),
        native: { symbol: m.symbol, side: p.side ?? null, contracts: p.contracts ?? null, contractSize: p.contractSize ?? null, notional: p.notional ?? null, entryPrice: p.entryPrice ?? null, markPrice: p.markPrice ?? null, unrealizedPnl: p.unrealizedPnl ?? null, leverage: p.leverage ?? null, marginMode: p.marginMode ?? null, liquidationPrice: p.liquidationPrice ?? null },
      });
    }
    return out;
  };

  /** A perpetual's leverage, and its margin mode where the exchange sets it for one market: Binance per symbol (POST /fapi/v1/marginType, then
   * POST /fapi/v1/leverage). OKX takes the margin mode on each order, and the account's orders there go in cross margin (the library's tdMode
   * cross), so it sets the cross leverage (POST /api/v5/account/set-leverage). Bybit sets a unified account's margin mode for the whole
   * account (POST /v5/account/set-margin-mode), so the account sets only the leverage there (POST /v5/position/set-leverage), and a classic
   * account's mode per symbol (POST /v5/position/switch-isolated) */
  const setLeverage = async (symbol: string, leverage: number, marginMode?: "cross" | "isolated"): Promise<{ leverage: number; marginMode?: "cross" | "isolated" | undefined; native: unknown } | Refusal> => {
    const f = await find(symbol);
    if (isRefusal(f)) return f;
    const { m, kind } = f;
    if (kind === "spot") return badOrder(venue, name, `leverage is set on a perpetual or a future; ${m.name} is spot`);
    if (!(Number.isInteger(leverage) && leverage >= 1)) return badOrder(venue, name, "leverage is a whole number, 1 or more");
    if (m.maxLeverage !== undefined && leverage > m.maxLeverage) return badOrder(venue, name, `it takes at most ${m.maxLeverage}x in ${m.name}`, { maxLeverage: m.maxLeverage });
    // a leverage or margin mode already what was asked is not a refusal
    const tolerant = async (run: () => Promise<unknown>): Promise<unknown> => {
      try {
        return await run();
      } catch (err) {
        const e = err as { name?: string; message?: string };
        if (e?.name === "MarginModeAlreadySet" || e?.name === "NoChange" || UNCHANGED.test(String(e?.message ?? ""))) return { unchanged: true, said: redact(String(e?.message ?? ""), secrets).slice(0, 160) };
        throw err;
      }
    };
    try {
      if (fam === "okx") {
        if (marginMode === "isolated") return badOrder(venue, name, "OKX takes the margin mode on each order, and the account's orders there go in cross margin: the leverage it sets is cross");
        const r = obj(await tolerant(() => lib.setLeverage!(leverage, m.symbol, { marginMode: "cross" })));
        return { leverage, marginMode: "cross", native: Array.isArray(r.data) ? (r.data[0] ?? r) : r };
      }
      if (fam === "binance") {
        const mm = marginMode ? await tolerant(() => lib.setMarginMode!(marginMode, m.symbol)) : undefined;
        const r = obj(await tolerant(() => lib.setLeverage!(leverage, m.symbol)));
        return { leverage: pos(r.leverage) ?? leverage, ...(marginMode ? { marginMode } : {}), native: { leverage: r, ...(mm !== undefined ? { marginMode: mm } : {}) } };
      }
      if (fam === "bybit") {
        if (marginMode) {
          const unified = client.isUnifiedEnabled ? await client.isUnifiedEnabled() : undefined;
          if (Array.isArray(unified) && (unified[0] === true || unified[1] === true)) return badOrder(venue, name, "Bybit sets a unified account's margin mode for the whole account, not one market: set it at Bybit, then set the leverage here without one");
          const mm = await tolerant(() => lib.setMarginMode!(marginMode, m.symbol, { leverage }));
          const r = await tolerant(() => lib.setLeverage!(leverage, m.symbol));
          return { leverage, marginMode, native: { marginMode: mm, leverage: r } };
        }
        const r = await tolerant(() => lib.setLeverage!(leverage, m.symbol));
        return { leverage, native: r };
      }
    } catch (err) {
      return fail(err);
    }
    return no("E_VENUE_RAIL_CLOSED", { venue, message: `${name} sets no leverage from the account` });
  };

  // ---- reading the market ----

  /** a ticker's price: its last trade, or the middle of its book */
  const priceOf = (t: Dict): { price?: number; bid?: number; ask?: number } => {
    const bid = pos(t.bid);
    const ask = pos(t.ask);
    const price = pos(t.last) ?? pos(t.close) ?? (bid !== undefined && ask !== undefined ? (bid + ask) / 2 : (bid ?? ask));
    return { ...(price !== undefined ? { price } : {}), ...(bid !== undefined ? { bid } : {}), ...(ask !== undefined ? { ask } : {}) };
  };

  /** What a ticker says of the last 24 hours, at the exchanges whose tickers the trader has read against their docs and the library's
   * parsers: OKX (open24h, high24h, low24h, and volCcy24h — in the quote in spot; a contract's is in the coin, and the library leaves it out),
   * Binance (priceChange, priceChangePercent, quoteVolume, highPrice, lowPrice: a rolling 24 hours, spot and futures), Bybit (price24hPcnt,
   * prevPrice24h, turnover24h, highPrice24h, lowPrice24h), Coinbase (its list of products' price_percentage_change_24h and
   * approximate_quote_24h_volume: one product's own ticker has neither), Kraken (the last 24 hours of its volume, its VWAP, its high and
   * its low — and no change: its `o` is today's opening price, at midnight UTC, not the price 24 hours ago) and KuCoin (changeRate,
   * changePrice, high, low and volValue, each of the last 24 hours). The library works out a change or a percentage from the exchange's own
   * 24-hour open, or its percentage, and its last price, where the exchange gives those instead.
   * Elsewhere the library's unified reading is given — its percentage, change, quoteVolume (or baseVolume at the last price), high and low —
   * marked as the library's word (`statsFrom`): whether that exchange's "open" is 24 hours ago or the day's, and whether its volume is in
   * the quote or in contracts, has not been checked here */
  const dayOf = (t: Dict, quote: string): Omit<MarketStats, "price"> & Pick<MarketExtras, "statsFrom"> => {
    const changes = dayFam !== "kraken";
    const pct = changes ? finite(t.percentage) : undefined;
    const change = changes ? finite(t.change) : undefined;
    let volume = inDollars(quote) ? finite(t.quoteVolume) : undefined;
    if (dayFam === undefined && volume === undefined && inDollars(quote)) {
      const base = finite(t.baseVolume);
      const last = pos(t.last) ?? pos(t.close);
      if (base !== undefined && last !== undefined) volume = base * last;
    }
    const high = pos(t.high);
    const low = pos(t.low);
    const read = pct !== undefined || change !== undefined || volume !== undefined || high !== undefined || low !== undefined;
    return {
      ...(pct !== undefined ? { changePct24h: pct } : {}),
      ...(change !== undefined ? { change24h: change } : {}),
      ...(volume !== undefined && volume >= 0 ? { volumeUsd24h: volume } : {}),
      ...(high !== undefined ? { high24h: high } : {}),
      ...(low !== undefined ? { low24h: low } : {}),
      ...(dayFam === undefined && read ? { statsFrom: `the exchange library's unified reading of ${name}'s ticker: its 24-hour window and its volume are the library's word, not checked against ${name}'s docs` } : {}),
    };
  };

  /** A perpetual's funding rate for the period being paid next, and when it is paid: OKX GET /api/v5/public/funding-rate (fundingRate,
   * fundingTime), Binance GET /fapi/v1/premiumIndex (lastFundingRate, nextFundingTime), as the library reads them. Bybit's ticker for a
   * perpetual carries both already (v5 Get Tickers: fundingRate, nextFundingTime), which is what the library's own call would ask again.
   * Elsewhere none is said. A rate that does not come back leaves the market without one: it is not why a market cannot be seen */
  const fundingOf = async (symbol: string, ticker: Dict): Promise<Pick<Market, "fundingRate" | "nextFundingAt">> => {
    const said = (rate: unknown, at: unknown) => {
      const fundingRate = finite(rate);
      const nextFundingAt = isoAt(at);
      return fundingRate === undefined ? {} : { fundingRate, ...(nextFundingAt ? { nextFundingAt } : {}) };
    };
    if (fam === "bybit") {
      const info = obj(ticker.info);
      if (finite(info.fundingRate) !== undefined) return said(info.fundingRate, info.nextFundingTime);
    }
    if (!(fam === "okx" || fam === "binance" || fam === "bybit") || !able("fetchFundingRate")) return {};
    try {
      const f = obj(await client.fetchFundingRate!(symbol));
      return said(f.fundingRate, f.fundingTimestamp);
    } catch {
      return {};
    }
  };

  /** The last 24 hours of many markets, by the library's own symbol for each: only markets the account offers here (dollar markets, open
   * now), at most forty; with no symbols, the well-known coins' spot markets and perpetuals. One fetchTickers per kind of market, so that
   * no call mixes them (OKX lists its tickers by instType, Bybit by category, and the library takes a call's kind from its first symbol),
   * and OKX, Binance and Bybit are told the kind as well. Binance is never asked for its whole list: its spot markets go twenty at a time,
   * and its futures one at a time, as GET /fapi/v1/ticker/24hr takes one symbol or none (the library asks it for all). Kraken is given only
   * the pairs the library counts as active, the only ones it would ask for. A kind that does not answer leaves the others standing */
  const stats = async (symbols?: string[]): Promise<Map<string, MarketStats> | Refusal> => {
    const failed = await load();
    if (failed) return failed;
    const asked = symbols ? [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))] : undefined;
    if (asked && asked.length > STATS_MAX) return no("E_VENUE_REJECTED", { venue, message: `${name}: at most ${STATS_MAX} markets are read at once, not ${asked.length}`, detail: { max: STATS_MAX } });
    const offered = new Map(list.map((m) => [m.symbol.toUpperCase(), m]));
    const wanted = asked ? asked.map((s) => offered.get(s)).filter((m): m is Market => m !== undefined) : list.filter((m) => WELL_KNOWN.includes(m.base) && m.kind !== "future").slice(0, STATS_MAX);
    const out = new Map<string, MarketStats & Pick<MarketExtras, "statsFrom">>();
    let refused: Refusal | undefined;
    for (const kind of ["spot", "perp", "future"] as const) {
      let group = wanted.filter((m) => m.kind === kind);
      if (id === "kraken") group = group.filter((m) => all.get(m.symbol)?.active === true);
      if (!group.length) continue;
      const rows: Record<string, unknown> = {};
      const oneByOne = (fam === "binance" && kind !== "spot") || !able("fetchTickers");
      if (oneByOne) {
        if (!client.fetchTicker) continue;
        for (const m of group) {
          try {
            rows[m.symbol] = await client.fetchTicker(m.symbol);
          } catch (err) {
            const r = fail(err);
            refused ??= r;
            if (final(r)) break;
          }
        }
      } else {
        const size = fam === "binance" ? BINANCE_SYMBOLS : group.length;
        const params = fam === "okx" || fam === "binance" || fam === "bybit" ? { type: LIBRARY_KIND[kind] } : undefined;
        for (let i = 0; i < group.length; i += size) {
          const chunk = group.slice(i, i + size).map((m) => m.symbol);
          try {
            Object.assign(rows, await (params ? client.fetchTickers!(chunk, params) : client.fetchTickers!(chunk)));
          } catch (err) {
            const r = fail(err);
            refused ??= r;
            if (final(r)) break;
          }
        }
      }
      for (const m of group) {
        const t = rows[m.symbol];
        if (t === undefined || t === null) continue;
        const { price } = priceOf(obj(t));
        out.set(m.symbol, { ...(price !== undefined ? { price } : {}), ...dayOf(obj(t), m.quote) });
      }
    }
    return !out.size && refused ? refused : out;
  };

  /** Price history (fetchOHLCV): the latest bars since `sinceMs`, at most 300, oldest first, in one request. A bar's volume is in the coin,
   * where the library counts it so: any spot market's, and OKX's, Binance's and Bybit's linear contracts' (OKX's from its volume in the coin,
   * not in contracts; Bybit's linear contract is one coin). Elsewhere a contract's volume may be counted in contracts, and none is said */
  const candles = async (symbol: string, interval: CandleInterval, sinceMs: number): Promise<Candle[] | Refusal> => {
    if (!CANDLE_INTERVALS.includes(interval)) return no("E_VENUE_REJECTED", { venue, message: `${name}: price history comes in bars of ${and([...CANDLE_INTERVALS])}, not ${String(interval)}` });
    if (!(Number.isFinite(sinceMs) && sinceMs >= 0)) return no("E_VENUE_REJECTED", { venue, message: `${name}: a price history starts at a time, in milliseconds` });
    const f = await find(symbol, true);
    if (isRefusal(f)) return f;
    if (!able("fetchOHLCV")) return no("E_VENUE_RAIL_CLOSED", { venue, message: `${name} has no price history the library can read` });
    if (client.timeframes !== undefined && obj(client.timeframes)[interval] === undefined) return no("E_VENUE_RAIL_CLOSED", { venue, message: `${name} keeps no ${interval} bars` });
    const from = Math.max(Math.floor(sinceMs), now() - BARS * BAR_MS[interval]);
    let rows: unknown[];
    try {
      rows = await client.fetchOHLCV!(f.m.symbol, interval, from, BARS);
    } catch (err) {
      return fail(err);
    }
    const inCoin = f.kind === "spot" || fam === "okx" || fam === "binance" || fam === "bybit";
    const bars = new Map<number, Candle>();
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!Array.isArray(r)) continue;
      const [t, o, h, l, c, v] = [finite(r[0]), pos(r[1]), pos(r[2]), pos(r[3]), pos(r[4]), finite(r[5])];
      if (t === undefined || t < from || o === undefined || h === undefined || l === undefined || c === undefined) continue;
      bars.set(t, { t, o, h, l, c, ...(inCoin && v !== undefined && v >= 0 ? { v } : {}) });
    }
    return [...bars.values()].sort((a, b) => a.t - b.t);
  };

  const trader: LiveTrader = {
    can: (() => {
      const kinds = [allowed("spot"), ...(contractsHere ? [allowed("perp")] : [])];
      return kinds.includes(true) ? true : kinds.every((k) => k === false) ? false : "unknown";
    })(),
    get what() {
      return offersContracts() ? (loadedAt && !list.some((m) => m.kind === "perp") ? "spot and futures" : "spot and perpetuals") : "spot";
    },

    async markets(query) {
      const failed = await load();
      if (failed) return failed;
      // a kind of market this key may not trade, by what the exchange said, is not offered
      const offered = list.filter((m) => allowed(m.kind as Kind) !== false);
      const few = pick(offered, query);
      if (query.trim()) return few;
      // the exchange's pre-IPO perpetuals too, after the well-known few, so that Markets groups them with the public venues' (live/preipo.ts)
      return [...few, ...offered.filter((m) => m.category === PRE_IPO_CATEGORY && !few.includes(m))];
    },

    async market(symbol) {
      const f = await find(symbol);
      if (isRefusal(f)) return f;
      if (!client.fetchTicker) return f.m;
      let t: Dict;
      try {
        // the fresh price: the exchange's ticker (OKX GET /api/v5/market/ticker, Binance GET /api/v3/ticker/24hr, Bybit GET /v5/market/tickers…)
        t = obj(await client.fetchTicker(f.m.symbol));
      } catch (err) {
        return fail(err);
      }
      // the same ticker's last 24 hours, as read above (a Market carries no high or low); a perpetual's funding, and at Bybit the margin
      // modes its leverage is set with, which depend on the account
      const { changePct24h, change24h, volumeUsd24h, statsFrom } = dayOf(t, f.m.quote);
      const funding = f.kind === "perp" ? await fundingOf(f.m.symbol, t) : {};
      const marginModes = await bybitModes(f.kind);
      const fresh = priceOf(t);
      // a pre-IPO perpetual: the valuation the fresh price implies, in the exchange's unit
      const implied = f.m.implied && fresh.price !== undefined ? { implied: { ...f.m.implied, usd: impliedUsd(fresh.price, f.m.implied.perPoint) } } : {};
      const m: Market & MarketExtras = { ...f.m, ...fresh, ...(changePct24h !== undefined ? { changePct24h } : {}), ...(change24h !== undefined ? { change24h } : {}), ...(volumeUsd24h !== undefined ? { volumeUsd24h } : {}), ...(statsFrom ? { statsFrom } : {}), ...funding, ...(marginModes ? { marginModes } : {}), ...implied };
      return m;
    },

    async place(o: OrderRequest) {
      const f = await find(o.symbol);
      if (isRefusal(f)) return f;
      const { m, kind, raw } = f;
      const symbol = m.symbol;
      if (!m.open) return no("E_VENUE_MARKET_CLOSED", { venue, message: `${name}: ${m.name} takes no orders now${m.note ? ` (${m.note})` : ""}` });
      if (!m.types.includes(o.type)) return badOrder(venue, name, `it takes ${and(m.types.map((t) => WORDS[t]))} orders in ${m.name}, not ${WORDS[o.type] ?? o.type} orders`);
      if (!(Number.isFinite(o.qty) && o.qty > 0)) return badOrder(venue, name, "a size is more than zero");
      const shape = shapeNo(o, m);
      if (shape) return shape;
      const tif = timeInForce(o, m, kind);
      if (isRefusal(tif)) return tif;

      const sizeNo = exact(symbol, o.qty, "size", m.qtyStep);
      if (sizeNo) return sizeNo;
      if (m.minQty !== undefined && o.qty < m.minQty - 1e-12) return badOrder(venue, name, `the smallest order in ${m.name} is ${plain(m.minQty)} ${kind === "spot" ? m.base : "contracts"}`, { minQty: m.minQty });
      const { cid, params } = idParam(o.clientId);
      if (o.postOnly) params.postOnly = true;
      if (o.reduceOnly) params.reduceOnly = true;
      let type: "market" | "limit" = o.type === "limit" || o.type === "stop_limit" ? "limit" : "market";
      let price: number | undefined;
      let sentAs: string | undefined;
      let book = false;
      if (o.type === "limit") {
        price = o.limitPrice!;
        const priceNo = exact(symbol, price, "price", m.priceStep);
        if (priceNo) return priceNo;
        // a post-only order rests until canceled by its nature, and goes with no time in force: the library makes Binance's futures one GTX
        // and its spot one LIMIT_MAKER (which takes none), and a timeInForce sent with it would come back over the GTX
        if (tif && !o.postOnly) params.timeInForce = tif;
      } else if (o.type === "stop" || o.type === "stop_limit") {
        const s = await stopOrder(o, m, kind, raw, tif, params);
        if (isRefusal(s)) return s;
        type = s.type;
        price = s.price;
        sentAs = s.sentAs;
        book = s.book;
      } else if (o.worstPrice !== undefined) {
        // a market order kept inside its worst price: a limit order there, filled at once (IOC), the rest canceled — or filled whole at once
        // or not at all (FOK), when that is asked. A buy's worst price goes down to the tick and a sell's up, so it is never looser than asked
        const b = boundOf(o, m, raw);
        price = b.price;
        if (!(price > 0)) return badOrder(venue, name, `a worst price of ${plain(o.worstPrice)} is under the smallest price step in ${m.name}`);
        const priceNo = exact(symbol, price, "price", b.step);
        if (priceNo) return priceNo;
        type = "limit";
        // where the library says the exchange takes no IOC here, the limit order at the worst price is sent as it is
        const ioc = obj(feature(kind).timeInForce).IOC !== false;
        if (tif === "FOK") params.timeInForce = "FOK";
        else if (ioc) params.timeInForce = "IOC";
        sentAs = `a limit order at ${plain(price)}${tif === "FOK" ? " that fills whole at once or not at all (FOK)" : ioc ? " that fills at once (IOC)" : ""}: a market order kept inside its worst price`;
      } else {
        // a plain market order: sized in the coin, and no price goes with it
        if (o.side === "buy" && kind === "spot") {
          if (isBybit(id)) {
            // Bybit reads a spot market buy's size in the coin only on a unified account (marketUnit baseCoin); a classic account reads it as
            // the quote to spend (Bybit v5 create-order). The library asks GET /v5/user/query-api once, and so does this
            let unified: unknown;
            try {
              unified = client.isUnifiedEnabled ? await client.isUnifiedEnabled() : undefined;
            } catch (err) {
              return fail(err);
            }
            if (!(Array.isArray(unified) && unified[1] === true)) return badOrder(venue, name, `on a classic Bybit account a market buy is sized in ${m.quote} to spend, not in ${m.base} to get: give the order a worst price (it then goes as a limit order filled at once), or place a limit order`);
          } else if (buysByCost()) {
            return badOrder(venue, name, `it takes a market buy only by what it costs, not by how much ${m.base} to get: give the order a worst price (it then goes as a limit order filled at once), or place a limit order`);
          }
        }
        // OKX shrinks a spot market order to the balance unless told not to (Place order: banAmend)
        if (isOkx(id) && kind === "spot") params.banAmend = true;
      }
      const worth = price ?? o.stopPrice;
      if (worth !== undefined && m.minNotional !== undefined && notionalOf(m, o.qty, worth) < m.minNotional - 1e-9) return badOrder(venue, name, `the smallest order in ${m.name} is worth ${plain(m.minNotional)} ${m.quote}`, { minNotional: m.minNotional });

      let created: Dict;
      try {
        created = obj(await client.createOrder!(symbol, type, o.side, o.qty, price, params));
      } catch (err) {
        const r = fail(err);
        if (!lostAnswer(err, r)) return r;
        // the order call did not come back: whether the order is at the exchange is asked by the account's id, before anything else is said
        let found: Dict | null | undefined;
        try {
          found = await byClientId(symbol, cid, book);
        } catch {
          found = undefined;
        }
        if (found) return foundState(found, m.contractSize, book);
        return no("E_VENUE_UNREACHABLE", { venue, message: found === null ? `${name} did not confirm the order, and shows none under the account's id ${cid} now: look at its open orders before placing it again` : `${name} did not confirm the order: it may or may not have been placed. Look at its open orders before placing it again (the account's id for it: ${cid})`, detail: { clientOrderId: cid }, native: r.native });
      }
      // an answer with no order id in it — or something in an id's place that is not one (MEXC takes any string answer, a page included, as
      // the order's id) — is not the exchange's yes: whether the order is there is asked by the account's id, and never stored from the answer
      const venueId = idOf(created);
      if (!venueId) {
        const found = await byClientId(symbol, cid, book).catch(() => undefined);
        if (found) return foundState(found, m.contractSize, book);
        return no("E_VENUE_UNREACHABLE", { venue, message: found === null ? `${name} did not confirm the order (what came back named no order), and shows none under the account's id ${cid} now: look at its open orders before placing it again` : `${name} did not confirm the order (what came back named no order): it may or may not have been placed. Look at its open orders before placing it again (the account's id for it: ${cid})`, detail: { clientOrderId: cid }, native: { answer: "names no order" } });
      }
      const ref = book ? TRIGGER + venueId : venueId;
      // what the order call answered is little more than the id at most exchanges: what became of it is asked at once
      let s: OrderState;
      let seen = false;
      try {
        s = await read(ref, symbol, m.contractSize);
        seen = true;
      } catch {
        s = book ? algoState(created, m.contractSize, ref) : stateOf(created, m.contractSize, ref);
      }
      // Binance's order answer carries the fills and their fees; its fetchOrder does not
      if (s.feeUsd === undefined && seen && !book) {
        const fee = feeUsd(created);
        if (fee !== undefined) s.feeUsd = fee;
      }
      return { ...s, native: { ...(s.native as Dict), clientOrderId: cid, ...(sentAs ? { sentAs } : {}) } };
    },

    cancel,

    async status(ref, symbol) {
      const f = await find(symbol);
      const cs = isRefusal(f) ? undefined : f.m.contractSize;
      try {
        return await read(ref, isRefusal(f) ? symbol : f.m.symbol, cs);
      } catch (err) {
        return fail(err, ref);
      }
    },
  };
  // an order changed in place, what is held and a perpetual's leverage: only at the exchanges checked for each, and only where the library
  // has the call there; no close of its own (see the head of this file). Binance changes only a futures order in place: where it has no
  // futures (Binance.US) it changes none
  if (fam !== undefined && !(fam === "binance" && !contractsHere) && client.has?.editOrder === true && typeof lib.editOrder === "function") trader.amend = amend;
  if ((fam === "okx" || fam === "binance" || fam === "bybit") && contractsHere && client.has?.fetchPositions === true && typeof lib.fetchPositions === "function") trader.positions = positions;
  if (leverageHere) trader.setLeverage = setLeverage;
  // an order the account could not hear placed, looked up again by its id for it: where the exchange can be asked that way (byClientId)
  const byClient: ByClient = async (clientId, symbol, type) => {
    const f = await find(symbol, true);
    if (isRefusal(f)) return f;
    const book = (type === "stop" || type === "stop_limit") && (fam === "okx" || (fam === "binance" && f.kind !== "spot"));
    try {
      const found = await byClientId(f.m.symbol, idParam(clientId).cid, book);
      return found ? foundState(found, f.m.contractSize, book) : found;
    } catch (err) {
      return fail(err);
    }
  };
  (trader as LiveTrader & { byClient?: ByClient }).byClient = byClient;
  // reading the market: many tickers where the library reads them (one at a time where it reads only one), price history where it has it
  if (able("fetchTickers") || typeof client.fetchTicker === "function") trader.stats = stats;
  if (able("fetchOHLCV")) trader.candles = candles;
  earnHooks.set(trader, { client, venue, name, key, can: [...probe.can] });
  return trader;
}

/** What the account's earn door (live/earn.ts) is handed of an exchange connected live: the trader's own client, under the same key, and
 * what the exchange said the key may do. Earn speaks to the exchange through the client the orders go through, never a second one */
export interface ExchangeEarnHook {
  client: ExchangeClient;
  venue: string;
  name: string;
  key: KeyFile;
  can: string[];
}
const earnHooks = new WeakMap<LiveTrader, ExchangeEarnHook>();
/** the earn hook of an exchange's trader, or nothing for any other trader */
export const exchangeEarnHook = (t: LiveTrader | undefined): ExchangeEarnHook | undefined => (t ? earnHooks.get(t) : undefined);
