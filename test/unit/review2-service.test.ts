/** review2 · the service lens: the read side under a public source that refuses this location, a venue that is slow to say no, a venue
 * connected or disconnected while Markets is kept, a trader that throws, the routes' shapes, what a real account's overview says, and what
 * a write at a venue does to the reads kept of it.
 *
 * Every venue is a stand-in: nothing leaves the process, and no key exists in this file but the stand-in agent wallet's, made in a temporary
 * home. Each test asserts what the service PROMISES in its own words (service.ts: ReadCache "a venue that cannot be asked just now is not
 * asked again for twenty seconds", "an answer still on its way is waited for"; explore "what the connected venues list"; the routes'
 * `{ok:false, refusal}` shape; "a throw is a refusal too"; overview "the totals here are the ones /api/account and /holdings give"). */
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { get as httpGet } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Ledger } from "../../src/agent/ledger.ts";
import { isRefusal, type Refusal } from "../../src/core/errors.ts";
import { no } from "../../src/portfolio/refuse.ts";
import type { Outcome } from "../../src/portfolio/account/exchange.ts";
import { signOwner, simKey, type OwnerAction } from "../../src/portfolio/account/sign.ts";
import { BRIDGE_CHAINS } from "../../src/portfolio/live/bridge.ts";
import { CHAINS, STABLECOINS, type ChainReader } from "../../src/portfolio/live/chain.ts";
import type { EarnPosition, LiveEarner } from "../../src/portfolio/live/earn.ts";
import { register } from "../../src/portfolio/live/index.ts";
import type { PublicSource } from "../../src/portfolio/live/public-markets.ts";
import type { Candle, LiveTrader, Market, MarketStats, OrderState, Position } from "../../src/portfolio/live/trade.ts";
import { STABLES, type LiveSource } from "../../src/portfolio/live/types.ts";
import { startPortfolioServer, type PortfolioServerHandle } from "../../src/portfolio/server.ts";
import { PortfolioService } from "../../src/portfolio/service.ts";

type NoNonce<T> = T extends unknown ? Omit<T, "nonce"> : never;
const owner = simKey("owner");
const cc = simKey("agent:review2-service-cc");
const DAY = 86_400_000;

// ---- stand-in markets and traders ----------------------------------------------------------------------------------------------------
const BTC: Market = { symbol: "BTC/USDT", name: "BTC / USDT", kind: "spot", base: "BTC", quote: "USDT", price: 60_000, bid: 59_990, ask: 60_010, minQty: 0.0001, qtyStep: 0.0001, priceStep: 0.1, open: true, types: ["market", "limit"], changePct24h: 2.5, volumeUsd24h: 5e9 };
/** ETH carries no 24-hour figure of its own: the Portfolio asks the public tickers for it */
const ETH: Market = { symbol: "ETH/USDT", name: "ETH / USDT", kind: "spot", base: "ETH", quote: "USDT", price: 3_000, bid: 2_999, ask: 3_001, minQty: 0.001, qtyStep: 0.001, priceStep: 0.01, open: true, types: ["market", "limit"] };
const PERP: Market = { symbol: "ETH/USDT:USDT", name: "ETH perpetual", kind: "perp", base: "ETH", quote: "USDT", price: 3_000, bid: 2_999, ask: 3_001, minQty: 0.01, qtyStep: 0.01, priceStep: 0.1, open: true, types: ["market", "limit"], reduceOnly: true };

