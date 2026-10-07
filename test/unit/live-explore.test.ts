import { describe, expect, it } from "vitest";
import type { Refusal } from "../../src/core/errors.ts";
import { no } from "../../src/portfolio/refuse.ts";
import { categoryOf, isExcludedCategory, roleOfCategory } from "../../src/portfolio/live/categories.ts";
import { exploreAcross, PREDICTIONS_MAX, type ExploreVenue } from "../../src/portfolio/live/explore.ts";
import type { OpenExchange } from "../../src/portfolio/live/exchange.ts";
import { exchangeTickers, type Listing, type PublicSource } from "../../src/portfolio/live/public-markets.ts";
import type { LiveTrader, Market, MarketKind, MarketStats } from "../../src/portfolio/live/trade.ts";

/** Every market the account can see as one list, with every source a stand-in: connected venues are stand-in traders that list what the
 * test gives them and record every call, public sources are stand-ins of the same shape public-markets.ts makes (and, for Binance's
 * refusal, the real exchangeTickers source over a stand-in exchange library). Nothing leaves the process; no key exists in this file. */

const NOW = Date.parse("2026-10-05T14:00:00.000Z");
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const clock = () => NOW;

const mk = (symbol: string, kind: MarketKind, base: string, quote: string, extra: Partial<Listing> = {}): Listing => ({ symbol, name: `${base} / ${quote}`, kind, base, quote, open: true, types: ["market", "limit"], ...extra });

/** a Kalshi market's two legs, as the account's Kalshi trader names them */
const kalshi = (ticker: string, title: string, yes: number, extra: Partial<Listing> = {}): Listing[] =>
  (["YES", "NO"] as const).map((o) => mk(`${ticker}:${o}`, "event", `${ticker}:${o}`, "USD", { name: `${title} · ${o === "YES" ? "Yes" : "No"}`, price: o === "YES" ? yes : Number((1 - yes).toFixed(4)), group: { id: ticker, title }, outcome: o, ...extra }));

/** a Polymarket market's outcomes, as the account's Polymarket trader names them */
const COND = `0x${"ab".repeat(32)}`;
const polymarket = (slug: string, question: string, outcomes: Array<[string, number]>, extra: Partial<Listing> = {}, condition = COND): Listing[] =>
  outcomes.map(([o, p]) => mk(`${slug}:${o}`, "event", o, "pUSD", { name: `${question} · ${o}`, price: p, group: { id: condition, title: question }, outcome: o, ...extra }));

type Answer<T> = T | Refusal | "hang" | "throw";
const never = <T,>() => new Promise<T>(() => undefined);
function answer<T>(a: Answer<T>): Promise<T | Refusal> {
  if (a === "hang") return never<T>();
  if (a === "throw") return Promise.reject(new Error("socket hang up"));
  return Promise.resolve(a);
}

interface Stand extends LiveTrader {
  calls: string[];
}

/** a connected venue's trader: lists `markets` (whatever the query), answers events within the window asked, and stats for the symbols asked */
function trader(o: { markets?: Answer<Market[]>; events?: Answer<Market[]>; stats?: Record<string, MarketStats>; can?: boolean | "unknown"; whyNot?: string }): Stand {
  const calls: string[] = [];
  const t: Stand = {
    calls,
    can: o.can ?? true,
    ...(o.whyNot ? { whyNot: o.whyNot } : {}),
    what: "stand-in",
    async markets(query) {
      calls.push(`markets:${query}`);
      return answer(o.markets ?? []);
    },
    async market() {
      throw new Error("exploring never asks for one market");
    },
    async place() {
      throw new Error("exploring never places an order");
    },
    async cancel() {
      throw new Error("exploring never cancels an order");
    },
    async status() {
      throw new Error("exploring never asks after an order");
    },
  };
  if (o.events !== undefined)
    t.events = async (q) => {
      calls.push(`events:${q.closingWithinMs ?? "all"}`);
      const got = await answer(o.events!);
      if (!Array.isArray(got) || !q.closingWithinMs) return got;
      return got.filter((m) => m.closeTime && Date.parse(m.closeTime) > NOW && Date.parse(m.closeTime) <= NOW + q.closingWithinMs!);
    };
  if (o.stats)
    t.stats = async (symbols) => {
      calls.push(`stats:${(symbols ?? []).join(",")}`);
      return new Map(Object.entries(o.stats!).filter(([s]) => !symbols || symbols.includes(s)));
    };
  return t;
}

const venue = (id: string, name: string, t: LiveTrader, connector?: string): ExploreVenue => ({ id, name, trader: t, ...(connector ? { connector } : {}) });

/** a public source: lists `listings`, and events when it has some */
function pub(id: string, name: string, o: { listings: Answer<Listing[]>; events?: Answer<Listing[]>; kind?: PublicSource["kind"]; connectTo?: string; connector?: string; readOnly?: string }): PublicSource & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    id,
    name,
    kind: o.kind ?? "exchange",
    connectTo: o.connectTo ?? id,
    connector: o.connector ?? `live:exchange:${id}`,
    ...(o.readOnly ? { readOnly: o.readOnly } : {}),
    async listings(q) {
      asked.push(`listings:${q.q ?? ""}`);
      return answer(o.listings);
    },
    ...(o.events !== undefined
      ? {
          async events(q: { closingWithinMs?: number | undefined }) {
            asked.push(`events:${q.closingWithinMs ?? "all"}`);
            return answer(o.events!);
          },
        }
      : {}),
  };
}

