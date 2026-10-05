import { createHash, createPublicKey, verify } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isRefusal, type Refusal } from "../../src/core/errors.ts";
import type { Outcome } from "../../src/portfolio/account/exchange.ts";
import { signOwner, simKey, type OwnerAction } from "../../src/portfolio/account/sign.ts";
import type { ChainName, ChainReader } from "../../src/portfolio/live/chain.ts";
import type { LiveDeps } from "../../src/portfolio/live/index.ts";
import { READ_TOOLS, ROBINHOOD_MCP, robinhoodKey, robinhoodSign, type McpSession, type McpTool, type OpenMcp } from "../../src/portfolio/live/robinhood.ts";
import type { Http, HttpReply } from "../../src/portfolio/live/types.ts";
import { PortfolioService } from "../../src/portfolio/service.ts";

/** Robinhood's three interfaces, each against a stand-in: its crypto API, its Stock Token list and prices, its sign-in and its MCP server.
 * Nothing here leaves the process. The one key pair in this file is the one Robinhood's own docs publish as a worked example. */
type NoNonce<T> = T extends unknown ? Omit<T, "nonce"> : never;
const START = Date.parse("2026-10-05T14:00:00.000Z");
const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));
const owner = simKey("owner");

// docs.robinhood.com/crypto/trading, "Headers and Signature": the published example key pair, request and signature
const DOC = { privateKey: "xQnTJVeQLmw1/Mg2YimEViSpw/SdJcgNXZ5kQkAXNPU=", publicKey: "jPItx4TLjcnSUnmnXQQyAKL4eJj3+oWNNMmmm2vATqk=", apiKey: "rh-api-6148effc-c0b1-486c-8940-a1d099456be6", timestamp: "1698708981", path: "/api/v1/crypto/trading/orders/", method: "POST", signature: "q/nEtxp/P2Or3hph3KejBqnw5o9qeuQ+hYRnB56FaHbjDsNUY9KhB1asMxohDnzdVFSD7StaTqjSd9U9HvaRAw==" };
// the docs' Python example signs its body as Python prints the dict
const DOC_BODY = "{'client_order_id': '131de903-5a9c-4260-abc1-28d562a5dcf0', 'side': 'buy', 'symbol': 'BTC-USD', 'type': 'market', 'market_order_config': {'asset_quantity': '0.1'}}";
const docPublic = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(DOC.publicKey, "base64")]), format: "der", type: "spki" });

const json = (body: unknown, status = 200): HttpReply => ({ status, body, text: JSON.stringify(body) });
type Asked = { url: string; method: string; headers: Record<string, string>; body?: string | undefined };

/** a network that answers only what the test routes, and remembers every request */
function net(route: (a: Asked) => HttpReply | undefined): Http & { asked: Asked[] } {
  const asked: Asked[] = [];
  const http = (async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const a: Asked = { url, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body };
    asked.push(a);
    return route(a) ?? { status: 599, body: undefined, text: "no network in tests" };
  }) as Http & { asked: Asked[] };
  http.asked = asked;
  return http;
}

function chain(held: Record<string, number>): ChainReader & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async tokens(_holder, refs) {
      asked.push(refs.map((r) => `${r.chain}:${r.asset}`).join(","));
      return { rows: refs.map((r) => ({ chain: r.chain, asset: r.asset, amount: held[`${r.chain}:${r.asset}`] ?? 0 })), failed: [] };
    },
    async native(_holder, chains: ChainName[]) {
      return { rows: chains.map((c) => ({ chain: c, asset: c === "BNB Chain" ? "BNB" : c === "Polygon" ? "POL" : "ETH", amount: 0 })), failed: [] };
    },
    async uint() {
      return undefined;
    },
    async decimals() {
      return 18;
    },
    async receipt() {
      return undefined;
    },
  };
}

async function boot(o: { http: Http; chain?: ChainReader; openMcp?: OpenMcp; clock?: () => number }) {
  let n = 0;
  const home = mkdtempSync(join(tmpdir(), "account-robinhood-"));
  homes.push(home);
  const liveDeps: Partial<LiveDeps> = { http: o.http, clock: o.clock ?? (() => START), chain: o.chain ?? chain({}), price: async () => undefined, ...(o.openMcp ? { openMcp: o.openMcp } : {}) };
  const svc = await PortfolioService.create({ home, now: () => new Date(START).toISOString(), venues: "frontline", liveDeps, account: { owners: [{ id: owner.address, kind: "eoa", label: "owner", addedAt: new Date(START).toISOString() }] } });
  const own = async (a: NoNonce<OwnerAction>) => svc.exchange(await signOwner(owner, { ...a, nonce: START + ++n } as OwnerAction));
  const keyFile = (ref: string, content: unknown) => {
    const path = join(home, ref);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(content));
    chmodSync(path, 0o600);
  };
  const venue = async (id: string) => (await svc.account!.view()).venues.find((v) => v.id === id);
  return { svc, own, keyFile, venue };
}

