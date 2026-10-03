/** Deterministic ids: `intent-0001`, `call-0002`, ... one counter per prefix.
 * Determinism matters more than global uniqueness here: a rehearsal and the
 * live run print the same ids, so the presenter's notes stay valid. */
export class IdFactory {
  private readonly counters = new Map<string, number>();

  next(prefix: string): string {
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    return `${prefix}-${String(n).padStart(4, "0")}`;
  }
}
