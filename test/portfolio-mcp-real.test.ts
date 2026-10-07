/** The MCP seat against an account that holds REAL accounts only — a stand-in venue in their place: the seat's own key (made in the home,
 * not derived from its name), the order space (a stop, a close, positions), waiting for the owner instead of asking again, the statement. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cardHash } from "../src/portfolio/account/exchange.ts";
import { signOwner, simKey, type OwnerAction } from "../src/portfolio/account/sign.ts";
import { no } from "../src/portfolio/refuse.ts";
import { register } from "../src/portfolio/live/index.ts";
import type { LiveTrader, Market, OrderState, Position } from "../src/portfolio/live/trade.ts";
import type { EarnProduct, LiveEarner } from "../src/portfolio/live/earn.ts";
import { startPortfolioServer, type PortfolioServerHandle } from "../src/portfolio/server.ts";
import { PortfolioService } from "../src/portfolio/service.ts";

type NoNonce<T> = T extends unknown ? Omit<T, "nonce"> : never;
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DAY = 86_400_000;
const owner = simKey("owner");

const PERP: Market = { symbol: "ETH/USDT:USDT", name: "ETH perpetual", kind: "perp", base: "ETH", quote: "USDT", price: 3000, bid: 2999, ask: 3001, minQty: 0.01, qtyStep: 0.01, priceStep: 0.1, open: true, types: ["market", "limit", "stop", "stop_limit"], tifs: ["gtc", "ioc"], reduceOnly: true };
const states = new Map<string, OrderState>();
let placed = 0;
const trader: LiveTrader = {
  can: true,
  what: "perpetuals",
  async markets() {
    return [PERP];
  },
  async market(symbol) {
    return symbol === PERP.symbol ? { ...PERP } : no("E_VENUE_REJECTED", { venue: "ex", message: `no market ${symbol}` });
  },
  async place(o) {
    const ref = `x-${++placed}`;
    const s: OrderState = o.type === "market" ? { ref, status: "filled", filledQty: o.qty, avgPrice: 2999, native: {} } : { ref, status: "open", filledQty: 0, native: {} };
    states.set(ref, s);
    return s;
  },
  async cancel(ref) {
    return { ...states.get(ref)!, status: "canceled" };
  },
  async status(ref) {
    return states.get(ref)!;
  },
  async positions(): Promise<Position[]> {
    return [{ symbol: PERP.symbol, name: PERP.name, kind: "perp", side: "long", qty: 0.4, entryPrice: 2900, markPrice: 3000, usd: 1200, unrealizedUsd: 40, native: {} }];
  },
  async candles(symbol) {
    return symbol === PERP.symbol ? [{ t: Date.now() - 3_600_000, o: 2990, h: 3010, l: 2980, c: 3000, v: 12 }] : no("E_VENUE_REJECTED", { venue: "ex", message: `no market ${symbol}` });
  },
};
/** its earn: one product, something held in it, and every request it is asked to run */
const SAVINGS: EarnProduct = { id: "savings:USDT", asset: "USDT", name: "USDT · Simple Earn Flexible", apy: 0.06, rateKind: "apr", lockDays: 0, priceUsd: 1, lands: "your Exchange funding account", canSupply: true, canWithdraw: true };
const earned: Array<{ kind: string; product: string; amount: number }> = [];
const earner: LiveEarner = {
  can: true,
  what: "Simple Earn",
  products: async () => [{ ...SAVINGS }],
  product: async (id) => (id === SAVINGS.id ? { ...SAVINGS } : no("E_VENUE_REJECTED", { venue: "ex", message: `no product ${id}` })),
  positions: async () => [{ product: SAVINGS.id, id: SAVINGS.id, asset: "USDT", amount: 40, usd: 40, apy: 0.06 }],
  async supply(p, amount) {
    earned.push({ kind: "supply", product: p.id, amount });
    return { ref: `s-${earned.length}`, status: "done", native: {} };
  },
  async withdraw(p, amount) {
    earned.push({ kind: "withdraw", product: p.id, amount });
    return { ref: `w-${earned.length}`, status: "done", native: {} };
  },
};
register({ kind: "standin-mcp-real", label: "a venue for the MCP seat", needs: "key-file", example: "", venues: [], async open(req) {
  return { source: { name: req.label || "Exchange", kind: "cex", reference: "standin", via: "a stand-in", probe: { can: ["read", "trade"], note: "" }, read: async () => [{ asset: "USDT", amount: 5000, usd: 5000 }], trader, readOnlyBecause: "the stand-in moves no money", earner } as never, first: [], summary: "connected" };
} });

