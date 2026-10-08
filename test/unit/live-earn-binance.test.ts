import { createHmac } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ccxt from "ccxt";
import { afterAll, describe, expect, it } from "vitest";
import { isRefusal, type Refusal } from "../../src/core/errors.ts";
import { cardHash, type Outcome } from "../../src/portfolio/account/exchange.ts";
import { byAsset } from "../../src/portfolio/account/holdings.ts";
import type { LiveEarn } from "../../src/portfolio/account/live-earn.ts";
import { signAgent, signOwner, simKey, type AgentAction, type OwnerAction } from "../../src/portfolio/account/sign.ts";
import { binanceEarner, exchangeEarner, type EarnProduct, type LiveEarner } from "../../src/portfolio/live/earn.ts";
import type { ExchangeClient, OpenExchange } from "../../src/portfolio/live/exchange.ts";
import type { LiveDeps } from "../../src/portfolio/live/index.ts";
import { PortfolioService } from "../../src/portfolio/service.ts";

/** BINANCE SIMPLE EARN FLEXIBLE, built from Binance's own documentation: developers.binance.com › Simple Earn › Flexible/Locked (the list,
 * the position, redeem's parameters, the redemption record) and › Error Code, read 2026-10-08; the subscribe call's parameters and the two
 * answers (`{purchaseId, success}`, `{redeemId, success}`) from Binance's own connector, npm @binance/simple-earn 16.0.5, and the defaults
 * (autoSubscribe true, sourceAccount SPOT) from its Ruby connector, binance-connector-ruby lib/binance/spot/simple_earn.rb, the same day.
 * Binance answers the developer's machine 451, so nothing here has been seen from Binance itself: every fixture below is a DOCUMENTED
 * SHAPE, labelled as such, with made-up values.
 *
 * The first part runs the REAL installed exchange library (ccxt 4.5.85) with its network call replaced: every request it builds is recorded
 * — the URL, the form body, the HMAC signature — and answered with Binance's documented shapes, read by the library's own error handling.
 * The second part is the account's earn door with Binance connected live through the exchange connector, a stand-in client answering in
 * the same shapes: Guard's card, Beast inside the earn limit, the server's cap, Binance's refusals, the page counting the money once.
 * Nothing leaves the process, and no key is anyone's: made-up strings. */
type Dict = Record<string, unknown>;
const NOW = Date.parse("2026-10-08T09:00:00.000Z");
const START = NOW;
const DAY = 86_400_000;
const CLIENT = "0123456789abcdef0123456789abcdef";
const KEY = { apiKey: "made-up-binance-key-0001", secret: "made-up-binance-secret-0001" };
const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));

// ---- documented shapes ------------------------------------------------------------------------------------------------------------

/** DOCUMENTED SHAPE: a row of GET /sapi/v1/simple-earn/flexible/list (developers.binance.com, read 2026-10-08); values made up */
const listRow = (over: Dict = {}): Dict => ({ asset: "USDT", latestAnnualPercentageRate: "0.04120000", tierAnnualPercentageRate: { "0-200USDT": 0.03 }, airDropPercentageRate: "0", canPurchase: true, canRedeem: true, isSoldOut: false, hot: true, minPurchaseAmount: "0.10000000", productId: "USDT001", subscriptionStartTime: 1646182276000, status: "PURCHASING", ...over });
/** DOCUMENTED SHAPE: a row of GET /sapi/v1/simple-earn/flexible/position (the same page); values made up */
const positionRow = (over: Dict = {}): Dict => ({ totalAmount: "40.00000000", tierAnnualPercentageRate: { "0-200USDT": 0.03 }, latestAnnualPercentageRate: "0.04120000", yesterdayAirdropPercentageRate: "0", asset: "USDT", airDropAsset: "BETH", canRedeem: true, collateralAmount: "0", productId: "USDT001", yesterdayRealTimeRewards: "0.00451000", cumulativeBonusRewards: "0.12000000", cumulativeRealTimeRewards: "0.30000000", cumulativeTotalRewards: "0.42000000", autoSubscribe: false, ...over });
/** DOCUMENTED SHAPE: a row of GET /sapi/v1/simple-earn/flexible/history/redemptionRecord (the same page; PAID is the status it shows) */
const redemptionRow = (status: string, over: Dict = {}): Dict => ({ amount: "10.00000000", asset: "USDT", time: 1791225581000, projectId: "USDT001", redeemId: 40608, destAccount: "SPOT", status, ...over });
/** the paged answer: `rows` and `total` */
const paged = (rows: Dict[], total = rows.length) => ({ rows, total });
/** DOCUMENTED SHAPES: POST flexible/subscribe and flexible/redeem (@binance/simple-earn 16.0.5 SubscribeFlexibleProductResponse,
 * RedeemFlexibleProductResponse) */
const SUBSCRIBED = { purchaseId: 40607, success: true };
const REDEEMED = { redeemId: 40608, success: true };
/** DOCUMENTED SHAPE: Binance's error answer, `{code, msg}`, with a code from its Simple Earn error list */
const binanceNo = (code: number, msg: string, status = 400) => ({ status, body: { code, msg } });
/** Binance's 451, as it answered the developer's machine on 2026-10-05 (live-public-markets.test.ts keeps the whole sentence) */
const LOCATION_451 = { status: 451, body: { code: 0, msg: "Service unavailable from a restricted location according to 'b. Eligibility' in https://www.binance.com/en/terms. Please contact customer service if you believe you received this message in error." } };

