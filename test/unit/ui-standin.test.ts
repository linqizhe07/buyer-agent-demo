/** The stand-in account (test/standin/ui-standin.ts), started in-process on a free port with its own clock: what the page reads is what was
 * seeded through the door — the venues, the agent with its limits, wallet, card, intents and asks, Markets with public rows and a venue's own
 * geoblock words, Portfolio by asset, the net worth curve over seven days — and the owner's browser pairs with the printed code, then signs
 * as an owner: it answers the agent's card and connects a venue from a public row. Prices move, and a resting order fills when the price
 * comes down to it. The Stand-in Broker keeps New York's market hours by the stand-in's clock: what it shows depends on the hour the test
 * runs, so two more stand-ins are started at chosen hours, one while the market is closed and one while it is open, and walked through a
 * session. Nothing leaves the process. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { regularSession } from "../../src/portfolio/account/calendar.ts";
import { signDevice, simKey, type OwnerAction } from "../../src/portfolio/account/sign.ts";
import { toStep } from "../standin/model.ts";
import { startStandin, type Standin } from "../standin/ui-standin.ts";
import { stockSession } from "../standin/venues.ts";

let clockMs = Date.now();
/** the stand-in's clock when it was seeded: the broker's market was open or closed then */
const seededAt = clockMs;
let s: Standin;
const get = async (path: string): Promise<{ status: number; body: any }> => {
  const r = await fetch(`${s.url}${path}`);
  return { status: r.status, body: await r.json() };
};
const post = async (path: string, body: unknown): Promise<{ status: number; body: any }> => {
  const r = await fetch(`${s.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const browser = simKey("device:ui-standin-test-browser");
/** a New York date, as Alpaca's clock gives one in the broker's note */
const nyDay = (ms: number): string => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
/** Alpaca's words for a stock while the US market is closed (live/alpaca.ts), as the Stand-in Broker says them, with the next open */
const closedWords = (opensAt: number): string =>
  `the US stock market is closed: Stand-in Broker holds an order and sends it when the market opens (${nyDay(opensAt)} 09:30 New York time). Until then no market order is placed here: it would fill at the opening price, which can be well away from this one. A limit, stop or stop-limit order waits for the open with its limit`;
/** the browser signs an owner action, as the page does: the nonce from the server's clock, the device key over the action */
const sign = async (a: Record<string, unknown>) => {
  const { body } = await get("/api/now");
  const action = { ...a, nonce: body.ms as number } as OwnerAction;
  return post("/api/exchange", { action, nonce: action.nonce, signature: signDevice(browser, action) });
};

beforeAll(async () => {
  s = await startStandin({ port: 0, tickMs: 0, agentMs: 0, clock: () => clockMs });
}, 60_000);

afterAll(async () => {
  await s?.close();
});

describe("the stand-in account", () => {
  it("never starts on the real account's port", async () => {
    await expect(startStandin({ port: 4820 })).rejects.toThrow(/4820 is the real account's/);
  });

  it("the account page: the venues with what they trade, the agent's card, intents, asks, the watchlist, orders of every kind, trading on", async () => {
    const { status, body: a } = await get("/api/account");
    expect(status).toBe(200);
    const venue = (id: string) => a.venues.find((v: { id: string }) => v.id === id);
    // the kinds are each stand-in trader's own (no table knows these connectors), and each venue says the connection it was made with
    expect(venue("ex").trade).toMatchObject({ can: true, kinds: ["spot", "perp"], positions: true, amend: true, leverage: true });
    expect(venue("ex")).toMatchObject({ connector: "live:standin-exchange", earn: { can: true } });
    expect(a.earns).toEqual([expect.objectContaining({ venue: "ex", kind: "supply", product: "flex:USDT", amount: 150 })]);
    expect(venue("predict").trade.kinds).toEqual(["event"]);
    expect(venue("wallet").trade.kinds).toEqual(["token"]);
    expect(venue(s.seeded.agent.wallet)).toMatchObject({ proven: "this account holds its key" });
    expect(a.cards).toHaveLength(1);
    expect(a.cards[0]).toMatchObject({ id: s.seeded.card, agentName: "Claude Code", agent: s.agent.address });
    expect(a.intents.map((i: { agentName: string }) => i.agentName).sort()).toEqual(["Claude Code", "every agent"]);
    expect(a.intents.find((i: { agentName: string }) => i.agentName === "Claude Code").byAgent[0]).toMatchObject({ status: "taking", byName: "Claude Code" });
    expect(a.asks.map((x: { kind: string }) => x.kind).sort()).toEqual(["limit", "venue"]);
    expect(a.watch).toHaveLength(3);
    const byId = (id: string) => a.orders.find((o: { id: string }) => o.id === id);
    expect(byId(s.seeded.orders.ethBuy!).status).toBe("filled");
    expect(byId(s.seeded.orders.solLimit!).status).toBe("open");
    expect(byId(s.seeded.orders.solStop!)).toMatchObject({ type: "stop", status: "open" });
    expect(byId(s.seeded.orders.btcCanceled!).status).toBe("canceled");
    expect(byId(s.seeded.orders.agentSol!)).toMatchObject({ status: "open", agent: s.agent.address });
    expect(a.payments.map((p: { kind: string }) => p.kind).sort()).toEqual(["swap", "transfer", "withdraw"]);
    expect(a.connectLive.writes).toMatchObject({ on: true, capUsd: 250 });
    expect([a.mode, a.dial.maxLeverage]).toEqual(["guard", 5]);
    expect(a.signers.owners.map((o: { label: string }) => o.label)).toEqual(["Stand-in seed key"]);
    // five venues: the exchange, the event market, the wallet, the broker and the agent's wallet
    expect(s.seeded.venues).toEqual(["ex", "predict", "wallet", "broker", s.seeded.agent.wallet]);
    expect(a.venues.map((v: { id: string }) => v.id).sort()).toEqual([...s.seeded.venues].sort());
    // the broker: a stock broker's one kind, said by its own trader; a cash account — no positions call, no order changed in place, no
    // leverage — where no money moves from here, in its own words
    expect(venue("broker")).toMatchObject({ connector: "live:standin-broker", trade: { can: true, what: "US stocks and ETFs", kinds: ["stock"], positions: false, amend: false, leverage: false, close: false } });
    expect(venue("broker").readOnlyBecause).toMatch(/^Stand-in Broker is a stand-in: it gives no deposit address and makes no withdrawal/);
    // its seeded orders by New York's clock then: the owner's market buys while the market was open; the SPY limit on the book, or held by
    // the broker for the open
    const open = stockSession(seededAt).open;
    expect(byId(s.seeded.orders.spyLimit!)).toMatchObject({ venue: "broker", symbol: "SPY", side: "buy", type: "limit", qty: 0.25, status: open ? "open" : "pending" });
    if (open) for (const [k, qty] of [["aaplBuy", 0.5], ["nvdaBuy", 1]] as const) expect(byId(s.seeded.orders[k]!)).toMatchObject({ venue: "broker", type: "market", status: "filled", filledQty: qty });
    else expect([s.seeded.orders.aaplBuy, s.seeded.orders.nvdaBuy]).toEqual([undefined, undefined]);
  });

  it("Markets: the connected venues' rows and the public ones marked Connect to trade, events with their outcomes, every tab, a venue's own geoblock words", async () => {
    const { status, body: e } = await get("/api/account/explore");
    expect(status).toBe(200);
    const row = (key: string) => e.items.find((i: { key: string }) => i.key === key);
    expect(row("coin:DOGE").at).toEqual([expect.objectContaining({ venue: "standin-pubex-public", connected: false, public: true, canTrade: false, connectTo: "standin-pubex", connector: "live:standin-pubex" })]);
    expect(row("coin:BTC").at.map((x: { venue: string }) => x.venue)).toEqual(expect.arrayContaining(["ex", "wallet", "standin-pubex-public"]));
    expect(row("perp:ETH").fundingRate).toBe(0.00008);
    expect(row("event:predict:SI-FEDCUT-DEC")).toMatchObject({ kind: "event", category: "Economics", outcomes: [expect.objectContaining({ label: "Yes" }), expect.objectContaining({ label: "No" })] });
    expect(row("rwa:NVDA").at[0]).toMatchObject({ public: true, canTrade: false, note: expect.stringMatching(/only read/) });
    // the wallet's tokenised fund is an RWA row too, traded at the wallet, with its issuer's words
    expect(row("rwa:USDY")).toMatchObject({ kind: "rwa", issuer: expect.any(String), at: [expect.objectContaining({ venue: "wallet", connected: true, canTrade: true })] });
    // the tabs are the Markets lens's own (live/categories.ts): these seven are on every stand-in run, whatever else that lens adds; All is first
    expect(e.tabs.map((t: { id: string }) => t.id)).toEqual(expect.arrayContaining(["all", "crypto", "stocks", "rwas", "perps", "preipo", "predictions"]));
    expect(e.tabs[0].id).toBe("all");
    // Stocks: the broker's three, each traded at the Stand-in Broker. NVDA and SPY are stock tokens too (RWAs), priced off the same curves,
    // so the line between a share and its token compares like with like
    for (const t of ["AAPL", "NVDA", "SPY"]) expect(row(`stock:${t}`)).toMatchObject({ kind: "stock", base: t, tabs: ["all", "stocks"], at: [expect.objectContaining({ venue: "broker", venueName: "Stand-in Broker", symbol: t, connected: true, canTrade: true, open: true })] });
    for (const t of ["NVDA", "SPY"]) expect(Math.abs(row(`stock:${t}`).price / row(`rwa:${t}`).price - 1)).toBeLessThan(0.002);
    const stocks = (await get("/api/account/explore?tab=stocks")).body;
    expect(stocks.items.map((i: { key: string; kind: string }) => [i.key, i.kind]).sort()).toEqual([["stock:AAPL", "stock"], ["stock:NVDA", "stock"], ["stock:SPY", "stock"]]);
    expect(stocks.tabs.find((t: { id: string }) => t.id === "stocks")).toMatchObject({ label: "Stocks", count: 3 });
    // the pre-IPO perpetual: one Anthropic row, Trade at the connected exchange and Connect to trade at the public perp exchange, each line
    // with its own contract price and implied valuation, the row's the median; it is Pre-IPO, not Perps
    const anthropic = row("preipo:anthropic");
    expect(anthropic).toMatchObject({ kind: "perp", name: "Anthropic", category: "Pre-IPO", group: { id: "preipo:anthropic", title: "Anthropic" }, tabs: ["all", "preipo"], issuer: "Anthropic" });
    expect(anthropic.at.map((a: { venue: string; connected: boolean; canTrade: unknown; connectTo?: string }) => [a.venue, a.connected, a.canTrade, a.connectTo]).sort()).toEqual([
      ["ex", true, true, undefined],
      ["standin-pubperps-public", false, false, "standin-pubperps"],
    ]);
    expect(anthropic.implied.usd).toBeGreaterThan(1.9e12);
    expect(anthropic.implied.usd).toBeLessThan(2.3e12);
    expect(anthropic.at.every((a: { implied?: { usd: number; unit: string } }) => a.implied && a.implied.usd > 1.9e12 && typeof a.implied.unit === "string")).toBe(true);
    expect(row("perp:ANTHROPIC")).toBeUndefined();
    // the IPO question is Predictions, under the venue's own word, and stays beside the busiest few
    expect(row("event:predict:SI-IPO-ANTHROPIC")).toMatchObject({ kind: "event", category: "IPO", tabs: ["all", "predictions"] });
    expect(e.notes).toContain("Pre-IPO perpetuals are contracts on a venue's estimate of a private company's valuation, not shares; each venue says who may trade them once a key connects.");
    expect(e.movers.map((m: { key: string }) => m.key)).toContain("coin:DOGE");
    expect(e.closing.length).toBeGreaterThan(0);
    expect(e.missing).toEqual([expect.objectContaining({ venue: "standin-geo", code: "E_VENUE_GEOBLOCKED", said: "Service unavailable from a restricted location (stand-in)." })]);
  });

  it("Portfolio by asset once the venues are read again: coins at two venues, the RWA, the event contract, the dollars", async () => {
    // a venue's balances are read again after thirty seconds on the account's clock
    clockMs += 31_000;
    const { status, body: h } = await get("/api/account/holdings?cost=1");
    expect(status).toBe(200);
    const row = (key: string) => h.rows.find((r: { key: string }) => r.key === key);
    expect(row("crypto:BTC").venues.map((v: { venue: string }) => v.venue).sort()).toEqual(["ex", "wallet"]);
    expect(row("rwa:USDY")).toMatchObject({ class: "rwa", amount: 1_500 });
    expect(row("event:SI-FEDCUT-DEC:YES")).toMatchObject({ class: "event", amount: 50 });
    expect(row("stable:USDT").usd).toBeGreaterThan(5_000);
    // the seeded USDT in earn: a row of its own, in the exchange's total, not in what is ready
    expect(row("earn:ex:flex:USDT")).toMatchObject({ class: "earn", amount: 150, usd: 150 });
    expect(h.money.readyUsd).toBeGreaterThan(5_000);
    expect(h.positions.map((p: { symbol: string }) => p.symbol).sort()).toEqual(["BTC/USDT:USDT", "ETH/USDT:USDT", "SI-FEDCUT-DEC:YES"]);
    // the broker's shares — 3 AAPL and 2 NVDA, whether the owner bought the last of them through the door or the broker held them already —
    // and its $2,000 less what those market buys cost
    expect(row("equity:AAPL")).toMatchObject({ class: "equity", amount: 3, venues: [expect.objectContaining({ venue: "broker", amount: 3 })] });
    expect(row("equity:NVDA")).toMatchObject({ class: "equity", amount: 2, venues: [expect.objectContaining({ venue: "broker", amount: 2 })] });
    const orders = (await get("/api/account")).body.orders as Array<{ venue: string; type: string; status: string; filledQty: number; avgPrice?: number }>;
    const spent = orders.filter((o) => o.venue === "broker" && o.type === "market" && o.status === "filled").reduce((t, o) => t + o.filledQty * (o.avgPrice ?? 0), 0);
    expect(row("cash:USD").venues.find((v: { venue: string }) => v.venue === "broker").amount).toBeCloseTo(2_000 - spent, 2);
  });

  it("the net worth curve draws over a week and over a day", async () => {
    const week = await get("/api/account/history?range=1w");
    expect(week.status).toBe(200);
    expect(week.body.points.length).toBeGreaterThanOrEqual(40);
    expect(clockMs - Date.parse(week.body.points[0].at)).toBeGreaterThan(6 * 86_400_000);
    expect((await get("/api/account/history?range=1d")).body.points.length).toBeGreaterThanOrEqual(20);
    expect(s.seeded.curvePoints).toBeGreaterThanOrEqual(70);
  });

  it("the agents: Claude Code with its three limits, its card, its wallet, the intents addressed to it and its asks", async () => {
    const { status, body } = await get("/api/account/agents");
    expect(status).toBe(200);
    const a = body.agents.find((x: { name: string }) => x.name === "Claude Code");
    expect(a).toMatchObject({ status: "ok", address: s.agent.address });
    expect(a.limits.map((l: { scope: string }) => l.scope).sort()).toEqual(["payees", "trade", "venues"]);
    expect(a.limits.find((l: { scope: string }) => l.scope === "trade")).toMatchObject({ perPaymentUsd: 150, budgetUsd: 600, allow: ["ex", "predict", "wallet"] });
    expect(a.cards).toHaveLength(1);
    expect(a.wallets.map((w: { venue: string }) => w.venue)).toEqual([s.seeded.agent.wallet]);
    expect(a.intents).toHaveLength(2);
    expect(a.asks).toHaveLength(2);
    expect(body.mode).toBe("guard");
  });

  it("the browser pairs only with the printed code, then signs as an owner beside the seed key: it answers the agent's card", async () => {
    const jwk = browser.jwk;
    expect((await post("/api/account/pair", { jwk, label: "this browser" })).body).toMatchObject({ ok: true, role: "needs-code" });
    const wrong = await post("/api/account/pair", { jwk, label: "this browser", code: "ZZZZ-ZZZZ" });
    expect([wrong.status, wrong.body.refusal.message]).toEqual([400, expect.stringMatching(/not the pairing code/)]);
    expect((await post("/api/account/pair", { jwk, label: "this browser", code: s.code.toLowerCase() })).body).toMatchObject({ ok: true, role: "owner", kid: browser.kid });
    // the seed key's signature that lets it in is already in the door's line: whatever the browser signs next comes after it
    let a = (await get("/api/account")).body;
    for (let i = 0; i < 40 && a.signers.owners.length < 2; i++) a = (await new Promise((r) => setTimeout(r, 50)), await get("/api/account")).body;
    expect(a.signers.owners.map((o: { id: string }) => o.id).sort()).toEqual([`device:${browser.kid}`, `device:${s.seed.kid}`].sort());
    // let in under the label it paired with
    expect(a.signers.owners.map((o: { label: string }) => o.label).sort()).toEqual(["Stand-in seed key", "this browser"]);
    const card = a.cards[0];
    const answered = await sign({ type: "approveCard", card: card.id, action: card.hash, decision: "approve" });
    expect(answered.status).toBe(200);
    const after = (await get("/api/account")).body;
    expect(after.cards).toHaveLength(0);
    expect(after.orders.find((o: { agent?: string; symbol: string; side: string }) => o.agent === s.agent.address && o.symbol === "ETH/USDT")).toMatchObject({ side: "buy", status: "filled" });
    // a second browser now waits until an owner lets it in
    expect((await post("/api/account/pair", { jwk: simKey("device:ui-standin-second").jwk, label: "another browser" })).body.role).toBe("pending");
  });

  it("Connect to trade from a public row: the browser connects the venue, and the row is then traded there", async () => {
    const r = await sign({ type: "connectVenue", venue: "standin-pubex", connector: "live:standin-pubex", label: "Stand-in Public Exchange", credentialRef: "" });
    expect(r.status).toBe(200);
    const v = (await get("/api/account")).body.venues.find((x: { id: string }) => x.id === "standin-pubex");
    expect(v.trade.kinds).toEqual(["spot"]);
    // a question not asked before: Markets is asked again rather than answered from what it kept
    const doge = (await get("/api/account/explore?q=DOGE")).body.items.find((i: { key: string }) => i.key === "coin:DOGE");
    expect(doge.at).toEqual([expect.objectContaining({ venue: "standin-pubex", connected: true, canTrade: true })]);
  });

  it("the Stand-in Broker by New York's clock: market orders only in the session; closed, Alpaca's words and the next open; both kinds of size", async () => {
    const session = stockSession(clockMs);
    const read = async (symbol: string) => (await get(`/api/account/market?venue=broker&symbol=${symbol}`)).body.market;
    const aapl = await read("AAPL");
    // a fractionable stock: to nine decimals of a share with no smallest size but $1, day or gtc, a cent's step; a sell sells what is held
    expect(aapl).toMatchObject({ kind: "stock", base: "AAPL", quote: "USD", open: true, qtyStep: 1e-9, priceStep: 0.01, minNotional: 1, tifs: ["day", "gtc"], sellsReduce: true });
    expect(aapl.minQty).toBeUndefined();
    // whole shares only: the ticket's "Shares (whole)"
    expect(await read("NVDA")).toMatchObject({ kind: "stock", qtyStep: 1, minQty: 1, open: true });
    if (session.open) {
      expect(aapl.types).toEqual(["market", "limit", "stop", "stop_limit"]);
      expect(aapl.note).toBeUndefined();
    } else {
      expect(aapl.types).toEqual(["limit", "stop", "stop_limit"]);
      expect(aapl.note).toBe(closedWords(session.opensAt));
    }
    // its session is said as Robinhood's is, from the account's market calendar at the stand-in's clock — never read from `open`, which
    // stays true at night: in session and when it closes, or out of it and when it opens
    expect(aapl.session).toEqual(regularSession(clockMs));
    expect(aapl.session).toEqual(session.open ? { open: true, closesAt: new Date(session.closesAt).toISOString() } : { open: false, opensAt: new Date(session.opensAt).toISOString() });
  });

  it("prices move every few seconds, and a resting limit fills when the price comes down to it", async () => {
    const before = s.world.ex.market("BTC/USDT")!.price;
    clockMs += 3_000;
    await s.step();
    expect(s.world.ex.market("BTC/USDT")!.price).not.toBe(before);
    // the owner's SOL limit rests under the market: on the stand-in's own curve, find when SOL comes down past it, and go there
    const order = (await get("/api/account")).body.orders.find((o: { id: string }) => o.id === s.seeded.orders.solLimit);
    expect(order.status).toBe("open");
    let t = clockMs;
    while (s.world.prices.at("SOL", t) > order.limitPrice * 0.996 && t < clockMs + 7 * 86_400_000) t += 60_000;
    expect(t).toBeLessThan(clockMs + 7 * 86_400_000);
    clockMs = t;
    await s.step();
    const filled = (await get("/api/account")).body.orders.find((o: { id: string }) => o.id === s.seeded.orders.solLimit);
    expect(filled).toMatchObject({ status: "filled", filledQty: 0.5 });
  });
});

describe("the Stand-in Broker keeps New York's market hours: a stand-in started while the market is closed, then one while it is open", () => {
  const HOUR = 3_600_000;
  /** the stand-in started again, its clock at `at` */
  const restart = async (at: number) => {
    await s.close();
    clockMs = at;
    s = await startStandin({ port: 0, tickMs: 0, agentMs: 0, clock: () => clockMs });
  };
  /** the seed key (an owner) signs what the account prepared, as the page does */
  const own = async (draft: Record<string, unknown>): Promise<{ status: number; body: any }> => {
    const p = await post("/api/account/prepare", { draft });
    if (p.status !== 200) return p;
    const action = p.body.action as OwnerAction;
    return post("/api/exchange", { action, nonce: action.nonce, signature: signDevice(s.seed, action) });
  };
  const orderOf = async (id: string) => (await get("/api/account")).body.orders.find((o: { id: string }) => o.id === id);
  /** a session wholly ahead of the real clock, so the stand-in's clock never runs behind it (an agent's card is timed by the real one) */
  const ahead = ((now) => (now.open ? stockSession(now.closesAt) : now))(stockSession(Date.now()));

  it("keeps 09:30–16:00 New York time on weekdays, across a daylight-saving change", () => {
    // Tuesday 6 October 2026, 10:00 EDT: open, until 16:00 EDT
    expect(stockSession(Date.parse("2026-10-06T14:00:00Z"))).toEqual({ open: true, opensAt: Date.parse("2026-10-06T13:30:00Z"), closesAt: Date.parse("2026-10-06T20:00:00Z") });
    // Friday 9 October at 16:00: closed, and the next session is Monday's
    expect(stockSession(Date.parse("2026-10-09T20:00:00Z"))).toEqual({ open: false, opensAt: Date.parse("2026-10-12T13:30:00Z"), closesAt: Date.parse("2026-10-12T20:00:00Z") });
    // Saturday 31 October: the next session is Monday 2 November, after the clocks went back — 09:30 EST is 14:30 UTC
    expect(stockSession(Date.parse("2026-10-31T16:00:00Z"))).toEqual({ open: false, opensAt: Date.parse("2026-11-02T14:30:00Z"), closesAt: Date.parse("2026-11-02T21:00:00Z") });
    expect(stockSession(Date.parse("2026-11-02T14:29:00Z")).open).toBe(false);
    // the market's holidays, as the account's calendar keeps them (Robinhood's session is the same calendar's): Thanksgiving is closed, and
    // the next session is Friday's; Columbus Day trades
    expect(stockSession(Date.parse("2026-11-26T16:00:00Z"))).toEqual({ open: false, opensAt: Date.parse("2026-11-27T14:30:00Z"), closesAt: Date.parse("2026-11-27T21:00:00Z") });
    expect(stockSession(Date.parse("2026-10-12T15:00:00Z")).open).toBe(true);
  });

  it("started while it is closed: the shares were held already, no market order is taken, an order is held for the open and fills there; a fraction is a day order", async () => {
    await restart(ahead.closesAt + 2 * HOUR);
    const session = stockSession(clockMs);
    expect(session.open).toBe(false);
    expect([s.seeded.orders.aaplBuy, s.seeded.orders.nvdaBuy]).toEqual([undefined, undefined]);
    expect(await orderOf(s.seeded.orders.spyLimit!)).toMatchObject({ venue: "broker", status: "pending", note: "Stand-in Broker took it" });
    clockMs += 31_000;
    const rows = (await get("/api/account/holdings")).body.rows;
    expect(["equity:AAPL", "equity:NVDA"].map((k) => rows.find((r: { key: string }) => r.key === k)?.amount)).toEqual([3, 2]);
    expect((await get("/api/account/market?venue=broker&symbol=AAPL")).body.market).toMatchObject({ open: true, types: ["limit", "stop", "stop_limit"], note: closedWords(session.opensAt) });
    // out of its session, and when it opens: on the market, and on its Markets row and line, where the broker's words say why
    const closed = { open: false, opensAt: new Date(session.opensAt).toISOString() };
    expect((await get("/api/account/market?venue=broker&symbol=AAPL")).body.market.session).toEqual(closed);
    const row = (await get("/api/account/explore?tab=stocks")).body.items.find((i: { key: string }) => i.key === "stock:AAPL");
    expect(row).toMatchObject({ session: closed, at: [{ venue: "broker", open: true, session: closed, note: closedWords(session.opensAt) }] });
    // the door asks the broker itself: no market order now
    const market = await own({ type: "liveOrder", venue: "broker", symbol: "AAPL", side: "buy", orderType: "market", qty: "0.1" });
    expect([market.status, market.body.refusal?.code]).toEqual([409, "E_VENUE_ORDER_INVALID"]);
    // a fraction of a share is a day order, in the broker's words
    const limitPrice = String(toStep(s.world.broker.market("AAPL")!.ask! * 1.05, 0.01, "ceil"));
    const gtc = await own({ type: "liveOrder", venue: "broker", symbol: "AAPL", side: "buy", orderType: "limit", qty: "0.1", limitPrice, tif: "gtc" });
    expect([gtc.status, gtc.body.refusal?.message]).toEqual([409, expect.stringMatching(/a fraction of a share is a day order, not gtc/)]);
    // a limit over the market is held, not filled, however long the market stays closed
    const held = await own({ type: "liveOrder", venue: "broker", symbol: "AAPL", side: "buy", orderType: "limit", qty: "0.1", limitPrice });
    expect(held.body.order).toMatchObject({ status: "pending" });
    clockMs += HOUR;
    await s.step();
    expect((await orderOf(held.body.order.id)).status).toBe("pending");
    // at the open it goes to the book and takes it, at the opening price; the SPY limit is on the book (or filled) too
    clockMs = session.opensAt + 60_000;
    await s.step();
    const filled = await orderOf(held.body.order.id);
    expect(filled).toMatchObject({ status: "filled", filledQty: 0.1 });
    expect(filled.avgPrice).toBeLessThanOrEqual(Number(limitPrice));
    expect(["open", "filled"]).toContain((await orderOf(s.seeded.orders.spyLimit!)).status);
    expect((await get("/api/account/market?venue=broker&symbol=NVDA")).body.market).toMatchObject({ types: ["market", "limit", "stop", "stop_limit"] });
    expect((await get("/api/account/market?venue=broker&symbol=NVDA")).body.market.note).toBeUndefined();
    // in session now, until 16:00 New York
    expect((await get("/api/account/market?venue=broker&symbol=NVDA")).body.market.session).toEqual({ open: true, closesAt: new Date(session.closesAt).toISOString() });
  });

  it("started while it is open: the owner's market buys fill through the door, a resting limit fills when the price comes down to it, and at the close a day order lapses while a gtc one stays", async () => {
    await restart(ahead.opensAt + 30 * 60_000);
    const session = stockSession(clockMs);
    expect(session.open).toBe(true);
    // in session, until 16:00 New York: on the market and on its Markets row, where the line carries no closed words
    const open = { open: true, closesAt: new Date(session.closesAt).toISOString() };
    expect((await get("/api/account/market?venue=broker&symbol=AAPL")).body.market.session).toEqual(open);
    const row = (await get("/api/account/explore?tab=stocks")).body.items.find((i: { key: string }) => i.key === "stock:AAPL");
    expect(row).toMatchObject({ session: open, at: [{ venue: "broker", open: true, session: open }] });
    expect(row.at[0].note).toBeUndefined();
    for (const [k, qty] of [["aaplBuy", 0.5], ["nvdaBuy", 1]] as const) expect(await orderOf(s.seeded.orders[k]!)).toMatchObject({ venue: "broker", type: "market", status: "filled", filledQty: qty });
    expect(await orderOf(s.seeded.orders.spyLimit!)).toMatchObject({ venue: "broker", status: "open" });
    clockMs += 31_000;
    const rows = (await get("/api/account/holdings")).body.rows;
    expect(["equity:AAPL", "equity:NVDA"].map((k) => rows.find((r: { key: string }) => r.key === k)?.amount)).toEqual([3, 2]);
    // a whole share of Apple (gtc, the broker's default) under the market: on the stand-in's own curve, find a fall of a quarter of a percent
    // later in this session, place the limit just above where it falls to, and go there. No tick in between, so the book is the curve's
    const curve = (t: number) => s.world.prices.at("AAPL", t);
    let t0 = 0;
    let t1 = 0;
    search: for (let a = clockMs; a < session.closesAt - 30 * 60_000; a += 60_000)
      for (let b = a + 60_000; b <= a + 20 * 60_000; b += 60_000)
        if (curve(b) <= curve(a) * 0.9975) {
          [t0, t1] = [a, b];
          break search;
        }
    expect(t1).toBeGreaterThan(0);
    clockMs = t0;
    const limit = toStep(s.world.broker.market("AAPL")!.ask! * (curve(t1) / curve(t0)) * 1.0012, 0.01, "ceil");
    const placed = await own({ type: "liveOrder", venue: "broker", symbol: "AAPL", side: "buy", orderType: "limit", qty: "1", limitPrice: String(limit) });
    expect(placed.body.order).toMatchObject({ status: "open" });
    clockMs = t1;
    s.world.broker.sweep();
    await s.svc.account!.settle();
    expect(await orderOf(placed.body.order.id)).toMatchObject({ status: "filled", filledQty: 1, avgPrice: limit });
    // two NVDA limits far under the market, one day and one gtc: at the close the day one lapses and the gtc one stays on the book
    const far = String(toStep(s.world.broker.market("NVDA")!.bid! * 0.9, 0.01, "floor"));
    const day = await own({ type: "liveOrder", venue: "broker", symbol: "NVDA", side: "buy", orderType: "limit", qty: "1", limitPrice: far, tif: "day" });
    const kept = await own({ type: "liveOrder", venue: "broker", symbol: "NVDA", side: "buy", orderType: "limit", qty: "1", limitPrice: far, tif: "gtc" });
    expect([day.body.order?.status, kept.body.order?.status]).toEqual(["open", "open"]);
    clockMs = session.closesAt + 60_000;
    await s.step();
    expect((await orderOf(day.body.order.id)).status).toBe("expired");
    expect((await orderOf(kept.body.order.id)).status).toBe("open");
    // the seeded SPY limit is a fraction of a share, so a day order: it went with the session, unless the price came down to it first
    expect(["expired", "filled"]).toContain((await orderOf(s.seeded.orders.spyLimit!)).status);
    // closed again: Alpaca's words, with the next session's open, and the session says so
    expect((await get("/api/account/market?venue=broker&symbol=SPY")).body.market.note).toBe(closedWords(stockSession(clockMs).opensAt));
    expect((await get("/api/account/market?venue=broker&symbol=SPY")).body.market.session).toEqual({ open: false, opensAt: new Date(stockSession(clockMs).opensAt).toISOString() });
  });
});
