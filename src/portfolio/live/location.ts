/** WHERE THIS USER IS, for a venue whose rule about places is written in its terms rather than only kept at its own servers: Hyperliquid's
 * Terms of Use say who may not use it, whatever its API answers a given network (that answer is the venue's own too, and is asked of it
 * where it matters: reach.ts, hyperliquid-trade.ts). The account holds each user to that rule at the place the user is in
 * at the time — the machine the account runs on, which is the user's own — and never at any place written into this code.
 *
 *   GET polymarket.com/api/geoblock   Polymarket's public location check (POLYMARKET_GEOBLOCK, polymarket-clob.ts), the same oracle
 *                                     `mm predict geoblock` asks: {blocked, ip, country, region}, looked up from the address this machine
 *                                     sends from (its shape checked live 2026-10-08). Asked directly over HTTP, with no key, no cookie and
 *                                     nothing about the user. Only `country` (ISO 3166-1 alpha-2) and `region` (its subdivision code) are
 *                                     read. Polymarket's own verdict (`blocked`) is Polymarket's rule, not the venue's, and is not read; nor
 *                                     is the address.
 *
 *   GET www.cloudflare.com/cdn-cgi/trace and 1.1.1.1/cdn-cgi/trace   asked only when Polymarket gives no place — in a country whose
 *                                     networks block Polymarket itself, the users a venue DOES serve must not be refused for that: Cloudflare's
 *                                     public trace page, lines of key=value, of which only `loc` (the country, ISO 3166-1 alpha-2) is read; the
 *                                     address on the same page is not. It gives no subdivision.
 *
 *   GET ipapi.co/json/                asked only when a rule closes PART of the country the trace gave and no subdivision is known: Ukraine
 *                                     ordered its providers to block polymarket.com from 12 January 2026, and a user in Kyiv whom Hyperliquid
 *                                     serves must not be refused because only Crimea, Donetsk and Luhansk are closed and the trace cannot say
 *                                     which part of Ukraine this is. Its keyless lookup: only `country_code` and `region_code` (ISO 3166-2) are
 *                                     read, and its country must be the one already learned. Without it the place is "not known" there rather
 *                                     than "served". It answers a client that gives no name of its own with 429 every time, so the account
 *                                     names itself as it does elsewhere (`agent-account/1`, guarded-http.ts) — its own name, nobody else's.
 *
 * A code that names no place — Cloudflare's XX (an address it cannot place) and T1 (Tor), read as polymarket-clob.ts reads them
 * (readablePlace) — is not a place, whichever source gave it. A US outlying area is one place however it is spelled (PR, or the US region
 * PR): it is held as its own country, as eligibility.ts matches the terms, so that no verdict turns on the spelling.
 *
 * The place is used for the one decision it was asked for, in memory, and kept at most ten minutes so that a burst of orders asks once — a
 * place from the trace alone (Polymarket not answering) twenty seconds, so that Polymarket is asked again soon; and an order or a leverage
 * change asks again (one asked in the last few seconds is used), so that a machine that moved to another network is judged where it is now,
 * not where it was. It is never logged, written, put in a refusal or returned in an answer: what leaves this file is the venue's rule and a
 * verdict — served, closed, or not known — and, for the account's own matching of the venues' published terms (availability.ts holding eligibility.ts's
 * lists to it), the place itself, in memory, for that one answer. A place that cannot be learned (no answer, an answer without a country) is not taken for a yes: the rule refuses, as the MetaMask
 * Agent Wallet's mm perps path does (metamask.ts). Nothing here can be told to skip the rule, and nothing here looks for another way in.
 *
 * Hyperliquid's rule — its Terms of Use, "Last updated on June 15, 2026", read 2026-10-08 at app.hyperliquid.xyz/terms (the page's
 * TermsOfUse script): §1.6 opens with "The Interface is not available to “Restricted Persons.”", and counts among them persons who reside
 * in, are located in, are incorporated in or have a registered office in the United States of America or Ontario, Canada, or in a
 * jurisdiction under economic and trade sanctions or export controls ("Restricted Territories"), and citizens of Restricted Territories
 * wherever they are. The terms do not list the sanctioned territories: the ones held here are those under comprehensive sanctions (ISO 3166:
 * Cuba, Iran, North Korea, Syria, and Crimea, Sevastopol, Donetsk and Luhansk). A machine can tell where it is now; where its user lives
 * and which citizenship they hold is the user's own to answer, as Hyperliquid's terms ask of them.
 */
