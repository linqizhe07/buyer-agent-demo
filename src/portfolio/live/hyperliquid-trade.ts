/** HYPERLIQUID, CONNECTED TO TRADE: an API wallet that signs orders for the owner's own Hyperliquid account — and can never withdraw. It is the
 * trade-only key the account is built around: Hyperliquid takes a withdrawal, a transfer, or a move between spot and perps only on the
 * account's own signature, never on an API wallet's ("API wallets are only used to sign").
 *
 * The key file (credentials/hyperliquid-trade/api-key.json) holds two things: `walletAddress`, the Hyperliquid account's own address, and
 * `privateKey`, the private key of an API wallet that account approved (app.hyperliquid.xyz → More → API → Generate → Authorize API Wallet;
 * an approval lasts at most 180 days). The account's own key is refused: it could withdraw.
 *
 * Connecting asks, in this order, and stops at the first no:
 *   1. Hyperliquid's own line for THIS user, where they are now (location.ts: its Terms of Use §1.6 — the United States, Ontario, the
 *      sanctioned territories). Nothing about the user is sent to learn it, and the place is never kept beyond ten minutes, logged or shown;
 *   2. that the API wallet is approved for that account and its approval has not ended: POST /info {"type":"extraAgents","user"} — the
 *      account's named API wallets, [{name, address, validUntil}] (the app's own read: it is not in the docs; its shape checked live
 *      2026-10-08) — and, for an API wallet not named there, {"type":"userRole","user": the API wallet} → {"role":"agent","data":{"user":
 *      the account}} (in the docs: an account may also hold one unnamed API wallet);
 *   3. the first read, always for the account's own address ("you must pass in the actual address of that account"): userAbstraction,
 *      then clearinghouseState (account value, withdrawable; positions are the trader's), spotClearinghouseState (spot balances) and each
 *      HIP-3 DEX's clearinghouseState {dex}. Under a unified account or portfolio margin the spot balances are the account ("use the spot
 *      balances endpoint instead"), and no perps figure is added to them.
 *
 * TRADING goes through the unified exchange library's Hyperliquid client (ccxt 4.5.85, node_modules/ccxt/js/src/hyperliquid.js, read
 * 2026-10-08), which holds the markets and builds and signs each action with the API wallet's key; what the library reads is asked of it
 * through its own info call (publicPostInfo), so that its rate limiter covers every request. From the library:
 *   · requiredCredentials walletAddress + privateKey; every info read names `walletAddress` as the user;
 *   · the markets: fetchMarkets with types ['spot', 'swap', 'hip3'] — spotMetaAndAssetCtxs, metaAndAssetCtxs, and for HIP-3 perpDexs then
 *     metaAndAssetCtxs {dex} for at most ten DEXs, each market's asset id 110000 + (its DEX's place in perpDexs − 1) × 10000 + its place in
 *     the DEX's universe (Hyperliquid's "100000 + perp_dex_index * 10000 + index_in_meta"); spot ids 10000 + the pair's index; a HIP-3
 *     market is quoted in its DEX's collateral token (USDC, USDH, USDE, USDT0);
 *   · an order is {"type":"order","orders":[{a, b, p, s, r, t: {limit: {tif}}, c}],"grouping":"na"}, signed as an L1 action: msgpack of the
 *     action, the nonce (8 bytes) and a vault flag, keccak-256, as the `connectionId` of the EIP-712 Agent {source: "a", connectionId} in the
 *     domain Exchange · 1 · chain 1337 · the zero address; the nonce is the milliseconds, kept strictly increasing (incrementingNonce);
 *   · a market order needs a price: the library sends Hyperliquid's market order, an IOC limit at price × (1 ± slippage), its
 *     defaultSlippage 5%. The account bounds every market order by its own worst price (account/live-orders.ts: 2% past the ask or the
 *     bid), so the IOC limit goes at exactly that worst price, moved inside onto Hyperliquid's price grid — the same order on the wire;
 *   · what the library does unasked the first time it signs (initializeClient): an approveBuilderFee for its own builder address, a
 *     setReferrer "CCXT1", and from then on a `builder` on every order. Each is a write on the owner's account that the owner did not ask
 *     for — and approveBuilderFee needs the account's own signature, which an API wallet cannot give — so the client is disarmed (disarm):
 *     no builder, no referrer, nothing but the order, the cancel and the leverage change asked for.
 *
 * From Hyperliquid's docs (hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api, read 2026-10-08):
 *   · exchange endpoint: a, b, p, s, r, t, c; tif "Alo" | "Ioc" | "Gtc" (Alo is post-only: "canceled instead of immediately matching"); the
 *     cloid "an optional 128 bit hex string, e.g. 0x1234567890abcdef1234567890abcdef"; answers {"resting":{"oid"}}, {"filled":{"totalSz",
 *     "avgPx","oid"}} or {"error": "Order must have minimum value of $10."}; cancel {"type":"cancel","cancels":[{a, o}]} → "success" or
 *     "Order was never placed, already canceled, or filled."; updateLeverage {asset, isCross, leverage};
 *   · tick and lot size: "Prices can have up to 5 significant figures", "no more than MAX_DECIMALS - szDecimals decimal places" (6 for perps,
 *     8 for spot), "Integer prices are always allowed"; "Sizes are rounded to the szDecimals of that asset";
 *   · info endpoint: orderStatus by oid or by cloid → {"status":"order","order":{order, status, statusTimestamp}} or {"status":"unknownOid"},
 *     and its statuses (open, filled, canceled, triggered, rejected, and the kinds of …Canceled and …Rejected); userFillsByTime (px, sz, fee,
 *     feeToken, oid); l2Book; candleSnapshot; activeAssetData (a coin's leverage, cross or isolated); userRole; userAbstraction
 *     ("unifiedAccount" | "portfolioMargin" | "disabled" | "default" | "dexAbstraction");
 *   · perpetuals: perpDexs; metaAndAssetCtxs {dex} — a market's `marginMode` "strictIsolated" or "noCross" takes isolated margin only;
 *     clearinghouseState {user, dex}; perpCategories, [[coin, category], …] (its shape checked live 2026-10-08: "preipo" among them);
 *   · nonces and API wallets: the 100 highest nonces are kept per signer, within (T − 2 days, T + 1 day); one API wallet per trading process.
 *
 * What is traded here: spot markets quoted in dollars, and perpetuals — the main DEX's and the HIP-3 DEXs' — margined in a dollar stablecoin
 * (USDC, USDT0); a HIP-3 DEX margined in USDH or USDE is not offered, so that every limit means dollars. A HIP-3 perpetual Hyperliquid files
 * under "preipo" on a company live/preipo.ts knows (io:ANTH, io:OAI) is a pre-IPO perpetual, grouped with the other venues' contracts on
 * that company, with the valuation its price implies. Market and limit orders, gtc or ioc, post-only (Alo), reduce-only on a perpetual;
 * cancel; what became of an order (orderStatus, and its fills for the price and the fee); positions; a perpetual's leverage and margin mode.
 * A position is closed by the account with a reduce-only market order. Not offered yet: stops — the library places Hyperliquid's trigger
 * orders, but how one is reported once it fires (whether the order it places keeps its oid) is not in the docs and could not be checked
 * from here, where no order may be placed — and changing an order in place.
 *
 * Every order and every leverage change is held to Hyperliquid's own line first (location.ts), and nothing is signed or sent when the place
 * is closed or not known. Taking an order off the book moves nothing, and is not held to it (as the mm perps path does it, metamask.ts).
 */
