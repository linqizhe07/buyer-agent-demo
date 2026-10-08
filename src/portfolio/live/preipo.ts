/** PRE-IPO PERPETUALS: the one table of what makes a perpetual a contract on a PRIVATE company's implied valuation — the flag each venue's
 * own record carries, the unit each venue prices such a contract in, the companies under the names the venues give them, and what two
 * issuers say of their stock. public-markets.ts reads the venues keyless with it, exchange-trade.ts tags a connected key's markets with it,
 * explore.ts groups the rows with it. Nothing here is a price: every figure is read live from a venue.
 *
 * What such a contract is: a perpetual whose price the venue sets as the company's valuation scaled down — Bybit, listing ANTHROPICUSDT on
 * 13 July 2026: "one contract represents approximately one-billionth of the company's estimated market capitalization" — so a price of
 * 2,080 means a $2.08 trillion implied valuation, $1 of price for $1,000,000,000 of valuation. No share changes hands (OKX's own words:
 * "You do not hold any equity"). Every venue promises to rebase to per-share terms once a filing discloses the share count, and to convert
 * to a stock perpetual at the IPO; every one excludes US persons, and each says so in its own terms when a key connects.
 *
 * THE UNIT IS PER INSTRUMENT. OKX rebased its ANTHROPIC-USDT-SWAP and OPENAI-USDT-SWAP 10:1 on 30 June 2026 ($1 of price for
 * $10,000,000,000), and ONLY those two. Read live on 2026-10-06: OKX's ANTHROPIC was 214.51 against Gate's 2,139.8, Kraken Futures' 2,078.3,
 * Deribit's 2,078.8, KuCoin's 2,083.0 and MEXC's 2,074.9, and its OPENAI 171.36 against 1,630–1,680 elsewhere; its MOONSHOT-USDT-SWAP
 * (68.18) and OURA-USDT-SWAP (49.03), listed in August and September 2026, equal Kraken's PF_MOONSHOTXUSD 68.18 and PF_OURAXUSD 49.12 and
 * MEXC's 68.01 and 48.96 — so OKX prices them in the same unit as everyone else (for OURA that unit is one share: see below).
 *
 * Binance and Bybit say the $1,000,000,000 unit in their own words. Bybit, listing ANTHROPICUSDT and OPENAIUSDT on 13 July 2026: "Pre-Rebase:
 * 1 ANTHROPIC ≈ 1/1,000,000,000 of estimated market cap" (announcements.bybit.com, read 2026-10-08). Binance, listing ANTHROPICUSDT on 2 June
 * 2026: an "Estimated share count" of 1,000,000,000, the contract opening near "the assumed IPO price per share" (its announcement, read
 * 2026-10-08 through treeofalpha.com's copy: binance.com answers this machine with an empty 202). Neither can be read from here (Binance
 * answers 451, Bybit 403), and each may resize a contract once a filing gives the real share count, so their lines are judged against the
 * other venues' implied valuations like any venue's (live/explore.ts): one more than 10% from the median is set aside and said. Hyperliquid's
 * HIP-3 io:ANTH (EntropyIO's dex) priced 2,044.55 on 2026-10-08 against the six venues' median of 1,983.79 (OKX 204.38 in its ×10 unit,
 * Gate 2,036.51, Kraken 1,977.62, Deribit 1,979.86, KuCoin 1,987.72, MEXC 1,977.51), and io:OAI 1,644.65 against 1,606.78: the same unit.
 *
 * NOT RIGHT FOR OURA. trade.xyz writes of its xyz:OURA (POST /info perpAnnotation, 2026-10-08): "OURA references 1 share of Oura Inc. common
 * stock"; Bitget (320 million) and BloFin (320,945,459) size theirs on an estimated share count; every venue's OURA traded at 48.55–50.91 that
 * day, the per-share level of Oura's $40–44 IPO range. The $1,000,000,000 unit this table gives OURA therefore overstates its implied
 * valuation about threefold, at every venue alike, so the venues still agree with each other. So a company whose venues price one share per
 * contract has its own unit (PER_SHARE): the implied valuation is the price times the share count the venues size on, and the row's price in
 * live/explore.ts is that valuation divided by the same count.
 *
 * A venue's flag, read 2026-10-06 from its own public record (the same record the unified exchange library keeps as a market's `info`, so a
 * connected key's market is read by the same flag):
 *   OKX             GET /api/v5/public/instruments?instType=SWAP    ruleType "pre_market"
 *   Gate            GET /api/v4/futures/usdt/contracts/<name>        is_pre_market true AND contract_type "stocks" — its B200 and H100
 *                                                                    GPU-price indices and its BP token are "pre-market" too, not companies
 *   Kraken Futures  GET /derivatives/api/v3/instruments               category "Pre-IPO"
 *   Deribit         GET /api/v2/public/get_instruments?currency=any   underlying_type "preipo" (its SPCX, public since 12 June 2026, is "equity")
 *   KuCoin Futures  GET /api/v1/contracts/active                      marketStage "PRE_MARKET" AND assetClass "STOCK" (its BPUSDTM is PRE_MARKET CRYPTO)
 *   MEXC            GET /api/v1/contract/detail                       conceptPlate contains "mc-trade-zone-preipo"
 *   Hyperliquid     POST /info {"type":"perpCategories"}              category "preipo" (documented in its info endpoint; read 2026-10-08:
 *                                                                    io:ANTH, io:OAI, xyz:OURA and the delisted para:ANTH, vntl:ANTHROPIC,
 *                                                                    vntl:OPENAI, vntl:SPACEX). Anyone may deploy a HIP-3 market, so there
 *                                                                    the flag never stands alone: a market it files elsewhere ("stocks") is
 *                                                                    not one, and one it files as "preipo" is one only under a known name
 * An exchange with no flag read here is read by the companies' names alone, matched whole: Bitget and Phemex, and Binance and Bybit, whose
 * documented records carry none (read 2026-10-08: Binance's USDⓈ-M exchangeInfo documents contractType PERPETUAL, CURRENT_MONTH,
 * NEXT_MONTH, CURRENT_QUARTER, NEXT_QUARTER, PERPETUAL_DELIVERING and TRADIFI_PERPETUAL and gives underlyingType no list; Bybit's v5
 * instruments-info documents symbolType innovation, adventure, xstocks, commodity, stock, forex, ETF, mstocks, and isPreListing, its
 * pre-market for coins not yet launched).
 *
 * A company is one row across venues under the names they give it (ANTHROPIC; Deribit's ANTH; Kraken's ANTHROPICx; MEXC's KIMISTOCK for
 * Moonshot AI, whose displayNameEn MEXC writes as "MOONSHOT_USDT PERPETUAL"). A name no entry knows is still a pre-IPO contract when the
 * venue's flag says so, shown under the venue's own name for it (Gate's KIMI and QNTX on 2026-10-06). SpaceX is never one: public since
 * 12 June 2026 (Nasdaq SPCX), every "SpaceX pre-IPO" contract was converted.
 */

