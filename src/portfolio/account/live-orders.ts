/** ORDERS at venues connected live: the account's door for trading with the user's own money, at the user's own venues.
 *
 * This is what lets an agent take off. An order is ONE venue call — an exchange's order, a broker's, a prediction market's, a DEX swap the
 * user's wallet sends — and it is placed only when all of this holds:
 *
 *   1. the server moves real money (it does unless it was started `--read-only`);
 *   2. the market is priced in dollars, is open, and the venue takes the order as written (its smallest size, its steps, its order types);
 *   3. it is worth no more than the most one order may be on this server (`--live-cap`), valued at the price the venue shows now: a buy at
 *      the ask (or its limit, if higher), a sell at the bid (or its limit, if higher — a sell priced under the bid fills at the bid);
 *   4. a MARKET order carries a worst price to the venue: a buy pays at most 2% over the ask, a sell takes at least 2% under the bid. What
 *      the account counts is what that worst price allows, and if a venue fills worse anyway, the real cost is counted, not the plan;
 *   5. the OWNER signed it — the exact size, the limit price, what it is worth and ten minutes — or an AGENT asked inside the trading limit
 *      the owner signed for it (which venues, how much an order, how much in all, until when), with the dial open to it (the session, the
 *      venue switched on). Conservative mode: the agent's order is a card the owner signs, and the owner's yes places exactly the card;
 *      Aggressive: inside its limit it is placed at once;
 *   6. the venue itself agrees: its own key permissions, balances, risk checks and region rules still apply, and its refusal is the answer.
 *
 * Trading moves money between what the user holds AT ONE VENUE (dollars into BTC, shares into cash); nothing leaves the venue by an order.
 * Withdrawals stay where they were: the owner's signature, to the user's own places only (live-moves.ts). An agent can cancel the orders it
 * placed, in either mode — taking an order off the book never needs a card. The owner can cancel any. An order the venue has only agreed to
 * cancel is followed until the venue says it is gone: it may still fill on the way.
 */
import { createHash, randomBytes } from "node:crypto";
import { keccak256, stringToHex, type Hex } from "viem";
import { isRefusal, type Refusal } from "../../core/errors.ts";
import { canonical } from "../../core/hash.ts";
import { no } from "../refuse.ts";
import type { Intent } from "../accounts.ts";
import { isExpired } from "../openness.ts";
import { ceilTo, DONE, floorTo, inDollars, notionalOf, onStep, plain, type LiveTrader, type Market, type MarketKind, type OrderState, type OrderStatus, type OrderType, type Side } from "../live/trade.ts";
import type { CardLike, Outcome } from "./exchange.ts";
import type { LiveEngine, LiveVenue } from "./live-moves.ts";
import { orderLine } from "./statement.ts";
import { micro, type AgentAction, type Envelope, type OwnerAction } from "./sign.ts";
import { covers, spendFor, type AgentKey, type SpendApproval } from "./state.ts";

export type LiveOrderAction = Extract<OwnerAction, { type: "liveOrder" }>;
export type LiveCancelAction = Extract<OwnerAction, { type: "liveCancel" }>;
export type AgentLiveOrderAction = Extract<AgentAction, { type: "agentLiveOrder" }>;
export type AgentLiveCancelAction = Extract<AgentAction, { type: "agentLiveCancel" }>;

/** one order the account placed, as the page, the ledger and an agent see it */
export interface LiveOrder {
  /** the account's id: `ord-0001` */
  id: string;
  /** what the venue was given as its idempotency key: new in every run of the account, so two runs never send the same one */
  clientId: string;
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
  /** a market order: the worst price the venue was told it may fill at */
  worstPrice?: number | undefined;
  /** a contract is this much base */
  contractSize?: number | undefined;
  /** the price it was valued at when it was placed, and what it was worth then in dollars (the most it may cost, for a market buy) */
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
  /** the trading limit this order counts against, until it is done */
  approval?: string | undefined;
  /** a wallet order taken back before the wallet sent it: the limit it counted against, in case the wallet sends it after all */
  heldBy?: string | undefined;
  /** the venue agreed to cancel it and has not yet said it is gone */
  canceling?: boolean | undefined;
  /** a wallet order: the hash the wallet reported for it — once there is one, that is the transaction, and the page reports it again rather
   * than sending another */
  reported?: string | undefined;
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
  /** the price it is valued at */
  price: number;
  notional: number;
  /** a market order: the worst price it may fill at */
  worstPrice?: number | undefined;
  /** what it is counted at: what it may cost at worst (a buy), what it is worth now (a sell) */
  maxUsd: number;
}

/** what a card showed the owner: the owner's yes places this, and nothing else */
interface Shown {
  symbol: string;
  qty: number;
  price: number;
  notional: number;
  maxUsd: number;
}

