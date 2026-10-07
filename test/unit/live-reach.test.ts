import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ExchangeClient, OpenExchange } from "../../src/portfolio/live/exchange.ts";
import type { RunMm } from "../../src/portfolio/live/metamask.ts";
import { reachKeepMs, reachOf, venueWords, type ReachDeps } from "../../src/portfolio/live/reach.ts";
import { OAuthSignIn } from "../../src/portfolio/live/signin.ts";
import type { Http, HttpReply } from "../../src/portfolio/live/types.ts";
import { startPortfolioServer } from "../../src/portfolio/server.ts";
import { PortfolioService } from "../../src/portfolio/service.ts";

/** Before a key is made: each connection's own first, keyless question to its venue (live/reach.ts), so the list of accounts says up front
 * which venue does not serve this location — in the venue's words — and sends no key, token or address to ask it. The venues' answers
 * below are what they said to this machine on 2026-10-07, verbatim (ccxt's message around them included) */
const BINANCE_451 = `binance GET https://api.binance.com/api/v3/time 451 Unavailable For Legal Reasons {\n  "code": 0,\n  "msg": "Service unavailable from a restricted location according to 'b. Eligibility' in https://www.binance.com/en/terms. Please contact customer service if you believe you received this message in error."\n}`;
const BYBIT_403 = "bybit GET https://api.bybit.com/v5/market/time 403 Forbidden {\n    error:The Amazon CloudFront distribution is configured to block access from your country\n}";

const thrown = (name: string, message: string) => Object.assign(new Error(message), { name });
const exchange = (name: string, clock: () => Promise<unknown>, has: Record<string, boolean> = {}): ExchangeClient => ({ id: name.toLowerCase(), name, has, fetchTime: clock }) as unknown as ExchangeClient;
const reply = (status: number, body: unknown): HttpReply => ({ status, body, text: typeof body === "string" ? body : JSON.stringify(body) });

/** stand-ins that record what they were asked, and with what headers */
function deps(over: Partial<ReachDeps> & { answers?: Record<string, HttpReply | Error>; clients?: Record<string, ExchangeClient> } = {}) {
  const asked: Array<{ url: string; headers: Record<string, string> }> = [];
  const keys: Array<Record<string, string>> = [];
  const http: Http = async (url, init = {}) => {
    asked.push({ url, headers: init.headers ?? {} });
    const a = over.answers?.[url];
    if (a instanceof Error) throw a;
    return a ?? reply(404, "not here");
  };
  const open: OpenExchange = async (id, key) => {
    keys.push(key);
    return over.clients?.[id];
  };
  const mm: RunMm = async () => ({ authenticated: true }) as never;
  return { d: { http, clock: () => Date.parse("2026-10-07T19:00:00Z"), open, mm, ...over } as ReachDeps, asked, keys };
}

