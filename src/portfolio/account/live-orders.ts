/** ORDERS at venues connected live: the account's door for trading with the user's own money, at the user's own venues.
 *
 * This is what lets an agent take off. An order is ONE venue call — an exchange's order, a broker's, a prediction market's, a DEX swap the
 * user's wallet sends — and it is placed only when all of this holds:
 *
 *   1. the server moves real money (it does unless it was started `--read-only`);
 *   2. the market is priced in dollars, is open, and the venue takes the order as written (its smallest size, its steps, its order types);
 *   3. it is worth no more than the most one order may be on this server (`--live-cap`), valued at the price the venue shows now — a market
 *      buy with room for the price to move (2%);
 *   4. the OWNER signed it — the exact size, the limit price, the most it may be worth and ten minutes — or an AGENT asked inside the trading
 *      limit the owner signed for it (which venues, how much an order, how much in all, until when). Conservative mode: the agent's order is a
 *      card the owner signs, every time. Aggressive: inside its limit it is placed at once;
 *   5. the venue itself agrees: its own key permissions, balances, risk checks and region rules still apply, and its refusal is the answer.
 *
 * Trading moves money between what the user holds AT ONE VENUE (dollars into BTC, shares into cash); nothing leaves the venue by an order.
 * Withdrawals stay where they were: the owner's signature, to the user's own places only (live-moves.ts). An agent can cancel the orders it
 * placed, in either mode — taking an order off the book never needs a card. The owner can cancel any.
 */
import { keccak256, stringToHex, type Hex } from "viem";
import { isRefusal, type Refusal } from "../../core/errors.ts";
import { canonical } from "../../core/hash.ts";
import { no } from "../refuse.ts";
import type { Intent } from "../accounts.ts";
import { DONE, floorTo, inDollars, notionalOf, onStep, plain, type LiveTrader, type Market, type MarketKind, type OrderState, type OrderStatus, type OrderType, type Side } from "../live/trade.ts";
import type { CardLike, Outcome } from "./exchange.ts";
import type { LiveEngine, LiveVenue } from "./live-moves.ts";
import { micro, type AgentAction, type Envelope, type OwnerAction } from "./sign.ts";
import { covers, spendFor, type AgentKey } from "./state.ts";

export type LiveOrderAction = Extract<OwnerAction, { type: "liveOrder" }>;
export type LiveCancelAction = Extract<OwnerAction, { type: "liveCancel" }>;
export type AgentLiveOrderAction = Extract<AgentAction, { type: "agentLiveOrder" }>;
export type AgentLiveCancelAction = Extract<AgentAction, { type: "agentLiveCancel" }>;

/** one order the account placed, as the page, the ledger and an agent see it */
export interface LiveOrder {
  /** the account's id: `ord-0001`. It is also the venue's client id, so a retry is the same order */
  id: string;
  at: string;
  venue: string;
  venueName: string;
  symbol: string;
  name: string;
  kind: MarketKind;
  base: string;
  side: Side;
  type: OrderType;
  /** in base units */
  qty: number;
  limitPrice?: number | undefined;
  /** the price it was valued at when it was placed, and what it was worth then in dollars (the most, for a market buy) */
  price: number;
  usd: number;
  status: OrderStatus;
  filledQty: number;
  avgPrice?: number | undefined;
  feeUsd?: number | undefined;
  /** the venue's own id */
  ref: string;
  signer: string;
  authority: "owner" | "agent";
  agent?: string | undefined;
  card?: string | undefined;
  /** the trading limit this order counts against */
  approval?: string | undefined;
  action?: Hex | undefined;
  note: string;
  updatedAt: string;
  native: unknown;
  /** from a wallet: the transactions the wallet is asked to send, in order */
  walletTxs?: OrderState["walletTxs"];
}

/** what this door uses of the engine, besides what the money door uses */
export interface OrderEngine extends LiveEngine {
  orders: LiveOrder[];
  nextOrderId(): string;
}

interface Fields {
  venue: string;
  symbol: string;
  side: string;
  orderType: string;
  qty: string;
  usd: string;
  limitPrice: string;
}

