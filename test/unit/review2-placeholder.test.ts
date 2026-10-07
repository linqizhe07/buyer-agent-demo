/** review2 · the placeholder lens: every place the product offers less than the real interface it stands on, pinned as a test that
 * FAILS while the gap stands. Every venue here is a stand-in and no network is reached; the only key is Hardhat's published account 0.
 *
 * Each `it` names the finding it pins (scratchpad/review2/placeholder/REPORT.md); a failing assertion is the finding, not the test's bug:
 *   F1  the real-only service still answers the simulated event catalogue (service.markets → /api/markets, MCP portfolio_markets)
 *   F2  the real-only service's overview invents a liquidity reason and a ladder route for a live venue (rails.ts / portfolio.ts tables)
 *   F3  Polymarket connected with its key hides the deposit wallet the connector knows (no Receive) — closed: its writer receives (pUSD on
 *       Polygon to the wallet, Polymarket's bridge from the other chains), and the test now pins that
 *   F4  the Asset drawer's price history ignores the keyless public OHLCV that /api/account/candles already serves
 *   F5  Hyperliquid by address asserts "does not serve this location" without asking anything — closed: the words name the key, not a place
 *   F6  a Stock Token row that trades at a connected wallet still carries a public line offering "Connect to trade"
 *   F7  the Alpaca connector never asks Alpaca about its crypto wallets (GET /v2/wallets) before declaring it moves nothing — closed: asked
 *       once at connect, its answer is the answer (a writer that receives, or Alpaca's own words)
 *   F8  the MCP seat's move schema is narrower than the door: no USDG, no Robinhood Chain for a bridge
 *   F9  the page keeps its own dollar lists, out of step with the account's STABLES
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isRefusal, type Refusal } from "../../src/core/errors.ts";
import { no } from "../../src/portfolio/refuse.ts";
import type { Outcome } from "../../src/portfolio/account/exchange.ts";
import { signOwner, simKey, type OwnerAction } from "../../src/portfolio/account/sign.ts";
import { hyperliquidSource } from "../../src/portfolio/live/address.ts";
import { alpacaSource } from "../../src/portfolio/live/alpaca.ts";
import { BRIDGE_CHAINS } from "../../src/portfolio/live/bridge.ts";
import type { ChainReader } from "../../src/portfolio/live/chain.ts";
import { exploreAcross, type ExploreVenue } from "../../src/portfolio/live/explore.ts";
import { register } from "../../src/portfolio/live/index.ts";
import { polymarketTradeSource } from "../../src/portfolio/live/polymarket-clob.ts";
import type { PublicSource } from "../../src/portfolio/live/public-markets.ts";
import type { Candle, LiveTrader, Market, OrderState } from "../../src/portfolio/live/trade.ts";
import { STABLES, type Http, type HttpReply } from "../../src/portfolio/live/types.ts";
import { PortfolioService } from "../../src/portfolio/service.ts";

type NoNonce<T> = T extends unknown ? Omit<T, "nonce"> : never;
const ROOT = join(import.meta.dirname, "..", "..");
const json = (body: unknown, status = 200): HttpReply => ({ status, body, text: JSON.stringify(body) });
const answer = <T,>(r: T | Refusal): T => {
  if (isRefusal(r)) throw new Error(`refused: ${r.code} ${r.message}`);
  return r;
};

// ---- stand-ins ----------------------------------------------------------------------------------------------------------------------
const BTC: Market = { symbol: "BTC/USDT", name: "BTC / USDT", kind: "spot", base: "BTC", quote: "USDT", price: 60_000, bid: 59_990, ask: 60_010, minQty: 0.0001, qtyStep: 0.0001, priceStep: 0.1, open: true, types: ["market", "limit"] };
/** a trader over a fixed list that keeps no price history (like the DEX trader, Robinhood's, the by-address sources) */
function stub(list: Market[]): LiveTrader {
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
  };
}
const bars: Candle[] = Array.from({ length: 24 }, (_, i) => ({ t: Date.UTC(2026, 9, 5, i), o: 60_000 + i, h: 60_050 + i, l: 59_950 + i, c: 60_010 + i, v: 1 }));
/** the keyless public side of an exchange the owner has NOT connected: it lists BTC and publishes its OHLCV, as public-markets.ts's exchange sources do */
const pubex: PublicSource = {
  id: "pubex",
  name: "Pub Exchange",
  kind: "exchange",
  connectTo: "pubex",
  connector: "live:exchange:pubex",
  async listings() {
    return [{ symbol: "BTC/USD", name: "BTC / USD", kind: "spot", base: "BTC", quote: "USD", price: 60_050, open: true, types: [], changePct24h: 2.4, volumeUsd24h: 1e9 }];
  },
  async candles() {
    return bars;
  },
} as PublicSource;