/** the category every pre-IPO perpetual carries, whatever the venue (the account's own word, like RWA_CATEGORY) */
export const PRE_IPO_CATEGORY = "Pre-IPO";
/** a pre-IPO row's `group.id` is `preipo:<company slug>` */
export const PRE_IPO_GROUP = "preipo:";

/** the dollars of implied company valuation one dollar of price stands for, everywhere but OKX's two rebased swaps */
export const PRE_IPO_PER_POINT = 1_000_000_000;
/** OKX's unit for the two swaps it rebased 10:1 on 30 June 2026 (see the top of this file) */
export const OKX_REBASED_PER_POINT = 10_000_000_000;
const OKX_REBASED: ReadonlySet<string> = new Set(["ANTHROPIC-USDT-SWAP", "OPENAI-USDT-SWAP"]);

/** companies whose venues price ONE SHARE per contract (they sized on a filing's share count), with that count: the implied valuation is the
 * price times it. Oura: trade.xyz, "OURA references 1 share of Oura Inc. common stock" (POST /info perpAnnotation, 2026-10-08); BloFin sizes
 * its contract on 320,945,459 shares and Bitget on about 320 million; every venue's OURA traded at 48.55–50.91 that day, the per-share
 * level of its $40–44 IPO range */
export const PER_SHARE: Readonly<Record<string, { shares: number; unit: string }>> = {
  oura: { shares: 320_945_459, unit: "one contract is one share of Oura Inc. common stock: the implied valuation is the price times the 320,945,459 shares the venues size on (BloFin's count; Bitget's about 320 million)" },
};

/** the venue's unit for a pre-IPO contract's price, in dollars of implied valuation per dollar of price, and the rule in words */
export interface PreIpoUnit {
  perPoint: number;
  unit: string;
}