/** a trader over a fixed list, with any method replaced */
function stub(list: Market[], over: Partial<LiveTrader> = {}): LiveTrader {
  return {
    can: true,
    what: "a stand-in",
    async markets(q) {
      return q ? list.filter((m) => m.symbol.toUpperCase().startsWith(q.toUpperCase())) : list;
    },
    async market(symbol) {
      const m = list.find((x) => x.symbol === symbol);
      return m ? { ...m } : no("E_VENUE_REJECTED", { venue: "standin", message: `no market ${symbol}` });
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
    ...over,
  };
}

/** a connector kind the owner can connect: what the venue holds, the trader that speaks for it, and anything else its source carries */
function connector(kind: string, name: string, trader: LiveTrader, first: Array<{ asset: string; amount: number; usd: number }>, more: Partial<LiveSource> & { earner?: LiveEarner } = {}): void {
  register({ kind, label: name, needs: "key-file", example: "", venues: [], async open(req) {
    return { source: { name: req.label || name, kind: "cex", reference: "standin", via: "a stand-in", probe: { can: ["read", "trade"], note: "" }, read: async () => first, trader, readOnlyBecause: "a stand-in moves no money", ...more } as LiveSource, first, summary: "connected" };
  } });
}

// ---- the public market data: two venues that answer this location with their own rule, one that could be connected, and the tickers -----
const geo = { stats: 0, listings: 0 };
const geo2 = { listings: 0 };
const GEO_SAID = '{"code":0,"msg":"Service unavailable from a restricted location according to \'b. Eligibility\' in https://www.binance.com/en/terms."}';
const geoNo = (venue: string, name: string): Refusal => no("E_VENUE_GEOBLOCKED", { venue, message: `${name} does not serve this location: that is its own rule, and the account does not look for a way around it`, native: { status: 451, said: GEO_SAID } });
const BARS: Candle[] = Array.from({ length: 24 }, (_, i) => ({ t: Date.UTC(2026, 9, 5, i), o: 60_000 + i, h: 60_050 + i, l: 59_950 + i, c: 60_010 + i, v: 1 }));
/** every call the tickers answer: which symbols were asked */
const tickerCalls: string[][] = [];
const publicMarkets: PublicSource[] = [
  {
    id: "geo",
    name: "Geo Exchange",
    kind: "exchange",
    connectTo: "geo",
    connector: "live:exchange:geo",
    async listings() {
      geo.listings++;
      return geoNo("geo", "Geo Exchange");
    },
    async stats() {
      geo.stats++;
      return geoNo("geo", "Geo Exchange");
    },
    async candles() {
      geo.listings++;
      return geoNo("geo", "Geo Exchange");
    },
  },
  {
    id: "geo2",
    name: "Second Geo Exchange",
    kind: "exchange",
    connectTo: "geo2",
    connector: "live:exchange:geo2",
    async listings() {
      geo2.listings++;
      return geoNo("geo2", "Second Geo Exchange");
    },
  },
  {
    id: "pubex",
    name: "Pub Exchange",
    kind: "exchange",
    connectTo: "pubex",
    connector: "live:standin-review2-pubex",
    async listings() {
      return [{ symbol: "BTC/USD", name: "BTC / USD", kind: "spot", base: "BTC", quote: "USD", price: 60_050, open: true, types: [], changePct24h: 2.4, volumeUsd24h: 1e9 }];
    },
    async candles(symbol) {
      return symbol === "BTC/USD" ? BARS : no("E_VENUE_REJECTED", { venue: "pubex", message: `Pub Exchange lists no market ${symbol} priced in dollars` });
    },
  },
  {
    id: "tickers",
    name: "Tickers",
    kind: "exchange",
    connectTo: "tickers",
    connector: "live:exchange:tickers",
    async listings() {
      return [];
    },
    async stats(symbols) {
      tickerCalls.push([...(symbols ?? [])]);
      return new Map<string, MarketStats>((symbols ?? []).map((s) => [s, { price: 1, changePct24h: 1 }]));
    },
  },
];

let home: string;
let svc: PortfolioService;
let server: PortfolioServerHandle;
let n = 0;
const nonce = () => Date.now() + ++n;
const own = async (a: NoNonce<OwnerAction>) => svc.exchange(await signOwner(owner, { ...a, nonce: nonce() } as OwnerAction));
const ok = (o: Outcome | Refusal) => {
  if (isRefusal(o)) throw new Error(`${o.code}: ${o.message}`);
  return o;
};
const answer = <T,>(r: T | Refusal): T => {
  if (isRefusal(r)) throw new Error(`refused: ${r.code} ${r.message}`);
  return r;
};
const get = async (path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any; headers: Headers }> => {
  const r = await fetch(`${server.url}${path}`, { headers });
  return { status: r.status, body: r.status === 304 ? null : await r.json(), headers: r.headers };
};
const noNetwork = async () => ({ status: 599, body: undefined, text: "" });

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "review2-service-"));
  // the connected exchange: BTC with its own 24 hours, ETH without (so the public tickers are asked for ETH's)
  connector("standin-review2-ex", "Ex", stub([BTC, ETH], { async stats() {
    return new Map<string, MarketStats>([["BTC/USDT", { price: 60_000, changePct24h: 2.5, volumeUsd24h: 5e9 }]]);
  } }), [{ asset: "BTC", amount: 0.5, usd: 30_000 }, { asset: "ETH", amount: 2, usd: 6_000 }, { asset: "USDT", amount: 1_000, usd: 1_000 }]);
  svc = await PortfolioService.create({ home, venues: "frontline", real: true, liveWrites: { capUsd: 5_000, pairingCode: "K7QX-M2PA" }, publicMarkets, liveDeps: { http: noNetwork, price: async () => undefined }, account: { owners: [{ id: owner.address, kind: "eoa", label: "owner", addedAt: new Date().toISOString() }] } });
  server = await startPortfolioServer({ port: 0, service: svc, snapshotMs: 3_600_000 });
  ok(await own({ type: "connectVenue", venue: "ex", connector: "live:standin-review2-ex", label: "Ex", credentialRef: "" }));
}, 30_000);

