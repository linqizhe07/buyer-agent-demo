import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

const HEADLINES = [
  "8 accounts connected in one shape",
  "raised no card",
  "four writes across four accounts, zero cards",
  "E_WALLET_SCOPE",
  "E_VENUE_PERMISSION",
  "-2015",
  "E_VENUE_CARD_DECLINED",
  "E_VENUE_TRANSFER_RESTRICTED",
  "E_VENUE_MARKET_CLOSED",
  "AWAITING_MFA",
  "E_CARD_REJECTED",
  "E_WALLET_BLOCKLIST",
  "E_WALLET_ACCOUNT_REVOKED",
  "reads are never revoked",
  "E_WALLET_REACH",
  "Base → Ethereum",
  "Still $801 short",
  "liquidity bridge",
  "fee $1.00",
  "CCTP",
  "DEX (Base)",
  "Split into 3 slices",
  "net $7,315.91",
  "Route: Aerodrome · gas $0.05",
  "free to move",
  "has no BTC",
  "CC-0004",
  "$415.66",
  "Buy 400 YES · Kalshi @ 0.73 · cost $297.52",
  "Buy 600 YES · Polymarket @ 0.74 · cost $449.77",
  "the same question can resolve differently at each",
  "Base → Polygon → Polymarket deposit wallet",
  "Redeem 80 winning shares",
  "which closed on 2026-10-01 and is not yet resolved",
  "(2 slices)",
  "Approved · Sell 0.5 ETH · OKX",
  "$9.50",
  "PM-0001",
  "ledger chain verified",
  "loss $0.00",
];

describe("npm run portfolio:demo (headless, no ports)", () => {
  let home: string;
  let stdout = "";
  let stderr = "";
  let code: number | null = null;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "portfolio-demo-"));
    await new Promise<void>((resolve) => {
      const child = spawn("npx", ["tsx", "src/portfolio/demo.ts", "--home", home], { cwd: ROOT, env: { ...process.env, PORTFOLIO_MM: "0" }, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("close", (c) => {
        code = c;
        resolve();
      });
    });
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it("exits 0 with every assertion passed and all ten beats in order", () => {
    if (code !== 0) console.log(stdout, stderr);
    expect(code).toBe(0);
    expect(stdout).toContain("ALL PORTFOLIO ASSERTIONS PASSED");
    expect(stdout).not.toMatch(/^FAIL /m);
    expect([...stdout.matchAll(/^==== Beat (\d+):/gm)].map((m) => Number(m[1]))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
  it("prints the headlines of the story", () => {
    for (const line of HEADLINES) expect(stdout).toContain(line);
  });
});
