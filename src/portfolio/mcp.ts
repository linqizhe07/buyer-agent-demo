/** The agent-facing surface: a stdio MCP server any skill-capable agent
 * (Claude Code, Codex, Cursor, …) can mount. It holds no venue credential and
 * no state — every tool is a call to the running portfolio service (:4820), so
 * the page, the ledger and the agent see one truth.
 *
 *   npm run account                 # the service
 *   npm run portfolio:mcp           # this, over stdio; PORTFOLIO_URL overrides the base
 *
 * Tools on the user's REAL accounts (the service's default): portfolio_account · portfolio_live_markets · portfolio_live_compare (reads) ·
 * portfolio_live_order · portfolio_live_cancel · portfolio_live_move (writes: inside the limit the owner signed for this seat;
 * Conservative asks the owner on a card, Aggressive places it at once) · portfolio_approval.
 * On the simulated statement (--classic): portfolio_overview · portfolio_read · portfolio_markets · portfolio_quote ·
 * portfolio_execute · portfolio_order · portfolio_transfer · portfolio_pay · portfolio_openness.
 *
 * With the account layer mounted (the service's default) this seat HOLDS AN AGENT KEY and signs
 * every write with it: the service takes no unsigned write, and what the key may do is what the
 * owner authorised on the Account page — nothing until then. The key is the seat's own: made the
 * first time this seat runs, kept in <home>/seats/<name>.json (the user's alone), the same ever
 * after (account/keystore.ts). PORTFOLIO_SEAT_KEYS=sim derives it from the name instead, as the
 * simulation's keys are — public by construction, for tests and demos only.
 *
 * Claude Code:  claude mcp add portfolio -- npx tsx src/portfolio/mcp.ts
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ap2Answer, ap2CheckoutHash, jwsParse, type Ap2Needs } from "./account/protocols.ts";
import { micro, signAgent, simKey, type AgentAction, type SimKey } from "./account/sign.ts";
import { mustKey, seatKey as storedSeatKey } from "./account/keystore.ts";
import { defaultHome } from "./home.ts";

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

// ---- the seat's key ---------------------------------------------------------------------------

/** this seat's agent key, two curves — secp256k1 signs the account's instructions, P-256 signs AP2 mandates. Its own, kept in the home;
 * derived from the seat's name only under PORTFOLIO_SEAT_KEYS=sim */
const seats = new Map<string, SimKey>();
const seatKey = (): SimKey => {
  const id = agentOf().id;
  let k = seats.get(id);
  if (!k) seats.set(id, (k = process.env.PORTFOLIO_SEAT_KEYS === "sim" ? simKey(`agent:${id}`) : mustKey(storedSeatKey(defaultHome(), id))));
  return k;
};

let layered: boolean | undefined;
/** does the service take signed instructions (the account layer), or is it the original eight accounts? */
async function layer(): Promise<boolean> {
  if (layered === undefined) {
    const r = await call("GET", "/api/overview");
    if (r.status < 400) layered = (r.body as { accountLayer?: boolean }).accountLayer === true;
  }
  return layered === true;
}

let lastNonce = 0;
/** a nonce is the SERVICE's clock (it may run ahead of this machine's: the simulation can skip time), and never the same one twice */
async function nonce(): Promise<number> {
  const r = await call("GET", "/api/now");
  lastNonce = Math.max(Number((r.body as { ms?: number }).ms ?? Date.now()), lastNonce + 1);
  return lastNonce;
}

type Unsigned = AgentAction extends infer A ? (A extends unknown ? Omit<A, "nonce"> : never) : never;
interface DoorAnswer {
  status: number;
  body: { ok?: boolean; kind?: string; refusal?: { code: string; message: string; detail?: unknown; native?: unknown }; payment?: Record<string, unknown>; card?: Record<string, unknown>; order?: Record<string, unknown>; result?: unknown; flight?: string; data?: unknown; summary?: string };
}

/** an order as an agent reads it: what was asked, where it stands, what filled and at what */
function orderView(o: Record<string, unknown>): Record<string, unknown> {
  const pick = ["id", "venue", "symbol", "name", "side", "type", "qty", "limitPrice", "status", "filledQty", "avgPrice", "feeUsd", "usd", "note", "at", "card"];
  return Object.fromEntries(pick.filter((k) => o[k] !== undefined && o[k] !== null && o[k] !== "").map((k) => [k === "usd" ? "worthUpToUsd" : k, o[k]]));
}

/** sign one instruction with the seat's key and hand it in at the door */
async function sign(action: Unsigned): Promise<DoorAnswer> {
  const envelope = await signAgent(seatKey(), { ...action, nonce: await nonce() } as AgentAction);
  return (await call("POST", "/api/exchange", envelope)) as DoorAnswer;
}