describe("one row for one thing", () => {
  it("two accounts at one exchange read one market: its volume counts once, and both accounts are where it trades", async () => {
    const a = trader({ markets: [mk("BTC/USDT", "spot", "BTC", "USDT", { price: 100_000, volumeUsd24h: 900e6 })] });
    const b = trader({ markets: [mk("BTC/USDT", "spot", "BTC", "USDT", { price: 100_000, volumeUsd24h: 900e6 })] });
    const kraken = pub("kraken", "Kraken", { listings: [mk("BTC/USD", "spot", "BTC", "USD", { price: 100_010, volumeUsd24h: 4e7, types: [] })] });
    const out = await exploreAcross({ connected: [venue("okx", "OKX", a, "live:exchange:okx"), venue("okx-sub", "OKX sub-account", b, "live:exchange:okx")], public: [kraken] }, { clock });
    const btc = out.items.find((i) => i.key === "coin:BTC")!;
    expect(btc.volumeUsd24h).toBe(900e6 + 4e7);
    expect(btc.at.map((x) => x.venue)).toEqual(["okx", "okx-sub", "kraken"]);
  });

  it("merges a coin across venues by its one name, each venue once by its most traded pair, and sums what they report", async () => {
    const okx = trader({ markets: [mk("BTC/USDT", "spot", "BTC", "USDT", { price: 100_000, volumeUsd24h: 900e6, changePct24h: 2.5, change24h: 2_440 }), mk("BTC/USDC", "spot", "BTC", "USDC", { price: 100_010, volumeUsd24h: 50e6 })] });
    const rh = trader({ markets: [mk("BTC-USD", "crypto", "BTC", "USD", { price: 100_050, volumeUsd24h: 20e6, changePct24h: 2.6 })] });
    const wallet = trader({ markets: [mk("WBTC/USDC@Arbitrum", "token", "WBTC", "USDC", { price: 99_980 })] });
    const out = await exploreAcross({ connected: [venue("okx", "OKX", okx), venue("robinhood-crypto", "Robinhood Crypto", rh), venue("metamask", "MetaMask", wallet)] }, { clock });
    const btc = out.items.find((i) => i.key === "coin:BTC")!;
    expect(btc).toMatchObject({ kind: "coin", name: "BTC", base: "BTC", price: 100_000, changePct24h: 2.5, change24h: 2_440, changeFrom: { venue: "okx", venueName: "OKX" }, volumeUsd24h: 920e6, tabs: expect.arrayContaining(["crypto"]) });
    // OKX once, by BTC/USDT (its most traded); the wallet's WBTC is BTC; the order there names each symbol as it is
    expect(btc.at.map((a) => [a.venue, a.symbol])).toEqual([
      ["okx", "BTC/USDT"],
      ["robinhood-crypto", "BTC-USD"],
      ["metamask", "WBTC/USDC@Arbitrum"],
    ]);
    expect(btc.at.every((a) => a.connected && a.canTrade === true && !a.public)).toBe(true);
    expect(out.items.filter((i) => i.kind === "coin")).toHaveLength(1);
  });

  it("keeps a stablecoin, a dated future and a market priced in something else out of the rows", async () => {
    const x = trader({ markets: [mk("USDC/USDT", "spot", "USDC", "USDT", { price: 1 }), mk("BTC/USDT:USDT-261225", "future", "BTC", "USDT", { price: 101_000 }), mk("ETH/BTC", "spot", "ETH", "BTC", { price: 0.03 }), mk("ETH/USDT", "spot", "ETH", "USDT", { price: 3_000 })] });
    const out = await exploreAcross({ connected: [venue("okx", "OKX", x)] }, { clock });
    expect(out.items.map((i) => i.key)).toEqual(["coin:ETH"]);
  });

  it("keeps a perpetual apart from the coin, by its base, with its funding where the venue says", async () => {
    const x = trader({ markets: [mk("ETH/USDT", "spot", "ETH", "USDT", { price: 3_000, volumeUsd24h: 5e8 }), mk("ETH/USDT:USDT", "perp", "ETH", "USDT", { price: 3_001, volumeUsd24h: 9e8, fundingRate: 0.0001, nextFundingAt: "2026-10-05T16:00:00.000Z" })] });
    const out = await exploreAcross({ connected: [venue("okx", "OKX", x)] }, { clock });
    expect(out.items.find((i) => i.key === "perp:ETH")).toMatchObject({ kind: "perp", name: "ETH perpetual", fundingRate: 0.0001, nextFundingAt: "2026-10-05T16:00:00.000Z", tabs: expect.arrayContaining(["perps"]) });
    expect(out.items.find((i) => i.key === "coin:ETH")?.at[0]?.symbol).toBe("ETH/USDT");
  });

  it("merges stocks by ticker and keeps a Stock Token apart from the share it stands for", async () => {
    const alpaca = trader({ markets: [mk("AAPL", "stock", "AAPL", "USD", { name: "Apple Inc.", price: 230 })] });
    const rh = trader({ markets: [mk("AAPL", "stock", "AAPL", "USD", { name: "AAPL", price: 230.1 })] });
    const tokens = pub("robinhood-stock-tokens", "Robinhood Stock Tokens", { kind: "tokens", connectTo: "robinhood-wallet", connector: "live:wallet", readOnly: "only read here", listings: [mk("AAPL", "token", "AAPL", "USD", { name: "Apple • Robinhood Token", price: 230.4, types: [] })] });
    const out = await exploreAcross({ connected: [venue("alpaca", "Alpaca", alpaca), venue("robinhood", "Robinhood", rh)], public: [tokens] }, { clock });
    expect(out.items.find((i) => i.key === "stock:AAPL")).toMatchObject({ name: "Apple Inc.", at: [{ venue: "alpaca" }, { venue: "robinhood" }] });
    const rwa = out.items.find((i) => i.key === "rwa:AAPL")!;
    expect(rwa).toMatchObject({ kind: "rwa", name: "Apple • Robinhood Token", tabs: expect.arrayContaining(["rwas"]) });
    expect(rwa.at[0]).toMatchObject({ connected: false, canTrade: false, public: true, note: "only read here", connectTo: "robinhood-wallet" });
  });
});

describe("event contracts", () => {
  it("folds a Kalshi market's YES and NO legs into one row with its outcomes, whichever call listed them", async () => {
    const legs = kalshi("KXFED-27APR-T4.00", "Fed above 4.00% after April?", 0.43, { closeTime: iso(NOW + 30 * 24 * HOUR), category: "Economics" });
    const k = trader({ markets: [legs[0]!], events: [legs[0]!, { ...legs[1]!, bid: 0.55, ask: 0.58 }] });
    const out = await exploreAcross({ connected: [venue("kalshi", "Kalshi", k, "live:kalshi")] }, { clock });
    expect(out.items).toHaveLength(1);
    const row = out.items[0]!;
    expect(row).toMatchObject({ key: "kalshi:KXFED-27APR-T4.00", kind: "event", name: "Fed above 4.00% after April?", price: 0.43, category: "Economics" });
    expect(row.outcomes).toEqual([
      { label: "Yes", price: 0.43, at: [{ venue: "kalshi", symbol: "KXFED-27APR-T4.00:YES" }] },
      { label: "No", price: 0.57, bid: 0.55, ask: 0.58, at: [{ venue: "kalshi", symbol: "KXFED-27APR-T4.00:NO" }] },
    ]);
    // the row's venue names its first outcome, as an order there would
    expect(row.at).toEqual([expect.objectContaining({ venue: "kalshi", symbol: "KXFED-27APR-T4.00:YES", connected: true })]);
    expect(k.calls).toEqual(expect.arrayContaining(["markets:", "events:86400000", "events:all"]));
  });

  it("folds a market's named outcomes; one Polymarket market seen connected (mm) and public is one row, traded where it is connected, its volume counted once", async () => {
    const legs = polymarket("brazil-runoff-2026-10-06", "Who wins the run-off?", [["Lula", 0.915], ["Other", 0.085]], { closeTime: iso(NOW + 10 * HOUR), volumeUsd24h: 4.2e6, category: "Politics" });
    const mm = trader({ markets: [], events: legs.map((m, i) => (i === 0 ? { ...m, change24h: 0.44 } : m)) });
    const gamma = pub("polymarket", "Polymarket", { kind: "events", connectTo: "polymarket", connector: "live:polymarket-trade", listings: legs.map((m) => ({ ...m, types: [], volumeUsd24h: 4.25e6 })) });
    const out = await exploreAcross({ connected: [venue("metamask", "MetaMask", mm)], public: [gamma] }, { clock });
    const row = out.items.find((i) => i.key === `pm:${COND}`)!;
    // mm trades it already: Polymarket's public listing of the same market would only say "connect to trade" what can be traded
    expect(row.outcomes?.map((o) => [o.label, o.price, o.at.map((a) => a.venue)])).toEqual([
      ["Lula", 0.915, ["metamask"]],
      ["Other", 0.085, ["metamask"]],
    ]);
    // both report Gamma's volume for the one market: it is counted once, the larger figure, not added up
    // it closes within the day, so it is in Now too; a venue's category makes no tab of its own any more
    expect(row).toMatchObject({ change24h: 0.44, changeFrom: { venue: "metamask" }, volumeUsd24h: 4.25e6, tabs: ["all", "predictions"] });
    expect(row.at.map((a) => [a.venue, a.symbol, a.connected, a.public])).toEqual([["metamask", "brazil-runoff-2026-10-06:Lula", true, false]]);
    // a market mm does not list keeps its public line, to connect to trade
    const other = polymarket("another-market", "Another?", [["Yes", 0.2], ["No", 0.8]], { volumeUsd24h: 1e5 }, `0x${"cd".repeat(32)}`);
    const both = await exploreAcross({ connected: [venue("metamask", "MetaMask", mm)], public: [pub("polymarket", "Polymarket", { kind: "events", connectTo: "polymarket", connector: "live:polymarket-trade", listings: [...legs, ...other].map((m) => ({ ...m, types: [] })) })] }, { clock });
    expect(both.items.find((i) => i.key === `pm:0x${"cd".repeat(32)}`)!.at[0]).toMatchObject({ venue: "polymarket", canTrade: false, connectTo: "polymarket", connector: "live:polymarket-trade" });
  });

  it("a Kalshi market connected carries its own contracts (no public source is asked then), so it still ranks among what closes soon", async () => {
    const soon = iso(NOW + 5 * HOUR);
    const big = kalshi("KXBIG-26OCT05-T1", "Big thing today?", 0.41, { contracts24h: 500_000, closeTime: soon, category: "Economics" });
    const pm = Array.from({ length: 8 }, (_, i) => polymarket(`m${i}`, `E${i}?`, [["Yes", 0.5], ["No", 0.5]], { volumeUsd24h: 20_000, closeTime: soon }, `0x${String(i).repeat(64)}`)).flat();
    const kalshiPublic = pub("kalshi", "Kalshi", { kind: "events", connectTo: "kalshi", connector: "live:kalshi", listings: big.map((m) => ({ ...m, types: [] })) });
    const gamma = pub("polymarket", "Polymarket", { kind: "events", connectTo: "polymarket", connector: "live:polymarket-trade", listings: pm.map((m) => ({ ...m, types: [] })) });
    const out = await exploreAcross({ connected: [venue("kalshi", "Kalshi", trader({ markets: [], events: big }), "live:kalshi")], public: [kalshiPublic, gamma] }, { clock });
    expect(kalshiPublic.asked).toEqual([]);
    expect(out.items.find((i) => i.key === "kalshi:KXBIG-26OCT05-T1")).toMatchObject({ contracts24h: 500_000 });
    expect(out.closing.map((i) => i.key)).toContain("kalshi:KXBIG-26OCT05-T1");
  });

  it("carries Kalshi's contracts as contracts, never as dollars", async () => {
    const gamma = pub("kalshi", "Kalshi", { kind: "events", connectTo: "kalshi", connector: "live:kalshi", listings: kalshi("KXBTCD-26OCT0617-T85749.99", "Bitcoin price on Oct 6, 2026?", 0.31, { contracts24h: 44_565.63, closeTime: iso(NOW + 7 * HOUR), types: [] }) });
    const out = await exploreAcross({ public: [gamma] }, { clock });
    expect(out.items[0]).toMatchObject({ key: "kalshi:KXBTCD-26OCT0617-T85749.99", contracts24h: 44_565.63 });
    expect(out.items[0]?.volumeUsd24h).toBeUndefined();
  });
});

