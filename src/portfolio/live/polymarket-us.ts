/** A POLYMARKET US account — QCX LLC d/b/a Polymarket US, a CFTC-designated contract market, cleared by QC Clearing LLC (Polymarket
 * Clearing) — read and traded through its own API (docs.polymarket.us, read 2026-10-08: api-reference/introduction, authentication,
 * rate-limits, orders/overview, orders/create-order, portfolio/overview, account/get-account-balances, market/overview, price-history, the
 * OpenAPI schemas behind them, concepts/orders, market-structure/collateral-and-margin, faqs/general-faqs).
 *
 * It is not polymarket.com. Polymarket's international exchange — the Polygon CLOB, live:polymarket-trade (polymarket-clob.ts) — is a
 * separate exchange with its own rules; Polymarket US is "Fiat-based, CFTC-regulated exchange. Trades in USD. Built for US residents" (its
 * docs), with its own accounts, its own dollars and its own API. Nothing is shared between the two connections.
 *
 * Signed, at api.polymarket.us — the authenticated API "to trade":
 *
 *   GET  /v1/account/balances          {balances: [{currentBalance, buyingPower, currency, …}]}: the cash, and what it may buy now
 *   GET  /v1/portfolio/positions       {positions: {<market slug>: {netPositionDecimal, cost, qtyAvailableDecimal, …}}, nextCursor, eof}: a MAP
 *                                      of slug to position, a hundred to a page ("follow the nextCursor value … until the response returns
 *                                      eof: true", changelog 2026-06-24)
 *   POST /v1/orders                    one order: {id, executions?} — the executions only when it was sent synchronous
 *   GET  /v1/order/{orderId}           {order}: what became of it
 *   POST /v1/order/{orderId}/cancel    {marketSlug}: answered empty
 *   GET  /v1/orders/open               {orders}: what rests on the book now (all of the account's: it is filtered here)
 *
 * Public, at gateway.polymarket.us — "No API key needed" (introduction.md); nothing is signed for these, and no key goes there:
 *
 *   GET /v1/market/slug/{slug}         one market: its sides, its best bid and ask (the YES leg's), its tick, its smallest size, its status
 *   GET /v1/markets/{slug}/bbo         its top of book now: best bid and ask, the last trade, the book's state
 *   GET /v1/markets?slug=…&slug=…      the held markets, of any status, for what a position is worth now
 *   GET /v1/markets?active=true&closed=false&categories=<c>&orderBy=volume&orderDirection=desc&limit=   a category's most traded open markets
 *   GET /v1/markets/{slug}/settlement  a resolved market's settlement: 1 (YES won) or 0
 *   GET /v1/search?query=              the events matching some words, each with its markets
 *   GET /v1/price-history?symbol=      "book-derived Yes and No display prices for one market"
 *
 * The gateway's answers, checked live and keyless on 2026-10-08 (their shapes only; nothing here is about who Polymarket US serves):
 *   · a market: {id, slug, question (the event's words), title (this market's: "Los Angeles Dodgers", "Before January 2027"), category
 *     ("politics", "finance", "crypto", "sports" …), status ("MARKET_STATUS_OPEN" …), active, closed, endDate, orderPriceMinTickSize (0.001,
 *     0.005 or 0.01), minimumTradeQty (1, or 0.01 for a partial-contract market), bestBidQuote and bestAskQuote ({value: "0.6020", currency:
 *     "USD"}, the YES leg's — a side with no order is absent), marketSides ([{long: true, description: "Yes", price, tradable}, {long:
 *     false, description: "No", …}]), outcomes and outcomePrices (JSON strings — which do NOT follow one order: ["No","Yes"] beside
 *     ["0.6030","0.398"], YES's price first, so they are not read)}. No volume figure in any list, though `orderBy=volume` orders by one
 *   · a BBO: {marketData: {marketSlug, bestBid, bestAsk, lastTradePx, currentPx (the middle), settlementPx (the DAILY settlement — a price,
 *     not a result: 0.40 on a market still trading), sharesTraded (since listing, not a day), state ("MARKET_STATE_OPEN" …)}}
 *   · a book: {marketData: {bids: [{px: {value}, qty}], offers: […], state, stats: {lastTradePx, openPx, highPx, …}, transactTime}}
 *   · a settlement: {"slug": …, "settlement": 1}; a market not settled: HTTP 404 {"code": 5, "message": "Settlement not found for market …"}
 *   · a market it does not list: HTTP 404 {"code": 5, "message": "The server was unable to process your request.", "details": []}
 *   · a search: {events: [{slug, title, category, markets: [<markets as above>]}]}; a price history: {history: [{timestamp (seconds),
 *     longPrice, shortPrice}]}, and {history: []} for a symbol it does not know
 *
 * SIGNING (authentication.md): three headers — X-PM-Access-Key (the Key ID), X-PM-Timestamp (milliseconds; "Timestamps must be within 30
 * seconds of server time") and X-PM-Signature, base64 of an Ed25519 signature over the UTF-8 of `${timestamp}${METHOD}${path}`, made with "the
 * first 32 bytes of the base64-decoded secret" (its Python: `base64.b64decode("YOUR_SECRET_KEY")[:32]`). The docs' one example signs a path
 * with no query (GET /v1/portfolio/positions) and do not say whether a query is part of the path: it is signed here without one, as Kalshi's
 * is, and the signed reads ask without a query wherever the API lets them (a page of positions after the first is the one place it does
 * not). The secret is read from the key file in this process and used for nothing but these signatures.
 *
 * WHAT AN ORDER IS (orders/overview.md): "Only the long side (YES) is directly tradable. The short side (NO) is synthetic exposure created
 * through positions in the long side. The `price.value` field always represents the long side's price" — so a NO order at X goes with
 * price.value 1 − X and the intent ORDER_INTENT_BUY_SHORT or ORDER_INTENT_SELL_SHORT, and a NO held is the account's short of the YES
 * contract. Prices are "between 0.01 and 0.99 (the exchange's absolute price limits)", on the market's own tick; sizes are in contracts, on
 * its minimumTradeQty. There is no client order id, no reduce-only flag and no stop order on the retail create.
 *
 * MONEY: "Sellers (Short Positions) · Receive the contract price as proceeds · Post $1.00 margin per contract (full payout value) · Fiat
 * balance increases by sale proceeds" (collateral-and-margin.md). A NO bought at 0.40 is a YES sold at 0.60: the balance (currentBalance,
 * "Current fiat currency balance, not including security values") rises by 0.60 while $1.00 is held, and buying power falls by 0.40. So the
 * cash this account shows is the balance less $1.00 for each NO contract held, and each NO is worth its own price: the two together are
 * the balance plus every position at its price, which is what the account is worth. Polymarket US's API has no call that moves money in
 * or out: deposits and withdrawals are made in its app.
 */
import { sign as cryptoSign, type KeyObject } from "node:crypto";
import { keyFromSeed } from "../../core/ed25519.ts";
import { isRefusal, type Refusal } from "../../core/errors.ts";
import { no } from "../refuse.ts";
import { categoryOf } from "./categories.ts";
import type { KeyFile, KeyShape } from "./credentials.ts";
import { badOrder, onStep, plain, type Candle, type CandleInterval, type LiveTrader, type Market, type OrderRequest, type OrderState, type OrderStatus, type Position, type TimeInForce } from "./trade.ts";
import { asRefusal, edgeRefused, edgeWords, notTheApi, notTheApiWords, num, redact, REGION, unreachable, type Http, type HttpReply, type LiveBalance, type LiveSource } from "./types.ts";

export const POLYMARKET_US_KEY: KeyShape = {
  required: ["keyId", "secretKey"],
  example: '{"keyId": "…", "secretKey": "…"} — the Key ID and the Secret Key polymarket.us/developer gives when the key is made (the Secret Key is shown once)',
};

export const PMUS_API = "https://api.polymarket.us";
export const PMUS_GATEWAY = "https://gateway.polymarket.us";
/** Polymarket US's own category words, as its gateway filed its open markets on 2026-10-08 (sports, politics, culture, finance, geopolitics,
 * technology, macro, crypto), less the two the account's lists leave out (categories.ts: sports and culture): the categories whose most
 * traded markets are offered to start from */
export const PMUS_CATEGORIES: readonly string[] = ["politics", "finance", "crypto", "macro", "geopolitics", "technology"];
/** how many markets of each category are read to start from */
export const PMUS_PER_CATEGORY = 6;

type Rec = Record<string, unknown>;
type Outcome = "YES" | "NO";
type Call = (method: "GET" | "POST", path: string, body?: unknown) => Promise<HttpReply>;
/** a GET at the gateway, by path: the body as it came, or the venue's refusal */
export type PmusGet = (path: string) => Promise<unknown>;

/** prices in millionths of a dollar, so a tick of 0.001, 0.005 or 0.01 is checked in integers and never off by float dust */
const SCALE = 1_000_000;
/** "Orders must have price.value between 0.01 and 0.99 (the exchange's absolute price limits)" */
const MIN_U = 10_000;
const MAX_U = 990_000;
const LIST_MS = 60_000;
/** a look at a market this recent is the one the account just valued an order at: a market order is sent at that price, not a newer one */
const FRESH_MS = 30_000;
/** a synchronous order waits at most this long at Polymarket US for its final state ("up to maxBlockTime seconds"); the latency stopgap
 * turns away any order not processed within five seconds anyway */
