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
 *   Binance                 Simple Earn Flexible, through its own API with the account's own key (developers.binance.com, Simple Earn ›
 *                           Flexible/Locked and Error Code, read 2026-10-08; where that page did not render the subscribe call and the
 *                           two answers, Binance's own connectors, read the same day: npm @binance/simple-earn 16.0.5 (github.com/binance/
 *                           binance-connector-js, clients/simple-earn) for the shapes, binance-connector-ruby lib/binance/spot/
 *                           simple_earn.rb for the defaults; its FAQ "Get Started with Binance Simple Earn Flexible Products", updated
 *                           2026-09-29, for when money moves). Every call under /sapi/v1/simple-earn:
 *                             GET  flexible/list                                  what is offered (any key: Enable Reading): the real-time
 *                                                                                 APR, the bonus tiers, the least that goes in, whether it
 *                                                                                 takes money (canPurchase, isSoldOut) and lets it out
 *                             GET  flexible/position                              what is held, and earned (Enable Reading)
 *                             POST flexible/subscribe                             in, from the spot account (sourceAccount SPOT) — the
 *                                                                                 key's "Enable Spot & Margin Trading". Its autoSubscribe
 *                                                                                 is on unless sent off, and turns on Binance's sweep of
 *                                                                                 the idle spot balance into the product (02:00 and 16:00
 *                                                                                 UTC): the account sends what the owner set at Binance,
 *                                                                                 else off
 *                             POST flexible/redeem                                out, an amount (redeemAll false, always sent) or all of
 *                                                                                 it (redeemAll), back to the spot account (destAccount
 *                                                                                 SPOT; Enable Spot & Margin Trading)
 *                             GET  flexible/history/redemptionRecord              how a redemption stands: Binance returns it at once
 *                                                                                 within its daily limits, and PAID says it has
 *                           Binance.US documents no Simple Earn (docs.binance.us has staking alone), so it has none here. Binance answers
 *                           the developer's machine 451, which is its rule for that place: the account says so in Binance's words, and
 *                           it decides nothing for anyone Binance serves
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
import { lostAnswer } from "./exchange-trade.ts";
import { plain } from "./trade.ts";
import type { Price } from "./prices.ts";
import { isStable, num } from "./types.ts";

/** a read just before a money request that the venue answered with its own rule for this network (not one product's), or a ban or a wait it
 * named: the request is not sent after it — the venue has just said it does not take one from here. A read that only did not answer leaves
 * no baseline, and the request goes as before */
const leftAlone = (r: Refusal): boolean => (r.code === "E_VENUE_GEOBLOCKED" && (r.detail as { scope?: unknown } | undefined)?.scope === undefined) || typeof (r.native as { until?: unknown } | undefined)?.until === "number";

