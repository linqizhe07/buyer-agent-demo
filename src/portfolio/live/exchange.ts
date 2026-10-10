/** An exchange account, read through the unified exchange library (ccxt): any exchange the library covers, with an API key from a key file.
 *
 * Three calls are made when it is connected, in this order:
 *   1. the exchange's public clock — no key involved. If the exchange does not serve this location, or cannot be reached, this is where
 *      that is learned, before the key is shown to anyone. An exchange the library has no clock call for (Kraken Futures, Phemex: its base
 *      class answers NotSupported) skips this step, and the key's permissions or the balances meet the exchange's rule instead;
 *   2. what the key may do, where the exchange has a call that says (Binance: GET /sapi/v1/account/apiRestrictions; OKX, its US and EEA
 *      hosts too: GET /api/v5/account/config; Bybit: GET /v5/user/query-api; Coinbase: GET /api/v3/brokerage/key_permissions; KuCoin: GET
 *      /api/v1/user/api-key). Elsewhere the library has no such call, and the connection says so instead of guessing. Binance.US documents
 *      no such call, so it is not asked. A call that fails leaves what the key may do unknown, and the connection goes on — unless the
 *      exchange refused the key itself or the place, which the balances would meet too;
 *   3. the balances.
 * After that only the balances (and the prices of what is held) are read again. Orders are placed through exchange-trade.ts, and only
 * behind the account's door.
 *
 * The library is loaded on first use, so a run that plugs in no exchange never loads it.
 */
import { STATUS_CODES } from "node:http";
import type { Refusal } from "../../core/errors.ts";
import { no } from "../refuse.ts";
import type { KeyFile, KeyShape } from "./credentials.ts";
import { exchangeTrader } from "./exchange-trade.ts";
import { bannedNo, bannedUntil, edgeRefused, edgeWords, IP_LIST, ipListWords, isStable, notTheApiWords, num, rateLimitedNo, redact, REGION, retryAfterMs, transportCode, unreachable, type LiveBalance, type LiveProbe, type LiveSource } from "./types.ts";
import { exchangeWriter } from "./writes.ts";

