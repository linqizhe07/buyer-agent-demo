/** The wallet's reads over HTTP — Markets, Portfolio, the net worth curve, Receive, one asset, fresh quotes, Sell many, the agents — against
 * an account holding REAL accounts only, stand-in venues in their place and stand-in public market data: nothing leaves the process.
 * Also what keeps the venues from being hammered (answers kept, a venue that cannot be asked held back twenty seconds, two reads at once
 * per venue) and the net worth snapshots the server takes. */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { isRefusal, type Refusal } from "../../src/core/errors.ts";
import { no } from "../../src/portfolio/refuse.ts";
import type { Outcome } from "../../src/portfolio/account/exchange.ts";
import { networthPath } from "../../src/portfolio/account/networth.ts";
import { signAgent, signOwner, simKey, type AgentAction, type OwnerAction, type SimKey } from "../../src/portfolio/account/sign.ts";
import { register } from "../../src/portfolio/live/index.ts";
import { WalletProofs } from "../../src/portfolio/live/proof.ts";
import type { PublicSource } from "../../src/portfolio/live/public-markets.ts";
import type { Candle, LiveTrader, Market, MarketStats, OrderState, Position } from "../../src/portfolio/live/trade.ts";
import type { LiveWriter } from "../../src/portfolio/live/writes.ts";
import { startPortfolioServer, type PortfolioServerHandle } from "../../src/portfolio/server.ts";
import { PortfolioService } from "../../src/portfolio/service.ts";

type NoNonce<T> = T extends unknown ? Omit<T, "nonce"> : never;
const DAY = 86_400_000;
const owner = simKey("owner");
const cc = simKey("agent:claude-code");
const PROVEN = "0x1111111111111111111111111111111111111111";
const WATCHED = "0x2222222222222222222222222222222222222222";
const DEPOSIT = "0x3333333333333333333333333333333333333333";

// ---- the stand-in exchange: spot BTC and ETH, a BTC perpetual, 24 hours for BTC only, price history, a position, a deposit address ----
const BTC: Market = { symbol: "BTC/USDT", name: "BTC / USDT", kind: "spot", base: "BTC", quote: "USDT", price: 60_000, bid: 59_990, ask: 60_010, minQty: 0.0001, qtyStep: 0.0001, priceStep: 0.1, open: true, types: ["market", "limit"], changePct24h: 2.5, volumeUsd24h: 5e9 };
const ETH: Market = { symbol: "ETH/USDT", name: "ETH / USDT", kind: "spot", base: "ETH", quote: "USDT", price: 3_000, bid: 2_999, ask: 3_001, minQty: 0.001, qtyStep: 0.001, priceStep: 0.01, open: true, types: ["market", "limit"] };
const PERP: Market = { symbol: "BTC/USDT:USDT", name: "BTC perpetual", kind: "perp", base: "BTC", quote: "USDT", price: 60_020, bid: 60_010, ask: 60_030, minQty: 1, qtyStep: 1, priceStep: 0.1, contractSize: 0.01, open: true, types: ["market", "limit"], reduceOnly: true, fundingRate: 0.0001 };
const BARS: Candle[] = [0, 1, 2].map((i) => ({ t: 1_700_000_000_000 + i * 3_600_000, o: 59_000 + i, h: 59_500 + i, l: 58_800 + i, c: 59_200 + i, v: 10 }));
const calls = { markets: 0, market: 0, stats: [] as Array<string[] | undefined>, candles: [] as string[], deposit: [] as string[], positions: 0 };
const exTrader: LiveTrader = {
  can: true,
  what: "spot and perpetuals",
  async markets(q) {
    calls.markets++;
    const all = [BTC, ETH, PERP];
    return q ? all.filter((m) => m.symbol.startsWith(q.toUpperCase())) : all;
  },
  async market(symbol) {
    calls.market++;
    const m = [BTC, ETH, PERP].find((x) => x.symbol === symbol);
    return m ? { ...m } : no("E_VENUE_REJECTED", { venue: "ex", message: `no market ${symbol}` });
  },
  async place(): Promise<OrderState> {
    return { ref: "r-1", status: "open", filledQty: 0, native: {} };
  },
  async cancel(ref) {
    return { ref, status: "canceled", filledQty: 0, native: {} };
  },
  async status(ref) {
    return { ref, status: "open", filledQty: 0, native: {} };
  },
  async positions(): Promise<Position[]> {
    calls.positions++;
    return [{ symbol: PERP.symbol, name: PERP.name, kind: "perp", side: "long", qty: 3, entryPrice: 58_000, markPrice: 60_000, usd: 1_800, unrealizedUsd: 60, native: {} }];
  },
  async stats(symbols) {
    calls.stats.push(symbols);
    return new Map<string, MarketStats>([["BTC/USDT", { price: 60_000, changePct24h: 2.5, volumeUsd24h: 5e9 }]]);
  },
  async candles(symbol, interval) {
    calls.candles.push(`${symbol}|${interval}`);
    return BARS;
  },
};
const exWriter: LiveWriter = {
  can: { withdraw: false, ledgers: [], transfer: false, swap: false, receive: true, send: false },
  async depositAddress(asset, network) {
    calls.deposit.push(`${asset}|${network}`);
    return { address: DEPOSIT };
  },
};
register({ kind: "standin-wallet-ex", label: "a stand-in exchange", needs: "key-file", example: "", venues: [], async open(req) {
  const first = [{ asset: "BTC", amount: 0.51237, usd: 30_742.2 }, { asset: "ETH", amount: 2, usd: 6_000 }, { asset: "USDT", amount: 1_000, usd: 1_000 }];
  return { source: { name: req.label || "Ex", kind: "cex", reference: "standin", via: "a stand-in", probe: { can: ["read", "trade"], note: "" }, read: async () => first, trader: exTrader, writer: exWriter }, first, summary: "connected" };
} });

