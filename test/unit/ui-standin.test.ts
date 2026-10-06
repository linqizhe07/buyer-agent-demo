/** The stand-in account (test/standin/ui-standin.ts), started in-process on a free port with its own clock: what the page reads is what was
 * seeded through the door — the venues, the agent with its limits, wallet, card, intents and asks, Markets with public rows and a venue's own
 * geoblock words, Portfolio by asset, the net worth curve over seven days — and the owner's browser pairs with the printed code, then signs
 * as an owner: it answers the agent's card and connects a venue from a public row. Prices move, and a resting order fills when the price
 * comes down to it. Nothing leaves the process. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signDevice, simKey, type OwnerAction } from "../../src/portfolio/account/sign.ts";
import { startStandin, type Standin } from "../standin/ui-standin.ts";

let clockMs = Date.now();
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
    expect(e.tabs.map((t: { id: string }) => t.id)).toEqual(expect.arrayContaining(["now", "crypto", "rwas", "predictions", "perps", "macro", "sports"]));
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
    expect(body.mode).toBe("Conservative");
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
