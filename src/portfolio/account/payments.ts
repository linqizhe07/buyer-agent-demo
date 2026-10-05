/** A payment and its life.
 *
 * Before this file a transfer was credited in the same call that sent it: time
 * was shown and never passed. Here money that has left one place and not yet
 * reached the next is IN FLIGHT — it is in no balance, nothing can spend it —
 * and each leg of a route lands when its rail says it does: seconds for a
 * chain, a bank day for an ACH.
 *
 *   authorized  approved, nothing has left yet (a card is waiting)
 *   pending     in flight; the leg that is flying says where
 *   settled     the last leg landed
 *   failed      refused before anything left: nothing moved
 *   stranded    a later leg was refused after an earlier one landed: the money
 *               is still the user's, sitting at the hub, and the payment says
 *               where and how to bring it back
 *   returned    the other side sent it back — which can happen AFTER settled
 *               (an ACH can be returned for weeks)
 *   unknown     the venue did not answer; reconcile decides
 *
 * A leg starts when the one before it lands, at THAT instant (not at whatever
 * time someone happened to look), so a route's arrival does not drift with
 * how often the clock is read. Every credit happens exactly once.
 */
import { isRefusal, type Refusal } from "../../core/errors.ts";
import { no } from "../refuse.ts";
import { chainIdOf, r2, type AccountAdapter } from "../accounts.ts";
import { achArrival } from "./calendar.ts";
import { nativeRequest, type Leg, type Route } from "./doors.ts";
import type { Hex } from "./sign.ts";

export type PaymentStatus = "authorized" | "pending" | "settled" | "failed" | "stranded" | "returned" | "unknown";
export type PaymentKind = "deposit" | "withdraw" | "transfer" | "send" | "swap" | "pay" | "refill";
export type Authority = "owner" | "agent" | "venue";

export interface PaymentLeg extends Leg {
  status: "waiting" | "pending" | "settled" | "failed";
  startedAt?: string | undefined;
  settlesAt?: string | undefined;
  /** the venue's own reference for this leg */
  ref?: string | undefined;
  /** the venue's own request, as it would be sent */
  native?: unknown;
  /** why it failed, in the venue's code */
  code?: string | undefined;
}

export interface Payment {
  id: string;
  kind: PaymentKind;
  at: string;
  from: string;
  to: string;
  /** a third party, when the money leaves the user's own venues */
  external?: { label: string; address: string; chain: string } | undefined;
  sourceToken: string;
  token: string;
  amountUsd: number;
  feeUsd: number;
  /** what the destination is credited */
  receiveUsd: number;
  legs: PaymentLeg[];
  status: PaymentStatus;
  /** when the last leg is due to land */
  settlesAt: string;
  settledAt?: string | undefined;
  /** whose signature moved it, and by what authority */
  signer: string;
  authority: Authority;
  agent?: string | undefined;
  flight?: string | undefined;
  /** the signed instruction this payment is the execution of */
  action?: Hex | undefined;
  approval?: string | undefined;
  card?: string | undefined;
  protocol?: string | undefined;
  /** a payment session's deposit: what of it is still the user's while the session is open */
  heldUsd?: number | undefined;
  /** where the money is while it is not at its destination, and what to do about it */
  note?: string | undefined;
}

export interface Money {
  adapter(id: string): AccountAdapter | undefined;
  /** the address of the hub wallet on a chain, as the venues know it */
  hub: string;
}

const HUB = "metamask";
const iso = (ms: number) => new Date(ms).toISOString();

export function newPayment(id: string, kind: PaymentKind, route: Route, at: string, who: { signer: string; authority: Authority; agent?: string | undefined; flight?: string | undefined; action?: Hex | undefined; approval?: string | undefined; card?: string | undefined; external?: Payment["external"] }): Payment {
  return {
    id,
    kind,
    at,
    from: route.from,
    to: route.to,
    ...(who.external ? { external: who.external } : {}),
    sourceToken: route.sourceToken,
    token: route.token,
    amountUsd: route.amountUsd,
    feeUsd: route.feeUsd,
    receiveUsd: route.receiveUsd,
    legs: route.legs.map((l) => ({ ...l, status: "waiting" as const })),
    status: "pending",
    settlesAt: iso(route.arrivalMs),
    signer: who.signer,
    authority: who.authority,
    ...(who.agent ? { agent: who.agent } : {}),
    ...(who.flight ? { flight: who.flight } : {}),
    ...(who.action ? { action: who.action } : {}),
    ...(who.approval ? { approval: who.approval } : {}),
    ...(who.card ? { card: who.card } : {}),
  };
}

