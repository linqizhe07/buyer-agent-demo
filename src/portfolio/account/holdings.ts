/** WHAT YOU OWN, by asset: every connected venue's balances read as one list, the way a wallet's home screen lists them.
 *
 * Each venue calls the same thing by its own name, and holds it in its own place: BTC at an exchange, WBTC in a wallet on Arbitrum and
 * BTC at a broker are one row with three venue lines under it. Nothing here asks a venue anything: it reads what the account page already
 * holds (AccountPage.venues[].holdings, account/exchange.ts), and the same input always gives the same rows.
 *
 *   byAsset(venues, opts)   the rows, largest first, and the dollars that are ready (`money`), split the way the page's Cash ready card
 *                           splits them (public/account.js renderLiquidity): traded where they are, moved between the user's own
 *                           accounts, or taken out only at the venue itself
 *   change24h(rows, stats)  what the rows gained or lost in the last 24 hours, from each market's own 24-hour change, and how much of the
 *                           total that covers
 *
 * One row is one thing, by its class:
 *   · a COIN (class crypto) by its one name, as live/compare.ts `normalBase` gives it: `WBTC`, `XBT`, `cbBTC` → BTC; `WETH` → ETH;
 *   · a DOLLAR STABLECOIN by its own symbol: USDC and USDT stay two rows (each is a dollar, but not the same issuer's), and so do USDC
 *     and the bridged USDC.e. Cash is a row per currency;
 *   · an EVENT CONTRACT by its own symbol: one outcome of one question, at the venue that lists it;
 *   · a STOCK, a stock token, an RWA by its ticker. A venue line's note says what it is there ("Arbitrum · Stock Token");
 *   · money in an EARN product (class earn) by its venue and product, `earn:<venue>:<product>`: a vault, OKX's Simple Earn, a Kraken Earn
 *     strategy is the venue's own, so the same USDC in two products is two rows, and none of them is the USDC that is ready. It is owned
 *     (in the total), not ready (not in `money`), and its 24 hours are its asset's: a dollar's change by nothing, a coin's as the coin's.
 *
 * A holding the venue could not price counts no dollars (the live adapter's "no price"): its amount is in the row, its dollars are not,
 * and the row's price is from the venue lines that are priced. Money on its way (`inTransit`) is owned, so it is in the rows, and it is not
 * ready, so it is not in what is ready.
 */
import type { AssetClass } from "../accounts.ts";
import { isRwaMarket } from "../live/categories.ts";
import { normalBase } from "../live/compare.ts";
import type { MarketKind, MarketStats } from "../live/trade.ts";
import { isStable } from "../live/types.ts";
import type { AccountPage } from "./exchange.ts";

type PageVenue = AccountPage["venues"][number];
/** what byAsset reads of a venue on the account page: its balances, and what decides where its dollars can go */
export type HoldingsVenue = Pick<PageVenue, "id" | "name" | "holdings"> & Partial<Pick<PageVenue, "trade" | "liveCan" | "readOnlyBecause" | "address" | "proven" | "stale">>;

/** one venue's part of a row */
export interface AssetLine {
  venue: string;
  venueName: string;
  amount: number;
  /** in dollars; 0 when the venue could not price it (`noPrice`) */
  usd: number;
  /** which of the venue's ledgers or which chain, as the venue said */
  note?: string | undefined;
  /** on its way (a redemption, a settlement): owned, not yet usable */
  inTransit?: true | undefined;
  /** the venue gave no price for it, and no price was found */
  noPrice?: true | undefined;
  /** the venue's last read failed: this is the last good number */
  stale?: true | undefined;
  /** an address the owner watches, not one proven theirs */
  watched?: true | undefined;
}