interface Plan {
  f: Fields;
  v: LiveVenue & { trader: LiveTrader };
  m: Market;
  side: Side;
  type: OrderType;
  qty: number;
  limitPrice?: number | undefined;
  /** the price it is valued at: the limit, or the side of the book it takes */
  price: number;
  notional: number;
  /** the most it may be worth: a market buy has room for the price to move */
  maxUsd: number;
}

const TTL_MS = 10 * 60_000;
const POLL_MS = 10_000;
/** how far the price may move against a market buy between the look and the fill, as far as the limits are concerned */
export const SLIPPAGE = 0.02;
const DEC = /^\d+(\.\d{1,12})?$/;
const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const qtyText = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 8 });

export class LiveOrders {
  private readonly polled = new Map<string, number>();
  constructor(private readonly e: OrderEngine) {}

  private money() {
    return this.e.host.liveMoney?.();
  }

  /** Everything that does not depend on who signed: the switch, the venue, the market, the size, the price, the cap */
  private async plan(f: Fields): Promise<Plan | Refusal> {
    const m = this.money();
    if (!m) return no("E_ACCOUNT_BAD_ACTION", { message: "this account has no venues connected live" });
    const w = m.writes();
    if (!w.on) return no("E_WALLET_LIVE_WRITES_OFF", { message: `this server places no orders: it was started read-only. To trade, stop it and start it again with: ${w.turnOn}`, detail: { turnOn: w.turnOn } });
    const v = m.venue(f.venue);
    if (!v) return no("E_WALLET_ACCOUNT_UNKNOWN", { venue: f.venue, message: `"${f.venue}" is not a venue connected live: orders are placed only at venues connected live` });
    if (!v.trader) return no("E_VENUE_RAIL_CLOSED", { venue: v.id, message: `${v.name}: ${v.noTradeBecause ?? "no orders are placed here from the account"}` });
    if (v.address !== undefined && !v.proven) return no("E_VENUE_RAIL_CLOSED", { venue: v.id, message: `${v.name} is watched, not proven yours: nothing is traded from it here. Connect it again from the wallet itself` });
    const trader = v.trader;
    if (trader.can === false) return no("E_VENUE_PERMISSION", { venue: v.id, message: `${v.name}: this key may not trade. That is set on the key at the venue` });
    if (f.side !== "buy" && f.side !== "sell") return no("E_ACCOUNT_BAD_ACTION", { message: "an order's side is buy or sell" });
    if (f.orderType !== "market" && f.orderType !== "limit") return no("E_ACCOUNT_BAD_ACTION", { message: "an order is a market order or a limit order" });
    const side = f.side as Side;
    const type = f.orderType as OrderType;
    const byQty = f.qty.trim() !== "";
    const byUsd = f.usd.trim() !== "";
    if (byQty === byUsd) return no("E_ACCOUNT_BAD_ACTION", { message: "an order's size is given once: in the market's own units (qty) or in dollars (usd)" });
    const size = byQty ? f.qty.trim() : f.usd.trim();
    if (!DEC.test(size) || !(Number(size) > 0)) return no("E_ACCOUNT_BAD_ACTION", { message: "a size is a plain decimal, more than zero" });
    if (type === "limit" ? !DEC.test(f.limitPrice.trim()) || !(Number(f.limitPrice) > 0) : f.limitPrice.trim() !== "") return no("E_ACCOUNT_BAD_ACTION", { message: type === "limit" ? "a limit order has a limit price: a plain decimal, more than zero" : "a market order has no limit price" });
    if (!f.symbol.trim()) return no("E_ACCOUNT_BAD_ACTION", { message: "an order names its market" });

    const mk = await trader.market(f.symbol.trim());
    if (isRefusal(mk)) return mk;
    if (!inDollars(mk.quote)) return no("E_ACCOUNT_UNPRICED", { venue: v.id, message: `${mk.symbol} is priced in ${mk.quote}: the account trades markets priced in dollars, so that every limit means dollars` });
    if (!mk.open) return no("E_VENUE_MARKET_CLOSED", { venue: v.id, message: `${v.name}: ${mk.name} takes no orders now${mk.note ? ` (${mk.note})` : ""}` });
    if (!mk.types.includes(type)) return no("E_VENUE_ORDER_INVALID", { venue: v.id, message: `${v.name} takes ${mk.types.join(" and ")} orders in ${mk.name}, not ${type} orders` });
    const limitPrice = type === "limit" ? Number(f.limitPrice) : undefined;
    if (limitPrice !== undefined && !onStep(limitPrice, mk.priceStep)) return no("E_VENUE_ORDER_INVALID", { venue: v.id, message: `${v.name}: a price in ${mk.name} moves in steps of ${plain(mk.priceStep!)}`, detail: { priceStep: mk.priceStep } });
    const book = side === "buy" ? (mk.ask ?? mk.price) : (mk.bid ?? mk.price);
    const price = limitPrice ?? book;
    if (!(price !== undefined && price > 0)) return no("E_ACCOUNT_UNPRICED", { venue: v.id, message: `${v.name} shows no price for ${mk.name} right now, so no limit can be judged: try a limit order` });
    const each = notionalOf(mk, 1, price);
    let qty: number;
    if (byQty) {
      qty = Number(size);
      if (!onStep(qty, mk.qtyStep)) return no("E_VENUE_ORDER_INVALID", { venue: v.id, message: `${v.name}: a size in ${mk.name} moves in steps of ${plain(mk.qtyStep!)} ${mk.base}`, detail: { qtyStep: mk.qtyStep } });
    } else qty = floorTo(Number(size) / each, mk.qtyStep);
    if (!(qty > 0) || (mk.minQty !== undefined && qty < mk.minQty - 1e-12)) return no("E_VENUE_ORDER_INVALID", { venue: v.id, message: `${v.name}: the smallest order in ${mk.name} is ${plain(mk.minQty ?? mk.qtyStep ?? 0)} ${mk.base}${byUsd ? ` (${usd((mk.minQty ?? mk.qtyStep ?? 0) * each)} at ${plain(price)})` : ""}`, detail: { minQty: mk.minQty, qtyStep: mk.qtyStep } });
    const notional = notionalOf(mk, qty, price);
    if (mk.minNotional !== undefined && notional < mk.minNotional - 1e-9) return no("E_VENUE_ORDER_INVALID", { venue: v.id, message: `${v.name}: the smallest order in ${mk.name} is worth ${usd(mk.minNotional)}`, detail: { minNotional: mk.minNotional } });
    const maxUsd = type === "market" && side === "buy" ? notional * (1 + SLIPPAGE) : notional;
    if (maxUsd > w.capUsd + 1e-9) return no("E_ACCOUNT_LIMIT", { venue: v.id, message: `${usd(maxUsd)} is more than the most one order may be on this server (${usd(w.capUsd)}). It is set when the server starts: --live-cap`, detail: { capUsd: w.capUsd, orderUsd: maxUsd } });
    return { f, v: v as Plan["v"], m: mk, side, type, qty, limitPrice, price, notional, maxUsd };
  }

