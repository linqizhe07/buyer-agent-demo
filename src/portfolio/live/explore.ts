/** WHAT IS THERE TO TRADE: every market the account can see — at the venues the owner has connected, and from the public market data of
 * venues it has not (public-markets.ts) — as one list, the same thing at several venues being one row, so the owner and an agent can browse
 * what moves, what trades most and what closes soon, and see at a glance where each thing can be traded now and where a connection is
 * needed first.
 *
 * What it asks, every source at once:
 *
 *   a connected venue    trader.markets(query)            what it lists that matches (its own few to start from, when nothing is typed)
 *                        trader.stats(symbols)            the last 24 hours of those of them whose listing carries no 24-hour figure,
 *                                                         where the trader has the call
 *                        trader.events({…})               its event contracts: what closes within the window, and (with no window) its
 *                                                         busiest, where the trader has the call
 *   a public source      source.listings({q, limit})      its well-known or busiest markets, or the ones matching
 *                        source.events({closingWithinMs}) what closes within the window, where it lists events
 *
 * and nothing else: no order, nothing signed. A public source is not asked when the venue it is the public side of is connected: the
 * connected venue speaks for itself. Each source has one time limit for all of its calls (four seconds by default); what has answered when it
 * is up is shown, and the rest is said to be missing (`missing`, with the venue's own words where it gave some), so one slow or refusing venue
 * never holds up the rest — Binance's "restricted location" is shown as exactly that. A call is not stopped when its time runs out (the
 * interfaces have no way to stop one); its answer is just not waited for.
 *
 * What is one row:
 *   · a coin, by normalBase (compare.ts): BTC/USDT at an exchange, BTC-USD at Robinhood Crypto, WBTC from a wallet are one BTC. A stablecoin
 *     is not a row of its own. A dated future is not listed; a perpetual is a row of its own (Perps), by its base;
 *   · a PRE-IPO perpetual — a contract on a venue's estimate of a private company's valuation (live/preipo.ts), category "Pre-IPO" — by its
 *     company (`group.id` preipo:<slug>): one row per company (Pre-IPO, not Perps), each venue's line carrying the venue's own contract price
 *     and the valuation it implies in the venue's own unit (OKX's ANTHROPIC at 214 in its $10B unit and Gate's at 2,140 in the $1B unit are
 *     one Anthropic). The median guard below runs on the implied valuation, never on the contract price; the row's `implied.usd` is the
 *     median of its venues' and its `price` that median in the $1-per-$1,000,000,000 convention most venues quote in. No `change24h` on the
 *     row (the units differ); the percent change stands. A public listing that names its own place (`venueName`: one source for several
 *     places — Hyperliquid's HIP-3 deployers, "Hyperliquid · io") names its venue line with it; the line's `venue` stays the source's id;
 *   · a stock, by its ticker; a token that stands for a share or a fund (an RWA), by its symbol: an AAPL Stock Token is not an AAPL share.
 *     A token is an RWA when its source lists such tokens (Robinhood's public Stock Token list) or its market carries the RWA category (a
 *     wallet's tokens an issuer stands behind, dex.ts): a Stock Token from a wallet and from Robinhood's public list is one row (`rwa:NVDA`),
 *     traded at the wallet and priced at both; an Ondo Stock (`rwa:NVDAON`) and an xStock (`rwa:NVDAX`) are rows of their own. Such a
 *     row, and each venue line of it, carries the issuer and the issuer's own eligibility words where the venue's market says them;
 *   · an event contract, by its question: `kalshi:<market ticker>`, `pm:<condition id>` or, at Polymarket US (its own exchange, not
 *     polymarket.com's), `pmus:<market slug>` — whichever account or public listing names it — its legs (YES and NO, or a market's named
 *     outcomes) folded into the one row as `outcomes`;
 *   · each venue appears once in a row, by its most traded market for it (its symbol is the one the account's order there names), and a
 *     price more than 10% from the middle of the others' (three venues or more) may be another token under the same name: it is left out of
 *     the row and said in `missing`, as compareAcross leaves it out of the best.
 * A row's price and 24-hour change are its most traded venue's (`changeFrom` says which venue the change is from). Its volume is counted
 * once per market: venues that read the same exchange's data (two accounts at OKX; MetaMask's mm, Polymarket's CLOB and its public Gamma
 * data, which all report Gamma's volume for one Polymarket market) count it once, the largest figure of them, and different exchanges'
 * are summed; an event's volume is its one market's, whichever venues read it. A venue the owner connected that reads an exchange makes that
 * exchange's public listing of the same thing redundant — it trades there already — so the public line is left out of the row. No figure is
 * estimated: a venue that does not say a 24-hour change gives none (Kraken), and
 * Kalshi's volume, which it counts in contracts, is `contracts24h`, never dollars. Only to ORDER the busiest is a Kalshi contract counted at
 * the dollar it pays at settlement, and a Polymarket market counted at its whole event's dollars (`eventVolumeUsd24h`, what Polymarket
 * itself orders by: the Fed decision is one hot question spread over five markets).
 *
 * What is made of the rows:
 *   · tabs (categories.ts TABS): All — every row, as one table; every row's `tabs` starts with it — then Crypto, Stocks, RWAs, Perps,
 *     Pre-IPO, Predictions. A tab is there only when something is in it. What closes within a day (busiest first), the biggest movers and
 *     the most traded are still worked out for the body (`closing`, `movers`, `mostTraded`), for agents. A row's `category` is the venue's
 *     own word for it (categories.ts picks which of several), shown on the card: "Economics", "Fed Rates", "Politics";
 *   · Predictions, when nothing is searched for, is a few of the busiest event markets and not every market the venues have (the owner
 *     asked for a few hot ones, not every bet): each venue's event rows by its own volume measure — contracts for Kalshi, dollars for
 *     Polymarket — then the venues in turn, the venue with the busiest row first, at most PREDICTIONS_MAX rows; an event under an excluded
 *     category (sports, weather, entertainment, mentions — categories.ts) is not one of them whatever venue lists it; the other event rows
 *     are not shown anywhere, so what closes soon is drawn from the same few. The IPO questions (category "IPO" or "IPOs", categories.ts
 *     isIpoCategory) stay beside the few whatever their volume, so the Pre-IPO company drawer can name them: they are Predictions, not
 *     Pre-IPO. With a search, every event row that matches is shown;
 *   · movers: coins, stocks, perpetuals and tokens by the size of their 24-hour change, only those whose 24-hour dollar volume is at least
 *     `moversMinUsd` ($1M by default; $10M for a perpetual, since Hyperliquid lists hundreds of thin ones), so that a thin market's jump is
 *     not news — one chip per asset: a coin's perpetual is the same asset as the coin, and the coin's own market is the one shown when it
 *     moves enough;
 *   · closing: the busiest events that close within the window (a day by default), the soonest first;
 *   · notes: what the sources say their lists are made of, in plain sentences for under the list ("Kalshi: the busiest market in each of
 *     10 series — …", "Robinhood Stock Tokens: 40 of 194 shown · search for the rest"), and this file's own about Predictions.
 *
 * An event past its close: Kalshi's close_time is the real close, so a Kalshi leg whose closeTime has passed is `open: false` whatever the
 * listing still says; Polymarket's endDate is Gamma's estimate and a market trades on past it, so a Polymarket leg keeps `open` as Gamma
 * says. Either way the row and its legs carry `pastEnd: true`, so the page can say "past its end date, still trading" rather than "closed".
 *
 * A stock out of its session (a stock market at night) may still take orders — Alpaca holds one for the open — so its line keeps `open` as
 * the venue says and carries the venue's `session` (in session now, when it next opens or closes), with the venue's note on what it does
 * until the open; the row carries the session of its first connected venue that says one, so the page can say "Closed" from it.
 */
