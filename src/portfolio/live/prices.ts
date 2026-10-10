/** A dollar price for something a source could not price itself: a chain's own coin in a wallet, a token on a spot ledger.
 *
 * It is the last trade on a public market, asked without a key through the unified exchange library: the exchanges are tried in order and
 * the first one that answers wins (one that does not serve this location simply does not answer, and the next is asked). A price is kept
 * for a minute; a miss is remembered for five when every exchange answered and none lists it, so an asset nobody lists is not asked about
 * on every refresh — but a miss because an exchange could not be asked is kept only as long as that exchange's refusal holds it back.
 *
 * The list does not depend on where this machine is. From the developer's machine (2026-10-08) Binance answers HTTP 451 and Bybit 403;
 * wherever they serve, they price what the first three do not list. An exchange that said no is held back for as long as its refusal says
 * (public-markets.ts holdBackMs: ten minutes for a place rule or an edge, a ban's own time, twenty seconds for no answer) and then asked
 * again, its markets loaded afresh — the library keeps a failed load and would answer it again at once, so an outage at login, or a verdict
 * from the network the machine was on before, would otherwise stand until a restart. Only spot markets are loaded: a derivatives host
 * refusing this network is not the answer for a spot price.
 */
import type { Refusal } from "../../core/errors.ts";
import { openExchange, type ExchangeClient, type OpenExchange } from "./exchange.ts";
import { exchangeNo, holdBackMs } from "./public-markets.ts";
import { isStable, num } from "./types.ts";

export type Price = (asset: string) => Promise<number | undefined>;

const ORDER = ["kraken", "coinbase", "okx", "binance", "bybit"];
const QUOTES = ["USD", "USDT", "USDC"];
/** the exchanges whose keyless market load also reads their derivatives, each from its own host, unless told spot only (public-markets.ts
 * keylessSpot does the same for the Markets screen) */
const SPOT_ONLY = new Set(["binance", "bybit", "okx"]);
/** a miss kept while an exchange could not be asked, at the least: it is not asked again on every read either */
const MISS_HELD_MS = 20_000;
/** a wrapped or staked form is priced as what it wraps only where that is one for one by construction */
const ALIAS: Record<string, string> = { WETH: "ETH", WBNB: "BNB", WPOL: "POL", MATIC: "POL" };

/** the exchanges a public price is asked of, in the order they are asked; the Markets screen reads their keyless tickers too, the same five
 * in the same order (public-markets.ts): one list, so a price and the Markets screen never disagree about which exchanges count */
export const PUBLIC_EXCHANGES: readonly string[] = ORDER;

/** one keyless client per exchange and per opener, opened on first use and kept: every read made through it shares the client, so its
 * markets are loaded once. An exchange the library cannot open answers undefined, and is not opened again */
const keyless = new WeakMap<OpenExchange, Map<string, Promise<ExchangeClient | undefined>>>();
export function keylessExchange(id: string, open: OpenExchange = openExchange): Promise<ExchangeClient | undefined> {
  let byId = keyless.get(open);
  if (!byId) keyless.set(open, (byId = new Map()));
  let c = byId.get(id);
  if (!c) {
    c = open(id, { apiKey: "", secret: "" }).catch(() => undefined);
    byId.set(id, c);
  }
  return c;
}

export function publicPrices(opts: { open?: OpenExchange | undefined; clock?: (() => number) | undefined; order?: string[] | undefined } = {}): Price {
  const open = opts.open ?? openExchange;
  const clock = opts.clock ?? Date.now;
  const clients = new Map<string, Promise<ExchangeClient | undefined>>();
  const seen = new Map<string, { until: number; price: number | undefined }>();
  /** an exchange that could not be asked: until when it is held back, by its own refusal */
  const held = new Map<string, number>();
  /** an exchange whose market load failed: the next load asks afresh, not the library's kept failure */
  const reload = new Set<string>();
  const client = (id: string) => {
    let c = clients.get(id);
    if (!c) {
      c = open(id, { apiKey: "", secret: "" })
        .then((x) => {
          const fm = x?.options?.fetchMarkets;
          if (x?.options && SPOT_ONLY.has(id) && fm !== null && typeof fm === "object" && !Array.isArray(fm)) x.options.fetchMarkets = { ...fm, types: ["spot"] };
          return x;
        })
        .catch(() => undefined);
      clients.set(id, c);
    }
    return c;
  };
  /** the price, and how long a miss may be kept: five minutes when every exchange answered, or as long as the soonest refusal among those
   * that could not be asked holds its exchange back (twenty seconds at the least) */
  const ask = async (asset: string): Promise<{ price: number | undefined; missMs: number }> => {
    let missMs = 300_000;
    for (const id of opts.order ?? ORDER) {
      const until = held.get(id);
      if (until !== undefined && clock() < until) {
        missMs = Math.min(missMs, Math.max(MISS_HELD_MS, until - clock()));
        continue;
      }
      const x = await client(id);
      if (!x?.fetchTickers) continue;
      let loading = true;
      try {
        await x.loadMarkets?.(reload.has(id));
        reload.delete(id);
        loading = false;
        const symbols = QUOTES.map((q) => `${asset}/${q}`).filter((s) => x.markets === undefined || x.markets[s] !== undefined);
        if (!symbols.length) continue;
        const t = await x.fetchTickers(symbols);
        const hit = symbols.map((s) => num(t[s]?.last ?? t[s]?.close)).find((p) => p > 0);
        if (hit) return { price: hit, missMs };
      } catch (err) {
        // this exchange could not be asked: held back as long as its refusal says, and the next one asked
        const said: Refusal = exchangeNo(id, id, err);
        const ms = holdBackMs(said, clock());
        if (ms > 0) held.set(id, clock() + ms);
        if (loading) reload.add(id);
        missMs = Math.min(missMs, Math.max(MISS_HELD_MS, ms));
      }
    }
    return { price: undefined, missMs };
  };
  return async (raw) => {
    const asset = ALIAS[raw.toUpperCase()] ?? raw.toUpperCase();
    if (isStable(asset)) return 1;
    const hit = seen.get(asset);
    if (hit && clock() < hit.until) return hit.price;
    const { price, missMs } = await ask(asset);
    seen.set(asset, { until: clock() + (price === undefined ? missMs : 60_000), price });
    return price;
  };
}
