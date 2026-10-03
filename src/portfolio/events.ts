/** Prediction markets: event contracts.
 *
 * A contract is a question with a close date. One share of an outcome settles
 * at $1 if that outcome happens and at $0 if it does not, so its price is a
 * number in [0, 1] that reads as a probability, and it trades on an order book.
 * The same question can list on more than one venue — here Polymarket (a CLOB
 * on Polygon, funded in pUSD, reached through the MetaMask wallet's
 * `mm predict`) and Kalshi (a CFTC-regulated exchange, funded in USD by ACH) —
 * at different prices, with different depth, different fees and different
 * RULES: two venues can settle "the same" question differently.
 *
 * This file is the catalogue and the book arithmetic. venues.ts turns it into
 * fills and routes an order across the venues like any other order.
 *
 * Illustrative numbers, real shapes. The December rate-decision market mirrors
 * a real Polymarket market as it stood at build time (0.73 / 0.74, tick 0.01,
 * minimum order 5 shares, a taker fee shaped like its `feeSchedule`:
 * rate × p × (1 − p) per share). Kalshi's fee is its published
 * 0.07 × C × P × (1 − P), rounded up to the cent. Tickers and depth are made up.
 * Books are stateless: a fill does not move them.
 */
export type Outcome = "YES" | "NO";
export type EventState = "open" | "awaiting" | "resolved";

export interface Level {
  price: number;
  size: number;
}

export interface EventListing {
  ticker: string;
  /** the YES book: asks cheapest first, bids highest first. The NO book is its mirror — a NO ask at 1 − p for every YES bid at p. */
  asks: Level[];
  bids: Level[];
  /** how this venue decides the outcome */
  rules: string;
  /** the real market this listing mirrors, for live reads through `mm predict` */
  realSlug?: string;
}

export interface EventMarket {
  id: string;
  title: string;
  /** words a person would use for it; the page agent matches on these */
  keywords: string[];
  closesAt: string;
  /** set once the question is settled */
  resolved?: Outcome;
  /** what the sim values a YES share at */
  markYes: number;
  listings: Record<string, EventListing>;
}

export interface PredictionVenue {
  name: string;
  /** what the venue is funded in */
  quote: string;
  /** taker fee: feeRate × p × (1 − p) per share */
  feeRate: number;
  /** Kalshi rounds a trade's fee up to the next cent */
  feeCeilCents: boolean;
  minOrder: number;
  /** whole contracts only */
  integerOnly: boolean;
}

export const PREDICTION_VENUES: Record<string, PredictionVenue> = {
  polymarket: { name: "Polymarket", quote: "pUSD", feeRate: 0.05, feeCeilCents: false, minOrder: 5, integerOnly: false },
  kalshi: { name: "Kalshi", quote: "USD", feeRate: 0.07, feeCeilCents: true, minOrder: 1, integerOnly: true },
};

export const EVENTS: EventMarket[] = [
  {
    id: "FED-DEC-HIKE25",
    title: "Fed hikes 25 bps in December",
    keywords: ["fed", "hike", "rate", "加息"],
    closesAt: "2026-12-09T23:59:00Z",
    markYes: 0.735,
    listings: {
      polymarket: {
        ticker: "fed-increase-25-bps-december-2026",
        asks: [{ price: 0.74, size: 700 }, { price: 0.75, size: 2500 }, { price: 0.76, size: 6000 }],
        bids: [{ price: 0.73, size: 600 }, { price: 0.72, size: 1800 }, { price: 0.71, size: 5000 }],
        rules: "UMA's optimistic oracle",
        realSlug: "will-the-fed-increase-interest-rates-by-25-bps-after-the-december-2026-meeting-20260729232808636",
      },
      kalshi: {
        ticker: "KXFEDDECISION-26DEC-H25",
        asks: [{ price: 0.73, size: 400 }, { price: 0.75, size: 3000 }, { price: 0.76, size: 4000 }],
        bids: [{ price: 0.72, size: 500 }, { price: 0.71, size: 2000 }],
        rules: "its own rulebook",
      },
    },
  },
  {
    // past its close, not settled yet: the price here is not odds (a resolution can still surprise), so an order needs a human
    id: "GOV-SHUTDOWN-OCT1",
    title: "US government shutdown by October 1",
    keywords: ["shutdown", "关门"],
    closesAt: "2026-10-01T04:00:00Z",
    markYes: 0.96,
    listings: {
      polymarket: {
        ticker: "us-government-shutdown-by-october-1-2026",
        asks: [{ price: 0.97, size: 5000 }, { price: 0.98, size: 8000 }],
        bids: [{ price: 0.95, size: 2000 }],
        rules: "UMA's optimistic oracle",
      },
    },
  },
  {
    // settled: winning shares wait to be redeemed at $1
    id: "FED-SEP-HOLD",
    title: "Fed holds rates in September",
    keywords: ["september", "hold"],
    closesAt: "2026-09-16T23:59:00Z",
    resolved: "YES",
    markYes: 1,
    listings: { polymarket: { ticker: "fed-no-change-september-2026", asks: [], bids: [], rules: "UMA's optimistic oracle" } },
  },
];

