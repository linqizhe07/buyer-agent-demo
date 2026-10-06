import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createContext, runInContext, Script } from "node:vm";
import { describe, expect, it } from "vitest";

/** The Portfolio pane's own logic (ui/portfolio.js), the Asset drawer's (ui/asset.js) and Receive's (ui/money.js), run as the page runs them:
 * plain scripts in one global scope after ui/core.js, here in a vm with a stand-in document. What is checked is what the owner reads and
 * presses: the lens narrowing every list, today's change and the curve from the account's own numbers, the cards grouped by agent, every
 * agent string escaped, every button wired to an action, nothing that signs offered to a browser that cannot sign */
const UI = fileURLToPath(new URL("../../src/portfolio/public/ui/", import.meta.url));
const FILES = ["core.js", "money.js", "asset.js", "portfolio.js"];

function page() {
  const element = (): Record<string, unknown> => ({ addEventListener() {}, removeAttribute() {}, setAttribute() {}, querySelectorAll: () => [], querySelector: () => null, classList: { add() {}, remove() {}, toggle() {} }, dataset: {}, style: {}, hidden: false, innerHTML: "" });
  const sandbox: Record<string, unknown> = {
    document: { getElementById: element, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, body: element(), documentElement: { dataset: { theme: "cream" } } },
    location: { hash: "", origin: "http://127.0.0.1:4820" },
    Owner: { role: "owner", kid: "k1" },
    console,
    URLSearchParams,
    Intl,
    setTimeout,
    clearTimeout,
    fetch: () => new Promise(() => {}),
    /* a form's fields, as the drafts read them: { values } stands in for the form */
    FormData: class {
      constructor(private readonly f: { values?: Record<string, string> }) {}
      get(k: string) {
        return this.f.values?.[k] ?? null;
      }
      getAll(k: string) {
        const v = this.f.values?.[k];
        return v === undefined ? [] : [v];
      }
    },
  };
  const ctx = createContext(sandbox);
  for (const f of FILES) new Script(readFileSync(`${UI}${f}`, "utf8"), { filename: f }).runInContext(ctx);
  const run = <T = unknown>(code: string): T => runInContext(code, ctx) as T;
  return { run, set: (name: string, value: unknown) => run(`${name} = ${JSON.stringify(value)}`) };
}

const NOW = "2026-10-06T12:00:00.000Z";
const AGENT = "0x3a087530887bd175ccc38828ee3776e5b6ea1ac6";
const OTHER = "0x9999999999999999999999999999999999999999";
const venue = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, live: true, usd: 0, holdings: [], ...extra });
/** an account as /api/account says it, the way the stand-in account seeds one: an exchange that trades and moves money, a wallet that only
 * trades, a prediction market, and an agent's wallet */
