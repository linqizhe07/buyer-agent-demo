/** Seeding the home, starting the venue simulators, mounting the seats. */
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { mountPlugin, type PluginHandle } from "../agent/mount.ts";
import { loadManifest, parseManifest, type Manifest } from "../contract/manifest.ts";
import { evmAddressOf, keyFromSeed } from "../core/ed25519.ts";
import { startAlpacaSim } from "../venues/alpaca.ts";
import { startBinanceSim } from "../venues/binance.ts";
import { startHyperliquidSim } from "../venues/hyperliquid.ts";
import { startPolicySigner } from "../venues/policy-signer.ts";
import { LAMPORTS_PER_SOL, startSolanaChain } from "../venues/solana-chain.ts";
import { startWallet } from "../venues/wallet.ts";
import type { DemoEnv } from "./env.ts";

export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const FIXTURES_HOME = join(REPO_ROOT, "fixtures", "home");
export const MANIFEST_DIR = join(REPO_ROOT, "manifests");

export const PORTS = { alpaca: 4701, hyperliquid: 4702, binance: 4703, solana: 4704, signer: 4705, wallet: 4706, controlRoom: 4800 } as const;

/** Per-run state: reseeded on every run so a rehearsal and the live run start
 * from the same mandates and an empty ledger. Credentials persist. */
const PER_RUN = ["mandates/", "signer/policy.json", "wallet/"];
const RESET = ["ledger", "signer/journal.jsonl", "agent-wallets"];

/** Copy `fixtures/home/**` into the home: missing files only (or everything with
 * `fresh`), per-run files always; credential and signer files are chmod 0600,
 * the way an operator would leave them. Returns the relative paths copied. */
export function seedHome(home: string, fresh: boolean): string[] {
  for (const rel of RESET) rmSync(join(home, rel), { recursive: true, force: true });
  const copied: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const src = join(dir, entry);
      if (statSync(src).isDirectory()) {
        walk(src);
        continue;
      }
      const rel = relative(FIXTURES_HOME, src);
      const dest = join(home, rel);
      const perRun = PER_RUN.some((p) => rel.startsWith(p));
      if (!fresh && !perRun && existsSync(dest)) continue;
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(src, dest);
      if (rel.startsWith("credentials/") || rel.startsWith("signer/")) chmodSync(dest, 0o600);
      copied.push(rel);
    }
  };
  walk(FIXTURES_HOME);
  return copied;
}

export function loadVenueManifest(venue: string): Manifest {
  return loadManifest(join(MANIFEST_DIR, `${venue}.json`));
}

/** The venue knows the keys it issued: the sim's account table is seeded from
 * the same fixture the operator placed into the home. The host reads the
 * FIXTURE here as the venue's operator, never the home as the agent. */
function fixtureCredential<T>(rel: string): T {
  return JSON.parse(readFileSync(join(FIXTURES_HOME, "credentials", rel), "utf8")) as T;
}