/** one thing the user owns, across every venue that holds it */
export interface AssetRow {
  /** the row's one name: `crypto:BTC`, `stable:USDC`, `cash:USD`, `equity:AAPL`, `event:KXFED-25DEC-T4.00:YES`, `rwa:USDY` */
  key: string;
  /** in words: the coin's one name, or the symbol as the first venue wrote it */
  asset: string;
  class: AssetClass;
  /** in the asset's own units, at every venue together */
  amount: number;
  usd: number;
  /** what one unit is worth, from the venue lines that are priced; absent when none is */
  price?: number | undefined;
  /** the amount no venue could price (and that counts no dollars) */
  unpriced?: number | undefined;
  /** largest first */
  venues: AssetLine[];
  /** class `earn`: the product the money is in, at one venue — what goes in and comes out, its name and its yield as the venue says */
  earn?: { venue: string; venueName: string; product: string; asset: string; name?: string | undefined; apy?: number | undefined; accrued?: number | undefined; accruedUsd?: number | undefined } | undefined;
}

/** where one venue's ready dollars can go, as the Cash ready card says it */
export interface ReadyVenue {
  venue: string;
  venueName: string;
  usd: number;
  lines: Array<{ asset: string; note?: string | undefined; usd: number }>;
  /** orders can be placed with it where it is */
  tradesHere: boolean;
  /** it can be moved from here to another account of the user's */
  movesOut: boolean;
  /** why it cannot move from here, when it cannot */
  why?: string | undefined;
}

/** the dollars: cash and dollar stablecoins */
export interface MoneySummary {
  cashUsd: number;
  stableUsd: number;
  /** cash and stablecoins on their way: owned, not ready */
  inTransitUsd: number;
  /** cash and stablecoins that are ready: `cashUsd + stableUsd` */
  readyUsd: number;
  /** of what is ready: what can trade where it is · what can move between the user's accounts · what leaves only at its venue. The last
   * two add up to `readyUsd`; the first overlaps them (a dollar at an exchange can do both) */
  tradesHereUsd: number;
  canMoveUsd: number;
  staysUsd: number;
  /** largest first */
  venues: ReadyVenue[];
}

export interface Holdings {
  rows: AssetRow[];
  money: MoneySummary;
}

export interface ByAssetOptions {
  /** this server moves real money (AccountPage.connectLive.writes.on). Off, or absent: nothing trades or moves from here, every ready dollar
   * stays where it is */
  writes?: boolean | undefined;
}

const r2 = (n: number): number => Number(n.toFixed(2)) || 0;
/** an amount without binary dust */
const units = (n: number): number => Number(n.toFixed(10)) || 0;
const dollars = (c: AssetClass): boolean => c === "cash" || c === "stable";

/** the row of money in an earn product: one per venue and product */
export const earnKey = (venue: string, product: string): string => `earn:${venue}:${product}`;

/** The row a holding belongs to. A coin by its one name; anything else by its symbol, in capitals (money in an earn product: earnKey) */
export function assetKey(asset: string, cls: AssetClass): string {
  const s = asset.trim();
  if (cls === "crypto") return `crypto:${normalBase(s, "crypto") || s.toUpperCase()}`;
  return `${cls}:${s.toUpperCase()}`;
}

/** The class a market's base is held as, once bought: a stock's share, an event contract, a token an issuer stands behind (a market of
 * category RWA: live/categories.ts), a dollar stablecoin, a coin. A perpetual or a dated future is a position, not something held: none */
export function marketClass(kind: MarketKind, base: string, category?: string | undefined): AssetClass | undefined {
  if (kind === "perp" || kind === "future") return undefined;
  if (kind === "stock") return "equity";
  if (kind === "event") return "event";
  if (isRwaMarket({ kind, category })) return "rwa";
  return isStable(normalBase(base, kind) || base) ? "stable" : "crypto";
}

/** The row an order's market belongs to, or none (a perpetual, a dated future): a stock by its ticker, an event contract by its symbol, a
 * token an issuer stands behind by its symbol (`rwa:USDY`, as a wallet holds it), a coin by its one name */
