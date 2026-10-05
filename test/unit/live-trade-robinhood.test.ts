import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isRefusal, type Refusal } from "../../src/core/errors.ts";
import { READ_TOOLS, robinhoodCryptoSource, robinhoodKey, robinhoodSign, robinhoodStocksSource, uuidFrom, type McpSession, type McpTool, type OpenMcp } from "../../src/portfolio/live/robinhood.ts";
import type { LiveTrader, Market, OrderState } from "../../src/portfolio/live/trade.ts";
import type { Http, HttpReply, LiveSource } from "../../src/portfolio/live/types.ts";

/** Robinhood's two trading interfaces — its Crypto Trading API and its Trading MCP server — against stand-ins that remember every request.
 * Nothing here leaves the process. The key pair the orders are signed with is made for this file and is nobody's; the API key and the
 * account numbers are made up. The one other key pair is the example Robinhood's own docs publish. */
const START = Date.parse("2026-10-05T14:00:00.000Z");
const TS = String(Math.floor(START / 1000));
const BASE = "https://trading.robinhood.com";

const pair = generateKeyPairSync("ed25519");
const KEY = { apiKey: "rh-api-00000000-0000-4000-8000-00000000c0de", privateKey: pair.privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32).toString("base64") };

const json = (body: unknown, status = 200): HttpReply => ({ status, body, text: JSON.stringify(body) });
const text = (t: string, status: number): HttpReply => ({ status, body: undefined, text: t });
type Asked = { url: string; method: string; headers: Record<string, string>; body?: string | undefined };

/** a network that answers only what the test routes, and remembers every request */
function net(route: (a: Asked, u: URL) => HttpReply | undefined): Http & { asked: Asked[] } {
  const asked: Asked[] = [];
  const http = (async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const a: Asked = { url, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body };
    asked.push(a);
    return route(a, new URL(url)) ?? { status: 599, body: undefined, text: "no network in tests" };
  }) as Http & { asked: Asked[] };
  http.asked = asked;
  return http;
}

const refusal = (o: unknown): Refusal => {
  if (!isRefusal(o)) throw new Error(`expected a refusal, got ${JSON.stringify(o).slice(0, 300)}`);
  return o;
};
function ok<T>(o: T | Refusal): T {
  if (isRefusal(o)) throw new Error(`expected an answer, got ${o.code}: ${o.message}`);
  return o;
}

// ---- Robinhood Crypto -------------------------------------------------------------------------

const ACCOUNT = "5512340009";
const ACCOUNTS = { results: [{ account_number: ACCOUNT, status: "active", buying_power: "1000.00", buying_power_currency: "USD", account_type: "individual", is_api_tradable: true, fee_tier_status: { fee_ratio: 0.0085, thirty_day_volume: "0" } }], next: null, previous: null };
const pairOf = (symbol: string, o: Record<string, unknown> = {}) => {
  const [asset, quote] = symbol.split("-");
  return { symbol, asset_code: asset, quote_code: quote, asset_increment: "0.00000001", quote_increment: "0.01", max_order_size: "20", min_order_amount: "1.00", status: "tradable", is_api_tradable: true, ...o };
};
const PAIRS = [
  pairOf("AAVE-USD", { asset_increment: "0.0001" }),
  pairOf("BTC-USD"),
  pairOf("DOGE-USD", { asset_increment: "1", quote_increment: "0.000001" }),
  pairOf("ETH-USD", { asset_increment: "0.0001" }),
  pairOf("ETH-BTC", { quote_code: "BTC" }),
  pairOf("LTC-USD", { status: "untradable" }),
  pairOf("SHIB-USD", { status: "sellonly", asset_increment: "1", quote_increment: "0.00000001" }),
  pairOf("SOL-USD", { asset_increment: "0.0001" }),
  pairOf("XLM-USD", { is_api_tradable: false }),
  ...Array.from({ length: 25 }, (_, i) => pairOf(`Z${String(i).padStart(2, "0")}-USD`)),
];
const BOOK: Record<string, { bid: number; ask: number }> = { "BTC-USD": { bid: 61990, ask: 62010 }, "ETH-USD": { bid: 2499, ask: 2501 }, "SOL-USD": { bid: 150, ask: 150.2 }, "DOGE-USD": { bid: 0.12, ask: 0.1202 }, "SHIB-USD": { bid: 0.00001, ask: 0.000011 } };
const ORDER_ID = "0e5b6c2a-1f3d-4e7a-9b8c-2d4f6a8b0c1e";

/** an order as Robinhood's V2CryptoOrder has it */
const v2Order = (o: Record<string, unknown> = {}) => ({ id: ORDER_ID, account_number: ACCOUNT, symbol: "BTC-USD", client_order_id: uuidFrom(`${BASE}/${ACCOUNT}/ord-0001`), side: "buy", type: "market", state: "open", average_price: null, filled_asset_quantity: 0, executions: [], created_at: "2026-10-05T14:00:01Z", updated_at: "2026-10-05T14:00:01Z", market_order_config: { asset_quantity: 0.00012 }, fee_charged: 0, estimated_fee_remaining: 0.06, ...o });

/** Robinhood's crypto API as far as reading and pricing go; what it says to an order is the test's */
function robinhood(orders: (a: Asked, u: URL) => HttpReply | undefined = () => undefined) {
  return net((a, u) => {
    if (u.host !== "trading.robinhood.com") return undefined;
    const path = u.pathname;
    if (a.method === "GET" && path === "/api/v2/crypto/trading/accounts/") return json(ACCOUNTS);
    if (a.method === "GET" && path === "/api/v2/crypto/trading/holdings/") return json({ results: [], next: null });
    if (a.method === "GET" && path === "/api/v2/crypto/trading/trading_pairs/") {
      const want = u.searchParams.getAll("symbol");
      return json({ results: want.length ? PAIRS.filter((p) => want.includes(p.symbol)) : PAIRS, next: null });
    }
    if (a.method === "GET" && path === "/api/v2/crypto/marketdata/best_bid_ask/") return json({ results: u.searchParams.getAll("symbol").filter((s) => BOOK[s]).map((s) => ({ symbol: s, ...BOOK[s] })) });
    return orders(a, u);
  });
}

async function crypto(http: Http, clock: () => number = () => START): Promise<{ source: LiveSource; trader: LiveTrader }> {
  const opened = ok(await robinhoodCryptoSource({ venue: "robinhood-crypto", label: "", reference: "credentials/robinhood-crypto/api-key.json", key: KEY, http, clock }));
  return { source: opened.source, trader: opened.source.trader! };
}

/** the path a request was signed with: everything after the host, query and all, exactly as sent */
const pathOf = (a: Asked) => a.url.slice(BASE.length);
/** Ed25519 over api key + timestamp + path with its query + method + body, checked with the public half of the throwaway key */
const signedRight = (a: Asked) => verify(null, Buffer.from(`${KEY.apiKey}${a.headers["x-timestamp"]}${pathOf(a)}${a.method}${a.body ?? ""}`), pair.publicKey, Buffer.from(a.headers["x-signature"] ?? "", "base64"));
const writes = (http: { asked: Asked[] }) => http.asked.filter((a) => a.method !== "GET");

