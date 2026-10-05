/** TRADING at an exchange through the unified exchange library (ccxt): any exchange it covers, on the owner's own API key.
 *
 * Markets are the library's own list (loadMarkets), kept for five minutes: spot markets quoted in dollars or a dollar stablecoin, and LINEAR
 * perpetuals and futures quoted and settled in one. Inverse contracts, options and anything priced in another coin are not offered. A
 * market is named as the library names it: `BTC/USDT` spot, `BTC/USDT:USDT` the perpetual, `BTC/USDT:USDT-251226` a future. A contract
 * market is sized in contracts, and `contractSize` says how much of the coin one contract is.
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
 */
import { isRefusal, type Refusal } from "../../core/errors.ts";
import { no } from "../refuse.ts";
import type { KeyFile } from "./credentials.ts";
import { exchangeSaidNo, isBinance, isBybit, isOkx, type ExchangeClient } from "./exchange.ts";
import { badOrder, ceilTo, floorTo, inDollars, notionalOf, onStep, pick, plain, DONE, type LiveTrader, type Market, type OrderRequest, type OrderState, type OrderStatus, type OrderType } from "./trade.ts";
import { num, redact, type LiveProbe } from "./types.ts";

type Dict = Record<string, unknown>;
type Kind = "spot" | "perp" | "future";

/** how the library counts a precision (base/functions/number.js): a step, a number of decimal places, or a number of significant digits */
const DECIMAL_PLACES = 2;
const SIGNIFICANT_DIGITS = 3;
const TICK_SIZE = 4;

const LIST_MS = 5 * 60_000;
const WELL_KNOWN = ["BTC", "ETH", "SOL", "XRP", "DOGE", "BNB", "ADA", "LINK", "AVAX", "LTC"];
const QUOTES = ["USDT", "USDC", "USD"];

