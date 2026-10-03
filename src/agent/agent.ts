/** The write path, in one place:
 *
 *   intent → constraints (rewrites on the card) → sizing → mandate → card →
 *   guard (one-shot grant) → the seat → venue answer → ledger
 *
 * Every refusal is returned as a structured value with the layer that
 * refused; nothing here throws at the driver. Reads skip straight to the seat
 * and still leave a ledger row.
 */
import { applyConstraints, classifyVenueError, type Rewrite } from "../contract/constraints.ts";
import type { Manifest } from "../contract/manifest.ts";
import type { Bus } from "../core/bus.ts";
import type { SimClock } from "../core/clock.ts";
import { refuse, type Code, type Refusal } from "../core/errors.ts";
import { canonical, sha256, short } from "../core/hash.ts";
import type { IdFactory } from "../core/ids.ts";
import type { Answerer } from "./answerer.ts";
import type { ApprovalCard, CardOutcome, Gate } from "./gate.ts";
import type { Ledger } from "./ledger.ts";
import type { Mandate, MandateStore } from "./mandates.ts";
import type { ToolRegistry } from "./registry.ts";
import { sizeIntent } from "./sizing.ts";

export type Caller = "principal" | "bot" | "child";

export interface AgentDeps {
  registry: ToolRegistry;
  gate: Gate;
  mandates: MandateStore;
  ledger: Ledger;
  answerer: Answerer;
  bus: Bus;
  clock: SimClock;
  ids: IdFactory;
  manifests: Map<string, Manifest>;
  counters: { fills: number; refusals: number; lossUsd: number };
}

export interface ExecuteOptions {
  /** apply the manifest's constraints before the card (default true) */
  absorb?: boolean;
  caller?: Caller;
}

export interface ExecuteOk {
  ok: true;
  intentId: string;
  callId: string;
  tool: string;
  payload: unknown;
  outcome: string;
  venueOrderId?: string | undefined;
  notionalUsd: number;
  rewrites: Rewrite[];
  card?: ApprovalCard | undefined;
  cardOutcome?: CardOutcome | undefined;
}

export type ExecuteRefusal = Refusal & {
  intentId: string;
  callId: string;
  rewrites?: Rewrite[] | undefined;
  card?: ApprovalCard | undefined;
};

export type ExecuteResult = ExecuteOk | ExecuteRefusal;

const FILLED = /fill|confirmed|canceled|cancelled/i;

export class Agent {
  constructor(private readonly deps: AgentDeps) {}

