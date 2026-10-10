import ccxt from "ccxt";
import { STATUS_CODES } from "node:http";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isRefusal, type Refusal } from "../../src/core/errors.ts";
import { hyperliquidSource, ondoSource, polymarketSource, walletSource } from "../../src/portfolio/live/address.ts";
import { CHAINS, type ChainName, type ChainReader, type TokenRef } from "../../src/portfolio/live/chain.ts";
import type { ExchangeClient, OpenExchange } from "../../src/portfolio/live/exchange.ts";
import { hyperliquidTradeSource, openHyperliquid, type HyperliquidClient, type OpenHyperliquid } from "../../src/portfolio/live/hyperliquid-trade.ts";
import { AGENT_NAME, heldTo, HYPERLIQUID_RULE, locator, placeOf, SUBDIVISION, TRACE, TRACE_MS, WRITE_MS, type Locator } from "../../src/portfolio/live/location.ts";
import type { RunMm } from "../../src/portfolio/live/metamask.ts";
import { holdBackMs } from "../../src/portfolio/live/public-markets.ts";
import { reachBanUntil, reachKeepMs, reachOf, type ReachDeps } from "../../src/portfolio/live/reach.ts";
import type { LiveTrader, OrderRequest } from "../../src/portfolio/live/trade.ts";
import type { Http, HttpReply, LiveBalance, LiveSource } from "../../src/portfolio/live/types.ts";

/** The IP audit's cluster "c" (2026-10-09): Hyperliquid's trading connection, where this user is (location.ts), each venue's first keyless
 * question (reach.ts) and the venues read by address (address.ts) — each as the user's own network answers it: an edge's page, a ban or a
 * rate limit held until its time, a page in the API's place, a place that is no place, a place spelled two ways, a part of a country a
 * lookup would not give, a network changed between two orders, a chain or a ledger not answering this time. The real exchange library's
 * Hyperliquid client is fed canned answers through its own reading of them; nothing leaves the process. Addresses are from the documentation
 * ranges (RFC 5737), and the API wallet's key is made here and thrown away */
const NOW = 1791484300000;
const DAY = 86_400_000;
const ACCOUNT = "0x0000000000000000000000000000000000a11ce5";
const PK = generatePrivateKey();
const AGENT = privateKeyToAccount(PK).address;
const GEO = "https://polymarket.com/api/geoblock";
const HL = "https://api.hyperliquid.xyz/info";
type Dict = Record<string, unknown>;
const lib = ccxt as unknown as { hyperliquid: new (o: Dict) => HyperliquidClient; RequestTimeout: new (m: string) => Error; RateLimitExceeded: new (m: string) => Error };

afterEach(() => vi.useRealTimers());

// ---- Hyperliquid, canned: a few markets in the live shape (trimmed from what it answered 2026-10-08) ------------------------------------

const TOKENS = [
  { name: "USDC", szDecimals: 8, weiDecimals: 8, index: 0, tokenId: "0x6d1e7cde53ba9467b783cb7c530ce054", isCanonical: true, fullName: null },
  { name: "HYPE", szDecimals: 2, weiDecimals: 8, index: 1, tokenId: "0x0d01dc56dcaaca66ad901c959b4011ec", isCanonical: false, fullName: "Hyperliquid" },
];
const PAIRS = [{ tokens: [1, 0], name: "@107", index: 0, isCanonical: false }];
const SPOT = [{ universe: PAIRS, tokens: TOKENS }, [{ prevDayPx: "87.4", dayNtlVlm: "112423831.19", markPx: "83.84", midPx: "83.84", coin: "@107", dayBaseVlm: "1312213.3" }]];
const MAIN = [{ universe: [{ szDecimals: 5, name: "BTC", maxLeverage: 40, marginTableId: 56 }] }, [{ funding: "0.0000125", openInterest: "39982.9", prevDayPx: "83341.0", dayNtlVlm: "3341631875.3", premium: "0.0002", oraclePx: "81016.9", markPx: "80992.0", midPx: "81035.5", impactPxs: ["81035.0", "81036.0"], dayBaseVlm: "40698.2" }]];
const XYZ = [{ universe: [{ szDecimals: 3, name: "xyz:NVDA", maxLeverage: 20, marginTableId: 20 }], collateralToken: 0 }, [{ funding: "0.00000625", openInterest: "456919.6", prevDayPx: "236.98", dayNtlVlm: "161899634.7", premium: "-0.0001", oraclePx: "231.13", markPx: "231.11", midPx: "231.095", impactPxs: ["231.09", "231.1"], dayBaseVlm: "690246.7" }]];
const EMPTY = { marginSummary: { accountValue: "0.0" }, withdrawable: "0.0", assetPositions: [] };
const CH = { marginSummary: { accountValue: "1000.0" }, withdrawable: "400.0", assetPositions: [{ type: "oneWay", position: { coin: "BTC", szi: "0.01", leverage: { type: "cross", value: 3 }, entryPx: "80000", positionValue: "810.0", unrealizedPnl: "10", liquidationPx: null, marginUsed: "270" } }] };
const CH_XYZ = { marginSummary: { accountValue: "5000.0" }, withdrawable: "4000.0", assetPositions: [] };
const SPOT_CH = { balances: [{ coin: "USDC", token: 0, total: "100.0", hold: "0.0", entryNtl: "0.0" }] };
const SPOT_UNIFIED = { balances: [{ coin: "USDC", token: 0, total: "1000.0", hold: "0.0", entryNtl: "0.0" }] };
const order = (oid: number, word: string, o: Dict = {}) => ({ status: "order", order: { order: { coin: "BTC", side: "B", limitPx: "80000.0", sz: "0.0004", oid, timestamp: NOW, origSz: "0.001", tif: "Gtc", cloid: null, reduceOnly: false, orderType: "Limit", ...o }, status: word, statusTimestamp: NOW } });
const fill = (oid: number, px: string, sz: string) => ({ coin: "BTC", px, sz, side: "B", time: NOW, oid, fee: "0.01", feeToken: "USDC" });