describe("reach: each venue's first, keyless question, before a key is made", () => {
  it("an exchange answers its public clock: ok; the library has no clock call for it: ok (that is the library's word, not the venue's)", async () => {
    const { d, keys } = deps({ clients: { okx: exchange("OKX", async () => 1_791_000_000_000), krakenfutures: exchange("Kraken Futures", async () => Promise.reject(thrown("NotSupported", "fetchTime() is not supported yet"))) } });
    expect(await reachOf("live:exchange:okx", d)).toEqual({ connector: "live:exchange:okx", state: "ok", at: "2026-10-07T19:00:00.000Z" });
    expect((await reachOf("live:exchange:krakenfutures", d)).state).toBe("ok");
    // the client was made with no key at all
    expect(keys).toEqual([{}, {}]);
  });

  it("Binance's 451 and Bybit's CloudFront 403 are the venues' location rule, said in their own words — Bybit's arrives labelled a rate limit by the library and is still read by what it says", async () => {
    const { d } = deps({ clients: { binance: exchange("Binance", async () => Promise.reject(thrown("ExchangeNotAvailable", BINANCE_451))), bybit: exchange("Bybit", async () => Promise.reject(thrown("RateLimitExceeded", BYBIT_403))) } });
    const b = await reachOf("live:exchange:binance", d);
    expect(b.state).toBe("location");
    expect(b.said).toBe("Binance does not serve this location: that is its own rule, and the account does not look for a way around it. It answered: “Service unavailable from a restricted location according to 'b. Eligibility' in https://www.binance.com/en/terms. Please contact customer service if you believe you received this message in error.”");
    const y = await reachOf("live:exchange:bybit", d);
    expect(y.state).toBe("location");
    expect(y.said).toContain("Bybit does not serve this location");
    expect(y.said).toContain("“The Amazon CloudFront distribution is configured to block access from your country”");
    expect(y.said).not.toMatch(/rate|try again/i);
    expect([reachKeepMs(b), reachKeepMs({ ...b, state: "ok" }), reachKeepMs({ ...b, state: "unreachable" })]).toEqual([600_000, 120_000, 20_000]);
  });

  it("an exchange that does not answer is no answer just now, not a no; one the library does not know has no way in", async () => {
    const { d } = deps({ clients: { kraken: exchange("Kraken", async () => Promise.reject(thrown("NetworkError", "kraken GET https://api.kraken.com/0/public/Time fetch failed"))) } });
    expect((await reachOf("live:exchange:kraken", d)).state).toBe("unreachable");
    const none = await reachOf("live:exchange:nowhere", d);
    expect(none.state).toBe("closed");
    expect(none.said).toContain('knows no exchange called "nowhere"');
  });

  it("Alpaca, Robinhood Crypto and Kalshi: a keyless GET; 401 or 400 asking for the key is an answer, a 451 or the place named is the rule, 5xx or nothing is no answer — and no credential header is ever sent", async () => {
    const { d, asked } = deps({
      answers: {
        "https://api.alpaca.markets/v2/clock": reply(401, "<html><head><title>401 Authorization Required</title></head></html>"),
        "https://trading.robinhood.com/api/v1/crypto/trading/accounts/": reply(400, "Request missing required headers. Required headers: x-api-key, x-signature, x-timestamp."),
        "https://external-api.kalshi.com/trade-api/v2/exchange/status": reply(200, { exchange_active: true, trading_active: true }),
      },
    });
    expect((await reachOf("live:alpaca", d)).state).toBe("ok");
    expect((await reachOf("live:robinhood-crypto", d)).state).toBe("ok");
    expect((await reachOf("live:kalshi", d)).state).toBe("ok");
    for (const a of asked) expect(Object.keys(a.headers).map((h) => h.toLowerCase()).filter((h) => /auth|key|sign|token|cookie/.test(h))).toEqual([]);
    const blocked = deps({ answers: { "https://api.alpaca.markets/v2/clock": reply(451, { message: "Alpaca is not available in your country" }), "https://external-api.kalshi.com/trade-api/v2/exchange/status": reply(503, "Service Unavailable"), "https://trading.robinhood.com/api/v1/crypto/trading/accounts/": new Error("ECONNRESET") } }).d;
    const al = await reachOf("live:alpaca", blocked);
    expect(al.state).toBe("location");
    expect(al.said).toBe("Alpaca does not serve this location: that is its own rule, and the account does not look for a way around it. It answered: “Alpaca is not available in your country”");
    expect((await reachOf("live:kalshi", blocked)).state).toBe("unreachable");
    expect((await reachOf("live:robinhood-crypto", blocked)).state).toBe("unreachable");
  });

  it("Polymarket's location check: blocked is its rule; what it says about the place and the IP never leaves the account", async () => {
    const { d } = deps({ answers: { "https://polymarket.com/api/geoblock": reply(200, { blocked: true, ip: "203.0.113.7", country: "XX", region: "YY" }) } });
    const r = await reachOf("live:polymarket-trade", d);
    expect(r.state).toBe("location");
    expect(r.said).toBe("Polymarket does not serve this location: that is its own rule, and the account does not look for a way around it. Its location check answered blocked");
    expect(JSON.stringify(r)).not.toMatch(/203\.0\.113\.7|"XX"|"YY"|\bXX\b|\bYY\b/);
    expect((await reachOf("live:polymarket-trade", deps({ answers: { "https://polymarket.com/api/geoblock": reply(200, { blocked: false }) } }).d)).state).toBe("ok");
    expect((await reachOf("live:polymarket-trade", deps({ answers: { "https://polymarket.com/api/geoblock": new Error("ETIMEDOUT") } }).d)).state).toBe("unreachable");
  });

  it("Robinhood: the sign-in's discovery only — ok when a client may register itself, no way in when it may not; nothing is registered", async () => {
    const meta = (registration: boolean): Record<string, HttpReply> => ({
      "https://agent.robinhood.com/.well-known/oauth-protected-resource/mcp/trading": reply(200, { authorization_servers: ["https://agent.robinhood.com/mcp/trading"] }),
      "https://agent.robinhood.com/.well-known/oauth-authorization-server/mcp/trading": reply(200, { issuer: "https://agent.robinhood.com/mcp/trading", authorization_endpoint: "https://robinhood.com/oauth/authorize", token_endpoint: "https://agent.robinhood.com/oauth/token", ...(registration ? { registration_endpoint: "https://agent.robinhood.com/oauth/register" } : {}), code_challenge_methods_supported: ["S256"] }),
    });
    for (const [registration, state] of [[true, "ok"], [false, "closed"]] as const) {
      const { d, asked } = deps({ answers: meta(registration) });
      const s = new OAuthSignIn({ resource: "https://agent.robinhood.com/mcp/trading", name: "Robinhood", venue: "robinhood", http: d.http, clock: d.clock });
      const r = await reachOf("live:robinhood", { ...d, signIn: (k) => (k === "robinhood" ? s : undefined) });
      expect(r.state).toBe(state);
      if (state === "closed") expect(r.said).toContain("does not let a new client register itself");
      expect(asked.map((a) => a.url).every((u) => u.includes("/.well-known/"))).toBe(true);
    }
  });

  it("MetaMask Agent Wallet: mm signed in on this machine is ok; not signed in, or not installed, says what to run — and mm is asked only its auth status", async () => {
    const runs: string[][] = [];
    const mm = (answer: unknown): RunMm => (async (args: string[]) => {
      runs.push(args);
      if (answer instanceof Error) throw answer;
      return answer;
    }) as RunMm;
    const base = deps().d;
    expect((await reachOf("live:metamask", { ...base, mm: mm({ authenticated: true }) })).state).toBe("ok");
    const out = await reachOf("live:metamask", { ...base, mm: mm({ authenticated: false }) });
    expect(out).toMatchObject({ state: "setup", said: "mm is not signed in on this machine: run mm login in a terminal, then check again" });
    const missing = await reachOf("live:metamask", { ...base, mm: mm(Object.assign(new Error("the mm command line is not installed on this machine (spawn mm ENOENT)"), { code: "ENOENT" })) });
    expect(missing.state).toBe("setup");
    expect(missing.said).toContain("npm install -g @metamask/agent-wallet");
    expect(runs.every((a) => a.join(" ") === "auth status")).toBe(true);
  });

  it("the connections read by address ask nothing (a public read is the same everywhere); a name that is no connection has no way in", async () => {
    const { d, asked, keys } = deps();
    for (const c of ["live:wallet", "live:hyperliquid", "live:polymarket", "live:ondo", "live:exchange"]) expect((await reachOf(c, d)).state).toBe("ok");
    expect(asked).toEqual([]);
    expect(keys).toEqual([]);
    expect((await reachOf("exchange:okx", d)).state).toBe("closed");
  });

  it("finds the venue's own sentence: the JSON message, the sentence in braces a server in front of it sent, or the one that names the place", () => {
    expect(venueWords(BINANCE_451)).toBe("Service unavailable from a restricted location according to 'b. Eligibility' in https://www.binance.com/en/terms. Please contact customer service if you believe you received this message in error.");
    expect(venueWords(BYBIT_403)).toBe("The Amazon CloudFront distribution is configured to block access from your country");
    expect(venueWords("<html><h1>403</h1><p>Sorry. This service is not available in your country. Thanks.</p></html>")).toBe("This service is not available in your country.");
    expect(venueWords("bad gateway")).toBe("");
  });
});

