import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { excludingTerms, termsExclude, termsFor, termsHere, VENUE_TERMS, type VenueTerms } from "../../src/portfolio/live/eligibility.ts";
import { PM_BLOCKED, PM_SITE_ONLY } from "../../src/portfolio/live/polymarket-clob.ts";
import { HL_CLOSED } from "../../src/portfolio/live/location.ts";

/** Each venue's own published rule about places (live/eligibility.ts), shown on the list of accounts to connect and never enforced: the
 * page it is on, a short excerpt in the venue's words, the places it names as ISO codes, and the matching of a user's place against them,
 * which keeps nothing. The cases below are the pages' own words, read 2026-10-08 */

const VENUES = ["okx", "kraken", "krakenfutures", "coinbase", "bybit", "binance", "kucoin", "kucoinfutures", "gate", "bitget", "mexc", "deribit", "alpaca", "robinhood", "robinhood-crypto", "kalshi", "polymarket", "polymarket-us", "hyperliquid", "okxus", "binanceus"];

/** each venue's own domain: the page an entry links to is there, or a web.archive.org copy of it */
const DOMAIN: Record<string, string> = {
  okx: "okx.com",
  kraken: "kraken.com",
  krakenfutures: "kraken.com",
  coinbase: "coinbase.com",
  bybit: "bybit.com",
  binance: "binance.com",
  kucoin: "kucoin.com",
  kucoinfutures: "kucoin.com",
  gate: "gate.com",
  bitget: "bitget.com",
  mexc: "mexc.com",
  deribit: "deribit.com",
  alpaca: "alpaca.markets",
  robinhood: "robinhood.com",
  "robinhood-crypto": "robinhood.com",
  kalshi: "kalshi.com",
  polymarket: "polymarket.com",
  // the exchange Polymarket US runs (QCX LLC) keeps its agreements on its own domain
  "polymarket-us": "polymarketexchange.com",
  okxus: "okx.com",
  binanceus: "binance.us",
  hyperliquid: "hyperliquid.xyz",
};

/** the ISO 3166-2 subdivisions the pages name, by their own names */
const SUBDIVISIONS: Record<string, string> = {
  "CA-AB": "Alberta",
  "CA-BC": "British Columbia",
  "CA-ON": "Ontario",
  "CA-QC": "Quebec",
  "US-ME": "Maine",
  "US-NY": "New York",
  "UA-09": "Luhansk",
  "UA-14": "Donetsk",
  "UA-23": "Zaporizhzhia",
  "UA-40": "Sevastopol",
  "UA-43": "Crimea",
  "UA-65": "Kherson",
  "US-AL": "Alabama",
  "US-AK": "Alaska",
  "US-AZ": "Arizona",
  "US-AR": "Arkansas",
  "US-CA": "California",
  "US-CO": "Colorado",
  "US-CT": "Connecticut",
  "US-DE": "Delaware",
  "US-DC": "District of Columbia",
  "US-FL": "Florida",
  "US-GA": "Georgia",
  "US-HI": "Hawaii",
  "US-ID": "Idaho",
  "US-IL": "Illinois",
  "US-IN": "Indiana",
  "US-IA": "Iowa",
  "US-KS": "Kansas",
  "US-KY": "Kentucky",
  "US-LA": "Louisiana",
  "US-MD": "Maryland",
  "US-MA": "Massachusetts",
  "US-MI": "Michigan",
  "US-MN": "Minnesota",
  "US-MS": "Mississippi",
  "US-MO": "Missouri",
  "US-MT": "Montana",
  "US-NE": "Nebraska",
  "US-NV": "Nevada",
  "US-NH": "New Hampshire",
  "US-NJ": "New Jersey",
  "US-NM": "New Mexico",
  "US-NC": "North Carolina",
  "US-ND": "North Dakota",
  "US-OH": "Ohio",
  "US-OK": "Oklahoma",
  "US-OR": "Oregon",
  "US-PA": "Pennsylvania",
  "US-RI": "Rhode Island",
  "US-SC": "South Carolina",
  "US-SD": "South Dakota",
  "US-TN": "Tennessee",
  "US-TX": "Texas",
  "US-UT": "Utah",
  "US-VT": "Vermont",
  "US-VA": "Virginia",
  "US-WA": "Washington",
  "US-WV": "West Virginia",
  "US-WI": "Wisconsin",
  "US-WY": "Wyoming",
};

