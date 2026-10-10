import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isRefusal, type Refusal } from "../../src/core/errors.ts";
import type { Outcome } from "../../src/portfolio/account/exchange.ts";
import { signAgent, signOwner, simKey, type AgentAction, type OwnerAction } from "../../src/portfolio/account/sign.ts";
import type { ChainName, ChainReader, Mined } from "../../src/portfolio/live/chain.ts";
import type { ExchangeClient, OpenExchange } from "../../src/portfolio/live/exchange.ts";
import type { LiveDeps } from "../../src/portfolio/live/index.ts";
import type { Http } from "../../src/portfolio/live/types.ts";
import { PortfolioService } from "../../src/portfolio/service.ts";

/** Live connections, with every real thing replaced by a stand-in: the exchange library, HTTP, the chain, the clock. Nothing here leaves
 * the process, and no key in this file is anyone's: they are made up on the spot. */
type NoNonce<T> = T extends unknown ? Omit<T, "nonce"> : never;
const START = Date.parse("2026-10-05T14:00:00.000Z");
const DAY = 86_400_000;
const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));

const owner = simKey("owner");
const cc = simKey("agent:claude-code");
const KEY = { apiKey: "made-up-key-0001", secret: "made-up-secret-0001" };

class Thrown extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

/** an exchange that answers like the library does */
function fakeExchange(id: string, over: Partial<ExchangeClient> & { calls?: string[] } = {}): ExchangeClient & { calls: string[] } {
  const calls = over.calls ?? [];
  const x: ExchangeClient & { calls: string[] } = {
    id,
    name: id === "binance" ? "Binance" : id === "okx" ? "OKX" : id[0]!.toUpperCase() + id.slice(1),
    requiredCredentials: { apiKey: true, secret: true, password: id === "okx" },
    markets: { "ETH/USDT": {}, "BTC/USDT": {} },
    calls,
    async loadMarkets() {
      calls.push("loadMarkets");
    },
    async fetchTime() {
      calls.push("fetchTime");
      return 1;
    },
    async fetchBalance(params = {}) {
      calls.push(`fetchBalance:${String(params.type ?? "default")}`);
      return params.type === "funding" ? { total: { USDT: 250, DOGE: 0 } } : { total: { USDT: 1200.5, ETH: 0.5, BTC: 0, WEIRD: 3 } };
    },
    async fetchTickers(symbols = []) {
      calls.push(`fetchTickers:${symbols.join(",")}`);
      return { "ETH/USDT": { last: 2000 } };
    },
    async sapiGetAccountApiRestrictions() {
      calls.push("apiRestrictions");
      return { ipRestrict: true, enableReading: true, enableWithdrawals: false, enableSpotAndMarginTrading: false, permitsUniversalTransfer: false, enableInternalTransfer: false, enableFutures: false };
    },
    async privateGetAccountConfig() {
      calls.push("accountConfig");
      return { data: [{ perm: "read_only,trade", ip: "", acctLv: "2" }] };
    },
    ...over,
  };
  return x;
}

/** a chain that holds what the test says it holds: `"Base:USDC"` → amount, `"Base"` → the chain's own coin; a chain named in `down` does not answer */
function fakeChain(held: Record<string, number>, opts: { down?: ChainName[]; uint?: Record<string, bigint>; decimals?: Record<string, number>; receipts?: Record<string, Mined> } = {}): ChainReader & { asked: string[]; receipts: Record<string, Mined> } {
  const receipts = opts.receipts ?? {};
  const asked: string[] = [];
  const down = (c: ChainName) => (opts.down ?? []).includes(c);
  return {
    asked,
    receipts,
    async decimals(_chain, token) {
      return (opts.decimals ?? {})[token.toLowerCase()] ?? 6;
    },
    async receipt(chain, hash) {
      asked.push(`receipt:${chain}:${hash}`);
      return receipts[hash.toLowerCase()];
    },
    async tokens(holder, refs) {
      asked.push(`tokens:${holder}:${refs.map((r) => `${r.chain}:${r.asset}`).join(",")}`);
      const chains = [...new Set(refs.map((r) => r.chain))];
      return { rows: refs.filter((r) => !down(r.chain)).map((r) => ({ chain: r.chain, asset: r.asset, amount: held[`${r.chain}:${r.asset}`] ?? 0 })), failed: chains.filter(down) };
    },
    async native(holder, chains) {
      asked.push(`native:${holder}`);
      return { rows: chains.filter((c) => !down(c)).map((c) => ({ chain: c, asset: c === "BNB Chain" ? "BNB" : c === "Polygon" ? "POL" : "ETH", amount: held[c] ?? 0 })), failed: chains.filter(down) };
    },
    async uint(chain, address, signature) {
      asked.push(`uint:${chain}:${signature.split("(")[0]!.replace("function ", "")}`);
      return (opts.uint ?? {})[address.toLowerCase()];
    },
  };
}

