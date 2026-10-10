/** A LIVE venue on the account: a real source (live/), wrapped in the same adapter shape as every other venue.
 *
 * It reads. Real orders, moves and earn go through the account's live doors (account/live-orders.ts, live-moves.ts, live-earn.ts), on the
 * owner's signature or inside a limit the owner signed — never through the simulated door this adapter wraps: `execute` refuses, in the
 * venue's words, and there is no `credit`, `debit`, `convert` or `shift`; the simulated doors compiled for it are shut (account/doors.ts
 * reads `watchOnly`). Reads are cached, because a real venue counts requests: the page asks for the account every few seconds, the venue is
 * asked at most once per `ttlMs`. When a refresh fails the last good numbers stay, with the time they were read and what went wrong — and
 * a venue that said it cannot be asked just now (it banned this machine's address until a time, its edge refused this network, it is
 * rate-limiting) is not asked again before the hold its refusal carries runs out (public-markets.ts holdBackMs, the one rule), nor while
 * the service holds the same venue's market reads back (`held`).
 *
 * Prices: a dollar stablecoin counts one for one; anything else is worth what the source or the injected price says, and nothing when
 * neither does. The simulation's fixed price table is never applied to a real balance.
 */
import { isRefusal, type Refusal } from "../../core/errors.ts";
import { no, unaddressed } from "../refuse.ts";
import { r2, type Account, type AccountAdapter, type Holding, type Intent } from "../accounts.ts";
import { holdBackMs } from "../live/public-markets.ts";
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
  /** the one hold the service keeps for this venue (its market reads' read cache): what holds it back now, and a refusal this read met,
   * for the market reads to wait out too — `refused` answers whether that hold took it: then the balance follows that hold, and a re-check
   * of the network that lets the venue go (service.ts reached → wake) lets the balance go with it. Absent, or not taken (one of the mm
   * connection's inner venues): this adapter keeps its own hold */
  held?: (() => Refusal | undefined) | undefined;
  refused?: ((r: Refusal) => boolean) | undefined;
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

  /** the venue is not asked again for `ms` from now: what is read meanwhile is the last good numbers */
  const waitFor = (ms: number): void => {
    readAt = clock() - ttl + Math.max(Math.min(ttl, 15_000), ms);
  };
  const refresh = async (): Promise<Holding[]> => {
    // the venue's market reads are held back (a ban, its place rule, an edge page met there): its balance is not asked meanwhile either
    const held = opts.held?.();
    if (held) {
      account.stale = held.message;
      waitFor(0);
      return cached;
    }
    try {
      took(await shape(await source.read()));
      // read in part (an address source whose chain or the venue's API did not answer for some of it): what was read stands, the page says
      // what was not, and the rest is asked again soon
      const unread = source.unread?.();
      if (unread) {
        account.stale = unaddressed(unread).slice(0, 200);
        waitFor(0);
      }
    } catch (err) {
      // the last good numbers stay; the page says how old they are and why — the words with this machine's address taken out before they
      // are cut, as they are served on /api/account. The venue is not asked again for a while: for as long as its refusal holds it back
      // (until a ban's time, ten minutes for a place rule or an edge page), fifteen seconds at least. A refusal's own time is on the wall
      // clock, as the venue said it and the refusal was stamped, so its hold is measured on that clock
      account.stale = unaddressed(String((err as Partial<Refusal> & { message?: string })?.message ?? err)).slice(0, 200);
      // the service's one hold, when it took the refusal, decides when the venue is asked again (asked about every fifteen seconds above):
      // a re-check that finds the venue answering lets it go at once. Otherwise this adapter holds it itself, as long as the refusal says
      if (isRefusal(err)) waitFor(opts.refused?.(err) === true ? 0 : holdBackMs(err));
      else waitFor(0);
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
    // a check of this network found the venue answering again, or a write it took answered: the next read asks it at once rather than
    // serving what was kept while it was held
    wake(): void {
      if (account.stale !== undefined) readAt = 0;
    },
    async execute(i: Intent) {
      // the simulated door: what a live venue does is done through its live doors, so the answer is where that is — or, where the venue
      // has no interface for it, the venue's own reason, and failing that which connection gives none
      const trading = i.kind === "trade";
      const why = trading
        ? source.trader
          ? "orders here are placed through the account's live door (a signed liveOrder), not this one"
          : (source.noTradeBecause ?? `${source.via} gives no interface for orders here`)
        : source.writer
          ? "money here moves through the account's live door (a signed liveMove), not this one"
          : (source.readOnlyBecause ?? `${source.via} gives no interface for moving money here`);
      return no("E_VENUE_RAIL_CLOSED", { venue: id, message: `${source.name}: ${why}`, detail: { want: i.kind } });
    },
  };
}
