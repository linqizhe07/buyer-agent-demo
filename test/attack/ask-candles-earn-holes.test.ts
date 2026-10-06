/** Attacks on three of the wallet's contracts:
 *
 *   answerAsk       only the owner declines an ask: an agent key, a stranger, a device not let in are refused; a decline grants nothing,
 *                   is taken once (a replay is the first answer, and after a restart it is refused), and lapses from the agent's view
 *                   after a day
 *   candles         the venue and the symbol of a price history never reach a host they name: a venue is an id the account knows, a
 *                   symbol plain text that a public source only puts, encoded, in a fixed host's path or query — or refuses
 *   earn counted    money in an earn product counts once: not again as Kraken's `<ASSET>.B` line or a vault's shares in a wallet, not
 *                   zero when the venue's earn blinks, and the ready money beside it is never taken for it
 *
 * Every venue, the network and the chain are stand-ins; nothing leaves the process. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isRefusal, type Refusal } from "../../src/core/errors.ts";
import { no } from "../../src/portfolio/refuse.ts";
import { AGENT_TYPES, malformed, signAgent, signDevice, signOwner, simKey, STEER_TYPES, MONEY_TYPES, type AgentAction, type OwnerAction, type SimKey } from "../../src/portfolio/account/sign.ts";
import { spendFor } from "../../src/portfolio/account/state.ts";
import type { EarnPosition, LiveEarner } from "../../src/portfolio/live/earn.ts";
import type { ExchangeClient, OpenExchange } from "../../src/portfolio/live/exchange.ts";
import { register, type LiveDeps } from "../../src/portfolio/live/index.ts";
import { exchangeTickers, kalshiPublic, polymarketPublic, PUBLIC_HOSTS } from "../../src/portfolio/live/public-markets.ts";
import type { LiveTrader, Market, OrderState } from "../../src/portfolio/live/trade.ts";
import type { Http, LiveBalance } from "../../src/portfolio/live/types.ts";
import { startPortfolioServer } from "../../src/portfolio/server.ts";
import { PortfolioService } from "../../src/portfolio/service.ts";

type NoNonce<T> = T extends unknown ? Omit<T, "nonce"> : never;
const START = Date.parse("2026-10-06T10:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const owner = simKey("owner");
const cc = simKey("agent:holes-claude-code");
const stranger = simKey("agent:holes-stranger");
const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));
const refusal = (r: unknown): Refusal => {
  if (!isRefusal(r)) throw new Error(`expected a refusal, got ${JSON.stringify(r).slice(0, 200)}`);
  return r;
};

// ---- the stand-in venues ------------------------------------------------------------------------------------------------------------

const BTC: Market = { symbol: "BTC/USD", name: "BTC/USD", kind: "spot", base: "BTC", quote: "USD", price: 62_000, bid: 61_990, ask: 62_010, minQty: 0.0001, qtyStep: 0.0001, priceStep: 0.1, open: true, types: ["market", "limit"] };
const trader: LiveTrader = {
  can: true,
  what: "spot",
  kinds: ["spot"],
  markets: async () => [BTC],
  market: async (symbol) => (symbol === BTC.symbol ? { ...BTC } : no("E_VENUE_REJECTED", { venue: "ex", message: `no market ${symbol}` })),
  place: async () => ({ ref: "r", status: "open", filledQty: 0, native: {} }) as OrderState,
  cancel: async () => ({ ref: "r", status: "canceled", filledQty: 0, native: {} }) as OrderState,
  status: async () => ({ ref: "r", status: "open", filledQty: 0, native: {} }) as OrderState,
  candles: async () => [{ t: START - HOUR, o: 1, h: 1, l: 1, c: 1 }],
};
/** what each stand-in venue holds, and what its earn says is in its products: the tests set these */
const world: Record<string, { balances: LiveBalance[]; earn: EarnPosition[] | Refusal }> = {};
const earnerOf = (venue: string): LiveEarner => ({
  can: true,
  what: "earn",
  products: async () => [],
  product: async () => no("E_VENUE_REJECTED", { venue, message: "none" }),
  positions: async () => world[venue]!.earn,
  supply: async () => no("E_VENUE_REJECTED", { venue, message: "not here" }),
  withdraw: async () => no("E_VENUE_REJECTED", { venue, message: "not here" }),
});
register({ kind: "holes-earn", label: "a venue that earns", needs: "key-file", example: "", venues: [], async open(req) {
  world[req.venue] ??= { balances: [], earn: [] };
  const read = async () => world[req.venue]!.balances;
  return { source: { name: req.label || req.venue, kind: "cex", reference: "standin", via: "a stand-in", probe: { can: ["read", "trade"], note: "" }, read, trader, readOnlyBecause: "the stand-in moves no money", earner: earnerOf(req.venue) }, first: await read(), summary: "connected" };
} });

