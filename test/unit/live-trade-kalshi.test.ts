import { constants, createPrivateKey, generateKeyPairSync, verify } from "node:crypto";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { isRefusal, type Refusal } from "../../src/core/errors.ts";
import { kalshiDayEnd, kalshiSign, kalshiSource } from "../../src/portfolio/live/kalshi.ts";
import type { LiveTrader, Market, OrderRequest, OrderState, Position } from "../../src/portfolio/live/trade.ts";
import type { Http, HttpReply, LiveSource } from "../../src/portfolio/live/types.ts";

/** TRADING at Kalshi, against a stand-in for Kalshi's trade API v2 that checks every request's signature with a key pair made here and
 * thrown away, records every request, and answers what each test says — in the shapes Kalshi's docs and its live public API show today
 * (V2 order endpoints, fixed-point strings, dollar prices, price_ranges). Nothing here leaves the process, and no key is anyone's. */
type Rec = Record<string, unknown>;
const START = Date.parse("2026-10-05T14:00:00.000Z");
const BASE = "https://external-api.kalshi.com/trade-api/v2";
const KEY_ID = "made-up-key-id";
const ORDER = "3b23c1c7-f4ef-4f0d-8b9a-9e53c61f1a0d";

const json = (body: unknown, status = 200): HttpReply => ({ status, body, text: JSON.stringify(body) });
const notFound = () => json({ error: { code: "not_found", message: "not found" } }, 404);

/** a cent-grid market, as GET /markets/{ticker} shows one (no cent fields, no tick_size) */
const FED: Rec = {
  ticker: "KXFED-27APR-T4.00",
  event_ticker: "KXFED-27APR",
  market_type: "binary",
  title: "Will the upper bound of the federal funds rate be above 4.00% following the Fed's Apr 28, 2027 meeting?",
  yes_sub_title: "Above 4.00%",
  no_sub_title: "Above 4.00%",
  status: "active",
  yes_bid_dollars: "0.4200",
  yes_ask_dollars: "0.4500",
  no_bid_dollars: "0.5500",
  no_ask_dollars: "0.5800",
  yes_bid_size_fp: "120.00",
  yes_ask_size_fp: "80.00",
  last_price_dollars: "0.4300",
  price_level_structure: "linear_cent",
  price_ranges: [{ end: "1.0000", start: "0.0000", step: "0.0100" }],
  notional_value_dollars: "1.0000",
  exchange_index: 0,
  open_time: "2026-05-01T14:00:00Z",
  close_time: "2027-04-28T17:55:00Z",
  volume_24h_fp: "5120.00",
  volume_fp: "91000.00",
  result: "",
};
/** a tapered grid (OBSERVED on KXGREENLAND-29): a tenth of a cent below $0.10 and above $0.90, a cent between; on shard 2 */
const GREEN: Rec = { ...FED, ticker: "KXGREENLAND-29", event_ticker: "KXGREENLAND-29", title: "Will the US acquire Greenland before 2029?", yes_sub_title: "Before 2029", yes_bid_dollars: "0.0450", yes_ask_dollars: "0.0480", no_bid_dollars: "0.9520", no_ask_dollars: "0.9550", last_price_dollars: "0.0470", price_level_structure: "tapered_deci_cent", price_ranges: [{ end: "0.1000", start: "0.0000", step: "0.0010" }, { end: "0.9000", start: "0.1000", step: "0.0100" }, { end: "1.0000", start: "0.9000", step: "0.0010" }], exchange_index: 2, volume_24h_fp: "300.00" };
/** a book whose best prices sit between cents: a market order's price goes to the grid in the safe direction */
const ODD: Rec = { ...FED, ticker: "KXODD-26OCT", yes_bid_dollars: "0.4450", yes_ask_dollars: "0.4550", no_bid_dollars: "0.5450", no_ask_dollars: "0.5550", volume_24h_fp: "10.00" };
/** nobody selling YES: Kalshi shows the empty ask as 1 and the empty NO bid as 0 (OBSERVED) */
const EMPTY: Rec = { ...FED, ticker: "KXEMPTY-26OCT", yes_ask_dollars: "1.0000", no_bid_dollars: "0.0000", yes_bid_dollars: "0.0000", no_ask_dollars: "1.0000", last_price_dollars: "0.0000" };

interface Sent {
  method: string;
  url: string;
  /** without the /trade-api/v2 prefix */
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
  raw: string | undefined;
}

/** A stand-in Kalshi. `routes` answers first; then the defaults: a $100 balance, no positions, the key's scopes, the exchange open, the
 * markets above. A request whose signature does not verify against the key made here is a 401, as at Kalshi. */
function fakeKalshi(opts: { scopes?: string[]; keys?: unknown; routes?: (s: Sent) => HttpReply | undefined; throwOn?: (s: Sent) => boolean } = {}) {
  const pair = generateKeyPairSync("ed25519");
  const k = {
    sent: [] as Sent[],
    now: START,
    pem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    privateKey: pair.privateKey,
    http: undefined as unknown as Http,
    /** the requests after the first `n` */
    since(n: number): string[] {
      return k.sent.slice(n).map((s) => `${s.method} ${s.path}`);
    },
  };
  const markets: Record<string, Rec> = { [String(FED.ticker)]: FED, [String(GREEN.ticker)]: GREEN, [String(ODD.ticker)]: ODD, [String(EMPTY.ticker)]: EMPTY };
  k.http = async (url, init = {}) => {
    const u = new URL(url);
    const h = init.headers ?? {};
    const method = init.method ?? "GET";
    const s: Sent = { method, url, path: u.pathname.replace("/trade-api/v2", ""), query: Object.fromEntries(u.searchParams), headers: h, body: init.body === undefined ? undefined : JSON.parse(init.body), raw: init.body };
    k.sent.push(s);
    const signed = verify(null, Buffer.from(`${h["KALSHI-ACCESS-TIMESTAMP"]}${method}${u.pathname}`), pair.publicKey, Buffer.from(h["KALSHI-ACCESS-SIGNATURE"] ?? "", "base64"));
    if (!signed || h["KALSHI-ACCESS-KEY"] !== KEY_ID) return json({ error: { code: "unauthorized", message: "unauthorized" } }, 401);
    if (opts.throwOn?.(s)) throw new Error("socket hang up");
    const custom = opts.routes?.(s);
    if (custom) return custom;
    if (s.path === "/portfolio/balance") return json({ balance: 10000, balance_dollars: "100.00" });
    if (s.path === "/portfolio/positions") return json({ market_positions: [], cursor: "" });
    if (s.path === "/portfolio/orders") return json({ orders: [], cursor: "" });
    if (s.path === "/api_keys") return json(opts.keys ?? { api_keys: [{ api_key_id: "another-key", name: "bot", scopes: ["read", "write"] }, { api_key_id: KEY_ID, name: "account", scopes: opts.scopes ?? ["read", "write::trade"] }], api_key_region_expiration_ts: START / 1000 + 30 * 86_400 });
    if (s.path === "/exchange/status") return json({ exchange_active: true, trading_active: true, exchange_index_statuses: [0, 1, 2, 3].map((i) => ({ exchange_index: i, exchange_active: true, trading_active: true })) });
    const m = /^\/markets\/([^/]+)$/.exec(s.path);
    if (m) return markets[decodeURIComponent(m[1]!)] ? json({ market: markets[decodeURIComponent(m[1]!)] }) : notFound();
    return notFound();
  };
  return k;
}
type Fake = ReturnType<typeof fakeKalshi>;

async function connect(k: Fake): Promise<{ source: LiveSource; t: LiveTrader }> {
  const opened = await kalshiSource({ venue: "kalshi", label: "Kalshi", reference: "credentials/kalshi/api-key.json", key: { keyId: KEY_ID, privateKey: k.pem }, home: tmpdir(), http: k.http, clock: () => k.now });
  if (isRefusal(opened)) throw new Error(opened.message);
  return { source: opened.source, t: opened.source.trader! };
}
const refusal = (r: unknown): Refusal => {
  if (!isRefusal(r)) throw new Error(`expected a refusal, got ${JSON.stringify(r)}`);
  return r;
};
const state = (r: OrderState | Refusal): OrderState => {
  if (isRefusal(r)) throw new Error(`${r.code}: ${r.message}`);
  return r;
};
const market = (r: Market | Refusal): Market => {
  if (isRefusal(r)) throw new Error(`${r.code}: ${r.message}`);
  return r;
};
const posts = (k: Fake) => k.sent.filter((s) => s.method === "POST");
const created = (fill: string, remaining: string, extra: Rec = {}) => json({ order_id: ORDER, client_order_id: "ord-0001", fill_count: fill, remaining_count: remaining, ts_ms: START, ...extra }, 201);
const order = (o: Rec): Rec => ({ order_id: ORDER, user_id: "u-made-up", client_order_id: "ord-0001", ticker: FED.ticker, outcome_side: "yes", book_side: "bid", type: "limit", status: "resting", yes_price_dollars: "0.4000", no_price_dollars: "0.6000", initial_count_fp: "10.00", fill_count_fp: "0.00", remaining_count_fp: "10.00", taker_fill_cost_dollars: "0.000000", maker_fill_cost_dollars: "0.000000", taker_fees_dollars: "0.000000", maker_fees_dollars: "0.000000", expiration_time: null, created_time: "2026-10-05T14:00:00Z", last_update_time: "2026-10-05T14:00:00Z", self_trade_prevention_type: "taker_at_cross", exchange_index: 0, ...o });

describe("Kalshi's request signature", () => {
  it("is timestamp + METHOD + path with its prefix and without its query, the body never signed: the spec's vectors for POST, DELETE and GET", () => {
    // the spec's throwaway Ed25519 key, from a seed of thirty-two 0x07 bytes: never registered anywhere. Ed25519 is deterministic.
    // a fixed Ed25519 test key, built from its seed (thirty-two 0x07 bytes) so no key text sits in the repo
    const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, 7)]), format: "der", type: "pkcs8" });
    const ts = 1759680000000;
    expect(kalshiSign(key, ts, "POST", "/trade-api/v2/portfolio/events/orders")).toBe("GTx6KiojxY855fLp+o2l51Db1pBUc0fDe3PJxUaceVHOQEk1oA+lVUGMWmPFDQinSOMDwGcCVtxFikKo93N3BQ==");
    expect(kalshiSign(key, ts, "DELETE", "/trade-api/v2/portfolio/events/orders/3b23c1c7-f4ef-4f0d-8b9a-9e53c61f1a0d?market_ticker=KXITFMATCH-26OCT06COLBAL-COL")).toBe("GlNElDrj/Vhi54Q7huNN6A0ZFRZQyWP9LroBTPRUANmNSIWtIEFRcgGKuUr3lk6hMDK/GvCtPzkSFMND8bK9Bw==");
    expect(kalshiSign(key, ts, "get", "/trade-api/v2/portfolio/orders/3b23c1c7-f4ef-4f0d-8b9a-9e53c61f1a0d")).toBe("D5rB8yrwRjOudmRaMNU62R0N9QgsrtFgqsLuqTeSCyED15JFkvErRiV3HbiTMbhq4aqQp2bkNqmmza1C6komDA==");
  });

  it("with an RSA key, RSA-PSS (SHA-256, salt as long as the digest) that verifies for a POST and a DELETE", () => {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    for (const [method, path, signedPath] of [["POST", "/trade-api/v2/portfolio/events/orders", "/trade-api/v2/portfolio/events/orders"], ["DELETE", `/trade-api/v2/portfolio/events/orders/${ORDER}?market_ticker=KXFED-27APR-T4.00`, `/trade-api/v2/portfolio/events/orders/${ORDER}`]] as const) {
      const sig = Buffer.from(kalshiSign(pair.privateKey, START, method, path), "base64");
      expect(verify("sha256", Buffer.from(`${START}${method}${signedPath}`), { key: pair.publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }, sig)).toBe(true);
    }
  });
});

