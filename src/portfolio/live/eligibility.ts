/** WHAT EACH VENUE'S OWN TERMS SAY ABOUT PLACES, for the list of accounts to connect: a venue whose published rule excludes where this user
 * is says so on its tile, in its own words, with a link to them. It is SHOWN, never enforced: the venue's own sign-up checks where its users
 * live, and the account neither stops a connection on a rule here nor looks for a way around one. (location.ts keeps Hyperliquid's rule
 * too, as Hyperliquid's API answers from anywhere; the entry here is the same rule, shown.)
 *
 * The place is the one location.ts learns (Polymarket's location check: a country, ISO 3166-1 alpha-2, and a region code, as "NY" or
 * "US-NY"; or a country alone). It is matched here, in memory, at the moment the list is drawn, and never kept, logged or returned:
 * termsExclude takes a place and answers yes, no or not known, and nothing in this file holds one. So a user anywhere sees only the rules
 * that apply where they are, and nobody else's. The pages speak of residence; the place is where the user's machine is now, so a traveller
 * sees the rule of the place they are in.
 *
 * Each entry is one venue's own page, read 2026-10-08:
 *   url        the venue's page that says it (its terms, or its own list of places)
 *   says       a short verbatim excerpt naming the restriction, cut with "…": a quote with a link, not a copy of the terms
 *   excludes   the places that page names, as codes: ISO 3166-1 alpha-2 for a country, ISO 3166-2 for a subdivision the page names
 *              (CA-ON Ontario, US-NY New York, UA-43 Crimea, UA-40 Sevastopol only where a page names Sevastopol). Only what the page
 *              names, never a place inferred: "the Chinese Mainland" is CN; a US territory the page names is its own code (PR, GU, VI, AS,
 *              MP, UM), which ISO 3166-2:US also gives as US-PR … and termsExclude matches in either form
 *   serves     instead of `excludes`, for a venue that serves only a list of places (an allow-list): those places
 *   openEnded  the page keeps the right to exclude places it does not name ("and such other locations …", "including but not limited to")
 *   also       another entry whose places apply as well, because an account here is opened under that venue's terms (a futures arm that
 *              needs the exchange's own account, terms that are "supplemental to" the general ones)
 *   via        how the page was read when the venue's own site refuses this machine (Binance's HTTP 451, Bybit's CloudFront 403, Gate's
 *              and MEXC's Access Denied) or stops it at a browser check (Kalshi): a public web.archive.org copy, never another network
 *   unread     why the venue's own words could not be read; such an entry has no excerpt and answers "not known" everywhere
 *
 * Hyperliquid's terms do not list the sanctioned territories they close; its entry holds the ones location.ts holds (HL_CLOSED), and
 * test/unit/live-eligibility.test.ts keeps the two equal.
 *
 * To update: open each `url` (or the newest web.archive.org copy, for a site that refuses this machine), compare the excerpt and the places
 * with what the page says now, change the entry and its `read` date, and run test/unit/live-eligibility.test.ts.
 */

/** one venue's own rule about places, as its page writes it */
export interface VenueTerms {
  /** the account's id for the venue: the exchange id of live:exchange:<id>, or the connection's own name */
  venue: string;
  /** the venue's name, for the sentences */
  name: string;
  /** the venue's own page that says it */
  url: string;
  /** when it was read (YYYY-MM-DD) */
  read: string;
  /** a short verbatim excerpt naming the restriction, cut with "…"; empty when unread */
  says: string;
  /** the places the page names as excluded: ISO 3166-1 alpha-2, or ISO 3166-2 for a subdivision it names */
  excludes?: string[];
  /** for a venue that serves only a list of places: those places, in the same codes */
  serves?: string[];
  /** the page keeps the right to exclude places it does not name */
  openEnded?: boolean;
  /** one plain sentence, when something matters */
  note?: string;
  /** how the page was read when not from the venue's own site: "web.archive.org snapshot <date>" */
  via?: string;
  /** why the venue's own words could not be read; such an entry answers "not known" */
  unread?: string;
  /** another entry whose places apply as well: an account here is opened under that venue's terms */
  also?: string;
  /** places this venue's own terms hand to another company's local terms (OKX: residents of OKX US's approved US locations are under OKX
   * US's): excluded here, in those words, so the other company — the venue's edition for them — can be named */
  routes?: { places: string[]; url: string; says: string };
}