const TTL_MS = 10 * 60_000;
const POLL_MS = 10_000;
/** the longest the account waits for a venue to say how an order stands */
const STATUS_MS = 15_000;
/** how far a market order may fill from the price the account saw: a buy pays at most this much more, a sell takes at most this much less */
export const SLIPPAGE = 0.02;
const DEC = /^\d+(\.\d{1,12})?$/;
const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const qtyText = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 8 });
const cents = (n: number) => Math.ceil(n * 100 - 1e-6) / 100;
const text = (v: unknown) => (typeof v === "string" ? v : "");

export class LiveOrders {
  private readonly polled = new Map<string, number>();
  /** what each waiting card showed, by card id */
  private readonly shown = new Map<string, Shown>();
  /** this run of the account: part of every client id it sends, so a restart never sends a venue an id it has seen */
  private readonly run = randomBytes(8).toString("hex");
  constructor(private readonly e: OrderEngine) {}

  private money() {
    return this.e.host.liveMoney?.();
  }

  /** Everything that does not depend on who signed: the switch, the venue, the market, the size, the price, the cap */
  private async plan(raw: Fields): Promise<Plan | Refusal> {
    const f: Fields = { venue: text(raw.venue), symbol: text(raw.symbol), side: text(raw.side), orderType: text(raw.orderType), qty: text(raw.qty), usd: text(raw.usd), limitPrice: text(raw.limitPrice) };
    const m = this.money();
    if (!m) return no("E_ACCOUNT_BAD_ACTION", { message: "this account has no venues connected live" });
    const w = m.writes();
    if (!w.on) return no("E_WALLET_LIVE_WRITES_OFF", { message: `this server places no orders: it was started read-only. To trade, stop it and start it again with: ${w.turnOn}`, detail: { turnOn: w.turnOn } });
    const v = m.venue(f.venue);
    if (!v) return no("E_WALLET_ACCOUNT_UNKNOWN", { venue: f.venue, message: `"${f.venue}" is not a venue connected live: orders are placed only at venues connected live` });
    if (!v.trader) return no("E_VENUE_RAIL_CLOSED", { venue: v.id, message: `${v.name}: ${v.noTradeBecause ?? "no orders are placed here from the account"}` });
    if (v.address !== undefined && !v.proven) return no("E_VENUE_RAIL_CLOSED", { venue: v.id, message: `${v.name} is watched, not proven yours: nothing is traded from it here. Connect it again from the wallet itself` });
    const trader = v.trader;
    if (trader.can === false) return no("E_VENUE_PERMISSION", { venue: v.id, message: `${v.name}: ${trader.whyNot ?? "this key may not trade. That is set on the key at the venue"}` });
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
    // the side of the book the order takes; a limit that crosses it fills at the book, so a sell is never valued under the bid
    const book = side === "buy" ? (mk.ask ?? mk.price) : (mk.bid ?? mk.price);
    const price = limitPrice === undefined ? book : side === "buy" ? limitPrice : Math.max(limitPrice, book ?? 0);
    if (!(price !== undefined && price > 0)) return no("E_ACCOUNT_UNPRICED", { venue: v.id, message: `${v.name} shows no price for ${mk.name} right now, so no limit can be judged: try a limit order` });
    const worstPrice = type === "market" ? (side === "buy" ? floorTo(price * (1 + SLIPPAGE), mk.priceStep) : ceilTo(price * (1 - SLIPPAGE), mk.priceStep)) : undefined;
    const each = notionalOf(mk, 1, side === "buy" && worstPrice !== undefined ? worstPrice : price);
    let qty: number;
    if (byQty) {
      qty = Number(size);
      if (!onStep(qty, mk.qtyStep)) return no("E_VENUE_ORDER_INVALID", { venue: v.id, message: `${v.name}: a size in ${mk.name} moves in steps of ${plain(mk.qtyStep!)} ${mk.base}`, detail: { qtyStep: mk.qtyStep } });
    } else qty = floorTo(Number(size) / each, mk.qtyStep);
    if (!(qty > 0) || (mk.minQty !== undefined && qty < mk.minQty - 1e-12)) return no("E_VENUE_ORDER_INVALID", { venue: v.id, message: `${v.name}: the smallest order in ${mk.name} is ${plain(mk.minQty ?? mk.qtyStep ?? 0)} ${mk.base}${byUsd ? ` (${usd((mk.minQty ?? mk.qtyStep ?? 0) * each)} at ${plain(price)})` : ""}`, detail: { minQty: mk.minQty, qtyStep: mk.qtyStep } });
    const notional = notionalOf(mk, qty, price);
    if (mk.minNotional !== undefined && notional < mk.minNotional - 1e-9) return no("E_VENUE_ORDER_INVALID", { venue: v.id, message: `${v.name}: the smallest order in ${mk.name} is worth ${usd(mk.minNotional)}`, detail: { minNotional: mk.minNotional } });
    const maxUsd = side === "buy" && worstPrice !== undefined ? notionalOf(mk, qty, worstPrice) : notional;
    if (maxUsd > w.capUsd + 1e-9) return no("E_ACCOUNT_LIMIT", { venue: v.id, message: `${usd(maxUsd)} is more than the most one order may be on this server (${usd(w.capUsd)}). It is set when the server starts: --live-cap`, detail: { capUsd: w.capUsd, orderUsd: maxUsd } });
    return { f, v: v as Plan["v"], m: mk, side, type, qty, limitPrice, price, notional, ...(worstPrice !== undefined ? { worstPrice } : {}), maxUsd };
  }