/** the door's answer as an agent reads it: a payment, a card that waits for the owner, a result, or a refusal that is not to be retried */
function answer(r: DoorAnswer): CallToolResult {
  const b = r.body;
  if (b.refusal) {
    const hint = b.refusal.code === "E_ACCOUNT_UNKNOWN_SIGNER" ? { hint: `this seat's key ${seatKey().address} is not authorised on the account. The owner lets it in on the account page (Agents), where it now shows as asking to be let in, and gives it a limit there.` } : b.refusal.code === "E_MANDATE_NONE" ? { hint: "the owner gives this seat a limit on the account page (Agents): which accounts, how much an order, how much in all, until when" } : {};
    return text({ ok: false, code: b.refusal.code, message: b.refusal.message, ...(b.refusal.detail !== undefined ? { detail: b.refusal.detail } : {}), ...(b.refusal.native !== undefined ? { native: b.refusal.native } : {}), ...hint }, true);
  }
  if (b.kind === "order" && b.order) return text({ ok: true, order: orderView(b.order), ...(b.flight ? { flight: b.flight } : {}), next: ["open", "partial", "pending"].includes(String(b.order.status)) ? "it is on the venue's book or on its way: portfolio_account shows what became of it; portfolio_live_cancel takes it off" : "done: portfolio_account shows the balances after it" });
  if (b.kind === "card" && b.card) {
    const c = b.card as { id: string; reason: string; usd: number; expiresAt?: string; offer?: unknown };
    return text({ ok: true, pending: true, card: { id: c.id, reason: c.reason, usd: c.usd, expiresAt: c.expiresAt, ...(c.offer ? { offer: c.offer } : {}) }, flight: b.flight, next: "the owner answers this card on the Account page. Poll portfolio_approval with the card id: once approved, its `outcome` holds the payment and whatever it bought — then do not send the request again. The one exception: if the outcome says mandates are needed (a shop paid from a float), call portfolio_pay once more and this seat signs them." });
  }
  if (b.kind === "payment" && b.payment) {
    const p = b.payment as { id: string; kind: string; from: string; to: string; amountUsd: number; feeUsd: number; receiveUsd: number; status: string; settlesAt: string; protocol?: string; note?: string; legs: Array<{ step: string; venue: string; protocol: string; status: string; settlesAt?: string }> };
    return text({ ok: true, payment: { id: p.id, kind: p.kind, from: p.from, to: p.to, amountUsd: p.amountUsd, feeUsd: p.feeUsd, arrivesUsd: p.receiveUsd, status: p.status, ...(p.status === "pending" ? { lands: p.settlesAt } : {}), ...(p.protocol ? { protocol: p.protocol } : {}), ...(p.note ? { note: p.note } : {}), legs: p.legs.map((l) => `${l.step} at ${l.venue} · ${l.protocol} · ${l.status}`) }, flight: b.flight, ...(b.data !== undefined ? { data: b.data } : {}) });
  }
  return text({ ok: true, ...(b.result !== undefined ? { result: b.result } : {}), ...(b.summary ? { summary: b.summary } : {}), ...(b.flight ? { flight: b.flight } : {}) }, r.status >= 400);
}

const intentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("trade"), symbol: z.string(), side: z.enum(["buy", "sell"]), qty: z.number().positive(), chainId: z.number().int().optional() }),
  z.object({ kind: z.literal("move"), asset: z.string(), amount: z.number().positive(), to: z.string(), chainId: z.number().int().optional(), fromChainId: z.number().int().optional() }),
  z.object({ kind: z.literal("subscribe"), fund: z.string(), amountUsd: z.number().positive() }),
  z.object({ kind: z.literal("redeem"), fund: z.string(), amountUsd: z.number().positive() }),
]);

interface OverviewLite {
  now: string;
  mode: string;
  live: boolean;
  session: { expiresAt: string; expired: boolean };
  portfolio: { totalUsd: number; byClass: Array<{ label: string; usd: number; pct: number }>; byAccount: Array<{ account: string; name: string; usd: number; live: boolean }> };
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
  { description: "The user's whole portfolio across every connected account (stock broker, CEX, perp DEX, on-chain agent wallet, prediction markets, RWA): total USD, by asset class, by account, the LIQUIDITY map (stablecoins you may move across accounts/chains vs. stuck ones and why) and LADDER (how soon and for how much each holding can reach the hub chain; closed routes keep their quote), the openness mode, what you may do at each account, and today's flights (every agent's requests, by flight number). Reads are never gated.", inputSchema: {}, annotations: { readOnlyHint: true } },
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
      "Act at one account: trade {symbol, side, qty, chainId?} (at the on-chain wallet a trade is a DEX swap on chainId's pools; at a prediction market the symbol is an event contract like FED-DEC-HIKE25:YES and qty is shares; to let the wallet pick venues and split, use portfolio_order instead) · subscribe/redeem {fund, amountUsd} (at a prediction market, redeem claims the winning shares of a settled market: fund is the event id) · move {asset, amount, to, chainId?, fromChainId?} ONLY on a service without the account layer — with it (the default) money moves through portfolio_live_move, and a move here is refused. Each call is one flight under your name, signed with this seat's key. The wallet first checks the credential's native scope and the user's openness dial; in open mode nothing is capped and only the dangerous ones raise a card: an order in a prediction market past its close. A card comes back as {pending: true, approval: {id}} — wait for the human, then poll portfolio_approval. A refusal is {ok: false, code: E_ACCOUNT_* | E_WALLET_* | E_VENUE_* | E_CARD_*, message, native}: do not retry it, tell the user.",
    inputSchema: { account: z.string(), intent: intentSchema },
  },
  async ({ account, intent }) => {
    if (await layer()) {
      const r = await sign({ type: "agentExecute", account, intent });
      // the older write path answers inside `result`: an ok, a card, or a refusal of its own
      const inner = r.body.result as { ok?: boolean; pending?: boolean } | undefined;
      return r.body.refusal || !inner ? answer(r) : text(inner, inner.ok === false);
    }
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
    if (await layer()) {
      const r = await sign({ type: "agentOrder", base, side, qty });
      return r.body.refusal ? answer(r) : text(r.body.result ?? r.body);
    }
    const r = await call("POST", "/api/order", { base, side, qty, agent: agentOf() });
    return text(r.body, r.status >= 400);
  },
);

// ---- the account: what this seat's key may do, and the two ways it moves money -------------------

