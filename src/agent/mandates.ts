/** Mandates: the authorization letter, checked BEFORE any card.
 *
 * One file per venue under `$BUYER_HOME/mandates/`, written by the operator
 * (seeded here). A mandate bounds purpose, notional, per-order size, symbols,
 * recipients, rate and validity. The check order mirrors agentpay's policy
 * gate; every refusal is structured and names what was exceeded, never the
 * limit's reason.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { refuse, type Refusal } from "../core/errors.ts";

export interface Mandate {
  id: string;
  venue: string;
  purpose: string;
  notionalLimitUsd: number;
  perOrderCapUsd: number;
  /** empty = any symbol */
  symbols: string[];
  /** transfer recipients allowed; empty = none */
  recipients: string[];
  maxOrdersPerMinute: number;
  validFrom: string;
  validUntil: string;
  spentUsd: number;
  status: "signed" | "disabled";
  approvedBy: string;
  approvedAt: string;
}

export interface IntentSize {
  kind: "order" | "transfer" | "cancel" | "other";
  venue: string;
  symbol?: string | undefined;
  recipient?: string | undefined;
  notionalUsd: number;
}

export function mandateRejection(m: Mandate, q: IntentSize, nowMs: number, recentInWindow: number): Refusal | undefined {
  const base = { venue: q.venue, detail: { mandateId: m.id } };
  if (m.status !== "signed") return refuse("E_MANDATE_NONE", { ...base, message: "授权书已被禁用" });
  const from = Date.parse(m.validFrom);
  const until = Date.parse(m.validUntil);
  if (nowMs < from || nowMs >= until) return refuse("E_MANDATE_EXPIRED", { ...base, detail: { ...base.detail, validUntil: m.validUntil } });
  if (q.kind === "order" && m.symbols.length && (!q.symbol || !m.symbols.includes(q.symbol))) {
    return refuse("E_MANDATE_SYMBOL", { ...base, detail: { ...base.detail, symbol: q.symbol, allowed: m.symbols } });
  }
  if (q.kind === "transfer" && (!q.recipient || !m.recipients.includes(q.recipient))) {
    return refuse("E_MANDATE_RECIPIENT", { ...base, detail: { ...base.detail, recipient: q.recipient, allowed: m.recipients } });
  }
  if (q.notionalUsd > m.perOrderCapUsd) {
    return refuse("E_MANDATE_PER_ORDER_CAP", { ...base, detail: { ...base.detail, notionalUsd: q.notionalUsd, perOrderCapUsd: m.perOrderCapUsd } });
  }
  if (recentInWindow >= m.maxOrdersPerMinute) {
    return refuse("E_MANDATE_RATE", { ...base, detail: { ...base.detail, maxOrdersPerMinute: m.maxOrdersPerMinute } });
  }
  if (m.spentUsd + q.notionalUsd > m.notionalLimitUsd) {
    return refuse("E_MANDATE_BUDGET", {
      ...base,
      detail: { ...base.detail, notionalUsd: q.notionalUsd, remainingUsd: m.notionalLimitUsd - m.spentUsd },
    });
  }
  return undefined;
}

export class MandateStore {
  private readonly byVenue = new Map<string, Mandate[]>();
  private readonly recent: Array<{ mandateId: string; at: number }> = [];

  constructor(private readonly home: string) {}

  private file(venue: string): string {
    return join(this.home, "mandates", `${venue}.json`);
  }

  forVenue(venue: string): Mandate[] {
    let list = this.byVenue.get(venue);
    if (!list) {
      const file = this.file(venue);
      list = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Mandate[]) : [];
      this.byVenue.set(venue, list);
    }
    return list;
  }

  remainingUsd(m: Mandate): number {
    return Math.max(0, m.notionalLimitUsd - m.spentUsd);
  }

  /** the first signed mandate for the venue that admits the intent, or the refusal of the first one */
  check(q: IntentSize, nowMs: number): { mandate: Mandate | null; refusal: Refusal | undefined } {
    const list = this.forVenue(q.venue).filter((m) => m.status === "signed");
    if (!list.length) return { mandate: null, refusal: refuse("E_MANDATE_NONE", { venue: q.venue }) };
    let first: Refusal | undefined;
    for (const m of list) {
      const windowStart = nowMs - 60_000;
      const recentInWindow = this.recent.filter((r) => r.mandateId === m.id && r.at >= windowStart).length;
      const r = mandateRejection(m, q, nowMs, recentInWindow);
      if (!r) return { mandate: m, refusal: undefined };
      first ??= r;
    }
    return { mandate: null, refusal: first };
  }

  /** book an accepted order against the mandate and persist */
  spend(m: Mandate, usd: number, nowMs: number): void {
    m.spentUsd = Number((m.spentUsd + usd).toFixed(2));
    this.recent.push({ mandateId: m.id, at: nowMs });
    this.save(m.venue);
  }

  upsert(m: Mandate): void {
    const list = this.forVenue(m.venue);
    const i = list.findIndex((x) => x.id === m.id);
    if (i >= 0) list[i] = m;
    else list.push(m);
    this.save(m.venue);
  }

  disable(venue: string, id: string): void {
    const m = this.forVenue(venue).find((x) => x.id === id);
    if (m) {
      m.status = "disabled";
      this.save(venue);
    }
  }

  private save(venue: string): void {
    const file = this.file(venue);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(this.forVenue(venue), null, 2) + "\n", "utf8");
  }
}
