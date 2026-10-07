/** ATTACKS THAT MUST FAIL, against what one MCP seat is shown of another's: two seats on one account, A and B, each with its own key. A
 * places an order that waits on the owner's card. B must not read that card, its reason, or what approving it released — not through
 * portfolio_account, portfolio_overview, portfolio_approval or portfolio_wait — and must not wait on A's order.
 *
 * What this is, and is not: a seat shows its own, and the service's reads stay open to any process on this machine (it listens on
 * 127.0.0.1 only, and every seat runs as the same user). The last test pins that boundary, so that no one reads the seat's filter as a wall
 * between agents: mcp.ts says so at its top. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cardHash } from "../../src/portfolio/account/exchange.ts";
import { signOwner, simKey, type OwnerAction } from "../../src/portfolio/account/sign.ts";
import { no } from "../../src/portfolio/refuse.ts";
import { register } from "../../src/portfolio/live/index.ts";
import type { LiveTrader, Market, OrderState } from "../../src/portfolio/live/trade.ts";
import { startPortfolioServer, type PortfolioServerHandle } from "../../src/portfolio/server.ts";
import { PortfolioService } from "../../src/portfolio/service.ts";

type NoNonce<T> = T extends unknown ? Omit<T, "nonce"> : never;
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DAY = 86_400_000;
const owner = simKey("owner");
const SPOT: Market = { symbol: "ETH/USDT", name: "ETH/USDT", kind: "spot", base: "ETH", quote: "USDT", price: 3000, bid: 2999, ask: 3001, minQty: 0.01, qtyStep: 0.01, priceStep: 0.1, open: true, types: ["market", "limit"] };
const states = new Map<string, OrderState>();
let placed = 0;
const trader: LiveTrader = {
  can: true,
  what: "spot",
  async markets() {
    return [SPOT];
  },
  async market(symbol) {
    return symbol === SPOT.symbol ? { ...SPOT } : no("E_VENUE_REJECTED", { venue: "ex", message: `no market ${symbol}` });
  },
  async place(o) {
    const s: OrderState = { ref: `x-${++placed}`, status: "open", filledQty: 0, native: {} };
    states.set(s.ref, s);
    return s;
  },
  async cancel(ref) {
    return { ...states.get(ref)!, status: "canceled" };
  },
  async status(ref) {
    return states.get(ref)!;
  },
};
register({ kind: "standin-seat-reads", label: "a venue", needs: "key-file", example: "", venues: [], async open(req) {
  return { source: { name: req.label || "Exchange", kind: "cex", reference: "standin", via: "a stand-in", probe: { can: ["read", "trade"], note: "" }, read: async () => [{ asset: "USDT", amount: 5000, usd: 5000 }], trader, readOnlyBecause: "the stand-in moves no money" }, first: [], summary: "connected" };
} });

let home: string;
let svc: PortfolioService;
let server: PortfolioServerHandle;
let a: Client;
let b: Client;
let n = 0;
const own = async (x: NoNonce<OwnerAction>) => svc.exchange(await signOwner(owner, { ...x, nonce: Date.now() + ++n } as OwnerAction));
/** a seat: the MCP server over stdio, its key derived from its name (PORTFOLIO_SEAT_KEYS=sim, as the tests' keys are) */
const seat = async (name: string) => {
  const c = new Client({ name: "vitest", version: "0" });
  await c.connect(new StdioClientTransport({ command: join(ROOT, "node_modules", ".bin", "tsx"), args: [join(ROOT, "src", "portfolio", "mcp.ts")], env: { ...(process.env as Record<string, string>), PORTFOLIO_URL: server.url, PORTFOLIO_AGENT: name, BUYER_HOME: home, PORTFOLIO_SEAT_KEYS: "sim" }, stderr: "ignore" }));
  return c;
};
const tool = async (c: Client, name: string, args: Record<string, unknown> = {}) => {
  const r = await c.callTool({ name, arguments: args });
  return { error: r.isError === true, body: JSON.parse((r.content as Array<{ text: string }>)[0]!.text) as Record<string, any> };
};

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "seat-reads-"));
  svc = await PortfolioService.create({ home, venues: "frontline", real: true, liveWrites: { capUsd: 5000, pairingCode: "K7QX-M2PA" }, publicMarkets: [], liveDeps: { http: async () => ({ status: 599, body: undefined, text: "" }), price: async () => undefined }, account: { owners: [{ id: owner.address, kind: "eoa", label: "owner", addedAt: new Date().toISOString() }] } });
  server = await startPortfolioServer({ port: 0, service: svc, snapshotMs: 0 });
  await own({ type: "connectVenue", venue: "ex", connector: "live:standin-seat-reads", label: "Exchange", credentialRef: "" });
  a = await seat("Seat A");
  b = await seat("Seat B");
  const ka = simKey("agent:seat-a").address;
  await own({ type: "approveAgent", agentAddress: ka, agentName: "Seat A", validUntil: Date.now() + 30 * DAY });
  await own({ type: "approveAgent", agentAddress: simKey("agent:seat-b").address, agentName: "Seat B", validUntil: Date.now() + 30 * DAY });
  await own({ type: "approveSpend", agent: ka, scope: "trade", allow: "ex", perPayment: "2000", budget: "4000", windowHours: 0, validUntil: Date.now() + 7 * DAY });
}, 30_000);