afterAll(async () => {
  await server?.close();
  rmSync(home, { recursive: true, force: true });
});

describe("the twenty-second hold-back (service.ts ReadCache: a venue that cannot be asked just now is not asked again for twenty seconds)", () => {
  it("reaches the public tickers the Portfolio's 24-hour change is read from: a venue that answered 451 is not asked again on the next poll", async () => {
    const before = geo.stats;
    const first = answer(await svc.holdings());
    // the venue's rule is shown, in its own words, as missing
    expect(first.missing).toEqual(expect.arrayContaining([expect.objectContaining({ venue: "geo", code: "E_VENUE_GEOBLOCKED", part: "stats" })]));
    expect(geo.stats - before).toBe(1);
    // the page polls holdings every 8 to 20 seconds: each poll must not be another request to a venue that just said 451 (or 429)
    await svc.holdings();
    await svc.holdings();
    expect(geo.stats - before).toBe(1);
    // and a coin the tickers do speak for has its change
    expect(first.rows.find((r) => r.key === "crypto:ETH")).toMatchObject({ changePct24h: 1, changeFrom: { venue: "tickers" } });
  });

  it("reaches Markets: the two explores one page makes (limit 200 for Markets, 24 for Trade's picker) ask a venue that answered 451 once, not twice — and a venue that refused this location to any read is not asked for its listings either", async () => {
    const before = geo2.listings;
    const beforeGeo = geo.listings;
    const x = answer(await svc.explore({ limit: 200 }));
    answer(await svc.explore({ limit: 24 }));
    expect(geo2.listings - before).toBe(1);
    // Geo Exchange said 451 to the Portfolio's ticker read: a rule for this location holds for ten minutes, for every read of it
    expect(geo.listings - beforeGeo).toBe(0);
    // and Markets still says so, in the venue's own words
    expect(x.missing).toEqual(expect.arrayContaining([expect.objectContaining({ venue: "geo", code: "E_VENUE_GEOBLOCKED" }), expect.objectContaining({ venue: "geo2", code: "E_VENUE_GEOBLOCKED" })]));
  });

  it("holds a public source's price history back too: a geoblocked venue's candles are its refusal, with no request", async () => {
    const before = geo.listings + geo.stats;
    const r = await svc.candles("geo", "BTC/USD", "1h");
    expect(isRefusal(r) && r.code).toBe("E_VENUE_GEOBLOCKED");
    expect(geo.listings + geo.stats - before).toBe(0);
  });
});

describe("the quotes route", () => {
  it("refuses in one shape: too many markets and none at all are the same mistake, answered as the service's refusal", async () => {
    const none = await get("/api/account/quotes");
    const many = await get(`/api/account/quotes?pairs=${Array.from({ length: 13 }, () => "ex|BTC/USDT").join(",")}`);
    expect([none.status, none.body.refusal?.code]).toEqual([409, "E_ACCOUNT_BAD_ACTION"]);
    expect([many.status, many.body.refusal?.code]).toEqual([409, "E_ACCOUNT_BAD_ACTION"]);
  });
});

describe("the routes' query parameters", () => {
  it("a limit is digits: a hexadecimal or an exponent is malformed, and so is a parameter given twice", async () => {
    expect((await get("/api/account/explore?limit=0x10")).status).toBe(400);
    expect((await get("/api/account/explore?limit=1e2")).status).toBe(400);
    expect((await get("/api/account/explore?limit=24&limit=30")).status).toBe(400);
    expect((await get("/api/account/explore?tab=crypto&tab=now")).body.error).toMatch(/given more than once/);
    expect((await get("/api/account/candles?venue=pubex&venue=geo&symbol=BTC/USD")).status).toBe(400);
    expect((await get("/api/account/explore?limit=24")).status).toBe(200);
  });
});