export function marketKey(m: { kind: MarketKind; base: string; symbol: string; category?: string | undefined }): string | undefined {
  const cls = marketClass(m.kind, m.base, m.category);
  if (!cls) return undefined;
  if (cls === "event") return assetKey(m.symbol, "event");
  if (cls === "equity") return assetKey(normalBase(m.base || m.symbol, "stock"), "equity");
  if (cls === "rwa") return assetKey(m.base || m.symbol, "rwa");
  return assetKey(normalBase(m.base || m.symbol, m.kind) || m.base, cls);
}

// ---- where a venue's dollars can go: the page's own rules (public/account.js canTrade, canMove, watched) ----------------------------

/** an address the owner watches: shown, never traded or sent from */
export const isWatched = (v: Pick<HoldingsVenue, "address" | "proven">): boolean => !!v.address && !v.proven;
/** an order can be placed here: the server moves real money, the venue trades, the key may (or has not said), and a wallet is proven theirs */
export const tradesHere = (v: HoldingsVenue, writes: boolean): boolean => writes && !!v.trade && v.trade.can !== false && !isWatched(v);
/** money can leave here for another account of the user's: a withdrawal, a move between the venue's own ledgers, a swap, or a send from a
 * wallet — unless the venue is read-only for money or the key lets nothing out */
export function movesOut(v: HoldingsVenue, writes: boolean): boolean {
  const c = v.liveCan;
  return writes && !!c && !v.readOnlyBecause && !isWatched(v) && (c.withdraw !== false || (c.ledgers.length > 1 && c.transfer !== false) || c.swap !== false || !!c.send);
}
function staysBecause(v: HoldingsVenue, writes: boolean): string {
  if (!writes) return "this server does not move money";
  if (v.readOnlyBecause) return "moves only at the venue";
  if (isWatched(v)) return "watched";
  return "this key only reads";
}

