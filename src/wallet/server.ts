/** The smart agent wallet, skeleton: one in-memory wallet service and one page.
 *
 *   npm run wallet            → http://127.0.0.1:4810
 *   npm run wallet -- --port 4811
 *
 *   GET  /api/overview        where the money is, connectors, compiled policy, flows
 *   POST /api/fund            {venue, amountUsd, purpose}  → ok | refusal (409)
 *   POST /api/recall          {venue, amountUsd, destination?} → ok | refusal (409)
 *   POST /api/revoke          {venue?}: revoke one grant, or (no venue) end the session: funding stops, recalling never does
 *   POST /api/mode            {mode: "guard" | "beast"}  display only in the skeleton
 *   POST /api/reset           back to the fixtures
 *
 * Blueprint: the MetaMask Agent Wallet — the user's smart account holds the
 * money, the agent has its own session key and a revocable, scoped grant.
 * It reads the same fixtures the demo seeds (policy, balances, the wallet key's
 * seed for its address) and never writes them. Rails are stubs: a funded
 * venue is a row in `transfers`, not a credited simulator. The demo runner's
 * wallet (src/venues/wallet.ts) is the one that really credits the venues;
 * attaching this page to it is the next step, not this one.
 */
import express from "express";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { evmAddressOf, keyFromSeed } from "../core/ed25519.ts";
import { isRefusal, type Refusal } from "../core/errors.ts";
import { CATALOG } from "./catalog.ts";
import { buildOverview, floatsOf, type Transfer, type WalletState } from "./overview.ts";
import { dailyOutUsd, evaluateFund, evaluateRecall, parsePolicy, type WalletMode, type WalletPolicy } from "./policy.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PUBLIC = join(ROOT, "src", "wallet", "public");
const FIXTURES = join(ROOT, "fixtures", "home");

export interface Attempt {
  at: string;
  action: "fund" | "recall" | "revoke" | "mode" | "reset";
  venue: string;
  amountUsd: number;
  result: "ok" | Refusal["code"];
  message: string;
  id?: string | undefined;
}

export interface WalletServiceOptions {
  port: number;
  now?: () => string;
}

export interface WalletServiceHandle {
  url: string;
  close(): Promise<void>;
}

function loadFixtures(): { policy: WalletPolicy; state: WalletState } {
  const read = (p: string) => JSON.parse(readFileSync(join(FIXTURES, p), "utf8")) as unknown;
  const policy = parsePolicy(read("wallet/policy.json"));
  const balances = read("wallet/balances.json") as Record<string, number>;
  const seed = (read("credentials/wallet/main.json") as { seed: string }).seed;
  // the agent's session key is NOT derived from the wallet's seed: a separate key, a separate address, no funds
  const agentKey = evmAddressOf(keyFromSeed("88".repeat(32)).publicKeyHex);
  return { policy, state: { address: evmAddressOf(keyFromSeed(seed).publicKeyHex), agentKey, balances: { ...balances }, transfers: [] } };
}

