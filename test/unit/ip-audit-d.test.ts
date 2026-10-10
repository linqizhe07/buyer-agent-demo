import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { isRefusal, type Refusal } from "../../src/core/errors.ts";
import { alpacaSource } from "../../src/portfolio/live/alpaca.ts";
import { kalshiSource } from "../../src/portfolio/live/kalshi.ts";
import { metamaskSource, MmError, parseMm, type RunMm } from "../../src/portfolio/live/metamask.ts";
import { holdBackMs } from "../../src/portfolio/live/public-markets.ts";
import { robinhoodCryptoSource, robinhoodStocksSource, type McpSession, type McpTool, type OpenMcp } from "../../src/portfolio/live/robinhood.ts";
import { OAuthSignIn } from "../../src/portfolio/live/signin.ts";
import type { LiveTrader, OrderRequest } from "../../src/portfolio/live/trade.ts";
import type { Http, HttpReply, LiveSource } from "../../src/portfolio/live/types.ts";

/** The IP audit's findings in the connections that speak to one venue each — MetaMask's mm command line (its Polymarket, Hyperliquid, swaps
 * and earn), Robinhood (its sign-in, its crypto API, its MCP server), Kalshi and Alpaca (2026-10-09): an answer to THIS network told as what
 * it is — the venue's place rule, the server in front of it refusing this network, a ban or a rate limit, no answer — and never as a key's
 * permission, a sign-in that ran out, or the venue refusing the account; a write whose answer was lost never told as refused; no place and
 * no address kept. Everything runs against stand-ins; nothing leaves the process. Addresses are from the documentation ranges (RFC 5737) */

const refusal = (x: unknown): Refusal => {
  if (!isRefusal(x)) throw new Error(`expected a refusal, got ${JSON.stringify(x)}`);
  return x;
};
const ok = <T>(x: T | Refusal): T => {
  if (isRefusal(x)) throw new Error(`expected an answer, got ${x.code}: ${x.message}`);
  return x;
};
const json = (body: unknown, status = 200, more: Partial<HttpReply> = {}): HttpReply => ({ status, body, text: JSON.stringify(body), ...more });
const page = (text: string, status = 403): HttpReply => ({ status, body: undefined, text });
/** Akamai's refusal page, and Cloudflare's for a site that bans the country (it names the country and the address) */
const AKAMAI = `<HTML><HEAD>\n<TITLE>Access Denied</TITLE>\n</HEAD><BODY>\n<H1>Access Denied</H1>\n \nYou don't have permission to access "http&#58;&#47;&#47;api&#46;example&#46;com&#47;" on this server.<P>\nReference&#32;&#35;18&#46;5f3c1e17&#46;1791225581&#46;2a4b\n</BODY>\n</HTML>`;
const CF1009 = `<!DOCTYPE html><html><head><title>Access denied | api.example.com used Cloudflare to restrict access</title></head><body><h1>Error 1009</h1><p>The owner of this website (api.example.com) has banned the country or region your IP address is in (XX) from accessing this website.</p><p>Your IP: 203.0.113.9</p></body></html>`;
/** nothing of the page but its title is kept: not its country, not the address it repeats */
const noPage = (r: Refusal) => expect(JSON.stringify(r)).not.toMatch(/\(XX\)|203\.0\.113\.9|banned the country|permission to access|Reference/);
const edge = (r: Refusal) => {
  expect([r.code, r.native]).toEqual(["E_VENUE_GEOBLOCKED", { status: 403, edge: true }]);
  expect(r.message).toContain("refuses this network: the server in front of it answered HTTP 403");
  expect(holdBackMs(r)).toBe(600_000);
  noPage(r);
};

// ---- MetaMask's mm command line ----------------------------------------------------------------------------------------------

const WALLET = "0x00000000000000000000000000000000000000Aa";
const NOW = Date.parse("2026-10-05T14:00:00.000Z");
const ON = { PORTFOLIO_MM_WRITES: "1" };
const TID = `1${"2345678901".repeat(7)}3`;
const CID = `0x${"c0ffee00".repeat(8)}`;
const SLUG = "fed-cuts-rates-in-december";
const ORDER = `0x5f${"0".repeat(60)}11`;
const fail = (code: string, message: string) => new MmError({ code, message });
const commandOf = (args: string[]): string => args.slice(0, args[0] !== "perps" && args[0] !== "earn" && ["markets", "requests"].includes(args[1] ?? "") ? 3 : 2).join(" ");

function mm(answers: Record<string, unknown>) {
  const calls: string[][] = [];
  const run: RunMm = async <T>(args: string[]): Promise<T> => {
    calls.push([...args]);
    // a list is answered in turn, its last one from then on (an answer that is itself a list goes inside one)
    const a = answers[commandOf(args)];
    const next = Array.isArray(a) ? (a.length > 1 ? a.shift() : a[0]) : a;
    if (next === undefined) throw fail("NOT_SET_UP", `not set up: mm ${args.join(" ")}`);
    const out = typeof next === "function" ? (next as (x: string[]) => unknown)(args) : next;
    if (out instanceof Error) throw out;
    return out as T;
  };
  return { run, calls };
}
const SHOW = { address: WALLET, tradingMode: "guard", policyYaml: "rolling_24h: 50" };
const BALANCE = { currency: "usd", totalValue: "40", chains: [{ chainName: "Base", tokens: [{ symbol: "USDC", balance: "40", value: "40" }] }] };
async function boot(answers: Record<string, unknown>) {
  const s = mm({ "wallet show": SHOW, "wallet balance": BALANCE, ...answers });
  const opened = ok(await metamaskSource({ venue: "metamask", label: "", run: s.run, env: ON, now: () => NOW }));
  s.calls.splice(0);
  return { t: opened.source.trader!, source: opened.source, calls: s.calls };
}
const PM = {
  "predict markets get": { command: "markets get", result: { market: { id: "900001", slug: SLUG, question: "Fed cuts rates in December?", conditionId: CID, active: true, closed: false, acceptingOrders: true, enableOrderBook: true, orderMinSize: 5, orderPriceMinTickSize: 0.01, endDate: "2026-12-31T00:00:00Z", outcomes: [{ name: "Yes", price: 0.175, tokenId: TID }, { name: "No", price: 0.825, tokenId: `9${"8".repeat(76)}` }] } } },
  "predict book": { command: "book", result: { book: { market: CID, asset_id: TID, bids: [{ price: "0.17", size: "500" }], asks: [{ price: "0.18", size: "400" }], min_order_size: "5", tick_size: "0.01", last_trade_price: "0.170" } } },
  "predict geoblock": { command: "geoblock", result: { blocked: false, ip: "203.0.113.9", country: "IE", region: "L" } },
};
const pmOrder = (clientId: string, side: "buy" | "sell" = "buy"): OrderRequest => ({ symbol: `${SLUG}:Yes`, side, type: "limit", qty: 10, limitPrice: 0.18, clientId });
const places = (calls: string[][]) => calls.filter((a) => a[0] === "predict" && a[1] === "place").length;