describe("Robinhood Crypto: the signature, and the order's own id", () => {
  // docs.robinhood.com/crypto/trading, "Headers and Signature": the published example key pair, request and signature
  const DOC = { privateKey: "xQnTJVeQLmw1/Mg2YimEViSpw/SdJcgNXZ5kQkAXNPU=", apiKey: "rh-api-6148effc-c0b1-486c-8940-a1d099456be6", timestamp: "1698708981" };

  it("signs as Robinhood's docs do: the published example, and the compact bodies an order sends, byte for byte", () => {
    const key = robinhoodKey(DOC.privateKey)!;
    // the docs' Python example signs its body as Python prints the dict: its published signature comes out of that string
    const docBody = "{'client_order_id': '131de903-5a9c-4260-abc1-28d562a5dcf0', 'side': 'buy', 'symbol': 'BTC-USD', 'type': 'market', 'market_order_config': {'asset_quantity': '0.1'}}";
    expect(robinhoodSign(key, DOC.apiKey, DOC.timestamp, "/api/v1/crypto/trading/orders/", "POST", docBody)).toBe("q/nEtxp/P2Or3hph3KejBqnw5o9qeuQ+hYRnB56FaHbjDsNUY9KhB1asMxohDnzdVFSD7StaTqjSd9U9HvaRAw==");
    // the same key and time over the requests this connection sends (computed from the docs' example key with the algorithm that gives the
    // docs' own signature): a v2 limit buy, a v2 market sell, one order, a cancel with no body
    const vectors: Array<[string, string, string, string]> = [
      ["POST", `/api/v2/crypto/trading/orders/?account_number=${ACCOUNT}`, '{"client_order_id":"2f0b6a8e-6c1a-4d0e-9a57-0c3b8f1d9e21","side":"buy","type":"limit","symbol":"BTC-USD","limit_order_config":{"asset_quantity":"0.00012","limit_price":"60000.00","time_in_force":"gtc"}}', "fSod6XtiwDQBS2Ne5QOAQuW/DqKNEbPMP3ySQd9CLL+kLJgcALPTqVz24CrwlcPy1WnOs0hzu5LZsHlK6N6uBQ=="],
      ["POST", `/api/v2/crypto/trading/orders/?account_number=${ACCOUNT}`, '{"client_order_id":"7d4c1e0a-3b5f-4c6e-8a9d-1e2f3a4b5c6d","side":"sell","type":"market","symbol":"ETH-USD","market_order_config":{"asset_quantity":"0.0150"}}', "I+P9U7Upd4lIqqYuPXFFkxMmWpBBgvhsLYqI3iNNIotZuRT4OgHGpVtCkZetPrZ5L9djYtF07o273Gh/jATGAg=="],
      ["GET", `/api/v2/crypto/trading/orders/${ORDER_ID}/?account_number=${ACCOUNT}`, "", "P9MWv4U1+vdUo8IOAg+gckpeXa6wpXNt7CGtjkRgMzuoH/yYcc+15AVoy9E0K5/siiQysKI/Kc3qjVWfLad3BQ=="],
      ["POST", `/api/v2/crypto/trading/orders/${ORDER_ID}/cancel/`, "", "reYanY3XBuEn9f36Rb9AWEvRY4Iumsn5fUUHBQUT2lfNdmVvNqcnlWyXUxmqE2zVyFwtQzGdGGiged/RwqD9BA=="],
    ];
    for (const [method, path, body, signature] of vectors) expect(robinhoodSign(key, DOC.apiKey, DOC.timestamp, path, method, body)).toBe(signature);
  });

  it("makes an order's UUID from its name as RFC 9562 version 5 does: the same id is the same order, another is another", () => {
    // Python: uuid.uuid5(uuid.NAMESPACE_URL, "https://trading.robinhood.com/5512340009/ord-0001")
    expect(uuidFrom(`${BASE}/${ACCOUNT}/ord-0001`)).toBe("12e88686-271a-55ba-b00f-10fcdbf9f022");
    expect(uuidFrom(`${BASE}/${ACCOUNT}/ord-0002`)).not.toBe(uuidFrom(`${BASE}/${ACCOUNT}/ord-0001`));
  });
});

