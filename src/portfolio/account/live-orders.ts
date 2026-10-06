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
import { ceilTo, DONE, floorTo, inDollars, notionalOf, onStep, ORDER_TYPES, plain, TIFS, type LiveTrader, type Market, type MarketKind, type OrderChange, type OrderRequest, type OrderState, type OrderStatus, type OrderType, type Position, type Side, type TimeInForce } from "../live/trade.ts";
import type { CardLike, Outcome } from "./exchange.ts";
import type { LiveEngine, LiveVenue } from "./live-moves.ts";
import { orderLine } from "./statement.ts";
import { micro, type AgentAction, type Envelope, type OwnerAction } from "./sign.ts";
import { covers, spendFor, type AgentKey, type SpendApproval } from "./state.ts";

export type LiveOrderAction = Extract<OwnerAction, { type: "liveOrder" }>;
export type LiveCancelAction = Extract<OwnerAction, { type: "liveCancel" }>;
export type AgentLiveOrderAction = Extract<AgentAction, { type: "agentLiveOrder" }>;
export type AgentLiveCancelAction = Extract<AgentAction, { type: "agentLiveCancel" }>;
export type LiveAmendAction = Extract<OwnerAction, { type: "liveAmend" }>;
export type AgentLiveAmendAction = Extract<AgentAction, { type: "agentLiveAmend" }>;
export type AgentLiveCloseAction = Extract<AgentAction, { type: "agentLiveClose" }>;
type CloseFields = { venue: string; symbol: string; qty: string };
type LeverageFields = { venue: string; symbol: string; leverage: string; marginMode: string };

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
  /** a market or stop order: the worst price the venue was told it may fill at */
  worstPrice?: number | undefined;
  /** a stop or stop-limit order: the price that triggers it */
  stopPrice?: number | undefined;
  tif?: TimeInForce | undefined;
  postOnly?: boolean | undefined;
  reduceOnly?: boolean | undefined;
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
  stopPrice: string;
  tif: string;
  postOnly: string;
  reduceOnly: string;
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
  /** a market or stop order: the worst price it may fill at */
  worstPrice?: number | undefined;
  stopPrice?: number | undefined;
  tif?: TimeInForce | undefined;
  postOnly?: boolean | undefined;
  reduceOnly?: boolean | undefined;
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
  /** what each waiting card for an AMEND showed: the order as it would be */
  private readonly shownAmend = new Map<string, { order: string; qty: number; limitPrice?: number | undefined; stopPrice?: number | undefined; maxUsd: number }>();
  /** what each close card showed the owner: the market and the size, which an approval releases exactly */
  private readonly shownClose = new Map<string, { symbol: string; qty: number }>();
  /** this run of the account: part of every client id it sends, so a restart never sends a venue an id it has seen */
  private readonly run = randomBytes(8).toString("hex");
  constructor(private readonly e: OrderEngine) {}

  private money() {
    return this.e.host.liveMoney?.();
  }

  /** Everything that does not depend on who signed: the switch, the venue, the market, the size, the price, the cap */
  private async plan(raw: Fields): Promise<Plan | Refusal> {
    const f: Fields = { venue: text(raw.venue), symbol: text(raw.symbol), side: text(raw.side), orderType: text(raw.orderType), qty: text(raw.qty), usd: text(raw.usd), limitPrice: text(raw.limitPrice), stopPrice: text(raw.stopPrice), tif: text(raw.tif), postOnly: text(raw.postOnly), reduceOnly: text(raw.reduceOnly) };
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
    if (!(ORDER_TYPES as readonly string[]).includes(f.orderType)) return no("E_ACCOUNT_BAD_ACTION", { message: "an order is a market, limit, stop or stop_limit order" });
    const side = f.side as Side;
    const type = f.orderType as OrderType;
    const byQty = f.qty.trim() !== "";
    const byUsd = f.usd.trim() !== "";
    if (byQty === byUsd) return no("E_ACCOUNT_BAD_ACTION", { message: "an order's size is given once: in the market's own units (qty) or in dollars (usd)" });
    const size = byQty ? f.qty.trim() : f.usd.trim();
    if (!DEC.test(size) || !(Number(size) > 0)) return no("E_ACCOUNT_BAD_ACTION", { message: "a size is a plain decimal, more than zero" });
    const limited = type === "limit" || type === "stop_limit";
    const stopped = type === "stop" || type === "stop_limit";
    if (limited ? !DEC.test(f.limitPrice.trim()) || !(Number(f.limitPrice) > 0) : f.limitPrice.trim() !== "") return no("E_ACCOUNT_BAD_ACTION", { message: limited ? `a ${type === "limit" ? "limit" : "stop-limit"} order has a limit price: a plain decimal, more than zero` : `a ${type} order has no limit price` });
    if (stopped ? !DEC.test(f.stopPrice.trim()) || !(Number(f.stopPrice) > 0) : f.stopPrice.trim() !== "") return no("E_ACCOUNT_BAD_ACTION", { message: stopped ? `a ${type === "stop" ? "stop" : "stop-limit"} order has a stop price that triggers it: a plain decimal, more than zero` : `a ${type} order has no stop price` });
    if (f.tif.trim() !== "" && !(TIFS as readonly string[]).includes(f.tif.trim())) return no("E_ACCOUNT_BAD_ACTION", { message: `a time in force is ${TIFS.join(", ")}, or left to the venue` });
    if (![f.postOnly, f.reduceOnly].every((x) => x === "" || x === "true")) return no("E_ACCOUNT_BAD_ACTION", { message: 'post-only and reduce-only are "true", or left out' });
    if (f.postOnly === "true" && type !== "limit") return no("E_ACCOUNT_BAD_ACTION", { message: "post-only is for a limit order: it rests on the book as a maker, or is refused" });
    if (!f.symbol.trim()) return no("E_ACCOUNT_BAD_ACTION", { message: "an order names its market" });

    const mk = await trader.market(f.symbol.trim());
    if (isRefusal(mk)) return mk;
    if (!inDollars(mk.quote)) return no("E_ACCOUNT_UNPRICED", { venue: v.id, message: `${mk.symbol} is priced in ${mk.quote}: the account trades markets priced in dollars, so that every limit means dollars` });
    if (!mk.open) return no("E_VENUE_MARKET_CLOSED", { venue: v.id, message: `${v.name}: ${mk.name} takes no orders now${mk.note ? ` (${mk.note})` : ""}` });
    if (!mk.types.includes(type)) return no("E_VENUE_ORDER_INVALID", { venue: v.id, message: `${v.name} takes ${mk.types.join(", ")} orders in ${mk.name}, not ${type} orders` });
    // what the market takes besides the type: a time in force it lists, post-only and reduce-only where it says so
    const tif = f.tif.trim() === "" ? undefined : (f.tif.trim() as TimeInForce);
    if (tif !== undefined && !(mk.tifs ?? []).includes(tif)) return no("E_VENUE_ORDER_INVALID", { venue: v.id, message: mk.tifs?.length ? `${v.name} takes ${mk.tifs.join(", ")} in ${mk.name}, not ${tif}` : `${v.name} takes no time-in-force choice in ${mk.name}: its own default applies` });
    const forType = mk.tifsByType?.[type];
    if (tif !== undefined && forType && !forType.includes(tif)) return no("E_VENUE_ORDER_INVALID", { venue: v.id, message: forType.length ? `${v.name} takes ${forType.join(", ")} for a ${type.replace("_", "-")} order in ${mk.name}, not ${tif}` : `${v.name} takes no time-in-force choice for a ${type.replace("_", "-")} order in ${mk.name}` });
    if (f.postOnly === "true" && !mk.postOnly) return no("E_VENUE_ORDER_INVALID", { venue: v.id, message: `${v.name} takes no post-only orders in ${mk.name}` });
    if (f.reduceOnly === "true" && !mk.reduceOnly) return no("E_VENUE_ORDER_INVALID", { venue: v.id, message: `${v.name} takes no reduce-only orders in ${mk.name}` });
    const limitPrice = limited ? Number(f.limitPrice) : undefined;
    const stopPrice = stopped ? Number(f.stopPrice) : undefined;
    for (const x of [limitPrice, stopPrice]) if (x !== undefined && !onStep(x, mk.priceStep)) return no("E_VENUE_ORDER_INVALID", { venue: v.id, message: `${v.name}: a price in ${mk.name} moves in steps of ${plain(mk.priceStep!)}`, detail: { priceStep: mk.priceStep } });
    // the side of the book the order takes; a limit that crosses it fills at the book, so a sell is never valued under the bid. A stop is
    // valued where it triggers: what the book does before then is not the order's price. A buy stop-limit at its limit (the most it pays); a
    // sell stop-limit at its stop, or its limit if that is higher — a limit under the stop takes the book where the stop fires, so a sell
    // limited at $1 is worth what it sells, not $1
    const book = side === "buy" ? (mk.ask ?? mk.price) : (mk.bid ?? mk.price);
    const price = type === "stop" ? stopPrice : limitPrice === undefined ? book : side === "buy" ? limitPrice : type === "stop_limit" ? Math.max(limitPrice, stopPrice ?? 0) : Math.max(limitPrice, book ?? 0);
    if (!(price !== undefined && price > 0)) return no("E_ACCOUNT_UNPRICED", { venue: v.id, message: `${v.name} shows no price for ${mk.name} right now, so no limit can be judged: try a limit order` });
    // a market order — and a stop, once it triggers — carries a worst price: 2% past where it is valued
    const worstPrice = type === "market" || type === "stop" ? (side === "buy" ? floorTo(price * (1 + SLIPPAGE), mk.priceStep) : ceilTo(price * (1 - SLIPPAGE), mk.priceStep)) : undefined;
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
    return { f, v: v as Plan["v"], m: mk, side, type, qty, limitPrice, price, notional, ...(worstPrice !== undefined ? { worstPrice } : {}), ...(stopPrice !== undefined ? { stopPrice } : {}), ...(tif ? { tif } : {}), ...(f.postOnly === "true" ? { postOnly: true } : {}), ...(f.reduceOnly === "true" ? { reduceOnly: true } : {}), maxUsd };
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
    const f: Fields = { venue: String(draft.venue ?? ""), symbol: String(draft.symbol ?? ""), side: String(draft.side ?? ""), orderType: String(draft.orderType ?? "market"), qty: String(draft.qty ?? ""), usd: String(draft.usd ?? ""), limitPrice: String(draft.limitPrice ?? ""), stopPrice: String(draft.stopPrice ?? ""), tif: String(draft.tif ?? ""), postOnly: draft.postOnly === true || draft.postOnly === "true" ? "true" : "", reduceOnly: draft.reduceOnly === true || draft.reduceOnly === "true" ? "true" : "" };
    const p = await this.plan(f);
    if (isRefusal(p)) return p;
    // a buy signs the most it may cost; a sell signs what it is worth now, and a market sell may then fetch at most 2% less
    const worth = (p.side === "buy" ? cents(p.maxUsd) : Math.floor(p.notional * 100 + 1e-6) / 100).toFixed(2);
    return {
      action: { type: "liveOrder", venue: p.v.id, symbol: p.m.symbol, side: p.side, orderType: p.type, qty: plain(p.qty), limitPrice: p.limitPrice !== undefined ? plain(p.limitPrice) : "", stopPrice: p.stopPrice !== undefined ? plain(p.stopPrice) : "", tif: p.tif ?? "", postOnly: p.postOnly ? "true" : "", reduceOnly: p.reduceOnly ? "true" : "", maxNotional: worth, deadline: this.money()!.realNow() + TTL_MS },
      quote: { words: this.words(p), name: p.m.name, kind: p.m.kind, base: p.m.base, quote: p.m.quote, price: p.price, notionalUsd: Number(p.notional.toFixed(2)), maxUsd: Number(worth), ...(p.worstPrice !== undefined ? { worstPrice: p.worstPrice } : {}), ...(p.m.note ? { note: p.m.note } : {}), capUsd: this.money()!.writes().capUsd },
    };
  }

  /** The owner's signed order: planned again, held to what was signed, placed */
  async owner(a: LiveOrderAction, who: { signer: string; envelope: Envelope; hash: Hex }): Promise<Outcome> {
    const planned = await this.plan({ ...fieldsOf(a), usd: "" });
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
    const p = await this.plan(fieldsOf(a));
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
    const planned = await this.plan({ ...fieldsOf(a), qty: plain(shown.qty), usd: "" });
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

  /** the order's line on the statement, as it stands now — and the order itself, so that a restarted account follows it again */
  private line(o: LiveOrder): void {
    const l = orderLine(o, (address) => this.e.state.agents.find((k) => k.address === address)?.name ?? address);
    this.e.host.log({ kind: "statement", venue: o.venue, reason: `${l.id} · ${l.description} · ${l.status}`, detail: l, native: { order: o } });
  }

  /** An order an earlier run of the account placed and did not see finished (account/restore.ts): followed again, as it was — its id, its
   * client id, the limit it counts against. Nothing is sent: it is only asked about */
  adopt(o: LiveOrder): void {
    if (this.e.orders.some((x) => x.clientId === o.clientId)) return;
    const back: LiveOrder = { ...o, note: o.walletTxs && !o.ref ? o.note : `${o.note ? `${o.note} · ` : ""}followed again after a restart` };
    this.e.orders.push(back);
    this.polled.set(o.id, 0);
    // its line is written in this run too: the statement shows it as followed, not as left behind
    this.line(back);
  }

  private words(p: Plan): string {
    const how = p.type === "limit" ? `limit ${plain(p.limitPrice!)}` : p.type === "stop" ? `stop at ${plain(p.stopPrice!)}` : p.type === "stop_limit" ? `stop at ${plain(p.stopPrice!)}, limit ${plain(p.limitPrice!)}` : "market";
    const flags = [p.tif ? p.tif.toUpperCase() : "", p.postOnly ? "post-only" : "", p.reduceOnly ? "reduce-only" : ""].filter(Boolean).join(", ");
    return `${p.side} ${qtyText(p.qty)} ${p.m.base} at ${p.v.name} · ${how}${flags ? ` (${flags})` : ""} · about ${usd(p.notional)}`;
  }

  /** the one venue call, and the order it becomes. `send`: another call than place — a venue's own close of a position */
  private async place(p: Plan, who: Who, send?: (clientId: string) => Promise<OrderState | Refusal>): Promise<Outcome> {
    const id = this.e.nextOrderId();
    const clientId = createHash("sha256").update(`${this.run}:${id}`).digest("hex").slice(0, 32);
    const at = new Date(this.money()!.realNow()).toISOString();
    const r = await safely(() => (send ? send(clientId) : p.v.trader.place(requestOf(p, clientId))), p.v.id, p.v.name);
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
      ...(p.stopPrice !== undefined ? { stopPrice: p.stopPrice } : {}),
      ...(p.tif ? { tif: p.tif } : {}),
      ...(p.postOnly ? { postOnly: true } : {}),
      ...(p.reduceOnly ? { reduceOnly: true } : {}),
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
        return o.type === "limit" ? `on ${o.venueName}'s book at ${plain(o.limitPrice!)}` : o.type === "stop" || o.type === "stop_limit" ? `waiting at ${o.venueName} for the price to reach ${plain(o.stopPrice ?? 0)}${o.type === "stop_limit" ? `, then a limit at ${plain(o.limitPrice ?? 0)}` : ""}` : o.worstPrice !== undefined ? `on ${o.venueName}'s book at its worst price, ${plain(o.worstPrice)}: it fills there or better, or waits` : `taken by ${o.venueName}`;
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
    const r = await safely(() => v.trader!.requote!(requestOfOrder(o)), o.venue, o.venueName);
    if (isRefusal(r)) return r;
    if (!r.walletTxs?.length) return no("E_VENUE_REJECTED", { venue: o.venue, message: `${o.venueName} built no swap` });
    o.walletTxs = r.walletTxs;
    o.native = r.native;
    o.note = this.noteOf(o);
    this.e.host.log({ kind: "order", venue: o.venue, tool: "live order", outcome: "requoted", reason: `${o.id} · the approval is on chain: the swap was built again from a fresh quote` });
    return { ok: true, kind: "order", order: o };
  }

  // ---- what is held, an order changed in place, a position closed, leverage --------------------------------

  /** what is held at a venue, as the venue lists it */
  async positions(venue: string): Promise<Position[] | Refusal> {
    const v = this.money()?.venue(venue);
    if (!v) return no("E_WALLET_ACCOUNT_UNKNOWN", { venue, message: `"${venue}" is not a venue connected live` });
    if (!v.trader?.positions) return no("E_VENUE_RAIL_CLOSED", { venue, message: `${v.name} lists no positions to the account` });
    return safely(() => v.trader!.positions!(), venue, v.name, STATUS_MS);
  }

  /** the order as an amend would leave it: its new size, limit or stop, valued afresh against the market as it is now */
  private async amendPlan(o: LiveOrder, a: { qty: string; limitPrice: string; stopPrice: string }): Promise<{ p: Plan; change: OrderChange } | Refusal> {
    const given = (x: string) => text(x).trim() !== "";
    if (![a.qty, a.limitPrice, a.stopPrice].some(given)) return no("E_ACCOUNT_BAD_ACTION", { message: "an amend changes the size, the limit or the stop" });
    if (given(a.limitPrice) && o.type !== "limit" && o.type !== "stop_limit") return no("E_ACCOUNT_BAD_ACTION", { message: `${o.id} is a ${o.type} order: it has no limit price to change` });
    if (given(a.stopPrice) && o.type !== "stop" && o.type !== "stop_limit") return no("E_ACCOUNT_BAD_ACTION", { message: `${o.id} is a ${o.type} order: it has no stop price to change` });
    const qty = given(a.qty) ? a.qty.trim() : plain(o.qty);
    if (DEC.test(qty) && Number(qty) < o.filledQty - 1e-12) return no("E_ACCOUNT_BAD_ACTION", { message: `${o.id} has ${qtyText(o.filledQty)} filled already: it cannot be made smaller than that` });
    const f: Fields = { venue: o.venue, symbol: o.symbol, side: o.side, orderType: o.type, qty, usd: "", limitPrice: given(a.limitPrice) ? a.limitPrice.trim() : o.limitPrice !== undefined ? plain(o.limitPrice) : "", stopPrice: given(a.stopPrice) ? a.stopPrice.trim() : o.stopPrice !== undefined ? plain(o.stopPrice) : "", tif: o.tif ?? "", postOnly: o.postOnly ? "true" : "", reduceOnly: o.reduceOnly ? "true" : "" };
    const planned = await this.plan(f);
    if (isRefusal(planned)) return planned;
    // a stop's worst price is never pulled in by a change: a venue that holds a stop as a stop-limit at its worst price (Alpaca) keeps the
    // one the stop was placed with, so what the order is worth at most stays a bound whichever of the two the venue holds
    const old = o.type === "stop" ? o.worstPrice : undefined;
    const p = old === undefined || planned.worstPrice === undefined ? planned : (() => {
      const worstPrice = planned.side === "buy" ? Math.max(planned.worstPrice, old) : Math.min(planned.worstPrice, old);
      return { ...planned, worstPrice, maxUsd: planned.side === "buy" ? notionalOf(planned.m, planned.qty, worstPrice) : planned.maxUsd };
    })();
    const capUsd = this.money()!.writes().capUsd;
    if (p.maxUsd > capUsd + 1e-9) return no("E_ACCOUNT_LIMIT", { venue: o.venue, message: `${usd(p.maxUsd)} is more than the most one order may be on this server (${usd(capUsd)}): the stop keeps the worst price it was placed with, ${plain(old!)}`, detail: { capUsd, orderUsd: p.maxUsd } });
    return { p, change: { ...(given(a.qty) ? { qty: p.qty } : {}), ...(given(a.limitPrice) ? { limitPrice: p.limitPrice } : {}), ...(given(a.stopPrice) ? { stopPrice: p.stopPrice } : {}) } };
  }

  private changeable(a: { venue: string; order: string }, who: { authority: "owner" | "agent"; agent?: AgentKey | undefined }): LiveOrder | Refusal {
    const o = this.e.orders.find((x) => x.id === a.order && x.venue === a.venue);
    const mine = o && (who.authority === "owner" || (o.authority === "agent" && o.agent === who.agent?.address));
    if (!o || !mine) return no("E_ACCOUNT_ORDER_UNKNOWN", { venue: a.venue, message: who.authority === "agent" && o ? `${a.order} was not placed by this agent: an agent changes only its own orders` : `there is no order ${a.order} at ${a.venue} on the account`, detail: { order: a.order } });
    if (DONE.has(o.status) || (o.walletTxs && !o.ref)) return no("E_ACCOUNT_BAD_ACTION", { venue: o.venue, message: `${o.id} is ${o.walletTxs && !o.ref ? "waiting for a wallet" : o.status}: there is nothing to change at the venue`, detail: { order: o.id } });
    const v = this.money()?.venue(o.venue);
    if (!v?.trader) return no("E_VENUE_RAIL_CLOSED", { venue: o.venue, message: `${o.venueName} is no longer connected live` });
    if (!v.trader.amend) return no("E_VENUE_RAIL_CLOSED", { venue: o.venue, message: `${o.venueName} changes no order in place: cancel it and place another` });
    return o;
  }

  /** what an agent's change adds to the limit that stands: what the order grows by, or — counted on a limit the owner has since replaced — all of
   * it, since it moves onto the one that stands */
  private growth(o: LiveOrder, maxUsd: number, limit: string): number {
    return o.approval === limit ? maxUsd - o.usd : maxUsd;
  }

  /** what the owner is shown and signs for an amend: the order as it would be, what it would then be worth at most, ten minutes */
  async prepareAmend(draft: Record<string, unknown>): Promise<{ action: Omit<LiveAmendAction, "nonce">; quote: OrderQuote } | Refusal> {
    const a = { venue: String(draft.venue ?? ""), order: String(draft.order ?? ""), qty: String(draft.qty ?? ""), limitPrice: String(draft.limitPrice ?? ""), stopPrice: String(draft.stopPrice ?? "") };
    const o = this.changeable(a, { authority: "owner" });
    if (isRefusal(o)) return o;
    const r = await this.amendPlan(o, a);
    if (isRefusal(r)) return r;
    const p = r.p;
    const worth = (p.side === "buy" ? cents(p.maxUsd) : Math.floor(p.notional * 100 + 1e-6) / 100).toFixed(2);
    return { action: { type: "liveAmend", ...a, maxNotional: worth, deadline: this.money()!.realNow() + TTL_MS }, quote: { words: `${o.id}: ${this.words(p)}`, name: p.m.name, kind: p.m.kind, base: p.m.base, quote: p.m.quote, price: p.price, notionalUsd: Number(p.notional.toFixed(2)), maxUsd: Number(worth), ...(p.worstPrice !== undefined ? { worstPrice: p.worstPrice } : {}), capUsd: this.money()!.writes().capUsd } };
  }

  /** Change an open order in place. The owner: held to what was signed. An agent: only its own order; what the order becomes worth MORE is
   * judged like a new order of the difference — Aggressive inside its limit at once, Conservative on a card; worth less, it simply goes */
  async amend(a: LiveAmendAction | AgentLiveAmendAction, who: { signer: string; authority: "owner" | "agent"; agent?: AgentKey | undefined; envelope: Envelope; hash: Hex }): Promise<Outcome> {
    const o = this.changeable(a, who);
    if (isRefusal(o)) return o;
    const r = await this.amendPlan(o, a);
    if (isRefusal(r)) return r;
    if (who.authority === "owner") {
      const signed = a as LiveAmendAction;
      if (this.money()!.realNow() > signed.deadline) return no("E_ACCOUNT_EXPIRED", { message: "this change was good for ten minutes after it was prepared: prepare it again" });
      const held = this.hold(r.p, o.symbol, Number(signed.maxNotional), "signed for");
      if (isRefusal(held)) return held;
      return this.applyAmend(o, held, r.change, who);
    }
    const spend = await this.limit(who.signer, o.venue);
    if (isRefusal(spend)) return spend;
    const p = r.p;
    const line = perOrder(spend, p.maxUsd);
    if (line) return line;
    const more = this.growth(o, p.maxUsd, spend.id);
    if (more <= 1e-9) return this.applyAmend(o, p, r.change, who, spend.id);
    const now = Date.parse(this.e.host.now());
    if (this.e.host.policy().mode === "open") {
      const c = covers(spend, o.venue, micro(more.toFixed(6)), now);
      if (c) return c;
      return this.applyAmend(o, p, r.change, who, spend.id);
    }
    const worth = cents(p.maxUsd);
    const extra = cents(more);
    const c = covers(spend, o.venue, micro(extra.toFixed(2)), now);
    if (c) return c;
    const flight = this.e.host.openFlight({ id: slug(who.agent!.name), name: who.agent!.name, code: who.agent!.code }, `change ${o.id}: ${this.words(p)} · real money`);
    const offer = { payee: o.venueName, payTo: o.symbol, amount: `${o.id} → ${p.side} ${qtyText(p.qty)} ${p.m.base}`, protocol: `change an order · ${this.words(p)}`, network: `${p.side === "buy" ? "costs at most" : "worth about"} ${usd(worth)} · ${usd(extra)} more than now` };
    const actionHash = keccak256(stringToHex(canonical({ action: who.hash, offer, qty: plain(p.qty), limit: p.limitPrice !== undefined ? plain(p.limitPrice) : "", stop: p.stopPrice !== undefined ? plain(p.stopPrice) : "", worth: worth.toFixed(2) })));
    const card = this.e.host.raiseCard(flight.no, { account: o.venue, intent: { kind: "trade", symbol: p.m.symbol, side: p.side, qty: p.qty }, usd: extra, reason: `${who.agent!.name} asks to change ${o.id}: ${this.words(p)}`, why: "live", action: a as AgentLiveAmendAction, actionHash, signer: who.signer, expiresAt: new Date(now + 30 * 60_000).toISOString(), offer, approval: spend.id });
    this.shownAmend.set(card.id, { order: o.id, qty: p.qty, ...(p.limitPrice !== undefined ? { limitPrice: p.limitPrice } : {}), ...(p.stopPrice !== undefined ? { stopPrice: p.stopPrice } : {}), maxUsd: worth });
    this.e.patchSpend(spend.id, (x) => ({ ...x, reservedMicro: x.reservedMicro + micro(String(extra)) }));
    this.e.host.log({ kind: "action", venue: o.venue, tool: a.type, signer: who.signer, envelope: who.envelope, outcome: "card", notionalUsd: extra, reason: `${card.id} · change ${o.id}: ${this.words(p)}`, flight: flight.no, intentId: card.id });
    return { ok: true, kind: "card", pending: true, card, flight: flight.no };
  }

  /** the owner approved an agent's change: exactly what the card showed, judged again against the agent's limit as it stands */
  async releaseAmend(card: CardLike, who: { signer: string; agent: AgentKey }): Promise<Outcome> {
    const a = card.action as AgentLiveAmendAction;
    const shown = this.shownAmend.get(card.id);
    this.shownAmend.delete(card.id);
    if (!shown) return no("E_ACCOUNT_REQUOTE", { message: "this card's change is not known to this run of the account: the agent asks again" });
    const o = this.changeable(a, { authority: "agent", agent: who.agent });
    if (isRefusal(o)) return o;
    const spend = await this.limit(who.signer, o.venue);
    if (isRefusal(spend)) return spend;
    const r = await this.amendPlan(o, { qty: plain(shown.qty), limitPrice: shown.limitPrice !== undefined && o.limitPrice !== shown.limitPrice ? plain(shown.limitPrice) : "", stopPrice: shown.stopPrice !== undefined && o.stopPrice !== shown.stopPrice ? plain(shown.stopPrice) : "" });
    if (isRefusal(r)) return r;
    const held = this.hold(r.p, o.symbol, r.p.side === "buy" ? shown.maxUsd : r.p.notional, "on the card");
    if (isRefusal(held)) return held;
    const line = perOrder(spend, held.maxUsd);
    if (line) return line;
    const more = this.growth(o, held.maxUsd, spend.id);
    const c = more > 0 ? covers(spend, o.venue, micro(more.toFixed(6)), Date.parse(this.e.host.now())) : null;
    if (c) return c;
    return this.applyAmend(o, held, r.change, { signer: who.signer, authority: "agent", agent: who.agent }, spend.id);
  }

  /** the venue's amend, and the order as it stands after it. What it is worth more is counted first (and uncounted if the venue says no);
   * what it is worth less goes back to its limit */
  private async applyAmend(o: LiveOrder, p: Plan, change: OrderChange, who: { signer: string; authority: "owner" | "agent"; agent?: AgentKey | undefined; envelope?: Envelope | undefined }, onto = o.approval): Promise<Outcome> {
    const v = this.money()!.venue(o.venue)!;
    // moving onto the limit that stands: all of the order is counted there, and what the old limit counted for it goes back to that one
    const moving = onto !== undefined && onto !== o.approval;
    const charge = moving ? micro(p.maxUsd.toFixed(6)) : p.maxUsd > o.usd ? micro((p.maxUsd - o.usd).toFixed(6)) : 0;
    const back = moving ? micro(o.usd.toFixed(6)) : p.maxUsd < o.usd ? micro((o.usd - p.maxUsd).toFixed(6)) : 0;
    if (onto && charge > 0) this.e.patchSpend(onto, (x) => ({ ...x, spentMicro: x.spentMicro + charge }));
    const r = await safely(() => v.trader!.amend!(o.ref, o.symbol, change, requestOfOrder(o)), o.venue, o.venueName);
    if (isRefusal(r)) {
      if (onto && charge > 0) this.e.patchSpend(onto, (x) => ({ ...x, spentMicro: Math.max(0, x.spentMicro - charge) }));
      this.e.host.log({ kind: "account-refusal", venue: o.venue, tool: "live amend", code: r.code, reason: r.message, native: r.native, signer: who.signer });
      return r;
    }
    if (o.approval && back > 0) this.e.patchSpend(o.approval, (x) => ({ ...x, spentMicro: Math.max(0, x.spentMicro - back) }));
    if (moving) o.approval = onto;
    Object.assign(o, { qty: p.qty, price: p.price, usd: Number(p.maxUsd.toFixed(6)), ...(p.limitPrice !== undefined ? { limitPrice: p.limitPrice } : {}), ...(p.stopPrice !== undefined ? { stopPrice: p.stopPrice } : {}), ...(p.worstPrice !== undefined ? { worstPrice: p.worstPrice } : {}) });
    this.apply(o, r, "");
    this.polled.set(o.id, 0);
    this.e.host.log({ kind: "order", venue: o.venue, tool: "live amend", outcome: o.status, venueOrderId: o.ref, notionalUsd: p.notional, reason: `${o.id} · changed by ${who.authority === "owner" ? "the owner" : "its agent"} · ${this.words(p)}`, signer: who.signer, ...(who.envelope ? { envelope: who.envelope } : {}) });
    this.giveBack(o);
    this.line(o);
    return { ok: true, kind: "order", order: o };
  }

  /** Close a position — all of it, or some — at a venue. It only shrinks what is held, so it does not count against a limit. The owner's goes at
   * once; an agent's is an order the owner sees like any other — in Conservative a card, in Aggressive at once inside its per-order line —
   * and only where its trading limit lets it trade (a position the agent closes may be the owner's own). The venue's own close where it has
   * one; otherwise a reduce-only market order, and only where the market takes reduce-only: a close that could open a position the other way
   * is not sent */
  async close(a: CloseFields | AgentLiveCloseAction, who: { signer: string; authority: "owner" | "agent"; agent?: AgentKey | undefined; envelope?: Envelope | undefined; hash: Hex; card?: string | undefined }): Promise<Outcome> {
    const v = this.money()?.venue(text(a.venue));
    if (!v) return no("E_WALLET_ACCOUNT_UNKNOWN", { venue: a.venue, message: `"${a.venue}" is not a venue connected live` });
    if (!v.trader?.positions) return no("E_VENUE_RAIL_CLOSED", { venue: v.id, message: `${v.name} lists no positions to the account: sell what is held as an order` });
    let spend: SpendApproval | undefined;
    if (who.authority === "agent") {
      const s = await this.limit(who.signer, v.id);
      if (isRefusal(s)) return s;
      spend = s;
    }
    const list = await safely(() => v.trader!.positions!(), v.id, v.name, STATUS_MS);
    if (isRefusal(list)) return list;
    const pos = list.find((x) => x.symbol === text(a.symbol));
    if (!pos || !(pos.qty > 0)) return no("E_ACCOUNT_BAD_ACTION", { venue: v.id, message: `${v.name} shows no position in ${a.symbol}` });
    const qty = text(a.qty).trim() === "" ? pos.qty : Number(a.qty);
    if ((text(a.qty).trim() !== "" && !DEC.test(text(a.qty).trim())) || !(qty > 0) || qty > pos.qty + 1e-12) return no("E_ACCOUNT_BAD_ACTION", { venue: v.id, message: `a close is more than zero and at most the ${qtyText(pos.qty)} held` });
    const native = v.trader.close;
    // without the venue's own close: reduce-only where the market takes it; a plain sell where a sell can only sell what is held; else nothing
    const mk = native ? undefined : await safely(() => v.trader!.market(pos.symbol), v.id, v.name, STATUS_MS);
    if (mk && isRefusal(mk)) return mk;
    const plainSell = !!mk && !mk.reduceOnly && !!mk.sellsReduce && pos.side === "long";
    if (mk && !mk.reduceOnly && !plainSell) return no("E_VENUE_ORDER_INVALID", { venue: v.id, message: `${v.name} takes no reduce-only order in ${mk.name}, and has no close of its own: close it at the venue, so that nothing opens the other way` });
    const p = await this.plan({ venue: v.id, symbol: pos.symbol, side: pos.side === "long" ? "sell" : "buy", orderType: "market", qty: plain(qty), usd: "", limitPrice: "", stopPrice: "", tif: "", postOnly: "", reduceOnly: native || plainSell ? "" : "true" });
    if (isRefusal(p)) return p;
    if (spend && who.card === undefined && !(this.e.host.policy().mode === "open" && micro(p.maxUsd.toFixed(6)) <= spend.perPaymentMicro)) return this.closeCard(a, p, qty, who);
    return this.place(p, { signer: who.signer, authority: who.authority, ...(who.agent ? { agent: who.agent.address } : {}), action: who.hash, ...(who.envelope ? { envelope: who.envelope } : {}), ...(who.card ? { card: who.card } : {}) }, native ? (clientId) => native.call(v.trader, pos.symbol, qty, clientId) : undefined);
  }

  /** an agent's close the owner answers: what it closes and what that is worth, shown on a card. It counts against no limit, so the card holds
   * none of one */
  private closeCard(a: CloseFields | AgentLiveCloseAction, p: Plan, qty: number, who: { signer: string; agent?: AgentKey | undefined; envelope?: Envelope | undefined; hash: Hex }): Outcome {
    const agent = who.agent!;
    const now = Date.parse(this.e.host.now());
    const flight = this.e.host.openFlight({ id: slug(agent.name), name: agent.name, code: agent.code }, `close ${qtyText(qty)} ${p.m.base} of ${p.m.name} · real money`);
    const worth = cents(p.maxUsd);
    const offer = { payee: p.v.name, payTo: p.m.symbol, amount: `close · ${p.side} ${qtyText(qty)} ${p.m.base}`, protocol: "real order · a close at market", network: `${p.side === "buy" ? "costs at most" : "worth about"} ${usd(worth)} · it only shrinks what is held` };
    // the owner's answer signs the card's hash: the agent's request AND the market and size the owner is shown
    const actionHash = keccak256(stringToHex(canonical({ action: who.hash, offer, symbol: p.m.symbol, qty: plain(qty), worth: worth.toFixed(2) })));
    const card = this.e.host.raiseCard(flight.no, { account: p.v.id, intent: { kind: "trade", symbol: p.m.symbol, side: p.side, qty }, usd: worth, reason: `${agent.name} asks to close ${qtyText(qty)} ${p.m.base} of ${p.m.name}`, why: "live", action: a as AgentLiveCloseAction, actionHash, signer: who.signer, expiresAt: new Date(now + 30 * 60_000).toISOString(), offer });
    this.shownClose.set(card.id, { symbol: p.m.symbol, qty });
    this.e.host.log({ kind: "action", venue: p.v.id, tool: "agentLiveClose", signer: who.signer, ...(who.envelope ? { envelope: who.envelope } : {}), outcome: "card", notionalUsd: worth, reason: `${card.id} · close ${qtyText(qty)} of ${p.m.name}`, flight: flight.no, intentId: card.id });
    return { ok: true, kind: "card", pending: true, card, flight: flight.no };
  }

  /** the owner approved an agent's close: exactly the size the card showed, against what is held then (never more than that) */
  async releaseClose(card: CardLike, who: { signer: string; agent: AgentKey }): Promise<Outcome> {
    const a = card.action as AgentLiveCloseAction;
    const shown = this.shownClose.get(card.id);
    this.shownClose.delete(card.id);
    if (!shown) return no("E_ACCOUNT_REQUOTE", { message: "this card's close is not known to this run of the account: the agent asks again" });
    return this.close({ venue: a.venue, symbol: shown.symbol, qty: plain(shown.qty) }, { signer: who.signer, authority: "agent", agent: who.agent, hash: card.actionHash!, card: card.id });
  }

  /** A perpetual's leverage (and margin mode). The owner: up to what the venue takes. An agent: where its trading limit lets it trade, up to
   * the most the owner signed for agents (1x unless the owner signed more) */
  async leverage(a: LeverageFields, who: { signer: string; authority: "owner" | "agent"; envelope: Envelope }): Promise<Outcome> {
    const v = this.money()?.venue(text(a.venue));
    if (!v) return no("E_WALLET_ACCOUNT_UNKNOWN", { venue: a.venue, message: `"${a.venue}" is not a venue connected live` });
    if (!v.trader?.setLeverage) return no("E_VENUE_RAIL_CLOSED", { venue: v.id, message: `${v.name} sets no leverage from the account` });
    const lev = Number(a.leverage);
    if (!/^\d{1,3}$/.test(text(a.leverage)) || !(lev >= 1)) return no("E_ACCOUNT_BAD_ACTION", { message: "leverage is a whole number, 1 or more" });
    if (text(a.marginMode) !== "" && a.marginMode !== "cross" && a.marginMode !== "isolated") return no("E_ACCOUNT_BAD_ACTION", { message: 'a margin mode is "cross" or "isolated"' });
    const m = this.money()!;
    if (!m.writes().on) return no("E_WALLET_LIVE_WRITES_OFF", { message: `this server changes nothing at a venue: it was started read-only. ${m.writes().turnOn}` });
    const mk = await safely(() => v.trader!.market(text(a.symbol)), v.id, v.name, STATUS_MS);
    if (isRefusal(mk)) return mk;
    if (mk.kind !== "perp" && mk.kind !== "future") return no("E_ACCOUNT_BAD_ACTION", { venue: v.id, message: `leverage is set on a perpetual or a future; ${mk.name} is ${mk.kind}` });
    if (mk.maxLeverage !== undefined && lev > mk.maxLeverage) return no("E_VENUE_ORDER_INVALID", { venue: v.id, message: `${v.name} takes at most ${mk.maxLeverage}x in ${mk.name}` });
    if (who.authority === "agent") {
      const spend = await this.limit(who.signer, v.id);
      if (isRefusal(spend)) return spend;
      const cap = this.e.host.policy().maxLeverage ?? 1;
      if (lev > cap) return no("E_ACCOUNT_LIMIT", { venue: v.id, message: `the owner lets agents use at most ${cap}x leverage: ${lev}x is the owner's to set, or to allow`, detail: { maxLeverage: cap } });
    }
    const r = await safely(() => v.trader!.setLeverage!(mk.symbol, lev, (text(a.marginMode) || undefined) as "cross" | "isolated" | undefined), v.id, v.name);
    if (isRefusal(r)) {
      this.e.host.log({ kind: "account-refusal", venue: v.id, tool: "live leverage", code: r.code, reason: r.message, native: r.native, signer: who.signer });
      return r;
    }
    this.e.host.log({ kind: "action", venue: v.id, tool: "live leverage", signer: who.signer, envelope: who.envelope, outcome: "ok", reason: `${mk.name} at ${v.name}: ${r.leverage}x${r.marginMode ? `, ${r.marginMode} margin` : ""}`, native: r.native });
    return { ok: true, kind: "result", result: { venue: v.id, symbol: mk.symbol, leverage: r.leverage, ...(r.marginMode ? { marginMode: r.marginMode } : {}) } };
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

/** an agent's order is held to its limit's per-order line as it stands after any change: a change cannot grow one order past what one order may be */
function perOrder(spend: SpendApproval, maxUsd: number): Refusal | null {
  return micro(maxUsd.toFixed(6)) > spend.perPaymentMicro ? no("E_MANDATE_PER_ORDER_CAP", { message: `the order would be worth ${usd(maxUsd)}, more than the ${usd(spend.perPaymentMicro / 1e6)} an order the trading limit allows: a change cannot grow one order past it`, detail: { approval: spend.id, perPayment: spend.perPaymentMicro / 1e6, amount: Number(maxUsd.toFixed(6)) } }) : null;
}

/** an order's fields as the door reads them, from an owner's or an agent's instruction (the agent's optional ones absent = "") */
function fieldsOf(a: { venue: string; symbol: string; side: string; orderType: string; qty: string; usd?: string | undefined; limitPrice: string; stopPrice?: string | undefined; tif?: string | undefined; postOnly?: string | undefined; reduceOnly?: string | undefined }): Fields {
  return { venue: text(a.venue), symbol: text(a.symbol), side: text(a.side), orderType: text(a.orderType), qty: text(a.qty), usd: text(a.usd), limitPrice: text(a.limitPrice), stopPrice: text(a.stopPrice), tif: text(a.tif), postOnly: text(a.postOnly), reduceOnly: text(a.reduceOnly) };
}

/** what the venue is sent for a plan */
function requestOf(p: Plan, clientId: string): OrderRequest {
  return { symbol: p.m.symbol, side: p.side, type: p.type, qty: p.qty, ...(p.limitPrice !== undefined ? { limitPrice: p.limitPrice } : {}), ...(p.worstPrice !== undefined ? { worstPrice: p.worstPrice } : {}), ...(p.stopPrice !== undefined ? { stopPrice: p.stopPrice } : {}), ...(p.tif ? { tif: p.tif } : {}), ...(p.postOnly ? { postOnly: true } : {}), ...(p.reduceOnly ? { reduceOnly: true } : {}), clientId };
}

/** an order as it was placed, for a venue asked to change or rebuild it */
function requestOfOrder(o: LiveOrder): OrderRequest {
  return { symbol: o.symbol, side: o.side, type: o.type, qty: o.qty, ...(o.limitPrice !== undefined ? { limitPrice: o.limitPrice } : {}), ...(o.worstPrice !== undefined ? { worstPrice: o.worstPrice } : {}), ...(o.stopPrice !== undefined ? { stopPrice: o.stopPrice } : {}), ...(o.tif ? { tif: o.tif } : {}), ...(o.postOnly ? { postOnly: true } : {}), ...(o.reduceOnly ? { reduceOnly: true } : {}), clientId: o.clientId };
}