describe("connected and public together", () => {
  it("marks each venue connected or public, says what the connected one may do, and where to connect the public one", async () => {
    const okx = trader({ markets: [mk("SOL/USDT", "spot", "SOL", "USDT", { price: 150, volumeUsd24h: 3e8 })], can: "unknown" });
    const kraken = pub("kraken", "Kraken", { listings: [mk("SOL/USD", "spot", "SOL", "USD", { price: 150.2, volumeUsd24h: 4e7, types: [] })] });
    const out = await exploreAcross({ connected: [venue("okx", "OKX", okx)], public: [kraken] }, { clock });
    const sol = out.items.find((i) => i.key === "coin:SOL")!;
    expect(sol.at).toEqual([
      { venue: "okx", venueName: "OKX", symbol: "SOL/USDT", connected: true, canTrade: "unknown", public: false, price: 150, open: true },
      { venue: "kraken", venueName: "Kraken", symbol: "SOL/USD", connected: false, canTrade: false, public: true, price: 150.2, open: true, connectTo: "kraken", connector: "live:exchange:kraken" },
    ]);
    expect(sol.volumeUsd24h).toBe(3e8 + 4e7);
  });

  it("does not ask a public source for a venue that is connected: the venue speaks for itself", async () => {
    const okx = trader({ markets: [mk("BTC/USDT", "spot", "BTC", "USDT", { price: 100_000 })] });
    const okxPublic = pub("okx", "OKX", { listings: [mk("BTC/USDT", "spot", "BTC", "USDT", { price: 100_000, types: [] })] });
    const kalshiPublic = pub("kalshi", "Kalshi", { kind: "events", connectTo: "kalshi", connector: "live:kalshi", listings: [] });
    const out = await exploreAcross({ connected: [venue("okx", "OKX", okx), venue("my-kalshi", "Kalshi", trader({}), "live:kalshi")], public: [okxPublic, kalshiPublic] }, { clock });
    expect(okxPublic.asked).toEqual([]);
    expect(kalshiPublic.asked).toEqual([]);
    expect(out.items.find((i) => i.key === "coin:BTC")?.at).toHaveLength(1);
  });

  it("shows a connected venue that refuses this location as canTrade false, in its own words", async () => {
    const pm = trader({ can: false, whyNot: "Polymarket does not take orders from this location", events: polymarket("will-x", "Will X?", [["Yes", 0.2], ["No", 0.8]], { closeTime: iso(NOW + 48 * HOUR) }) });
    const out = await exploreAcross({ connected: [venue("polymarket", "Polymarket", pm, "live:polymarket-trade")] }, { clock });
    expect(out.items[0]?.at[0]).toMatchObject({ connected: true, canTrade: false, note: "Polymarket does not take orders from this location" });
  });

  it("asks a venue's stats for the markets its listing gives no 24-hour figure for, and only those", async () => {
    const x = trader({ markets: [mk("BTC/USDT", "spot", "BTC", "USDT", { price: 100_000 }), mk("ETH/USDT", "spot", "ETH", "USDT", { price: 3_000, changePct24h: -1, volumeUsd24h: 4e8 })], stats: { "BTC/USDT": { changePct24h: 3.2, change24h: 3_100, volumeUsd24h: 1.1e9, high24h: 101_000 } } });
    const out = await exploreAcross({ connected: [venue("okx", "OKX", x)] }, { clock });
    expect(x.calls).toContain("stats:BTC/USDT");
    expect(out.items.find((i) => i.key === "coin:BTC")).toMatchObject({ changePct24h: 3.2, change24h: 3_100, volumeUsd24h: 1.1e9 });
  });
});

describe("the median guard", () => {
  it("leaves out a price more than 10% from the middle of three or more venues, and says why", async () => {
    const a = trader({ markets: [mk("PEPE/USDT", "spot", "PEPE", "USDT", { price: 0.00001, volumeUsd24h: 5e8 })] });
    const b = pub("kraken", "Kraken", { listings: [mk("PEPE/USD", "spot", "PEPE", "USD", { price: 0.0000102, volumeUsd24h: 2e7, types: [] })] });
    const c = trader({ markets: [mk("PEPE/USDC@Base", "token", "PEPE", "USDC", { price: 0.0042 })] });
    const out = await exploreAcross({ connected: [venue("okx", "OKX", a), venue("wallet", "Wallet", c)], public: [b] }, { clock });
    const row = out.items.find((i) => i.key === "coin:PEPE")!;
    expect(row.at.map((x) => x.venue)).toEqual(["okx", "kraken"]);
    expect(out.missing).toEqual([expect.objectContaining({ venue: "wallet", symbol: "PEPE/USDC@Base", connected: true, why: expect.stringContaining("more than 10% from the other venues'") })]);
  });

  it("does not judge two venues against each other", async () => {
    const a = trader({ markets: [mk("X/USDT", "spot", "X", "USDT", { price: 1 })] });
    const b = trader({ markets: [mk("X/USD", "spot", "X", "USD", { price: 2 })] });
    const out = await exploreAcross({ connected: [venue("a", "A", a), venue("b", "B", b)] }, { clock });
    expect(out.items[0]?.at).toHaveLength(2);
    expect(out.missing).toEqual([]);
  });
});