export async function startVenues(env: DemoEnv): Promise<void> {
  const alpacaCred = fixtureCredential<{ keyId: string; secret: string }>("alpaca/paper.json");
  const alpaca = await startAlpacaSim({
    port: PORTS.alpaca,
    seed: 20261002,
    clock: env.clock,
    accounts: [
      {
        keyId: alpacaCred.keyId,
        secret: alpacaCred.secret,
        accountNumber: "PA3DEMO001",
        cash: 100_000,
        positions: [
          { symbol: "AAPL", qty: 40, avg_entry_price: 212.4 },
          { symbol: "NVDA", qty: 100, avg_entry_price: 104.1 },
        ],
      },
    ],
    onEvent: (type, data) => env.bus.emit(type, data),
  });
  env.venues.alpaca = alpaca;
  env.cleanups.push(() => alpaca.close());

  // the main wallet's address: the venues whitelist it before anything else starts
  const walletSeed = fixtureCredential<{ seed: string }>("wallet/main.json").seed;
  const walletAddress = evmAddressOf(keyFromSeed(walletSeed).publicKeyHex);

  const hlMaster = fixtureCredential<{ address: string }>("hyperliquid/master.json");
  const hyperliquid = await startHyperliquidSim({
    port: PORTS.hyperliquid,
    seed: 20261003,
    clock: env.clock,
    masters: [{ address: hlMaster.address, accountValue: 0 }], // funded by the wallet in the fund scenario
    onEvent: (type, data) => env.bus.emit(type, data),
  });
  env.venues.hyperliquid = hyperliquid;
  env.cleanups.push(() => hyperliquid.close());

  type BnKey = { apiKey: string; secret: string; permissions: Array<"SPOT" | "WITHDRAW">; ipWhitelist: string[] };
  const bnKey = fixtureCredential<BnKey>("binance/spot-trade.json");
  const bnOperator = fixtureCredential<BnKey>("binance/operator.json");
  const binance = await startBinanceSim({
    port: PORTS.binance,
    seed: 20261004,
    clock: env.clock,
    accounts: [{ id: "acct-demo", balances: { USDT: 0, BTC: 0 }, depositAddresses: { USDT: "bn-dep-usdt-demo-0001" }, withdrawWhitelist: [walletAddress] }],
    keys: [
      { apiKey: bnKey.apiKey, secret: bnKey.secret, permissions: bnKey.permissions, ipWhitelist: bnKey.ipWhitelist, account: "acct-demo" },
      { apiKey: bnOperator.apiKey, secret: bnOperator.secret, permissions: bnOperator.permissions, ipWhitelist: bnOperator.ipWhitelist, account: "acct-demo" },
    ],
    onEvent: (type, data) => env.bus.emit(type, data),
  });
  env.venues.binance = binance;
  env.cleanups.push(() => binance.close());

  // the signer starts BEFORE the chain's accounts are seeded: its address is the owner
  const signer = await startPolicySigner({ port: PORTS.signer, home: env.home, clock: env.clock, onEvent: (type, data) => env.bus.emit(type, data) });
  env.venues.signer = signer;
  env.cleanups.push(() => signer.close());
  const solana = await startSolanaChain({
    port: PORTS.solana,
    clock: env.clock,
    accounts: [
      { address: signer.address, lamports: 20 * LAMPORTS_PER_SOL, label: "owner (signer)" },
      { address: "c6822637c7d310ec57627be00ba259d253749f4aaf644470cffbe53a35f73242", lamports: 0, label: "treasury (allow-listed)" },
      { address: "d759793bbc13a2819a827c76adb6fba8a49aee007f49f2d0992d99b825ad2c48", lamports: 0, label: "attacker" },
    ],
    onEvent: (type, data) => env.bus.emit(type, data),
  });
  env.venues.solana = solana;
  env.cleanups.push(() => solana.close());

  // the main wallet: the user's, outside the agent; it knows each venue's deposit rail
  const wallet = await startWallet({
    port: PORTS.wallet,
    home: env.home,
    clock: env.clock,
    rails: {
      binance: { url: binance.url, asset: "USDT", destination: "bn-dep-usdt-demo-0001", rail: "cex-deposit" },
      hyperliquid: { url: hyperliquid.url, asset: "USDC", destination: hlMaster.address, rail: "dex-bridge" },
    },
    onEvent: (type, data) => env.bus.emit(type, data),
  });
  env.venues.wallet = wallet;
  env.cleanups.push(() => wallet.close());
  installWalletTools(env, wallet.url);
}

/** The agent's only way to the wallet: two in-process tools (Kairos style, no
 * MCP row, no credential), one of them a write that goes through the mandate
 * and a card like any other. The wallet decides the rest. */
