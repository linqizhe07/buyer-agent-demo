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
};
register({ kind: "standin-mcp-real", label: "a venue for the MCP seat", needs: "key-file", example: "", venues: [], async open(req) {
  return { source: { name: req.label || "Exchange", kind: "cex", reference: "standin", via: "a stand-in", probe: { can: ["read", "trade"], note: "" }, read: async () => [{ asset: "USDT", amount: 5000, usd: 5000 }], trader, readOnlyBecause: "the stand-in moves no money" }, first: [], summary: "connected" };
} });

let home: string;
let svc: PortfolioService;
let server: PortfolioServerHandle;
let client: Client;
let n = 0;
const START = Date.now();
const own = async (a: NoNonce<OwnerAction>) => svc.exchange(await signOwner(owner, { ...a, nonce: Date.now() + ++n } as OwnerAction));
const tool = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { error: r.isError === true, body: JSON.parse((r.content as Array<{ text: string }>)[0]!.text) as Record<string, any> };
};

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "portfolio-mcp-real-"));
  svc = await PortfolioService.create({ home, venues: "frontline", real: true, liveWrites: { capUsd: 5000, pairingCode: "K7QX-M2PA" }, liveDeps: { http: async () => ({ status: 599, body: undefined, text: "" }), price: async () => undefined }, account: { owners: [{ id: owner.address, kind: "eoa", label: "owner", addedAt: new Date(START).toISOString() }] } });
  server = await startPortfolioServer({ port: 0, service: svc });
  await own({ type: "connectVenue", venue: "ex", connector: "live:standin-mcp-real", label: "Exchange", credentialRef: "" });
  client = new Client({ name: "vitest", version: "0" });
  // no PORTFOLIO_SEAT_KEYS: the seat makes its own key, in this home
  await client.connect(new StdioClientTransport({ command: join(ROOT, "node_modules", ".bin", "tsx"), args: [join(ROOT, "src", "portfolio", "mcp.ts")], env: { ...(process.env as Record<string, string>), PORTFOLIO_URL: server.url, PORTFOLIO_AGENT: "DeepSeek Harness", BUYER_HOME: home }, stderr: "ignore" }));
}, 30_000);

afterAll(async () => {
  await client?.close();
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
    // Conservative: a card; the harness waits on it while the owner answers
    const asked = await tool("portfolio_live_order", { venue: "ex", symbol: PERP.symbol, side: "sell", orderType: "stop", stopPrice: 2800, qty: 0.2, reduceOnly: true });
    expect(asked.body).toMatchObject({ ok: true, pending: true });
    const id = asked.body.card.id as string;
    setTimeout(() => void own({ type: "approveCard", card: id, action: cardHash(svc.account!.host.card(id)!), decision: "approve" }), 1200);
    const waited = await tool("portfolio_wait", { card: id, timeoutSec: 10 });
    expect(waited.body).toMatchObject({ ok: true, changed: true, done: true, now: { status: "approved" } });
    const order = (waited.body.now as { outcome: { order: { id: string; type: string; stopPrice: number; reduceOnly: boolean; status: string } } }).outcome.order;
    expect([order.type, order.stopPrice, order.reduceOnly, order.status]).toEqual(["stop", 2800, true, "open"]);
    // positions, and a close: in Conservative a card like any order (the position may be the owner's own), which the harness waits on
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