/** Every venue's holdings as rows by asset, largest first, and the ready dollars as the Cash ready card splits them */
export function byAsset(venues: readonly HoldingsVenue[], opts: ByAssetOptions = {}): Holdings {
  const writes = opts.writes === true;
  const rows = new Map<string, AssetRow>();
  const ready = new Map<string, ReadyVenue>();
  let cashUsd = 0;
  let stableUsd = 0;
  let inTransitUsd = 0;
  for (const v of venues) {
    const watched = isWatched(v);
    for (const h of v.holdings ?? []) {
      if (!(h.amount > 0) && !(h.usd > 0)) continue;
      const noPrice = !(h.usd > 0) && /\bno price\b/.test(h.note ?? "");
      const usd = noPrice || !Number.isFinite(h.usd) ? 0 : h.usd;
      const earn = h.class === "earn" ? h.earn : undefined;
      const key = earn ? earnKey(v.id, earn.product) : assetKey(h.asset, h.class);
      let row = rows.get(key);
      if (!row) {
        row = { key, asset: h.class === "crypto" ? key.slice("crypto:".length) : (earn?.asset ?? h.asset).trim(), class: h.class, amount: 0, usd: 0, venues: [], ...(earn ? { earn: { venue: v.id, venueName: v.name, product: earn.product, asset: earn.asset, ...(earn.name ? { name: earn.name } : {}), ...(earn.apy !== undefined ? { apy: earn.apy } : {}), ...(earn.accrued !== undefined ? { accrued: earn.accrued } : {}), ...(earn.accruedUsd !== undefined ? { accruedUsd: earn.accruedUsd } : {}) } } : {}) };
        rows.set(key, row);
      }
      row.amount += h.amount;
      row.usd += usd;
      if (noPrice) row.unpriced = (row.unpriced ?? 0) + h.amount;
      // a venue that holds the same thing in two places (two chains, two ledgers) has a line for each: the note says which
      row.venues.push({ venue: v.id, venueName: v.name, amount: h.amount, usd: r2(usd), ...(h.note ? { note: h.note } : {}), ...(h.inTransit ? { inTransit: true as const } : {}), ...(noPrice ? { noPrice: true as const } : {}), ...(v.stale || earn?.stale ? { stale: true as const } : {}), ...(watched ? { watched: true as const } : {}) });
      if (!dollars(h.class) || !(usd > 0)) continue;
      if (h.inTransit) {
        inTransitUsd += usd;
        continue;
      }
      if (h.class === "cash") cashUsd += usd;
      else stableUsd += usd;
      let r = ready.get(v.id);
      if (!r) {
        const moves = movesOut(v, writes);
        r = { venue: v.id, venueName: v.name, usd: 0, lines: [], tradesHere: tradesHere(v, writes), movesOut: moves, ...(moves ? {} : { why: staysBecause(v, writes) }) };
        ready.set(v.id, r);
      }
      r.usd += usd;
      r.lines.push({ asset: h.asset, ...(h.note ? { note: h.note } : {}), usd: r2(usd) });
    }
  }
  const out = [...rows.values()].map((row): AssetRow => {
    const priced = row.venues.filter((l) => !l.noPrice && l.usd > 0);
    const pricedAmount = priced.reduce((s, l) => s + l.amount, 0);
    const pricedUsd = priced.reduce((s, l) => s + l.usd, 0);
    return {
      ...row,
      amount: units(row.amount),
      usd: r2(row.usd),
      ...(pricedAmount > 0 ? { price: Number((pricedUsd / pricedAmount).toPrecision(10)) } : {}),
      ...(row.unpriced ? { unpriced: units(row.unpriced) } : {}),
      venues: row.venues.sort((a, b) => b.usd - a.usd || b.amount - a.amount),
    };
  });
  out.sort((a, b) => b.usd - a.usd || a.key.localeCompare(b.key));
  const byVenue = [...ready.values()].map((r) => ({ ...r, usd: r2(r.usd) })).sort((a, b) => b.usd - a.usd);
  const readyUsd = cashUsd + stableUsd;
  const canMoveUsd = byVenue.filter((r) => r.movesOut).reduce((s, r) => s + r.usd, 0);
  return {
    rows: out,
    money: {
      cashUsd: r2(cashUsd),
      stableUsd: r2(stableUsd),
      inTransitUsd: r2(inTransitUsd),
      readyUsd: r2(readyUsd),
      tradesHereUsd: r2(byVenue.filter((r) => r.tradesHere).reduce((s, r) => s + r.usd, 0)),
      canMoveUsd: r2(canMoveUsd),
      staysUsd: r2(Math.max(0, readyUsd - canMoveUsd)),
      venues: byVenue,
    },
  };
}

// ---- the last 24 hours ------------------------------------------------------------------------------

/** a market's last 24 hours, as much as change24h reads of it */
export type DayStats = Pick<MarketStats, "changePct24h" | "change24h" | "price">;

export interface DayChange {
  /** what the rows gained (or lost: negative) in dollars */
  usd: number;
  /** that, in percent of what the same rows were worth 24 hours ago; absent when no row is covered */
  pct?: number | undefined;
  /** the dollars whose 24-hour change is known (cash and dollar stablecoins are: they are counted one for one), of `ofUsd` in all */
  coveredUsd: number;
  ofUsd: number;
  /** the rows with dollars whose change is not known: no market said */
  missing: string[];
}

/** One row's change in percent: the venue's own percentage, or, where it gives the change in price only, that change against its own price
 * 24 hours ago. Never a guess */
function pctOf(s: DayStats | undefined): number | undefined {
  if (!s) return undefined;
  if (typeof s.changePct24h === "number" && Number.isFinite(s.changePct24h) && s.changePct24h > -100) return s.changePct24h;
  if (typeof s.change24h === "number" && Number.isFinite(s.change24h) && typeof s.price === "number" && s.price > 0) {
    const before = s.price - s.change24h;
    if (before > 0) return (s.change24h / before) * 100;
  }
  return undefined;
}

