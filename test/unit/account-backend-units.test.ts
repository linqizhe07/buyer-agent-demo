/** The smaller contracts behind the wallet page, one at a time against stand-ins (nothing leaves the process, no key anywhere):
 *
 *   public price history    an exchange's keyless OHLCV (only for a pair it lists), Kalshi's public candlesticks (NO as 1 − YES, five
 *                           minutes folded from one), Polymarket's prices-history through the outcome's token id — fixed hosts only
 *   movers                  one chip per asset: a coin's perpetual is the coin
 *   agentSetup              the command that adds this account's MCP seat, quoted where a shell would read the path
 *   the mm source's price   live/index.ts hands the price to the mm source, so a vault of a coin can be valued
 *   a device's label        kept when the owner lets it in, and after a restart
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isRefusal, type Refusal } from "../../src/core/errors.ts";
import { signOwner, signDevice, simKey, type OwnerAction } from "../../src/portfolio/account/sign.ts";
import { applyOwner, emptyState } from "../../src/portfolio/account/state.ts";
import { exploreAcross } from "../../src/portfolio/live/explore.ts";
import type { ExchangeClient, OpenExchange } from "../../src/portfolio/live/exchange.ts";
import { openLive, type LiveDeps } from "../../src/portfolio/live/index.ts";
import { exchangeTickers, kalshiPublic, polymarketPublic, PUBLIC_HOSTS, stockTokensPublic, type PublicSource } from "../../src/portfolio/live/public-markets.ts";
import type { Candle, Market } from "../../src/portfolio/live/trade.ts";
import type { Http, HttpReply } from "../../src/portfolio/live/types.ts";
import { agentSetupOf } from "../../src/portfolio/server.ts";
import { PortfolioService } from "../../src/portfolio/service.ts";

const NOW = Date.parse("2026-10-06T12:00:00.000Z");
const HOUR = 3_600_000;
const json = (body: unknown, status = 200): HttpReply => ({ status, body, text: JSON.stringify(body) });
const bars = (r: Candle[] | Refusal): Candle[] => {
  if (isRefusal(r)) throw new Error(`refused: ${r.code} ${r.message}`);
  return r;
};
const refusal = (r: unknown): Refusal => {
  if (!isRefusal(r)) throw new Error(`expected a refusal, got ${JSON.stringify(r).slice(0, 160)}`);
  return r;
};
/** a stand-in network that answers by URL and records every URL asked */
function network(routes: Array<[string, HttpReply]>) {
  const sent: string[] = [];
  const http: Http = async (url) => {
    sent.push(url);
    return routes.find(([k]) => url.includes(k))?.[1] ?? json({ error: "not found" }, 404);
  };
  return { http, sent };
}

