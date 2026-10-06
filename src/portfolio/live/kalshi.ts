/** A Kalshi account, read and traded through its trade API v2 (docs.kalshi.com, read 2026-10-05; OpenAPI 3.32.0).
 *
 *   GET /trade-api/v2/portfolio/balance      balance, in cents
 *   GET /trade-api/v2/portfolio/positions    market_positions[]: ticker, position_fp (contracts; negative = NO), market_exposure_dollars (cost)
 *   GET /trade-api/v2/markets?tickers=…      the held markets, for what a position is worth now: Kalshi reports only what it cost
 *
 * Orders (the trader below):
 *
 *   GET    /trade-api/v2/markets/{ticker}                 one market: *_dollars prices, price_ranges (its price grid), status (`active` trades)
 *   GET    /trade-api/v2/markets?status=open&…            the list a search runs over
 *   GET    /trade-api/v2/exchange/status                  whether Kalshi is taking orders now, per exchange shard
 *   GET    /trade-api/v2/api_keys                         the key's own scopes: `write` or `write::trade` places orders, `read` alone does not
 *   POST   /trade-api/v2/portfolio/events/orders          place (the V2 endpoint; the old /portfolio/orders writes were removed in June 2026)
 *   DELETE /trade-api/v2/portfolio/events/orders/{id}     cancel, with ?market_ticker= so Kalshi routes it to the market's shard
 *   POST   /trade-api/v2/portfolio/events/orders/{id}/amend   a resting order's price or size changed in place (amend-order-v2.md)
 *   GET    /trade-api/v2/portfolio/orders/{id}            what became of it: resting, executed, canceled
 *   GET    /trade-api/v2/portfolio/orders?ticker=         the orders on one market: those resting (a sell counts them), one by its client id
 *   GET    /trade-api/v2/portfolio/fills?order_id=        the price of each fill, in YES and in NO terms, and its fee
 *   GET    /trade-api/v2/portfolio/positions?count_filter=position   what is held, for the trader's positions
 *   GET    /trade-api/v2/markets?tickers=…                those positions' markets, for their names and prices
 *
 * Reading the market (nothing signed for but the request itself, nothing placed):
 *
 *   GET    /trade-api/v2/markets?min_close_ts=&max_close_ts=   the markets closing within a window (get-markets.md)
 *   GET    /trade-api/v2/events?tickers=…                 the events those markets belong to, for their category
 *   GET    /trade-api/v2/markets/candlesticks?market_tickers=   a market's price history (batch-get-market-candlesticks.md)
 *
 * What an order may say (create-order-v2.md): every Kalshi event order is a limit order with a price, and it says how long it stays —
 * good_till_canceled, immediate_or_cancel or fill_or_kill, which V2 requires; a good-till-canceled one may carry an `expiration_time`, which
 * is how a day order is sent. It may be post_only, and reduce_only when it fills at once. Kalshi has no stop orders on event contracts.
 *
 * Each request carries three headers: the key's id, a millisecond timestamp, and a signature over `timestamp + METHOD + path` — the path
 * with its `/trade-api/v2` prefix and without the query string, the body never signed — made with the private key that came with the id:
 * RSA-PSS (SHA-256, MGF1 SHA-256, salt as long as the digest) for an RSA key, the string signed directly for an Ed25519 one. The private
 * key is a PEM file the key file points to; it is read in this process and used for nothing but these signatures.
 *
 * Kalshi's API has no call that moves money in or out: this connection could not start a deposit or a withdrawal if it wanted to. An order
 * moves dollars into contracts and back, inside the Kalshi account.
 */
import { constants, createPrivateKey, sign as cryptoSign, type KeyObject } from "node:crypto";
import { isRefusal, type Refusal } from "../../core/errors.ts";
import { no } from "../refuse.ts";
import { readSecretFile, type KeyFile, type KeyShape } from "./credentials.ts";
import { badOrder, onStep, pick, plain, type Candle, type CandleInterval, type LiveTrader, type Market, type OrderRequest, type OrderState, type OrderStatus, type Position, type Side, type TimeInForce } from "./trade.ts";
import { asRefusal, num, redact, REGION, unreachable, venueSaidNo, type Http, type HttpReply, type LiveBalance, type LiveSource } from "./types.ts";

export const KALSHI_KEY: KeyShape = { required: ["keyId"], optional: ["privateKeyFile", "privateKey", "demo"], example: '{"keyId": "…", "privateKeyFile": "credentials/kalshi/private-key.pem"} (the .pem is the file Kalshi gives you when the key is made; a key made with write access places orders, a read-only one only reads)' };

const PROD = "https://external-api.kalshi.com";
const DEMO = "https://external-api.demo.kalshi.co";
const PREFIX = "/trade-api/v2";

/** the signature Kalshi expects for one request, base64 */
export function kalshiSign(key: KeyObject, timestampMs: number, method: string, path: string): string {
  const text = Buffer.from(`${timestampMs}${method.toUpperCase()}${path.split("?")[0]}`);
  return key.asymmetricKeyType === "ed25519" ? cryptoSign(null, text, key).toString("base64") : cryptoSign("sha256", text, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }).toString("base64");
}

export async function kalshiSource(req: { venue: string; label: string; reference: string; key: KeyFile; home: string; http: Http; clock: () => number }): Promise<{ source: LiveSource; first: LiveBalance[] } | Refusal> {
  const demo = req.key.demo === "true";
  const base = demo ? DEMO : PROD;
  const name = `${req.label || "Kalshi"}${demo && !/demo/i.test(req.label) ? " · demo" : ""}`;
  let pem = req.key.privateKey;
  if (!pem) {
    const file = readSecretFile(req.home, req.key.privateKeyFile ?? `credentials/${req.venue}/private-key.pem`, req.venue, "It is the private key Kalshi gives you when the API key is made; chmod 600 on it");
    if ("ok" in file) return file;
    pem = file.text;
  }
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    return no("E_ACCOUNT_CREDENTIAL", { venue: req.venue, message: "Kalshi's private key is not a PEM private key this machine can read" });
  }
  if (key.asymmetricKeyType !== "rsa" && key.asymmetricKeyType !== "ed25519") return no("E_ACCOUNT_CREDENTIAL", { venue: req.venue, message: `Kalshi signs with an RSA or an Ed25519 key; this one is ${key.asymmetricKeyType ?? "something else"}` });
  const secrets = [pem];

  const get = async (path: string): Promise<Record<string, unknown>> => {
    const ts = req.clock();
    let r;
    try {
      r = await req.http(`${base}${PREFIX}${path}`, { headers: { "KALSHI-ACCESS-KEY": req.key.keyId!, "KALSHI-ACCESS-TIMESTAMP": String(ts), "KALSHI-ACCESS-SIGNATURE": kalshiSign(key, ts, "GET", `${PREFIX}${path}`), accept: "application/json" } });
    } catch (err) {
      throw unreachable(req.venue, name, err, secrets);
    }
    if (r.status !== 200 || !r.body || typeof r.body !== "object") throw venueSaidNo(req.venue, name, r.status, r.text, secrets);
    return r.body as Record<string, unknown>;
  };
  /** any signed request, its answer as it came: the trader reads the status itself, because a 201, a 404 and a 409 each mean something */
  const call: Call = async (method, path, body) => {
    const ts = req.clock();
    const headers: Record<string, string> = { "KALSHI-ACCESS-KEY": req.key.keyId!, "KALSHI-ACCESS-TIMESTAMP": String(ts), "KALSHI-ACCESS-SIGNATURE": kalshiSign(key, ts, method, `${PREFIX}${path}`), accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) };
    try {
      return await req.http(`${base}${PREFIX}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    } catch (err) {
      throw unreachable(req.venue, name, err, secrets);
    }
  };
  const read = async (): Promise<LiveBalance[]> => {
    const balance = await get("/portfolio/balance");
    const out: LiveBalance[] = [{ asset: "USD", amount: num(balance.balance) / 100, usd: num(balance.balance) / 100, where: "cash", class: "cash" }];
    const held: Array<{ ticker: string; outcome: Outcome; qty: number; cost: number }> = [];
    let cursor = "";
    // a page at a time, and not for ever: five pages is a thousand positions
    for (let page = 0; page < 5; page++) {
      const body = await get(`/portfolio/positions?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      for (const p of (Array.isArray(body.market_positions) ? body.market_positions : []) as Array<Record<string, unknown>>) {
        const n = num(p.position_fp);
        if (n !== 0) held.push({ ticker: String(p.ticker ?? "?"), outcome: n > 0 ? "YES" : "NO", qty: Math.abs(n), cost: num(p.market_exposure_dollars) });
      }
      cursor = typeof body.cursor === "string" ? body.cursor : "";
      if (!cursor) break;
    }
    // What Kalshi reports per position is what it cost, not what it is worth now. So it is valued as positions() values it: at its market's
    // price now, or $1 or $0 a contract once the market has a result — the held markets read with GET /markets?tickers=, a hundred to a
    // call, of any status. A market Kalshi answers for and shows no price, or does not list, leaves its position at what it cost, said as
    // that. A call that FAILS (a 429, no answer) fails the read: the account keeps the last good number and says the venue is stale, rather
    // than show the positions at cost now and at market the next time — a swing that is no gain and no loss
    const markets = new Map<string, Record<string, unknown>>();
    const tickers = [...new Set(held.map((h) => h.ticker.toUpperCase()).filter((t) => t !== "?"))];
    for (let i = 0; i < tickers.length; i += 100) {
      const chunk = tickers.slice(i, i + 100);
      const body = await get(`/markets?tickers=${chunk.map(encodeURIComponent).join(",")}&limit=${chunk.length}`);
      for (const m of (Array.isArray(body.markets) ? body.markets : []) as unknown[]) if (isRec(m)) markets.set(String(m.ticker ?? "").toUpperCase(), m);
    }
    for (const h of held) {
      const m = markets.get(h.ticker.toUpperCase());
      const mark = markOf(m, h.outcome);
      const cost = `cost $${h.cost.toFixed(2)}`;
      const asset = `${h.ticker}:${h.outcome}`;
      if (mark !== undefined) out.push({ asset, amount: h.qty, usd: round(h.qty * mark), where: `${decided(m) ? `decided ${String(m!.result).toUpperCase()}` : "at market"} · ${cost}`, class: "event" });
      else out.push({ asset, amount: h.qty, usd: h.cost, where: `at cost: ${m ? "no price now" : "Kalshi did not list its market"}`, class: "event" });
    }
    return out;
  };
  try {
    const first = await read();
    const trader = kalshiTrader({ venue: req.venue, name, keyId: req.key.keyId!, call, clock: req.clock, secrets });
    const source: LiveSource = {
      name,
      kind: "prediction",
      reference: req.reference,
      via: `Kalshi trade API${demo ? " · demo" : ""}`,
      probe: {
        can: [],
        note: "a Kalshi key carries the scopes it was made with: read to see the account, write (or write::trade) to place and cancel orders here; positions are valued at their market's price now (its last trade, or the middle of its book), what they cost — which is all Kalshi reports for them — beside it",
        native: { calls: ["GET /trade-api/v2/portfolio/balance", "GET /trade-api/v2/portfolio/positions", "GET /trade-api/v2/markets?tickers=", "GET /trade-api/v2/api_keys", "POST /trade-api/v2/portfolio/events/orders", "DELETE /trade-api/v2/portfolio/events/orders/{order_id}", "POST /trade-api/v2/portfolio/events/orders/{order_id}/amend", "GET /trade-api/v2/portfolio/orders/{order_id}"], signed: key.asymmetricKeyType === "ed25519" ? "Ed25519" : "RSA-PSS SHA-256", demo },
      },
      read,
      readOnlyBecause: "Kalshi's API moves no money: deposits and withdrawals are made at Kalshi",
      trader,
    };
    return { source, first };
  } catch (err) {
    return asRefusal(req.venue, name, err, secrets);
  }
}