describe("a trader that throws", () => {
  it("is a refusal to the page, never a 500 carrying the exception's text — for one market, for fresh quotes, and for Sell many as a whole", async () => {
    const X: Market = { ...BTC, symbol: "X/USDT", name: "X / USDT", base: "X", price: 20, bid: 19.9, ask: 20.1 };
    const thrower = stub([X], { async market() {
      throw new Error("ECONNRESET https://api.venue.example/v1/ticker?symbol=XUSDT&signature=deadbeef");
    } });
    connector("standin-review2-throws", "Thrower", thrower, [{ asset: "X", amount: 5, usd: 100 }]);
    ok(await own({ type: "connectVenue", venue: "thr", connector: "live:standin-review2-throws", label: "Thrower", credentialRef: "" }));
    const one = await get("/api/account/market?venue=thr&symbol=X/USDT");
    const quotes = await get(`/api/account/quotes?pairs=${encodeURIComponent("thr|X/USDT,ex|BTC/USDT")}`);
    const sellable = await get("/api/account/sellable");
    const seen = [one, quotes, sellable].map((r) => [r.status, JSON.stringify(r.body).includes("signature=deadbeef") ? "leaks the exception" : "clean"]);
    // every read answers 200 (a per-market refusal) or 409 (a refusal), and nothing of the exception's text is on the wire
    expect(seen).toEqual([
      [409, "clean"],
      [200, "clean"],
      [200, "clean"],
    ]);
    expect(one.body.refusal).toMatchObject({ code: "E_VENUE_UNREACHABLE", message: "Thrower answered in a way the account could not read" });
    // its health says so in the same words, with no exception text either
    const health = (await get("/api/account")).body.health.thr;
    expect(JSON.stringify(health)).not.toContain("deadbeef");
    expect(health.code).toBe("E_VENUE_UNREACHABLE");
  });
});