describe("the Kalshi connection carries a trader", () => {
  it("connecting asks only what it asked before — the balance and the positions — and the trader says what is traded; whether the key may trade is learned when the trader is first used", async () => {
    const k = fakeKalshi();
    const { source, t } = await connect(k);
    expect(k.since(0)).toEqual(["GET /portfolio/balance", "GET /portfolio/positions"]);
    expect([t.what, t.can, source.readOnlyBecause]).toEqual(["event contracts: YES or NO on Kalshi's markets", "unknown", "Kalshi's API moves no money: deposits and withdrawals are made at Kalshi"]);
    market(await t.market("KXFED-27APR-T4.00:YES"));
    expect(k.since(2).sort()).toEqual(["GET /api_keys", "GET /exchange/status", "GET /markets/KXFED-27APR-T4.00"]);
    expect(t.can).toBe(true);
  });

  it("can: write or write::trade trades; read alone does not, and its order is refused here, never sent; a key Kalshi does not list, or no answer, is unknown", async () => {
    for (const [scopes, can] of [[["read", "write"], true], [["read", "write::trade"], true], [["read"], false], [["read", "write::transfer"], false]] as const) {
      const k = fakeKalshi({ scopes: [...scopes] });
      const { t } = await connect(k);
      await t.market("KXFED-27APR-T4.00:YES");
      expect([scopes.join(","), t.can]).toEqual([scopes.join(","), can]);
      if (can === false) {
        const no = refusal(await t.place({ symbol: "KXFED-27APR-T4.00:YES", side: "buy", type: "limit", qty: 1, limitPrice: 0.4, clientId: "ord-0001" }));
        expect([no.code, no.message, no.native]).toEqual(["E_VENUE_PERMISSION", `Kalshi: this key may not trade — Kalshi lists its scopes as ${scopes.join(", ")}. A Kalshi key keeps the scopes it was made with: make one with write (or write::trade) at Kalshi`, { scopes: [...scopes] }]);
        expect(posts(k)).toEqual([]);
      }
    }
    const unlisted = fakeKalshi({ keys: { api_keys: [{ api_key_id: "another-key", scopes: ["read", "write"] }] } });
    const a = await connect(unlisted);
    await a.t.market("KXFED-27APR-T4.00:YES");
    expect(a.t.can).toBe("unknown");
    const refused = fakeKalshi({ routes: (s) => (s.path === "/api_keys" ? json({ error: { code: "forbidden", message: "Forbidden" } }, 403) : undefined) });
    const b = await connect(refused);
    await b.t.market("KXFED-27APR-T4.00:YES");
    expect(b.t.can).toBe("unknown");
  });
});

describe("market(): one Kalshi market, for one of its outcomes", () => {
  it("YES and NO: the dollar prices of each side of the one book, steps of 0.01 contracts and of the grid, open while `active`; market and limit orders, the four times in force, post-only and reduce-only — no stops, no leverage", async () => {
    const k = fakeKalshi();
    const { t } = await connect(k);
    const yes = market(await t.market("kxfed-27apr-t4.00:yes"));
    expect(yes).toEqual({ symbol: "KXFED-27APR-T4.00:YES", name: "Will the upper bound of the federal funds rate be above 4.00% following the Fed's Apr 28, 2027 meeting? (Above 4.00%) · Yes", kind: "event", base: "KXFED-27APR-T4.00:YES", quote: "USD", price: 0.43, bid: 0.42, ask: 0.45, minQty: 0.01, qtyStep: 0.01, priceStep: 0.01, open: true, note: "closes 2027-04-28 17:55 UTC", types: ["market", "limit"], tifs: ["gtc", "ioc", "fok", "day"], tifsByType: { market: ["ioc", "fok"], limit: ["gtc", "ioc", "fok", "day"] }, postOnly: true, reduceOnly: true });
    const no = market(await t.market("KXFED-27APR-T4.00:NO"));
    expect([no.symbol, no.name.endsWith("· No"), no.price, no.bid, no.ask, no.open]).toEqual(["KXFED-27APR-T4.00:NO", true, 0.57, 0.55, 0.58, true]);
    // the tapered grid: its finest step, a tenth of a cent — so the account's worst price for a 0.048 ask is 0.048, not 0.04; the trader checks the full grid
    expect(market(await t.market("KXGREENLAND-29:YES")).priceStep).toBe(0.001);
    // an empty side of the book is no price; with no trade yet, no price at all
    const empty = market(await t.market("KXEMPTY-26OCT:YES"));
    expect([empty.bid, empty.ask, empty.price]).toEqual([undefined, undefined, undefined]);
  });

  it("closed: a market that is not `active` says why; a paused exchange or shard closes its markets; an unknown ticker or a name that is not <ticker>:YES|NO is refused", async () => {
    const SETTLED = { ...FED, ticker: "KXFED-26SEP-T4.00", status: "finalized", result: "no" };
    const LATER = { ...FED, ticker: "KXFED-27JUN-T4.00", status: "initialized", open_time: "2026-11-01T14:00:00Z" };
    const PAUSED = { ...FED, ticker: "KXFED-27JUL-T4.00", status: "inactive" };
    let shard2 = true;
    let whole = true;
    const k = fakeKalshi({
      routes: (s) => {
        const m = /^\/markets\/(.+)$/.exec(s.path);
        const found = [SETTLED, LATER, PAUSED].find((x) => x.ticker === m?.[1]);
        if (found) return json({ market: found });
        // a paused exchange answers 503 with its status in the body (OBSERVED on demo)
        if (s.path === "/exchange/status") return whole ? json({ exchange_active: true, trading_active: true, exchange_index_statuses: [{ exchange_index: 0, exchange_active: true, trading_active: true }, { exchange_index: 2, exchange_active: true, trading_active: shard2 }] }) : json({ exchange_active: false, trading_active: false }, 503);
        return undefined;
      },
    });
    const { t } = await connect(k);
    const said = async (symbol: string) => {
      const m = market(await t.market(symbol));
      return [m.open, m.note];
    };
    expect(await said("KXFED-26SEP-T4.00:YES")).toEqual([false, "settled: no"]);
    expect(await said("KXFED-27JUN-T4.00:NO")).toEqual([false, "not open for orders yet: opens 2026-11-01T14:00:00Z"]);
    expect(await said("KXFED-27JUL-T4.00:YES")).toEqual([false, "Kalshi has paused this market"]);
    shard2 = false;
    expect(await said("KXGREENLAND-29:YES")).toEqual([false, "Kalshi has paused trading now (its scheduled maintenance is Thursdays 03:00–05:00 ET)"]);
    expect((await said("KXFED-27APR-T4.00:YES"))[0]).toBe(true);
    whole = false;
    expect((await said("KXFED-27APR-T4.00:YES"))[0]).toBe(false);
    const unknown = refusal(await t.market("KXNOPE-1:YES"));
    expect([unknown.code, unknown.message]).toEqual(["E_VENUE_REJECTED", "Kalshi has no market KXNOPE-1"]);
    expect(refusal(await t.market("KXFED-27APR-T4.00")).code).toBe("E_ACCOUNT_BAD_ACTION");
    // a closed market's order is refused here, not sent
    expect(refusal(await t.place({ symbol: "KXFED-26SEP-T4.00:YES", side: "buy", type: "limit", qty: 1, limitPrice: 0.4, clientId: "ord-0001" })).code).toBe("E_VENUE_MARKET_CLOSED");
    expect(posts(k)).toEqual([]);
  });

  it("a key without a current location attestation: Kalshi's own rule for Sports, Elections and Entertainment markets is said on the market", async () => {
    const k = fakeKalshi({ keys: { api_keys: [{ api_key_id: KEY_ID, scopes: ["read", "write"] }] } });
    const { t } = await connect(k);
    expect(market(await t.market("KXFED-27APR-T4.00:YES")).note).toBe("closes 2027-04-28 17:55 UTC · Kalshi shows no current location attestation for this key's account: by Kalshi's own rule it takes no API orders in Sports, Elections and Entertainment markets without one");
  });
});

