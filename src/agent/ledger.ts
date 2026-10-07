/** The ledger: append-only JSONL, hash-chained. A refusal is a row like any
 * other; state never changes in place — a later fact is a later row. */
import { appendJsonl, readJsonl } from "../core/jsonl.ts";
import { canonical, sha256 } from "../core/hash.ts";

export type LedgerKind =
  | "read"
  | "intent"
  | "constraint"
  | "mandate-refusal"
  | "gate-refusal"
  | "card"
  | "venue"
  | "venue-refusal"
  | "signer-refusal"
  | "mount-refusal"
  | "funding"
  | "bypass"
  | "reconcile"
  | "note"
  | "openness-refusal"
  /** the account: a signed instruction it took, one it refused, a payment's life (pending · settled · returned …), and an order's at a
   * real venue (placed · filled · canceled …) */
  | "action"
  | "account-refusal"
  | "payment"
  | "order"
  /** one line of the account's statement: a transaction as it stands now (account/statement.ts) */
  | "statement"
  /** what a spending or trading limit has used, after it changed: a restarted account reads the last one (account/restore.ts) */
  | "spend";

export interface LedgerRowInput {
  kind: LedgerKind;
  venue: string;
  intentId?: string | undefined;
  callId?: string | undefined;
  tool?: string | undefined;
  args?: Record<string, unknown> | undefined;
  outcome?: string | undefined;
  venueOrderId?: string | undefined;
  notionalUsd?: number | undefined;
  code?: string | undefined;
  reason?: string | undefined;
  detail?: unknown;
  native?: unknown;
  /** the portfolio manager: which flight (one agent request) and which agent this row belongs to */
  flight?: string | undefined;
  agent?: string | undefined;
  /** the account: the signed envelope this row is evidence of, who signed it, and the payment it belongs to */
  envelope?: unknown;
  signer?: string | undefined;
  payment?: string | undefined;
}

export interface LedgerRow extends LedgerRowInput {
  v: 1;
  seq: number;
  /** simulated time */
  ts: string;
  prev: string;
  hash: string;
}

const GENESIS = "0".repeat(64);

export class Ledger {
  private rows: LedgerRow[];

  constructor(
    private readonly file: string,
    private readonly now: () => string,
    private readonly onAppend?: (row: LedgerRow) => void,
  ) {
    this.rows = readJsonl<LedgerRow>(file);
  }

  append(input: LedgerRowInput): LedgerRow {
    const prev = this.rows.length ? this.rows[this.rows.length - 1]!.hash : GENESIS;
    const unhashed = { v: 1 as const, seq: this.rows.length + 1, ts: this.now(), prev, ...input };
    const row: LedgerRow = { ...unhashed, hash: sha256(prev + canonical(unhashed)) };
    this.rows.push(row);
    appendJsonl(this.file, row);
    this.onAppend?.(row);
    return row;
  }

  all(): readonly LedgerRow[] {
    return this.rows;
  }

  byVenue(venue: string): LedgerRow[] {
    return this.rows.filter((r) => r.venue === venue);
  }

  byKind(kind: LedgerKind): LedgerRow[] {
    return this.rows.filter((r) => r.kind === kind);
  }

  /** Recompute every hash from genesis. `at` is the first bad seq. */
  verifyChain(): { ok: boolean; rows: number; at?: number } {
    let prev = GENESIS;
    for (const row of this.rows) {
      const { hash, ...rest } = row;
      if (rest.prev !== prev || sha256(prev + canonical(rest)) !== hash) return { ok: false, rows: this.rows.length, at: row.seq };
      prev = hash;
    }
    return { ok: true, rows: this.rows.length };
  }

  path(): string {
    return this.file;
  }
}