import { no } from "../refuse.ts";
import type { Refusal } from "../../core/errors.ts";
import { POLYMARKET_GEOBLOCK, readablePlace } from "./polymarket-clob.ts";
import type { Http, HttpReply } from "./types.ts";

/** Hyperliquid's own line: its Terms of Use §1.6 closes the venue to persons located in the United States of America or Ontario, Canada, and
 * in territories under economic sanctions. The sanctioned territories are not listed there; these are the ones under comprehensive
 * sanctions (ISO 3166: Cuba, Iran, North Korea, Syria, and Crimea, Sevastopol, Donetsk and Luhansk). Moved here from metamask.ts, whose mm
 * perps path holds the place `mm predict geoblock` names to the same two lists */
// the United States of America read with its territories (Puerto Rico, Guam, the US Virgin Islands, American Samoa, the Northern Mariana
// Islands, the minor outlying islands): the account's own reading of "located in the United States", the stricter one — a place a source
// spells as US-PR or as PR gets the same verdict either way
export const HL_CLOSED = { countries: new Set(["US", "AS", "GU", "MP", "PR", "UM", "VI", "CU", "IR", "KP", "SY"]), regions: new Set(["CA-ON", "UA-43", "UA-40", "UA-14", "UA-09"]) };
export const HL_TERMS = "Hyperliquid's Terms of Use §1.6: the Interface is not available to persons located in the United States, Ontario, or a sanctioned territory";

/** a venue's rule about places, as its terms write it */
export interface PlaceRule {
  /** the venue's name, for the sentences */
  name: string;
  /** where the rule is written and what it says, in one line (carried in a refusal's `native`) */
  terms: string;
  /** where it is written, for a sentence: "its Terms of Use §1.6" */
  cite: string;
  /** the refusal's sentence when the rule closes the place: the venue's own words, and nothing about the place itself */
  closedWords: string;
  /** does the rule close this place: a country (ISO 3166-1 alpha-2) and the subdivision code the oracle gives with it */
  closes(country: string, region: string): boolean;
  /** the rule closes part of this country: without the subdivision the place cannot be judged (CA: Ontario) */
  splits?(country: string): boolean;
}

/** a subdivision as the lists hold it, `CA-ON`: the oracle's region code after the country, unless it already carries the country */
const subdivision = (country: string, region: string): string => (region.startsWith(`${country}-`) ? region : `${country}-${region}`);

export const HYPERLIQUID_RULE: PlaceRule = {
  name: "Hyperliquid",
  terms: HL_TERMS,
  cite: "its Terms of Use §1.6",
  closedWords: "Hyperliquid does not serve this location: its Terms of Use (§1.6) make its Interface unavailable to persons located in the United States of America or Ontario, Canada, or in a territory under economic sanctions. That is its own rule, and the account does not look for a way around it",
  closes: (country, region) => HL_CLOSED.countries.has(country) || (region !== "" && HL_CLOSED.regions.has(subdivision(country, region))),
  splits: (country) => [...HL_CLOSED.regions].some((r) => r.startsWith(`${country}-`)),
};

/** served · closed by the rule · not known now (and so not served) */
export type Verdict = "served" | "closed" | "unknown";

/** what a decision asks of the place */
export interface PlaceAsk {
  /** a write about to be signed (an order, a leverage change): the place is asked again — one asked in the last few seconds (WRITE_MS) is
   * used, so that a burst asks once — and never taken from minutes ago, when the machine may have been on another network */
  fresh?: boolean | undefined;
  /** the country another source named for this machine (mm's `predict geoblock`, which gave no part of it): judged only when the place
   * learned here is in that same country and its part is known; another country, or no part, is "not known" — never a verdict for a
   * country the other source did not name */
  country?: string | undefined;
}