/** an answer as the server gives it: a status and a body, read by the library itself */
type Raw = { raw: number; text: string };
const raw = (status: number, text: string): Raw => ({ raw: status, text });
const isRaw = (a: unknown): a is Raw => typeof a === "object" && a !== null && "raw" in a;

const INFO: Record<string, unknown> = {
  spotMeta: { tokens: TOKENS, universe: PAIRS },
  spotMetaAndAssetCtxs: SPOT,
  metaAndAssetCtxs: (b: Dict) => (b.dex === "xyz" ? XYZ : b.dex ? [{ universe: [], collateralToken: 0 }, []] : MAIN),
  perpDexs: [null, { name: "xyz", fullName: "XYZ" }],
  perpCategories: [],
  extraAgents: [{ name: "agent-account", address: AGENT.toLowerCase(), validUntil: NOW + 90 * DAY }],
  userAbstraction: "default",
  clearinghouseState: (b: Dict) => (b.dex === "xyz" ? CH_XYZ : b.dex ? EMPTY : CH),
  spotClearinghouseState: SPOT_CH,
  allMids: { "@107": "84.0" },
  orderStatus: { status: "unknownOid" },
  userFillsByTime: [],
  activeAssetData: { leverage: { type: "cross", value: 3 } },
  l2Book: { coin: "BTC", levels: [[{ px: "81359.0", sz: "1", n: 1 }], [{ px: "81360.0", sz: "1", n: 1 }]] },
};

interface Net {
  seen: Array<{ to: string; body: Dict }>;
  info: Record<string, unknown>;
  exchange: unknown[];
  geo: HttpReply | Error;
}
/** the real library's client, its network replaced: each answer goes through the library's own reading (handleRestResponse) */
const opener =
  (net: Net): OpenHyperliquid =>
  async (key) => {
    const c = (await openHyperliquid(key)) as HyperliquidClient & { fetch: unknown; nonce: unknown; handleRestResponse: (...a: unknown[]) => Promise<unknown> };
    c.enableRateLimit = false;
    c.nonce = () => NOW;
    c.fetch = async (url: string, method = "GET", headers: unknown = {}, body: string | undefined = undefined) => {
      const parsed = body ? (JSON.parse(body) as Dict) : {};
      const to = url.endsWith("/exchange") ? "exchange" : "info";
      net.seen.push({ to, body: parsed });
      let a = to === "info" ? net.info[String(parsed.type)] : net.exchange.shift();
      if (typeof a === "function") a = (a as (b: Dict) => unknown)(parsed);
      if (a === undefined) throw new Error(`not set up in this test: ${to} ${body}`);
      if (a instanceof Error) throw a;
      const status = isRaw(a) ? a.raw : 200;
      const text = isRaw(a) ? a.text : JSON.stringify(a);
      return c.handleRestResponse({ status, statusText: STATUS_CODES[status] ?? "", headers: {}, text: async () => text }, url, method, headers, body);
    };
    return c;
  };
const network = (over: Partial<Net> = {}): Net => ({ seen: [], info: { ...INFO, ...(over.info ?? {}) }, exchange: over.exchange ?? [], geo: over.geo ?? geo("DE", "BE") });
const geo = (country: string, region: string): HttpReply => {
  const body = { blocked: false, ip: "203.0.113.7", country, region };
  return { status: 200, body, text: JSON.stringify(body) };
};
const geoHttp =
  (net: Net): Http =>
  async (url) => {
    if (url !== GEO) throw new Error(`no answer: ${url}`);
    net.seen.push({ to: "geo", body: {} });
    if (net.geo instanceof Error) throw net.geo;
    return net.geo;
  };