/** one product money can be put into */
export interface EarnProduct {
  /** the venue's id for it: `8453:0x…` (a vault on a chain, through mm), `savings:USDT` (OKX Simple Earn Flexible), Kraken's strategy id,
   * KuCoin's and Binance's own product ids (`2152`, `USDT001`) */
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
  /** how a request that was pending stands now. `asked`: what the request was — its amount, whether it was all of it, and what the venue's
   * answer left (`native`) — for one whose answer was lost, which only the venue's own reads can settle (unsureMove) */
  status?(ref: string, p: EarnProduct, kind: "supply" | "withdraw", asked?: { amount: number; all?: boolean | undefined; native?: unknown }): Promise<EarnState | Refusal>;
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

/** Money in or out whose answer was lost (a timeout — OKX's 50004 "does not indicate success or failure" arrives as one —, a connection
 * cut or reset, a gateway's 5xx, a page answered in the venue's place): not refused, since the venue may have moved it and asking again
 * would move it twice. A request under way instead, known by the account's id (once() keeps the id: it is not a refusal), that the venue's
 * own reads settle: the product's holding against `before`, what it was when the request was sent (settleUnsure) */
function unsureMove(side: string, p: EarnProduct, clientId: string, name: string, r: Refusal, before: number | undefined, more: Record<string, unknown> = {}): EarnState {
  return { ref: `${side}:${p.id}:client-${clientId}`, status: "pending", native: { unsure: true, waiting: `${name} did not confirm it: it may or may not have moved. Look at ${name} before asking again`, refusal: { code: r.code, message: r.message }, ...(before !== undefined ? { before } : {}), ...more } };
}

/** an earn call's failure, through the venue's own reading (`say`) — or, when the call may have reached the venue, the request under way it
 * may be (unsureMove) */
function movedOrNot(err: unknown, said: Refusal, lost: () => EarnState): EarnState | Refusal {
  return lostAnswer(err, said) ? lost() : said;
}

/** A request whose answer was lost, settled by the product's holding now against what it was before: `done` when it moved by (nearly) the
 * amount, the right way — in by it, out by it, or all of it out. Anything else is still under way: a request is never turned into "nothing
 * moved" on a guess, and one with nothing to compare stays under way for the owner to look at */
function settleUnsure(ref: string, kind: "supply" | "withdraw", asked: { amount: number; all?: boolean | undefined; native?: unknown }, now: number | Refusal): EarnState | Refusal {
  if (isRefusal(now)) return now;
  const before = (asked.native as { before?: unknown } | undefined)?.before;
  const was = typeof before === "number" ? before : undefined;
  const slack = Math.max(asked.amount * 0.01, 1e-9);
  const moved = was !== undefined && (kind === "supply" ? now >= was + asked.amount - slack : asked.all ? now <= slack : now <= was - asked.amount + slack);
  return { ref, status: moved ? "done" : "pending", native: { ...(asked.native as Record<string, unknown>), held: now, ...(moved ? { settled: `the holding moved from ${was} to ${now}` } : {}) } };
}
const isUnsure = (asked: { native?: unknown } | undefined): boolean => (asked?.native as { unsure?: unknown } | undefined)?.unsure === true;

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

/** OKX's Simple Earn Flexible, Kraken Earn, KuCoin Earn and Binance's Simple Earn Flexible, where the exchange is one of them; nothing for
 * any other exchange. Binance is binance.com's own client alone — Binance.US documents no Simple Earn, and the library's futures clients
 * are not where the money lands — and only where the library has its Simple Earn calls */
export function exchangeEarner(d: ExchangeEarnDeps): LiveEarner | undefined {
  // OKX US documents no Earn API: its on-chain staking is in its app only
  if (isOkx(d.client.id) && d.client.id !== "okxus") return okxEarner(d);
  if (d.client.id === "kraken") return krakenEarner(d);
  if (d.client.id === "kucoin") return kucoinEarner(d);
  if (d.client.id === "binance" && BINANCE_CALLS.every((c) => method(d.client, c))) return binanceEarner(d);
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
    // a key bound to other addresses (50110) is not a missing permission: its own words, and what the owner does about it, stand
    if ((r.detail as { ipList?: unknown } | undefined)?.ipList) return r;
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
  /** what is lent in one currency now, or a refusal; nothing when the call is not there (a request whose answer is lost is settled by it) */
  const lent = async (ccy: string): Promise<number | Refusal> => {
    const rows = await balances();
    return isRefusal(rows) ? rows : num(rows.find((b) => str(b.ccy).toUpperCase() === ccy.toUpperCase())?.amt);
  };
  const move = (side: "purchase" | "redempt", p: EarnProduct, amount: number, clientId: string): Promise<EarnState | Refusal> =>
    submit(clientId, async () => {
      const call = method(client, "privatePostFinanceSavingsPurchaseRedempt");
      if (!call) return no("E_VENUE_RAIL_CLOSED", { venue, message: `the exchange library does not reach ${name}'s Simple Earn` });
      // what is lent before: what settles the request if its answer is lost (a read that fails leaves nothing to compare, and moves nothing)
      const before = method(client, "privateGetFinanceSavingsBalance") ? await lent(p.asset) : undefined;
      if (isRefusal(before) && leftAlone(before)) return before;
      // no `rate`: OKX keeps the minimum lending rate set before (its own default otherwise); no destination: it lands in the funding account
      const body = { ccy: p.asset, amt: plain(amount), side };
      try {
        const r = await call(body);
        const row = rec(list(rec(r).data)[0]);
        return { ref: `${side}:${p.asset}:${clientId}`, status: "done", native: { request: body, answer: { ccy: str(row.ccy), amt: str(row.amt), side: str(row.side), rate: str(row.rate) } } };
      } catch (err) {
        const said = say(err, side === "purchase" ? `put ${plain(amount)} ${p.asset} into Simple Earn` : `take ${plain(amount)} ${p.asset} out of Simple Earn`);
        return movedOrNot(err, said, () => unsureMove(side, p, clientId, name, said, typeof before === "number" ? before : undefined));
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
    // a purchase or redemption OKX answered is done at once; one whose answer was lost is settled by what is lent now against before
    async status(ref, p, kind, asked) {
      if (!asked || !isUnsure(asked)) return { ref, status: "done", native: { said: `${name} answers a purchase or redemption when it is done` } };
      return settleUnsure(ref, kind, asked, await lent(p.asset));
    },
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
    if ((r.detail as { ipList?: unknown } | undefined)?.ipList) return r;
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
  /** what is allocated to one strategy now, pending allocations included (Allocations: amount_allocated.total and .pending, in the asset),
   * or a refusal: what settles a request whose answer was lost */
  const allocated = async (strategy: string): Promise<number | Refusal> => {
    const call = method(client, "privatePostEarnAllocations");
    if (!call) return no("E_VENUE_RAIL_CLOSED", { venue, message: `the exchange library does not reach ${name}'s Earn` });
    try {
      const items = list(rec(rec(await call({ converted_asset: "USD", hide_zero_allocations: true })).result).items).map(rec);
      const it = items.find((x) => str(x.strategy_id) === strategy);
      return it ? num(rec(rec(it.amount_allocated).total).native) + num(rec(rec(it.amount_allocated).pending).native) : 0;
    } catch (err) {
      return say(err, "list what is allocated to Earn");
    }
  };
  const before = async (strategy: string): Promise<number | undefined | Refusal> => {
    if (!method(client, "privatePostEarnAllocations")) return undefined;
    const x = await allocated(strategy);
    return isRefusal(x) ? (leftAlone(x) ? x : undefined) : x;
  };
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
        const was = await before(p.id);
        if (isRefusal(was)) return was;
        try {
          const r = await call(body);
          return { ref: `allocate:${p.id}:${clientId}`, status: "pending", native: { request: body, answer: rec(r).result ?? null } };
        } catch (err) {
          const said = say(err, `allocate ${plain(amount)} ${p.asset}`);
          return movedOrNot(err, said, () => unsureMove("allocate", p, clientId, name, said, was));
        }
      }),
    withdraw: (p, amount, clientId) =>
      submit(clientId, async () => {
        const call = method(client, "privatePostEarnDeallocate");
        if (!call) return no("E_VENUE_RAIL_CLOSED", { venue, message: `the exchange library does not reach ${name}'s Earn` });
        const body = { strategy_id: p.id, amount: plain(amount) };
        const was = await before(p.id);
        if (isRefusal(was)) return was;
        try {
          const r = await call(body);
          return { ref: `deallocate:${p.id}:${clientId}`, status: "pending", native: { request: body, answer: rec(r).result ?? null } };
        } catch (err) {
          const said = say(err, `deallocate ${plain(amount)} ${p.asset}`);
          return movedOrNot(err, said, () => unsureMove("deallocate", p, clientId, name, said, was));
        }
      }),
    async status(ref, p, kind, asked) {
      // a request whose answer was lost: AllocateStatus says only whether one is under way for the strategy, never whether this one was
      // made, so what is allocated settles it
      if (asked && isUnsure(asked)) return settleUnsure(ref, kind, asked, await allocated(p.id));
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
    // a key bound to other addresses (400006) is not a missing permission: its own words, and what the owner does about it, stand
    if ((r.detail as { ipList?: unknown } | undefined)?.ipList) return r;
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
  /** what is held in one product and not on its way out (hold-assets, holding by holding), or a refusal: what settles a request whose
   * answer was lost */
  const inProduct = (held: Hold[]): number => held.reduce((sum, h) => sum + Math.max(0, h.holdAmount - h.redeemingAmount), 0);
  const holding = async (productId: string): Promise<number | Refusal> => {
    const held = await holds(productId);
    return isRefusal(held) ? held : inProduct(held);
  };
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
        const was = method(client, "earnGetEarnHoldAssets") ? await holding(p.id) : undefined;
        if (isRefusal(was) && leftAlone(was)) return was;
        try {
          const r = rec(rec(await call(body)).data);
          return { ref: `purchase:${p.id}:${clientId}`, status: "done", native: { request: body, answer: { orderId: str(r.orderId), orderTxId: str(r.orderTxId) } } };
        } catch (err) {
          const said = say(err, `put ${plain(amount)} ${p.asset} into ${p.name}`);
          return movedOrNot(err, said, () => unsureMove("purchase", p, clientId, name, said, typeof was === "number" ? was : undefined));
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
            // the first one's answer lost: it may be on its way, settled by what is held against what was
            return movedOrNot(err, refused, () => unsureMove("redeem", p, clientId, name, refused, inProduct(held)));
          }
        }
        return { ref: `redeem:${p.id}:${clientId}`, status: answers.every((a) => a.status === "SUCCESS") ? "done" : "pending", native: { requests, answers } };
      }),
    // a purchase is credited at once; a redemption is PENDING until KuCoin delivers it, and hold-assets shows the amount still redeeming. One
    // whose answer was lost is settled by what is held against what was
    async status(ref, p, kind, asked) {
      if (asked && isUnsure(asked)) return settleUnsure(ref, kind, asked, await holding(p.id));
      if (kind === "supply") return { ref, status: "done", native: { said: `${name} credits a purchase at once` } };
      const held = await holds(p.id);
      if (isRefusal(held)) return held;
      const redeeming = held.reduce((s, h) => s + h.redeemingAmount, 0);
      const pending = redeeming > 0 || held.some((h) => h.status === "REDEEMING");
      return { ref, status: pending ? "pending" : "done", native: { redeeming } };
    },
  };
}