async function boot(over: { open?: OpenExchange; clock?: () => number; http?: Http; chain?: ChainReader; price?: (asset: string) => Promise<number | undefined> } = {}) {
  let t = START;
  let n = 0;
  let real = 1_000_000;
  const home = mkdtempSync(join(tmpdir(), "account-live-"));
  homes.push(home);
  const made: Record<string, ExchangeClient & { calls: string[] }> = {};
  const open: OpenExchange = over.open ?? (async (id) => (["binance", "okx", "bybit", "kraken"].includes(id) ? (made[id] ??= fakeExchange(id)) : undefined));
  const liveDeps: Partial<LiveDeps> = { openExchange: open, clock: over.clock ?? (() => real), http: over.http ?? (async () => ({ status: 599, body: undefined, text: "no network in tests" })), chain: over.chain ?? fakeChain({}), price: over.price ?? (async (asset) => ({ ETH: 2000, BNB: 600, POL: 0.5, HYPE: 40 })[asset]) };
  const svc = await PortfolioService.create({ home, now: () => new Date(t).toISOString(), venues: "frontline", liveDeps, account: { owners: [{ id: owner.address, kind: "eoa", label: "owner", addedAt: new Date(START).toISOString() }] } });
  const engine = svc.account!;
  const nonce = () => t + ++n;
  const own = async (a: NoNonce<OwnerAction>) => svc.exchange(await signOwner(owner, { ...a, nonce: nonce() } as OwnerAction));
  const ag = async (a: NoNonce<AgentAction>) => svc.exchange(await signAgent(cc, { ...a, nonce: nonce() } as AgentAction));
  const keyFile = (ref: string, content: unknown = KEY, mode = 0o600) => {
    const path = join(home, ref);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
    chmodSync(path, mode);
    return path;
  };
  const connect = (venue: string, connector: string, credentialRef = "", label = "") => own({ type: "connectVenue", venue, connector, label, credentialRef });
  const venue = async (id: string) => (await engine.view()).venues.find((v) => v.id === id);
  return { svc, engine, home, own, ag, keyFile, connect, venue, made, tick: (ms: number) => (real += ms), pass: (ms: number) => (t += ms) };
}

const code = (o: Outcome): string => (isRefusal(o) ? o.code : o.kind);
const refusal = (o: Outcome): Refusal => {
  if (!isRefusal(o)) throw new Error(`expected a refusal, got ${o.kind}`);
  return o;
};
const summary = (o: Outcome): string => {
  if (isRefusal(o) || o.kind !== "account") throw new Error(`expected a summary, got ${isRefusal(o) ? `${o.code}: ${o.message}` : o.kind}`);
  return o.summary;
};

describe("an exchange account, connected live through the unified library", () => {
  it("reads what the exchange holds and what it says the key may do; it stands in for the simulated venue and every door through it is shut", async () => {
    const x = await boot();
    x.keyFile("credentials/binance/api-key.json");
    const before = (await x.venue("binance"))!;
    expect([before.usd, before.live, before.in.access]).toEqual([28525, undefined, "agent"]);

    const said = summary(await x.connect("binance", "live:exchange:binance"));
    expect(said).toBe("Binance connected live · $2,450.50 there now · the venue says this credential can read · bound to an IP list · a read-only key · read only: this server was started without real-money writes · it stands in for the simulated one until it is unplugged");
    // the clock first (no key involved), then what the key may do, then the balances — spot and funding — and the price of what is not dollars
    expect(x.made.binance!.calls).toEqual(["fetchTime", "apiRestrictions", "fetchBalance:default", "fetchBalance:funding", "loadMarkets", "fetchTickers:ETH/USDT"]);

    const v = (await x.venue("binance"))!;
    expect([v.name, v.live, v.watchOnly, v.plugged, v.usd]).toEqual(["Binance", true, "Live · read-only", true, 2450.5]);
    expect(v.holdings.map((h) => [h.asset, h.amount, h.usd, h.note])).toEqual([["USDT", 1200.5, 1200.5, "spot"], ["ETH", 0.5, 1000, "spot"], ["USDT", 250, 250, "funding"], ["WEIRD", 3, 0, "spot · no price"]]);
    expect([v.in.access, v.out.access, v.in.why, v.swaps.map((s) => s.access), v.runways.every((r) => r.access === "closed")]).toEqual(["closed", "closed", "a live venue, connected read-only: the account reads it and sends it nothing", ["closed"], true]);
    expect(v.agentKey.can).toBe("nothing: no agent key reaches a live venue");
    const page = await x.engine.view();
    expect([page.liveUsd, page.connectLive?.options.some((o) => o.connector === "live:exchange"), page.connectLive?.home]).toEqual([2450.5, true, x.home]);
  });

  it("nothing the account does reaches it: the owner cannot route through it, and neither can an agent the owner approved for it", async () => {
    const x = await boot();
    x.keyFile("credentials/okx/api-key.json", { ...KEY, password: "made-up-passphrase" });
    summary(await x.connect("okx", "live:exchange:okx"));
    await x.own({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: START + 30 * DAY });
    await x.own({ type: "approveSpend", agent: cc.address, scope: "venues", allow: "okx,hyperliquid,metamask", perPayment: "500", budget: "2000", windowHours: 0, validUntil: START + 7 * DAY });
    const agent = refusal(await x.ag({ type: "agentSendAsset", destination: "self", sourceDex: "okx", destinationDex: "hyperliquid", token: "USDC", amount: "100", fromSubAccount: "", maxFee: "5" }));
    expect([agent.code, agent.message]).toEqual(["E_VENUE_RAIL_CLOSED", "OKX: a live venue, connected read-only: the account reads it and sends it nothing"]);
    const planned = await x.engine.resolve({ destination: "self", sourceDex: "metamask", destinationDex: "okx", token: "USDC", amount: "100" }, "owner");
    expect(isRefusal(planned) ? planned.code : planned.route.access).toBe("closed");
    expect(code(await x.ag({ type: "agentSwap", venue: "okx", sell: "USDT", buy: "USDC", amount: "50", minReceive: "49" }))).toBe("E_VENUE_RAIL_CLOSED");
    // what OKX says about the key, in its own field
    expect((await x.venue("okx"))!.via).toBe("OKX · unified exchange API · live · the venue says this credential can: read, trade");
    expect(x.made.okx!.calls.slice(0, 2)).toEqual(["fetchTime", "accountConfig"]);
  });

  it("unplugging brings the simulated venue back; a reset does too", async () => {
    const x = await boot();
    x.keyFile("credentials/binance/api-key.json");
    summary(await x.connect("binance", "live:exchange:binance"));
    expect(code(await x.connect("binance", "live:exchange:binance"))).toBe("E_ACCOUNT_BAD_ACTION");
    expect(summary(await x.own({ type: "disconnectVenue", venue: "binance" }))).toBe("Binance disconnected: the account no longer reads the real venue, and the simulated one is back. The key at the venue is untouched: delete it there");
    const back = (await x.venue("binance"))!;
    expect([back.usd, back.live, back.plugged, back.in.access]).toEqual([28525, undefined, undefined, "agent"]);
    // the simulated venue the account opened with still cannot be unplugged
    expect(code(await x.own({ type: "disconnectVenue", venue: "binance" }))).toBe("E_ACCOUNT_BAD_ACTION");
    summary(await x.connect("binance", "live:exchange:binance"));
    x.svc.reset();
    expect((await x.venue("binance"))!.usd).toBe(28525);
  });

  it("an exchange that is not on the account yet is added, and unplugging removes it", async () => {
    const x = await boot();
    x.keyFile("credentials/kraken-main/api-key.json");
    const said = summary(await x.connect("kraken-main", "live:exchange:kraken", "", "Kraken · main"));
    expect(said).toContain("Kraken · main connected live · $2,200.50 there now · connected · this exchange has no call that says what a key may do: its first refusal will · read only: this server was started without real-money writes");
    expect(said).not.toContain("stands in");
    expect((await x.engine.view()).venues.map((v) => v.id)).toContain("kraken-main");
    summary(await x.own({ type: "disconnectVenue", venue: "kraken-main" }));
    expect((await x.engine.view()).venues.map((v) => v.id)).not.toContain("kraken-main");
  });

  it("asks the exchange at most once per half minute, and keeps the last good numbers when a refresh fails", async () => {
    const x = await boot();
    x.keyFile("credentials/binance/api-key.json");
    summary(await x.connect("binance", "live:exchange:binance"));
    const calls = x.made.binance!.calls;
    const reads = () => calls.filter((c) => c === "fetchBalance:default").length;
    await x.engine.view();
    await x.engine.view();
    expect(reads()).toBe(1);
    x.tick(31_000);
    await x.engine.view();
    expect(reads()).toBe(2);
    // the exchange stops answering: the page keeps what it last read, and says when that was and what went wrong
    x.made.binance!.fetchBalance = async () => {
      calls.push("fetchBalance:default");
      throw new Thrown("RequestTimeout", "binance GET https://api.example/ request timed out (12000 ms)");
    };
    x.tick(31_000);
    const v = (await x.venue("binance"))!;
    expect([v.usd, v.stale, typeof v.asOf]).toEqual([2450.5, "Binance could not be reached", "string"]);
    // and it is not hammered while it is down
    await x.engine.view();
    expect(reads()).toBe(3);
  });
});