let home: string;
let svc: PortfolioService;
let server: PortfolioServerHandle;
let client: Client;
/** a second seat, another harness on the same account */
let second: Client | undefined;
let n = 0;
const START = Date.now();
const own = async (a: NoNonce<OwnerAction>) => svc.exchange(await signOwner(owner, { ...a, nonce: Date.now() + ++n } as OwnerAction));
const tool = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { error: r.isError === true, body: JSON.parse((r.content as Array<{ text: string }>)[0]!.text) as Record<string, any> };
};

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "portfolio-mcp-real-"));
  // no public market data is read from here: Markets shows the connected venue only
  svc = await PortfolioService.create({ home, venues: "frontline", real: true, liveWrites: { capUsd: 5000, pairingCode: "K7QX-M2PA" }, publicMarkets: [], liveDeps: { http: async () => ({ status: 599, body: undefined, text: "" }), price: async () => undefined }, account: { owners: [{ id: owner.address, kind: "eoa", label: "owner", addedAt: new Date(START).toISOString() }] } });
  server = await startPortfolioServer({ port: 0, service: svc });
  await own({ type: "connectVenue", venue: "ex", connector: "live:standin-mcp-real", label: "Exchange", credentialRef: "" });
  client = new Client({ name: "vitest", version: "0" });
  // no PORTFOLIO_SEAT_KEYS: the seat makes its own key, in this home
  await client.connect(new StdioClientTransport({ command: join(ROOT, "node_modules", ".bin", "tsx"), args: [join(ROOT, "src", "portfolio", "mcp.ts")], env: { ...(process.env as Record<string, string>), PORTFOLIO_URL: server.url, PORTFOLIO_AGENT: "DeepSeek Harness", BUYER_HOME: home }, stderr: "ignore" }));
}, 30_000);

afterAll(async () => {
  await client?.close();
  await second?.close();
  await server?.close();
  rmSync(home, { recursive: true, force: true });
});

