/** EARN at a venue connected live: the products the user's money can be put to work in, what is in them, and money put in or taken out.
 *
 * Three venues have an interface for it, each its own:
 *
 *   MetaMask Agent Wallet   DeFi vaults through MetaMask's `mm earn` (LI.FI's earn API): `mm earn markets` lists the vaults, `mm earn
 *                           positions` what the wallet holds in them, `mm earn supply --vault` and `mm earn withdraw --vault` move money
 *                           in and out — from the wallet, back to the wallet, on the vault's own chain. It lives in metamask.ts, beside
 *                           the mm trader, because it speaks mm's language
 *   OKX                     Simple Earn Flexible ("savings"), through the exchange's own API with the account's own key:
 *                             GET  /api/v5/finance/savings/lending-rate-history   the annual lending rate (public)
 *                             GET  /api/v5/finance/savings/balance                what is lent, and earned (the key's Read permission)
 *                             POST /api/v5/finance/savings/purchase-redempt       in (purchase) or out (redempt) — the key's Trade
 *                                                                                 permission. Only the FUNDING account's assets can be
 *                                                                                 put in, and what comes out lands there
 *   Kraken                  Kraken Earn, through its own API with the account's own key:
 *                             POST /0/private/Earn/Strategies                     the strategies offered here (any valid key; Kraken
 *                                                                                 lists only what it offers in the user's region)
 *                             POST /0/private/Earn/Allocations                    what is allocated, and earned (Query Funds)
 *                             POST /0/private/Earn/Allocate · Deallocate          in or out (Earn Funds); asynchronous: Earn/AllocateStatus
 *                                                                                 and Earn/DeallocateStatus say when it is done
 *   KuCoin                  KuCoin Earn, through its own API with the account's own key (www.kucoin.com/docs-new/rest/earn, read
 *                           2026-10-06; every call under /api/v1/earn):
 *                             GET  earn/saving/products · promotion/products ·    what is offered (the key's General permission): flexible
 *                                  staking/products · kcs-staking/products ·      savings (type DEMAND, out at any time) and fixed terms
 *                                  eth-staking/products                           (type TIME), each with its annualized returnRate
 *                             GET  earn/hold-assets                               what is held, holding by holding (General)
 *                             POST earn/orders                                    in, from the trading account (the key's Earn permission)
 *                             GET  earn/redeem-preview                            what a redemption would do: a penalty on an early one
 *                             DELETE earn/orders                                  out, back to the trading account (Earn); PENDING until
 *                                                                                 KuCoin delivers it, which hold-assets shows
 *                           Binance's Simple Earn has an interface too, and is not offered: Binance answers this machine 451
 *
 * A withdrawal lands where the money came from, at the same venue, always: none of these calls takes a destination, and the account
 * sends none. Nothing here decides WHETHER money goes in or out: the account's earn door does (account/live-earn.ts) — the server's
 * switch and cap, the owner's signature or the agent's earn limit, the mode. An adapter only speaks its venue's language, and a refusal is
 * the venue's own words, with what the owner can do about it.
 */
import { isRefusal, type Refusal } from "../../core/errors.ts";
import { no } from "../refuse.ts";
import type { KeyFile } from "./credentials.ts";
import { exchangeSaidNo, isOkx, type ExchangeClient } from "./exchange.ts";
import { plain } from "./trade.ts";
import type { Price } from "./prices.ts";
import { isStable, num } from "./types.ts";

/** one product money can be put into */
export interface EarnProduct {
  /** the venue's id for it: `8453:0x…` (a vault on a chain, through mm), `savings:USDT` (OKX Simple Earn Flexible), Kraken's strategy id */
  id: string;
  /** what goes in, and what comes out */
  asset: string;
  name: string;
  /** a year's yield as a fraction (0.052 is 5.2%), as the venue states it now; where it states a range, the low end (`apyHigh` the top) */
  apy?: number | undefined;
  apyHigh?: number | undefined;
  /** the venue's word for the figure: an APY (compounded) or an APR (not) */
  rateKind?: "apy" | "apr" | undefined;
  protocol?: string | undefined;
  chain?: string | undefined;
  /** the least that goes in, in the asset */
  minAmount?: number | undefined;
  /** days the money stays after a withdrawal is asked (0: out at once); absent: the venue does not say */
  lockDays?: number | undefined;
  tvlUsd?: number | undefined;
  /** what one unit of the asset is worth in dollars, where the venue or a public price says */
  priceUsd?: number | undefined;
  /** where money taken out of it lands, in words: the place it came from */
  lands: string;
  /** may money go in now, and may it come out: the venue's own flags */
  canSupply: boolean;
  canWithdraw: boolean;
  /** why money cannot go in, in the venue's words, where it cannot */
  why?: string | undefined;
  note?: string | undefined;
}

