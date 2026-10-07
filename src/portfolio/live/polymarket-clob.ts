/** TRADING at Polymarket: orders on its CLOB, signed by the account wallet's key (docs.polymarket.com and the official clients
 * clob-client-v2, py-clob-client-v2 and @polymarket/client, read 2026-10-05).
 *
 * Polymarket moved to CLOB V2 on 2026-04-28: pUSD is the collateral, the signed Order lost taker, expiration, nonce and feeRateBps and
 * gained timestamp, metadata and builder, and the exchange's EIP-712 domain went from version "1" to "2" (V1-signed orders are refused).
 * Markets of its newer position system ("Protocol V2", Gamma `version: "v2"`) settle on ExchangeV3 and sign with domain version "3". This
 * file speaks those two and nothing older.
 *
 *   GET  polymarket.com/api/geoblock   whether Polymarket serves the place this machine is in: asked before connecting and before every
 *                                     order. Blocked is Polymarket's own rule; the answer is that, and nothing here looks for a way around it
 *   GET  /auth/derive-api-key          the CLOB credentials of the signer, on an EIP-712 ClobAuth signature (L1); POST /auth/api-key makes
 *                                     them the first time. They are kept in this process's memory and written nowhere
 *   GET  gamma /markets/slug/{slug}    a market by its name: its outcomes and their ids, neg-risk, whether it takes orders
 *   GET  gamma /markets/keyset         the markets to choose from (by 24-hour volume, kept five minutes), and a token's market by condition id
 *   GET  /book?token_id=               the book: best bid and ask, the tick, the smallest order, neg-risk
 *   POST /order                        one signed order, with the L2 headers: an HMAC over the exact body sent. Its `orderType` is the time
 *                                     in force (GTC, FAK or FOK), and an order that rests (GTC) may say `postOnly`
 *   GET  /data/order/{id}              what became of it; GET /data/trades?market= for the prices it filled at
 *   DELETE /order                      cancel it
 *   GET  data-api /v2/positions?user=  what the wallet holds, outcome by outcome
 *   GET  gamma /events                 event contracts to discover: the open events, busiest first, with their markets and tags
 *   GET  /prices-history?market=       an outcome's price history, by its token id
 *
 * The last two only read: like Gamma and the book, they need no credentials, and the location check stays where it is, before every order.
 *
 * Money IN, for the owner's Receive (polymarketWriter; docs.polymarket.com/trading/bridge and /concepts/pusd, read 2026-10-06), keyless:
 *   pUSD on Polygon                    straight to the wallet the orders are made by (`maker`): pUSD is "a standard ERC-20 token on Polygon",
 *                                      and that wallet's pUSD is the cash the account reads here
 *   POST bridge.polymarket.com/deposit {address: maker} → address.evm: the bridge address unique to that wallet, one for every EVM chain;
 *                                      what is sent to it "is bridged and swapped to pUSD automatically" and credited to the wallet
 *   GET  bridge.polymarket.com/supported-assets   the chains and tokens it takes, with the least it takes ("Deposits below the minimum will
 *                                      not be processed"): asked before an address is given, and the token checked against the one the
 *                                      account would send
 * Money OUT is not made from here: the CLOB has no withdrawal call, and the bridge's withdrawal is a pUSD transfer the Polymarket wallet
 * itself sends ("Send pUSD from your Polymarket wallet to the appropriate bridge address") — a transaction this account does not sign with
 * the key file's key. The writer says so (`can.why.withdraw`).
 *
 * What the CLOB does not have is not offered: no stop or trigger order, no reduce-only flag, no leverage, and no change to an open order in
 * place (/order takes POST and DELETE only: an order is signed, so another price or size is another order). Its GTD order, good until a
 * date the owner names, has no counterpart among the account's times in force.
 *
 * Who signs: the key file holds the signer's private key. When the money sits in a Polymarket wallet (the address in the profile menu),
 * the file also names that wallet (`funderAddress`) and its kind (`signatureType`): 1 a Proxy wallet, 2 a Safe, 3 a Deposit Wallet (every
 * account made since 2026-05-04). The wallet is the order's maker; the key's own address authenticates. Session keys and builder keys are
 * not used here: a session key needs a Builder API key that Polymarket enables by hand, and this connection signs as the owner.
 *
 * Fees are not in the order: Polymarket charges a taker at match time. The positions and the cash are read as the address connection reads
 * them (address.ts), for the wallet that holds the money.
 */
