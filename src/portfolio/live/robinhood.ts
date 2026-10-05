/** Robinhood, through the interfaces Robinhood itself publishes (docs.robinhood.com and Robinhood's support pages, read 2026-10-05).
 *
 *   Robinhood stocks   agent.robinhood.com/mcp/trading — Robinhood's own MCP server, behind Robinhood's own sign-in (signin.ts). It gives
 *                      an agent read access to every Robinhood account and lets it trade only in a separate Agentic account. This connection
 *                      calls three of its tools — get_accounts, get_portfolio, get_equity_positions — and no other: never
 *                      review_equity_order, place_equity_order or cancel_equity_order.
 *   Robinhood Crypto   trading.robinhood.com/api/v2/crypto/trading/{accounts,holdings}/ and /api/v2/crypto/marketdata/best_bid_ask/ — an
 *                      API key and an Ed25519 signature over api key + timestamp (seconds) + path (with its query) + method + body, made
 *                      with the private key the user created, whose public half Robinhood holds. The API trades and reads; this only reads.
 *   Stock Tokens       api.robinhood.com/rhj/assets and /rhj/prices/{symbol} — no key: each token's contract on Robinhood Chain (4663),
 *                      and its bid in dollars per token. A wallet's tokens are read from the chain (address.ts).
 *
 * None of the three moves money in or out: Robinhood's deposits and withdrawals are made in Robinhood's own app.
 */
import { createPrivateKey, sign as cryptoSign, type KeyObject } from "node:crypto";
import { getAddress, isAddress, type Hex } from "viem";
import { isRefusal, type Refusal } from "../../core/errors.ts";
import { no } from "../refuse.ts";
import { CHAIN_BY_ID, type ChainName, type ChainReader, type TokenRef } from "./chain.ts";
import type { KeyFile, KeyShape } from "./credentials.ts";
import { asRefusal, isStable, num, redact, unreachable, venueSaidNo, type Http, type LiveBalance, type LiveSource } from "./types.ts";

// ---- Robinhood Crypto ----------------------------------------------------------------------

export const ROBINHOOD_CRYPTO_KEY: KeyShape = { required: ["apiKey", "privateKey"], example: '{"apiKey": "rh-api-…", "privateKey": "…"} (the base64 private key you made; Robinhood was given its public half when the credential was created)' };

const CRYPTO = "https://trading.robinhood.com";
/** an Ed25519 private key as PKCS#8 is this prefix and the 32-byte seed */
const ED25519_PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");

/** the private key Robinhood's docs have you make: 32 bytes, base64 */
export function robinhoodKey(base64: string): KeyObject | undefined {
  const seed = Buffer.from(base64.trim(), "base64");
  if (seed.length !== 32) return undefined;
  try {
    return createPrivateKey({ key: Buffer.concat([ED25519_PKCS8, seed]), format: "der", type: "pkcs8" });
  } catch {
    return undefined;
  }
}

/** the x-signature Robinhood expects for one request, base64 */
export function robinhoodSign(key: KeyObject, apiKey: string, timestampS: number | string, pathWithQuery: string, method: string, body = ""): string {
  return cryptoSign(null, Buffer.from(`${apiKey}${timestampS}${pathWithQuery}${method.toUpperCase()}${body}`), key).toString("base64");
}