const owner = simKey("review2-placeholder-owner");
let home: string;
let svc: PortfolioService;
let n = 0;
const own = async (a: NoNonce<OwnerAction>) => svc.exchange(await signOwner(owner, { ...a, nonce: Date.now() + ++n } as OwnerAction));
const ok = (o: Outcome | Refusal) => {
  if (isRefusal(o)) throw new Error(`${o.code}: ${o.message}`);
  return o;
};

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "review2-placeholder-"));
  // the connected exchange: a key the venue says may withdraw, a writer that can, BTC and USDT held, a trader that keeps no price history
  register({ kind: "standin-review2-ph", label: "Ph Ex", needs: "key-file", example: "", venues: [], async open(req) {
    const first = [{ asset: "BTC", amount: 0.5, usd: 30_000 }, { asset: "USDT", amount: 1_000, usd: 1_000 }];
    return {
      source: {
        name: req.label || "Ph Ex",
        kind: "cex",
        reference: "standin",
        via: "a stand-in",
        probe: { can: ["read", "trade", "withdraw"], note: "" },
        read: async () => first,
        trader: stub([BTC]),
        writer: { can: { withdraw: true, ledgers: ["funding", "trading"], transfer: true, swap: true, receive: true, send: false }, async depositAddress() { return { address: "0x1111111111111111111111111111111111111111" as `0x${string}` }; } },
      },
      first,
      summary: "connected",
    };
  } });
  svc = await PortfolioService.create({ home, venues: "frontline", real: true, liveWrites: { capUsd: 100, pairingCode: "K7QX-M2PA" }, publicMarkets: [pubex], liveDeps: { http: async () => ({ status: 599, body: undefined, text: "" }), price: async () => undefined }, account: { owners: [{ id: owner.address, kind: "eoa", label: "owner", addedAt: new Date().toISOString() }] } });
  ok(await own({ type: "connectVenue", venue: "ex", connector: "live:standin-review2-ph", label: "Ph Ex", credentialRef: "" }));
}, 30_000);

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

// ---- F1 · F2: what the real-only service still answers from the simulation -----------------------------------------------------------
describe("F1 · a real-only service answers no simulated catalogue (README: 'nothing simulated is shown on the real page'; server.ts GET /api/markets, mcp.ts portfolio_markets read it)", () => {
  it("service.markets() is empty on a real account instead of the fixture's three event contracts (events.ts EVENTS: FED-DEC-HIKE25 …)", () => {
    const m = svc.markets();
    expect(m.map((x) => x.id)).toEqual([]);
  });
});

describe("F2 · the overview an agent reads (mcp.ts portfolio_overview → /api/overview) says nothing invented about a live venue", () => {
  it("liquidity: a live key the venue says may withdraw is not 'stuck · key cannot withdraw' (portfolio.ts:93 picks the words by kind, not by the key)", async () => {
    const o = await svc.overview();
    const ex = o.liquidity.stuck.filter((s) => s.account === "ex");
    expect(ex.map((s) => s.why)).not.toContain("key cannot withdraw");
  });
  it("ladder: a live venue's dollars get no simulated route quote ('convert to USDC, withdraw to Ethereum · $5.50 · 600 s', rails.ts source 'sim')", async () => {
    const o = await svc.overview();
    const items = o.ladder.rows.flatMap((r) => r.items).filter((i) => i.account === "ex");
    expect(items.map((i) => (i.route as { source?: string }).source)).not.toContain("sim");
  });
});

