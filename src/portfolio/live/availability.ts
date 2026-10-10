/** WHERE THIS USER CAN CONNECT — detected from the network the Account runs on, for every venue it knows, without the owner opening
 * anything: the page's list of accounts, its Markets and Trade buttons, and the agents (MCP portfolio_venues, portfolio_account) all read
 * the same answer. Two things decide it, both the venue's:
 *
 *   its answer to this network   each connection's own first, keyless question (live/reach.ts): an exchange's public clock, a broker's
 *                                keyless GET, Polymarket's location check, Robinhood's sign-in discovery, mm on this machine. A venue
 *                                that refuses this IP says so in its own words
 *   its own terms                the residency rule the venue publishes (live/eligibility.ts), matched to where this network is
 *                                (live/location.ts). Shown, never enforced: the venue's own sign-up checks residency, and a venue whose
 *                                terms exclude the user may still answer this network
 *
 * Where the network is, is used for this matching in memory and is never returned, logged or kept: the answer says only what applies.
 *
 * A venue that cannot be used from here may have an EDITION for where the user is: a separate company, under its own terms, with its own
 * accounts and API (Polymarket US, QCX LLC, for Polymarket). When the venue refuses this network, lets it only close, or its terms exclude
 * the place, its edition is named beside it — only when the edition itself answers this network (connectable: its terms do not exclude the
 * place either) and its own words say it is for the place (EDITIONS: the edition's page, quoted, with the places it names). An edition that
 * says nothing of whom it is for, or is for elsewhere, is never offered. What every one of these is decided from is the user's own network, at the moment it is asked: nothing a builder's machine was
 * answered is in it.
 *
 * Verdicts: connectable · not-served (the venue refuses this network) · close-only (the venue lets this network close positions and open
 * none — Polymarket's rule for the United States and other places: connecting reads what is held, and it can be sold) · terms-exclude (the
 * venue answers here, but its own terms exclude where the user is) · setup (something on this machine first: mm installed, mm signed in) · closed (the venue offers no way in for this
 * account) · no-answer (it did not answer just now; connecting asks again). The connections read by address (a watched wallet, a
 * Hyperliquid or Polymarket account by its address, OUSG) are asked like the rest — a network may refuse or filter the host they read
 * (Ukraine's order to block polymarket.com) — and are never judged by terms: what they read is public, read only. A connection nothing
 * answered for carries no `asked` time: the list's own time is not an answer.
 */
import { servesPlace } from "./eligibility.ts";
import type { Reach } from "./reach.ts";

export type Verdict = "connectable" | "not-served" | "close-only" | "terms-exclude" | "setup" | "closed" | "no-answer";

/** a venue's own residency rule, as the eligibility table holds it (live/eligibility.ts) */
export interface TermsLine {
  url: string;
  read: string;
  says: string;
  /** one plain sentence the table keeps with it (a separate company that serves a place the venue excludes, under its own terms) */
  note?: string | undefined;
  via?: string | undefined;
  unread?: string | undefined;
}

export interface VenueHere {
  /** the connection, as connectVenue takes it: `live:exchange:okx`, `live:kalshi` */
  connector: string;
  name: string;
  /** what kind of account it is, as the page groups them */
  group: "Exchanges" | "Brokers" | "Wallets" | "Markets and tokens";
  /** how it is connected: a key file, the venue's own sign-in, an address, the mm command line */
  needs: "key-file" | "sign-in" | "address" | "cli";
  verdict: Verdict;
  /** the venue's own words when it is not connectable: its answer to this network, or its terms */
  said?: string | undefined;
  /** the venue's published residency rule, when the table has it: always given, so its words can be read whatever the verdict */
  terms?: (TermsLine & { excludesHere?: boolean | undefined; servesHere?: boolean | undefined }) | undefined;
  /** already on the account: read, or connected and waiting for the venue to answer this network (`waiting`) */
  connected: boolean;
  /** the owner has connected it and the venue has not answered this network yet: why, and when it is asked again (service.ts waiting) */
  waiting?: string | undefined;
  /** read by address: it reads, it trades nothing */
  readOnly?: boolean | undefined;
  /** this venue cannot be used from here, and its edition for where the user is can: a separate company that answers this network and
   * whose own terms serve the place */
  edition?: { connector: string; name: string; said: string } | undefined;
  /** when the venue was asked (ISO); absent when nothing answered for it */
  asked?: string | undefined;
}

