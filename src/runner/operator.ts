/** Operator-side actions: things the HUMAN does outside the agent's tool
 * surface. They read the operator's own files in the home directly (plain
 * JSON, never through the seats' identity resolver) and talk to the venue as
 * the venue's customer would.
 *
 * `hlBypassWithdraw` is the deliberate exception: it reads the AGENT key file
 * the way a shell inside the workspace could (residual R1) and skips every
 * gate — to show that the venue's own line holds when ours is not in the path.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { keyFromSeed, sign } from "../core/ed25519.ts";
import { refuse, type Refusal } from "../core/errors.ts";
import { canonical } from "../core/hash.ts";
import type { DemoEnv } from "./env.ts";

interface SeedFile {
  seed: string;
  address: string;
  master?: string;
}

function readHomeJson<T>(env: DemoEnv, rel: string): T {
  return JSON.parse(readFileSync(join(env.home, rel), "utf8")) as T;
}

async function postExchange(url: string, seedHex: string, action: Record<string, unknown>) {
  const kp = keyFromSeed(seedHex);
  // a per-signer nonce, like the seat's: the venue only asks that it increases
  const nonce = Date.now();
  const sig = sign(kp.privateKey, canonical({ action, nonce }));
  const res = await fetch(`${url}/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, nonce, signature: { pubkey: kp.publicKeyHex, sig } }),
  });
  return { status: res.status, body: (await res.json()) as { status: string; response: unknown } };
}

export interface AgentApproval {
  agentAddress: string;
  master: string;
  validUntil: number;
  response: unknown;
}

/** The operator, with the MASTER key, approves the seat's agent key for `validForMs`. */
export async function hlApproveAgent(env: DemoEnv, validForMs: number): Promise<AgentApproval> {
  const venue = env.venues.hyperliquid;
  if (!venue) throw new Error("hyperliquid sim is not up");
  const master = readHomeJson<SeedFile>(env, "credentials/hyperliquid/master.json");
  const agent = readHomeJson<SeedFile>(env, "credentials/hyperliquid/agent-wallet.json");
  const validUntil = env.clock.now() + validForMs;
  const r = await postExchange(venue.url, master.seed, {
    type: "approveAgent",
    agentAddress: agent.address,
    agentName: `buyer-agent-demo valid_until ${validUntil}`,
  });
  if (r.body.status !== "ok") throw new Error(`approveAgent failed: ${JSON.stringify(r.body)}`);
  const record = { venue: "hyperliquid", agentAddress: agent.address, master: master.address, validUntil, approvedAt: env.clock.iso(), by: "operator" };
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(join(env.home, "agent-wallets"), { recursive: true });
  writeFileSync(join(env.home, "agent-wallets", "hyperliquid.json"), JSON.stringify(record, null, 2) + "\n");
  env.bus.emit("agent-wallet/approved", record);
  env.ledger.append({ kind: "note", venue: "hyperliquid", outcome: "agent-approved", detail: record });
  return { agentAddress: agent.address, master: master.address, validUntil, response: r.body.response };
}

/** Skip every gate: sign a withdrawal with the agent key read straight from the home. */
export async function hlBypassWithdraw(env: DemoEnv, destination: string, amount: number): Promise<{ refusal?: Refusal; body: unknown }> {
  const venue = env.venues.hyperliquid;
  if (!venue) throw new Error("hyperliquid sim is not up");
  const agent = readHomeJson<SeedFile>(env, "credentials/hyperliquid/agent-wallet.json");
  const r = await postExchange(venue.url, agent.seed, { type: "withdraw3", destination, amount: String(amount), time: Date.now() });
  const row = { destination, amount, signer: agent.address, response: r.body };
  if (r.body.status === "ok") {
    env.ledger.append({ kind: "bypass", venue: "hyperliquid", outcome: "withdrawn", detail: row });
    return { body: r.body };
  }
  const text = String(r.body.response ?? "");
  const refusal = refuse(/cannot withdraw/i.test(text) ? "E_VENUE_AGENT_NO_WITHDRAW" : "E_VENUE_REJECTED", {
    venue: "hyperliquid",
    tool: "withdraw3 (bypass)",
    native: r.body,
  });
  env.ledger.append({ kind: "bypass", venue: "hyperliquid", outcome: "refused", code: refusal.code, reason: refusal.message, native: r.body, detail: row });
  env.bus.emit("venue/refused", { venue: "hyperliquid", tool: "withdraw3 (bypass)", refusal, bypass: true });
  return { refusal, body: r.body };
}

