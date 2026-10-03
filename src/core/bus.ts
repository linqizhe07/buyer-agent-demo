/** The event bus: everything the runner, the agent, the sims and the control
 * room say to each other goes through here, in order, with a sequence number.
 * The control room replays `since(seq)` over SSE; a run is also persisted as
 * `runs/last.jsonl` so a rehearsal can be replayed without the runner. */
export interface BusEvent<T = unknown> {
  seq: number;
  /** wall-clock time of the emit (for the log) */
  at: string;
  /** simulated time, when a clock was given */
  simAt?: string;
  type: string;
  data: T;
}

export type BusListener = (event: BusEvent) => void;

export interface BusOptions {
  capacity?: number;
  /** receives every event as one JSON line (the run log) */
  sink?: (line: string) => void;
  /** simulated clock, rendered onto every event */
  simNow?: () => string;
}

export class Bus {
  private seq = 0;
  private readonly ring: BusEvent[] = [];
  private readonly listeners = new Set<BusListener>();

  constructor(private readonly opts: BusOptions = {}) {}

  emit<T>(type: string, data: T): BusEvent<T> {
    const event: BusEvent<T> = {
      seq: ++this.seq,
      at: new Date().toISOString(),
      type,
      data,
    };
    if (this.opts.simNow) event.simAt = this.opts.simNow();
    this.ring.push(event as BusEvent);
    const cap = this.opts.capacity ?? 10_000;
    if (this.ring.length > cap) this.ring.splice(0, this.ring.length - cap);
    this.opts.sink?.(JSON.stringify(event));
    for (const fn of this.listeners) {
      try {
        fn(event as BusEvent);
      } catch (err) {
        // A broken listener (a closed SSE socket, say) must never break the run.
        console.error(`[bus] listener failed on ${type}: ${(err as Error).message}`);
      }
    }
    return event;
  }

  on(fn: BusListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  since(seq: number): BusEvent[] {
    return this.ring.filter((e) => e.seq > seq);
  }

  all(): BusEvent[] {
    return [...this.ring];
  }

  last(): number {
    return this.seq;
  }
}
