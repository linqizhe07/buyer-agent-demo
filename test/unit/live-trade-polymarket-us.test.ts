import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createPrivateKey, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { isRefusal, type Refusal } from "../../src/core/errors.ts";
import { venuesHere } from "../../src/portfolio/live/availability.ts";
import { exploreAcross, type ExploreVenue } from "../../src/portfolio/live/explore.ts";
import { KEY_SHAPES, keyFileStatus, liveOptions, openLive, type LiveDeps } from "../../src/portfolio/live/index.ts";
import type { RunMm } from "../../src/portfolio/live/metamask.ts";
import { pmusDayEnd, polymarketUsKey, polymarketUsSign, polymarketUsSource, type PolymarketUsTrader } from "../../src/portfolio/live/polymarket-us.ts";
import { holdBackMs, polymarketUsPublic, PUBLIC_HOSTS, type Listing } from "../../src/portfolio/live/public-markets.ts";
import { reachOf } from "../../src/portfolio/live/reach.ts";
import type { LiveTrader, Market, OrderRequest, OrderState, Position } from "../../src/portfolio/live/trade.ts";
import type { Http, HttpReply, LiveBalance, LiveSource } from "../../src/portfolio/live/types.ts";
import { venueCatalog } from "../../src/portfolio/service.ts";

/** POLYMARKET US (QCX LLC d/b/a Polymarket US, a CFTC-designated contract market — not polymarket.com), against a stand-in for both of its
 * hosts: api.polymarket.us, which checks every request's Ed25519 signature with a key pair made here and thrown away, and the public
 * gateway.polymarket.us, which takes no key. Every request is recorded, and each answers in the shapes Polymarket US's docs give and its
 * gateway answered keyless on 2026-10-08 (a market's question and title, bestBidQuote and bestAskQuote, the BBO's marketData, a map of
 * positions by slug). Nothing here leaves the process, and no key is anyone's. */
type Rec = Record<string, unknown>;
const START = Date.parse("2026-10-08T14:00:00.000Z");
const API = "api.polymarket.us";
const GW = "gateway.polymarket.us";
/** made up: shaped like a Key ID (a UUID), registered nowhere */
const KEY_ID = "0b7e9c1a-3d2f-4e5a-9b8c-7d6e5f4a3b2c";
const DAY = 86_400_000;

const amount = (value: string) => ({ value, currency: "USD" });
const json = (body: unknown, status = 200): HttpReply => ({ status, body, text: JSON.stringify(body) });
/** the gateway's error body: a gRPC code, its message, no details (a market it does not list: 404 {"code":5, …}) */
const grpc = (status: number, code: number, message: string): HttpReply => json({ code, message, details: [] }, status);

/** a market as GET /v1/market/slug/{slug} answered on 2026-10-08: YES the long side, a side of the book with no order absent, and
 * outcomes/outcomePrices strings that do not follow one order */
function mk(o: Rec & { slug: string; bid?: string | undefined; ask?: string | undefined }): Rec {
  const { bid, ask, ...rest } = o;
  return {
    id: "7909",
    question: "National League Champion",
    endDate: "2026-11-06T21:20:09Z",
    category: "sports",
    active: true,
    closed: false,
    archived: false,
    orderPriceMinTickSize: 0.001,
    marketType: "futures",
    marketSides: [
      { id: "15817", marketSideType: "MARKET_SIDE_TYPE_INSTRUMENT", identifier: o.slug, description: "Yes", long: true, tradable: true },
      { id: "15818", marketSideType: "MARKET_SIDE_TYPE_INSTRUMENT", identifier: o.slug, description: "No", long: false, tradable: true },
    ],
    outcomes: '["No","Yes"]',
    outcomePrices: '["0.6030","0.398"]',
    ep3Status: "OPEN",
    status: "MARKET_STATUS_OPEN",
    title: "Los Angeles Dodgers",
    minimumTradeQty: 1,
    ...(bid !== undefined ? { bestBidQuote: amount(bid) } : {}),
    ...(ask !== undefined ? { bestAskQuote: amount(ask) } : {}),
    ...rest,
  };
}
const LAD = mk({ slug: "tec-mlb-nlchamp-2026-09-27-lad", bid: "0.6020", ask: "0.6030" });
const BTC = mk({ slug: "cpc-btc-150k-12-31-2026", question: "When will Bitcoin hit $150k?", title: "Before January 2027", category: "crypto", orderPriceMinTickSize: 0.01, minimumTradeQty: 0.01, endDate: "2027-01-15T04:00:00Z", bid: "0.0400", ask: "0.0500" });
const ANTH = mk({ slug: "ipcc-anthropic-2026-12-31", question: "Anthropic IPO Officially Confirmed By", title: "December 31, 2026", category: "finance", orderPriceMinTickSize: 0.005, endDate: "2027-01-07T05:00:00Z", bid: "0.7200", ask: "0.7300" });
const HOUSE = mk({ slug: "paccc-usho-midterms-2026-11-03-dem", question: "U.S House Midterm Winner", title: "Democratic Party", category: "politics", endDate: "2026-11-04T05:00:00Z", bid: "0.8990", ask: "0.9000" });
const SENATE = mk({ slug: "paccc-usse-midterms-2026-11-03-rep", question: "U.S Senate Midterm Winner", title: "Republican Party", category: "politics", endDate: "2026-11-04T05:00:00Z", bid: "0.4170", ask: "0.4180" });
const BTC90 = mk({ slug: "cpc-btc-hitprice-high-yr-12-31-2026-90k", question: "How high will Bitcoin get this year?", title: "Above $89,999.99", category: "crypto", orderPriceMinTickSize: 0.01, minimumTradeQty: 0.01, endDate: "2026-10-09T04:00:00Z", bid: "0.6000", ask: "0.6100" });
const ONE_SIDED = mk({ slug: "ewc-usgub-mi-2026-11-03-mikdug", question: "Michigan Governor Election Winner", title: "Mike Duggan (Ind)", category: "politics", orderPriceMinTickSize: 0.01, ask: "0.0100" });
const SETTLED = mk({ slug: "aec-nfl-lac-ten-2025-11-02", question: "Chargers vs. Titans", title: "Los Angeles Chargers", status: "MARKET_STATUS_RESOLVED", ep3Status: "EXPIRED", active: false, closed: true, endDate: "2025-11-03T18:00:00Z" });
const MARKETS = [LAD, BTC, ANTH, HOUSE, SENATE, BTC90, ONE_SIDED, SETTLED];
const slugOf = (m: Rec) => m.slug as string;

/** GET /v1/markets/{slug}/bbo, as it answered for LAD on 2026-10-08: its settlementPx the DAILY settlement, not a result */
const bboOf = (m: Rec, extra: Rec = {}): Rec => ({ marketData: { marketSlug: m.slug, currentPx: null, lastTradePx: m.bestAskQuote ?? null, settlementPx: amount("0.4000"), sharesTraded: "1067975.0000", openInterest: "104278.0000", bestAsk: m.bestAskQuote ?? null, bestBid: m.bestBidQuote ?? null, askDepth: 8, bidDepth: 15, state: m.status === "MARKET_STATUS_OPEN" ? "MARKET_STATE_OPEN" : "MARKET_STATE_EXPIRED", bidShares: "340000", askShares: "260000", ...extra } });

interface Sent {
  method: string;
  host: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: Rec | undefined;
}

/** A stand-in Polymarket US. `routes` answers first; then the defaults: a $100 balance, no positions, nothing resting, the markets above, an
 * order filled at once when it was sent synchronous and resting when not. A signed request whose signature does not verify against the key
 * made here, whose key id is another, or whose timestamp is not now, is a 401 — as at Polymarket US */
