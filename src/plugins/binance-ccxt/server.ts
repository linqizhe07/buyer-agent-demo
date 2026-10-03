/** A third-party seat in the shape of the official CCXT MCP server: unified
 * tool names (`fetchTicker`, `createOrder`, `withdraw`, ...), unified symbols
 * (`BTC/USDT`), the exchange key held locally and never shown to the model.
 *
 * Nothing in this file knows about the host's gate. That is the point of the
 * Binance beat: a server we did not write is still bounded, because the
 * manifest classified `createOrder` as write and never mounted `withdraw`. */
import { createHmac } from "node:crypto";
import { z } from "zod";
import { http } from "../_shared/http.ts";
import { loadCredential, type CredentialRecord } from "../_shared/identity.ts";
import { fail, log, ok, pluginEnv, serve } from "../_shared/server.ts";

interface HmacCredential extends CredentialRecord {
  kind: "hmac-api-key";
  apiKey: string;
  secret: string;
  permissions: string[];
  ipWhitelist: string[];
}

const env = pluginEnv();
if (!env.credRef) throw new Error("the binance seat needs a credential ref (BUYER_CRED_REF)");
const cred = loadCredential<HmacCredential>(env.credRef, env.venue, env.home);
const base = env.venueUrl.replace(/\/$/, "");
const SOURCE_IP = process.env.BUYER_SOURCE_IP ?? "127.0.0.1";

const toMarket = (unified: string) => unified.replace("/", "");

function signParams(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries({ ...params, timestamp: Date.now(), recvWindow: 5000 }).filter(([, v]) => v !== undefined) as Array<[string, string | number]>;
  const query = entries.map(([k, v]) => `${k}=${v}`).join("&");
  const signature = createHmac("sha256", cred.secret).update(query).digest("hex");
  return `${query}&signature=${signature}`;
}

async function pub(path: string, query?: Record<string, string>) {
  return http(`${base}${path}`, { query });
}

async function signed(method: "GET" | "POST" | "DELETE", path: string, params: Record<string, string | number | undefined> = {}) {
  const q = signParams(params);
  const headers = { "X-MBX-APIKEY": cred.apiKey, "X-Demo-Source-IP": SOURCE_IP };
  if (method === "POST") {
    return fetch(`${base}${path}`, { method, headers: { ...headers, "content-type": "application/x-www-form-urlencoded" }, body: q }).then(async (r) => ({
      status: r.status,
      body: (await r.json()) as unknown,
    }));
  }
  return http(`${base}${path}?${q}`, { method, headers });
}

const venueFail = (status: number, body: unknown) => fail({ venueError: { status, ...((body as object) ?? {}) } });

log(`credential ref ${env.credRef} resolved · permissions ${cred.permissions.join(",")} · ip whitelist ${cred.ipWhitelist.join(",")}`);

await serve({ name: "ccxt-binance", version: "0.1.0" }, (server) => {
  server.registerTool(
    "fetchTicker",
    { description: "Fetch the ticker for a unified symbol, e.g. BTC/USDT.", inputSchema: { symbol: z.string() }, annotations: { readOnlyHint: true } },
    async ({ symbol }) => {
      const r = await pub("/api/v3/ticker/price", { symbol: toMarket(symbol) });
      if (r.status >= 400) return venueFail(r.status, r.body);
      const px = Number((r.body as { price: string }).price);
      return ok({ symbol, last: px, bid: Number((px * 0.9998).toFixed(2)), ask: Number((px * 1.0002).toFixed(2)) });
    },
  );
  server.registerTool(
    "fetchBalance",
    { description: "Account balances and the key's permissions.", inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => {
      const r = await signed("GET", "/api/v3/account");
      if (r.status >= 400) return venueFail(r.status, r.body);
      const acct = r.body as { balances: Array<{ asset: string; free: string }>; permissions: string[]; canWithdraw: boolean };
      const free: Record<string, number> = {};
      for (const b of acct.balances) free[b.asset] = Number(b.free);
      return ok({ free, permissions: acct.permissions, canWithdraw: acct.canWithdraw });
    },
  );
  server.registerTool(
    "fetchOpenOrders",
    { description: "Open orders, optionally for one symbol.", inputSchema: { symbol: z.string().optional() }, annotations: { readOnlyHint: true } },
    async ({ symbol }) => {
      const r = await signed("GET", "/api/v3/openOrders", symbol ? { symbol: toMarket(symbol) } : {});
      return r.status < 400 ? ok(r.body) : venueFail(r.status, r.body);
    },
  );
  server.registerTool(
    "fetchMyTrades",
    { description: "Trades of this account for a symbol.", inputSchema: { symbol: z.string() }, annotations: { readOnlyHint: true } },
    async ({ symbol }) => {
      const r = await signed("GET", "/api/v3/myTrades", { symbol: toMarket(symbol) });
      return r.status < 400 ? ok(r.body) : venueFail(r.status, r.body);
    },
  );
  server.registerTool(
    "createOrder",
    {
      description: "Create an order: unified symbol, type market|limit, side buy|sell, amount in base, price for limit.",
      inputSchema: {
        symbol: z.string(),
        type: z.enum(["market", "limit"]),
        side: z.enum(["buy", "sell"]),
        amount: z.number().positive(),
        price: z.number().positive().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (a) => {
      const r = await signed("POST", "/api/v3/order", {
        symbol: toMarket(a.symbol),
        side: a.side.toUpperCase(),
        type: a.type.toUpperCase(),
        quantity: a.amount,
        ...(a.type === "limit" ? { price: a.price, timeInForce: "GTC" } : {}),
      });
      if (r.status >= 400) return venueFail(r.status, r.body);
      const o = r.body as { orderId: number; status: string; executedQty: string; cummulativeQuoteQty: string; fills: Array<{ price: string }> };
      const avg = o.fills.length ? Number(o.fills[0]!.price) : undefined;
      return ok({ id: String(o.orderId), status: o.status.toLowerCase(), symbol: a.symbol, side: a.side, amount: a.amount, filled: Number(o.executedQty), average: avg, cost: Number(o.cummulativeQuoteQty) });
    },
  );
  server.registerTool(
    "cancelOrder",
    { description: "Cancel an open order by id.", inputSchema: { id: z.string(), symbol: z.string() }, annotations: { readOnlyHint: false, destructiveHint: true } },
    async ({ id, symbol }) => {
      const r = await signed("DELETE", "/api/v3/order", { symbol: toMarket(symbol), orderId: id });
      return r.status < 400 ? ok({ id, status: "canceled" }) : venueFail(r.status, r.body);
    },
  );
  server.registerTool(
    "withdraw",
    {
      description: "Withdraw a coin to an address. Exists on the server; the manifest never mounts it.",
      inputSchema: { code: z.string(), amount: z.number().positive(), address: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ code, amount, address }) => {
      const r = await signed("POST", "/sapi/v1/capital/withdraw/apply", { coin: code, amount, address });
      return r.status < 400 ? ok(r.body) : venueFail(r.status, r.body);
    },
  );
});