// ---- trading -----------------------------------------------------------------------------------------

type Call = (method: "GET" | "POST" | "DELETE", path: string, body?: unknown) => Promise<HttpReply>;
type Rec = Record<string, unknown>;
type Outcome = "YES" | "NO";
/** the V2 book is the YES leg's: `bid` buys YES (or sells NO), `ask` sells YES (or buys NO) — order_direction.md */
type BookSide = "bid" | "ask";

/** prices in hundredths of a cent ("centicents"), so that a price grid is checked in integers and never off by float dust */
const CC = 10_000;
/** "minimum granularity is 0.01 contracts", and every active market takes fractional counts (changelog 2026-04-17) */
const COUNT_STEP = 0.01;
const LIST_MS = 5 * 60_000;
/** a look at a market this recent is the one the account just valued an order at: a market order is sent at that price, not a newer one */
const FRESH_MS = 30_000;
/** what an empty search starts from: the Fed's rate and decision, CPI, the S&P 500, Bitcoin — the most-traded market of each */
const KNOWN = ["KXFED", "KXFEDDECISION", "KXCPI", "KXINX", "KXBTCD"];
/** The account's time in force as V2's create takes it: `time_in_force` is required there and is one of good_till_canceled,
 * immediate_or_cancel, fill_or_kill (create-order-v2.md). A day order is Kalshi's own too — over FIX, Day "expires 11:59:59.999pm ET" and
 * "Kalshi stores Day orders as explicit deadlines" (fix/order-entry.md) — and over REST that deadline is an `expiration_time` in Unix
 * seconds: "To place an expiring order, set `time_in_force` to `good_till_canceled` and provide this `expiration_time`" */
const TIF_WIRE: Record<TimeInForce, string> = { gtc: "good_till_canceled", ioc: "immediate_or_cancel", fok: "fill_or_kill", day: "good_till_canceled" };
const KALSHI_TIFS: TimeInForce[] = ["gtc", "ioc", "fok", "day"];
/** a day order this close to the day's end would end before it rests: Kalshi refuses an expiry that is not in the future (changelog 2025-11-21) */
const DAY_MARGIN_S = 10;

const enc = encodeURIComponent;
const round = (x: number, places = 6): number => Number(x.toFixed(places));
const isRec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);
/** a venue's words as a refusal carries them: secrets out first, then one line, at most 220 characters */
const saidOf = (text: string, secrets: string[]): string => redact(text, secrets).replace(/\s+/g, " ").trim().slice(0, 220);

interface Band {
  start: number;
  end: number;
  step: number;
}

/** a market's price grid, from its `price_ranges` (tick_size was removed 2026-05-07); "whole-cent prices are valid in every structure" */
function bandsOf(m: Rec): Band[] {
  const raw = Array.isArray(m.price_ranges) ? (m.price_ranges as unknown[]).filter(isRec) : [];
  const out = raw.map((r) => ({ start: Math.round(num(r.start) * CC), end: Math.round(num(r.end) * CC), step: Math.round(num(r.step) * CC) })).filter((b) => b.step > 0 && b.end > b.start);
  return out.length ? out : [{ start: 0, end: CC, step: 100 }];
}
const bandAt = (bands: Band[], p: number): Band | undefined => bands.find((b) => p >= b.start && p <= b.end);
/** on the grid, and neither $0 nor $1, which Kalshi refuses */
const onGrid = (bands: Band[], p: number): boolean => p > 0 && p < CC && bands.some((b) => p >= b.start && p <= b.end && (p - b.start) % b.step === 0);
/** to the grid: down for a bid, up for an ask — the safe direction either way, since a bid then pays no more and an ask sells for no less */
function snapTo(bands: Band[], p: number, dir: "down" | "up"): number | undefined {
  const b = bandAt(bands, p);
  if (!b) return undefined;
  const k = (p - b.start) / b.step;
  const q = b.start + (dir === "down" ? Math.floor(k + 1e-9) : Math.ceil(k - 1e-9)) * b.step;
  return onGrid(bands, q) ? q : undefined;
}

/** `KXFED-27APR-T4.00:YES` → the ticker and the outcome: the same names the reader gives positions */
function parse(symbol: string): { ticker: string; outcome: Outcome } | undefined {
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*):(YES|NO)$/i.exec(symbol.trim());
  return m ? { ticker: m[1]!.toUpperCase(), outcome: m[2]!.toUpperCase() as Outcome } : undefined;
}

/** the YES leg's side of the book: buying YES and selling NO are bids, buying NO and selling YES are asks */
const sideOf = (outcome: Outcome, side: Side): BookSide => ((outcome === "YES") === (side === "buy") ? "bid" : "ask");

/** a limit price in the outcome's own terms as the YES-leg price Kalshi is sent, in centicents — or why Kalshi would not take it */
function limitYes(venue: string, name: string, m: Market, bands: Band[], outcome: Outcome, lp: number | undefined): number | Refusal {
  const c = (lp ?? NaN) * CC;
  if (!(lp !== undefined && lp > 0 && lp < 1) || Math.abs(c - Math.round(c)) > 1e-6) return badOrder(venue, name, "a price at Kalshi is in dollars, more than 0 and less than 1, at most four decimals", { limitPrice: lp });
  const yesC = outcome === "YES" ? Math.round(c) : CC - Math.round(c);
  if (onGrid(bands, yesC)) return yesC;
  const b = bandAt(bands, yesC);
  return badOrder(venue, name, `a price in ${m.name} moves in steps of ${plain((b?.step ?? 100) / CC)}${b ? ` between ${plain(outcome === "YES" ? b.start / CC : 1 - b.end / CC)} and ${plain(outcome === "YES" ? b.end / CC : 1 - b.start / CC)}` : ""}`, { limitPrice: lp, priceStep: (b?.step ?? 100) / CC });
}

const ET = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23" });
/** New York's wall clock at an instant, written as if it were UTC: less the instant, that is New York's offset from UTC then */
function etWall(ms: number): { y: number; mo: number; d: number; wall: number } {
  const p: Record<string, number> = {};
  for (const x of ET.formatToParts(new Date(ms))) if (x.type !== "literal") p[x.type] = Number(x.value);
  return { y: p.year!, mo: p.month!, d: p.day!, wall: Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) };
}

/** When a Kalshi day order placed at `nowMs` ends, in Unix seconds: 23:59:59 in New York that day. Kalshi's own Day deadline is
 * 11:59:59.999pm ET (fix/order-entry.md) and `expiration_time` takes whole seconds, so this is the last whole second before it, never after.
 * New York's offset is read at the deadline itself and not now, so a day on which the clocks change between EDT and EST ends at its own
 * midnight */
