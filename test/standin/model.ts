/** The stand-in account's market: one price curve per thing traded, which moves a little every few seconds and also gives its own past —
 * the candles, the last 24 hours and the net worth curve's points are read off the same curve, so they agree with each other.
 *
 * A curve is three slow waves on top of one another (minutes, hours, days), plus a ramp over the 24 hours before the stand-in started that
 * makes its 24-hour change at the start exactly the one it was given. A price lives in log space; an event contract's price (a probability)
 * lives in logit space, so it stays between 0 and 1. On top of the curve, `now()` adds a few seconds' jitter that `tick()` moves. Nothing
 * here is random from run to run except the jitter: the waves are seeded from each curve's name.
 *
 * Nothing here is any venue's data. It is made up, and every page that shows it is the stand-in's.
 */
import type { Candle, CandleInterval } from "../../src/portfolio/live/trade.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
const INTERVAL_MS: Record<CandleInterval, number> = { "5m": 5 * MINUTE, "1h": HOUR, "1d": DAY };

/** FNV-1a: a name as a 32-bit seed */
export function seedOf(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: a small seeded generator, the same numbers for the same seed */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const logit = (p: number): number => Math.log(p / (1 - p));
const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));
const smooth = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

export interface CurveSpec {
  /** the price at the start (an event contract's: its probability, between 0 and 1) */
  price: number;
  /** the last 24 hours at the start: in percent for a price; in dollars per contract for an event (0.04 = 4¢) */
  change24h: number;
  /** how much it moves: 1 is a large coin's, 0.02 a fund token's */
  vol?: number | undefined;
  event?: boolean | undefined;
}

interface Curve {
  event: boolean;
  /** the level the waves and the ramp move around, in log or logit space */
  level: number;
  amps: [number, number, number];
  periods: [number, number, number];
  phases: [number, number, number];
  ramp: number;
  vol: number;
}

export class PriceBook {
  private readonly curves = new Map<string, Curve>();
  private readonly jitter = new Map<string, number>();
  private readonly random: () => number;

  /** `t0`: when the stand-in started (its curves' 24-hour changes are the given ones then); `clock`: the real clock */
  constructor(
    readonly t0: number,
    private readonly clock: () => number = Date.now,
    seed = seedOf(String(t0)),
  ) {
    this.random = seeded(seed);
  }

  add(key: string, spec: CurveSpec): void {
    const r = seeded(seedOf(key));
    const vol = spec.vol ?? 1;
    const event = spec.event === true;
    const amps: [number, number, number] = event ? [0.04 * vol, 0.12 * vol, 0.3 * vol] : [0.0035 * vol, 0.012 * vol, 0.045 * vol];
    // a wave of about ten minutes (so a resting limit near the price fills while someone watches), one of hours, one of days
    const periods: [number, number, number] = [(8 + 6 * r()) * MINUTE, (5 + 4 * r()) * HOUR, (8 + 6 * r()) * DAY];
    const phases: [number, number, number] = [r() * 2 * Math.PI, r() * 2 * Math.PI, r() * 2 * Math.PI];
    const c: Curve = { event, level: 0, amps, periods, phases, ramp: 0, vol };
    const target = event ? logit(clampP(spec.price)) - logit(clampP(spec.price - spec.change24h)) : Math.log(1 + spec.change24h / 100);
    c.ramp = target - (this.waves(c, this.t0) - this.waves(c, this.t0 - DAY));
    c.level = (event ? logit(clampP(spec.price)) : Math.log(spec.price)) - this.waves(c, this.t0) - c.ramp;
    this.curves.set(key, c);
    this.jitter.set(key, 0);
  }

  has(key: string): boolean {
    return this.curves.has(key);
  }

  private waves(c: Curve, t: number): number {
    let s = 0;
    for (let i = 0; i < 3; i++) s += c.amps[i]! * Math.sin((2 * Math.PI * t) / c.periods[i]! + c.phases[i]!);
    return s;
  }