  /** what the owner is shown and signs: the exact size, the price, the most it may be worth, ten minutes */
  async prepare(draft: Record<string, unknown>): Promise<{ action: Omit<LiveOrderAction, "nonce">; quote: OrderQuote } | Refusal> {
    const f: Fields = { venue: String(draft.venue ?? ""), symbol: String(draft.symbol ?? ""), side: String(draft.side ?? ""), orderType: String(draft.orderType ?? "market"), qty: String(draft.qty ?? ""), usd: String(draft.usd ?? ""), limitPrice: String(draft.limitPrice ?? "") };
    const p = await this.plan(f);
    if (isRefusal(p)) return p;
    const maxNotional = (Math.ceil(p.maxUsd * 100) / 100).toFixed(2);
    return {
      action: { type: "liveOrder", venue: p.v.id, symbol: p.m.symbol, side: p.side, orderType: p.type, qty: plain(p.qty), limitPrice: p.limitPrice !== undefined ? plain(p.limitPrice) : "", maxNotional, deadline: this.money()!.realNow() + TTL_MS },
      quote: { words: this.words(p), name: p.m.name, kind: p.m.kind, base: p.m.base, quote: p.m.quote, price: p.price, notionalUsd: Number(p.notional.toFixed(2)), maxUsd: Number(maxNotional), ...(p.m.note ? { note: p.m.note } : {}), capUsd: this.money()!.writes().capUsd },
    };
  }