const READ = "2026-10-08";

export const VENUE_TERMS: Record<string, VenueTerms> = {
  // OKX's Terms of Service (17 September 2026) §2.2 send the list to Section 3 of its Risk & Compliance Disclosure (8 July 2026)
  okx: {
    venue: "okx",
    name: "OKX",
    url: "https://www.okx.com/help/risk-compliance-disclosure",
    read: READ,
    says: "…may restrict or prohibit use of all or a portion of the Services from Restricted Locations, which at this time include Afghanistan, Canada, Cuba, Hong Kong, …",
    excludes: ["AF", "CA", "CU", "HK", "IR", "IN", "JP", "MY", "NP", "KP", "SY", "UA-43", "UA-14", "UA-09", "PR", "AS", "GU", "MP", "VI", "UM", "UZ"],
    openEnded: true,
    note: "It also restricts “certain jurisdictions within the United States of America”, unnamed, and limits some services in Australia, the Bahamas, Brazil, Eritrea, Russia, South Korea and the United Kingdom; residents of OKX US’s approved US locations are served by OKX Inc. (OKX US) under its own terms.",
    // its Terms of Service (17 September 2026), the preamble: local terms govern instead "for Users who are residents of one of OKX US's
    // approved operating locations"; those locations are the ones OKX US lists a licence or registration for (its US licences page,
    // 15 September 2026). OKX's API FAQ (28 September 2026): a US account's key works at us.okx.com only
    routes: {
      places: ["US-AL", "US-AK", "US-AZ", "US-AR", "US-CO", "US-CT", "US-DE", "US-DC", "US-FL", "US-GA", "US-ID", "US-IL", "US-IN", "US-IA", "US-KS", "US-KY", "US-LA", "US-ME", "US-MD", "US-MI", "US-MN", "US-MS", "US-MO", "US-NE", "US-NV", "US-NH", "US-NJ", "US-NM", "US-NC", "US-ND", "US-OH", "US-OK", "US-OR", "US-PA", "US-RI", "US-SC", "US-SD", "US-TN", "US-TX", "US-VT", "US-VA", "US-WA", "US-WV", "US-WI", "PR"],
      url: "https://www.okx.com/help/terms-of-service",
      says: "…for Users who are residents of one of OKX US's approved operating locations within the United States and its territories…",
    },
  },
  // OKX US (OKX INC.): its US licences page, updated September 15, 2026
  okxus: {
    venue: "okxus",
    name: "OKX US",
    url: "https://www.okx.com/en-us/help/us-licenses",
    read: READ,
    says: "OKX INC. does not provide services to residents of the following states and territories at this time",
    excludes: ["US-NY", "AS", "GU", "MP", "VI"],
    note: "The page lists a licence or registration for 44 states, the District of Columbia and Puerto Rico; California, Hawaii, Massachusetts, Montana, Utah and Wyoming are neither listed nor excluded there.",
  },
  // Binance.US (BAM Trading Services Inc.): its list of supported and unsupported states and regions, updated June 3, 2026
  binanceus: {
    venue: "binanceus",
    name: "Binance.US",
    url: "https://support.binance.us/en/articles/9842798-list-of-supported-and-unsupported-states-and-regions",
    read: READ,
    says: "This article includes all of the states and regions where Binance.US services are available.",
    serves: ["US-AL", "US-AZ", "US-AR", "US-CA", "US-CO", "US-DE", "US-DC", "US-FL", "US-HI", "US-ID", "US-IL", "US-IN", "US-IA", "US-KS", "US-KY", "US-LA", "US-MD", "US-MA", "US-MI", "US-MN", "US-MS", "US-MO", "US-MT", "US-NE", "US-NV", "US-NH", "US-NJ", "US-NM", "US-OK", "US-PA", "US-RI", "US-SC", "US-SD", "US-TN", "US-UT", "US-VA", "US-WV", "US-WI", "US-WY", "PR"],
    note: "Kansas and Wisconsin are crypto only; its Terms of Use (June 5, 2026) say individuals must be US citizens or residents. Unsupported: Alaska, Connecticut, Georgia, Maine, New York, North Carolina, North Dakota, Ohio, Oregon, Texas, Vermont, Washington and the territories but Puerto Rico.",
  },
  // "Where is Kraken licensed or regulated?", last updated September 30, 2026
  kraken: {
    venue: "kraken",
    name: "Kraken",
    url: "https://support.kraken.com/articles/where-is-kraken-licensed-or-regulated",
    read: READ,
    says: "At this time, Kraken … does not offer services to residents of: … Maine … New York … We do not serve clients, or permit cash and crypto deposits, from the following regions: …",
    excludes: ["AF", "BY", "UA-43", "UA-14", "UA-09", "CU", "CD", "IR", "IQ", "JP", "LY", "KP", "RU", "SD", "SS", "SY", "US-ME", "US-NY"],
    openEnded: true,
    note: "The page sends readers to Kraken’s Terms of Service for the complete criteria, which also bar any sanctioned or embargoed jurisdiction and any place where Kraken has restricted its services; clients in Canada, and UK retail clients, cannot trade derivatives.",
  },
  // "Kraken Derivatives eligibility requirements", last updated July 28, 2026: the perpetual futures that futures.kraken.com trades
  krakenfutures: {
    venue: "krakenfutures",
    name: "Kraken Futures",
    url: "https://support.kraken.com/articles/360023786632-kraken-derivatives-eligibility",
    read: READ,
    says: "Kraken Derivatives (non-US) allows clients to trade perpetual futures … Kraken Derivatives is not available to clients in the regions listed below:",
    excludes: ["AF", "AU", "CX", "CC", "HM", "NF", "BD", "BY", "CA", "CD", "CU", "IR", "IQ", "KP", "LY", "NZ", "RU", "GB", "UA-43", "UA-14", "UA-09", "US"],
    also: "kraken",
    note: "The page names the product Kraken Derivatives (non-US), US clients having Kraken Derivatives US, and opens it in Australia (and its territories) only to wholesale clients and in the UK only to professional clients; it needs a verified Kraken account, so Kraken’s own places apply too.",
  },
  coinbase: {
    venue: "coinbase",
    name: "Coinbase",
    url: "https://www.coinbase.com/legal/user_agreement",
    read: READ,
    says: "",
    unread: "when this table was made (2026-10-08), coinbase.com and help.coinbase.com answered its reader with a browser check (HTTP 403), and web.archive.org’s copies of Coinbase’s list of places (coinbase.com/places) hold only its home page since mid-2026: no list of the places Coinbase serves could be read",
    note: "Coinbase keeps a user agreement per region (this link opens the visitor’s own); the US one, with Coinbase, Inc. (read from a web.archive.org copy of 2026-10-05), asks that its users reside in the United States.",
  },
  // "Service Restricted Countries", last updated on 2026-09-01 (Bybit Platform Terms & Conditions §11.3)
  bybit: {
    venue: "bybit",
    name: "Bybit",
    url: "https://www.bybit.com/en/help-center/article/Service-Restricted-Countries",
    read: READ,
    says: "…Bybit does not offer services or products to Users in a few excluded jurisdictions including the United States, the Chinese Mainland, Hong Kong, Singapore, Canada, …",
    excludes: ["US", "CN", "HK", "SG", "CA", "KP", "CU", "IR", "UZ", "UA-43", "UA-14", "UA-09", "UA-40", "SD", "SY", "SC"],
    openEnded: true,
    via: "web.archive.org snapshot 2026-10-02",
    note: "The page also names “Rostov” among the Russian-controlled regions of Ukraine (Ukraine has no Rostov region, so it is not coded), Dubai for Bybit’s UAE company only, and persons in Seychelles other than international business companies (coded SC).",
  },
  // Binance's Terms of Use (effective 21 July 2026) §2.1(f) send the list to its List of Prohibited Countries (updated 5 January 2026)
  binance: {
    venue: "binance",
    name: "Binance",
    url: "https://www.binance.com/en/about-legal/list-of-prohibited-countries",
    read: READ,
    says: "The below Countries, and such other locations, as designated by Binance from time to time, form the List of Prohibited Countries … United States … Canada … Netherlands",
    excludes: ["US", "CA", "NL", "CU", "KP", "IR", "UA-43", "UA-14", "UA-09"],
    openEnded: true,
    via: "web.archive.org snapshot 2026-10-03; the list itself is the PDF that page embeds from bin.bnbstatic.com, Binance’s own file host, read there",
    note: "The United States line also covers US citizens wherever they are; US persons are served by Binance.US, run by a separate company (BAM Trading Services Inc.) under its own terms.",
  },
  // KuCoin's Terms of Use, last updated 09/29/2026, Article 17(5)
  kucoin: {
    venue: "kucoin",
    name: "KuCoin",
    url: "https://www.kucoin.com/legal/terms-of-use",
    read: READ,
    says: "…“Restricted Locations” shall include the United States (including its territories such as Puerto Rico, Guam, the Northern Mariana Islands, American Samoa, etc), Singapore, …",
    excludes: ["US", "PR", "GU", "MP", "AS", "VI", "UM", "SG", "CN", "HK", "MY", "KZ", "UZ", "CA-ON", "CA-BC", "FR", "NL", "UA-43", "UA-14", "UA-09", "UA-23", "UA-65"],
    openEnded: true,
  },
  // KuCoin Futures Terms of Use, 2026/03/16, §3.1(c)
  kucoinfutures: {
    venue: "kucoinfutures",
    name: "KuCoin Futures",
    url: "https://www.kucoin.com/announcement/en-futures-terms-of-use",
    read: READ,
    says: "…not be a resident of any jurisdictions or regions where futures and derivative trading is prohibited or restricted by applicable laws and regulations (such as Spain and Australia)",
    excludes: ["ES", "AU"],
    openEnded: true,
    also: "kucoin",
    note: "These terms are supplemental to KuCoin’s Terms of Use, so KuCoin’s Restricted Locations apply too.",
  },
  // Gate's User Agreement, last updated on 22 July 2026, clause 2.5
  gate: {
    venue: "gate",
    name: "Gate",
    url: "https://www.gate.com/legal/user-agreement",
    read: READ,
    says: "The Restricted Locations include but are not limited to the United States of America, Mainland China, Singapore, Canada, France, Germany, Hong Kong, …",
    excludes: ["US", "CN", "SG", "CA", "FR", "DE", "HK", "MY", "MT", "CU", "IR", "KP", "SD", "UA-43", "ES", "UA-09", "UA-14", "NL", "GB", "MM", "VE", "UZ", "AT", "IN", "ID", "JP", "AR", "KH", "AE", "TH", "KR", "PH", "PK", "VN", "RU"],
    openEnded: true,
    via: "web.archive.org snapshot 2026-09-21",
  },
  // Bitget's Terms of Use, last updated September 15, 2026 (Definitions: Prohibited Countries)
  bitget: {
    venue: "bitget",
    name: "Bitget",
    url: "https://www.bitget.com/support/articles/360014944032",
    read: READ,
    says: "Prohibited Countries means the following countries and such other locations as designated by Bitget from time to time, including Austria, Canada, Crimea, Cuba, …",
    excludes: ["AT", "CA", "UA-43", "CU", "UA-14", "FR", "DE", "HK", "IR", "JP", "KZ", "UA-09", "MY", "KP", "SG", "SD", "US", "PR", "GU", "VI", "AS", "MP", "UM", "IQ", "LY", "YE", "AF", "CF", "CD", "GW", "HT", "LB", "SO", "SS", "TH"],
    openEnded: true,
  },
  // MEXC's User Agreement ("Last Updated: 29 May, 2025" on the page), Prohibited Jurisdiction
  mexc: {
    venue: "mexc",
    name: "MEXC",
    url: "https://www.mexc.com/terms",
    read: READ,
    says: "Currently, MEXC does not provide Services, nor do we accept registration of Users or trade applications, in the following countries: North Korea, Cuba, Sudan, Iran, …",
    excludes: ["KP", "CU", "SD", "IR", "CN", "SG", "MY", "US", "GB", "HK", "KZ", "UA-43", "UA-14", "UA-09", "UA-23", "UA-65", "UA-40", "CA"],
    openEnded: true,
    via: "web.archive.org snapshot 2026-10-02",
    note: "Also any country under comprehensive EU or OFAC sanctions or on the FATF blacklist, which the page does not name.",
  },
  // Deribit's "Restricted Jurisdictions", updated 2026-10-06
  deribit: {
    venue: "deribit",
    name: "Deribit",
    url: "https://support.deribit.com/hc/en-us/articles/25944487427741-Restricted-Jurisdictions",
    read: READ,
    says: "The access and use of our platform, and the services we offer, are not allowed if you are located … in, or a resident of, any of the jurisdictions in the overview below",
    excludes: ["BY", "CA", "CF", "CG", "CD", "CU", "GU", "IR", "IQ", "JP", "KP", "LY", "MM", "PR", "RU", "AS", "SO", "SS", "SD", "SY", "UA-43", "UA-14", "UA-09", "GB", "US", "VI", "YE"],
    note: "Retail investors in Panama and the UAE may only trade spot products, and UK retail clients are not allowed (coded GB); the Belarus and Russia lines also cover their nationals abroad without EEA or Swiss nationality or residence, and “Congo”, as written, is coded as both Congos (CG, CD).",
  },
  // "Countries Alpaca is available", February 2026
  alpaca: {
    venue: "alpaca",
    name: "Alpaca",
    url: "https://alpaca.markets/support/countries-alpaca-is-available",
    read: READ,
    says: "Please contact support at … for more information regarding whether your country is supported.",
    openEnded: true,
    note: "Alpaca publishes no list of the countries it serves; for US residents it asks for a residential address in the 50 states or Puerto Rico.",
  },
  // "What you need to get started": Robinhood's investing accounts
  robinhood: {
    venue: "robinhood",
    name: "Robinhood",
    url: "https://robinhood.com/us/en/support/articles/what-you-need-to-get-started/",
    read: READ,
    says: "Have a legal United States (US) residential address within the 50 states, Puerto Rico, or the US Virgin Islands (exceptions may apply for active US military personnel stationed abroad)",
    serves: ["US", "PR", "VI"],
    note: "An allow-list: the page names where its customers must live, read here as the United States (the District of Columbia with the 50 states), Puerto Rico and the US Virgin Islands.",
  },
  // "Robinhood Crypto Trading API"
  "robinhood-crypto": {
    venue: "robinhood-crypto",
    name: "Robinhood Crypto",
    url: "https://robinhood.com/us/en/support/articles/crypto-api/",
    read: READ,
    says: "It’s available to Robinhood Crypto customers in the United States.",
    serves: ["US", "PR", "VI"],
    note: "An allow-list: a Robinhood Crypto account opens with a Robinhood account, whose address must be in the 50 states, Puerto Rico or the US Virgin Islands (the robinhood entry); some coins cannot be traded in New York or Texas.",
  },
  // the Kalshi Member Agreement, §VI, to which Kalshi's help center ("Can I trade on Kalshi from outside the United States?", 20 March 2026)
  // sends every question about countries
  kalshi: {
    venue: "kalshi",
    name: "Kalshi",
    url: "https://kalshi.com/docs/kalshi-member-agreement.pdf",
    read: READ,
    says: "…you are prohibited to access, use, or trade Contracts on the Platform if you are domiciled in, organized in, or located in any of the following jurisdictions (collectively, the “Restricted Jurisdictions”): Afghanistan, Algeria, Angola, …",
    excludes: ["AF", "DZ", "AO", "AU", "BY", "BE", "BO", "BG", "BF", "CM", "CA", "CF", "CI", "CU", "CD", "ET", "FR", "HT", "HU", "IR", "IQ", "IT", "KE", "LA", "LB", "LY", "ML", "MC", "MZ", "MM", "NA", "NZ", "NI", "NE", "KP", "CN", "PL", "RU", "SG", "SO", "SS", "SD", "CH", "SY", "TW", "TH", "UA", "AE", "GB", "VE", "YE", "ZW"],
    openEnded: true,
    via: "web.archive.org snapshot 2026-02-22 (the agreement’s v1.6): kalshi.com, and every later snapshot of it, answer with a security checkpoint",
    note: "This is the newest copy that could be read; a later version of the agreement may name other places.",
  },
  // Polymarket's "Geographic Restrictions", which its Terms of Use (effective 11 August 2026) make the list of Restricted Jurisdictions
  polymarket: {
    venue: "polymarket",
    name: "Polymarket",
    url: "https://docs.polymarket.com/api-reference/geoblock",
    read: READ,
    says: "Polymarket restricts order placement from certain geographic locations due to regulatory requirements and compliance with international sanctions.",
    excludes: [
      // blocked completely
      "IR", "SY", "CU", "KP", "UA-43", "UA-14", "UA-09",
      // close-only on the website and the API
      "AU", "BY", "BE", "BI", "BR", "CA-BC", "CA-ON", "CA-AB", "CA-QC", "CF", "CD", "ET", "FR", "DE", "IQ", "IT", "LB", "LY", "MM", "NZ", "NI", "PL", "RU", "SG", "SO", "SK", "SS", "SD", "TW", "TH", "GB", "US", "UM", "VE", "YE", "ZW",
      // close-only on the website (Malta, for sports markets only, is not coded)
      "IE", "JP", "NL", "KR",
      // named by the Terms of Use as well
      "HU", "SI",
    ],
    openEnded: true,
    note: "Its Terms of Use adopt this list and also name Hungary and Slovenia; Malta is listed for sports markets only, and where a place is close-only, positions already open may still be closed. In the United States, Polymarket US (QCX LLC, a CFTC-regulated Designated Contract Market) is a separate exchange under its own terms.",
  },
  // Polymarket US (QCX LLC, a CFTC-designated contract market): its app's Terms (polymarket.us/tos, effective September 25, 2025) defer to
  // the exchange's Participant Agreement (2026.08.06, §II.8), which names no US state or territory
  "polymarket-us": {
    venue: "polymarket-us",
    name: "Polymarket US",
    url: "https://polymarketexchange.com/files/legal/latest/participant-agreement",
    read: READ,
    says: "…you are prohibited from accessing, using, or trading Contracts on the System if you are domiciled, a resident of, or located in: (a) any country, territory, or region that is the target of comprehensive economic sanctions …",
    excludes: ["CU", "IR", "KP", "UA-43", "UA-14", "UA-09"],
    openEnded: true,
    note: "Its Participant Agreement also excludes every jurisdiction on FATF's black and grey lists, unnamed, and any that bans or warns against selling retail binary options; its docs call it “Built for US residents”, and sign-up asks for a Social Security number.",
  },
  // Hyperliquid's Terms of Use, last updated on June 15, 2026, §1.6
  hyperliquid: {
    venue: "hyperliquid",
    name: "Hyperliquid",
    url: "https://app.hyperliquid.xyz/terms",
    read: READ,
    says: "The Interface is not available to “Restricted Persons.” … who reside in, are located in … the United States of America or Ontario, Canada; (b) … jurisdictions subject to applicable economic and trade sanctions",
    excludes: ["US", "AS", "GU", "MP", "PR", "UM", "VI", "CU", "IR", "KP", "SY", "CA-ON", "UA-43", "UA-40", "UA-14", "UA-09"],
    openEnded: true,
    note: "The terms do not list the sanctioned territories: the ones held here are the account’s own reading in location.ts (comprehensive sanctions: Cuba, Iran, North Korea, Syria, and Crimea, Sevastopol, Donetsk and Luhansk); §1.6 also covers citizens of those territories wherever they are. “The United States of America” is read here with its territories (Puerto Rico, Guam, the US Virgin Islands, American Samoa, the Northern Mariana Islands, the minor outlying islands).",
  },
};

