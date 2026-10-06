import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isRefusal } from "../../src/core/errors.ts";
import { NetWorthLog, networthPath, type NetWorthHistory, type NetWorthSnapshot } from "../../src/portfolio/account/networth.ts";

/** The net worth curve: snapshots in a file in the account's home, read back as a curve. Every home is a fresh temporary directory and every
 * clock is the test's own, so nothing here depends on when it runs or on any real account. */

const START = Date.parse("2026-10-05T14:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));
const home = (): string => {
  const h = mkdtempSync(join(tmpdir(), "networth-"));
  homes.push(h);
  return h;
};
/** a log on a home, with a clock the test moves */
function log(file = networthPath(home())) {
  const clock = { t: START };
  return { file, clock, log: new NetWorthLog(file, () => clock.t) };
}
const snap = (byVenue: Record<string, number>, extra: Partial<NetWorthSnapshot> = {}): NetWorthSnapshot => {
  const usd = Object.values(byVenue).reduce((s, v) => s + v, 0);
  return { usd, byClass: { crypto: usd }, byVenue, stale: [], ...extra };
};
const rows = (file: string) => readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
const ok = (h: NetWorthHistory | ReturnType<NetWorthLog["read"]>): NetWorthHistory => {
  if (isRefusal(h)) throw new Error(h.message);
  return h;
};

describe("NetWorthLog.append: a point when something changed, or an hour went by", () => {
  it("does not write the same account twice within the hour, and writes it again after", () => {
    const { file, clock, log: l } = log();
    expect(l.append(snap({ kraken: 1000 }))).toMatchObject({ written: true });
    clock.t += 5 * MIN;
    expect(l.append(snap({ kraken: 1000.001 }))).toMatchObject({ written: false });
    clock.t += 50 * MIN;
    expect(l.append(snap({ kraken: 1000 }))).toMatchObject({ written: false });
    clock.t += 5 * MIN;
    // an hour since the last point: the same account is written, so the curve reaches now
    expect(l.append(snap({ kraken: 1000 }))).toMatchObject({ written: true });
    clock.t += 5 * MIN;
    expect(l.append(snap({ kraken: 1001 }))).toMatchObject({ written: true });
    expect(rows(file).map((r) => r.usd)).toEqual([1000, 1000, 1001]);
  });

  it("counts a change of class, of venue split or of which venues are stale as a change, even with the same total", () => {
    const { file, clock, log: l } = log();
    l.append(snap({ a: 500, b: 500 }));
    clock.t += MIN;
    expect(l.append(snap({ a: 400, b: 600 }))).toMatchObject({ written: true });
    clock.t += MIN;
    expect(l.append({ ...snap({ a: 400, b: 600 }), byClass: { crypto: 900, stable: 100 } })).toMatchObject({ written: true });
    clock.t += MIN;
    expect(l.append({ ...snap({ a: 400, b: 600 }), byClass: { crypto: 900, stable: 100 }, stale: ["b"] })).toMatchObject({ written: true });
    expect(rows(file)).toHaveLength(4);
  });

  it("marks a point partial when a venue's data is stale", () => {
    const { file, log: l } = log();
    l.append(snap({ kraken: 1000, kalshi: 50 }, { stale: ["kalshi", "kalshi"] }));
    expect(rows(file)[0]).toMatchObject({ partial: true, stale: ["kalshi"] });
    const h = ok(l.read("1d"));
    expect(h.points[0]).toMatchObject({ usd: 1050, partial: true });
    expect(h.partial).toBe(true);
  });

  it("keeps the file the user's alone, and refuses what is not a snapshot", () => {
    const { file, log: l } = log();
    l.append(snap({ a: 1 }));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(isRefusal(l.append({ ...snap({ a: 1 }), usd: Number.NaN }))).toBe(true);
    expect(isRefusal(l.append({ ...snap({ a: 1 }), byVenue: { a: "1" as unknown as number } }))).toBe(true);
    expect(isRefusal(l.append({ ...snap({ a: 1 }), at: "not a time" }))).toBe(true);
    expect(isRefusal(l.read("2d"))).toBe(true);
  });

  it("makes a file another user could read the user's alone when it next writes", () => {
    const file = networthPath(home());
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "", { mode: 0o644 });
    const l = new NetWorthLog(file, () => START);
    l.append(snap({ a: 1 }));
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe("connecting and disconnecting are not profit", () => {
  it("records the event with what the venue held, and leaves it out of the change", () => {
    const { file, clock, log: l } = log();
    l.append(snap({ kraken: 1000 }));
    clock.t += 10 * MIN;
    l.append(snap({ kraken: 1100 }));
    clock.t += 10 * MIN;
    l.append(snap({ kraken: 1100, alpaca: 5000 }, { event: { kind: "connect", venue: "alpaca", name: "Alpaca" } }));
    clock.t += 10 * MIN;
    l.append(snap({ kraken: 1100, alpaca: 5050 }));
    clock.t += 10 * MIN;
    l.append(snap({ alpaca: 5050 }, { event: { kind: "disconnect", venue: "kraken", name: "Kraken" } }));
    const h = ok(l.read("1d"));
    expect(h.events).toEqual([
      { at: new Date(START + 20 * MIN).toISOString(), kind: "connect", venue: "alpaca", name: "Alpaca", usd: 5000 },
      { at: new Date(START + 40 * MIN).toISOString(), kind: "disconnect", venue: "kraken", name: "Kraken", usd: 1100 },
    ]);
    // gained: 100 at Kraken, 50 at Alpaca. The total went from 1000 to 5050
    expect(h.changeUsd).toBe(150);
    expect(h.changePct).toBe(Number(((150 / (1000 + 5000)) * 100).toFixed(2)));
    expect(h.points.map((p) => p.usd)).toEqual([1000, 1100, 6100, 6150, 5050]);
    expect(rows(file).filter((r) => r.event)).toHaveLength(2);
  });

  it("does not read a venue that is missing after a restart, or comes back, as a loss or a gain", () => {
    const { clock, log: l } = log();
    l.append(snap({ kraken: 1000, alpaca: 2000 }));
    clock.t += 5 * MIN;
    l.append(snap({ kraken: 1010 }));
    clock.t += 5 * MIN;
    l.append(snap({ kraken: 1010, alpaca: 2020 }));
    expect(ok(l.read("1d")).changeUsd).toBe(10);
  });

  it("counts money in flight between venues (in the total, at no venue) as still the user's", () => {
    const { clock, log: l } = log();
    l.append({ usd: 1000, byClass: { stable: 1000 }, byVenue: { a: 1000, b: 0 }, stale: [] });
    clock.t += 5 * MIN;
    // 400 left a, and has not reached b: the total still counts it
    l.append({ usd: 1000, byClass: { stable: 1000 }, byVenue: { a: 600, b: 0 }, stale: [] });
    clock.t += 5 * MIN;
    l.append({ usd: 999, byClass: { stable: 999 }, byVenue: { a: 600, b: 399 }, stale: [] });
    const h = ok(l.read("1d"));
    expect(h.changeUsd).toBe(-1);
  });
});

describe("what the account paid out, and what it cannot see", () => {
  it("an agent's payment to a payee is not a loss: what the account paid out is added back to the change, and said", () => {
    const { clock, log: l } = log();
    l.append(snap({ "agent-ops": 100, kraken: 1000 }, { paidOutUsd: 0 }));
    clock.t += 10 * MIN;
    // the agent wallet paid a payee $50 (x402): the wallet holds $50 less, and nothing else moved
    l.append(snap({ "agent-ops": 50, kraken: 1000 }, { paidOutUsd: 50 }));
    clock.t += 10 * MIN;
    // BTC at Kraken rose $20: that is a change
    l.append(snap({ "agent-ops": 50, kraken: 1020 }, { paidOutUsd: 50 }));
    const h = ok(l.read("1d", clock.t));
    expect([h.changeUsd, h.paidOutUsd, h.points.at(-1)!.usd]).toEqual([20, 50, 1070]);
    // a point with no word on payments adds nothing back, and says nothing paid
    const old = log();
    old.log.append(snap({ x: 100 }));
    old.clock.t += 10 * MIN;
    old.log.append(snap({ x: 60 }));
    expect(ok(old.log.read("1d", old.clock.t))).toMatchObject({ changeUsd: -40 });
    expect(ok(old.log.read("1d", old.clock.t)).paidOutUsd).toBeUndefined();
    expect(isRefusal(old.log.append(snap({ x: 60 }, { paidOutUsd: -1 })))).toBe(true);
  });

  it("a deposit made at a venue's own site is in the change: no venue the account reads says which of its moves were money in, so it is a change, not a gain", () => {
    const { clock, log: l } = log();
    l.append(snap({ alpaca: 1000 }, { paidOutUsd: 0 }));
    clock.t += 10 * MIN;
    // a $1,000 ACH deposit at Alpaca, no price moved: the account sees Alpaca's number go up
    l.append(snap({ alpaca: 2000 }, { paidOutUsd: 0 }));
    expect(ok(l.read("1d", clock.t))).toMatchObject({ changeUsd: 1000, changePct: 100, paidOutUsd: 0 });
  });
});

describe("restarts and two runs sharing a home", () => {
  it("a new run carries on the same curve, and its first point follows the last run's rule", () => {
    const file = networthPath(home());
    const first = new NetWorthLog(file, () => START);
    first.append(snap({ a: 100 }));
    const second = new NetWorthLog(file, () => START + 10 * MIN);
    expect(second.append(snap({ a: 100 }))).toMatchObject({ written: false });
    expect(second.append(snap({ a: 120 }))).toMatchObject({ written: true });
    const h = ok(second.read("1d"));
    expect(h.points.map((p) => p.usd)).toEqual([100, 120]);
    expect(h.first).toBe(new Date(START).toISOString());
    expect(h.changeUsd).toBe(20);
  });

  it("each run sees what the other appended, before it writes and when it reads", () => {
    const file = networthPath(home());
    const clock = { t: START };
    const a = new NetWorthLog(file, () => clock.t);
    const b = new NetWorthLog(file, () => clock.t);
    a.append(snap({ x: 10 }));
    clock.t += 5 * MIN;
    expect(b.append(snap({ x: 10 }))).toMatchObject({ written: false });
    expect(b.append(snap({ x: 11 }))).toMatchObject({ written: true });
    clock.t += 5 * MIN;
    expect(a.append(snap({ x: 11 }))).toMatchObject({ written: false });
    expect(ok(a.read("1d")).points.map((p) => p.usd)).toEqual([10, 11]);
    expect(rows(file)).toHaveLength(2);
  });

  it("goes on past a line cut short, and starts its next row on a line of its own", () => {
    const { file, clock, log: l } = log();
    l.append(snap({ a: 1 }));
    appendFileSync(file, '{"v":1,"at":"2026-10-05T14:01');
    clock.t += 5 * MIN;
    expect(l.append(snap({ a: 2 }))).toMatchObject({ written: true });
    const again = new NetWorthLog(file, () => clock.t);
    expect(ok(again.read("1d")).points.map((p) => p.usd)).toEqual([1, 2]);
  });

  it("reads a file that was replaced from the start", () => {
    const { file, clock, log: l } = log();
    l.append(snap({ a: 1 }));
    clock.t += MIN;
    l.append(snap({ a: 2 }));
    writeFileSync(file, `${JSON.stringify({ v: 1, at: new Date(START).toISOString(), usd: 7, byClass: {}, byVenue: { a: 7 } })}\n`);
    expect(ok(l.read("1d")).points.map((p) => p.usd)).toEqual([7]);
  });
});

describe("NetWorthLog.read: the curve, one point per bucket", () => {
  /** a point a minute for `minutes`, the total climbing a dollar a minute */
  function minutes(n: number, every = MIN) {
    const { clock, log: l } = log();
    for (let i = 0; i < n; i++) {
      clock.t = START + i * every;
      l.append(snap({ a: 1000 + i }));
    }
    return { clock, l };
  }

  it("a day: the last point of every five minutes", () => {
    const { clock, l } = minutes(30);
    const h = ok(l.read("1d", clock.t));
    expect(h.bucket).toBe("5m");
    expect(h.points.map((p) => p.usd)).toEqual([1004, 1009, 1014, 1019, 1024, 1029]);
    expect(h.points.at(-1)!.at).toBe(new Date(START + 29 * MIN).toISOString());
    // the change is from every point, not only the curve's
    expect(h.changeUsd).toBe(29);
  });

  it("a week and a month: the last point of every hour; all of it: the finest bucket for its span", () => {
    const { clock, l } = minutes(3 * 24 * 4, 15 * MIN);
    const w = ok(l.read("1w", clock.t));
    expect(w.bucket).toBe("1h");
    expect(w.points).toHaveLength(3 * 24);
    expect(ok(l.read("1m", clock.t)).bucket).toBe("1h");
    const all = ok(l.read("all", clock.t));
    expect(all.bucket).toBe("1h");
    expect(all.from).toBe(new Date(START).toISOString());
    const short = minutes(10);
    expect(ok(short.l.read("all", short.clock.t)).bucket).toBe("5m");
  });

  it("starts a range at the value the account had then, when it was looked at close enough to then", () => {
    const { clock, log: l } = log();
    l.append(snap({ a: 100 }));
    clock.t = START + 30 * MIN;
    l.append(snap({ a: 150 }));
    clock.t = START + DAY + 20 * MIN;
    l.append(snap({ a: 160 }));
    const h = ok(l.read("1d", clock.t));
    // the day began at START + 20 min: the point at START + 0 is older than that, but within the hour the account writes at least once
    expect(h.points[0]).toEqual({ at: new Date(START + 20 * MIN).toISOString(), usd: 100 });
    expect(h.changeUsd).toBe(60);
    // a range that begins long after the last point before it does not pretend to know its start
    const later = ok(l.read("1d", START + DAY + 30 * MIN + 2 * HOUR));
    expect(later.points.map((p) => p.usd)).toEqual([160]);
    expect(later.changeUsd).toBe(0);
    expect(later.changePct).toBeUndefined();
  });

  it("an empty log is an empty curve", () => {
    const { log: l } = log();
    const h = ok(l.read("1w"));
    expect(h).toMatchObject({ range: "1w", points: [], events: [], changeUsd: 0 });
    expect(h.first).toBeUndefined();
  });
});