afterAll(async () => {
  await a?.close();
  await b?.close();
  await server?.close();
  rmSync(home, { recursive: true, force: true });
});

describe("one seat does not read another's cards", () => {
  it("B is shown A's card only as a count, in portfolio_account and portfolio_overview alike; A is shown it whole", async () => {
    const asked = await tool(a, "portfolio_live_order", { venue: "ex", symbol: SPOT.symbol, side: "buy", orderType: "limit", limitPrice: 2900, qty: 0.5 });
    expect(asked.body).toMatchObject({ ok: true, pending: true });
    const id = asked.body.card.id as string;
    const acct = (await tool(b, "portfolio_account")).body;
    expect([acct.waitingForOwner, acct.othersWaiting]).toEqual([[], 1]);
    const ov = (await tool(b, "portfolio_overview")).body;
    expect([ov.pendingCards, ov.othersWaiting]).toEqual([[], 1]);
    expect(JSON.stringify(ov)).not.toContain("Seat A asks");
    // B's flights are its own: A's request is in none of them
    expect(ov.flights.every((f: { agent: string }) => f.agent === "Seat B")).toBe(true);
    const mine = (await tool(a, "portfolio_overview")).body;
    expect([mine.pendingCards.map((c: { id: string }) => c.id), mine.othersWaiting]).toEqual([[id], 0]);
    expect(mine.flights.length).toBeGreaterThan(0);
  }, 60_000);

  it("once the owner approves, B reads neither the card nor the order it released — through portfolio_approval or portfolio_wait — and A reads both", async () => {
    const id = svc.account!.host.cards().find((c) => c.status === "pending")!.id;
    ok(await own({ type: "approveCard", card: id, action: cardHash(svc.account!.host.card(id)!), decision: "approve" }));
    const ap = await tool(b, "portfolio_approval", { id });
    expect([ap.error, ap.body.error, JSON.stringify(ap.body).includes("0.5")]).toEqual([true, `no card ${id} of this seat's`, false]);
    const waited = await tool(b, "portfolio_wait", { card: id, timeoutSec: 1 });
    expect([waited.error, waited.body.error]).toEqual([true, `no card ${id} of this seat's`]);
    const order = svc.account!.orders.find((o) => o.card === id)!;
    const onOrder = await tool(b, "portfolio_wait", { order: order.id, timeoutSec: 1 });
    expect([onOrder.error, onOrder.body.error]).toEqual([true, `no order ${order.id} of this seat's on the account`]);
    // A, whose card it is
    const own_ = await tool(a, "portfolio_approval", { id });
    expect(own_.body).toMatchObject({ id, status: "approved" });
    expect((await tool(a, "portfolio_wait", { order: order.id, timeoutSec: 1 })).body).toMatchObject({ ok: true, now: { id: order.id } });
  }, 60_000);

  it("the boundary, said: the service's own reads answer any process on this machine, so the seat's filter is a view and not a wall", async () => {
    const r = await fetch(`${server.url}/api/account`);
    const body = (await r.json()) as { cards: unknown[]; orders: Array<{ agent?: string }> };
    expect(r.status).toBe(200);
    expect(body.orders.some((o) => o.agent === simKey("agent:seat-a").address)).toBe(true);
  }, 30_000);
});

function ok<T>(x: T): T {
  if (x && typeof x === "object" && "code" in x && "message" in x && (x as { ok?: unknown }).ok === false) throw new Error(String((x as { message: unknown }).message));
  return x;
}