// ---- the stand-in broker: shares; its well-known 24 hours do not include AAPL, asked by ticker they do; its positions it refuses to list
// (a refusal about that read alone: a venue that did not ANSWER would be held back whole for twenty seconds, markets and all) ----
const brokerTrader: LiveTrader = {
  can: true,
  what: "US stocks",
  async markets() {
    return [{ symbol: "AAPL", name: "Apple", kind: "stock", base: "AAPL", quote: "USD", price: 230, bid: 229.9, ask: 230.1, minQty: 1, qtyStep: 1, open: true, types: ["market"] }];
  },
  async market(symbol) {
    return symbol === "AAPL" ? { symbol: "AAPL", name: "Apple", kind: "stock", base: "AAPL", quote: "USD", price: 230, bid: 229.9, ask: 230.1, minQty: 1, qtyStep: 1, open: true, types: ["market"] } : no("E_VENUE_REJECTED", { venue: "brk", message: `no market ${symbol}` });
  },
  async place(): Promise<OrderState> {
    return { ref: "b-1", status: "open", filledQty: 0, native: {} };
  },
  async cancel(ref) {
    return { ref, status: "canceled", filledQty: 0, native: {} };
  },
  async status(ref) {
    return { ref, status: "open", filledQty: 0, native: {} };
  },
  async positions() {
    return no("E_VENUE_REJECTED", { venue: "brk", message: "Broker lists no positions for this key" });
  },
  async stats(symbols) {
    return symbols?.includes("AAPL") ? new Map<string, MarketStats>([["AAPL", { price: 230, change24h: 4.6 }]]) : new Map<string, MarketStats>([["SPY", { price: 600, changePct24h: 0.4 }]]);
  },
};
register({ kind: "standin-wallet-broker", label: "a stand-in broker", needs: "key-file", example: "", venues: [], async open(req) {
  const first = [{ asset: "AAPL", amount: 10, usd: 2_300, class: "equity" as const }];
  return { source: { name: req.label || "Broker", kind: "broker", reference: "standin", via: "a stand-in", probe: { can: ["read", "trade"], note: "" }, read: async () => first, trader: brokerTrader, readOnlyBecause: "the stand-in broker moves no money" }, first, summary: "connected" };
} });

// ---- two stand-in wallets: one proven the user's, one only watched ----
register({ kind: "standin-wallet-addr", label: "a stand-in wallet", needs: "address", example: "", venues: [], async open(req) {
  const first = [{ asset: "USDC", amount: 50, usd: 50, where: "Base" }];
  return { source: { name: req.label || "Wallet", kind: "agent-wallet", reference: req.reference, address: req.reference, via: "a stand-in", probe: { can: ["read"], note: "" }, read: async () => first, writer: { can: { withdraw: false, ledgers: [], transfer: false, swap: false, receive: true, send: "wallet" }, depositAddress: async () => ({ address: req.reference as `0x${string}` }) } }, first, summary: "connected" };
} });