/** the part of a ccxt exchange this file uses; the tests hand in a stand-in with the same shape */
export interface ExchangeClient {
  id: string;
  name?: string | undefined;
  requiredCredentials?: Record<string, boolean> | undefined;
  /** when the library last sent a request (0 before the first): tells a market list it built in from one the exchange answered */
  lastRestRequestTimestamp?: number | undefined;
  markets?: Record<string, unknown> | undefined;
  loadMarkets?(reload?: boolean): Promise<unknown>;
  fetchTime?(): Promise<unknown>;
  fetchBalance(params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** `params`: the kind of market where the exchange lists its tickers by kind (`{ type: "swap" }`); the trader also reads a ticker's last
   * 24 hours (percentage, change, quoteVolume, high, low) */
  fetchTickers?(symbols?: string[], params?: Record<string, unknown>): Promise<Record<string, { last?: number | undefined; close?: number | undefined; [field: string]: unknown }>>;
  /** Binance: GET /sapi/v1/account/apiRestrictions */
  sapiGetAccountApiRestrictions?(): Promise<Record<string, unknown>>;
  /** OKX: GET /api/v5/account/config */
  privateGetAccountConfig?(): Promise<{ data?: Array<Record<string, unknown>> }>;
  /** Bybit: GET /v5/user/query-api */
  privateGetV5UserQueryApi?(): Promise<unknown>;
  /** Coinbase Advanced Trade: GET /api/v3/brokerage/key_permissions */
  v3PrivateGetBrokerageKeyPermissions?(): Promise<unknown>;
  /** KuCoin: GET /api/v1/user/api-key */
  privateGetUserApiKey?(): Promise<unknown>;
  // what moves money — used only by writes.ts, and only behind the account's door
  has?: Record<string, unknown> | undefined;
  currencies?: Record<string, { networks?: Record<string, unknown> | undefined } | undefined> | undefined;
  fetchDepositAddress?(code: string, params?: Record<string, unknown>): Promise<unknown>;
  /** some exchanges give no deposit address until one is made (Kraken, KuCoin, Coinbase): live/writes.ts calls this first, then fetches again */
  createDepositAddress?(code: string, params?: Record<string, unknown>): Promise<unknown>;
  withdraw?(code: string, amount: number, address: string, tag?: string, params?: Record<string, unknown>): Promise<unknown>;
  fetchWithdrawals?(code?: string, since?: number): Promise<unknown[]>;
  transfer?(code: string, amount: number, fromAccount: string, toAccount: string): Promise<unknown>;
  createOrder?(symbol: string, type: string, side: string, amount: number, price?: number, params?: Record<string, unknown>): Promise<unknown>;
  createMarketBuyOrderWithCost?(symbol: string, cost: number): Promise<unknown>;
  // what places, cancels and tracks orders — used only by exchange-trade.ts, and only behind the account's door
  /** how `markets[…].precision` counts: 2 decimal places, 3 significant digits, 4 a step (TICK_SIZE) */
  precisionMode?: number | undefined;
  options?: Record<string, unknown> | undefined;
  /** what the library says each kind of market takes (`features.spot.createOrder.timeInForce.IOC`, `marketBuyRequiresPrice`…) */
  features?: Record<string, unknown> | undefined;
  amountToPrecision?(symbol: string, amount: number): string;
  priceToPrecision?(symbol: string, price: number): string;
  fetchTicker?(symbol: string, params?: Record<string, unknown>): Promise<unknown>;
  cancelOrder?(id: string, symbol?: string, params?: Record<string, unknown>): Promise<unknown>;
  fetchOrder?(id: string | undefined, symbol?: string, params?: Record<string, unknown>): Promise<unknown>;
  fetchOpenOrder?(id: string, symbol?: string, params?: Record<string, unknown>): Promise<unknown>;
  fetchOpenOrders?(symbol?: string, since?: number, limit?: number, params?: Record<string, unknown>): Promise<unknown[]>;
  fetchClosedOrders?(symbol?: string, since?: number, limit?: number, params?: Record<string, unknown>): Promise<unknown[]>;
  fetchCanceledAndClosedOrders?(symbol?: string, since?: number, limit?: number, params?: Record<string, unknown>): Promise<unknown[]>;
  fetchOrders?(symbol?: string, since?: number, limit?: number, params?: Record<string, unknown>): Promise<unknown[]>;
  /** Bybit: whether the account is unified, which decides how a spot market buy is sized; the library caches the answer */
  isUnifiedEnabled?(): Promise<unknown>;
  // what reads the market for the account (no key needed by the exchange) — used only by exchange-trade.ts
  /** the bar sizes the library knows for this exchange, by its own names ("5m", "1h", "1d") */
  timeframes?: Record<string, unknown> | undefined;
  /** bars as [start ms, open, high, low, close, volume], oldest first */
  fetchOHLCV?(symbol: string, timeframe?: string, since?: number, limit?: number, params?: Record<string, unknown>): Promise<unknown[]>;
  /** a perpetual's funding: `fundingRate` and `fundingTimestamp`, when it is paid */
  fetchFundingRate?(symbol: string, params?: Record<string, unknown>): Promise<unknown>;
}

/** The exchange's market list, loaded through the library — and a load that failed let go of: the library keeps a failed load's promise and
 * hands it to every later call, so one blip (a network change, a filtering page) would refuse every read and write until a restart */
export async function loadList(client: ExchangeClient, reload?: boolean): Promise<void> {
  try {
    await client.loadMarkets?.(reload);
  } catch (err) {
    const kept = client as { marketsLoading?: unknown; reloadingMarkets?: boolean };
    if ("marketsLoading" in kept) {
      kept.marketsLoading = undefined;
      kept.reloadingMarkets = false;
    }
    throw err;
  }
}

/** the library's ids for one exchange on several hosts (ccxt.md §0): OKX is also okxus and myokx (EEA) */
export function isOkx(id: string): boolean {
  return id.startsWith("okx") || id === "myokx";
}
export function isBinance(id: string): boolean {
  return id.startsWith("binance");
}
export function isBybit(id: string): boolean {
  return id.startsWith("bybit");
}

/** `undefined`: the library knows no exchange by that id */
export type OpenExchange = (exchangeId: string, key: KeyFile) => Promise<ExchangeClient | undefined>;

export const EXCHANGE_KEY: KeyShape = { required: ["apiKey", "secret"], optional: ["password", "uid"], example: '{"apiKey": "…", "secret": "…"} (OKX, KuCoin and Bitget also need "password": the API passphrase)' };

type Ccxt = { exchanges: string[] } & Record<string, new (config: Record<string, unknown>) => ExchangeClient>;
let library: Promise<Ccxt> | undefined;
const ccxt = (): Promise<Ccxt> => (library ??= import("ccxt").then((m) => (m as unknown as { default: Ccxt }).default));

export const openExchange: OpenExchange = async (exchangeId, key) => {
  const lib = await ccxt();
  if (!lib.exchanges.includes(exchangeId)) return undefined;
  return guardClient(new lib[exchangeId]!({ apiKey: key.apiKey, secret: key.secret, ...(key.password ? { password: key.password } : {}), ...(key.uid ? { uid: key.uid } : {}), enableRateLimit: true, timeout: 12_000 }), lib as unknown as ErrorClasses);
};

type ErrorClasses = Record<"RequestTimeout" | "BadResponse", new (message: string) => Error>;
type Guarded = ExchangeClient & {
  timeout?: number;
  fetch(url: string, method?: string, headers?: unknown, body?: unknown): Promise<unknown>;
  handleErrors(code: number, reason: string, url: string, method: string, headers: Record<string, unknown> | undefined, body: string, response: unknown, requestHeaders?: unknown, requestBody?: unknown): unknown;
  handleHttpStatusCode(code: number, reason: string, url: string, method: string, body: string): void;
};

/** What the library is made to hear before it answers for an exchange, on every client this file opens:
 *   · a deadline on the whole request, the body included: a connection cut after the headers otherwise never settles (the library's own
 *     timeout stops at the headers), and a market load caught that way hands the same stuck promise to every later call;
 *   · the HTTP status, read first, for any answer that is not JSON: some exchanges' own handlers (Crypto.com's) throw a bare "error" with
 *     the body and no status, and an edge's 403 page, a 451 or a gateway's 5xx then read as the exchange refusing the request;
 *   · a 2xx answer that is a page where the API answers JSON (a filtering network's block page, a captive portal, a challenge): not the
 *     exchange's answer — the library would parse nothing from it and carry on as if the exchange had said "nothing";
 *   · the wait an exchange asked for on a 429 or a 418 (Retry-After), carried on what is thrown, so the hold is the exchange's own */
export function guardClient<T extends ExchangeClient>(client: T, lib: ErrorClasses): T {
  const x = client as unknown as Guarded;
  if (typeof x.fetch === "function") {
    const fetch = x.fetch.bind(x);
    x.fetch = (url, method = "GET", headers, body) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = Number(x.timeout) || 12_000;
      const ms = timeout + Math.min(2_000, timeout);
      const deadline = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new lib.RequestTimeout(`${x.id} ${method} ${url} request timed out (${ms} ms, the answer included)`)), ms)));
      return Promise.race([fetch(url, method, headers, body), deadline]).finally(() => clearTimeout(timer));
    };
  }
  if (typeof x.handleErrors === "function" && typeof x.handleHttpStatusCode === "function") {
    const own = x.handleErrors.bind(x);
    const status = x.handleHttpStatusCode.bind(x);
    x.handleErrors = (code, reason, url, method, headers, body, response, requestHeaders, requestBody) => {
      try {
        if (response === undefined || response === null || typeof response !== "object") {
          if (code >= 400) status(code, reason, url, method, body);
          else if (code >= 200 && code < 300 && code !== 204 && /^\s*</.test(String(body ?? ""))) throw new lib.BadResponse(`${x.id} ${method} ${url} ${code} ${reason} ${String(body ?? "").slice(0, 600)}`);
        }
        const skip = own(code, reason, url, method, headers, body, response, requestHeaders, requestBody);
        if (skip === undefined && code >= 400) status(code, reason, url, method, body);
        return skip;
      } catch (err) {
        const wait = (code === 429 || code === 418) && headers ? retryAfterMs(String(headers["Retry-After"] ?? headers["retry-after"] ?? "")) : undefined;
        if (wait && err && typeof err === "object") (err as { retryAfterMs?: number }).retryAfterMs = wait;
        throw err;
      }
    };
  }
  return client;
}

