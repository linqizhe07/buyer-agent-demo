import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Gate, hasApprovalGrant, type ApprovalCard, type GateEvent } from "../../src/agent/gate.ts";
import { Bus } from "../../src/core/bus.ts";

const asked = (id: string, callId: string, toolName: string): GateEvent => ({
  type: "approval/asked",
  data: { id, callId, toolName, line: "x", at: "t" },
});
const decided = (id: string, outcome: "allowed-once" | "rejected"): GateEvent => ({
  type: "approval/decided",
  data: { id, outcome, by: "test", at: "t" },
});

describe("hasApprovalGrant (pure)", () => {
  it("needs the asked/decided pair for the SAME call and tool", () => {
    const events = [asked("c1", "call-1", "mcp__x__place_order"), decided("c1", "allowed-once")];
    expect(hasApprovalGrant(events, "call-1", "mcp__x__place_order")).toBe(true);
    expect(hasApprovalGrant(events, "call-2", "mcp__x__place_order")).toBe(false);
    expect(hasApprovalGrant(events, "call-1", "mcp__x__cancel_order")).toBe(false);
  });
  it("a sighting is not a grant; a rejection is not a grant", () => {
    expect(hasApprovalGrant([asked("c1", "call-1", "t")], "call-1", "t")).toBe(false);
    expect(hasApprovalGrant([asked("c1", "call-1", "t"), decided("c1", "rejected")], "call-1", "t")).toBe(false);
    expect(hasApprovalGrant([asked("c1", "call-1", "t"), decided("c9", "allowed-once")], "call-1", "t")).toBe(false);
  });
});

describe("Gate", () => {
  let dir: string;
  let gate: Gate;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gate-"));
    gate = new Gate({ bus: new Bus(), eventsFile: join(dir, "events.jsonl"), now: () => "t" });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const card = (callId: string, tool: string): ApprovalCard => ({
    id: `card-${callId}`,
    callId,
    tool,
    venue: "x",
    raw: tool.split("__")[2]!,
    line: "l",
    fields: {},
    rewrites: [],
    mandate: null,
    notionalUsd: 0,
    argsHash: "h",
    askedAt: "t",
  });

  it("gates only names the manifests put on the allow-list", () => {
    gate.allow("mcp__binance__createOrder");
    expect(gate.decision("mcp__binance__createOrder", "line")).toEqual({ kind: "ask", line: "line" });
    expect(gate.decision("mcp__binance__fetchTicker", "line")).toBeNull();
    expect(gate.decision("createOrder", "line")).toBeNull();
  });

  it("policy never denies in its own words instead of asking", () => {
    gate.allow("mcp__x__place_order");
    gate.policy = "never";
    const d = gate.decision("mcp__x__place_order", "line");
    expect(d?.kind).toBe("deny");
    expect((d as { reason: string }).reason).toMatch(/Nobody refused it; nobody was asked/);
  });

  it("the guard admits exactly one dispatch per logged grant", () => {
    gate.allow("mcp__x__place_order");
    expect(gate.guardReason("mcp__x__place_order", "call-1")).toMatch(/no logged approval/);
    gate.recordAsked(card("call-1", "mcp__x__place_order"));
    expect(gate.guardReason("mcp__x__place_order", "call-1")).toMatch(/no logged approval/);
    gate.recordDecided("card-call-1", "allowed-once", "test");
    expect(gate.guardReason("mcp__x__place_order", "call-1")).toBeUndefined();
    gate.consume("call-1");
    expect(gate.guardReason("mcp__x__place_order", "call-1")).toMatch(/already used/);
    expect(gate.guardReason("mcp__x__orders", "call-1")).toBeUndefined();
  });
});