// ---- the public market data: a venue not connected, the connected exchange's own public side, and tokens that are only read ----
const pub = { pubex: 0, shadow: 0, statsAsked: [] as Array<string[] | undefined> };
const publicMarkets: PublicSource[] = [
  {
    id: "pubex",
    name: "Pub Exchange",
    kind: "exchange",
    connectTo: "pubex",
    connector: "live:exchange:pubex",
    async listings() {
      pub.pubex++;
      return [{ symbol: "BTC/USD", name: "BTC / USD", kind: "spot", base: "BTC", quote: "USD", price: 60_050, open: true, types: [], changePct24h: 2.4, volumeUsd24h: 1e9 }];
    },
    async stats(symbols) {
      pub.statsAsked.push(symbols);
      return new Map<string, MarketStats>([["ETH/USD", { price: 3_000, changePct24h: -1.5 }]]);
    },
  },
  {
    id: "ex-public",
    name: "Ex (public)",
    kind: "exchange",
    connectTo: "ex",
    connector: "live:standin-wallet-ex",
    async listings() {
      pub.shadow++;
      return [];
    },
  },
  {
    id: "toks",
    name: "Tokens",
    kind: "tokens",
    connectTo: "nowhere",
    connector: "live:standin-wallet-ex",
    readOnly: "these tokens are only read here",
    async listings() {
      return [{ symbol: "NVDA", name: "NVIDIA token", kind: "token", base: "NVDA", quote: "USD", price: 180, open: true, types: [] }];
    },
  },
];

let home: string;
let svc: PortfolioService;
let server: PortfolioServerHandle;
let n = 0;
const nonce = () => Date.now() + ++n;
const own = async (a: NoNonce<OwnerAction>) => svc.exchange(await signOwner(owner, { ...a, nonce: nonce() } as OwnerAction));
const ag = async (a: NoNonce<AgentAction>, key: SimKey = cc) => svc.exchange(await signAgent(key, { ...a, nonce: nonce() } as AgentAction));
const ok = (o: Outcome | Refusal) => {
  if (isRefusal(o)) throw new Error(`${o.code}: ${o.message}`);
  return o;
};
const get = async (path: string): Promise<{ status: number; body: any }> => {
  const r = await fetch(`${server.url}${path}`);
  return { status: r.status, body: await r.json() };
};

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "account-wallet-api-"));
  const proofs = new WalletProofs();
  proofs.keep({ address: PROVEN, wallet: "Rabby", at: Date.now(), message: "the account's sentence", signature: "0x00" });
  svc = await PortfolioService.create({ home, venues: "frontline", real: true, liveWrites: { capUsd: 5_000, pairingCode: "K7QX-M2PA" }, publicMarkets, liveDeps: { http: async () => ({ status: 599, body: undefined, text: "" }), price: async () => undefined, proofs }, account: { owners: [{ id: owner.address, kind: "eoa", label: "owner", addedAt: new Date().toISOString() }] } });
  server = await startPortfolioServer({ port: 0, service: svc, snapshotMs: 3_600_000 });
  ok(await own({ type: "connectVenue", venue: "ex", connector: "live:standin-wallet-ex", label: "Ex", credentialRef: "" }));
  ok(await own({ type: "connectVenue", venue: "brk", connector: "live:standin-wallet-broker", label: "Broker", credentialRef: "" }));
  ok(await own({ type: "connectVenue", venue: "rabby", connector: "live:standin-wallet-addr", label: "Rabby", credentialRef: PROVEN }));
  ok(await own({ type: "connectVenue", venue: "watched", connector: "live:standin-wallet-addr", label: "Watched", credentialRef: WATCHED }));
}, 30_000);

afterAll(async () => {
  await server?.close();
  rmSync(home, { recursive: true, force: true });
});

