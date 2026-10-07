/** The fix round after review 2: what the page's scripts do now that the reviews asked for and no earlier test pinned. The scripts run as
 * the page runs them (owner.js then ui/*.js in account.html's order, one global scope) over the stand-in browser test/unit/page-scripts.test.ts
 * uses, with a fixed clock where a countdown is drawn. Nothing here reaches a network or a venue. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext, Script } from "node:vm";
import { describe, expect, it } from "vitest";

const PUBLIC = fileURLToPath(new URL("../../src/portfolio/public/", import.meta.url));
const html = readFileSync(join(PUBLIC, "account.html"), "utf8");
const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1] ?? "");
const source = (src: string) => readFileSync(join(PUBLIC, src.replace(/^\//, "")), "utf8");
const NOW = Date.parse("2026-10-06T17:00:00.000Z");

/** the page's scripts in a stand-in browser: elements take listeners and report nothing; `fetch` is the caller's; the clock is fixed */
function page(opts: { fetch?: (path: string, init?: { method?: string; body?: string }) => Promise<unknown>; activeElement?: unknown } = {}) {
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
    document: { getElementById: element, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, body: element(), documentElement: { dataset: { theme: "cream" }, setAttribute() {} }, hidden: false, activeElement: opts.activeElement ?? null },
    location: { hash: "", origin: "http://127.0.0.1:4877" },
    history: { replaceState() {} },
    localStorage: { getItem: () => null, setItem() {} },
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
    fetch: opts.fetch ?? (() => new Promise(() => {})),
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
  for (const src of scripts) new Script(source(src), { filename: src }).runInContext(ctx);
  const run = <T = unknown>(code: string): T => runInContext(code, ctx) as T;
  return { run, out: <T = any>(code: string): T => JSON.parse(run<string>(`JSON.stringify(${code})`)) as T, set: (name: string, v: unknown) => run(`${name} = ${JSON.stringify(v)}`) };
}

