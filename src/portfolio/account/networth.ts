/** NET WORTH over time: what the account was worth, snapshot after snapshot, kept in `<home>/portfolio/networth.jsonl` for the curve on
 * the Portfolio screen.
 *
 * This is DERIVED data, not the ledger: it is not hash-chained, nothing is restored from it, and nothing is decided by it. A lost or edited
 * file loses a curve, never money and never a limit. It is the user's own numbers all the same, so the file is readable by the user alone
 * (mode 0600, as the account's key files are). History starts at the first snapshot: what the account was worth before it is not known,
 * and nothing here makes it up.
 *
 *   append(snapshot)   one point: the total, by class and by venue, and which venues' numbers are stale. A point the same as the last one
 *                      is not written while the last one is less than an hour old, so a quiet account writes one an hour, not one every
 *                      five minutes. A point with a stale venue is marked `partial`: that venue's number is the last good one, not now's
 *   read(range, now)   the last day, week or month, or all of it: one point per 5 minutes, per hour or per day (the last in each), the
 *                      connections and disconnections in it, and how the account's holdings changed (`changeUsd`)
 *
 * Connecting a venue is not profit, and disconnecting one is not a loss. The CHANGE is counted venue by venue, between each point and the
 * next, over the venues present in both: a venue that appears (connected) or goes away (disconnected, or not yet back after a restart)
 * moves the total and not the change. Money the account itself paid out to someone else (an agent's payment to a payee: the account's own
 * record of it, `paidOutUsd` on each point, in all) is not a loss either: it is added back, and said (`paidOutUsd` over the range). What the
 * account does NOT see is in the change: a deposit or a withdrawal made at a venue's own site moves that venue's number like a price does,
 * because no venue the account reads says which of its moves were money in or out — so it is a change, not a gain. A connect or disconnect the account saw is also written as an event of its own, with
 * what the venue held, so the page can mark it on the curve. Money the total counts and no venue holds (in flight between venues, in an
 * open session's escrow) is the difference between the total and the venues, and is counted like a venue that is always there.
 *
 * Two runs of the account can share a home (the service and a command line): each reads what the other appended before it reads or
 * writes, so the "same as the last point" rule sees the other's points too, and a run that restarts carries on the same curve.
 */
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Refusal } from "../../core/errors.ts";
import { no } from "../refuse.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** an unchanged account still writes a point this often */
export const NETWORTH_KEEP_MS = HOUR;
/** a point older than this before the start of a range does not stand for the range's start: nothing was looking in between */
const ANCHOR_MS = HOUR + 15 * MINUTE;

export type NetWorthRange = "1d" | "1w" | "1m" | "all";
export const NETWORTH_RANGES: readonly NetWorthRange[] = ["1d", "1w", "1m", "all"];
export type NetWorthBucket = "5m" | "1h" | "1d";
const BUCKET_MS: Readonly<Record<NetWorthBucket, number>> = { "5m": 5 * MINUTE, "1h": HOUR, "1d": DAY };
const SPAN_MS: Readonly<Record<Exclude<NetWorthRange, "all">, number>> = { "1d": DAY, "1w": 7 * DAY, "1m": 30 * DAY };

/** one point per bucket: five minutes over a day, an hour over a week or a month; over all of it, the finest that keeps the curve to a
 * few hundred points */
export function bucketFor(range: NetWorthRange, spanMs: number): NetWorthBucket {
  if (range === "1d") return "5m";
  if (range === "1w" || range === "1m") return "1h";
  return spanMs <= 2 * DAY ? "5m" : spanMs <= 60 * DAY ? "1h" : "1d";
}

export const networthPath = (home: string): string => join(home, "portfolio", "networth.jsonl");

/** what the account was worth at one moment, as the service reads it off the account page */
export interface NetWorthSnapshot {
  /** when (ISO 8601 or milliseconds); absent: the log's clock */
  at?: string | number | undefined;
  /** the whole account, in dollars */
  usd: number;
  /** by asset class: crypto, stable, cash, equity, rwa, event */
  byClass: Record<string, number>;
  /** by venue id. A venue the account holds stays here (with 0) for as long as it is connected: one that is missing reads as disconnected */
  byVenue: Record<string, number>;
  /** the venues whose last read failed: their numbers are the last good ones */
  stale: string[];
  /** what the account has paid out to someone else, in all, by its own records (agents' payments to payees, settled): a step's change has
   * what it grew by added back. Absent: not known, and nothing is added back */
  paidOutUsd?: number | undefined;
  /** a venue connected or disconnected just now: the snapshot is the account as it is after it */
  event?: { kind: "connect" | "disconnect"; venue: string; name?: string | undefined } | undefined;
}