// ---- F3: Polymarket connected with the account wallet's key knows the deposit wallet and hides it ----------------------------------------
describe("F3 · Polymarket by key: the connector knows the wallet pUSD lands in (native.maker) and the account offers no Receive for it", () => {
  const HARDHAT_0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const EOA = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
  const chain: ChainReader = { tokens: async (_h: unknown, refs: Array<{ chain: unknown; asset: unknown }>) => ({ rows: refs.map((r) => ({ chain: r.chain, asset: r.asset, amount: 150.5 })), failed: [] }), native: async () => ({ rows: [], failed: [] }), uint: async () => undefined, decimals: async () => 6, receipt: async () => undefined } as unknown as ChainReader;
  const http: Http = async (url) => {
    if (url.includes("/api/geoblock")) return json({ blocked: false, ip: "203.0.113.7", country: "IE", region: "L" });
    if (url.includes("/positions?user=")) return json({ data: [], pagination: { next_cursor: null } });
    if (url.endsWith("/auth/derive-api-key")) return json({ apiKey: "7b1e2d60-6f9a-4dd7-8f3e-21b8f94c77a2", secret: "ABEiM0RVZneImaq7zN3u_wARIjNEVWZ3iJmqu8zd7v8=", passphrase: "made-up-passphrase-0001" });
    return json({ error: `not set up in this test: ${url}` }, 404);
  };
  it("the source's writer receives: pUSD on Polygon goes to the wallet the orders are made by — docs.polymarket.com/concepts/pusd: pUSD is 'a standard ERC-20 token on Polygon'", async () => {
    const opened = answer(await polymarketTradeSource({ venue: "polymarket-trade", label: "", reference: "credentials/polymarket-trade/api-key.json", key: { privateKey: HARDHAT_0 }, http, chain, clock: () => 1791225442000, salt: () => 479249096354 }));
    const native = opened.source.probe.native as { maker?: string };
    // what the connector already knows
    expect(String(native.maker).toLowerCase()).toBe(EOA.toLowerCase());
    // what it tells the account: a writer that receives (money.js canReceive reads liveCan.receive; service.receive asks writer.depositAddress).
    // The wallet is NOT the source's `address`: service.receive and mcp.ts read an `address` as a watched or proven wallet and would refuse
    // it as "watched, not proven yours"; the key signing Polymarket's orders is what shows the wallet is the owner's
    expect(opened.source.address).toBeUndefined();
    expect(opened.source.readOnlyBecause).toBeUndefined();
    expect(opened.source.writer?.can.receive).toBe(true);
    expect(opened.source.writer?.can.withdraw).toBe(false);
    const where = answer(await opened.source.writer!.depositAddress("pUSD", "Polygon"));
    expect(where.address.toLowerCase()).toBe(EOA.toLowerCase());
  });
});

// ---- F4: the Asset drawer's price history -----------------------------------------------------------------------------------------------
describe("F4 · the Asset drawer (service.asset → candlesFor) falls back to the keyless public OHLCV that /api/account/candles already serves", () => {
  it("GET /api/account/candles answers for the public source (the interface exists)", async () => {
    const c = answer(await svc.candles("pubex", "BTC/USD", "1h"));
    expect(c.candles.length).toBe(24);
    expect(c.public).toBe(true);
  });
  it("service.asset('crypto:BTC') carries that history instead of 'No venue connected here keeps a price history for it' (asset.js:122)", async () => {
    const a = answer(await svc.asset("crypto:BTC", "1h"));
    expect(a.row?.asset).toBe("BTC");
    expect(a.candles?.bars.length ?? 0).toBeGreaterThan(0);
  });
});

