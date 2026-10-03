/** Execution liquidity: where an order can be filled, at what price, and how
 * to SPLIT it across venues.
 *
 * Two kinds of venue, one Fill shape:
 *
 *   CEX order books  a mid (venues disagree by a few bps), a half-spread, a
 *                    depth (bps of impact per dollar of size) and a taker fee
 *   DEX pools        constant-product pools on a chain, reached through the
 *                    on-chain wallet's swap. One swap on one chain is one venue
 *                    (`dex:Base`): inside it the route water-fills that chain's
 *                    pools until their marginal prices are equal, pays each
 *                    pool's LP fee, and pays gas once
 *
 *   fillAt       one venue, one size → the fill. The adapters execute with this
 *                same function, so a quote the agent compared is the price it
 *                gets.
 *   venueQuotes  the WHOLE order at every connected venue. A venue that cannot
 *                take it alone still answers, with the reason — liquidity is
 *                also inventory: a venue that does not hold the asset cannot
 *                sell it.
 *   splitOrder   the order router. Lot by lot, each lot goes to the venue whose
 *                marginal net price is best among those that still hold
 *                inventory. Every combination of venues is tried, so a fixed
 *                cost (gas) is paid only where it earns itself back, and one
 *                more leg has to add at least EXTRA_LEG_MIN_GAIN_USD.
 *
 * Illustrative numbers, real shapes: a deep CEX with a 10 bps fee, a second
 * CEX a little thinner and cheaper, 5 bps and 30 bps pools on Ethereum (gas in
 * dollars) and on Base (gas in cents). A pool's `reserve` is VIRTUAL: near the
 * current price a concentrated-liquidity pool trades as if it held far more
 * than its TVL. Books and pools are stateless here — arbitrage puts the price
 * back between two flights.
 */
import { PRICES, qtyText, r2, r8 } from "./accounts.ts";
import type { RailAccount } from "./rails.ts";

export type Side = "buy" | "sell";

export interface BookModel {
  name: string;
  /** what the venue pays in / takes */
  quote: string;
  symbol(base: string): string;
  /** how far this venue's mid sits from the reference price */
  midAdjBps: number;
  halfSpreadBps: number;
  /** USD of size that moves the price 10 bps */
  depthUsdPer10bps: number;
  feeBps: number;
}

export const BOOKS: Record<string, BookModel> = {
  binance: { name: "Binance", quote: "USDT", symbol: (b) => `${b}USDT`, midAdjBps: 0, halfSpreadBps: 0.5, depthUsdPer10bps: 2_000_000, feeBps: 10 },
  okx: { name: "OKX", quote: "USDT", symbol: (b) => `${b}-USDT`, midAdjBps: 5, halfSpreadBps: 1, depthUsdPer10bps: 1_000_000, feeBps: 8 },
};

export interface PoolModel {
  id: string;
  dex: string;
  chain: string;
  base: string;
  feeBps: number;
  /** virtual base reserve (see the header) */
  reserve: number;
  /** how far the pool's price sits from the reference; arbitrage keeps it inside the fee */
  midAdjBps: number;
}

export const DEX_QUOTE = "USDC";

export const POOLS: PoolModel[] = [
  { id: "eth:univ3-5", dex: "Uniswap v3 0.05%", chain: "Ethereum", base: "ETH", feeBps: 5, reserve: 300_000, midAdjBps: -1 },
  { id: "eth:univ3-30", dex: "Uniswap v3 0.3%", chain: "Ethereum", base: "ETH", feeBps: 30, reserve: 120_000, midAdjBps: 0 },
  { id: "base:aero", dex: "Aerodrome", chain: "Base", base: "ETH", feeBps: 5, reserve: 40_000, midAdjBps: 0 },
  { id: "base:univ3-5", dex: "Uniswap v3 0.05%", chain: "Base", base: "ETH", feeBps: 5, reserve: 15_000, midAdjBps: -1 },
  { id: "eth:univ3-wbtc", dex: "Uniswap v3 0.3%（WBTC）", chain: "Ethereum", base: "BTC", feeBps: 30, reserve: 6_000, midAdjBps: 0 },
  { id: "base:aero-cbbtc", dex: "Aerodrome（cbBTC）", chain: "Base", base: "BTC", feeBps: 5, reserve: 1_500, midAdjBps: 0 },
];