describe("Markets: what there is to trade", () => {
  it("merges the connected venue and a public one into one row, marks the public one Connect to trade, and does not ask the connected venue's own public side", async () => {
    const r = await get("/api/account/explore");
    expect(r.status).toBe(200);
    const btc = r.body.items.find((i: { key: string }) => i.key === "coin:BTC");
    expect(btc.at.map((a: { venue: string; connected: boolean; public: boolean; canTrade: unknown }) => [a.venue, a.connected, a.public, a.canTrade])).toEqual(expect.arrayContaining([["ex", true, false, true], ["pubex", false, true, false]]));
    expect(btc.at.find((a: { venue: string }) => a.venue === "pubex").connectTo).toBe("pubex");
    expect(btc.volumeUsd24h).toBe(6e9);
    expect(r.body.items.some((i: { key: string }) => i.key === "perp:BTC")).toBe(true);
    // the tokens no connection trades are read even though their connector is the connected exchange's
    expect(r.body.items.find((i: { kind: string }) => i.kind === "rwa")?.at[0]).toMatchObject({ venue: "toks", public: true, canTrade: false });
    expect(pub.shadow).toBe(0);
    expect(r.body.movers.map((m: { key: string }) => m.key)).toContain("coin:BTC");
  });

  it("answers the same question from what it found for a while, and refuses a tab or a sort it does not have", async () => {
    const before = pub.pubex;
    await get("/api/account/explore");
    expect(pub.pubex).toBe(before);
    expect((await get("/api/account/explore?tab=crypto")).body.items.every((i: { tabs: string[] }) => i.tabs.includes("crypto"))).toBe(true);
    const badTab = await get("/api/account/explore?tab=nft");
    expect([badTab.status, badTab.body.refusal.code]).toEqual([409, "E_ACCOUNT_BAD_ACTION"]);
    expect((await get("/api/account/explore?sort=random")).status).toBe(409);
  });
});

describe("Portfolio: what is held", () => {
  it("rows by asset, each coin's and share's own 24 hours from whoever reports it, the ready dollars — and cost on request", async () => {
    const r = await get("/api/account/holdings");
    expect(r.status).toBe(200);
    const row = (key: string) => r.body.rows.find((x: { key: string }) => x.key === key);
    expect(row("crypto:BTC")).toMatchObject({ usd: 30_742.2, changePct24h: 2.5, changeFrom: { venue: "ex" } });
    // ETH: the exchange's 24 hours do not include it; the public tickers do
    expect(row("crypto:ETH")).toMatchObject({ changePct24h: -1.5, changeFrom: { venue: "pubex" } });
    expect(pub.statsAsked.at(-1)).toEqual(["ETH/USD", "ETH/USDT", "ETH/USDC"]);
    // AAPL: not among the broker's well-known markets; asked by its ticker it is, as a change in price (4.6 on 225.4)
    expect(row("equity:AAPL").changePct24h).toBeCloseTo(2.0408, 3);
    // the exchange's USDT, and each wallet's USDC (the watched one's too: it is owned, and it is said where it can go)
    expect(r.body.money).toMatchObject({ stableUsd: 1_100, readyUsd: 1_100 });
    expect(r.body.change24h.missing).toEqual([]);
    expect(r.body.cost).toBeUndefined();
    const withCost = await get("/api/account/holdings?cost=1");
    expect(withCost.body.positions).toMatchObject([{ venue: "ex", symbol: PERP.symbol, qty: 3 }]);
    expect(withCost.body.cost.find((c: { key: string }) => c.key === `position:ex:${PERP.symbol}`)).toMatchObject({ source: "venue" });
    expect(withCost.body.missing).toEqual(expect.arrayContaining([expect.objectContaining({ venue: "brk", part: "positions", code: "E_VENUE_REJECTED" })]));
  });

  it("positions at every venue that lists them when none is named, and the venues that could not be read", async () => {
    const r = await get("/api/account/positions");
    expect(r.status).toBe(200);
    expect(r.body.positions.map((p: { venue: string; symbol: string }) => `${p.venue}|${p.symbol}`)).toEqual([`ex|${PERP.symbol}`]);
    expect(r.body.missing).toMatchObject([{ venue: "brk", why: "Broker lists no positions for this key" }]);
    expect((await get("/api/account/positions?venue=ex")).body.positions).toHaveLength(1);
  });

  it("one asset: its row, every venue's price, its price history, its position, and what was paid", async () => {
    const r = await get("/api/account/asset?key=crypto:BTC&interval=1h");
    expect(r.status).toBe(200);
    expect(r.body.row.key).toBe("crypto:BTC");
    expect(r.body.compare.rows[0]).toMatchObject({ venue: "ex", symbol: "BTC/USDT" });
    expect(r.body.candles).toMatchObject({ venue: "ex", symbol: "BTC/USDT", interval: "1h", bars: BARS });
    expect(r.body.positions.map((p: { symbol: string }) => p.symbol)).toEqual([PERP.symbol]);
    expect(r.body.cost.map((c: { key: string }) => c.key)).toEqual(expect.arrayContaining(["crypto:BTC", `position:ex:${PERP.symbol}`]));
    // Markets' name for a coin is taken too; a key that is not one, or an interval there is none of, is refused
    expect((await get("/api/account/asset?key=coin:BTC")).body.key).toBe("crypto:BTC");
    expect((await get("/api/account/asset?key=BTC")).status).toBe(409);
    expect((await get("/api/account/asset?key=crypto:BTC&interval=4h")).status).toBe(409);
  });
});

