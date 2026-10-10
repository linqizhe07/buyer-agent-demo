import ccxt from "ccxt";
import { STATUS_CODES } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isRefusal, type Refusal } from "../../src/core/errors.ts";
import { exchangeClock, exchangeSaidNo, exchangeSource, guardClient, type ExchangeClient, type OpenExchange } from "../../src/portfolio/live/exchange.ts";
import { holdBackMs } from "../../src/portfolio/live/public-markets.ts";
import { IP_LIST, realHttp, REGION, retryAfterMs, venueSaidNo } from "../../src/portfolio/live/types.ts";
import { exchangeWriter, mmWriter, walletWriter, type LiveReceipt } from "../../src/portfolio/live/writes.ts";
import { no, unaddressed } from "../../src/portfolio/refuse.ts";

/** The shared layer the IP audit's findings met first (2026-10-09): how a venue's answer to THIS network is read — a place rule (and one
 * about a single pair), an edge's page or plain-text refusal, a key bound to other addresses, a ban or a rate limit held as long as the venue
 * asked, a redirect, a page answered in the venue's place, a connection cut or intercepted — and what a move whose answer was lost becomes.
 * The library's own classes decide each error, fed canned answers; nothing leaves the process. Addresses are from the documentation ranges
 * (RFC 5737, RFC 3849) */
const lib = ccxt as unknown as Record<string, new (o: Record<string, unknown>) => Record<string, unknown>> & { RequestTimeout: new (m: string) => Error; BadResponse: new (m: string) => Error };
type Canned = { status: number; body?: string; headers?: Record<string, string> };

/** a real library client whose network answers what it is told, through the account's guard */
function client(id: string, canned: Canned | ((url: string) => Canned), extra: Record<string, unknown> = {}): ExchangeClient & Record<string, unknown> {
  const x = new lib[id]!({ apiKey: "made-up-key-000", secret: "bWFkZS11cC1zZWNyZXQ=", password: "made-up-pass", enableRateLimit: false, timeout: 12_000, ...extra }) as Record<string, unknown> & { handleRestResponse: (...a: unknown[]) => Promise<unknown> };
  x.fetch = async function (url: string, method = "GET", headers: unknown = {}, body: unknown = undefined) {
    const c = typeof canned === "function" ? canned(url) : canned;
    const resp = { status: c.status, statusText: STATUS_CODES[c.status] ?? "", headers: c.headers ?? {}, text: async () => c.body ?? "" };
    return x.handleRestResponse(resp, url, method, headers, body);
  };
  return guardClient(x as unknown as ExchangeClient, lib) as ExchangeClient & Record<string, unknown>;
}
const thrownBy = async (p: Promise<unknown>): Promise<unknown> => p.then(() => undefined, (e) => e);
const thrown = (name: string, message: string, more: Record<string, unknown> = {}) => Object.assign(new Error(message), { name, ...more });
const PAGE = `<!DOCTYPE html><html><head><title>Web Page Blocked</title></head><body>Access to this site is blocked by your network administrator. Your IP: 203.0.113.9</body></html>`;

afterEach(() => vi.unstubAllGlobals());

describe("Cloudflare's plain-text refusal, and any 403 whose body has no brace", () => {
  it("is the edge refusing this network, through a plain HTTP read and through the exchange library alike", async () => {
    const r = venueSaidNo("pm-us", "Polymarket US", 403, "error code: 1009");
    expect([r.code, (r.native as { edge?: boolean }).edge]).toEqual(["E_VENUE_GEOBLOCKED", true]);
    for (const body of ["error code: 1020", "error code: 1006"]) expect(venueSaidNo("v", "V", 403, body).code).toBe("E_VENUE_GEOBLOCKED");
    // its rate limit comes as a 429 and stays one; a request-shape code is not a refusal of the network
    expect(venueSaidNo("v", "V", 429, "error code: 1015").code).toBe("E_VENUE_UNREACHABLE");
    expect(venueSaidNo("v", "V", 403, "error code: 1003").code).toBe("E_VENUE_PERMISSION");
    const okx = exchangeSaidNo("okx", "OKX", thrown("ExchangeNotAvailable", "okx GET https://www.okx.com/api/v5/public/time 403 Forbidden error code: 1009"), {});
    expect([okx.code, (okx.native as { edge?: boolean }).edge]).toEqual(["E_VENUE_GEOBLOCKED", true]);
    expect(holdBackMs(okx)).toBe(600_000);
  });
});