  /** The owner's signed order: planned again, held to what was signed, placed */
  async owner(a: LiveOrderAction, who: { signer: string; hash: Hex }): Promise<Outcome> {
    const p = await this.plan({ ...a, usd: "" });
    if (isRefusal(p)) return p;
    if (this.money()!.realNow() > a.deadline) return no("E_ACCOUNT_EXPIRED", { message: "this order was good for ten minutes after it was prepared: prepare it again" });
    if (p.m.symbol !== a.symbol) return no("E_ACCOUNT_REQUOTE", { venue: p.v.id, message: `${p.v.name} now calls this market ${p.m.symbol}, not ${a.symbol}: prepare it again` });
    if (p.notional > Number(a.maxNotional) + 1e-9) return this.moved(p, Number(a.maxNotional), "signed for");
    return this.run(p, { signer: who.signer, authority: "owner", action: who.hash });
  }

  /** the price moved past what was agreed: nothing is placed */
  private moved(p: Plan, max: number, what: string): Refusal {
    return no("E_ACCOUNT_REQUOTE", { venue: p.v.id, message: `the price moved: at ${plain(p.price)} the order is worth ${usd(p.notional)} now, more than the ${usd(max)} ${what}. Nothing was placed`, detail: { price: p.price, notionalUsd: p.notional, maxUsd: max } });
  }

  /** An agent's order. Its trading limit first; then Conservative: a card the owner signs; Aggressive: placed at once */
  async agent(a: AgentLiveOrderAction, who: { signer: string; envelope: Envelope; hash: Hex; agent: AgentKey }): Promise<Outcome> {
    const now = Date.parse(this.e.host.now());
    const spend = spendFor(this.e.state, who.signer, "trade", now);
    if (isRefusal(spend)) return spend;
    if (!spend.allow.includes(a.venue)) return covers(spend, a.venue, 0, now)!;
    const p = await this.plan(a);
    if (isRefusal(p)) return p;
    const amountMicro = micro(p.maxUsd.toFixed(6));
    const c = covers(spend, p.v.id, amountMicro, now);
    if (c) return c;
    const flight = this.e.host.openFlight({ id: slug(who.agent.name), name: who.agent.name, code: who.agent.code }, `${this.words(p)} · real money`);
    if (this.e.host.policy().mode === "open") {
      // counted first: an order that fills at once gives back what it did not use as soon as it is placed
      this.e.patchSpend(spend.id, (x) => ({ ...x, spentMicro: x.spentMicro + amountMicro }));
      const out = await this.run(p, { signer: who.signer, authority: "agent", agent: who.agent.address, action: who.hash, approval: spend.id });
      if (isRefusal(out)) {
        this.e.patchSpend(spend.id, (x) => ({ ...x, spentMicro: Math.max(0, x.spentMicro - amountMicro) }));
        return out;
      }
      this.e.host.log({ kind: "action", venue: p.v.id, tool: a.type, signer: who.signer, envelope: who.envelope, outcome: "accepted", notionalUsd: p.maxUsd, reason: `aggressive mode: ${this.words(p)}, inside the trading limit`, flight: flight.no });
      this.e.host.say(flight.no, `${who.agent.name} ${this.words(p)}: inside its limit, so it went without a card (Aggressive)`, "ok");
      return { ...out, flight: flight.no } as Outcome;
    }
    const offer = { payee: p.v.name, payTo: p.m.symbol, amount: `${p.side} ${qtyText(p.qty)} ${p.m.base}`, protocol: `real order · ${p.type}${p.limitPrice !== undefined ? ` at ${plain(p.limitPrice)}` : ` near ${plain(p.price)}`}`, network: `worth up to ${usd(p.maxUsd)}` };
    // the owner's answer signs the card's hash: it covers the agent's request AND the size, price and worth the owner is shown
    const actionHash = keccak256(stringToHex(canonical({ action: who.hash, offer, qty: plain(p.qty), maxUsd: p.maxUsd.toFixed(6) })));
    const intent: Intent = { kind: "trade", symbol: p.m.symbol, side: p.side, qty: p.qty };
    const card = this.e.host.raiseCard(flight.no, { account: p.v.id, intent, usd: Math.ceil(p.maxUsd * 100) / 100, reason: `${who.agent.name} asks to ${this.words(p)}`, why: "live", action: a, actionHash, signer: who.signer, expiresAt: new Date(now + 30 * 60_000).toISOString(), offer, approval: spend.id });
    this.e.patchSpend(spend.id, (x) => ({ ...x, reservedMicro: x.reservedMicro + amountMicro }));
    this.e.host.log({ kind: "action", venue: p.v.id, tool: a.type, signer: who.signer, envelope: who.envelope, outcome: "card", notionalUsd: p.maxUsd, reason: `${card.id} · ${this.words(p)}`, flight: flight.no, intentId: card.id });
    return { ok: true, kind: "card", pending: true, card, flight: flight.no };
  }