describe("mm: Polymarket's location check, and what Polymarket says of a wallet", () => {
  it("R1-15 · 'address in closed only mode' is a state of the wallet, as the CLOB connection reads it: E_VENUE_PERMISSION in Polymarket's words, never 'does not serve this location'", async () => {
    const x = await boot({ ...PM, "predict place": fail("PREDICT_ERROR", `'0x00000000000000000000000000000000000000Dd' address in closed only mode`) });
    const r = refusal(await x.t.place(pmOrder("c1")));
    expect([r.code, (r.native as { closeOnly?: boolean }).closeOnly]).toEqual(["E_VENUE_PERMISSION", true]);
    expect(r.message).toBe("Polymarket holds this wallet to closing positions (its words: '0x00000000000000000000000000000000000000Dd' address in closed only mode): a buy opens one, so nothing was placed; a sell of shares the wallet holds still goes");
    expect(r.message).not.toMatch(/does not serve this location/);
    expect(holdBackMs(r)).toBe(0);
  });

  it("R1-24 · the check's own outage or rate limit is no answer (E_VENUE_UNREACHABLE) for a buy and a sell alike, and nothing is placed; a bare 403 is the edge in its words", async () => {
    for (const [code, said] of [["PREDICT_ERROR", "Polymarket check geoblock failed: Service Unavailable"], ["RATE_LIMITED", "Polymarket check geoblock failed: Too Many Requests"], ["NETWORK_UNREACHABLE", "Could not reach the Polymarket endpoint (fetch failed)."], ["UNPARSEABLE", `{"command":"geoblock","result":{"blocked":false}} trailing`]] as const) {
      const x = await boot({ ...PM, "predict geoblock": fail(code, said), "predict place": { command: "place", result: { response: { orderId: ORDER, status: "live", success: true } } } });
      for (const side of ["buy", "sell"] as const) {
        const r = refusal(await x.t.place(pmOrder(`${code}-${side}`, side)));
        expect([r.code, r.message]).toEqual(["E_VENUE_UNREACHABLE", "Polymarket's location check did not answer: nothing goes to Polymarket without it"]);
        expect(r.native).toEqual({ command: "mm predict geoblock --json", code });
      }
      expect(places(x.calls)).toBe(0);
    }
    const x = await boot({ ...PM, "predict geoblock": fail("PREDICT_ERROR", "Polymarket check geoblock failed: Forbidden") });
    const r = refusal(await x.t.place(pmOrder("f1", "sell")));
    expect([r.code, (r.native as { edge?: boolean }).edge]).toEqual(["E_VENUE_GEOBLOCKED", true]);
    expect(r.message).toBe("Polymarket refuses this network: the server in front of it answered HTTP 403 and gave no reason — by place, or by this address's standing, it does not say. That is its own answer, and the account does not look for a way around it. Nothing was placed");
    // the same check failing inside mm predict place's own sign-in step: an outage, and nothing was sent (so nothing is "unsure")
    const y = await boot({ ...PM, "predict place": fail("PREDICT_ERROR", "Polymarket check geoblock failed: Service Unavailable") });
    const p = refusal(await y.t.place(pmOrder("p1")));
    expect([p.code, p.detail]).toEqual(["E_VENUE_UNREACHABLE", undefined]);
  });

  it("R1-25 · a place mm names, or its raw geoblock answer, is kept nowhere; an answer printed whole before an exit that is not 0 is mm's answer", async () => {
    const x = await boot({ ...PM, "predict geoblock": fail("PREDICT_GEOBLOCKED", "Polymarket is not available in your region (PA, US). Predict features cannot be used from this location.") });
    const r = refusal(await x.t.place(pmOrder("g1", "sell")));
    expect(r.code).toBe("E_VENUE_GEOBLOCKED");
    expect(r.native).toEqual({ command: "mm predict geoblock --json", code: "PREDICT_GEOBLOCKED" });
    expect(JSON.stringify(r)).not.toMatch(/\(PA, US\)|"US"|"PA"/);
    // the same words from another command (mm predict place's own guard) keep only mm's code too
    const y = await boot({ ...PM, "predict place": fail("PREDICT_GEOBLOCKED", "Polymarket is not available in your region (PA, US).") });
    expect(JSON.stringify(refusal(await y.t.place(pmOrder("g2", "sell"))))).not.toMatch(/PA, US/);
    // mm 7.0.0 exits 130 from its SIGINT handler after it has printed its answer: the answer is read, not echoed as a failure
    const envelope = JSON.stringify({ ok: true, data: { command: "geoblock", result: { blocked: false, ip: "203.0.113.9", country: "IE", region: "L" } } }, null, 2);
    expect(parseMm(envelope, "", 130)).toEqual({ ok: true, data: { command: "geoblock", result: { blocked: false, ip: "203.0.113.9", country: "IE", region: "L" } }, notices: [] });
    const half = parseMm(`${JSON.stringify({ command: "geoblock", result: { country: "IE", region: "L" } })}\n`, "", 1);
    expect(!half.ok && half.error.code).toBe("UNPARSEABLE");
    expect(JSON.stringify(half)).not.toMatch(/"IE"|country|region/);
    // the Hyperliquid path's fallback keeps mm's code alone, never its words
    const z = await boot({ "perps markets": [[{ venue: "hyperliquid", symbol: "BTC", maxLeverage: 40, sizeDecimals: 5, markPrice: "60000.0" }]], "perps positions": [[]], "predict geoblock": fail("UNPARSEABLE", `{"country":"IE","region":"L"} exited 1`) });
    const h = refusal(await z.t.place({ symbol: "BTC-PERP", side: "buy", type: "market", qty: 0.001, worstPrice: 61_200, clientId: "h1" }));
    expect(h.native).toEqual({ command: "mm predict geoblock --json", code: "UNPARSEABLE" });
  });
});

