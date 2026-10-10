import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey } from "viem/accounts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { isRefusal, type Refusal } from "../../src/core/errors.ts";
import { liveScope, polymarketLiveAccount, scopeOf } from "../../src/portfolio/adapters/polymarket.ts";
import type { RunMm } from "../../src/portfolio/live/metamask.ts";
import { CLOSE_ONLY_WORDS, polymarketLocation, polymarketScope, polymarketTradeSource, readablePlace } from "../../src/portfolio/live/polymarket-clob.ts";
import { polymarketUsNo, polymarketUsSource, type PolymarketUsTrader } from "../../src/portfolio/live/polymarket-us.ts";
import { holdBackMs } from "../../src/portfolio/live/public-markets.ts";
import { reachOf } from "../../src/portfolio/live/reach.ts";
import type { ChainReader } from "../../src/portfolio/live/chain.ts";
import type { LiveTrader, OrderRequest } from "../../src/portfolio/live/trade.ts";
import type { Http, HttpReply } from "../../src/portfolio/live/types.ts";

/** The IP audit's Polymarket findings (2026-10-09): Polymarket's location check, its CLOB, its bridge, Polymarket US and the classic `mm`
 * adapter, met by answers this NETWORK gives — the server in front of a venue refusing it (a Cloudflare, Akamai or CloudFront page, or
 * Cloudflare's "error code: 1009"), a page answered in the venue's place, a proxy repeating the address it fetched, an order whose answer was
 * lost, a country code that names no place, a place rule met after the network changed. Every venue is a stand-in that answers what each
 * test says; nothing leaves the process. Addresses are from the documentation ranges (RFC 5737) */
const json = (body: unknown, status = 200): HttpReply => ({ status, body, text: JSON.stringify(body) });
const page = (text: string, status: number): HttpReply => ({ status, body: undefined, text });
const refusal = (x: unknown): Refusal => {
  if (!isRefusal(x)) throw new Error(`expected a refusal, got ${JSON.stringify(x)}`);
  return x;
};
const ok = <T>(x: T | Refusal): T => {
  if (isRefusal(x)) throw new Error(`expected an answer, got ${x.code}: ${x.message}`);
  return x;
};
const edgeOf = (r: Refusal): boolean | undefined => (r.native as { edge?: boolean } | undefined)?.edge;

// the pages, as the servers in front of venues send them (their shapes; the addresses are documentation ones)
const CF_CHALLENGE = `<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title></head><body><div id="challenge-body"></div><script>window._cf_chl_opt={cRay:'8c1f0a2b3d4e5f60',cUPMDTk:"\\/api\\/geoblock?__cf_chl_tk=made-up",cType:'managed'};</script></body></html>`;
const CF_BLOCKED = `<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body><h1>Sorry, you have been blocked</h1><p>You are unable to access polymarket.com. Your IP: 203.0.113.9</p><span>Cloudflare Ray ID: 8c1f0a2b3d4e5f60</span></body></html>`;
const AKAMAI = `<HTML><HEAD>\n<TITLE>Access Denied</TITLE>\n</HEAD><BODY>\n<H1>Access Denied</H1>\n \nYou don't have permission to access "http&#58;&#47;&#47;api&#46;polymarket&#46;us&#47;v1&#47;orders" on this server.<P>\nReference&#32;&#35;18&#46;6f3e1702&#46;1791225442&#46;1a2b3c4d\n</BODY>\n</HTML>`;
const CLOUDFRONT = `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN" "http://www.w3.org/TR/html4/loose.dtd"><HTML><HEAD><TITLE>ERROR: The request could not be satisfied</TITLE></HEAD><BODY><H1>403 ERROR</H1><H2>The request could not be satisfied.</H2>Request blocked. We can't connect to the server for this app or website at this time.</BODY></HTML>`;
const PROXY_502 = `<html><head><title>502 Bad Gateway</title></head><body><h1>Bad Gateway</h1><p>The proxy could not fetch https://polymarket.com/api/geoblock from upstream.</p></body></html>`;
const NGINX_404 = `<html>\r\n<head><title>404 Not Found</title></head>\r\n<body>\r\n<center><h1>404 Not Found</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>`;
const FILTER_200 = `<!DOCTYPE html><html><head><title>Web Page Blocked</title></head><body>Access to this site is blocked by your network administrator.</body></html>`;

// ---- Polymarket: its location check, its CLOB, its bridge --------------------------------------------------------------------------

