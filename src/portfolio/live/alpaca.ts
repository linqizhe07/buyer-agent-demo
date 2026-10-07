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
 *   GET /v2/clock                                    whether the US stock market is open, and when it next opens and closes: a
 *                                                    stock market's session (Market.session)
 *   GET data.alpaca.markets …/quotes/latest          a fresh bid and ask (stocks: also …/trades/latest, the last trade)
 *   POST /v2/orders                                  an order, with the account's id as client_order_id. A MARKET order goes as a
 *                                                    limit order at its worst price, and a STOP as a stop-limit at its worst price,
 *                                                    so neither ever fills past it (see place)
 *   GET /v2/orders/{id}                              what became of it
 *   GET /v2/orders:by_client_order_id                the order under the account's id, when Alpaca did not answer a POST or a PATCH
 *   DELETE /v2/orders/{id}                           cancel it: 204 means asked, not done, so the order is read back
 *   PATCH /v2/orders/{id}                            change it (Alpaca's replace): the answer is a NEW order, under a new id
 *   GET /v2/positions                                what is held, for the trader too
 *   DELETE /v2/positions/{symbol}?qty=               close a position: Alpaca places a market order of its own for it
 *
 * and, to read the market (Market Data API, nothing placed):
 *
 *   GET data.alpaca.markets/v2/stocks/snapshots      many stocks at once, keyed by symbol: latestTrade, dailyBar, prevDailyBar
 *   GET data.alpaca.markets/v1beta3/crypto/us/snapshots   many coin pairs at once, under `snapshots`
 *   GET data.alpaca.markets/v2/stocks/bars, …/v1beta3/crypto/us/bars   price history (bars keyed by symbol)
 *
 * and, for crypto coming in (Alpaca's Crypto Wallets API, docs.alpaca.markets/us/docs/crypto-wallets-api and
 * /us/reference/listcryptofundingwallets, read 2026-10-06; Alpaca enables it per account — "you have to reach out to Alpaca to enable Crypto
 * Wallets API access" — so it is asked once at connect, and its answer is the answer):
 *
 *   GET /v2/wallets                                  the account's deposit wallets (200: enabled; 403 or 404: not for this account)
 *   GET /v2/wallets?asset=USDC&chain=ETH             one wallet's address, made on the spot when there is none ("If specified and no wallet
 *                                                    exists, one will be created"); its chains are ETH, ARB, SOL, BTC and XRP
 *
 * Two headers carry the key (APCA-API-KEY-ID, APCA-API-SECRET-KEY); nothing is signed. An individual key has no scopes: any key can place
 * orders. Cash moves by ACH at Alpaca, not through this API. Crypto leaves Alpaca in the Alpaca app: its Trading API withdrawal (POST
 * /v2/wallets/transfers) is deprecated — "Use the Alpaca web application to initiate withdrawals. Since: 2026-07-09 / Sunset: 2026-10-09" —
 * so none is made from here. An order moves money only inside the Alpaca account: dollars into shares or coins, and back.
 */
import { getAddress, isAddress } from "viem";
import { isRefusal, type Refusal } from "../../core/errors.ts";
import { no } from "../refuse.ts";
import type { ChainName } from "./chain.ts";
import type { KeyFile, KeyShape } from "./credentials.ts";
import { badOrder, ceilTo, CANDLE_INTERVALS, DONE, floorTo, inDollars, pick, plain, type Candle, type CandleInterval, type LiveTrader, type Market, type MarketSession, type MarketStats, type OrderRequest, type OrderState, type OrderStatus, type Position, type TimeInForce } from "./trade.ts";
import { asRefusal, num, REGION, redact, unreachable, venueSaidNo, type Http, type HttpReply, type LiveBalance, type LiveSource } from "./types.ts";
import type { LiveWriter } from "./writes.ts";

export const ALPACA_KEY: KeyShape = { required: ["keyId", "secret"], optional: ["paper"], example: '{"keyId": "…", "secret": "…"} (add "paper": "true" for a paper-trading account)' };

const LIVE = "https://api.alpaca.markets";
const PAPER = "https://paper-api.alpaca.markets";

/** the chains of this account's that Alpaca's wallets are on, by Alpaca's own code for each (its others, SOL, BTC and XRP, are not read here) */
const WALLET_CHAIN: Partial<Record<ChainName, string>> = { Ethereum: "ETH", Arbitrum: "ARB" };
/** why no withdrawal is made from here, in Alpaca's words: its reference page for POST /v2/wallets/transfers */
const NO_WITHDRAWAL = 'Alpaca retired crypto withdrawals through its Trading API ("This endpoint is deprecated. Use the Alpaca web application to initiate withdrawals." Sunset: 2026-10-09): crypto leaves Alpaca in the Alpaca app, to an address whitelisted there first; cash moves by ACH at Alpaca';

export async function alpacaSource(req: { venue: string; label: string; reference: string; key: KeyFile; http: Http; clock?: (() => number) | undefined }): Promise<{ source: LiveSource; first: LiveBalance[] } | Refusal> {
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
  /** A position as a balance. A coin is named by its base, as positions() names its market (BTCUSD is BTC), so that it is one row with the
   * same coin held elsewhere. A short is not something held: it is carried as what it is, a negative amount worth what buying it back
   * costs (Alpaca's market_value, negative), so that the venue's total is net of it as Alpaca's own equity is — and it is a short
   * position in positions(), never a positive holding */
  const balanceOf = (p: Record<string, unknown>): LiveBalance => {
    const crypto = String(p.asset_class ?? "") === "crypto";
    const raw = String(p.symbol ?? "?").toUpperCase();
    const asset = crypto ? (raw.includes("/") ? raw.slice(0, raw.indexOf("/")) : (/^([A-Z0-9]+)USD$/.exec(raw)?.[1] ?? raw)) : raw;
    const q = num(p.qty);
    const where = crypto ? "crypto" : "stocks";
    const cls = crypto ? "crypto" : "equity";
    if (p.side === "short" || q < 0) return { asset, amount: -Math.abs(q), usd: -Math.abs(num(p.market_value)), where: `${where} · short`, class: cls };
    return { asset, amount: q, usd: num(p.market_value), where, class: cls };
  };
  const read = async (): Promise<LiveBalance[]> => {
    const account = (await get("/v2/account")) as Record<string, unknown>;
    const positions = (await get("/v2/positions")) as Array<Record<string, unknown>>;
    if (!account || typeof account !== "object") throw venueSaidNo(req.venue, name, 200, "the account came back empty", secrets);
    return [
      { asset: "USD", amount: num(account.cash), usd: num(account.cash), where: "cash", class: "cash" },
      ...(Array.isArray(positions) ? positions : []).map(balanceOf),
    ];
  };
  /** Alpaca's own answer to a wallets call that was not a 200, in its words and without the key */
  const walletWords = (r: HttpReply): string => {
    const b = r.body && typeof r.body === "object" ? (r.body as Record<string, unknown>) : {};
    const said = redact(String(typeof b.message === "string" ? b.message : r.text), secrets).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
    return `HTTP ${r.status}${said ? `, "${said}"` : ""}`;
  };
  /** whether Alpaca has crypto wallets for this account: asked once, softly — a no is Alpaca's own answer, and the connection goes on */
  const wallets = async (): Promise<{ on: true } | { on: false; why: string }> => {
    let r: HttpReply;
    try {
      r = await req.http(`${base}/v2/wallets`, { headers: { "APCA-API-KEY-ID": req.key.keyId!, "APCA-API-SECRET-KEY": req.key.secret!, accept: "application/json" } });
    } catch (err) {
      return { on: false, why: `Alpaca did not answer whether this account has crypto wallets (${unreachable(req.venue, name, err, secrets).message}): nothing is sent to it from here until it is connected again. Cash moves by ACH at Alpaca` };
    }
    if (r.status === 200) return { on: true };
    if (r.status === 403 || r.status === 404) return { on: false, why: `Alpaca has not enabled the Crypto Wallets API for this account (GET /v2/wallets: ${walletWords(r)}): cash moves by ACH at Alpaca, and crypto wallets are enabled by Alpaca on request` };
    return { on: false, why: `Alpaca did not say whether this account has crypto wallets (GET /v2/wallets: ${walletWords(r)}): nothing is sent to it from here until it is connected again. Cash moves by ACH at Alpaca` };
  };
  try {
    const first = await read();
    const trader = alpacaTrader({ venue: req.venue, name, base, keyId: req.key.keyId!, secret: req.key.secret!, http: req.http, clock: req.clock ?? Date.now });
    const w = await wallets();
    const writer = w.on ? alpacaWriter({ venue: req.venue, name, base, keyId: req.key.keyId!, secret: req.key.secret!, http: req.http }) : undefined;
    const note = `an Alpaca key has no scopes: any key can place orders. ${w.on ? "Crypto comes in to Alpaca's wallets for this account (GET /v2/wallets: enabled), on Ethereum or Arbitrum; it leaves Alpaca in the Alpaca app (the Trading API's withdrawal is deprecated, sunset 2026-10-09). Cash moves by ACH at Alpaca" : w.why}`;
    const source: LiveSource = { name, kind: "broker", reference: req.reference, via: `Alpaca Trading API${paper ? " · paper" : ""}`, probe: { can: ["read", "trade"], note, native: { calls: ["GET /v2/account", "GET /v2/positions", "GET /v2/wallets"], paper, wallets: w.on } }, read, ...(writer ? { writer } : { readOnlyBecause: (w as { why: string }).why }), trader };
    return { source, first };
  } catch (err) {
    return asRefusal(req.venue, name, err, secrets);
  }
}

// ---- crypto coming in: Alpaca's wallets --------------------------------------------------------------

/** Money INTO Alpaca: the account's own deposit wallet at Alpaca for an asset on a chain, as Alpaca gives it (GET /v2/wallets?asset=&chain=,
 * one wallet, made on the spot when there is none). Nothing leaves Alpaca from here: its Trading API withdrawal is deprecated (sunset
 * 2026-10-09), and `can.why.withdraw` says so in Alpaca's words. The shape of one wallet is `address`, `chain`, `created_at` (its OpenAPI
 * definition); an answer in another shape is read for an `address` and refused when none is there */
function alpacaWriter(c: { venue: string; name: string; base: string; keyId: string; secret: string; http: Http }): LiveWriter {
  const secrets = [c.keyId, c.secret];
  const headers = { "APCA-API-KEY-ID": c.keyId, "APCA-API-SECRET-KEY": c.secret, accept: "application/json" };
  const said = (r: HttpReply): { said: string; native: Record<string, unknown> } => {
    const b = r.body && typeof r.body === "object" && !Array.isArray(r.body) ? (r.body as Record<string, unknown>) : {};
    const text = redact(String(typeof b.message === "string" ? b.message : r.text), secrets).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 220);
    return { said: text, native: { status: r.status, ...(num(b.code) ? { code: num(b.code) } : {}), said: text } };
  };
  return {
    can: { withdraw: false, ledgers: [], transfer: false, swap: false, receive: true, send: false, why: { withdraw: NO_WITHDRAWAL } },
    async depositAddress(asset, chain) {
      const code = WALLET_CHAIN[chain];
      if (!code) return no("E_VENUE_RAIL_CLOSED", { venue: c.venue, message: `${c.name}'s crypto wallets are on Ethereum and Arbitrum (Alpaca's chains: ETH, ARB, SOL, BTC, XRP): not on ${chain}` });
      const a = asset.trim().toUpperCase();
      let r: HttpReply;
      try {
        r = await c.http(`${c.base}/v2/wallets?asset=${encodeURIComponent(a)}&chain=${code}`, { headers });
      } catch (err) {
        return unreachable(c.venue, c.name, err, secrets);
      }
      if (r.status !== 200) {
        const { said: words, native } = said(r);
        if (r.status === 401) return no("E_VENUE_UNAUTHORIZED", { venue: c.venue, message: `${c.name} does not accept this key`, native });
        if (r.status === 403) return no("E_VENUE_PERMISSION", { venue: c.venue, message: `${c.name} refused the wallet: ${words || "the Crypto Wallets API is not enabled for this account"}`, native });
        if (r.status === 404) return no("E_VENUE_RAIL_CLOSED", { venue: c.venue, message: `${c.name} has no ${a} wallet on ${chain} for this account${words ? ` (it says: ${words})` : ""}`, native });
        if (r.status === 429) return no("E_VENUE_UNREACHABLE", { venue: c.venue, message: `${c.name} is rate-limiting this machine: try again in a minute`, native });
        if (r.status >= 500) return no("E_VENUE_UNREACHABLE", { venue: c.venue, message: `${c.name} did not answer`, native });
        return no("E_VENUE_RAIL_CLOSED", { venue: c.venue, message: `${c.name} gives no ${a} wallet on ${chain}${words ? `: ${words}` : ` (HTTP ${r.status})`}`, native });
      }
      // one wallet when the asset is named; a list is read for the one on this chain, or its first
      const rows = (Array.isArray(r.body) ? r.body : r.body && typeof r.body === "object" ? [r.body] : []).filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
      const row = rows.find((x) => String(x.chain ?? "").toUpperCase() === code) ?? rows[0];
      const address = String(row?.address ?? "");
      if (!row || !isAddress(address, { strict: false })) return no("E_VENUE_REJECTED", { venue: c.venue, message: `${c.name} answered the ${a} wallet on ${chain} without an EVM address in it`, native: { status: r.status, said: redact(r.text, secrets).slice(0, 200) } });
      return { address: getAddress(address), note: `${c.name}'s own ${a} wallet for this account on ${chain}${row.chain ? ` (its chain code: ${String(row.chain)})` : ""}: what lands there trades at ${c.name}. Crypto leaves ${c.name} in the Alpaca app` };
    },
  };
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
/** the most markets one stats call reads: one snapshots request for the stocks among them, one for the pairs */
const STATS_MAX = 100;
/** the most bars one history reads, the latest first, in one request */
const BARS = 300;
/** a bar's size in Alpaca's words (timeframe: [1-59]Min, [1-23]Hour, 1Day) */
const TIMEFRAME: Record<CandleInterval, string> = { "5m": "5Min", "1h": "1Hour", "1d": "1Day" };

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const positive = (v: unknown): number | undefined => (num(v) > 0 ? num(v) : undefined);
/** does `x` fit in nine decimal places, the most Alpaca takes, so that sending it as nine places changes nothing */
const nine = (x: number): boolean => Math.abs(Number(plain(x, 9)) - x) <= Math.abs(x) * 1e-15;
/** a US stock's tick, by the price itself (Alpaca's sub-penny rule): a cent at $1 and over, a hundredth of a cent under $1. Anything finer
 * is refused */
const tickOf = (price: number): number => (price < 1 ? 0.0001 : 0.01);
const isWhole = (x: number): boolean => Math.abs(x - Math.round(x)) < 1e-9;
/** an id as Alpaca takes it plainly: letters, digits and hyphens, so that it reads the same in a URL when the order is looked up by it.
 * Alpaca allows 128 characters */
const idOf = (id: string, max = 128): string => id.replace(/[^A-Za-z0-9-]/g, "-").slice(0, max);

/** Alpaca's order status, in the account's words. `accepted` (taken, held outside market hours), `pending_new` and `accepted_for_bidding`
 * (routed, not yet working) are pending. `held` is an order Alpaca keeps back until something happens: a stop or stop-limit waiting for its
 * stop price is working — open, and the account says it waits for its price — while any other held order is a leg waiting on another (the
 * account places none), so pending. `stopped` is not a stop that triggered: it is Alpaca's rare "a trade is guaranteed, but has not
 * happened yet", and the order is still working. `calculated` is a day's end with settlement still to come. */
const WAITING = new Set(["accepted", "pending_new", "accepted_for_bidding"]);
/** the order types that wait for a stop price before they act */
const STOPS = new Set(["stop", "stop_limit", "trailing_stop"]);
function statusOf(s: string, filled: number, qty: number, type = ""): OrderStatus {
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
  if (WAITING.has(s) || (s === "held" && !STOPS.has(type))) return filled > 0 ? "partial" : "pending";
  // new, a held stop, pending_cancel, pending_replace, stopped, suspended, done_for_day, and anything Alpaca adds: still working, still watched
  return filled > 0 ? "partial" : "open";
}
/** "Order cannot be replaced when the status is accepted, pending_new, pending_cancel or pending_replace" (PATCH /v2/orders/{order_id}) */
const UNREPLACEABLE = new Set(["accepted", "pending_new", "pending_cancel", "pending_replace"]);

const ORDER_FIELDS = ["id", "client_order_id", "symbol", "asset_class", "side", "type", "time_in_force", "qty", "notional", "limit_price", "stop_price", "filled_qty", "filled_avg_price", "status", "extended_hours", "created_at", "submitted_at", "updated_at", "filled_at", "canceled_at", "expired_at", "failed_at", "expires_at", "replaced_by", "replaces"] as const;
/** a position as Alpaca shows it (GET /v2/positions); `usd` is a local-currency account's dollar values */
const POSITION_FIELDS = ["asset_id", "symbol", "exchange", "asset_class", "side", "qty", "qty_available", "avg_entry_price", "current_price", "lastday_price", "market_value", "cost_basis", "unrealized_pl", "unrealized_plpc", "unrealized_intraday_pl", "change_today", "usd"] as const;
/** the parts of an Alpaca refusal worth keeping: insufficient buying power adds buying_power and cost_basis, insufficient qty adds available,
 * existing_qty and held_for_orders, a wash-trade guard adds reject_reason */
const REFUSAL_FIELDS = ["buying_power", "cost_basis", "available", "existing_qty", "held_for_orders", "symbol", "reject_reason"] as const;

const INSUFFICIENT = /insufficient (buying power|qty|quantity|balance|funds)|not enough (buying power|funds|cash|shares)/i;
const PDT = /pattern day trad/i;
const CLOSED = /market (is )?closed|only allowed during market hours|outside (of )?(regular |market |trading )*hours|\b(asset|symbol|security|contract)\b.{0,40}\bnot (tradable|active)\b|halted/i;
const SIZE_403 = /not fractionable|cannot be sold short/i;

/** the calendar day in New York of a moment, as 2026-10-05: a stock's session is a New York day */
const nyDay = (ms: number): string => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
/** "2026-10-06T09:30:00-04:00" as "2026-10-06 09:30": Alpaca's clock speaks New York time */
const nyTime = (s: unknown): string => (typeof s === "string" && s.length >= 16 ? `${s.slice(0, 10)} ${s.slice(11, 16)}` : "");
/** "2026-10-06T09:30:00-04:00" as the instant it is, ISO 8601 in UTC ("2026-10-06T13:30:00.000Z"); undefined for what is not a time */
const isoOf = (s: unknown): string | undefined => {
  const ms = typeof s === "string" ? Date.parse(s) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
};
/** the US stock market's session as Alpaca's clock gives it (GET /v2/clock: is_open, next_open, next_close); a clock that did not answer, or
 * answered without saying whether the market is open, gives none — the session is then unknown, and nothing is said of it */
function sessionOf(clock: unknown): MarketSession | undefined {
  if (!isObj(clock) || isRefusal(clock) || typeof clock.is_open !== "boolean") return undefined;
  const opensAt = isoOf(clock.next_open);
  const closesAt = isoOf(clock.next_close);
  return { open: clock.is_open, ...(opensAt ? { opensAt } : {}), ...(closesAt ? { closesAt } : {}) };
}

function alpacaTrader(c: { venue: string; name: string; base: string; keyId: string; secret: string; http: Http; clock: () => number }): LiveTrader {
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
        // an IPO-flagged stock takes limit orders only until it first trades; any other takes all four (a stop goes as a stop-limit at its
        // worst price, see place)
        types: attrs.includes("ipo") ? ["limit"] : ["market", "limit", "stop", "stop_limit"],
        // Alpaca's table of order types against times in force: day and gtc for every type. Its ioc and fok are starred "please contact the
        // sales team", so they are not offered to an individual key. A fraction of a share is day only: place holds an order to that
        tifs: ["day", "gtc"],
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
        // Alpaca's crypto takes market, limit and stop_limit orders, and no plain stop: a stop goes as a stop-limit at its worst price, so the
        // account's stop is taken here too
        types: ["market", "limit", "stop", "stop_limit"],
        // gtc and ioc, never day or fok; and ioc only for a market or limit order (its crypto table), which place holds a stop to
        tifs: ["gtc", "ioc"],
        tifsByType: { stop: ["gtc"], stop_limit: ["gtc"] },
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
      // and the agent's limit, which allow 2%). So until the clock says the market is open, no market order is offered. A limit, a
      // stop-limit and a stop (sent as a stop-limit at its worst price) each carry a limit, and wait for the open with it.
      const isOpen = isObj(clock) && !isRefusal(clock) && clock.is_open === true;
      if (!isOpen) types = types.filter((t) => t !== "market");
      if (isObj(clock) && clock.is_open === false) note = `the US stock market is closed: ${c.name} holds an order and sends it when the market opens${nyTime(clock.next_open) ? ` (${nyTime(clock.next_open)} New York time)` : ""}. Until then no market order is placed here: it would fill at the opening price, which can be well away from this one. A limit, stop or stop-limit order waits for the open with its limit`;
      else if (isRefusal(clock)) note = `${c.name}'s market clock did not answer, so no market order is placed here: outside market hours ${c.name} holds an order until the market opens, and a market order would fill at the opening price`;
      if (price === undefined && isRefusal(quote)) note = `${note ? `${note} · ` : ""}${c.name}'s market data did not answer: ${quote.message}`;
    }
    // the session, by Alpaca's own clock: in session now, and when it next opens and closes. At night a stock is open (Alpaca takes an order
    // and holds it for the open) and out of its session. No clock answer: unknown, and no session is said
    const session = sessionOf(clock);
    return { ...m, price, bid, ask, priceStep, note, types, ...(session ? { session } : {}) };
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
    return { ref: String(o.id), status: statusOf(String(o.status ?? ""), filled, num(o.qty), String(o.type ?? o.order_type ?? "")), filledQty: filled, ...(avg !== undefined ? { avgPrice: avg } : {}), native: Object.fromEntries(ORDER_FIELDS.filter((k) => o[k] !== undefined).map((k) => [k, o[k]])) };
  };
  /** the order as it stands: one Alpaca replaced (a change made here or at Alpaca, a corporate action) goes on under a new id, followed a
   * few hops at most. One still `replaced` after that counts as working, so it is asked again rather than taken for done */
  const live = async (ref: string): Promise<Json> => {
    let o = await order(ref);
    for (let hop = 0; o.status === "replaced" && typeof o.replaced_by === "string" && o.replaced_by && hop < 3; hop++) o = await order(o.replaced_by);
    // "If the existing open order is filled before the replacing (new) order reaches the execution venue, the replacing (new) order is
    // rejected" (PATCH /v2/orders/{order_id}). A rejected replacement whose order filled on its own is that fill, not a rejection
    if (o.status === "rejected" && typeof o.replaces === "string" && o.replaces) {
      const before = await order(o.replaces).catch(() => undefined);
      if (before && before.status !== "replaced" && num(before.filled_qty) > 0) return before;
    }
    return o;
  };
  const read = async (ref: string): Promise<OrderState> => stateOf(await live(ref));

  /** What Alpaca holds under the account's id (GET /v2/orders:by_client_order_id): THIS order — the same market, side, size, type and prices
   * as the one sent (a market order was sent as a limit at its worst price, a stop as a stop-limit, and each is matched as that), made
   * minutes ago — or none, or another order made earlier under the same id, or no answer */
  type Held = { is: "this"; state: OrderState } | { is: "none" } | { is: "other"; no: Refusal } | { is: "unknown"; no: Refusal };
  /** what went to Alpaca: always a limit or a stop-limit, with its limit and, for a stop-limit, its stop */
  type Sent = Pick<OrderRequest, "symbol" | "side" | "qty" | "stopPrice"> & { type: "limit" | "stop_limit"; limitPrice: number };
  /** what a lost answer leaves unknown: an order placed, or an order changed */
  type Act = "placed" | "changed";
  const held = async (cid: string, o: Sent, act: Act = "placed"): Promise<Held> => {
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
    const same = String(x.symbol ?? "").replace("/", "") === o.symbol.replace("/", "") && x.side === o.side && (x.type ?? x.order_type) === o.type && Math.abs(num(x.qty) - o.qty) < 1e-9 && Math.abs(num(x.limit_price) - o.limitPrice) < 1e-9 && (o.stopPrice === undefined || Math.abs(num(x.stop_price) - o.stopPrice) < 1e-9) && Number.isFinite(made) && Math.abs(Date.now() - made) < RETRY_MS;
    if (same) return { is: "this", state: stateOf(x) };
    return { is: "other", no: no("E_VENUE_REJECTED", { venue: c.venue, message: `${c.name} already holds an earlier, different order under the account's id ${cid}: ${act === "placed" ? "nothing new was placed" : "nothing was changed"}`, detail: { clientOrderId: cid, theirs: x.id }, native: { status: x.status ?? null, symbol: x.symbol ?? null, created_at: x.created_at ?? null } }) };
  };

  /** a position as the account names it: a stock by its ticker; a coin, which Alpaca names by the coin and USD ("BTCUSD is an asset symbol
   * and BTC/USD is a tradable pair": its coin-pair FAQ), by the dollar pair it trades as. Options and anything else are not traded here */
  const positionOf = (p: Json): Position | undefined => {
    const cls = String(p.asset_class ?? "");
    if (cls !== "us_equity" && cls !== "crypto") return undefined;
    const raw = String(p.symbol ?? "").toUpperCase();
    const coin = /^([A-Z0-9]+)USD$/.exec(raw);
    const symbol = cls === "crypto" && coin ? `${coin[1]}/USD` : raw;
    const q = num(p.qty);
    // a local-currency account gives its dollar values under `usd`; anyone else's are dollars already. A value Alpaca did not give stays out
    const dollars = isObj(p.usd) ? p.usd : p;
    const usd = (k: string): number | undefined => (dollars[k] === undefined || dollars[k] === null ? undefined : num(dollars[k]));
    return {
      symbol,
      name: listed?.all.find((m) => m.symbol === symbol)?.name ?? symbol,
      kind: cls === "crypto" ? "crypto" : "stock",
      // a short position's qty is negative at Alpaca, and its side says so
      side: p.side === "short" || q < 0 ? "short" : "long",
      qty: Math.abs(q),
      entryPrice: positive(dollars.avg_entry_price),
      markPrice: positive(dollars.current_price),
      usd: usd("market_value"),
      unrealizedUsd: usd("unrealized_pl"),
      native: Object.fromEntries(POSITION_FIELDS.filter((k) => p[k] !== undefined).map((k) => [k, p[k]])),
    };
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
        const priced = (x: number | undefined): boolean => x !== undefined && Number.isFinite(x) && x > 0;
        const named = o.type === "stop_limit" ? "stop-limit" : o.type;
        const stopped = o.type === "stop" || o.type === "stop_limit";
        // held to a worst price: a market order, and a stop, which is a market order once its stop price is reached
        const bounded = o.type === "market" || o.type === "stop";
        if (!(Number.isFinite(o.qty) && o.qty > 0)) return badOrder(c.venue, c.name, "a size is more than zero");
        if (!bounded && !priced(o.limitPrice)) return badOrder(c.venue, c.name, `a ${named} order has a limit price`);
        if (bounded && o.limitPrice !== undefined) return badOrder(c.venue, c.name, `a ${named} order has no limit price`);
        if (stopped && !priced(o.stopPrice)) return badOrder(c.venue, c.name, `a ${named} order has a stop price that triggers it`);
        if (!stopped && o.stopPrice !== undefined) return badOrder(c.venue, c.name, `a ${named} order has no stop price`);
        // a market order — or a stop, once triggered — is never sent without the worst price it may fill at: Alpaca is given a limit there,
        // never an open market order
        if (bounded && !priced(o.worstPrice)) return badOrder(c.venue, c.name, `a ${named} order carries the worst price it may fill at`);
        // flags Alpaca has no word for are refused, never dropped: an order sent without the reduce-only it asked for could open a position
        if (o.postOnly) return badOrder(c.venue, c.name, "no post-only order is taken here");
        if (o.reduceOnly) return badOrder(c.venue, c.name, "no reduce-only order is taken here: an order can open or grow a position");
        const pair = PAIR.exec(o.symbol);
        if (pair && !inDollars(pair[2]!)) return no("E_ACCOUNT_UNPRICED", { venue: c.venue, message: `${o.symbol} is priced in ${pair[2]}: the account trades markets priced in dollars, so that every limit means dollars` });
        const fraction = !pair && !isWhole(o.qty);
        const cid = idOf(o.clientId);
        // numbers go as decimal strings, nine places at most, as the OpenAPI types them; never notional — the account sends a size. A size
        // or price finer than nine places is refused, not rounded: rounding could send an order bigger or pricier than the one valued
        if (!nine(o.qty)) return badOrder(c.venue, c.name, "a size has at most nine decimal places");
        if (o.limitPrice !== undefined && !nine(o.limitPrice)) return badOrder(c.venue, c.name, "a limit price has at most nine decimal places");
        if (o.stopPrice !== undefined && !nine(o.stopPrice)) return badOrder(c.venue, c.name, "a stop price has at most nine decimal places");
        // Time in force, by Alpaca's tables of order types against times in force (docs: orders-at-alpaca, "Order Types vs Supported Time in
        // Force"). A pair: gtc for market, limit and stop-limit, ioc for market and limit only, never day or fok. A stock: day and gtc for every
        // type (its ioc and fok are starred "contact the sales team", and not offered); a fraction of a share day only.
        // Left to the venue: a pair's market order is ioc — what does not fill at once at the worst price or better is canceled, as a market
        // order's rest would be — and anything else of a pair's gtc. A stock market order is day: a day limit at the worst price fills at once
        // at that price or better, and what it cannot fill waits on the book for that price and lapses at the close. A whole-share limit, stop
        // or stop-limit is gtc, as a resting order is on an exchange; Alpaca cancels a gtc order by itself 90 days on. A fraction is day.
        // extended_hours is never set: a stock market order is offered only while the clock says the regular session is open. Older pages said
        // a fraction goes only as a market order; the newer table takes day limits, stops and stop-limits too: they are sent, and Alpaca's own
        // refusal is the answer if it says otherwise.
        const tif: TimeInForce = o.tif ?? (pair ? (o.type === "market" ? "ioc" : "gtc") : fraction || o.type === "market" ? "day" : "gtc");
        if (pair && tif !== "gtc" && tif !== "ioc") return badOrder(c.venue, c.name, `a crypto order is gtc or ioc, not ${tif}`);
        if (pair && stopped && tif !== "gtc") return badOrder(c.venue, c.name, `a crypto ${named} order is gtc only, not ${tif}`);
        if (!pair && tif !== "day" && tif !== "gtc") return badOrder(c.venue, c.name, `a stock order is day or gtc here, not ${tif} (which its sales team turns on for an account)`);
        if (fraction && tif !== "day") return badOrder(c.venue, c.name, `a fraction of a share is a day order, not ${tif}`);
        // A MARKET order goes as a limit order at its worst price, and a STOP as a stop-limit whose limit is its worst price, so that either
        // fills there or better, or not at all. The price is put onto the market's grid on the safe side — a buy down, a sell up, never past
        // the worst price: a stock by the sub-penny rule (a cent from $1, a hundredth of a cent under it, by the price sent), a pair by its
        // price_increment (read with the market; asked for here if not). A stop price goes as given, like a limit price: Alpaca holds it to the
        // same sub-penny rule, and refuses one off it in its own words.
        let limit = o.limitPrice;
        if (bounded) {
          const worst = o.worstPrice!;
          const step = pair ? ((await stepOf(o.symbol)) ?? 1e-9) : tickOf(worst);
          limit = o.side === "buy" ? floorTo(worst, step) : ceilTo(worst, step);
          if (!(limit > 0)) return badOrder(c.venue, c.name, `the worst price ${plain(worst)} is under the smallest price step of ${o.symbol} (${plain(step)})`);
          if (!nine(limit)) return badOrder(c.venue, c.name, "a worst price has at most nine decimal places");
          // a stop's worst price lies beyond its trigger — at or over it for a buy, at or under it for a sell — or the limit order it turns
          // into could not fill at the price that triggered it
          if (o.type === "stop" && (o.side === "buy" ? limit < o.stopPrice! : limit > o.stopPrice!)) return badOrder(c.venue, c.name, `a ${o.side} stop's worst price (${plain(limit)}) is ${o.side === "buy" ? "under" : "over"} its stop price (${plain(o.stopPrice!)}): the order it triggers could not fill`);
        }
        const kind = stopped ? "stop_limit" : "limit";
        const sent: Sent = { symbol: o.symbol, side: o.side, type: kind, qty: o.qty, limitPrice: limit!, ...(stopped ? { stopPrice: o.stopPrice! } : {}) };
        const body: Record<string, string> = { symbol: o.symbol, qty: plain(o.qty, 9), side: o.side, type: kind, limit_price: plain(limit!, 9), ...(stopped ? { stop_price: plain(o.stopPrice!, 9) } : {}), time_in_force: tif, client_order_id: cid };
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

    // PATCH /v2/orders/{order_id}, Alpaca's replace: "Each parameter overrides the corresponding attribute of the existing order. The other
    // attributes remain the same", and the answer is "The new Order object with the new order ID"
    async amend(ref, _symbol, change, placed) {
      try {
        const words = { qty: "size", limitPrice: "limit price", stopPrice: "stop price" } as const;
        const asked = (["qty", "limitPrice", "stopPrice"] as const).filter((k) => change[k] !== undefined);
        if (!asked.length) return badOrder(c.venue, c.name, "an order is changed by a new size, limit price or stop price: none was given");
        for (const k of asked) {
          const x = change[k]!;
          if (!(Number.isFinite(x) && x > 0)) return badOrder(c.venue, c.name, `a new ${words[k]} is more than zero`);
          if (!nine(x)) return badOrder(c.venue, c.name, `a new ${words[k]} has at most nine decimal places`);
        }
        // Alpaca holds a market order as a limit at its worst price, and a stop as a stop-limit at its worst price. That worst price is the
        // bound the account approved, so neither takes a new limit here; and only a stop or a stop-limit has a stop to move
        if (change.limitPrice !== undefined && (placed.type === "market" || placed.type === "stop")) return badOrder(c.venue, c.name, `a ${placed.type} order has no limit price to change: it is held to its worst price, which stays`);
        if (change.stopPrice !== undefined && (placed.type === "market" || placed.type === "limit")) return badOrder(c.venue, c.name, `a ${placed.type} order has no stop price`);
        // the order as Alpaca holds it now, followed to the order that replaced it if it was replaced (a change whose answer was lost, or one
        // made at Alpaca): a replace carries the prices Alpaca holds, not the ones the account remembers
        const now = await live(ref);
        const id = String(now.id);
        const kind = placed.type === "stop" || placed.type === "stop_limit" ? "stop_limit" : "limit";
        const theirs = String(now.type ?? now.order_type ?? "");
        // the order under this id is the one the account placed: the same market and side, held as what it was sent as
        if (String(now.symbol ?? "").replace("/", "") !== placed.symbol.replace("/", "") || now.side !== placed.side || theirs !== kind) return no("E_VENUE_REJECTED", { venue: c.venue, message: `${c.name}'s order ${id} is not the order the account placed (a ${placed.side} of ${placed.symbol}, sent as a ${kind.replace("_", "-")}): nothing was changed`, detail: { order: id }, native: { symbol: now.symbol ?? null, side: now.side ?? null, type: theirs || null } });
        const state = stateOf(now);
        // the prices a replace carries whether they change or not (the SDK: a limit order's limit price, a stop-limit's limit and stop prices)
        const limit = change.limitPrice ?? positive(now.limit_price);
        const stop = kind === "stop_limit" ? (change.stopPrice ?? positive(now.stop_price)) : undefined;
        if (limit === undefined || (kind === "stop_limit" && stop === undefined)) return no("E_VENUE_REJECTED", { venue: c.venue, message: `${c.name}'s order ${id} came back without its prices: nothing was changed`, native: state.native });
        const qty = change.qty ?? num(now.qty);
        // already as asked — a change whose answer was lost, asked for again: the order as it stands, and nothing is sent
        if (Math.abs(qty - num(now.qty)) < 1e-9 && Math.abs(limit - num(now.limit_price)) < 1e-9 && (stop === undefined || Math.abs(stop - num(now.stop_price)) < 1e-9)) return state;
        const at = String(now.status ?? "");
        if (DONE.has(state.status)) return no("E_VENUE_REJECTED", { venue: c.venue, message: `${c.name}'s order ${id} is ${state.status}: there is nothing left to change`, detail: { order: id, status: state.status }, native: state.native });
        if (UNREPLACEABLE.has(at)) return no("E_VENUE_REJECTED", { venue: c.venue, message: `${c.name} does not change an order while it is ${at.replace(/_/g, " ")}${at === "accepted" ? " (taken, and held until the market opens)" : ""}: nothing was changed, and it can be once the order is working`, detail: { order: id, status: at }, native: state.native });
        // A part-filled order is not changed here. Alpaca's replace makes a new order for the size given, and its own staff say the replace
        // "doesn't handle partial fills very well" (Alpaca's forum, 2021; alpacahq/Alpaca-API#165 is still open): the new order could buy or
        // sell again what already filled, or lose sight of it
        if (state.filledQty > 0) return no("E_VENUE_REJECTED", { venue: c.venue, message: `${c.name}'s order ${id} has filled ${plain(state.filledQty)} of ${plain(num(now.qty))}, and ${c.name}'s replace does not carry a part-filled order over cleanly, so it is not changed here: cancel it, and place what is left as a new order`, detail: { order: id, filledQty: state.filledQty }, native: state.native });
        // "You can only patch full shares for now. Qty of equity fractional orders are not allowed to change" (ibid.; the official SDK types
        // the new qty as a whole number). A coin's new size is sent as it is, and Alpaca's own refusal is the answer if it says otherwise
        const coin = now.asset_class === "crypto" || (now.asset_class === undefined && PAIR.test(placed.symbol));
        if (change.qty !== undefined && !coin && !isWhole(change.qty)) return badOrder(c.venue, c.name, "a stock order's size changes in whole shares only: cancel it and place the new size as a new order");
        if (change.qty !== undefined && !coin && !isWhole(num(now.qty))) return badOrder(c.venue, c.name, "an order for a fraction of a share keeps its size: cancel it and place the new size as a new order");
        // a stop's worst price stays where the account bounded it: a stop moved past it would trigger an order that could not fill there
        if (placed.type === "stop" && change.stopPrice !== undefined && (placed.side === "buy" ? limit < change.stopPrice : limit > change.stopPrice)) return badOrder(c.venue, c.name, `a ${placed.side} stop at ${plain(change.stopPrice)} would be past its worst price, ${plain(limit)}, and the order it triggers could not fill: cancel it and place a new stop order`);
        // The new order's id: the account's own, marked as the replacement of this order. An order is replaced once at most, so no other
        // order can carry it, and after a lost answer the new order can be asked for by it
        const cid = `${idOf(placed.clientId, 89)}-r-${idOf(id, 36)}`;
        const sent: Sent = { symbol: placed.symbol, side: placed.side, type: kind, qty, limitPrice: limit, ...(stop !== undefined ? { stopPrice: stop } : {}) };
        // what changes, the prices a replace carries, and the time in force as it stands; the rest stays as Alpaca holds it
        const body: Record<string, string> = { ...(change.qty !== undefined ? { qty: plain(change.qty, 9) } : {}), limit_price: plain(limit, 9), ...(stop !== undefined ? { stop_price: plain(stop, 9) } : {}), ...(typeof now.time_in_force === "string" ? { time_in_force: now.time_in_force } : {}), client_order_id: cid };
        let r: HttpReply;
        try {
          r = await call(`${c.base}/v2/orders/${encodeURIComponent(id)}`, "PATCH", body);
        } catch (err) {
          return await silent(cid, sent, asRefusal(c.venue, c.name, err, secrets), "changed");
        }
        // "A success return code from a replaced order does NOT guarantee the existing open order has been replaced": should the old order
        // fill first, the new one is rejected — and the status read from here says so (see live)
        if (r.status === 200 || r.status === 201) {
          if (!isObj(r.body) || typeof r.body.id !== "string") return await silent(cid, sent, no("E_VENUE_REJECTED", { venue: c.venue, message: `${c.name} took the change but its answer could not be read`, native: { status: r.status, said: redact(r.text, secrets).slice(0, 200) } }), "changed");
          return stateOf(r.body);
        }
        if (r.status >= 500) return await silent(cid, sent, refusal(r), "changed");
        return refusal(r, id);
      } catch (err) {
        return asRefusal(c.venue, c.name, err, secrets);
      }
    },

    async positions() {
      try {
        const all = await getJson(`${c.base}/v2/positions`);
        if (!Array.isArray(all)) return no("E_VENUE_REJECTED", { venue: c.venue, message: `${c.name}'s positions came back in a shape this connection could not read` });
        return all.filter(isObj).map(positionOf).filter((p): p is Position => p !== undefined);
      } catch (err) {
        return asRefusal(c.venue, c.name, err, secrets);
      }
    },

    // DELETE /v2/positions/{symbol_or_asset_id}?qty=: "the number of shares to liquidate. Can accept up to 9 decimal points". It takes no id
    // of the account's (its only other parameter is a percentage), so the account's id is not sent, and a lost answer cannot be asked for by it
    async close(raw, qty) {
      try {
        if (!(Number.isFinite(qty) && qty > 0)) return badOrder(c.venue, c.name, "a size to close is more than zero");
        if (!nine(qty)) return badOrder(c.venue, c.name, "a size has at most nine decimal places");
        const symbol = raw.trim().toUpperCase();
        const pair = PAIR.exec(symbol);
        if (!pair && !STOCK.test(symbol)) return no("E_VENUE_REJECTED", { venue: c.venue, message: `${c.name} holds no position "${raw.trim()}": a stock is its ticker (AAPL), a coin its pair (BTC/USD)` });
        // a coin held is one position whatever pair bought it, named by the coin and USD (BTCUSD); a stock by its ticker
        const asset = pair ? `${pair[1]}USD` : symbol;
        // Alpaca closes a position with a MARKET order of its own — its Close All Positions examples show "type": "market", a day order for a
        // stock — and no price can bound it. Outside the regular session a stock's market order waits for the open and fills at the opening
        // price, so a stock position is closed here only while the clock says the market is open: the same rule as a market order. A coin
        // trades around the clock, and Alpaca puts "an automatic 2% price collar on all crypto market orders" itself: a limit 2% past the last
        // ask (a buy) or bid (a sell), its support pages say
        if (!pair) {
          const clock = await soft(`${c.base}/v2/clock`);
          if (isRefusal(clock)) return no("E_VENUE_MARKET_CLOSED", { venue: c.venue, message: `${c.name}'s market clock did not answer, so ${symbol} is not closed now: ${c.name} closes a position with a market order, and outside market hours that order would wait for the open and fill at the opening price`, native: clock.native });
          if (!(isObj(clock) && clock.is_open === true)) return no("E_VENUE_MARKET_CLOSED", { venue: c.venue, message: `the US stock market is closed: ${c.name} closes a position with a market order, which would wait for the open${isObj(clock) && nyTime(clock.next_open) ? ` (${nyTime(clock.next_open)} New York time)` : ""} and fill at the opening price. Close it once the market is open, or sell it with a limit order now` });
        }
        const lost = (why: Refusal): Refusal => ({ ...why, message: `${why.message}: the closing order may have been taken all the same. Look at ${c.name}'s orders for ${symbol} before closing it again`, detail: { symbol, placed: "unknown" } });
        let r: HttpReply;
        try {
          r = await call(`${c.base}/v2/positions/${encodeURIComponent(asset)}?qty=${plain(qty, 9)}`, "DELETE");
        } catch (err) {
          return lost(asRefusal(c.venue, c.name, err, secrets));
        }
        if (r.status === 200 || r.status === 201) {
          if (isObj(r.body) && typeof r.body.id === "string") return stateOf(r.body);
          return lost(no("E_VENUE_REJECTED", { venue: c.venue, message: `${c.name} took the close but its answer could not be read`, native: { status: r.status, said: redact(r.text, secrets).slice(0, 200) } }));
        }
        if (r.status >= 500) return lost(refusal(r));
        if (r.status === 404) return no("E_VENUE_REJECTED", { venue: c.venue, message: `${c.name} holds no ${symbol} position for this key`, native: refusal(r).native });
        return refusal(r);
      } catch (err) {
        return asRefusal(c.venue, c.name, err, secrets);
      }
    },
    // no setLeverage: Alpaca sets no leverage per position (an account's margin is the account's)

    // The latest of many markets at once, from the Market Data API's snapshots: GET /v2/stocks/snapshots?symbols= (keyed by symbol), on the
    // feed this key may use as for a quote (Alpaca's default: all exchanges with its subscription, IEX without one), and GET
    // /v1beta3/crypto/us/snapshots?symbols= (under `snapshots`) for dollar pairs, at most a hundred markets. A price is the latest trade.
    // A stock's day is its latest session's bar (dailyBar) against the session before (prevDailyBar), the change a broker shows for a stock,
    // which trades in sessions and not around the clock; its high and low are that session's — said only while that session is today's in
    // New York: on a weekend, or the next morning, the last session's move is not what the last 24 hours did, and none is said. No volume is said for a stock: without a
    // subscription the feed is IEX's alone, a few percent of the market, and the answer does not say which feed it is. A coin's bars are
    // calendar days, so its daily bar is the day so far and not the last 24 hours: of a coin, only its price. No symbols: the well-known ones
    async stats(symbols) {
      try {
        const asked = [...new Set((symbols ?? KNOWN).map((s) => s.trim().toUpperCase()).filter(Boolean))];
        if (asked.length > STATS_MAX) return no("E_VENUE_REJECTED", { venue: c.venue, message: `${c.name}: at most ${STATS_MAX} markets are read at once, not ${asked.length}`, detail: { max: STATS_MAX } });
        const stocks = asked.filter((s) => !PAIR.test(s) && STOCK.test(s));
        const coins = asked.filter((s) => inDollars(PAIR.exec(s)?.[2] ?? ""));
        const [st, co] = await Promise.all([stocks.length ? soft(`${DATA}/v2/stocks/snapshots?symbols=${stocks.join(",")}`) : undefined, coins.length ? soft(`${DATA}/v1beta3/crypto/us/snapshots?symbols=${coins.join(",")}`) : undefined]);
        const out = new Map<string, MarketStats>();
        if (isObj(st) && !isRefusal(st)) {
          for (const s of stocks) {
            const day = isObj(st[s]) ? stockDay(st[s] as Json) : undefined;
            if (day) out.set(s, day);
          }
        }
        const snaps = isObj(co) && !isRefusal(co) && isObj(co.snapshots) ? co.snapshots : undefined;
        for (const s of coins) {
          const x = snaps?.[s];
          const price = isObj(x) && isObj(x.latestTrade) ? positive(x.latestTrade.p) : undefined;
          if (price !== undefined) out.set(s, { price });
        }
        const refused = [st, co].find((x): x is Refusal => isRefusal(x));
        return !out.size && refused ? refused : out;
      } catch (err) {
        return asRefusal(c.venue, c.name, err, secrets);
      }
    },

    // Price history from the bars endpoints: GET /v2/stocks/bars (Alpaca's default feed for bars: all exchanges, 15 minutes behind without a
    // subscription, so no end is sent) and GET /v1beta3/crypto/us/bars, one symbol, 5Min, 1Hour or 1Day bars from `sinceMs`, the latest 300
    // (sort desc), given back oldest first. A bar's volume is in shares or coins
    async candles(raw, interval, sinceMs) {
      try {
        if (!CANDLE_INTERVALS.includes(interval)) return no("E_VENUE_REJECTED", { venue: c.venue, message: `${c.name}: price history comes in bars of ${CANDLE_INTERVALS.join(", ")}, not ${String(interval)}` });
        if (!(Number.isFinite(sinceMs) && sinceMs >= 0)) return no("E_VENUE_REJECTED", { venue: c.venue, message: `${c.name}: a price history starts at a time, in milliseconds` });
        const symbol = raw.trim().toUpperCase();
        const pair = PAIR.exec(symbol);
        if (pair && !inDollars(pair[2]!)) return no("E_ACCOUNT_UNPRICED", { venue: c.venue, message: `${symbol} is priced in ${pair[2]}: the account trades markets priced in dollars, so that every limit means dollars` });
        if (!pair && !STOCK.test(symbol)) return no("E_VENUE_REJECTED", { venue: c.venue, message: `${c.name} lists no market "${raw.trim()}": a stock is its ticker (AAPL), a coin a pair (BTC/USD)` });
        // RFC-3339, to the second
        const start = new Date(Math.floor(sinceMs)).toISOString().replace(/\.\d{3}Z$/, "Z");
        const query = `symbols=${symbol}&timeframe=${TIMEFRAME[interval]}&start=${encodeURIComponent(start)}&limit=${BARS}&sort=desc`;
        const body = await getJson(pair ? `${DATA}/v1beta3/crypto/us/bars?${query}` : `${DATA}/v2/stocks/bars?${query}`);
        const rows = isObj(body) && isObj(body.bars) && Array.isArray(body.bars[symbol]) ? (body.bars[symbol] as unknown[]) : [];
        const bars = new Map<number, Candle>();
        for (const b of rows) {
          if (!isObj(b)) continue;
          const t = Date.parse(String(b.t ?? ""));
          const [o, h, l, cl] = [positive(b.o), positive(b.h), positive(b.l), positive(b.c)];
          if (!Number.isFinite(t) || o === undefined || h === undefined || l === undefined || cl === undefined) continue;
          const v = typeof b.v === "number" && Number.isFinite(b.v) && b.v >= 0 ? b.v : undefined;
          bars.set(t, { t, o, h, l, c: cl, ...(v !== undefined ? { v } : {}) });
        }
        return [...bars.values()].sort((x, y) => x.t - y.t);
      } catch (err) {
        return asRefusal(c.venue, c.name, err, secrets);
      }
    },
  };

  /** a stock's latest session from its snapshot: the latest trade, and the session's bar against the one before it. A change (and the
   * session's high and low) is said only when both bars are there, the latest is the later one, and it is TODAY's session in New York — a
   * daily bar starts at midnight there (dailyBar.t 04:00Z or 05:00Z) — so that Friday's move is not shown as the last 24 hours' all weekend */
  function stockDay(x: Json): MarketStats | undefined {
    const day = isObj(x.dailyBar) ? x.dailyBar : undefined;
    const before = isObj(x.prevDailyBar) ? x.prevDailyBar : undefined;
    const price = (isObj(x.latestTrade) ? positive(x.latestTrade.p) : undefined) ?? positive(day?.c);
    const close = positive(day?.c);
    const prev = positive(before?.c);
    const dayAt = Date.parse(String(day?.t ?? ""));
    const later = dayAt > Date.parse(String(before?.t ?? ""));
    const today = Number.isFinite(dayAt) && nyDay(dayAt) === nyDay(c.clock());
    const change = close !== undefined && prev !== undefined && later && today ? close - prev : undefined;
    const high = today ? positive(day?.h) : undefined;
    const low = today ? positive(day?.l) : undefined;
    if (price === undefined && change === undefined) return undefined;
    return { ...(price !== undefined ? { price } : {}), ...(change !== undefined ? { change24h: Number(change.toFixed(10)), changePct24h: Number(((change / prev!) * 100).toFixed(10)) } : {}), ...(high !== undefined ? { high24h: high } : {}), ...(low !== undefined ? { low24h: low } : {}) };
  }

  /** Alpaca did not answer an order, or a change to one: its docs say not to send it again until it is known. Asked by the account's id, it
   * is either there (and returned as placed), not there, or still unknown — never sent twice from here */
  async function silent(cid: string, o: Sent, why: Refusal, act: Act = "placed"): Promise<OrderState | Refusal> {
    const h = await held(cid, o, act);
    if (h.is === "this") return h.state;
    // another order already had this id, so Alpaca would have refused this one as a duplicate
    if (h.is === "other") return h.no;
    if (h.is === "none") return { ...why, message: `${why.message}, and a moment later it held no order under the account's id ${cid}: nothing was ${act}`, detail: { clientOrderId: cid, [act]: false } };
    return { ...why, message: `${why.message}: the ${act === "placed" ? "order" : "change"} may have been taken all the same. Look at ${c.name}'s orders for ${cid} before ${act === "placed" ? "placing" : "changing"} it again`, detail: { clientOrderId: cid, [act]: "unknown" } };
  }
}