async function open(net: Net, clock: () => number = () => NOW, where?: Locator) {
  return hyperliquidTradeSource({ venue: "hyperliquid-trade", label: "", reference: "credentials/hyperliquid-trade/api-key.json", key: { walletAddress: ACCOUNT, privateKey: PK }, where: where ?? locator({ http: geoHttp(net), clock }), clock, open: opener(net) });
}
async function connected(over: Partial<Net> = {}, clock?: () => number): Promise<{ t: LiveTrader; source: LiveSource; first: LiveBalance[]; net: Net }> {
  const net = network(over);
  const opened = await open(net, clock);
  if (isRefusal(opened)) throw new Error(`${opened.code}: ${opened.message}`);
  net.seen.splice(0);
  return { t: opened.source.trader!, source: opened.source, first: opened.first, net };
}
const refusal = (x: unknown): Refusal => {
  if (!isRefusal(x)) throw new Error(`expected a refusal, got ${JSON.stringify(x)}`);
  // nothing of this machine's address, nor of its place, in any refusal
  expect(JSON.stringify(x)).not.toMatch(/203\.0\.113\.\d|"DE"|"BE"/);
  return x;
};
const ok = <T>(x: T | Refusal): T => {
  if (isRefusal(x)) throw new Error(`expected an answer, got ${x.code}: ${x.message}`);
  return x;
};
const types = (seen: Net["seen"]) => seen.map((s) => (s.to === "info" ? `info ${String(s.body.type)}${s.body.dex ? ` ${String(s.body.dex)}` : ""}` : s.to));
const buy = (o: Partial<OrderRequest> = {}): OrderRequest => ({ symbol: "BTC/USDC:USDC", side: "buy", type: "limit", qty: 0.001, limitPrice: 80000, clientId: "0123456789abcdef0123456789abcdef", ...o });
const total = (rows: LiveBalance[]) => rows.reduce((s, b) => s + (b.usd ?? 0), 0);

/** CloudFront's own pages: a WAF rule, and its geo restriction — the place words well past the first 300 characters */
const WAF = `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN" "http://www.w3.org/TR/html4/loose.dtd"><HTML><HEAD><META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=iso-8859-1"><TITLE>ERROR: The request could not be satisfied</TITLE></HEAD><BODY><H1>403 ERROR</H1><H2>The request could not be satisfied.</H2><HR noshade size="1px">Request blocked. We can't connect to the server for this app or website at this time. There might be too much traffic or a configuration error. Try again later, or contact the app or website owner.<BR clear="all">Generated by cloudfront (CloudFront)<BR clear="all">Request ID: made-up==</BODY></HTML>`;
const GEO_PAGE = WAF.replace("Request blocked. We can't connect to the server for this app or website at this time. There might be too much traffic or a configuration error. Try again later, or contact the app or website owner.", `${"<!-- padding -->".repeat(20)}The Amazon CloudFront distribution is configured to block access from your country. We can't connect to the server for this app or website at this time.`);
/** a filtering network's page, answered with 200 in Hyperliquid's place */
const FILTER = `<html><head><title>Site blocked</title></head><body>This site is blocked by your organisation. Your address 203.0.113.7 (Berlin)</body></html>`;

// ---- Hyperliquid's trading connection -------------------------------------------------------------------------------------------------

describe("Hyperliquid trading: what its edge, a ban, a page in its place and a refused read are (R1-41, R4-16)", () => {
  it("an order its CloudFront edge refuses — a WAF page, or its geo page with the words past the cut — is that refusal: never 'may or may not have been placed', no look-up by the account's id, held ten minutes", async () => {
    for (const page of [WAF, GEO_PAGE]) {
      const { t, net } = await connected({ exchange: [raw(403, page)] });
      const r = refusal(await t.place(buy()));
      expect(r.code).toBe("E_VENUE_GEOBLOCKED");
      expect(r.message).not.toMatch(/may or may not/);
      expect(holdBackMs(r)).toBe(600_000);
      // nothing asked after the refused order: it was never placed
      expect(types(net.seen).filter((x) => x !== "geo")).toEqual(["exchange"]);
      if (page === WAF) expect(r.native).toMatchObject({ status: 403, edge: true });
      else expect(r.message).toContain("configured to block access from your country");
    }
    // the same edge at /info: a read refused in its words, not "could not be reached"
    const { source, net } = await connected();
    net.info.clearinghouseState = raw(403, WAF);
    const read = refusal(await source.read().catch((e: unknown) => e));
    expect([read.code, (read.native as Dict).edge]).toEqual(["E_VENUE_GEOBLOCKED", true]);
  });

  it("a ban (418) is held until its time, a 429 the minute it says", async () => {
    const { t } = await connected({ exchange: [raw(418, `{"error":"IP banned until ${NOW + 7_200_000}"}`), raw(429, "null")] });
    const ban = refusal(await t.place(buy()));
    expect([ban.code, (ban.native as Dict).until, (ban.native as Dict).ban]).toEqual(["E_VENUE_UNREACHABLE", NOW + 7_200_000, true]);
    const rate = refusal(await t.place(buy({ clientId: "1".repeat(32) })));
    expect([rate.code, holdBackMs(rate)]).toEqual(["E_VENUE_UNREACHABLE", 60_000]);
  });

  it("a 200 that is a page, or empty, is no answer: no holdings of nothing, no position gone, no 'no such order', no cancel or leverage change taken — and the page's address never kept", async () => {
    for (const body of [FILTER, ""]) {
      const { t, source, net } = await connected({ exchange: [raw(200, body), raw(200, body)] });
      for (const k of ["clearinghouseState", "spotClearinghouseState", "orderStatus"]) net.info[k] = raw(200, body);
      expect(refusal(await source.read().catch((e: unknown) => e)).code).toBe("E_VENUE_UNREACHABLE");
      expect(refusal(await t.positions!()).code).toBe("E_VENUE_UNREACHABLE");
      expect(refusal(await t.status("123", "BTC/USDC:USDC")).code).toBe("E_VENUE_UNREACHABLE");
      const cancel = refusal(await t.cancel("123", "BTC/USDC:USDC"));
      expect([cancel.code, cancel.detail]).toEqual(["E_VENUE_UNREACHABLE", { order: "123", unsure: true }]);
      const lev = refusal(await t.setLeverage!("BTC/USDC:USDC", 5, "cross"));
      expect([lev.code, (lev.detail as Dict).unsure]).toEqual(["E_VENUE_UNREACHABLE", true]);
      for (const r of [cancel, lev]) expect(JSON.stringify(r)).not.toMatch(/Berlin|203\.0\.113/);
    }
  });

  it("a market reload that comes back with no markets keeps the list it had", async () => {
    let now = NOW;
    const { t, net } = await connected({}, () => now);
    expect(ok(await t.markets("BTC")).map((m) => m.symbol)).toContain("BTC/USDC:USDC");
    now += 6 * 60_000;
    net.info.metaAndAssetCtxs = () => [{ universe: [] }, []];
    net.info.spotMetaAndAssetCtxs = [{ universe: [], tokens: TOKENS }, []];
    net.info.perpDexs = [null];
    expect(ok(await t.markets("BTC")).map((m) => m.symbol)).toContain("BTC/USDC:USDC");
  });
});