/** one swap transaction, per chain */
export const DEX_GAS_USD: Record<string, number> = { Ethereum: 4, Base: 0.05 };

/** one more leg has to add at least this much, or the order is not split further */
export const EXTRA_LEG_MIN_GAIN_USD = 1;

/** a pool that would carry less than this share of a swap is left out of the route */
const MIN_POOL_SHARE = 0.01;

const DEX_PREFIX = "dex:";
export const dexVenue = (chain: string): string => `${DEX_PREFIX}${chain}`;
export const dexChainOf = (venue: string): string | undefined => (venue.startsWith(DEX_PREFIX) ? venue.slice(DEX_PREFIX.length) : undefined);
export const dexName = (chain: string): string => `DEX（${chain}）`;

/** chains that have a pool for this asset */
export function dexChains(base: string): string[] {
  return [...new Set(POOLS.filter((p) => p.base === base).map((p) => p.chain))].sort();
}

/** a holding's chain as the pools name it (`Base`, `Base Mainnet` → Base) */
export function chainKey(note: string | undefined): string | undefined {
  if (!note) return undefined;
  if (/base/i.test(note)) return "Base";
  if (/ethereum|mainnet/i.test(note)) return "Ethereum";
  return note;
}

export interface PoolFill {
  pool: string;
  dex: string;
  qty: number;
  price: number;
  feeUsd: number;
}

export interface Fill {
  /** `binance` · `okx` · `dex:Base` */
  venue: string;
  kind: "cex" | "dex";
  name: string;
  symbol: string;
  base: string;
  quote: string;
  side: Side;
  qty: number;
  mid: number;
  /** average execution price, before fees */
  price: number;
  grossUsd: number;
  /** the taker fee, or the pools' LP fees plus gas */
  feeUsd: number;
  /** sell: what lands in the account · buy: what leaves it */
  netUsd: number;
  impactBps: number;
  /** DEX only: the chain, its gas, and how the swap is routed across that chain's pools */
  chain?: string | undefined;
  gasUsd?: number | undefined;
  route?: PoolFill[] | undefined;
}

// ---- the two price curves, unrounded -----------------------------------------

interface Raw {
  /** size × execution price, before fees */
  gross: number;
  /** proportional fees: taker fee, LP fees */
  fee: number;
  /** a fixed cost paid once if the venue is used at all */
  gas: number;
  mid: number;
  impactBps: number;
  route?: Array<{ pool: PoolModel; qty: number; gross: number; fee: number }>;
}

function rawBook(v: BookModel, ref: number, side: Side, qty: number): Raw {
  const mid = ref * (1 + v.midAdjBps / 1e4);
  const impactBps = (10 * qty * mid) / v.depthUsdPer10bps;
  const slip = (v.halfSpreadBps + impactBps) / 1e4;
  const gross = qty * mid * (side === "sell" ? 1 - slip : 1 + slip);
  return { gross, fee: (gross * v.feeBps) / 1e4, gas: 0, mid, impactBps };
}