describe("tabs", () => {
  it("shows a tab only when something is in it, in the screen's order", async () => {
    const x = trader({ markets: [mk("BTC/USDT", "spot", "BTC", "USDT", { price: 100_000, volumeUsd24h: 2e9, changePct24h: 1 })] });
    const out = await exploreAcross({ connected: [venue("okx", "OKX", x)] }, { clock });
    expect(out.tabs).toEqual([
      { id: "all", label: "All", count: 1 },
      { id: "crypto", label: "Crypto", count: 1 },
    ]);
    expect(out.items[0]?.tabs).toEqual(["all", "crypto"]);
  });

  it("makes no tab of a venue's category: every event is Predictions, and its category is the venue's own word for the card", async () => {
    const k = trader({ events: [...kalshi("KXCPI-26OCT", "CPI above 3%?", 0.4, { category: "Economics" }), ...kalshi("KXNFL-1", "Falcons win?", 0.6, { category: "Sports" }), ...kalshi("KXPRES-1", "Who wins?", 0.5, { category: "Elections" })] });
    const pmTagged = polymarket("brazil", "Brazil election", [["Yes", 0.5], ["No", 0.5]], { tags: ["Politics", "Macro Election 2", "World"], category: "Politics" }, `0x${"cd".repeat(32)}`);
    const gamma = pub("polymarket", "Polymarket", { kind: "events", connectTo: "polymarket", connector: "live:polymarket-trade", listings: pmTagged });
    const out = await exploreAcross({ connected: [venue("kalshi", "Kalshi", k)], public: [gamma] }, { clock });
    // the owner asked for a few hot markets, not every bet: an event under an excluded category (sports here) is not one of the few even
    // when a venue the owner connected lists it — a search still finds it, under the venue's own word
    expect(out.tabs.map((t) => [t.id, t.count])).toEqual([["all", 3], ["predictions", 3]]);
    expect(out.items.map((i) => [i.key, i.category, i.tabs])).toEqual(
      expect.arrayContaining([
        ["kalshi:KXCPI-26OCT", "Economics", ["all", "predictions"]],
        ["kalshi:KXPRES-1", "Elections", ["all", "predictions"]],
        [`pm:${"0x" + "cd".repeat(32)}`, "Politics", ["all", "predictions"]],
      ]),
    );
    expect(out.items.some((i) => i.key === "kalshi:KXNFL-1")).toBe(false);
    expect(out.notes).toContain("Predictions: at most 12 rows, each venue's busiest in turn, without sports, weather and entertainment; a search reaches everything the venues' listings loaded.");
    const searched = await exploreAcross({ connected: [venue("kalshi", "Kalshi", k)], public: [gamma] }, { clock, q: "falcons" });
    expect(searched.items.map((i) => [i.key, i.category])).toEqual([["kalshi:KXNFL-1", "Sports"]]);
  });

  it("reads a category word whole, without regard to case or punctuation, and prefers the table's word among a venue's several", () => {
    expect(roleOfCategory("Fed Rates")).toBe("shown");
    expect(roleOfCategory("fed-rates")).toBe("shown");
    expect(roleOfCategory("NFL (All)")).toBe("excluded");
    expect(roleOfCategory("Hide From New")).toBe("plumbing");
    expect(roleOfCategory("Macro Election 2")).toBeUndefined();
    expect(isExcludedCategory(["Politics", "Sports", undefined, "Games"])).toBe(true);
    expect(isExcludedCategory(["Politics", "World", undefined])).toBe(false);
    // Gamma's "Fed Decision in October?" carries Fed, fomc, Trump, Economy and Fed Rates: the card reads "Fed Rates"
    expect(categoryOf(["Fed", "fomc", "Trump", "Economy", "Fed Rates"])).toBe("Fed Rates");
    // the venue's plumbing is never the category (public F5)
    expect(categoryOf(["Parent For Derivative", "United States", "US Election", "Politics"])).toBe("Politics");
    expect(categoryOf(["putin", "Geopolitics", "Ukraine", "Politics"])).toBe("Politics");
    expect(categoryOf(["Games", "Sports", "NFL"])).toBe("Sports");
    expect(categoryOf(["Politics", "World"])).toBe("Politics");
    // nothing the table names: the first word that is not plumbing, in title case when the venue wrote it in lower case
    expect(categoryOf(["Rewards 20", "4.5", "50", "pedro sanchez"])).toBe("Pedro Sanchez");
    expect(categoryOf(["Hide From New", "Recurring", "1H"])).toBeUndefined();
  });
});

describe("the Predictions list", () => {
  /** nine Kalshi markets (contracts) and nine Polymarket markets (dollars), each venue's busiest first, all closing within the day */
  const kalshiNine = Array.from({ length: 9 }, (_, i) => kalshi(`KXK-${i}`, `Kalshi question ${i}?`, 0.5, { contracts24h: 90_000 - i * 10_000, closeTime: iso(NOW + (i + 2) * HOUR), category: "Economics", types: [] })).flat();
  const pmNine = Array.from({ length: 9 }, (_, i) => polymarket(`pm-${i}`, `Polymarket question ${i}?`, [["Yes", 0.5], ["No", 0.5]], { volumeUsd24h: 500_000 - i * 50_000, closeTime: iso(NOW + (i + 2) * HOUR), category: "Politics", types: [] }, `0x${String(i).repeat(64)}`)).flat();
  const sources = () => ({ public: [pub("kalshi", "Kalshi", { kind: "events", connectTo: "kalshi", connector: "live:kalshi", listings: kalshiNine }), pub("polymarket", "Polymarket", { kind: "events", connectTo: "polymarket", connector: "live:polymarket-trade", listings: pmNine })] });

  it("shows at most twelve event rows when nothing is searched for: each venue's busiest in turn, the venue with the busiest row first; what closes soon is drawn from the same few", async () => {
    const out = await exploreAcross(sources(), { clock, tab: "predictions" });
    expect(out.items).toHaveLength(PREDICTIONS_MAX);
    // Polymarket's $500,000 row is the busiest (a Kalshi contract counts a dollar only to order), so Polymarket leads and the venues alternate
    expect(out.items.map((i) => i.key)).toEqual([`pm:0x${"0".repeat(64)}`, "kalshi:KXK-0", `pm:0x${"1".repeat(64)}`, "kalshi:KXK-1", `pm:0x${"2".repeat(64)}`, "kalshi:KXK-2", `pm:0x${"3".repeat(64)}`, "kalshi:KXK-3", `pm:0x${"4".repeat(64)}`, "kalshi:KXK-4", `pm:0x${"5".repeat(64)}`, "kalshi:KXK-5"]);
    expect(out.tabs).toEqual([
      { id: "all", label: "All", count: PREDICTIONS_MAX },
      { id: "predictions", label: "Predictions", count: PREDICTIONS_MAX },
    ]);
    // the seventh busiest of either venue closes within the day too, and is in neither the list nor what closes soon
    expect(out.closing.length).toBe(8);
    expect(out.closing.every((c) => out.items.some((i) => i.key === c.key))).toBe(true);
    expect(out.notes).toContain(`Predictions: at most ${PREDICTIONS_MAX} rows, each venue's busiest in turn, without sports, weather and entertainment; a search reaches everything the venues' listings loaded.`);
    // asked for every row, the dropped event rows are still gone: the page's "All results" is the same few
    const every = await exploreAcross(sources(), { clock });
    expect(every.items.filter((i) => i.kind === "event")).toHaveLength(PREDICTIONS_MAX);
    // a sort asked for sorts the same few
    const soonest = await exploreAcross(sources(), { clock, tab: "predictions", sort: "closing" });
    expect(soonest.items.map((i) => i.key).slice(0, 2)).toEqual([`pm:0x${"0".repeat(64)}`, "kalshi:KXK-0"]);
    expect(soonest.items).toHaveLength(PREDICTIONS_MAX);
  });

  it("orders a Polymarket row by its whole event's dollars where Gamma gives them, and keeps the row's volume the market's own", async () => {
    // the Fed decision: one hot event ($880,418) spread over five markets, its busiest $254,692; a quieter event whose one market trades more
    const fed = polymarket("fed-decreases-50", "Will the Fed decrease rates by 50+ bps?", [["Yes", 0.02], ["No", 0.98]], { volumeUsd24h: 254_692, eventVolumeUsd24h: 880_418, types: [] } as Partial<Listing>, `0x${"01".repeat(32)}`);
    const one = polymarket("one-market-event", "One question?", [["Yes", 0.5], ["No", 0.5]], { volumeUsd24h: 300_000, eventVolumeUsd24h: 300_000, types: [] } as Partial<Listing>, `0x${"02".repeat(32)}`);
    const out = await exploreAcross({ public: [pub("polymarket", "Polymarket", { kind: "events", connectTo: "polymarket", connector: "live:polymarket-trade", listings: [...one, ...fed] })] }, { clock, tab: "predictions" });
    expect(out.items.map((i) => [i.key, i.volumeUsd24h, i.eventVolumeUsd24h])).toEqual([
      [`pm:0x${"01".repeat(32)}`, 254_692, 880_418],
      [`pm:0x${"02".repeat(32)}`, 300_000, 300_000],
    ]);
  });

  it("with a search, every event row that matches is shown, however many, and the sentence about the few is not said", async () => {
    const out = await exploreAcross(sources(), { clock, q: "question" });
    expect(out.items).toHaveLength(18);
    expect(out.notes.some((n) => n.startsWith("Predictions:"))).toBe(false);
  });

  it("carries what the sources say of their lists, each sentence once and under 160 characters", async () => {
    const tokens = { ...pub("robinhood-stock-tokens", "Robinhood Stock Tokens", { kind: "tokens", connectTo: "robinhood-wallet", connector: "live:wallet", readOnly: "only read here", listings: [mk("AAPL", "token", "AAPL", "USD", { price: 230, types: [] })] }), notes: () => ["Robinhood Stock Tokens: 40 of 194 shown · search for the rest"] };
    const said = "Kalshi: the busiest market in each of 10 series — Fed decision, CPI.";
    const k = { ...pub("kalshi", "Kalshi", { kind: "events", connectTo: "kalshi", connector: "live:kalshi", listings: kalshiNine.slice(0, 2) }), notes: () => [said, "  "] };
    const again = { ...pub("kalshi-2", "Kalshi again", { kind: "events", connectTo: "kalshi", connector: "live:kalshi", listings: [] }), notes: () => [said] };
    const out = await exploreAcross({ public: [tokens, k, again] }, { clock });
    expect(out.notes).toEqual(["Robinhood Stock Tokens: 40 of 194 shown · search for the rest", said, `Predictions: at most ${PREDICTIONS_MAX} rows, each venue's busiest in turn, without sports, weather and entertainment; a search reaches everything the venues' listings loaded.`]);
    expect(out.notes.every((n) => n.length < 160)).toBe(true);
    // a source without a word to say, or one whose words cannot be read, says nothing
    const mute = { ...pub("okx", "OKX", { listings: [mk("BTC/USDT", "spot", "BTC", "USDT", { price: 1, types: [] })] }), notes: () => { throw new Error("no words"); } };
    expect((await exploreAcross({ public: [mute] }, { clock })).notes).toEqual([]);
    // a source is told what was searched for, so it can hold its "N of M shown" for the whole list only
    const asked: string[] = [];
    const counted = { ...tokens, notes: (o: { q?: string | undefined }) => (asked.push(o.q ?? ""), o.q ? [] : ["Robinhood Stock Tokens: 40 of 194 shown · search for the rest"]) };
    expect((await exploreAcross({ public: [counted] }, { clock, q: "nvda" })).notes).toEqual([]);
    expect(asked).toEqual(["nvda"]);
  });
});