describe("the key file", () => {
  it("is found in the home directory, readable by its owner only, and holds what the exchange needs; nothing in it is ever said back", async () => {
    const x = await boot();
    const missing = refusal(await x.connect("binance", "live:exchange:binance"));
    expect([missing.code, missing.message]).toEqual(["E_ACCOUNT_CREDENTIAL", `there is no key file at credentials/binance/api-key.json. Create it as ${join(x.home, "credentials/binance/api-key.json")} — {"apiKey": "…", "secret": "…"} (OKX, KuCoin and Bitget also need "password": the API passphrase) — then: chmod 600 on the file`]);

    x.keyFile("credentials/binance/api-key.json", KEY, 0o644);
    const open = refusal(await x.connect("binance", "live:exchange:binance"));
    expect([open.code, open.message]).toEqual(["E_ACCOUNT_CREDENTIAL", "credentials/binance/api-key.json can be read by other users of this machine (mode 644): run chmod 600 on it first"]);

    x.keyFile("credentials/binance/api-key.json", "{not json");
    expect(refusal(await x.connect("binance", "live:exchange:binance")).message).toContain("is not JSON");
    x.keyFile("credentials/binance/api-key.json", { apiKey: KEY.apiKey });
    expect(refusal(await x.connect("binance", "live:exchange:binance")).message).toContain('is missing "secret"');

    // OKX also wants the passphrase the key was made with
    x.keyFile("credentials/okx/api-key.json");
    const okx = refusal(await x.connect("okx", "live:exchange:okx"));
    expect([okx.code, okx.message]).toEqual(["E_ACCOUNT_CREDENTIAL", 'OKX also needs "password" in credentials/okx/api-key.json ("password" is the passphrase set when the API key was made)']);

    // a path that leaves the home directory, directly or through a link, is not read
    expect(refusal(await x.connect("binance", "live:exchange:binance", "../outside.json")).message).toContain("is outside it");
    const outside = join(mkdtempSync(join(tmpdir(), "outside-")), "key.json");
    homes.push(dirname(outside));
    writeFileSync(outside, JSON.stringify(KEY), { mode: 0o600 });
    mkdirSync(join(x.home, "credentials/linked"), { recursive: true });
    symlinkSync(outside, join(x.home, "credentials/linked/api-key.json"));
    expect(refusal(await x.connect("binance", "live:exchange:binance", "credentials/linked/api-key.json")).message).toBe("credentials/linked/api-key.json is a link to a file outside the home directory: not read");
  });

  it("can be checked before connecting: where it goes, whether it is private, which fields are missing — names, never values", async () => {
    const x = await boot();
    const check = (ref = "", needs: string[] = []) => x.svc.keyFile("exchange", "okx", ref, needs);
    expect(check()).toMatchObject({ ready: false, path: join(x.home, "credentials/okx/api-key.json"), fields: ["apiKey", "secret"] });
    expect(check().message).toContain("there is no key file at credentials/okx/api-key.json");
    // the exchange library says OKX also needs its passphrase: the check asks for it too
    x.keyFile("credentials/okx/api-key.json", KEY, 0o644);
    expect(check("", ["apiKey", "secret", "password"])).toMatchObject({ ready: false, mode: "644", fields: ["apiKey", "secret", "password"] });
    x.keyFile("credentials/okx/api-key.json", KEY);
    const short = check("", ["apiKey", "secret", "password"]);
    expect([short.ready, short.missing]).toEqual([false, ["password"]]);
    x.keyFile("credentials/okx/api-key.json", { ...KEY, password: "made-up-pass" });
    const ready = check("", ["apiKey", "secret", "password"]);
    expect([ready.ready, ready.message]).toEqual([true, "the key file is ready"]);
    expect(JSON.stringify([short, ready]).includes(KEY.secret)).toBe(false);
    // a connection that reads no key file says so; a path outside the home is not looked at
    expect(x.svc.keyFile("wallet", "w", "").ready).toBe(false);
    expect(check("../outside.json").message).toContain("is outside it");
  });

  it("stays in the file: not in the ledger, not in what the page reads, not in a refusal that quotes the exchange", async () => {
    const leaky: OpenExchange = async (id) =>
      fakeExchange(id, {
        async sapiGetAccountApiRestrictions() {
          throw new Thrown("AuthenticationError", `binance {"code":-2015,"msg":"Invalid API-key, IP, or permissions for action."} sent key ${KEY.apiKey} signature made with ${KEY.secret}`);
        },
      });
    const x = await boot({ open: leaky });
    x.keyFile("credentials/binance/api-key.json");
    const no = refusal(await x.connect("binance", "live:exchange:binance"));
    expect([no.code, no.message]).toEqual(["E_VENUE_UNAUTHORIZED", "Binance refused the key: it is wrong, it lacks the permission, or this machine's IP is not on its list (the exchange gives one answer for all three)"]);
    const everything = JSON.stringify([no, x.svc.rows(), await x.engine.view(), await x.svc.overview()]);
    expect([everything.includes(KEY.apiKey), everything.includes(KEY.secret)]).toEqual([false, false]);
    expect(JSON.stringify(no.native)).toContain("•••");

    const y = await boot();
    y.keyFile("credentials/binance/api-key.json");
    summary(await y.connect("binance", "live:exchange:binance"));
    const all = JSON.stringify([y.svc.rows(), await y.engine.view(), await y.svc.overview()]);
    expect([all.includes(KEY.apiKey), all.includes(KEY.secret), all.includes("credentials/binance/api-key.json")]).toEqual([false, false, true]);
  });
});

