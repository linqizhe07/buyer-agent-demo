import { describe, expect, it } from "vitest";
import { isRefusal, type Refusal } from "../../src/core/errors.ts";
import { alpacaSource } from "../../src/portfolio/live/alpaca.ts";
import type { LiveTrader, Market, OrderState } from "../../src/portfolio/live/trade.ts";
import type { Http, HttpReply, LiveSource } from "../../src/portfolio/live/types.ts";

/** TRADING at Alpaca, against a stand-in for its Trading and Market Data APIs that records every request and answers what each test says.
 * Nothing here leaves the process, and the key is made up: Alpaca's key is two plain strings, nothing is signed with it. */
const KEY_ID = "made-up-key-id-0001";
const SECRET = "made-up-secret-alpaca-0001";
const LIVE = "https://api.alpaca.markets";
const PAPER = "https://paper-api.alpaca.markets";
const DATA = "https://data.alpaca.markets";
const AUTH = { "APCA-API-KEY-ID": KEY_ID, "APCA-API-SECRET-KEY": SECRET, accept: "application/json" };

interface Req {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}
type Answer = HttpReply | ((r: Req) => HttpReply) | Error;

const json = (body: unknown, status = 200): HttpReply => ({ status, body, text: JSON.stringify(body) });

/** Alpaca as a stand-in: an answer by "METHOD url" (a list is answered in turn, its last one from then on); anything not set up is a 404 */
async function alpaca(answers: Record<string, Answer | Answer[]> = {}, opts: { paper?: boolean } = {}): Promise<{ t: LiveTrader; seen: Req[]; reads: Req[]; source: LiveSource }> {
  const seen: Req[] = [];
  const host = opts.paper ? PAPER : LIVE;
  const http: Http = async (url, init = {}) => {
    const req: Req = { method: init.method ?? "GET", url, headers: { ...(init.headers ?? {}) }, ...(init.body !== undefined ? { body: JSON.parse(init.body) } : {}) };
    seen.push(req);
    if (url === `${host}/v2/account`) return json({ status: "ACTIVE", crypto_status: "ACTIVE", cash: "2500.50", equity: "2500.50", buying_power: "5001" });
    if (url === `${host}/v2/positions`) return json([]);
    const a = answers[`${req.method} ${url}`];
    const next = Array.isArray(a) ? (a.length > 1 ? a.shift() : a[0]) : a;
    if (next === undefined) return json({ message: `not set up in this test: ${req.method} ${url}` }, 404);
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(req) : next;
  };
  const opened = await alpacaSource({ venue: "alpaca", label: "", reference: "credentials/alpaca/api-key.json", key: { keyId: KEY_ID, secret: SECRET, ...(opts.paper ? { paper: "true" } : {}) }, http });
  if (isRefusal(opened)) throw new Error(opened.message);
  const reads = seen.splice(0);
  return { t: opened.source.trader!, seen, reads, source: opened.source };
}

const refusal = (x: unknown): Refusal => {
  if (!isRefusal(x)) throw new Error(`expected a refusal, got ${JSON.stringify(x)}`);
  expect(JSON.stringify(x)).not.toContain(SECRET);
  expect(JSON.stringify(x)).not.toContain(KEY_ID);
  return x;
};
const ok = <T>(x: T | Refusal): T => {
  if (isRefusal(x)) throw new Error(`expected an answer, got ${x.code}: ${x.message}`);
  return x;
};
const calls = (seen: Req[]) => seen.map((r) => `${r.method} ${r.url}`);

// ---- what Alpaca answers, shaped like its docs' examples -----------------------------------------------

const AAPL = { id: "b0b6dd9d-8b9b-48a9-ba46-b9d54906e415", class: "us_equity", exchange: "NASDAQ", symbol: "AAPL", name: "Apple Inc. Common Stock", status: "active", tradable: true, marginable: true, shortable: true, easy_to_borrow: true, fractionable: true, attributes: ["fractional_eh_enabled", "has_options", "overnight_tradable"] };
const PNNY = { ...AAPL, id: "00000000-0000-4000-8000-000000000001", symbol: "PNNY", name: "Penny Corp", fractionable: false, attributes: [] };
const IPO = { ...AAPL, id: "00000000-0000-4000-8000-000000000002", symbol: "NEWCO", name: "Newco Inc.", fractionable: false, attributes: ["ipo"] };
const HALTED = { ...AAPL, id: "00000000-0000-4000-8000-000000000003", symbol: "HALT", name: "Halted Inc.", tradable: false };
const BTC = { id: "276e2673-764b-4ab6-a611-caf665ca6340", class: "crypto", exchange: "CRYPTO", symbol: "BTC/USD", name: "Bitcoin / US Dollar", status: "active", tradable: true, marginable: false, shortable: false, easy_to_borrow: false, fractionable: true, min_order_size: "0.0001", min_trade_increment: "0.000000001", price_increment: "0.1" };
const ETHBTC = { ...BTC, id: "00000000-0000-4000-8000-000000000004", symbol: "ETH/BTC", name: "Ethereum / Bitcoin", min_order_size: "0.001", min_trade_increment: "0.0001", price_increment: "0.00001" };
const ETHUSDT = { ...BTC, id: "00000000-0000-4000-8000-000000000005", symbol: "ETH/USDT", name: "Ethereum / USD Tether", min_order_size: "0.001", min_trade_increment: "0.000000001", price_increment: "0.01" };
const OPEN = { timestamp: "2026-10-05T10:15:22-04:00", is_open: true, next_open: "2026-10-06T09:30:00-04:00", next_close: "2026-10-05T16:00:00-04:00" };
const SHUT = { timestamp: "2026-10-05T20:15:22-04:00", is_open: false, next_open: "2026-10-06T09:30:00-04:00", next_close: "2026-10-06T16:00:00-04:00" };
const quote = (symbol: string, bp: number, ap: number) => ({ symbol, quote: { ap, as: 1, ax: "Q", bp, bs: 2, bx: "Q", c: ["R"], t: "2026-10-05T14:09:34.055031265Z", z: "C" } });
const trade = (symbol: string, p: number) => ({ symbol, trade: { c: ["@"], i: 689, p, s: 100, t: "2026-10-05T14:09:30.845580544Z", x: "V", z: "C" } });
const ID = "7b08df51-c1ac-453c-99f9-323a5f075f0d";
/** how Alpaca shows a market buy of 3 AAPL sent as a limit at its worst price, 204.73 */
const LIMIT = { type: "limit", order_type: "limit", limit_price: "204.73" };
const order = (over: Record<string, unknown> = {}) => ({ asset_class: "us_equity", asset_id: AAPL.id, canceled_at: null, client_order_id: "ord-0001", created_at: new Date().toISOString(), expired_at: null, extended_hours: false, failed_at: null, filled_at: null, filled_avg_price: null, filled_qty: "0", hwm: null, id: ID, legs: null, limit_price: null, notional: null, order_class: "", order_type: "market", qty: "3", replaced_at: null, replaced_by: null, replaces: null, side: "buy", status: "accepted", stop_price: null, submitted_at: new Date().toISOString(), symbol: "AAPL", time_in_force: "day", trail_percent: null, trail_price: null, type: "market", updated_at: new Date().toISOString(), ...over });

