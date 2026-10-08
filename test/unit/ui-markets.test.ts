import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext, Script } from "node:vm";
import { describe, expect, it } from "vitest";

/** The Markets pane (ui/markets.js), the one drawer it draws, the holding that opens it by key (ui/asset.js) and the connections it opens
 * (ui/connect.js), run as the page runs them — after ui/core.js, in one global scope — in a stand-in browser: what it draws from an explore
 * read, what each button signs or asks, and that a venue that refuses is shown in its own words. No server: the reads are answered here */
const PUBLIC = fileURLToPath(new URL("../../src/portfolio/public/", import.meta.url));
const NOW = Date.parse("2026-10-06T05:00:00.000Z");

const venue = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, live: true, usd: 100, cashUsd: 0, holdings: [], asOf: "2026-10-06T04:59:00.000Z", plugged: true, ...extra });
const account = (over: Record<string, unknown> = {}) => ({
  now: new Date(NOW).toISOString(),
  venues: [venue("ex", "Exchange X", { trade: { can: true, what: "spot and perpetuals", kinds: ["spot", "perp"], positions: true } }), venue("kalshi", "Kalshi", { trade: { can: false, what: "event contracts", kinds: ["event"] } })],
  connectLive: {
    home: "/home/x",
    writes: { on: true, capUsd: 250, turnOn: "npm run account" },
    options: [
      { kind: "exchange", connector: "live:exchange", needs: "key-file", label: "Exchange account · API key", venues: ["okx", "kraken"] },
      { kind: "kalshi", connector: "live:kalshi", needs: "key-file", label: "Kalshi · prediction-market account, API key" },
      { kind: "polymarket-trade", connector: "live:polymarket-trade", needs: "key-file", label: "Polymarket · trading" },
      { kind: "standin-pubex", connector: "live:standin-pubex", needs: "cli", label: "Stand-in Public Exchange · a stand-in" },
    ],
  },
  watch: [],
  cards: [],
  orders: [],
  intents: [],
  asks: [],
  keys: [],
  requests: [],
  dial: { revoked: [] },
  health: {},
  mode: "guard",
  ...over,
});
/* Kalshi's key may trade */
const kalshiTrades = () => account({ venues: [account().venues[0], venue("kalshi", "Kalshi", { trade: { can: true, what: "event contracts", kinds: ["event"], positions: true } })] });

const btc = {
  key: "coin:BTC",
  kind: "coin",
  name: "Bitcoin",
  base: "BTC",
  price: 62140,
  changePct24h: 2.1,
  volumeUsd24h: 1.9e9,
  tabs: ["now", "crypto"],
  at: [
    { venue: "ex", venueName: "Exchange X", symbol: "BTC/USDT", connected: true, canTrade: true, public: false, price: 62140, open: true },
    { venue: "okx-public", venueName: "OKX", symbol: "BTC/USDT", connected: false, canTrade: false, public: true, price: 62150, connectTo: "okx", connector: "live:exchange:okx" },
  ],
};
const btcPerp = { key: "perp:BTC", kind: "perp", name: "BTC perpetual", base: "BTC", price: 62180, changePct24h: 1.2, volumeUsd24h: 4.2e9, fundingRate: 0.0001, tabs: ["now", "perps"], at: [{ venue: "ex", venueName: "Exchange X", symbol: "BTC/USDT:USDT", connected: true, canTrade: true, public: false, price: 62180, open: true }] };
const doge = {
  key: "coin:DOGE",
  kind: "coin",
  name: "DOGE",
  base: "DOGE",
  price: 0.12121,
  changePct24h: -3.1,
  volumeUsd24h: 880_000,
  changeFrom: { venue: "okx-public", venueName: "OKX" },
  tabs: ["now", "crypto"],
  at: [{ venue: "okx-public", venueName: "OKX", symbol: "DOGE/USDT", connected: false, canTrade: false, public: true, price: 0.12121, connectTo: "okx", connector: "live:exchange:okx" }],
};
const fed = {
  key: "kalshi:KXFED-DEC",
  kind: "event",
  name: 'Fed cuts in December? <img src=x onerror="alert(1)">',
  price: 0.62,
  volumeUsd24h: 4_100_000,
  category: "Economics",
  closeTime: new Date(NOW + 2 * 86_400_000 + 4 * 3_600_000 + 12 * 60_000 + 30_000).toISOString(),
  tabs: ["now", "predictions"],
  outcomes: [
    { label: "YES", price: 0.62, bid: 0.61, ask: 0.63, at: [{ venue: "kalshi", symbol: "KXFED-DEC:YES" }, { venue: "pm-public", symbol: "fed-dec:Yes" }] },
    { label: "NO", price: 0.38, bid: 0.37, ask: 0.39, at: [{ venue: "kalshi", symbol: "KXFED-DEC:NO" }, { venue: "pm-public", symbol: "fed-dec:No" }] },
  ],
  at: [
    { venue: "kalshi", venueName: "Kalshi", symbol: "KXFED-DEC:YES", connected: true, canTrade: false, public: false, price: 0.62, open: true, note: "this key may not trade: it was made read-only" },
    { venue: "pm-public", venueName: "Polymarket", symbol: "fed-dec:Yes", connected: false, canTrade: false, public: true, price: 0.61, connectTo: "polymarket", connector: "live:polymarket-trade" },
  ],
};
/* a pre-IPO company's perpetual, as the account lists it (F5): the valuation its price implies, per venue in the venue's own unit; the
   company it is on; the issuer's words. Only under All and Pre-IPO, never under Perps */
const anth = {
  key: "perp:ANTHROPIC",
  kind: "perp",
  name: "Anthropic pre-IPO",
  base: "ANTHROPIC",
  category: "Pre-IPO",
  price: 208,
  changePct24h: 4.2,
  volumeUsd24h: 31_000_000,
  fundingRate: 0.0001,
  implied: { perPoint: 1e9, unit: "$1 of contract price stands for $1B of valuation", usd: 2.08e12 },
  group: { id: "anthropic", title: "Anthropic" },
  issuer: "Anthropic",
  eligibility: "Anthropic, 29 June 2026: transfers of its shares without its approval are void",
  tabs: ["all", "preipo"],
  at: [
    { venue: "okx-public", venueName: "OKX", symbol: "ANTHROPIC-USDT-SWAP", connected: false, canTrade: false, public: true, price: 208, open: true, connectTo: "okx", connector: "live:exchange:okx", implied: { perPoint: 1e10, unit: "OKX: $1 of contract price stands for $10B of valuation (since 30 June 2026)", usd: 2.08e12 } },
    { venue: "ex", venueName: "Exchange X", symbol: "ANTHROPIC/USDT:USDT", connected: true, canTrade: true, public: false, price: 2080, open: true, implied: { perPoint: 1e9, unit: "Exchange X: $1 of contract price stands for $1B of valuation", usd: 2.08e12 } },
  ],
};
/* the prediction market about that company's IPO: an ordinary event under Predictions */
const ipoEvent = {
  key: "kalshi:KXIPOANTHROPIC-26",
  kind: "event",
  name: "Anthropic IPO before 2027?",
  price: 0.31,
  contracts24h: 12_400,
  category: "IPOs",
  closeTime: new Date(NOW + 40 * 86_400_000).toISOString(),
  tabs: ["all", "predictions"],
  outcomes: [
    { label: "YES", price: 0.31, bid: 0.3, ask: 0.32, at: [{ venue: "kalshi", symbol: "KXIPOANTHROPIC-26:YES" }] },
    { label: "NO", price: 0.69, bid: 0.68, ask: 0.7, at: [{ venue: "kalshi", symbol: "KXIPOANTHROPIC-26:NO" }] },
  ],
  at: [{ venue: "kalshi", venueName: "Kalshi", symbol: "KXIPOANTHROPIC-26:YES", connected: true, canTrade: true, public: false, price: 0.31, open: true }],
};
/* the account's explore read today (its first tab is still `now`) */
const explore = {
  ok: true,
  asOf: new Date(NOW).toISOString(),
  tabs: [{ id: "now", label: "Now", count: 3 }, { id: "crypto", label: "Crypto", count: 2 }, { id: "predictions", label: "Predictions", count: 1 }],
  items: [fed, btc, doge],
  movers: [doge],
  closing: [fed],
  mostTraded: [btc, doge],
  missing: [{ venue: "binance-public", venueName: "Binance", why: "Binance does not serve this location: that is its own rule, and the account does not look for a way around it", said: "Service unavailable from a restricted location.", code: "E_VENUE_GEOBLOCKED", connected: false }],
  notes: ["Predictions: at most 12 rows, each venue's busiest in turn, without sports, weather and entertainment; a search reaches everything the venues' listings loaded."],
};
/* the read once the account's tabs are all · crypto · stocks · rwas · perps · preipo · predictions (F5) */
const exploreF5 = {
  ...explore,
  tabs: [{ id: "all", label: "All", count: 6 }, { id: "crypto", label: "Crypto", count: 2 }, { id: "perps", label: "Perps", count: 1 }, { id: "preipo", label: "Pre-IPO", count: 1 }, { id: "predictions", label: "Predictions", count: 2 }],
  items: [btcPerp, anth, btc, fed, ipoEvent, doge],
  movers: [],
  closing: [],
  mostTraded: [],
};

/** the page's scripts in a stand-in browser: elements that take listeners, a clock fixed at NOW, reads answered by `answer` */
function page(answer: (path: string, init?: { method?: string; body?: string }) => unknown) {
  const asked: Array<{ path: string; method: string; body?: unknown }> = [];
  const element = (): Record<string, unknown> => ({ addEventListener() {}, removeAttribute() {}, setAttribute() {}, querySelectorAll: () => [], querySelector: () => null, classList: { add() {}, remove() {}, toggle() {} }, dataset: {}, style: {}, hidden: false, value: "", textContent: "", innerHTML: "", contains: () => false, open: false });
  const RealDate = Date;
  class FixedDate extends RealDate {
    constructor(...a: ConstructorParameters<typeof Date>) {
      super(...((a.length ? a : [NOW]) as ConstructorParameters<typeof Date>));
    }
    static override now() {
      return NOW;
    }
  }
  const sandbox: Record<string, unknown> = {
    document: { getElementById: element, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, body: element(), documentElement: { dataset: {} }, hidden: false, activeElement: null },
    location: { hash: "#/markets", origin: "http://127.0.0.1:4820" },
    history: { replaceState() {} },
    Owner: { role: "owner", why: (r: { body?: { refusal?: { message?: string } } }) => r.body?.refusal?.message ?? "" },
    Event: class {
      constructor(readonly type: string) {}
    },
    addEventListener() {},
    dispatchEvent: () => true,
    fetch: async (path: string, init?: { method?: string; body?: string }) => {
      asked.push({ path, method: init?.method ?? "GET", ...(init?.body ? { body: JSON.parse(init.body) } : {}) });
      const body = await answer(path, init);
      return { status: (body as { ok?: boolean })?.ok === false ? 409 : 200, statusText: "", json: async () => body };
    },
    console,
    URLSearchParams,
    Intl,
    Date: FixedDate,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval() {},
  };
  const ctx = createContext(sandbox);
  sandbox.window = runInContext("globalThis", ctx);
  // the page's order: the contract, the connections, the holding's opener, then the pane that draws the drawer they both open
  for (const f of ["ui/core.js", "ui/connect.js", "ui/asset.js", "ui/markets.js"]) new Script(readFileSync(join(PUBLIC, f), "utf8"), { filename: f }).runInContext(ctx);
  const run = <T = unknown>(code: string) => runInContext(code, ctx) as T;
  return { run, asked, set: (name: string, value: unknown) => run(`${name} = ${JSON.stringify(value)}`) };
}
const settle = () => new Promise((r) => setTimeout(r, 0));
/* a pane element, as the shell hands one over */
const PANE = 'var EL = { innerHTML: "", dataset: {}, addEventListener() {}, querySelectorAll: () => [], contains: () => false }';
/* a button pressed, as the handlers read it */
const press = (dataset: Record<string, string>) => `({ target: { closest: (s) => (s === "[data-act]" ? { dataset: ${JSON.stringify(dataset)}, disabled: false } : null) } })`;