describe("Robinhood Crypto: orders through its own API", () => {
  it("the connection carries a trader: crypto, and whether the key may place orders is Robinhood's to say on the first one", async () => {
    const http = robinhood();
    const { source, trader } = await crypto(http);
    expect([trader.can, trader.what, source.noTradeBecause]).toEqual(["unknown", "crypto", undefined]);
    expect(source.readOnlyBecause).toBe("Robinhood's crypto API reads and trades; it has no call that moves money in or out: deposits and withdrawals are made in Robinhood's app");
    expect(source.probe.note).toContain('"Place crypto orders with fee tiers" places orders');
    expect(source.probe.note).toContain("orders go to the account Robinhood trades through the API, ··0009");
    // connecting still only reads
    expect(http.asked.map((a) => `${a.method} ${new URL(a.url).pathname}`)).toEqual(["GET /api/v2/crypto/trading/accounts/", "GET /api/v2/crypto/trading/holdings/"]);
  });

  it("market(): the pair's increments and smallest order in dollars, the best bid and ask, open every day", async () => {
    const http = robinhood();
    const { trader } = await crypto(http);
    http.asked.length = 0;
    const m = ok(await trader.market("btc/usd"));
    expect(m).toEqual({ symbol: "BTC-USD", name: "BTC / USD", kind: "crypto", base: "BTC", quote: "USD", price: 62000, bid: 61990, ask: 62010, qtyStep: 0.00000001, priceStep: 0.01, minNotional: 1, open: true, note: "Robinhood's fee is 0.85% of each order at this account's fee tier · at most 20 BTC an order · a market order goes as a limit at its worst price, good till canceled: what does not fill at once waits on the book · crypto trades every day, all day", types: ["market", "limit"] } satisfies Market);
    expect(http.asked.map((a) => a.url)).toEqual([`${BASE}/api/v2/crypto/trading/trading_pairs/?symbol=BTC-USD`, `${BASE}/api/v2/crypto/marketdata/best_bid_ask/?symbol=BTC-USD`]);
    expect(http.asked.every((a) => a.method === "GET" && a.headers["x-api-key"] === KEY.apiKey && a.headers["x-timestamp"] === TS && signedRight(a))).toBe(true);
    // the pair's rules are kept five minutes; the price is asked every time
    http.asked.length = 0;
    expect(ok(await trader.market("BTC")).symbol).toBe("BTC-USD");
    expect(http.asked.map((a) => new URL(a.url).pathname)).toEqual(["/api/v2/crypto/marketdata/best_bid_ask/"]);

    // a pair the API does not trade, one Robinhood lists as untradable, one it takes only sells in
    const xlm = ok(await trader.market("XLM-USD"));
    expect([xlm.open, xlm.note, xlm.price]).toEqual([false, "Robinhood takes no API orders in XLM-USD (it is not marked is_api_tradable)", undefined]);
    expect([ok(await trader.market("LTC-USD")).open, ok(await trader.market("LTC-USD")).note]).toEqual([false, "Robinhood lists LTC-USD as untradable now"]);
    const shib = ok(await trader.market("SHIB-USD"));
    expect([shib.open, shib.note!.startsWith("Robinhood takes only sells in SHIB-USD now")]).toEqual([true, true]);
    expect(refusal(await trader.place({ symbol: "SHIB-USD", side: "buy", type: "market", qty: 100, clientId: "ord-0009" })).code).toBe("E_VENUE_MARKET_CLOSED");

    // a pair priced in something other than dollars is not asked about at all; one Robinhood does not list is said
    http.asked.length = 0;
    expect(refusal(await trader.market("ETH-EUR")).code).toBe("E_ACCOUNT_UNPRICED");
    expect(http.asked).toEqual([]);
    const none = refusal(await trader.market("ZZZ-USD"));
    expect([none.code, none.message]).toEqual(["E_VENUE_ORDER_INVALID", "Robinhood Crypto: Robinhood lists no crypto pair ZZZ-USD"]);
    expect(writes(http)).toEqual([]);
  });

  it("place(): a market buy is one signed POST, signed over the body exactly as sent, with a client_order_id made from the account's id", async () => {
    const http = robinhood((a, u) => (a.method === "POST" && u.pathname === "/api/v2/crypto/trading/orders/" ? json(v2Order({ client_order_id: JSON.parse(a.body!).client_order_id }), 201) : undefined));
    const { trader } = await crypto(http);
    const placed = ok(await trader.place({ symbol: "BTC-USD", side: "buy", type: "market", qty: 0.00012, clientId: "ord-0001" }));
    const sent = writes(http);
    expect(sent).toHaveLength(1);
    const a = sent[0]!;
    expect([a.method, a.url]).toEqual(["POST", `${BASE}/api/v2/crypto/trading/orders/?account_number=${ACCOUNT}`]);
    expect(a.body).toBe('{"client_order_id":"12e88686-271a-55ba-b00f-10fcdbf9f022","side":"buy","type":"market","symbol":"BTC-USD","market_order_config":{"asset_quantity":"0.00012000"}}');
    expect([a.headers["x-api-key"], a.headers["x-timestamp"], a.headers["content-type"], a.headers.accept]).toEqual([KEY.apiKey, TS, "application/json", "application/json"]);
    expect(verify(null, Buffer.from(`${KEY.apiKey}${TS}/api/v2/crypto/trading/orders/?account_number=${ACCOUNT}POST${a.body}`), pair.publicKey, Buffer.from(a.headers["x-signature"]!, "base64"))).toBe(true);
    // what Robinhood answered, its account named by the last four digits
    expect([placed.ref, placed.status, placed.filledQty, placed.feeUsd, (placed.native as { account_number: string }).account_number]).toEqual([ORDER_ID, "open", 0, 0, "··0009"]);
    expect(JSON.stringify(placed)).not.toContain(ACCOUNT);
    // asked again with the same account id it is the same order; another id is another
    await trader.place({ symbol: "BTC-USD", side: "buy", type: "market", qty: 0.00012, clientId: "ord-0001" });
    await trader.place({ symbol: "BTC-USD", side: "buy", type: "market", qty: 0.00012, clientId: "ord-0002" });
    const ids = writes(http).map((x) => JSON.parse(x.body!).client_order_id);
    expect(ids).toEqual([ids[0], ids[0], uuidFrom(`${BASE}/${ACCOUNT}/ord-0002`)]);
  });

  it("place(): a market sell and a limit buy, each with the one config its type names, the amounts on the pair's increments", async () => {
    const echo = (a: Asked) => {
      const b = JSON.parse(a.body!);
      return json(v2Order({ client_order_id: b.client_order_id, symbol: b.symbol, side: b.side, type: b.type }), 201);
    };
    const http = robinhood((a, u) => (a.method === "POST" && u.pathname === "/api/v2/crypto/trading/orders/" ? echo(a) : undefined));
    const { trader } = await crypto(http);
    ok(await trader.place({ symbol: "ETH-USD", side: "sell", type: "market", qty: 0.015, clientId: "ord-0002" }));
    ok(await trader.place({ symbol: "BTC-USD", side: "buy", type: "limit", qty: 0.00012, limitPrice: 60000, clientId: "ord-0003" }));
    const [sell, limit] = writes(http);
    expect(sell!.body).toBe(`{"client_order_id":"${uuidFrom(`${BASE}/${ACCOUNT}/ord-0002`)}","side":"sell","type":"market","symbol":"ETH-USD","market_order_config":{"asset_quantity":"0.0150"}}`);
    expect(limit!.body).toBe(`{"client_order_id":"${uuidFrom(`${BASE}/${ACCOUNT}/ord-0003`)}","side":"buy","type":"limit","symbol":"BTC-USD","limit_order_config":{"asset_quantity":"0.00012000","limit_price":"60000.00","time_in_force":"gtc"}}`);
    expect(writes(http).every((a) => a.url === `${BASE}/api/v2/crypto/trading/orders/?account_number=${ACCOUNT}` && signedRight(a))).toBe(true);
    // off the pair's steps, or larger than its largest order: said here, nothing sent
    const before = writes(http).length;
    expect(refusal(await trader.place({ symbol: "ETH-USD", side: "sell", type: "market", qty: 0.01505, clientId: "ord-0004" })).message).toBe("Robinhood Crypto: a size in ETH-USD moves in steps of 0.0001 ETH");
    expect(refusal(await trader.place({ symbol: "BTC-USD", side: "buy", type: "market", qty: 21, clientId: "ord-0005" })).message).toBe("Robinhood Crypto: the largest order in BTC-USD is 20 BTC");
    expect(refusal(await trader.place({ symbol: "BTC-USD", side: "buy", type: "limit", qty: 0.001, limitPrice: 60000.005, clientId: "ord-0006" })).message).toBe("Robinhood Crypto: a limit price in BTC-USD moves in steps of 0.01");
    expect(writes(http).length).toBe(before);
  });

  it("place(): a market order with a worst price goes as a limit at it, a buy's rounded down and a sell's up, so it never fills past it", async () => {
    const echo = (a: Asked) => {
      const b = JSON.parse(a.body!);
      return json(v2Order({ client_order_id: b.client_order_id, symbol: b.symbol, side: b.side, type: b.type }), 201);
    };
    const http = robinhood((a, u) => (a.method === "POST" && u.pathname === "/api/v2/crypto/trading/orders/" ? echo(a) : undefined));
    const { trader } = await crypto(http);
    ok(await trader.place({ symbol: "BTC-USD", side: "buy", type: "market", qty: 0.00012, worstPrice: 63250.209, clientId: "ord-0010" }));
    ok(await trader.place({ symbol: "ETH-USD", side: "sell", type: "market", qty: 0.015, worstPrice: 2449.021, clientId: "ord-0011" }));
    const [buy, sell] = writes(http).map((a) => JSON.parse(a.body!));
    expect([buy.type, buy.limit_order_config, buy.market_order_config]).toEqual(["limit", { asset_quantity: "0.00012000", limit_price: "63250.20", time_in_force: "gtc" }, undefined]);
    expect([sell.type, sell.limit_order_config, sell.market_order_config]).toEqual(["limit", { asset_quantity: "0.0150", limit_price: "2449.03", time_in_force: "gtc" }, undefined]);
    expect(writes(http).every(signedRight)).toBe(true);
    // a worst price that is not one is said here
    expect(refusal(await trader.place({ symbol: "BTC-USD", side: "buy", type: "market", qty: 0.00012, worstPrice: 0, clientId: "ord-0012" })).code).toBe("E_VENUE_ORDER_INVALID");
    // nor is a worst price that bounds nothing, nor a limit price that is not a number
    expect(refusal(await trader.place({ symbol: "BTC-USD", side: "buy", type: "market", qty: 0.00012, worstPrice: Infinity, clientId: "ord-0018" })).code).toBe("E_VENUE_ORDER_INVALID");
    expect(refusal(await trader.place({ symbol: "BTC-USD", side: "buy", type: "limit", qty: 0.00012, limitPrice: Infinity, clientId: "ord-0019" })).code).toBe("E_VENUE_ORDER_INVALID");
    expect(writes(http)).toHaveLength(2);
    // on the finer grids of cheap coins too, and a worst price already on the grid stays where it is: never past it, never looser
    ok(await trader.place({ symbol: "DOGE-USD", side: "buy", type: "market", qty: 10, worstPrice: 0.12260499, clientId: "ord-0014" }));
    ok(await trader.place({ symbol: "SHIB-USD", side: "sell", type: "market", qty: 20, worstPrice: 0.000010700001, clientId: "ord-0015" }));
    ok(await trader.place({ symbol: "BTC-USD", side: "buy", type: "market", qty: 0.00012, worstPrice: 63250.2, clientId: "ord-0016" }));
    expect(writes(http).slice(2).map((a) => JSON.parse(a.body!).limit_order_config.limit_price)).toEqual(["0.122604", "0.00001071", "63250.20"]);
    // a buy's worst price under the pair's smallest price step cannot be held: not sent
    expect(refusal(await trader.place({ symbol: "BTC-USD", side: "buy", type: "market", qty: 0.00012, worstPrice: 0.004, clientId: "ord-0017" })).code).toBe("E_VENUE_ORDER_INVALID");
    expect(writes(http)).toHaveLength(5);
  });

  it("place(): a yes without an order in it is looked for, never read as a refusal", async () => {
    const http = robinhood((a, u) => {
      if (a.method === "POST") return text("", 201);
      if (a.method === "GET" && u.pathname === "/api/v2/crypto/trading/orders/") return json({ results: [v2Order({ client_order_id: uuidFrom(`${BASE}/${ACCOUNT}/ord-0013`) })], next: null });
      return undefined;
    });
    const { trader } = await crypto(http);
    expect(ok(await trader.place({ symbol: "BTC-USD", side: "buy", type: "market", qty: 0.00012, clientId: "ord-0013" }))).toMatchObject({ ref: ORDER_ID, status: "open" });
    expect(new URL(http.asked.at(-1)!.url).pathname).toBe("/api/v2/crypto/trading/orders/");
    expect(writes(http)).toHaveLength(1);
  });

  it("status(): every state Robinhood has, as the account's; a state it adds later is still working", async () => {
    let answer: Record<string, unknown> = v2Order();
    const http = robinhood((a, u) => (a.method === "GET" && u.pathname === `/api/v2/crypto/trading/orders/${ORDER_ID}/` ? json(answer) : undefined));
    const { trader } = await crypto(http);
    const seen = async (o: Record<string, unknown>): Promise<Omit<OrderState, "native">> => {
      answer = v2Order(o);
      const { native: _native, ...rest } = ok(await trader.status(ORDER_ID, "BTC-USD"));
      return rest;
    };
    expect(await seen({ state: "open" })).toEqual({ ref: ORDER_ID, status: "open", filledQty: 0, feeUsd: 0 });
    expect(await seen({ state: "open", filled_asset_quantity: 0.00005, average_price: 61999.5, fee_charged: 0.03 })).toEqual({ ref: ORDER_ID, status: "partial", filledQty: 0.00005, avgPrice: 61999.5, feeUsd: 0.03 });
    expect(await seen({ state: "partially_filled", filled_asset_quantity: 0.00005, average_price: 61999.5 })).toMatchObject({ status: "partial", filledQty: 0.00005 });
    expect(await seen({ state: "filled", filled_asset_quantity: 0.00012, average_price: 62005.12, fee_charged: 0.06 })).toEqual({ ref: ORDER_ID, status: "filled", filledQty: 0.00012, avgPrice: 62005.12, feeUsd: 0.06 });
    expect(await seen({ state: "canceled", filled_asset_quantity: 0.00004, average_price: 62000 })).toMatchObject({ status: "canceled", filledQty: 0.00004 });
    expect(await seen({ state: "failed" })).toMatchObject({ status: "rejected", filledQty: 0 });
    expect(await seen({ state: "pending" })).toMatchObject({ status: "pending" });
    expect(await seen({ state: "something_new" })).toMatchObject({ status: "pending" });
    const asked = http.asked.filter((a) => new URL(a.url).pathname.includes(ORDER_ID));
    expect(asked.every((a) => a.method === "GET" && a.url === `${BASE}/api/v2/crypto/trading/orders/${ORDER_ID}/?account_number=${ACCOUNT}` && signedRight(a))).toBe(true);
  });

  it("status(): where the one-order path is not there, the order list answers; an order in neither is unknown", async () => {
    let listed = [v2Order({ id: "11111111-2222-4333-8444-555555555555" }), v2Order({ state: "filled", filled_asset_quantity: 0.00012, average_price: 62001 })];
    const http = robinhood((a, u) => {
      if (u.pathname.startsWith("/api/v2/crypto/trading/orders/") && u.pathname !== "/api/v2/crypto/trading/orders/") return json({ type: "client_error", errors: [{ detail: "Not found.", attr: null }] }, 404);
      if (a.method === "GET" && u.pathname === "/api/v2/crypto/trading/orders/") return json({ results: listed, next: null });
      return undefined;
    });
    const { trader } = await crypto(http);
    expect(ok(await trader.status(ORDER_ID, "BTC-USD"))).toMatchObject({ ref: ORDER_ID, status: "filled", avgPrice: 62001 });
    expect(http.asked.at(-1)!.url).toBe(`${BASE}/api/v2/crypto/trading/orders/?account_number=${ACCOUNT}&symbol=BTC-USD`);
    listed = [];
    expect(refusal(await trader.status(ORDER_ID, "BTC-USD")).code).toBe("E_ACCOUNT_ORDER_UNKNOWN");
    // an id that is not Robinhood's shape is not put in a path
    const before = http.asked.length;
    expect(refusal(await trader.status("../accounts", "BTC-USD")).code).toBe("E_ACCOUNT_ORDER_UNKNOWN");
    expect(http.asked.length).toBe(before);
  });

  it("cancel(): a POST with no body, signed as an empty one; the order comes back as it stands", async () => {
    let plainText = false;
    const http = robinhood((a, u) => {
      if (a.method === "POST" && u.pathname === `/api/v2/crypto/trading/orders/${ORDER_ID}/cancel/`) return plainText ? text(`Cancel request was submitted for order ${ORDER_ID}`, 200) : json(v2Order({ state: "canceled" }));
      if (a.method === "GET" && u.pathname === `/api/v2/crypto/trading/orders/${ORDER_ID}/`) return json(v2Order({ state: "open" }));
      return undefined;
    });
    const { trader } = await crypto(http);
    expect(ok(await trader.cancel(ORDER_ID, "BTC-USD"))).toMatchObject({ ref: ORDER_ID, status: "canceled", filledQty: 0 });
    const a = writes(http)[0]!;
    expect([a.method, a.url, a.body, a.headers["content-type"]]).toEqual(["POST", `${BASE}/api/v2/crypto/trading/orders/${ORDER_ID}/cancel/`, undefined, undefined]);
    expect(verify(null, Buffer.from(`${KEY.apiKey}${TS}/api/v2/crypto/trading/orders/${ORDER_ID}/cancel/POST`), pair.publicKey, Buffer.from(a.headers["x-signature"]!, "base64"))).toBe(true);
    // an answer in text (as v1 gives) is followed by asking for the order
    plainText = true;
    expect(ok(await trader.cancel(ORDER_ID, "BTC-USD")).status).toBe("open");
    expect(http.asked.at(-1)!.url).toBe(`${BASE}/api/v2/crypto/trading/orders/${ORDER_ID}/?account_number=${ACCOUNT}`);
  });

  it("Robinhood's refusals come back in its own words, as what they mean, with nothing secret in them", async () => {
    let answer: HttpReply = json({}, 400);
    const http = robinhood((a, u) => (a.method === "POST" && u.pathname.startsWith("/api/v2/crypto/trading/orders/") ? answer : undefined));
    const { trader } = await crypto(http);
    const buy = () => trader.place({ symbol: "BTC-USD", side: "buy", type: "market", qty: 0.001, clientId: "ord-0007" });
    const said = async (r: HttpReply, cancel = false) => {
      answer = r;
      return refusal(cancel ? await trader.cancel(ORDER_ID, "BTC-USD") : await buy());
    };
    const poor = await said(json({ type: "validation_error", errors: [{ detail: "Insufficient buying power.", attr: "non_field_errors" }] }, 400));
    expect([poor.code, poor.native]).toEqual(["E_VENUE_INSUFFICIENT", { status: 400, said: "Insufficient buying power." }]);
    const size = await said(json({ type: "validation_error", errors: [{ detail: "Ensure this value is a multiple of 0.00000001.", attr: "asset_quantity" }] }, 400));
    expect([size.code, size.message]).toEqual(["E_VENUE_ORDER_INVALID", "Robinhood Crypto: asset_quantity: Ensure this value is a multiple of 0.00000001."]);
    const scope = await said(json({ type: "client_error", errors: [{ detail: "You do not have permission to perform this action.", attr: null }] }, 403));
    expect([scope.code, scope.message.includes('"Place crypto orders with fee tiers"')]).toEqual(["E_VENUE_PERMISSION", true]);
    const region = await said(json({ type: "client_error", errors: [{ detail: "Crypto trading is not available in your state.", attr: null }] }, 403));
    expect([region.code, region.message]).toEqual(["E_VENUE_GEOBLOCKED", "Robinhood Crypto does not take this from where the account is: that is Robinhood's own rule, and the account does not look for a way around it"]);
    expect((await said(json({ type: "client_error", errors: [{ detail: "Not found.", attr: null }] }, 404), true)).code).toBe("E_ACCOUNT_ORDER_UNKNOWN");
    // a cancel Robinhood refuses (the order is already done) is its refusal, not a bad order
    const late = await said(json({ type: "validation_error", errors: [{ detail: "Order has already been filled.", attr: "non_field_errors" }] }, 400), true);
    expect([late.code, late.native]).toEqual(["E_VENUE_REJECTED", { status: 400, said: "Order has already been filled." }]);
    expect((await said(json({ type: "client_error", errors: [{ detail: "Invalid API key", attr: null }] }, 401))).code).toBe("E_VENUE_UNAUTHORIZED");
    expect((await said(text("Request missing required headers. Required headers: x-api-key, x-signature, x-timestamp.", 400))).code).toBe("E_VENUE_UNAUTHORIZED");
    expect((await said(json({ type: "client_error", errors: [{ detail: "Request was throttled.", attr: null }] }, 429))).code).toBe("E_VENUE_UNREACHABLE");
    expect((await said(json({ type: "validation_error", errors: [{ detail: "Something else entirely.", attr: "non_field_errors" }] }, 409))).code).toBe("E_VENUE_REJECTED");
    // a key the venue repeats back never leaves this process
    const echoed = await said(json({ type: "client_error", errors: [{ detail: `Key ${KEY.apiKey} lacks permission`, attr: null }] }, 403));
    expect(JSON.stringify(echoed)).not.toContain(KEY.apiKey);
    expect((echoed.native as { said: string }).said).toBe("Key ••• lacks permission");
    expect(JSON.stringify(echoed)).not.toContain(KEY.privateKey);
    // a key repeated back across the point where Robinhood's words are cut short: redacted first, so not even its first half is kept
    const long = await said(json({ type: "client_error", errors: [{ detail: `${"x".repeat(205)} ${KEY.apiKey}`, attr: null }] }, 403));
    expect(JSON.stringify(long)).not.toContain(KEY.apiKey.slice(0, 9));
    expect((long.native as { said: string }).said.endsWith(" •••")).toBe(true);
  });

  it("an order sent without an answer is looked for by its client_order_id before anything is said, and never sent twice", async () => {
    let found = true;
    const http = robinhood((a, u) => {
      if (a.method === "POST") throw new Error("socket hang up");
      if (a.method === "GET" && u.pathname === "/api/v2/crypto/trading/orders/") return json({ results: found ? [v2Order({ client_order_id: uuidFrom(`${BASE}/${ACCOUNT}/ord-0008`), state: "filled", filled_asset_quantity: 0.00012, average_price: 62010 })] : [], next: null });
      return undefined;
    });
    const { trader } = await crypto(http);
    expect(ok(await trader.place({ symbol: "BTC-USD", side: "buy", type: "market", qty: 0.00012, clientId: "ord-0008" }))).toMatchObject({ ref: ORDER_ID, status: "filled", avgPrice: 62010 });
    expect(http.asked.at(-1)!.url).toBe(`${BASE}/api/v2/crypto/trading/orders/?account_number=${ACCOUNT}&created_at_start=2026-10-05T13:59:00Z&symbol=BTC-USD`);
    expect(signedRight(http.asked.at(-1)!)).toBe(true);
    found = false;
    const lost = refusal(await trader.place({ symbol: "BTC-USD", side: "buy", type: "market", qty: 0.00012, clientId: "ord-0009" }));
    expect([lost.code, lost.message, (lost.native as { client_order_id: string }).client_order_id]).toEqual(["E_VENUE_UNREACHABLE", "Robinhood Crypto did not answer the order, and it is not among Robinhood's orders yet: look in Robinhood before placing it again", uuidFrom(`${BASE}/${ACCOUNT}/ord-0009`)]);
    expect(writes(http)).toHaveLength(2);
  });

  it("markets(): the pairs the API trades in dollars, well-known ones first, twenty at most, the list kept five minutes", async () => {
    let now = START;
    const http = robinhood();
    const { trader } = await crypto(http, () => now);
    http.asked.length = 0;
    const first = ok(await trader.markets(""));
    expect(first).toHaveLength(20);
    expect(first.slice(0, 6).map((m) => m.symbol)).toEqual(["BTC-USD", "ETH-USD", "SOL-USD", "DOGE-USD", "AAVE-USD", "LTC-USD"]);
    // nothing the API does not trade, nothing priced in something other than dollars
    expect(first.some((m) => m.symbol === "XLM-USD" || m.symbol === "ETH-BTC")).toBe(false);
    expect(first.every((m) => m.quote === "USD")).toBe(true);
    expect([first[0]!.price, first[0]!.bid, first[0]!.ask]).toEqual([62000, 61990, 62010]);
    // one request for the list, one for the prices of the open ones
    expect(http.asked.map((a) => a.url)[0]).toBe(`${BASE}/api/v2/crypto/trading/trading_pairs/`);
    expect(new URL(http.asked[1]!.url).searchParams.getAll("symbol")).toEqual(first.filter((m) => m.open).map((m) => m.symbol));
    http.asked.length = 0;
    expect(ok(await trader.markets("do")).map((m) => m.symbol)).toEqual(["DOGE-USD"]);
    expect(http.asked.map((a) => new URL(a.url).pathname)).toEqual(["/api/v2/crypto/marketdata/best_bid_ask/"]);
    now += 5 * 60_000;
    http.asked.length = 0;
    await trader.markets("sol");
    expect(http.asked[0]!.url).toBe(`${BASE}/api/v2/crypto/trading/trading_pairs/`);
  });
});