const stockAnswers = (asset: Record<string, unknown>, clock: unknown, q: unknown, tr: unknown): Record<string, Answer> => ({
  [`GET ${LIVE}/v2/assets/${String(asset.symbol)}`]: json(asset),
  [`GET ${LIVE}/v2/clock`]: json(clock),
  [`GET ${DATA}/v2/stocks/${String(asset.symbol)}/quotes/latest`]: json(q),
  [`GET ${DATA}/v2/stocks/${String(asset.symbol)}/trades/latest`]: json(tr),
});

describe("Alpaca's connection carries a trader", () => {
  it("through the source the account opens: it can trade, and says what; the two reads are still the only calls made while connecting", async () => {
    const { t, reads, source } = await alpaca();
    expect([t.can, t.what]).toEqual([true, "US stocks, ETFs and crypto"]);
    expect(calls(reads)).toEqual([`GET ${LIVE}/v2/account`, `GET ${LIVE}/v2/positions`]);
    expect(source.readOnlyBecause).toBe("Alpaca's API moves no cash: deposits and withdrawals are made at Alpaca");
    expect(source.probe).toEqual({ can: ["read", "trade"], note: "an Alpaca key has no scopes: any key can place orders, and no key can move cash", native: { calls: ["GET /v2/account", "GET /v2/positions"], paper: false } });
    expect(source.noTradeBecause).toBeUndefined();
  });
});

describe("one market, with a fresh price", () => {
  it("a stock while the market is open: the asset, the clock, the latest quote and trade, asked at once with the key's two headers", async () => {
    const { t, seen } = await alpaca(stockAnswers(AAPL, OPEN, quote("AAPL", 200.25, 200.75), trade("AAPL", 200.4)));
    const m = ok(await t.market("aapl"));
    expect(m).toEqual({ symbol: "AAPL", name: "Apple Inc. Common Stock", kind: "stock", base: "AAPL", quote: "USD", price: 200.5, bid: 200.25, ask: 200.75, qtyStep: 1e-9, priceStep: 0.01, minNotional: 1, open: true, types: ["market", "limit"] } satisfies Market);
    expect(calls(seen)).toEqual([`GET ${LIVE}/v2/assets/AAPL`, `GET ${LIVE}/v2/clock`, `GET ${DATA}/v2/stocks/AAPL/quotes/latest`, `GET ${DATA}/v2/stocks/AAPL/trades/latest`]);
    for (const r of seen) expect(r.headers).toEqual(AUTH);
  });

  it("a stock while the market is closed takes limit orders only — Alpaca holds them for the open, and a market order would fill at the opening price — and the owner is told; whole shares, a sub-dollar tick", async () => {
    const { t } = await alpaca(stockAnswers(PNNY, SHUT, quote("PNNY", 0, 0), trade("PNNY", 0.5123)));
    const m = ok(await t.market("PNNY"));
    expect([m.open, m.price, m.bid, m.ask, m.minQty, m.qtyStep, m.priceStep, m.minNotional, m.types]).toEqual([true, 0.5123, undefined, undefined, 1, 1, 0.0001, 1, ["limit"]]);
    expect(m.note).toBe("the US stock market is closed: Alpaca holds an order and sends it when the market opens (2026-10-06 09:30 New York time). Until then only limit orders are placed here: a market order would fill at the opening price, which can be well away from this one");
  });

  it("a clock that does not answer cannot say the market is open: limit orders only, and the owner is told why", async () => {
    const { t } = await alpaca({ ...stockAnswers(AAPL, OPEN, quote("AAPL", 200.25, 200.75), trade("AAPL", 200.4)), [`GET ${LIVE}/v2/clock`]: json({ code: 50010000, message: "internal server error" }, 500) });
    const m = ok(await t.market("AAPL"));
    expect([m.open, m.types, m.price]).toEqual([true, ["limit"], 200.5]);
    expect(m.note).toBe("Alpaca's market clock did not answer, so only limit orders are placed here: outside market hours Alpaca holds an order until the market opens, and a market order would fill at the opening price");
  });

  it("an IPO-flagged stock takes limit orders only; one Alpaca does not trade now is closed, in Alpaca's words", async () => {
    const ipo = await alpaca(stockAnswers(IPO, OPEN, quote("NEWCO", 0, 0), json({ message: "no trade" }, 404)));
    expect(ok(await ipo.t.market("NEWCO")).types).toEqual(["limit"]);
    const halted = await alpaca(stockAnswers(HALTED, OPEN, quote("HALT", 10, 10.02), trade("HALT", 10.01)));
    const m = ok(await halted.t.market("HALT"));
    expect([m.open, m.note]).toEqual([false, "Alpaca does not trade HALT now"]);
  });

  it("a coin pair: the asset by its URL-encoded pair, the quote from Alpaca's own crypto venue, its own minimum and steps, no clock", async () => {
    const { t, seen } = await alpaca({
      [`GET ${LIVE}/v2/assets/BTC%2FUSD`]: json(BTC),
      [`GET ${DATA}/v1beta3/crypto/us/latest/quotes?symbols=BTC/USD`]: json({ quotes: { "BTC/USD": { ap: 85611.5, as: 0.001009, bp: 85584.5, bs: 0.00100304, t: "2026-10-05T18:36:45.104849889Z" } } }),
    });
    const m = ok(await t.market("BTC/USD"));
    expect(m).toEqual({ symbol: "BTC/USD", name: "Bitcoin / US Dollar", kind: "crypto", base: "BTC", quote: "USD", price: 85598, bid: 85584.5, ask: 85611.5, minQty: 0.0001, qtyStep: 1e-9, priceStep: 0.1, open: true, types: ["market", "limit"] } satisfies Market);
    expect(calls(seen)).toEqual([`GET ${LIVE}/v2/assets/BTC%2FUSD`, `GET ${DATA}/v1beta3/crypto/us/latest/quotes?symbols=BTC/USD`]);
  });

  it("the legacy BTCUSD finds the pair, and the market is named as Alpaca names it now", async () => {
    const { t } = await alpaca({
      [`GET ${LIVE}/v2/assets/BTCUSD`]: json(BTC),
      [`GET ${DATA}/v1beta3/crypto/us/latest/quotes?symbols=BTC/USD`]: json({ quotes: { "BTC/USD": { ap: 85611.5, bp: 85584.5 } } }),
    });
    expect(ok(await t.market("BTCUSD")).symbol).toBe("BTC/USD");
  });

  it("a pair priced in anything but dollars is not offered, and nothing is asked for it; a symbol Alpaca does not list is Alpaca's no", async () => {
    const { t, seen } = await alpaca({ [`GET ${LIVE}/v2/assets/ZZZZ`]: json({ code: 40410000, message: "asset not found for ZZZZ" }, 404) });
    expect(refusal(await t.market("ETH/BTC")).code).toBe("E_ACCOUNT_UNPRICED");
    expect(seen).toEqual([]);
    const no = refusal(await t.market("ZZZZ"));
    expect([no.code, no.message]).toEqual(["E_VENUE_REJECTED", "Alpaca lists no market ZZZZ"]);
  });
});

