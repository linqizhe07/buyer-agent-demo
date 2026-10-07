/** The Markets screen's tabs, the ONE table of a venue's own category words, and the Kalshi series the public read is made of.
 *
 * Each venue files an event under its own words: Kalshi gives an event a category ("Economics", "Sports", "Financials"), Polymarket gives
 * it tags ("Sports", "NFL", "Fed Rates", "Economy", and housekeeping tags such as "Hide From New" or "Parent For Derivative"). The table
 * below is the only place those words are read, and it says three things about a word: that an event carrying it is LEFT OUT of the
 * public listings (sports, esports, weather, entertainment, celebrity and "will X say" markets — the gambling-flavoured corners the owner
 * asked not to see), that it is SHOWN as a row's category when the event carries it, or that it is the venue's own PLUMBING and never
 * shown. A word is matched whole, without regard to case, punctuation or "&" for "and": "Fed Rates" and "fed-rates" are one word, while
 * "Macro Election 2" (a Polymarket tag about elections) is not "macro". A word no row names is shown as the venue gives it, when nothing
 * better is there.
 *
 * The tabs come from what a market is, not from its category: a coin is Crypto, a stock Stocks, a token that stands for a share or a fund
 * RWAs, a perpetual Perps, a pre-IPO perpetual — a contract on a private company's implied valuation (live/preipo.ts) — Pre-IPO and not
 * Perps, an event contract Predictions (an IPO question among them). All is every row as one table; what closes within a day, what moves
 * and what trades most are still worked out by the aggregator (explore.ts) for the body, for agents. Predictions is a few of the busiest
 * markets, not every market a venue has: the public sources (public-markets.ts) read Kalshi by the series named below and Polymarket by
 * 24-hour volume, leave out every event carrying an excluded word, and the aggregator shows at most a dozen of them, each venue's busiest
 * in turn, and the IPO questions beside them.
 *
 * A token is an RWA when its source lists tokens that stand for shares (Robinhood's public Stock Token list), or when the market itself
 * says so: a wallet's swap market for a token an issuer stands behind — a Robinhood Stock Token, an Ondo Stock, an xStock, a fund token
 * (dex.ts) — carries the category RWA_CATEGORY. That word is the account's own, not a venue's, so no row of the table below names it.
 */

/** the category a market carries when it is a token an issuer stands behind (dex.ts), whatever the venue that lists it */
export const RWA_CATEGORY = "RWA";

/** a token market that says it stands for a share or a fund */
export const isRwaMarket = (m: { kind: string; category?: string | undefined }): boolean => m.kind === "token" && m.category === RWA_CATEGORY;

export type TabId = "all" | "crypto" | "stocks" | "rwas" | "perps" | "preipo" | "predictions";

/** every tab, in the order the screen shows them; a tab with nothing in it is not shown. All is first and holds every row (each row's `tabs`
 * starts with it); the page adds its own Watching after these */
export const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: "all", label: "All" },
  { id: "crypto", label: "Crypto" },
  { id: "stocks", label: "Stocks" },
  { id: "rwas", label: "RWAs" },
  { id: "perps", label: "Perps" },
  { id: "preipo", label: "Pre-IPO" },
  { id: "predictions", label: "Predictions" },
];

/** a venue's category or tag, as it is matched: lower case, "&" as "and", anything but letters and digits as one space */
export const normalWords = (words: string): string =>
  words
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** what the table says of a word: shown as a row's category, the event left out, or the venue's plumbing */
export type CategoryRole = "shown" | "excluded" | "plumbing";

/** THE table. The shown words are in the order one is preferred when an event carries several (Polymarket's "Fed Decision in October?" carries
 * Fed, fomc, Trump, Economy and Fed Rates: it reads "Fed Rates"). Kalshi files rate, inflation and jobs markets under Economics, and index,
 * yield and currency markets under Financials. The excluded words are every league and sport Polymarket and Kalshi tag, weather, and the
 * entertainment, celebrity, awards and "will X say or post" corners. The plumbing words are Polymarket's housekeeping tags, read from its
 * live events on 2026-10-06 ("Parent For Derivative", "Hide From New", "Recurring", "Daily", "Multi Strikes", "Hit Price", "Rewards 20",
 * "Earn 3.25%", "1H", "Daily-Close" …) */