const PERP_ROWS = [{ venue: "hyperliquid", symbol: "BTC", maxLeverage: 40, sizeDecimals: 5, markPrice: "60000.0", fundingRate: "0.0000125", volume24h: "2500000000.0" }];
const perpsBoot = (geo: unknown, more: Record<string, unknown> = {}) => boot({ "perps markets": [PERP_ROWS], "perps positions": [[]], "predict geoblock": geo, ...more });
const perpBuy = (clientId: string, o: Partial<OrderRequest> = {}): OrderRequest => ({ symbol: "BTC-PERP", side: "buy", type: "market", qty: 0.001, worstPrice: 61_200, clientId, ...o });

describe("mm: Hyperliquid's own line, where mm cannot say the place", () => {
  it("R1-37 · not known now is E_VENUE_UNREACHABLE, asked again, as the direct connection says it — never Hyperliquid's no", async () => {
    for (const geo of [fail("NETWORK_UNREACHABLE", "fetch failed"), { command: "geoblock", result: { blocked: false } }, { command: "geoblock", result: { blocked: false, country: "XX" } }]) {
      const x = await perpsBoot(geo, { "perps open": { venue: "hyperliquid", symbol: "BTC", orderId: "777", status: "filled", averagePrice: "60010.0", filledSize: "0.001" } });
      const r = refusal(await x.t.place(perpBuy("u1")));
      expect(r.code).toBe("E_VENUE_UNREACHABLE");
      expect(r.message).toMatch(/Try again in a moment$/);
      expect(holdBackMs(r)).toBe(20_000);
      expect(x.calls.some((a) => a[1] === "open")).toBe(false);
    }
  });

  it("R3-17 · a country Hyperliquid's line closes in part, said without its part: the refusal names no country and does not say the line closes part of it", async () => {
    for (const country of ["CA", "UA"]) {
      const x = await perpsBoot({ command: "geoblock", result: { blocked: false, country, region: "" } });
      const r = refusal(await x.t.place(perpBuy(`s-${country}`)));
      expect([r.code, r.message]).toEqual(["E_VENUE_UNREACHABLE", "where this machine is could not be learned just now, so Hyperliquid's own line (its Terms of Use §1.6) could not be held to it: nothing was sent (buy 0.001 BTC). Try again in a moment"]);
      expect(JSON.stringify(r)).not.toMatch(/part of it|Canada|Ukraine|"CA"|"UA"/);
    }
  });
});

describe("mm: MetaMask's swaps", () => {
  it("R3-8 · one RWA token's restriction is that asset's no (E_VENUE_REJECTED, held back not at all), never 'MetaMask's swaps does not serve this location'", async () => {
    const x = await boot({ "swap quote": { kind: "unavailable", reason: "RWA_GEO_RESTRICTED", message: "This asset is restricted in your region." } });
    const r = refusal(await x.t.market("TSLAx/USDC@Ethereum"));
    expect(r.code).toBe("E_VENUE_REJECTED");
    expect(r.message).toContain('MetaMask says "This asset is restricted in your region."');
    expect(r.message).not.toMatch(/does not serve this location/);
    expect((r.native as { code: string }).code).toBe("RWA_GEO_RESTRICTED");
    expect(holdBackMs(r)).toBe(0);
  });
});