const isOkxId = (exchangeId: string): boolean => exchangeId.toLowerCase().startsWith("okx") || exchangeId.toLowerCase() === "myokx";

/** the unit a venue prices one of its pre-IPO contracts in: `instrumentId` is the venue's own id for the contract (ANTHROPIC-USDT-SWAP) */
export function unitOf(exchangeId: string, instrumentId: string, company = ""): PreIpoUnit {
  const share = PER_SHARE[company];
  if (share) return { perPoint: share.shares, unit: share.unit };
  if (isOkxId(exchangeId) && OKX_REBASED.has(instrumentId.trim().toUpperCase())) return { perPoint: OKX_REBASED_PER_POINT, unit: "OKX: a price of $1 stands for $10,000,000,000 of implied company valuation since its 10:1 rebase of 30 June 2026" };
  return { perPoint: PRE_IPO_PER_POINT, unit: "a price of $1 stands for $1,000,000,000 of implied company valuation (one contract ≈ one-billionth of the company)" };
}

/** the valuation a price implies, in whole dollars */
export const impliedUsd = (price: number, perPoint: number): number => Math.round(price * perPoint);

export interface PreIpoCompany {
  slug: string;
  name: string;
  /** the bases venues give it, upper case (a venue's trailing "x" or "STOCK" is read off before matching) */
  aliases: readonly string[];
}

/** the companies, under the names the venues used on 2026-10-06 (OKX, Gate, Kraken Futures, Deribit, KuCoin Futures, MEXC, and Bitget's,
 * Phemex's, Binance's and Bybit's symbols as the exchanges list them) and on 2026-10-08 (Hyperliquid's HIP-3 io:ANTH, io:OAI, xyz:OURA) */
export const PRE_IPO_COMPANIES: readonly PreIpoCompany[] = [
  { slug: "anthropic", name: "Anthropic", aliases: ["ANTHROPIC", "ANTH"] },
  { slug: "openai", name: "OpenAI", aliases: ["OPENAI", "OAI"] },
  { slug: "anduril", name: "Anduril", aliases: ["ANDURIL"] },
  { slug: "neuralink", name: "Neuralink", aliases: ["NEURALINK"] },
  { slug: "figureai", name: "Figure AI", aliases: ["FIGUREAI"] },
  { slug: "kalshi", name: "Kalshi", aliases: ["KALSHI"] },
  { slug: "polymarket", name: "Polymarket", aliases: ["POLYMARKET"] },
  { slug: "oura", name: "Oura", aliases: ["OURA"] },
  { slug: "moonshot", name: "Moonshot AI (Kimi)", aliases: ["MOONSHOT", "KIMISTOCK"] },
  { slug: "ymtc", name: "YMTC", aliases: ["YMTC"] },
];

/** never a pre-IPO contract, whatever a venue's record says: SpaceX is public since 12 June 2026 (Nasdaq SPCX) */
export const NEVER_PRE_IPO: ReadonlySet<string> = new Set(["SPACEX", "SPCX"]);

/** the names Gate is asked about one by one (its full contract list is 1.3 MB uncompressed): each company's first alias, as Gate spells its
 * contracts (`<NAME>_USDT`, 2026-10-06) */
export const PRE_IPO_NAMES: readonly string[] = PRE_IPO_COMPANIES.map((c) => c.aliases[0]!);

const BY_ALIAS: ReadonlyMap<string, PreIpoCompany> = new Map(PRE_IPO_COMPANIES.flatMap((c) => c.aliases.map((a) => [a, c] as const)));

/** the company a venue's base names: a known one (`known`), or the venue's own name for one the table does not know. `undefined` for a
 * company that is public now (SpaceX) */
export function companyOf(base: string): { slug: string; name: string; known: boolean } | undefined {
  const up = base.trim().toUpperCase();
  if (!up) return undefined;
  // MEXC writes OURASTOCK, Kraken Futures ANTHROPICx: the suffix is the venue's, not the company's
  const forms = [up, up.replace(/STOCK$/, ""), up.replace(/X$/, "")].filter((f) => f.length > 0);
  if (forms.some((f) => NEVER_PRE_IPO.has(f))) return undefined;
  for (const f of forms) {
    const c = BY_ALIAS.get(f);
    if (c) return { slug: c.slug, name: c.name, known: true };
  }
  return { slug: up.toLowerCase().replace(/[^a-z0-9]+/g, "-"), name: base.trim(), known: false };
}