describe("an event past its close", () => {
  const k = (listings: Listing[]) => pub("kalshi", "Kalshi", { kind: "events", connectTo: "kalshi", connector: "live:kalshi", listings });
  const p = (listings: Listing[]) => pub("polymarket", "Polymarket", { kind: "events", connectTo: "polymarket", connector: "live:polymarket-trade", listings });

  it("is closed at Kalshi whatever the listing says, keeps Polymarket's own open flag, and says pastEnd on the row and its leg either way", async () => {
    const kalshiLegs = kalshi("KXBTCD-26OCT0514-T85000", "Bitcoin above $85,000 at 2pm?", 0.6, { closeTime: iso(NOW - HOUR), contracts24h: 1_000, category: "Crypto", types: [] });
    // Gamma's own answer for the Lula market on 2026-10-06: endDate the day before, active, not closed, accepting orders
    const pmLegs = polymarket("lula-2026", "Will Lula win?", [["Yes", 0.155], ["No", 0.845]], { closeTime: iso(NOW - 10 * HOUR), volumeUsd24h: 1_185_573, types: [] });
    const out = await exploreAcross({ public: [k(kalshiLegs), p(pmLegs)] }, { clock });
    expect(out.items.find((i) => i.key === "kalshi:KXBTCD-26OCT0514-T85000")).toMatchObject({ pastEnd: true, at: [expect.objectContaining({ venue: "kalshi", open: false, pastEnd: true })] });
    expect(out.items.find((i) => i.key === `pm:${COND}`)).toMatchObject({ pastEnd: true, at: [expect.objectContaining({ venue: "polymarket", open: true, pastEnd: true })] });
    // neither is in what closes soon: the window starts now
    expect(out.closing).toEqual([]);
    // a market still to close carries neither
    const live = await exploreAcross({ public: [k(kalshi("KXA-1", "A?", 0.3, { closeTime: iso(NOW + HOUR), types: [] }))] }, { clock });
    expect(live.items[0]?.pastEnd).toBeUndefined();
    expect(live.items[0]?.at[0]).toMatchObject({ open: true });
    expect(live.items[0]?.at[0]?.pastEnd).toBeUndefined();
  });
});

describe("a venue's line", () => {
  it("carries the venue's own bid and ask beside its price, for a coin and for an event's lead outcome", async () => {
    const kraken = pub("kraken", "Kraken", { listings: [mk("BTC/USD", "spot", "BTC", "USD", { price: 100_000, bid: 99_990, ask: 100_010, volumeUsd24h: 4e7, types: [] })] });
    const legs = kalshi("KXFED-27APR-T4.00", "Fed above 4.00% after April?", 0.43, { closeTime: iso(NOW + 30 * 24 * HOUR), types: [] }).map((m, i) => (i === 0 ? { ...m, bid: 0.42, ask: 0.45 } : m));
    const out = await exploreAcross({ public: [kraken, pub("kalshi", "Kalshi", { kind: "events", connectTo: "kalshi", connector: "live:kalshi", listings: legs })] }, { clock });
    expect(out.items.find((i) => i.key === "coin:BTC")?.at[0]).toMatchObject({ venue: "kraken", price: 100_000, bid: 99_990, ask: 100_010 });
    expect(out.items.find((i) => i.key === "kalshi:KXFED-27APR-T4.00")?.at[0]).toMatchObject({ venue: "kalshi", symbol: "KXFED-27APR-T4.00:YES", price: 0.43, bid: 0.42, ask: 0.45 });
  });

  it("a read-only listing's line is a price and not a connection to make, once the row trades at a connected venue", async () => {
    const nvda = mk("NVDA/USDG@Robinhood Chain", "token", "NVDA", "USDG", { name: "NVIDIA Stock Token on Robinhood Chain", price: 180, types: ["market"], category: "RWA", issuer: "Robinhood", eligibility: "not for US persons" });
    const tokens = pub("robinhood-stock-tokens", "Robinhood Stock Tokens", { kind: "tokens", connectTo: "robinhood-wallet", connector: "live:wallet", readOnly: "Robinhood's own prices", listings: [mk("NVDA", "token", "NVDA", "USD", { name: "NVIDIA", price: 181, bid: 180.9, ask: 181.1, types: [] })] });
    const out = await exploreAcross({ connected: [venue("wallet", "Browser wallet", trader({ markets: [nvda] }), "live:wallet")], public: [tokens] }, { clock });
    const row = out.items.find((i) => i.key === "rwa:NVDA")!;
    expect(row.at.map((a) => [a.venue, a.connected, a.canTrade, a.connectTo, a.connector])).toEqual([
      ["wallet", true, true, undefined, undefined],
      ["robinhood-stock-tokens", false, false, undefined, undefined],
    ]);
    expect(row.at[1]).toMatchObject({ public: true, price: 181, bid: 180.9, ask: 181.1, note: "Robinhood's own prices" });
    // with no wallet connected the line offers the connection, as before
    const alone = await exploreAcross({ public: [tokens] }, { clock });
    expect(alone.items[0]?.at[0]).toMatchObject({ public: true, connectTo: "robinhood-wallet", connector: "live:wallet" });
    // a wallet connected that may not trade leaves the offer too
    const cannot = await exploreAcross({ connected: [venue("wallet", "Browser wallet", trader({ markets: [nvda], can: false, whyNot: "the wallet is read-only here" }), "live:wallet")], public: [tokens] }, { clock });
    expect(cannot.items.find((i) => i.key === "rwa:NVDA")?.at[1]).toMatchObject({ connectTo: "robinhood-wallet" });
  });
});