export function kalshiDayEnd(nowMs: number): number {
  const today = etWall(nowMs);
  const target = Date.UTC(today.y, today.mo - 1, today.d, 23, 59, 59);
  let at = target - (today.wall - Math.floor(nowMs / 1000) * 1000);
  at = target - (etWall(at).wall - at);
  return Math.floor(at / 1000);
}

/** What V2's create does not take, or not together, said before anything is sent. Every Kalshi event order is a limit order: market orders
 * were removed 2026-02-11 (the account's market order goes as a limit at its worst price that fills at once), and event contracts have no stop
 * orders — Kalshi's stop-loss and take-profit triggers belong to its margin product (/margin/…/exit_trigger, changelog 2026-08-20) */
function notTaken(order: OrderRequest, tif: TimeInForce, s: { ticker: string; outcome: Outcome }): string | undefined {
  const market = order.type === "market";
  if (!market && order.type !== "limit") return `Kalshi has no ${order.type === "stop_limit" ? "stop-limit" : String(order.type)} orders on event contracts: it takes limit orders, and the account's market order goes as a limit that fills at once`;
  if (!KALSHI_TIFS.includes(tif)) return `Kalshi takes good-till-canceled, immediate-or-cancel, fill-or-kill and day orders, not "${String(tif).slice(0, 20)}"`;
  if (market && (tif === "gtc" || tif === "day")) return "a market order at Kalshi is a limit at its worst price that fills at once (immediate-or-cancel), or all at once or not at all (fill-or-kill): one that rests on the book is a limit order";
  if (order.postOnly && market) return "post-only is for a limit order: a market order takes from the book";
  if (order.postOnly && (tif === "ioc" || tif === "fok")) return "a post-only order rests on the book as a maker: one that must fill at once never rests, so Kalshi would cancel it at once";
  if (order.reduceOnly && order.side === "buy") return `reduce-only at Kalshi is a sell of contracts held: a buy of ${s.ticker}:${s.outcome} only opens or grows a position in it (${s.ticker}:${s.outcome === "YES" ? "NO" : "YES"} held is reduced by selling it)`;
  // "Orders with reduce_only set to true will be rejected unless time_in_force is immediate_or_cancel" (create-order-v2.md)
  if (order.reduceOnly && tif !== "ioc") return "Kalshi takes reduce-only only on an order that fills at once (immediate-or-cancel): a market sell, or a limit sell with ioc";
  return undefined;
}

/** Kalshi's prices are dollar strings (the cent fields were removed 2026-01-15): a market without them is not one the account can price */
const dollarPriced = (m: Rec): boolean => ["yes_bid_dollars", "yes_ask_dollars", "last_price_dollars"].some((k) => typeof m[k] === "string");
/** a market the list offers: active (the only status that trades), dollar-priced, and not a combo (multivariate event) */
const tradable = (m: Rec): boolean => m.status === "active" && typeof m.ticker === "string" && !m.ticker.startsWith("KXMVE") && dollarPriced(m);
const byVolume = (a: Rec, b: Rec): number => num(b.volume_24h_fp) - num(a.volume_24h_fp) || num(b.volume_fp) - num(a.volume_fp);

const NOT_ACTIVE: Record<string, string> = {
  initialized: "not open for orders yet",
  inactive: "Kalshi has paused this market",
  closed: "closed: past its close time, waiting for its result",
  determined: "decided",
  disputed: "its result is disputed",
  amended: "its result was amended",
  finalized: "settled",
};

/** One Kalshi market as the account's market for one of its outcomes; NO is the other side of the same book. What the market's own answer
 * says beyond the order rules is kept: its close (`close_time`), the change since the last trade a day ago (`previous_price_dollars`
 * beside `last_price_dollars`, the outcome's own), its question (the market's ticker, which both outcomes share) and, when the caller
 * knows it, its event's category. Kalshi counts volume in contracts, not dollars (`volume_24h_fp`): it is carried as `contracts24h`, and no
 * dollar volume is said */
function toMarket(m: Rec, outcome: Outcome, paused?: string, caveat?: string, category?: string): Market {
  const ticker = String(m.ticker ?? "").toUpperCase();
  const yes = outcome === "YES";
  // an empty side of the book shows as 0 (no bid) or 1 (no ask) — OBSERVED — and neither is a price
  const px = (v: unknown): number | undefined => {
    const n = num(v);
    return n > 0 && n < 1 ? n : undefined;
  };
  const noBid = m.no_bid_dollars !== undefined ? m.no_bid_dollars : 1 - num(m.yes_ask_dollars);
  const noAsk = m.no_ask_dollars !== undefined ? m.no_ask_dollars : 1 - num(m.yes_bid_dollars);
  const bid = px(yes ? m.yes_bid_dollars : noBid);
  const ask = px(yes ? m.yes_ask_dollars : noAsk);
  const lastYes = px(m.last_price_dollars);
  const last = lastYes === undefined ? undefined : yes ? lastYes : round(1 - lastYes, 4);
  const price = last ?? (bid !== undefined && ask !== undefined ? round((bid + ask) / 2, 4) : undefined);
  const status = String(m.status ?? "");
  const open = status === "active" && !paused;
  const title = String(m.title ?? "").trim();
  const sub = String(m.yes_sub_title ?? "").trim();
  const words = title ? (sub && !title.includes(sub) ? `${title} (${sub})` : title) : sub || ticker;
  const closes = typeof m.close_time === "string" && m.close_time ? `closes ${m.close_time.replace("T", " ").replace(/:\d\d(\.\d+)?Z$/, " UTC")}` : "";
  const why = status === "active" ? paused : `${NOT_ACTIVE[status] ?? `its status at Kalshi is ${status || "unknown"}`}${status === "initialized" && typeof m.open_time === "string" ? `: opens ${m.open_time}` : ""}${(status === "determined" || status === "finalized") && typeof m.result === "string" && m.result ? `: ${m.result}` : ""}`;
  const note = [open ? closes : why, caveat].filter(Boolean).join(" · ");
  // the finest band's step: every valid price is a whole number of it. The coarsest would push the account's worst price for a market order
  // off the book on a mixed grid (a 0.048 ask, 2% over, floored to the cent, is 0.04); the trader checks the full grid before anything goes
  const priceStep = Math.min(...bandsOf(m).map((b) => b.step)) / CC;
  // the last trade a day ago: 0 when there was none (OBSERVED on markets made that day), which is no price. NO's price is 1 − YES's, so its
  // change is YES's turned over, and its percent is of NO's own price then
  const prevYes = px(m.previous_price_dollars);
  const change = lastYes !== undefined && prevYes !== undefined ? round((yes ? 1 : -1) * (lastYes - prevYes), 4) : undefined;
  const prev = prevYes === undefined ? undefined : yes ? prevYes : 1 - prevYes;
  const closeTime = typeof m.close_time === "string" && m.close_time ? m.close_time : undefined;
  // the market's 24 hours in contracts, as Kalshi counts them (volume_24h_fp, a fixed-point count): a market, so both of its legs carry it
  const vol = m.volume_24h_fp === undefined || m.volume_24h_fp === null || m.volume_24h_fp === "" ? Number.NaN : Number(m.volume_24h_fp);
  const contracts = Number.isFinite(vol) && vol >= 0 ? vol : undefined;
  // What V2's create takes in every event market: limit orders (the account's market order goes as one), the four times in force above,
  // post_only, and reduce_only — which Kalshi takes only on an order that fills at once, so the trader holds it to a sell sent ioc
  return { symbol: `${ticker}:${outcome}`, name: `${words} · ${yes ? "Yes" : "No"}`, kind: "event", base: `${ticker}:${outcome}`, quote: "USD", price, bid, ask, minQty: COUNT_STEP, qtyStep: COUNT_STEP, priceStep, open, ...(note ? { note } : {}), types: ["market", "limit"], tifs: [...KALSHI_TIFS], tifsByType: { market: ["ioc", "fok"], limit: [...KALSHI_TIFS] }, postOnly: true, reduceOnly: true,
    ...(change !== undefined && prev !== undefined ? { change24h: change, changePct24h: round((change / prev) * 100, 2) } : {}), ...(contracts !== undefined ? { contracts24h: contracts } : {}), ...(closeTime ? { closeTime } : {}), ...(category ? { category } : {}), group: { id: ticker, title: words }, outcome };
}

/** a market with a result: it pays $1 a contract to the side that won and nothing to the other, whatever its last trade was */
const decided = (m: Rec | undefined): boolean => m?.result === "yes" || m?.result === "no";
/** what one contract of an outcome is worth now: $1 or $0 once its market has a result, else its price (the last trade, or the middle of
 * the book); nothing when the market shows neither */
function markOf(m: Rec | undefined, outcome: Outcome): number | undefined {
  if (!m) return undefined;
  return decided(m) ? (m.result === outcome.toLowerCase() ? 1 : 0) : toMarket(m, outcome).price;
}

/** a category as words to compare: "Climate and Weather", "climate-and-weather" and "CLIMATE AND WEATHER" are one */
const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Kalshi keeps candles of 1, 60 and 1440 minutes (get-market-candlesticks.md; asked for 5 it answers none — OBSERVED): five minutes are five
 * one-minute candles folded together */
const PERIOD_MIN: Record<CandleInterval, number> = { "5m": 1, "1h": 60, "1d": 1440 };
const FOLD_MS: Partial<Record<CandleInterval, number>> = { "5m": 5 * 60_000 };
/** a dollar string Kalshi gave, or nothing for a field that is absent or null (a candle's prices are null when nothing traded) */
const dollars = (v: unknown): number | undefined => (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);