/** `FED-DEC-HIKE25:YES` */
export const isEventSymbol = (symbol: string): boolean => /:(YES|NO)$/.test(symbol);
export const eventSymbol = (id: string, outcome: Outcome): string => `${id}:${outcome}`;

export function parseEventSymbol(symbol: string): { event: EventMarket; outcome: Outcome } | undefined {
  const m = /^(.+):(YES|NO)$/.exec(symbol);
  const event = m ? EVENTS.find((e) => e.id === m[1]) : undefined;
  return event && m ? { event, outcome: m[2] as Outcome } : undefined;
}

export function eventState(e: EventMarket, now: string): EventState {
  if (e.resolved !== undefined) return "resolved";
  return Date.parse(now) >= Date.parse(e.closesAt) ? "awaiting" : "open";
}

/** what one share is worth in the sim: the mark, or $1 / $0 once settled */
export function eventMark(symbol: string): number | undefined {
  const p = parseEventSymbol(symbol);
  if (!p) return undefined;
  if (p.event.resolved !== undefined) return p.event.resolved === p.outcome ? 1 : 0;
  return Number((p.outcome === "YES" ? p.event.markYes : 1 - p.event.markYes).toFixed(4));
}

/** `Fed hikes 25 bps in December · YES` */
export function eventLabel(symbol: string): string {
  const p = parseEventSymbol(symbol);
  return p ? `${p.event.title} · ${p.outcome}` : symbol;
}

/** the event a sentence is about, by its id or one of its keywords */
export function findEvent(text: string): EventMarket | undefined {
  const t = text.toLowerCase();
  return EVENTS.find((e) => t.includes(e.id.toLowerCase())) ?? EVENTS.find((e) => e.keywords.some((k) => t.includes(k)));
}

const mirror = (levels: Level[]): Level[] => levels.map((l) => ({ price: Number((1 - l.price).toFixed(4)), size: l.size }));

/** the levels a taker walks: a buy lifts asks cheapest first, a sell hits bids highest first */
export function levelsFor(venue: string, symbol: string, side: "buy" | "sell"): Level[] | undefined {
  const p = parseEventSymbol(symbol);
  const listing = p?.event.listings[venue];
  if (!p || !listing) return undefined;
  if (p.outcome === "YES") return side === "buy" ? listing.asks : listing.bids;
  return side === "buy" ? mirror(listing.bids) : mirror(listing.asks);
}

export interface RawEvent {
  /** shares × the prices they filled at, before the fee */
  gross: number;
  fee: number;
  /** the best price on that side of the book */
  best: number;
}

/** walk the book for `qty` shares; nothing comes back when the venue does not list it or the book is not that deep */
export function rawEvent(venue: string, symbol: string, side: "buy" | "sell", qty: number): RawEvent | undefined {
  const v = PREDICTION_VENUES[venue];
  const levels = levelsFor(venue, symbol, side);
  if (!v || !levels?.length || !(qty > 0)) return undefined;
  let left = qty;
  let gross = 0;
  let fee = 0;
  for (const l of levels) {
    const take = Math.min(left, l.size);
    gross += take * l.price;
    fee += v.feeRate * l.price * (1 - l.price) * take;
    left -= take;
    if (left <= 1e-9) return { gross, fee, best: levels[0]!.price };
  }
  return undefined;
}

export interface EventTop {
  bid?: number | undefined;
  ask?: number | undefined;
  bidSize?: number | undefined;
  askSize?: number | undefined;
}

export function eventTop(venue: string, symbol: string): EventTop {
  const ask = levelsFor(venue, symbol, "buy")?.[0];
  const bid = levelsFor(venue, symbol, "sell")?.[0];
  return { bid: bid?.price, ask: ask?.price, bidSize: bid?.size, askSize: ask?.size };
}
