import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** Headlines a passing run must print. Grows with the phases. */
const HEADLINES: string[] = [
  "refused at mount",
  "E_MOUNT_UNCLASSIFIED",
  "no approval card was raised for any read",
  "E_VENUE_INVALID_TIF",
  "42210000",
  "tif: day → gtc",
  "ledger chain verified",
  "E_VENUE_AGENT_NO_WITHDRAW",
  "E_VENUE_AGENT_EXPIRED",
  "agent keys cannot withdraw",
  "E_MOUNT_TOOL_NOT_MOUNTED",
  "E_VENUE_PERMISSION",
  "E_SIGNER_TX_CAP",
  "E_MANDATE_RECIPIENT",
  "E_SIGNER_RECIPIENT",
  "reconcile 4/4",
  "loss $0.00",
  "E_WALLET_FLOAT_CAP",
  "E_VENUE_WITHDRAW_WHITELIST",
  "float back home",
];

describe("npm run demo (headless)", () => {
  let home: string;
  let stdout = "";
  let stderr = "";
  let code: number | null = null;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "buyer-agent-demo-"));
    await new Promise<void>((resolve) => {
      const child = spawn("npx", ["tsx", "src/runner/run-demo.ts", "--home", home], {
        cwd: ROOT,
        env: { ...process.env, BUYER_DRIVER: "scripted" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("close", (c) => {
        code = c;
        resolve();
      });
    });
  });

  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("exits 0 with every assertion passed", () => {
    if (code !== 0) console.log(stdout, stderr);
    expect(code).toBe(0);
    expect(stdout).toContain("ALL SCENARIO ASSERTIONS PASSED");
    expect(stdout).not.toMatch(/^FAIL /m);
  });

  it("runs all eleven scenarios in order", () => {
    const indexes = [...stdout.matchAll(/^==== Scenario (\d+):/gm)].map((m) => Number(m[1]));
    expect(indexes).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it("prints the headlines of the story", () => {
    for (const line of HEADLINES) expect(stdout).toContain(line);
  });
});