const CLOB = "https://clob.polymarket.com";
const GAMMA = "https://gamma-api.polymarket.com";
const GEO = "https://polymarket.com/api/geoblock";
const DATA = "https://data-api.polymarket.com/v2";
const BRIDGE = "https://bridge.polymarket.com";
const GEO_WORDS = "Polymarket does not serve this location: that is its own rule, and the account does not look for a way around it";
const SLUG = "will-the-us-invade-iran-before-2027";
const CID = "0x5db999fad322cea2914535aae5517060c3f80ad6d8c0231cde2124a434d16846";
const YES = "55115078421062885512539156303747803058407616201213034911037320915726138659123";
const MARKET = { id: "665374", version: "v1", slug: SLUG, question: "Will the U.S. invade Iran before 2027?", conditionId: CID, outcomes: '["Yes", "No"]', outcomePrices: '["0.155", "0.845"]', clobTokenIds: `["${YES}", "1910830010387565971650098373488592514702818137344973088263643820608151819241"]`, active: true, closed: false, acceptingOrders: true, enableOrderBook: true, negRisk: false, archived: false, orderPriceMinTickSize: 0.01, orderMinSize: 5 };
const BOOK = { market: CID, asset_id: YES, bids: [{ price: "0.15", size: "340465.51" }], asks: [{ price: "0.16", size: "77813.8" }], min_order_size: "5", tick_size: "0.01", neg_risk: false, last_trade_price: "0.160" };
const CREDS = { apiKey: "7b1e2d60-6f9a-4dd7-8f3e-21b8f94c77a2", secret: "ABEiM0RVZneImaq7zN3u_wARIjNEVWZ3iJmqu8zd7v8=", passphrase: "made-up-passphrase-0001" };

type Answer = HttpReply | Error | Array<HttpReply | Error>;
/** Polymarket as a stand-in, by "METHOD url": a list is answered in turn, its last one from then on; anything not set up is a 404 */
function stand(answers: Record<string, Answer>, seen: string[]): Http {
  const all: Record<string, Answer> = {
    [`GET ${GEO}`]: json({ blocked: false, ip: "203.0.113.7", country: "IE", region: "L" }),
    [`GET ${CLOB}/auth/derive-api-key`]: json(CREDS),
    [`GET ${GAMMA}/markets/slug/${SLUG}`]: json(MARKET),
    [`GET ${CLOB}/book?token_id=${YES}`]: json(BOOK),
    ...answers,
  };
  return async (url, init = {}) => {
    const key = `${init.method ?? "GET"} ${url}`;
    seen.push(key);
    const a = all[key] ?? (url.startsWith(`${DATA}/positions`) ? json({ data: [], pagination: { next_cursor: null } }) : undefined);
    const next = Array.isArray(a) ? (a.length > 1 ? a.shift() : a[0]) : a;
    if (next === undefined) return json({ error: `not set up in this test: ${key}` }, 404);
    if (next instanceof Error) throw next;
    return next;
  };
}
const chain: ChainReader = { tokens: async (_h, refs) => ({ rows: refs.map((r) => ({ chain: r.chain, asset: r.asset, amount: 10 })), failed: [] }), native: async () => ({ rows: [], failed: [] }), uint: async () => undefined, decimals: async () => 6, receipt: async () => undefined };
const open = (answers: Record<string, Answer>, seen: string[] = []) => polymarketTradeSource({ venue: "polymarket-trade", label: "", reference: "", key: { privateKey: generatePrivateKey() }, http: stand(answers, seen), chain, clock: () => 1791225442000, salt: () => 479249096354 });
async function trader(answers: Record<string, Answer>): Promise<{ t: LiveTrader; seen: string[]; source: Awaited<ReturnType<typeof open>> }> {
  const seen: string[] = [];
  const source = await open(answers, seen);
  if (isRefusal(source)) throw new Error(`${source.code}: ${source.message}`);
  seen.splice(0);
  return { t: source.source.trader!, seen, source };
}
const buy = (over: Partial<OrderRequest> = {}): OrderRequest => ({ symbol: `${SLUG}:Yes`, side: "buy", type: "limit", qty: 10, limitPrice: 0.15, clientId: "0123456789abcdef0123456789abcdef", ...over });