const refusal = (o: Outcome | Refusal | unknown): Refusal => {
  if (!isRefusal(o)) throw new Error(`expected a refusal, got ${JSON.stringify(o).slice(0, 200)}`);
  return o;
};
const summary = (o: Outcome): string => {
  if (isRefusal(o) || o.kind !== "account") throw new Error(`expected a summary, got ${isRefusal(o) ? `${o.code}: ${o.message}` : o.kind}`);
  return o.summary;
};

describe("Robinhood Crypto, through its own API", () => {
  it("signs as Robinhood's docs do: the published example comes out byte for byte", () => {
    const key = robinhoodKey(DOC.privateKey)!;
    expect(robinhoodSign(key, DOC.apiKey, DOC.timestamp, DOC.path, DOC.method, DOC_BODY)).toBe(DOC.signature);
    expect(robinhoodKey("not a key")).toBeUndefined();
  });

  it("reads buying power and holdings, priced at Robinhood's own midpoint, and only ever sends GETs", async () => {
    const http = net((a) => {
      const u = new URL(a.url);
      if (u.host !== "trading.robinhood.com") return undefined;
      if (u.pathname === "/api/v2/crypto/trading/accounts/") return json({ results: [{ account_number: "5512340009", status: "active", buying_power: "125.50", buying_power_currency: "USD", is_api_tradable: true }], next: null });
      if (u.pathname === "/api/v2/crypto/trading/holdings/" && !u.searchParams.has("cursor")) return json({ results: [{ account_number: "5512340009", asset_code: "BTC", total_quantity: "0.01" }], next: "https://trading.robinhood.com/api/v2/crypto/trading/holdings/?account_number=5512340009&cursor=abc" });
      if (u.pathname === "/api/v2/crypto/trading/holdings/") return json({ results: [{ account_number: "5512340009", asset_code: "ETH", total_quantity: "0.5" }, { account_number: "5512340009", asset_code: "DOGE", total_quantity: "0" }], next: null });
      if (u.pathname === "/api/v2/crypto/marketdata/best_bid_ask/") return json({ results: [{ symbol: "BTC-USD", price: 60000 }, { symbol: "ETH-USD", price: 2500 }] });
      return undefined;
    });
    const x = await boot({ http });
    x.keyFile("credentials/robinhood-crypto/api-key.json", { apiKey: DOC.apiKey, privateKey: DOC.privateKey });
    const said = summary(await x.own({ type: "connectVenue", venue: "robinhood-crypto", connector: "live:robinhood-crypto", label: "", credentialRef: "" }));
    expect(said).toContain("Robinhood Crypto connected live · $1,975.50 there now");
    expect(said).toContain("read only: Robinhood's crypto API reads and trades; it has no call that moves money in or out");
    const v = (await x.venue("robinhood-crypto"))!;
    // the page lists what is worth most first
    expect(v.holdings.map((h) => [h.asset, h.amount, h.usd])).toEqual([["ETH", 0.5, 1250], ["BTC", 0.01, 600], ["USD", 125.5, 125.5]]);
    // every request a GET, signed: Ed25519 over api key + timestamp in seconds + path with its query + GET, and nothing else in the body
    expect(http.asked.every((a) => a.method === "GET")).toBe(true);
    for (const a of http.asked) {
      const u = new URL(a.url);
      expect(a.headers["x-api-key"]).toBe(DOC.apiKey);
      expect(a.headers["x-timestamp"]).toBe(String(Math.floor(START / 1000)));
      expect(verify(null, Buffer.from(`${DOC.apiKey}${a.headers["x-timestamp"]}${u.pathname}${u.search}GET`), docPublic, Buffer.from(a.headers["x-signature"]!, "base64"))).toBe(true);
    }
    // the account is named by its last four digits; the whole number is not on the page
    expect(JSON.stringify(v)).not.toContain("5512340009");
  });

  it("a key file that is not Robinhood's, and a key Robinhood does not take, are said plainly", async () => {
    const x = await boot({ http: net((a) => (a.url.startsWith("https://trading.robinhood.com/") ? json({ type: "client_error", errors: [{ detail: "Invalid API key" }] }, 401) : undefined)) });
    x.keyFile("credentials/robinhood-crypto/api-key.json", { apiKey: "rh-api-made-up", privateKey: "short" });
    const bad = refusal(await x.own({ type: "connectVenue", venue: "robinhood-crypto", connector: "live:robinhood-crypto", label: "", credentialRef: "" }));
    expect([bad.code, bad.message]).toEqual(["E_ACCOUNT_CREDENTIAL", "the private key is not the base64 Ed25519 key Robinhood's docs have you make (32 bytes once decoded)"]);
    x.keyFile("credentials/robinhood-crypto/api-key.json", { apiKey: "rh-api-made-up", privateKey: DOC.privateKey });
    expect(refusal(await x.own({ type: "connectVenue", venue: "robinhood-crypto", connector: "live:robinhood-crypto", label: "", credentialRef: "" })).code).toBe("E_VENUE_UNAUTHORIZED");
  });
});

