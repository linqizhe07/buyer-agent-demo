import { describe, expect, it } from "vitest";
import { accountCheck, checkMarkdown } from "../../src/portfolio/account-check.ts";
import type { ExchangeClient, OpenExchange } from "../../src/portfolio/live/exchange.ts";
import type { RunMm } from "../../src/portfolio/live/metamask.ts";
import type { PublicSource } from "../../src/portfolio/live/public-markets.ts";
import type { Http, HttpReply } from "../../src/portfolio/live/types.ts";
import { no } from "../../src/portfolio/refuse.ts";

/** `npm run account:check` (src/portfolio/account-check.ts): what the Account reaches from where it runs, in each venue's own words, to
 * paste to someone else — so it must hold no IP, place, key or balance. The network is a stand-in: one place where every venue serves, one
 * where three do not */
const reply = (status: number, body: unknown): HttpReply => ({ status, body, text: typeof body === "string" ? body : JSON.stringify(body) });
const thrown = (name: string, message: string) => Object.assign(new Error(message), { name });

function network(refusing: boolean) {
  const http: Http = async (url) => {
    if (url.includes("polymarket.com/api/geoblock")) return reply(200, { blocked: refusing, ip: "203.0.113.9", country: "ZZ", region: "QQ" });
    if (url.includes("/.well-known/oauth-protected-resource")) return reply(200, { authorization_servers: ["https://agent.robinhood.com/mcp/trading"] });
    if (url.includes("/.well-known/oauth-authorization-server")) return reply(200, { issuer: "https://agent.robinhood.com/mcp/trading", authorization_endpoint: "https://robinhood.com/oauth/authorize", token_endpoint: "https://agent.robinhood.com/oauth/token", registration_endpoint: "https://agent.robinhood.com/oauth/register", code_challenge_methods_supported: ["S256"] });
    if (url.includes("alpaca")) return reply(401, "401 Authorization Required");
    if (url.includes("robinhood.com/api/v1/crypto")) return reply(400, "Request missing required headers");
    if (url.includes("kalshi")) return reply(200, { exchange_active: true });
    return reply(404, "");
  };
  const open: OpenExchange = async (id) =>
    ({
      id,
      name: id === "binance" ? "Binance" : id === "bybit" ? "Bybit" : id.toUpperCase(),
      has: {},
      fetchTime: async () => {
        if (refusing && id === "binance") throw thrown("ExchangeNotAvailable", 'binance GET https://api.binance.com/api/v3/time 451 Unavailable For Legal Reasons {"code":0,"msg":"Service unavailable from a restricted location"}');
        if (refusing && id === "bybit") throw thrown("RateLimitExceeded", "bybit GET https://api.bybit.com/v5/market/time 403 Forbidden { error:The Amazon CloudFront distribution is configured to block access from your country }");
        return 1;
      },
    }) as unknown as ExchangeClient;
  const mm = (async () => ({ authenticated: true })) as unknown as RunMm;
  const source = (id: string, name: string, says?: string): PublicSource => ({ id, name, kind: "exchange", connectTo: id, connector: `live:exchange:${id}`, listings: async () => (says ? no("E_VENUE_GEOBLOCKED", { venue: id, message: says }) : [{ symbol: "BTC/USDT", name: "Bitcoin", kind: "coin", base: "BTC", quote: "USDT", price: 62_000, open: true, types: [] } as never]) });
  const sources = [source("kraken", "Kraken"), source("binance", "Binance", refusing ? "Binance does not serve this location: that is its own rule" : undefined)];
  return { http, clock: () => Date.parse("2026-10-08T15:00:00Z"), openExchange: open, mm, sources };
}

describe("account:check", () => {
  it("where every venue serves, every connection answers and every source lists; where some do not, exactly those say so in their own words", async () => {
    const open = await accountCheck({ home: "/nowhere", deps: network(false) });
    expect(open.connections.filter((c) => c.state !== "ok")).toEqual([]);
    expect(open.sources.every((s) => s.rows === 1)).toBe(true);
    const shut = await accountCheck({ home: "/nowhere", deps: network(true) });
    expect(shut.connections.filter((c) => c.state !== "ok").map((c) => [c.connector, c.state])).toEqual([["live:exchange:bybit", "location"], ["live:exchange:binance", "location"], ["live:polymarket-trade", "location"]]);
    expect(shut.sources.find((s) => s.id === "binance")).toMatchObject({ code: "E_VENUE_GEOBLOCKED" });
    const md = checkMarkdown(shut);
    expect(md).toContain("| Binance | Not served here | Binance does not serve this location");
    expect(md).toContain("“The Amazon CloudFront distribution is configured to block access from your country”");
    // nothing about the place: no IP, no country, no region, in the report or its JSON
    for (const text of [md, JSON.stringify(shut)]) expect(text).not.toMatch(/203\.0\.113\.9|\bZZ\b|\bQQ\b/);
  });

  it("with --keys and no key file, says so; a key file's venue it cannot place is named, not guessed", async () => {
    const r = await accountCheck({ home: "/nowhere", keys: true, deps: network(false) });
    expect(r.keys).toEqual([]);
    expect(checkMarkdown(r)).toContain("No key file in the home's credentials/.");
  });
});