describe("Hyperliquid trading: a read in part is never kept as whole (R1-38, R4-17, R3-27)", () => {
  it("the market list refused at connect refuses the connect (not one without the HIP-3 accounts); asked again once the network is back, the library loads afresh and the HIP-3 account is there", async () => {
    let fail = true;
    const markets = INFO.metaAndAssetCtxs as (b: Dict) => unknown;
    const net = network({ info: { metaAndAssetCtxs: (b: Dict) => (fail && !b.dex ? new lib.RequestTimeout("hyperliquid POST https://api.hyperliquid.xyz/info request timed out (12000 ms)") : markets(b)) } });
    const first = refusal(await open(net));
    expect(first.code).toBe("E_VENUE_UNREACHABLE");
    fail = false;
    const again = ok(await open(net));
    expect(again.first.map((b) => b.where)).toEqual(expect.arrayContaining([expect.stringContaining("XYZ (HIP-3)")]));
  });

  it("a unified account holding dollars connects without the list; the trader then loads it afresh — not the first failed load, over and over", async () => {
    let fail = true;
    const { t } = await connected({ info: { userAbstraction: "unifiedAccount", spotClearinghouseState: SPOT_UNIFIED, metaAndAssetCtxs: (b: Dict) => (fail ? new lib.RateLimitExceeded("hyperliquid POST https://api.hyperliquid.xyz/info 429 Too Many Requests null") : (INFO.metaAndAssetCtxs as (x: Dict) => unknown)(b)) } });
    expect(refusal(await t.markets("BTC")).code).toBe("E_VENUE_UNREACHABLE");
    fail = false;
    expect(ok(await t.markets("BTC")).map((m) => m.symbol)).toContain("BTC/USDC:USDC");
  });

  it("one HIP-3 DEX's account refused (a 429) refuses the read: the account keeps the last whole one, never $5,000 gone without a word", async () => {
    const { source, first, net } = await connected();
    expect(total(first)).toBe(1000 + 100 + 5000);
    net.info.clearinghouseState = (b: Dict) => (b.dex === "xyz" ? raw(429, "null") : b.dex ? EMPTY : CH);
    expect(refusal(await source.read().catch((e: unknown) => e)).code).toBe("E_VENUE_UNREACHABLE");
  });

  it("the account's kind refused: never guessed ordinary — refused when never learned, the kind learned before when it was (a unified account is not counted twice)", async () => {
    const limited = () => new lib.RateLimitExceeded("hyperliquid POST https://api.hyperliquid.xyz/info 429 Too Many Requests null");
    const never = network({ info: { userAbstraction: limited, spotClearinghouseState: SPOT_UNIFIED } });
    expect(refusal(await open(never)).code).toBe("E_VENUE_UNREACHABLE");
    let now = NOW;
    const { source, first, net } = await connected({ info: { userAbstraction: "unifiedAccount", spotClearinghouseState: SPOT_UNIFIED } }, () => now);
    expect(total(first)).toBe(1000);
    now += 11 * 60_000;
    net.info.userAbstraction = limited;
    expect(total(await source.read())).toBe(1000);
  });
});

