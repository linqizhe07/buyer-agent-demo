import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertClean, childEnvFor, scrubEnv } from "../../src/contract/env-scrub.ts";
import { parseManifest } from "../../src/contract/manifest.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const manifest = parseManifest({
  manifestVersion: 1,
  venue: "alpaca",
  serverName: "alpaca",
  title: "t",
  command: ["tsx", "x.ts"],
  native: "n",
  keyLives: "k",
  identity: { ref: "alpaca/paper", kind: "broker-api-key" },
  signer: { kind: "in-plugin" },
  tools: { read: [], write: [], deny: [] },
});

describe("env scrub", () => {
  it("drops every secret-looking NAME from the base environment", () => {
    const env = scrubEnv({
      PATH: "/usr/bin",
      APCA_API_SECRET_KEY: "x",
      APCA_API_KEY_ID: "y",
      GITHUB_TOKEN: "z",
      DB_PASSWORD: "p",
      MY_SECRET: "s",
      HOME: "/h",
      EMPTY: undefined,
    });
    expect(Object.keys(env).sort()).toEqual(["HOME", "PATH"]);
  });

  it("gives a seat exactly one credential ref and no values", () => {
    const env = childEnvFor(manifest, {
      base: { PATH: "/usr/bin", APCA_API_SECRET_KEY: "leak" },
      home: "/home",
      venueUrl: "http://127.0.0.1:4701",
    });
    expect(env).toEqual({
      PATH: "/usr/bin",
      BUYER_HOME: "/home",
      BUYER_VENUE: "alpaca",
      BUYER_VENUE_URL: "http://127.0.0.1:4701",
      BUYER_CRED_REF: "alpaca/paper",
    });
  });

  it("assertClean refuses a surviving secret name", () => {
    expect(() => assertClean({ API_KEY: "x" })).toThrow(/not clean/);
  });

  it("the host never imports the identity resolver", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts") && /_shared\/identity/.test(readFileSync(p, "utf8"))) offenders.push(p);
      }
    };
    walk(join(ROOT, "src", "agent"));
    walk(join(ROOT, "src", "runner"));
    expect(offenders).toEqual([]);
  });
});