describe("Polymarket's location check answered by the server in front of it (R1-12, R1-42)", () => {
  it("an edge's page or Cloudflare's 1009 is its refusal of this network, in its words and none of the page's, held ten minutes — not 'did not answer'", () => {
    for (const [r, title] of [[page(CF_CHALLENGE, 403), "Just a moment..."], [page(CF_BLOCKED, 403), "Attention Required! | Cloudflare"], [page("error code: 1009", 403), ""]] as const) {
      const no = refusal(polymarketLocation(r, "polymarket", "Polymarket"));
      expect([no.code, edgeOf(no), no.native]).toEqual(["E_VENUE_GEOBLOCKED", true, { status: 403, edge: true }]);
      expect(no.message).toContain("Polymarket refuses this network: the server in front of it answered HTTP 403");
      if (title) expect(no.message).toContain(`(“${title}”)`);
      expect(JSON.stringify(no)).not.toMatch(/203\.0\.113\.9|Sorry, you have been blocked|cf_chl/);
      expect(holdBackMs(no)).toBe(600_000);
    }
  });

  it("a page that repeats the check's own address is not a place: a proxy's 502, a 503 challenge carrying it escaped — no answer, asked again soon", () => {
    for (const r of [page(PROXY_502, 502), page(CF_CHALLENGE, 503)]) {
      const no = refusal(polymarketLocation(r, "polymarket", "Polymarket"));
      expect(no.code).toBe("E_VENUE_UNREACHABLE");
      expect(holdBackMs(no)).toBe(20_000);
    }
    // Polymarket's own words for a place, and its 451, are still its rule
    expect(refusal(polymarketLocation(json({ error: "Trading restricted in your region" }, 403), "polymarket", "Polymarket")).message).toBe(GEO_WORDS);
    expect(refusal(polymarketLocation(page("", 451), "polymarket", "Polymarket")).message).toBe(GEO_WORDS);
  });

  it("connecting and reach: the edge's refusal before anything else is asked; reach says location (so the editions' own rule can be looked at), not unreachable", async () => {
    const seen: string[] = [];
    const no = refusal(await open({ [`GET ${GEO}`]: page(CF_BLOCKED, 403) }, seen));
    expect([no.code, edgeOf(no)]).toEqual(["E_VENUE_GEOBLOCKED", true]);
    expect(seen).toEqual([`GET ${GEO}`]);
    const mm = (async () => {
      throw new Error("no mm in this test");
    }) as unknown as RunMm;
    const reach = await reachOf("live:polymarket-trade", { http: async () => page(CF_CHALLENGE, 403), clock: () => 1791225442000, mm });
    expect(reach.state).toBe("location");
    const proxied = await reachOf("live:polymarket-trade", { http: async () => page(PROXY_502, 502), clock: () => 1791225442000, mm });
    expect(proxied.state).toBe("unreachable");
  });
});