import { createHash } from "node:crypto";
import { getAddress, isAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { isRefusal, type Refusal } from "../../core/errors.ts";
import { no } from "../refuse.ts";
import type { KeyFile, KeyShape } from "./credentials.ts";
import { thrownHttp } from "./exchange.ts";
import { heldTo, HYPERLIQUID_RULE, type Locator } from "./location.ts";
import { impliedUsd, PRE_IPO_CATEGORY, preIpoOf } from "./preipo.ts";
import { badOrder, CANDLE_INTERVALS, ceilTo, DONE, floorTo, inDollars, onStep, pick, plain, type Candle, type CandleInterval, type LiveTrader, type Market, type MarketStats, type OrderRequest, type OrderState, type OrderStatus, type Position, type TimeInForce } from "./trade.ts";
import { bannedNo, bannedUntil, edgeRefused, edgeTitle, edgeWords, isStable, notTheApiWords, redact, REGION, type LiveBalance, type LiveSource, type MarginMode } from "./types.ts";

type Dict = Record<string, unknown>;

export const HYPERLIQUID_TRADE_KEY: KeyShape = {
  required: ["walletAddress", "privateKey"],
  example: '{"walletAddress": "0x… (the Hyperliquid account\'s own address)", "privateKey": "0x… (the private key of an API wallet that account approved: More → API → Generate → Authorize API Wallet)"}',
};

/** the page where an API wallet is made and approved */
export const HL_API_PAGE = "https://app.hyperliquid.xyz/API";
const HOW = `Make one at ${HL_API_PAGE} (More → API): name an API wallet, Generate, then Authorize API Wallet with the account's own wallet (an approval lasts at most 180 days), and put that API wallet's private key in the key file`;

// ---- the library's client ----------------------------------------------------------------------------

/** the part of the library's Hyperliquid client this file uses */
export interface HyperliquidClient {
  id: string;
  markets?: Record<string, unknown> | undefined;
  options: Dict;
  enableRateLimit?: boolean | undefined;
  loadMarkets(reload?: boolean): Promise<unknown>;
  /** POST /info, through the library's rate limiter and its reading of the answer */
  publicPostInfo(body: Dict): Promise<unknown>;
  createOrder(symbol: string, type: string, side: string, amount: number, price?: number, params?: Dict): Promise<unknown>;
  cancelOrder(id: string, symbol?: string, params?: Dict): Promise<unknown>;
  setLeverage(leverage: number, symbol?: string, params?: Dict): Promise<unknown>;
  amountToPrecision(symbol: string, amount: number): string;
  priceToPrecision(symbol: string, price: number): string;
  /** what the library does unasked the first time it signs; replaced by disarm() */
  initializeClient?: (() => Promise<boolean>) | undefined;
  /** the library's reading of each answer (base/Exchange.js handleRestResponse: the body, and its parse when it is a JSON object or list);
   * guarded by disarm() */
  handleErrors?(code: number, reason: string, url: string, method: string, headers: unknown, body: string, response: unknown, requestHeaders: unknown, requestBody: unknown): unknown;
}

/** the library's client for one key file; a stand-in's network in tests */
export type OpenHyperliquid = (key: { walletAddress: string; privateKey: string }) => Promise<HyperliquidClient>;

type Ccxt = { hyperliquid: new (config: Dict) => HyperliquidClient };
let library: Promise<Ccxt> | undefined;
const ccxt = (): Promise<Ccxt> => (library ??= import("ccxt").then((m) => (m as unknown as { default: Ccxt }).default));

/** a bare JSON value, which the library hands back as its text: Hyperliquid's own (userAbstraction answers "default"), never a page */
const BARE = /^\s*(?:"[^"<>]*"|null|true|false|-?\d[\d.eE+-]*)\s*$/;

/** The library's client with nothing done unasked: its initializeClient (an approveBuilderFee for the library's own builder, a setReferrer
 * "CCXT1", the account's abstraction looked up) is replaced by a no-op, and with no approved builder fee no order carries a `builder`. Every
 * signed action this account sends is then one the owner or an agent asked for.
 *
 * And nothing taken for Hyperliquid's answer that is not one: a 2xx answer the library cannot parse — a filtering network's page, an empty
 * body — is handed back by the library as text, and would read as a cancel taken, a leverage changed, holdings of nothing. It is thrown
 * instead (BadResponse: no answer), carrying the page's title alone, never the page */
export function disarm(client: HyperliquidClient): HyperliquidClient {
  client.initializeClient = async () => true;
  client.options.builderFee = false;
  client.options.approvedBuilderFee = false;
  client.options.refSet = true;
  const own = client.handleErrors?.bind(client);
  if (own) {
    client.handleErrors = (code, reason, url, method, headers, body, response, requestHeaders, requestBody) => {
      const text = String(body ?? "");
      if ((response === undefined || response === null) && code >= 200 && code < 300 && !BARE.test(text)) {
        const title = edgeTitle(text);
        throw Object.assign(new Error(`hyperliquid ${method} ${url} ${code} ${text.trim() ? `a page, not the API's answer${title ? ` (“${title}”)` : ""}` : "an empty answer"}`), { name: "BadResponse" });
      }
      return own(code, reason, url, method, headers, body, response, requestHeaders, requestBody);
    };
  }
  return client;
}

export const openHyperliquid: OpenHyperliquid = async (key) => {
  const lib = await ccxt();
  return disarm(new lib.hyperliquid({ walletAddress: key.walletAddress, privateKey: key.privateKey, enableRateLimit: true, timeout: 12_000 }));
};

// ---- small readers -------------------------------------------------------------------------------------

const obj = (v: unknown): Dict => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Dict) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : undefined);
const fin = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};
const pos = (v: unknown): number | undefined => {
  const n = fin(v);
  return n !== undefined && n > 0 ? n : undefined;
};
const short = (a: string): string => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const round = (x: number, places: number): number => Number(x.toFixed(places));

// ---- Hyperliquid's price rule ----------------------------------------------------------------------------

/** the most decimals a price has here: MAX_DECIMALS (6 for perps, 8 for spot) less the asset's szDecimals */
const decimalsFor = (kind: "spot" | "perp", szDecimals: number): number => Math.max(0, (kind === "spot" ? 8 : 6) - szDecimals);

/** Does Hyperliquid take this price (Tick and lot size): at most five significant figures and at most `decimals` decimal places — a whole
 * number always passes */
export function hlPriceOk(px: number, decimals: number): boolean {
  if (!(Number.isFinite(px) && px > 0)) return false;
  if (Number.isInteger(px)) return true;
  const [int = "", frac = ""] = plain(px, 12).split(".");
  if (frac.length > decimals) return false;
  return `${int === "0" ? "" : int}${frac}`.replace(/^0+/, "").length <= 5;
}

/** the power of ten of a price: 81359 → 4, 0.11 → −1 */
function magnitude(px: number): number {
  let e = Math.floor(Math.log10(px));
  if (10 ** (e + 1) <= px) e += 1;
  if (10 ** e > px) e -= 1;
  return e;
}

/** the grid of prices Hyperliquid takes around `px`: the fifth significant figure, never finer than the decimals allowed; a whole number
 * from 100,000 up */
export function hlPriceStep(px: number, decimals: number): number {
  if (!(px > 0)) return 10 ** -decimals;
  if (px >= 100_000) return 1;
  return Number(Math.max(10 ** (magnitude(px) - 4), 10 ** -decimals).toPrecision(1));
}

/** the nearest price Hyperliquid takes at or inside `px`: down for a buy's worst price, up for a sell's — never looser than asked. NaN when
 * there is none (a price under the smallest step) */
export function hlPriceInside(px: number, decimals: number, dir: "down" | "up"): number {
  if (!(Number.isFinite(px) && px > 0)) return NaN;
  const step = hlPriceStep(px, decimals);
  const out = dir === "down" ? floorTo(px, step) : ceilTo(px, step);
  return out > 0 && hlPriceOk(out, decimals) ? out : NaN;
}

// ---- Hyperliquid's refusals, in its words ------------------------------------------------------------------

/** what the library threw: its class, and Hyperliquid's own sentence — the library puts the answer's body after its id ("hyperliquid {…}"),
 * and the sentence is the body's `response` when its status is "err", else the first order status's `error` */
export function hlSaid(err: unknown, secrets: string[] = []): { kind: string; said: string } {
  const e = err as { name?: unknown; message?: unknown } | undefined;
  const kind = String(e?.name ?? "");
  const text = redact(String(e?.message ?? err), secrets);
  const at = text.indexOf("{");
  if (at >= 0) {
    try {
      const body = obj(JSON.parse(text.slice(at)));
      if (body.status === "err" && typeof body.response === "string") return { kind, said: body.response.slice(0, 300) };
      if (body.status === "unknownOid") return { kind, said: "unknownOid" };
      const data = obj(obj(body.response).data);
      for (const s of arr(data.statuses)) {
        const w = obj(s).error;
        if (typeof w === "string") return { kind, said: w.slice(0, 300) };
      }
      const st = obj(data.status).error;
      if (typeof st === "string") return { kind, said: st.slice(0, 300) };
    } catch {
      // not JSON after all: the library's own words are said instead
    }
  }
  return { kind, said: text.replace(/^hyperliquid\s+/, "").replace(/\s+/g, " ").slice(0, 300) };
}

const INSUFFICIENT = /insufficient (margin|spot balance|balance)/i;
const UNKNOWN_ORDER = /never placed, already canceled, or filled|unknownOid/i;
const NO_AGENT = /user or api wallet .* does not exist/i;
const NO_MATCH = /could not immediately match|no liquidity available|post only order would have immediately matched/i;
const AS_WRITTEN = /minimum value of \$10|divisible by tick size|invalid size|zero size|away from the reference price|invalid tp\/sl price|reduce only order would increase position|invalid leverage|leverage .*(exceed|too high|max)/i;
const RATE = /too many (cumulative )?requests|rate limit/i;
const NONCE = /\bnonce\b/i;
const DOWN = new Set(["NetworkError", "RequestTimeout", "ExchangeNotAvailable", "OnMaintenance", "TimeoutError", "AbortError"]);
/** an order call that failed this way may still have reached Hyperliquid: no answer, or a page in place of its answer (disarm) */
const UNSURE = new Set(["RequestTimeout", "NetworkError", "ExchangeNotAvailable", "TimeoutError", "AbortError", "BadResponse"]);

/** Hyperliquid's no as the account's refusal: its own sentence, with " asset=N" (its internal index) left to `native`. What the server in
 * front of it answered is read from the whole answer, not the sentence cut from it: an edge's page says where it is from further in */
