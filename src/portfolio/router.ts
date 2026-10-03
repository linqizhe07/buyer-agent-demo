/** An order as a flight: the router's plan (venues.ts) in the agent's words —
 * what it compared, one step per slice, what it left alone and why, and where
 * the proceeds end up (a sale on a CEX whose key cannot withdraw leaves the
 * money stuck there; a sale on a DEX leaves it on-chain, free to move).
 *
 * One planner for both kinds of thing an order can be about: an asset
 * (`ETH`) or an event contract (`FED-DEC-HIKE25:YES`).
 *
 * Pure. The service flies it: every slice is a leg, and the whole order is ONE
 * decision for the human — one card, not one per slice. */
import { chainIdOf, qtyText, type Intent } from "./accounts.ts";
import { eventState, parseEventSymbol, PREDICTION_VENUES } from "./events.ts";
import type { RailAccount } from "./rails.ts";
import { EXTRA_LEG_MIN_GAIN_USD, splitOrder, type Side, type Slice, type SplitPlan, type VenueKind } from "./venues.ts";
import { cents } from "./words.ts";

export interface Step {
  account: string;
  intent: Intent;
  /** the agent's own words for this action */
  say: string;
  /** what this step was chosen over (other routes, other venues) */
  compare?: string | undefined;
  /** index of a step that must have succeeded first (a subscribe after a bridge) */
  needs?: number | undefined;
}

/** one segment of the split bar on the page */
export interface Part {
  label: string;
  pct: number;
  kind: VenueKind;
}

export interface OrderPlan {
  /** an asset (`ETH`) or an event contract (`FED-DEC-HIKE25:YES`) */
  base: string;
  side: Side;
  qty: number;
  /** `Sell 3 ETH` · `Buy 1,000 YES · Fed hikes 25 bps in December` */
  title: string;
  split: SplitPlan;
  narration: string;
  /** one per slice, best price first; empty when the order cannot be done */
  steps: Step[];
  /** about the plan: what was left out and why */
  notes: string[];
  /** about the outcome — where the proceeds are, what the position pays. Said only once the order has actually filled (after the card, if there is one) */
  after: string[];
  parts?: Part[] | undefined;
}

const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
/** an asset's price to the cent; a share's price to the tenth of a cent */
const price = (n: number) => (n < 10 ? n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 }) : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

