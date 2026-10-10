import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isRefusal } from "../../src/core/errors.ts";
import { signAgent, signOwner, simKey, type AgentAction, type OwnerAction } from "../../src/portfolio/account/sign.ts";
import { exchangeClock, exchangeSaidNo, type ExchangeClient, type OpenExchange } from "../../src/portfolio/live/exchange.ts";
import type { RunMm } from "../../src/portfolio/live/metamask.ts";
import { holdBackMs } from "../../src/portfolio/live/public-markets.ts";
import { reachOf, type ReachDeps } from "../../src/portfolio/live/reach.ts";
import { REGION, venueSaidNo, type Http, type HttpReply } from "../../src/portfolio/live/types.ts";
import { no, unaddressed } from "../../src/portfolio/refuse.ts";
import { PortfolioService } from "../../src/portfolio/service.ts";

/** Every block an IP address makes, told apart (live/types.ts, exchange.ts, reach.ts, public-markets.ts, refuse.ts): the venue's rule about
 * the place (its words, held to it), a key bound to other addresses (the owner adds this one), a page from the server in front of the venue
 * refusing this network with no reason, a ban for too many requests (until when the venue says), and an exchange whose library has no clock
 * (asked its own public question, not taken for a yes). The address itself is never said or kept. Addresses below are from the ranges kept
 * for documentation (RFC 5737, RFC 3849); the venues' sentences are their own (ccxt's error tables, 2026-10-08) */
const thrown = (name: string, message: string) => Object.assign(new Error(message), { name });
const reply = (status: number, body: unknown): HttpReply => ({ status, body, text: typeof body === "string" ? body : JSON.stringify(body) });

describe("a key bound to other IP addresses: said as that, at every exchange that says it, with the address taken out", () => {
  const cases: Array<[string, string, string]> = [
    ["okx", "PermissionDenied", 'okx {"msg":"Your IP 203.0.113.7 is not included in your API key\'s IP whitelist.","code":"50110"}'],
    ["bybit", "PermissionDenied", 'bybit {"retCode":10010,"retMsg":"Unmatched IP, please check your API key\'s bound IP addresses.","result":{},"retExtInfo":{},"time":1791500000000}'],
    ["bitget", "PermissionDenied", 'bitget {"code":"40018","msg":"Invalid IP","requestTime":1791500000000,"data":null}'],
    ["kucoin", "AuthenticationError", 'kucoin {"code":"400006","msg":"The IP address is not in the API whitelist"}'],
    ["cryptocom", "AuthenticationError", 'cryptocom {"code":40103,"message":"IP address not whitelisted"}'],
    ["mexc", "BadRequest", 'mexc {"code":700006,"msg":"IP [198.51.100.23] not in the ip white list"}'],
    ["gate", "AuthenticationError", 'gate {"label":"IP_FORBIDDEN","message":"Request IP not in whitelist: 2001:db8:85a3::8a2e:370:7334"}'],
    ["bitstamp", "PermissionDenied", 'bitstamp {"status":"error","reason":"IP address not allowed"}'],
  ];
  for (const [id, kind, message] of cases) {
    it(`${id}: the key is good, this machine's address is not on its list`, () => {
      const r = exchangeSaidNo(id, id.toUpperCase(), thrown(kind, message), {});
      expect(r.code).toBe("E_VENUE_PERMISSION");
      expect(r.message).toBe(`${id.toUpperCase()} refuses this key from this machine's address: the key is bound to a list of IP addresses, and the one this machine reaches ${id.toUpperCase()} from now is not on it. Add this machine's current address to the key's IP list at ${id.toUpperCase()} (or make the key again with it), then try again`);
      expect(r.detail).toEqual({ ipList: true });
      expect(JSON.stringify(r)).not.toMatch(/203\.0\.113\.7|198\.51\.100\.23|2001:db8/);
    });
  }

  it("Binance's -2015 names three causes, IP among them: it stays the three, never guessed to be the list", () => {
    const r = exchangeSaidNo("binance", "Binance", thrown("OperationRejected", 'binance {"code":-2015,"msg":"Invalid API-key, IP, or permissions for action."}'), {});
    expect([r.code, r.message]).toEqual(["E_VENUE_UNAUTHORIZED", "Binance refused the key: it is wrong, it lacks the permission, or this machine's IP is not on its list (the exchange gives one answer for all three)"]);
  });

  it("the same for a venue read over plain HTTP", () => {
    const r = venueSaidNo("v", "Venue", 403, '{"code":"50110","msg":"Your IP 203.0.113.7 is not included in your API key\'s IP whitelist."}');
    expect([r.code, r.detail]).toEqual(["E_VENUE_PERMISSION", { ipList: true }]);
    expect(JSON.stringify(r)).not.toContain("203.0.113.7");
  });
});

