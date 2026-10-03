/** Execution liquidity: the same order, quoted at every venue that could take
 * it. A venue is a mid price (venues disagree by a few bps), a half-spread, a
 * depth (how many bps the price moves per dollar of size), a taker fee and —
 * for the on-chain route — gas. The adapters FILL with the same function that
 * quotes, so a quote the agent compared is the price it gets.
 *
 * Illustrative numbers, real shapes: a deep CEX with a 10 bps fee, a second
 * CEX that is a little thinner and a little cheaper, and a DEX route through
 * the MetaMask wallet's swap aggregator (5 bps pool fee, price impact against
 * a pool, gas per chain). Liquidity is also inventory: a venue that does not
 * hold the asset cannot sell it, and the quote says so.
 */
import { PRICES, r2 } from "./accounts.ts";
import type { RailAccount } from "./rails.ts";

export interface VenueModel {
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
  gasUsd: number;
}

export const VENUES: Record<string, VenueModel> = {
  binance: { name: "Binance", quote: "USDT", symbol: (b) => `${b}USDT`, midAdjBps: 0, halfSpreadBps: 0.5, depthUsdPer10bps: 2_000_000, feeBps: 10, gasUsd: 0 },
  okx: { name: "OKX", quote: "USDT", symbol: (b) => `${b}-USDT`, midAdjBps: 5, halfSpreadBps: 1, depthUsdPer10bps: 1_000_000, feeBps: 8, gasUsd: 0 },
  metamask: { name: "DEX（经 MetaMask）", quote: "USDC", symbol: (b) => `${b}-USDC`, midAdjBps: -4, halfSpreadBps: 0, depthUsdPer10bps: 300_000, feeBps: 5, gasUsd: 4 },
};

export const DEX_GAS_USD: Record<string, number> = { Ethereum: 4, Base: 0.5 };

export interface Fill {
  venue: string;
  name: string;
  symbol: string;
  base: string;
  quote: string;
  side: "buy" | "sell";
  qty: number;
  mid: number;
  price: number;
  grossUsd: number;
  feeUsd: number;
  /** sell: what lands in the account · buy: what leaves it */
  netUsd: number;
  impactBps: number;
}

export function fillAt(venue: string, base: string, side: "buy" | "sell", qty: number, gasUsd?: number): Fill | undefined {
  const v = VENUES[venue];
  const ref = PRICES[base];
  if (!v || !ref || !(qty > 0) || base === v.quote) return undefined;
  const mid = ref * (1 + v.midAdjBps / 1e4);
  const impactBps = (10 * qty * mid) / v.depthUsdPer10bps;
  const slip = (v.halfSpreadBps + impactBps) / 1e4;
  const price = r2(side === "sell" ? mid * (1 - slip) : mid * (1 + slip));
  const grossUsd = r2(qty * price);
  const feeUsd = r2((grossUsd * v.feeBps) / 1e4 + (gasUsd ?? v.gasUsd));
  const netUsd = r2(side === "sell" ? grossUsd - feeUsd : grossUsd + feeUsd);
  return { venue, name: v.name, symbol: v.symbol(base), base, quote: v.quote, side, qty, mid: r2(mid), price, grossUsd, feeUsd, netUsd, impactBps: Number(impactBps.toFixed(3)) };
}

export interface VenueQuote extends Fill {
  ok: boolean;
  /** why this venue cannot take the order, in the user's words */
  why?: string | undefined;
}

/** one quote per connected venue; a venue that cannot take the order still answers, with the reason */
export function venueQuotes(base: string, side: "buy" | "sell", qty: number, accounts: RailAccount[]): VenueQuote[] {
  const out: VenueQuote[] = [];
  for (const id of Object.keys(VENUES)) {
    const a = accounts.find((x) => x.id === id);
    if (!a) continue;
    const v = VENUES[id]!;
    const held = a.holdings.filter((h) => h.asset === base);
    const heldQty = held.reduce((s, h) => s + h.amount, 0);
    const paying = a.holdings.filter((h) => h.asset === v.quote);
    const chain = (side === "sell" ? held : paying).find((h) => h.note && h.note in DEX_GAS_USD)?.note;
    const fill = fillAt(id, base, side, qty, id === "metamask" && chain ? DEX_GAS_USD[chain] : undefined);
    if (!fill) continue;
    let why: string | undefined;
    if (!a.reach.includes("trade")) why = a.revoked ? "你关了" : "交易没开放";
    else if (side === "sell" && heldQty < qty) why = heldQty > 0 ? `只有 ${heldQty} ${base}` : `没有 ${base}`;
    else if (side === "buy" && paying.reduce((s, h) => s + h.amount, 0) < fill.netUsd) why = `${v.quote} 不够`;
    out.push({ ...fill, ok: why === undefined, why });
  }
  return out;
}

/** sell: the most that lands · buy: the least that leaves */
export function bestVenue(quotes: VenueQuote[], side: "buy" | "sell"): VenueQuote | undefined {
  return quotes.filter((q) => q.ok).sort((a, b) => (side === "sell" ? b.netUsd - a.netUsd : a.netUsd - b.netUsd))[0];
}