/** a recording network and exchange library for the public sources: every URL asked, every symbol the library is handed */
const asked: string[] = [];
const recordingHttp: Http = async (url) => {
  asked.push(url);
  return { status: 404, body: { error: "not here" }, text: "not here" };
};
const handed: string[] = [];
const library: OpenExchange = async () =>
  ({
    id: "kraken",
    markets: { "BTC/USD": { symbol: "BTC/USD", base: "BTC", quote: "USD", spot: true } },
    loadMarkets: async () => ({}),
    fetchBalance: async () => ({}),
    fetchOHLCV: async (symbol: string) => (handed.push(symbol), [[START - HOUR, 1, 1, 1, 1, 1]]),
  }) as unknown as ExchangeClient;

/** one run of the real account on `home`; its clock can be moved */
async function run(home: string, at = 0) {
  let t = START + at;
  let n = 0;
  // a price feed that would price Kraken's USDC.B as a dollar: were the line not left out, the allocation would count twice
  const liveDeps: Partial<LiveDeps> = { clock: () => t, http: recordingHttp, price: async (a) => (a.toUpperCase() === "USDC.B" ? 1 : undefined), chain: { symbol: async () => "steakUSDC" } as never };
  const svc = await PortfolioService.create({ home, now: () => new Date(t).toISOString(), venues: "frontline", real: true, liveDeps, liveWrites: { capUsd: 1000, pairingCode: "K7QX-M2PA" }, publicMarkets: [exchangeTickers("kraken", { open: library, clock: () => t }), kalshiPublic({ http: recordingHttp, clock: () => t }), polymarketPublic({ http: recordingHttp, clock: () => t })], account: { owners: [{ id: owner.address, kind: "eoa" as const, label: "owner", addedAt: new Date(START).toISOString() }] } });
  await svc.restoring;
  const nonce = () => t + ++n;
  const own = async (a: NoNonce<OwnerAction>, by: SimKey = owner) => svc.exchange(await signOwner(by, { ...a, nonce: nonce() } as OwnerAction));
  const ag = async (a: NoNonce<AgentAction>, key: SimKey = cc) => svc.exchange(await signAgent(key, { ...a, nonce: nonce() } as AgentAction));
  return { svc, engine: svc.account!, own, ag, pass: (ms: number) => void (t += ms), nonce };
}
const fresh = () => {
  const h = mkdtempSync(join(tmpdir(), "ask-candles-earn-"));
  homes.push(h);
  return h;
};