describe("the Markets pane", () => {
  it("says prices, volumes, valuations and countdowns as a person reads them", () => {
    const p = page(() => ({}));
    expect(p.run('[mkCents(0.62), mkCents(0.004), mkCents(0), mkCents(undefined)]')).toEqual(["62¢", "0.4¢", "0¢", "—"]);
    expect(p.run('[mkVol(1.9e9), mkVol(120e6), mkVol(880000), mkVol(412), mkVol(undefined)]')).toEqual(["$1.9B", "$120M", "$880k", "$412", "—"]);
    expect(p.run('[mkUsd(62140), mkUsd(0.12121), mkUsd(null)]')).toEqual(["$62,140.00", "$0.1212", "—"]);
    // a valuation to three figures, as the Trade pane's picker says it too (mkValuation is top-level for it)
    expect(p.run('[mkValuation(2.08e12), mkValuation(965e9), mkValuation(12.5e9), mkValuation(4.2e6), mkValuation(undefined)]')).toEqual(["$2.08T", "$965B", "$12.5B", "$4.2M", "—"]);
    expect(p.run(`mkLeft(${2 * 86_400_000 + 4 * 3_600_000 + 12 * 60_000 + 30_000})`)).toBe("Closes in 2d 04:12");
    expect(p.run(`mkLeft(${6 * 3_600_000 + 48 * 60_000 + 10_000})`)).toBe("Closes in 06:48:10");
    expect(p.run("mkLeft(-5)")).toBe("Closed");
    expect(p.run('[mkLabel("YES"), mkLabel("UP"), mkLabel("Falcons")]')).toEqual(["Yes", "Up", "Falcons"]);
    expect(p.run('mkFmt({ price: 0.6, bid: 0.59, ask: 0.61 }, "c")')).toBe("61¢");
    expect(p.run('mkFmt({ price: 0.6, ask: 0.61 }, "c-last")')).toBe("60¢");
    expect(p.run('mkFmt({ price: 101.5, bid: 101.4 }, "bid")')).toBe("$101.40");
  });

  it("sends a Buy to the venue that takes the order, to the connection where only public prices list it, else says why in the venue's words", () => {
    const p = page(() => ({}));
    p.set("A", account());
    p.set("ITEMS", { btc, doge, fed });
    expect(p.run("JSON.stringify(mkRoute(ITEMS.btc))")).toBe(JSON.stringify({ act: "trade", venue: "ex", symbol: "BTC/USDT", venueName: "Exchange X" }));
    // only OKX's public prices list DOGE: its connection's own form
    expect(p.run("JSON.stringify(mkRoute(ITEMS.doge))")).toBe(JSON.stringify({ act: "connect", connector: "live:exchange:okx", venue: "okx", venueName: "OKX", note: "" }));
    // the connected Kalshi key refuses; Polymarket lists it publicly: connect Polymarket
    expect(p.run("mkRoute(ITEMS.fed, 1).act")).toBe("connect");
    expect(p.run("mkRoute(ITEMS.fed, 1).connector")).toBe("live:polymarket-trade");
    // with no public listing to connect, Kalshi's own words, and how to fix the key
    p.run("ITEMS.fedK = { ...ITEMS.fed, at: [ITEMS.fed.at[0]], outcomes: ITEMS.fed.outcomes.map((o) => ({ ...o, at: [o.at[0]] })) }");
    const why = p.run<{ act: string; venue: string; text: string }>("mkRoute(ITEMS.fedK, 0)");
    expect(why.act).toBe("why");
    expect(why.venue).toBe("kalshi");
    expect(why.text).toContain("Kalshi: this key may not trade: it was made read-only.");
    expect(why.text).toContain("Create New API Key");
    // an outcome is traded by its own market
    p.set("A", account({ venues: [venue("kalshi", "Kalshi", { trade: { can: true, what: "event contracts", kinds: ["event"] } })] }));
    p.run("ITEMS.fedOk = { ...ITEMS.fedK, at: [{ ...ITEMS.fedK.at[0], canTrade: true }] }");
    expect(p.run("mkRoute(ITEMS.fedOk, 1).symbol")).toBe("KXFED-DEC:NO");
    // a server started read-only places nothing, and says how to start it to trade
    p.set("A", account({ connectLive: { ...account().connectLive, writes: { on: false, capUsd: 0, turnOn: "npm run account" } } }));
    expect(p.run("JSON.stringify(mkRoute(ITEMS.btc))")).toBe(JSON.stringify({ act: "why", text: "Trading is off on this server: start it with npm run account." }));
    expect(p.run("mkRoute(ITEMS.doge).act")).toBe("why");
  });

  it("opens the ticket on the row's kind — crypto · stocks · rwas · perps · preipo · predictions — which the Trade seg follows; no variant", () => {
    const p = page(() => ({}));
    p.set("A", kalshiTrades());
    p.set("ITEMS", { btc, btcPerp, doge, fed, anth, ipoEvent });
    expect(p.run("[mkKindOf(ITEMS.btc), mkKindOf(ITEMS.btcPerp), mkKindOf(ITEMS.anth), mkKindOf(ITEMS.fed), mkKindOf({ kind: 'stock' }), mkKindOf({ kind: 'rwa' }), mkKindOf({ kind: 'perp', category: 'Pre-IPO' }), mkKindOf({ kind: 'stable' })]")).toEqual(["crypto", "perps", "preipo", "predictions", "stocks", "rwas", "preipo", "crypto"]);
    p.run("var TICKETS = []; globalThis.openTicket = (x) => TICKETS.push(x)");
    p.run('mkTrade(ITEMS.btc, "buy")');
    expect(p.run<unknown[]>("TICKETS")[0]).toEqual({ venue: "ex", symbol: "BTC/USDT", side: "buy", kind: "crypto", key: "coin:BTC", base: "BTC", name: "Bitcoin" });
    // an outcome: the ticket on the predictions face, the outcome named
    p.run("ITEMS.fedOk = { ...ITEMS.fed, at: [{ ...ITEMS.fed.at[0], canTrade: true }] }");
    p.run('mkTrade(ITEMS.fedOk, "buy", 1)');
    expect(p.run<unknown[]>("TICKETS")[1]).toEqual({ venue: "kalshi", symbol: "KXFED-DEC:NO", side: "buy", outcome: "NO", kind: "predictions", key: "kalshi:KXFED-DEC", name: fed.name });
    // the drawer's Across venues → Trade on a pre-IPO company row: the preipo face, at that venue
    p.run('MKT.open = { item: ITEMS.anth, interval: "1h", ipo: [] }');
    p.run(`mkDrawerClick(${press({ act: "trade-at", venue: "ex", symbol: "ANTHROPIC/USDT:USDT" })})`);
    expect(p.run<unknown[]>("TICKETS")[2]).toEqual({ venue: "ex", symbol: "ANTHROPIC/USDT:USDT", side: "buy", kind: "preipo", key: "perp:ANTHROPIC", base: "ANTHROPIC", name: "Anthropic pre-IPO" });
    // the drawer's Sell: the sell side, the same kind
    p.run('MKT.open = { item: ITEMS.btcPerp, interval: "1h", ipo: [] }');
    p.run(`mkDrawerClick(${press({ act: "sell", venue: "ex", symbol: "BTC/USDT:USDT" })})`);
    expect(p.run<unknown[]>("TICKETS")[3]).toMatchObject({ venue: "ex", symbol: "BTC/USDT:USDT", side: "sell", kind: "perps" });
    expect(JSON.stringify(p.run("TICKETS"))).not.toContain("variant");
  });

  it("watches with a signed setWatch: a public listing under the venue it would be once connected, and off for what is watched", async () => {
    const drafts: unknown[] = [];
    const p = page(() => ({}));
    p.set("A", account());
    p.set("ITEMS", { btc, doge });
    p.run("own = async (d) => { DRAFTS.push(d); return { status: 200, body: {} }; }; var DRAFTS = []");
    expect(p.run("JSON.stringify(mkWatchDraft(ITEMS.doge))")).toBe(JSON.stringify({ type: "setWatch", venue: "okx", symbol: "DOGE/USDT", on: "true" }));
    expect(p.run("JSON.stringify(mkWatchDraft(ITEMS.btc))")).toBe(JSON.stringify({ type: "setWatch", venue: "ex", symbol: "BTC/USDT", on: "true" }));
    p.set("A", account({ watch: [{ venue: "okx", symbol: "DOGE/USDT", at: "2026-10-06T04:00:00.000Z" }] }));
    expect(p.run("JSON.stringify(mkWatchDraft(ITEMS.doge))")).toBe(JSON.stringify({ type: "setWatch", venue: "okx", symbol: "DOGE/USDT", on: "" }));
    expect(p.run("mkStar(ITEMS.doge, 0)")).toContain('aria-pressed="true" aria-label="Stop watching DOGE"');
    // on the Watching tab the star says since when
    expect(p.run('mkStar(ITEMS.doge, 0, "2026-10-06T04:00:00.000Z")')).toContain('title="Watching since Tue 6 Oct"');
    // the ★ in the pane signs exactly that
    p.run("MKT.reg = [ITEMS.doge]");
    p.run(`mkPaneClick(${press({ act: "watch", i: "0" })})`);
    await settle();
    drafts.push(...p.run<unknown[]>("DRAFTS"));
    expect(JSON.stringify(drafts)).toBe(JSON.stringify([{ type: "setWatch", venue: "okx", symbol: "DOGE/USDT", on: "" }]));
  });

  it("draws a card with Yes and No in cents, a countdown, the question escaped, and fresh prices asked only at connected venues; lean under Predictions", () => {
    const p = page(() => ({}));
    p.set("A", account({ venues: [venue("kalshi", "Kalshi", { trade: { can: true, what: "event contracts", kinds: ["event"] } })] }));
    p.set("ITEM", { ...fed, at: [{ ...fed.at[0], canTrade: true }, fed.at[1]] });
    const html = p.run<string>("MKT.reg = []; mkCard(ITEM)");
    expect(html).not.toContain("<img");
    expect(html).toContain("Fed cuts in December? &lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain('data-close="2026-10-08T09:12:30.000Z">Closes in 2d 04:12</span>');
    expect(html).toContain('Yes · <span data-q="kalshi|KXFED-DEC:YES" data-fmt="c">63¢</span>');
    expect(html).toContain('No · <span data-q="kalshi|KXFED-DEC:NO" data-fmt="c">39¢</span>');
    // the public listing is never asked for a quote (it has no key to read one with)
    expect(html).toContain('data-pairs="kalshi|KXFED-DEC:YES,kalshi|KXFED-DEC:NO"');
    expect(html).not.toContain("pm-public|");
    // the facts line, where the tab does not already say what the card is (a search, All results)
    expect(html).toContain("Kalshi · Polymarket · $4.1M vol");
    // under Predictions the tab says it: the card is lean — countdown, question, Yes and No
    const lean = p.run<string>("mkCard(ITEM, { lean: true })");
    expect(lean).not.toContain("Kalshi · Polymarket");
    expect(lean).not.toContain("Economics");
    expect(lean).toContain("Closes in 2d 04:12");
    expect(lean).toContain('data-act="yn"');
    // a fresh quote, once read, is what the card shows
    p.run(`MKT.quotes.set("kalshi|KXFED-DEC:YES", { at: ${NOW}, market: { price: 0.7, bid: 0.69, ask: 0.71 } })`);
    expect(p.run<string>("mkCard(ITEM)")).toContain('data-fmt="c">71¢</span>');
  });

  it("names each venue that did not answer in its own words, a location rule as the venue's rule and nothing more", () => {
    const p = page(() => ({}));
    const line = p.run<string>(`mkMissingLine(${JSON.stringify([...explore.missing, { venue: "kraken", venueName: "Kraken <b>", why: "no answer in 4 s", connected: true }, { venue: "ex", venueName: "X", why: "far from the others", symbol: "BTC/USD", connected: true }])})`);
    expect(line).toBe('<p class="mk-missing">Not shown: <b>Binance</b>: “Service unavailable from a restricted location” — its own rule for this location · <b>Kraken &lt;b&gt;</b>: no answer in 4 s.</p>');
    expect(line).not.toMatch(/vpn|proxy|another region|elsewhere/i);
    expect(p.run("mkMissingLine([])")).toBe("");
  });

  it("draws All as one table of everything the read returned, with the tabs it lists (a legacy Now is All), a skeleton while it loads, and keeps what it drew when a later read fails", async () => {
    let fail = false;
    const p = page((path) => (path.startsWith("/api/account/explore") ? (fail ? { ok: false, refusal: { message: "the account is restarting" } } : explore) : {}));
    p.set("A", account({ watch: [{ venue: "ex", symbol: "BTC/USDT", at: "2026-10-06T04:00:00.000Z" }] }));
    p.run(`ROUTE.tab = "markets"; ${PANE}`);
    p.run('renderMarkets({ el: EL, owner: true, lens: lensNow(), params: {} })');
    expect(p.run<string>("EL.innerHTML")).toContain('aria-busy="true"');
    // All is every row: the read is asked with no tab (the account's own list, busiest first) and never with a sort
    expect(p.asked.map((a) => a.path)).toEqual(["/api/account/explore"]);
    await settle();
    await settle();
    const html = p.run<string>("EL.innerHTML");
    const tabs = [...html.matchAll(/data-act="tab" data-tab="([a-z]*)"[^>]*aria-pressed="(true|false)">([^<]+)</g)].map((m) => `${m[3]}${m[2] === "true" ? "*" : ""}`);
    expect(tabs).toEqual(["All*", "Crypto", "Predictions", "Watching"]);
    // one table, no Now sections, no Venues board
    expect(html.match(/<table class="t mk-t">/g)).toHaveLength(1);
    expect(html).not.toMatch(/<h2[^>]*>(Closing soon|Movers|Most traded)<\/h2>/);
    expect(html).not.toContain("mk-chip");
    expect(html).not.toContain("Your venues");
    expect(html).not.toContain("Connect a venue");
    // the event is a row too: its lead outcome in cents, a countdown that ticks in place
    expect(html).toContain('<span data-q="kalshi|KXFED-DEC:YES" data-fmt="c-last">62¢</span><span class="dim small"> Yes</span>');
    expect(html).toContain('Economics · <span class="mk-close" data-ended="Closed" data-close="2026-10-08T09:12:30.000Z">Closes in 2d 04:12</span>');
    // DOGE is only at OKX's public prices: its row connects; BTC trades at Exchange X
    expect(html).toContain('data-connector="live:exchange:okx" data-name="OKX"');
    expect(html).toMatch(/data-act="trade" data-i="\d+" data-fk="trade:coin:BTC"/);
    // the sort seg, Most traded pressed
    expect(html).toContain('data-act="sort" data-v="volume" data-fk="sort:volume" aria-pressed="true">Most traded</button>');
    // a later read fails: what was read stays, said to be from earlier
    fail = true;
    p.run("for (const g of MKT.got.values()) g.at = 0");
    p.run('renderMarkets({ el: EL, owner: true, lens: lensNow(), params: {} })');
    await settle();
    await settle();
    const after = p.run<string>("EL.innerHTML");
    expect(after.match(/<table class="t mk-t">/g)).toHaveLength(1);
    expect(after).toContain("Couldn't read the markets again just now: the account is restarting.");
  });

  it("folds everything under the list into one line — why these, and what's not shown — and keeps it as the owner left it", async () => {
    const p = page((path) => (path.startsWith("/api/account/explore") ? explore : {}));
    p.set("A", account());
    p.run(`ROUTE.tab = "markets"; ${PANE}`);
    p.run('renderMarkets({ el: EL, owner: true, lens: lensNow(), params: {} })');
    await settle();
    await settle();
    const html = p.run<string>("EL.innerHTML");
    expect(html.match(/<details class="mk-foot"/g)).toHaveLength(1);
    expect(html).toContain("<summary>Why these, and what's not shown ");
    // the notes and the venues that did not answer are inside it, not standing under the list
    expect(html).toContain("<b>Binance</b>: “Service unavailable from a restricted location”");
    expect(html).toContain('<p class="mk-note">Predictions: at most 12 rows');
    expect(html.indexOf('<p class="mk-note">')).toBeGreaterThan(html.indexOf('<details class="mk-foot"'));
    expect(html.indexOf("<b>Binance</b>")).toBeGreaterThan(html.indexOf('<details class="mk-foot"'));
    expect(html).not.toContain('<details class="mk-foot" open>');
    // opened by the owner, it stays open across the next redraw
    p.run('mkPaneToggle({ target: { classList: { contains: (c) => c === "mk-foot" }, open: true } })');
    expect(p.run("MKT.footOpen")).toBe(true);
    expect(p.run<string>("mkFootHtml(" + JSON.stringify(explore) + ")")).toContain('<details class="mk-foot" open>');
    // nothing to say: no line at all; a read-only server says so inside it
    expect(p.run("mkFootHtml({ notes: [], missing: [] })")).toBe("");
    p.set("A", account({ connectLive: { ...account().connectLive, writes: { on: false, capUsd: 0, turnOn: "npm run account" } } }));
    expect(p.run<string>("mkFootHtml({ notes: [], missing: [] })")).toContain("Read-only server: prices are read here, and nothing is traded or connected from it.");
    expect(p.run("mkNotes(['A few of the busiest markets · search for more.', '', 7])")).toBe('<p class="mk-note">A few of the busiest markets · search for more.</p>');
  });

  it("sorts here, never by asking the account again: most traded, biggest moves, closing soonest; the seg moves the route only", async () => {
    const p = page((path) => (path.startsWith("/api/account/explore") ? explore : {}));
    p.set("A", account());
    p.set("ITEMS", { btc, doge, fed });
    expect(p.run("mkSortRows([ITEMS.fed, ITEMS.btc, ITEMS.doge], '').map((x) => x.key)")).toEqual(["kalshi:KXFED-DEC", "coin:BTC", "coin:DOGE"]);
    expect(p.run("mkSortRows([ITEMS.fed, ITEMS.btc, ITEMS.doge], 'volume').map((x) => x.key)")).toEqual(["coin:BTC", "kalshi:KXFED-DEC", "coin:DOGE"]);
    expect(p.run("mkSortRows([ITEMS.fed, ITEMS.btc, ITEMS.doge], 'movers').map((x) => x.key)")).toEqual(["coin:DOGE", "coin:BTC", "kalshi:KXFED-DEC"]);
    expect(p.run("mkSortRows([ITEMS.btc, ITEMS.doge, ITEMS.fed], 'closing').map((x) => x.key)")).toEqual(["kalshi:KXFED-DEC", "coin:BTC", "coin:DOGE"]);
    // the pane, sorted by the route: the rows in that order, the seg pressed there
    p.run(`ROUTE.tab = "markets"; ROUTE.params = { sort: "movers" }; ${PANE}`);
    p.run('renderMarkets({ el: EL, owner: true, lens: lensNow(), params: { sort: "movers" } })');
    await settle();
    await settle();
    const html = p.run<string>("EL.innerHTML");
    expect(html).toContain('data-v="movers" data-fk="sort:movers" aria-pressed="true"');
    expect(html.indexOf('data-fk="open:coin:DOGE"')).toBeLessThan(html.indexOf('data-fk="open:coin:BTC"'));
    expect(html.indexOf('data-fk="open:coin:BTC"')).toBeLessThan(html.indexOf('data-fk="open:kalshi:KXFED-DEC"'));
    // the path of the read carries no sort; pressing a sort moves the route in place and reads nothing
    expect(p.asked.map((a) => a.path)).toEqual(["/api/account/explore"]);
    p.run("var GONE = []; go = (tab, params, opts) => GONE.push([tab, params, opts])");
    p.run(`mkPaneClick(${press({ act: "sort", v: "closing" })})`);
    expect(p.run("GONE")).toEqual([["markets", { sort: "closing" }, { replace: true }]]);
    p.run(`mkPaneClick(${press({ act: "sort", v: "volume" })})`);
    expect(p.run("GONE[1]")).toEqual(["markets", { sort: "" }, { replace: true }]);
    expect(p.asked.map((a) => a.path)).toEqual(["/api/account/explore"]);
  });

  it("shows the tabs the account lists, in its order — All · Crypto · Perps · Pre-IPO · Predictions — and sends a legacy or unknown tab to All", async () => {
    const p = page((path) => (path.startsWith("/api/account/explore") ? exploreF5 : {}));
    p.set("A", account());
    expect(p.run("mkParams({ tab: 'now' })")).toEqual({ tab: "all", q: "", sort: "", bogus: true });
    expect(p.run("mkParams({ tab: 'venues', q: 'x' })")).toEqual({ tab: "all", q: "x", sort: "", bogus: true });
    expect(p.run("mkParams({ tab: 'sports' })")).toEqual({ tab: "all", q: "", sort: "", bogus: true });
    expect(p.run("mkParams({})")).toEqual({ tab: "all", q: "", sort: "", bogus: false });
    expect(p.run("mkParams({ q: ' fed ' })")).toEqual({ tab: "", q: "fed", sort: "", bogus: false });
    expect(p.run("mkParams({ tab: 'preipo', sort: 'closing' })")).toEqual({ tab: "preipo", q: "", sort: "closing", bogus: false });
    // a search typed on Watching searches every market
    expect(p.run("mkParams({ tab: 'watching', q: 'btc' })")).toEqual({ tab: "", q: "btc", sort: "", bogus: true });
    expect(p.run("mkParams({ tab: 'watching' })")).toEqual({ tab: "watching", q: "", sort: "", bogus: false });
    expect(p.run("MKT_TAB_IDS")).toEqual(["all", "crypto", "stocks", "rwas", "perps", "preipo", "predictions"]);
    // the hash named Now: the pane puts All in its place
    p.run(`ROUTE.tab = "markets"; ${PANE}; var GONE = []; go = (tab, params, opts) => GONE.push([tab, params, opts])`);
    p.run('renderMarkets({ el: EL, owner: true, lens: lensNow(), params: { tab: "now" } })');
    expect(p.run("GONE")).toEqual([["markets", { tab: "all" }, { replace: true }]]);
    // Pre-IPO asked for: the read for that tab, the tabs in the account's order
    p.run('ROUTE.params = { tab: "preipo" }; renderMarkets({ el: EL, owner: true, lens: lensNow(), params: { tab: "preipo" } })');
    expect(p.asked.map((a) => a.path)).toEqual(["/api/account/explore?tab=preipo"]);
    await settle();
    await settle();
    const html = p.run<string>("EL.innerHTML");
    const tabs = [...html.matchAll(/data-act="tab" data-tab="([a-z]*)"[^>]*aria-pressed="(true|false)">([^<]+)</g)].map((m) => `${m[3]}${m[2] === "true" ? "*" : ""}`);
    expect(tabs).toEqual(["All", "Crypto", "Perps", "Pre-IPO*", "Predictions"]);
    expect(html).not.toContain('data-tab="venues"');
  });

  it("says a failed first read in the account's words, with a way to try again — never a blank pane", async () => {
    const p = page(() => ({ ok: false, refusal: { message: "the account layer is not mounted" } }));
    p.set("A", account());
    p.run(`ROUTE.tab = "markets"; ${PANE}`);
    p.run('renderMarkets({ el: EL, owner: true, lens: lensNow(), params: { tab: "crypto" } })');
    await settle();
    await settle();
    const html = p.run<string>("EL.innerHTML");
    expect(html).toContain("Couldn't read the markets: the account layer is not mounted.");
    expect(html).toContain('data-act="retry"');
    expect(html).toContain('data-tab="all"');
  });

  it("puts ONE action on a row — Trade, Connect to trade, or why not — and no Hand to agent (the drawer has it)", () => {
    const p = page(() => ({}));
    p.set("A", account());
    p.set("ITEMS", { btc, doge });
    const connect = p.run<string>("MKT.reg = []; mkActs(ITEMS.doge, 0)");
    expect(connect).toContain("Connect to trade");
    expect(connect).not.toContain('data-act="hand"');
    expect(connect.match(/<button/g)).toHaveLength(1);
    const trade = p.run<string>("mkActs(ITEMS.btc, 1)");
    expect(trade).toContain('data-act="trade" data-i="1" data-fk="trade:coin:BTC"');
    expect(trade.match(/<button/g)).toHaveLength(1);
    // the drawer keeps Hand to agent, with the row's kind
    p.run("var HANDED = []; globalThis.openHandToAgent = (x) => HANDED.push(x)");
    const drawer = p.run<string>('mkDrawerHtml({ item: ITEMS.btc, interval: "1h", ipo: [] })');
    expect(drawer).toContain('data-act="hand"');
    p.run('MKT.open = { item: ITEMS.btc, interval: "1h", ipo: [] }');
    p.run(`mkDrawerClick(${press({ act: "hand" })})`);
    expect(p.run("HANDED")).toEqual([{ venue: "ex", symbol: "BTC/USDT", venueName: "Exchange X", side: "buy", kind: "crypto" }]);
  });

  it("opens a connection's own form for Connect to trade, and lists every way of connecting the server offers", () => {
    const p = page(() => ({}));
    p.set("A", account());
    p.run("var OPENED = []; openConnect = (o, opts) => OPENED.push([o.kind, opts.exchange, opts.name])");
    expect(p.run("connectVia('live:exchange:okx', { name: 'OKX' })")).toBe(true);
    expect(p.run("connectVia('live:polymarket-trade', { name: 'Polymarket' })")).toBe(true);
    expect(p.run("connectVia('live:standin-pubex', { name: 'Stand-in Public Exchange' })")).toBe(true);
    expect(p.run("connectVia('live:nowhere', { name: 'Nowhere' })")).toBe(false);
    expect(p.run("OPENED")).toEqual([["exchange", "okx", "OKX"], ["polymarket-trade", "", "Polymarket"], ["standin-pubex", "", "Stand-in Public Exchange"]]);
    expect(p.run("[connectorOfVenue(A.venues[1]), connectorOfVenue(A.venues[0])]")).toEqual(["live:kalshi", ""]);
    // a second OKX account is still OKX: the connection the account names for it, and what to tick there
    const second = venue("okx-trading", "OKX Trading", { connector: "live:exchange:okx", trade: { can: false, what: "spot", kinds: ["spot"] } });
    p.set("A", account({ venues: [...account().venues, second, venue("mystery", "Mystery", { connector: "live:gone" })] }));
    expect(p.run("[connectorOfVenue(A.venues[2]), connectorOfVenue(A.venues[3])]")).toEqual(["live:exchange:okx", ""]);
    expect(p.run("keyHowFor(A.venues[2])")).toContain("Tick Read and Trade");
    // the pane's Connect to trade goes through connectVia
    p.run(`mkPaneClick(${press({ act: "connect", connector: "live:exchange:okx", name: "OKX" })})`);
    expect(p.run("OPENED.length")).toBe(4);
    const cat = p.run<string>("catalog(true, 'wide')");
    expect(cat).toContain('<div class="pick-h">More</div>');
    expect(cat).toContain('data-kind="standin-pubex" data-extra=""><b>Stand-in Public Exchange</b><span>On this machine</span>');
    // a venue that answered no before any key was made (GET /api/account/connect/reach): its tile says so, its words in the title; the ones
    // read by address ask nothing; an answer of ok changes nothing
    const said = "Binance does not serve this location: that is its own rule, and the account does not look for a way around it. It answered: “Service unavailable from a restricted location”";
    p.run(`REACH.set("live:exchange:binance", { connector: "live:exchange:binance", state: "location", said: ${JSON.stringify(said)}, at: "2026-10-06T05:00:00.000Z" }); REACH.set("live:exchange:okx", { connector: "live:exchange:okx", state: "ok", at: "2026-10-06T05:00:00.000Z" }); REACH.set("live:metamask", { connector: "live:metamask", state: "setup", said: "mm is not signed in on this machine: run mm login in a terminal, then check again", at: "2026-10-06T05:00:00.000Z" })`);
    const marked = p.run<string>("catalog(true)");
    expect(marked).toContain(`<button type="button" class="tile tile-off" data-kind="exchange" data-extra="binance" title="${said.replace(/'/g, "&#39;")}"><b>Binance</b><span><em class="off">Not served here</em></span></button>`);
    expect(marked).toContain('<button type="button" class="tile" data-kind="exchange" data-extra="okx"><b>OKX</b><span>API key</span></button>');
    expect(p.run("[tileConnector('exchange', 'okx'), tileConnector('exchange', ''), tileConnector('hyperliquid', ''), tileConnector('wallet', 'watch'), tileConnector('kalshi', '')]")).toEqual(["live:exchange:okx", "", "", "", "live:kalshi"]);
    // the form's note: the venue's words, when it was asked, Check again; Polymarket's offers to watch a wallet there by its address
    const note = p.run<string>(`reachNoteHtml(REACH.get("live:exchange:binance"), "exchange")`);
    expect(note).toContain("It answered: “Service unavailable from a restricted location”");
    expect(note).toContain('<span class="dim">(asked 01:00)</span>');
    expect(note).toContain('<button type="button" class="link" data-reach="again">Check again</button>');
    expect(note).not.toContain("data-reach=\"watch\"");
    p.set("A", { ...account(), connectLive: { ...account().connectLive, options: [...account().connectLive.options, { kind: "polymarket", connector: "live:polymarket", needs: "address", label: "Polymarket · by the account wallet's address" }] } });
    expect(p.run<string>(`reachNoteHtml({ state: "location", said: "Polymarket does not serve this location", at: "2026-10-06T05:00:00.000Z" }, "polymarket-trade")`)).toContain('data-reach="watch">Watch a Polymarket wallet by its address instead</button>');
    expect(p.run(`reachNoteHtml({ state: "ok" }, "kalshi")`)).toBe("");
  });

  it("offers Hyperliquid as Polymarket is offered: its tile is the API-wallet connection (a key file that never withdraws), and the account read by its address is Hyperliquid · by address", () => {
    const p = page(() => ({}));
    const options = [...account().connectLive.options, { kind: "hyperliquid-trade", connector: "live:hyperliquid-trade", needs: "key-file", label: "Hyperliquid · trading, with an API wallet that cannot withdraw", venues: ["hyperliquid"] }, { kind: "hyperliquid", connector: "live:hyperliquid", needs: "address", label: "Hyperliquid · by the account's address", venues: ["hyperliquid"] }];
    p.set("A", account({ connectLive: { ...account().connectLive, options } }));
    const cat = p.run<string>("catalog(true)");
    expect(cat).toContain('<button type="button" class="tile" data-kind="hyperliquid-trade" data-extra=""><b>Hyperliquid</b><span>API key</span></button>');
    expect(cat).toContain('<button type="button" class="tile" data-kind="hyperliquid" data-extra=""><b>Hyperliquid · by address</b><span>Address</span></button>');
    // neither is offered again under More
    expect([cat.match(/data-kind="hyperliquid-trade"/g), cat.match(/data-kind="hyperliquid"/g)].map((m) => m?.length)).toEqual([1, 1]);
    // the API-wallet connection asks its venue's rule first (live/reach.ts); the one by address asks nothing
    expect(p.run("[tileConnector('hyperliquid-trade', ''), tileConnector('hyperliquid', '')]")).toEqual(["live:hyperliquid-trade", ""]);
    p.run(`REACH.set("live:hyperliquid-trade", { connector: "live:hyperliquid-trade", state: "location", said: "Hyperliquid does not serve this location: its Terms of Use (§1.6) …", at: "2026-10-06T05:00:00.000Z" })`);
    expect(p.run<string>("catalog(true)")).toContain('data-kind="hyperliquid-trade" data-extra="" title="Hyperliquid does not serve this location: its Terms of Use (§1.6) …"><b>Hyperliquid</b><span><em class="off">Not served here</em></span>');
    // its form's note offers to watch the account by its address instead
    expect(p.run<string>(`reachNoteHtml(REACH.get("live:hyperliquid-trade"), "hyperliquid-trade")`)).toContain('data-reach="watch">Watch a Hyperliquid account by its address instead</button>');
    // the key file: where an API wallet is made, what to do there in Hyperliquid's words, and its two fields
    expect(p.run("API_PAGES['hyperliquid-trade']")).toBe("https://app.hyperliquid.xyz/API");
    const how = p.run<string>("keyHow('hyperliquid-trade')");
    for (const w of ["More → API", "Generate", "Authorize API Wallet", "180 days", "can never withdraw", '"walletAddress"', '"privateKey"', "§1.6"]) expect(how).toContain(w);
    expect(p.run("FIELDS['hyperliquid-trade']")).toEqual(["walletAddress", "privateKey"]);
    expect(p.run("keyHowFor({ id: 'hyperliquid-trade', connector: 'live:hyperliquid-trade' })")).toBe(how);
  });

  it("shows in the drawer what the agents are doing in a market: their cards (Review → Portfolio), open orders and the owner's intents", () => {
    const p = page(() => ({}));
    p.set(
      "A",
      account({
        cards: [{ id: "card-1", agent: "0xa", agentName: "Claude Code", reason: "Claude Code asks to buy 0.01 BTC", shown: [{ name: "symbol", value: "BTC/USDT" }] }, { id: "card-2", agent: "0xa", agentName: "Claude Code", reason: "ETH", shown: [{ name: "symbol", value: "ETH/USDT" }] }],
        orders: [{ id: "ord-1", agent: "0xa", status: "open", symbol: "BTC/USDT", base: "BTC", side: "buy", qty: 0.01, type: "limit", limitPrice: 60000, venueName: "Exchange X" }, { id: "ord-2", status: "open", symbol: "BTC/USDT", base: "BTC", side: "buy", qty: 1, type: "market", venueName: "Exchange X" }],
        intents: [{ id: "intent-1", agent: "*", agentName: "every agent", symbol: "BTC/USDT", text: "Tell me if BTC moves <5%>", validUntil: "2026-10-13T00:00:00.000Z" }],
        keys: [{ address: "0xa", name: "Claude Code" }],
      }),
    );
    p.set("ITEM", btc);
    const on = p.run<{ orders: Array<{ id: string }>; cards: Array<{ id: string }>; intents: Array<{ id: string }> }>("mkAgentsOn(ITEM)");
    expect([on.cards.map((c) => c.id), on.orders.map((o) => o.id), on.intents.map((x) => x.id)]).toEqual([["card-1"], ["ord-1"], ["intent-1"]]);
    const html = p.run<string>("mkAgentsHtml(ITEM)");
    expect(html).toContain("Claude Code asks: Claude Code asks to buy 0.01 BTC");
    expect(html).toContain('Waiting for you · <button type="button" class="link" data-act="review" data-card="card-1" data-fk="review:card-1">Review</button>');
    expect(html).toContain("Claude Code: buy 0.01 BTC · limit 60,000");
    expect(html).toContain("You to every agent: “Tell me if BTC moves &lt;5%&gt;”");
    expect(p.run("[mkAssetKey(ITEM), mkAssetKey({ kind: 'perp', base: 'eth', at: [] }), mkAssetKey({ kind: 'event', at: [{ connected: false, symbol: 'x' }] })]")).toEqual(["crypto:BTC", "crypto:ETH", ""]);
    // Review closes the drawer and lands on that card under Portfolio
    p.run('var GONE = []; var CLOSED = 0; go = (tab, params) => GONE.push([tab, params]); closeDrawer = () => { CLOSED++; }; MKT.open = { item: ITEM, interval: "1h", ipo: [] }');
    p.run(`mkDrawerClick(${press({ act: "review", card: "card-1" })})`);
    expect(p.run("[GONE, CLOSED]")).toEqual([[["portfolio", { card: "card-1" }]], 1]);
  });

  it("counts down only its own countdowns: another pane's Close button that carries data-close keeps its word", () => {
    const p = page(() => ({}));
    p.set("A", account());
    // a document of two elements, matched by class and attribute as a browser would
    type El = { className: string; attrs: Record<string, string>; dataset: Record<string, string>; textContent: string; hasAttribute(n: string): boolean; setAttribute(n: string, v: string): void };
    const el = (className: string, attrs: Record<string, string>, textContent: string): El => ({ className, attrs, dataset: { close: attrs["data-close"] ?? "" }, textContent, hasAttribute: (n) => n in attrs, setAttribute: (n, v) => void (attrs[n] = v) });
    const btn = el("btn btn-sm", { "data-close": "BTC/USDT:USDT", "data-venue": "ex" }, "Close");
    const cd = el("mk-close", { "data-close": new Date(NOW + 90_000).toISOString() }, "");
    const g = p.run<{ document: { querySelectorAll: (sel: string) => El[] } }>("globalThis");
    g.document.querySelectorAll = (sel) => [btn, cd].filter((e) => [...sel.matchAll(/\.([\w-]+)|\[([\w-]+)\]/g)].every((m) => (m[1] ? e.className.split(" ").includes(m[1]) : m[2]! in e.attrs)));
    p.run("mkTick()");
    expect(btn.textContent).toBe("Close");
    expect(cd.textContent).toBe(p.run("mkLeft(90_000)"));
    expect(cd.textContent).not.toBe("Closed");
  });

  it("prices another pane's rows too: the Trade picker's data-pairs are polled while Trade is shown, and the poll stops only when no pane and no drawer needs it", async () => {
    const p = page(() => ({}));
    p.set("A", account());
    expect(p.run("typeof mkWatchPane")).toBe("function");
    const g = p.run<{ document: { getElementById: (id: string) => unknown } }>("globalThis");
    const was = g.document.getElementById;
    g.document.getElementById = (id) => (id === "pane-trade" ? { querySelectorAll: () => [{ dataset: { pairs: "ex|BTC/USDT" }, isConnected: true }] } : was(id));
    p.run('ROUTE.tab = "trade"; var ASKED = []; api = (path) => { ASKED.push(path); return Promise.resolve({ ok: true, quotes: [] }); }');
    await p.run("mkPoll()");
    expect(p.run("ASKED")).toEqual(["/api/account/quotes?pairs=ex%7CBTC%2FUSDT"]);
    // off Trade, that pane's rows are not asked for
    p.run('ROUTE.tab = "portfolio"; ASKED.length = 0');
    await p.run("mkPoll()");
    expect(p.run("ASKED")).toEqual([]);
    // the route: Markets and Trade keep the clocks; anywhere else with no drawer open stops them
    p.run("MKT.tick = 7; MKT.poll = 8; for (const fn of ROUTED) fn('trade', {}, true)");
    expect(p.run("[MKT.tick, MKT.poll]")).toEqual([7, 8]);
    p.run("for (const fn of ROUTED) fn('portfolio', {}, true)");
    expect(p.run("[MKT.tick, MKT.poll]")).toEqual([0, 0]);
  });

  it("sells from the drawer what the row is: a coin from what is held (never a short at a perpetual in the same coin), a perpetual only from its position", () => {
    const p = page(() => ({}));
    p.set("A", account());
    const perp = { key: "perp:BTC", kind: "perp", name: "BTC perpetual", base: "BTC", at: [{ venue: "ex", venueName: "Exchange X", symbol: "BTC/USDT:USDT", connected: true, canTrade: true, public: false, open: true }] };
    const asset = { ok: true, key: "crypto:BTC", row: { key: "crypto:BTC", venues: [{ venue: "ex", venueName: "Exchange X", amount: 0.5, usd: 31000 }] }, positions: [{ venue: "ex", venueName: "Exchange X", symbol: "BTC/USDT:USDT", kind: "perp", side: "long", qty: 0.01 }] };
    p.set("O", { item: btc, asset });
    expect(p.run("mkSellAt(O)")).toEqual({ venue: "ex", symbol: "BTC/USDT", venueName: "Exchange X" });
    p.set("O", { item: perp, asset });
    expect(p.run("mkSellAt(O)")).toEqual({ venue: "ex", symbol: "BTC/USDT:USDT", venueName: "Exchange X" });
    // a perpetual with no position: nothing to sell — the coin held at the same venue is not sold short there
    p.set("O", { item: perp, asset: { ...asset, positions: [] } });
    expect(p.run("mkSellAt(O)")).toBeNull();
    // a coin with only a perpetual position open: nothing held to sell
    p.set("O", { item: btc, asset: { ...asset, row: undefined } });
    expect(p.run("mkSellAt(O)")).toBeNull();
  });

  it("leaves nothing of the Venues board, the Now sections or the old Asset drawer behind", () => {
    const p = page(() => ({}));
    expect(p.run("['mkVenuesHtml', 'mkHealth', 'mkTrades', 'mkAgentsSwitch', 'mkUnplug', 'mkRekey', 'mkNowHtml', 'mkChip', 'mkOnePerBase', 'assetCandles', 'assetTargets', 'assetPx', 'assetDraw', 'assetRead', 'ASSET'].map((n) => typeof globalThis[n])")).toEqual(Array(15).fill("undefined"));
    for (const name of ["openAsset", "openMarket", "mkFindByKey", "mkLookup", "mkValuation", "mkIssuer", "mkWatchPane", "assetTitle", "assetItemOf"]) expect(p.run(`typeof ${name}`), name).toBe("function");
  });
});

describe("the one drawer", () => {
  const nvda = {
    key: "rwa:NVDA",
    kind: "rwa",
    name: "NVIDIA · Ondo Stock on Ethereum",
    base: "NVDA",
    price: 181.2,
    tabs: ["rwas"],
    issuer: "Ondo Global Markets",
    eligibility: "Ondo Global Markets: “not available to US persons, or to anyone in a sanctioned or prohibited jurisdiction” — the issuer's own words, which run long",
    at: [{ venue: "wallet", venueName: "Wallet", symbol: "NVDAon/USDC@Ethereum", connected: true, canTrade: true, public: false, price: 181.2, open: true }],
  };
  const ousg = {
    key: "rwa:OUSG",
    kind: "rwa",
    name: "OUSG",
    base: "OUSG",
    tabs: ["rwas"],
    at: [{ venue: "wallet", venueName: "Wallet", symbol: "OUSG/USDC@Ethereum", connected: true, canTrade: false, public: false, open: false, issuer: "Ondo Finance", eligibility: "OUSG moves only between wallets Ondo has approved", note: "OUSG moves only between wallets Ondo has approved" }],
  };
  const withWallet = () => account({ venues: [...account().venues, venue("wallet", "Wallet", { trade: { can: true, what: "tokens", kinds: ["token"] }, address: "0x1111111111111111111111111111111111111111", proven: "MetaMask" })] });
  /* what the account holds of BTC: the row, a perpetual position, an agent's resting order, a statement line, the cost of the row and of
     the position (said once) */
  const assetBtc = {
    ok: true,
    key: "crypto:BTC",
    row: { key: "crypto:BTC", asset: "BTC", class: "crypto", amount: 0.5, usd: 31000, price: 62000, changePct24h: 2.1, venues: [{ venue: "ex", venueName: "Exchange X", amount: 0.5, usd: 31000 }] },
    positions: [{ venue: "ex", venueName: "Exchange X", symbol: "BTC/USDT:USDT", name: "BTC perpetual", kind: "perp", side: "long", qty: 0.01, usd: 620, unrealizedUsd: 12, entryPrice: 60000, markPrice: 62000, leverage: 5 }],
    orders: [{ id: "ord-1", venue: "ex", venueName: "Exchange X", symbol: "BTC/USDT", base: "BTC", side: "buy", qty: 0.01, filledQty: 0, type: "limit", limitPrice: 60000, status: "open", agent: "0xa", authority: "agent" }],
    lines: [{ key: "l1", description: "Bought 0.01 BTC", accountName: "Exchange X", status: "filled", at: "2026-10-05T12:00:00.000Z" }],
    cost: [
      { key: "crypto:BTC", asset: "BTC", class: "crypto", coveredQty: 0.4, ofQty: 0.5, avgCostUsd: 58000, unrealizedUsd: 1600, realizedUsd: 0, source: "account orders", words: "cost known for 0.4 of 0.5 BTC" },
      { key: "position:ex:BTC/USDT:USDT", asset: "BTC", class: "position", coveredQty: 0.01, ofQty: 0.01, realizedUsd: 0, source: "venue", words: "cost known for 0.01 of 0.01 BTC" },
    ],
    missing: [],
  };
  const assetUsdc = { ok: true, key: "stable:USDC", row: { key: "stable:USDC", asset: "USDC", class: "stable", amount: 120, usd: 120, price: 1, venues: [{ venue: "ex", venueName: "Exchange X", amount: 120, usd: 120 }] }, positions: [], orders: [], lines: [], cost: [], missing: [] };

  it("hands a market to an agent with its venue's name (not its id, when only public prices list it) and the row's kind", () => {
    const p = page(() => ({}));
    p.set("A", account());
    p.set("ITEMS", { btc, doge, fed });
    p.run("var HANDED = []; globalThis.openHandToAgent = (x) => HANDED.push(x)");
    p.run("mkHand(ITEMS.doge); mkHand(ITEMS.btc); mkHand(ITEMS.fed)");
    const handed = p.run<Array<Record<string, string>>>("HANDED");
    // what the composer reads: where, which market, which way, the kind for its tag (the row's own key and base are not its business).
    // The kind is new here: the Trade pane is organised by kind now, so every hand-off names one
    expect(handed[0]).toEqual({ venue: "okx", symbol: "DOGE/USDT", venueName: "OKX", side: "buy", kind: "crypto" });
    expect(handed[1]).toMatchObject({ venue: "ex", symbol: "BTC/USDT", venueName: "Exchange X", kind: "crypto" });
    expect(handed[2]).toMatchObject({ venue: "kalshi", symbol: "KXFED-DEC:YES", kind: "predictions" });
  });

  it("draws any market's price history from the candles read — connected or public — with where it comes from as the picture's title, and says quietly in the venue's words when it keeps none", () => {
    const p = page(() => new Promise(() => {}));
    p.set("A", account());
    p.set("ITEMS", { btc, doge, fed });
    // where the history is asked: the connected venue first, else the public listing; an event's first outcome
    expect(p.run("JSON.stringify([mkCandleLeg(ITEMS.btc), mkCandleLeg(ITEMS.doge), mkCandleLeg(ITEMS.fed)])")).toBe(JSON.stringify([{ venue: "ex", symbol: "BTC/USDT", venueName: "Exchange X" }, { venue: "okx-public", symbol: "DOGE/USDT", venueName: "OKX" }, { venue: "kalshi", symbol: "KXFED-DEC:YES", venueName: "Kalshi" }]));
    p.run('var ASKED = []; api = (path) => { ASKED.push(path); return new Promise(() => {}); }; MKT.open = { item: ITEMS.doge, interval: "5m", asset: undefined, assetFor: "", compare: undefined, candles: undefined, ipo: [] }; mkDrawerLoad(MKT.open)');
    expect(p.run<string[]>("ASKED")[0]).toBe("/api/account/candles?venue=okx-public&symbol=DOGE%2FUSDT&interval=5m");
    const bars = Array.from({ length: 12 }, (_, i) => ({ t: NOW - (12 - i) * 300_000, o: 0.12, h: 0.125, l: 0.118, c: 0.12 + i / 1000 }));
    const chart = (candles: unknown, asset?: unknown) => p.run<string>(`mkChartHtml({ interval: "5m", candles: ${JSON.stringify(candles)}, asset: ${asset === undefined ? "undefined" : JSON.stringify(asset)} }, ITEMS.doge, mkCandleLeg(ITEMS.doge), "crypto:DOGE")`);
    // asked and not back yet: a skeleton; back: the line, where it came from in its title (no caption under it)
    expect(chart(null)).toContain("skel");
    const drawn = chart({ ok: true, venue: "okx-public", venueName: "OKX", symbol: "DOGE/USDT", interval: "5m", candles: bars, public: true });
    expect(drawn).toContain('class="spark mk-chart"');
    expect(drawn).toContain("<title>At OKX · DOGE/USDT</title>");
    expect(drawn).not.toContain('<p class="dim small">At OKX');
    expect(drawn).toContain("Price at OKX, 5m bars");
    // a series given whole, or its bars at the top of the answer, read the same
    expect(chart({ ok: true, candles: { venue: "okx-public", venueName: "OKX", symbol: "DOGE/USDT", interval: "5m", bars } })).toContain('class="spark mk-chart"');
    expect(chart({ ok: true, venue: "okx-public", venueName: "OKX", symbol: "DOGE/USDT", interval: "5m", bars })).toContain('class="spark mk-chart"');
    // the venue refuses: one quiet line in its words
    expect(chart({ ok: false, refusal: { code: "E_VENUE_RAIL_CLOSED", message: "OKX publishes no price history" } })).toBe('<p class="mk-quiet">OKX publishes no price history.</p>');
    expect(chart({ ok: false, refusal: { code: "E_VENUE_TIMEOUT", message: "no answer in 4 s" } })).toBe('<p class="mk-quiet">No price history from OKX: no answer in 4 s.</p>');
    expect(chart({ ok: true, venue: "okx-public", venueName: "OKX", symbol: "DOGE/USDT", interval: "5m", candles: [] })).toBe('<p class="mk-quiet">OKX has no 5m bars for it yet.</p>');
    // an account without the candles read: the Asset read's history, as before
    const assetBars = { ok: true, candles: { venue: "ex", venueName: "Exchange X", symbol: "DOGE/USDT", interval: "5m", bars }, missing: [] };
    expect(chart({ ok: false, error: "404 Not Found" }, assetBars)).toContain("<title>At Exchange X · DOGE/USDT</title>");
    expect(chart({ ok: false, error: "404 Not Found" })).toContain("skel");
  });

  it("says a market's 24 hours once, its facts without it, and no second key offered (connections live under Portfolio)", () => {
    const p = page(() => ({}));
    p.set("A", account());
    p.set("ITEMS", { btc, fed });
    const html = p.run<string>('mkDrawerHtml({ item: ITEMS.btc, interval: "1h", ipo: [] })');
    expect(html.match(/<span class="sr">up<\/span> 2.1%/g)).toHaveLength(1);
    expect(html).not.toContain("<dt>24h</dt>");
    expect(html).toContain("<dt>Bid</dt>");
    expect(html).toContain("<dt>Volume 24h</dt><dd>$1.9B</dd>");
    expect(html).not.toContain('data-act="rekey"');
    // the parts, each in its own element, in the brief's order
    expect([...html.matchAll(/data-sec="([a-z]+)"/g)].map((m) => m[1])).toEqual(["head", "chart", "across", "ipo", "held", "agents", "lines"]);
    expect(html.indexOf('aria-label="Across venues"')).toBeLessThan(html.indexOf('aria-label="You hold"'));
    expect(html.indexOf('aria-label="You hold"')).toBeLessThan(html.indexOf('aria-label="Agents on it"'));
    expect(html.indexOf('aria-label="Agents on it"')).toBeLessThan(html.indexOf('aria-label="On the statement"'));
    // an event: cents, its outcome's name, the change in cents, once
    const ev = p.run<string>('mkDrawerHtml({ item: ITEMS.fed, interval: "1h", ipo: [] })');
    expect(ev).toContain('<span class="num-m" data-q="kalshi|KXFED-DEC:YES" data-fmt="c-last">62¢</span><span class="dim">Yes</span>');
    expect(ev).toContain("<dt>Closes</dt>");
  });

  it("says a tokenised asset's issuer and whom it is for: a short line on its row, all of it in the drawer; a restricted one in the issuer's words, never a dead button", () => {
    const p = page(() => ({}));
    p.set("A", withWallet());
    p.set("ITEMS", { nvda, ousg });
    const rows = p.run<string>("MKT.reg = []; mkTable([ITEMS.nvda, ITEMS.ousg], '')");
    expect(rows).toContain('<span class="mk-iss" title="Issued by Ondo Global Markets · Ondo Global Markets: “not available to US persons');
    expect(rows).toContain(">Issued by Ondo Global Markets · Ondo Global Markets: “not available to US persons, or…</span>");
    // the issuer and its words carried on a listing read the same
    expect(rows).toContain(">Issued by Ondo Finance · OUSG moves only between wallets Ondo has approved</span>");
    // NVDA trades at the wallet; OUSG does not: its button opens the drawer, whose callout gives the issuer's rule
    expect(rows).toContain('data-act="trade" data-i="0"');
    expect(rows).toContain('data-act="open" data-i="1" data-fk="why:rwa:OUSG" title="Wallet: OUSG moves only between wallets Ondo has approved."');
    const drawer = p.run<string>('mkDrawerHtml({ item: ITEMS.ousg, interval: "1h", asset: undefined, compare: undefined, candles: undefined, ipo: [] })');
    expect(drawer).toContain('<div class="box mk-iss-box"><div class="label">Issuer</div><b>Ondo Finance</b><p class="small">OUSG moves only between wallets Ondo has approved</p></div>');
    expect(drawer).toContain("<div class=\"label\">Can't trade it here</div><p>Wallet: OUSG moves only between wallets Ondo has approved.</p>");
    expect(drawer).not.toContain('data-act="trade"');
    // anything else has no issuer line
    p.set("ITEMS", { btc });
    expect(p.run("mkIssuer(ITEMS.btc)")).toBeNull();
  });

  it("draws a pre-IPO contract by the valuation its price implies — in the row, in the drawer once, and venue by venue in each venue's own unit — only under All and Pre-IPO, with the IPO markets about the company", () => {
    const p = page(() => ({}));
    p.set("A", kalshiTrades());
    p.set("ITEMS", { anth, ipoEvent, btcPerp });
    expect(p.run("[mkIsPreipo(ITEMS.anth), mkIsPreipo(ITEMS.btcPerp), mkIsPreipo({ kind: 'perp', category: 'Pre-IPO' })]")).toEqual([true, false, true]);
    expect(p.run("mkImplied(ITEMS.anth)")).toEqual({ usd: 2.08e12, unit: "$1 of contract price stands for $1B of valuation", perPoint: 1e9 });
    // the valuation from the price and the venue's dollars a point, when the venue did not say it outright
    expect(p.run("mkImplied({ price: 208, implied: { perPoint: 1e10, unit: 'u' } }).usd")).toBe(2.08e12);
    // the row: the valuation is the figure, tagged implied; the contract price under it, ticking from the connected venue
    const rows = p.run<string>("MKT.reg = []; mkTable([ITEMS.anth], '')");
    expect(rows).toContain('<span class="mk-implied"><b>$2.08T</b> <span class="tag">implied</span></span><span class="dim small mk-contract" data-q="ex|ANTHROPIC/USDT:USDT" data-fmt="usd">$208.00</span>');
    expect(rows).toContain("Pre-IPO · Perpetual");
    expect(rows).toContain('data-act="trade" data-i="0" data-fk="trade:perp:ANTHROPIC"');
    // without the valuation it is an ordinary perpetual row
    const plain = p.run<string>("MKT.reg = []; mkTable([{ ...ITEMS.anth, implied: undefined, category: undefined }], '')");
    expect(plain).not.toContain("implied");
    expect(plain).toContain("$208.00");
    // Perps leaves pre-IPO contracts to the Pre-IPO tab
    expect(p.run<string>("MKT.reg = []; mkListHtml({ tab: 'perps', q: '', sort: '' }, { items: [ITEMS.btcPerp, ITEMS.anth] }, lensNow())")).not.toContain("Anthropic");
    expect(p.run<string>("MKT.reg = []; mkListHtml({ tab: 'preipo', q: '', sort: '' }, { items: [ITEMS.anth] }, lensNow())")).toContain("Anthropic pre-IPO");
    // the drawer: the valuation once in the head with the contract price and the unit sentence under it; the issuer's words; Across venues
    // with each venue's own contract price and unit; Trade at the connected venue, no connection offered for OKX (the row trades here)
    const drawer = p.run<string>('mkDrawerHtml({ item: ITEMS.anth, interval: "1h", ipo: [], ipoRead: { items: [ITEMS.ipoEvent] } })');
    expect(drawer.match(/\$2\.08T/g)).toHaveLength(3);
    expect(drawer).toContain('<span class="num-m">$2.08T</span><span class="tag">implied</span>');
    expect(drawer).toContain('<span class="mk-contract"><span data-q="ex|ANTHROPIC/USDT:USDT" data-fmt="usd">$208.00</span> a contract · $1 of contract price stands for $1B of valuation</span>');
    expect(drawer).toContain("Pre-IPO · Anthropic · ANTHROPIC");
    // the company's own words — never as an issuer's: the venue writes the contract, the company says such transfers are void
    expect(drawer).toContain('<div class="box mk-iss-box"><div class="label">What the company says</div><p class="small">Anthropic, 29 June 2026: transfers of its shares without its approval are void</p></div>');
    expect(drawer).not.toContain("Issued by Anthropic");
    expect(drawer).not.toContain('<div class="label">Issuer</div>');
    expect(rows).not.toContain("Issued by");
    // a perpetual's side buttons are the ticket's words: Long and Short
    expect(drawer).toContain('data-fk="d-buy"');
    expect(drawer).toMatch(/data-act="trade" data-fk="d-buy"[^>]*>Long</);
    expect(drawer).toMatch(/data-act="short" data-fk="d-short"[^>]*>Short</);
    expect(drawer).toContain('<span class="why mk-unit">$2.08T implied · OKX: $1 of contract price stands for $10B of valuation (since 30 June 2026)</span>');
    expect(drawer).toContain('<span class="why mk-unit">$2.08T implied · Exchange X: $1 of contract price stands for $1B of valuation</span>');
    expect(drawer).toContain('<th scope="col" class="r">Contract</th>');
    expect(drawer).toContain("$2,080.00");
    expect(drawer).toContain('data-act="trade-at" data-venue="ex" data-symbol="ANTHROPIC/USDT:USDT"');
    expect(drawer).not.toContain("Connect to trade");
    // the IPO markets about the company, as lean cards whose Yes and No open the predictions ticket
    expect(drawer).toContain('<section class="sec" aria-label="IPO markets"><h2 class="h2">IPO markets</h2><div class="cards-grid mk-cards">');
    expect(drawer).toContain("Anthropic IPO before 2027?");
    expect(drawer).toContain('Yes · <span data-q="kalshi|KXIPOANTHROPIC-26:YES" data-fmt="c">32¢</span>');
    expect(drawer).not.toContain("IPOs · Kalshi");
    p.run('var TICKETS = []; globalThis.openTicket = (x) => TICKETS.push(x); MKT.open = { item: ITEMS.anth, interval: "1h", ipo: [], ipoRead: { items: [ITEMS.ipoEvent] } }; mkDrawerHtml(MKT.open)');
    expect(p.run("MKT.open.ipo[0].key")).toBe("kalshi:KXIPOANTHROPIC-26");
    p.run(`mkDrawerClick(${press({ act: "yn", i: "0", o: "0" })})`);
    expect(p.run("TICKETS[0]")).toEqual({ venue: "kalshi", symbol: "KXIPOANTHROPIC-26:YES", side: "buy", outcome: "YES", kind: "predictions", key: "kalshi:KXIPOANTHROPIC-26", name: "Anthropic IPO before 2027?" });
    // nothing about the company yet: said so; the read for it still on its way: a skeleton
    expect(p.run<string>('mkDrawerHtml({ item: ITEMS.anth, interval: "1h", ipo: [], ipoRead: { items: [] } })')).toContain("No prediction market about Anthropic's IPO is listed");
    expect(p.run<string>('mkDrawerHtml({ item: ITEMS.anth, interval: "1h", ipo: [], ipoRead: null })')).toContain('aria-label="IPO markets"><h2 class="h2">IPO markets</h2><div class="skel-rows"');
    // what the drawer reads for it: its candles, its asset, the IPO markets — never the comparison (each venue's unit is its own)
    p.run('var ASKED = []; api = (path) => { ASKED.push(path); return new Promise(() => {}); }; MKT.open = { item: ITEMS.anth, interval: "1h", asset: undefined, assetFor: "", compare: undefined, candles: undefined, ipoRead: undefined, ipo: [] }; mkDrawerLoad(MKT.open)');
    const asked = p.run<string[]>("ASKED");
    expect(asked).toContain("/api/account/candles?venue=ex&symbol=ANTHROPIC%2FUSDT%3AUSDT&interval=1h");
    expect(asked).toContain("/api/account/explore?tab=predictions&q=Anthropic&limit=12");
    expect(asked.some((x) => x.startsWith("/api/account/compare"))).toBe(false);
  });

  it("opens by a holding's key (openAsset): the coin's own row from what Markets read — never its perpetual's — else, for a holding no listing carries, from the asset read alone", async () => {
    const asked: string[] = [];
    const p = page((path) => {
      asked.push(path);
      if (path.startsWith("/api/account/explore")) return { ...explore, items: path.includes("q=USDC") ? [] : [fed, btcPerp, btc, doge] };
      if (path.startsWith("/api/account/asset")) return path.includes("stable%3AUSDC") ? assetUsdc : path.includes("crypto%3ABTC") ? assetBtc : { ok: false, refusal: { message: "the venue said no" } };
      return {};
    });
    p.set("A", account());
    // the drawer stands open once drawn, so the reads that land afterwards redraw it in place (as in a browser)
    const g = p.run<{ document: { getElementById: (id: string) => unknown } }>("globalThis");
    const was = g.document.getElementById;
    const body = { innerHTML: "", querySelectorAll: () => [], contains: () => false, addEventListener() {} };
    const drawer = { open: true, addEventListener() {}, querySelector: () => body, querySelectorAll: () => [], innerHTML: "", dataset: {}, setAttribute() {} };
    g.document.getElementById = (id) => (id === "drawer" ? drawer : was(id));
    p.run("var DRAWN = []; var TOASTS = []; openDrawer = (html, opts) => { DRAWN.push([opts.title, html]); return { addEventListener() {} }; }; toast = (t, k) => TOASTS.push([t, k])");
    // a coin held: its row from Markets, the coin before the perpetual
    await p.run("openAsset('crypto:BTC')");
    expect(asked[0]).toBe("/api/account/explore?q=BTC&limit=200");
    expect(p.run("DRAWN.length")).toBe(1);
    expect(p.run("DRAWN[0][0]")).toBe("Bitcoin");
    expect(p.run("MKT.open.item.key")).toBe("coin:BTC");
    expect(p.run("mkResolve({ key: 'crypto:BTC' }).key")).toBe("coin:BTC");
    expect(p.run("mkResolve({ key: 'perp:BTC' }).key")).toBe("perp:BTC");
    // the drawer's own asset read is on the same key
    expect(asked.some((x) => x === "/api/account/asset?key=crypto%3ABTC&interval=1h")).toBe(true);
    // a stablecoin held: no listing carries it, so the asset read opens it, at the price the venue last read
    await p.run("openAsset('stable:USDC')");
    expect(p.run("DRAWN.length")).toBe(2);
    expect(p.run("DRAWN[1][0]")).toBe("USDC");
    const html = p.run<string>("DRAWN[1][1]");
    expect(html).toContain("as your venue last read it");
    expect(html).toContain('aria-label="You hold"');
    expect(html).not.toContain('aria-label="Across venues"');
    expect(html).not.toContain("Can't trade it here");
    expect(p.run("[MKT.open.item.heldKey, MKT.open.item.kind, mkAssetKey(MKT.open.item)]")).toEqual(["stable:USDC", "stable", "stable:USDC"]);
    // drawn with the asset read in hand: what is held, where
    const held = p.run<string>(`mkDrawerHtml({ item: assetItemOf("stable:USDC", ${JSON.stringify(assetUsdc)}), interval: "1h", asset: ${JSON.stringify(assetUsdc)}, ipo: [] })`);
    expect(held).toContain("120 USDC · $120.00");
    expect(held).toContain("Exchange X");
    expect(held).toContain("Stablecoin");
    // no dash for a 24 hours its venue did not give, no box of facts it has none of
    expect(held).not.toContain('<span class="flat">—</span>');
    expect(held).not.toContain("<dt>Bid</dt>");
    expect(held).not.toContain('<dl class="mk-facts">');
    // the account refuses the read: its words, no drawer
    await p.run("openAsset('equity:ZZZZ')");
    expect(p.run("DRAWN.length")).toBe(2);
    expect(p.run("TOASTS")).toEqual([["the venue said no", "no"]]);
    expect(p.run("[assetTitle('event:FED:YES', { positions: [{ kind: 'event', name: 'Fed · Yes' }] }), assetTitle('cash:USD', {}), assetTitle('crypto:BTC', { row: { asset: 'BTC' } })]")).toEqual(["Fed · Yes", "Cash · USD", "BTC"]);
  });

  it("shows what is held once each — holdings, positions with Close…, open orders with Cancel, what was paid — and its statement lines; every button goes through the one door", () => {
    const p = page(() => ({}));
    p.set("A", account({ keys: [{ address: "0xa", name: "Claude Code" }] }));
    p.set("ITEM", btc);
    p.set("ASSET", assetBtc);
    p.run("globalThis.openStatement = () => OPENED.push('statement'); var OPENED = []");
    const html = p.run<string>('mkDrawerHtml({ item: ITEM, interval: "1h", asset: ASSET, ipo: [] })');
    expect(html).toContain("0.5 BTC · $31,000.00");
    expect(html).toContain("Long 0.01 · BTC perpetual");
    expect(html).toContain('data-act="close" data-venue="ex" data-symbol="BTC/USDT:USDT" data-fk="close:ex:BTC/USDT:USDT">Close…</button>');
    expect(html).toContain("Buy 0.01 BTC · limit 60,000");
    expect(html).toContain('data-act="cancel" data-order="ord-1" data-venue="ex" data-fk="cancel:ord-1">Cancel</button>');
    expect(html).toContain("Exchange X · Claude Code · 0 of 0.01 filled");
    // what was paid, said once (the position's own cost line is not repeated under it)
    expect(html).toContain('<p class="mk-cost">Paid $58,000.00 on average · <span class="up"><span aria-hidden="true">▲</span><span class="sr">up</span> $1,600.00</span> since bought <span class="dim">(cost known for 0.4 of 0.5 BTC, from account orders)</span></p>');
    expect(html.match(/cost known for/g)).toHaveLength(1);
    // the statement lines, and the way to the whole statement
    expect(html).toContain("Bought 0.01 BTC");
    expect(html).toContain('data-act="statement" data-fk="d-statement">Open the Statement →</button>');
    // Sell goes where the coin is held
    expect(html).toContain('data-act="sell" data-venue="ex" data-symbol="BTC/USDT" data-fk="d-sell"');
    // a browser that only looks: no Close…, no Cancel
    p.run('Owner.role = "pending"');
    const looks = p.run<string>('mkDrawerHtml({ item: ITEM, interval: "1h", asset: ASSET, ipo: [] })');
    expect(looks).not.toContain('data-act="close"');
    expect(looks).not.toContain('data-act="cancel"');
    p.run('Owner.role = "owner"');
    // the doors: Close… is the Trade pane's close, Cancel the one signed cancel, the Statement the statement's opener
    p.run('var CLOSED = []; var CANCELED = []; globalThis.openClose = (x) => CLOSED.push(x.symbol); cancelOrder = (o, then) => { CANCELED.push([o.id, typeof then]); return null; }; closeDrawer = () => {}; MKT.open = { item: ITEM, interval: "1h", asset: ASSET, ipo: [] }');
    p.run(`mkDrawerClick(${press({ act: "close", venue: "ex", symbol: "BTC/USDT:USDT" })})`);
    p.run(`mkDrawerClick(${press({ act: "cancel", venue: "ex", order: "ord-1" })})`);
    p.run(`mkDrawerClick(${press({ act: "statement" })})`);
    expect(p.run("[CLOSED, CANCELED, OPENED]")).toEqual([["BTC/USDT:USDT"], [["ord-1", "function"]], ["statement"]]);
    // nothing held of a coin only public prices list: said plainly; nothing on the statement either
    const none = p.run<string>(`mkDrawerHtml({ item: ${JSON.stringify(doge)}, interval: "1h", asset: { ok: true, key: "crypto:DOGE", positions: [], orders: [], lines: [], cost: [], missing: [] }, ipo: [] })`);
    expect(none).toContain("You don’t hold any.");
    expect(none).toContain("Nothing on the statement about it yet.");
  });

  it("asks for the All list once, ahead of the first visit, so Markets comes in drawn instead of a skeleton swapped after its entrance", async () => {
    const explore = { ok: true, items: [], tabs: [{ id: "all", label: "All", count: 0 }], notes: [], missing: [] };
    const p = page(() => explore);
    p.set("A", account());
    p.run("mkPrefetch(); mkPrefetch();");
    await settle();
    p.run("mkPrefetch();");
    // one read of the All list (the very path the All tab draws from), none again while it is kept
    expect(p.asked.map((a) => a.path)).toEqual(["/api/account/explore"]);
    expect(p.run('MKT.got.get("/api/account/explore").good.tabs[0].id')).toBe("all");
    // the shell asks for it (and for the Trade picker's lists) once the first account read is drawn, when the browser is idle
    const shell = readFileSync(join(PUBLIC, "ui/shell.js"), "utf8");
    expect(shell).toMatch(/requestIdleCallback\(ahead/);
    expect(shell).toMatch(/typeof mkPrefetch === "function"\) mkPrefetch\(\)/);
    expect(shell).toMatch(/typeof tkReadKinds === "function"\) tkReadKinds\(\)/);
  });

  it("names two venues in Where, the rest as +N with their names in its title, so a row stays short", () => {
    const p = page(() => ({}));
    p.set("A", account());
    const at = (venueName: string, connected: boolean) => ({ venue: venueName.toLowerCase(), venueName, symbol: "BTC/USDT", connected, canTrade: connected, public: !connected });
    const html = p.run<string>(`mkWhere(${JSON.stringify({ key: "coin:BTC", kind: "coin", name: "Bitcoin", at: [at("Kraken", false), at("Exchange X", true), at("OKX", false), at("Coinbase", false)] })})`);
    // yours first, then the public ones; two by name
    expect(html).toContain('<span class="mk-v">Exchange X</span> · ');
    expect(html).toContain('<span class="mk-v pub" title="Public prices, read without a key">Kraken</span>');
    expect(html).toContain('<span class="dim mk-more" title="OKX, Coinbase">+2</span>');
    expect(p.run<string>(`mkWhere(${JSON.stringify({ key: "coin:ETH", kind: "coin", name: "Ether", at: [at("Exchange X", true)] })})`)).not.toContain("mk-more");
  });

  it("offers Connect to trade only at a venue that would take the user from where they are; one that would not says so in its own words, on the row and in the drawer", () => {
    const p = page(() => ({}));
    p.set("A", account());
    const at = (venue: string, venueName: string, connector: string) => ({ venue, venueName, symbol: "BTC-PERP", connected: false, canTrade: false, public: true, connectTo: venue, connector, price: 62_000 });
    const item = { key: "perp:BTC", kind: "perp", name: "BTC perpetual", base: "BTC", price: 62_000, tabs: ["perps"], at: [at("hyperliquid-trade", "Hyperliquid", "live:exchange:okx")] };
    // not judged yet: offered as before
    expect(p.run<Record<string, unknown>>(`mkRoute(${JSON.stringify(item)})`)).toMatchObject({ act: "connect", venueName: "Hyperliquid" });
    // the venue refuses this network: no connection offered, its words instead — the row's button says it
    p.run(`VENUES.set("live:exchange:okx", { connector: "live:exchange:okx", name: "Hyperliquid", verdict: "not-served", said: "Hyperliquid's Terms of Use §1.6 do not serve this location." })`);
    const r = p.run<Record<string, string>>(`mkRoute(${JSON.stringify(item)})`);
    expect(r).toMatchObject({ act: "why", word: "Not served here" });
    expect(r.text).toBe("Hyperliquid: not served here — Hyperliquid's Terms of Use §1.6 do not serve this location.");
    expect(p.run<string>(`mkActs(${JSON.stringify(item)}, 0)`)).toContain(">Not served here · why</button>");
    // two venues list it, one would take the user: that one is offered
    const two = { ...item, at: [item.at[0], at("kraken", "Kraken", "live:exchange:kraken")] };
    expect(p.run<Record<string, unknown>>(`mkRoute(${JSON.stringify(two)})`)).toMatchObject({ act: "connect", venueName: "Kraken" });
    // both would refuse: none of them is offered, and the row says how many list it
    p.run(`VENUES.set("live:exchange:kraken", { connector: "live:exchange:kraken", name: "Kraken", verdict: "terms-exclude", said: "its terms exclude where you are" })`);
    expect(p.run<Record<string, string>>(`mkRoute(${JSON.stringify(two)})`).text).toMatch(/^None of the 2 venues that list it would take you from where you are\. Hyperliquid: not served here/);
    // setup and no answer are not a no: a venue that did not answer just now is still offered
    p.run(`VENUES.set("live:exchange:kraken", { connector: "live:exchange:kraken", name: "Kraken", verdict: "no-answer" })`);
    expect(p.run<Record<string, unknown>>(`mkRoute(${JSON.stringify(two)})`)).toMatchObject({ act: "connect", venueName: "Kraken" });
    p.run(`VENUES.clear()`);
  });

  it("the list of accounts reads the account's detection too: a venue whose own terms exclude where the user is is marked and said, never closed; one that refuses this network is closed", () => {
    const p = page(() => ({}));
    p.set("A", account());
    const terms = "its terms exclude where you are (https://www.okx.com/help/terms-of-service, read 2026-10-08): “…Restricted Persons…” — the venue checks residency when an account is opened; the account does not";
    p.run(`VENUES.set("live:exchange:okx", { connector: "live:exchange:okx", name: "OKX", verdict: "terms-exclude", said: ${JSON.stringify(terms)}, asked: "2026-10-06T05:00:00.000Z" })`);
    p.run(`VENUES.set("live:exchange:bybit", { connector: "live:exchange:bybit", name: "Bybit", verdict: "not-served", said: "Bybit does not serve this location", asked: "2026-10-06T05:00:00.000Z" })`);
    expect(p.run("tileSays('live:exchange:okx')")).toMatchObject({ word: "Its terms exclude where you are", shut: false, state: "terms" });
    expect(p.run("tileSays('live:exchange:bybit')")).toMatchObject({ word: "Not served here", shut: true });
    const cat = p.run<string>("catalog(true)");
    expect(cat).toContain('data-extra="okx"');
    expect(cat).toMatch(/data-extra="okx" title="its terms exclude where you are[^"]*"><b>OKX<\/b><span><em class="off">Its terms exclude where you are<\/em>/);
    expect(cat).toMatch(/data-extra="bybit" title="Bybit does not serve this location"><b>Bybit<\/b><span><em class="off">Not served here<\/em>/);
    // the form's note for the terms: the venue's words and when they were judged — no Check again, no watch-instead, and the form stays open
    const note = p.run<string>("reachNoteHtml(tileSays('live:exchange:okx'), 'exchange')");
    expect(note).toContain("the venue checks residency when an account is opened; the account does not");
    expect(note).not.toContain("data-reach=");
    // this form's own fresh check wins over the detection for a no; a venue the form found answering keeps its terms note
    p.run(`REACH.set("live:exchange:bybit", { connector: "live:exchange:bybit", state: "ok", at: "2026-10-06T05:00:00.000Z" })`);
    expect(p.run("tileSays('live:exchange:bybit')")).toBeNull();
    p.run(`REACH.set("live:exchange:okx", { connector: "live:exchange:okx", state: "ok", at: "2026-10-06T05:00:00.000Z" })`);
    expect(p.run("tileSays('live:exchange:okx')")).toMatchObject({ shut: false, state: "terms" });
    p.run("VENUES.clear(); REACH.clear()");
  });

  it("lists the watchlist without a lead sentence or a date column: the date is the star's title", () => {
    const p = page((path) => (path.startsWith("/api/account/explore") ? explore : {}));
    p.set("A", account({ watch: [{ venue: "ex", symbol: "BTC/USDT", at: "2026-10-06T04:00:00.000Z" }, { venue: "kraken", symbol: "ETH/USD", at: "2026-10-01T04:00:00.000Z" }] }));
    p.run(`MKT.got.set(${JSON.stringify("/api/account/explore?limit=200")}, { at: ${NOW}, body: ${JSON.stringify(explore)}, good: ${JSON.stringify(explore)}, goodAt: ${NOW} })`);
    const html = p.run<string>("MKT.reg = []; mkWatchingHtml(lensNow())");
    expect(html).not.toContain("Your agents read this list");
    expect(html).not.toContain(">Watched<");
    expect(html).toContain('title="Watching since Tue 6 Oct"');
    expect(html).toContain('title="Watching since Thu 1 Oct"');
    // the watched BTC is the row Markets lists; the Kraken market no read carries is a row of its own that still prices, opens and connects
    expect(html).toContain('data-fk="open:coin:BTC"');
    expect(html).toContain("ETH/USD");
    expect([...html.matchAll(/<th scope="col"[^>]*>(?:<span class="sr">)?([^<]*)/g)].map((m) => m[1])).toEqual(["Watch", "Market", "Where", "Price", "24h", "Actions"]);
  });
});

