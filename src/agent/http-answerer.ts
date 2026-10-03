/** The human at the control room. `answer(card)` parks the card until
 * `POST /approve {cardId, outcome}` arrives; nothing times out, because the
 * decision is the human's. */
import type { Answerer } from "./answerer.ts";
import type { ApprovalCard, CardOutcome } from "./gate.ts";

export class HttpAnswerer implements Answerer {
  readonly kind = "human" as const;
  private readonly pending = new Map<string, { card: ApprovalCard; resolve: (o: CardOutcome) => void }>();

  constructor(private readonly onCard?: (card: ApprovalCard) => void) {}

  answer(card: ApprovalCard): Promise<CardOutcome> {
    console.log(`  [control room] waiting for the human · card ${card.id} · ${card.line}`);
    this.onCard?.(card);
    return new Promise<CardOutcome>((resolve) => this.pending.set(card.id, { card, resolve }));
  }

  /** the route handler calls this; returns false when no such card is waiting */
  decide(cardId: string, outcome: CardOutcome): boolean {
    const p = this.pending.get(cardId);
    if (!p) return false;
    this.pending.delete(cardId);
    p.resolve(outcome);
    return true;
  }

  waiting(): ApprovalCard[] {
    return [...this.pending.values()].map((p) => p.card);
  }
}
