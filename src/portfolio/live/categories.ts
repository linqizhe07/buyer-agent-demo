/** The Markets screen's tabs, and the ONE table that turns a venue's own category words into the two tabs made from them: Macro and Sports.
 *
 * Each venue files an event under its own words: Kalshi gives an event a category ("Economics", "Sports", "Financials"), Polymarket gives
 * it tags ("Sports", "NFL", "Fed Rates", "Economy"). The table below is the only place those words are read. A word is matched whole, without
 * regard to case, punctuation or "&" for "and": "Fed Rates" and "fed-rates" are one word, while "Macro Election 2" (a Polymarket tag about
 * elections) is not "macro". A category no row names stays in Predictions only, under its own words.
 *
 * The other tabs come from what a market is, not from its category: a coin is Crypto, a stock Stocks, a token that stands for a share or a
 * fund RWAs, a perpetual Perps, an event contract Predictions. Now is made by the aggregator (explore.ts): what closes within a day, what
 * moves, what trades most.
 *
 * A token is an RWA when its source lists tokens that stand for shares (Robinhood's public Stock Token list), or when the market itself
 * says so: a wallet's swap market for a token an issuer stands behind — a Robinhood Stock Token, an Ondo Stock, an xStock, a fund token
 * (dex.ts) — carries the category RWA_CATEGORY. That word is the account's own, not a venue's, so no row of the table below names it.
 */

/** the category a market carries when it is a token an issuer stands behind (dex.ts), whatever the venue that lists it */
export const RWA_CATEGORY = "RWA";

/** a token market that says it stands for a share or a fund */
export const isRwaMarket = (m: { kind: string; category?: string | undefined }): boolean => m.kind === "token" && m.category === RWA_CATEGORY;

export type TabId = "now" | "crypto" | "stocks" | "rwas" | "predictions" | "perps" | "macro" | "sports";
export type CategoryTab = "macro" | "sports";

/** every tab, in the order the screen shows them; a tab with nothing in it is not shown */
export const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: "now", label: "Now" },
  { id: "crypto", label: "Crypto" },
  { id: "stocks", label: "Stocks" },
  { id: "rwas", label: "RWAs" },
  { id: "predictions", label: "Predictions" },
  { id: "perps", label: "Perps" },
  { id: "macro", label: "Macro" },
  { id: "sports", label: "Sports" },
];

/** a venue's category or tag, as it is matched: lower case, "&" as "and", anything but letters and digits as one space */
export const normalWords = (words: string): string =>
  words
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** THE table: which of a venue's own category words (Kalshi's event categories, Polymarket's tag labels and slugs) make an event Macro or
 * Sports. Kalshi files rate, inflation and jobs markets under Economics, and index, yield and currency markets under Financials */
export const CATEGORY_TABS: ReadonlyArray<{ tab: CategoryTab; words: readonly string[] }> = [
  {
    tab: "macro",
    words: ["economics", "economy", "financials", "fed", "fed rates", "fomc", "interest rates", "inflation", "cpi", "jobs", "jobs report", "unemployment", "gdp", "recession", "macro indicators", "treasuries", "tariffs"],
  },
  {
    tab: "sports",
    words: ["sports", "nfl", "nfl all", "nba", "wnba", "mlb", "nhl", "mls", "soccer", "football", "basketball", "baseball", "hockey", "tennis", "golf", "ufc", "mma", "boxing", "f1", "formula 1", "cricket", "epl", "premier league", "champions league", "ucl", "la liga", "serie a", "bundesliga", "ligue 1", "college football", "cfb", "ncaa", "ncaab", "cbb", "olympics", "world cup", "esports", "nascar"],
  },
];

const BY_WORD: ReadonlyMap<string, CategoryTab> = new Map(CATEGORY_TABS.flatMap((row) => row.words.map((w) => [normalWords(w), row.tab] as const)));

/** the tab one of a venue's category words makes, if the table names it */
export const tabOfCategory = (words: string): CategoryTab | undefined => BY_WORD.get(normalWords(words));

/** the tabs a venue's words make together: an event tagged "Sports" and "NFL" is Sports once */
export function tabsOfCategories(words: ReadonlyArray<string | undefined>): Set<CategoryTab> {
  const out = new Set<CategoryTab>();
  for (const w of words) {
    const t = typeof w === "string" ? tabOfCategory(w) : undefined;
    if (t) out.add(t);
  }
  return out;
}

/** the venue's words shown for an event: the first the table names (so that an event tagged "Games, Sports" reads "Sports"), else the first */
export function categoryOf(words: ReadonlyArray<string | undefined>): string | undefined {
  const given = words.filter((w): w is string => typeof w === "string" && w.trim() !== "").map((w) => w.trim());
  return given.find((w) => tabOfCategory(w) !== undefined) ?? given[0];
}