  /** the owner approved an agent's order: planned again, held to the worth on the card, placed, counted against the limit */
  async release(card: CardLike, who: { signer: string; agent: AgentKey }): Promise<Outcome> {
    const a = card.action as AgentLiveOrderAction;
    const p = await this.plan(a);
    if (isRefusal(p)) return p;
    if (p.notional > card.usd + 1e-9) return this.moved(p, card.usd, "on the card");
    const amountMicro = micro(p.maxUsd.toFixed(6));
    if (card.approval) this.e.patchSpend(card.approval, (x) => ({ ...x, spentMicro: x.spentMicro + amountMicro }));
    const out = await this.run(p, { signer: who.signer, authority: "agent", agent: who.agent.address, card: card.id, action: card.actionHash, approval: card.approval });
    if (isRefusal(out) && card.approval) this.e.patchSpend(card.approval, (x) => ({ ...x, spentMicro: Math.max(0, x.spentMicro - amountMicro) }));
    return out;
  }

  /** cancel: the owner any open order, an agent only one it placed itself. Never a card: taking an order off the book moves nothing */
  async cancel(a: { venue: string; order: string }, who: { signer: string; authority: "owner" | "agent"; agent?: AgentKey | undefined; envelope: Envelope }): Promise<Outcome> {
    const o = this.e.orders.find((x) => x.id === a.order && x.venue === a.venue);
    const mine = o && (who.authority === "owner" || (o.authority === "agent" && o.agent === who.agent?.address));
    if (!o || !mine) return no("E_ACCOUNT_ORDER_UNKNOWN", { venue: a.venue, message: who.authority === "agent" && o ? `${a.order} was not placed by this agent: an agent cancels only its own orders` : `there is no order ${a.order} at ${a.venue} on the account`, detail: { order: a.order } });
    if (DONE.has(o.status)) return no("E_ACCOUNT_BAD_ACTION", { venue: o.venue, message: `${o.id} is already ${o.status}`, detail: { order: o.id, status: o.status } });
    const v = this.money()?.venue(o.venue);
    // a wallet's order the wallet never sent: there is nothing at a venue to take back
    if (o.walletTxs && !o.ref) {
      this.apply(o, { ref: "", status: "canceled", filledQty: 0, native: { canceled: "before the wallet sent it" } }, "canceled before your wallet sent it");
    } else {
      if (!v?.trader) return no("E_VENUE_RAIL_CLOSED", { venue: o.venue, message: `${o.venueName} is no longer connected live: cancel the order at the venue` });
      const r = await v.trader.cancel(o.ref, o.symbol);
      if (isRefusal(r)) {
        this.e.host.log({ kind: "account-refusal", venue: o.venue, tool: "live cancel", code: r.code, reason: r.message, native: r.native, signer: who.signer });
        return r;
      }
      this.apply(o, r.status === "open" || r.status === "pending" || r.status === "partial" ? { ...r, status: "canceled" } : r, "");
    }
    this.e.host.log({ kind: "order", venue: o.venue, tool: "live cancel", outcome: o.status, venueOrderId: o.ref, reason: `${o.id} · canceled by ${who.authority === "owner" ? "the owner" : (who.agent?.name ?? "an agent")} · ${o.filledQty ? `${qtyText(o.filledQty)} of ${qtyText(o.qty)} had filled` : "nothing had filled"}`, signer: who.signer, envelope: who.envelope });
    this.giveBack(o);
    return { ok: true, kind: "order", order: o };
  }