/** what the user has in a product */
export interface EarnPosition {
  /** the product it is in (EarnProduct.id) */
  product: string;
  id: string;
  /** what the venue counts it in: the product's asset, or the vault's own share token (mm: `mUSDC` for a vault of USDC) */
  asset: string;
  amount: number;
  usd?: number | undefined;
  apy?: number | undefined;
  /** earned so far, where the venue says: in the asset and in dollars */
  accrued?: number | undefined;
  accruedUsd?: number | undefined;
  name?: string | undefined;
  chain?: string | undefined;
  protocol?: string | undefined;
  /** money on its way in or out, where the venue says (Kraken's pending allocation, OKX's pending amount) */
  pending?: number | undefined;
}

/** what became of money put in or taken out: `pending` while the venue (or the wallet, waiting for the owner's approval in MetaMask) has
 * not finished it, `done`, or `rejected` by the venue afterwards */
export interface EarnState {
  ref: string;
  status: "pending" | "done" | "rejected";
  native: unknown;
}

export interface LiveEarner {
  /** may this key or wallet put money in here: what the venue said, `unknown` where it has no call that says (its first refusal will) */
  can: boolean | "unknown";
  whyNot?: string | undefined;
  /** what is earned here, in a few words */
  what: string;
  /** the products offered here, in one asset when asked */
  products(asset?: string): Promise<EarnProduct[] | Refusal>;
  /** one product, read afresh (its rate, whether it takes money now) */
  product(id: string): Promise<EarnProduct | Refusal>;
  positions(): Promise<EarnPosition[] | Refusal>;
  /** money in: `amount` of the product's asset, from the venue's own balance. `clientId`: the account's id for it; a retry with the same id
   * is the same request, never a second one */
  supply(p: EarnProduct, amount: number, clientId: string): Promise<EarnState | Refusal>;
  /** money out, back to the same venue: `amount` of the product's asset, or all of it */
  withdraw(p: EarnProduct, amount: number, clientId: string, all: boolean): Promise<EarnState | Refusal>;
  /** how a request that was pending stands now */
  status?(ref: string, p: EarnProduct, kind: "supply" | "withdraw"): Promise<EarnState | Refusal>;
}

/** a live source that can also earn: the field a source sets for it (live/types.ts LiveSource does not name it yet) */
export interface EarnSource {
  earner?: LiveEarner | undefined;
}

const rec = (v: unknown): Record<string, unknown> => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
/** a figure the venue gave, or nothing when it gave none (0 is a figure) */
export const known = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};
const KEPT_MS = 5 * 60_000;

/** one request per client id: a retry with the same id is the first request's answer; a refusal placed nothing, so it may be tried again */
export function once<T>(): (id: string, run: () => Promise<T | Refusal>) => Promise<T | Refusal> {
  const asked = new Map<string, Promise<T | Refusal>>();
  return (id, run) => {
    const prior = asked.get(id);
    if (prior) return prior;
    const p = run();
    asked.set(id, p);
    void p.then((r) => {
      if (isRefusal(r)) asked.delete(id);
    });
    return p;
  };
}

/** a dollar price for the asset: 1 for a dollar stablecoin, the public one otherwise, or nothing */
async function priceOf(price: Price | undefined, asset: string): Promise<number | undefined> {
  if (isStable(asset)) return 1;
  try {
    const p = await price?.(asset);
    return p !== undefined && p > 0 ? p : undefined;
  } catch {
    return undefined;
  }
}

// ---- an exchange's earn, through the account's own key ---------------------------------------------------------------

/** what an exchange's trader hands the earn door (live/exchange-trade.ts exchangeEarnHook): the same client, the same key */
export interface ExchangeEarnDeps {
  client: ExchangeClient;
  venue: string;
  name: string;
  /** the key's values: never sent anywhere from here, only taken out of anything shown */
  key: KeyFile;
  /** what the exchange said the key may do, in the account's words */
  can: string[];
  price?: Price | undefined;
  now?: (() => number) | undefined;
}

/** OKX's Simple Earn Flexible, Kraken Earn and KuCoin Earn, where the exchange is one of them; nothing for any other exchange */
export function exchangeEarner(d: ExchangeEarnDeps): LiveEarner | undefined {
  if (isOkx(d.client.id)) return okxEarner(d);
  if (d.client.id === "kraken") return krakenEarner(d);
  if (d.client.id === "kucoin") return kucoinEarner(d);
  return undefined;
}

type Call = (params: Record<string, unknown>) => Promise<unknown>;
const method = (client: ExchangeClient, name: string): Call | undefined => {
  const f = (client as unknown as Record<string, unknown>)[name];
  return typeof f === "function" ? (params) => (f as (p: Record<string, unknown>) => Promise<unknown>).call(client, params) : undefined;
};