/** What the rows gained or lost in the last 24 hours: each row's dollars now, against what they were worth at its market's price 24 hours
 * ago (the amount held now, at yesterday's price: a buy or a sell in between is not a gain). `stats` is keyed by the row's key
 * (`crypto:BTC`) or by its asset (`BTC`). Cash and dollar stablecoins change by nothing; a row no market speaks for is left out of the
 * change and named in `missing`, so `coveredUsd` says how much of the total the change is about */
export function change24h(rows: readonly AssetRow[], stats: ReadonlyMap<string, DayStats> | Readonly<Record<string, DayStats>>): DayChange {
  const map = typeof (stats as ReadonlyMap<string, DayStats>).get === "function" ? (stats as ReadonlyMap<string, DayStats>) : undefined;
  const get = (k: string): DayStats | undefined => (map ? map.get(k) : Object.hasOwn(stats, k) ? (stats as Readonly<Record<string, DayStats>>)[k] : undefined);
  let usd = 0;
  let before = 0;
  let covered = 0;
  let of = 0;
  const missing: string[] = [];
  for (const row of rows) {
    if (!(row.usd > 0)) continue;
    of += row.usd;
    // money in an earn product changes as what is in it does: a dollar's by nothing, a coin's as the coin's
    const inEarn = row.class === "earn" ? (row.earn?.asset ?? row.asset) : undefined;
    if (dollars(row.class) || (inEarn !== undefined && isStable(inEarn))) {
      covered += row.usd;
      before += row.usd;
      continue;
    }
    const pct = pctOf(inEarn !== undefined ? (get(assetKey(inEarn, "crypto")) ?? get(inEarn.toUpperCase())) : (get(row.key) ?? get(row.asset)));
    if (pct === undefined) {
      missing.push(row.key);
      continue;
    }
    const then = row.usd / (1 + pct / 100);
    covered += row.usd;
    before += then;
    usd += row.usd - then;
  }
  return { usd: r2(usd), ...(covered > 0 && before > 0 ? { pct: r2((usd / before) * 100) } : {}), coveredUsd: r2(covered), ofUsd: r2(of), missing };
}

// ---- money in earn products, beside a venue's balances -------------------------------------------------------------------------------

/** what a venue's earn says the user has in one product (live/earn.ts EarnPosition, as much as is read here) */
export interface EarnHeld {
  product: string;
  /** what the venue counts it in: the product's asset (OKX, Kraken, an mm vault's underlying token) */
  asset: string;
  amount: number;
  usd?: number | undefined;
  apy?: number | undefined;
  accrued?: number | undefined;
  accruedUsd?: number | undefined;
  name?: string | undefined;
  /** the chain a vault is on, as the venue names it */
  chain?: string | undefined;
}

type PageHolding = PageVenue["holdings"][number];

/** Kraken's balance names an Earn allocation by its asset and a suffix (Kraken's Get Account Balance: `.B` yield-bearing products, `.F`
 * Kraken Rewards, `.S` staked, `.M` opt-in rewards, `.P` parachain) — `USDC.B`, `BTC.B` once the exchange library has named the asset */
const EARN_SUFFIX = /^([A-Za-z0-9]+)\.(B|F|S|M|P)$/i;
const coinOf = (asset: string): string => normalBase(asset, "crypto") || asset.toUpperCase();
/** a line's chain, as a wallet's balance names it: the first part of its note ("Base", "Base · no price") */
const chainOfNote = (note: string | undefined): string => (note ?? "").split(" · ")[0]!.trim().toLowerCase();
/** one chain under two spellings: "Base" and "Base Mainnet", "BNB Chain" and "BNB Chain Mainnet" */
const sameChain = (a: string, b: string): boolean => a !== "" && b !== "" && (a === b || a.startsWith(`${b} `) || b.startsWith(`${a} `));
const pctText = (apy: number): string => `${Number((apy * 100).toFixed(2))}%`;