/** a user's place, asked of the oracle for each decision, kept at most ten minutes */
export interface Locator {
  verdict(rule: PlaceRule, ask?: PlaceAsk): Promise<Verdict>;
  /** the place itself, for the account's matching of the venues' published terms in memory (availability.ts): never logged, written, or
   * put in an answer; undefined when it cannot be learned now. `splits`: the lists in use name parts of this country (US states for an
   * edition, Ontario), so a place with no part is given its part from the subdivision lookup, when that answers for the same country */
  place(fill?: { splits?: ((country: string) => boolean) | undefined }): Promise<{ country: string; region: string } | undefined>;
  /** why the last verdict was "not known", for the sentence — no place at all, the part of a country a rule closes in part, or a network
   * whose address the sources answered with no place (XX, T1: an anonymising network, an address they cannot place) — and nothing about the
   * place itself */
  missing?(): "place" | "part" | "unplaceable" | undefined;
}

/** the second and third place to ask, when Polymarket gives no place: Cloudflare's public trace, on two hosts */
export const TRACE = ["https://www.cloudflare.com/cdn-cgi/trace", "https://1.1.1.1/cdn-cgi/trace"];
/** the last, for the part of a country a rule closes in part, when nothing above gave it */
export const SUBDIVISION = "https://ipapi.co/json/";
/** the account's own name, as it gives it to a service that answers no client without one (the one guarded-http.ts sends) */
export const AGENT_NAME = "agent-account/1";
/** the longest a place is kept */
export const PLACE_MS = 10 * 60_000;
/** a place from Cloudflare's trace alone — Polymarket gave none, and the trace gives no part of the country — is kept this long: Polymarket
 * is asked again soon rather than ten minutes on */
export const TRACE_MS = 20_000;
/** a write asks the place again; one asked this recently is used */
export const WRITE_MS = 5_000;
/** a subdivision lookup that did not answer is not asked again for this long: a burst of orders asks it once */
const PART_MISS_MS = 20_000;
/** the oracle answers in this long, or the place is not known now */
const ASK_MS = 6_000;

/** the outlying areas of the United States: each a country of its own in ISO 3166-1, and a US region in ISO 3166-2:US (eligibility.ts
 * holds the published terms to the same set) */
const US_AREAS = new Set(["AS", "GU", "MP", "PR", "UM", "VI"]);
/** One place, one spelling: a US outlying area given as the US region it also is (US with PR or US-PR) is held as its own country (PR), as
 * eligibility.ts matches the terms — so that a rule's verdict never turns on how a source spelled the place */
export function placeOf(country: string, region: string): { country: string; region: string } {
  const part = region.startsWith(`${country}-`) ? region.slice(country.length + 1) : region;
  return country === "US" && US_AREAS.has(part) ? { country: part, region: "" } : { country, region };
}

type Learned = { country: string; region: string; from: "polymarket" | "trace" };

/** One user's place: Polymarket's location check asked with no key, its country and region read and nothing else, kept in this closure at
 * most ten minutes (a place from the trace alone, twenty seconds). A place not learned is not kept: the next decision asks again */