// ---- Robinhood stocks, through Robinhood's MCP server ---------------------------------------------

const AGENTIC = "5RH00009876";
const ORDER = "6f1d2c3b-4a59-4e8d-9c7b-0a1b2c3d4e5f";
const done = (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify({ data }) }], structuredContent: { data, guide: "made up" } });
const failed = (said: string) => ({ isError: true, content: [{ type: "text", text: said }] });
const accounts = (agentic: boolean | undefined) =>
  done({ accounts: [
    { account_number: "5RH00001234", rhs_account_number: "511111111", type: "margin", brokerage_account_type: "individual", is_default: true, ...(agentic === undefined ? {} : { agentic_allowed: false }), option_level: "", state: "active", deactivated: false, permanently_deactivated: false },
    { account_number: AGENTIC, rhs_account_number: "522222222", type: "limited_margin", brokerage_account_type: "individual", is_default: false, ...(agentic === undefined ? {} : { agentic_allowed: agentic }), option_level: "", state: "active", deactivated: false, permanently_deactivated: false },
  ] });
const quote = (symbol: string, o: Record<string, unknown> = {}) => ({ quote: { symbol, last_trade_price: "230.10", venue_last_trade_time: "2026-10-05T13:59:00Z", last_non_reg_trade_price: null, venue_last_non_reg_trade_time: null, adjusted_previous_close: "229.00", previous_close: "229.00", previous_close_date: "2026-10-02", bid_price: "230.05", venue_bid_time: "2026-10-05T13:59:58Z", ask_price: "230.15", venue_ask_time: "2026-10-05T13:59:58Z", has_traded: true, state: "active", ...o }, close: { symbol, date: "2026-10-02", price: "229.00", interpolated: false, source: "sip-close" } });
const tradability = (symbol: string, o: Record<string, unknown> = {}) => ({ symbol, name: "Apple Inc. - Common Stock", simple_name: "Apple", state: "active", tradeable: true, fractional_tradability: "tradable", extended_hours_fractional_tradability: false, all_day_tradability: "tradable", account_type_tradabilities: [{ account_type: "individual", account_type_tradability: "tradable" }], ...o });
/** an equity order as place_equity_order and get_equity_orders give it */
const equityOrder = (o: Record<string, unknown> = {}) => ({ id: ORDER, instrument_id: "450dfc6d-5510-4d40-abfb-f633b7d9be3e", symbol: "AAPL", side: "buy", type: "market", state: "queued", quantity: "1.00000000", cumulative_quantity: "0.00000000", price: null, stop_price: null, average_price: null, fees: "0.00", dollar_based_amount: null, time_in_force: "gfd", market_hours: "regular_hours", trigger: "immediate", placed_agent: "agentic", created_at: "2026-10-05T14:00:01Z", last_transaction_at: null, executions: [], ...o });

