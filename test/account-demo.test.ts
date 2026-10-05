import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** one line per thing the run has to have shown: what went through, and what was turned away */
const HEADLINES = [
  "8 venues on one account",
  "E_ACCOUNT_BAD_SIGNATURE",
  "E_ACCOUNT_UNKNOWN_SIGNER",
  "E_ACCOUNT_OWNER_ONLY",
  "E_ACCOUNT_AGENT_EXPIRED",
  "E_ACCOUNT_AGENT_REVOKED",
  "a revoked key is never authorised again",
  "recovers to the SDK's test address",
  "the same signed envelope sent twice is ONE transfer",
  "E_ACCOUNT_NONCE",
  "E_ACCOUNT_EXPIRED",
  "$499.95 in flight",
  "POST /api/v5/asset/withdrawal",
  "depositForBurnWithHook",
  "E_ACCOUNT_NOT_HOME",
  "Hyperliquid: only the master account's signature can withdraw",
  "Binance: this key has no withdraw permission",
  "E_VENUE_MIN_DEPOSIT",
  "sendToEvmWithData",
  "E_ACCOUNT_REQUOTE",
  "Alpaca moves dollars only by ACH with your own bank, started at Alpaca",
  "E_MANDATE_BUDGET",
  "E_MANDATE_PER_ORDER_CAP",
  "E_MANDATE_RECIPIENT",
  "E_ACCOUNT_UNPRICED",
  "guard: $550 is above OKX's no-ask allowance $500",
  "E_ACCOUNT_CARD_EXPIRED",
  "E_ACCOUNT_DESTINATION",
  "E_ACCOUNT_DEST_COOLING",
  "E_WALLET_BLOCKLIST",
  "E_WALLET_FLOAT_CAP",
  "E_ACCOUNT_SOURCE",
  "account type → Unified",
  "nothing was sent to it",
  "a first payment to data.sim: $0.01 to",
  "E_PAYEE_CHANGED",
  "E_PAYEE_OVERCHARGE",
  "E_PAYEE_REDIRECT",
  "invalid_transaction_state",
  "E_ACCOUNT_FEE_CAP",
  "fee $0.000005",
  "session closed: $0.03 paid for 3 calls, $0.47 back in float",
  "E_PAYEE_UNVERIFIED",
  "all fifty cents are back",
  "shop.sim is paid in USDC: name the float that pays",
  "over AP2 mandates · EIP-3009",
  "E_MANDATE_INVALID",
  "the closed mandate is not signed by the agent key the open mandate names",
  "Bybit plugged in · the venue says this credential can read, trade",
  "Kraken plugged in · the venue says this credential can read, trade, withdraw",
  "OKX Wallet plugged in",
  "Bybit unplugged",
  "ledger chain verified",
  "every signature recovers to the signer the row names",
  "the chain breaks at row",
  "came in and no payment of the account explains it",
  "loss $0.00",
];

describe("npm run account:demo (headless, no ports)", () => {
  let home: string;
  let stdout = "";
  let stderr = "";
  let code: number | null = null;

  const run = (dir: string) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const out = { code: null as number | null, stdout: "", stderr: "" };
      const child = spawn("npx", ["tsx", "src/portfolio/account-demo.ts", "--home", dir], { cwd: ROOT, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", (d) => (out.stdout += d.toString()));
      child.stderr.on("data", (d) => (out.stderr += d.toString()));
      child.on("close", (c) => {
        out.code = c;
        resolve(out);
      });
    });

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "account-demo-"));
    ({ code, stdout, stderr } = await run(home));
  }, 60_000);
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it("exits 0 with every assertion passed and all fourteen beats in order", () => {
    if (code !== 0) console.log(stdout, stderr);
    expect(code).toBe(0);
    expect(stdout).toContain("ALL ACCOUNT ASSERTIONS PASSED");
    expect(stdout).not.toMatch(/^FAIL /m);
    expect([...stdout.matchAll(/^==== Beat (\d+):/gm)].map((m) => Number(m[1]))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  });
  it("run again in the same home it says the same thing, to the byte: no clock, no random value and no signature that differs between runs is printed", async () => {
    const again = await run(home);
    if (again.code !== 0) console.log(again.stdout, again.stderr);
    expect(again.code).toBe(0);
    expect(again.stdout).toBe(stdout);
  }, 60_000);
  it("prints the headlines of the story", () => {
    for (const line of HEADLINES) expect(stdout).toContain(line);
  });
  it("prints no key material: nothing that looks like a private key or a full signature", () => {
    expect(stdout).not.toMatch(/0x[0-9a-fA-F]{64}/);
  });
});