  /** Held to what was agreed — the owner's signature or the card: the same market, and a price that has not moved past what was agreed. A
   * buy may cost at most `worth` (its worst price is pulled in to fit); a market sell may take at most 2% less than `worth` (its worst
   * price is pushed up to fit). Answers the plan with the worst price that holds it there, or why it cannot be held */
  private hold(p: Plan, symbol: string, worth: number, what: string): Plan | Refusal {
    if (p.m.symbol !== symbol) return no("E_ACCOUNT_REQUOTE", { venue: p.v.id, message: `${p.v.name} now calls this market ${p.m.symbol}, not ${symbol}: prepare it again` });
    const per = notionalOf(p.m, p.qty, 1);
    if (p.side === "buy") {
      if (p.notional > worth + 1e-9) return no("E_ACCOUNT_REQUOTE", { venue: p.v.id, message: `the price moved: at ${plain(p.price)} the order is worth ${usd(p.notional)} now, more than the ${usd(worth)} ${what}. Nothing was placed`, detail: { price: p.price, notionalUsd: p.notional, maxUsd: worth } });
      if (p.worstPrice === undefined) return { ...p, maxUsd: p.notional };
      const worstPrice = Math.max(p.price, floorTo(Math.min(p.worstPrice, worth / per), p.m.priceStep));
      return { ...p, worstPrice, maxUsd: notionalOf(p.m, p.qty, worstPrice) };
    }
    if (p.worstPrice === undefined) return p;
    const least = worth * (1 - SLIPPAGE);
    if (p.notional < least - 1e-9) return no("E_ACCOUNT_REQUOTE", { venue: p.v.id, message: `the price fell: at ${plain(p.price)} the order fetches ${usd(p.notional)} now, more than 2% under the ${usd(worth)} ${what}. Nothing was placed`, detail: { price: p.price, notionalUsd: p.notional, worthUsd: worth } });
    return { ...p, worstPrice: Math.min(p.price, ceilTo(Math.max(p.worstPrice, least / per), p.m.priceStep)) };
  }

  /** the dial, as it stands: the agent's session, the venue switched off for agents, what the owner opened to agents there */
  private dial(venue: string): Refusal | null {
    const o = this.e.host.policy();
    if (isExpired(this.e.host.now(), o.sessionExpiresAt)) return no("E_WALLET_SESSION_EXPIRED", { venue, message: "the agent's session has expired: every write stops, reads continue", detail: { sessionExpiresAt: o.sessionExpiresAt } });
    if (o.revoked.includes(venue)) return no("E_WALLET_ACCOUNT_REVOKED", { venue, message: `${venue} is switched off for agents: reads only`, detail: { revoked: o.revoked } });
    const reach = o.reach[venue];
    if (reach && !reach.includes("trade")) return no("E_WALLET_REACH", { venue, message: `the owner did not open trading at ${venue} to agents`, detail: { reach } });
    return null;
  }

  /** the agent's trading limit as it stands now, its owner signature still good, the dial open at the venue */
  private async limit(signer: string, venue: string): Promise<SpendApproval | Refusal> {
    const now = Date.parse(this.e.host.now());
    const spend = spendFor(this.e.state, signer, "trade", now);
    if (isRefusal(spend)) return spend;
    if (!(await this.e.stillSigned(spend))) return no("E_ACCOUNT_BAD_SIGNATURE", { message: "the trading limit's own signature no longer checks out against the account's owners", detail: { approval: spend.id } });
    if (!spend.allow.includes(venue)) return covers(spend, venue, 0, now)!;
    return this.dial(venue) ?? spend;
  }