/** what this seat may ask of a venue connected live, in the words the page uses */
function liveMoney(v: AccountLite["venues"][number], writes: boolean): string {
  if (v.readOnlyBecause) return `read only: ${v.readOnlyBecause}`;
  if (!writes) return "read only: this server moves no real money";
  const c = v.liveCan;
  if (!c) return "read only";
  if (v.address && !v.proven) return "watched: no wallet signed for this address, so nothing is sent to or from it";
  const out = [c.withdraw !== false && !c.send ? "withdraw" : "", c.send ? "send" : "", c.ledgers.length > 1 && c.transfer !== false ? `transfer between ${c.ledgers.join(" and ")}` : "", c.swap !== false && !c.send ? "swap" : ""].filter(Boolean);
  if (!out.length) return `this key only reads: nothing leaves it${c.receive ? ", but it can receive a movement from another venue" : ""}`;
  return `ask with portfolio_live_move (the owner signs every one): ${[...out, c.receive ? "receive" : ""].filter(Boolean).join(", ")}`;
}

/** what this seat may trade at a venue connected live, in the words the page uses */
function liveTrading(v: AccountLite["venues"][number], writes: boolean): string {
  if (!writes) return "no orders: this server was started read-only";
  if (!v.trade) return `no orders: ${v.noTradeBecause ?? "orders are not placed here from the account"}`;
  if (v.trade.can === false) return "no orders: this key may not trade (that is set on the key at the venue)";
  if (v.address && !v.proven) return "no orders: a watched address, not proven the user's";
  return `trades ${v.trade.what}: portfolio_live_markets to find a market, portfolio_live_order to place one (inside your trading limit)`;
}

interface AccountLite {
  now: string;
  type: string;
  totalUsd: number;
  inFlightUsd: number;
  venues: Array<{ id: string; name: string; frontLine: string; usd: number; cashUsd: number; restricted?: string; in: { text: string; access: string; why?: string }; out: { text: string; access: string; why?: string }; ledgers: string[]; live?: true; liveCan?: { withdraw: boolean | string; ledgers: string[]; transfer?: boolean | string; swap: boolean | string; receive: boolean; send: string | false }; trade?: { can: boolean | string; what: string }; noTradeBecause?: string; readOnlyBecause?: string; proven?: string; address?: string; holdings?: Array<{ asset: string; amount: number; usd: number }> }>;
  orders?: Array<Record<string, unknown>>;
  connectLive?: { writes?: { on: boolean; capUsd: number } };
  payments: Array<{ id: string; kind: string; at: string; from: string; to: string; amountUsd: number; status: string; settlesAt: string; agent?: string; protocol?: string; note?: string }>;
  keys: Array<{ address: string; name: string; validUntil: string; status: string }>;
  spend: Array<{ id: string; agent: string; scope: string; allow: string[]; perPaymentUsd: number; budgetUsd: number; spentUsd: number; reservedUsd: number; windowHours: number; validUntil: string; expired: boolean; payTo: Record<string, string> }>;
  fees: Array<{ builder: string; maxFeeRate: string }>;
  cards: Array<{ id: string; flight: string; usd: number; reason: string; expiresAt?: string }>;
  subAccounts: Array<{ name: string; agent: string; address: string; capUsd: number; balanceUsd: number }>;
  pay: { payees: unknown[]; sessions: unknown[] };
}

server.registerTool(
  "portfolio_account",
  {
    description:
      "The ACCOUNT as this seat sees it — read this before trading, moving or paying anything. It returns this seat's own key (its address, and whether the owner has authorised it: an unauthorised key can do nothing, and the owner authorises it on the Account page), the limits the owner signed for it (`trade`: placing orders, with a per-order maximum, a budget of orders and what is left of it; `venues`: moving money between the user's own venues; `payees`: paying someone else), every venue connected live with what it holds and what this seat may trade there (`trading`), the orders on the account (yours marked `mine`) and where each stands, its sub-accounts (the floats it pays from), every venue's runways (how money gets in and out, how long it takes, and who may start it: `agent` = you, `owner` = only the owner's signature, `venue` = only at the venue's own page, `closed`), the account type (Unified lets you leave the source of a transfer to the account), recent payments with their status (a payment in flight is in no balance until it lands), the payees already paid and the payment sessions open. A venue the owner plugs in later (another exchange wallet, a self-custody wallet) appears here with its runways; it is in none of your approvals until the owner names it. A read.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    const r = await call("GET", "/api/account");
    if (r.status >= 400) return text({ ok: false, error: "this service runs without the account layer (--classic): use portfolio_execute" }, true);
    const a = r.body as AccountLite;
    const me = seatKey().address;
    const key = a.keys.find((k) => k.address === me);
    return text({
      now: a.now,
      seat: { name: agentOf().name, key: me, authorised: key?.status === "ok", ...(key ? { status: key.status, validUntil: key.validUntil } : { status: "not authorised: the owner lets this key in on the account page (Agents)" }) },
      accountType: a.type,
      totalUsd: a.totalUsd,
      inFlightUsd: a.inFlightUsd,
      approvals: a.spend.filter((s) => s.agent === me).map((s) => ({ scope: s.scope, allow: s.allow, perPaymentUsd: s.perPaymentUsd, budgetUsd: s.budgetUsd, leftUsd: Number((s.budgetUsd - s.spentUsd - s.reservedUsd).toFixed(6)), ...(s.windowHours ? { onePerHours: s.windowHours } : {}), validUntil: s.validUntil, expired: s.expired, ...(s.scope === "payees" ? { pinnedAddresses: s.payTo } : {}) })),
      floats: a.subAccounts.filter((s) => s.agent === me).map((s) => {
        // on the real account an agent wallet's money is what the chains say, read on its own line of the account
        const live = a.venues.find((v) => v.id === `agent-${s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`);
        return { name: s.name, address: s.address, balanceUsd: live ? live.usd : s.balanceUsd, capUsd: s.capUsd, ...(live ? { holdings: (live.holdings ?? []).filter((h) => h.amount).map((h) => ({ asset: h.asset, amount: h.amount, usd: h.usd })) } : {}) };
      }),
      venues: a.venues.map((v) => (v.live ? { id: v.id, name: v.name, frontLine: v.frontLine, usd: v.usd, live: true, trading: liveTrading(v, !!a.connectLive?.writes?.on), realMoney: liveMoney(v, !!a.connectLive?.writes?.on), holdings: (v.holdings ?? []).filter((h) => h.amount).slice(0, 30).map((h) => ({ asset: h.asset, amount: h.amount, usd: h.usd })), ...(v.address ? { address: v.address, proven: v.proven ?? "watched, not proven" } : {}) } : { id: v.id, name: v.name, frontLine: v.frontLine, usd: v.usd, movableUsd: v.cashUsd, ...(v.restricted ? { restricted: v.restricted } : { moneyIn: `${v.in.text} (${v.in.access})`, moneyOut: `${v.out.text} (${v.out.access})${v.out.why ? ` — ${v.out.why}` : ""}` }), ...(v.ledgers.length ? { ledgers: v.ledgers } : {}) })),
      ...(a.connectLive?.writes?.on ? { realMoney: { on: true, capUsd: a.connectLive.writes.capUsd } } : {}),
      waitingForOwner: a.cards,
      orders: (a.orders ?? []).slice(0, 20).map((o) => ({ ...orderView(o), mine: o.agent === me })),
      payments: a.payments.slice(0, 12).map((p) => ({ id: p.id, kind: p.kind, from: p.from, to: p.to, amountUsd: p.amountUsd, status: p.status, ...(p.status === "pending" ? { lands: p.settlesAt } : {}), ...(p.protocol ? { protocol: p.protocol } : {}), ...(p.note ? { note: p.note } : {}) })),
      payees: a.pay.payees,
      sessions: a.pay.sessions,
      appFees: a.fees,
    });
  },
);