const MAX_BLOCK = "5";
/** a day order this close to its end would end before it rests */
const DAY_MARGIN_MS = 10_000;

const enc = encodeURIComponent;
const round = (x: number, places = 6): number => Number(x.toFixed(places));
const isRec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);
const rec = (v: unknown): Rec => (isRec(v) ? v : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);
const fin = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};
/** an Amount, {value: "0.55", currency: "USD"}, as a number; nothing when it is absent or null */
const amountOf = (v: unknown): number | undefined => (isRec(v) ? fin(v.value) : undefined);
/** an event contract's price: more than 0 and less than 1 */
const px = (v: number | undefined): number | undefined => (v !== undefined && v > 0 && v < 1 ? v : undefined);
const mid = (bid: number | undefined, ask: number | undefined): number | undefined => (bid !== undefined && ask !== undefined && ask >= bid ? round((bid + ask) / 2) : undefined);
const toU = (x: number): number => Math.round(x * SCALE);
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** `tec-mlb-nlchamp-2026-09-27-lad:YES` → the market's slug and the outcome: the names this connection gives markets and positions */
export function pmusParse(symbol: string): { slug: string; outcome: Outcome } | undefined {
  const m = /^([a-z0-9][a-z0-9._-]{0,159}):(yes|no)$/i.exec(String(symbol ?? "").trim());
  return m ? { slug: m[1]!.toLowerCase(), outcome: m[2]!.toUpperCase() as Outcome } : undefined;
}

// ---- signing ------------------------------------------------------------------------------------------

/** The Ed25519 key a Polymarket US Secret Key holds: the first 32 bytes of its base64 (authentication.md), as the seed of the key that signs
 * (core/ed25519.ts keyFromSeed: the seed in its PKCS#8 wrapping). Nothing when the text is not base64 of at least 32 bytes */
export function polymarketUsKey(secretKey: string): KeyObject | undefined {
  const s = String(secretKey ?? "").trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return undefined;
  const raw = Buffer.from(s, "base64");
  if (raw.length < 32) return undefined;
  try {
    return keyFromSeed(raw.subarray(0, 32).toString("hex")).privateKey;
  } catch {
    return undefined;
  }
}

/** the signature Polymarket US expects for one request, base64: Ed25519 over `${timestamp}${METHOD}${path}`, the path without its query */
export function polymarketUsSign(key: KeyObject, timestampMs: number, method: string, path: string): string {
  return cryptoSign(null, Buffer.from(`${timestampMs}${method.toUpperCase()}${path.split("?")[0]}`, "utf8"), key).toString("base64");
}

// ---- Polymarket US's no, in its own words -------------------------------------------------------------------

/** how Polymarket US might say "not from where you are", beyond the shared REGION words: a state, a location or a geofence. Phrases about
 * the user's place only: a bare "state" is as often an account's or an order's ("account state is not ACTIVE") */
const PMUS_REGION = /(?:not|isn't) (available|permitted|allowed|supported|offered) (in|from|to|for) (your|this) (state|region|location|area|jurisdiction|country)|restricted (state|location|jurisdiction|region|area)|(?:ineligible|unsupported) (?:jurisdiction|location|region)|geo-?(fenc|locat|block|restrict)/i;
/** the venue's words with any market slug it repeats taken out ("market 'geo-blocked-countries-2026' is closed" names a market, not where
 * the account is), for the place words to be read in */
const unslugged = (s: string): string => s.replace(/\b[a-z0-9]+(?:-[a-z0-9]+){2,}\b/gi, " ");
/** the latency stopgap: "These rejects carry the message Global Rate Limit Exceeded, but they are not an actual rate limit" (rate-limits.md) */
const STOPGAP = /global rate limit exceeded/i;
const INSUFFICIENT = /insufficient|buying power|not enough (funds|balance|cash|collateral)/i;
const CLOSED = /exchange[_ ]closed|market (is )?(closed|halted|suspended|expired|not open)|not (currently )?(open|accepting orders)|trading (is )?(halted|suspended|paused|closed)|\b(halted|suspended)\b/i;

/** the venue's words in an answer: its JSON's message (the gateway answers {code, message, details}, a 429 {status, message}), else its
 * text — secrets out first, then one line of at most 220 characters */
function saidOf(r: HttpReply, secrets: string[]): { said: string; grpc?: number | undefined } {
  const b = isRec(r.body) ? r.body : {};
  const words = [b.message, b.error, b.msg].find((x): x is string => typeof x === "string" && x.trim() !== "") ?? r.text ?? "";
  const said = redact(String(words), secrets).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 220);
  return { said, ...(typeof b.code === "number" ? { grpc: b.code } : {}) };
}

/** Polymarket US's answer that is not a yes, as the account's refusal, with its words in `native`. Its documented statuses: 400 a bad
 * request, 401 a key it does not accept, 404 nothing there, 429 its edge's rate limit, 5xx (503 for every request during its weekly
 * maintenance, "Every Thursday, 6am–8am ET"); the gateway's bodies carry a gRPC code (5 not found, 7 permission denied, 16 unauthenticated).
 * The words decide where they say more than the status: a place, the latency stopgap, buying power, a closed market. A page answered with a
 * 2xx in its place is not Polymarket US speaking (no answer, and none of its words decide); a page from the server in front of it refusing
 * this network is that refusal, the same for every key — not this key's permission */
export function polymarketUsNo(venue: string, name: string, r: HttpReply, secrets: string[], order = false): Refusal {
  if (notTheApi(r)) return no("E_VENUE_UNREACHABLE", { venue, message: notTheApiWords(name), native: { status: r.status, page: true } });
  const { said, grpc } = saidOf(r, secrets);
  const native = { status: r.status, ...(grpc !== undefined ? { code: grpc } : {}), said };
  const quoted = said ? `: “${said}”` : "";
  // first, so that none of the page's words decide or travel: they may name the country
  if (edgeRefused(r.status, r.text)) return no("E_VENUE_GEOBLOCKED", { venue, message: edgeWords(name, r.status, r.text), native: { status: r.status, edge: true } });
  const place = unslugged(said);
  if (r.status === 451 || REGION.test(place) || PMUS_REGION.test(place)) return no("E_VENUE_GEOBLOCKED", { venue, message: `${name} does not take this from where this account is: that is its own rule, and the account does not look for a way around it`, native });
  if (STOPGAP.test(said)) return no("E_VENUE_REJECTED", { venue, message: `${name} turned the order away with its latency stopgap (“Global Rate Limit Exceeded”: not processed within five seconds, so not placed). Polymarket US says it is not a rate limit: it may be sent again`, native });
  if (r.status === 429) return no("E_VENUE_UNREACHABLE", { venue, message: `${name} is rate-limiting this machine: try again in a minute`, native });
  if (r.status === 401 || grpc === 16) return no("E_VENUE_UNAUTHORIZED", { venue, message: `${name} does not accept this key: its Key ID, its Secret Key, or this machine's clock (a timestamp more than 30 seconds from Polymarket US's is refused)${quoted}`, native });
  if (r.status === 503) return no("E_VENUE_UNREACHABLE", { venue, message: `${name} did not answer (HTTP 503): it answers every request so during its weekly maintenance, Thursdays 6–8am ET, and cancels every open order before it begins`, native });
  if (r.status >= 500 || r.status === 0) return no("E_VENUE_UNREACHABLE", { venue, message: `${name} did not answer`, native });
  if (r.status === 403 || grpc === 7) return no("E_VENUE_PERMISSION", { venue, message: `${name} refused: this key may not do this${quoted}`, native });
  if (INSUFFICIENT.test(said)) return no("E_VENUE_INSUFFICIENT", { venue, message: `${name}: not enough buying power for this order${quoted}`, native });
  if (CLOSED.test(said)) return no("E_VENUE_MARKET_CLOSED", { venue, message: `${name}: the market takes no orders now${quoted}`, native });
  if (order && (r.status === 400 || r.status === 422 || grpc === 3 || grpc === 9)) return no("E_VENUE_ORDER_INVALID", { venue, message: `${name}: it does not take this order as written${quoted}`, native });
  return no("E_VENUE_REJECTED", { venue, message: `${name} refused the request (HTTP ${r.status})${quoted}`, native });
}