export async function startWalletService(opts: WalletServiceOptions): Promise<WalletServiceHandle> {
  const now = opts.now ?? (() => new Date().toISOString());
  let { policy, state } = loadFixtures();
  const attempts: Attempt[] = [];
  let seq = 0;
  const log = (a: Attempt) => {
    attempts.unshift(a);
    if (attempts.length > 200) attempts.pop();
  };
  const overview = () => ({ ...buildOverview(state, policy, now(), CATALOG), attempts });

  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.setHeader("cache-control", "no-store");
    next();
  });
  app.get("/", (_req, res) => res.type("html").send(readFileSync(join(PUBLIC, "index.html"), "utf8")));
  app.get("/wallet.js", (_req, res) => res.type("application/javascript").send(readFileSync(join(PUBLIC, "wallet.js"), "utf8")));
  app.get("/wallet.css", (_req, res) => res.type("text/css").send(readFileSync(join(PUBLIC, "wallet.css"), "utf8")));
  app.get("/api/overview", (_req, res) => res.json(overview()));

  app.post("/api/fund", (req, res) => {
    const { venue = "", amountUsd = 0, purpose } = req.body as { venue?: string; amountUsd?: number; purpose?: string };
    const amount = Number(amountUsd);
    const v = evaluateFund({ venue, amountUsd: amount, balances: state.balances, floats: floatsOf(policy, state.transfers), policy, now: now(), dailyOut: dailyOutUsd(state.transfers, now()) });
    if (isRefusal(v)) {
      log({ at: now(), action: "fund", venue, amountUsd: amount, result: v.code, message: v.message });
      res.status(409).json({ ok: false, refusal: v });
      return;
    }
    const id = `fund-${String(++seq).padStart(4, "0")}`;
    state.balances[v.asset] = Number(((state.balances[v.asset] ?? 0) - amount).toFixed(2));
    const row: Transfer = { id, direction: "out", venue: v.venue, asset: v.asset, amount, at: now(), purpose };
    state.transfers.push(row);
    log({ at: row.at, action: "fund", venue: v.venue, amountUsd: amount, result: "ok", message: `→ ${v.venue} · ${amount} ${v.asset} · ${v.rail}${v.chain ? " · " + v.chain : ""}`, id });
    res.json({ ok: true, transfer: row, rail: v.rail });
  });

  app.post("/api/recall", (req, res) => {
    const { venue = "", amountUsd = 0, destination = "wallet-main" } = req.body as { venue?: string; amountUsd?: number; destination?: string };
    const amount = Number(amountUsd);
    const v = evaluateRecall({ venue, amountUsd: amount, destination, floats: floatsOf(policy, state.transfers), policy, now: now() });
    if (isRefusal(v)) {
      log({ at: now(), action: "recall", venue, amountUsd: amount, result: v.code, message: v.message });
      res.status(409).json({ ok: false, refusal: v });
      return;
    }
    const id = `recall-${String(++seq).padStart(4, "0")}`;
    state.balances[v.asset] = Number(((state.balances[v.asset] ?? 0) + amount).toFixed(2));
    const row: Transfer = { id, direction: "in", venue: v.venue, asset: v.asset, amount, at: now() };
    state.transfers.push(row);
    log({ at: row.at, action: "recall", venue: v.venue, amountUsd: amount, result: "ok", message: `← ${v.venue} · ${amount} ${v.asset} · 回到 ${destination}`, id });
    res.json({ ok: true, transfer: row });
  });

  app.post("/api/revoke", (req, res) => {
    const { venue } = req.body as { venue?: string };
    if (venue) {
      if (!CATALOG.some((c) => c.id === venue)) {
        res.status(404).json({ ok: false, error: `no connector ${venue}` });
        return;
      }
      policy = { ...policy, revoked: [...new Set([...policy.revoked, venue])] };
      log({ at: now(), action: "revoke", venue, amountUsd: 0, result: "ok", message: `撤销 ${venue} 的授权：链上是一笔 revoke 交易（与服务器是否在线无关）；链下场所同步删 key / 撤 agent；float 仍可提回` });
      res.json({ ok: true, revoked: policy.revoked });
      return;
    }
    policy = { ...policy, sessionExpiresAt: now() };
    log({ at: now(), action: "revoke", venue: "*", amountUsd: 0, result: "ok", message: "撤销全部授权：所有场所从现在起不再注资；各家钥匙的到期由各家自己强制；float 仍可提回" });
    res.json({ ok: true, sessionExpiresAt: policy.sessionExpiresAt });
  });

  app.post("/api/mode", (req, res) => {
    const { mode } = req.body as { mode?: WalletMode };
    if (mode !== "guard" && mode !== "beast") {
      res.status(400).json({ ok: false, error: "mode must be guard | beast" });
      return;
    }
    policy = { ...policy, mode };
    log({ at: now(), action: "mode", venue: "*", amountUsd: 0, result: "ok", message: mode === "guard" ? "Guard 模式：每一笔注资、每一笔写操作都停在一张卡上等人" : "Beast 模式：只有可疑的交易才送人审（骨架里只是显示；demo runner 仍每笔过卡）" });
    res.json({ ok: true, mode });
  });

  app.post("/api/reset", (_req, res) => {
    ({ policy, state } = loadFixtures());
    attempts.length = 0;
    seq = 0;
    res.json({ ok: true });
  });

  const server: Server = await new Promise((resolve, reject) => {
    const s = app.listen(opts.port, "127.0.0.1", () => resolve(s));
    s.on("error", reject);
  });
  return {
    url: `http://127.0.0.1:${opts.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const portAt = args.indexOf("--port");
  const port = portAt >= 0 ? Number(args[portAt + 1]) : 4810;
  const svc = await startWalletService({ port });
  console.log(`smart agent wallet (skeleton) at ${svc.url} · ${CATALOG.length} connectors in the catalog · Ctrl-C to stop`);
  const stop = () => svc.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