  /** what the owner is shown and signs: the exact size, the price, what it is worth, ten minutes */
  async prepare(draft: Record<string, unknown>): Promise<{ action: Omit<LiveOrderAction, "nonce">; quote: OrderQuote } | Refusal> {
    const f: Fields = { venue: String(draft.venue ?? ""), symbol: String(draft.symbol ?? ""), side: String(draft.side ?? ""), orderType: String(draft.orderType ?? "market"), qty: String(draft.qty ?? ""), usd: String(draft.usd ?? ""), limitPrice: String(draft.limitPrice ?? "") };
    const p = await this.plan(f);
    if (isRefusal(p)) return p;
    // a buy signs the most it may cost; a sell signs what it is worth now, and a market sell may then fetch at most 2% less
    const worth = (p.side === "buy" ? cents(p.maxUsd) : Math.floor(p.notional * 100 + 1e-6) / 100).toFixed(2);
    return {
      action: { type: "liveOrder", venue: p.v.id, symbol: p.m.symbol, side: p.side, orderType: p.type, qty: plain(p.qty), limitPrice: p.limitPrice !== undefined ? plain(p.limitPrice) : "", maxNotional: worth, deadline: this.money()!.realNow() + TTL_MS },
      quote: { words: this.words(p), name: p.m.name, kind: p.m.kind, base: p.m.base, quote: p.m.quote, price: p.price, notionalUsd: Number(p.notional.toFixed(2)), maxUsd: Number(worth), ...(p.worstPrice !== undefined ? { worstPrice: p.worstPrice } : {}), ...(p.m.note ? { note: p.m.note } : {}), capUsd: this.money()!.writes().capUsd },
    };
  }

  /** The owner's signed order: planned again, held to what was signed, placed */
  async owner(a: LiveOrderAction, who: { signer: string; envelope: Envelope; hash: Hex }): Promise<Outcome> {
    const planned = await this.plan({ ...a, usd: "" });
    if (isRefusal(planned)) return planned;
    if (this.money()!.realNow() > a.deadline) return no("E_ACCOUNT_EXPIRED", { message: "this order was good for ten minutes after it was prepared: prepare it again" });
    const p = this.hold(planned, a.symbol, Number(a.maxNotional), "signed for");
    if (isRefusal(p)) return p;
    return this.place(p, { signer: who.signer, authority: "owner", action: who.hash, envelope: who.envelope });
  }

  /** An agent's order. Its trading limit and the dial first; then Conservative: a card the owner signs; Aggressive: placed at once */
  async agent(a: AgentLiveOrderAction, who: { signer: string; envelope: Envelope; hash: Hex; agent: AgentKey }): Promise<Outcome> {
    const now = Date.parse(this.e.host.now());
    const spend = await this.limit(who.signer, text(a.venue));
    if (isRefusal(spend)) return spend;
    const p = await this.plan(a);
    if (isRefusal(p)) return p;
    const flight = this.e.host.openFlight({ id: slug(who.agent.name), name: who.agent.name, code: who.agent.code }, `${this.words(p)} · real money`);
    if (this.e.host.policy().mode === "open") {
      const c = covers(spend, p.v.id, micro(p.maxUsd.toFixed(6)), now);
      if (c) return c;
      const out = await this.charged(spend.id, p, { signer: who.signer, authority: "agent", agent: who.agent.address, action: who.hash, approval: spend.id });
      if (isRefusal(out)) return out;
      this.e.host.log({ kind: "action", venue: p.v.id, tool: a.type, signer: who.signer, envelope: who.envelope, outcome: "accepted", notionalUsd: p.maxUsd, reason: `aggressive mode: ${this.words(p)}, inside the trading limit`, flight: flight.no });
      this.e.host.say(flight.no, `${who.agent.name} ${this.words(p)}: inside its limit, so it went without a card (Aggressive)`, "ok");
      return { ...out, flight: flight.no } as Outcome;
    }
    // the card holds what it shows, to the cent: answering it frees exactly that
    const worth = cents(p.maxUsd);
    const c = covers(spend, p.v.id, micro(worth.toFixed(2)), now);
    if (c) return c;
    const offer = { payee: p.v.name, payTo: p.m.symbol, amount: `${p.side} ${qtyText(p.qty)} ${p.m.base}`, protocol: `real order · ${p.type}${p.limitPrice !== undefined ? ` at ${plain(p.limitPrice)}` : ` near ${plain(p.price)}`}`, network: `${p.side === "buy" ? "costs at most" : "worth about"} ${usd(worth)}` };
    // the owner's answer signs the card's hash: it covers the agent's request AND the market, size, price and worth the owner is shown
    const actionHash = keccak256(stringToHex(canonical({ action: who.hash, offer, symbol: p.m.symbol, qty: plain(p.qty), price: plain(p.price), worth: worth.toFixed(2) })));
    const intent: Intent = { kind: "trade", symbol: p.m.symbol, side: p.side, qty: p.qty };
    const card = this.e.host.raiseCard(flight.no, { account: p.v.id, intent, usd: worth, reason: `${who.agent.name} asks to ${this.words(p)}`, why: "live", action: a, actionHash, signer: who.signer, expiresAt: new Date(now + 30 * 60_000).toISOString(), offer, approval: spend.id });
    this.shown.set(card.id, { symbol: p.m.symbol, qty: p.qty, price: p.price, notional: p.notional, maxUsd: worth });
    this.e.patchSpend(spend.id, (x) => ({ ...x, reservedMicro: x.reservedMicro + micro(String(worth)) }));
    this.e.host.log({ kind: "action", venue: p.v.id, tool: a.type, signer: who.signer, envelope: who.envelope, outcome: "card", notionalUsd: worth, reason: `${card.id} · ${this.words(p)}`, flight: flight.no, intentId: card.id });
    return { ok: true, kind: "card", pending: true, card, flight: flight.no };
  }