export const CATEGORY_WORDS: ReadonlyArray<{ role: CategoryRole; words: readonly string[] }> = [
  {
    role: "shown",
    words: [
      "fed rates", "fed", "fomc", "interest rates", "global rates", "inflation", "cpi", "jobs", "jobs report", "unemployment", "gdp", "recession", "tariffs", "treasuries", "macro indicators", "economic policy",
      // an IPO question reads "IPO" (Polymarket's tag) or "IPOs" (Kalshi's series tag) before the broader Finance or Companies it also carries
      "ipo", "ipos",
      "economics", "economy", "financials", "finance", "business", "companies", "stocks", "equities", "indices", "indicies", "commodities", "oil", "gold",
      "crypto", "crypto prices", "bitcoin", "ethereum", "politics", "elections", "us election", "global elections", "geopolitics", "world", "tech", "ai", "science", "science and technology", "health",
    ],
  },
  {
    role: "excluded",
    words: [
      "sports", "esports", "e sports", "games", "gaming", "video games", "nfl", "nfl all", "nba", "wnba", "mlb", "nhl", "mls", "soccer", "football", "basketball", "baseball", "hockey", "tennis", "golf", "ufc", "mma", "boxing", "f1", "formula 1", "cricket", "epl", "premier league", "champions league", "ucl", "la liga", "serie a", "bundesliga", "ligue 1", "college football", "cfb", "ncaa", "ncaab", "cbb", "olympics", "world cup", "nascar", "counter strike 2", "dota 2", "league of legends", "valorant",
      "weather", "climate", "climate and weather", "temperature", "daily temperature", "highest temperature", "lowest temperature", "rain",
      "entertainment", "pop culture", "culture", "celebrities", "celebrity", "awards", "music", "movies", "tv", "television", "streaming", "live streams", "mentions", "mention markets", "tweet markets", "tweets", "social media",
    ],
  },
  {
    role: "plumbing",
    words: ["parent for derivative", "hide from new", "recurring", "daily", "weekly", "monthly", "yearly", "hourly", "today", "up or down", "daily close", "multi strikes", "hit price", "main election", "pre market", "finance updown", "pyth finance", "equity daily pyth", "rewards", "earn"],
  },
];

const BY_WORD: ReadonlyMap<string, CategoryRole> = new Map(CATEGORY_WORDS.flatMap((row) => row.words.map((w) => [normalWords(w), row.role] as const)));
/** the words preferred as a row's category, in order: the shown words, then the excluded ones (a connected venue's own sports event still
 * reads "Sports" before "Games"); plumbing is never one */
const PREFERRED: readonly string[] = ["shown", "excluded"].flatMap((role) => CATEGORY_WORDS.find((r) => r.role === role)!.words.map(normalWords));

/** what the table says of one of a venue's words, if it names it */
export const roleOfCategory = (words: string): CategoryRole | undefined => BY_WORD.get(normalWords(words));

/** a venue's housekeeping tag: one the table names as plumbing, a rewards or earn tag with its figure ("Rewards 20", "Earn 3.25%"), a
 * window ("1H", "4H", "15M"), or one with no letters at all ("4.5", "50") */
export function isPlumbingTag(tag: string): boolean {
  const n = normalWords(tag);
  return !n || BY_WORD.get(n) === "plumbing" || /^(rewards|earn)( |$)/.test(n) || /^\d+ ?[mh]$/.test(n) || !/[a-z]/.test(n);
}

/** an event whose venue files it under any excluded word is left out of the public listings */
export function isExcludedCategory(words: ReadonlyArray<string | undefined>): boolean {
  return words.some((w) => typeof w === "string" && roleOfCategory(w) === "excluded");
}

/** an IPO question: a venue's word for it is "IPO" (Polymarket) or "IPOs" (Kalshi). Such an event stays in Predictions beside the busiest
 * few (explore.ts), so the Pre-IPO company drawer can name it */