describe("place(): Kalshi's V2 order, on the YES leg", () => {
  it("a market buy: an immediate-or-cancel bid at the best ask the account valued it at, with the account's id as Kalshi's client order id — exactly this request", async () => {
    const k = fakeKalshi({
      routes: (s) => {
        if (s.method === "POST" && s.path === "/portfolio/events/orders") return created("10.00", "0.00", { average_fill_price: "0.4440", average_fee_paid: "0.0175" });
        if (s.path === "/portfolio/fills") return json({ fills: [{ fill_id: "f1", order_id: ORDER, ticker: FED.ticker, outcome_side: "yes", book_side: "bid", count_fp: "6.00", yes_price_dollars: "0.4400", no_price_dollars: "0.5600", is_taker: true, fee_cost: "0.105000" }, { fill_id: "f2", order_id: ORDER, ticker: FED.ticker, outcome_side: "yes", book_side: "bid", count_fp: "4.00", yes_price_dollars: "0.4500", no_price_dollars: "0.5500", is_taker: true, fee_cost: "0.070000" }], cursor: "" });
        return undefined;
      },
    });
    const { t } = await connect(k);
    market(await t.market("KXFED-27APR-T4.00:YES"));
    const n = k.sent.length;
    k.now += 1500;
    const s = state(await t.place({ symbol: "KXFED-27APR-T4.00:YES", side: "buy", type: "market", qty: 10, clientId: "ord-0001" }));
    // the look the account just valued the order at is the one it is sent at: no second look, no position read for a buy
    expect(k.since(n)).toEqual(["POST /portfolio/events/orders", "GET /portfolio/fills"]);
    const p = posts(k)[0]!;
    expect([p.method, p.url]).toEqual(["POST", `${BASE}/portfolio/events/orders`]);
    expect(p.body).toEqual({ ticker: "KXFED-27APR-T4.00", side: "bid", count: "10.00", price: "0.4500", time_in_force: "immediate_or_cancel", self_trade_prevention_type: "taker_at_cross", client_order_id: "ord-0001" });
    expect(p.headers).toEqual({ "KALSHI-ACCESS-KEY": KEY_ID, "KALSHI-ACCESS-TIMESTAMP": String(START + 1500), "KALSHI-ACCESS-SIGNATURE": kalshiSign(k.privateKey, START + 1500, "POST", "/trade-api/v2/portfolio/events/orders"), accept: "application/json", "Content-Type": "application/json" });
    // the fills price each contract, so the average is what was paid; the fee is Kalshi's own
    expect(s).toEqual({ ref: ORDER, status: "filled", filledQty: 10, avgPrice: 0.444, feeUsd: 0.175, native: { order_id: ORDER, client_order_id: "ord-0001", fill_count: "10.00", remaining_count: "0.00", ts_ms: START, average_fill_price: "0.4440", average_fee_paid: "0.0175" } });
    expect(k.sent.at(-1)!.query).toEqual({ order_id: ORDER, limit: "200" });
  });

  it("a market sell: the position is read first, then an immediate-or-cancel, reduce-only ask at the best bid; what does not fill at once is canceled", async () => {
    const k = fakeKalshi({
      routes: (s) => {
        if (s.path === "/portfolio/positions") return json({ market_positions: [{ ticker: FED.ticker, position_fp: "25.00", market_exposure_dollars: "10.50" }], cursor: "" });
        if (s.method === "POST") return created("4.00", "0.00", { client_order_id: "ord-0002", average_fill_price: "0.4200", average_fee_paid: "0.0170" });
        if (s.path === "/portfolio/fills") return json({ fills: [{ count_fp: "4.00", yes_price_dollars: "0.4200", no_price_dollars: "0.5800", fee_cost: "0.068000" }] });
        return undefined;
      },
    });
    const { t } = await connect(k);
    await t.market("KXFED-27APR-T4.00:YES");
    const n = k.sent.length;
    const s = state(await t.place({ symbol: "KXFED-27APR-T4.00:YES", side: "sell", type: "market", qty: 10, clientId: "ord-0002" }));
    expect(k.since(n)).toEqual(["GET /portfolio/positions", "GET /portfolio/orders", "POST /portfolio/events/orders", "GET /portfolio/fills"]);
    expect([k.sent[n]!.query, k.sent[n + 1]!.query]).toEqual([{ ticker: "KXFED-27APR-T4.00", limit: "200" }, { ticker: "KXFED-27APR-T4.00", status: "resting", limit: "200" }]);
    expect(posts(k)[0]!.body).toEqual({ ticker: "KXFED-27APR-T4.00", side: "ask", count: "10.00", price: "0.4200", time_in_force: "immediate_or_cancel", self_trade_prevention_type: "taker_at_cross", client_order_id: "ord-0002", reduce_only: true });
    expect([s.status, s.filledQty, s.avgPrice, s.feeUsd]).toEqual(["canceled", 4, 0.42, 0.068]);
  });

  it("a limit order: a good-till-canceled order at the limit, resting on Kalshi's book; fractional counts go as two-decimal strings", async () => {
    const k = fakeKalshi({ routes: (s) => (s.method === "POST" ? created("0.00", "2.50") : undefined) });
    const { t } = await connect(k);
    const s = state(await t.place({ symbol: "KXFED-27APR-T4.00:YES", side: "buy", type: "limit", qty: 2.5, limitPrice: 0.4, clientId: "ord-0003" }));
    const p = posts(k)[0]!;
    expect([p.url, p.raw]).toEqual([`${BASE}/portfolio/events/orders`, JSON.stringify({ ticker: "KXFED-27APR-T4.00", side: "bid", count: "2.50", price: "0.4000", time_in_force: "good_till_canceled", self_trade_prevention_type: "taker_at_cross", client_order_id: "ord-0003" })]);
    expect(verify(null, Buffer.from(`${p.headers["KALSHI-ACCESS-TIMESTAMP"]}POST/trade-api/v2/portfolio/events/orders`), createPrivateKey(k.pem), Buffer.from(p.headers["KALSHI-ACCESS-SIGNATURE"]!, "base64"))).toBe(true);
    // nothing filled: no fills are asked for
    expect([s.status, s.filledQty, s.avgPrice, s.feeUsd, k.sent.at(-1)!.method]).toEqual(["open", 0, undefined, undefined, "POST"]);
  });

  it("NO in YES-leg terms: buying NO at n is an ask on YES at 1 − n, selling NO at n a bid on YES at 1 − n — for market and limit orders", async () => {
    const k = fakeKalshi({
      routes: (s) => {
        if (s.path === "/portfolio/positions") return json({ market_positions: [{ ticker: FED.ticker, position_fp: "-30.00" }] });
        if (s.method === "POST") return created("0.00", String((s.body as Rec).count));
        return undefined;
      },
    });
    const { t } = await connect(k);
    const cases = [
      [{ side: "buy", type: "market" }, { side: "ask", price: "0.4200", time_in_force: "immediate_or_cancel" }], // NO's best ask 0.58 → YES 0.42
      [{ side: "buy", type: "limit", limitPrice: 0.55 }, { side: "ask", price: "0.4500", time_in_force: "good_till_canceled" }],
      [{ side: "sell", type: "limit", limitPrice: 0.6 }, { side: "bid", price: "0.4000", time_in_force: "good_till_canceled" }],
      [{ side: "sell", type: "market" }, { side: "bid", price: "0.4500", time_in_force: "immediate_or_cancel", reduce_only: true }], // NO's best bid 0.55 → YES 0.45
    ] as const;
    for (const [i, [o, want]] of cases.entries()) {
      await t.market("KXFED-27APR-T4.00:NO");
      state(await t.place({ symbol: "KXFED-27APR-T4.00:NO", qty: 3, clientId: `ord-000${i + 1}`, ...o }));
      expect(posts(k)[i]!.body).toEqual({ ticker: "KXFED-27APR-T4.00", count: "3.00", self_trade_prevention_type: "taker_at_cross", client_order_id: `ord-000${i + 1}`, ...want });
    }
    // and selling YES at a limit is an ask at that price
    const y = fakeKalshi({ routes: (s) => (s.path === "/portfolio/positions" ? json({ market_positions: [{ ticker: FED.ticker, position_fp: "25.00" }] }) : s.method === "POST" ? created("0.00", "5.00") : undefined) });
    const ty = (await connect(y)).t;
    state(await ty.place({ symbol: "KXFED-27APR-T4.00:YES", side: "sell", type: "limit", qty: 5, limitPrice: 0.47, clientId: "ord-0009" }));
    expect(posts(y)[0]!.body).toMatchObject({ side: "ask", price: "0.4700", time_in_force: "good_till_canceled" });
  });

  it("a NO order's average price is NO's own, from the fills' no_price_dollars", async () => {
    const k = fakeKalshi({
      routes: (s) => {
        if (s.method === "POST") return created("3.00", "0.00", { average_fill_price: "0.4200" });
        if (s.path === "/portfolio/fills") return json({ fills: [{ count_fp: "3.00", outcome_side: "no", book_side: "ask", yes_price_dollars: "0.4200", no_price_dollars: "0.5800", fee_cost: "0.050000" }] });
        return undefined;
      },
    });
    const { t } = await connect(k);
    const s = state(await t.place({ symbol: "KXFED-27APR-T4.00:NO", side: "buy", type: "market", qty: 3, clientId: "ord-0001" }));
    expect([s.status, s.avgPrice, s.feeUsd]).toEqual(["filled", 0.58, 0.05]);
  });

  it("a market order's price goes to the grid in the safe direction: a bid down, an ask up — so it is never worth more than the account valued", async () => {
    const k = fakeKalshi({ routes: (s) => (s.path === "/portfolio/positions" ? json({ market_positions: [{ ticker: ODD.ticker, position_fp: "9.00" }] }) : s.method === "POST" ? created("0.00", "0.00") : undefined) });
    const { t } = await connect(k);
    // YES ask 0.455 → a bid at 0.45; NO ask 0.555 → an ask on YES at 0.45 (NO at 0.55); YES bid 0.445 → an ask at 0.45
    for (const [symbol, side] of [["KXODD-26OCT:YES", "buy"], ["KXODD-26OCT:NO", "buy"], ["KXODD-26OCT:YES", "sell"]] as const) state(await t.place({ symbol, side, type: "market", qty: 1, clientId: "ord-0001" }));
    expect(posts(k).map((p) => [(p.body as Rec).side, (p.body as Rec).price])).toEqual([["bid", "0.4500"], ["ask", "0.4500"], ["ask", "0.4500"]]);
  });

  it("refused here, before anything is sent: a size off 0.01 contracts, a price off the market's grid, a market order with nothing to take, a sell of more than is held, a name that is not a Kalshi market", async () => {
    const k = fakeKalshi({ routes: (s) => (s.path === "/portfolio/positions" ? json({ market_positions: [{ ticker: FED.ticker, position_fp: "2.00" }] }) : undefined) });
    const { t } = await connect(k);
    const base = { symbol: "KXFED-27APR-T4.00:YES", side: "buy", type: "limit", qty: 1, limitPrice: 0.4, clientId: "ord-0001" } as const;
    const said = async (o: Partial<typeof base> | Rec) => {
      const r = refusal(await t.place({ ...base, ...o } as never));
      return [r.code, r.message];
    };
    expect(await said({ qty: 1.234 })).toEqual(["E_VENUE_ORDER_INVALID", "Kalshi: a count at Kalshi is in steps of 0.01 contracts, at least 0.01"]);
    expect((await said({ qty: 0.004 }))[0]).toBe("E_VENUE_ORDER_INVALID");
    expect(await said({ limitPrice: 0.40001 })).toEqual(["E_VENUE_ORDER_INVALID", "Kalshi: a price at Kalshi is in dollars, more than 0 and less than 1, at most four decimals"]);
    expect((await said({ limitPrice: 1 }))[0]).toBe("E_VENUE_ORDER_INVALID");
    expect(await said({ limitPrice: 0.405 })).toEqual(["E_VENUE_ORDER_INVALID", `Kalshi: a price in ${String(FED.title)} (Above 4.00%) · Yes moves in steps of 0.01 between 0 and 1`]);
    // the tapered grid: a tenth of a cent is fine below $0.10, not between $0.10 and $0.90 — and for NO, the bands as NO sees them
    expect(await said({ symbol: "KXGREENLAND-29:YES", limitPrice: 0.155 })).toEqual(["E_VENUE_ORDER_INVALID", "Kalshi: a price in Will the US acquire Greenland before 2029? (Before 2029) · Yes moves in steps of 0.01 between 0.1 and 0.9"]);
    expect(await said({ symbol: "KXGREENLAND-29:NO", limitPrice: 0.845 })).toEqual(["E_VENUE_ORDER_INVALID", "Kalshi: a price in Will the US acquire Greenland before 2029? (Before 2029) · No moves in steps of 0.01 between 0.1 and 0.9"]);
    expect(await said({ symbol: "KXEMPTY-26OCT:YES", type: "market", limitPrice: undefined })).toEqual(["E_VENUE_ORDER_INVALID", `Kalshi: no one is selling ${String(FED.title)} (Above 4.00%) · Yes right now, so a market order has nothing to take: try a limit order`]);
    const held = refusal(await t.place({ ...base, side: "sell", qty: 3 }));
    expect([held.code, held.message, held.detail]).toEqual(["E_VENUE_INSUFFICIENT", "Kalshi: you hold 2 KXFED-27APR-T4.00:YES, fewer than the 3 to sell. A sell here is of what is held: selling more at Kalshi would buy the other side", { held: 2, qty: 3 }]);
    // holding YES is holding no NO
    expect(refusal(await t.place({ ...base, symbol: "KXFED-27APR-T4.00:NO", side: "sell", qty: 1 })).code).toBe("E_VENUE_INSUFFICIENT");
    expect(refusal(await t.place({ ...base, symbol: "FED-YES" })).code).toBe("E_ACCOUNT_BAD_ACTION");
    expect(posts(k)).toEqual([]);
    // a tenth of a cent on the tapered grid's edge band is a valid price, and goes
    const ok = fakeKalshi({ routes: (s) => (s.method === "POST" ? created("0.00", "1.00") : undefined) });
    state(await (await connect(ok)).t.place({ ...base, symbol: "KXGREENLAND-29:YES", limitPrice: 0.045 }));
    expect((posts(ok)[0]!.body as Rec).price).toBe("0.0450");
  });

  it("the client id is the account's own, kept to the characters a client id takes", async () => {
    const k = fakeKalshi({ routes: (s) => (s.method === "POST" ? created("0.00", "1.00") : undefined) });
    const { t } = await connect(k);
    state(await t.place({ symbol: "KXFED-27APR-T4.00:YES", side: "buy", type: "limit", qty: 1, limitPrice: 0.4, clientId: "ord-0007" }));
    state(await t.place({ symbol: "KXFED-27APR-T4.00:YES", side: "buy", type: "limit", qty: 1, limitPrice: 0.4, clientId: "ord 0008/x" }));
    expect(posts(k).map((p) => (p.body as Rec).client_order_id)).toEqual(["ord-0007", "ord0008x"]);
  });

  it("a market order goes at the worst price the account gave it — a buy pays at most it, a sell takes at least it — on the grid in the safe direction, never at $0 or $1", async () => {
    let held = "50.00";
    const k = fakeKalshi({ routes: (s) => (s.path === "/portfolio/positions" ? json({ market_positions: [{ ticker: FED.ticker, position_fp: held }] }) : s.method === "POST" ? created("0.00", "0.00") : undefined) });
    const { t } = await connect(k);
    const go = async (symbol: string, side: "buy" | "sell", worstPrice: number) => {
      state(await t.place({ symbol, side, type: "market", qty: 1, worstPrice, clientId: "0123456789abcdef0123456789abcdef" }));
      const b = posts(k).at(-1)!.body as Rec;
      return [b.side, b.price, b.time_in_force];
    };
    // FED's book: YES 0.42 / 0.45, NO 0.55 / 0.58
    expect(await go("KXFED-27APR-T4.00:YES", "buy", 0.459)).toEqual(["bid", "0.4500", "immediate_or_cancel"]);
    expect(await go("KXFED-27APR-T4.00:YES", "buy", 0.46)).toEqual(["bid", "0.4600", "immediate_or_cancel"]);
    // tighter than the book is still the bound: whatever the look showed, the order never pays more than its worst price
    expect(await go("KXFED-27APR-T4.00:YES", "buy", 0.44)).toEqual(["bid", "0.4400", "immediate_or_cancel"]);
    expect(await go("KXFED-27APR-T4.00:NO", "buy", 0.59)).toEqual(["ask", "0.4100", "immediate_or_cancel"]);
    expect(await go("KXFED-27APR-T4.00:YES", "sell", 0.41)).toEqual(["ask", "0.4100", "immediate_or_cancel"]);
    held = "-50.00";
    // NO at least 0.539 is YES at most 0.461: down to 0.46, which is NO at 0.54
    expect(await go("KXFED-27APR-T4.00:NO", "sell", 0.539)).toEqual(["bid", "0.4600", "immediate_or_cancel"]);
    // 2% over a 0.99 ask is past $1: the highest price there is, under $1 (and for NO, the lowest YES ask, over $0)
    expect(await go("KXFED-27APR-T4.00:YES", "buy", 1.009)).toEqual(["bid", "0.9900", "immediate_or_cancel"]);
    expect(await go("KXFED-27APR-T4.00:NO", "buy", 1.009)).toEqual(["ask", "0.0100", "immediate_or_cancel"]);
    expect(await go("KXGREENLAND-29:YES", "buy", 0.048)).toEqual(["bid", "0.0480", "immediate_or_cancel"]);
  });

  it("a sell counts the orders already resting on the same side of the book: they sell what is held first, and selling past them would buy the other side", async () => {
    const k = fakeKalshi({
      routes: (s) => {
        if (s.path === "/portfolio/positions") return json({ market_positions: [{ ticker: FED.ticker, position_fp: "10.00" }] });
        if (s.path === "/portfolio/orders") return json({ orders: [order({ book_side: "ask", remaining_count_fp: "8.00" }), order({ order_id: "a-bid", book_side: "bid", remaining_count_fp: "50.00" })], cursor: "" });
        if (s.method === "POST") return created("0.00", "2.00");
        return undefined;
      },
    });
    const { t } = await connect(k);
    const over = refusal(await t.place({ symbol: "KXFED-27APR-T4.00:YES", side: "sell", type: "limit", qty: 3, limitPrice: 0.5, clientId: "c1" }));
    expect([over.code, over.message, over.detail]).toEqual(["E_VENUE_INSUFFICIENT", "Kalshi: you hold 10 KXFED-27APR-T4.00:YES, and orders already resting on Kalshi's book sell 8 of it: 2 is free to sell, fewer than the 3 asked. A sell here is of what is held: selling more at Kalshi would buy the other side", { held: 10, qty: 3, resting: 8 }]);
    expect(posts(k)).toEqual([]);
    // the resting bid does not sell YES; the 2 that are free go
    state(await t.place({ symbol: "KXFED-27APR-T4.00:YES", side: "sell", type: "limit", qty: 2, limitPrice: 0.5, clientId: "c2" }));
    expect((posts(k)[0]!.body as Rec).side).toBe("ask");
  });

  it("fills that cannot be read: a YES order's average is Kalshi's average_fill_price; a NO order's is left to the price it was valued at, since the docs do not say which leg that field is on", async () => {
    const k = fakeKalshi({ routes: (s) => (s.method === "POST" ? created("3.00", "0.00", { average_fill_price: "0.4200", average_fee_paid: "0.0100" }) : undefined) });
    const { t } = await connect(k);
    const yes = state(await t.place({ symbol: "KXFED-27APR-T4.00:YES", side: "buy", type: "market", qty: 3, clientId: "c1" }));
    const noOrder = state(await t.place({ symbol: "KXFED-27APR-T4.00:NO", side: "buy", type: "market", qty: 3, clientId: "c2" }));
    expect([yes.avgPrice, yes.feeUsd, noOrder.avgPrice, noOrder.feeUsd]).toEqual([0.42, 0.03, undefined, 0.03]);
  });
});

