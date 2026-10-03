/** The simulated clock.
 *
 * The runner, the four venue simulators, the policy signer and the agent all
 * read time from ONE instance of this class, so "T+61s" in the Hyperliquid
 * beat is a jump of the clock, never a real wait. The start is fixed so a run
 * is reproducible on stage.
 */
export class SimClock {
  private ms: number;

  constructor(startMs: number = Date.UTC(2026, 9, 2, 14, 30, 0)) {
    this.ms = startMs;
  }

  /** Milliseconds since the Unix epoch, simulated. */
  now(): number {
    return this.ms;
  }

  /** ISO-8601 rendering of {@link now}. */
  iso(): string {
    return new Date(this.ms).toISOString();
  }

  /** Move the clock forward; returns the new time. */
  advance(deltaMs: number): number {
    if (deltaMs < 0) throw new Error("the sim clock never runs backwards");
    this.ms += deltaMs;
    return this.ms;
  }
}
