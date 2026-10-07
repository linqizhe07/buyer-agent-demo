/** What each mode does with an agent's request, door by door — and how long a card waits. The Mode sheet (ui/agents-mount.js) and the
 * agents' account read (mcp.ts portfolio_account) draw from here, so neither drifts from the doors.
 *
 * The wire values stay `guard` | `open` (signed rows, old ledgers); Guard and Beast are the words a person reads. Each row is worded from the
 * door's own code, not from a description of it:
 *   orders, enlarging one          live-orders.ts agent() · amend()        · Guard a card; Beast at once inside the limit
 *   a close                        live-orders.ts close()                   · a plain sell of a holding counts like a sell order in both modes;
 *                                                                              a derivative closed reduce-only: Beast at once inside the per-order
 *                                                                              line, a card above it
 *   leverage                       live-orders.ts leverage()                · a card only where a position is open in the market
 *   cancel                         live-orders.ts cancel()                  · never a card: taking an order off the book moves nothing
 *   money between the user's own   live-moves.ts agent()                    · Guard a card with the exact address and fee; Beast at once
 *   earn                           live-earn.ts agent()                     · a supply counts; a withdrawal counts nothing and goes at once
 *                                                                              in Beast inside the per-supply line
 *   a payment                      pay-real.ts                              · Beast pays a payee paid before at once; a first payment is a card
 *                                                                              unless the limit names any payee (`*`)
 * In both modes anything over a limit is refused before a card is raised, and the owner's own actions are the owner's to sign. */

/** how long a card waits for the owner before it closes unanswered (account/exchange.ts expireCards gives back what it held) */
export const CARD_TTL_MS = 30 * 60_000;
/** the same, in the minutes the page and the agents say */
export const cardMinutes = CARD_TTL_MS / 60_000;

export interface ModeRule {
  /** what an agent, inside its limit, asks for */
  door: string;
  /** what Guard does with it */
  guard: string;
  /** what Beast does with it */
  beast: string;
}

export const MODE_RULES: readonly ModeRule[] = [
  { door: "Place or enlarge an order", guard: "Waits on a card", beast: "At once" },
  { door: "Close a spot, stock or contract holding", guard: "Waits on a card", beast: "At once; counts against its trading limit, like a sell" },
  { door: "Close a derivative position", guard: "Waits on a card", beast: "At once inside its per-order line; a card above it" },
  { door: "Change leverage with a position open", guard: "Waits on a card", beast: "At once if the position is inside its per-order line; else a card" },
  { door: "Move money between your accounts", guard: "Waits on a card", beast: "At once" },
  { door: "Put money into earn", guard: "Waits on a card", beast: "At once" },
  { door: "Take money out of earn", guard: "Waits on a card", beast: "At once inside its per-supply line; a card above it" },
  { door: "Pay from its agent wallet", guard: "Waits on a card", beast: "At once for a payee it paid before; the first payment to a payee still waits on a card, unless its limit says any payee" },
  { door: "Cancel its own order", guard: "At once, never a card", beast: "At once, never a card" },
  { door: "Set leverage with no position open", guard: "At once", beast: "At once" },
];

/** the rules as the account page carries them (AccountPage.modeRules) */
export const modeRules = (): { rows: ModeRule[]; cardMinutes: number } => ({ rows: [...MODE_RULES], cardMinutes });