/** an order Polymarket US rejected (a synchronous order's EXECUTION_TYPE_REJECTED), by its documented reason, with its words */
function rejectedNo(venue: string, name: string, e: Rec, id: string, secrets: string[]): Refusal {
  const reason = String(e.orderRejectReason ?? "");
  const text = redact(String(e.text ?? ""), secrets).replace(/\s+/g, " ").trim().slice(0, 220);
  const native = { orderId: id, orderRejectReason: reason || undefined, text: text || undefined };
  const words = text ? ` (“${text}”)` : "";
  if (REGION.test(unslugged(text)) || PMUS_REGION.test(unslugged(text))) return no("E_VENUE_GEOBLOCKED", { venue, message: `${name} does not take this order from where this account is: that is its own rule, and the account does not look for a way around it`, native });
  if (STOPGAP.test(text)) return no("E_VENUE_REJECTED", { venue, message: `${name} turned the order away with its latency stopgap (“Global Rate Limit Exceeded”: not processed within five seconds, so not placed). Polymarket US says it is not a rate limit: it may be sent again`, native });
  if (reason === "ORD_REJECT_REASON_EXCHANGE_CLOSED" || CLOSED.test(text)) return no("E_VENUE_MARKET_CLOSED", { venue, message: `${name} rejected the order: “Exchange/market is closed”${words}`, native });
  if (INSUFFICIENT.test(text)) return no("E_VENUE_INSUFFICIENT", { venue, message: `${name} rejected the order: not enough buying power${words}`, native });
  const asWritten: Record<string, string> = {
    ORD_REJECT_REASON_INCORRECT_QUANTITY: "“Invalid quantity”",
    ORD_REJECT_REASON_INVALID_PRICE_INCREMENT: "“Price not on valid increment”",
    ORD_REJECT_REASON_INCORRECT_ORDER_TYPE: "“Invalid order type for market”",
    ORD_REJECT_REASON_PRICE_OUT_OF_BOUNDS: "“Price outside valid range”",
  };
  if (asWritten[reason]) return no("E_VENUE_ORDER_INVALID", { venue, message: `${name}: it rejected the order: ${asWritten[reason]}${words}`, native });
  if (reason === "ORD_REJECT_REASON_UNKNOWN_MARKET") return no("E_VENUE_REJECTED", { venue, message: `${name} rejected the order: “Unknown or invalid market”${words}`, native });
  if (reason === "ORD_REJECT_REASON_NO_LIQUIDITY") return no("E_VENUE_REJECTED", { venue, message: `${name} rejected the order: “No liquidity for market order”${words}`, native });
  return no("E_VENUE_REJECTED", { venue, message: `${name} rejected the order${words}`, native });
}

// ---- a market, in the account's terms ----------------------------------------------------------------

const STATUS_WORDS: Record<string, string> = {
  MARKET_STATUS_CLOSED: "closed",
  MARKET_STATUS_RESOLVING: "past its expiry, its settlement not published yet",
  MARKET_STATUS_RESOLVED: "settled",
  MARKET_STATUS_HALTED: "Polymarket US has halted it",
  MARKET_STATUS_UNSPECIFIED: "not open for orders yet",
};
const STATE_WORDS: Record<string, string> = {
  MARKET_STATE_PREOPEN: "not open for orders yet (pre-open)",
  MARKET_STATE_SUSPENDED: "Polymarket US has suspended trading in it now (its weekly maintenance is Thursdays 6–8am ET)",
  MARKET_STATE_HALTED: "Polymarket US has halted trading in it",
  MARKET_STATE_EXPIRED: "expired",
  MARKET_STATE_TERMINATED: "terminated",
  MARKET_STATE_MATCH_AND_CLOSE_AUCTION: "in its closing auction",
};

const slugOf = (m: Rec): string => String(m.slug ?? "").toLowerCase();
/** a market in words: the event's question and this market's own title ("When will Bitcoin hit $150k? — Before January 2027") */
function wordsOf(m: Rec): string {
  const q = str(m.question);
  const t = str(m.title);
  return q && t && t !== q ? `${q} — ${t}` : (q ?? t ?? slugOf(m));
}
/** a market that takes orders by its own listing: open, active, not closed, its YES side tradable */
export const pmusTradable = (m: Rec): boolean => typeof m.slug === "string" && m.slug !== "" && m.status === "MARKET_STATUS_OPEN" && m.active !== false && m.closed !== true && !list(m.marketSides).some((s) => isRec(s) && s.long === true && s.tradable === false);

/** One Polymarket US market as the account's market for one of its outcomes. The book is the YES contract's: NO's bid is 1 − YES's ask and
 * NO's ask 1 − YES's bid. `lite` is the market's BBO when it was read (marketData): the freshest book, its last trade, its state. The
 * venue's category is kept in its own words, title-cased (categories.ts). No volume or 24-hour change is said: the gateway gives neither
 * (sharesTraded counts since listing) */
export function pmusMarket(m: Rec, outcome: Outcome, lite?: Rec): Market {
  const slug = slugOf(m);
  const yes = outcome === "YES";
  // the BBO when it was read is the book now: a side it shows empty (null) is empty, whatever the listing's quote said
  const yb = px(amountOf(lite ? lite.bestBid : m.bestBidQuote));
  const ya = px(amountOf(lite ? lite.bestAsk : m.bestAskQuote));
  const lastYes = px(amountOf(lite?.lastTradePx));
  const bid = yes ? yb : ya === undefined ? undefined : round(1 - ya);
  const ask = yes ? ya : yb === undefined ? undefined : round(1 - yb);
  const last = lastYes === undefined ? undefined : yes ? lastYes : round(1 - lastYes);
  const price = last ?? mid(bid, ask);
  const status = String(m.status ?? "");
  const state = lite ? str(lite.state) : undefined;
  const open = pmusTradable(m) && (state === undefined || state === "MARKET_STATE_OPEN");
  const words = wordsOf(m);
  const end = str(m.endDate);
  const why = status !== "MARKET_STATUS_OPEN" ? (STATUS_WORDS[status] ?? `its status at Polymarket US is ${status || "unknown"}`) : state && state !== "MARKET_STATE_OPEN" ? (STATE_WORDS[state] ?? `its book is ${state}`) : m.active === false || m.closed === true ? "Polymarket US lists it as not active" : open ? "" : "its YES side does not trade now";
  const note = open ? (end ? `ends ${end.replace("T", " ").replace(/:\d\d(\.\d+)?Z$/, " UTC")}` : "") : why;
  const tick = fin(m.orderPriceMinTickSize);
  const priceStep = tick !== undefined && tick > 0 ? tick : 0.01;
  const lot = fin(m.minimumTradeQty);
  const qtyStep = lot !== undefined && lot > 0 ? lot : 1;
  const category = categoryOf([str(m.category)]);
  // What its create takes in every market: limit and market orders (the account's market order goes as a limit at its worst price that
  // fills at once), good-till-canceled, immediate-or-cancel, fill-or-kill, and a day order as good-till-date at the trade day's end;
  // post-only (participateDontInitiate). A sell is held to what is held, so a plain sell closes a position (no reduce-only flag exists)
  return {
    symbol: `${slug}:${outcome}`,
    name: `${words} · ${yes ? "Yes" : "No"}`,
    kind: "event",
    base: `${slug}:${outcome}`,
    quote: "USD",
    price,
    bid,
    ask,
    minQty: qtyStep,
    qtyStep,
    priceStep,
    open,
    ...(note ? { note } : {}),
    types: ["market", "limit"],
    tifs: ["gtc", "ioc", "fok", "day"],
    tifsByType: { market: ["ioc", "fok"], limit: ["gtc", "ioc", "fok", "day"] },
    postOnly: true,
    sellsReduce: true,
    ...(end ? { closeTime: end } : {}),
    ...(category ? { category } : {}),
    group: { id: slug, title: words },
    outcome,
  };
}
/** a market as its two outcomes */
export const pmusLegs = (m: Rec, lite?: Rec): Market[] => [pmusMarket(m, "YES", lite), pmusMarket(m, "NO", lite)];

/** What a category's most traded open markets are, several categories in turn — each one's most traded, then each one's second … — one
 * GET each: GET /v1/markets?active=true&closed=false&categories=&orderBy=volume&orderDirection=desc (Polymarket US gives no volume figure,
 * and orders by its own when asked: `orderBy=volume` reorders the list, `volume24hr` and `volumeNum` do not — checked 2026-10-08).
 * `endMin`/`endMax` keep the markets that end within a window (endDateMin, endDateMax). A category that refuses is left out while the
 * others answer; only when every one refuses is the refusal the answer */
export async function pmusBusiest(get: PmusGet, o: { perCategory: number; categories?: readonly string[] | undefined; endMin?: string | undefined; endMax?: string | undefined }): Promise<Rec[] | Refusal> {
  const window = `${o.endMin ? `&endDateMin=${enc(o.endMin)}` : ""}${o.endMax ? `&endDateMax=${enc(o.endMax)}` : ""}`;
  const bodies = await Promise.all((o.categories ?? PMUS_CATEGORIES).map((c) => get(`/v1/markets?active=true&closed=false&categories=${enc(c)}&orderBy=volume&orderDirection=desc&limit=${o.perCategory}${window}`)));
  let refused: Refusal | undefined;
  const lists: Rec[][] = [];
  for (const b of bodies) {
    if (isRefusal(b)) refused ??= b;
    else lists.push(list(rec(b).markets).filter(isRec).filter(pmusTradable));
  }
  if (!lists.length && refused) return refused;
  const out = new Map<string, Rec>();
  for (let k = 0; k < o.perCategory; k++) for (const l of lists) if (l[k] && !out.has(slugOf(l[k]!))) out.set(slugOf(l[k]!), l[k]!);
  return [...out.values()];
}