describe("Kalshi's refusals, in its own words", () => {
  const refusedWith = async (reply: HttpReply) => {
    const k = fakeKalshi({ routes: (s) => (s.method === "POST" ? reply : s.path === "/portfolio/orders" ? json({ orders: [], cursor: "" }) : undefined) });
    const { t } = await connect(k);
    const r = refusal(await t.place({ symbol: "KXGREENLAND-29:YES", side: "buy", type: "limit", qty: 10, limitPrice: 0.045, clientId: "ord-0001" }));
    return { r, k };
  };

  it("not enough cash (on the market's shard), a size Kalshi does not take, a key without trading scope, a region rule, a closed market, a price off the grid", async () => {
    const said = async (reply: HttpReply) => {
      const { r } = await refusedWith(reply);
      return [r.code, r.message, r.native];
    };
    expect(await said(json({ error: { code: "available_balance_too_low", message: "Insufficient available balance for the order" } }, 400))).toEqual(["E_VENUE_INSUFFICIENT", "Kalshi: not enough cash for this order on the exchange shard its market trades on (shard 2). An order sent through Kalshi's API counts only the cash already on that shard", { status: 400, said: "available_balance_too_low · Insufficient available balance for the order" }]);
    expect(await said(json({ error: { code: "invalid_order_size", message: "invalid order size" } }, 400))).toEqual(["E_VENUE_ORDER_INVALID", "Kalshi: Kalshi does not take an order of this size (counts are in steps of 0.01 contracts)", { status: 400, said: "invalid_order_size · invalid order size" }]);
    expect(await said(json({ code: "forbidden", message: "Forbidden - insufficient permissions" }, 403))).toEqual(["E_VENUE_PERMISSION", "Kalshi refused: this key may not trade. A Kalshi key keeps the scopes it was made with; one that trades has write (or write::trade)", { status: 403, said: "forbidden · Forbidden - insufficient permissions" }]);
    const region = await said(json({ error: { code: "forbidden", message: "API key location attestation has expired for this market category" } }, 403));
    expect([region[0], region[1]]).toEqual(["E_VENUE_GEOBLOCKED", "Kalshi does not take this order from where this account is: that is its own rule, and the account does not look for a way around it"]);
    expect((await said(json({ error: { code: "forbidden", message: "Not available in your jurisdiction" } }, 403)))[0]).toBe("E_VENUE_GEOBLOCKED");
    expect((await said(json({ error: { code: "market_inactive", message: "market is not active" } }, 400)))[0]).toBe("E_VENUE_MARKET_CLOSED");
    expect((await said(json({ error: { code: "invalid_order", message: "invalid price", details: "INVALID_PRICE" } }, 400)))[0]).toBe("E_VENUE_ORDER_INVALID");
    expect((await said(json({ error: { code: "unauthorized", message: "invalid signature" } }, 401)))[0]).toBe("E_VENUE_UNAUTHORIZED");
    expect(await said(json({ error: "too many requests" }, 429))).toEqual(["E_VENUE_UNREACHABLE", "Kalshi is rate-limiting this machine: try again in a minute", { status: 429, said: "too many requests" }]);
    expect((await said(json({ error: { code: "something_new", message: "something new" } }, 400)))[0]).toBe("E_VENUE_REJECTED");
    // a post-only order that would cross, as a batch reported it (changelog 2025-10-24)
    expect(await said(json({ error: { code: "invalid order", message: "invalid order", details: "post only cross" } }, 400))).toEqual(["E_VENUE_ORDER_INVALID", "Kalshi: post-only: at this price the order would have taken from the book at once, so Kalshi did not rest it", { status: 400, said: "invalid order · post only cross · invalid order" }]);
  });

  it("nothing secret leaves in a refusal, even if Kalshi's answer were to carry the private key, line breaks and all", async () => {
    const box = { pem: "" };
    const k = fakeKalshi({ routes: (s) => (s.method === "POST" ? json({ error: { code: "bad_request", message: `echo ${box.pem}` } }, 400) : undefined) });
    box.pem = k.pem;
    const no = refusal(await (await connect(k)).t.place({ symbol: "KXFED-27APR-T4.00:YES", side: "buy", type: "limit", qty: 1, limitPrice: 0.4, clientId: "ord-0001" }));
    expect(JSON.stringify(no)).not.toContain(k.pem.split("\n")[1]!);
    expect(no.native).toEqual({ status: 400, said: "bad_request · echo •••" });
  });

  it("an order Kalshi did not answer for, or answered 409 for, is looked for by its client id: the same order is the order, another under that id is refused", async () => {
    const resting = order({ client_order_id: "ord-0001", book_side: "bid", yes_price_dollars: "0.4000", initial_count_fp: "2.00", remaining_count_fp: "2.00" });
    for (const how of ["409", "timeout", "500"] as const) {
      const k = fakeKalshi({
        throwOn: (s) => how === "timeout" && s.method === "POST",
        routes: (s) => (s.method === "POST" ? json({ error: { code: "conflict", message: "order already exists" } }, how === "409" ? 409 : 500) : s.path === "/portfolio/orders" ? json({ orders: [order({ order_id: "another", client_order_id: "ord-0000" }), resting], cursor: "" }) : undefined),
      });
      const { t } = await connect(k);
      const s = state(await t.place({ symbol: "KXFED-27APR-T4.00:YES", side: "buy", type: "limit", qty: 2, limitPrice: 0.4, clientId: "ord-0001" }));
      expect([how, s.ref, s.status, posts(k).length]).toEqual([how, ORDER, "open", 1]);
      expect(k.sent.at(-1)!.query).toEqual({ ticker: "KXFED-27APR-T4.00", limit: "200" });
    }
    const k = fakeKalshi({ routes: (s) => (s.method === "POST" ? json({ error: { code: "conflict", message: "order already exists" } }, 409) : s.path === "/portfolio/orders" ? json({ orders: [resting] }) : undefined) });
    const other = refusal(await (await connect(k)).t.place({ symbol: "KXFED-27APR-T4.00:YES", side: "buy", type: "limit", qty: 5, limitPrice: 0.4, clientId: "ord-0001" }));
    expect([other.code, other.message]).toEqual(["E_VENUE_REJECTED", "Kalshi already has an order with the id ord-0001, and it is not this one: nothing was placed"]);
    // no answer, and not found: the venue did not answer
    const lost = fakeKalshi({ throwOn: (s) => s.method === "POST", routes: (s) => (s.path === "/portfolio/orders" ? json({ orders: [] }) : undefined) });
    const gone = refusal(await (await connect(lost)).t.place({ symbol: "KXFED-27APR-T4.00:YES", side: "buy", type: "limit", qty: 2, limitPrice: 0.4, clientId: "ord-0001" }));
    expect([gone.code, gone.message, gone.detail]).toEqual(["E_VENUE_UNREACHABLE", "Kalshi did not answer the order, and it is not among Kalshi's orders yet: it may have been taken all the same. Look at Kalshi's orders for ord-0001 before placing it again", { clientOrderId: "ord-0001", placed: "unknown" }]);
    // a 5xx, not found: the same — never "not placed"
    const five = fakeKalshi({ routes: (s) => (s.method === "POST" ? json({ error: { code: "service_unavailable", message: "unavailable" } }, 503) : undefined) });
    const f = refusal(await (await connect(five)).t.place({ symbol: "KXFED-27APR-T4.00:YES", side: "buy", type: "limit", qty: 2, limitPrice: 0.4, clientId: "ord-0001" }));
    expect([f.code, f.message.startsWith("Kalshi answered the order with HTTP 503, and it is not among Kalshi's orders yet"), f.detail]).toEqual(["E_VENUE_UNREACHABLE", true, { clientOrderId: "ord-0001", placed: "unknown" }]);
  });
});