describe("order among ties", () => {
  it("rows that report no volume keep their source's order — Robinhood's well-known tokens first, not the alphabet", async () => {
    const tokens = pub("robinhood-stock-tokens", "Robinhood Stock Tokens", { kind: "tokens", connectTo: "robinhood-wallet", connector: "live:wallet", readOnly: "only read here", listings: ["NVDA", "AAPL", "MSFT", "AEHR"].map((s) => mk(s, "token", s, "USD", { name: `${s} • Robinhood Token`, price: 100, types: [] })) });
    const out = await exploreAcross({ public: [tokens] }, { clock, tab: "rwas" });
    expect(out.items.map((i) => i.base)).toEqual(["NVDA", "AAPL", "MSFT", "AEHR"]);
  });
});

describe("movers, closing, all", () => {
  it("counts a mover only above the 24-hour dollar volume floor, biggest change first, and says which venue the change is from", async () => {
    const x = trader({
      markets: [
        mk("BTC/USDT", "spot", "BTC", "USDT", { price: 100_000, volumeUsd24h: 2e9, changePct24h: 1.5 }),
        mk("ETH/USDT", "spot", "ETH", "USDT", { price: 3_000, volumeUsd24h: 8e8, changePct24h: -6 }),
        mk("THIN/USDT", "spot", "THIN", "USDT", { price: 0.1, volumeUsd24h: 40_000, changePct24h: 80 }),
        mk("NOVOL/USDT", "spot", "NOVOL", "USDT", { price: 0.1, changePct24h: 50 }),
      ],
    });
    const out = await exploreAcross({ connected: [venue("okx", "OKX", x)] }, { clock });
    expect(out.movers.map((m) => [m.key, m.changePct24h, m.changeFrom?.venue])).toEqual([
      ["coin:ETH", -6, "okx"],
      ["coin:BTC", 1.5, "okx"],
    ]);
    const lower = await exploreAcross({ connected: [venue("okx", "OKX", x)] }, { clock, moversMinUsd: { coin: 10_000 } });
    expect(lower.movers.map((m) => m.key)).toEqual(["coin:THIN", "coin:ETH", "coin:BTC"]);
    // a perpetual's floor is ten times a coin's: a $5M perpetual's jump is not news, a $5M coin's is
    const perps = trader({ markets: [mk("PONS/USDC:USDC", "perp", "PONS", "USDC", { price: 0.1, volumeUsd24h: 5e6, changePct24h: 40 }), mk("AVAX/USDT", "spot", "AVAX", "USDT", { price: 30, volumeUsd24h: 5e6, changePct24h: 9 }), mk("BTC/USDC:USDC", "perp", "BTC", "USDC", { price: 100_000, volumeUsd24h: 1.8e9, changePct24h: 1 })] });
    const thin = await exploreAcross({ connected: [venue("hl", "HL", perps)] }, { clock });
    expect(thin.movers.map((m) => m.key)).toEqual(["coin:AVAX", "perp:BTC"]);
    const sorted = await exploreAcross({ connected: [venue("okx", "OKX", x)] }, { clock, sort: "movers" });
    expect(sorted.items.map((i) => i.key)).toEqual(["coin:THIN", "coin:NOVOL", "coin:ETH", "coin:BTC"]);
  });

  it("lists what closes within the window, the busiest of it, soonest first; nothing past or later", async () => {
    const events = [
      ...polymarket("late", "Closes in 20h", [["Yes", 0.5], ["No", 0.5]], { closeTime: iso(NOW + 20 * HOUR), volumeUsd24h: 9e6 }, `0x${"01".repeat(32)}`),
      ...polymarket("soon", "Closes in 1h", [["Yes", 0.5], ["No", 0.5]], { closeTime: iso(NOW + 1 * HOUR), volumeUsd24h: 2e6 }, `0x${"02".repeat(32)}`),
      ...polymarket("mid", "Closes in 5h", [["Yes", 0.5], ["No", 0.5]], { closeTime: iso(NOW + 5 * HOUR), volumeUsd24h: 1e3 }, `0x${"03".repeat(32)}`),
      ...polymarket("past", "Closed an hour ago", [["Yes", 0.5], ["No", 0.5]], { closeTime: iso(NOW - HOUR), volumeUsd24h: 5e7 }, `0x${"04".repeat(32)}`),
      ...polymarket("week", "Closes in a week", [["Yes", 0.5], ["No", 0.5]], { closeTime: iso(NOW + 7 * 24 * HOUR), volumeUsd24h: 8e7 }, `0x${"05".repeat(32)}`),
    ];
    const gamma = pub("polymarket", "Polymarket", { kind: "events", connectTo: "polymarket", connector: "live:polymarket-trade", listings: events, events: events.filter((m) => Date.parse(m.closeTime!) > NOW && Date.parse(m.closeTime!) <= NOW + 24 * HOUR) });
    const out = await exploreAcross({ public: [gamma] }, { clock });
    expect(out.closing.map((i) => i.name)).toEqual(["Closes in 1h", "Closes in 5h", "Closes in 20h"]);
    // two at most: the busiest two, still soonest first
    const two = await exploreAcross({ public: [gamma] }, { clock, top: 2 });
    expect(two.closing.map((i) => i.name)).toEqual(["Closes in 1h", "Closes in 20h"]);
    const byClose = await exploreAcross({ public: [gamma] }, { clock, sort: "closing" });
    expect(byClose.items.map((i) => i.name)).toEqual(["Closes in 1h", "Closes in 5h", "Closes in 20h", "Closes in a week", "Closed an hour ago"]);
  });

  it("All is every row as one table, by volume, and the body still carries what closes within a day, the movers and the most traded for agents", async () => {
    const x = trader({
      markets: [mk("BTC/USDT", "spot", "BTC", "USDT", { price: 100_000, volumeUsd24h: 2e9, changePct24h: 1 }), mk("DOGE/USDT", "spot", "DOGE", "USDT", { price: 0.2, volumeUsd24h: 3e6, changePct24h: 12 })],
      events: kalshi("KXBTCD-1", "Bitcoin above 100k today?", 0.5, { closeTime: iso(NOW + 3 * HOUR), volumeUsd24h: 5e5 }),
    });
    const out = await exploreAcross({ connected: [venue("somewhere", "Somewhere", x)] }, { clock, tab: "all" });
    expect(out.items.map((i) => i.key)).toEqual(["coin:BTC", "coin:DOGE", "event:somewhere:KXBTCD-1"]);
    // every row's tabs start with All; All is the first tab and counts every row
    expect(out.items.every((i) => i.tabs[0] === "all")).toBe(true);
    expect(out.tabs[0]).toEqual({ id: "all", label: "All", count: 3 });
    expect(out.tabs.map((t) => t.id)).toEqual(["all", "crypto", "predictions"]);
    // no tab asked is the same list
    expect((await exploreAcross({ connected: [venue("somewhere", "Somewhere", x)] }, { clock })).items.map((i) => i.key)).toEqual(["coin:BTC", "coin:DOGE", "event:somewhere:KXBTCD-1"]);
    expect(out.mostTraded.map((i) => i.key)).toEqual(["coin:BTC", "coin:DOGE"]);
    expect(out.movers.map((i) => i.key)).toEqual(["coin:DOGE", "coin:BTC"]);
    expect(out.closing.map((i) => i.key)).toEqual(["event:somewhere:KXBTCD-1"]);
  });

  it("filters by a query over every venue's symbols and names", async () => {
    const x = trader({ markets: [mk("BTC/USDT", "spot", "BTC", "USDT", { name: "Bitcoin / Tether", price: 100_000 }), mk("ETH/USDT", "spot", "ETH", "USDT", { price: 3_000 })] });
    const out = await exploreAcross({ connected: [venue("okx", "OKX", x)] }, { clock, q: "bitcoin" });
    expect(out.items.map((i) => i.key)).toEqual(["coin:BTC"]);
    expect(x.calls).toContain("markets:bitcoin");
  });
});