describe("mm: a write whose answer was lost", () => {
  it("R4-13 · an order cut off on the network is looked for; not found, it may have been taken (detail.unsure, placed 'unknown') and the same id never sends it again", async () => {
    const lost = fail("NETWORK_UNREACHABLE", "Could not reach the Polymarket endpoint (fetch failed).");
    const x = await boot({ ...PM, "predict place": lost, "predict orders": { command: "orders", result: { orders: [] } } });
    const r = refusal(await x.t.place(pmOrder("w1")));
    expect([r.code, r.detail]).toEqual(["E_VENUE_UNREACHABLE", { unsure: true, placed: "unknown" }]);
    expect(r.message).toBe("Polymarket did not answer whether it took this (buy 10 Yes shares in Fed cuts rates in December? · Yes): it may have. Look at Polymarket's open orders and positions in Fed cuts rates in December? · Yes before asking again");
    expect(x.calls.filter((a) => a[1] === "orders")).toEqual([["predict", "orders", "--market", CID, "--json"]]);
    // asked again with the same id: the same answer, and no second order
    const again = refusal(await x.t.place(pmOrder("w1")));
    expect((again.detail as { unsure?: boolean }).unsure).toBe(true);
    expect(places(x.calls)).toBe(1);
    // found resting since it was sent, with the same outcome, side, price and size: it is the order, followed by its id
    const resting = { id: ORDER, market: CID, asset_id: TID, side: "BUY", price: "0.18", original_size: "10", size_matched: "0", status: "LIVE", created_at: NOW / 1000 };
    const y = await boot({ ...PM, "predict place": fail("JOB_TIMEOUT", "Timed out"), "predict orders": { command: "orders", result: { orders: [{ ...resting, created_at: NOW / 1000 - 3600, id: "0xolder" }, resting] } } });
    expect(ok(await y.t.place(pmOrder("w2")))).toMatchObject({ ref: ORDER, status: "open", filledQty: 0 });
    // Polymarket's own no is still a no, and its id may be tried again
    const z = await boot({ ...PM, "predict place": [fail("PREDICT_INSUFFICIENT_BALANCE", "Insufficient Predict COLLATERAL balance."), { command: "place", result: { response: { orderId: ORDER, status: "live", success: true, makingAmount: "0", takingAmount: "0" } } }] });
    expect(refusal(await z.t.place(pmOrder("w3"))).code).toBe("E_VENUE_INSUFFICIENT");
    expect(ok(await z.t.place(pmOrder("w3"))).ref).toBe(ORDER);
  });

  it("R4-13 · a perpetual's open, close or leverage change cut off is unsure; a swap's or a vault's is pending, followed by its quote id or job", async () => {
    const opened = await perpsBoot(PM["predict geoblock"], { "perps open": fail("MM_TIMEOUT", "mm did not finish in 660 s") });
    const o = refusal(await opened.t.place(perpBuy("p1")));
    expect([o.code, o.detail]).toEqual(["E_VENUE_UNREACHABLE", { unsure: true, placed: "unknown" }]);
    expect(o.message).toContain("Hyperliquid did not answer whether it took this (buy 0.001 BTC): it may have");
    const BTC_POS = { venue: "hyperliquid", symbol: "BTC", side: "long", size: "0.002", entryPrice: "59000.0", positionValue: "120.0", unrealizedPnl: "2.0", marginUsed: "24.0", leverage: 5 };
    const closed = await perpsBoot(PM["predict geoblock"], { "perps positions": [[BTC_POS]], "perps close": fail("PREDICT_ERROR", "Hyperliquid order failed: Bad Gateway") });
    expect(refusal(await closed.t.close!("BTC-PERP", 0.001, "p2")).detail).toEqual({ unsure: true, placed: "unknown" });
    const lev = await perpsBoot(PM["predict geoblock"], { "perps modify": fail("NETWORK_TIMEOUT", "socket hang up") });
    expect(refusal(await lev.t.setLeverage!("BTC-PERP", 3)).detail).toEqual({ unsure: true });
    // a resting limit order found since it was sent is the order
    const resting = { venue: "hyperliquid", orderId: "779", symbol: "BTC", side: "long", size: "0.001", originalSize: "0.001", limitPrice: "59000", timestamp: NOW };
    const found = await perpsBoot(PM["predict geoblock"], { "perps open": fail("NETWORK_UNREACHABLE", "fetch failed"), "perps orders": [[resting]] });
    expect(ok(await found.t.place(perpBuy("p3", { type: "limit", limitPrice: 59_000, worstPrice: undefined })))).toMatchObject({ ref: "779", status: "open" });
    // a swap: the quote, then an execute whose connection dropped
    const USDC = { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, symbol: "USDC" };
    const ETH = { address: "0x0000000000000000000000000000000000000000", decimals: 18, symbol: "ETH" };
    const q = (id: string, src: typeof ETH, dst: typeof ETH, spend: string, get: string, least: string) => ({ quoteId: id, request: { walletAddress: WALLET, srcChainId: 8453, destChainId: 8453, srcAsset: src, destAsset: dst, srcAssetAmount: spend }, quote: { destAssetAmount: get, minDestAssetAmount: least, feeData: { metabridge: { usd: "0.88" } }, protocols: ["uniswap"] } });
    const quotes = (args: string[]) => (args[3] === USDC.address ? q("q-ask", USDC, ETH, "100000000", "40000000000000000", "39800000000000000") : args[7] === "0.04" ? q("q-bid", ETH, USDC, "40000000000000000", "99200000", "98704000") : q("q-sell", ETH, USDC, "500000000000000000", "1240000000", "1233800000"));
    const sw = await boot({ "swap quote": quotes, "swap execute": fail("NETWORK_UNREACHABLE", "Could not reach the MetaMask Bridge API (fetch failed).") });
    ok(await sw.t.market("ETH/USDC@Base"));
    const s = ok(await sw.t.place({ symbol: "ETH/USDC@Base", side: "sell", type: "market", qty: 0.5, clientId: "s1" }));
    expect([s.ref, s.status]).toEqual(["q-sell", "pending"]);
    expect((s.native as { waiting: string }).waiting).toBe("the connection dropped after the swap was sent: MetaMask may still send it");
    // a vault: money in whose connection dropped
    const vault = { address: "0x00000000000000000000000000000000000Fa017", chainId: 8453, name: "USDC vault", protocol: { name: "made-up" }, underlyingTokens: [{ symbol: "USDC" }], apy: { total: 0.05 }, tvlUsd: 5_000_000, isTransactional: true, isRedeemable: true };
    const ev = await boot({ "earn markets": [[vault]], "earn supply": fail("NETWORK_UNREACHABLE", "fetch failed") });
    const earner = (ev.source as unknown as { earner: { product(id: string): Promise<unknown>; supply(p: unknown, a: number, id: string): Promise<unknown> } }).earner;
    const product = await earner.product(`8453:${vault.address.toLowerCase()}`);
    expect(ok(await earner.supply(product, 10, "e1"))).toMatchObject({ ref: "earn:e1", status: "pending" });
  });
});