/** Polymarket US's own search (GET /v1/search?query=&limit=: events, each with its markets), the open markets of what it finds — every
 * category, as the venue's search reaches every market */
export async function pmusSearch(get: PmusGet, q: string, events = 10): Promise<Rec[] | Refusal> {
  const body = await get(`/v1/search?query=${enc(q.trim().slice(0, 60))}&limit=${Math.min(20, Math.max(1, Math.floor(events)))}`);
  if (isRefusal(body)) return body;
  const out = new Map<string, Rec>();
  for (const ev of list(rec(body).events).filter(isRec)) for (const m of list(ev.markets).filter(isRec).filter(pmusTradable)) if (!out.has(slugOf(m))) out.set(slugOf(m), m);
  return [...out.values()];
}

const BAR_MS: Record<CandleInterval, number> = { "5m": 300_000, "1h": 3_600_000, "1d": 86_400_000 };
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** A market's price history: GET /v1/price-history?symbol=<slug>&fixedInterval=&fidelity= — "book-derived Yes and No display prices",
 * `longPrice` "normally derived from the best ask" and `shortPrice` "from one minus the best bid": the price each outcome could be bought at
 * then, not trades, so a bar has no volume. Its fixed profiles are five-minute points for a day (INTERVAL_1D, fidelity 5), minute points
 * for six hours (INTERVAL_6H, 1), three-hour points for a week or a month (INTERVAL_1W / INTERVAL_1M, 180) and all of it (INTERVAL_ALL, 180):
 * the one that covers the start asked is read, and its points folded into bars — first, highest, lowest, last */
export async function pmusCandles(get: PmusGet, venue: string, symbol: string, interval: CandleInterval, sinceMs: number, now: number): Promise<Candle[] | Refusal> {
  if (!Object.hasOwn(BAR_MS, interval)) return no("E_ACCOUNT_BAD_ACTION", { venue, message: `price history comes in bars of 5m, 1h or 1d, not "${String(interval).slice(0, 12)}"` });
  if (!(Number.isFinite(sinceMs) && sinceMs >= 0 && sinceMs < now)) return no("E_ACCOUNT_BAD_ACTION", { venue, message: "price history starts before now" });
  const s = pmusParse(symbol);
  if (!s) return no("E_ACCOUNT_BAD_ACTION", { venue, message: `a Polymarket US market here is <market slug>:YES or <market slug>:NO, not "${String(symbol).slice(0, 60)}"` });
  const span = now - sinceMs;
  const [profile, fidelity] = interval === "5m" ? ["INTERVAL_1D", 5] : interval === "1h" ? (span <= 6 * HOUR_MS ? ["INTERVAL_6H", 1] : span <= DAY_MS ? ["INTERVAL_1D", 5] : ["INTERVAL_1W", 180]) : span <= 30 * DAY_MS ? ["INTERVAL_1M", 180] : ["INTERVAL_ALL", 180];
  const body = await get(`/v1/price-history?symbol=${enc(s.slug)}&fixedInterval=${profile}&fidelity=${fidelity}`);
  if (isRefusal(body)) return body;
  const step = BAR_MS[interval];
  const bars = new Map<number, Candle>();
  const points = list(rec(body).history)
    .filter(isRec)
    .map((p) => ({ t: fin(p.timestamp), p: px(fin(s.outcome === "YES" ? p.longPrice : p.shortPrice)) }))
    .filter((p): p is { t: number; p: number } => p.t !== undefined && p.p !== undefined && p.t * 1000 >= sinceMs)
    .sort((a, b) => a.t - b.t);
  for (const { t, p } of points) {
    const at = Math.floor((t * 1000) / step) * step;
    const b = bars.get(at);
    if (!b) bars.set(at, { t: at, o: p, h: p, l: p, c: p });
    else {
      b.h = Math.max(b.h, p);
      b.l = Math.min(b.l, p);
      b.c = p;
    }
  }
  return [...bars.values()];
}

// ---- how long an order stays -----------------------------------------------------------------------------

/** the account's time in force as Polymarket US's create takes it. Its own DAY order is not sent: "DAY orders do not automatically cancel at
 * 5pm during trade day rolls … Please use GTD orders with the desired timestamp" (orders/overview.md, changelog 2026-09-13) — so a day order
 * goes as good-till-date at the trade day's end */
const TIF_WIRE: Record<TimeInForce, string> = { gtc: "TIME_IN_FORCE_GOOD_TILL_CANCEL", ioc: "TIME_IN_FORCE_IMMEDIATE_OR_CANCEL", fok: "TIME_IN_FORCE_FILL_OR_KILL", day: "TIME_IN_FORCE_GOOD_TILL_DATE" };
const PMUS_TIFS: TimeInForce[] = ["gtc", "ioc", "fok", "day"];
const INTENT: Record<Outcome, Record<"buy" | "sell", string>> = {
  YES: { buy: "ORDER_INTENT_BUY_LONG", sell: "ORDER_INTENT_SELL_LONG" },
  NO: { buy: "ORDER_INTENT_BUY_SHORT", sell: "ORDER_INTENT_SELL_SHORT" },
};

const ET = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23" });
/** New York's wall clock at an instant, written as if it were UTC */
function etWall(ms: number): { y: number; mo: number; d: number; wall: number } {
  const p: Record<string, number> = {};
  for (const x of ET.formatToParts(new Date(ms))) if (x.type !== "literal") p[x.type] = Number(x.value);
  return { y: p.year!, mo: p.month!, d: p.day!, wall: Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) };
}
/** 17:00 in New York on the day `days` after the one `nowMs` falls on there, New York's offset read at that moment itself */
function fivePm(nowMs: number, days: number): number {
  const today = etWall(nowMs);
  const target = Date.UTC(today.y, today.mo - 1, today.d + days, 17, 0, 0);
  const at = target - (today.wall - Math.floor(nowMs / 1000) * 1000);
  return target - (etWall(at).wall - at);
}
/** When a Polymarket US day order placed at `nowMs` ends, in milliseconds: its next trade day roll — "5pm" (orders/overview.md), seven days a
 * week (an instrument's trade_day_roll_schedule: every day, "time_of_day": "17:00:00"), in New York, as every other time Polymarket US
 * writes is ("5:00 PM ET") */
export function pmusDayEnd(nowMs: number): number {
  const today = fivePm(nowMs, 0);
  return today > nowMs ? today : fivePm(nowMs, 1);
}

/** what the retail create does not take, or not together, said before anything is sent */
function notTaken(order: OrderRequest, tif: TimeInForce): string | undefined {
  const market = order.type === "market";
  if (!market && order.type !== "limit") return `Polymarket US takes limit and market orders, not ${order.type === "stop_limit" ? "stop-limit" : String(order.type)} orders`;
  if (!PMUS_TIFS.includes(tif)) return `Polymarket US takes good-till-canceled, immediate-or-cancel, fill-or-kill and day orders, not "${String(tif).slice(0, 20)}"`;
  if (market && (tif === "gtc" || tif === "day")) return "a market order at Polymarket US is a limit at its worst price that fills at once (immediate-or-cancel), or all at once or not at all (fill-or-kill): one that rests on the book is a limit order";
  if (order.postOnly && market) return "post-only is for a limit order: a market order takes from the book";
  if (order.postOnly && (tif === "ioc" || tif === "fok")) return "a post-only order “must rest on the book prior to matching”: one that must fill at once never rests";
  if (order.reduceOnly) return "Polymarket US's order has no reduce-only flag: a sell here sells only what is held, which the account checks before it is sent";
  return undefined;
}

// ---- the source --------------------------------------------------------------------------------------

export interface PolymarketUsRequest {
  venue: string;
  label: string;
  reference: string;
  key: KeyFile;
  http: Http;
  /** the real clock, in milliseconds */
  clock: () => number;
}

/** a Polymarket US trader, with what rests on its book */
export type PolymarketUsTrader = LiveTrader & {
  /** the account's orders resting at Polymarket US now (GET /v1/orders/open), each with its market as this connection names it — all of them,
   * or one market's */
  openOrders(symbol?: string): Promise<Array<OrderState & { symbol: string; side: "buy" | "sell"; limitPrice?: number | undefined }> | Refusal>;
};

/** Polymarket US, connected: the key checked, then the balance and the positions read — and a trader. Polymarket US saying no to either is
 * the answer, in its words */
