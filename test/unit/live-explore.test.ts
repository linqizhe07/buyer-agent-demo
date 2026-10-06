import { describe, expect, it } from "vitest";
import type { Refusal } from "../../src/core/errors.ts";
import { no } from "../../src/portfolio/refuse.ts";
import { categoryOf, tabOfCategory, tabsOfCategories } from "../../src/portfolio/live/categories.ts";
import { exploreAcross, type ExploreVenue } from "../../src/portfolio/live/explore.ts";
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
    const legs = polymarket("nfl-atl-no-2026-10-06", "Falcons vs. Saints", [["Falcons", 0.915], ["Saints", 0.085]], { closeTime: iso(NOW + 10 * HOUR), volumeUsd24h: 4.2e6, category: "Sports" });
    const mm = trader({ markets: [], events: legs.map((m, i) => (i === 0 ? { ...m, change24h: 0.44 } : m)) });
    const gamma = pub("polymarket", "Polymarket", { kind: "events", connectTo: "polymarket", connector: "live:polymarket-trade", listings: legs.map((m) => ({ ...m, types: [], volumeUsd24h: 4.25e6 })) });
    const out = await exploreAcross({ connected: [venue("metamask", "MetaMask", mm)], public: [gamma] }, { clock });
    const row = out.items.find((i) => i.key === `pm:${COND}`)!;
    // mm trades it already: Polymarket's public listing of the same market would only say "connect to trade" what can be traded
    expect(row.outcomes?.map((o) => [o.label, o.price, o.at.map((a) => a.venue)])).toEqual([
      ["Falcons", 0.915, ["metamask"]],
      ["Saints", 0.085, ["metamask"]],
    ]);
    // both report Gamma's volume for the one market: it is counted once, the larger figure, not added up
    expect(row).toMatchObject({ change24h: 0.44, changeFrom: { venue: "metamask" }, volumeUsd24h: 4.25e6, tabs: expect.arrayContaining(["predictions", "sports"]) });
    expect(row.at.map((a) => [a.venue, a.symbol, a.connected, a.public])).toEqual([["metamask", "nfl-atl-no-2026-10-06:Falcons", true, false]]);
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
      { id: "now", label: "Now", count: 1 },
      { id: "crypto", label: "Crypto", count: 1 },
    ]);
  });

  it("makes Macro and Sports from the venues' own categories, through the one table", async () => {
    const k = trader({ events: [...kalshi("KXCPI-26OCT", "CPI above 3%?", 0.4, { category: "Economics" }), ...kalshi("KXNFL-1", "Falcons win?", 0.6, { category: "Sports" }), ...kalshi("KXPRES-1", "Who wins?", 0.5, { category: "Elections" })] });
    const pmTagged = polymarket("brazil", "Brazil election", [["Yes", 0.5], ["No", 0.5]], { tags: ["Politics", "Macro Election 2", "World"], category: "Politics" }, `0x${"cd".repeat(32)}`);
    const gamma = pub("polymarket", "Polymarket", { kind: "events", connectTo: "polymarket", connector: "live:polymarket-trade", listings: pmTagged });
    const out = await exploreAcross({ connected: [venue("kalshi", "Kalshi", k)], public: [gamma] }, { clock });
    expect(out.tabs.map((t) => [t.id, t.count])).toEqual([
      ["predictions", 4],
      ["macro", 1],
      ["sports", 1],
    ]);
    expect(out.items.find((i) => i.key === "kalshi:KXCPI-26OCT")?.tabs).toEqual(["predictions", "macro"]);
    // "Macro Election 2" is a tag about elections, not the word "macro"
    expect(out.items.find((i) => i.key === `pm:${"0x" + "cd".repeat(32)}`)?.tabs).toEqual(["predictions"]);
    const sports = await exploreAcross({ connected: [venue("kalshi", "Kalshi", k)] }, { clock, tab: "sports" });
    expect(sports.items.map((i) => i.key)).toEqual(["kalshi:KXNFL-1"]);
  });

  it("reads a category word whole, without regard to case or punctuation", () => {
    expect(tabOfCategory("Fed Rates")).toBe("macro");
    expect(tabOfCategory("fed-rates")).toBe("macro");
    expect(tabOfCategory("NFL (All)")).toBe("sports");
    expect(tabOfCategory("Macro Election 2")).toBeUndefined();
    expect(tabOfCategory("Crypto")).toBeUndefined();
    expect([...tabsOfCategories(["Sports", "NFL", undefined, "Games"])]).toEqual(["sports"]);
    expect(categoryOf(["Games", "Sports", "NFL"])).toBe("Sports");
    expect(categoryOf(["Politics", "World"])).toBe("Politics");
  });
});

describe("movers, closing, now", () => {
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

  it("makes Now of what closes within a day by volume, the movers and the most traded, each once", async () => {
    const x = trader({
      markets: [mk("BTC/USDT", "spot", "BTC", "USDT", { price: 100_000, volumeUsd24h: 2e9, changePct24h: 1 }), mk("DOGE/USDT", "spot", "DOGE", "USDT", { price: 0.2, volumeUsd24h: 3e6, changePct24h: 12 })],
      events: kalshi("KXBTCD-1", "Bitcoin above 100k today?", 0.5, { closeTime: iso(NOW + 3 * HOUR) }),
    });
    const out = await exploreAcross({ connected: [venue("somewhere", "Somewhere", x)] }, { clock, tab: "now" });
    expect(out.items.map((i) => i.key)).toEqual(["event:somewhere:KXBTCD-1", "coin:DOGE", "coin:BTC"]);
    expect(out.items.every((i) => i.tabs[0] === "now")).toBe(true);
    expect(out.tabs.find((t) => t.id === "now")?.count).toBe(3);
    expect(out.mostTraded.map((i) => i.key)).toEqual(["coin:BTC", "coin:DOGE"]);
  });

  it("filters by a query over every venue's symbols and names", async () => {
    const x = trader({ markets: [mk("BTC/USDT", "spot", "BTC", "USDT", { name: "Bitcoin / Tether", price: 100_000 }), mk("ETH/USDT", "spot", "ETH", "USDT", { price: 3_000 })] });
    const out = await exploreAcross({ connected: [venue("okx", "OKX", x)] }, { clock, q: "bitcoin" });
    expect(out.items.map((i) => i.key)).toEqual(["coin:BTC"]);
    expect(x.calls).toContain("markets:bitcoin");
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