describe("what the exchange says no to", () => {
  const failing = (name: string, message: string): OpenExchange => async (id) =>
    fakeExchange(id, {
      async fetchTime() {
        throw new Thrown(name, message);
      },
    });

  it("a location it does not serve is its own rule: said as that, with nothing about getting around it", async () => {
    const x = await boot({ open: failing("ExchangeNotAvailable", 'binance GET https://api.example/api/v3/time 451  {"code":0,"msg":"Service unavailable from a restricted location according to \'b. Eligibility\' in the terms."}') });
    x.keyFile("credentials/binance/api-key.json");
    const no = refusal(await x.connect("binance", "live:exchange:binance"));
    expect([no.code, no.message]).toEqual(["E_VENUE_GEOBLOCKED", "Binance does not serve this location: that is its own rule, and the account does not look for a way around it"]);
    expect(JSON.stringify(no).toLowerCase()).not.toMatch(/vpn|proxy|testnet|another region/);
    // Bybit's edge says it differently, and the library files it under rate limits: it is still the venue's rule about where
    const y = await boot({ open: failing("RateLimitExceeded", "bybit GET https://api.example/v5/market/time 403 Forbidden { error:The Amazon CloudFront distribution is configured to block access from your country }") });
    y.keyFile("credentials/bybit/api-key.json");
    expect(code(await y.connect("bybit", "live:exchange:bybit"))).toBe("E_VENUE_GEOBLOCKED");
    // the simulated venue is still there, untouched
    expect((await x.venue("binance"))!.usd).toBe(28525);
  });

  it("a key without the permission, a rate limit, a network that does not answer, an exchange the library does not know", async () => {
    const tries: Array<[string, string, string]> = [
      ["PermissionDenied", 'kraken {"error":["EGeneral:Permission denied"]}', "E_VENUE_PERMISSION"],
      ["RateLimitExceeded", "binance 429 Too Many Requests", "E_VENUE_UNREACHABLE"],
      ["RequestTimeout", "binance request timed out", "E_VENUE_UNREACHABLE"],
      ["BadRequest", "binance something else", "E_VENUE_REJECTED"],
      // OKX says these with HTTP 200 and a code the library leaves as a plain ExchangeError
      ["ExchangeError", 'okx {"msg":"Your IP is barred from this service","code":"50121"}', "E_VENUE_GEOBLOCKED"],
      ["ExchangeError", 'okx {"msg":"API key doesn\'t have permission","code":"50120"}', "E_VENUE_PERMISSION"],
      ["ExchangeError", 'okx {"msg":"API key doesn\'t exist","code":"50119"}', "E_VENUE_UNAUTHORIZED"],
      // Binance's one code for a wrong key, a missing permission and an IP not on the list, even when the library calls it a rate limit
      ["DDoSProtection", 'binance {"code":-2015,"msg":"Invalid API-key, IP, or permissions for action."}', "E_VENUE_UNAUTHORIZED"],
    ];
    for (const [name, message, want] of tries) {
      const x = await boot({ open: failing(name, message) });
      x.keyFile("credentials/binance/api-key.json");
      expect([name, code(await x.connect("binance", "live:exchange:binance"))]).toEqual([name, want]);
    }
    const x = await boot();
    x.keyFile("credentials/nowhere/api-key.json");
    const unknown = refusal(await x.connect("nowhere", "live:exchange:nowhere"));
    expect([unknown.code, unknown.message]).toEqual(["E_WALLET_UNKNOWN_VENUE", 'the exchange library knows no exchange called "nowhere"']);
    expect(code(await x.connect("binance", "live:teleport"))).toBe("E_WALLET_UNKNOWN_VENUE");
    expect(code(await x.connect("Bad Id", "live:exchange:binance"))).toBe("E_ACCOUNT_BAD_ACTION");
  });

  it("only the owner connects a venue, live or not", async () => {
    const x = await boot();
    x.keyFile("credentials/binance/api-key.json");
    await x.own({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: START + 30 * DAY });
    const byAgent = await x.svc.exchange(await signOwner(cc, { type: "connectVenue", venue: "binance", connector: "live:exchange:binance", label: "", credentialRef: "", nonce: START + 999 } as OwnerAction));
    expect(code(byAgent)).toBe("E_ACCOUNT_OWNER_ONLY");
    expect(x.made.binance).toBeUndefined();
  });
});