/** every exchange the library covers, by id and by the name it gives itself; the well-known ones first — the futures venues that list
 * pre-IPO perpetuals (live/preipo.ts) beside their spot siblings: krakenfutures, kucoinfutures, deribit, phemex */
const FIRST = ["binance", "okx", "bybit", "kraken", "krakenfutures", "coinbase", "kucoin", "kucoinfutures", "gate", "bitget", "mexc", "deribit", "phemex", "htx", "cryptocom", "bitfinex", "gemini", "bitstamp", "binanceus", "upbit"];
let listed: Promise<Array<{ id: string; name: string; needs: string[] }>> | undefined;
export function exchangeList(): Promise<Array<{ id: string; name: string; needs: string[] }>> {
  return (listed ??= ccxt().then((lib) => {
    const rank = (id: string) => (FIRST.includes(id) ? FIRST.indexOf(id) : FIRST.length);
    return [...lib.exchanges]
      .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
      .flatMap((id) => {
        try {
          const x = new lib[id]!({});
          const needs = Object.entries(x.requiredCredentials ?? {}).filter(([, on]) => on).map(([k]) => k);
          // an exchange that is reached with a wallet key rather than an API key is not this connector's
          return needs.includes("privateKey") || needs.includes("walletAddress") ? [] : [{ id, name: x.name ?? id, needs }];
        } catch {
          return [];
        }
      });
  }));
}

/** a failure the library threw, as one of the account's refusals; the exchange's own words go with it, without the key */
/** OKX answers some refusals with HTTP 200 and a code the library does not map (docs-v5, error codes): the code says what it was */
const OKX_REGION = /"(50121|50051)"/;
const OKX_PERMISSION = /"(50120|50110)"/;
const OKX_KEY = /"(50111|50113|50105|50119)"/;
/** Binance's -2015 is one code for a wrong key, a missing permission and an IP not on the key's list: it cannot be told apart */
const BINANCE_2015 = /-2015|Invalid API-key, IP, or permissions/;
/** A place rule about one pair, token, product or feature, not the whole exchange (ccxt's RestrictedLocation is only ever that: OKX 51155,
 * Bybit 170209, KuCoin 400500, Bitget 40024; OKX 51773 "feature not available in your region"; KuCoin 126046 "this digital asset does not
 * support your IP region", 126021/126045 "does not support user participation in your region", 126037, 130315): the exchange still serves
 * everything else here, so it is said as that and holds nothing else back */