/** A stolen trade-only Binance key, used from an IP outside its whitelist, asks for a withdrawal. */
export async function binanceBypassWithdraw(
  env: DemoEnv,
  req: { coin: string; amount: number; address: string; sourceIp: string },
): Promise<{ refusal?: Refusal; body: unknown }> {
  const venue = env.venues.binance;
  if (!venue) throw new Error("binance sim is not up");
  const key = readHomeJson<{ apiKey: string; secret: string }>(env, "credentials/binance/spot-trade.json");
  const { createHmac } = await import("node:crypto");
  const params = `coin=${req.coin}&amount=${req.amount}&address=${req.address}&timestamp=${Date.now()}&recvWindow=5000`;
  const signature = createHmac("sha256", key.secret).update(params).digest("hex");
  const res = await fetch(`${venue.url}/sapi/v1/capital/withdraw/apply`, {
    method: "POST",
    headers: { "X-MBX-APIKEY": key.apiKey, "X-Demo-Source-IP": req.sourceIp, "content-type": "application/x-www-form-urlencoded" },
    body: `${params}&signature=${signature}`,
  });
  const body = (await res.json()) as { code?: number; msg?: string };
  const row = { ...req, response: body, status: res.status };
  if (res.status < 400) {
    env.ledger.append({ kind: "bypass", venue: "binance", outcome: "withdrawn", detail: row });
    return { body };
  }
  const refusal = refuse(body.code === -2015 ? "E_VENUE_PERMISSION" : "E_VENUE_REJECTED", {
    venue: "binance",
    tool: "withdraw (bypass)",
    native: { status: res.status, ...body },
  });
  env.ledger.append({ kind: "bypass", venue: "binance", outcome: "refused", code: refusal.code, reason: refusal.message, native: body, detail: row });
  env.bus.emit("venue/refused", { venue: "binance", tool: "withdraw (bypass)", refusal, bypass: true });
  return { refusal, body };
}

export async function hlExtraAgents(env: DemoEnv): Promise<Array<{ address: string; name: string; validUntil: number }>> {
  const venue = env.venues.hyperliquid;
  if (!venue) throw new Error("hyperliquid sim is not up");
  const master = readHomeJson<SeedFile>(env, "credentials/hyperliquid/master.json");
  const res = await fetch(`${venue.url}/info`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "extraAgents", user: master.address }),
  });
  return (await res.json()) as Array<{ address: string; name: string; validUntil: number }>;
}

/** The injection beat's second line: hand the SAME poisoned intent straight to
 * the signer, as if the mandate layer did not exist. */
export async function signerAskDirectly(
  env: DemoEnv,
  intent: { to: string; lamports: number; program: string; token: string },
): Promise<{ refusal?: Refusal; body: unknown }> {
  const signer = env.venues.signer;
  if (!signer) throw new Error("policy signer is not up");
  const res = await fetch(`${signer.url}/sign`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ intent, recentBlockhash: "demo-direct" }),
  });
  const body = (await res.json()) as { refused?: boolean; reason?: string; detail?: Record<string, unknown> };
  if (!body.refused) {
    env.ledger.append({ kind: "bypass", venue: "solana", outcome: "signed", detail: { intent } });
    return { body };
  }
  const code =
    body.reason === "recipient_not_allowlisted"
      ? "E_SIGNER_RECIPIENT"
      : body.reason === "per_tx_cap"
        ? "E_SIGNER_TX_CAP"
        : body.reason === "daily_cap"
          ? "E_SIGNER_DAILY_CAP"
          : "E_SIGNER_UNAVAILABLE";
  const refusal = refuse(code, { venue: "solana", tool: "sign (direct)", detail: { reason: body.reason, ...(body.detail ?? {}) } });
  env.ledger.append({ kind: "signer-refusal", venue: "solana", tool: "sign (direct)", code: refusal.code, reason: refusal.message, detail: refusal.detail });
  env.bus.emit("signer/refused", { venue: "solana", tool: "sign (direct)", refusal, direct: true });
  env.counters.refusals++;
  return { refusal, body };
}


