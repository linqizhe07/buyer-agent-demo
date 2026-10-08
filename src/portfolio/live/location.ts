/** WHERE THIS USER IS, for a venue whose rule about places is written in its terms rather than kept at its own servers: Hyperliquid's API
 * answers from anywhere, and its Terms of Use say who may not use it. The account holds each user to that rule at the place the user is in
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
 *                                     address on the same page is not. It gives no subdivision, so a rule that closes part of a country (Ontario,
 *                                     Crimea) cannot judge a place it gives, and says "not known" there rather than "served".
 *
 * The place is used for the one decision it was asked for, in memory, and kept at most ten minutes so that a burst of orders asks once. It
 * is never logged, written, put in a refusal or returned: what leaves this file is the venue's rule and a verdict — served, closed, or not
 * known. A place that cannot be learned (no answer, an answer without a country) is not taken for a yes: the rule refuses, as the MetaMask
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
import { POLYMARKET_GEOBLOCK } from "./polymarket-clob.ts";
import type { Http, HttpReply } from "./types.ts";

/** Hyperliquid's own line: its Terms of Use §1.6 closes the venue to persons located in the United States of America or Ontario, Canada, and
 * in territories under economic sanctions. The sanctioned territories are not listed there; these are the ones under comprehensive
 * sanctions (ISO 3166: Cuba, Iran, North Korea, Syria, and Crimea, Sevastopol, Donetsk and Luhansk). Moved here from metamask.ts, whose mm
 * perps path holds the place `mm predict geoblock` names to the same two lists */
export const HL_CLOSED = { countries: new Set(["US", "CU", "IR", "KP", "SY"]), regions: new Set(["CA-ON", "UA-43", "UA-40", "UA-14", "UA-09"]) };
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

/** a user's place, asked of the oracle for each decision, kept at most ten minutes */
export interface Locator {
  verdict(rule: PlaceRule): Promise<Verdict>;
}

/** the second and third place to ask, when Polymarket gives no place: Cloudflare's public trace, on two hosts */
export const TRACE = ["https://www.cloudflare.com/cdn-cgi/trace", "https://1.1.1.1/cdn-cgi/trace"];
/** the longest a place is kept */
export const PLACE_MS = 10 * 60_000;
/** the oracle answers in this long, or the place is not known now */
const ASK_MS = 6_000;

/** One user's place: Polymarket's location check asked with no key, its country and region read and nothing else, kept in this closure at
 * most ten minutes. A place not learned is not kept: the next decision asks again */
export function locator(deps: { http: Http; clock: () => number; timeoutMs?: number | undefined }): Locator {
  let kept: { country: string; region: string; until: number } | undefined;
  let asking: Promise<{ country: string; region: string } | undefined> | undefined;
  // the place is dropped ten minutes on even when nothing asks again (a timer that keeps nothing alive)
  let drop: ReturnType<typeof setTimeout> | undefined;
  const forget = (): void => {
    kept = undefined;
    if (drop) clearTimeout(drop);
    drop = undefined;
  };
  const polymarket = async (): Promise<{ country: string; region: string } | undefined> => {
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
    if (!/^[A-Z]{2}$/.test(country)) return undefined;
    return { country, region: /^[A-Z0-9-]{1,12}$/.test(region) ? region : "" };
  };
  // Cloudflare's trace: only `loc`, the country; no subdivision (region "")
  const cloudflare = async (url: string): Promise<{ country: string; region: string } | undefined> => {
    let r: HttpReply;
    try {
      r = await deps.http(url, { headers: { accept: "text/plain" }, timeoutMs: deps.timeoutMs ?? ASK_MS });
    } catch {
      return undefined;
    }
    if (r.status !== 200) return undefined;
    const loc = /^loc=([A-Za-z]{2})\s*$/m.exec(String(r.text ?? ""));
    const country = loc ? loc[1]!.toUpperCase() : "";
    // XX and T1 are Cloudflare's own words for "not known" and Tor: no place
    return /^[A-Z]{2}$/.test(country) && country !== "XX" && country !== "T1" ? { country, region: "" } : undefined;
  };
  const ask = async (): Promise<{ country: string; region: string } | undefined> => (await polymarket()) ?? (await cloudflare(TRACE[0]!)) ?? (await cloudflare(TRACE[1]!));
  const place = async (): Promise<{ country: string; region: string } | undefined> => {
    if (kept && deps.clock() < kept.until) return kept;
    forget();
    asking ??= ask().finally(() => (asking = undefined));
    const got = await asking;
    if (got) {
      forget();
      kept = { ...got, until: deps.clock() + PLACE_MS };
      drop = setTimeout(forget, PLACE_MS);
      (drop as { unref?: () => void }).unref?.();
    }
    return got;
  };
  return {
    async verdict(rule) {
      const p = await place();
      if (!p) return "unknown";
      if (rule.closes(p.country, p.region)) return "closed";
      // the rule closes part of this country and the subdivision is not known: not judged, so not served
      if (!p.region && rule.splits?.(p.country)) return "unknown";
      return "served";
    },
  };
}

/** The rule held to this user's place now, before anything is sent: nothing when the place is served; otherwise the account's refusal —
 * the venue's own rule in its words (E_VENUE_GEOBLOCKED), or the place not known now (E_VENUE_UNREACHABLE: asked again next time). Neither
 * says where the place is. `doing`: what was not sent, for the sentence ("buy 0.001 BTC/USDC:USDC"); empty while connecting, when what is
 * not done is the connection */
export async function heldTo(rule: PlaceRule, where: Locator, venue: string, doing: string): Promise<Refusal | undefined> {
  const v = await where.verdict(rule);
  if (v === "served") return undefined;
  if (v === "closed") return no("E_VENUE_GEOBLOCKED", { venue, message: `${rule.closedWords}. ${doing ? `Nothing was sent to ${rule.name} (${doing})` : "Nothing was connected"}`, native: { rule: rule.terms } });
  return no("E_VENUE_UNREACHABLE", { venue, message: `where this machine is could not be learned just now (neither Polymarket's location check nor Cloudflare's trace gave one that the rule can judge), so ${rule.name}'s own line (${rule.cite}) could not be held to it: ${doing ? `nothing was sent (${doing})` : "nothing was connected"}. Try again in a moment`, native: { rule: rule.terms } });
}