  private words(p: Plan): string {
    return `${p.side} ${qtyText(p.qty)} ${p.m.base} at ${p.v.name} · ${p.type === "limit" ? `limit ${plain(p.limitPrice!)}` : "market"} · about ${usd(p.notional)}`;
  }

  /** the one venue call, and the order it becomes */
  private async run(p: Plan, who: { signer: string; authority: "owner" | "agent"; agent?: string | undefined; card?: string | undefined; action?: Hex | undefined; approval?: string | undefined }): Promise<Outcome> {
    const id = this.e.nextOrderId();
    const at = new Date(this.money()!.realNow()).toISOString();
    const r = await p.v.trader.place({ symbol: p.m.symbol, side: p.side, type: p.type, qty: p.qty, ...(p.limitPrice !== undefined ? { limitPrice: p.limitPrice } : {}), clientId: id });
    if (isRefusal(r)) {
      this.e.host.log({ kind: "account-refusal", venue: p.v.id, tool: "live order", code: r.code, reason: r.message, native: r.native, signer: who.signer });
      return r;
    }
    const order: LiveOrder = {
      id,
      at,
      venue: p.v.id,
      venueName: p.v.name,
      symbol: p.m.symbol,
      name: p.m.name,
      kind: p.m.kind,
      base: p.m.base,
      side: p.side,
      type: p.type,
      qty: p.qty,
      ...(p.limitPrice !== undefined ? { limitPrice: p.limitPrice } : {}),
      price: p.price,
      usd: Number(p.maxUsd.toFixed(6)),
      status: r.status,
      filledQty: r.filledQty,
      ...(r.avgPrice !== undefined ? { avgPrice: r.avgPrice } : {}),
      ...(r.feeUsd !== undefined ? { feeUsd: r.feeUsd } : {}),
      ref: r.ref,
      signer: who.signer,
      authority: who.authority,
      ...(who.agent ? { agent: who.agent } : {}),
      ...(who.card ? { card: who.card } : {}),
      ...(who.approval ? { approval: who.approval } : {}),
      ...(who.action ? { action: who.action } : {}),
      note: "",
      updatedAt: at,
      native: r.native,
      ...(r.walletTxs?.length ? { walletTxs: r.walletTxs } : {}),
    };
    order.note = this.noteOf(order);
    this.e.orders.unshift(order);
    this.polled.set(id, this.money()!.realNow());
    this.e.host.log({ kind: "order", venue: p.v.id, tool: "live order", outcome: order.status, venueOrderId: r.ref, notionalUsd: p.notional, reason: `${id} · real money · ${this.words(p)}`, native: r.native, signer: who.signer });
    if (DONE.has(order.status)) this.giveBack(order);
    return { ok: true, kind: "order", order };
  }

  private noteOf(o: LiveOrder): string {
    if (o.walletTxs && !o.ref) return `waiting for your wallet to send it${o.walletTxs.length > 1 ? ` (${o.walletTxs.length} transactions: an approval first)` : ""}`;
    switch (o.status) {
      case "filled":
        return `filled${o.avgPrice ? ` at ${plain(o.avgPrice)}` : ""}${o.feeUsd ? ` · fee ${usd(o.feeUsd)}` : ""}`;
      case "partial":
        return `${qtyText(o.filledQty)} of ${qtyText(o.qty)} filled${o.avgPrice ? ` at ${plain(o.avgPrice)}` : ""}`;
      case "open":
        return o.type === "limit" ? `on ${o.venueName}'s book at ${plain(o.limitPrice!)}` : `taken by ${o.venueName}`;
      case "pending":
        return `${o.venueName} took it`;
      case "canceled":
        return o.filledQty ? `canceled · ${qtyText(o.filledQty)} of ${qtyText(o.qty)} had filled` : "canceled · nothing filled";
      case "rejected":
        return `${o.venueName} rejected it`;
      case "expired":
        return o.filledQty ? `expired · ${qtyText(o.filledQty)} of ${qtyText(o.qty)} had filled` : "expired · nothing filled";
    }
  }