export const WALLET_MANIFEST: Manifest = parseManifest({
  manifestVersion: 1,
  venue: "wallet",
  serverName: "wallet",
  title: "主钱包（用户的，非托管，在 agent 之外）",
  command: ["node", "(in-process)"],
  native: "agent 不能动钱包，只能申请注资；钱包按每个场所的 float 上限决定给不给，提币只回主钱包地址",
  keyLives: "钱包服务进程内（home 的 credentials/wallet/main.json）；没有任何席位拿到它的引用",
  limits: "float：binance ≤ $3000 · hyperliquid ≤ $3000 · 场所提币白名单 = 主钱包地址",
  identity: null,
  signer: { kind: "none" },
  tools: { read: ["balance"], write: ["fund_request"], deny: [] },
  card: { fund_request: ["venue", "amountUsd", "purpose"] },
  sizing: { fund_request: { kind: "transfer", recipient: "venue", amount: "amountUsd", unitUsd: 1 } },
  constraints: [],
  venueErrors: [
    { match: "float cap", refusal: "E_WALLET_FLOAT_CAP" },
    { match: "insufficient", refusal: "E_WALLET_INSUFFICIENT" },
    { match: "does not know venue", refusal: "E_WALLET_UNKNOWN_VENUE" },
  ],
});

export function installWalletTools(env: DemoEnv, walletUrl: string): void {
  env.manifests.set("wallet", WALLET_MANIFEST);
  const post = async (path: string, body: unknown) => {
    const r = await fetch(`${walletUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const payload = (await r.json()) as Record<string, unknown>;
    return r.ok ? { isError: false, payload } : { isError: true, payload: { ok: false, venueError: { status: r.status, ...payload } } };
  };
  env.registry.register({
    name: "wallet_balance",
    venue: "wallet",
    serverName: "wallet",
    raw: "balance",
    cls: "read",
    description: "The main wallet's balances and per-venue floats (read).",
    inputSchema: { type: "object", properties: {} },
    call: async () => {
      const r = await fetch(`${walletUrl}/balance`);
      return { isError: !r.ok, payload: await r.json() };
    },
  });
  env.registry.register({
    name: "wallet_fund_request",
    venue: "wallet",
    serverName: "wallet",
    raw: "fund_request",
    cls: "write",
    description: "Ask the main wallet to fund a venue up to its float (operator-gated).",
    inputSchema: { type: "object", properties: { venue: { type: "string" }, amountUsd: { type: "number" }, purpose: { type: "string" } }, required: ["venue", "amountUsd"] },
    call: (args) => post("/fund", args),
  });
  env.gate.allow("wallet_fund_request");
  env.writeTools.set("wallet_fund_request", WALLET_MANIFEST);
  env.bus.emit("plugin/mounted", {
    venue: "wallet",
    serverName: "wallet",
    title: WALLET_MANIFEST.title,
    pid: process.pid,
    read: ["balance"],
    write: ["fund_request"],
    denied: [],
    keyLives: WALLET_MANIFEST.keyLives,
    native: WALLET_MANIFEST.native,
    limits: WALLET_MANIFEST.limits ?? null,
    credentialRef: null,
    signer: "none",
    inProcess: true,
  });
}

export async function mountVenue(env: DemoEnv, venue: string): Promise<PluginHandle> {
  const manifest = loadVenueManifest(venue);
  const sim = env.venues[manifest.venue];
  const handle = await mountPlugin(manifest, {
    home: env.home,
    repoRoot: REPO_ROOT,
    venueUrl: sim?.url ?? "http://127.0.0.1:9",
    signerUrl: env.venues.signer?.url,
    bus: env.bus,
    registry: env.registry,
    onWriteTool: (name, m) => {
      env.writeTools.set(name, m);
      env.gate.allow(name);
    },
  });
  if (handle.audit.ok) env.manifests.set(manifest.venue, manifest);
  else env.ledger.append({ kind: "mount-refusal", venue: manifest.venue, code: handle.audit.refusal?.code, reason: handle.audit.refusal?.message, detail: handle.audit.refusal?.detail });
  env.plugins.set(venue, handle);
  env.cleanups.push(() => handle.close());
  return handle;
}
