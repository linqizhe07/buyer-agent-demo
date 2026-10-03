/** The approval gate, in the shape of Kairos's Gate 2 (face/src/orders.ts):
 *
 *   decision  — a write tool's call is an `ask` (a card) or, under policy
 *               `never`, a deny in our own words (nobody refused, nobody was asked)
 *   grant     — a logged `approval/asked` + `approval/decided{allowed-once}`
 *               pair for THIS callId and THIS tool name
 *   guard     — runs right before dispatch and refuses without such a pair,
 *               and refuses a second dispatch of a consumed grant
 *
 * The difference from Kairos: the allow-list of write names is not a module
 * constant but grows at mount from each manifest's `tools.write`.
 */
import type { Bus } from "../core/bus.ts";
import { appendJsonl } from "../core/jsonl.ts";
import type { Rewrite } from "../contract/constraints.ts";

export type ApprovalPolicy = "ask" | "never";
export type CardOutcome = "allowed-once" | "rejected";

export interface ApprovalCard {
  id: string;
  callId: string;
  /** public tool name */
  tool: string;
  venue: string;
  raw: string;
  /** the one line a human decides on */
  line: string;
  /** the fields the manifest said to show */
  fields: Record<string, unknown>;
  rewrites: Rewrite[];
  mandate: { id: string; purpose: string; remainingUsd: number } | null;
  notionalUsd: number;
  /** sha256 of the canonical arguments that will be sent — what you see is what is sent */
  argsHash: string;
  askedAt: string;
}

export interface AskedEvent {
  type: "approval/asked";
  data: { id: string; callId: string; toolName: string; line: string; at: string };
}
export interface DecidedEvent {
  type: "approval/decided";
  data: { id: string; outcome: CardOutcome; by: string; at: string };
}
export type GateEvent = AskedEvent | DecidedEvent;

export type GateDecision = { kind: "ask"; line: string } | { kind: "deny"; reason: string };

/** Pure: is there a logged asked/decided pair granting `callId` on `toolName`? */
export function hasApprovalGrant(events: readonly GateEvent[], callId: string, toolName: string): boolean {
  const asked = events.find(
    (e): e is AskedEvent => e.type === "approval/asked" && e.data.callId === callId && e.data.toolName === toolName,
  );
  if (!asked) return false;
  return events.some(
    (e): e is DecidedEvent => e.type === "approval/decided" && e.data.id === asked.data.id && e.data.outcome === "allowed-once",
  );
}

export class Gate {
  private readonly writeNames = new Set<string>();
  private readonly events: GateEvent[] = [];
  private readonly consumed = new Set<string>();

  constructor(
    private readonly deps: { bus: Bus; eventsFile: string; now: () => string },
    public policy: ApprovalPolicy = "ask",
  ) {}

  /** the allow-list: called at mount for every manifest write tool */
  allow(name: string): void {
    this.writeNames.add(name);
  }

  isWriteTool(name: string): boolean {
    return this.writeNames.has(name);
  }

  allowed(): string[] {
    return [...this.writeNames];
  }

  decision(name: string, line: string): GateDecision | null {
    if (!this.isWriteTool(name)) return null;
    if (this.policy === "never") {
      return {
        kind: "deny",
        reason: `${name} needs an approval card and this session's policy is "never": no card can be raised, so it does not run. Nobody refused it; nobody was asked.`,
      };
    }
    return { kind: "ask", line };
  }

  recordAsked(card: ApprovalCard): void {
    const event: AskedEvent = {
      type: "approval/asked",
      data: { id: card.id, callId: card.callId, toolName: card.tool, line: card.line, at: this.deps.now() },
    };
    this.events.push(event);
    appendJsonl(this.deps.eventsFile, event);
    this.deps.bus.emit("approval/asked", { card });
  }

  recordDecided(cardId: string, outcome: CardOutcome, by: string): void {
    const event: DecidedEvent = { type: "approval/decided", data: { id: cardId, outcome, by, at: this.deps.now() } };
    this.events.push(event);
    appendJsonl(this.deps.eventsFile, event);
    this.deps.bus.emit("approval/decided", { cardId, outcome, by });
  }

  hasGrant(callId: string, toolName: string): boolean {
    return hasApprovalGrant(this.events, callId, toolName);
  }

  /** `undefined` means dispatch; a string is the refusal reason. */
  guardReason(name: string, callId: string): string | undefined {
    if (!this.isWriteTool(name)) return undefined;
    if (this.consumed.has(callId)) return `the one-shot grant for ${callId} was already used`;
    if (!this.hasGrant(callId, name)) return `no logged approval/asked + approval/decided{allowed-once} pair for ${callId} on ${name}`;
    return undefined;
  }

  /** a grant admits exactly one dispatch */
  consume(callId: string): void {
    this.consumed.add(callId);
  }

  history(): readonly GateEvent[] {
    return this.events;
  }
}