describe("the markets to choose from", () => {
  it("are Alpaca's tradable stocks and its dollar pairs, the well-known ones first, at most twenty, the list kept five minutes", async () => {
    const filler = Array.from({ length: 25 }, (_, i) => ({ ...PNNY, id: `00000000-0000-4000-8000-1000000000${String(i).padStart(2, "0")}`, symbol: `ZF${String(i).padStart(2, "0")}`, name: `Filler ${i}` }));
    const { t, seen } = await alpaca({
      [`GET ${LIVE}/v2/assets?status=active&asset_class=us_equity`]: json([PNNY, AAPL, HALTED, { ...AAPL, symbol: "SPY", name: "SPDR S&P 500 ETF Trust" }, ...filler]),
      [`GET ${LIVE}/v2/assets?status=active&asset_class=crypto`]: json([ETHBTC, ETHUSDT, BTC]),
    });
    const first = ok(await t.markets(""));
    expect(first.length).toBe(20);
    expect(first.slice(0, 5).map((m) => m.symbol)).toEqual(["SPY", "AAPL", "BTC/USD", "ETH/USDT", "PNNY"]);
    expect(calls(seen)).toEqual([`GET ${LIVE}/v2/assets?status=active&asset_class=us_equity`, `GET ${LIVE}/v2/assets?status=active&asset_class=crypto`]);
    expect(ok(await t.markets("eth")).map((m) => m.symbol)).toEqual(["ETH/USDT"]);
    expect(ok(await t.markets("halt"))).toEqual([]);
    const usdt = ok(await t.markets("ETH/USDT"))[0]!;
    expect([usdt.base, usdt.quote, usdt.minQty, usdt.qtyStep, usdt.priceStep]).toEqual(["ETH", "USDT", 0.001, 1e-9, 0.01]);
    expect(seen.length).toBe(2);
  });
});

