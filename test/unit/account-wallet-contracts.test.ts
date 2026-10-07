/** The backend contracts the wallet page is built against, on the stand-in account (test/standin/ui-standin.ts) — the real server, door and
 * reads over stand-in venues, nothing leaving the process:
 *
 *   answerAsk           the owner declines an agent's ask: it leaves `asks`, and the agent is shown it was declined for a day
 *   earn in holdings    money in an earn product is a holdings row (class earn) and in the venue's, the live and the net worth totals — once
 *   candles             one market's price history, at a connected venue and from a public source, kept a minute
 *   connector           each venue says the connection it was made with
 *   RWA rows            a wallet's tokenised fund is rwa:USDY in Markets, with its issuer's words, as in holdings
 *   kinds               a trader's own kinds reach the page
 *   agentSetup          the exact command that adds this account's MCP seat
 *   a close's quote     what a close is worth and whether the server's cap lets it go, before anything is signed
 *   a device's label    a device let in keeps the label it paired under
 *   stand-in earn       the Earn tile clicked through: in, done on the next tick, out again
 */
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
/** the seed key (an owner) signs what the account prepared, through the door over HTTP — as the page does */
const own = async (draft: Record<string, unknown>): Promise<{ status: number; body: any }> => {
  const p = await post("/api/account/prepare", { draft });
  if (p.status !== 200) return p;
  const action = p.body.action as OwnerAction;
  return post("/api/exchange", { action, nonce: action.nonce, signature: signDevice(s.seed, action) });
};
/** the stand-in's clock moves, and a venue's balances (read again after thirty seconds) are read afresh */
const later = (ms = 31_000) => void (clockMs += ms);

beforeAll(async () => {
  s = await startStandin({ port: 0, tickMs: 0, agentMs: 0, clock: () => clockMs });
}, 60_000);

afterAll(async () => {
  await s?.close();
});