export function locator(deps: { http: Http; clock: () => number; timeoutMs?: number | undefined }): Locator {
  let kept: (Learned & { at: number; until: number }) | undefined;
  let asking: Promise<Learned | undefined> | undefined;
  let partAsking: { country: string; p: Promise<string> } | undefined;
  let partMissed: { country: string; until: number } | undefined;
  // the part last learned, kept ten minutes for its country: a write asks the place afresh, and a fresh answer with the country alone (the
  // trace's, or Polymarket's without a region) must not send every order to the part's lookup again — that service limits how often it is
  // asked, and an order refused for "part not known" because of it would be the account's doing
  let partKnown: { country: string; region: string; until: number } | undefined;
  let missing: "place" | "part" | "unplaceable" | undefined;
  // the place is dropped when its time is up even when nothing asks again (a timer that keeps nothing alive)
  let drop: ReturnType<typeof setTimeout> | undefined;
  const forget = (): void => {
    kept = undefined;
    if (drop) clearTimeout(drop);
    drop = undefined;
  };
  const keep = (got: Learned, ms: number): void => {
    forget();
    const at = deps.clock();
    kept = { ...got, at, until: at + ms };
    drop = setTimeout(forget, ms);
    (drop as { unref?: () => void }).unref?.();
  };
  // a source answered, and named no place (XX, T1): this network's address is not placed, which asking again on the same network does not
  // change — remembered as long as a place would be, unlike a source that did not answer
  let unplaced = false;
  let blank: { at: number; until: number } | undefined;
  const polymarket = async (): Promise<Learned | undefined> => {
    let r: HttpReply;
    try {
      r = await deps.http(POLYMARKET_GEOBLOCK, { headers: { accept: "application/json" }, timeoutMs: deps.timeoutMs ?? ASK_MS });
    } catch {
      return undefined;
    }
    const b = r.body;
    if (r.status !== 200 || b === null || typeof b !== "object" || Array.isArray(b)) return undefined;
    const country = typeof (b as { country?: unknown }).country === "string" ? (b as { country: string }).country.trim().toUpperCase() : "";
    const region = typeof (b as { region?: unknown }).region === "string" ? (b as { region: string }).region.trim().toUpperCase() : "";
    // Polymarket sits behind Cloudflare, and passes on its XX for an address it cannot place: no place, so the trace is asked
    if (!readablePlace(country)) {
      if (country) unplaced = true;
      return undefined;
    }
    return { ...placeOf(country, /^[A-Z0-9-]{1,12}$/.test(region) ? region : ""), from: "polymarket" };
  };
  // Cloudflare's trace: only `loc`, the country; no subdivision (region "")
  const cloudflare = async (url: string): Promise<Learned | undefined> => {
    let r: HttpReply;
    try {
      r = await deps.http(url, { headers: { accept: "text/plain" }, timeoutMs: deps.timeoutMs ?? ASK_MS });
    } catch {
      return undefined;
    }
    if (r.status !== 200) return undefined;
    const loc = /^loc=([A-Za-z]{2})\s*$/m.exec(String(r.text ?? ""));
    const country = loc ? loc[1]!.toUpperCase() : "";
    if (country && !readablePlace(country)) unplaced = true;
    return readablePlace(country) ? { country, region: "", from: "trace" } : undefined;
  };
  const ask = async (): Promise<Learned | undefined> => {
    unplaced = false;
    const got = (await polymarket()) ?? (await cloudflare(TRACE[0]!)) ?? (await cloudflare(TRACE[1]!));
    const now = deps.clock();
    blank = !got && unplaced ? { at: now, until: now + PLACE_MS } : undefined;
    return got;
  };
  const place = async (fresh: boolean): Promise<Learned | undefined> => {
    const now = deps.clock();
    if (kept && now < kept.until && (!fresh || now - kept.at < WRITE_MS)) return kept;
    // the sources answered that this network's address names no place: not asked again for a while (a write asks again after a few seconds)
    if (!kept && blank && now < blank.until && (!fresh || now - blank.at < WRITE_MS)) return undefined;
    // asked afresh for a write: the place kept for reads stays until its time unless this answer replaces it
    if (!fresh) forget();
    asking ??= ask().finally(() => (asking = undefined));
    const got = await asking;
    if (got) keep(got, got.from === "trace" ? TRACE_MS : PLACE_MS);
    return got;
  };
  // the part of the country, asked only for a rule that closes part of it, or for lists that name parts of it: the same country, or
  // nothing; kept with the place (then for the full ten minutes: the country is confirmed and its part known). One lookup at a time, and
  // one that did not answer is not asked again for twenty seconds
  const subdivision = async (country: string): Promise<string> => {
    let r: HttpReply;
    try {
      r = await deps.http(SUBDIVISION, { headers: { accept: "application/json", "user-agent": AGENT_NAME }, timeoutMs: deps.timeoutMs ?? ASK_MS });
    } catch {
      return "";
    }
    const b = r.body as { country_code?: unknown; region_code?: unknown } | undefined;
    if (r.status !== 200 || !b || typeof b !== "object") return "";
    const c = typeof b.country_code === "string" ? b.country_code.trim().toUpperCase() : "";
    const region = typeof b.region_code === "string" ? b.region_code.trim().toUpperCase() : "";
    if (c !== country || !/^[A-Z0-9]{1,3}$/.test(region)) return "";
    if (kept && kept.country === country && !kept.region) keep({ country, region, from: kept.from }, PLACE_MS);
    partKnown = { country, region, until: deps.clock() + PLACE_MS };
    return region;
  };
  const part = async (country: string): Promise<string> => {
    if (partKnown && partKnown.country === country && deps.clock() < partKnown.until) return partKnown.region;
    if (partMissed && partMissed.country === country && deps.clock() < partMissed.until) return "";
    if (!partAsking || partAsking.country !== country) {
      const p = subdivision(country).finally(() => {
        if (partAsking?.p === p) partAsking = undefined;
      });
      partAsking = { country, p };
    }
    const region = await partAsking.p;
    partMissed = region ? undefined : { country, until: deps.clock() + PART_MISS_MS };
    return region;
  };
  return {
    async place(fill) {
      const p = await place(false);
      if (!p) return undefined;
      if (!p.region && fill?.splits?.(p.country)) return { country: p.country, region: await part(p.country) };
      return { country: p.country, region: p.region };
    },
    async verdict(rule, ask = {}) {
      const p = await place(ask.fresh === true);
      // another source's country that this place is not in: not judged here, so not served
      if (!p || (ask.country !== undefined && ask.country.trim().toUpperCase() !== p.country)) {
        missing = !p && blank && deps.clock() < blank.until ? "unplaceable" : "place";
        return "unknown";
      }
      missing = undefined;
      if (rule.closes(p.country, p.region)) return "closed";
      if (!p.region && rule.splits?.(p.country)) {
        // the rule closes part of this country and the part is not known: asked once more; still not known, not judged, so not served
        const region = await part(p.country);
        if (!region) {
          missing = "part";
          return "unknown";
        }
        return rule.closes(p.country, region) ? "closed" : "served";
      }
      return "served";
    },
    missing: () => missing,
  };
}