describe("Robinhood's Stock Tokens, in any wallet", () => {
  it("reads the tokens Robinhood lists on Robinhood Chain from the chain, priced at Robinhood's bid for the token", async () => {
    const http = net((a) => {
      if (a.url === "https://api.robinhood.com/rhj/assets")
        return json({ assets: [
          { tokenSymbol: "NVDA", tokenName: "NVIDIA • Robinhood Token", status: "ASSET_STATUS_ACTIVE", deployments: [{ contractAddress: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", chainId: 4663 }] },
          { tokenSymbol: "AAPL", tokenName: "Apple • Robinhood Token", status: "ASSET_STATUS_ACTIVE", deployments: [{ contractAddress: "0x00000000000000000000000000000000000a4b11", chainId: 4663 }] },
          { tokenSymbol: "GONE", status: "ASSET_STATUS_DELISTED", deployments: [{ contractAddress: "0x00000000000000000000000000000000000a4b12", chainId: 4663 }] },
          { tokenSymbol: "ELSE", status: "ASSET_STATUS_ACTIVE", deployments: [{ contractAddress: "0x00000000000000000000000000000000000a4b13", chainId: 999999 }] },
        ] });
      if (a.url === "https://api.robinhood.com/rhj/prices/NVDA") return json({ quotes: [{ tokenSymbol: "NVDA", bid: "236.87", ask: "236.88", tokenBid: "237.05", tokenAsk: "237.06" }] });
      return undefined;
    });
    const c = chain({ "Robinhood Chain:NVDA": 2, "Arbitrum:USDC": 10 });
    const x = await boot({ http, chain: c });
    const said = summary(await x.own({ type: "connectVenue", venue: "wallet-rh", connector: "live:wallet", label: "Robinhood Wallet", credentialRef: "0x00000000000000000000000000000000000000a1" }));
    expect(said).toContain("Robinhood Wallet connected live · $484.10 there now");
    expect(said).toContain("Robinhood Chain, and Robinhood's Stock Tokens");
    const v = (await x.venue("wallet-rh"))!;
    expect(v.holdings.map((h) => [h.asset, h.amount, h.usd])).toEqual([["NVDA", 2, 474.1], ["USDC", 10, 10]]);
    // delisted tokens and chains this account does not read are not asked for; only a held token is priced
    expect(c.asked).toContain("Robinhood Chain:NVDA,Robinhood Chain:AAPL");
    expect(http.asked.map((a) => a.url)).toEqual(["https://api.robinhood.com/rhj/assets", "https://api.robinhood.com/rhj/prices/NVDA"]);
  });
});

// ---- Robinhood stocks: the sign-in and the MCP server ---------------------------------------

const ISSUER = "https://agent.robinhood.com/mcp/trading";
const CALLBACK = "http://127.0.0.1:4820/api/account/signin/callback";

/** Robinhood's sign-in as its metadata describes it (read 2026-10-05), with made-up tokens */
function robinhoodSignIn(o: { iss?: boolean } = {}) {
  let issued = 0;
  const http = net((a) => {
    if (a.url === "https://agent.robinhood.com/.well-known/oauth-protected-resource/mcp/trading") return json({ authorization_servers: [ISSUER], resource: ROBINHOOD_MCP, scopes_supported: ["internal"] });
    if (a.url === "https://agent.robinhood.com/.well-known/oauth-authorization-server/mcp/trading")
      return json({ issuer: ISSUER, authorization_endpoint: "https://robinhood.com/oauth", token_endpoint: "https://api.robinhood.com/oauth2/token/", registration_endpoint: "https://agent.robinhood.com/oauth/trading/register", code_challenge_methods_supported: ["S256"], scopes_supported: ["internal"], token_endpoint_auth_methods_supported: ["none"], authorization_response_iss_parameter_supported: o.iss ?? true });
    if (a.url === "https://agent.robinhood.com/oauth/trading/register" && a.method === "POST") return json({ client_id: "client-made-up-1" }, 201);
    if (a.url === "https://api.robinhood.com/oauth2/token/" && a.method === "POST") return json({ access_token: `access-made-up-${++issued}`, refresh_token: `refresh-made-up-${issued}`, expires_in: 3600, token_type: "Bearer" });
    return undefined;
  });
  return http;
}

/** Robinhood's MCP server, as far as the tools go: three that read, three that trade, and what each read answers */
function mcpServer(answers: Partial<Record<string, unknown>>, tools: McpTool[] = [{ name: "get_accounts" }, { name: "get_portfolio", inputSchema: { required: ["account_number"] } }, { name: "get_equity_positions" }, { name: "review_equity_order" }, { name: "place_equity_order" }, { name: "cancel_equity_order" }, { name: "add_to_watchlist" }]) {
  const called: Array<[string, Record<string, unknown>]> = [];
  const bearers: string[] = [];
  const open: OpenMcp = async (url, bearer) => {
    expect(url).toBe(ROBINHOOD_MCP);
    bearers.push(bearer);
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
  return { open, called, bearers };
}

describe("Robinhood's own sign-in", () => {
  it("registers as a public client, signs in with PKCE, checks who answered, and keeps the token in memory", async () => {
    let now = START;
    const http = robinhoodSignIn();
    const x = await boot({ http, clock: () => now });
    const signIn = x.svc.signIn("robinhood")!;
    const started = await signIn.start(CALLBACK);
    if (isRefusal(started)) throw new Error(started.message);
    const url = new URL(started.url);
    const q = Object.fromEntries(url.searchParams);
    expect([url.origin + url.pathname, q.response_type, q.client_id, q.redirect_uri, q.code_challenge_method, q.state, q.resource, q.scope]).toEqual(["https://robinhood.com/oauth", "code", "client-made-up-1", CALLBACK, "S256", started.state, ROBINHOOD_MCP, "internal"]);
    const registered = JSON.parse(http.asked.find((a) => a.url.endsWith("/register"))!.body!);
    expect([registered.redirect_uris, registered.token_endpoint_auth_method, registered.grant_types]).toEqual([[CALLBACK], "none", ["authorization_code", "refresh_token"]]);
    expect(signIn.status(started.state)).toEqual({ status: "waiting" });

    // a state this server did not make, and an answer that names another issuer, are not Robinhood's
    expect(refusal(await signIn.finish({ state: "made-up-state", code: "c" })).code).toBe("E_ACCOUNT_BAD_ACTION");
    const other = await signIn.start(CALLBACK);
    if (isRefusal(other)) throw new Error(other.message);
    expect(refusal(await signIn.finish({ state: other.state, code: "c", iss: "https://elsewhere.example" })).message).toBe("the answer did not come from Robinhood's own sign-in (its issuer is https://agent.robinhood.com/mcp/trading)");
    expect(signIn.status(other.state).status).toBe("failed");

    expect(await signIn.finish({ state: started.state, code: "code-made-up", iss: ISSUER })).toEqual({ ok: true });
    const traded = new URLSearchParams(http.asked.find((a) => a.url.endsWith("/oauth2/token/"))!.body!);
    // the verifier sent with the code is the one whose hash went out with the sign-in
    expect([traded.get("grant_type"), traded.get("code"), traded.get("client_id"), traded.get("resource"), createHash("sha256").update(traded.get("code_verifier")!).digest("base64url")]).toEqual(["authorization_code", "code-made-up", "client-made-up-1", ROBINHOOD_MCP, q.code_challenge]);
    expect(await signIn.token(started.state)).toBe("access-made-up-1");
    expect(refusal(await signIn.finish({ state: started.state, code: "again", iss: ISSUER })).message).toBe("this sign-in has already come back");
    // an hour later the token is renewed with the refresh token, without the owner
    now += 3_600_000;
    expect(await signIn.token(started.state)).toBe("access-made-up-2");
    expect(new URLSearchParams(http.asked.filter((a) => a.url.endsWith("/oauth2/token/")).at(-1)!.body!).get("grant_type")).toBe("refresh_token");
  });
});

describe("Robinhood's investing accounts, through its MCP server", () => {
  const signedIn = async (http: Http & { asked: Asked[] }, server: ReturnType<typeof mcpServer>) => {
    const x = await boot({ http, openMcp: server.open });
    const signIn = x.svc.signIn("robinhood")!;
    const started = await signIn.start(CALLBACK);
    if (isRefusal(started)) throw new Error(started.message);
    await signIn.finish({ state: started.state, code: "code-made-up", iss: ISSUER });
    return { ...x, state: started.state };
  };

  it("reads cash and stock positions, and calls no tool but the three that read", async () => {
    const server = mcpServer({
      get_accounts: { structuredContent: { accounts: [{ account_number: "5RH00001234", account_type: "individual" }, { account_number: "5RH00009876", account_type: "agentic" }] } },
      get_portfolio: (a: Record<string, unknown>) => ({ content: [{ type: "text", text: JSON.stringify({ account_number: a.account_number, equity: "1000.00", cash: a.account_number === "5RH00001234" ? "250.00" : "40.00" }) }] }),
      get_equity_positions: { structuredContent: { positions: [{ account_number: "5RH00001234", symbol: "NVDA", quantity: "3", market_value: { amount: "711.15", currency_code: "USD" } }, { account_number: "5RH00009876", symbol: "AAPL", quantity: "1", price: "230.00" }] } },
    });
    const x = await signedIn(robinhoodSignIn(), server);
    const said = summary(await x.own({ type: "connectVenue", venue: "robinhood", connector: "live:robinhood", label: "", credentialRef: x.state }));
    expect(said).toContain("Robinhood connected live · $1,231.15 there now");
    expect(said).toContain("the venue says this credential can read every Robinhood account, trade in the Agentic account");
    expect(said).toContain("never review_equity_order, place_equity_order or cancel_equity_order");
    expect(said).toContain("read only: Robinhood moves money in and out only in its own app");
    const v = (await x.venue("robinhood"))!;
    expect(v.holdings.map((h) => [h.asset, h.amount, h.usd])).toEqual([["NVDA", 3, 711.15], ["USD", 250, 250], ["AAPL", 1, 230], ["USD", 40, 40]]);
    // Robinhood offered seven tools; the account called the three that read, get_portfolio once per account as its schema asks
    expect([...new Set(server.called.map(([name]) => name))].every((t) => (READ_TOOLS as readonly string[]).includes(t))).toBe(true);
    expect(server.called.filter(([name]) => name === "get_portfolio").map(([, a]) => a)).toEqual([{ account_number: "5RH00001234" }, { account_number: "5RH00009876" }]);
    expect(server.bearers.every((b) => b === "access-made-up-1")).toBe(true);
    expect(JSON.stringify(v)).not.toContain("5RH00001234");
  });

  it("without a finished sign-in, with no tool to read by, or with answers it cannot read, it says so instead of showing zero", async () => {
    const plain = await boot({ http: robinhoodSignIn(), openMcp: mcpServer({}).open });
    expect(refusal(await plain.own({ type: "connectVenue", venue: "robinhood", connector: "live:robinhood", label: "", credentialRef: "made-up-state" })).message).toBe("Robinhood: nobody has signed in for this connection yet — sign in from the account page first");

    const tradingOnly = await signedIn(robinhoodSignIn(), mcpServer({}, [{ name: "place_equity_order" }, { name: "cancel_equity_order" }]));
    const none = refusal(await tradingOnly.own({ type: "connectVenue", venue: "robinhood", connector: "live:robinhood", label: "", credentialRef: tradingOnly.state }));
    expect(none.message).toBe("Robinhood's MCP server offered none of the tools this connection reads with (get_accounts, get_portfolio, get_equity_positions)");

    const odd = mcpServer({ get_accounts: { structuredContent: { what: "no" } }, get_portfolio: { structuredContent: { total: 5 } }, get_equity_positions: { content: [{ type: "text", text: "nothing to show" }] } }, [{ name: "get_accounts" }, { name: "get_portfolio" }, { name: "get_equity_positions" }]);
    const shaped = await signedIn(robinhoodSignIn(), odd);
    const unread = refusal(await shaped.own({ type: "connectVenue", venue: "robinhood", connector: "live:robinhood", label: "", credentialRef: shaped.state }));
    expect([unread.code, unread.message]).toEqual(["E_VENUE_REJECTED", "Robinhood answered, but not in a shape this connection reads yet: nothing in it looks like an account, cash or a position"]);
    // what is said about the answer is its keys, never its values
    expect(JSON.stringify(unread.native)).toBe(JSON.stringify({ answered: [{ tool: "get_portfolio", keys: ["total"] }, { tool: "get_equity_positions", keys: ["string"] }] }));
  });
});