import { createHmac, randomBytes } from "node:crypto";
import { concatHex, encodeAbiParameters, getAddress, hashStruct, hashTypedData, isAddress, keccak256, toHex, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { isRefusal, type Refusal } from "../../core/errors.ts";
import { no } from "../refuse.ts";
import { polymarketSource } from "./address.ts";
import { CHAINS, type ChainName, type ChainReader } from "./chain.ts";
import type { KeyFile, KeyShape } from "./credentials.ts";
import { badOrder, ceilTo, floorTo, inDollars, pick, plain, type Candle, type CandleInterval, type LiveTrader, type Market, type OrderRequest, type OrderState, type OrderStatus, type Position, type TimeInForce } from "./trade.ts";
import { asRefusal, num, REGION, redact, unreachable, type Http, type HttpReply, type LiveBalance, type LiveSource } from "./types.ts";
import { tokenOn, type LiveWriter } from "./writes.ts";

export const POLYMARKET_TRADE_KEY: KeyShape = {
  required: ["privateKey"],
  optional: ["funderAddress", "signatureType"],
  example: '{"privateKey": "0x…"} — and when the money sits in a Polymarket wallet, "funderAddress": "0x…" (the address in the profile menu) with "signatureType": "1" (Proxy), "2" (Safe) or "3" (Deposit Wallet)',
};

const CLOB = "https://clob.polymarket.com";
const GAMMA = "https://gamma-api.polymarket.com";
const DATA = "https://data-api.polymarket.com/v2";
const GEOBLOCK = "https://polymarket.com/api/geoblock";
const CHAIN_ID = 137;
/** Polygon, from docs.polymarket.com/resources/contracts and the clients' configs (all four agree). The V1 exchanges (domain "1") are dead */
const EXCHANGE = {
  standard: "0xE111180000d2663C0091e4f400237545B87B996B",
  negRisk: "0xe2222d279d744050d28e00520010520000310F59",
  v3: "0xe3333700cA9d93003F00f0F71f8515005F6c00Aa",
} as const;
const DOMAIN_NAME = "Polymarket CTF Exchange";
const ZERO32: Hex = `0x${"00".repeat(32)}`;
/** the V2 Order, field by field in the order it is signed */
const ORDER = [
  { name: "salt", type: "uint256" },
  { name: "maker", type: "address" },
  { name: "signer", type: "address" },
  { name: "tokenId", type: "uint256" },
  { name: "makerAmount", type: "uint256" },
  { name: "takerAmount", type: "uint256" },
  { name: "side", type: "uint8" },
  { name: "signatureType", type: "uint8" },
  { name: "timestamp", type: "uint256" },
  { name: "metadata", type: "bytes32" },
  { name: "builder", type: "bytes32" },
] as const;
const ORDER_TYPE = "Order(uint256 salt,address maker,address signer,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint8 side,uint8 signatureType,uint256 timestamp,bytes32 metadata,bytes32 builder)";
/** what a Deposit Wallet's owner signs: the order wrapped for the wallet's ERC-1271 check (ERC-7739) */
const TYPED_DATA_SIGN = [
  { name: "contents", type: "Order" },
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
  { name: "salt", type: "bytes32" },
] as const;
const CLOB_AUTH = [
  { name: "address", type: "address" },
  { name: "timestamp", type: "string" },
  { name: "nonce", type: "uint256" },
  { name: "message", type: "string" },
] as const;
const ATTEST = "This message attests that I control the given wallet";

/** the clients' rounding table, by tick: decimals of a price, a size in shares, and an amount (all on-chain amounts have six decimals) */
const ROUNDING: Array<{ tick: number; price: number; size: number; amount: number }> = [
  { tick: 0.1, price: 1, size: 2, amount: 3 },
  { tick: 0.01, price: 2, size: 2, amount: 4 },
  { tick: 0.005, price: 3, size: 2, amount: 5 },
  { tick: 0.0025, price: 4, size: 2, amount: 6 },
  { tick: 0.001, price: 3, size: 2, amount: 5 },
  { tick: 0.0001, price: 4, size: 2, amount: 6 },
];
const roundingOf = (tick: number) => ROUNDING.find((r) => Math.abs(r.tick - tick) < 1e-12);

/** The CLOB's order types, which its OpenAPI calls the time in force, in the account's words (docs.polymarket.com/concepts/order-lifecycle):
 * GTC rests until it fills or is canceled; FAK, fill and kill, fills what it can at once and cancels the rest, which is the account's
 * immediate-or-cancel (except that a FAK matching nothing is refused, not canceled: error-codes, "FAK orders are partially filled or killed
 * if no match is found"); FOK fills all of it at once or none of it. GTD is left out (see above), and no Polymarket market has a session
 * for a `day` order to end with */
type ClobOrderType = "GTC" | "FAK" | "FOK";
const TIF: Partial<Record<TimeInForce, ClobOrderType>> = { gtc: "GTC", ioc: "FAK", fok: "FOK" };
const TIFS_HERE: TimeInForce[] = ["gtc", "ioc", "fok"];

const LIST_MS = 5 * 60_000;
/** what market() learned about a symbol is used by place() for this long; the price a market order may fill at comes with the order */
const KNOWN_MS = 60_000;
const TOKEN = /^\d{10,90}$/;
const SLUG = /^[a-z0-9][a-z0-9-]*$/i;
/** The prices a bar is folded from: one-minute prices make five-minute bars, five-minute prices hourly ones, hourly prices daily ones
 * (`fidelity` is in minutes). Polymarket refuses a range too long for its fidelity ("'startTs' and 'endTs' interval is too long", OBSERVED
 * for forty days of one-minute prices) */
const FIDELITY_MIN: Record<CandleInterval, number> = { "5m": 1, "1h": 5, "1d": 60 };
const BAR_MS: Record<CandleInterval, number> = { "5m": 5 * 60_000, "1h": 3_600_000, "1d": 86_400_000 };
/** the longest startTs-to-endTs range /prices-history takes: fourteen days, under the fifteen or so it answers (OBSERVED 2026-10-05) */
const HISTORY_RANGE_MS = 14 * 86_400_000;
/** a category as Gamma's tag slug: "Climate & Science" → climate-science */
const tagSlug = (category: string): string =>
  category
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
const ORDER_ID = /^0x[0-9a-fA-F]{64}$/;

type Json = Record<string, unknown>;
type SigType = 0 | 1 | 2 | 3;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const positive = (v: unknown): number | undefined => (num(v) > 0 ? num(v) : undefined);
/** Gamma sends some lists as JSON-encoded strings (`outcomes`, `clobTokenIds`) and others as arrays (`positionIds`) */
const list = (v: unknown): unknown[] => {
  if (Array.isArray(v)) return v;
  if (typeof v !== "string") return [];
  try {
    const p = JSON.parse(v) as unknown;
    return Array.isArray(p) ? p : [];
  } catch {
    return [];
  }
};
const SIG_NAME: Record<SigType, string> = { 0: "EOA", 1: "Proxy wallet (POLY_PROXY)", 2: "Safe wallet (POLY_GNOSIS_SAFE)", 3: "Deposit Wallet (POLY_1271)" };
const SIG_WORDS: Record<string, SigType> = { "0": 0, eoa: 0, "1": 1, poly_proxy: 1, proxy: 1, "2": 2, poly_gnosis_safe: 2, gnosis_safe: 2, safe: 2, "3": 3, poly_1271: 3, deposit_wallet: 3, deposit: 3 };

// ---- the L2 signature -------------------------------------------------------------------------------

/** Polymarket's L2 HMAC: the seconds, the method, the path without its query, and the exact body sent, keyed by the base64 secret; the
 * result is URL-safe base64 that keeps its "=" padding */
export function polyHmac(secret: string, seconds: number, method: string, path: string, body?: string): string {
  const key = Buffer.from(secret.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  return createHmac("sha256", key)
    .update(`${seconds}${method}${path}${body ?? ""}`)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

// ---- amounts ---------------------------------------------------------------------------------------

const SCALE = 1_000_000n;
const quantum = (decimals: number): bigint => 10n ** BigInt(6 - decimals);
const mulDiv = (a: bigint, b: bigint, d: bigint, up: boolean): bigint => {
  const n = a * b;
  return up && n % d !== 0n ? n / d + 1n : n / d;
};

// ---- the wallet that trades ------------------------------------------------------------------------

interface Wallet {
  account: PrivateKeyAccount;
  /** the key's own address: it authenticates (POLY_ADDRESS, ClobAuth) and signs */
  eoa: Hex;
  /** the order's maker: where the money is */
  maker: Hex;
  /** the order's signer field: the key's address, or the Deposit Wallet itself */
  signer: Hex;
  type: SigType;
  privateKey: Hex;
}

/** The key file as a wallet: the private key, and where the money sits. Field names are said; no value from the file ever is */
function walletOf(venue: string, key: KeyFile): Wallet | Refusal {
  const raw = (key.privateKey ?? "").trim();
  const privateKey = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) return no("E_ACCOUNT_CREDENTIAL", { venue, message: `"privateKey" in the key file is not a private key: it is 64 hex digits, with or without 0x`, detail: { field: "privateKey" } });
  let account: PrivateKeyAccount;
  try {
    account = privateKeyToAccount(privateKey);
  } catch {
    return no("E_ACCOUNT_CREDENTIAL", { venue, message: `"privateKey" in the key file is not a usable private key`, detail: { field: "privateKey" } });
  }
  const eoa = account.address;
  const funderRaw = key.funderAddress?.trim();
  const typeRaw = key.signatureType?.trim();
  // own keys only: "constructor" or "toString" is not a wallet kind
  const type = typeRaw === undefined || !Object.hasOwn(SIG_WORDS, typeRaw.toLowerCase()) ? undefined : SIG_WORDS[typeRaw.toLowerCase()];
  if (typeRaw !== undefined && type === undefined) return no("E_ACCOUNT_CREDENTIAL", { venue, message: `"signatureType" in the key file is "0" (the key's own address), "1" (Proxy), "2" (Safe) or "3" (Deposit Wallet), as a string`, detail: { field: "signatureType" } });
  if (funderRaw !== undefined && !isAddress(funderRaw, { strict: false })) return no("E_ACCOUNT_CREDENTIAL", { venue, message: `"funderAddress" in the key file is not an address: 0x and forty hex digits`, detail: { field: "funderAddress" } });
  const funder = funderRaw !== undefined ? getAddress(funderRaw) : undefined;
  // a wallet named without its kind is not guessed at: the kind decides who the order says signed it
  if (funder !== undefined && type === undefined) return no("E_ACCOUNT_CREDENTIAL", { venue, message: `the key file names a "funderAddress" but not its "signatureType": "1" for a Proxy wallet, "2" for a Safe, "3" for a Deposit Wallet`, detail: { missing: ["signatureType"] } });
  const t: SigType = type ?? 0;
  if (t === 0) {
    if (funder !== undefined && funder !== eoa) return no("E_ACCOUNT_CREDENTIAL", { venue, message: `"signatureType" "0" trades from the key's own address, but "funderAddress" names another one: give the wallet's kind ("1", "2" or "3") or leave "funderAddress" out`, detail: { field: "signatureType" } });
    return { account, eoa, maker: eoa, signer: eoa, type: 0, privateKey };
  }
  if (funder === undefined) return no("E_ACCOUNT_CREDENTIAL", { venue, message: `"signatureType" "${t}" trades from a Polymarket wallet: the key file also needs its "funderAddress"`, detail: { missing: ["funderAddress"] } });
  return { account, eoa, maker: funder, signer: t === 3 ? funder : eoa, type: t, privateKey };
}

// ---- markets ---------------------------------------------------------------------------------------

/** one outcome of a Gamma market, as the account names it */
interface Outcome {
  symbol: string;
  slug: string;
  question: string;
  outcome: string;
  tokenId: string;
  conditionId: string;
  version: "v1" | "v2";
  negRisk: boolean;
  open: boolean;
  why?: string | undefined;
  tick?: number | undefined;
  minSize?: number | undefined;
  price?: number | undefined;
  notes: string[];
  /** what Gamma's market says beyond the order rules: its end (`endDate`), the pUSD traded in it in 24 hours (`volume24hr`, the
   * market's, which all its outcomes share), the change of its price in 24 hours (`oneDayPriceChange`, absolute: the first outcome's,
   * whose price Gamma's market price is), and its event's category when the caller knows it */
  closeTime?: string | undefined;
  volume24h?: number | undefined;
  change24h?: number | undefined;
  category?: string | undefined;
}

/** Every outcome of a Gamma market. The trading id follows the market's `version`, even where both id fields are present: a v1 (CTF)
 * market trades its `clobTokenIds` (a JSON-encoded string), a v2 market its `positionIds` (Polymarket says a v1 market's positionIds have
 * no book). Index i of `outcomes` is index i of the ids. Any other version is left out. `oneDayPriceChange` is said for the first outcome
 * only: Gamma's market price, last trade, best bid and best ask are all that outcome's (OBSERVED), and the others' change is not given */
function outcomesOf(m: Json, category?: string): Outcome[] {
  const version = m.version === "v1" || m.version === "v2" ? m.version : undefined;
  const slug = typeof m.slug === "string" ? m.slug : "";
  if (!version || !slug) return [];
  const names = list(m.outcomes).map(String);
  const ids = list(version === "v1" ? m.clobTokenIds : m.positionIds).map((x) => String(x));
  if (!names.length || names.length !== ids.length || !ids.every((x) => /^\d+$/.test(x))) return [];
  const prices = list(m.outcomePrices).map(num);
  const why = m.closed === true ? "the market is closed" : m.archived === true ? "the market is archived" : m.active !== true ? "the market is not active" : m.enableOrderBook !== true ? "the market has no order book" : m.acceptingOrders !== true ? "Polymarket is not taking orders in it now" : undefined;
  const notes: string[] = [];
  const fee = isObj(m.feeSchedule) ? m.feeSchedule : undefined;
  if (m.feesEnabled === true && fee && num(fee.rate) > 0) notes.push(`a taker pays ${plain(num(fee.rate))} × ${num(fee.exponent) && num(fee.exponent) !== 1 ? `(p × (1 − p))^${plain(num(fee.exponent))}` : "p × (1 − p)"} a share in fees when it matches`);
  if (num(m.secondsDelay) > 0) notes.push(`Polymarket holds an order that would match for ${plain(num(m.secondsDelay))} s before matching it, and it cannot be canceled meanwhile`);
  if (m.restricted === true) notes.push("Polymarket restricts this market in some places");
  const question = String(m.question ?? slug);
  const closeTime = typeof m.endDate === "string" && m.endDate ? m.endDate : undefined;
  const volume24h = given(m.volume24hr);
  const dayChange = given(m.oneDayPriceChange);
  return names.map((outcome, i) => ({
    symbol: `${slug}:${outcome}`,
    slug,
    question,
    outcome,
    tokenId: ids[i]!,
    conditionId: String(m.conditionId ?? ""),
    version,
    negRisk: m.negRisk === true,
    open: why === undefined,
    why,
    tick: positive(m.orderPriceMinTickSize),
    minSize: positive(m.orderMinSize),
    price: positive(prices[i]),
    notes,
    ...(closeTime ? { closeTime } : {}),
    ...(volume24h !== undefined && volume24h >= 0 ? { volume24h } : {}),
    ...(i === 0 && dayChange !== undefined ? { change24h: dayChange } : {}),
    ...(category ? { category } : {}),
  }));
}

/** The CLOB's book. Polymarket's live books list bids rising and asks falling (the best of each LAST), which is the reverse of what its
 * OpenAPI file says: the best bid and ask are therefore computed, never read off a position */
interface Book {
  bid?: number | undefined;
  ask?: number | undefined;
  /** price and size in millionths, best first */
  asks: Array<{ price: bigint; size: bigint }>;
  tick?: number | undefined;
  minSize?: number | undefined;
  negRisk?: boolean | undefined;
  version?: string | undefined;
  last?: number | undefined;
  conditionId: string;
}
function bookOf(b: Json): Book {
  const side = (v: unknown) => (Array.isArray(v) ? v : []).filter(isObj).map((l) => ({ p: num(l.price), s: num(l.size) })).filter((l) => l.p > 0 && l.s > 0);
  const bids = side(b.bids);
  const asks = side(b.asks).sort((x, y) => x.p - y.p);
  return {
    bid: bids.length ? Math.max(...bids.map((l) => l.p)) : undefined,
    ask: asks.length ? asks[0]!.p : undefined,
    asks: asks.map((l) => ({ price: BigInt(Math.round(l.p * 1e6)), size: BigInt(Math.round(l.s * 1e6)) })),
    tick: positive(b.tick_size),
    minSize: positive(b.min_order_size),
    negRisk: typeof b.neg_risk === "boolean" ? b.neg_risk : undefined,
    version: typeof b.version === "string" ? b.version : undefined,
    last: positive(b.last_trade_price),
    conditionId: String(b.market ?? ""),
  };
}

/** what market() learned about one symbol, for place() */
interface Known {
  symbol: string;
  name: string;
  tokenId: string;
  conditionId: string;
  version: "v1" | "v2";
  negRisk: boolean;
  tick: number;
  minSize?: number | undefined;
  open: boolean;
  why?: string | undefined;
  at: number;
}

// ---- positions -------------------------------------------------------------------------------------

/** a number the Data API gave: a missing or null one is "unavailable, never zero" in its conventions, so it stays unknown rather than 0 */
const given = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};
const POSITION_FIELDS = ["token_id", "condition_id", "slug", "outcome", "outcome_index", "status", "redeemable", "mergeable", "negative_risk", "end_date", "current_size", "avg_price", "current_price", "current_value", "entry_cost_usdc", "entry_fees_usdc", "realized_pnl", "unrealized_pnl"] as const;

/** One row of the Data API's positions (docs.polymarket.com/api-reference/wallet/list-positions-for-a-user-or-market), in the account's words.
 * The symbol is the one market() takes: `<slug>:<outcome>`, or the token id when the row names no market. The shares held are
 * `current_size` (`total_size` is every share ever bought). Every holding is long: a bet against an outcome is the other outcome bought, and
 * a sell can only be of shares the wallet holds. A resolved market's shares stay a position until they are redeemed (status REDEEMABLE,
 * marked at 0 when the outcome lost). The profile fields of the row (name, image) are left out */
function positionOf(p: Json): Position | undefined {
  const qty = num(p.current_size);
  if (!(qty > 0)) return undefined;
  const slug = typeof p.slug === "string" ? p.slug : "";
  const outcome = typeof p.outcome === "string" ? p.outcome : "";
  const token = typeof p.token_id === "string" ? p.token_id : "";
  const symbol = SLUG.test(slug) && outcome ? `${slug}:${outcome}` : TOKEN.test(token) ? token : undefined;
  if (symbol === undefined) return undefined;
  const title = typeof p.title === "string" && p.title ? p.title : slug || token;
  return {
    symbol,
    name: `${title} · ${outcome || "?"}`,
    kind: "event",
    side: "long",
    qty,
    entryPrice: positive(p.avg_price),
    markPrice: given(p.current_price),
    usd: given(p.current_value),
    unrealizedUsd: given(p.unrealized_pnl),
    native: Object.fromEntries(POSITION_FIELDS.filter((k) => p[k] !== undefined).map((k) => [k, p[k]])),
  };
}

// ---- refusals --------------------------------------------------------------------------------------

/** the CLOB's region refusal is not in Polymarket's docs; a third-party report has 403 "Trading restricted in your region", which the
 * shared REGION pattern does not catch */
const PM_REGION = /restricted in your (region|country|jurisdiction)|trading (is )?restricted|geo-?blocked|not available in your (region|country)/i;
const GEO_WORDS = "Polymarket does not serve this location: that is its own rule, and the account does not look for a way around it";
const INSUFFICIENT = /not enough balance|allowance/i;
const NO_TRADE = /address banned|closed only mode/i;
const KEY_OWNER = /has to be the (owner|address) of the api key/i;
const CLOSED = /cancel-only|trading is currently disabled|not yet ready to process new orders/i;
const LATER = /post-only mode|order timed out|context canceled/i;
const AS_WRITTEN = /breaks minimum tick size|lower than the minimum|invalid order payload|rounding issues|discrepancy greater than allowed|duplicated|invalid expiration|invalid post-only/i;
const NO_MATCH = /no orders found to match|filled or killed|no matching orders|crosses (the )?book|match delayed|canceled in the ctf exchange/i;
const UNAUTH = /unauthori[sz]ed|invalid api key|l1 request headers|missing address header/i;

// ---- the source --------------------------------------------------------------------------------------

export interface PolymarketTradeRequest {
  venue: string;
  label: string;
  reference: string;
  key: KeyFile;
  http: Http;
  chain: ChainReader;
  /** the real clock, in milliseconds */
  clock: () => number;
  /** an order's salt; random unless a test fixes it */
  salt?: (() => number) | undefined;
}

/** Polymarket, connected to trade: Polymarket's location check first, then the positions and cash of the wallet that holds the money,
 * then the CLOB credentials of the key. Any of the three saying no is the answer, in Polymarket's words */
export async function polymarketTradeSource(req: PolymarketTradeRequest): Promise<{ source: LiveSource; first: LiveBalance[] } | Refusal> {
  const w = walletOf(req.venue, req.key);
  if (isRefusal(w)) return w;
  const name = req.label || "Polymarket";
  const t = polymarketTrader({ venue: req.venue, name, wallet: w, http: req.http, clock: req.clock, salt: req.salt });
  const geo = await t.geoblock();
  if (geo) return geo;
  const read = await polymarketSource({ venue: req.venue, label: name, address: w.maker, http: req.http, chain: req.chain });
  if (isRefusal(read)) return read;
  const creds = await t.creds();
  if (isRefusal(creds)) return creds;
  // the wallet the orders are made by is where money lands: the writer gives its address for pUSD on Polygon, and Polymarket's bridge address
  // for the other chains. It is not the source's `address`: that field is a watched or proven wallet, and the service would ask a wallet
  // proof for it; the key file's key signing Polymarket's orders is what shows the wallet is the owner's here
  const source: LiveSource = {
    name,
    kind: "prediction",
    reference: req.reference,
    via: `Polymarket CLOB · orders signed by the account wallet's key (${SIG_NAME[w.type]})`,
    probe: {
      can: ["trade"],
      note: `orders are made by ${w.maker}${w.maker === w.eoa ? "" : ` and signed by its owner key ${w.eoa}`}; Polymarket issued CLOB credentials for ${w.eoa}, kept in this process's memory only${w.type === 0 ? " · Polymarket says a plain address trades only once it has allowlisted it" : ""} · money comes in to that wallet as pUSD on Polygon, or through Polymarket's bridge from the other chains; it leaves Polymarket at Polymarket`,
      native: { calls: ["GET polymarket.com/api/geoblock", "GET data-api /v2/positions?user=", "balanceOf pUSD on Polygon", "GET /auth/derive-api-key"], maker: w.maker, signer: w.eoa, signatureType: w.type },
    },
    read: read.source.read,
    writer: polymarketWriter({ venue: req.venue, name, maker: w.maker, http: req.http, clock: req.clock }),
    trader: t.trader,
  };
  return { source, first: read.first };
}

// ---- money in: pUSD on Polygon, and Polymarket's bridge ------------------------------------------------

const BRIDGE = "https://bridge.polymarket.com";
/** the chains of this account's that Polymarket's bridge takes deposits from (its supported-assets page, read 2026-10-06, lists these six
 * among others; every EVM chain goes through the one `evm` address the bridge gives a wallet). What each chain takes, and the least it takes,
 * is asked of the bridge itself each time, kept ten minutes */
const BRIDGE_CHAINS: ChainName[] = ["Ethereum", "Polygon", "Arbitrum", "Base", "Optimism", "BNB Chain"];
const BRIDGE_MS = 10 * 60_000;

/** Money INTO Polymarket, for the wallet the orders are made by. Nothing leaves from here: `can.why.withdraw` says how it does leave */
function polymarketWriter(c: { venue: string; name: string; maker: Hex; http: Http; clock: () => number }): LiveWriter {
  type Listed = { symbol: string; address: string; minUsd: number | undefined };
  let listed: { at: number; byChain: Map<number, Listed[]> } | undefined;
  let bridge: { at: number; evm: Hex; note: string | undefined } | undefined;
  const call = async (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<HttpReply> => {
    try {
      return await c.http(`${BRIDGE}${path}`, { method: init.method ?? "GET", headers: { accept: "application/json", ...(init.headers ?? {}) }, ...(init.body !== undefined ? { body: init.body } : {}) });
    } catch (err) {
      throw unreachable(c.venue, `${c.name}'s bridge`, err);
    }
  };
  /** the bridge's no, in its words: its errors are `{"error": "…"}` */
  const bridgeNo = (r: HttpReply, doing: string): Refusal => {
    const b = isObj(r.body) ? r.body : {};
    const said = String(typeof b.error === "string" ? b.error : r.text).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 220);
    const native = { status: r.status, said };
    if (r.status === 429) return no("E_VENUE_UNREACHABLE", { venue: c.venue, message: `${c.name}'s bridge is rate-limiting this machine: try again in a minute`, native });
    if (r.status >= 500 || r.status === 0) return no("E_VENUE_UNREACHABLE", { venue: c.venue, message: `${c.name}'s bridge did not answer`, native });
    return no("E_VENUE_REJECTED", { venue: c.venue, message: `${c.name}'s bridge refused to ${doing}${said ? `: ${said}` : ` (HTTP ${r.status})`}`, native });
  };
  const supported = async (): Promise<Map<number, Listed[]> | Refusal> => {
    if (listed && c.clock() - listed.at < BRIDGE_MS) return listed.byChain;
    const r = await call("/supported-assets");
    if (r.status !== 200 || !isObj(r.body)) return bridgeNo(r, "list what it takes");
    const byChain = new Map<number, Listed[]>();
    for (const row of (Array.isArray(r.body.supportedAssets) ? r.body.supportedAssets : []).filter(isObj)) {
      const chainId = num(row.chainId);
      const token = isObj(row.token) ? row.token : {};
      const symbol = String(token.symbol ?? "").toUpperCase();
      if (!chainId || !symbol) continue;
      const here = byChain.get(chainId) ?? [];
      here.push({ symbol, address: String(token.address ?? ""), minUsd: given(row.minCheckoutUsd) });
      byChain.set(chainId, here);
    }
    listed = { at: c.clock(), byChain };
    return byChain;
  };
  /** the bridge address of this wallet: POST /deposit answers one per kind of chain (evm, svm, btc, tron), "unique to your wallet" */
  const bridgeAddress = async (): Promise<{ evm: Hex; note: string | undefined } | Refusal> => {
    if (bridge && c.clock() - bridge.at < BRIDGE_MS) return bridge;
    const r = await call("/deposit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: c.maker }) });
    if ((r.status !== 200 && r.status !== 201) || !isObj(r.body)) return bridgeNo(r, "give a deposit address for this wallet");
    const addresses = isObj(r.body.address) ? r.body.address : {};
    const evm = String(addresses.evm ?? "");
    if (!isAddress(evm, { strict: false })) return no("E_VENUE_REJECTED", { venue: c.venue, message: `${c.name}'s bridge answered without an EVM deposit address`, native: { status: r.status, said: r.text.replace(/\s+/g, " ").slice(0, 200) } });
    bridge = { at: c.clock(), evm: getAddress(evm), note: typeof r.body.note === "string" && r.body.note ? r.body.note.replace(/\s+/g, " ").slice(0, 200) : undefined };
    return bridge;
  };
  return {
    can: {
      receive: true,
      withdraw: false,
      ledgers: [],
      transfer: false,
      swap: false,
      send: false,
      why: { withdraw: `money leaves ${c.name} by a pUSD transfer from the Polymarket wallet to one of its bridge addresses (POST bridge.polymarket.com/withdraw: "Send pUSD from your Polymarket wallet to the appropriate bridge address"), made at polymarket.com: the CLOB has no withdrawal call, and this account signs no transaction with the key file's key` },
    },
    async depositAddress(asset, network) {
      const a = asset.trim().toUpperCase();
      if (a === "PUSD") {
        if (network !== "Polygon") return no("E_VENUE_RAIL_CLOSED", { venue: c.venue, message: `pUSD is a token on Polygon only (${c.name}'s collateral): from ${network}, send USDC or USDT to ${c.name}'s bridge address instead` });
        return { address: c.maker, note: `the wallet ${c.name} trades from: pUSD on Polygon sent to it is the cash the account reads there (pUSD is a standard ERC-20 token on Polygon; ${c.name}'s docs describe deposits through its bridge and its Collateral Onramp, which both end as pUSD in this wallet)` };
      }
      if (!BRIDGE_CHAINS.includes(network)) return no("E_VENUE_RAIL_CLOSED", { venue: c.venue, message: `${c.name}'s bridge takes deposits from ${BRIDGE_CHAINS.join(", ")}, not ${network}` });
      const chainId = CHAINS[network].chain.id;
      const lists = await supported();
      if (isRefusal(lists)) return lists;
      const here = lists.get(chainId) ?? [];
      const token = here.find((t) => t.symbol === a || (a === "USDC.E" && t.symbol === "USDCE"));
      if (!token) return no("E_VENUE_RAIL_CLOSED", { venue: c.venue, message: `${c.name}'s bridge lists no ${asset} on ${network}: there it takes ${here.map((t) => t.symbol).join(", ") || "nothing it lists today"}`, detail: { takes: here.map((t) => t.symbol) } });
      // a dollar this account knows is matched by its contract, not its name: the bridge lists pUSD on Polygon under the name USDC, and a
      // transfer of the account's USDC to an address expecting that token is not the deposit the bridge describes
      const mine = tokenOn(a, network);
      if (mine && token.address && mine.address.toLowerCase() !== token.address.toLowerCase()) return no("E_VENUE_RAIL_CLOSED", { venue: c.venue, message: `${c.name}'s bridge lists ${asset} on ${network} at ${token.address}, not the ${mine.asset} this account sends (${mine.address})${network === "Polygon" ? ": that is pUSD, which goes straight to the wallet" : ""}`, detail: { bridge: token.address, account: mine.address } });
      const b = await bridgeAddress();
      if (isRefusal(b)) return b;
      return { address: b.evm, note: `${c.name}'s bridge address, unique to this wallet: ${asset} sent to it on ${network} is bridged and credited as pUSD to ${c.maker}${token.minUsd !== undefined ? `. ${c.name} takes at least $${plain(token.minUsd)} a deposit there, and says deposits below the minimum are not processed` : ""}${b.note ? ` · ${c.name} says: ${b.note}` : ""}` };
    },
  };
}

// ---- the trader --------------------------------------------------------------------------------------

function polymarketTrader(c: { venue: string; name: string; wallet: Wallet; http: Http; clock: () => number; salt?: (() => number) | undefined }) {
  const w = c.wallet;
  let creds: { apiKey: string; secret: string; passphrase: string } | undefined;
  let deriving: Promise<typeof creds | Refusal> | undefined;
  let listed: { at: number; all: Market[] } | undefined;
  const known = new Map<string, Known>();
  const fills = new Map<string, { matched: number; avg?: number | undefined }>();
  // every credential this process has held stays redacted, also after Polymarket dropped it
  const hidden = new Set<string>([w.privateKey, w.privateKey.slice(2)]);
  const secrets = (): string[] => [...hidden];
  const salt = c.salt ?? (() => Number(BigInt(`0x${randomBytes(7).toString("hex")}`) & ((1n << 53n) - 1n)));
  const seconds = () => Math.floor(c.clock() / 1000);

  const call = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<HttpReply> => {
    try {
      return await c.http(url, { method: init.method ?? "GET", headers: { accept: "application/json", ...(init.headers ?? {}) }, ...(init.body !== undefined ? { body: init.body } : {}) });
    } catch (err) {
      throw unreachable(c.venue, c.name, err, secrets());
    }
  };

  /** Polymarket's no, in the account's words. Its errors are `{"error": "…"}`, and an order it takes in but will not place comes back as
   * `{"success": false, "errorMsg": "…"}`, sometimes with HTTP 200. The words decide first, the status after: the CLOB turns any message
   * with "not found" into a 404 and "unauthorized" into a 401, and some order refusals arrive as 500 */
  const refusal = (r: HttpReply, order?: string): Refusal => {
    const b = isObj(r.body) ? r.body : {};
    const text = typeof b.errorMsg === "string" && b.errorMsg ? b.errorMsg : typeof b.error === "string" ? b.error : typeof b.error_msg === "string" ? b.error_msg : r.text;
    // redacted before it is cut, so that no part of a secret survives at the cut
    const said = redact(String(text), secrets()).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 220);
    const native = { status: r.status, said, ...(typeof b.code === "string" ? { code: b.code } : {}), ...(b.retry_after_seconds !== undefined ? { retryAfterSeconds: num(b.retry_after_seconds) } : {}) };
    const words = said ? `${c.name}: ${said}` : `${c.name} refused (HTTP ${r.status})`;
    if (r.status === 451 || REGION.test(said) || PM_REGION.test(said)) return no("E_VENUE_GEOBLOCKED", { venue: c.venue, message: GEO_WORDS, native });
    if (INSUFFICIENT.test(said)) return no("E_VENUE_INSUFFICIENT", { venue: c.venue, message: words, native });
    if (NO_TRADE.test(said)) return no("E_VENUE_PERMISSION", { venue: c.venue, message: words, native });
    if (KEY_OWNER.test(said)) return no("E_VENUE_BAD_SIGNER", { venue: c.venue, message: `${words} · the key file's "funderAddress" and "signatureType" say who makes the order and who signs it`, native });
    if (CLOSED.test(said)) return no("E_VENUE_MARKET_CLOSED", { venue: c.venue, message: words, native });
    if (LATER.test(said) || r.status === 425 || r.status === 429) return no("E_VENUE_UNREACHABLE", { venue: c.venue, message: r.status === 429 ? `${c.name} is rate-limiting this machine: try again in a minute` : `${words}: try again shortly`, native });
    if (AS_WRITTEN.test(said)) return { ...badOrder(c.venue, c.name, said), native };
    if (/order_version_mismatch/i.test(said)) return no("E_VENUE_REJECTED", { venue: c.venue, message: `${words} · this connection signs CLOB V2 orders, and Polymarket now asks for another version`, native });
    if (NO_MATCH.test(said)) return no("E_VENUE_REJECTED", { venue: c.venue, message: words, native });
    if (r.status === 401 || UNAUTH.test(said)) {
      // the credentials are asked for again on the next call: Polymarket may have dropped them
      creds = undefined;
      return no("E_VENUE_UNAUTHORIZED", { venue: c.venue, message: `${c.name} does not accept this key's credentials${said ? `: ${said}` : ""}`, native });
    }
    if (order !== undefined && (r.status === 404 || /not found|invalid orderid/i.test(said))) return no("E_ACCOUNT_ORDER_UNKNOWN", { venue: c.venue, message: `${c.name} has no order ${order} for this key`, detail: { order }, native });
    if (r.status === 403) return no("E_VENUE_PERMISSION", { venue: c.venue, message: words, native });
    if (r.status >= 500 || r.status === 0) return no("E_VENUE_UNREACHABLE", { venue: c.venue, message: `${c.name} did not answer`, native });
    return no("E_VENUE_REJECTED", { venue: c.venue, message: words, native });
  };

  /** Polymarket's own location check, for the IP this machine sends from. Blocked — completely, or close-only as the US is — is its rule;
   * the check not answering is not taken for a yes. The IP it reports is left out of everything */
  const geoblock = async (): Promise<Refusal | undefined> => {
    let r: HttpReply;
    try {
      r = await call(GEOBLOCK);
    } catch (err) {
      const x = asRefusal(c.venue, c.name, err, secrets());
      return { ...x, message: `${c.name}'s location check could not be reached: nothing goes to Polymarket without it` };
    }
    if (r.status === 451 || (r.status !== 200 && (REGION.test(r.text) || PM_REGION.test(r.text)))) return no("E_VENUE_GEOBLOCKED", { venue: c.venue, message: GEO_WORDS, native: { status: r.status } });
    if (r.status !== 200 || !isObj(r.body) || typeof r.body.blocked !== "boolean") return no("E_VENUE_UNREACHABLE", { venue: c.venue, message: `${c.name}'s location check did not answer: nothing goes to Polymarket without it`, native: { status: r.status } });
    if (r.body.blocked) return no("E_VENUE_GEOBLOCKED", { venue: c.venue, message: GEO_WORDS, native: { blocked: true, ...(typeof r.body.country === "string" ? { country: r.body.country } : {}), ...(typeof r.body.region === "string" ? { region: r.body.region } : {}) } });
    return undefined;
  };

  /** L1: the key signs ClobAuth (no verifyingContract; the timestamp is seconds, signed as a string; nonce 0) and Polymarket answers the
   * signer's CLOB credentials. Derive first; a 400 means there are none yet, and they are made */
  const l1 = async (): Promise<Record<string, string>> => {
    const ts = seconds();
    const signature = await w.account.signTypedData({ domain: { name: "ClobAuthDomain", version: "1", chainId: CHAIN_ID }, types: { ClobAuth: CLOB_AUTH }, primaryType: "ClobAuth", message: { address: w.eoa, timestamp: String(ts), nonce: 0n, message: ATTEST } });
    return { POLY_ADDRESS: w.eoa, POLY_SIGNATURE: signature, POLY_TIMESTAMP: String(ts), POLY_NONCE: "0" };
  };
  const credsOf = async (): Promise<NonNullable<typeof creds> | Refusal> => {
    if (creds) return creds;
    deriving ??= (async () => {
      try {
        let r = await call(`${CLOB}/auth/derive-api-key`, { headers: await l1() });
        if (r.status === 400) r = await call(`${CLOB}/auth/api-key`, { method: "POST", headers: await l1() });
        const b = isObj(r.body) ? r.body : {};
        if (r.status === 200 && typeof b.apiKey === "string" && typeof b.secret === "string" && typeof b.passphrase === "string" && b.apiKey && b.secret && b.passphrase) {
          creds = { apiKey: b.apiKey, secret: b.secret, passphrase: b.passphrase };
          for (const v of [b.apiKey, b.secret, b.passphrase]) hidden.add(v);
          return creds;
        }
        // an answer of 200 without the three fields is not shown: it may hold part of them
        return r.status === 200 ? no("E_VENUE_REJECTED", { venue: c.venue, message: `${c.name} answered the credentials request in a way this connection could not read`, native: { status: 200 } }) : refusal(r);
      } catch (err) {
        return asRefusal(c.venue, c.name, err, secrets());
      } finally {
        deriving = undefined;
      }
    })();
    const out = await deriving;
    return out ?? no("E_VENUE_REJECTED", { venue: c.venue, message: `${c.name} issued no credentials` });
  };

  /** L2: every private call carries the key's address, the seconds, the HMAC over method, path and body, and the credentials */
  const priv = async (method: "GET" | "POST" | "DELETE", path: string, query = "", body?: string, given?: NonNullable<typeof creds>): Promise<HttpReply> => {
    const k = given ?? (await credsOf());
    if (isRefusal(k)) throw k;
    const ts = seconds();
    const headers: Record<string, string> = { POLY_ADDRESS: w.eoa, POLY_SIGNATURE: polyHmac(k.secret, ts, method, path, body), POLY_TIMESTAMP: String(ts), POLY_API_KEY: k.apiKey, POLY_PASSPHRASE: k.passphrase, ...(body !== undefined ? { "content-type": "application/json" } : {}) };
    return call(`${CLOB}${path}${query}`, { method, headers, ...(body !== undefined ? { body } : {}) });
  };

  const getJson = async (url: string): Promise<unknown> => {
    const r = await call(url);
    if (r.status !== 200 || r.body === undefined) throw refusal(r);
    return r.body;
  };

  const book = async (tokenId: string): Promise<Book | undefined> => {
    const r = await call(`${CLOB}/book?token_id=${tokenId}`);
    // no book: a token Polymarket does not trade, or a market that is closed or resolved
    if (r.status === 404 || (r.status === 400 && /invalid token id/i.test(r.text))) return undefined;
    if (r.status !== 200 || !isObj(r.body)) throw refusal(r);
    return bookOf(r.body);
  };

  const catalog = async (): Promise<Market[]> => {
    if (listed && c.clock() - listed.at < LIST_MS) return listed.all;
    const all: Market[] = [];
    let cursor = "";
    // the busiest markets first: 24-hour volume, three pages of a hundred at most
    for (let page = 0; page < 3; page++) {
      const body = await getJson(`${GAMMA}/markets/keyset?closed=false&limit=100&order=volume24hr&ascending=false${cursor ? `&after_cursor=${encodeURIComponent(cursor)}` : ""}`);
      const markets = isObj(body) && Array.isArray(body.markets) ? body.markets : [];
      for (const m of markets.filter(isObj)) for (const o of outcomesOf(m)) if (o.open) all.push(marketOf(o, undefined));
      cursor = isObj(body) && typeof body.next_cursor === "string" ? body.next_cursor : "";
      if (!cursor || !markets.length) break;
    }
    // every Polymarket market is priced in pUSD; the filter is the account's rule, said once more
    const out = all.filter((m) => inDollars(m.quote));
    listed = { at: c.clock(), all: out };
    return out;
  };

  const marketOf = (o: Outcome, b: Book | undefined, why?: string): Market => {
    const tick = b?.tick ?? o.tick;
    const open = o.open && !why;
    const reason = why ?? o.why;
    const price = b ? (b.bid !== undefined && b.ask !== undefined ? (b.bid + b.ask) / 2 : (b.last ?? o.price)) : o.price;
    return {
      symbol: o.symbol,
      name: `${o.question} · ${o.outcome}`,
      kind: "event",
      base: o.outcome,
      quote: "pUSD",
      price,
      bid: b?.bid,
      ask: b?.ask,
      minQty: b?.minSize ?? o.minSize,
      // sizes go to two decimals of a share in every tick's rounding
      qtyStep: 0.01,
      priceStep: tick,
      open,
      note: open ? (o.notes.length ? o.notes.join(" · ") : undefined) : reason,
      // every Polymarket order is a limit order, a market order being one priced to match at once (concepts/order-lifecycle): there is no
      // stop or trigger order, no reduce-only flag and no leverage, so none is declared
      types: ["market", "limit"],
      tifs: [...TIFS_HERE],
      // an order that rests may be post-only: the CLOB takes it on GTC and GTD only (its OpenAPI, SendOrder.postOnly)
      postOnly: true,
      // a sell can only sell shares held — open sells reserve them, and a sell beyond them is refused: it never opens a position the other way
      sellsReduce: true,
      ...(o.change24h !== undefined ? { change24h: o.change24h } : {}),
      ...(o.volume24h !== undefined ? { volumeUsd24h: o.volume24h } : {}),
      ...(o.closeTime ? { closeTime: o.closeTime } : {}),
      ...(o.category ? { category: o.category } : {}),
      // the question all its outcomes share: Polymarket's condition id
      ...(o.conditionId ? { group: { id: o.conditionId, title: o.question } } : {}),
      outcome: o.outcome,
    };
  };

  /** one market: Gamma for what it is, the CLOB's book for its price and rules now */
  const market = async (raw: string): Promise<Market> => {
    const s = raw.trim();
    let o: Outcome | undefined;
    let b: Book | undefined;
    if (TOKEN.test(s)) {
      b = await book(s);
      if (!b?.conditionId) throw no("E_VENUE_REJECTED", { venue: c.venue, message: `${c.name} has no order book for the token ${s.slice(0, 12)}…: it is not one Polymarket trades, or its market is closed` });
      const found = await getJson(`${GAMMA}/markets/keyset?condition_ids=${encodeURIComponent(b.conditionId)}&limit=5`);
      const ms = isObj(found) && Array.isArray(found.markets) ? found.markets.filter(isObj) : [];
      o = ms.flatMap((m) => outcomesOf(m)).find((x) => x.tokenId === s);
      if (!o) throw no("E_VENUE_REJECTED", { venue: c.venue, message: `${c.name} lists no open market for the token ${s.slice(0, 12)}…` });
      // the token is the name the owner gave: it stays the symbol
      o = { ...o, symbol: s };
    } else {
      const i = s.indexOf(":");
      const slug = i > 0 ? s.slice(0, i).trim() : "";
      const want = i > 0 ? s.slice(i + 1).trim() : "";
      if (!SLUG.test(slug) || !want) throw no("E_VENUE_REJECTED", { venue: c.venue, message: `a market at ${c.name} is <slug>:<outcome> (will-the-us-invade-iran-before-2027:Yes), or an outcome's token id` });
      const r = await call(`${GAMMA}/markets/slug/${encodeURIComponent(slug)}`);
      if (r.status === 404 || (isObj(r.body) && typeof r.body.error === "string" && /not found/i.test(r.body.error))) throw no("E_VENUE_REJECTED", { venue: c.venue, message: `${c.name} lists no market ${slug}`, native: { status: r.status, said: redact(r.text, secrets()).slice(0, 200) } });
      if (r.status !== 200 || !isObj(r.body)) throw refusal(r);
      const all = outcomesOf(r.body);
      if (!all.length) throw no("E_VENUE_REJECTED", { venue: c.venue, message: `${c.name} lists ${slug}, but not as a market this connection can trade (version ${String(r.body.version ?? "unknown")})`, native: { version: r.body.version ?? null } });
      o = all.find((x) => x.outcome.toLowerCase() === want.toLowerCase());
      if (!o) throw no("E_VENUE_REJECTED", { venue: c.venue, message: `${c.name}'s ${slug} has the outcomes ${all.map((x) => x.outcome).join(" and ")}, not "${want}"` });
      b = o.open ? await book(o.tokenId) : undefined;
    }
    // Gamma's version picks the id; a book that says another version is not signed for
    if (b?.version && b.version !== o.version) throw no("E_VENUE_REJECTED", { venue: c.venue, message: `${c.name}'s market data disagree on this market's version (Gamma ${o.version}, book ${b.version}): nothing is signed for it`, native: { gamma: o.version, book: b.version } });
    const why = o.open && !b ? "it has no order book now" : undefined;
    const m = marketOf(o, b, why);
    const tick = m.priceStep;
    known.set(m.symbol, { symbol: m.symbol, name: m.name, tokenId: o.tokenId, conditionId: b?.conditionId || o.conditionId, version: o.version, negRisk: b?.negRisk ?? o.negRisk, tick: tick ?? 0, minSize: m.minQty, open: m.open, why: m.open ? undefined : m.note, at: c.clock() });
    return m;
  };

  const resolve = async (symbol: string): Promise<Known> => {
    const k = known.get(symbol);
    if (k && c.clock() - k.at < KNOWN_MS) return k;
    // kept under the market's own name (`slug:Yes`), which may differ from what was typed (`slug:yes`)
    const m = await market(symbol);
    return known.get(m.symbol)!;
  };

  /** the prices the order filled at, from the account's trades in its market: as a taker, the trade's size and price; as a maker, its own
   * entry among the trade's maker orders. Failed trades do not count. Asked only when more has filled than last time */
  const avgOf = async (ref: string, conditionId: string, matched: number): Promise<number | undefined> => {
    const was = fills.get(ref);
    if (was && Math.abs(was.matched - matched) < 1e-9) return was.avg;
    let shares = 0;
    let paid = 0;
    try {
      let cursor = "";
      for (let page = 0; page < 3; page++) {
        const r = await priv("GET", "/data/trades", `?market=${encodeURIComponent(conditionId)}${cursor ? `&next_cursor=${encodeURIComponent(cursor)}` : ""}`);
        if (r.status !== 200) return was?.avg;
        const rows = Array.isArray(r.body) ? r.body : isObj(r.body) && Array.isArray(r.body.data) ? r.body.data : [];
        for (const t of rows.filter(isObj)) {
          if (String(t.status ?? "").toUpperCase() === "FAILED") continue;
          if (String(t.taker_order_id ?? "").toLowerCase() === ref.toLowerCase()) {
            shares += num(t.size);
            paid += num(t.size) * num(t.price);
            continue;
          }
          for (const m of (Array.isArray(t.maker_orders) ? t.maker_orders : []).filter(isObj)) {
            if (String(m.order_id ?? "").toLowerCase() !== ref.toLowerCase()) continue;
            shares += num(m.matched_amount);
            paid += num(m.matched_amount) * num(m.price);
          }
        }
        cursor = isObj(r.body) && typeof r.body.next_cursor === "string" ? r.body.next_cursor : "";
        if (!cursor || cursor === "LTE=") break;
      }
    } catch {
      return was?.avg;
    }
    const avg = shares > 0 ? Number((paid / shares).toFixed(6)) : undefined;
    fills.set(ref, { matched, avg });
    return avg;
  };

  const ORDER_FIELDS = ["id", "status", "market", "asset_id", "side", "price", "original_size", "size_matched", "outcome", "order_type", "expiration", "associate_trades", "created_at", "maker_address"] as const;

  /** An order as Polymarket keeps it (GET /data/order/{id}), in the account's words. `original_size` and `size_matched` are shares,
   * already decimal; `price` is the order's limit, not what it filled at. Statuses arrive upper-case, some with an ORDER_STATUS_ prefix */
  const stateOf = async (o: Json): Promise<OrderState> => {
    const s = String(o.status ?? "").toUpperCase().replace(/^ORDER_STATUS_/, "");
    const matched = num(o.size_matched);
    let status: OrderStatus;
    switch (s) {
      case "MATCHED":
        status = "filled";
        break;
      // the unfilled rest was canceled — by the owner, by a fill-and-kill order's end, or at resolution — and any fill stands
      case "CANCELED":
      case "CANCELED_MARKET_RESOLVED":
        status = "canceled";
        break;
      case "INVALID":
        status = "rejected";
        break;
      // not in Polymarket's list (this connection sends no GTD order); read as what it says should Polymarket ever answer it
      case "EXPIRED":
        status = "expired";
        break;
      case "LIVE":
        status = matched > 0 ? "partial" : "open";
        break;
      // DELAYED (a marketable order waiting out a market's delay), UNMATCHED, and anything Polymarket adds: taken, watched until it says
      default:
        status = matched > 0 ? "partial" : "pending";
    }
    const ref = String(o.id);
    const avg = matched > 0 && typeof o.market === "string" && o.market ? await avgOf(ref, o.market, matched) : undefined;
    // `owner` is the credentials' key: it is left out
    return { ref, status, filledQty: matched, ...(avg !== undefined ? { avgPrice: avg } : {}), native: Object.fromEntries(ORDER_FIELDS.filter((k) => o[k] !== undefined).map((k) => [k, o[k]])) };
  };

  const read = async (ref: string): Promise<OrderState> => {
    const r = await priv("GET", `/data/order/${ref}`);
    if (r.status !== 200) throw refusal(r, ref);
    if (!isObj(r.body) || typeof r.body.id !== "string" || !r.body.id) throw no("E_ACCOUNT_ORDER_UNKNOWN", { venue: c.venue, message: `${c.name} has no order ${ref} for this key`, detail: { order: ref } });
    return stateOf(r.body);
  };

  /** The CLOB order type an order is sent as, or why Polymarket would not take it as asked. A limit order rests (GTC) unless it is
   * fill-and-kill (ioc, sent as FAK) or fill-or-kill (fok, FOK); a market order fills at once, FAK unless FOK is asked, and never rests
   * (the clients send a market order as FAK or FOK only). Post-only is for an order that rests: the CLOB's OpenAPI says it is "Only
   * supported for GTC and GTD orders", and the unified client refuses it on any other before sending, as this does */
  const orderTypeOf = (o: OrderRequest): ClobOrderType | Refusal => {
    if (o.type !== "limit" && o.type !== "market") return badOrder(c.venue, c.name, `the CLOB takes limit and market orders, not ${String(o.type).replace("_", "-")} orders: it has no stop or trigger order`);
    if (o.stopPrice !== undefined) return badOrder(c.venue, c.name, "the CLOB has no stop orders, so an order there carries no stop price");
    if (o.reduceOnly === true) return badOrder(c.venue, c.name, "the CLOB has no reduce-only flag (a sell there can only be of shares the wallet holds, so it never opens a position)");
    // own keys only, as with the key file's words: "constructor" is not a time in force
    const sent = o.tif !== undefined && Object.hasOwn(TIF, o.tif) ? TIF[o.tif] : undefined;
    if (o.tif !== undefined && sent === undefined) return badOrder(c.venue, c.name, `an order here is good till canceled (gtc), fill-and-kill (ioc) or fill-or-kill (fok), not ${String(o.tif)}`);
    const t = sent ?? (o.type === "limit" ? "GTC" : "FAK");
    if (o.type === "market" && t === "GTC") return badOrder(c.venue, c.name, "a market order here fills at once, fill-and-kill (ioc) or fill-or-kill (fok): an order that rests is a limit order");
    if (o.postOnly === true && o.type === "market") return badOrder(c.venue, c.name, "a market order takes from the book: only a limit order may be post-only");
    if (o.postOnly === true && t !== "GTC") return badOrder(c.venue, c.name, "post-only is for an order that rests (gtc): a fill-and-kill or fill-or-kill order takes from the book at once");
    return t;
  };

  /** The signed order, as the official clients build it. An order that rests (GTC: a limit order, post-only or not) is its shares at its
   * limit. One that fills at once (FAK or FOK: every market order, and a limit order that is fill-and-kill or fill-or-kill) is built as the
   * clients build a price-protected market order, bounded at the limit or at the worst price the account allows: a sell of the shares
   * asked, and a buy of what those shares cost on the book now. The CLOB sizes a FAK or FOK buy in pUSD, not in shares ("CLOB GTC/GTD BUY
   * targets are shares; FOK/FAK BUY targets are collateral", migrate/polymarket-v2/api-integrations), so the cost is walked off the asks up
   * to the bound, anything the book lacks is counted at the bound, and the pUSD goes to the cent as the clients send it */
  const build = async (o: OrderRequest, k: Known, orderType: ClobOrderType): Promise<{ body: string; hash: Hex; orderType: ClobOrderType; creds: NonNullable<typeof creds> } | Refusal> => {
    const cfg = roundingOf(k.tick);
    if (!cfg) return badOrder(c.venue, c.name, `the tick here is ${plain(k.tick)}, which is not one Polymarket's clients round for`, { tick: k.tick });
    const hundredths = Math.round(o.qty * 100);
    if (!(hundredths > 0) || Math.abs(o.qty * 100 - hundredths) > 1e-6) return badOrder(c.venue, c.name, "a size moves in steps of 0.01 shares", { qtyStep: 0.01 });
    if (k.minSize !== undefined && o.qty < k.minSize - 1e-9) return badOrder(c.venue, c.name, `the smallest order in ${k.name} is ${plain(k.minSize)} shares`, { minQty: k.minSize });
    const shares = BigInt(hundredths) * 10_000n;
    const tickM = BigInt(Math.round(k.tick * 1e6));
    // a market order's worst price goes onto the tick the side it cannot loosen: down for a buy, up for a sell
    const raw = o.type === "limit" ? o.limitPrice! : o.side === "buy" ? floorTo(o.worstPrice!, k.tick) : ceilTo(o.worstPrice!, k.tick);
    let priceM = BigInt(Math.round(raw * 1e6));
    if (Math.abs(raw * 1e6 - Number(priceM)) > 1e-3 || priceM % tickM !== 0n) return badOrder(c.venue, c.name, `a price in ${k.name} moves in steps of ${plain(k.tick)}`, { priceStep: k.tick });
    // a market buy's worst price past the top of the range (an ask at 0.99 plus 2%) is held at the top: tighter, never looser
    if (o.type === "market" && o.side === "buy" && priceM > SCALE - tickM) priceM = SCALE - tickM;
    if (priceM < tickM || priceM > SCALE - tickM) return badOrder(c.venue, c.name, `a price in ${k.name} is between ${plain(k.tick)} and ${plain(1 - k.tick)}`, { priceStep: k.tick });
    const amountQ = quantum(cfg.amount);
    let makerAmount: bigint;
    let takerAmount: bigint;
    // place() sends GTC for a limit order only: a market order never rests
    if (orderType === "GTC") {
      const usd = mulDiv(shares, priceM, SCALE * amountQ, false) * amountQ;
      [makerAmount, takerAmount] = o.side === "buy" ? [usd, shares] : [shares, usd];
    } else if (o.side === "sell") {
      makerAmount = shares;
      takerAmount = mulDiv(shares, priceM, SCALE * amountQ, true) * amountQ;
    } else {
      const b = await book(k.tokenId);
      if (!b) return no("E_VENUE_MARKET_CLOSED", { venue: c.venue, message: `${c.name} has no order book for ${k.name} now` });
      let left = shares;
      let cost = 0n;
      for (const l of b.asks) {
        if (left === 0n || l.price > priceM) break;
        const take = l.size < left ? l.size : left;
        cost += mulDiv(take, l.price, SCALE, true);
        left -= take;
      }
      cost += mulDiv(left, priceM, SCALE, true);
      // each level was rounded up: the whole is held to the shares at the bound, the most the account valued it at
      const most = mulDiv(shares, priceM, SCALE, false);
      if (cost > most) cost = most;
      // pUSD to two decimals, down: never more than the bound allows
      const sizeQ = quantum(cfg.size);
      makerAmount = (cost / sizeQ) * sizeQ;
      // the fewest shares it may bring, rounded up, so that no fill is dearer than the bound. Whether the CLOB holds this figure to the
      // market's smallest order in shares is not in its docs (they disagree on that minimum's units); its refusal would be its own words
      takerAmount = mulDiv(makerAmount, SCALE, priceM * amountQ, true) * amountQ;
      if (makerAmount === 0n) return badOrder(c.venue, c.name, "the order is worth less than a cent");
    }
    const timestamp = BigInt(Math.floor(c.clock()));
    const s = salt();
    if (!Number.isSafeInteger(s) || s < 0) return no("E_VENUE_REJECTED", { venue: c.venue, message: `${c.name} takes a salt no larger than 2^53` });
    const message = { salt: BigInt(s), maker: w.maker, signer: w.signer, tokenId: BigInt(k.tokenId), makerAmount, takerAmount, side: o.side === "buy" ? 0 : 1, signatureType: w.type, timestamp, metadata: ZERO32, builder: ZERO32 };
    const domain = k.version === "v2" ? { name: DOMAIN_NAME, version: "3", chainId: CHAIN_ID, verifyingContract: EXCHANGE.v3 } : { name: DOMAIN_NAME, version: "2", chainId: CHAIN_ID, verifyingContract: k.negRisk ? EXCHANGE.negRisk : EXCHANGE.standard };
    const hash = hashTypedData({ domain, types: { Order: ORDER }, primaryType: "Order", message });
    let signature: Hex;
    if (w.type !== 3) signature = await w.account.signTypedData({ domain, types: { Order: ORDER }, primaryType: "Order", message });
    else {
      // a Deposit Wallet: its owner signs TypedDataSign under the exchange's domain, and the signature carries the exchange's domain
      // separator, the order's struct hash, the Order type string and that string's length (317 bytes in all)
      const inner = await w.account.signTypedData({ domain, types: { Order: ORDER, TypedDataSign: TYPED_DATA_SIGN }, primaryType: "TypedDataSign", message: { contents: message, name: "DepositWallet", version: "1", chainId: BigInt(CHAIN_ID), verifyingContract: w.signer, salt: ZERO32 } });
      const appDomain = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }], [keccak256(toHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")), keccak256(toHex(DOMAIN_NAME)), keccak256(toHex(domain.version)), BigInt(CHAIN_ID), domain.verifyingContract]));
      const contents = hashStruct({ data: message, primaryType: "Order", types: { Order: ORDER } });
      signature = concatHex([inner, appDomain, contents, toHex(ORDER_TYPE), toHex(ORDER_TYPE.length, { size: 2 })]);
    }
    const k2 = await credsOf();
    if (isRefusal(k2)) return k2;
    // the body as the unified client sends it; it is serialised once, and those exact bytes are signed and sent. The order type and post-only
    // are not in the signed order: they travel only here, `postOnly` last and only when asked (place() allows it on GTC alone). The
    // expiration is "0" for all three types: only a GTD order has one
    const body = JSON.stringify({
      deferExec: false,
      order: { builder: ZERO32, expiration: "0", maker: w.maker, makerAmount: makerAmount.toString(), metadata: ZERO32, salt: s, side: o.side === "buy" ? "BUY" : "SELL", signature, signatureType: w.type, signer: w.signer, takerAmount: takerAmount.toString(), timestamp: timestamp.toString(), tokenId: k.tokenId },
      orderType,
      owner: k2.apiKey,
      ...(o.postOnly === true ? { postOnly: true } : {}),
    });
    return { body, hash, orderType, creds: k2 };
  };

  const trader: LiveTrader = {
    // the credentials were issued when the connection was made: Polymarket will take signed orders from this key
    can: true,
    what: "event contracts",

    async markets(query) {
      try {
        return pick(await catalog(), query);
      } catch (err) {
        return asRefusal(c.venue, c.name, err, secrets());
      }
    },

    async market(symbol) {
      try {
        return await market(symbol);
      } catch (err) {
        return asRefusal(c.venue, c.name, err, secrets());
      }
    },

    async place(o) {
      try {
        // an order the CLOB would not take as asked is refused here, before anything is sent: Polymarket's location check stays the first
        // thing sent for every order
        const orderType = orderTypeOf(o);
        if (isRefusal(orderType)) return orderType;
        if (!(Number.isFinite(o.qty) && o.qty > 0)) return badOrder(c.venue, c.name, "a size is more than zero");
        if (o.type === "limit" && !(o.limitPrice !== undefined && Number.isFinite(o.limitPrice) && o.limitPrice > 0)) return badOrder(c.venue, c.name, "a limit order has a limit price");
        if (o.type === "market" && o.limitPrice !== undefined) return badOrder(c.venue, c.name, "a market order has no limit price");
        // a market order is bounded by the worst price the account allows, or it is not sent
        if (o.type === "market" && !(o.worstPrice !== undefined && Number.isFinite(o.worstPrice) && o.worstPrice > 0)) return badOrder(c.venue, c.name, "a market order here carries the worst price it may fill at");
        const geo = await geoblock();
        if (geo) return geo;
        const k = await resolve(o.symbol);
        if (!k.open) return no("E_VENUE_MARKET_CLOSED", { venue: c.venue, message: `${c.name}: ${k.name} takes no orders now${k.why ? ` (${k.why})` : ""}` });
        const built = await build(o, k, orderType);
        if (isRefusal(built)) return built;
        // Polymarket takes no client order id: an order is its own hash (salt and timestamp make it unique). The account's id stays here
        const mine = { clientId: o.clientId, orderHash: built.hash, orderType: built.orderType, ...(o.postOnly === true ? { postOnly: true } : {}) };
        let r: HttpReply;
        try {
          // the credentials whose key is the body's `owner`, and nothing re-derived on the way: the order is sent once, as signed
          r = await priv("POST", "/order", "", built.body, built.creds);
        } catch (err) {
          return await silent(built.hash, mine, asRefusal(c.venue, c.name, err, secrets()));
        }
        const b = isObj(r.body) ? r.body : {};
        const accepted = b.success === true && (b.errorMsg ?? "") === "" && typeof b.orderID === "string" && b.orderID !== "";
        if (r.status === 200 && accepted) {
          const ref = String(b.orderID);
          const native = { ...mine, orderID: ref, status: b.status ?? null, makingAmount: b.makingAmount ?? null, takingAmount: b.takingAmount ?? null, tradeIDs: Array.isArray(b.tradeIDs) ? b.tradeIDs : [], transactionsHashes: Array.isArray(b.transactionsHashes) ? b.transactionsHashes : [] };
          if (b.status === "live") return { ref, status: "open", filledQty: 0, native };
          // matched at once (wholly or in part): what filled is read from the order itself, the units of making/takingAmount being disputed
          if (b.status === "matched") {
            const now = await read(ref).catch(() => undefined);
            return now ? { ...now, native: { ...native, order: now.native } } : { ref, status: "pending", filledQty: 0, native };
          }
          // `delayed` (a market's matching delay: no fill yet, and it cannot be canceled meanwhile) and `unmatched` (Polymarket's own pages
          // disagree on what it means): taken, and followed until Polymarket says
          return { ref, status: "pending", filledQty: 0, native };
        }
        // a gateway's error or an outage, not one of the CLOB's own answers: the order may have been taken all the same
        // "context canceled" (which the CLOB turns into a 400) is the request cut off mid-way: the order may stand, so it is looked up too
        if ((r.status >= 500 && r.status !== 503 && !/order timed out|no matching orders|filled or killed|rounding|discrepancy/i.test(r.text)) || /context canceled/i.test(r.text)) return await silent(built.hash, mine, refusal(r));
        return refusal(r);
      } catch (err) {
        return asRefusal(c.venue, c.name, err, secrets());
      }
    },

    async cancel(ref) {
      try {
        if (!ORDER_ID.test(ref)) return no("E_ACCOUNT_ORDER_UNKNOWN", { venue: c.venue, message: `${c.name} has no order ${ref}: its orders are 0x and sixty-four hex digits`, detail: { order: ref } });
        const r = await priv("DELETE", "/order", "", JSON.stringify({ orderID: ref }));
        if (r.status !== 200 || !isObj(r.body)) return refusal(r, ref);
        const canceled = (Array.isArray(r.body.canceled) ? r.body.canceled : []).map((x) => String(x).toLowerCase());
        const notCanceled = isObj(r.body.not_canceled) ? r.body.not_canceled : {};
        const reason = Object.entries(notCanceled).find(([id]) => id.toLowerCase() === ref.toLowerCase())?.[1];
        // only what had not filled is canceled; the order is read back as it stands
        if (canceled.includes(ref.toLowerCase())) {
          const now = await read(ref).catch(() => undefined);
          if (now) return now;
          // canceled, but what had filled first is not known yet: left working, so the account follows it until Polymarket says
          const filled = fills.get(ref)?.matched ?? 0;
          return { ref, status: filled > 0 ? "partial" : "open", filledQty: filled, native: { canceled: [ref], readBack: "no answer" } };
        }
        if (reason !== undefined) {
          const said = redact(String(reason), secrets()).slice(0, 200);
          // already matched, or already canceled: read back as that. Anything else (a market's delay window) keeps Polymarket's words
          if (/already matched|already canceled|not found/i.test(said)) {
            const now = await read(ref).catch((err: unknown) => (isRefusal(err) ? err : undefined));
            if (now && !isRefusal(now)) return now;
            if (now && now.code === "E_ACCOUNT_ORDER_UNKNOWN") return { ...now, native: { notCanceled: said } };
          }
          return no("E_VENUE_REJECTED", { venue: c.venue, message: `${c.name} did not cancel ${ref}: ${said}`, detail: { order: ref }, native: { notCanceled: said } });
        }
        return no("E_VENUE_REJECTED", { venue: c.venue, message: `${c.name} answered the cancel without naming ${ref}`, detail: { order: ref }, native: { status: r.status } });
      } catch (err) {
        return asRefusal(c.venue, c.name, err, secrets());
      }
    },

    async status(ref) {
      try {
        if (!ORDER_ID.test(ref)) return no("E_ACCOUNT_ORDER_UNKNOWN", { venue: c.venue, message: `${c.name} has no order ${ref}: its orders are 0x and sixty-four hex digits`, detail: { order: ref } });
        return await read(ref);
      } catch (err) {
        return asRefusal(c.venue, c.name, err, secrets());
      }
    },

    /** What the wallet that holds the money has at Polymarket: the Data API's positions for it, asked as the address connection asks them
     * (address.ts), page by page up to a thousand. A public read, like the balances: nothing is signed and nothing goes to the CLOB */
    async positions() {
      try {
        const out: Position[] = [];
        let cursor = "";
        for (let page = 0; page < 5; page++) {
          // a next page is the cursor with the same `user` (a bare cursor is a 400); the cursor carries the page size
          const body = await getJson(`${DATA}/positions?user=${w.maker}&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
          for (const p of isObj(body) && Array.isArray(body.data) ? body.data.filter(isObj) : []) {
            const held = positionOf(p);
            if (held) out.push(held);
          }
          const pagination = isObj(body) && isObj(body.pagination) ? body.pagination : {};
          cursor = typeof pagination.next_cursor === "string" ? pagination.next_cursor : "";
          if (!cursor) break;
        }
        return out;
      } catch (err) {
        return asRefusal(c.venue, c.name, err, secrets());
      }
    },

    /** Event contracts to discover, from Gamma's events (GET /events, list-events): the open ones (closed=false), the busiest first
     * (order=volume24hr), in one tag when a category is asked (tag_slug), ending within the window when one is asked (end_date_min and
     * end_date_max on the event, and each market's own endDate held to it too). Every outcome of every open order-book market among them is a
     * market, the markets most traded in 24 hours first. Gamma's events carry tags and no category of their own (OBSERVED: `category` is in
     * its schema and absent from its answers), so a market's category is the tag that was asked for, in Gamma's words (its label), or the
     * event's `category` should Gamma send one; with neither, none is said. A read: no location check and no credentials */
    async events({ category, closingWithinMs, limit }) {
      try {
        const n = Math.min(200, Math.floor(limit));
        if (!(n > 0)) return [];
        if (closingWithinMs !== undefined && !(Number.isFinite(closingWithinMs) && closingWithinMs > 0)) return no("E_ACCOUNT_BAD_ACTION", { venue: c.venue, message: "a window for markets closing soon is a number of milliseconds, more than 0" });
        const tag = category !== undefined ? tagSlug(category) : undefined;
        if (tag === "") return no("E_ACCOUNT_BAD_ACTION", { venue: c.venue, message: `a category at ${c.name} is one of its tags, in words ("Sports", "Crypto"), not "${String(category).slice(0, 40)}"` });
        const now = c.clock();
        const until = closingWithinMs !== undefined ? now + closingWithinMs : undefined;
        // an event holds one market or hundreds (a game's every prop): a few events are plenty to choose the busiest markets from
        const many = Math.min(20, Math.max(5, Math.ceil(n / 2)));
        const window = until !== undefined ? `&end_date_min=${encodeURIComponent(new Date(now).toISOString())}&end_date_max=${encodeURIComponent(new Date(until).toISOString())}` : "";
        const body = await getJson(`${GAMMA}/events?closed=false&order=volume24hr&ascending=false&limit=${many}${tag ? `&tag_slug=${encodeURIComponent(tag)}` : ""}${window}`);
        const rows: Outcome[] = [];
        const seen = new Set<string>();
        for (const e of (Array.isArray(body) ? body : []).filter(isObj)) {
          const asked = tag ? (Array.isArray(e.tags) ? e.tags : []).filter(isObj).find((t) => t.slug === tag) : undefined;
          // an event that lists its tags without the one asked for is not in that category, whatever came back
          if (tag && Array.isArray(e.tags) && !asked) continue;
          const cat = typeof asked?.label === "string" && asked.label ? asked.label : typeof e.category === "string" && e.category ? e.category : undefined;
          for (const m of (Array.isArray(e.markets) ? e.markets : []).filter(isObj)) {
            for (const o of outcomesOf(m, cat)) {
              if (!o.open || seen.has(o.symbol)) continue;
              if (until !== undefined && !(o.closeTime && Date.parse(o.closeTime) > now && Date.parse(o.closeTime) <= until)) continue;
              seen.add(o.symbol);
              rows.push(o);
            }
          }
        }
        // the busiest markets first; a market's outcomes stay together, in Gamma's order (the sort is stable)
        rows.sort((a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0));
        return rows
          .map((o) => marketOf(o, undefined))
          .filter((m) => inDollars(m.quote))
          .slice(0, n);
      } catch (err) {
        return asRefusal(c.venue, c.name, err, secrets());
      }
    },

    /** An outcome's price history, from the CLOB's GET /prices-history (get-prices-history: `market` is the outcome's token id, `startTs` and
     * `endTs` Unix seconds, `fidelity` minutes): Polymarket's price at moments `fidelity` apart, folded into bars. A bar's open and close are
     * its first and last price, its high and low the highest and lowest of them — Polymarket's prices at those moments, not the trades'
     * own extremes between them — and Polymarket gives no volume with them, so none is said. A bar starts on a whole step of its length.
     * Polymarket refuses a startTs-to-endTs range longer than about fifteen days, whatever the fidelity ("invalid filters: 'startTs' and
     * 'endTs' interval is too long"), and answers a startTs alone — the endTs is optional — up to now, three hundred days included
     * (OBSERVED 2026-10-05, keyless GETs). So a longer history (the daily bars) is asked from its start with no end */
    async candles(symbol, interval, sinceMs) {
      try {
        if (!Object.hasOwn(FIDELITY_MIN, interval)) return no("E_ACCOUNT_BAD_ACTION", { venue: c.venue, message: `price history comes in bars of 5m, 1h or 1d, not "${String(interval).slice(0, 12)}"` });
        const now = c.clock();
        if (!(Number.isFinite(sinceMs) && sinceMs < now)) return no("E_ACCOUNT_BAD_ACTION", { venue: c.venue, message: "price history starts before now" });
        const k = await resolve(symbol);
        const range = now - sinceMs > HISTORY_RANGE_MS ? "" : `&endTs=${Math.floor(now / 1000)}`;
        const body = await getJson(`${CLOB}/prices-history?market=${k.tokenId}&startTs=${Math.floor(sinceMs / 1000)}${range}&fidelity=${FIDELITY_MIN[interval]}`);
        const points = (isObj(body) && Array.isArray(body.history) ? body.history : [])
          .filter(isObj)
          .map((x) => ({ t: given(x.t), p: given(x.p) }))
          .filter((x): x is { t: number; p: number } => x.t !== undefined && x.t > 0 && x.p !== undefined && x.p >= 0 && x.p <= 1)
          .sort((a, b) => a.t - b.t);
        const step = BAR_MS[interval];
        const bars = new Map<number, Candle>();
        for (const { t, p } of points) {
          const at = Math.floor((t * 1000) / step) * step;
          const b = bars.get(at);
          if (!b) bars.set(at, { t: at, o: p, h: p, l: p, c: p });
          else {
            b.h = Math.max(b.h, p);
            b.l = Math.min(b.l, p);
            b.c = p;
          }
        }
        return [...bars.values()];
      } catch (err) {
        return asRefusal(c.venue, c.name, err, secrets());
      }
    },

    // Not here, because the CLOB has no call for them: amend (POST and DELETE are all /order takes; another price or size is another
    // signed order), close (a position is closed by selling its shares, which place() does), setLeverage (there is no leverage)
  };

  /** Polymarket did not answer an order. The order's id is its EIP-712 hash, known before it is sent, so Polymarket is asked for that
   * order: there (returned as placed), or not there, or no answer — it is never sent twice from here. That the CLOB's id is exactly this
   * hash is what its clients compute; Polymarket's docs call it "the order hash" */
  async function silent(hash: Hex, mine: Record<string, unknown>, why: Refusal): Promise<OrderState | Refusal> {
    try {
      const r = await priv("GET", `/data/order/${hash}`);
      if (r.status === 200 && isObj(r.body) && typeof r.body.id === "string" && r.body.id) {
        const st = await stateOf(r.body);
        return { ...st, native: { ...mine, order: st.native, noAnswer: why.message } };
      }
      if (r.status === 404 || (r.status === 200 && !isObj(r.body)) || /not found/i.test(r.text)) return { ...why, message: `${why.message}, and a moment later it held no order under this order's hash: most likely nothing was placed. Look at ${c.name}'s open orders before placing it again`, detail: { ...mine, placed: "unknown" } };
    } catch {
      // no answer to the question either
    }
    return { ...why, message: `${why.message}: the order may have been taken all the same. Look at ${c.name}'s open orders before placing it again`, detail: { ...mine, placed: "unknown" } };
  }

  return { trader, geoblock, creds: credsOf };
}