describe("Receive, quotes, Sell many", () => {
  it("an exchange's own deposit address (asked once a minute at most); a proven wallet's own; none for a watched address or a venue sent nothing", async () => {
    const ex = await get("/api/account/receive?venue=ex&asset=usdc&network=Base");
    expect(ex.body).toMatchObject({ ok: true, venue: "ex", asset: "USDC", network: "Base", address: DEPOSIT });
    await get("/api/account/receive?venue=ex&asset=USDC&network=Base");
    expect(calls.deposit).toEqual(["USDC|Base"]);
    expect((await get("/api/account/receive?venue=rabby&asset=USDC&network=Arbitrum")).body).toMatchObject({ address: PROVEN, whose: "Rabby" });
    expect((await get("/api/account/receive?venue=watched&asset=USDC&network=Base")).body.refusal.code).toBe("E_ACCOUNT_DESTINATION");
    expect((await get("/api/account/receive?venue=brk&asset=USD&network=Base")).body.refusal.code).toBe("E_VENUE_RAIL_CLOSED");
    expect((await get("/api/account/receive?venue=ex&asset=USDC&network=Solana")).body.refusal.code).toBe("E_ACCOUNT_BAD_ACTION");
    expect((await get("/api/account/receive?venue=nope&asset=USDC&network=Base")).body.refusal.code).toBe("E_WALLET_ACCOUNT_UNKNOWN");
  });

  it("fresh prices for a few markets, each answered on its own; more than twelve is the service's refusal, a market without its venue a malformed request", async () => {
    const r = await get(`/api/account/quotes?pairs=${encodeURIComponent("ex|BTC/USDT,ex|NOPE/USDT")}&pair=${encodeURIComponent("brk|AAPL")}`);
    expect(r.status).toBe(200);
    expect(r.body.quotes.map((q: { symbol: string; market?: { price: number }; refusal?: { code: string } }) => [q.symbol, q.market?.price ?? q.refusal?.code])).toEqual([["BTC/USDT", 60_000], ["NOPE/USDT", "E_VENUE_REJECTED"], ["AAPL", 230]]);
    const many = await get(`/api/account/quotes?pairs=${Array.from({ length: 13 }, () => "ex|BTC/USDT").join(",")}`);
    expect([many.status, many.body.refusal?.code]).toEqual([409, "E_ACCOUNT_BAD_ACTION"]);
    expect((await get("/api/account/quotes?pairs=BTC/USDT")).status).toBe(400);
  });

  it("everything held that is not a dollar, with what selling it would sign: a sell down to the step, a close for a perpetual", async () => {
    const r = await get("/api/account/sellable");
    expect(r.status).toBe(200);
    const at = (key: string, venue: string) => r.body.items.find((i: { key: string; venue: string }) => i.key === key && i.venue === venue);
    expect(at("crypto:BTC", "ex")).toMatchObject({ action: "sell", symbol: "BTC/USDT", held: 0.51237, sellQty: 0.5123, price: 59_990, ready: true });
    expect(at("crypto:ETH", "ex")).toMatchObject({ action: "sell", symbol: "ETH/USDT", sellQty: 2, ready: true });
    expect(at("equity:AAPL", "brk")).toMatchObject({ action: "sell", symbol: "AAPL", sellQty: 10, ready: true });
    expect(at(`position:ex:${PERP.symbol}`, "ex")).toMatchObject({ action: "close", side: "long", sellQty: 3, ready: true });
    expect(r.body.items.some((i: { key: string }) => i.key.startsWith("stable:"))).toBe(false);
  });
});