  async execute(name: string, args: Record<string, unknown> = {}, opts: ExecuteOptions = {}): Promise<ExecuteResult> {
    const d = this.deps;
    const intentId = d.ids.next("intent");
    const callId = d.ids.next("call");
    const tool = d.registry.get(name);

    if (!tool) {
      const venue = name.split("__")[1] ?? "?";
      const refusal = refuse("E_MOUNT_TOOL_NOT_MOUNTED", { venue, tool: name, detail: { requested: name } });
      d.ledger.append({ kind: "mount-refusal", venue, intentId, callId, tool: name, args, code: refusal.code, reason: refusal.message });
      d.bus.emit("tool/refused", { intentId, callId, tool: name, venue, refusal });
      d.counters.refusals++;
      return { ...refusal, intentId, callId };
    }
    const manifest = d.manifests.get(tool.venue);
    if (!manifest) throw new Error(`no manifest for mounted venue ${tool.venue}`);
    d.bus.emit("tool/call", { intentId, callId, tool: name, venue: tool.venue, cls: tool.cls, args, caller: opts.caller ?? "principal" });

    if (tool.cls === "read") {
      const r = await tool.call(args);
      d.ledger.append({ kind: "read", venue: tool.venue, intentId, callId, tool: name, outcome: r.isError ? "error" : "ok" });
      if (r.isError) {
        const refusal = classifyVenueError(manifest, tool.raw, venueErrorOf(r.payload));
        d.bus.emit("tool/refused", { intentId, callId, tool: name, venue: tool.venue, refusal });
        return { ...refusal, intentId, callId };
      }
      d.bus.emit("tool/result", { intentId, callId, tool: name, venue: tool.venue, outcome: "ok" });
      return { ok: true, intentId, callId, tool: name, payload: r.payload, outcome: "ok", notionalUsd: 0, rewrites: [] };
    }

    // ---- write path ----
    d.ledger.append({ kind: "intent", venue: tool.venue, intentId, callId, tool: name, args });
    const absorb = opts.absorb ?? true;
    const { args: sent, rewrites, pending } = applyConstraints(manifest, tool.raw, args, { absorb });
    for (const rw of rewrites) {
      d.ledger.append({ kind: "constraint", venue: tool.venue, intentId, callId, tool: name, outcome: "rewritten", detail: rw });
      d.bus.emit("constraint/applied", { intentId, callId, venue: tool.venue, rewrite: rw });
    }
    if (pending.length) d.bus.emit("constraint/skipped", { intentId, callId, venue: tool.venue, pending: pending.map((c) => c.id) });

    const size = await sizeIntent(manifest, tool.raw, sent, d.registry);
    const { mandate, refusal: mandateRefusal } = d.mandates.check(size, d.clock.now());
    if (mandateRefusal) {
      d.ledger.append({
        kind: "mandate-refusal",
        venue: tool.venue,
        intentId,
        callId,
        tool: name,
        notionalUsd: size.notionalUsd,
        code: mandateRefusal.code,
        reason: mandateRefusal.message,
        detail: mandateRefusal.detail,
      });
      d.bus.emit("mandate/refused", { intentId, callId, venue: tool.venue, tool: name, refusal: mandateRefusal, size });
      d.counters.refusals++;
      return { ...mandateRefusal, tool: name, intentId, callId, rewrites };
    }

    const fields = pickFields(manifest.card[tool.raw] ?? Object.keys(sent), sent);
    const argsHash = sha256(canonical(sent));
    const line = cardLine(manifest, tool.raw, fields, rewrites, size.notionalUsd, mandate, d.mandates, argsHash);
    const decision = d.gate.decision(name, line);
    if (!decision) throw new Error(`${name} is a write tool but not on the gate's allow-list`);
    if (decision.kind === "deny") {
      const refusal = refuse("E_CARD_NO_ANSWERER", { venue: tool.venue, tool: name, message: decision.reason });
      d.ledger.append({ kind: "gate-refusal", venue: tool.venue, intentId, callId, tool: name, code: refusal.code, reason: refusal.message });
      d.bus.emit("gate/denied", { intentId, callId, tool: name, venue: tool.venue, refusal });
      d.counters.refusals++;
      return { ...refusal, intentId, callId, rewrites };
    }

    const card: ApprovalCard = {
      id: d.ids.next("card"),
      callId,
      tool: name,
      venue: tool.venue,
      raw: tool.raw,
      line,
      fields,
      rewrites,
      mandate: mandate ? { id: mandate.id, purpose: mandate.purpose, remainingUsd: d.mandates.remainingUsd(mandate) } : null,
      notionalUsd: size.notionalUsd,
      argsHash,
      askedAt: d.clock.iso(),
    };
    d.gate.recordAsked(card);
    const outcome = await d.answerer.answer(card);
    d.gate.recordDecided(card.id, outcome, d.answerer.kind);
    d.ledger.append({
      kind: "card",
      venue: tool.venue,
      intentId,
      callId,
      tool: name,
      outcome,
      notionalUsd: size.notionalUsd,
      detail: { cardId: card.id, line, argsHash, by: d.answerer.kind },
    });
    if (outcome === "rejected") {
      const refusal = refuse("E_CARD_REJECTED", { venue: tool.venue, tool: name, detail: { cardId: card.id } });
      d.bus.emit("card/rejected", { intentId, callId, tool: name, venue: tool.venue, cardId: card.id });
      d.counters.refusals++;
      return { ...refusal, intentId, callId, rewrites, card };
    }

    const reason = d.gate.guardReason(name, callId);
    if (reason) {
      const refusal = refuse("E_CARD_NOT_GRANTED", { venue: tool.venue, tool: name, message: reason });
      d.ledger.append({ kind: "gate-refusal", venue: tool.venue, intentId, callId, tool: name, code: refusal.code, reason });
      d.counters.refusals++;
      return { ...refusal, intentId, callId, rewrites, card };
    }
    d.gate.consume(callId);

    const r = await tool.call(sent);
    if (r.isError) {
      const signerRefusal = signerRefusalOf(r.payload);
      if (signerRefusal) {
        const refusal = refuse(SIGNER_CODES[signerRefusal.reason] ?? "E_SIGNER_UNAVAILABLE", {
          venue: tool.venue,
          tool: name,
          detail: { reason: signerRefusal.reason, ...(signerRefusal.detail ?? {}) },
        });
        d.ledger.append({
          kind: "signer-refusal",
          venue: tool.venue,
          intentId,
          callId,
          tool: name,
          notionalUsd: size.notionalUsd,
          code: refusal.code,
          reason: refusal.message,
          detail: refusal.detail,
        });
        d.bus.emit("signer/refused", { intentId, callId, tool: name, venue: tool.venue, refusal, cardId: card.id });
        d.counters.refusals++;
        return { ...refusal, intentId, callId, rewrites, card };
      }
      const venueError = venueErrorOf(r.payload);
      const refusal = classifyVenueError(manifest, tool.raw, venueError);
      d.ledger.append({
        kind: "venue-refusal",
        venue: tool.venue,
        intentId,
        callId,
        tool: name,
        notionalUsd: size.notionalUsd,
        code: refusal.code,
        reason: refusal.message,
        native: venueError,
      });
      d.bus.emit("venue/refused", { intentId, callId, tool: name, venue: tool.venue, refusal, cardId: card.id });
      d.counters.refusals++;
      return { ...refusal, intentId, callId, rewrites, card, tool: name };
    }

    const payload = r.payload as Record<string, unknown> | null;
    const venueOutcome = String(payload?.status ?? payload?.state ?? "ok");
    const venueOrderId = firstString(payload, ["id", "order_id", "orderId", "oid", "signature", "txid"]);
    d.ledger.append({
      kind: "venue",
      venue: tool.venue,
      intentId,
      callId,
      tool: name,
      outcome: venueOutcome,
      ...(venueOrderId !== undefined ? { venueOrderId } : {}),
      notionalUsd: size.notionalUsd,
      detail: summarize(payload),
    });
    if (mandate && size.notionalUsd > 0) d.mandates.spend(mandate, size.notionalUsd, d.clock.now());
    if (FILLED.test(venueOutcome) && !/cancel/i.test(venueOutcome)) d.counters.fills++;
    d.bus.emit("tool/result", { intentId, callId, tool: name, venue: tool.venue, outcome: venueOutcome, venueOrderId: venueOrderId ?? null, cardId: card.id });
    return {
      ok: true,
      intentId,
      callId,
      tool: name,
      payload,
      outcome: venueOutcome,
      venueOrderId,
      notionalUsd: size.notionalUsd,
      rewrites,
      card,
      cardOutcome: outcome,
    };
  }
}