server.registerTool(
  "portfolio_transfer",
  {
    description:
      "Move dollars BETWEEN THE USER'S OWN VENUES, signed with this seat's key: the one money movement an agent key can sign besides paying. `from` and `to` are venue ledgers — `okx`, `binance`, `hyperliquid` (or `hyperliquid:perps` / `hyperliquid:spot`), `metamask` (the on-chain wallet, the hub every route passes through), `sub:<name>` (one of your floats, filled from `metamask`) — and never an outside address: sending to someone else is the owner's own signature, and this tool cannot do it. A server that holds real accounts only refuses this: use portfolio_live_move there. Leave `from` empty only on a Unified account, and the account picks the open source that lands soonest. The account plans the route (swap, way out, bridge, way in), refuses it if it costs more than `maxFeeUsd`, and holds it against the owner's spending approval (both ends must be named in it; per-payment maximum; budget) and the openness dial. It returns a payment that may still be IN FLIGHT: a chain leg lands in seconds to minutes, and the money is in no balance until it does — read portfolio_account to see it land. {pending: true, card} means the owner is asked first. A refusal ({ok: false, code}) is not to be retried: E_ACCOUNT_OWNER_ONLY / E_VENUE_RAIL_CLOSED name a door that is not yours to open, E_MANDATE_* a limit of the approval.",
    inputSchema: { from: z.string().describe("source ledger, e.g. okx · metamask · hyperliquid:spot; empty on a Unified account"), to: z.string().describe("destination ledger, e.g. hyperliquid · hyperliquid:perps · metamask · sub:research"), amount: z.number().positive().describe("US dollars"), token: z.enum(["USDC", "USDT", "USD"]).optional().describe("what should arrive (default USDC)"), maxFeeUsd: z.number().nonnegative().optional().describe("the most the route may cost (default 5)") },
  },
  async ({ from, to, amount, token, maxFeeUsd }) => {
    if (!(await layer())) return text({ ok: false, error: "this service runs without the account layer (--classic): use portfolio_execute with a move intent" }, true);
    return answer(await sign({ type: "agentSendAsset", destination: "self", sourceDex: from, destinationDex: to, token: token ?? "USDC", amount: String(amount), fromSubAccount: "", maxFee: String(maxFeeUsd ?? 5) }));
  },
);