describe("public price history, keyless", () => {
  it("an exchange: fetchOHLCV for a pair it lists, at most 300 bars, nothing asked for a pair it does not", async () => {
    const asked: Array<[string, string, number, number]> = [];
    const client: ExchangeClient = {
      id: "kraken",
      markets: { "BTC/USD": { symbol: "BTC/USD", base: "BTC", quote: "USD", spot: true }, "BTC/EUR": { symbol: "BTC/EUR", base: "BTC", quote: "EUR", spot: true } },
      timeframes: { "5m": "5", "1h": "60", "1d": "1440" },
      async loadMarkets() {
        return {};
      },
      async fetchBalance() {
        throw new Error("never");
      },
      async fetchOHLCV(symbol, timeframe, since, limit) {
        asked.push([symbol, timeframe!, since!, limit!]);
        return [[NOW - 2 * HOUR, 100, 110, 95, 105, 3.5], [NOW - HOUR, 105, 108, 101, 107, 2], ["junk"], [NOW - 3 * HOUR * 1000, 1, 1, 1, 1, 1]];
      },
    };
    const open: OpenExchange = async () => client;
    const src = exchangeTickers("kraken", { open, clock: () => NOW });
    const got = bars(await src.candles!("BTC/USD", "1h", NOW - 20 * 24 * HOUR));
    expect(got).toEqual([{ t: NOW - 2 * HOUR, o: 100, h: 110, l: 95, c: 105, v: 3.5 }, { t: NOW - HOUR, o: 105, h: 108, l: 101, c: 107, v: 2 }]);
    // never further back than 300 bars
    expect(asked).toEqual([["BTC/USD", "1h", NOW - 300 * HOUR, 300]]);
    expect(refusal(await src.candles!("BTC/EUR", "1h", NOW - HOUR)).message).toMatch(/lists no market BTC\/EUR priced in dollars/);
    expect(refusal(await src.candles!("ETH/USD?x=1", "1h", NOW - HOUR)).code).toBe("E_VENUE_REJECTED");
    expect(refusal(await src.candles!("BTC/USD", "4h" as never, NOW - HOUR)).code).toBe("E_ACCOUNT_BAD_ACTION");
    expect(asked).toHaveLength(1);
  });

  it("Kalshi: its public candlesticks for the market's ticker — the trades' prices, NO turned over, five minutes folded from one", async () => {
    const stick = (endMin: number, o: string, h: string, l: string, c: string, v = "10.00") => ({ end_period_ts: Math.floor(NOW / 1000) - endMin * 60, price: { open_dollars: o, high_dollars: h, low_dollars: l, close_dollars: c }, volume_fp: v });
    const net = network([["/markets/candlesticks", json({ markets: [{ market_ticker: "KXFED-25DEC-T4.00", candlesticks: [stick(9, "0.40", "0.42", "0.39", "0.41"), stick(8, "0.41", "0.45", "0.41", "0.44"), { end_period_ts: Math.floor(NOW / 1000) - 7 * 60, price: { open_dollars: null } }] }] })]]);
    const src = kalshiPublic({ http: net.http, clock: () => NOW });
    const yes = bars(await src.candles!("KXFED-25DEC-T4.00:YES", "5m", NOW - 24 * HOUR));
    const no = bars(await src.candles!("kxfed-25dec-t4.00:no", "5m", NOW - 24 * HOUR));
    expect(yes).toHaveLength(1);
    expect(yes[0]).toMatchObject({ o: 0.4, h: 0.45, l: 0.39, c: 0.44, v: 20 });
    expect(no[0]).toMatchObject({ o: 0.6, h: 0.61, l: 0.55, c: 0.56 });
    const u = new URL(net.sent[0]!);
    expect([u.host, u.pathname, u.searchParams.get("market_tickers"), u.searchParams.get("period_interval")]).toEqual(["external-api.kalshi.com", "/trade-api/v2/markets/candlesticks", "KXFED-25DEC-T4.00", "1"]);
    expect(refusal(await src.candles!("../../x:YES", "1h", NOW - HOUR)).message).toMatch(/<ticker>:YES/);
  });

  it("Polymarket: the outcome's token id from Gamma, then the CLOB's prices-history, folded into bars", async () => {
    const t0 = Math.floor(NOW / 1000) - 7200;
    const net = network([
      ["gamma-api.polymarket.com/markets/slug/nfl-atl-no-2026-10-06", json({ slug: "nfl-atl-no-2026-10-06", outcomes: '["Falcons", "Saints"]', clobTokenIds: '["111", "222"]' })],
      ["clob.polymarket.com/prices-history", json({ history: [{ t: t0, p: 0.47 }, { t: t0 + 600, p: 0.5 }, { t: t0 + 3700, p: 0.45 }, { t: t0 + 3800, p: 2 }] })],
    ]);
    const src = polymarketPublic({ http: net.http, clock: () => NOW });
    const got = bars(await src.candles!("nfl-atl-no-2026-10-06:Saints", "1h", NOW - 12 * 24 * HOUR));
    expect(got.map((b) => [b.o, b.h, b.l, b.c])).toEqual([[0.47, 0.5, 0.47, 0.5], [0.45, 0.45, 0.45, 0.45]]);
    expect(new URL(net.sent[1]!).searchParams.get("market")).toBe("222");
    expect(net.sent.every((u) => PUBLIC_HOSTS.includes(new URL(u).host))).toBe(true);
    expect(refusal(await src.candles!("nfl-atl-no-2026-10-06:Rams", "1h", NOW - HOUR)).message).toMatch(/no outcome "Rams"/);
    expect(refusal(await src.candles!("NOT A SLUG:Yes", "1h", NOW - HOUR)).code).toBe("E_ACCOUNT_BAD_ACTION");
  });

  it("Robinhood's Stock Tokens publish none", () => {
    expect(stockTokensPublic({}).candles).toBeUndefined();
  });
});

describe("movers: one chip per asset", () => {
  const listing = (symbol: string, kind: Market["kind"], base: string, changePct24h: number, volumeUsd24h: number): Market => ({ symbol, name: symbol, kind, base, quote: "USDT", price: 100, open: true, types: [], changePct24h, volumeUsd24h });
  const source = (markets: Market[]): PublicSource => ({ id: "x", name: "X", kind: "exchange", connectTo: "x", connector: "live:exchange:x", listings: async () => markets });

  it("a coin and its perpetual both moving: the coin's own market is the chip; a perpetual alone is its own", async () => {
    const x = await exploreAcross({ public: [source([listing("BTC/USDT", "spot", "BTC", 3, 5e9), listing("BTC/USDT:USDT", "perp", "BTC", 9, 9e9), listing("SOL/USDT:USDT", "perp", "SOL", -7, 2e9), listing("ETH/USDT", "spot", "ETH", 1, 3e9)])] }, { clock: () => NOW });
    expect(x.movers.map((m) => m.key)).toEqual(["perp:SOL", "coin:BTC", "coin:ETH"]);
    // the perpetual's row is still in Perps
    expect(x.items.map((i) => i.key)).toContain("perp:BTC");
  });
});

describe("agentSetup: the command that adds this account's MCP seat", () => {
  it("names this server's origin and the seat by its absolute path, quoted where a shell would read it", () => {
    const s = agentSetupOf("http://127.0.0.1:4821");
    expect(s.url).toBe("http://127.0.0.1:4821");
    expect(s.command).toMatch(/^claude mcp add portfolio -e PORTFOLIO_URL=http:\/\/127\.0\.0\.1:4821 -- npx tsx \/\S+\/src\/portfolio\/mcp\.ts$/);
    expect(agentSetupOf("http://localhost:1 ;rm -rf ~").command).toContain("PORTFOLIO_URL='http://localhost:1 ;rm -rf ~'");
  });
});

