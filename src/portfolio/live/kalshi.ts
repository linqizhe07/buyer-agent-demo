/** A Kalshi account, read and traded through its trade API v2 (docs.kalshi.com, read 2026-10-05; OpenAPI 3.32.0).
 *
 *   GET /trade-api/v2/portfolio/balance      balance, in cents
 *   GET /trade-api/v2/portfolio/positions    market_positions[]: ticker, position_fp (contracts; negative = NO), market_exposure_dollars (cost)
 *
 * Orders (the trader below):
 *
 *   GET    /trade-api/v2/markets/{ticker}                 one market: *_dollars prices, price_ranges (its price grid), status (`active` trades)
 *   GET    /trade-api/v2/markets?status=open&…            the list a search runs over
 *   GET    /trade-api/v2/exchange/status                  whether Kalshi is taking orders now, per exchange shard
 *   GET    /trade-api/v2/api_keys                         the key's own scopes: `write` or `write::trade` places orders, `read` alone does not
 *   POST   /trade-api/v2/portfolio/events/orders          place (the V2 endpoint; the old /portfolio/orders writes were removed in June 2026)
 *   DELETE /trade-api/v2/portfolio/events/orders/{id}     cancel, with ?market_ticker= so Kalshi routes it to the market's shard
 *   GET    /trade-api/v2/portfolio/orders/{id}            what became of it: resting, executed, canceled
 *   GET    /trade-api/v2/portfolio/orders?ticker=         the orders on one market: those resting (a sell counts them), one by its client id
 *   GET    /trade-api/v2/portfolio/fills?order_id=        the price of each fill, in YES and in NO terms, and its fee
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
import { badOrder, onStep, pick, plain, type LiveTrader, type Market, type OrderRequest, type OrderState, type OrderStatus } from "./trade.ts";
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
    let cursor = "";
    // a page at a time, and not for ever: five pages is a thousand positions
    for (let page = 0; page < 5; page++) {
      const body = await get(`/portfolio/positions?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      for (const p of (Array.isArray(body.market_positions) ? body.market_positions : []) as Array<Record<string, unknown>>) {
        const n = num(p.position_fp);
        // what Kalshi reports per position is what it cost, not what it is worth now: said as that
        if (n !== 0) out.push({ asset: `${String(p.ticker ?? "?")}:${n > 0 ? "YES" : "NO"}`, amount: Math.abs(n), usd: num(p.market_exposure_dollars), where: "at cost", class: "event" });
      }
      cursor = typeof body.cursor === "string" ? body.cursor : "";
      if (!cursor) break;
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
        note: "a Kalshi key carries the scopes it was made with: read to see the account, write (or write::trade) to place and cancel orders here; positions are shown at what they cost, which is what Kalshi reports",
        native: { calls: ["GET /trade-api/v2/portfolio/balance", "GET /trade-api/v2/portfolio/positions", "GET /trade-api/v2/api_keys", "POST /trade-api/v2/portfolio/events/orders", "DELETE /trade-api/v2/portfolio/events/orders/{order_id}", "GET /trade-api/v2/portfolio/orders/{order_id}"], signed: key.asymmetricKeyType === "ed25519" ? "Ed25519" : "RSA-PSS SHA-256", demo },
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

/** one Kalshi market as the account's market for one of its outcomes; NO is the other side of the same book */
function toMarket(m: Rec, outcome: Outcome, paused?: string, caveat?: string): Market {
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
  return { symbol: `${ticker}:${outcome}`, name: `${words} · ${yes ? "Yes" : "No"}`, kind: "event", base: `${ticker}:${outcome}`, quote: "USD", price, bid, ask, minQty: COUNT_STEP, qtyStep: COUNT_STEP, priceStep, open, ...(note ? { note } : {}), types: ["market", "limit"] };
}

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
  if (/invalid_price|price|tick/.test(t)) return { ...badOrder(venue, name, "the price is not on this market's price grid"), native };
  if (/risk_limit|position limit|position_floor/.test(t)) return { ...badOrder(venue, name, "over Kalshi's limit for one market"), native };
  if (/invalid_order|post.?only/.test(t)) return { ...badOrder(venue, name, "Kalshi does not take this order as written"), native };
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
  let universe: { at: number; list: Market[] } | undefined;
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
    universe = { at: now, list: [...ordered.values()].flatMap((m) => [toMarket(m, "YES"), toMarket(m, "NO")]) };
    return universe.list;
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

  const status = async (ref: string, symbol: string): Promise<OrderState | Refusal> => {
    try {
      const r = await call("GET", `/portfolio/orders/${enc(ref)}`);
      if (r.status === 404) return no("E_ACCOUNT_ORDER_UNKNOWN", { venue, message: `${name} has no order ${ref} for this key (an order done before Kalshi's historical cutoff is only in GET /historical/orders)`, native: { status: 404, said: saidOf(r.text, secrets) } });
      if (r.status !== 200) return fail(r);
      const ord = isRec(r.body) && isRec(r.body.order) ? r.body.order : undefined;
      if (!ord) return no("E_VENUE_REJECTED", { venue, message: `${name} answered without the order ${ref}` });
      return await stateOf(ord, parse(symbol)?.outcome);
    } catch (err) {
      return asRefusal(venue, name, err, secrets);
    }
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
        const l = await recent(s.ticker);
        if (isRefusal(l)) return l;
        const m = toMarket(l.m, s.outcome, l.paused, l.caveat);
        if (scopes?.can === false) return no("E_VENUE_PERMISSION", { venue, message: `${name}: this key may not trade — Kalshi lists its scopes as ${scopes.list?.join(", ") || "none"}. A Kalshi key keeps the scopes it was made with: make one with write (or write::trade) at Kalshi`, native: { scopes: scopes.list } });
        if (!m.open) return no("E_VENUE_MARKET_CLOSED", { venue, message: `${name}: ${m.name} takes no orders now${m.note ? ` (${m.note})` : ""}` });
        const bands = bandsOf(l.m);
        // the YES leg: buying YES and selling NO are bids, buying NO and selling YES are asks, and a NO price n is the YES price 1 − n
        const side: BookSide = (s.outcome === "YES") === (order.side === "buy") ? "bid" : "ask";
        const yesOf = (outcomeC: number) => (s.outcome === "YES" ? outcomeC : CC - outcomeC);
        let yesC: number;
        if (order.type === "limit") {
          const lp = order.limitPrice ?? NaN;
          const c = lp * CC;
          if (!(lp > 0 && lp < 1) || Math.abs(c - Math.round(c)) > 1e-6) return badOrder(venue, name, "a price at Kalshi is in dollars, more than 0 and less than 1, at most four decimals", { limitPrice: order.limitPrice });
          yesC = yesOf(Math.round(c));
          if (!onGrid(bands, yesC)) {
            const b = bandAt(bands, yesC);
            return badOrder(venue, name, `a price in ${m.name} moves in steps of ${plain((b?.step ?? 100) / CC)}${b ? ` between ${plain(s.outcome === "YES" ? b.start / CC : 1 - b.end / CC)} and ${plain(s.outcome === "YES" ? b.end / CC : 1 - b.start / CC)}` : ""}`, { limitPrice: order.limitPrice, priceStep: (b?.step ?? 100) / CC });
          }
        } else {
          // Kalshi takes no market orders (removed 2026-02-11). The account's market order is an immediate-or-cancel limit at the worst price
          // the account gave it (trade.ts: the most a buy pays, the least a sell takes), or, without one, at the book the account just looked
          // at — put on the grid in the safe direction: it fills at that price or better, and what does not fill there at once is canceled.
          const book = order.side === "buy" ? m.ask : m.bid;
          if (book === undefined) return badOrder(venue, name, `no one is ${order.side === "buy" ? "selling" : "buying"} ${m.name} right now, so a market order has nothing to take: try a limit order`);
          const at = order.worstPrice !== undefined && order.worstPrice > 0 ? order.worstPrice : book;
          // $0 and $1 are not prices at Kalshi: a bid starts under $1, an ask over $0 — tighter, never looser
          const snapped = snapTo(bands, Math.min(CC - 1, Math.max(1, yesOf(Math.round(at * CC)))), side === "bid" ? "down" : "up");
          if (snapped === undefined) return badOrder(venue, name, `${plain(at)} has no price on ${m.name}'s grid to send a market order at: try a limit order`);
          yesC = snapped;
        }
        // A sell is of contracts held. Kalshi nets a market into one position, so an ask on YES that finds no YES held opens NO instead — a
        // purchase, and at a low price a far bigger one than the sell was valued at. So the position is read first (GET
        // /portfolio/positions?ticker=), less what the orders already resting on the same side of the book will take out of it before this one
        // (GET /portfolio/orders?status=resting); a market sell also goes reduce_only, which Kalshi takes only with immediate_or_cancel. A
        // resting limit sell cannot be reduce_only: it is held to what is free when it is placed, and every later sell here counts it.
        if (order.side === "sell") {
          const [r, o] = await Promise.all([call("GET", `/portfolio/positions?ticker=${enc(s.ticker)}&limit=200`), call("GET", `/portfolio/orders?ticker=${enc(s.ticker)}&status=resting&limit=200`)]);
          if (r.status !== 200 || !isRec(r.body)) return fail(r);
          if (o.status !== 200 || !isRec(o.body)) return fail(o);
          const p = (Array.isArray(r.body.market_positions) ? (r.body.market_positions as unknown[]).filter(isRec) : []).find((x) => String(x.ticker ?? "").toUpperCase() === s.ticker);
          const n = num(p?.position_fp);
          const held = s.outcome === "YES" ? Math.max(0, n) : Math.max(0, -n);
          const resting = round((Array.isArray(o.body.orders) ? (o.body.orders as unknown[]).filter(isRec) : []).filter((x) => x.book_side === side).reduce((a, x) => a + num(x.remaining_count_fp), 0), 2);
          const free = Math.max(0, round(held - resting, 2));
          if (order.qty > free + 1e-9) return no("E_VENUE_INSUFFICIENT", { venue, message: `${name}: you hold ${plain(held)} ${m.symbol}${resting > 0 ? `, and orders already resting on Kalshi's book sell ${plain(Math.min(resting, held))} of it: ${plain(free)} is free to sell, fewer than the ${plain(order.qty)} asked` : `, fewer than the ${plain(order.qty)} to sell`}. A sell here is of what is held: selling more at Kalshi would buy the other side`, detail: { held, qty: order.qty, ...(resting > 0 ? { resting } : {}) }, native: p ?? { market_positions: [] } });
        }
        const market = order.type === "market";
        const body: Rec = {
          ticker: s.ticker,
          side,
          count: order.qty.toFixed(2),
          price: (yesC / CC).toFixed(4),
          time_in_force: market ? "immediate_or_cancel" : "good_till_canceled",
          // required on V2: an order that would match the account's own resting order is the one canceled, and what matched stands
          self_trade_prevention_type: "taker_at_cross",
          // the account's id is Kalshi's idempotency key: a second order under it is refused with 409. The docs say only "string" (and
          // suggest a UUID): it is kept to letters, digits, dashes and underscores
          client_order_id: order.clientId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64),
          ...(market && order.side === "sell" ? { reduce_only: true } : {}),
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
  };

  /** the create answer (201): {order_id, fill_count, remaining_count, average_fill_price?, average_fee_paid?} — not the order itself */
  async function placed(b: Rec, qty: number, outcome: Outcome): Promise<OrderState> {
    const ref = String(b.order_id);
    const filled = num(b.fill_count);
    const rest = num(b.remaining_count);
    // what did not fill and is not resting was canceled: the rest of an immediate-or-cancel order, a self-trade
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
