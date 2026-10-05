/** A dollar price for something a source could not price itself: a chain's own coin in a wallet, a token on a spot ledger.
 *
 * It is the last trade on a public market, asked without a key through the unified exchange library: the exchanges are tried in order and
 * the first one that answers wins (one that does not serve this location simply does not answer, and the next is asked). A price is kept
 * for a minute; a miss is remembered for five, so an asset nobody lists is not asked about on every refresh.
 */
import { openExchange, type ExchangeClient, type OpenExchange } from "./exchange.ts";
import { isStable, num } from "./types.ts";

export type Price = (asset: string) => Promise<number | undefined>;

const ORDER = ["kraken", "coinbase", "okx", "binance"];
const QUOTES = ["USD", "USDT", "USDC"];
/** a wrapped or staked form is priced as what it wraps only where that is one for one by construction */
const ALIAS: Record<string, string> = { WETH: "ETH", WBNB: "BNB", WPOL: "POL", MATIC: "POL" };

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