/** what is in flight when leg `i` starts: the amount, less every fee taken before it */
function carried(p: Payment, i: number): number {
  return r2(p.amountUsd - p.legs.slice(0, i).reduce((s, l) => s + l.feeUsd, 0));
}

const failLeg = (leg: PaymentLeg, r: Refusal): Refusal => {
  leg.status = "failed";
  leg.code = r.code;
  return r;
};

/** Start leg `i` at `atMs`: do what the venue does when the money leaves (or is swapped, or is moved inside), and set when the leg lands. */
async function startLeg(p: Payment, i: number, atMs: number, m: Money): Promise<Refusal | null> {
  const leg = p.legs[i]!;
  const amount = carried(p, i);
  const a = m.adapter(leg.venue);
  if (!a) return failLeg(leg, no("E_WALLET_ACCOUNT_UNKNOWN", { venue: leg.venue }));
  const next = p.legs[i + 1];
  // where an `out` leg sends the money: a venue's way out lands in the hub; the hub's own leg goes to the next venue's door, or to the third party
  // (a float's address is on the wallet's own allowlist under one label, `floats`: the owner put it there when the sub-account was made)
  const to = leg.step !== "out" ? p.to : leg.venue !== HUB ? HUB : next ? (m.adapter(next.venue)?.account.address ?? next.venue) : (p.external?.address ?? (p.to.startsWith("sub:") ? "floats" : p.to));
  // an agent's leg always goes through the credential the account holds, so the venue's own second line answers (a permission, a whitelist,
  // the wallet's Guard). The owner's leg does too at a venue that only knows that credential; at the owner's own wallet, and at a venue that
  // takes the owner's signature itself (Hyperliquid), it is the owner's own action
  const viaCredential = p.authority === "agent" || (leg.access === "agent" && leg.venue !== HUB);
  leg.startedAt = iso(atMs);
  // whom the venue's own request names: the hub's own transfer names its target; a venue's way in and its inside moves name the account there; a
  // venue's way out names the hub
  const names = leg.venue === HUB && leg.step === "out" ? to : leg.step === "in" || leg.step === "shift" || leg.step === "swap" ? (a.account.address ?? leg.venue) : m.hub;
  leg.native = nativeRequest(leg, { amount: String(amount), to: names, nowMs: atMs, account: p.id, from: p.sourceToken, authority: p.authority, connector: a.account.connector, kind: a.account.kind });
  const lands = (ms: number) => void (leg.settlesAt = iso(ms));
  switch (leg.step) {
    case "swap": {
      const r = a.convert?.(p.sourceToken, leg.token, amount) ?? no("E_VENUE_CURRENCY", { venue: leg.venue, message: `${a.account.name} cannot swap here` });
      if (isRefusal(r)) return failLeg(leg, r);
      leg.ref = r.ref;
      leg.feeUsd = r.feeUsd ?? leg.feeUsd;
      lands(atMs);
      return null;
    }
    case "shift": {
      const r = a.shift?.(leg.token, amount, leg.fromLedger ?? "", leg.toLedger ?? "") ?? no("E_VENUE_RAIL_CLOSED", { venue: leg.venue });
      if (isRefusal(r)) return failLeg(leg, r);
      leg.ref = r.ref;
      lands(atMs);
      return null;
    }
    case "venue": {
      // the account holder at the venue's own page. The bank is the other side of the ACH: it is debited when the pull is made, credited when the payout lands
      const inbound = leg.venue === p.to;
      const bank = m.adapter(inbound ? p.from : p.to);
      if (inbound) {
        const d = bank?.debit?.("USD", amount) ?? no("E_VENUE_RAIL_CLOSED", { venue: p.from });
        if (isRefusal(d)) return failLeg(leg, d);
      }
      const r = a.startAtVenue?.(inbound ? "in" : "out", "USD", amount) ?? no("E_VENUE_RAIL_CLOSED", { venue: leg.venue });
      if (isRefusal(r)) {
        if (inbound) bank?.credit?.("USD", amount);
        return failLeg(leg, r);
      }
      leg.ref = r.ref;
      leg.native = r.native ?? leg.native;
      lands(r.settlesAt ? Date.parse(r.settlesAt) : achArrival(atMs));
      return null;
    }
    case "out": {
      if (viaCredential) {
        const r = await a.execute({ kind: "move", asset: leg.token, amount, to, ...(leg.chain && chainIdOf(leg.chain) !== undefined ? { fromChainId: chainIdOf(leg.chain), chainId: chainIdOf(leg.chain) } : {}) });
        if (isRefusal(r)) return failLeg(leg, r);
        if (r.status === "pending") return failLeg(leg, no("E_VENUE_RAIL_CLOSED", { venue: leg.venue, message: `${a.account.name} is holding this for the owner's own confirmation (${String((r.native as { status?: string } | undefined)?.status ?? "pending")}): nothing left`, native: r.native }));
        leg.ref = r.ref;
      } else {
        const r = a.debit?.(leg.token, amount, a.account.kind === "agent-wallet" ? leg.chain : leg.fromLedger) ?? no("E_VENUE_RAIL_CLOSED", { venue: leg.venue, message: `${a.account.name}: a withdrawal starts at the venue itself` });
        if (isRefusal(r)) return failLeg(leg, r);
        leg.ref = r.ref;
      }
      lands(atMs + leg.etaSec * 1000);
      return null;
    }
    case "bridge": {
      // the wallet, chain to chain: it leaves the first chain now and is on neither until it lands
      const from = /: (\w+) → /.exec(leg.protocol)?.[1];
      const r = viaCredential ? await a.execute({ kind: "move", asset: leg.token, amount, to: "wallet-main", ...(from && chainIdOf(from) !== undefined ? { fromChainId: chainIdOf(from), chainId: chainIdOf(from) } : {}) }) : (a.debit?.(leg.token, amount, from) ?? no("E_VENUE_RAIL_CLOSED", { venue: leg.venue }));
      if (isRefusal(r)) return failLeg(leg, r);
      if ("status" in r && r.status === "pending") return failLeg(leg, no("E_VENUE_RAIL_CLOSED", { venue: leg.venue, message: `${a.account.name} is holding this for the owner's own confirmation: nothing left`, native: r.native }));
      leg.ref = r.ref;
      lands(atMs + leg.etaSec * 1000);
      return null;
    }
    case "in":
      lands(atMs + leg.etaSec * 1000);
      return null;
  }
}