describe("a wallet proves an address is the user's", () => {
  it("by signing the sentence the account wrote for it: that sentence, in time, by that address", async () => {
    const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
    const { WalletProofs, siweMessage } = await import("../../src/portfolio/live/proof.ts");
    let now = 5_000_000;
    const proofs = new WalletProofs(() => now);
    // a key made here and thrown away: nobody's wallet
    const wallet = privateKeyToAccount(generatePrivateKey());
    const other = privateKeyToAccount(generatePrivateKey());
    const page = { domain: "127.0.0.1:4820", uri: "http://127.0.0.1:4820/account" };

    const c = proofs.challenge(wallet.address.toLowerCase(), "OKX Wallet", page, 8453);
    if (isRefusal(c)) throw new Error(c.message);
    // EIP-4361, line for line: the page, the checksummed address, what is being agreed to, and the fields that bind it
    expect(c.message).toBe(siweMessage({ domain: "127.0.0.1:4820", address: wallet.address, statement: "Show this wallet's balances on my account page. Read-only: this is not a transaction and it lets nothing be moved.", uri: "http://127.0.0.1:4820/account", chainId: 8453, nonce: c.nonce, issuedAt: new Date(5_000_000).toISOString(), expirationTime: new Date(5_000_000 + 600_000).toISOString() }));
    expect(c.message.split("\n").slice(0, 2)).toEqual(["127.0.0.1:4820 wants you to sign in with your Ethereum account:", wallet.address]);
    expect(proofs.proven(wallet.address)).toBeUndefined();

    // someone else's signature over it; this wallet's signature over another sentence
    const wrongSigner = await proofs.prove(wallet.address, await other.signMessage({ message: c.message }));
    expect(isRefusal(wrongSigner) && wrongSigner.code).toBe("E_ACCOUNT_BAD_SIGNATURE");
    const wrongText = await proofs.prove(wallet.address, await wallet.signMessage({ message: c.message.replace("Read-only", "Read-write") }));
    expect(isRefusal(wrongText) && wrongText.code).toBe("E_ACCOUNT_BAD_SIGNATURE");
    expect(isRefusal(await proofs.prove(wallet.address, "not a signature"))).toBe(true);

    const ok = await proofs.prove(wallet.address, await wallet.signMessage({ message: c.message }));
    expect(ok).toMatchObject({ address: wallet.address, wallet: "OKX Wallet", at: 5_000_000, message: expect.stringContaining(wallet.address) });
    // the sentence and the signature are kept: a restarted account checks the proof again (account/restore.ts)
    expect(isRefusal(ok) ? "" : ok.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(proofs.proven(wallet.address.toLowerCase())?.wallet).toBe("OKX Wallet");
    // a sentence is signed once; a proof is good for ten minutes
    expect(isRefusal(await proofs.prove(wallet.address, await wallet.signMessage({ message: c.message })))).toBe(true);
    now += 601_000;
    expect(proofs.proven(wallet.address)).toBeUndefined();

    // a sentence left unsigned lapses
    const late = proofs.challenge(wallet.address, "OKX Wallet", page);
    if (isRefusal(late)) throw new Error(late.message);
    now += 601_000;
    const lapsed = await proofs.prove(wallet.address, await wallet.signMessage({ message: late.message }));
    expect(isRefusal(lapsed) && lapsed.code).toBe("E_ACCOUNT_EXPIRED");
    expect(isRefusal(proofs.challenge("0x1234", "x", page))).toBe(true);
  });
});

// ---- the venues with their own interfaces -------------------------------------------------------

const ADDRESS = "0x00000000000000000000000000000000000000a1";
const json = (body: unknown, status = 200) => ({ status, body, text: JSON.stringify(body) });

describe("a brokerage account at Alpaca", () => {
  it("is read with two GETs and the two key headers; cash and positions come back as the broker reports them, a coin by its base (BTCUSD is BTC)", async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const http: Http = async (url, init = {}) => {
      seen.push({ url, headers: init.headers ?? {} });
      if (init.headers?.["APCA-API-KEY-ID"] !== "made-up-id") return json({ code: 40110000, message: "request is not authorized" }, 401);
      if (url.endsWith("/v2/account")) return json({ status: "ACTIVE", cash: "5500.25", equity: "17000.25", buying_power: "11000.50" });
      if (url.endsWith("/v2/positions")) return json([{ symbol: "NVDA", qty: "20", market_value: "3000", current_price: "150", asset_class: "us_equity" }, { symbol: "BTCUSD", qty: "0.01", market_value: "620", asset_class: "crypto" }]);
      return json({ message: "not found" }, 404);
    };
    const x = await boot({ http });
    x.keyFile("credentials/alpaca/api-key.json", { keyId: "made-up-id", secret: "made-up-secret-0002" });
    // Alpaca is asked once, softly, whether this account has crypto wallets (GET /v2/wallets); its 404 is its answer, in its words
    const WALLETS = 'Alpaca has not enabled the Crypto Wallets API for this account (GET /v2/wallets: HTTP 404, "not found"): cash moves by ACH at Alpaca, and crypto wallets are enabled by Alpaca on request';
    expect(summary(await x.connect("alpaca", "live:alpaca"))).toBe(`Alpaca connected live · $9,120.25 there now · the venue says this credential can read, trade · an Alpaca key has no scopes: any key can place orders. ${WALLETS} · read only: ${WALLETS} · it stands in for the simulated one until it is unplugged`);
    expect(seen.map((r) => r.url)).toEqual(["https://api.alpaca.markets/v2/account", "https://api.alpaca.markets/v2/positions", "https://api.alpaca.markets/v2/wallets"]);
    expect(seen[0]!.headers).toMatchObject({ "APCA-API-KEY-ID": "made-up-id", "APCA-API-SECRET-KEY": "made-up-secret-0002" });
    const v = (await x.venue("alpaca"))!;
    expect([v.frontLine, v.live, v.watchOnly]).toEqual(["Stocks", true, "Live · read-only"]);
    expect(v.holdings.map((h) => [h.asset, h.amount, h.usd, h.note])).toEqual([["USD", 5500.25, 5500.25, "cash"], ["NVDA", 20, 3000, "stocks"], ["BTC", 0.01, 620, "crypto"]]);

    // a paper account is a different host; a key the broker does not know is the broker's no
    const y = await boot({ http });
    y.keyFile("credentials/alpaca/api-key.json", { keyId: "made-up-id", secret: "s3cret-value-1", paper: "true" });
    expect(summary(await y.connect("alpaca", "live:alpaca"))).toContain("Alpaca · paper connected live");
    const z = await boot({ http });
    z.keyFile("credentials/alpaca/api-key.json", { keyId: "someone-else", secret: "made-up-secret-0003" });
    const no = refusal(await z.connect("alpaca", "live:alpaca"));
    expect([no.code, no.message, JSON.stringify(no).includes("made-up-secret-0003")]).toEqual(["E_VENUE_UNAUTHORIZED", "Alpaca does not accept this key", false]);
  });
});

