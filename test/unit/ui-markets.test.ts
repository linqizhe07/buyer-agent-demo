import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext, Script } from "node:vm";
import { describe, expect, it } from "vitest";

/** The Markets pane (ui/markets.js) and the connections it opens (ui/connect.js), run as the page runs them — after ui/core.js, in one global
 * scope — in a stand-in browser: what it draws from an explore read, what each button signs or asks, and that a venue that refuses is shown
 * in its own words. No server: the reads are answered here */
const PUBLIC = fileURLToPath(new URL("../../src/portfolio/public/", import.meta.url));
const NOW = Date.parse("2026-10-06T05:00:00.000Z");

const venue = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, live: true, usd: 100, cashUsd: 0, holdings: [], asOf: "2026-10-06T04:59:00.000Z", plugged: true, ...extra });
const account = (over: Record<string, unknown> = {}) => ({
  now: new Date(NOW).toISOString(),
  venues: [venue("ex", "Exchange X", { trade: { can: true, what: "spot and perpetuals", kinds: ["spot", "perp"] } }), venue("kalshi", "Kalshi", { trade: { can: false, what: "event contracts", kinds: ["event"] } })],
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
const explore = {
  ok: true,
  asOf: new Date(NOW).toISOString(),
  tabs: [{ id: "now", label: "Now", count: 3 }, { id: "crypto", label: "Crypto", count: 2 }, { id: "predictions", label: "Predictions", count: 1 }],
  items: [fed, btc, doge],
  movers: [doge],
  closing: [fed],
  mostTraded: [btc, doge],
  missing: [{ venue: "binance-public", venueName: "Binance", why: "Binance does not serve this location: that is its own rule, and the account does not look for a way around it", said: "Service unavailable from a restricted location.", code: "E_VENUE_GEOBLOCKED", connected: false }],
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
  for (const f of ["ui/core.js", "ui/connect.js", "ui/markets.js"]) new Script(readFileSync(join(PUBLIC, f), "utf8"), { filename: f }).runInContext(ctx);
  const run = <T = unknown>(code: string) => runInContext(code, ctx) as T;
  return { run, asked, set: (name: string, value: unknown) => run(`${name} = ${JSON.stringify(value)}`) };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("the Markets pane", () => {
  it("says prices, volumes and countdowns as a person reads them", () => {
    const p = page(() => ({}));
    expect(p.run('[mkCents(0.62), mkCents(0.004), mkCents(0), mkCents(undefined)]')).toEqual(["62¢", "0.4¢", "0¢", "—"]);
    expect(p.run('[mkVol(1.9e9), mkVol(120e6), mkVol(880000), mkVol(412), mkVol(undefined)]')).toEqual(["$1.9B", "$120M", "$880k", "$412", "—"]);
    expect(p.run('[mkUsd(62140), mkUsd(0.12121), mkUsd(null)]')).toEqual(["$62,140.00", "$0.1212", "—"]);
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
    // the ★ in the pane signs exactly that
    p.run("MKT.reg = [ITEMS.doge]");
    p.run('mkPaneClick({ target: { closest: (s) => (s === "[data-act]" ? { dataset: { act: "watch", i: "0" }, disabled: false } : null) } })');
    await settle();
    drafts.push(...p.run<unknown[]>("DRAFTS"));
    expect(JSON.stringify(drafts)).toBe(JSON.stringify([{ type: "setWatch", venue: "okx", symbol: "DOGE/USDT", on: "" }]));
  });

  it("draws a card with Yes and No in cents, a countdown, the question escaped, and fresh prices asked only at connected venues", () => {
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
    expect(html).toContain("Kalshi · Polymarket · $4.1M vol");
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

  it("draws only the tabs the explore read returns, with a skeleton while it loads, and keeps what it drew when a later read fails", async () => {
    let fail = false;
    const p = page((path) => (path.startsWith("/api/account/explore") ? (fail ? { ok: false, refusal: { message: "the account is restarting" } } : explore) : {}));
    p.set("A", account({ watch: [{ venue: "ex", symbol: "BTC/USDT", at: "2026-10-06T04:00:00.000Z" }] }));
    p.run('ROUTE.tab = "markets"; var EL = { innerHTML: "", dataset: {}, addEventListener() {}, querySelectorAll: () => [], contains: () => false }');
    p.run('renderMarkets({ el: EL, owner: true, lens: lensNow(), params: {} })');
    expect(p.run<string>("EL.innerHTML")).toContain('aria-busy="true"');
    expect(p.asked.map((a) => a.path)).toEqual(["/api/account/explore?tab=now"]);
    await settle();
    await settle();
    const html = p.run<string>("EL.innerHTML");
    const tabs = [...html.matchAll(/data-act="tab" data-tab="([a-z]*)"[^>]*aria-pressed="(true|false)">([^<]+)</g)].map((m) => `${m[3]}${m[2] === "true" ? "*" : ""}`);
    expect(tabs).toEqual(["Now*", "Crypto", "Predictions", "Watching", "Venues"]);
    expect(html).toContain("Closing soon");
    expect(html).toContain("Movers");
    expect(html).toContain("Most traded");
    // DOGE is only at OKX's public prices: its row connects; BTC trades at Exchange X
    expect(html).toContain('data-connector="live:exchange:okx" data-name="OKX"');
    expect(html).toMatch(/data-act="trade" data-i="\d+" data-fk="trade:coin:BTC"/);
    expect(html).toContain("<b>Binance</b>: “Service unavailable from a restricted location”");
    // a later read fails: what was read stays, said to be from earlier
    fail = true;
    p.run("for (const g of MKT.got.values()) g.at = 0");
    p.run('renderMarkets({ el: EL, owner: true, lens: lensNow(), params: {} })');
    await settle();
    await settle();
    const after = p.run<string>("EL.innerHTML");
    expect(after).toContain("Most traded");
    expect(after).toContain("Couldn't read the markets again just now: the account is restarting.");
  });

  it("says a failed first read in the account's words, with a way to try again — never a blank pane", async () => {
    const p = page(() => ({ ok: false, refusal: { message: "the account layer is not mounted" } }));
    p.set("A", account());
    p.run('ROUTE.tab = "markets"; var EL = { innerHTML: "", dataset: {}, addEventListener() {}, querySelectorAll: () => [], contains: () => false }');
    p.run('renderMarkets({ el: EL, owner: true, lens: lensNow(), params: { tab: "crypto" } })');
    await settle();
    await settle();
    const html = p.run<string>("EL.innerHTML");
    expect(html).toContain("Couldn't read the markets: the account layer is not mounted.");
    expect(html).toContain('data-act="retry"');
    expect(html).toContain('data-tab="venues"');
  });

  it("closes a venue to agents for free and reopens it signed; a key that can't trade says how to fix it", async () => {
    const p = page(() => ({ ok: true, revoked: ["ex"] }));
    p.set("A", account({ dial: { revoked: ["kalshi"] } }));
    p.run("var DRAFTS = []; own = async (d) => { DRAFTS.push(d); return { status: 200, body: {} }; }; load = async () => {}");
    const html = p.run<string>("MKT.good = null; mkVenuesHtml(true, lensNow())");
    expect(html).toContain('role="switch" class="mk-switch" aria-checked="true" data-act="agents" data-venue="ex"');
    expect(html).toContain('role="switch" class="mk-switch" aria-checked="false" data-act="agents" data-venue="kalshi"');
    expect(html).toContain("This key can&#39;t trade. Create New API Key (Ed25519)");
    expect(html).toContain('data-act="rekey" data-venue="kalshi"');
    // a browser that only looks may close (free) but not reopen (signed)
    p.run('Owner.role = "pending"');
    expect(p.run<string>("mkVenuesHtml(false, lensNow())")).toMatch(/aria-checked="false" data-act="agents" data-venue="kalshi"[^>]*disabled/);
    p.run('Owner.role = "owner"');
    await p.run("mkAgentsSwitch('ex', true)");
    expect(p.asked.filter((a) => a.method === "POST")).toEqual([{ path: "/api/revoke", method: "POST", body: { account: "ex" } }]);
    expect(p.run("said")).toBe("Exchange X is closed to agents: they keep reading it, and place or move nothing there. Reopening it is signed.");
    await p.run("mkAgentsSwitch('kalshi', false)");
    expect(JSON.stringify(p.run("DRAFTS"))).toBe(JSON.stringify([{ type: "setPolicy", change: "restore", value: "kalshi" }]));
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
    const cat = p.run<string>("catalog(true, 'wide')");
    expect(cat).toContain('<div class="pick-h">More</div>');
    expect(cat).toContain('data-kind="standin-pubex" data-extra=""><b>Stand-in Public Exchange</b><span>On this machine</span>');
  });

  it("shows in the drawer what the agents are doing in a market: their cards, open orders and the owner's intents about it", () => {
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
    expect(html).toContain("Claude Code: buy 0.01 BTC · limit 60,000");
    expect(html).toContain("You to every agent: “Tell me if BTC moves &lt;5%&gt;”");
    expect(p.run("[mkAssetKey(ITEM), mkAssetKey({ kind: 'perp', base: 'eth', at: [] }), mkAssetKey({ kind: 'event', at: [{ connected: false, symbol: 'x' }] })]")).toEqual(["crypto:BTC", "crypto:ETH", ""]);
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
});

describe("the Markets pane, against what the account now says", () => {
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

  it("hands a market only public prices list to an agent by that venue's name, not its id", () => {
    const p = page(() => ({}));
    p.set("A", account());
    p.set("ITEMS", { btc, doge });
    p.run("var HANDED = []; globalThis.openHandToAgent = (x) => HANDED.push(x)");
    p.run("mkHand(ITEMS.doge); mkHand(ITEMS.btc)");
    const handed = p.run<Array<Record<string, string>>>("HANDED");
    expect(handed[0]).toMatchObject({ venue: "okx", symbol: "DOGE/USDT", venueName: "OKX", side: "buy", key: "coin:DOGE" });
    expect(handed[1]).toMatchObject({ venue: "ex", symbol: "BTC/USDT", venueName: "Exchange X" });
  });

  it("draws any market's price history from the candles read — connected or public — and says quietly in the venue's words when it keeps none", () => {
    const p = page(() => new Promise(() => {}));
    p.set("A", account());
    p.set("ITEMS", { btc, doge, fed });
    // where the history is asked: the connected venue first, else the public listing; an event's first outcome
    expect(p.run("JSON.stringify([mkCandleLeg(ITEMS.btc), mkCandleLeg(ITEMS.doge), mkCandleLeg(ITEMS.fed)])")).toBe(JSON.stringify([{ venue: "ex", symbol: "BTC/USDT", venueName: "Exchange X" }, { venue: "okx-public", symbol: "DOGE/USDT", venueName: "OKX" }, { venue: "kalshi", symbol: "KXFED-DEC:YES", venueName: "Kalshi" }]));
    p.run('var ASKED = []; api = (path) => { ASKED.push(path); return new Promise(() => {}); }; MKT.open = { item: ITEMS.doge, interval: "5m", asset: undefined, compare: undefined, candles: undefined }; mkDrawerLoad(MKT.open)');
    expect(p.run<string[]>("ASKED")[0]).toBe("/api/account/candles?venue=okx-public&symbol=DOGE%2FUSDT&interval=5m");
    const bars = Array.from({ length: 12 }, (_, i) => ({ t: NOW - (12 - i) * 300_000, o: 0.12, h: 0.125, l: 0.118, c: 0.12 + i / 1000 }));
    const chart = (candles: unknown, asset?: unknown) => p.run<string>(`mkChartHtml({ interval: "5m", candles: ${JSON.stringify(candles)}, asset: ${asset === undefined ? "undefined" : JSON.stringify(asset)} }, ITEMS.doge, mkCandleLeg(ITEMS.doge), "crypto:DOGE")`);
    // asked and not back yet: a skeleton; back: the line, where it came from
    expect(chart(null)).toContain("skel");
    // as the account answers: { venue, venueName, symbol, interval, candles: [bars], public }
    const drawn = chart({ ok: true, venue: "okx-public", venueName: "OKX", symbol: "DOGE/USDT", interval: "5m", candles: bars, public: true });
    expect(drawn).toContain('class="spark mk-chart"');
    expect(drawn).toContain("At OKX · DOGE/USDT");
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
    expect(chart({ ok: false, error: "404 Not Found" }, assetBars)).toContain("At Exchange X · DOGE/USDT");
    expect(chart({ ok: false, error: "404 Not Found" })).toContain("skel");
  });

  it("connects again by the connection the account names for a venue, under its own name — a second OKX account is still OKX", async () => {
    const p = page(() => ({}));
    const second = venue("okx-trading", "OKX Trading", { connector: "live:exchange:okx", trade: { can: false, what: "spot", kinds: ["spot"] } });
    p.set("A", account({ venues: [...account().venues, second, venue("mystery", "Mystery", { connector: "live:gone" })] }));
    expect(p.run("[connectorOfVenue(A.venues[2]), connectorOfVenue(A.venues[3])]")).toEqual(["live:exchange:okx", ""]);
    // what to tick at the venue is OKX's, read from the connection rather than guessed from the id
    expect(p.run("keyHowFor(A.venues[2])")).toContain("Tick Read and Trade");
    expect(p.run<string>("mkVenuesHtml(true, lensNow())")).toContain('data-act="rekey" data-venue="okx-trading"');
    p.run("var OPENED = []; openConnect = (o, opts) => OPENED.push([o.kind, opts.exchange, opts.name, opts.label]); confirmSheet = async () => true; var DRAFTS = []; own = async (d) => { DRAFTS.push(d); return { status: 200, body: {} }; }");
    await p.run("mkRekey('okx-trading')");
    expect(p.run("JSON.stringify(DRAFTS)")).toBe(JSON.stringify([{ type: "disconnectVenue", venue: "okx-trading" }]));
    expect(p.run("OPENED")).toEqual([["exchange", "okx", "OKX Trading", "OKX Trading"]]);
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
    const drawer = p.run<string>('mkDrawerHtml({ item: ITEMS.ousg, interval: "1h", asset: undefined, compare: undefined, candles: undefined })');
    expect(drawer).toContain('<div class="box mk-iss-box"><div class="label">Issuer</div><b>Ondo Finance</b><p class="small">OUSG moves only between wallets Ondo has approved</p></div>');
    expect(drawer).toContain("<div class=\"label\">Can't trade it here</div><p>Wallet: OUSG moves only between wallets Ondo has approved.</p>");
    expect(drawer).not.toContain('data-act="trade"');
    // anything else has no issuer line
    p.set("ITEMS", { btc });
    expect(p.run("mkIssuer(ITEMS.btc)")).toBeNull();
  });

  it("keeps one Movers chip a thing: a coin and its perpetual are one", () => {
    const p = page(() => ({}));
    p.set("A", account());
    const perp = { ...btc, key: "perp:BTC", kind: "perp", name: "BTC perpetual", changePct24h: 1.2, changeFrom: { venue: "ex", venueName: "Exchange X" } };
    p.set("BODY", { ...explore, movers: [doge, btc, perp] });
    expect(p.run("mkOnePerBase(BODY.movers).map((x) => x.key)")).toEqual(["coin:DOGE", "coin:BTC"]);
    const now = p.run<string>("MKT.reg = []; mkNowHtml(BODY, lensNow())");
    expect(now.match(/class="mk-chip"/g)).toHaveLength(2);
  });

  it("lets the owner decline what an agent asked to connect, beside Connect", async () => {
    const p = page(() => ({}));
    p.set("A", account({ asks: [{ id: "ask-9", agent: "0xa", agentName: "Claude Code", kind: "venue", venue: "okx", text: "Connect OKX so I can buy DOGE", at: new Date(NOW).toISOString() }] }));
    // declineAsk is the Portfolio's (portfolio.js); without it the button is not drawn
    expect(p.run<string>("MKT.good = null; mkVenuesHtml(true, lensNow())")).not.toContain('data-act="decline"');
    p.run("var DECLINED = []; globalThis.declineAsk = (a) => DECLINED.push(a.id)");
    const html = p.run<string>("mkVenuesHtml(true, lensNow())");
    expect(html).toContain('data-act="decline" data-ask="ask-9"');
    p.run('mkPaneClick({ target: { closest: (s) => (s === "[data-act]" ? { dataset: { act: "decline", ask: "ask-9" }, disabled: false } : null) } })');
    expect(p.run("DECLINED")).toEqual(["ask-9"]);
  });
});