server.registerTool(
  "portfolio_live_move",
  {
    description:
      "Ask to move REAL money at venues the owner connected live (portfolio_account marks them `live: true`): withdraw from an exchange to another place of the user's, send from a wallet, transfer between an exchange's own ledgers, or swap one dollar stablecoin for another there. What happens next is the owner's mode. Conservative (the default): every request becomes a card the owner signs, showing the exact destination address and the fee the venue quotes; the answer is {pending: true, card} and portfolio_approval tells you how it went. Aggressive: a request inside your spending approval runs at once and the answer is the payment; outside it, a refusal. Money goes only to the user's own places (an exchange's own deposit address, or a wallet that proved it is the user's), at most the server's per-movement cap, and only if this server was started with real-money writes on. Your spending approval (`venues`) must name both venues. A refusal ({ok: false, code}) is not to be retried: E_WALLET_LIVE_WRITES_OFF (the server moves no real money), E_ACCOUNT_DESTINATION (not a place shown to be the user's), E_ACCOUNT_LIMIT (above the cap), E_VENUE_* (the venue's own rule).",
    inputSchema: {
      kind: z.enum(["withdraw", "send", "transfer", "swap", "bridge"]).describe("withdraw: from an exchange · send: from a wallet · transfer: between an exchange's own ledgers · swap: one stablecoin for another at an exchange · bridge: from a wallet to another chain (the same wallet there, another wallet of the user's, or an exchange's deposit address on that chain)"),
      toNetwork: z.enum(["Arbitrum", "Base", "Ethereum", "Optimism", "Polygon", "BNB Chain"]).optional().describe("bridge: the chain it lands on"),
      from: z.string().describe("the live venue's id, e.g. okx"),
      to: z.string().optional().describe("withdraw/send: the live venue it goes to (an exchange, or a proven wallet); the same venue for transfer and swap"),
      asset: z.enum(["USDC", "USDT"]).describe("what leaves"),
      toAsset: z.enum(["USDC", "USDT"]).optional().describe("swap: what you get"),
      network: z.enum(["Arbitrum", "Base", "Ethereum", "Optimism", "Polygon", "BNB Chain"]).optional().describe("withdraw/send: the chain it travels on"),
      fromLedger: z.string().optional().describe("transfer: e.g. funding"),
      toLedger: z.string().optional().describe("transfer: e.g. trading"),
      amount: z.number().positive().describe("in dollars (the stablecoin's units)"),
    },
  },
  async ({ kind, from, to, asset, toAsset, network, toNetwork, fromLedger, toLedger, amount }) => {
    if (!(await layer())) return text({ ok: false, error: "this service runs without the account layer (--classic)" }, true);
    const dest = kind === "transfer" || kind === "swap" ? from : kind === "bridge" ? to || from : (to ?? "");
    return answer(await sign({ type: "agentLiveMove", kind, from, fromLedger: fromLedger ?? "", to: dest, toLedger: kind === "bridge" ? (toNetwork ?? "") : (toLedger ?? ""), asset, toAsset: toAsset ?? asset, network: network ?? "", amount: String(amount), maxFee: "0" }));
  },
);

server.registerTool(
  "portfolio_live_markets",
  {
    description:
      "What a venue the owner connected live trades: markets matching `query` (a few letters: BTC, AAPL, FED), or a few to start from when it is empty — or ONE market by its exact `symbol`, with a fresh price (bid/ask/last), the smallest order, the steps of size and price, the order types it takes and whether it is open now. Every market is priced in dollars. Read this before portfolio_live_order: the symbol to send is the one this returns. A read.",
    inputSchema: { venue: z.string().describe("the live venue's id, e.g. okx · alpaca · kalshi (portfolio_account lists them)"), query: z.string().optional().describe("a few letters to search for"), symbol: z.string().optional().describe("one exact market symbol, for its fresh price and rules") },
    annotations: { readOnlyHint: true },
  },
  async ({ venue, query, symbol }) => {
    const r = symbol ? await call("GET", `/api/account/market?${new URLSearchParams({ venue, symbol })}`) : await call("GET", `/api/account/markets?${new URLSearchParams({ venue, q: query ?? "" })}`);
    const b = r.body as { ok?: boolean; refusal?: { code: string; message: string }; market?: unknown; markets?: unknown };
    if (b.refusal) return text({ ok: false, code: b.refusal.code, message: b.refusal.message }, true);
    return text(symbol ? { ok: true, market: b.market } : { ok: true, markets: b.markets });
  },
);

server.registerTool(
  "portfolio_live_compare",
  {
    description:
      "Where is it cheapest to buy, or best to sell? The same coin or stock (`base`: BTC, ETH, SOL, AAPL …) at every venue the owner connected live that trades it, ranked by the price an order would take there: the ask for a buy, the bid for a sell. Each row has the venue, its own symbol for it (send that to portfolio_live_order), the price, bid/ask and spread, whether it is open and whether this account can trade there now, and how much worse than the best it is. `usd` checks the size fits each venue's smallest order. Fees are not guessed: a venue's own note says so when it knows. A venue that does not answer in four seconds is listed under `missing`. A price far from the others is marked not ready: it may be another token under the same name. A read.",
    inputSchema: { base: z.string().describe("what to compare: BTC, ETH, AAPL"), side: z.enum(["buy", "sell"]), usd: z.number().positive().optional().describe("the size in dollars, to check it fits each venue's smallest order") },
    annotations: { readOnlyHint: true },
  },
  async ({ base, side, usd }) => {
    const r = await call("GET", `/api/account/compare?${new URLSearchParams({ base, side, ...(usd !== undefined ? { usd: String(usd) } : {}) })}`);
    const b = r.body as { refusal?: { code: string; message: string } } & Record<string, unknown>;
    if (b.refusal) return text({ ok: false, code: b.refusal.code, message: b.refusal.message }, true);
    return text(b);
  },
);