describe("a venue that is slow to say no", () => {
  it("is waited for while its first answer is on its way, then held back once it has said it cannot be asked: nothing more is asked of it for twenty seconds", async () => {
    const waiting: Array<(r: Market | Refusal) => void> = [];
    let asked = 0;
    const slow = stub([BTC, ETH], { market: () => {
      asked++;
      return new Promise<Market | Refusal>((resolve) => waiting.push(resolve));
    } });
    connector("standin-review2-slow", "Slow", slow, []);
    ok(await own({ type: "connectVenue", venue: "slow", connector: "live:standin-review2-slow", label: "Slow", credentialRef: "" }));
    const down = no("E_VENUE_UNREACHABLE", { venue: "slow", message: "Slow did not answer" });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const t0 = Date.now();
      const p1 = svc.liveMarket("slow", "BTC/USDT");
      expect(asked).toBe(1);
      // four seconds on, the first ask is still on its way (the venue takes ten to twelve seconds to time out): it is waited for, not
      // asked again — whatever the three seconds a price is kept
      vi.setSystemTime(t0 + 4_000);
      const p2 = svc.liveMarket("slow", "BTC/USDT");
      expect(asked).toBe(1);
      waiting[0]!(down);
      expect(isRefusal(await p1)).toBe(true);
      expect(isRefusal(await p2)).toBe(true);
      // the venue has now said it cannot be asked: by the service's own rule nothing more is asked of it for twenty seconds — not the
      // same market, not another
      vi.setSystemTime(t0 + 8_000);
      expect(isRefusal(await svc.liveMarket("slow", "BTC/USDT"))).toBe(true);
      vi.setSystemTime(t0 + 23_000);
      expect(isRefusal(await svc.liveMarket("slow", "ETH/USDT"))).toBe(true);
      expect(asked).toBe(1);
      // past the twenty seconds, it is asked again
      vi.setSystemTime(t0 + 25_000);
      const p5 = svc.liveMarket("slow", "BTC/USDT");
      expect(asked).toBe(2);
      waiting[1]!({ ...BTC });
      expect(answer(await p5).symbol).toBe("BTC/USDT");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Markets is kept thirty seconds", () => {
  const line = async () => {
    const x = answer(await svc.explore({ q: "BTC" }));
    return x.items.find((i) => i.key === "coin:BTC")?.at.find((a) => a.venue === "pubex");
  };

  it("says a venue the owner just connected is connected, not Connect to trade for thirty more seconds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      expect(await line()).toMatchObject({ connected: false, public: true, connectTo: "pubex" });
      connector("standin-review2-pubex", "Pub Exchange", stub([BTC]), [{ asset: "BTC", amount: 0.1, usd: 6_000 }]);
      ok(await own({ type: "connectVenue", venue: "pubex", connector: "live:standin-review2-pubex", label: "Pub Exchange", credentialRef: "" }));
      // the owner connected it: Markets says so now (the public listing of the same exchange is the connected venue's to speak for)
      expect(await line()).toMatchObject({ connected: true, public: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("says a venue the owner just disconnected is not connected, not connected for thirty more seconds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 31_000);
      expect(await line()).toMatchObject({ connected: true, public: false });
      ok(await own({ type: "disconnectVenue", venue: "pubex" }));
      expect(await line()).toMatchObject({ connected: false, public: true });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the Portfolio's 24 hours for many coins", () => {
  it("asks the public tickers in lots the tickers take (forty symbols), so every held coin gets its figure", async () => {
    const coins = Array.from({ length: 20 }, (_, i) => `C${String(i + 1).padStart(2, "0")}`);
    connector("standin-review2-many", "Many", stub([]), coins.map((c) => ({ asset: c, amount: 1, usd: 10 })));
    ok(await own({ type: "connectVenue", venue: "many", connector: "live:standin-review2-many", label: "Many", credentialRef: "" }));
    tickerCalls.length = 0;
    const h = answer(await svc.holdings());
    expect(tickerCalls.length).toBeGreaterThan(1);
    expect(tickerCalls.every((c) => c.length <= 40)).toBe(true);
    const asked = new Set(tickerCalls.flat());
    for (const c of coins) {
      expect(asked.has(`${c}/USD`)).toBe(true);
      expect(h.rows.find((r) => r.key === `crypto:${c}`)).toMatchObject({ changePct24h: 1, changeFrom: { venue: "tickers" } });
    }
    expect(h.change24h.missing).toEqual([]);
  });
});

describe("a real account's overview, markets and quote (the statement page's reads, as agents read them)", () => {
  it("answers no simulated catalogue or router: /api/markets and /api/quote are the service's refusal pointing at the wallet's reads", async () => {
    const markets = await get("/api/markets");
    expect([markets.status, markets.body.refusal?.code]).toEqual([409, "E_ACCOUNT_BAD_ACTION"]);
    expect(markets.body.refusal.message).toContain("/api/account/explore");
    const quote = await get("/api/quote?base=ETH&side=sell&qty=1");
    expect([quote.status, quote.body.refusal?.code]).toEqual([409, "E_ACCOUNT_BAD_ACTION"]);
    expect(svc.markets()).toEqual([]);
  });

  it("leaves the simulation's dial, day and ladder out, says live venues are on it, and its totals are the account page's and the holdings'", async () => {
    const o = await get("/api/overview");
    expect(o.status).toBe(200);
    expect(Object.keys(o.body)).not.toEqual(expect.arrayContaining(["openness"]));
    expect(o.body.daily).toBeUndefined();
    expect(o.body.compiled).toBeUndefined();
    expect(o.body.ladder).toBeUndefined();
    expect(o.body.live).toBe(true);
    expect(o.body.accountLayer).toBe(true);
    const a = await get("/api/account");
    const h = await get("/api/account/holdings");
    expect(o.body.portfolio.totalUsd).toBe(a.body.totalUsd);
    expect(h.body.totalUsd).toBe(a.body.totalUsd);
    // the liquidity map says why a venue's dollars stay in the venue's own words (the stand-in moves no money), never by the kind of venue
    const ex = o.body.liquidity.stuck.filter((s: { account: string }) => s.account === "ex");
    expect(ex.length).toBeGreaterThan(0);
    expect(ex.map((s: { why: string }) => s.why)).not.toContain("key cannot withdraw");
    expect((await svc.overview()).ladder.rows).toEqual([]);
  });

  it("the account page carries no simulated runways, doors or address book, keeps what the page and the seats read, and publishes the door's own lists", async () => {
    const a = (await get("/api/account")).body;
    for (const v of a.venues) for (const k of ["runways", "agentKey", "in", "out", "swaps", "fiat", "ledgers"]) expect(v).not.toHaveProperty(k);
    expect(a).not.toHaveProperty("destinations");
    expect(Array.isArray(a.declinedAsks)).toBe(true);
    expect(a.real).toBe(true);
    expect(a.dollars).toEqual([...STABLES]);
    expect(a.networks).toEqual([...new Set(STABLECOINS.map((s) => s.chain))]);
    expect(a.bridgeChains).toEqual([...BRIDGE_CHAINS]);
    expect(a.bridgeChains).toContain("Robinhood Chain");
    expect(Object.keys(CHAINS)).toEqual(expect.arrayContaining(a.networks));
  });

  it("an unsigned agent write is pointed at the live door", async () => {
    const r = await fetch(`${server.url}/api/execute`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: "ex", intent: { kind: "trade", symbol: "BTC/USDT", side: "buy", qty: 0.001 } }) });
    expect(r.status).toBe(401);
    const body = (await r.json()) as { refusal: { message: string } };
    expect(body.refusal.message).toContain("agentLiveOrder");
    expect(body.refusal.message).toContain("agentLiveMove");
  });

  it("the agents' read wires the mode as every other read does: guard or open", async () => {
    expect((await get("/api/account/agents")).body.mode).toBe("guard");
    expect((await get("/api/account")).body.mode).toBe("guard");
  });

  it("a new session's summary names the day the way the page does", async () => {
    const r = ok(await own({ type: "setPolicy", change: "session", value: "30d" })) as { summary?: string };
    expect(r.summary).toMatch(/^agents may act again, until [A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2}$/);
  });
});

describe("the page's own files and the account's answers", () => {
  it("a script is kept and revalidated by its ETag; an answer under /api/ is never stored", async () => {
    const first = await fetch(`${server.url}/ui/core.js`);
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-cache");
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    // a browser's revalidation (fetch() itself marks a conditional request no-cache, so the plain client stands in for the browser here)
    const again = await new Promise<number>((resolve, reject) => httpGet(`${server.url}/ui/core.js`, { headers: { "if-none-match": etag! } }, (res) => (res.resume(), resolve(res.statusCode ?? 0))).on("error", reject));
    expect(again).toBe(304);
    expect((await fetch(`${server.url}/`)).headers.get("cache-control")).toBe("no-cache");
    expect((await fetch(`${server.url}/api/account`)).headers.get("cache-control")).toBe("no-store");
    expect((await fetch(`${server.url}/ui/nope.js`)).status).toBe(404);
  });
});

describe("a venue's earn beside its balance", () => {
  const held = { positions: no("E_VENUE_PERMISSION", { venue: "earnven", message: "Earn Ex: this key may not read Simple Earn" }) as EarnPosition[] | Refusal };
  const earner: LiveEarner = {
    can: true,
    what: "Simple Earn",
    products: async () => [],
    product: async (id) => no("E_VENUE_REJECTED", { venue: "earnven", message: `no product ${id}` }),
    positions: async () => held.positions,
    supply: async () => no("E_VENUE_RAIL_CLOSED", { venue: "earnven", message: "no" }),
    withdraw: async () => no("E_VENUE_RAIL_CLOSED", { venue: "earnven", message: "no" }),
  };

  it("an earn that has not answered yet marks the venue stale, in words that say what is not counted", async () => {
    connector("standin-review2-earn", "Earn Ex", stub([BTC]), [{ asset: "USDT", amount: 1_000, usd: 1_000 }], { earner });
    ok(await own({ type: "connectVenue", venue: "earnven", connector: "live:standin-review2-earn", label: "Earn Ex", credentialRef: "" }));
    const v = (await get("/api/account")).body.venues.find((x: { id: string }) => x.id === "earnven");
    expect(v.stale).toMatch(/its earn has not answered yet: what is in its earn products is not counted/);
    expect(v.usd).toBe(1_000);
  });

  it("once it answers, the venue's total counts it once, and the overview, the account page and the holdings agree", async () => {
    held.positions = [{ product: "flex:USDT", id: "flex:USDT", asset: "USDT", amount: 100, usd: 100 }];
    const a = (await get("/api/account")).body;
    const v = a.venues.find((x: { id: string }) => x.id === "earnven");
    expect(v.usd).toBe(1_100);
    expect(v.stale).toBeUndefined();
    const o = (await get("/api/overview")).body;
    expect(o.portfolio.byAccount.find((x: { account: string }) => x.account === "earnven").usd).toBe(1_100);
    expect(o.portfolio.totalUsd).toBe(a.totalUsd);
    expect((await get("/api/account/holdings")).body.totalUsd).toBe(a.totalUsd);
  });
});

describe("a write at a venue and the reads kept of it", () => {
  it("the venue's positions are read again on the next poll after the owner's leverage signature, not when the keep runs out", async () => {
    let reads = 0;
    const trader = stub([PERP], {
      async positions(): Promise<Position[]> {
        reads++;
        return [{ symbol: PERP.symbol, name: PERP.name, kind: "perp", side: "long", qty: 0.4, entryPrice: 2_900, markPrice: 3_000, usd: 1_200, unrealizedUsd: 40, leverage: reads > 1 ? 5 : 2, native: {} }];
      },
      async setLeverage(_symbol, leverage, marginMode) {
        return { leverage, marginMode, native: {} };
      },
    });
    connector("standin-review2-pos", "Perps", trader, [{ asset: "USDT", amount: 500, usd: 500 }]);
    ok(await own({ type: "connectVenue", venue: "pos", connector: "live:standin-review2-pos", label: "Perps", credentialRef: "" }));
    expect((await get("/api/account/positions?venue=pos")).body.positions[0].leverage).toBe(2);
    await get("/api/account/positions?venue=pos");
    expect(reads).toBe(1);
    ok(await own({ type: "liveLeverage", venue: "pos", symbol: PERP.symbol, leverage: "5", marginMode: "cross" }));
    expect((await get("/api/account/positions?venue=pos")).body.positions[0].leverage).toBe(5);
    expect(reads).toBe(2);
  });
});

describe("the Asset sheet's price history", () => {
  it("a coin no connected venue keeps a history of is charted from the exchanges' keyless public bars", async () => {
    const a = answer(await svc.asset("crypto:BTC", "1h"));
    expect(a.candles).toMatchObject({ venue: "pubex", symbol: "BTC/USD", public: true });
    expect(a.candles?.bars.length).toBe(24);
    // one no public exchange lists either has none, in a source's own words (the first that refused: here the venue that refuses this location)
    const x = answer(await svc.asset("crypto:ETH", "1h"));
    expect(x.candles).toBeUndefined();
    expect(x.missing).toEqual(expect.arrayContaining([expect.objectContaining({ part: "candles", code: expect.stringMatching(/^E_VENUE_/) })]));
  });
});

describe("an agent wallet on the account", () => {
  /** a stand-in chain: every address holds 40 USDC on every chain, and a little of each chain's coin */
  const chain = {
    tokens: async (_holder: string, refs: Array<{ chain: string; asset: string }>) => ({ rows: refs.filter((r) => r.asset === "USDC").map((r) => ({ chain: r.chain, asset: r.asset, amount: 40 })), failed: [] }),
    native: async (_holder: string, chains: string[]) => ({ rows: chains.map((c) => ({ chain: c, asset: CHAINS[c as keyof typeof CHAINS].coin, amount: 0.01 })), failed: [] }),
    uint: async () => undefined,
    decimals: async () => 6,
    receipt: async () => undefined,
  } as unknown as ChainReader;
  let home2: string;
  let svc2: PortfolioService;
  const own2 = async (a: NoNonce<OwnerAction>) => svc2.exchange(await signOwner(owner, { ...a, nonce: nonce() } as OwnerAction));
  afterAll(() => {
    if (home2) rmSync(home2, { recursive: true, force: true });
  });

  it("is not disconnected: it holds money the account has the key for, and it stays on the account with what it holds", async () => {
    home2 = mkdtempSync(join(tmpdir(), "review2-service-wallet-"));
    svc2 = await PortfolioService.create({ home: home2, venues: "frontline", real: true, liveWrites: { capUsd: 100, pairingCode: "K7QX-M2PA" }, publicMarkets: [], liveDeps: { http: noNetwork, price: async () => undefined, chain, sender: { transfer: async () => ({ error: "the stand-in sends nothing" }) } }, account: { owners: [{ id: owner.address, kind: "eoa", label: "owner", addedAt: new Date().toISOString() }] } });
    await svc2.restoring;
    ok(await own2({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: Date.now() + 30 * DAY }));
    ok(await own2({ type: "createSubAccount", name: "Claude Code", agent: cc.address, float: "100" }));
    const wallet = svc2.accounts().find((a) => a.connector === "live:agent-wallet");
    expect(wallet).toBeDefined();
    const before = (await svc2.accountView())!.venues.find((v) => v.id === wallet!.id)!;
    expect(before.usd).toBeGreaterThan(0);
    const r = await own2({ type: "disconnectVenue", venue: wallet!.id });
    expect(isRefusal(r) && r.code).toBe("E_ACCOUNT_BAD_ACTION");
    expect(isRefusal(r) && r.message).toMatch(/agent wallet/);
    expect(isRefusal(r) && r.message).toMatch(/Take back/);
    const after = (await svc2.accountView())!.venues.find((v) => v.id === wallet!.id);
    expect(after?.usd).toBe(before.usd);
  });
});

describe("the statement across a restart", () => {
  let home3: string;
  afterAll(() => {
    if (home3) rmSync(home3, { recursive: true, force: true });
  });
  const flex = { id: "flex:USDT", asset: "USDT", name: "USDT · flexible", apy: 0.05, rateKind: "apr" as const, lockDays: 0, priceUsd: 1, lands: "the Earn Ex funding account", canSupply: true, canWithdraw: true };
  const earner: LiveEarner = {
    can: true,
    what: "a flexible product",
    products: async () => [{ ...flex }],
    product: async (id) => (id === flex.id ? { ...flex } : no("E_VENUE_REJECTED", { venue: "earn2", message: `no product ${id}` })),
    positions: async () => [],
    supply: async (_p, amount) => ({ ref: `s-${amount}`, status: "done", native: {} }),
    withdraw: async (_p, amount) => ({ ref: `w-${amount}`, status: "done", native: {} }),
  };
  const make = (h: string) => PortfolioService.create({ home: h, venues: "frontline", real: true, liveWrites: { capUsd: 5_000, pairingCode: "K7QX-M2PA" }, publicMarkets: [], liveDeps: { http: noNetwork, price: async () => undefined }, account: { owners: [{ id: owner.address, kind: "eoa", label: "owner", addedAt: new Date().toISOString() }] } });

  it("a finished earn request stays done, and a ledger in the home that is not one of the account's runs is not read", async () => {
    home3 = mkdtempSync(join(tmpdir(), "review2-service-restart-"));
    // a demo's ledger, left in the same home: a statement row that is nobody's on this account
    mkdirSync(join(home3, "portfolio"), { recursive: true });
    const stray = new Ledger(join(home3, "portfolio", "ledger-0000-demo.jsonl"), () => new Date().toISOString());
    stray.append({ kind: "statement", venue: "demo", detail: { key: "order:demo-1", id: "ord-demo", at: new Date().toISOString(), updatedAt: new Date().toISOString(), type: "trade", kind: "buy", account: "demo", accountName: "Demo", description: "Buy 1 DEMO", amountUsd: -1, status: "filled", by: "You" }, native: {} });
    connector("standin-review2-earn2", "Earn Two", stub([BTC]), [{ asset: "USDT", amount: 1_000, usd: 1_000 }], { earner });
    const first = await make(home3);
    await first.restoring;
    const own1 = async (a: NoNonce<OwnerAction>) => first.exchange(await signOwner(owner, { ...a, nonce: nonce() } as OwnerAction));
    ok(await own1({ type: "connectVenue", venue: "earn2", connector: "live:standin-review2-earn2", label: "Earn Two", credentialRef: "" }));
    const prepared = answer(await first.account!.prepare({ type: "liveEarn", venue: "earn2", kind: "supply", product: flex.id, asset: "USDT", amount: "25" }));
    ok(await first.exchange(await signOwner(owner, prepared.action as OwnerAction)));
    const before = first.statement();
    expect(before.map((l) => [l.type, l.kind, l.status])).toEqual([["earn", "supply", "done"]]);
    // the account starts again on the same home: the line is still done, not "not followed since a restart"
    const again = await make(home3);
    await again.restoring;
    const after = again.statement();
    expect(after.map((l) => [l.type, l.kind, l.status])).toEqual([["earn", "supply", "done"]]);
    expect(after.some((l) => l.key === "order:demo-1")).toBe(false);
  }, 30_000);
});
