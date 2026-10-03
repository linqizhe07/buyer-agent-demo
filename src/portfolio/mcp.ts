/** The agent-facing surface: a stdio MCP server any skill-capable agent
 * (Claude Code, Codex, Cursor, …) can mount. It holds no credential and no
 * state — every tool is a call to the running portfolio service (:4820), so the
 * page, the ledger and the agent see one truth.
 *
 *   npm run portfolio               # the service
 *   npm run portfolio:mcp           # this, over stdio; PORTFOLIO_URL overrides the base
 *
 * Tools: portfolio_overview · portfolio_read · portfolio_markets · portfolio_quote (reads) ·
 * portfolio_execute · portfolio_order (writes) · portfolio_approval ·
 * portfolio_openness.
 *
 * Claude Code:  claude mcp add portfolio -- npx tsx src/portfolio/mcp.ts
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const BASE = process.env.PORTFOLIO_URL ?? "http://127.0.0.1:4820";

/** who is flying: the MCP client's own name (Claude Code, Codex, Cursor…), or PORTFOLIO_AGENT; the service turns it into the flight number's prefix */
function agentOf(): { id: string; name: string } {
  const name = process.env.PORTFOLIO_AGENT ?? server.server.getClientVersion()?.name ?? "MCP agent";
  return { id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), name };
}

async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const init: RequestInit = { method, headers: { "content-type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetch(`${BASE}${path}`, init);
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

const text = (payload: unknown, isError = false): CallToolResult => ({ isError, content: [{ type: "text", text: JSON.stringify(payload) }] });

const intentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("trade"), symbol: z.string(), side: z.enum(["buy", "sell"]), qty: z.number().positive(), chainId: z.number().int().optional() }),
  z.object({ kind: z.literal("move"), asset: z.string(), amount: z.number().positive(), to: z.string(), chainId: z.number().int().optional(), fromChainId: z.number().int().optional() }),
  z.object({ kind: z.literal("pay"), merchant: z.string(), mcc: z.string(), amountUsd: z.number().positive() }),
  z.object({ kind: z.literal("subscribe"), fund: z.string(), amountUsd: z.number().positive() }),
  z.object({ kind: z.literal("redeem"), fund: z.string(), amountUsd: z.number().positive() }),
]);

interface OverviewLite {
  now: string;
  mode: string;
  live: boolean;
  session: { expiresAt: string; expired: boolean };
  portfolio: { totalUsd: number; creditAvailableUsd: number; byClass: Array<{ label: string; usd: number; pct: number }>; byAccount: Array<{ account: string; name: string; usd: number; live: boolean }> };
  accounts: Array<{ id: string; name: string; kind: string; live: boolean; reach: string[]; revoked: boolean; usd: number; scope: { can: string[]; limits: string[]; enforcedBy: string }; holdings: unknown[]; readError?: string; address?: string; chain?: string }>;
  approvals: Array<{ id: string; status: string; account: string; usd: number; reason: string; result?: unknown; flight?: string }>;
  daily: { used: number; cap: number };
  liquidity: { mobileUsd: number; stuckUsd: number; mobile: Array<{ account: string; asset: string; chain?: string; usd: number }>; stuck: Array<{ account: string; asset: string; usd: number; why: string }> };
  ladder: unknown;
  flights: Array<{ no: string; agent: { id: string; name: string; code: string }; at: string; request: string; legs: Array<{ mark: string; text: string; usd?: number; approvalId?: string }> }>;
}

const server = new McpServer({ name: "agent-portfolio-manager", version: "0.1.0" });

server.registerTool(
  "portfolio_overview",
  { description: "The user's whole portfolio across every connected account (CEX, on-chain agent wallet, prediction markets, RWA, card, bank): total USD, by asset class, by account, the LIQUIDITY map (stablecoins you may move across accounts/chains vs. stuck ones and why) and LADDER (how soon and for how much each holding can reach the hub chain; closed routes keep their quote), the openness mode, what you may do at each account, and today's flights (every agent's requests, by flight number). Reads are never gated.", inputSchema: {}, annotations: { readOnlyHint: true } },
  async () => {
    const r = await call("GET", "/api/overview");
    if (r.status >= 400) return text(r.body, true);
    const o = r.body as OverviewLite;
    return text({
      now: o.now,
      mode: o.mode,
      session: o.session,
      live: o.live,
      totalUsd: o.portfolio.totalUsd,
      creditAvailableUsd: o.portfolio.creditAvailableUsd,
      byClass: o.portfolio.byClass,
      liquidity: o.liquidity,
      ladder: o.ladder,
      accounts: o.accounts.map((a) => ({ id: a.id, name: a.name, kind: a.kind, live: a.live, usd: a.usd, address: a.address, chain: a.chain, agentMay: a.reach, revoked: a.revoked, credentialCan: a.scope.can, nativeLimits: a.scope.limits, enforcedBy: a.scope.enforcedBy, ...(a.readError ? { readError: a.readError } : {}) })),
      pendingCards: o.approvals.filter((x) => x.status === "pending").map((x) => ({ id: x.id, flight: x.flight, account: x.account, usd: x.usd, reason: x.reason })),
      flights: o.flights.slice(-12).map((f) => ({ no: f.no, agent: f.agent.name, at: f.at, request: f.request, legs: f.legs.map((l) => `${l.mark === "ok" ? "✓" : l.mark === "no" ? "✗" : l.mark === "wait" ? "▣" : "·"} ${l.text}`) })),
      daily: o.daily,
    });
  },
);