describe("an order", () => {
  it("a stock market buy goes as a limit at its worst price: POST /v2/orders with the account's id as client_order_id, a whole-share size as a string, time in force day", async () => {
    const { t, seen } = await alpaca({ [`POST ${LIVE}/v2/orders`]: json(order(LIMIT)) });
    const s = ok(await t.place({ symbol: "AAPL", side: "buy", type: "market", qty: 3, worstPrice: 204.73, clientId: "ord-0001" }));
    expect(seen).toEqual([{ method: "POST", url: `${LIVE}/v2/orders`, headers: { ...AUTH, "content-type": "application/json" }, body: { symbol: "AAPL", qty: "3", side: "buy", type: "limit", limit_price: "204.73", time_in_force: "day", client_order_id: "ord-0001" } }]);
    expect([s.ref, s.status, s.filledQty, s.avgPrice, s.feeUsd]).toEqual([ID, "pending", 0, undefined, undefined]);
    expect(s.native).toMatchObject({ id: ID, client_order_id: "ord-0001", status: "accepted", type: "limit", limit_price: "204.73", time_in_force: "day" });
  });

  it("a crypto market sell is a limit at its worst price, ioc (a pair takes no day order); a fractional stock market sell is a day limit", async () => {
    const { t, seen } = await alpaca({
      [`GET ${LIVE}/v2/assets/BTC%2FUSD`]: json(BTC),
      [`POST ${LIVE}/v2/orders`]: [json(order({ symbol: "BTC/USD", asset_class: "crypto", side: "sell", qty: "0.0012", type: "limit", limit_price: "83872.9", time_in_force: "ioc", status: "pending_new", client_order_id: "ord-0002" })), json(order({ side: "sell", qty: "0.5", type: "limit", limit_price: "196.46", status: "filled", filled_qty: "0.5", filled_avg_price: "200.31", client_order_id: "ord-0003" }))],
    });
    const coin = ok(await t.place({ symbol: "BTC/USD", side: "sell", type: "market", qty: 0.0012, worstPrice: 83872.9, clientId: "ord-0002" }));
    const share = ok(await t.place({ symbol: "AAPL", side: "sell", type: "market", qty: 0.5, worstPrice: 196.46, clientId: "ord-0003" }));
    expect(seen.filter((r) => r.method === "POST").map((r) => r.body)).toEqual([
      { symbol: "BTC/USD", qty: "0.0012", side: "sell", type: "limit", limit_price: "83872.9", time_in_force: "ioc", client_order_id: "ord-0002" },
      { symbol: "AAPL", qty: "0.5", side: "sell", type: "limit", limit_price: "196.46", time_in_force: "day", client_order_id: "ord-0003" },
    ]);
    expect([coin.status, share.status, share.filledQty, share.avgPrice]).toEqual(["pending", "filled", 0.5, 200.31]);
  });

  it("a limit order carries its price: a whole-share stock limit is gtc, a pair's gtc, a fractional stock limit day", async () => {
    const { t, seen } = await alpaca({ [`POST ${LIVE}/v2/orders`]: json(order({ type: "limit", limit_price: "150.25", qty: "2", status: "new", time_in_force: "gtc" })) });
    const s = ok(await t.place({ symbol: "AAPL", side: "buy", type: "limit", qty: 2, limitPrice: 150.25, clientId: "ord-0004" }));
    await t.place({ symbol: "ETH/USD", side: "buy", type: "limit", qty: 0.02, limitPrice: 2100, clientId: "ord-0005" });
    await t.place({ symbol: "AAPL", side: "buy", type: "limit", qty: 0.25, limitPrice: 199.5, clientId: "ord-0006" });
    expect(seen.map((r) => [r.method, r.url, r.body])).toEqual([
      ["POST", `${LIVE}/v2/orders`, { symbol: "AAPL", qty: "2", side: "buy", type: "limit", limit_price: "150.25", time_in_force: "gtc", client_order_id: "ord-0004" }],
      ["POST", `${LIVE}/v2/orders`, { symbol: "ETH/USD", qty: "0.02", side: "buy", type: "limit", limit_price: "2100", time_in_force: "gtc", client_order_id: "ord-0005" }],
      ["POST", `${LIVE}/v2/orders`, { symbol: "AAPL", qty: "0.25", side: "buy", type: "limit", limit_price: "199.5", time_in_force: "day", client_order_id: "ord-0006" }],
    ]);
    expect([s.status, s.ref]).toEqual(["open", ID]);
  });

  it("a paper key trades on Alpaca's paper host; prices still come from the one market-data host", async () => {
    const { t, seen, reads } = await alpaca({ [`POST ${PAPER}/v2/orders`]: json(order()), ...Object.fromEntries(Object.entries(stockAnswers(AAPL, OPEN, quote("AAPL", 1, 2), trade("AAPL", 1.5))).map(([k, v]) => [k.replace(LIVE, PAPER), v])) }, { paper: true });
    expect(calls(reads)).toEqual([`GET ${PAPER}/v2/account`, `GET ${PAPER}/v2/positions`]);
    ok(await t.market("AAPL"));
    ok(await t.place({ symbol: "AAPL", side: "buy", type: "market", qty: 1, worstPrice: 2.04, clientId: "ord-0007" }));
    expect(calls(seen)).toEqual([`GET ${PAPER}/v2/assets/AAPL`, `GET ${PAPER}/v2/clock`, `GET ${DATA}/v2/stocks/AAPL/quotes/latest`, `GET ${DATA}/v2/stocks/AAPL/trades/latest`, `POST ${PAPER}/v2/orders`]);
  });

  it("the account's id is kept to what Alpaca takes plainly; an order that cannot be right is refused before anything is sent", async () => {
    const { t, seen } = await alpaca({ [`POST ${LIVE}/v2/orders`]: json(order()) });
    await t.place({ symbol: "AAPL", side: "buy", type: "market", qty: 1, worstPrice: 204.73, clientId: "ord 0008/x" });
    expect((seen[0]!.body as Record<string, string>).client_order_id).toBe("ord-0008-x");
    seen.length = 0;
    expect(refusal(await t.place({ symbol: "AAPL", side: "buy", type: "market", qty: 0, worstPrice: 204.73, clientId: "ord-0009" })).code).toBe("E_VENUE_ORDER_INVALID");
    expect(refusal(await t.place({ symbol: "AAPL", side: "buy", type: "limit", qty: 1, clientId: "ord-0010" })).code).toBe("E_VENUE_ORDER_INVALID");
    expect(refusal(await t.place({ symbol: "AAPL", side: "buy", type: "market", qty: 1, limitPrice: 5, worstPrice: 5, clientId: "ord-0011" })).code).toBe("E_VENUE_ORDER_INVALID");
    expect(refusal(await t.place({ symbol: "ETH/BTC", side: "buy", type: "market", qty: 1, worstPrice: 0.04, clientId: "ord-0012" })).code).toBe("E_ACCOUNT_UNPRICED");
    // finer than the nine places Alpaca takes: refused, never rounded up into a bigger or pricier order than the one valued
    expect(refusal(await t.place({ symbol: "BTC/USD", side: "buy", type: "market", qty: 0.0012345678906, worstPrice: 87323.1, clientId: "ord-0012a" })).message).toBe("Alpaca: a size has at most nine decimal places");
    expect(refusal(await t.place({ symbol: "BTC/USD", side: "buy", type: "limit", qty: 0.001, limitPrice: 85611.1234567896, clientId: "ord-0012b" })).message).toBe("Alpaca: a limit price has at most nine decimal places");
    expect(seen).toEqual([]);
  });

  it("Alpaca did not answer: it is asked by the account's id, and the order is never sent twice from here", async () => {
    // the POST timed out at Alpaca, but the order reached it
    const a = await alpaca({ [`POST ${LIVE}/v2/orders`]: json({ code: 50410000, message: "request timed out" }, 504), [`GET ${LIVE}/v2/orders:by_client_order_id?client_order_id=ord-0013`]: json(order({ ...LIMIT, client_order_id: "ord-0013", status: "new" })) });
    const s = ok(await a.t.place({ symbol: "AAPL", side: "buy", type: "market", qty: 3, worstPrice: 204.73, clientId: "ord-0013" }));
    expect([s.status, s.ref]).toEqual(["open", ID]);
    expect(calls(a.seen)).toEqual([`POST ${LIVE}/v2/orders`, `GET ${LIVE}/v2/orders:by_client_order_id?client_order_id=ord-0013`]);
    // it did not
    const b = await alpaca({ [`POST ${LIVE}/v2/orders`]: json({ code: 50410000, message: "request timed out" }, 504), [`GET ${LIVE}/v2/orders:by_client_order_id?client_order_id=ord-0014`]: json({ code: 40410000, message: "order not found" }, 404) });
    const none = refusal(await b.t.place({ symbol: "AAPL", side: "buy", type: "market", qty: 3, worstPrice: 204.73, clientId: "ord-0014" }));
    expect([none.code, none.message, none.detail]).toEqual(["E_VENUE_UNREACHABLE", "Alpaca did not answer, and a moment later it held no order under the account's id ord-0014: nothing was placed", { clientOrderId: "ord-0014", placed: false }]);
    // nothing answers at all
    const c = await alpaca({ [`POST ${LIVE}/v2/orders`]: Object.assign(new Error("socket hang up"), { name: "TimeoutError" }), [`GET ${LIVE}/v2/orders:by_client_order_id?client_order_id=ord-0015`]: new Error("ECONNRESET") });
    const unknown = refusal(await c.t.place({ symbol: "AAPL", side: "buy", type: "market", qty: 3, worstPrice: 204.73, clientId: "ord-0015" }));
    expect([unknown.code, unknown.detail]).toEqual(["E_VENUE_UNREACHABLE", { clientOrderId: "ord-0015", placed: "unknown" }]);
    expect(unknown.message).toContain("Look at Alpaca's orders for ord-0015 before placing it again");
    expect(c.seen.filter((r) => r.method === "POST").length).toBe(1);
  });

  it("an id Alpaca already holds is this order only when it is the same order made minutes ago", async () => {
    const dup = json({ code: 40010001, message: "client_order_id must be unique" }, 422);
    const same = await alpaca({ [`POST ${LIVE}/v2/orders`]: dup, [`GET ${LIVE}/v2/orders:by_client_order_id?client_order_id=ord-0016`]: json(order({ ...LIMIT, client_order_id: "ord-0016" })) });
    expect(ok(await same.t.place({ symbol: "AAPL", side: "buy", type: "market", qty: 3, worstPrice: 204.73, clientId: "ord-0016" })).ref).toBe(ID);
    const old = await alpaca({ [`POST ${LIVE}/v2/orders`]: dup, [`GET ${LIVE}/v2/orders:by_client_order_id?client_order_id=ord-0017`]: json(order({ ...LIMIT, client_order_id: "ord-0017", created_at: "2026-01-02T15:00:00Z", status: "filled", filled_qty: "3" })) });
    const no = refusal(await old.t.place({ symbol: "AAPL", side: "buy", type: "market", qty: 3, worstPrice: 204.73, clientId: "ord-0017" }));
    expect([no.code, no.message]).toEqual(["E_VENUE_REJECTED", "Alpaca already holds an earlier, different order under the account's id ord-0017: nothing new was placed"]);
  });

  it("a market order Alpaca already holds is matched as what was sent — the limit at its worst price — not as an open market order", async () => {
    // a 504, and under the account's id an unbounded MARKET order of the same size: not this one (this one went as a limit at 204.73)
    const marketHeld = await alpaca({ [`POST ${LIVE}/v2/orders`]: json({ code: 50410000, message: "request timed out" }, 504), [`GET ${LIVE}/v2/orders:by_client_order_id?client_order_id=ord-0018`]: json(order({ client_order_id: "ord-0018", status: "new" })) });
    expect(refusal(await marketHeld.t.place({ symbol: "AAPL", side: "buy", type: "market", qty: 3, worstPrice: 204.73, clientId: "ord-0018" })).message).toBe("Alpaca already holds an earlier, different order under the account's id ord-0018: nothing new was placed");
    // a limit at another price: not this one either
    const otherPrice = await alpaca({ [`POST ${LIVE}/v2/orders`]: json({ code: 50410000, message: "request timed out" }, 504), [`GET ${LIVE}/v2/orders:by_client_order_id?client_order_id=ord-0019`]: json(order({ ...LIMIT, limit_price: "206", client_order_id: "ord-0019", status: "new" })) });
    expect(refusal(await otherPrice.t.place({ symbol: "AAPL", side: "buy", type: "market", qty: 3, worstPrice: 204.73, clientId: "ord-0019" })).code).toBe("E_VENUE_REJECTED");
    // a worst price off the grid of the price sent (1.0098 went as 1.00): the order Alpaca holds at 1.00 is this one, not "different"
    const rounded = await alpaca({ [`POST ${LIVE}/v2/orders`]: json({ code: 50410000, message: "request timed out" }, 504), [`GET ${LIVE}/v2/orders:by_client_order_id?client_order_id=ord-0020`]: json(order({ ...LIMIT, symbol: "PNNY", qty: "100", limit_price: "1", client_order_id: "ord-0020", status: "new" })) });
    const held = ok(await rounded.t.place({ symbol: "PNNY", side: "buy", type: "market", qty: 100, worstPrice: 1.0098, clientId: "ord-0020" }));
    expect([held.ref, held.status]).toEqual([ID, "open"]);
    expect((rounded.seen[0]!.body as Record<string, string>).limit_price).toBe("1");
  });
});