interface PointRow {
  v: 1;
  at: string;
  usd: number;
  byClass: Record<string, number>;
  byVenue: Record<string, number>;
  stale?: string[] | undefined;
  partial?: true | undefined;
  paid?: number | undefined;
}

export interface NetWorthEvent {
  at: string;
  kind: "connect" | "disconnect";
  venue: string;
  name?: string | undefined;
  /** what the venue held when it was connected, or when it went */
  usd: number;
}

interface EventRow {
  v: 1;
  at: string;
  event: Omit<NetWorthEvent, "at">;
}

export interface NetWorthPoint {
  at: string;
  usd: number;
  /** a venue's number in it was its last good one */
  partial?: true | undefined;
}

export interface NetWorthHistory {
  range: NetWorthRange;
  /** where the range starts (the first point, for "all"), and the size of its buckets */
  from: string;
  bucket: NetWorthBucket;
  /** oldest first; the first stands for the range's start when the account was looked at then */
  points: NetWorthPoint[];
  /** the first point the account ever wrote: the curve cannot go back further ("since …") */
  first?: string | undefined;
  /** connections and disconnections in the range, oldest first */
  events: NetWorthEvent[];
  /** how the account's holdings changed over the range: connections and disconnections left out, and what the account paid out to
   * someone else added back; a deposit or withdrawal made at a venue's own site is in it (see the top). 0 with fewer than two points */
  changeUsd: number;
  /** what the account paid out to someone else over the range (agents' payments to payees), which the change does not count as a loss */
  paidOutUsd?: number | undefined;
  /** that, in percent of what the account held at the start and what was connected since; absent with fewer than two points */
  changePct?: number | undefined;
  /** a point in the range carried a stale venue: the change may miss what that venue did while it could not be read */
  partial?: true | undefined;
}

const r2 = (n: number): number => Number(n.toFixed(2)) || 0;
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const iso = (ms: number): string => new Date(ms).toISOString();

/** a map of dollars, rounded to the cent, its keys in order, so that two of them compare as text */
function cents(m: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.keys(m).sort().map((k) => [k, r2(m[k]!)]));
}

function asPoint(x: unknown): PointRow | undefined {
  if (!x || typeof x !== "object") return undefined;
  const r = x as Partial<PointRow>;
  if (typeof r.at !== "string" || !Number.isFinite(Date.parse(r.at)) || !finite(r.usd) || !r.byVenue || typeof r.byVenue !== "object") return undefined;
  return r as PointRow;
}

function asEvent(x: unknown): EventRow | undefined {
  if (!x || typeof x !== "object") return undefined;
  const r = x as Partial<EventRow>;
  const e = r.event;
  if (typeof r.at !== "string" || !Number.isFinite(Date.parse(r.at)) || !e || (e.kind !== "connect" && e.kind !== "disconnect") || typeof e.venue !== "string" || !finite(e.usd)) return undefined;
  return r as EventRow;
}

/** What a point is made of, venue by venue, for the change: each venue's number, and what is in the total and in no venue (money in flight,
 * in escrow) as one more venue that is always there. A venue whose number is STALE at the point is left out: its number is the last good
 * one, not what it holds now, so nothing is read off it — the step into it counts nothing, and when it answers again it comes back as a
 * venue that appeared (a connection, not a gain). Its stale number still leaves the remainder: it is in the total, and it is no one else's */
const OTHER = "\u0000other";
function parts(p: PointRow): Map<string, number> {
  const stale = new Set(p.stale ?? []);
  const all = Object.entries(p.byVenue).filter(([, v]) => finite(v));
  const m = new Map(all.filter(([venue]) => !stale.has(venue)));
  m.set(OTHER, p.usd - all.reduce((s, [, v]) => s + v, 0));
  return m;
}

export class NetWorthLog {
  private points: PointRow[] = [];
  private events: EventRow[] = [];
  /** how far into the file has been read: whole lines only */
  private offset = 0;
  /** the file ends in a line with no newline (a write cut short): the next row starts on a line of its own */
  private dangling = false;
  private checkedMode = false;