export async function polymarketUsSource(req: PolymarketUsRequest): Promise<{ source: LiveSource; first: LiveBalance[] } | Refusal> {
  const name = req.label || "Polymarket US";
  const venue = req.venue;
  const keyId = String(req.key.keyId ?? "").trim();
  const secretKey = String(req.key.secretKey ?? "").trim();
  if (!keyId || keyId.length > 200 || /\s/.test(keyId)) return no("E_ACCOUNT_CREDENTIAL", { venue, message: "Polymarket US's Key ID is the id polymarket.us/developer shows beside the key: one word, no spaces" });
  const key = polymarketUsKey(secretKey);
  if (!key) return no("E_ACCOUNT_CREDENTIAL", { venue, message: "Polymarket US's Secret Key is not the base64 text polymarket.us/developer gives when the key is made (it decodes to at least 32 bytes): copy it again, whole" });
  // every form of the secret this process holds stays out of every refusal: the text, and the bytes it decodes to
  const raw = Buffer.from(secretKey, "base64");
  const secrets = [secretKey, raw.toString("hex"), raw.subarray(0, 32).toString("hex"), raw.toString("base64url"), keyId];

  /** any signed request, its answer as it came: the caller reads the status, because a 200, a 400 and a 404 each mean something */
  const call: Call = async (method, path, body) => {
    const ts = req.clock();
    const headers: Record<string, string> = { "X-PM-Access-Key": keyId, "X-PM-Timestamp": String(ts), "X-PM-Signature": polymarketUsSign(key, ts, method, path), accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) };
    try {
      return await req.http(`${PMUS_API}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    } catch (err) {
      throw unreachable(venue, name, err, secrets);
    }
  };
  /** a signed GET that must answer: its body, or Polymarket US's no thrown */
  const signedGet = async (path: string): Promise<Rec> => {
    const r = await call("GET", path);
    if (r.status !== 200 || !isRec(r.body)) throw polymarketUsNo(venue, name, r, secrets);
    return r.body;
  };
  /** a GET at the public gateway, unsigned: the body, or Polymarket US's no (never thrown); lists kept `keepMs` */
  const kept = new Map<string, { at: number; body: unknown }>();
  const gw = async (path: string, keepMs = 0): Promise<unknown> => {
    const now = req.clock();
    const hit = keepMs > 0 ? kept.get(path) : undefined;
    if (hit && now - hit.at < keepMs) return hit.body;
    let r: HttpReply;
    try {
      r = await req.http(`${PMUS_GATEWAY}${path}`, { headers: { accept: "application/json" } });
    } catch (err) {
      return unreachable(venue, name, err, secrets);
    }
    if (r.status !== 200 || r.body === undefined) return polymarketUsNo(venue, name, r, secrets);
    if (keepMs > 0) {
      kept.set(path, { at: now, body: r.body });
      if (kept.size > 100) kept.delete(kept.keys().next().value!);
    }
    return r.body;
  };

  /** every position, a hundred to a page and not for ever: five pages. The first page is asked without a query (see SIGNING above) */
  const allPositions = async (): Promise<Map<string, Rec>> => {
    const out = new Map<string, Rec>();
    let cursor = "";
    for (let page = 0; page < 5; page++) {
      const body = await signedGet(`/v1/portfolio/positions${cursor ? `?cursor=${enc(cursor)}` : ""}`);
      for (const [slug, p] of Object.entries(rec(body.positions))) if (isRec(p)) out.set(slug.toLowerCase(), p);
      cursor = typeof body.nextCursor === "string" ? body.nextCursor : "";
      if (body.eof === true || !cursor) break;
    }
    return out;
  };
  /** The held markets, for what each position is worth now: GET /v1/markets?slug=…&slug=… (any status: a position outlives its market's
   * close until it settles), fifty to a call, and each resolved one's settlement. A call that FAILS fails the read: the account keeps the last
   * good number and says the venue is stale, rather than show positions at cost now and at market the next time */
  const heldMarkets = async (slugs: string[]): Promise<{ markets: Map<string, Rec>; settled: Map<string, number> }> => {
    const markets = new Map<string, Rec>();
    const wanted = [...new Set(slugs)];
    for (let i = 0; i < wanted.length; i += 50) {
      const chunk = wanted.slice(i, i + 50);
      const body = await gw(`/v1/markets?${chunk.map((s) => `slug=${enc(s)}`).join("&")}&limit=${chunk.length}`);
      if (isRefusal(body)) throw body;
      for (const m of list(rec(body).markets).filter(isRec)) markets.set(slugOf(m), m);
    }
    const settled = new Map<string, number>();
    await Promise.all(
      [...markets.values()]
        .filter((m) => m.status === "MARKET_STATUS_RESOLVED")
        .map(async (m) => {
          const body = await gw(`/v1/markets/${enc(slugOf(m))}/settlement`);
          // not settled yet answers 404 ("Settlement not found for market …"): no result, no throw
          if (isRefusal(body)) {
            if ((body.native as { status?: unknown } | undefined)?.status === 404) return;
            throw body;
          }
          const s = fin(rec(body).settlement);
          if (s !== undefined && s >= 0 && s <= 1) settled.set(slugOf(m), s);
        }),
    );
    return { markets, settled };
  };
  /** what one contract of an outcome is worth now: its settlement once the market has one (1 to the side that won), else the middle of its
   * book; nothing when the book shows neither side */
  const markOf = (m: Rec | undefined, settled: number | undefined, outcome: Outcome): number | undefined => {
    if (settled !== undefined) return outcome === "YES" ? settled : round(1 - settled);
    if (!m) return undefined;
    const leg = pmusMarket(m, outcome);
    return mid(leg.bid, leg.ask);
  };
  const netOf = (p: Rec): number => fin(p.netPositionDecimal) ?? num(p.netPosition);
  /** what a YES position cost (`cost`, "Total cost basis"); a NO's is not read: Polymarket US books it as YES sold, and its docs do not say
   * how that basis is signed */
  const costOf = (p: Rec, outcome: Outcome): number | undefined => {
    const c = amountOf(p.cost);
    return outcome === "YES" && c !== undefined && c > 0 ? c : undefined;
  };

  const read = async (): Promise<LiveBalance[]> => {
    const [bal, held] = await Promise.all([signedGet("/v1/account/balances"), allPositions()]);
    const rows = list(bal.balances).filter(isRec);
    const usd = rows.find((x) => String(x.currency ?? "USD").toUpperCase() === "USD") ?? rows[0];
    const balance = fin(usd?.currentBalance) ?? 0;
    const buying = fin(usd?.buyingPower);
    const pos = [...held.entries()].map(([slug, p]) => ({ slug, p, net: netOf(p) })).filter((x) => x.net !== 0);
    const noHeld = round(pos.filter((x) => x.net < 0).reduce((a, x) => a - x.net, 0));
    const cash = round(balance - noHeld);
    const out: LiveBalance[] = [{ asset: "USD", amount: cash, usd: cash, where: ["cash", buying !== undefined ? `buying power $${buying.toFixed(2)}` : "", noHeld > 0 ? `the balance less the $1.00 a contract Polymarket US holds as margin for the ${plain(noHeld)} NO held` : ""].filter(Boolean).join(" · "), class: "cash" }];
    if (!pos.length) return out;
    const { markets, settled } = await heldMarkets(pos.map((x) => x.slug));
    for (const { slug, p, net } of pos) {
      const outcome: Outcome = net > 0 ? "YES" : "NO";
      const qty = Math.abs(net);
      const m = markets.get(slug);
      const s = settled.get(slug);
      const mark = markOf(m, s, outcome);
      const cost = costOf(p, outcome);
      const asset = `${slug}:${outcome}`;
      const paid = cost !== undefined ? ` · cost $${cost.toFixed(2)}` : "";
      // a settlement is 1 or 0 — or, for an event called off, "last fair market prices" (its markets' own rules): said as the price it is
      const settledAs = s === undefined ? "at market" : s === 1 ? "settled YES" : s === 0 ? "settled NO" : `settled at ${plain(s)} a YES contract`;
      if (mark !== undefined) out.push({ asset, amount: qty, usd: round(qty * mark, 2), where: `${settledAs}${paid}`, class: "event" });
      else out.push({ asset, amount: qty, ...(cost !== undefined ? { usd: cost } : {}), where: `${cost !== undefined ? "at cost" : "unpriced"}: ${m ? "no price now" : "Polymarket US did not list its market"}`, class: "event" });
    }
    return out;
  };

  try {
    const first = await read();
    const trader = polymarketUsTrader({ venue, name, call, gw, allPositions, heldMarkets, markOf, netOf, costOf, clock: req.clock, secrets });
    const source: LiveSource = {
      name,
      kind: "prediction",
      reference: req.reference,
      via: "Polymarket US API · Ed25519-signed key",
      probe: {
        can: [],
        note: "a Polymarket US key belongs to the identity-verified account that made it at polymarket.us/developer, and Polymarket US says nothing of what it may do until it answers an order; positions are worth their market's price now (the middle of its book) or their settlement, and a NO held is Polymarket US's short of the YES contract — so the cash shown is its balance less the $1.00 a contract it holds as margin for NO",
        native: { calls: ["GET /v1/account/balances", "GET /v1/portfolio/positions", "GET gateway /v1/markets?slug=", "POST /v1/orders", "GET /v1/order/{orderId}", "POST /v1/order/{orderId}/cancel", "GET /v1/orders/open"], signed: "Ed25519" },
      },
      read,
      readOnlyBecause: "Polymarket US's API moves no money: deposits and withdrawals are made in its app",
      trader,
    };
    return { source, first };
  } catch (err) {
    return asRefusal(venue, name, err, secrets);
  }
}

// ---- trading -----------------------------------------------------------------------------------------

interface Look {
  m: Rec;
  lite?: Rec | undefined;
  at: number;
}

function polymarketUsTrader(o: {
  venue: string;
  name: string;
  call: Call;
  gw: (path: string, keepMs?: number) => Promise<unknown>;
  allPositions: () => Promise<Map<string, Rec>>;
  heldMarkets: (slugs: string[]) => Promise<{ markets: Map<string, Rec>; settled: Map<string, number> }>;
  markOf: (m: Rec | undefined, settled: number | undefined, outcome: Outcome) => number | undefined;
  netOf: (p: Rec) => number;
  costOf: (p: Rec, outcome: Outcome) => number | undefined;
  clock: () => number;
  secrets: string[];
}): PolymarketUsTrader {
  const { venue, name, call, gw, secrets } = o;
  const lists: PmusGet = (path) => gw(path, LIST_MS);
  const fail = (r: HttpReply, order = false) => polymarketUsNo(venue, name, r, secrets, order);
  const badSymbol = (symbol: string) => no("E_ACCOUNT_BAD_ACTION", { venue, message: `a Polymarket US market is named <market slug>:YES or <market slug>:NO, not "${String(symbol).slice(0, 60)}"` });
  const badRef = (ref: string) => no("E_ACCOUNT_ORDER_UNKNOWN", { venue, message: `"${String(ref).slice(0, 40)}" is not an order id Polymarket US gives`, detail: { order: String(ref).slice(0, 40) } });
  const okRef = (ref: string): boolean => typeof ref === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(ref);
  const looks = new Map<string, Look>();
  /** what Polymarket US said of this key's trading: unknown until an order is answered (it has no call that says) */
  let can: boolean | "unknown" = "unknown";
  let whyNot: string | undefined;

  /** one market and its book, together; the look is kept for the order that follows it */
  const look = async (slug: string): Promise<Look | Refusal> => {
    const [mb, bb] = await Promise.all([gw(`/v1/market/slug/${enc(slug)}`), gw(`/v1/markets/${enc(slug)}/bbo`)]);
    if (isRefusal(mb)) return (mb.native as { status?: unknown } | undefined)?.status === 404 ? no("E_VENUE_REJECTED", { venue, message: `${name} has no market ${slug}`, native: mb.native }) : mb;
    const m = isRec(rec(mb).market) ? (rec(mb).market as Rec) : undefined;
    if (!m || !slugOf(m)) return no("E_VENUE_REJECTED", { venue, message: `${name} answered without the market ${slug}` });
    // the book read with it, when it answered: without it the market's own quotes stand
    const lite = !isRefusal(bb) && isRec(rec(bb).marketData) ? (rec(bb).marketData as Rec) : undefined;
    const l: Look = { m, ...(lite ? { lite } : {}), at: o.clock() };
    looks.set(slug, l);
    if (looks.size > 200) looks.delete(looks.keys().next().value!);
    return l;
  };
  const recent = async (slug: string): Promise<Look | Refusal> => {
    const l = looks.get(slug);
    return l && o.clock() - l.at < FRESH_MS ? l : look(slug);
  };

  /** the outcome an order of Polymarket US's is in: its intent, or its outcomeSide */
  const outcomeOfOrder = (ord: Rec): Outcome | undefined => {
    const i = String(ord.intent ?? "");
    if (i.endsWith("_LONG")) return "YES";
    if (i.endsWith("_SHORT")) return "NO";
    return ord.outcomeSide === "OUTCOME_SIDE_YES" ? "YES" : ord.outcomeSide === "OUTCOME_SIDE_NO" ? "NO" : undefined;
  };
  const sideOfOrder = (ord: Rec): "buy" | "sell" => (String(ord.intent ?? "").includes("_SELL_") || ord.action === "ORDER_ACTION_SELL" ? "sell" : "buy");

  /** An Order (GET /v1/order/{id}) as the account's order. Its states: NEW rests on the book, PARTIALLY_FILLED, FILLED, CANCELED,
   * REJECTED, EXPIRED (a GTD order past its time); PENDING_NEW and PENDING_RISK are not yet on the book; PENDING_REPLACE and PENDING_CANCEL
   * still rest until processed; REPLACED is an order changed at Polymarket US (its modify is a cancel-replace): done under this id. Its
   * prices are the YES contract's (avgPx as price.value is), so a NO order's average is 1 − it: "Only the long side (YES) is directly
   * tradable" */
  const stateOf = (ord: Rec, fallback?: Outcome): OrderState => {
    const filled = fin(ord.cumQuantity) ?? 0;
    const st = String(ord.state ?? "");
    const status: OrderStatus =
      st === "ORDER_STATE_FILLED" ? "filled" : st === "ORDER_STATE_CANCELED" || st === "ORDER_STATE_REPLACED" ? "canceled" : st === "ORDER_STATE_REJECTED" ? "rejected" : st === "ORDER_STATE_EXPIRED" ? "expired" : st === "ORDER_STATE_PARTIALLY_FILLED" ? "partial" : st === "ORDER_STATE_NEW" || st === "ORDER_STATE_PENDING_CANCEL" || st === "ORDER_STATE_PENDING_REPLACE" ? (filled > 0 ? "partial" : "open") : "pending";
    const outcome = outcomeOfOrder(ord) ?? fallback;
    const avgYes = px(amountOf(ord.avgPx));
    const avg = avgYes === undefined || filled <= 0 || !outcome ? undefined : outcome === "YES" ? avgYes : round(1 - avgYes);
    // as Polymarket US states it: a rebate would be its own sign
    const fee = amountOf(ord.commissionNotionalTotalCollected);
    return { ref: String(ord.id ?? ""), status, filledQty: filled, ...(avg !== undefined ? { avgPrice: avg } : {}), ...(fee !== undefined && (filled > 0 || fee !== 0) ? { feeUsd: round(fee) } : {}), native: ord };
  };

  const status = async (ref: string, symbol: string): Promise<OrderState | Refusal> => {
    try {
      if (!okRef(ref)) return badRef(ref);
      const ord = await orderOf(ref);
      return isRefusal(ord) ? ord : stateOf(ord, pmusParse(symbol)?.outcome);
    } catch (err) {
      return asRefusal(venue, name, err, secrets);
    }
  };

  /** GET /v1/order/{id}: the order as Polymarket US has it now */
  const orderOf = async (ref: string): Promise<Rec | Refusal> => {
    const r = await call("GET", `/v1/order/${enc(ref)}`);
    if (r.status === 404 || (r.status === 400 && /not found|unknown|invalid order/i.test(saidOf(r, secrets).said))) return no("E_ACCOUNT_ORDER_UNKNOWN", { venue, message: `${name} has no order ${ref} for this key`, detail: { order: ref }, native: { status: r.status, said: saidOf(r, secrets).said } });
    if (r.status !== 200) return fail(r);
    const ord = isRec(r.body) && isRec(r.body.order) ? r.body.order : undefined;
    return ord ?? no("E_VENUE_REJECTED", { venue, message: `${name} answered without the order ${ref}` });
  };

  /** GET /v1/orders/open: every order of this account's resting at Polymarket US now */
  const resting = async (): Promise<Rec[]> => {
    const r = await call("GET", "/v1/orders/open");
    if (r.status !== 200 || !isRec(r.body)) throw fail(r);
    return list(r.body.orders).filter(isRec);
  };

  /** What of one outcome is free to sell: what is held (netPositionDecimal above zero is YES, below it NO), less what the account's orders
   * already resting to sell it will take first — and never more than Polymarket US's own `qtyAvailableDecimal` ("Quantity available to
   * trade"), whichever is smaller. A sell past what is held would sell YES short: buy the other side */
  const freeToSell = async (slug: string, outcome: Outcome): Promise<{ held: number; resting: number; free: number; position: unknown } | Refusal> => {
    const [ps, os] = await Promise.all([o.allPositions(), resting()]);
    const p = ps.get(slug);
    const net = p ? o.netOf(p) : 0;
    const held = outcome === "YES" ? Math.max(0, net) : Math.max(0, -net);
    const available = p && fin(p.qtyAvailableDecimal) !== undefined ? Math.abs(fin(p.qtyAvailableDecimal)!) : undefined;
    const sells = round(os.filter((x) => String(x.marketSlug ?? "").toLowerCase() === slug && outcomeOfOrder(x) === outcome && sideOfOrder(x) === "sell").reduce((a, x) => a + num(x.leavesQuantity), 0));
    return { held, resting: sells, free: Math.max(0, round(Math.min(held - sells, available ?? Number.POSITIVE_INFINITY))), position: p ?? { positions: {} } };
  };

  /** the order as sent, said back when Polymarket US did not answer for it: what rests now on that market with the same intent, price and
   * size, made since it was sent — for the owner to look at; never taken for this order, since Polymarket US takes no client order id */
  const alike = async (body: Rec, sentAt: number): Promise<Array<{ id: unknown; state: unknown; createTime: unknown }>> => {
    try {
      const want = amountOf(body.price);
      return (await resting())
        .filter((x) => String(x.marketSlug ?? "").toLowerCase() === body.marketSlug && x.intent === body.intent && want !== undefined && amountOf(x.price) === want && Math.abs(num(x.quantity) - num(body.quantity)) < 1e-9 && (Date.parse(String(x.createTime ?? x.insertTime ?? "")) || 0) >= sentAt - 5_000)
        .map((x) => ({ id: x.id, state: x.state, createTime: x.createTime }));
    } catch {
      return [];
    }
  };

  /** the YES price for a limit in the outcome's own terms, in millionths, on the market's tick and within 0.01–0.99 — or why not */
  const limitYes = (m: Market, outcome: Outcome, lp: number | undefined): number | Refusal => {
    const tickU = toU(m.priceStep ?? 0.01);
    const u = (lp ?? NaN) * SCALE;
    if (!(lp !== undefined && lp > 0 && lp < 1) || Math.abs(u - Math.round(u)) > 1e-6) return badOrder(venue, name, "a price at Polymarket US is in dollars, more than 0 and less than 1", { limitPrice: lp });
    const yesU = outcome === "YES" ? Math.round(u) : SCALE - Math.round(u);
    if (yesU >= MIN_U && yesU <= MAX_U && yesU % tickU === 0) return yesU;
    return badOrder(venue, name, `a price in ${m.name} moves in steps of ${plain(tickU / SCALE)}, between ${plain(MIN_U / SCALE)} and ${plain(MAX_U / SCALE)}`, { limitPrice: lp, priceStep: tickU / SCALE });
  };

  const trader: PolymarketUsTrader = {
    get can() {
      return can;
    },
    get whyNot() {
      return whyNot;
    },
    what: "event contracts: YES or NO on Polymarket US's markets",

    /** A few markets to start from — the most traded open markets of each of Polymarket US's categories in turn (PMUS_CATEGORIES) — or, for a
     * query, Polymarket US's own search, with a market slug asked as itself */
    async markets(query) {
      try {
        const q = query.trim();
        if (!q) {
          const busy = await pmusBusiest(lists, { perCategory: PMUS_PER_CATEGORY });
          return isRefusal(busy) ? busy : busy.slice(0, 10).flatMap((m) => pmusLegs(m));
        }
        const s = pmusParse(q) ?? (/^[a-z0-9][a-z0-9._-]*-[a-z0-9._-]+$/i.test(q) ? { slug: q.toLowerCase(), outcome: "YES" as const } : undefined);
        const [found, own] = await Promise.all([pmusSearch(lists, q), s ? gw(`/v1/market/slug/${enc(s.slug)}`) : Promise.resolve(undefined)]);
        const exact = own !== undefined && !isRefusal(own) && isRec(rec(own).market) && pmusTradable(rec(own).market as Rec) ? [rec(own).market as Rec] : [];
        if (isRefusal(found) && !exact.length) return found;
        const all = [...exact, ...(isRefusal(found) ? [] : found)];
        const seen = new Set<string>();
        return all.filter((m) => !seen.has(slugOf(m)) && seen.add(slugOf(m)) !== undefined).slice(0, 10).flatMap((m) => pmusLegs(m));
      } catch (err) {
        return asRefusal(venue, name, err, secrets);
      }
    },

    async market(symbol) {
      try {
        const s = pmusParse(symbol);
        if (!s) return badSymbol(symbol);
        const l = await look(s.slug);
        return isRefusal(l) ? l : pmusMarket(l.m, s.outcome, l.lite);
      } catch (err) {
        return asRefusal(venue, name, err, secrets);
      }
    },

    async place(order: OrderRequest) {
      try {
        const s = pmusParse(order.symbol);
        if (!s) return badSymbol(order.symbol);
        const market = order.type === "market";
        // how long it stays, as asked, or as it always is here when not: a market order fills at once, a limit order rests until canceled
        const tif: TimeInForce = order.tif ?? (market ? "ioc" : "gtc");
        const why = notTaken(order, tif);
        if (why) return badOrder(venue, name, why);
        let goodTill: string | undefined;
        if (tif === "day") {
          const now = o.clock();
          const end = pmusDayEnd(now);
          if (end - now < DAY_MARGIN_MS) return badOrder(venue, name, "a day order at Polymarket US ends at its 5:00 pm ET trade day roll, seconds from now: it would end before it rested. Send it good-till-canceled, or after the roll", { expiresAt: iso(end) });
          goodTill = iso(end);
        }
        const l = await recent(s.slug);
        if (isRefusal(l)) return l;
        const m = pmusMarket(l.m, s.outcome, l.lite);
        if (!m.open) return no("E_VENUE_MARKET_CLOSED", { venue, message: `${name}: ${m.name} takes no orders now${m.note ? ` (${m.note})` : ""}` });
        const step = m.qtyStep ?? 1;
        if (!(order.qty >= (m.minQty ?? step) - 1e-12) || !onStep(order.qty, step)) return badOrder(venue, name, `a size in ${m.name} is in steps of ${plain(step)} contracts, at least ${plain(m.minQty ?? step)} (its minimumTradeQty)`, { qty: order.qty, qtyStep: step });
        // the YES contract's side of the book: buying YES and selling NO bid for it, selling YES and buying NO offer it
        const yesBid = (s.outcome === "YES") === (order.side === "buy");
        let yesU: number;
        if (order.type === "limit") {
          const p = limitYes(m, s.outcome, order.limitPrice);
          if (isRefusal(p)) return p;
          yesU = p;
        } else {
          // The account's market order is a limit at its worst price (trade.ts: the most a buy pays, the least a sell takes), or, without
          // one, at the book the account just looked at — sent ORDER_TYPE_LIMIT and immediate-or-cancel (or fill-or-kill when asked): every
          // fill is held to that price or better, and what does not fill at once is canceled. Polymarket US's own ORDER_TYPE_MARKET is not
          // used: its slippage bound is "Unlimited (no slippage protection by default)", and its tolerance is a check against the best price
          // moving before execution (orders/overview.md), not a price each fill is held to
          const book = order.side === "buy" ? m.ask : m.bid;
          if (book === undefined) return badOrder(venue, name, `no one is ${order.side === "buy" ? "selling" : "buying"} ${m.name} right now, so a market order has nothing to take: try a limit order`);
          const at = order.worstPrice !== undefined && order.worstPrice > 0 ? order.worstPrice : book;
          const tickU = toU(m.priceStep ?? 0.01);
          const raw = s.outcome === "YES" ? toU(at) : SCALE - toU(at);
          // within 0.01–0.99, tighter and never looser, then to the tick in the safe direction: a bid down, an offer up
          const bounded = yesBid ? Math.min(MAX_U, raw) : Math.max(MIN_U, raw);
          const snapped = (yesBid ? Math.floor(bounded / tickU + 1e-9) : Math.ceil(bounded / tickU - 1e-9)) * tickU;
          if (snapped < MIN_U || snapped > MAX_U) return badOrder(venue, name, `${plain(at)} has no price on ${m.name}'s grid between 0.01 and 0.99 to send a market order at: try a limit order`);
          yesU = snapped;
        }
        // A sell is of what is held: Polymarket US has one instrument a market, so selling YES that is not held sells it short (buys NO), and
        // a NO sold past what is held buys YES. What is free to sell is read first
        if (order.side === "sell") {
          const f = await freeToSell(s.slug, s.outcome);
          if (isRefusal(f)) return f;
          if (order.qty > f.free + 1e-9) return no("E_VENUE_INSUFFICIENT", { venue, message: `${name}: you hold ${plain(f.held)} ${m.symbol}${f.resting > 0 ? `, and orders already resting at Polymarket US sell ${plain(Math.min(f.resting, f.held))} of it` : ""}: ${plain(f.free)} is free to sell, fewer than the ${plain(order.qty)} asked. A sell here is of what is held: selling more would buy the other side`, detail: { held: f.held, qty: order.qty, ...(f.resting > 0 ? { resting: f.resting } : {}) }, native: f.position });
        }
        const fillsAtOnce = tif === "ioc" || tif === "fok";
        const body: Rec = {
          marketSlug: s.slug,
          type: "ORDER_TYPE_LIMIT",
          // always the YES contract's price ("price.value always represents the long side's price")
          price: { value: plain(yesU / SCALE), currency: "USD" },
          // "a number and can contain decimals for partial-contract markets", already on its minimumTradeQty
          quantity: round(order.qty),
          tif: TIF_WIRE[tif],
          intent: INTENT[s.outcome][order.side],
          // "Required to indicate whether the order is placed by a human or automated system": every order this account sends is sent by
          // this software — an agent's inside its limit, or one the owner signed on a card the account built
          manualOrderIndicator: "MANUAL_ORDER_INDICATOR_AUTOMATIC",
          ...(goodTill ? { goodTillTime: goodTill } : {}),
          ...(order.postOnly ? { participateDontInitiate: true } : {}),
          // an order that fills at once is waited for ("Only use synchronousExecution: true for immediately-fillable orders"); one that rests
          // is not, and is read back after
          ...(fillsAtOnce ? { synchronousExecution: true, maxBlockTime: MAX_BLOCK } : {}),
        };
        const sentAt = o.clock();
        // no answer, a 5xx, or a 200 without an id: it may be at Polymarket US all the same — never "not placed"
        const unknown = async (why: string, native: unknown): Promise<Refusal> => {
          const found = await alike(body, sentAt);
          return no("E_VENUE_UNREACHABLE", { venue, message: `${name} ${why}: it may have been taken all the same. Polymarket US takes no client order id, so the account cannot look it up by one — look at its open orders and activity in ${s.slug} before placing it again`, detail: { placed: "unknown", marketSlug: s.slug }, native: { answer: native, ...(found.length ? { restingAlike: found } : {}) } });
        };
        let r: HttpReply;
        try {
          r = await call("POST", "/v1/orders", body);
        } catch (err) {
          return await unknown("did not answer the order", isRefusal(err) ? err.native : undefined);
        }
        // a 5xx (a 503 too: Polymarket US answers every request so during its maintenance, but a 503 at another time says nothing of where
        // the order got to) is no answer about the order
        if (r.status >= 500 || r.status === 0) return await unknown(`answered the order with HTTP ${r.status}`, fail(r).native);
        if (r.status !== 200) {
          const refused = fail(r, true);
          // only Polymarket US's own answer about this key ({code: 7, message}) says what the key may do: a page, an empty 403 or another
          // server's JSON says nothing of the key, and does not mark it unable to trade for the rest of the session
          if (refused.code === "E_VENUE_PERMISSION" && typeof rec(r.body).code === "number") {
            can = false;
            whyNot = refused.message;
          }
          return refused;
        }
        const b = rec(r.body);
        const id = str(b.id);
        if (!id) return await unknown("took the order without saying its id", { status: r.status });
        can = true;
        whyNot = undefined;
        const executions = list(b.executions).filter(isRec);
        const rejected = executions.find((e) => e.type === "EXECUTION_TYPE_REJECTED");
        if (rejected) return rejectedNo(venue, name, rejected, id, secrets);
        // the order as its last execution saw it, when it was waited for; else it is read back once (a resting order is "~100ms" away)
        const lastSeen = [...executions].reverse().map((e) => e.order).find(isRec);
        if (lastSeen) return { ...stateOf({ ...lastSeen, id: lastSeen.id ?? id }, s.outcome), native: { id, executions } };
        const now = await orderOf(id).catch((err: unknown) => (isRefusal(err) ? err : undefined));
        if (now === undefined || isRefusal(now)) return { ref: id, status: "pending", filledQty: 0, native: { id, ...(now ? { read: now.native } : {}) } };
        // a resting order rejected after it was taken: its reason is in Polymarket US's order stream, not in the order
        if (now.state === "ORDER_STATE_REJECTED") return no("E_VENUE_REJECTED", { venue, message: `${name} rejected the order after taking it (order ${id}): the order it lists says rejected, and its reason is not in it`, native: { order: now } });
        return stateOf(now, s.outcome);
      } catch (err) {
        return asRefusal(venue, name, err, secrets);
      }
    },

    /** POST /v1/order/{id}/cancel with its market's slug (cancel-order.md: {marketSlug}), answered empty; then the order as it stands. A cancel
     * Polymarket US did not take, with the order still on its book, is said as that; one done already is the order as it is */
    async cancel(ref, symbol) {
      try {
        const s = pmusParse(symbol);
        if (!s) return badSymbol(symbol);
        if (!okRef(ref)) return badRef(ref);
        const r = await call("POST", `/v1/order/${enc(ref)}/cancel`, { marketSlug: s.slug });
        if (r.status !== 200) {
          // no answer, a key it does not accept, a place (its 451, its words) or the server in front of it refusing this network: that is
          // the answer, in its words — reading the order back would not make it Polymarket US's word about this order
          const refused = fail(r);
          if (refused.code === "E_VENUE_UNREACHABLE" || refused.code === "E_VENUE_UNAUTHORIZED" || refused.code === "E_VENUE_GEOBLOCKED") return refused;
          // already filled or canceled, or not this key's: the order as it stands — and if it is still on the book, Polymarket US did not
          // take the cancel, which is said as that rather than handed back as a cancel on its way
          const now = await status(ref, symbol);
          if (isRefusal(now) || (now.status !== "open" && now.status !== "partial" && now.status !== "pending")) return now;
          return no("E_VENUE_REJECTED", { venue, message: `${name} did not take the cancel (HTTP ${r.status}), and the order is still on its book: cancel it at Polymarket US`, native: { ...saidOf(r, secrets), status: r.status, order: now.native } });
        }
        // the cancel's answer is empty: the order itself is read (PENDING_CANCEL still rests until processed, and the account follows it)
        const now = await status(ref, symbol);
        if (!isRefusal(now)) return { ...now, native: { cancel: r.body ?? {}, order: now.native } };
        return no("E_VENUE_UNREACHABLE", { venue, message: `${name} took the cancel, but the order could not be read back: it is read again in a few seconds`, native: { cancel: r.body ?? {}, read: now.native } });
      } catch (err) {
        return asRefusal(venue, name, err, secrets);
      }
    },

    status,

    async openOrders(symbol) {
      try {
        const only = symbol === undefined ? undefined : pmusParse(symbol);
        if (symbol !== undefined && !only) return badSymbol(symbol);
        const os = await resting();
        return os
          .filter((x) => !only || (String(x.marketSlug ?? "").toLowerCase() === only.slug && outcomeOfOrder(x) === only.outcome))
          .map((x) => {
            const outcome = outcomeOfOrder(x) ?? "YES";
            const yesLimit = px(amountOf(x.price));
            return { ...stateOf(x), symbol: `${String(x.marketSlug ?? "").toLowerCase()}:${outcome}`, side: sideOfOrder(x), ...(yesLimit !== undefined ? { limitPrice: outcome === "YES" ? yesLimit : round(1 - yesLimit) } : {}) };
          });
      } catch (err) {
        return asRefusal(venue, name, err, secrets);
      }
    },

    /** What is held here: GET /v1/portfolio/positions, one row per market with its position netted — netPositionDecimal above zero is YES held,
     * below zero NO — named and priced by its market (GET /v1/markets?slug=), at its settlement once it has one */
    async positions() {
      try {
        const held = await o.allPositions();
        const pos = [...held.entries()].map(([slug, p]) => ({ slug, p, net: o.netOf(p) })).filter((x) => x.net !== 0);
        if (!pos.length) return [];
        const { markets, settled } = await o.heldMarkets(pos.map((x) => x.slug));
        return pos.map(({ slug, p, net }): Position => {
          const outcome: Outcome = net > 0 ? "YES" : "NO";
          const qty = Math.abs(net);
          const m = markets.get(slug);
          const mark = o.markOf(m, settled.get(slug), outcome);
          const cost = o.costOf(p, outcome);
          const meta = rec(p.marketMetadata);
          const words = m ? wordsOf(m) : (str(meta.title) ?? slug);
          return { symbol: `${slug}:${outcome}`, name: `${words} · ${outcome === "YES" ? "Yes" : "No"}`, kind: "event", side: "long", qty, ...(cost !== undefined ? { entryPrice: round(cost / qty) } : {}), ...(mark !== undefined ? { markPrice: mark, usd: round(qty * mark, 2), ...(cost !== undefined ? { unrealizedUsd: round(qty * mark - cost, 2) } : {}) } : {}), native: p };
        });
      } catch (err) {
        return asRefusal(venue, name, err, secrets);
      }
    },

    /** Event contracts to discover: the most traded open markets of one category (the venue's own word, as GET /v1/markets?categories= takes
     * it) or of each of PMUS_CATEGORIES in turn, ending within a window when one is asked (endDateMin, endDateMax); both outcomes of each */
    async events({ category, closingWithinMs, limit }) {
      try {
        const n = Math.min(200, Math.floor(limit));
        if (!(n > 0)) return [];
        if (closingWithinMs !== undefined && !(Number.isFinite(closingWithinMs) && closingWithinMs > 0)) return no("E_ACCOUNT_BAD_ACTION", { venue, message: "a window for markets closing soon is a number of milliseconds, more than 0" });
        const now = o.clock();
        const cats = category?.trim() ? [category.trim().toLowerCase()] : PMUS_CATEGORIES;
        const want = Math.ceil(n / 2);
        const busy = await pmusBusiest(lists, { perCategory: Math.min(50, Math.max(PMUS_PER_CATEGORY, Math.ceil(want / cats.length))), categories: cats, ...(closingWithinMs !== undefined ? { endMin: iso(now), endMax: iso(now + closingWithinMs) } : {}) });
        return isRefusal(busy) ? busy : busy.slice(0, want).flatMap((m) => pmusLegs(m)).slice(0, n);
      } catch (err) {
        return asRefusal(venue, name, err, secrets);
      }
    },

    async candles(symbol, interval, sinceMs) {
      try {
        return await pmusCandles(lists, venue, symbol, interval, sinceMs, o.clock());
      } catch (err) {
        return asRefusal(venue, name, err, secrets);
      }
    },
  };
  return trader;
}