function fakePmus(o: { balances?: unknown[]; positions?: Rec; open?: Rec[]; orders?: Record<string, Rec>; settlements?: Record<string, number>; bbo?: Record<string, Rec>; history?: Rec[]; routes?: (s: Sent) => HttpReply | undefined; throwOn?: (s: Sent) => boolean } = {}) {
  const pair = generateKeyPairSync("ed25519");
  const seed = (pair.privateKey.export({ format: "der", type: "pkcs8" }) as Buffer).subarray(-32);
  const pub = (pair.publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32);
  const bySlug = new Map(MARKETS.map((m) => [slugOf(m), m]));
  const k = {
    /** the Secret Key as polymarket.us/developer would hand it over: base64, the first 32 bytes the seed */
    secret: Buffer.concat([seed, pub]).toString("base64"),
    seedHex: seed.toString("hex"),
    publicKey: pair.publicKey,
    now: START,
    sent: [] as Sent[],
    orders: { ...(o.orders ?? {}) } as Record<string, Rec>,
    http: undefined as unknown as Http,
    /** the requests after the first `n`, as METHOD host path?query */
    since(n: number): string[] {
      return k.sent.slice(n).map((s) => `${s.method} ${s.host === API ? "api" : "gw"} ${s.path}${[...s.query.keys()].length ? `?${s.query.toString()}` : ""}`);
    },
  };
  const created = (body: Rec): HttpReply => {
    const id = `ord-${Object.keys(k.orders).length + 1}`;
    const base = { id, marketSlug: body.marketSlug, type: body.type, price: body.price, quantity: body.quantity, tif: body.tif, intent: body.intent, createTime: new Date(k.now).toISOString() };
    if (body.synchronousExecution) {
      const ord = { ...base, cumQuantity: body.quantity, leavesQuantity: 0, state: "ORDER_STATE_FILLED", avgPx: body.price, commissionNotionalTotalCollected: amount("0.07") };
      k.orders[id] = ord;
      return json({ id, executions: [{ id: "ex-1", order: ord, lastShares: String(body.quantity), lastPx: body.price, type: "EXECUTION_TYPE_FILL", aggressor: true }] });
    }
    k.orders[id] = { ...base, cumQuantity: 0, leavesQuantity: body.quantity, state: "ORDER_STATE_NEW" };
    return json({ id });
  };
  const api = (s: Sent): HttpReply => {
    if (s.method === "GET" && s.path === "/v1/account/balances") return json({ balances: o.balances ?? [{ currentBalance: 100, currency: "USD", lastUpdated: "2026-10-08T13:00:00Z", buyingPower: 100, assetNotional: 0, assetAvailable: 0, pendingCredit: 0, openOrders: 0, unsettledFunds: 0, marginRequirement: 0 }] });
    if (s.method === "GET" && s.path === "/v1/portfolio/positions") return json({ positions: o.positions ?? {}, nextCursor: "", eof: true });
    if (s.method === "GET" && s.path === "/v1/orders/open") return json({ orders: o.open ?? [] });
    const one = /^\/v1\/order\/([^/]+)$/.exec(s.path);
    if (s.method === "GET" && one) {
      const ord = k.orders[decodeURIComponent(one[1]!)];
      return ord ? json({ order: ord }) : grpc(404, 5, "order not found");
    }
    const cancel = /^\/v1\/order\/([^/]+)\/cancel$/.exec(s.path);
    if (s.method === "POST" && cancel) {
      const id = decodeURIComponent(cancel[1]!);
      const ord = k.orders[id];
      if (!ord) return grpc(404, 5, "order not found");
      k.orders[id] = { ...ord, state: "ORDER_STATE_CANCELED" };
      return json({});
    }
    if (s.method === "POST" && s.path === "/v1/orders") return created(s.body!);
    return grpc(404, 5, "The server was unable to process your request.");
  };
  const gateway = (s: Sent): HttpReply => {
    const one = /^\/v1\/market\/slug\/([^/]+)$/.exec(s.path);
    if (one) {
      const m = bySlug.get(decodeURIComponent(one[1]!));
      return m ? json({ market: m }) : grpc(404, 5, "The server was unable to process your request.");
    }
    const bbo = /^\/v1\/markets\/([^/]+)\/bbo$/.exec(s.path);
    if (bbo) {
      const slug = decodeURIComponent(bbo[1]!);
      const m = bySlug.get(slug);
      return m ? json(o.bbo?.[slug] ?? bboOf(m)) : grpc(404, 5, "The server was unable to process your request.");
    }
    const settle = /^\/v1\/markets\/([^/]+)\/settlement$/.exec(s.path);
    if (settle) {
      const slug = decodeURIComponent(settle[1]!);
      const v = o.settlements?.[slug];
      return v !== undefined ? json({ slug, settlement: v }) : grpc(404, 5, `Settlement not found for market ${slug}`);
    }
    if (s.path === "/v1/markets") {
      const slugs = s.query.getAll("slug");
      if (slugs.length) return json({ markets: MARKETS.filter((m) => slugs.includes(slugOf(m))) });
      const cats = s.query.getAll("categories");
      const endMin = s.query.get("endDateMin");
      const endMax = s.query.get("endDateMax");
      const open = MARKETS.filter((m) => m.status === "MARKET_STATUS_OPEN" && (!cats.length || cats.includes(String(m.category))) && (!endMin || Date.parse(String(m.endDate)) >= Date.parse(endMin)) && (!endMax || Date.parse(String(m.endDate)) <= Date.parse(endMax)));
      return json({ markets: open.slice(0, Number(s.query.get("limit") ?? 20)) });
    }
    if (s.path === "/v1/search") {
      const q = (s.query.get("query") ?? "").toLowerCase();
      const hits = MARKETS.filter((m) => [m.question, m.title, m.slug].some((f) => String(f).toLowerCase().includes(q)));
      return json({ events: hits.length ? [{ slug: "found", title: String(hits[0]!.question), category: hits[0]!.category, markets: hits }] : [] });
    }
    if (s.path === "/v1/price-history") return json({ history: o.history ?? [] });
    return grpc(404, 5, "The server was unable to process your request.");
  };
  k.http = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const headers = init.headers ?? {};
    const s: Sent = { method, host: u.host, path: u.pathname, query: u.searchParams, headers, body: init.body === undefined ? undefined : (JSON.parse(init.body) as Rec) };
    k.sent.push(s);
    if (u.host !== API && u.host !== GW) throw new Error(`not Polymarket US: ${u.host}`);
    if (o.throwOn?.(s)) throw new Error(`socket hang up after ${k.secret}`);
    if (u.host === API) {
      const signed = verify(null, Buffer.from(`${headers["X-PM-Timestamp"]}${method}${u.pathname}`), pair.publicKey, Buffer.from(headers["X-PM-Signature"] ?? "", "base64"));
      if (!signed || headers["X-PM-Access-Key"] !== KEY_ID || headers["X-PM-Timestamp"] !== String(k.now)) return grpc(401, 16, "unauthenticated");
    }
    const custom = o.routes?.(s);
    if (custom) return custom;
    return u.host === API ? api(s) : gateway(s);
  };
  return k;
}
type Fake = ReturnType<typeof fakePmus>;