describe("a stock out of its session", () => {
  /* a broker connected live, and a stock it lists at night: still open for orders (the broker holds them for the open), out of its session */
  const withBroker = () => account({ venues: [...account().venues, venue("broker", "Broker", { trade: { can: true, what: "US stocks and ETFs", kinds: ["stock"] } })] });
  const NIGHT = { open: false, opensAt: "2026-10-06T13:30:00.000Z", closesAt: "2026-10-06T20:00:00.000Z" };
  const DAY = { open: true, opensAt: "2026-10-07T13:30:00.000Z", closesAt: "2026-10-06T20:00:00.000Z" };
  const HELD = "the US stock market is closed: Broker holds an order and sends it when the market opens (2026-10-06 09:30 New York time)";
  const aapl = (session?: unknown) => ({
    key: "stock:AAPL",
    kind: "stock",
    name: "Apple Inc.",
    base: "AAPL",
    price: 255.12,
    changePct24h: 0.4,
    volumeUsd24h: 5.1e9,
    ...(session ? { session } : {}),
    tabs: ["all", "stocks"],
    at: [{ venue: "broker", venueName: "Broker", symbol: "AAPL", connected: true, canTrade: true, public: false, price: 255.12, open: true, ...(session ? { session } : {}), ...(session && !(session as { open: boolean }).open ? { note: HELD } : {}) }],
  });

  it("says Closed beside its price, with when it opens as the tag's title — from the venue's own stamp, and only while it is out of session", () => {
    const p = page(() => ({}));
    p.set("A", withBroker());
    p.set("ITEMS", { night: aapl(NIGHT), day: aapl(DAY), unknown: aapl() });
    const night = p.run<string>("MKT.reg = []; mkTable([ITEMS.night], '')");
    expect(night).toContain('<span class="tag" title="Opens Tue 6 Oct, 09:30 New York">Closed</span> <span data-q="broker|AAPL" data-fmt="usd">$255.12</span>');
    // still traded: a broker holds the order for the open, and the drawer says so in its words
    expect(night).toContain('data-act="trade"');
    // in session, and where no venue says a session: no tag (never read from `open`)
    expect(p.run<string>("mkTable([ITEMS.day], '')")).not.toContain(">Closed<");
    expect(p.run<string>("mkTable([ITEMS.unknown], '')")).not.toContain(">Closed<");
    // a fresh price read with the venue's clock says the session now: in session, the tag goes; out of it, it comes
    p.run(`MKT.quotes.set("broker|AAPL", { at: ${NOW}, market: { price: 256, session: ${JSON.stringify(DAY)} } })`);
    expect(p.run<string>("mkTable([ITEMS.night], '')")).not.toContain(">Closed<");
    p.run(`MKT.quotes.set("broker|AAPL", { at: ${NOW}, market: { price: 256, session: ${JSON.stringify(NIGHT)} } })`);
    expect(p.run<string>("mkTable([ITEMS.unknown], '')")).toContain('title="Opens Tue 6 Oct, 09:30 New York">Closed</span>');
    // a coin has no session, whatever a line carries
    expect(p.run<string>(`mkTable([{ ...${JSON.stringify(btc)}, session: ${JSON.stringify(NIGHT)} }], '')`)).not.toContain(">Closed<");
  });

  it("says it in the drawer's facts — Closed · opens …, or Open · closes … — and nothing where no venue says a session", () => {
    const p = page(() => ({}));
    p.set("A", withBroker());
    p.set("ITEMS", { night: aapl(NIGHT), day: aapl(DAY), unknown: aapl() });
    const night = p.run<string>('mkDrawerHtml({ item: ITEMS.night, interval: "1h", ipo: [] })');
    expect(night).toContain("<dt>Session</dt><dd>Closed · opens Tue 6 Oct, 09:30 New York</dd>");
    // Buy stays: the broker takes the order and holds it for the open
    expect(night).toContain('data-act="trade" data-fk="d-buy"');
    expect(p.run<string>('mkDrawerHtml({ item: ITEMS.day, interval: "1h", ipo: [] })')).toContain("<dt>Session</dt><dd>Open · closes 16:00 New York</dd>");
    expect(p.run<string>('mkDrawerHtml({ item: ITEMS.unknown, interval: "1h", ipo: [] })')).not.toContain("<dt>Session</dt>");
    // the Watching tab's row says it too
    p.set("A", { ...withBroker(), watch: [{ venue: "broker", symbol: "AAPL", at: "2026-10-06T04:00:00.000Z" }] });
    const read = { ...explore, items: [aapl(NIGHT)] };
    p.run(`MKT.got.set(${JSON.stringify("/api/account/explore?limit=200")}, { at: ${NOW}, body: ${JSON.stringify(read)}, good: ${JSON.stringify(read)}, goodAt: ${NOW} })`);
    expect(p.run<string>("MKT.reg = []; mkWatchingHtml(lensNow())")).toContain('title="Opens Tue 6 Oct, 09:30 New York">Closed</span>');
  });
});