/** an ISO 3166-1 alpha-2 country code: one the platform's region names know, and none of the codes outside the standard */
const regionName = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" });
const NOT_ISO = new Set(["EU", "EZ", "UN", "QO", "XA", "XB", "XK", "ZZ"]);
const isCountry = (code: string) => /^[A-Z]{2}$/.test(code) && !NOT_ISO.has(code) && regionName.of(code) !== undefined;

const terms = (venue: string): VenueTerms => {
  const t = VENUE_TERMS[venue];
  if (!t) throw new Error(`no entry for ${venue}`);
  return t;
};

describe("the venues' own pages", () => {
  it("has one entry for each venue the account connects, under its own id", () => {
    expect(Object.keys(VENUE_TERMS).sort()).toEqual([...VENUES].sort());
    for (const [key, t] of Object.entries(VENUE_TERMS)) {
      expect(t.venue).toBe(key);
      expect(t.name.length).toBeGreaterThan(0);
    }
  });

  it("links each to an https page on the venue's own domain, or a web.archive.org copy that says so", () => {
    for (const t of Object.values(VENUE_TERMS)) {
      const u = new URL(t.url);
      expect(u.protocol, t.venue).toBe("https:");
      const own = u.hostname === DOMAIN[t.venue] || u.hostname.endsWith(`.${DOMAIN[t.venue]}`);
      const archived = u.hostname === "web.archive.org" && t.via !== undefined;
      expect(own || archived, `${t.venue}: ${t.url}`).toBe(true);
      if (t.via !== undefined) expect(t.via, t.venue).toMatch(/^web\.archive\.org snapshot \d{4}-\d{2}-\d{2}\b/);
    }
  });

  it("was read 2026-10-08, and quotes the venue in a short excerpt, or says why its words could not be read", () => {
    for (const t of Object.values(VENUE_TERMS)) {
      expect(t.read, t.venue).toBe("2026-10-08");
      if (t.unread !== undefined) {
        expect(t.says, t.venue).toBe("");
        expect(t.unread.length, t.venue).toBeGreaterThan(20);
        expect(t.excludes ?? t.serves, t.venue).toBeUndefined();
      } else {
        expect(t.says.length, t.venue).toBeGreaterThan(20);
        expect(t.says.length, t.venue).toBeLessThanOrEqual(300);
      }
    }
    expect(terms("coinbase").unread).toMatch(/browser check/);
  });

  it("names places only as ISO 3166-1 alpha-2 countries and ISO 3166-2 subdivisions, each once", () => {
    for (const t of Object.values(VENUE_TERMS)) {
      const list = [...(t.excludes ?? []), ...(t.serves ?? [])];
      expect(new Set(list).size, t.venue).toBe(list.length);
      for (const code of list) {
        if (code.includes("-")) {
          expect(SUBDIVISIONS[code], `${t.venue}: ${code}`).toBeDefined();
          expect(isCountry(code.slice(0, 2)), `${t.venue}: ${code}`).toBe(true);
        } else {
          expect(isCountry(code), `${t.venue}: ${code}`).toBe(true);
        }
      }
    }
  });

  it("gives a venue with no list of places an open end or a reason, and points `also` only at an entry of its own", () => {
    for (const t of Object.values(VENUE_TERMS)) {
      if (!t.excludes && !t.serves) expect(t.openEnded === true || t.unread !== undefined, t.venue).toBe(true);
      expect(t.excludes && t.serves, t.venue).toBeFalsy();
      if (t.also !== undefined) {
        expect(t.also, t.venue).not.toBe(t.venue);
        expect(VENUE_TERMS[t.also]?.also, t.venue).toBeUndefined();
      }
    }
    expect(terms("krakenfutures").also).toBe("kraken");
    expect(terms("kucoinfutures").also).toBe("kucoin");
  });

  it("holds Hyperliquid to the places location.ts holds it to (its terms list no sanctioned territory by name)", () => {
    const hl = terms("hyperliquid");
    expect([...(hl.excludes ?? [])].sort()).toEqual([...HL_CLOSED.countries, ...HL_CLOSED.regions].sort());
    expect(hl.says).toContain("“Restricted Persons.”");
    expect(hl.says).toContain("the United States of America or Ontario, Canada");
    expect(hl.url).toBe("https://app.hyperliquid.xyz/terms");
  });
});