  /** The owner approved an agent's order: exactly what the card showed — its market, its size, its worth — judged again against the agent's
   * trading limit as it stands now (answering the card has already freed what the card held), the limit's signature and the dial */
  async release(card: CardLike, who: { signer: string; agent: AgentKey }): Promise<Outcome> {
    const a = card.action as AgentLiveOrderAction;
    const shown = this.shown.get(card.id);
    this.shown.delete(card.id);
    if (!shown) return no("E_ACCOUNT_REQUOTE", { message: "this card's order is not known to this run of the account: the agent asks again" });
    const spend = await this.limit(who.signer, text(a.venue));
    if (isRefusal(spend)) return spend;
    const planned = await this.plan({ ...a, qty: plain(shown.qty), usd: "" });
    if (isRefusal(planned)) return planned;
    // a buy may cost at most what the card showed; a sell is held to what it was worth when the card was shown
    const p = this.hold(planned, shown.symbol, planned.side === "buy" ? card.usd : shown.notional, "on the card");
    if (isRefusal(p)) return p;
    const c = covers(spend, p.v.id, micro(p.maxUsd.toFixed(6)), Date.parse(this.e.host.now()));
    if (c) return c;
    return this.charged(spend.id, p, { signer: who.signer, authority: "agent", agent: who.agent.address, card: card.id, action: card.actionHash, approval: spend.id });
  }

  /** counted against the limit first, so an order that fills at once settles its count when it is placed; uncounted if the venue says no */
  private async charged(approval: string, p: Plan, who: Who): Promise<Outcome> {
    const amount = micro(p.maxUsd.toFixed(6));
    this.e.patchSpend(approval, (x) => ({ ...x, spentMicro: x.spentMicro + amount }));
    const out = await this.place(p, who);
    if (isRefusal(out)) this.e.patchSpend(approval, (x) => ({ ...x, spentMicro: Math.max(0, x.spentMicro - amount) }));
    return out;
  }

  /** cancel: the owner any open order, an agent only one it placed itself. Never a card: taking an order off the book moves nothing */
  async cancel(a: { venue: string; order: string }, who: { signer: string; authority: "owner" | "agent"; agent?: AgentKey | undefined; envelope: Envelope }): Promise<Outcome> {
    const o = this.e.orders.find((x) => x.id === a.order && x.venue === a.venue);
    const mine = o && (who.authority === "owner" || (o.authority === "agent" && o.agent === who.agent?.address));
    if (!o || !mine) return no("E_ACCOUNT_ORDER_UNKNOWN", { venue: a.venue, message: who.authority === "agent" && o ? `${a.order} was not placed by this agent: an agent cancels only its own orders` : `there is no order ${a.order} at ${a.venue} on the account`, detail: { order: a.order } });
    if (DONE.has(o.status)) return no("E_ACCOUNT_BAD_ACTION", { venue: o.venue, message: `${o.id} is already ${o.status}`, detail: { order: o.id, status: o.status } });
    const by = who.authority === "owner" ? "the owner" : (who.agent?.name ?? "an agent");
    if (o.walletTxs && !o.ref) {
      // a wallet order the wallet has not sent: nothing at a venue to take back. Its limit is kept in mind: if the wallet sends it after all,
      // the account takes it back on and counts it again
      o.heldBy = o.approval;
      this.apply(o, { ref: "", status: "canceled", filledQty: 0, native: { canceled: "before the wallet sent it" } }, "taken back before your wallet sent it");
      this.giveBack(o);
      this.e.host.log({ kind: "order", venue: o.venue, tool: "live cancel", outcome: o.status, reason: `${o.id} · taken back by ${by} before the wallet sent it`, signer: who.signer, envelope: who.envelope });
      this.line(o);
      return { ok: true, kind: "order", order: o };
    }
    const v = this.money()?.venue(o.venue);
    if (!v?.trader) return no("E_VENUE_RAIL_CLOSED", { venue: o.venue, message: `${o.venueName} is no longer connected live: cancel the order at the venue` });
    const r = await safely(() => v.trader!.cancel(o.ref, o.symbol), o.venue, o.venueName);
    if (isRefusal(r)) {
      this.e.host.log({ kind: "account-refusal", venue: o.venue, tool: "live cancel", code: r.code, reason: r.message, native: r.native, signer: who.signer });
      return r;
    }
    if (DONE.has(r.status)) this.apply(o, r, "");
    else {
      // the venue took the cancel but has not said the order is gone: it may still fill on the way, so it is followed until it says
      o.canceling = true;
      this.apply(o, r, `cancel asked of ${o.venueName}: waiting for it to say the order is gone`);
      this.polled.set(o.id, 0);
    }
    this.line(o);
    this.e.host.log({ kind: "order", venue: o.venue, tool: "live cancel", outcome: o.status, venueOrderId: o.ref, reason: `${o.id} · cancel by ${by} · ${o.canceling && !DONE.has(o.status) ? "the venue took the cancel" : o.filledQty ? `${qtyText(o.filledQty)} of ${qtyText(o.qty)} had filled` : "nothing had filled"}`, signer: who.signer, envelope: who.envelope });
    this.giveBack(o);
    return { ok: true, kind: "order", order: o };
  }