/** Kalshi's answer that is not a yes, as the account's refusal, with Kalshi's own words in `native`. Kalshi does not enumerate its REST
 * order-error codes, so this reads the HTTP status first and then the words: `available_balance_too_low` and `invalid_order_size` are
 * documented (changelog 2026-01-26); the rest are the exchange's own reason names (MARKET_INACTIVE, INVALID_PRICE …, fix/order-entry.md).
 * Error bodies come nested ({error: {code, message, details}} — OBSERVED), flat (the OpenAPI shape), or as a string on a 429. */
function kalshiNo(venue: string, name: string, r: HttpReply, secrets: string[], shard?: number): Refusal {
  const b = isRec(r.body) ? r.body : undefined;
  const e = b && isRec(b.error) ? b.error : (b ?? {});
  const words = typeof b?.error === "string" ? b.error : [e.code, e.details, e.message].filter((x): x is string => typeof x === "string" && x !== "").join(" · ");
  // redacted before anything else is done to it: a PEM has line breaks, and folding them first would hide it from redact()
  const text = redact(words || r.text || "", secrets);
  const native = { status: r.status, said: saidOf(text, secrets) };
  if (r.status === 429 || r.status === 401 || r.status === 0 || r.status >= 500) return venueSaidNo(venue, name, r.status, text, secrets);
  // where the account is: Kalshi's own rule — a lapsed location attestation, for one, stops a key in Sports, Elections and Entertainment markets
  if (r.status === 451 || REGION.test(text) || /attest/i.test(text) || (r.status === 403 && /location/i.test(text))) return no("E_VENUE_GEOBLOCKED", { venue, message: `${name} does not take this order from where this account is: that is its own rule, and the account does not look for a way around it`, native });
  if (r.status === 403) return no("E_VENUE_PERMISSION", { venue, message: `${name} refused: this key may not trade. A Kalshi key keeps the scopes it was made with; one that trades has write (or write::trade)`, native });
  const t = text.toLowerCase();
  if (/balance_too_low|insufficient/.test(t)) return no("E_VENUE_INSUFFICIENT", { venue, message: `${name}: not enough cash for this order on the exchange shard its market trades on${shard !== undefined ? ` (shard ${shard})` : ""}. An order sent through Kalshi's API counts only the cash already on that shard`, native });
  if (/invalid_order_size|incorrect quantity|order size/.test(t)) return { ...badOrder(venue, name, "Kalshi does not take an order of this size (counts are in steps of 0.01 contracts)"), native };
  if (/market_inactive|market_already_closed|market_closed|market is closed|not active|exchange_paused|trading_paused|paused/.test(t)) return no("E_VENUE_MARKET_CLOSED", { venue, message: `${name}: the market takes no orders now`, native });
  // a post-only order that would cross is canceled rather than refused (its last_update_reason is PostOnlyCrossCancel, changelog 2026-06-04),
  // but a batch reported it as an error ("invalid order" · "post only cross", changelog 2025-10-24): either way it is said as what it is
  if (/post.?only/.test(t)) return { ...badOrder(venue, name, "post-only: at this price the order would have taken from the book at once, so Kalshi did not rest it"), native };
  if (/invalid_price|price|tick/.test(t)) return { ...badOrder(venue, name, "the price is not on this market's price grid"), native };
  if (/risk_limit|position limit|position_floor/.test(t)) return { ...badOrder(venue, name, "over Kalshi's limit for one market"), native };
  if (/invalid_order/.test(t)) return { ...badOrder(venue, name, "Kalshi does not take this order as written"), native };
  return no("E_VENUE_REJECTED", { venue, message: `${name} refused the request (HTTP ${r.status})`, native });
}

interface Look {
  m: Rec;
  at: number;
  paused?: string | undefined;
  caveat?: string | undefined;
}