describe("mm: connecting the MetaMask wallet", () => {
  it("R4-14 · a network failure, a rate limit or a place rule at `mm wallet show` is said as that, not as 'sign in'; the balance's no is read by mm's code", async () => {
    const show = async (err: MmError) => refusal(await metamaskSource({ venue: "metamask", label: "", run: mm({ "wallet show": err }).run, env: ON }));
    expect((await show(fail("NETWORK_UNREACHABLE", "fetch failed"))).code).toBe("E_VENUE_UNREACHABLE");
    expect((await show(fail("RATE_LIMITED", "Too many requests"))).message).toBe("MetaMask did not answer in time, or is limiting requests: try again in a minute");
    expect((await show(fail("AUTH_FAILED", "Authentication failed."))).code).toBe("E_ACCOUNT_CREDENTIAL");
    expect((await show(fail("ENOENT", "spawn mm ENOENT"))).message).toBe("the mm command line is not installed on this machine");
    // a 404 in mm's words is not "not installed"
    const missing = await show(fail("WALLET_ERROR", "Wallet not found (HTTP 404)"));
    expect([missing.code, missing.message]).toEqual(["E_VENUE_REJECTED", "MetaMask refused to show the wallet: Wallet not found (HTTP 404)"]);
    const placed = await show(fail("PREDICT_UNAVAILABLE_FOR_LEGAL_REASONS", "Unavailable in your region (PA, US)"));
    expect(placed.code).toBe("E_VENUE_GEOBLOCKED");
    expect(JSON.stringify(placed)).not.toMatch(/PA, US/);
    // connected: the balance read's no by its code
    const s = mm({ "wallet show": SHOW, "wallet balance": [BALANCE, fail("AUTH_FAILED", "Authentication failed."), fail("NETWORK_UNREACHABLE", "fetch failed")] });
    const opened = ok(await metamaskSource({ venue: "metamask", label: "", run: s.run, env: ON }));
    expect(refusal(await opened.source.read().catch((e: unknown) => e)).code).toBe("E_VENUE_UNAUTHORIZED");
    expect(refusal(await opened.source.read().catch((e: unknown) => e)).code).toBe("E_VENUE_UNREACHABLE");
  });
});

// ---- Robinhood's sign-in ------------------------------------------------------------------------------------------------------------

const RESOURCE = "https://agent.robinhood.com/mcp/trading";
const ISSUER = "https://agent.robinhood.com/mcp/trading";
const PR = "https://agent.robinhood.com/.well-known/oauth-protected-resource/mcp/trading";
const AS = "https://agent.robinhood.com/.well-known/oauth-authorization-server/mcp/trading";
const TOKEN = "https://agent.robinhood.com/oauth/token";
const REGISTER = "https://agent.robinhood.com/oauth/register";
const META: Record<string, HttpReply> = {
  [PR]: json({ authorization_servers: [ISSUER] }),
  [AS]: json({ issuer: ISSUER, authorization_endpoint: "https://robinhood.com/oauth/authorize", token_endpoint: TOKEN, registration_endpoint: REGISTER, code_challenge_methods_supported: ["S256"], authorization_response_iss_parameter_supported: true }),
};
function rh(answers: Record<string, HttpReply | ((n: number) => HttpReply)>) {
  const asked: string[] = [];
  const count: Record<string, number> = {};
  const http: Http = async (url, init = {}) => {
    asked.push(`${init.method ?? "GET"} ${url}`);
    count[url] = (count[url] ?? 0) + 1;
    const a = answers[url] ?? META[url];
    if (!a) return json({ error: "not_found" }, 404);
    return typeof a === "function" ? a(count[url]!) : a;
  };
  return { http, asked, answers };
}
const signIn = (http: Http, clock = () => NOW) => new OAuthSignIn({ resource: RESOURCE, name: "Robinhood", venue: "robinhood", http, clock });
const BANNED = Date.parse("2026-10-05T15:00:00.000Z");
const NETWORK: Array<[string, HttpReply, string]> = [
  ["a 451 in Robinhood's words", json({ error: "unavailable", error_description: "Robinhood is not available in your country." }, 451), "E_VENUE_GEOBLOCKED"],
  ["Cloudflare's 403 page", page(CF1009), "E_VENUE_GEOBLOCKED"],
  ["a ban until a time", json({ msg: `IP banned until ${BANNED}` }, 418), "E_VENUE_UNREACHABLE"],
  ["a 429", json({ error: "slow_down" }, 429, { retryAfterMs: 30_000 }), "E_VENUE_UNREACHABLE"],
  ["an outage", page("Service Unavailable", 503), "E_VENUE_UNREACHABLE"],
];