describe("Polymarket's CLOB and bridge answered by the server in front of them (R1-42)", () => {
  it("an edge's 403 page on POST /order, on DELETE /order, and on the location check before an order: its refusal, held ten minutes, never the key's permission", async () => {
    const { t } = await trader({ [`POST ${CLOB}/order`]: page(CF_BLOCKED, 403), [`DELETE ${CLOB}/order`]: page(AKAMAI, 403) });
    const placed = refusal(await t.place(buy()));
    expect([placed.code, placed.native]).toEqual(["E_VENUE_GEOBLOCKED", { status: 403, edge: true }]);
    expect(placed.message).toContain("(“Attention Required! | Cloudflare”)");
    expect(JSON.stringify(placed)).not.toMatch(/203\.0\.113\.9|Sorry, you have been blocked/);
    expect(holdBackMs(placed)).toBe(600_000);
    const canceled = refusal(await t.cancel(`0x${"ab".repeat(32)}`, `${SLUG}:Yes`));
    expect([canceled.code, canceled.native]).toEqual(["E_VENUE_GEOBLOCKED", { status: 403, edge: true }]);
    // the check before the order, refused by the edge: nothing else is asked
    const later = await trader({ [`GET ${GEO}`]: [json({ blocked: false }), page("error code: 1009", 403)] });
    const geo = refusal(await later.t.place(buy()));
    expect([geo.code, edgeOf(geo)]).toEqual(["E_VENUE_GEOBLOCKED", true]);
    expect(later.seen).toEqual([`GET ${GEO}`]);
  });

  it("a page answered with a 2xx in Polymarket's place: no answer, and an order met by one is looked up by its own hash — never 'refused'", async () => {
    const { t, seen } = await trader({ [`POST ${CLOB}/order`]: page(FILTER_200, 200) });
    const no = refusal(await t.place(buy()));
    expect(no.code).toBe("E_VENUE_UNREACHABLE");
    expect(no.message).toContain("Polymarket did not answer: something on this network answered in its place");
    expect(seen.filter((s) => s.startsWith(`GET ${CLOB}/data/order/0x`))).toHaveLength(1);
    expect(no.detail).toMatchObject({ placed: "unknown" });
    // a read met by one is no answer too
    const read = await trader({ [`GET ${GAMMA}/markets/slug/${SLUG}`]: page(FILTER_200, 200) });
    expect(refusal(await read.t.market(`${SLUG}:Yes`)).code).toBe("E_VENUE_UNREACHABLE");
  });

  it("the bridge: its 451 or place words are Polymarket's rule; an edge's page is that refusal; a 2xx page is no answer", async () => {
    const at = async (supported: HttpReply, deposit?: HttpReply) => {
      const { source } = await trader({ [`GET ${BRIDGE}/supported-assets`]: supported, ...(deposit ? { [`POST ${BRIDGE}/deposit`]: deposit } : {}) });
      return refusal(await ok(source).source.writer!.depositAddress("USDC", "Ethereum"));
    };
    const r451 = await at(json({ error: "not available in your region" }, 451));
    expect([r451.code, r451.message, r451.native]).toEqual(["E_VENUE_GEOBLOCKED", GEO_WORDS, { status: 451 }]);
    const edge = await at(page(CLOUDFRONT, 403));
    expect([edge.code, edge.native]).toEqual(["E_VENUE_GEOBLOCKED", { status: 403, edge: true }]);
    expect(edge.message).toContain("Polymarket's bridge refuses this network");
    expect(holdBackMs(edge)).toBe(600_000);
    const filtered = await at(page(FILTER_200, 200));
    expect([filtered.code, filtered.native]).toEqual(["E_VENUE_UNREACHABLE", { status: 200, page: true }]);
    // the deposit address asked of an edge
    const listed = json({ supportedAssets: [{ chainId: "1", chainName: "Ethereum", token: { name: "USD Coin", symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 }, minCheckoutUsd: 7 }] });
    expect(edgeOf(await at(listed, page(CF_BLOCKED, 403)))).toBe(true);
  });

  it("a refusal of an order as written keeps the venue's words with no address in them (no raw copy spread over the refusal)", async () => {
    const { t } = await trader({ [`POST ${CLOB}/order`]: json({ error: "Invalid order payload from 203.0.113.9" }, 400) });
    const no = refusal(await t.place(buy()));
    expect(no.code).toBe("E_VENUE_ORDER_INVALID");
    expect(JSON.stringify(no)).not.toContain("203.0.113.9");
  });
});

describe("a Polymarket order whose answer was lost, looked up on another network (R4-29)", () => {
  /** an order sent once, its answer lost (the connection reset), then looked up by its own hash — answered as the test says */
  const lostThen = async (lookup: HttpReply): Promise<{ no: Refusal; looked: string[] }> => {
    const looked: string[] = [];
    const http = stand({ [`POST ${CLOB}/order`]: new Error("socket hang up") }, []);
    const opened = ok(await polymarketTradeSource({ venue: "polymarket-trade", label: "", reference: "", key: { privateKey: generatePrivateKey() }, http: async (url, init) => (url.startsWith(`${CLOB}/data/order/0x`) ? (looked.push(url), lookup) : http(url, init)), chain, clock: () => 1791225442000, salt: () => 1 }));
    return { no: refusal(await opened.source.trader!.place(buy())), looked };
  };

  it("a filtering network's 200 page, a proxy's own 404 page, an edge's page, a 5xx: nothing said of the order — it may have been taken", async () => {
    for (const lookup of [page(FILTER_200, 200), page(NGINX_404, 404), page(CF_BLOCKED, 403), json({ error: "bad gateway" }, 502)]) {
      const { no, looked } = await lostThen(lookup);
      expect([no.code, looked.length]).toEqual(["E_VENUE_UNREACHABLE", 1]);
      expect(no.message).toContain("the order may have been taken all the same");
      expect(no.message).not.toContain("most likely nothing was placed");
      expect(no.detail).toMatchObject({ placed: "unknown" });
    }
  });

  it("Polymarket's own answers still say it is not there: its JSON 'Order not found', its empty null", async () => {
    for (const lookup of [json({ error: "Order not found" }, 404), json(null, 200)]) expect((await lostThen(lookup)).no.message).toContain("most likely nothing was placed");
  });
});