describe("status() and cancel(): what became of an order", () => {
  it("resting is open (partial once some filled), executed is filled, canceled is canceled with what had filled, canceled at its expiry is expired; an id Kalshi does not have is unknown", async () => {
    let now: Rec = order({});
    const k = fakeKalshi({
      routes: (s) => {
        if (s.path === `/portfolio/orders/${ORDER}`) return json({ order: now });
        if (s.path === "/portfolio/orders/nope") return notFound();
        if (s.path === "/portfolio/fills") return json({ fills: [{ count_fp: "3.00", yes_price_dollars: "0.4000", no_price_dollars: "0.6000", fee_cost: "0.050000" }, { count_fp: "1.00", yes_price_dollars: "0.3900", no_price_dollars: "0.6100", fee_cost: "0.010000" }] });
        return undefined;
      },
    });
    const { t } = await connect(k);
    const read = async (o: Rec, symbol = "KXFED-27APR-T4.00:YES") => {
      now = order(o);
      const s = state(await t.status(ORDER, symbol));
      return [s.status, s.filledQty, s.avgPrice, s.feeUsd];
    };
    expect(await read({})).toEqual(["open", 0, undefined, undefined]);
    expect(k.sent.at(-1)!.url).toBe(`${BASE}/portfolio/orders/${ORDER}`);
    expect(await read({ fill_count_fp: "4.00", remaining_count_fp: "6.00", maker_fill_cost_dollars: "1.590000", maker_fees_dollars: "0.060000" })).toEqual(["partial", 4, 0.3975, 0.06]);
    expect(await read({ status: "executed", fill_count_fp: "10.00", remaining_count_fp: "0.00", taker_fees_dollars: "0.120000", maker_fees_dollars: "0.060000" })).toEqual(["filled", 10, 0.3975, 0.18]);
    expect(await read({ status: "canceled", fill_count_fp: "4.00", remaining_count_fp: "0.00" })).toEqual(["canceled", 4, 0.3975, 0]);
    expect(await read({ status: "canceled", expiration_time: "2026-10-05T15:00:00Z", last_update_time: "2026-10-05T15:00:00Z" })).toEqual(["expired", 0, undefined, undefined]);
    // a NO order's average from the same fills is NO's price
    expect(await read({ status: "executed", fill_count_fp: "4.00", remaining_count_fp: "0.00", outcome_side: "no", book_side: "ask" }, "KXFED-27APR-T4.00:NO")).toEqual(["filled", 4, 0.6025, 0]);
    const gone = refusal(await t.status("nope", "KXFED-27APR-T4.00:YES"));
    expect(gone.code).toBe("E_ACCOUNT_ORDER_UNKNOWN");
  });

  it("cancel: DELETE on the V2 endpoint with the market's ticker for routing — the signature over the path alone — then the order as it stands", async () => {
    let deleted = false;
    const k = fakeKalshi({
      routes: (s) => {
        if (s.method === "DELETE") {
          deleted = true;
          return json({ order_id: ORDER, client_order_id: "ord-0001", reduced_by: "6.00", ts_ms: START });
        }
        if (s.path === `/portfolio/orders/${ORDER}`) return json({ order: order(deleted ? { status: "canceled", fill_count_fp: "4.00", remaining_count_fp: "0.00" } : {}) });
        if (s.path === "/portfolio/fills") return json({ fills: [{ count_fp: "4.00", yes_price_dollars: "0.4000", no_price_dollars: "0.6000", fee_cost: "0.040000" }] });
        return undefined;
      },
    });
    const { t } = await connect(k);
    const n = k.sent.length;
    const s = state(await t.cancel(ORDER, "KXFED-27APR-T4.00:YES"));
    expect(k.since(n)).toEqual([`DELETE /portfolio/events/orders/${ORDER}`, `GET /portfolio/orders/${ORDER}`, "GET /portfolio/fills"]);
    const d = k.sent[n]!;
    expect([d.url, d.body, d.headers["KALSHI-ACCESS-SIGNATURE"], d.headers["Content-Type"]]).toEqual([`${BASE}/portfolio/events/orders/${ORDER}?market_ticker=KXFED-27APR-T4.00`, undefined, kalshiSign(k.privateKey, START, "DELETE", `/trade-api/v2/portfolio/events/orders/${ORDER}`), undefined]);
    expect([s.ref, s.status, s.filledQty, s.avgPrice]).toEqual([ORDER, "canceled", 4, 0.4]);
    expect((s.native as Rec).cancel).toEqual({ order_id: ORDER, client_order_id: "ord-0001", reduced_by: "6.00", ts_ms: START });
  });

  it("cancel of an order already done is Kalshi's 404: the order as it stands if Kalshi has it, unknown if not; a cancel taken but not read back says so", async () => {
    const k = fakeKalshi({
      routes: (s) => {
        if (s.method === "DELETE") return notFound();
        if (s.path === `/portfolio/orders/${ORDER}`) return json({ order: order({ status: "executed", fill_count_fp: "10.00", remaining_count_fp: "0.00" }) });
        if (s.path === "/portfolio/fills") return json({ fills: [{ count_fp: "10.00", yes_price_dollars: "0.4000", no_price_dollars: "0.6000", fee_cost: "0.1" }] });
        return undefined;
      },
    });
    const { t } = await connect(k);
    expect(state(await t.cancel(ORDER, "KXFED-27APR-T4.00:YES")).status).toBe("filled");
    expect(refusal(await t.cancel("nope", "KXFED-27APR-T4.00:YES")).code).toBe("E_ACCOUNT_ORDER_UNKNOWN");
    const half = fakeKalshi({ routes: (s) => (s.method === "DELETE" ? json({ order_id: ORDER, reduced_by: "6.00", ts_ms: START }) : s.path.startsWith("/portfolio/orders/") ? json({ error: { code: "service_unavailable", message: "unavailable" } }, 503) : undefined) });
    const r = refusal(await (await connect(half)).t.cancel(ORDER, "KXFED-27APR-T4.00:YES"));
    expect([r.code, r.message]).toEqual(["E_VENUE_UNREACHABLE", "Kalshi took the cancel (6 contracts off the book), but the order could not be read back: it is read again in a few seconds"]);
    expect(refusal(await t.cancel(ORDER, "KXFED")).code).toBe("E_ACCOUNT_BAD_ACTION");
    // a 404 on the cancel while the order is still resting: Kalshi did not take it, and that is what is said
    const stuck = fakeKalshi({ routes: (s) => (s.method === "DELETE" ? notFound() : s.path === `/portfolio/orders/${ORDER}` ? json({ order: order({}) }) : undefined) });
    const st = refusal(await (await connect(stuck)).t.cancel(ORDER, "KXFED-27APR-T4.00:YES"));
    expect([st.code, st.message]).toEqual(["E_VENUE_REJECTED", "Kalshi did not take the cancel (HTTP 404), and the order is still on its book: cancel it at Kalshi"]);
  });
});