describe("Robinhood's sign-in: what this network is told", () => {
  it("R1-29 · discovery answered by an outage, an edge's page, a 429 or a place rule is not 'offers no way in': no answer, or the place rule", async () => {
    for (const [what, reply, code] of NETWORK) {
      const r = refusal(await signIn(rh({ [PR]: reply }).http).reachable());
      expect([what, r.code]).toEqual([what, code]);
      expect(r.message).not.toMatch(/refused finding where it signs people in/);
      noPage(r);
    }
    expect(refusal(await signIn(rh({ [PR]: page(AKAMAI) }).http).reachable()).message).toContain("Robinhood refuses this network");
    // a ban carries Robinhood's own time
    expect((refusal(await signIn(rh({ [PR]: NETWORK[2]![1] }).http).reachable()).native as { until: number }).until).toBe(BANNED);
    // only a real no-way-in is "closed": a metadata document without what a sign-in needs
    expect(refusal(await signIn(rh({ [PR]: json({ resource: RESOURCE }) }).http).reachable()).code).toBe("E_VENUE_REJECTED");
  });

  it("R1-33 · the reach asks the venue every time: a network change after a good discovery is seen, and a sign-in under way keeps its endpoints", async () => {
    let edgeNow = false;
    const net = rh({ [PR]: () => (edgeNow ? page(AKAMAI) : META[PR]!), [REGISTER]: json({ client_id: "client-made-up-1" }, 201) });
    const s = signIn(net.http);
    expect(await s.reachable()).toBeUndefined();
    const started = ok(await s.start("http://127.0.0.1:4820/api/account/signin/callback"));
    const before = net.asked.length;
    edgeNow = true;
    edge(refusal(await s.reachable()));
    expect(net.asked.length).toBe(before + 1);
    // what was found before still serves the sign-in already under way
    net.answers[TOKEN] = json({ access_token: "access-made-up-1", refresh_token: "refresh-made-up-1", expires_in: 3600 });
    expect(await s.finish({ state: started.state, code: "code-made-up-0001", iss: ISSUER })).toEqual({ ok: true });
  });

  it("R2-11 · renewing the sign-in from a network Robinhood refuses is said as that, the sign-in stays and is asked again; only invalid_grant means sign in again", async () => {
    let now = NOW;
    let answer: HttpReply = json({ access_token: "access-made-up-1", refresh_token: "refresh-made-up-1", expires_in: 3600 });
    const net = rh({ [REGISTER]: json({ client_id: "client-made-up-1" }, 201), [TOKEN]: () => answer });
    const s = signIn(net.http, () => now);
    const started = ok(await s.start("http://127.0.0.1:4820/api/account/signin/callback"));
    expect(await s.finish({ state: started.state, code: "code-made-up-0001", iss: ISSUER })).toEqual({ ok: true });
    now += 3_600_000;
    for (const [what, reply, code] of NETWORK) {
      answer = reply;
      const r = refusal(await s.token(started.state));
      expect([what, r.code]).toEqual([what, code]);
      expect(r.message).not.toMatch(/sign in again/);
      expect(JSON.stringify(r)).not.toContain("refresh-made-up-1");
      noPage(r);
      expect(s.status(started.state).status).toBe("ready");
    }
    answer = json({ error: "invalid_grant", error_description: "The refresh token is invalid." }, 400);
    const ran = refusal(await s.token(started.state));
    expect([ran.code, ran.message]).toEqual(["E_ACCOUNT_CREDENTIAL", "Robinhood's sign-in ran out and could not be renewed: sign in again from the account page"]);
    answer = json({ access_token: "access-made-up-2", refresh_token: "refresh-made-up-2", expires_in: 3600 });
    expect(await s.token(started.state)).toBe("access-made-up-2");
  });

  it("R2-11 · the code exchange: no answer leaves the sign-in waiting (the owner can come back to it), a place rule fails it as that; registration's place rule is said as that", async () => {
    let answer: HttpReply = page("Service Unavailable", 503);
    const net = rh({ [REGISTER]: json({ client_id: "client-made-up-1" }, 201), [TOKEN]: () => answer });
    const s = signIn(net.http);
    const started = ok(await s.start("http://127.0.0.1:4820/api/account/signin/callback"));
    const down = refusal(await s.finish({ state: started.state, code: "code-made-up-0001", iss: ISSUER }));
    expect(down.code).toBe("E_VENUE_UNREACHABLE");
    expect(s.status(started.state)).toEqual({ status: "waiting", error: down.message });
    answer = json({ error: "unavailable", error_description: "Robinhood is not available in your country." }, 451);
    expect(refusal(await s.finish({ state: started.state, code: "code-made-up-0001", iss: ISSUER })).code).toBe("E_VENUE_GEOBLOCKED");
    expect(s.status(started.state).status).toBe("failed");
    const reg = refusal(await signIn(rh({ [REGISTER]: page(CF1009) }).http).start("http://127.0.0.1:4820/api/account/signin/callback"));
    edge(reg);
  });
});

// ---- Kalshi, Alpaca and Robinhood Crypto: an edge's page is not a key's permission ---------------------------------------------------------

function stand(route: (method: string, url: string) => HttpReply | undefined) {
  const sent: string[] = [];
  const http: Http = async (url, init = {}) => {
    const method = init.method ?? "GET";
    sent.push(`${method} ${url}`);
    return route(method, url) ?? json({ error: { code: "not_found", message: "not found" } }, 404);
  };
  return { http, sent };
}

describe("Kalshi's trader", () => {
  const pem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const connect = async (later: (method: string, url: string) => HttpReply | undefined): Promise<LiveTrader> => {
    const k = stand((method, url) => {
      if (url.endsWith("/portfolio/balance")) return json({ balance: 10000 });
      if (url.includes("/portfolio/positions")) return json({ market_positions: [], cursor: "" });
      if (url.endsWith("/api_keys")) return json({ api_keys: [] });
      if (url.endsWith("/exchange/status")) return json({ exchange_active: true, trading_active: true });
      return later(method, url);
    });
    const opened = ok(await kalshiSource({ venue: "kalshi", label: "Kalshi", reference: "credentials/kalshi/api-key.json", key: { keyId: "made-up-key-id", privateKey: pem }, home: tmpdir(), http: k.http, clock: () => NOW }));
    return opened.source.trader!;
  };
  it("R1-16 · an edge's 403 page on a market or an order is the edge refusing this network (held ten minutes), never 'this key may not trade'", async () => {
    edge(refusal(await (await connect(() => page(AKAMAI))).market("KXFED-27APR-T4.00:YES")));
    edge(refusal(await (await connect(() => page(CF1009))).status("3b23c1c7-f4ef-4f0d-8b9a-9e53c61f1a0d", "KXFED-27APR-T4.00:YES")));
    // a 429 is held as long as Kalshi asked; a page answered in Kalshi's place with a 200 is no answer
    const slow = refusal(await (await connect(() => json({ error: "too many requests" }, 429, { retryAfterMs: 120_000 }))).market("KXFED-27APR-T4.00:YES"));
    expect([slow.code, slow.message]).toEqual(["E_VENUE_UNREACHABLE", "Kalshi is rate-limiting this machine: try again in 2 minutes"]);
    expect((slow.native as { until: number }).until).toBeGreaterThanOrEqual(Date.now() + 110_000);
    const portal = refusal(await (await connect(() => page("<html><title>Login to the network</title></html>", 200))).status("3b23c1c7-f4ef-4f0d-8b9a-9e53c61f1a0d", "KXFED-27APR-T4.00:YES"));
    expect([portal.code, (portal.native as { page?: boolean }).page]).toEqual(["E_VENUE_UNREACHABLE", true]);
    // Kalshi's own JSON location rule stays its own: an attestation it wants is its rule for some market categories, held to them alone
    const attest = refusal(await (await connect(() => json({ error: { code: "location_attestation_required", message: "attest your location" } }, 403))).market("KXFED-27APR-T4.00:YES"));
    expect([attest.code, attest.message, (attest.detail as { scope?: string }).scope]).toEqual(["E_VENUE_GEOBLOCKED", "Kalshi takes no API orders in this market's category without a current location attestation: its own rule, for these markets alone", "product"]);
  });
});