describe("a venue's own words for a key bound to other addresses, and for a place, that were missed", () => {
  it("Phemex, Coinbase International and Upbit say the key's IP list in their own words; Binance's -2015 and a bad key are not that", () => {
    for (const t of ['phemex {"code":"401","msg":"401 Request IP mismatch.","data":null}', 'coinbaseinternational {"title":"ip not allowed","status":401}', 'upbit {"error":{"name":"no_authorization_i_p","message":"This is not a verified IP."}}']) {
      expect(IP_LIST.test(t), t).toBe(true);
      const r = exchangeSaidNo("x", "X", thrown("AuthenticationError", t), {});
      expect([r.code, r.detail], t).toEqual(["E_VENUE_PERMISSION", { ipList: true }]);
    }
    for (const t of ['binance {"code":-2015,"msg":"Invalid API-key, IP, or permissions for action."}', 'phemex {"code":"401","msg":"401 Failed to load API KEY."}', 'upbit {"error":{"name":"invalid_access_key"}}']) expect(IP_LIST.test(t), t).toBe(false);
  });

  it("a whole venue's place rule in the words REGION missed; one pair's or one product's is said as that, and holds nothing else back", () => {
    for (const t of ["This is a blacklist country.", "Trading is suspended due to country restrictions", "Due to country and region restrictions, this is unavailable"]) expect(REGION.test(t), t).toBe(true);
    expect(exchangeSaidNo("deribit", "Deribit", thrown("AuthenticationError", 'deribit {"error":{"message":"country_is_banned","code":12005}}'), {}).code).toBe("E_VENUE_GEOBLOCKED");
    for (const [kind, t] of [["RestrictedLocation", 'okx {"code":"51155","msg":"You can\'t trade this pair or borrow this crypto due to local compliance restrictions."}'], ["BadRequest", 'kucoin {"code":"126046","msg":"This digital asset does not support your IP region."}'], ["ExchangeError", 'okx {"code":"51773","msg":"Feature not available in your region"}']] as const) {
      const r = exchangeSaidNo("v", "V", thrown(kind, t), {});
      expect([r.code, r.detail, r.message], t).toEqual(["E_VENUE_GEOBLOCKED", { scope: "product" }, "V does not offer this pair or product to this location: that is its own rule, for this alone, and the account does not look for a way around it"]);
      expect(holdBackMs(r)).toBe(0);
    }
    const lev = exchangeSaidNo("binance", "Binance", thrown("BadRequest", 'binance {"code":-4201,"msg":"Users in your location/country can only access a maximum leverage of 20"}'), {});
    expect([lev.code, lev.detail]).toEqual(["E_VENUE_GEOBLOCKED", { scope: "leverage" }]);
  });
});