  /** the order's line on the statement, as it stands now */
  private line(o: LiveOrder): void {
    const l = orderLine(o, (address) => this.e.state.agents.find((k) => k.address === address)?.name ?? address);
    this.e.host.log({ kind: "statement", venue: o.venue, reason: `${l.id} · ${l.description} · ${l.status}`, detail: l });
  }

  private words(p: Plan): string {
    return `${p.side} ${qtyText(p.qty)} ${p.m.base} at ${p.v.name} · ${p.type === "limit" ? `limit ${plain(p.limitPrice!)}` : "market"} · about ${usd(p.notional)}`;
  }

  /** the one venue call, and the order it becomes */
  private async place(p: Plan, who: Who): Promise<Outcome> {
    const id = this.e.nextOrderId();
    const clientId = createHash("sha256").update(`${this.run}:${id}`).digest("hex").slice(0, 32);
    const at = new Date(this.money()!.realNow()).toISOString();
    const r = await safely(() => p.v.trader.place({ symbol: p.m.symbol, side: p.side, type: p.type, qty: p.qty, ...(p.limitPrice !== undefined ? { limitPrice: p.limitPrice } : {}), ...(p.worstPrice !== undefined ? { worstPrice: p.worstPrice } : {}), clientId }), p.v.id, p.v.name);
    if (isRefusal(r)) {
      this.e.host.log({ kind: "account-refusal", venue: p.v.id, tool: "live order", code: r.code, reason: r.message, native: r.native, signer: who.signer, ...(who.envelope ? { envelope: who.envelope } : {}) });
      return r;
    }
    const order: LiveOrder = {
      id,
      clientId,
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
      ...(p.worstPrice !== undefined ? { worstPrice: p.worstPrice } : {}),
      ...(p.m.contractSize !== undefined ? { contractSize: p.m.contractSize } : {}),
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
    // the owner's envelope goes on the ledger with the order: a later run of the account then knows this instruction was taken
    this.e.host.log({ kind: "order", venue: p.v.id, tool: "live order", outcome: order.status, venueOrderId: r.ref, notionalUsd: p.notional, reason: `${id} · real money · ${this.words(p)}`, native: r.native, signer: who.signer, ...(who.envelope ? { envelope: who.envelope } : {}) });
    if (DONE.has(order.status)) this.giveBack(order);
    this.line(order);
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
        return o.type === "limit" ? `on ${o.venueName}'s book at ${plain(o.limitPrice!)}` : o.worstPrice !== undefined ? `on ${o.venueName}'s book at its worst price, ${plain(o.worstPrice)}: it fills there or better, or waits` : `taken by ${o.venueName}`;
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
    // what the venue says filled, as it says it: a fill beyond the order (a buy sized in dollars that met a better book) is money spent, and
    // it is counted as such when the order is done
    const filledQty = Math.max(0, Number.isFinite(r.filledQty) ? r.filledQty : 0);
    Object.assign(o, { status: r.status, filledQty, ...(r.ref ? { ref: r.ref } : {}), ...(r.avgPrice !== undefined && r.avgPrice > 0 ? { avgPrice: r.avgPrice } : {}), ...(r.feeUsd !== undefined ? { feeUsd: r.feeUsd } : {}), native: r.native, updatedAt: new Date(this.money()?.realNow() ?? Date.now()).toISOString() });
    if (DONE.has(o.status)) o.canceling = undefined;
    o.note = note && !DONE.has(o.status) ? note : this.noteOf(o);
  }

  /** An agent's order that is done settles its count: what it did not use goes back to the limit; if the venue filled it worse than the
   * worst price allowed, the real cost is counted, and the ledger says so */
  private giveBack(o: LiveOrder): void {
    if (!o.approval || !DONE.has(o.status)) return;
    const used = o.filledQty > 0 ? notionalOf(o, o.filledQty, o.avgPrice !== undefined && o.avgPrice > 0 ? o.avgPrice : o.price) : 0;
    const diff = micro(Math.abs(o.usd - used).toFixed(6));
    if (used <= o.usd) {
      if (diff > 0) this.e.patchSpend(o.approval, (x) => ({ ...x, spentMicro: Math.max(0, x.spentMicro - diff) }));
    } else {
      this.e.patchSpend(o.approval, (x) => ({ ...x, spentMicro: x.spentMicro + diff }));
      this.e.host.log({ kind: "order", venue: o.venue, tool: "live order", outcome: "overrun", reason: `${o.id} · ${o.venueName} filled it for ${usd(used)}, more than the ${usd(o.usd)} it was counted at: the real cost is counted`, notionalUsd: used });
    }
    o.approval = undefined;
  }

  /** The page tells which transaction the wallet sent for a DEX order: once, for an order waiting for its wallet. An order taken back
   * before the wallet sent it is taken on again — the wallet sent it after all — and counted against its limit again. The trader checks on
   * chain that the hash is the transaction the account built. Called one at a time with every other instruction */
  async sent(orderId: string, hash: string): Promise<Outcome> {
    const o = this.e.orders.find((x) => x.id === orderId);
    const waiting = !!o?.walletTxs && !o.ref && (o.status === "pending" || (o.status === "canceled" && o.filledQty === 0));
    if (!o || !waiting) return no("E_ACCOUNT_ORDER_UNKNOWN", { message: `no order ${orderId} is waiting for a wallet` });
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return no("E_ACCOUNT_BAD_ACTION", { message: "a transaction hash is 0x and sixty-four hex digits" });
    const v = this.money()?.venue(o.venue);
    if (!v?.trader?.sent) return no("E_VENUE_RAIL_CLOSED", { venue: o.venue, message: `${o.venueName} is no longer connected live` });
    if (o.reported && o.reported.toLowerCase() !== hash.toLowerCase()) return no("E_ACCOUNT_BAD_ACTION", { message: `your wallet already sent ${o.reported.slice(0, 10)}… for ${o.id}: report that one`, detail: { reported: o.reported } });
    o.reported = hash;
    const expected = o.walletTxs!.at(-1);
    const r = await safely(() => v.trader!.sent!(o.id, hash as Hex, expected), o.venue, o.venueName);
    if (isRefusal(r)) {
      // a hash that is NOT this order's swap is forgotten; one the chain does not show yet is kept, to be reported again
      if (r.code === "E_VENUE_REJECTED" || r.code === "E_ACCOUNT_ORDER_UNKNOWN") o.reported = undefined;
      return r;
    }
    if (o.status === "canceled") {
      o.approval = o.heldBy;
      if (o.approval) this.e.patchSpend(o.approval, (x) => ({ ...x, spentMicro: x.spentMicro + micro(o.usd.toFixed(6)) }));
      this.e.host.log({ kind: "order", venue: o.venue, tool: "live order", outcome: "taken on again", reason: `${o.id} · it had been taken back, but the wallet sent it (${hash}): it counts again` });
    }
    o.heldBy = undefined;
    this.apply(o, { ...r, ref: r.ref || hash }, "");
    this.polled.set(o.id, 0);
    this.e.host.log({ kind: "order", venue: o.venue, tool: "live order", outcome: o.status, venueOrderId: hash, reason: `${o.id} · the wallet sent ${hash}` });
    this.giveBack(o);
    this.line(o);
    return { ok: true, kind: "order", order: o };
  }

  /** A wallet order whose approval the wallet has sent and the chain has taken: its swap, built again from a fresh quote and held to the same
   * order. Only for an order still waiting for its wallet, one at a time with every other instruction */
  async requote(orderId: string): Promise<Outcome> {
    const o = this.e.orders.find((x) => x.id === orderId);
    if (!o?.walletTxs || o.ref || o.status !== "pending") return no("E_ACCOUNT_ORDER_UNKNOWN", { message: `no order ${orderId} is waiting for a wallet` });
    const v = this.money()?.venue(o.venue);
    if (!v?.trader?.requote) return no("E_VENUE_RAIL_CLOSED", { venue: o.venue, message: `${o.venueName} cannot build the swap again: send it as it is, or take it back` });
    const r = await safely(() => v.trader!.requote!({ symbol: o.symbol, side: o.side, type: o.type, qty: o.qty, ...(o.limitPrice !== undefined ? { limitPrice: o.limitPrice } : {}), ...(o.worstPrice !== undefined ? { worstPrice: o.worstPrice } : {}), clientId: o.clientId }), o.venue, o.venueName);
    if (isRefusal(r)) return r;
    if (!r.walletTxs?.length) return no("E_VENUE_REJECTED", { venue: o.venue, message: `${o.venueName} built no swap` });
    o.walletTxs = r.walletTxs;
    o.native = r.native;
    o.note = this.noteOf(o);
    this.e.host.log({ kind: "order", venue: o.venue, tool: "live order", outcome: "requoted", reason: `${o.id} · the approval is on chain: the swap was built again from a fresh quote` });
    return { ok: true, kind: "order", order: o };
  }

  /** an order still open at a venue: a venue with one is not disconnected until it is done */
  openAt(venue: string): LiveOrder | undefined {
    return this.e.orders.find((o) => o.venue === venue && !DONE.has(o.status) && !(o.walletTxs && !o.ref));
  }

  /** What became of the open orders: every open order asked of its venue at once, at most every ten seconds per order, each for at most
   * fifteen seconds. A venue that throws or does not answer is asked again later — less often each time it fails, and after a few failures
   * the order says so (its share of a limit stays held: the account does not guess it is gone). An answer that arrives after the order
   * changed is dropped. One sweep at a time: a sweep already under way is the answer to a second ask */
  poll(): Promise<void> {
    return (this.sweep ??= this.sweepOnce().finally(() => (this.sweep = undefined)));
  }
  private sweep: Promise<void> | undefined;
  private readonly misses = new Map<string, number>();

  private async sweepOnce(): Promise<void> {
    const m = this.money();
    if (!m) return;
    const now = m.realNow();
    const due = this.e.orders.filter((o) => {
      if (DONE.has(o.status) || (o.walletTxs && !o.ref)) return false;
      const wait = POLL_MS * Math.min(30, 2 ** (this.misses.get(o.id) ?? 0));
      return now - (this.polled.get(o.id) ?? 0) >= wait;
    });
    await Promise.all(due.map(async (o) => {
      this.polled.set(o.id, now);
      const v = m.venue(o.venue);
      if (!v?.trader) return;
      const before = o.updatedAt;
      const r = await safely(() => v.trader!.status(o.ref, o.symbol), o.venue, o.venueName, STATUS_MS);
      if (isRefusal(r)) {
        const n = (this.misses.get(o.id) ?? 0) + 1;
        this.misses.set(o.id, n);
        if (n === 3) {
          o.note = `${o.venueName} has not said how this order stands (${r.message}): check it there`;
          this.e.host.log({ kind: "order", venue: o.venue, tool: "live order", outcome: "unknown", venueOrderId: o.ref, reason: `${o.id} · ${o.note}` });
        }
        return;
      }
      this.misses.delete(o.id);
      if (o.updatedAt !== before || DONE.has(o.status)) return;
      const was = `${o.status}:${o.filledQty}`;
      this.apply(o, r, o.canceling ? `cancel asked of ${o.venueName}: waiting for it to say the order is gone` : "");
      if (`${o.status}:${o.filledQty}` === was) return;
      this.e.host.log({ kind: "order", venue: o.venue, tool: "live order", outcome: o.status, venueOrderId: o.ref, reason: `${o.id} · ${o.note}` });
      this.giveBack(o);
      this.line(o);
    }));
  }
}

interface Who {
  signer: string;
  authority: "owner" | "agent";
  agent?: string | undefined;
  card?: string | undefined;
  action?: Hex | undefined;
  approval?: string | undefined;
  envelope?: Envelope | undefined;
}

/** A venue call that throws answers as a refusal, never as an exception through the door. A READ may also be given a time limit; a call that
 * places or cancels is not raced — a venue that is slow to answer may still have taken it, and an order the account stopped waiting for
 * would be an order it does not know about (the trader's own network timeout and its look-up by client id answer that) */
async function safely<T>(call: () => Promise<T | Refusal>, venue: string, name: string, ms?: number): Promise<T | Refusal> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (ms === undefined) return await call();
    return await Promise.race([call(), new Promise<Refusal>((resolve) => (timer = setTimeout(() => resolve(no("E_VENUE_UNREACHABLE", { venue, message: `${name} did not answer in time` })), ms)))]);
  } catch (err) {
    return isRefusal(err) ? err : no("E_VENUE_REJECTED", { venue, message: `${name} answered in a way the account could not read`, native: { error: String((err as Error)?.message ?? err).slice(0, 200) } });
  } finally {
    if (timer) clearTimeout(timer);
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
  /** a buy: the most it may cost · a sell: what it is worth now */
  maxUsd: number;
  worstPrice?: number;
  note?: string;
  capUsd: number;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");