server.registerTool(
  "portfolio_live_order",
  {
    description:
      "Place a REAL order at a venue the owner connected live, signed with this seat's key: buy or sell `symbol` (exactly as portfolio_live_markets returns it), a size in the market's own units (`qty`: coins, shares, contracts) OR in dollars (`usd`, rounded down to the market's step): a market order, a limit order at `limitPrice`, a stop order (a market order once the price reaches `stopPrice`) or a stop_limit (a limit at `limitPrice` once it does) — with a time in force (`tif`), `postOnly` or `reduceOnly` only where the market lists them (portfolio_live_markets says which). It must be inside the trading limit the owner signed for this seat (which venues, how much an order, how much in all, until when — portfolio_account shows it) and no bigger than the server's cap. What happens next is the owner's mode. Conservative (the default): the order becomes a card the owner signs, showing the size, the price and what it is worth — the answer is {pending: true, card}; poll portfolio_approval, and once approved its `outcome` is the order. Aggressive: inside the limit it is placed at once and the answer is the order (status open, partial, filled …). Trading never moves money out of the venue. A refusal ({ok: false, code}) is not to be retried as is: E_MANDATE_* (your limit), E_ACCOUNT_LIMIT (the server's cap), E_VENUE_ORDER_INVALID (below the smallest order, off a step), E_VENUE_MARKET_CLOSED, E_ACCOUNT_UNPRICED, E_VENUE_* (the venue's own answer: funds, permissions, region), E_WALLET_LIVE_WRITES_OFF (the server is read-only).",
    inputSchema: {
      venue: z.string().describe("the live venue's id"),
      symbol: z.string().describe("the market, as portfolio_live_markets returns it"),
      side: z.enum(["buy", "sell"]),
      orderType: z.enum(["market", "limit", "stop", "stop_limit"]).optional().describe("default market"),
      qty: z.number().positive().optional().describe("size in the market's units; give this or usd"),
      usd: z.number().positive().optional().describe("size in dollars; give this or qty"),
      limitPrice: z.number().positive().optional().describe("limit and stop_limit orders: the price, in dollars per unit"),
      stopPrice: z.number().positive().optional().describe("stop and stop_limit orders: the price that triggers it"),
      tif: z.enum(["gtc", "ioc", "fok", "day"]).optional().describe("time in force, only where the market lists it; default the venue's own"),
      postOnly: z.boolean().optional().describe("a limit order that only rests on the book (maker), where the market takes it"),
      reduceOnly: z.boolean().optional().describe("an order that can only shrink a position, where the market takes it"),
    },
  },
  async ({ venue, symbol, side, orderType, qty, usd, limitPrice, stopPrice, tif, postOnly, reduceOnly }) => {
    if (!(await layer())) return text({ ok: false, error: "this service runs without the account layer (--classic): use portfolio_order" }, true);
    if ((qty === undefined) === (usd === undefined)) return text({ ok: false, error: "give the size once: qty (the market's units) or usd (dollars)" }, true);
    const type = orderType ?? "market";
    const limited = type === "limit" || type === "stop_limit";
    const stopped = type === "stop" || type === "stop_limit";
    if (limited && limitPrice === undefined) return text({ ok: false, error: `a ${type} order needs limitPrice` }, true);
    if (stopped && stopPrice === undefined) return text({ ok: false, error: `a ${type} order needs stopPrice` }, true);
    return answer(await sign({ type: "agentLiveOrder", venue, symbol, side, orderType: type, qty: qty !== undefined ? String(qty) : "", usd: usd !== undefined ? String(usd) : "", limitPrice: limited ? String(limitPrice) : "", ...(stopped ? { stopPrice: String(stopPrice) } : {}), ...(tif ? { tif } : {}), ...(postOnly ? { postOnly: "true" } : {}), ...(reduceOnly ? { reduceOnly: "true" } : {}) }));
  },
);

server.registerTool(
  "portfolio_live_amend",
  {
    description:
      "Change an order THIS seat placed, in place, at a venue that changes orders (portfolio_account shows your open orders; a venue that cannot answers E_VENUE_RAIL_CLOSED — cancel and place again there): its new size (`qty`), limit (`limitPrice`) or stop (`stopPrice`); what you leave out stays. Made smaller or cheaper, it simply goes. Made worth MORE, the difference is judged like a new order: Aggressive inside your trading limit at once, Conservative on a card the owner signs ({pending: true, card}). The answer is the order as it stands after.",
    inputSchema: { venue: z.string(), order: z.string().describe("its id on the account, e.g. ord-0007"), qty: z.number().positive().optional(), limitPrice: z.number().positive().optional(), stopPrice: z.number().positive().optional() },
  },
  async ({ venue, order, qty, limitPrice, stopPrice }) => {
    if (!(await layer())) return text({ ok: false, error: "this service runs without the account layer (--classic)" }, true);
    return answer(await sign({ type: "agentLiveAmend", venue, order, qty: qty !== undefined ? String(qty) : "", limitPrice: limitPrice !== undefined ? String(limitPrice) : "", stopPrice: stopPrice !== undefined ? String(stopPrice) : "" }));
  },
);

server.registerTool(
  "portfolio_live_positions",
  {
    description: "What is held at a venue connected live, as the venue lists it: perpetual positions (side, size, entry and mark price, unrealised profit, leverage, liquidation price), shares, event contracts. Read this before portfolio_live_close. A read.",
    inputSchema: { venue: z.string().describe("the live venue's id") },
    annotations: { readOnlyHint: true },
  },
  async ({ venue }) => {
    const r = await call("GET", `/api/account/positions?${new URLSearchParams({ venue })}`);
    const b = r.body as { refusal?: { code: string; message: string }; positions?: unknown };
    if (b.refusal) return text({ ok: false, code: b.refusal.code, message: b.refusal.message }, true);
    return text({ ok: true, positions: b.positions });
  },
);

server.registerTool(
  "portfolio_live_close",
  {
    description:
      "Close a position at a venue connected live — all of it, or `qty` of it — where your trading limit lets you trade. It only shrinks what is held, so it does not count against your limit; but a position may be the owner's own, so it is answered like an order: in Conservative a card the owner answers (wait on it with portfolio_wait), in Aggressive at once when it is worth no more than your per-order limit, else a card. The venue's own close where it has one; otherwise a reduce-only market order, and only in a market that takes reduce-only (so it can never open a position the other way). The answer is the closing order.",
    inputSchema: { venue: z.string(), symbol: z.string().describe("the position's market, as portfolio_live_positions lists it"), qty: z.number().positive().optional().describe("how much of it; all of it when left out") },
  },
  async ({ venue, symbol, qty }) => {
    if (!(await layer())) return text({ ok: false, error: "this service runs without the account layer (--classic)" }, true);
    return answer(await sign({ type: "agentLiveClose", venue, symbol, qty: qty !== undefined ? String(qty) : "" }));
  },
);