export async function robinhoodCryptoSource(req: { venue: string; label: string; reference: string; key: KeyFile; http: Http; clock: () => number }): Promise<{ source: LiveSource; first: LiveBalance[] } | Refusal> {
  const name = req.label || "Robinhood Crypto";
  const key = robinhoodKey(req.key.privateKey ?? "");
  if (!key) return no("E_ACCOUNT_CREDENTIAL", { venue: req.venue, message: "the private key is not the base64 Ed25519 key Robinhood's docs have you make (32 bytes once decoded)" });
  const apiKey = req.key.apiKey!;
  const secrets = [apiKey, req.key.privateKey];
  const get = async (pathWithQuery: string): Promise<Record<string, unknown>> => {
    const ts = Math.floor(req.clock() / 1000);
    let r;
    try {
      r = await req.http(`${CRYPTO}${pathWithQuery}`, { headers: { "x-api-key": apiKey, "x-timestamp": String(ts), "x-signature": robinhoodSign(key, apiKey, ts, pathWithQuery, "GET"), accept: "application/json" } });
    } catch (err) {
      throw unreachable(req.venue, name, err, secrets);
    }
    if (r.status !== 200 || !r.body || typeof r.body !== "object") throw venueSaidNo(req.venue, name, r.status, r.text, secrets);
    return r.body as Record<string, unknown>;
  };
  /** a list Robinhood pages: `next` is the whole URL of the next page; five pages and no more */
  const all = async (path: string): Promise<Array<Record<string, unknown>>> => {
    const out: Array<Record<string, unknown>> = [];
    let next: string | undefined = path;
    for (let page = 0; next && page < 5; page++) {
      const body = await get(next);
      out.push(...((Array.isArray(body.results) ? body.results : []) as Array<Record<string, unknown>>));
      const n: unknown = body.next;
      next = typeof n === "string" && n.startsWith(`${CRYPTO}/`) ? n.slice(CRYPTO.length) : undefined;
    }
    return out;
  };
  const read = async (): Promise<LiveBalance[]> => {
    const out: LiveBalance[] = [];
    const held: Array<{ asset: string; amount: number; where: string }> = [];
    for (const a of await all("/api/v2/crypto/trading/accounts/")) {
      const number = String(a.account_number ?? "");
      // an account is named by its last four digits, never the whole number
      const tail = number ? `··${number.slice(-4)}` : "";
      const currency = String(a.buying_power_currency ?? "USD");
      const bp = num(a.buying_power);
      if (bp) out.push({ asset: currency, amount: bp, ...(currency === "USD" ? { usd: bp } : {}), where: `buying power ${tail}`.trim(), class: "cash" });
      if (!number) continue;
      for (const h of await all(`/api/v2/crypto/trading/holdings/?account_number=${encodeURIComponent(number)}`)) {
        const q = num(h.total_quantity);
        if (q > 0) held.push({ asset: String(h.asset_code ?? "?").toUpperCase(), amount: q, where: tail });
      }
    }
    // Robinhood's own price: the midpoint of what its market makers would buy and sell at
    const symbols = [...new Set(held.filter((h) => !isStable(h.asset)).map((h) => `${h.asset}-USD`))];
    const mid = new Map<string, number>();
    if (symbols.length) {
      const body = await get(`/api/v2/crypto/marketdata/best_bid_ask/?${symbols.map((s) => `symbol=${encodeURIComponent(s)}`).join("&")}`);
      for (const p of (Array.isArray(body.results) ? body.results : []) as Array<Record<string, unknown>>) if (num(p.price) > 0) mid.set(String(p.symbol), num(p.price));
    }
    for (const h of held) {
      const price = isStable(h.asset) ? 1 : mid.get(`${h.asset}-USD`);
      out.push({ asset: h.asset, amount: h.amount, ...(price ? { usd: h.amount * price } : {}), where: h.where, class: isStable(h.asset) ? "stable" : "crypto" });
    }
    return out;
  };
  try {
    const first = await read();
    const source: LiveSource = { name, kind: "cex", reference: req.reference, via: "Robinhood Crypto Trading API · priced at Robinhood's own midpoint", probe: { can: [], note: "a Robinhood crypto credential can trade; this connection only reads its accounts, holdings and prices", native: { calls: ["GET /api/v2/crypto/trading/accounts/", "GET /api/v2/crypto/trading/holdings/", "GET /api/v2/crypto/marketdata/best_bid_ask/"], signed: "Ed25519" } }, read, readOnlyBecause: "Robinhood's crypto API reads and trades; it has no call that moves money in or out: deposits and withdrawals are made in Robinhood's app" };
    return { source, first };
  } catch (err) {
    return asRefusal(req.venue, name, err, secrets);
  }
}

// ---- Stock Tokens --------------------------------------------------------------------------

const RHJ = "https://api.robinhood.com/rhj";

export interface StockToken {
  symbol: string;
  name: string;
  chain: ChainName;
  address: Hex;
}

/** the token list changes slowly: asked again after ten minutes, kept per network so a test's stand-in is never handed another's list */
const lists = new WeakMap<Http, { at: number; tokens: StockToken[] }>();