/** a place as location.ts learns it: a country (ISO 3166-1 alpha-2) and its region code, "NY" or "US-NY" */
export interface Place {
  country?: string | undefined;
  region?: string | undefined;
}

/** the outlying areas of the United States: ISO 3166-1 codes each as a country of its own, and ISO 3166-2:US codes each as US-<code> */
const US_AREAS = new Set(["AS", "GU", "MP", "PR", "UM", "VI"]);

/** a place as the lists name it: its country, every code it goes by, and whether its subdivision is known */
interface Codes {
  country: string;
  subdivision: boolean;
  codes: string[];
}

/** the codes a place goes by, or nothing when its country is not known. A region comes as "NY" or "US-NY" and is held as "US-NY"; a US
 * outlying area is the same place whether it comes as the country PR or as the US region PR */
function codesOf(place: Place): Codes | undefined {
  const country = typeof place.country === "string" ? place.country.trim().toUpperCase() : "";
  // "XX" (a country not known) and "T1" (Tor) are a lookup's placeholders, not places: nothing is judged by them (polymarket-clob.ts
  // readablePlace)
  if (!/^[A-Z]{2}$/.test(country) || country === "XX" || country === "T1") return undefined;
  const given = typeof place.region === "string" ? place.region.trim().toUpperCase() : "";
  const part = given.startsWith(`${country}-`) ? given.slice(country.length + 1) : given;
  const region = /^[A-Z0-9]{1,3}$/.test(part) ? part : "";
  if (country === "US" && US_AREAS.has(region)) return { country: region, subdivision: false, codes: [region, `US-${region}`] };
  if (US_AREAS.has(country)) return { country, subdivision: false, codes: [country, `US-${country}`] };
  return region ? { country, subdivision: true, codes: [country, `${country}-${region}`] } : { country, subdivision: false, codes: [country] };
}