async function connect(k: Fake, keyId = KEY_ID): Promise<{ source: LiveSource; t: PolymarketUsTrader; first: LiveBalance[] }> {
  const opened = await polymarketUsSource({ venue: "polymarket-us", label: "", reference: "credentials/polymarket-us/api-key.json", key: { keyId, secretKey: k.secret }, http: k.http, clock: () => k.now });
  if (isRefusal(opened)) throw new Error(`${opened.code}: ${opened.message}`);
  return { source: opened.source, t: opened.source.trader as PolymarketUsTrader, first: opened.first };
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
const order = (o: Partial<OrderRequest> & { symbol: string }): OrderRequest => ({ side: "buy", type: "limit", qty: 1, clientId: "0123456789abcdef0123456789abcdef", ...o });
/** an Order as GET /v1/order/{id} and GET /v1/orders/open give it */
const pmOrder = (o: Rec): Rec => ({ id: "o-1", marketSlug: LAD.slug, side: "ORDER_SIDE_BUY", type: "ORDER_TYPE_LIMIT", price: amount("0.6000"), quantity: 10, cumQuantity: 0, leavesQuantity: 10, tif: "TIME_IN_FORCE_GOOD_TILL_CANCEL", intent: "ORDER_INTENT_BUY_LONG", state: "ORDER_STATE_NEW", createTime: "2026-10-08T13:59:00Z", insertTime: "2026-10-08T13:59:00Z", ...o });
const noKeyHeaders = (k: Fake) => k.sent.filter((s) => s.host === GW).every((s) => !Object.keys(s.headers).some((h) => /^x-pm/i.test(h)));

afterEach(() => vi.restoreAllMocks());

describe("Polymarket US's request signature", () => {
  it("is base64 of Ed25519 over timestamp + METHOD + path — the path without its query, the body never signed — with the key the Secret Key's first 32 bytes hold", () => {
    // a throwaway key from a seed of thirty-two 0x07 bytes, registered nowhere; Ed25519 is deterministic
    const seed = Buffer.alloc(32, 7);
    const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
    const pub = createPublicKey(key);
    // the Secret Key: base64, of which the first 32 bytes are the seed ("base64.b64decode("YOUR_SECRET_KEY")[:32]", authentication.md)
    const secret = Buffer.concat([seed, (pub.export({ format: "der", type: "spki" }) as Buffer).subarray(-32)]).toString("base64");
    const fromSecret = polymarketUsKey(secret)!;
    const ts = 1791468000000;
    const sig = polymarketUsSign(fromSecret, ts, "get", "/v1/portfolio/positions?cursor=abc");
    expect(verify(null, Buffer.from(`${ts}GET/v1/portfolio/positions`, "utf8"), pub, Buffer.from(sig, "base64"))).toBe(true);
    expect(Buffer.from(sig, "base64")).toHaveLength(64);
    expect(sig).toBe(polymarketUsSign(key, ts, "GET", "/v1/portfolio/positions"));
    // the method is part of what is signed: a POST's signature is not a GET's
    const post = polymarketUsSign(fromSecret, ts, "POST", "/v1/orders");
    expect(verify(null, Buffer.from(`${ts}POST/v1/orders`), pub, Buffer.from(post, "base64"))).toBe(true);
    expect(verify(null, Buffer.from(`${ts}GET/v1/orders`), pub, Buffer.from(post, "base64"))).toBe(false);
    // the seed alone, in base64, is the same key; anything that is not base64 of 32 bytes or more is no key
    expect(polymarketUsSign(polymarketUsKey(seed.toString("base64"))!, ts, "POST", "/v1/orders")).toBe(post);
    for (const bad of ["", "not base64!", Buffer.alloc(31, 1).toString("base64"), "c2hvcnQ="]) expect(polymarketUsKey(bad)).toBeUndefined();
  });
});

describe("the Polymarket US connection", () => {
  it("connecting signs two reads at api.polymarket.us — the balances and the positions — each with the key's id, the time and a signature that verifies; the trader says what is traded, and no money moves here", async () => {
    const k = fakePmus();
    const { source, t, first } = await connect(k);
    expect(k.since(0).sort()).toEqual(["GET api /v1/account/balances", "GET api /v1/portfolio/positions"]);
    for (const s of k.sent) {
      expect(Object.keys(s.headers).sort()).toEqual(["X-PM-Access-Key", "X-PM-Signature", "X-PM-Timestamp", "accept"]);
      expect([s.headers["X-PM-Access-Key"], s.headers["X-PM-Timestamp"]]).toEqual([KEY_ID, String(START)]);
      expect(verify(null, Buffer.from(`${START}GET${s.path}`), k.publicKey, Buffer.from(s.headers["X-PM-Signature"]!, "base64"))).toBe(true);
    }
    expect(first).toEqual([{ asset: "USD", amount: 100, usd: 100, where: "cash · buying power $100.00", class: "cash" }]);
    expect([source.name, source.kind, source.via, source.readOnlyBecause, source.probe.can, t.what, t.can]).toEqual(["Polymarket US", "prediction", "Polymarket US API · Ed25519-signed key", "Polymarket US's API moves no money: deposits and withdrawals are made in its app", [], "event contracts: YES or NO on Polymarket US's markets", "unknown"]);
    expect(JSON.stringify(source)).not.toContain(k.secret);
  });

  const home = mkdtempSync(join(tmpdir(), "pmus-trade-"));
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it("through the account's connector table: live:polymarket-us reads a key file of a Key ID and a Secret Key, says which field is missing — never a value — and refuses a Secret Key that is not one without repeating it", async () => {
    const k = fakePmus();
    expect(KEY_SHAPES["polymarket-us"]!.required).toEqual(["keyId", "secretKey"]);
    expect(liveOptions(home).options.find((o) => o.kind === "polymarket-us")).toMatchObject({ connector: "live:polymarket-us", label: "Polymarket US · prediction-market account, API key", needs: "key-file", venues: [] });
    mkdirSync(join(home, "credentials/polymarket-us"), { recursive: true });
    const file = join(home, "credentials/polymarket-us/api-key.json");
    writeFileSync(file, JSON.stringify({ keyId: KEY_ID }));
    chmodSync(file, 0o600);
    const half = keyFileStatus(home, "polymarket-us", "polymarket-us", "");
    expect([half.ready, half.missing]).toEqual([false, ["secretKey"]]);
    writeFileSync(file, JSON.stringify({ keyId: KEY_ID, secretKey: k.secret }));
    expect(keyFileStatus(home, "polymarket-us", "polymarket-us", "").ready).toBe(true);
    const deps = { home, http: k.http, clock: () => k.now } as unknown as LiveDeps;
    const opened = await openLive({ venue: "polymarket-us", connector: "live:polymarket-us", label: "", reference: "" }, deps);
    if (isRefusal(opened)) throw new Error(opened.message);
    expect([opened.source.name, opened.source.reference, opened.source.trader?.what]).toEqual(["Polymarket US", "credentials/polymarket-us/api-key.json", "event contracts: YES or NO on Polymarket US's markets"]);
    expect(opened.summary).toMatch(/^connected · a Polymarket US key belongs to the identity-verified account that made it/);
    writeFileSync(file, JSON.stringify({ keyId: KEY_ID, secretKey: "this is not base64 at all, it is a sentence" }));
    const bad = refusal(await openLive({ venue: "polymarket-us", connector: "live:polymarket-us", label: "", reference: "" }, deps));
    expect(bad.code).toBe("E_ACCOUNT_CREDENTIAL");
    expect(JSON.stringify(bad)).not.toContain("a sentence");
  });

  it("a key Polymarket US does not accept is its 401, said as that in its words: the Key ID, the Secret Key or the clock — nothing secret in it", async () => {
    const k = fakePmus();
    const opened = await polymarketUsSource({ venue: "polymarket-us", label: "", reference: "", key: { keyId: "another-key-id-0000", secretKey: k.secret }, http: k.http, clock: () => k.now });
    const no = refusal(opened);
    expect([no.code, no.native]).toEqual(["E_VENUE_UNAUTHORIZED", { status: 401, code: 16, said: "unauthenticated" }]);
    expect(no.message).toContain("Polymarket US does not accept this key: its Key ID, its Secret Key, or this machine's clock (a timestamp more than 30 seconds from Polymarket US's is refused)");
    expect(JSON.stringify(no)).not.toContain(k.secret);
  });
});

describe("what the account reads at Polymarket US: each position at its market's price now, and a NO as the short it is there", () => {
  const positions: Rec = {
    [LAD.slug as string]: { netPosition: "4", netPositionDecimal: "4.0000", qtyBoughtDecimal: "4.0000", qtySoldDecimal: "0.0000", cost: amount("2.20"), realized: amount("0"), expired: false, cashValue: amount("2.41"), qtyAvailableDecimal: "4.0000", marketMetadata: { slug: LAD.slug, title: "Los Angeles Dodgers", outcome: "Yes", eventSlug: "mlb-nlchamp-2026-09-27" } },
    [BTC.slug as string]: { netPositionDecimal: "-20.0000", cost: amount("-0.90"), qtyAvailableDecimal: "-20.0000", marketMetadata: { slug: BTC.slug, title: "Before January 2027" } },
    [SETTLED.slug as string]: { netPositionDecimal: "3.0000", cost: amount("1.50"), expired: true },
    "gone-from-the-list-2026": { netPositionDecimal: "2.0000", cost: amount("1.00") },
    "ewc-usgub-ks-2026-11-03-dem": { netPositionDecimal: "0.0000", cost: amount("0") },
  };
  const balances = [{ currentBalance: 120, currency: "USD", buyingPower: 80.5, assetNotional: 2.41, assetAvailable: 0, openOrders: 0, unsettledFunds: 0, marginRequirement: 20 }];

  it("the cash is the balance less $1.00 a NO contract (Polymarket US adds a NO's sale proceeds to the balance and holds $1.00 as margin), so cash and positions add up to the balance plus every position at its price; a settled market at its settlement, one it does not list at what it cost", async () => {
    const k = fakePmus({ positions, balances, settlements: { [SETTLED.slug as string]: 1 } });
    const { first } = await connect(k);
    expect(first).toEqual([
      { asset: "USD", amount: 100, usd: 100, where: "cash · buying power $80.50 · the balance less the $1.00 a contract Polymarket US holds as margin for the 20 NO held", class: "cash" },
      { asset: `${LAD.slug}:YES`, amount: 4, usd: 2.41, where: "at market · cost $2.20", class: "event" },
      { asset: `${BTC.slug}:NO`, amount: 20, usd: 19.1, where: "at market", class: "event" },
      { asset: `${SETTLED.slug}:YES`, amount: 3, usd: 3, where: "settled YES · cost $1.50", class: "event" },
      { asset: "gone-from-the-list-2026:YES", amount: 2, usd: 1, where: "at cost: Polymarket US did not list its market", class: "event" },
    ]);
    // the balance plus every position netted at its YES price: 120 + 4 × 0.6025 − 20 × 0.045 + 3 × 1 + 2 at its cost of 1.00
    const total = first.reduce((s, b) => s + (b.usd ?? 0), 0);
    expect(total).toBeCloseTo(120 + 4 * 0.6025 - 20 * 0.045 + 3 + 1, 9);
    // the held markets in one call, of any status, and the settled one's settlement: both at the public gateway, with no key
    expect(k.since(2)).toEqual([`GET gw /v1/markets?slug=${LAD.slug}&slug=${BTC.slug}&slug=${SETTLED.slug}&slug=gone-from-the-list-2026&limit=4`, `GET gw /v1/markets/${SETTLED.slug}/settlement`]);
    expect(noKeyHeaders(k)).toBe(true);
  });

  it("positions(): the same rows as the trader lists them — named by their market's question and title, what a YES cost and its unrealised gain beside; a NO's basis is not read, as Polymarket US books it as YES sold", async () => {
    const k = fakePmus({ positions, balances, settlements: { [SETTLED.slug as string]: 1 } });
    const { t } = await connect(k);
    const got = (await t.positions!()) as Position[];
    expect(got.map((p) => [p.symbol, p.name, p.side, p.qty, p.entryPrice, p.markPrice, p.usd, p.unrealizedUsd])).toEqual([
      [`${LAD.slug}:YES`, "National League Champion — Los Angeles Dodgers · Yes", "long", 4, 0.55, 0.6025, 2.41, 0.21],
      [`${BTC.slug}:NO`, "When will Bitcoin hit $150k? — Before January 2027 · No", "long", 20, undefined, 0.955, 19.1, undefined],
      [`${SETTLED.slug}:YES`, "Chargers vs. Titans — Los Angeles Chargers · Yes", "long", 3, 0.5, 1, 3, 1.5],
      ["gone-from-the-list-2026:YES", "gone-from-the-list-2026 · Yes", "long", 2, 0.5, undefined, undefined, undefined],
    ]);
  });

  it("a market settled at a price — an event called off settles at “last fair market prices” — is worth that price a YES contract, and 1 − it a NO; said as that, not as a side that won", async () => {
    const k = fakePmus({ positions: { [SETTLED.slug as string]: { netPositionDecimal: "-5.0000" } }, settlements: { [SETTLED.slug as string]: 0.4 } });
    const { first } = await connect(k);
    expect(first[1]).toEqual({ asset: `${SETTLED.slug}:NO`, amount: 5, usd: 3, where: "settled at 0.4 a YES contract", class: "event" });
  });

  it("the held markets not answering fails the read in Polymarket US's words — never every position at cost now and at market the next time", async () => {
    const k = fakePmus({ positions, balances, routes: (s) => (s.host === GW && s.path === "/v1/markets" ? json({ status: 429, message: "Too Many Requests" }, 429) : undefined) });
    const no = refusal(await polymarketUsSource({ venue: "polymarket-us", label: "", reference: "", key: { keyId: KEY_ID, secretKey: k.secret }, http: k.http, clock: () => k.now }));
    expect([no.code, no.message]).toEqual(["E_VENUE_UNREACHABLE", "Polymarket US is rate-limiting this machine: try again in a minute"]);
  });
});

describe("market(): one Polymarket US market, for one of its outcomes", () => {
  it("YES and NO from the one YES book (NO's bid is 1 − YES's ask), on its tick and its minimumTradeQty, open while its status and its book say so; market and limit orders, four times in force, post-only — no stops, no reduce-only flag, and a sell sells only what is held", async () => {
    const k = fakePmus();
    const { t } = await connect(k);
    const n = k.sent.length;
    const yes = market(await t.market(`${(LAD.slug as string).toUpperCase()}:yes`));
    expect(k.since(n)).toEqual([`GET gw /v1/market/slug/${LAD.slug}`, `GET gw /v1/markets/${LAD.slug}/bbo`]);
    expect(yes).toEqual({
      symbol: `${LAD.slug}:YES`,
      name: "National League Champion — Los Angeles Dodgers · Yes",
      kind: "event",
      base: `${LAD.slug}:YES`,
      quote: "USD",
      price: 0.603,
      bid: 0.602,
      ask: 0.603,
      minQty: 1,
      qtyStep: 1,
      priceStep: 0.001,
      open: true,
      note: "ends 2026-11-06 21:20 UTC",
      types: ["market", "limit"],
      tifs: ["gtc", "ioc", "fok", "day"],
      tifsByType: { market: ["ioc", "fok"], limit: ["gtc", "ioc", "fok", "day"] },
      postOnly: true,
      sellsReduce: true,
      closeTime: "2026-11-06T21:20:09Z",
      category: "Sports",
      group: { id: LAD.slug, title: "National League Champion — Los Angeles Dodgers" },
      outcome: "YES",
    });
    const no = market(await t.market(`${LAD.slug}:NO`));
    expect([no.symbol, no.name.endsWith(" · No"), no.price, no.bid, no.ask, no.open, no.group, no.outcome]).toEqual([`${LAD.slug}:NO`, true, 0.397, 0.397, 0.398, true, yes.group, "NO"]);
    // a partial-contract market: sizes in hundredths of a contract, a cent tick
    expect([market(await t.market(`${BTC.slug}:YES`)).qtyStep, market(await t.market(`${BTC.slug}:YES`)).priceStep]).toEqual([0.01, 0.01]);
    // a side with no order is no price
    const thin = market(await t.market(`${ONE_SIDED.slug}:NO`));
    expect([thin.bid, thin.ask]).toEqual([0.99, undefined]);
  });

  it("closed: a book Polymarket US has suspended (its weekly maintenance), a settled market, an unknown slug; a name that is not <slug>:YES|NO is refused before anything is asked", async () => {
    const k = fakePmus({ bbo: { [LAD.slug as string]: bboOf(LAD, { state: "MARKET_STATE_SUSPENDED" }) } });
    const { t } = await connect(k);
    const paused = market(await t.market(`${LAD.slug}:YES`));
    expect([paused.open, paused.note]).toEqual([false, "Polymarket US has suspended trading in it now (its weekly maintenance is Thursdays 6–8am ET)"]);
    const done = market(await t.market(`${SETTLED.slug}:YES`));
    expect([done.open, done.note]).toEqual([false, "settled"]);
    const none = refusal(await t.market("no-such-market-2026:YES"));
    expect([none.code, none.message]).toEqual(["E_VENUE_REJECTED", "Polymarket US has no market no-such-market-2026"]);
    const n = k.sent.length;
    expect(refusal(await t.market("KXFED-27APR-T4.00")).code).toBe("E_ACCOUNT_BAD_ACTION");
    expect(k.sent.length).toBe(n);
  });
});

describe("place(): Polymarket US's order, always in the YES contract's price", () => {
  it("a market buy: a limit at the worst price the account gave it, on the tick, immediate-or-cancel and waited for (synchronous), marked automatic — exactly this request, signed over its path; the fill as the order says it", async () => {
    const filled = { id: "o-1", marketSlug: LAD.slug, intent: "ORDER_INTENT_BUY_LONG", type: "ORDER_TYPE_LIMIT", price: amount("0.615"), quantity: 5, cumQuantity: 5, leavesQuantity: 0, state: "ORDER_STATE_FILLED", avgPx: amount("0.6030"), commissionNotionalTotalCollected: amount("0.07") };
    const k = fakePmus({ routes: (s) => (s.method === "POST" && s.path === "/v1/orders" ? json({ id: "o-1", executions: [{ id: "x-1", type: "EXECUTION_TYPE_FILL", lastShares: "5", lastPx: amount("0.6030"), order: filled }] }) : undefined) });
    const { t } = await connect(k);
    market(await t.market(`${LAD.slug}:YES`));
    const n = k.sent.length;
    const st = state(await t.place(order({ symbol: `${LAD.slug}:YES`, type: "market", qty: 5, worstPrice: 0.6155 })));
    expect(k.since(n)).toEqual(["POST api /v1/orders"]);
    const sent = k.sent.at(-1)!;
    expect(sent.body).toEqual({ marketSlug: LAD.slug, type: "ORDER_TYPE_LIMIT", price: { value: "0.615", currency: "USD" }, quantity: 5, tif: "TIME_IN_FORCE_IMMEDIATE_OR_CANCEL", intent: "ORDER_INTENT_BUY_LONG", manualOrderIndicator: "MANUAL_ORDER_INDICATOR_AUTOMATIC", synchronousExecution: true, maxBlockTime: "5" });
    expect(sent.headers["Content-Type"]).toBe("application/json");
    expect(verify(null, Buffer.from(`${START}POST/v1/orders`), k.publicKey, Buffer.from(sent.headers["X-PM-Signature"]!, "base64"))).toBe(true);
    expect([st.ref, st.status, st.filledQty, st.avgPrice, st.feeUsd]).toEqual(["o-1", "filled", 5, 0.603, 0.07]);
    expect(t.can).toBe(true);
  });

  it("NO in YES terms: buying NO at X is ORDER_INTENT_BUY_SHORT with price.value 1 − X, selling it ORDER_INTENT_SELL_SHORT — for limit and market orders; a NO fill's average is 1 − the YES price it filled at", async () => {
    const k = fakePmus({ positions: { [LAD.slug as string]: { netPositionDecimal: "-10.0000", qtyAvailableDecimal: "-10.0000" } } });
    const { t } = await connect(k);
    const buy = state(await t.place(order({ symbol: `${LAD.slug}:NO`, side: "buy", type: "limit", qty: 2, limitPrice: 0.4 })));
    expect([k.sent.find((s) => s.method === "POST")!.body!.price, k.sent.find((s) => s.method === "POST")!.body!.intent, k.sent.find((s) => s.method === "POST")!.body!.tif, buy.status]).toEqual([{ value: "0.6", currency: "USD" }, "ORDER_INTENT_BUY_SHORT", "TIME_IN_FORCE_GOOD_TILL_CANCEL", "open"]);
    expect("synchronousExecution" in posts(k)[0]!.body!).toBe(false);
    state(await t.place(order({ symbol: `${LAD.slug}:NO`, side: "sell", type: "limit", qty: 3, limitPrice: 0.42 })));
    expect([posts(k)[1]!.body!.price, posts(k)[1]!.body!.intent]).toEqual([{ value: "0.58", currency: "USD" }, "ORDER_INTENT_SELL_SHORT"]);
    // a market buy of NO at worst 0.41 offers YES at 0.59 or more; filled there, NO's average is 0.41
    const mkt = state(await t.place(order({ symbol: `${LAD.slug}:NO`, side: "buy", type: "market", qty: 2, worstPrice: 0.41 })));
    expect([posts(k)[2]!.body!.price, posts(k)[2]!.body!.intent, mkt.status, mkt.avgPrice]).toEqual([{ value: "0.59", currency: "USD" }, "ORDER_INTENT_BUY_SHORT", "filled", 0.41]);
    // a market sell of NO at worst 0.395 bids for YES at 0.605 or less
    state(await t.place(order({ symbol: `${LAD.slug}:NO`, side: "sell", type: "market", qty: 1, worstPrice: 0.395 })));
    expect([posts(k)[3]!.body!.price, posts(k)[3]!.body!.intent]).toEqual([{ value: "0.605", currency: "USD" }, "ORDER_INTENT_SELL_SHORT"]);
  });

  it("a market order's price goes to the tick in the safe direction — a YES bid down, a YES offer up — and inside 0.01–0.99, tighter and never looser; a worst price with no price on the grid is refused", async () => {
    const k = fakePmus({ positions: { [BTC.slug as string]: { netPositionDecimal: "50.0000" } } });
    const { t } = await connect(k);
    const priceOf = async (o: OrderRequest) => {
      const n = posts(k).length;
      state(await t.place(o));
      return (posts(k)[n]!.body!.price as { value: string }).value;
    };
    expect(await priceOf(order({ symbol: `${BTC.slug}:YES`, type: "market", worstPrice: 0.0567 }))).toBe("0.05");
    expect(await priceOf(order({ symbol: `${BTC.slug}:NO`, type: "market", worstPrice: 0.9433 }))).toBe("0.06");
    expect(await priceOf(order({ symbol: `${BTC.slug}:YES`, type: "market", worstPrice: 0.999 }))).toBe("0.99");
    expect(await priceOf(order({ symbol: `${BTC.slug}:YES`, side: "sell", type: "market", worstPrice: 0.004 }))).toBe("0.01");
    // without a worst price: the book the account just looked at
    expect(await priceOf(order({ symbol: `${BTC.slug}:YES`, type: "market" }))).toBe("0.05");
    const n = posts(k).length;
    const no = refusal(await t.place(order({ symbol: `${BTC.slug}:YES`, type: "market", worstPrice: 0.004 })));
    expect([no.code, no.message]).toEqual(["E_VENUE_ORDER_INVALID", "Polymarket US: 0.004 has no price on When will Bitcoin hit $150k? — Before January 2027 · Yes's grid between 0.01 and 0.99 to send a market order at: try a limit order"]);
    expect(posts(k).length).toBe(n);
  });

  it("refused here, before anything is sent: a stop order, a market order that would rest, post-only that could never rest, reduce-only, a size off the market's step, a price off its tick or outside 0.01–0.99, a sell of what is not held, a name that is not a Polymarket US market", async () => {
    const k = fakePmus();
    const { t } = await connect(k);
    const lad = `${LAD.slug}:YES`;
    const cases: Array<[OrderRequest, string, string]> = [
      [order({ symbol: lad, type: "stop", stopPrice: 0.5 }), "E_VENUE_ORDER_INVALID", "Polymarket US: Polymarket US takes limit and market orders, not stop orders"],
      [order({ symbol: lad, type: "market", tif: "gtc" }), "E_VENUE_ORDER_INVALID", "Polymarket US: a market order at Polymarket US is a limit at its worst price that fills at once (immediate-or-cancel), or all at once or not at all (fill-or-kill): one that rests on the book is a limit order"],
      [order({ symbol: lad, limitPrice: 0.5, tif: "ioc", postOnly: true }), "E_VENUE_ORDER_INVALID", "Polymarket US: a post-only order “must rest on the book prior to matching”: one that must fill at once never rests"],
      [order({ symbol: lad, limitPrice: 0.5, reduceOnly: true }), "E_VENUE_ORDER_INVALID", "Polymarket US: Polymarket US's order has no reduce-only flag: a sell here sells only what is held, which the account checks before it is sent"],
      [order({ symbol: lad, limitPrice: 0.5, qty: 1.5 }), "E_VENUE_ORDER_INVALID", "Polymarket US: a size in National League Champion — Los Angeles Dodgers · Yes is in steps of 1 contracts, at least 1 (its minimumTradeQty)"],
      [order({ symbol: `${BTC.slug}:YES`, limitPrice: 0.05, qty: 0.005 }), "E_VENUE_ORDER_INVALID", "Polymarket US: a size in When will Bitcoin hit $150k? — Before January 2027 · Yes is in steps of 0.01 contracts, at least 0.01 (its minimumTradeQty)"],
      [order({ symbol: lad, limitPrice: 0.6035 }), "E_VENUE_ORDER_INVALID", "Polymarket US: a price in National League Champion — Los Angeles Dodgers · Yes moves in steps of 0.001, between 0.01 and 0.99"],
      [order({ symbol: `${ANTH.slug}:YES`, limitPrice: 0.722 }), "E_VENUE_ORDER_INVALID", "Polymarket US: a price in Anthropic IPO Officially Confirmed By — December 31, 2026 · Yes moves in steps of 0.005, between 0.01 and 0.99"],
      [order({ symbol: lad, limitPrice: 0.995 }), "E_VENUE_ORDER_INVALID", "Polymarket US: a price in National League Champion — Los Angeles Dodgers · Yes moves in steps of 0.001, between 0.01 and 0.99"],
      [order({ symbol: `${LAD.slug}:NO`, limitPrice: 0.004 }), "E_VENUE_ORDER_INVALID", "Polymarket US: a price in National League Champion — Los Angeles Dodgers · No moves in steps of 0.001, between 0.01 and 0.99"],
      [order({ symbol: lad, limitPrice: 1.2 }), "E_VENUE_ORDER_INVALID", "Polymarket US: a price at Polymarket US is in dollars, more than 0 and less than 1"],
      [order({ symbol: lad, side: "sell", limitPrice: 0.6, qty: 5 }), "E_VENUE_INSUFFICIENT", `Polymarket US: you hold 0 ${LAD.slug}:YES: 0 is free to sell, fewer than the 5 asked. A sell here is of what is held: selling more would buy the other side`],
      [order({ symbol: "LAD" }), "E_ACCOUNT_BAD_ACTION", 'a Polymarket US market is named <market slug>:YES or <market slug>:NO, not "LAD"'],
    ];
    for (const [o, code, message] of cases) {
      const no = refusal(await t.place(o));
      expect([o.symbol, no.code, no.message]).toEqual([o.symbol, code, message]);
    }
    expect(posts(k)).toEqual([]);
  });

  it("a sell counts what the account's orders already resting sell first, and never more than Polymarket US's own qtyAvailableDecimal", async () => {
    const resting = [pmOrder({ id: "o-7", intent: "ORDER_INTENT_SELL_LONG", side: "ORDER_SIDE_SELL", quantity: 7, leavesQuantity: 7 }), pmOrder({ id: "o-8", intent: "ORDER_INTENT_BUY_SHORT", quantity: 9, leavesQuantity: 9 })];
    const k = fakePmus({ positions: { [LAD.slug as string]: { netPositionDecimal: "10.0000", qtyAvailableDecimal: "10.0000" } }, open: resting });
    const { t } = await connect(k);
    const no = refusal(await t.place(order({ symbol: `${LAD.slug}:YES`, side: "sell", limitPrice: 0.6, qty: 5 })));
    expect([no.code, no.message, no.detail]).toEqual(["E_VENUE_INSUFFICIENT", `Polymarket US: you hold 10 ${LAD.slug}:YES, and orders already resting at Polymarket US sell 7 of it: 3 is free to sell, fewer than the 5 asked. A sell here is of what is held: selling more would buy the other side`, { held: 10, qty: 5, resting: 7 }]);
    expect(state(await t.place(order({ symbol: `${LAD.slug}:YES`, side: "sell", limitPrice: 0.6, qty: 3 }))).status).toBe("open");
    const lean = fakePmus({ positions: { [LAD.slug as string]: { netPositionDecimal: "10.0000", qtyAvailableDecimal: "2.0000" } } });
    const two = await connect(lean);
    expect(refusal(await two.t.place(order({ symbol: `${LAD.slug}:YES`, side: "sell", limitPrice: 0.6, qty: 3 }))).message).toContain(": 2 is free to sell, fewer than the 3 asked");
  });

  it("a resting order is sent without waiting and read back once; a day order goes good-till-date at the next 5:00 pm ET trade day roll (Polymarket US's own DAY does not cancel itself); post-only is participateDontInitiate", async () => {
    const k = fakePmus();
    const { t } = await connect(k);
    const n = k.sent.length;
    const st = state(await t.place(order({ symbol: `${LAD.slug}:YES`, limitPrice: 0.55, qty: 2, tif: "day", postOnly: true })));
    expect(k.since(n)).toEqual([`GET gw /v1/market/slug/${LAD.slug}`, `GET gw /v1/markets/${LAD.slug}/bbo`, "POST api /v1/orders", "GET api /v1/order/ord-1"]);
    expect(posts(k)[0]!.body).toEqual({ marketSlug: LAD.slug, type: "ORDER_TYPE_LIMIT", price: { value: "0.55", currency: "USD" }, quantity: 2, tif: "TIME_IN_FORCE_GOOD_TILL_DATE", intent: "ORDER_INTENT_BUY_LONG", manualOrderIndicator: "MANUAL_ORDER_INDICATOR_AUTOMATIC", goodTillTime: "2026-10-08T21:00:00Z", participateDontInitiate: true });
    expect([st.ref, st.status, st.filledQty]).toEqual(["ord-1", "open", 0]);
    // rejected after it was taken: its reason is in the order stream, not the order
    const late = fakePmus({ routes: (s) => (s.method === "GET" && s.path.startsWith("/v1/order/") ? json({ order: pmOrder({ id: "ord-1", state: "ORDER_STATE_REJECTED" }) }) : undefined) });
    const { t: t2 } = await connect(late);
    const no = refusal(await t2.place(order({ symbol: `${LAD.slug}:YES`, limitPrice: 0.55, qty: 2 })));
    expect([no.code, no.message]).toEqual(["E_VENUE_REJECTED", "Polymarket US rejected the order after taking it (order ord-1): the order it lists says rejected, and its reason is not in it"]);
    // a day order in the roll's last seconds would end before it rested
    k.now = Date.parse("2026-10-08T20:59:55.000Z");
    const soon = refusal(await t.place(order({ symbol: `${LAD.slug}:YES`, limitPrice: 0.55, tif: "day" })));
    expect([soon.code, soon.detail]).toEqual(["E_VENUE_ORDER_INVALID", { expiresAt: "2026-10-08T21:00:00Z" }]);
  });

  it("a day order ends at the next 5:00 pm in New York, every day of the week — the offset read at the deadline itself, so the night the clocks change too", () => {
    const end = (iso: string) => new Date(pmusDayEnd(Date.parse(iso))).toISOString();
    expect(end("2026-10-08T14:00:00.000Z")).toBe("2026-10-08T21:00:00.000Z");
    expect(end("2026-10-08T21:00:00.000Z")).toBe("2026-10-09T21:00:00.000Z");
    expect(end("2026-10-08T23:30:00.000Z")).toBe("2026-10-09T21:00:00.000Z");
    expect(end("2026-10-10T15:00:00.000Z")).toBe("2026-10-10T21:00:00.000Z");
    expect(end("2026-12-01T15:00:00.000Z")).toBe("2026-12-01T22:00:00.000Z");
    // 1 November 2026: New York goes back to EST at 2am; 6pm EDT on 31 October ends at 5pm EST the next day
    expect(end("2026-10-31T22:00:00.000Z")).toBe("2026-11-01T22:00:00.000Z");
    expect(end("2026-11-01T12:00:00.000Z")).toBe("2026-11-01T22:00:00.000Z");
  });
});

describe("Polymarket US's refusals, in its own words", () => {
  const refusedWith = async (answer: HttpReply) => {
    const k = fakePmus({ routes: (s) => (s.method === "POST" && s.path === "/v1/orders" ? answer : undefined) });
    const { t } = await connect(k);
    return { no: refusal(await t.place(order({ symbol: `${LAD.slug}:YES`, limitPrice: 0.6, qty: 2 }))), t };
  };

  it("buying power, a closed market, an order as written, a key it does not accept, a place (its own rule), a key that may not trade, its rate limit", async () => {
    const cases: Array<[HttpReply, string, string]> = [
      [grpc(400, 3, "insufficient buying power: order requires $1.20"), "E_VENUE_INSUFFICIENT", "Polymarket US: not enough buying power for this order: “insufficient buying power: order requires $1.20”"],
      [grpc(400, 9, "market is closed"), "E_VENUE_MARKET_CLOSED", "Polymarket US: the market takes no orders now: “market is closed”"],
      [grpc(400, 3, "quantity must be a multiple of minimumTradeQty"), "E_VENUE_ORDER_INVALID", "Polymarket US: it does not take this order as written: “quantity must be a multiple of minimumTradeQty”"],
      [grpc(401, 16, "unauthenticated"), "E_VENUE_UNAUTHORIZED", "Polymarket US does not accept this key: its Key ID, its Secret Key, or this machine's clock (a timestamp more than 30 seconds from Polymarket US's is refused): “unauthenticated”"],
      [grpc(403, 7, "Trading is not available in your state"), "E_VENUE_GEOBLOCKED", "Polymarket US does not take this from where this account is: that is its own rule, and the account does not look for a way around it"],
      [grpc(403, 7, "permission denied"), "E_VENUE_PERMISSION", "Polymarket US refused: this key may not do this: “permission denied”"],
      [json({ status: 429, message: "Too Many Requests" }, 429), "E_VENUE_UNREACHABLE", "Polymarket US is rate-limiting this machine: try again in a minute"],
    ];
    for (const [answer, code, message] of cases) {
      const { no, t } = await refusedWith(answer);
      expect([no.code, no.message]).toEqual([code, message]);
      expect((no.native as { status: number }).status).toBe(answer.status);
      if (code === "E_VENUE_PERMISSION") expect([t.can, t.whyNot]).toEqual([false, message]);
    }
  });

  it("an order it took and rejected at once, by its reason: the latency stopgap (not a rate limit: it may be sent again), the market closed, a price off its increment, a place", async () => {
    const rejected = (reason: string, text: string) => json({ id: "o-9", executions: [{ id: "x-9", type: "EXECUTION_TYPE_REJECTED", orderRejectReason: reason, text, order: pmOrder({ id: "o-9", state: "ORDER_STATE_REJECTED" }) }] });
    const k = fakePmus({ routes: (s) => (s.method === "POST" && s.path === "/v1/orders" ? (s.body!.quantity === 1 ? rejected("ORD_REJECT_REASON_EXCHANGE_OPTION", "Global Rate Limit Exceeded") : s.body!.quantity === 2 ? rejected("ORD_REJECT_REASON_EXCHANGE_CLOSED", "") : s.body!.quantity === 3 ? rejected("ORD_REJECT_REASON_INVALID_PRICE_INCREMENT", "price 0.6005 not on tick") : rejected("ORD_REJECT_REASON_EXCHANGE_OPTION", "Not available in your state")) : undefined) });
    const { t } = await connect(k);
    const place = async (qty: number) => refusal(await t.place(order({ symbol: `${LAD.slug}:YES`, type: "market", qty })));
    const stop = await place(1);
    expect([stop.code, stop.message, stop.native]).toEqual(["E_VENUE_REJECTED", "Polymarket US turned the order away with its latency stopgap (“Global Rate Limit Exceeded”: not processed within five seconds, so not placed). Polymarket US says it is not a rate limit: it may be sent again", { orderId: "o-9", orderRejectReason: "ORD_REJECT_REASON_EXCHANGE_OPTION", text: "Global Rate Limit Exceeded" }]);
    expect([(await place(2)).code, (await place(2)).message]).toEqual(["E_VENUE_MARKET_CLOSED", "Polymarket US rejected the order: “Exchange/market is closed”"]);
    expect([(await place(3)).code, (await place(3)).message]).toEqual(["E_VENUE_ORDER_INVALID", "Polymarket US: it rejected the order: “Price not on valid increment” (“price 0.6005 not on tick”)"]);
    expect((await place(4)).code).toBe("E_VENUE_GEOBLOCKED");
  });

  it("nothing secret leaves in a refusal or a log line, even when the answer carries the Secret Key, its seed or the Key ID", async () => {
    const logs = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    // an answer that carries the Secret Key, its seed and the Key ID back
    let echoed = "";
    const echo = fakePmus({ routes: (s) => (s.method === "POST" && s.path === "/v1/orders" ? grpc(400, 3, echoed) : undefined) });
    echoed = `bad key ${KEY_ID} ${echo.secret} ${echo.seedHex}`;
    const { t } = await connect(echo);
    const no = refusal(await t.place(order({ symbol: `${LAD.slug}:YES`, limitPrice: 0.6 })));
    expect(no.message).toBe("Polymarket US: it does not take this order as written: “bad key ••• ••• •••”");
    // a network failure whose message carries the Secret Key
    const thrown = fakePmus({ throwOn: (s) => s.method === "POST" });
    const { t: t2 } = await connect(thrown);
    const lost = refusal(await t2.place(order({ symbol: `${LAD.slug}:YES`, limitPrice: 0.6 })));
    expect(lost.code).toBe("E_VENUE_UNREACHABLE");
    const said = [JSON.stringify(no), JSON.stringify(lost), ...logs.flatMap((l) => l.mock.calls.map((c) => JSON.stringify(c)))].join("\n");
    for (const secret of [echo.secret, echo.seedHex, thrown.secret, thrown.seedHex, KEY_ID]) expect(said).not.toContain(secret);
  });

  it("an order it did not answer for may be there all the same: said as unknown, never as not placed — Polymarket US takes no client order id, so what rests alike since it was sent is shown, not taken for it", async () => {
    const alike = pmOrder({ id: "o-77", price: amount("0.6000"), quantity: 2, leavesQuantity: 2, createTime: "2026-10-08T14:00:00.500Z" });
    const other = pmOrder({ id: "o-78", price: amount("0.5900"), quantity: 2, leavesQuantity: 2, createTime: "2026-10-08T14:00:00.500Z" });
    const old = pmOrder({ id: "o-79", price: amount("0.6000"), quantity: 2, leavesQuantity: 2, createTime: "2026-10-08T13:00:00.000Z" });
    for (const k of [fakePmus({ open: [alike, other, old], throwOn: (s) => s.method === "POST" }), fakePmus({ open: [alike, other, old], routes: (s) => (s.method === "POST" ? json({ message: "bad gateway" }, 502) : undefined) })]) {
      const { t } = await connect(k);
      const no = refusal(await t.place(order({ symbol: `${LAD.slug}:YES`, limitPrice: 0.6, qty: 2 })));
      expect([no.code, no.detail]).toEqual(["E_VENUE_UNREACHABLE", { placed: "unknown", marketSlug: LAD.slug }]);
      expect(no.message).toContain("it may have been taken all the same. Polymarket US takes no client order id, so the account cannot look it up by one");
      expect((no.native as { restingAlike?: unknown }).restingAlike).toEqual([{ id: "o-77", state: "ORDER_STATE_NEW", createTime: "2026-10-08T14:00:00.500Z" }]);
    }
  });
});

describe("status(), cancel() and openOrders(): what became of an order", () => {
  it("NEW is open (partial once some filled), PARTIALLY_FILLED partial, FILLED filled at its average — a NO order's 1 − the YES price — CANCELED, EXPIRED, REJECTED; not yet on the book is pending; an id it does not have is unknown", async () => {
    const orders: Record<string, Rec> = {
      a: pmOrder({ id: "a" }),
      b: pmOrder({ id: "b", cumQuantity: 4, leavesQuantity: 6 }),
      c: pmOrder({ id: "c", state: "ORDER_STATE_PARTIALLY_FILLED", cumQuantity: 4, leavesQuantity: 6, avgPx: amount("0.6000") }),
      d: pmOrder({ id: "d", intent: "ORDER_INTENT_BUY_SHORT", state: "ORDER_STATE_FILLED", cumQuantity: 10, leavesQuantity: 0, avgPx: amount("0.5800"), commissionNotionalTotalCollected: amount("0.12") }),
      e: pmOrder({ id: "e", state: "ORDER_STATE_CANCELED", cumQuantity: 2, leavesQuantity: 0 }),
      f: pmOrder({ id: "f", state: "ORDER_STATE_EXPIRED" }),
      g: pmOrder({ id: "g", state: "ORDER_STATE_REJECTED" }),
      h: pmOrder({ id: "h", state: "ORDER_STATE_PENDING_NEW" }),
      i: pmOrder({ id: "i", state: "ORDER_STATE_PENDING_CANCEL" }),
    };
    const k = fakePmus({ orders });
    const { t } = await connect(k);
    const got: Array<[string, string, number, number | undefined, number | undefined]> = [];
    for (const id of Object.keys(orders)) {
      const st = state(await t.status(id, `${LAD.slug}:YES`));
      got.push([st.ref, st.status, st.filledQty, st.avgPrice, st.feeUsd]);
    }
    expect(got).toEqual([
      ["a", "open", 0, undefined, undefined],
      ["b", "partial", 4, undefined, undefined],
      ["c", "partial", 4, 0.6, undefined],
      ["d", "filled", 10, 0.42, 0.12],
      ["e", "canceled", 2, undefined, undefined],
      ["f", "expired", 0, undefined, undefined],
      ["g", "rejected", 0, undefined, undefined],
      ["h", "pending", 0, undefined, undefined],
      ["i", "open", 0, undefined, undefined],
    ]);
    expect(refusal(await t.status("zz", `${LAD.slug}:YES`)).code).toBe("E_ACCOUNT_ORDER_UNKNOWN");
    const n = k.sent.length;
    expect(refusal(await t.status("../../v1/account/balances", `${LAD.slug}:YES`)).code).toBe("E_ACCOUNT_ORDER_UNKNOWN");
    expect(k.sent.length).toBe(n);
  });

  it("cancel: POST /v1/order/{id}/cancel with its market's slug, signed over its path; then the order as it stands. One already done is the order as it is; one still on the book after a refused cancel is said as that", async () => {
    const k = fakePmus({ orders: { "o-5": pmOrder({ id: "o-5" }), "o-6": pmOrder({ id: "o-6", state: "ORDER_STATE_FILLED", cumQuantity: 10, leavesQuantity: 0, avgPx: amount("0.6000") }), "o-7": pmOrder({ id: "o-7" }) }, routes: (s) => (s.method === "POST" && /o-(6|7)\/cancel$/.test(s.path) ? grpc(400, 9, "order cannot be canceled") : undefined) });
    const { t } = await connect(k);
    const n = k.sent.length;
    const gone = state(await t.cancel("o-5", `${LAD.slug}:YES`));
    expect(k.since(n)).toEqual(["POST api /v1/order/o-5/cancel", "GET api /v1/order/o-5"]);
    expect(k.sent[n]!.body).toEqual({ marketSlug: LAD.slug });
    expect([gone.status, (gone.native as { cancel: unknown }).cancel]).toEqual(["canceled", {}]);
    expect(state(await t.cancel("o-6", `${LAD.slug}:YES`)).status).toBe("filled");
    const kept = refusal(await t.cancel("o-7", `${LAD.slug}:YES`));
    expect([kept.code, kept.message]).toEqual(["E_VENUE_REJECTED", "Polymarket US did not take the cancel (HTTP 400), and the order is still on its book: cancel it at Polymarket US"]);
  });

  it("openOrders(): the account's orders resting at Polymarket US, each named by its market and outcome, a NO order's limit in NO's own terms; one market's, when asked", async () => {
    const k = fakePmus({ open: [pmOrder({ id: "o-1", intent: "ORDER_INTENT_BUY_SHORT", price: amount("0.6000") }), pmOrder({ id: "o-2", marketSlug: BTC.slug, intent: "ORDER_INTENT_SELL_LONG", side: "ORDER_SIDE_SELL", price: amount("0.0500"), quantity: 5, cumQuantity: 2, leavesQuantity: 3, state: "ORDER_STATE_PARTIALLY_FILLED" })] });
    const { t } = await connect(k);
    const all = (await t.openOrders()) as Array<OrderState & { symbol: string; side: string; limitPrice?: number }>;
    expect(all.map((o) => [o.ref, o.status, o.filledQty, o.symbol, o.side, o.limitPrice])).toEqual([
      ["o-1", "open", 0, `${LAD.slug}:NO`, "buy", 0.4],
      ["o-2", "partial", 2, `${BTC.slug}:YES`, "sell", 0.05],
    ]);
    expect(((await t.openOrders(`${LAD.slug}:NO`)) as OrderState[]).map((o) => o.ref)).toEqual(["o-1"]);
    expect(refusal(await t.openOrders("LAD")).code).toBe("E_ACCOUNT_BAD_ACTION");
  });
});

describe("markets(), events() and candles(): what there is to trade at Polymarket US, from its public gateway", () => {
  it("markets(''): the most traded open markets of each of its categories in turn (orderBy=volume), both outcomes of each, kept a minute; a query is its own search, and a slug is asked as itself", async () => {
    const k = fakePmus();
    const { t } = await connect(k);
    const n = k.sent.length;
    const list = (await t.markets("")) as Market[];
    expect(k.since(n)).toEqual(["politics", "finance", "crypto", "macro", "geopolitics", "technology"].map((c) => `GET gw /v1/markets?active=true&closed=false&categories=${c}&orderBy=volume&orderDirection=desc&limit=6`));
    expect(list.filter((m) => m.outcome === "YES").map((m) => m.group!.id)).toEqual([HOUSE.slug, ANTH.slug, BTC.slug, SENATE.slug, BTC90.slug, ONE_SIDED.slug]);
    expect(list.every((m) => m.types.length === 2)).toBe(true);
    await t.markets("");
    expect(k.sent.length).toBe(n + 6);
    const found = (await t.markets("bitcoin")) as Market[];
    expect(k.since(n + 6)).toEqual(["GET gw /v1/search?query=bitcoin&limit=10"]);
    expect(found.map((m) => m.symbol)).toEqual([`${BTC.slug}:YES`, `${BTC.slug}:NO`, `${BTC90.slug}:YES`, `${BTC90.slug}:NO`]);
    const exact = (await t.markets(BTC90.slug as string)) as Market[];
    expect(exact[0]!.symbol).toBe(`${BTC90.slug}:YES`);
    expect(noKeyHeaders(k)).toBe(true);
  });

  it("events(): the most traded open markets, in one category when asked (in its own word) or each in turn, ending within a window when asked, at most `limit` legs", async () => {
    const k = fakePmus();
    const { t } = await connect(k);
    const n = k.sent.length;
    const crypto = (await t.events!({ category: "Crypto", limit: 10 })) as Market[];
    expect(k.since(n)).toEqual(["GET gw /v1/markets?active=true&closed=false&categories=crypto&orderBy=volume&orderDirection=desc&limit=6"]);
    expect(crypto.map((m) => [m.symbol, m.category])).toEqual([[`${BTC.slug}:YES`, "Crypto"], [`${BTC.slug}:NO`, "Crypto"], [`${BTC90.slug}:YES`, "Crypto"], [`${BTC90.slug}:NO`, "Crypto"]]);
    expect(((await t.events!({ limit: 4 })) as Market[]).map((m) => m.symbol)).toEqual([`${HOUSE.slug}:YES`, `${HOUSE.slug}:NO`, `${ANTH.slug}:YES`, `${ANTH.slug}:NO`]);
    const soon = (await t.events!({ closingWithinMs: DAY, limit: 10 })) as Market[];
    expect(k.sent.at(-1)!.query.get("endDateMin")).toBe("2026-10-08T14:00:00Z");
    expect(k.sent.at(-1)!.query.get("endDateMax")).toBe("2026-10-09T14:00:00Z");
    expect(soon.map((m) => m.symbol)).toEqual([`${BTC90.slug}:YES`, `${BTC90.slug}:NO`]);
    expect(refusal(await t.events!({ closingWithinMs: -1, limit: 4 })).code).toBe("E_ACCOUNT_BAD_ACTION");
  });

  it("candles(): its book-derived display prices (YES from longPrice, NO from shortPrice) at the profile that covers the start, folded into bars with no volume; refused before anything is asked when the interval, the start or the name is not one", async () => {
    const at = (min: number, long: number, short: number) => ({ timestamp: (START - min * 60_000) / 1000, longPrice: long, shortPrice: short });
    const k = fakePmus({ history: [at(120, 0.55, 0.46), at(119, 0.56, 0.45), at(60, 0.58, 0.43), at(59, 0.57, 0.44), at(200, 0.5, 0.5)] });
    const { t } = await connect(k);
    const n = k.sent.length;
    const yes = await t.candles!(`${LAD.slug}:YES`, "1h", START - 2 * 3_600_000);
    expect(k.since(n)).toEqual([`GET gw /v1/price-history?symbol=${LAD.slug}&fixedInterval=INTERVAL_6H&fidelity=1`]);
    expect(yes).toEqual([
      { t: START - 2 * 3_600_000, o: 0.55, h: 0.56, l: 0.55, c: 0.56 },
      { t: START - 3_600_000, o: 0.58, h: 0.58, l: 0.57, c: 0.57 },
    ]);
    const no = await t.candles!(`${LAD.slug}:NO`, "1h", START - 2 * 3_600_000);
    expect(no).toEqual([
      { t: START - 2 * 3_600_000, o: 0.46, h: 0.46, l: 0.45, c: 0.45 },
      { t: START - 3_600_000, o: 0.43, h: 0.44, l: 0.43, c: 0.44 },
    ]);
    await t.candles!(`${LAD.slug}:YES`, "5m", START - 3_600_000);
    await t.candles!(`${LAD.slug}:YES`, "1d", START - 10 * DAY);
    await t.candles!(`${LAD.slug}:YES`, "1d", START - 60 * DAY);
    // the NO bars came from the same history, kept a minute: one request
    expect(k.since(n + 1).map((x) => x.slice(x.indexOf("fixedInterval")))).toEqual(["fixedInterval=INTERVAL_1D&fidelity=5", "fixedInterval=INTERVAL_1M&fidelity=180", "fixedInterval=INTERVAL_ALL&fidelity=180"]);
    const m = k.sent.length;
    expect(refusal(await t.candles!(`${LAD.slug}:YES`, "15m" as never, START - DAY)).code).toBe("E_ACCOUNT_BAD_ACTION");
    expect(refusal(await t.candles!(`${LAD.slug}:YES`, "1h", START + DAY)).code).toBe("E_ACCOUNT_BAD_ACTION");
    expect(refusal(await t.candles!("LAD", "1h", START - DAY)).code).toBe("E_ACCOUNT_BAD_ACTION");
    expect(k.sent.length).toBe(m);
  });

  it("the trader has no amend (Polymarket US's modify is a cancel-replace that answers no new id), no close of its own (its close-position has no price bound by default: a close here is a sell at the account's worst price) and no leverage", async () => {
    const { t } = await connect(fakePmus());
    expect([t.amend, t.close, t.setLeverage, typeof t.positions, typeof t.events, typeof t.candles]).toEqual([undefined, undefined, undefined, "function", "function", "function"]);
  });
});

describe("Polymarket US's public market data (Markets, before it is connected)", () => {
  it("its most traded open markets of each category in turn, both legs of each, with no order types and its own category word; only GETs to its gateway, with no key; kept, so a second look asks nothing", async () => {
    const k = fakePmus();
    expect(PUBLIC_HOSTS).toContain("gateway.polymarket.us");
    expect(PUBLIC_HOSTS).not.toContain("api.polymarket.us");
    const src = polymarketUsPublic({ http: k.http, clock: () => k.now });
    expect([src.id, src.name, src.kind, src.connectTo, src.connector]).toEqual(["polymarket-us", "Polymarket US", "events", "polymarket-us", "live:polymarket-us"]);
    const got = (await src.listings({ limit: 3 })) as Listing[];
    expect(got[0]).toEqual({ symbol: `${HOUSE.slug}:YES`, name: "U.S House Midterm Winner — Democratic Party · Yes", kind: "event", base: `${HOUSE.slug}:YES`, quote: "USD", price: 0.8995, bid: 0.899, ask: 0.9, open: true, types: [], group: { id: HOUSE.slug, title: "U.S House Midterm Winner — Democratic Party" }, outcome: "YES", closeTime: "2026-11-04T05:00:00Z", category: "Politics", tags: ["politics"] });
    expect(got.map((l) => l.symbol)).toEqual([`${HOUSE.slug}:YES`, `${HOUSE.slug}:NO`, `${ANTH.slug}:YES`, `${ANTH.slug}:NO`, `${BTC.slug}:YES`, `${BTC.slug}:NO`]);
    expect(k.sent.every((s) => s.method === "GET" && s.host === GW)).toBe(true);
    expect(noKeyHeaders(k)).toBe(true);
    expect(src.notes!({})).toEqual(["Polymarket US: the most traded open markets of politics, finance, crypto, macro, geopolitics and technology, in turn (its lists give no volume figure)."]);
    const n = k.sent.length;
    const soon = (await src.events!({ closingWithinMs: DAY, limit: 10 })) as Listing[];
    expect(soon.map((l) => l.symbol)).toEqual([`${BTC90.slug}:YES`, `${BTC90.slug}:NO`]);
    expect(k.sent.length).toBe(n);
    const found = (await src.listings({ q: "bitcoin", limit: 1 })) as Listing[];
    expect(found.map((l) => l.symbol)).toEqual([`${BTC.slug}:YES`, `${BTC.slug}:NO`]);
    expect(src.notes!({ q: "bitcoin" })).toEqual(["Polymarket US: its own search, which reaches every market it lists."]);
    const bars = await src.candles!(`${LAD.slug}:YES`, "1d", START - 10 * DAY);
    expect(Array.isArray(bars)).toBe(true);
  });

  it("a gateway that does not serve the network asked from says so in its words, and is held back ten minutes; one not answering, twenty seconds", async () => {
    const refusing = fakePmus({ routes: () => json({ message: "This service is not available in your country" }, 451) });
    const no = refusal(await polymarketUsPublic({ http: refusing.http, clock: () => START }).listings({ limit: 3 }));
    expect([no.code, holdBackMs(no)]).toEqual(["E_VENUE_GEOBLOCKED", 600_000]);
    const quiet = fakePmus({ routes: () => json({ message: "Service Unavailable" }, 503) });
    const late = refusal(await polymarketUsPublic({ http: quiet.http, clock: () => START }).listings({ limit: 3 }));
    expect([late.code, holdBackMs(late)]).toEqual(["E_VENUE_UNREACHABLE", 20_000]);
  });
});

describe("before a key is made: Polymarket US asked from the network the Account runs on", () => {
  it("its first, keyless question is its public gateway, carrying nothing that identifies anyone; an answer is an answer, its own refusal of the network is said in its words, no answer is unreachable", async () => {
    const asked: Array<{ url: string; headers: Record<string, string> }> = [];
    const deps = (answer: HttpReply | Error) => ({ http: (async (url: string, init: { headers?: Record<string, string> } = {}) => {
      asked.push({ url, headers: init.headers ?? {} });
      if (answer instanceof Error) throw answer;
      return answer;
    }) as Http, clock: () => START, mm: (async () => ({})) as unknown as RunMm });
    expect(await reachOf("live:polymarket-us", deps(json({ markets: [LAD] })))).toEqual({ connector: "live:polymarket-us", state: "ok", at: new Date(START).toISOString() });
    expect(asked.map((a) => a.url)).toEqual(["https://gateway.polymarket.us/v1/markets?limit=1"]);
    for (const a of asked) expect(Object.keys(a.headers).map((h) => h.toLowerCase()).filter((h) => /auth|key|sign|token|cookie|x-pm/.test(h))).toEqual([]);
    const shut = await reachOf("live:polymarket-us", deps(json({ message: "This service is not available in your country" }, 403)));
    expect([shut.state, shut.said]).toEqual(["location", "Polymarket US does not serve this location: that is its own rule, and the account does not look for a way around it. It answered: “This service is not available in your country”"]);
    expect((await reachOf("live:polymarket-us", deps(json({}, 503)))).state).toBe("unreachable");
    expect((await reachOf("live:polymarket-us", deps(new Error("ETIMEDOUT")))).state).toBe("unreachable");
  });

  it("the account's list of venues knows it — Polymarket US, under Markets and tokens, by a key file — and judges it by that answer", async () => {
    const home = mkdtempSync(join(tmpdir(), "pmus-venues-"));
    try {
      const catalog = venueCatalog(liveOptions(home).options);
      const entry = catalog.find((c) => c.connector === "live:polymarket-us");
      expect(entry).toEqual({ connector: "live:polymarket-us", name: "Polymarket US", group: "Markets and tokens", needs: "key-file" });
      const at = new Date(START).toISOString();
      const said = "Polymarket US does not serve this location: that is its own rule, and the account does not look for a way around it";
      const judged = await venuesHere({ connections: [entry!], reach: async (cs) => cs.map((c) => ({ connector: c, state: "location" as const, said, at })), connected: () => false, clock: () => START });
      expect(judged).toEqual([{ connector: "live:polymarket-us", name: "Polymarket US", group: "Markets and tokens", needs: "key-file", verdict: "not-served", said, connected: false, asked: at }]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("Markets: a Polymarket US market is one row by its slug, whichever account or listing names it", () => {
  /** a trader that lists the given markets and nothing else */
  const lister = (markets: Market[]): LiveTrader => ({ can: true, what: "event contracts", markets: async () => markets, market: async () => markets[0]!, place: async () => ({ ref: "", status: "pending", filledQty: 0, native: {} }), cancel: async () => ({ ref: "", status: "canceled", filledQty: 0, native: {} }), status: async () => ({ ref: "", status: "pending", filledQty: 0, native: {} }) });

  it("two Polymarket US accounts listing one market are one pmus: row with a line for each; the public listing of a venue connected is not asked", async () => {
    const k = fakePmus();
    const { t } = await connect(k);
    const lad = (await t.markets(LAD.slug as string)) as Market[];
    const venues: ExploreVenue[] = [
      { id: "polymarket-us", name: "Polymarket US", trader: lister(lad), connector: "live:polymarket-us" },
      { id: "polymarket-us-2", name: "Polymarket US · joint", trader: lister(lad), connector: "live:polymarket-us" },
    ];
    const pub = polymarketUsPublic({ http: k.http, clock: () => k.now });
    const spy = vi.spyOn(pub, "listings");
    const out = await exploreAcross({ connected: venues, public: [pub] }, { clock: () => START, q: "dodgers" });
    const row = out.items.find((i) => i.key === `pmus:${LAD.slug}`);
    expect(row?.at.map((a) => a.venue)).toEqual(["polymarket-us", "polymarket-us-2"]);
    expect(spy).not.toHaveBeenCalled();
    // not connected: the public rows are the same keys, marked to connect
    const open = await exploreAcross({ public: [polymarketUsPublic({ http: k.http, clock: () => k.now })] }, { clock: () => START });
    const house = open.items.find((i) => i.key === `pmus:${HOUSE.slug}`);
    expect([house?.tabs, house?.at[0]?.connectTo, house?.at[0]?.connector, house?.at[0]?.canTrade]).toEqual([["all", "predictions"], "polymarket-us", "live:polymarket-us", false]);
  });
});