describe("answerAsk: the owner's, and only the owner's", () => {
  it("is an owner action and a steering one, never money, never an agent's to sign", () => {
    expect([STEER_TYPES.has("answerAsk"), MONEY_TYPES.has("answerAsk"), (AGENT_TYPES as readonly string[]).includes("answerAsk")]).toEqual([true, false, false]);
    // an agent's ask cannot carry an answer in it
    expect(malformed({ type: "agentAsk", kind: "limit", venue: "", usd: "", text: "", decision: "decline", nonce: 1 } as never)).toMatch(/"decision" is not part of "agentAsk"/);
  });

  it("an agent key, a stranger and a device not let in cannot decline; the ask stays", async () => {
    const r = await run(fresh());
    await r.own({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: START + 30 * DAY });
    const asked = await r.ag({ type: "agentAsk", kind: "limit", venue: "", usd: "500", text: "a limit, please" });
    if (isRefusal(asked) || asked.kind !== "result") throw new Error("the ask was not taken");
    const id = (asked.result as { ask: { id: string } }).ask.id;
    // the agent signs the owner's action with its own key: the types do not overlap, and the door says so
    expect(refusal(await r.svc.exchange(await signOwner(cc, { type: "answerAsk", ask: id, decision: "decline", nonce: r.nonce() }))).code).toBe("E_ACCOUNT_OWNER_ONLY");
    expect(refusal(await r.svc.exchange(await signOwner(stranger, { type: "answerAsk", ask: id, decision: "decline", nonce: r.nonce() }))).code).toBe("E_ACCOUNT_UNKNOWN_SIGNER");
    // a browser that only asked to pair signs nothing
    const tablet = simKey("device:holes-tablet");
    expect(r.engine.pairDevice(tablet.jwk, "a tablet")).toMatchObject({ role: "pending" });
    const action: OwnerAction = { type: "answerAsk", ask: id, decision: "decline", nonce: r.nonce() };
    expect(refusal(await r.svc.exchange({ action, nonce: action.nonce, signature: signDevice(tablet, action) })).code).toBe("E_ACCOUNT_BAD_SIGNATURE");
    expect((await r.engine.view()).asks.map((x) => x.id)).toEqual([id]);
  });

  it("grants nothing, is taken once (a replay is the first answer; after a restart, refused), and lapses from view after a day", async () => {
    const home = fresh();
    const r = await run(home);
    await r.own({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: START + 30 * DAY });
    const asked = await r.ag({ type: "agentAsk", kind: "limit", venue: "", usd: "500", text: "a limit, please" });
    const id = ((asked as { result: { ask: { id: string } } }).result).ask.id;
    const envelope = await signOwner(owner, { type: "answerAsk", ask: id, decision: "decline", nonce: r.nonce() });
    const first = await r.svc.exchange(envelope);
    expect(first).toMatchObject({ ok: true, kind: "account" });
    expect(await r.svc.exchange(envelope)).toEqual(first);
    // no limit came of it, and the agent may ask again (a new ask)
    expect(refusal(spendFor(r.engine.state, cc.address, "trade", START)).code).toBe("E_MANDATE_NONE");
    const again = await r.ag({ type: "agentAsk", kind: "limit", venue: "", usd: "500", text: "please reconsider" });
    expect((again as { result: { ask: { id: string } } }).result.ask.id).not.toBe(id);
    let page = await r.engine.view();
    expect(page.declinedAsks.map((x) => x.id)).toEqual([id]);
    r.pass(DAY + 60_000);
    page = await r.engine.view();
    expect(page.declinedAsks).toEqual([]);
    // a later run: the declined ask is not brought back, and the same signed decline is not taken again
    const later = await run(home, DAY + 2 * 60_000);
    expect((await later.engine.view()).declinedAsks).toEqual([]);
    expect(refusal(await later.svc.exchange(envelope)).code).toBe("E_ACCOUNT_NONCE");
  });
});

describe("candles: the venue and the symbol never reach a host they name", () => {
  it("a venue is an id the account knows; a symbol is plain text — anything else is refused before anything is asked", async () => {
    const r = await run(fresh());
    asked.length = 0;
    for (const venue of ["http://169.254.169.254/latest", "../etc/passwd", "EX", "ex/../kalshi", "", "kraken@evil.com", "a".repeat(61)]) expect(refusal(await r.svc.candles(venue, "BTC/USD", "1h")).code, venue).toBe("E_ACCOUNT_BAD_ACTION");
    for (const symbol of ["BTC/USD\nHost: evil.com", "BTC\u0000", "BTC‮", "x".repeat(161), ""]) expect(refusal(await r.svc.candles("kraken", symbol, "1h")).code, JSON.stringify(symbol)).toBe("E_ACCOUNT_BAD_ACTION");
    expect(refusal(await r.svc.candles("kraken", "BTC/USD", "1h&x=1")).code).toBe("E_ACCOUNT_BAD_ACTION");
    expect(asked).toEqual([]);
  });

  it("a public source puts a symbol only in its fixed host's path or query, encoded — or refuses it without asking", async () => {
    const r = await run(fresh());
    asked.length = 0;
    handed.length = 0;
    // Kalshi's ticker and Polymarket's slug are read by pattern: these are refused, nothing asked
    for (const symbol of ["A@evil.com/x:YES", "KX/../..:YES", "https://evil.com:YES"]) expect(refusal(await r.svc.candles("kalshi", symbol, "1h")).code).toBe("E_ACCOUNT_BAD_ACTION");
    for (const symbol of ["x/../../evil:Yes", "UPPER:Yes", "@evil.com:Yes"]) expect(refusal(await r.svc.candles("polymarket", symbol, "1h")).code).toBe("E_ACCOUNT_BAD_ACTION");
    expect(asked).toEqual([]);
    // what is asked goes to the source's own host, the symbol in it encoded
    await r.svc.candles("polymarket", "http:Yes?x=1&y=#frag", "1h");
    await r.svc.candles("kalshi", "KX-ONE.T4:NO", "5m");
    expect(asked.length).toBe(2);
    for (const u of asked) {
      const url = new URL(u);
      expect([url.protocol, PUBLIC_HOSTS.includes(url.hostname), url.port, url.username]).toEqual(["https:", true, "", ""]);
    }
    expect(asked[0]).toBe("https://gamma-api.polymarket.com/markets/slug/http");
    // the exchange library is handed only a pair the exchange lists
    expect(refusal(await r.svc.candles("kraken", "BTC/USD@evil.com", "1h")).code).toBe("E_VENUE_REJECTED");
    expect((await r.svc.candles("kraken", "BTC/USD", "1h")) as { candles: unknown[] }).toMatchObject({ venue: "kraken", public: true });
    expect(handed).toEqual(["BTC/USD"]);
  });

  it("over HTTP too: a venue naming a host is a 409, and nothing is asked", async () => {
    const r = await run(fresh());
    const server = await startPortfolioServer({ port: 0, service: r.svc, snapshotMs: 0 });
    try {
      asked.length = 0;
      const res = await fetch(`${server.url}/api/account/candles?venue=${encodeURIComponent("http://169.254.169.254")}&symbol=${encodeURIComponent("BTC/USD")}&interval=1h`);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { refusal: Refusal }).refusal.code).toBe("E_ACCOUNT_BAD_ACTION");
      expect(asked).toEqual([]);
    } finally {
      await server.close();
    }
  });
});