describe("pre-IPO perpetuals: one row per company", () => {
  const UNIT = "a price of $1 stands for $1,000,000,000 of implied company valuation (one contract ≈ one-billionth of the company)";
  const OKX_UNIT = "OKX: a price of $1 stands for $10,000,000,000 of implied company valuation since its 10:1 rebase of 30 June 2026";
  const anthropic = { id: "preipo:anthropic", title: "Anthropic" };
  /** a venue's pre-IPO perpetual as public-markets.ts lists it, or as a connected key's trader lists it (no price: its stats bring one) */
  const pre = (symbol: string, base: string, quote: string, price: number | undefined, perPoint: number, extra: Partial<Listing> = {}): Listing =>
    mk(symbol, "perp", base, quote, { ...(price !== undefined ? { price } : {}), category: "Pre-IPO", group: anthropic, implied: { perPoint, unit: perPoint === 1e10 ? OKX_UNIT : UNIT, ...(price !== undefined ? { usd: Math.round(price * perPoint) } : {}) }, issuer: "Anthropic", eligibility: "Anthropic, 29 June 2026: unapproved transfers are void", types: [], ...extra });

  it("folds the contracts at every venue into the company's row — OKX's 214 in its $10B unit beside Gate's 2,140 in the $1B unit — each line with its own price and implied valuation, the row's the median; it is Pre-IPO, not Perps", async () => {
    const okx = pub("okx-preipo", "OKX", { listings: [pre("ANTHROPIC/USDT:USDT", "ANTHROPIC", "USDT", 214.51, 1e10, { volumeUsd24h: undefined, changePct24h: 2.07, fundingRate: 0, nextFundingAt: "2026-10-07T00:00:00.000Z" })], connectTo: "okx", connector: "live:exchange:okx" });
    const gate = pub("gate-preipo", "Gate", { listings: [pre("ANTHROPIC/USDT:USDT", "ANTHROPIC", "USDT", 2139.8, 1e9, { volumeUsd24h: 651_204, changePct24h: 1.9 })], connectTo: "gate", connector: "live:exchange:gate" });
    const deribit = pub("deribit-preipo", "Deribit", { listings: [pre("ANTH/USDC:USDC", "ANTH", "USDC", 2078.81, 1e9, { volumeUsd24h: 330_972.78, changePct24h: 1.69 })], connectTo: "deribit", connector: "live:exchange:deribit" });
    const out = await exploreAcross({ public: [okx, gate, deribit] }, { clock });
    expect(out.items).toHaveLength(1);
    const row = out.items[0]!;
    expect(row).toMatchObject({ key: "preipo:anthropic", kind: "perp", name: "Anthropic", base: "ANTHROPIC", category: "Pre-IPO", group: anthropic, tabs: ["all", "preipo"], issuer: "Anthropic", eligibility: "Anthropic, 29 June 2026: unapproved transfers are void", volumeUsd24h: 651_204 + 330_972.78, changePct24h: 1.9, changeFrom: { venue: "gate-preipo", venueName: "Gate" } });
    // the median implied valuation (2.145T, 2.1398T, 2.0788T → 2.1398T) and the row's price in the $1-per-$1B convention; no change24h (the units differ)
    expect(row.implied).toEqual({ usd: 2_139_800_000_000, unit: "the median of 3 venues' implied valuations (each venue's own contract price and unit are on its line)" });
    expect(row.price).toBe(2139.8);
    expect(row.change24h).toBeUndefined();
    // each venue's line keeps its own contract price and implied valuation in its own unit; the busiest first
    expect(row.at.map((a) => [a.venue, a.symbol, a.price, a.implied, a.connectTo])).toEqual([
      ["gate-preipo", "ANTHROPIC/USDT:USDT", 2139.8, { usd: 2_139_800_000_000, unit: UNIT }, "gate"],
      ["deribit-preipo", "ANTH/USDC:USDC", 2078.81, { usd: 2_078_810_000_000, unit: UNIT }, "deribit"],
      ["okx-preipo", "ANTHROPIC/USDT:USDT", 214.51, { usd: 2_145_100_000_000, unit: OKX_UNIT }, "okx"],
    ]);
    // Pre-IPO is its tab; Perps has nothing here
    expect(out.tabs.map((t) => [t.id, t.count])).toEqual([["all", 1], ["preipo", 1]]);
    expect((await exploreAcross({ public: [okx, gate, deribit] }, { clock, tab: "preipo" })).items.map((i) => i.key)).toEqual(["preipo:anthropic"]);
    expect((await exploreAcross({ public: [okx, gate, deribit] }, { clock, tab: "perps" })).items).toEqual([]);
    expect(out.notes).toContain("Pre-IPO perpetuals are contracts on a venue's estimate of a private company's valuation, not shares; each venue says who may trade them once a key connects.");
    expect(out.notes.every((n) => n.length < 160)).toBe(true);
    // a search by the company's name
    expect((await exploreAcross({ public: [okx, gate, deribit] }, { clock, q: "anthropic" })).items.map((i) => i.key)).toEqual(["preipo:anthropic"]);
  });

  it("a connected key's contract is the row's line to trade — its unit from its list, its price from its stats — and the venue's public source is not asked", async () => {
    const key = trader({ markets: [pre("ANTHROPIC/USDT:USDT", "ANTHROPIC", "USDT", undefined, 1e10)], stats: { "ANTHROPIC/USDT:USDT": { price: 214.6, changePct24h: 2.1, volumeUsd24h: 520_000 } } });
    const okxPublic = pub("okx-preipo", "OKX", { listings: [pre("ANTHROPIC/USDT:USDT", "ANTHROPIC", "USDT", 214.51, 1e10)], connectTo: "okx", connector: "live:exchange:okx" });
    const gate = pub("gate-preipo", "Gate", { listings: [pre("ANTHROPIC/USDT:USDT", "ANTHROPIC", "USDT", 2139.8, 1e9, { volumeUsd24h: 651_204 })], connectTo: "gate", connector: "live:exchange:gate" });
    const out = await exploreAcross({ connected: [venue("okx", "OKX", key, "live:exchange:okx")], public: [okxPublic, gate] }, { clock });
    expect(okxPublic.asked).toEqual([]);
    const row = out.items.find((i) => i.key === "preipo:anthropic")!;
    expect(row.at.map((a) => [a.venue, a.connected, a.canTrade, a.price, a.implied?.usd, a.connectTo])).toEqual([
      ["gate-preipo", false, false, 2139.8, 2_139_800_000_000, "gate"],
      ["okx", true, true, 214.6, 2_146_000_000_000, undefined],
    ]);
    // two venues: the median of two is their middle
    expect(row.implied?.usd).toBe(2_142_900_000_000);
    expect(row.price).toBe(2142.9);
  });

  it("the median guard runs on the implied valuation, never on the contract price: a venue 20% away is set aside and said", async () => {
    const okx = pub("okx-preipo", "OKX", { listings: [pre("ANTHROPIC/USDT:USDT", "ANTHROPIC", "USDT", 214.51, 1e10)], connectTo: "okx", connector: "live:exchange:okx" });
    const gate = pub("gate-preipo", "Gate", { listings: [pre("ANTHROPIC/USDT:USDT", "ANTHROPIC", "USDT", 2139.8, 1e9)], connectTo: "gate", connector: "live:exchange:gate" });
    const odd = pub("odd-preipo", "Odd", { listings: [pre("ANTHROPIC/USDT:USDT", "ANTHROPIC", "USDT", 1600, 1e9)], connectTo: "odd", connector: "live:exchange:odd" });
    const out = await exploreAcross({ public: [okx, gate, odd] }, { clock });
    expect(out.items[0]?.at.map((a) => a.venue).sort()).toEqual(["gate-preipo", "okx-preipo"]);
    expect(out.missing).toEqual([expect.objectContaining({ venue: "odd-preipo", symbol: "ANTHROPIC/USDT:USDT", connected: false, why: expect.stringContaining("an implied 1600000000000 in its unit, more than 10% from the other venues' 2139800000000 for Anthropic") })]);
    // a single venue: its own unit sentence is the row's
    const alone = await exploreAcross({ public: [okx] }, { clock });
    expect(alone.items[0]?.implied).toEqual({ usd: 2_145_100_000_000, unit: OKX_UNIT });
    expect(alone.items[0]?.price).toBe(2145.1);
  });

  it("the IPO questions stay in Predictions beside the busiest few whatever their volume, as Predictions and not Pre-IPO, so the company drawer can name them", async () => {
    const kalshiNine = Array.from({ length: 9 }, (_, i) => kalshi(`KXK-${i}`, `Kalshi question ${i}?`, 0.5, { contracts24h: 90_000 - i * 10_000, closeTime: iso(NOW + (i + 2) * HOUR), category: "Economics", types: [] })).flat();
    const ipoK = kalshi("KXIPOANTHROPIC-DATE-26DEC01", "When will Anthropic officially announce an IPO? (Dec 1, 2026)", 0.67, { contracts24h: 4_227, closeTime: iso(NOW + 56 * 24 * HOUR), category: "IPOs", types: [] });
    const pmNine = Array.from({ length: 9 }, (_, i) => polymarket(`pm-${i}`, `Polymarket question ${i}?`, [["Yes", 0.5], ["No", 0.5]], { volumeUsd24h: 500_000 - i * 50_000, closeTime: iso(NOW + (i + 2) * HOUR), category: "Politics", types: [] }, `0x${String(i).repeat(64)}`)).flat();
    const ipoP = polymarket("anthropic-ipo-by-m", "Will Anthropic IPO by December 31, 2026?", [["Yes", 0.83], ["No", 0.17]], { volumeUsd24h: 27_271, eventVolumeUsd24h: 40_703, closeTime: iso(NOW + 86 * 24 * HOUR), category: "IPO", types: [] } as Partial<Listing>, `0x${"b4".repeat(32)}`);
    const sources = { public: [pub("kalshi", "Kalshi", { kind: "events" as const, connectTo: "kalshi", connector: "live:kalshi", listings: [...kalshiNine, ...ipoK] }), pub("polymarket", "Polymarket", { kind: "events" as const, connectTo: "polymarket", connector: "live:polymarket-trade", listings: [...pmNine, ...ipoP] })] };
    const out = await exploreAcross(sources, { clock, tab: "predictions" });
    // the twelve busiest in turn, then the two IPO questions, Polymarket's busier one first
    expect(out.items).toHaveLength(PREDICTIONS_MAX + 2);
    expect(out.items.slice(PREDICTIONS_MAX).map((i) => [i.key, i.category, i.tabs])).toEqual([
      [`pm:0x${"b4".repeat(32)}`, "IPO", ["all", "predictions"]],
      ["kalshi:KXIPOANTHROPIC-DATE-26DEC01", "IPOs", ["all", "predictions"]],
    ]);
    expect(out.tabs.map((t) => [t.id, t.count])).toEqual([["all", PREDICTIONS_MAX + 2], ["predictions", PREDICTIONS_MAX + 2]]);
    expect(out.notes).toContain("Predictions: and the IPO questions at Kalshi and Polymarket, beside the busiest few.");
    expect(out.notes.every((n) => n.length < 160)).toBe(true);
    // All carries them too; what closes soon is still the interleaved few
    const all = await exploreAcross(sources, { clock });
    expect(all.items.filter((i) => i.kind === "event")).toHaveLength(PREDICTIONS_MAX + 2);
    expect(all.closing.every((c) => !["IPO", "IPOs"].includes(c.category ?? ""))).toBe(true);
    // with a search the IPO sentence is not said
    expect((await exploreAcross(sources, { clock, q: "ipo" })).notes.some((n) => n.includes("IPO questions"))).toBe(false);
  });
});