describe("no refusal carries this machine's public address", () => {
  it("a venue's words that repeat it have it taken out where every refusal is made; a loopback or private address, which says nothing about the place, stays", () => {
    const r = no("E_VENUE_REJECTED", { venue: "x", message: "X refused 203.0.113.7", native: { said: "from 198.51.100.23 and 2001:db8:85a3::8a2e:370:7334", nested: [{ ip: "203.0.113.9" }], local: "connect ECONNREFUSED 127.0.0.1:4820", lan: "192.168.1.20" } });
    expect(JSON.stringify(r)).not.toMatch(/203\.0\.113|198\.51\.100|2001:db8/);
    expect(r.message).toBe("X refused (this machine's address)");
    expect(JSON.stringify(r.native)).toContain("127.0.0.1:4820");
    expect(JSON.stringify(r.native)).toContain("192.168.1.20");
    // what is not an address stays as it is: a time, a price, a version, a MAC, a path
    for (const t of ["at 12:30:45 UTC", "price 0.155", "v10.20.30", "aa:bb:cc:dd:ee:ff", "Error::Something", "abc::def"]) expect(unaddressed(t)).toBe(t);
  });
});

describe("words about a place, and words that are not", () => {
  it("a place rule is read as one; a product's or a tier's eligibility, an account's permission, a number 451 in a sentence are not", () => {
    for (const t of ["Service unavailable from a restricted location according to 'b. Eligibility'", "This feature is not available in your state", "Staking is not offered in your jurisdiction", "binance GET https://api.binance.com/api/v3/time 451 Unavailable For Legal Reasons", "The Amazon CloudFront distribution is configured to block access from your country"]) expect(REGION.test(t), t).toBe(true);
    for (const t of ["You do not meet the eligibility requirements for this product", "Trading this pair is not permitted in your account", "minimum notional 451 USDT", "This product is not supported in your VIP tier", "Trading is restricted for this market"]) expect(REGION.test(t), t).toBe(false);
  });
});

describe("a page from the server in front of a venue, refusing this network", () => {
  const PAGE = `<html><head><title>Access Denied</title></head><body><h1>Access Denied</h1>You don't have permission to access "http://api.example/" on this server.<p>Reference #18.6f2d1402.1791500000.a1b2c3</p></body></html>`;

  it("an exchange: its own answer to this network (not served), not 'could not be reached' asked again every 20 seconds", async () => {
    const client = { id: "gate", name: "Gate", has: {}, fetchTime: async () => { throw thrown("ExchangeNotAvailable", `gate GET https://api.gateio.ws/api/v4/spot/time 403 Forbidden ${PAGE}`); } } as unknown as ExchangeClient;
    const r = await exchangeClock("gate", "gate", (async () => client) as OpenExchange);
    expect(r?.code).toBe("E_VENUE_GEOBLOCKED");
    expect(r?.message).toBe("Gate refuses this network: the server in front of it answered HTTP 403 (“Access Denied”) and gave no reason — by place, or by this address's standing, it does not say. That is its own answer, and the account does not look for a way around it");
    expect(holdBackMs(r!)).toBe(600_000);
  });

  it("a keyless GET: an edge's 403 page refuses this network; the API's own 401 page asking for a key is an answer", async () => {
    const d = (a: HttpReply): ReachDeps => ({ http: (async () => a) as Http, clock: () => Date.parse("2026-10-08T15:00:00Z"), mm: (async () => ({ authenticated: true })) as unknown as RunMm });
    expect((await reachOf("live:alpaca", d(reply(403, PAGE)))).state).toBe("location");
    expect((await reachOf("live:alpaca", d(reply(401, "<html><head><title>401 Authorization Required</title></head></html>")))).state).toBe("ok");
    // a venue's own JSON "access denied" is the API's answer, not an edge's
    expect((await reachOf("live:alpaca", d(reply(403, { message: "access denied" })))).state).toBe("ok");
  });
});

describe("a ban for too many requests", () => {
  it("Binance's 418 says until when: nothing is asked of it before then — not 'in a minute'", () => {
    const until = Date.parse("2026-10-08T18:00:00Z");
    const r = exchangeSaidNo("binance", "Binance", thrown("DDoSProtection", `binance GET https://api.binance.com/api/v3/ticker/24hr 418 I'm a teapot {"code":-1003,"msg":"Way too much request weight used; IP banned until ${until}. Please use WebSocket Streams for live updates to avoid bans."}`), {});
    expect(r.code).toBe("E_VENUE_UNREACHABLE");
    expect(r.message).toBe("Binance has banned this machine's address for too many requests until 2026-10-08T18:00:00.000Z: nothing is asked of it before then");
    expect(holdBackMs(r, Date.parse("2026-10-08T17:30:00Z"))).toBe(30 * 60_000);
    // over plain HTTP too, and a ban with no time is held back ten minutes
    const plain = venueSaidNo("v", "Venue", 418, "IP banned");
    expect(plain.code).toBe("E_VENUE_UNREACHABLE");
    expect(holdBackMs(plain)).toBe(600_000);
  });
});