  /** `file`: the JSONL file (networthPath(home)); `now`: the clock, in milliseconds */
  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {}

  path(): string {
    return this.file;
  }

  /** read what was appended since the last look — by this run or another sharing the home. A file that shrank was replaced: read again */
  private sync(): void {
    if (!existsSync(this.file)) {
      if (this.offset) this.forget();
      return;
    }
    const size = statSync(this.file).size;
    if (size < this.offset) this.forget();
    if (size === this.offset) return;
    const buf = Buffer.alloc(size - this.offset);
    const fd = openSync(this.file, "r");
    try {
      readSync(fd, buf, 0, buf.length, this.offset);
    } finally {
      closeSync(fd);
    }
    const end = buf.lastIndexOf(0x0a);
    this.dangling = end < buf.length - 1;
    if (end < 0) return;
    this.offset += end + 1;
    for (const line of buf.subarray(0, end + 1).toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch {
        // a line cut short, or not one of ours: the curve goes on without it
        continue;
      }
      const e = asEvent(row);
      if (e) this.events.push(e);
      else {
        const p = asPoint(row);
        if (p) this.points.push(p);
      }
    }
  }

  private forget(): void {
    this.points = [];
    this.events = [];
    this.offset = 0;
    this.dangling = false;
  }

  /** what one venue held at the newest point that counted it, and when: a venue a restart could not bring back is shown at that */
  lastOf(venue: string): { usd: number; at: string } | undefined {
    this.sync();
    // the newest point at which the venue was read (not one that carried its numbers on while it was not answering)
    let best: PointRow | undefined;
    for (const p of this.points) if (typeof p.byVenue[venue] === "number" && !p.stale?.includes(venue) && (!best || Date.parse(p.at) >= Date.parse(best.at))) best = p;
    return best ? { usd: best.byVenue[venue]!, at: best.at } : undefined;
  }

  /** the point written last, by its time */
  private last(): PointRow | undefined {
    let best: PointRow | undefined;
    for (const p of this.points) if (!best || Date.parse(p.at) >= Date.parse(best.at)) best = p;
    return best;
  }