describe("Hyperliquid trading: a cancel read back too late, and a network changed between two orders (R4-28, R2-35)", () => {
  it("a cancel Hyperliquid took whose order could not be read back says what was last heard to have filled, as not read now — never that nothing filled", async () => {
    const { t, net } = await connected({ exchange: [{ status: "ok", response: { type: "cancel", data: { statuses: ["success"] } } }], info: { orderStatus: order(77, "open"), userFillsByTime: [fill(77, "80000", "0.0006")] } });
    expect(ok(await t.status("77", "BTC/USDC:USDC"))).toMatchObject({ status: "partial", filledQty: 0.0006 });
    net.info.orderStatus = raw(429, "null");
    expect(ok(await t.cancel("77", "BTC/USDC:USDC"))).toMatchObject({ ref: "77", status: "partial", filledQty: 0.0006, avgPrice: 80000, native: { cancel: "success", unread: true } });
  });

  it("an order or a leverage change asks the place again (one asked in the last few seconds is used): a move inside the ten minutes is judged where the machine is now, both ways", async () => {
    let now = NOW;
    const { t, net } = await connected({ exchange: [{ status: "ok", response: { type: "order", data: { statuses: [{ resting: { oid: 1 } }] } } }, { status: "ok", response: { type: "order", data: { statuses: [{ resting: { oid: 2 } }] } } }] }, () => now);
    // just connected: the place is not asked again
    ok(await t.place(buy()));
    expect(types(net.seen)).not.toContain("geo");
    // a minute on, on a network the terms close: refused before anything is signed
    now += 60_000;
    net.geo = geo("US", "NY");
    net.seen.splice(0);
    expect(refusal(await t.place(buy({ clientId: "1".repeat(32) }))).code).toBe("E_VENUE_GEOBLOCKED");
    expect(refusal(await t.setLeverage!("BTC/USDC:USDC", 2, "cross")).code).toBe("E_VENUE_GEOBLOCKED");
    expect(types(net.seen).filter((x) => x === "exchange")).toEqual([]);
    // and back on a served network a minute later: served again, not closed for ten minutes
    now += 60_000;
    net.geo = geo("DE", "BE");
    ok(await t.place(buy({ clientId: "2".repeat(32) })));
  });
});

// ---- where this user is ---------------------------------------------------------------------------------------------------------------

const reply = (status: number, body: unknown, text = typeof body === "string" ? body : JSON.stringify(body)): HttpReply => ({ status, body, text });
const trace = (loc: string) => reply(200, undefined, `fl=1f1\nh=www.cloudflare.com\nip=203.0.113.7\nts=1791500000.1\ncolo=EWR\nloc=${loc}\nwarp=off\n`);
/** a network of canned answers that records each request and its headers; an answer may be a function of the headers */
function net(answers: Record<string, HttpReply | Error | ((headers: Record<string, string>) => HttpReply | Error)>, clock = () => NOW) {
  const asked: Array<{ url: string; headers: Record<string, string> }> = [];
  const http: Http = async (url, init = {}) => {
    asked.push({ url, headers: init.headers ?? {} });
    let a = answers[url];
    if (typeof a === "function") a = a(init.headers ?? {});
    if (a instanceof Error) throw a;
    return a ?? reply(404, "");
  };
  return { http, asked, clock };
}

