/** The Hyperliquid seat: holds the AGENT key (never the master's), signs
 * exchange actions with it, and reads the master's state. `withdraw3` exists
 * on this server because the real API has it; the manifest denies it, and the
 * venue refuses it for agent keys anyway — two lines, both visible. */
import { z } from "zod";
import { keyFromSeed, sign } from "../../core/ed25519.ts";
import { canonical } from "../../core/hash.ts";
import { http } from "../_shared/http.ts";
import { loadCredential, type CredentialRecord } from "../_shared/identity.ts";
import { fail, log, ok, pluginEnv, serve } from "../_shared/server.ts";

interface AgentWalletCredential extends CredentialRecord {
  kind: "agent-wallet";
  seed: string;
  address: string;
  master: string;
}

const env = pluginEnv();
if (!env.credRef) throw new Error("the hyperliquid seat needs a credential ref (BUYER_CRED_REF)");
const cred = loadCredential<AgentWalletCredential>(env.credRef, env.venue, env.home);
const kp = keyFromSeed(cred.seed);
const base = env.venueUrl.replace(/\/$/, "");
let lastNonce = 0;
const nextNonce = () => {
  let n = Date.now();
  if (n <= lastNonce) n = lastNonce + 1;
  lastNonce = n;
  return n;
};

async function info(body: Record<string, unknown>) {
  const r = await http(`${base}/info`, { method: "POST", body });
  return r;
}

async function exchange(action: Record<string, unknown>) {
  const nonce = nextNonce();
  const sig = sign(kp.privateKey, canonical({ action, nonce }));
  const r = await http(`${base}/exchange`, { method: "POST", body: { action, nonce, signature: { pubkey: kp.publicKeyHex, sig } } });
  const body = r.body as { status?: string; response?: unknown };
  if (r.status >= 400 || body?.status === "err") {
    return { ok: false as const, venueError: { status: r.status >= 400 ? r.status : "err", response: body?.response ?? body } };
  }
  return { ok: true as const, body };
}

const meta = await info({ type: "meta" });
const universe = ((meta.body as { universe?: Array<{ name: string }> }).universe ?? []).map((u) => u.name);
const assetIndex = (coin: string): number => {
  const i = universe.indexOf(coin);
  if (i < 0) throw new Error(`unknown coin ${coin}; universe is ${universe.join(", ")}`);
  return i;
};
log(`credential ref ${env.credRef} resolved · agent ${cred.address} for master ${cred.master} · universe ${universe.join(",")}`);

await serve({ name: "hyperliquid-seat", version: "0.1.0" }, (server) => {
  server.registerTool(
    "l2Book",
    { description: "Order book for a coin, with the mid price.", inputSchema: { coin: z.string() }, annotations: { readOnlyHint: true } },
    async ({ coin }) => {
      const r = await info({ type: "l2Book", coin });
      if (r.status >= 400) return fail({ venueError: { status: r.status, ...(r.body as object) } });
      const book = r.body as { levels: [Array<{ px: string }>, Array<{ px: string }>] };
      const bestBid = Number(book.levels[0][0]?.px ?? 0);
      const bestAsk = Number(book.levels[1][0]?.px ?? 0);
      return ok({ ...book, mid: Number(((bestBid + bestAsk) / 2).toFixed(1)) });
    },
  );
  server.registerTool(
    "userState",
    { description: "The master account's margin summary and positions.", inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => {
      const r = await info({ type: "userState", user: cred.master });
      return r.status < 400 ? ok(r.body) : fail({ venueError: { status: r.status, ...(r.body as object) } });
    },
  );
  server.registerTool(
    "openOrders",
    { description: "Resting orders of the master account.", inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => {
      const r = await info({ type: "openOrders", user: cred.master });
      return r.status < 400 ? ok(r.body) : fail({ venueError: { status: r.status, ...(r.body as object) } });
    },
  );
  server.registerTool(
    "userFills",
    { description: "Fills of the master account.", inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => {
      const r = await info({ type: "userFills", user: cred.master });
      return r.status < 400 ? ok(r.body) : fail({ venueError: { status: r.status, ...(r.body as object) } });
    },
  );
  server.registerTool(
    "order",
    {
      description: "Place a limit order (operator-gated). tif Gtc rests, Ioc fills or dies.",
      inputSchema: {
        coin: z.string(),
        is_buy: z.boolean(),
        sz: z.number().positive(),
        limit_px: z.number().positive(),
        tif: z.enum(["Gtc", "Ioc", "Alo"]).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (a) => {
      const action = {
        type: "order",
        orders: [{ a: assetIndex(a.coin), b: a.is_buy, p: String(a.limit_px), s: String(a.sz), r: false, t: { limit: { tif: a.tif ?? "Gtc" } } }],
        grouping: "na",
      };
      const r = await exchange(action);
      if (!r.ok) return fail({ venueError: r.venueError });
      const status = (r.body.response as { data?: { statuses?: Array<Record<string, unknown>> } })?.data?.statuses?.[0] ?? {};
      if ("error" in status) return fail({ venueError: { status: "err", response: status.error } });
      if ("filled" in status) {
        const f = status.filled as { totalSz: string; avgPx: string; oid: number };
        return ok({ status: "filled", oid: f.oid, avgPx: f.avgPx, totalSz: f.totalSz, coin: a.coin, is_buy: a.is_buy, sz: a.sz });
      }
      const rest = status.resting as { oid: number };
      return ok({ status: "resting", oid: rest.oid, coin: a.coin, is_buy: a.is_buy, sz: a.sz, limit_px: a.limit_px });
    },
  );
  server.registerTool(
    "cancel",
    {
      description: "Cancel a resting order by oid (operator-gated).",
      inputSchema: { coin: z.string(), oid: z.number().int() },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ coin, oid }) => {
      const r = await exchange({ type: "cancel", cancels: [{ a: assetIndex(coin), o: oid }] });
      if (!r.ok) return fail({ venueError: r.venueError });
      return ok({ status: "canceled", oid });
    },
  );
  server.registerTool(
    "withdraw3",
    {
      description: "Withdraw USDC to an address. Exists on the real API; the manifest never mounts it.",
      inputSchema: { destination: z.string(), amount: z.number().positive() },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ destination, amount }) => {
      const r = await exchange({ type: "withdraw3", destination, amount: String(amount), time: Date.now() });
      if (!r.ok) return fail({ venueError: r.venueError });
      return ok({ status: "ok", destination, amount });
    },
  );
});
