/** WHAT IT COST: the average price paid for what is held, and what was made on what was sold.
 *
 * Two places know a price paid, and nothing else is used:
 *   · the account's own ORDERS, every run's. Each order is logged whole on its statement row (live-orders.ts `line`: `native.order`) every
 *     time it changes, so the ledgers in the home hold every word on every order the account ever placed: its last word, and each time
 *     more of it had filled (`ordersOf`, an order's `steps`);
 *   · the VENUE, where it says: a broker's average entry price (Alpaca, Robinhood), a prediction market's average price (Polymarket, Kalshi's
 *     cost), a perpetual's entry price. Where a venue says, its number wins for what is held there.
 *
 * How (`costBasis`), asset by asset, FILL BY FILL in the order the fills were logged — not order by order: a limit buy that part-filled,
 * then a sell, then the buy's rest canceled, is the buy's fill, then the sell, whenever the buy's last word was written:
 *   · a fill is what more of an order had filled at one of its rows than at the row before: that much, worth what the order had filled for
 *     then less what it had filled for before (`filledQty × avgPrice × contractSize`, row by row), and its share of the order's fee;
 *   · a buy adds what filled at the price it filled at, and its fee; a part fill counts its part;
 *   · a sell takes the average cost of what it sold off the pile, and what it fetched above that, less its fee, is realised. A sell of more
 *     than the account's orders bought (coins that were there before, or came in from elsewhere) realises nothing for the rest: its cost
 *     is not known (`soldUnknownQty`);
 *   · coins are one pile across venues (BTC bought at one exchange and sold at another is one BTC), by the same one name the holdings use
 *     (account/holdings.ts); a stock by its ticker, an event contract by its symbol. A venue that reports its own entry price for what it
 *     holds keeps its own pile, so its orders are not counted twice;
 *   · a perpetual or a dated future is a position at its venue, long or short: it has a pile of its own, and a trade against it closes
 *     before it opens.
 *
 * What is not known stays unknown: a fill without a price adds nothing to the pile (`unpricedFills`), a fee the venue did not report is not
 * guessed (`unreportedFees`), and every row says how much of what is held its cost covers — "cost known for 0.4 of 1 BTC" — because coins
 * bought before the account, or moved in from elsewhere, have a cost the account never saw. Nothing here asks a venue anything.
 */
import type { AssetClass } from "../accounts.ts";
import type { MarketKind, Position } from "../live/trade.ts";
import { marketClass, marketKey, type AssetRow } from "./holdings.ts";
import type { LiveOrder } from "./live-orders.ts";

/** a venue's position, with the venue it is at */
export interface VenuePosition extends Position {
  venue: string;
  venueName?: string | undefined;
}

export type CostSource = "account orders" | "venue";

/** where a row's known cost comes from: one venue's own number, or the account's orders */
export interface CostPart {
  source: CostSource;
  /** the venue whose own entry price this is (source "venue") */
  venue?: string | undefined;
  venueName?: string | undefined;
  /** in the row's units */
  qty: number;
  /** in dollars; absent where the venue's entry price is known and its contract size is not */
  costUsd?: number | undefined;
}