describe("a country code that names no place (R2-32)", () => {
  it("Cloudflare's XX (an address it cannot place) and T1 (Tor), with blocked: blocked completely, not close-only; Polymarket's own yes stays a yes", () => {
    expect([readablePlace("US"), readablePlace("XX"), readablePlace("T1"), readablePlace(""), readablePlace("USA")]).toEqual([true, false, false, false, false]);
    expect([polymarketScope({ blocked: true, country: "XX" }), polymarketScope({ blocked: true, country: "xx" }), polymarketScope({ blocked: true, country: "T1" }), polymarketScope({ blocked: false, country: "XX" }), polymarketScope({ blocked: true, country: "US" })]).toEqual(["blocked", "blocked", "blocked", "open", "close-only"]);
    const no = refusal(polymarketLocation(json({ blocked: true, ip: "203.0.113.7", country: "XX" }), "polymarket", "Polymarket"));
    expect([no.code, no.native]).toEqual(["E_VENUE_GEOBLOCKED", { blocked: true }]);
  });
});

// ---- Polymarket US ---------------------------------------------------------------------------------------------------------------

const API = "https://api.polymarket.us";
const GW = "https://gateway.polymarket.us";
const LAD_SLUG = "tec-mlb-nlchamp-2026-09-27-lad";
const LAD = { id: "7909", slug: LAD_SLUG, question: "National League Champion", title: "Los Angeles Dodgers", category: "sports", status: "MARKET_STATUS_OPEN", active: true, closed: false, orderPriceMinTickSize: 0.001, minimumTradeQty: 1, endDate: "2026-11-06T21:20:09Z", bestBidQuote: { value: "0.6020", currency: "USD" }, bestAskQuote: { value: "0.6030", currency: "USD" }, marketSides: [{ long: true, description: "Yes", tradable: true }, { long: false, description: "No", tradable: true }] };
const NEW_ORDER = { id: "o-1", marketSlug: LAD_SLUG, type: "ORDER_TYPE_LIMIT", price: { value: "0.6000", currency: "USD" }, quantity: 2, cumQuantity: 0, leavesQuantity: 2, intent: "ORDER_INTENT_BUY_LONG", state: "ORDER_STATE_NEW" };
const grpc = (status: number, code: number, message: string): HttpReply => json({ code, message, details: [] }, status);
type Route = (method: string, url: string) => HttpReply | undefined;

/** Polymarket US as a small stand-in: a $100 balance, no positions, the Dodgers market, an order resting; `route` answers first. The
 * signature is not checked here (the venue's own test file checks it) */
function pmus(route: Route = () => undefined): { http: Http; sent: string[]; set(r: Route): void } {
  let current = route;
  const sent: string[] = [];
  const http: Http = async (url, init = {}) => {
    const method = init.method ?? "GET";
    sent.push(`${method} ${url}`);
    const custom = current(method, url);
    if (custom) return custom;
    if (url === `${API}/v1/account/balances`) return json({ balances: [{ currentBalance: 100, currency: "USD", buyingPower: 100 }] });
    if (url.startsWith(`${API}/v1/portfolio/positions`)) return json({ positions: {}, nextCursor: "", eof: true });
    if (url === `${API}/v1/orders/open`) return json({ orders: [] });
    if (url === `${GW}/v1/market/slug/${LAD_SLUG}`) return json({ market: LAD });
    if (url === `${GW}/v1/markets/${LAD_SLUG}/bbo`) return json({ marketData: { marketSlug: LAD_SLUG, bestBid: LAD.bestBidQuote, bestAsk: LAD.bestAskQuote, state: "MARKET_STATE_OPEN" } });
    if (method === "POST" && url === `${API}/v1/orders`) return json({ id: "o-1" });
    if (url === `${API}/v1/order/o-1`) return json({ order: NEW_ORDER });
    return grpc(404, 5, "The server was unable to process your request.");
  };
  return { http, sent, set: (r) => (current = r) };
}
const SECRET = randomBytes(64).toString("base64");
const connectUs = (http: Http) => polymarketUsSource({ venue: "polymarket-us", label: "", reference: "", key: { keyId: "0b7e9c1a-3d2f-4e5a-9b8c-7d6e5f4a3b2c", secretKey: SECRET }, http, clock: () => 1791225442000 });
async function usTrader(route?: Route): Promise<{ t: PolymarketUsTrader; k: ReturnType<typeof pmus> }> {
  const k = pmus(route);
  const opened = ok(await connectUs(k.http));
  return { t: opened.source.trader as PolymarketUsTrader, k };
}
const usOrder = (over: Partial<OrderRequest> = {}): OrderRequest => ({ symbol: `${LAD_SLUG}:YES`, side: "buy", type: "limit", qty: 2, limitPrice: 0.6, clientId: "0123456789abcdef0123456789abcdef", ...over });
const ordersPost = (m: string, u: string) => m === "POST" && u === `${API}/v1/orders`;

