/** The stand-in account's venues: an exchange, an event market, a wallet, and the public market data of venues that are not connected —
 * each speaking exactly the shapes the real ones speak (live/trade.ts, live/types.ts, live/writes.ts, live/public-markets.ts), so the
 * account's own doors, reads and pages run against them unchanged. Nothing here reaches the network and no money exists: every balance,
 * price and fill is the stand-in's own, made up and kept in memory.
 *
 *   live:standin-exchange    spot BTC, ETH and SOL against USDT, and their perpetuals — and a pre-IPO perpetual, ANTHROPIC/USDT:USDT, a
 *                            contract on Anthropic's implied valuation (live/preipo.ts: category Pre-IPO, $1 of price for $1,000,000,000,
 *                            about 2,100 here): balances in a spot and a futures ledger, the last 24 hours, candles, positions, leverage,
 *                            an order changed in place; a limit order rests and fills when the price crosses it; a stop triggers. It moves
 *                            money between its own ledgers, swaps one stablecoin for another and withdraws to an agent wallet of the
 *                            account's (the stand-in chain credits it); it gives no deposit address. And it EARNS (an earner, live/earn.ts):
 *                            a flexible USDT product and a bonded ETH one; money goes in from spot and comes back there, each request done
 *                            on the next tick, and — as at OKX — what is in earn is not in the exchange's balance read
 *   live:standin-events      event contracts with a YES and a NO leg, closing minutes to days ahead (Economics, Crypto, Sports, Weather,
 *                            and an IPO question), and a fifteen-minute "Bitcoin up or down" that rolls over and settles; positions
 *   live:standin-wallet      a wallet that swaps on its own (as the mm command line does: nothing for a browser wallet to send): WETH and
 *                            cbBTC on Base, and USDY, a tokenised fund (an RWA), on Ethereum — its market carries the RWA category, an
 *                            issuer and the issuer's words, as a real wallet's tokenised shares do (dex.ts), so it is an RWA in Markets
 *                            and in holdings alike
 *   live:standin-broker      a cash stock broker, as Alpaca and Robinhood are: AAPL and SPY to a billionth of a share, NVDA in whole shares
 *                            only, priced off the same curves as the stock tokens below (NVDA and SPY), cash in dollars; each market's
 *                            steps, minimum and times in force are Alpaca's (live/alpaca.ts). It keeps New York's market hours by the
 *                            world's clock and the account's market calendar (account/calendar.ts) — 09:30 to 16:00 on a market day, the
 *                            market's holidays closed — and says its session as a market does (Market.session): while the market is closed
 *                            it takes no market order and says when it opens, in Alpaca's words, and holds any other order (pending, as
 *                            Alpaca's `accepted`) until the open, nothing filling and no stop firing before then; a day order lapses at its
 *                            session's close (a fraction of a share is a day order, as at Alpaca). No positions, leverage or orders changed
 *                            in place, and no money moves: it gives no deposit address and makes no withdrawal
 *   live:standin-pubex       the exchange behind the public listing below, for "Connect to trade"
 *   live:standin-pubperps    the perp exchange behind the public perpetuals below (as Hyperliquid stands behind the real ones); it lists
 *                            the same Anthropic pre-IPO perpetual, unconnected, so Markets shows one Anthropic row with Trade at the
 *                            Stand-in Exchange and Connect to trade here
 *   live:standin-pubevents   the event market behind the public events below
 *
 * and the keyless public sources Markets reads beside them: an exchange's coins (DOGE, AVAX and LINK only there), an event market's events
 * with their tags (its Sports one is left out, as the real read leaves sports out), a perp exchange's perpetuals, stock tokens that are only
 * read, and an exchange that answers this location with its own geoblock — so the page shows the venue's words. Each says what its list is
 * made of (`notes`). The exchanges' and the event market's public sources give price history too (`candles`), as the real keyless ones do.
 */
import { isRefusal, type Refusal } from "../../src/core/errors.ts";
import { nextRegularSession, regularSession } from "../../src/portfolio/account/calendar.ts";
import { no } from "../../src/portfolio/refuse.ts";
import { register } from "../../src/portfolio/live/index.ts";
import { isExcludedCategory, RWA_CATEGORY } from "../../src/portfolio/live/categories.ts";
import type { EarnPosition, EarnProduct, EarnState, LiveEarner } from "../../src/portfolio/live/earn.ts";
import { CHAINS, type ChainName, type ChainReader, type ChainSender } from "../../src/portfolio/live/chain.ts";
import { impliedUsd, PRE_IPO_CATEGORY, PRE_IPO_ISSUERS, PRE_IPO_PER_POINT } from "../../src/portfolio/live/preipo.ts";
import type { Listing, PublicSource } from "../../src/portfolio/live/public-markets.ts";
import { badOrder, DONE, notionalOf, onStep, type Candle, type CandleInterval, type LiveTrader, type Market, type MarketKind, type MarketStats, type OrderChange, type OrderRequest, type OrderState, type OrderStatus, type Position, type TimeInForce } from "../../src/portfolio/live/trade.ts";
import { isStable, type LiveBalance, type LiveSource } from "../../src/portfolio/live/types.ts";
import { tokenOn, type LiveWriter } from "../../src/portfolio/live/writes.ts";
import { DAY, PriceBook, seedOf, toStep } from "./model.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const r2 = (n: number): number => Number(n.toFixed(2)) || 0;
const units = (n: number): number => Number(n.toFixed(10)) || 0;
const show = (n: number): string => (Math.abs(n) >= 100 ? n.toFixed(2) : Number(n.toPrecision(6)).toString());
const STANDIN = "a stand-in in the test harness: no network, no real money, every number made up";

// ---- the world: the prices, the books, the stand-in chain -----------------------------------------------------------------------------

export interface World {
  t0: number;
  clock: () => number;
  prices: PriceBook;
  ex: ExchangeBook;
  pubex: ExchangeBook;
  /** the perp exchange behind the public perpetuals: not connected on the stand-in account */
  pubperps: ExchangeBook;
  predict: EventBook;
  pubevents: EventBook;
  wallet: WalletBook;
  /** the stock broker: New York's market hours, by `clock` */
  broker: BrokerBook;
  /** the Stand-in Exchange's earn products and what is in them */
  earn: EarnBook;
  /** what the stand-in chain holds: `address|chain|asset` → amount (an agent wallet's dollars, its gas) */
  chain: Map<string, number>;
}

let current: World | undefined;
const w = (): World => {
  if (!current) throw new Error("the stand-in world is not made yet: call makeWorld first");
  return current;
};

// ---- an order book with balances, shared by the three kinds of venue ------------------------------------------------------------------

type Need = { ledger: string; asset: string; amount: number };
interface Rec {
  ref: string;
  clientId: string;
  venue: string;
  req: OrderRequest;
  status: OrderStatus;
  filledQty: number;
  avgPrice?: number | undefined;
  feeUsd: number;
  /** a stop that has fired: from then on it is a market or a limit order */
  triggered: boolean;
  /** what it holds of a balance while it rests */
  hold?: Need | undefined;
  /** when it lapses by itself: a day order, at its session's close */
  until?: number | undefined;
  at: number;
  note?: string | undefined;
}

abstract class Book {
  protected readonly recs = new Map<string, Rec>();
  private readonly clients = new Map<string, string>();
  private seq = 0;
  private readonly held = new Map<string, number>();
  /** `ledger|asset` → amount */
  readonly balances = new Map<string, number>();

  constructor(
    readonly tag: string,
    readonly name: string,
    protected readonly fees: { taker: number; maker: number },
  ) {}

  /** every market it lists now, priced now */
  abstract markets(): Market[];
  /** a market by its symbol, a closed one included */
  market(symbol: string): Market | undefined {
    return this.markets().find((m) => m.symbol === symbol) ?? this.closed(symbol);
  }
  protected closed(_symbol: string): Market | undefined {
    return undefined;
  }
  /** what an order must find in a balance at `price` (and holds while it rests) */
  protected abstract need(o: OrderRequest, m: Market, price: number): Need | undefined;
  /** what a fill does to the balances and positions */
  protected abstract settle(o: OrderRequest, m: Market, price: number, fee: number): void;
  /** the venue's own refusal of an order before anything else (reduce-only that grows a position) */
  protected check(_venue: string, _o: OrderRequest, _m: Market): Refusal | undefined {
    return undefined;
  }
  /** what a balance holds for something besides resting orders (a perpetual's margin) */
  protected locked(_ledger: string, _asset: string): number {
    return 0;
  }
  /** does the venue match orders in this market now: a stock market outside its session takes an order and holds it until the open
   * (Alpaca's `accepted`), so nothing fills and no stop fires before then */
  protected inSession(_m: Market): boolean {
    return true;
  }
  /** when an order that rests lapses by itself (a day order, at its session's close), or never */
  protected lapsesAt(_o: OrderRequest, _m: Market): number | undefined {
    return undefined;
  }

  bal(ledger: string, asset: string): number {
    return this.balances.get(`${ledger}|${asset}`) ?? 0;
  }
  add(ledger: string, asset: string, x: number): void {
    this.balances.set(`${ledger}|${asset}`, units(this.bal(ledger, asset) + x));
  }
  available(ledger: string, asset: string): number {
    return this.bal(ledger, asset) - (this.held.get(`${ledger}|${asset}`) ?? 0) - this.locked(ledger, asset);
  }
  private hold(n: Need | undefined, sign: 1 | -1): void {
    if (!n) return;
    const k = `${n.ledger}|${n.asset}`;
    this.held.set(k, Math.max(0, units((this.held.get(k) ?? 0) + sign * n.amount)));
  }
  private release(rec: Rec): void {
    this.hold(rec.hold, -1);
    rec.hold = undefined;
  }
  private short(venue: string, n: Need): Refusal {
    return no("E_VENUE_INSUFFICIENT", { venue, message: `${this.name}: not enough balance there for this order`, native: { said: `insufficient ${n.asset}${n.ledger ? ` in ${n.ledger}` : ""}: ${show(Math.max(0, this.available(n.ledger, n.asset)))} available, ${show(n.amount)} needed` } });
  }

  /** the price an order fills at now, and whether it rested on the book first (a maker), or nothing */
  private fillOf(rec: Rec, m: Market, resting: boolean): { price: number; maker: boolean } | undefined {
    const o = rec.req;
    const last = m.price ?? 0;
    const ask = m.ask ?? last;
    const bid = m.bid ?? last;
    let type = o.type;
    if (type === "stop" || type === "stop_limit") {
      if (!rec.triggered) {
        const hit = o.side === "buy" ? last >= (o.stopPrice ?? Number.POSITIVE_INFINITY) : last <= (o.stopPrice ?? 0);
        if (!hit) return undefined;
        rec.triggered = true;
        // a stop that fires places its order now: one that crosses the book takes it
        resting = false;
      }
      type = type === "stop" ? "market" : "limit";
    }
    if (type === "market") {
      if (o.side === "buy") return o.worstPrice !== undefined && ask > o.worstPrice ? undefined : { price: ask, maker: false };
      return o.worstPrice !== undefined && bid < o.worstPrice ? undefined : { price: bid, maker: false };
    }
    const lim = o.limitPrice ?? 0;
    if (o.side === "buy") return ask <= lim ? (resting ? { price: lim, maker: true } : { price: ask, maker: false }) : undefined;
    return bid >= lim ? (resting ? { price: lim, maker: true } : { price: bid, maker: false }) : undefined;
  }

  private execute(rec: Rec, m: Market, fill: { price: number; maker: boolean }): true | Refusal {
    const o = rec.req;
    this.release(rec);
    const n = this.need(o, m, fill.price);
    if (n && this.available(n.ledger, n.asset) + 1e-9 < n.amount) return this.short(rec.venue, n);
    const fee = Number((notionalOf(m, o.qty, fill.price) * (fill.maker ? this.fees.maker : this.fees.taker)).toFixed(4));
    this.settle(o, m, fill.price, fee);
    Object.assign(rec, { status: "filled" as const, filledQty: o.qty, avgPrice: fill.price, feeUsd: fee });
    return true;
  }

