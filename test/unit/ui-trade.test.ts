/** The Trade pane's own logic (ui/trade.js) and the Hand-to-agent composer's (ui/intent.js), run as the page runs them — every page script in
 * account.html's order, in one global scope — over a stand-in for the browser: which tiles a set of venues gives, an order's draft from the
 * ticket's fields (an event contract's prices typed in cents), where a market is listed (yours ranked, yours that cannot with how to fix it,
 * public ones "Connect to trade"), how a swap goes at one venue, Sell many's legs, the owner's words and the limit for them. Then the same
 * drafts go through the real account's door on the stand-in account (test/standin): each is prepared, the owner's browser signs them, and the
 * account does what they say — a coin-for-coin swap in two signatures, the second sized by what the first sale brought. Nothing leaves the
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

/** the page's scripts in a stand-in browser: elements take listeners and report nothing; the device key never answers, so nothing is drawn */
function page() {
  const element = (): Record<string, unknown> => ({ addEventListener() {}, removeAttribute() {}, setAttribute() {}, querySelectorAll: () => [], querySelector: () => null, classList: { add() {}, remove() {}, toggle() {} }, dataset: {}, style: {}, hidden: false, value: "", textContent: "", innerHTML: "" });
  const sandbox: Record<string, unknown> = {
    document: { getElementById: element, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, body: element(), documentElement: { dataset: { theme: "cream" }, setAttribute() {} }, hidden: false, activeElement: null },
    location: { hash: "", origin: "http://127.0.0.1:4821" },
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
const EARNER = venue("mm", "MetaMask Agent Wallet", { trade: { can: true, what: "tokens", kinds: ["token", "event", "perp"] }, earn: { can: true, what: "DeFi vaults through mm" } });
const pageOf = (venues: unknown[], writes = true) => ({ now: "2026-10-06T12:00:00.000Z", venues, keys: [], spend: [], cards: [], orders: [], payments: [], intents: [], asks: [], connectLive: { writes: { on: writes, capUsd: 250 }, options: [] } });

describe("the Trade pane's logic, as the page runs it", () => {
  const p = page();

  it("draws a tile for each thing a connected venue really does; a tile whose venues all refuse says so in their words; none when the server is read-only", () => {
    p.set("A", pageOf([EX, PRED, WALLET]));
    const tiles = p.out<Array<{ id: string; sub: string; able: string[]; venues: string[] }>>("tkTilesFor(connected())");
    expect(tiles.map((t) => t.id)).toEqual(["trade", "swap", "perps", "predictions", "sellmany", "move"]);
    expect(tiles.find((t) => t.id === "trade")!.sub).toBe("Coins");
    expect(tiles.find((t) => t.id === "swap")!.sub).toBe("Tokens on-chain");
    expect(tiles.find((t) => t.id === "perps")).toMatchObject({ sub: "At Exchange", able: ["ex"] });
    expect(tiles.find((t) => t.id === "predictions")).toMatchObject({ sub: "Predictions", able: ["predict"] });
    // a key that may not trade: the tile is there, with the venue's own words, and nothing can be done from it
    p.set("A", pageOf([READONLY]));
    const ro = p.out<Array<{ id: string; sub: string; able: string[] }>>("tkTilesFor(connected())");
    expect(ro.find((t) => t.id === "trade")).toMatchObject({ able: [], sub: "OKX: this API key has no Trade permission" });
    // earn only where a venue earns
    p.set("A", pageOf([EARNER]));
    expect(p.out<Array<{ id: string }>>("tkTilesFor(connected())").map((t) => t.id)).toEqual(["trade", "swap", "perps", "predictions", "sellmany", "earn"]);
    p.set("A", pageOf([EX, PRED], false));
    expect(p.out("tkTilesFor(connected())")).toEqual([]);
  });

  it("drafts an order from the ticket: in dollars or in the market's units, an event contract's limit typed in cents, only the flags the type takes", () => {
    expect(p.out('tkOrderDraft({ amount: " 50 ", unit: "usd", orderType: "market" }, { venue: "ex", symbol: "BTC/USDT", side: "buy", event: false })')).toEqual({ type: "liveOrder", venue: "ex", symbol: "BTC/USDT", side: "buy", orderType: "market", usd: "50", limitPrice: "", stopPrice: "", tif: "", postOnly: "", reduceOnly: "" });
    expect(p.out('tkOrderDraft({ amount: "26", unit: "qty", orderType: "limit", limitPrice: "38", postOnly: "on", tif: "gtc" }, { venue: "predict", symbol: "SI-FEDCUT-DEC:NO", side: "buy", event: true })')).toMatchObject({ qty: "26", limitPrice: "0.38", postOnly: "true", tif: "gtc" });
    // a stop has no limit and is never post-only; reduce-only rides along where ticked
    expect(p.out('tkOrderDraft({ amount: "0.01", unit: "qty", orderType: "stop", limitPrice: "9", stopPrice: "60000", postOnly: "on", reduceOnly: "on" }, { venue: "ex", symbol: "BTC/USDT:USDT", side: "sell", event: false })')).toMatchObject({ limitPrice: "", stopPrice: "60000", postOnly: "", reduceOnly: "true" });
    expect(p.out('[tkPriceIn("62", true), tkPriceIn("62", false), tkPriceIn("", true), tkCents(0.625), tkCents(undefined)]')).toEqual(["0.62", "62", "", "62.5¢", "—"]);
  });

  it("lists where a market is: yours that trade it (best first), yours that cannot with what to change, and public venues to connect — not one already connected", () => {
    p.set("A", pageOf([EX, WALLET, READONLY]));
    const item = { kind: "coin", base: "BTC", at: [{ venue: "okx", venueName: "OKX", symbol: "BTC/USDT", connected: true, canTrade: false }, { venue: "kraken-public", venueName: "Kraken", symbol: "BTC/USD", connected: false, canTrade: false, public: true, price: 62000, connectTo: "kraken", connector: "live:exchange:kraken" }, { venue: "wallet", venueName: "Wallet", symbol: "cbBTC/USDC@Base", connected: true, canTrade: true, price: 62100 }] };
    const ranked = [{ venue: "ex", venueName: "Exchange", symbol: "BTC/USDT", price: 61990, best: true, open: true, canTrade: true, ready: true }, { venue: "wallet", venueName: "Wallet", symbol: "cbBTC/USDC@Base", price: 62100, worse: 0.18, open: true, canTrade: true, ready: true }];
    const rows = p.out<Array<Record<string, unknown>>>(`tkWhereRows(${JSON.stringify(item)}, ${JSON.stringify(ranked)})`);
    expect(rows.map((r) => [r.state, r.venue])).toEqual([["able", "ex"], ["able", "wallet"], ["off", "okx"], ["public", "kraken-public"]]);
    expect(rows[0]).toMatchObject({ best: true, price: 61990 });
    expect(rows[2]).toMatchObject({ why: "this API key has no Trade permission", how: expect.stringMatching(/Trade.*Then connect it again\./) });
    // the public listing of a venue the owner has since connected is not offered again
    p.set("A", pageOf([EX, venue("kraken", "Kraken", { trade: { can: true, kinds: ["spot"] } })]));
    expect(p.out<Array<{ state: string }>>(`tkWhereRows(${JSON.stringify(item)}, [])`).map((r) => r.state)).not.toContain("public");
    // Connect to trade opens the connection the row names, through connect.js's own door (connectVia); one this server does not offer says so
    p.set("A", { ...pageOf([EX]), connectLive: { writes: { on: true, capUsd: 250 }, options: [{ kind: "exchange", connector: "live:exchange", needs: "key-file", venues: ["kraken"] }, { kind: "kalshi", connector: "live:kalshi", needs: "key-file" }] } });
    p.run('Object.defineProperty(Owner, "role", { get: () => "owner", configurable: true }); var CONNECTED = []; openConnect = (o, opts) => CONNECTED.push([o.kind, opts.exchange, opts.name]); var TOASTS = []; toast = (t) => TOASTS.push(t)');
    p.run('tkConnectTo({ connector: "live:exchange:kraken", venueName: "Kraken" }); tkConnectTo({ connector: "live:kalshi", venueName: "Kalshi" }); tkConnectTo({ venueName: "Nowhere" })');
    expect(p.out("CONNECTED")).toEqual([["exchange", "kraken", "Kraken"], ["kalshi", "", "Kalshi"]]);
    expect(p.out("TOASTS")).toEqual(["Nowhere can't be connected from this server."]);
  });

  it("plans a swap at one venue: a stablecoin by the venue's convert, a dollar for a coin or back in one order, a coin for a coin in two through the dollar both share", () => {
    const markets = [{ symbol: "WETH/USDC@Base", kind: "token", base: "WETH", quote: "USDC", open: true }, { symbol: "cbBTC/USDC@Base", kind: "token", base: "cbBTC", quote: "USDC", open: true }, { symbol: "USDY/USDC@Ethereum", kind: "token", base: "USDY", quote: "USDC", open: true }, { symbol: "BTC/USDT", kind: "spot", base: "BTC", quote: "USDT", open: true }, { symbol: "SOL/USDT", kind: "spot", base: "SOL", quote: "USDT", open: true }];
    const plan = (o: Record<string, unknown>) => p.out<any>(`tkSwapPlan(${JSON.stringify({ markets, ...o })})`);
    expect(plan({ venue: "ex", from: "USDC", to: "USDT", amount: "50", stableSwap: true })).toMatchObject({ mode: "convert", legs: [{ type: "liveMove", kind: "swap", from: "ex", to: "ex", asset: "USDC", toAsset: "USDT", amount: "50", network: "" }] });
    expect(plan({ venue: "wallet", from: "USDC", to: "USDT", amount: "50", stableSwap: false })).toMatchObject({ mode: "", why: expect.stringMatching(/doesn't swap one stablecoin/) });
    expect(plan({ venue: "wallet", from: "USDC", to: "WETH", amount: "25", chain: "Base" }).legs).toEqual([{ type: "liveOrder", venue: "wallet", symbol: "WETH/USDC@Base", side: "buy", orderType: "market", usd: "25", limitPrice: "", stopPrice: "", tif: "", postOnly: "", reduceOnly: "" }]);
    expect(plan({ venue: "wallet", from: "WETH", to: "USDC", amount: "0.1", chain: "Base" }).legs[0]).toMatchObject({ symbol: "WETH/USDC@Base", side: "sell", qty: "0.1" });
    // a coin held on one chain is sold there, and only a coin listed against the same dollar on that chain can be bought with it
    expect(plan({ venue: "wallet", from: "WETH", to: "cbBTC", amount: "0.1", chain: "Base" })).toMatchObject({ mode: "two", via: "USDC", legs: [{ symbol: "WETH/USDC@Base", side: "sell", qty: "0.1" }, { symbol: "cbBTC/USDC@Base", side: "buy", usd: "" }] });
    expect(plan({ venue: "wallet", from: "WETH", to: "USDY", amount: "0.1", chain: "Base" })).toMatchObject({ mode: "", why: expect.stringMatching(/USDY isn't listed against USDC/) });
    expect(plan({ venue: "ex", from: "BTC", to: "SOL", amount: "0.001" })).toMatchObject({ mode: "two", via: "USDT" });
    expect(plan({ venue: "ex", from: "USDC", to: "BTC", amount: "10" })).toMatchObject({ mode: "", why: "BTC isn't listed against USDC here (it trades against USDT)." });
    expect(plan({ venue: "ex", from: "BTC", to: "BTC" }).why).toBe("Pick two different assets.");
    // what the sale brought, less its fee, down to the cent: what the second leg spends
    expect(p.out('tkProceeds({ filledQty: 0.001, avgPrice: 62523.2, feeUsd: 0.04 })')).toBe(62.48);
    expect(p.out('tkProceeds({ filledQty: 0, price: 10 })')).toBe(0);
  });

  it("drafts Sell many's legs: a market sell of what is held (or less), a position's close (all, or part)", () => {
    expect(p.out('tkSellDraft({ action: "sell", venue: "ex", symbol: "ETH/USDT", held: 1.8, sellQty: 1.8 }, "")')).toEqual({ type: "liveOrder", venue: "ex", symbol: "ETH/USDT", side: "sell", orderType: "market", qty: "1.8", limitPrice: "", stopPrice: "", tif: "", postOnly: "", reduceOnly: "" });
    expect(p.out('tkSellDraft({ action: "sell", venue: "ex", symbol: "ETH/USDT", held: 1.8, sellQty: 1.8 }, "0.01")')).toMatchObject({ qty: "0.01" });
    expect(p.out('tkSellDraft({ action: "close", venue: "ex", symbol: "ETH/USDT:USDT", held: 0.05, sellQty: 0.05 }, "0.05")')).toEqual({ type: "liveClose", venue: "ex", symbol: "ETH/USDT:USDT", qty: "" });
    expect(p.out('tkSellDraft({ action: "close", venue: "ex", symbol: "ETH/USDT:USDT", held: 0.05, sellQty: 0.05 }, "0.02")')).toMatchObject({ qty: "0.02" });
    expect(p.out('[tkLegName({ action: "close", side: "long", asset: "ETH" }), tkLegName({ action: "sell", asset: "SOL" })]')).toEqual(["Close long ETH", "SOL"]);
  });

  it("lists Earn's products — to put in, the ones taking money first; to take out, the ones something is in — and drafts money in or out in the product's own asset", () => {
    const view = { products: [{ venue: "okx", id: "savings:BTC", asset: "BTC", canSupply: false, why: "closed to new money" }, { venue: "okx", id: "savings:USDT", asset: "USDT", canSupply: true }, { venue: "mm", id: "8453:0xvault", asset: "USDC", canSupply: true }], positions: [{ venue: "mm", product: "8453:0xvault", asset: "mUSDC", amount: 12 }, { venue: "okx", product: "savings:USDT", asset: "USDT", amount: 0 }] };
    expect(p.out<Array<{ id: string }>>(`tkEarnList(${JSON.stringify(view)}, "supply")`).map((x) => x.id)).toEqual(["savings:USDT", "8453:0xvault", "savings:BTC"]);
    expect(p.out<Array<{ id: string }>>(`tkEarnList(${JSON.stringify(view)}, "withdraw")`).map((x) => x.id)).toEqual(["8453:0xvault"]);
    expect(p.out('tkEarnDraft({ venue: "mm", id: "8453:0xvault", asset: "USDC" }, "withdraw", " 5 ")')).toEqual({ type: "liveEarn", venue: "mm", kind: "withdraw", product: "8453:0xvault", asset: "USDC", amount: "5" });
    expect(p.out('tkEarnDraft({ venue: "okx", id: "savings:USDT", asset: "USDT" }, "anything", "10").kind')).toBe("supply");
    expect(p.out('[tkRate({ apy: 0.0534 }), tkRate({ apy: 0.02, apyHigh: 0.05, rateKind: "apr" }), tkRate({})]')).toEqual(["5.34% APY", "2.00%–5.00% APR", ""]);
  });

  it("drafts the owner's words to an agent and, when asked, its trading limit for them — exactly the fields the door signs", () => {
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
    for (const a of [d.intent, d.limit, p.out('tkSellDraft({ action: "close", venue: "ex", symbol: "X", held: 1, sellQty: 1 }, "")'), { type: "setIntent", id: "intent-0001", agent: "*", venue: "", symbol: "", side: "", usd: "", text: "", validUntil: 0 }]) expect(malformed({ ...a, nonce: now } as OwnerAction), a.type).toBeNull();
  });
});

describe("the ticket at rest leaves the page refreshing", () => {
  it("opens the resting ticket without taking the focus, and its search counts as the page's own (data-live), so a cursor in it does not stop the refresh", () => {
    const p = page();
    p.set("A", pageOf([EX]));
    // what the panel is asked to open, captured: at rest, after its close, and on purpose
    p.run("TK.mode = 'self'; ROUTE.tab = 'trade'; render = () => {}; OPENED = []; tkTicket = (panel, variant, preset) => OPENED.push(preset);");
    p.run("tkRest()");
    p.run("openTicket({})");
    expect(p.out("OPENED")).toEqual([{ rest: true }, {}]);
    // the shell keeps refreshing while focus is inside [data-live]: the ticket's search is marked so
    const src = readFileSync(join(PUBLIC, "ui/trade.js"), "utf8");
    expect(src).toContain('<div class="tk-find" data-find data-live>');
    expect(src).toContain("if (!preset.symbol && !preset.venue && !preset.rest) setTimeout(() => live() && form.elements.q.focus(");
    // its close puts the panel back at rest, and drops the ticket kept in this browser
    expect(src).toContain('b.addEventListener("click", () => {\n    tkDraftKeep(null);\n    tkOpen({ rest: true });');
  });
});

describe("closing a position, from whichever pane", () => {
  const POS = { venue: "ex", venueName: "Exchange", symbol: "BTC/USDT:USDT", name: "BTC perpetual", kind: "perp", side: "long", qty: 0.5, usd: 31000, markPrice: 62000, unrealizedUsd: 120 };
  const prep = (close?: Record<string, unknown>) => ({ action: { type: "liveClose", venue: "ex", symbol: "BTC/USDT:USDT", qty: "" }, quote: { words: "close", ...(close ? { close } : {}) } });

  it("says what the prepared close is worth at the worst price it may fill at, and refuses one over the cap before the sign button — with a part that fits one click away", () => {
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
    // inside the cap: nothing refused, the cap said
    const inside = prep({ worthUsd: 198.2, capUsd: 250, overCap: false, side: "sell", qty: 0.0032, worstPrice: 61500 });
    expect(p.run(`QD.block(${JSON.stringify(inside)})`)).toBe("");
    expect(p.run<string>(`QD.show(${JSON.stringify(inside)})`)).toContain("Up to $250.00 an order on this server.");
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

  it("is the one close every pane opens: the Portfolio's and the Asset drawer's go through it, and the sheet holds the sign button off while a refusal stands", () => {
    const src = (f: string) => readFileSync(join(PUBLIC, `ui/${f}`), "utf8");
    expect(src("portfolio.js")).toContain("if (p && typeof openClose === \"function\") openClose(p);");
    expect(src("asset.js")).toContain("if (p && typeof openClose === \"function\") openClose(p);");
    expect(src("trade.js")).toContain("b.addEventListener(\"click\", () => openClose(rows.find(");
    const core = src("core.js");
    expect(core).toContain("btn.disabled = !owns() || !!no;");
    expect(core).toContain("if (!prepared || busy || !stop.hidden) return;");
  });
});

describe("a ticket kept in this browser", () => {
  const DRAFT = { variant: "trade", venue: "ex", venueName: "Exchange", symbol: "BTC/USDT", side: "buy", kind: "coin", key: "coin:BTC", base: "BTC", name: "Bitcoin", amount: "25", unit: "usd", orderType: "limit", limitPrice: "60000" };
  const kept = () => {
    const p = page();
    p.set("A", pageOf([EX, PRED]));
    p.run("var STORE = {}; localStorage.getItem = (k) => (k in STORE ? STORE[k] : null); localStorage.setItem = (k, v) => { STORE[k] = String(v); }; localStorage.removeItem = (k) => { delete STORE[k]; }");
    p.run('var OPENED = []; tkOpen = (preset) => OPENED.push(preset); var ASKED = []; var MARKET = { ok: true, market: { symbol: "BTC/USDT", open: true } }; api = async (path) => { ASKED.push(path); return MARKET; }; TK.mode = "self"');
    return p;
  };
  const again = async (p: ReturnType<typeof page>) => {
    p.run("TK.draftLooked = false");
    await p.run("tkReopenDraft()");
  };

  it("opens again, at rest, while its venue is connected and still lists its market", async () => {
    const p = kept();
    p.run(`tkDraftKeep(${JSON.stringify(DRAFT)})`);
    expect(p.out("Object.keys(JSON.parse(STORE['account.ticket'])).sort()")).toEqual([...Object.keys(DRAFT), "at"].sort());
    await again(p);
    expect(p.out("ASKED")).toEqual(["/api/account/market?venue=ex&symbol=BTC%2FUSDT"]);
    expect(p.out("OPENED")).toEqual([{ ...DRAFT, rest: true }]);
    // looked at once a visit
    await p.run("tkReopenDraft()");
    expect(p.out("OPENED.length")).toBe(1);
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
    // not a ticket the page keeps
    expect(await dropped(`STORE['account.ticket'] = JSON.stringify({ ...${JSON.stringify(DRAFT)}, variant: "earn", at: Date.now() })`)).toEqual([0, false]);
    expect(await dropped("STORE['account.ticket'] = '{not json'")).toEqual([0, false]);
  });

  it("gives way to a ticket opened meanwhile, and is kept for later; storage that is off opens nothing and breaks nothing", async () => {
    const p = kept();
    p.run(`tkDraftKeep(${JSON.stringify(DRAFT)}); api = async (path) => { TK.gen++; return MARKET; }`);
    await again(p);
    expect([p.out("OPENED.length"), p.out("'account.ticket' in STORE")]).toEqual([0, true]);
    p.run("localStorage.getItem = () => { throw new Error('storage is off'); }; localStorage.removeItem = () => { throw new Error('storage is off'); }");
    await again(p);
    expect(p.out("OPENED.length")).toBe(0);
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

  it("gives the tiles the stand-in's venues really offer", async () => {
    const { body } = await get("/api/account");
    p.set("A", body);
    // Earn too, where a stand-in venue offers earn products
    const earns = body.venues.some((v: { live?: boolean; earn?: unknown }) => v.live && v.earn);
    expect(p.out<Array<{ id: string }>>("tkTilesFor(connected())").map((t) => t.id)).toEqual(["trade", "swap", "perps", "predictions", "sellmany", "move", ...(earns ? ["earn"] : [])]);
  });

  it("places the ticket's order — an event contract's limit typed in cents rests at the venue at that price", async () => {
    const draft = p.out<Record<string, unknown>>('tkOrderDraft({ amount: "10", unit: "usd", orderType: "limit", limitPrice: "30" }, { venue: "predict", symbol: "SI-FEDCUT-DEC:NO", side: "buy", event: true })');
    const r = await act(draft);
    expect(r.status).toBe(200);
    expect(r.body.order).toMatchObject({ venue: "predict", symbol: "SI-FEDCUT-DEC:NO", type: "limit", limitPrice: 0.3, status: "open" });
  });

  it("swaps a coin for a coin in two signatures: the sale, then the buy sized by what the sale brought", async () => {
    const markets = (await get("/api/account/markets?venue=ex&q=")).body.markets;
    const plan = p.out<any>(`tkSwapPlan(${JSON.stringify({ venue: "ex", from: "BTC", to: "SOL", amount: "0.001", markets, stableSwap: true })})`);
    expect(plan.mode).toBe("two");
    const sold = await act(plan.legs[0]);
    expect(sold.body.order).toMatchObject({ side: "sell", status: "filled" });
    const usd = p.out<number>(`tkProceeds(${JSON.stringify(sold.body.order)})`);
    expect(usd).toBeGreaterThan(50);
    const bought = await act({ ...plan.legs[1], usd: String(usd) });
    expect(bought.body.order).toMatchObject({ symbol: "SOL/USDT", side: "buy", status: "filled" });
    expect(bought.body.order.qty * bought.body.order.avgPrice).toBeLessThanOrEqual(usd + 0.01);
    // and a stablecoin for another, by the exchange's own convert
    const convert = p.out<any>(`tkSwapPlan(${JSON.stringify({ venue: "ex", from: "USDC", to: "USDT", amount: "20", markets, stableSwap: true })})`);
    expect((await act(convert.legs[0])).status).toBe(200);
  });

  it("sells many: each leg Sell many drafts is one signature — a spot sale and a perpetual's close", async () => {
    const { body } = await get("/api/account/sellable");
    const eth = body.items.find((x: { venue: string; asset: string; action: string }) => x.venue === "ex" && x.asset === "ETH" && x.action === "sell");
    const perp = body.items.find((x: { action: string; symbol: string }) => x.action === "close" && x.symbol === "ETH/USDT:USDT");
    expect((await act(p.out(`tkSellDraft(${JSON.stringify(eth)}, "0.01")`))).body.order).toMatchObject({ side: "sell", qty: 0.01 });
    expect((await act(p.out(`tkSellDraft(${JSON.stringify(perp)}, "")`))).body.order).toMatchObject({ symbol: "ETH/USDT:USDT", side: "sell" });
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
    // even in Aggressive the agent now places nothing: its authority ended with the words
    expect((await act({ type: "setPolicy", change: "mode", value: "open" })).status).toBe(200);
    const order = await s.svc.exchange(await signAgent(s.agent, { type: "agentLiveOrder", venue: "ex", symbol: "SOL/USDT", side: "buy", orderType: "market", qty: "", usd: "50", limitPrice: "", nonce: Date.now() } as AgentAction));
    expect((order as { code?: string }).code).toBe("E_MANDATE_NONE");
    // words that came with no limit withdraw alone
    expect(p.out(`htaWithdrawDrafts({ id: "intent-9", agent: "*", validUntil: "2026-10-09T00:00:00.000Z" }, ${now0}).length`)).toBe(1);
  });
});