/** Leg `i` has landed: put the money where it now is. Each leg lands once. */
function landLeg(p: Payment, i: number, m: Money): void {
  const leg = p.legs[i]!;
  if (leg.status !== "pending") return;
  leg.status = "settled";
  const after = r2(carried(p, i) - leg.feeUsd);
  const next = p.legs[i + 1];
  const hub = m.adapter(HUB);
  if (leg.step === "in") m.adapter(leg.venue)?.credit?.(leg.token, after, leg.toLedger ?? (m.adapter(leg.venue)?.account.kind === "agent-wallet" ? leg.chain : undefined));
  else if (leg.step === "bridge") hub?.credit?.(leg.token, after, leg.chain);
  else if (leg.step === "out" && leg.venue !== HUB && (!next || next.venue === HUB)) hub?.credit?.(leg.token, after, leg.chain);
  else if (leg.step === "venue") m.adapter(p.to)?.credit?.("USD", after);
}

export interface Advance {
  payment: Payment;
  /** what happened: a leg started, a leg landed, the payment settled, failed or stranded */
  event: "started" | "landed" | "settled" | "failed" | "stranded";
  leg?: PaymentLeg | undefined;
  refusal?: Refusal | undefined;
}

/** Fly a new payment's first leg. If the venue refuses it, nothing has moved and the payment has failed. */
export async function launch(p: Payment, nowMs: number, m: Money): Promise<Advance[]> {
  const out: Advance[] = [];
  const r = await startLeg(p, 0, nowMs, m);
  if (r) {
    p.status = "failed";
    return [{ payment: p, event: "failed", leg: p.legs[0], refusal: r }];
  }
  p.legs[0]!.status = "pending";
  out.push({ payment: p, event: "started", leg: p.legs[0] });
  out.push(...(await settleDue([p], nowMs, m)));
  return out;
}