  /** what a resting order holds: at its limit, or for a stop at the worst it may fill at */
  private resting(o: OrderRequest, m: Market): Need | undefined {
    const price = o.type === "limit" || o.type === "stop_limit" ? (o.limitPrice ?? 0) : (o.worstPrice ?? o.stopPrice ?? m.price ?? 0);
    return this.need(o, m, price);
  }

  place(venue: string, o: OrderRequest): OrderState | Refusal {
    const m = this.market(o.symbol);
    if (!m) return no("E_VENUE_REJECTED", { venue, message: `${this.name} lists no market called ${o.symbol}` });
    if (!m.open) return no("E_VENUE_MARKET_CLOSED", { venue, message: `${this.name}: ${m.name} takes no orders now${m.note ? ` (${m.note})` : ""}` });
    // the account's id for the order is the venue's idempotency key: the same order again is the same order
    const again = this.clients.get(o.clientId);
    if (again) return this.view(this.recs.get(again)!);
    if (!m.types.includes(o.type)) return badOrder(venue, this.name, `it takes ${m.types.join(", ")} orders in ${m.name}, not ${o.type}`);
    if (!(o.qty > 0) || (m.minQty !== undefined && o.qty < m.minQty - 1e-12) || !onStep(o.qty, m.qtyStep)) return badOrder(venue, this.name, `a size in ${m.name} is at least ${m.minQty ?? m.qtyStep ?? 0} and moves in steps of ${m.qtyStep ?? "any amount"}`);
    const wrong = this.check(venue, o, m);
    if (wrong) return wrong;
    const rec: Rec = { ref: `${this.tag}-${String(++this.seq).padStart(5, "0")}`, clientId: o.clientId, venue, req: { ...o }, status: "open", filledQty: 0, feeUsd: 0, triggered: false, at: w().clock() };
    // outside its session the venue takes the order and holds it for the open: nothing fills, and no stop fires, now
    const live = this.inSession(m);
    const fill = live ? this.fillOf(rec, m, false) : undefined;
    if (o.postOnly && fill && !fill.maker) return badOrder(venue, this.name, `a post-only order at ${o.limitPrice} would have taken liquidity, so it was not placed`);
    if (fill) {
      const done = this.execute(rec, m, fill);
      if (isRefusal(done)) return done;
    } else if (o.type === "market" || o.tif === "ioc" || o.tif === "fok" || (rec.triggered && o.type === "stop")) {
      rec.status = "canceled";
      rec.note = "nothing filled inside its price, so it was canceled";
    } else {
      const n = this.resting(o, m);
      if (n && this.available(n.ledger, n.asset) + 1e-9 < n.amount) return this.short(venue, n);
      rec.hold = n;
      this.hold(n, 1);
      rec.until = this.lapsesAt(o, m);
      // taken, not on the book yet: it goes there at the open
      if (!live) rec.status = "pending";
    }
    this.recs.set(rec.ref, rec);
    this.clients.set(o.clientId, rec.ref);
    return this.view(rec);
  }

  cancel(venue: string, ref: string): OrderState | Refusal {
    const rec = this.recs.get(ref);
    if (!rec) return no("E_VENUE_REJECTED", { venue, message: `${this.name} has no order ${ref}` });
    if (rec.status === "open" || rec.status === "partial" || rec.status === "pending") {
      this.release(rec);
      rec.status = "canceled";
    }
    return this.view(rec);
  }

  status(venue: string, ref: string): OrderState | Refusal {
    const rec = this.recs.get(ref);
    return rec ? this.view(rec) : no("E_VENUE_REJECTED", { venue, message: `${this.name} has no order ${ref}` });
  }

  amend(venue: string, ref: string, change: OrderChange): OrderState | Refusal {
    const rec = this.recs.get(ref);
    if (!rec) return no("E_VENUE_REJECTED", { venue, message: `${this.name} has no order ${ref}` });
    if (rec.status !== "open") return no("E_VENUE_REJECTED", { venue, message: `${this.name}: the order is ${rec.status}, so there is nothing to change` });
    const m = this.market(rec.req.symbol);
    if (!m?.open) return no("E_VENUE_MARKET_CLOSED", { venue, message: `${this.name}: the market takes no changes now` });
    const before = { req: rec.req, hold: rec.hold, triggered: rec.triggered };
    const next: OrderRequest = { ...rec.req, ...(change.qty !== undefined ? { qty: change.qty } : {}), ...(change.limitPrice !== undefined ? { limitPrice: change.limitPrice } : {}), ...(change.stopPrice !== undefined ? { stopPrice: change.stopPrice } : {}) };
    if (!(next.qty > 0) || (m.minQty !== undefined && next.qty < m.minQty - 1e-12) || !onStep(next.qty, m.qtyStep)) return badOrder(venue, this.name, `a size in ${m.name} is at least ${m.minQty ?? m.qtyStep ?? 0} and moves in steps of ${m.qtyStep ?? "any amount"}`);
    const undo = (r: Refusal): Refusal => {
      Object.assign(rec, before);
      this.hold(before.hold, 1);
      return r;
    };
    this.release(rec);
    rec.req = next;
    const fill = this.fillOf(rec, m, false);
    if (next.postOnly && fill && !fill.maker) return undo(badOrder(venue, this.name, `a post-only order at ${next.limitPrice} would take liquidity: it was left as it was`));
    if (fill) {
      const done = this.execute(rec, m, fill);
      if (isRefusal(done)) return undo(done);
    } else {
      const n = this.resting(next, m);
      if (n && this.available(n.ledger, n.asset) + 1e-9 < n.amount) return undo(this.short(venue, n));
      rec.hold = n;
      this.hold(n, 1);
    }
    return this.view(rec);
  }

  /** a few seconds passed: what rests is filled where the price crossed it, a stop fires, an order in a market that closed expires, a day
   * order lapses at its session's close, and what a venue held while its market was closed goes to the book at the open */
  sweep(): void {
    for (const rec of this.recs.values()) {
      if (rec.status !== "open" && rec.status !== "pending") continue;
      const m = this.market(rec.req.symbol);
      if (!m) continue;
      if (!m.open) {
        this.release(rec);
        rec.status = "expired";
        rec.note = "the market closed";
        continue;
      }
      if (rec.until !== undefined && w().clock() >= rec.until) {
        this.release(rec);
        rec.status = "expired";
        rec.note = "a day order: its session closed";
        continue;
      }
      if (!this.inSession(m)) continue;
      // held for the open: on the book now, as if placed now — one that crosses the book takes it at the opening price
      const opening = rec.status === "pending";
      if (opening) rec.status = "open";
      const fill = this.fillOf(rec, m, !opening);
      if (!fill) {
        if (rec.triggered && rec.req.type === "stop") {
          this.release(rec);
          rec.status = "canceled";
          rec.note = "the stop fired, and nothing filled inside its worst price";
        }
        continue;
      }
      const done = this.execute(rec, m, fill);
      if (isRefusal(done)) {
        rec.status = "canceled";
        rec.note = `canceled by ${this.name}: ${String((done.native as { said?: string } | undefined)?.said ?? done.message)}`;
      }
    }
    this.after();
  }
  protected after(): void {}

  /** the orders not finished yet (the harness reads them) */
  openOrders(): Array<{ ref: string; symbol: string; side: string; type: string; status: OrderStatus }> {
    return [...this.recs.values()].filter((r) => !DONE.has(r.status)).map((r) => ({ ref: r.ref, symbol: r.req.symbol, side: r.req.side, type: r.req.type, status: r.status }));
  }

  private view(rec: Rec): OrderState {
    return { ref: rec.ref, status: rec.status, filledQty: rec.filledQty, ...(rec.avgPrice !== undefined ? { avgPrice: rec.avgPrice } : {}), ...(rec.feeUsd ? { feeUsd: rec.feeUsd } : {}), native: { venue: this.name, standIn: true, id: rec.ref, symbol: rec.req.symbol, side: rec.req.side, type: rec.req.type, qty: rec.req.qty, status: rec.status, ...(rec.note ? { note: rec.note } : {}) } };
  }

  /** a market's 20 best matches for what was typed: in its symbol, its base, its name, its question or its category */
  matching(q: string): Market[] {
    const all = this.markets();
    const t = q.trim().toLowerCase();
    if (!t) return all.slice(0, 20);
    return all.filter((m) => [m.symbol, m.base, m.name, m.group?.title, m.category].some((f) => typeof f === "string" && f.toLowerCase().includes(t))).slice(0, 20);
  }
}

const notFound = (venue: string, name: string, symbol: string): Refusal => no("E_VENUE_REJECTED", { venue, message: `${name} lists no market called ${symbol}` });

// ---- the exchange -------------------------------------------------------------------------------------------------------------------

export interface CoinSpec {
  symbol: string;
  base: string;
  quote: string;
  /** its price curve */
  key: string;
  qtyStep: number;
  minQty: number;
  priceStep: number;
  /** the book's width, as a fraction of the price */
  spread: number;
  /** dollars traded a day */
  volume: number;
  perp?: { maxLeverage: number; funding: number; basis: number } | undefined;
  /** a perpetual on a private company's implied valuation (live/preipo.ts): the company it stands for; its price is in the $1-per-$1,000,000,000 unit */
  preipo?: { slug: string; name: string } | undefined;
}

const nextFunding = (now: number): string => new Date(Math.ceil((now + 1) / (8 * HOUR)) * 8 * HOUR).toISOString();

export class ExchangeBook extends Book {
  /** perpetuals held: symbol → size (negative: short) and entry price */
  readonly positions = new Map<string, { qty: number; entry: number }>();
  readonly leverage = new Map<string, { leverage: number; marginMode: "cross" | "isolated" }>();

  constructor(
    tag: string,
    name: string,
    readonly specs: CoinSpec[],
  ) {
    super(tag, name, { taker: 0.0006, maker: 0.0002 });
  }

  priceOf(s: CoinSpec): number {
    return w().prices.now(s.key) * (s.perp?.basis ?? 1);
  }

  build(s: CoinSpec): Market {
    const now = w().clock();
    const p = this.priceOf(s);
    const half = Math.max(s.priceStep, (p * s.spread) / 2);
    const bid = toStep(p - half, s.priceStep, "floor");
    const ask = Math.max(toStep(p + half, s.priceStep, "ceil"), bid + s.priceStep);
    const day = w().prices.day(s.key);
    const volume = s.volume * (1 + 0.04 * Math.sin(now / (3 * HOUR) + (seedOf(s.symbol) % 7)));
    const common = { symbol: s.symbol, base: s.base, quote: s.quote, price: toStep(p, s.priceStep), bid: toStep(bid, s.priceStep), ask: toStep(ask, s.priceStep), minQty: s.minQty, qtyStep: s.qtyStep, priceStep: s.priceStep, open: true, types: ["market", "limit", "stop", "stop_limit"] as Market["types"], tifs: ["gtc", "ioc", "fok"] as Market["tifs"], postOnly: true, changePct24h: Number(day.changePct24h.toFixed(2)), change24h: toStep(day.change24h * (s.perp?.basis ?? 1), s.priceStep), volumeUsd24h: Math.round(volume) };
    if (!s.perp) return { ...common, name: `${s.base} / ${s.quote}`, kind: "spot", sellsReduce: true };
    const perp: Market = { ...common, name: `${s.base} perpetual`, kind: "perp", reduceOnly: true, maxLeverage: s.perp.maxLeverage, fundingRate: s.perp.funding, nextFundingAt: nextFunding(now) };
    if (!s.preipo) return perp;
    // a pre-IPO perpetual carries what the real ones carry (public-markets.ts, exchange-trade.ts): its category, its company, the valuation
    // its price implies in the venue's unit, and the issuer's own words where the issuer has given some
    const said = PRE_IPO_ISSUERS[s.preipo.slug];
    return { ...perp, name: `${s.preipo.name} pre-IPO perpetual`, category: PRE_IPO_CATEGORY, group: { id: `preipo:${s.preipo.slug}`, title: s.preipo.name }, implied: { perPoint: PRE_IPO_PER_POINT, unit: "a price of $1 stands for $1,000,000,000 of implied company valuation (a stand-in: nothing here is real)", usd: impliedUsd(common.price, PRE_IPO_PER_POINT) }, ...(said ? { issuer: said.issuer, eligibility: said.eligibility } : {}) };
  }