export function orderPlan(base: string, side: Side, qty: number, accounts: RailAccount[], now?: string): OrderPlan {
  const split = splitOrder(base, side, qty, accounts);
  const sell = side === "sell";
  const ev = parseEventSymbol(base);
  const verb = sell ? "Sell" : "Buy";
  /** what one unit of the order is called: `ETH`, or the outcome of an event contract */
  const unit = ev ? ev.outcome : base;
  const title = ev ? `${verb} ${qtyText(qty)} ${ev.outcome} · ${ev.event.title}` : `${verb} ${qtyText(qty)} ${base}`;
  const out: OrderPlan = { base, side, qty, title, split, narration: "", steps: [], notes: [], after: [] };
  const mixOf = (slices: Slice[]) => slices.map((s) => `${s.name} ${qtyText(s.qty)}`).join(" · ");

  if (ev && now !== undefined && eventState(ev.event, now) === "resolved") {
    out.narration = `${title}: this market has settled (${ev.event.resolved}); it takes no more orders.`;
    return out;
  }
  if (!split.feasible) {
    const reasons = split.quotes.filter((q) => !q.ok).map((q) => `${q.name} ${q.why ?? "cannot take it"}`).join("; ");
    out.narration = !split.quotes.length
      ? `${title}: no connected venue trades it.`
      : split.maxQty > 0
        ? `${title}: all venues together ${sell ? `hold only ${qtyText(split.maxQty)} ${unit}, not enough` : `can pay for only ${qtyText(split.maxQty)} ${unit}`} — ${reasons}.`
        : `${title}: no venue can take it right now — ${reasons || "no inventory"}.`;
    return out;
  }

  const stepOf = (s: Slice, compare?: string): Step => ({
    account: s.account,
    intent: { kind: "trade", symbol: s.symbol, side, qty: s.qty, ...(s.chain ? { chainId: chainIdOf(s.chain) } : {}) },
    say: `${verb} ${qtyText(s.qty)} ${unit} · ${s.name}`,
    compare,
  });

  if (split.slices.length === 1) {
    const best = split.slices[0]!;
    const rest = split.quotes.filter((q) => q.venue !== best.venue);
    const priced = rest.filter((q) => q.ok).sort((a, b) => (sell ? b.netUsd - a.netUsd : a.netUsd - b.netUsd));
    const others = [...priced.map((q) => `${q.name} ${sell ? "nets" : "costs"} ${cents(q.netUsd)} (${cents(Math.abs(best.netUsd - q.netUsd))} ${sell ? "less" : "more"})`), ...rest.filter((q) => !q.ok).map((q) => `${q.name} ${q.why ?? "cannot take it"}`)];
    const richer = split.richer ? ` A split across ${split.richer.slices.map((s) => s.name).join(" + ")} would ${sell ? "add" : "save"} only ${cents(split.richer.gainUsd)}, under ${cents(EXTRA_LEG_MIN_GAIN_USD)}.` : "";
    out.narration =
      split.quotes.length > 1
        ? `${title}: compared at ${split.quotes.length} venues; ${best.name} ${sell ? "nets the most" : "costs the least"} (${cents(best.netUsd)}). One venue can take it, so no split.${richer}`
        : `${title}: ${best.name} is the only venue for it (${sell ? "net" : "cost"} ${cents(best.netUsd)}).`;
    out.steps = [stepOf(best, others.length ? `Compared: ${others.join("; ")}` : undefined)];
  } else {
    const n = split.slices.length;
    const haves = split.quotes.filter((q) => q.have > 0).map((q) => `${q.name} ${sell ? qtyText(q.have) : money(q.have)}`).join(" · ");
    out.narration = split.single
      ? `${title}: the best single venue is ${split.single.name} (${sell ? "net" : "cost"} ${cents(split.single.netUsd)}); split into ${n} slices it ${sell ? "nets" : "costs"} ${cents(split.netUsd)}, ${cents(split.gainUsd ?? 0)} ${sell ? "more" : "less"}.`
      : `${title}: no single venue ${sell ? "holds that much" : "has the cash for it"} (${haves}). Split into ${n} slices: average ${price(split.avgPrice)}, ${sell ? "net" : "cost"} ${cents(split.netUsd)}.`;
    out.steps = split.slices.map((s) => stepOf(s));
    out.parts = split.slices.map((s) => ({ label: `${s.name} ${qtyText(s.qty)}`, pct: Math.round((s.qty / qty) * 100), kind: s.kind }));
    const compared = split.passed.map((p) => (sell ? `${p.name}'s ${qtyText(p.have)} ${unit} stays put: ${p.gasUsd !== undefined && p.gasUsd >= 1 ? `one swap costs ${cents(p.gasUsd)} in gas, so ` : ""}using it would net ${cents(-p.deltaUsd)} less` : `${p.name} is left out: using it would cost ${cents(-p.deltaUsd)} more`));
    // a richer split exists but its extra leg earns less than the threshold: say so, and say what it was
    if (split.richer) compared.unshift(`one more slice (${mixOf(split.richer.slices)}) would ${sell ? "add" : "save"} only ${cents(split.richer.gainUsd)}, under ${cents(EXTRA_LEG_MIN_GAIN_USD)}: not worth another leg`);
    if (compared.length) out.notes.push(`Compared: ${compared.join("; ")}.`);
  }

  if (ev) {
    // what the position is, and the catch of holding one question at two venues
    const venues = [...new Set(split.slices.map((s) => s.venue))];
    if (!sell) out.after.push(`Each share pays $1 if this resolves ${ev.outcome} (closes ${ev.event.closesAt.slice(0, 10)}), $0 if not; until then it can be sold back at the bid.`);
    else out.after.push(`Proceeds: ${split.slices.map((s) => `${s.quote} at ${s.name}`).join(", ")}.`);
    if (venues.length > 1) out.after.push(`${venues.map((v) => `${PREDICTION_VENUES[v]?.name ?? v} settles by ${ev.event.listings[v]?.rules ?? "its own rules"}`).join(", ")}: the same question can resolve differently at each.`);
    return out;
  }

  // where the proceeds are: stuck at a CEX whose key cannot withdraw, or on-chain and free to move
  if (sell) {
    const stuck = split.slices.filter((s) => s.kind === "cex" && !accounts.find((a) => a.id === s.account)?.reach.includes("move"));
    const onchain = split.slices.filter((s) => s.kind === "dex");
    if (split.slices.length === 1) {
      if (stuck[0]) out.after.push(`The ${stuck[0].quote} stays at ${stuck[0].name}: this key cannot withdraw, so it is stuck there.`);
      else if (onchain[0]) out.after.push(`The ${onchain[0].quote} is on ${onchain[0].chain}, free to move.`);
    } else {
      const where: string[] = [];
      if (stuck.length) where.push(`${stuck[0]!.quote} stays at ${stuck.map((s) => s.name).join(" and ")} (keys cannot withdraw)`);
      if (onchain.length) where.push(`the DEX slice's ${onchain[0]!.quote} is on ${onchain.map((s) => s.chain).join(" and ")}, free to move`);
      if (where.length) out.after.push(`Proceeds: ${where.join("; ")}.`);
    }
  }
  return out;
}