describe("an agent harness on the real account, through the MCP seat", () => {
  it("has a key of its own, kept in the home — not one anyone could derive from its name", async () => {
    const names = (await client.listTools()).tools.map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(["portfolio_live_order", "portfolio_live_amend", "portfolio_live_positions", "portfolio_live_close", "portfolio_live_leverage", "portfolio_wait", "portfolio_statement", "portfolio_pay"]));
    const a = await tool("portfolio_account");
    const path = join(home, "seats", "deepseek-harness.json");
    expect([existsSync(path), statSync(path).mode & 0o777]).toEqual([true, 0o600]);
    expect(a.body.seat.key).not.toBe(simKey("agent:deepseek-harness").address);
    expect(a.body.seat.authorised).toBe(false);
  });

  it("places a stop inside its limit, waits for the owner's answer instead of asking again, reads positions and closes one", async () => {
    const key = (await tool("portfolio_account")).body.seat.key as `0x${string}`;
    await own({ type: "approveAgent", agentAddress: key, agentName: "DeepSeek Harness", validUntil: Date.now() + 30 * DAY });
    await own({ type: "approveSpend", agent: key, scope: "trade", allow: "ex", perPayment: "2000", budget: "4000", windowHours: 0, validUntil: Date.now() + 7 * DAY });
    // Guard: a card; the harness waits on it while the owner answers
    const asked = await tool("portfolio_live_order", { venue: "ex", symbol: PERP.symbol, side: "sell", orderType: "stop", stopPrice: 2800, qty: 0.2, reduceOnly: true });
    expect(asked.body).toMatchObject({ ok: true, pending: true });
    const id = asked.body.card.id as string;
    setTimeout(() => void own({ type: "approveCard", card: id, action: cardHash(svc.account!.host.card(id)!), decision: "approve" }), 1200);
    const waited = await tool("portfolio_wait", { card: id, timeoutSec: 10 });
    expect(waited.body).toMatchObject({ ok: true, changed: true, done: true, now: { status: "approved" } });
    const order = (waited.body.now as { outcome: { order: { id: string; type: string; stopPrice: number; reduceOnly: boolean; status: string } } }).outcome.order;
    expect([order.type, order.stopPrice, order.reduceOnly, order.status]).toEqual(["stop", 2800, true, "open"]);
    // positions, and a close: in Guard a card like any order (the position may be the owner's own), which the harness waits on
    expect((await tool("portfolio_live_positions", { venue: "ex" })).body.positions).toMatchObject([{ symbol: PERP.symbol, side: "long", qty: 0.4 }]);
    const closing = await tool("portfolio_live_close", { venue: "ex", symbol: PERP.symbol });
    expect(closing.body).toMatchObject({ ok: true, pending: true });
    const closeCard = closing.body.card.id as string;
    setTimeout(() => void own({ type: "approveCard", card: closeCard, action: cardHash(svc.account!.host.card(closeCard)!), decision: "approve" }), 800);
    const closed = await tool("portfolio_wait", { card: closeCard, timeoutSec: 10 });
    expect(closed.body).toMatchObject({ ok: true, done: true, now: { status: "approved", outcome: { order: { side: "sell", qty: 0.4, status: "filled" } } } });
    // leverage: this venue sets none
    expect((await tool("portfolio_live_leverage", { venue: "ex", symbol: PERP.symbol, leverage: 2 })).body.code).toBe("E_VENUE_RAIL_CLOSED");
    // the statement, only this seat's lines
    const st = await tool("portfolio_statement", { mine: true });
    expect(st.body.lines.map((l: { kind: string; status: string }) => [l.kind, l.status])).toEqual([["sell", "filled"], ["sell", "open"]]);
  }, 30_000);
});

/** another seat on the same account, under its own client name: its own key in the home */
async function seat(name: string): Promise<(tool: string, args?: Record<string, unknown>) => Promise<{ error: boolean; body: Record<string, any> }>> {
  second = new Client({ name: "vitest-2", version: "0" });
  await second.connect(new StdioClientTransport({ command: join(ROOT, "node_modules", ".bin", "tsx"), args: [join(ROOT, "src", "portfolio", "mcp.ts")], env: { ...(process.env as Record<string, string>), PORTFOLIO_URL: server.url, PORTFOLIO_AGENT: name, BUYER_HOME: home }, stderr: "ignore" }));
  const c = second;
  return async (tool, args = {}) => {
    const r = await c.callTool({ name: tool, arguments: args });
    return { error: r.isError === true, body: JSON.parse((r.content as Array<{ text: string }>)[0]!.text) as Record<string, any> };
  };
}