describe("a market order never fills past its worst price", () => {
  const sentBody = (seen: Req[]) => seen.filter((r) => r.method === "POST").map((r) => r.body as Record<string, string>);

  it("a stock's worst price is put onto the sub-penny grid on the safe side — a buy down, a sell up — by the tick of the price sent", async () => {
    const { t, seen } = await alpaca({ [`POST ${LIVE}/v2/orders`]: json(order(LIMIT)) });
    const cases: Array<[side: "buy" | "sell", worst: number, sent: string]> = [
      ["buy", 204.7399, "204.73"],
      ["sell", 196.4512, "196.46"],
      ["buy", 204.73, "204.73"],
      ["sell", 196.46, "196.46"],
      // under $1 the tick is a hundredth of a cent
      ["buy", 0.51239, "0.5123"],
      ["sell", 0.50201, "0.5021"],
      // a worst price over $1 takes the cent tick even when the market was under it; a sell up from just under $1 lands on $1
      ["buy", 1.0098, "1"],
      ["sell", 0.99995, "1"],
    ];
    for (const [i, [side, worst]] of cases.entries()) await t.place({ symbol: "PNNY", side, type: "market", qty: 100, worstPrice: worst, clientId: `ord-02${String(i).padStart(2, "0")}` });
    const bodies = sentBody(seen);
    expect(bodies.map((b) => [b.side, b.type, b.limit_price, b.time_in_force])).toEqual(cases.map(([side, , sent]) => [side, "limit", sent, "day"]));
    // never past the worst price: a buy's limit at or under it, a sell's at or over it
    for (const [i, [side, worst]] of cases.entries()) {
      const sent = Number(bodies[i]!.limit_price);
      expect(side === "buy" ? sent <= worst + 1e-12 : sent >= worst - 1e-12).toBe(true);
      expect(bodies[i]!).not.toHaveProperty("extended_hours");
    }
  });

  it("a pair's worst price goes onto its price_increment, read with the market — or asked of Alpaca once, and kept — and the order is ioc", async () => {
    const book = json({ quotes: { "BTC/USD": { ap: 85611.5, bp: 85584.5 } } });
    // the market was read first: its step is used, and nothing more is asked
    const read = await alpaca({ [`GET ${LIVE}/v2/assets/BTC%2FUSD`]: json(BTC), [`GET ${DATA}/v1beta3/crypto/us/latest/quotes?symbols=BTC/USD`]: book, [`POST ${LIVE}/v2/orders`]: json(order({ symbol: "BTC/USD", asset_class: "crypto", type: "limit", time_in_force: "ioc" })) });
    ok(await read.t.market("BTC/USD"));
    read.seen.length = 0;
    await read.t.place({ symbol: "BTC/USD", side: "buy", type: "market", qty: 0.001, worstPrice: 87323.19, clientId: "ord-0300" });
    expect(calls(read.seen)).toEqual([`POST ${LIVE}/v2/orders`]);
    expect(sentBody(read.seen)).toEqual([{ symbol: "BTC/USD", qty: "0.001", side: "buy", type: "limit", limit_price: "87323.1", time_in_force: "ioc", client_order_id: "ord-0300" }]);
    // not read first: the asset is asked for its step, once
    const cold = await alpaca({ [`GET ${LIVE}/v2/assets/ETH%2FUSD`]: json({ ...BTC, symbol: "ETH/USD", name: "Ethereum / US Dollar", price_increment: "0.01" }), [`POST ${LIVE}/v2/orders`]: json(order({ symbol: "ETH/USD", asset_class: "crypto", type: "limit", time_in_force: "ioc" })) });
    await cold.t.place({ symbol: "ETH/USD", side: "sell", type: "market", qty: 0.5, worstPrice: 2653.0151, clientId: "ord-0301" });
    await cold.t.place({ symbol: "ETH/USD", side: "buy", type: "market", qty: 0.5, worstPrice: 2762.0199, clientId: "ord-0302" });
    expect(calls(cold.seen)).toEqual([`GET ${LIVE}/v2/assets/ETH%2FUSD`, `POST ${LIVE}/v2/orders`, `POST ${LIVE}/v2/orders`]);
    expect(sentBody(cold.seen).map((b) => [b.side, b.limit_price, b.time_in_force])).toEqual([["sell", "2653.02", "ioc"], ["buy", "2762.01", "ioc"]]);
    // a pair whose asset does not answer is not traded
    const gone = await alpaca({ [`GET ${LIVE}/v2/assets/SOL%2FUSD`]: json({ code: 50010000, message: "internal server error" }, 500) });
    expect(refusal(await gone.t.place({ symbol: "SOL/USD", side: "buy", type: "market", qty: 1, worstPrice: 150, clientId: "ord-0303" })).code).toBe("E_VENUE_UNREACHABLE");
    expect(gone.seen.filter((r) => r.method === "POST")).toEqual([]);
  });

  it("an ioc limit that found nothing at its worst price is canceled with nothing filled; one that filled part is canceled with that part", async () => {
    const { t } = await alpaca({
      [`GET ${LIVE}/v2/assets/BTC%2FUSD`]: json(BTC),
      [`POST ${LIVE}/v2/orders`]: [json(order({ symbol: "BTC/USD", asset_class: "crypto", type: "limit", limit_price: "87323.1", time_in_force: "ioc", qty: "0.002", status: "canceled", filled_qty: "0" })), json(order({ symbol: "BTC/USD", asset_class: "crypto", type: "limit", limit_price: "87323.1", time_in_force: "ioc", qty: "0.002", status: "canceled", filled_qty: "0.0015", filled_avg_price: "85620.4" }))],
    });
    const none = ok(await t.place({ symbol: "BTC/USD", side: "buy", type: "market", qty: 0.002, worstPrice: 87323.1, clientId: "ord-0400" }));
    const part = ok(await t.place({ symbol: "BTC/USD", side: "buy", type: "market", qty: 0.002, worstPrice: 87323.1, clientId: "ord-0401" }));
    expect([none.status, none.filledQty, part.status, part.filledQty, part.avgPrice]).toEqual(["canceled", 0, "canceled", 0.0015, 85620.4]);
  });

  it("a market order with no worst price, or one under the smallest step, is refused before anything is sent", async () => {
    const { t, seen } = await alpaca({ [`POST ${LIVE}/v2/orders`]: json(order()) });
    expect(refusal(await t.place({ symbol: "AAPL", side: "buy", type: "market", qty: 1, clientId: "ord-0500" })).message).toBe("Alpaca: a market order carries the worst price it may fill at");
    expect(refusal(await t.place({ symbol: "AAPL", side: "buy", type: "market", qty: 1, worstPrice: Number.NaN, clientId: "ord-0501" })).code).toBe("E_VENUE_ORDER_INVALID");
    expect(refusal(await t.place({ symbol: "PNNY", side: "buy", type: "market", qty: 1000, worstPrice: 0.00004, clientId: "ord-0502" })).message).toBe("Alpaca: the worst price 0.00004 is under the smallest price step of PNNY (0.0001)");
    expect(seen).toEqual([]);
  });

  it("market orders are still offered only while the clock says the regular session is open", async () => {
    const shut = await alpaca(stockAnswers(AAPL, SHUT, quote("AAPL", 200.25, 200.75), trade("AAPL", 200.4)));
    expect(ok(await shut.t.market("AAPL")).types).toEqual(["limit"]);
    const open = await alpaca(stockAnswers(AAPL, OPEN, quote("AAPL", 200.25, 200.75), trade("AAPL", 200.4)));
    expect(ok(await open.t.market("AAPL")).types).toEqual(["market", "limit"]);
  });
});