describe("markets(): what can be traded at Kalshi", () => {
  const mk = (ticker: string, vol: number, over: Rec = {}): Rec => ({ ...FED, ticker, title: `Market ${ticker}`, yes_sub_title: "", volume_24h_fp: `${vol}.00`, ...over });
  const BTC = mk("KXBTCD-26OCT0517-T94000", 900, { title: "Bitcoin price on Oct 5, 2026?", yes_sub_title: "$94,000 or above", exchange_index: 2 });
  const FED2 = mk("KXFED-27APR-T4.25", 100);
  const GDP = mk("KXGDP-26Q3-T2.0", 50, { title: "Will real GDP grow more than 2.0% in Q3 2026?" });
  const general = [
    ...Array.from({ length: 12 }, (_, i) => mk(`KXSPORT-26OCT05-T${i}`, 10 + i)),
    mk("KXMVECROSSCATEGORY-S2026-ABC", 99_999),
    mk("KXHALTED-26OCT", 99_999, { status: "inactive" }),
    // a market without dollar prices is not one the account can price
    Object.fromEntries(Object.entries(mk("KXCENTS-26OCT", 99_999)).filter(([key]) => !key.endsWith("_dollars"))),
    mk("KXHIGHNY-26OCT05-B70", 4000, { title: "Highest temperature in NYC today?" }),
  ];

  it("an empty search: the well-known markets first (the most-traded of each series), then the rest by the day's volume; combos, inactive and undollared markets left out; at most 20; kept five minutes", async () => {
    const k = fakeKalshi({
      routes: (s) => {
        if (s.path !== "/markets") return undefined;
        if (s.query.series_ticker === "KXFED") return json({ markets: [FED2, FED], cursor: "" });
        if (s.query.series_ticker === "KXBTCD") return json({ markets: [BTC], cursor: "" });
        if (s.query.series_ticker) return json({ markets: [], cursor: "" });
        return json({ markets: general, cursor: "next" });
      },
    });
    const { t } = await connect(k);
    const n = k.sent.length;
    const list = await t.markets("");
    if (isRefusal(list)) throw new Error(list.message);
    const lists = k.sent.slice(n).filter((s) => s.path === "/markets");
    expect(lists.map((s) => s.query)).toEqual([{ status: "open", mve_filter: "exclude", limit: "1000" }, ...["KXFED", "KXFEDDECISION", "KXCPI", "KXINX", "KXBTCD"].map((series_ticker) => ({ status: "open", series_ticker, limit: "200" }))]);
    expect(list.length).toBe(20);
    expect(list.slice(0, 8).map((m) => m.symbol)).toEqual(["KXFED-27APR-T4.00:YES", "KXFED-27APR-T4.00:NO", "KXBTCD-26OCT0517-T94000:YES", "KXBTCD-26OCT0517-T94000:NO", "KXHIGHNY-26OCT05-B70:YES", "KXHIGHNY-26OCT05-B70:NO", "KXFED-27APR-T4.25:YES", "KXFED-27APR-T4.25:NO"]);
    expect(list.every((m) => m.quote === "USD" && m.kind === "event" && m.open)).toBe(true);
    expect(list.some((m) => /KXMVE|KXHALTED|KXCENTS/.test(m.symbol))).toBe(false);
    expect(list[2]!.name).toBe("Bitcoin price on Oct 5, 2026? ($94,000 or above) · Yes");
    // kept five minutes
    const m = k.sent.length;
    await t.markets("");
    expect(k.sent.slice(m).filter((s) => s.path === "/markets")).toEqual([]);
    k.now += 5 * 60_000;
    await t.markets("");
    expect(k.sent.slice(m).filter((s) => s.path === "/markets").length).toBe(6);
  });

  it("a search: by name or ticker over the list; a ticker the list does not hold is asked of its series", async () => {
    const k = fakeKalshi({
      routes: (s) => {
        if (s.path !== "/markets") return undefined;
        if (s.query.series_ticker === "KXBTCD") return json({ markets: [BTC] });
        if (s.query.series_ticker === "KXGDP") return json({ markets: [mk("KXGDP-26Q3-T2.5", 20), GDP, mk("KXGDP-26Q3-T3.0", 5, { status: "closed" })] });
        if (s.query.series_ticker) return json({ markets: [] });
        return json({ markets: general });
      },
    });
    const { t } = await connect(k);
    const named = await t.markets("bitcoin");
    if (isRefusal(named)) throw new Error(named.message);
    expect(named.map((m) => m.symbol)).toEqual(["KXBTCD-26OCT0517-T94000:YES", "KXBTCD-26OCT0517-T94000:NO"]);
    const n = k.sent.length;
    const gdp = await t.markets("kxgdp-26q3");
    if (isRefusal(gdp)) throw new Error(gdp.message);
    expect(gdp.map((m) => m.symbol)).toEqual(["KXGDP-26Q3-T2.0:YES", "KXGDP-26Q3-T2.0:NO", "KXGDP-26Q3-T2.5:YES", "KXGDP-26Q3-T2.5:NO"]);
    expect(k.sent.slice(n).filter((s) => s.path === "/markets").map((s) => s.url)).toEqual([`${BASE}/markets?status=open&series_ticker=KXGDP&limit=200`]);
    // the list itself not answering is Kalshi's no
    const down = fakeKalshi({ routes: (s) => (s.path === "/markets" ? json({ error: { code: "service_unavailable", message: "unavailable" } }, 503) : undefined) });
    expect(refusal(await (await connect(down)).t.markets("")).code).toBe("E_VENUE_UNREACHABLE");
  });
});

/** 2026-10-05 10:00 EDT (START): the day ends at 23:59:59 EDT, which is 03:59:59 UTC the next morning */
const DAY_END = Date.parse("2026-10-06T03:59:59Z") / 1000;
const FED_YES = "KXFED-27APR-T4.00:YES";
const FED_NO = "KXFED-27APR-T4.00:NO";
const body = (p: Sent): Rec => p.body as Rec;

describe("how long an order stays, post-only and reduce-only: what V2's create takes", () => {
  it("each time in force as V2's time_in_force: gtc good_till_canceled, ioc immediate_or_cancel, fok fill_or_kill, and day good_till_canceled with the end of the day in New York as its expiration_time", async () => {
    const k = fakeKalshi({ routes: (s) => (s.method === "POST" ? created("0.00", String((s.body as Rec).count)) : undefined) });
    const { t } = await connect(k);
    const limit = { symbol: FED_YES, side: "buy", type: "limit", qty: 1, limitPrice: 0.4 } as const;
    for (const [i, tif] of (["gtc", "ioc", "fok", "day"] as const).entries()) state(await t.place({ ...limit, tif, clientId: `ord-000${i + 1}` }));
    expect(posts(k).map((p) => [body(p).time_in_force, body(p).expiration_time])).toEqual([["good_till_canceled", undefined], ["immediate_or_cancel", undefined], ["fill_or_kill", undefined], ["good_till_canceled", DAY_END]]);
    // the day order, whole: what Kalshi takes and nothing else
    expect(posts(k)[3]!.raw).toBe(JSON.stringify({ ticker: "KXFED-27APR-T4.00", side: "bid", count: "1.00", price: "0.4000", time_in_force: "good_till_canceled", self_trade_prevention_type: "taker_at_cross", client_order_id: "ord-0004", expiration_time: DAY_END }));
    // none asked: as it always was here — a limit order rests, a market order fills at once
    state(await t.place({ ...limit, clientId: "ord-0005" }));
    state(await t.place({ ...limit, type: "market", limitPrice: undefined, clientId: "ord-0006" }));
    expect(posts(k).slice(4).map((p) => body(p).time_in_force)).toEqual(["good_till_canceled", "immediate_or_cancel"]);
  });

  it("a market order fills at once (immediate-or-cancel) or, asked, all at once or not at all (fill-or-kill); a sell sent ioc goes reduce_only, asked or not — a fill-or-kill or resting one cannot, since Kalshi takes reduce_only only with immediate_or_cancel", async () => {
    const k = fakeKalshi({ routes: (s) => (s.path === "/portfolio/positions" ? json({ market_positions: [{ ticker: FED.ticker, position_fp: "25.00" }] }) : s.method === "POST" ? created("0.00", "0.00") : undefined) });
    const { t } = await connect(k);
    const go = async (o: Partial<OrderRequest>) => {
      state(await t.place({ symbol: FED_YES, side: "buy", type: "market", qty: 1, clientId: "c1", ...o }));
      const b = body(posts(k).at(-1)!);
      return [b.side, b.price, b.time_in_force, b.reduce_only];
    };
    // FED's book: YES 0.42 / 0.45
    expect(await go({ tif: "fok" })).toEqual(["bid", "0.4500", "fill_or_kill", undefined]);
    expect(await go({ tif: "ioc" })).toEqual(["bid", "0.4500", "immediate_or_cancel", undefined]);
    expect(await go({ side: "sell" })).toEqual(["ask", "0.4200", "immediate_or_cancel", true]);
    expect(await go({ side: "sell", tif: "fok" })).toEqual(["ask", "0.4200", "fill_or_kill", undefined]);
    expect(await go({ side: "sell", type: "limit", limitPrice: 0.47, tif: "ioc" })).toEqual(["ask", "0.4700", "immediate_or_cancel", true]);
    expect(await go({ side: "sell", type: "limit", limitPrice: 0.47, tif: "fok" })).toEqual(["ask", "0.4700", "fill_or_kill", undefined]);
    expect(await go({ side: "sell", type: "limit", limitPrice: 0.47 })).toEqual(["ask", "0.4700", "good_till_canceled", undefined]);
  });

  it("post_only on a limit order that rests (good-till-canceled or day), and Kalshi's cancel of one that would have crossed is said as canceled; reduce_only on a sell that fills at once — NO held closed as a bid on the YES leg", async () => {
    let crossed = true;
    const k = fakeKalshi({
      routes: (s) => {
        if (s.path === "/portfolio/positions") return json({ market_positions: [{ ticker: FED.ticker, position_fp: "-30.00" }] });
        // the first post-only order would have crossed: Kalshi cancels it rather than let it take (PostOnlyCrossCancel)
        if (s.method === "POST" && crossed) {
          crossed = false;
          return created("0.00", "0.00");
        }
        return s.method === "POST" ? created("0.00", String((s.body as Rec).count)) : undefined;
      },
    });
    const { t } = await connect(k);
    const first = state(await t.place({ symbol: FED_YES, side: "buy", type: "limit", qty: 1, limitPrice: 0.46, postOnly: true, clientId: "c1" }));
    expect([first.status, first.filledQty]).toEqual(["canceled", 0]);
    state(await t.place({ symbol: FED_NO, side: "buy", type: "limit", qty: 1, limitPrice: 0.57, tif: "day", postOnly: true, clientId: "c2" }));
    state(await t.place({ symbol: FED_NO, side: "sell", type: "market", qty: 5, reduceOnly: true, clientId: "c3" }));
    state(await t.place({ symbol: FED_NO, side: "sell", type: "limit", qty: 5, limitPrice: 0.54, tif: "ioc", reduceOnly: true, clientId: "c4" }));
    const same = { ticker: "KXFED-27APR-T4.00", self_trade_prevention_type: "taker_at_cross" };
    expect(posts(k).map(body)).toEqual([
      { ...same, side: "bid", count: "1.00", price: "0.4600", time_in_force: "good_till_canceled", client_order_id: "c1", post_only: true },
      // NO at 0.57 is an ask on YES at 0.43, resting until the day's end
      { ...same, side: "ask", count: "1.00", price: "0.4300", time_in_force: "good_till_canceled", client_order_id: "c2", expiration_time: DAY_END, post_only: true },
      // NO's best bid 0.55 is a YES bid at 0.45; NO at least 0.54 is a YES bid at 0.46
      { ...same, side: "bid", count: "5.00", price: "0.4500", time_in_force: "immediate_or_cancel", client_order_id: "c3", reduce_only: true },
      { ...same, side: "bid", count: "5.00", price: "0.4600", time_in_force: "immediate_or_cancel", client_order_id: "c4", reduce_only: true },
    ]);
  });

  it("refused here, before anything is sent: stop orders, a market order that would rest, post-only that could never rest, reduce-only on a buy or on an order that does not fill at once, a day order in the day's last seconds", async () => {
    const k = fakeKalshi({ routes: (s) => (s.path === "/portfolio/positions" ? json({ market_positions: [{ ticker: FED.ticker, position_fp: "25.00" }] }) : undefined) });
    const { t } = await connect(k);
    const sell = { symbol: FED_YES, side: "sell", type: "limit", qty: 1, limitPrice: 0.4, clientId: "c1" } as const;
    const said = async (o: Rec) => {
      const r = refusal(await t.place({ ...sell, ...o } as never));
      return [r.code, r.message];
    };
    expect(await said({ type: "stop", limitPrice: undefined, stopPrice: 0.3 })).toEqual(["E_VENUE_ORDER_INVALID", "Kalshi: Kalshi has no stop orders on event contracts: it takes limit orders, and the account's market order goes as a limit that fills at once"]);
    expect((await said({ type: "stop_limit", stopPrice: 0.3 }))[1]).toContain("Kalshi has no stop-limit orders on event contracts");
    expect(await said({ type: "market", limitPrice: undefined, tif: "gtc" })).toEqual(["E_VENUE_ORDER_INVALID", "Kalshi: a market order at Kalshi is a limit at its worst price that fills at once (immediate-or-cancel), or all at once or not at all (fill-or-kill): one that rests on the book is a limit order"]);
    expect((await said({ type: "market", limitPrice: undefined, tif: "day" }))[0]).toBe("E_VENUE_ORDER_INVALID");
    expect(await said({ side: "buy", type: "market", limitPrice: undefined, postOnly: true })).toEqual(["E_VENUE_ORDER_INVALID", "Kalshi: post-only is for a limit order: a market order takes from the book"]);
    for (const tif of ["ioc", "fok"]) expect(await said({ side: "buy", postOnly: true, tif })).toEqual(["E_VENUE_ORDER_INVALID", "Kalshi: a post-only order rests on the book as a maker: one that must fill at once never rests, so Kalshi would cancel it at once"]);
    expect(await said({ side: "buy", type: "market", limitPrice: undefined, reduceOnly: true })).toEqual(["E_VENUE_ORDER_INVALID", "Kalshi: reduce-only at Kalshi is a sell of contracts held: a buy of KXFED-27APR-T4.00:YES only opens or grows a position in it (KXFED-27APR-T4.00:NO held is reduced by selling it)"]);
    for (const o of [{ reduceOnly: true }, { reduceOnly: true, tif: "gtc" }, { reduceOnly: true, tif: "fok" }, { reduceOnly: true, tif: "day" }, { type: "market", limitPrice: undefined, reduceOnly: true, tif: "fok" }]) {
      expect(await said(o)).toEqual(["E_VENUE_ORDER_INVALID", "Kalshi: Kalshi takes reduce-only only on an order that fills at once (immediate-or-cancel): a market sell, or a limit sell with ioc"]);
    }
    expect((await said({ tif: "gtd" }))[1]).toBe('Kalshi: Kalshi takes good-till-canceled, immediate-or-cancel, fill-or-kill and day orders, not "gtd"');
    // four seconds before 11:59:59pm ET: a day order would end before it rested
    k.now = DAY_END * 1000 - 4000;
    const late = refusal(await t.place({ ...sell, side: "buy", tif: "day" }));
    expect([late.code, late.message, late.detail]).toEqual(["E_VENUE_ORDER_INVALID", "Kalshi: a day order at Kalshi ends at 11:59:59pm ET, seconds from now: it would end before it rested. Send it good-till-canceled, or after midnight ET", { expiresAt: DAY_END }]);
    expect(posts(k)).toEqual([]);
  });

  it("a day order ends at 23:59:59 in New York, the last whole second of Kalshi's own day (11:59:59.999pm ET) — on the nights the clocks change too", () => {
    const end = (iso: string) => new Date(kalshiDayEnd(Date.parse(iso)) * 1000).toISOString();
    expect(end("2026-10-05T14:00:00Z")).toBe("2026-10-06T03:59:59.000Z"); // 10:00 EDT
    expect(end("2026-10-06T03:59:58.500Z")).toBe("2026-10-06T03:59:59.000Z"); // 23:59:58.5 EDT, still that day
    expect(end("2026-10-06T04:00:00Z")).toBe("2026-10-07T03:59:59.000Z"); // midnight EDT: the next day's
    expect(end("2026-12-15T20:00:00Z")).toBe("2026-12-16T04:59:59.000Z"); // 15:00 EST
    // 1 November 2026, 01:30 EDT: the clocks go back at 02:00, and the day ends at 23:59:59 EST
    expect(end("2026-11-01T05:30:00Z")).toBe("2026-11-02T04:59:59.000Z");
    // 14 March 2027, 01:30 EST: the clocks go forward at 02:00, and the day ends at 23:59:59 EDT
    expect(end("2027-03-14T06:30:00Z")).toBe("2027-03-15T03:59:59.000Z");
  });
});