const ACCOUNT = {
  now: NOW,
  liveUsd: 12000,
  inFlightUsd: 0,
  mode: "guard",
  connectLive: { writes: { on: true, capUsd: 250 }, options: [{ kind: "exchange", label: "Exchange account · API key", venues: ["okx", "kraken"] }, { kind: "standin-pubex", label: "Stand-in Public Exchange · spot (test harness)", venues: [] }] },
  dial: { sessionExpiresAt: "2026-11-05T00:00:00.000Z", sessionEnded: false, maxLeverage: 5 },
  venues: [
    venue("ex", "Exchange", { usd: 9000, trade: { can: true, what: "spot and perpetuals", positions: true }, liveCan: { withdraw: true, ledgers: ["spot", "futures"], transfer: true, swap: true, receive: true, send: false }, plugged: true }),
    venue("wallet", "Wallet", { usd: 2000, trade: { can: true, what: "tokens" }, liveCan: null, readOnlyBecause: "moves only at the venue", plugged: true }),
    venue("predict", "Predictions", { usd: 900, trade: { can: false, what: "event contracts", positions: true }, plugged: true }),
    venue("agent-claude-code", "Agent wallet · Claude Code", { usd: 100, address: "0x90cd4774dfc70d05260f7a2b7ac44a3dc021cf5b", proven: "this account holds its key", liveCan: { withdraw: false, ledgers: [], transfer: false, swap: false, receive: true, send: "account" }, plugged: true }),
  ],
  keys: [{ address: AGENT, name: "Claude Code", code: "CC", status: "ok", validUntil: "2026-11-05T00:00:00.000Z", approvedAt: NOW }],
  spend: [{ id: "spend-0001", agent: AGENT, scope: "trade", allow: ["ex"], perPaymentUsd: 150, budgetUsd: 600, spentUsd: 100, reservedUsd: 0, expired: false }],
  subAccounts: [{ id: "sub-1", name: "Claude Code", agent: AGENT, agentName: "Claude Code", address: "0x90cd4774dfc70d05260f7a2b7ac44a3dc021cf5b", capUsd: 100, balanceUsd: 0 }],
  cards: [
    { id: "card-0001", flight: "CC-0002", usd: 119.99, reason: "Claude Code asks to buy 0.0479 ETH at Exchange", hash: "0xabc", kind: "agentLiveOrder", agent: AGENT, agentName: "Claude Code", expiresAt: "2026-10-06T12:24:00.000Z", shown: [{ name: "venue", value: "ex" }, { name: "symbol", value: "ETH/USDT" }, { name: "nonce", value: "1" }] },
    { id: "card-0002", flight: "CC-0003", usd: 40, reason: "Claude Code asks to buy SOL <script>", hash: "0xdef", kind: "agentLiveOrder", agent: AGENT, agentName: "Claude Code", expiresAt: "2026-10-06T12:40:00.000Z", shown: [{ name: "venue", value: "wallet" }] },
    { id: "card-0003", flight: "XX-0001", usd: 10, reason: "Other asks", hash: "0x123", kind: "agentLiveOrder", agent: OTHER, agentName: "Other", expiresAt: "2026-10-06T13:00:00.000Z", shown: [{ name: "venue", value: "predict" }] },
  ],
  asks: [
    { id: "ask-0001", agent: AGENT, agentName: "Claude Code", kind: "limit", venue: "ex", usd: "1000", text: "Raise my budget <img src=x onerror=alert(1)>", at: NOW, expiresAt: "2026-10-07T12:00:00.000Z" },
    { id: "ask-0002", agent: AGENT, agentName: "Claude Code", kind: "venue", venue: "standin-pubex", usd: "", text: "Connect it", at: NOW, expiresAt: "2026-10-07T12:00:00.000Z" },
  ],
  requests: [],
  intents: [{ id: "intent-1", agent: AGENT, venue: "ex", symbol: "SOL/USDT", text: "Build SOL", byAgent: [{ status: "taking", note: "Placed a limit", by: AGENT, byName: "Claude Code", at: "2026-10-06T11:00:00.000Z" }] }],
  health: {},
};
/** what GET /api/account/holdings?cost=1 says of it */
const HOLD = {
  ok: true,
  rows: [
    { key: "crypto:BTC", asset: "BTC", class: "crypto", amount: 0.1, usd: 6000, price: 60000, changePct24h: 2, venues: [{ venue: "ex", venueName: "Exchange", amount: 0.09, usd: 5400 }, { venue: "wallet", venueName: "Wallet", amount: 0.01, usd: 600 }] },
    { key: "stable:USDC", asset: "USDC", class: "stable", amount: 3000, usd: 3000, price: 0.99999876, venues: [{ venue: "ex", venueName: "Exchange", amount: 2900, usd: 2900 }, { venue: "agent-claude-code", venueName: "Agent wallet · Claude Code", amount: 100, usd: 100 }] },
    { key: "rwa:USDY", asset: "USDY", class: "rwa", amount: 1000, usd: 1100, price: 1.1, venues: [{ venue: "wallet", venueName: "Wallet", amount: 1000, usd: 1100 }] },
    { key: "event:FED:YES", asset: "FED:YES", class: "event", amount: 50, usd: 31, price: 0.62, venues: [{ venue: "predict", venueName: "Predictions", amount: 50, usd: 31 }] },
  ],
  money: { readyUsd: 3000, venues: [{ venue: "ex", venueName: "Exchange", usd: 2900, lines: [{ asset: "USDC", usd: 2900 }], tradesHere: true, movesOut: true }, { venue: "agent-claude-code", venueName: "Agent wallet · Claude Code", usd: 100, lines: [{ asset: "USDC", usd: 100 }], tradesHere: false, movesOut: true }] },
  change24h: { usd: 117.65, pct: 0.97, coveredUsd: 9000, ofUsd: 10131, missing: ["rwa:USDY", "event:FED:YES"] },
  missing: [],
  positions: [{ symbol: "FED:YES", name: "Will the Fed cut? · Yes", kind: "event", side: "long", qty: 50, venue: "predict", venueName: "Predictions" }],
  cost: [
    { key: "crypto:BTC", asset: "BTC", class: "crypto", coveredQty: 0.04, ofQty: 0.1, costUsd: 2200, avgCostUsd: 55000, unrealizedUsd: 200, realizedUsd: 0, source: "account orders", words: "cost known for 0.04 of 0.1 BTC", parts: [], orders: 2 },
    { key: "event:FED:YES", asset: "FED:YES", class: "event", coveredQty: 50, ofQty: 50, costUsd: 31.5, avgCostUsd: 0.63, unrealizedUsd: -0.5, realizedUsd: 0, source: "venue", words: "cost known for 50 of 50 FED:YES", parts: [], orders: 1 },
  ],
};

function account(over: Record<string, unknown> = {}) {
  const p = page();
  p.set("A", { ...ACCOUNT, ...over });
  p.set("PF.hold", HOLD);
  return p;
}