/** how much each pool takes so that every pool in use ends at the same marginal price (after its LP fee) */
function waterfill(pools: PoolModel[], ref: number, side: Side, qty: number): Array<{ pool: PoolModel; qty: number }> | undefined {
  const edge = (p: PoolModel) => ref * (1 + p.midAdjBps / 1e4) * (side === "sell" ? 1 - p.feeBps / 1e4 : 1 + p.feeBps / 1e4);
  const at = (p: PoolModel, level: number): number => {
    const e = edge(p);
    if (side === "sell") return level >= e ? 0 : p.reserve * (Math.sqrt(e / level) - 1);
    return level <= e ? 0 : p.reserve * (1 - Math.sqrt(e / level));
  };
  const total = (level: number) => pools.reduce((s, p) => s + at(p, level), 0);
  if (side === "buy" && qty >= pools.reduce((s, p) => s + p.reserve, 0) * 0.5) return undefined;
  let lo = side === "sell" ? Math.max(...pools.map(edge)) * 1e-6 : Math.min(...pools.map(edge));
  let hi = side === "sell" ? Math.max(...pools.map(edge)) : lo * 1e6;
  for (let i = 0; i < 100; i++) {
    const m = (lo + hi) / 2;
    const over = total(m) > qty;
    if (side === "sell" ? over : !over) lo = m;
    else hi = m;
  }
  const parts = pools.map((p) => ({ pool: p, qty: at(p, (lo + hi) / 2) }));
  const sum = parts.reduce((s, a) => s + a.qty, 0);
  return sum > 0 ? parts.map((a) => ({ pool: a.pool, qty: (a.qty * qty) / sum })) : undefined;
}

function rawSwap(chain: string, base: string, side: Side, qty: number): Raw | undefined {
  const ref = PRICES[base];
  let pools = POOLS.filter((p) => p.chain === chain && p.base === base);
  if (!ref || !pools.length || !(qty > 0)) return undefined;
  for (;;) {
    const parts = waterfill(pools, ref, side, qty);
    if (!parts) return undefined;
    const dust = parts.filter((a) => a.qty > 0 && a.qty < qty * MIN_POOL_SHARE).sort((a, b) => a.qty - b.qty)[0];
    if (dust && pools.length > 1) {
      pools = pools.filter((p) => p !== dust.pool);
      continue;
    }
    const route = parts
      .filter((a) => a.qty > 0)
      .map((a) => {
        const price = ref * (1 + a.pool.midAdjBps / 1e4);
        const gross = (price * a.pool.reserve * a.qty) / (side === "sell" ? a.pool.reserve + a.qty : a.pool.reserve - a.qty);
        return { pool: a.pool, qty: a.qty, gross, fee: (gross * a.pool.feeBps) / 1e4 };
      });
    const gross = route.reduce((s, r) => s + r.gross, 0);
    const mid = route.reduce((s, r) => s + ref * (1 + r.pool.midAdjBps / 1e4) * r.qty, 0) / qty;
    return { gross, fee: route.reduce((s, r) => s + r.fee, 0), gas: DEX_GAS_USD[chain] ?? 1, mid, impactBps: (Math.abs(gross / qty - mid) / mid) * 1e4, route };
  }
}

/** one venue, one size → the fill (the adapters execute with this) */
export function fillAt(venue: string, base: string, side: Side, qty: number): Fill | undefined {
  const ref = PRICES[base];
  if (!ref || !(qty > 0)) return undefined;
  const chain = dexChainOf(venue);
  if (chain !== undefined) {
    const raw = rawSwap(chain, base, side, qty);
    if (!raw) return undefined;
    const grossUsd = r2(raw.gross);
    const feeUsd = r2(raw.fee + raw.gas);
    const route = (raw.route ?? []).map((r) => ({ pool: r.pool.id, dex: r.pool.dex, qty: r8(r.qty), price: r2(r.gross / r.qty), feeUsd: r2(r.fee) })).sort((a, b) => b.qty - a.qty);
    return { venue, kind: "dex", name: dexName(chain), symbol: `${base}-${DEX_QUOTE}`, base, quote: DEX_QUOTE, side, qty, mid: r2(raw.mid), price: r2(raw.gross / qty), grossUsd, feeUsd, netUsd: r2(side === "sell" ? grossUsd - feeUsd : grossUsd + feeUsd), impactBps: Number(raw.impactBps.toFixed(3)), chain, gasUsd: raw.gas, route };
  }
  const v = BOOKS[venue];
  if (!v || base === v.quote) return undefined;
  const raw = rawBook(v, ref, side, qty);
  const price = r2(raw.gross / qty);
  const grossUsd = r2(qty * price);
  const feeUsd = r2((grossUsd * v.feeBps) / 1e4);
  return { venue, kind: "cex", name: v.name, symbol: v.symbol(base), base, quote: v.quote, side, qty, mid: r2(raw.mid), price, grossUsd, feeUsd, netUsd: r2(side === "sell" ? grossUsd - feeUsd : grossUsd + feeUsd), impactBps: Number(raw.impactBps.toFixed(3)) };
}