/** OKX Simple Earn Flexible: lent hourly to margin borrowers at the market's lending rate, out at any time. Product ids are `savings:<ccy>` */
export function okxEarner(d: ExchangeEarnDeps): LiveEarner {
  const { client, venue, name } = d;
  const now = d.now ?? Date.now;
  const LANDS = `your ${name} funding account`;
  const NOTE = `OKX Simple Earn Flexible: lent each hour to margin borrowers at the market's lending rate; out at any time. Only what is in your ${name} funding account goes in, and what comes out lands there`;
  const say = (err: unknown, doing: string): Refusal => {
    const r = exchangeSaidNo(venue, name, err, d.key);
    // the venue's own words stay in `native`; what the owner can do about a permission is said here
    if (r.code === "E_VENUE_PERMISSION") return no("E_VENUE_PERMISSION", { venue, message: `${name} refused to ${doing}: Simple Earn's purchase and redemption need the key's Trade permission, and reading it needs Read (set on the key at OKX)`, native: r.native });
    return r;
  };
  const rates = new Map<string, { at: number; apy: number | undefined }>();
  const rateOf = async (ccy: string): Promise<number | undefined | Refusal> => {
    const hit = rates.get(ccy);
    if (hit && now() - hit.at < KEPT_MS) return hit.apy;
    const call = method(client, "publicGetFinanceSavingsLendingRateHistory");
    if (!call) return no("E_VENUE_RAIL_CLOSED", { venue, message: `the exchange library does not reach ${name}'s Simple Earn` });
    try {
      const r = await call({ ccy, limit: "1" });
      const row = rec(list(rec(r).data)[0]);
      // `lendingRate` is the annual rate lenders received; `rate` the borrowers' (OKX docs)
      const apy = known(row.lendingRate) ?? undefined;
      rates.set(ccy, { at: now(), apy });
      return apy;
    } catch (err) {
      return say(err, `say its lending rate for ${ccy}`);
    }
  };
  const productOf = async (ccy: string, apy: number | undefined): Promise<EarnProduct> => ({ id: `savings:${ccy}`, asset: ccy, name: `${ccy} · Simple Earn Flexible`, ...(apy !== undefined ? { apy, rateKind: "apr" as const } : {}), protocol: "OKX Simple Earn", lockDays: 0, lands: LANDS, canSupply: true, canWithdraw: true, note: NOTE, ...(await priceOf(d.price, ccy).then((p) => (p !== undefined ? { priceUsd: p } : {}))) });
  const balances = async (): Promise<Array<Record<string, unknown>> | Refusal> => {
    const call = method(client, "privateGetFinanceSavingsBalance");
    if (!call) return no("E_VENUE_RAIL_CLOSED", { venue, message: `the exchange library does not reach ${name}'s Simple Earn` });
    try {
      return list(rec(await call({})).data).map(rec);
    } catch (err) {
      return say(err, "list what is in Simple Earn");
    }
  };
  const can = d.can.length === 0 ? "unknown" : d.can.includes("trade");
  const submit = once<EarnState>();
  const move = (side: "purchase" | "redempt", p: EarnProduct, amount: number, clientId: string): Promise<EarnState | Refusal> =>
    submit(clientId, async () => {
      const call = method(client, "privatePostFinanceSavingsPurchaseRedempt");
      if (!call) return no("E_VENUE_RAIL_CLOSED", { venue, message: `the exchange library does not reach ${name}'s Simple Earn` });
      // no `rate`: OKX keeps the minimum lending rate set before (its own default otherwise); no destination: it lands in the funding account
      const body = { ccy: p.asset, amt: plain(amount), side };
      try {
        const r = await call(body);
        const row = rec(list(rec(r).data)[0]);
        return { ref: `${side}:${p.asset}:${clientId}`, status: "done", native: { request: body, answer: { ccy: str(row.ccy), amt: str(row.amt), side: str(row.side), rate: str(row.rate) } } };
      } catch (err) {
        return say(err, side === "purchase" ? `put ${plain(amount)} ${p.asset} into Simple Earn` : `take ${plain(amount)} ${p.asset} out of Simple Earn`);
      }
    });
  const DEFAULTS = ["USDT", "USDC", "BTC", "ETH"];
  return {
    can,
    ...(can === false ? { whyNot: `this ${name} key may only read: Simple Earn's purchase and redemption need its Trade permission (set on the key at OKX)` } : {}),
    what: "Simple Earn Flexible: lent hourly, out at any time",
    async products(asset) {
      // one asset when asked; otherwise what is in Simple Earn already and the best-known, at most eight (OKX allows six reads a second)
      let ccys: string[];
      if (asset) ccys = [asset.trim().toUpperCase()];
      else {
        const held = await balances();
        ccys = [...new Set([...(isRefusal(held) ? [] : held.map((b) => str(b.ccy).toUpperCase()).filter(Boolean)), ...DEFAULTS])].slice(0, 8);
      }
      const out: EarnProduct[] = [];
      for (const ccy of ccys) {
        if (!/^[A-Z0-9]{2,12}$/.test(ccy)) continue;
        const apy = await rateOf(ccy);
        if (isRefusal(apy)) {
          if (asset) return apy;
          continue;
        }
        out.push(await productOf(ccy, apy));
      }
      return out;
    },
    async product(id) {
      const m = /^savings:([A-Z0-9]{2,12})$/.exec(id.trim());
      if (!m) return no("E_ACCOUNT_BAD_ACTION", { venue, message: `a product at ${name} is savings:<currency> (for example savings:USDT), not "${id.slice(0, 40)}"` });
      const apy = await rateOf(m[1]!);
      if (isRefusal(apy)) return apy;
      return productOf(m[1]!, apy);
    },
    async positions() {
      const rows = await balances();
      if (isRefusal(rows)) return rows;
      const out: EarnPosition[] = [];
      for (const b of rows) {
        const ccy = str(b.ccy).toUpperCase();
        const amount = num(b.amt);
        if (!ccy || !(amount > 0)) continue;
        const price = await priceOf(d.price, ccy);
        const apy = rates.get(ccy)?.apy;
        const earned = known(b.earnings);
        const pending = known(b.pendingAmt);
        out.push({ product: `savings:${ccy}`, id: `savings:${ccy}`, asset: ccy, amount, ...(price !== undefined ? { usd: Number((amount * price).toFixed(2)) } : {}), ...(apy !== undefined ? { apy } : {}), ...(earned !== undefined ? { accrued: earned, ...(price !== undefined ? { accruedUsd: Number((earned * price).toFixed(2)) } : {}) } : {}), ...(pending ? { pending } : {}), name: `${ccy} · Simple Earn Flexible`, protocol: "OKX Simple Earn" });
      }
      return out;
    },
    supply: (p, amount, clientId) => move("purchase", p, amount, clientId),
    withdraw: (p, amount, clientId) => move("redempt", p, amount, clientId),
  };
}