export function isIpoCategory(words: ReadonlyArray<string | undefined>): boolean {
  return words.some((w) => typeof w === "string" && ["ipo", "ipos"].includes(normalWords(w)));
}

/** a word in title case when the venue wrote it all in lower case ("putin" reads "Putin"); a venue's own capitals stay ("Fed Rates", "UCL") */
const titleCased = (w: string): string => (/[A-Z]/.test(w) ? w : w.replace(/(^|\s)([a-z])/g, (_, s: string, c: string) => `${s}${c.toUpperCase()}`));

/** the venue's words shown for an event: the word the table prefers among those the event carries, else the first word that is not the
 * venue's plumbing — in the venue's own spelling, title-cased when it wrote it in lower case */
export function categoryOf(words: ReadonlyArray<string | undefined>): string | undefined {
  const given = words.filter((w): w is string => typeof w === "string" && w.trim() !== "").map((w) => w.trim());
  for (const preferred of PREFERRED) {
    const hit = given.find((w) => normalWords(w) === preferred);
    if (hit) return titleCased(hit);
  }
  const plain = given.find((w) => !isPlumbingTag(w));
  return plain === undefined ? undefined : titleCased(plain);
}

/** THE KALSHI SERIES the public read is made of (public-markets.ts), each read with one small GET /events?series_ticker=&status=open&
 * with_nested_markets=true, and shown as its busiest market: a few of Kalshi's busiest subjects that are finance, not sport. Each was
 * checked keyless on 2026-10-06: open events with their 24-hour contracts summed were Fed decision 235,185 (its "Fed maintains rate" market
 * alone 151,859), CPI 9,816, CPI year on year 20,060, GDP 474 (the Q3 release is weeks away), jobs 53,861, bitcoin at 5pm 1,237,339,
 * S&P 500 14,862, Nasdaq-100 5,533, 2028 Democratic nominee 760,259, Trump approval 16,584. Left out that day: KXUNRATE, KXTNOTE,
 * KXRECESSION and KXPRESAPPROVAL, which Kalshi answers with no open event at all; KXFED (294 contracts); KXBTC, KXETH and KXETHD, the
 * bitcoin range twin and the ether ladders (42,000, 71,000 and 34,000 contracts for bodies of 600–750 KB each). `word` is how the note
 * under the list names the series.
 *
 * The two IPO series (for the Pre-IPO company drawer): KXIPOANTHROPIC — "When will Anthropic officially announce an IPO?", 12 markets,
 * 8,167 contracts a day, 23 KB — and KXIPOOPENAI — "When will OpenAI officially announce an IPO?", 11 markets, 237 contracts, 20.6 KB
 * (both checked keyless on 2026-10-06; `series_ticker=KXIPOANTHROPIC-DATE` answers nothing, the series root answers). `tags` is how Kalshi
 * itself files a series (GET /trade-api/v2/series/<ticker>, 2026-10-06: both "IPOs", "Companies"), carried where it says more than the
 * event's own category (Companies, Economics) so the card reads Kalshi's "IPOs"; the other series carry none and keep the event's word */
export const KALSHI_SERIES: ReadonlyArray<{ ticker: string; word: string; tags?: readonly string[] | undefined }> = [
  { ticker: "KXFEDDECISION", word: "Fed decision" },
  { ticker: "KXCPI", word: "CPI" },
  { ticker: "KXCPIYOY", word: "CPI YoY" },
  { ticker: "KXGDP", word: "GDP" },
  { ticker: "KXPAYROLLS", word: "jobs" },
  { ticker: "KXBTCD", word: "bitcoin" },
  { ticker: "KXINX", word: "S&P 500" },
  { ticker: "KXNASDAQ100", word: "Nasdaq-100" },
  { ticker: "KXPRESNOMD", word: "2028 Dem nominee" },
  { ticker: "KXTRUMPAPPROVE", word: "Trump approval" },
  { ticker: "KXIPOANTHROPIC", word: "Anthropic IPO", tags: ["IPOs", "Companies"] },
  { ticker: "KXIPOOPENAI", word: "OpenAI IPO", tags: ["IPOs", "Companies"] },
];