/** the tools as the server lists them (inputs as a capture of its tools/list has them) */
const props = (...names: string[]) => Object.fromEntries(names.map((n) => [n, { type: "string" }]));
const TOOLS: McpTool[] = [
  { name: "get_accounts", inputSchema: {} },
  { name: "get_portfolio", inputSchema: { required: ["account_number"], properties: props("account_number") } },
  { name: "get_equity_positions" },
  { name: "get_equity_quotes", inputSchema: { required: ["symbols"], properties: props("symbols") } },
  { name: "get_equity_tradability", inputSchema: { required: ["account_number", "symbols"], properties: props("account_number", "symbols") } },
  { name: "review_equity_order" },
  { name: "place_equity_order", inputSchema: { required: ["account_number", "symbol", "side", "type"], properties: props("account_number", "symbol", "side", "type", "quantity", "dollar_amount", "limit_price", "stop_price", "time_in_force", "market_hours", "tax_lots", "ref_id") } },
  { name: "get_equity_orders", inputSchema: { required: ["account_number"], properties: props("account_number", "order_id", "state", "symbol", "created_at_gte", "placed_agent", "cursor") } },
  { name: "cancel_equity_order", inputSchema: { required: ["account_number", "order_id"], properties: props("account_number", "order_id") } },
  { name: "search", inputSchema: { required: ["query"], properties: props("query", "asset_type", "limit") } },
];