/** One venue's holdings with what it has in its earn products added, each product a holding of class `earn` — and the balance lines that
 * are the SAME money left out, so nothing is counted twice:
 *   · a Kraken Earn allocation is also in Kraken's balance, as `<ASSET>.<suffix>` (unpriced there): that line goes, the allocation stays;
 *   · a vault's shares a wallet holds (an ERC-4626 token, an Aave aToken) may also be in the wallet's balance, under the vault's own symbol on
 *     the vault's chain: that line goes. `shares` names a vault's symbol where it is known (read from the chain), and then only a line under
 *     that symbol goes — none, when the balance does not list the shares; where the chain gave no symbol, a line on the same chain whose
 *     symbol carries the vault's asset in it (`aBasUSDC`, `steakUSDC`), is not a dollar itself, and is worth what the position is (within
 *     2%, or 50¢) is taken for it;
 *   · OKX's Simple Earn is not in the funding or the trading balance (it leaves the funding account when it goes in), so nothing goes there.
 * `stale`: the venue's earn did not answer this time, and these are the last good numbers */
export function withEarn(v: Pick<PageVenue, "name" | "holdings">, held: readonly EarnHeld[], opts: { stale?: boolean | undefined; shares?: ReadonlyMap<string, string> | undefined } = {}): { holdings: PageHolding[]; dropped: PageHolding[] } {
  const live = held.filter((p) => p.amount > 0);
  if (!live.length) return { holdings: [...v.holdings], dropped: [] };
  const assets = new Set(live.map((p) => coinOf(p.asset)));
  const dropped = new Set<PageHolding>();
  for (const h of v.holdings) {
    if (h.class === "earn") continue;
    const k = EARN_SUFFIX.exec(h.asset.trim());
    if (k && assets.has(coinOf(k[1]!))) dropped.add(h);
  }
  for (const p of live) {
    const chain = (p.chain ?? "").trim().toLowerCase();
    if (!chain) continue;
    const share = opts.shares?.get(p.product);
    const onChain = v.holdings.filter((h) => h.class !== "earn" && !dropped.has(h) && sameChain(chainOfNote(h.note), chain) && h.asset.trim().toUpperCase() !== p.asset.trim().toUpperCase());
    // a symbol the chain gave is the whole answer: no line under it means the wallet's balance does not list the shares, and a look-alike
    // of the same worth (another protocol's aToken, say) is someone else's money, not this vault's
    const like = share ? onChain.find((h) => h.asset.trim() === share.trim()) : (p.usd !== undefined && p.usd > 0 ? onChain.filter((h) => !isStable(h.asset) && h.asset.toUpperCase().includes(p.asset.trim().toUpperCase()) && Math.abs(h.usd - p.usd!) <= Math.max(0.5, p.usd! * 0.02)).sort((a, b) => Math.abs(a.usd - p.usd!) - Math.abs(b.usd - p.usd!))[0] : undefined);
    if (like) dropped.add(like);
  }
  const lines: PageHolding[] = live.map((p) => {
    const usd = p.usd !== undefined && Number.isFinite(p.usd) ? p.usd : isStable(p.asset) ? p.amount : undefined;
    const note = [`earning${p.apy !== undefined ? ` ${pctText(p.apy)}` : ""} at ${v.name}`, p.name, opts.stale ? "the venue's last read" : undefined, usd === undefined ? "no price" : undefined].filter(Boolean).join(" · ");
    return { asset: p.asset, amount: p.amount, usd: r2(usd ?? 0), class: "earn", note, inTransit: false, earn: { product: p.product, asset: p.asset, ...(p.name ? { name: p.name } : {}), ...(p.apy !== undefined ? { apy: p.apy } : {}), ...(p.accrued !== undefined ? { accrued: p.accrued } : {}), ...(p.accruedUsd !== undefined ? { accruedUsd: p.accruedUsd } : {}), ...(opts.stale ? { stale: true as const } : {}) } };
  });
  return { holdings: [...v.holdings.filter((h) => !dropped.has(h)), ...lines], dropped: [...dropped] };
}