/** Kraken Earn: the strategies Kraken offers this account (its region, its verification tier), allocated to and deallocated from. A
 * strategy that only runs account-wide from Kraken's own page ("flex", Kraken Rewards) is not offered: Kraken takes no allocation to it */
export function krakenEarner(d: ExchangeEarnDeps): LiveEarner {
  const { client, venue, name } = d;
  const now = d.now ?? Date.now;
  const LANDS = `your ${name} spot balance`;
  const say = (err: unknown, doing: string): Refusal => {
    const r = exchangeSaidNo(venue, name, err, d.key);
    const said = str(rec(r.native).said);
    if (/tier is not high enough/i.test(said)) return no("E_VENUE_PERMISSION", { venue, message: `${name} refused to ${doing}: Kraken offers Earn from its Intermediate verification tier. That is verified at Kraken`, native: r.native });
    if (r.code === "E_VENUE_PERMISSION" || /permission denied/i.test(said)) return no("E_VENUE_PERMISSION", { venue, message: `${name} refused to ${doing}: allocating and deallocating need the key's "Earn Funds" permission, and reading what is allocated needs "Query Funds" (set on the key at Kraken)`, native: r.native });
    if (/EEarnings:Busy/i.test(said)) return no("E_VENUE_UNREACHABLE", { venue, message: `${name}: another allocation or deallocation of this strategy is still under way, or Earn is busy. Try again in a few minutes`, native: r.native });
    if (/EEarnings:(Below min|Above max|Insufficient funds)/i.test(said)) return no(/Insufficient/i.test(said) ? "E_VENUE_INSUFFICIENT" : "E_VENUE_ORDER_INVALID", { venue, message: `${name} refused to ${doing}: ${said}`, native: r.native });
    return r;
  };
  const asset = (a: string) => (a.toUpperCase() === "XBT" || a.toUpperCase() === "XXBT" ? "BTC" : a.toUpperCase());
  let seen: { at: number; key: string; items: Array<Record<string, unknown>> } | undefined;
  const strategies = async (of?: string): Promise<Array<Record<string, unknown>> | Refusal> => {
    const key = of ?? "";
    if (seen && seen.key === key && now() - seen.at < KEPT_MS) return seen.items;
    const call = method(client, "privatePostEarnStrategies");
    if (!call) return no("E_VENUE_RAIL_CLOSED", { venue, message: `the exchange library does not reach ${name}'s Earn` });
    try {
      const items = list(rec(rec(await call(of ? { asset: of } : {})).result).items).map(rec);
      seen = { at: now(), key, items };
      return items;
    } catch (err) {
      return say(err, "list its Earn strategies");
    }
  };
  const productOf = async (s: Record<string, unknown>): Promise<EarnProduct | undefined> => {
    const lock = rec(s.lock_type);
    const type = str(lock.type);
    if (!str(s.id) || type === "flex") return undefined;
    const low = known(rec(s.apr_estimate).low);
    const high = known(rec(s.apr_estimate).high);
    const unbond = known(lock.unbonding_period);
    const a = asset(str(s.asset));
    const restricted = list(s.allocation_restriction_info).map(str).filter(Boolean);
    const fees = [known(s.allocation_fee), known(s.deallocation_fee)];
    const price = await priceOf(d.price, a);
    const lockDays = type === "instant" ? 0 : unbond !== undefined ? Math.ceil(unbond / 86_400) : undefined;
    return {
      id: str(s.id),
      asset: a,
      name: `${a} · ${type === "instant" ? "flexible" : type === "bonded" ? "bonded" : type || "Earn"}${str(rec(s.yield_source).type) ? ` (${str(rec(s.yield_source).type)})` : ""}`,
      ...(low !== undefined ? { apy: low / 100 } : {}),
      ...(high !== undefined && high !== low ? { apyHigh: high / 100 } : {}),
      rateKind: "apr",
      protocol: "Kraken Earn",
      ...(known(s.user_min_allocation) !== undefined ? { minAmount: known(s.user_min_allocation) } : {}),
      ...(lockDays !== undefined ? { lockDays } : {}),
      ...(price !== undefined ? { priceUsd: price } : {}),
      lands: LANDS,
      canSupply: s.can_allocate === true,
      canWithdraw: s.can_deallocate === true,
      ...(s.can_allocate !== true ? { why: restricted.length ? `${name} does not take an allocation here now (${restricted.join(", ")})` : `${name} does not take an allocation here now` } : {}),
      note: `Kraken Earn states an APR range. ${type === "bonded" ? `Bonded: what is deallocated stays${lockDays !== undefined ? ` about ${lockDays} days` : ""} before it is back in your spot balance.` : "Flexible: out without an unbonding period."}${fees.some((f) => f) ? ` Fees: ${fees[0] ?? 0}% in, ${fees[1] ?? 0}% out.` : ""} It is asynchronous: Kraken says when it is done`,
    };
  };
  const submit = once<EarnState>();
  const can = "unknown" as const;
  return {
    can,
    what: "Kraken Earn strategies: flexible and bonded",
    async products(of) {
      const items = await strategies(of ? of.trim().toUpperCase() : undefined);
      if (isRefusal(items)) return items;
      const out: EarnProduct[] = [];
      for (const s of items) {
        const p = await productOf(s);
        if (p && (!of || p.asset === asset(of))) out.push(p);
      }
      return out;
    },
    async product(id) {
      if (!/^[A-Z0-9-]{6,40}$/.test(id.trim())) return no("E_ACCOUNT_BAD_ACTION", { venue, message: `a product at ${name} is a Kraken Earn strategy id (for example ESRFUO3-Q62XD-WIOIL7), not "${id.slice(0, 40)}"` });
      seen = undefined;
      const items = await strategies();
      if (isRefusal(items)) return items;
      const s = items.find((x) => str(x.id) === id.trim());
      const p = s ? await productOf(s) : undefined;
      return p ?? no("E_VENUE_REJECTED", { venue, message: `${name} offers no Earn strategy ${id} to this account (it lists only what it offers in your region and tier, and none that runs account-wide)` });
    },
    async positions() {
      const call = method(client, "privatePostEarnAllocations");
      if (!call) return no("E_VENUE_RAIL_CLOSED", { venue, message: `the exchange library does not reach ${name}'s Earn` });
      let items: Array<Record<string, unknown>>;
      try {
        items = list(rec(rec(await call({ converted_asset: "USD", hide_zero_allocations: true })).result).items).map(rec);
      } catch (err) {
        return say(err, "list what is allocated to Earn");
      }
      const offered = await strategies().then((x) => (isRefusal(x) ? [] : x));
      return items.flatMap((it) => {
        const total = rec(rec(it.amount_allocated).total);
        const amount = num(total.native);
        if (!(amount > 0)) return [];
        const id = str(it.strategy_id);
        const s = offered.find((x) => str(x.id) === id);
        const low = known(rec(s?.apr_estimate).low);
        const rewarded = rec(it.total_rewarded);
        const pending = known(rec(it.amount_allocated).pending ?? it.pending);
        const pos: EarnPosition = { product: id, id, asset: asset(str(it.native_asset)), amount, ...(known(total.converted) !== undefined ? { usd: known(total.converted) } : {}), ...(low !== undefined ? { apy: low / 100 } : {}), ...(known(rewarded.native) !== undefined ? { accrued: known(rewarded.native) } : {}), ...(known(rewarded.converted) !== undefined ? { accruedUsd: known(rewarded.converted) } : {}), ...(pending ? { pending } : {}), name: `${asset(str(it.native_asset))} · Kraken Earn`, protocol: "Kraken Earn" };
        return [pos];
      });
    },
    supply: (p, amount, clientId) =>
      submit(clientId, async () => {
        const call = method(client, "privatePostEarnAllocate");
        if (!call) return no("E_VENUE_RAIL_CLOSED", { venue, message: `the exchange library does not reach ${name}'s Earn` });
        const body = { strategy_id: p.id, amount: plain(amount) };
        try {
          const r = await call(body);
          return { ref: `allocate:${p.id}:${clientId}`, status: "pending", native: { request: body, answer: rec(r).result ?? null } };
        } catch (err) {
          return say(err, `allocate ${plain(amount)} ${p.asset}`);
        }
      }),
    withdraw: (p, amount, clientId) =>
      submit(clientId, async () => {
        const call = method(client, "privatePostEarnDeallocate");
        if (!call) return no("E_VENUE_RAIL_CLOSED", { venue, message: `the exchange library does not reach ${name}'s Earn` });
        const body = { strategy_id: p.id, amount: plain(amount) };
        try {
          const r = await call(body);
          return { ref: `deallocate:${p.id}:${clientId}`, status: "pending", native: { request: body, answer: rec(r).result ?? null } };
        } catch (err) {
          return say(err, `deallocate ${plain(amount)} ${p.asset}`);
        }
      }),
    async status(ref, p, kind) {
      const call = method(client, kind === "supply" ? "privatePostEarnAllocateStatus" : "privatePostEarnDeallocateStatus");
      if (!call) return no("E_VENUE_RAIL_CLOSED", { venue, message: `the exchange library does not reach ${name}'s Earn` });
      try {
        const r = rec(rec(await call({ strategy_id: p.id })).result);
        return { ref, status: r.pending === true ? "pending" : "done", native: { pending: r.pending === true } };
      } catch (err) {
        // a request that failed is answered by the status call "as if it belonged to the original request" (Kraken's docs) — but only Earn's
        // own words about the request say that (EEarnings:Insufficient funds, Below min, Above max…). Anything else — a nonce, the key, a
        // permission, a blip — is about this call, not the request: it is a refusal, the request stays under way and is asked again, so
        // what Kraken may still be allocating is never counted as nothing moved
        const said = say(err, kind === "supply" ? "allocate" : "deallocate");
        const words = str(rec(said.native).said);
        const failed = said.code === "E_VENUE_INSUFFICIENT" || said.code === "E_VENUE_ORDER_INVALID" || (/EEarnings:/i.test(words) && !/EEarnings:(Busy|Permission denied)/i.test(words));
        return failed ? { ref, status: "rejected", native: { refusal: { code: said.code, message: said.message }, said: words } } : said;
      }
    },
  };
}