/** Robinhood's MCP server, as far as the tools go: what each answers is the test's, every call remembered */
function server(answers: Record<string, unknown>, tools: McpTool[] = TOOLS) {
  const called: Array<[string, Record<string, unknown>]> = [];
  const open: OpenMcp = async (_url, bearer) => {
    expect(bearer).toBe("access-made-up-1");
    const session: McpSession = {
      tools: async () => tools,
      call: async (name, args) => {
        called.push([name, args]);
        const a = answers[name];
        return typeof a === "function" ? (a as (x: Record<string, unknown>) => unknown)(args) : a;
      },
      close: async () => undefined,
    };
    return session;
  };
  return { open, called };
}
const READS = { get_accounts: accounts(true), get_portfolio: done({ buying_power: { buying_power: "500.00" }, cash: "500.00" }), get_equity_positions: done({ positions: [] }) };

async function stocks(s: ReturnType<typeof server>, clock?: () => number): Promise<{ source: LiveSource; trader: LiveTrader }> {
  const opened = ok(await robinhoodStocksSource({ venue: "robinhood", label: "", token: async () => "access-made-up-1", open: s.open, ...(clock ? { clock } : {}) }));
  return { source: opened.source, trader: opened.source.trader! };
}
const callsTo = (s: ReturnType<typeof server>, tool: string) => s.called.filter(([n]) => n === tool).map(([, a]) => a);