import { isRefusal, type Refusal } from "../../core/errors.ts";
import { isExcludedCategory, isIpoCategory, isRwaMarket, TABS, type TabId } from "./categories.ts";
import { normalBase, type CompareMissing, type PlaceRule } from "./compare.ts";
import { impliedUsd, PER_SHARE, PRE_IPO_CATEGORY, PRE_IPO_GROUP, PRE_IPO_PER_POINT } from "./preipo.ts";
import type { EventsQuery, Listing, PublicSource } from "./public-markets.ts";
import { inDollars, type LiveTrader, type Market, type MarketSession, type MarketStats } from "./trade.ts";
import { isStable } from "./types.ts";

export interface ExploreVenue {
  /** the account's id for the venue */
  id: string;
  name: string;
  trader: LiveTrader;
  /** the connection it was made with (`live:exchange:okx`, `live:kalshi`): a public source of the same connection is then not asked */
  connector?: string | undefined;
  /** the venue's own place rule for this network, judged just now (compare.ts PlaceRule): `closed` — its lines cannot trade here, and say
   * why in its words; `close-only` — they can (a sell closes), and say that only closing is taken */
  place?: PlaceRule | undefined;
}

export interface ExploreSources {
  connected?: ExploreVenue[] | undefined;
  public?: PublicSource[] | undefined;
}

export type ExploreKind = "coin" | "stock" | "perp" | "event" | "rwa";
export type ExploreSort = "volume" | "movers" | "closing";

export interface ExploreOptions {
  /** a few letters of a symbol or a name: only the rows that match */
  q?: string | undefined;
  /** only this tab's rows in `items` (absent, or `all`: every row) */
  tab?: TabId | undefined;
  /** `items` by volume (the default; the curated Predictions keep their own order), by the size of the 24-hour change, or by how soon they close */
  sort?: ExploreSort | undefined;
  /** at most this many rows in `items` (60) */
  limit?: number | undefined;
  /** how long each source has for all of its calls, in milliseconds (4000) */
  timeoutMs?: number | undefined;
  /** how many markets each source is asked for (40) */
  perSource?: number | undefined;
  /** how many movers, closing events and parts of Now (8 each) */
  top?: number | undefined;
  /** the least 24-hour dollar volume a mover must have: one figure for every kind, or by kind ($1,000,000; a perpetual $10,000,000) */
  moversMinUsd?: number | Partial<Record<Exclude<ExploreKind, "event">, number>> | undefined;
  /** what "closing soon" means, in milliseconds from now (a day) */
  closingWithinMs?: number | undefined;
  clock?: (() => number) | undefined;
  /** does this source's venue serve the network the account runs on (its own answer to it, as the account last learned it): one that does
   * not — or offers no way in — is not asked, and its markets are not listed; a note names it, without its words. Absent: every source is */
  serves?: ((r: { id: string; name: string; connected: boolean; connector?: string | undefined }) => boolean) | undefined;
}

/** one venue where a row's thing is listed */
export interface ExploreAt {
  venue: string;
  venueName: string;
  /** the market there: at a connected venue, exactly what the account's order there names; at a public one, what it would name once the
   * venue is connected. An event's is its first outcome's (each outcome's are in `outcomes`) */
  symbol: string;
  /** the owner has connected this venue */
  connected: boolean;
  /** may the connected key or sign-in trade there: what the venue said (`unknown`: its first refusal will say); a public listing: false */
  canTrade: boolean | "unknown";
  /** read from the venue's public market data, without a key */
  public: boolean;
  price?: number | undefined;
  /** the venue's book for it, where its listing gives one (an event's: the lead outcome's) */
  bid?: number | undefined;
  ask?: number | undefined;
  /** the market takes orders now, as the venue says — except a Kalshi event past its close, which is closed whatever the listing says */
  open?: boolean | undefined;
  /** the venue's trading session for it, where the venue keeps one (a stock: Market.session) — in session now, when it next opens or closes.
   * A stock out of its session may still be `open` (the venue holds an order for the open): its `note` then says so in the venue's words */
  session?: MarketSession | undefined;
  /** an event whose close time has passed: a Polymarket market may still trade then (Gamma's endDate is an estimate), a Kalshi one is closed */
  pastEnd?: boolean | undefined;
  /** a public listing: the venue to connect to trade it, and the connection that does. Left out of a read-only listing's line (Stock
   * Tokens) when the row already trades at a connected venue: the line is then a price, not a connection to make */
  connectTo?: string | undefined;
  connector?: string | undefined;
  /** why it cannot be traded there (the venue's words), or what the venue says of the market; for a token an issuer stands behind, whom the
   * issuer says it is not for, or the issuer's rule that keeps it from being swapped */
  note?: string | undefined;
  /** a token an issuer stands behind: who issues it, and whom the issuer says it is not for, in the issuer's own words */
  issuer?: string | undefined;
  eligibility?: string | undefined;
  /** a pre-IPO perpetual: the company valuation this venue's contract price implies, in dollars, and the venue's unit in words (live/preipo.ts) */
  implied?: { usd: number; unit: string } | undefined;
}

export interface ExploreOutcome {
  /** "Yes", "No", or the outcome's own name ("Falcons") */
  label: string;
  /** dollars per contract or share, which is the market's probability for it */
  price?: number | undefined;
  bid?: number | undefined;
  ask?: number | undefined;
  /** in dollars per contract over 24 hours (0.03 = 3¢) */
  change24h?: number | undefined;
  /** the outcome's market at each venue that lists it */
  at: Array<{ venue: string; symbol: string }>;
}

export interface ExploreItem {
  /** `coin:BTC`, `stock:AAPL`, `perp:ETH`, `rwa:NVDA`, `kalshi:<market ticker>`, `pm:<condition id>`, `pmus:<market slug>` */
  key: string;
  kind: ExploreKind;
  name: string;
  /** the one name for the thing (BTC, AAPL); an event has none */
  base?: string | undefined;
  /** dollars; an event's is its first outcome's */
  price?: number | undefined;
  changePct24h?: number | undefined;
  change24h?: number | undefined;
  /** the venue whose 24-hour change is shown */
  changeFrom?: { venue: string; venueName: string } | undefined;
  /** the dollars traded in 24 hours: each exchange's market counted once, the exchanges summed (an event: its one market's) */
  volumeUsd24h?: number | undefined;
  /** the event contracts traded in 24 hours, where a venue counts contracts instead of dollars (Kalshi) */
  contracts24h?: number | undefined;
  /** an event market's whole event, all its markets together, in dollars over 24 hours, where the venue reports it (Polymarket): how hot the
   * question is. Only to order the busiest; the row's volume stays the market's */
  eventVolumeUsd24h?: number | undefined;
  /** the venue's own words */
  category?: string | undefined;
  closeTime?: string | undefined;
  /** an event whose `closeTime` has passed (see the top of this file: a Polymarket market may still trade then) */
  pastEnd?: boolean | undefined;
  /** the venue's event an event market belongs to, where an event holds several */
  event?: { id: string; title: string } | undefined;
  /** a perpetual's funding rate per interval and when it is next paid, from its most traded venue that says */
  fundingRate?: number | undefined;
  nextFundingAt?: string | undefined;
  /** a stock's trading session (Market.session), from the first of its connected venues that says one */
  session?: MarketSession | undefined;
  outcomes?: ExploreOutcome[] | undefined;
  /** a token an issuer stands behind (kind rwa), or a pre-IPO perpetual whose issuer has spoken: who issues it and what the issuer says, in
   * the issuer's own words, from the first venue that says */
  issuer?: string | undefined;
  eligibility?: string | undefined;
  /** a pre-IPO perpetual's company (`preipo:<slug>`, its name), or an event's question where the venue gives one (see `event`) */
  group?: { id: string; title: string } | undefined;
  /** a pre-IPO perpetual: the median of its venues' implied company valuations, in dollars, and what that figure is (each venue's own is on
   * its line, in the venue's own unit) */
  implied?: { usd: number; unit: string } | undefined;
  /** the tabs it is in: `all` first, then its own */
  tabs: TabId[];
  at: ExploreAt[];
}