// ---- Binance Simple Earn Flexible ------------------------------------------------------------------------------------------------

/** the library's implicit calls for Binance's Simple Earn Flexible (ccxt abstract/binance.d.ts): Binance's earn is offered where it has them */
const BINANCE_CALLS = ["sapiGetSimpleEarnFlexibleList", "sapiGetSimpleEarnFlexiblePosition", "sapiPostSimpleEarnFlexibleSubscribe", "sapiPostSimpleEarnFlexibleRedeem", "sapiGetSimpleEarnFlexibleHistoryRedemptionRecord"];
/** a Binance product id (`USDT001`): the only kind sent back to it — the library writes these calls' query without escaping it */
const BINANCE_ID = /^[A-Za-z0-9._-]{2,40}$/;
const BINANCE_ASSET = /^[A-Z0-9]{1,20}$/;
/** Binance's Simple Earn codes ("6XXX - Savings Issues", developers.binance.com Simple Earn › Error Code), by what they leave the owner to do */
const BINANCE_CLOSED = new Set(["-6004", "-6007", "-6008"]); // Product not in purchase status · Not in redeem time · Product not in redeem status
const BINANCE_INVALID = new Set(["-6005", "-6006", "-6011", "-6014"]); // Smaller than min purchase limit · Redeem amount error · Exceeding the
// maximum num allowed to purchase per user · Exceed up-limit allowed to purchased
const BINANCE_SHORT = new Set(["-6012", "-6018"]); // Balance not enough · Asset not enough
/** Binance's own code and sentence in what the library threw (`binance {"code":-6012,"msg":"Balance not enough"}`) */
function binanceSaid(said: string): { code?: string | undefined; msg?: string | undefined } {
  return { code: /"code"\s*:\s*"?(-?\d+)/.exec(said)?.[1], msg: /"msg"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(said)?.[1] };
}
const pctOf = (f: number): string => `${Number((f * 100).toFixed(2))}%`;

/** Binance Simple Earn Flexible: out at any time, at Binance's real-time APR. Money goes in from the account's Binance spot account — the
 * main balance the account reads there — and comes back to it. Product ids are Binance's own (`USDT001`) */
export function binanceEarner(d: ExchangeEarnDeps): LiveEarner {
  const { client, venue, name } = d;
  const now = d.now ?? Date.now;
  const LANDS = `your ${name} spot account`;
  /** Binance's name for the spot account: where money goes in from (sourceAccount) and comes back to (destAccount) */
  const ACCOUNT = "SPOT";
  const PAGE = 100;
  const PAGES = 5;
  const PERMISSION = `subscribing and redeeming need the key's "Enable Spot & Margin Trading" permission, and reading Simple Earn needs "Enable Reading" (set on the key at Binance)`;
  const closed = (): Refusal => no("E_VENUE_RAIL_CLOSED", { venue, message: `the exchange library does not reach ${name}'s Simple Earn` });
  const say = (err: unknown, doing: string, kind: "read" | "supply" | "withdraw" = "read"): Refusal => {
    const r = exchangeSaidNo(venue, name, err, d.key);
    // its rule for this place, a limit on how often it is asked, a blip: as the exchange said them
    if (r.code === "E_VENUE_GEOBLOCKED" || r.code === "E_VENUE_UNREACHABLE") return r;
    const said = str(rec(r.native).said);
    const { code, msg } = binanceSaid(said);
    const words = msg ? `${msg}${code ? ` (${code})` : ""}` : "";
    const native = r.native;
    // -2015 is Binance's one answer for a missing permission, a wrong key and an IP not on the key's list, -1002 "not authorized": what the
    // owner can check on the key is said
    if (code === "-2015" || code === "-1002" || /Invalid API-key, IP, or permissions/i.test(said)) return no("E_VENUE_PERMISSION", { venue, message: `${name} refused to ${doing}: ${PERMISSION}. ${code === "-1002" ? `It said: ${words}` : "Binance gives this one answer (-2015) for a missing permission, a wrong key and an IP not on the key's list"}`, native });
    if (code === "-6019") return no("E_VENUE_REJECTED", { venue, message: `${name} refused to ${doing}: ${words}. It asks for a confirmation, and the account does not confirm it for you: do it at Binance if you mean to`, native });
    if (code && BINANCE_SHORT.has(code)) return no("E_VENUE_INSUFFICIENT", { venue, message: `${name} refused to ${doing}: ${words}${kind === "supply" ? `. Only what is in ${LANDS} goes in` : ""}`, native });
    if (code && BINANCE_CLOSED.has(code)) return no("E_VENUE_MARKET_CLOSED", { venue, message: `${name} refused to ${doing}: ${words}`, native });
    if (code && BINANCE_INVALID.has(code)) return no("E_VENUE_ORDER_INVALID", { venue, message: `${name} refused to ${doing}: ${words}`, native });
    if (r.code === "E_VENUE_UNAUTHORIZED") return words ? no("E_VENUE_UNAUTHORIZED", { venue, message: `${name} does not accept this key: ${words}`, native }) : r;
    // anything else Binance said in words — the product is not there, or not for this account (-6001, -6003, -6017, -6020): its words
    return words ? no("E_VENUE_REJECTED", { venue, message: `${name} refused to ${doing}: ${words}`, native }) : r;
  };
  /** an answer with success false (the library throws on one; a stand-in or a later library may not): nothing was done */
  const unsuccessful = (doing: string, answer: unknown, request: unknown): Refusal => no("E_VENUE_REJECTED", { venue, message: `${name} did not ${doing}: it answered that it did not succeed`, native: { request, answer } });
  const notId = (id: string): Refusal => no("E_ACCOUNT_BAD_ACTION", { venue, message: `a product at ${name} is Binance's own Simple Earn Flexible product id (for example USDT001), not "${id.slice(0, 40)}"` });
  /** a paged list (a hundred a page, five pages at most) */
  const rowsOf = async (call: string, params: Record<string, unknown>, doing: string): Promise<Array<Record<string, unknown>> | Refusal> => {
    const f = method(client, call);
    if (!f) return closed();
    const out: Array<Record<string, unknown>> = [];
    for (let page = 1; page <= PAGES; page++) {
      let data: Record<string, unknown>;
      try {
        data = rec(await f({ ...params, current: page, size: PAGE }));
      } catch (err) {
        return say(err, doing);
      }
      const rows = list(data.rows).map(rec);
      out.push(...rows);
      if (rows.length < PAGE || page * PAGE >= num(data.total)) break;
    }
    return out;
  };
  /** what is held in Simple Earn Flexible (GET flexible/position), in one product when asked */
  const heldRows = (productId?: string) => rowsOf("sapiGetSimpleEarnFlexiblePosition", productId ? { productId } : {}, "list what is in Simple Earn");
  /** the asset of each product seen, so one is read again in its own asset's list */
  const assetOf = new Map<string, string>();
  const noteOf = (tiers: string): string => `Binance Simple Earn Flexible: out at any time — Binance returns what is redeemed to ${LANDS} at once, within its daily redemption limits. The rate is its real-time APR${tiers ? `, and it pays a bonus tiered APR besides (${tiers})` : ""}. Only what is in ${LANDS} goes in, and the account never turns on Binance's Auto-Subscribe`;
  const tiersOf = (v: unknown): string =>
    Object.entries(rec(v))
      .flatMap(([band, f]) => {
        const x = known(f);
        return band && x !== undefined ? [`${band} ${pctOf(x)}`] : [];
      })
      .join(", ");
  /** one of Binance's products as the account offers it (a row of GET flexible/list), at the dollar price it was given */
  const productOf = (row: Record<string, unknown>, price: number | undefined): EarnProduct | undefined => {
    const id = str(row.productId);
    const ccy = str(row.asset).toUpperCase();
    if (!BINANCE_ID.test(id) || !ccy) return undefined;
    assetOf.set(id, ccy);
    const rate = known(row.latestAnnualPercentageRate);
    const min = known(row.minPurchaseAmount);
    const soldOut = row.isSoldOut === true;
    const takes = row.canPurchase === true && !soldOut;
    const status = str(row.status);
    return {
      id,
      asset: ccy,
      name: `${ccy} · Simple Earn Flexible`,
      ...(rate !== undefined ? { apy: rate, rateKind: "apr" as const } : {}),
      protocol: "Binance Simple Earn",
      ...(min !== undefined && min > 0 ? { minAmount: min } : {}),
      lockDays: 0,
      ...(price !== undefined ? { priceUsd: price } : {}),
      lands: LANDS,
      canSupply: takes,
      canWithdraw: row.canRedeem === true,
      ...(takes ? {} : { why: soldOut ? `${name} says it is sold out` : `${name} takes no money into it now${status ? ` (${status})` : ""}` }),
      note: noteOf(tiersOf(row.tierAnnualPercentageRate)),
    };
  };
  /** a product Binance no longer lists, from what is held in it: money can only come out */
  const heldProduct = async (row: Record<string, unknown>): Promise<EarnProduct> => {
    const ccy = str(row.asset).toUpperCase();
    const rate = known(row.latestAnnualPercentageRate);
    const price = await priceOf(d.price, ccy);
    return { id: str(row.productId), asset: ccy, name: `${ccy} · Simple Earn Flexible`, ...(rate !== undefined ? { apy: rate, rateKind: "apr" as const } : {}), protocol: "Binance Simple Earn", lockDays: 0, ...(price !== undefined ? { priceUsd: price } : {}), lands: LANDS, canSupply: false, canWithdraw: row.canRedeem === true, why: `${name} does not list it now: what is in it can only come out`, note: noteOf("") };
  };
  /** the product with its asset's dollar price, where a public price says one */
  const priced = async (p: EarnProduct): Promise<EarnProduct> => {
    if (p.priceUsd !== undefined) return p;
    const x = await priceOf(d.price, p.asset);
    return x !== undefined ? { ...p, priceUsd: x } : p;
  };
  let seen: { at: number; key: string; items: EarnProduct[] } | undefined;
  /** every product Binance lists (in one asset when asked), kept five minutes. One asset's list is priced; the whole list — hundreds of
   * products — only where it costs nothing (a dollar stablecoin), so no asset is asked about one by one: a product money moves for is
   * priced when it is read alone (product) */
  const listed = async (asset?: string, fresh = false): Promise<EarnProduct[] | Refusal> => {
    const key = asset ?? "";
    if (!fresh && seen && seen.key === key && now() - seen.at < KEPT_MS) return seen.items;
    const rows = await rowsOf("sapiGetSimpleEarnFlexibleList", asset ? { asset } : {}, "list its Simple Earn products");
    if (isRefusal(rows)) return rows;
    const price = asset ? await priceOf(d.price, asset) : undefined;
    const items: EarnProduct[] = [];
    for (const row of rows) {
      const p = productOf(row, asset ? price : isStable(str(row.asset)) ? 1 : undefined);
      if (p && (!asset || p.asset === asset)) items.push(p);
    }
    seen = { at: now(), key, items };
    return items;
  };
  /** how one redemption stands, by Binance's redemption record: PAID is done, a failure rejected; anything else, or no row yet, under way */
  const redemption = async (redeemId: string): Promise<{ status: EarnState["status"]; native: unknown } | Refusal> => {
    const f = method(client, "sapiGetSimpleEarnFlexibleHistoryRedemptionRecord");
    if (!f) return closed();
    let rows: Array<Record<string, unknown>>;
    try {
      rows = list(rec(await f({ redeemId })).rows).map(rec);
    } catch (err) {
      return say(err, "say how a redemption stands");
    }
    const row = rows.find((x) => str(x.redeemId) === redeemId);
    if (!row) return { status: "pending", native: { redeemId, record: null } };
    const s = str(row.status).toUpperCase();
    return { status: s === "PAID" ? "done" : /FAIL/.test(s) ? "rejected" : "pending", native: { redeemId, record: { status: s, amount: str(row.amount), asset: str(row.asset), destAccount: str(row.destAccount), time: known(row.time) ?? null } } };
  };
  /** a redemption whose answer was lost, found in Binance's redemption record by its product, when it was asked (a minute either side) and
   * how much: PAID there is done. Not found, or not paid yet, it is still under way — never "nothing moved" on a guess */
  const unsureRedemption = async (ref: string, p: EarnProduct, asked: { amount: number; all?: boolean | undefined; native?: unknown }): Promise<EarnState | Refusal> => {
    const native = (asked.native ?? {}) as Record<string, unknown>;
    const sentAt = typeof native.sentAt === "number" ? native.sentAt : undefined;
    const f = method(client, "sapiGetSimpleEarnFlexibleHistoryRedemptionRecord");
    if (!f || sentAt === undefined || !BINANCE_ID.test(p.id)) return { ref, status: "pending", native };
    let rows: Array<Record<string, unknown>>;
    try {
      rows = list(rec(await f({ productId: p.id, startTime: sentAt - 60_000 })).rows).map(rec);
    } catch (err) {
      return say(err, "say how a redemption stands");
    }
    const row = rows.find((x) => (known(x.time) ?? 0) >= sentAt - 60_000 && (asked.all || Math.abs(num(x.amount) - asked.amount) <= Math.max(asked.amount * 0.001, 1e-9)));
    if (!row) return { ref, status: "pending", native };
    const st = str(row.status).toUpperCase();
    return { ref, status: st === "PAID" ? "done" : "pending", native: { ...native, record: { redeemId: str(row.redeemId), status: st, amount: str(row.amount), time: known(row.time) ?? null } } };
  };
  const can = d.can.length === 0 ? "unknown" : d.can.includes("trade spot and margin");
  const submit = once<EarnState>();
  /** what is held in one product (GET flexible/position totalAmount): what settles a request whose answer was lost */
  const inProduct = (rows: Array<Record<string, unknown>>, pid: string): number => rows.filter((r) => str(r.productId) === pid).reduce((sum, r) => sum + num(r.totalAmount), 0);
  const holding = async (pid: string): Promise<number | Refusal> => {
    const rows = await heldRows(pid);
    return isRefusal(rows) ? rows : inProduct(rows, pid);
  };
  return {
    can,
    ...(can === false ? { whyNot: `this ${name} key may not trade: Simple Earn's subscription and redemption need its "Enable Spot & Margin Trading" permission (set on the key at Binance)` } : {}),
    what: "Simple Earn Flexible: out at any time",
    async products(asset) {
      const a = asset?.trim().toUpperCase() ?? "";
      // an asset Binance could not have is none here: nothing that is not one goes into its query
      if (a && !BINANCE_ASSET.test(a)) return [];
      return listed(a || undefined);
    },
    async product(id) {
      const pid = id.trim();
      if (!BINANCE_ID.test(pid)) return notId(id);
      // read afresh: in its own asset's list where it was seen before (one call), else in all of them
      const was = assetOf.get(pid);
      const own = was && BINANCE_ASSET.test(was) ? was : undefined;
      let items = await listed(own, true);
      if (isRefusal(items)) return items;
      let hit = items.find((p) => p.id === pid);
      if (!hit && own) {
        items = await listed(undefined, true);
        if (isRefusal(items)) return items;
        hit = items.find((p) => p.id === pid);
      }
      if (hit) return priced(hit);
      const held = await heldRows(pid);
      if (isRefusal(held)) return held;
      const row = held.find((r) => str(r.productId) === pid && num(r.totalAmount) > 0);
      return row ? heldProduct(row) : no("E_VENUE_REJECTED", { venue, message: `${name} lists no Simple Earn Flexible product ${pid} now` });
    },
    async positions() {
      const rows = await heldRows();
      if (isRefusal(rows)) return rows;
      const out: EarnPosition[] = [];
      for (const r of rows) {
        const id = str(r.productId);
        const asset = str(r.asset).toUpperCase();
        const amount = num(r.totalAmount);
        if (!id || !asset || !(amount > 0)) continue;
        assetOf.set(id, asset);
        const price = await priceOf(d.price, asset);
        const apy = known(r.latestAnnualPercentageRate);
        // earned so far, in the asset: the real-time rewards Binance adds to the position each minute and the bonus it pays to spot each day
        const earned = known(r.cumulativeTotalRewards);
        out.push({ product: id, id, asset, amount, ...(price !== undefined ? { usd: Number((amount * price).toFixed(2)) } : {}), ...(apy !== undefined ? { apy } : {}), ...(earned !== undefined ? { accrued: earned, ...(price !== undefined ? { accruedUsd: Number((earned * price).toFixed(2)) } : {}) } : {}), name: `${asset} · Simple Earn Flexible`, protocol: "Binance Simple Earn" });
      }
      return out;
    },
    supply: (p, amount, clientId) =>
      submit(clientId, async () => {
        const call = method(client, "sapiPostSimpleEarnFlexibleSubscribe");
        if (!call) return closed();
        if (!BINANCE_ID.test(p.id)) return notId(p.id);
        const doing = `put ${plain(amount)} ${p.asset} into ${p.name}`;
        // Auto-Subscribe is the owner's to set, at Binance: what the position says goes back as it is, and with nothing held it is off —
        // Binance's own default is on, which would sweep the idle spot balance into the product twice a day
        const held = await heldRows(p.id);
        if (isRefusal(held)) return held;
        const auto = held.some((r) => str(r.productId) === p.id && r.autoSubscribe === true);
        const body = { productId: p.id, amount: plain(amount), autoSubscribe: auto, sourceAccount: ACCOUNT };
        let r: Record<string, unknown>;
        try {
          r = rec(await call(body));
        } catch (err) {
          const said = say(err, doing, "supply");
          return movedOrNot(err, said, () => unsureMove("subscribe", p, clientId, name, said, inProduct(held, p.id)));
        }
        if (r.success === false) return unsuccessful(doing, r, body);
        return { ref: `subscribe:${p.id}:${str(r.purchaseId) || `client-${clientId}`}`, status: "done", native: { request: body, answer: { purchaseId: str(r.purchaseId), success: r.success ?? null } } };
      }),
    // out: an amount, or all of it by Binance's own redeemAll, back to the spot account; done when its redemption record says PAID
    withdraw: (p, amount, clientId, all) =>
      submit(clientId, async () => {
        const call = method(client, "sapiPostSimpleEarnFlexibleRedeem");
        if (!call) return closed();
        if (!BINANCE_ID.test(p.id)) return notId(p.id);
        const doing = all ? `take all of it out of ${p.name}` : `take ${plain(amount)} ${p.asset} out of ${p.name}`;
        // redeemAll is always sent: Binance's docs give its default as false, its own Ruby connector as true — a part must never go as all
        const body = { productId: p.id, redeemAll: all, ...(all ? {} : { amount: plain(amount) }), destAccount: ACCOUNT };
        const sent = now();
        let r: Record<string, unknown>;
        try {
          r = rec(await call(body));
        } catch (err) {
          // its answer lost, it is looked for in the redemption record by when it was asked and how much (status)
          const said = say(err, doing, "withdraw");
          return movedOrNot(err, said, () => unsureMove("redeem", p, clientId, name, said, undefined, { sentAt: sent }));
        }
        if (r.success === false) return unsuccessful(doing, r, body);
        const redeemId = str(r.redeemId);
        const answer = { redeemId, success: r.success ?? null };
        // no id to follow it by: Binance says a flexible redemption is back at once
        if (!/^\d{1,30}$/.test(redeemId)) return { ref: `redeem:${p.id}:client-${clientId}`, status: "done", native: { request: body, answer } };
        const st = await redemption(redeemId);
        // a record that could not be read leaves it under way: it is asked again
        return { ref: `redeem:${p.id}:${redeemId}`, status: isRefusal(st) ? "pending" : st.status, native: { request: body, answer, ...(isRefusal(st) ? {} : { record: st.native }) } };
      }),
    // a subscription is credited at once; a redemption is followed in Binance's redemption record until it says PAID. One whose answer was
    // lost is settled by what is held against what was (a subscription), or found in that record by when and how much (a redemption)
    async status(ref, p, kind, asked) {
      if (asked && isUnsure(asked) && kind === "supply") return settleUnsure(ref, kind, asked, await holding(p.id));
      if (asked && isUnsure(asked)) return unsureRedemption(ref, p, asked);
      if (kind === "supply") return { ref, status: "done", native: { said: `${name} credits a subscription at once` } };
      const id = /^redeem:[^:]+:(\d{1,30})$/.exec(ref)?.[1];
      if (!id) return { ref, status: "done", native: { said: `no redemption id to follow: ${name} returns a flexible redemption at once` } };
      const r = await redemption(id);
      return isRefusal(r) ? r : { ref, status: r.status, native: r.native };
    },
  };
}