const ok = <T>(x: T | Refusal): T => {
  if (isRefusal(x)) throw new Error(`expected an answer, got ${x.code}: ${x.message} ${JSON.stringify(x.native)}`);
  return x;
};
const refused = (x: unknown): Refusal => {
  if (!isRefusal(x)) throw new Error(`expected a refusal, got ${JSON.stringify(x).slice(0, 300)}`);
  for (const s of Object.values(KEY)) expect(JSON.stringify(x)).not.toContain(s);
  return x;
};

// ---- the real library, its network call replaced -----------------------------------------------------------------------------------

interface Req {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
}
type Reply = { status?: number; body: unknown } | Error;
interface Lib extends ExchangeClient {
  nonce: () => number;
  milliseconds: () => number;
  fetch: (url: string, method?: string, headers?: Record<string, string>, body?: string) => Promise<unknown>;
  handleErrors(code: number, reason: string, url: string, method: string, headers: Dict, body: string, response: unknown, requestHeaders: unknown, requestBody: unknown): unknown;
  handleHttpStatusCode(code: number, reason: string, url: string, method: string, body: string): unknown;
}

function library(id = "binance") {
  const Ctor = (ccxt as unknown as Record<string, new (config: Dict) => Lib>)[id]!;
  const x = new Ctor({ ...KEY, enableRateLimit: false });
  x.nonce = () => NOW;
  x.milliseconds = () => NOW;
  const seen: Req[] = [];
  const replies: Reply[] = [];
  x.fetch = async (url, method = "GET", headers = {}, body = undefined) => {
    seen.push({ method, url, headers: { ...headers }, body });
    const r = replies.shift();
    if (!r) throw new Error(`not set up in this test: ${method} ${url}`);
    if (r instanceof Error) throw r;
    const status = r.status ?? 200;
    const text = JSON.stringify(r.body);
    // the library's own reading of the answer, as its real fetch does it (base/Exchange.js handleRestResponse)
    if (x.handleErrors(status, "", url, method, {}, text, r.body, headers, body) === undefined) x.handleHttpStatusCode(status, "", url, method, text);
    return r.body;
  };
  return { x, seen, answer: (...r: Reply[]) => replies.push(...r) };
}

/** a request as Binance reads it: the method and path, the API key header, and the parameters — after checking that the signature is the
 * HMAC-SHA256 of the rest with the secret, and that the timestamp is the library's clock */