describe("bans and rate limits, held as long as the venue asked", () => {
  it("a Retry-After is read as seconds or a date, an hour at most; a 429 without one is held the minute its sentence says", () => {
    expect(retryAfterMs("45")).toBe(45_000);
    expect(retryAfterMs(new Date(1_000_090_000).toUTCString(), 1_000_000_000)).toBe(90_000);
    expect(retryAfterMs("999999")).toBe(3_600_000);
    expect([retryAfterMs(""), retryAfterMs("soon"), retryAfterMs("-3")]).toEqual([undefined, undefined, undefined]);
    const asked = venueSaidNo("v", "V", 429, "slow down", [], { retryAfterMs: 45_000 });
    expect([asked.message, holdBackMs(asked) > 44_000 && holdBackMs(asked) <= 45_000]).toEqual(["V is rate-limiting this machine: try again in 45 s", true]);
    expect(holdBackMs(venueSaidNo("v", "V", 429, "slow down"))).toBeGreaterThan(59_000);
  });

  it("the exchange library's 429 carries the exchange's Retry-After through the guard", async () => {
    const x = client("binance", { status: 429, body: '{"code":-1003,"msg":"Too many requests; current limit of IP(203.0.113.9) is 6000 requests per minute."}', headers: { "retry-after": "45" } });
    const err = await thrownBy((x.fetchTime as () => Promise<unknown>)());
    const r = exchangeSaidNo("binance", "Binance", err, {});
    expect([r.code, r.message]).toEqual(["E_VENUE_UNREACHABLE", "Binance is rate-limiting this machine: try again in 45 s"]);
    expect(holdBackMs(r)).toBeGreaterThan(44_000);
    expect(JSON.stringify(r)).not.toContain("203.0.113.9");
  });

  it("Bybit's IP ban (10009, and its 403 'access too frequent') is a ban of ten minutes; KuCoin's 429000 is a rate limit, and asked without a key it is not 'answered here'", async () => {
    const ban = exchangeSaidNo("bybit", "Bybit", thrown("AuthenticationError", 'bybit {"retCode":10009,"retMsg":"IP has been banned","result":{}}'), {});
    expect([ban.code, holdBackMs(ban) > 590_000]).toEqual(["E_VENUE_UNREACHABLE", true]);
    const freq = exchangeSaidNo("bybit", "Bybit", thrown("RateLimitExceeded", "bybit GET https://api.bybit.com/v5/market/time 403 Forbidden access too frequent"), {});
    expect([freq.code, holdBackMs(freq) > 590_000]).toEqual(["E_VENUE_UNREACHABLE", true]);
    const busy = exchangeSaidNo("kucoin", "KuCoin", thrown("ExchangeError", 'kucoin {"code":"429000","msg":"Too Many Requests"}'), {});
    expect([busy.code, holdBackMs(busy)]).toEqual(["E_VENUE_UNREACHABLE", 60_000]);
    const open: OpenExchange = async () => ({ id: "kucoin", name: "KuCoin", has: {}, fetchTime: async () => { throw thrown("ExchangeError", 'kucoin {"code":"429000","msg":"Too Many Requests"}'); } }) as unknown as ExchangeClient;
    expect((await exchangeClock("kucoin", "kucoin", open))?.code).toBe("E_VENUE_UNREACHABLE");
  });
});