describe("what became of an order", () => {
  it("GET /v2/orders/{id}, every status Alpaca has in the account's words; filled_qty and filled_avg_price as numbers", async () => {
    let now: Record<string, unknown> = order();
    const { t, seen } = await alpaca({ [`GET ${LIVE}/v2/orders/${ID}`]: () => json(now) });
    const cases: Array<[string, string, string | null, OrderState["status"]]> = [
      ["accepted", "0", null, "pending"],
      ["pending_new", "0", null, "pending"],
      ["accepted_for_bidding", "0", null, "pending"],
      ["held", "0", null, "pending"],
      ["new", "0", null, "open"],
      ["new", "1", "200.1", "partial"],
      ["partially_filled", "1.5", "200.2", "partial"],
      ["pending_cancel", "0", null, "open"],
      ["pending_replace", "0", null, "open"],
      ["stopped", "0", null, "open"],
      ["suspended", "0", null, "open"],
      ["done_for_day", "2", "200.3", "partial"],
      ["calculated", "3", "200.3", "filled"],
      ["calculated", "2", "200.3", "partial"],
      ["filled", "3", "200.35", "filled"],
      ["canceled", "0.4", "200.5", "canceled"],
      ["canceled", "0", null, "canceled"],
      ["expired", "0", null, "expired"],
      ["rejected", "0", null, "rejected"],
    ];
    for (const [status, filled, avg, want] of cases) {
      now = order({ status, filled_qty: filled, filled_avg_price: avg });
      const s = ok(await t.status(ID, "AAPL"));
      expect([status, s.status, s.filledQty, s.avgPrice ?? null]).toEqual([status, want, Number(filled), avg === null ? null : Number(avg)]);
      expect(s.ref).toBe(ID);
    }
    expect(seen.every((r) => r.method === "GET" && r.url === `${LIVE}/v2/orders/${ID}`)).toBe(true);
  });

  it("an order Alpaca replaced is followed to the one that replaced it", async () => {
    const NEW = "11111111-2222-4333-8444-555555555555";
    const { t, seen } = await alpaca({ [`GET ${LIVE}/v2/orders/${ID}`]: json(order({ status: "replaced", replaced_by: NEW })), [`GET ${LIVE}/v2/orders/${NEW}`]: json(order({ id: NEW, status: "new", replaces: ID })) });
    const s = ok(await t.status(ID, "AAPL"));
    expect([s.ref, s.status]).toEqual([NEW, "open"]);
    expect(calls(seen)).toEqual([`GET ${LIVE}/v2/orders/${ID}`, `GET ${LIVE}/v2/orders/${NEW}`]);
  });

  it("an order Alpaca does not have for this key is unknown", async () => {
    const { t } = await alpaca({ [`GET ${LIVE}/v2/orders/nope`]: json({ code: 40410000, message: "order not found for nope" }, 404) });
    const no = refusal(await t.status("nope", "AAPL"));
    expect([no.code, no.message, no.native]).toEqual(["E_ACCOUNT_ORDER_UNKNOWN", "Alpaca has no order nope for this key", { status: 404, code: 40410000, said: "order not found for nope" }]);
  });
});

