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
 *   POST /order                        one signed order, with the L2 headers: an HMAC over the exact body sent
 *   GET  /data/order/{id}              what became of it; GET /data/trades?market= for the prices it filled at
 *   DELETE /order                      cancel it
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
import type { ChainReader } from "./chain.ts";
import type { KeyFile, KeyShape } from "./credentials.ts";
import { badOrder, ceilTo, floorTo, inDollars, pick, plain, type LiveTrader, type Market, type OrderRequest, type OrderState, type OrderStatus } from "./trade.ts";
import { asRefusal, num, REGION, redact, unreachable, type Http, type HttpReply, type LiveBalance, type LiveSource } from "./types.ts";

export const POLYMARKET_TRADE_KEY: KeyShape = {
  required: ["privateKey"],
  optional: ["funderAddress", "signatureType"],
  example: '{"privateKey": "0x…"} — and when the money sits in a Polymarket wallet, "funderAddress": "0x…" (the address in the profile menu) with "signatureType": "1" (Proxy), "2" (Safe) or "3" (Deposit Wallet)',
};

const CLOB = "https://clob.polymarket.com";
const GAMMA = "https://gamma-api.polymarket.com";
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

const LIST_MS = 5 * 60_000;
/** what market() learned about a symbol is used by place() for this long; the price a market order may fill at comes with the order */
const KNOWN_MS = 60_000;
const TOKEN = /^\d{10,90}$/;
const SLUG = /^[a-z0-9][a-z0-9-]*$/i;
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
}

/** Every outcome of a Gamma market. The trading id follows the market's `version`, even where both id fields are present: a v1 (CTF)
 * market trades its `clobTokenIds` (a JSON-encoded string), a v2 market its `positionIds` (Polymarket says a v1 market's positionIds have
 * no book). Index i of `outcomes` is index i of the ids. Any other version is left out */
function outcomesOf(m: Json): Outcome[] {
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
  const source: LiveSource = {
    name,
    kind: "prediction",
    reference: req.reference,
    via: `Polymarket CLOB · orders signed by the account wallet's key (${SIG_NAME[w.type]})`,
    probe: {
      can: ["trade"],
      note: `orders are made by ${w.maker}${w.maker === w.eoa ? "" : ` and signed by its owner key ${w.eoa}`}; Polymarket issued CLOB credentials for ${w.eoa}, kept in this process's memory only${w.type === 0 ? " · Polymarket says a plain address trades only once it has allowlisted it" : ""}`,
      native: { calls: ["GET polymarket.com/api/geoblock", "GET data-api /v2/positions?user=", "balanceOf pUSD on Polygon", "GET /auth/derive-api-key"], maker: w.maker, signer: w.eoa, signatureType: w.type },
    },
    read: read.source.read,
    readOnlyBecause: "money goes in and out of Polymarket at Polymarket",
    trader: t.trader,
  };
  return { source, first: read.first };
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
      types: ["market", "limit"],
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
      o = ms.flatMap(outcomesOf).find((x) => x.tokenId === s);
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

  /** The signed order, as the official clients build it. `market` is a fill-and-kill order at the worst price the account allows: a sell of
   * the shares asked, a buy of what those shares cost on the book now (Polymarket sizes a fill-and-kill buy in pUSD, so the cost is walked
   * off the asks up to the worst price, and anything the book lacks is counted at the worst price). `limit` rests until filled or canceled */
  const build = async (o: OrderRequest, k: Known): Promise<{ body: string; hash: Hex; orderType: "GTC" | "FAK"; creds: NonNullable<typeof creds> } | Refusal> => {
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
    if (o.type === "limit") {
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
      // each level was rounded up: the whole is held to the shares at the worst price, the most the account valued it at
      const most = mulDiv(shares, priceM, SCALE, false);
      if (cost > most) cost = most;
      // pUSD to two decimals, down: never more than the worst price allows
      const sizeQ = quantum(cfg.size);
      makerAmount = (cost / sizeQ) * sizeQ;
      // the fewest shares it may bring, rounded up, so that no fill is dearer than the worst price
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
    const orderType = o.type === "limit" ? "GTC" : "FAK";
    // the body as the unified client sends it; it is serialised once, and those exact bytes are signed and sent
    const body = JSON.stringify({
      deferExec: false,
      order: { builder: ZERO32, expiration: "0", maker: w.maker, makerAmount: makerAmount.toString(), metadata: ZERO32, salt: s, side: o.side === "buy" ? "BUY" : "SELL", signature, signatureType: w.type, signer: w.signer, takerAmount: takerAmount.toString(), timestamp: timestamp.toString(), tokenId: k.tokenId },
      orderType,
      owner: k2.apiKey,
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
        if (!(Number.isFinite(o.qty) && o.qty > 0)) return badOrder(c.venue, c.name, "a size is more than zero");
        if (o.type === "limit" && !(o.limitPrice !== undefined && Number.isFinite(o.limitPrice) && o.limitPrice > 0)) return badOrder(c.venue, c.name, "a limit order has a limit price");
        if (o.type === "market" && o.limitPrice !== undefined) return badOrder(c.venue, c.name, "a market order has no limit price");
        // a market order is bounded by the worst price the account allows, or it is not sent
        if (o.type === "market" && !(o.worstPrice !== undefined && Number.isFinite(o.worstPrice) && o.worstPrice > 0)) return badOrder(c.venue, c.name, "a market order here carries the worst price it may fill at");
        const geo = await geoblock();
        if (geo) return geo;
        const k = await resolve(o.symbol);
        if (!k.open) return no("E_VENUE_MARKET_CLOSED", { venue: c.venue, message: `${c.name}: ${k.name} takes no orders now${k.why ? ` (${k.why})` : ""}` });
        const built = await build(o, k);
        if (isRefusal(built)) return built;
        // Polymarket takes no client order id: an order is its own hash (salt and timestamp make it unique). The account's id stays here
        const mine = { clientId: o.clientId, orderHash: built.hash, orderType: built.orderType };
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