/** The account's sentence for a place not known now — the same whichever part could not be learned: that the rule closes part of the
 * user's country would say which country it is (the line closes part of only a few), and this sentence reaches agents and the ledger */
export function unknownWords(rule: PlaceRule, where?: Pick<Locator, "missing">): string {
  // an address the sources answered with no place is a state of this network, not a moment: said as that, not "just now"
  if (where?.missing?.() === "unplaceable") return `this network's address names no place (an anonymising network, or an address the account's sources cannot place), so ${rule.name}'s own line (${rule.cite}) cannot be held to it`;
  return `where this machine is could not be learned just now, so ${rule.name}'s own line (${rule.cite}) could not be held to it`;
}

/** The rule held to this user's place now, before anything is sent: nothing when the place is served; otherwise the account's refusal —
 * the venue's own rule in its words (E_VENUE_GEOBLOCKED), or the place not known now (E_VENUE_UNREACHABLE: asked again next time). Neither
 * says where the place is. `doing`: what was not sent, for the sentence ("buy 0.001 BTC/USDC:USDC"); empty while connecting, when what is
 * not done is the connection. `ask`: `{ fresh: true }` for a write */
export async function heldTo(rule: PlaceRule, where: Locator, venue: string, doing: string, ask: PlaceAsk = {}): Promise<Refusal | undefined> {
  const v = await where.verdict(rule, ask);
  if (v === "served") return undefined;
  if (v === "closed") return no("E_VENUE_GEOBLOCKED", { venue, message: `${rule.closedWords}. ${doing ? `Nothing was sent to ${rule.name} (${doing})` : "Nothing was connected"}`, native: { rule: rule.terms } });
  // a network that names no place stays one until the network changes: asked again when a check of this network finds a place, not "in a
  // moment"
  if (where.missing?.() === "unplaceable") return no("E_VENUE_UNREACHABLE", { venue, message: `${unknownWords(rule, where)}: ${doing ? `nothing was sent (${doing})` : "nothing was connected"}. It is asked again when this machine is on a network that names a place`, native: { rule: rule.terms, unplaceable: true } });
  return no("E_VENUE_UNREACHABLE", { venue, message: `${unknownWords(rule, where)}: ${doing ? `nothing was sent (${doing})` : "nothing was connected"}. Try again in a moment`, native: { rule: rule.terms } });
}