/** one entry's own list, held to a place: excluded, not excluded, or not known (the list names parts of the place's country and which
 * part the place is in was not learned) */
function byList(t: VenueTerms, p: Codes): boolean | undefined {
  const named = (list: string[]) => p.codes.some((c) => list.includes(c));
  const partOf = (list: string[]) => !p.subdivision && list.some((c) => c.startsWith(`${p.country}-`));
  if (t.serves && !named(t.serves)) return partOf(t.serves) ? undefined : true;
  if (t.excludes) {
    if (named(t.excludes)) return true;
    if (partOf(t.excludes)) return undefined;
  }
  return false;
}

/** the answer for one entry and one place, and whose words give it when the answer is yes */
function judge(t: VenueTerms, place: Place): { excluded: boolean | undefined; by?: VenueTerms } {
  if (t.unread !== undefined) return { excluded: undefined };
  const p = codesOf(place);
  if (!p) return { excluded: undefined };
  // a place the venue's own terms hand to another company's: excluded here, in the words that hand it over
  const routed = t.routes ? byList({ venue: t.venue, name: t.name, url: t.routes.url, read: t.read, says: t.routes.says, excludes: t.routes.places }, p) : false;
  if (routed === true && t.routes) return { excluded: true, by: { ...t, url: t.routes.url, says: t.routes.says } };
  const own = byList(t, p);
  if (own === true) return { excluded: true, by: t };
  // the hand-over names parts of the place's country and the part is not known: not judged
  if (routed === undefined) return { excluded: undefined };
  const parent = t.also !== undefined && t.also !== t.venue && Object.hasOwn(VENUE_TERMS, t.also) ? VENUE_TERMS[t.also] : undefined;
  if (!parent) return { excluded: own };
  if (parent.unread !== undefined) return { excluded: undefined };
  const theirs = byList(parent, p);
  if (theirs === true) return { excluded: true, by: parent };
  return { excluded: own === undefined || theirs === undefined ? undefined : false };
}