const obj = (v: unknown): Dict => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Dict) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : typeof v === "number" ? String(v) : undefined);
const pos = (v: unknown): number | undefined => (num(v) > 0 ? num(v) : undefined);
const yes = (v: unknown): boolean => v === true || v === "true";

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
/** an order call that failed this way may still have reached the exchange (OKX 50004: "does not indicate success or failure of order") */
const UNSURE = new Set(["RequestTimeout", "NetworkError", "ExchangeNotAvailable", "TimeoutError", "AbortError"]);

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
  const offersContracts = () => (loadedAt ? list.some((m) => m.kind !== "spot") : client.has?.swap === true || client.has?.future === true);
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

  /** what the library threw, as the account's refusal, in the exchange's own words with nothing secret in them */
  const fail = (err: unknown, ref?: string): Refusal => {
    if (isRefusal(err)) return err;
    const kind = String((err as { name?: string })?.name ?? "");
    const said = redact(String((err as { message?: string })?.message ?? err), secrets).replace(/\s+/g, " ").slice(0, 240);
    const native = { error: kind, said };
    const plainNo = exchangeSaidNo(venue, name, err, key);
    if (plainNo.code === "E_VENUE_GEOBLOCKED") return plainNo;
    // Coinbase's place rule arrives as an order failure reason, which the library files as a plain error (ccxt.md §6, region row)
    if (/GEOFENCING_RESTRICTION/.test(said)) return no("E_VENUE_GEOBLOCKED", { venue, message: `${name} does not serve this location: that is its own rule, and the account does not look for a way around it`, native });
    if (kind === "OrderNotFound" || NOT_FOUND.test(said)) return no("E_ACCOUNT_ORDER_UNKNOWN", { venue, message: ref ? `${name} has no order ${ref} for this key` : `${name} has no such order for this key`, ...(ref ? { detail: { order: ref } } : {}), native });
    if (kind === "InsufficientFunds" || INSUFFICIENT.test(said)) return no("E_VENUE_INSUFFICIENT", { venue, message: `${name}: not enough balance there for this order`, native });
    if (kind === "MarketClosed" || CLOSED.test(said)) return no("E_VENUE_MARKET_CLOSED", { venue, message: `${name} takes no orders in this market now`, native });
    if (NO_PERMISSION.test(said)) return no("E_VENUE_PERMISSION", { venue, message: `${name} refused: the key lacks the permission for this, or this machine's IP is not on the key's list`, native });
    if (plainNo.code !== "E_VENUE_REJECTED") return plainNo;
    if (INVALID_KINDS.has(kind) || INVALID.test(said)) return { ...badOrder(venue, name, "it does not take this order as written (its size, step, price or minimum)"), native };
    return plainNo;
  };

  /** the library's market list, kept five minutes; a list that cannot be reloaded is used as it was */
  const load = async (): Promise<Refusal | undefined> => {
    if (loadedAt && now() - loadedAt < LIST_MS) return undefined;
    try {
      await client.loadMarkets?.(loadedAt > 0);
    } catch (err) {
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

  /** whether the exchange takes orders in it now, and which; the exchange's own flags where the library leaves them in `info` */
  const tradable = (r: Dict, symbol: string): { open: boolean; note?: string; types: OrderType[] } => {
    const info = obj(r.info);
    let types: OrderType[] = ["market", "limit"];
    // Binance lists the order types of each market (exchangeInfo `orderTypes`), and the library refuses one not on the list
    if (Array.isArray(info.orderTypes)) {
      const listed = info.orderTypes.map((t) => String(t).toUpperCase());
      types = types.filter((t) => listed.includes(t.toUpperCase()));
    }
    const notes: string[] = [];
    if (id === "coinbase") {
      // Coinbase product flags (GET /api/v3/brokerage/market/products): the library reads only trading_disabled into `active`
      if (yes(info.cancel_only)) return { open: false, note: `${name} takes only cancellations in ${symbol} now`, types };
      if (yes(info.limit_only)) {
        types = ["limit"];
        notes.push(`${name} takes only limit orders in ${symbol} now`);
      }
      if (yes(info.post_only)) {
        types = ["limit"];
        notes.push(`${name} takes only orders that rest on its book in ${symbol} now: a limit order that would fill at once is refused`);
      }
    }
    if (id === "kraken" && typeof info.status === "string" && info.status !== "online") {
      // Kraken AssetPairs `status`: limit_only and post_only still take limit orders; the library counts only "online" as active
      if (info.status === "limit_only" || info.status === "post_only") return { open: true, note: `${name} has ${symbol} in ${info.status.replace("_", "-")} mode: limit orders only${info.status === "post_only" ? ", and only ones that rest on its book" : ""}`, types: ["limit"] };
      return { open: false, note: `${name} has ${symbol} in ${info.status.replace(/_/g, "-")} mode`, types };
    }
    if (r.active === false) {
      const word = str(info.status) ?? str(info.state);
      return { open: false, note: `${name} is not trading ${symbol} now${word ? ` (it says: ${word})` : ""}`, types };
    }
    if (types.includes("market") && r.spot === true && !isBybit(id) && buysByCost()) notes.push(`${name} takes a market buy only by what it costs: a market buy here goes as a limit order at its worst price, filled at once`);
    return { open: true, ...(notes.length ? { note: notes.join(" · ") } : {}), types };
  };

  function toMarket(r: Dict, kind: Kind): Market {
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
    const expiry = str(r.expiryDatetime)?.slice(0, 10);
    const pair = `${base}/${quote}`;
    const label = kind === "spot" ? `${pair} spot` : `${pair} ${kind === "perp" ? "perpetual" : `future${expiry ? ` to ${expiry}` : ""}`}${settle && settle !== quote ? `, settled in ${settle}` : ""}`;
    const t = tradable(r, symbol);
    const counting = mode === SIGNIFICANT_DIGITS ? `${name} counts prices here in ${num(precision.price)} significant digits` : undefined;
    const note = [t.note, counting].filter(Boolean).join(" · ");
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
      open: t.open,
      ...(note ? { note } : {}),
      types: t.types,
    };
  }

  /** one market by the library's symbol (any case), or the reason it is not one the account trades */
  const find = async (symbol: string): Promise<{ m: Market; raw: Dict; kind: Kind } | Refusal> => {
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
    if (allowed(kind) === false) return no("E_VENUE_PERMISSION", { venue, message: `${name}: this key may not trade ${kind === "spot" ? "spot markets" : "perpetuals and futures"} (the exchange says it can: ${probe.can.join(", ")}). That is set on the key at the exchange`, detail: { said: probe.can } });
    return { m: toMarket(r, kind), raw: r, kind };
  };

  /** an order as the account keeps it: what filled decides, the status word only where nothing says otherwise */
  const stateOf = (o: Dict, contractSize: number | undefined, ref?: string): OrderState => {
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
    const info = obj(o.info);
    const venueWord = str(info.status) ?? str(info.state) ?? str(info.orderStatus);
    const native: Dict = { id: str(o.id) ?? ref ?? null, clientOrderId: str(o.clientOrderId) ?? null, symbol: str(o.symbol) ?? null, type: str(o.type) ?? null, side: str(o.side) ?? null, status: word ?? null, ...(venueWord ? { venueStatus: venueWord } : {}), amount: o.amount ?? null, filled: o.filled ?? null, average: o.average ?? null, cost: o.cost ?? null, fees: Array.isArray(o.fees) ? o.fees : [] };
    return { ref: str(o.id) ?? ref ?? "", status, filledQty: filled, ...(average !== undefined ? { avgPrice: average } : {}), ...(fee !== undefined ? { feeUsd: fee } : {}), native };
  };

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

  /** what became of an order: fetchOrder where the exchange has it; elsewhere what it has instead (ccxt.md §5) */
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

  /** an order looked up by the account's id, after an order call that may or may not have reached the exchange (ccxt.md §5, by client id).
   * `null`: looked, and none is there; `undefined`: this exchange cannot be asked that way through the library */
  const byClientId = async (symbol: string, cid: string): Promise<Dict | null | undefined> => {
    const mine = (rows: unknown) => (Array.isArray(rows) ? rows.map(obj).find((o) => str(o.clientOrderId) === cid) : undefined);
    if ((isOkx(id) || isBinance(id)) && client.fetchOrder) {
      try {
        return obj(await client.fetchOrder(undefined, symbol, { clientOrderId: cid }));
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

  return {
    can: (() => {
      const kinds = [allowed("spot"), ...(client.has?.swap === true || client.has?.future === true ? [allowed("perp")] : [])];
      return kinds.includes(true) ? true : kinds.every((k) => k === false) ? false : "unknown";
    })(),
    get what() {
      return offersContracts() ? (loadedAt && !list.some((m) => m.kind === "perp") ? "spot and futures" : "spot and perpetuals") : "spot";
    },

    async markets(query) {
      const failed = await load();
      if (failed) return failed;
      // a kind of market this key may not trade, by what the exchange said, is not offered
      return pick(list.filter((m) => allowed(m.kind as Kind) !== false), query);
    },

    async market(symbol) {
      const f = await find(symbol);
      if (isRefusal(f)) return f;
      if (!client.fetchTicker) return f.m;
      try {
        // the fresh price: the exchange's ticker (OKX GET /api/v5/market/ticker, Binance GET /api/v3/ticker/24hr, Bybit GET /v5/market/tickers…)
        const t = obj(await client.fetchTicker(f.m.symbol));
        const bid = pos(t.bid);
        const ask = pos(t.ask);
        const last = pos(t.last) ?? pos(t.close);
        const price = last ?? (bid !== undefined && ask !== undefined ? (bid + ask) / 2 : (bid ?? ask));
        return { ...f.m, ...(price !== undefined ? { price } : {}), ...(bid !== undefined ? { bid } : {}), ...(ask !== undefined ? { ask } : {}) };
      } catch (err) {
        return fail(err);
      }
    },

    async place(o: OrderRequest) {
      const f = await find(o.symbol);
      if (isRefusal(f)) return f;
      const { m, kind } = f;
      const symbol = m.symbol;
      if (!m.open) return no("E_VENUE_MARKET_CLOSED", { venue, message: `${name}: ${m.name} takes no orders now${m.note ? ` (${m.note})` : ""}` });
      if (!m.types.includes(o.type)) return badOrder(venue, name, `it takes ${m.types.join(" and ")} orders in ${m.name}, not ${o.type} orders`);
      if (!(Number.isFinite(o.qty) && o.qty > 0)) return badOrder(venue, name, "a size is more than zero");
      if (o.type === "limit" && !(o.limitPrice !== undefined && Number.isFinite(o.limitPrice) && o.limitPrice > 0)) return badOrder(venue, name, "a limit order has a limit price");
      if (o.type === "market" && o.limitPrice !== undefined) return badOrder(venue, name, "a market order has no limit price");
      if (o.worstPrice !== undefined && !(o.type === "market" && Number.isFinite(o.worstPrice) && o.worstPrice > 0)) return badOrder(venue, name, "a worst price belongs to a market order, and is more than zero");

      const sizeNo = exact(symbol, o.qty, "size", m.qtyStep);
      if (sizeNo) return sizeNo;
      if (m.minQty !== undefined && o.qty < m.minQty - 1e-12) return badOrder(venue, name, `the smallest order in ${m.name} is ${plain(m.minQty)} ${kind === "spot" ? m.base : "contracts"}`, { minQty: m.minQty });
      const { cid, params } = idParam(o.clientId);
      let type: OrderType = o.type;
      let price: number | undefined;
      let sentAs: string | undefined;
      if (o.type === "limit") {
        price = o.limitPrice!;
        const priceNo = exact(symbol, price, "price", m.priceStep);
        if (priceNo) return priceNo;
      } else if (o.worstPrice !== undefined) {
        // a market order kept inside its worst price: a limit order there, filled at once (IOC), the rest canceled. A buy's worst price goes
        // down to the tick and a sell's up, so it is never looser than asked
        const step = m.priceStep ?? (mode === SIGNIFICANT_DIGITS ? sigStep(o.worstPrice, num(obj(f.raw.precision).price)) : undefined);
        price = o.side === "buy" ? floorTo(o.worstPrice, step) : ceilTo(o.worstPrice, step);
        if (!(price > 0)) return badOrder(venue, name, `a worst price of ${plain(o.worstPrice)} is under the smallest price step in ${m.name}`);
        const priceNo = exact(symbol, price, "price", step);
        if (priceNo) return priceNo;
        type = "limit";
        // where the library says the exchange takes no IOC here, the limit order at the worst price is sent as it is
        const ioc = obj(feature(kind).timeInForce).IOC !== false;
        if (ioc) params.timeInForce = "IOC";
        sentAs = `a limit order at ${plain(price)}${ioc ? " that fills at once (IOC)" : ""}: a market order kept inside its worst price`;
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
      if (price !== undefined && m.minNotional !== undefined && notionalOf(m, o.qty, price) < m.minNotional - 1e-9) return badOrder(venue, name, `the smallest order in ${m.name} is worth ${plain(m.minNotional)} ${m.quote}`, { minNotional: m.minNotional });

      let created: Dict;
      try {
        created = obj(await client.createOrder!(symbol, type, o.side, o.qty, price, params));
      } catch (err) {
        const r = fail(err);
        if (r.code !== "E_VENUE_UNREACHABLE" || !UNSURE.has(String((err as { name?: string })?.name ?? ""))) return r;
        // the order call did not come back: whether the order is at the exchange is asked by the account's id, before anything else is said
        let found: Dict | null | undefined;
        try {
          found = await byClientId(symbol, cid);
        } catch {
          found = undefined;
        }
        if (found) return stateOf(found, m.contractSize);
        return no("E_VENUE_UNREACHABLE", { venue, message: found === null ? `${name} did not confirm the order, and shows none under the account's id ${cid} now: look at its open orders before placing it again` : `${name} did not confirm the order: it may or may not have been placed. Look at its open orders before placing it again (the account's id for it: ${cid})`, detail: { clientOrderId: cid }, native: r.native });
      }
      const ref = str(created.id);
      if (!ref) {
        const found = await byClientId(symbol, cid).catch(() => undefined);
        if (found) return stateOf(found, m.contractSize);
        return no("E_VENUE_REJECTED", { venue, message: `${name} answered the order without an order id: look at its open orders before placing it again (the account's id for it: ${cid})`, detail: { clientOrderId: cid } });
      }
      // what the order call answered is little more than the id at most exchanges: what became of it is asked at once
      let seen: Dict | undefined;
      try {
        seen = await lookup(ref, symbol);
      } catch {
        seen = undefined;
      }
      const s = stateOf(seen ?? created, m.contractSize, ref);
      // Binance's order answer carries the fills and their fees; its fetchOrder does not
      if (s.feeUsd === undefined && seen) {
        const fee = feeUsd(created);
        if (fee !== undefined) s.feeUsd = fee;
      }
      return { ...s, native: { ...(s.native as Dict), clientOrderId: cid, ...(sentAs ? { sentAs } : {}) } };
    },

    async cancel(ref, symbol) {
      const f = await find(symbol);
      const cs = isRefusal(f) ? undefined : f.m.contractSize;
      const sym = isRefusal(f) ? symbol : f.m.symbol;
      let answer: Dict;
      try {
        answer = obj(await client.cancelOrder!(ref, sym));
      } catch (err) {
        const r = fail(err, ref);
        if (r.code === "E_VENUE_PERMISSION" || r.code === "E_VENUE_UNAUTHORIZED" || r.code === "E_VENUE_GEOBLOCKED" || r.code === "E_VENUE_UNREACHABLE") return r;
        // filled already, canceled already, or not there: what the exchange shows now is the answer
        try {
          const s = stateOf(await lookup(ref, sym), cs, ref);
          if (DONE.has(s.status)) return s;
        } catch {
          // it does not show it either: its refusal stands
        }
        return r;
      }
      // most exchanges answer a cancel with the id alone (Kraken with a count): the order as it stands is asked again
      try {
        return stateOf(await lookup(ref, sym), cs, ref);
      } catch {
        // the cancel was taken but what became of the order cannot be read now: it is not called canceled with nothing filled (it may have
        // filled in part, or still fill on the way: Bybit and Coinbase cancel later), so the account follows it until the exchange says
        return stateOf(answer, cs, ref);
      }
    },

    async status(ref, symbol) {
      const f = await find(symbol);
      const cs = isRefusal(f) ? undefined : f.m.contractSize;
      try {
        return stateOf(await lookup(ref, isRefusal(f) ? symbol : f.m.symbol), cs, ref);
      } catch (err) {
        return fail(err, ref);
      }
    },
  };
}