/** every active Stock Token, on the chains this account reads */
export async function stockTokens(http: Http, now: number): Promise<StockToken[]> {
  const kept = lists.get(http);
  if (kept && now - kept.at < 10 * 60_000) return kept.tokens;
  const r = await http(`${RHJ}/assets`, { headers: { accept: "application/json" } });
  if (r.status !== 200 || !r.body || typeof r.body !== "object") throw venueSaidNo("robinhood", "Robinhood's Stock Token list", r.status, r.text);
  const tokens: StockToken[] = [];
  for (const a of ((r.body as { assets?: unknown }).assets ?? []) as Array<Record<string, unknown>>) {
    if (a.status !== "ASSET_STATUS_ACTIVE" || typeof a.tokenSymbol !== "string") continue;
    for (const d of (Array.isArray(a.deployments) ? a.deployments : []) as Array<Record<string, unknown>>) {
      const chain = CHAIN_BY_ID.get(Number(d.chainId));
      if (chain && typeof d.contractAddress === "string" && isAddress(d.contractAddress, { strict: false })) tokens.push({ symbol: a.tokenSymbol, name: String(a.tokenName ?? a.tokenSymbol), chain, address: getAddress(d.contractAddress) });
    }
  }
  lists.set(http, { at: now, tokens });
  return tokens;
}

/** a token's bid is asked at most once a minute, and eight at a time: Robinhood allows sixty requests a second, and a wallet may hold many */
const bids = new WeakMap<Http, Map<string, { at: number; bid: number }>>();

/** dollars per token, from Robinhood's bid for the token itself (the share price times the token's corporate-action multiplier) */
export async function stockTokenBids(http: Http, symbols: string[], now: number): Promise<Map<string, number>> {
  const kept = bids.get(http) ?? new Map<string, { at: number; bid: number }>();
  bids.set(http, kept);
  const out = new Map<string, number>();
  const ask = symbols.filter((s) => {
    const k = kept.get(s);
    if (k && now - k.at < 60_000) out.set(s, k.bid);
    return !out.has(s);
  });
  for (let i = 0; i < ask.length; i += 8)
    await Promise.all(
      ask.slice(i, i + 8).map(async (s) => {
        try {
          const r = await http(`${RHJ}/prices/${encodeURIComponent(s)}`, { headers: { accept: "application/json" } });
          const q = ((r.body as { quotes?: unknown[] } | undefined)?.quotes?.[0] ?? {}) as Record<string, unknown>;
          if (r.status === 200 && num(q.tokenBid) > 0) {
            out.set(s, num(q.tokenBid));
            kept.set(s, { at: now, bid: num(q.tokenBid) });
          }
        } catch {
          // no price: the token is shown, and counts for nothing
        }
      }),
    );
  return out;
}

/** the Stock Tokens an address holds, priced; a list or a chain that does not answer is said, not thrown */
export async function stockTokenHoldings(holder: Hex, chain: ChainReader, http: Http, now: number): Promise<{ rows: LiveBalance[]; unread?: string }> {
  let tokens: StockToken[];
  try {
    tokens = await stockTokens(http, now);
  } catch {
    return { rows: [], unread: "Robinhood's Stock Token list did not answer" };
  }
  if (!tokens.length) return { rows: [] };
  const refs: TokenRef[] = tokens.map((t) => ({ chain: t.chain, asset: t.symbol, address: t.address }));
  const read = await chain.tokens(holder, refs);
  const held = read.rows.filter((b) => b.amount > 0);
  const bid = await stockTokenBids(http, [...new Set(held.map((b) => b.asset))], now);
  return {
    rows: held.map((b) => ({ asset: b.asset, amount: b.amount, ...(bid.has(b.asset) ? { usd: b.amount * bid.get(b.asset)! } : {}), where: `${b.chain} · Stock Token`, class: "equity" })),
    ...(read.failed.length ? { unread: `${read.failed.join(", ")} did not answer` } : {}),
  };
}

// ---- Robinhood stocks, through Robinhood's MCP server --------------------------------------

export const ROBINHOOD_MCP = "https://agent.robinhood.com/mcp/trading";

/** The only tools this connection ever calls. Robinhood's server also offers review_equity_order, place_equity_order and
 * cancel_equity_order (and watchlist tools that write); they are never called from here. */
export const READ_TOOLS = ["get_accounts", "get_portfolio", "get_equity_positions"] as const;
type ReadTool = (typeof READ_TOOLS)[number];