/** a stand-in order that rests at Kalshi and takes amends as Kalshi does: the price and the whole size (filled + resting) are set, not added */
function amendable(start: Rec, more: (s: Sent) => HttpReply | undefined = () => undefined) {
  const box = { live: order(start) };
  const routes = (s: Sent): HttpReply | undefined => {
    const custom = more(s);
    if (custom) return custom;
    if (s.path === `/portfolio/orders/${ORDER}`) return json({ order: box.live });
    if (s.method === "POST" && s.path === `/portfolio/events/orders/${ORDER}/amend`) {
      const b = s.body as Rec;
      const rest = (Number(b.count) - Number(box.live.fill_count_fp)).toFixed(2);
      const resized = rest !== box.live.remaining_count_fp;
      box.live = { ...box.live, yes_price_dollars: Number(b.price).toFixed(6), no_price_dollars: (1 - Number(b.price)).toFixed(6), remaining_count_fp: rest };
      return json({ order_id: ORDER, client_order_id: "ord-0001", ...(resized ? { remaining_count: rest } : {}), ts_ms: START });
    }
    if (s.path === "/portfolio/fills") return json({ fills: [{ count_fp: box.live.fill_count_fp, yes_price_dollars: "0.4000", no_price_dollars: "0.6000", fee_cost: "0.040000" }] });
    return undefined;
  };
  return { box, routes };
}
/** a YES bid of 10 at 0.40, 4 filled and 6 resting, its price as a portfolio answer carries it: six decimals */
const RESTING: Rec = { yes_price_dollars: "0.400000", no_price_dollars: "0.600000", initial_count_fp: "10.00", fill_count_fp: "4.00", remaining_count_fp: "6.00" };
const PLACED: OrderRequest = { symbol: FED_YES, side: "buy", type: "limit", qty: 10, limitPrice: 0.4, clientId: "ord-0001" };

