/** A brokerage account at Alpaca, read and traded through its Trading API (docs.alpaca.markets, read 2026-10-05).
 *
 *   GET /v2/account     cash, equity, buying_power                    (numbers arrive as strings)
 *   GET /v2/positions   symbol, qty, market_value, asset_class        (a bare array)
 *
 * and, for orders (the trader at the end of this file):
 *
 *   GET /v2/assets?status=active&asset_class=…        the markets: tradable, fractionable; a coin pair's min_order_size,
 *                                                    min_trade_increment and price_increment (kept five minutes)
 *   GET /v2/assets/{symbol}                          one of them (a coin pair URL-encoded: BTC%2FUSD)
 *   GET /v2/clock                                    whether the US stock market is open, and when it next opens
 *   GET data.alpaca.markets …/quotes/latest          a fresh bid and ask (stocks: also …/trades/latest, the last trade)
 *   POST /v2/orders                                  an order, with the account's id as client_order_id. A MARKET order goes as a
 *                                                    limit order at its worst price, so it never fills past it (see place)
 *   GET /v2/orders/{id}                              what became of it
 *   GET /v2/orders:by_client_order_id                the order under the account's id, when Alpaca did not answer a POST
 *   DELETE /v2/orders/{id}                           cancel it: 204 means asked, not done, so the order is read back
 *
 * Two headers carry the key (APCA-API-KEY-ID, APCA-API-SECRET-KEY); nothing is signed. An individual key has no scopes: any key can place
 * orders, and none can move cash — deposits and withdrawals are not in this API at all, which is why the account's door for this venue says
 * "at the venue". An order moves money only inside the Alpaca account: dollars into shares or coins, and back.
 */
import { isRefusal, type Refusal } from "../../core/errors.ts";
import { no } from "../refuse.ts";
import type { KeyFile, KeyShape } from "./credentials.ts";
import { badOrder, ceilTo, floorTo, inDollars, pick, plain, type LiveTrader, type Market, type OrderRequest, type OrderState, type OrderStatus } from "./trade.ts";
import { asRefusal, num, REGION, redact, unreachable, venueSaidNo, type Http, type HttpReply, type LiveBalance, type LiveSource } from "./types.ts";

export const ALPACA_KEY: KeyShape = { required: ["keyId", "secret"], optional: ["paper"], example: '{"keyId": "…", "secret": "…"} (add "paper": "true" for a paper-trading account)' };

const LIVE = "https://api.alpaca.markets";
const PAPER = "https://paper-api.alpaca.markets";

export async function alpacaSource(req: { venue: string; label: string; reference: string; key: KeyFile; http: Http }): Promise<{ source: LiveSource; first: LiveBalance[] } | Refusal> {
  const paper = req.key.paper === "true";
  const base = paper ? PAPER : LIVE;
  // a paper account says so in its name, whatever the owner called it
  const name = `${req.label || "Alpaca"}${paper && !/paper/i.test(req.label) ? " · paper" : ""}`;
  const secrets = [req.key.keyId, req.key.secret];
  const get = async (path: string): Promise<unknown> => {
    let r;
    try {
      r = await req.http(`${base}${path}`, { headers: { "APCA-API-KEY-ID": req.key.keyId!, "APCA-API-SECRET-KEY": req.key.secret!, accept: "application/json" } });
    } catch (err) {
      throw unreachable(req.venue, name, err, secrets);
    }
    if (r.status !== 200 || r.body === undefined) throw venueSaidNo(req.venue, name, r.status, r.text, secrets);
    return r.body;
  };
  const read = async (): Promise<LiveBalance[]> => {
    const account = (await get("/v2/account")) as Record<string, unknown>;
    const positions = (await get("/v2/positions")) as Array<Record<string, unknown>>;
    if (!account || typeof account !== "object") throw venueSaidNo(req.venue, name, 200, "the account came back empty", secrets);
    return [
      { asset: "USD", amount: num(account.cash), usd: num(account.cash), where: "cash", class: "cash" },
      ...(Array.isArray(positions) ? positions : []).map((p): LiveBalance => ({ asset: String(p.symbol ?? "?"), amount: Math.abs(num(p.qty)), usd: num(p.market_value), where: String(p.asset_class ?? "") === "crypto" ? "crypto" : "stocks", class: String(p.asset_class ?? "") === "crypto" ? "crypto" : "equity" })),
    ];
  };
  try {
    const first = await read();
    const trader = alpacaTrader({ venue: req.venue, name, base, keyId: req.key.keyId!, secret: req.key.secret!, http: req.http });
    const source: LiveSource = { name, kind: "broker", reference: req.reference, via: `Alpaca Trading API${paper ? " · paper" : ""}`, probe: { can: ["read", "trade"], note: "an Alpaca key has no scopes: any key can place orders, and no key can move cash", native: { calls: ["GET /v2/account", "GET /v2/positions"], paper } }, read, readOnlyBecause: "Alpaca's API moves no cash: deposits and withdrawals are made at Alpaca", trader };
    return { source, first };
  } catch (err) {
    return asRefusal(req.venue, name, err, secrets);
  }
}