  markets(): Market[] {
    return this.specs.map((s) => this.build(s));
  }

  levOf(symbol: string): { leverage: number; marginMode: "cross" | "isolated" } {
    return this.leverage.get(symbol) ?? { leverage: 5, marginMode: "cross" };
  }

  protected override need(o: OrderRequest, m: Market, price: number): Need | undefined {
    const worth = notionalOf(m, o.qty, price);
    if (m.kind === "perp") return o.reduceOnly ? undefined : { ledger: "futures", asset: m.quote, amount: worth / this.levOf(m.symbol).leverage + worth * this.fees.taker };
    return o.side === "buy" ? { ledger: "spot", asset: m.quote, amount: worth * (1 + this.fees.taker) } : { ledger: "spot", asset: m.base, amount: o.qty };
  }

  protected override check(venue: string, o: OrderRequest, m: Market): Refusal | undefined {
    if (m.kind !== "perp" || !o.reduceOnly) return undefined;
    const pos = this.positions.get(m.symbol);
    const sign = o.side === "buy" ? 1 : -1;
    if (!pos || Math.sign(pos.qty) === sign || o.qty > Math.abs(pos.qty) + 1e-12) return badOrder(venue, this.name, `a reduce-only order can only shrink a position: ${pos ? `the position is ${pos.qty > 0 ? "long" : "short"} ${Math.abs(pos.qty)}` : "there is no position"} in ${m.name}`);
    return undefined;
  }

  protected override locked(ledger: string, asset: string): number {
    if (ledger !== "futures") return 0;
    let used = 0;
    for (const [symbol, p] of this.positions) {
      const s = this.specs.find((x) => x.symbol === symbol);
      if (s?.quote === asset) used += (Math.abs(p.qty) * p.entry) / this.levOf(symbol).leverage;
    }
    return used;
  }

  protected override settle(o: OrderRequest, m: Market, price: number, fee: number): void {
    const worth = notionalOf(m, o.qty, price);
    if (m.kind !== "perp") {
      if (o.side === "buy") {
        this.add("spot", m.quote, -(worth + fee));
        this.add("spot", m.base, o.qty);
      } else {
        this.add("spot", m.base, -o.qty);
        this.add("spot", m.quote, worth - fee);
      }
      return;
    }
    const pos = this.positions.get(m.symbol) ?? { qty: 0, entry: price };
    const delta = o.side === "buy" ? o.qty : -o.qty;
    let realized = 0;
    if (pos.qty === 0 || Math.sign(pos.qty) === Math.sign(delta)) {
      const q = units(pos.qty + delta);
      this.positions.set(m.symbol, { qty: q, entry: (Math.abs(pos.qty) * pos.entry + Math.abs(delta) * price) / Math.abs(q) });
    } else {
      const closing = Math.min(Math.abs(delta), Math.abs(pos.qty));
      realized = (price - pos.entry) * closing * Math.sign(pos.qty);
      const q = units(pos.qty + delta);
      if (Math.abs(q) < 1e-12) this.positions.delete(m.symbol);
      else this.positions.set(m.symbol, { qty: q, entry: Math.sign(q) === Math.sign(pos.qty) ? pos.entry : price });
    }
    this.add("futures", m.quote, realized - fee);
  }

  positionsView(): Position[] {
    const out: Position[] = [];
    for (const [symbol, p] of this.positions) {
      const s = this.specs.find((x) => x.symbol === symbol);
      if (!s) continue;
      const mark = toStep(this.priceOf(s), s.priceStep);
      const lev = this.levOf(symbol);
      const liq = p.qty > 0 ? p.entry * (1 - 1 / lev.leverage + 0.005) : p.entry * (1 + 1 / lev.leverage - 0.005);
      out.push({ symbol, name: `${s.base} perpetual`, kind: "perp", side: p.qty > 0 ? "long" : "short", qty: Math.abs(p.qty), entryPrice: toStep(p.entry, s.priceStep), markPrice: mark, usd: r2(Math.abs(p.qty) * mark), unrealizedUsd: r2((mark - p.entry) * p.qty), leverage: lev.leverage, marginMode: lev.marginMode, liquidationPrice: toStep(liq, s.priceStep), native: { venue: this.name, standIn: true } });
    }
    return out;
  }

  setLeverage(venue: string, symbol: string, leverage: number, marginMode?: "cross" | "isolated"): { leverage: number; marginMode?: "cross" | "isolated" | undefined; native: unknown } | Refusal {
    const s = this.specs.find((x) => x.symbol === symbol);
    if (!s?.perp) return badOrder(venue, this.name, `${symbol} is not a perpetual here: leverage is set on a perpetual`);
    if (!(Number.isInteger(leverage) && leverage >= 1 && leverage <= s.perp.maxLeverage)) return badOrder(venue, this.name, `leverage in ${s.base} perpetual is a whole number from 1 to ${s.perp.maxLeverage}`);
    const was = this.levOf(symbol);
    const mode = marginMode ?? was.marginMode;
    if (this.positions.has(symbol) && mode !== was.marginMode) return no("E_VENUE_REJECTED", { venue, message: `${this.name}: the margin mode cannot change while a position is open`, native: { said: "margin mode cannot be changed with an open position" } });
    this.leverage.set(symbol, { leverage, marginMode: mode });
    // the margin a smaller leverage needs is there, or the venue says no
    if (this.available("futures", s.quote) < -1e-9) {
      this.leverage.set(symbol, was);
      return no("E_VENUE_INSUFFICIENT", { venue, message: `${this.name}: not enough margin for ${leverage}x`, native: { said: `insufficient margin for leverage ${leverage}` } });
    }
    return { leverage, marginMode: mode, native: { venue: this.name, standIn: true, symbol, leverage, marginMode: mode } };
  }

  read(): LiveBalance[] {
    const out: LiveBalance[] = [];
    for (const [k, amount] of this.balances) {
      if (Math.abs(amount) < 1e-12) continue;
      const [ledger, asset] = k.split("|") as [string, string];
      const s = this.specs.find((x) => x.base === asset && !x.perp);
      out.push({ asset, amount, where: ledger, ...(isStable(asset) ? { usd: amount, class: asset === "USD" ? ("cash" as const) : ("stable" as const) } : s ? { usd: amount * this.priceOf(s), class: "crypto" as const } : {}) });
    }
    return out;
  }

  stats(symbols?: string[]): Map<string, MarketStats> {
    const out = new Map<string, MarketStats>();
    for (const m of this.markets()) {
      if (symbols && !symbols.includes(m.symbol)) continue;
      const s = this.specs.find((x) => x.symbol === m.symbol)!;
      const d = w().prices.day(s.key);
      out.set(m.symbol, { price: m.price, changePct24h: m.changePct24h, change24h: m.change24h, volumeUsd24h: m.volumeUsd24h, high24h: toStep(d.high24h, s.priceStep), low24h: toStep(d.low24h, s.priceStep) });
    }
    return out;
  }

  candles(venue: string, symbol: string, interval: CandleInterval, since: number): Candle[] | Refusal {
    const s = this.specs.find((x) => x.symbol === symbol);
    if (!s) return notFound(venue, this.name, symbol);
    const b = s.perp?.basis ?? 1;
    return w().prices.candles(s.key, interval, since, s.volume).map((c) => ({ t: c.t, o: toStep(c.o * b, s.priceStep), h: toStep(c.h * b, s.priceStep), l: toStep(c.l * b, s.priceStep), c: toStep(c.c * b, s.priceStep), ...(c.v !== undefined ? { v: c.v } : {}) }));
  }

  // ---- money between its own ledgers, a stablecoin swap, a withdrawal to an agent wallet of the account's ----
  private moves = new Map<string, { at: number; address: string; network: ChainName; asset: string; amount: number; landed: boolean }>();
  private moveSeq = 0;

  writer(venue: string): LiveWriter {
    const name = this.name;
    return {
      can: { withdraw: true, ledgers: ["spot", "futures"], transfer: true, swap: true, receive: false, send: false },
      depositAddress: async () => no("E_VENUE_RAIL_CLOSED", { venue, message: `${name} is a stand-in: it gives no deposit address, and nothing real can be sent to it` }),
      withdrawFee: async () => 1,
      withdraw: async (r) => {
        if (!isStable(r.asset)) return no("E_VENUE_CURRENCY", { venue, message: `${name} withdraws dollar stablecoins only` });
        const fee = 1;
        if (this.available("spot", r.asset) + 1e-9 < r.amount + fee) return no("E_VENUE_INSUFFICIENT", { venue, message: `${name}: not enough ${r.asset} in spot for this withdrawal and its $1 fee`, native: { said: `insufficient ${r.asset}: ${show(this.available("spot", r.asset))} available, ${show(r.amount + fee)} needed` } });
        this.add("spot", r.asset, -(r.amount + fee));
        const ref = `${this.tag}-wd-${++this.moveSeq}`;
        this.moves.set(ref, { at: w().clock(), address: r.address.toLowerCase(), network: r.network, asset: r.asset, amount: r.amount, landed: false });
        return { ref, status: "pending", native: { venue: name, standIn: true, withdrawal: ref, network: r.network, to: r.address, amount: r.amount, fee } };
      },
      transfer: async (r) => {
        const ledgers = ["spot", "futures"];
        if (!ledgers.includes(r.from) || !ledgers.includes(r.to) || r.from === r.to) return no("E_VENUE_REJECTED", { venue, message: `${name} moves money between spot and futures` });
        if (this.available(r.from, r.asset) + 1e-9 < r.amount) return no("E_VENUE_INSUFFICIENT", { venue, message: `${name}: not enough ${r.asset} free in ${r.from}`, native: { said: `insufficient ${r.asset} in ${r.from}: ${show(Math.max(0, this.available(r.from, r.asset)))} available` } });
        this.add(r.from, r.asset, -r.amount);
        this.add(r.to, r.asset, r.amount);
        return { ref: `${this.tag}-tr-${++this.moveSeq}`, status: "settled", native: { venue: name, standIn: true, from: r.from, to: r.to, asset: r.asset, amount: r.amount } };
      },
      swap: async (r) => {
        if (!isStable(r.sell) || !isStable(r.buy) || r.sell === r.buy) return no("E_VENUE_CURRENCY", { venue, message: `${name} swaps one dollar stablecoin for another` });
        if (this.available("spot", r.sell) + 1e-9 < r.amount) return no("E_VENUE_INSUFFICIENT", { venue, message: `${name}: not enough ${r.sell} in spot`, native: { said: `insufficient ${r.sell}: ${show(Math.max(0, this.available("spot", r.sell)))} available` } });
        const received = Number((r.amount * (1 - 0.0001)).toFixed(6));
        this.add("spot", r.sell, -r.amount);
        this.add("spot", r.buy, received);
        return { ref: `${this.tag}-sw-${++this.moveSeq}`, status: "settled", received, native: { venue: name, standIn: true, sell: r.sell, buy: r.buy, amount: r.amount, received } };
      },
      // a withdrawal lands eight seconds after it was asked for: the stand-in chain credits the address it went to
      landed: async (ref) => {
        const m = this.moves.get(ref);
        if (!m) return "failed";
        if (!m.landed && w().clock() - m.at >= 8_000) {
          m.landed = true;
          // the token it lands as on that chain (USDT is USDT0 on Arbitrum and Polygon)
          const k = `${m.address}|${m.network}|${tokenOn(m.asset, m.network)?.asset ?? m.asset}`;
          w().chain.set(k, units((w().chain.get(k) ?? 0) + m.amount));
        }
        return m.landed ? "settled" : "pending";
      },
    };
  }

