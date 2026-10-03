import { describe, expect, it } from "vitest";
import { auditManifest } from "../../src/contract/audit.ts";
import { parseManifest, splitFullName, toolFullName } from "../../src/contract/manifest.ts";

const base = {
  manifestVersion: 1,
  venue: "demo",
  serverName: "demo",
  title: "demo",
  command: ["tsx", "x.ts"],
  native: "n",
  keyLives: "k",
  identity: null,
  signer: { kind: "none" },
  tools: { read: ["r1", "r2"], write: ["w1"], deny: ["d1"] },
};

describe("auditManifest", () => {
  it("mounts a server that advertises exactly the classified tools", () => {
    const m = parseManifest(base);
    const r = auditManifest(m, [{ name: "r1" }, { name: "r2" }, { name: "w1" }, { name: "d1" }]);
    expect(r.ok).toBe(true);
    expect(r.mounted).toEqual({ read: ["r1", "r2"], write: ["w1"] });
    expect(r.denied).toEqual(["d1"]);
  });

  it("refuses the whole mount on one unclassified tool (D4)", () => {
    const m = parseManifest(base);
    const r = auditManifest(m, [{ name: "r1" }, { name: "r2" }, { name: "w1" }, { name: "sweepToColdWallet" }]);
    expect(r.ok).toBe(false);
    expect(r.refusal?.code).toBe("E_MOUNT_UNCLASSIFIED");
    expect(r.refusal?.detail?.unclassified).toEqual(["sweepToColdWallet"]);
    expect(r.mounted).toEqual({ read: [], write: [] });
  });

  it("refuses when the manifest names a tool the server lacks (drift)", () => {
    const m = parseManifest(base);
    const r = auditManifest(m, [{ name: "r1" }, { name: "w1" }]);
    expect(r.refusal?.code).toBe("E_MOUNT_MISSING_TOOL");
    expect(r.refusal?.detail?.missing).toEqual(["r2"]);
  });

  it("a deny tool may be absent from the server", () => {
    const m = parseManifest(base);
    const r = auditManifest(m, [{ name: "r1" }, { name: "r2" }, { name: "w1" }]);
    expect(r.ok).toBe(true);
    expect(r.denied).toEqual([]);
  });

  it("refuses a read tool the server itself says writes", () => {
    const m = parseManifest(base);
    const r = auditManifest(m, [
      { name: "r1", annotations: { readOnlyHint: false } },
      { name: "r2" },
      { name: "w1" },
    ]);
    expect(r.refusal?.code).toBe("E_MOUNT_READONLY_MISMATCH");
  });

  it("does not trust a readOnlyHint=true on an unclassified tool", () => {
    const m = parseManifest(base);
    const r = auditManifest(m, [{ name: "r1" }, { name: "r2" }, { name: "w1" }, { name: "x", annotations: { readOnlyHint: true } }]);
    expect(r.refusal?.code).toBe("E_MOUNT_UNCLASSIFIED");
  });
});

describe("manifest", () => {
  it("rejects a tool listed in two classes", () => {
    expect(() => parseManifest({ ...base, tools: { read: ["a"], write: ["a"], deny: [] } })).toThrow(/two classes/);
  });

  it("mints and splits dsh-style public names", () => {
    expect(toolFullName("binance", "createOrder")).toBe("mcp__binance__createOrder");
    expect(splitFullName("mcp__binance__createOrder")).toEqual({ serverName: "binance", raw: "createOrder" });
    expect(splitFullName("place_order")).toBeNull();
  });
});
