/** Robinhood, through the interfaces Robinhood itself publishes (docs.robinhood.com and Robinhood's support pages, read 2026-10-05).
 *
 *   Robinhood stocks   agent.robinhood.com/mcp/trading — Robinhood's own MCP server, behind Robinhood's own sign-in (signin.ts). It gives
 *                      an agent read access to every Robinhood account and lets it trade only in a separate Agentic account. Reading calls
 *                      three of its tools — get_accounts, get_portfolio, get_equity_positions — and never review_equity_order,
 *                      place_equity_order or cancel_equity_order. An order the account places (the owner signed it, or an agent asked inside
 *                      its limit: market, limit, stop or stop-limit) calls get_equity_quotes, get_equity_tradability, place_equity_order,
 *                      get_equity_orders and cancel_equity_order, in the Agentic account and no other; what that account holds is read with
 *                      get_equity_positions and priced with get_equity_quotes.
 *   Robinhood Crypto   trading.robinhood.com/api/v2/crypto/ — an API key and an Ed25519 signature over api key + timestamp (seconds) + path
 *                      (with its query) + method + body, made with the private key the user created, whose public half Robinhood holds.
 *                      It reads accounts, holdings and the best bid and ask, and places (market, limit, stop and stop-limit), follows and
 *                      cancels orders (v2: the fee-tier orders).
 *   Stock Tokens       api.robinhood.com/rhj/assets and /rhj/prices/{symbol} — no key: each token's contract on Robinhood Chain (4663),
 *                      and its bid in dollars per token. A wallet's tokens are read from the chain (address.ts).
 *
 * None of the three moves money in or out: Robinhood's deposits and withdrawals are made in Robinhood's own app. An order moves money
 * between what the user holds at Robinhood: dollars into BTC, shares into dollars.
 */
import { createHash, createPrivateKey, sign as cryptoSign, type KeyObject } from "node:crypto";
import { getAddress, isAddress, type Hex } from "viem";
import { isRefusal, type Refusal } from "../../core/errors.ts";
import { no } from "../refuse.ts";
import { CHAIN_BY_ID, type ChainName, type ChainReader, type TokenRef } from "./chain.ts";
import type { KeyFile, KeyShape } from "./credentials.ts";
import { badOrder, ceilTo, floorTo, inDollars, onStep, ORDER_TYPES, pick as pickMarkets, plain, type LiveTrader, type Market, type OrderRequest, type OrderState, type OrderStatus, type Position, type TimeInForce } from "./trade.ts";
import { asRefusal, isStable, num, redact, REGION, unreachable, venueSaidNo, type Http, type HttpReply, type LiveBalance, type LiveSource } from "./types.ts";

// ---- Robinhood Crypto ----------------------------------------------------------------------

export const ROBINHOOD_CRYPTO_KEY: KeyShape = { required: ["apiKey", "privateKey"], example: '{"apiKey": "rh-api-…", "privateKey": "…"} (the base64 private key you made; Robinhood was given its public half when the credential was created)' };

const CRYPTO = "https://trading.robinhood.com";
/** an Ed25519 private key as PKCS#8 is this prefix and the 32-byte seed */
const ED25519_PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");

/** the private key Robinhood's docs have you make: 32 bytes, base64 */
export function robinhoodKey(base64: string): KeyObject | undefined {
  const seed = Buffer.from(base64.trim(), "base64");
  if (seed.length !== 32) return undefined;
  try {
    return createPrivateKey({ key: Buffer.concat([ED25519_PKCS8, seed]), format: "der", type: "pkcs8" });
  } catch {
    return undefined;
  }
}

/** the x-signature Robinhood expects for one request, base64 */
export function robinhoodSign(key: KeyObject, apiKey: string, timestampS: number | string, pathWithQuery: string, method: string, body = ""): string {
  return cryptoSign(null, Buffer.from(`${apiKey}${timestampS}${pathWithQuery}${method.toUpperCase()}${body}`), key).toString("base64");
}

// ---- trading: what both interfaces share ---------------------------------------------------------

/** A UUID made from a name (RFC 9562 version 5: SHA-1 under the URL namespace): the same name always makes the same UUID. An order's UUID is
 * made from the venue, the account and the account's own id for the order (`ord-0001`), so asking twice is asking for the same order. */