// ---- where an order could go --------------------------------------------------

interface Source {
  venue: string;
  account: string;
  kind: "cex" | "dex";
  name: string;
  quote: string;
  chain?: string | undefined;
  /** sells: units of the asset held there · buys: the quote currency held there */
  have: number;
  /** why the agent cannot trade there at all */
  blocked?: string | undefined;
}

function sourcesFor(base: string, side: Side, accounts: RailAccount[]): Source[] {
  const out: Source[] = [];
  const held = (a: RailAccount, asset: string, chain?: string) => a.holdings.filter((h) => h.asset === asset && (chain === undefined || chainKey(h.note) === chain)).reduce((s, h) => s + h.amount, 0);
  for (const a of accounts) {
    const blocked = a.reach.includes("trade") ? undefined : a.revoked ? "你关了" : "交易没开放";
    const book = a.kind === "cex" ? BOOKS[a.id] : undefined;
    if (book) {
      if (base === book.quote || !PRICES[base]) continue;
      out.push({ venue: a.id, account: a.id, kind: "cex", name: book.name, quote: book.quote, have: held(a, side === "sell" ? base : book.quote), blocked });
    } else if (a.kind === "agent-wallet") {
      for (const chain of dexChains(base)) out.push({ venue: dexVenue(chain), account: a.id, kind: "dex", name: dexName(chain), quote: DEX_QUOTE, chain, have: held(a, side === "sell" ? base : DEX_QUOTE, chain), blocked });
    }
  }
  return out;
}

export interface VenueQuote extends Fill {
  /** the account that would execute it */
  account: string;
  /** this venue can take the WHOLE order alone */
  ok: boolean;
  /** why it cannot, in the user's words */
  why?: string | undefined;
  /** what it holds for this order: the asset to sell, or the quote currency to pay with */
  have: number;
}

/** the whole order at every connected venue; a venue that cannot take it alone still answers, with the reason */
export function venueQuotes(base: string, side: Side, qty: number, accounts: RailAccount[]): VenueQuote[] {
  const sources = sourcesFor(base, side, accounts);
  const dex = sources.filter((s) => s.kind === "dex");
  const dexHolds = dex.some((s) => s.have > 0);
  const out: VenueQuote[] = [];
  for (const s of sources) {
    if (s.kind === "dex" && s.have <= 0) continue;
    const fill = fillAt(s.venue, base, side, qty);
    if (!fill) continue;
    let why: string | undefined;
    if (s.blocked) why = s.blocked;
    else if (side === "sell" && s.have < qty - 1e-9) why = s.have > 0 ? `只有 ${qtyText(s.have)} ${base}` : `没有 ${base}`;
    else if (side === "buy" && s.have < fill.netUsd) why = `${s.quote} 不够`;
    out.push({ ...fill, account: s.account, ok: why === undefined, why, have: s.have });
  }
  // the on-chain wallet holds nothing to trade with on any chain: one line for the DEX, not one per chain
  const first = dex[0];
  if (first && !dexHolds) {
    out.push({ venue: "dex", kind: "dex", name: "DEX", symbol: `${base}-${DEX_QUOTE}`, base, quote: DEX_QUOTE, side, qty, mid: 0, price: 0, grossUsd: 0, feeUsd: 0, netUsd: 0, impactBps: 0, account: first.account, ok: false, why: first.blocked ?? `链上没有 ${side === "sell" ? base : DEX_QUOTE}`, have: 0 });
  }
  return out;
}

/** sell: the most that lands · buy: the least that leaves */
export function bestVenue(quotes: VenueQuote[], side: Side): VenueQuote | undefined {
  return quotes.filter((q) => q.ok).sort((a, b) => (side === "sell" ? b.netUsd - a.netUsd : a.netUsd - b.netUsd))[0];
}

