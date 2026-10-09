import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createContext, runInContext, Script } from "node:vm";
import { describe, expect, it } from "vitest";

/** The Portfolio pane's own logic (ui/portfolio.js), run as the page runs it: plain scripts in one global scope after ui/core.js, ui/connect.js
 * and ui/money.js, here in a vm with a stand-in document. What is checked is what the owner reads and presses: the lens narrowing every
 * list, ONE change line that follows the range, the curve from the account's own numbers, the cards grouped by agent with their time said
 * once, every agent string escaped, the Accounts table's switch and Details, the Account drawer, every button wired to an action, nothing
 * that signs offered to a browser that cannot sign */
const UI = fileURLToPath(new URL("../../src/portfolio/public/ui/", import.meta.url));
const FILES = ["core.js", "connect.js", "money.js", "portfolio.js"];

type Asked = { path: string; method: string; body?: unknown };
function page(opts: { fetch?: (path: string, init?: { method?: string; body?: string }) => Promise<unknown> } = {}) {
  const asked: Asked[] = [];
  const element = (): Record<string, unknown> => ({ addEventListener() {}, removeAttribute() {}, setAttribute() {}, querySelectorAll: () => [], querySelector: () => null, classList: { add() {}, remove() {}, toggle() {} }, dataset: {}, style: {}, hidden: false, innerHTML: "", textContent: "", value: "" });
  const sandbox: Record<string, unknown> = {
    document: { getElementById: element, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, body: element(), documentElement: { dataset: { theme: "cream" } } },
    location: { hash: "", origin: "http://127.0.0.1:4820" },
    history: { replaceState() {} },
    Owner: { role: "owner", kid: "k1", why: (r: { body?: { refusal?: { message?: string }; error?: string } }) => r.body?.refusal?.message ?? r.body?.error ?? "" },
    Event: class {
      constructor(readonly type: string) {}
    },
    addEventListener() {},
    dispatchEvent: () => true,
    console,
    URLSearchParams,
    Intl,
    setTimeout,
    clearTimeout,
    fetch: async (path: string, init?: { method?: string; body?: string }) => {
      asked.push({ path, method: init?.method ?? "GET", ...(init?.body ? { body: JSON.parse(init.body) } : {}) });
      if (!opts.fetch) return new Promise(() => {});
      const body = await opts.fetch(path, init);
      return { status: (body as { ok?: boolean })?.ok === false ? 409 : 200, statusText: "", json: async () => body };
    },
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
  sandbox.window = runInContext("globalThis", ctx);
  for (const f of FILES) new Script(readFileSync(`${UI}${f}`, "utf8"), { filename: f }).runInContext(ctx);
  const run = <T = unknown>(code: string): T => runInContext(code, ctx) as T;
  return { run, asked, set: (name: string, value: unknown) => run(`${name} = ${JSON.stringify(value)}`) };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

const NOW = "2026-10-06T12:00:00.000Z";
const AGENT = "0x3a087530887bd175ccc38828ee3776e5b6ea1ac6";
const OTHER = "0x9999999999999999999999999999999999999999";
const venue = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, live: true, usd: 0, holdings: [], ...extra });
/** an account as /api/account says it, the way the stand-in account seeds one: an exchange that trades and moves money, a wallet that only
 * trades, a prediction market whose key can't trade, and an agent's wallet */
const ACCOUNT = {
  now: NOW,
  liveUsd: 12000,
  inFlightUsd: 0,
  mode: "guard",
  connectLive: { writes: { on: true, capUsd: 250 }, home: "/home/x", options: [{ kind: "exchange", connector: "live:exchange", label: "Exchange account · API key", venues: ["okx", "kraken"] }, { kind: "standin-pubex", connector: "live:standin-pubex", label: "Stand-in Public Exchange · spot (test harness)", venues: [] }, { kind: "kalshi", connector: "live:kalshi", label: "Kalshi · event contracts", needs: "key-file", venues: [] }] },
  dial: { sessionExpiresAt: "2026-11-05T00:00:00.000Z", sessionEnded: false, maxLeverage: 5, revoked: [] },
  venues: [
    venue("ex", "Exchange", { usd: 9000, trade: { can: true, what: "spot and perpetuals", positions: true }, liveCan: { withdraw: true, ledgers: ["spot", "futures"], transfer: true, swap: true, receive: true, send: false }, plugged: true, asOf: "2026-10-06T11:58:00.000Z" }),
    venue("wallet", "Wallet", { usd: 2000, trade: { can: true, what: "tokens" }, liveCan: null, readOnlyBecause: "moves only at the venue", plugged: true }),
    venue("predict", "Predictions", { usd: 900, trade: { can: false, what: "event contracts", positions: true }, connector: "live:kalshi", keyFile: "credentials/predict/api-key.json", plugged: true }),
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
  intents: [{ id: "intent-1", agent: AGENT, agentName: "Claude Code", venue: "ex", symbol: "SOL/USDT", text: "Build SOL", validUntil: "2026-10-09T12:00:00.000Z", byAgent: [{ status: "taking", note: "Placed a limit", by: AGENT, byName: "Claude Code", at: "2026-10-06T11:00:00.000Z" }] }],
  health: { ex: { lastOkAt: "2026-10-06T11:58:00.000Z", ms: 12 }, predict: { lastFailAt: "2026-10-06T11:59:00.000Z", lastOkAt: "2026-10-06T11:00:00.000Z", code: "E_VENUE_GEOBLOCKED", message: "Predictions does not serve this location." } },
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
  ],
};
/** the curve's history for a week */
const HIST_1W = { range: "1w", from: "2026-09-29T12:00:00Z", first: "2026-09-20T00:00:00Z", points: [{ at: "2026-09-29T12:00:00Z", usd: 11000 }, { at: "2026-10-06T12:00:00Z", usd: 12000 }], events: [], changeUsd: 1000, changePct: 9.09 };