describe("an exchange whose library has no clock is asked its own public question", () => {
  it("not taken for a yes: its cheapest public list is asked, and its refusal there is its answer", async () => {
    let asked = 0;
    const gemini = { id: "gemini", name: "Gemini", has: {}, publicGetV1Symbols: async () => (asked++, ["btcusd"]) } as unknown as ExchangeClient;
    expect(await exchangeClock("gemini", "gemini", (async () => gemini) as OpenExchange)).toBeUndefined();
    expect(asked).toBe(1);
    const refusing = { id: "cryptocom", name: "Crypto.com", has: { fetchTime: false }, v1PublicGetPublicGetInstruments: async () => { throw thrown("ExchangeNotAvailable", 'cryptocom GET https://api.crypto.com/v2/public/get-instruments 451 Unavailable For Legal Reasons {"message":"Service unavailable from a restricted location"}'); } } as unknown as ExchangeClient;
    expect((await exchangeClock("cryptocom", "cryptocom", (async () => refusing) as OpenExchange))?.code).toBe("E_VENUE_GEOBLOCKED");
    // one with neither a clock nor a listed call: its markets, which connecting reads first anyway
    let loaded = 0;
    const other = { id: "someex", name: "Some Exchange", has: { fetchTime: false }, loadMarkets: async () => (loaded++, {}) } as unknown as ExchangeClient;
    expect(await exchangeClock("someex", "someex", (async () => other) as OpenExchange)).toBeUndefined();
    expect(loaded).toBe(1);
  });
});

describe("asked with no key, any answer that is not about the place or the network is the exchange answering", () => {
  it("Gate EU's clock asking for a signed header is not 'no way in': the exchange answered this network", async () => {
    const client = { id: "gateeu", name: "Gate EU", has: {}, fetchTime: async () => { throw thrown("AuthenticationError", 'gateeu GET https://api.gateio.ws/api/v4/spot/time 401 Unauthorized {"label":"INVALID_KEY","message":"Missing required header: Timestamp"}'); } } as unknown as ExchangeClient;
    expect(await exchangeClock("gateeu", "gateeu", (async () => client) as OpenExchange)).toBeUndefined();
    // a place rule, or no answer, is still said
    const down = { id: "x", name: "X", has: {}, fetchTime: async () => { throw thrown("RequestTimeout", "x GET https://x/time request timed out"); } } as unknown as ExchangeClient;
    expect((await exchangeClock("x", "x", (async () => down) as OpenExchange))?.code).toBe("E_VENUE_UNREACHABLE");
  });
});

describe("the account's own answer, kept, refuses at the door only while it is fresh", () => {
  const home = mkdtempSync(join(tmpdir(), "live-ip-blocks-"));
  afterAll(() => rmSync(home, { recursive: true, force: true }));
  type NoNonce<T> = T extends unknown ? Omit<T, "nonce"> : never;

  it("an agent's ask for a venue that refused this network ten minutes ago or more goes to the owner: the network may have changed", async () => {
    let now = Date.parse("2026-10-08T15:00:00Z");
    let n = 0;
    const owner = simKey("owner");
    const cc = simKey("agent:claude-code");
    const openExchange: OpenExchange = async (id) => ({ id, name: id === "binance" ? "Binance" : id, has: {}, fetchTime: async () => { if (id === "binance") throw thrown("ExchangeNotAvailable", 'binance GET https://api.binance.com/api/v3/time 451 Unavailable For Legal Reasons {"code":0,"msg":"Service unavailable from a restricted location"}'); return 1; } }) as unknown as ExchangeClient;
    const http = (async () => ({ status: 404, body: undefined, text: "" })) as Http;
    // the account's clock follows the test's: the nonces below are signed at that moment, and a nonce is good for two days around the account's clock
    const svc = await PortfolioService.create({ home, now: () => new Date(now).toISOString(), venues: "frontline", real: true, publicMarkets: [], liveDeps: { http, openExchange, clock: () => now, mm: (async () => ({ authenticated: true })) as unknown as RunMm, price: async () => undefined }, account: { owners: [{ id: owner.address, kind: "eoa", label: "owner", addedAt: new Date(now).toISOString() }] } });
    const own = async (a: NoNonce<OwnerAction>) => svc.exchange(await signOwner(owner, { ...a, nonce: now + ++n } as OwnerAction));
    const ag = async (a: NoNonce<AgentAction>) => svc.exchange(await signAgent(cc, { ...a, nonce: now + ++n } as AgentAction));
    expect(isRefusal(await own({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: now + 30 * 86_400_000 }))).toBe(false);
    await svc.venuesHere(true);
    const fresh = await ag({ type: "agentAsk", kind: "venue", venue: "binance", usd: "0", text: "connect Binance" });
    expect(isRefusal(fresh) && fresh.code).toBe("E_VENUE_GEOBLOCKED");
    now += 11 * 60_000;
    const stale = await ag({ type: "agentAsk", kind: "venue", venue: "binance", usd: "0", text: "connect Binance again" });
    expect(isRefusal(stale)).toBe(false);
  });
});