describe("Polymarket US answered by the server in front of it (R1-13, R1-40)", () => {
  it("Cloudflare's challenge, Akamai's Access Denied, CloudFront's request blocked: the edge's refusal, held ten minutes; Polymarket US's own JSON 403 is still the key's permission", () => {
    for (const text of [CF_CHALLENGE, CF_BLOCKED, AKAMAI, CLOUDFRONT, "error code: 1020"]) {
      const no = polymarketUsNo("polymarket-us", "Polymarket US", page(text, 403), []);
      expect([no.code, no.native], text.slice(0, 40)).toEqual(["E_VENUE_GEOBLOCKED", { status: 403, edge: true }]);
      expect(no.message).toContain("Polymarket US refuses this network");
      expect(holdBackMs(no)).toBe(600_000);
    }
    const own = polymarketUsNo("polymarket-us", "Polymarket US", grpc(403, 7, "permission denied"), []);
    expect([own.code, holdBackMs(own)]).toEqual(["E_VENUE_PERMISSION", 0]);
    // a page answered with a 2xx in its place: no answer
    const filtered = polymarketUsNo("polymarket-us", "Polymarket US", page(FILTER_200, 200), []);
    expect([filtered.code, filtered.native]).toEqual(["E_VENUE_UNREACHABLE", { status: 200, page: true }]);
  });

  it("on connecting and on a keyless gateway read: the edge's refusal, not 'this key may not do this'", async () => {
    const shut = refusal(await connectUs(pmus((_m, u) => (u === `${API}/v1/account/balances` ? page(AKAMAI, 403) : undefined)).http));
    expect([shut.code, edgeOf(shut)]).toEqual(["E_VENUE_GEOBLOCKED", true]);
    const { t } = await usTrader((_m, u) => (u.startsWith(GW) ? page(CF_BLOCKED, 403) : undefined));
    const read = refusal(await t.market(`${LAD_SLUG}:YES`));
    expect([read.code, edgeOf(read)]).toEqual(["E_VENUE_GEOBLOCKED", true]);
    expect(JSON.stringify(read)).not.toContain("203.0.113.9");
  });

  it("an edge's page on an order does not mark the key unable to trade: the next order, once the edge lets this network through, is sent", async () => {
    for (const text of [AKAMAI, CF_BLOCKED]) {
      const { t, k } = await usTrader((m, u) => (ordersPost(m, u) ? page(text, 403) : undefined));
      const no = refusal(await t.place(usOrder()));
      expect([no.code, edgeOf(no)]).toEqual(["E_VENUE_GEOBLOCKED", true]);
      expect([t.can, t.whyNot]).toEqual(["unknown", undefined]);
      k.set(() => undefined);
      const before = k.sent.filter((s) => s === `POST ${API}/v1/orders`).length;
      expect(ok(await t.place(usOrder())).ref).toBe("o-1");
      expect(k.sent.filter((s) => s === `POST ${API}/v1/orders`).length).toBe(before + 1);
      expect(t.can).toBe(true);
    }
    // a 403 that is neither Polymarket US's own answer nor a page it knows (empty, another server's JSON): said, and the key not marked
    for (const r of [page("", 403), json({ message: "Forbidden" }, 403)]) {
      const { t } = await usTrader((m, u) => (ordersPost(m, u) ? r : undefined));
      expect(refusal(await t.place(usOrder())).code).toBe("E_VENUE_PERMISSION");
      expect(t.can).toBe("unknown");
    }
  });
});

describe("Polymarket US's words read as a place only when they are about one (R2-26)", () => {
  it("an account's state is not a place; a market slug it repeats is not a place; its own words for a state are", async () => {
    const say = (r: HttpReply, order = false) => polymarketUsNo("polymarket-us", "Polymarket US", r, [], order);
    const state = say(grpc(403, 7, "permission denied: account state is not ACTIVE"));
    expect([state.code, holdBackMs(state)]).toEqual(["E_VENUE_PERMISSION", 0]);
    expect(say(grpc(400, 9, "market 'geo-blocked-countries-2026' is closed"), true).code).toBe("E_VENUE_ORDER_INVALID");
    expect(say(grpc(400, 3, "quantity invalid for will-apple-ship-geolocation-ban"), true).code).toBe("E_VENUE_ORDER_INVALID");
    expect(say(grpc(404, 5, "market will-the-us-geo-restrict-tiktok not found")).code).toBe("E_VENUE_REJECTED");
    expect(say(grpc(403, 7, "Trading is not available in your state")).code).toBe("E_VENUE_GEOBLOCKED");
    expect(say(grpc(400, 9, "Trading isn't available in your state")).code).toBe("E_VENUE_GEOBLOCKED");
    // on an order, Polymarket US's own 403 about the account marks the key, as it should
    const { t } = await usTrader((m, u) => (ordersPost(m, u) ? grpc(403, 7, "permission denied: account state is not ACTIVE") : undefined));
    expect(refusal(await t.place(usOrder())).code).toBe("E_VENUE_PERMISSION");
    expect(t.can).toBe(false);
    // a rejection naming a slug with geo words in it is not a place either
    const rejected = await usTrader((m, u) => (ordersPost(m, u) ? json({ id: "o-9", executions: [{ id: "x-9", type: "EXECUTION_TYPE_REJECTED", orderRejectReason: "ORD_REJECT_REASON_UNKNOWN_MARKET", text: "unknown market geo-blocked-countries-2026" }] }) : undefined));
    expect(refusal(await rejected.t.place(usOrder())).code).toBe("E_VENUE_REJECTED");
  });
});