describe("Alpaca", () => {
  const KEY = { keyId: "made-up-key-id-0001", secret: "made-up-secret-alpaca-0001" };
  const connect = async (wallets: (url: string, n: number) => HttpReply, later: (method: string, url: string) => HttpReply | undefined = () => undefined) => {
    let n = 0;
    const a = stand((method, url) => {
      if (url.endsWith("/v2/account")) return json({ cash: "100", equity: "100" });
      if (url.endsWith("/v2/positions") && method === "GET") return json([]);
      if (url.includes("/v2/wallets")) return wallets(url, ++n);
      return later(method, url);
    });
    return ok(await alpacaSource({ venue: "alpaca", label: "Alpaca", reference: "credentials/alpaca.json", key: KEY, http: a.http, clock: () => NOW })).source;
  };

  it("R2-10 · the wallets probe at connect: a place rule, an edge's page or a ban is said as that, never 'Alpaca has not enabled the Crypto Wallets API'", async () => {
    for (const reply of [json({ message: "Unavailable For Legal Reasons" }, 451), page(CF1009), page(AKAMAI), json({ code: 40310000, message: "not available in your country" }, 403), json({ message: `IP banned until ${BANNED}` }, 418)]) {
      const s = await connect(() => reply);
      expect(s.writer).toBeUndefined();
      expect(s.readOnlyBecause).not.toMatch(/has not enabled the Crypto Wallets API/);
      expect(s.probe.note).not.toMatch(/has not enabled/);
      expect(JSON.stringify(s.probe)).not.toMatch(/\(XX\)|203\.0\.113\.9/);
    }
    // Alpaca's own JSON 403 is still Alpaca's answer about the account
    expect((await connect(() => json({ code: 40310000, message: "crypto wallets are not enabled for this account" }, 403))).readOnlyBecause).toMatch(/has not enabled the Crypto Wallets API/);
  });

  it("R2-10 · money in, once connected: a 451, an edge's page, a region 403 and a ban are told as such, with the ban's time", async () => {
    const cases: Array<[HttpReply, string]> = [
      [json({ message: "Unavailable For Legal Reasons" }, 451), "E_VENUE_GEOBLOCKED"],
      [page(CF1009), "E_VENUE_GEOBLOCKED"],
      [page(AKAMAI), "E_VENUE_GEOBLOCKED"],
      [json({ code: 40310000, message: "This service is not available in your country" }, 403), "E_VENUE_GEOBLOCKED"],
      [json({ message: `IP banned until ${BANNED}` }, 418), "E_VENUE_UNREACHABLE"],
    ];
    for (const [reply, code] of cases) {
      const s = await connect((_url, n) => (n === 1 ? json([]) : reply));
      const r = refusal(await s.writer!.depositAddress("USDC", "Ethereum"));
      expect(r.code).toBe(code);
      noPage(r);
      if (reply.status === 418) expect((r.native as { until: number }).until).toBe(BANNED);
      if (reply.status === 403 && reply.body === undefined) expect(r.native).toEqual({ status: 403, edge: true });
    }
  });

  it("R3-15 · Alpaca's words about the wallets keep no address of this machine's, in what is stored, shown and logged", async () => {
    const s = await connect(() => json({ message: "access from 203.0.113.7 denied" }, 403));
    expect(s.readOnlyBecause).toContain("(this machine's address)");
    expect(`${s.readOnlyBecause} ${s.probe.note}`).not.toContain("203.0.113.7");
  });

  it("R1-16 · the trader: an edge's page on a market or an order is the edge, not the account's permission", async () => {
    const s = await connect(() => json([]), () => page(AKAMAI));
    edge(refusal(await s.trader!.status("7b08df51-c1ac-453c-99f9-323a5f075f0d", "AAPL")));
    const t = await connect(() => json([]), (_m, url) => (url.includes("/v2/orders") ? page(CF1009) : undefined));
    edge(refusal(await t.trader!.status("7b08df51-c1ac-453c-99f9-323a5f075f0d", "AAPL")));
  });
});