describe("an answer that is not the exchange's, or no answer at all", () => {
  it("a 200 page where the API answers JSON is no answer — not the exchange's yes, not 'nothing held'", async () => {
    const x = client("okx", { status: 200, body: PAGE });
    const err = await thrownBy((x.fetchTime as () => Promise<unknown>)());
    const r = exchangeSaidNo("okx", "OKX", err, {});
    expect([r.code, r.message]).toEqual(["E_VENUE_UNREACHABLE", "OKX did not answer: something on this network answered in its place with a page that is not OKX's API. Nothing it said is taken as OKX's answer"]);
    expect(JSON.stringify(r)).not.toContain("203.0.113.9");
    // a plain HTTP read the same
    expect(venueSaidNo("v", "V", 200, PAGE).code).toBe("E_VENUE_UNREACHABLE");
  });

  it("Crypto.com's own handler drops the status: the guard reads it first, so its edge's page is the edge refusing, and a 502 is an outage", async () => {
    const edge = client("cryptocom", { status: 403, body: "<html><head><title>Attention Required! | Cloudflare</title></head><body>Sorry, you have been blocked</body></html>" });
    const page = await thrownBy((edge.v1PublicGetPublicGetInstruments as () => Promise<unknown>).call(edge));
    expect(exchangeSaidNo("cryptocom", "Crypto.com", page, {}).code).toBe("E_VENUE_GEOBLOCKED");
    const x = client("cryptocom", { status: 502, body: "<html><body>502 Bad Gateway</body></html>" });
    const down = await thrownBy((x.v1PublicGetPublicGetInstruments as () => Promise<unknown>).call(x));
    expect(exchangeSaidNo("cryptocom", "Crypto.com", down, {}).code).toBe("E_VENUE_UNREACHABLE");
  });

  it("Gemini's 500 and its 'System' reason are an outage, not 'refused the request'", () => {
    expect(exchangeSaidNo("gemini", "Gemini", thrown("ExchangeError", "gemini GET https://api.gemini.com/v1/symbols 500 Internal Server Error "), {}).code).toBe("E_VENUE_UNREACHABLE");
    expect(exchangeSaidNo("gemini", "Gemini", thrown("ExchangeError", 'gemini {"result":"error","reason":"System","message":"We are experiencing technical issues"}'), {}).code).toBe("E_VENUE_UNREACHABLE");
  });

  it("a connection reset, no route, or a certificate that is not the exchange's is no answer — and only the code is kept", async () => {
    const tls = thrown("Error", "Hostname/IP does not match certificate's altnames: Host: api.example. is not in the cert's altnames: DNS:blockpage.isp.example", { code: "ERR_TLS_CERT_ALTNAME_INVALID" });
    const r = exchangeSaidNo("okx", "OKX", tls, {});
    expect([r.code, r.native]).toEqual(["E_VENUE_UNREACHABLE", { error: "Error", code: "ERR_TLS_CERT_ALTNAME_INVALID" }]);
    expect(JSON.stringify(r)).not.toContain("blockpage");
    expect(exchangeSaidNo("okx", "OKX", thrown("Error", "connect EHOSTUNREACH", { code: "EHOSTUNREACH" }), {}).code).toBe("E_VENUE_UNREACHABLE");
    expect(exchangeSaidNo("okx", "OKX", thrown("SocketError", "other side closed"), {}).code).toBe("E_VENUE_UNREACHABLE");
    const open: OpenExchange = async () => ({ id: "okx", name: "OKX", has: {}, fetchTime: async () => { throw tls; } }) as unknown as ExchangeClient;
    expect((await exchangeClock("okx", "okx", open))?.code).toBe("E_VENUE_UNREACHABLE");
  });

  it("a request whose answer never finishes is cut at the deadline, the body included", async () => {
    const x = new lib.binance!({ enableRateLimit: false, timeout: 30 }) as unknown as ExchangeClient & Record<string, unknown>;
    x.fetch = () => new Promise(() => undefined);
    guardClient(x, lib);
    const err = await thrownBy((x.fetchTime as () => Promise<unknown>)());
    expect((err as Error).name).toBe("RequestTimeout");
    expect(exchangeSaidNo("binance", "Binance", err, {}).code).toBe("E_VENUE_UNREACHABLE");
  });

  it("an exchange whose market list is built into the library is asked a real question, or none is claimed", async () => {
    const asked: string[] = [];
    const built = (ticker: boolean) => ({ id: "coincheck", name: "coincheck", has: { fetchTime: false, fetchTicker: ticker }, lastRestRequestTimestamp: 0, markets: { "BTC/JPY": {} }, loadMarkets: async () => ({}), fetchTicker: async (s: string) => { asked.push(s); throw thrown("ExchangeNotAvailable", "coincheck GET https://coincheck.com/api/ticker 403 Forbidden error code: 1009"); } }) as unknown as ExchangeClient;
    expect((await exchangeClock("coincheck", "coincheck", async () => built(true)))?.code).toBe("E_VENUE_GEOBLOCKED");
    expect(asked).toEqual(["BTC/JPY"]);
    expect((await exchangeClock("coincheck", "coincheck", async () => built(false)))?.code).toBe("E_VENUE_UNREACHABLE");
  });

  it("a redirect is the venue answering, never followed, and where it pointed is not kept", async () => {
    vi.stubGlobal("fetch", async () => new Response(null, { status: 302, headers: { location: "https://kalshi.example/restricted?ip=203.0.113.9&cc=XX" } }));
    const r = await realHttp("https://api.kalshi.example/trade-api/v2/exchange/status");
    expect(r).toMatchObject({ status: 302, location: "kalshi.example", text: "" });
    const no3 = venueSaidNo("kalshi", "Kalshi", r.status, r.text, [], r);
    expect([no3.code, no3.message]).toEqual(["E_VENUE_REJECTED", "Kalshi answered HTTP 302, sending the request on elsewhere: not followed"]);
    expect(JSON.stringify(no3)).not.toMatch(/203\.0\.113\.9|cc=|kalshi\.example/);
  });
});