/** Land every leg that is due and start the one after it, at the instant the previous one landed. */
export async function settleDue(payments: Payment[], nowMs: number, m: Money): Promise<Advance[]> {
  const out: Advance[] = [];
  for (const p of payments) {
    // a payment session's deposit is not on a clock: it comes back when the session is closed (payees.ts)
    if (p.status !== "pending" || p.heldUsd !== undefined) continue;
    for (;;) {
      const i = p.legs.findIndex((l) => l.status === "pending");
      if (i < 0) break;
      const leg = p.legs[i]!;
      const due = Date.parse(leg.settlesAt!);
      if (nowMs < due) break;
      landLeg(p, i, m);
      out.push({ payment: p, event: "landed", leg });
      if (i === p.legs.length - 1) {
        p.status = "settled";
        p.settledAt = leg.settlesAt;
        out.push({ payment: p, event: "settled" });
        break;
      }
      const r = await startLeg(p, i + 1, due, m);
      if (r) {
        // the money already left the source and is sitting at the hub: it is the user's, and it is not where it was sent
        p.status = "stranded";
        const where = p.legs[i]!;
        p.note = `${where.token} is in the wallet${where.chain ? ` on ${where.chain}` : ""}: ${r.message}. It has not reached ${p.to}; move it on or back from the wallet.`;
        out.push({ payment: p, event: "stranded", leg: p.legs[i + 1], refusal: r });
        break;
      }
      p.legs[i + 1]!.status = "pending";
      out.push({ payment: p, event: "started", leg: p.legs[i + 1] });
    }
  }
  return out;
}

/** The other side sent it back (an ACH return): undo the credit, give the source its money back. Possible after `settled`. */
export function returnPayment(p: Payment, code: string, description: string, m: Money): Refusal | null {
  if (p.status !== "settled" && p.status !== "pending") return no("E_ACCOUNT_BAD_ACTION", { message: `payment ${p.id} is ${p.status}: there is nothing to return` });
  const last = p.legs[p.legs.length - 1]!;
  if (last.final) return no("E_ACCOUNT_BAD_ACTION", { message: `payment ${p.id} travelled on a final rail (${last.protocol}): it cannot come back` });
  if (p.status === "settled") {
    const d = m.adapter(p.to)?.debit?.(p.token, p.receiveUsd);
    if (!d || isRefusal(d)) return no("E_VENUE_RETURNED", { venue: p.to, message: `the return of ${p.id} could not be taken back from ${p.to}: the money was already used there`, native: { return_code: code } });
  }
  m.adapter(p.from)?.credit?.(p.sourceToken, p.amountUsd);
  for (const l of p.legs) if (l.status === "pending") l.status = "failed";
  p.status = "returned";
  p.note = `returned by the bank: ${code} ${description}`;
  return null;
}

/** money that has left somewhere and is not anywhere yet */
export function inFlightUsd(payments: Payment[]): number {
  return r2(payments.filter((p) => p.status === "pending" && p.heldUsd === undefined).reduce((s, p) => s + p.amountUsd - p.legs.filter((l) => l.status === "settled").reduce((f, l) => f + l.feeUsd, 0), 0));
}

/** what open payment sessions hold in escrow that is still the user's */
export function heldUsd(payments: Payment[]): number {
  return r2(payments.filter((p) => p.status === "pending").reduce((s, p) => s + (p.heldUsd ?? 0), 0));
}
