/** A dollar price for something a source could not price itself: a chain's own coin in a wallet, a token on a spot ledger.
 *
 * It is the last trade on a public market, asked without a key through the unified exchange library: the exchanges are tried in order and
 * the first one that answers wins (one that does not serve this location simply does not answer, and the next is asked). A price is kept
 * for a minute; a miss is remembered for five, so an asset nobody lists is not asked about on every refresh.
 *
 * The list does not depend on where this machine is. From the developer's machine (2026-10-08) Binance answers HTTP 451 and Bybit 403;
 * wherever they serve, they price what the first three do not list. A refusal costs one round of requests: the library keeps its failed load
 * of the markets and answers it again at once, so an exchange that said no is not asked again while the process runs.
 */
import { openExchange, type ExchangeClient, type OpenExchange } from "./exchange.ts";
import { isStable, num } from "./types.ts";

export type Price = (asset: string) => Promise<number | undefined>;

const ORDER = ["kraken", "coinbase", "okx", "binance", "bybit"];
const QUOTES = ["USD", "USDT", "USDC"];
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
  const seen = new Map<string, { at: number; price: number | undefined }>();
  const client = (id: string) => {
    let c = clients.get(id);
    if (!c) {
      c = open(id, { apiKey: "", secret: "" }).catch(() => undefined);
      clients.set(id, c);
    }
    return c;
  };
  const ask = async (asset: string): Promise<number | undefined> => {
    for (const id of opts.order ?? ORDER) {
      const x = await client(id);
      if (!x?.fetchTickers) continue;
      try {
        await x.loadMarkets?.();
        const symbols = QUOTES.map((q) => `${asset}/${q}`).filter((s) => x.markets === undefined || x.markets[s] !== undefined);
        if (!symbols.length) continue;
        const t = await x.fetchTickers(symbols);
        const hit = symbols.map((s) => num(t[s]?.last ?? t[s]?.close)).find((p) => p > 0);
        if (hit) return hit;
      } catch {
        // this exchange did not answer: the next one is asked
      }
    }
    return undefined;
  };
  return async (raw) => {
    const asset = ALIAS[raw.toUpperCase()] ?? raw.toUpperCase();
    if (isStable(asset)) return 1;
    const hit = seen.get(asset);
    if (hit && clock() - hit.at < (hit.price === undefined ? 300_000 : 60_000)) return hit.price;
    const price = await ask(asset);
    seen.set(asset, { at: clock(), price });
    return price;
  };
}
