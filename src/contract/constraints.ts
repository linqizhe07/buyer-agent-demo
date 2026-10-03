/** Per-venue constraints the plugin contract absorbs before a card is raised.
 *
 * A constraint says: when `args[when.arg]` matches, `args[require.arg]` must be
 * one of `require.oneOf`, else it becomes `require.default`. Every rewrite is
 * printed on the card and written to the ledger — the contract absorbs the
 * venue's habit, but it never sends a changed order without asking again.
 */
import { CODES, refuse, type Code, type Refusal } from "../core/errors.ts";
import type { Constraint, Manifest } from "./manifest.ts";

export interface Rewrite {
  id: string;
  arg: string;
  from: unknown;
  to: unknown;
}

export interface ConstraintOutcome {
  args: Record<string, unknown>;
  /** rewrites applied (absorb: true) */
  rewrites: Rewrite[];
  /** constraints that match and would rewrite, left alone (absorb: false) */
  pending: Constraint[];
}

function matches(c: Constraint, args: Record<string, unknown>): boolean {
  const value = args[c.when.arg];
  if (value === undefined || value === null) return false;
  return new RegExp(c.when.matches).test(String(value));
}

export function applyConstraints(
  manifest: Manifest,
  raw: string,
  args: Record<string, unknown>,
  opts: { absorb: boolean },
): ConstraintOutcome {
  const out = { ...args };
  const rewrites: Rewrite[] = [];
  const pending: Constraint[] = [];
  for (const c of manifest.constraints) {
    if (c.tool !== raw || !matches(c, out)) continue;
    const current = out[c.require.arg];
    const okAlready = current !== undefined && c.require.oneOf.includes(String(current));
    if (okAlready) continue;
    if (!opts.absorb) {
      pending.push(c);
      continue;
    }
    rewrites.push({ id: c.id, arg: c.require.arg, from: current, to: c.require.default });
    out[c.require.arg] = c.require.default;
  }
  return { args: out, rewrites, pending };
}

/** Classify a venue error through the manifest's declared constraint errors;
 * anything else is the generic E_VENUE_REJECTED with the venue's words kept. */
export function classifyVenueError(manifest: Manifest, raw: string, venueError: unknown): Refusal {
  const e = (venueError && typeof venueError === "object" ? venueError : { message: String(venueError) }) as Record<string, unknown>;
  for (const c of manifest.constraints) {
    const ve = c.venueError;
    if (!ve || c.tool !== raw || !ve.refusal || !(ve.refusal in CODES)) continue;
    const statusOk = ve.status === undefined || e.status === ve.status;
    const codeOk = ve.code === undefined || String(e.code) === String(ve.code);
    const msgOk = ve.message === undefined || String(e.message ?? "").includes(ve.message);
    if (statusOk && codeOk && msgOk) {
      return refuse(ve.refusal as Code, { venue: manifest.venue, tool: raw, native: venueError, detail: { constraint: c.id } });
    }
  }
  const message = firstText(e, ["message", "msg", "response", "error"]);
  for (const ve of manifest.venueErrors) {
    if (!(ve.refusal in CODES)) continue;
    if (message !== undefined && new RegExp(ve.match, "i").test(message)) {
      return refuse(ve.refusal as Code, { venue: manifest.venue, tool: raw, native: venueError });
    }
  }
  return refuse("E_VENUE_REJECTED", {
    venue: manifest.venue,
    tool: raw,
    native: venueError,
    ...(message ? { message: `场所拒绝：${message}` } : {}),
  });
}

function firstText(e: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = e[k];
    if (typeof v === "string") return v;
    if (v && typeof v === "object" && typeof (v as { message?: unknown }).message === "string") return (v as { message: string }).message;
  }
  return undefined;
}