/** Do this venue's own terms exclude this place? true when the place's country, or its subdivision, is one the page names (or, for an
 * allow-list, is not one it names), or the venue named in `also` excludes it; false when the place is known and nothing names it; undefined
 * when the place is not known (no country, or a list that names part of its country when the part was not learned) or the entry was not
 * read. A list the venue keeps open (`openEnded`) still answers by what it names. Nothing is kept: the place is used for this answer only */
export function termsExclude(t: VenueTerms, place: Place): boolean | undefined {
  return judge(t, place).excluded;
}

/** Whose words exclude this place: the venue's own entry, or the one its `also` names (so the page quotes the words that apply);
 * nothing when the place is not excluded or not known */
export function excludingTerms(t: VenueTerms, place: Place): VenueTerms | undefined {
  return judge(t, place).by;
}

/** the exchanges, by their live:exchange:<id>, that have an entry here */
const EXCHANGES = new Set(["okx", "okxus", "kraken", "krakenfutures", "coinbase", "bybit", "binance", "binanceus", "kucoin", "kucoinfutures", "gate", "bitget", "mexc", "deribit"]);
/** the other connections, by the venue whose terms they are under; a connection that reads by address is its venue's too */
const CONNECTIONS: Record<string, string> = {
  "live:alpaca": "alpaca",
  "live:robinhood": "robinhood",
  "live:robinhood-crypto": "robinhood-crypto",
  "live:kalshi": "kalshi",
  "live:polymarket-us": "polymarket-us",
  "live:polymarket-trade": "polymarket",
  "live:polymarket": "polymarket",
  "live:hyperliquid-trade": "hyperliquid",
  "live:hyperliquid": "hyperliquid",
};