describe("live/index.ts hands the price to the mm source", () => {
  it("so a vault of a coin is valued: the earner prices a WETH vault by the price it was given", async () => {
    const priced: string[] = [];
    const vault = { address: "0x1111111111111111111111111111111111111111", chainId: 8453, name: "WETH vault", protocol: { name: "Morpho" }, underlyingTokens: [{ address: "0x4200000000000000000000000000000000000006", symbol: "WETH", decimals: 18 }], apy: { base: 0.02, reward: null, total: 0.02 }, tvlUsd: 50_000_000, isTransactional: true, isRedeemable: true };
    const mm = (async (args: string[]) => {
      if (args[0] === "wallet" && args[1] === "show") return { address: "0x2222222222222222222222222222222222222222", policyYaml: "" };
      if (args[0] === "wallet" && args[1] === "balance") return { currency: "usd", totalValue: "0", chains: [] };
      if (args[0] === "earn" && args[1] === "markets") return [vault];
      throw new Error(`not asked here: ${args.join(" ")}`);
    }) as LiveDeps["mm"];
    const deps = { home: "/nowhere", http: async () => json({}, 599), clock: () => NOW, proofs: undefined as never, chain: undefined as never, mm, price: async (a: string) => (priced.push(a), a === "WETH" ? 2_400 : undefined) } as unknown as LiveDeps;
    const opened = await openLive({ venue: "metamask", connector: "live:metamask", label: "", reference: "" }, deps);
    if (isRefusal(opened)) throw new Error(opened.message);
    const earner = opened.source.earner!;
    const products = await earner.products();
    if (isRefusal(products)) throw new Error(products.message);
    expect(products.find((p) => p.asset === "WETH")).toMatchObject({ priceUsd: 2_400 });
    expect(priced).toContain("WETH");
  });
});

describe("a device let in keeps the label it paired under", () => {
  const homes: string[] = [];
  afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));
  const owner = simKey("device:label-owner");
  const phone = simKey("device:label-phone");

  it("in the state: a waiting device's label becomes its owner label; one that gave none is a device", () => {
    const base = { ...emptyState(), owners: [{ id: `device:${owner.kid}`, kind: "device" as const, label: "first", jwk: owner.jwk, addedAt: "" }], pendingDevices: [{ kid: phone.kid, jwk: phone.jwk, at: "", label: "Safari on this Mac" }, { kid: simKey("device:label-x").kid, jwk: simKey("device:label-x").jwk, at: "" }] };
    const users = [`device:${owner.kid}`, `device:${phone.kid}`, `device:${simKey("device:label-x").kid}`].sort();
    const next = applyOwner(base, { type: "convertToMultiSigUser", signers: JSON.stringify({ authorizedUsers: users, threshold: 1 }), nonce: 1 }, {} as never, NOW);
    if (isRefusal(next)) throw new Error(next.message);
    expect(Object.fromEntries(next.owners.map((o) => [o.id, o.label]))).toEqual({ [`device:${owner.kid}`]: "first", [`device:${phone.kid}`]: "Safari on this Mac", [`device:${simKey("device:label-x").kid}`]: "device" });
  });

  it("through the door, and after a restart: the same label", async () => {
    const home = mkdtempSync(join(tmpdir(), "device-label-"));
    homes.push(home);
    let t = NOW;
    const start = () => PortfolioService.create({ home, now: () => new Date(t).toISOString(), venues: "frontline", real: true, liveDeps: { clock: () => t, http: async () => json({}, 599), price: async () => undefined }, liveWrites: { capUsd: 100, pairingCode: "K7QX-M2PA" } });
    const svc = await start();
    await svc.restoring;
    const engine = svc.account!;
    expect(engine.pairDevice(owner.jwk, "the first browser", "K7QX-M2PA")).toMatchObject({ role: "owner" });
    expect(engine.pairDevice(phone.jwk, "Safari on this Mac")).toMatchObject({ role: "pending" });
    const action: OwnerAction = { type: "convertToMultiSigUser", signers: JSON.stringify({ authorizedUsers: [`device:${owner.kid}`, `device:${phone.kid}`].sort(), threshold: 1 }), nonce: t + 1 };
    expect(await svc.exchange({ action, nonce: action.nonce, signature: signDevice(owner, action) })).toMatchObject({ ok: true });
    const labels = (s: PortfolioService) => Object.fromEntries(s.account!.state.owners.map((o) => [o.id, o.label]));
    expect(labels(svc)).toEqual({ [`device:${owner.kid}`]: "the first browser", [`device:${phone.kid}`]: "Safari on this Mac" });
    t += 60_000;
    const again = await start();
    await again.restoring;
    expect(labels(again)).toEqual({ [`device:${owner.kid}`]: "the first browser", [`device:${phone.kid}`]: "Safari on this Mac" });
    // an EOA owner is unaffected by any of it
    void signOwner;
  });
});