/* an account with the venues given, the owner signing, trading on */
const account = (venues: unknown[], extra: Record<string, unknown> = {}) => ({ now: new Date(NOW).toISOString(), mode: "guard", liveUsd: 1000, venues, keys: [{ address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", name: "Claude Code", status: "ok", validUntil: "2026-11-05T00:00:00.000Z" }], spend: [], cards: [], asks: [], orders: [], payments: [], intents: [], watch: [], requests: [], subAccounts: [], signers: { owners: [], pendingDevices: [], threshold: 1 }, connectLive: { writes: { on: true, capUsd: 250 }, options: [{ kind: "polymarket-trade", connector: "live:polymarket-trade", needs: "key-file", label: "Polymarket" }] }, health: {}, ...extra });
const venue = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, live: true, plugged: true, usd: 100, holdings: [], trade: { can: true, what: "coins", kinds: ["spot"], positions: true }, ...extra });
const OWNER = 'Object.defineProperty(Owner, "role", { get: () => "owner", configurable: true })';

describe("fix round · the helpers the contract gained", () => {
  it("money, fine, px, usd and qtyOf: the sign before the dollar, a dash for what is not a number, small amounts to two figures", () => {
    const p = page();
    expect(p.out('[money(-1234.5), money(0), money(undefined), money("abc"), money(NaN)]')).toEqual(["-$1,234.50", "$0.00", "$0.00", "—", "—"]);
    expect(p.out("[fine(-0.001), fine(4e-7), fine(0.5), fine(12), fine(NaN)]")).toEqual(["-$0.001", "$0.0000004", "$0.50", "$12.00", "—"]);
    expect(p.out('[px("abc"), px(NaN), px(0.5), px(62140)]')).toEqual(["—", "—", "0.5", "62,140"]);
    expect(p.out("[usd(62140), usd(0.12121), usd(-0.5), usd(null), usd(\"x\")]")).toEqual(["$62,140.00", "$0.1212", "-$0.5", "—", "—"]);
    expect(p.out('[qtyOf(undefined), qtyOf("x"), qtyOf(1234.56789), qtyOf(0.5)]')).toEqual(["—", "—", "1,234.57", "0.5"]);
  });

  it("cents: one decimal, held to 0–100, the same in Markets, on the ticket, in the Asset drawer and in the Portfolio", () => {
    const p = page();
    expect(p.out("[cents(0.625), cents(0.995), cents(0.004), cents(0), cents(1.5), cents(-0.1), cents(undefined)]")).toEqual(["62.5¢", "99.5¢", "0.4¢", "0¢", "100¢", "0¢", "—"]);
    expect(p.out('[mkCents(0.625), tkCents(0.625), pfPrice({ class: "event", price: 0.625 })]')).toEqual(["62.5¢", "62.5¢", "62.5¢"]);
    // a limit typed in cents outside 0–100 is no price: "" (the ticket says so in its quote box)
    expect(p.out('[tkPriceIn("62", true), tkPriceIn("150", true), tkPriceIn("-5", true), tkPriceIn("150", false), tkCentsBad("150"), tkCentsBad("62"), tkCentsBad("")]')).toEqual(["0.62", "", "", "150", true, false, false]);
    // under What you sign, beside a prediction's limit: the cents the owner typed, read back
    expect(p.out('tkSignNotes({ action: { limitPrice: "0.62", stopPrice: "" } }, true)')).toEqual({ limitPrice: "limit 62¢ ($0.62 a contract)" });
    expect(p.run('whatYouSign({ shown: [{ name: "limitPrice", value: "0.62" }] }, { notes: { limitPrice: "limit 62¢ ($0.62 a contract)" } })')).toContain("limitPrice: 0.62   <i>limit 62¢ ($0.62 a contract)</i>");
  });

  it("ny, nyDay, nyTime and the statement's monthOf say a dash (or nothing) for a time that is not one; a time in milliseconds is one", () => {
    const p = page();
    expect(p.out('[nyDay(undefined), nyDay(""), nyDay("garbage"), nyDay(null), nyTime("x"), monthOf("x"), monthName("—")]')).toEqual(["—", "—", "—", "—", "—", "", "—"]);
    expect(p.run(`nyDay(${NOW})`)).toBe(p.run(`nyDay("${new Date(NOW).toISOString()}")`));
    expect(p.run('monthOf("2026-10-06T17:00:00.000Z")')).toBe("2026-10");
  });

  it("csvCell: a cell starting with = + - @ tab or return is put behind an apostrophe and quoted; a number stays a number", () => {
    const p = page();
    expect(p.out('[csvCell("=1+1"), csvCell("+1"), csvCell("-2"), csvCell("@SUM(1)"), csvCell("\\tx"), csvCell(-12.5), csvCell(0), csvCell("plain"), csvCell("a,b")]')).toEqual(["\"'=1+1\"", "\"'+1\"", "\"'-2\"", "\"'@SUM(1)\"", "\"'\tx\"", "-12.5", "0", "plain", '"a,b"']);
  });

  it("mkLabel re-cases only YES NO UP DOWN; byOf, isLive, typeText and readOnlyWords are one each, in core", () => {
    const p = page();
    expect(p.out('[mkLabel("YES"), mkLabel("DOWN"), mkLabel("FURIA"), mkLabel("Falcons")]')).toEqual(["Yes", "Down", "FURIA", "Falcons"]);
    p.set("A", account([]));
    expect(p.out('[byOf({ authority: "owner" }), byOf({ authority: "agent", agent: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", card: "card-1" }), byOf({ authority: "agent", agent: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })]')).toEqual(["You", "Claude Code, approved by you", "Claude Code, inside its limit"]);
    expect(p.out('[isLive({ status: "open" }), isLive({ status: "partial" }), isLive({ status: "filled" })]')).toEqual([true, true, false]);
    expect(p.run('typeText({ type: "stop_limit", stopPrice: 100, limitPrice: 99, tif: "gtc", postOnly: true })')).toBe("stop 100, limit 99 · GTC · post-only");
    expect(p.out('[readOnlyWords({ readOnlyBecause: "Alpaca moves no cash" }), readOnlyWords({ noTradeBecause: "this key can\'t trade" }), readOnlyWords({ watchOnly: true }), readOnlyWords({ via: "Robinhood sign-in" }), readOnlyWords({})]')).toEqual(["Alpaca moves no cash", "this key can't trade", "a watched address: nothing is traded or sent from it", "Robinhood sign-in gives no interface for orders here", "its connection gives no interface for orders here"]);
    for (const f of ["ui/statement.js", "ui/trade.js", "ui/asset.js"]) expect(source(f), f).not.toMatch(/^(const|function) (isLive|byOf|tkBy|typeText|later)\b/m);
    for (const name of ["qty", "formOf", "moneyFields", "mkPaint", "MKT_PAINTED", "PF_DOLLAR_ASSETS", "TK_DOLLARS", "NETWORKS"]) expect(p.run(`typeof ${name}`), name).toBe("undefined");
  });

  it("the account's lists come from /api/account when it publishes them (dollars, networks, bridgeChains), the page's own only as the fallback", () => {
    const p = page();
    p.set("A", account([]));
    // the fallback is the account's own door list (live/types.ts STABLES): USDT0 and pUSD are dollars there, USDE is not
    expect(p.out("[isDollar('usdc'), isDollar('USDE'), isDollar('USDT0'), isDollar('pusd'), networksOf()[0], bridgeChainsOf().length]")).toEqual([true, false, true, true, "Arbitrum", 6]);
    p.set("A", account([], { dollars: ["USDC", "USDT0", "pUSD"], networks: ["Base", "Arbitrum"], bridgeChains: ["Base", "Arbitrum", "Robinhood Chain"] }));
    expect(p.out("[isDollar('USDE'), isDollar('usdt0'), isDollar('PUSD'), networksOf(), bridgeChainsOf(), receiveNetworks()]")).toEqual([false, true, true, ["Base", "Arbitrum"], ["Base", "Arbitrum", "Robinhood Chain"], ["Base", "Arbitrum", "Robinhood Chain"]]);
    // a swap between two of the account's dollars is a MOVE (Move › Swap stablecoins, under Portfolio), never a trade: the ticket's plan says so
    expect(p.out('tkSwapPlan({ venue: "w", from: "USDT0", to: "pUSD", amount: "5", markets: [] })')).toMatchObject({ mode: "", why: expect.stringContaining("Move › Swap stablecoins") });
    expect(p.out('[modeOf("guard"), modeOf("open"), modeOf("Guard"), modeOf("Beast"), modeOf(undefined)]')).toEqual(["guard", "open", "guard", "open", "guard"]);
  });

  it("setOptions writes a select's options only when they differ, and moves its value; formFields reads a form by name", () => {
    const p = page();
    p.run('var SEL = { innerHTML: "", value: "", options: [{ value: "a", textContent: "A", disabled: false }, { value: "b", textContent: "B", disabled: false }] }');
    p.run('setOptions(SEL, [["a", "A"], ["b", "B"]], "b")');
    expect(p.out("[SEL.innerHTML, SEL.value]")).toEqual(["", "b"]);
    p.run('setOptions(SEL, [["a", "A"], ["c", "C"]], "zzz")');
    expect(p.out("[SEL.innerHTML, SEL.value]")).toEqual(['<option value="a">A</option><option value="c">C</option>', "a"]);
  });

  it("paint replaces an element's HTML only when it changed and gives the focused control (data-fk) its focus back", () => {
    let focused = "";
    const btn = { dataset: { fk: "cancel:ord-2" }, focus: () => { focused = "cancel:ord-2"; } };
    const el = { innerHTML: "", contains: (x: unknown) => x === btn, querySelectorAll: (sel: string) => (sel.includes("data-fk") ? [{ dataset: { fk: "approve:c1" }, focus() {} }, btn] : []) };
    const p = page({ activeElement: btn });
    p.run("globalThis.EL = null");
    (p.run("globalThis") as Record<string, unknown>).EL = el;
    expect(p.run('paint(EL, "<b>one</b>")')).toBe(true);
    expect(el.innerHTML).toBe("<b>one</b>");
    expect(focused).toBe("cancel:ord-2");
    expect(p.run('paint(EL, "<b>one</b>")')).toBe(false);
    expect(p.run('paint(EL, "<b>two</b>")')).toBe(true);
  });

  it("the refresh is quiet only for a text field being typed in: a button or a toggle with the focus holds nothing half-typed", () => {
    const quiet = (active: unknown) => {
      const p = page({ activeElement: active });
      p.run('busy = false');
      return p.run("quiet()");
    };
    const inForm = (matches: (s: string) => boolean) => ({ matches, closest: (s: string) => (s === "[data-live]" ? null : {}) });
    expect(quiet(inForm((s) => s.startsWith("input:not")))).toBe(false);
    expect(quiet(inForm((s) => s === "select" || s.startsWith("input:not")))).toBe(false);
    expect(quiet(inForm(() => false))).toBe(true);
    expect(quiet(null)).toBe(true);
  });
});

describe("fix round · what the panes draw", () => {
  const agentWallet = venue("agent-research", "research", { connector: "live:agent-wallet", trade: undefined, liveCan: { receive: true, withdraw: true, ledgers: [] }, holdings: [{ asset: "USDC", amount: 72.38, usd: 72.38, class: "stable", note: "Base" }, { asset: "ETH", amount: 0.002, usd: 9, class: "crypto", note: "Base" }] });

  it("never offers Disconnect for an agent wallet: not under Accounts (no row-level Disconnect at all), not in its Details", () => {
    const p = page();
    p.run(OWNER);
    p.set("A", account([venue("ex", "Exchange"), agentWallet]));
    expect(p.out('[isAgentWallet(A.venues[0]), isAgentWallet(A.venues[1]), isAgentWallet({ id: "agent-x" })]')).toEqual([false, true, true]);
    // the IA round moved Disconnect into the Account drawer: no row of the Accounts table offers it, for any venue
    const acc = p.run<string>('pfAccountsHtml(pfVenueIn({ kind: "all", id: "" }), true)');
    expect(acc).not.toContain('data-pf-act="acct-off"');
    // the drawer's words, drawn through openDrawer: the Disconnect… button for the exchange alone
    p.run('var DRAWN = ""; openDrawer = (html) => { DRAWN = html; return { addEventListener() {}, querySelector: () => null }; }');
    p.run('pfDetails("agent-research")');
    expect(p.run("DRAWN")).not.toContain('data-det="off"');
    expect(p.run("DRAWN")).toContain("Empty it with Take back…");
    p.run('pfDetails("ex")');
    expect(p.run("DRAWN")).toContain('data-det="off"');
  });

  it("money to an agent wallet starts on the chain the wallet holds money or gas on", () => {
    const p = page();
    p.set("A", account([venue("ex", "Exchange"), agentWallet]));
    expect(p.out('[fundedChainOf("agent-research"), fundedChainOf("ex"), fundedChainOf("nowhere")]')).toEqual(["Base", "", ""]);
  });

  it("an event position's entry and mark are in cents under Positions; a venue's own words replace the generic Read-only chip", () => {
    const p = page();
    p.run(OWNER);
    p.set("A", account([venue("pr", "Predictions", { trade: { can: true, what: "event contracts", kinds: ["event"], positions: true } }), venue("alp", "Alpaca", { trade: undefined, readOnlyBecause: "Alpaca's API moves no cash: deposits and withdrawals are made at Alpaca" })]));
    p.set("PF.pos", { positions: [{ symbol: "FED:YES", name: "Fed cuts · Yes", kind: "event", side: "long", qty: 50, usd: 31, venue: "pr", venueName: "Predictions", entryPrice: 0.58, markPrice: 0.62 }], missing: [] });
    const pos = p.run<string>('pfPositionsHtml({ kind: "all", id: "" }, pfVenueIn({ kind: "all", id: "" }), true)');
    expect(pos).toContain("58¢ · 62¢");
    expect(pos).toContain("long 50 contracts");
    const chips = p.run<string>("pfChips(A.venues[1])");
    expect(chips).not.toContain(">Read-only<");
    expect(chips).toContain("Alpaca&#39;s API moves no cash");
    expect(p.run("pfTrades(A.venues[1]).text")).toBe("Alpaca's API moves no cash: deposits and withdrawals are made at Alpaca");
  });

  it("the Assets table folds the price into the name line (a class the stylesheet shows under 1320); the cost cover moved to the drawer", () => {
    const p = page();
    p.set("A", account([venue("ex", "Exchange")]));
    p.set("PF.hold", { rows: [], cost: [{ key: "crypto:BTC", coveredQty: 0.04, ofQty: 0.1, unrealizedUsd: 200, words: "from 2 buys" }], missing: [] });
    const rows = [{ key: "crypto:BTC", class: "crypto", asset: "BTC", amount: 0.05, usd: 3000, price: 60000, venues: [{ venue: "ex", venueName: "Exchange", amount: 0.05, usd: 3000 }] }];
    const t = p.run<string>(`pfAssetsHtml({ kind: "agent", id: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, ${JSON.stringify(rows)})`);
    expect(t).toContain('<span class="pf-px-l"> · $60,000.00</span>');
    expect(t).toContain('<th scope="col" class="r pf-px">Price</th>');
    expect(t).not.toContain("for 0.04 of 0.05");
    expect(source("ui/portfolio.css")).toMatch(/@media \(max-width: 1319px\)[\s\S]*\.pf-px[\s\S]*display: none/);
  });

  it("a prediction card past its close: closed at the venue → no buttons and the venue's words; still trading past its end date → the buttons stay and the countdown says so", () => {
    const p = page();
    p.run(OWNER);
    p.set("A", account([venue("kalshi", "Kalshi", { trade: { can: true, what: "event contracts", kinds: ["event"] } })]));
    const leg = (venue: string, symbol: string, extra: Record<string, unknown>) => ({ venue, venueName: "Kalshi", symbol, connected: true, canTrade: true, public: false, price: 0.6, ...extra });
    const item = (extra: Record<string, unknown>) => ({ key: "kalshi:FED", kind: "event", name: "Fed cuts?", price: 0.6, volumeUsd24h: 1000, category: "Economics", closeTime: "2026-10-06T16:00:00.000Z", tabs: ["predictions"], outcomes: [{ label: "Yes", price: 0.6, at: [{ venue: "kalshi", symbol: "FED:YES" }] }, { label: "No", price: 0.4, at: [{ venue: "kalshi", symbol: "FED:NO" }] }], at: [leg("kalshi", "FED:YES", extra)] });
    const closed = p.run<string>(`MKT.reg = []; mkCard(${JSON.stringify(item({ open: false, note: "closed: waiting for the result" }))})`);
    expect(closed).toContain(">Closed<");
    expect(closed).not.toContain('data-act="yn"');
    expect(closed).toContain("Kalshi: closed: waiting for the result.");
    expect(p.run(`mkRoute(${JSON.stringify(item({ open: false, note: "closed: waiting for the result" }))}, 0).act`)).toBe("why");
    const past = p.run<string>(`MKT.reg = []; mkCard(${JSON.stringify(item({ open: true, pastEnd: true }))})`);
    expect(past).toContain(">Past its end date · still trading<");
    expect(past).toContain('data-act="yn"');
    expect(p.run(`mkRoute(${JSON.stringify(item({ open: true, pastEnd: true }))}, 0).act`)).toBe("trade");
    // the facts line: what it is about · where · how much; no tag, no "more outcomes" link
    expect(past).toContain("Economics · Kalshi · $1k vol");
    expect(past).not.toContain("Connect to trade");
    expect(past).not.toContain("more outcome");
    // a card not yet closed counts down, and the words it will say are carried for the tick
    const open = p.run<string>(`MKT.reg = []; mkCard(${JSON.stringify({ ...item({ open: true }), closeTime: "2026-10-08T09:12:30.000Z" })})`);
    expect(open).toContain('data-ended="Closed" data-close="2026-10-08T09:12:30.000Z">Closes in');
  });

  it("the Markets pane: notes under the list, a read-only foot said once, no Macro or Sports tab of its own, Hand to agent on a public row", () => {
    const p = page();
    p.run(OWNER);
    p.set("A", account([]));
    expect(p.run('mkNotes(["A few of the busiest markets · search for more.", "", 7])')).toBe('<p class="mk-note">A few of the busiest markets · search for more.</p>');
    expect(p.out("MKT_TAB_IDS")).not.toContain("macro");
    expect(p.out("MKT_TAB_IDS")).not.toContain("sports");
    expect(p.out('mkParams({ tab: "sports" })')).toEqual({ tab: "all", q: "", sort: "", bogus: true });
    expect(p.out('mkParams({ tab: "predictions", q: " fed " })')).toEqual({ tab: "predictions", q: "fed", sort: "", bogus: false });
    const doge = { key: "coin:DOGE", kind: "coin", name: "Dogecoin", base: "DOGE", price: 0.12, tabs: ["crypto"], at: [{ venue: "okx-public", venueName: "OKX", symbol: "DOGE/USDT", connected: false, canTrade: false, public: true, price: 0.12, bid: 0.119, ask: 0.121, connectTo: "okx", connector: "live:exchange:okx" }] };
    p.set("A", account([], { connectLive: { writes: { on: true, capUsd: 250 }, options: [{ kind: "exchange", connector: "live:exchange", needs: "key-file", label: "Exchange", venues: ["okx"] }] } }));
    const acts = p.run<string>(`MKT.reg = []; mkActs(${JSON.stringify(doge)}, 0)`);
    expect(acts).toContain("Connect to trade");
    // one action per row: Hand to agent lives in the drawer, not on every row
    expect(acts).not.toContain('data-act="hand"');
    // the drawer shows the public venue's bid and ask where no venue of the owner's is connected
    const drawer = p.run<string>(`mkDrawerHtml({ item: ${JSON.stringify(doge)}, interval: "1h" })`);
    expect(drawer).toContain('data-fmt="bid">$0.119</span>');
    expect(drawer).toContain('data-fmt="ask">$0.121</span>');
    expect(drawer).toContain('data-act="hand"');
    // read-only: no connection is offered and nothing says "Connect to trade" on a card
    p.set("A", account([], { connectLive: { writes: { on: false }, options: [] } }));
    expect(p.run(`mkRoute(${JSON.stringify(doge)}).act`)).toBe("why");
  });

  it("a public line of a row the owner's own venue trades is a price, not a connection to offer (Markets drawer and the ticket's Where)", () => {
    const p = page();
    p.run(OWNER);
    p.set("A", account([venue("wallet", "Wallet", { trade: { can: true, what: "tokens", kinds: ["token"] } })], { connectLive: { writes: { on: true, capUsd: 250 }, options: [{ kind: "wallet", connector: "live:wallet", needs: "address", label: "Browser wallet" }] } }));
    const nvda = { key: "rwa:NVDA", kind: "rwa", name: "NVIDIA", base: "NVDA", price: 180, tabs: ["rwas"], at: [{ venue: "wallet", venueName: "Wallet", symbol: "NVDA/USDG@Robinhood Chain", connected: true, canTrade: true, public: false, price: 180 }, { venue: "robinhood-public", venueName: "Robinhood Stock Tokens", symbol: "NVDA", connected: false, canTrade: false, public: true, price: 181, connectTo: "robinhood-wallet", connector: "live:wallet" }] };
    expect(p.run(`mkTradedHere(${JSON.stringify(nvda)})`)).toBe(true);
    const across = p.run<string>(`mkAcrossHtml({ item: ${JSON.stringify(nvda)}, compare: null })`);
    expect(across).toContain('data-act="trade-at"');
    expect(across).not.toContain("Connect to trade");
    const rows = p.out<Array<{ state: string; connector?: string }>>(`tkWhereRows(${JSON.stringify(nvda)}, null)`);
    expect(rows.find((r) => r.state === "public")?.connector).toBe("");
  });

  it("tkKindOf: a venue named without a kind opens the ticket for what that venue trades; the old variant words map to kinds", () => {
    const p = page();
    p.set("A", account([venue("pr", "Predictions", { trade: { can: true, what: "event contracts", kinds: ["event"] } }), venue("hl", "Hyperliquid", { trade: { can: true, what: "perpetuals", kinds: ["perp"] } }), venue("ex", "Exchange", { trade: { can: true, what: "coins and perps", kinds: ["spot", "perp"] } })]));
    expect(p.out('[tkKindOf({ venue: "pr" }), tkKindOf({ venue: "hl" }), tkKindOf({ venue: "ex" }), tkKindOf({ venue: "pr", kind: "event" }), tkKindOf({ variant: "swap", venue: "pr" }), tkKindOf({})]')).toEqual(["predictions", "perps", "crypto", "predictions", "crypto", "crypto"]);
  });

  it("cancelOrder asks before an agent's order comes off the book, and takes the owner's own with one click", async () => {
    const p = page();
    p.run(OWNER);
    p.set("A", account([venue("ex", "Exchange")]));
    p.run('var ASKED = []; var OWNED = []; confirmSheet = async (text) => { ASKED.push(text); return false; }; own = async (d) => { OWNED.push(d); return { status: 200, body: { ok: true } }; }');
    await p.run<Promise<unknown>>('cancelOrder({ id: "ord-1", venue: "ex", venueName: "Exchange", authority: "owner" })');
    await p.run<Promise<unknown>>('cancelOrder({ id: "ord-2", venue: "ex", venueName: "Exchange", authority: "agent", agent: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })');
    expect(p.out("OWNED")).toEqual([{ type: "liveCancel", venue: "ex", order: "ord-1" }]);
    expect(p.out("ASKED")).toEqual(["Cancel Claude Code's order ord-2? It comes off Exchange's book; the agent is told through the account."]);
    // every single Cancel on the page goes through it
    for (const f of ["ui/asset.js", "ui/statement.js", "ui/trade.js"]) expect(source(f).split("\n").filter((l) => /data-cancel\]|asCancel\)/.test(l) && /addEventListener|return void/.test(l)).every((l) => l.includes("cancelOrder")), f).toBe(true);
  });

  it("own() treats { ok: false } and no answer as refusals: flash is set, nothing is said done", async () => {
    const p = page({ fetch: async () => ({ status: 200, statusText: "OK", ok: true, json: async () => ({ ok: false, error: "the venue said no" }) }) });
    p.run(OWNER);
    p.run("load = async () => {}");
    await p.run<Promise<unknown>>('own({ type: "setWatch", venue: "ex", symbol: "BTC/USDT", on: "true" })');
    expect(p.out("[flash, said]")).toEqual(["the venue said no", ""]);
    const q = page({ fetch: async () => { throw new TypeError("Failed to fetch"); } });
    q.run(OWNER);
    q.run("load = async () => {}");
    await q.run<Promise<unknown>>('own({ type: "setWatch", venue: "ex", symbol: "BTC/USDT", on: "true" })');
    expect(q.out("[flash, said]")).toEqual(["The account did not answer. Try again.", ""]);
  });
});