  /** One snapshot. Written unless it is the same as the last point (to the cent, venue by venue and class by class, with the same stale
   * venues) and that point is less than an hour old; a connect or disconnect is always written, with the point after it */
  append(s: NetWorthSnapshot): { written: boolean; at: string } | Refusal {
    const atMs = s.at === undefined ? this.now() : typeof s.at === "number" ? s.at : Date.parse(s.at);
    const bad = (message: string) => no("E_ACCOUNT_BAD_ACTION", { message: `a net worth snapshot ${message}` });
    if (!Number.isFinite(atMs)) return bad("needs a time");
    if (!finite(s.usd)) return bad("needs a total in dollars");
    for (const [what, m] of [["byClass", s.byClass], ["byVenue", s.byVenue]] as const) {
      if (!m || typeof m !== "object" || Object.values(m).some((v) => !finite(v))) return bad(`needs ${what} as dollars by name`);
    }
    if (!Array.isArray(s.stale) || s.stale.some((x) => typeof x !== "string")) return bad("names its stale venues as a list");
    if (s.paidOutUsd !== undefined && !(finite(s.paidOutUsd) && s.paidOutUsd >= 0)) return bad("says what was paid out as dollars, or nothing");
    this.sync();
    const at = iso(atMs);
    const stale = [...new Set(s.stale)].sort();
    const point: PointRow = { v: 1, at, usd: r2(s.usd), byClass: cents(s.byClass), byVenue: cents(s.byVenue), ...(stale.length ? { stale, partial: true as const } : {}), ...(s.paidOutUsd !== undefined ? { paid: r2(s.paidOutUsd) } : {}) };
    const last = this.last();
    const rows: unknown[] = [];
    if (s.event) {
      // what the venue brought in, or took away: what it holds now, or what it held at the last point
      const held = s.event.kind === "connect" ? point.byVenue[s.event.venue] : last?.byVenue[s.event.venue];
      rows.push({ v: 1, at, event: { kind: s.event.kind, venue: s.event.venue, ...(s.event.name ? { name: s.event.name } : {}), usd: r2(held ?? 0) } } satisfies EventRow);
    } else if (last && same(last, point) && atMs >= Date.parse(last.at) && atMs - Date.parse(last.at) < NETWORTH_KEEP_MS) {
      return { written: false, at: last.at };
    }
    rows.push(point);
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    if (!this.checkedMode && existsSync(this.file) && statSync(this.file).mode & 0o077) chmodSync(this.file, 0o600);
    this.checkedMode = true;
    // one write: two runs appending at once do not interleave inside a row
    appendFileSync(this.file, `${this.dangling ? "\n" : ""}${rows.map((r) => JSON.stringify(r)).join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
    this.sync();
    return { written: true, at };
  }

  /** The curve over `range`, as of `now`. A range that is not one of 1d, 1w, 1m, all is a refusal */
  read(range: string, now: number = this.now()): NetWorthHistory | Refusal {
    if (!(NETWORTH_RANGES as readonly string[]).includes(range)) return no("E_ACCOUNT_BAD_ACTION", { message: `a net worth range is one of ${NETWORTH_RANGES.join(", ")}: not "${range}"`, detail: { ranges: NETWORTH_RANGES } });
    const r = range as NetWorthRange;
    this.sync();
    const all = this.points.map((p, i) => ({ p, ms: Date.parse(p.at), i })).sort((a, b) => a.ms - b.ms || a.i - b.i);
    const firstMs = all[0]?.ms;
    const startMs = r === "all" ? (firstMs ?? now) : now - SPAN_MS[r];
    const bucket = bucketFor(r, now - startMs);
    const used: Array<{ p: PointRow; ms: number }> = all.filter((x) => x.ms >= startMs && x.ms <= now);
    // the last point before the range stands for its start, if the account was looked at close enough to it
    const before = all.filter((x) => x.ms < startMs).pop();
    if (before && startMs - before.ms <= ANCHOR_MS) used.unshift({ p: before.p, ms: startMs });
    // the curve: the last point in each bucket
    const kept = new Map<number, { p: PointRow; ms: number }>();
    const size = BUCKET_MS[bucket];
    for (const x of used) kept.set(Math.floor(x.ms / size), x);
    const points = [...kept.values()].map(({ p, ms }): NetWorthPoint => ({ at: iso(ms), usd: p.usd, ...(p.partial ? { partial: true as const } : {}) }));
    // the change, from every point (not only the curve's), venue by venue over the venues present on both sides of each step; what the
    // account paid out to someone else in the step is added back
    let change = 0;
    let came = 0;
    let paidOut = 0;
    let paidKnown = false;
    for (let k = 1; k < used.length; k++) {
      const a = parts(used[k - 1]!.p);
      const b = parts(used[k]!.p);
      for (const [v, usd] of b) {
        const was = a.get(v);
        if (was === undefined) came += Math.max(0, usd);
        else change += usd - was;
      }
      const pa = used[k - 1]!.p.paid;
      const pb = used[k]!.p.paid;
      if (finite(pa) && finite(pb)) {
        paidKnown = true;
        const out = Math.max(0, pb - pa);
        change += out;
        paidOut += out;
      }
    }
    const base = used.length ? used[0]!.p.usd + came : 0;
    const events = this.events
      .map((e, i) => ({ e, ms: Date.parse(e.at), i }))
      .filter((x) => x.ms >= startMs && x.ms <= now)
      .sort((a, b) => a.ms - b.ms || a.i - b.i)
      .map(({ e }): NetWorthEvent => ({ at: e.at, ...e.event }));
    const two = used.length >= 2;
    return {
      range: r,
      from: iso(startMs),
      bucket,
      points,
      ...(firstMs !== undefined ? { first: iso(firstMs) } : {}),
      events,
      changeUsd: two ? r2(change) : 0,
      ...(paidKnown ? { paidOutUsd: r2(paidOut) } : {}),
      ...(two && base > 0 ? { changePct: r2((change / base) * 100) } : {}),
      ...(used.some((x) => x.p.partial) ? { partial: true as const } : {}),
    };
  }
}

/** the same account: the same total, classes, venues and stale venues, to the cent */
function same(a: PointRow, b: PointRow): boolean {
  return a.usd === b.usd && (a.paid ?? null) === (b.paid ?? null) && JSON.stringify(cents(a.byClass ?? {})) === JSON.stringify(b.byClass) && JSON.stringify(cents(a.byVenue)) === JSON.stringify(b.byVenue) && JSON.stringify([...(a.stale ?? [])].sort()) === JSON.stringify(b.stale ?? []);
}