export function hyperliquidNo(venue: string, name: string, err: unknown, secrets: string[] = [], ref?: string): Refusal {
  if (isRefusal(err)) return err;
  const { kind, said } = hlSaid(err, secrets);
  const words = said.replace(/\s*asset=\d+\s*$/, "").trim();
  const native = { error: kind, said };
  const theirs = `${name}: ${words}`;
  const whole = redact(String((err as { message?: unknown } | undefined)?.message ?? err), secrets).replace(/\s+/g, " ");
  const http = thrownHttp(whole);
  // something on this network answered in Hyperliquid's place with a page (disarm): no answer — never its yes, nor its no
  if (kind === "BadResponse") return no("E_VENUE_UNREACHABLE", { venue, message: notTheApiWords(name), native: { error: kind, ...(http ? { status: http.status } : {}), page: true } });
  if (REGION.test(said)) return no("E_VENUE_GEOBLOCKED", { venue, message: `${name} does not serve this location: that is its own rule, and the account does not look for a way around it. It answered: “${words}”`, native });
  if (REGION.test(whole)) {
    // a page that names the place past the sentence kept (CloudFront's "configured to block access from your country"): the words around it
    const plain = (http ? http.body : whole).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    const at = Math.max(0, plain.search(REGION));
    const around = plain.slice(Math.max(0, at - 120), at + 120).trim();
    return no("E_VENUE_GEOBLOCKED", { venue, message: `${name} does not serve this location: that is its own rule, and the account does not look for a way around it. It answered: “${around}”`, native: { error: kind, said: around } });
  }
  // the server in front of Hyperliquid refusing this network with a page of its own (the library calls it "not available"): its answer,
  // not a moment without one — and an order it refused was never placed
  if (http && edgeRefused(http.status, http.body)) return no("E_VENUE_GEOBLOCKED", { venue, message: edgeWords(name, http.status, http.body), native: { error: kind, status: http.status, edge: true } });
  // banned for too many requests: until when it says, or ten minutes
  const until = bannedUntil(whole);
  if (until !== undefined || http?.status === 418) return bannedNo(venue, name, until, native);
  if (NO_AGENT.test(said)) return no("E_VENUE_UNAUTHORIZED", { venue, message: `${theirs} — the API wallet is not, or is no longer, approved for this account. ${HOW}`, native });
  if (INSUFFICIENT.test(said) || kind === "InsufficientFunds") return no("E_VENUE_INSUFFICIENT", { venue, message: theirs, native });
  if (UNKNOWN_ORDER.test(said) || kind === "OrderNotFound") return no("E_ACCOUNT_ORDER_UNKNOWN", { venue, message: ref ? `${name} has no open order ${ref} for this account (${words})` : theirs, ...(ref ? { detail: { order: ref } } : {}), native });
  if (NO_MATCH.test(said)) return no("E_VENUE_REJECTED", { venue, message: `${theirs.replace(/\.$/, "")}. Nothing was filled`, native });
  // badOrder's refusal, with Hyperliquid's own answer passed through no() so that the address scrub is not undone
  if (AS_WRITTEN.test(said) || kind === "InvalidOrder" || kind === "BadSymbol") return no("E_VENUE_ORDER_INVALID", { venue, message: `${name}: ${words}`, native });
  // held the minute the sentence says (holdBackMs reads the status)
  if (RATE.test(said) || kind === "RateLimitExceeded" || kind === "DDoSProtection") return no("E_VENUE_UNREACHABLE", { venue, message: `${theirs}: try again in a minute`, native: { ...native, status: 429 } });
  // Hyperliquid keeps each signer's highest nonces ("Use a API wallet per trading process"): one shared with another program can collide
  if (NONCE.test(said)) return no("E_VENUE_REJECTED", { venue, message: `${theirs} — Hyperliquid asks for one API wallet per trading process: give this account an API wallet of its own, then try again`, native });
  if (kind === "AuthenticationError" || kind === "PermissionDenied") return no("E_VENUE_UNAUTHORIZED", { venue, message: theirs, native });
  if (DOWN.has(kind)) return no("E_VENUE_UNREACHABLE", { venue, message: `${name} could not be reached${kind === "RequestTimeout" ? ": no answer in time" : ""}`, native });
  return no("E_VENUE_REJECTED", { venue, message: theirs, native });
}

// ---- the key file ------------------------------------------------------------------------------------------

/** The key file's two fields: an address, and a private key that is an API wallet's — never the account's own. Field names are said, never
 * a value */
export function hyperliquidKey(venue: string, key: KeyFile): { user: Hex; agent: Hex; privateKey: Hex } | Refusal {
  const user = (key.walletAddress ?? "").trim();
  const pk = (key.privateKey ?? "").trim();
  if (!isAddress(user, { strict: false })) return no("E_ACCOUNT_CREDENTIAL", { venue, message: '"walletAddress" in the key file is not an address: it is the Hyperliquid account\'s own address, 0x and forty hex digits', detail: { field: "walletAddress" } });
  const hex = /^(0x)?[0-9a-fA-F]{64}$/.test(pk) ? ((pk.startsWith("0x") ? pk : `0x${pk}`) as Hex) : undefined;
  let agent: Hex | undefined;
  try {
    agent = hex ? privateKeyToAccount(hex).address : undefined;
  } catch {
    agent = undefined;
  }
  if (!hex || !agent) return no("E_ACCOUNT_CREDENTIAL", { venue, message: '"privateKey" in the key file is not a private key: it is the API wallet\'s, 0x and sixty-four hex digits', detail: { field: "privateKey" } });
  if (agent.toLowerCase() === user.toLowerCase()) return no("E_ACCOUNT_CREDENTIAL", { venue, message: `the key file holds the account's own private key, which could withdraw: this connection takes only an API wallet's key, which cannot. ${HOW}`, detail: { field: "privateKey" } });
  return { user: getAddress(user), agent, privateKey: hex };
}

/** the account's id for an order as Hyperliquid takes it: a 128-bit hex string. The account's own is thirty-two hex digits already */
export const cloidOf = (clientId: string): string => `0x${/^[0-9a-f]{32}$/i.test(clientId) ? clientId.toLowerCase() : createHash("sha256").update(clientId).digest("hex").slice(0, 32)}`;

// ---- the markets, as the library loads them ------------------------------------------------------------------

/** one market, as the account names and checks it */
interface Entry {
  /** the library's unified symbol: BTC/USDC:USDC, XYZ-NVDA/USDC:USDC, HYPE/USDC */
  symbol: string;
  kind: "spot" | "perp";
  /** Hyperliquid's own name for it, as its info calls take it: BTC, xyz:NVDA, @107, PURR/USDC */
  coin: string;
  /** "" for the main DEX and for spot; a HIP-3 DEX's name (xyz) */
  dex: string;
  /** the asset id an action carries */
  asset: number;
  base: string;
  quote: string;
  /** a spot token's own name where the library calls it otherwise (UBTC for BTC) */
  token?: string | undefined;
  szDecimals: number;
  decimals: number;
  maxLeverage?: number | undefined;
  /** the market takes isolated margin only (its marginMode strictIsolated or noCross) */
  isolatedOnly: boolean;
  delisted: boolean;
  /** the 24-hour dollar volume and the price when the list was loaded, to order the list and to draw its price grid */
  volume: number;
  refPrice?: number | undefined;
  /** traded here: quoted in dollars and not delisted */
  offered: boolean;
}

const LIST_MS = 5 * 60_000;
const CTX_MS = 15_000;
const KEEP_MS = 10 * 60_000;
/** a market order's worst price when none is given: the room account/live-orders.ts gives one (SLIPPAGE) */
const ROOM = 0.02;
/** the smallest order Hyperliquid takes ("Order must have minimum value of $10") */
const MIN_USD = 10;
const STATS_MAX = 40;
const BARS = 300;
const BAR_MS: Record<CandleInterval, number> = { "5m": 300_000, "1h": 3_600_000, "1d": 86_400_000 };
const TIFS: TimeInForce[] = ["gtc", "ioc"];
/** Hyperliquid pays funding every hour, on the hour */
const nextHour = (now: number): string => new Date((Math.floor(now / 3_600_000) + 1) * 3_600_000).toISOString();

export interface HyperliquidTradeRequest {
  venue: string;
  label: string;
  reference: string;
  key: KeyFile;
  /** where this user is: one per connection (location.ts) */
  where: Locator;
  clock: () => number;
  open?: OpenHyperliquid | undefined;
}