/** The operator brings a venue's float back to the main wallet. Binance: the
 * operator's WITHDRAW key, to the account's whitelisted address. Hyperliquid:
 * the master signs `withdraw3`. The chain's delivery is simulated by crediting
 * the wallet's `/receive`. A `destination` other than the wallet shows the
 * venue's whitelist refusing. */
export async function withdrawToWallet(
  env: DemoEnv,
  venue: "binance" | "hyperliquid",
  opts: { amount?: number; destination?: string } = {},
): Promise<{ ok: boolean; amount: number; asset: string; refusal?: Refusal | undefined; body: unknown }> {
  const wallet = env.venues.wallet as { url: string; address: string } | undefined;
  const sim = env.venues[venue];
  if (!wallet || !sim) throw new Error(`${venue} or the wallet is not up`);
  const destination = opts.destination ?? wallet.address;
  let amount = opts.amount ?? 0;
  const asset = venue === "binance" ? "USDT" : "USDC";
  let body: unknown;
  let ok = false;
  let refusal: Refusal | undefined;

  if (venue === "binance") {
    const key = readHomeJson<{ apiKey: string; secret: string }>(env, "credentials/binance/operator.json");
    const { createHmac } = await import("node:crypto");
    const signedGet = async (path: string, params: Record<string, string | number>) => {
      const q = Object.entries({ ...params, timestamp: Date.now(), recvWindow: 5000 }).map(([k, v]) => `${k}=${v}`).join("&");
      const sig = createHmac("sha256", key.secret).update(q).digest("hex");
      const r = await fetch(`${sim.url}${path}?${q}&signature=${sig}`, { headers: { "X-MBX-APIKEY": key.apiKey } });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    if (!amount) {
      const acct = await signedGet("/api/v3/account", {});
      const usdt = (acct.body.balances as Array<{ asset: string; free: string }>).find((b) => b.asset === "USDT");
      amount = Math.floor(Number(usdt?.free ?? 0) * 100) / 100;
    }
    const params = `coin=USDT&amount=${amount}&address=${destination}&timestamp=${Date.now()}&recvWindow=5000`;
    const sig = createHmac("sha256", key.secret).update(params).digest("hex");
    const r = await fetch(`${sim.url}/sapi/v1/capital/withdraw/apply`, {
      method: "POST",
      headers: { "X-MBX-APIKEY": key.apiKey, "content-type": "application/x-www-form-urlencoded" },
      body: `${params}&signature=${sig}`,
    });
    body = await r.json();
    ok = r.ok;
    if (!ok) {
      const b = body as { code?: number; msg?: string };
      refusal = refuse(b.code === -4026 ? "E_VENUE_WITHDRAW_WHITELIST" : "E_VENUE_REJECTED", { venue, tool: "withdraw (operator)", native: { status: r.status, ...b } });
    }
  } else {
    const master = readHomeJson<SeedFile>(env, "credentials/hyperliquid/master.json");
    if (!amount) {
      const res = await fetch(`${sim.url}/info`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "userState", user: master.address }) });
      amount = Math.floor(Number(((await res.json()) as { withdrawable: string }).withdrawable) * 100) / 100;
    }
    const r = await postExchange(sim.url, master.seed, { type: "withdraw3", destination, amount: String(amount), time: Date.now() });
    body = r.body;
    ok = r.body.status === "ok";
    if (!ok) refusal = refuse("E_VENUE_REJECTED", { venue, tool: "withdraw3 (operator)", native: r.body });
  }

  if (ok && amount > 0) {
    await fetch(`${wallet.url}/receive`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ venue, asset, amount, ref: `withdraw:${venue}` }) });
    env.ledger.append({ kind: "funding", venue, outcome: "withdrawn-to-wallet", notionalUsd: amount, detail: { destination, asset } });
    env.bus.emit("funding/withdrawn", { venue, asset, amount, destination });
  } else if (refusal) {
    env.ledger.append({ kind: "funding", venue, outcome: "refused", code: refusal.code, reason: refusal.message, native: body, detail: { destination, amount } });
    env.bus.emit("venue/refused", { venue, tool: "withdraw (operator)", refusal, bypass: false, operator: true });
    env.counters.refusals++;
  }
  return { ok, amount, asset, refusal, body };
}