/** the trader: Kalshi's V2 order endpoints, in the account's terms */
function kalshiTrader(o: { venue: string; name: string; keyId: string; call: Call; clock: () => number; secrets: string[] }): LiveTrader {
  const { venue, name, call, secrets } = o;
  const fail = (r: HttpReply, shard?: number) => kalshiNo(venue, name, r, secrets, shard);
  const badSymbol = (symbol: string) => no("E_ACCOUNT_BAD_ACTION", { venue, message: `a Kalshi market is named <ticker>:YES or <ticker>:NO, not "${symbol.slice(0, 60)}"` });
  const looks = new Map<string, Look>();
  let scopes: { at: number; can: boolean | "unknown"; list?: string[]; caveat?: string } | undefined;
  /** a key Kalshi lists without a trading scope: its write is refused here, never sent */
  const mayNot = () => no("E_VENUE_PERMISSION", { venue, message: `${name}: this key may not trade — Kalshi lists its scopes as ${scopes?.list?.join(", ") || "none"}. A Kalshi key keeps the scopes it was made with: make one with write (or write::trade) at Kalshi`, native: { scopes: scopes?.list } });
  let universe: { at: number; list: Market[]; raw: Rec[] } | undefined;
  const eventsSeen = new Map<string, { at: number; ev: Rec }>();
  const series = new Map<string, { at: number; list: Rec[] }>();

  /** What the key may do: GET /api_keys lists the account's keys with their scopes (read-only keys exist since 2025-12-18). Learned when the
   * trader is first used, not at connect, and again every five minutes; until then, and if Kalshi does not say, `can` is "unknown" and a
   * 403 on the order says it instead. */
  const learn = async (): Promise<void> => {
    const now = o.clock();
    if (scopes && now - scopes.at < LIST_MS) return;
    try {
      const r = await call("GET", "/api_keys");
      const b = isRec(r.body) ? r.body : {};
      const mine = r.status === 200 && Array.isArray(b.api_keys) ? (b.api_keys as unknown[]).filter(isRec).find((k) => k.api_key_id === o.keyId) : undefined;
      if (!mine || !Array.isArray(mine.scopes)) {
        scopes = { at: now, can: "unknown" };
        return;
      }
      const list = (mine.scopes as unknown[]).map(String);
      // a key tied to an FCM sub-trader is "denied on every REST endpoint"
      const can = !mine.fcm_subtrader_id && (list.includes("write") || list.includes("write::trade"));
      // "Once this date has passed, API keys are not valid for trading Sports, Elections, and Entertainment markets" (changelog 2026-08-16); absent: never attested
      const exp = b.api_key_region_expiration_ts;
      const lapsed = typeof exp !== "number" || exp * 1000 < now;
      scopes = { at: now, can, list, ...(lapsed ? { caveat: "Kalshi shows no current location attestation for this key's account: by Kalshi's own rule it takes no API orders in Sports, Elections and Entertainment markets without one" } : {}) };
    } catch {
      scopes = { at: now, can: "unknown" };
    }
  };

  /** Kalshi pauses trading (every Thursday 03:00–05:00 ET, and when it must): the exchange and each shard say so. A 503 here still carries
   * the answer (OBSERVED on demo). No answer at all closes nothing: the order itself would hear Kalshi's no. */
  const pausedFor = async (): Promise<(shard: number) => string | undefined> => {
    try {
      const r = await call("GET", "/exchange/status");
      const b = isRec(r.body) ? r.body : undefined;
      if (!b) return () => undefined;
      const shards = Array.isArray(b.exchange_index_statuses) ? (b.exchange_index_statuses as unknown[]).filter(isRec) : [];
      return (shard) => {
        const s = shards.find((x) => x.exchange_index !== undefined && num(x.exchange_index) === shard);
        return b.exchange_active === false || b.trading_active === false || s?.exchange_active === false || s?.trading_active === false ? "Kalshi has paused trading now (its scheduled maintenance is Thursdays 03:00–05:00 ET)" : undefined;
      };
    } catch {
      return () => undefined;
    }
  };

  /** GET /markets/{ticker}, the exchange's status and the key's scopes, together; the look is kept for the order that follows it */
  const look = async (ticker: string): Promise<Look | Refusal> => {
    const [r, paused] = await Promise.all([call("GET", `/markets/${enc(ticker)}`), pausedFor(), learn()]);
    if (r.status === 404) return no("E_VENUE_REJECTED", { venue, message: `${name} has no market ${ticker}`, native: { status: 404, said: saidOf(r.text, secrets) } });
    if (r.status !== 200) return fail(r);
    const m = isRec(r.body) && isRec(r.body.market) ? r.body.market : undefined;
    if (!m) return no("E_VENUE_REJECTED", { venue, message: `${name} answered without the market ${ticker}` });
    if (!dollarPriced(m)) return no("E_ACCOUNT_UNPRICED", { venue, message: `${name} shows no dollar price for ${ticker}: the account trades markets priced in dollars` });
    const l: Look = { m, at: o.clock(), paused: paused(num(m.exchange_index)), caveat: scopes?.caveat };
    looks.set(ticker, l);
    if (looks.size > 200) looks.delete(looks.keys().next().value!);
    return l;
  };
  const recent = async (ticker: string): Promise<Look | Refusal> => {
    const l = looks.get(ticker);
    return l && o.clock() - l.at < FRESH_MS ? l : look(ticker);
  };

  const listed = async (path: string): Promise<Rec[]> => {
    const r = await call("GET", path);
    if (r.status !== 200 || !isRec(r.body)) throw fail(r);
    return Array.isArray(r.body.markets) ? (r.body.markets as unknown[]).filter(isRec) : [];
  };
  /** what a search runs over, five minutes at a time: the open markets (combos left out), and the well-known series' most-traded first */
  const all = async (): Promise<Market[]> => {
    const now = o.clock();
    if (universe && now - universe.at < LIST_MS) return universe.list;
    const [general, ...known] = await Promise.all([listed("/markets?status=open&mve_filter=exclude&limit=1000"), ...KNOWN.map((s) => listed(`/markets?status=open&series_ticker=${s}&limit=200`).catch(() => [] as Rec[]))]);
    const firsts = known.map((ms) => ms.filter(tradable).sort(byVolume)[0]).filter((m): m is Rec => m !== undefined);
    const ordered = new Map<string, Rec>();
    for (const m of [...firsts, ...[...general!, ...known.flat()].filter(tradable).sort(byVolume)]) if (!ordered.has(String(m.ticker))) ordered.set(String(m.ticker), m);
    const raw = [...ordered.values()];
    universe = { at: now, list: raw.flatMap((m) => [toMarket(m, "YES"), toMarket(m, "NO")]), raw };
    return universe.list;
  };
  /** The markets closing between two instants (Unix seconds): GET /markets?min_close_ts=&max_close_ts=, which Kalshi takes with no status or
   * `closed` only (get-markets.md, its table of filters), so the active ones are kept by the caller. Combos left out; three pages at most */
  const closing = async (from: number, to: number): Promise<Rec[]> => {
    const out: Rec[] = [];
    let cursor = "";
    for (let page = 0; page < 3; page++) {
      const r = await call("GET", `/markets?min_close_ts=${from}&max_close_ts=${to}&mve_filter=exclude&limit=1000${cursor ? `&cursor=${enc(cursor)}` : ""}`);
      if (r.status !== 200 || !isRec(r.body)) throw fail(r);
      out.push(...(Array.isArray(r.body.markets) ? (r.body.markets as unknown[]).filter(isRec) : []));
      cursor = typeof r.body.cursor === "string" ? r.body.cursor : "";
      if (!cursor) break;
    }
    return out;
  };
  /** The events of some markets, for their category: GET /events?tickers=… (get-events.md), a hundred at a time, kept five minutes. Kalshi
   * marks an event's `category` deprecated and still sends it (OBSERVED); markets carry none of their own */
  const eventsOf = async (tickers: string[]): Promise<Map<string, Rec>> => {
    const now = o.clock();
    const out = new Map<string, Rec>();
    const wanted: string[] = [];
    for (const t of new Set(tickers.filter(Boolean))) {
      const hit = eventsSeen.get(t);
      if (hit && now - hit.at < LIST_MS) out.set(t, hit.ev);
      else wanted.push(t);
    }
    for (let i = 0; i < wanted.length; i += 100) {
      const chunk = wanted.slice(i, i + 100);
      const r = await call("GET", `/events?tickers=${chunk.map(enc).join(",")}&limit=${chunk.length}`);
      if (r.status !== 200 || !isRec(r.body)) throw fail(r);
      for (const ev of Array.isArray(r.body.events) ? (r.body.events as unknown[]).filter(isRec) : []) {
        const t = String(ev.event_ticker ?? "");
        out.set(t, ev);
        eventsSeen.set(t, { at: now, ev });
      }
    }
    if (eventsSeen.size > 2000) eventsSeen.clear();
    return out;
  };
  /** a query that looks like a ticker is also asked of its series (GET /markets?series_ticker=), which the list of the newest may not hold */
  const ofSeries = async (root: string): Promise<Market[]> => {
    const now = o.clock();
    let s = series.get(root);
    if (!s || now - s.at >= LIST_MS) {
      s = { at: now, list: await listed(`/markets?status=open&series_ticker=${enc(root)}&limit=200`).catch(() => [] as Rec[]) };
      if (series.size > 50) series.clear();
      series.set(root, s);
    }
    return s.list.filter(tradable).sort(byVolume).flatMap((m) => [toMarket(m, "YES"), toMarket(m, "NO")]);
  };

  /** the fills of one order (GET /portfolio/fills): each states its price in YES and in NO terms, so the average is the outcome's own */
  const fillsOf = async (ref: string, outcome: Outcome): Promise<{ avg: number; fee: number } | undefined> => {
    try {
      const r = await call("GET", `/portfolio/fills?order_id=${enc(ref)}&limit=200`);
      if (r.status !== 200 || !isRec(r.body) || !Array.isArray(r.body.fills)) return undefined;
      let n = 0;
      let cost = 0;
      let fee = 0;
      for (const f of (r.body.fills as unknown[]).filter(isRec)) {
        const c = num(f.count_fp);
        n += c;
        cost += c * num(outcome === "YES" ? f.yes_price_dollars : f.no_price_dollars);
        fee += num(f.fee_cost);
      }
      return n > 0 ? { avg: round(cost / n), fee: round(fee) } : undefined;
    } catch {
      return undefined;
    }
  };

  /** an Order object (GET /portfolio/orders/{id}) as the account's order: resting · executed · canceled; there is no pending since 2025-11 */
  const stateOf = async (ord: Rec, outcome: Outcome | undefined): Promise<OrderState> => {
    const filled = num(ord.fill_count_fp);
    const lapsed = typeof ord.expiration_time === "string" && typeof ord.last_update_time === "string" && Date.parse(ord.last_update_time) >= Date.parse(ord.expiration_time);
    const status: OrderStatus = ord.status === "executed" ? "filled" : ord.status === "canceled" ? (lapsed ? "expired" : "canceled") : ord.status === "resting" ? (filled > 0 ? "partial" : "open") : "pending";
    const fee = num(ord.taker_fees_dollars) + num(ord.maker_fees_dollars);
    const f = filled > 0 && outcome ? await fillsOf(String(ord.order_id ?? ""), outcome) : undefined;
    return { ref: String(ord.order_id ?? ""), status, filledQty: filled, ...(f ? { avgPrice: f.avg } : {}), ...(filled > 0 || fee > 0 ? { feeUsd: round(fee) } : {}), native: ord };
  };

  /** GET /portfolio/orders/{id}: the order as Kalshi has it now */
  const orderOf = async (ref: string): Promise<Rec | Refusal> => {
    const r = await call("GET", `/portfolio/orders/${enc(ref)}`);
    if (r.status === 404) return no("E_ACCOUNT_ORDER_UNKNOWN", { venue, message: `${name} has no order ${ref} for this key (an order done before Kalshi's historical cutoff is only in GET /historical/orders)`, native: { status: 404, said: saidOf(r.text, secrets) } });
    if (r.status !== 200) return fail(r);
    const ord = isRec(r.body) && isRec(r.body.order) ? r.body.order : undefined;
    return ord ?? no("E_VENUE_REJECTED", { venue, message: `${name} answered without the order ${ref}` });
  };

  const status = async (ref: string, symbol: string): Promise<OrderState | Refusal> => {
    try {
      const ord = await orderOf(ref);
      return isRefusal(ord) ? ord : await stateOf(ord, parse(symbol)?.outcome);
    } catch (err) {
      return asRefusal(venue, name, err, secrets);
    }
  };

  /** What of one outcome is free to sell: what is held (GET /portfolio/positions?ticker=), less what the orders already resting on the same
   * side of the book will take out of it first (GET /portfolio/orders?status=resting). Kalshi nets a market into one position, so selling
   * past it would buy the other side */
  const freeToSell = async (ticker: string, outcome: Outcome, side: BookSide): Promise<{ held: number; resting: number; free: number; position: unknown } | Refusal> => {
    const [r, os] = await Promise.all([call("GET", `/portfolio/positions?ticker=${enc(ticker)}&limit=200`), call("GET", `/portfolio/orders?ticker=${enc(ticker)}&status=resting&limit=200`)]);
    if (r.status !== 200 || !isRec(r.body)) return fail(r);
    if (os.status !== 200 || !isRec(os.body)) return fail(os);
    const p = (Array.isArray(r.body.market_positions) ? (r.body.market_positions as unknown[]).filter(isRec) : []).find((x) => String(x.ticker ?? "").toUpperCase() === ticker);
    const n = num(p?.position_fp);
    const held = outcome === "YES" ? Math.max(0, n) : Math.max(0, -n);
    const resting = round((Array.isArray(os.body.orders) ? (os.body.orders as unknown[]).filter(isRec) : []).filter((x) => x.book_side === side).reduce((a, x) => a + num(x.remaining_count_fp), 0), 2);
    return { held, resting, free: Math.max(0, round(held - resting, 2)), position: p ?? { market_positions: [] } };
  };

  /** The markets of some tickers, for their names and prices: GET /markets?tickers=… (comma-separated, get-markets.md), of any status — a
   * position outlives its market's close until it settles — a hundred at a time. A page that cannot be read leaves its positions named by
   * their ticker, with what they cost and no price */
  const marketsOf = async (tickers: string[]): Promise<Map<string, Rec>> => {
    const out = new Map<string, Rec>();
    const wanted = [...new Set(tickers)];
    for (let i = 0; i < wanted.length; i += 100) {
      const chunk = wanted.slice(i, i + 100);
      for (const m of await listed(`/markets?tickers=${chunk.map(enc).join(",")}&limit=${chunk.length}`).catch(() => [] as Rec[])) out.set(String(m.ticker ?? "").toUpperCase(), m);
    }
    return out;
  };

  /** An order Kalshi did not answer for (a timeout, a 5xx) or answered 409 for (that client id is taken) may be at Kalshi already: look for it
   * by its client id before saying no. The same order is the order; another one under the same id is refused, never placed twice. */
  const findSent = async (ticker: string, body: Rec, outcome: Outcome): Promise<OrderState | Refusal | undefined> => {
    try {
      const r = await call("GET", `/portfolio/orders?ticker=${enc(ticker)}&limit=200`);
      if (r.status !== 200 || !isRec(r.body) || !Array.isArray(r.body.orders)) return undefined;
      const ord = (r.body.orders as unknown[]).filter(isRec).find((x) => x.client_order_id === body.client_order_id);
      if (!ord) return undefined;
      const same = ord.book_side === body.side && Math.abs(num(ord.yes_price_dollars) - Number(body.price)) < 1e-9 && Math.abs(num(ord.initial_count_fp) - Number(body.count)) < 1e-9;
      if (!same) return no("E_VENUE_REJECTED", { venue, message: `${name} already has an order with the id ${String(body.client_order_id)}, and it is not this one: nothing was placed`, native: { order_id: ord.order_id, ticker: ord.ticker, book_side: ord.book_side, yes_price_dollars: ord.yes_price_dollars, initial_count_fp: ord.initial_count_fp } });
      return await stateOf(ord, outcome);
    } catch {
      return undefined;
    }
  };

  return {
    get can() {
      return scopes?.can ?? "unknown";
    },
    what: "event contracts: YES or NO on Kalshi's markets",

    async markets(query) {
      try {
        void learn();
        const q = query.trim();
        let list = await all();
        if (q && pick(list, q).length < 20 && /^[A-Za-z0-9][A-Za-z0-9._-]*(:(YES|NO))?$/i.test(q)) {
          const more = await ofSeries(q.split(/[-:]/)[0]!.toUpperCase());
          const have = new Set(list.map((m) => m.symbol));
          list = [...list, ...more.filter((m) => !have.has(m.symbol))];
        }
        return pick(list, q);
      } catch (err) {
        return asRefusal(venue, name, err, secrets);
      }
    },

    async market(symbol) {
      try {
        const s = parse(symbol);
        if (!s) return badSymbol(symbol);
        const l = await look(s.ticker);
        return isRefusal(l) ? l : toMarket(l.m, s.outcome, l.paused, l.caveat);
      } catch (err) {
        return asRefusal(venue, name, err, secrets);
      }
    },

    async place(order: OrderRequest) {
      try {
        const s = parse(order.symbol);
        if (!s) return badSymbol(order.symbol);
        if (!(order.qty >= COUNT_STEP - 1e-12) || !onStep(order.qty, COUNT_STEP)) return badOrder(venue, name, "a count at Kalshi is in steps of 0.01 contracts, at least 0.01", { qty: order.qty, qtyStep: COUNT_STEP });
        const market = order.type === "market";
        // how long it stays, as asked, or as it always was here when not: a market order fills at once, a limit order rests until canceled
        const tif: TimeInForce = order.tif ?? (market ? "ioc" : "gtc");
        const why = notTaken(order, tif, s);
        if (why) return badOrder(venue, name, why);
        let expires: number | undefined;
        if (tif === "day") {
          const now = o.clock();
          expires = kalshiDayEnd(now);
          if (expires - now / 1000 < DAY_MARGIN_S) return badOrder(venue, name, "a day order at Kalshi ends at 11:59:59pm ET, seconds from now: it would end before it rested. Send it good-till-canceled, or after midnight ET", { expiresAt: expires });
        }
        const l = await recent(s.ticker);
        if (isRefusal(l)) return l;
        const m = toMarket(l.m, s.outcome, l.paused, l.caveat);
        if (scopes?.can === false) return mayNot();
        if (!m.open) return no("E_VENUE_MARKET_CLOSED", { venue, message: `${name}: ${m.name} takes no orders now${m.note ? ` (${m.note})` : ""}` });
        const bands = bandsOf(l.m);
        // the YES leg: buying YES and selling NO are bids, buying NO and selling YES are asks, and a NO price n is the YES price 1 − n
        const side = sideOf(s.outcome, order.side);
        const yesOf = (outcomeC: number) => (s.outcome === "YES" ? outcomeC : CC - outcomeC);
        let yesC: number;
        if (order.type === "limit") {
          const p = limitYes(venue, name, m, bands, s.outcome, order.limitPrice);
          if (isRefusal(p)) return p;
          yesC = p;
        } else {
          // Kalshi takes no market orders (removed 2026-02-11). The account's market order is an immediate-or-cancel limit at the worst price
          // the account gave it (trade.ts: the most a buy pays, the least a sell takes), or, without one, at the book the account just looked
          // at — put on the grid in the safe direction: it fills at that price or better, and what does not fill there at once is canceled
          // (or, sent fill-or-kill, all of it fills there at once or none does).
          const book = order.side === "buy" ? m.ask : m.bid;
          if (book === undefined) return badOrder(venue, name, `no one is ${order.side === "buy" ? "selling" : "buying"} ${m.name} right now, so a market order has nothing to take: try a limit order`);
          const at = order.worstPrice !== undefined && order.worstPrice > 0 ? order.worstPrice : book;
          // $0 and $1 are not prices at Kalshi: a bid starts under $1, an ask over $0 — tighter, never looser
          const snapped = snapTo(bands, Math.min(CC - 1, Math.max(1, yesOf(Math.round(at * CC)))), side === "bid" ? "down" : "up");
          if (snapped === undefined) return badOrder(venue, name, `${plain(at)} has no price on ${m.name}'s grid to send a market order at: try a limit order`);
          yesC = snapped;
        }
        // A sell is of contracts held. Kalshi nets a market into one position, so an ask on YES that finds no YES held opens NO instead — a
        // purchase, and at a low price a far bigger one than the sell was valued at. So what is free to sell is read first: what is held, less
        // what the orders already resting on the same side of the book will take out of it before this one. A sell that fills at once
        // (immediate-or-cancel: a market sell, or a limit sell sent ioc) also goes reduce_only, which Kalshi takes only then. A resting sell,
        // or a fill-or-kill one, cannot be reduce_only: it is held to what is free when it is placed, and every later sell here counts it.
        if (order.side === "sell") {
          const f = await freeToSell(s.ticker, s.outcome, side);
          if (isRefusal(f)) return f;
          const { held, resting, free } = f;
          if (order.qty > free + 1e-9) return no("E_VENUE_INSUFFICIENT", { venue, message: `${name}: you hold ${plain(held)} ${m.symbol}${resting > 0 ? `, and orders already resting on Kalshi's book sell ${plain(Math.min(resting, held))} of it: ${plain(free)} is free to sell, fewer than the ${plain(order.qty)} asked` : `, fewer than the ${plain(order.qty)} to sell`}. A sell here is of what is held: selling more at Kalshi would buy the other side`, detail: { held, qty: order.qty, ...(resting > 0 ? { resting } : {}) }, native: f.position });
        }
        const body: Rec = {
          ticker: s.ticker,
          side,
          count: order.qty.toFixed(2),
          price: (yesC / CC).toFixed(4),
          time_in_force: TIF_WIRE[tif],
          // required on V2: an order that would match the account's own resting order is the one canceled, and what matched stands
          self_trade_prevention_type: "taker_at_cross",
          // the account's id is Kalshi's idempotency key: a second order under it is refused with 409. The docs say only "string" (and
          // suggest a UUID): it is kept to letters, digits, dashes and underscores
          client_order_id: order.clientId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64),
          // a day order: good_till_canceled with the day's deadline, in Unix seconds
          ...(expires !== undefined ? { expiration_time: expires } : {}),
          ...(order.postOnly ? { post_only: true } : {}),
          ...((order.reduceOnly || order.side === "sell") && tif === "ioc" ? { reduce_only: true } : {}),
        };
        // no answer, a 5xx, or a 201 that could not be read, and the order not among Kalshi's yet: it may be there all the same — never "not placed"
        const unknown = (why: string, native: unknown) => no("E_VENUE_UNREACHABLE", { venue, message: `${name} ${why}, and it is not among Kalshi's orders yet: it may have been taken all the same. Look at Kalshi's orders for ${String(body.client_order_id)} before placing it again`, detail: { clientOrderId: body.client_order_id, placed: "unknown" }, native });
        let r: HttpReply;
        try {
          r = await call("POST", "/portfolio/events/orders", body);
        } catch (err) {
          const found = await findSent(s.ticker, body, s.outcome);
          return found ?? unknown("did not answer the order", isRefusal(err) ? err.native : undefined);
        }
        if ((r.status === 201 || r.status === 200) && isRec(r.body) && typeof r.body.order_id === "string") return await placed(r.body, order.qty, s.outcome);
        if (r.status === 409 || r.status >= 500 || r.status === 201 || r.status === 200) {
          const found = await findSent(s.ticker, body, s.outcome);
          if (found) return found;
          if (r.status === 409) return no("E_VENUE_REJECTED", { venue, message: `${name} already has an order with the id ${String(body.client_order_id)}: nothing was placed`, native: { status: 409, said: saidOf(r.text, secrets) } });
          return unknown(r.status >= 500 ? `answered the order with HTTP ${r.status}` : "took the order without saying its id", { status: r.status, said: saidOf(r.text, secrets) });
        }
        return fail(r, l.m.exchange_index !== undefined ? num(l.m.exchange_index) : undefined);
      } catch (err) {
        return asRefusal(venue, name, err, secrets);
      }
    },

    async cancel(ref, symbol) {
      try {
        const s = parse(symbol);
        // the market's ticker routes the cancel to its shard: "an order ID alone cannot identify the exchange shard"
        if (!s) return badSymbol(symbol);
        const r = await call("DELETE", `/portfolio/events/orders/${enc(ref)}?market_ticker=${enc(s.ticker)}`);
        // already filled or canceled is a 404 too: the order as it stands, if Kalshi still has it — and if it is still on the book, Kalshi did not
        // take the cancel, which is said as that rather than handed back as a cancel on its way
        if (r.status === 404) {
          const now = await status(ref, symbol);
          if (isRefusal(now) || (now.status !== "open" && now.status !== "partial" && now.status !== "pending")) return now;
          return no("E_VENUE_REJECTED", { venue, message: `${name} did not take the cancel (HTTP 404), and the order is still on its book: cancel it at Kalshi`, native: { status: 404, said: saidOf(r.text, secrets), order: now.native } });
        }
        if (r.status !== 200) return fail(r);
        // the cancel's answer is {order_id, reduced_by, …}, and "in certain uncommon cases" described another order: the order itself is read
        const now = await status(ref, symbol);
        if (!isRefusal(now)) return { ...now, native: { cancel: r.body, order: now.native } };
        return no("E_VENUE_UNREACHABLE", { venue, message: `${name} took the cancel (${plain(num(isRec(r.body) ? r.body.reduced_by : 0))} contracts off the book), but the order could not be read back: it is read again in a few seconds`, native: { cancel: r.body, read: now.native } });
      } catch (err) {
        return asRefusal(venue, name, err, secrets);
      }
    },

    status,

    /** A resting order changed in place: POST /portfolio/events/orders/{id}/amend (amend-order-v2.md). Its body is the order's whole new
     * terms — ticker, side, price and count, all four required — and `count` is the order's whole size, "already filled count plus the
     * desired resting remaining count", as the account's qty is. "Amending only expiry or decreasing size preserves queue position.
     * Increasing size or changing price forfeits queue position." An amend that leaves `expiration_time` out keeps the order's expiry, so a
     * day order stays one. Kalshi has no stop to change. */
    async amend(ref, symbol, change, order) {
      try {
        const s = parse(symbol);
        if (!s) return badSymbol(symbol);
        if (change.stopPrice !== undefined) return badOrder(venue, name, "Kalshi has no stop orders on event contracts: there is no stop price to change");
        if (change.qty === undefined && change.limitPrice === undefined) return no("E_ACCOUNT_BAD_ACTION", { venue, message: "a change to an order at Kalshi is a new size, a new limit, or both: neither was given" });
        if (change.qty !== undefined && (!(change.qty >= COUNT_STEP - 1e-12) || !onStep(change.qty, COUNT_STEP))) return badOrder(venue, name, "a count at Kalshi is in steps of 0.01 contracts, at least 0.01", { qty: change.qty, qtyStep: COUNT_STEP });
        const l = await recent(s.ticker);
        if (isRefusal(l)) return l;
        const m = toMarket(l.m, s.outcome, l.paused, l.caveat);
        if (scopes?.can === false) return mayNot();
        // a paused market takes no amend either: while trading is paused only cancels go through (maintenance_and_pauses.md)
        if (!m.open) return no("E_VENUE_MARKET_CLOSED", { venue, message: `${name}: ${m.name} takes no orders now${m.note ? ` (${m.note})` : ""}` });
        const side = sideOf(s.outcome, order.side);
        const asked = change.limitPrice === undefined ? undefined : limitYes(venue, name, m, bandsOf(l.m), s.outcome, change.limitPrice);
        if (isRefusal(asked)) return asked;
        // the order as Kalshi has it now: what is not changed is sent as Kalshi has it, not as the account remembers it
        const live = await orderOf(ref);
        if (isRefusal(live)) return live;
        if (String(live.ticker ?? "").toUpperCase() !== s.ticker || live.book_side !== side) return no("E_VENUE_REJECTED", { venue, message: `${name}'s order ${ref} is ${live.book_side === "bid" ? "a bid" : live.book_side === "ask" ? "an ask" : "an order"} on ${String(live.ticker ?? "another market")}, not the ${order.side} of ${m.symbol} it was taken for: nothing was changed`, native: { order_id: live.order_id, ticker: live.ticker, book_side: live.book_side } });
        if (live.status !== "resting") {
          const was = await stateOf(live, s.outcome);
          return no("E_VENUE_REJECTED", { venue, message: `${name}: the order is no longer on the book (${was.status}${was.filledQty > 0 ? `, ${plain(was.filledQty)} filled` : ""}): there is nothing to change`, native: { order: live } });
        }
        const filled = num(live.fill_count_fp);
        const total = round(filled + num(live.remaining_count_fp), 2);
        // a portfolio answer carries up to six decimals; a request takes two to four, and an unchanged price goes back as it rests
        const nowC = Math.round(num(live.yes_price_dollars) * CC);
        const yesC = asked ?? nowC;
        const count = change.qty ?? total;
        if (count <= filled + 1e-9) return badOrder(venue, name, `${plain(filled)} of this order has filled already: its size can come down to more than that, not to ${plain(count)}. To stop the rest, cancel it`, { qty: count, filledQty: filled });
        // already so: nothing is sent
        if (yesC === nowC && Math.abs(count - total) < 1e-9) return await stateOf(live, s.outcome);
        // a sell made bigger sells more of what is held: the more must be free, as for a new sell (this order's own rest already counts)
        const more = round(count - total, 2);
        if (order.side === "sell" && more > 0) {
          const f = await freeToSell(s.ticker, s.outcome, side);
          if (isRefusal(f)) return f;
          if (more > f.free + 1e-9) return no("E_VENUE_INSUFFICIENT", { venue, message: `${name}: you hold ${plain(f.held)} ${m.symbol}, and orders resting on Kalshi's book, this one among them, already sell ${plain(Math.min(f.resting, f.held))} of it: ${plain(f.free)} more is free to sell, fewer than the ${plain(more)} more asked. A sell here is of what is held: selling more at Kalshi would buy the other side`, detail: { held: f.held, resting: f.resting, more }, native: f.position });
        }
        const body: Rec = { ticker: s.ticker, side, price: (yesC / CC).toFixed(4), count: count.toFixed(2) };
        // An amend sets the price and the size, it does not add to them: sent twice, it is the same change. One Kalshi did not answer is read
        // back — made, if the order shows it; if not, said as unknown, never as "not changed"
        const unanswered = async (why: string, native: unknown): Promise<OrderState | Refusal> => {
          const back = await orderOf(ref).catch(() => undefined);
          if (back && !isRefusal(back) && Math.round(num(back.yes_price_dollars) * CC) === yesC && Math.abs(num(back.fill_count_fp) + num(back.remaining_count_fp) - count) < 1e-9) return await stateOf(back, s.outcome);
          return no("E_VENUE_UNREACHABLE", { venue, message: `${name} ${why}, and the order does not show the change yet: it may have been made all the same. Read the order before changing it again (sent again, the same change is the same change)`, detail: { ref, changed: "unknown" }, native });
        };
        let r: HttpReply;
        try {
          r = await call("POST", `/portfolio/events/orders/${enc(ref)}/amend`, body);
        } catch (err) {
          return await unanswered("did not answer the change", isRefusal(err) ? err.native : undefined);
        }
        if (r.status >= 500) return await unanswered(`answered the change with HTTP ${r.status}`, { status: r.status, said: saidOf(r.text, secrets) });
        if (r.status === 404) {
          // filled or canceled since it was read
          const now = await status(ref, symbol);
          if (isRefusal(now)) return now;
          return no("E_VENUE_REJECTED", { venue, message: `${name} did not take the change (HTTP 404): the order is ${now.status} now${now.filledQty > 0 ? `, ${plain(now.filledQty)} filled` : ""}`, native: { status: 404, said: saidOf(r.text, secrets), order: now.native } });
        }
        if (r.status !== 200) return fail(r, l.m.exchange_index !== undefined ? num(l.m.exchange_index) : undefined);
        // the answer is {order_id, remaining_count?, fill_count?, average_fill_price?, …}, the counts only when the size changed or something
        // filled: the order itself is read
        const id = isRec(r.body) && typeof r.body.order_id === "string" && r.body.order_id ? r.body.order_id : ref;
        const now = await status(id, symbol);
        if (!isRefusal(now)) return { ...now, native: { amend: r.body, order: now.native } };
        return no("E_VENUE_UNREACHABLE", { venue, message: `${name} took the change, but the order could not be read back: it is read again in a few seconds`, native: { amend: r.body, read: now.native } });
      } catch (err) {
        return asRefusal(venue, name, err, secrets);
      }
    },

    /** What is held here: GET /portfolio/positions, one row per market with its position netted — `position_fp` above zero is YES held,
     * below zero NO (get-positions.md) — and each market's name and price from GET /markets?tickers=. What a position cost is Kalshi's
     * `market_exposure_dollars`; what it is worth is its outcome's price now, or $1 or $0 a contract once its market has a result. */
    async positions() {
      try {
        const rows: Rec[] = [];
        let cursor = "";
        // the positions not yet settled (Kalshi's default) and not flat (count_filter=position), a page at a time and not for ever: five pages of two hundred
        for (let page = 0; page < 5; page++) {
          const r = await call("GET", `/portfolio/positions?count_filter=position&limit=200${cursor ? `&cursor=${enc(cursor)}` : ""}`);
          if (r.status !== 200 || !isRec(r.body)) return fail(r);
          rows.push(...(Array.isArray(r.body.market_positions) ? (r.body.market_positions as unknown[]).filter(isRec) : []).filter((p) => typeof p.ticker === "string" && num(p.position_fp) !== 0));
          cursor = typeof r.body.cursor === "string" ? r.body.cursor : "";
          if (!cursor) break;
        }
        const markets = await marketsOf(rows.map((p) => String(p.ticker).toUpperCase()));
        return rows.map((p): Position => {
          const ticker = String(p.ticker).toUpperCase();
          const n = num(p.position_fp);
          const outcome: Outcome = n > 0 ? "YES" : "NO";
          const qty = Math.abs(n);
          const cost = num(p.market_exposure_dollars);
          const m = markets.get(ticker);
          const mk = m ? toMarket(m, outcome) : undefined;
          const mark = markOf(m, outcome);
          return { symbol: `${ticker}:${outcome}`, name: mk?.name ?? `${ticker} · ${outcome === "YES" ? "Yes" : "No"}`, kind: "event", side: "long", qty, ...(cost > 0 ? { entryPrice: round(cost / qty) } : {}), ...(mark !== undefined ? { markPrice: mark, usd: round(qty * mark), ...(cost > 0 ? { unrealizedUsd: round(qty * mark - cost) } : {}) } : {}), native: p };
        });
      } catch (err) {
        return asRefusal(venue, name, err, secrets);
      }
    },

    /** Event contracts to discover, both outcomes of each market, the markets most traded in 24 hours first. Kalshi has no order of its own
     * to ask for, so the markets are read and sorted here by `volume_24h_fp` (contracts). Without a window, they are the markets a search runs
     * over (the open ones, combos left out, the well-known series' busiest first); closing within one, they are GET /markets with
     * min_close_ts and max_close_ts. Either way only `active` ones (the only status that trades). Each carries its event's category, from
     * GET /events?tickers=, and one category asked keeps the markets whose event says it, in Kalshi's own words */
    async events({ category, closingWithinMs, limit }) {
      try {
        const n = Math.min(200, Math.floor(limit));
        if (!(n > 0)) return [];
        if (closingWithinMs !== undefined && !(Number.isFinite(closingWithinMs) && closingWithinMs > 0)) return no("E_ACCOUNT_BAD_ACTION", { venue, message: "a window for markets closing soon is a number of milliseconds, more than 0" });
        const now = o.clock();
        let candidates: Rec[];
        if (closingWithinMs === undefined) {
          await all();
          candidates = [...universe!.raw].sort(byVolume);
        } else {
          candidates = (await closing(Math.floor(now / 1000), Math.ceil((now + closingWithinMs) / 1000))).filter(tradable).sort(byVolume);
        }
        // the questions, two outcomes each; the events are asked for a hundred markets at a time, only as far as the answer needs
        const want = Math.ceil(n / 2);
        const picked: Array<{ m: Rec; category: string | undefined }> = [];
        for (let i = 0; picked.length < want && i < candidates.length; i += 100) {
          const batch = candidates.slice(i, i + 100);
          let evs: Map<string, Rec>;
          try {
            evs = await eventsOf(batch.map((m) => String(m.event_ticker ?? "")));
          } catch (err) {
            // without a category asked, a market whose event could not be read is still the market, said without one
            if (category !== undefined) throw err;
            evs = new Map();
          }
          for (const m of batch) {
            const c = evs.get(String(m.event_ticker ?? ""))?.category;
            const cat = typeof c === "string" && c ? c : undefined;
            if (category !== undefined && (!cat || norm(cat) !== norm(category))) continue;
            picked.push({ m, category: cat });
            if (picked.length >= want) break;
          }
        }
        return picked.flatMap(({ m, category: cat }) => [toMarket(m, "YES", undefined, undefined, cat), toMarket(m, "NO", undefined, undefined, cat)]).slice(0, n);
      } catch (err) {
        return asRefusal(venue, name, err, secrets);
      }
    },

    /** A market's price history: GET /markets/candlesticks (batch-get-market-candlesticks.md: market_tickers, start_ts and end_ts in Unix
     * seconds, period_interval in minutes), one candle for each minute, hour or day in which something changed. A candle's prices are the
     * trades' (`price`: open_dollars, high_dollars, low_dollars, close_dollars, null when nothing traded — such a candle is left out: no trade,
     * no price, and the book's bid and ask are not a trade) and its volume the contracts traded (`volume_fp`). NO's prices are YES's turned over:
     * 1 − YES, its high YES's low. A bar starts where Kalshi's period does: its end less its length */
    async candles(symbol, interval, sinceMs) {
      try {
        const s = parse(symbol);
        if (!s) return badSymbol(symbol);
        if (!Object.hasOwn(PERIOD_MIN, interval)) return no("E_ACCOUNT_BAD_ACTION", { venue, message: `price history comes in bars of 5m, 1h or 1d, not "${String(interval).slice(0, 12)}"` });
        const now = o.clock();
        if (!(Number.isFinite(sinceMs) && sinceMs < now)) return no("E_ACCOUNT_BAD_ACTION", { venue, message: "price history starts before now" });
        const period = PERIOD_MIN[interval];
        const r = await call("GET", `/markets/candlesticks?market_tickers=${enc(s.ticker)}&start_ts=${Math.floor(sinceMs / 1000)}&end_ts=${Math.floor(now / 1000)}&period_interval=${period}`);
        if (r.status !== 200 || !isRec(r.body)) return fail(r);
        const row = (Array.isArray(r.body.markets) ? (r.body.markets as unknown[]).filter(isRec) : []).find((x) => String(x.market_ticker ?? "").toUpperCase() === s.ticker);
        const sticks = (row && Array.isArray(row.candlesticks) ? (row.candlesticks as unknown[]).filter(isRec) : []).sort((a, b) => num(a.end_period_ts) - num(b.end_period_ts));
        const fold = FOLD_MS[interval];
        const bars = new Map<number, Candle>();
        for (const k of sticks) {
          const p = isRec(k.price) ? k.price : {};
          const [yo, yh, yl, yc] = [dollars(p.open_dollars), dollars(p.high_dollars), dollars(p.low_dollars), dollars(p.close_dollars)];
          const end = num(k.end_period_ts);
          if (yo === undefined || yh === undefined || yl === undefined || yc === undefined || !(end > 0)) continue;
          const [op, hi, lo, cl] = s.outcome === "YES" ? [yo, yh, yl, yc] : [round(1 - yo, 4), round(1 - yl, 4), round(1 - yh, 4), round(1 - yc, 4)];
          const v = typeof k.volume_fp === "string" ? num(k.volume_fp) : undefined;
          const start = (end - period * 60) * 1000;
          const t = fold ? Math.floor(start / fold) * fold : start;
          const b = bars.get(t);
          if (!b) bars.set(t, { t, o: op, h: hi, l: lo, c: cl, ...(v !== undefined ? { v } : {}) });
          else {
            b.h = Math.max(b.h, hi);
            b.l = Math.min(b.l, lo);
            b.c = cl;
            if (v !== undefined) b.v = round((b.v ?? 0) + v, 2);
          }
        }
        return [...bars.values()];
      } catch (err) {
        return asRefusal(venue, name, err, secrets);
      }
    },
  };

  /** the create answer (201): {order_id, fill_count, remaining_count, average_fill_price?, average_fee_paid?} — not the order itself */
  async function placed(b: Rec, qty: number, outcome: Outcome): Promise<OrderState> {
    const ref = String(b.order_id);
    const filled = num(b.fill_count);
    const rest = num(b.remaining_count);
    // what did not fill and is not resting was canceled: the rest of an immediate-or-cancel order, a fill-or-kill order that could not fill
    // whole, a post-only order that would have crossed, a self-trade
    const status: OrderStatus = filled >= qty - 1e-9 ? "filled" : rest > 1e-9 ? (filled > 0 ? "partial" : "open") : "canceled";
    let avgPrice: number | undefined;
    let feeUsd: number | undefined;
    if (filled > 0) {
      const f = await fillsOf(ref, outcome);
      if (f) {
        avgPrice = f.avg;
        feeUsd = f.fee;
      } else {
        // the docs do not say which leg average_fill_price is on. For a YES order either reading is YES's price; for NO a wrong guess would count the
        // fill at the other leg's price (0.42 for 0.58) and hand an agent's limit back what it spent, so NO is left to the price it was valued at
        const a = num(b.average_fill_price);
        if (a > 0 && a < 1 && outcome === "YES") avgPrice = a;
        const per = num(b.average_fee_paid);
        if (per > 0) feeUsd = round(per * filled);
      }
    }
    return { ref, status, filledQty: filled, ...(avgPrice !== undefined ? { avgPrice } : {}), ...(feeUsd !== undefined ? { feeUsd } : {}), native: b };
  }
}