describe("a Polymarket US cancel refused by a place or by the server in front of it (R4-15)", () => {
  it("its 451, its words for a place, an edge's page: that refusal, not 'did not take the cancel' — while the order still rests", async () => {
    for (const [r, edge] of [[grpc(451, 7, "Trading is not available in your location"), undefined], [page("", 451), undefined], [grpc(403, 7, "not available in your state"), undefined], [page(CF_BLOCKED, 403), true]] as const) {
      const { t } = await usTrader((m, u) => (m === "POST" && u === `${API}/v1/order/o-1/cancel` ? r : undefined));
      const no = refusal(await t.cancel("o-1", `${LAD_SLUG}:YES`));
      expect([no.code, edgeOf(no)]).toEqual(["E_VENUE_GEOBLOCKED", edge]);
    }
    // its own answer about the order (a 400, gRPC 9) is still read back
    const { t } = await usTrader((m, u) => (m === "POST" && u === `${API}/v1/order/o-1/cancel` ? grpc(400, 9, "order cannot be canceled") : undefined));
    const kept = refusal(await t.cancel("o-1", `${LAD_SLUG}:YES`));
    expect([kept.code, kept.message]).toEqual(["E_VENUE_REJECTED", "Polymarket US did not take the cancel (HTTP 400), and the order is still on its book: cancel it at Polymarket US"]);
  });
});

// ---- the classic --mm Polymarket adapter -------------------------------------------------------------------------------------------