describe("fix round · the owner's words and the limit for them", () => {
  const AGENT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  it("htaDrafts names the words on the limit only when they have an id, never as an empty field", () => {
    const p = page();
    const withId = p.out<{ limit: Record<string, unknown> }>(`htaDrafts({ agent: "${AGENT}", text: "Buy a little SOL", days: "7", withLimit: true, budget: "100", perOrder: "25", intentId: "intent-0003" }, ${NOW})`);
    expect(withId.limit).toMatchObject({ type: "approveSpend", agent: AGENT, scope: "trade", allow: "*", perPayment: "25", budget: "100", intent: "intent-0003" });
    const without = p.out<{ limit: Record<string, unknown> }>(`htaDrafts({ agent: "${AGENT}", text: "Buy a little SOL", days: "7", withLimit: true, budget: "100", intentId: "" }, ${NOW})`);
    expect("intent" in without.limit).toBe(false);
  });

  it("htaLimitOf matches a limit by the intent it names first, then — for a limit from before limits named their words — by the same end", () => {
    const p = page();
    const until = "2026-10-13T17:00:00.000Z";
    p.set("A", account([], { spend: [{ id: "sp-1", agent: AGENT, scope: "trade", allow: ["ex"], validUntil: until, expired: false, intent: "intent-0002" }, { id: "sp-2", agent: AGENT, scope: "trade", allow: ["ex"], validUntil: until, expired: false }] }));
    expect(p.run(`htaLimitOf({ id: "intent-0002", agent: "${AGENT}", validUntil: "${until}" }).id`)).toBe("sp-1");
    expect(p.run(`htaLimitOf({ id: "intent-0009", agent: "${AGENT}", validUntil: "${until}" }).id`)).toBe("sp-2");
    expect(p.run(`htaLimitOf({ id: "intent-0009", agent: "${AGENT}", validUntil: "2026-10-14T17:00:00.000Z" })`)).toBeNull();
    expect(p.run(`htaLimitOf({ id: "intent-0009", agent: "*", validUntil: "${until}" })`)).toBeNull();
    // the id the account gave the words just signed, read back from the account by what the page itself sent
    const page2 = { intents: [{ id: "intent-0004", agent: AGENT, text: "Buy a little SOL", validUntil: until }, { id: "intent-0005", agent: AGENT, text: "Buy a little SOL", validUntil: until }] };
    expect(p.run(`htaIdOf(${JSON.stringify(page2)}, { agent: "${AGENT}", text: " Buy a little SOL ", validUntil: ${Date.parse(until)} })`)).toBe("intent-0005");
    expect(p.run(`htaIdOf(${JSON.stringify(page2)}, { agent: "*", text: "Buy a little SOL", validUntil: ${Date.parse(until)} })`)).toBe("");
  });

  it("the Agents sheet: Require both is not offered (every device signs alone), Revoke asks, a limit says the words it is for", () => {
    const src = source("ui/agents-mount.js");
    expect(src).not.toContain('data-both="1"');
    expect(src).toContain("Every device signs alone");
    expect(src).toMatch(/data-revoke.*confirmSheet/);
    expect(src).toContain("for ${esc(s.intent)}");
    expect(source("ui/intent.js")).toContain("for ${esc(lim.intent)}");
  });
});