  trader(venue: string, what: string): LiveTrader {
    const name = this.name;
    const hasPerps = this.specs.some((s) => s.perp);
    const t: LiveTrader = {
      can: true,
      what,
      // the kinds it trades, said by the trader itself as the mm trader says them: the page's Trade grid reads them
      kinds: hasPerps ? ["spot", "perp"] : ["spot"],
      markets: async (q) => this.matching(q),
      market: async (symbol) => this.market(symbol) ?? notFound(venue, name, symbol),
      place: async (o) => this.place(venue, o),
      cancel: async (ref) => this.cancel(venue, ref),
      status: async (ref) => this.status(venue, ref),
      amend: async (ref, _symbol, change) => this.amend(venue, ref, change),
      stats: async (symbols) => this.stats(symbols),
      candles: async (symbol, interval, since) => this.candles(venue, symbol, interval, since),
    };
    if (hasPerps) {
      t.positions = async () => this.positionsView();
      t.setLeverage = async (symbol, leverage, marginMode) => this.setLeverage(venue, symbol, leverage, marginMode);
    }
    return t;
  }
}

// ---- the event market ---------------------------------------------------------------------------------------------------------------

export interface EventSpec {
  id: string;
  title: string;
  category: string;
  /** the venue's own tags for it, as Gamma gives an event several (the public listing carries them; one under an excluded word is left out) */
  tags?: string[] | undefined;
  /** when it stops trading */
  closeAt: number;
  /** YES now, and its change over 24 hours in dollars per contract */
  yes: number;
  change: number;
  volume: number;
  vol?: number | undefined;
}

const ROLL_MS = 15 * MINUTE;
const etTime = (ms: number): string => new Date(ms).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
const stamp = (ms: number): string => new Date(ms).toISOString().slice(2, 16).replace(/[-T:]/g, "");
const cents = (p: number): number => Math.min(0.99, Math.max(0.01, Math.round(p * 100) / 100));

export class EventBook extends Book {
  /** what was paid for each contract held, in all */
  readonly cost = new Map<string, number>();
  /** what the rolling fifteen-minute markets paid out when they settled */
  readonly settled: Array<{ symbol: string; qty: number; paid: number; at: string }> = [];

  constructor(
    tag: string,
    name: string,
    readonly events: EventSpec[],
    /** a fifteen-minute "Bitcoin up or down" that rolls over */
    readonly rolling: boolean,
  ) {
    super(tag, name, { taker: 0.007, maker: 0 });
  }

  private windowOf(now: number): { start: number; end: number; id: string } {
    const start = Math.floor(now / ROLL_MS) * ROLL_MS;
    return { start, end: start + ROLL_MS, id: `SI-BTC15-${stamp(start)}` };
  }

  /** the chance that bitcoin ends the window above where it started, at time `t` inside it */
  private upAt(start: number, t: number, live = false): number {
    const p0 = w().prices.at("BTC", start);
    const p = live ? w().prices.now("BTC") : w().prices.at("BTC", t);
    const left = Math.max(0, (start + ROLL_MS - t) / ROLL_MS);
    return 1 / (1 + Math.exp(-Math.log(p / p0) / (0.004 * Math.sqrt(left + 0.04))));
  }

  private leg(id: string, title: string, outcome: string, p: number, change: number, closeAt: number, category: string, volume: number, open: boolean): Market {
    const price = cents(p);
    return { symbol: `${id}:${outcome}`, name: `${title} · ${outcome.charAt(0) + outcome.slice(1).toLowerCase()}`, kind: "event", base: `${id}:${outcome}`, quote: "USD", price, bid: cents(price - 0.01), ask: cents(price + 0.01), minQty: 1, qtyStep: 1, priceStep: 0.01, open, ...(open ? {} : { note: "closed: waiting for the result" }), types: ["market", "limit"], tifs: ["gtc", "ioc", "fok"], postOnly: true, sellsReduce: true, change24h: Number(change.toFixed(2)), volumeUsd24h: Math.round(volume), closeTime: new Date(closeAt).toISOString(), category, group: { id, title }, outcome };
  }

  private legsOf(e: EventSpec, now: number): Market[] {
    const p = w().prices.now(`ev:${e.id}`);
    const d = w().prices.day(`ev:${e.id}`).change24h;
    const open = now < e.closeAt;
    return [this.leg(e.id, e.title, "YES", p, d, e.closeAt, e.category, e.volume, open), this.leg(e.id, e.title, "NO", 1 - p, -d, e.closeAt, e.category, e.volume, open)];
  }

  private rollingLegs(start: number, now: number): Market[] {
    const end = start + ROLL_MS;
    const id = `SI-BTC15-${stamp(start)}`;
    const title = `Bitcoin up or down · ${etTime(start)}–${etTime(end)} ET`;
    const open = now < end;
    const up = this.upAt(start, Math.min(now, end), open);
    const volume = 85_000 * Math.min(1, (Math.min(now, end) - start) / ROLL_MS + 0.2);
    return [this.leg(id, title, "UP", up, 0, end, "Crypto", volume, open), this.leg(id, title, "DOWN", 1 - up, 0, end, "Crypto", volume, open)];
  }

  markets(): Market[] {
    const now = w().clock();
    const out = this.events.filter((e) => now < e.closeAt).flatMap((e) => this.legsOf(e, now));
    if (this.rolling) out.push(...this.rollingLegs(this.windowOf(now).start, now));
    return out;
  }

  protected override closed(symbol: string): Market | undefined {
    const now = w().clock();
    const id = symbol.slice(0, symbol.lastIndexOf(":"));
    const e = this.events.find((x) => x.id === id);
    if (e) return this.legsOf(e, now).find((m) => m.symbol === symbol);
    const r = /^SI-BTC15-(\d{10})$/.exec(id);
    if (!this.rolling || !r) return undefined;
    const d = r[1]!;
    const start = Date.parse(`20${d.slice(0, 2)}-${d.slice(2, 4)}-${d.slice(4, 6)}T${d.slice(6, 8)}:${d.slice(8, 10)}:00Z`);
    return Number.isFinite(start) ? this.rollingLegs(start, now).find((m) => m.symbol === symbol) : undefined;
  }

  protected override need(o: OrderRequest, m: Market, price: number): Need | undefined {
    return o.side === "buy" ? { ledger: "cash", asset: "USD", amount: o.qty * price * (1 + this.fees.taker) } : { ledger: "pos", asset: m.symbol, amount: o.qty };
  }

  protected override settle(o: OrderRequest, m: Market, price: number, fee: number): void {
    const held = this.bal("pos", m.symbol);
    if (o.side === "buy") {
      this.add("cash", "USD", -(o.qty * price + fee));
      this.add("pos", m.symbol, o.qty);
      this.cost.set(m.symbol, (this.cost.get(m.symbol) ?? 0) + o.qty * price);
    } else {
      const avg = held > 0 ? (this.cost.get(m.symbol) ?? 0) / held : 0;
      this.cost.set(m.symbol, Math.max(0, (this.cost.get(m.symbol) ?? 0) - avg * o.qty));
      this.add("pos", m.symbol, -o.qty);
      this.add("cash", "USD", o.qty * price - fee);
    }
  }

  /** a fifteen-minute market that ended pays $1 a contract on the side that won, and nothing on the other */
  protected override after(): void {
    const now = w().clock();
    for (const [k, qty] of [...this.balances]) {
      const [ledger, symbol] = k.split("|") as [string, string];
      if (ledger !== "pos" || qty <= 0 || !symbol.startsWith("SI-BTC15-")) continue;
      const m = this.closed(symbol);
      if (!m?.closeTime || now < Date.parse(m.closeTime)) continue;
      const start = Date.parse(m.closeTime) - ROLL_MS;
      const won = (w().prices.at("BTC", start + ROLL_MS) > w().prices.at("BTC", start)) === symbol.endsWith(":UP");
      const paid = won ? qty : 0;
      this.add("pos", symbol, -qty);
      this.add("cash", "USD", paid);
      this.cost.delete(symbol);
      this.settled.push({ symbol, qty, paid, at: new Date(now).toISOString() });
    }
  }

  positionsView(): Position[] {
    const out: Position[] = [];
    for (const [k, qty] of this.balances) {
      const [ledger, symbol] = k.split("|") as [string, string];
      if (ledger !== "pos" || qty <= 0) continue;
      const m = this.market(symbol);
      const mark = m?.price;
      const cost = this.cost.get(symbol) ?? 0;
      out.push({ symbol, name: m?.name ?? symbol, kind: "event", side: "long", qty, ...(cost > 0 ? { entryPrice: Number((cost / qty).toFixed(4)) } : {}), ...(mark !== undefined ? { markPrice: mark, usd: r2(qty * mark), ...(cost > 0 ? { unrealizedUsd: r2(qty * mark - cost) } : {}) } : {}), native: { venue: this.name, standIn: true } });
    }
    return out;
  }

  read(): LiveBalance[] {
    const out: LiveBalance[] = [{ asset: "USD", amount: this.bal("cash", "USD"), usd: this.bal("cash", "USD"), class: "cash" }];
    for (const p of this.positionsView()) out.push({ asset: p.symbol, amount: p.qty, usd: p.usd ?? 0, where: `${this.market(p.symbol)?.open === false ? "closed · waiting for the result" : "at market"} · cost $${((p.entryPrice ?? 0) * p.qty).toFixed(2)}`, class: "event" });
    return out;
  }

  eventsList(o: { category?: string | undefined; closingWithinMs?: number | undefined; limit: number }): Market[] {
    const now = w().clock();
    const legs = this.markets().filter((m) => m.open && (!o.category || m.category?.toLowerCase() === o.category.toLowerCase()) && (o.closingWithinMs === undefined || Date.parse(m.closeTime!) <= now + o.closingWithinMs));
    const groups = [...new Set(legs.map((m) => m.group!.id))].sort((a, b) => (legs.find((m) => m.group!.id === b)!.volumeUsd24h ?? 0) - (legs.find((m) => m.group!.id === a)!.volumeUsd24h ?? 0)).slice(0, Math.max(1, o.limit));
    return legs.filter((m) => groups.includes(m.group!.id));
  }

  candles(venue: string, symbol: string, interval: CandleInterval, since: number): Candle[] | Refusal {
    const m = this.market(symbol);
    if (!m) return notFound(venue, this.name, symbol);
    const id = symbol.slice(0, symbol.lastIndexOf(":"));
    const flip = symbol.endsWith(":NO") || symbol.endsWith(":DOWN");
    let bars: Candle[];
    if (w().prices.has(`ev:${id}`)) bars = w().prices.candles(`ev:${id}`, interval, since);
    else {
      // a fifteen-minute market: its own short life, read off bitcoin's curve
      const start = Date.parse(m.closeTime!) - ROLL_MS;
      const size = interval === "5m" ? 5 * MINUTE : interval === "1h" ? HOUR : DAY;
      const now = Math.min(w().clock(), start + ROLL_MS);
      bars = [];
      for (let t = Math.max(start, Math.floor(since / size) * size); t <= now; t += size) {
        const end = Math.min(t + size, now);
        const o = this.upAt(start, t);
        const c = this.upAt(start, end);
        bars.push({ t, o, h: Math.max(o, c), l: Math.min(o, c), c });
      }
    }
    return bars.map((b) => (flip ? { t: b.t, o: cents(1 - b.o), h: cents(1 - b.l), l: cents(1 - b.h), c: cents(1 - b.c) } : { t: b.t, o: cents(b.o), h: cents(b.h), l: cents(b.l), c: cents(b.c) }));
  }