describe("what did not answer", () => {
  it("puts a source that does not answer in time, one that refuses and one that throws in missing, and shows the rest", async () => {
    const ok = trader({ markets: [mk("BTC/USDT", "spot", "BTC", "USDT", { price: 100_000 })] });
    const slow = trader({ markets: "hang" });
    const refusing = pub("kalshi", "Kalshi", { kind: "events", connectTo: "kalshi", connector: "live:kalshi", listings: no("E_VENUE_UNREACHABLE", { venue: "kalshi", message: "Kalshi is rate-limiting this machine: try again in a minute", native: { status: 429, said: "too many requests" } }) });
    const throwing = trader({ markets: "throw" });
    const started = Date.now();
    const out = await exploreAcross({ connected: [venue("okx", "OKX", ok), venue("bybit", "Bybit", slow), venue("odd", "Odd", throwing)], public: [refusing] }, { clock, timeoutMs: 50 });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(out.items.map((i) => i.key)).toEqual(["coin:BTC"]);
    expect(out.missing).toEqual([
      { venue: "bybit", venueName: "Bybit", why: "did not answer in 0.05 s", code: "E_VENUE_UNREACHABLE", connected: true },
      { venue: "odd", venueName: "Odd", why: "answered in a way this could not read", connected: true },
      { venue: "kalshi", venueName: "Kalshi", why: "Kalshi is rate-limiting this machine: try again in a minute", code: "E_VENUE_UNREACHABLE", said: "too many requests", connected: false },
    ]);
  });

  it("says which call failed when the others answered", async () => {
    const k = trader({ markets: kalshi("KXA-1", "A?", 0.3), events: no("E_VENUE_REJECTED", { venue: "kalshi", message: "Kalshi refused the request (HTTP 400)" }) });
    const out = await exploreAcross({ connected: [venue("kalshi", "Kalshi", k)] }, { clock });
    expect(out.items).toHaveLength(1);
    expect(out.missing).toEqual([{ venue: "kalshi", venueName: "Kalshi", why: "Kalshi refused the request (HTTP 400)", code: "E_VENUE_REJECTED", connected: true, part: "events" }]);
  });

  it("shows Binance's 451 as missing, in Binance's own words, and nothing is asked again a way around it", async () => {
    const asked: string[] = [];
    // the exchange library throws what it throws on a 451: ExchangeNotAvailable, with the request and the body Binance answered
    const open: OpenExchange = async (id) => ({
      id,
      name: "Binance",
      async loadMarkets() {
        asked.push("loadMarkets");
        throw Object.assign(new Error(`binance GET https://api.binance.com/api/v3/exchangeInfo 451  {"code":0,"msg":"Service unavailable from a restricted location according to 'b. Eligibility' in https://www.binance.com/en/terms. Please contact customer service if you believe you received this message in error."}`), { name: "ExchangeNotAvailable" });
      },
      async fetchBalance() {
        throw new Error("a public source never reads a balance");
      },
      async fetchTickers() {
        asked.push("fetchTickers");
        return {};
      },
    });
    const kraken = pub("kraken", "Kraken", { listings: [mk("BTC/USD", "spot", "BTC", "USD", { price: 100_000, volumeUsd24h: 1e9, types: [] })] });
    const out = await exploreAcross({ public: [exchangeTickers("binance", { open, clock }), kraken] }, { clock });
    expect(out.items.map((i) => i.key)).toEqual(["coin:BTC"]);
    expect(out.missing).toEqual([
      {
        venue: "binance",
        venueName: "Binance",
        why: "Binance does not serve this location: that is its own rule, and the account does not look for a way around it",
        code: "E_VENUE_GEOBLOCKED",
        said: expect.stringContaining("Service unavailable from a restricted location according to 'b. Eligibility'"),
        connected: false,
      },
    ]);
    expect(asked).toEqual(["loadMarkets"]);
  });
});