/** the exchanges asked by default: the tiles of Connect an account, the venues Markets reads, the pre-IPO venues, and a few well-known
 * others (Binance.US among them: the company that serves US persons under its own terms) */
export const KNOWN_EXCHANGES = ["okx", "okxus", "kraken", "coinbase", "bybit", "binance", "binanceus", "kucoin", "gate", "bitget", "mexc", "deribit", "krakenfutures", "kucoinfutures", "cryptocom", "gemini", "bitstamp", "bitfinex", "htx"];

/** an edition, and its own words for whom it is for */
export interface Edition {
  /** the edition's connection */
  connector: string;
  /** the places its page says it is for: ISO 3166-1 alpha-2, or ISO 3166-2 for a part */
  serves: string[];
  url: string;
  says: string;
  read: string;
}
/** each venue's editions for other places, by connection: separate companies under their own terms, with their own accounts and API.
 * Only what the companies' own pages say; an edition the account does not connect is not here */
export const EDITIONS: Record<string, Edition[]> = {
  // Binance.US (BAM Trading Services Inc.): its own list of the states and regions it serves (updated June 3, 2026)
  "live:exchange:binance": [{ connector: "live:exchange:binanceus", serves: ["US-AL", "US-AZ", "US-AR", "US-CA", "US-CO", "US-DE", "US-DC", "US-FL", "US-HI", "US-ID", "US-IL", "US-IN", "US-IA", "US-KS", "US-KY", "US-LA", "US-MD", "US-MA", "US-MI", "US-MN", "US-MS", "US-MO", "US-MT", "US-NE", "US-NV", "US-NH", "US-NJ", "US-NM", "US-OK", "US-PA", "US-RI", "US-SC", "US-SD", "US-TN", "US-UT", "US-VA", "US-WV", "US-WI", "US-WY", "PR"], url: "https://support.binance.us/en/articles/9842798-list-of-supported-and-unsupported-states-and-regions", says: "This article includes all of the states and regions where Binance.US services are available.", read: "2026-10-08" }],
  // OKX US (OKX INC.): "The OKX digital asset trading platform for United States customers is provided by OKX INC.", for the places it lists a
  // licence or registration for (its US licences page, updated September 15, 2026); a US account's key works at us.okx.com only
  "live:exchange:okx": [{ connector: "live:exchange:okxus", serves: ["US-AL", "US-AK", "US-AZ", "US-AR", "US-CO", "US-CT", "US-DE", "US-DC", "US-FL", "US-GA", "US-ID", "US-IL", "US-IN", "US-IA", "US-KS", "US-KY", "US-LA", "US-ME", "US-MD", "US-MI", "US-MN", "US-MS", "US-MO", "US-NE", "US-NV", "US-NH", "US-NJ", "US-NM", "US-NC", "US-ND", "US-OH", "US-OK", "US-OR", "US-PA", "US-RI", "US-SC", "US-SD", "US-TN", "US-TX", "US-VT", "US-VA", "US-WA", "US-WV", "US-WI", "PR"], url: "https://www.okx.com/en-us/help/us-licenses", says: "The OKX digital asset trading platform for United States customers is provided by OKX INC.", read: "2026-10-08" }],
  // Polymarket US (QCX LLC, a CFTC-designated contract market): "Fiat-based, CFTC-regulated exchange. Trades in USD. Built for US residents."
  "live:polymarket-trade": [{ connector: "live:polymarket-us", serves: ["US"], url: "https://docs.polymarket.us/getting-started/what-is-polymarket-us", says: "Built for US residents.", read: "2026-10-08" }],
};