server.registerTool(
  "portfolio_live_leverage",
  {
    description: "Set a perpetual's leverage (and its margin mode: cross or isolated) at a venue that lets it be set, where your trading limit lets you trade — up to the most the owner lets agents use (1x unless the owner signed more; E_ACCOUNT_LIMIT says the cap).",
    inputSchema: { venue: z.string(), symbol: z.string().describe("a perpetual's market"), leverage: z.number().int().min(1).max(200), marginMode: z.enum(["cross", "isolated"]).optional() },
  },
  async ({ venue, symbol, leverage, marginMode }) => {
    if (!(await layer())) return text({ ok: false, error: "this service runs without the account layer (--classic)" }, true);
    return answer(await sign({ type: "agentLiveLeverage", venue, symbol, leverage: String(leverage), marginMode: marginMode ?? "" }));
  },
);

server.registerTool(
  "portfolio_live_cancel",
  {
    description: "Cancel an order this seat placed (its id on the account, `ord-0001`, from portfolio_live_order or portfolio_account). Never a card, in either mode: taking an order off the book moves nothing. An order the owner or another agent placed is not this seat's to cancel (E_ACCOUNT_ORDER_UNKNOWN). The answer is the order as it stands: canceled, with whatever had filled.",
    inputSchema: { venue: z.string().describe("the live venue's id"), order: z.string().describe("the order's id on the account, e.g. ord-0001") },
  },
  async ({ venue, order }) => {
    if (!(await layer())) return text({ ok: false, error: "this service runs without the account layer (--classic)" }, true);
    return answer(await sign({ type: "agentLiveCancel", venue, order }));
  },
);

server.registerTool(
  "portfolio_pay",
  {
    description:
      "Pay for something at a URL — an API call, a metered service, an item in a shop — up to `maxAmount` dollars, from one of your agent wallets / floats (`from`: its name; portfolio_account lists yours under `floats`). On the user's REAL account it is real USDC from an agent wallet the account holds the key of: x402 (V1 and V2) and MPP charges, on Base, Arbitrum, Optimism, Polygon or Ethereum; `method`/`body` ask a POST API. You do not pay yourself and you never hold the wallet's key: you sign this request, and the ACCOUNT asks the payee, reads the price and the receiving address out of the payee's own answer, and speaks whatever protocol the payee does (x402, MPP charge or session, AP2 with mandates this seat signs with its own key — sessions and AP2 on the simulated account only). It pays only a host the owner named in a `payees` spending approval, only inside that approval's per-payment maximum and budget, and only at the address the owner approved for that host. The FIRST payment to a payee comes back as {pending: true, card}: the owner is shown who is paid, where and how much; once they approve, the card's `outcome` (portfolio_approval) holds the payment and the data it bought — do not pay again; if instead it says mandates are needed (a shop paid from a float), call this tool once more. Later payments return {payment, data} at once. A metered service (an MPP session) locks a deposit from the float on the first call and spends from it call by call: when you are done, call again with `close: true` and the rest comes back. Refusals are final: E_PAYEE_OVERCHARGE (it asked for more than maxAmount), E_PAYEE_CHANGED (its address is not the approved one — tell the user, this is what an attack looks like), E_PAYEE_REDIRECT, E_PAYEE_UNVERIFIED, E_MANDATE_* (the approval's limits), E_WALLET_INSUFFICIENT (the float). On the real account: Conservative makes every payment a card; Aggressive pays a payee paid before at once (and any payee at once when the owner signed `*`). A payee that answers before settling on chain gets {paid: 'not yet'}: the amount stays set aside until the chain shows it used or it lapses.",
    inputSchema: { url: z.string().url().describe("https URL of what is being paid for"), maxAmount: z.number().nonnegative().describe("the most this one call may cost, in US dollars"), from: z.string().describe("the agent wallet / float that pays"), close: z.boolean().optional().describe("end the payment session at this URL and bring the unused deposit back (simulated account)"), method: z.enum(["GET", "POST"]).optional().describe("how the payee is asked (default GET)"), body: z.string().max(64_000).optional().describe("a POST's body"), contentType: z.string().max(100).optional().describe("the body's content type (default application/json)") },
  },
  async ({ url, maxAmount, from, close, method, body, contentType }) => {
    if (!(await layer())) return text({ ok: false, error: "this service runs without the account layer (--classic): it pays no one" }, true);
    const key = seatKey();
    const base = { type: "agentPay" as const, url, maxAmount: String(maxAmount), fromSubAccount: from, ...(method && method !== "GET" ? { method } : {}), ...(body !== undefined ? { body } : {}), ...(contentType ? { contentType } : {}) };
    const first = await sign({ ...base, ...(close ? { close: true } : {}), ...(close ? {} : { cnf: key.jwk }) });
    const needs = first.body.result as Ap2Needs | undefined;
    if (first.body.refusal || needs?.needs !== "mandates") return answer(first);
    // AP2: the merchant asks for this seat's own signature on what it commits the user to. It signs only what it can read in the merchant's
    // signed checkout: that checkout, that payee, that total — and only if the total is inside what it was asked to spend
    const signedTotal = (jwsParse(needs.checkout.jwt)?.payload.totals as Array<{ type: string; amount: number }> | undefined)?.find((t) => t.type === "total")?.amount;
    if (ap2CheckoutHash(needs.checkout.jwt) !== needs.checkout.hash || signedTotal !== needs.checkout.total.amount || signedTotal * 10_000 > micro(String(maxAmount))) return text({ ok: false, code: "E_PAYEE_OVERCHARGE", message: `the merchant's signed checkout totals $${((signedTotal ?? 0) / 100).toFixed(2)}, which is not what this seat was asked to pay: no mandate was signed` }, true);
    const now = await call("GET", "/api/now");
    return answer(await sign({ ...base, mandates: ap2Answer(key.p256, needs, Math.floor(Number((now.body as { ms: number }).ms) / 1000)) }));
  },
);