export type Mover = ExploreItem & { changePct24h: number; volumeUsd24h: number };

export interface ExploreMissing extends CompareMissing {
  /** the venue is one the owner connected (false: a public source) */
  connected: boolean;
  /** which of its calls, when the others answered */
  part?: "markets" | "stats" | "events" | undefined;
  /** the venue's own words, when it gave some ("Service unavailable from a restricted location …") */
  said?: string | undefined;
  /** a market left out of a row: its price is far from the other venues' */
  symbol?: string | undefined;
}

export interface Exploration {
  asOf: string;
  tabs: Array<{ id: TabId; label: string; count: number }>;
  items: ExploreItem[];
  movers: Mover[];
  closing: ExploreItem[];
  /** coins, stocks, perpetuals and tokens by their 24-hour dollar volume */
  mostTraded: ExploreItem[];
  missing: ExploreMissing[];
  /** plain sentences for under the list, each under 160 characters: what the lists are made of (the sources' own words, and this file's
   * about Predictions) */
  notes: string[];
}

/** the most event rows Predictions shows when nothing is searched for */
export const PREDICTIONS_MAX = 12;

/** a source, connected or public, as the aggregator asks it */
interface Reader {
  id: string;
  name: string;
  connected: boolean;
  canTrade: boolean | "unknown";
  whyNot?: string | undefined;
  /** the venue's close-only rule for this network, in its words: it trades, but only what closes */
  closeOnly?: string | undefined;
  readOnly?: string | undefined;
  connectTo?: string | undefined;
  connector?: string | undefined;
  /** whose market data it reads: the connection (`live:exchange:okx`, `live:kalshi`), which a connected venue and the public source of the
   * same exchange share; a source nothing is traded through (Stock Tokens) is its own */
  family: string;
  /** its event contracts are Kalshi's, named by market ticker */
  kalshi: boolean;
  /** its event contracts are Polymarket US's, named by market slug */
  pmus: boolean;
  /** its tokens stand for shares or funds */
  rwa: boolean;
  markets(q: string): Promise<Market[] | Refusal>;
  stats?: ((symbols: string[]) => Promise<Map<string, MarketStats> | Refusal>) | undefined;
  events?: ((o: EventsQuery) => Promise<Market[] | Refusal>) | undefined;
  /** its busiest events are asked apart from its listing (a trader's few markets to start from may hold none) */
  eventsAlso: boolean;
  /** what it says of the list asked for, once it has answered (a public source's `notes`) */
  notes?: ((o: { q: string }) => string[]) | undefined;
}

type Part = "markets" | "stats" | "events";
type Got = { r: Reader; m: Listing };

const pos = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
const fin = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const seconds = (ms: number): string => `${Number((ms / 1000).toFixed(3))} s`;
const LATE = Symbol("late");
/** the longest a timer waits: setTimeout fires at once for anything longer */
const MAX_MS = 2_147_483_647;
const DAY_MS = 86_400_000;
/** the least a mover trades in a day, by kind: a perpetual ten times a coin, since Hyperliquid alone lists hundreds of thin perpetuals whose
 * jumps are not news */
const FLOOR_USD: Record<Exclude<ExploreKind, "event">, number> = { coin: 1_000_000, stock: 1_000_000, rwa: 1_000_000, perp: 10_000_000 };
const HEX_ID = /^0x[0-9a-f]{64}$/i;

/** a call as an answer, never a throw */
function settle<T>(call: () => Promise<T | Refusal>): Promise<T | Refusal | Error> {
  return Promise.resolve()
    .then(call)
    .catch((err: unknown) => (isRefusal(err) ? err : err instanceof Error ? err : new Error(String(err))));
}