// ---- trading ---------------------------------------------------------------------------------------

/** Market Data API: one host for live and paper keys alike */
const DATA = "https://data.alpaca.markets";
const LIST_MS = 5 * 60_000;
/** an order Alpaca already holds under the account's id is this order only if it was made this recently */
const RETRY_MS = 10 * 60_000;
/** what an owner looks for first, when nothing is typed yet */
const KNOWN = ["SPY", "QQQ", "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "BTC/USD", "ETH/USD", "SOL/USD"];
const STOCK = /^[A-Z][A-Z0-9.]{0,14}$/;
const PAIR = /^([A-Z0-9]{1,15})\/([A-Z0-9]{1,15})$/;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const positive = (v: unknown): number | undefined => (num(v) > 0 ? num(v) : undefined);
/** does `x` fit in nine decimal places, the most Alpaca takes, so that sending it as nine places changes nothing */
const nine = (x: number): boolean => Math.abs(Number(plain(x, 9)) - x) <= Math.abs(x) * 1e-15;
/** a US stock's tick, by the price itself (Alpaca's sub-penny rule): a cent at $1 and over, a hundredth of a cent under $1. Anything finer
 * is refused */
const tickOf = (price: number): number => (price < 1 ? 0.0001 : 0.01);

/** Alpaca's order status, in the account's words. `accepted` (taken, held outside market hours), `pending_new` and `accepted_for_bidding`
 * (routed, not yet working) and `held` (a leg waiting on another) are pending; `calculated` is a day's end with settlement still to come. */
const WAITING = new Set(["accepted", "pending_new", "accepted_for_bidding", "held"]);
function statusOf(s: string, filled: number, qty: number): OrderStatus {
  switch (s) {
    case "filled":
      return "filled";
    case "canceled":
      return "canceled";
    case "expired":
      return "expired";
    case "rejected":
      return "rejected";
    case "partially_filled":
      return "partial";
    case "calculated":
      if (qty > 0 && filled >= qty - 1e-12) return "filled";
  }
  if (WAITING.has(s)) return filled > 0 ? "partial" : "pending";
  // new, pending_cancel, pending_replace, stopped, suspended, done_for_day, and anything Alpaca adds: still working, still watched
  return filled > 0 ? "partial" : "open";
}

const ORDER_FIELDS = ["id", "client_order_id", "symbol", "asset_class", "side", "type", "time_in_force", "qty", "notional", "limit_price", "filled_qty", "filled_avg_price", "status", "extended_hours", "created_at", "submitted_at", "updated_at", "filled_at", "canceled_at", "expired_at", "failed_at", "expires_at", "replaced_by", "replaces"] as const;
/** the parts of an Alpaca refusal worth keeping: insufficient buying power adds buying_power and cost_basis, insufficient qty adds available,
 * existing_qty and held_for_orders, a wash-trade guard adds reject_reason */
const REFUSAL_FIELDS = ["buying_power", "cost_basis", "available", "existing_qty", "held_for_orders", "symbol", "reject_reason"] as const;

const INSUFFICIENT = /insufficient (buying power|qty|quantity|balance|funds)|not enough (buying power|funds|cash|shares)/i;
const PDT = /pattern day trad/i;
const CLOSED = /market (is )?closed|only allowed during market hours|outside (of )?(regular |market |trading )*hours|\b(asset|symbol|security|contract)\b.{0,40}\bnot (tradable|active)\b|halted/i;
const SIZE_403 = /not fractionable|cannot be sold short/i;

/** "2026-10-06T09:30:00-04:00" as "2026-10-06 09:30": Alpaca's clock speaks New York time */
const nyTime = (s: unknown): string => (typeof s === "string" && s.length >= 16 ? `${s.slice(0, 10)} ${s.slice(11, 16)}` : "");

function alpacaTrader(c: { venue: string; name: string; base: string; keyId: string; secret: string; http: Http }): LiveTrader {
  const secrets = [c.keyId, c.secret];
  const auth = { "APCA-API-KEY-ID": c.keyId, "APCA-API-SECRET-KEY": c.secret };
  let listed: { at: number; all: Market[] } | undefined;
  /** a coin pair's price step (its price_increment), as last read: a market order's worst price is put onto it */
  const steps = new Map<string, { at: number; step: number | undefined }>();
  const learn = (m: Market): void => {
    if (m.kind === "crypto") steps.set(m.symbol, { at: Date.now(), step: m.priceStep });
  };

  const call = async (url: string, method = "GET", body?: unknown, timeoutMs?: number): Promise<HttpReply> => {
    try {
      return await c.http(url, { method, headers: { ...auth, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), ...(timeoutMs ? { timeoutMs } : {}) });
    } catch (err) {
      throw unreachable(c.venue, c.name, err, secrets);
    }
  };

  /** Alpaca's no, in the account's words. Errors are `{code, message}`, sometimes a message alone, sometimes an HTML page (a 401 from its
   * edge). Alpaca says its messages may change and the numeric code and HTTP status do not, but its codes are coarse (40310000 covers buying
   * power, shares, fractionability, shorting and a blocked account), so the status and code come first and the words second. */
  const refusal = (r: HttpReply, order?: string): Refusal => {
    const b = isObj(r.body) ? r.body : {};
    const code = num(b.code) || undefined;
    // redacted before it is cut, so that no part of a secret survives at the cut
    const said = redact(String(typeof b.message === "string" ? b.message : r.text), secrets).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 220);
    const extra = Object.fromEntries(REFUSAL_FIELDS.filter((k) => b[k] !== undefined && b[k] !== null).map((k) => [k, typeof b[k] === "string" ? redact(b[k], secrets) : b[k]]));
    const native = { status: r.status, ...(code ? { code } : {}), said, ...extra };
    const words = said ? `${c.name}: ${said}` : `${c.name} refused (HTTP ${r.status})`;
    const withNative = (x: Refusal): Refusal => ({ ...x, native });
    if (r.status === 451 || REGION.test(said)) return no("E_VENUE_GEOBLOCKED", { venue: c.venue, message: `${c.name} does not serve this location: that is its own rule, and the account does not look for a way around it`, native });
    if (r.status === 401) return no("E_VENUE_UNAUTHORIZED", { venue: c.venue, message: `${c.name} does not accept this key`, native });
    if (r.status === 429) return no("E_VENUE_UNREACHABLE", { venue: c.venue, message: `${c.name} is rate-limiting this machine: try again in a minute`, native });
    if (r.status >= 500 || r.status === 0) return no("E_VENUE_UNREACHABLE", { venue: c.venue, message: `${c.name} did not answer`, native });
    if (r.status === 404 || code === 40410000) return order !== undefined ? no("E_ACCOUNT_ORDER_UNKNOWN", { venue: c.venue, message: `${c.name} has no order ${order} for this key`, detail: { order }, native }) : no("E_VENUE_REJECTED", { venue: c.venue, message: words, native });
    if (INSUFFICIENT.test(said)) return no("E_VENUE_INSUFFICIENT", { venue: c.venue, message: words, native });
    // the legacy pattern-day-trader refusal (40310100): Alpaca says the rule is gone, but the code is still documented
    if (code === 40310100 || PDT.test(said)) return no("E_VENUE_PERMISSION", { venue: c.venue, message: words, native });
    if (CLOSED.test(said)) return no("E_VENUE_MARKET_CLOSED", { venue: c.venue, message: words, native });
    if (r.status === 403 && /wash trade/i.test(said)) return no("E_VENUE_REJECTED", { venue: c.venue, message: words, native });
    if (r.status === 403 && SIZE_403.test(said)) return withNative(badOrder(c.venue, c.name, said, code ? { code } : undefined));
    // 403 otherwise: the account may not do this — "account is not authorized to trade", "restricted to liquidation only", "not allowed to
    // short", crypto not enabled on the account
    if (r.status === 403) return no("E_VENUE_PERMISSION", { venue: c.venue, message: words, native });
    // 400 and 422 (40010000, 40010001, 42210000): the order as written — its size, its price's tick, its type or time in force
    if (r.status === 400 || r.status === 422) return withNative(badOrder(c.venue, c.name, said || `the order was refused as written (HTTP ${r.status})`, code ? { code } : undefined));
    return no("E_VENUE_REJECTED", { venue: c.venue, message: words, native });
  };

  const getJson = async (url: string, timeoutMs?: number): Promise<unknown> => {
    const r = await call(url, "GET", undefined, timeoutMs);
    if (r.status !== 200 || r.body === undefined) throw refusal(r);
    return r.body;
  };
  /** a read whose failure is not the end of the question: its refusal comes back instead of being thrown */
  const soft = async (url: string): Promise<unknown> => {
    try {
      return await getJson(url);
    } catch (err) {
      return asRefusal(c.venue, c.name, err, secrets);
    }
  };

  /** a coin pair's price step: as read with the market a moment ago, or asked of Alpaca now (GET /v2/assets/{pair}). A pair that does not
   * answer is not traded: its refusal is thrown, and nothing is placed */
  const stepOf = async (symbol: string): Promise<number | undefined> => {
    const hit = steps.get(symbol);
    if (hit && Date.now() - hit.at < LIST_MS) return hit.step;
    const a = await getJson(`${c.base}/v2/assets/${encodeURIComponent(symbol)}`);
    const step = isObj(a) ? positive(a.price_increment) : undefined;
    steps.set(symbol, { at: Date.now(), step });
    return step;
  };

  /** one asset as a market, before any price: what Alpaca says about it in /v2/assets */
  const marketOf = (a: Json): Market | undefined => {
    const symbol = String(a.symbol ?? "");
    const open = a.tradable === true && a.status === "active";
    const name = String(a.name ?? symbol) || symbol;
    const attrs = Array.isArray(a.attributes) ? a.attributes.map(String) : [];
    if (a.class === "us_equity") {
      const fractionable = a.fractionable === true;
      return {
        symbol,
        name,
        kind: "stock",
        base: symbol,
        quote: "USD",
        // whole shares, or a fraction to nine decimals when Alpaca says the stock is fractionable
        minQty: fractionable ? undefined : 1,
        qtyStep: fractionable ? 1e-9 : 1,
        // Alpaca takes no buy worth less than $1. Its rule names buys only; a market here has one minimum, so a sell is held to it too
        minNotional: 1,
        open,
        ...(open ? {} : { note: `${c.name} does not trade ${symbol} now` }),
        // an IPO-flagged stock takes limit orders only until it first trades
        types: attrs.includes("ipo") ? ["limit"] : ["market", "limit"],
      };
    }
    if (a.class === "crypto") {
      const m = PAIR.exec(symbol);
      if (!m || !inDollars(m[2]!)) return undefined;
      return {
        symbol,
        name,
        kind: "crypto",
        base: m[1]!,
        quote: m[2]!,
        minQty: positive(a.min_order_size),
        qtyStep: positive(a.min_trade_increment),
        // the asset schema calls price_increment the step of a price; a support page calls it the smallest notional. Read as a price step,
        // the stricter of the two
        priceStep: positive(a.price_increment),
        open,
        ...(open ? {} : { note: `${c.name} does not trade ${symbol} now` }),
        types: ["market", "limit"],
      };
    }
    return undefined;
  };

  const list = async (): Promise<Market[]> => {
    if (listed && Date.now() - listed.at < LIST_MS) return listed.all;
    const [stocks, coins] = await Promise.all([getJson(`${c.base}/v2/assets?status=active&asset_class=us_equity`, 30_000), soft(`${c.base}/v2/assets?status=active&asset_class=crypto`)]);
    const all = [...(Array.isArray(stocks) ? stocks : []), ...(Array.isArray(coins) ? coins : [])]
      .filter((a): a is Json => isObj(a) && a.tradable === true)
      .map(marketOf)
      .filter((m): m is Market => m !== undefined && m.open)
      .sort((x, y) => rank(x) - rank(y) || x.symbol.localeCompare(y.symbol));
    all.forEach(learn);
    listed = { at: Date.now(), all };
    return all;
  };
  const rank = (m: Market): number => (KNOWN.includes(m.symbol) ? KNOWN.indexOf(m.symbol) : KNOWN.length);

  const market = async (raw: string): Promise<Market> => {
    const symbol = raw.trim().toUpperCase();
    const pair = PAIR.exec(symbol);
    if (pair && !inDollars(pair[2]!)) throw no("E_ACCOUNT_UNPRICED", { venue: c.venue, message: `${symbol} is priced in ${pair[2]}: the account trades markets priced in dollars, so that every limit means dollars` });
    if (!pair && !STOCK.test(symbol)) throw no("E_VENUE_REJECTED", { venue: c.venue, message: `${c.name} lists no market "${raw.trim()}": a stock is its ticker (AAPL), a coin a pair (BTC/USD)` });
    const assetUrl = `${c.base}/v2/assets/${encodeURIComponent(symbol)}`;
    // a stock's asset, the clock and its price are asked at once; a pair needs no clock (crypto trades every day, around the clock)
    const [assetR, clock, quote, trade] = await Promise.all([call(assetUrl), pair ? undefined : soft(`${c.base}/v2/clock`), pair ? undefined : soft(`${DATA}/v2/stocks/${encodeURIComponent(symbol)}/quotes/latest`), pair ? undefined : soft(`${DATA}/v2/stocks/${encodeURIComponent(symbol)}/trades/latest`)]);
    if (assetR.status === 404 || (assetR.status === 422 && /not found/i.test(assetR.text))) throw no("E_VENUE_REJECTED", { venue: c.venue, message: `${c.name} lists no market ${symbol}`, native: { status: assetR.status, said: redact(assetR.text, secrets).slice(0, 200) } });
    if (assetR.status !== 200 || !isObj(assetR.body)) throw refusal(assetR);
    const asset = assetR.body;
    const m = marketOf(asset);
    if (!m) {
      const q = PAIR.exec(String(asset.symbol ?? ""));
      if (asset.class === "crypto" && q) throw no("E_ACCOUNT_UNPRICED", { venue: c.venue, message: `${q[0]} is priced in ${q[2]}: the account trades markets priced in dollars, so that every limit means dollars` });
      throw no("E_VENUE_REJECTED", { venue: c.venue, message: `${c.name} lists ${symbol} as ${String(asset.class ?? "something else")}: the account trades its US stocks, ETFs and crypto`, native: { class: asset.class ?? null } });
    }
    if (m.kind === "crypto") {
      learn(m);
      // Alpaca's own crypto venue, where its orders execute; the pair keeps its slash (BTCUSD is refused here)
      const book = await soft(`${DATA}/v1beta3/crypto/us/latest/quotes?symbols=${m.symbol}`);
      const qt = !isRefusal(book) && isObj(book) && isObj(book.quotes) && isObj(book.quotes[m.symbol]) ? (book.quotes[m.symbol] as Json) : undefined;
      const bid = positive(qt?.bp);
      const ask = positive(qt?.ap);
      return { ...m, bid, ask, price: bid && ask ? (bid + ask) / 2 : (bid ?? ask), ...(isRefusal(book) && m.open ? { note: `${c.name}'s market data did not answer: ${book.message}` } : {}) };
    }
    // a stock: the latest quote and trade on whatever feed this key may use (Alpaca's default is all exchanges with a subscription, IEX
    // without one); 0 means no bid or ask is up
    const qt = !isRefusal(quote) && isObj(quote) && isObj(quote.quote) ? quote.quote : undefined;
    const tr = !isRefusal(trade) && isObj(trade) && isObj(trade.trade) ? trade.trade : undefined;
    const bid = positive(qt?.bp);
    const ask = positive(qt?.ap);
    const price = bid && ask ? (bid + ask) / 2 : (positive(tr?.p) ?? bid ?? ask);
    // a stock's tick: a cent from $1, a hundredth of a cent below it; Alpaca refuses anything finer
    const priceStep = price !== undefined && price < 1 ? 0.0001 : 0.01;
    let note = m.note;
    let types = m.types;
    if (m.open) {
      // Outside the regular session Alpaca still takes the order and holds it (status `accepted`) until the next one: an order with
      // extended_hours unset — and the account never sets it — waits for 9:30 New York time. A limit order held so fills at its limit or
      // better; a market order would fill at the opening price, which can be well past the price it was valued at here (and past the cap
      // and the agent's limit, which allow 2%). So until the clock says the market is open, only limit orders are offered.
      const isOpen = isObj(clock) && !isRefusal(clock) && clock.is_open === true;
      if (!isOpen) types = types.filter((t) => t !== "market");
      if (isObj(clock) && clock.is_open === false) note = `the US stock market is closed: ${c.name} holds an order and sends it when the market opens${nyTime(clock.next_open) ? ` (${nyTime(clock.next_open)} New York time)` : ""}. Until then only limit orders are placed here: a market order would fill at the opening price, which can be well away from this one`;
      else if (isRefusal(clock)) note = `${c.name}'s market clock did not answer, so only limit orders are placed here: outside market hours ${c.name} holds an order until the market opens, and a market order would fill at the opening price`;
      if (price === undefined && isRefusal(quote)) note = `${note ? `${note} · ` : ""}${c.name}'s market data did not answer: ${quote.message}`;
    }
    return { ...m, price, bid, ask, priceStep, note, types };
  };

  const order = async (ref: string): Promise<Json> => {
    const r = await call(`${c.base}/v2/orders/${encodeURIComponent(ref)}`);
    if (r.status !== 200) throw refusal(r, ref);
    if (!isObj(r.body) || typeof r.body.id !== "string") throw new Error("the order came back without its id");
    return r.body;
  };
  const stateOf = (o: Json): OrderState => {
    const filled = num(o.filled_qty);
    const avg = positive(o.filled_avg_price);
    // no fee is on an Alpaca order: stock trades pay none but the regulatory fees, and crypto fees are posted at the end of the day
    return { ref: String(o.id), status: statusOf(String(o.status ?? ""), filled, num(o.qty)), filledQty: filled, ...(avg !== undefined ? { avgPrice: avg } : {}), native: Object.fromEntries(ORDER_FIELDS.filter((k) => o[k] !== undefined).map((k) => [k, o[k]])) };
  };
  const read = async (ref: string): Promise<OrderState> => {
    let o = await order(ref);
    // an order Alpaca replaced (a corporate action, or an edit made at Alpaca) goes on under a new id: followed, a few hops at most. One
    // still `replaced` after that counts as working, so it is asked again rather than taken for done
    for (let hop = 0; o.status === "replaced" && typeof o.replaced_by === "string" && o.replaced_by && hop < 3; hop++) o = await order(o.replaced_by);
    return stateOf(o);
  };

  /** What Alpaca holds under the account's id (GET /v2/orders:by_client_order_id): THIS order — the same market, side, size, type and price
   * as the one sent (a market order was sent as a limit at its worst price, and is matched as that), made minutes ago — or none, or another
   * order made earlier under the same id, or no answer */
  type Held = { is: "this"; state: OrderState } | { is: "none" } | { is: "other"; no: Refusal } | { is: "unknown"; no: Refusal };
  type Sent = Pick<OrderRequest, "symbol" | "side" | "type" | "qty" | "limitPrice">;
  const held = async (cid: string, o: Sent): Promise<Held> => {
    let r: HttpReply;
    try {
      r = await call(`${c.base}/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(cid)}`);
    } catch (err) {
      return { is: "unknown", no: asRefusal(c.venue, c.name, err, secrets) };
    }
    if (r.status === 404) return { is: "none" };
    if (r.status !== 200 || !isObj(r.body) || typeof r.body.id !== "string") return { is: "unknown", no: refusal(r) };
    const x = r.body;
    const made = Date.parse(String(x.created_at ?? x.submitted_at ?? ""));
    const same = String(x.symbol ?? "").replace("/", "") === o.symbol.replace("/", "") && x.side === o.side && (x.type ?? x.order_type) === o.type && Math.abs(num(x.qty) - o.qty) < 1e-9 && (o.type === "market" || Math.abs(num(x.limit_price) - (o.limitPrice ?? 0)) < 1e-9) && Number.isFinite(made) && Math.abs(Date.now() - made) < RETRY_MS;
    if (same) return { is: "this", state: stateOf(x) };
    return { is: "other", no: no("E_VENUE_REJECTED", { venue: c.venue, message: `${c.name} already holds an earlier, different order under the account's id ${cid}: nothing new was placed`, detail: { clientOrderId: cid, theirs: x.id }, native: { status: x.status ?? null, symbol: x.symbol ?? null, created_at: x.created_at ?? null } }) };
  };

  return {
    // an individual Alpaca key has no scopes: whether the ACCOUNT may trade is Alpaca's to say, and its 403 carries its own words
    can: true,
    what: "US stocks, ETFs and crypto",

    async markets(query) {
      try {
        return pick(await list(), query);
      } catch (err) {
        return asRefusal(c.venue, c.name, err, secrets);
      }
    },

    async market(symbol) {
      try {
        return await market(symbol);
      } catch (err) {
        return asRefusal(c.venue, c.name, err, secrets);
      }
    },

    async place(o) {
      try {
        if (!(Number.isFinite(o.qty) && o.qty > 0)) return badOrder(c.venue, c.name, "a size is more than zero");
        if (o.type === "limit" && !(o.limitPrice !== undefined && Number.isFinite(o.limitPrice) && o.limitPrice > 0)) return badOrder(c.venue, c.name, "a limit order has a limit price");
        if (o.type === "market" && o.limitPrice !== undefined) return badOrder(c.venue, c.name, "a market order has no limit price");
        // a market order is never sent without the worst price it may fill at: Alpaca is given a limit there, never an open market order
        if (o.type === "market" && !(o.worstPrice !== undefined && Number.isFinite(o.worstPrice) && o.worstPrice > 0)) return badOrder(c.venue, c.name, "a market order carries the worst price it may fill at");
        const pair = PAIR.exec(o.symbol);
        if (pair && !inDollars(pair[2]!)) return no("E_ACCOUNT_UNPRICED", { venue: c.venue, message: `${o.symbol} is priced in ${pair[2]}: the account trades markets priced in dollars, so that every limit means dollars` });
        const whole = Math.abs(o.qty - Math.round(o.qty)) < 1e-9;
        // Alpaca allows 128 characters; letters, digits and hyphens keep it plain in a URL when the order is looked up by it
        const cid = o.clientId.replace(/[^A-Za-z0-9-]/g, "-").slice(0, 128);
        // numbers go as decimal strings, nine places at most, as the OpenAPI types them; never notional — the account sends a size. A size
        // or price finer than nine places is refused, not rounded: rounding could send an order bigger or pricier than the one valued
        if (!nine(o.qty)) return badOrder(c.venue, c.name, "a size has at most nine decimal places");
        if (o.type === "limit" && !nine(o.limitPrice!)) return badOrder(c.venue, c.name, "a limit price has at most nine decimal places");
        // A MARKET order goes as a limit order at its worst price, so that it fills there or better, or not at all. The price is put onto the
        // market's grid on the safe side — a buy down, a sell up, never past the worst price: a stock by the sub-penny rule (a cent from $1,
        // a hundredth of a cent under it, by the price sent), a pair by its price_increment (read with the market; asked for here if not).
        let limit = o.limitPrice;
        if (o.type === "market") {
          const worst = o.worstPrice!;
          const step = pair ? ((await stepOf(o.symbol)) ?? 1e-9) : tickOf(worst);
          limit = o.side === "buy" ? floorTo(worst, step) : ceilTo(worst, step);
          if (!(limit > 0)) return badOrder(c.venue, c.name, `the worst price ${plain(worst)} is under the smallest price step of ${o.symbol} (${plain(step)})`);
          if (!nine(limit)) return badOrder(c.venue, c.name, "a worst price has at most nine decimal places");
        }
        // Time in force. A pair takes gtc or ioc only (no day): its market order is ioc — what does not fill at once at the worst price or
        // better is canceled, as a market order's rest would be. A stock market order is day: Alpaca lists ioc and fok for stocks only "for
        // the sales team" to enable, so an individual account's ioc may be refused; a day limit at the worst price fills at once at that price
        // or better, and what it cannot fill waits on the book for that price and lapses at the close (fractions must be day anyway).
        // extended_hours is never set: a stock market order is offered only while the clock says the regular session is open. A whole-share
        // limit is gtc, as a limit is on an exchange; Alpaca cancels a gtc order by itself 90 days on. Older pages said a fraction goes only
        // as a market order, newer ones allow a day limit too: it is sent, and Alpaca's own refusal is the answer if it says otherwise.
        const tif = pair ? (o.type === "market" ? "ioc" : "gtc") : o.type === "limit" && whole ? "gtc" : "day";
        const sent: Sent = { symbol: o.symbol, side: o.side, type: "limit", qty: o.qty, limitPrice: limit! };
        const body: Record<string, string> = { symbol: o.symbol, qty: plain(o.qty, 9), side: o.side, type: "limit", limit_price: plain(limit!, 9), time_in_force: tif, client_order_id: cid };
        let r: HttpReply;
        try {
          r = await call(`${c.base}/v2/orders`, "POST", body);
        } catch (err) {
          return await silent(cid, sent, asRefusal(c.venue, c.name, err, secrets));
        }
        if (r.status === 200 || r.status === 201) {
          if (!isObj(r.body) || typeof r.body.id !== "string") return await silent(cid, sent, no("E_VENUE_REJECTED", { venue: c.venue, message: `${c.name} took the order but its answer could not be read`, native: { status: r.status, said: redact(r.text, secrets).slice(0, 200) } }));
          return stateOf(r.body);
        }
        // a timeout or an error at Alpaca's side: the order may have reached the market all the same, so Alpaca is asked by the account's id
        if (r.status >= 500) return await silent(cid, sent, refusal(r));
        // the account's id is already in use at Alpaca: this order, if it is the same one made minutes ago; otherwise someone else's
        if (/client_order_id must be unique/i.test(r.text)) {
          const h = await held(cid, sent);
          if (h.is === "this") return h.state;
          if (h.is === "other") return h.no;
          return no("E_VENUE_REJECTED", { venue: c.venue, message: `${c.name} says the account's id ${cid} is already in use: nothing new was placed`, detail: { clientOrderId: cid }, native: refusal(r).native });
        }
        return refusal(r);
      } catch (err) {
        return asRefusal(c.venue, c.name, err, secrets);
      }
    },

    async cancel(ref) {
      try {
        const r = await call(`${c.base}/v2/orders/${encodeURIComponent(ref)}`, "DELETE");
        // 204: the cancel is asked for; the order may sit in pending_cancel a moment, and may still fill. It is read back as it stands
        if (r.status === 204 || r.status === 200) return await read(ref);
        // 422: no longer cancelable. Filled, canceled or expired, it is read back as that; still working (pending_replace), the refusal stands
        if (r.status === 422) {
          const now = await read(ref).catch(() => undefined);
          if (now && (now.status === "filled" || now.status === "canceled" || now.status === "expired" || now.status === "rejected")) return now;
        }
        return refusal(r, ref);
      } catch (err) {
        return asRefusal(c.venue, c.name, err, secrets);
      }
    },

    async status(ref) {
      try {
        return await read(ref);
      } catch (err) {
        return asRefusal(c.venue, c.name, err, secrets);
      }
    },
  };

  /** Alpaca did not answer an order: its docs say not to send it again until it is known. Asked by the account's id, it is either there (and
   * returned as placed), not there, or still unknown — never sent twice from here */
  async function silent(cid: string, o: Sent, why: Refusal): Promise<OrderState | Refusal> {
    const h = await held(cid, o);
    if (h.is === "this") return h.state;
    // another order already had this id, so Alpaca would have refused this one as a duplicate
    if (h.is === "other") return h.no;
    if (h.is === "none") return { ...why, message: `${why.message}, and a moment later it held no order under the account's id ${cid}: nothing was placed`, detail: { clientOrderId: cid, placed: false } };
    return { ...why, message: `${why.message}: the order may have been taken all the same. Look at ${c.name}'s orders for ${cid} before placing it again`, detail: { clientOrderId: cid, placed: "unknown" } };
  }
}