  trader(venue: string): LiveTrader {
    const name = this.name;
    return {
      can: true,
      what: "event contracts",
      kinds: ["event"],
      markets: async (q) => this.matching(q),
      market: async (symbol) => this.market(symbol) ?? notFound(venue, name, symbol),
      place: async (o) => this.place(venue, o),
      cancel: async (ref) => this.cancel(venue, ref),
      status: async (ref) => this.status(venue, ref),
      amend: async (ref, _symbol, change) => this.amend(venue, ref, change),
      positions: async () => this.positionsView(),
      events: async (o) => this.eventsList(o),
      candles: async (symbol, interval, since) => this.candles(venue, symbol, interval, since),
    };
  }
}

// ---- the wallet ---------------------------------------------------------------------------------------------------------------------

export interface TokenSpec {
  symbol: string;
  name: string;
  chain: ChainName;
  /** its price curve, and its price on that curve (WETH a hair under ETH) */
  key: string;
  factor: number;
  qtyStep: number;
  volume: number;
  /** a token that stands for a fund or a share: who issues it, and whom the issuer says it is not for (a stand-in's words) */
  rwa?: { issuer: string; eligibility: string } | undefined;
}

export class WalletBook extends Book {
  constructor(
    tag: string,
    name: string,
    readonly tokens: TokenSpec[],
  ) {
    super(tag, name, { taker: 0.003, maker: 0.003 });
  }

  private priceOf(t: TokenSpec): number {
    return w().prices.now(t.key) * t.factor;
  }

  markets(): Market[] {
    return this.tokens.map((t) => {
      const p = this.priceOf(t);
      const step = p > 1000 ? 0.01 : 0.0001;
      const day = w().prices.day(t.key);
      // a token an issuer stands behind carries the RWA category, its issuer and the issuer's words, as dex.ts's tokenised shares do
      return { symbol: `${t.symbol}/USDC@${t.chain}`, name: `${t.name} on ${t.chain}`, kind: "token" as MarketKind, base: t.symbol, quote: "USDC", price: toStep(p, step), bid: toStep(p * 0.9985, step, "floor"), ask: toStep(p * 1.0015, step, "ceil"), qtyStep: t.qtyStep, minNotional: 1, priceStep: step, open: true, note: "swapped by the stand-in wallet itself: nothing for a browser wallet to send", types: ["market"], changePct24h: Number(day.changePct24h.toFixed(2)), volumeUsd24h: t.volume, ...(t.rwa ? { category: RWA_CATEGORY, issuer: t.rwa.issuer, eligibility: t.rwa.eligibility } : {}) };
    });
  }

  private tokenOf(m: Market): TokenSpec {
    return this.tokens.find((t) => `${t.symbol}/USDC@${t.chain}` === m.symbol)!;
  }

  protected override need(o: OrderRequest, m: Market, price: number): Need | undefined {
    const t = this.tokenOf(m);
    return o.side === "buy" ? { ledger: t.chain, asset: "USDC", amount: o.qty * price * (1 + this.fees.taker) } : { ledger: t.chain, asset: t.symbol, amount: o.qty };
  }

  protected override settle(o: OrderRequest, m: Market, price: number, fee: number): void {
    const t = this.tokenOf(m);
    if (o.side === "buy") {
      this.add(t.chain, "USDC", -(o.qty * price + fee));
      this.add(t.chain, t.symbol, o.qty);
    } else {
      this.add(t.chain, t.symbol, -o.qty);
      this.add(t.chain, "USDC", o.qty * price - fee);
    }
  }

  read(): LiveBalance[] {
    const out: LiveBalance[] = [];
    for (const [k, amount] of this.balances) {
      if (amount <= 1e-12) continue;
      const [chain, asset] = k.split("|") as [string, string];
      const t = this.tokens.find((x) => x.symbol === asset && x.chain === chain);
      out.push({ asset, amount, where: chain, ...(isStable(asset) ? { usd: amount, class: "stable" as const } : t ? { usd: amount * this.priceOf(t), class: t.rwa ? ("rwa" as const) : ("crypto" as const) } : {}) });
    }
    return out;
  }

  trader(venue: string): LiveTrader {
    const name = this.name;
    return {
      can: true,
      what: "tokens, swapped from this wallet",
      kinds: ["token"],
      markets: async (q) => this.matching(q),
      market: async (symbol) => this.market(symbol) ?? notFound(venue, name, symbol),
      place: async (o) => this.place(venue, o),
      cancel: async (ref) => this.cancel(venue, ref),
      status: async (ref) => this.status(venue, ref),
      stats: async (symbols) => new Map(this.markets().filter((m) => !symbols || symbols.includes(m.symbol)).map((m) => [m.symbol, { price: m.price, changePct24h: m.changePct24h, volumeUsd24h: m.volumeUsd24h }] as const)),
      candles: async (symbol, interval, since) => {
        const t = this.tokens.find((x) => `${x.symbol}/USDC@${x.chain}` === symbol);
        if (!t) return notFound(venue, name, symbol);
        return w().prices.candles(t.key, interval, since, t.volume).map((c) => ({ t: c.t, o: c.o * t.factor, h: c.h * t.factor, l: c.l * t.factor, c: c.c * t.factor }));
      },
    };
  }
}

// ---- the stock broker: New York's market hours -------------------------------------------------------------------------------------

const NY_PARTS = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const nyParts = (ms: number): { y: number; mo: number; d: number; h: number; mi: number } => {
  const p = Object.fromEntries(NY_PARTS.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: Number(p.hour), mi: Number(p.minute) };
};
/** a moment as Alpaca's note gives its clock's next open (alpaca.ts nyTime): "2026-10-07 09:30", New York time */
const nyStamp = (ms: number): string => {
  const p = nyParts(ms);
  const two = (n: number): string => String(n).padStart(2, "0");
  return `${p.y}-${two(p.mo)}-${two(p.d)} ${two(p.h)}:${two(p.mi)}`;
};

/** The US stock market's regular session as the stand-in keeps it — the account's market calendar (account/calendar.ts nextRegularSession):
 * 09:30 to 16:00 New York time on a market day, the market's holidays closed — the one under way at `ms`, or else the next one. What the
 * broker says of its session (Market.session) is the same calendar's (regularSession), as Robinhood's is */
export function stockSession(ms: number): { open: boolean; opensAt: number; closesAt: number } {
  return nextRegularSession(ms);
}

export interface StockSpec {
  symbol: string;
  name: string;
  /** its price curve: NVDA's and SPY's are the stock tokens' own (STOCK_TOKENS), so a share and its token are priced alike */
  key: string;
  /** a fraction of a share is taken (Alpaca's `fractionable`): a size to nine decimals; otherwise whole shares only */
  fractionable: boolean;
  /** the book's width, as a fraction of the price */
  spread: number;
  /** dollars traded a day */
  volume: number;
}

const STOCK_TYPES: Market["types"] = ["market", "limit", "stop", "stop_limit"];
const whole = (qty: number): boolean => Math.abs(qty - Math.round(qty)) < 1e-9;

export class BrokerBook extends Book {
  constructor(
    tag: string,
    name: string,
    readonly stocks: StockSpec[],
  ) {
    // a US stock trade pays no commission at a broker like Alpaca
    super(tag, name, { taker: 0, maker: 0 });
  }

  private spec(symbol: string): StockSpec | undefined {
    return this.stocks.find((x) => x.symbol === symbol);
  }

  /** A stock as Alpaca's market() gives one (alpaca.ts): to nine decimals of a share or whole shares, $1 the smallest order, day and gtc, a
   * price step of a cent ($0.0001 under $1), a sell selling only what is held. While the market is closed it stays open for orders but takes
   * no market order, and says so in Alpaca's words with the next open; its session says it is out of session, and when it opens */
  build(s: StockSpec): Market {
    const now = w().clock();
    const session = stockSession(now);
    const p = w().prices.now(s.key);
    const step = p < 1 ? 0.0001 : 0.01;
    const half = Math.max(step, (p * s.spread) / 2);
    const bid = toStep(p - half, step, "floor");
    const ask = Math.max(toStep(p + half, step, "ceil"), toStep(bid + step, step));
    const day = w().prices.day(s.key);
    const volume = s.volume * (1 + 0.04 * Math.sin(now / (3 * HOUR) + (seedOf(s.symbol) % 7)));
    return {
      symbol: s.symbol,
      name: s.name,
      kind: "stock",
      base: s.symbol,
      quote: "USD",
      price: toStep(p, step),
      bid,
      ask,
      ...(s.fractionable ? {} : { minQty: 1 }),
      qtyStep: s.fractionable ? 1e-9 : 1,
      priceStep: step,
      minNotional: 1,
      open: true,
      // the session as Robinhood says one: the market calendar's, at the stand-in's clock (the calendar `session` above is read from too)
      session: regularSession(now),
      ...(session.open ? {} : { note: `the US stock market is closed: ${this.name} holds an order and sends it when the market opens (${nyStamp(session.opensAt)} New York time). Until then no market order is placed here: it would fill at the opening price, which can be well away from this one. A limit, stop or stop-limit order waits for the open with its limit` }),
      types: session.open ? [...STOCK_TYPES] : STOCK_TYPES.filter((t) => t !== "market"),
      tifs: ["day", "gtc"],
      sellsReduce: true,
      changePct24h: Number(day.changePct24h.toFixed(2)),
      change24h: toStep(day.change24h, step),
      volumeUsd24h: Math.round(volume),
    };
  }

  markets(): Market[] {
    return this.stocks.map((s) => this.build(s));
  }

  protected override inSession(): boolean {
    return stockSession(w().clock()).open;
  }

  /** the time in force an order has here: its own, or Alpaca's default for it — a fraction of a share and a market order are day orders,
   * anything else gtc (alpaca.ts place) */
  private tifOf(o: OrderRequest): TimeInForce {
    return o.tif ?? (!whole(o.qty) || o.type === "market" ? "day" : "gtc");
  }

  /** a day order lapses at the close of the session it is for: the one under way, or — taken while the market is closed — the next one */
  protected override lapsesAt(o: OrderRequest): number | undefined {
    return this.tifOf(o) === "day" ? stockSession(w().clock()).closesAt : undefined;
  }

  protected override check(venue: string, o: OrderRequest): Refusal | undefined {
    // Alpaca's own rule (alpaca.ts place): a fraction of a share is a day order
    if (!whole(o.qty) && this.tifOf(o) !== "day") return badOrder(venue, this.name, `a fraction of a share is a day order, not ${this.tifOf(o)}`);
    return undefined;
  }

  protected override need(o: OrderRequest, m: Market, price: number): Need | undefined {
    return o.side === "buy" ? { ledger: "cash", asset: "USD", amount: notionalOf(m, o.qty, price) * (1 + this.fees.taker) } : { ledger: "stocks", asset: m.base, amount: o.qty };
  }

  protected override settle(o: OrderRequest, m: Market, price: number, fee: number): void {
    const worth = notionalOf(m, o.qty, price);
    if (o.side === "buy") {
      this.add("cash", "USD", -(worth + fee));
      this.add("stocks", m.base, o.qty);
    } else {
      this.add("stocks", m.base, -o.qty);
      this.add("cash", "USD", worth - fee);
    }
  }