describe("the wallet through the MCP seat: what the page reads, steering, a preview, a batch", () => {
  it("reads what the page reads — markets, holdings, the curve, one asset, where to receive — with the same answers as over HTTP", async () => {
    const names = (await client.listTools()).tools.map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(["portfolio_explore", "portfolio_holdings", "portfolio_history", "portfolio_asset", "portfolio_receive", "portfolio_watchlist", "portfolio_report", "portfolio_ask", "portfolio_live_preview", "portfolio_live_batch"]));
    const http = async (path: string) => (await fetch(`${server.url}${path}`)).json() as Promise<Record<string, any>>;
    const explored = await tool("portfolio_explore", {});
    expect(explored.body.items).toEqual((await http("/api/account/explore?limit=30")).items);
    expect(explored.body.items.map((i: { key: string }) => i.key)).toContain("perp:ETH");
    const held = await tool("portfolio_holdings", {});
    const page = await http("/api/account/holdings");
    expect([held.body.rows, held.body.money]).toEqual([page.rows, page.money]);
    expect((await tool("portfolio_history", { range: "1d" })).body.events.map((e: { kind: string; venue: string }) => `${e.kind}:${e.venue}`)).toContain("connect:ex");
    const asset = await tool("portfolio_asset", { key: "stable:USDT" });
    expect(asset.body.row).toEqual((await http("/api/account/asset?key=stable:USDT&interval=1h")).row);
    // the stand-in moves no money: there is no address to send it
    expect((await tool("portfolio_receive", { venue: "ex", asset: "USDT", network: "Arbitrum" })).body).toMatchObject({ ok: false, code: "E_VENUE_RAIL_CLOSED" });
  }, 30_000);

  it("previews an order without placing it: the price, what is left of its limit, and that it would be a card — or why it would be refused", async () => {
    const before = { placed, orders: svc.account!.orders.length, cards: svc.account!.host.cards().length };
    const p = await tool("portfolio_live_preview", { order: { venue: "ex", symbol: PERP.symbol, side: "buy", orderType: "limit", limitPrice: 2900, qty: 0.1 } });
    // the mode as every read wires it: guard (Guard) or open (Beast)
    expect(p.body).toMatchObject({ ok: true, placed: "nothing", worthUpToUsd: 290, mode: "guard", wouldBe: "card", limit: { scope: "trade", perOrderUsd: 2000 } });
    expect(typeof p.body.limit.leftUsd).toBe("number");
    const big = await tool("portfolio_live_preview", { order: { venue: "ex", symbol: PERP.symbol, side: "buy", orderType: "limit", limitPrice: 2900, qty: 1 } });
    expect(big.body).toMatchObject({ wouldBe: "refused" });
    expect(big.body.why).toMatch(/more than the \$2000 one order may be/);
    expect((await tool("portfolio_live_preview", {})).error).toBe(true);
    expect({ placed, orders: svc.account!.orders.length, cards: svc.account!.host.cards().length }).toEqual(before);
  }, 30_000);

  it("two seats each see only their own; a seat not let in knocks once by name; its statement is matched by its key, whatever the owner named it", async () => {
    const codex = await seat("Codex CLI");
    const a = await codex("portfolio_account");
    expect(a.body.seat.authorised).toBe(false);
    const key2 = a.body.seat.key as `0x${string}`;
    expect(svc.account!.state.requests).toEqual(expect.arrayContaining([expect.objectContaining({ address: key2, name: "Codex CLI" })]));
    const key1 = (await tool("portfolio_account")).body.seat.key as `0x${string}`;
    // the owner lets it in under ANOTHER name, and gives it a trading limit
    await own({ type: "approveAgent", agentAddress: key2, agentName: "Codex", validUntil: Date.now() + 30 * DAY });
    await own({ type: "approveSpend", agent: key2, scope: "trade", allow: "ex", perPayment: "1000", budget: "2000", windowHours: 0, validUntil: Date.now() + 7 * DAY });
    for (const [agent, text] of [[key1, "for deepseek"], ["*", "for everyone"], [key2, "for codex"]] as const) await own({ type: "setIntent", id: "", agent, venue: "ex", symbol: PERP.symbol, side: "buy", usd: "100", text, validUntil: Date.now() + DAY });
    const w1 = await tool("portfolio_watchlist");
    const w2 = await codex("portfolio_watchlist");
    expect(w1.body.intents.map((i: { ownerSaid: string }) => i.ownerSaid).sort()).toEqual(["for deepseek", "for everyone"]);
    expect(w2.body.intents.map((i: { ownerSaid: string }) => i.ownerSaid).sort()).toEqual(["for codex", "for everyone"]);
    // a report on an intent addressed to this seat is taken; one on another seat's is not
    const mine = w1.body.intents.find((i: { ownerSaid: string }) => i.ownerSaid === "for deepseek").id as string;
    expect((await tool("portfolio_report", { intent: mine, status: "taking", note: "watching the book" })).body.ok).toBe(true);
    expect((await codex("portfolio_report", { intent: mine, status: "done" })).body.ok).toBe(false);
    expect((await codex("portfolio_ask", { kind: "limit", venue: "ex", usd: 5000, text: "a bigger budget" })).body.ok).toBe(true);
    expect((await tool("portfolio_watchlist")).body.myAsks).toEqual([]);
    expect((await codex("portfolio_watchlist")).body.myAsks.map((x: { kind: string }) => x.kind)).toEqual(["limit"]);
    // codex's order waits on a card: codex sees it, the first seat only counts it
    const asked = await codex("portfolio_live_order", { venue: "ex", symbol: PERP.symbol, side: "buy", orderType: "limit", limitPrice: 2900, qty: 0.1 });
    expect(asked.body).toMatchObject({ ok: true, pending: true });
    const id = asked.body.card.id as string;
    expect((await codex("portfolio_account")).body.waitingForOwner.map((c: { id: string }) => c.id)).toEqual([id]);
    const first = (await tool("portfolio_account")).body;
    expect(first.waitingForOwner.map((c: { id: string }) => c.id)).not.toContain(id);
    expect(first.othersWaiting).toBeGreaterThanOrEqual(1);
    await own({ type: "approveCard", card: id, action: cardHash(svc.account!.host.card(id)!), decision: "approve" });
    const st = await codex("portfolio_statement", { mine: true });
    expect(st.body.lines.map((l: { kind: string; status: string; agentName: string }) => [l.kind, l.status, l.agentName])).toEqual([["buy", "open", "Codex"]]);
    expect((await tool("portfolio_statement", { mine: true })).body.lines.every((l: { agent?: string }) => l.agent === key1)).toBe(true);
  }, 60_000);

  it("a batch of orders: one signed instruction and one answer each; a leg that is wrong is answered on its own", async () => {
    const b = await tool("portfolio_live_batch", { legs: [{ venue: "ex", symbol: PERP.symbol, side: "buy", orderType: "limit", limitPrice: 2900, qty: 0.1 }, { venue: "ex", symbol: PERP.symbol, side: "buy", orderType: "limit", limitPrice: 2900 }, { venue: "ex", symbol: PERP.symbol, side: "buy", orderType: "limit", limitPrice: 2800, qty: 0.2 }] });
    expect(b.body.legs.map((l: { leg: number; ok: boolean; pending?: boolean }) => [l.leg, l.ok, l.pending ?? false])).toEqual([[1, true, true], [2, false, false], [3, true, true]]);
    expect(b.body.legs[1].error).toMatch(/give the size once/);
    expect(b.body.legs[0].card.id).not.toBe(b.body.legs[2].card.id);
  }, 30_000);
});