describe("the Portfolio pane", () => {
  it("narrows every list to the lens: one venue's lines, or one agent's wallets, added up again", () => {
    const p = account();
    const keys = (code: string) => p.run<Array<{ key: string; usd: number; amount: number }>>(code).map((r) => `${r.key}=${r.usd}`);
    expect(keys('pfRowsIn(PF.hold.rows, pfVenueIn({ kind: "all", id: "" }))')).toEqual(["crypto:BTC=6000", "stable:USDC=3000", "rwa:USDY=1100", "event:FED:YES=31"]);
    // one venue: BTC is only the exchange's 0.09, and the wallet's USDY is gone
    expect(keys('pfRowsIn(PF.hold.rows, pfVenueIn({ kind: "venue", id: "ex" }))')).toEqual(["crypto:BTC=5400", "stable:USDC=2900"]);
    expect(p.run('pfRowsIn(PF.hold.rows, pfVenueIn({ kind: "venue", id: "ex" }))[0].amount')).toBe(0.09);
    // one agent: what its own wallet holds
    expect(keys(`pfRowsIn(PF.hold.rows, pfVenueIn({ kind: "agent", id: "${AGENT.toUpperCase().replace("0X", "0x")}" }))`)).toEqual(["stable:USDC=100"]);
    // the cards and asks: an agent's own, or the ones about a venue
    expect(p.run(`A.cards.filter((c) => pfAboutIn(c.agent, pfCardVenue(c), { kind: "agent", id: "${AGENT}" })).map((c) => c.id)`)).toEqual(["card-0001", "card-0002"]);
    expect(p.run('A.cards.filter((c) => pfAboutIn(c.agent, pfCardVenue(c), { kind: "venue", id: "wallet" })).map((c) => c.id)')).toEqual(["card-0002"]);
  });

  it("says today's change from each row's own 24 hours: dollars count one for one, a row no venue spoke for is left out and named", () => {
    const p = account();
    const day = p.run<{ usd: number; pct: number; coveredUsd: number; ofUsd: number; missing: string[] }>("pfDayChange(PF.hold.rows)");
    // BTC: $6,000 now, up 2%: it was 6000 / 1.02 = 5882.35 → +117.65; USDC counts at par; USDY and the event say nothing
    expect(day.usd).toBe(117.65);
    expect(day.coveredUsd).toBe(9000);
    expect(day.ofUsd).toBe(10131);
    expect(day.missing).toEqual(["rwa:USDY", "event:FED:YES"]);
    expect(day.pct).toBe(Number(((117.65 / (5882.35 + 3000)) * 100).toFixed(2)));
    expect(p.run("pfDayChange([]).pct")).toBeUndefined();
  });

  it("splits the ready dollars as the account does: what moves between your accounts and what stays add up to what is ready", () => {
    const p = account();
    expect(p.run('pfCash(PF.hold.money, pfVenueIn({ kind: "all", id: "" }))')).toMatchObject({ ready: 3000, canMove: 3000, stays: 0, trades: 2900 });
    expect(p.run(`pfCash(PF.hold.money, pfVenueIn({ kind: "agent", id: "${AGENT}" }))`)).toMatchObject({ ready: 100, canMove: 100, stays: 0, trades: 0 });
    expect(p.run('pfAlloc(PF.hold.rows).map((x) => `${x.cls} ${x.pct}`)')).toEqual(["crypto 59.2", "stable 29.6", "rwa 10.9", "event 0.3"]);
  });

  it("draws the curve only from two points on, scaled to its box, and says how far back it goes", () => {
    const p = account();
    expect(p.run('pfCurve([{ at: "2026-10-06T00:00:00Z", usd: 10 }])')).toBeNull();
    const c = p.run<{ line: string; area: string; pts: number[][] }>('pfCurve([{ at: "2026-10-06T00:00:00Z", usd: 100 }, { at: "2026-10-06T01:00:00Z", usd: 200 }, { at: "2026-10-06T02:00:00Z", usd: 150 }], 600, 140)');
    expect(c.pts.map((x) => x[0])).toEqual([0, 300, 600]);
    // the highest point near the top, the lowest near the bottom, a tenth of the span spare at each end
    expect(c.pts[1]![1]).toBeCloseTo(140 / 12, 0);
    expect(c.pts[0]![1]).toBeCloseTo(140 - 140 / 12, 0);
    expect(c.line.startsWith("M0,")).toBe(true);
    expect(c.area.endsWith("L600,140L0,140Z")).toBe(true);
    // short of two points: when the first was taken; a range that starts before the first point says "since"
    p.set("PF.range", "1m");
    expect(p.run('pfCurveHtml({ range: "1m", from: "2026-09-06T00:00:00Z", first: "2026-10-06T11:00:00Z", points: [{ at: "2026-10-06T11:00:00Z", usd: 1 }], events: [], changeUsd: 0 })')).toContain("the first was taken");
    const h = String(p.run('pfCurveHtml({ range: "1m", from: "2026-09-06T00:00:00Z", first: "2026-09-29T04:00:00Z", points: [{ at: "2026-09-29T04:00:00Z", usd: 100 }, { at: "2026-10-06T04:00:00Z", usd: 110 }], events: [], changeUsd: 10, changePct: 10 })'));
    expect(h).toContain("since Tue 29 Sept");
    expect(h).toContain('role="img"');
    expect(h).toContain("▲");
  });

  it("groups what waits by agent, with Approve all for an agent with more than one card, and escapes every word an agent wrote", () => {
    const p = account();
    const groups = p.run<Array<{ name: string; cards: unknown[]; asks: unknown[] }>>("pfGroups(A.cards, A.asks)");
    expect(groups.map((g) => [g.name, g.cards.length, g.asks.length])).toEqual([["Claude Code", 2, 2], ["Other", 1, 0]]);
    const html = String(p.run('pfWaitingHtml({ kind: "all", id: "" }, true)'));
    expect(html).toContain("Waiting for you · 5");
    expect(html).toContain('data-pf-act="approve-all"');
    expect(html.match(/data-pf-act="approve-all"/g)).toHaveLength(1);
    expect(html.match(/data-pf-act="approve"/g)).toHaveLength(3);
    expect(html.match(/data-pf-act="grant"/g)).toHaveLength(2);
    // an agent's words are text, never markup
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    // what the card asks, without its nonce; a venue not connected by its connection's name
    expect(html).toContain("venue: ex\nsymbol: ETH/USDT");
    expect(html).not.toContain("nonce: 1");
    expect(html).toContain("at Stand-in Public Exchange");
    expect(html).toContain("answer in 24 mins");
    // a browser that cannot sign sees them, and can press none
    const look = String(p.run('pfWaitingHtml({ kind: "all", id: "" }, false)'));
    expect(look.match(/data-pf-act="(approve|reject|grant|approve-all)"[^>]*disabled/g)).toHaveLength(3 + 3 + 2 + 1);
    // nothing waits: no section at all
    p.run("A.cards = []; A.asks = []");
    expect(p.run('pfWaitingHtml({ kind: "all", id: "" }, true)')).toBe("");
  });

  it("offers Grant only where the account has the form for it", () => {
    const p = account();
    const g = (kind: string) => p.run(`pfGrantable({ kind: "${kind}", agent: "${AGENT}", venue: "ex", usd: "" })`);
    expect(["limit", "venue", "topup", "session", "leverage", "mode", "letIn"].map(g)).toEqual([true, true, true, true, true, true, true]);
    p.run('A.mode = "open"');
    expect(g("mode")).toBe(false);
    // started read-only: a limit, a top-up, a session or leverage would place or move nothing
    p.run("A.connectLive.writes.on = false");
    expect(["limit", "topup", "session", "leverage", "venue"].map(g)).toEqual([false, false, false, false, true]);
  });

  it("tells what the agents did, newest first: done ✓, waiting ▣, refused ✗, reported ›", () => {
    const p = account();
    const items = p.run<Array<{ mark: string; text: string; at: string }>>(`pfActivity({
      agents: [{ address: "${AGENT}", name: "Claude Code", flights: [{ no: "CC-0002", at: "2026-10-06T11:30:00.000Z", request: "buy ETH", legs: ["▣ waits"] }, { no: "CC-0009", at: "2026-10-06T11:45:00.000Z", request: "move $900 to a new address", legs: ["✗ not one of your places"] }] }],
      lines: [{ agent: "${AGENT}", agentName: "Claude Code", by: "Claude Code, inside its limit", description: "Buy 0.002 BTC", status: "filled", at: "2026-10-06T10:00:00.000Z", account: "ex", accountName: "Exchange" }, { description: "your own", status: "filled", at: "2026-10-06T11:59:00.000Z" }],
      intents: A.intents,
      cards: [A.cards[0]],
    })`);
    expect(items.map((x) => `${x.mark} ${x.text}`)).toEqual(["✗ move $900 to a new address", "▣ Claude Code asks to buy 0.0479 ETH at Exchange", "› Placed a limit", "✓ Buy 0.002 BTC"]);
  });

  it("ticks the three first steps from the account, and shows them until they are done", () => {
    const p = account();
    expect(p.run("pfSteps(A).map((s) => s.done)")).toEqual([true, true, true]);
    expect(p.run("pfStepsHtml(true, false)")).toBe("");
    p.run("A.spend = []");
    expect(p.run("pfSteps(A).map((s) => s.done)")).toEqual([true, true, false]);
    expect(String(p.run("pfStepsHtml(true, false)"))).toContain("Next steps · 2 of 3");
    p.run("A.venues = []; A.keys = []");
    const fresh = String(p.run("pfStepsHtml(true, true)"));
    expect(fresh).toContain("Get started · 0 of 3");
    expect(fresh).toContain('data-pf-act="connect"');
    expect(fresh).toContain('data-pf-act="setup"');
    // a limit needs an agent and an account that trades first
    expect(fresh).toMatch(/data-pf-act="limit"[^>]*disabled/);
  });

  it("lists assets with where they are, their own 24 hours and what they cost; an event by its question, a dollar to the cent", () => {
    const p = account();
    const html = String(p.run('pfAssetsHtml({ kind: "all", id: "" }, PF.hold.rows)'));
    expect(html).toContain("Will the Fed cut? · Yes");
    expect(html).toContain("62¢");
    expect(html).toContain("Exchange · Wallet");
    expect(html).toContain('data-pf-act="asset" data-key="crypto:BTC"');
    // USDC at $0.99999876 reads $1.00
    expect(html).toContain("<td class=\"r\">$1.00</td>");
    // BTC: up $200 on what the account bought, for 0.04 of the 0.1 held
    expect(html).toContain("for 0.04 of 0.1");
    expect(String(p.run("pfCostWords(PF.hold.rows)"))).toContain("Cost known for 1 of 3 · part of 1 more");
  });

  it("offers a close, a trade, a move and a disconnect only where the account can do them", () => {
    const p = account();
    p.set("PF.pos", { positions: [{ symbol: "BTC/USDT:USDT", name: "BTC perpetual", kind: "perp", side: "long", qty: 0.01, usd: 600, venue: "ex", venueName: "Exchange" }, { symbol: "FED:YES", name: "Fed · Yes", kind: "event", side: "long", qty: 50, venue: "predict", venueName: "Predictions" }], missing: [{ venue: "wallet", venueName: "Wallet", why: "Wallet: this region is not served <b>" }] });
    const pos = String(p.run('pfPositionsHtml({ kind: "all", id: "" }, pfVenueIn({ kind: "all", id: "" }), true)'));
    // the exchange trades and lists positions: Close; the prediction market's key may not trade: none
    expect(pos.match(/data-pf-act="close"/g)).toHaveLength(1);
    expect(pos).toContain('data-venue="ex" data-symbol="BTC/USDT:USDT"');
    // a venue that refused says so in its own words, escaped
    expect(pos).toContain("Wallet: this region is not served &lt;b&gt;");
    const acc = String(p.run('pfAccountsHtml(pfVenueIn({ kind: "all", id: "" }), true)'));
    expect(acc.match(/data-pf-act="acct-move"/g)).toHaveLength(2);
    expect(acc.match(/data-pf-act="acct-off"/g)).toHaveLength(4);
    // Trade… needs the ticket: on this page alone (no trade.js) there is none to open, so none is offered
    expect(acc).not.toContain('data-pf-act="acct-trade"');
    p.run("globalThis.openTicket = () => {}");
    expect(String(p.run('pfAccountsHtml(pfVenueIn({ kind: "all", id: "" }), true)')).match(/data-pf-act="acct-trade"/g)).toHaveLength(2);
    const quick = String(p.run('pfQuickHtml({ kind: "all", id: "" }, pfVenueIn({ kind: "all", id: "" }), true)'));
    expect(quick).toContain('data-pf-act="trade"');
    expect(quick).toContain('data-pf-act="move"');
    expect(quick).toContain('data-pf-act="receive"');
    // read-only server: nothing trades or moves, the addresses still receive
    p.run("A.connectLive.writes.on = false");
    const ro = String(p.run('pfQuickHtml({ kind: "all", id: "" }, pfVenueIn({ kind: "all", id: "" }), true)'));
    expect(ro).not.toContain('data-pf-act="trade"');
    expect(ro).not.toContain('data-pf-act="move"');
    expect(ro).toContain('data-pf-act="receive"');
  });

  it("shows the net worth of what the lens shows, and the curve only for all accounts together", () => {
    const p = account();
    p.set("PF.hist", {});
    p.run('PF.hist = new Map([["1w", { range: "1w", from: "2026-09-29T12:00:00Z", first: "2026-09-20T00:00:00Z", points: [{ at: "2026-09-29T12:00:00Z", usd: 11000 }, { at: "2026-10-06T12:00:00Z", usd: 12000 }], events: [], changeUsd: 1000, changePct: 9.09 }]])');
    const all = String(p.run('pfWorthHtml({ kind: "all", id: "", name: "All accounts" }, pfVenueIn({ kind: "all", id: "" }), PF.hold.rows)'));
    expect(all).toContain("$12,000.00");
    expect(all).toContain("$117.65");
    expect(all).toContain("on $9,000.00 of $10,131.00");
    expect(all).toContain("data-pf-curve");
    expect(all).toContain("past week");
    const one = String(p.run('pfWorthHtml({ kind: "venue", id: "ex", name: "Exchange" }, pfVenueIn({ kind: "venue", id: "ex" }), pfRowsIn(PF.hold.rows, pfVenueIn({ kind: "venue", id: "ex" })))'));
    expect(one).toContain("Net worth · Exchange");
    expect(one).toContain("$9,000.00");
    expect(one).not.toContain("data-pf-curve");
    expect(one).toContain('data-pf-act="all"');
  });

  it("lists what is in the venues' earn products, each with its way out where the venue lets money out", () => {
    const p = account();
    p.run('A.venues[0].earn = { can: true, what: "Simple Earn Flexible" }');
    p.set("PF.earn", { positions: [{ venue: "ex", venueName: "Exchange", product: "savings:USDT", id: "p1", asset: "USDT", amount: 120, usd: 120, apy: 0.052, name: "USDT Flexible" }, { venue: "ex", venueName: "Exchange", product: "locked:ETH", id: "p2", asset: "ETH", amount: 1, name: "ETH 30 days" }], products: [{ venue: "ex", id: "savings:USDT", asset: "USDT", canWithdraw: true }, { venue: "ex", id: "locked:ETH", asset: "ETH", canWithdraw: false }], missing: [] });
    const html = String(p.run('pfEarnHtml(pfVenueIn({ kind: "all", id: "" }), true)'));
    expect(html).toContain("USDT Flexible");
    expect(html).toContain("5.2%");
    expect(html.match(/data-pf-act="earn-out"/g)).toHaveLength(1);
    expect(html).toContain('data-venue="ex" data-product="savings:USDT"');
    // no venue earns: no section
    p.run("delete A.venues[0].earn");
    expect(p.run('pfEarnHtml(pfVenueIn({ kind: "all", id: "" }), true)')).toBe("");
  });

  it("wires every button it draws to something it does", () => {
    const src = readFileSync(`${UI}portfolio.js`, "utf8");
    const drawn = new Set([...src.matchAll(/pfBtn\("([a-z-]+)"/g), ...src.matchAll(/data-pf-act="([a-z-]+)"/g)].map((m) => m[1]));
    const handled = new Set([...src.slice(src.indexOf("async function pfAct(")).matchAll(/case "([a-z-]+)":/g)].map((m) => m[1]));
    expect([...drawn].filter((a) => !handled.has(a))).toEqual([]);
    expect(drawn.size).toBeGreaterThan(15);
  });
});

describe("answering an agent's ask", () => {
  it("offers Decline… on every ask — beside Grant… where the account has the form for it — in place of when the ask lapses", () => {
    const p = account();
    const html = String(p.run('pfWaitingHtml({ kind: "all", id: "" }, true)'));
    expect(html.match(/data-pf-act="decline"/g)).toHaveLength(2);
    expect(html).toContain('data-pf-act="decline" data-ask="ask-0001"');
    expect(html).toContain('data-pf-act="decline" data-ask="ask-0002"');
    expect(html).not.toContain("until ");
    // an ask nothing here can grant still has its Decline, and says why it can't be granted
    p.run('A.mode = "open"; A.asks.push({ id: "ask-0003", agent: A.keys[0].address, agentName: "Claude Code", kind: "mode", text: "Let me trade without asking", at: A.now, expiresAt: A.now })');
    const more = String(p.run('pfWaitingHtml({ kind: "all", id: "" }, true)'));
    expect(more).toContain('data-pf-act="decline" data-ask="ask-0003"');
    expect(more).toContain("Already Aggressive.");
    expect(more.match(/data-pf-act="grant"/g)).toHaveLength(2);
    // a browser that only looks sees Decline, and can't press it
    const look = String(p.run('pfWaitingHtml({ kind: "all", id: "" }, false)'));
    expect(look.match(/data-pf-act="decline"[^>]*disabled/g)).toHaveLength(3);
  });

  it("asks first, then signs the owner's answerAsk — a no signs nothing, and a browser that only looks signs nothing", async () => {
    const p = account();
    p.run("var DRAFTS = []; own = async (d) => { DRAFTS.push(d); return { status: 200, body: {} }; }; var ANSWER = false; var ASKED = ''; confirmSheet = async (t, o) => { ASKED = [t, o.title, o.yes].join(' | '); return ANSWER; }");
    await p.run("declineAsk(A.asks[0])");
    expect(p.run("DRAFTS.length")).toBe(0);
    // the agent's words go to the question as text (confirmSheet escapes what it shows)
    expect(p.run("ASKED")).toBe("Decline Claude Code's ask: “Raise my budget <img src=x onerror=alert(1)>”? It is told no. Nothing on the account changes. | Decline the ask | Decline");
    p.run("ANSWER = true");
    await p.run("declineAsk(A.asks[0])");
    expect(p.run("JSON.stringify(DRAFTS)")).toBe(JSON.stringify([{ type: "answerAsk", ask: "ask-0001", decision: "decline" }]));
    // the pane's own button reaches the same door
    p.run('pfAct("decline", { ask: "ask-0002" })');
    await new Promise((r) => setTimeout(r, 0));
    expect(p.run("DRAFTS.map((d) => d.ask).join()")).toBe("ask-0001,ask-0002");
    p.run('Owner.role = "pending"; DRAFTS = []');
    await p.run("declineAsk(A.asks[0])");
    expect(p.run("DRAFTS.length")).toBe(0);
  });
});

describe("money in earn products, under Assets", () => {
  /* as GET /api/account/holdings gives it: one row a product, `earn:<venue>:<product>`, the product on the row */
  const EARN_ROW = { key: "earn:ex:savings:USDT", asset: "USDT", class: "earn", amount: 120, usd: 120, price: 1, venues: [{ venue: "ex", venueName: "Exchange", amount: 120, usd: 120 }], earn: { venue: "ex", venueName: "Exchange", product: "savings:USDT", asset: "USDT", name: "USDT Flexible", apy: 0.052 } };

  it("shows an Earning row with where it earns, a dollar to the cent, counted at par today, with Withdraw… where the venue lets money out", () => {
    const p = account();
    p.run('A.venues[0].earn = { can: true, what: "Simple Earn Flexible" }');
    p.run(`PF.hold.rows.push(${JSON.stringify(EARN_ROW)})`);
    const html = String(p.run('pfAssetsHtml({ kind: "all", id: "" }, PF.hold.rows)'));
    expect(html).toContain("USDT · earning");
    expect(html).toContain("Exchange · USDT Flexible · 5.2% a year");
    expect(html).toContain('data-pf-act="earn-row-out" data-key="earn:ex:savings:USDT"');
    // it is not an asset drawer's row: the Withdraw is its one action
    expect(html).not.toContain('data-pf-act="asset" data-key="earn:ex:savings:USDT"');
    expect(html).toContain('<tr class="pf-earn-row">');
    // on the allocation bar as its own slice; today it counts at par, like the dollars it is
    expect(p.run('pfAlloc(PF.hold.rows).map((x) => x.cls)')).toContain("earn");
    expect(p.run("CLASS.earn[0]")).toBe("Earning");
    expect(p.run("pfDayChange(PF.hold.rows).missing")).toEqual(["rwa:USDY", "event:FED:YES"]);
    // a key that can't take money out, or a server started read-only: no Withdraw
    p.run("A.venues[0].earn.can = false");
    expect(String(p.run('pfAssetsHtml({ kind: "all", id: "" }, PF.hold.rows)'))).not.toContain("earn-row-out");
    p.run("A.venues[0].earn.can = true; A.connectLive.writes.on = false");
    expect(String(p.run('pfAssetsHtml({ kind: "all", id: "" }, PF.hold.rows)'))).not.toContain("earn-row-out");
    // its way out sits under its name: the table keeps its six columns
    p.run("A.connectLive.writes.on = true");
    expect(String(p.run('pfAssetsHtml({ kind: "all", id: "" }, PF.hold.rows)')).match(/<th /g)).toHaveLength(6);
  });

  it("withdraws with the owner's signed liveEarn, from the product the row names or the one the venue lists for that asset", async () => {
    const p = account();
    p.run('A.venues[0].earn = { can: true, what: "Simple Earn Flexible" }');
    p.run(`PF.hold.rows.push(${JSON.stringify(EARN_ROW)})`);
    p.run("var QD = null; quoteDialog = (o) => { QD = o; return { form: { addEventListener() {} } }; }");
    await p.run('pfEarnRowOut("earn:ex:savings:USDT")');
    expect(p.run("QD.title")).toBe("Withdraw from earn");
    expect(p.run("QD.sub")).toBe("USDT Flexible at Exchange: 120 USDT in it.");
    expect(p.run('JSON.stringify(QD.draft({ values: { amount: "50" } }))')).toBe(JSON.stringify({ type: "liveEarn", venue: "ex", kind: "withdraw", product: "savings:USDT", asset: "USDT", amount: "50" }));
    expect(p.run('QD.draft({ values: { amount: "" } })')).toBe("How much to take out.");
    // a row that names no product (an account from before rows carried it): the one /earn lists at that venue for that asset
    p.set("PF.earn", { positions: [{ venue: "ex", venueName: "Exchange", product: "savings:USDT", asset: "USDT", amount: 120, name: "USDT Flexible" }, { venue: "ex", venueName: "Exchange", product: "locked:ETH", asset: "ETH", amount: 1, name: "ETH 30 days" }], products: [], missing: [] });
    expect(p.run('JSON.stringify(pfEarnLines({ asset: "USDT", venues: [{ venue: "ex", venueName: "Exchange", amount: 120 }] }))')).toBe(JSON.stringify([{ venue: "ex", venueName: "Exchange", product: "savings:USDT", name: "USDT Flexible", asset: "USDT", amount: 120 }]));
    // two products with it: the owner picks one
    p.run('PF.earn.positions.push({ venue: "ex", venueName: "Exchange", product: "fixed:USDT", asset: "USDT", amount: 30, name: "USDT 7 days" }); var PICKED = null; pickSheet = async (t, opts) => { PICKED = [t, opts.map((o) => o[1])]; return 1; }');
    p.run('PF.hold.rows[PF.hold.rows.length - 1] = { ...PF.hold.rows[PF.hold.rows.length - 1], earn: undefined, venues: [{ venue: "ex", venueName: "Exchange", amount: 150, usd: 150 }] }');
    await p.run('pfEarnRowOut("earn:ex:savings:USDT")');
    expect(p.run("JSON.stringify(PICKED)")).toBe(JSON.stringify(["Withdraw USDT from", ["USDT Flexible · Exchange", "USDT 7 days · Exchange"]]));
    expect(p.run('QD.draft({ values: { amount: "30" } }).product')).toBe("fixed:USDT");
  });
});

describe("the Asset drawer and Receive", () => {
  it("draws candles hollow when up and filled when down, the last ninety-six at most", () => {
    const p = page();
    const bars = Array.from({ length: 120 }, (_, i) => ({ t: 1_790_000_000_000 + i * 3_600_000, o: 100 + i, h: 102 + i, l: 99 + i, c: i % 2 ? 101 + i : 99.5 + i }));
    const c = p.run<{ svg: string; bars: unknown[]; hi: number; lo: number }>(`assetCandles(${JSON.stringify(bars)})`);
    expect(c.bars).toHaveLength(96);
    expect(c.svg.match(/<rect /g)).toHaveLength(96);
    expect(c.svg).toContain('class="c-up"');
    expect(c.svg).toContain('class="c-down"');
    expect(c.hi).toBe(102 + 119);
    expect(p.run("assetCandles([{ t: 1, o: 1, h: 1, l: 1, c: 1 }])")).toBeNull();
  });

  it("buys where the best price is ready and sells where the most is held, only at a venue that trades", () => {
    const p = account();
    const d = { row: { asset: "BTC", venues: [{ venue: "ex", amount: 0.09 }, { venue: "wallet", amount: 0.01 }] }, compare: { rows: [{ venue: "wallet", symbol: "WBTC/USDC@Base", kind: "token", open: true, canTrade: true }, { venue: "ex", symbol: "BTC/USDT", kind: "spot", open: true, canTrade: true }], missing: [] }, positions: [] };
    expect(p.run(`assetTargets("crypto:BTC", ${JSON.stringify(d)})`)).toEqual({ buy: { venue: "wallet", symbol: "WBTC/USDC@Base", kind: "token" }, sell: { venue: "ex", symbol: "BTC/USDT", kind: "spot" } });
    // the prediction market's key may not trade: an event held there can't be bought or sold from here
    expect(p.run('assetTargets("event:FED:YES", { row: { asset: "FED:YES", venues: [{ venue: "predict", amount: 50 }] }, positions: [] })')).toEqual({ buy: null, sell: null });
    expect(p.run('assetTitle("event:FED:YES", { positions: [{ kind: "event", name: "Fed · Yes" }] })')).toBe("Fed · Yes");
    expect(p.run('assetPx("event", 0.625)')).toBe("62.5¢");
  });

  it("gives an address only where an account can receive one: a proven wallet, or a venue whose key reads deposit addresses", () => {
    const p = account();
    expect(p.run("A.venues.filter(canReceive).map((v) => v.id)")).toEqual(["ex", "agent-claude-code"]);
    // a watched address gives none
    expect(p.run('canReceive({ address: "0xabc", proven: "" })')).toBe(false);
    expect(p.run('receiveAssets({ holdings: [{ asset: "sol", class: "crypto" }, { asset: "USD", class: "cash" }, { asset: "USDC", class: "stable" }] })')).toEqual(["USDC", "USDT", "ETH", "SOL"]);
    expect(p.run("RECEIVE_NETWORKS")).toContain("Robinhood Chain");
  });
});

describe("Grant… on an agent's ask", () => {
  it("starts an agent's limit ask from what it asked: never every account, and an ask about a venue that can't trade from here ticks nothing and says so", () => {
    // no limit yet: the agent asks a limit at a venue that is not connected
    const p = account({ spend: [] });
    p.run("quoteDialog = (o) => { QD = o; return { form: { addEventListener() {} } }; }");
    const ticked = () => [...p.run<string>("QD.fields").matchAll(/name="allow-trade" value="([^"]+)" checked/g)].map((m) => m[1]);
    p.run(`pfLimitForm({ agent: "${AGENT}", venue: "standin-pubex", usd: "1000", ask: A.asks[1] })`);
    expect(ticked()).toEqual([]);
    expect(p.run<string>("QD.fields")).toContain("It asked about standin-pubex, which can't trade from here: tick where it may.");
    // an ask about a venue that trades: that venue alone
    p.run(`pfLimitForm({ agent: "${AGENT}", venue: "wallet", usd: "1000", ask: A.asks[0] })`);
    expect(ticked()).toEqual(["wallet"]);
    // the owner opening the form without an ask: every account that trades starts ticked
    p.run("pfLimitForm({})");
    expect(ticked()).toEqual(["ex", "wallet"]);
  });
});