/** KuCoin Earn: flexible savings (out at any time) and fixed terms (promotions, staking), each as KuCoin lists it. Money goes in from the
 * account's KuCoin trading account — the balance the account reads there — and comes back to it. Product ids are KuCoin's own */
export function kucoinEarner(d: ExchangeEarnDeps): LiveEarner {
  const { client, venue, name } = d;
  const now = d.now ?? Date.now;
  const LANDS = `your ${name} trading account`;
  /** KuCoin's name for the spot trading account, where money goes in from and comes back to */
  const ACCOUNT = "TRADE";
  const PAGE = 100;
  const say = (err: unknown, doing: string): Refusal => {
    const r = exchangeSaidNo(venue, name, err, d.key);
    const said = str(rec(r.native).said);
    // a key without the Earn permission: KuCoin's 400007 "Access denied, require more permission", which the library files as a bad key
    if (r.code === "E_VENUE_PERMISSION" || /400007|require more permission|access denied/i.test(said)) return no("E_VENUE_PERMISSION", { venue, message: `${name} refused to ${doing}: purchase and redemption need the key's Earn permission (set on the key at KuCoin)`, native: r.native });
    if (r.code === "E_VENUE_REJECTED" && said) return no("E_VENUE_REJECTED", { venue, message: `${name} refused to ${doing}: ${said}`, native: r.native });
    return r;
  };
  const day = (ms: number | undefined): string => (ms !== undefined && ms > 0 ? new Date(ms).toISOString().slice(0, 10) : "");
  /** the five product lists KuCoin keeps, and what each is called */
  const LISTS: Array<{ call: string; what: string }> = [
    { call: "earnGetEarnSavingProducts", what: "Savings" },
    { call: "earnGetEarnPromotionProducts", what: "Promotion" },
    { call: "earnGetEarnStakingProducts", what: "Staking" },
    { call: "earnGetEarnKcsStakingProducts", what: "KCS Staking" },
    { call: "earnGetEarnEthStakingProducts", what: "ETH Staking" },
  ];
  /** one of KuCoin's products as the account offers it; none where its income is in another currency than what goes in (the shape here is one
   * asset in and out), or where it has no id */
  const productOf = async (row: Record<string, unknown>, what: string): Promise<EarnProduct | undefined> => {
    const id = str(row.id);
    const ccy = str(row.currency).toUpperCase();
    const income = str(row.incomeCurrency).toUpperCase();
    if (!id || !ccy || (income && income !== ccy)) return undefined;
    const fixed = str(row.type) === "TIME";
    const status = str(row.status);
    const rate = known(row.returnRate);
    const min = known(row.userLowerLimit);
    const remain = known(row.productRemainAmount);
    const redeemDays = known(row.redeemPeriod);
    const lockEnd = known(row.lockEndTime);
    const applyEnd = known(row.applyEndTime);
    const duration = known(row.duration);
    const early = row.earlyRedeemSupported === 1 || row.earlyRedeemSupported === "1" || row.earlyRedeemSupported === true;
    const price = await priceOf(d.price, ccy);
    const why = status !== "ONGOING" ? `${name} lists it as ${status || "not open"}` : remain !== undefined && remain <= 0 ? `${name} says it is full` : applyEnd !== undefined && applyEnd > 0 && applyEnd <= now() ? `${name} says its subscription window has closed` : undefined;
    return {
      id,
      asset: ccy,
      name: `${ccy} · ${what}${fixed ? ` (${duration !== undefined ? `${duration} days` : "fixed term"})` : " (flexible)"}`,
      ...(rate !== undefined ? { apy: rate, rateKind: "apr" as const } : {}),
      protocol: "KuCoin Earn",
      ...(min !== undefined ? { minAmount: min } : {}),
      ...(redeemDays !== undefined ? { lockDays: redeemDays } : {}),
      ...(price !== undefined ? { priceUsd: price } : {}),
      lands: LANDS,
      canSupply: why === undefined,
      // a fixed term is delivered at its end; before that it is redeemed only where KuCoin allows an early redemption
      canWithdraw: !fixed || early,
      ...(why ? { why } : {}),
      note: `KuCoin Earn ${what}: ${fixed ? `a fixed term${day(lockEnd) ? ` to ${day(lockEnd)}` : ""}${early ? ", redeemable early where KuCoin allows it — an early redemption may forfeit interest, which KuCoin asks you to confirm, at KuCoin, not from here" : ", delivered at its end"}` : "flexible, out at any time"}${redeemDays ? `; what is redeemed is back in ${redeemDays} day${redeemDays === 1 ? "" : "s"}` : ""}. The rate is KuCoin's annualized return rate. Money goes in from ${LANDS} and comes back to it`,
    };
  };
  let seen: { at: number; key: string; items: EarnProduct[] } | undefined;
  /** every product KuCoin lists (in one currency when asked), kept five minutes; a list that does not answer is left out, and when none
   * answers the first refusal is the answer */
  const listed = async (asset?: string, fresh = false): Promise<EarnProduct[] | Refusal> => {
    const key = asset ?? "";
    if (!fresh && seen && seen.key === key && now() - seen.at < KEPT_MS) return seen.items;
    const items: EarnProduct[] = [];
    let refused: Refusal | undefined;
    let answered = 0;
    for (const l of LISTS) {
      const call = method(client, l.call);
      if (!call) continue;
      try {
        const rows = list(rec(await call(asset ? { currency: asset } : {})).data).map(rec);
        answered++;
        for (const row of rows) {
          const p = await productOf(row, l.what);
          if (p && (!asset || p.asset === asset)) items.push(p);
        }
      } catch (err) {
        refused ??= say(err, `list its ${l.what} products`);
      }
    }
    if (!answered) return refused ?? no("E_VENUE_RAIL_CLOSED", { venue, message: `the exchange library does not reach ${name}'s Earn` });
    seen = { at: now(), key, items };
    return items;
  };
  type Hold = { orderId: string; productId: string; currency: string; holdAmount: number; redeemingAmount: number; status: string; lockEndTime: number | undefined; returnRate: number | undefined; category: string };
  /** what is held, holding by holding (hold-assets is paged); in one product when asked */
  const holds = async (productId?: string): Promise<Hold[] | Refusal> => {
    const call = method(client, "earnGetEarnHoldAssets");
    if (!call) return no("E_VENUE_RAIL_CLOSED", { venue, message: `the exchange library does not reach ${name}'s Earn` });
    const out: Hold[] = [];
    for (let page = 1; page <= 5; page++) {
      let data: Record<string, unknown>;
      try {
        data = rec(rec(await call({ ...(productId ? { productId } : {}), currentPage: page, pageSize: PAGE })).data);
      } catch (err) {
        return say(err, "list what is in Earn");
      }
      for (const it of list(data.items).map(rec)) out.push({ orderId: str(it.orderId), productId: str(it.productId), currency: str(it.currency).toUpperCase(), holdAmount: num(it.holdAmount), redeemingAmount: num(it.redeemingAmount), status: str(it.status), lockEndTime: known(it.lockEndTime), returnRate: known(it.returnRate), category: str(it.productCategory) });
      if (page >= num(data.totalPage)) break;
    }
    return out;
  };
  const can = d.can.length === 0 ? "unknown" : d.can.includes("earn");
  const submit = once<EarnState>();
  return {
    can,
    ...(can === false ? { whyNot: `this ${name} key lacks the Earn permission: purchase and redemption need it (set on the key at KuCoin)` } : {}),
    what: "KuCoin Earn: flexible savings, fixed terms and staking",
    products: (asset) => listed(asset ? asset.trim().toUpperCase() : undefined),
    async product(id) {
      const pid = id.trim();
      if (!/^\d{1,20}$/.test(pid)) return no("E_ACCOUNT_BAD_ACTION", { venue, message: `a product at ${name} is KuCoin's own product id (digits, for example 2611), not "${id.slice(0, 40)}"` });
      const items = await listed(undefined, true);
      if (isRefusal(items)) return items;
      return items.find((p) => p.id === pid) ?? no("E_VENUE_REJECTED", { venue, message: `${name} lists no Earn product ${pid} now` });
    },
    async positions() {
      const held = await holds();
      if (isRefusal(held)) return held;
      const out: EarnPosition[] = [];
      for (const h of held) {
        if (!(h.holdAmount > 0) || !h.currency) continue;
        const price = await priceOf(d.price, h.currency);
        out.push({ product: h.productId, id: h.orderId, asset: h.currency, amount: h.holdAmount, ...(price !== undefined ? { usd: Number((h.holdAmount * price).toFixed(2)) } : {}), ...(h.returnRate !== undefined ? { apy: h.returnRate } : {}), ...(h.redeemingAmount > 0 ? { pending: h.redeemingAmount } : {}), name: `${h.currency} · KuCoin Earn${h.category ? ` (${h.category.toLowerCase().replace(/_/g, " ")})` : ""}`, protocol: "KuCoin Earn" });
      }
      return out;
    },
    supply: (p, amount, clientId) =>
      submit(clientId, async () => {
        const call = method(client, "earnPostEarnOrders");
        if (!call) return no("E_VENUE_RAIL_CLOSED", { venue, message: `the exchange library does not reach ${name}'s Earn` });
        const body = { productId: p.id, amount: plain(amount), accountType: ACCOUNT };
        try {
          const r = rec(rec(await call(body)).data);
          return { ref: `purchase:${p.id}:${clientId}`, status: "done", native: { request: body, answer: { orderId: str(r.orderId), orderTxId: str(r.orderTxId) } } };
        } catch (err) {
          return say(err, `put ${plain(amount)} ${p.asset} into ${p.name}`);
        }
      }),
    // out: holding by holding, each previewed first. KuCoin asks for an early redemption's penalty to be confirmed (confirmPunishRedeem), and
    // the account never confirms it: a redemption that would forfeit interest is refused with the figure, for the owner to make at KuCoin
    withdraw: (p, amount, clientId, all) =>
      submit(clientId, async () => {
        const preview = method(client, "earnGetEarnRedeemPreview");
        const redeem = method(client, "earnDeleteEarnOrders");
        if (!preview || !redeem) return no("E_VENUE_RAIL_CLOSED", { venue, message: `the exchange library does not reach ${name}'s Earn` });
        const held = await holds(p.id);
        if (isRefusal(held)) return held;
        const mine = held.filter((h) => h.holdAmount > 0);
        if (!mine.length) return no("E_VENUE_REJECTED", { venue, message: `nothing of yours is in ${p.name} at ${name}` });
        const total = mine.reduce((s, h) => s + h.holdAmount, 0);
        if (!all && amount > total + 1e-9) return no("E_VENUE_INSUFFICIENT", { venue, message: `${name}: ${plain(total)} ${p.asset} is in ${p.name}, not ${plain(amount)}` });
        // what each holding gives: all of it, or what is still wanted of it
        const takes: Array<{ h: Hold; take: number }> = [];
        let left = all ? total : amount;
        for (const h of mine) {
          if (left <= 1e-12) break;
          const take = Math.min(left, h.holdAmount);
          takes.push({ h, take });
          left -= take;
        }
        for (const { h, take } of takes) {
          let pv: Record<string, unknown>;
          try {
            pv = rec(rec(await preview({ orderId: h.orderId, fromAccountType: ACCOUNT })).data);
          } catch (err) {
            return say(err, `preview redeeming ${plain(take)} ${p.asset}`);
          }
          const until = day(h.lockEndTime) || day(known(pv.deliverTime));
          if (pv.manualRedeemable === false) return no("E_VENUE_RAIL_CLOSED", { venue, message: `${name} says this holding in ${p.name} is not redeemed by hand now${until ? `: it is delivered on ${until}` : ""}`, native: pv });
          const penalty = num(pv.penaltyInterestAmount);
          if (penalty > 0) return no("E_VENUE_REJECTED", { venue, message: `${name} says redeeming ${plain(take)} ${p.asset} from ${p.name} now forfeits ${plain(penalty)} ${str(pv.currency) || p.asset} of interest, and asks for that to be confirmed: the account does not confirm it for you. Redeem it at KuCoin if you mean to${until ? `, or after ${until}` : ""}`, native: pv });
        }
        const answers: Array<Record<string, unknown>> = [];
        const requests: Array<Record<string, unknown>> = [];
        for (const { h, take } of takes) {
          const body = { orderId: h.orderId, amount: plain(take), fromAccountType: ACCOUNT };
          requests.push(body);
          try {
            const r = rec(rec(await redeem(body)).data);
            answers.push({ orderTxId: str(r.orderTxId), deliverTime: known(r.deliverTime) ?? null, status: str(r.status), amount: str(r.amount) });
          } catch (err) {
            const refused = say(err, `redeem ${plain(take)} ${p.asset} from ${p.name}`);
            // a holding redeemed before this one failed is money on its way: the request stands as pending, and what stopped it is said
            if (answers.length) return { ref: `redeem:${p.id}:${clientId}`, status: "pending", native: { requests, answers, stopped: { code: refused.code, message: refused.message } } };
            return refused;
          }
        }
        return { ref: `redeem:${p.id}:${clientId}`, status: answers.every((a) => a.status === "SUCCESS") ? "done" : "pending", native: { requests, answers } };
      }),
    // a purchase is credited at once; a redemption is PENDING until KuCoin delivers it, and hold-assets shows the amount still redeeming
    async status(ref, p, kind) {
      if (kind === "supply") return { ref, status: "done", native: { said: `${name} credits a purchase at once` } };
      const held = await holds(p.id);
      if (isRefusal(held)) return held;
      const redeeming = held.reduce((s, h) => s + h.redeemingAmount, 0);
      const pending = redeeming > 0 || held.some((h) => h.status === "REDEEMING");
      return { ref, status: pending ? "pending" : "done", native: { redeeming } };
    },
  };
}