/** what two issuers say of their stock, in their own words, for the rows that stand for them (the same two fields a tokenised share
 * carries, trade.ts `issuer`/`eligibility`) */
export const PRE_IPO_ISSUERS: Readonly<Record<string, { issuer: string; eligibility: string }>> = {
  // support.claude.com/en/articles/13704655-unauthorized-anthropic-stock-sales-and-investment-scams, first published 2026-02-11, updated 2026-06-29
  anthropic: { issuer: "Anthropic", eligibility: 'Anthropic, 29 June 2026: "Any sale or transfer of Anthropic stock, or any interest in Anthropic stock, that has not been approved by our Board of Directors is void and will not be recognized on our books and records."' },
  // openai.com/policies/unauthorized-openai-equity-transactions, read 2026-10-06
  openai: { issuer: "OpenAI", eligibility: 'OpenAI: its equity "cannot be directly or indirectly transferred unless the seller first obtains OpenAI\'s written consent" — "tokenized interests in OpenAI equity or an SPV holding OpenAI equity" included.' },
};

type Rec = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);
const yes = (v: unknown): boolean => v === true || v === "true";

/** what the venue's own record says: true, a pre-IPO contract; false, not one; `undefined`, the venue has no flag this file reads (or the
 * record is not one that carries it) */
export function preIpoFlag(exchangeId: string, info: Rec): boolean | undefined {
  const id = exchangeId.toLowerCase();
  if (isOkxId(id)) return str(info.ruleType) === undefined ? undefined : info.ruleType === "pre_market";
  if (id === "gate" || id === "gateio") return info.is_pre_market === undefined ? undefined : yes(info.is_pre_market) && str(info.contract_type) === "stocks";
  if (id === "krakenfutures") return str(info.category) === undefined ? undefined : info.category === "Pre-IPO";
  if (id === "deribit") return str(info.underlying_type) === undefined ? undefined : info.underlying_type === "preipo";
  if (id === "kucoinfutures") return str(info.marketStage) === undefined ? undefined : info.marketStage === "PRE_MARKET" && str(info.assetClass) === "STOCK";
  if (id === "mexc") return Array.isArray(info.conceptPlate) ? info.conceptPlate.some((c) => typeof c === "string" && c.toLowerCase().includes("preipo")) : undefined;
  // Hyperliquid's own category for a market (perpCategories), carried on the record as `category`
  if (id === "hyperliquid") return str(info.category) === undefined ? undefined : info.category === "preipo";
  return undefined;
}

/** venues anyone may list a market on (Hyperliquid's HIP-3 deployers): their flag can rule a market out, never in on its own — a company's
 * name the table knows decides */
const NAMED_ONLY: ReadonlySet<string> = new Set(["hyperliquid"]);

/** what a pre-IPO perpetual's market carries beyond a plain perpetual's fields */
export interface PreIpoMark {
  slug: string;
  name: string;
  category: typeof PRE_IPO_CATEGORY;
  group: { id: string; title: string };
  implied: PreIpoUnit;
  issuer?: string | undefined;
  eligibility?: string | undefined;
}

/** a perpetual read as a pre-IPO contract, or not: by the venue's flag where it has one (the flag alone decides there — except at a venue
 * anyone may list on, where it only rules out), else by the company's name matched whole. `info` is the venue's own record (a library
 * market's `info`, or the REST record), `base` the venue's base, `instrumentId` the venue's id for the contract (for OKX's per-instrument
 * unit) */
export function preIpoOf(exchangeId: string, info: Rec | undefined, base: string, instrumentId: string): PreIpoMark | undefined {
  const flag = preIpoFlag(exchangeId, info ?? {});
  if (flag === false) return undefined;
  const company = companyOf(base);
  if (!company) return undefined;
  if ((flag === undefined || NAMED_ONLY.has(exchangeId.toLowerCase())) && !company.known) return undefined;
  const said = PRE_IPO_ISSUERS[company.slug];
  return { slug: company.slug, name: company.name, category: PRE_IPO_CATEGORY, group: { id: `${PRE_IPO_GROUP}${company.slug}`, title: company.name }, implied: unitOf(exchangeId, instrumentId, company.slug), ...(said ? { issuer: said.issuer, eligibility: said.eligibility } : {}) };
}

/** a market that is a pre-IPO perpetual, by the category every one carries */
export const isPreIpoMarket = (m: { kind: string; category?: string | undefined }): boolean => m.kind === "perp" && m.category === PRE_IPO_CATEGORY;