/** the venue's own words in a refusal: the message inside the JSON it answered with, where there is one, else what it said */
function wordsOf(r: Refusal): string | undefined {
  const said = (r.native as { said?: unknown } | undefined)?.said;
  if (typeof said !== "string" || !said.trim()) return undefined;
  const inner = /"(?:msg|message|retMsg|error_description)"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(said);
  return (inner?.[1] ? inner[1].replace(/\\"/g, '"') : said).trim().slice(0, 240) || undefined;
}

function fromVenue(v: ExploreVenue): Reader {
  let canTrade: boolean | "unknown" = "unknown";
  let whyNot: string | undefined;
  try {
    canTrade = v.trader.can;
    whyNot = v.trader.whyNot;
  } catch {
    canTrade = "unknown";
  }
  // the venue's own rule takes no order from this network: whatever the key may do, nothing trades there from here
  if (v.place?.rule === "closed") {
    canTrade = false;
    whyNot = v.place.words;
  }
  const t = v.trader;
  return {
    id: v.id,
    name: v.name,
    connected: true,
    canTrade,
    whyNot,
    ...(v.place?.rule === "close-only" ? { closeOnly: v.place.words } : {}),
    connector: v.connector,
    family: v.connector ?? v.id,
    kalshi: /kalshi/i.test(v.id) || /^live:kalshi/.test(v.connector ?? ""),
    pmus: v.connector === "live:polymarket-us" || (v.connector === undefined && v.id === "polymarket-us"),
    rwa: false,
    markets: (q) => t.markets(q),
    stats: t.stats ? (s) => t.stats!(s) : undefined,
    events: t.events ? (o) => t.events!(o) : undefined,
    eventsAlso: true,
  };
}

function fromPublic(s: PublicSource, perSource: number): Reader {
  return {
    id: s.id,
    name: s.name,
    connected: false,
    canTrade: false,
    readOnly: s.readOnly,
    connectTo: s.connectTo,
    connector: s.connector,
    family: s.readOnly !== undefined ? s.id : s.connector,
    kalshi: s.connectTo === "kalshi",
    pmus: s.connector === "live:polymarket-us",
    rwa: s.kind === "tokens",
    markets: (q) => s.listings({ q, limit: perSource }),
    stats: s.stats ? (symbols) => s.stats!(symbols) : undefined,
    events: s.events ? (o) => s.events!(o) : undefined,
    // a public source's listing is already its busiest events
    eventsAlso: false,
    notes: s.notes ? (o) => s.notes!(o) : undefined,
  };
}

const isMarket = (m: unknown): m is Listing => !!m && typeof m === "object" && typeof (m as Market).symbol === "string" && (m as Market).symbol !== "" && typeof (m as Market).kind === "string";
const noDay = (m: Market): boolean => m.kind !== "event" && m.changePct24h === undefined && m.volumeUsd24h === undefined;

/** what a source says of the list asked for, once it has answered; a source whose sentences cannot be read says nothing */
function notesOf(r: Reader, q: string): string[] {
  try {
    return (r.notes?.({ q }) ?? []).filter((n): n is string => typeof n === "string" && n.trim() !== "").map((n) => n.trim().slice(0, 160));
  } catch {
    return [];
  }
}

/** one source's markets, inside its time limit; what failed or did not answer in time, said; and what the source says of its list */
async function atSource(r: Reader, o: { q: string; ms: number; perSource: number; closingWithinMs: number }): Promise<{ got: Got[]; missing: ExploreMissing[]; notes: string[] }> {
  const slots: Array<{ part: Part; v?: unknown; done: boolean }> = [];
  const run = <T>(part: Part, call: () => Promise<T | Refusal>): Promise<T | Refusal | Error> => {
    const s: { part: Part; v?: unknown; done: boolean } = { part, done: false };
    slots.push(s);
    return settle(call).then((v) => {
      s.v = v;
      s.done = true;
      return v;
    });
  };
  const work: Array<Promise<unknown>> = [
    run("markets", () => r.markets(o.q)).then(async (listed) => {
      if (!Array.isArray(listed) || !r.stats) return;
      const want = [...new Set(listed.filter(isMarket).filter(noDay).map((m) => m.symbol))];
      if (want.length) await run("stats", () => r.stats!(want));
    }),
  ];
  if (r.events) {
    work.push(run("events", () => r.events!({ closingWithinMs: o.closingWithinMs, limit: o.perSource })));
    if (r.eventsAlso) work.push(run("events", () => r.events!({ limit: o.perSource })));
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<typeof LATE>((resolve) => {
    timer = setTimeout(() => resolve(LATE), o.ms);
  });
  try {
    await Promise.race([Promise.all(work), late]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  const seen = slots.map((s) => ({ ...s }));

  // what came back: the listing and the events, one market per symbol (a market both list keeps every field either gave), with the 24-hour
  // figures the stats call gave to those whose listing had none
  const bySymbol = new Map<string, Listing>();
  let stats: Map<string, MarketStats> | undefined;
  for (const s of seen) {
    if (!s.done) continue;
    if (s.part === "stats" && s.v instanceof Map) stats = s.v as Map<string, MarketStats>;
    if (s.part !== "stats" && Array.isArray(s.v))
      for (const m of s.v.filter(isMarket)) {
        const was = bySymbol.get(m.symbol);
        bySymbol.set(m.symbol, was ? fill(was, m) : m);
      }
  }
  const got: Got[] = [...bySymbol.values()].map((m) => {
    const st = stats?.get(m.symbol);
    return { r, m: st && noDay(m) ? fill(m, { price: st.price, changePct24h: st.changePct24h, change24h: st.change24h, volumeUsd24h: st.volumeUsd24h }) : m };
  });

  const gone = (why: string, extra: Partial<ExploreMissing> = {}): ExploreMissing => ({ venue: r.id, venueName: r.name, why, connected: r.connected, ...extra });
  const failed: ExploreMissing[] = [];
  for (const s of seen) {
    if (!s.done) failed.push(gone(`did not answer in ${seconds(o.ms)}`, { code: "E_VENUE_UNREACHABLE", part: s.part }));
    else if (isRefusal(s.v)) {
      const said = wordsOf(s.v);
      failed.push(gone(s.v.message, { code: s.v.code, part: s.part, ...(said ? { said } : {}) }));
    } else if (s.v instanceof Error || (s.part === "stats" ? !(s.v instanceof Map) : !Array.isArray(s.v))) failed.push(gone("answered in a way this could not read", { part: s.part }));
  }
  // what a source says its list is made of, only when its listing answered: a source that refused this network, timed out or could not be
  // read is described by its line in `missing`, not by a list it did not give (nor by what an earlier network's listing showed)
  const listed = seen.some((s) => s.part === "markets" && s.done && Array.isArray(s.v));
  const notes = listed ? notesOf(r, o.q) : [];
  if (got.length) return { got, missing: dedupe(failed), notes };
  // nothing to show: the source is missing as a whole, for its listing's reason first
  const first = failed.find((f) => f.part === "markets") ?? failed[0];
  if (!first) return { got, missing: [], notes };
  const { part: _part, ...whole } = first;
  return { got, missing: [whole], notes };
}

/** the venues that do not serve this network, in a line under 160 characters: named, never quoted */
function awayNote(names: string[]): string {
  const shown = names.length > 4 ? [...names.slice(0, 3), `${names.length - 3} more`] : names;
  const list = shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}` : shown[0]!;
  return `${list} ${names.length === 1 ? "does" : "do"} not serve this network: ${names.length === 1 ? "its" : "their"} markets are not listed here.`;
}

/** one line per thing missing: a source that is missing as a whole (no part, no symbol) is one line per venue name and reason, so an exchange
 * read through two public sources (its spot tickers and its pre-IPO perpetuals) that both refused with the same words is named once */
const dedupe = (list: ExploreMissing[]): ExploreMissing[] => {
  const keys = new Set<string>();
  return list.filter((m) => {
    const k = m.part === undefined && m.symbol === undefined ? `whole|${m.venueName}|${m.why}` : `${m.venue}|${m.part ?? ""}|${m.why}|${m.symbol ?? ""}`;
    return !keys.has(k) && keys.add(k) !== undefined;
  });
};

/** `a`, with what `b` says where `a` says nothing */
function fill<T extends object>(a: T, b: Partial<T>): T {
  const out = { ...a } as Record<string, unknown>;
  for (const [k, v] of Object.entries(b)) if (v !== undefined && out[k] === undefined) out[k] = v;
  return out as T;
}

function kindOf(m: Market, r: Reader): ExploreKind | undefined {
  switch (m.kind) {
    case "event":
      return "event";
    case "stock":
      return "stock";
    case "perp":
      return "perp";
    case "spot":
    case "crypto":
      return "coin";
    case "token":
      return r.rwa || isRwaMarket(m) ? "rwa" : "coin";
    default:
      // a dated future: its price carries the time to its expiry, so it is not one row with anything else
      return undefined;
  }
}

/** an event market's outcome: the venue's own, else what its symbol ends in */
const outcomeOf = (m: Market): string => m.outcome ?? (m.symbol.includes(":") ? m.symbol.slice(m.symbol.lastIndexOf(":") + 1) : m.base);
/** an event market's question, without the outcome its name ends in */
function titleOf(m: Market): string {
  const tail = ` · ${outcomeOf(m)}`;
  return m.name.toLowerCase().endsWith(tail.toLowerCase()) ? m.name.slice(0, -tail.length) : m.name;
}

/** the question an event market belongs to: the venue's own (`group`), else read from a Kalshi symbol (`<ticker>:YES`), else the symbol's
 * part before its outcome */
function groupOf(m: Market): { id: string; title: string } | undefined {
  if (m.group?.id) return { id: m.group.id, title: m.group.title || titleOf(m) };
  const k = /^([A-Za-z0-9][A-Za-z0-9._-]*):(YES|NO)$/i.exec(m.symbol);
  if (k) return { id: k[1]!.toUpperCase(), title: titleOf(m) };
  const i = m.symbol.lastIndexOf(":");
  return i > 0 ? { id: m.symbol.slice(0, i), title: titleOf(m) } : undefined;
}

function keyOf(m: Market, kind: ExploreKind, r: Reader): string | undefined {
  if (kind === "event") {
    const g = groupOf(m);
    if (!g) return undefined;
    if (HEX_ID.test(g.id)) return `pm:${g.id.toLowerCase()}`;
    if (r.pmus) return `pmus:${g.id.toLowerCase()}`;
    return r.kalshi ? `kalshi:${g.id.toUpperCase()}` : `event:${r.id}:${g.id}`;
  }
  if (kind === "stock") {
    const t = normalBase(String(m.base || m.symbol), "stock");
    return t ? `stock:${t}` : undefined;
  }
  if (kind === "rwa") {
    const t = String(m.base || m.symbol).trim().toUpperCase();
    return t ? `rwa:${t}` : undefined;
  }
  // a pre-IPO perpetual is one row per company, whatever each venue calls the contract (ANTHROPIC, ANTH, ANTHROPICx)
  if (kind === "perp" && m.category === PRE_IPO_CATEGORY && m.group?.id.startsWith(PRE_IPO_GROUP)) return m.group.id;
  const b = normalBase(String(m.base || m.symbol), m.kind);
  if (!b || isStable(b)) return undefined;
  return `${kind}:${b}`;
}

const priceOf = (m: Market): number | undefined => pos(m.price) ?? (pos(m.bid) !== undefined && pos(m.ask) !== undefined ? (m.bid! + m.ask!) / 2 : undefined);
/** the name on a market's venue line: a public listing's own place where it names one (Hyperliquid's HIP-3: "Hyperliquid · io"), else the
 * source's or the venue's name */
const lineName = (r: Reader, m: Market): string => {
  const own = (m as Listing).venueName;
  return !r.connected && typeof own === "string" && own.trim() ? own.trim().slice(0, 80) : r.name;
};
/** a market's session as the venue said it (Market.session), with nothing else carried; none where it said none, or not in that shape */
function sessionOf(m: Market): MarketSession | undefined {
  const s = m.session;
  if (!s || typeof s !== "object" || typeof s.open !== "boolean") return undefined;
  const at = (x: unknown): string | undefined => (typeof x === "string" && Number.isFinite(Date.parse(x)) ? x : undefined);
  const opensAt = at(s.opensAt);
  const closesAt = at(s.closesAt);
  return { open: s.open, ...(opensAt ? { opensAt } : {}), ...(closesAt ? { closesAt } : {}) };
}
/** how busy a row is, only to order: an event's whole event where the venue reports it, else the market's dollars, else its contracts counted
 * at the dollar each pays at settlement */
const volumeOf = (i: { volumeUsd24h?: number | undefined; contracts24h?: number | undefined; eventVolumeUsd24h?: number | undefined }): number => i.eventVolumeUsd24h ?? i.volumeUsd24h ?? i.contracts24h ?? -1;
const closeMs = (i: { closeTime?: string | undefined }): number => (i.closeTime ? Date.parse(i.closeTime) : NaN);

/** one venue's line of a row. `offer`: whether a public line names the venue to connect (not when the row trades at a connected venue
 * already and this listing is read-only — then it is a price and nothing more) */
function atOf(r: Reader, m: Market, symbol = m.symbol, price = priceOf(m), open = m.open, offer = true): ExploreAt {
  // a token an issuer stands behind, at a connected venue: the issuer's own words go with it, and one whose contract moves it only between
  // wallets the issuer approved takes no order there (dex.ts lists it with no order types), whatever the venue may trade
  const rwa = r.connected && isRwaMarket(m) ? m : undefined;
  const ordersTaken = !rwa || !Array.isArray(m.types) || m.types.length > 0;
  const issuerWords = rwa && typeof rwa.eligibility === "string" && rwa.eligibility ? rwa.eligibility : undefined;
  const issuer = typeof m.issuer === "string" && m.issuer ? m.issuer : undefined;
  const eligibility = typeof m.eligibility === "string" && m.eligibility ? m.eligibility : undefined;
  // the venue's own words where it takes no order now, or where its market is out of its session (a stock at night: the venue says what it
  // does with an order until the open)
  const session = sessionOf(m);
  const note = (r.connected && r.canTrade === false ? r.whyNot : undefined) ?? (r.connected ? r.closeOnly : undefined) ?? r.readOnly ?? issuerWords ?? ((open === false || session?.open === false) && typeof m.note === "string" && m.note ? m.note : undefined);
  return {
    venue: r.id,
    venueName: lineName(r, m),
    symbol,
    connected: r.connected,
    canTrade: r.connected ? (ordersTaken ? r.canTrade : false) : false,
    public: !r.connected,
    ...(price !== undefined ? { price } : {}),
    ...(pos(m.bid) !== undefined ? { bid: m.bid } : {}),
    ...(pos(m.ask) !== undefined ? { ask: m.ask } : {}),
    ...(typeof open === "boolean" ? { open } : {}),
    ...(session ? { session } : {}),
    ...(!r.connected && offer && r.connectTo ? { connectTo: r.connectTo } : {}),
    ...(!r.connected && offer && r.connector ? { connector: r.connector } : {}),
    ...(note ? { note } : {}),
    ...(issuer ? { issuer } : {}),
    ...(eligibility ? { eligibility } : {}),
  };
}

const TAB_OF: Record<Exclude<ExploreKind, "event">, TabId> = { coin: "crypto", stock: "stocks", rwa: "rwas", perp: "perps" };
const displayLabel = (label: string): string => (/^yes$/i.test(label) ? "Yes" : /^no$/i.test(label) ? "No" : label);

/** one row from a thing's markets, venue by venue (connected venues first); markets set aside by the median guard go to `aside` */
function rowOf(key: string, kind: ExploreKind, venues: Map<string, Got[]>, aside: ExploreMissing[], now: number): ExploreItem | undefined {
  const all = [...venues.values()].sort((a, b) => Number(b[0]!.r.connected) - Number(a[0]!.r.connected));
  if (kind === "event") return eventRow(key, all, now);
  // a public listing of an exchange a connected venue reads already is the same market again: the connected venue speaks for it
  const reads = new Set(all.filter((l) => l[0]!.r.connected).map((l) => l[0]!.r.family));
  const order = all.filter((l) => l[0]!.r.connected || !reads.has(l[0]!.r.family));
  // each venue once, by its most traded market for the thing (an open one before a closed one, then the venue's own order)
  let entries = order.map((list) => [...list].sort((a, b) => (b.m.volumeUsd24h ?? -1) - (a.m.volumeUsd24h ?? -1) || Number(b.m.open !== false) - Number(a.m.open !== false))[0]!);
  if (key.startsWith(PRE_IPO_GROUP)) return preIpoRow(key, entries, aside);
  const priced = entries.filter((e) => priceOf(e.m) !== undefined);
  if (priced.length >= 3) {
    const prices = priced.map((e) => priceOf(e.m)!).sort((x, y) => x - y);
    const middle = prices[Math.floor(prices.length / 2)]!;
    const far = new Set(priced.filter((e) => Math.abs(priceOf(e.m)! - middle) / middle > 0.1));
    for (const e of far) aside.push({ venue: e.r.id, venueName: lineName(e.r, e.m), connected: e.r.connected, symbol: e.m.symbol, why: `lists ${e.m.symbol} at ${priceOf(e.m)}, more than 10% from the other venues' ${middle} for ${key.slice(key.indexOf(":") + 1)}: it may be another token under the same name, so it is left out of that row` });
    entries = entries.filter((e) => !far.has(e));
  }
  if (!entries.length) return undefined;
  entries.sort((a, b) => (b.m.volumeUsd24h ?? -1) - (a.m.volumeUsd24h ?? -1) || Number(b.r.connected) - Number(a.r.connected));
  const base = key.slice(key.indexOf(":") + 1);
  const priceAt = entries.find((e) => priceOf(e.m) !== undefined);
  const moved = entries.find((e) => fin(e.m.changePct24h) !== undefined);
  // one market's volume once: the largest figure of the venues that read one exchange, then the exchanges summed
  const byFamily = new Map<string, number>();
  for (const e of entries) {
    const v = fin(e.m.volumeUsd24h);
    if (v !== undefined && v >= 0) byFamily.set(e.r.family, Math.max(byFamily.get(e.r.family) ?? 0, v));
  }
  const vols = [...byFamily.values()];
  const funded = entries.find((e) => fin(e.m.fundingRate) !== undefined);
  // a stock's session: its first connected venue's that says one (the order its lines are in)
  const sessioned = entries.find((e) => e.r.connected && sessionOf(e.m) !== undefined);
  const named = entries.find((e) => e.m.name && !e.m.name.includes(" / ") && e.m.name.toUpperCase() !== e.m.symbol.toUpperCase());
  const name = kind === "coin" ? base : kind === "perp" ? `${base} perpetual` : (named?.m.name ?? base);
  const category = entries.map((e) => e.m.category).find((c): c is string => typeof c === "string" && c !== "");
  const issued = kind === "rwa" ? entries.find((e) => typeof e.m.issuer === "string" && e.m.issuer !== "") : undefined;
  const eligible = kind === "rwa" ? entries.find((e) => typeof e.m.eligibility === "string" && e.m.eligibility !== "") : undefined;
  // the row trades at a venue the owner connected: a read-only listing's line (Stock Tokens) is then its price, with no connection to offer
  const trades = entries.some((e) => e.r.connected && e.r.canTrade !== false);
  return {
    key,
    kind,
    name,
    base,
    ...(priceAt ? { price: priceOf(priceAt.m) } : {}),
    ...(moved ? { changePct24h: moved.m.changePct24h, ...(fin(moved.m.change24h) !== undefined ? { change24h: moved.m.change24h } : {}), changeFrom: { venue: moved.r.id, venueName: lineName(moved.r, moved.m) } } : {}),
    ...(vols.length ? { volumeUsd24h: vols.reduce((s, v) => s + v, 0) } : {}),
    ...(category ? { category } : {}),
    ...(funded ? { fundingRate: funded.m.fundingRate, ...(funded.m.nextFundingAt ? { nextFundingAt: funded.m.nextFundingAt } : {}) } : {}),
    ...(sessioned ? { session: sessionOf(sessioned.m) } : {}),
    ...(issued ? { issuer: issued.m.issuer } : {}),
    ...(eligible ? { eligibility: eligible.m.eligibility } : {}),
    tabs: ["all", TAB_OF[kind as Exclude<ExploreKind, "event">]],
    at: entries.map((e) => atOf(e.r, e.m, e.m.symbol, priceOf(e.m), e.m.open, !(trades && e.r.readOnly !== undefined))),
  };
}

/** the valuation a venue's pre-IPO contract implies: the listing's own figure, or its price in the venue's unit (a connected key's market
 * carries the unit from its list and a price from its stats) */
function impliedOf(m: Market): { usd: number; unit: string } | undefined {
  if (!m.implied) return undefined;
  const usd = pos(m.implied.usd) ?? (priceOf(m) !== undefined ? impliedUsd(priceOf(m)!, m.implied.perPoint) : undefined);
  return usd === undefined ? undefined : { usd, unit: m.implied.unit };
}

/** a pre-IPO company's row (see the top of this file): one line per venue, each with the venue's own contract price and the valuation it
 * implies in the venue's own unit; the median guard on the implied valuation; the row's `implied.usd` the median of the venues', its `price`
 * that median in the $1-per-$1,000,000,000 convention. The row is Pre-IPO, not Perps */
function preIpoRow(key: string, every: Got[], aside: ExploreMissing[]): ExploreItem | undefined {
  let entries = every.filter((e) => impliedOf(e.m) !== undefined || priceOf(e.m) === undefined);
  const title = every.map((e) => e.m.group?.title).find((t): t is string => typeof t === "string" && t !== "") ?? key.slice(PRE_IPO_GROUP.length);
  const valued = entries.filter((e) => impliedOf(e.m) !== undefined);
  if (valued.length >= 3) {
    const usds = valued.map((e) => impliedOf(e.m)!.usd).sort((x, y) => x - y);
    const middle = usds[Math.floor(usds.length / 2)]!;
    const far = new Set(valued.filter((e) => Math.abs(impliedOf(e.m)!.usd - middle) / middle > 0.1));
    for (const e of far) aside.push({ venue: e.r.id, venueName: lineName(e.r, e.m), connected: e.r.connected, symbol: e.m.symbol, why: `lists ${e.m.symbol} at ${priceOf(e.m)}, an implied ${impliedOf(e.m)!.usd} in its unit, more than 10% from the other venues' ${middle} for ${title}: it may be another thing under the same name, so it is left out of that row` });
    entries = entries.filter((e) => !far.has(e));
  }
  if (!entries.length) return undefined;
  entries.sort((a, b) => (b.m.volumeUsd24h ?? -1) - (a.m.volumeUsd24h ?? -1) || Number(b.r.connected) - Number(a.r.connected));
  const usds = entries.map((e) => impliedOf(e.m)?.usd).filter((u): u is number => u !== undefined).sort((x, y) => x - y);
  const median = usds.length ? (usds.length % 2 ? usds[(usds.length - 1) / 2]! : Math.round((usds[usds.length / 2 - 1]! + usds[usds.length / 2]!) / 2)) : undefined;
  const moved = entries.find((e) => fin(e.m.changePct24h) !== undefined);
  const byFamily = new Map<string, number>();
  for (const e of entries) {
    const v = fin(e.m.volumeUsd24h);
    if (v !== undefined && v >= 0) byFamily.set(e.r.family, Math.max(byFamily.get(e.r.family) ?? 0, v));
  }
  const vols = [...byFamily.values()];
  const funded = entries.find((e) => fin(e.m.fundingRate) !== undefined);
  const issued = entries.find((e) => typeof e.m.issuer === "string" && e.m.issuer !== "");
  const eligible = entries.find((e) => typeof e.m.eligibility === "string" && e.m.eligibility !== "");
  const unit = usds.length === 1 ? impliedOf(entries.find((e) => impliedOf(e.m) !== undefined)!.m)!.unit : `the median of ${usds.length} venues' implied valuations (each venue's own contract price and unit are on its line)`;
  return {
    key,
    kind: "perp",
    name: title,
    base: key.slice(PRE_IPO_GROUP.length).toUpperCase(),
    // the row's price is the median written in the company's unit: $1 per $1B, or one share for a company its venues price per share
    ...(median !== undefined ? { price: Number((median / (PER_SHARE[key.slice(PRE_IPO_GROUP.length)]?.shares ?? PRE_IPO_PER_POINT)).toFixed(2)), implied: { usd: median, unit } } : {}),
    ...(moved ? { changePct24h: moved.m.changePct24h, changeFrom: { venue: moved.r.id, venueName: lineName(moved.r, moved.m) } } : {}),
    ...(vols.length ? { volumeUsd24h: vols.reduce((s, v) => s + v, 0) } : {}),
    category: PRE_IPO_CATEGORY,
    group: { id: key, title },
    ...(funded ? { fundingRate: funded.m.fundingRate, ...(funded.m.nextFundingAt ? { nextFundingAt: funded.m.nextFundingAt } : {}) } : {}),
    ...(issued ? { issuer: issued.m.issuer } : {}),
    ...(eligible ? { eligibility: eligible.m.eligibility } : {}),
    tabs: ["all", "preipo"],
    at: entries.map((e) => {
      const implied = impliedOf(e.m);
      return { ...atOf(e.r, e.m, e.m.symbol, priceOf(e.m), e.m.open), ...(implied ? { implied } : {}) };
    }),
  };
}

/** an event's row: its legs at every venue folded into its outcomes, YES and NO first. A `pm:`, `kalshi:` or `pmus:` row is one market at
 * one exchange, so a venue the owner connected that lists it trades it already: the public listing of it is left out. Past its close the row
 * and its legs say so (`pastEnd`), and a Kalshi leg is closed (see the top of this file) */
function eventRow(key: string, every: Got[][], now: number): ExploreItem | undefined {
  const order = every.some((l) => l[0]!.r.connected) ? every.filter((l) => l[0]!.r.connected) : every;
  const outcomes = new Map<string, ExploreOutcome>();
  let changeFrom: { venue: string; venueName: string } | undefined;
  const firstLegs = order.flat();
  if (!firstLegs.length) return undefined;
  for (const list of order)
    for (const { r, m } of list) {
      const label = outcomeOf(m);
      const k = label.toLowerCase();
      const row = outcomes.get(k) ?? { label: displayLabel(label), at: [] };
      if (!row.at.some((a) => a.venue === r.id && a.symbol === m.symbol)) row.at.push({ venue: r.id, symbol: m.symbol });
      const p = priceOf(m);
      if (row.price === undefined && p !== undefined) row.price = p;
      if (row.bid === undefined && pos(m.bid) !== undefined) row.bid = m.bid;
      if (row.ask === undefined && pos(m.ask) !== undefined) row.ask = m.ask;
      if (row.change24h === undefined && fin(m.change24h) !== undefined) row.change24h = m.change24h;
      outcomes.set(k, row);
    }
  const rows = [...outcomes.entries()];
  const rank = (k: string) => (k === "yes" ? 0 : k === "no" ? 1 : 2);
  rows.sort((a, b) => rank(a[0]) - rank(b[0]));
  const out = rows.map(([, o]) => o);
  const lead = out[0]!;
  if (lead.change24h !== undefined) {
    const from = firstLegs.find((g) => outcomeOf(g.m).toLowerCase() === lead.label.toLowerCase() && fin(g.m.change24h) !== undefined);
    if (from) changeFrom = { venue: from.r.id, venueName: from.r.name };
  }
  // a market's volume is the market's, whichever leg and whichever venue carries it: every venue here reads the same one market, so it is
  // counted once — the largest figure any of them gives (the public one included, when a connected venue gives none)
  const legs = every.flat();
  const v = Math.max(...legs.map((g) => fin(g.m.volumeUsd24h) ?? -1));
  const c = Math.max(...legs.map((g) => fin(g.m.contracts24h) ?? -1));
  const ev = Math.max(...legs.map((g) => fin((g.m as Listing).eventVolumeUsd24h) ?? -1));
  const usd = v >= 0 ? v : undefined;
  const contracts = c >= 0 ? c : undefined;
  const eventUsd = ev >= 0 ? ev : undefined;
  const g0 = firstLegs[0]!.m;
  const category = firstLegs.map((g) => g.m.category).find((c): c is string => typeof c === "string" && c !== "");
  const closeTime = firstLegs.map((g) => g.m.closeTime).find((c): c is string => typeof c === "string" && c !== "");
  const event = firstLegs.map((g) => g.m.event).find((e) => e !== undefined);
  const past = closeTime !== undefined && closeMs({ closeTime }) <= now;
  return {
    key,
    kind: "event",
    name: groupOf(g0)?.title ?? titleOf(g0),
    ...(lead.price !== undefined ? { price: lead.price } : {}),
    ...(lead.change24h !== undefined ? { change24h: lead.change24h } : {}),
    ...(changeFrom ? { changeFrom } : {}),
    ...(usd !== undefined ? { volumeUsd24h: usd } : {}),
    ...(contracts !== undefined ? { contracts24h: contracts } : {}),
    ...(eventUsd !== undefined ? { eventVolumeUsd24h: eventUsd } : {}),
    ...(category ? { category } : {}),
    ...(closeTime ? { closeTime } : {}),
    ...(past ? { pastEnd: true } : {}),
    ...(event ? { event } : {}),
    outcomes: out,
    tabs: ["all", "predictions"],
    at: order.map((list) => {
      const lead0 = list.find((g) => outcomeOf(g.m).toLowerCase() === lead.label.toLowerCase()) ?? list[0]!;
      const open = list.some((g) => g.m.open === true) ? true : lead0.m.open;
      const line = atOf(lead0.r, lead0.m, lead0.m.symbol, priceOf(lead0.m), past && lead0.r.kalshi ? false : open);
      return past ? { ...line, pastEnd: true } : line;
    }),
  };
}

/** a row matches a query by its own words or by any of its markets' symbols and names at any venue */
const matches = (i: ExploreItem, words: string[], q: string): boolean => [i.name, i.base, i.category, i.event?.title, ...words].some((f) => typeof f === "string" && f.toLowerCase().includes(q));

/** the busier first; rows that trade the same (or report no volume) keep the order they came in, which is each source's own */
const byVolume = (a: ExploreItem, b: ExploreItem): number => volumeOf(b) - volumeOf(a);
const size = (i: ExploreItem): number => (fin(i.changePct24h) !== undefined ? Math.abs(i.changePct24h!) : -1);
const byMove = (a: ExploreItem, b: ExploreItem): number => size(b) - size(a) || byVolume(a, b);
function byClose(now: number): (a: ExploreItem, b: ExploreItem) => number {
  const at = (i: ExploreItem) => {
    const t = closeMs(i);
    return t > now ? t : Number.POSITIVE_INFINITY;
  };
  return (a, b) => at(a) - at(b) || byVolume(a, b);
}

/** one mover per asset: a coin's perpetual is the coin, so where both moved enough the coin's own market is the chip, and the perpetual
 * only where the coin is not among them. A stock and the token that stands for it are two things, and stay two */
function oneEach(movers: Mover[]): Mover[] {
  const asset = (i: Mover): string => (i.kind === "perp" ? `coin:${i.base ?? i.key.slice(i.key.indexOf(":") + 1)}` : i.key);
  const byAsset = new Map<string, Mover>();
  for (const i of movers) {
    const was = byAsset.get(asset(i));
    if (!was || (was.kind === "perp" && i.kind !== "perp")) byAsset.set(asset(i), i);
  }
  return [...byAsset.values()];
}

/** The Predictions rows when nothing is searched for: each venue's event rows by its own volume measure, then the venues in turn — the
 * venue with the busiest row first, its busiest, the next venue's busiest, and so on — at most PREDICTIONS_MAX. A venue is the row's first
 * line (a connected venue before a public one) */
function inTurn(events: ExploreItem[]): ExploreItem[] {
  const byVenue = new Map<string, ExploreItem[]>();
  for (const i of events) {
    const v = i.at[0]?.venue ?? "";
    byVenue.set(v, [...(byVenue.get(v) ?? []), i]);
  }
  const lists = [...byVenue.values()].map((l) => [...l].sort(byVolume)).sort((a, b) => volumeOf(b[0]!) - volumeOf(a[0]!));
  const out: ExploreItem[] = [];
  for (let k = 0; out.length < PREDICTIONS_MAX && lists.some((l) => k < l.length); k++) for (const l of lists) if (k < l.length && out.length < PREDICTIONS_MAX) out.push(l[k]!);
  return out;
}

/** Every market the sources list, as one list of rows, with its tabs, its movers and what closes soon. Every source is asked at once, each
 * inside its own time limit; what failed is in `missing`, with why. See the top of this file for what is one row and what is made of them */
export async function exploreAcross(sources: ExploreSources, opts: ExploreOptions = {}): Promise<Exploration> {
  const clock = opts.clock ?? Date.now;
  const ms = Math.min(pos(opts.timeoutMs) ?? 4_000, MAX_MS);
  const perSource = Math.max(1, Math.floor(pos(opts.perSource) ?? 40));
  const top = Math.max(1, Math.floor(pos(opts.top) ?? 8));
  const limit = Math.max(1, Math.floor(pos(opts.limit) ?? 60));
  const window = pos(opts.closingWithinMs) ?? DAY_MS;
  const q = (opts.q ?? "").trim();
  const floor = (k: Exclude<ExploreKind, "event">): number => (typeof opts.moversMinUsd === "number" ? opts.moversMinUsd : (opts.moversMinUsd?.[k] ?? FLOOR_USD[k]));

  const connected = sources.connected ?? [];
  // a source nothing is ever traded through (Stock Tokens) is the public side of no connection: it is always asked
  const covered = (s: PublicSource) => s.readOnly === undefined && connected.some((v) => v.id === s.connectTo || (v.connector !== undefined && v.connector === s.connector));
  const every = [...connected.map(fromVenue), ...(sources.public ?? []).filter((s) => !covered(s)).map((s) => fromPublic(s, perSource))];
  // the markets listed are the ones of the venues that serve the network the account runs on: the others are not asked, and named once
  const readers = opts.serves ? every.filter((r) => opts.serves!(r)) : every;
  const away = [...new Set(every.filter((r) => !readers.includes(r)).map((r) => r.name))];
  const answers = await Promise.all(readers.map((r) => atSource(r, { q, ms, perSource, closingWithinMs: window })));
  const missing: ExploreMissing[] = answers.flatMap((a) => a.missing);
  const now = clock();

  // every market to its row, and within its row to its venue
  const rows = new Map<string, { kind: ExploreKind; venues: Map<string, Got[]>; words: string[] }>();
  for (const g of answers.flatMap((a) => a.got)) {
    const kind = kindOf(g.m, g.r);
    if (!kind || !inDollars(String(g.m.quote ?? ""))) continue;
    const key = keyOf(g.m, kind, g.r);
    if (!key) continue;
    const row = rows.get(key) ?? { kind, venues: new Map<string, Got[]>(), words: [] };
    if (row.kind !== kind) continue;
    row.venues.set(g.r.id, [...(row.venues.get(g.r.id) ?? []), g]);
    row.words.push(g.m.symbol, g.m.name, String(g.m.base ?? ""));
    rows.set(key, row);
  }
  const made: ExploreItem[] = [];
  for (const [key, row] of rows) {
    const aside: ExploreMissing[] = [];
    const item = rowOf(key, row.kind, row.venues, aside, now);
    if (!item || (q && !matches(item, row.words, q.toLowerCase()))) continue;
    made.push(item);
    missing.push(...aside);
  }
  // Predictions is a few of the busiest when nothing is searched for: the other event rows are not shown anywhere. An event under an
  // excluded category (sports, weather, entertainment, what someone says — categories.ts) is not one of the few, whatever venue lists it,
  // connected or not: the owner asked for a few hot markets, not every bet. A search still finds it, and a position in it is still a position.
  // The IPO questions stay beside the few whatever their volume (the Pre-IPO company drawer names them), after the interleaved rows
  const events = made.filter((i) => i.kind === "event" && !isExcludedCategory([i.category]));
  const ipo = events.filter((i) => isIpoCategory([i.category]));
  const curated = q ? undefined : [...inTurn(events.filter((i) => !ipo.includes(i))), ...ipo.sort(byVolume)];
  const kept = curated ? new Set(curated) : undefined;
  const all = kept ? made.filter((i) => i.kind !== "event" || kept.has(i)) : made;
  const notes = [...new Set(answers.flatMap((a) => a.notes))];
  if (away.length) notes.push(awayNote(away));
  if (curated?.length) notes.push(`Predictions: at most ${PREDICTIONS_MAX} rows, each venue's busiest in turn, without sports, weather and entertainment; a search reaches everything the venues' listings loaded.`);
  if (curated && ipo.length) notes.push("Predictions: and the IPO questions at Kalshi and Polymarket, beside the busiest few.");
  if (all.some((i) => i.tabs.includes("preipo"))) notes.push("Pre-IPO perpetuals are contracts on a venue's estimate of a private company's valuation, not shares; each venue says who may trade them once a key connects.");

  const traded = all.filter((i) => i.kind !== "event" && i.volumeUsd24h !== undefined).sort(byVolume);
  const movers = oneEach(all.filter((i): i is Mover => i.kind !== "event" && fin(i.changePct24h) !== undefined && (i.volumeUsd24h ?? -1) >= floor(i.kind as Exclude<ExploreKind, "event">))).sort(byMove).slice(0, top);
  const soon = all.filter((i) => i.kind === "event" && closeMs(i) > now && closeMs(i) <= now + window).sort(byVolume).slice(0, top);
  const closing = [...soon].sort(byClose(now));
  const mostTraded = traded.slice(0, top);

  // All holds every row (each row's tabs start with it), so every tab's count is the rows that carry it
  const tabs = TABS.map((t) => ({ id: t.id, label: t.label, count: all.filter((i) => i.tabs.includes(t.id)).length })).filter((t) => t.count > 0);
  const sorter = opts.sort === "movers" ? byMove : opts.sort === "closing" ? byClose(now) : byVolume;
  // the curated Predictions list keeps its own order (the venues in turn, then the IPO questions), unless a sort is asked for
  const chosen = opts.tab === "predictions" && curated && !opts.sort ? curated : (opts.tab && opts.tab !== "all" ? all.filter((i) => i.tabs.includes(opts.tab!)) : all).sort(sorter);
  return { asOf: new Date(now).toISOString(), tabs, items: chosen.slice(0, limit), movers, closing, mostTraded, missing: dedupe(missing), notes };
}