server.registerTool(
  "portfolio_approval",
  { description: "Status of a card the wallet raised: pending | approved | rejected, with the venue result once decided. For a card about a transfer or a payment, `outcome` holds what approving it released: the payment and the data it bought, or — at a shop that asks for AP2 mandates — a note that mandates are needed (call portfolio_pay again).", inputSchema: { id: z.string() }, annotations: { readOnlyHint: true } },
  async ({ id }) => {
    const r = await call("GET", "/api/overview");
    if (r.status >= 400) return text(r.body, true);
    const ap = (r.body as OverviewLite).approvals.find((x) => x.id === id);
    return ap ? text(ap) : text({ ok: false, error: `no card ${id}` }, true);
  },
);

/** what a waited-on thing is now: a card's status, an order's status and fill, a payment's status */
async function stateOf(what: { card?: string | undefined; order?: string | undefined; payment?: string | undefined }): Promise<{ key: string; value: unknown } | { error: string }> {
  if (what.card) {
    const r = await call("GET", "/api/overview");
    const ap = (r.body as OverviewLite).approvals?.find((x) => x.id === what.card) as (Record<string, unknown> & { status?: string }) | undefined;
    return ap ? { key: String(ap.status), value: ap } : { error: `no card ${what.card}` };
  }
  const r = await call("GET", "/api/account");
  if (r.status >= 400) return { error: "this service runs without the account layer (--classic)" };
  const a = r.body as AccountLite;
  if (what.order) {
    const o = (a.orders ?? []).find((x) => x.id === what.order) as (Record<string, unknown> & { status?: string; filledQty?: number }) | undefined;
    return o ? { key: `${o.status}:${o.filledQty}`, value: orderView(o) } : { error: `no order ${what.order} on the account` };
  }
  const p = a.payments.find((x) => x.id === what.payment);
  return p ? { key: p.status, value: p } : { error: `no payment ${what.payment} on the account` };
}

server.registerTool(
  "portfolio_wait",
  {
    description:
      "Wait for something to change instead of asking again and again: a card the owner has not answered yet (`card`), an order on its way or on the book (`order`), a movement in flight (`payment`). It returns as soon as it changes — a card answered, an order filled, part filled, canceled, a movement landed or failed — or after `timeoutSec` (at most 55) with `changed: false` and how it stands. Call it again to keep waiting. A read: it changes nothing.",
    inputSchema: { card: z.string().optional().describe("a card id, e.g. card-0003"), order: z.string().optional().describe("an order id, e.g. ord-0007"), payment: z.string().optional().describe("a payment id, e.g. pay-0002"), timeoutSec: z.number().int().positive().max(55).optional().describe("how long to wait at most (default 30)") },
    annotations: { readOnlyHint: true },
  },
  async ({ card, order, payment, timeoutSec }) => {
    if ([card, order, payment].filter(Boolean).length !== 1) return text({ ok: false, error: "wait for one thing: a card, an order or a payment" }, true);
    const first = await stateOf({ card, order, payment });
    if ("error" in first) return text({ ok: false, error: first.error }, true);
    // a card already answered, an order already done: nothing to wait for
    const settled = (k: string) => (card ? k !== "pending" : order ? /^(filled|canceled|rejected|expired):/.test(k) : ["settled", "failed", "returned"].includes(k));
    if (settled(first.key)) return text({ ok: true, changed: false, done: true, now: first.value });
    const until = Date.now() + (timeoutSec ?? 30) * 1000;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 1000));
      const now = await stateOf({ card, order, payment });
      if ("error" in now) return text({ ok: false, error: now.error }, true);
      if (now.key !== first.key) return text({ ok: true, changed: true, done: settled(now.key), was: first.key.split(":")[0], now: now.value });
    }
    return text({ ok: true, changed: false, done: false, now: first.value });
  },
);

server.registerTool(
  "portfolio_statement",
  {
    description:
      "The account's statement, like a bank's: every transaction at the user's real venues — orders (buys, sells) and movements (withdrawals, transfers, swaps, bridges, payments) — one line each, as it stands now, newest first, across restarts of the account. Each line: when, what, where, the dollars of it (a buy is money out, a sell money in), the fee, its status, and who did it (the owner, or an agent on the owner's yes or inside its limit). `mine: true` keeps only this seat's. A read.",
    inputSchema: { mine: z.boolean().optional().describe("only this seat's own transactions"), limit: z.number().int().positive().max(200).optional().describe("how many lines (default 50)") },
    annotations: { readOnlyHint: true },
  },
  async ({ mine, limit }) => {
    const r = await call("GET", "/api/account/statement");
    const b = r.body as { lines?: Array<Record<string, unknown> & { by?: string }>; refusal?: { code: string; message: string } };
    if (b.refusal || !Array.isArray(b.lines)) return text({ ok: false, error: b.refusal?.message ?? "no statement on this service" }, true);
    const name = agentOf().name;
    const lines = mine ? b.lines.filter((l) => String(l.by ?? "").startsWith(`${name},`)) : b.lines;
    return text({ ok: true, lines: lines.slice(0, limit ?? 50), total: lines.length });
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
process.stderr.write(`[agent-portfolio-manager] up (stdio) → ${BASE} · this seat signs with ${process.env.PORTFOLIO_SEAT_KEYS === "sim" ? "a key derived from its name (agent:<name>, PORTFOLIO_SEAT_KEYS=sim)" : "its own key, kept in <home>/seats"}; the owner authorises it on the Account page\n`);