export interface CostBasis {
  /** the holdings row it belongs to (`crypto:BTC`, `equity:AAPL`, `event:…`), or a position at one venue: `position:<venue>:<symbol>` */
  key: string;
  asset: string;
  class: AssetClass | "position";
  /** a position: long or short, and its market */
  side?: "long" | "short" | undefined;
  symbol?: string | undefined;
  /** the average price paid, per unit (per coin, per share, per contract's base) — of what is covered */
  avgCostUsd?: number | undefined;
  /** what the covered part cost in all */
  costUsd?: number | undefined;
  /** how much of what is held the cost covers, of how much is held now (contracts, for a perpetual) */
  coveredQty: number;
  ofQty: number;
  /** what the covered part is worth now less what it cost; absent where there is no price now */
  unrealizedUsd?: number | undefined;
  /** what sells made over their average cost, less their fees: every run's */
  realizedUsd: number;
  /** where the known cost comes from; "none" when nothing is known */
  source: CostSource | "venue and account orders" | "none";
  /** "cost known for 0.4 of 1 BTC" */
  words: string;
  parts: CostPart[];
  /** the account's filled orders counted for it */
  orders: number;
  soldUnknownQty?: number | undefined;
  unpricedFills?: number | undefined;
  unreportedFees?: number | undefined;
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const r2 = (n: number): number => Number(n.toFixed(2)) || 0;
const units = (n: number): number => Number(n.toFixed(10)) || 0;
const price = (n: number): number => Number(n.toPrecision(10));
const qtyText = (n: number): string => n.toLocaleString("en-US", { maximumFractionDigits: 8 });
const KINDS: ReadonlySet<string> = new Set<MarketKind>(["spot", "perp", "future", "stock", "crypto", "event", "token"]);

/** an order as it was logged: enough of it to be counted */
function asOrder(x: unknown): LiveOrder | undefined {
  if (!isObj(x)) return undefined;
  if (typeof x.clientId !== "string" || !x.clientId || typeof x.venue !== "string" || typeof x.symbol !== "string" || typeof x.base !== "string") return undefined;
  if (typeof x.kind !== "string" || !KINDS.has(x.kind) || (x.side !== "buy" && x.side !== "sell") || typeof x.filledQty !== "number" || !Number.isFinite(x.filledQty)) return undefined;
  return x as unknown as LiveOrder;
}

/** what an order had filled by one of its rows: when that row says it changed, how much had filled, at what average, with what fee */
export interface FillStep {
  at: string;
  filledQty: number;
  avgPrice?: number | undefined;
  feeUsd?: number | undefined;
}

/** an order as last logged, with each row at which more of it had filled, oldest first */
export type LoggedOrder = LiveOrder & { steps?: FillStep[] | undefined };

/** Every order the account placed, as last logged: from ledger rows (every run's, oldest run first, as service.ts statement() reads them),
 * the statement rows that carry the order whole. An order followed again in a later run is one order: its last row wins, and every row at
 * which more of it had filled is kept as a step, at the time the row says the order changed — so its fills are replayed when they happened */
export function ordersOf(rows: Iterable<{ kind: string; native?: unknown }>): LoggedOrder[] {
  const last = new Map<string, LoggedOrder>();
  for (const row of rows) {
    if (row.kind !== "statement" || !isObj(row.native)) continue;
    const o = asOrder(row.native.order);
    if (!o) continue;
    const steps = last.get(o.clientId)?.steps ?? [];
    const prev = steps.at(-1);
    const step: FillStep = { at: o.updatedAt ?? o.at, filledQty: o.filledQty, ...(o.avgPrice !== undefined ? { avgPrice: o.avgPrice } : {}), ...(o.feeUsd !== undefined ? { feeUsd: o.feeUsd } : {}) };
    let next = steps;
    if (o.filledQty > (prev?.filledQty ?? 0) + 1e-12) next = [...steps, step];
    // the same fill, priced only now: it keeps the time it was first seen
    else if (prev && !(prev.avgPrice !== undefined && prev.avgPrice > 0) && o.avgPrice !== undefined && o.avgPrice > 0 && Math.abs(o.filledQty - prev.filledQty) <= 1e-12) next = [...steps.slice(0, -1), { ...prev, avgPrice: o.avgPrice }];
    // a later row is a later word on the same order (it keeps the place it first had)
    last.set(o.clientId, { ...o, steps: next });
  }
  return [...last.values()];
}

/** one fill of an order: how much more had filled at one of its rows, what that was worth (absent when a price is missing), its share of the
 * order's fee, and when */
interface Fill {
  o: LiveOrder;
  qty: number;
  value: number | undefined;
  fee: number;
  at: number;
  /** the order's place, and the step's within it: fills logged in the same millisecond keep the ledger's order */
  i: number;
  j: number;
}

/** An order's fills, from its steps. An order without them (handed in whole, not read from the ledgers) is one fill, at the time it was
 * placed. A fill's worth is what the order had filled for at its row less what it had filled for at the row before — when either is not
 * priced, the fill is not. The order's fee, as last reported, is shared out by what each fill was of what filled in all */
function fillsOf(o: LoggedOrder, i: number, cs: number): Fill[] {
  const steps: FillStep[] = o.steps?.length ? o.steps : [{ at: o.at, filledQty: o.filledQty, avgPrice: o.avgPrice, feeUsd: o.feeUsd }];
  const fee = o.feeUsd !== undefined && Number.isFinite(o.feeUsd) ? o.feeUsd : 0;
  const out: Fill[] = [];
  let q0 = 0;
  let v0: number | undefined = 0;
  for (const [j, s] of steps.entries()) {
    const dq = s.filledQty - q0;
    if (!(dq > 1e-12)) continue;
    const v = s.avgPrice !== undefined && s.avgPrice > 0 ? s.filledQty * s.avgPrice * cs : undefined;
    const value = v !== undefined && v0 !== undefined && v - v0 > 0 ? v - v0 : undefined;
    out.push({ o, qty: dq, value, fee: o.filledQty > 0 ? (fee * dq) / o.filledQty : 0, at: Date.parse(s.at), i, j });
    q0 = s.filledQty;
    v0 = v;
  }
  return out;
}

/** a perpetual or a dated future, and a short anywhere: a position at its venue, not a holding */
const positionKey = (venue: string, symbol: string): string => `position:${venue}:${symbol}`;
/** the holdings row a venue's position is part of: what is held long and is held as a thing (a share, a coin, an event contract). A
 * position names its market, not its base: `BTC/USD` is cut to BTC the way normalBase cuts a pair */
function heldKey(p: Position): string | undefined {
  if (p.side !== "long") return undefined;
  return marketKey({ kind: p.kind, base: p.symbol, symbol: p.symbol });
}

interface Pile {
  /** what is held by these orders: base units for a holding; contracts, signed (a short is negative), for a position */
  qty: number;
  /** what that cost in dollars, fees in */
  cost: number;
  realized: number;
  soldUnknown: number;
  /** a position: one contract is this much base */
  contractSize: number;
}

interface Tally {
  key: string;
  asset: string;
  class: AssetClass | "position";
  symbol?: string | undefined;
  venue?: string | undefined;
  piles: Map<string, Pile>;
  orders: number;
  unpricedFills: number;
  unreportedFees: number;
}

const pileOf = (t: Tally, id: string): Pile => {
  let p = t.piles.get(id);
  if (!p) {
    p = { qty: 0, cost: 0, realized: 0, soldUnknown: 0, contractSize: 1 };
    t.piles.set(id, p);
  }
  return p;
};

/** a holding: bought, then sold at the pile's average cost; never below nothing. `q` in base units */
function holdingTrade(p: Pile, side: LiveOrder["side"], q: number, value: number | undefined, fee: number): void {
  if (side === "buy") {
    if (value === undefined) return;
    p.qty += q;
    p.cost += value + fee;
    return;
  }
  const covered = Math.min(q, p.qty);
  const basis = p.qty > 0 ? (covered / p.qty) * p.cost : 0;
  const share = q > 0 ? covered / q : 0;
  if (value !== undefined) p.realized += value * share - basis - fee * share;
  p.cost -= basis;
  p.qty -= covered;
  p.soldUnknown += q - covered;
  if (p.qty <= 1e-12) p.qty = p.cost = 0;
}

/** a position: a trade the same way grows it at its price; one against it closes what it can at the average entry, and the rest opens the
 * other way. `q` in contracts */
function positionTrade(p: Pile, side: LiveOrder["side"], q: number, value: number | undefined, fee: number): void {
  const d = side === "buy" ? q : -q;
  const growing = p.qty === 0 || Math.sign(d) === Math.sign(p.qty);
  // a fill without a price adds nothing it cannot price; what it closed is closed all the same, with nothing realised
  if (growing && value === undefined) return;
  if (growing) {
    p.qty += d;
    p.cost += value! + fee;
    return;
  }
  const closing = Math.min(Math.abs(d), Math.abs(p.qty));
  const basis = (closing / Math.abs(p.qty)) * p.cost;
  const share = closing / Math.abs(d);
  if (value !== undefined) {
    const got = (closing / q) * value;
    p.realized += (p.qty > 0 ? got - basis : basis - got) - fee * share;
  }
  p.cost -= basis;
  p.qty += Math.sign(d) * closing;
  if (Math.abs(p.qty) <= 1e-12) p.qty = p.cost = 0;
  const rest = Math.abs(d) - closing;
  if (rest > 1e-12 && value !== undefined) {
    p.qty = Math.sign(d) * rest;
    p.cost = (rest / q) * value + fee * (1 - share);
  }
}

/** What each asset cost: from the account's orders (`ordersOf`), what is held now (`byAsset(...).rows`: how much, and its price now), and
 * the positions the venues report (their entry prices win where they give one). A row for everything held that is not a dollar, everything
 * the orders traded, and every position — each saying how much of what is held its cost covers. Largest holding first */
export function costBasis(orders: Iterable<LoggedOrder>, held: readonly AssetRow[], positions: readonly VenuePosition[] = []): CostBasis[] {
  const tallies = new Map<string, Tally>();
  const tallyOf = (key: string, make: () => Omit<Tally, "piles" | "orders" | "unpricedFills" | "unreportedFees">): Tally => {
    let t = tallies.get(key);
    if (!t) {
      t = { ...make(), piles: new Map(), orders: 0, unpricedFills: 0, unreportedFees: 0 };
      tallies.set(key, t);
    }
    return t;
  };
  // a venue that reports its own entry price for something held keeps its own pile of it
  const ownPile = new Set<string>();
  for (const p of positions) {
    const k = heldKey(p);
    if (k && p.entryPrice !== undefined && p.entryPrice > 0) ownPile.add(`${k}|${p.venue}`);
  }

  // every order's fills, all of them in the order they were logged (a rebate is a fee below nothing, as the venue reported it)
  const contract = (o: LiveOrder): number => (o.contractSize !== undefined && o.contractSize > 0 ? o.contractSize : 1);
  const fills = [...orders]
    .flatMap((o, i) => (o.filledQty > 0 ? fillsOf(o, i, contract(o)) : []))
    .sort((a, b) => (a.at || 0) - (b.at || 0) || a.i - b.i || a.j - b.j);
  const counted = new Set<LiveOrder>();
  const unpriced = new Set<LiveOrder>();
  for (const { o, qty, value, fee } of fills) {
    const cls = marketClass(o.kind, o.base);
    if (cls === "stable" || cls === "cash") continue;
    const cs = contract(o);
    let t: Tally;
    if (!cls) {
      const key = positionKey(o.venue, o.symbol);
      t = tallyOf(key, () => ({ key, asset: o.name || o.symbol, class: "position", symbol: o.symbol, venue: o.venue }));
      const pile = pileOf(t, "*");
      pile.contractSize = cs;
      positionTrade(pile, o.side, qty, value, fee);
    } else {
      const key = marketKey(o)!;
      t = tallyOf(key, () => ({ key, asset: cls === "event" ? o.symbol : key.slice(key.indexOf(":") + 1), class: cls }));
      holdingTrade(pileOf(t, ownPile.has(`${key}|${o.venue}`) ? o.venue : "*"), o.side, qty * cs, value, fee);
    }
    // counted once an order, however many fills it had
    if (!counted.has(o)) {
      counted.add(o);
      t.orders++;
      if (o.feeUsd === undefined) t.unreportedFees++;
    }
    if (value === undefined && !unpriced.has(o)) {
      unpriced.add(o);
      t.unpricedFills++;
    }
  }

  const rows = new Map(held.map((r) => [r.key, r]));
  for (const r of held) if (r.class !== "cash" && r.class !== "stable") tallyOf(r.key, () => ({ key: r.key, asset: r.asset, class: r.class }));
  const venueParts = new Map<string, VenuePosition[]>();
  // a perpetual, a dated future, a short: a position of its own at its venue
  const own: VenuePosition[] = [];
  for (const p of positions) {
    const k = heldKey(p);
    if (!k) {
      own.push(p);
      const key = positionKey(p.venue, p.symbol);
      tallyOf(key, () => ({ key, asset: p.name || p.symbol, class: "position", symbol: p.symbol, venue: p.venue }));
      continue;
    }
    tallyOf(k, () => ({ key: k, asset: p.kind === "event" ? p.symbol : k.slice(k.indexOf(":") + 1), class: marketClass(p.kind, p.symbol) ?? "crypto" }));
    venueParts.set(k, [...(venueParts.get(k) ?? []), p]);
  }

  const out: CostBasis[] = [];
  for (const t of tallies.values()) {
    const realized = [...t.piles.values()].reduce((s, p) => s + p.realized, 0);
    const soldUnknown = [...t.piles.values()].reduce((s, p) => s + p.soldUnknown, 0);
    const extra = { orders: t.orders, ...(soldUnknown > 1e-12 ? { soldUnknownQty: units(soldUnknown) } : {}), ...(t.unpricedFills ? { unpricedFills: t.unpricedFills } : {}), ...(t.unreportedFees ? { unreportedFees: t.unreportedFees } : {}) };
    if (t.class === "position") {
      out.push({ ...positionBasis(t, own.find((p) => positionKey(p.venue, p.symbol) === t.key)), realizedUsd: r2(realized), ...extra });
      continue;
    }
    const row = rows.get(t.key);
    const reported = (venueParts.get(t.key) ?? []).filter((p) => p.entryPrice !== undefined && p.entryPrice > 0);
    const reportedQty = reported.reduce((s, p) => s + p.qty, 0);
    const ofQty = Math.max(row ? row.amount : (venueParts.get(t.key) ?? []).reduce((s, p) => s + p.qty, 0), reportedQty);
    const parts: CostPart[] = reported.map((p) => ({ source: "venue", venue: p.venue, ...(p.venueName ? { venueName: p.venueName } : {}), qty: units(p.qty), costUsd: p.entryPrice! * p.qty }));
    // what the venues do not speak for is covered by the account's own pile, as far as it goes
    const pile = t.piles.get("*");
    const fromOrders = pile && pile.qty > 0 ? Math.min(pile.qty, Math.max(0, ofQty - reportedQty)) : 0;
    if (fromOrders > 1e-12) parts.push({ source: "account orders", qty: units(fromOrders), costUsd: (fromOrders / pile!.qty) * pile!.cost });
    const covered = parts.reduce((s, p) => s + p.qty, 0);
    const cost = parts.reduce((s, p) => s + (p.costUsd ?? 0), 0);
    // worth now: the venue's own mark and P&L for its part where it gives them, the holdings' price for the rest
    let unrealized: number | undefined = covered > 0 ? 0 : undefined;
    for (const part of parts) {
      if (unrealized === undefined) break;
      const p = part.source === "venue" ? reported.find((x) => x.venue === part.venue) : undefined;
      const mark = p?.markPrice ?? row?.price;
      if (p?.unrealizedUsd !== undefined) unrealized += p.unrealizedUsd;
      else if (mark !== undefined) unrealized += part.qty * mark - (part.costUsd ?? 0);
      else unrealized = undefined;
    }
    const sources = new Set(parts.map((p) => p.source));
    out.push({
      key: t.key,
      asset: row?.asset ?? t.asset,
      class: t.class,
      ...(covered > 0 ? { avgCostUsd: price(cost / covered), costUsd: r2(cost) } : {}),
      coveredQty: units(covered),
      ofQty: units(ofQty),
      ...(unrealized !== undefined ? { unrealizedUsd: r2(unrealized) } : {}),
      realizedUsd: r2(realized),
      source: sources.size === 2 ? "venue and account orders" : sources.has("venue") ? "venue" : sources.has("account orders") ? "account orders" : "none",
      words: ofQty > 0 ? `cost known for ${qtyText(units(covered))} of ${qtyText(units(ofQty))} ${row?.asset ?? t.asset}` : "nothing held now",
      parts: parts.map((p) => ({ ...p, ...(p.costUsd !== undefined ? { costUsd: r2(p.costUsd) } : {}) })),
      ...extra,
    });
  }
  const worth = (c: CostBasis) => rows.get(c.key)?.usd ?? 0;
  return out.sort((a, b) => worth(b) - worth(a) || b.ofQty - a.ofQty || a.key.localeCompare(b.key));
}

/** A position at one venue: the venue's entry price where it gives one; the account's own pile otherwise, while it is on the same side */
function positionBasis(t: Tally, p: VenuePosition | undefined): Omit<CostBasis, "realizedUsd" | "orders"> {
  const pile = t.piles.get("*");
  const symbol = t.symbol ?? p?.symbol;
  const base = { key: t.key, asset: p?.name || t.asset, class: "position" as const, ...(symbol ? { symbol } : {}) };
  if (!p) {
    // the venue lists no such position (or was not asked): what the account's own orders leave open is said, and not counted as held
    const open = pile && pile.qty !== 0 ? units(Math.abs(pile.qty)) : 0;
    return { ...base, ...(open ? { side: pile!.qty > 0 ? ("long" as const) : ("short" as const) } : {}), coveredQty: 0, ofQty: 0, source: "none", words: open ? `${qtyText(open)} contracts left open by the account's orders; no position listed at the venue` : "nothing held now", parts: [] };
  }
  // the contract size is the account's own order's, where it traded this market: a position does not carry one
  const cs = pile ? pile.contractSize : p.kind === "perp" || p.kind === "future" ? undefined : 1;
  const unit = p.kind === "perp" || p.kind === "future" ? "contracts" : p.name || p.symbol;
  if (p.entryPrice !== undefined && p.entryPrice > 0) {
    const cost = cs !== undefined ? p.entryPrice * p.qty * cs : undefined;
    const unrealized = p.unrealizedUsd ?? (cs !== undefined && p.markPrice !== undefined && cost !== undefined ? (p.side === "long" ? 1 : -1) * (p.qty * p.markPrice * cs - cost) : undefined);
    return { ...base, side: p.side, avgCostUsd: price(p.entryPrice), ...(cost !== undefined ? { costUsd: r2(cost) } : {}), coveredQty: units(p.qty), ofQty: units(p.qty), ...(unrealized !== undefined ? { unrealizedUsd: r2(unrealized) } : {}), source: "venue", words: `cost known for ${qtyText(units(p.qty))} of ${qtyText(units(p.qty))} ${unit}`, parts: [{ source: "venue", venue: p.venue, ...(p.venueName ? { venueName: p.venueName } : {}), qty: units(p.qty), ...(cost !== undefined ? { costUsd: r2(cost) } : {}) }] };
  }
  const sameSide = pile && pile.qty !== 0 && (pile.qty > 0) === (p.side === "long");
  const covered = sameSide ? Math.min(Math.abs(pile!.qty), p.qty) : 0;
  const cost = sameSide ? (covered / Math.abs(pile!.qty)) * pile!.cost : 0;
  const unrealized = covered > 0 ? (p.unrealizedUsd !== undefined && covered >= p.qty - 1e-12 ? p.unrealizedUsd : p.markPrice !== undefined ? (p.side === "long" ? 1 : -1) * (covered * p.markPrice * pile!.contractSize - cost) : undefined) : undefined;
  return {
    ...base,
    side: p.side,
    ...(covered > 0 ? { avgCostUsd: price(cost / (covered * pile!.contractSize)), costUsd: r2(cost) } : {}),
    coveredQty: units(covered),
    ofQty: units(p.qty),
    ...(unrealized !== undefined ? { unrealizedUsd: r2(unrealized) } : {}),
    source: covered > 0 ? "account orders" : "none",
    words: `cost known for ${qtyText(units(covered))} of ${qtyText(units(p.qty))} ${unit}`,
    parts: covered > 0 ? [{ source: "account orders", qty: units(covered), costUsd: r2(cost) }] : [],
  };
}