// ---- the order router ----------------------------------------------------------

export interface Slice extends Fill {
  account: string;
}

export interface PassedVenue {
  venue: string;
  name: string;
  have: number;
  /** what using it would have changed, in USD: negative = the order would have netted less */
  deltaUsd: number;
  gasUsd?: number | undefined;
}

export interface SplitPlan {
  base: string;
  side: Side;
  qty: number;
  /** the size of one lot the router moved around */
  lot: number;
  quotes: VenueQuote[];
  /** the best venue that can take the whole order alone, if any */
  single?: Slice | undefined;
  /** every usable venue together can take the order */
  feasible: boolean;
  /** the most they could take together */
  maxQty: number;
  /** best price first */
  slices: Slice[];
  grossUsd: number;
  feeUsd: number;
  netUsd: number;
  avgPrice: number;
  /** what splitting earned over `single` (sell: more lands · buy: less leaves) */
  gainUsd?: number | undefined;
  /** venues that hold inventory and were left out because using them nets less (a gas bill, a worse price) */
  passed: PassedVenue[];
  /** the split that nets the most in pure money, when the router did NOT take it: its extra legs earn less than the threshold */
  richer?: { slices: Slice[]; gainUsd: number } | undefined;
}

export interface SplitOptions {
  /** depth only: pretend every venue holds enough (a what-if for size) */
  ignoreInventory?: boolean;
  minGainPerLegUsd?: number;
}

function lotOf(qty: number): number {
  return 10 ** Math.floor(Math.log10(qty / 100) + 1e-9);
}