export interface AvailabilityDeps {
  /** every connection to ask, with its name, group and way in */
  connections: Array<{ connector: string; name: string; group: VenueHere["group"]; needs: VenueHere["needs"] }>;
  /** each connection's own first question (live/reach.ts, kept by the service) */
  reach: (connectors: string[]) => Promise<Reach[]>;
  /** the venue's published residency rule for a connection, whether it excludes the place (true · false · undefined: unknown), and — for
   * a venue whose terms name the places it serves — whether they serve it */
  terms?: ((connector: string, place: { country?: string | undefined; region?: string | undefined } | undefined) => (TermsLine & { excludesHere?: boolean | undefined; servesHere?: boolean | undefined }) | undefined) | undefined;
  /** where this network is — in memory only; undefined when it cannot be learned */
  place?: (() => Promise<{ country?: string | undefined; region?: string | undefined } | undefined>) | undefined;
  /** the connections already on the account */
  connected: (connector: string) => boolean;
  /** a connection the owner made whose venue has not answered this network yet: why it waits (nothing when it is not waiting) */
  waiting?: ((connector: string) => string | undefined) | undefined;
  clock: () => number;
  /** the editions to offer (EDITIONS unless a test gives its own) */
  editions?: Record<string, Edition[]> | undefined;
}

/** the verdict for one connection from its venue's answer and its terms */
export function verdictOf(r: Reach | undefined, terms: (TermsLine & { excludesHere?: boolean | undefined }) | undefined, needs: VenueHere["needs"]): { verdict: Verdict; said?: string | undefined } {
  if (r && r.state === "location") return { verdict: "not-served", said: r.said };
  if (r && r.state === "close-only") return { verdict: "close-only", said: r.said };
  if (r && r.state === "setup") return { verdict: "setup", said: r.said };
  if (r && r.state === "closed") return { verdict: "closed", said: r.said };
  if (r && r.state === "unreachable") return { verdict: "no-answer", said: r.said };
  // read by address: public data, never judged by terms (the venue's answer to this network, above, still decides)
  if (needs === "address") return { verdict: "connectable" };
  if (terms && terms.excludesHere === true) return { verdict: "terms-exclude", said: `its terms exclude where you are (${terms.url}, read ${terms.read}): “${terms.says}” — the venue checks residency when an account is opened; the account does not${terms.note ? `. ${terms.note}` : ""}` };
  return { verdict: "connectable" };
}

/** every connection, asked now (or from what the service kept), with its verdict — and, beside a venue that cannot be used from here, its
 * edition for the place when there is one that can */
export async function venuesHere(d: AvailabilityDeps): Promise<VenueHere[]> {
  const place = d.place ? await d.place().catch(() => undefined) : undefined;
  // every connection, the ones read by address too: the host they read answers this network, or it does not
  const answers = await d.reach(d.connections.map((c) => c.connector));
  const byConnector = new Map(answers.map((r) => [r.connector, r]));
  const out: VenueHere[] = d.connections.map((c) => {
    const r = byConnector.get(c.connector);
    const terms = d.terms?.(c.connector, place);
    const v = verdictOf(r, terms, c.needs);
    const waiting = d.waiting?.(c.connector);
    return {
      connector: c.connector,
      name: c.name,
      group: c.group,
      needs: c.needs,
      verdict: v.verdict,
      ...(v.said ? { said: v.said } : {}),
      ...(terms ? { terms } : {}),
      connected: d.connected(c.connector) || waiting !== undefined,
      ...(waiting !== undefined ? { waiting } : {}),
      ...(c.needs === "address" ? { readOnly: true } : {}),
      ...(r?.at ? { asked: r.at } : {}),
    };
  });
  const judged = new Map(out.map((v) => [v.connector, v]));
  for (const v of out) {
    if (v.verdict !== "not-served" && v.verdict !== "close-only" && v.verdict !== "terms-exclude") continue;
    // the first edition that can be connected from here and whose own words say it is for the place: a place merely not excluded is not enough
    for (const ed of (d.editions ?? EDITIONS)[v.connector] ?? []) {
      const x = judged.get(ed.connector);
      if (!x || x.verdict !== "connectable" || servesPlace(ed.serves, place) !== true) continue;
      v.edition = { connector: x.connector, name: x.name, said: `${x.name} is for where you are, in its own words: “${ed.says}” (${ed.url}, read ${ed.read}). A separate company, with its own account and API keys` };
      break;
    }
  }
  return out;
}
