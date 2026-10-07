import { describe, expect, it } from "vitest";
import { isRefusal, type Refusal } from "../../src/core/errors.ts";
import { byAsset } from "../../src/portfolio/account/holdings.ts";
import { liveAccount } from "../../src/portfolio/adapters/live.ts";
import { alpacaSource } from "../../src/portfolio/live/alpaca.ts";
import type { Candle, CandleInterval, LiveTrader, Market, MarketStats, OrderRequest, OrderState } from "../../src/portfolio/live/trade.ts";
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

/** Alpaca as a stand-in: an answer by "METHOD url" (a list is answered in turn, its last one from then on); anything not set up is a 404.
 * The two reads made while connecting are answered here; once connected, a test may answer GET /v2/positions itself */
async function alpaca(answers: Record<string, Answer | Answer[]> = {}, opts: { paper?: boolean; clock?: number } = {}): Promise<{ t: LiveTrader; seen: Req[]; reads: Req[]; source: LiveSource }> {
  const seen: Req[] = [];
  const host = opts.paper ? PAPER : LIVE;
  let connected = false;
  const http: Http = async (url, init = {}) => {
    const req: Req = { method: init.method ?? "GET", url, headers: { ...(init.headers ?? {}) }, ...(init.body !== undefined ? { body: JSON.parse(init.body) } : {}) };
    seen.push(req);
    const a = answers[`${req.method} ${url}`];
    if (!connected || a === undefined) {
      if (url === `${host}/v2/account`) return json({ status: "ACTIVE", crypto_status: "ACTIVE", cash: "2500.50", equity: "2500.50", buying_power: "5001" });
      if (url === `${host}/v2/positions` && req.method === "GET") return json([]);
    }
    const next = Array.isArray(a) ? (a.length > 1 ? a.shift() : a[0]) : a;
    if (next === undefined) return json({ message: `not set up in this test: ${req.method} ${url}` }, 404);
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(req) : next;
  };
  // a Monday afternoon in New York, the day of the snapshots below, unless a test says another moment
  const now = opts.clock ?? Date.parse("2026-10-05T19:53:20.000Z");
  const opened = await alpacaSource({ venue: "alpaca", label: "", reference: "credentials/alpaca/api-key.json", key: { keyId: KEY_ID, secret: SECRET, ...(opts.paper ? { paper: "true" } : {}) }, http, clock: () => now });
  if (isRefusal(opened)) throw new Error(opened.message);
  connected = true;
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
/** the order bodies sent to Alpaca */
const posted = (seen: Req[]) => seen.filter((r) => r.method === "POST").map((r) => r.body as Record<string, string>);

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
/** how Alpaca shows a sell stop of 3 AAPL at 190 sent as a stop-limit whose limit is its worst price, 186.2 */
const STOP = { type: "stop_limit", order_type: "stop_limit", side: "sell", stop_price: "190", limit_price: "186.2", time_in_force: "gtc" };
/** a whole-share limit buy of 2 AAPL at 150.25, resting */
const LIMIT_150 = { type: "limit", order_type: "limit", limit_price: "150.25", qty: "2", time_in_force: "gtc", status: "new" };
/** the ids Alpaca gives an order's replacements */
const NEW = "22222222-3333-4444-8555-666666666666";
const NEWER = "33333333-4444-4555-8666-777777777777";

const stockAnswers = (asset: Record<string, unknown>, clock: unknown, q: unknown, tr: unknown): Record<string, Answer> => ({
  [`GET ${LIVE}/v2/assets/${String(asset.symbol)}`]: json(asset),
  [`GET ${LIVE}/v2/clock`]: json(clock),
  [`GET ${DATA}/v2/stocks/${String(asset.symbol)}/quotes/latest`]: json(q),
  [`GET ${DATA}/v2/stocks/${String(asset.symbol)}/trades/latest`]: json(tr),
});

describe("Alpaca's connection carries a trader", () => {
  it("through the source the account opens: it can trade, and says what; the two reads and the one soft question about crypto wallets are the only calls made while connecting", async () => {
    const { t, reads, source } = await alpaca();
    expect([t.can, t.what]).toEqual([true, "US stocks, ETFs and crypto"]);
    expect(calls(reads)).toEqual([`GET ${LIVE}/v2/account`, `GET ${LIVE}/v2/positions`, `GET ${LIVE}/v2/wallets`]);
    // Alpaca's 404 to GET /v2/wallets is Alpaca's answer: no crypto wallets for this account, in its words, and nothing is assumed about cash
    expect(source.writer).toBeUndefined();
    expect(source.readOnlyBecause).toBe('Alpaca has not enabled the Crypto Wallets API for this account (GET /v2/wallets: HTTP 404, "not set up in this test: GET https://api.alpaca.markets/v2/wallets"): cash moves by ACH at Alpaca, and crypto wallets are enabled by Alpaca on request');
    expect(source.probe).toEqual({ can: ["read", "trade"], note: `an Alpaca key has no scopes: any key can place orders. ${source.readOnlyBecause}`, native: { calls: ["GET /v2/account", "GET /v2/positions", "GET /v2/wallets"], paper: false, wallets: false } });
    expect(source.noTradeBecause).toBeUndefined();
  });

  it("an account Alpaca has enabled crypto wallets for: a writer that receives — GET /v2/wallets?asset=&chain= gives the wallet, made on the spot — and nothing leaves, in Alpaca's words (its withdrawal endpoint is deprecated, sunset 2026-10-09)", async () => {
    const WALLET = "0x2222222222222222222222222222222222222222";
    const { seen, source } = await alpaca({
      [`GET ${LIVE}/v2/wallets`]: json([]),
      [`GET ${LIVE}/v2/wallets?asset=USDC&chain=ETH`]: json({ address: WALLET.toLowerCase(), chain: "ETH", created_at: "2026-10-06T09:00:00Z" }),
      [`GET ${LIVE}/v2/wallets?asset=USDG&chain=ARB`]: json({ code: 40410000, message: "asset not found" }, 404),
    });
    expect(source.readOnlyBecause).toBeUndefined();
    expect(source.probe.note).toContain("Crypto comes in to Alpaca's wallets for this account (GET /v2/wallets: enabled)");
    expect((source.probe.native as { wallets: boolean }).wallets).toBe(true);
    const w = source.writer!;
    expect(w.can).toEqual({ withdraw: false, ledgers: [], transfer: false, swap: false, receive: true, send: false, why: { withdraw: expect.stringContaining("Sunset: 2026-10-09") as unknown as string } });
    expect([w.withdraw, w.transfer, w.swap, w.send]).toEqual([undefined, undefined, undefined, undefined]);
    const eth = ok(await w.depositAddress("USDC", "Ethereum"));
    expect(eth.address).toBe(WALLET);
    expect(eth.note).toContain("Alpaca's own USDC wallet for this account on Ethereum");
    expect(calls(seen)).toEqual([`GET ${LIVE}/v2/wallets?asset=USDC&chain=ETH`]);
    expect(seen[0]!.headers).toEqual(AUTH);
    // Alpaca's chains are ETH, ARB, SOL, BTC and XRP: a chain of this account's that is not among them is refused before Alpaca is asked
    const poly = refusal(await w.depositAddress("USDC", "Polygon"));
    expect([poly.code, poly.message]).toEqual(["E_VENUE_RAIL_CLOSED", "Alpaca's crypto wallets are on Ethereum and Arbitrum (Alpaca's chains: ETH, ARB, SOL, BTC, XRP): not on Polygon"]);
    // an asset Alpaca has no wallet for: its own words
    const none = refusal(await w.depositAddress("USDG", "Arbitrum"));
    expect([none.code, none.message]).toEqual(["E_VENUE_RAIL_CLOSED", "Alpaca has no USDG wallet on Arbitrum for this account (it says: asset not found)"]);
    expect(calls(seen)).toEqual([`GET ${LIVE}/v2/wallets?asset=USDC&chain=ETH`, `GET ${LIVE}/v2/wallets?asset=USDG&chain=ARB`]);
  });

  it("Alpaca not answering the wallets question is not a no: nothing is sent to it until it is connected again, and the words say so", async () => {
    const { source } = await alpaca({ [`GET ${LIVE}/v2/wallets`]: json({ message: "service unavailable" }, 503) });
    expect(source.writer).toBeUndefined();
    expect(source.readOnlyBecause).toBe('Alpaca did not say whether this account has crypto wallets (GET /v2/wallets: HTTP 503, "service unavailable"): nothing is sent to it from here until it is connected again. Cash moves by ACH at Alpaca');
  });

  it("with Alpaca's replace, its positions and its close; no leverage call, since Alpaca sets none per position", async () => {
    const { t, seen } = await alpaca();
    expect([typeof t.amend, typeof t.positions, typeof t.close, t.setLeverage, t.sent, t.requote]).toEqual(["function", "function", "function", undefined, undefined, undefined]);
    // it reads the market — many at once, and price history — and lists no events: Alpaca has no event contracts
    expect([typeof t.stats, typeof t.candles, t.events]).toEqual(["function", "function", undefined]);
    expect(seen).toEqual([]);
  });
});

describe("one market, with a fresh price", () => {
  it("a stock while the market is open: the asset, the clock, the latest quote and trade, asked at once with the key's two headers", async () => {
    const { t, seen } = await alpaca(stockAnswers(AAPL, OPEN, quote("AAPL", 200.25, 200.75), trade("AAPL", 200.4)));
    const m = ok(await t.market("aapl"));
    expect(m).toEqual({ symbol: "AAPL", name: "Apple Inc. Common Stock", kind: "stock", base: "AAPL", quote: "USD", price: 200.5, bid: 200.25, ask: 200.75, qtyStep: 1e-9, priceStep: 0.01, minNotional: 1, open: true, types: ["market", "limit", "stop", "stop_limit"], tifs: ["day", "gtc"] } satisfies Market);
    // Alpaca has no post-only or reduce-only order, and no leverage per position: none is declared
    expect(["postOnly", "reduceOnly", "maxLeverage"].filter((k) => k in m)).toEqual([]);
    expect(calls(seen)).toEqual([`GET ${LIVE}/v2/assets/AAPL`, `GET ${LIVE}/v2/clock`, `GET ${DATA}/v2/stocks/AAPL/quotes/latest`, `GET ${DATA}/v2/stocks/AAPL/trades/latest`]);
    for (const r of seen) expect(r.headers).toEqual(AUTH);
  });

  it("a stock while the market is closed takes no market order — Alpaca holds an order for the open, and a market order would fill at the opening price — but limits, stops and stop-limits; the owner is told; whole shares, a sub-dollar tick", async () => {
    const { t } = await alpaca(stockAnswers(PNNY, SHUT, quote("PNNY", 0, 0), trade("PNNY", 0.5123)));
    const m = ok(await t.market("PNNY"));
    expect([m.open, m.price, m.bid, m.ask, m.minQty, m.qtyStep, m.priceStep, m.minNotional, m.types, m.tifs]).toEqual([true, 0.5123, undefined, undefined, 1, 1, 0.0001, 1, ["limit", "stop", "stop_limit"], ["day", "gtc"]]);
    expect(m.note).toBe("the US stock market is closed: Alpaca holds an order and sends it when the market opens (2026-10-06 09:30 New York time). Until then no market order is placed here: it would fill at the opening price, which can be well away from this one. A limit, stop or stop-limit order waits for the open with its limit");
  });

  it("a clock that does not answer cannot say the market is open: no market order, and the owner is told why", async () => {
    const { t } = await alpaca({ ...stockAnswers(AAPL, OPEN, quote("AAPL", 200.25, 200.75), trade("AAPL", 200.4)), [`GET ${LIVE}/v2/clock`]: json({ code: 50010000, message: "internal server error" }, 500) });
    const m = ok(await t.market("AAPL"));
    expect([m.open, m.types, m.price]).toEqual([true, ["limit", "stop", "stop_limit"], 200.5]);
    expect(m.note).toBe("Alpaca's market clock did not answer, so no market order is placed here: outside market hours Alpaca holds an order until the market opens, and a market order would fill at the opening price");
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
    // crypto takes market, limit and stop-limit (a stop goes as a stop-limit); gtc and ioc only, and a stop or stop-limit gtc only
    expect(m).toEqual({ symbol: "BTC/USD", name: "Bitcoin / US Dollar", kind: "crypto", base: "BTC", quote: "USD", price: 85598, bid: 85584.5, ask: 85611.5, minQty: 0.0001, qtyStep: 1e-9, priceStep: 0.1, open: true, types: ["market", "limit", "stop", "stop_limit"], tifs: ["gtc", "ioc"], tifsByType: { stop: ["gtc"], stop_limit: ["gtc"] } } satisfies Market);
    expect(["postOnly", "reduceOnly", "maxLeverage"].filter((k) => k in m)).toEqual([]);
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
    expect(calls(reads)).toEqual([`GET ${PAPER}/v2/account`, `GET ${PAPER}/v2/positions`, `GET ${PAPER}/v2/wallets`]);
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
    expect(ok(await shut.t.market("AAPL")).types).toEqual(["limit", "stop", "stop_limit"]);
    const open = await alpaca(stockAnswers(AAPL, OPEN, quote("AAPL", 200.25, 200.75), trade("AAPL", 200.4)));
    expect(ok(await open.t.market("AAPL")).types).toEqual(["market", "limit", "stop", "stop_limit"]);
  });
});

describe("stop and stop-limit orders", () => {
  it("a stock stop goes as a stop-limit whose limit is its worst price, put onto the tick on the safe side; a whole-share stop is gtc, a fraction day", async () => {
    const { t, seen } = await alpaca({ [`POST ${LIVE}/v2/orders`]: json(order({ ...STOP, status: "new", client_order_id: "ord-0600" })) });
    const s = ok(await t.place({ symbol: "AAPL", side: "sell", type: "stop", qty: 3, stopPrice: 190, worstPrice: 186.2049, clientId: "ord-0600" }));
    await t.place({ symbol: "AAPL", side: "buy", type: "stop", qty: 0.5, stopPrice: 210, worstPrice: 214.2099, clientId: "ord-0601" });
    expect(posted(seen)).toEqual([
      // a sell's worst price goes up onto the cent, a buy's down: never past the worst price
      { symbol: "AAPL", qty: "3", side: "sell", type: "stop_limit", stop_price: "190", limit_price: "186.21", time_in_force: "gtc", client_order_id: "ord-0600" },
      { symbol: "AAPL", qty: "0.5", side: "buy", type: "stop_limit", stop_price: "210", limit_price: "214.2", time_in_force: "day", client_order_id: "ord-0601" },
    ]);
    expect([s.ref, s.status]).toEqual([ID, "open"]);
    expect(s.native).toMatchObject({ type: "stop_limit", stop_price: "190", limit_price: "186.2" });
  });

  it("a stop-limit carries both its prices as given, gtc for whole shares", async () => {
    const { t, seen } = await alpaca({ [`POST ${LIVE}/v2/orders`]: json(order({ type: "stop_limit", stop_price: "210", limit_price: "211.5", status: "new" })) });
    ok(await t.place({ symbol: "AAPL", side: "buy", type: "stop_limit", qty: 2, stopPrice: 210, limitPrice: 211.5, clientId: "ord-0602" }));
    expect(posted(seen)).toEqual([{ symbol: "AAPL", qty: "2", side: "buy", type: "stop_limit", stop_price: "210", limit_price: "211.5", time_in_force: "gtc", client_order_id: "ord-0602" }]);
  });

  it("a coin's stop goes as a gtc stop-limit at its worst price on the pair's price_increment; Alpaca takes no ioc stop-limit for crypto, so one is refused before anything is sent", async () => {
    const { t, seen } = await alpaca({ [`GET ${LIVE}/v2/assets/BTC%2FUSD`]: json(BTC), [`POST ${LIVE}/v2/orders`]: json(order({ symbol: "BTC/USD", asset_class: "crypto", type: "stop_limit", stop_price: "80000", limit_price: "78400.1", time_in_force: "gtc", status: "new" })) });
    ok(await t.place({ symbol: "BTC/USD", side: "sell", type: "stop", qty: 0.01, stopPrice: 80000, worstPrice: 78400.04, clientId: "ord-0603" }));
    expect(posted(seen)).toEqual([{ symbol: "BTC/USD", qty: "0.01", side: "sell", type: "stop_limit", stop_price: "80000", limit_price: "78400.1", time_in_force: "gtc", client_order_id: "ord-0603" }]);
    seen.length = 0;
    expect(refusal(await t.place({ symbol: "BTC/USD", side: "sell", type: "stop", qty: 0.01, stopPrice: 80000, worstPrice: 78400, tif: "ioc", clientId: "ord-0604" })).message).toBe("Alpaca: a crypto stop order is gtc only, not ioc");
    expect(refusal(await t.place({ symbol: "BTC/USD", side: "buy", type: "stop_limit", qty: 0.01, stopPrice: 90000, limitPrice: 90500, tif: "ioc", clientId: "ord-0605" })).message).toBe("Alpaca: a crypto stop-limit order is gtc only, not ioc");
    expect(seen).toEqual([]);
  });

  it("a stop or stop-limit that cannot be right, and a flag Alpaca has no word for, are refused before anything is sent", async () => {
    const { t, seen } = await alpaca({ [`POST ${LIVE}/v2/orders`]: json(order()) });
    const base = { symbol: "AAPL", qty: 1, clientId: "ord-0606" } as const;
    const cases: Array<[OrderRequest, string]> = [
      [{ ...base, side: "sell", type: "stop", stopPrice: 190 }, "a stop order carries the worst price it may fill at"],
      [{ ...base, side: "sell", type: "stop", worstPrice: 186.2 }, "a stop order has a stop price that triggers it"],
      [{ ...base, side: "sell", type: "stop", stopPrice: 190, worstPrice: 186.2, limitPrice: 186.2 }, "a stop order has no limit price"],
      [{ ...base, side: "buy", type: "stop_limit", stopPrice: 210 }, "a stop-limit order has a limit price"],
      [{ ...base, side: "buy", type: "stop_limit", limitPrice: 211 }, "a stop-limit order has a stop price that triggers it"],
      [{ ...base, side: "buy", type: "limit", limitPrice: 150, stopPrice: 149 }, "a limit order has no stop price"],
      [{ ...base, side: "buy", type: "market", worstPrice: 204.73, stopPrice: 200 }, "a market order has no stop price"],
      // a buy stop's worst price under its trigger: the limit order it turns into could not fill at the price that triggered it
      [{ ...base, side: "buy", type: "stop", stopPrice: 210, worstPrice: 205 }, "a buy stop's worst price (205) is under its stop price (210): the order it triggers could not fill"],
      [{ ...base, side: "sell", type: "stop", stopPrice: 190, worstPrice: 191 }, "a sell stop's worst price (191) is over its stop price (190): the order it triggers could not fill"],
      [{ ...base, side: "sell", type: "stop_limit", stopPrice: 190.0000000001, limitPrice: 189 }, "a stop price has at most nine decimal places"],
      [{ ...base, side: "buy", type: "limit", limitPrice: 150, postOnly: true }, "no post-only order is taken here"],
      [{ ...base, side: "sell", type: "market", worstPrice: 196.46, reduceOnly: true }, "no reduce-only order is taken here: an order can open or grow a position"],
    ];
    for (const [o, message] of cases) {
      const no = refusal(await t.place(o));
      expect([no.code, no.message]).toEqual(["E_VENUE_ORDER_INVALID", `Alpaca: ${message}`]);
    }
    expect(seen).toEqual([]);
  });
});

describe("time in force", () => {
  it("each one Alpaca takes goes as its own word: day and gtc for a stock, gtc and ioc for a coin", async () => {
    const { t, seen } = await alpaca({ [`GET ${LIVE}/v2/assets/ETH%2FUSD`]: json({ ...BTC, symbol: "ETH/USD", name: "Ethereum / US Dollar", price_increment: "0.01" }), [`POST ${LIVE}/v2/orders`]: json(order()) });
    const cases: Array<[OrderRequest, string]> = [
      [{ symbol: "AAPL", side: "buy", type: "limit", qty: 2, limitPrice: 150, tif: "day", clientId: "ord-0700" }, "day"],
      [{ symbol: "AAPL", side: "buy", type: "limit", qty: 2, limitPrice: 150, tif: "gtc", clientId: "ord-0701" }, "gtc"],
      [{ symbol: "AAPL", side: "buy", type: "market", qty: 2, worstPrice: 204.73, tif: "gtc", clientId: "ord-0702" }, "gtc"],
      [{ symbol: "AAPL", side: "sell", type: "stop", qty: 2, stopPrice: 190, worstPrice: 186.2, tif: "day", clientId: "ord-0703" }, "day"],
      [{ symbol: "AAPL", side: "buy", type: "stop_limit", qty: 2, stopPrice: 210, limitPrice: 211, tif: "gtc", clientId: "ord-0704" }, "gtc"],
      [{ symbol: "AAPL", side: "buy", type: "limit", qty: 0.25, limitPrice: 199.5, tif: "day", clientId: "ord-0705" }, "day"],
      [{ symbol: "ETH/USD", side: "buy", type: "limit", qty: 0.02, limitPrice: 2100, tif: "ioc", clientId: "ord-0706" }, "ioc"],
      [{ symbol: "ETH/USD", side: "buy", type: "limit", qty: 0.02, limitPrice: 2100, tif: "gtc", clientId: "ord-0707" }, "gtc"],
      [{ symbol: "ETH/USD", side: "sell", type: "market", qty: 0.02, worstPrice: 2000, tif: "gtc", clientId: "ord-0708" }, "gtc"],
      [{ symbol: "ETH/USD", side: "sell", type: "market", qty: 0.02, worstPrice: 2000, tif: "ioc", clientId: "ord-0709" }, "ioc"],
    ];
    for (const [o] of cases) ok(await t.place(o));
    expect(posted(seen).map((b) => [b.client_order_id, b.time_in_force])).toEqual(cases.map(([o, tif]) => [o.clientId, tif]));
  });

  it("one Alpaca does not take there is refused before anything is sent: a stock's ioc and fok (its sales team's to turn on), a coin's day and fok, a fraction's gtc", async () => {
    const { t, seen } = await alpaca({ [`POST ${LIVE}/v2/orders`]: json(order()) });
    const cases: Array<[OrderRequest, string]> = [
      [{ symbol: "AAPL", side: "buy", type: "limit", qty: 2, limitPrice: 150, tif: "ioc", clientId: "ord-0710" }, "a stock order is day or gtc here, not ioc (which its sales team turns on for an account)"],
      [{ symbol: "AAPL", side: "buy", type: "market", qty: 2, worstPrice: 204.73, tif: "fok", clientId: "ord-0711" }, "a stock order is day or gtc here, not fok (which its sales team turns on for an account)"],
      [{ symbol: "ETH/USD", side: "buy", type: "limit", qty: 0.02, limitPrice: 2100, tif: "day", clientId: "ord-0712" }, "a crypto order is gtc or ioc, not day"],
      [{ symbol: "ETH/USD", side: "buy", type: "limit", qty: 0.02, limitPrice: 2100, tif: "fok", clientId: "ord-0713" }, "a crypto order is gtc or ioc, not fok"],
      [{ symbol: "AAPL", side: "buy", type: "limit", qty: 0.25, limitPrice: 199.5, tif: "gtc", clientId: "ord-0714" }, "a fraction of a share is a day order, not gtc"],
      [{ symbol: "AAPL", side: "sell", type: "stop", qty: 0.25, stopPrice: 190, worstPrice: 186.2, tif: "gtc", clientId: "ord-0715" }, "a fraction of a share is a day order, not gtc"],
    ];
    for (const [o, message] of cases) {
      const no = refusal(await t.place(o));
      expect([no.code, no.message]).toEqual(["E_VENUE_ORDER_INVALID", `Alpaca: ${message}`]);
    }
    expect(seen).toEqual([]);
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

  it("a stop or stop-limit waiting for its stop price is working: held and new read as open; accepted and pending_new are pending; stopped (a trade guaranteed, not yet made) is open", async () => {
    let now: Record<string, unknown> = order(STOP);
    const { t } = await alpaca({ [`GET ${LIVE}/v2/orders/${ID}`]: () => json(now) });
    const cases: Array<[Record<string, unknown>, OrderState["status"]]> = [
      [{ ...STOP, status: "held" }, "open"],
      [{ ...STOP, status: "new" }, "open"],
      [{ ...STOP, status: "accepted" }, "pending"],
      [{ ...STOP, status: "pending_new" }, "pending"],
      [{ ...STOP, status: "stopped" }, "open"],
      [{ ...STOP, status: "partially_filled", filled_qty: "1", filled_avg_price: "188.4" }, "partial"],
      [{ ...STOP, status: "filled", filled_qty: "3", filled_avg_price: "188.1" }, "filled"],
      [{ ...STOP, status: "canceled" }, "canceled"],
      [{ ...STOP, status: "expired" }, "expired"],
      // a plain stop (placed at Alpaca, not from here) waits the same way
      [{ type: "stop", order_type: "stop", stop_price: "190", limit_price: null, status: "held" }, "open"],
      // a held order of another kind is a leg waiting on another: taken, not yet working
      [{ type: "limit", order_type: "limit", limit_price: "150", status: "held" }, "pending"],
    ];
    for (const [over, want] of cases) {
      now = order(over);
      expect([over.type, over.status, ok(await t.status(ID, "AAPL")).status]).toEqual([over.type, over.status, want]);
    }
  });

  it("a replacement Alpaca rejected because the order it was to replace filled first reads as that fill; one rejected on its own stays rejected", async () => {
    const raced = await alpaca({ [`GET ${LIVE}/v2/orders/${NEW}`]: json(order({ ...LIMIT_150, id: NEW, limit_price: "151", status: "rejected", replaces: ID })), [`GET ${LIVE}/v2/orders/${ID}`]: json(order({ ...LIMIT_150, status: "filled", filled_qty: "2", filled_avg_price: "150.25" })) });
    const s = ok(await raced.t.status(NEW, "AAPL"));
    expect([s.ref, s.status, s.filledQty, s.avgPrice]).toEqual([ID, "filled", 2, 150.25]);
    expect(calls(raced.seen)).toEqual([`GET ${LIVE}/v2/orders/${NEW}`, `GET ${LIVE}/v2/orders/${ID}`]);
    const own = await alpaca({ [`GET ${LIVE}/v2/orders/${NEW}`]: json(order({ ...LIMIT_150, id: NEW, limit_price: "151", status: "rejected", replaces: ID })), [`GET ${LIVE}/v2/orders/${ID}`]: json(order({ ...LIMIT_150, status: "replaced", replaced_by: NEW })) });
    expect([ok(await own.t.status(NEW, "AAPL")).status, ok(await own.t.status(NEW, "AAPL")).ref]).toEqual(["rejected", NEW]);
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

describe("changing an open order: Alpaca's replace", () => {
  const limitBuy: OrderRequest = { symbol: "AAPL", side: "buy", type: "limit", qty: 2, limitPrice: 150.25, clientId: "ord-0800" };

  it("a limit order's new price: the order is read, then PATCH /v2/orders/{id} carries the new limit, its time in force and an id of the account's for the new order; the answer is the new order, under its new id", async () => {
    const cid = `ord-0800-r-${ID}`;
    const { t, seen } = await alpaca({ [`GET ${LIVE}/v2/orders/${ID}`]: json(order({ ...LIMIT_150, client_order_id: "ord-0800" })), [`PATCH ${LIVE}/v2/orders/${ID}`]: json(order({ ...LIMIT_150, id: NEW, limit_price: "151", status: "pending_new", client_order_id: cid, replaces: ID })) });
    const s = ok(await t.amend!(ID, "AAPL", { limitPrice: 151 }, limitBuy));
    expect(seen.map((r) => [r.method, r.url, r.body])).toEqual([
      ["GET", `${LIVE}/v2/orders/${ID}`, undefined],
      ["PATCH", `${LIVE}/v2/orders/${ID}`, { limit_price: "151", time_in_force: "gtc", client_order_id: cid }],
    ]);
    expect(seen[1]!.headers).toEqual({ ...AUTH, "content-type": "application/json" });
    expect([s.ref, s.status, s.filledQty]).toEqual([NEW, "pending", 0]);
    expect(s.native).toMatchObject({ id: NEW, replaces: ID, limit_price: "151", client_order_id: cid });
  });

  it("a whole-share size changes with the limit Alpaca holds carried along, as its replace requires", async () => {
    const { t, seen } = await alpaca({ [`GET ${LIVE}/v2/orders/${ID}`]: json(order(LIMIT_150)), [`PATCH ${LIVE}/v2/orders/${ID}`]: json(order({ ...LIMIT_150, id: NEW, qty: "5" })) });
    expect(ok(await t.amend!(ID, "AAPL", { qty: 5 }, limitBuy)).ref).toBe(NEW);
    expect(seen[1]!.body).toEqual({ qty: "5", limit_price: "150.25", time_in_force: "gtc", client_order_id: `ord-0800-r-${ID}` });
  });

  it("a stop's size or stop: the stop-limit Alpaca holds keeps its worst price as its limit; a stop moved past that worst price, or a new limit for it, is refused before anything is sent", async () => {
    const placed: OrderRequest = { symbol: "AAPL", side: "sell", type: "stop", qty: 3, stopPrice: 190, worstPrice: 186.2, clientId: "ord-0801" };
    const { t, seen } = await alpaca({ [`GET ${LIVE}/v2/orders/${ID}`]: json(order({ ...STOP, status: "held", client_order_id: "ord-0801" })), [`PATCH ${LIVE}/v2/orders/${ID}`]: json(order({ ...STOP, id: NEW, qty: "5", stop_price: "188", status: "held", replaces: ID })) });
    const s = ok(await t.amend!(ID, "AAPL", { qty: 5, stopPrice: 188 }, placed));
    expect(seen[1]!.body).toEqual({ qty: "5", limit_price: "186.2", stop_price: "188", time_in_force: "gtc", client_order_id: `ord-0801-r-${ID}` });
    expect([s.ref, s.status]).toEqual([NEW, "open"]);
    seen.length = 0;
    // a sell stop under its worst price: the limit order it would turn into could not fill when it triggers
    expect(refusal(await t.amend!(ID, "AAPL", { stopPrice: 185 }, placed)).message).toBe("Alpaca: a sell stop at 185 would be past its worst price, 186.2, and the order it triggers could not fill: cancel it and place a new stop order");
    expect(refusal(await t.amend!(ID, "AAPL", { limitPrice: 180 }, placed)).message).toBe("Alpaca: a stop order has no limit price to change: it is held to its worst price, which stays");
    expect(calls(seen)).toEqual([`GET ${LIVE}/v2/orders/${ID}`]);
  });

  it("a stop-limit takes a new limit and a new stop; a market order, held as a limit at its worst price, only a new size", async () => {
    const stopLimit: OrderRequest = { symbol: "AAPL", side: "buy", type: "stop_limit", qty: 2, stopPrice: 210, limitPrice: 211.5, clientId: "ord-0802" };
    const a = await alpaca({ [`GET ${LIVE}/v2/orders/${ID}`]: json(order({ type: "stop_limit", order_type: "stop_limit", stop_price: "210", limit_price: "211.5", qty: "2", status: "new", time_in_force: "day" })), [`PATCH ${LIVE}/v2/orders/${ID}`]: json(order({ id: NEW, type: "stop_limit", stop_price: "209.5", limit_price: "212", qty: "2", status: "new" })) });
    ok(await a.t.amend!(ID, "AAPL", { limitPrice: 212, stopPrice: 209.5 }, stopLimit));
    expect(a.seen[1]!.body).toEqual({ limit_price: "212", stop_price: "209.5", time_in_force: "day", client_order_id: `ord-0802-r-${ID}` });
    const market: OrderRequest = { symbol: "AAPL", side: "buy", type: "market", qty: 3, worstPrice: 204.73, clientId: "ord-0803" };
    const b = await alpaca({ [`GET ${LIVE}/v2/orders/${ID}`]: json(order({ ...LIMIT, status: "new" })), [`PATCH ${LIVE}/v2/orders/${ID}`]: json(order({ ...LIMIT, id: NEW, qty: "4", status: "new" })) });
    ok(await b.t.amend!(ID, "AAPL", { qty: 4 }, market));
    expect(b.seen[1]!.body).toEqual({ qty: "4", limit_price: "204.73", time_in_force: "day", client_order_id: `ord-0803-r-${ID}` });
    b.seen.length = 0;
    expect(refusal(await b.t.amend!(ID, "AAPL", { limitPrice: 205 }, market)).message).toBe("Alpaca: a market order has no limit price to change: it is held to its worst price, which stays");
    expect(refusal(await b.t.amend!(ID, "AAPL", { stopPrice: 200 }, market)).message).toBe("Alpaca: a market order has no stop price");
    expect(refusal(await b.t.amend!(ID, "AAPL", { stopPrice: 149 }, limitBuy)).message).toBe("Alpaca: a limit order has no stop price");
    expect(b.seen).toEqual([]);
  });

  it("not changed, and nothing patched: an order taken but not yet working, one being replaced or canceled, one that is done, one part-filled (Alpaca's replace does not carry its fills over cleanly)", async () => {
    let now: Record<string, unknown> = order(LIMIT_150);
    const { t, seen } = await alpaca({ [`GET ${LIVE}/v2/orders/${ID}`]: () => json(now) });
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ status: "accepted" }, "Alpaca does not change an order while it is accepted (taken, and held until the market opens): nothing was changed, and it can be once the order is working"],
      [{ status: "pending_new" }, "Alpaca does not change an order while it is pending new: nothing was changed, and it can be once the order is working"],
      [{ status: "pending_cancel" }, "Alpaca does not change an order while it is pending cancel: nothing was changed, and it can be once the order is working"],
      [{ status: "pending_replace" }, "Alpaca does not change an order while it is pending replace: nothing was changed, and it can be once the order is working"],
      [{ status: "filled", filled_qty: "2", filled_avg_price: "150.2" }, `Alpaca's order ${ID} is filled: there is nothing left to change`],
      [{ status: "canceled" }, `Alpaca's order ${ID} is canceled: there is nothing left to change`],
      [{ status: "partially_filled", filled_qty: "1", filled_avg_price: "150.2" }, `Alpaca's order ${ID} has filled 1 of 2, and Alpaca's replace does not carry a part-filled order over cleanly, so it is not changed here: cancel it, and place what is left as a new order`],
      [{ symbol: "MSFT" }, `Alpaca's order ${ID} is not the order the account placed (a buy of AAPL, sent as a limit): nothing was changed`],
    ];
    for (const [over, message] of cases) {
      now = order({ ...LIMIT_150, ...over });
      const no = refusal(await t.amend!(ID, "AAPL", { limitPrice: 151 }, limitBuy));
      expect([no.code, no.message]).toEqual(["E_VENUE_REJECTED", message]);
    }
    expect(seen.every((r) => r.method === "GET")).toBe(true);
  });

  it("a stock's size changes in whole shares only, and an order for a fraction keeps its size; a change that is no change sends nothing", async () => {
    let now: Record<string, unknown> = order(LIMIT_150);
    const { t, seen } = await alpaca({ [`GET ${LIVE}/v2/orders/${ID}`]: () => json(now) });
    expect(refusal(await t.amend!(ID, "AAPL", { qty: 2.5 }, limitBuy)).message).toBe("Alpaca: a stock order's size changes in whole shares only: cancel it and place the new size as a new order");
    now = order({ ...LIMIT_150, qty: "0.5", time_in_force: "day" });
    expect(refusal(await t.amend!(ID, "AAPL", { qty: 1 }, { ...limitBuy, qty: 0.5 })).message).toBe("Alpaca: an order for a fraction of a share keeps its size: cancel it and place the new size as a new order");
    // already as asked (a change whose answer was lost, asked for again): the order as it stands, and no PATCH
    now = order(LIMIT_150);
    const same = ok(await t.amend!(ID, "AAPL", { limitPrice: 150.25, qty: 2 }, limitBuy));
    expect([same.ref, same.status]).toEqual([ID, "open"]);
    expect(refusal(await t.amend!(ID, "AAPL", {}, limitBuy)).message).toBe("Alpaca: an order is changed by a new size, limit price or stop price: none was given");
    expect(refusal(await t.amend!(ID, "AAPL", { qty: -1 }, limitBuy)).message).toBe("Alpaca: a new size is more than zero");
    expect(refusal(await t.amend!(ID, "AAPL", { limitPrice: 150.1234567891 }, limitBuy)).message).toBe("Alpaca: a new limit price has at most nine decimal places");
    expect(seen.every((r) => r.method === "GET")).toBe(true);
    // a coin's new size is sent as it is: Alpaca's own refusal is the answer if it takes whole units only there too
    const coin = await alpaca({ [`GET ${LIVE}/v2/orders/${ID}`]: json(order({ symbol: "BTC/USD", asset_class: "crypto", type: "limit", order_type: "limit", limit_price: "80000", qty: "0.002", time_in_force: "gtc", status: "new" })), [`PATCH ${LIVE}/v2/orders/${ID}`]: json(order({ id: NEW, symbol: "BTC/USD", asset_class: "crypto", type: "limit", limit_price: "80000", qty: "0.003", status: "new" })) });
    ok(await coin.t.amend!(ID, "BTC/USD", { qty: 0.003 }, { symbol: "BTC/USD", side: "buy", type: "limit", qty: 0.002, limitPrice: 80000, clientId: "ord-0810" }));
    expect(coin.seen[1]!.body).toEqual({ qty: "0.003", limit_price: "80000", time_in_force: "gtc", client_order_id: `ord-0810-r-${ID}` });
  });

  it("a change made already, whose answer was lost, is found as it stands — even before Alpaca puts the new order to work — and is not sent again", async () => {
    const { t, seen } = await alpaca({ [`GET ${LIVE}/v2/orders/${ID}`]: json(order({ ...LIMIT_150, status: "replaced", replaced_by: NEW })), [`GET ${LIVE}/v2/orders/${NEW}`]: json(order({ ...LIMIT_150, id: NEW, limit_price: "151", status: "pending_new", replaces: ID })) });
    const s = ok(await t.amend!(ID, "AAPL", { limitPrice: 151 }, limitBuy));
    expect([s.ref, s.status]).toEqual([NEW, "pending"]);
    expect(seen.every((r) => r.method === "GET")).toBe(true);
  });

  it("an order already replaced is followed to the order that replaced it, and that one is changed", async () => {
    const { t, seen } = await alpaca({
      [`GET ${LIVE}/v2/orders/${ID}`]: json(order({ ...LIMIT_150, status: "replaced", replaced_by: NEW })),
      [`GET ${LIVE}/v2/orders/${NEW}`]: json(order({ ...LIMIT_150, id: NEW, limit_price: "150.5", replaces: ID })),
      [`PATCH ${LIVE}/v2/orders/${NEW}`]: json(order({ ...LIMIT_150, id: NEWER, limit_price: "151", replaces: NEW })),
    });
    const s = ok(await t.amend!(ID, "AAPL", { limitPrice: 151 }, limitBuy));
    expect(calls(seen)).toEqual([`GET ${LIVE}/v2/orders/${ID}`, `GET ${LIVE}/v2/orders/${NEW}`, `PATCH ${LIVE}/v2/orders/${NEW}`]);
    expect(seen[2]!.body).toEqual({ limit_price: "151", time_in_force: "gtc", client_order_id: `ord-0800-r-${NEW}` });
    expect(s.ref).toBe(NEWER);
  });

  it("Alpaca did not answer the change: the new order is asked for by its id, and the change is never sent twice from here", async () => {
    const cid = `ord-0800-r-${ID}`;
    const lookup = `GET ${LIVE}/v2/orders:by_client_order_id?client_order_id=${cid}`;
    const timedOut = json({ code: 50410000, message: "request timed out" }, 504);
    // the PATCH timed out at Alpaca, but the change was made
    const a = await alpaca({ [`GET ${LIVE}/v2/orders/${ID}`]: json(order(LIMIT_150)), [`PATCH ${LIVE}/v2/orders/${ID}`]: timedOut, [lookup]: json(order({ ...LIMIT_150, id: NEW, limit_price: "151", client_order_id: cid, replaces: ID })) });
    const s = ok(await a.t.amend!(ID, "AAPL", { limitPrice: 151 }, limitBuy));
    expect([s.ref, s.status]).toEqual([NEW, "open"]);
    // it was not
    const b = await alpaca({ [`GET ${LIVE}/v2/orders/${ID}`]: json(order(LIMIT_150)), [`PATCH ${LIVE}/v2/orders/${ID}`]: timedOut, [lookup]: json({ code: 40410000, message: "order not found" }, 404) });
    const none = refusal(await b.t.amend!(ID, "AAPL", { limitPrice: 151 }, limitBuy));
    expect([none.code, none.message, none.detail]).toEqual(["E_VENUE_UNREACHABLE", `Alpaca did not answer, and a moment later it held no order under the account's id ${cid}: nothing was changed`, { clientOrderId: cid, changed: false }]);
    // nothing answers at all
    const c = await alpaca({ [`GET ${LIVE}/v2/orders/${ID}`]: json(order(LIMIT_150)), [`PATCH ${LIVE}/v2/orders/${ID}`]: new Error("socket hang up"), [lookup]: new Error("ECONNRESET") });
    const unknown = refusal(await c.t.amend!(ID, "AAPL", { limitPrice: 151 }, limitBuy));
    expect([unknown.code, unknown.detail]).toEqual(["E_VENUE_UNREACHABLE", { clientOrderId: cid, changed: "unknown" }]);
    expect(unknown.message).toContain(`the change may have been taken all the same. Look at Alpaca's orders for ${cid} before changing it again`);
    expect(c.seen.filter((r) => r.method === "PATCH").length).toBe(1);
  });

  it("Alpaca's own no to a change comes back in its words", async () => {
    const { t } = await alpaca({ [`GET ${LIVE}/v2/orders/${ID}`]: json(order(LIMIT_150)), [`PATCH ${LIVE}/v2/orders/${ID}`]: json({ code: 42210000, message: "invalid limit_price 151.123. sub-penny increment does not fulfill minimum pricing criteria" }, 422) });
    const no = refusal(await t.amend!(ID, "AAPL", { limitPrice: 151.123 }, limitBuy));
    expect([no.code, no.message]).toEqual(["E_VENUE_ORDER_INVALID", "Alpaca: invalid limit_price 151.123. sub-penny increment does not fulfill minimum pricing criteria"]);
    const gone = await alpaca({ [`GET ${LIVE}/v2/orders/nope`]: json({ code: 40410000, message: "order not found for nope" }, 404) });
    expect(refusal(await gone.t.amend!("nope", "AAPL", { limitPrice: 151 }, limitBuy)).code).toBe("E_ACCOUNT_ORDER_UNKNOWN");
  });
});

describe("what is held, and closing it", () => {
  const POSITIONS = [
    { asset_id: AAPL.id, symbol: "AAPL", exchange: "NASDAQ", asset_class: "us_equity", asset_marginable: true, avg_entry_price: "174.78", change_today: "-0.0018326556325525", cost_basis: "349.56", current_price: "174.29", lastday_price: "174.61", market_value: "348.58", qty: "2", qty_available: "2", side: "long", unrealized_intraday_pl: "-0.98", unrealized_intraday_plpc: "-0.0028035244307129", unrealized_pl: "-0.98", unrealized_plpc: "-0.0028035244307129" },
    { asset_id: "00000000-0000-4000-8000-000000000010", symbol: "TSLA", exchange: "NASDAQ", asset_class: "us_equity", asset_marginable: true, avg_entry_price: "260", change_today: "0.01", cost_basis: "-1300", current_price: "250", lastday_price: "247.5", market_value: "-1250", qty: "-5", qty_available: "-5", side: "short", unrealized_intraday_pl: "-12.5", unrealized_intraday_plpc: "-0.01", unrealized_pl: "50", unrealized_plpc: "0.0385" },
    { asset_id: BTC.id, symbol: "BTCUSD", exchange: "CRYPTO", asset_class: "crypto", asset_marginable: false, avg_entry_price: "84000", change_today: "0.004", cost_basis: "42", current_price: "85598", lastday_price: "85250", market_value: "42.799", qty: "0.0005", qty_available: "0.0005", side: "long", unrealized_intraday_pl: "0.17", unrealized_intraday_plpc: "0.004", unrealized_pl: "0.799", unrealized_plpc: "0.019" },
    { asset_id: "00000000-0000-4000-8000-000000000011", symbol: "AAPL250620C00100000", exchange: "", asset_class: "us_option", asset_marginable: false, avg_entry_price: "10", change_today: "0", cost_basis: "1000", current_price: "11", lastday_price: "11", market_value: "1100", qty: "1", qty_available: "1", side: "long", unrealized_intraday_pl: "0", unrealized_intraday_plpc: "0", unrealized_pl: "100", unrealized_plpc: "0.1" },
  ];

  it("GET /v2/positions: a stock long, a stock short, a coin by the dollar pair it trades as; an option is not traded here, so not shown", async () => {
    const { t, seen } = await alpaca({ [`GET ${LIVE}/v2/positions`]: json(POSITIONS) });
    const ps = ok(await t.positions!());
    expect(calls(seen)).toEqual([`GET ${LIVE}/v2/positions`]);
    expect(seen[0]!.headers).toEqual(AUTH);
    expect(ps.map((p) => [p.symbol, p.name, p.kind, p.side, p.qty, p.entryPrice, p.markPrice, p.usd, p.unrealizedUsd])).toEqual([
      ["AAPL", "AAPL", "stock", "long", 2, 174.78, 174.29, 348.58, -0.98],
      ["TSLA", "TSLA", "stock", "short", 5, 260, 250, -1250, 50],
      ["BTC/USD", "BTC/USD", "crypto", "long", 0.0005, 84000, 85598, 42.799, 0.799],
    ]);
    expect(ps.every((p) => p.leverage === undefined && p.marginMode === undefined && p.liquidationPrice === undefined)).toBe(true);
    expect(ps[2]!.native).toMatchObject({ symbol: "BTCUSD", asset_class: "crypto", qty_available: "0.0005", cost_basis: "42" });
  });

  it("the balances: a coin by its base (BTCUSD is BTC, one row with BTC held elsewhere), a short as what it is — a negative amount worth what buying it back costs — never a positive holding", async () => {
    const { source } = await alpaca({ [`GET ${LIVE}/v2/positions`]: json(POSITIONS.slice(0, 3)) });
    const read = await source.read();
    expect(read.map((b) => [b.asset, b.amount, b.usd, b.where, b.class])).toEqual([
      ["USD", 2500.5, 2500.5, "cash", "cash"],
      ["AAPL", 2, 348.58, "stocks", "equity"],
      ["TSLA", -5, -1250, "stocks · short", "equity"],
      ["BTC", 0.0005, 42.799, "crypto", "crypto"],
    ]);
    // as the account holds them: the short counts against the venue's total (Alpaca's equity is net of it), and is no row of what is held
    const adapter = await liveAccount("alpaca", source, { connector: "live:alpaca", first: read });
    const holdings = await adapter.read();
    expect(holdings.reduce((sum, h) => sum + h.usd, 0)).toBeCloseTo(2500.5 + 348.58 - 1250 + 42.8, 2);
    const rows = byAsset([{ id: "kraken", name: "Kraken", holdings: [{ asset: "XBT", amount: 1, usd: 85_000, class: "crypto", inTransit: false }] }, { id: "alpaca", name: "Alpaca", holdings: holdings.map((h) => ({ ...h, inTransit: false })) }]).rows;
    expect(rows.map((r) => [r.key, r.amount])).toEqual([["crypto:BTC", 1.0005], ["cash:USD", 2500.5], ["equity:AAPL", 2]]);
  });

  it("a position is named in words once the markets were read; a local-currency account's dollars come from its usd block", async () => {
    const lct = { ...POSITIONS[0]!, market_value: "5200", unrealized_pl: "866.71", usd: { avg_entry_price: "71.43", cost_basis: "333.33", current_price: "80.0", market_value: "400.00", unrealized_pl: "66.67" } };
    const { t } = await alpaca({
      [`GET ${LIVE}/v2/assets?status=active&asset_class=us_equity`]: json([AAPL]),
      [`GET ${LIVE}/v2/assets?status=active&asset_class=crypto`]: json([BTC]),
      [`GET ${LIVE}/v2/positions`]: json([lct, POSITIONS[2]]),
    });
    ok(await t.markets(""));
    const ps = ok(await t.positions!());
    expect(ps.map((p) => [p.symbol, p.name, p.entryPrice, p.markPrice, p.usd, p.unrealizedUsd])).toEqual([
      ["AAPL", "Apple Inc. Common Stock", 71.43, 80, 400, 66.67],
      ["BTC/USD", "Bitcoin / US Dollar", 84000, 85598, 42.799, 0.799],
    ]);
  });

  it("positions that do not come back as a list are not read as an empty account", async () => {
    const { t } = await alpaca({ [`GET ${LIVE}/v2/positions`]: json({ message: "maintenance" }) });
    expect(refusal(await t.positions!()).code).toBe("E_VENUE_REJECTED");
    const down = await alpaca({ [`GET ${LIVE}/v2/positions`]: json({ code: 50010000, message: "internal server error" }, 500) });
    expect(refusal(await down.t.positions!()).code).toBe("E_VENUE_UNREACHABLE");
  });

  it("a stock position closed while the market is open: DELETE /v2/positions/{symbol}?qty=, and the market order Alpaca places for it", async () => {
    const { t, seen } = await alpaca({ [`GET ${LIVE}/v2/clock`]: json(OPEN), [`DELETE ${LIVE}/v2/positions/AAPL?qty=2`]: json(order({ side: "sell", qty: "2", status: "accepted", client_order_id: "c0a8f2de-0000-4000-8000-000000000000" })) });
    const s = ok(await t.close!(" aapl", 2, "ord-0900"));
    expect(seen.map((r) => [r.method, r.url, r.headers, r.body])).toEqual([
      ["GET", `${LIVE}/v2/clock`, AUTH, undefined],
      ["DELETE", `${LIVE}/v2/positions/AAPL?qty=2`, AUTH, undefined],
    ]);
    expect([s.ref, s.status, s.filledQty]).toEqual([ID, "pending", 0]);
    expect(s.native).toMatchObject({ type: "market", side: "sell", qty: "2", time_in_force: "day" });
  });

  it("a coin is closed by the name Alpaca holds it under, BTCUSD, at any hour: no clock is asked; a fraction goes in nine places at most", async () => {
    const { t, seen } = await alpaca({ [`DELETE ${LIVE}/v2/positions/BTCUSD?qty=0.0005`]: json(order({ symbol: "BTC/USD", asset_class: "crypto", side: "sell", qty: "0.0005", time_in_force: "gtc", status: "pending_new" })) });
    expect(ok(await t.close!("BTC/USD", 0.0005, "ord-0901")).status).toBe("pending");
    expect(calls(seen)).toEqual([`DELETE ${LIVE}/v2/positions/BTCUSD?qty=0.0005`]);
    seen.length = 0;
    expect(refusal(await t.close!("BTC/USD", 0.00050000000001, "ord-0902")).message).toBe("Alpaca: a size has at most nine decimal places");
    expect(refusal(await t.close!("AAPL", 0, "ord-0903")).message).toBe("Alpaca: a size to close is more than zero");
    expect(seen).toEqual([]);
  });

  it("a stock position is not closed while the market is shut, or while its clock does not answer: Alpaca would hold its market order for the open", async () => {
    const shut = await alpaca({ [`GET ${LIVE}/v2/clock`]: json(SHUT) });
    const no = refusal(await shut.t.close!("AAPL", 2, "ord-0904"));
    expect([no.code, no.message]).toEqual(["E_VENUE_MARKET_CLOSED", "the US stock market is closed: Alpaca closes a position with a market order, which would wait for the open (2026-10-06 09:30 New York time) and fill at the opening price. Close it once the market is open, or sell it with a limit order now"]);
    expect(calls(shut.seen)).toEqual([`GET ${LIVE}/v2/clock`]);
    const quiet = await alpaca({ [`GET ${LIVE}/v2/clock`]: json({ code: 50010000, message: "internal server error" }, 500) });
    const unsure = refusal(await quiet.t.close!("AAPL", 2, "ord-0905"));
    expect([unsure.code, unsure.message]).toEqual(["E_VENUE_MARKET_CLOSED", "Alpaca's market clock did not answer, so AAPL is not closed now: Alpaca closes a position with a market order, and outside market hours that order would wait for the open and fill at the opening price"]);
    expect(quiet.seen.filter((r) => r.method === "DELETE")).toEqual([]);
  });

  it("Alpaca's no: no such position, not enough of it free to close; an answer lost on the way is not sent again", async () => {
    const closing = (answer: HttpReply | Error) => alpaca({ [`GET ${LIVE}/v2/clock`]: json(OPEN), [`DELETE ${LIVE}/v2/positions/AAPL?qty=2`]: answer });
    const none = await closing(json({ code: 40410000, message: "position not found: AAPL" }, 404));
    const gone = refusal(await none.t.close!("AAPL", 2, "ord-0906"));
    expect([gone.code, gone.message]).toEqual(["E_VENUE_REJECTED", "Alpaca holds no AAPL position for this key"]);
    const held = await closing(json({ available: "0", code: 40310000, existing_qty: "2", held_for_orders: "2", message: "insufficient qty available for order (requested: 2, available: 0)", symbol: "AAPL" }, 403));
    expect(refusal(await held.t.close!("AAPL", 2, "ord-0907")).code).toBe("E_VENUE_INSUFFICIENT");
    const lost = await closing(json({ code: 50410000, message: "request timed out" }, 504));
    const unknown = refusal(await lost.t.close!("AAPL", 2, "ord-0908"));
    expect([unknown.code, unknown.message, unknown.detail]).toEqual(["E_VENUE_UNREACHABLE", "Alpaca did not answer: the closing order may have been taken all the same. Look at Alpaca's orders for AAPL before closing it again", { symbol: "AAPL", placed: "unknown" }]);
    const dropped = await closing(new Error("socket hang up"));
    expect(refusal(await dropped.t.close!("AAPL", 2, "ord-0909")).detail).toEqual({ symbol: "AAPL", placed: "unknown" });
    expect([lost, dropped].map((x) => x.seen.filter((r) => r.method === "DELETE").length)).toEqual([1, 1]);
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

// ---- reading the market: snapshots and bars (Market Data API) ----------------------------------------------------------------------

/** a bar as the Market Data API gives it: start, open, high, low, close, volume, trade count, VWAP */
const bar = (t: string, o: number, h: number, l: number, c: number, v: number) => ({ t, o, h, l, c, v, n: 120, vw: (o + c) / 2 });
/** a stock's snapshot (GET /v2/stocks/snapshots: keyed by symbol at the top) */
const stockSnap = (p: number, day: ReturnType<typeof bar> | undefined, prev: ReturnType<typeof bar> | undefined) => ({ latestTrade: { t: "2026-10-05T19:53:19.123Z", x: "V", p, s: 100, c: ["@"], i: 52983525029461, z: "C" }, latestQuote: { t: "2026-10-05T19:53:19.5Z", ax: "V", ap: p + 0.02, as: 1, bx: "V", bp: p - 0.02, bs: 2, c: ["R"], z: "C" }, minuteBar: bar("2026-10-05T19:52:00Z", p, p, p, p, 300), ...(day ? { dailyBar: day } : {}), ...(prev ? { prevDailyBar: prev } : {}) });
/** a pair's snapshot (GET /v1beta3/crypto/us/snapshots: under `snapshots`) */
const coinSnap = (p: number) => ({ latestTrade: { t: "2026-10-05T19:53:19.1Z", p, s: 0.01, i: 1, tks: "B" }, latestQuote: { t: "2026-10-05T19:53:19.2Z", bp: p - 5, bs: 1, ap: p + 5, as: 1 }, minuteBar: bar("2026-10-05T19:52:00Z", p, p, p, p, 0.5), dailyBar: bar("2026-10-05T00:00:00Z", p - 500, p + 100, p - 600, p, 12), prevDailyBar: bar("2026-10-04T00:00:00Z", p - 900, p - 300, p - 1000, p - 500, 40) });
const STOCK_SNAPS = `${DATA}/v2/stocks/snapshots?symbols=SPY,QQQ,AAPL,MSFT,NVDA,AMZN,GOOGL,META,TSLA`;
const COIN_SNAPS = `${DATA}/v1beta3/crypto/us/snapshots?symbols=BTC/USD,ETH/USD,SOL/USD`;

describe("reading the market: many markets at once (snapshots)", () => {
  it("no symbols: the well-known stocks and pairs, one snapshots request each; a stock's latest session against the one before, a coin's price only", async () => {
    const { t, seen } = await alpaca({
      [`GET ${STOCK_SNAPS}`]: json({ AAPL: stockSnap(201.62, bar("2026-10-05T04:00:00Z", 200.1, 202.3, 199.8, 201.5, 41234567), bar("2026-10-02T04:00:00Z", 198, 200.5, 197.2, 200, 52345678)), SPY: stockSnap(571.3, bar("2026-10-05T04:00:00Z", 569, 572, 568.5, 571.25, 30000000), bar("2026-10-02T04:00:00Z", 572, 574, 570, 573.75, 35000000)) }),
      [`GET ${COIN_SNAPS}`]: json({ snapshots: { "BTC/USD": coinSnap(85573.7) } }),
    });
    const s = ok(await t.stats!());
    expect(calls(seen)).toEqual([`GET ${STOCK_SNAPS}`, `GET ${COIN_SNAPS}`]);
    // the key's two headers go to the market-data host too, so its own feed is used, as for a quote
    expect(seen.every((r) => r.headers["APCA-API-KEY-ID"] === KEY_ID && r.headers["APCA-API-SECRET-KEY"] === SECRET)).toBe(true);
    expect(Object.fromEntries(s)).toEqual({
      // no volume for a stock: on a key without a subscription the feed is IEX's alone, and the answer does not say which
      AAPL: { price: 201.62, change24h: 1.5, changePct24h: 0.75, high24h: 202.3, low24h: 199.8 },
      SPY: { price: 571.3, change24h: -2.5, changePct24h: -0.4357298475, high24h: 572, low24h: 568.5 },
      // a coin's daily bar is the calendar day so far, not the last 24 hours: its price only
      "BTC/USD": { price: 85573.7 },
    } satisfies Record<string, MarketStats>);
  });

  it("symbols: stocks by ticker and dollar pairs, upper-cased and once each; a pair priced in a coin, or no symbol at all, is not asked for", async () => {
    const { t, seen } = await alpaca({
      [`GET ${DATA}/v2/stocks/snapshots?symbols=AAPL,BRK.B`]: json({ AAPL: stockSnap(201.62, bar("2026-10-05T04:00:00Z", 200.1, 202.3, 199.8, 201.5, 1), undefined) }),
      [`GET ${DATA}/v1beta3/crypto/us/snapshots?symbols=BTC/USD,ETH/USDT`]: json({ snapshots: { "ETH/USDT": coinSnap(2400) } }),
    });
    const s = ok(await t.stats!(["aapl", "ETH/BTC", "btc/usd", "not a symbol", "AAPL", "brk.b", "eth/usdt"]));
    expect(calls(seen)).toEqual([`GET ${DATA}/v2/stocks/snapshots?symbols=AAPL,BRK.B`, `GET ${DATA}/v1beta3/crypto/us/snapshots?symbols=BTC/USD,ETH/USDT`]);
    // no session before it: a price, and no change; the high and low of its session
    expect(Object.fromEntries(s)).toEqual({ AAPL: { price: 201.62, high24h: 202.3, low24h: 199.8 }, "ETH/USDT": { price: 2400 } });
    const stocksOnly = await alpaca({ [`GET ${DATA}/v2/stocks/snapshots?symbols=TSLA`]: json({}) });
    expect(ok(await stocksOnly.t.stats!(["TSLA"])).size).toBe(0);
    expect(calls(stocksOnly.seen)).toEqual([`GET ${DATA}/v2/stocks/snapshots?symbols=TSLA`]);
  });

  it("a change is said only when both sessions are there and the latest is the later one; a stock with no trade is priced at its session's close", async () => {
    const { t } = await alpaca({
      [`GET ${DATA}/v2/stocks/snapshots?symbols=AAA,BBB`]: json({
        AAA: { ...stockSnap(10, bar("2026-10-02T04:00:00Z", 10, 10, 10, 10, 1), bar("2026-10-05T04:00:00Z", 9, 9, 9, 9, 1)) },
        BBB: { dailyBar: bar("2026-10-05T04:00:00Z", 20, 21, 19.5, 20.5, 1), prevDailyBar: bar("2026-10-02T04:00:00Z", 19, 20, 18, 20, 1) },
      }),
    });
    const s = ok(await t.stats!(["AAA", "BBB"]));
    // AAA's latest bar is Friday's (the one after it is not the later one): no session of today, so its price only
    expect(s.get("AAA")).toEqual({ price: 10 });
    expect(s.get("BBB")).toEqual({ price: 20.5, change24h: 0.5, changePct24h: 2.5, high24h: 21, low24h: 19.5 });
  });

  it("a session that is not today's in New York is not the last 24 hours: on Sunday, Friday's 8% is no change at all; Monday, once its session has a bar, it is", async () => {
    const FRIDAY = { FRI: stockSnap(108, bar("2026-10-02T04:00:00Z", 100, 109, 99, 108, 1), bar("2026-10-01T04:00:00Z", 99, 101, 98, 100, 1)) };
    const sunday = await alpaca({ [`GET ${DATA}/v2/stocks/snapshots?symbols=FRI`]: json(FRIDAY) }, { clock: Date.parse("2026-10-04T18:00:00.000Z") });
    expect(ok(await sunday.t.stats!(["FRI"])).get("FRI")).toEqual({ price: 108 });
    // a minute before midnight in New York on Friday (04:00Z on Saturday) it is still Friday's session
    const late = await alpaca({ [`GET ${DATA}/v2/stocks/snapshots?symbols=FRI`]: json(FRIDAY) }, { clock: Date.parse("2026-10-03T03:59:00.000Z") });
    expect(ok(await late.t.stats!(["FRI"])).get("FRI")).toEqual({ price: 108, change24h: 8, changePct24h: 8, high24h: 109, low24h: 99 });
  });

  it("one request that does not answer leaves the other standing; when none answers, Alpaca's own no is the answer; more than a hundred are refused before anything is asked", async () => {
    const sip = json({ code: 40310000, message: "subscription does not permit querying recent SIP data" }, 403);
    const half = await alpaca({ [`GET ${STOCK_SNAPS}`]: sip, [`GET ${COIN_SNAPS}`]: json({ snapshots: { "ETH/USD": coinSnap(2400) } }) });
    expect(Object.fromEntries(ok(await half.t.stats!()))).toEqual({ "ETH/USD": { price: 2400 } });
    const none = await alpaca({ [`GET ${STOCK_SNAPS}`]: sip, [`GET ${COIN_SNAPS}`]: json({ message: "internal server error" }, 500) });
    const r = refusal(await none.t.stats!());
    expect([r.code, r.message]).toEqual(["E_VENUE_PERMISSION", "Alpaca: subscription does not permit querying recent SIP data"]);
    const many = await alpaca();
    const big = refusal(await many.t.stats!(Array.from({ length: 101 }, (_, i) => `S${i}`)));
    expect([big.code, big.message, many.seen.length]).toEqual(["E_VENUE_REJECTED", "Alpaca: at most 100 markets are read at once, not 101", 0]);
  });
});

describe("reading the market: price history (bars)", () => {
  const SINCE = Date.parse("2026-10-05T16:53:20.000Z");
  const START = encodeURIComponent("2026-10-05T16:53:20Z");

  it("a stock's hourly bars: GET /v2/stocks/bars, the latest 300 since the start (sort desc, no end and no feed: Alpaca's own for the key), oldest first, volume in shares", async () => {
    const url = `${DATA}/v2/stocks/bars?symbols=AAPL&timeframe=1Hour&start=${START}&limit=300&sort=desc`;
    const { t, seen } = await alpaca({ [`GET ${url}`]: json({ bars: { AAPL: [bar("2026-10-05T19:00:00Z", 201.2, 201.8, 201.1, 201.62, 1500000), bar("2026-10-05T18:00:00Z", 200.9, 201.4, 200.7, 201.2, 1800000), bar("2026-10-05T17:00:00Z", 200.5, 201, 200.4, 200.9, 2100000)] }, next_page_token: null, currency: "USD" }) });
    const bars = ok(await t.candles!("aapl", "1h", SINCE));
    expect(calls(seen)).toEqual([`GET ${url}`]);
    expect(seen[0]!.headers).toMatchObject(AUTH);
    expect(bars).toEqual([
      { t: Date.parse("2026-10-05T17:00:00Z"), o: 200.5, h: 201, l: 200.4, c: 200.9, v: 2100000 },
      { t: Date.parse("2026-10-05T18:00:00Z"), o: 200.9, h: 201.4, l: 200.7, c: 201.2, v: 1800000 },
      { t: Date.parse("2026-10-05T19:00:00Z"), o: 201.2, h: 201.8, l: 201.1, c: 201.62, v: 1500000 },
    ] satisfies Candle[]);
  });

  it("a pair's five-minute and daily bars: GET /v1beta3/crypto/us/bars, the pair keeping its slash, volume in coins", async () => {
    const five = `${DATA}/v1beta3/crypto/us/bars?symbols=BTC/USD&timeframe=5Min&start=${START}&limit=300&sort=desc`;
    const day = `${DATA}/v1beta3/crypto/us/bars?symbols=BTC/USD&timeframe=1Day&start=${START}&limit=300&sort=desc`;
    const { t, seen } = await alpaca({ [`GET ${five}`]: json({ bars: { "BTC/USD": [bar("2026-10-05T19:50:00Z", 85560, 85580, 85550, 85573.7, 0.42)] }, next_page_token: null }), [`GET ${day}`]: json({ bars: {}, next_page_token: null }) });
    expect(ok(await t.candles!("BTC/USD", "5m", SINCE))).toEqual([{ t: Date.parse("2026-10-05T19:50:00Z"), o: 85560, h: 85580, l: 85550, c: 85573.7, v: 0.42 }]);
    expect(ok(await t.candles!("BTC/USD", "1d", SINCE))).toEqual([]);
    expect(calls(seen)).toEqual([`GET ${five}`, `GET ${day}`]);
  });

  it("refused before anything is asked: a bar size not offered, a start that is not a time, a pair priced in a coin, a symbol that is none; Alpaca's own no in its words", async () => {
    const { t, seen } = await alpaca({ [`GET ${DATA}/v2/stocks/bars?symbols=AAPL&timeframe=1Day&start=${START}&limit=300&sort=desc`]: json({ code: 40310000, message: "subscription does not permit querying recent SIP data" }, 403) });
    const size = refusal(await t.candles!("AAPL", "1w" as CandleInterval, SINCE));
    const start = refusal(await t.candles!("AAPL", "1h", -1));
    const coin = refusal(await t.candles!("ETH/BTC", "1h", SINCE));
    const none = refusal(await t.candles!("not a symbol", "1h", SINCE));
    expect([size.message, start.message, coin.code, none.message, seen.length]).toEqual(["Alpaca: price history comes in bars of 5m, 1h, 1d, not 1w", "Alpaca: a price history starts at a time, in milliseconds", "E_ACCOUNT_UNPRICED", 'Alpaca lists no market "not a symbol": a stock is its ticker (AAPL), a coin a pair (BTC/USD)', 0]);
    const theirs = refusal(await t.candles!("AAPL", "1d", SINCE));
    expect([theirs.code, theirs.message]).toEqual(["E_VENUE_PERMISSION", "Alpaca: subscription does not permit querying recent SIP data"]);
  });
});