/** What the connection and its trader share: the client, the market list, and Hyperliquid's answers kept a moment */
function book(c: { venue: string; name: string; user: Hex; client: HyperliquidClient; clock: () => number; secrets: string[] }) {
  const user = c.user.toLowerCase();
  let loadedAt = 0;
  let loadFailed = false;
  let entries: Entry[] = [];
  const bySymbol = new Map<string, Entry>();
  const byCoin = new Map<string, Entry>();
  const dexNames = new Map<string, string>();
  /** Hyperliquid's own category for each HIP-3 market (perpCategories: "stocks", "commodities", "preipo" …) */
  const categories = new Map<string, string>();
  const kept = new Map<string, { at: number; value: unknown }>();

  const fail = (err: unknown, ref?: string): Refusal => hyperliquidNo(c.venue, c.name, err, c.secrets, ref);
  /** an answer that is not Hyperliquid's (nothing, or text that is not a bare JSON value): no answer */
  const page = (call: string): Refusal => no("E_VENUE_UNREACHABLE", { venue: c.venue, message: notTheApiWords(c.name), native: { call, page: true } });
  /** one info read; a refusal is thrown as the account's */
  const info = async (body: Dict): Promise<unknown> => {
    let answer: unknown;
    try {
      answer = await c.client.publicPostInfo(body);
    } catch (err) {
      throw fail(err);
    }
    // disarm() throws for a page; this is the last look, so that nothing is ever read as an answer of nothing
    if (answer === undefined || answer === null || (typeof answer === "string" && !BARE.test(answer))) throw page(`POST /info ${String(body.type)}`);
    return answer;
  };
  /** an answer kept `ms`; a failed one is not kept */
  const keep = async <T>(key: string, ms: number, ask: () => Promise<T>): Promise<T> => {
    const k = kept.get(key);
    if (k && c.clock() - k.at < ms) return k.value as T;
    const value = await ask();
    kept.set(key, { at: c.clock(), value });
    return value;
  };

  const toEntry = (r: Dict): Entry | undefined => {
    const i = obj(r.info);
    const symbol = str(r.symbol);
    const kind = r.spot === true ? "spot" : r.swap === true ? "perp" : undefined;
    if (!symbol || !kind) return undefined;
    const step = pos(obj(r.precision).amount);
    const szDecimals = fin(i.szDecimals) ?? (step !== undefined ? Math.max(0, Math.round(-Math.log10(step))) : 0);
    const coin = kind === "perp" ? (str(r.baseName) ?? str(i.name) ?? "") : (str(r.id) ?? "");
    const dex = kind === "perp" ? (str(i.dex) ?? "") : "";
    const quote = String(r.quote ?? "");
    const delisted = i.isDelisted === true || r.active === false;
    const mode = str(i.marginMode);
    const baseName = str(r.baseName);
    return {
      symbol,
      kind,
      coin,
      dex,
      asset: Number(r.baseId ?? NaN),
      base: kind === "perp" ? (coin.includes(":") ? coin.slice(coin.indexOf(":") + 1) : coin) : String(r.base ?? ""),
      quote,
      ...(kind === "spot" && baseName && baseName !== r.base ? { token: baseName } : {}),
      szDecimals,
      decimals: decimalsFor(kind, szDecimals),
      ...(kind === "perp" && pos(obj(obj(r.limits).leverage).max) !== undefined ? { maxLeverage: pos(obj(obj(r.limits).leverage).max) } : {}),
      isolatedOnly: kind === "perp" && (i.onlyIsolated === true || mode === "strictIsolated" || mode === "noCross"),
      delisted,
      volume: fin(i.dayNtlVlm) ?? 0,
      refPrice: pos(i.midPx) ?? pos(i.markPx),
      offered: !delisted && coin !== "" && Number.isInteger(Number(r.baseId)) && inDollars(quote) && (kind === "spot" || inDollars(String(r.settle ?? quote))),
    };
  };

  /** the library's market list, kept five minutes (a list that cannot be reloaded is used as it was), the HIP-3 DEXs' full names (perpDexs)
   * and Hyperliquid's category for each of their markets (perpCategories: [[coin, category], …], read live 2026-10-08), each kept ten minutes.
   * After a load that failed the library is asked afresh: it otherwise hands the same failed load to every later call, and one blip on the
   * first load would leave the connection without markets until it is made again */
  const load = async (): Promise<Refusal | undefined> => {
    if (loadedAt && c.clock() - loadedAt < LIST_MS) return undefined;
    try {
      await c.client.loadMarkets(loadedAt > 0 || loadFailed);
      loadFailed = false;
    } catch (err) {
      loadFailed = true;
      if (loadedAt) return undefined;
      return fail(err);
    }
    const next = Object.values(c.client.markets ?? {}).map((m) => toEntry(obj(m))).filter((e): e is Entry => e !== undefined);
    // a load that came back with no markets is not a list (Hyperliquid always lists some): one held stays, and the next look loads again
    if (!next.length) {
      loadFailed = true;
      return entries.length ? undefined : page("the market list");
    }
    next.sort((a, b) => b.volume - a.volume || a.symbol.localeCompare(b.symbol));
    entries = next;
    bySymbol.clear();
    byCoin.clear();
    for (const e of next) {
      bySymbol.set(e.symbol.toUpperCase(), e);
      byCoin.set(e.coin.toUpperCase(), e);
    }
    loadedAt = c.clock();
    try {
      for (const d of arr(await keep("perpDexs", KEEP_MS, () => info({ type: "perpDexs" })))) {
        const n = str(obj(d).name);
        if (n) dexNames.set(n, str(obj(d).fullName) ?? n);
      }
    } catch {
      // the DEXs are named by their short names instead
    }
    try {
      for (const row of arr(await keep("perpCategories", KEEP_MS, () => info({ type: "perpCategories" })))) {
        const [coin, category] = arr(row);
        if (typeof coin === "string" && typeof category === "string") categories.set(coin.toUpperCase(), category);
      }
    } catch {
      // no categories this time: a pre-IPO perpetual is known by its company's name alone (live/preipo.ts)
    }
    return undefined;
  };

  /** one market by the account's name for it — the library's symbol, Hyperliquid's own coin (BTC, xyz:NVDA, @107), or <COIN>-PERP and
   * <dex>:<COIN>-PERP as the public listings name a perpetual (BTC-PERP, io:ANTH-PERP) — or the reason it is not one traded here */
  const find = async (symbol: string): Promise<Entry | Refusal> => {
    const failed = await load();
    if (failed) return failed;
    const s = symbol.trim();
    const u = s.toUpperCase();
    const perp = /^(.+)-PERP$/i.exec(s);
    const named = perp ? byCoin.get(perp[1]!.toUpperCase()) : undefined;
    const e = bySymbol.get(u) ?? byCoin.get(u) ?? (named?.kind === "perp" ? named : undefined);
    if (!e) return no("E_VENUE_REJECTED", { venue: c.venue, message: `${c.name} lists no market "${s}": a market is named as portfolio_live_markets names it — BTC/USDC:USDC for the perpetual, HYPE/USDC for spot, XYZ-NVDA/USDC:USDC for a HIP-3 perpetual` });
    if (!inDollars(e.quote)) return no("E_ACCOUNT_UNPRICED", { venue: c.venue, message: `${e.symbol} is ${e.kind === "perp" ? `margined and priced in ${e.quote}` : `priced in ${e.quote}`}: the account trades markets priced in dollars, so that every limit means dollars` });
    return e;
  };

  /** Hyperliquid's asset contexts for one group of markets — a DEX's perpetuals (metaAndAssetCtxs {dex}) or spot (spotMetaAndAssetCtxs) —
   * by coin, kept fifteen seconds */
  const ctxOf = (group: string): Promise<Map<string, Dict>> =>
    keep(`ctx:${group}`, CTX_MS, async () => {
      const out = new Map<string, Dict>();
      if (group === "spot") {
        // [spotMeta, ctxs]: each ctx names its own coin (PURR/USDC, @107)
        for (const x of arr(arr(await info({ type: "spotMetaAndAssetCtxs" }))[1])) {
          const coin = str(obj(x).coin);
          if (coin) out.set(coin.toUpperCase(), obj(x));
        }
        return out;
      }
      const [meta, ctxs] = arr(await info({ type: "metaAndAssetCtxs", ...(group ? { dex: group } : {}) }));
      const universe = arr(obj(meta).universe);
      arr(ctxs).forEach((x, i) => {
        const coin = str(obj(universe[i]).name);
        if (coin) out.set(coin.toUpperCase(), obj(x));
      });
      return out;
    });
  const groupOf = (e: Entry): string => (e.kind === "spot" ? "spot" : e.dex);

  return {
    user,
    info,
    keep,
    /** the last answer kept under `key`, however old: what was learned before, for a read that is refused now */
    lastKept: (key: string): unknown => kept.get(key)?.value,
    fail,
    page,
    load,
    find,
    ctxOf,
    groupOf,
    entries: () => entries,
    bySymbol: (symbol: string) => bySymbol.get(symbol.trim().toUpperCase()),
    byCoin: (coin: string) => byCoin.get(coin.trim().toUpperCase()),
    categoryOf: (coin: string) => categories.get(coin.toUpperCase()),
    dexName: (dex: string) => dexNames.get(dex) ?? dex.toUpperCase(),
    loaded: () => loadedAt > 0,
  };
}
type Book = ReturnType<typeof book>;

// ---- the connection -------------------------------------------------------------------------------------------

/** Is this API wallet approved for this account, and not past its end? Named API wallets by extraAgents (with their end); one not named there
 * answers for itself (userRole). A no says how to approve one at Hyperliquid */
async function approval(b: Book, c: { venue: string; name: string; user: Hex; agent: Hex; clock: () => number }): Promise<{ name?: string | undefined; validUntil?: number | undefined } | Refusal> {
  let named: unknown;
  try {
    named = await b.info({ type: "extraAgents", user: b.user });
  } catch (err) {
    // the app's own read, not in the docs: its absence is not a no, and userRole (in the docs) answers below. Hyperliquid's own no is one
    const r = err as Refusal;
    if (isRefusal(r) && (r.code === "E_VENUE_GEOBLOCKED" || r.code === "E_VENUE_UNREACHABLE")) return r;
    named = undefined;
  }
  const list = arr(named).map(obj);
  const mine = list.find((a) => String(a.address ?? "").toLowerCase() === c.agent.toLowerCase());
  if (mine) {
    const until = fin(mine.validUntil);
    const nm = str(mine.name);
    if (until !== undefined && until <= c.clock()) return no("E_VENUE_UNAUTHORIZED", { venue: c.venue, message: `${c.name}'s approval of this API wallet${nm ? ` (“${nm}”)` : ""} ended on ${iso(until)}: an API wallet is approved for at most 180 days. ${HOW}`, native: { call: "POST /info extraAgents", agent: c.agent, validUntil: until } });
    return { ...(nm ? { name: nm } : {}), ...(until !== undefined ? { validUntil: until } : {}) };
  }
  let role: Dict;
  try {
    role = obj(await b.info({ type: "userRole", user: c.agent.toLowerCase() }));
  } catch (err) {
    return err as Refusal;
  }
  const master = str(obj(role.data).user)?.toLowerCase();
  if (role.role === "agent" && master === b.user) return {};
  if (role.role === "agent" && master) return no("E_VENUE_UNAUTHORIZED", { venue: c.venue, message: `this API wallet (${short(c.agent)}) is approved for another Hyperliquid account (${short(master)}), not for ${short(c.user)}: put that account's address in "walletAddress", or approve an API wallet for ${short(c.user)}. ${HOW}`, native: { call: "POST /info userRole", role: "agent" } });
  // the address in the key file may be an API wallet's, a sub-account's or a vault's, rather than an account that signs for itself
  let owner: Dict = {};
  try {
    owner = obj(await b.info({ type: "userRole", user: b.user }));
  } catch {
    owner = {};
  }
  if (owner.role === "agent") return no("E_ACCOUNT_CREDENTIAL", { venue: c.venue, message: `"walletAddress" (${short(c.user)}) is an API wallet's address, not an account's: put there the Hyperliquid account's own address, the one it deposits to and trades from`, detail: { field: "walletAddress" } });
  if (owner.role === "subAccount" || owner.role === "vault") return no("E_VENUE_REJECTED", { venue: c.venue, message: `${short(c.user)} is a Hyperliquid ${owner.role === "vault" ? "vault" : "sub-account"}: this connection trades an account that signs for itself, and a ${owner.role === "vault" ? "vault" : "sub-account"} is traded by its master's API wallet on its behalf, which is not offered here` });
  return no("E_VENUE_UNAUTHORIZED", { venue: c.venue, message: `${c.name} has not approved this API wallet (${short(c.agent)}) for ${short(c.user)}${list.length ? ` — its API wallets are ${list.map((a) => `“${str(a.name) ?? short(String(a.address ?? ""))}”`).join(", ")}` : ""}. ${HOW}`, native: { call: "POST /info extraAgents", named: list.length } });
}