describe("earn is counted once", () => {
  /** an account with one venue that earns, whose balance and earn the test sets; the page as it reads it */
  async function venueWith(balances: LiveBalance[], earn: EarnPosition[] | Refusal) {
    const r = await run(fresh());
    const venue = `v${Math.random().toString(36).slice(2, 8)}`;
    world[venue] = { balances, earn };
    const ok = await r.own({ type: "connectVenue", venue, connector: "live:holes-earn", label: "Earner", credentialRef: "" });
    if (isRefusal(ok)) throw new Error(ok.message);
    const read = async () => {
      const page = (await r.svc.accountView())!;
      return { page, v: page.venues.find((x) => x.id === venue)! };
    };
    return { r, venue, read };
  }

  it("Kraken's allocation is in its balance as USDC.B: counted as the allocation, not again", async () => {
    const { read } = await venueWith([{ asset: "USDC", amount: 100 }, { asset: "USDC.B", amount: 500 }], [{ product: "ESRFUO3-Q62XD-WIOIL7", id: "x", asset: "USDC", amount: 500, usd: 500 }]);
    const { page, v } = await read();
    expect(v.usd).toBe(600);
    expect(v.holdings.map((h) => h.asset).sort()).toEqual(["USDC", "USDC"]);
    expect(page.liveUsd).toBe(600);
    expect(page.totalUsd).toBe(600);
  });

  it("a vault's shares in a wallet's balance, by the symbol its chain gives: counted as the position, not again", async () => {
    const { read } = await venueWith([{ asset: "USDC", amount: 80, usd: 80, where: "Base" }, { asset: "steakUSDC", amount: 290, usd: 301.2, where: "Base" }], [{ product: "8453:0x7bfa7c4f149e7415b73bdedfe609237e29cbf34a", id: "x", asset: "USDC", amount: 301.2, usd: 301.2, chain: "Base" }]);
    expect((await read()).v.usd).toBe(381.2);
  });

  it("the ready money beside a position is never taken for it: USDC in the wallet and USDC in a vault are both counted", async () => {
    const { read } = await venueWith([{ asset: "USDC", amount: 300, usd: 300, where: "Base" }], [{ product: "8453:0x4e65fe4dba92790696d040ac24aa414708f5c0ab", id: "x", asset: "USDC", amount: 300, usd: 300, chain: "Base" }]);
    expect((await read()).v.usd).toBe(600);
  });

  it("a venue's earn that blinks keeps its last numbers, marked — neither zero nor twice — and a net worth point counts them once", async () => {
    const { r, venue, read } = await venueWith([{ asset: "USDT", amount: 300, usd: 300 }], [{ product: "savings:USDT", id: "x", asset: "USDT", amount: 1_000, usd: 1_000 }]);
    expect((await read()).v.usd).toBe(1_300);
    world[venue]!.earn = no("E_VENUE_UNREACHABLE", { venue, message: "did not answer" });
    // the balance is read again after thirty seconds, and the earn with it
    r.pass(31_000);
    const { v } = await read();
    expect(v.usd).toBe(1_300);
    expect(v.holdings.find((h) => h.class === "earn")).toMatchObject({ usd: 1_000, earn: { stale: true }, note: expect.stringContaining("the venue's last read") });
    const snap = await r.svc.snapshot();
    expect(snap).toMatchObject({ written: true });
    const curve = r.svc.history("1d");
    if (isRefusal(curve)) throw new Error(curve.message);
    expect(curve.points.at(-1)!.usd).toBe(1_300);
  });
});