describe("the agents, one by one", () => {
  it("each key's standing, its limits with what is left, its cards, the intents addressed to it and its asks", async () => {
    ok(await own({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: Date.now() + 30 * DAY }));
    ok(await own({ type: "approveSpend", agent: cc.address, scope: "trade", allow: "ex", perPayment: "500", budget: "2000", windowHours: 0, validUntil: Date.now() + 7 * DAY }));
    ok(await own({ type: "setIntent", id: "", agent: "*", venue: "ex", symbol: "BTC/USDT", side: "buy", usd: "100", text: "Buy a little BTC on dips", validUntil: Date.now() + DAY }));
    ok(await ag({ type: "agentAsk", kind: "limit", venue: "ex", usd: "5000", text: "a bigger budget" }));
    // Guard: the agent's order is a card, and its worth is held against the limit
    const card = ok(await ag({ type: "agentLiveOrder", venue: "ex", symbol: "BTC/USDT", side: "buy", orderType: "limit", qty: "0.001", usd: "", limitPrice: "59000" }));
    expect(card.kind).toBe("card");
    const r = await get("/api/account/agents");
    expect(r.status).toBe(200);
    const a = r.body.agents.find((x: { address: string }) => x.address === cc.address);
    expect(a).toMatchObject({ name: "Claude Code", status: "ok", limits: [{ scope: "trade", allow: ["ex"], perPaymentUsd: 500, budgetUsd: 2000, reservedUsd: 59, leftUsd: 1941 }] });
    expect(a.cards).toHaveLength(1);
    expect(a.intents.map((i: { text: string }) => i.text)).toEqual(["Buy a little BTC on dips"]);
    expect(a.asks.map((x: { kind: string }) => x.kind)).toEqual(["limit"]);
    expect(a.flights[0].request).toMatch(/BTC/);
    // the mode as every read wires it: guard (Guard) or open (Beast)
    expect(r.body.mode).toBe("guard");
  });
});