const SIGNER_CODES: Record<string, Code> = {
  per_tx_cap: "E_SIGNER_TX_CAP",
  daily_cap: "E_SIGNER_DAILY_CAP",
  recipient_not_allowlisted: "E_SIGNER_RECIPIENT",
  program_not_allowlisted: "E_SIGNER_PROGRAM",
  token_not_allowlisted: "E_SIGNER_TOKEN",
  session_expired: "E_SIGNER_EXPIRED",
};

function signerRefusalOf(payload: unknown): { reason: string; detail: Record<string, unknown> | null } | null {
  if (payload && typeof payload === "object" && "signerRefusal" in payload) {
    const s = (payload as { signerRefusal: { reason?: unknown; detail?: unknown } }).signerRefusal;
    return { reason: String(s?.reason ?? "unavailable"), detail: s?.detail && typeof s.detail === "object" ? (s.detail as Record<string, unknown>) : null };
  }
  return null;
}

function venueErrorOf(payload: unknown): unknown {
  if (payload && typeof payload === "object" && "venueError" in payload) return (payload as { venueError: unknown }).venueError;
  return payload;
}

function pickFields(names: string[], args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const n of names) if (args[n] !== undefined) out[n] = args[n];
  return out;
}

function firstString(obj: Record<string, unknown> | null, keys: string[]): string | undefined {
  if (!obj) return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" || typeof v === "number") return String(v);
  }
  return undefined;
}

function summarize(payload: Record<string, unknown> | null): Record<string, unknown> {
  if (!payload) return {};
  const keep = ["status", "state", "symbol", "coin", "side", "qty", "sz", "filled_avg_price", "price", "avgPx", "executedQty", "lamports", "to"];
  const out: Record<string, unknown> = {};
  for (const k of keep) if (payload[k] !== undefined) out[k] = payload[k];
  return out;
}

/** The one line a human decides on. If the symbol, side and size are not in
 * this string, the human is approving a tool NAME — a click-through. */
function cardLine(
  manifest: Manifest,
  raw: string,
  fields: Record<string, unknown>,
  rewrites: Rewrite[],
  notionalUsd: number,
  mandate: Mandate | null,
  store: MandateStore,
  argsHash: string,
): string {
  const parts = Object.entries(fields).map(([k, v]) => {
    const rw = rewrites.find((r) => r.arg === k);
    return rw ? `${k} ${String(v)}（改写自 ${String(rw.from ?? "空")}）` : `${k} ${String(v)}`;
  });
  const budget = mandate ? `授权书 ${mandate.id} 余额 $${store.remainingUsd(mandate).toFixed(2)}` : "无授权书";
  return `[${manifest.venue}] ${raw} · ${parts.join(" · ")} · 名义 $${notionalUsd.toFixed(2)} · ${budget} · hash ${short(argsHash)}`;
}