function signed(r: Req): { call: string; apiKey: string | undefined; params: Record<string, string> } {
  const u = new URL(r.url);
  const raw = r.method === "GET" ? u.search.slice(1) : (r.body ?? "");
  const [unsigned, signature] = raw.split("&signature=");
  expect(signature).toBe(createHmac("sha256", KEY.secret).update(unsigned!).digest("hex"));
  const { timestamp, recvWindow: _w, ...params } = Object.fromEntries(new URLSearchParams(unsigned));
  expect(timestamp).toBe(String(NOW));
  if (r.method === "POST") expect(r.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
  return { call: `${r.method} ${u.origin}${u.pathname}`, apiKey: r.headers["X-MBX-APIKEY"], params };
}
const SAPI = "https://api.binance.com/sapi/v1/simple-earn";

function earner(can: string[] = ["read", "trade spot and margin"]) {
  const lib = library();
  const e = exchangeEarner({ client: lib.x, venue: "binance", name: "Binance", key: KEY, can, now: () => NOW, price: async (a) => (a === "BTC" ? 60_000 : undefined) });
  if (!e) throw new Error("no earner for the real library's binance client");
  return { e, ...lib };
}

describe("Binance Simple Earn Flexible through the real exchange library: who gets it", () => {
  it("binance.com's own client gets it, through the library's implicit Simple Earn calls; Binance.US documents none, the futures clients are not where money lands, and a library without the calls has none", () => {
    const lib = library();
    for (const c of ["sapiGetSimpleEarnFlexibleList", "sapiGetSimpleEarnFlexiblePosition", "sapiPostSimpleEarnFlexibleSubscribe", "sapiPostSimpleEarnFlexibleRedeem", "sapiGetSimpleEarnFlexibleHistoryRedemptionRecord"]) expect(typeof (lib.x as unknown as Dict)[c]).toBe("function");
    expect(exchangeEarner({ client: lib.x, venue: "binance", name: "Binance", key: KEY, can: [] })?.what).toBe("Simple Earn Flexible: out at any time");
    // Binance.US inherits the calls in the library, and documents no Simple Earn (docs.binance.us: staking alone)
    expect(exchangeEarner({ client: library("binanceus").x, venue: "binanceus", name: "Binance.US", key: KEY, can: [] })).toBeUndefined();
    expect(exchangeEarner({ client: library("binanceusdm").x, venue: "binanceusdm", name: "Binance USDⓈ-M", key: KEY, can: [] })).toBeUndefined();
    expect(exchangeEarner({ client: { id: "binance", fetchBalance: async () => ({}) }, venue: "binance", name: "Binance", key: KEY, can: [] })).toBeUndefined();
    // nothing was asked of anyone
    expect(lib.seen).toEqual([]);
  });

  it("may this key put money in: Binance's apiRestrictions says Enable Spot & Margin Trading, which subscribe and redeem need; unsaid, its first refusal will", () => {
    expect(earner().e.can).toBe(true);
    const readOnly = earner(["read"]).e;
    expect([readOnly.can, readOnly.whyNot]).toEqual([false, 'this Binance key may not trade: Simple Earn\'s subscription and redemption need its "Enable Spot & Margin Trading" permission (set on the key at Binance)']);
    expect(earner([]).e.can).toBe("unknown");
  });
});

describe("Binance Simple Earn Flexible through the real exchange library: the products, what is held", () => {
  it("the products: GET flexible/list signed with the account's key, page by page; the real-time APR as Binance states it, the bonus tiers in its note, the least that goes in, out at once to the spot account; a sold-out one says so", async () => {
    const { e, seen, answer } = earner();
    // a full first page asks for the second
    const many = Array.from({ length: 100 }, (_, i) => listRow({ asset: `C${i}`, productId: `C${i}001`, latestAnnualPercentageRate: "0.01000000", tierAnnualPercentageRate: {} }));
    answer({ body: paged(many, 102) }, { body: paged([listRow(), listRow({ asset: "BTC", productId: "BTC001", latestAnnualPercentageRate: "0.00350000", tierAnnualPercentageRate: { "0-0.5BTC": 0.01, "0.5-1BTC": 0.005 }, minPurchaseAmount: "0.00010000", isSoldOut: true })], 102) });
    const list = ok(await e.products());
    expect(seen.map(signed)).toEqual([
      { call: `GET ${SAPI}/flexible/list`, apiKey: KEY.apiKey, params: { current: "1", size: "100" } },
      { call: `GET ${SAPI}/flexible/list`, apiKey: KEY.apiKey, params: { current: "2", size: "100" } },
    ]);
    expect(list).toHaveLength(102);
    const usdt = list.find((p) => p.id === "USDT001")!;
    expect(usdt).toEqual<EarnProduct>({ id: "USDT001", asset: "USDT", name: "USDT · Simple Earn Flexible", apy: 0.0412, rateKind: "apr", protocol: "Binance Simple Earn", minAmount: 0.1, lockDays: 0, priceUsd: 1, lands: "your Binance spot account", canSupply: true, canWithdraw: true, note: "Binance Simple Earn Flexible: out at any time — Binance returns what is redeemed to your Binance spot account at once, within its daily redemption limits. The rate is its real-time APR, and it pays a bonus tiered APR besides (0-200USDT 3%). Only what is in your Binance spot account goes in, and the account never turns on Binance's Auto-Subscribe" });
    expect(list.find((p) => p.id === "BTC001")).toMatchObject({ asset: "BTC", apy: 0.0035, minAmount: 0.0001, canSupply: false, canWithdraw: true, why: "Binance says it is sold out" });
    expect(list.find((p) => p.id === "BTC001")!.note).toContain("(0-0.5BTC 1%, 0.5-1BTC 0.5%)");
    // the whole list, hundreds of products, is not priced asset by asset: a dollar stablecoin is a dollar, the rest carry no price here
    expect(list.find((p) => p.id === "BTC001")!.priceUsd).toBeUndefined();
    // kept five minutes: asked again, nothing is sent
    ok(await e.products());
    expect(seen).toHaveLength(2);
  });

  it("one asset when asked (its own list); an asset Binance could not have is none, and nothing is sent", async () => {
    const { e, seen, answer } = earner();
    answer({ body: paged([listRow({ canPurchase: false, status: "END" })]) });
    const usdt = ok(await e.products(" usdt "));
    expect(signed(seen[0]!).params).toEqual({ asset: "USDT", current: "1", size: "100" });
    expect(usdt).toEqual([expect.objectContaining({ id: "USDT001", canSupply: false, why: "Binance takes no money into it now (END)" })]);
    // the library writes these queries without escaping them: nothing that is not an asset goes in
    expect(ok(await e.products("USDT&redeemAll=true"))).toEqual([]);
    expect(seen).toHaveLength(1);
    // one asset's list is priced, once
    answer({ body: paged([listRow({ asset: "BTC", productId: "BTC001", latestAnnualPercentageRate: "0.00350000" })]) });
    expect(ok(await e.products("BTC")).map((p) => [p.id, p.priceUsd])).toEqual([["BTC001", 60_000]]);
  });

  it("one product, read afresh: in its own asset's list once seen, else every list; one Binance no longer lists but something is in can only come out; anything but Binance's id is refused before asking", async () => {
    const { e, seen, answer } = earner();
    // not seen yet: every list — and the one product read is priced, whatever the list carried
    answer({ body: paged([listRow(), listRow({ asset: "BTC", productId: "BTC001" })]) });
    expect(ok(await e.product("BTC001"))).toMatchObject({ id: "BTC001", asset: "BTC", priceUsd: 60_000 });
    expect(signed(seen[0]!).params).toEqual({ current: "1", size: "100" });
    // seen: its asset's list alone
    answer({ body: paged([listRow({ latestAnnualPercentageRate: "0.05000000" })]) });
    expect(ok(await e.product("USDT001")).apy).toBe(0.05);
    expect(signed(seen[1]!).params).toEqual({ asset: "USDT", current: "1", size: "100" });
    // no longer listed (never seen, so every list is read): what is held in it can come out, nothing goes in
    answer({ body: paged([]) }, { body: paged([positionRow({ productId: "BETH001", asset: "BETH", totalAmount: "0.5" })]) });
    const gone = ok(await e.product("BETH001"));
    expect([gone.asset, gone.canSupply, gone.canWithdraw, gone.why, gone.lands]).toEqual(["BETH", false, true, "Binance does not list it now: what is in it can only come out", "your Binance spot account"]);
    expect(signed(seen.at(-1)!)).toMatchObject({ call: `GET ${SAPI}/flexible/position`, params: { productId: "BETH001", current: "1", size: "100" } });
    answer({ body: paged([]) }, { body: paged([]) });
    expect(refused(await e.product("NONE001")).message).toBe("Binance lists no Simple Earn Flexible product NONE001 now");
    const asked = seen.length;
    expect(refused(await e.product("savings:USDT")).message).toBe('a product at Binance is Binance\'s own Simple Earn Flexible product id (for example USDT001), not "savings:USDT"');
    expect(refused(await e.product("USDT001&amount=9")).code).toBe("E_ACCOUNT_BAD_ACTION");
    expect(seen).toHaveLength(asked);
  });

  it("what is held: GET flexible/position, the position's total in the asset (its real-time rewards are in it), the APR, earned so far, priced", async () => {
    const { e, seen, answer } = earner();
    answer({ body: paged([positionRow(), positionRow({ asset: "BTC", productId: "BTC001", totalAmount: "0.01500000", latestAnnualPercentageRate: "0.00350000", cumulativeTotalRewards: "0.00002000" }), positionRow({ asset: "ETH", productId: "ETH001", totalAmount: "0" })]) });
    const held = ok(await e.positions());
    expect(signed(seen[0]!)).toEqual({ call: `GET ${SAPI}/flexible/position`, apiKey: KEY.apiKey, params: { current: "1", size: "100" } });
    expect(held).toEqual([
      { product: "USDT001", id: "USDT001", asset: "USDT", amount: 40, usd: 40, apy: 0.0412, accrued: 0.42, accruedUsd: 0.42, name: "USDT · Simple Earn Flexible", protocol: "Binance Simple Earn" },
      { product: "BTC001", id: "BTC001", asset: "BTC", amount: 0.015, usd: 900, apy: 0.0035, accrued: 0.00002, accruedUsd: 1.2, name: "BTC · Simple Earn Flexible", protocol: "Binance Simple Earn" },
    ]);
  });
});

describe("Binance Simple Earn Flexible through the real exchange library: money in and out", () => {
  const USDT001: EarnProduct = { id: "USDT001", asset: "USDT", name: "USDT · Simple Earn Flexible", lands: "your Binance spot account", canSupply: true, canWithdraw: true };

  it("money in: POST flexible/subscribe from the spot account, Auto-Subscribe off unless the owner turned it on at Binance (read from the position first); credited at once; once per client id", async () => {
    const { e, seen, answer } = earner();
    answer({ body: paged([]) }, { body: SUBSCRIBED });
    const s = ok(await e.supply(USDT001, 25, CLIENT));
    expect(seen.map(signed)).toEqual([
      { call: `GET ${SAPI}/flexible/position`, apiKey: KEY.apiKey, params: { productId: "USDT001", current: "1", size: "100" } },
      { call: `POST ${SAPI}/flexible/subscribe`, apiKey: KEY.apiKey, params: { productId: "USDT001", amount: "25", autoSubscribe: "false", sourceAccount: "SPOT" } },
    ]);
    expect([s.ref, s.status, s.native]).toEqual(["subscribe:USDT001:40607", "done", { request: { productId: "USDT001", amount: "25", autoSubscribe: false, sourceAccount: "SPOT" }, answer: { purchaseId: "40607", success: true } }]);
    // the same client id again is the same request: nothing is subscribed twice
    expect(ok(await e.supply(USDT001, 25, CLIENT)).ref).toBe("subscribe:USDT001:40607");
    expect(seen).toHaveLength(2);
    // the owner had turned Auto-Subscribe on at Binance for this product: it is sent back on, as the owner set it
    answer({ body: paged([positionRow({ autoSubscribe: true })]) }, { body: SUBSCRIBED });
    ok(await e.supply(USDT001, 0.5, "f".repeat(32)));
    expect(signed(seen[3]!).params).toEqual({ productId: "USDT001", amount: "0.5", autoSubscribe: "true", sourceAccount: "SPOT" });
    expect(ok(await e.status!("subscribe:USDT001:40607", USDT001, "supply")).status).toBe("done");
  });

  it("money out: POST flexible/redeem back to the spot account, an amount (redeemAll false, always sent: the sources differ on its default) or all of it by redeemAll; done when the redemption record says PAID, under way until then, rejected if it failed", async () => {
    const { e, seen, answer } = earner();
    answer({ body: REDEEMED }, { body: paged([redemptionRow("PAID")]) });
    const now = ok(await e.withdraw(USDT001, 10, CLIENT, false));
    expect(seen.map(signed)).toEqual([
      { call: `POST ${SAPI}/flexible/redeem`, apiKey: KEY.apiKey, params: { productId: "USDT001", redeemAll: "false", amount: "10", destAccount: "SPOT" } },
      { call: `GET ${SAPI}/flexible/history/redemptionRecord`, apiKey: KEY.apiKey, params: { redeemId: "40608" } },
    ]);
    expect([now.ref, now.status]).toEqual(["redeem:USDT001:40608", "done"]);
    expect(now.native).toMatchObject({ answer: { redeemId: "40608", success: true }, record: { redeemId: "40608", record: { status: "PAID", destAccount: "SPOT" } } });
    // all of it: Binance's own redeemAll, and no amount; its record not there yet: under way, and followed
    answer({ body: { redeemId: 40609, success: true } }, { body: paged([]) });
    const all = ok(await e.withdraw(USDT001, 40, "e".repeat(32), true));
    expect(signed(seen[2]!).params).toEqual({ productId: "USDT001", redeemAll: "true", destAccount: "SPOT" });
    expect([all.ref, all.status]).toEqual(["redeem:USDT001:40609", "pending"]);
    answer({ body: paged([redemptionRow("PAYING", { redeemId: 40609 })]) }, { body: paged([redemptionRow("PAID", { redeemId: 40609 })]) }, { body: paged([redemptionRow("FAILED", { redeemId: 40609 })]) });
    expect(ok(await e.status!(all.ref, USDT001, "withdraw")).status).toBe("pending");
    expect(ok(await e.status!(all.ref, USDT001, "withdraw")).status).toBe("done");
    expect(ok(await e.status!(all.ref, USDT001, "withdraw")).status).toBe("rejected");
    expect(signed(seen.at(-1)!).params).toEqual({ redeemId: "40609" });
  });

  it("Binance's refusals, read by the library's own error handling, in Binance's words with what the owner can do; its 451 is its rule for the place; the key never in what is shown", async () => {
    const { e, answer } = earner();
    const into = (n: number) => e.supply(USDT001, 25, String(n).repeat(32));
    answer({ body: paged([]) }, binanceNo(-6012, "Balance not enough"));
    const short = refused(await into(1));
    expect([short.code, short.message]).toEqual(["E_VENUE_INSUFFICIENT", "Binance refused to put 25 USDT into USDT · Simple Earn Flexible: Balance not enough (-6012). Only what is in your Binance spot account goes in"]);
    expect(short.native).toMatchObject({ error: "InsufficientFunds" });
    answer({ body: paged([]) }, binanceNo(-6005, "Smaller than min purchase limit"));
    expect(refused(await into(2))).toMatchObject({ code: "E_VENUE_ORDER_INVALID", message: "Binance refused to put 25 USDT into USDT · Simple Earn Flexible: Smaller than min purchase limit (-6005)" });
    answer({ body: paged([]) }, binanceNo(-6004, "Product not in purchase status"));
    expect(refused(await into(3)).code).toBe("E_VENUE_MARKET_CLOSED");
    // "Product not exist or you don't have permission" is about the product, not the key: Binance's words, as a no
    answer({ body: paged([]) }, binanceNo(-6003, "Product not exist or you don't have permission"));
    expect(refused(await into(4))).toMatchObject({ code: "E_VENUE_REJECTED", message: "Binance refused to put 25 USDT into USDT · Simple Earn Flexible: Product not exist or you don't have permission (-6003)" });
    answer({ body: paged([]) }, binanceNo(-6019, "Need confirm"));
    expect(refused(await into(5)).message).toBe("Binance refused to put 25 USDT into USDT · Simple Earn Flexible: Need confirm (-6019). It asks for a confirmation, and the account does not confirm it for you: do it at Binance if you mean to");
    // -2015: one answer for a missing permission, a wrong key and an IP not on the key's list — the permission these calls need is said
    answer({ body: paged([]) }, binanceNo(-2015, "Invalid API-key, IP, or permissions for action.", 401));
    const perm = refused(await into(6));
    expect([perm.code, perm.message]).toEqual(["E_VENUE_PERMISSION", 'Binance refused to put 25 USDT into USDT · Simple Earn Flexible: subscribing and redeeming need the key\'s "Enable Spot & Margin Trading" permission, and reading Simple Earn needs "Enable Reading" (set on the key at Binance). Binance gives this one answer (-2015) for a missing permission, a wrong key and an IP not on the key\'s list']);
    answer(binanceNo(-6006, "Redeem amount error"));
    expect(refused(await e.withdraw(USDT001, 500, "7".repeat(32), false))).toMatchObject({ code: "E_VENUE_ORDER_INVALID", message: "Binance refused to take 500 USDT out of USDT · Simple Earn Flexible: Redeem amount error (-6006)" });
    answer(binanceNo(-6018, "Asset not enough"));
    expect(refused(await e.withdraw(USDT001, 500, "8".repeat(32), false)).message).toBe("Binance refused to take 500 USDT out of USDT · Simple Earn Flexible: Asset not enough (-6018)");
    // the place: Binance's rule, said as such — the account does not look for a way around it
    answer(LOCATION_451);
    const place = refused(await e.positions());
    expect([place.code, place.message]).toEqual(["E_VENUE_GEOBLOCKED", "Binance does not serve this location: that is its own rule, and the account does not look for a way around it"]);
    // a refusal placed nothing: the same client id may go again
    answer({ body: paged([]) }, { body: SUBSCRIBED });
    expect(ok(await into(1)).status).toBe("done");
  });
});

// ---- the account's door, with Binance connected live through the exchange connector -----------------------------------------------

type NoNonce<T> = T extends unknown ? Omit<T, "nonce"> : never;
const owner = simKey("owner");
const cc = simKey("agent:claude-code");
const thrown = (name: string, message: string) => Object.assign(new Error(message), { name });

/** Binance as the exchange library would be with an account there: a stand-in client answering in Binance's documented shapes. Its spot
 * balance carries the Simple Earn position as LDUSDT, as Binance's spot account does */
function standIn(o: { trade?: boolean } = {}) {
  const b = { calls: [] as Array<[string, Dict]>, held: [positionRow()] as Dict[], products: [listRow(), listRow({ asset: "BTC", productId: "BTC001", latestAnnualPercentageRate: "0.00350000", tierAnnualPercentageRate: {}, minPurchaseAmount: "0.00010000" })] as Dict[], records: {} as Record<string, string>, fail: {} as Record<string, Error>, client: undefined as unknown as ExchangeClient };
  let id = 70_000;
  const call = (name: string, run: (p: Dict) => unknown) => async (p: Dict = {}) => {
    b.calls.push([name, p]);
    const f = b.fail[name];
    if (f) {
      delete b.fail[name];
      throw f;
    }
    return run(p);
  };
  b.client = {
    id: "binance",
    name: "Binance",
    requiredCredentials: { apiKey: true, secret: true },
    markets: { "ETH/USDT": {} },
    async loadMarkets() {},
    async fetchTime() {
      return 1;
    },
    async fetchBalance(params: Dict = {}) {
      return params.type === "funding" ? { total: { USDT: 50 } } : { total: { USDT: 500, LDUSDT: 40 } };
    },
    async fetchTickers() {
      return { "ETH/USDT": { last: 2000 } };
    },
    async sapiGetAccountApiRestrictions() {
      return { ipRestrict: true, enableReading: true, enableWithdrawals: false, enableSpotAndMarginTrading: o.trade ?? true, permitsUniversalTransfer: false };
    },
    sapiGetSimpleEarnFlexibleList: call("list", (p) => paged(b.products.filter((r) => !p.asset || r.asset === p.asset))),
    sapiGetSimpleEarnFlexiblePosition: call("position", (p) => paged(b.held.filter((r) => !p.productId || r.productId === p.productId))),
    sapiPostSimpleEarnFlexibleSubscribe: call("subscribe", () => ({ purchaseId: ++id, success: true })),
    sapiPostSimpleEarnFlexibleRedeem: call("redeem", () => ({ redeemId: ++id, success: true })),
    sapiGetSimpleEarnFlexibleHistoryRedemptionRecord: call("record", (p) => paged(b.records[String(p.redeemId)] ? [redemptionRow(b.records[String(p.redeemId)]!, { redeemId: Number(p.redeemId) })] : [])),
  } as unknown as ExchangeClient;
  return b;
}

async function boot(o: { cap?: number; trade?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "earn-binance-"));
  homes.push(home);
  let n = 0;
  let real = 5_000_000;
  const bn = standIn(o);
  const open: OpenExchange = async (id) => (id === "binance" ? bn.client : undefined);
  const liveDeps: Partial<LiveDeps> = { openExchange: open, clock: () => real, http: async () => ({ status: 599, body: undefined, text: "no network in tests" }), price: async (asset) => ({ ETH: 2000, BTC: 60_000 })[asset] };
  const svc = await PortfolioService.create({ home, now: () => new Date(START).toISOString(), venues: "frontline", real: true, liveDeps, liveWrites: { capUsd: o.cap ?? 100, pairingCode: "K7QX-M2PA" }, account: { owners: [{ id: owner.address, kind: "eoa", label: "owner", addedAt: new Date(START).toISOString() }] } });
  const engine = svc.account!;
  const own = async (a: NoNonce<OwnerAction>) => svc.exchange(await signOwner(owner, { ...a, nonce: START + ++n } as OwnerAction));
  const ag = async (a: NoNonce<AgentAction>) => svc.exchange(await signAgent(cc, { ...a, nonce: START + ++n } as AgentAction));
  const path = join(home, "credentials/binance/api-key.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(KEY));
  chmodSync(path, 0o600);
  const connected = await own({ type: "connectVenue", venue: "binance", connector: "live:exchange:binance", label: "", credentialRef: "" });
  if (isRefusal(connected)) throw new Error(connected.message);
  const prepared = (draft: Dict) => engine.prepare({ type: "liveEarn", venue: "binance", ...draft });
  /** what the page does: prepare, then sign exactly what came back */
  const earn = async (draft: Dict) => {
    const p = await prepared(draft);
    if (isRefusal(p)) return p;
    const { nonce: _n, ...rest } = p.action as Extract<OwnerAction, { type: "liveEarn" }>;
    return own(rest as NoNonce<OwnerAction>);
  };
  const letIn = async (limit: { perSupply?: string; budget?: string } = {}) => {
    await own({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: START + 30 * DAY });
    return own({ type: "approveSpend", agent: cc.address, scope: "earn", allow: "binance", perPayment: limit.perSupply ?? "50", budget: limit.budget ?? "100", windowHours: 0, validUntil: START + 7 * DAY });
  };
  const limit = () => engine.state.spends.find((s) => s.scope === "earn" && s.revokedAt === undefined)!;
  const sent = (what: string) => bn.calls.filter(([c]) => c === what).map(([, p]) => p);
  return { svc, engine, bn, own, ag, earn, prepared, letIn, limit, sent, tick: (ms: number) => (real += ms), page: async () => (await svc.accountView())! };
}

const result = (o: Outcome): LiveEarn => {
  const e = !isRefusal(o) && o.kind === "result" ? (o.result as { earn?: LiveEarn }).earn : undefined;
  if (!e) throw new Error(`expected an earn request, got ${isRefusal(o) ? `${o.code}: ${o.message}` : JSON.stringify(o).slice(0, 200)}`);
  return e;
};
const carded = (o: Outcome) => {
  if (isRefusal(o) || o.kind !== "card") throw new Error(`expected a card, got ${isRefusal(o) ? `${o.code}: ${o.message}` : o.kind}`);
  return o.card;
};
const ask = (o: Partial<Extract<AgentAction, { type: "agentLiveEarn" }>> = {}) => ({ type: "agentLiveEarn" as const, venue: "binance", kind: "supply", product: "USDT001", asset: "USDT", amount: "25", ...o });

describe("the earn door with Binance connected live", () => {
  it("Binance earns on the page; its Simple Earn position is a row of its own and the LDUSDT line its spot balance carries for it is left out, so the USDT is counted once", async () => {
    const x = await boot();
    const page = await x.page();
    const v = page.venues.find((y) => y.id === "binance")!;
    expect(v.earn).toEqual({ can: true, what: "Simple Earn Flexible: out at any time" });
    expect(v.holdings.map((h) => [h.asset, h.amount, h.usd, h.class, h.note])).toEqual([
      ["USDT", 500, 500, "stable", "spot"],
      ["USDT", 50, 50, "stable", "funding"],
      ["USDT", 40, 40, "earn", "earning 4.12% at Binance · USDT · Simple Earn Flexible"],
    ]);
    expect(v.usd).toBe(590);
    const { rows, money } = byAsset(page.venues, { writes: true });
    expect(rows.map((r) => [r.key, r.amount, r.usd])).toEqual([["stable:USDT", 550, 550], ["earn:binance:USDT001", 40, 40]]);
    expect(money.readyUsd).toBe(550);
    // the earn read: the products Binance lists and what is in them
    const r = await x.svc.earn({ venue: "binance" });
    if (isRefusal(r)) throw new Error(r.message);
    expect(r.products.map((p) => [p.id, p.apy, p.canSupply])).toEqual([["USDT001", 0.0412, true], ["BTC001", 0.0035, true]]);
    expect(r.positions.map((p) => [p.product, p.amount, p.accrued])).toEqual([["USDT001", 40, 0.42]]);
  });

  it("the owner's request: prepared with the APR and where money taken out lands, signed as shown, subscribed once from the spot account with Auto-Subscribe off, a statement line", async () => {
    const x = await boot();
    const p = await x.prepared({ kind: "supply", product: "USDT001", asset: "USDT", amount: "25" });
    if (isRefusal(p)) throw new Error(p.message);
    expect(p.action).toMatchObject({ type: "liveEarn", venue: "binance", kind: "supply", product: "USDT001", asset: "USDT", amount: "25", maxUsd: "25.00", lands: "your Binance spot account" });
    expect(p.quote?.earn).toMatchObject({ words: "put 25 USDT into USDT · Simple Earn Flexible at Binance (4.12% APR) · about $25.00", rateKind: "apr", lockDays: 0, minAmount: 0.1, protocol: "Binance Simple Earn", lands: "your Binance spot account", capUsd: 100 });
    const e = result(await x.earn({ kind: "supply", product: "USDT001", asset: "USDT", amount: "25" }));
    expect([e.status, e.ref, e.authority, e.lands]).toEqual(["done", "subscribe:USDT001:70001", "owner", "your Binance spot account"]);
    expect(x.sent("subscribe")).toEqual([{ productId: "USDT001", amount: "25", autoSubscribe: false, sourceAccount: "SPOT" }]);
    expect(x.svc.statement().find((l) => l.id === e.id)!.description).toBe("Supply 25 USDT · USDT · Simple Earn Flexible · 4.12% APR");
  });

  it("the server's cap and Binance's own minimum stop it before Binance is asked; a key that may not trade is refused in Binance's terms", async () => {
    const x = await boot({ cap: 100 });
    const big = refused(await x.prepared({ kind: "supply", product: "USDT001", asset: "USDT", amount: "150" }));
    expect([big.code, big.message]).toEqual(["E_ACCOUNT_LIMIT", "$150.00 is more than the most one movement may be on this server ($100.00). It is set when the server starts: --live-cap"]);
    expect(refused(await x.prepared({ kind: "supply", product: "USDT001", asset: "USDT", amount: "0.05" }))).toMatchObject({ code: "E_VENUE_ORDER_INVALID", message: "Binance: the least that goes into USDT · Simple Earn Flexible is 0.1 USDT" });
    expect(x.sent("subscribe")).toEqual([]);
    const ro = await boot({ trade: false });
    const no = refused(await ro.prepared({ kind: "supply", product: "USDT001", asset: "USDT", amount: "5" }));
    expect([no.code, no.message]).toEqual(["E_VENUE_PERMISSION", 'Binance: this Binance key may not trade: Simple Earn\'s subscription and redemption need its "Enable Spot & Margin Trading" permission (set on the key at Binance)']);
  });

  it("Guard: an agent's request is a card showing the product, its APR, the amount and where money lands; the owner's yes subscribes exactly it, once, and counts it", async () => {
    const x = await boot();
    await x.letIn();
    const card = carded(await x.ag(ask()));
    expect([card.usd, card.offer?.payee, card.offer?.payTo, card.offer?.protocol, card.offer?.network]).toEqual([25, "Binance", "USDT · Simple Earn Flexible", "earn · 4.12% APR", "worth about $25.00 · money taken out lands in your Binance spot account"]);
    expect([x.sent("subscribe"), x.limit().reservedMicro]).toEqual([[], 25_000_000]);
    const e = result(await x.own({ type: "approveCard", card: card.id, action: cardHash(card), decision: "approve" }));
    expect([e.authority, e.card, e.status, x.limit().spentMicro, x.limit().reservedMicro]).toEqual(["agent", card.id, "done", 25_000_000, 0]);
    expect(x.sent("subscribe")).toEqual([{ productId: "USDT001", amount: "25", autoSubscribe: false, sourceAccount: "SPOT" }]);
  });

  it("Beast: a supply inside the earn limit goes at once and nothing past it; Binance's no gives the limit back; a withdrawal inside the line goes at once and is followed until Binance's record says PAID", async () => {
    const x = await boot();
    await x.letIn({ perSupply: "30", budget: "100" });
    await x.own({ type: "setPolicy", change: "mode", value: "open" });
    const e = result(await x.ag(ask()));
    expect([e.authority, e.card, e.status, x.limit().spentMicro]).toEqual(["agent", undefined, "done", 25_000_000]);
    expect(refused(await x.ag(ask({ amount: "31" }))).code).toBe("E_MANDATE_PER_ORDER_CAP");
    // Binance says no, in its words: nothing moved, and the limit is as it was
    x.bn.fail.subscribe = thrown("InsufficientFunds", 'binance {"code":-6012,"msg":"Balance not enough"}');
    const short = refused(await x.ag(ask({ amount: "20" })));
    expect([short.code, short.message, x.limit().spentMicro]).toEqual(["E_VENUE_INSUFFICIENT", "Binance refused to put 20 USDT into USDT · Simple Earn Flexible: Balance not enough (-6012). Only what is in your Binance spot account goes in", 25_000_000]);
    // out: inside the per-supply line, at once; under way until the redemption record says PAID
    const w = result(await x.ag(ask({ kind: "withdraw", amount: "20" })));
    expect([w.kind, w.status, w.ref, x.limit().spentMicro]).toEqual(["withdraw", "pending", "redeem:USDT001:70002", 25_000_000]);
    expect(x.sent("redeem")).toEqual([{ productId: "USDT001", redeemAll: false, amount: "20", destAccount: "SPOT" }]);
    x.bn.records["70002"] = "PAID";
    x.tick(20_000);
    await x.engine.settle();
    expect((await x.page()).earns.find((y) => y.id === w.id)).toMatchObject({ status: "done", note: "out of USDT · Simple Earn Flexible: back in your Binance spot account" });
    // all of it, past the line: the owner's card even in Beast
    expect(carded(await x.ag(ask({ kind: "withdraw", amount: "all" }))).usd).toBe(40);
  });

  it("the owner takes all of it out by Binance's redeemAll; Binance's -2015 is said with the permission these calls need, and never with the key", async () => {
    const x = await boot();
    const all = result(await x.earn({ kind: "withdraw", product: "USDT001", asset: "USDT", amount: "all" }));
    expect([all.all, all.amount, all.usd]).toEqual([true, 40, 40]);
    expect(x.sent("redeem")).toEqual([{ productId: "USDT001", redeemAll: true, destAccount: "SPOT" }]);
    x.bn.fail.subscribe = thrown("AuthenticationError", 'binance {"code":-2015,"msg":"Invalid API-key, IP, or permissions for action."}');
    const perm = refused(await x.earn({ kind: "supply", product: "USDT001", asset: "USDT", amount: "5" }));
    expect(perm.code).toBe("E_VENUE_PERMISSION");
    expect(perm.message).toContain('"Enable Spot & Margin Trading"');
  });
});

// a type check that the earner is the shape the door takes
const _shape: (e: LiveEarner) => void = () => undefined;
_shape(binanceEarner({ client: { id: "binance", fetchBalance: async () => ({}) }, venue: "binance", name: "Binance", key: KEY, can: [] }));
