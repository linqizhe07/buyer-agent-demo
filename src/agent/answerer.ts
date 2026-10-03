/** Who answers a card.
 *
 * Headless runs use the stand-in: it prints that it is a stand-in, approves,
 * and rejects only when the script queued a rejection. Live runs use a human
 * at the control room (`HttpAnswerer`, added with the control room).
 */
import type { ApprovalCard, CardOutcome } from "./gate.ts";

export interface Answerer {
  readonly kind: "stand-in" | "human";
  answer(card: ApprovalCard): Promise<CardOutcome>;
}

export class AutoAnswerer implements Answerer {
  readonly kind = "stand-in" as const;
  private queue: CardOutcome[] = [];

  constructor(private readonly delayMs = 0) {}

  /** the next card gets this outcome (scripts queue a rejection to show one) */
  queueNext(outcome: CardOutcome): void {
    this.queue.push(outcome);
  }

  async answer(card: ApprovalCard): Promise<CardOutcome> {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const outcome = this.queue.shift() ?? "allowed-once";
    console.log(`  [stand-in answerer] ${outcome === "allowed-once" ? "approved" : "REJECTED"} card ${card.id} · ${card.line}`);
    return outcome;
  }
}