function account(over: Record<string, unknown> = {}, opts: Parameters<typeof page>[0] = {}) {
  const p = page(opts);
  p.set("A", { ...ACCOUNT, ...over });
  p.set("PF.hold", HOLD);
  return p;
}
const ALL = '{ kind: "all", id: "", name: "All accounts" }';

describe("the Portfolio pane", () => {
  it("narrows every list to the lens: one venue's lines, or one agent's wallets, added up again", () => {
    const p = account();
    const keys = (code: string) => p.run<Array<{ key: string; usd: number; amount: number }>>(code).map((r) => `${r.key}=${r.usd}`);
    expect(keys(`pfRowsIn(PF.hold.rows, pfVenueIn(${ALL}))`)).toEqual(["crypto:BTC=6000", "stable:USDC=3000", "rwa:USDY=1100", "event:FED:YES=31"]);
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

  it("splits the ready dollars as the account does, and folds money earning into the dollar or coin it is on the allocation bar", () => {
    const p = account();
    expect(p.run(`pfCash(PF.hold.money, pfVenueIn(${ALL}))`)).toMatchObject({ ready: 3000, canMove: 3000, stays: 0, trades: 2900 });
    expect(p.run(`pfCash(PF.hold.money, pfVenueIn({ kind: "agent", id: "${AGENT}" }))`)).toMatchObject({ ready: 100, canMove: 100, stays: 0, trades: 0 });
    expect(p.run('pfAlloc(PF.hold.rows).map((x) => `${x.cls} ${x.pct}`)')).toEqual(["crypto 59.2", "stable 29.6", "rwa 10.9", "event 0.3"]);
    // no Earning class: USDT earning is a stablecoin, ETH earning a coin (the Assets rows say where each earns)
    const alloc = p.run<Array<{ cls: string; usd: number }>>('pfAlloc([{ key: "earn:ex:flex:USDT", asset: "USDT", class: "earn", usd: 100 }, { key: "earn:ex:bond:ETH", asset: "ETH", class: "earn", usd: 50 }, { key: "stable:USDC", asset: "USDC", class: "stable", usd: 100 }])');
    expect(alloc.map((x) => `${x.cls} ${x.usd}`)).toEqual(["stable 200", "crypto 50"]);
  });

  it("draws the curve only from two points on, scaled to its box, and the one change line says how far back it goes", () => {
    const p = account();
    expect(p.run('pfCurve([{ at: "2026-10-06T00:00:00Z", usd: 10 }])')).toBeNull();
    const c = p.run<{ line: string; area: string; pts: number[][] }>('pfCurve([{ at: "2026-10-06T00:00:00Z", usd: 100 }, { at: "2026-10-06T01:00:00Z", usd: 200 }, { at: "2026-10-06T02:00:00Z", usd: 150 }], 600, 140)');
    expect(c.pts.map((x) => x[0])).toEqual([0, 300, 600]);
    // the highest point near the top, the lowest near the bottom, a tenth of the span spare at each end
    expect(c.pts[1]![1]).toBeCloseTo(140 / 12, 0);
    expect(c.pts[0]![1]).toBeCloseTo(140 - 140 / 12, 0);
    expect(c.line.startsWith("M0,")).toBe(true);
    expect(c.area.endsWith("L600,140L0,140Z")).toBe(true);
    // short of two points: when the first was taken
    expect(p.run('pfCurveHtml({ range: "1m", from: "2026-09-06T00:00:00Z", first: "2026-10-06T11:00:00Z", points: [{ at: "2026-10-06T11:00:00Z", usd: 1 }], events: [], changeUsd: 0 })')).toContain("the first was taken");
    const svg = String(p.run('pfCurveHtml({ range: "1m", from: "2026-09-06T00:00:00Z", first: "2026-09-29T04:00:00Z", points: [{ at: "2026-09-29T04:00:00Z", usd: 100 }, { at: "2026-10-06T04:00:00Z", usd: 110 }], events: [], changeUsd: 10, changePct: 10 })'));
    expect(svg).toContain('role="img"');
    // the curve carries no change line of its own any more: the one line is the card's (pfRangeLine), and a range that starts before the
    // first point says "since"
    expect(svg).not.toContain("▲");
    const line = String(p.run('pfRangeLine({ range: "1m", from: "2026-09-06T00:00:00Z", first: "2026-09-29T04:00:00Z", points: [], events: [], changeUsd: 10, changePct: 10 })'));
    expect(line).toContain("since Tue 29 Sept");
    expect(line).toContain("▲");
    expect(line).toContain("$10.00");
    expect(String(p.run(`pfRangeLine(${JSON.stringify(HIST_1W)})`))).toContain("past week");
  });

  it("groups what waits by agent, says each card's time once, offers Connect on a venue ask, and escapes every word an agent wrote", () => {
    const p = account();
    const groups = p.run<Array<{ name: string; cards: unknown[]; asks: unknown[] }>>("pfGroups(A.cards, A.asks)");
    expect(groups.map((g) => [g.name, g.cards.length, g.asks.length])).toEqual([["Claude Code", 2, 2], ["Other", 1, 0]]);
    const html = String(p.run(`pfWaitingHtml(${ALL}, true)`));
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
    // the time once, on each card — no "answer in N mins" for the group, no "1 card · 2 asks" count line
    expect(html.match(/answer by /g)).toHaveLength(3);
    expect(html).not.toContain("answer in");
    expect(html).not.toContain("2 cards · 2 asks");
    // each card is named, so a "Review" elsewhere can bring it into view
    for (const id of ["card-0001", "card-0002", "card-0003"]) expect(html).toContain(`data-pf-card="${id}"`);
    // a venue asked for is connected from here: the ask's button says so
    // round 7's keys (F3): a round icon for each answer, its word for the screen reader — Connect on a venue ask, Grant on the rest
    expect(html).toMatch(/data-pf-act="grant" data-ask="ask-0002"[^>]*>(<svg[^>]*>.*?<\/svg>)<span class="sr">Connect<\/span><\/button>/);
    expect(html).toMatch(/data-pf-act="grant" data-ask="ask-0001"[^>]*>(<svg[^>]*>.*?<\/svg>)<span class="sr">Grant<\/span><\/button>/);
    expect(html).toMatch(/class="rkey yes-k" data-pf-act="approve"[^>]*title="Approve: one signature"/);
    // a browser that cannot sign sees them, and can press none
    const look = String(p.run(`pfWaitingHtml(${ALL}, false)`));
    expect(look.match(/data-pf-act="(approve|reject|grant|approve-all)"[^>]*disabled/g)).toHaveLength(3 + 3 + 2 + 1);
    // nothing waits: no section at all
    p.run("A.cards = []; A.asks = []");
    expect(p.run(`pfWaitingHtml(${ALL}, true)`)).toBe("");
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

  it("connects a venue an agent asked for through the connection's own form, straight away", () => {
    const p = account();
    p.run("var VIA = []; var OPENED = []; connectVia = (c, o) => { VIA.push([c, o.name]); return true; }; openConnect = (o, opts) => OPENED.push([o.kind, opts.exchange]); openPicker = () => OPENED.push(['picker'])");
    p.run('pfGrant(A.asks[1])');
    expect(p.run("VIA")).toEqual([["live:standin-pubex", "Stand-in Public Exchange"]]);
    // an exchange the server connects by id: its connection by id; a venue nothing names: every way of connecting
    p.run('pfConnectVenue("okx")');
    expect(p.run("VIA")).toEqual([["live:standin-pubex", "Stand-in Public Exchange"], ["live:exchange:okx", ""]]);
    p.run('pfConnectVenue("nowhere")');
    expect(p.run("OPENED")).toEqual([["picker"]]);
  });

  it("tells what the agents did, newest first — done ✓ and refused ✗ only; what waits and what they reported live elsewhere", () => {
    const p = account();
    const items = p.run<Array<{ mark: string; text: string; at: string }>>(`pfAgentLines({
      agents: [{ address: "${AGENT}", name: "Claude Code", flights: [{ no: "CC-0002", at: "2026-10-06T11:30:00.000Z", request: "buy ETH", legs: ["▣ waits"] }, { no: "CC-0009", at: "2026-10-06T11:45:00.000Z", request: "move $900 to a new address", legs: ["✗ not one of your places"] }] }],
      lines: [{ agent: "${AGENT}", agentName: "Claude Code", by: "Claude Code, inside its limit", description: "Buy 0.002 BTC", status: "filled", at: "2026-10-06T10:00:00.000Z", account: "ex", accountName: "Exchange" }, { agent: "${AGENT}", description: "Buy SOL", status: "open", at: "2026-10-06T11:50:00.000Z" }, { description: "your own", status: "filled", at: "2026-10-06T11:59:00.000Z" }],
    })`);
    expect(items.map((x) => `${x.mark} ${x.text}`)).toEqual(["✗ move $900 to a new address", "✓ Buy 0.002 BTC"]);
    // Agents at work: the words to the agents mount in their own box (ui/intent.js), the lines under them, the Statement at hand
    const html = String(p.run(`pfAgentsHtml(${ALL})`));
    expect(html).toContain("Agents at work");
    expect(html).toContain("<div data-pf-intents></div>");
    expect(html).toContain('data-pf-act="statement"');
    expect(html).not.toContain("▣");
    // no agent, no words: no card
    p.run("A.keys = []; A.intents = []");
    expect(p.run(`pfAgentsHtml(${ALL})`)).toBe("");
  });

  it("mounts the owner's words to agents under Agents at work through intent.js, once per change — and Change words hands over again", () => {
    const p = account();
    p.run("var MOUNTS = []; globalThis.htaIntents = (el, owner, o) => MOUNTS.push([el.tag, owner, typeof o.change]); var HANDED = []; globalThis.openHandToAgent = (x) => HANDED.push(x)");
    p.run('var BOX = { tag: "box" }; var EL = { querySelector: (s) => (s === "[data-pf-intents]" ? BOX : null) }');
    p.run("pfIntents(EL, true)");
    expect(p.run("MOUNTS")).toEqual([["box", true, "function"]]);
    // a plain refresh with the same words: not mounted again (Change words and Withdraw keep their focus)
    p.run("pfIntents(EL, false)");
    expect(p.run("MOUNTS.length")).toBe(1);
    // the words changed: mounted again; the part drawn again: mounted again
    p.run('A.intents.push({ id: "intent-2", agent: "*", text: "Watch BTC", validUntil: "2026-10-09T12:00:00.000Z", byAgent: [] }); pfIntents(EL, false)');
    expect(p.run("MOUNTS.length")).toBe(2);
    p.run("pfIntents(EL, true)");
    expect(p.run("MOUNTS.length")).toBe(3);
    // the change callback: the composer, with the words being changed
    p.run('htaIntents = (el, owner, o) => o.change({ id: "intent-1" }); pfIntents(EL, true)');
    expect(p.run("HANDED")).toEqual([{ intent: { id: "intent-1" } }]);
  });

  it("ticks the three first steps from the account, and shows them until they are done", () => {
    const p = account();
    expect(p.run("pfSteps(A).map((s) => s.done)")).toEqual([true, true, true]);
    expect(p.run("pfStepsHtml(true, false)")).toBe("");
    p.run("A.spend = []");
    expect(p.run("pfSteps(A).map((s) => s.done)")).toEqual([true, true, false]);
    const next = String(p.run("pfStepsHtml(true, false)"));
    expect(next).toContain("Next steps · 2 of 3");
    expect(next).toContain("In Guard each order still waits for you.");
    p.run("A.venues = []; A.keys = []");
    const fresh = String(p.run("pfStepsHtml(true, true)"));
    expect(fresh).toContain("Get started · 0 of 3");
    expect(fresh).toContain('data-pf-act="connect"');
    expect(fresh).toContain('data-pf-act="setup"');
    // a limit needs an agent and an account that trades first
    expect(fresh).toMatch(/data-pf-act="limit"[^>]*disabled/);
  });

  it("lists assets with where they are and their own 24 hours in five columns; an event by its question, a dollar to the cent; no cost column", () => {
    const p = account();
    const html = String(p.run(`pfAssetsHtml(${ALL}, PF.hold.rows)`));
    expect(html).toContain("Will the Fed cut? · Yes");
    expect(html).toContain("62¢");
    expect(html).toContain("Exchange · Wallet");
    expect(html).toContain('data-pf-act="asset" data-key="crypto:BTC"');
    // USDC at $0.99999876 reads $1.00 (the price's column, which folds into the name line on a narrow card: .pf-px)
    expect(html).toContain("<td class=\"r pf-px\">$1.00</td>");
    // Asset · Amount · Price · 24h · Value — what the account paid is the drawer's story
    expect(html.match(/<th /g)).toHaveLength(5);
    expect(html).not.toContain("Since bought");
    expect(html).not.toContain("for 0.04 of 0.1");
    expect(p.run("typeof pfCostWords")).toBe("undefined");
  });

  it("offers Close… or Sell… on a position only where the account can, and the quick actions where some account can", () => {
    const p = account();
    p.set("PF.pos", { positions: [{ symbol: "BTC/USDT:USDT", name: "BTC perpetual", kind: "perp", side: "long", qty: 0.01, usd: 600, venue: "ex", venueName: "Exchange" }, { symbol: "FED:YES", name: "Fed · Yes", kind: "event", side: "long", qty: 50, venue: "predict", venueName: "Predictions" }, { symbol: "ETH/USDT", name: "ETH", kind: "spot", side: "long", qty: 1, usd: 2000, venue: "ex", venueName: "Exchange" }], missing: [{ venue: "wallet", venueName: "Wallet", why: "Wallet: this region is not served <b>" }] });
    const pos = String(p.run(`pfPositionsHtml(${ALL}, pfVenueIn(${ALL}), true)`));
    // the exchange trades and lists positions: Close… for the perpetual, Sell… for the holding; the prediction market's key may not trade: none
    expect(pos.match(/data-pf-act="close"/g)).toHaveLength(2);
    expect(pos).toMatch(/data-pf-act="close" data-venue="ex" data-symbol="BTC\/USDT:USDT"[^>]*>Close…</);
    expect(pos).toMatch(/data-pf-act="close" data-venue="ex" data-symbol="ETH\/USDT"[^>]*>Sell…</);
    // no Earning sub-table: earn rows live under Assets
    expect(pos).not.toContain("Earning");
    expect(p.run("typeof pfEarnHtml")).toBe("undefined");
    // a venue that refused says so in its own words, escaped
    expect(pos).toContain("Wallet: this region is not served &lt;b&gt;");
    const quick = String(p.run(`pfQuickHtml(${ALL}, pfVenueIn(${ALL}), true)`));
    expect(quick).toContain('data-pf-act="trade"');
    expect(quick).toContain('data-pf-act="move"');
    expect(quick).toContain('data-pf-act="receive"');
    // read-only server: nothing trades or moves, the addresses still receive
    p.run("A.connectLive.writes.on = false");
    const ro = String(p.run(`pfQuickHtml(${ALL}, pfVenueIn(${ALL}), true)`));
    expect(ro).not.toContain('data-pf-act="trade"');
    expect(ro).not.toContain('data-pf-act="move"');
    expect(ro).toContain('data-pf-act="receive"');
  });

  it("lists the accounts with a health chip, an Open to agents switch and Details — no row-level Trade, Move or Disconnect", () => {
    const p = account({ dial: { ...ACCOUNT.dial, revoked: ["wallet"] } });
    const acc = String(p.run(`pfAccountsHtml(pfVenueIn(${ALL}), true)`));
    for (const gone of ["acct-trade", "acct-move", "acct-off"]) expect(acc).not.toContain(`data-pf-act="${gone}"`);
    expect(acc.match(/data-pf-act="acct-details"/g)).toHaveLength(4);
    // the switch: open unless the dial says closed; closing is free, so a looking-only browser may; reopening is signed, so it may not
    expect(acc.match(/role="switch" class="pf-switch"/g)).toHaveLength(4);
    expect(acc).toContain('aria-checked="true" data-pf-act="agents" data-venue="ex" data-on="true"');
    expect(acc).toContain('aria-checked="false" data-pf-act="agents" data-venue="wallet" data-on="false"');
    expect(acc).not.toMatch(/data-venue="wallet" data-on="false"[^>]*disabled/);
    expect(String(p.run(`pfAccountsHtml(pfVenueIn(${ALL}), false)`))).toMatch(/data-venue="wallet" data-on="false"[^>]*disabled/);
    // the health chip: ✓ for a venue that answered, ✗ with the venue's own geoblock words for one that did not; the caption and "as of" are gone
    expect(acc).toMatch(/<span class="chip pf-health" title="Answered at 07:58 · 12 ms"><span aria-hidden="true">✓<\/span>Answers<\/span>/);
    expect(acc).toMatch(/<span class="chip pf-health bad" title="Predictions does not serve this location\. That is Predictions&#39;s own rule for this location\."><span aria-hidden="true">✗<\/span>Not answering<\/span>/);
    expect(acc).not.toContain("API key");
    expect(acc).not.toContain("as of");
    // what a venue trades from here, or why not — and when a new key would fix it
    expect(p.run("pfTrades(A.venues[0])")).toEqual({ can: true, text: "Trades spot and perpetuals." });
    expect(p.run("pfTrades(A.venues[1])")).toEqual({ can: true, text: "Trades tokens." });
    const t = p.run<{ can: boolean; rekey: boolean; text: string }>("pfTrades(A.venues[2])");
    expect(t.can).toBe(false);
    expect(t.rekey).toBe(true);
    expect(t.text).toContain("This key can't trade. Create New API Key (Ed25519)");
  });

  it("closes an account to agents for free and reopens it signed", async () => {
    const p = account({}, { fetch: async () => ({ ok: true, revoked: ["ex"] }) });
    p.run("var DRAFTS = []; own = async (d) => { DRAFTS.push(d); return { status: 200, body: {} }; }; load = async () => {}");
    await p.run("pfAgentsSwitch('ex', true)");
    expect(p.asked.filter((a) => a.method === "POST")).toEqual([{ path: "/api/revoke", method: "POST", body: { account: "ex" } }]);
    expect(p.run("said")).toBe("Exchange is closed to agents: they keep reading it, and place or move nothing there. Reopening it is signed.");
    await p.run("pfAgentsSwitch('wallet', false)");
    expect(JSON.stringify(p.run("DRAFTS"))).toBe(JSON.stringify([{ type: "setPolicy", change: "restore", value: "wallet" }]));
    // a browser that only looks reopens nothing
    p.run('Owner.role = "pending"; DRAFTS = []');
    await p.run("pfAgentsSwitch('wallet', false)");
    expect(p.run("DRAFTS.length")).toBe(0);
    // the pane's own switch reaches the same door, with the state it showed
    p.run('Owner.role = "owner"');
    p.run('pfAct("agents", { venue: "wallet", on: "false" })');
    await settle();
    expect(p.run("DRAFTS.length")).toBe(1);
  });

  it("draws the Account drawer with every action on it, Connect a new key only for a key that can't trade, and never Disconnect for an agent wallet", async () => {
    const p = account();
    p.run('var DRAWN = ""; openDrawer = (html) => { DRAWN = html; return { addEventListener() {}, querySelector: () => null }; }; globalThis.openTicket = () => {}');
    p.run('pfDetails("ex")');
    let d = String(p.run("DRAWN"));
    for (const act of ["trade", "move", "receive", "lens", "off"]) expect(d, act).toContain(`data-det="${act}"`);
    expect(d).not.toContain('data-det="rekey"');
    expect(d).toContain("Trades spot and perpetuals.");
    expect(d).toContain("Moves money: withdraw, transfer, swap.");
    // a key that can't trade: a new key, and no Trade…
    p.run('pfDetails("predict")');
    d = String(p.run("DRAWN"));
    expect(d).toContain('data-det="rekey"');
    expect(d).not.toContain('data-det="trade"');
    expect(d).toContain("This key can&#39;t trade. Create New API Key (Ed25519)");
    // the agent wallet: Receive, never Disconnect
    p.run('pfDetails("agent-claude-code")');
    d = String(p.run("DRAWN"));
    expect(d).toContain('data-det="receive"');
    expect(d).not.toContain('data-det="off"');
    expect(d).toContain("Empty it with Take back…");
    // Connect a new key: asked first, then the signed disconnect, then the venue's own form under its own name and key file
    p.run("var ASKED = ''; confirmSheet = async (t) => { ASKED = t; return true; }; var DRAFTS = []; own = async (d) => { DRAFTS.push(d); return { status: 200, body: {} }; }; var VIA = []; connectVia = (c, o) => { VIA.push([c, o]); return true; }");
    await p.run('pfRekey("predict")');
    expect(p.run("ASKED")).toContain("Predictions's key can't trade.");
    expect(p.run("ASKED")).toContain("/home/x/credentials/predict/api-key.json");
    expect(JSON.stringify(p.run("DRAFTS"))).toBe(JSON.stringify([{ type: "disconnectVenue", venue: "predict" }]));
    expect(p.run("VIA")).toEqual([["live:kalshi", { name: "Predictions", label: "Predictions", ref: "credentials/predict/api-key.json" }]]);
    // a venue whose key trades is never re-keyed from here
    p.run("DRAFTS = []");
    await p.run('pfRekey("ex")');
    expect(p.run("DRAFTS.length")).toBe(0);
  });

  it("shows the net worth with ONE change line that follows the range — today for 1D, the curve's for the rest — and the footnotes behind one ⓘ", () => {
    const p = account({ inFlightUsd: 25 });
    p.run(`PF.hist = new Map([["1w", ${JSON.stringify({ ...HIST_1W, paidOutUsd: 3, partial: true })}]])`);
    const all = String(p.run(`pfWorthHtml(${ALL}, pfVenueIn(${ALL}), PF.hold.rows)`));
    expect(all).toContain("$12,000.00");
    // the range is a week: the week's change, not today's; the coverage words are not on the line
    expect(all).toContain("$1,000.00");
    expect(all).toContain("past week");
    expect(all).not.toContain("$117.65");
    expect(all).not.toContain('<span class="dim">today</span>');
    expect(all).toContain("data-pf-curve");
    expect(all.match(/<details class="more pf-info">/g)).toHaveLength(1);
    expect(all).toContain("$3.00 paid out by agents is not counted as a loss.");
    expect(all).toContain("A venue&#39;s last good number is in it.");
    expect(all).toContain("$25.00 on the way between your accounts is counted in the figure.");
    expect(all).not.toContain("on $9,000.00 of $10,131.00");
    // 1D: today's change on the line, its coverage in the ⓘ, nothing of the curve's notes
    p.set("PF.range", "1d");
    const day = String(p.run(`pfWorthHtml(${ALL}, pfVenueIn(${ALL}), PF.hold.rows)`));
    expect(day).toContain("$117.65");
    expect(day).toContain('<span class="dim">today</span>');
    expect(day).not.toContain("past week");
    expect(day).toContain("The 24-hour change covers $9,000.00 of $10,131.00: no 24-hour figure for USDY, FED:YES.");
    expect(day).not.toContain("paid out by agents");
    // one venue: its own figure and today's change, no curve, no range
    const one = String(p.run('pfWorthHtml({ kind: "venue", id: "ex", name: "Exchange" }, pfVenueIn({ kind: "venue", id: "ex" }), pfRowsIn(PF.hold.rows, pfVenueIn({ kind: "venue", id: "ex" })))'));
    expect(one).toContain("Net worth · Exchange");
    expect(one).toContain("$9,000.00");
    expect(one).toContain('<span class="dim">today</span>');
    expect(one).not.toContain("data-pf-curve");
    expect(one).not.toContain('data-pf-range="1d"');
    expect(one).toContain('data-pf-act="all"');
  });

  it("brings a card named by the route into view and rings it for a moment; an unknown id does nothing", () => {
    const p = account();
    p.run('var SCROLLED = []; var CLASSES = []; var NODE = { scrollIntoView: (o) => SCROLLED.push(o), classList: { add: (c) => CLASSES.push("+" + c), remove: (c) => CLASSES.push("-" + c) } }; var EL = { querySelector: (s) => (s === \'[data-pf-card="card-0001"]\' ? NODE : null) }');
    expect(p.run('pfShowCard(EL, "card-0001")')).toBe(true);
    expect(p.run("SCROLLED")).toEqual([{ block: "center", behavior: "smooth" }]);
    expect(p.run("CLASSES")).toEqual(["+pf-hi", "+on"]);
    expect(p.run('pfShowCard(EL, "card-9999")')).toBe(false);
    // the route names the card; the pane shows it the next time it draws
    p.run('routed = undefined; location.hash = "#/portfolio?card=card-0002"');
    p.run('ROUTED.forEach((fn) => fn("portfolio", { card: "card-0002" }, true))');
    expect(p.run("PF.hiWant")).toBe("card-0002");
    p.run('ROUTED.forEach((fn) => fn("markets", {}, true))');
    expect(p.run("PF.hiWant")).toBe("");
  });

  it("puts Earn… on Cash ready where a venue earns, Sell many… among the Assets tools where a venue trades, and Withdraw… on an earn row — each to its sheet", async () => {
    const p = account();
    // without earn.js on this page there is no sheet to open, so no button
    let cash = String(p.run(`pfCashHtml(${ALL}, pfVenueIn(${ALL}), true)`));
    expect(cash).not.toContain('data-pf-act="earn"');
    expect(cash).toContain("$3,000.00");
    expect(cash).toContain("$3,000.00 can move between your accounts.");
    expect(cash).not.toContain("legend");
    p.run("var OPENED = []; globalThis.openEarn = (x) => OPENED.push(['earn', x]); globalThis.openSellMany = (x) => OPENED.push(['sellmany', x])");
    cash = String(p.run(`pfCashHtml(${ALL}, pfVenueIn(${ALL}), true)`));
    // still no venue earns
    expect(cash).not.toContain('data-pf-act="earn"');
    p.run('A.venues[0].earn = { can: true, what: "Simple Earn Flexible" }');
    cash = String(p.run(`pfCashHtml(${ALL}, pfVenueIn(${ALL}), true)`));
    expect(cash).toContain('data-pf-act="earn"');
    // under an agent's lens, its wallet earns nothing: no Earn…
    expect(String(p.run(`pfCashHtml({ kind: "agent", id: "${AGENT}" }, pfVenueIn({ kind: "agent", id: "${AGENT}" }), true)`))).not.toContain('data-pf-act="earn"');
    const table = String(p.run(`pfTableHtml(${ALL}, pfVenueIn(${ALL}), PF.hold.rows, true)`));
    expect(table).toContain('data-pf-act="sellmany"');
    p.run('pfAct("earn", {}); pfAct("sellmany", {})');
    expect(p.run("OPENED")).toEqual([["earn", {}], ["sellmany", {}]]);
    p.run('view.lens = "venue:ex"; pfAct("earn", {}); pfAct("sellmany", {}); view.lens = ""');
    expect(p.run("OPENED.slice(2)")).toEqual([["earn", { venue: "ex" }], ["sellmany", { venue: "ex" }]]);
    // an earn row's Withdraw…: the Earn sheet on Take out, the product the row names picked
    p.run('PF.hold.rows.push({ key: "earn:ex:savings:USDT", asset: "USDT", class: "earn", amount: 120, usd: 120, price: 1, venues: [{ venue: "ex", venueName: "Exchange", amount: 120, usd: 120 }], earn: { venue: "ex", venueName: "Exchange", product: "savings:USDT", asset: "USDT", name: "USDT Flexible", apy: 0.052 } })');
    const assets = String(p.run(`pfAssetsHtml(${ALL}, PF.hold.rows)`));
    expect(assets).toContain("USDT · earning");
    expect(assets).toContain("Exchange · USDT Flexible · 5.2% a year");
    expect(assets).toContain('data-pf-act="earn-row-out" data-key="earn:ex:savings:USDT"');
    expect(assets).not.toContain('data-pf-act="asset" data-key="earn:ex:savings:USDT"');
    expect(assets).toContain('<tr class="pf-earn-row">');
    await p.run('pfEarnRowOut("earn:ex:savings:USDT")');
    expect(p.run("OPENED[OPENED.length - 1]")).toEqual(["earn", { venue: "ex", side: "withdraw", product: "savings:USDT" }]);
    // a key that can't take money out, or a server started read-only: no Withdraw
    p.run("A.venues[0].earn.can = false");
    expect(String(p.run(`pfAssetsHtml(${ALL}, PF.hold.rows)`))).not.toContain("earn-row-out");
    p.run("A.venues[0].earn.can = true; A.connectLive.writes.on = false");
    expect(String(p.run(`pfAssetsHtml(${ALL}, PF.hold.rows)`))).not.toContain("earn-row-out");
    expect(p.run("typeof pfEarnWithdraw")).toBe("undefined");
  });

  it("wires every button it draws to something it does", () => {
    const src = readFileSync(`${UI}portfolio.js`, "utf8");
    const drawn = new Set([...src.matchAll(/pfBtn\("([a-z-]+)"/g), ...src.matchAll(/data-pf-act="([a-z-]+)"/g)].map((m) => m[1]));
    const handled = new Set([...src.slice(src.indexOf("async function pfAct(")).matchAll(/case "([a-z-]+)":/g)].map((m) => m[1]));
    expect([...drawn].filter((a) => !handled.has(a))).toEqual([]);
    expect(drawn.size).toBeGreaterThan(15);
    // Guard and Beast are the words; the old ones are gone
    expect(src).not.toMatch(/Conservative|Aggressive/);
  });
});

describe("answering an agent's ask", () => {
  it("offers Decline… on every ask — beside Grant… (or Connect) where the account has the form for it — in place of when the ask lapses", () => {
    const p = account();
    const html = String(p.run(`pfWaitingHtml(${ALL}, true)`));
    expect(html.match(/data-pf-act="decline"/g)).toHaveLength(2);
    expect(html).toContain('data-pf-act="decline" data-ask="ask-0001"');
    expect(html).toContain('data-pf-act="decline" data-ask="ask-0002"');
    expect(html).not.toContain("until ");
    // an ask nothing here can grant still has its Decline, and says why it can't be granted
    p.run('A.mode = "open"; A.asks.push({ id: "ask-0003", agent: A.keys[0].address, agentName: "Claude Code", kind: "mode", text: "Let me trade without asking", at: A.now, expiresAt: A.now })');
    const more = String(p.run(`pfWaitingHtml(${ALL}, true)`));
    expect(more).toContain('data-pf-act="decline" data-ask="ask-0003"');
    expect(more).toContain("Already Beast.");
    expect(more.match(/data-pf-act="grant"/g)).toHaveLength(2);
    // a browser that only looks sees Decline, and can't press it
    const look = String(p.run(`pfWaitingHtml(${ALL}, false)`));
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
    await settle();
    expect(p.run("DRAFTS.map((d) => d.ask).join()")).toBe("ask-0001,ask-0002");
    p.run('Owner.role = "pending"; DRAFTS = []');
    await p.run("declineAsk(A.asks[0])");
    expect(p.run("DRAFTS.length")).toBe(0);
  });
});

describe("money in earn products, under Assets", () => {
  it("finds the product an earn row is in: the one it names, the one /earn lists at that venue for that asset, or the owner's pick", async () => {
    const p = account();
    p.run('A.venues[0].earn = { can: true, what: "Simple Earn Flexible" }; var OPENED = []; globalThis.openEarn = (x) => OPENED.push(x)');
    // a row that names no product (an account from before rows carried it): the one /earn lists at that venue for that asset
    p.set("PF.earn", { positions: [{ venue: "ex", venueName: "Exchange", product: "savings:USDT", asset: "USDT", amount: 120, name: "USDT Flexible" }, { venue: "ex", venueName: "Exchange", product: "locked:ETH", asset: "ETH", amount: 1, name: "ETH 30 days" }], products: [], missing: [] });
    expect(p.run('JSON.stringify(pfEarnLines({ asset: "USDT", venues: [{ venue: "ex", venueName: "Exchange", amount: 120 }] }))')).toBe(JSON.stringify([{ venue: "ex", venueName: "Exchange", product: "savings:USDT", name: "USDT Flexible", asset: "USDT", amount: 120 }]));
    p.run('PF.hold.rows.push({ key: "earn:ex:savings:USDT", asset: "USDT", class: "earn", amount: 120, usd: 120, price: 1, venues: [{ venue: "ex", venueName: "Exchange", amount: 120, usd: 120 }] })');
    await p.run('pfEarnRowOut("earn:ex:savings:USDT")');
    expect(p.run("OPENED")).toEqual([{ venue: "ex", side: "withdraw", product: "savings:USDT" }]);
    // two products with it: the owner picks one
    p.run('PF.earn.positions.push({ venue: "ex", venueName: "Exchange", product: "fixed:USDT", asset: "USDT", amount: 30, name: "USDT 7 days" }); var PICKED = null; pickSheet = async (t, opts) => { PICKED = [t, opts.map((o) => o[1])]; return 1; }');
    await p.run('pfEarnRowOut("earn:ex:savings:USDT")');
    expect(p.run("JSON.stringify(PICKED)")).toBe(JSON.stringify(["Withdraw USDT from", ["USDT Flexible · Exchange", "USDT 7 days · Exchange"]]));
    expect(p.run("OPENED[1]")).toEqual({ venue: "ex", side: "withdraw", product: "fixed:USDT" });
  });
});

describe("Receive, from the Portfolio", () => {
  it("gives an address only where an account can receive one: a proven wallet, or a venue whose key reads deposit addresses", () => {
    const p = account();
    expect(p.run("A.venues.filter(canReceive).map((v) => v.id)")).toEqual(["ex", "agent-claude-code"]);
    // a watched address gives none
    expect(p.run('canReceive({ address: "0xabc", proven: "" })')).toBe(false);
    expect(p.run('receiveAssets({ holdings: [{ asset: "sol", class: "crypto" }, { asset: "USD", class: "cash" }, { asset: "USDC", class: "stable" }] })')).toEqual(["USDC", "USDT", "ETH", "SOL"]);
    expect(p.run("receiveNetworks()")).toContain("Robinhood Chain");
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
    expect(p.run<string>("QD.sub")).toContain("in Guard each order still waits for you");
    // an ask about a venue that trades: that venue alone
    p.run(`pfLimitForm({ agent: "${AGENT}", venue: "wallet", usd: "1000", ask: A.asks[0] })`);
    expect(ticked()).toEqual(["wallet"]);
    // the owner opening the form without an ask: every account that trades starts ticked
    p.run("pfLimitForm({})");
    expect(ticked()).toEqual(["ex", "wallet"]);
    expect(p.run<string>("QD.sub")).toBe("The most an agent may do on its own. In Guard each order still waits for you; in Beast it goes at once inside this limit.");
  });
});