describe("earn through the MCP seat", () => {
  it("reads what is offered and held with the same answers as over HTTP; puts money in only inside its earn limit, on the owner's card in Guard", async () => {
    const names = (await client.listTools()).tools.map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(["portfolio_earn", "portfolio_live_earn"]));
    const http = async (path: string) => (await fetch(`${server.url}${path}`)).json() as Promise<Record<string, any>>;
    const offered = await tool("portfolio_earn", {});
    const page = await http("/api/account/earn");
    expect([offered.body.products, offered.body.positions, offered.body.missing]).toEqual([page.products, page.positions, []]);
    expect(offered.body.products.map((p: { venue: string; id: string; apy: number; lands: string }) => [p.venue, p.id, p.apy, p.lands])).toEqual([["ex", "savings:USDT", 0.06, "your Exchange funding account"]]);
    expect((await tool("portfolio_earn", { asset: "USDC" })).body.products).toEqual([]);
    // a trading limit is not an earn limit
    expect((await tool("portfolio_live_earn", { venue: "ex", kind: "supply", product: "savings:USDT", asset: "USDT", amount: 25 })).body).toMatchObject({ ok: false, code: "E_MANDATE_NONE" });
    const key = (await tool("portfolio_account")).body.seat.key as `0x${string}`;
    await own({ type: "approveSpend", agent: key, scope: "earn", allow: "ex", perPayment: "50", budget: "100", windowHours: 0, validUntil: Date.now() + 7 * DAY });
    expect((await tool("portfolio_account")).body.approvals.map((x: { scope: string }) => x.scope)).toContain("earn");
    const asked = await tool("portfolio_live_earn", { venue: "ex", kind: "supply", product: "savings:USDT", asset: "USDT", amount: 25 });
    expect(asked.body).toMatchObject({ ok: true, pending: true, card: { usd: 25 } });
    expect(earned).toEqual([]);
    const id = asked.body.card.id as string;
    setTimeout(() => void own({ type: "approveCard", card: id, action: cardHash(svc.account!.host.card(id)!), decision: "approve" }), 800);
    const waited = await tool("portfolio_wait", { card: id, timeoutSec: 10 });
    expect(waited.body).toMatchObject({ ok: true, done: true, now: { status: "approved", outcome: { result: { earn: { kind: "supply", product: "savings:USDT", amount: 25, status: "done" } } } } });
    expect(earned).toEqual([{ kind: "supply", product: "savings:USDT", amount: 25 }]);
    // the statement says it, under this seat's key
    const lines = (await tool("portfolio_statement", { mine: true })).body.lines as Array<{ type: string; kind: string; agent?: string }>;
    expect(lines.filter((l) => l.type === "earn").map((l) => [l.kind, l.agent])).toEqual([["supply", key]]);
    // a withdrawal names no destination, and the tool takes none
    const out = await tool("portfolio_live_earn", { venue: "ex", kind: "withdraw", product: "savings:USDT", asset: "USDT", amount: "all", toAddress: "0x00000000000000000000000000000000000BAD00" });
    expect(out.body).toMatchObject({ ok: true, pending: true });
    expect(svc.account!.host.card(out.body.card.id as string)!.action).toEqual({ type: "agentLiveEarn", venue: "ex", kind: "withdraw", product: "savings:USDT", asset: "USDT", amount: "all", nonce: expect.any(Number) });
  }, 30_000);
});