const PRODUCT_RULE = /"(51155|51773|170209|400500|40024|126021|126037|126045|126046|130315)"|\bretCode"?\s*:\s*170209\b/;
/** Binance capping leverage for this location (-4201, -4206, -4403): a cap, not a closed door */
const LEVERAGE_RULE = /"?code"?\s*:\s*-(4201|4206|4403)\b/;
/** Deribit's country ban (12005 country_is_banned: "possibly via IP check"), filed by the library as a bad key */
const DERIBIT_REGION = /"code"\s*:\s*"?12005\b|country_is_banned/;
/** Bybit's IP ban (10009 "IP has been banned"), filed by the library as a bad key */
const BYBIT_IP_BAN = /\bretCode"?\s*:\s*"?10009\b|\bIP ha(?:s|d) been banned\b/i;
/** KuCoin's rate limit (429000), which the library files as a plain error with no status */
const RATE_CODE = /"code"\s*:\s*"429000"|\btoo many requests\b/i;
/** an exchange's own server failing in its own words (Gemini's "System": "We are experiencing technical issues") */
const OUTAGE_WORDS = /\btechnical issues\b|"reason"\s*:\s*"System"/i;
/** what a connection cut mid-answer throws from beneath the library, by name */
const CUT = new Set(["SocketError", "BodyTimeoutError", "HeadersTimeoutError", "RequestAbortedError", "AbortError", "ClientDestroyedError", "ClientClosedError"]);