describe("Robinhood Crypto's trader", () => {
  const pair = generateKeyPairSync("ed25519");
  const KEY = { apiKey: "rh-api-00000000-0000-4000-8000-00000000c0de", privateKey: pair.privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32).toString("base64") };
  const ACCOUNTS = { results: [{ account_number: "5512340009", status: "active", buying_power: "1000.00", buying_power_currency: "USD", is_api_tradable: true }], next: null };
  const PAIR = { symbol: "BTC-USD", asset_code: "BTC", quote_code: "USD", status: "tradable", is_api_tradable: true, asset_increment: "0.00000001", quote_increment: "0.01", min_order_amount: "1", max_order_size: "100" };
  const connect = async (later: (method: string, url: string) => HttpReply | undefined) => {
    const r = stand((method, url) => {
      if (url.includes("/trading/accounts/")) return json(ACCOUNTS);
      if (url.includes("/trading/holdings/")) return json({ results: [], next: null });
      if (url.includes("/trading_pairs/")) return json({ results: [PAIR], next: null });
      return later(method, url);
    });
    const opened = ok(await robinhoodCryptoSource({ venue: "robinhood-crypto", label: "", reference: "credentials/robinhood-crypto.json", key: KEY, http: r.http, clock: () => NOW }));
    return { t: opened.source.trader!, sent: r.sent };
  };
  const REF = "6f1d2c3b-4a59-4e8d-9c7b-0a1b2c3d4e5f";

  it("R2-9 · an order, its status or its cancel refused for this machine's address is the key's IP list, as a read says it — never a missing key action", async () => {
    const ipList = json({ type: "client_error", errors: [{ detail: "IP address not allowed." }] }, 403);
    for (const call of ["status", "cancel"] as const) {
      const { t } = await connect(() => ipList);
      const r = refusal(await t[call](REF, "BTC-USD"));
      expect([r.code, r.detail]).toEqual(["E_VENUE_PERMISSION", { ipList: true }]);
      expect(r.message).toContain("refuses this key from this machine's address");
      expect(r.message).not.toMatch(/Place crypto orders/);
    }
  });

  it("R1-16 · an edge's page on an order, its status or its cancel is the edge refusing this network; the order is sent once", async () => {
    const a = await connect(() => page(AKAMAI));
    edge(refusal(await a.t.status(REF, "BTC-USD")));
    edge(refusal(await a.t.cancel(REF, "BTC-USD")));
    const b = await connect((method) => (method === "POST" ? page(CF1009) : undefined));
    edge(refusal(await b.t.place({ symbol: "BTC-USD", side: "buy", type: "limit", qty: 0.001, limitPrice: 60_000, clientId: "ord-0001" })));
    expect(b.sent.filter((s) => s.startsWith("POST")).length).toBe(1);
    // a rate limit is held as long as Robinhood asked
    const c = await connect(() => json({ errors: [{ detail: "Request was throttled." }] }, 429, { retryAfterMs: 90_000 }));
    expect(refusal(await c.t.status(REF, "BTC-USD")).message).toBe("Robinhood Crypto is rate-limiting this machine: try again in 90 s");
  });
});

describe("Robinhood stocks, through Robinhood's MCP server", () => {
  const done = (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify({ data }) }], structuredContent: { data } });
  const TOOLS: McpTool[] = ["get_accounts", "get_portfolio", "get_equity_positions", "get_equity_quotes", "get_equity_tradability", "place_equity_order", "get_equity_orders", "cancel_equity_order"].map((name) => ({ name }));
  const READS: Record<string, unknown> = { get_accounts: done({ accounts: [{ account_number: "5RH00009876", brokerage_account_type: "individual", agentic_allowed: true }] }), get_portfolio: done({ cash: "500.00" }), get_equity_positions: done({ positions: [] }) };
  const http = (status: number, body: string) => new StreamableHTTPError(status, `Error POSTing to endpoint: ${body}`);
  function server(o: { open?: unknown; place?: unknown }) {
    const called: string[] = [];
    let opens = 0;
    const open: OpenMcp = async () => {
      opens++;
      // the connection's first read opens a session; a later failure to open is the test's
      if (o.open && opens > 1) throw o.open;
      const session: McpSession = {
        tools: async () => TOOLS,
        call: async (name) => {
          called.push(name);
          if (name === "place_equity_order" && o.place) throw o.place;
          return READS[name] ?? done({});
        },
        close: async () => undefined,
      };
      return session;
    };
    return { open, called };
  }
  const connectWith = (open: OpenMcp) => robinhoodStocksSource({ venue: "robinhood", label: "", token: async () => "access-made-up-0001", open });
  const failing = (err: unknown): OpenMcp => async () => {
    throw err;
  };

  it("R4-25 · a refused session is Robinhood's answer: its place rule, an edge's page, a ban with its time — and only a call with no HTTP answer is 'could not be reached'", async () => {
    const placeRule = refusal(await connectWith(failing(http(451, JSON.stringify({ detail: "Robinhood is not available in your country." })))));
    expect([placeRule.code, holdBackMs(placeRule)]).toEqual(["E_VENUE_GEOBLOCKED", 600_000]);
    edge(refusal(await connectWith(failing(http(403, AKAMAI)))));
    const banned = refusal(await connectWith(failing(http(418, JSON.stringify({ msg: `IP banned until ${BANNED}` })))));
    expect([banned.code, (banned.native as { until: number }).until]).toEqual(["E_VENUE_UNREACHABLE", BANNED]);
    const gone = refusal(await connectWith(failing(new StreamableHTTPError(-1, "Unexpected content type: text/html"))));
    expect([gone.code, gone.message]).toEqual(["E_VENUE_UNREACHABLE", "Robinhood could not be reached"]);
    expect(refusal(await connectWith(failing(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } })))).message).toBe("Robinhood could not be reached");
    // a session refused later, on an order, the same way
    const s = server({ open: http(451, JSON.stringify({ detail: "Robinhood is not available in your country." })) });
    const t = ok(await connectWith(s.open)).source.trader!;
    expect(refusal(await t.place({ symbol: "AAPL", side: "buy", type: "limit", qty: 1, limitPrice: 200, clientId: "ord-0001" })).code).toBe("E_VENUE_GEOBLOCKED");
  });

  it("R4-18 · place_equity_order refused at the transport by place, by the edge or for too many requests is sent once; a 5xx, which may have reached Robinhood, is sent once more under its ref_id", async () => {
    const order: OrderRequest = { symbol: "AAPL", side: "buy", type: "limit", qty: 1, limitPrice: 200, clientId: "ord-0001" };
    const cases: Array<[unknown, string, number]> = [
      [http(451, JSON.stringify({ detail: "Robinhood is not available in your country." })), "E_VENUE_GEOBLOCKED", 1],
      [http(403, CF1009), "E_VENUE_GEOBLOCKED", 1],
      [http(429, JSON.stringify({ detail: "Request was throttled." })), "E_VENUE_UNREACHABLE", 1],
      [http(503, "Service Unavailable"), "E_VENUE_UNREACHABLE", 2],
    ];
    for (const [err, code, sent] of cases) {
      const s = server({ place: err });
      const t = ok(await connectWith(s.open)).source.trader!;
      const r = refusal(await t.place(order));
      expect([r.code, s.called.filter((n) => n === "place_equity_order").length]).toEqual([code, sent]);
      noPage(r);
    }
  });
});
