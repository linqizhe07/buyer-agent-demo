/** The Trade pane's own logic (ui/trade.js) and the Hand-to-agent composer's (ui/intent.js), run as the page runs them — every page script in
 * account.html's order, in one global scope — over a stand-in for the browser: the six kinds (Crypto · Stocks · RWAs · Perps · Pre-IPO ·
 * Predictions) and which face a preset, a Markets row or a venue opens; which kinds the seg shows; an order's draft from the ticket's fields
 * (an event contract's prices typed in cents); where a market is listed, kept to the face's kind (yours ranked, yours that cannot with how
 * to fix it, public ones "Connect to trade"); each face's block; Advanced's one line; paying with a coin held (two steps); Under way's rows
 * (an agent's card → Review); what left the pane (tiles, the mode switch, Positions, Recent fills, Swap, Earn, Sell many). Then the same
 * drafts go through the real account's door on the stand-in account (test/standin): each is prepared, the owner's browser signs them, and
 * the account does what they say — a coin for a coin in two signatures, the second sized by what the first sale brought. Nothing leaves the
 * process. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createContext, runInContext, Script } from "node:vm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { malformed, signAgent, signDevice, simKey, type AgentAction, type OwnerAction } from "../../src/portfolio/account/sign.ts";
import { startStandin, type Standin } from "../standin/ui-standin.ts";

const PUBLIC = fileURLToPath(new URL("../../src/portfolio/public/", import.meta.url));
const html = readFileSync(join(PUBLIC, "account.html"), "utf8");
const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1] ?? "");
const source = (f: string) => readFileSync(join(PUBLIC, f), "utf8");

/** the page's scripts in a stand-in browser: elements take listeners and report nothing; the device key never answers, so nothing is drawn */
function page() {
  const element = (): Record<string, unknown> => ({ addEventListener() {}, removeAttribute() {}, setAttribute() {}, querySelectorAll: () => [], querySelector: () => null, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, dataset: {}, style: {}, hidden: false, value: "", textContent: "", innerHTML: "" });
  const sandbox: Record<string, unknown> = {
    document: { getElementById: element, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, body: element(), documentElement: { dataset: { theme: "cream" }, setAttribute() {} }, hidden: false, activeElement: null },
    location: { hash: "", origin: "http://127.0.0.1:4821" },
    history: { replaceState() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    MutationObserver: class {
      observe() {}
    },
    Event: class {
      constructor(readonly type: string) {}
    },
    addEventListener() {},
    dispatchEvent: () => true,
    scrollTo() {},
    indexedDB: { open: () => ({}) },
    fetch: () => new Promise(() => {}),
    /* a form's fields, as the drafts read them: { values } stands in for the form */
    FormData: class {
      constructor(private readonly f: { values?: Record<string, string> }) {}
      get(k: string) {
        return this.f.values?.[k] ?? null;
      }
      entries() {
        return Object.entries(this.f.values ?? {})[Symbol.iterator]();
      }
    },
    console,
    URLSearchParams,
    Intl,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval() {},
  };
  const ctx = createContext(sandbox);
  sandbox.window = runInContext("globalThis", ctx);
  for (const src of scripts) new Script(readFileSync(join(PUBLIC, src.replace(/^\//, "")), "utf8"), { filename: src }).runInContext(ctx);
  const run = <T = unknown>(code: string): T => runInContext(code, ctx) as T;
  /** a value out of the page, as plain data */
  const out = <T = any>(code: string): T => JSON.parse(run<string>(`JSON.stringify(${code})`)) as T;
  return { run, out, set: (name: string, value: unknown) => run(`${name} = ${JSON.stringify(value)}`) };
}

/* venues as /api/account gives them, cut to what the pane reads */
const venue = (id: string, name: string, more: Record<string, unknown> = {}) => ({ id, name, live: true, watchOnly: "live", usd: 100, holdings: [], ...more });
const EX = venue("ex", "Exchange", { trade: { can: true, what: "spot and perpetuals", kinds: ["spot", "perp"], positions: true, amend: true, leverage: true }, liveCan: { withdraw: true, ledgers: ["spot", "futures"], transfer: true, swap: true, receive: false, send: false } });
const PRED = venue("predict", "Predictions", { trade: { can: true, what: "event contracts", kinds: ["event"], positions: true } });
const WALLET = venue("wallet", "Wallet", { trade: { can: true, what: "tokens", kinds: ["token"] }, address: "0x1111111111111111111111111111111111111111", proven: "MetaMask" });
const READONLY = venue("okx", "OKX", { trade: { can: false, what: "spot", kinds: ["spot"] }, noTradeBecause: "this API key has no Trade permission" });
const HL = venue("hl", "Hyperliquid", { trade: { can: true, what: "perpetuals", kinds: ["perp"] } });
const pageOf = (venues: unknown[], writes = true) => ({ now: "2026-10-06T12:00:00.000Z", venues, keys: [], spend: [], cards: [], orders: [], payments: [], intents: [], asks: [], connectLive: { writes: { on: writes, capUsd: 250 }, options: [] } });
/* rows as /api/account/explore gives them, cut to what the pane reads */
const ROW = (kind: string, base: string, more: Record<string, unknown> = {}) => ({ key: `${kind}:${base}`, kind, name: base, base, price: 10, tabs: [], at: [{ venue: "ex", venueName: "Exchange", symbol: `${base}/USDT`, connected: true, canTrade: true, public: false, price: 10 }], ...more });
const ANTH = { key: "preipo:anthropic", kind: "perp", name: "Anthropic", base: "ANTHROPIC", category: "Pre-IPO", price: 2080, implied: { perPoint: 1e9, unit: "1 contract = 1/1,000,000,000 of the implied company valuation", usd: 2.08e12 }, group: { id: "preipo:anthropic", title: "Anthropic" }, issuer: "Anthropic", eligibility: "Anthropic, 29 June 2026: transfers of its shares it has not approved are void", tabs: ["all", "preipo"], at: [{ venue: "okx-preipo", venueName: "OKX", symbol: "ANTHROPIC/USDT:USDT", connected: false, canTrade: false, public: true, price: 214.5, implied: { perPoint: 1e10, unit: "OKX: 1/10,000,000,000 since its 30 June 2026 rebase", usd: 2.145e12 }, connectTo: "okx", connector: "live:exchange:okx" }, { venue: "ex", venueName: "Exchange", symbol: "ANTHROPIC/USDT:USDT", connected: true, canTrade: true, public: false, price: 2080, implied: { perPoint: 1e9, unit: "1 contract = 1/1,000,000,000 of the implied company valuation", usd: 2.08e12 } }] };

describe("the six kinds, as the page runs them", () => {
  const p = page();

  it("names the six faces in Markets' order, each with its icon, and tells which face a preset, a Markets row, a market or a venue opens", () => {
    expect(p.out("TK_KINDS.map((k) => k.id)")).toEqual(["crypto", "stocks", "rwas", "perps", "preipo", "predictions"]);
    expect(p.out("TK_KINDS.map((k) => k.icon)")).toEqual(["trade", "stock", "rwa", "perps", "preipo", "prediction"]);
    // a Markets row's kind, a market's kind, the old tile and variant names, the six words themselves
    expect(p.out('[{ kind: "coin" }, { kind: "stock" }, { kind: "rwa" }, { kind: "perp" }, { kind: "event" }, { kind: "token" }, { kind: "spot" }, { kind: "future" }].map(tkKindOf)')).toEqual(["crypto", "stocks", "rwas", "perps", "predictions", "crypto", "crypto", "perps"]);
    expect(p.out('[{ variant: "trade" }, { variant: "perps" }, { variant: "predictions" }, { tile: "swap" }, { kind: "stocks" }, { kind: "preipo" }, {}].map(tkKindOf)')).toEqual(["crypto", "perps", "predictions", "crypto", "stocks", "preipo", "crypto"]);
    // a perpetual on a company's implied valuation is Pre-IPO, whatever it is called
    expect(p.out(`[tkKindOf({ kind: "perp", category: "Pre-IPO" }), tkKindOf({ item: ${JSON.stringify(ANTH)} }), tkKindOf({ kind: "perps", implied: { usd: 1 } }), tkKindOf({ item: { kind: "perp", group: { id: "preipo:openai" } } })]`)).toEqual(["preipo", "preipo", "preipo", "preipo"]);
    // a venue named without a kind: what that venue trades; one that trades several kinds opens Crypto
    p.set("A", pageOf([EX, PRED, HL]));
    expect(p.out('[tkKindOf({ venue: "predict" }), tkKindOf({ venue: "hl" }), tkKindOf({ venue: "ex" })]')).toEqual(["predictions", "perps", "crypto"]);
    // the variant words the page before this one used map to kinds (no alias function remains)
    expect(p.out('[tkKindOf({ venue: "predict", kind: "event" }), tkKindOf({ variant: "swap", venue: "predict" }), tkKindOf({ variant: "perps" }), tkKindOf({ tile: "predictions" }), tkKindOf({})]')).toEqual(["predictions", "crypto", "perps", "predictions", "crypto"]);
    expect(p.out("typeof tkVariantOf")).toBe("undefined");
  });

  it("shows a kind when a connected venue trades it or a read of it has rows — and hides one with nothing; a venue's lens hides public-only kinds", () => {
    p.set("A", pageOf([EX, PRED, WALLET]));
    expect(p.out("tkKindsFor(connected(), {}, lensNow())")).toEqual(["crypto", "perps", "predictions"]);
    const got = { rwas: { items: [ROW("rwa", "NVDA", { at: [{ venue: "wallet", venueName: "Wallet", symbol: "NVDA/USDG@Robinhood Chain", connected: true, canTrade: true, public: false }] })] }, stocks: { items: [ROW("stock", "AAPL", { at: [{ venue: "alpaca-public", venueName: "Alpaca", symbol: "AAPL", connected: false, canTrade: false, public: true }] })] }, preipo: { items: [ANTH] } };
    expect(p.out(`tkKindsFor(connected(), ${JSON.stringify(got)}, lensNow())`)).toEqual(["crypto", "stocks", "rwas", "perps", "preipo", "predictions"]);
    // under a venue's lens: that venue's kinds and the rows it lists; Stocks (public only) and Pre-IPO (the exchange's row) part ways
    expect(p.out(`tkKindsFor([${JSON.stringify(EX)}], ${JSON.stringify(got)}, { kind: "venue", id: "ex", name: "Exchange" })`)).toEqual(["crypto", "perps", "preipo"]);
    // a read-only server still shows the kinds: prices show, the sign button says why nothing is placed
    p.set("A", pageOf([EX, PRED], false));
    expect(p.out("tkKindsFor(connected(), {}, lensNow())")).toEqual(["crypto", "perps", "predictions"]);
    // the pane is one seg + a picker + Under way: no tiles, no mode switch, no Positions, no Recent fills, no Swap/Earn/Sell many panels
    for (const gone of ["TK_TILES", "tkTilesFor", "tkTile", "tkRefusal", "tkSetMode", "TK_VARIANTS", "tkDrawPositions", "tkDrawFills", "tkSwap", "tkSwapHow2", "tkStableSwap", "tkSellMany", "tkSellDraft", "tkLegName", "tkEarn", "tkEarnList", "tkEarnDraft", "tkRate", "tkInVenue", "renderOpen"]) expect(p.run(`typeof ${gone}`), gone).toBe("undefined");
    expect(p.out("Object.keys(TK).sort()")).not.toEqual(expect.arrayContaining(["mode", "pos", "tileDone", "legs"]));
    const src = source("ui/trade.js");
    for (const words of ["Do it myself", "account.tradeMode", "Recent fills", "Your words to agents", "Earning now", "data-tp-pos", "data-tp-fills", "data-tp-intents", "Up to ${money(cap)}"]) expect(src, words).not.toContain(words);
    // the seg is drawn by hand (icons on its buttons) and never collides with core seg()'s click delegation
    expect(src).toContain('data-kind="${esc(id)}" aria-pressed=');
    expect(src).not.toMatch(/class="seg tk-seg"[^>]*data-seg/);
    // `later` lives inside the functions that debounce, never at the top level (ui-fixes forbids it)
    expect(src).not.toMatch(/^(const|function) later\b/m);
  });

  it("drafts an order from the ticket: in dollars or in the market's units, an event contract's limit typed in cents, only the flags the type takes", () => {
    expect(p.out('tkOrderDraft({ amount: " 50 ", unit: "usd", orderType: "market" }, { venue: "ex", symbol: "BTC/USDT", side: "buy", event: false })')).toEqual({ type: "liveOrder", venue: "ex", symbol: "BTC/USDT", side: "buy", orderType: "market", usd: "50", limitPrice: "", stopPrice: "", tif: "", postOnly: "", reduceOnly: "" });
    expect(p.out('tkOrderDraft({ amount: "26", unit: "qty", orderType: "limit", limitPrice: "38", postOnly: "on", tif: "gtc" }, { venue: "predict", symbol: "SI-FEDCUT-DEC:NO", side: "buy", event: true })')).toMatchObject({ qty: "26", limitPrice: "0.38", postOnly: "true", tif: "gtc" });
    // a stop has no limit and is never post-only; reduce-only rides along where ticked
    expect(p.out('tkOrderDraft({ amount: "0.01", unit: "qty", orderType: "stop", limitPrice: "9", stopPrice: "60000", postOnly: "on", reduceOnly: "on" }, { venue: "ex", symbol: "BTC/USDT:USDT", side: "sell", event: false })')).toMatchObject({ limitPrice: "", stopPrice: "60000", postOnly: "", reduceOnly: "true" });
    expect(p.out('[tkPriceIn("62", true), tkPriceIn("62", false), tkPriceIn("", true), tkCents(0.625), tkCents(undefined)]')).toEqual(["0.62", "62", "", "62.5¢", "—"]);
  });

  it("lists where a market is, kept to the face's kind: yours that trade it (best first), yours that cannot with what to change, public venues to connect — not one already connected, none on a read-only server", () => {
    p.set("A", pageOf([EX, WALLET, READONLY]));
    const item = { kind: "coin", base: "BTC", at: [{ venue: "okx", venueName: "OKX", symbol: "BTC/USDT", connected: true, canTrade: false }, { venue: "kraken-public", venueName: "Kraken", symbol: "BTC/USD", connected: false, canTrade: false, public: true, price: 62000, connectTo: "kraken", connector: "live:exchange:kraken" }, { venue: "wallet", venueName: "Wallet", symbol: "cbBTC/USDC@Base", connected: true, canTrade: true, price: 62100 }] };
    const ranked = [{ venue: "ex", venueName: "Exchange", symbol: "BTC/USDT", kind: "spot", price: 61990, best: true, open: true, canTrade: true, ready: true }, { venue: "wallet", venueName: "Wallet", symbol: "cbBTC/USDC@Base", kind: "token", price: 62100, worse: 0.18, open: true, canTrade: true, ready: true }];
    const rows = p.out<Array<Record<string, unknown>>>(`tkWhereRows(${JSON.stringify(item)}, ${JSON.stringify(ranked)})`);
    expect(rows.map((r) => [r.state, r.venue])).toEqual([["able", "ex"], ["able", "wallet"], ["off", "okx"], ["public", "kraken-public"]]);
    expect(rows[0]).toMatchObject({ best: true, price: 61990 });
    expect(rows[2]).toMatchObject({ why: "this API key has no Trade permission", how: expect.stringMatching(/Trade.*Then connect it again\./) });
    // a perpetual standing in for the coin, or an RWA token of the same name, is not one of a coin's places (compare rows carry their kind)
    const mixed = [...ranked, { venue: "ex", venueName: "Exchange", symbol: "BTC/USDT:USDT", kind: "perp", price: 61995, open: true, canTrade: true, ready: true }, { venue: "wallet", venueName: "Wallet", symbol: "BTCx/USDC@Base", kind: "token", category: "RWA", price: 62050, open: true, canTrade: true, ready: true }];
    expect(p.out<Array<{ symbol?: string }>>(`tkWhereRows(${JSON.stringify(item)}, ${JSON.stringify(mixed)}, "crypto")`).map((r) => r.symbol)).toEqual(["BTC/USDT", "cbBTC/USDC@Base", undefined, "BTC/USD"]);
    // a stock's places are brokers: an RWA token of the same name is a line to RWAs, not a place to buy shares
    const nvda = { kind: "stock", base: "NVDA", at: [{ venue: "alpaca", venueName: "Alpaca", symbol: "NVDA", connected: true, canTrade: true, price: 180 }] };
    const stockRanked = [{ venue: "alpaca", venueName: "Alpaca", symbol: "NVDA", kind: "stock", price: 180, best: true, open: true, canTrade: true, ready: true }, { venue: "wallet", venueName: "Wallet", symbol: "NVDA/USDG@Robinhood Chain", kind: "token", category: "RWA", price: 181, open: true, canTrade: true, ready: true }];
    p.set("A", pageOf([EX, WALLET, venue("alpaca", "Alpaca", { trade: { can: true, what: "US stocks", kinds: ["stock"] } })]));
    expect(p.out<Array<{ venue: string }>>(`tkWhereRows(${JSON.stringify(nvda)}, ${JSON.stringify(stockRanked)}, "stocks")`).map((r) => r.venue)).toEqual(["alpaca"]);
    expect(p.out("[tkOfFace({ kind: 'token', category: 'RWA' }, 'rwas'), tkOfFace({ kind: 'token' }, 'rwas'), tkOfFace({ kind: 'token', category: 'RWA' }, 'crypto'), tkOfFace({ kind: 'perp' }, 'preipo'), tkOfFace({}, 'stocks')]")).toEqual([true, true, false, true, true]);
    // a pre-IPO venue carries its implied valuation and its unit (they differ by venue); the public one is a price while a connected venue
    // trades the row, and a connection to make when none does
    p.set("A", pageOf([EX]));
    const pre = p.out<Array<Record<string, any>>>(`tkWhereRows(${JSON.stringify(ANTH)}, null, "preipo")`);
    expect(pre.map((r) => [r.state, r.venue])).toEqual([["able", "ex"], ["public", "okx-preipo"]]);
    expect(pre[0]!.implied).toMatchObject({ usd: 2.08e12 });
    expect(pre[1]!.implied.unit).toMatch(/OKX: 1\/10,000,000,000/);
    expect(pre[1]!.connector).toBe("");
    p.set("A", pageOf([PRED]));
    expect(p.out<Array<Record<string, any>>>(`tkWhereRows(${JSON.stringify({ ...ANTH, at: [ANTH.at[0]] })}, null, "preipo")`)).toEqual([expect.objectContaining({ state: "public", venue: "okx-preipo", connector: "live:exchange:okx" })]);
    // OKX's own terms exclude where the user is: said beside the connection, which stays (shown, never enforced — its sign-up decides)
    p.run(`VENUES.set("live:exchange:okx", { connector: "live:exchange:okx", name: "OKX", verdict: "terms-exclude", said: "its terms exclude where you are (https://www.okx.com/help/terms-of-service, read 2026-10-08)" })`);
    const told = p.out<Array<Record<string, any>>>(`tkWhereRows(${JSON.stringify({ ...ANTH, at: [ANTH.at[0]] })}, null, "preipo")`);
    expect(told).toEqual([expect.objectContaining({ state: "public", venue: "okx-preipo", connector: "live:exchange:okx", terms: expect.objectContaining({ word: "Its terms exclude where you are" }) })]);
    // where OKX does not serve this network at all, it is not listed: the list is what serves the user, and it counts what it left out
    p.run(`VENUES.set("live:exchange:okx", { connector: "live:exchange:okx", name: "OKX", verdict: "not-served", said: "OKX does not serve this location" })`);
    const shut = p.run<{ rows: unknown[]; away: number }>(`(() => { const r = tkWhereRows(${JSON.stringify({ ...ANTH, at: [ANTH.at[0]] })}, null, "preipo"); return { rows: [...r], away: r.away }; })()`);
    expect(shut).toEqual({ rows: [], away: 1 });
    // close-only (a venue that takes the user only to close) stays, in a word, with no connection offered
    p.run(`VENUES.set("live:exchange:okx", { connector: "live:exchange:okx", name: "OKX", verdict: "close-only", said: "OKX lets this location close positions, not open new ones" })`);
    const closing = p.out<Array<Record<string, any>>>(`tkWhereRows(${JSON.stringify({ ...ANTH, at: [ANTH.at[0]] })}, null, "preipo")`);
    expect(closing).toEqual([expect.objectContaining({ state: "public", venue: "okx-preipo", connector: "", refuses: expect.objectContaining({ word: "Close only here" }) })]);
    // a connected venue that does not serve this network now is not listed either
    p.set("A", pageOf([{ ...EX, notServed: { said: "Exchange does not serve this location" } }, WALLET, READONLY]));
    const away = p.run<{ venues: string[]; away: number }>(`(() => { const r = tkWhereRows(${JSON.stringify(item)}, ${JSON.stringify(ranked)}); return { venues: r.map((x) => x.venue), away: r.away }; })()`);
    expect(away).toEqual({ venues: ["wallet", "okx", "kraken-public"], away: 1 });
    // a connected close-only venue stays listed for what it takes (a sell), marked so the ticket says its state for a buy
    p.set("A", pageOf([{ ...EX, closeOnly: { said: "Exchange lets this location close positions, not open new ones" } }, WALLET, READONLY]));
    expect(p.out<Array<{ venue: string; closeOnly?: boolean }>>(`tkWhereRows(${JSON.stringify(item)}, ${JSON.stringify(ranked)})`).find((r) => r.venue === "ex")).toMatchObject({ state: "able", closeOnly: true });
    p.run(`VENUES.clear()`);
    // the public listing of a venue the owner has since connected is not offered again
    p.set("A", pageOf([EX, venue("kraken", "Kraken", { trade: { can: true, kinds: ["spot"] } })]));
    expect(p.out<Array<{ state: string }>>(`tkWhereRows(${JSON.stringify(item)}, [])`).map((r) => r.state)).not.toContain("public");
    // a read-only server: the public line is a price, there is nothing to connect for
    p.set("A", pageOf([EX], false));
    expect(p.out<Array<{ state: string; connector?: string }>>(`tkWhereRows(${JSON.stringify(item)}, [])`).find((r) => r.state === "public")?.connector).toBe("");
    // Connect to trade opens the connection the row names, through connect.js's own door (connectVia); one this server does not offer says so
    p.set("A", { ...pageOf([EX]), connectLive: { writes: { on: true, capUsd: 250 }, options: [{ kind: "exchange", connector: "live:exchange", needs: "key-file", venues: ["kraken"] }, { kind: "kalshi", connector: "live:kalshi", needs: "key-file" }] } });
    p.run('Object.defineProperty(Owner, "role", { get: () => "owner", configurable: true }); var CONNECTED = []; openConnect = (o, opts) => CONNECTED.push([o.kind, opts.exchange, opts.name]); var TOASTS = []; toast = (t) => TOASTS.push(t)');
    p.run('tkConnectTo({ connector: "live:exchange:kraken", venueName: "Kraken" }); tkConnectTo({ connector: "live:kalshi", venueName: "Kalshi" }); tkConnectTo({ venueName: "Nowhere" })');
    expect(p.out("CONNECTED")).toEqual([["exchange", "kraken", "Kraken"], ["kalshi", "", "Kalshi"]]);
    expect(p.out("TOASTS")).toEqual(["Nowhere can't be connected from this server."]);
  });

  it("says each face's own block from the market, the place and the row: hours and whole shares, the issuer once, a perpetual's facts and margin, a pre-IPO valuation and notice, an event's payout", () => {
    p.set("A", pageOf([EX, WALLET]));
    p.run("TK.cross = null");
    const kb = (kind: string, m: unknown, at: unknown, item: unknown, c: unknown = {}) => p.run<string>(`tkKindBlock(${JSON.stringify(kind)}, ${JSON.stringify(m)}, ${JSON.stringify(at)}, ${JSON.stringify(item)}, ${JSON.stringify(c)})`);
    // Stocks: the session from the venue's own clock (or the market calendar), never from `open` — at night a real broker's stock is still
    // open (Alpaca holds an order for the open) — then the venue's note verbatim; whole shares where the step is one
    const held = "the US stock market is closed: Alpaca holds an order and sends it when the market opens (2026-10-07 09:30 New York time). Until then no market order is placed here: it would fill at the opening price, which can be well away from this one. A limit, stop or stop-limit order waits for the open with its limit";
    const night = { symbol: "AAPL", kind: "stock", base: "AAPL", quote: "USD", open: true, session: { open: false, opensAt: "2026-10-07T13:30:00.000Z", closesAt: "2026-10-07T20:00:00.000Z" }, note: held, qtyStep: 1, types: ["limit", "stop", "stop_limit"] };
    const aapl = kb("stocks", night, null, null);
    expect(aapl).toContain(`<div><b>Closed</b> · opens Wed 7 Oct, 09:30 New York · ${held}</div>`);
    expect(aapl).not.toContain("Open now");
    expect(aapl).toContain("Whole shares only here.");
    // in session: open now, and when it closes, in New York time (an early close as the venue's clock says it)
    const day = kb("stocks", { ...night, session: { open: true, opensAt: "2026-10-07T13:30:00.000Z", closesAt: "2026-10-06T20:00:00.000Z" }, note: undefined, qtyStep: 0.001, types: ["market", "limit"] }, null, null);
    expect(day).toContain("<div><b>Open now</b> · closes 16:00 New York</div>");
    expect(day).not.toContain("Whole shares only here.");
    expect(kb("stocks", { ...night, session: { open: true, closesAt: "2026-11-27T18:00:00.000Z" }, note: undefined }, null, null)).toContain("<b>Open now</b> · closes 13:00 New York");
    // no session said (Alpaca's clock did not answer): no Open or Closed word at all, only the venue's own words
    const words = "Alpaca's market clock did not answer, so no market order is placed here: outside market hours Alpaca holds an order until the market opens, and a market order would fill at the opening price";
    const unknown = kb("stocks", { ...night, session: undefined, note: words }, null, null);
    expect(unknown).toContain(`<div>${words.replace(/'/g, "&#39;")}</div>`);
    expect(unknown).not.toMatch(/Open now|<b>Closed/);
    expect(kb("stocks", { ...night, session: undefined, note: undefined, qtyStep: 1 }, null, null)).toBe("<div>Whole shares only here.</div>");
    // a stock the venue takes no order in now (halted) says so with the venue's words, whatever the session
    const halted = kb("stocks", { ...night, open: false, session: { open: true, closesAt: "2026-10-06T20:00:00.000Z" }, note: "AAPL is halted at Robinhood: news pending" }, null, null);
    expect(halted).toContain("<div><b>Closed now.</b> AAPL is halted at Robinhood: news pending</div>");
    expect(halted).not.toContain("Open now");
    expect(halted.match(/halted at Robinhood/g)).toHaveLength(1);
    // RWAs: the issuer's words once, the pay token and the chain, the route's own line
    const ousg = kb("rwas", { symbol: "OUSG/USDC@Ethereum", kind: "token", base: "OUSG", quote: "USDC", open: true, note: "LI.FI: 0.25% fee, 0.5% slippage, gas paid by the wallet", types: ["market"] }, null, { kind: "rwa", base: "OUSG", issuer: "Ondo Finance", eligibility: "OUSG moves only between wallets Ondo has approved", at: [] });
    expect(ousg).toContain("Issued by <b>Ondo Finance</b>.");
    expect(ousg).toContain("OUSG moves only between wallets Ondo has approved");
    expect(ousg).toContain("Paid in <b>USDC</b> on Ethereum.");
    expect(ousg).toContain("LI.FI: 0.25% fee, 0.5% slippage, gas paid by the wallet");
    expect((ousg.match(/Ondo Finance/g) ?? []).length).toBe(1);
    // with chains to choose from, a Chain field
    expect(kb("rwas", { symbol: "OUSG/USDC@Ethereum", kind: "token", base: "OUSG", quote: "USDC", open: true, types: ["market"] }, null, null, { chains: [{ symbol: "OUSG/USDC@Ethereum", chain: "Ethereum", quote: "USDC" }, { symbol: "OUSG/USDG@Robinhood Chain", chain: "Robinhood Chain", quote: "USDG" }] })).toContain('<select name="chain">');
    // Perps: mark, funding and its next payment, the leverage the venue takes, the margin the amount needs, what is held
    const perp = { symbol: "ETH/USDT:USDT", kind: "perp", base: "ETH", quote: "USDT", price: 2500, open: true, fundingRate: 0.0001, nextFundingAt: "2026-10-06T16:00:00.000Z", maxLeverage: 20, types: ["market", "limit"] };
    const facts = kb("perps", perp, { venue: "ex", venueName: "Exchange" }, null, { amount: "100", unit: "usd", leverage: "5", held: { side: "long", qty: 0.05, leverage: 5, liquidationPrice: 2100, entryPrice: 2480 }, positions: [] });
    expect(facts).toContain("Mark 2,500 USDT");
    expect(facts).toContain("Funding 0.0100% a period, next paid 12:00 New York · up to 20x here.");
    expect(facts).toContain("Margin ≈ $20.00 for $100.00 at 5x.");
    expect(facts).toContain("You hold long 0.05 at 5x · liquidation at 2,100 · entry 2,480.");
    expect(kb("perps", perp, { venue: "ex", venueName: "Exchange" }, null, { positions: [] })).toContain("Nothing held here yet");
    // Pre-IPO: from the row alone when no market is picked — the valuation, the unit, the conversion, the company's notice, what it is not
    const pre = kb("preipo", null, null, ANTH, {});
    // Markets' own figure for a valuation (mkValuation), the same one its rows show
    expect(pre).toContain("Implied valuation ≈ $2.08T");
    expect(pre).toContain("a contract 2,080");
    expect(pre).toContain("1 contract = 1/1,000,000,000 of the implied company valuation");
    expect(pre).toContain("Becomes a stock perpetual at the IPO; the venue rebases when the share count is public.");
    expect(pre).toContain("Anthropic, 29 June 2026: transfers of its shares it has not approved are void");
    // the company's own words, labelled as such — the venue writes the contract, so nothing here says the company issues it
    expect(pre).toContain("<b>What the company says</b>");
    expect(pre).not.toContain("Issued by");
    expect(pre).toContain("This is a contract on a valuation, not a share.");
    // …and with the venue's market, the venue's own implied figure and the perpetual's facts too
    const preAt = kb("preipo", { symbol: "ANTHROPIC/USDT:USDT", kind: "perp", base: "ANTHROPIC", quote: "USDT", price: 2080, open: true, maxLeverage: 20, types: ["market"] }, ANTH.at[1], ANTH, { positions: [] });
    expect(preAt).toContain("a contract 2,080 USDT");
    expect(preAt).toContain("Up to 20x here.");
    // Predictions: the payout line from the amount, the close counted down, sells only what you hold
    const fed = { symbol: "SI-FEDCUT-DEC:YES", kind: "event", base: "SI-FEDCUT-DEC", quote: "USD", price: 0.62, ask: 0.62, bid: 0.6, outcome: "Yes", open: true, closeTime: "2026-12-10T19:00:00.000Z", sellsReduce: true, types: ["market", "limit"] };
    const pay = kb("predictions", fed, null, null, { side: "buy", outcome: "Yes", amount: "10", unit: "usd", held: { qty: 50 }, positions: [] });
    expect(pay).toContain("<b>16 contracts pay $16.00</b> if Yes · cost ≈ $9.92 · the market gives it 62%");
    expect(pay).toContain('data-tk-close="2026-12-10T19:00:00.000Z"');
    expect(pay).toContain("Sells only what you hold · 50 held.");
    expect(kb("predictions", fed, null, null, { side: "buy", outcome: "Yes", positions: [] })).toContain("<b>Yes</b> at 62¢ — the market gives it 62%. Each contract pays $1.00 if it happens, nothing if not.");
    // Crypto at a wallet: the venue's own line (route, slippage, gas); paid with a coin held: the two steps said
    expect(kb("crypto", { symbol: "WETH/USDC@Base", kind: "token", base: "WETH", quote: "USDC", open: true, bid: 2499, ask: 2501, note: "Route by LI.FI · 0.3% slippage · gas ≈ $0.02", types: ["market"] }, null, null, { pay: { asset: "cbBTC" } })).toMatch(/Route by LI\.FI[\s\S]*Paid with <b>cbBTC<\/b>: sold first, then WETH bought/);
  });

  it("speaks the venue's rule on Advanced's one line — what is set, else what the market takes — never invented", () => {
    const adv = (m: unknown, f: unknown) => p.run<string>(`tkAdvSummary(${JSON.stringify(m)}, ${JSON.stringify(f)})`);
    // Kalshi: a market order fills now or is cancelled
    expect(adv({ tifs: ["ioc", "fok", "gtc"], tifsByType: { market: ["ioc", "fok"] } }, { orderType: "market" })).toBe("A market order here fills now or is cancelled (ioc/fok)");
    // Polymarket: never rests until cancelled
    expect(adv({ tifs: ["fok", "day"] }, { orderType: "limit" })).toBe("Never rests until cancelled here: all now or nothing or today only");
    // mm Hyperliquid: nothing to set from here
    expect(adv({}, { orderType: "limit" })).toBe("The venue's defaults: no time in force, post-only or reduce-only is set from here");
    // an exchange: the default and what it takes; once something is set, that
    expect(adv({ tifs: ["gtc", "day"], postOnly: true, reduceOnly: true }, { orderType: "limit" })).toBe("The venue's default · until canceled · today only · post-only possible · reduce-only possible");
    expect(adv({ tifs: ["gtc", "day"], postOnly: true }, { orderType: "limit", tif: "gtc", postOnly: "on" })).toBe("Until canceled · post-only");
    // the disclosure is folded and holds exactly the time in force and the flags; the leverage of a perpetual stays in view above it
    const src = source("ui/trade.js");
    const details = src.indexOf('<details class="tk-adv" data-adv hidden>');
    expect(details).toBeGreaterThan(0);
    const inside = src.slice(details, src.indexOf("</details>", details));
    for (const f of ["data-more", "data-tif", 'name="postOnly"', 'name="reduceOnly"', "data-adv-sum"]) expect(inside, f).toContain(f);
    expect(inside).not.toContain("data-lev");
    expect(src.indexOf('<div class="tk-lev" data-lev hidden>')).toBeLessThan(details);
    expect(src).toContain('q("[data-adv]").hidden = more.hidden;');
    // the quote and what is signed are written through paint: a refresh never takes the focus from What you sign
    expect(src).toContain("const show = (html) => paint(box, html);");
    expect(src).toContain("const signed = (html) => paint(sign, html);");
  });

  it("plans paying with a coin held: a dollar for a coin or back in one order, a coin for a coin in two through the dollar both share; one dollar for another is a Move", () => {
    const markets = [{ symbol: "WETH/USDC@Base", kind: "token", base: "WETH", quote: "USDC", open: true }, { symbol: "cbBTC/USDC@Base", kind: "token", base: "cbBTC", quote: "USDC", open: true }, { symbol: "USDY/USDC@Ethereum", kind: "token", base: "USDY", quote: "USDC", open: true }, { symbol: "BTC/USDT", kind: "spot", base: "BTC", quote: "USDT", open: true }, { symbol: "SOL/USDT", kind: "spot", base: "SOL", quote: "USDT", open: true }];
    const plan = (o: Record<string, unknown>) => p.out<any>(`tkSwapPlan(${JSON.stringify({ markets, ...o })})`);
    expect(plan({ venue: "ex", from: "USDC", to: "USDT", amount: "50" })).toMatchObject({ mode: "", why: expect.stringMatching(/Move › Swap stablecoins/) });
    expect(plan({ venue: "wallet", from: "USDC", to: "WETH", amount: "25", chain: "Base" }).legs).toEqual([{ type: "liveOrder", venue: "wallet", symbol: "WETH/USDC@Base", side: "buy", orderType: "market", usd: "25", limitPrice: "", stopPrice: "", tif: "", postOnly: "", reduceOnly: "" }]);
    expect(plan({ venue: "wallet", from: "WETH", to: "USDC", amount: "0.1", chain: "Base" }).legs[0]).toMatchObject({ symbol: "WETH/USDC@Base", side: "sell", qty: "0.1" });
    // a coin held on one chain is sold there, and only a coin listed against the same dollar on that chain can be bought with it
    const two = plan({ venue: "wallet", from: "WETH", to: "cbBTC", amount: "0.1", chain: "Base" });
    expect(two).toMatchObject({ mode: "two", from: "WETH", to: "CBBTC", via: "USDC", legs: [{ symbol: "WETH/USDC@Base", side: "sell", qty: "0.1" }, { symbol: "cbBTC/USDC@Base", side: "buy", usd: "" }] });
    expect(p.run(`tkSwapHow(${JSON.stringify(two)})`)).toBe("Two orders: sells WETH for USDC (WETH/USDC@Base), then buys CBBTC with what that brings (cbBTC/USDC@Base) — two signatures.");
    expect(plan({ venue: "wallet", from: "WETH", to: "USDY", amount: "0.1", chain: "Base" })).toMatchObject({ mode: "", why: expect.stringMatching(/USDY isn't listed against USDC/) });
    expect(plan({ venue: "ex", from: "BTC", to: "SOL", amount: "0.001" })).toMatchObject({ mode: "two", via: "USDT" });
    expect(plan({ venue: "ex", from: "USDC", to: "BTC", amount: "10" })).toMatchObject({ mode: "", why: "BTC isn't listed against USDC here (it trades against USDT)." });
    expect(plan({ venue: "ex", from: "BTC", to: "BTC" }).why).toBe("Pick two different assets.");
    // what the sale brought, less its fee, down to the cent: what the second leg spends
    expect(p.out("tkProceeds({ filledQty: 0.001, avgPrice: 62523.2, feeUsd: 0.04 })")).toBe(62.48);
    expect(p.out("tkProceeds({ filledQty: 0, price: 10 })")).toBe(0);
    // the ticket's own words for the two steps and its buttons
    const src = source("ui/trade.js");
    for (const words of ["Two steps, two signatures.", "Sign the sale (1 of 2)", "Sign the buy (2 of 2)", "tkFilled(o, live)", "tkProceeds(o)"]) expect(src, words).toContain(words);
  });

  it("Under way: an agent's card is a status row whose one action is Review (answered under Portfolio); an order has Change, Cancel, Send from wallet…", () => {
    p.set("A", pageOf([EX, WALLET]));
    const card = { id: "card-7", kind: "order", reason: "Buy about $120 of ETH", agentName: "Claude Code", expiresAt: "2026-10-06T12:29:00.000Z", shown: [{ name: "venue", value: "ex" }] };
    const acts = p.run<string>(`tkOpenActs({ c: ${JSON.stringify(card)} })`);
    expect(acts).toContain('data-review="card-7"');
    expect(acts).not.toMatch(/Approve|Reject|data-card/);
    expect(p.run<string>(`tkOpenStatus({ c: ${JSON.stringify(card)} })`)).toContain("Waiting for you");
    expect(p.run<string>(`tkOpenWhat({ c: ${JSON.stringify(card)} })`)).toContain("Buy about $120 of ETH");
    const order = { id: "ord-9", venue: "ex", venueName: "Exchange", side: "buy", qty: 0.5, base: "SOL", type: "limit", limitPrice: 140, status: "open", clientId: "c9" };
    const oacts = p.run<string>(`tkOpenActs({ o: ${JSON.stringify(order)} })`);
    expect(oacts).toContain('data-amend="ord-9"');
    expect(oacts).toContain('data-cancel="ord-9"');
    expect(p.run<string>(`tkOpenActs({ o: ${JSON.stringify({ ...order, venue: "wallet", venueName: "Wallet", walletTxs: [{}], ref: "" })} })`)).toContain("Send from wallet…");
    // an order the account stopped following (the owner's cancel asked while its venue refused this network): Not followed, its note on
    // hover, never Open; no Change, and Cancel stays (it sends the owner's cancel again)
    const gone = { ...order, unfollowed: true, note: "Exchange refuses this network, so the account can neither cancel it nor see it fill: it stopped following it. Cancel it at Exchange" };
    expect(p.run<string>(`tkOpenStatus({ o: ${JSON.stringify(gone)} })`)).toBe(`<span class="tp-st dim" title="${gone.note}">Not followed</span>`);
    const goneActs = p.run<string>(`tkOpenActs({ o: ${JSON.stringify(gone)} })`);
    expect(goneActs).not.toContain("data-amend");
    expect(goneActs).toContain('data-cancel="ord-9"');
    expect(p.run<string>(`tkOpenStatus({ o: ${JSON.stringify(order)} })`)).toBe('<span class="tp-st">Open</span>');
    const src = source("ui/trade.js");
    expect(src).toContain('if (d.review) return void go("portfolio", { card: d.review });');
    expect(src).not.toContain('type: "approveCard"');
    // drawn through paint (in place: the focused button keeps its focus), its buttons heard once, on the section itself; the empty words
    // say where a card is answered
    const body = src.slice(src.indexOf("function tkDrawOpen"), src.indexOf("function tkOpenWhat"));
    expect(body).toContain("paint(sec, html);");
    expect(body).toMatch(/if \(sec\.tkHeard\) return;\s*sec\.tkHeard = true;\s*sec\.addEventListener\("click"/);
    expect(body).toContain("data-cancel-all");
  });

  it("drafts the owner's words to an agent and, when asked, its trading limit for them — exactly the fields the door signs; the composer suggests by the six kinds", () => {
    const now = Date.parse("2026-10-06T12:00:00.000Z");
    const d = p.out<any>(`htaDrafts({ agent: "0xABCDEF0000000000000000000000000000000001", venue: "ex", symbol: " ETH/USDT ", side: "sell", usd: "100", text: "  Sell about $100 of ETH under $2,300  ", days: "7", withLimit: true, perOrder: "", budget: "200" }, ${now})`);
    expect(d.intent).toEqual({ type: "setIntent", id: "", agent: "0xabcdef0000000000000000000000000000000001", venue: "ex", symbol: "ETH/USDT", side: "sell", usd: "100", text: "Sell about $100 of ETH under $2,300", validUntil: now + 7 * 86_400_000 });
    // per order left empty: the whole budget is one order's most
    expect(d.limit).toEqual({ type: "approveSpend", agent: "0xabcdef0000000000000000000000000000000001", scope: "trade", allow: "ex", perPayment: "200", budget: "200", windowHours: 0, validUntil: now + 7 * 86_400_000 });
    // every agent: no limit (a limit is one agent's); no venue: every venue; words cut at 200; a side that is neither is left to the agent
    const all = p.out<any>(`htaDrafts({ agent: "*", side: "hold", text: ${JSON.stringify("x".repeat(260))}, withLimit: true, budget: "50" }, ${now})`);
    expect([all.limit, all.intent.agent, all.intent.side, all.intent.text.length]).toEqual([null, "*", "", 200]);
    expect(p.out<any>(`htaDrafts({ agent: "0xabcdef0000000000000000000000000000000001", text: "go", withLimit: true, budget: "50" }, ${now})`).limit.allow).toBe("*");
    // handing over earning gives an earn limit, not a trading one — at the venue named, or the venues that earn; never every account
    expect(p.out<any>(`htaDrafts({ agent: "0xabcdef0000000000000000000000000000000001", venue: "okx", text: "keep USDC earning", withLimit: true, budget: "50", scope: "earn" }, ${now})`).limit).toMatchObject({ scope: "earn", allow: "okx" });
    expect(p.out<any>(`htaDrafts({ agent: "0xabcdef0000000000000000000000000000000001", text: "keep USDC earning", withLimit: true, budget: "50", scope: "earn", earnAt: "okx,mm" }, ${now})`).limit).toMatchObject({ scope: "earn", allow: "okx,mm" });
    expect(p.out<any>(`htaDrafts({ agent: "0xabcdef0000000000000000000000000000000001", text: "keep USDC earning", withLimit: true, budget: "50", scope: "earn" }, ${now})`).limit).toBeNull();
    // words being changed keep the end of the limit given with them: both end at that moment
    const kept = p.out<any>(`htaDrafts({ id: "intent-0002", agent: "0xabcdef0000000000000000000000000000000001", text: "slower", days: "1", until: ${now + 5 * 86_400_000}, withLimit: true, budget: "50" }, ${now})`);
    expect([kept.intent.validUntil, kept.limit.validUntil]).toEqual([now + 5 * 86_400_000, now + 5 * 86_400_000]);
    // what the door signs, field for field, once the account adds its nonce
    for (const a of [d.intent, d.limit, { type: "setIntent", id: "intent-0001", agent: "*", venue: "", symbol: "", side: "", usd: "", text: "", validUntil: 0 }]) expect(malformed({ ...a, nonce: now } as OwnerAction), a.type).toBeNull();
    // the composer: a hint for each of the six kinds and for earning; a kind tag; the sheet variant lists no intents (Portfolio does)
    expect(p.out("Object.keys(HTA_HINT)")).toEqual(["crypto", "stocks", "rwas", "perps", "preipo", "predictions", "earn"]);
    expect(p.out('[htaKindWord("perps"), htaKindWord("earn"), htaKindWord("")]')).toEqual(["Perps", "Earn", ""]);
    const intent = source("ui/intent.js");
    expect(intent).not.toContain("Your words to agents");
    expect(intent).not.toMatch(/Conservative|Aggressive/);
    expect(intent).toContain("openSheet('<div data-hta></div>'");
    expect(intent).toContain("openTicket({ ...(kind !== \"earn\" ? { kind } : {}),");
    expect(p.run("typeof htaIntents")).toBe("function");
  });
});

describe("the ticket at rest leaves the page refreshing", () => {
  it("opens the resting ticket on the kind showing without taking the focus, and its search counts as the page's own (data-live), so a cursor in it does not stop the refresh", () => {
    const p = page();
    p.set("A", pageOf([EX]));
    // what the panel is asked to open, captured: at rest, after its close, and on purpose (the shell's own route and render are stubbed:
    // this stand-in browser has no panes to draw)
    p.run("ROUTE.tab = 'trade'; TK.kind = 'crypto'; render = () => {}; routed = () => {}; OPENED = []; tkTicket = (panel, kind, preset) => OPENED.push([kind, preset]);");
    p.run("tkRest()");
    p.run("openTicket({})");
    p.run("openTicket({ kind: 'perp', venue: 'ex', symbol: 'ETH/USDT:USDT' })");
    expect(p.out("OPENED")).toEqual([["crypto", { kind: "crypto", rest: true }], ["crypto", {}], ["perps", { kind: "perp", venue: "ex", symbol: "ETH/USDT:USDT" }]]);
    // a ticket of another kind moves the seg to it
    expect(p.run("TK.kind")).toBe("perps");
    // off the Trade pane, the ticket waits and the page goes to Trade on the market's kind
    p.run("ROUTE.tab = 'portfolio'; var WENT = []; go = (tab, params) => WENT.push([tab, params]); openTicket({ kind: 'event', venue: 'predict', symbol: 'X' })");
    expect(p.out("[WENT, TK.pending]")).toEqual([[["trade", { kind: "predictions" }]], { kind: "event", venue: "predict", symbol: "X" }]);
    // the shell keeps refreshing while focus is inside [data-live]: the ticket's search and the picker's are marked so
    const src = source("ui/trade.js");
    expect(src).toContain('<div class="tk-find" data-find data-live>');
    expect(src).toContain('<form class="tk-pfind" role="search" data-live>');
    expect(src).toContain("if (!preset.symbol && !preset.venue && !preset.rest) setTimeout(() => live() && form.elements.q.focus(");
    // its close puts the panel back at rest on the kind showing, and drops the ticket kept in this browser
    expect(src).toContain('b.addEventListener("click", () => {\n    tkDraftKeep(null);\n    tkOpen({ kind: TK.kind, rest: true });');
    // earn and selling many are Portfolio's sheets now: an old preset goes there when they are on the page
    p.run("ROUTE.tab = 'trade'; var SHEETS = []; openEarn = (x) => SHEETS.push(['earn', x]); openSellMany = (x) => SHEETS.push(['sellmany', x]); OPENED = []; tkOpen({ variant: 'earn', venue: 'ex' }); tkOpen({ tile: 'sellmany' })");
    expect(p.out("[SHEETS, OPENED]")).toEqual([[["earn", { variant: "earn", venue: "ex" }], ["sellmany", { tile: "sellmany" }]], []]);
  });
});

describe("closing a position, from whichever pane", () => {
  const POS = { venue: "ex", venueName: "Exchange", symbol: "BTC/USDT:USDT", name: "BTC perpetual", kind: "perp", side: "long", qty: 0.5, usd: 31000, markPrice: 62000, unrealizedUsd: 120 };
  const prep = (close?: Record<string, unknown>) => ({ action: { type: "liveClose", venue: "ex", symbol: "BTC/USDT:USDT", qty: "" }, quote: { words: "close", ...(close ? { close } : {}) } });

  it("says what the prepared close is worth at the worst price it may fill at, and refuses one over the cap before the sign button — with a part that fits one click away; inside the cap, no standing cap sentence", () => {
    const p = page();
    p.set("A", pageOf([EX]));
    p.run("var QD = null; quoteDialog = (o) => { QD = o; return { form: { addEventListener() {}, elements: {} }, requote() {} }; }");
    p.run(`openClose(${JSON.stringify(POS)})`);
    expect(p.run("QD.title")).toBe("Close BTC perpetual");
    expect(p.run("QD.go")).toBe("Sign and close");
    // over the cap: the worth, the worst price, and the refusal before the sign button (block), with the part that fits
    const over = prep({ worthUsd: 30900, capUsd: 250, overCap: true, side: "sell", qty: 0.5, worstPrice: 61800 });
    const words = p.run<string>(`QD.show(${JSON.stringify(over)})`);
    expect(words).toContain("Sell 0.5");
    expect(words).toContain("≈ $30,900.00");
    expect(words).toContain("filled no worse than 61,800");
    expect(words).toContain("One order may be worth up to $250.00 on this server.");
    // 0.5 × $250 × 0.98 / $30,900, to the millionth
    expect(words).toContain('data-close-part="0.003964"');
    expect(p.run(`QD.block(${JSON.stringify(over)})`)).toBe("Worth about $30,900.00: more than the $250.00 one order may be on this server, so the account would refuse it. Close part of it.");
    // in the account's own words, where it gave them
    expect(p.run(`QD.block(${JSON.stringify(prep({ worthUsd: 30900, capUsd: 250, overCap: true, side: "sell", qty: 0.5, why: "$30,900.00 is more than the most one order may be on this server ($250.00): close part of it, or start the server with a higher --live-cap" }))})`)).toBe("$30,900.00 is more than the most one order may be on this server ($250.00): close part of it, or start the server with a higher --live-cap.");
    // inside the cap: nothing refused, and the cap not said (it belongs to the block message and Settings)
    const inside = prep({ worthUsd: 198.2, capUsd: 250, overCap: false, side: "sell", qty: 0.0032, worstPrice: 61500 });
    expect(p.run(`QD.block(${JSON.stringify(inside)})`)).toBe("");
    expect(p.run<string>(`QD.show(${JSON.stringify(inside)})`)).not.toContain("$250.00");
    // a short is bought back
    expect(p.run<string>(`QD.show(${JSON.stringify(prep({ worthUsd: 100, capUsd: 250, overCap: false, side: "buy", qty: 1, worstPrice: 101 }))})`)).toContain("Buy back 1");
    // an account that does not say what a close is worth: shown as before, and nothing refused here (the door still holds it to the cap)
    expect(p.run(`QD.block(${JSON.stringify(prep())})`)).toBe("");
    expect(p.run<string>(`QD.show(${JSON.stringify(prep())})`)).toContain("≈ $31,000.00");
    // the draft: all of it, or the part typed
    expect(p.out('QD.draft({ values: { qty: "" } })')).toEqual({ type: "liveClose", venue: "ex", symbol: "BTC/USDT:USDT", qty: "" });
    expect(p.out('QD.draft({ values: { qty: "0.003964" } })')).toMatchObject({ qty: "0.003964" });
    // the part offered is in the market's own steps of a size, and none when even the smallest order it takes is over the cap
    expect(p.run("tkClosePart(0.01, 624.89, 250, false, { step: 0.001 })")).toBe(0.003);
    expect(p.run("tkClosePart(0.01, 624.89, 250, false, { step: 0.001, min: 0.005 })")).toBe(0);
    expect(p.run("tkClosePart(3, 300, 250, false, { step: 0.5 })")).toBe(2);
    // an event contract is sold, in whole contracts
    p.run(`openClose(${JSON.stringify({ ...POS, kind: "event", name: "Fed cut · Yes", symbol: "FED:YES", qty: 900 })})`);
    expect(p.run("QD.go")).toBe("Sign and sell");
    expect(p.run<string>(`QD.show(${JSON.stringify(prep({ worthUsd: 540, capUsd: 250, overCap: true, side: "sell", qty: 900, worstPrice: 0.6 }))})`)).toContain('data-close-part="408"');
  });

  it("is the one close every pane opens: Portfolio's and the market drawer's go through it, and the sheet holds the sign button off while a refusal stands", () => {
    expect(source("ui/portfolio.js")).toContain("if (p && typeof openClose === \"function\") openClose(p);");
    // the one drawer (markets.js; asset.js opens it by key) closes through the same door
    expect(source("ui/markets.js") + source("ui/asset.js")).toMatch(/typeof openClose === "function"/);
    const core = source("ui/core.js");
    expect(core).toContain("btn.disabled = !owns() || !!no;");
    expect(core).toContain("if (!prepared || busy || !stop.hidden) return;");
  });
});

describe("a ticket kept in this browser", () => {
  const DRAFT = { kind: "crypto", venue: "ex", venueName: "Exchange", symbol: "BTC/USDT", side: "buy", key: "coin:BTC", base: "BTC", name: "Bitcoin", amount: "25", unit: "usd", orderType: "limit", limitPrice: "60000" };
  const kept = () => {
    const p = page();
    p.set("A", pageOf([EX, PRED]));
    p.run("var STORE = {}; localStorage.getItem = (k) => (k in STORE ? STORE[k] : null); localStorage.setItem = (k, v) => { STORE[k] = String(v); }; localStorage.removeItem = (k) => { delete STORE[k]; }");
    p.run('var OPENED = []; tkOpen = (preset) => OPENED.push(preset); var ASKED = []; var MARKET = { ok: true, market: { symbol: "BTC/USDT", open: true } }; api = async (path) => { ASKED.push(path); return MARKET; }');
    return p;
  };
  const again = async (p: ReturnType<typeof page>) => {
    p.run("TK.draftLooked = false");
    await p.run("tkReopenDraft()");
  };

  it("opens again, at rest and on its kind, while its venue is connected and still lists its market", async () => {
    const p = kept();
    p.run(`tkDraftKeep(${JSON.stringify(DRAFT)})`);
    expect(p.out("Object.keys(JSON.parse(STORE['account.ticket'])).sort()")).toEqual([...Object.keys(DRAFT), "at"].sort());
    await again(p);
    expect(p.out("ASKED")).toEqual(["/api/account/market?venue=ex&symbol=BTC%2FUSDT"]);
    expect(p.out("OPENED")).toEqual([{ ...DRAFT, rest: true }]);
    expect(p.run("TK.kind")).toBe("crypto");
    // looked at once a visit
    await p.run("tkReopenDraft()");
    expect(p.out("OPENED.length")).toBe(1);
    // a draft of the page before this one named a ticket variant: it opens on the kind that variant was
    p.run(`OPENED = []; STORE['account.ticket'] = JSON.stringify({ ...${JSON.stringify({ ...DRAFT, kind: undefined, variant: "perps", symbol: "ETH/USDT:USDT" })}, at: Date.now() })`);
    await again(p);
    expect(p.out("OPENED[0].kind")).toBe("perps");
  });

  it("is dropped without a word when its venue is gone, its market is gone, it is a day old, or it was never a ticket", async () => {
    const p = kept();
    const dropped = async (setup: string) => {
      p.run(`tkDraftKeep(${JSON.stringify(DRAFT)}); OPENED = []; ${setup}`);
      await again(p);
      return [p.out("OPENED.length"), p.out("'account.ticket' in STORE")];
    };
    // the venue disconnected
    expect(await dropped(`A = ${JSON.stringify(pageOf([PRED]))}`)).toEqual([0, false]);
    // connected, but its key can no longer trade
    expect(await dropped(`A = ${JSON.stringify(pageOf([{ ...EX, trade: { can: false, what: "spot and perpetuals", kinds: ["spot", "perp"] } }]))}`)).toEqual([0, false]);
    p.set("A", pageOf([EX, PRED]));
    // the venue no longer lists it
    expect(await dropped('MARKET = { ok: false, refusal: { code: "E_VENUE_NO_MARKET", message: "Exchange lists no BTC/USDT" } }')).toEqual([0, false]);
    p.run('MARKET = { ok: true, market: { symbol: "BTC/USDT" } }');
    // a day old
    expect(await dropped("STORE['account.ticket'] = JSON.stringify({ ...JSON.parse(STORE['account.ticket']), at: Date.now() - 25 * 3600000 })")).toEqual([0, false]);
    // not a ticket the page keeps: an earn draft of the page before this one, no kind at all, not JSON
    expect(await dropped(`STORE['account.ticket'] = JSON.stringify({ ...${JSON.stringify({ ...DRAFT, kind: undefined })}, variant: "earn", at: Date.now() })`)).toEqual([0, false]);
    expect(await dropped(`STORE['account.ticket'] = JSON.stringify({ ...${JSON.stringify({ ...DRAFT, kind: "nothing" })}, at: Date.now() })`)).toEqual([0, false]);
    expect(await dropped("STORE['account.ticket'] = '{not json'")).toEqual([0, false]);
  });

  it("gives way to a ticket opened meanwhile, and is kept for later; storage that is off opens nothing and breaks nothing; the markets picked are remembered per kind", async () => {
    const p = kept();
    p.run(`tkDraftKeep(${JSON.stringify(DRAFT)}); api = async (path) => { TK.gen++; return MARKET; }`);
    await again(p);
    expect([p.out("OPENED.length"), p.out("'account.ticket' in STORE")]).toEqual([0, true]);
    // Recent: the last markets picked, per kind, newest first, one entry a market
    p.run('tkRecentAdd({ kind: "crypto", key: "coin:BTC", name: "Bitcoin", base: "BTC", venue: "ex", venueName: "Exchange", symbol: "BTC/USDT" }); tkRecentAdd({ kind: "perps", key: "perp:ETH", name: "ETH perpetual", base: "ETH", venue: "ex", venueName: "Exchange", symbol: "ETH/USDT:USDT" }); tkRecentAdd({ kind: "crypto", key: "coin:SOL", name: "Solana", base: "SOL", venue: "ex", venueName: "Exchange", symbol: "SOL/USDT" }); tkRecentAdd({ kind: "crypto", key: "coin:BTC", name: "Bitcoin", base: "BTC", venue: "ex", venueName: "Exchange", symbol: "BTC/USDT" })');
    expect(p.out('tkRecent("crypto").map((r) => r.symbol)')).toEqual(["BTC/USDT", "SOL/USDT"]);
    expect(p.out('tkRecent("perps").map((r) => r.symbol)')).toEqual(["ETH/USDT:USDT"]);
    p.run("localStorage.getItem = () => { throw new Error('storage is off'); }; localStorage.removeItem = () => { throw new Error('storage is off'); }");
    await again(p);
    expect(p.out("OPENED.length")).toBe(0);
    expect(p.out('tkRecent("crypto")')).toEqual([]);
  });
});

describe("a tokenised asset in the ticket", () => {
  it("shows the issuer's words where its issuer closed it or keeps it from being swapped, instead of a button that would only be refused", () => {
    const p = page();
    p.set("A", pageOf([WALLET]));
    const ousg = { kind: "rwa", base: "OUSG", at: [{ venue: "wallet", venueName: "Wallet", symbol: "OUSG/USDC@Ethereum", connected: true, canTrade: false, issuer: "Ondo Finance", eligibility: "OUSG moves only between wallets Ondo has approved" }] };
    expect(p.run(`tkShut(${JSON.stringify(ousg)}, { open: false, types: [], issuer: "Ondo Finance", note: "OUSG on Ethereum: transfers only between wallets the issuer approved." })`)).toBe("No order for it here · Ondo Finance: OUSG on Ethereum: transfers only between wallets the issuer approved.");
    // paused by its issuer, with no words of the venue's: the issuer's own
    expect(p.run(`tkShut(${JSON.stringify(ousg)}, { open: false, types: ["market"], issuer: "Ondo Finance" })`)).toBe("Closed now · Ondo Finance: OUSG moves only between wallets Ondo has approved.");
    // open, or not a tokenised asset: nothing is held back here
    expect(p.run(`tkShut(${JSON.stringify(ousg)}, { open: true, types: ["market"], issuer: "Ondo Finance" })`)).toBe("");
    expect(p.run('tkShut({ kind: "stock", at: [] }, { open: false, types: ["limit"] })')).toBe("");
  });
});

describe("the same drafts through the real account's door, on the stand-in account", () => {
  let s: Standin;
  const p = page();
  const browser = simKey("device:ui-trade-test-browser");
  const get = async (path: string): Promise<{ status: number; body: any }> => {
    const r = await fetch(`${s.url}${path}`);
    return { status: r.status, body: await r.json() };
  };
  const post = async (path: string, body: unknown): Promise<{ status: number; body: any }> => {
    const r = await fetch(`${s.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  /** as the page does: the account prepares the draft, the browser signs exactly what was prepared, the door takes it */
  const act = async (draft: Record<string, unknown>) => {
    const prep = await post("/api/account/prepare", { draft });
    expect(prep.status, JSON.stringify(prep.body)).toBe(200);
    const action = prep.body.action as OwnerAction;
    return post("/api/exchange", { action, nonce: action.nonce, signature: signDevice(browser, action) });
  };

  beforeAll(async () => {
    s = await startStandin({ port: 0, tickMs: 0, agentMs: 0 });
    const paired = await post("/api/account/pair", { jwk: browser.jwk, label: "this browser", code: s.code });
    expect(paired.body).toMatchObject({ ok: true, role: "owner" });
  }, 60_000);
  afterAll(async () => {
    await s?.close();
  });

  it("shows the kinds the stand-in's venues and public listings really have, each kind's rows read as the picker reads them", async () => {
    const { body } = await get("/api/account");
    p.set("A", body);
    const got: Record<string, unknown> = {};
    for (const kind of ["crypto", "stocks", "rwas", "perps", "preipo", "predictions"]) {
      const r = await get(`/api/account/explore?tab=${kind}&limit=12`);
      // a kind this server does not know yet answers with a refusal: the picker reads it as an empty list, without a toast
      got[kind] = { at: Date.now(), items: r.status === 200 ? r.body.items : [], missing: [] };
    }
    const kinds = p.out<string[]>(`tkKindsFor(connected(), ${JSON.stringify(got)}, lensNow())`);
    for (const k of ["crypto", "perps", "predictions"]) expect(kinds).toContain(k);
    // the Pre-IPO face lists the company's row — its implied valuation, the stand-in venue's Trade and the public venue's Connect to trade
    const pre = (got.preipo as { items: Array<Record<string, any>> }).items.filter((x) => p.run(`tkPre(${JSON.stringify(x)})`));
    if (pre.length) {
      expect(kinds).toContain("preipo");
      const rows = p.out<Array<{ state: string; implied?: { usd: number } }>>(`tkWhereRows(${JSON.stringify(pre[0])}, null, "preipo")`);
      expect(rows.some((r) => r.state === "able")).toBe(true);
      expect(p.run<string>(`tkKindBlock("preipo", null, null, ${JSON.stringify(pre[0])}, {})`)).toContain("Implied valuation ≈");
      // a pre-IPO row never shows under Perps
      expect((got.perps as { items: Array<{ key: string }> }).items.some((x) => x.key === pre[0]!.key)).toBe(false);
    }
  });

  it("places the ticket's order — an event contract's limit typed in cents rests at the venue at that price", async () => {
    const draft = p.out<Record<string, unknown>>('tkOrderDraft({ amount: "10", unit: "usd", orderType: "limit", limitPrice: "30" }, { venue: "predict", symbol: "SI-FEDCUT-DEC:NO", side: "buy", event: true })');
    const r = await act(draft);
    expect(r.status).toBe(200);
    expect(r.body.order).toMatchObject({ venue: "predict", symbol: "SI-FEDCUT-DEC:NO", type: "limit", limitPrice: 0.3, status: "open" });
  });

  it("pays with a coin held in two signatures: the sale, then the buy sized by what the sale brought", async () => {
    const markets = (await get("/api/account/markets?venue=ex&q=")).body.markets;
    const plan = p.out<any>(`tkSwapPlan(${JSON.stringify({ venue: "ex", from: "BTC", to: "SOL", amount: "0.001", markets })})`);
    expect(plan.mode).toBe("two");
    const sold = await act(plan.legs[0]);
    expect(sold.body.order).toMatchObject({ side: "sell", status: "filled" });
    const usd = p.out<number>(`tkProceeds(${JSON.stringify(sold.body.order)})`);
    expect(usd).toBeGreaterThan(50);
    const bought = await act({ ...plan.legs[1], usd: String(usd) });
    expect(bought.body.order).toMatchObject({ symbol: "SOL/USDT", side: "buy", status: "filled" });
    expect(bought.body.order.qty * bought.body.order.avgPrice).toBeLessThanOrEqual(usd + 0.01);
  });

  it("prepares a position's close at the door and reads it as the close sheet does: its worth against this server's cap, or as before on an account that does not say", async () => {
    const { body } = await get("/api/account/positions");
    const pos = body.positions.find((x: { venue: string; kind: string; qty: number }) => x.venue === "ex" && x.kind === "perp" && x.qty > 0);
    expect(pos).toBeTruthy();
    const prep = await post("/api/account/prepare", { draft: { type: "liveClose", venue: pos.venue, symbol: pos.symbol, qty: "" } });
    const c = p.out<{ worthUsd: number; capUsd: number; overCap: boolean } | null>(`tkCloseQuote(${JSON.stringify(prep.body)})`);
    if (prep.status === 200 && c) {
      expect(c.worthUsd).toBeGreaterThan(0);
      expect(c.overCap).toBe(c.worthUsd > c.capUsd);
      expect(p.out<string>(`tkCloseBlock(${JSON.stringify(prep.body)})`) !== "").toBe(c.overCap);
    } else expect(p.out(`tkCloseBlock(${JSON.stringify(prep.body)})`)).toBe("");
  });

  it("hands words to the agent with a limit for them: the intent stands, the limit replaces the agent's, and withdrawing ends the intent", async () => {
    const page0 = (await get("/api/account")).body;
    const d = p.out<any>(`htaDrafts({ agent: ${JSON.stringify(s.agent.address)}, venue: "ex", symbol: "ETH/USDT", side: "sell", usd: "100", text: "Sell about $100 of ETH under $2,300", days: "3", withLimit: true, perOrder: "50", budget: "200" }, ${Date.parse(page0.now)})`);
    expect((await act(d.intent)).status).toBe(200);
    expect((await act(d.limit)).status).toBe(200);
    const after = (await get("/api/account")).body;
    const it = after.intents.find((x: { text: string }) => x.text === "Sell about $100 of ETH under $2,300");
    expect(it).toMatchObject({ agentName: "Claude Code", venue: "ex", side: "sell", usd: "100" });
    expect(after.spend.filter((x: { scope: string; agent: string }) => x.scope === "trade" && x.agent === s.agent.address)).toEqual([expect.objectContaining({ allow: ["ex"], perPaymentUsd: 50, budgetUsd: 200 })]);
    expect((await act({ type: "setIntent", id: it.id, agent: it.agent, venue: "", symbol: "", side: "", usd: "", text: "", validUntil: 0 })).status).toBe(200);
    expect((await get("/api/account")).body.intents.some((x: { id: string }) => x.id === it.id)).toBe(false);
  });

  it("withdrawing words a limit was given with ends the limit too, so the agent can place nothing after; words being changed keep the limit's end", async () => {
    const AG = JSON.stringify(s.agent.address);
    const now0 = Date.parse((await get("/api/account")).body.now);
    const d = p.out<any>(`htaDrafts({ agent: ${AG}, venue: "ex", symbol: "SOL/USDT", side: "buy", usd: "100", text: "Buy a little SOL", days: "7", withLimit: true, perOrder: "60", budget: "120" }, ${now0})`);
    expect((await act(d.intent)).status).toBe(200);
    expect((await act(d.limit)).status).toBe(200);
    const read = async () => {
      const a = (await get("/api/account")).body;
      p.set("A", a);
      return a;
    };
    let a = await read();
    const it0 = a.intents.find((x: { text: string }) => x.text === "Buy a little SOL");
    expect(p.out(`htaLimitOf(${JSON.stringify(it0)})`)).toMatchObject({ scope: "trade", allow: ["ex"], perPaymentUsd: 60, budgetUsd: 120 });
    // the words changed: their end stays the limit's, so the two still end together
    const changed = p.out<any>(`htaDrafts({ id: ${JSON.stringify(it0.id)}, agent: ${AG}, venue: "ex", text: "Buy a little SOL, slowly", days: "1", until: ${Date.parse(it0.validUntil)} }, ${now0})`);
    expect((await act(changed.intent)).status).toBe(200);
    a = await read();
    const it1 = a.intents.find((x: { id: string }) => x.id === it0.id);
    expect([it1.text, it1.validUntil]).toEqual(["Buy a little SOL, slowly", it0.validUntil]);
    // Withdraw signs the words away, then the limit given with them
    const drafts = p.out<Array<Record<string, unknown>>>(`htaWithdrawDrafts(${JSON.stringify(it1)}, ${now0})`);
    expect(drafts.map((x) => x.type)).toEqual(["setIntent", "approveSpend"]);
    expect(drafts[1]).toMatchObject({ agent: s.agent.address, scope: "trade", allow: "ex", perPayment: "0", budget: "0" });
    for (const x of drafts) expect((await act(x)).status).toBe(200);
    a = await read();
    expect(a.intents.some((x: { id: string }) => x.id === it0.id)).toBe(false);
    expect(a.spend.filter((x: { scope: string; agent: string }) => x.scope === "trade" && x.agent === s.agent.address)).toEqual([]);
    // even in Beast the agent now places nothing: its authority ended with the words
    expect((await act({ type: "setPolicy", change: "mode", value: "open" })).status).toBe(200);
    const order = await s.svc.exchange(await signAgent(s.agent, { type: "agentLiveOrder", venue: "ex", symbol: "SOL/USDT", side: "buy", orderType: "market", qty: "", usd: "50", limitPrice: "", nonce: Date.now() } as AgentAction));
    expect((order as { code?: string }).code).toBe("E_MANDATE_NONE");
    // words that came with no limit withdraw alone
    expect(p.out(`htaWithdrawDrafts({ id: "intent-9", agent: "*", validUntil: "2026-10-09T00:00:00.000Z" }, ${now0}).length`)).toBe(1);
  });
});