  /** the cash, and each stock held at what it is worth now — as Alpaca's account and positions read (alpaca.ts) */
  read(): LiveBalance[] {
    const out: LiveBalance[] = [{ asset: "USD", amount: this.bal("cash", "USD"), usd: this.bal("cash", "USD"), where: "cash", class: "cash" }];
    for (const s of this.stocks) {
      const qty = this.bal("stocks", s.symbol);
      if (qty > 1e-12) out.push({ asset: s.symbol, amount: qty, usd: qty * w().prices.now(s.key), where: "stocks", class: "equity" });
    }
    return out;
  }

  stats(symbols?: string[]): Map<string, MarketStats> {
    const out = new Map<string, MarketStats>();
    for (const m of this.markets()) {
      if (symbols && !symbols.includes(m.symbol)) continue;
      const d = w().prices.day(this.spec(m.symbol)!.key);
      const step = m.priceStep ?? 0.01;
      out.set(m.symbol, { price: m.price, changePct24h: m.changePct24h, change24h: m.change24h, volumeUsd24h: m.volumeUsd24h, high24h: toStep(d.high24h, step), low24h: toStep(d.low24h, step) });
    }
    return out;
  }

  candles(venue: string, symbol: string, interval: CandleInterval, since: number): Candle[] | Refusal {
    const s = this.spec(symbol);
    if (!s) return notFound(venue, this.name, symbol);
    return w().prices.candles(s.key, interval, since, s.volume).map((c) => ({ t: c.t, o: toStep(c.o, 0.01), h: toStep(c.h, 0.01), l: toStep(c.l, 0.01), c: toStep(c.c, 0.01), ...(c.v !== undefined ? { v: c.v } : {}) }));
  }

  /** a cash broker's trader: no positions call, no leverage, no order changed in place */
  trader(venue: string): LiveTrader {
    const name = this.name;
    return {
      can: true,
      what: "US stocks and ETFs",
      // the kind it trades, said by the trader itself as every stand-in's is (a broker's, as accounts.ts tradeKinds gives Robinhood's)
      kinds: ["stock"],
      markets: async (q) => this.matching(q),
      market: async (symbol) => this.market(symbol) ?? notFound(venue, name, symbol),
      place: async (o) => this.place(venue, o),
      cancel: async (ref) => this.cancel(venue, ref),
      status: async (ref) => this.status(venue, ref),
      stats: async (symbols) => this.stats(symbols),
      candles: async (symbol, interval, since) => this.candles(venue, symbol, interval, since),
    };
  }
}

// ---- what the stand-in trades, and where it starts --------------------------------------------------------------------------------

const H = HOUR;
const D = DAY;

/** the curves: coins, a fund token, stocks (the broker's shares and the stock tokens share theirs), and each event's YES */
function curves(prices: PriceBook, t0: number): { events: EventSpec[]; publicEvents: EventSpec[] } {
  const coins: Array<[string, number, number, number]> = [
    ["BTC", 62_480, 2.3, 1],
    ["ETH", 2_455.6, 3.8, 1.2],
    ["SOL", 142.85, -1.6, 1.6],
    ["DOGE", 0.1214, 12.4, 2.4],
    ["AVAX", 24.37, -8.2, 2],
    ["LINK", 13.92, 4.9, 1.6],
    ["USDY", 1.1052, 0.01, 0.015],
    ["AAPL", 228.4, 0.8, 0.5],
    ["NVDA", 182.4, 1.9, 0.6],
    ["TSLA", 251.3, -2.7, 0.9],
    ["SPY", 662.1, 0.4, 0.3],
    // Anthropic's implied valuation in the pre-IPO perpetuals' unit: about $2.1 trillion, as the real venues quoted it on 2026-10-06
    ["ANTHROPIC", 2_100, 1.2, 0.5],
  ];
  for (const [key, price, change24h, vol] of coins) prices.add(key, { price, change24h, vol });
  const events: EventSpec[] = [
    { id: "SI-FEDCUT-DEC", title: "Will the Fed cut rates at its December meeting?", category: "Economics", closeAt: t0 + 9 * D + 3 * H, yes: 0.62, change: 0.04, volume: 1_840_000, vol: 0.8 },
    { id: "SI-CPI-NEXT", title: "Will US inflation come in above 3.0% in the next CPI report?", category: "Economics", closeAt: t0 + 2 * D + 5 * H, yes: 0.41, change: -0.03, volume: 620_000 },
    { id: "SI-ETH-WEEK", title: "Will ETH close the week above $2,500?", category: "Crypto", closeAt: t0 + 4 * D + 7 * H, yes: 0.38, change: 0.06, volume: 410_000, vol: 1.2 },
    { id: "SI-FINAL-HOME", title: "Will the home side win Sunday's championship final?", category: "Sports", closeAt: t0 + 3 * D + 20 * H, yes: 0.55, change: -0.02, volume: 960_000 },
    { id: "SI-RAIN-NYC", title: "Will it rain in New York tomorrow?", category: "Weather", closeAt: t0 + 20 * H + 35 * MINUTE, yes: 0.33, change: 0.05, volume: 74_000, vol: 0.6 },
    // an IPO question, under the venue's own word for it (categories.ts isIpoCategory): it stays in Predictions beside the busiest few, and
    // the Pre-IPO company drawer names it
    { id: "SI-IPO-ANTHROPIC", title: "Will Anthropic IPO before January 1, 2027?", category: "IPO", closeAt: t0 + 86 * D + 5 * H, yes: 0.64, change: 0.03, volume: 215_000, vol: 0.5 },
  ];
  // the public event exchange's events carry tags as Gamma's do: the Sports one is there to be LEFT OUT of the public listing (categories.ts),
  // and the housekeeping tags ("Hide From New", "Recurring") are never the category shown
  const publicEvents: EventSpec[] = [
    { id: "SX-JOBS-NEXT", title: "Will the unemployment rate be 4.5% or higher in the next jobs report?", category: "Economics", tags: ["Jobs Report", "Economy", "Recurring"], closeAt: t0 + 6 * D + 2 * H, yes: 0.27, change: 0.02, volume: 530_000 },
    { id: "SX-OPENER-OT", title: "Will the season opener go to overtime?", category: "Sports", tags: ["Games", "Sports", "NFL (All)"], closeAt: t0 + 11 * H, yes: 0.18, change: -0.01, volume: 150_000, vol: 0.7 },
    { id: "SX-YIELD-FRI", title: "Will the 10-year Treasury yield close above 4.25% on Friday?", category: "Financials", tags: ["Hide From New", "Treasuries", "Finance"], closeAt: t0 + 2 * D + 2 * H, yes: 0.47, change: 0.03, volume: 380_000 },
  ];
  for (const e of [...events, ...publicEvents]) prices.add(`ev:${e.id}`, { price: e.yes, change24h: e.change, vol: e.vol, event: true });
  return { events, publicEvents };
}

const EX_COINS: CoinSpec[] = [
  { symbol: "BTC/USDT", base: "BTC", quote: "USDT", key: "BTC", qtyStep: 0.00001, minQty: 0.0001, priceStep: 0.1, spread: 0.0001, volume: 1.94e9 },
  { symbol: "ETH/USDT", base: "ETH", quote: "USDT", key: "ETH", qtyStep: 0.0001, minQty: 0.001, priceStep: 0.01, spread: 0.00012, volume: 8.4e8 },
  { symbol: "SOL/USDT", base: "SOL", quote: "USDT", key: "SOL", qtyStep: 0.001, minQty: 0.01, priceStep: 0.01, spread: 0.0002, volume: 3.1e8 },
  { symbol: "BTC/USDT:USDT", base: "BTC", quote: "USDT", key: "BTC", qtyStep: 0.001, minQty: 0.001, priceStep: 0.1, spread: 0.0001, volume: 4.2e9, perp: { maxLeverage: 50, funding: 0.0001, basis: 1.0003 } },
  { symbol: "ETH/USDT:USDT", base: "ETH", quote: "USDT", key: "ETH", qtyStep: 0.01, minQty: 0.01, priceStep: 0.01, spread: 0.00012, volume: 1.6e9, perp: { maxLeverage: 25, funding: 0.00008, basis: 1.0004 } },
  { symbol: "SOL/USDT:USDT", base: "SOL", quote: "USDT", key: "SOL", qtyStep: 0.1, minQty: 0.1, priceStep: 0.01, spread: 0.0002, volume: 5.2e8, perp: { maxLeverage: 20, funding: -0.00005, basis: 0.9998 } },
  // the pre-IPO perpetual, as a real exchange names it: a contract on Anthropic's implied valuation, about 2,100 in the $1-per-$1B unit
  { symbol: "ANTHROPIC/USDT:USDT", base: "ANTHROPIC", quote: "USDT", key: "ANTHROPIC", qtyStep: 0.001, minQty: 0.001, priceStep: 0.01, spread: 0.0005, volume: 1.4e6, perp: { maxLeverage: 20, funding: 0.00005, basis: 1 }, preipo: { slug: "anthropic", name: "Anthropic" } },
];

const PUB_COINS: CoinSpec[] = [
  { symbol: "BTC/USD", base: "BTC", quote: "USD", key: "BTC", qtyStep: 0.00001, minQty: 0.0001, priceStep: 0.1, spread: 0.00015, volume: 6.1e8 },
  { symbol: "ETH/USD", base: "ETH", quote: "USD", key: "ETH", qtyStep: 0.0001, minQty: 0.001, priceStep: 0.01, spread: 0.0002, volume: 2.9e8 },
  { symbol: "SOL/USD", base: "SOL", quote: "USD", key: "SOL", qtyStep: 0.001, minQty: 0.01, priceStep: 0.01, spread: 0.0003, volume: 9.5e7 },
  { symbol: "DOGE/USD", base: "DOGE", quote: "USD", key: "DOGE", qtyStep: 1, minQty: 10, priceStep: 0.00001, spread: 0.0004, volume: 8.2e8 },
  { symbol: "AVAX/USD", base: "AVAX", quote: "USD", key: "AVAX", qtyStep: 0.01, minQty: 0.1, priceStep: 0.001, spread: 0.0004, volume: 2.1e8 },
  { symbol: "LINK/USD", base: "LINK", quote: "USD", key: "LINK", qtyStep: 0.01, minQty: 0.1, priceStep: 0.001, spread: 0.0004, volume: 3.4e8 },
];

/** the public perp exchange's perpetuals (as Hyperliquid's keyless list is read in public-markets.ts): coins the connected exchange has no
 * perpetual of, so each is a Perps row of its own marked "Connect to trade" */
const PUB_PERPS: CoinSpec[] = [
  { symbol: "DOGE/USDC:USDC", base: "DOGE", quote: "USDC", key: "DOGE", qtyStep: 1, minQty: 10, priceStep: 0.00001, spread: 0.0004, volume: 2.6e8, perp: { maxLeverage: 10, funding: 0.0000125, basis: 1.0002 } },
  { symbol: "AVAX/USDC:USDC", base: "AVAX", quote: "USDC", key: "AVAX", qtyStep: 0.01, minQty: 0.1, priceStep: 0.001, spread: 0.0004, volume: 1.1e8, perp: { maxLeverage: 10, funding: -0.00002, basis: 0.9999 } },
  { symbol: "LINK/USDC:USDC", base: "LINK", quote: "USDC", key: "LINK", qtyStep: 0.01, minQty: 0.1, priceStep: 0.001, spread: 0.0004, volume: 1.5e8, perp: { maxLeverage: 10, funding: 0.00001, basis: 1.0001 } },
  // the same company's pre-IPO perpetual at an unconnected venue, a hair apart in price: Markets folds it into the connected one's row
  { symbol: "ANTHROPIC/USDC:USDC", base: "ANTHROPIC", quote: "USDC", key: "ANTHROPIC", qtyStep: 0.001, minQty: 0.001, priceStep: 0.01, spread: 0.0006, volume: 9.2e5, perp: { maxLeverage: 10, funding: 0.00005, basis: 1.004 }, preipo: { slug: "anthropic", name: "Anthropic" } },
];