describe("amend(): a resting order changed in place", () => {
  it("a new limit: POST …/amend with the order's whole terms — ticker, side, price, and its count as Kalshi has it (filled + resting) — signed over its path; then the order as it stands", async () => {
    const a = amendable(RESTING);
    const k = fakeKalshi({ routes: a.routes });
    const { t } = await connect(k);
    market(await t.market(FED_YES));
    const n = k.sent.length;
    const s = state(await t.amend!(ORDER, FED_YES, { limitPrice: 0.41 }, PLACED));
    // the look the account just took is the one the change is checked against: then the order, the amend, the order again and its fills
    expect(k.since(n)).toEqual([`GET /portfolio/orders/${ORDER}`, `POST /portfolio/events/orders/${ORDER}/amend`, `GET /portfolio/orders/${ORDER}`, "GET /portfolio/fills"]);
    const p = posts(k)[0]!;
    expect([p.url, p.raw]).toEqual([`${BASE}/portfolio/events/orders/${ORDER}/amend`, JSON.stringify({ ticker: "KXFED-27APR-T4.00", side: "bid", price: "0.4100", count: "10.00" })]);
    expect(p.headers).toEqual({ "KALSHI-ACCESS-KEY": KEY_ID, "KALSHI-ACCESS-TIMESTAMP": String(START), "KALSHI-ACCESS-SIGNATURE": kalshiSign(k.privateKey, START, "POST", `/trade-api/v2/portfolio/events/orders/${ORDER}/amend`), accept: "application/json", "Content-Type": "application/json" });
    expect([s.ref, s.status, s.filledQty, s.avgPrice, s.feeUsd]).toEqual([ORDER, "partial", 4, 0.4, 0]);
    expect(s.native).toEqual({ amend: { order_id: ORDER, client_order_id: "ord-0001", ts_ms: START }, order: a.box.live });
    expect((s.native as { order: Rec }).order.yes_price_dollars).toBe("0.410000");
  });

  it("a new size is the order's whole size, filled and resting, as Kalshi's count is; an unchanged price goes back as it rests, in four decimals; a NO order's limit goes as YES's", async () => {
    const a = amendable(RESTING);
    const k = fakeKalshi({ routes: a.routes });
    const { t } = await connect(k);
    // 4 filled and 6 resting; 8 in all leaves 4 resting — and a smaller size keeps the order's place in the queue
    state(await t.amend!(ORDER, FED_YES, { qty: 8 }, PLACED));
    expect(body(posts(k).at(-1)!)).toEqual({ ticker: "KXFED-27APR-T4.00", side: "bid", price: "0.4000", count: "8.00" });
    expect(a.box.live.remaining_count_fp).toBe("4.00");
    state(await t.amend!(ORDER, FED_YES, { qty: 12, limitPrice: 0.39 }, PLACED));
    expect(body(posts(k).at(-1)!)).toEqual({ ticker: "KXFED-27APR-T4.00", side: "bid", price: "0.3900", count: "12.00" });
    // buying NO at 0.58 rests as an ask on YES at 0.42: its new limit, 0.57, goes as 0.43
    a.box.live = order({ ...RESTING, book_side: "ask", outcome_side: "no", yes_price_dollars: "0.420000", no_price_dollars: "0.580000" });
    state(await t.amend!(ORDER, FED_NO, { limitPrice: 0.57 }, { ...PLACED, symbol: FED_NO, limitPrice: 0.58 }));
    expect(body(posts(k).at(-1)!)).toEqual({ ticker: "KXFED-27APR-T4.00", side: "ask", price: "0.4300", count: "10.00" });
  });

  it("refused here, before anything is sent: a stop to change, nothing to change, a size off 0.01 or down to what has filled, a price off the grid, an order no longer resting, one that is not the order it is said to be, an id Kalshi does not have, a key that may not trade, a closed market — and a change to what already is sends nothing", async () => {
    let closed = false;
    const a = amendable(RESTING, (s) => (closed && s.path === `/markets/${String(FED.ticker)}` ? json({ market: { ...FED, status: "closed" } }) : s.path === "/portfolio/orders/nope" ? notFound() : undefined));
    const k = fakeKalshi({ routes: a.routes });
    const { t } = await connect(k);
    const said = async (change: Rec, placed: OrderRequest = PLACED, ref = ORDER, symbol = placed.symbol) => {
      const r = refusal(await t.amend!(ref, symbol, change, placed));
      return [r.code, r.message];
    };
    expect(await said({ stopPrice: 0.3 })).toEqual(["E_VENUE_ORDER_INVALID", "Kalshi: Kalshi has no stop orders on event contracts: there is no stop price to change"]);
    expect(await said({})).toEqual(["E_ACCOUNT_BAD_ACTION", "a change to an order at Kalshi is a new size, a new limit, or both: neither was given"]);
    expect(await said({ qty: 7.125 })).toEqual(["E_VENUE_ORDER_INVALID", "Kalshi: a count at Kalshi is in steps of 0.01 contracts, at least 0.01"]);
    expect(await said({ limitPrice: 0.405 })).toEqual(["E_VENUE_ORDER_INVALID", `Kalshi: a price in ${String(FED.title)} (Above 4.00%) · Yes moves in steps of 0.01 between 0 and 1`]);
    expect(await said({ qty: 4 })).toEqual(["E_VENUE_ORDER_INVALID", "Kalshi: 4 of this order has filled already: its size can come down to more than that, not to 4. To stop the rest, cancel it"]);
    // the order is a bid on YES: it is not a sell of YES, and not an order on another market
    expect(await said({ limitPrice: 0.41 }, { ...PLACED, side: "sell" })).toEqual(["E_VENUE_REJECTED", `Kalshi's order ${ORDER} is a bid on KXFED-27APR-T4.00, not the sell of KXFED-27APR-T4.00:YES it was taken for: nothing was changed`]);
    expect((await said({ limitPrice: 0.41 }, { ...PLACED, symbol: "KXGREENLAND-29:YES" }))[0]).toBe("E_VENUE_REJECTED");
    expect((await said({ limitPrice: 0.41 }, PLACED, "nope"))[0]).toBe("E_ACCOUNT_ORDER_UNKNOWN");
    a.box.live = order({ ...RESTING, status: "executed", fill_count_fp: "10.00", remaining_count_fp: "0.00" });
    expect(await said({ limitPrice: 0.41 })).toEqual(["E_VENUE_REJECTED", "Kalshi: the order is no longer on the book (filled, 10 filled): there is nothing to change"]);
    a.box.live = order(RESTING);
    // already so: the order as it stands, and nothing sent
    const n = k.sent.length;
    const same = state(await t.amend!(ORDER, FED_YES, { qty: 10, limitPrice: 0.4 }, PLACED));
    expect([same.status, same.filledQty, k.since(n)]).toEqual(["partial", 4, [`GET /portfolio/orders/${ORDER}`, "GET /portfolio/fills"]]);
    closed = true;
    k.now += 60_000;
    expect((await said({ limitPrice: 0.41 }))[0]).toBe("E_VENUE_MARKET_CLOSED");
    expect(posts(k)).toEqual([]);
    const readOnly = fakeKalshi({ scopes: ["read"], routes: amendable(RESTING).routes });
    const r = refusal(await (await connect(readOnly)).t.amend!(ORDER, FED_YES, { limitPrice: 0.41 }, PLACED));
    expect([r.code, posts(readOnly)]).toEqual(["E_VENUE_PERMISSION", []]);
  });

  it("a sell made bigger must have the more free to sell, as a new sell does: what is held, less what already rests on that side — this order's own rest among it", async () => {
    // 10 YES held; this ask rests 6 and another rests 2, so 2 more are free; a resting bid sells no YES
    const a = amendable({ book_side: "ask", outcome_side: "no", yes_price_dollars: "0.500000", no_price_dollars: "0.500000", initial_count_fp: "6.00", fill_count_fp: "0.00", remaining_count_fp: "6.00" }, (s) => {
      if (s.path === "/portfolio/positions") return json({ market_positions: [{ ticker: FED.ticker, position_fp: "10.00" }] });
      if (s.path === "/portfolio/orders") return json({ orders: [a.box.live, order({ order_id: "other", book_side: "ask", remaining_count_fp: "2.00" }), order({ order_id: "a-bid", book_side: "bid", remaining_count_fp: "50.00" })], cursor: "" });
      return undefined;
    });
    const k = fakeKalshi({ routes: a.routes });
    const { t } = await connect(k);
    const sell: OrderRequest = { symbol: FED_YES, side: "sell", type: "limit", qty: 6, limitPrice: 0.5, clientId: "c1" };
    const over = refusal(await t.amend!(ORDER, FED_YES, { qty: 9 }, sell));
    expect([over.code, over.message, over.detail]).toEqual(["E_VENUE_INSUFFICIENT", "Kalshi: you hold 10 KXFED-27APR-T4.00:YES, and orders resting on Kalshi's book, this one among them, already sell 8 of it: 2 more is free to sell, fewer than the 3 more asked. A sell here is of what is held: selling more at Kalshi would buy the other side", { held: 10, resting: 8, more: 3 }]);
    expect(posts(k)).toEqual([]);
    state(await t.amend!(ORDER, FED_YES, { qty: 8 }, sell));
    expect(body(posts(k)[0]!)).toEqual({ ticker: "KXFED-27APR-T4.00", side: "ask", price: "0.5000", count: "8.00" });
    // smaller, or at a new price, it sells no more: nothing held is read
    const n = k.sent.length;
    state(await t.amend!(ORDER, FED_YES, { qty: 5, limitPrice: 0.52 }, sell));
    expect(k.since(n)).toEqual([`GET /portfolio/orders/${ORDER}`, `POST /portfolio/events/orders/${ORDER}/amend`, `GET /portfolio/orders/${ORDER}`]);
  });

  it("Kalshi's answer: a 404 (filled or canceled since it was read) is said with the order as it is; a 400 is Kalshi's own no; no answer, or a 5xx, is read back — the change made if the order shows it, unknown if not", async () => {
    const said = async (more: (s: Sent, a: ReturnType<typeof amendable>) => HttpReply | undefined, throwOn?: (s: Sent, a: ReturnType<typeof amendable>) => boolean) => {
      const box: { a?: ReturnType<typeof amendable> } = {};
      box.a = amendable(RESTING, (s) => more(s, box.a!));
      const k = fakeKalshi({ routes: box.a.routes, ...(throwOn ? { throwOn: (s: Sent) => throwOn(s, box.a!) } : {}) });
      const r = await (await connect(k)).t.amend!(ORDER, FED_YES, { limitPrice: 0.41 }, PLACED);
      return { r, a: box.a, k };
    };
    const amending = (s: Sent) => s.method === "POST" && s.path.endsWith("/amend");
    const gone = refusal(
      (
        await said((s, a) => {
          if (!amending(s)) return undefined;
          a.box.live = order({ ...RESTING, status: "executed", fill_count_fp: "10.00", remaining_count_fp: "0.00" });
          return notFound();
        })
      ).r,
    );
    expect([gone.code, gone.message]).toEqual(["E_VENUE_REJECTED", "Kalshi did not take the change (HTTP 404): the order is filled now, 10 filled"]);
    const poor = refusal((await said((s) => (amending(s) ? json({ error: { code: "available_balance_too_low", message: "Insufficient available balance for the order" } }, 400) : undefined))).r);
    expect([poor.code, poor.message]).toEqual(["E_VENUE_INSUFFICIENT", "Kalshi: not enough cash for this order on the exchange shard its market trades on (shard 0). An order sent through Kalshi's API counts only the cash already on that shard"]);
    // no answer, but Kalshi made the change: the order shows it, and that is the answer
    const made = await said(
      () => undefined,
      (s, a) => {
        if (!amending(s)) return false;
        a.box.live = { ...a.box.live, yes_price_dollars: "0.410000", no_price_dollars: "0.590000" };
        return true;
      },
    );
    expect([state(made.r).ref, (state(made.r).native as Rec).yes_price_dollars]).toEqual([ORDER, "0.410000"]);
    // no answer and no change on the order: unknown, never "not changed"
    const lost = refusal((await said(() => undefined, (s) => amending(s))).r);
    expect([lost.code, lost.message, lost.detail]).toEqual(["E_VENUE_UNREACHABLE", "Kalshi did not answer the change, and the order does not show the change yet: it may have been made all the same. Read the order before changing it again (sent again, the same change is the same change)", { ref: ORDER, changed: "unknown" }]);
    const five = refusal((await said((s) => (amending(s) ? json({ error: { code: "service_unavailable", message: "unavailable" } }, 503) : undefined))).r);
    expect([five.code, five.message.startsWith("Kalshi answered the change with HTTP 503, and the order does not show the change yet")]).toEqual(["E_VENUE_UNREACHABLE", true]);
  });
});

describe("positions(): what is held at Kalshi", () => {
  /** decided NO, waiting to settle: its last trade is no longer what a contract is worth */
  const DECIDED: Rec = { ...FED, ticker: "KXFED-26SEP-T4.00", status: "determined", result: "no", yes_bid_dollars: "0.0000", yes_ask_dollars: "1.0000", no_bid_dollars: "0.0000", no_ask_dollars: "1.0000", last_price_dollars: "0.0300" };
  const ROW = { exchange_index: 0, realized_pnl_dollars: "0.000000", total_traded_dollars: "10.500000", fees_paid_dollars: "0.180000", last_updated_ts: "2026-10-05T13:00:00Z" };

  it("each market's netted position as the outcome held — YES above zero, NO below — at what it cost, named and priced by its market; flat rows left out; a page at a time", async () => {
    const k = fakeKalshi({
      routes: (s) => {
        if (s.path === "/portfolio/positions" && s.query.count_filter === "position") {
          return s.query.cursor === "p2"
            ? json({ market_positions: [{ ...ROW, ticker: "KXFED-26SEP-T4.00", position_fp: "-40.00", market_exposure_dollars: "24.000000" }], event_positions: [], cursor: "" })
            : json({ market_positions: [{ ...ROW, ticker: FED.ticker, position_fp: "25.00", market_exposure_dollars: "10.500000" }, { ...ROW, ticker: "KXFLAT-26OCT", position_fp: "0.00", market_exposure_dollars: "0.000000" }, { ...ROW, ticker: "KXGONE-26OCT", position_fp: "3.00", market_exposure_dollars: "1.200000" }], event_positions: [], cursor: "p2" });
        }
        if (s.path === "/markets" && s.query.tickers) return json({ markets: [FED, DECIDED].filter((m) => s.query.tickers!.split(",").includes(String(m.ticker))), cursor: "" });
        return undefined;
      },
    });
    const { t } = await connect(k);
    const n = k.sent.length;
    const held = await t.positions!();
    if (isRefusal(held)) throw new Error(held.message);
    expect(k.sent.slice(n).map((s) => [s.path, s.query])).toEqual([
      ["/portfolio/positions", { count_filter: "position", limit: "200" }],
      ["/portfolio/positions", { count_filter: "position", limit: "200", cursor: "p2" }],
      ["/markets", { tickers: "KXFED-27APR-T4.00,KXGONE-26OCT,KXFED-26SEP-T4.00", limit: "3" }],
    ]);
    const words = `${String(FED.title)} (Above 4.00%)`;
    expect(held.map(({ native: _, ...p }) => p)).toEqual([
      { symbol: FED_YES, name: `${words} · Yes`, kind: "event", side: "long", qty: 25, entryPrice: 0.42, markPrice: 0.43, usd: 10.75, unrealizedUsd: 0.25 },
      // a market the lookup did not return: named by its ticker, at what it cost, and no price
      { symbol: "KXGONE-26OCT:YES", name: "KXGONE-26OCT · Yes", kind: "event", side: "long", qty: 3, entryPrice: 0.4 },
      // NO held where the result is no: a dollar a contract, whatever the last trade
      { symbol: "KXFED-26SEP-T4.00:NO", name: `${words} · No`, kind: "event", side: "long", qty: 40, entryPrice: 0.6, markPrice: 1, usd: 40, unrealizedUsd: 16 },
    ] satisfies Array<Omit<Position, "native">>);
    expect(held[0]!.native).toEqual({ ...ROW, ticker: FED.ticker, position_fp: "25.00", market_exposure_dollars: "10.500000" });
  });

  it("Kalshi not answering for the positions is its no; markets that cannot be read leave the positions named by ticker, at cost, unpriced", async () => {
    let down = false;
    const k = fakeKalshi({
      routes: (s) => {
        if (s.path === "/portfolio/positions" && s.query.count_filter === "position") return down ? json({ error: { code: "service_unavailable", message: "unavailable" } }, 503) : json({ market_positions: [{ ...ROW, ticker: FED.ticker, position_fp: "-2.00", market_exposure_dollars: "1.160000" }], cursor: "" });
        if (s.path === "/markets") return json({ error: { code: "service_unavailable", message: "unavailable" } }, 503);
        return undefined;
      },
    });
    const { t } = await connect(k);
    expect(await t.positions!()).toEqual([{ symbol: FED_NO, name: "KXFED-27APR-T4.00 · No", kind: "event", side: "long", qty: 2, entryPrice: 0.58, native: { ...ROW, ticker: FED.ticker, position_fp: "-2.00", market_exposure_dollars: "1.160000" } }]);
    down = true;
    expect(refusal(await t.positions!()).code).toBe("E_VENUE_UNREACHABLE");
  });

  it("the trader changes a resting order and lists what is held; it has no close of its own (a position closes with a reduce-only sell) and no leverage to set", async () => {
    const { t } = await connect(fakeKalshi());
    expect([typeof t.amend, typeof t.positions, t.close, t.setLeverage]).toEqual(["function", "function", undefined, undefined]);
  });
});

