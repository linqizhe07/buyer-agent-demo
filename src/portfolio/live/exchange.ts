/** An exchange account, read through the unified exchange library (ccxt): any exchange the library covers, with an API key from a key file.
 *
 * Three calls are made when it is connected, in this order:
 *   1. the exchange's public clock — no key involved. If the exchange does not serve this location, or cannot be reached, this is where
 *      that is learned, before the key is shown to anyone;
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
import type { Refusal } from "../../core/errors.ts";
import { no } from "../refuse.ts";
import type { KeyFile, KeyShape } from "./credentials.ts";
import { exchangeTrader } from "./exchange-trade.ts";
import { isStable, num, redact, REGION, type LiveBalance, type LiveProbe, type LiveSource } from "./types.ts";
import { exchangeWriter } from "./writes.ts";

/** the part of a ccxt exchange this file uses; the tests hand in a stand-in with the same shape */
export interface ExchangeClient {
  id: string;
  name?: string | undefined;
  requiredCredentials?: Record<string, boolean> | undefined;
  markets?: Record<string, unknown> | undefined;
  loadMarkets?(reload?: boolean): Promise<unknown>;
  fetchTime?(): Promise<unknown>;
  fetchBalance(params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  fetchTickers?(symbols?: string[]): Promise<Record<string, { last?: number | undefined; close?: number | undefined }>>;
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
  return new lib[exchangeId]!({ apiKey: key.apiKey, secret: key.secret, ...(key.password ? { password: key.password } : {}), ...(key.uid ? { uid: key.uid } : {}), enableRateLimit: true, timeout: 12_000 });
};

/** every exchange the library covers, by id and by the name it gives itself; the well-known ones first */
const FIRST = ["binance", "okx", "bybit", "kraken", "coinbase", "kucoin", "gate", "bitget", "mexc", "htx", "cryptocom", "bitfinex", "gemini", "bitstamp", "binanceus", "upbit", "deribit"];
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
const OKX_REGION = /"(50121|50051|51773)"/;
const OKX_PERMISSION = /"(50120|50110)"/;
const OKX_KEY = /"(50111|50113|50105|50119)"/;
/** Binance's -2015 is one code for a wrong key, a missing permission and an IP not on the key's list: it cannot be told apart */
const BINANCE_2015 = /-2015|Invalid API-key, IP, or permissions/;

export function exchangeSaidNo(venue: string, name: string, err: unknown, key: KeyFile): Refusal {
  const e = err as { name?: string; message?: string };
  const kind = String(e?.name ?? "");
  // redacted before the whitespace is folded and the text is cut: a secret over several lines (a PEM key), or one the cut would split, is still found
  const said = redact(String(e?.message ?? err), Object.values(key)).replace(/\s+/g, " ").slice(0, 240);
  const native = { error: kind, said };
  // judged by what the exchange said, not by the class the library picked: Bybit's country block arrives as a "rate limit", OKX's as HTTP 200
  const region = kind === "RestrictedLocation" || REGION.test(said) || OKX_REGION.test(said);
  if (region) return no("E_VENUE_GEOBLOCKED", { venue, message: `${name} does not serve this location: that is its own rule, and the account does not look for a way around it`, native });
  if (BINANCE_2015.test(said)) return no("E_VENUE_UNAUTHORIZED", { venue, message: `${name} refused the key: it is wrong, it lacks the permission, or this machine's IP is not on its list (the exchange gives one answer for all three)`, native });
  if (kind === "PermissionDenied" || kind === "AccountNotEnabled" || OKX_PERMISSION.test(said)) return no("E_VENUE_PERMISSION", { venue, message: `${name} refused: the key lacks the permission for this, or this machine's IP is not on the key's list`, native });
  if (kind === "AuthenticationError" || kind === "AccountSuspended" || OKX_KEY.test(said)) return no("E_VENUE_UNAUTHORIZED", { venue, message: `${name} does not accept this key`, native });
  if (kind === "RateLimitExceeded" || kind === "DDoSProtection") return no("E_VENUE_UNREACHABLE", { venue, message: `${name} is rate-limiting this machine: try again in a minute`, native });
  if (kind === "ExchangeNotAvailable" || kind === "OnMaintenance" || kind === "NetworkError" || kind === "RequestTimeout" || kind === "TimeoutError" || kind === "TypeError") return no("E_VENUE_UNREACHABLE", { venue, message: `${name} could not be reached`, native });
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
      const r = await client.sapiGetAccountApiRestrictions!();
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
      const r = rec(rec(await client.privateGetV5UserQueryApi!()).result);
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

async function balances(client: ExchangeClient): Promise<LiveBalance[]> {
  const ledgers = LEDGERS[client.id] ?? [{ where: "" }];
  const out: LiveBalance[] = [];
  for (const [i, l] of ledgers.entries()) {
    let total: Record<string, unknown>;
    try {
      total = ((await client.fetchBalance(l.params ?? {})).total ?? {}) as Record<string, unknown>;
    } catch (err) {
      // the main ledger failing is the read failing; a second ledger the key cannot see is just not shown
      if (i === 0) throw err;
      continue;
    }
    for (const [asset, v] of Object.entries(total)) if (num(v) > 0) out.push({ asset, amount: num(v), ...(l.where ? { where: l.where } : {}) });
  }
  // what the exchange itself last traded each held asset at, for the ones that are not dollars
  const assets = [...new Set(out.filter((b) => !isStable(b.asset)).map((b) => b.asset))];
  if (assets.length && client.fetchTickers) {
    try {
      await client.loadMarkets?.();
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

/** connect: the clock, the key's permissions, the balances — then a source that reads, and that moves money and places orders only behind
 * the account's door */
export async function exchangeSource(req: ExchangeRequest): Promise<{ source: LiveSource; first: LiveBalance[] } | Refusal> {
  const client = await (req.open ?? openExchange)(req.exchangeId, req.key).catch(() => undefined);
  if (!client) return no("E_WALLET_UNKNOWN_VENUE", { venue: req.venue, message: `the exchange library knows no exchange called "${req.exchangeId}"`, detail: { exchange: req.exchangeId } });
  const name = req.label || client.name || req.exchangeId;
  const missing = Object.entries(client.requiredCredentials ?? {}).filter(([field, on]) => on && ["apiKey", "secret", "password", "uid"].includes(field) && !req.key[field]).map(([field]) => field);
  if (missing.length) return no("E_ACCOUNT_CREDENTIAL", { venue: req.venue, message: `${client.name ?? req.exchangeId} also needs ${missing.map((m) => `"${m}"`).join(", ")} in ${req.reference}${missing.includes("password") ? ' ("password" is the passphrase set when the API key was made)' : ""}`, detail: { missing } });
  try {
    await client.fetchTime?.();
    const said = await probe(client, req.venue, name, req.key);
    const first = await balances(client);
    const ledgers = (LEDGERS[client.id] ?? []).map((l) => l.where);
    const source: LiveSource = { name, kind: "cex", reference: req.reference, via: `${client.name ?? req.exchangeId} · unified exchange API`, probe: said, read: () => balances(client).catch((err) => Promise.reject(exchangeSaidNo(req.venue, name, err, req.key))), writer: exchangeWriter(client, req.venue, name, Object.values(req.key), said, ledgers), trader: exchangeTrader(client, req.venue, name, Object.values(req.key), said) };
    return { source, first };
  } catch (err) {
    return exchangeSaidNo(req.venue, name, err, req.key);
  }
}
