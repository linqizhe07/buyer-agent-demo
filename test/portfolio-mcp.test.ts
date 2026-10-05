/** The MCP seat against a running service: the seat holds an agent key and signs every write; the service takes no unsigned one. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isRefusal } from "../src/core/errors.ts";
import { cardHash } from "../src/portfolio/account/exchange.ts";
import { signOwner, simKey, type OwnerAction } from "../src/portfolio/account/sign.ts";
import { startPortfolioServer, type PortfolioServerHandle } from "../src/portfolio/server.ts";
import { PortfolioService } from "../src/portfolio/service.ts";

type NoNonce<T> = T extends unknown ? Omit<T, "nonce"> : never;
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const START = Date.parse("2026-10-05T14:00:00.000Z");
const DAY = 86_400_000;
const owner = simKey("owner");
const seat = simKey("agent:claude-code");

let home: string;
let svc: PortfolioService;
let server: PortfolioServerHandle;
let client: Client;
let t = START;
let n = 0;

const own = async (a: NoNonce<OwnerAction>) => svc.exchange(await signOwner(owner, { ...a, nonce: t + ++n } as OwnerAction));
const tool = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { error: r.isError === true, body: JSON.parse((r.content as Array<{ text: string }>)[0]!.text) as Record<string, any> };
};
const approveCard = async (id: string) => {
  const card = svc.account!.host.card(id)!;
  return own({ type: "approveCard", card: id, action: cardHash(card), decision: "approve" });
};

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "portfolio-mcp-"));
  svc = await PortfolioService.create({ home, now: () => new Date(t).toISOString(), venues: "frontline", account: { owners: [{ id: owner.address, kind: "eoa", label: "owner", addedAt: new Date(START).toISOString() }] } });
  server = await startPortfolioServer({ port: 0, service: svc });
  client = new Client({ name: "vitest", version: "0" });
  await client.connect(new StdioClientTransport({ command: join(ROOT, "node_modules", ".bin", "tsx"), args: [join(ROOT, "src", "portfolio", "mcp.ts")], env: { ...(process.env as Record<string, string>), PORTFOLIO_URL: server.url, PORTFOLIO_AGENT: "Claude Code" }, stderr: "ignore" }));
}, 30_000);

afterAll(async () => {
  await client?.close();
  await server?.close();
  rmSync(home, { recursive: true, force: true });
});

describe("the MCP seat holds an agent key", () => {
  it("lists the account tools, and an unsigned write gets nowhere", async () => {
    const names = (await client.listTools()).tools.map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(["portfolio_account", "portfolio_transfer", "portfolio_pay", "portfolio_execute", "portfolio_order", "portfolio_approval"]));
    const post = (path: string, body: unknown) => fetch(`${server.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const unsigned = await post("/api/execute", { account: "binance", intent: { kind: "trade", symbol: "BTCUSDT", side: "buy", qty: 0.001 }, agent: { name: "Claude Code" } });
    expect([unsigned.status, ((await unsigned.json()) as { refusal: { code: string } }).refusal.code]).toEqual([401, "E_ACCOUNT_BAD_SIGNATURE"]);
    expect((await post("/api/approve", { id: "card-0001", decision: "approve" })).status).toBe(401);
  });

  it("before the owner authorises it the key can do nothing, and the account shows it asking", async () => {
    const a = await tool("portfolio_account");
    expect(a.body.seat).toMatchObject({ name: "Claude Code", key: seat.address, authorised: false });
    const r = await tool("portfolio_transfer", { from: "okx", to: "hyperliquid", amount: 100 });
    expect([r.error, r.body.code]).toEqual([true, "E_ACCOUNT_UNKNOWN_SIGNER"]);
    expect(r.body.hint).toContain(seat.address);
    expect(svc.account!.state.requests.map((x) => x.address)).toEqual([seat.address]);
  });

  it("authorised and approved: a transfer between the user's own venues, in flight until it lands", async () => {
    await own({ type: "approveAgent", agentAddress: seat.address, agentName: "Claude Code", validUntil: t + 30 * DAY });
    const none = await tool("portfolio_transfer", { from: "okx", to: "hyperliquid", amount: 500 });
    expect([none.error, none.body.code]).toEqual([true, "E_MANDATE_NONE"]);
    await own({ type: "approveSpend", agent: seat.address, scope: "venues", allow: "okx,metamask,hyperliquid", perPayment: "600", budget: "2000", windowHours: 0, validUntil: t + 30 * DAY });
    const r = await tool("portfolio_transfer", { from: "okx", to: "hyperliquid", amount: 500 });
    expect(r.error).toBe(false);
    expect(r.body.payment).toMatchObject({ kind: "transfer", from: "okx", to: "hyperliquid", amountUsd: 500, status: "pending" });
    expect(r.body.flight).toMatch(/^CC-\d{4}$/);
    // an outside address is not something this tool can reach
    const out = await tool("portfolio_transfer", { from: "okx", to: "chase", amount: 100 });
    expect(out.error).toBe(true);
    const a = await tool("portfolio_account");
    expect(a.body.seat.authorised).toBe(true);
    expect(a.body.approvals).toMatchObject([{ scope: "venues", perPaymentUsd: 600, budgetUsd: 2000, leftUsd: 1500 }]);
  });

  it("pays an API through the account: a card the first time, then the data straight away", async () => {
    await own({ type: "createSubAccount", name: "research", agent: seat.address, float: "60" });
    const fund = { destination: "self", sourceDex: "metamask", destinationDex: "sub:research", token: "USDC", amount: "50" };
    const route = await svc.account!.resolve(fund, "owner");
    if (isRefusal(route)) throw new Error(route.message);
    await own({ type: "sendAsset", ...fund, fromSubAccount: "", route: route.route.hash, maxFee: String(route.route.feeUsd), deadline: route.route.arrivalMs + 60_000 });
    t += 5 * 60_000;
    await own({ type: "approveSpend", agent: seat.address, scope: "payees", allow: "data.sim,shop.sim", perPayment: "30", budget: "40", windowHours: 0, validUntil: t + 30 * DAY });

    const first = await tool("portfolio_pay", { url: "https://data.sim/v1/quotes?symbol=NVDA", maxAmount: 0.05, from: "research" });
    expect(first.body).toMatchObject({ ok: true, pending: true, card: { usd: 0.01, offer: { payee: "data.sim", amount: "0.01 USDC" } } });
    expect((await tool("portfolio_approval", { id: first.body.card.id })).body.status).toBe("pending");
    await approveCard(first.body.card.id);
    const done = await tool("portfolio_approval", { id: first.body.card.id });
    expect(done.body.status).toBe("approved");
    expect(done.body.outcome).toMatchObject({ kind: "payment", data: { symbol: "NVDA", price: 150.12 }, payment: { amountUsd: 0.01, protocol: "x402" } });

    const second = await tool("portfolio_pay", { url: "https://data.sim/v1/quotes?symbol=SPY", maxAmount: 0.05, from: "research" });
    expect(second.body).toMatchObject({ ok: true, payment: { kind: "pay", from: "sub:research", to: "data.sim", amountUsd: 0.01, status: "settled", protocol: "x402" }, data: { symbol: "SPY", price: 600.4 } });
    const no = await tool("portfolio_pay", { url: "https://infer.sim/v1/answers", maxAmount: 0.05, from: "research" });
    expect([no.error, no.body.code]).toEqual([true, "E_MANDATE_RECIPIENT"]);
  });

  it("buys under AP2: the seat signs the two closed mandates itself, after reading the merchant's signed total", async () => {
    const url = "https://shop.sim/items/desk-feed-pro";
    const first = await tool("portfolio_pay", { url, maxAmount: 30, from: "research" });
    expect(first.body).toMatchObject({ ok: true, pending: true, card: { usd: 29, offer: { payee: "shop.sim", protocol: "AP2 mandates · EIP-3009" } } });
    await approveCard(first.body.card.id);
    const paid = await tool("portfolio_pay", { url, maxAmount: 30, from: "research" });
    expect(paid.body).toMatchObject({ ok: true, payment: { from: "sub:research", to: "shop.sim", amountUsd: 29, protocol: "ap2", status: "settled" }, data: { order: { id: "order_000001" } } });
    // the price the merchant signs goes up after the seat was told $30 at most: it signs nothing
    svc.payees!.shop.priceCents = 3500;
    svc.payees!.shop.checkoutCents = 3500;
    const over = await tool("portfolio_pay", { url, maxAmount: 30, from: "research" });
    expect([over.error, over.body.code]).toEqual([true, "E_PAYEE_OVERCHARGE"]);
  });

  it("the older writes are signed too: a trade goes through, a move or a pay is sent to its own tool", async () => {
    const trade = await tool("portfolio_execute", { account: "binance", intent: { kind: "trade", symbol: "BTCUSDT", side: "buy", qty: 0.001 } });
    expect([trade.error, trade.body.status]).toEqual([false, "filled"]);
    const move = await tool("portfolio_execute", { account: "binance", intent: { kind: "move", asset: "USDT", amount: 10, to: "wallet-main" } });
    expect([move.error, move.body.code]).toEqual([true, "E_ACCOUNT_BAD_ACTION"]);
    const order = await tool("portfolio_order", { base: "ETH", side: "sell", qty: 0.1 });
    expect(order.error).toBe(false);
    expect(order.body.flight).toMatch(/^CC-\d{4}$/);
    expect(svc.verifyChain().ok).toBe(true);
  });
});