describe("where this user is: a place that is no place, one place spelled two ways, the part of a country (R1-17, R2-28, R2-12, R3-20, R4-24)", () => {
  it("Polymarket's XX (Cloudflare's 'cannot place') is no place: the trace is asked, and only a real place is judged", async () => {
    const at = (loc: string) => net({ [GEO]: reply(200, { blocked: false, country: "XX" }), [TRACE[0]!]: trace(loc), [TRACE[1]!]: trace(loc) });
    const xx = at("XX");
    expect(await locator(xx).verdict(HYPERLIQUID_RULE)).toBe("unknown");
    expect(xx.asked.map((a) => a.url)).toEqual([GEO, TRACE[0], TRACE[1]]);
    expect(await locator(at("SG")).verdict(HYPERLIQUID_RULE)).toBe("served");
    expect(await locator(at("US")).verdict(HYPERLIQUID_RULE)).toBe("closed");
    // Kosovo's XK is a place
    expect(await locator(net({ [GEO]: reply(200, { country: "XK" }) })).verdict(HYPERLIQUID_RULE)).toBe("served");
    // refused, and nothing sent, where the place is not known
    expect((await heldTo(HYPERLIQUID_RULE, locator(at("XX")), "hyperliquid-trade", "buy 1 BTC"))?.code).toBe("E_VENUE_UNREACHABLE");
  });

  it("a US outlying area is one place however the oracle spells it: the same verdict and the same place for PR, US/PR and US/US-PR", async () => {
    const verdicts = [];
    for (const body of [{ country: "PR" }, { country: "US", region: "PR" }, { country: "US", region: "US-PR" }]) {
      const w = locator(net({ [GEO]: reply(200, body) }));
      verdicts.push([await w.verdict(HYPERLIQUID_RULE), await w.place()]);
    }
    expect(new Set(verdicts.map((v) => JSON.stringify(v))).size).toBe(1);
    expect(placeOf("US", "GU")).toEqual({ country: "GU", region: "" });
    expect(placeOf("US", "NY")).toEqual({ country: "US", region: "NY" });
  });

  it("the place for the terms gets its part from the lookup when the lists split the country (a state for an edition), only for the same country, and never asked for a country that does not split", async () => {
    const splits = (c: string) => c === "US";
    const us = net({ [GEO]: new Error("ECONNRESET"), [TRACE[0]!]: trace("US"), [SUBDIVISION]: reply(200, { country_code: "US", region_code: "CA" }) });
    expect(await locator(us).place({ splits })).toEqual({ country: "US", region: "CA" });
    expect(await locator(net({ [GEO]: new Error("x"), [TRACE[0]!]: trace("US"), [SUBDIVISION]: reply(200, { country_code: "DE", region_code: "BE" }) })).place({ splits })).toEqual({ country: "US", region: "" });
    const de = net({ [GEO]: new Error("x"), [TRACE[0]!]: trace("DE") });
    expect(await locator(de).place({ splits })).toEqual({ country: "DE", region: "" });
    expect(de.asked.map((a) => a.url)).not.toContain(SUBDIVISION);
  });

  it("ipapi.co answers only a client that names itself: the account sends its own name, and a Ukrainian user Hyperliquid serves is served", async () => {
    const ua = net({ [GEO]: new Error("ECONNRESET"), [TRACE[0]!]: trace("UA"), [SUBDIVISION]: (h) => (h["user-agent"] === AGENT_NAME ? reply(200, { country_code: "UA", region_code: "30" }) : reply(429, { error: true, reason: "RateLimited" })) });
    expect(await locator(ua).verdict(HYPERLIQUID_RULE)).toBe("served");
    expect(AGENT_NAME).toBe("agent-account/1");
  });

  it("a place from the trace alone is kept twenty seconds, not ten minutes: Polymarket back with the part, the user is served — and a burst asks the lookup once, its refusal said as that", async () => {
    let now = NOW;
    let pm: HttpReply | Error = reply(503, "");
    const n = net({ [GEO]: () => pm, [TRACE[0]!]: trace("CA"), [SUBDIVISION]: reply(429, { error: true }) }, () => now);
    const w = locator(n);
    expect(await Promise.all(Array.from({ length: 5 }, () => w.verdict(HYPERLIQUID_RULE)))).toEqual(Array(5).fill("unknown"));
    expect(n.asked.filter((a) => a.url === SUBDIVISION)).toHaveLength(1);
    const r = refusal(await heldTo(HYPERLIQUID_RULE, w, "hyperliquid-trade", "buy 1 BTC"));
    // the same sentence whichever part was not learned: that the line closes part of the country would say which country it is
    expect(r.message).toContain("where this machine is could not be learned just now");
    expect(r.message).not.toMatch(/part of (that|its) country|in its country/);
    expect(r.message).not.toContain("neither Polymarket");
    pm = reply(200, { country: "CA", region: "QC" });
    now += TRACE_MS + 1;
    expect(await w.verdict(HYPERLIQUID_RULE)).toBe("served");
  });

  it("a write asks again after a few seconds; the country another source named is judged only when this place is in it", async () => {
    let now = NOW;
    const n = net({ [GEO]: reply(200, { country: "CA", region: "BC" }) }, () => now);
    const w = locator(n);
    await w.verdict(HYPERLIQUID_RULE);
    await w.verdict(HYPERLIQUID_RULE, { fresh: true });
    expect(n.asked).toHaveLength(1);
    now += WRITE_MS + 1;
    await w.verdict(HYPERLIQUID_RULE, { fresh: true });
    expect(n.asked).toHaveLength(2);
    expect(await w.verdict(HYPERLIQUID_RULE, { country: "CA" })).toBe("served");
    expect(await w.verdict(HYPERLIQUID_RULE, { country: "UA" })).toBe("unknown");
  });
});

// ---- each venue's first, keyless question -----------------------------------------------------------------------------------------------

const exchange = (name: string, clock: () => Promise<unknown>): ExchangeClient => ({ id: name.toLowerCase(), name, has: {}, fetchTime: clock }) as unknown as ExchangeClient;
function reachDeps(answers: Record<string, HttpReply | Error> = {}, over: Partial<ReachDeps> = {}) {
  const asked: string[] = [];
  const http: Http = async (url) => {
    asked.push(url);
    const a = answers[url];
    if (a instanceof Error) throw a;
    return a ?? reply(404, "not here");
  };
  const mm = (async () => ({ authenticated: true })) as unknown as RunMm;
  return { d: { http, clock: () => Date.now(), mm, ...over } as ReachDeps, asked };
}