describe("GET /api/account/connect/reach", () => {
  const home = mkdtempSync(join(tmpdir(), "live-reach-"));
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it("answers each connection asked for, keeps a location rule ten minutes (asked once while on its way), asks again on force, and takes only connection names", async () => {
    let clocks = 0;
    const openExchange: OpenExchange = async (id) => (id === "binance" ? exchange("Binance", async () => (clocks++, Promise.reject(thrown("ExchangeNotAvailable", BINANCE_451)))) : id === "okx" ? exchange("OKX", async () => (clocks++, 1)) : undefined);
    const http: Http = async () => reply(599, "");
    const svc = await PortfolioService.create({ home, venues: "frontline", real: true, liveDeps: { http, openExchange, mm: (async () => ({ authenticated: true })) as unknown as RunMm }, publicMarkets: [] });
    const server = await startPortfolioServer({ port: 0, service: svc, snapshotMs: 3_600_000 });
    try {
      const ask = async (q: string) => {
        const r = await fetch(`${server.url}/api/account/connect/reach?${q}`);
        return { status: r.status, body: (await r.json()) as { ok: boolean; reach?: Array<{ connector: string; state: string; said?: string }>; error?: string } };
      };
      const [a, b] = await Promise.all([ask("connector=live:exchange:binance,live:exchange:okx,live:hyperliquid"), ask("connector=live:exchange:binance")]);
      expect(a.status).toBe(200);
      expect(a.body.reach!.map((r) => [r.connector, r.state])).toEqual([["live:exchange:binance", "location"], ["live:exchange:okx", "ok"], ["live:hyperliquid", "ok"]]);
      expect(b.body.reach![0]!.said).toContain("Service unavailable from a restricted location");
      // two asked at once: the venue was asked once each
      expect(clocks).toBe(2);
      await ask("connector=live:exchange:binance");
      expect(clocks).toBe(2);
      await ask("connector=live:exchange:binance&force=1");
      expect(clocks).toBe(3);
      for (const q of ["", "connector=", "connector=okx", "connector=live:exchange:okx&connector=live:kalshi", `connector=${Array.from({ length: 25 }, (_, i) => `live:x${i}`).join(",")}`]) expect((await ask(q)).status, q).toBe(400);
    } finally {
      await server.close();
    }
  });
});
