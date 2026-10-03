/** Reconcile: the ledger against each venue's own statement, fetched by the
 * OPERATOR (never through the agent's tools). A fill the ledger knows and the
 * venue does not, or the other way round, is a difference; so is any
 * withdrawal the venue saw, because the demo never authorizes one. */
import type { Ledger } from "./ledger.ts";

export interface VenueStatementSummary {
  venue: string;
  /** ids of fills/confirmations the venue reports */
  fillIds: string[];
  /** withdrawals the venue executed (expected: none) */
  withdrawals: number;
}

export interface ReconcileResult {
  venue: string;
  ledgerFills: number;
  venueFills: number;
  matched: number;
  missingAtVenue: string[];
  unknownAtVenue: string[];
  refusals: number;
  bypassAttempts: number;
  venueWithdrawals: number;
  ok: boolean;
}

const FILLED = /fill|confirmed/i;

export function reconcileVenue(ledger: Ledger, s: VenueStatementSummary): ReconcileResult {
  const rows = ledger.byVenue(s.venue);
  const ledgerIds = rows
    .filter((r) => r.kind === "venue" && r.venueOrderId !== undefined && FILLED.test(r.outcome ?? ""))
    .map((r) => r.venueOrderId!);
  const venueSet = new Set(s.fillIds);
  const ledgerSet = new Set(ledgerIds);
  const matched = ledgerIds.filter((id) => venueSet.has(id));
  const missingAtVenue = ledgerIds.filter((id) => !venueSet.has(id));
  const unknownAtVenue = s.fillIds.filter((id) => !ledgerSet.has(id));
  const refusals = rows.filter((r) => r.kind.endsWith("-refusal") || (r.kind === "bypass" && r.outcome === "refused")).length;
  const bypassAttempts = rows.filter((r) => r.kind === "bypass").length;
  return {
    venue: s.venue,
    ledgerFills: ledgerIds.length,
    venueFills: s.fillIds.length,
    matched: matched.length,
    missingAtVenue,
    unknownAtVenue,
    refusals,
    bypassAttempts,
    venueWithdrawals: s.withdrawals,
    ok: missingAtVenue.length === 0 && unknownAtVenue.length === 0 && s.withdrawals === 0,
  };
}