describe("the net worth curve", () => {
  it("has a point from the start and each connection and disconnection marked on it; a range it does not know is refused", async () => {
    ok(await own({ type: "disconnectVenue", venue: "watched" }));
    const marks = async () => (await get("/api/account/history?range=1d")).body.events.map((e: { kind: string; venue: string }) => `${e.kind}:${e.venue}`) as string[];
    for (let i = 0; i < 40 && !(await marks()).includes("disconnect:watched"); i++) await new Promise((r) => setTimeout(r, 50));
    const r = await get("/api/account/history?range=1d");
    expect(r.status).toBe(200);
    expect(r.body.events.map((e: { kind: string; venue: string }) => `${e.kind}:${e.venue}`)).toEqual(expect.arrayContaining(["connect:ex", "connect:brk", "connect:watched", "disconnect:watched"]));
    expect(r.body.events.find((e: { kind: string; venue: string }) => e.kind === "disconnect" && e.venue === "watched").usd).toBe(50);
    expect(r.body.points.length).toBeGreaterThan(0);
    expect(r.body.changeUsd).toBe(0);
    // every point says what the account has paid out to payees so far (none here): the change adds it back
    expect(r.body.paidOutUsd).toBe(0);
    expect((await get("/api/account/history?range=1y")).body.refusal.code).toBe("E_ACCOUNT_BAD_ACTION");
  });

  it("takes points on the timer and stops at close; 0 takes none, not even on a connection", async () => {
    const h = mkdtempSync(join(tmpdir(), "account-wallet-api-timer-"));
    try {
      const s = await PortfolioService.create({ home: h, venues: "frontline", real: true, publicMarkets: [], liveDeps: { http: async () => ({ status: 599, body: undefined, text: "" }), price: async () => undefined }, account: { owners: [{ id: owner.address, kind: "eoa", label: "owner", addedAt: new Date().toISOString() }] } });
      const off = await startPortfolioServer({ port: 0, service: s, snapshotMs: 0 });
      await s.exchange(await signOwner(owner, { type: "connectVenue", venue: "ex", connector: "live:standin-wallet-ex", label: "Ex", credentialRef: "", nonce: nonce() }));
      await off.close();
      expect(existsSync(networthPath(h))).toBe(false);
      const on = await startPortfolioServer({ port: 0, service: s, snapshotMs: 40 });
      await new Promise((r) => setTimeout(r, 300));
      await on.close();
      const after = readFileSync(networthPath(h), "utf8");
      expect(after.trim().split("\n").length).toBeGreaterThan(0);
      expect(JSON.parse(after.trim().split("\n")[0]!)).toMatchObject({ usd: 37_742.2, byVenue: { ex: 37_742.2 } });
      await new Promise((r) => setTimeout(r, 150));
      expect(readFileSync(networthPath(h), "utf8")).toBe(after);
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });
});

describe("without the account layer", () => {
  it("answers 404", async () => {
    const h = mkdtempSync(join(tmpdir(), "account-wallet-api-classic-"));
    const classic = await PortfolioService.create({ home: h, venues: "classic" });
    const srv = await startPortfolioServer({ port: 0, service: classic });
    try {
      for (const path of ["explore", "holdings", "history", "receive", "asset", "quotes?pairs=a|b", "sellable", "agents"]) expect((await fetch(`${srv.url}/api/account/${path}`)).status).toBe(404);
    } finally {
      await srv.close();
      rmSync(h, { recursive: true, force: true });
    }
  });
});

describe("what keeps the venues from being hammered", () => {
  it("a venue that cannot be asked is held back twenty seconds, its health says so, and at most two of its reads are on their way at once", async () => {
    let busy = 0;
    let most = 0;
    let asked = 0;
    const slow: LiveTrader = {
      ...exTrader,
      async markets(q) {
        busy++;
        most = Math.max(most, busy);
        await new Promise((r) => setTimeout(r, 30));
        busy--;
        return [{ ...BTC, symbol: `${q}/USDT`, base: q }];
      },
      async market() {
        asked++;
        return no("E_VENUE_UNREACHABLE", { venue: "slow", message: "Slow did not answer" });
      },
    };
    register({ kind: "standin-wallet-slow", label: "a slow venue", needs: "key-file", example: "", venues: [], async open() {
      return { source: { name: "Slow", kind: "cex", reference: "standin", via: "a stand-in", probe: { can: ["read", "trade"], note: "" }, read: async () => [], trader: slow, readOnlyBecause: "a stand-in" }, first: [], summary: "connected" };
    } });
    ok(await own({ type: "connectVenue", venue: "slow", connector: "live:standin-wallet-slow", label: "Slow", credentialRef: "" }));
    await Promise.all(["A", "B", "C", "D", "E"].map((q) => svc.liveMarkets("slow", q)));
    expect(most).toBe(2);
    expect(isRefusal(await svc.liveMarket("slow", "A/USDT"))).toBe(true);
    // past the three seconds a price is kept: still held back; past twenty, asked again
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 5_000);
      expect(isRefusal(await svc.liveMarket("slow", "A/USDT"))).toBe(true);
      expect(asked).toBe(1);
      vi.setSystemTime(Date.now() + 16_000);
      await svc.liveMarket("slow", "A/USDT");
      expect(asked).toBe(2);
    } finally {
      vi.useRealTimers();
    }
    const health = (await get("/api/account")).body.health.slow;
    expect(health).toMatchObject({ code: "E_VENUE_UNREACHABLE", message: "Slow did not answer" });
    expect(typeof health.lastFailAt).toBe("string");
    expect(typeof health.lastOkAt).toBe("string");
  });

  it("a refusal about the request itself is not kept: it is asked again; an answer is", async () => {
    const market = calls.market;
    await svc.liveMarket("ex", "NOPE/USDT");
    await svc.liveMarket("ex", "NOPE/USDT");
    expect(calls.market - market).toBe(2);
    const markets = calls.markets;
    await svc.liveMarkets("ex", "ZZ");
    await svc.liveMarkets("ex", "ZZ");
    expect(calls.markets - markets).toBe(1);
  });
});