describe("Robinhood stocks: orders through its MCP server, in the Agentic account", () => {
  it("the connection carries a trader when Robinhood offers the order tools, and reading still calls only the three that read", async () => {
    const s = server(READS);
    const { source, trader } = await stocks(s);
    expect([trader.can, trader.what, source.noTradeBecause]).toEqual([true, "US stocks and ETFs, in the Robinhood Agentic account", undefined]);
    expect([...new Set(s.called.map(([n]) => n))].every((t) => (READ_TOOLS as readonly string[]).includes(t))).toBe(true);
    expect(source.probe.note).toContain("never review_equity_order, place_equity_order or cancel_equity_order");
    expect(source.probe.note).toContain("an order the account places calls get_equity_quotes, place_equity_order, get_equity_orders, cancel_equity_order, in the Agentic account ··9876 and no other");
    expect(source.readOnlyBecause).toBe("Robinhood moves money in and out only in its own app; through its MCP server an agent trades in the Agentic account and nothing else");

    expect(trader.whyNot).toBeUndefined();
    // no Agentic account for this sign-in: it may not trade, and why, in Robinhood's terms, with how that account is opened
    const none = (await stocks(server({ ...READS, get_accounts: accounts(false) }))).trader;
    expect([none.can, none.whyNot]).toEqual([false, "this sign-in has no Robinhood Agentic account, the one account an agent may trade in (Robinhood marks it agentic_allowed): Robinhood opens it, as a self-directed individual investing account it calls the MCP account, during the sign-in that first connects an agent, so sign in again from the account page and open it there"]);
    // accounts that do not say: unknown, and no reason given for a no that was not said
    const unsaid = (await stocks(server({ ...READS, get_accounts: accounts(undefined) }))).trader;
    expect([unsaid.can, unsaid.whyNot]).toEqual(["unknown", undefined]);
    // a server without the order tools: no trader, and the reason
    const readOnly = ok(await robinhoodStocksSource({ venue: "robinhood", label: "", token: async () => "access-made-up-1", open: server(READS, TOOLS.filter((t) => !["place_equity_order", "cancel_equity_order"].includes(t.name))).open }));
    expect([readOnly.source.trader, readOnly.source.noTradeBecause]).toEqual([undefined, "Robinhood's MCP server did not offer place_equity_order, cancel_equity_order: no order is placed there from here"]);
  });

  it("a later read whose tool answers with an error: the sign-in's token comes out of it before the page is shown it", async () => {
    let broken = false;
    const s = server({ ...READS, get_portfolio: () => (broken ? failed(`${"x".repeat(190)} token access-made-up-1 was refused`) : READS.get_portfolio) });
    const { source } = await stocks(s);
    broken = true;
    const err = await source.read().then(() => undefined, (e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).not.toContain("access-");
    expect(err!.message).toContain("token •••");
  });

  it("market(): the quote, the tick, whole shares or fractions, and whether the Agentic account may trade the stock", async () => {
    let t = tradability("AAPL");
    let q = quote("AAPL");
    const s = server({ ...READS, get_equity_quotes: () => done({ results: [q] }), get_equity_tradability: () => done({ results: [t] }) });
    const { trader } = await stocks(s);
    s.called.length = 0;
    expect(ok(await trader.market("aapl"))).toEqual({
      symbol: "AAPL",
      name: "Apple",
      kind: "stock",
      base: "AAPL",
      quote: "USD",
      price: 230.1,
      bid: 230.05,
      ask: 230.15,
      // whole shares: a fraction goes only as a plain market order, which cannot be held to the worst price the account values it at
      minQty: 1,
      qtyStep: 1,
      priceStep: 0.01,
      open: true,
      note: "orders go to your Robinhood Agentic account ··9876, the one account an agent may trade in · a market order goes as a limit at its worst price; orders are for the regular session (9:30 to 16:00 New York), good for the day, and outside it wait for the next open · whole shares only: Robinhood takes a fraction of a share only as a plain market order, which cannot be held to a worst price",
      types: ["market", "limit"],
    } satisfies Market);
    expect(s.called).toEqual([["get_equity_quotes", { symbols: ["AAPL"] }], ["get_equity_tradability", { account_number: AGENTIC, symbols: ["AAPL"] }]]);
    // the later of the regular and the extended sessions' last trades is the price; a closed book has no bid or ask
    q = quote("AAPL", { last_non_reg_trade_price: "231.40", venue_last_non_reg_trade_time: "2026-10-05T23:10:00Z", bid_price: "0", ask_price: "0" });
    t = tradability("AAPL", { fractional_tradability: "untradable" });
    const late = ok(await trader.market("AAPL"));
    expect([late.price, late.bid, late.ask, late.qtyStep, late.minQty, late.note!.endsWith("whole shares only")]).toEqual([231.4, undefined, undefined, 1, 1, true]);
    // halted for the regular session, or not for this kind of account: closed, and why
    t = tradability("AAPL", { internal_halt_sessions: ["regular_hours"], internal_halt_details: "news pending" });
    expect([ok(await trader.market("AAPL")).open, ok(await trader.market("AAPL")).note]).toEqual([false, "AAPL is halted at Robinhood: news pending"]);
    t = tradability("AAPL", { account_type_tradabilities: [{ account_type: "individual", account_type_tradability: "untradable" }] });
    expect(ok(await trader.market("AAPL")).note).toBe("Robinhood does not let the Agentic account trade AAPL");
    // a stock Robinhood does not have
    const none = server({ ...READS, get_equity_quotes: done({ results: [] }), get_equity_tradability: done({ results: [], not_found: ["ZZZZ"] }) });
    expect(refusal(await (await stocks(none)).trader.market("ZZZZ")).message).toBe("Robinhood: Robinhood has no stock ZZZZ");
  });

  it("place(): a market buy, a market sell and a limit order, in the Agentic account, each with a ref_id made from the account's id", async () => {
    const s = server({ ...READS, place_equity_order: (a: Record<string, unknown>) => done({ order: equityOrder({ side: a.side, type: a.type, quantity: a.quantity, price: a.limit_price ?? null }) }) });
    const { trader } = await stocks(s);
    const ref = (id: string) => uuidFrom(`https://agent.robinhood.com/mcp/trading/${AGENTIC}/${id}`);
    expect(ok(await trader.place({ symbol: "AAPL", side: "buy", type: "market", qty: 1, clientId: "ord-0001" }))).toMatchObject({ ref: ORDER, status: "pending", filledQty: 0, feeUsd: 0 });
    ok(await trader.place({ symbol: "nvda", side: "sell", type: "market", qty: 0.5, clientId: "ord-0002" }));
    ok(await trader.place({ symbol: "AAPL", side: "buy", type: "limit", qty: 2, limitPrice: 218, clientId: "ord-0003" }));
    expect(callsTo(s, "place_equity_order")).toEqual([
      { account_number: AGENTIC, symbol: "AAPL", side: "buy", type: "market", quantity: "1", time_in_force: "gfd", market_hours: "regular_hours", ref_id: ref("ord-0001") },
      { account_number: AGENTIC, symbol: "NVDA", side: "sell", type: "market", quantity: "0.5", time_in_force: "gfd", market_hours: "regular_hours", ref_id: ref("ord-0002") },
      { account_number: AGENTIC, symbol: "AAPL", side: "buy", type: "limit", quantity: "2", limit_price: "218.00", time_in_force: "gfd", market_hours: "regular_hours", ref_id: ref("ord-0003") },
    ]);
    // the same account id again is the same ref_id; a fraction in a limit order is not sent
    ok(await trader.place({ symbol: "AAPL", side: "buy", type: "market", qty: 1, clientId: "ord-0001" }));
    expect(callsTo(s, "place_equity_order").at(-1)!.ref_id).toBe(ref("ord-0001"));
    const n = callsTo(s, "place_equity_order").length;
    expect(refusal(await trader.place({ symbol: "AAPL", side: "buy", type: "limit", qty: 0.5, limitPrice: 218, clientId: "ord-0004" })).message).toBe("Robinhood: Robinhood takes a fraction of a share only in a market order: a limit order is whole shares");
    expect(callsTo(s, "place_equity_order")).toHaveLength(n);
    // a limit price off the US tick is refused here, never rounded up
    expect(refusal(await trader.place({ symbol: "AAPL", side: "buy", type: "limit", qty: 1, limitPrice: 1.0051, clientId: "ord-0005" })).code).toBe("E_VENUE_ORDER_INVALID");
    expect(callsTo(s, "place_equity_order")).toHaveLength(n);
  });

  it("place(): a market order with a worst price goes as a marketable limit at it, in whole shares, so it never fills past it", async () => {
    const s = server({ ...READS, place_equity_order: (a: Record<string, unknown>) => done({ order: equityOrder({ side: a.side, type: a.type, quantity: a.quantity, price: a.limit_price ?? null }) }) });
    const { trader } = await stocks(s);
    const ref = (id: string) => uuidFrom(`https://agent.robinhood.com/mcp/trading/${AGENTIC}/${id}`);
    ok(await trader.place({ symbol: "AAPL", side: "buy", type: "market", qty: 2, worstPrice: 234.759, clientId: "ord-0101" }));
    ok(await trader.place({ symbol: "AAPL", side: "sell", type: "market", qty: 1, worstPrice: 225.441, clientId: "ord-0102" }));
    ok(await trader.place({ symbol: "PENNY", side: "buy", type: "market", qty: 100, worstPrice: 0.51239, clientId: "ord-0103" }));
    expect(callsTo(s, "place_equity_order")).toEqual([
      { account_number: AGENTIC, symbol: "AAPL", side: "buy", type: "limit", quantity: "2", limit_price: "234.75", time_in_force: "gfd", market_hours: "regular_hours", ref_id: ref("ord-0101") },
      { account_number: AGENTIC, symbol: "AAPL", side: "sell", type: "limit", quantity: "1", limit_price: "225.45", time_in_force: "gfd", market_hours: "regular_hours", ref_id: ref("ord-0102") },
      { account_number: AGENTIC, symbol: "PENNY", side: "buy", type: "limit", quantity: "100", limit_price: "0.5123", time_in_force: "gfd", market_hours: "regular_hours", ref_id: ref("ord-0103") },
    ]);
    // a fraction goes only as a plain market order, which no worst price holds: not sent
    const frac = refusal(await trader.place({ symbol: "AAPL", side: "buy", type: "market", qty: 0.5, worstPrice: 234.75, clientId: "ord-0104" }));
    expect([frac.code, frac.message]).toEqual(["E_VENUE_ORDER_INVALID", "Robinhood: Robinhood takes a fraction of a share only as a plain market order, which cannot be held to a worst price: order whole shares"]);
    expect(callsTo(s, "place_equity_order")).toHaveLength(3);
    // a worst price that bounds nothing is not sent either
    expect(refusal(await trader.place({ symbol: "AAPL", side: "buy", type: "market", qty: 1, worstPrice: Infinity, clientId: "ord-0108" })).code).toBe("E_VENUE_ORDER_INVALID");
    expect(callsTo(s, "place_equity_order")).toHaveLength(3);
    // at the dollar, where the tick changes: a buy rounded down onto a cent, a sell rounded up onto one, neither past its worst price
    ok(await trader.place({ symbol: "PENNY", side: "buy", type: "market", qty: 100, worstPrice: 1.0049, clientId: "ord-0105" }));
    ok(await trader.place({ symbol: "PENNY", side: "sell", type: "market", qty: 100, worstPrice: 0.99991, clientId: "ord-0106" }));
    ok(await trader.place({ symbol: "PENNY", side: "buy", type: "market", qty: 100, worstPrice: 0.99999, clientId: "ord-0107" }));
    expect(callsTo(s, "place_equity_order").slice(3).map((a) => [a.side, a.type, a.limit_price])).toEqual([["buy", "limit", "1.00"], ["sell", "limit", "1.00"], ["buy", "limit", "0.9999"]]);
  });

  it("status(): every equity state Robinhood has, as the account's", async () => {
    let answer: Record<string, unknown> = equityOrder();
    const s = server({ ...READS, get_equity_orders: () => done({ orders: [answer], next: "" }) });
    const { trader } = await stocks(s);
    const seen = async (o: Record<string, unknown>) => {
      answer = equityOrder(o);
      const { native: _native, ...rest } = ok(await trader.status(ORDER, "AAPL"));
      return rest;
    };
    for (const state of ["new", "queued", "unconfirmed", "locating"]) expect((await seen({ state })).status).toBe("pending");
    expect((await seen({ state: "confirmed" })).status).toBe("open");
    expect((await seen({ state: "pending_cancelled" })).status).toBe("open");
    expect(await seen({ state: "partially_filled", cumulative_quantity: "0.4", average_price: "230.02", fees: "0.01" })).toEqual({ ref: ORDER, status: "partial", filledQty: 0.4, avgPrice: 230.02, feeUsd: 0.01 });
    expect(await seen({ state: "filled", cumulative_quantity: "1.00000000", average_price: "230.11", fees: "0.02" })).toEqual({ ref: ORDER, status: "filled", filledQty: 1, avgPrice: 230.11, feeUsd: 0.02 });
    expect(await seen({ state: "cancelled" })).toMatchObject({ status: "canceled", filledQty: 0 });
    expect(await seen({ state: "partially_filled_rest_cancelled", cumulative_quantity: "0.4" })).toMatchObject({ status: "canceled", filledQty: 0.4 });
    for (const state of ["rejected", "failed", "voided", "locate_failed"]) expect((await seen({ state })).status).toBe("rejected");
    expect((await seen({ state: "something_new" })).status).toBe("pending");
    expect(callsTo(s, "get_equity_orders").every((a) => JSON.stringify(a) === JSON.stringify({ account_number: AGENTIC, order_id: ORDER }))).toBe(true);
    answer = equityOrder({ id: "00000000-0000-4000-8000-000000000000" });
    expect(refusal(await trader.status(ORDER, "AAPL")).code).toBe("E_ACCOUNT_ORDER_UNKNOWN");
  });

  it("cancel(): cancel_equity_order, then the order as it stands", async () => {
    let accepted = true;
    const s = server({ ...READS, cancel_equity_order: () => done({ accepted }), get_equity_orders: done({ orders: [equityOrder({ state: "pending_cancelled" })] }) });
    const { trader } = await stocks(s);
    expect(ok(await trader.cancel(ORDER, "AAPL"))).toMatchObject({ ref: ORDER, status: "open" });
    expect(s.called.slice(-2)).toEqual([["cancel_equity_order", { account_number: AGENTIC, order_id: ORDER }], ["get_equity_orders", { account_number: AGENTIC, order_id: ORDER }]]);
    accepted = false;
    expect(refusal(await trader.cancel(ORDER, "AAPL")).code).toBe("E_VENUE_REJECTED");
  });

  it("refusals: Robinhood's words, the Agentic account, approvals, a call that did not come back, a tool that changed", async () => {
    let placeAnswer: unknown = failed("Insufficient buying power for this order");
    const s = server({ ...READS, place_equity_order: () => (typeof placeAnswer === "function" ? (placeAnswer as () => unknown)() : placeAnswer), get_equity_orders: () => failed("Order not found") });
    const { trader } = await stocks(s);
    const buy = () => trader.place({ symbol: "AAPL", side: "buy", type: "market", qty: 1, clientId: "ord-0005" });
    const poor = refusal(await buy());
    expect([poor.code, poor.native]).toEqual(["E_VENUE_INSUFFICIENT", { said: "Insufficient buying power for this order" }]);
    placeAnswer = failed("Fractional shares are only available in regular hours");
    expect(refusal(await buy()).code).toBe("E_VENUE_ORDER_INVALID");
    placeAnswer = failed("This account is not agentic_allowed; non-agentic accounts are rejected");
    expect(refusal(await buy()).code).toBe("E_VENUE_PERMISSION");
    placeAnswer = failed("Trading is not available in your region");
    expect(refusal(await buy()).code).toBe("E_VENUE_GEOBLOCKED");
    placeAnswer = failed("RATE_LIMITED");
    expect(refusal(await buy()).code).toBe("E_VENUE_UNREACHABLE");
    placeAnswer = failed("Rejected for access-made-up-1");
    expect(JSON.stringify(refusal(await buy()))).not.toContain("access-made-up-1");
    // across the point where the words are cut short: redacted first, so not even the token's first half is kept
    placeAnswer = failed(`${"x".repeat(190)} access-made-up-1`);
    expect(JSON.stringify(refusal(await buy()))).not.toContain("access-");
    expect(refusal(await trader.status(ORDER, "AAPL")).code).toBe("E_ACCOUNT_ORDER_UNKNOWN");
    // trade approvals on: Robinhood holds it, nothing is placed
    placeAnswer = done({ approval: { approval_id: "ap-1", asset_class: "ASSET_CLASS_EQUITY", state: "APPROVAL_STATE_PENDING", is_edited: false } });
    const held = refusal(await buy());
    expect([held.code, held.message.startsWith("Robinhood holds this order for your approval in its app")]).toEqual(["E_VENUE_REJECTED", true]);
    // a call that did not come back is made once more, with the same ref_id
    let tries = 0;
    placeAnswer = () => {
      if (++tries === 1) throw new Error("fetch failed");
      return done({ order: equityOrder() });
    };
    const before = callsTo(s, "place_equity_order").length;
    expect(ok(await buy()).ref).toBe(ORDER);
    const retried = callsTo(s, "place_equity_order").slice(before);
    expect([retried.length, retried[0]!.ref_id === retried[1]!.ref_id]).toEqual([2, true]);

    // no Agentic account: refused before any order tool is called
    const none = server({ ...READS, get_accounts: accounts(false), place_equity_order: done({ order: equityOrder() }) });
    const noneTrader = (await stocks(none)).trader;
    const shut = refusal(await noneTrader.place({ symbol: "AAPL", side: "buy", type: "market", qty: 1, clientId: "ord-0006" }));
    expect([shut.code, shut.message]).toEqual(["E_VENUE_PERMISSION", `Robinhood: ${noneTrader.whyNot}`]);
    expect(callsTo(none, "place_equity_order")).toEqual([]);
    // a tool whose inputs changed since this connection was written is not called on a guess
    const changed = server({ ...READS, place_equity_order: done({ order: equityOrder() }) }, TOOLS.map((t) => (t.name === "place_equity_order" ? { ...t, inputSchema: { required: ["account_number", "symbol", "side", "type", "session"], properties: props("account_number", "symbol", "side", "type", "quantity", "limit_price", "time_in_force", "ref_id", "session") } } : t)));
    const drift = refusal(await (await stocks(changed)).trader.place({ symbol: "AAPL", side: "buy", type: "market", qty: 1, clientId: "ord-0007" }));
    expect([drift.code, drift.message]).toEqual(["E_VENUE_REJECTED", "Robinhood's place_equity_order no longer takes market_hours, now requires session: nothing was sent until this connection is brought up to date"]);
    expect(callsTo(changed, "place_equity_order")).toEqual([]);
  });

  it("markets(): Robinhood's own search, or a few well-known stocks to start from, priced in one call and kept five minutes", async () => {
    let now = START;
    const s = server({
      ...READS,
      search: done({ results: [{ instrument_id: "450dfc6d-5510-4d40-abfb-f633b7d9be3e", symbol: "AAPL", name: "Apple Inc. - Common Stock", simple_name: "Apple" }, { instrument_id: "made-up", symbol: "APLE", name: "Apple Hospitality REIT" }] }),
      get_equity_quotes: (a: { symbols: string[] }) => done({ results: a.symbols.map((x) => quote(x)) }),
    });
    const { trader } = await stocks(s, () => now);
    s.called.length = 0;
    const first = ok(await trader.markets(""));
    expect(first.map((m) => m.symbol)).toEqual(["SPY", "QQQ", "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "HOOD"]);
    expect(first.every((m) => m.kind === "stock" && m.quote === "USD" && m.price === 230.1)).toBe(true);
    expect(s.called).toEqual([["get_equity_quotes", { symbols: first.map((m) => m.symbol) }]]);
    s.called.length = 0;
    const apple = ok(await trader.markets("apple"));
    expect(apple.map((m) => [m.symbol, m.name])).toEqual([["AAPL", "Apple"], ["APLE", "Apple Hospitality REIT"]]);
    expect(s.called[0]).toEqual(["search", { query: "apple", asset_type: "instrument", limit: 20 }]);
    s.called.length = 0;
    await trader.markets("apple");
    expect(s.called.map(([n]) => n)).toEqual(["get_equity_quotes"]);
    now += 5 * 60_000;
    s.called.length = 0;
    await trader.markets("apple");
    expect(s.called.map(([n]) => n)).toEqual(["search", "get_equity_quotes"]);
  });
});