describe("cancelling", () => {
  it("DELETE /v2/orders/{id}: 204 is the cancel asked for, so the order is read back as it stands", async () => {
    const { t, seen } = await alpaca({ [`DELETE ${LIVE}/v2/orders/${ID}`]: { status: 204, body: undefined, text: "" }, [`GET ${LIVE}/v2/orders/${ID}`]: json(order({ status: "canceled", canceled_at: new Date().toISOString(), filled_qty: "1", filled_avg_price: "200.1" })) });
    const s = ok(await t.cancel(ID, "AAPL"));
    expect([s.status, s.filledQty, s.avgPrice]).toEqual(["canceled", 1, 200.1]);
    expect(seen.map((r) => [r.method, r.url, r.headers, r.body])).toEqual([
      ["DELETE", `${LIVE}/v2/orders/${ID}`, AUTH, undefined],
      ["GET", `${LIVE}/v2/orders/${ID}`, AUTH, undefined],
    ]);
  });

  it("422, no longer cancelable: a filled order is read back as filled; one still working keeps Alpaca's refusal; an unknown one is unknown", async () => {
    const notCancelable = json({ code: 42210000, message: "order is not cancelable" }, 422);
    const filled = await alpaca({ [`DELETE ${LIVE}/v2/orders/${ID}`]: notCancelable, [`GET ${LIVE}/v2/orders/${ID}`]: json(order({ status: "filled", filled_qty: "3", filled_avg_price: "200" })) });
    expect(ok(await filled.t.cancel(ID, "AAPL")).status).toBe("filled");
    const replacing = await alpaca({ [`DELETE ${LIVE}/v2/orders/${ID}`]: notCancelable, [`GET ${LIVE}/v2/orders/${ID}`]: json(order({ status: "pending_replace" })) });
    const no = refusal(await replacing.t.cancel(ID, "AAPL"));
    expect([no.code, no.message]).toEqual(["E_VENUE_ORDER_INVALID", "Alpaca: order is not cancelable"]);
    const gone = await alpaca({ [`DELETE ${LIVE}/v2/orders/${ID}`]: json({ code: 40410000, message: `order not found for ${ID}` }, 404) });
    expect(refusal(await gone.t.cancel(ID, "AAPL")).code).toBe("E_ACCOUNT_ORDER_UNKNOWN");
  });
});