export function uuidFrom(name: string): string {
  const h = createHash("sha1").update(Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex")).update(name, "utf8").digest().subarray(0, 16);
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIVE_MIN = 5 * 60_000;
const tail4 = (n: string) => `··${n.slice(-4)}`;
const isOrder = (b: unknown): b is Record<string, unknown> => !!b && typeof b === "object" && typeof (b as { id?: unknown }).id === "string" && (b as { id: string }).id !== "";

/** Robinhood's crypto API is for US customers, and v2 orders for "customers in eligible jurisdictions": a state's rule, in the words a refusal
 * of it is likely to use (Robinhood publishes none of its sentences) */
const STATE_RULE = /(not|isn't) (available|supported|offered|permitted) (in|for|from) (your|this) (state|jurisdiction|region|country|location)|(ineligible|restricted|unsupported) (state|jurisdiction)|eligible jurisdiction/i;

/** What Robinhood said, as one of the account's refusals. Robinhood publishes the shape of its errors and none of their sentences, so its words
 * are read in this order, and anything else is a plain refusal that carries them. */
function rhNo(venue: string, name: string, s: { status?: number | undefined; said: string }, o: { order?: string | undefined; permission: string; unauthorized: string }): Refusal {
  const t = s.said;
  const code = s.status ?? 0;
  const native = { ...(s.status !== undefined ? { status: s.status } : {}), said: t };
  if (code === 451 || REGION.test(t) || STATE_RULE.test(t)) return no("E_VENUE_GEOBLOCKED", { venue, message: `${name} does not take this from where the account is: that is Robinhood's own rule, and the account does not look for a way around it`, native });
  // a request Robinhood could not authenticate: a missing header comes back as a 400 in plain text, a signature or a timestamp it refuses as a 401
  if (code === 401 || /required headers|signature|timestamp/i.test(t)) return no("E_VENUE_UNAUTHORIZED", { venue, message: o.unauthorized, native });
  if (code === 429 || /rate.?limit|too many requests/i.test(t)) return no("E_VENUE_UNREACHABLE", { venue, message: `${name} is rate-limiting this machine: try again in a minute`, native });
  if (code >= 500) return no("E_VENUE_UNREACHABLE", { venue, message: `${name} did not answer`, native });
  if (/permission|scope|api action|unauthori[sz]ed|not authori[sz]ed|agentic/i.test(t)) return no("E_VENUE_PERMISSION", { venue, message: o.permission, native });
  if (/insufficient|not enough|buying power|exceeds? (the |your )?(available|balance|holdings)/i.test(t)) return no("E_VENUE_INSUFFICIENT", { venue, message: `${name}: not enough buying power, or not enough held, for this order`, native });
  if (code === 403) return no("E_VENUE_PERMISSION", { venue, message: o.permission, native });
  if (o.order !== undefined && (code === 404 || /not found|does not exist|no such order|unknown order/i.test(t))) return no("E_ACCOUNT_ORDER_UNKNOWN", { venue, message: `${name} has no order ${o.order}`, native, detail: { order: o.order } });
  if (/not (currently )?tradable|untradable|halt|sell.?only|position_closing_only|market (is )?closed|outside (of )?(regular|market|trading) hours/i.test(t)) return no("E_VENUE_MARKET_CLOSED", { venue, message: `${name} takes no such order now: ${t}`, native });
  // a 400 to an order being placed is Robinhood's validation of it; a 400 to a cancel (an order already done) is a plain refusal
  if ((o.order === undefined && code === 400) || /increment|minimum|maximum|precision|decimal|too (small|large)|at (least|most)|fraction|tick|quantity|price|size|amount/i.test(t)) return { ...badOrder(venue, name, t || "the order was not taken as written"), native };
  return no("E_VENUE_REJECTED", { venue, message: `${name} refused${code ? ` (HTTP ${code})` : ""}: ${t}`.slice(0, 300), native });
}

// ---- Robinhood Crypto: orders ----------------------------------------------------------------------

/** the pairs an empty search starts with, when Robinhood lists them */
const CRYPTO_FIRST = ["BTC-USD", "ETH-USD", "SOL-USD", "XRP-USD", "DOGE-USD", "LINK-USD", "AVAX-USD"];
const PAIR = /^[A-Z0-9]{1,16}-[A-Z0-9]{2,8}$/;
/** v1's trading_pairs say `sellonly`; v2's status is free text, read the same way */
const SELL_ONLY = /^sell_?only$/;
/** The times in force Robinhood's crypto orders take. Its API lists gtc, gfd, gfw and gfm for the limit, stop_loss and stop_limit configs
 * (docs.robinhood.com/crypto/trading, AddOrderV2's TimeInForce; a market config has none), and Robinhood's own Trading MCP says which go with
 * which type: "market and limit: 'gtc' (good till canceled) only … limit orders are always for 90 days", a stop gtc, gfd, gfw or gfm and gfd
 * when none is given, and "'ioc' is NEVER supported for crypto orders" (place_crypto_order, as its tools/list gives it). The account's gtc is
 * Robinhood's gtc and its day is gfd; a week or a month has no name in the account, and there is no immediate-or-cancel or fill-or-kill. */
const CRYPTO_TIFS: TimeInForce[] = ["gtc", "day"];

/** the account's name for a pair is Robinhood's own, `BTC-USD`; `btc/usd` and `BTC` are read as it */
function pairSymbol(s: string): string {
  const t = s.trim().toUpperCase().replace("/", "-");
  return t.includes("-") ? t : `${t}-USD`;
}

/** a number as Robinhood takes it: a decimal string with no more places than the pair's increment has (`0.00000001` → eight) */
function fixed(x: number, increment: unknown): string {
  const m = /^\d+(?:\.(\d+))?$/.exec(String(increment ?? "").trim());
  if (!m) return plain(x, 10);
  return x.toFixed(Math.min(12, (m[1] ?? "").replace(/0+$/, "").length));
}

/** Robinhood's price for a pair: v2's best_bid_ask has a bid and an ask and no `price`, so the middle of the two (v1's `price` if it is there) */
const midOf = (p: Record<string, unknown>): number => (num(p.price) > 0 ? num(p.price) : num(p.bid) > 0 && num(p.ask) > 0 ? (num(p.bid) + num(p.ask)) / 2 : 0);

/** Robinhood's error body ({type, errors: [{detail, attr}]}), or its text: a request missing a header is answered in text/plain */
function saidBy(r: HttpReply, secrets: Array<string | undefined>): { status: number; said: string } {
  const errors = (r.body as { errors?: unknown } | undefined)?.errors;
  const parts = (Array.isArray(errors) ? errors : []).map((e: { detail?: unknown; attr?: unknown } | null) => `${typeof e?.attr === "string" && e.attr !== "non_field_errors" ? `${e.attr}: ` : ""}${String(e?.detail ?? "")}`.trim()).filter(Boolean);
  // redacted before it is cut short: a key that runs over the cut would otherwise leave its first half behind
  return { status: r.status, said: redact(parts.join("; ") || r.text, secrets).replace(/\s+/g, " ").trim().slice(0, 220) };
}

/** Robinhood's crypto order states — open (a limit on the book, or a stop waiting for its price), partially_filled, filled, canceled, failed,
 * and `pending`, which its order list filters by — as the account's. The states Robinhood's Trading MCP gives the same orders are read too:
 * confirmed is working, voided is done with nothing more to fill. A state it adds later is still working, and is asked again. */
function cryptoState(b: Record<string, unknown>): OrderState {
  const filled = num(b.filled_asset_quantity);
  const s = String(b.state ?? "").toLowerCase();
  const status: OrderStatus =
    s === "filled" ? "filled"
    : s === "canceled" || s === "cancelled" ? "canceled"
    : s === "failed" || s === "rejected" || s === "voided" ? "rejected"
    : s === "partially_filled" ? "partial"
    : s === "open" || s === "confirmed" ? (filled > 0 ? "partial" : "open")
    : filled > 0 ? "partial" : "pending";
  const fee = b.fee_charged;
  // the order as Robinhood said it, its account named by the last four digits
  const native = { ...b, ...(typeof b.account_number === "string" ? { account_number: tail4(b.account_number) } : {}) };
  return { ref: String(b.id), status, filledQty: filled, ...(num(b.average_price) > 0 ? { avgPrice: num(b.average_price) } : {}), ...(fee !== undefined && fee !== null && fee !== "" ? { feeUsd: num(fee) } : {}), native };
}

export async function robinhoodCryptoSource(req: { venue: string; label: string; reference: string; key: KeyFile; http: Http; clock: () => number }): Promise<{ source: LiveSource; first: LiveBalance[] } | Refusal> {
  const name = req.label || "Robinhood Crypto";
  const key = robinhoodKey(req.key.privateKey ?? "");
  if (!key) return no("E_ACCOUNT_CREDENTIAL", { venue: req.venue, message: "the private key is not the base64 Ed25519 key Robinhood's docs have you make (32 bytes once decoded)" });
  const apiKey = req.key.apiKey!;
  const secrets = [apiKey, req.key.privateKey];
  /** one signed request. A body is signed as the very string that is sent; a request without one (every GET, a cancel) signs an empty body */
  const send = async (method: "GET" | "POST", pathWithQuery: string, body?: string): Promise<HttpReply> => {
    const ts = Math.floor(req.clock() / 1000);
    const headers: Record<string, string> = { "x-api-key": apiKey, "x-timestamp": String(ts), "x-signature": robinhoodSign(key, apiKey, ts, pathWithQuery, method, body ?? ""), accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    try {
      return await req.http(`${CRYPTO}${pathWithQuery}`, { ...(method === "GET" ? {} : { method }), headers, ...(body !== undefined ? { body } : {}) });
    } catch (err) {
      throw unreachable(req.venue, name, err, secrets);
    }
  };
  const get = async (pathWithQuery: string): Promise<Record<string, unknown>> => {
    const r = await send("GET", pathWithQuery);
    if (r.status !== 200 || !r.body || typeof r.body !== "object") throw venueSaidNo(req.venue, name, r.status, r.text, secrets);
    return r.body as Record<string, unknown>;
  };
  /** a list Robinhood pages: `next` is the whole URL of the next page; five pages and no more */
  const all = async (path: string): Promise<Array<Record<string, unknown>>> => {
    const out: Array<Record<string, unknown>> = [];
    let next: string | undefined = path;
    for (let page = 0; next && page < 5; page++) {
      const body = await get(next);
      out.push(...((Array.isArray(body.results) ? body.results : []) as Array<Record<string, unknown>>));
      const n: unknown = body.next;
      next = typeof n === "string" && n.startsWith(`${CRYPTO}/`) ? n.slice(CRYPTO.length) : undefined;
    }
    return out;
  };
  /** the account the API trades: the one Robinhood marks is_api_tradable ("true for the default account"), noted on every read */
  let tradable: { number: string; status: string; feeRatio?: number | undefined } | undefined;
  const tradableIn = (a: Record<string, unknown>) => {
    const ratio = (a.fee_tier_status as { fee_ratio?: unknown } | undefined)?.fee_ratio;
    return a.is_api_tradable === true && typeof a.account_number === "string" && a.account_number ? { number: a.account_number, status: String(a.status ?? ""), ...(ratio !== undefined && ratio !== null ? { feeRatio: num(ratio) } : {}) } : undefined;
  };
  const read = async (): Promise<LiveBalance[]> => {
    const out: LiveBalance[] = [];
    const held: Array<{ asset: string; amount: number; where: string }> = [];
    let api: typeof tradable;
    for (const a of await all("/api/v2/crypto/trading/accounts/")) {
      api ??= tradableIn(a);
      const number = String(a.account_number ?? "");
      // an account is named by its last four digits, never the whole number
      const tail = number ? `··${number.slice(-4)}` : "";
      const currency = String(a.buying_power_currency ?? "USD");
      const bp = num(a.buying_power);
      if (bp) out.push({ asset: currency, amount: bp, ...(currency === "USD" ? { usd: bp } : {}), where: `buying power ${tail}`.trim(), class: "cash" });
      if (!number) continue;
      for (const h of await all(`/api/v2/crypto/trading/holdings/?account_number=${encodeURIComponent(number)}`)) {
        const q = num(h.total_quantity);
        if (q > 0) held.push({ asset: String(h.asset_code ?? "?").toUpperCase(), amount: q, where: tail });
      }
    }
    tradable = api;
    // Robinhood's own price: the midpoint of what its partner exchanges would buy and sell at
    const symbols = [...new Set(held.filter((h) => !isStable(h.asset)).map((h) => `${h.asset}-USD`))];
    const mid = new Map<string, number>();
    if (symbols.length) {
      const body = await get(`/api/v2/crypto/marketdata/best_bid_ask/?${symbols.map((s) => `symbol=${encodeURIComponent(s)}`).join("&")}`);
      for (const p of (Array.isArray(body.results) ? body.results : []) as Array<Record<string, unknown>>) if (midOf(p) > 0) mid.set(String(p.symbol), midOf(p));
    }
    for (const h of held) {
      const price = isStable(h.asset) ? 1 : mid.get(`${h.asset}-USD`);
      out.push({ asset: h.asset, amount: h.amount, ...(price ? { usd: h.amount * price } : {}), where: h.where, class: isStable(h.asset) ? "stable" : "crypto" });
    }
    return out;
  };

  // ---- orders: GET trading_pairs and best_bid_ask, POST orders, GET orders/{id}, POST orders/{id}/cancel ---------------------------------
  const refused = (r: HttpReply, order?: string) =>
    rhNo(req.venue, name, saidBy(r, secrets), { order, permission: `${name} refused: this API key was made without the action "Place crypto orders with fee tiers" (or "Read crypto orders"). A key's actions are chosen when it is made, in Robinhood's crypto account settings`, unauthorized: `${name} does not accept this key` });
  const unknownOrder = (ref: string) => no("E_ACCOUNT_ORDER_UNKNOWN", { venue: req.venue, message: `${name} has no order ${ref}`, detail: { order: ref } });
  const unpriced = (symbol: string) => no("E_ACCOUNT_UNPRICED", { venue: req.venue, message: `${symbol} is not priced in dollars: the account trades markets priced in dollars, so that every limit means dollars` });
  const account = async (): Promise<{ number: string; status: string } | Refusal> => {
    if (!tradable) for (const a of await all("/api/v2/crypto/trading/accounts/")) if ((tradable = tradableIn(a))) break;
    return tradable && /^[A-Za-z0-9-]{1,40}$/.test(tradable.number) ? tradable : no("E_VENUE_PERMISSION", { venue: req.venue, message: `${name}: none of this key's crypto accounts may be traded through the API (Robinhood marks the one that may with is_api_tradable)` });
  };
  /** a pair's rules — its increments, its largest order, its smallest in dollars, whether the API trades it — kept five minutes */
  let listed: { at: number; pairs: Array<Record<string, unknown>> } | undefined;
  const kept = new Map<string, { at: number; pair: Record<string, unknown> | undefined }>();
  const pairOf = async (symbol: string): Promise<Record<string, unknown> | undefined> => {
    const now = req.clock();
    const k = kept.get(symbol);
    if (k && now - k.at < FIVE_MIN) return k.pair;
    const body = await get(`/api/v2/crypto/trading/trading_pairs/?symbol=${symbol}`);
    const pair = ((Array.isArray(body.results) ? body.results : []) as Array<Record<string, unknown>>).find((p) => String(p?.symbol ?? "").toUpperCase() === symbol);
    kept.set(symbol, { at: now, pair });
    return pair;
  };
  /** Robinhood's best bid and ask for a few pairs, in one request ("this price does not take into account the order size or fee") */
  const books = async (symbols: string[]): Promise<Map<string, { bid: number; ask: number; price: number }>> => {
    const out = new Map<string, { bid: number; ask: number; price: number }>();
    if (!symbols.length) return out;
    const body = await get(`/api/v2/crypto/marketdata/best_bid_ask/?${symbols.map((s) => `symbol=${s}`).join("&")}`);
    for (const p of (Array.isArray(body.results) ? body.results : []) as Array<Record<string, unknown>>) if (midOf(p) > 0) out.set(String(p.symbol).toUpperCase(), { bid: num(p.bid), ask: num(p.ask), price: midOf(p) });
    return out;
  };
  const marketOf = (p: Record<string, unknown>, book?: { bid: number; ask: number; price: number }): Market => {
    const symbol = String(p.symbol ?? "").toUpperCase();
    const [b0, q0] = symbol.split("-");
    const base = String(p.asset_code ?? b0 ?? "").toUpperCase();
    const quote = String(p.quote_code ?? q0 ?? "").toUpperCase();
    const status = String(p.status ?? "").toLowerCase();
    const sellsOnly = SELL_ONLY.test(status);
    const max = num(p.max_order_size);
    const why =
      p.is_api_tradable !== true ? `Robinhood takes no API orders in ${symbol} (it is not marked is_api_tradable)`
      : status !== "tradable" && !sellsOnly ? `Robinhood lists ${symbol} as ${status || "not tradable"} now`
      : tradable?.status === "deactivated" ? "Robinhood has deactivated this crypto account"
      : undefined;
    const note = why ?? [
      ...(sellsOnly ? [`Robinhood takes only sells in ${symbol} now`] : []),
      ...(tradable?.status === "sell_only" ? ["Robinhood has this crypto account on sell only: it refuses buys"] : []),
      tradable?.feeRatio !== undefined ? `Robinhood's fee is ${plain(tradable.feeRatio * 100, 4)}% of each order at this account's fee tier` : "Robinhood charges the fee of the account's fee tier on each order",
      ...(max > 0 ? [`at most ${plain(max)} ${base} an order`] : []),
      // Robinhood's crypto orders have no immediate-or-cancel, so this is how a market order, and a stop once it triggers, is held to its worst
      // price (see place)
      "a market order goes as a limit at its worst price, a stop as a stop-limit at its worst price: what does not fill at once waits on the book",
      "market and limit orders are good till canceled (Robinhood keeps them 90 days); a stop is good for the day, Robinhood's default, unless good till canceled is chosen",
      "crypto trades every day, all day",
    ].join(" · ");
    // the four order types Robinhood's crypto orders come in (AddOrderV2: market, limit, stop_loss, stop_limit), and no post-only, reduce-only
    // or leverage: its API has none of them
    return { symbol, name: `${base} / ${quote}`, kind: "crypto", base, quote, ...(book ? { price: book.price, bid: book.bid > 0 ? book.bid : undefined, ask: book.ask > 0 ? book.ask : undefined } : {}), qtyStep: num(p.asset_increment) || undefined, priceStep: num(p.quote_increment) || undefined, minNotional: num(p.min_order_amount) || undefined, open: !why, note, types: ["market", "limit", "stop", "stop_limit"], tifs: [...CRYPTO_TIFS], tifsByType: { market: ["gtc"], limit: ["gtc"], stop: ["gtc", "day"], stop_limit: ["gtc", "day"] }, sellsReduce: true };
  };
  const market = async (symbol: string): Promise<Market | Refusal> => {
    try {
      const sym = pairSymbol(symbol);
      if (!PAIR.test(sym)) return badOrder(req.venue, name, `"${symbol}" is not a crypto pair: Robinhood names them like BTC-USD`);
      if (!inDollars(sym.split("-")[1]!)) return unpriced(sym);
      const p = await pairOf(sym);
      if (!p) return badOrder(req.venue, name, `Robinhood lists no crypto pair ${sym}`);
      const m = marketOf(p);
      // best_bid_ask answers only for the pairs the API trades
      if (!m.open) return m;
      const book = (await books([sym])).get(sym);
      return book ? marketOf(p, book) : m;
    } catch (err) {
      return asRefusal(req.venue, name, err, secrets);
    }
  };
  const markets = async (query: string): Promise<Market[] | Refusal> => {
    try {
      const now = req.clock();
      if (!listed || now - listed.at >= FIVE_MIN) {
        const symbolOf = (p: Record<string, unknown>) => String(p.symbol ?? "").toUpperCase();
        const rank = (s: string) => (CRYPTO_FIRST.includes(s) ? CRYPTO_FIRST.indexOf(s) : CRYPTO_FIRST.length);
        const pairs = (await all("/api/v2/crypto/trading/trading_pairs/")).filter((p) => p.is_api_tradable === true && PAIR.test(symbolOf(p)) && inDollars(String(p.quote_code ?? symbolOf(p).split("-")[1])));
        pairs.sort((a, b) => rank(symbolOf(a)) - rank(symbolOf(b)) || symbolOf(a).localeCompare(symbolOf(b)));
        listed = { at: now, pairs };
      }
      const found = pickMarkets(listed.pairs.map((p) => marketOf(p)), query);
      // a price for each, in one request; a list without prices is still a list
      const book = await books(found.filter((m) => m.open).map((m) => m.symbol)).catch(() => new Map<string, { bid: number; ask: number; price: number }>());
      return found.map((m) => {
        const b = book.get(m.symbol);
        return b ? { ...m, price: b.price, bid: b.bid > 0 ? b.bid : undefined, ask: b.ask > 0 ? b.ask : undefined } : m;
      });
    } catch (err) {
      return asRefusal(req.venue, name, err, secrets);
    }
  };
  /** An order sent without an answer (no answer in time, a reset, Robinhood's 5xx) is looked for once, by its client_order_id, among the
   * orders made in the pair since a minute before it was sent. Robinhood does not say what a second order with the same id does, so it is
   * looked for, not sent again. */
  const recover = async (accountNumber: string, symbol: string, id: string, at: number): Promise<OrderState | undefined> => {
    try {
      const since = new Date(at - 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
      const body = await get(`/api/v2/crypto/trading/orders/?account_number=${accountNumber}&created_at_start=${since}&symbol=${symbol}`);
      const hit = (Array.isArray(body.results) ? body.results : []).find((x: { client_order_id?: unknown } | null) => x?.client_order_id === id);
      return isOrder(hit) ? cryptoState(hit) : undefined;
    } catch {
      return undefined;
    }
  };
  const lost = (id: string, said: unknown) => no("E_VENUE_UNREACHABLE", { venue: req.venue, message: `${name} did not answer the order, and it is not among Robinhood's orders yet: look in Robinhood before placing it again`, native: { client_order_id: id, said } });
  const place = async (o: OrderRequest): Promise<OrderState | Refusal> => {
    try {
      const sym = pairSymbol(o.symbol);
      if (!PAIR.test(sym)) return badOrder(req.venue, name, `"${o.symbol}" is not a crypto pair: Robinhood names them like BTC-USD`);
      if (!inDollars(sym.split("-")[1]!)) return unpriced(sym);
      // what a Robinhood crypto order cannot carry is said before Robinhood is asked anything
      if (!ORDER_TYPES.includes(o.type)) return badOrder(req.venue, name, `Robinhood takes market, limit, stop and stop-limit crypto orders, not ${String(o.type)} orders`);
      if (o.postOnly || o.reduceOnly) return badOrder(req.venue, name, "Robinhood's crypto orders have no post-only or reduce-only flag");
      const stopped = o.type === "stop" || o.type === "stop_limit";
      if (o.tif !== undefined && !CRYPTO_TIFS.includes(o.tif)) return badOrder(req.venue, name, `Robinhood's crypto orders are good till canceled or good for the day, never ${o.tif}`);
      if (o.tif === "day" && !stopped) return badOrder(req.venue, name, "a market or limit crypto order at Robinhood is good till canceled only (Robinhood keeps it 90 days): good for the day is for a stop");
      const p = await pairOf(sym);
      if (!p) return badOrder(req.venue, name, `Robinhood lists no crypto pair ${sym}`);
      const m = marketOf(p);
      if (!m.open) return no("E_VENUE_MARKET_CLOSED", { venue: req.venue, message: `${name}: ${m.note}` });
      if (o.side === "buy" && SELL_ONLY.test(String(p.status ?? "").toLowerCase())) return no("E_VENUE_MARKET_CLOSED", { venue: req.venue, message: `${name} takes only sells in ${sym} now` });
      if (!(o.qty > 0) || !onStep(o.qty, m.qtyStep)) return badOrder(req.venue, name, `a size in ${sym} moves in steps of ${plain(m.qtyStep ?? 0)} ${m.base}`, { qtyStep: m.qtyStep });
      const max = num(p.max_order_size);
      if (max > 0 && o.qty > max + 1e-12) return badOrder(req.venue, name, `the largest order in ${sym} is ${plain(max)} ${m.base}`, { maxQty: max });
      // a limit price and a stop price are on the pair's quote_increment, refused here when they are not, never rounded: a rounded trigger
      // fires at another price than the one signed
      const onGrid = (x: number | undefined): x is number => x !== undefined && Number.isFinite(x) && x > 0 && onStep(x, m.priceStep);
      if ((o.type === "limit" || o.type === "stop_limit") && !onGrid(o.limitPrice)) return badOrder(req.venue, name, `a limit price in ${sym} moves in steps of ${plain(m.priceStep ?? 0)}`, { priceStep: m.priceStep });
      if (stopped && !onGrid(o.stopPrice)) return badOrder(req.venue, name, `a stop price in ${sym} moves in steps of ${plain(m.priceStep ?? 0)}`, { priceStep: m.priceStep });
      // A market order with a worst price goes as a limit at that price, and a stop with one as a stop-limit at it (a buy's rounded down, a
      // sell's up). Robinhood's crypto API has no other way to bound a market order and no immediate-or-cancel; and a stop it triggers becomes a
      // market order it lets fill up to 1% above the price on a buy and 5% below on a sell (Robinhood's "Buying and selling crypto"). Held at
      // the worst price, what does not fill at once rests on the book, never past it
      const bounds = o.type === "market" || o.type === "stop";
      if (bounds && o.worstPrice !== undefined && !(Number.isFinite(o.worstPrice) && o.worstPrice > 0)) return badOrder(req.venue, name, `a ${o.type} order's worst price is a price more than zero`);
      const bound = bounds && o.worstPrice !== undefined ? (o.side === "buy" ? floorTo(o.worstPrice, m.priceStep) : ceilTo(o.worstPrice, m.priceStep)) : undefined;
      if (bound !== undefined && !(bound > 0)) return badOrder(req.venue, name, `a price in ${sym} moves in steps of ${plain(m.priceStep ?? 0)}`, { priceStep: m.priceStep });
      const acct = await account();
      if (isRefusal(acct)) return acct;
      const id = uuidFrom(`${CRYPTO}/${acct.number}/${o.clientId}`);
      const limitPrice = o.type === "limit" || o.type === "stop_limit" ? o.limitPrice! : bound;
      const stopPrice = stopped ? o.stopPrice! : undefined;
      // AddOrderV2: Robinhood's type, and exactly one order config, named for it as Robinhood's own sample client names it
      // (`${type}_order_config`): market {asset_quantity} · limit {asset_quantity, limit_price, time_in_force} · stop_loss {asset_quantity,
      // stop_price, time_in_force} · stop_limit {asset_quantity, limit_price, stop_price, time_in_force}. stop_loss is Robinhood's stop, a buy's
      // as much as a sell's. Market and limit orders are good till canceled; a stop is good for the day unless good till canceled was chosen,
      // the default Robinhood gives its stops, sent rather than left out. The amounts go as decimal strings, as every example in Robinhood's
      // docs sends them, never as a float that could print as 1e-7
      const type = stopPrice === undefined ? (limitPrice === undefined ? "market" : "limit") : limitPrice === undefined ? "stop_loss" : "stop_limit";
      const tif = o.tif === "day" ? "gfd" : o.tif === "gtc" ? "gtc" : stopped ? "gfd" : "gtc";
      const config = {
        asset_quantity: fixed(o.qty, p.asset_increment),
        ...(limitPrice !== undefined ? { limit_price: fixed(limitPrice, p.quote_increment) } : {}),
        ...(stopPrice !== undefined ? { stop_price: fixed(stopPrice, p.quote_increment) } : {}),
        ...(type === "market" ? {} : { time_in_force: tif }),
      };
      const body = JSON.stringify({ client_order_id: id, side: o.side, type, symbol: sym, [`${type}_order_config`]: config });
      const at = req.clock();
      let r: HttpReply;
      try {
        r = await send("POST", `/api/v2/crypto/trading/orders/?account_number=${acct.number}`, body);
      } catch (err) {
        return (await recover(acct.number, sym, id, at)) ?? lost(id, isRefusal(err) ? err.native : undefined);
      }
      if ((r.status === 201 || r.status === 200) && isOrder(r.body)) {
        const b = r.body;
        if (String(b.symbol ?? sym).toUpperCase() !== sym || String(b.side ?? o.side) !== o.side) return no("E_VENUE_REJECTED", { venue: req.venue, message: `${name} answered with another order under this order's id: nothing new was placed`, native: cryptoState(b).native });
        return cryptoState(b);
      }
      // a 5xx, or a yes without an order in it: the order may be there, so it is looked for, never read as a refusal
      if (r.status >= 500 || (r.status >= 200 && r.status < 300)) return (await recover(acct.number, sym, id, at)) ?? lost(id, saidBy(r, secrets));
      return refused(r);
    } catch (err) {
      return asRefusal(req.venue, name, err, secrets);
    }
  };
  const status = async (ref: string, symbol: string): Promise<OrderState | Refusal> => {
    try {
      if (!UUID.test(ref)) return unknownOrder(ref);
      const acct = await account();
      if (isRefusal(acct)) return acct;
      const r = await send("GET", `/api/v2/crypto/trading/orders/${ref}/?account_number=${acct.number}`);
      if (r.status === 200 && isOrder(r.body)) return cryptoState(r.body);
      // the one-order path is in Robinhood's own sample client, not in its list of paths: where it is not there, the order list answers
      if (r.status === 404 || r.status === 405) {
        const sym = pairSymbol(symbol);
        const hit = (await all(`/api/v2/crypto/trading/orders/?account_number=${acct.number}${PAIR.test(sym) ? `&symbol=${sym}` : ""}`)).find((x) => x.id === ref);
        return isOrder(hit) ? cryptoState(hit) : unknownOrder(ref);
      }
      return refused(r, ref);
    } catch (err) {
      return asRefusal(req.venue, name, err, secrets);
    }
  };
  const cancel = async (ref: string, symbol: string): Promise<OrderState | Refusal> => {
    try {
      if (!UUID.test(ref)) return unknownOrder(ref);
      // a POST with no body, signed as an empty one, and no account number. It asks Robinhood to cancel: the order comes back as it stands
      const r = await send("POST", `/api/v2/crypto/trading/orders/${ref}/cancel/`);
      if (r.status >= 200 && r.status < 300) return isOrder(r.body) ? cryptoState(r.body) : await status(ref, symbol);
      return refused(r, ref);
    } catch (err) {
      return asRefusal(req.venue, name, err, secrets);
    }
  };
  /** What the account the API trades holds (GET /api/v2/crypto/trading/holdings/?account_number=, docs.robinhood.com/crypto/trading:
   * total_quantity, and quantity_available_for_trading net of what open orders lock, both strings in v2), as long positions in the pairs the
   * account names them by (BTC as BTC-USD), priced at Robinhood's own midpoint in one request. Robinhood gives no cost basis here, so no
   * entry price; it has no call that closes a position, nor one that changes an order in place: a sell is placed, an order canceled. */
  const positions = async (): Promise<Position[] | Refusal> => {
    try {
      const acct = await account();
      if (isRefusal(acct)) return acct;
      const held = (await all(`/api/v2/crypto/trading/holdings/?account_number=${acct.number}`))
        .map((h) => ({ h, asset: String(h.asset_code ?? "").toUpperCase(), qty: num(h.total_quantity) }))
        .filter((x) => x.qty > 0 && /^[A-Z0-9]{1,16}$/.test(x.asset));
      // positions without a price are still positions
      const book = await books([...new Set(held.filter((x) => !isStable(x.asset)).map((x) => `${x.asset}-USD`))]).catch(() => new Map<string, { bid: number; ask: number; price: number }>());
      return held.map(({ h, asset, qty }): Position => {
        const mark = isStable(asset) ? 1 : book.get(`${asset}-USD`)?.price;
        return { symbol: `${asset}-USD`, name: `${asset} / USD`, kind: "crypto", side: "long", qty, ...(mark ? { markPrice: mark, usd: qty * mark } : {}), native: { ...h, ...(typeof h.account_number === "string" ? { account_number: tail4(h.account_number) } : {}) } };
      });
    } catch (err) {
      return asRefusal(req.venue, name, err, secrets);
    }
  };
  // Robinhood has no call that says which actions a key was made with: its first refusal of an order says it
  const trader: LiveTrader = { can: "unknown", what: "crypto", markets, market, place, cancel, status, positions };
  try {
    const first = await read();
    const source: LiveSource = {
      name,
      kind: "cex",
      reference: req.reference,
      via: "Robinhood Crypto Trading API · priced at Robinhood's own midpoint",
      probe: {
        can: [],
        note: `a Robinhood crypto key can do what was chosen for it when it was made ("Place crypto orders with fee tiers" places orders), and Robinhood has no call that says which: an order the key may not place is refused by Robinhood itself${tradable ? ` · orders go to the account Robinhood trades through the API, ${tail4(tradable.number)}` : " · Robinhood marks none of this key's accounts as one the API trades"}`,
        native: { calls: ["GET /api/v2/crypto/trading/accounts/", "GET /api/v2/crypto/trading/holdings/", "GET /api/v2/crypto/marketdata/best_bid_ask/"], orders: ["GET /api/v2/crypto/trading/trading_pairs/", "POST /api/v2/crypto/trading/orders/", "GET /api/v2/crypto/trading/orders/{id}/", "POST /api/v2/crypto/trading/orders/{id}/cancel/"], signed: "Ed25519" },
      },
      read,
      readOnlyBecause: "Robinhood's crypto API reads and trades; it has no call that moves money in or out: deposits and withdrawals are made in Robinhood's app",
      trader,
    };
    return { source, first };
  } catch (err) {
    return asRefusal(req.venue, name, err, secrets);
  }
}

// ---- Stock Tokens --------------------------------------------------------------------------

const RHJ = "https://api.robinhood.com/rhj";

export interface StockToken {
  symbol: string;
  name: string;
  chain: ChainName;
  address: Hex;
}

/** the token list changes slowly: asked again after ten minutes, kept per network so a test's stand-in is never handed another's list */
const lists = new WeakMap<Http, { at: number; tokens: StockToken[] }>();

/** every active Stock Token, on the chains this account reads */
export async function stockTokens(http: Http, now: number): Promise<StockToken[]> {
  const kept = lists.get(http);
  if (kept && now - kept.at < 10 * 60_000) return kept.tokens;
  const r = await http(`${RHJ}/assets`, { headers: { accept: "application/json" } });
  if (r.status !== 200 || !r.body || typeof r.body !== "object") throw venueSaidNo("robinhood", "Robinhood's Stock Token list", r.status, r.text);
  const tokens: StockToken[] = [];
  for (const a of ((r.body as { assets?: unknown }).assets ?? []) as Array<Record<string, unknown>>) {
    if (a.status !== "ASSET_STATUS_ACTIVE" || typeof a.tokenSymbol !== "string") continue;
    for (const d of (Array.isArray(a.deployments) ? a.deployments : []) as Array<Record<string, unknown>>) {
      const chain = CHAIN_BY_ID.get(Number(d.chainId));
      if (chain && typeof d.contractAddress === "string" && isAddress(d.contractAddress, { strict: false })) tokens.push({ symbol: a.tokenSymbol, name: String(a.tokenName ?? a.tokenSymbol), chain, address: getAddress(d.contractAddress) });
    }
  }
  lists.set(http, { at: now, tokens });
  return tokens;
}

/** a token's bid is asked at most once a minute, and eight at a time: Robinhood allows sixty requests a second, and a wallet may hold many */
const bids = new WeakMap<Http, Map<string, { at: number; bid: number }>>();

/** dollars per token, from Robinhood's bid for the token itself (the share price times the token's corporate-action multiplier) */
export async function stockTokenBids(http: Http, symbols: string[], now: number): Promise<Map<string, number>> {
  const kept = bids.get(http) ?? new Map<string, { at: number; bid: number }>();
  bids.set(http, kept);
  const out = new Map<string, number>();
  const ask = symbols.filter((s) => {
    const k = kept.get(s);
    if (k && now - k.at < 60_000) out.set(s, k.bid);
    return !out.has(s);
  });
  for (let i = 0; i < ask.length; i += 8)
    await Promise.all(
      ask.slice(i, i + 8).map(async (s) => {
        try {
          const r = await http(`${RHJ}/prices/${encodeURIComponent(s)}`, { headers: { accept: "application/json" } });
          const q = ((r.body as { quotes?: unknown[] } | undefined)?.quotes?.[0] ?? {}) as Record<string, unknown>;
          if (r.status === 200 && num(q.tokenBid) > 0) {
            out.set(s, num(q.tokenBid));
            kept.set(s, { at: now, bid: num(q.tokenBid) });
          }
        } catch {
          // no price: the token is shown, and counts for nothing
        }
      }),
    );
  return out;
}

/** the Stock Tokens an address holds, priced; a list or a chain that does not answer is said, not thrown */
export async function stockTokenHoldings(holder: Hex, chain: ChainReader, http: Http, now: number): Promise<{ rows: LiveBalance[]; unread?: string }> {
  let tokens: StockToken[];
  try {
    tokens = await stockTokens(http, now);
  } catch {
    return { rows: [], unread: "Robinhood's Stock Token list did not answer" };
  }
  if (!tokens.length) return { rows: [] };
  const refs: TokenRef[] = tokens.map((t) => ({ chain: t.chain, asset: t.symbol, address: t.address }));
  const read = await chain.tokens(holder, refs);
  const held = read.rows.filter((b) => b.amount > 0);
  const bid = await stockTokenBids(http, [...new Set(held.map((b) => b.asset))], now);
  return {
    rows: held.map((b) => ({ asset: b.asset, amount: b.amount, ...(bid.has(b.asset) ? { usd: b.amount * bid.get(b.asset)! } : {}), where: `${b.chain} · Stock Token`, class: "equity" })),
    ...(read.failed.length ? { unread: `${read.failed.join(", ")} did not answer` } : {}),
  };
}

// ---- Robinhood stocks, through Robinhood's MCP server --------------------------------------

export const ROBINHOOD_MCP = "https://agent.robinhood.com/mcp/trading";

/** The only tools a read calls. Orders are placed, followed and cancelled with TRADE_TOOLS (and the two tools below them, when offered), and
 * what the Agentic account holds is read with get_equity_positions; review_equity_order, the crypto and option tools, and the watchlist tools
 * that write are never called from here. */
export const READ_TOOLS = ["get_accounts", "get_portfolio", "get_equity_positions"] as const;
type ReadTool = (typeof READ_TOOLS)[number];

/** The tools an order needs, by the names on Robinhood's own page ("Trading with your agent", read 2026-10-05). Robinhood publishes no input
 * schemas: the inputs sent are the ones a capture of the server's tools/list gives (2026-09-28), and every call is checked against the
 * schema the server lists at that moment before it is made. */
export const TRADE_TOOLS = ["get_equity_quotes", "place_equity_order", "get_equity_orders", "cancel_equity_order"] as const;
/** asked when the server offers them: a stock's tradability for the account, and a search by name */
const MORE_TOOLS = ["get_equity_tradability", "search"] as const;
type TradeTool = (typeof TRADE_TOOLS)[number] | (typeof MORE_TOOLS)[number] | "get_accounts" | "get_equity_positions";

export interface McpTool {
  name: string;
  description?: string | undefined;
  inputSchema?: { required?: string[] | undefined; properties?: Record<string, unknown> | undefined } | undefined;
}
export interface McpSession {
  tools(): Promise<McpTool[]>;
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}
export type OpenMcp = (url: string, bearer: string) => Promise<McpSession>;

/** the real client: Streamable HTTP, the bearer token in a header (the SDK is loaded on first use) */
export const realMcp: OpenMcp = async (url, bearer) => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const client = new Client({ name: "buyer-agent-demo account", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${bearer}` } } });
  // the SDK's own types disagree with exactOptionalPropertyTypes on `sessionId`; the object is the SDK's own transport
  await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
  return {
    tools: async () => (await client.listTools()).tools as McpTool[],
    call: (name, args) => client.callTool({ name, arguments: args }),
    close: () => client.close(),
  };
};

/** what a tool answered, as data: its structured content, or its text read as JSON */
export function toolData(result: unknown): unknown {
  const r = (result ?? {}) as { structuredContent?: unknown; content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  const text = (Array.isArray(r.content) ? r.content : []).filter((c) => c?.type === "text").map((c) => c.text ?? "").join("\n").trim();
  // whole: the caller redacts the sign-in's token out of it before cutting it short
  if (r.isError) throw new Error(text || "the tool answered with an error");
  if (r.structuredContent !== undefined) return r.structuredContent;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** every object in a value, depth first, not too deep */
function* objects(v: unknown, depth = 0): Generator<Record<string, unknown>> {
  if (depth > 6 || !v || typeof v !== "object") return;
  if (Array.isArray(v)) {
    for (const x of v) yield* objects(x, depth + 1);
    return;
  }
  yield v as Record<string, unknown>;
  for (const x of Object.values(v)) yield* objects(x, depth + 1);
}

const pick = (o: Record<string, unknown>, keys: string[]): unknown => keys.map((k) => o[k]).find((x) => x !== undefined && x !== null && x !== "");
/** a number, or a money object ({amount, currency_code}) */
const amountOf = (v: unknown): number => (v && typeof v === "object" ? num((v as { amount?: unknown }).amount) : num(v));

/** The field names Robinhood's tools are read by. Robinhood does not publish what the tools answer, so these are the names its own APIs
 * use; an answer with none of them is said to be unreadable rather than read as zero. */
const ACCOUNT_ID = ["account_number", "accountNumber", "account_id", "accountId"];
const ACCOUNT_TYPE = ["account_type", "type", "brokerage_account_type", "nickname", "name"];
const SYMBOL = ["symbol", "ticker", "instrument_symbol"];
const QTY = ["quantity", "shares", "qty"];
const VALUE = ["market_value", "marketValue", "equity", "value", "current_value"];
const PRICE = ["price", "last_trade_price", "current_price", "mark_price", "last_price"];
const CASH = ["cash", "withdrawable_amount", "uninvested_cash", "cash_balance", "cash_available_for_withdrawal"];

export function accountsIn(data: unknown): Array<{ number: string; type: string }> {
  const seen = new Map<string, string>();
  for (const o of objects(data)) {
    const id = pick(o, ACCOUNT_ID);
    if (typeof id === "string" || typeof id === "number") seen.set(String(id), String(pick(o, ACCOUNT_TYPE) ?? ""));
  }
  return [...seen].map(([number, type]) => ({ number, type }));
}

export function cashIn(data: unknown): number | undefined {
  for (const o of objects(data)) {
    const v = pick(o, CASH);
    if (v !== undefined) return amountOf(v);
  }
  return undefined;
}

export function positionsIn(data: unknown): Array<{ symbol: string; quantity: number; usd?: number | undefined; account?: string | undefined }> {
  const out: Array<{ symbol: string; quantity: number; usd?: number | undefined; account?: string | undefined }> = [];
  for (const o of objects(data)) {
    const symbol = pick(o, SYMBOL);
    const quantity = amountOf(pick(o, QTY));
    if (typeof symbol !== "string" || !quantity) continue;
    const value = pick(o, VALUE);
    const price = amountOf(pick(o, PRICE));
    const account = pick(o, ACCOUNT_ID);
    out.push({ symbol, quantity, usd: value !== undefined ? amountOf(value) : price ? price * quantity : undefined, ...(account !== undefined ? { account: String(account) } : {}) });
  }
  return out;
}

/** the keys of an answer, and nothing in them: what is said when an answer cannot be read */
const shapeOf = (data: unknown): string[] => (Array.isArray(data) ? ["[list]", ...shapeOf(data[0])] : data && typeof data === "object" ? Object.keys(data).slice(0, 20) : [typeof data]);

const asksForAccount = (t: McpTool | undefined): string | undefined => (t?.inputSchema?.required ?? []).find((k) => /account/i.test(k));

/** the one account the trading tools may trade in: Robinhood marks it agentic_allowed (true for this agent; false may mean another agent's) */
export function agenticIn(data: unknown): { seen: boolean; account?: { number: string; type: string } | undefined } {
  let seen = false;
  for (const o of objects(data)) {
    if (typeof o.agentic_allowed !== "boolean") continue;
    seen = true;
    if (o.agentic_allowed && typeof o.account_number === "string" && o.account_number) return { seen, account: { number: o.account_number, type: String(o.brokerage_account_type ?? "") } };
  }
  return { seen };
}

/** why a sign-in with no account marked agentic_allowed may not trade, and how the account it needs is opened (Robinhood's "Onboarding an
 * external agent", read 2026-10-05: the MCP account is "a type of self-directed, individual investing account", opened during the first
 * sign-in; the agent "can only place trades in your Robinhood Agentic account") */
const NO_AGENTIC =
  "this sign-in has no Robinhood Agentic account, the one account an agent may trade in (Robinhood marks it agentic_allowed): Robinhood opens it, as a self-directed individual investing account it calls the MCP account, during the sign-in that first connects an agent, so sign in again from the account page and open it there";

/** what a tool would be sent that its schema, as the server lists it now, no longer takes or now requires: an order is not sent on a guess */
function unfit(tool: McpTool | undefined, args: Record<string, unknown>): string[] {
  const props = tool?.inputSchema?.properties;
  const extra = props ? Object.keys(args).filter((k) => !(k in props)) : [];
  const missing = (tool?.inputSchema?.required ?? []).filter((k) => !(k in args));
  return [...extra.map((k) => `no longer takes ${k}`), ...missing.map((k) => `now requires ${k}`)];
}

const TICKER = /^[A-Z][A-Z0-9.]{0,9}$/;
/** a few stocks an empty search starts with */
const STOCKS_FIRST: Array<{ symbol: string; name: string }> = [
  { symbol: "SPY", name: "SPDR S&P 500 ETF" },
  { symbol: "QQQ", name: "Invesco QQQ" },
  { symbol: "AAPL", name: "Apple" },
  { symbol: "MSFT", name: "Microsoft" },
  { symbol: "NVDA", name: "NVIDIA" },
  { symbol: "AMZN", name: "Amazon" },
  { symbol: "GOOGL", name: "Alphabet" },
  { symbol: "META", name: "Meta Platforms" },
  { symbol: "TSLA", name: "Tesla" },
  { symbol: "HOOD", name: "Robinhood Markets" },
];

/** a stock's quote (results[].quote), told apart from its close (results[].close) by its prices */
const quoteIn = (data: unknown, symbol: string): Record<string, unknown> | undefined => {
  for (const o of objects(data)) if (String(o.symbol ?? "").toUpperCase() === symbol && ("last_trade_price" in o || "bid_price" in o || "ask_price" in o)) return o;
  return undefined;
};
const tradabilityIn = (data: unknown, symbol: string): Record<string, unknown> | undefined => {
  for (const o of objects(data)) if (String(o.symbol ?? "").toUpperCase() === symbol && "tradeable" in o) return o;
  return undefined;
};
/** the last price: the regular session's last trade or the extended sessions', whichever is later (as the tool's guide says) */
const lastOf = (q: Record<string, unknown>): number | undefined => {
  if (q.has_traded === false) return undefined;
  const reg = num(q.last_trade_price);
  const ext = num(q.last_non_reg_trade_price);
  const regAt = Date.parse(String(q.venue_last_trade_time ?? "")) || 0;
  const extAt = Date.parse(String(q.venue_last_non_reg_trade_time ?? "")) || 0;
  const p = ext > 0 && extAt > regAt ? ext : reg;
  return p > 0 ? p : undefined;
};

/** Robinhood's equity order states (cancelled has two Ls here) as the account's. Queued, new, unconfirmed and locating are taken and not yet
 * working; pending_cancelled still works until Robinhood confirms the cancel; a state it adds later is still working, and is asked again. A
 * stop comes back as Robinhood's market or limit order with trigger "stop" (place_equity_order's own answer), under the same id and the same
 * states: while it waits for its price it is still working (queued is pending here, confirmed is open), and it fills, is cancelled or is
 * rejected as any other order does. */
function equityState(o: Record<string, unknown>): OrderState {
  const filled = num(o.cumulative_quantity);
  const s = String(o.state ?? "").toLowerCase();
  const working = filled > 0 ? "partial" : undefined;
  const status: OrderStatus =
    s === "filled" ? "filled"
    : s === "cancelled" || s === "canceled" || s === "partially_filled_rest_cancelled" ? "canceled"
    : s === "rejected" || s === "failed" || s === "voided" || s === "locate_failed" ? "rejected"
    : s === "partially_filled" ? "partial"
    : s === "confirmed" || s === "pending_cancelled" ? (working ?? "open")
    : (working ?? "pending");
  const native = { ...o, ...(typeof o.account_number === "string" ? { account_number: tail4(o.account_number) } : {}) };
  return { ref: String(o.id), status, filledQty: filled, ...(num(o.average_price) > 0 ? { avgPrice: num(o.average_price) } : {}), ...(o.fees !== undefined && o.fees !== null && o.fees !== "" ? { feeUsd: num(o.fees) } : {}), native };
}

export async function robinhoodStocksSource(req: { venue: string; label: string; token: () => Promise<string | Refusal>; open: OpenMcp; clock?: (() => number) | undefined }): Promise<{ source: LiveSource; first: LiveBalance[] } | Refusal> {
  const name = req.label || "Robinhood";
  const clock = req.clock ?? Date.now;
  let offered: string[] = [];
  let tokenSeen: string | undefined;
  /** the Agentic account, as the last read of get_accounts found it */
  let agentic: { number: string; type: string } | undefined;
  let agenticSeen = false;
  const read = async (): Promise<LiveBalance[]> => {
    const token = await req.token();
    if (isRefusal(token)) throw token;
    tokenSeen = token;
    let session: McpSession;
    try {
      session = await req.open(ROBINHOOD_MCP, token);
    } catch (err) {
      throw unreachable(req.venue, name, err, [token]);
    }
    try {
      const tools = new Map((await session.tools()).map((t) => [t.name, t]));
      offered = [...tools.keys()];
      const reads = READ_TOOLS.filter((t) => tools.has(t));
      if (!reads.length) throw no("E_VENUE_REJECTED", { venue: req.venue, message: `${name}'s MCP server offered none of the tools this connection reads with (${READ_TOOLS.join(", ")})`, native: { offered } });
      // only ever a name from READ_TOOLS: whatever else the server offers is left alone
      const call = async (tool: ReadTool, args: Record<string, unknown> = {}) => toolData(await session.call(tool, args));
      const accountData = tools.has("get_accounts") ? await call("get_accounts") : undefined;
      const accounts = accountData === undefined ? [] : accountsIn(accountData);
      const ag = agenticIn(accountData);
      agentic = ag.account;
      agenticSeen = ag.seen;
      const answers: Array<{ tool: ReadTool; account?: string | undefined; data: unknown }> = [];
      for (const tool of ["get_portfolio", "get_equity_positions"] as const) {
        if (!tools.has(tool)) continue;
        // a tool that needs an account names it in its input schema: it is asked once per account
        const arg = asksForAccount(tools.get(tool));
        if (arg) for (const a of accounts) answers.push({ tool, account: a.number, data: await call(tool, { [arg]: a.number }) });
        else answers.push({ tool, data: await call(tool) });
      }
      const tail = (n: string | undefined) => (n ? ` ··${n.slice(-4)}` : "");
      const out: LiveBalance[] = [];
      for (const a of answers.filter((x) => x.tool === "get_portfolio")) {
        const cash = cashIn(a.data);
        if (cash) out.push({ asset: "USD", amount: cash, usd: cash, where: `cash${tail(a.account)}`, class: "cash" });
      }
      for (const a of answers.filter((x) => x.tool === "get_equity_positions"))
        for (const p of positionsIn(a.data)) out.push({ asset: p.symbol, amount: Math.abs(p.quantity), ...(p.usd !== undefined ? { usd: p.usd } : {}), where: `stocks${tail(p.account ?? a.account)}`, class: "equity" });
      if (!out.length && !accounts.length) throw no("E_VENUE_REJECTED", { venue: req.venue, message: `${name} answered, but not in a shape this connection reads yet: nothing in it looks like an account, cash or a position`, native: { answered: answers.map((a) => ({ tool: a.tool, keys: shapeOf(a.data) })) } });
      return out;
    } catch (err) {
      // a later read's error is shown on the page as it is: the token comes out of it first, then it is cut short
      throw isRefusal(err) ? err : new Error(redact(String((err as Error)?.message ?? err), [token]).slice(0, 200));
    } finally {
      await session.close().catch(() => undefined);
    }
  };

  // ---- orders, in the Agentic account: get_equity_quotes, get_equity_tradability, place_equity_order, get_equity_orders, cancel_equity_order
  /** refusals made when a call did not come back at all, as opposed to the tool answering with an error */
  const lostCalls = new WeakSet<Refusal>();
  const refusedBy = (text: string, order?: string) =>
    rhNo(req.venue, name, { said: redact(text, [tokenSeen]).replace(/\s+/g, " ").trim().slice(0, 220) }, { order, permission: `${name} refused: through its MCP server an agent trades only in the Robinhood Agentic account, which Robinhood opens during the sign-in that first connects an agent`, unauthorized: `${name} no longer accepts this sign-in: sign in again from the account page` });
  const unknownOrder = (ref: string) => no("E_ACCOUNT_ORDER_UNKNOWN", { venue: req.venue, message: `${name} has no order ${ref} in the Agentic account`, detail: { order: ref } });
  const noAgentic = () => no("E_VENUE_PERMISSION", { venue: req.venue, message: `${name}: ${NO_AGENTIC}` });
  interface Tools {
    offered: Map<string, McpTool>;
    /** one tool, its answer's `data`; a tool's error comes back as a refusal in Robinhood's words */
    call(tool: TradeTool, args: Record<string, unknown>, order?: string): Promise<Record<string, unknown>>;
  }
  /** one session for one piece of trading: signed in, the server's tools listed, closed after */
  const withTools = async <T>(fn: (t: Tools) => Promise<T | Refusal>): Promise<T | Refusal> => {
    const token = await req.token();
    if (isRefusal(token)) return token;
    tokenSeen = token;
    let session: McpSession;
    try {
      session = await req.open(ROBINHOOD_MCP, token);
    } catch (err) {
      return unreachable(req.venue, name, err, [token]);
    }
    try {
      const listed = new Map((await session.tools()).map((t) => [t.name, t]));
      return await fn({
        offered: listed,
        call: async (tool, args, order) => {
          if (!listed.has(tool)) throw no("E_VENUE_REJECTED", { venue: req.venue, message: `${name}'s MCP server no longer offers ${tool}: nothing was sent`, native: { offered: [...listed.keys()] } });
          const changed = unfit(listed.get(tool), args);
          if (changed.length) throw no("E_VENUE_REJECTED", { venue: req.venue, message: `${name}'s ${tool} ${changed.join(", ")}: nothing was sent until this connection is brought up to date`, native: { tool, changed } });
          let result: unknown;
          try {
            result = await session.call(tool, args);
          } catch (err) {
            const r = unreachable(req.venue, name, err, [token]);
            lostCalls.add(r);
            throw r;
          }
          let data: unknown;
          try {
            data = toolData(result);
          } catch (err) {
            throw refusedBy(String((err as Error)?.message ?? err), order);
          }
          // a tool answers {data, guide}: the data is what is read
          const d = data && typeof data === "object" && !Array.isArray(data) && "data" in data ? (data as { data: unknown }).data : data;
          return d && typeof d === "object" && !Array.isArray(d) ? (d as Record<string, unknown>) : { value: d };
        },
      });
    } catch (err) {
      return asRefusal(req.venue, name, isRefusal(err) ? err : new Error(redact(String((err as Error)?.message ?? err), [token])), [token]);
    } finally {
      await session.close().catch(() => undefined);
    }
  };
  const accountFor = async (t: Tools) => {
    if (!agentic && t.offered.has("get_accounts")) {
      const ag = agenticIn(await t.call("get_accounts", {}));
      agentic = ag.account;
      agenticSeen = ag.seen;
    }
    return agentic;
  };
  /** whether place_equity_order, as the server lists it now, takes a stop: Robinhood's stop_market and stop_limit need its stop_price, so a
   * server whose schema has none is offered no stops rather than refused them at the last moment */
  const takesStops = (t: Tools): boolean => {
    const props = t.offered.get("place_equity_order")?.inputSchema?.properties;
    return !props || "stop_price" in props;
  };
  const stockOf = (symbol: string, q: Record<string, unknown> | undefined, t: Record<string, unknown> | undefined, stops: boolean): Market => {
    const price = q ? lastOf(q) : undefined;
    const bid = num(q?.bid_price);
    const ask = num(q?.ask_price);
    const fractional = t?.fractional_tradability === "tradable";
    const types = Array.isArray(t?.account_type_tradabilities) ? (t.account_type_tradabilities as Array<Record<string, unknown> | null>) : [];
    const forAccount = agentic?.type ? types.find((x) => x?.account_type === agentic!.type)?.account_type_tradability : undefined;
    const halted = Array.isArray(t?.internal_halt_sessions) && (t.internal_halt_sessions as unknown[]).includes("regular_hours");
    const state = String(q?.state ?? t?.state ?? "active");
    const why =
      t?.tradeable === false ? `Robinhood does not trade ${symbol}`
      : state !== "active" ? `Robinhood lists ${symbol} as ${state}`
      : forAccount === "untradable" ? `Robinhood does not let the Agentic account trade ${symbol}`
      : halted ? `${symbol} is halted at Robinhood${t?.internal_halt_details ? `: ${String(t.internal_halt_details)}` : ""}`
      : undefined;
    const note = why ?? [
      agentic ? `orders go to your Robinhood Agentic account ${tail4(agentic.number)}, the one account an agent may trade in` : "Robinhood shows no account this sign-in may trade in: an agent trades only in the Robinhood Agentic account",
      ...(forAccount === "position_closing_only" ? [`Robinhood takes only sells of ${symbol} in that account`] : []),
      `a market order goes as a limit at its worst price${stops ? ", a stop as a stop-limit at its worst price" : ""}; orders are for the regular session (9:30 to 16:00 New York) and outside it wait for the next open`,
      "good for the day, Robinhood's default, unless good till canceled is chosen (Robinhood keeps such an order 90 days); a market order is good for the day only",
      fractional ? "whole shares only: Robinhood takes a fraction of a share only as a plain market order, which cannot be held to a worst price" : "whole shares only",
    ].join(" · ");
    // The tick is the US market's ($0.01, or $0.0001 under a dollar): Robinhood's tools do not say it. The order types are place_equity_order's
    // (market, limit, stop_market, stop_limit; Robinhood's page "Trading with your agent" lists the same four), its time_in_force gfd or gtc —
    // "Market orders are Good-for-Day (GFD) orders and you can enter other order types as GFD or Good-til-Canceled (GTC)" (Robinhood's
    // "Order types"), which place() holds a market order to. No post-only, reduce-only or leverage: the tool has none
    return { symbol, name: String(t?.simple_name ?? t?.name ?? symbol), kind: "stock", base: symbol, quote: "USD", ...(price !== undefined ? { price } : {}), bid: bid > 0 ? bid : undefined, ask: ask > 0 ? ask : undefined, minQty: 1, qtyStep: 1, priceStep: (price ?? 1) < 1 ? 0.0001 : 0.01, open: !why, note, types: stops ? ["market", "limit", "stop", "stop_limit"] : ["market", "limit"], tifs: ["gtc", "day"], tifsByType: { market: ["day"], limit: ["gtc", "day"], stop: ["gtc", "day"], stop_limit: ["gtc", "day"] }, sellsReduce: true };
  };
  const market = async (symbol: string): Promise<Market | Refusal> => {
    const sym = symbol.trim().toUpperCase();
    if (!TICKER.test(sym)) return badOrder(req.venue, name, `"${symbol}" is not a stock symbol`);
    return withTools(async (t) => {
      const acct = await accountFor(t);
      const q = quoteIn(await t.call("get_equity_quotes", { symbols: [sym] }), sym);
      const tr = acct && t.offered.has("get_equity_tradability") ? tradabilityIn(await t.call("get_equity_tradability", { account_number: acct.number, symbols: [sym] }), sym) : undefined;
      if (!q && !tr) return badOrder(req.venue, name, `Robinhood has no stock ${sym}`);
      return stockOf(sym, q, tr, takesStops(t));
    });
  };
  /** search answers per query; each kept five minutes */
  const searched = new Map<string, { at: number; list: Array<{ symbol: string; name: string }> }>();
  const markets = (query: string): Promise<Market[] | Refusal> =>
    withTools(async (t) => {
      const q = query.trim();
      const key = q.toUpperCase();
      const bySearch = q !== "" && t.offered.has("search");
      let kept = searched.get(key);
      if (!kept || clock() - kept.at >= FIVE_MIN) {
        let list = STOCKS_FIRST;
        if (bySearch) {
          const d = await t.call("search", { query: q, asset_type: "instrument", limit: 20 });
          list = (Array.isArray(d.results) ? d.results : [])
            .filter((r: { symbol?: unknown } | null) => typeof r?.symbol === "string" && TICKER.test(r.symbol.toUpperCase()))
            .map((r: { symbol: string; simple_name?: unknown; name?: unknown }) => ({ symbol: r.symbol.toUpperCase(), name: String(r.simple_name ?? r.name ?? r.symbol) }));
        } else if (TICKER.test(key) && !STOCKS_FIRST.some((s) => s.symbol === key)) list = [{ symbol: key, name: key }, ...STOCKS_FIRST];
        kept = { at: clock(), list };
        searched.set(key, kept);
      }
      // Robinhood's search ranks its own answers; the list this starts from is picked from
      const found = bySearch ? kept.list.slice(0, 20) : pickMarkets(kept.list, q);
      let quotes: Record<string, unknown> | undefined;
      try {
        quotes = found.length ? await t.call("get_equity_quotes", { symbols: found.map((m) => m.symbol) }) : undefined;
      } catch {
        // a list without prices is still a list
        quotes = undefined;
      }
      return found.map((m) => ({ ...stockOf(m.symbol, quotes ? quoteIn(quotes, m.symbol) : undefined, undefined, takesStops(t)), name: m.name }));
    });
  const place = async (o: OrderRequest): Promise<OrderState | Refusal> => {
    const sym = o.symbol.trim().toUpperCase();
    if (!TICKER.test(sym)) return badOrder(req.venue, name, `"${o.symbol}" is not a stock symbol`);
    // what place_equity_order cannot carry is said before Robinhood is asked: its types are market, limit, stop_market and stop_limit, its
    // time_in_force gfd or gtc (a market order gfd only, as Robinhood's "Order types" says), and it has no post-only or reduce-only flag
    if (!ORDER_TYPES.includes(o.type)) return badOrder(req.venue, name, `Robinhood takes market, limit, stop and stop-limit orders, not ${String(o.type)} orders`);
    if (o.postOnly || o.reduceOnly) return badOrder(req.venue, name, "Robinhood's stock orders have no post-only or reduce-only flag");
    if (o.tif !== undefined && o.tif !== "gtc" && o.tif !== "day") return badOrder(req.venue, name, `Robinhood's stock orders are good for the day or good till canceled, never ${o.tif}`);
    if (o.type === "market" && o.tif === "gtc") return badOrder(req.venue, name, "a market order at Robinhood is good for the day only");
    if (!(o.qty > 0) || !onStep(o.qty, 0.000001)) return badOrder(req.venue, name, "a size at Robinhood is shares, to six decimal places at most");
    const limited = o.type === "limit" || o.type === "stop_limit";
    const stopped = o.type === "stop" || o.type === "stop_limit";
    const words = o.type === "stop_limit" ? "a stop-limit order" : `a ${o.type} order`;
    // a fraction of a share goes "only on type=market with market_hours=regular_hours" (place_equity_order's own rule)
    if (o.type !== "market" && !onStep(o.qty, 1)) return badOrder(req.venue, name, `Robinhood takes a fraction of a share only in a market order: ${words} is whole shares`);
    if (limited && !(o.limitPrice !== undefined && Number.isFinite(o.limitPrice) && o.limitPrice > 0)) return badOrder(req.venue, name, `${words} has a limit price`);
    // the US tick of the price itself: a price off it is refused here, never rounded (a rounded-up buy would pay more than was signed, a
    // rounded trigger fires at another price than the one signed)
    const tick = (x: number) => (x < 1 ? 0.0001 : 0.01);
    if (limited && !onStep(o.limitPrice!, tick(o.limitPrice!))) return badOrder(req.venue, name, "a limit price at Robinhood is in cents (in hundredths of a cent under $1)");
    if (stopped && !(o.stopPrice !== undefined && Number.isFinite(o.stopPrice) && o.stopPrice > 0)) return badOrder(req.venue, name, `${words} has a stop price`);
    if (stopped && !onStep(o.stopPrice!, tick(o.stopPrice!))) return badOrder(req.venue, name, "a stop price at Robinhood is in cents (in hundredths of a cent under $1)");
    // A market order with a worst price goes as a marketable limit at it, as Robinhood's own tool advises for price protection, and a stop
    // with one as a stop-limit at it (a buy's rounded down, a sell's up): it never fills past it. A fraction of a share goes only as a plain
    // market order, so it cannot be held there
    const bounds = o.type === "market" || o.type === "stop";
    if (bounds && o.worstPrice !== undefined) {
      if (!(Number.isFinite(o.worstPrice) && o.worstPrice > 0)) return badOrder(req.venue, name, `${words}'s worst price is a price more than zero`);
      if (!onStep(o.qty, 1)) return badOrder(req.venue, name, "Robinhood takes a fraction of a share only as a plain market order, which cannot be held to a worst price: order whole shares");
    }
    const bound = bounds && o.worstPrice !== undefined ? (o.side === "buy" ? floorTo(o.worstPrice, tick(o.worstPrice)) : ceilTo(o.worstPrice, tick(o.worstPrice))) : undefined;
    if (bound !== undefined && !(bound > 0)) return badOrder(req.venue, name, `${words}'s worst price is under the smallest tick`);
    const limitPrice = limited ? o.limitPrice! : bound;
    const stopPrice = stopped ? o.stopPrice! : undefined;
    return withTools(async (t) => {
      const acct = await accountFor(t);
      if (!acct) return noAgentic();
      // place_equity_order as its schema has it: shares; Robinhood's type; the regular session, the only one a market or stop order may be
      // tagged to (a limit could go to another, which the account does not choose); good for the day, the tool's default, unless good till
      // canceled was chosen; and ref_id — Robinhood keeps one order per ref_id
      const price = (x: number) => x.toFixed(x < 1 ? 4 : 2);
      const args: Record<string, unknown> = {
        account_number: acct.number,
        symbol: sym,
        side: o.side,
        type: stopPrice === undefined ? (limitPrice === undefined ? "market" : "limit") : limitPrice === undefined ? "stop_market" : "stop_limit",
        quantity: plain(o.qty, 6),
        ...(limitPrice !== undefined ? { limit_price: price(limitPrice) } : {}),
        ...(stopPrice !== undefined ? { stop_price: price(stopPrice) } : {}),
        time_in_force: o.tif === "gtc" ? "gtc" : "gfd",
        market_hours: "regular_hours",
        ref_id: uuidFrom(`${ROBINHOOD_MCP}/${acct.number}/${o.clientId}`),
      };
      let d: Record<string, unknown>;
      try {
        d = await t.call("place_equity_order", args);
      } catch (err) {
        // a call that did not come back is made once more with the same ref_id, which Robinhood dedupes by
        if (!(isRefusal(err) && lostCalls.has(err))) throw err;
        d = await t.call("place_equity_order", args);
      }
      if (d.approval && !d.order) return no("E_VENUE_REJECTED", { venue: req.venue, message: `${name} holds this order for your approval in its app (trade approvals are on for the Agentic account): nothing was placed from here, and an order approved there is not followed here`, native: { approval: { ...(d.approval as Record<string, unknown>), ...(typeof (d.approval as { account_number?: unknown }).account_number === "string" ? { account_number: tail4((d.approval as { account_number: string }).account_number) } : {}) } } });
      return isOrder(d.order) ? equityState(d.order) : no("E_VENUE_REJECTED", { venue: req.venue, message: `${name} answered without an order: nothing is known to be placed`, native: { keys: shapeOf(d) } });
    });
  };
  const orderIn = (d: Record<string, unknown>, ref: string) => (Array.isArray(d.orders) ? d.orders : []).find((x: unknown) => isOrder(x) && x.id === ref) as Record<string, unknown> | undefined;
  const status = async (ref: string): Promise<OrderState | Refusal> => {
    if (!UUID.test(ref)) return unknownOrder(ref);
    return withTools(async (t) => {
      const acct = await accountFor(t);
      if (!acct) return noAgentic();
      const hit = orderIn(await t.call("get_equity_orders", { account_number: acct.number, order_id: ref }, ref), ref);
      return hit ? equityState(hit) : unknownOrder(ref);
    });
  };
  const cancel = async (ref: string): Promise<OrderState | Refusal> => {
    if (!UUID.test(ref)) return unknownOrder(ref);
    return withTools(async (t) => {
      const acct = await accountFor(t);
      if (!acct) return noAgentic();
      const d = await t.call("cancel_equity_order", { account_number: acct.number, order_id: ref }, ref);
      if (d.accepted !== true) return no("E_VENUE_REJECTED", { venue: req.venue, message: `${name} did not take the cancel of ${ref}`, native: d });
      // a cancel is a request: the order is asked again and comes back as it stands (pending_cancelled until Robinhood confirms it)
      const hit = orderIn(await t.call("get_equity_orders", { account_number: acct.number, order_id: ref }, ref), ref);
      return hit ? equityState(hit) : unknownOrder(ref);
    });
  };
  /** the cursor in a page's `next`: get_equity_positions says to "pass the cursor query param from the prior response's next URL" */
  const cursorIn = (next: unknown): string | undefined => {
    if (typeof next !== "string" || !next) return undefined;
    try {
      return new URL(next).searchParams.get("cursor") || undefined;
    } catch {
      return undefined;
    }
  };
  /** What the Agentic account holds, the one account an order from here can change (every account's holdings come with the read): its
   * get_equity_positions — symbol, quantity ("negative for short positions"), average_buy_price, a page at a time, five pages at most — priced
   * by get_equity_quotes in one call, since "No market price here — for current value or PnL, call get_equity_quotes and multiply by
   * quantity". Robinhood's tools have no call that closes a position, nor one that changes an order in place: a sell is placed, an order
   * canceled. */
  const positions = (): Promise<Position[] | Refusal> =>
    withTools(async (t) => {
      const acct = await accountFor(t);
      if (!acct) return noAgentic();
      const props = t.offered.get("get_equity_positions")?.inputSchema?.properties;
      const rows: Array<Record<string, unknown>> = [];
      let cursor: string | undefined;
      for (let page = 0; page < 5; page++) {
        const d = await t.call("get_equity_positions", { account_number: acct.number, ...(cursor ? { cursor } : {}) });
        for (const x of Array.isArray(d.positions) ? d.positions : []) if (x && typeof x === "object") rows.push(x as Record<string, unknown>);
        cursor = !props || "cursor" in props ? cursorIn(d.next) : undefined;
        if (!cursor) break;
      }
      const held = rows.map((p) => ({ p, symbol: String(p.symbol ?? "").toUpperCase(), q: num(p.quantity) })).filter((x) => TICKER.test(x.symbol) && x.q !== 0);
      let quotes: Record<string, unknown> | undefined;
      try {
        quotes = held.length ? await t.call("get_equity_quotes", { symbols: [...new Set(held.map((x) => x.symbol))] }) : undefined;
      } catch {
        // positions without a price are still positions
        quotes = undefined;
      }
      return held.map(({ p, symbol, q }): Position => {
        const quote = quotes ? quoteIn(quotes, symbol) : undefined;
        const mark = quote ? lastOf(quote) : undefined;
        const entry = num(p.average_buy_price);
        // a short's quantity is negative: what it is worth, and what it has made, carry the sign
        return {
          symbol,
          name: symbol,
          kind: "stock",
          side: q < 0 ? "short" : "long",
          qty: Math.abs(q),
          ...(entry > 0 ? { entryPrice: entry } : {}),
          ...(mark !== undefined ? { markPrice: mark, usd: q * mark } : {}),
          ...(mark !== undefined && entry > 0 ? { unrealizedUsd: q * (mark - entry) } : {}),
          native: { ...p, ...(typeof p.account_number === "string" ? { account_number: tail4(p.account_number) } : {}) },
        };
      });
    });
  const trader: LiveTrader = {
    // get_accounts marks the one account this agent may trade in agentic_allowed: none marked is no; accounts that do not say are unknown
    get can() {
      return agentic ? true : agenticSeen ? false : "unknown";
    },
    get whyNot() {
      return !agentic && agenticSeen ? NO_AGENTIC : undefined;
    },
    what: "US stocks and ETFs, in the Robinhood Agentic account",
    markets,
    market,
    place,
    cancel: (ref) => cancel(ref),
    status: (ref) => status(ref),
    positions,
  };
  try {
    const first = await read();
    const missing = TRADE_TOOLS.filter((t) => !offered.includes(t));
    const source: LiveSource = {
      name,
      kind: "broker",
      reference: "signed in at Robinhood",
      via: "Robinhood's MCP server · Robinhood's own sign-in",
      probe: {
        can: ["read every Robinhood account", "trade in the Agentic account"],
        note: `reading calls ${READ_TOOLS.join(", ")} and nothing else — never review_equity_order, place_equity_order or cancel_equity_order${offered.length ? ` (Robinhood offered ${offered.length} tools)` : ""} · ${missing.length ? "no order is placed from here" : `an order the account places calls ${TRADE_TOOLS.join(", ")}, in the Agentic account${agentic ? ` ${tail4(agentic.number)}` : ""} and no other`}`,
        native: { server: ROBINHOOD_MCP, offered, called: READ_TOOLS, ...(missing.length ? {} : { orders: [...TRADE_TOOLS, ...MORE_TOOLS.filter((t) => offered.includes(t))] }) },
      },
      read,
      readOnlyBecause: "Robinhood moves money in and out only in its own app; through its MCP server an agent trades in the Agentic account and nothing else",
      ...(missing.length ? { noTradeBecause: `Robinhood's MCP server did not offer ${missing.join(", ")}: no order is placed there from here` } : { trader }),
    };
    return { source, first };
  } catch (err) {
    return asRefusal(req.venue, name, isRefusal(err) ? err : new Error(redact(String((err as Error)?.message ?? err), [tokenSeen])), [tokenSeen]);
  }
}