  private apply(o: LiveOrder, r: OrderState, note: string): void {
    Object.assign(o, { status: r.status, filledQty: r.filledQty, ...(r.ref ? { ref: r.ref } : {}), ...(r.avgPrice !== undefined ? { avgPrice: r.avgPrice } : {}), ...(r.feeUsd !== undefined ? { feeUsd: r.feeUsd } : {}), native: r.native, updatedAt: new Date(this.money()?.realNow() ?? Date.now()).toISOString() });
    o.note = note || this.noteOf(o);
  }

  /** an agent's order that ended with less filled than it was counted at: the rest of its share of the limit is free again */
  private giveBack(o: LiveOrder): void {
    if (!o.approval || !DONE.has(o.status)) return;
    const used = o.filledQty > 0 ? Math.min(o.usd, o.filledQty * (o.avgPrice ?? o.price)) : 0;
    const back = micro(Math.max(0, o.usd - used).toFixed(6));
    if (back > 0) this.e.patchSpend(o.approval, (x) => ({ ...x, spentMicro: Math.max(0, x.spentMicro - back) }));
    o.approval = undefined;
  }

  /** the page tells which transaction the wallet sent for a DEX order; the chain decides from then on */
  async sent(orderId: string, hash: string): Promise<Outcome> {
    const o = this.e.orders.find((x) => x.id === orderId);
    if (!o?.walletTxs || DONE.has(o.status)) return no("E_ACCOUNT_ORDER_UNKNOWN", { message: `no order ${orderId} is waiting for a wallet` });
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return no("E_ACCOUNT_BAD_ACTION", { message: "a transaction hash is 0x and sixty-four hex digits" });
    const v = this.money()?.venue(o.venue);
    if (!v?.trader?.sent) return no("E_VENUE_RAIL_CLOSED", { venue: o.venue, message: `${o.venueName} is no longer connected live` });
    const r = await v.trader.sent(o.ref || o.id, hash as Hex);
    if (isRefusal(r)) return r;
    this.apply(o, r, "");
    this.polled.set(o.id, 0);
    this.e.host.log({ kind: "order", venue: o.venue, tool: "live order", outcome: o.status, venueOrderId: hash, reason: `${o.id} · the wallet sent ${hash}` });
    return { ok: true, kind: "order", order: o };
  }

  /** what became of the open orders: asked of the venue, at most every ten seconds per order */
  async poll(): Promise<void> {
    const m = this.money();
    if (!m) return;
    const now = m.realNow();
    for (const o of this.e.orders) {
      if (DONE.has(o.status) || (o.walletTxs && !o.ref)) continue;
      if (now - (this.polled.get(o.id) ?? 0) < POLL_MS) continue;
      this.polled.set(o.id, now);
      const v = m.venue(o.venue);
      if (!v?.trader) continue;
      const r = await v.trader.status(o.ref, o.symbol);
      if (isRefusal(r)) continue;
      const was = `${o.status}:${o.filledQty}`;
      this.apply(o, r, "");
      if (`${o.status}:${o.filledQty}` === was) continue;
      this.e.host.log({ kind: "order", venue: o.venue, tool: "live order", outcome: o.status, venueOrderId: o.ref, reason: `${o.id} · ${o.note}` });
      this.giveBack(o);
    }
  }
}

/** what the owner is shown before signing an order */
export interface OrderQuote {
  words: string;
  name: string;
  kind: MarketKind;
  base: string;
  quote: string;
  price: number;
  notionalUsd: number;
  maxUsd: number;
  note?: string;
  capUsd: number;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");