describe("connecting and reading an exchange from such a network", () => {
  const base = (over: Record<string, unknown>) => ({ id: "binance", name: "Binance", requiredCredentials: { apiKey: true, secret: true }, has: {}, markets: {}, loadMarkets: async () => ({}), fetchTime: async () => 1, sapiGetAccountApiRestrictions: async () => ({ enableReading: true }), fetchTickers: async () => ({}), ...over }) as unknown as ExchangeClient;
  const KEY = { apiKey: "made-up-key-000", secret: "made-up-secret-000" };

  it("a funding ledger that meets a ban, an edge or a timeout fails the read; one the key may not see is not shown", async () => {
    const ledger = (funding: () => Promise<unknown>) => base({ fetchBalance: async (p: Record<string, unknown> = {}) => (p.type === "funding" ? funding() : { total: { USDT: 100 } }) });
    for (const err of [thrown("RequestTimeout", "binance GET https://api.binance.com/sapi/v1/asset/get-funding-asset request timed out (12000 ms)"), thrown("DDoSProtection", 'binance {"code":-1003,"msg":"Way too many requests; IP banned until 1791999999999."}'), thrown("ExchangeNotAvailable", `binance POST https://api.binance.com/sapi/v1/asset/get-funding-asset 403 Forbidden ${PAGE}`)]) {
      const c = ledger(async () => { throw err; });
      const r = await exchangeSource({ venue: "binance", exchangeId: "binance", label: "Binance", reference: "~/k", key: KEY, open: async () => c });
      expect(isRefusal(r), err.message).toBe(true);
    }
    const hidden = await exchangeSource({ venue: "binance", exchangeId: "binance", label: "Binance", reference: "~/k", key: KEY, open: async () => ledger(async () => { throw thrown("PermissionDenied", 'binance {"code":-1002,"msg":"You are not authorized to execute this request."}'); }) });
    expect(isRefusal(hidden) ? hidden.code : hidden.first).toEqual([{ asset: "USDT", amount: 100, where: "spot" }]);
  });

  it("a balance the library made from a page is no balance: the read fails and the last numbers stand", async () => {
    const r = await exchangeSource({ venue: "binance", exchangeId: "binance", label: "Binance", reference: "~/k", key: KEY, open: async () => base({ fetchBalance: async () => ({ info: "", total: {} }) }) });
    expect(isRefusal(r) && r.code).toBe("E_VENUE_UNREACHABLE");
  });

  it("Bybit's key-permission call answered by anything but a real result leaves the key's permissions unknown, never 'read-only'", async () => {
    const c = base({ id: "bybit", name: "Bybit", sapiGetAccountApiRestrictions: undefined, privateGetV5UserQueryApi: async () => "<html>challenge</html>", fetchBalance: async () => ({ total: {} }) });
    const r = await exchangeSource({ venue: "bybit", exchangeId: "bybit", label: "Bybit", reference: "~/k", key: KEY, open: async () => c });
    expect(isRefusal(r) ? r.code : r.source.probe.can).toEqual([]);
  });
});