const WALLET_TOKENS: TokenSpec[] = [
  { symbol: "WETH", name: "Wrapped Ether", chain: "Base", key: "ETH", factor: 0.9997, qtyStep: 0.0001, volume: 9.1e7 },
  { symbol: "cbBTC", name: "Coinbase Wrapped BTC", chain: "Base", key: "BTC", factor: 0.9995, qtyStep: 0.00001, volume: 6.3e7 },
  { symbol: "USDY", name: "Ondo US Dollar Yield (a tokenised fund)", chain: "Ethereum", key: "USDY", factor: 1, qtyStep: 0.01, volume: 3.2e6, rwa: { issuer: "Stand-in Issuer (not a real issuer)", eligibility: "the stand-in's words: not for US persons or anyone in a sanctioned place" } },
];

export const STOCK_TOKENS: Array<{ symbol: string; name: string; key: string; volume: number }> = [
  { symbol: "NVDA", name: "NVIDIA stock token", key: "NVDA", volume: 1.24e7 },
  { symbol: "TSLA", name: "Tesla stock token", key: "TSLA", volume: 9.1e6 },
  { symbol: "SPY", name: "S&P 500 ETF stock token", key: "SPY", volume: 4.3e6 },
];

/** the broker's stocks. NVDA and SPY are on the stock tokens' own curves, so Stocks and RWAs show a share and its token at one price; NVDA
 * is whole shares only here (most stocks are fractionable at Alpaca), so the ticket shows both kinds of size */
const BROKER_STOCKS: StockSpec[] = [
  { symbol: "AAPL", name: "Apple Inc. common stock", key: "AAPL", fractionable: true, spread: 0.0002, volume: 1.12e10 },
  { symbol: "NVDA", name: "NVIDIA Corporation common stock", key: "NVDA", fractionable: false, spread: 0.0002, volume: 3.05e10 },
  { symbol: "SPY", name: "SPDR S&P 500 ETF Trust", key: "SPY", fractionable: true, spread: 0.0001, volume: 2.71e10 },
];

/** Make the stand-in's world: the curves, the books with what they hold at the start (the exchange already holds a BTC perpetual), and
 * an empty stand-in chain. One world per process: the connectors registered below read the latest one */
export function makeWorld(o: { t0?: number | undefined; clock?: (() => number) | undefined } = {}): World {
  const clock = o.clock ?? Date.now;
  const t0 = o.t0 ?? clock();
  const prices = new PriceBook(t0, clock);
  const { events, publicEvents } = curves(prices, t0);
  const ex = new ExchangeBook("sx", "Stand-in Exchange", EX_COINS);
  for (const [ledger, asset, amount] of [["spot", "USDT", 4_200], ["spot", "USDC", 300], ["spot", "BTC", 0.12], ["spot", "ETH", 1.8], ["spot", "SOL", 25], ["futures", "USDT", 1_500]] as const) ex.add(ledger, asset, amount);
  // held at the venue before the account ever connected it: a small BTC long at 3x
  ex.positions.set("BTC/USDT:USDT", { qty: 0.01, entry: 60_520 });
  ex.leverage.set("BTC/USDT:USDT", { leverage: 3, marginMode: "cross" });
  const pubex = new ExchangeBook("px", "Stand-in Public Exchange", PUB_COINS);
  pubex.add("spot", "USD", 500);
  const pubperps = new ExchangeBook("pp", "Stand-in Perp Exchange", PUB_PERPS);
  pubperps.add("futures", "USDC", 400);
  const predict = new EventBook("se", "Stand-in Predictions", events, true);
  predict.add("cash", "USD", 640);
  const pubevents = new EventBook("pe", "Stand-in Event Exchange", publicEvents, false);
  pubevents.add("cash", "USD", 200);
  const wallet = new WalletBook("sw", "Stand-in Wallet", WALLET_TOKENS);
  for (const [chain, asset, amount] of [["Base", "USDC", 820], ["Base", "WETH", 0.35], ["Base", "cbBTC", 0.004], ["Ethereum", "USDY", 1_500], ["Ethereum", "USDC", 150]] as const) wallet.add(chain, asset, amount);
  // held at the broker before the account connected it: $2,000, two and a half shares of Apple, one of NVIDIA (ui-standin.ts makes them
  // three and two: the owner's market buys while the US market is open, held already while it is closed)
  const broker = new BrokerBook("sb", "Stand-in Broker", BROKER_STOCKS);
  for (const [ledger, asset, amount] of [["cash", "USD", 2_000], ["stocks", "AAPL", 2.5], ["stocks", "NVDA", 1]] as const) broker.add(ledger, asset, amount);
  const earn = new EarnBook(ex, EARN_PRODUCTS);
  current = { t0, clock, prices, ex, pubex, pubperps, predict, pubevents, wallet, broker, earn, chain: new Map() };
  return current;
}

/** a few seconds pass: prices step, every book fills what the price crossed, and earn finishes what was asked of it */
export function tick(world: World): void {
  world.prices.tick();
  for (const b of [world.ex, world.pubex, world.pubperps, world.predict, world.pubevents, world.wallet, world.broker]) b.sweep();
  world.earn.tick();
}

// ---- earn at the stand-in exchange ----------------------------------------------------------------------------------------------------

export interface EarnSpec {
  id: string;
  asset: string;
  name: string;
  apy: number;
  rateKind: "apy" | "apr";
  lockDays: number;
  minAmount: number;
  /** the price curve of an asset that is not a dollar */
  key?: string | undefined;
}

/** a flexible USDT product and a bonded ETH one */
export const EARN_PRODUCTS: EarnSpec[] = [
  { id: "flex:USDT", asset: "USDT", name: "USDT · Flexible (stand-in)", apy: 0.046, rateKind: "apy", lockDays: 0, minAmount: 1 },
  { id: "bond:ETH", asset: "ETH", name: "ETH · Bonded 7 days (stand-in)", apy: 0.032, rateKind: "apr", lockDays: 7, minAmount: 0.01, key: "ETH" },
];

interface EarnReq {
  ref: string;
  kind: "supply" | "withdraw";
  product: string;
  amount: number;
  all: boolean;
  status: EarnState["status"];
  /** the tick that finishes it */
  due: number;
}

/** The stand-in exchange's earn: money goes in from its spot ledger (out of the balance read at once, into the product) and comes back
 * there; each request is done on the next tick. What is in a product is never in the exchange's balance read, as at OKX */
export class EarnBook {
  /** product → what is in it, a supply still under way included */
  readonly held = new Map<string, number>();
  private readonly reqs = new Map<string, EarnReq>();
  private readonly byClient = new Map<string, string>();
  private ticks = 0;
  private seq = 0;

  constructor(
    readonly ex: ExchangeBook,
    readonly specs: EarnSpec[],
  ) {}

  private priceOf(s: EarnSpec): number | undefined {
    return isStable(s.asset) ? 1 : s.key && w().prices.has(s.key) ? w().prices.now(s.key) : undefined;
  }

  tick(): void {
    this.ticks++;
    for (const r of this.reqs.values()) {
      if (r.status !== "pending" || this.ticks < r.due) continue;
      const s = this.specs.find((x) => x.id === r.product)!;
      if (r.kind === "withdraw") {
        const have = this.held.get(r.product) ?? 0;
        const out = r.all ? have : Math.min(r.amount, have);
        this.held.set(r.product, units(have - out));
        this.ex.add("spot", s.asset, out);
      }
      r.status = "done";
    }
  }

  private productOf(s: EarnSpec, name: string): EarnProduct {
    const price = this.priceOf(s);
    return { id: s.id, asset: s.asset, name: s.name, apy: s.apy, rateKind: s.rateKind, protocol: "Stand-in Earn", minAmount: s.minAmount, lockDays: s.lockDays, ...(price !== undefined ? { priceUsd: price } : {}), lands: `your ${name} spot balance`, canSupply: true, canWithdraw: true, note: `${STANDIN}: each request is done on the next tick` };
  }

  private request(clientId: string, make: () => EarnReq | Refusal): EarnState | Refusal {
    const prior = this.byClient.get(clientId);
    if (prior) {
      const r = this.reqs.get(prior)!;
      return { ref: r.ref, status: r.status, native: { standIn: true, again: true } };
    }
    const r = make();
    if (isRefusal(r)) return r;
    this.reqs.set(r.ref, r);
    this.byClient.set(clientId, r.ref);
    return { ref: r.ref, status: r.status, native: { standIn: true, kind: r.kind, product: r.product, amount: r.amount } };
  }

  earner(venue: string, name: string): LiveEarner {
    const find = (id: string): EarnSpec | Refusal => this.specs.find((x) => x.id === id) ?? no("E_VENUE_REJECTED", { venue, message: `${name} offers no earn product ${id.slice(0, 40)}` });
    return {
      can: true,
      what: "stand-in earn: a flexible USDT product and a bonded ETH one",
      products: async (asset) => this.specs.filter((s) => !asset || s.asset === asset.toUpperCase()).map((s) => this.productOf(s, name)),
      product: async (id) => {
        const s = find(id);
        return isRefusal(s) ? s : this.productOf(s, name);
      },
      positions: async (): Promise<EarnPosition[]> =>
        this.specs.flatMap((s) => {
          const amount = this.held.get(s.id) ?? 0;
          if (!(amount > 0)) return [];
          const price = this.priceOf(s);
          const pending = [...this.reqs.values()].filter((r) => r.product === s.id && r.status === "pending" && r.kind === "supply").reduce((x, r) => x + r.amount, 0);
          return [{ product: s.id, id: s.id, asset: s.asset, amount, ...(price !== undefined ? { usd: r2(amount * price) } : {}), apy: s.apy, name: s.name, protocol: "Stand-in Earn", ...(pending ? { pending } : {}) }];
        }),
      supply: async (p, amount, clientId) =>
        this.request(clientId, () => {
          const s = find(p.id);
          if (isRefusal(s)) return s;
          if (this.ex.available("spot", s.asset) + 1e-9 < amount) return no("E_VENUE_INSUFFICIENT", { venue, message: `${name}: not enough ${s.asset} free in spot to put ${show(amount)} into ${s.name}`, native: { said: `insufficient ${s.asset}: ${show(Math.max(0, this.ex.available("spot", s.asset)))} available` } });
          this.ex.add("spot", s.asset, -amount);
          this.held.set(s.id, units((this.held.get(s.id) ?? 0) + amount));
          return { ref: `${this.ex.tag}-earn-${++this.seq}`, kind: "supply", product: s.id, amount, all: false, status: "pending", due: this.ticks + 1 };
        }),
      withdraw: async (p, amount, clientId, all) =>
        this.request(clientId, () => {
          const s = find(p.id);
          if (isRefusal(s)) return s;
          const have = this.held.get(s.id) ?? 0;
          if (!(have > 0) || (!all && amount > have + 1e-9)) return no("E_VENUE_INSUFFICIENT", { venue, message: `${name}: ${show(have)} ${s.asset} is in ${s.name}`, native: { said: `insufficient ${s.asset} in ${s.id}: ${show(have)}` } });
          return { ref: `${this.ex.tag}-earn-${++this.seq}`, kind: "withdraw", product: s.id, amount, all, status: "pending", due: this.ticks + 1 };
        }),
      status: async (ref) => {
        const r = this.reqs.get(ref);
        return r ? { ref, status: r.status, native: { standIn: true, kind: r.kind, product: r.product } } : no("E_VENUE_REJECTED", { venue, message: `${name} knows no earn request ${ref.slice(0, 40)}` });
      },
    };
  }
}

// ---- the connectors: each one a venue the owner connects through the real door --------------------------------------------------------

const probe = (can: string[]) => ({ can, note: STANDIN, native: { standIn: true } });
const readOnly = "a stand-in: no money is sent to it or from it here";