describe("a place held to a venue's terms", () => {
  it("is excluded where the page names its country", () => {
    expect(termsExclude(terms("binance"), { country: "US" })).toBe(true);
    expect(termsExclude(terms("binance"), { country: "NL" })).toBe(true);
    expect(termsExclude(terms("kraken"), { country: "JP" })).toBe(true);
    expect(termsExclude(terms("kalshi"), { country: "CH" })).toBe(true);
    expect(termsExclude(terms("deribit"), { country: "GB" })).toBe(true);
    expect(termsExclude(terms("okx"), { country: "IN" })).toBe(true);
  });

  it("is excluded where the page names its subdivision, given as Polymarket's location check gives it, or with its country", () => {
    const hl = terms("hyperliquid");
    expect(termsExclude(hl, { country: "CA", region: "ON" })).toBe(true);
    expect(termsExclude(hl, { country: "CA", region: "CA-ON" })).toBe(true);
    expect(termsExclude(hl, { country: "ca", region: " on " })).toBe(true);
    expect(termsExclude(hl, { country: "UA", region: "40" })).toBe(true);
    expect(termsExclude(terms("kraken"), { country: "US", region: "NY" })).toBe(true);
    expect(termsExclude(terms("kraken"), { country: "US", region: "US-ME" })).toBe(true);
    expect(termsExclude(terms("polymarket"), { country: "CA", region: "QC" })).toBe(true);
    expect(termsExclude(terms("mexc"), { country: "UA", region: "23" })).toBe(true);
    // Bybit names Sevastopol on its own; Binance names Crimea and not Sevastopol
    expect(termsExclude(terms("bybit"), { country: "UA", region: "40" })).toBe(true);
    expect(termsExclude(terms("binance"), { country: "UA", region: "40" })).toBe(false);
  });

  it("is not excluded where the place is known and the page does not name it", () => {
    expect(termsExclude(terms("hyperliquid"), { country: "CA", region: "BC" })).toBe(false);
    expect(termsExclude(terms("hyperliquid"), { country: "JP" })).toBe(false);
    expect(termsExclude(terms("kraken"), { country: "US", region: "CA" })).toBe(false);
    expect(termsExclude(terms("binance"), { country: "FR" })).toBe(false);
    expect(termsExclude(terms("bybit"), { country: "UA", region: "30" })).toBe(false);
    // Polymarket's help center: "users traveling to non-restricted regions, such as Bulgaria, can continue to trade"
    expect(termsExclude(terms("polymarket"), { country: "BG" })).toBe(false);
    // Malta is listed for sports markets only, and Panama at Deribit for retail derivatives only: neither is coded
    expect(termsExclude(terms("polymarket"), { country: "MT" })).toBe(false);
    expect(termsExclude(terms("deribit"), { country: "PA" })).toBe(false);
  });

  it("is not known where no country was learned, or where the page names part of the country and the part was not learned", () => {
    expect(termsExclude(terms("binance"), {})).toBeUndefined();
    expect(termsExclude(terms("binance"), { country: "" })).toBeUndefined();
    expect(termsExclude(terms("binance"), { country: "USA" })).toBeUndefined();
    expect(termsExclude(terms("binance"), { region: "NY" })).toBeUndefined();
    expect(termsExclude(terms("hyperliquid"), { country: "CA" })).toBeUndefined();
    expect(termsExclude(terms("kraken"), { country: "US" })).toBeUndefined();
    expect(termsExclude(terms("bybit"), { country: "UA", region: "not a code" })).toBeUndefined();
    // a country the page names whole needs no region
    expect(termsExclude(terms("hyperliquid"), { country: "US" })).toBe(true);
  });

  it("is not known at a venue whose words could not be read, wherever the place is", () => {
    for (const place of [{ country: "US", region: "NY" }, { country: "JP" }, { country: "CU" }]) {
      expect(termsExclude(terms("coinbase"), place)).toBeUndefined();
      expect(excludingTerms(terms("coinbase"), place)).toBeUndefined();
    }
  });

  it("answers an allow-list by whether the place is on it, a US outlying area under either of its codes", () => {
    const rh = terms("robinhood");
    expect(termsExclude(rh, { country: "US", region: "NY" })).toBe(false);
    expect(termsExclude(rh, { country: "US" })).toBe(false);
    expect(termsExclude(rh, { country: "PR" })).toBe(false);
    expect(termsExclude(rh, { country: "US", region: "PR" })).toBe(false);
    expect(termsExclude(rh, { country: "US", region: "US-VI" })).toBe(false);
    expect(termsExclude(rh, { country: "GU" })).toBe(true);
    expect(termsExclude(rh, { country: "US", region: "GU" })).toBe(true);
    expect(termsExclude(rh, { country: "FR" })).toBe(true);
    expect(termsExclude(terms("robinhood-crypto"), { country: "DE" })).toBe(true);
  });

  it("matches a US territory a page names under either code, and leaves one it does not name alone", () => {
    expect(termsExclude(terms("kucoin"), { country: "PR" })).toBe(true);
    expect(termsExclude(terms("kucoin"), { country: "US", region: "PR" })).toBe(true);
    expect(termsExclude(terms("bitget"), { country: "UM" })).toBe(true);
    // Binance names the United States and none of its territories
    expect(termsExclude(terms("binance"), { country: "PR" })).toBe(false);
  });

  it("holds an account opened under another venue's terms to that venue's places too, and says whose words exclude", () => {
    const kf = terms("kucoinfutures");
    expect(termsExclude(kf, { country: "ES" })).toBe(true);
    expect(excludingTerms(kf, { country: "ES" })?.venue).toBe("kucoinfutures");
    expect(termsExclude(kf, { country: "US" })).toBe(true);
    expect(excludingTerms(kf, { country: "US" })?.venue).toBe("kucoin");
    expect(termsExclude(kf, { country: "CA", region: "ON" })).toBe(true);
    expect(termsExclude(kf, { country: "CA" })).toBeUndefined();
    expect(termsExclude(kf, { country: "DE" })).toBe(false);
    expect(excludingTerms(kf, { country: "DE" })).toBeUndefined();
    const kr = terms("krakenfutures");
    expect(termsExclude(kr, { country: "JP" })).toBe(true);
    expect(excludingTerms(kr, { country: "JP" })?.venue).toBe("kraken");
    expect(termsExclude(kr, { country: "GB" })).toBe(true);
    expect(termsExclude(kr, { country: "US", region: "TX" })).toBe(true);
    expect(termsExclude(kr, { country: "DE" })).toBe(false);
  });

  it("keeps nothing: the entries are the same after any number of answers, and the file holds no state", () => {
    const before = JSON.stringify(VENUE_TERMS);
    for (const venue of VENUES) for (const place of [{ country: "US", region: "NY" }, { country: "CA", region: "ON" }, { country: "JP" }, {}]) termsExclude(terms(venue), place);
    expect(JSON.stringify(VENUE_TERMS)).toBe(before);
    const source = readFileSync(new URL("../../src/portfolio/live/eligibility.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/^\s*(let|var)\s/m);
    expect(source).not.toMatch(/new (Map|WeakMap)\(/);
  });
});

describe("the connections' terms", () => {
  it("maps every exchange connection to its exchange's entry", () => {
    for (const id of ["okx", "kraken", "krakenfutures", "coinbase", "bybit", "binance", "kucoin", "kucoinfutures", "gate", "bitget", "mexc", "deribit"]) {
      expect(termsFor(`live:exchange:${id}`)?.venue).toBe(id);
    }
  });

  it("maps the other connections, a read by address to its venue's own terms", () => {
    expect(termsFor("live:alpaca")?.venue).toBe("alpaca");
    expect(termsFor("live:robinhood")?.venue).toBe("robinhood");
    expect(termsFor("live:robinhood-crypto")?.venue).toBe("robinhood-crypto");
    expect(termsFor("live:kalshi")?.venue).toBe("kalshi");
    expect(termsFor("live:polymarket-trade")?.venue).toBe("polymarket");
    expect(termsFor("live:polymarket")?.venue).toBe("polymarket");
    expect(termsFor("live:hyperliquid-trade")?.venue).toBe("hyperliquid");
    expect(termsFor("live:hyperliquid")?.venue).toBe("hyperliquid");
  });

  it("has nothing for a connection without an entry, and nothing an object's own keys could be mistaken for", () => {
    for (const c of ["live:exchange:phemex", "live:exchange:robinhood", "live:exchange:alpaca", "live:exchange:constructor", "live:exchange:__proto__", "live:wallet", "live:ondo", "live:metamask", "constructor", "toString", "__proto__", "okx", "live:exchange:"]) {
      expect(termsFor(c), c).toBeUndefined();
    }
  });
});

describe("a connection's terms as the list of accounts shows them (termsHere)", () => {
  it("an exclusion list: excluded or not where the place is known, not judged where it is not; an allow-list also says whether it serves the place", () => {
    expect(termsHere("live:exchange:binance", { country: "US", region: "TX" })).toMatchObject({ url: VENUE_TERMS.binance!.url, excludesHere: true });
    expect(termsHere("live:exchange:binance", { country: "AR", region: "B" })).toMatchObject({ excludesHere: false });
    expect(termsHere("live:exchange:binance", undefined)).toMatchObject({ excludesHere: undefined });
    // an exclusion list never says it serves a place: only an allow-list does
    expect(termsHere("live:exchange:binance", { country: "AR", region: "B" })!.servesHere).toBeUndefined();
    expect(termsHere("live:robinhood", { country: "US", region: "TX" })).toMatchObject({ excludesHere: false, servesHere: true });
    expect(termsHere("live:robinhood", { country: "FR", region: "IDF" })).toMatchObject({ excludesHere: true, servesHere: false });
    expect(termsHere("live:robinhood", undefined)!.servesHere).toBeUndefined();
    expect(termsHere("live:wallet", { country: "US" })).toBeUndefined();
  });

  it("Polymarket's terms entry holds every place its geoblock lists name, the ones the order path reads included", () => {
    for (const c of [...PM_BLOCKED, ...PM_SITE_ONLY].filter((c) => c !== "MT")) expect(VENUE_TERMS.polymarket!.excludes, c).toContain(c);
  });
});

describe("an edition's own words for whom it is for (servesPlace)", () => {
  it("names the place, names another, or cannot say", async () => {
    const { servesPlace } = await import("../../src/portfolio/live/eligibility.ts");
    expect(servesPlace(["US"], { country: "US", region: "PA" })).toBe(true);
    // a territory is named on its own, as the terms above name it: "US" alone does not say Puerto Rico
    expect(servesPlace(["US"], { country: "PR" })).toBe(false);
    expect(servesPlace(["US", "PR"], { country: "US", region: "PR" })).toBe(true);
    expect(servesPlace(["US"], { country: "GB", region: "ENG" })).toBe(false);
    expect(servesPlace(["US"], undefined)).toBeUndefined();
  });
});

describe("a venue's own terms handing a place to another company's (OKX → OKX US)", () => {
  it("a US resident in one of OKX US's approved locations is under OKX US's terms, in OKX's own words; elsewhere OKX's own list decides", () => {
    const t = termsFor("live:exchange:okx")!;
    expect(termsExclude(t, { country: "US", region: "PA" })).toBe(true);
    expect(excludingTerms(t, { country: "US", region: "PA" })).toMatchObject({ url: "https://www.okx.com/help/terms-of-service", says: expect.stringContaining("OKX US's approved operating locations") });
    // New York is not an approved location; OKX restricts unnamed US jurisdictions, and names none: not excluded by what it names
    expect(termsExclude(t, { country: "US", region: "NY" })).toBe(false);
    expect(termsExclude(t, { country: "SG" })).toBe(false);
    // the state not known: the hand-over names parts of the US, so not judged
    expect(termsExclude(t, { country: "US" })).toBeUndefined();
  });

  it("Binance.US serves the states its page lists; OKX US excludes the ones its page names", () => {
    const bus = termsFor("live:exchange:binanceus")!;
    expect(termsExclude(bus, { country: "US", region: "PA" })).toBe(false);
    expect(termsExclude(bus, { country: "US", region: "TX" })).toBe(true);
    expect(termsExclude(bus, { country: "PR" })).toBe(false);
    expect(termsExclude(bus, { country: "CA", region: "ON" })).toBe(true);
    const okxus = termsFor("live:exchange:okxus")!;
    expect(termsExclude(okxus, { country: "US", region: "NY" })).toBe(true);
    expect(termsExclude(okxus, { country: "US", region: "TX" })).toBe(false);
  });
});