export interface McpTool {
  name: string;
  description?: string | undefined;
  inputSchema?: { required?: string[] | undefined; properties?: Record<string, unknown> | undefined } | undefined;
}
export interface McpSession {
  tools(): Promise<McpTool[]>;
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}
export type OpenMcp = (url: string, bearer: string) => Promise<McpSession>;

/** the real client: Streamable HTTP, the bearer token in a header (the SDK is loaded on first use) */
export const realMcp: OpenMcp = async (url, bearer) => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const client = new Client({ name: "buyer-agent-demo account", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${bearer}` } } });
  // the SDK's own types disagree with exactOptionalPropertyTypes on `sessionId`; the object is the SDK's own transport
  await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
  return {
    tools: async () => (await client.listTools()).tools as McpTool[],
    call: (name, args) => client.callTool({ name, arguments: args }),
    close: () => client.close(),
  };
};

/** what a tool answered, as data: its structured content, or its text read as JSON */
export function toolData(result: unknown): unknown {
  const r = (result ?? {}) as { structuredContent?: unknown; content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  const text = (Array.isArray(r.content) ? r.content : []).filter((c) => c?.type === "text").map((c) => c.text ?? "").join("\n").trim();
  if (r.isError) throw new Error(text.slice(0, 200) || "the tool answered with an error");
  if (r.structuredContent !== undefined) return r.structuredContent;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** every object in a value, depth first, not too deep */
function* objects(v: unknown, depth = 0): Generator<Record<string, unknown>> {
  if (depth > 6 || !v || typeof v !== "object") return;
  if (Array.isArray(v)) {
    for (const x of v) yield* objects(x, depth + 1);
    return;
  }
  yield v as Record<string, unknown>;
  for (const x of Object.values(v)) yield* objects(x, depth + 1);
}

const pick = (o: Record<string, unknown>, keys: string[]): unknown => keys.map((k) => o[k]).find((x) => x !== undefined && x !== null && x !== "");
/** a number, or a money object ({amount, currency_code}) */
const amountOf = (v: unknown): number => (v && typeof v === "object" ? num((v as { amount?: unknown }).amount) : num(v));

/** The field names Robinhood's tools are read by. Robinhood does not publish what the tools answer, so these are the names its own APIs
 * use; an answer with none of them is said to be unreadable rather than read as zero. */
const ACCOUNT_ID = ["account_number", "accountNumber", "account_id", "accountId"];
const ACCOUNT_TYPE = ["account_type", "type", "brokerage_account_type", "nickname", "name"];
const SYMBOL = ["symbol", "ticker", "instrument_symbol"];
const QTY = ["quantity", "shares", "qty"];
const VALUE = ["market_value", "marketValue", "equity", "value", "current_value"];
const PRICE = ["price", "last_trade_price", "current_price", "mark_price", "last_price"];
const CASH = ["cash", "withdrawable_amount", "uninvested_cash", "cash_balance", "cash_available_for_withdrawal"];

export function accountsIn(data: unknown): Array<{ number: string; type: string }> {
  const seen = new Map<string, string>();
  for (const o of objects(data)) {
    const id = pick(o, ACCOUNT_ID);
    if (typeof id === "string" || typeof id === "number") seen.set(String(id), String(pick(o, ACCOUNT_TYPE) ?? ""));
  }
  return [...seen].map(([number, type]) => ({ number, type }));
}

export function cashIn(data: unknown): number | undefined {
  for (const o of objects(data)) {
    const v = pick(o, CASH);
    if (v !== undefined) return amountOf(v);
  }
  return undefined;
}

export function positionsIn(data: unknown): Array<{ symbol: string; quantity: number; usd?: number | undefined; account?: string | undefined }> {
  const out: Array<{ symbol: string; quantity: number; usd?: number | undefined; account?: string | undefined }> = [];
  for (const o of objects(data)) {
    const symbol = pick(o, SYMBOL);
    const quantity = amountOf(pick(o, QTY));
    if (typeof symbol !== "string" || !quantity) continue;
    const value = pick(o, VALUE);
    const price = amountOf(pick(o, PRICE));
    const account = pick(o, ACCOUNT_ID);
    out.push({ symbol, quantity, usd: value !== undefined ? amountOf(value) : price ? price * quantity : undefined, ...(account !== undefined ? { account: String(account) } : {}) });
  }
  return out;
}

/** the keys of an answer, and nothing in them: what is said when an answer cannot be read */
const shapeOf = (data: unknown): string[] => (Array.isArray(data) ? ["[list]", ...shapeOf(data[0])] : data && typeof data === "object" ? Object.keys(data).slice(0, 20) : [typeof data]);

const asksForAccount = (t: McpTool | undefined): string | undefined => (t?.inputSchema?.required ?? []).find((k) => /account/i.test(k));

export async function robinhoodStocksSource(req: { venue: string; label: string; token: () => Promise<string | Refusal>; open: OpenMcp }): Promise<{ source: LiveSource; first: LiveBalance[] } | Refusal> {
  const name = req.label || "Robinhood";
  let offered: string[] = [];
  let tokenSeen: string | undefined;
  const read = async (): Promise<LiveBalance[]> => {
    const token = await req.token();
    if (isRefusal(token)) throw token;
    tokenSeen = token;
    let session: McpSession;
    try {
      session = await req.open(ROBINHOOD_MCP, token);
    } catch (err) {
      throw unreachable(req.venue, name, err, [token]);
    }
    try {
      const tools = new Map((await session.tools()).map((t) => [t.name, t]));
      offered = [...tools.keys()];
      const reads = READ_TOOLS.filter((t) => tools.has(t));
      if (!reads.length) throw no("E_VENUE_REJECTED", { venue: req.venue, message: `${name}'s MCP server offered none of the tools this connection reads with (${READ_TOOLS.join(", ")})`, native: { offered } });
      // only ever a name from READ_TOOLS: whatever else the server offers is left alone
      const call = async (tool: ReadTool, args: Record<string, unknown> = {}) => toolData(await session.call(tool, args));
      const accounts = tools.has("get_accounts") ? accountsIn(await call("get_accounts")) : [];
      const answers: Array<{ tool: ReadTool; account?: string | undefined; data: unknown }> = [];
      for (const tool of ["get_portfolio", "get_equity_positions"] as const) {
        if (!tools.has(tool)) continue;
        // a tool that needs an account names it in its input schema: it is asked once per account
        const arg = asksForAccount(tools.get(tool));
        if (arg) for (const a of accounts) answers.push({ tool, account: a.number, data: await call(tool, { [arg]: a.number }) });
        else answers.push({ tool, data: await call(tool) });
      }
      const tail = (n: string | undefined) => (n ? ` ··${n.slice(-4)}` : "");
      const out: LiveBalance[] = [];
      for (const a of answers.filter((x) => x.tool === "get_portfolio")) {
        const cash = cashIn(a.data);
        if (cash) out.push({ asset: "USD", amount: cash, usd: cash, where: `cash${tail(a.account)}`, class: "cash" });
      }
      for (const a of answers.filter((x) => x.tool === "get_equity_positions"))
        for (const p of positionsIn(a.data)) out.push({ asset: p.symbol, amount: Math.abs(p.quantity), ...(p.usd !== undefined ? { usd: p.usd } : {}), where: `stocks${tail(p.account ?? a.account)}`, class: "equity" });
      if (!out.length && !accounts.length) throw no("E_VENUE_REJECTED", { venue: req.venue, message: `${name} answered, but not in a shape this connection reads yet: nothing in it looks like an account, cash or a position`, native: { answered: answers.map((a) => ({ tool: a.tool, keys: shapeOf(a.data) })) } });
      return out;
    } finally {
      await session.close().catch(() => undefined);
    }
  };
  try {
    const first = await read();
    const source: LiveSource = { name, kind: "broker", reference: "signed in at Robinhood", via: "Robinhood's MCP server · Robinhood's own sign-in", probe: { can: ["read every Robinhood account", "trade in the Agentic account"], note: `this connection calls ${READ_TOOLS.join(", ")} and nothing else — never review_equity_order, place_equity_order or cancel_equity_order${offered.length ? ` (Robinhood offered ${offered.length} tools)` : ""}`, native: { server: ROBINHOOD_MCP, offered, called: READ_TOOLS } }, read, readOnlyBecause: "Robinhood moves money in and out only in its own app; through its MCP server an agent trades in the Agentic account and nothing else, and this account only reads" };
    return { source, first };
  } catch (err) {
    return asRefusal(req.venue, name, isRefusal(err) ? err : new Error(redact(String((err as Error)?.message ?? err), [tokenSeen])), [tokenSeen]);
  }
}