function exchangeSource(book: ExchangeBook, venue: string, label: string, what: string, withWriter: boolean): LiveSource {
  // the exchange that moves money also earns: its earner is the source's own, as the mm wallet's is
  return { name: label || book.name, kind: "cex", reference: "stand-in", via: `${book.name} · ${STANDIN}`, probe: probe(withWriter ? ["read", "trade", "transfer", "withdraw", "earn"] : ["read", "trade"]), read: async () => book.read(), trader: book.trader(venue, what), ...(withWriter ? { writer: book.writer(venue), earner: w().earn.earner(venue, label || book.name) } : { readOnlyBecause: readOnly }) };
}

/** the broker: read and traded; no money moves — a broker's cash moves by ACH, at the broker, as Robinhood says of itself and Alpaca of an
 * account without crypto wallets, so this stand-in gives no deposit address and makes no withdrawal */
function brokerSource(book: BrokerBook, venue: string, label: string): LiveSource {
  const name = label || book.name;
  return { name, kind: "broker", reference: "stand-in", via: `${book.name} · ${STANDIN}`, probe: probe(["read", "trade"]), read: async () => book.read(), trader: book.trader(venue), readOnlyBecause: `${name} is a stand-in: it gives no deposit address and makes no withdrawal, so no money is sent to it or from it here (a broker's cash moves by ACH, at the broker)` };
}

let registered = false;
/** add the stand-in connectors to the account's table of live connections (live/index.ts): once per process */
export function registerStandins(): void {
  if (registered) return;
  registered = true;
  const add = (kind: string, label: string, example: string, open: (venue: string, label: string) => LiveSource) =>
    register({ kind, label, needs: "cli", example, venues: [], async open(req) {
      const source = open(req.venue, req.label);
      const first = await source.read();
      return { source, first, summary: `${source.name} connected · ${STANDIN}` };
    } });
  add("standin-exchange", "Stand-in Exchange · spot and perpetuals (test harness)", `Spot BTC, ETH and SOL and their perpetuals; ${STANDIN}.`, (venue, label) => exchangeSource(w().ex, venue, label, "spot and perpetuals", true));
  add("standin-pubex", "Stand-in Public Exchange · spot (test harness)", `Spot coins priced in dollars, DOGE, AVAX and LINK among them; ${STANDIN}.`, (venue, label) => exchangeSource(w().pubex, venue, label, "spot", false));
  add("standin-pubperps", "Stand-in Perp Exchange · perpetuals (test harness)", `DOGE, AVAX and LINK perpetuals in USDC; ${STANDIN}.`, (venue, label) => exchangeSource(w().pubperps, venue, label, "perpetuals", false));
  add("standin-events", "Stand-in Predictions · event contracts (test harness)", `Event contracts with a YES and a NO leg; ${STANDIN}.`, (venue, label) => ({ name: label || w().predict.name, kind: "prediction", reference: "stand-in", via: `${w().predict.name} · ${STANDIN}`, probe: probe(["read", "trade"]), read: async () => w().predict.read(), trader: w().predict.trader(venue), readOnlyBecause: readOnly }));
  add("standin-pubevents", "Stand-in Event Exchange · event contracts (test harness)", `Event contracts; ${STANDIN}.`, (venue, label) => ({ name: label || w().pubevents.name, kind: "prediction", reference: "stand-in", via: `${w().pubevents.name} · ${STANDIN}`, probe: probe(["read", "trade"]), read: async () => w().pubevents.read(), trader: w().pubevents.trader(venue), readOnlyBecause: readOnly }));
  add("standin-wallet", "Stand-in Wallet · tokens on Base and Ethereum (test harness)", `A wallet that swaps on its own (as the mm command line does): WETH, cbBTC and USDY, a tokenised fund; ${STANDIN}.`, (venue, label) => ({ name: label || w().wallet.name, kind: "agent-wallet", reference: "stand-in", via: `${w().wallet.name} · ${STANDIN}`, probe: probe(["read", "swap"]), read: async () => w().wallet.read(), trader: w().wallet.trader(venue), readOnlyBecause: readOnly }));
  add("standin-broker", "Stand-in Broker · US stocks and ETFs (test harness)", `AAPL, NVDA and SPY in New York's market hours, cash in dollars; ${STANDIN}.`, (venue, label) => brokerSource(w().broker, venue, label));
  // the exchange behind the geoblocked public source below: it refuses this location in its own words, as a real venue's servers would
  // refuse the network the account runs on — so connecting it shows what the account does then (service.ts waiting: the connection is kept,
  // read nowhere, asked again when a check of this network finds the venue answering). Nothing here looks for a way around it
  register({ kind: "standin-geo", label: "Stand-in Geo Exchange · does not serve this location (test harness)", needs: "cli", example: `An exchange whose servers refuse this location; ${STANDIN}.`, venues: [], async open(req) {
    return no("E_VENUE_GEOBLOCKED", { venue: req.venue, message: "Stand-in Geo Exchange does not serve this location: that is its own rule, and the account does not look for a way around it", native: { status: 451, said: '{"code":0,"msg":"Service unavailable from a restricted location (stand-in)."}' } });
  } });
}

// ---- the public market data of venues that are not connected ------------------------------------------------------------------------

/** a listing carries no order types: nothing is ordered through one */
const listed = (m: Market): Listing => ({ ...m, types: [] });

export function publicSources(): PublicSource[] {
  const pubex: PublicSource = {
    id: "standin-pubex-public",
    name: "Stand-in Public Exchange",
    kind: "exchange",
    connectTo: "standin-pubex",
    connector: "live:standin-pubex",
    listings: async (o) => w().pubex.matching(o.q ?? "").slice(0, o.limit).map(listed),
    stats: async (symbols) => w().pubex.stats(symbols),
    // its public price history, as an exchange's keyless OHLCV
    candles: async (symbol, interval, since) => w().pubex.candles("standin-pubex-public", symbol, interval, since),
  };
  // the public side of the perp exchange, as Hyperliquid's keyless list is: its perpetuals busiest first, each a Perps row to connect to trade
  let shownPerps: { of: number; total: number } | undefined;
  const pubperps: PublicSource = {
    id: "standin-pubperps-public",
    name: "Stand-in Perp Exchange",
    kind: "exchange",
    connectTo: "standin-pubperps",
    connector: "live:standin-pubperps",
    listings: async (o) => {
      const all = w().pubperps.matching(o.q ?? "").sort((a, b) => (b.volumeUsd24h ?? 0) - (a.volumeUsd24h ?? 0));
      const pool = all.slice(0, o.limit);
      if (!o.q) shownPerps = { of: pool.length, total: all.length };
      return pool.map(listed);
    },
    candles: async (symbol, interval, since) => w().pubperps.candles("standin-pubperps-public", symbol, interval, since),
    notes: (o) => (!o.q && shownPerps && shownPerps.of < shownPerps.total ? [`Stand-in Perp Exchange: ${shownPerps.of} of ${shownPerps.total} perpetuals shown · search for the rest`] : []),
  };
  // the public side of the event exchange, as the real Gamma read is (public-markets.ts): each market carries its event's tags, an event
  // under an excluded word (the Sports one) is left out, and the venue says what its list is made of
  const publicLegs = (ms: Market[]): Listing[] =>
    ms
      .map((m): Listing => {
        const spec = w().pubevents.events.find((e) => e.id === m.group?.id);
        return { ...m, types: [], tags: spec?.tags ?? (m.category ? [m.category] : []) };
      })
      .filter((m) => !isExcludedCategory([m.category, ...(m.tags ?? [])]));
  const pubevents: PublicSource = {
    id: "standin-pubevents-public",
    name: "Stand-in Event Exchange",
    kind: "events",
    connectTo: "standin-pubevents",
    connector: "live:standin-pubevents",
    listings: async (o) => publicLegs(w().pubevents.matching(o.q ?? "")).slice(0, o.limit * 2),
    events: async (o) => publicLegs(w().pubevents.eventsList(o)),
    candles: async (symbol, interval, since) => w().pubevents.candles("standin-pubevents-public", symbol, interval, since),
    notes: () => ["Stand-in Event Exchange: its busiest events, without sports (a stand-in: nothing here is real)."],
  };
  // how much of the token list a listing with nothing searched for shows, for the sentence under it
  let shownTokens: { of: number; total: number } | undefined;
  const tokens: PublicSource = {
    id: "standin-stock-tokens",
    name: "Stand-in Stock Tokens",
    kind: "tokens",
    connectTo: "standin-stock-tokens",
    connector: "live:standin-stock-tokens",
    readOnly: "these stock tokens are only read here: no connection on this account trades them",
    listings: async (o) => {
      const matching = STOCK_TOKENS.filter((t) => !o.q || `${t.symbol} ${t.name}`.toLowerCase().includes(o.q.toLowerCase()));
      const pool = matching.slice(0, o.limit);
      if (!o.q) shownTokens = { of: pool.length, total: matching.length };
      return pool.map((t) => {
        const p = w().prices.now(t.key);
        const d = w().prices.day(t.key);
        return { symbol: t.symbol, name: t.name, kind: "token" as MarketKind, base: t.symbol, quote: "USD", price: toStep(p, 0.01), bid: toStep(p * 0.999, 0.01, "floor"), ask: toStep(p * 1.001, 0.01, "ceil"), open: true, types: [], changePct24h: Number(d.changePct24h.toFixed(2)), volumeUsd24h: t.volume };
      });
    },
    notes: (o) => (!o.q && shownTokens && shownTokens.of < shownTokens.total ? [`Stand-in Stock Tokens: ${shownTokens.of} of ${shownTokens.total} shown · search for the rest`] : []),
  };
  // an exchange that does not serve this location: the page shows its own words, and nothing looks for a way around it
  const geo: PublicSource = {
    id: "standin-geo",
    name: "Stand-in Geo Exchange",
    kind: "exchange",
    connectTo: "standin-geo",
    connector: "live:standin-geo",
    listings: async () => no("E_VENUE_GEOBLOCKED", { venue: "standin-geo", message: "Stand-in Geo Exchange does not serve this location: that is its own rule, and the account does not look for a way around it", native: { status: 451, said: '{"code":0,"msg":"Service unavailable from a restricted location (stand-in)."}' } }),
  };
  return [pubex, pubevents, pubperps, tokens, geo];
}

// ---- the network, the chain and the payees, as the stand-in answers them: nothing leaves the process -------------------------------------

/** the stand-in chain: what `World.chain` holds, read as the chains would answer */
export function standinChain(): ChainReader {
  const amount = (holder: string, chain: ChainName, asset: string): number => w().chain.get(`${holder.toLowerCase()}|${chain}|${asset}`) ?? 0;
  return {
    // a row for every token asked about, a zero balance too, as the real chain reader answers: a missing row means the chain did not answer
    tokens: async (holder, refs) => ({ rows: refs.map((r) => ({ chain: r.chain, asset: r.asset, amount: amount(holder, r.chain, r.asset) })), failed: [] }),
    native: async (holder, chains) => ({ rows: chains.map((c) => ({ chain: c, asset: CHAINS[c].coin, amount: amount(holder, c, CHAINS[c].coin) })), failed: [] }),
    uint: async () => undefined,
    decimals: async () => 6,
    receipt: async () => undefined,
  };
}

export const standinSender: ChainSender = { transfer: async () => ({ error: "the stand-in sends nothing on any chain" }) };

/** a dollar price for what a source could not price itself: from the stand-in's curves */
export async function standinPrice(asset: string): Promise<number | undefined> {
  const a = asset.toUpperCase();
  if (isStable(a)) return 1;
  const key = a === "WETH" ? "ETH" : a === "WBTC" || a === "CBBTC" ? "BTC" : a;
  return current?.prices.has(key) ? current.prices.now(key) : undefined;
}
