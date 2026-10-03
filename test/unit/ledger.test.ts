import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Ledger } from "../../src/agent/ledger.ts";

describe("Ledger", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "ledger-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("chains every row to the previous and verifies", () => {
    const file = join(dir, "ledger.jsonl");
    const l = new Ledger(file, () => "t");
    l.append({ kind: "intent", venue: "v", intentId: "i1" });
    l.append({ kind: "venue-refusal", venue: "v", intentId: "i1", code: "E_VENUE_REJECTED" });
    expect(l.verifyChain()).toEqual({ ok: true, rows: 2 });
    const reloaded = new Ledger(file, () => "t");
    expect(reloaded.verifyChain()).toEqual({ ok: true, rows: 2 });
    expect(reloaded.all()[1]!.prev).toBe(reloaded.all()[0]!.hash);
  });

  it("detects a tampered row", () => {
    const file = join(dir, "ledger.jsonl");
    const l = new Ledger(file, () => "t");
    l.append({ kind: "intent", venue: "v", intentId: "i1", notionalUsd: 10 });
    l.append({ kind: "venue", venue: "v", intentId: "i1", outcome: "filled" });
    const lines = readFileSync(file, "utf8").trim().split("\n");
    const row = JSON.parse(lines[0]!);
    row.notionalUsd = 10_000;
    lines[0] = JSON.stringify(row);
    writeFileSync(file, lines.join("\n") + "\n");
    expect(new Ledger(file, () => "t").verifyChain()).toEqual({ ok: false, rows: 2, at: 1 });
  });
});