export function exchangeSaidNo(venue: string, name: string, err: unknown, key: KeyFile): Refusal {
  const e = err as { name?: string; message?: string; retryAfterMs?: number };
  const kind = String(e?.name ?? "");
  const wait = typeof e?.retryAfterMs === "number" && e.retryAfterMs > 0 ? e.retryAfterMs : undefined;
  // redacted before the whitespace is folded and the text is cut: a secret over several lines (a PEM key), or one the cut would split, is still found.
  // The cut never splits the exchange's own sentence (the "msg" in the JSON it answered with): it runs to the end of that sentence when the
  // sentence runs past it, so Binance's "…Please contact customer service if you believe you received this message in error." stays whole
  const folded = redact(String(e?.message ?? err), Object.values(key)).replace(/\s+/g, " ");
  const sentence = /"(?:msg|message|retMsg|error_description)"\s*:\s*"(?:[^"\\]|\\.)*"/.exec(folded);
  const said = folded.slice(0, Math.min(600, Math.max(240, sentence ? sentence.index + sentence[0].length : 0)));
  const native = { error: kind, said };
  const http = thrownHttp(String(e?.message ?? err));
  // the connection itself failing, with no HTTP answer at all (a reset, no route, a certificate that is not the exchange's, an answer cut off
  // halfway): no answer from the exchange — never its refusal, and never its yes. Read first: a certificate's names could read as place words
  const code = transportCode(err);
  if (!http && (code || CUT.has(kind))) return code ? unreachable(venue, name, err, Object.values(key)) : no("E_VENUE_UNREACHABLE", { venue, message: `${name} could not be reached: the answer was cut off`, native: { error: kind } });
  // a place rule about one pair or product: that, and not "does not serve this location"
  if (kind === "RestrictedLocation" || PRODUCT_RULE.test(said)) return no("E_VENUE_GEOBLOCKED", { venue, message: `${name} does not offer this pair or product to this location: that is its own rule, for this alone, and the account does not look for a way around it`, native, detail: { scope: "product" } });
  if (LEVERAGE_RULE.test(said)) return no("E_VENUE_GEOBLOCKED", { venue, message: `${name} caps leverage for this location: that is its own rule, and the account does not look for a way around it`, native, detail: { scope: "leverage" } });
  // judged by what the exchange said, not by the class the library picked: Bybit's country block arrives as a "rate limit", OKX's as HTTP 200.
  // Read whole: an edge's HTML page says it further in than the sentence kept, and then the sentence around it is what is kept
  const region = REGION.test(said) || OKX_REGION.test(said) || DERIBIT_REGION.test(said);
  if (region) return no("E_VENUE_GEOBLOCKED", { venue, message: `${name} does not serve this location: that is its own rule, and the account does not look for a way around it`, native });
  if (REGION.test(folded)) {
    const plain = (http ? http.body : folded).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    const at = Math.max(0, plain.search(REGION));
    return no("E_VENUE_GEOBLOCKED", { venue, message: `${name} does not serve this location: that is its own rule, and the account does not look for a way around it`, native: { error: kind, said: plain.slice(Math.max(0, at - 120), at + 120).trim() } });
  }
  // the server in front of the exchange refusing this network with a page of its own (the library calls it "not available"): not a wait
  if (http && edgeRefused(http.status, http.body)) return no("E_VENUE_GEOBLOCKED", { venue, message: edgeWords(name, http.status, http.body), native: { error: kind, status: http.status, edge: true } });
  // a 2xx page where the API answers JSON (guardClient): something on this network answered in the exchange's place
  if (kind === "BadResponse" && http && http.status < 300) return no("E_VENUE_UNREACHABLE", { venue, message: notTheApiWords(name), native: { error: kind, status: http.status, page: true } });
  if (BINANCE_2015.test(said)) return no("E_VENUE_UNAUTHORIZED", { venue, message: `${name} refused the key: it is wrong, it lacks the permission, or this machine's IP is not on its list (the exchange gives one answer for all three)`, native });
  // the key is bound to IP addresses and this machine's is not one: the key and the place are fine, the owner adds the address
  if (IP_LIST.test(said)) return no("E_VENUE_PERMISSION", { venue, message: ipListWords(name), native, detail: { ipList: true } });
  // banned for too many requests (Binance's 418, "IP banned until <ms>"; Bybit's 10009, and its 403 "access too frequent", which asks for
  // at least ten minutes with nothing sent): until then, not "in a minute"
  const until = bannedUntil(said);
  if (until !== undefined || BYBIT_IP_BAN.test(said) || http?.status === 418 || (kind === "DDoSProtection" && /\b418\b/.test(said))) return bannedNo(venue, name, until ?? (wait ? Date.now() + wait : undefined), native);
  if (http?.status === 403 && /^bybit/i.test(String(e?.message ?? "").trim()) && !/^\s*[{[]/.test(http.body)) return bannedNo(venue, name, Date.now() + 600_000, { ...native, status: 403 });
  if (kind === "PermissionDenied" || kind === "AccountNotEnabled" || OKX_PERMISSION.test(said)) return no("E_VENUE_PERMISSION", { venue, message: `${name} refused: the key lacks the permission for this, or this machine's IP is not on the key's list`, native });
  if (kind === "AuthenticationError" || kind === "AccountSuspended" || OKX_KEY.test(said)) return no("E_VENUE_UNAUTHORIZED", { venue, message: `${name} does not accept this key`, native });
  if (kind === "RateLimitExceeded" || kind === "DDoSProtection" || http?.status === 429 || RATE_CODE.test(said)) return rateLimitedNo(venue, name, wait, native);
  if (kind === "ExchangeNotAvailable" || kind === "OnMaintenance" || kind === "NetworkError" || kind === "RequestTimeout" || kind === "TimeoutError" || kind === "TypeError" || kind === "BadResponse" || kind === "NullResponse") return no("E_VENUE_UNREACHABLE", { venue, message: `${name} could not be reached`, native });
  // the exchange's own server failing (5xx), whatever class the library picked (Gemini, MEXC map a 500 to a plain error): an outage, asked again soon
  if ((http && http.status >= 500) || OUTAGE_WORDS.test(said)) return no("E_VENUE_UNREACHABLE", { venue, message: `${name} could not be reached: its server failed${http ? ` (HTTP ${http.status})` : ""}`, native: { ...native, ...(http ? { status: http.status } : {}) } });
  return no("E_VENUE_REJECTED", { venue, message: `${name} refused the request`, native });
}

const yes = (v: unknown): boolean => v === true || v === "true";
const rec = (v: unknown): Record<string, unknown> => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const words = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const said = (can: string[], ip: string) => {
  const more = can.filter((c) => c !== "read");
  return `${ip}${more.length ? ` · it can do more than read (${more.join(", ")})` : can.length ? " · a read-only key" : " · the exchange did not say what the key may do"}`;
};
/** KuCoin's permission names (GET /api/v1/user/api-key `permission`), in the words the account shows */
const KUCOIN: Record<string, string> = { General: "read", Spot: "trade spot", Margin: "trade margin", Futures: "trade futures", Unified: "trade (unified account)", Earn: "earn", InnerTransfer: "move between its own accounts", FlexTransfers: "flexible transfers", Withdrawal: "withdraw", LeadtradeFutures: "lead trading futures" };

/** what the exchange says the key may do — where it has a call that says. Such a call that fails leaves it unknown: the key's first refusal
 * will say. Only a refusal of the key itself, or of the place, stops the connection, because the balances would meet it too */
async function probe(client: ExchangeClient, venue: string, name: string, key: KeyFile): Promise<LiveProbe> {
  const ask = async (call: string, run: () => Promise<LiveProbe>): Promise<LiveProbe> => {
    try {
      return await run();
    } catch (err) {
      const r = exchangeSaidNo(venue, name, err, key);
      if (r.code === "E_VENUE_UNAUTHORIZED" || r.code === "E_VENUE_GEOBLOCKED") throw err;
      return { can: [], note: `the exchange did not answer what the key may do (${call}): its first refusal will`, native: { call, failed: r.native } };
    }
  };
  // Binance.US documents no apiRestrictions call (keys.md §2.5): it is not asked
  if (isBinance(client.id) && client.id !== "binanceus" && client.sapiGetAccountApiRestrictions) {
    const call = "GET /sapi/v1/account/apiRestrictions";
    return ask(call, async () => {
      const r = rec(await client.sapiGetAccountApiRestrictions!());
      if (r.enableReading === undefined) return { can: [], note: `the exchange did not answer what the key may do (${call}): its first refusal will`, native: { call, failed: { answer: "no result" } } };
      const can = [yes(r.enableReading) ? "read" : "", yes(r.enableSpotAndMarginTrading) ? "trade spot and margin" : "", yes(r.enableFutures) ? "trade futures" : "", yes(r.permitsUniversalTransfer) ? "move between its own wallets" : "", yes(r.enableInternalTransfer) ? "transfer to other Binance accounts" : "", yes(r.enableWithdrawals) ? "withdraw" : ""].filter(Boolean);
      const more = can.filter((c) => c !== "read");
      return { can, note: `${yes(r.ipRestrict) ? "bound to an IP list" : "not bound to an IP"}${more.length ? ` · it can do more than read (${more.join(", ")})` : " · a read-only key"}`, native: { call, ...r } };
    });
  }
  if (isOkx(client.id) && client.privateGetAccountConfig) {
    const call = "GET /api/v5/account/config";
    return ask(call, async () => {
      const row = (await client.privateGetAccountConfig!()).data?.[0] ?? {};
      const perm = String(row.perm ?? "").split(",").map((p) => p.trim()).filter(Boolean);
      const can = perm.map((p) => (p === "read_only" ? "read" : p));
      return { can, note: said(can, row.ip ? "bound to an IP list" : "not bound to an IP"), native: { call, perm: row.perm ?? null, ipBound: Boolean(row.ip), acctLv: row.acctLv ?? null } };
    });
  }
  if (isBybit(client.id) && client.privateGetV5UserQueryApi) {
    // readOnly 0 is "Read and Write", 1 "Read only"; spot orders need Spot SpotTrade, contracts ContractTrade Order or (unified) Derivatives
    // DerivativesTrade; Wallet holds the transfer and withdraw permissions; ips ["*"] is no IP bound (Bybit v5 user/apikey-info)
    const call = "GET /v5/user/query-api";
    return ask(call, async () => {
      const raw = rec(await client.privateGetV5UserQueryApi!());
      const r = rec(raw.result);
      // only a real answer says what the key may do: anything else (a challenge page the library handed back, no result) leaves it unknown,
      // and the exchange's own answer to an order decides — never "a read-only key" made up from nothing
      if ((raw.retCode !== undefined && String(raw.retCode) !== "0") || !["0", "1"].includes(String(r.readOnly))) return { can: [], note: `the exchange did not answer what the key may do (${call}): its first refusal will`, native: { call, failed: { answer: "no result" } } };
      const writes = r.readOnly === 0 || r.readOnly === "0";
      const p = rec(r.permissions);
      const can = ["read", writes && words(p.Spot).includes("SpotTrade") ? "trade spot" : "", writes && (words(p.ContractTrade).includes("Order") || words(p.Derivatives).includes("DerivativesTrade")) ? "trade contracts" : "", writes && words(p.Wallet).includes("AccountTransfer") ? "move between its own wallets" : "", writes && words(p.Wallet).includes("SubMemberTransfer") ? "transfer to sub-accounts" : "", writes && words(p.Wallet).includes("Withdraw") ? "withdraw" : ""].filter(Boolean);
      const ips = words(r.ips);
      const bound = ips.length > 0 && !ips.includes("*");
      const days = num(r.deadlineDay);
      return { can, note: said(can, bound ? "bound to an IP list" : `not bound to an IP${days > 0 ? ` (Bybit ends such a key in ${days} days)` : ""}`), native: { call, readOnly: r.readOnly ?? null, permissions: p, ipBound: bound, uta: r.uta ?? null, deadlineDay: r.deadlineDay ?? null } };
    });
  }
  if (client.id === "coinbase" && client.v3PrivateGetBrokerageKeyPermissions) {
    // can_view, can_trade, can_transfer: Coinbase's View, Trade and Transfer ("send and receive funds, on and off platform")
    const call = "GET /api/v3/brokerage/key_permissions";
    return ask(call, async () => {
      const r = rec(await client.v3PrivateGetBrokerageKeyPermissions!());
      const can = [yes(r.can_view) ? "read" : "", yes(r.can_trade) ? "trade" : "", yes(r.can_transfer) ? "transfer (send and withdraw)" : ""].filter(Boolean);
      return { can, note: said(can, "the IP list is not reported"), native: { call, can_view: r.can_view ?? null, can_trade: r.can_trade ?? null, can_transfer: r.can_transfer ?? null, portfolio_type: r.portfolio_type ?? null } };
    });
  }
  if (client.id === "kucoin" && client.privateGetUserApiKey) {
    const call = "GET /api/v1/user/api-key";
    return ask(call, async () => {
      const d = rec(rec(await client.privateGetUserApiKey!()).data);
      const perm = String(d.permission ?? "").split(",").map((p) => p.trim()).filter(Boolean);
      const can = [...new Set(perm.map((p) => KUCOIN[p] ?? p))];
      const ip = typeof d.ipWhitelist === "string" ? (d.ipWhitelist ? "bound to an IP list" : "not bound to an IP") : "the IP list is not reported";
      return { can, note: said(can, ip), native: { call, permission: d.permission ?? null, apiVersion: d.apiVersion ?? null, isMaster: d.isMaster ?? null } };
    });
  }
  return { can: [], note: "this exchange has no call that says what a key may do: its first refusal will", native: { call: null } };
}

/** exchanges that keep a funding wallet apart from the trading one, and what the library calls it */
const LEDGERS: Record<string, Array<{ where: string; params?: Record<string, unknown> }>> = {
  binance: [{ where: "spot" }, { where: "funding", params: { type: "funding" } }],
  binanceus: [{ where: "spot" }],
  okx: [{ where: "trading" }, { where: "funding", params: { type: "funding" } }],
  bybit: [{ where: "unified" }, { where: "funding", params: { type: "funding" } }],
};

/** what the library made of an answer it could not read — a page, an empty body — carries that answer as its `info`: it is not a balance */
function readBalance(bal: Record<string, unknown>, id: string): Record<string, unknown> {
  if ("info" in bal && (bal.info === null || typeof bal.info !== "object")) throw Object.assign(new Error(`${id} answered the balance with something that is not its API's answer`), { name: "BadResponse" });
  return (bal.total ?? {}) as Record<string, unknown>;
}

/** A second ledger (a funding wallet) that fails: not shown only when the exchange said this key may not see it. A ban, an edge's page, a
 * place rule, a key bound to other addresses or no answer is the read failing — never a read that looks complete without that ledger */
function keyMayNotSee(venue: string, name: string, err: unknown, key: KeyFile): boolean {
  const r = exchangeSaidNo(venue, name, err, key);
  if (String((err as { name?: string } | undefined)?.name) === "NotSupported") return true;
  return (r.code === "E_VENUE_PERMISSION" && !(r.detail as { ipList?: unknown } | undefined)?.ipList) || (r.code === "E_VENUE_REJECTED" && !(r.native as { status?: unknown } | undefined)?.status);
}

async function balances(client: ExchangeClient, who: { venue: string; name: string; key: KeyFile } = { venue: client.id, name: client.id, key: {} }): Promise<LiveBalance[]> {
  const ledgers = LEDGERS[client.id] ?? [{ where: "" }];
  const out: LiveBalance[] = [];
  for (const [i, l] of ledgers.entries()) {
    let total: Record<string, unknown>;
    try {
      total = readBalance(await client.fetchBalance(l.params ?? {}), client.id);
    } catch (err) {
      // the main ledger failing is the read failing; a second ledger the key may not see is just not shown
      if (i === 0 || !keyMayNotSee(who.venue, who.name, err, who.key)) throw err;
      continue;
    }
    for (const [asset, v] of Object.entries(total)) if (num(v) > 0) out.push({ asset, amount: num(v), ...(l.where ? { where: l.where } : {}) });
  }
  // what the exchange itself last traded each held asset at, for the ones that are not dollars
  const assets = [...new Set(out.filter((b) => !isStable(b.asset)).map((b) => b.asset))];
  if (assets.length && client.fetchTickers) {
    try {
      await loadList(client);
      const quotes = ["USDT", "USDC", "USD"];
      const symbols = assets.flatMap((a) => quotes.map((q) => `${a}/${q}`)).filter((s) => client.markets === undefined || client.markets[s] !== undefined);
      const tickers = symbols.length ? await client.fetchTickers(symbols) : {};
      for (const b of out) {
        const t = quotes.map((q) => tickers[`${b.asset}/${q}`]).find((x) => x && num(x.last ?? x.close) > 0);
        if (t) b.usd = b.amount * num(t.last ?? t.close);
      }
    } catch {
      // no prices this time: the amounts are still right
    }
  }
  return out;
}

export interface ExchangeRequest {
  venue: string;
  exchangeId: string;
  label: string;
  /** the key file's path, as it is shown */
  reference: string;
  key: KeyFile;
  open?: OpenExchange | undefined;
}

/** the status and the body in what the library threw ("gate GET https://… 403 Forbidden <html>…"), when it says. The body is what follows
 * the status's reason phrase — a page, JSON, or a few plain words ("error code: 1009") */
export function thrownHttp(text: string): { status: number; body: string } | undefined {
  const m = /^\S+ (?:GET|POST|PUT|DELETE|PATCH) https?:\/\/\S+ (\d{3})\b ?([\s\S]*)$/.exec(text.trim());
  if (!m) return undefined;
  const status = Number(m[1]);
  let rest = (m[2] ?? "").trim();
  const phrase = STATUS_CODES[status];
  if (phrase && rest.toLowerCase().startsWith(phrase.toLowerCase())) rest = rest.slice(phrase.length).trim();
  const at = rest.search(/[{[<]/);
  return { status, body: at >= 0 ? rest.slice(at) : rest };
}

/** An exchange's cheapest keyless public answer, for one whose library has no clock call (checked live 2026-10-08: each answered). Without
 * it, detection took the library's missing call for the exchange's yes, and never heard the exchange at all */
const FIRST_PUBLIC: Record<string, string> = { gemini: "publicGetV1Symbols", bitstamp: "publicGetTradingPairsInfo", cryptocom: "v1PublicGetPublicGetInstruments", coinbaseinternational: "v1PublicGetInstruments", krakenfutures: "publicGetInstruments" };

/** the first keyless question an exchange is asked: its clock; else its cheapest public list (FIRST_PUBLIC); else its markets, which
 * connecting reads first anyway. Resolves when the exchange answered; throws what it answered otherwise */
async function firstQuestion(client: ExchangeClient): Promise<void> {
  if (client.has?.fetchTime !== false && typeof client.fetchTime === "function") {
    try {
      await client.fetchTime();
      return;
    } catch (err) {
      if (String((err as { name?: string } | undefined)?.name) !== "NotSupported") throw err;
    }
  }
  const named = Object.hasOwn(FIRST_PUBLIC, client.id) ? FIRST_PUBLIC[client.id]! : "";
  const call = named ? (client as unknown as Record<string, unknown>)[named] : undefined;
  if (typeof call === "function") {
    await (call as () => Promise<unknown>).call(client);
    return;
  }
  const before = client.lastRestRequestTimestamp;
  await loadList(client);
  // a market list built into the library sends nothing: the exchange has not been asked. Its cheapest public question is, or nothing is said
  if (typeof before === "number" && client.lastRestRequestTimestamp === before) {
    const symbol = Object.keys(client.markets ?? {})[0];
    if (symbol && client.has?.fetchTicker !== false && typeof client.fetchTicker === "function") {
      await client.fetchTicker(symbol);
      return;
    }
    throw Object.assign(new Error(`${client.id} has no question it answers without a key`), { name: "NotAsked" });
  }
}

/** the first question exchangeSource asks — the exchange's public clock, or for one without, its cheapest public list — asked alone, with
 * no key (live/reach.ts: before the owner makes one). Undefined: the exchange answered here */
export async function exchangeClock(venue: string, exchangeId: string, open: OpenExchange = openExchange): Promise<Refusal | undefined> {
  const client = await open(exchangeId, {}).catch(() => undefined);
  if (!client) return no("E_WALLET_UNKNOWN_VENUE", { venue, message: `the exchange library knows no exchange called "${exchangeId}"`, detail: { exchange: exchangeId } });
  try {
    await firstQuestion(client);
    return undefined;
  } catch (err) {
    if (String((err as { name?: string } | undefined)?.name) === "NotAsked") return no("E_VENUE_UNREACHABLE", { venue, message: `${client.name ?? exchangeId} has no question it answers without a key: connecting asks it`, native: { asked: false } });
    if (String((err as { name?: string } | undefined)?.name) === "NotSupported") return undefined;
    // asked with no key, an answer that is not about the place or the network is still the exchange answering this network (Gate EU's clock
    // asks for a signed header): a "no way in" would be the library's call, not the exchange's word about where the user is
    const r = exchangeSaidNo(venue, client.name ?? exchangeId, err, {});
    return r.code === "E_VENUE_GEOBLOCKED" || r.code === "E_VENUE_UNREACHABLE" ? r : undefined;
  }
}

/** connect: the clock, the key's permissions, the balances — then a source that reads, and that moves money and places orders only behind
 * the account's door */
export async function exchangeSource(req: ExchangeRequest): Promise<{ source: LiveSource; first: LiveBalance[] } | Refusal> {
  const client = await (req.open ?? openExchange)(req.exchangeId, req.key).catch(() => undefined);
  if (!client) return no("E_WALLET_UNKNOWN_VENUE", { venue: req.venue, message: `the exchange library knows no exchange called "${req.exchangeId}"`, detail: { exchange: req.exchangeId } });
  const name = req.label || client.name || req.exchangeId;
  const missing = Object.entries(client.requiredCredentials ?? {}).filter(([field, on]) => on && ["apiKey", "secret", "password", "uid"].includes(field) && !req.key[field]).map(([field]) => field);
  if (missing.length) return no("E_ACCOUNT_CREDENTIAL", { venue: req.venue, message: `${client.name ?? req.exchangeId} also needs ${missing.map((m) => `"${m}"`).join(", ")} in ${req.reference}${missing.includes("password") ? ' ("password" is the passphrase set when the API key was made)' : ""}`, detail: { missing } });
  try {
    // the exchange's public clock, where the library has the call: its base class answers NotSupported where it has none (Kraken Futures,
    // Phemex), and that is the library's word, not the exchange's refusal of the key or the place
    if (client.has?.fetchTime !== false) {
      try {
        await client.fetchTime?.();
      } catch (err) {
        if (String((err as { name?: string } | undefined)?.name) !== "NotSupported") throw err;
      }
    }
    const said = await probe(client, req.venue, name, req.key);
    const who = { venue: req.venue, name, key: req.key };
    const first = await balances(client, who);
    const ledgers = (LEDGERS[client.id] ?? []).map((l) => l.where);
    const source: LiveSource = { name, kind: "cex", reference: req.reference, via: `${client.name ?? req.exchangeId} · unified exchange API`, probe: said, read: () => balances(client, who).catch((err) => Promise.reject(exchangeSaidNo(req.venue, name, err, req.key))), writer: exchangeWriter(client, req.venue, name, Object.values(req.key), said, ledgers), trader: exchangeTrader(client, req.venue, name, Object.values(req.key), said) };
    return { source, first };
  } catch (err) {
    return exchangeSaidNo(req.venue, name, err, req.key);
  }
}