// ---- F5: Hyperliquid by address --------------------------------------------------------------------------------------------------------
describe("F5 · Hyperliquid by address (address.ts:104) states the venue's rule honestly: no key to sign with, not a location it never checked", () => {
  const http: Http = async (_url, init) => {
    const type = (JSON.parse(String(init?.body ?? "{}")) as { type?: string }).type;
    if (type === "clearinghouseState") return json({ marginSummary: { accountValue: "25.5" }, withdrawable: "25.5" });
    if (type === "spotClearinghouseState") return json({ balances: [] });
    return json({ error: "not set up" }, 404);
  };
  it("neither readOnlyBecause nor noTradeBecause claims 'does not serve this location' (nothing about the location was asked: the only calls are clearinghouseState and spotClearinghouseState)", async () => {
    const opened = answer(await hyperliquidSource({ venue: "hl", label: "", address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", http, chain: {} as ChainReader }));
    const words = `${opened.source.readOnlyBecause ?? ""} ${opened.source.noTradeBecause ?? ""}`;
    expect(words).not.toMatch(/does not serve this location/);
  });
});

// ---- F6: a Stock Token row with a wallet connected ---------------------------------------------------------------------------------------
describe("F6 · Markets: a Stock Token that trades at a connected wallet carries no public line that offers 'Connect to trade' (markets.js:815, trade.js:891)", () => {
  it("the rwa:NVDA row trades at the wallet, so its Robinhood public line is a price, not a connection to make", async () => {
    const nvda: Market = { symbol: "NVDA/USDG@Robinhood Chain", name: "NVIDIA Stock Token on Robinhood Chain", kind: "token", base: "NVDA", quote: "USDG", price: 180, bid: 179.9, ask: 180.1, open: true, types: ["market"], category: "RWA", issuer: "Robinhood", eligibility: "not for US persons" };
    const wallet: ExploreVenue = { id: "wallet", name: "Browser wallet", trader: stub([nvda]), connector: "live:wallet" };
    const tokens: PublicSource = {
      id: "robinhood-tokens",
      name: "Robinhood Stock Tokens",
      kind: "tokens",
      connectTo: "robinhood-wallet",
      connector: "live:wallet",
      readOnly: "Robinhood's own prices: a Stock Token trades from a connected wallet on Robinhood Chain, against USDG",
      async listings() {
        return [{ symbol: "NVDA", name: "NVIDIA", kind: "token", base: "NVDA", quote: "USDG", price: 181, open: true, types: [] }];
      },
    } as PublicSource;
    const x = await exploreAcross({ connected: [wallet], public: [tokens] }, { clock: () => Date.UTC(2026, 9, 5, 14) });
    const row = x.items.find((i) => i.key === "rwa:NVDA");
    expect(row).toBeDefined();
    expect(row!.at.some((a) => a.connected && a.canTrade === true)).toBe(true);
    // the public line may price the row; it may not say "connect to trade" when the row already trades here
    const offers = row!.at.filter((a) => a.public && a.connectTo !== undefined);
    expect(offers).toEqual([]);
  });
});

// ---- F7: Alpaca's crypto wallets ---------------------------------------------------------------------------------------------------------
describe("F7 · Alpaca (alpaca.ts:86 'Alpaca's API moves no cash'): the Trading API has crypto wallets (GET /v2/wallets, POST /v2/wallets/transfers, whitelists), gated per account, so the connector asks", () => {
  it("connecting asks GET /v2/wallets (or declares the venue's own answer) rather than assuming the account can neither receive nor withdraw crypto", async () => {
    const seen: string[] = [];
    const LIVE = "https://api.alpaca.markets";
    const http: Http = async (url, init = {}) => {
      seen.push(`${init.method ?? "GET"} ${url}`);
      if (url === `${LIVE}/v2/account`) return json({ status: "ACTIVE", crypto_status: "ACTIVE", cash: "2500.50", equity: "2500.50", buying_power: "5001" });
      if (url === `${LIVE}/v2/positions`) return json([]);
      if (url.startsWith(`${LIVE}/v2/wallets`)) return json([{ asset: "USDC", network: "ethereum", address: "0x2222222222222222222222222222222222222222" }]);
      return json({ message: `not set up in this test: ${url}` }, 404);
    };
    const opened = answer(await alpacaSource({ venue: "alpaca", label: "", reference: "credentials/alpaca/api-key.json", key: { keyId: "PKTEST000000000000000", secret: "made-up-secret" }, http, clock: () => Date.parse("2026-10-05T19:53:20.000Z") }));
    expect(seen.some((c) => c.startsWith(`GET ${LIVE}/v2/wallets`))).toBe(true);
    expect(opened.source.writer?.can.receive).toBe(true);
  });
});

// ---- F8 · F9: the seat's schema and the page's own tables ----------------------------------------------------------------------------------
describe("F8 · mcp.ts: the seat's live-move schema is as wide as the door (live-moves.ts planBridge takes bridge.chains incl. Robinhood Chain in USDG)", () => {
  // the service round closed this by IMPORTING the door's own lists rather than retyping them (the review asked for exactly that), so the
  // check reads the enums' sources, not a literal list: toNetwork is z.enum over live/bridge.ts BRIDGE_CHAINS (Robinhood Chain in USDG among
  // them), asset and toAsset over live/types.ts STABLES (USDG, USDT0 among them), network over the chains of live/chain.ts STABLECOINS
  const src = readFileSync(join(ROOT, "src/portfolio/mcp.ts"), "utf8");
  it("toNetwork for a bridge may be Robinhood Chain", () => {
    expect(src).toMatch(/import \{ BRIDGE_CHAINS \} from "\.\/live\/bridge\.ts"/);
    expect(src).toMatch(/const BRIDGE_TO = enumOf\(BRIDGE_CHAINS\)/);
    expect(src).toMatch(/toNetwork: z\.enum\(BRIDGE_TO\)/);
    expect(BRIDGE_CHAINS).toContain("Robinhood Chain");
  });
  it("asset may be USDG (the dollar a bridge carries on Robinhood Chain) and USDT0", () => {
    expect(src).toMatch(/const DOLLARS = enumOf\(STABLES as Set<string>\)/);
    expect(src).toMatch(/asset: z\.enum\(DOLLARS\)/);
    expect(src).toMatch(/toAsset: z\.enum\(DOLLARS\)/);
    expect([...STABLES]).toEqual(expect.arrayContaining(["USDG", "USDT0"]));
  });
});

describe("F9 · the page keeps ONE dollar list, core.js DOLLARS_KNOWN, equal to the account's STABLES (live/types.ts), and reads A.dollars first", () => {
  const src = readFileSync(join(ROOT, "src/portfolio/public/ui/core.js"), "utf8");
  const list = (name: string): string[] => {
    const m = new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(src);
    return (m?.[1] ?? "").split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
  };
  it("core.js DOLLARS_KNOWN names exactly the account's stablecoins", () => {
    const ui = new Set(list("DOLLARS_KNOWN").map((s) => s.toUpperCase()));
    const onlyUi = [...ui].filter((s) => !STABLES.has(s));
    const onlyAccount = [...STABLES].filter((s) => !ui.has(s));
    expect({ onlyUi, onlyAccount }).toEqual({ onlyUi: [], onlyAccount: [] });
  });
  it("the page reads the account's own list (A.dollars) before its fallback, and no other script keeps a dollar table", () => {
    expect(src).toMatch(/A\.dollars/);
    for (const file of ["trade.js", "portfolio.js", "money.js"]) {
      const other = readFileSync(join(ROOT, "src/portfolio/public/ui", file), "utf8");
      expect(other).not.toMatch(/TK_DOLLARS|PF_DOLLAR_ASSETS|new Set\(\["USD"/);
    }
  });
});