  private value(c: Curve, t: number, extra = 0): number {
    const x = c.level + this.waves(c, t) + c.ramp * smooth((t - (this.t0 - DAY)) / DAY) + extra;
    return c.event ? sigmoid(x) : Math.exp(x);
  }

  private curve(key: string): Curve {
    const c = this.curves.get(key);
    if (!c) throw new Error(`the stand-in has no price curve called ${key}`);
    return c;
  }

  /** the curve at `t`: the past as the candles and the net worth curve show it (no jitter) */
  at(key: string, t: number): number {
    return this.value(this.curve(key), t);
  }

  /** the price now: the curve, and the last few seconds' jitter */
  now(key: string): number {
    return this.value(this.curve(key), this.clock(), this.jitter.get(key) ?? 0);
  }

  /** the last 24 hours as of now: the change in percent, and in the price's own units */
  day(key: string): { changePct24h: number; change24h: number; high24h: number; low24h: number } {
    const now = this.clock();
    const p = this.now(key);
    const was = this.at(key, now - DAY);
    let high = Math.max(p, was);
    let low = Math.min(p, was);
    for (let t = now - DAY; t < now; t += 30 * MINUTE) {
      const x = this.at(key, t);
      high = Math.max(high, x);
      low = Math.min(low, x);
    }
    return { changePct24h: ((p - was) / was) * 100, change24h: p - was, high24h: high, low24h: low };
  }

  /** a few seconds pass: each price takes a small step, and is pulled back towards its curve */
  tick(): void {
    for (const [key, c] of this.curves) {
      const j = this.jitter.get(key) ?? 0;
      // two uniform draws make a rough bell; the step is a few hundredths of a percent for a large coin
      const step = (this.random() + this.random() - 1) * (c.event ? 0.02 : 0.0006) * c.vol;
      this.jitter.set(key, j * 0.85 + step);
    }
  }

  /** bars from `sinceMs` to now, oldest first: each bar's open and close off the curve (the last close is the price now), its high and low
   * from points inside it */
  candles(key: string, interval: CandleInterval, sinceMs: number, volumePerDay = 0): Candle[] {
    const c = this.curve(key);
    const size = INTERVAL_MS[interval];
    const now = this.clock();
    const out: Candle[] = [];
    const from = Math.max(Math.floor(sinceMs / size) * size, now - 400 * size);
    for (let t = from; t <= now; t += size) {
      const end = Math.min(t + size, now);
      const o = this.value(c, t);
      const close = end >= now ? this.now(key) : this.value(c, end);
      let h = Math.max(o, close);
      let l = Math.min(o, close);
      for (let k = 1; k < 4; k++) {
        const x = this.value(c, t + ((end - t) * k) / 4);
        h = Math.max(h, x);
        l = Math.min(l, x);
      }
      // a small wick, the same every time this bar is drawn
      const w = seeded(seedOf(`${key}|${interval}|${t}`))();
      h *= 1 + w * 0.0008 * c.vol;
      l *= 1 - (1 - w) * 0.0008 * c.vol;
      if (c.event) {
        h = Math.min(h, 0.99);
        l = Math.max(l, 0.01);
      }
      out.push({ t, o, h, l, c: close, ...(volumePerDay > 0 ? { v: Number(((volumePerDay * (end - t)) / DAY / Math.max(close, 1e-9)).toFixed(4)) } : {}) });
    }
    return out;
  }
}

const clampP = (p: number): number => Math.min(0.98, Math.max(0.02, p));

/** down to a step of price or size, without binary dust */
export function toStep(x: number, step: number, how: "floor" | "round" | "ceil" = "round"): number {
  const n = how === "floor" ? Math.floor(x / step + 1e-9) : how === "ceil" ? Math.ceil(x / step - 1e-9) : Math.round(x / step);
  const places = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  return Number((n * step).toFixed(Math.min(12, places + 2)));
}