describe("a Kalshi account", () => {
  it("signs each request the way Kalshi checks it — timestamp, method, path with its prefix and without its query — with an RSA or an Ed25519 key", async () => {
    const { generateKeyPairSync, verify, constants } = await import("node:crypto");
    for (const type of ["rsa", "ed25519"] as const) {
      // a key pair made here and thrown away
      const pair = type === "rsa" ? generateKeyPairSync("rsa", { modulusLength: 2048 }) : generateKeyPairSync("ed25519");
      const checked: string[] = [];
      const http: Http = async (url, init = {}) => {
        const h = init.headers ?? {};
        const path = new URL(url).pathname;
        const text = Buffer.from(`${h["KALSHI-ACCESS-TIMESTAMP"]}GET${path}`);
        const sig = Buffer.from(h["KALSHI-ACCESS-SIGNATURE"] ?? "", "base64");
        const ok = type === "rsa" ? verify("sha256", text, { key: pair.publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }, sig) : verify(null, text, pair.publicKey, sig);
        checked.push(`${path}${new URL(url).search}:${ok}`);
        if (!ok || h["KALSHI-ACCESS-KEY"] !== "made-up-key-id") return json({ error: "unauthorized" }, 401);
        if (path.endsWith("/portfolio/balance")) return json({ balance: 61025, portfolio_value: 9000 });
        // the held markets, for what the positions are worth now: Kalshi reports only what they cost
        if (path.endsWith("/markets")) return json({ markets: [{ ticker: "KXBTC-26DEC", status: "active", yes_bid_dollars: "0.6900", yes_ask_dollars: "0.7100", last_price_dollars: "0.7000", result: "" }, { ticker: "FED-DEC-HIKE25", status: "active", yes_bid_dollars: "0.2400", yes_ask_dollars: "0.2600", last_price_dollars: "0.2500", result: "" }], cursor: "" });
        if (new URL(url).searchParams.get("cursor") === "next") return json({ market_positions: [{ ticker: "FED-DEC-HIKE25", position_fp: "-40.00", market_exposure_dollars: "12.40" }], cursor: "" });
        return json({ market_positions: [{ ticker: "KXBTC-26DEC", position_fp: "150.00", market_exposure_dollars: "97.50" }, { ticker: "FLAT", position_fp: "0.00", market_exposure_dollars: "0" }], cursor: "next" });
      };
      const x = await boot({ http });
      x.keyFile("credentials/kalshi/api-key.json", { keyId: "made-up-key-id" });
      x.keyFile("credentials/kalshi/private-key.pem", pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString());
      const said = summary(await x.connect("kalshi", "live:kalshi"));
      expect(said).toContain("Kalshi connected live · $745.25 there now");
      expect(checked).toEqual(["/trade-api/v2/portfolio/balance:true", "/trade-api/v2/portfolio/positions?limit=200:true", "/trade-api/v2/portfolio/positions?limit=200&cursor=next:true", "/trade-api/v2/markets?tickers=KXBTC-26DEC,FED-DEC-HIKE25&limit=2:true"]);
      const v = (await x.venue("kalshi"))!;
      // cash in dollars from cents; a negative position is a NO; a position is worth its market's price now (NO's is 1 − YES's), and what it
      // cost — all Kalshi reports for it — is said beside
      expect(v.holdings.map((h) => [h.asset, h.amount, h.usd, h.note])).toEqual([["USD", 610.25, 610.25, "cash"], ["KXBTC-26DEC:YES", 150, 105, "at market · cost $97.50"], ["FED-DEC-HIKE25:NO", 40, 30, "at market · cost $12.40"]]);
    }
  });

  it("needs its private key where the key file says, kept as carefully as the key file", async () => {
    const x = await boot();
    x.keyFile("credentials/kalshi/api-key.json", { keyId: "made-up-key-id" });
    expect(refusal(await x.connect("kalshi", "live:kalshi")).message).toContain("there is no key file at credentials/kalshi/private-key.pem");
    x.keyFile("credentials/kalshi/private-key.pem", "not a key");
    expect(refusal(await x.connect("kalshi", "live:kalshi")).message).toBe("Kalshi's private key is not a PEM private key this machine can read");
    x.keyFile("credentials/kalshi/private-key.pem", "whatever", 0o640);
    expect(refusal(await x.connect("kalshi", "live:kalshi")).message).toContain("can be read by other users of this machine (mode 640)");
  });
});