/** The terms a connection is under: live:exchange:<id> for the exchanges above, and the account's other live connections by name. A
 * connection without an entry (another exchange, a wallet read by address) has none */
export function termsFor(connector: string): VenueTerms | undefined {
  const exchange = /^live:exchange:([a-z0-9]+)$/.exec(connector)?.[1];
  const venue = exchange !== undefined ? (EXCHANGES.has(exchange) ? exchange : undefined) : Object.hasOwn(CONNECTIONS, connector) ? CONNECTIONS[connector] : undefined;
  return venue !== undefined && Object.hasOwn(VENUE_TERMS, venue) ? VENUE_TERMS[venue] : undefined;
}

/** A connection's terms as the list of accounts shows them (availability.ts's TermsLine): the venue's url, date and words — the words of
 * the entry that excludes the place when one does (a futures arm's parent) — its note, and whether they exclude the place: true, false, or
 * undefined (the place not known, or the page unread). The place is matched here and not kept or returned */
export function termsHere(connector: string, place: Place | undefined): { url: string; read: string; says: string; note?: string; via?: string; unread?: string; excludesHere: boolean | undefined; servesHere?: boolean | undefined } | undefined {
  const t = termsFor(connector);
  if (!t) return undefined;
  const excludesHere = place ? termsExclude(t, place) : undefined;
  const w = (place && excludesHere ? excludingTerms(t, place) : undefined) ?? t;
  // an allow-list that names the place, and nothing excluding it: the venue's own terms serve it (an edition is offered only then)
  const servesHere = t.serves ? (excludesHere === undefined ? undefined : !excludesHere) : undefined;
  return { url: w.url, read: w.read, says: w.says, ...(w.note ? { note: w.note } : {}), ...(w.via ? { via: w.via } : {}), ...(w.unread ? { unread: w.unread } : {}), excludesHere, ...(servesHere !== undefined ? { servesHere } : {}) };
}

/** Does a list of places (an edition's own "who it is for", availability.ts EDITIONS) name this place: true, false, or undefined when the
 * place is not known or the list names parts of its country and the part was not learned. The same matching as the terms above */
export function servesPlace(serves: string[], place: Place | undefined): boolean | undefined {
  const p = place ? codesOf(place) : undefined;
  if (!p) return undefined;
  const excluded = byList({ venue: "", name: "", url: "", read: "", says: "", serves }, p);
  return excluded === undefined ? undefined : !excluded;
}