describe("a move at an exchange: its no read as the connection reads it, and an answer lost on the way back never told as refused", () => {
  const stub = (err: unknown, more: Record<string, unknown> = {}) => ({ id: "okx", has: { withdraw: true }, loadMarkets: async () => ({}), currencies: { USDC: { networks: { ERC20: { withdraw: true, fee: 1 } } } }, withdraw: async () => { throw err; }, transfer: async () => { throw err; }, fetchBalance: async () => ({}), ...more }) as unknown as ExchangeClient;
  const KEY = ["made-up-key-000", "made-up-secret-000", "made-up-pass"];
  const withdraw = (err: unknown, id = "okx") => exchangeWriter({ ...stub(err), id }, id, id.toUpperCase(), KEY, { can: ["read", "withdraw"] }, ["trading", "funding"]).withdraw!({ asset: "USDC", amount: 100, address: "0x000000000000000000000000000000000000dEaD", network: "Ethereum", clientId: "pay-0001-abc" });

  it("a key bound to other addresses is that — not the withdrawal address; a place rule is the venue's; a ban is held", async () => {
    const ip = (await withdraw(thrown("PermissionDenied", 'okx {"msg":"Your IP 203.0.113.7 is not included in your API key\'s IP whitelist.","code":"50110"}'))) as Refusal;
    expect([ip.code, ip.detail]).toEqual(["E_VENUE_PERMISSION", { ipList: true }]);
    expect(JSON.stringify(ip)).not.toContain("203.0.113.7");
    const gate = (await withdraw(thrown("AuthenticationError", 'gate {"label":"IP_FORBIDDEN","message":"Request IP not in whitelist: 203.0.113.7"}'), "gate")) as Refusal;
    expect([gate.code, gate.detail]).toEqual(["E_VENUE_PERMISSION", { ipList: true }]);
    expect(((await withdraw(thrown("ExchangeNotAvailable", 'binance POST https://api.binance.com/sapi/v1/capital/withdraw/apply 451 {"code":0,"msg":"Service unavailable from a restricted location"}'), "binance")) as Refusal).code).toBe("E_VENUE_GEOBLOCKED");
    const ban = (await withdraw(thrown("DDoSProtection", 'binance {"code":-1003,"msg":"Way too many requests; IP banned until 1791999999999."}'), "binance")) as Refusal;
    expect([ban.code, (ban.native as { until?: number }).until]).toEqual(["E_VENUE_UNREACHABLE", 1791999999999]);
    // the exchange's own refusal of the destination still is that
    expect(((await withdraw(thrown("ExchangeError", 'okx {"code":"58207","msg":"Withdrawal address isn\'t on the verified address list."}'))) as Refusal).code).toBe("E_VENUE_WITHDRAW_WHITELIST");
  });

  it("a withdrawal that timed out or met a gateway's 5xx is a payment on its way, known by the account's id, and found by it afterwards", async () => {
    for (const err of [thrown("RequestTimeout", "okx POST https://www.okx.com/api/v5/asset/withdrawal request timed out (12000 ms)"), thrown("ExchangeNotAvailable", "okx POST https://www.okx.com/api/v5/asset/withdrawal 504 Gateway Time-out "), thrown("NetworkError", "okx POST https://www.okx.com/api/v5/asset/withdrawal fetch failed: other side closed")]) {
      const r = (await withdraw(err)) as LiveReceipt;
      expect([r.ref, r.status, (r.native as { unsure?: boolean }).unsure], err.message).toEqual(["client:pay0001abc", "pending", true]);
    }
    const listed = [{ id: "w-9", status: "ok", info: { clientId: "pay0001abc" } }, { id: "w-8", status: "failed", info: { clientId: "other" } }];
    const w = exchangeWriter(stub(undefined, { fetchWithdrawals: async () => listed }), "okx", "OKX", KEY, { can: ["read", "withdraw"] }, []);
    expect(await w.landed!("client:pay0001abc", "USDC", Date.now() - 1_000)).toBe("settled");
    expect(await w.landed!("client:nobody", "USDC", Date.now() - 1_000)).toBe("pending");
    // where the exchange keeps no id of the account's: found by where it went, how much, and when
    const rows = [{ id: "w-1", status: "ok", address: "0x000000000000000000000000000000000000dead", amount: 99, timestamp: Date.now() }];
    const byWhere = exchangeWriter(stub(undefined, { id: "kraken", fetchWithdrawals: async () => rows }), "kraken", "Kraken", KEY, { can: [] }, []);
    expect(await byWhere.landed!("client:pay0001abc", "USDC", Date.now() - 1_000, { address: "0x000000000000000000000000000000000000dEaD", amount: 99 })).toBe("settled");
    // never a withdrawal another payment already is, nor one of two alike: one landing never settles two payments
    expect(await byWhere.landed!("client:pay0001abc", "USDC", Date.now() - 1_000, { address: "0x000000000000000000000000000000000000dEaD", amount: 99, taken: ["w-1"] })).toBe("pending");
    rows.push({ ...rows[0]!, id: "w-2" });
    expect(await byWhere.landed!("client:pay0001abc", "USDC", Date.now() - 1_000, { address: "0x000000000000000000000000000000000000dEaD", amount: 99 })).toBe("pending");
    // where the exchange keeps the account's id, only that id finds it
    const keyed = exchangeWriter(stub(undefined, { id: "binance", fetchWithdrawals: async () => [rows[0]] }), "binance", "Binance", KEY, { can: [] }, []);
    expect(await keyed.landed!("client:pay0001abc", "USDC", Date.now() - 1_000, { address: "0x000000000000000000000000000000000000dEaD", amount: 99 })).toBe("pending");
  });

  it("a transfer or swap that timed out says it may have been taken — never 'refused'", async () => {
    const w = exchangeWriter(stub(thrown("RequestTimeout", "okx POST https://www.okx.com/api/v5/asset/transfer request timed out (12000 ms)")), "okx", "OKX", KEY, { can: ["read", "trade"] }, ["trading", "funding"]);
    const r = (await w.transfer!({ asset: "USDC", amount: 10, from: "funding", to: "trading" })) as Refusal;
    expect([r.code, r.detail, r.message]).toEqual(["E_VENUE_UNREACHABLE", { unsure: true }, "OKX did not answer whether it took this (move USDC from funding to trading): it may have. Look at OKX before asking again"]);
  });
});