describe("venues read by address", () => {
  it("a wallet: dollar stablecoins and each chain's own coin, from the chains; a chain that does not answer is named, not fatal", async () => {
    const chain = fakeChain({ "Base:USDC": 210, "Arbitrum:USDC": 640, Ethereum: 0.25, "BNB Chain": 2 }, { down: ["Polygon"] });
    const x = await boot({ chain });
    const said = summary(await x.connect("wallet-0000a1", "live:wallet", ADDRESS, "OKX Wallet"));
    expect(said).toBe("OKX Wallet connected live · $2,550.00 there now · watched, not proven yours: nobody signed for it · dollar stablecoins and each chain's own coin on Ethereum, Optimism, BNB Chain, Polygon, Base, Arbitrum, Robinhood Chain, and Robinhood's Stock Tokens and the best-known Ondo Stocks and xStocks (no answer this time: Polygon; Robinhood's Stock Token list did not answer) · read only: this server was started without real-money writes");
    const v = (await x.venue("wallet-0000a1"))!;
    expect([v.frontLine, v.live, v.watchOnly, v.in.access, v.out.access]).toEqual(["On-chain", true, "Live · read-only", "closed", "closed"]);
    expect(v.holdings.map((h) => [h.asset, h.amount, h.usd, h.note])).toEqual([["BNB", 2, 1200, "BNB Chain"], ["USDC", 640, 640, "Arbitrum"], ["ETH", 0.25, 500, "Ethereum"], ["USDC", 210, 210, "Base"]]);
    // an agent the owner approved for it still cannot send it anything: it is not a venue money moves through
    await x.own({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: START + 30 * DAY });
    await x.own({ type: "approveSpend", agent: cc.address, scope: "venues", allow: "metamask,wallet-0000a1", perPayment: "500", budget: "2000", windowHours: 0, validUntil: START + 7 * DAY });
    expect(code(await x.ag({ type: "agentSendAsset", destination: "self", sourceDex: "metamask", destinationDex: "wallet-0000a1", token: "USDC", amount: "50", fromSubAccount: "", maxFee: "5" }))).toBe("E_VENUE_RAIL_CLOSED");

    expect(code(await x.connect("wallet-bad", "live:wallet", "0x1234"))).toBe("E_ACCOUNT_BAD_ACTION");
    const dark = await boot({ chain: fakeChain({}, { down: ["Ethereum", "Optimism", "BNB Chain", "Polygon", "Base", "Arbitrum", "Robinhood Chain"] }) });
    expect(code(await dark.connect("wallet-0000a1", "live:wallet", ADDRESS))).toBe("E_VENUE_UNREACHABLE");
  });

  it("a wallet that signed the account's sentence is shown as the user's own", async () => {
    const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
    const mine = privateKeyToAccount(generatePrivateKey());
    const x = await boot({ chain: fakeChain({ "Base:USDC": 12 }) });
    const c = x.svc.proofs.challenge(mine.address, "Binance Wallet", { domain: "127.0.0.1:4820", uri: "http://127.0.0.1:4820/account" });
    if (isRefusal(c)) throw new Error(c.message);
    await x.svc.proofs.prove(mine.address, await mine.signMessage({ message: c.message }));
    const said = summary(await x.connect("wallet-mine", "live:wallet", mine.address));
    expect(said).toContain("Binance Wallet connected live · $12.00 there now · proven yours: Binance Wallet signed for it");
    expect((await x.venue("wallet-mine"))!.name).toBe("Binance Wallet");
  });

  it("Hyperliquid: the perps ledger and the spot ledger, as the venue reports them for the address", async () => {
    const asked: string[] = [];
    const http: Http = async (url, init = {}) => {
      const body = JSON.parse(init.body ?? "{}") as { type: string; user: string };
      asked.push(`${init.method} ${url} ${body.type} ${body.user}`);
      if (body.type === "clearinghouseState") return json({ marginSummary: { accountValue: "1500.5", totalMarginUsed: "300.0" }, withdrawable: "1200.5", assetPositions: [] });
      return json({ balances: [{ coin: "USDC", token: 0, total: "500.0", hold: "0.0" }, { coin: "HYPE", token: 150, total: "2.5", hold: "0" }, { coin: "PURR", token: 1, total: "0.0", hold: "0" }] });
    };
    const x = await boot({ http });
    const said = summary(await x.connect("hyperliquid", "live:hyperliquid", ADDRESS));
    expect(said).toContain("Hyperliquid connected live · $2,100.50 there now · watched, not proven yours");
    expect(asked).toEqual(["POST https://api.hyperliquid.xyz/info clearinghouseState 0x00000000000000000000000000000000000000A1", "POST https://api.hyperliquid.xyz/info spotClearinghouseState 0x00000000000000000000000000000000000000A1", "POST https://api.hyperliquid.xyz/info userAbstraction 0x00000000000000000000000000000000000000A1"]);
    expect((await x.venue("hyperliquid"))!.holdings.map((h) => [h.asset, h.amount, h.usd, h.note])).toEqual([["USDC", 1500.5, 1500.5, "perps · 1200.50 withdrawable"], ["USDC", 500, 500, "spot"], ["HYPE", 2.5, 100, "spot"]]);
    // a unified account: the perps ledger draws on the spot balances, so its value is the same money again and is not added to them
    const unified: Http = async (url, init = {}) => {
      const body = JSON.parse(init.body ?? "{}") as { type: string };
      if (body.type === "userAbstraction") return json("unifiedAccount");
      return http(url, init);
    };
    const u = await boot({ http: unified });
    expect(summary(await u.connect("hyperliquid", "live:hyperliquid", ADDRESS))).toContain("Hyperliquid connected live · $600.00 there now");
    expect((await u.venue("hyperliquid"))!.holdings.map((h) => [h.asset, h.amount, h.note])).toEqual([["USDC", 500, "spot · one account with the perps (unified)"], ["HYPE", 2.5, "spot · one account with the perps (unified)"]]);
    // what the venue answers when it will not serve the caller is the venue's own rule
    const blocked = await boot({ http: async () => json({ error: "restricted jurisdiction" }, 403) });
    const no = refusal(await blocked.connect("hyperliquid", "live:hyperliquid", ADDRESS));
    expect([no.code, no.message]).toEqual(["E_VENUE_GEOBLOCKED", "Hyperliquid does not serve this location: that is its own rule, and the account does not look for a way around it"]);
  });

  it("Polymarket: positions from its data API page by page, each named as an order there names it (<slug>:<outcome>, its question beside it) where the row gives its slug; cash from the token at the same address", async () => {
    const urls: string[] = [];
    const http: Http = async (url) => {
      urls.push(url);
      return new URL(url).searchParams.get("cursor") ? json({ data: [{ title: "Government shutdown by year end", outcome: "No", current_size: 80, current_price: 1, current_value: 80, redeemable: true }], pagination: { next_cursor: null } }) : json({ data: [{ title: "Fed hikes 25 bps in December", slug: "fed-hikes-25-bps-in-december", outcome: "Yes", current_size: 600, current_price: 0.74, current_value: 444, status: "OPEN" }, { title: "Closed out", outcome: "Yes", current_size: 0, current_value: 0 }], pagination: { next_cursor: "p2" } });
    };
    const chain = fakeChain({ "Polygon:pUSD": 150.5 });
    const x = await boot({ http, chain });
    expect(summary(await x.connect("polymarket", "live:polymarket", ADDRESS))).toContain("Polymarket connected live · $674.50 there now");
    expect(urls).toEqual(["https://data-api.polymarket.com/v2/positions?user=0x00000000000000000000000000000000000000A1&limit=200", "https://data-api.polymarket.com/v2/positions?user=0x00000000000000000000000000000000000000A1&limit=200&cursor=p2"]);
    expect((await x.venue("polymarket"))!.holdings.map((h) => [h.asset, h.amount, h.usd, h.note])).toEqual([["fed-hikes-25-bps-in-december:Yes", 600, 444, "Fed hikes 25 bps in December · open"], ["pUSD", 150.5, 150.5, "cash · Polygon"], ["Government shutdown by year end · No", 80, 80, "redeemable"]]);
    expect(chain.asked).toContain("tokens:0x00000000000000000000000000000000000000A1:Polygon:pUSD");
  });

  it("Ondo: the fund's tokens at the address, priced by Ondo's own on-chain oracle — and not valued at nothing when the oracle does not answer", async () => {
    const oracle = "0x9cad45a8bf0ed41ff33074449b357c7a1fab4094";
    const chain = fakeChain({ "Ethereum:OUSG": 45.5, "Ethereum:USDY": 100 }, { uint: { [oracle]: 110_420000000000000000n, "0x87b126e5518b6a1bb8465779b4607c45c643df90": 1_090000000000000000n } });
    const x = await boot({ chain });
    expect(summary(await x.connect("ondo", "live:ondo", ADDRESS))).toContain("Ondo · OUSG connected live · $5,133.11 there now");
    expect((await x.venue("ondo"))!.holdings.map((h) => [h.asset, h.amount, h.usd, h.note])).toEqual([["OUSG", 45.5, 5024.11, "Ethereum"], ["USDY", 100, 109, "Ethereum"]]);
    expect(chain.asked.filter((a) => a.startsWith("uint"))).toEqual(["uint:Ethereum:getAssetPrice", "uint:Ethereum:getPrice"]);

    // the oracle's read refused (an endpoint rate-limiting this address answers a revert's "nothing"): a fund held is not worth $0 — it is
    // shown with no price this time, and the read says so (stale, asked again soon)
    const silent = await boot({ chain: fakeChain({ "Ethereum:OUSG": 45.5 }) });
    expect(summary(await silent.connect("ondo", "live:ondo", ADDRESS))).toContain("Ondo · OUSG connected live");
    expect((await silent.venue("ondo"))!.holdings.map((h) => [h.asset, h.amount, h.note])).toEqual([["OUSG", 45.5, "Ethereum · no price"]]);
  });
});