describe("reach: a ban held until its time, a rate limit, a page in the API's place, Hyperliquid itself, mm's sign-in check (R1-5, R4-22, R3-9, R1-31, R2-23)", () => {
  it("an exchange's ban is kept until the venue's time (an hour at most), not twenty seconds — and said as a ban", async () => {
    const until = Date.now() + 2 * 3_600_000;
    const open: OpenExchange = async () => exchange("Binance", async () => Promise.reject(Object.assign(new Error(`binance GET https://api.binance.com/api/v3/time 418 I'm a Teapot {"code":-1003,"msg":"Way too much request weight used; IP banned until ${until}."}`), { name: "DDoSProtection" })));
    const r = await reachOf("live:exchange:binance", { ...reachDeps().d, open });
    expect(r.state).toBe("unreachable");
    expect(reachKeepMs(r, Date.parse(r.at))).toBe(3_600_000);
    expect(reachBanUntil(r, Date.parse(r.at))).toBeDefined();
    // a 418 that names no time: ten minutes
    const plain: OpenExchange = async () => exchange("Binance", async () => Promise.reject(Object.assign(new Error("binance GET https://api.binance.com/api/v3/time 418 I'm a Teapot "), { name: "DDoSProtection" })));
    const p = await reachOf("live:exchange:binance", { ...reachDeps().d, open: plain });
    expect(reachKeepMs(p, Date.parse(p.at))).toBeGreaterThan(590_000);
    expect(reachKeepMs(p, Date.parse(p.at))).toBeLessThanOrEqual(600_000);
  });

  it("a keyless venue's 418, 429 (Cloudflare's 1015 among them) and a page in its place are no answer to connect on — the ban held until its time; Alpaca's own 401 page is still Alpaca asking for a key", async () => {
    const until = Date.now() + 3_000_000;
    const at = async (url: string, a: HttpReply, connector: string) => reachOf(connector, reachDeps({ [url]: a }).d);
    const K = "https://external-api.kalshi.com/trade-api/v2/exchange/status";
    const banned = await at(K, reply(418, `IP banned until ${until}`), "live:kalshi");
    expect([banned.state, banned.ban]).toEqual(["unreachable", true]);
    expect(reachKeepMs(banned, Date.parse(banned.at))).toBeGreaterThan(2_900_000);
    expect(reachKeepMs(banned, Date.parse(banned.at))).toBeLessThanOrEqual(3_000_000);
    for (const a of [reply(429, { error: "too many" }), reply(429, "error code: 1015")]) {
      const r = await at(K, a, "live:kalshi");
      expect(r.state).toBe("unreachable");
      expect(reachKeepMs(r, Date.parse(r.at))).toBeGreaterThan(55_000);
      expect(reachKeepMs(r, Date.parse(r.at))).toBeLessThanOrEqual(60_000);
    }
    for (const a of [reply(200, undefined, FILTER), reply(404, undefined, FILTER), reply(200, undefined, "")]) expect((await at("https://gateway.polymarket.us/v1/markets?limit=1", a, "live:polymarket-us")).state).toBe("unreachable");
    expect((await at("https://api.alpaca.markets/v2/clock", reply(401, "<html><head><title>401 Authorization Required</title></head></html>"), "live:alpaca")).state).toBe("ok");
  });

  it("Hyperliquid's tile asks Hyperliquid too: its edge refusing this network is not served, an outage or no answer is no answer — whatever the place", async () => {
    const at = (a: HttpReply | Error) => reachOf("live:hyperliquid-trade", reachDeps({ [GEO]: reply(200, { country: "DE", region: "BE" }), [HL]: a }).d);
    const edge = await at(reply(403, WAF));
    expect([edge.state, edge.said]).toEqual(["location", expect.stringContaining("Hyperliquid refuses this network")]);
    expect((await at(reply(503, "Service Unavailable"))).state).toBe("unreachable");
    expect((await at(new Error("ETIMEDOUT"))).state).toBe("unreachable");
    expect((await at(reply(200, { universe: [] }))).state).toBe("ok");
  });

  it("Hyperliquid's line uses the service's own place when given, with no second lookup, and gives a slow place its full time rather than cutting it at 6.5 s", async () => {
    vi.useFakeTimers({ now: NOW });
    const slow: Locator = { verdict: () => new Promise((r) => setTimeout(() => r("served"), 9_000)), place: async () => undefined };
    const { d, asked } = reachDeps({ [HL]: reply(200, { universe: [] }) }, { where: slow });
    const p = reachOf("live:hyperliquid-trade", d);
    await vi.advanceTimersByTimeAsync(9_500);
    expect((await p).state).toBe("ok");
    expect(asked).toEqual([HL]);
  });

  it("mm's sign-in check, which asks MetaMask's servers each time: their not answering this network is no answer just now — not 'run mm login'", async () => {
    const mm = (answer: unknown): RunMm => (async () => (answer instanceof Error ? Promise.reject(answer) : answer)) as RunMm;
    const at = (answer: unknown) => reachOf("live:metamask", reachDeps({}, { mm: mm(answer) }).d);
    const code = (c: string, message = c) => Object.assign(new Error(`${c}: ${message}`), { code: c });
    for (const a of [code("NETWORK_UNREACHABLE"), code("MM_TIMEOUT"), code("AUTH_ERROR", "introspect failed with HTTP 503"), { authenticated: false, reason: "NETWORK_TIMEOUT" }]) {
      const r = await at(a);
      expect(r.state).toBe("unreachable");
      expect(r.said).not.toContain("run mm login in a terminal, then");
    }
    expect((await at({ authenticated: false, reason: "TOKEN_REFRESH_FAILED" })).said).toContain("MetaMask may not have answered, or the sign-in lapsed");
    expect((await at({ authenticated: false })).state).toBe("setup");
  });
});

// ---- read by address --------------------------------------------------------------------------------------------------------------------

const ADDRESS = "0x00000000000000000000000000000000000000A1";
/** chains that answer what they hold, and the ones named in `down` that do not */
function chainOf(held: Record<string, number>, down: Set<string>, prices: Record<string, bigint> = {}): ChainReader & { uints: string[] } {
  const uints: string[] = [];
  const amount = (chain: string, asset: string) => held[`${chain}:${asset}`] ?? 0;
  return {
    uints,
    async tokens(_h, refs: TokenRef[]) {
      const chains = [...new Set(refs.map((r) => r.chain))];
      return { rows: refs.filter((r) => !down.has(r.chain)).map((r) => ({ chain: r.chain, asset: r.asset, amount: amount(r.chain, r.asset) })), failed: chains.filter((c) => down.has(c)) };
    },
    async native(_h, chains: ChainName[]) {
      return { rows: chains.filter((c) => !down.has(c)).map((c) => ({ chain: c, asset: CHAINS[c].coin, amount: amount(c, CHAINS[c].coin) })), failed: chains.filter((c) => down.has(c)) };
    },
    async uint(_c, address) {
      uints.push(address.toLowerCase());
      return prices[address.toLowerCase()];
    },
    async decimals() {
      return 6;
    },
    async receipt() {
      return undefined;
    },
  };
}
const quiet: Http = async () => reply(404, "");
type Parted = LiveSource & { unread(): string | undefined };

