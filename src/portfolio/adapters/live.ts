/** A LIVE venue on the account: a real source (live/), wrapped in the same adapter shape as every other venue — and watch-only.
 *
 * It reads. `execute` refuses, and there is no `credit`, `debit`, `convert` or `shift`: nothing the account does can reach the real venue,
 * and the doors compiled for it are all shut (account/doors.ts reads `watchOnly`). Reads are cached, because a real venue counts requests:
 * the page asks for the account every few seconds, the venue is asked at most once per `ttlMs`. When a refresh fails the last good numbers
 * stay, with the time they were read and what went wrong.
 *
 * Prices: a dollar stablecoin counts one for one; anything else is worth what the source or the injected price says, and nothing when
 * neither does. The simulation's fixed price table is never applied to a real balance.
 */
import type { Refusal } from "../../core/errors.ts";
import { no } from "../refuse.ts";
import { r2, type Account, type AccountAdapter, type Holding, type Intent } from "../accounts.ts";
import { isStable, type LiveBalance, type LiveSource } from "../live/types.ts";

export interface LiveAccountOptions {
  /** the connector string the owner signed (`live:exchange:binance`) */
  connector: string;
  /** how long a read is good for, in real milliseconds (default 30 s) */
  ttlMs?: number | undefined;
  /** the real clock: a live venue does not follow the simulation's */
  clock?: (() => number) | undefined;
  /** a price in dollars for an asset the source could not price itself */
  price?: ((asset: string) => Promise<number | undefined>) | undefined;
  /** the balances read while connecting, so the venue is not asked twice */
  first?: LiveBalance[] | undefined;
}

export const WATCH_ONLY = "Live · read-only";

export async function liveAccount(id: string, source: LiveSource, opts: LiveAccountOptions): Promise<AccountAdapter> {
  const clock = opts.clock ?? Date.now;
  const ttl = opts.ttlMs ?? 30_000;
  const byKey = source.address === undefined;
  const account: Account = {
    id,
    name: source.name,
    kind: source.kind,
    provider: `${source.via} · live`,
    credentialRef: source.reference,
    credentialKind: byKey ? "API key in a file in the home directory: this process reads it, the page never sees it" : "no credential: an address, read from the venue",
    scope: { can: ["read"], limits: [source.probe.can.length ? `the venue says this credential can: ${source.probe.can.join(", ")}` : source.probe.note, source.writer ? "nothing is sent to it but what the owner signs, through its own door" : "this connection reads, and sends the venue nothing"], enforcedBy: "venue" },
    settlement: source.writer ? "real money: only what the owner signs, when the server moves real money at all" : "read-only: nothing is sent to this venue from here",
    live: true,
    ...(source.address ? { address: source.address } : {}),
    connector: opts.connector,
    plugged: true,
    watchOnly: WATCH_ONLY,
  };

  const toHolding = async (b: LiveBalance): Promise<Holding> => {
    let usd = b.usd;
    if (usd === undefined && isStable(b.asset)) usd = b.amount;
    if (usd === undefined && opts.price) {
      const p = await opts.price(b.asset).catch(() => undefined);
      if (p !== undefined) usd = b.amount * p;
    }
    const note = [b.where, usd === undefined ? "no price" : undefined].filter(Boolean).join(" · ");
    return { account: id, asset: b.asset, amount: b.amount, usd: r2(usd ?? 0), class: b.class ?? (isStable(b.asset) ? (b.asset.toUpperCase() === "USD" ? "cash" : "stable") : "crypto"), ...(note ? { note } : {}) };
  };
  // what is held, and a short as the venue carries it (a negative amount, worth what buying it back costs): the venue's total is net of it,
  // as the venue's own equity is; the holdings by asset (account/holdings.ts) list only what is held
  const shape = async (rows: LiveBalance[]): Promise<Holding[]> => (await Promise.all(rows.filter((b) => b.amount > 0 || (b.amount < 0 && b.usd !== undefined && b.usd < 0)).map(toHolding))).sort((a, b) => b.usd - a.usd);

  let cached: Holding[] = [];
  let readAt = 0;
  let pending: Promise<Holding[]> | undefined;
  const took = (rows: Holding[]) => {
    cached = rows;
    readAt = clock();
    account.asOf = new Date(readAt).toISOString();
    delete account.stale;
  };
  if (opts.first) took(await shape(opts.first));

  const refresh = async (): Promise<Holding[]> => {
    try {
      took(await shape(await source.read()));
    } catch (err) {
      // the last good numbers stay; the page says how old they are and why. The venue is not asked again for a while
      account.stale = String((err as Partial<Refusal> & { message?: string })?.message ?? err).slice(0, 200);
      readAt = clock() - ttl + Math.min(ttl, 15_000);
    }
    return cached;
  };

  return {
    account,
    read(): Promise<Holding[]> {
      if (readAt !== 0 && clock() - readAt < ttl) return Promise.resolve(cached);
      pending ??= refresh().finally(() => {
        pending = undefined;
      });
      return pending;
    },
    async execute(i: Intent) {
      return no("E_VENUE_RAIL_CLOSED", { venue: id, message: `${source.name} is connected read-only: the account reads it and sends it nothing`, detail: { want: i.kind } });
    },
  };
}