export function splitOrder(base: string, side: Side, qty: number, accounts: RailAccount[], opts: SplitOptions = {}): SplitPlan {
  const quotes = venueQuotes(base, side, qty, accounts);
  const plan: SplitPlan = { base, side, qty, lot: 0, quotes, feasible: false, maxQty: 0, slices: [], grossUsd: 0, feeUsd: 0, netUsd: 0, avgPrice: 0, passed: [] };
  const ref = PRICES[base];
  if (!ref || !(qty > 0)) return plan;
  const minGain = opts.minGainPerLegUsd ?? EXTRA_LEG_MIN_GAIN_USD;
  const usable = sourcesFor(base, side, accounts).filter((s) => !s.blocked && (opts.ignoreInventory === true || s.have > 0));
  const lot = lotOf(qty);
  plan.lot = lot;
  const whole = Math.floor(qty / lot + 1e-9);
  const rest = r8(qty - whole * lot);

  /** variable proceeds (sell) or cost (buy) of `q` at one source, without its fixed cost */
  const variable = (s: Source, q: number): number | undefined => {
    const raw = s.kind === "cex" ? rawBook(BOOKS[s.venue]!, ref, side, q) : rawSwap(s.chain!, base, side, q);
    return raw ? (side === "sell" ? raw.gross - raw.fee : raw.gross + raw.fee) : undefined;
  };
  const fixed = (s: Source) => (s.kind === "dex" ? (DEX_GAS_USD[s.chain!] ?? 1) : 0);
  const holds = (s: Source, q: number, cost: number): boolean => opts.ignoreInventory === true || (side === "sell" ? q <= s.have + 1e-9 : cost + fixed(s) <= s.have - 0.01);

  /** lot by lot to the best marginal price among the sources that can still take one */
  const fill = (subset: Source[]): Map<Source, number> | undefined => {
    const got = new Map<Source, number>(subset.map((s) => [s, 0]));
    const value = new Map<Source, number>(subset.map((s) => [s, 0]));
    const next = new Map<Source, { q: number; v: number; m: number } | null>();
    const steps = [...Array<number>(whole).fill(lot), ...(rest > 1e-9 ? [rest] : [])];
    let last = lot;
    for (const d of steps) {
      if (d !== last) next.clear();
      last = d;
      let best: Source | undefined;
      for (const s of subset) {
        if (!next.has(s)) {
          const q = r8(got.get(s)! + d);
          const v = variable(s, q);
          next.set(s, v !== undefined && holds(s, q, v) ? { q, v, m: (v - value.get(s)!) / d } : null);
        }
        const c = next.get(s);
        if (!c) continue;
        const b = best ? next.get(best)! : undefined;
        if (!b || (side === "sell" ? c.m > b.m + 1e-12 : c.m < b.m - 1e-12)) best = s;
      }
      if (!best) return undefined;
      const c = next.get(best)!;
      got.set(best, c.q);
      value.set(best, c.v);
      next.delete(best);
    }
    return got;
  };

  interface Candidate {
    slices: Slice[];
    net: number;
  }
  const candidates: Candidate[] = [];
  for (let mask = 1; mask < 1 << usable.length; mask++) {
    const subset = usable.filter((_, i) => mask & (1 << i));
    const got = fill(subset);
    if (!got) continue;
    const slices: Slice[] = [];
    let affordable = true;
    for (const [s, q] of got) {
      if (q <= 1e-9) continue;
      const f = fillAt(s.venue, base, side, q);
      if (!f || (side === "buy" && opts.ignoreInventory !== true && f.netUsd > s.have)) affordable = false;
      else slices.push({ ...f, account: s.account });
    }
    if (!affordable || !slices.length) continue;
    const perUnit = (x: Slice) => x.netUsd / x.qty;
    slices.sort((a, b) => (side === "sell" ? perUnit(b) - perUnit(a) : perUnit(a) - perUnit(b)) || a.venue.localeCompare(b.venue));
    candidates.push({ slices, net: r2(slices.reduce((s, x) => s + x.netUsd, 0)) });
  }
  const better = (a: number, b: number) => (side === "sell" ? a - b : b - a);
  const score = (c: Candidate) => (side === "sell" ? c.net : -c.net) - minGain * (c.slices.length - 1);
  const chosen = [...candidates].sort((a, b) => score(b) - score(a) || a.slices.length - b.slices.length)[0];
  if (!chosen) {
    // not even together: say how much they could take
    plan.maxQty = r8(
      usable.reduce((sum, s) => {
        if (side === "sell") return sum + s.have;
        let lo = 0;
        let hi = (s.have / ref) * 1.01;
        for (let i = 0; i < 60; i++) {
          const m = (lo + hi) / 2;
          const v = variable(s, m);
          if (v !== undefined && v + fixed(s) <= s.have - 0.01) lo = m;
          else hi = m;
        }
        return sum + Math.floor(lo / lot) * lot;
      }, 0),
    );
    return plan;
  }
  plan.feasible = true;
  plan.maxQty = qty;
  plan.slices = chosen.slices;
  plan.grossUsd = r2(chosen.slices.reduce((s, x) => s + x.grossUsd, 0));
  plan.feeUsd = r2(chosen.slices.reduce((s, x) => s + x.feeUsd, 0));
  plan.netUsd = chosen.net;
  plan.avgPrice = r2(plan.grossUsd / qty);
  plan.single = candidates.filter((c) => c.slices.length === 1).sort((a, b) => better(b.net, a.net))[0]?.slices[0];
  if (plan.single && chosen.slices.length > 1) plan.gainUsd = r2(better(chosen.net, plan.single.netUsd));
  for (const s of usable) {
    if (chosen.slices.some((x) => x.venue === s.venue)) continue;
    const withIt = candidates.filter((c) => c.slices.some((x) => x.venue === s.venue)).sort((a, b) => better(b.net, a.net))[0];
    const delta = withIt ? r2(better(withIt.net, chosen.net)) : 0;
    if (delta < 0) plan.passed.push({ venue: s.venue, name: s.name, have: s.have, deltaUsd: delta, gasUsd: s.kind === "dex" ? fixed(s) : undefined });
  }
  const richest = [...candidates].sort((a, b) => better(b.net, a.net) || a.slices.length - b.slices.length)[0]!;
  if (better(richest.net, chosen.net) > 0) plan.richer = { slices: richest.slices, gainUsd: r2(better(richest.net, chosen.net)) };
  return plan;
}