describe("a wallet's payment, and mm's transfer", () => {
  it("a mined payment is not failed because the chain did not answer the token's decimals just then", async () => {
    const chain = { receipt: async () => ({ status: "success", logs: [] }), decimals: async () => undefined } as never;
    const w = walletWriter("0x1111111111111111111111111111111111111111", chain);
    expect(await w.confirm!(`0x${"ab".repeat(32)}`, { asset: "USDC", amount: 25, to: "0x2222222222222222222222222222222222222222", network: "Arbitrum" })).toBe("pending");
  });

  it("a transfer mm stopped waiting for is followed by its wallet job, never told as 'not sent'", async () => {
    const env = { PORTFOLIO_MM_WRITES: "1" };
    let timeoutMs: number | undefined;
    const run = async <T>(_args: string[], opts?: { timeoutMs?: number }): Promise<T> => {
      timeoutMs = opts?.timeoutMs;
      throw thrown("MmError", "mm stopped waiting (JOB_TIMEOUT): the job may still complete");
    };
    const voice = { mayLand: () => ({ job: "job-7", code: "JOB_TIMEOUT", said: "the job may still complete", mfa: false }), refusal: () => no("E_VENUE_REJECTED", { message: "mm refused" }), landed: async (job: string) => (job === "job-7" ? ("settled" as const) : ("pending" as const)) };
    const w = mmWriter("0x1111111111111111111111111111111111111111", run, env, voice);
    const r = (await w.send!({ asset: "USDC", amount: 10, to: "0x2222222222222222222222222222222222222222", network: "Base" })) as LiveReceipt;
    expect([r.ref, r.status, timeoutMs]).toEqual(["job:job-7", "pending", 660_000]);
    expect(await w.landed!("job:job-7", "USDC", 0)).toBe("settled");
    const refused = await mmWriter("0x1111111111111111111111111111111111111111", run, env, { ...voice, mayLand: () => undefined }).send!({ asset: "USDC", amount: 10, to: "0x2222222222222222222222222222222222222222", network: "Base" });
    expect(isRefusal(refused) && refused.message).toBe("mm refused");
  });
});

describe("this machine's address, wherever a venue's words put it", () => {
  it("after a colon, glued to a word, cut short, or in a refusal's detail: taken out; what is not an address stays", () => {
    expect(unaddressed("Your IP:2001:db8:85a3::8a2e:370:7334 is not allowed")).toBe("Your IP:(this machine's address) is not allowed");
    expect(unaddressed("whitelist:2001:db8::1234:5678")).toBe("whitelist:(this machine's address)");
    expect(unaddressed("ip_203.0.113.7 and IP198.51.100.23.")).toBe("ip_(this machine's address) and IP(this machine's address).");
    for (const t of ["at 12:30:45 UTC", "v10.20.30", "aa:bb:cc:dd:ee:ff", "Error::Something", "abc::def", "1.2.3.4.5", "2026-10-09T18:00:00.000Z", "fe80::1:2:3", "connect ECONNREFUSED 127.0.0.1:4820"]) expect(unaddressed(t), t).toBe(t);
    const r = no("E_PAYEE_REJECTED", { message: "the payee refused", detail: { error: "refused for 203.0.113.7" } });
    expect(JSON.stringify(r.detail)).not.toContain("203.0.113.7");
    // a venue's words cut to length after the address is taken out: no half of it survives the cut
    const long = `${"x".repeat(214)} 203.0.113.77 more`;
    expect(venueSaidNo("v", "V", 400, long).native).toMatchObject({ said: expect.not.stringMatching(/203\.0\.1/) });
  });
});

describe("a public source's own hold, let go when a forced re-check finds the venue answering", () => {
  it("a place rule from the network the user left is not kept for ten minutes after the venue answers this one", async () => {
    const { kalshiPublic } = await import("../../src/portfolio/live/public-markets.ts");
    let blocked = true;
    let sent = 0;
    const http = async (): Promise<import("../../src/portfolio/live/types.ts").HttpReply> => {
      sent++;
      return blocked ? { status: 451, body: undefined, text: "unavailable" } : { status: 200, body: { events: [], cursor: "" }, text: "{}" };
    };
    const k = kalshiPublic({ http, clock: () => 1_000_000 });
    expect(await k.listings({ limit: 5 })).toMatchObject({ code: "E_VENUE_GEOBLOCKED" });
    const first = sent;
    blocked = false;
    await k.listings({ limit: 5 });
    expect(sent).toBe(first);
    k.reset?.();
    expect(isRefusal(await k.listings({ limit: 5 }))).toBe(false);
    expect(sent).toBeGreaterThan(first);
  });
});