server.registerTool(
  "portfolio_read",
  { description: "Holdings of one account (or all): asset, amount, USD, class. Never raises a card.", inputSchema: { account: z.string().optional() }, annotations: { readOnlyHint: true } },
  async ({ account }) => {
    const r = await call("GET", `/api/read${account ? `?account=${encodeURIComponent(account)}` : ""}`);
    return text(r.body, r.status >= 400);
  },
);

server.registerTool(
  "portfolio_execute",
  {
    description:
      "Act at one account: trade {symbol, side, qty, chainId?} (at the on-chain wallet a trade is a DEX swap on chainId's pools; at a prediction market the symbol is an event contract like FED-DEC-HIKE25:YES and qty is shares; to let the wallet pick venues and split, use portfolio_order instead) · move {asset, amount, to, chainId?, fromChainId?} (fromChainId ≠ chainId is a bridge; a move to another connected account's address lands there) · pay {merchant, mcc, amountUsd} · subscribe/redeem {fund, amountUsd} (at a prediction market, redeem claims the winning shares of a settled market: fund is the event id). Each call is one flight under your name. The wallet first checks the credential's native scope and the user's openness dial; in open mode nothing is capped and only the dangerous ones raise a card: a move to a never-used address, an order in a prediction market past its close. A card comes back as {pending: true, approval: {id}} — wait for the human, then poll portfolio_approval. A refusal is {ok: false, code: E_WALLET_* | E_VENUE_* | E_CARD_*, message, native}: do not retry it, tell the user.",
    inputSchema: { account: z.string(), intent: intentSchema },
  },
  async ({ account, intent }) => {
    const r = await call("POST", "/api/execute", { account, intent, agent: agentOf() });
    return text(r.body, r.status >= 400);
  },
);

const orderSchema = { base: z.string().describe("an asset (ETH | BTC | SOL) or an event contract from portfolio_markets (e.g. FED-DEC-HIKE25:YES)"), side: z.enum(["buy", "sell"]), qty: z.number().positive().describe("units of the asset, or shares of the outcome") };

server.registerTool(
  "portfolio_markets",
  { description: "The event contracts on the connected prediction markets (Polymarket, Kalshi): each question, when it closes, its state (open · awaiting = past its close and not yet resolved, where an order always needs the human · resolved), and every venue's top of book for YES. The `symbols` (`<id>:YES`, `<id>:NO`) are what portfolio_quote and portfolio_order take as `base`. A read.", inputSchema: {}, annotations: { readOnlyHint: true } },
  async () => {
    const r = await call("GET", "/api/markets");
    return text(r.body, r.status >= 400);
  },
);

server.registerTool(
  "portfolio_quote",
  {
    description:
      "Price one order at every connected venue — the CEX order books and the DEX pools on each chain the on-chain wallet holds inventory on, or, for an event contract, each prediction market's book — and see how the wallet's router would split it: each venue's net for the whole order (or why it cannot take it: inventory is liquidity too), the slices with their fills, a DEX slice's route across pools and its gas, the best single venue and what splitting earns over it, and the venues left out with the reason. A read: no card, nothing moves.",
    inputSchema: orderSchema,
    annotations: { readOnlyHint: true },
  },
  async ({ base, side, qty }) => {
    const r = await call("GET", `/api/quote?base=${encodeURIComponent(base)}&side=${side}&qty=${qty}`);
    return text(r.body, r.status >= 400);
  },
);

server.registerTool(
  "portfolio_order",
  {
    description:
      "Route an order and execute it as ONE flight under your name: the wallet splits it across venues by marginal net price and inventory (run portfolio_quote first to see the plan), one leg per slice. The wallet judges the whole order, not the slices — in guard mode an order above the free allowance raises ONE card ({pending: true, approval: {id}}; poll portfolio_approval) and nothing executes until the human answers. {ok: false, error} means the venues together cannot take the order; a refusal is not to be retried.",
    inputSchema: orderSchema,
  },
  async ({ base, side, qty }) => {
    const r = await call("POST", "/api/order", { base, side, qty, agent: agentOf() });
    return text(r.body, r.status >= 400);
  },
);

server.registerTool(
  "portfolio_approval",
  { description: "Status of a card the wallet raised: pending | approved | rejected, with the venue result once decided.", inputSchema: { id: z.string() }, annotations: { readOnlyHint: true } },
  async ({ id }) => {
    const r = await call("GET", "/api/overview");
    if (r.status >= 400) return text(r.body, true);
    const ap = (r.body as OverviewLite).approvals.find((x) => x.id === id);
    return ap ? text(ap) : text({ ok: false, error: `no card ${id}` }, true);
  },
);

server.registerTool(
  "portfolio_openness",
  { description: "The three layers per account: what the credential can do (and who enforces it), what the user opened to the agent and what the wallet still keeps, and the venue's own second line. Read this before planning a cross-account action.", inputSchema: {}, annotations: { readOnlyHint: true } },
  async () => {
    const r = await call("GET", "/api/overview");
    if (r.status >= 400) return text(r.body, true);
    const o = r.body as { mode: string; openness: unknown; compiled: unknown };
    return text({ mode: o.mode, openness: o.openness, layers: o.compiled });
  },
);

await server.connect(new StdioServerTransport());
process.stderr.write(`[agent-portfolio-manager] up (stdio) → ${BASE}\n`);