describe("read by address: a chain, a ledger or a price not answering this time (R3-12, R1-19, R4-20)", () => {
  it("a wallet's chain that does not answer keeps what it held, said as not read this time — never $0 freshly read — and the source says what was not read", async () => {
    const down = new Set<string>();
    const opened = await walletSource({ venue: "wallet", label: "", address: ADDRESS, http: quiet, chain: chainOf({ "Base:USDC": 1000, "Base:ETH": 0.5 }, down) });
    if (isRefusal(opened)) throw new Error(opened.message);
    expect(opened.first.filter((b) => b.where === "Base").map((b) => [b.asset, b.amount])).toEqual([["USDC", 1000], ["ETH", 0.5]]);
    down.add("Base");
    const later = await opened.source.read();
    expect(later.filter((b) => b.asset === "USDC" || b.asset === "ETH").map((b) => [b.asset, b.amount, b.where])).toEqual([["USDC", 1000, "Base · not read this time: Base did not answer"], ["ETH", 0.5, "Base · not read this time: Base did not answer"]]);
    expect((opened.source as Parted).unread()).toContain("Base");
    expect(opened.source.probe.note).toContain("no answer this time: Base");
  });

  it("Polymarket's cash on Polygon not answering keeps the last pUSD, said as not read this time", async () => {
    const down = new Set<string>();
    const http: Http = async () => reply(200, { data: [], pagination: { next_cursor: null } });
    const opened = await polymarketSource({ venue: "polymarket", label: "", address: ADDRESS, http, chain: chainOf({ "Polygon:pUSD": 150.5 }, down) });
    if (isRefusal(opened)) throw new Error(opened.message);
    down.add("Polygon");
    expect((await opened.source.read()).map((b) => [b.asset, b.amount, b.where])).toEqual([["pUSD", 150.5, "cash · Polygon · not read this time: Polygon did not answer"]]);
    expect((opened.source as Parted).unread()).toContain("cash on Polygon");
  });

  it("Hyperliquid by address: the account's kind refused is never taken for an ordinary one — refused when never answered, the kind it last answered after", async () => {
    vi.useFakeTimers({ now: NOW });
    let kind: HttpReply = reply(429, { error: "too many requests" });
    const http: Http = async (_url, init = {}) => {
      const type = (JSON.parse(String(init.body ?? "{}")) as { type?: string }).type;
      if (type === "clearinghouseState") return reply(200, { marginSummary: { accountValue: "1000.0" }, withdrawable: "1000.0" });
      if (type === "spotClearinghouseState") return reply(200, { balances: [{ coin: "USDC", total: "1000.0" }] });
      return kind;
    };
    expect(refusal(await hyperliquidSource({ venue: "hl", label: "", address: ADDRESS, http, chain: {} as ChainReader })).code).toBe("E_VENUE_UNREACHABLE");
    kind = reply(200, "unifiedAccount", '"unifiedAccount"');
    const opened = await hyperliquidSource({ venue: "hl", label: "", address: ADDRESS, http, chain: {} as ChainReader });
    if (isRefusal(opened)) throw new Error(opened.message);
    expect(opened.first.map((b) => [b.asset, b.amount])).toEqual([["USDC", 1000]]);
    vi.setSystemTime(NOW + 11 * 60_000);
    kind = reply(403, WAF);
    expect((await opened.source.read()).map((b) => [b.asset, b.amount])).toEqual([["USDC", 1000]]);
  });

  it("Ondo: a token held whose oracle read was refused is not worth $0: it keeps the oracle's last price, or none, and the read says so; a token not held is never priced", async () => {
    const oracle = "0x9cad45a8bf0ed41ff33074449b357c7a1fab4094";
    const silent = await ondoSource({ venue: "ondo", label: "", address: ADDRESS, http: quiet, chain: chainOf({ "Ethereum:OUSG": 45.5 }, new Set()) });
    if (isRefusal(silent)) throw new Error(silent.message);
    expect([silent.first.map((b) => [b.asset, b.usd]), silent.source.unread?.()]).toEqual([[["OUSG", undefined]], "Ondo's oracle could not be read for OUSG this time"]);
    const chain = chainOf({ "Ethereum:OUSG": 10 }, new Set(), { [oracle]: 110_000000000000000000n });
    const opened = await ondoSource({ venue: "ondo", label: "", address: ADDRESS, http: quiet, chain });
    if (isRefusal(opened)) throw new Error(opened.message);
    expect(opened.first.map((b) => [b.asset, b.usd])).toEqual([["OUSG", 1100]]);
    expect(chain.uints).toEqual([oracle]);
  });
});