/** What the account holds at Hyperliquid, as Hyperliquid reports it, for the account's own address: the perps account value (open positions
 * marked) with what can be withdrawn, each HIP-3 DEX's account value, and the spot balances priced at Hyperliquid's own mids — or, under a
 * unified account or portfolio margin, the spot balances alone, which are the whole account there */
async function balances(b: Book, name: string): Promise<LiveBalance[]> {
  // Hyperliquid answers a bare JSON string ("default"), which the library hands back as its text, quotes and all: a word, or it is not its
  // answer. A refused read takes the kind learned before, never a guess — a unified account taken for an ordinary one has its perps value
  // counted on top of the spot balances that are the same money; never learned, the read is refused as the other reads are
  const mode = await b
    .keep("abstraction", KEEP_MS, async () => {
      const m = String(await b.info({ type: "userAbstraction", user: b.user })).replace(/"/g, "").trim();
      if (!/^[A-Za-z]+$/.test(m)) throw b.page("POST /info userAbstraction");
      return m;
    })
    .catch((err: unknown) => {
      const last = b.lastKept("abstraction");
      if (typeof last === "string") return last;
      throw err;
    });
  const unified = mode === "unifiedAccount" || mode === "portfolioMargin";
  const [perps, spot] = await Promise.all([b.info({ type: "clearinghouseState", user: b.user }), b.info({ type: "spotClearinghouseState", user: b.user })]);
  const out: LiveBalance[] = [];
  if (!unified) {
    const v = fin(obj(obj(perps).marginSummary).accountValue) ?? 0;
    if (v > 0) out.push({ asset: "USDC", amount: v, usd: v, where: `perps · ${(fin(obj(perps).withdrawable) ?? 0).toFixed(2)} withdrawable`, class: "stable" });
  }
  // the markets name a spot token as the rest of the account does (UBTC is BTC, as the library maps it) and give its USDC pair for a price;
  // each HIP-3 DEX's perps account is found from them too. A list that cannot be loaded makes a read that is not whole — the DEXs' accounts
  // missing, the tokens unpriced — and it is refused rather than kept as complete (under a unified account holding only dollars, nothing
  // here needs the list)
  const failed = b.loaded() ? undefined : await b.load();
  const rows = arr(obj(spot).balances).map(obj).filter((x) => (fin(x.total) ?? 0) > 0);
  if (failed && (!unified || rows.some((x) => !isStable(String(x.coin ?? ""))))) throw failed;
  const listed = !failed;
  const pairs = new Map<string, Entry>();
  if (listed) for (const e of b.entries()) if (e.kind === "spot" && e.quote === "USDC" && !e.delisted) pairs.set((e.token ?? e.base).toUpperCase(), e);
  const needMids = rows.some((x) => !isStable(String(x.coin ?? "")) && pairs.has(String(x.coin ?? "").toUpperCase()));
  // the mids refused: the read is refused, not kept with the tokens counted as nothing
  const mids = needMids ? obj(await b.info({ type: "allMids" })) : {};
  for (const x of rows) {
    const coin = String(x.coin ?? "?");
    const amount = fin(x.total) ?? 0;
    const pair = pairs.get(coin.toUpperCase());
    const asset = pair && pair.token ? pair.base : coin;
    const mid = pair ? pos(mids[pair.coin]) : undefined;
    const usd = isStable(coin) ? amount : mid !== undefined ? round(amount * mid, 8) : undefined;
    out.push({ asset, amount, ...(usd !== undefined ? { usd } : {}), where: `${unified ? "spot and perps · unified account" : "spot"}${asset !== coin ? ` · ${coin} on ${name}` : ""}`, ...(isStable(coin) ? { class: "stable" as const } : {}) });
  }
  // each HIP-3 DEX keeps its own perps account; under a unified account its margin is in the spot balances already. One refused (a rate
  // limit, an edge's page) refuses the read: the account keeps the last whole one, rather than one with that DEX's money gone
  if (!unified && listed) {
    const dexes = new Map<string, string>();
    for (const e of b.entries()) if (e.kind === "perp" && e.dex && !dexes.has(e.dex)) dexes.set(e.dex, e.quote);
    const states = await Promise.all([...dexes.keys()].map((dex) => b.info({ type: "clearinghouseState", user: b.user, dex })));
    [...dexes.entries()].forEach(([dex, collateral], i) => {
      const s = obj(states[i]);
      const v = fin(obj(s.marginSummary).accountValue) ?? 0;
      if (v > 0) out.push({ asset: collateral, amount: v, ...(isStable(collateral) ? { usd: v, class: "stable" as const } : {}), where: `perps · ${b.dexName(dex)} (HIP-3) · ${(fin(s.withdrawable) ?? 0).toFixed(2)} withdrawable` });
    });
  }
  return out;
}

/** Hyperliquid, connected to trade: Hyperliquid's own line for this user first, then the API wallet's approval for the account, then the
 * account's balances — each no in Hyperliquid's words, and nothing signed on the way */
export async function hyperliquidTradeSource(req: HyperliquidTradeRequest): Promise<{ source: LiveSource; first: LiveBalance[] } | Refusal> {
  const k = hyperliquidKey(req.venue, req.key);
  if (isRefusal(k)) return k;
  const name = req.label || "Hyperliquid";
  const secrets = [k.privateKey, k.privateKey.slice(2)];
  // 1. Hyperliquid's own line, for this user where they are now: before anything about the account is asked
  const line = await heldTo(HYPERLIQUID_RULE, req.where, req.venue, "");
  if (line) return line;
  let client: HyperliquidClient;
  try {
    client = await (req.open ?? openHyperliquid)({ walletAddress: k.user, privateKey: k.privateKey });
  } catch (err) {
    return no("E_VENUE_REJECTED", { venue: req.venue, message: `the exchange library could not open ${name}`, native: { error: redact(String((err as Error)?.message ?? err), secrets).slice(0, 200) } });
  }
  const b = book({ venue: req.venue, name, user: k.user, client, clock: req.clock, secrets });
  // 2. the API wallet, approved for this account and not past its end
  const ok = await approval(b, { venue: req.venue, name, user: k.user, agent: k.agent, clock: req.clock });
  if (isRefusal(ok)) return ok;
  // 3. what the account holds
  let first: LiveBalance[];
  try {
    first = await balances(b, name);
  } catch (err) {
    return hyperliquidNo(req.venue, name, err, secrets);
  }
  const until = ok.validUntil;
  const trader = hyperliquidTrader({ venue: req.venue, name, b, client, where: req.where, clock: req.clock, secrets, validUntil: until });
  const who = `an API wallet${ok.name ? ` (“${ok.name}”)` : ""} approved for ${k.user}${until !== undefined ? `, until ${iso(until)}` : " (unnamed: Hyperliquid reports no end for it)"}`;
  const source: LiveSource = {
    name,
    kind: "perp",
    reference: req.reference,
    via: `Hyperliquid · orders signed by an API wallet (unified exchange library)`,
    probe: {
      can: ["trade"],
      note: `${who}: it signs orders, cancels and leverage changes for the account, and Hyperliquid takes no withdrawal or transfer signed by it · every order is held first to Hyperliquid's own line for where you are (its Terms of Use §1.6)`,
      native: { calls: ["GET polymarket.com/api/geoblock (country and region only, kept in memory)", "POST /info extraAgents", "POST /info userAbstraction", "POST /info clearinghouseState", "POST /info spotClearinghouseState"], account: k.user, agent: k.agent, ...(ok.name ? { agentName: ok.name } : {}), ...(until !== undefined ? { validUntil: until } : {}) },
    },
    read: () => balances(b, name).catch((err) => Promise.reject(hyperliquidNo(req.venue, name, err, secrets))),
    readOnlyBecause: `an API wallet signs orders for the account and nothing else: Hyperliquid takes a withdrawal, a transfer or a move between spot and perps only on the account's own signature, so no money moves from here — it moves at app.hyperliquid.xyz`,
    trader,
  };
  return { source, first };
}

// ---- the trader ----------------------------------------------------------------------------------------------------

function hyperliquidTrader(c: { venue: string; name: string; b: Book; client: HyperliquidClient; where: Locator; clock: () => number; secrets: string[]; validUntil?: number | undefined }): LiveTrader {
  const { venue, name, b, client } = c;
  const live = () => c.validUntil === undefined || c.clock() < c.validUntil;
  /** what Hyperliquid last said had filled of each order (fills only grow): a cancel whose order could not be read back says that, never
   * that nothing filled */
  const fills = new Map<string, { qty: number; avg?: number | undefined }>();
  const heard = (s: OrderState): OrderState => {
    if (s.filledQty > (fills.get(s.ref)?.qty ?? 0)) fills.set(s.ref, { qty: s.filledQty, avg: s.avgPrice });
    if (fills.size > 500) fills.delete(fills.keys().next().value!);
    return s;
  };

  /** a market as the account sees it, before any fresh price */
  const marketOf = (e: Entry): Market => {
    const perp = e.kind === "perp";
    const dexName = e.dex ? b.dexName(e.dex) : "";
    const label = perp ? (e.dex ? `${e.base} perpetual on ${dexName} (HIP-3, ${e.coin})` : `${e.base}/${e.quote} perpetual`) : `${e.base}/${e.quote} spot${e.token ? ` (${e.token})` : ""}`;
    const notes = [
      perp ? (e.dex ? `a HIP-3 perpetual that ${dexName} deployed on Hyperliquid, margined in ${e.quote} in that DEX's own perps balance` : `margined in ${e.quote} in the account's perps balance`) : `a sell sells only what the account holds${e.token ? `; ${e.token} is the token Hyperliquid trades as ${e.base}` : ""}`,
      "a market order is Hyperliquid's IOC limit at its worst price",
      perp ? `funding is paid or received every hour${e.isolatedOnly ? "; isolated margin only" : ""}` : "",
      "the smallest order is worth $10",
      "every order is held first to Hyperliquid's own line for where you are (its Terms of Use §1.6)",
    ].filter(Boolean);
    const priceStep = e.refPrice !== undefined ? hlPriceStep(e.refPrice, e.decimals) : undefined;
    // a HIP-3 pre-IPO perpetual, by Hyperliquid's own category for it and the company's name (live/preipo.ts: anyone may deploy one, so the
    // category alone never makes one): its company, the unit its price is in, the issuer's words
    const pre = perp && e.dex ? preIpoOf("hyperliquid", { category: b.categoryOf(e.coin) }, e.base, e.coin) : undefined;
    return {
      symbol: e.symbol,
      name: label,
      kind: perp ? "perp" : "spot",
      base: e.base,
      quote: e.quote,
      qtyStep: Number((10 ** -e.szDecimals).toFixed(e.szDecimals)),
      ...(priceStep !== undefined ? { priceStep } : {}),
      minNotional: MIN_USD,
      ...(perp ? { contractSize: 1 } : {}),
      open: !e.delisted,
      note: e.delisted ? "delisted: it takes no orders" : notes.join(" · "),
      types: ["market", "limit"],
      tifs: [...TIFS],
      tifsByType: { market: ["ioc"] },
      postOnly: true,
      ...(perp ? { reduceOnly: true } : { sellsReduce: true }),
      ...(perp && e.maxLeverage !== undefined ? { maxLeverage: e.maxLeverage } : {}),
      ...(perp ? { marginModes: (e.isolatedOnly ? ["isolated"] : ["cross", "isolated"]) as MarginMode[] } : {}),
      ...(pre ? { category: pre.category, group: pre.group, implied: pre.implied, ...(pre.issuer ? { issuer: pre.issuer, eligibility: pre.eligibility } : {}) } : {}),
    };
  };

  /** the start-from list: the busiest perpetuals, then the busiest spot markets — and the HIP-3 pre-IPO perpetuals after them, so that Markets
   * groups them with the other venues' (as exchange-trade.ts does) */
  const startFrom = (): Entry[] => {
    const offered = b.entries().filter((e) => e.offered);
    const few = [...offered.filter((e) => e.kind === "perp").slice(0, 12), ...offered.filter((e) => e.kind === "spot").slice(0, 8)];
    return [...few, ...offered.filter((e) => e.kind === "perp" && e.dex && !few.includes(e) && marketOf(e).category === PRE_IPO_CATEGORY)];
  };

  /** a day's figures from an asset context: the mid (the mark when there is none) — or the price read just now — the change since
   * prevDayPx, the dollars traded */
  const dayOf = (ctx: Dict, now?: number): MarketStats => {
    const price = now ?? pos(ctx.midPx) ?? pos(ctx.markPx);
    const prev = pos(ctx.prevDayPx);
    const vol = fin(ctx.dayNtlVlm);
    return {
      ...(price !== undefined ? { price } : {}),
      ...(price !== undefined && prev !== undefined ? { change24h: round(price - prev, 10), changePct24h: round(((price - prev) / prev) * 100, 4) } : {}),
      ...(vol !== undefined && vol >= 0 ? { volumeUsd24h: vol } : {}),
    };
  };

  /** the best bid and ask on Hyperliquid's book now (l2Book) */
  const bookOf = async (e: Entry): Promise<{ bid?: number | undefined; ask?: number | undefined }> => {
    const levels = arr(obj(await b.info({ type: "l2Book", coin: e.coin })).levels);
    return { bid: pos(obj(arr(levels[0])[0]).px), ask: pos(obj(arr(levels[1])[0]).px) };
  };

  /** Hyperliquid's own fills for one order (userFillsByTime from when it was placed): how much filled, at what average, and its fees in
   * dollars when every fee was paid in a dollar */
  const fillsOf = async (oid: string, sinceMs: number): Promise<{ qty: number; avg?: number | undefined; feeUsd?: number | undefined }> => {
    const rows = arr(await b.info({ type: "userFillsByTime", user: b.user, startTime: Math.max(0, Math.floor(sinceMs)) })).map(obj).filter((f) => str(f.oid) === oid);
    const qty = rows.reduce((s, f) => s + (fin(f.sz) ?? 0), 0);
    const notional = rows.reduce((s, f) => s + (fin(f.sz) ?? 0) * (fin(f.px) ?? 0), 0);
    const dollars = rows.every((f) => inDollars(String(f.feeToken ?? "")));
    const fee = rows.reduce((s, f) => s + (fin(f.fee) ?? 0), 0);
    return { qty: round(qty, 12), ...(qty > 0 ? { avg: round(notional / qty, 12) } : {}), ...(rows.length && dollars ? { feeUsd: round(fee, 10) } : {}) };
  };

  /** an order as Hyperliquid's orderStatus shows it, in the account's words: what filled decides, its status word only where nothing says
   * otherwise. `found` is the answer's `order` */
  const stateOf = async (found: Dict, e: Entry | undefined): Promise<OrderState> => {
    const o = obj(found.order);
    const word = str(found.status) ?? "";
    const oid = str(o.oid) ?? "";
    const orig = fin(o.origSz) ?? 0;
    const left = fin(o.sz) ?? 0;
    const filled = Math.max(0, round(orig - left, 12));
    let status: OrderStatus;
    // filled is filled whole; one that says filled with some of it left (an IOC's rest) filled what it filled, and the rest is gone
    if (word === "filled") status = left > 0 ? "canceled" : "filled";
    else if (word === "open" || word === "triggered") status = filled > 0 ? "partial" : "open";
    else if (word === "canceled" || word.endsWith("Canceled") || word === "scheduledCancel") status = "canceled";
    else if (word === "rejected" || word.endsWith("Rejected")) status = "rejected";
    else status = filled > 0 ? "partial" : "pending";
    const native = { oid, status: word, coin: str(o.coin) ?? e?.coin ?? null, side: str(o.side) ?? null, limitPx: str(o.limitPx) ?? null, sz: str(o.sz) ?? null, origSz: str(o.origSz) ?? null, tif: str(o.tif) ?? null, reduceOnly: o.reduceOnly ?? null, orderType: str(o.orderType) ?? null, cloid: str(o.cloid) ?? null, statusTimestamp: found.statusTimestamp ?? null };
    let avg: number | undefined;
    let feeUsd: number | undefined;
    if (filled > 0) {
      try {
        const f = await fillsOf(oid, (fin(o.timestamp) ?? c.clock() - 86_400_000) - 1_000);
        avg = f.avg;
        feeUsd = f.feeUsd;
      } catch {
        // the fills could not be read now: the next look reads them
      }
    }
    return heard({ ref: oid, status, filledQty: filled, ...(avg !== undefined ? { avgPrice: avg } : {}), ...(feeUsd !== undefined ? { feeUsd } : {}), native });
  };

  /** orderStatus by the oid, or by the account's cloid; `null`: Hyperliquid has no such order for this account */
  const lookup = async (oid: string | number): Promise<Dict | null> => {
    try {
      const r = obj(await b.info({ type: "orderStatus", user: b.user, oid }));
      return r.status === "order" ? obj(r.order) : null;
    } catch (err) {
      if ((err as Refusal).code === "E_ACCOUNT_ORDER_UNKNOWN") return null;
      throw err;
    }
  };

  const status = async (ref: string, symbol: string): Promise<OrderState | Refusal> => {
    if (!/^\d{1,20}$/.test(ref)) return no("E_ACCOUNT_ORDER_UNKNOWN", { venue, message: `${ref} is not an order id ${name} gave`, detail: { order: ref } });
    const f = await b.find(symbol);
    try {
      const found = await lookup(Number(ref));
      if (!found) return no("E_ACCOUNT_ORDER_UNKNOWN", { venue, message: `${name} has no order ${ref} for this account`, detail: { order: ref } });
      return await stateOf(found, isRefusal(f) ? undefined : f);
    } catch (err) {
      return b.fail(err, ref);
    }
  };

  const trader: LiveTrader & { held(o: { side: "buy" | "sell"; reduceOnly?: boolean | undefined }): Promise<Refusal | undefined> } = {
    /** Hyperliquid's own line for where the user is now, asked before the owner is quoted or an agent's card is raised (account/live-orders.ts):
     * nothing is signed or sent for it */
    held: (o) => heldTo(HYPERLIQUID_RULE, c.where, venue, `${o.side}${o.reduceOnly ? " to close" : ""}`, { fresh: true }),
    get can() {
      return live();
    },
    get whyNot() {
      return live() ? undefined : `${name}'s approval of this API wallet ended on ${iso(c.validUntil!)}: approve a new one at ${HL_API_PAGE} and connect again`;
    },
    what: "spot and perpetuals",
    kinds: ["spot", "perp"],

    async markets(query) {
      const failed = await b.load();
      if (failed) return failed;
      const q = query.trim();
      if (!q) return startFrom().map(marketOf);
      // Hyperliquid's own name for a market finds it too (xyz:NVDA, @107, BTC-PERP)
      const own = await b.find(q);
      const offered = b.entries().filter((e) => e.offered);
      const few = pick(offered.map(marketOf), q);
      return !isRefusal(own) && own.offered && !few.some((m) => m.symbol === own.symbol) ? [marketOf(own), ...few].slice(0, 20) : few;
    },

    async market(symbol) {
      const e = await b.find(symbol);
      if (isRefusal(e)) return e;
      const m = marketOf(e);
      let top: { bid?: number | undefined; ask?: number | undefined };
      let ctx: Dict;
      try {
        const [bk, ctxs] = await Promise.all([bookOf(e), b.ctxOf(b.groupOf(e))]);
        top = bk;
        ctx = ctxs.get(e.coin.toUpperCase()) ?? {};
      } catch (err) {
        return b.fail(err);
      }
      const mid = top.bid !== undefined && top.ask !== undefined ? round((top.bid + top.ask) / 2, 12) : undefined;
      const day = dayOf(ctx, mid);
      const price = day.price;
      const funding = e.kind === "perp" ? fin(ctx.funding) : undefined;
      return {
        ...m,
        ...(price !== undefined ? { price, priceStep: hlPriceStep(price, e.decimals) } : {}),
        ...(top.bid !== undefined ? { bid: top.bid } : {}),
        ...(top.ask !== undefined ? { ask: top.ask } : {}),
        ...(day.changePct24h !== undefined ? { changePct24h: day.changePct24h, change24h: day.change24h } : {}),
        ...(day.volumeUsd24h !== undefined ? { volumeUsd24h: day.volumeUsd24h } : {}),
        ...(funding !== undefined ? { fundingRate: funding, nextFundingAt: nextHour(c.clock()) } : {}),
        // a pre-IPO perpetual: the valuation the price implies now, in the venue's unit
        ...(m.implied && price !== undefined ? { implied: { ...m.implied, usd: impliedUsd(price, m.implied.perPoint) } } : {}),
      };
    },

    async place(o: OrderRequest) {
      const e = await b.find(o.symbol);
      if (isRefusal(e)) return e;
      const m = marketOf(e);
      if (!m.open) return no("E_VENUE_MARKET_CLOSED", { venue, message: `${name} takes no orders in ${e.symbol}: it is delisted` });
      if (o.type !== "market" && o.type !== "limit") return badOrder(venue, name, `it takes market and limit orders through the account, not ${String(o.type).replace("_", "-")} orders: Hyperliquid's trigger orders are not offered here yet`);
      if (!(Number.isFinite(o.qty) && o.qty > 0)) return badOrder(venue, name, "a size is more than zero");
      if (!onStep(o.qty, m.qtyStep)) return badOrder(venue, name, `a size in ${m.name} moves in steps of ${plain(m.qtyStep ?? 1)} (its szDecimals is ${e.szDecimals})`, { qty: o.qty, qtyStep: m.qtyStep });
      if (o.stopPrice !== undefined) return badOrder(venue, name, "a stop price belongs to a stop order, which is not offered here");
      if (o.type === "limit" ? !(o.limitPrice !== undefined && o.limitPrice > 0) : o.limitPrice !== undefined) return badOrder(venue, name, o.type === "limit" ? "a limit order has a limit price" : "a market order has no limit price");
      if (o.worstPrice !== undefined && !(o.type === "market" && o.worstPrice > 0)) return badOrder(venue, name, "a worst price belongs to a market order, and is more than zero");
      if (o.postOnly && o.type !== "limit") return badOrder(venue, name, "post-only is for a limit order: it rests on the book as a maker (Hyperliquid's Alo), or is canceled");
      if (o.postOnly && o.tif === "ioc") return badOrder(venue, name, "a post-only order rests on the book: it takes no ioc");
      if (o.reduceOnly && !m.reduceOnly) return badOrder(venue, name, `a reduce-only order is for a perpetual: ${m.name} is spot, where a sell sells only what is held`);
      if (o.tif !== undefined && !(o.tif === "gtc" || o.tif === "ioc")) return badOrder(venue, name, `it takes gtc and ioc, not ${o.tif}: Hyperliquid has no fill-or-kill and no day order`);
      if (o.type === "market" && o.tif === "gtc") return badOrder(venue, name, "a market order fills at once: it does not wait until canceled");

      // the price the order goes with: a limit order's own, exactly as Hyperliquid takes it; a market order's worst price, moved inside onto
      // Hyperliquid's grid — it is an IOC limit there, as Hyperliquid's own market orders are
      let px: number;
      let sentAs: string | undefined;
      if (o.type === "limit") {
        px = o.limitPrice!;
        if (!hlPriceOk(px, e.decimals)) return badOrder(venue, name, `a price in ${m.name} has at most five significant figures and ${e.decimals} decimal${e.decimals === 1 ? "" : "s"} (a whole number always passes): ${plain(px)} is not one`, { limitPrice: px, priceStep: hlPriceStep(px, e.decimals) });
      } else {
        let worst = o.worstPrice;
        if (worst === undefined) {
          let ref: number | undefined;
          try {
            const top = await bookOf(e);
            ref = o.side === "buy" ? top.ask : top.bid;
          } catch (err) {
            return b.fail(err);
          }
          if (ref === undefined) return badOrder(venue, name, `${name} shows no ${o.side === "buy" ? "ask" : "bid"} in ${m.name} now: a limit order can be placed instead`);
          worst = o.side === "buy" ? ref * (1 + ROOM) : ref * (1 - ROOM);
        }
        px = hlPriceInside(worst, e.decimals, o.side === "buy" ? "down" : "up");
        if (!(px > 0)) return badOrder(venue, name, `a worst price of ${plain(worst)} is under the smallest price ${m.name} takes`);
        sentAs = `a limit order at ${plain(px)} that fills at once (IOC), the rest canceled: a market order kept inside its worst price, as Hyperliquid's own market orders are`;
      }
      // exactly as the library will send it: an order is never rounded on its way out
      let sentPx: string;
      let sentSz: string;
      try {
        sentPx = client.priceToPrecision(e.symbol, px);
        sentSz = client.amountToPrecision(e.symbol, o.qty);
      } catch (err) {
        return b.fail(err);
      }
      if (Math.abs(Number(sentPx) - px) > Math.max(1e-12, px * 1e-12)) return badOrder(venue, name, `${plain(px)} would go to ${name} as ${sentPx}: the account sends no price other than the one asked`, { price: px, wouldSend: sentPx });
      if (Math.abs(Number(sentSz) - o.qty) > Math.max(1e-12, o.qty * 1e-12)) return badOrder(venue, name, `a size of ${plain(o.qty)} would go to ${name} as ${sentSz}`, { qty: o.qty, wouldSend: sentSz });
      // Hyperliquid's smallest order; a reduce-only order closing what is held is Hyperliquid's to judge
      if (!o.reduceOnly && o.qty * px < MIN_USD - 1e-9) return badOrder(venue, name, `the smallest order ${name} takes is worth $${MIN_USD} (“Order must have minimum value of $10”): ${plain(o.qty)} at ${plain(px)} is $${(o.qty * px).toFixed(2)}`, { minNotional: MIN_USD });

      // Hyperliquid's own line for this user, where they are now — asked again for a write, not taken from minutes ago on another network:
      // before anything is signed
      const doing = `${o.side} ${plain(o.qty)} ${e.symbol}`;
      const line = await heldTo(HYPERLIQUID_RULE, c.where, venue, doing, { fresh: true });
      if (line) return line;

      const cloid = cloidOf(o.clientId);
      const ioc = o.type === "market" || o.tif === "ioc";
      const params: Dict = { clientOrderId: cloid, ...(ioc ? { timeInForce: "Ioc" } : {}), ...(o.postOnly ? { postOnly: true } : {}), ...(o.reduceOnly ? { reduceOnly: true } : {}) };
      let created: Dict;
      try {
        created = obj(await client.createOrder(e.symbol, "limit", o.side, o.qty, px, params));
      } catch (err) {
        const r = b.fail(err);
        const kind = String((err as { name?: unknown })?.name ?? "");
        if (r.code !== "E_VENUE_UNREACHABLE" || !UNSURE.has(kind)) return r;
        // the order call did not come back: whether it reached Hyperliquid is asked by the account's own id before anything else is said
        let found: Dict | null | undefined;
        try {
          found = await lookup(cloid);
        } catch {
          found = undefined;
        }
        if (found) {
          const s = await stateOf(found, e);
          return { ...s, native: { ...(s.native as Dict), cloid, foundBy: "the account's id, after the order call did not come back" } };
        }
        return no("E_VENUE_UNREACHABLE", { venue, message: found === null ? `${name} did not confirm the order, and shows none under the account's id ${cloid} now: look at its open orders before placing it again` : `${name} did not confirm the order: it may or may not have been placed. Look at its open orders before placing it again (the account's id for it: ${cloid})`, detail: { clientOrderId: cloid }, native: r.native });
      }
      const answer = obj(created.info);
      const resting = obj(answer.resting);
      const filled = obj(answer.filled);
      const oid = str(resting.oid) ?? str(filled.oid);
      const native = { asset: e.asset, cloid, answer, ...(sentAs ? { sentAs } : {}) };
      if (!oid) return no("E_VENUE_REJECTED", { venue, message: `${name} answered the order without an order id: look at its open orders before placing it again (the account's id for it: ${cloid})`, detail: { clientOrderId: cloid }, native });
      if (filled.oid !== undefined) {
        // filled at once: all of it, or — an IOC — what the book held, the rest canceled at once
        const got = fin(filled.totalSz) ?? 0;
        const whole = got >= o.qty - 1e-12;
        const s: OrderState = { ref: oid, status: whole ? "filled" : ioc ? "canceled" : "partial", filledQty: got, ...(pos(filled.avgPx) !== undefined ? { avgPrice: pos(filled.avgPx) } : {}), native };
        try {
          const f = await fillsOf(oid, c.clock() - 10 * 60_000);
          if (f.feeUsd !== undefined) s.feeUsd = f.feeUsd;
        } catch {
          // the fee is read on the next look
        }
        return heard(s);
      }
      // resting: what became of it on its way to the book (a limit order may have filled in part)
      try {
        const found = await lookup(Number(oid));
        if (found) {
          const s = await stateOf(found, e);
          return { ...s, native: { ...(s.native as Dict), ...native } };
        }
      } catch {
        // read on the next look
      }
      return { ref: oid, status: "open", filledQty: 0, native };
    },

    async cancel(ref, symbol) {
      if (!/^\d{1,20}$/.test(ref)) return no("E_ACCOUNT_ORDER_UNKNOWN", { venue, message: `${ref} is not an order id ${name} gave`, detail: { order: ref } });
      const e = await b.find(symbol);
      if (isRefusal(e)) return e;
      /** what Hyperliquid shows of the order now, when it is done (filled, canceled): the answer, whatever the cancel's was */
      const done = async (): Promise<OrderState | undefined> => {
        try {
          const found = await lookup(Number(ref));
          const s = found ? await stateOf(found, e) : undefined;
          return s && DONE.has(s.status) ? s : undefined;
        } catch {
          return undefined;
        }
      };
      // the cancel's answer lost (no answer, or a page in its place): it may have reached Hyperliquid, and is never told as refused
      const unconfirmed = (native: unknown): Refusal => no("E_VENUE_UNREACHABLE", { venue, message: `${name} did not answer whether it took the cancel of order ${ref}: it may have. Look at its open orders before asking again`, detail: { order: ref, unsure: true }, native });
      let answer: unknown;
      try {
        answer = await client.cancelOrder(ref, e.symbol);
      } catch (err) {
        const r = b.fail(err, ref);
        if (r.code === "E_VENUE_UNREACHABLE" && UNSURE.has(String((err as { name?: unknown })?.name ?? ""))) return (await done()) ?? unconfirmed(r.native);
        if (r.code !== "E_ACCOUNT_ORDER_UNKNOWN") return r;
        // filled already, canceled already, or never placed: what Hyperliquid shows now is the answer
        return (await done()) ?? r;
      }
      // Hyperliquid's own "success" for it, or the cancel is not confirmed
      if (obj(answer).info !== "success") return (await done()) ?? unconfirmed({ cancel: str(obj(answer).info) ?? null });
      // canceled: the order as it stands now, with whatever had filled
      try {
        const found = await lookup(Number(ref));
        if (found) return await stateOf(found, e);
      } catch {
        // read on the next look
      }
      // taken, and not read back (a rate limit, a network change between the two): what was last heard to have filled, said as not read now
      const had = fills.get(ref);
      return { ref, status: had ? "partial" : "pending", filledQty: had?.qty ?? 0, ...(had?.avg !== undefined ? { avgPrice: had.avg } : {}), native: { cancel: "success", unread: true } };
    },

    status,

    async positions() {
      const failed = await b.load();
      if (failed) return failed;
      const groups = ["", ...new Set(b.entries().filter((e) => e.kind === "perp" && e.dex && e.offered).map((e) => e.dex))];
      let states: unknown[];
      try {
        states = await Promise.all(groups.map((dex) => b.info({ type: "clearinghouseState", user: b.user, ...(dex ? { dex } : {}) })));
      } catch (err) {
        return b.fail(err);
      }
      const out: Position[] = [];
      for (const st of states) {
        for (const ap of arr(obj(st).assetPositions)) {
          const p = obj(obj(ap).position);
          const e = b.byCoin(String(p.coin ?? ""));
          if (!e || e.kind !== "perp" || !e.offered) continue;
          const szi = fin(p.szi) ?? 0;
          const qty = Math.abs(szi);
          if (!(qty > 0)) continue;
          const value = Math.abs(fin(p.positionValue) ?? NaN);
          const lev = obj(p.leverage);
          const mode = lev.type === "cross" || lev.type === "isolated" ? lev.type : undefined;
          out.push({
            symbol: e.symbol,
            name: marketOf(e).name,
            kind: "perp",
            side: szi < 0 ? "short" : "long",
            qty,
            entryPrice: pos(p.entryPx),
            markPrice: Number.isFinite(value) ? round(value / qty, 10) : undefined,
            usd: Number.isFinite(value) ? value : undefined,
            unrealizedUsd: fin(p.unrealizedPnl),
            leverage: pos(lev.value),
            marginMode: mode,
            liquidationPrice: pos(p.liquidationPx),
            native: { coin: p.coin ?? null, szi: p.szi ?? null, entryPx: p.entryPx ?? null, positionValue: p.positionValue ?? null, unrealizedPnl: p.unrealizedPnl ?? null, returnOnEquity: p.returnOnEquity ?? null, liquidationPx: p.liquidationPx ?? null, marginUsed: p.marginUsed ?? null, leverage: p.leverage ?? null, maxLeverage: p.maxLeverage ?? null, cumFunding: p.cumFunding ?? null },
          });
        }
      }
      return out;
    },

    async setLeverage(symbol, leverage, marginMode) {
      const e = await b.find(symbol);
      if (isRefusal(e)) return e;
      if (e.kind !== "perp") return badOrder(venue, name, `leverage is set on a perpetual; ${e.symbol} is spot`);
      if (!(Number.isInteger(leverage) && leverage >= 1)) return badOrder(venue, name, "leverage is a whole number, 1 or more");
      if (e.maxLeverage !== undefined && leverage > e.maxLeverage) return badOrder(venue, name, `it takes at most ${e.maxLeverage}x in ${e.symbol}`, { maxLeverage: e.maxLeverage });
      if (marginMode === "cross" && e.isolatedOnly) return badOrder(venue, name, `${e.symbol} takes isolated margin only (Hyperliquid's marginMode for it is strictIsolated or noCross)`);
      // with no margin mode asked, the one the account uses there now stays (activeAssetData), else cross where the market takes it
      let mode = marginMode;
      if (!mode) {
        try {
          const now = obj(obj(await b.info({ type: "activeAssetData", user: b.user, coin: e.coin })).leverage).type;
          mode = now === "cross" || now === "isolated" ? now : undefined;
        } catch {
          mode = undefined;
        }
        mode ??= e.isolatedOnly ? "isolated" : "cross";
        if (mode === "cross" && e.isolatedOnly) mode = "isolated";
      }
      // Hyperliquid's own line for this user, where they are now — asked again for a write: before anything is signed
      const doing = `set ${e.symbol} to ${leverage}x ${mode}`;
      const line = await heldTo(HYPERLIQUID_RULE, c.where, venue, doing, { fresh: true });
      if (line) return line;
      const unconfirmed = (native: unknown): Refusal => no("E_VENUE_UNREACHABLE", { venue, message: `${name} did not answer whether it took the leverage change (${doing}): it may have. Look at it there before asking again`, detail: { unsure: true }, native });
      let answer: Dict;
      try {
        answer = obj(await client.setLeverage(leverage, e.symbol, { marginMode: mode }));
      } catch (err) {
        const r = b.fail(err);
        return r.code === "E_VENUE_UNREACHABLE" && UNSURE.has(String((err as { name?: unknown })?.name ?? "")) ? unconfirmed(r.native) : r;
      }
      // Hyperliquid's own fields only (never a page's body, which may name this machine's address): its "ok", or the change is not confirmed
      const said = { status: str(answer.status) ?? null, type: str(obj(answer.response).type) ?? null };
      if (answer.status !== "ok") return unconfirmed({ answer: said });
      return { leverage, marginMode: mode, native: { action: { type: "updateLeverage", asset: e.asset, isCross: mode === "cross", leverage }, answer: said } };
    },

    async stats(symbols) {
      const failed = await b.load();
      if (failed) return failed;
      if (symbols && symbols.length > STATS_MAX) return no("E_VENUE_REJECTED", { venue, message: `${name}: at most ${STATS_MAX} markets are read at once, not ${symbols.length}`, detail: { max: STATS_MAX } });
      const wanted = symbols ? [...new Set(symbols.map((s) => b.bySymbol(s) ?? b.byCoin(s)).filter((e): e is Entry => e !== undefined && e.offered))] : startFrom();
      const out = new Map<string, MarketStats>();
      let refused: Refusal | undefined;
      for (const group of [...new Set(wanted.map(b.groupOf))]) {
        let ctxs: Map<string, Dict>;
        try {
          ctxs = await b.ctxOf(group);
        } catch (err) {
          refused ??= b.fail(err);
          continue;
        }
        for (const e of wanted.filter((x) => b.groupOf(x) === group)) {
          const ctx = ctxs.get(e.coin.toUpperCase());
          if (ctx) out.set(e.symbol, dayOf(ctx));
        }
      }
      return !out.size && refused ? refused : out;
    },

    async candles(symbol, interval, sinceMs) {
      if (!CANDLE_INTERVALS.includes(interval)) return no("E_VENUE_REJECTED", { venue, message: `${name}: price history comes in bars of 5m, 1h and 1d, not ${String(interval)}` });
      if (!(Number.isFinite(sinceMs) && sinceMs >= 0)) return no("E_VENUE_REJECTED", { venue, message: `${name}: a price history starts at a time, in milliseconds` });
      const e = await b.find(symbol);
      if (isRefusal(e)) return e;
      const now = c.clock();
      const from = Math.max(Math.floor(sinceMs), now - BARS * BAR_MS[interval]);
      let rows: unknown[];
      try {
        rows = arr(await b.info({ type: "candleSnapshot", req: { coin: e.coin, interval, startTime: from, endTime: now } }));
      } catch (err) {
        return b.fail(err);
      }
      const bars = new Map<number, Candle>();
      for (const r of rows.map(obj)) {
        const [t, o, h, l, cl, v] = [fin(r.t), pos(r.o), pos(r.h), pos(r.l), pos(r.c), fin(r.v)];
        if (t === undefined || t < from || o === undefined || h === undefined || l === undefined || cl === undefined) continue;
        bars.set(t, { t, o, h, l, c: cl, ...(v !== undefined && v >= 0 ? { v } : {}) });
      }
      return [...bars.values()].sort((a, z) => a.t - z.t).slice(-BARS);
    },
  };
  return trader;
}