describe("Alpaca's refusals, in its own words", () => {
  const placing = async (answer: HttpReply): Promise<Refusal> => {
    const { t } = await alpaca({ [`POST ${LIVE}/v2/orders`]: answer });
    return refusal(await t.place({ symbol: "AAPL", side: "buy", type: "market", qty: 100000, worstPrice: 204.73, clientId: "ord-0100" }));
  };

  it("not enough buying power, or not enough shares to sell", async () => {
    const bp = await placing(json({ buying_power: "558660.03", code: 40310000, cost_basis: "680930026.5", message: "insufficient buying power" }, 403));
    expect([bp.code, bp.message, bp.native]).toEqual(["E_VENUE_INSUFFICIENT", "Alpaca: insufficient buying power", { status: 403, code: 40310000, said: "insufficient buying power", buying_power: "558660.03", cost_basis: "680930026.5" }]);
    const qty = await placing(json({ available: "0", code: 40310000, existing_qty: "10", held_for_orders: "10", message: "insufficient qty available for order (requested: 5, available: 0)", symbol: "AAPL" }, 403));
    expect([qty.code, (qty.native as Record<string, unknown>).held_for_orders]).toEqual(["E_VENUE_INSUFFICIENT", "10"]);
  });

  it("a size, a tick or a time in force the market does not take", async () => {
    for (const [status, body] of [
      [422, { code: 42210000, message: "invalid limit_price 290.123. sub-penny increment does not fulfill minimum pricing criteria" }],
      [422, { code: 42210000, message: "fractional orders must be DAY orders" }],
      [422, { code: 40010001, message: "qty or notional is required" }],
      [403, { code: 40310000, message: 'asset "CWVX" is not fractionable' }],
    ] as const) {
      const no = await placing(json(body, status));
      expect([no.code, no.message, no.detail]).toEqual(["E_VENUE_ORDER_INVALID", `Alpaca: ${body.message}`, { code: body.code }]);
      expect(no.native).toEqual({ status, code: body.code, said: body.message });
    }
  });

  it("an account that may not trade, the old pattern-day-trader guard, a stock Alpaca does not trade now", async () => {
    const blocked = await placing(json({ code: 40310000, message: "account is not authorized to trade" }, 403));
    expect([blocked.code, blocked.message]).toEqual(["E_VENUE_PERMISSION", "Alpaca: account is not authorized to trade"]);
    expect((await placing(json({ code: 40310100, message: "trade denied due to pattern day trading protection" }, 403))).code).toBe("E_VENUE_PERMISSION");
    expect((await placing(json({ code: 42210000, message: 'asset "HALT" is not tradable' }, 422))).code).toBe("E_VENUE_MARKET_CLOSED");
    expect((await placing(json({ code: 42210000, message: "options market orders are only allowed during market hours" }, 422))).code).toBe("E_VENUE_MARKET_CLOSED");
  });

  it("Alpaca's own region rule is reported as that, and nothing looks for a way around it", async () => {
    const region = await placing(json({ code: 40310000, message: "crypto trading is not available in your jurisdiction" }, 403));
    expect([region.code, region.message]).toEqual(["E_VENUE_GEOBLOCKED", "Alpaca does not serve this location: that is its own rule, and the account does not look for a way around it"]);
    expect((await placing(json({ message: "unavailable for legal reasons" }, 451))).code).toBe("E_VENUE_GEOBLOCKED");
  });

  it("a key Alpaca does not accept (its edge answers in HTML), the rate limit, an outage; nothing secret in any of them", async () => {
    const html = await placing({ status: 401, body: undefined, text: "<html><head><title>401 Authorization Required</title></head><body><center><h1>401 Authorization Required</h1></center><hr><center>nginx</center></body></html>" });
    expect([html.code, html.message]).toEqual(["E_VENUE_UNAUTHORIZED", "Alpaca does not accept this key"]);
    expect((await placing(json({ message: "unauthorized." }, 401))).code).toBe("E_VENUE_UNAUTHORIZED");
    expect((await placing(json({ code: 42910000, message: "rate limit exceeded" }, 429))).code).toBe("E_VENUE_UNREACHABLE");
    // a body that repeats the key back is redacted before it is kept
    const echoed = await placing(json({ code: 40010001, message: `invalid key ${KEY_ID} with secret ${SECRET}` }, 422));
    expect(echoed.message).toBe("Alpaca: invalid key ••• with secret •••");
  });
});