describe("declined asks and price history through the MCP seat", () => {
  it("the owner declines this seat's ask: its watchlist shows it declined, for a day; another seat's is not shown", async () => {
    const asked = await tool("portfolio_ask", { kind: "venue", venue: "okx", text: "connect OKX: the SOL perpetual trades there" });
    expect(asked.body.ok).toBe(true);
    const id = (asked.body.result as { ask: { id: string } }).ask.id;
    expect(await own({ type: "answerAsk", ask: id, decision: "decline" })).toMatchObject({ ok: true });
    const w = await tool("portfolio_watchlist");
    expect(w.body.myAsks.filter((x: { id: string }) => x.id === id)).toEqual([expect.objectContaining({ id, kind: "venue", venue: "okx", declined: true, declinedAt: expect.any(String) })]);
    // the second seat asked once; it is not shown this seat's decline
    if (second) {
      const r = await second.callTool({ name: "portfolio_watchlist", arguments: {} });
      const body = JSON.parse((r.content as Array<{ text: string }>)[0]!.text) as { myAsks: Array<{ id: string }> };
      expect(body.myAsks.map((x) => x.id)).not.toContain(id);
    }
  }, 30_000);

  it("one market's price history, the same as over HTTP; a market the venue does not list is its refusal", async () => {
    expect((await client.listTools()).tools.map((x) => x.name)).toContain("portfolio_candles");
    const c = await tool("portfolio_candles", { venue: "ex", symbol: PERP.symbol, interval: "1h" });
    const http = (await (await fetch(`${server.url}/api/account/candles?venue=ex&symbol=${encodeURIComponent(PERP.symbol)}&interval=1h`)).json()) as Record<string, unknown>;
    expect(c.body).toEqual(http);
    expect(c.body).toMatchObject({ ok: true, venue: "ex", interval: "1h", candles: [{ o: 2990, c: 3000 }] });
    expect((await tool("portfolio_candles", { venue: "ex", symbol: "NOPE" })).body).toMatchObject({ ok: false, code: "E_VENUE_REJECTED" });
  }, 30_000);
});