describe("the classic --mm Polymarket adapter: Polymarket's lists, the check asked before every order, a start that does not fail (R4-23)", () => {
  const FED = "FED-DEC-HIKE25:YES";
  let dir = "";
  let bin = "";
  let stateFile = "";
  const was = { writes: process.env.PORTFOLIO_MM_WRITES, state: process.env.FAKE_MM_STATE };
  const answer = (s: { status?: "error"; geo: unknown }) => writeFileSync(stateFile, JSON.stringify(s));
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "fake-mm-classic-"));
    bin = join(dir, "mm");
    stateFile = join(dir, "state.json");
    // a fake mm: `predict status`, `predict geoblock` (from the state file, read on every call) and `predict markets get`; nothing else
    const script = [
      `#!${process.execPath}`,
      "const fs = require('fs');",
      "const args = process.argv.slice(2);",
      "const state = JSON.parse(fs.readFileSync(process.env.FAKE_MM_STATE, 'utf8'));",
      "const out = (data) => process.stdout.write(JSON.stringify({ ok: true, data }));",
      "const fail = (code, message) => { process.stdout.write(JSON.stringify({ ok: false, error: { code, message } })); process.exit(1); };",
      "if (args[0] === 'predict' && args[1] === 'status') state.status === 'error' ? fail('NETWORK_ERROR', 'fetch failed') : out({ result: { account: { depositWalletAddress: '0x2e234DAe75C793f67A35089C9d99245E1C58470b', deployed: true, credentials: true, setupComplete: true } } });",
      "else if (args[0] === 'predict' && args[1] === 'geoblock') state.geo === 'error' ? fail('NETWORK_ERROR', 'fetch failed') : state.geo === 'region' ? fail('PREDICT_GEOBLOCKED', 'Polymarket is not available in your region (PA, US)') : out({ result: state.geo });",
      "else if (args[0] === 'predict' && args[1] === 'markets') out({ result: { market: { question: 'Fed hikes 25 bps in December?', bestBid: 0.73, bestAsk: 0.74, outcomes: [{ name: 'Yes', tokenId: '123' }, { name: 'No', tokenId: '456' }] } } });",
      "else fail('UNSUPPORTED', 'not in this fake');",
    ].join("\n");
    writeFileSync(bin, script, { mode: 0o755 });
    process.env.FAKE_MM_STATE = stateFile;
    delete process.env.PORTFOLIO_MM_WRITES;
  });
  afterEach(() => answer({ geo: { blocked: false } }));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    if (was.state === undefined) delete process.env.FAKE_MM_STATE;
    else process.env.FAKE_MM_STATE = was.state;
    if (was.writes !== undefined) process.env.PORTFOLIO_MM_WRITES = was.writes;
  });
  const account = () => polymarketLiveAccount({ bin, timeoutMs: 10_000 });
  const trade = (side: "buy" | "sell") => ({ kind: "trade" as const, symbol: FED, side, qty: 10 });

  it("close-only (the United States, by Polymarket's lists): trade stays in scope, a buy is refused in its words, a sell goes on to the real-money switch", async () => {
    answer({ geo: { blocked: true, ip: "203.0.113.9", country: "US", region: "PA" } });
    const pm = await account();
    expect(pm.account.scope.can).toEqual(["read", "trade", "move", "redeem"]);
    expect(pm.account.closed).toBeUndefined();
    expect(pm.account.scope.limits[0]).toContain(CLOSE_ONLY_WORDS);
    const b = refusal(await pm.execute(trade("buy")));
    expect([b.code, b.native]).toEqual(["E_VENUE_GEOBLOCKED", { blocked: true, closeOnly: true }]);
    expect(refusal(await pm.execute(trade("sell"))).code).toBe("E_WALLET_LIVE_WRITES_OFF");
    expect(JSON.stringify([pm.account, b])).not.toMatch(/203\.0\.113\.9|"US"|"PA"/);
  });

  it("close-only on the website alone (Japan): as open as anywhere for the API; blocked completely (Iran): no trade, nothing goes", async () => {
    answer({ geo: { blocked: true, country: "JP", region: "13" } });
    expect(refusal(await (await account()).execute(trade("buy"))).code).toBe("E_WALLET_LIVE_WRITES_OFF");
    answer({ geo: { blocked: true, country: "IR" } });
    const ir = await account();
    expect([ir.account.scope.can, ir.account.closed]).toEqual([["read", "move", "redeem"], { trade: "takes no orders from this location" }]);
    expect(refusal(await ir.execute(trade("sell"))).code).toBe("E_VENUE_GEOBLOCKED");
  });

  it("the check is asked again before every order: the second order follows the new answer — mm's own region refusal, then no answer at all", async () => {
    answer({ geo: { blocked: false } });
    const pm = await account();
    expect(refusal(await pm.execute(trade("buy"))).code).toBe("E_WALLET_LIVE_WRITES_OFF");
    answer({ geo: "region" });
    expect(refusal(await pm.execute(trade("sell"))).code).toBe("E_VENUE_GEOBLOCKED");
    answer({ geo: "error" });
    const quiet = refusal(await pm.execute(trade("sell")));
    expect([quiet.code, quiet.message]).toEqual(["E_VENUE_UNREACHABLE", "Polymarket's location check did not answer (mm predict geoblock): nothing was placed, and it is asked again on the next order"]);
    answer({ geo: { blocked: false } });
    expect(refusal(await pm.execute(trade("sell"))).code).toBe("E_WALLET_LIVE_WRITES_OFF");
  });

  it("a check or a status that does not answer at start-up opens the account all the same — reading, and saying so — instead of stopping the server", async () => {
    answer({ geo: "error" });
    const pm = await account();
    expect(pm.account.scope.can).toEqual(["read", "trade", "move", "redeem"]);
    expect(pm.account.scope.limits[0]).toContain("did not answer at start-up");
    expect(refusal(await pm.execute(trade("buy"))).code).toBe("E_VENUE_UNREACHABLE");
    answer({ status: "error", geo: "error" });
    const none = await account();
    expect(none.account.scope.can).toEqual(["read"]);
    expect(none.account.scope.limits[1]).toBe("mm predict status did not answer at start-up: reads only until the server starts again");
    expect(await none.read()).toEqual([]);
  });

  it("the scope is read with Polymarket's lists, never keeping the place", () => {
    expect([scopeOf({ result: { blocked: true, country: "XX" } }), scopeOf({ blocked: true, country: "US" }), scopeOf("not json")]).toEqual(["blocked", "close-only", undefined]);
    expect(liveScope(true, undefined)).toEqual(["read", "trade", "move", "redeem"]);
  });
});