describe("the owner declines an ask", () => {
  it("takes it off the page's asks, keeps it a day for the agent that asked, logs it, and grants nothing", async () => {
    const before = (await get("/api/account")).body;
    const ask = before.asks.find((x: { kind: string }) => x.kind === "venue");
    expect(ask).toMatchObject({ kind: "venue", venue: "standin-pubex", agent: s.agent.address });
    const prepared = await post("/api/account/prepare", { draft: { type: "answerAsk", ask: ask.id, decision: "decline" } });
    expect(prepared.status).toBe(200);
    // what the owner signs, field for field: the ask and the answer, on the account's own chain (not real money)
    expect(prepared.body.shown).toEqual([{ name: "ask", value: ask.id }, { name: "decision", value: "decline" }, { name: "nonce", value: String(prepared.body.action.nonce) }]);
    expect([prepared.body.primaryType, prepared.body.accountChain]).toEqual(["AccountTransaction:AnswerAsk", "Simulation"]);
    const action = prepared.body.action as OwnerAction;
    const r = await post("/api/exchange", { action, nonce: action.nonce, signature: signDevice(s.seed, action) });
    expect(r.status).toBe(200);
    expect(r.body.summary).toMatch(/declined Claude Code's ask: venue at standin-pubex/);
    const after = (await get("/api/account")).body;
    expect(after.asks.map((x: { id: string }) => x.id)).not.toContain(ask.id);
    expect(after.declinedAsks).toEqual([expect.objectContaining({ id: ask.id, kind: "venue", agent: s.agent.address, declinedAt: expect.any(String) })]);
    // the agents read: its declined asks beside its waiting ones
    const agent = (await get("/api/account/agents")).body.agents.find((a: { name: string }) => a.name === "Claude Code");
    expect(agent.declinedAsks.map((x: { id: string }) => x.id)).toEqual([ask.id]);
    // the venue was not connected, and no limit moved: a decline grants nothing
    expect(after.venues.map((v: { id: string }) => v.id)).not.toContain("standin-pubex");
    expect(after.spend).toEqual(before.spend);
    expect(s.svc.ledgerRows().find((row) => row.tool === "answerAsk" && row.outcome === "ok")).toMatchObject({ native: { ask: ask.id, kind: "venue" } });
    // declined once is declined: the same ask is not there to decline again
    const again = await own({ type: "answerAsk", ask: ask.id, decision: "decline" });
    expect([again.status, again.body.refusal.code]).toEqual([409, "E_ACCOUNT_BAD_ACTION"]);
    expect(again.body.refusal.message).toMatch(/no waiting ask/);
  });

  it("answers only with decline, and only a waiting ask", async () => {
    const ask = (await get("/api/account")).body.asks[0];
    const grant = await own({ type: "answerAsk", ask: ask.id, decision: "grant" });
    expect([grant.status, grant.body.refusal.message]).toEqual([409, expect.stringMatching(/granting it is the owner's own action/)]);
    expect((await own({ type: "answerAsk", ask: "ask-9999", decision: "decline" })).body.refusal.code).toBe("E_ACCOUNT_BAD_ACTION");
    // a field the type does not sign is refused before anything is shown
    expect((await post("/api/account/prepare", { draft: { type: "answerAsk", ask: ask.id, decision: "decline", venue: "ex" } })).body.refusal.message).toMatch(/"venue" is not part of what "answerAsk" signs/);
    expect((await get("/api/account")).body.asks.map((x: { id: string }) => x.id)).toContain(ask.id);
  });

});

describe("money in an earn product, in holdings and the totals", () => {
  it("is a holdings row of class earn — once: what is in earn is not also in the exchange's balance", async () => {
    // the seeded supply is done on the next tick
    await s.step();
    later();
    const h = (await get("/api/account/holdings")).body;
    const row = h.rows.find((r: { key: string }) => r.key === "earn:ex:flex:USDT");
    expect(row).toMatchObject({ class: "earn", asset: "USDT", amount: 150, usd: 150, earn: { venue: "ex", product: "flex:USDT", asset: "USDT", apy: 0.046 } });
    expect(row.venues).toEqual([expect.objectContaining({ venue: "ex", amount: 150, note: expect.stringMatching(/^earning 4\.6% at Stand-in Exchange/) })]);
    // not ready to trade or move: not in the dollars that are ready
    expect(h.money.venues.find((v: { venue: string }) => v.venue === "ex").lines.map((l: { asset: string }) => l.asset)).not.toContain("earn");
    // a dollar in earn changes by nothing in 24 hours: it is covered
    expect(h.change24h.missing).not.toContain("earn:ex:flex:USDT");
    const a = (await get("/api/account")).body;
    const ex = a.venues.find((v: { id: string }) => v.id === "ex");
    expect(ex.holdings.filter((x: { class: string }) => x.class === "earn")).toEqual([expect.objectContaining({ asset: "USDT", amount: 150, usd: 150, earn: expect.objectContaining({ product: "flex:USDT" }) })]);
    expect(ex.usd).toBeCloseTo(ex.holdings.reduce((t: number, x: { usd: number }) => t + x.usd, 0), 2);
    expect(a.liveUsd).toBeCloseTo(a.venues.filter((v: { live?: boolean }) => v.live).reduce((t: number, v: { usd: number }) => t + v.usd, 0), 2);
  });

  it("money put in or taken out is counted once all along: the page's USDT at the exchange is what its books hold, spot, futures and earn", async () => {
    // the stand-in's own books, and the page read right then (a venue's balance is read again after thirty seconds, its earn with it)
    const books = () => s.world.ex.bal("spot", "USDT") + s.world.ex.bal("futures", "USDT") + (s.world.earn.held.get("flex:USDT") ?? 0);
    const counted = async () => {
      later();
      const a = (await get("/api/account")).body;
      return (a.venues.find((v: { id: string }) => v.id === "ex").holdings as Array<{ asset: string; usd: number }>).filter((x) => x.asset === "USDT").reduce((t, x) => t + x.usd, 0);
    };
    const same = async () => expect(await counted()).toBeCloseTo(books(), 1);
    await same();
    const spot = s.world.ex.bal("spot", "USDT");
    const put = await own({ type: "liveEarn", venue: "ex", kind: "supply", product: "flex:USDT", asset: "USDT", amount: "100" });
    expect(put.status).toBe(200);
    expect(put.body.result.earn).toMatchObject({ kind: "supply", amount: 100, status: "pending" });
    // out of spot at once, into the product (the venue counts it there while it is under way): counted once
    expect(s.world.ex.bal("spot", "USDT")).toBeCloseTo(spot - 100, 6);
    await same();
    await s.step();
    await same();
    const out = await own({ type: "liveEarn", venue: "ex", kind: "withdraw", product: "flex:USDT", asset: "USDT", amount: "100" });
    expect(out.status).toBe(200);
    await same();
    await s.step();
    await same();
    later();
    expect((await get("/api/account/holdings")).body.rows.find((r: { key: string }) => r.key === "earn:ex:flex:USDT")).toMatchObject({ amount: 150 });
  });

  it("a net worth point counts it, by class and by venue", async () => {
    later();
    const page = await s.svc.accountView();
    const snap = await s.svc.snapshot();
    expect(snap).toMatchObject({ written: true });
    // the point is the page's total then: what is in earn is in it, once
    const last = (await get("/api/account/history?range=1d")).body.points.at(-1);
    expect(Math.abs(last.usd - page!.totalUsd) / page!.totalUsd).toBeLessThan(0.01);
    expect(page!.venues.find((v) => v.id === "ex")!.holdings.some((x) => x.class === "earn")).toBe(true);
  });
});

describe("one market's price history", () => {
  it("at a connected venue, from its trader; from a public source, without a key", async () => {
    const c = await get("/api/account/candles?venue=ex&symbol=BTC/USDT&interval=1h");
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ ok: true, venue: "ex", venueName: "Stand-in Exchange", symbol: "BTC/USDT", interval: "1h" });
    expect(c.body.candles.length).toBeGreaterThan(100);
    expect(c.body.candles[0]).toEqual({ t: expect.any(Number), o: expect.any(Number), h: expect.any(Number), l: expect.any(Number), c: expect.any(Number), v: expect.any(Number) });
    expect(c.body.public).toBeUndefined();
    const pub = await get(`/api/account/candles?venue=standin-pubex-public&symbol=${encodeURIComponent("DOGE/USD")}&interval=5m`);
    expect(pub.body).toMatchObject({ ok: true, venue: "standin-pubex-public", symbol: "DOGE/USD", interval: "5m", public: true });
    expect(pub.body.candles.length).toBeGreaterThan(10);
    const ev = await get(`/api/account/candles?venue=standin-pubevents-public&symbol=${encodeURIComponent("SX-JOBS-NEXT:YES")}&interval=1d`);
    expect(ev.body.candles.every((b: { c: number }) => b.c > 0 && b.c < 1)).toBe(true);
  });

  it("refuses what it cannot answer, in words", async () => {
    const no = async (q: string) => (await get(`/api/account/candles?${q}`)).body.refusal;
    expect((await no("venue=ex&symbol=BTC/USDT&interval=4h")).message).toMatch(/5m, 1h, 1d/);
    expect((await no("venue=nowhere&symbol=BTC/USDT&interval=1h")).code).toBe("E_WALLET_ACCOUNT_UNKNOWN");
    expect((await no("venue=standin-stock-tokens&symbol=NVDA&interval=1h")).message).toMatch(/publishes no price history/);
    expect((await no("venue=ex&symbol=NOPE/USDT&interval=1h")).code).toBe("E_VENUE_REJECTED");
  });
});

describe("what the page reads of each venue", () => {
  it("each venue's connector, the trader's own kinds, the RWA rows and the command that adds an agent's seat", async () => {
    const a = (await get("/api/account")).body;
    const venue = (id: string) => a.venues.find((v: { id: string }) => v.id === id);
    expect([venue("ex").connector, venue("predict").connector, venue("wallet").connector, venue(s.seeded.agent.wallet).connector]).toEqual(["live:standin-exchange", "live:standin-events", "live:standin-wallet", "live:agent-wallet"]);
    // the stand-in connectors are in no table: these kinds are the traders' own
    expect([venue("ex").trade.kinds, venue("predict").trade.kinds, venue("wallet").trade.kinds]).toEqual([["spot", "perp"], ["event"], ["token"]]);
    expect(a.agentSetup.url).toBe(s.url);
    expect(a.agentSetup.command).toMatch(new RegExp(`^claude mcp add portfolio -e PORTFOLIO_URL=${s.url.replace(/[.]/g, "\\.")} -- npx tsx /.+/src/portfolio/mcp\\.ts$`));
    const e = (await get("/api/account/explore?tab=rwas")).body;
    const usdy = e.items.find((i: { key: string }) => i.key === "rwa:USDY");
    expect(usdy).toMatchObject({ kind: "rwa", issuer: "Stand-in Issuer (not a real issuer)", eligibility: expect.stringMatching(/not for US persons/) });
    expect(usdy.at).toEqual([expect.objectContaining({ venue: "wallet", connected: true, canTrade: true, symbol: "USDY/USDC@Ethereum", issuer: "Stand-in Issuer (not a real issuer)" })]);
    expect(e.items.find((i: { key: string }) => i.key === "coin:USDY")).toBeUndefined();
    later();
    expect((await get("/api/account/holdings")).body.rows.find((r: { key: string }) => r.key === "rwa:USDY")).toMatchObject({ class: "rwa" });
  });

  it("an RWA buy routes to the wallet, and lands on the same rwa:USDY row", async () => {
    later();
    const before = (await get("/api/account/holdings")).body.rows.find((r: { key: string }) => r.key === "rwa:USDY").amount as number;
    const r = await own({ type: "liveOrder", venue: "wallet", symbol: "USDY/USDC@Ethereum", side: "buy", orderType: "market", qty: "10" });
    expect(r.status).toBe(200);
    expect(r.body.order).toMatchObject({ symbol: "USDY/USDC@Ethereum", status: "filled" });
    later();
    expect((await get("/api/account/holdings")).body.rows.find((r: { key: string }) => r.key === "rwa:USDY").amount).toBeCloseTo(before + 10, 6);
  });
});

describe("a close's quote", () => {
  it("says what a close is worth and whether the server's cap lets it go, before anything is signed", async () => {
    // the BTC long the exchange already held (0.01 BTC, about $625) is over the stand-in's $250 cap; the ETH long is not
    const over = await post("/api/account/prepare", { draft: { type: "liveClose", venue: "ex", symbol: "BTC/USDT:USDT", qty: "" } });
    expect(over.status).toBe(200);
    expect(over.body.quote.close).toMatchObject({ side: "sell", qty: 0.01, capUsd: 250, overCap: true, why: expect.stringMatching(/more than the most one order may be/) });
    expect(over.body.quote.close.worthUsd).toBeGreaterThan(250);
    expect(over.body.quote.close.worstPrice).toBeLessThan(over.body.quote.close.price);
    expect(over.body.action).toMatchObject({ type: "liveClose", venue: "ex", symbol: "BTC/USDT:USDT", qty: "" });
    // the door holds it to the same cap
    const action = over.body.action as OwnerAction;
    const refused = await post("/api/exchange", { action, nonce: action.nonce, signature: signDevice(s.seed, action) });
    expect([refused.status, refused.body.refusal.code]).toEqual([409, "E_ACCOUNT_LIMIT"]);
    const part = await post("/api/account/prepare", { draft: { type: "liveClose", venue: "ex", symbol: "BTC/USDT:USDT", qty: "0.003" } });
    expect(part.body.quote.close).toMatchObject({ qty: 0.003, overCap: false });
    expect(part.body.quote.close.why).toBeUndefined();
    expect(part.body.action.qty).toBe("0.003");
    const none = await post("/api/account/prepare", { draft: { type: "liveClose", venue: "ex", symbol: "DOGE/USDT:USDT", qty: "" } });
    expect(none.body.refusal.message).toMatch(/no position in DOGE/);
  });
});

describe("a device let in", () => {
  it("keeps the label it paired under", async () => {
    const phone = simKey("device:contracts-phone");
    expect((await post("/api/account/pair", { jwk: phone.jwk, label: "this browser" })).body.role).toBe("needs-code");
    // the stand-in's first browser pairs with the code and becomes an owner beside the seed key, under its own label
    expect((await post("/api/account/pair", { jwk: phone.jwk, label: "Safari on this Mac", code: s.code })).body.role).toBe("owner");
    let a = (await get("/api/account")).body;
    for (let i = 0; i < 40 && a.signers.owners.length < 2; i++) a = (await new Promise((r) => setTimeout(r, 50)), await get("/api/account")).body;
    expect(a.signers.owners.map((o: { label: string }) => o.label).sort()).toEqual(["Safari on this Mac", "Stand-in seed key"]);
  });
});

describe("the stand-in's earn", () => {
  it("offers two products, shows what is in them, and finishes each request on the next tick", async () => {
    const e = (await get("/api/account/earn")).body;
    expect(e.products.map((p: { id: string; asset: string; lockDays: number }) => [p.id, p.asset, p.lockDays]).sort()).toEqual([["bond:ETH", "ETH", 7], ["flex:USDT", "USDT", 0]]);
    expect(e.positions).toEqual([expect.objectContaining({ venue: "ex", product: "flex:USDT", amount: 150 })]);
    const put = await own({ type: "liveEarn", venue: "ex", kind: "supply", product: "bond:ETH", asset: "ETH", amount: "0.05" });
    expect(put.body.result.earn).toMatchObject({ product: "bond:ETH", status: "pending" });
    await s.step();
    // the door asks how a pending request stands every fifteen seconds
    clockMs += 16_000;
    await s.svc.account!.settle();
    expect(s.svc.account!.earns.find((x) => x.id === put.body.result.earn.id)?.status).toBe("done");
    later();
    const row = (await get("/api/account/holdings")).body.rows.find((r: { key: string }) => r.key === "earn:ex:bond:ETH");
    expect(row).toMatchObject({ class: "earn", asset: "ETH", amount: 0.05 });
    expect(row.usd).toBeGreaterThan(50);
  });
});
