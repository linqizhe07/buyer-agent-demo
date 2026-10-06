import { createHash, createHmac, createPublicKey, generateKeyPairSync, randomBytes, verify } from "node:crypto";
import ccxt from "ccxt";
import { describe, expect, it } from "vitest";
import { isRefusal, type Refusal } from "../../src/core/errors.ts";
import { exchangeTrader } from "../../src/portfolio/live/exchange-trade.ts";
import { exchangeSource, type ExchangeClient } from "../../src/portfolio/live/exchange.ts";
import { DONE, type LiveTrader, type Market, type OrderState } from "../../src/portfolio/live/trade.ts";
import type { LiveSource } from "../../src/portfolio/live/types.ts";

/** TRADING at an exchange through the unified exchange library. Each exchange here is the REAL installed library with its network call
 * replaced: every request it builds is recorded, and it is answered with what the test says (shaped like the exchange's docs, as in the
 * spec's harness). The library still reads each answer with its own error handling. So a test sees the exact request the library sends
 * for what the trader asked: the URL, the body, the signature. Nothing leaves the process, and no key is anyone's: made-up strings, and a
 * P-256 key and a Kraken secret generated here and thrown away. */
const NOW = Date.parse("2026-10-05T19:53:20.000Z");
const CID = "0f3a9c01b2d4e6f80a1b2c3d4e5f6071";

type Dict = Record<string, unknown>;
interface Req {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
}
type Reply = { status?: number; body: unknown } | Error;

/** what the tests use of a library instance besides what the trader uses */
interface Lib extends ExchangeClient {
  setMarkets(markets: unknown[]): unknown;
  nonce: () => number;
  milliseconds: () => number;
  seconds: () => number;
  fetch: (url: string, method?: string, headers?: Record<string, string>, body?: string) => Promise<unknown>;
  handleErrors(code: number, reason: string, url: string, method: string, headers: Dict, body: string, response: unknown, requestHeaders: unknown, requestBody: unknown): unknown;
  handleHttpStatusCode(code: number, reason: string, url: string, method: string, body: string): unknown;
  options: Dict;
}

function venue(id: string, creds: Record<string, string>, markets: Dict[], options: Dict = {}) {
  const Ctor = (ccxt as unknown as Record<string, new (config: Dict) => Lib>)[id]!;
  const x = new Ctor({ ...creds, enableRateLimit: false, options });
  x.setMarkets(markets);
  x.nonce = () => NOW;
  x.milliseconds = () => NOW;
  x.seconds = () => Math.floor(NOW / 1000);
  const seen: Req[] = [];
  const replies: Reply[] = [];
  x.fetch = async (url, method = "GET", headers = {}, body = undefined) => {
    seen.push({ method, url, headers: { ...headers }, body });
    const r = replies.shift();
    if (!r) throw new Error(`not set up in this test: ${method} ${url}`);
    if (r instanceof Error) throw r;
    const status = r.status ?? 200;
    const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    const parsed = typeof r.body === "string" ? undefined : r.body;
    // the library's own reading of the answer, as its real fetch does it (base/Exchange.js handleRestResponse)
    if (x.handleErrors(status, "", url, method, {}, text, parsed, headers, body) === undefined) x.handleHttpStatusCode(status, "", url, method, text);
    return parsed ?? text;
  };
  const answer = (...r: Reply[]) => replies.push(...r);
  return { x, seen, answer };
}

const ok = <T>(x: T | Refusal): T => {
  if (isRefusal(x)) throw new Error(`expected an answer, got ${x.code}: ${x.message} ${JSON.stringify(x.native)}`);
  return x;
};
const said = (x: unknown, secrets: string[]): Refusal => {
  if (!isRefusal(x)) throw new Error(`expected a refusal, got ${JSON.stringify(x)}`);
  for (const s of secrets) expect(JSON.stringify(x)).not.toContain(s);
  return x;
};
const hmac = (alg: string, key: string | Buffer, data: string | Buffer, enc: "hex" | "base64") => createHmac(alg, key).update(data).digest(enc);
const form = (body: string | undefined) => Object.fromEntries(new URLSearchParams(body ?? ""));

// ---- markets, shaped as the library parses them (the spec's harness, from the exchanges' public answers of 2026-10-05) -------------------

const spot = (id: string, base: string, quote: string, extra: Dict = {}): Dict => ({ id, symbol: `${base}/${quote}`, base, quote, baseId: base, quoteId: quote, type: "spot", spot: true, margin: false, swap: false, future: false, option: false, contract: false, active: true, precision: { amount: 0.00000001, price: 0.1 }, limits: { amount: { min: 0.00001 }, cost: {}, price: {} }, info: {}, ...extra });
const linear = (id: string, base: string, quote: string, extra: Dict = {}): Dict => ({ id, symbol: `${base}/${quote}:${quote}`, base, quote, settle: quote, baseId: base, quoteId: quote, settleId: quote, type: "swap", spot: false, margin: false, swap: true, future: false, option: false, contract: true, linear: true, inverse: false, contractSize: 0.01, active: true, precision: { amount: 0.01, price: 0.1 }, limits: { amount: { min: 0.01 }, cost: {}, price: {} }, info: {}, ...extra });

const OKX_MARKETS = [
  spot("BTC-USDT", "BTC", "USDT", { info: { instType: "SPOT", state: "live" } }),
  spot("ETH-USDT", "ETH", "USDT", { precision: { amount: 0.000001, price: 0.01 }, limits: { amount: { min: 0.0001 }, cost: {}, price: {} }, info: { instType: "SPOT", state: "live" } }),
  spot("ETH-BTC", "ETH", "BTC", { precision: { amount: 0.000001, price: 0.00001 }, info: { instType: "SPOT", state: "live" } }),
  spot("ZZZ-USDT", "ZZZ", "USDT", { active: false, info: { instType: "SPOT", state: "suspend" } }),
  spot("AAVE-USDC", "AAVE", "USDC", { info: { instType: "SPOT", state: "live" } }),
  linear("BTC-USDT-SWAP", "BTC", "USDT", { info: { instType: "SWAP", ctType: "linear" } }),
  { ...linear("BTC-USD-SWAP", "BTC", "USD"), symbol: "BTC/USD:BTC", settle: "BTC", settleId: "BTC", linear: false, inverse: true, contractSize: 100, precision: { amount: 1, price: 0.1 }, limits: { amount: { min: 1 }, cost: {}, price: {} } },
  { ...linear("BTC-USDT-261225", "BTC", "USDT"), symbol: "BTC/USDT:USDT-261225", type: "future", swap: false, future: true, expiry: Date.parse("2026-12-25T08:00:00Z"), expiryDatetime: "2026-12-25T08:00:00.000Z" },
  { ...linear("BTC-USD-261225-90000-C", "BTC", "USD"), symbol: "BTC/USD:BTC-261225-90000-C", type: "option", swap: false, option: true, linear: false, inverse: true, settle: "BTC" },
];
const BINANCE_MARKETS = [
  spot("BTCUSDT", "BTC", "USDT", { precision: { amount: 0.00001, price: 0.01 }, limits: { amount: { min: 0.00001 }, cost: { min: 5 }, price: {} }, info: { status: "TRADING", orderTypes: ["LIMIT", "LIMIT_MAKER", "MARKET", "STOP_LOSS_LIMIT", "TAKE_PROFIT_LIMIT"] } }),
  spot("PAXGUSDT", "PAXG", "USDT", { active: false, precision: { amount: 0.0001, price: 0.01 }, info: { status: "BREAK", orderTypes: ["LIMIT", "MARKET"] } }),
  spot("XYZUSDT", "XYZ", "USDT", { precision: { amount: 1, price: 0.0001 }, info: { status: "TRADING", orderTypes: ["LIMIT", "LIMIT_MAKER"] } }),
  linear("BTCUSDT", "BTC", "USDT", { contractSize: 1, precision: { amount: 0.001, price: 0.1 }, limits: { amount: { min: 0.001 }, cost: { min: 100 }, price: {} }, info: { status: "TRADING", orderTypes: ["LIMIT", "MARKET", "STOP"] } }),
];
const BYBIT_MARKETS = [spot("BTCUSDT", "BTC", "USDT", { precision: { amount: 0.000001, price: 0.1 }, limits: { amount: { min: 0.000048 }, cost: { min: 5 }, price: {} } })];
const COINBASE_MARKETS = [
  spot("BTC-USD", "BTC", "USD", { precision: { amount: 0.00000001, price: 0.01 }, limits: { amount: { min: 0.00000001, max: 3400 }, cost: { min: 1, max: 150000000 }, price: {} }, info: { status: "online", cancel_only: false, limit_only: false, post_only: false, trading_disabled: false } }),
  spot("SOL-USD", "SOL", "USD", { precision: { amount: 0.001, price: 0.01 }, info: { status: "online", cancel_only: false, limit_only: true, post_only: false } }),
  spot("DOGE-USD", "DOGE", "USD", { precision: { amount: 0.1, price: 0.00001 }, info: { status: "online", cancel_only: true, limit_only: false, post_only: false } }),
];
const KRAKEN_MARKETS = [
  spot("XXBTZUSD", "BTC", "USD", { altname: "XBTUSD", wsId: "XBT/USD", baseId: "XXBT", quoteId: "ZUSD", precision: { amount: 0.00000001, price: 0.1 }, limits: { amount: { min: 0.00005 }, cost: { min: 0.5 }, price: {} }, info: { altname: "XBTUSD", status: "online", tick_size: "0.1" } }),
  spot("CELRUSD", "CELR", "USD", { altname: "CELRUSD", precision: { amount: 0.00000001, price: 0.0000001 }, limits: { amount: { min: 50 }, cost: { min: 0.5 }, price: {} }, info: { altname: "CELRUSD", status: "online", tick_size: "0.000001" } }),
  spot("XETHZUSD", "ETH", "USD", { altname: "ETHUSD", active: false, info: { altname: "ETHUSD", status: "limit_only", tick_size: "0.01" } }),
];

// ---- the five exchanges, each on its own made-up key -------------------------------------------------------------------------------

const OKX = { apiKey: "made-up-okx-key-0001", secret: "made-up-okx-secret-0001", password: "Made-up-pass-0001!" };
function okx(can: string[] = ["read", "trade"], id = "okx") {
  const v = venue(id, OKX, OKX_MARKETS);
  return { ...v, t: exchangeTrader(v.x, id, "OKX", Object.values(OKX), { can }, { now: () => NOW }) };
}
const BINANCE = { apiKey: "made-up-binance-key-0001", secret: "made-up-binance-secret-0001" };
function binance(can: string[] = ["read", "trade spot and margin", "trade futures"]) {
  const v = venue("binance", BINANCE, BINANCE_MARKETS);
  return { ...v, t: exchangeTrader(v.x, "binance", "Binance", Object.values(BINANCE), { can }, { now: () => NOW }) };
}
const BYBIT = { apiKey: "made-up-bybit-key-0001", secret: "made-up-bybit-secret-0001" };
function bybit(unified: boolean) {
  // the library caches whether the account is unified (isUnifiedEnabled: GET /v5/user/query-api and /v5/account/info): set here, as known
  const v = venue("bybit", BYBIT, BYBIT_MARKETS, { enableUnifiedAccount: unified, enableUnifiedMargin: false });
  return { ...v, t: exchangeTrader(v.x, "bybit", "Bybit", Object.values(BYBIT), { can: ["read", "trade spot", "trade contracts"] }, { now: () => NOW }) };
}
const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const COINBASE = { apiKey: "organizations/00000000-0000-4000-8000-0000000000aa/apiKeys/00000000-0000-4000-8000-0000000000bb", secret: pair.privateKey.export({ type: "sec1", format: "pem" }).toString() };
function coinbase() {
  const v = venue("coinbase", COINBASE, COINBASE_MARKETS);
  return { ...v, t: exchangeTrader(v.x, "coinbase", "Coinbase", Object.values(COINBASE), { can: ["read", "trade"] }, { now: () => NOW }) };
}
const KRAKEN = { apiKey: "made-up-kraken-key-0001", secret: randomBytes(64).toString("base64") };
function kraken() {
  const v = venue("kraken", KRAKEN, KRAKEN_MARKETS);
  v.x.options.marketsByAltname = { XBTUSD: KRAKEN_MARKETS[0], CELRUSD: KRAKEN_MARKETS[1], ETHUSD: KRAKEN_MARKETS[2] };
  return { ...v, t: exchangeTrader(v.x, "kraken", "Kraken", Object.values(KRAKEN), { can: [] }, { now: () => NOW }) };
}
const ALL_SECRETS = [OKX.secret, OKX.password, BINANCE.secret, BYBIT.secret, KRAKEN.secret, COINBASE.secret.split("\n")[1]!];

// ---- answers, shaped like each exchange's docs ------------------------------------------------------------------------------------

const OKX_ORD = "312269865356374016";
const okxAck = (cl = CID) => ({ body: { code: "0", msg: "", data: [{ clOrdId: cl, ordId: OKX_ORD, tag: "", ts: "1791230000123", sCode: "0", sMsg: "", subCode: "" }], inTime: "1791230000121000", outTime: "1791230000124000" } });
const okxOrder = (state: string, accFillSz: string, avgPx: string, over: Dict = {}) => ({ body: { code: "0", msg: "", data: [{ accFillSz, avgPx, cTime: "1791230000123", uTime: "1791230000456", fillTime: accFillSz === "0" ? "" : "1791230000400", clOrdId: CID, fee: accFillSz === "0" ? "0" : "-0.0000004", feeCcy: "BTC", instId: "BTC-USDT", instType: "SPOT", ordId: OKX_ORD, ordType: "limit", px: "60000", side: "buy", state, sz: "0.001", tdMode: "cash", tgtCcy: "", reduceOnly: "false", ...over }] } });
const okxFail = (sCode: string, sMsg: string) => ({ body: { code: "1", msg: "All operations failed", data: [{ clOrdId: CID, ordId: "", sCode, sMsg, subCode: "", tag: "", ts: "1791230000123" }], inTime: "1", outTime: "2" } });
const okxTicker = { body: { code: "0", msg: "", data: [{ instType: "SPOT", instId: "BTC-USDT", last: "85573.7", lastSz: "0.00001", askPx: "85573.8", askSz: "0.56", bidPx: "85573.7", bidSz: "0.2", open24h: "85317", high24h: "86994.3", low24h: "84979.5", volCcy24h: "1", vol24h: "1", ts: "1791225482263", sodUtc0: "1", sodUtc8: "1" }] } };

const binOrder = (status: string, executedQty: string, cummulativeQuoteQty: string, over: Dict = {}) => ({ body: { symbol: "BTCUSDT", orderId: 28, orderListId: -1, clientOrderId: CID, transactTime: 1791230000123, price: "60000.00000000", origQty: "0.00100000", executedQty, origQuoteOrderQty: "0.00000000", cummulativeQuoteQty, status, timeInForce: "GTC", type: "LIMIT", side: "BUY", workingTime: 1791230000123, selfTradePreventionMode: "EXPIRE_MAKER", time: 1791230000123, updateTime: 1791230000456, fills: [], ...over } });

const BYBIT_ORD = "1321003749386327552";
const bybitList = (rows: Dict[]) => ({ body: { retCode: 0, retMsg: "OK", result: { nextPageCursor: "", category: "spot", list: rows }, retExtInfo: {}, time: 1791230000500 } });
const bybitRow = (orderStatus: string, cumExecQty: string, cumExecValue: string, avgPrice: string, over: Dict = {}): Dict => ({ symbol: "BTCUSDT", orderType: "Limit", orderLinkId: CID, orderId: BYBIT_ORD, avgPrice, orderStatus, cumExecValue, cumFeeDetail: cumExecQty === "0" ? {} : { BTC: "0.0000004" }, rejectReason: "EC_NoError", price: "60000", createdTime: "1791230000123", updatedTime: "1791230000456", side: "Buy", timeInForce: "GTC", cumExecFee: "0", leavesQty: String(Number((0.001 - Number(cumExecQty)).toFixed(6))), cumExecQty, qty: "0.001", marketUnit: "", ...over });

const CB_ORD = "52cfe5e2-0b29-4c19-a245-a6a773de5030";
const cbAck = (side = "BUY") => ({ body: { success: true, failure_reason: "UNKNOWN_FAILURE_REASON", order_id: CB_ORD, success_response: { order_id: CB_ORD, product_id: "BTC-USD", side, client_order_id: CID }, order_configuration: null } });
const cbOrder = (status: string, filled_size: string, average_filled_price: string, total_fees: string, over: Dict = {}) => ({ body: { order: { order_id: CB_ORD, product_id: "BTC-USD", user_id: "u", order_configuration: { limit_limit_gtc: { base_size: "0.001", limit_price: "60000", post_only: false } }, side: "BUY", client_order_id: CID, status, time_in_force: "GOOD_UNTIL_CANCELLED", created_time: "2026-10-05T19:53:20.123Z", completion_percentage: "40", filled_size, average_filled_price, fee: "", number_of_fills: "1", filled_value: "0", pending_cancel: false, size_in_quote: false, total_fees, size_inclusive_of_fees: false, total_value_after_fees: "0", trigger_status: "INVALID_ORDER_TYPE", order_type: "LIMIT", reject_reason: "REJECT_REASON_UNSPECIFIED", settled: false, product_type: "SPOT", reject_message: "", cancel_message: "", order_placement_source: "RETAIL_ADVANCED", outstanding_hold_amount: "0", is_liquidation: false, ...over } } });

const KR_ORD = "OUF4EM-FRGI2-MQMWZD";
const krQuery = (status: string, vol_exec: string, cost: string, fee: string, price: string) => ({ body: { error: [], result: { [KR_ORD]: { refid: null, userref: 0, cl_ord_id: CID, status, reason: null, opentm: 1791230000.123, closetm: status === "open" ? 0 : 1791230000.9, starttm: 0, expiretm: 0, descr: { pair: "XBTUSD", type: "buy", ordertype: "limit", price: "60000.0", price2: "0", leverage: "none", order: "buy 0.00100000 XBTUSD @ limit 60000.0", close: "" }, vol: "0.00100000", vol_exec, cost, fee, price, stopprice: "0.00000", limitprice: "0.00000", misc: "", oflags: "fciq", trades: vol_exec === "0.00000000" ? [] : ["TCCCTY-WE2O6-P3NB37"] } } } });

/** a JSON body the library signed: the parsed body, and whether OKX's signature over it is right */
function okxSigned(r: Req, path: string): unknown {
  const ts = new Date(NOW).toISOString();
  expect(r.headers["OK-ACCESS-KEY"]).toBe(OKX.apiKey);
  expect(r.headers["OK-ACCESS-PASSPHRASE"]).toBe(OKX.password);
  expect(r.headers["OK-ACCESS-TIMESTAMP"]).toBe(ts);
  expect(r.headers["OK-ACCESS-SIGN"]).toBe(hmac("sha256", OKX.secret, `${ts}${r.method}${path}${r.body ?? ""}`, "base64"));
  return r.body ? JSON.parse(r.body) : undefined;
}

// ==================================================================================================================================

describe("an exchange's connection carries a trader", () => {
  /** an exchange that answers its read calls like the library does; the probe call is the one the test hands in */
  const standIn = (id: string, over: Partial<ExchangeClient> = {}): ExchangeClient & { calls: string[] } => {
    const calls: string[] = [];
    return {
      id,
      name: id === "okx" ? "OKX" : id === "myokx" ? "MyOKX (EEA)" : id[0]!.toUpperCase() + id.slice(1),
      requiredCredentials: { apiKey: true, secret: true },
      markets: {},
      has: { swap: ["okx", "myokx", "binance", "bybit", "coinbase"].includes(id) },
      calls,
      async loadMarkets() {},
      async fetchTime() {
        calls.push("fetchTime");
        return 1;
      },
      async fetchBalance() {
        calls.push("fetchBalance");
        return { total: { USDT: 100 } };
      },
      ...over,
    } as ExchangeClient & { calls: string[] };
  };
  const connect = async (client: ExchangeClient): Promise<LiveSource> => {
    const r = await exchangeSource({ venue: client.id, exchangeId: client.id, label: "", reference: `credentials/${client.id}/api-key.json`, key: { apiKey: "made-up-key-0002", secret: "made-up-secret-0002" }, open: async () => client });
    if (isRefusal(r)) throw new Error(`${r.code}: ${r.message}`);
    return r.source;
  };
  const trader = (s: LiveSource): LiveTrader => s.trader!;

  it("OKX — and its EEA host, myokx — says trade: the trader may trade spot and perpetuals", async () => {
    for (const id of ["okx", "myokx"]) {
      const c = standIn(id, {
        async privateGetAccountConfig() {
          (c as unknown as { calls: string[] }).calls.push("accountConfig");
          return { data: [{ perm: "read_only,trade", ip: "", acctLv: "2" }] };
        },
      });
      const s = await connect(c);
      expect([id, trader(s).can, trader(s).what, s.probe.can]).toEqual([id, true, "spot and perpetuals", ["read", "trade"]]);
      // OKX's trading and funding ledgers are both read; the EEA host's, as one
      expect((c as unknown as { calls: string[] }).calls).toEqual(id === "okx" ? ["fetchTime", "accountConfig", "fetchBalance", "fetchBalance"] : ["fetchTime", "accountConfig", "fetchBalance"]);
    }
  });

  it("Binance by its two trading permissions; Binance.US is not asked a call it does not document, and its key's trading is unknown", async () => {
    const restrictions = (spot: boolean, futures: boolean) => async () => ({ ipRestrict: true, enableReading: true, enableSpotAndMarginTrading: spot, enableFutures: futures, enableWithdrawals: false });
    expect(trader(await connect(standIn("binance", { sapiGetAccountApiRestrictions: restrictions(false, false) }))).can).toBe(false);
    expect(trader(await connect(standIn("binance", { sapiGetAccountApiRestrictions: restrictions(false, true) }))).can).toBe(true);
    let asked = false;
    const us = await connect(
      standIn("binanceus", {
        async sapiGetAccountApiRestrictions() {
          asked = true;
          return {};
        },
      }),
    );
    expect([asked, trader(us).can, trader(us).what, us.probe.note]).toEqual([false, "unknown", "spot", "this exchange has no call that says what a key may do: its first refusal will"]);
  });

  it("Bybit by GET /v5/user/query-api: a read-only key cannot trade, a read-write one with SpotTrade can; the key itself is never kept", async () => {
    const queryApi = (readOnly: number, permissions: Dict) => async () => ({ retCode: 0, retMsg: "", result: { id: "1", apiKey: "made-up-key-0002", readOnly, secret: "", permissions, ips: ["*"], type: 1, deadlineDay: 83, uta: 1, isMaster: true } });
    const ro = await connect(standIn("bybit", { privateGetV5UserQueryApi: queryApi(1, { Spot: ["SpotTrade"], ContractTrade: ["Order", "Position"] }) }));
    expect([trader(ro).can, ro.probe.can]).toEqual([false, ["read"]]);
    const rw = await connect(standIn("bybit", { privateGetV5UserQueryApi: queryApi(0, { Spot: ["SpotTrade"], ContractTrade: [], Derivatives: [], Wallet: ["AccountTransfer"] }) }));
    expect([trader(rw).can, rw.probe.can, rw.probe.note]).toEqual([true, ["read", "trade spot", "move between its own wallets"], "not bound to an IP (Bybit ends such a key in 83 days) · it can do more than read (trade spot, move between its own wallets)"]);
    expect(rw.probe.native).toEqual({ call: "GET /v5/user/query-api", readOnly: 0, permissions: { Spot: ["SpotTrade"], ContractTrade: [], Derivatives: [], Wallet: ["AccountTransfer"] }, ipBound: false, uta: 1, deadlineDay: 83 });
    expect(JSON.stringify(rw)).not.toContain("made-up-key-0002");
  });

  it("Coinbase by can_trade (GET /api/v3/brokerage/key_permissions), KuCoin by its permission list; Kraken has no such call", async () => {
    const cb = await connect(standIn("coinbase", { v3PrivateGetBrokerageKeyPermissions: async () => ({ can_view: true, can_trade: true, can_transfer: false, portfolio_uuid: "p", portfolio_type: "DEFAULT" }) }));
    expect([trader(cb).can, cb.probe.can, cb.probe.native]).toEqual([true, ["read", "trade"], { call: "GET /api/v3/brokerage/key_permissions", can_view: true, can_trade: true, can_transfer: false, portfolio_type: "DEFAULT" }]);
    const noTrade = await connect(standIn("coinbase", { v3PrivateGetBrokerageKeyPermissions: async () => ({ can_view: true, can_trade: false, can_transfer: true }) }));
    expect([trader(noTrade).can, noTrade.probe.can]).toEqual([false, ["read", "transfer (send and withdraw)"]]);
    const ku = await connect(standIn("kucoin", { privateGetUserApiKey: async () => ({ code: "200000", data: { remark: "No ip", apiKey: "made-up-key-0002", apiVersion: 3, permission: "General,Spot,InnerTransfer", isMaster: true } }) }));
    expect([trader(ku).can, ku.probe.can, trader(ku).what]).toEqual([true, ["read", "trade spot", "move between its own accounts"], "spot"]);
    const kr = await connect(standIn("kraken"));
    expect([trader(kr).can, trader(kr).what]).toEqual(["unknown", "spot"]);
  });

  it("a permission call that fails leaves it unknown and the connection goes on; a refused key still stops it", async () => {
    class Thrown extends Error {
      constructor(name: string, message: string) {
        super(message);
        this.name = name;
      }
    }
    const failing = await connect(
      standIn("bybit", {
        async privateGetV5UserQueryApi() {
          throw new Thrown("BadRequest", 'bybit {"retCode":10001,"retMsg":"params error"}');
        },
      }),
    );
    expect([trader(failing).can, failing.probe.can, failing.probe.note]).toEqual(["unknown", [], "the exchange did not answer what the key may do (GET /v5/user/query-api): its first refusal will"]);
    expect(failing.probe.native).toEqual({ call: "GET /v5/user/query-api", failed: { error: "BadRequest", said: 'bybit {"retCode":10001,"retMsg":"params error"}' } });
    const refused = await exchangeSource({
      venue: "coinbase",
      exchangeId: "coinbase",
      label: "",
      reference: "credentials/coinbase/api-key.json",
      key: { apiKey: "made-up-key-0002", secret: "made-up-secret-0002" },
      open: async () =>
        standIn("coinbase", {
          async v3PrivateGetBrokerageKeyPermissions() {
            throw new Thrown("AuthenticationError", "coinbase 401 Unauthorized made-up-secret-0002");
          },
        }),
    });
    const r = said(refused, ["made-up-secret-0002"]);
    expect(r.code).toBe("E_VENUE_UNAUTHORIZED");
  });
});

describe("the markets it lists", () => {
  it("dollar markets only — spot, linear perpetuals and futures — the well-known ones first; nothing priced in a coin, no inverse, no option, nothing halted", async () => {
    const { t, seen } = okx();
    const all = ok(await t.markets(""));
    expect(all.map((m) => m.symbol)).toEqual(["BTC/USDT", "BTC/USDT:USDT", "BTC/USDT:USDT-261225", "ETH/USDT", "AAVE/USDC"]);
    expect(all.map((m) => m.name)).toEqual(["BTC/USDT spot", "BTC/USDT perpetual", "BTC/USDT future to 2026-12-25", "ETH/USDT spot", "AAVE/USDC spot"]);
    expect(ok(await t.markets("eth")).map((m) => m.symbol)).toEqual(["ETH/USDT"]);
    expect(ok(await t.markets("perp")).map((m) => m.symbol)).toEqual(["BTC/USDT:USDT"]);
    expect(seen).toEqual([]);
    expect(t.what).toBe("spot and perpetuals");
  });

  it("at most twenty, from a list kept five minutes: the library is asked to reload it only after that", async () => {
    const many = Array.from({ length: 30 }, (_, i) => spot(`C${i}-USDT`, `C${String(i).padStart(2, "0")}`, "USDT"));
    const v = venue("okx", OKX, many);
    const reloads: boolean[] = [];
    const load = v.x.loadMarkets!.bind(v.x);
    v.x.loadMarkets = async (reload?: boolean) => {
      reloads.push(Boolean(reload));
      return load(false);
    };
    let clock = NOW;
    const t = exchangeTrader(v.x, "okx", "OKX", [], { can: ["trade"] }, { now: () => clock });
    expect(ok(await t.markets("")).length).toBe(20);
    expect(ok(await t.markets("C2")).map((m) => m.symbol)).toEqual(["C20/USDT", "C21/USDT", "C22/USDT", "C23/USDT", "C24/USDT", "C25/USDT", "C26/USDT", "C27/USDT", "C28/USDT", "C29/USDT"]);
    clock += 4 * 60_000;
    await t.markets("");
    expect(reloads).toEqual([false]);
    clock += 2 * 60_000;
    await t.markets("");
    expect(reloads).toEqual([false, true]);
  });
});

describe("one market, with a fresh price", () => {
  it("OKX spot: the ticker's last, bid and ask; steps from the market's precision (a step, TICK_SIZE), the smallest size; open; what it takes", async () => {
    const { t, seen, answer } = okx();
    answer(okxTicker);
    const m = ok(await t.market("btc/usdt"));
    // stops are OKX's trigger orders; the times in force and post-only the library lists for OKX spot, and the ones each type takes (a market
    // order never gtc, a stop gtc only, and in spot the order a stop places rests until canceled); a cash account sells only what it holds
    expect(m).toEqual({ symbol: "BTC/USDT", name: "BTC/USDT spot", kind: "spot", base: "BTC", quote: "USDT", price: 85573.7, bid: 85573.7, ask: 85573.8, minQty: 0.00001, qtyStep: 1e-8, priceStep: 0.1, open: true, types: ["market", "limit", "stop", "stop_limit"], tifs: ["gtc", "ioc", "fok"], tifsByType: { market: ["ioc", "fok"], stop: ["gtc"], stop_limit: ["gtc"] }, postOnly: true, sellsReduce: true } satisfies Market);
    expect(seen.map((r) => `${r.method} ${r.url}`)).toEqual(["GET https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT"]);
  });

  it("an OKX perpetual is sized in contracts: the contract's size, its step and smallest size in contracts", async () => {
    const { t, answer } = okx();
    answer({ body: { code: "0", msg: "", data: [{ instType: "SWAP", instId: "BTC-USDT-SWAP", last: "85580.1", askPx: "85580.2", bidPx: "85580.1", ts: "1791225482263" }] } });
    const m = ok(await t.market("BTC/USDT:USDT"));
    expect([m.kind, m.name, m.contractSize, m.qtyStep, m.minQty, m.priceStep, m.price]).toEqual(["perp", "BTC/USDT perpetual", 0.01, 0.01, 0.01, 0.1, 85580.1]);
  });

  it("Coinbase's own flags: limit-only takes limit orders, cancel-only takes none; a market buy there is said to go as a limit order", async () => {
    const { t, answer } = coinbase();
    const tick = { body: { trades: [{ trade_id: "1", product_id: "X", price: "150.12", size: "1", time: "2026-10-05T19:53:19Z", side: "SELL", bid: "", ask: "", exchange: "coinbase" }], best_bid: "150.11", best_ask: "150.13" } };
    answer(tick, tick, tick);
    const sol = ok(await t.market("SOL/USD"));
    expect([sol.open, sol.types, sol.note, sol.qtyStep, sol.priceStep]).toEqual([true, ["limit"], "Coinbase takes only limit orders in SOL/USD now", 0.001, 0.01]);
    const doge = ok(await t.market("DOGE/USD"));
    expect([doge.open, doge.note]).toEqual([false, "Coinbase takes only cancellations in DOGE/USD now"]);
    const btc = ok(await t.market("BTC/USD"));
    expect([btc.open, btc.types, btc.minNotional, btc.note]).toEqual([true, ["market", "limit", "stop", "stop_limit"], 1, "Coinbase takes a market buy only by what it costs: a market buy here goes as a limit order at its worst price, filled at once"]);
  });

  it("Binance: a market at a break is closed in its own word; its own list of order types; Kraken's tick size, and its limit-only mode", async () => {
    const b = binance();
    b.answer({ body: { symbol: "PAXGUSDT", lastPrice: "2650.10", bidPrice: "2650.00", askPrice: "2650.20" } }, { body: { symbol: "XYZUSDT", lastPrice: "0.5", bidPrice: "0.4999", askPrice: "0.5001" } });
    const paxg = ok(await b.t.market("PAXG/USDT"));
    expect([paxg.open, paxg.note, paxg.minNotional]).toEqual([false, "Binance is not trading PAXG/USDT now (it says: BREAK)", undefined]);
    expect(ok(await b.t.market("XYZ/USDT")).types).toEqual(["limit"]);
    const k = kraken();
    k.answer({ body: { error: [], result: { CELRUSD: { a: ["0.012346", "1", "1"], b: ["0.012340", "1", "1"], c: ["0.012345", "1"] } } } }, { body: { error: [], result: { XETHZUSD: { a: ["2500.01", "1", "1"], b: ["2500.00", "1", "1"], c: ["2500.00", "1"] } } } });
    const celr = ok(await k.t.market("CELR/USD"));
    expect([celr.priceStep, celr.minQty, celr.minNotional]).toEqual([0.000001, 50, 0.5]);
    const eth = ok(await k.t.market("ETH/USD"));
    expect([eth.open, eth.types, eth.note]).toEqual([true, ["limit"], "Kraken has ETH/USD in limit-only mode: limit orders only"]);
    // the library counts only "online" pairs as active; a limit-only pair still takes orders, so it is offered
    expect(ok(await k.t.markets("")).map((m) => m.symbol)).toEqual(["BTC/USD", "ETH/USD", "CELR/USD"]);
    // a product that takes only cancellations is not
    expect(ok(await coinbase().t.markets("")).map((m) => m.symbol)).toEqual(["BTC/USD", "SOL/USD"]);
  });

  it("an exchange that counts decimal places: the step is ten to the minus that many", async () => {
    const x = {
      id: "someex",
      precisionMode: 2,
      markets: { "BTC/USDT": spot("BTCUSDT", "BTC", "USDT", { precision: { amount: 4, price: 2 } }) },
      async loadMarkets() {},
      async fetchBalance() {
        return {};
      },
      async fetchTicker() {
        return { last: 85000.12, bid: 85000.1, ask: 85000.2 };
      },
    } satisfies ExchangeClient;
    const m = ok(await exchangeTrader(x, "someex", "Someex", [], { can: [] }).market("BTC/USDT"));
    expect([m.qtyStep, m.priceStep, m.price]).toEqual([0.0001, 0.01, 85000.12]);
  });

  it("refused without a request: priced in a coin, an inverse contract, a market it does not list, perpetuals the key may not trade", async () => {
    const { t, seen } = okx();
    const coin = said(await t.market("ETH/BTC"), ALL_SECRETS);
    expect([coin.code, coin.message]).toEqual(["E_ACCOUNT_UNPRICED", "ETH/BTC is priced in BTC: the account trades markets priced in dollars, so that every limit means dollars"]);
    expect(said(await t.market("BTC/USD:BTC"), ALL_SECRETS).code).toBe("E_ACCOUNT_UNPRICED");
    const option = said(await t.market("BTC/USD:BTC-261225-90000-C"), ALL_SECRETS);
    expect([option.code, option.message]).toEqual(["E_VENUE_REJECTED", "BTC/USD:BTC-261225-90000-C is an option at OKX: the account trades spot markets and linear perpetuals and futures"]);
    const none = said(await t.market("NOPE/USDT"), ALL_SECRETS);
    expect([none.code, none.message]).toEqual(["E_VENUE_REJECTED", 'OKX lists no market "NOPE/USDT": a market is named as the library names it, BTC/USDT for spot or BTC/USDT:USDT for the perpetual']);
    expect(seen).toEqual([]);
    const spotOnly = binance(["read", "trade spot and margin"]);
    const perp = said(await spotOnly.t.market("BTC/USDT:USDT"), ALL_SECRETS);
    expect([perp.code, perp.message]).toEqual(["E_VENUE_PERMISSION", "Binance: this key may not trade perpetuals and futures (the exchange says it can: read, trade spot and margin). That is set on the key at the exchange"]);
    expect(spotOnly.t.can).toBe(true);
    expect(ok(await spotOnly.t.markets("")).map((m) => m.symbol)).toEqual(["BTC/USDT", "XYZ/USDT"]);
  });
});

describe("an order, as the library sends it", () => {
  it("OKX limit buy: POST /api/v5/trade/batch-orders, base size, the account's id as clOrdId, signed; then GET /api/v5/trade/order", async () => {
    const { t, seen, answer } = okx();
    answer(okxAck(), okxOrder("live", "0", ""));
    const s = ok(await t.place({ symbol: "BTC/USDT", side: "buy", type: "limit", qty: 0.001, limitPrice: 60000, clientId: CID }));
    expect(seen.map((r) => `${r.method} ${r.url}`)).toEqual(["POST https://www.okx.com/api/v5/trade/batch-orders", `GET https://www.okx.com/api/v5/trade/order?instId=BTC-USDT&ordId=${OKX_ORD}`]);
    expect(okxSigned(seen[0]!, "/api/v5/trade/batch-orders")).toEqual([{ instId: "BTC-USDT", side: "buy", ordType: "limit", sz: "0.001", tdMode: "cash", tgtCcy: "base_ccy", px: "60000", clOrdId: CID }]);
    okxSigned(seen[1]!, `/api/v5/trade/order?instId=BTC-USDT&ordId=${OKX_ORD}`);
    expect(s).toMatchObject({ ref: OKX_ORD, status: "open", filledQty: 0 } satisfies Partial<OrderState>);
    expect(s.native).toMatchObject({ clientOrderId: CID, venueStatus: "live" });
  });

  it("OKX market buy and sell: sized in BTC with no price, and banAmend so OKX does not cut the size to the balance", async () => {
    const { t, seen, answer } = okx();
    answer(okxAck(), okxOrder("filled", "0.001", "85580.2", { ordType: "market", px: "" }), okxAck(), okxOrder("filled", "0.001", "85570", { ordType: "market", px: "", side: "sell", fee: "-0.0855", feeCcy: "USDT" }));
    const buy = ok(await t.place({ symbol: "BTC/USDT", side: "buy", type: "market", qty: 0.001, clientId: CID }));
    expect(okxSigned(seen[0]!, "/api/v5/trade/batch-orders")).toEqual([{ instId: "BTC-USDT", side: "buy", ordType: "market", sz: "0.001", tdMode: "cash", tgtCcy: "base_ccy", clOrdId: CID, banAmend: true }]);
    // the fee was paid in BTC: it is not counted as dollars
    expect([buy.status, buy.filledQty, buy.avgPrice, buy.feeUsd]).toEqual(["filled", 0.001, 85580.2, undefined]);
    const sell = ok(await t.place({ symbol: "BTC/USDT", side: "sell", type: "market", qty: 0.001, clientId: CID }));
    expect(okxSigned(seen[2]!, "/api/v5/trade/batch-orders")).toEqual([{ instId: "BTC-USDT", side: "sell", ordType: "market", sz: "0.001", tdMode: "cash", tgtCcy: "base_ccy", clOrdId: CID, banAmend: true }]);
    expect([sell.status, sell.avgPrice, sell.feeUsd]).toEqual(["filled", 85570, 0.0855]);
  });

  it("an OKX perpetual: one contract, cross margin, no banAmend (a spot rule)", async () => {
    const { t, seen, answer } = okx();
    answer(okxAck(), okxOrder("filled", "1", "85580.2", { instId: "BTC-USDT-SWAP", instType: "SWAP", ordType: "market", sz: "1", fee: "-0.4279", feeCcy: "USDT" }));
    const s = ok(await t.place({ symbol: "BTC/USDT:USDT", side: "buy", type: "market", qty: 1, clientId: CID }));
    expect(okxSigned(seen[0]!, "/api/v5/trade/batch-orders")).toEqual([{ instId: "BTC-USDT-SWAP", side: "buy", ordType: "market", sz: "1", tdMode: "cross", clOrdId: CID }]);
    expect([s.status, s.filledQty, s.avgPrice, s.feeUsd]).toEqual(["filled", 1, 85580.2, 0.4279]);
  });

  it("Binance market buy: quantity in BTC and no price (a price would turn it into dollars to spend), newClientOrderId, HMAC-signed", async () => {
    const { t, seen, answer } = binance();
    answer(binOrder("FILLED", "0.00100000", "85.57370000", { type: "MARKET", price: "0.00000000", fills: [{ price: "85573.70000000", qty: "0.00100000", commission: "0.00000100", commissionAsset: "BTC", tradeId: 56 }] }), binOrder("FILLED", "0.00100000", "85.57370000", { type: "MARKET", price: "0.00000000" }));
    const s = ok(await t.place({ symbol: "BTC/USDT", side: "buy", type: "market", qty: 0.001, clientId: CID }));
    const r = seen[0]!;
    expect([r.method, r.url, r.headers["X-MBX-APIKEY"]]).toEqual(["POST", "https://api.binance.com/api/v3/order", BINANCE.apiKey]);
    const body = r.body!;
    const [unsigned, signature] = body.split("&signature=");
    expect(signature).toBe(hmac("sha256", BINANCE.secret, unsigned!, "hex"));
    expect(form(unsigned)).toEqual({ timestamp: String(NOW), symbol: "BTCUSDT", side: "BUY", newClientOrderId: CID, newOrderRespType: "FULL", type: "MARKET", quantity: "0.001", recvWindow: "10000" });
    expect(seen[1]!.url).toMatch(new RegExp(`^https://api\\.binance\\.com/api/v3/order\\?timestamp=${NOW}&symbol=BTCUSDT&orderId=28&recvWindow=10000&signature=[0-9a-f]{64}$`));
    expect([s.ref, s.status, s.filledQty, s.avgPrice, s.feeUsd]).toEqual(["28", "filled", 0.001, 85573.7, undefined]);
  });

  it("Binance market sell: quantity, no quoteOrderQty; the fee in USDT from the order's own fills, which its fetchOrder does not carry", async () => {
    const { t, seen, answer } = binance();
    answer(binOrder("FILLED", "0.00100000", "85.57370000", { type: "MARKET", side: "SELL", price: "0.00000000", fills: [{ price: "85573.70000000", qty: "0.00100000", commission: "0.08557370", commissionAsset: "USDT", tradeId: 57 }] }), binOrder("FILLED", "0.00100000", "85.57370000", { type: "MARKET", side: "SELL", price: "0.00000000" }));
    const s = ok(await t.place({ symbol: "BTC/USDT", side: "sell", type: "market", qty: 0.001, clientId: CID }));
    const f = form(seen[0]!.body);
    expect([f.side, f.type, f.quantity, f.quoteOrderQty, f.price]).toEqual(["SELL", "MARKET", "0.001", undefined, undefined]);
    expect([s.status, s.feeUsd]).toEqual(["filled", 0.0855737]);
  });

  it("a market order with a worst price goes as a limit order at that price, filled at once (IOC); a buy's price down to the tick", async () => {
    const { t, seen, answer } = binance();
    answer(binOrder("FILLED", "0.00100000", "85.57370000", { timeInForce: "IOC" }), binOrder("FILLED", "0.00100000", "85.57370000", { timeInForce: "IOC" }));
    const s = ok(await t.place({ symbol: "BTC/USDT", side: "buy", type: "market", qty: 0.001, worstPrice: 87285.229, clientId: CID }));
    const f = form(seen[0]!.body!.split("&signature=")[0]);
    expect([f.type, f.timeInForce, f.price, f.quantity, f.quoteOrderQty]).toEqual(["LIMIT", "IOC", "87285.22", "0.001", undefined]);
    expect(s.native).toMatchObject({ sentAs: "a limit order at 87285.22 that fills at once (IOC): a market order kept inside its worst price" });
  });

  it("a sell's worst price goes up to the tick, never looser: at OKX the order is ordType ioc at that price, and no banAmend (a market-order rule)", async () => {
    const { t, seen, answer } = okx();
    answer(okxAck(), okxOrder("filled", "0.001", "85570.3", { ordType: "ioc", side: "sell", px: "85000.1" }));
    const s = ok(await t.place({ symbol: "BTC/USDT", side: "sell", type: "market", qty: 0.001, worstPrice: 85000.04, clientId: CID }));
    expect(okxSigned(seen[0]!, "/api/v5/trade/batch-orders")).toEqual([{ instId: "BTC-USDT", side: "sell", ordType: "ioc", sz: "0.001", tdMode: "cash", tgtCcy: "base_ccy", px: "85000.1", clOrdId: CID }]);
    expect([s.status, s.avgPrice]).toEqual(["filled", 85570.3]);
  });

  it("Bybit, a unified account: a market buy is sized in the coin (marketUnit baseCoin), the id as orderLinkId; a closed order is found in its history", async () => {
    const { t, seen, answer } = bybit(true);
    answer({ body: { retCode: 0, retMsg: "OK", result: { orderId: BYBIT_ORD, orderLinkId: CID }, retExtInfo: {}, time: 1791230000123 } }, bybitList([]), bybitList([bybitRow("PartiallyFilledCanceled", "0.0004", "34.232", "85580", { orderType: "Market", marketUnit: "baseCoin" })]));
    const s = ok(await t.place({ symbol: "BTC/USDT", side: "buy", type: "market", qty: 0.001, clientId: CID }));
    const r = seen[0]!;
    expect([r.method, r.url]).toEqual(["POST", "https://api.bybit.com/v5/order/create"]);
    expect(JSON.parse(r.body!)).toEqual({ symbol: "BTCUSDT", side: "Buy", orderType: "Market", orderLinkId: CID, category: "spot", marketUnit: "baseCoin", qty: "0.001" });
    expect([r.headers["X-BAPI-API-KEY"], r.headers["X-BAPI-TIMESTAMP"], r.headers["X-BAPI-RECV-WINDOW"]]).toEqual([BYBIT.apiKey, String(NOW), "5000"]);
    expect(r.headers["X-BAPI-SIGN"]).toBe(hmac("sha256", BYBIT.secret, `${NOW}${BYBIT.apiKey}5000${r.body}`, "hex"));
    expect(seen.slice(1).map((q) => q.url.split("?")[0])).toEqual(["https://api.bybit.com/v5/order/realtime", "https://api.bybit.com/v5/order/history"]);
    expect(seen[1]!.url).toContain(`orderId=${BYBIT_ORD}`);
    expect(seen[2]!.url).toContain(`orderId=${BYBIT_ORD}`);
    // Bybit closes a partly filled spot order: what filled says it was canceled with 0.0004 of 0.001 filled
    expect([s.status, s.filledQty, s.avgPrice]).toEqual(["canceled", 0.0004, 85580]);
  });

  it("Bybit, a classic account: a market buy there is read as USDT to spend, so it is refused and nothing is sent", async () => {
    const { t, seen } = bybit(false);
    const r = said(await t.place({ symbol: "BTC/USDT", side: "buy", type: "market", qty: 0.001, clientId: CID }), ALL_SECRETS);
    expect([r.code, r.message]).toEqual(["E_VENUE_ORDER_INVALID", "Bybit: on a classic Bybit account a market buy is sized in USDT to spend, not in BTC to get: give the order a worst price (it then goes as a limit order filled at once), or place a limit order"]);
    expect(seen).toEqual([]);
  });

  it("Coinbase: the account's id as client_order_id (the library would drop clientOrderId), a JWT signed with the key; a market sell by base size", async () => {
    const { t, seen, answer } = coinbase();
    answer(cbAck(), cbOrder("OPEN", "0", "0", "0"), cbAck("SELL"), cbOrder("FILLED", "0.001", "85597.86", "0.51", { side: "SELL", order_type: "MARKET", order_configuration: { market_market_ioc: { base_size: "0.001" } } }));
    const lim = ok(await t.place({ symbol: "BTC/USD", side: "buy", type: "limit", qty: 0.001, limitPrice: 60000, clientId: CID }));
    const r = seen[0]!;
    expect([r.method, r.url]).toEqual(["POST", "https://api.coinbase.com/api/v3/brokerage/orders"]);
    expect(JSON.parse(r.body!)).toEqual({ client_order_id: CID, product_id: "BTC-USD", side: "BUY", order_configuration: { limit_limit_gtc: { base_size: "0.001", limit_price: "60000", post_only: false } } });
    const [h, p, sig] = r.headers.Authorization!.replace("Bearer ", "").split(".");
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toMatchObject({ alg: "ES256", kid: COINBASE.apiKey });
    expect(JSON.parse(Buffer.from(p!, "base64url").toString())).toMatchObject({ sub: COINBASE.apiKey, uri: "POST api.coinbase.com/api/v3/brokerage/orders", nbf: Math.floor(NOW / 1000), exp: Math.floor(NOW / 1000) + 120 });
    expect(verify("sha256", Buffer.from(`${h}.${p}`), { key: createPublicKey(COINBASE.secret), dsaEncoding: "ieee-p1363" }, Buffer.from(sig!, "base64url"))).toBe(true);
    expect(seen[1]!.url).toBe(`https://api.coinbase.com/api/v3/brokerage/orders/historical/${CB_ORD}`);
    expect([lim.status, lim.ref]).toEqual(["open", CB_ORD]);
    const sell = ok(await t.place({ symbol: "BTC/USD", side: "sell", type: "market", qty: 0.001, clientId: CID }));
    expect(JSON.parse(seen[2]!.body!)).toEqual({ client_order_id: CID, product_id: "BTC-USD", side: "SELL", order_configuration: { market_market_ioc: { base_size: "0.001" } } });
    expect([sell.status, sell.avgPrice, sell.feeUsd]).toEqual(["filled", 85597.86, 0.51]);
  });

  it("Coinbase sizes a market buy only in dollars: without a worst price it is refused; with one it goes as sor_limit_ioc, in BTC", async () => {
    const { t, seen, answer } = coinbase();
    const plainBuy = said(await t.place({ symbol: "BTC/USD", side: "buy", type: "market", qty: 0.001, clientId: CID }), ALL_SECRETS);
    expect([plainBuy.code, seen.length]).toEqual(["E_VENUE_ORDER_INVALID", 0]);
    answer(cbAck(), cbOrder("FILLED", "0.001", "85597.87", "0.51", { order_configuration: { sor_limit_ioc: { base_size: "0.001", limit_price: "87309.82" } }, time_in_force: "IMMEDIATE_OR_CANCEL" }));
    const s = ok(await t.place({ symbol: "BTC/USD", side: "buy", type: "market", qty: 0.001, worstPrice: 87309.8274, clientId: CID }));
    expect(JSON.parse(seen[0]!.body!)).toEqual({ client_order_id: CID, product_id: "BTC-USD", side: "BUY", order_configuration: { sor_limit_ioc: { base_size: "0.001", limit_price: "87309.82" } } });
    expect([s.status, s.filledQty, s.feeUsd]).toEqual(["filled", 0.001, 0.51]);
  });

  it("Kraken limit buy: AddOrder with the id as cl_ord_id (a short UUID), signed with HMAC-SHA512; then QueryOrders", async () => {
    const { t, seen, answer } = kraken();
    answer({ body: { error: [], result: { descr: { order: "buy 0.00100000 XBTUSD @ limit 60000.0" }, txid: [KR_ORD] } } }, krQuery("open", "0.00000000", "0.00000", "0.00000", "0.0"));
    const s = ok(await t.place({ symbol: "BTC/USD", side: "buy", type: "limit", qty: 0.001, limitPrice: 60000, clientId: CID }));
    const r = seen[0]!;
    expect([r.method, r.url, r.headers["API-Key"]]).toEqual(["POST", "https://api.kraken.com/0/private/AddOrder", KRAKEN.apiKey]);
    expect(form(r.body)).toEqual({ nonce: String(NOW), pair: "XXBTZUSD", type: "buy", ordertype: "limit", volume: "0.001", cl_ord_id: CID, price: "60000" });
    const digest = createHash("sha256").update(`${NOW}${r.body}`).digest();
    expect(r.headers["API-Sign"]).toBe(hmac("sha512", Buffer.from(KRAKEN.secret, "base64"), Buffer.concat([Buffer.from("/0/private/AddOrder"), digest]), "base64"));
    expect([seen[1]!.url, form(seen[1]!.body).txid]).toEqual(["https://api.kraken.com/0/private/QueryOrders", KR_ORD]);
    expect([s.ref, s.status]).toEqual([KR_ORD, "open"]);
  });

  it("checked before anything is sent: a size off the step, under the smallest, a price off the tick, a worth under the smallest", async () => {
    const { t, seen } = binance();
    const off = said(await t.place({ symbol: "BTC/USDT", side: "buy", type: "limit", qty: 0.000015, limitPrice: 60000, clientId: CID }), ALL_SECRETS);
    expect([off.code, off.message]).toEqual(["E_VENUE_ORDER_INVALID", "Binance: a size in BTC/USDT moves in steps of 0.00001: 0.000015 would go as 0.00001"]);
    const tick = said(await t.place({ symbol: "BTC/USDT", side: "buy", type: "limit", qty: 0.001, limitPrice: 60000.005, clientId: CID }), ALL_SECRETS);
    expect(tick.message).toBe("Binance: a price in BTC/USDT moves in steps of 0.01: 60000.005 would go as 60000.01");
    const worth = said(await t.place({ symbol: "BTC/USDT", side: "buy", type: "limit", qty: 0.00002, limitPrice: 60000, clientId: CID }), ALL_SECRETS);
    expect(worth.message).toBe("Binance: the smallest order in BTC/USDT spot is worth 5 USDT");
    const k = kraken();
    const small = said(await k.t.place({ symbol: "CELR/USD", side: "buy", type: "limit", qty: 10, limitPrice: 0.012345, clientId: CID }), ALL_SECRETS);
    expect(small.message).toBe("Kraken: the smallest order in CELR/USD spot is 50 CELR");
    // on CELR/USD the library would send 0.0123451 as it is (7 decimals); Kraken ticks in 0.000001 and would refuse it
    const offTick = said(await k.t.place({ symbol: "CELR/USD", side: "buy", type: "limit", qty: 100, limitPrice: 0.0123451, clientId: CID }), ALL_SECRETS);
    expect(offTick.message).toBe("Kraken: a price in CELR/USD moves in steps of 0.000001");
    expect([seen.length, k.seen.length]).toEqual([0, 0]);
  });

  it("an order call that does not come back is looked up by the account's id before anything is said", async () => {
    class Timeout extends Error {
      override name = "RequestTimeout";
    }
    const found = okx();
    found.answer(new Timeout("okx POST https://www.okx.com/api/v5/trade/batch-orders request timed out (12000 ms)"), okxOrder("live", "0", ""));
    const s = ok(await found.t.place({ symbol: "BTC/USDT", side: "buy", type: "limit", qty: 0.001, limitPrice: 60000, clientId: CID }));
    expect([s.status, s.ref, found.seen[1]!.url]).toEqual(["open", OKX_ORD, `https://www.okx.com/api/v5/trade/order?instId=BTC-USDT&clOrdId=${CID}`]);
    const none = okx();
    none.answer(new Timeout("okx request timed out"), { body: { code: "51603", msg: "Order does not exist", data: [] } });
    const r = said(await none.t.place({ symbol: "BTC/USDT", side: "buy", type: "limit", qty: 0.001, limitPrice: 60000, clientId: CID }), ALL_SECRETS);
    expect([r.code, r.message]).toEqual(["E_VENUE_UNREACHABLE", `OKX did not confirm the order, and shows none under the account's id ${CID} now: look at its open orders before placing it again`]);
    // Coinbase cannot be asked by the account's id through the library: it is said that the order may or may not be there
    const cb = coinbase();
    cb.answer(new Timeout("coinbase request timed out"));
    const u = said(await cb.t.place({ symbol: "BTC/USD", side: "sell", type: "market", qty: 0.001, clientId: CID }), ALL_SECRETS);
    expect([u.code, u.message, cb.seen.length]).toEqual(["E_VENUE_UNREACHABLE", `Coinbase did not confirm the order: it may or may not have been placed. Look at its open orders before placing it again (the account's id for it: ${CID})`, 1]);
  });
});

describe("what became of it", () => {
  const okxStatus = async (state: string, acc: string, avg: string): Promise<OrderState> => {
    const { t, answer } = okx();
    answer(okxOrder(state, acc, avg));
    return ok(await t.status(OKX_ORD, "BTC/USDT"));
  };
  it("OKX: live, partly filled, filled, canceled (with what had filled), canceled by its market-maker protection", async () => {
    expect([(await okxStatus("live", "0", "")).status]).toEqual(["open"]);
    const part = await okxStatus("partially_filled", "0.0004", "59990.5");
    expect([part.status, part.filledQty, part.avgPrice]).toEqual(["partial", 0.0004, 59990.5]);
    expect((await okxStatus("filled", "0.001", "59995.2")).status).toBe("filled");
    const canceled = await okxStatus("canceled", "0.0004", "59990.5");
    expect([canceled.status, canceled.filledQty]).toEqual(["canceled", 0.0004]);
    expect((await okxStatus("mmp_canceled", "0", "")).status).toBe("canceled");
  });

  it("Binance: every status it has, from what filled — an expired market order may have filled in part", async () => {
    const cases: Array<[string, string, string, string, number]> = [
      ["NEW", "0.00000000", "0.00000000", "open", 0],
      ["PENDING_NEW", "0.00000000", "0.00000000", "pending", 0],
      ["PARTIALLY_FILLED", "0.00040000", "23.99600000", "partial", 0.0004],
      ["FILLED", "0.00100000", "59.99000000", "filled", 0.001],
      ["CANCELED", "0.00040000", "23.99600000", "canceled", 0.0004],
      ["PENDING_CANCEL", "0.00040000", "23.99600000", "partial", 0.0004],
      ["EXPIRED", "0.00060000", "51.34422000", "expired", 0.0006],
      ["EXPIRED_IN_MATCH", "0.00000000", "0.00000000", "expired", 0],
      ["REJECTED", "0.00000000", "0.00000000", "rejected", 0],
    ];
    for (const [word, exec, quote, want, filled] of cases) {
      const { t, seen, answer } = binance();
      answer(binOrder(word, exec, quote));
      const s = ok(await t.status("28", "BTC/USDT"));
      expect([word, s.status, s.filledQty]).toEqual([word, want, filled]);
      expect(seen[0]!.url).toContain("/api/v3/order?");
    }
    const { t, answer } = binance();
    answer(binOrder("PARTIALLY_FILLED", "0.00040000", "23.99600000"));
    expect(ok(await t.status("28", "BTC/USDT")).avgPrice).toBe(59990);
  });

  it("Bybit: open orders by realtime, the rest by history; every status, with its fee in BTC not counted as dollars", async () => {
    const cases: Array<[string, string, string, string, number]> = [
      ["New", "0", "0", "open", 0],
      ["PartiallyFilled", "0.0004", "23.996", "partial", 0.0004],
      ["Untriggered", "0", "0", "open", 0],
    ];
    for (const [word, qty, value, want, filled] of cases) {
      const { t, answer } = bybit(true);
      answer(bybitList([bybitRow(word, qty, value, qty === "0" ? "" : "59990")]));
      const s = ok(await t.status(BYBIT_ORD, "BTC/USDT"));
      expect([word, s.status, s.filledQty, s.feeUsd]).toEqual([word, want, filled, undefined]);
    }
    const done: Array<[string, string, string, number]> = [
      ["Filled", "0.001", "filled", 0.001],
      ["Cancelled", "0", "canceled", 0],
      ["Rejected", "0", "rejected", 0],
      ["PartiallyFilledCanceled", "0.0004", "canceled", 0.0004],
      ["Deactivated", "0", "canceled", 0],
    ];
    for (const [word, qty, want, filled] of done) {
      const { t, seen, answer } = bybit(true);
      answer(bybitList([]), bybitList([bybitRow(word, qty, String(Number(qty) * 59990), qty === "0" ? "" : "59990")]));
      const s = ok(await t.status(BYBIT_ORD, "BTC/USDT"));
      expect([word, s.status, s.filledQty]).toEqual([word, want, filled]);
      expect(seen.map((r) => r.url.split("?")[0])).toEqual(["https://api.bybit.com/v5/order/realtime", "https://api.bybit.com/v5/order/history"]);
    }
  });

  it("Coinbase: pending and queued are taken, not settled; open, filled, canceled, expired and failed; its fee in dollars", async () => {
    const cases: Array<[string, string, string]> = [
      ["PENDING", "0", "pending"],
      ["QUEUED", "0", "pending"],
      ["OPEN", "0.0004", "partial"],
      ["FILLED", "0.001", "filled"],
      ["CANCELLED", "0.0004", "canceled"],
      ["EXPIRED", "0", "canceled"],
      ["FAILED", "0", "canceled"],
    ];
    for (const [word, filled, want] of cases) {
      const { t, answer } = coinbase();
      answer(cbOrder(word, filled, filled === "0" ? "0" : "59990", filled === "0" ? "0" : "0.144"));
      const s = ok(await t.status(CB_ORD, "BTC/USD"));
      expect([word, s.status, s.filledQty, s.feeUsd]).toEqual([word, want, Number(filled), filled === "0" ? 0 : 0.144]);
    }
  });

  it("Kraken: open, closed, canceled and expired, by QueryOrders", async () => {
    const cases: Array<[string, string, string]> = [
      ["pending", "0.00000000", "open"],
      ["open", "0.00040000", "partial"],
      ["closed", "0.00100000", "filled"],
      ["canceled", "0.00040000", "canceled"],
      ["expired", "0.00000000", "expired"],
    ];
    for (const [word, exec, want] of cases) {
      const { t, answer } = kraken();
      answer(krQuery(word, exec, String(Number(exec) * 59990), exec === "0.00000000" ? "0" : "0.09598", "59990.0"));
      const s = ok(await t.status(KR_ORD, "BTC/USD"));
      expect([word, s.status, s.filledQty]).toEqual([word, want, Number(exec)]);
    }
  });
});

describe("taking an order off the book", () => {
  it("OKX: POST /api/v5/trade/cancel-order, then the order as it stands — its answer to the cancel is the id alone", async () => {
    const { t, seen, answer } = okx();
    answer({ body: { code: "0", msg: "", data: [{ clOrdId: CID, ordId: OKX_ORD, ts: "1791230000999", sCode: "0", sMsg: "" }] } }, okxOrder("canceled", "0.0004", "59990.5"));
    const s = ok(await t.cancel(OKX_ORD, "BTC/USDT"));
    expect([seen[0]!.method, seen[0]!.url]).toEqual(["POST", "https://www.okx.com/api/v5/trade/cancel-order"]);
    expect(okxSigned(seen[0]!, "/api/v5/trade/cancel-order")).toEqual({ instId: "BTC-USDT", ordId: OKX_ORD });
    expect([s.status, s.filledQty, s.ref]).toEqual(["canceled", 0.0004, OKX_ORD]);
  });

  it("Kraken answers a cancel with a count: the order is asked again", async () => {
    const { t, seen, answer } = kraken();
    answer({ body: { error: [], result: { count: 1 } } }, krQuery("canceled", "0.00000000", "0", "0", "0"));
    const s = ok(await t.cancel(KR_ORD, "BTC/USD"));
    expect([seen[0]!.url, form(seen[0]!.body).txid, seen[1]!.url]).toEqual(["https://api.kraken.com/0/private/CancelOrder", KR_ORD, "https://api.kraken.com/0/private/QueryOrders"]);
    expect([s.status, s.ref]).toEqual(["canceled", KR_ORD]);
  });

  it("a cancel taken whose order cannot then be read is not called canceled: it may have filled, so it stays followed", async () => {
    const { t, seen, answer } = okx();
    answer({ body: { code: "0", msg: "", data: [{ clOrdId: CID, ordId: OKX_ORD, ts: "1791230000999", sCode: "0", sMsg: "" }] } }, new Error("socket hang up"));
    const s = ok(await t.cancel(OKX_ORD, "BTC/USDT"));
    expect([seen.length, s.ref, s.status, DONE.has(s.status)]).toEqual([2, OKX_ORD, "pending", false]);
  });

  it("an order that filled before the cancel reached it comes back filled; one the exchange does not have is the account's unknown order", async () => {
    const filled = okx();
    filled.answer(okxFail("51400", "Order cancellation failed as the order has been filled, canceled or does not exist"), okxOrder("filled", "0.001", "59995.2"));
    expect(ok(await filled.t.cancel(OKX_ORD, "BTC/USDT")).status).toBe("filled");
    const gone = binance();
    gone.answer({ status: 400, body: { code: -2011, msg: "Unknown order sent." } }, { status: 400, body: { code: -2013, msg: "Order does not exist." } });
    const r = said(await gone.t.cancel("29", "BTC/USDT"), ALL_SECRETS);
    expect([r.code, r.message, r.detail]).toEqual(["E_ACCOUNT_ORDER_UNKNOWN", "Binance has no order 29 for this key", { order: "29" }]);
  });
});

describe("what the exchange says no to, in its own words", () => {
  it("not enough balance: OKX 51008, Binance -2010, Coinbase INSUFFICIENT_FUND (which the library files as a plain error)", async () => {
    const o = okx();
    o.answer(okxFail("51008", "Order failed. Insufficient USDT balance in account"));
    const a = said(await o.t.place({ symbol: "BTC/USDT", side: "buy", type: "limit", qty: 0.001, limitPrice: 60000, clientId: CID }), ALL_SECRETS);
    expect([a.code, a.message]).toEqual(["E_VENUE_INSUFFICIENT", "OKX: not enough balance there for this order"]);
    expect(JSON.stringify(a.native)).toContain("51008");
    const b = binance();
    b.answer({ status: 400, body: { code: -2010, msg: "Account has insufficient balance for requested action." } });
    expect(said(await b.t.place({ symbol: "BTC/USDT", side: "buy", type: "market", qty: 0.001, clientId: CID }), ALL_SECRETS).code).toBe("E_VENUE_INSUFFICIENT");
    const c = coinbase();
    c.answer({ body: { success: false, failure_reason: "UNKNOWN_FAILURE_REASON", order_id: "", error_response: { error: "INSUFFICIENT_FUND", message: "Insufficient balance in source account", error_details: "", new_order_failure_reason: "INSUFFICIENT_FUND" }, order_configuration: null } });
    expect(said(await c.t.place({ symbol: "BTC/USD", side: "sell", type: "market", qty: 0.001, clientId: CID }), ALL_SECRETS).code).toBe("E_VENUE_INSUFFICIENT");
  });

  it("a size it does not take: OKX 51020, Binance's NOTIONAL filter (filed by the library as a bad request)", async () => {
    const o = okx();
    o.answer(okxFail("51020", "Your order should meet or exceed the minimum order amount."));
    const a = said(await o.t.place({ symbol: "BTC/USDT", side: "buy", type: "market", qty: 0.00001, clientId: CID }), ALL_SECRETS);
    expect([a.code, a.message]).toEqual(["E_VENUE_ORDER_INVALID", "OKX: it does not take this order as written (its size, step, price or minimum)"]);
    const b = binance();
    b.answer({ status: 400, body: { code: -1013, msg: "Filter failure: NOTIONAL" } });
    expect(said(await b.t.place({ symbol: "BTC/USDT", side: "buy", type: "market", qty: 0.00002, clientId: CID }), ALL_SECRETS).code).toBe("E_VENUE_ORDER_INVALID");
  });

  it("a key without the trading permission: OKX 50120, Bybit 10005, Kraken's invalid permissions", async () => {
    const o = okx();
    o.answer({ body: { code: "50120", msg: "This API key doesn't have permission to use this function", data: [] } });
    expect(said(await o.t.place({ symbol: "BTC/USDT", side: "buy", type: "limit", qty: 0.001, limitPrice: 60000, clientId: CID }), ALL_SECRETS).code).toBe("E_VENUE_PERMISSION");
    const y = bybit(true);
    y.answer({ body: { retCode: 10005, retMsg: "Permission denied, please check your API key permissions.", result: {}, retExtInfo: {}, time: 1 } });
    expect(said(await y.t.place({ symbol: "BTC/USDT", side: "buy", type: "limit", qty: 0.001, limitPrice: 60000, clientId: CID }), ALL_SECRETS).code).toBe("E_VENUE_PERMISSION");
    const k = kraken();
    k.answer({ body: { error: ["EAccount:Invalid permissions"] } });
    expect(said(await k.t.place({ symbol: "BTC/USD", side: "buy", type: "limit", qty: 0.001, limitPrice: 60000, clientId: CID }), ALL_SECRETS).code).toBe("E_VENUE_PERMISSION");
  });

  it("a location the exchange does not serve is its own rule, said as that and nothing more: Binance's 451, OKX 51155", async () => {
    const b = binance();
    b.answer({ status: 451, body: { code: 0, msg: "Service unavailable from a restricted location according to 'b. Eligibility' in https://www.binance.com/en/terms. Please contact customer service if you believe you received this message in error." } });
    const a = said(await b.t.place({ symbol: "BTC/USDT", side: "buy", type: "market", qty: 0.001, clientId: CID }), ALL_SECRETS);
    expect([a.code, a.message]).toEqual(["E_VENUE_GEOBLOCKED", "Binance does not serve this location: that is its own rule, and the account does not look for a way around it"]);
    expect(JSON.stringify(a).toLowerCase()).not.toMatch(/vpn|proxy|testnet|another region/);
    // a 451 is the exchange's answer, not a lost call: nothing is looked up after it
    expect(b.seen.length).toBe(1);
    const o = okx();
    o.answer(okxFail("51155", "You can't trade this pair or borrow this crypto due to local compliance restrictions."));
    expect(said(await o.t.place({ symbol: "BTC/USDT", side: "buy", type: "limit", qty: 0.001, limitPrice: 60000, clientId: CID }), ALL_SECRETS).code).toBe("E_VENUE_GEOBLOCKED");
    // Coinbase's GEOFENCING_RESTRICTION, which the library files as a plain error
    const c = coinbase();
    c.answer({ body: { success: false, failure_reason: "UNKNOWN_FAILURE_REASON", order_id: "", error_response: { error: "UNKNOWN_FAILURE_REASON", message: "", error_details: "", new_order_failure_reason: "GEOFENCING_RESTRICTION" }, order_configuration: null } });
    const g = said(await c.t.place({ symbol: "BTC/USD", side: "sell", type: "market", qty: 0.001, clientId: CID }), ALL_SECRETS);
    expect([g.code, g.message, c.seen.length]).toEqual(["E_VENUE_GEOBLOCKED", "Coinbase does not serve this location: that is its own rule, and the account does not look for a way around it", 1]);
  });

  it("an order it does not have; a market in cancel-only mode; and nothing secret in what is said back", async () => {
    const b = binance();
    b.answer({ status: 400, body: { code: -2013, msg: "Order does not exist." } });
    const r = said(await b.t.status("404", "BTC/USDT"), ALL_SECRETS);
    expect([r.code, r.message]).toEqual(["E_ACCOUNT_ORDER_UNKNOWN", "Binance has no order 404 for this key"]);
    const k = kraken();
    k.answer({ body: { error: ["EService:Market in cancel_only mode"] } });
    expect(said(await k.t.place({ symbol: "BTC/USD", side: "buy", type: "limit", qty: 0.001, limitPrice: 60000, clientId: CID }), ALL_SECRETS).code).toBe("E_VENUE_MARKET_CLOSED");
    const leak = okx();
    leak.answer(new Error(`okx something odd with ${OKX.secret} and ${OKX.password}`));
    const l = said(await leak.t.status(OKX_ORD, "BTC/USDT"), ALL_SECRETS);
    expect(JSON.stringify(l.native)).toContain("•••");
  });
});

// ==================================================================================================================================
// stops, the times in force and flags each market takes, an order changed in place, what is held, and a perpetual's leverage

const OKX_PERP = { ...OKX_MARKETS[5]!, limits: { amount: { min: 0.01 }, cost: {}, price: {}, leverage: { min: 1, max: 100 } } };
/** OKX with its spot pair, a perpetual that says its most leverage, and an inverse perpetual (whose positions the account does not list) */
function okxPerp() {
  const v = venue("okx", OKX, [OKX_MARKETS[0]!, OKX_PERP, OKX_MARKETS[6]!]);
  return { ...v, t: exchangeTrader(v.x, "okx", "OKX", Object.values(OKX), { can: ["read", "trade"] }, { now: () => NOW }) };
}
const BYBIT_PERP = linear("BTCUSDT", "BTC", "USDT", { contractSize: 1, precision: { amount: 0.001, price: 0.1 }, limits: { amount: { min: 0.001 }, cost: { min: 5 }, price: {}, leverage: { min: 1, max: 100 } } });
function bybitBoth(unified = true) {
  const v = venue("bybit", BYBIT, [BYBIT_MARKETS[0]!, BYBIT_PERP], { enableUnifiedAccount: unified, enableUnifiedMargin: false });
  return { ...v, t: exchangeTrader(v.x, "bybit", "Bybit", Object.values(BYBIT), { can: ["read", "trade spot", "trade contracts"] }, { now: () => NOW }) };
}

const OKX_ALGO = "1836487817828872192";
const OKX_CHILD = "312269865356374099";
/** Place algo order (POST /api/v5/trade/order-algo) */
const okxAlgoAck = { body: { code: "0", msg: "", data: [{ algoClOrdId: CID, algoId: OKX_ALGO, clOrdId: "", sCode: "0", sMsg: "", tag: "" }] } };
/** Get algo order details (GET /api/v5/trade/order-algo): a trigger order */
const okxAlgo = (state: string, over: Dict = {}) => ({ body: { code: "0", msg: "", data: [{ instType: "SPOT", instId: "BTC-USDT", ordId: "", ordIdList: [], ccy: "", clOrdId: "", algoId: OKX_ALGO, sz: "0.001", closeFraction: "", ordType: "trigger", side: "sell", posSide: "net", tdMode: "cash", tgtCcy: "", state, lever: "", triggerPx: "80000", triggerPxType: "last", ordPx: "79900", actualSz: "", actualPx: "", actualSide: "", advanceOrdType: "", reduceOnly: "false", triggerTime: "", last: "85573.7", failCode: "", algoClOrdId: CID, cTime: "1791230000123", uTime: "1791230000123", ...over }] } });
const okxSwapTicker = { body: { code: "0", msg: "", data: [{ instType: "SWAP", instId: "BTC-USDT-SWAP", last: "85580.1", askPx: "85580.2", bidPx: "85580.1", ts: "1791225482263" }] } };

const BIN_ALGO = 3358;
const BIN_FUT = 8389765519;
/** New Algo Order / Query Algo Order (USDⓈ-M futures, /fapi/v1/algoOrder) */
const binAlgo = (algoStatus: string, over: Dict = {}) => ({ body: { algoId: BIN_ALGO, clientAlgoId: CID, algoType: "CONDITIONAL", orderType: "STOP", symbol: "BTCUSDT", side: "BUY", positionSide: "BOTH", timeInForce: "FOK", quantity: "0.002", algoStatus, triggerPrice: "90000.0", price: "91000.0", actualOrderId: "", actualPrice: "0.00000", icebergQuantity: null, selfTradePreventionMode: "EXPIRE_MAKER", workingType: "CONTRACT_PRICE", priceMatch: "NONE", closePosition: false, priceProtect: false, reduceOnly: true, createTime: 1791230000123, updateTime: 1791230000123, triggerTime: 0, goodTillDate: 0, ...over } });
/** Query Order (USDⓈ-M futures, GET /fapi/v1/order) */
const binFut = (status: string, executedQty: string, cumQuote: string, over: Dict = {}) => ({ body: { orderId: BIN_FUT, symbol: "BTCUSDT", status, clientOrderId: CID, price: "91000.0", avgPrice: executedQty === "0" ? "0.00" : "90950.0", origQty: "0.002", executedQty, cumQty: executedQty, cumQuote, timeInForce: "GTC", type: "LIMIT", reduceOnly: false, closePosition: false, side: "BUY", positionSide: "BOTH", stopPrice: "0", workingType: "CONTRACT_PRICE", priceProtect: false, origType: "LIMIT", time: 1791230000123, updateTime: 1791230000456, ...over } });

const bybitAck = { body: { retCode: 0, retMsg: "OK", result: { orderId: BYBIT_ORD, orderLinkId: CID }, retExtInfo: {}, time: 1791230000123 } };
const bybitTicker = { body: { retCode: 0, retMsg: "OK", result: { category: "spot", list: [{ symbol: "BTCUSDT", bid1Price: "85573.6", bid1Size: "1", ask1Price: "85573.8", ask1Size: "1", lastPrice: "85573.7", prevPrice24h: "85000", price24hPcnt: "0.0067", highPrice24h: "86000", lowPrice24h: "84000", turnover24h: "1", volume24h: "1" }] }, retExtInfo: {}, time: 1791230000123 } };
const bybitLinearList = (rows: Dict[]) => ({ body: { retCode: 0, retMsg: "OK", result: { nextPageCursor: "", category: "linear", list: rows }, retExtInfo: {}, time: 1791230000500 } });

describe("what each market takes besides market and limit orders", () => {
  it("OKX: stops (its trigger orders) everywhere; on a perpetual reduce-only and its most leverage; a spot sell sells only what is held", async () => {
    const { t, seen } = okxPerp();
    const [spot, perp] = ok(await t.markets("")).filter((m) => m.base === "BTC");
    expect([spot!.types, spot!.tifs, spot!.postOnly, spot!.reduceOnly, spot!.sellsReduce, spot!.maxLeverage]).toEqual([["market", "limit", "stop", "stop_limit"], ["gtc", "ioc", "fok"], true, undefined, true, undefined]);
    expect([perp!.symbol, perp!.types, perp!.tifs, perp!.postOnly, perp!.reduceOnly, perp!.sellsReduce, perp!.maxLeverage]).toEqual(["BTC/USDT:USDT", ["market", "limit", "stop", "stop_limit"], ["gtc", "ioc", "fok"], true, true, undefined, 100]);
    expect(seen).toEqual([]);
  });

  it("Binance by each market's own list of order types: STOP_LOSS_LIMIT for a spot stop, STOP for a futures one, LIMIT_MAKER for post-only", async () => {
    const { t } = binance();
    const all = ok(await t.markets(""));
    const by = (s: string) => all.find((m) => m.symbol === s)!;
    expect([by("BTC/USDT").types, by("BTC/USDT").tifs, by("BTC/USDT").postOnly, by("BTC/USDT").reduceOnly]).toEqual([["market", "limit", "stop", "stop_limit"], ["gtc", "ioc", "fok"], true, undefined]);
    // a market that lists LIMIT and LIMIT_MAKER only: no market order, so no stop
    expect([by("XYZ/USDT").types, by("XYZ/USDT").postOnly]).toEqual([["limit"], true]);
    expect([by("BTC/USDT:USDT").types, by("BTC/USDT:USDT").reduceOnly, by("BTC/USDT:USDT").sellsReduce]).toEqual([["market", "limit", "stop", "stop_limit"], true, undefined]);
  });

  it("Coinbase and Kraken: stop-limits in spot, no reduce-only; a market held to limit orders takes no stop, and one held to post-only no IOC", async () => {
    const c = coinbase();
    const cb = ok(await c.t.markets(""));
    expect(cb.map((m) => [m.symbol, m.types, m.tifs, m.postOnly ?? false, m.reduceOnly ?? false])).toEqual([
      ["BTC/USD", ["market", "limit", "stop", "stop_limit"], ["gtc", "ioc", "fok"], true, false],
      ["SOL/USD", ["limit"], ["gtc", "ioc", "fok"], true, false],
    ]);
    const k = kraken();
    const kr = ok(await k.t.markets(""));
    expect(kr.map((m) => [m.symbol, m.types])).toEqual([
      ["BTC/USD", ["market", "limit", "stop", "stop_limit"]],
      ["ETH/USD", ["limit"]],
      ["CELR/USD", ["market", "limit", "stop", "stop_limit"]],
    ]);
    const post = venue("kraken", KRAKEN, [{ ...KRAKEN_MARKETS[0]!, active: false, info: { altname: "XBTUSD", status: "post_only", tick_size: "0.1" } }]);
    const held = ok(await exchangeTrader(post.x, "kraken", "Kraken", [], { can: [] }, { now: () => NOW }).markets(""));
    expect([held[0]!.types, held[0]!.tifs, held[0]!.postOnly]).toEqual([["limit"], ["gtc"], true]);
  });

  it("an exchange the trader has not checked: market and limit orders as before, the times in force its library lists, nothing more", async () => {
    const x = {
      id: "someex",
      markets: { "BTC/USDT": spot("BTCUSDT", "BTC", "USDT"), "BTC/USDT:USDT": linear("BTCUSDT", "BTC", "USDT") },
      has: { swap: true, editOrder: true, fetchPositions: true, setLeverage: true },
      features: { spot: { createOrder: { timeInForce: { GTC: true, IOC: true, FOK: false, PO: false } } } },
      async loadMarkets() {},
      async fetchBalance() {
        return {};
      },
    } satisfies ExchangeClient;
    const t = exchangeTrader(x, "someex", "Someex", [], { can: [] });
    const [s, p] = ok(await t.markets(""));
    expect([s!.types, s!.tifs, s!.postOnly, s!.sellsReduce, p!.types, p!.tifs, p!.reduceOnly]).toEqual([["market", "limit"], ["gtc", "ioc"], undefined, undefined, ["market", "limit"], undefined, undefined]);
    expect([t.amend, t.positions, t.setLeverage, t.close]).toEqual([undefined, undefined, undefined, undefined]);
  });
});

describe("a stop, as the library sends it", () => {
  it("OKX: a trigger order in its algo book (POST /api/v5/trade/order-algo), the id as algoClOrdId, no tgtCcy (51281); followed as trigger:<algoId>", async () => {
    const { t, seen, answer } = okx();
    answer(okxTicker, okxAlgoAck, okxAlgo("live"));
    const s = ok(await t.place({ symbol: "BTC/USDT", side: "sell", type: "stop_limit", qty: 0.001, stopPrice: 80000, limitPrice: 79900, clientId: CID }));
    // the price first: OKX fires a trigger order when the price crosses it from where it is, so a sell stop must be below it
    expect(seen.map((r) => `${r.method} ${r.url}`)).toEqual(["GET https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT", "POST https://www.okx.com/api/v5/trade/order-algo", `GET https://www.okx.com/api/v5/trade/order-algo?instId=BTC-USDT&algoId=${OKX_ALGO}`]);
    expect(okxSigned(seen[1]!, "/api/v5/trade/order-algo")).toEqual({ instId: "BTC-USDT", side: "sell", ordType: "trigger", sz: "0.001", tdMode: "cash", triggerPx: "80000", orderPx: "79900", clOrdId: CID, algoClOrdId: CID });
    expect([s.ref, s.status, s.filledQty]).toEqual([`trigger:${OKX_ALGO}`, "open", 0]);
    expect(s.native).toMatchObject({ clientOrderId: CID, venueStatus: "live" });
  });

  it("OKX perpetual: a stop with a worst price places a limit order there that fills at once (advanceOrdType ioc), a buy's worst price down to the tick", async () => {
    const { t, seen, answer } = okx();
    answer(okxSwapTicker, okxAlgoAck, okxAlgo("live", { instType: "SWAP", instId: "BTC-USDT-SWAP", sz: "1", side: "buy", tdMode: "cross", triggerPx: "90000", ordPx: "91800", advanceOrdType: "ioc" }));
    const s = ok(await t.place({ symbol: "BTC/USDT:USDT", side: "buy", type: "stop", qty: 1, stopPrice: 90000, worstPrice: 91800.04, clientId: CID }));
    expect(okxSigned(seen[1]!, "/api/v5/trade/order-algo")).toEqual({ instId: "BTC-USDT-SWAP", side: "buy", ordType: "trigger", sz: "1", tdMode: "cross", triggerPx: "90000", orderPx: "91800", clOrdId: CID, algoClOrdId: CID, advanceOrdType: "ioc" });
    expect(s.native).toMatchObject({ sentAs: "a stop at 90000 that places a limit order at 91800, filled at once (IOC): a stop kept inside its worst price" });
  });

  it("OKX refuses before anything is sent: a spot stop buy with no worst price, a reduce-only stop; after the price only: a stop on the wrong side of it", async () => {
    const { t, seen, answer } = okx();
    const buy = said(await t.place({ symbol: "BTC/USDT", side: "buy", type: "stop", qty: 0.001, stopPrice: 90000, clientId: CID }), ALL_SECRETS);
    expect([buy.code, buy.message]).toEqual(["E_VENUE_ORDER_INVALID", "OKX: a stop buy in BTC/USDT spot needs a worst price: OKX takes no size unit on a trigger order (error 51281), and reads a spot market buy's size in USDT to spend"]);
    const p = okxPerp();
    const reduce = said(await p.t.place({ symbol: "BTC/USDT:USDT", side: "sell", type: "stop", qty: 1, stopPrice: 80000, worstPrice: 78400, reduceOnly: true, clientId: CID }), ALL_SECRETS);
    expect(reduce.message).toContain("OKX lists no reduce-only flag on a trigger order");
    expect([seen.length, p.seen.length]).toEqual([0, 0]);
    answer(okxTicker);
    const wrong = said(await t.place({ symbol: "BTC/USDT", side: "sell", type: "stop_limit", qty: 0.001, stopPrice: 86000, limitPrice: 85900, clientId: CID }), ALL_SECRETS);
    expect([wrong.code, wrong.message, seen.length]).toEqual(["E_VENUE_ORDER_INVALID", "OKX: a sell stop goes below the price now (85573.7): at 86000 it would fire when the price rises to it", 1]);
  });

  it("Binance spot: a stop with a worst price is STOP_LOSS_LIMIT at it, IOC, a sell's worst price up to the tick; with none it is refused (no STOP_LOSS listed)", async () => {
    const { t, seen, answer } = binance();
    answer(binOrder("NEW", "0.00000000", "0.00000000", { type: "STOP_LOSS_LIMIT", side: "SELL", price: "78400.01000000", stopPrice: "80000.00000000", timeInForce: "IOC" }), binOrder("NEW", "0.00000000", "0.00000000", { type: "STOP_LOSS_LIMIT", side: "SELL", stopPrice: "80000.00000000" }));
    const s = ok(await t.place({ symbol: "BTC/USDT", side: "sell", type: "stop", qty: 0.001, stopPrice: 80000, worstPrice: 78400.004, clientId: CID }));
    const [unsigned, signature] = seen[0]!.body!.split("&signature=");
    expect(signature).toBe(hmac("sha256", BINANCE.secret, unsigned!, "hex"));
    expect(form(unsigned)).toEqual({ timestamp: String(NOW), symbol: "BTCUSDT", side: "SELL", newClientOrderId: CID, newOrderRespType: "FULL", type: "STOP_LOSS_LIMIT", quantity: "0.001", price: "78400.01", stopPrice: "80000", timeInForce: "IOC", recvWindow: "10000" });
    expect([s.ref, s.status]).toEqual(["28", "open"]);
    const bare = said(await t.place({ symbol: "BTC/USDT", side: "sell", type: "stop", qty: 0.001, stopPrice: 80000, clientId: CID }), ALL_SECRETS);
    expect([bare.message, seen.length]).toEqual(["Binance: it takes a stop in BTC/USDT spot only as a stop-limit: give the stop a worst price", 2]);
  });

  it("Binance futures: a stop on the algo service (POST /fapi/v1/algoOrder), the id as clientAlgoId, reduce-only and FOK; followed as trigger:<algoId>", async () => {
    const { t, seen, answer } = binance();
    answer(binAlgo("NEW"), binAlgo("NEW"));
    const s = ok(await t.place({ symbol: "BTC/USDT:USDT", side: "buy", type: "stop_limit", qty: 0.002, stopPrice: 90000, limitPrice: 91000, tif: "fok", reduceOnly: true, clientId: CID }));
    expect([seen[0]!.method, seen[0]!.url]).toEqual(["POST", "https://fapi.binance.com/fapi/v1/algoOrder"]);
    expect(form(seen[0]!.body!.split("&signature=")[0])).toEqual({ timestamp: String(NOW), symbol: "BTCUSDT", side: "BUY", clientAlgoId: CID, newOrderRespType: "RESULT", type: "STOP", quantity: "0.002", price: "91000", triggerPrice: "90000", timeInForce: "FOK", reduceOnly: "true", algoType: "CONDITIONAL", recvWindow: "10000" });
    expect(seen[1]!.url).toMatch(new RegExp(`^https://fapi\\.binance\\.com/fapi/v1/algoOrder\\?timestamp=${NOW}&symbol=BTCUSDT&algoId=${BIN_ALGO}&recvWindow=10000&signature=[0-9a-f]{64}$`));
    expect([s.ref, s.status, s.filledQty]).toEqual([`trigger:${BIN_ALGO}`, "open", 0]);
  });

  it("Bybit: a perpetual's stop says its direction (triggerDirection 1 up, 2 down); a spot stop needs a unified account and the price's side", async () => {
    const { t, seen, answer } = bybitBoth();
    answer(bybitAck, bybitLinearList([bybitRow("Untriggered", "0", "0", "", { orderType: "Limit", qty: "0.002", price: "91800", triggerPrice: "90000", leavesQty: "0.002" })]));
    const s = ok(await t.place({ symbol: "BTC/USDT:USDT", side: "buy", type: "stop", qty: 0.002, stopPrice: 90000, worstPrice: 91800, clientId: CID }));
    expect(JSON.parse(seen[0]!.body!)).toEqual({ symbol: "BTCUSDT", side: "Buy", orderType: "Limit", timeInForce: "IOC", orderLinkId: CID, price: "91800", category: "linear", qty: "0.002", triggerDirection: 1, triggerPrice: "90000" });
    expect([s.ref, s.status]).toEqual([BYBIT_ORD, "open"]);
    answer(bybitTicker, bybitAck, bybitList([bybitRow("Untriggered", "0", "0", "", { side: "Sell", price: "79900", triggerPrice: "80000" })]));
    ok(await t.place({ symbol: "BTC/USDT", side: "sell", type: "stop_limit", qty: 0.001, stopPrice: 80000, limitPrice: 79900, clientId: CID }));
    expect(seen[2]!.url).toBe("https://api.bybit.com/v5/market/tickers?symbol=BTCUSDT&category=spot");
    expect(JSON.parse(seen[3]!.body!)).toEqual({ symbol: "BTCUSDT", side: "Sell", orderType: "Limit", orderFilter: "StopOrder", orderLinkId: CID, price: "79900", category: "spot", qty: "0.001", triggerPrice: "80000" });
    const classic = bybitBoth(false);
    const r = said(await classic.t.place({ symbol: "BTC/USDT", side: "sell", type: "stop_limit", qty: 0.001, stopPrice: 80000, limitPrice: 79900, clientId: CID }), ALL_SECRETS);
    expect([r.message, classic.seen.length]).toEqual(["Bybit: the account places spot stops at Bybit on a unified account only: a classic account lists them apart from its orders", 0]);
  });

  it("Coinbase: stop_limit_stop_limit_gtc with its direction always sent (the library's default runs a stop the other way); a stop needs a worst price", async () => {
    const { t, seen, answer } = coinbase();
    const stopCfg = { stop_limit_stop_limit_gtc: { base_size: "0.001", limit_price: "79900", stop_price: "80000", stop_direction: "STOP_DIRECTION_STOP_DOWN" } };
    answer(cbAck("SELL"), cbOrder("OPEN", "0", "0", "0", { side: "SELL", order_type: "STOP_LIMIT", order_configuration: stopCfg, trigger_status: "STOP_PENDING" }));
    const s = ok(await t.place({ symbol: "BTC/USD", side: "sell", type: "stop_limit", qty: 0.001, stopPrice: 80000, limitPrice: 79900, clientId: CID }));
    expect(JSON.parse(seen[0]!.body!)).toEqual({ client_order_id: CID, product_id: "BTC-USD", side: "SELL", order_configuration: stopCfg });
    expect([s.ref, s.status]).toEqual([CB_ORD, "open"]);
    answer(cbAck(), cbOrder("OPEN", "0", "0", "0", { order_type: "STOP_LIMIT", trigger_status: "STOP_PENDING" }));
    const up = ok(await t.place({ symbol: "BTC/USD", side: "buy", type: "stop", qty: 0.001, stopPrice: 90000, worstPrice: 91800.007, clientId: CID }));
    expect(JSON.parse(seen[2]!.body!).order_configuration).toEqual({ stop_limit_stop_limit_gtc: { base_size: "0.001", limit_price: "91800", stop_price: "90000", stop_direction: "STOP_DIRECTION_STOP_UP" } });
    expect(up.native).toMatchObject({ sentAs: "a stop at 90000 that places a limit order at 91800, which rests on the book if it does not fill at once: a stop kept inside its worst price" });
    const bare = said(await t.place({ symbol: "BTC/USD", side: "sell", type: "stop", qty: 0.001, stopPrice: 80000, clientId: CID }), ALL_SECRETS);
    const ioc = said(await t.place({ symbol: "BTC/USD", side: "sell", type: "stop_limit", qty: 0.001, stopPrice: 80000, limitPrice: 79900, tif: "ioc", clientId: CID }), ALL_SECRETS);
    expect([bare.message, ioc.message, seen.length]).toEqual(["Coinbase: it takes a stop only as a stop-limit (stop_limit_stop_limit_gtc): give the stop a worst price", "Coinbase: it takes no ioc on the limit order a stop places in BTC/USD spot: that order waits on the book until canceled", 4]);
  });

  it("Kraken: stop-loss-limit (price the trigger, price2 the limit), and stop-loss for a stop with no worst price", async () => {
    const { t, seen, answer } = kraken();
    const added = { body: { error: [], result: { descr: { order: "sell 0.00100000 XBTUSD @ stop loss 80000.0 -> limit 79900.0" }, txid: [KR_ORD] } } };
    answer(added, krQuery("open", "0.00000000", "0", "0", "0"), added, krQuery("open", "0.00000000", "0", "0", "0"));
    ok(await t.place({ symbol: "BTC/USD", side: "sell", type: "stop_limit", qty: 0.001, stopPrice: 80000, limitPrice: 79900, clientId: CID }));
    expect(form(seen[0]!.body)).toEqual({ nonce: String(NOW), pair: "XXBTZUSD", type: "sell", ordertype: "stop-loss-limit", volume: "0.001", cl_ord_id: CID, price: "80000", price2: "79900" });
    const bare = ok(await t.place({ symbol: "BTC/USD", side: "sell", type: "stop", qty: 0.001, stopPrice: 80000, clientId: CID }));
    // the library counts its own nonce up from one request to the next
    expect(form(seen[2]!.body)).toEqual({ nonce: String(NOW + 2), pair: "XXBTZUSD", type: "sell", ordertype: "stop-loss", volume: "0.001", cl_ord_id: CID, price: "80000" });
    expect(bare.native).toMatchObject({ sentAs: "a stop at 80000 that places a market order: it has no worst price" });
  });

  it("checked before anything is sent: a stop's worst price on the wrong side of it, a stop price on a limit order, a stop without one", async () => {
    const { t, seen } = kraken();
    const wrong = said(await t.place({ symbol: "BTC/USD", side: "sell", type: "stop", qty: 0.001, stopPrice: 80000, worstPrice: 80100, clientId: CID }), ALL_SECRETS);
    expect(wrong.message).toBe("Kraken: a sell stop's worst price is at or below its stop price: 80100 is not, against 80000");
    const onLimit = said(await t.place({ symbol: "BTC/USD", side: "buy", type: "limit", qty: 0.001, limitPrice: 60000, stopPrice: 61000, clientId: CID }), ALL_SECRETS);
    const without = said(await t.place({ symbol: "BTC/USD", side: "sell", type: "stop", qty: 0.001, clientId: CID }), ALL_SECRETS);
    expect([onLimit.message, without.message, seen.length]).toEqual(["Kraken: a limit order has no stop price", "Kraken: a stop order has a stop price that triggers it", 0]);
  });

  it("an OKX trigger order whose call did not come back is looked up by algoClOrdId in the algo book", async () => {
    class Timeout extends Error {
      override name = "RequestTimeout";
    }
    const { t, seen, answer } = okx();
    answer(okxTicker, new Timeout("okx POST https://www.okx.com/api/v5/trade/order-algo request timed out (12000 ms)"), okxAlgo("live"));
    const s = ok(await t.place({ symbol: "BTC/USDT", side: "sell", type: "stop_limit", qty: 0.001, stopPrice: 80000, limitPrice: 79900, clientId: CID }));
    expect([s.ref, s.status, seen[2]!.url]).toEqual([`trigger:${OKX_ALGO}`, "open", `https://www.okx.com/api/v5/trade/order-algo?instId=BTC-USDT&algoClOrdId=${CID}`]);
  });
});

describe("the times in force and flags, as the library sends them", () => {
  it("post-only: OKX ordType post_only, Binance LIMIT_MAKER, Bybit timeInForce PostOnly, Coinbase post_only, Kraken oflags post", async () => {
    const o = okx();
    o.answer(okxAck(), okxOrder("live", "0", "", { ordType: "post_only" }));
    ok(await o.t.place({ symbol: "BTC/USDT", side: "buy", type: "limit", qty: 0.001, limitPrice: 60000, postOnly: true, clientId: CID }));
    expect(okxSigned(o.seen[0]!, "/api/v5/trade/batch-orders")).toEqual([{ instId: "BTC-USDT", side: "buy", ordType: "post_only", sz: "0.001", tdMode: "cash", tgtCcy: "base_ccy", px: "60000", clOrdId: CID }]);
    const b = binance();
    b.answer(binOrder("NEW", "0.00000000", "0.00000000", { type: "LIMIT_MAKER" }), binOrder("NEW", "0.00000000", "0.00000000", { type: "LIMIT_MAKER" }));
    ok(await b.t.place({ symbol: "BTC/USDT", side: "buy", type: "limit", qty: 0.001, limitPrice: 60000, postOnly: true, clientId: CID }));
    expect(form(b.seen[0]!.body!.split("&signature=")[0])).toMatchObject({ type: "LIMIT_MAKER", price: "60000", quantity: "0.001" });
    expect(form(b.seen[0]!.body!.split("&signature=")[0]).timeInForce).toBeUndefined();
    // a futures post-only order is GTX, and a "gtc" asked with it goes as nothing, so that it cannot come back over the GTX
    b.answer(binFut("NEW", "0", "0", { timeInForce: "GTX" }), binFut("NEW", "0", "0", { timeInForce: "GTX" }));
    ok(await b.t.place({ symbol: "BTC/USDT:USDT", side: "buy", type: "limit", qty: 0.002, limitPrice: 91000, postOnly: true, tif: "gtc", clientId: CID }));
    expect(form(b.seen[2]!.body!.split("&signature=")[0])).toMatchObject({ type: "LIMIT", price: "91000", timeInForce: "GTX" });
    const y = bybit(true);
    y.answer(bybitAck, bybitList([bybitRow("New", "0", "0", "")]));
    ok(await y.t.place({ symbol: "BTC/USDT", side: "buy", type: "limit", qty: 0.001, limitPrice: 60000, postOnly: true, clientId: CID }));
    expect(JSON.parse(y.seen[0]!.body!)).toEqual({ symbol: "BTCUSDT", side: "Buy", orderType: "Limit", timeInForce: "PostOnly", orderLinkId: CID, price: "60000", category: "spot", qty: "0.001" });
    const c = coinbase();
    c.answer(cbAck(), cbOrder("OPEN", "0", "0", "0"));
    ok(await c.t.place({ symbol: "BTC/USD", side: "buy", type: "limit", qty: 0.001, limitPrice: 60000, postOnly: true, clientId: CID }));
    expect(JSON.parse(c.seen[0]!.body!).order_configuration).toEqual({ limit_limit_gtc: { base_size: "0.001", limit_price: "60000", post_only: true } });
    const k = kraken();
    k.answer({ body: { error: [], result: { descr: { order: "buy 0.00100000 XBTUSD @ limit 60000.0" }, txid: [KR_ORD] } } }, krQuery("open", "0.00000000", "0", "0", "0"));
    ok(await k.t.place({ symbol: "BTC/USD", side: "buy", type: "limit", qty: 0.001, limitPrice: 60000, postOnly: true, clientId: CID }));
    expect(form(k.seen[0]!.body)).toMatchObject({ ordertype: "limit", price: "60000", oflags: "post" });
  });

  it("a time in force: OKX ordType fok, Binance IOC, Coinbase limit_limit_fok and sor_limit_ioc, Kraken timeinforce; a market order with a worst price FOK", async () => {
    const o = okx();
    o.answer(okxAck(), okxOrder("canceled", "0", "", { ordType: "fok" }));
    ok(await o.t.place({ symbol: "BTC/USDT", side: "buy", type: "limit", qty: 0.001, limitPrice: 60000, tif: "fok", clientId: CID }));
    expect((okxSigned(o.seen[0]!, "/api/v5/trade/batch-orders") as Dict[])[0]).toMatchObject({ ordType: "fok", px: "60000" });
    const b = binance();
    b.answer(binOrder("EXPIRED", "0.00000000", "0.00000000", { timeInForce: "IOC" }), binOrder("EXPIRED", "0.00000000", "0.00000000", { timeInForce: "IOC" }), binOrder("FILLED", "0.00100000", "87.28522000", { timeInForce: "FOK" }), binOrder("FILLED", "0.00100000", "87.28522000", { timeInForce: "FOK" }));
    ok(await b.t.place({ symbol: "BTC/USDT", side: "buy", type: "limit", qty: 0.001, limitPrice: 60000, tif: "ioc", clientId: CID }));
    expect(form(b.seen[0]!.body!.split("&signature=")[0])).toMatchObject({ type: "LIMIT", timeInForce: "IOC" });
    const fok = ok(await b.t.place({ symbol: "BTC/USDT", side: "buy", type: "market", qty: 0.001, worstPrice: 87285.22, tif: "fok", clientId: CID }));
    expect(form(b.seen[2]!.body!.split("&signature=")[0])).toMatchObject({ type: "LIMIT", timeInForce: "FOK", price: "87285.22" });
    expect(fok.native).toMatchObject({ sentAs: "a limit order at 87285.22 that fills whole at once or not at all (FOK): a market order kept inside its worst price" });
    const c = coinbase();
    c.answer(cbAck(), cbOrder("CANCELLED", "0", "0", "0"), cbAck(), cbOrder("FILLED", "0.001", "60000", "0.36"));
    ok(await c.t.place({ symbol: "BTC/USD", side: "buy", type: "limit", qty: 0.001, limitPrice: 60000, tif: "fok", clientId: CID }));
    ok(await c.t.place({ symbol: "BTC/USD", side: "buy", type: "limit", qty: 0.001, limitPrice: 60000, tif: "ioc", clientId: CID }));
    expect([JSON.parse(c.seen[0]!.body!).order_configuration, JSON.parse(c.seen[2]!.body!).order_configuration]).toEqual([{ limit_limit_fok: { base_size: "0.001", limit_price: "60000" } }, { sor_limit_ioc: { base_size: "0.001", limit_price: "60000" } }]);
    const k = kraken();
    k.answer({ body: { error: [], result: { descr: { order: "buy 0.00100000 XBTUSD @ limit 60000.0" }, txid: [KR_ORD] } } }, krQuery("canceled", "0.00000000", "0", "0", "0"));
    ok(await k.t.place({ symbol: "BTC/USD", side: "buy", type: "limit", qty: 0.001, limitPrice: 60000, tif: "fok", clientId: CID }));
    expect(form(k.seen[0]!.body)).toMatchObject({ ordertype: "limit", timeinforce: "FOK" });
  });

  it("reduce-only on a perpetual: OKX reduceOnly true, Binance reduceOnly=true, Bybit reduceOnly true", async () => {
    const o = okx();
    o.answer(okxAck(), okxOrder("live", "0", "", { instId: "BTC-USDT-SWAP", instType: "SWAP", sz: "1", side: "sell", reduceOnly: "true" }));
    ok(await o.t.place({ symbol: "BTC/USDT:USDT", side: "sell", type: "limit", qty: 1, limitPrice: 90000, reduceOnly: true, clientId: CID }));
    expect(okxSigned(o.seen[0]!, "/api/v5/trade/batch-orders")).toEqual([{ instId: "BTC-USDT-SWAP", side: "sell", ordType: "limit", sz: "1", tdMode: "cross", px: "90000", clOrdId: CID, reduceOnly: true }]);
    const b = binance();
    b.answer(binFut("NEW", "0", "0", { side: "SELL", reduceOnly: true }), binFut("NEW", "0", "0", { side: "SELL", reduceOnly: true }));
    ok(await b.t.place({ symbol: "BTC/USDT:USDT", side: "sell", type: "limit", qty: 0.002, limitPrice: 91000, reduceOnly: true, clientId: CID }));
    expect([b.seen[0]!.url, form(b.seen[0]!.body!.split("&signature=")[0])]).toEqual(["https://fapi.binance.com/fapi/v1/order", { timestamp: String(NOW), symbol: "BTCUSDT", side: "SELL", newClientOrderId: CID, newOrderRespType: "RESULT", type: "LIMIT", quantity: "0.002", price: "91000", reduceOnly: "true", timeInForce: "GTC", recvWindow: "10000" }]);
    const y = bybitBoth();
    y.answer(bybitAck, bybitLinearList([bybitRow("New", "0", "0", "", { side: "Sell", qty: "0.002", leavesQty: "0.002", price: "91000" })]));
    ok(await y.t.place({ symbol: "BTC/USDT:USDT", side: "sell", type: "limit", qty: 0.002, limitPrice: 91000, reduceOnly: true, clientId: CID }));
    expect(JSON.parse(y.seen[0]!.body!)).toEqual({ symbol: "BTCUSDT", side: "Sell", orderType: "Limit", orderLinkId: CID, price: "91000", category: "linear", qty: "0.002", reduceOnly: true });
  });

  it("refused before anything is sent: a flag the market does not list, post-only off a limit order or with IOC, a time in force that means nothing there", async () => {
    const { t, seen } = okx();
    const cases: Array<[Parameters<LiveTrader["place"]>[0], string]> = [
      [{ symbol: "BTC/USDT", side: "buy", type: "market", qty: 0.001, postOnly: true, clientId: CID }, "OKX: post-only is for a limit order: it rests on the book as a maker, or is refused"],
      [{ symbol: "BTC/USDT", side: "buy", type: "limit", qty: 0.001, limitPrice: 60000, postOnly: true, tif: "ioc", clientId: CID }, "OKX: a post-only order rests on the book until canceled: it takes no ioc"],
      [{ symbol: "BTC/USDT", side: "buy", type: "limit", qty: 0.001, limitPrice: 60000, tif: "day", clientId: CID }, "OKX: it takes gtc, ioc and fok in BTC/USDT spot, not day"],
      [{ symbol: "BTC/USDT", side: "sell", type: "limit", qty: 0.001, limitPrice: 60000, reduceOnly: true, clientId: CID }, "OKX: it takes no reduce-only orders in BTC/USDT spot"],
      [{ symbol: "BTC/USDT", side: "sell", type: "market", qty: 0.001, tif: "gtc", clientId: CID }, "OKX: a market order fills at once: it does not wait until canceled"],
      [{ symbol: "BTC/USDT", side: "sell", type: "market", qty: 0.001, tif: "fok", clientId: CID }, "OKX: a market order that fills whole or not at all needs a worst price: it then goes as a limit order there, filled at once in full or not at all"],
      [{ symbol: "BTC/USDT", side: "sell", type: "stop", qty: 0.001, stopPrice: 80000, worstPrice: 78400, tif: "ioc", clientId: CID }, "OKX: a stop waits for its trigger until canceled and then fills at once: it takes no ioc"],
      [{ symbol: "BTC/USDT", side: "sell", type: "stop_limit", qty: 0.001, stopPrice: 80000, limitPrice: 79900, tif: "ioc", clientId: CID }, "OKX: it takes no ioc on the limit order a stop places in BTC/USDT spot: that order waits on the book until canceled"],
    ];
    for (const [order, message] of cases) expect(said(await t.place(order), ALL_SECRETS).message).toBe(message);
    expect(seen).toEqual([]);
  });
});

describe("what became of a stop, and taking it off the book", () => {
  it("OKX: an untriggered trigger order is open; once it has fired the order it placed is followed, under that order's id; one that failed is rejected", async () => {
    const { t, seen, answer } = okx();
    answer(okxAlgo("live"));
    expect(ok(await t.status(`trigger:${OKX_ALGO}`, "BTC/USDT")).status).toBe("open");
    answer(okxAlgo("effective", { ordId: OKX_CHILD, ordIdList: [OKX_CHILD], actualSz: "0.001", actualPx: "79900", actualSide: "sell", triggerTime: "1791230009999" }), okxOrder("filled", "0.001", "79950", { ordId: OKX_CHILD, side: "sell", px: "79900", fee: "-0.08", feeCcy: "USDT" }));
    const fired = ok(await t.status(`trigger:${OKX_ALGO}`, "BTC/USDT"));
    expect(seen.slice(1).map((r) => r.url)).toEqual([`https://www.okx.com/api/v5/trade/order-algo?instId=BTC-USDT&algoId=${OKX_ALGO}`, `https://www.okx.com/api/v5/trade/order?instId=BTC-USDT&ordId=${OKX_CHILD}`]);
    expect([fired.ref, fired.status, fired.filledQty, fired.avgPrice, fired.feeUsd]).toEqual([OKX_CHILD, "filled", 0.001, 79950, 0.08]);
    expect(fired.native).toMatchObject({ trigger: { id: OKX_ALGO, status: "effective" } });
    // fired with the order it placed not named yet: taken, not settled; never filled by the algo order's own word
    answer(okxAlgo("effective"));
    expect(ok(await t.status(`trigger:${OKX_ALGO}`, "BTC/USDT"))).toMatchObject({ ref: `trigger:${OKX_ALGO}`, status: "pending", filledQty: 0 });
    answer(okxAlgo("order_failed", { failCode: "51008" }));
    const failed = ok(await t.status(`trigger:${OKX_ALGO}`, "BTC/USDT"));
    expect([failed.status, failed.native]).toEqual(["rejected", expect.objectContaining({ failCode: "51008", venueStatus: "order_failed" })]);
  });

  it("OKX: a trigger order is canceled in its book (POST /api/v5/trade/cancel-algos); one that has fired has the order it placed canceled instead", async () => {
    const { t, seen, answer } = okx();
    answer({ body: { code: "0", msg: "", data: [{ algoId: OKX_ALGO, sCode: "0", sMsg: "" }] } }, okxAlgo("canceled"));
    const s = ok(await t.cancel(`trigger:${OKX_ALGO}`, "BTC/USDT"));
    expect(okxSigned(seen[0]!, "/api/v5/trade/cancel-algos")).toEqual([{ algoId: OKX_ALGO, instId: "BTC-USDT" }]);
    expect([s.ref, s.status, s.filledQty]).toEqual([`trigger:${OKX_ALGO}`, "canceled", 0]);
    const late = okx();
    late.answer({ body: { code: "1", msg: "", data: [{ algoId: OKX_ALGO, sCode: "51400", sMsg: "Cancellation failed as the order has been filled, canceled or does not exist" }] } }, okxAlgo("effective", { ordId: OKX_CHILD }), okxOrder("live", "0", "", { ordId: OKX_CHILD, side: "sell", px: "79900" }), { body: { code: "0", msg: "", data: [{ clOrdId: "", ordId: OKX_CHILD, ts: "1791230000999", sCode: "0", sMsg: "" }] } }, okxOrder("canceled", "0", "", { ordId: OKX_CHILD, side: "sell", px: "79900" }));
    const child = ok(await late.t.cancel(`trigger:${OKX_ALGO}`, "BTC/USDT"));
    expect(late.seen.map((r) => `${r.method} ${r.url.split("?")[0]}`)).toEqual(["POST https://www.okx.com/api/v5/trade/cancel-algos", "GET https://www.okx.com/api/v5/trade/order-algo", "GET https://www.okx.com/api/v5/trade/order", "POST https://www.okx.com/api/v5/trade/cancel-order", "GET https://www.okx.com/api/v5/trade/order"]);
    expect(okxSigned(late.seen[3]!, "/api/v5/trade/cancel-order")).toEqual({ instId: "BTC-USDT", ordId: OKX_CHILD });
    expect([child.ref, child.status]).toEqual([OKX_CHILD, "canceled"]);
    // canceled in its book just as it fired: the order it placed is canceled too, not left on the book
    const race = okx();
    race.answer({ body: { code: "0", msg: "", data: [{ algoId: OKX_ALGO, sCode: "0", sMsg: "" }] } }, okxAlgo("effective", { ordId: OKX_CHILD }), okxOrder("live", "0", "", { ordId: OKX_CHILD, side: "sell", px: "79900" }), { body: { code: "0", msg: "", data: [{ clOrdId: "", ordId: OKX_CHILD, ts: "1791230000999", sCode: "0", sMsg: "" }] } }, okxOrder("canceled", "0", "", { ordId: OKX_CHILD, side: "sell", px: "79900" }));
    const both = ok(await race.t.cancel(`trigger:${OKX_ALGO}`, "BTC/USDT"));
    expect([race.seen[3]!.url, both.ref, both.status]).toEqual(["https://www.okx.com/api/v5/trade/cancel-order", OKX_CHILD, "canceled"]);
  });

  it("Binance futures: an algo order is read and canceled at /fapi/v1/algoOrder; once TRIGGERED the order it placed (actualOrderId) is followed", async () => {
    const { t, seen, answer } = binance();
    answer(binAlgo("TRIGGERED", { actualOrderId: String(BIN_FUT), actualPrice: "90950.0", triggerTime: 1791230009999 }), binFut("FILLED", "0.002", "181.9"));
    const fired = ok(await t.status(`trigger:${BIN_ALGO}`, "BTC/USDT:USDT"));
    expect(seen.map((r) => r.url.split("?")[0])).toEqual(["https://fapi.binance.com/fapi/v1/algoOrder", "https://fapi.binance.com/fapi/v1/order"]);
    expect(seen[1]!.url).toContain(`orderId=${BIN_FUT}`);
    expect([fired.ref, fired.status, fired.filledQty, fired.avgPrice]).toEqual([String(BIN_FUT), "filled", 0.002, 90950]);
    answer({ body: { algoId: BIN_ALGO, clientAlgoId: CID, code: "200", msg: "success" } }, binAlgo("CANCELED"));
    const s = ok(await t.cancel(`trigger:${BIN_ALGO}`, "BTC/USDT:USDT"));
    expect([seen[2]!.method, seen[2]!.url.split("?")[0], seen[3]!.url.split("?")[0]]).toEqual(["DELETE", "https://fapi.binance.com/fapi/v1/algoOrder", "https://fapi.binance.com/fapi/v1/algoOrder"]);
    expect(seen[2]!.url).toContain(`algoId=${BIN_ALGO}`);
    expect([s.ref, s.status]).toEqual([`trigger:${BIN_ALGO}`, "canceled"]);
  });

  it("Bybit: a spot conditional order it does not know as a plain order is canceled as one (orderFilter StopOrder)", async () => {
    const { t, seen, answer } = bybit(true);
    answer({ body: { retCode: 170213, retMsg: "Order does not exist.", result: {}, retExtInfo: {}, time: 1 } }, bybitAck, bybitList([]), bybitList([bybitRow("Deactivated", "0", "0", "", { triggerPrice: "80000" })]));
    const s = ok(await t.cancel(BYBIT_ORD, "BTC/USDT"));
    expect(seen.slice(0, 2).map((r) => JSON.parse(r.body!).orderFilter)).toEqual(["Order", "StopOrder"]);
    expect([s.ref, s.status]).toEqual([BYBIT_ORD, "canceled"]);
  });
});

describe("an open order changed in place", () => {
  const limitBuy = { symbol: "BTC/USDT", side: "buy" as const, type: "limit" as const, qty: 0.001, limitPrice: 60000, clientId: CID };

  it("OKX: amend-order for an order on the book (newSz the whole size); amend-algos for a trigger order, its trigger and order price together", async () => {
    const { t, seen, answer } = okx();
    answer({ body: { code: "0", msg: "", data: [{ clOrdId: CID, ordId: OKX_ORD, reqId: "", sCode: "0", sMsg: "" }] } }, okxOrder("live", "0", "", { sz: "0.002", px: "60100" }));
    const s = ok(await t.amend!(OKX_ORD, "BTC/USDT", { qty: 0.002, limitPrice: 60100 }, limitBuy));
    expect(okxSigned(seen[0]!, "/api/v5/trade/amend-order")).toEqual({ instId: "BTC-USDT", ordId: OKX_ORD, newSz: "0.002", newPx: "60100" });
    expect([s.ref, s.status]).toEqual([OKX_ORD, "open"]);
    answer({ body: { code: "0", msg: "", data: [{ algoClOrdId: CID, algoId: OKX_ALGO, reqId: "", sCode: "0", sMsg: "" }] } }, okxAlgo("live", { triggerPx: "80100" }));
    const stop = ok(await t.amend!(`trigger:${OKX_ALGO}`, "BTC/USDT", { stopPrice: 80100 }, { symbol: "BTC/USDT", side: "sell", type: "stop_limit", qty: 0.001, stopPrice: 80000, limitPrice: 79900, clientId: CID }));
    expect(okxSigned(seen[2]!, "/api/v5/trade/amend-algos")).toEqual({ instId: "BTC-USDT", algoId: OKX_ALGO, newTriggerPx: "80100", newOrdPx: "79900" });
    expect([stop.ref, stop.status]).toEqual([`trigger:${OKX_ALGO}`, "open"]);
  });

  it("Binance: a futures limit order by Modify Order (quantity and price together); spot only cancels and replaces, so it is refused", async () => {
    const { t, seen, answer } = binance();
    answer(binFut("NEW", "0", "0", { price: "90900.0" }), binFut("NEW", "0", "0", { price: "90900.0" }));
    const s = ok(await t.amend!(String(BIN_FUT), "BTC/USDT:USDT", { limitPrice: 90900 }, { symbol: "BTC/USDT:USDT", side: "buy", type: "limit", qty: 0.002, limitPrice: 91000, clientId: CID }));
    expect([seen[0]!.method, seen[0]!.url, form(seen[0]!.body!.split("&signature=")[0])]).toEqual(["PUT", "https://fapi.binance.com/fapi/v1/order", { timestamp: String(NOW), symbol: "BTCUSDT", side: "BUY", orderId: String(BIN_FUT), quantity: "0.002", price: "90900", recvWindow: "10000" }]);
    expect([s.ref, s.status]).toEqual([String(BIN_FUT), "open"]);
    const spot = said(await t.amend!("28", "BTC/USDT", { limitPrice: 60100 }, limitBuy), ALL_SECRETS);
    const algo = said(await t.amend!(`trigger:${BIN_ALGO}`, "BTC/USDT:USDT", { stopPrice: 90100 }, { symbol: "BTC/USDT:USDT", side: "buy", type: "stop_limit", qty: 0.002, stopPrice: 90000, limitPrice: 91000, clientId: CID }), ALL_SECRETS);
    expect([spot.code, algo.code, seen.length]).toEqual(["E_VENUE_RAIL_CLOSED", "E_VENUE_RAIL_CLOSED", 2]);
    expect(spot.message).toContain("cancel-replace");
  });

  it("Bybit: v5 amend, a stop's trigger too; a stop kept inside its worst price is not moved past it", async () => {
    const { t, seen, answer } = bybitBoth();
    answer(bybitAck, bybitLinearList([bybitRow("Untriggered", "0", "0", "", { qty: "0.002", leavesQty: "0.002", price: "91800", triggerPrice: "90100" })]));
    const order = { symbol: "BTC/USDT:USDT", side: "buy" as const, type: "stop" as const, qty: 0.002, stopPrice: 90000, worstPrice: 91800, clientId: CID };
    const s = ok(await t.amend!(BYBIT_ORD, "BTC/USDT:USDT", { stopPrice: 90100 }, order));
    expect([seen[0]!.url, JSON.parse(seen[0]!.body!)]).toEqual(["https://api.bybit.com/v5/order/amend", { symbol: "BTCUSDT", orderId: BYBIT_ORD, category: "linear", triggerPrice: "90100", triggerBy: "LastPrice" }]);
    expect([s.ref, s.status]).toEqual([BYBIT_ORD, "open"]);
    const past = said(await t.amend!(BYBIT_ORD, "BTC/USDT:USDT", { stopPrice: 92000 }, order), ALL_SECRETS);
    expect([past.message, seen.length]).toEqual(["Bybit: this buy stop's worst price is 91800: a stop at 92000 would be past it. Cancel it and place it again with a new worst price", 2]);
  });

  it("Coinbase: Edit order with the size and price together, and a change it did not make (success false) is its refusal; a stop is not edited", async () => {
    const { t, seen, answer } = coinbase();
    answer({ body: { success: true, errors: [] } }, cbOrder("OPEN", "0", "0", "0", { order_configuration: { limit_limit_gtc: { base_size: "0.002", limit_price: "60000", post_only: false } } }));
    const s = ok(await t.amend!(CB_ORD, "BTC/USD", { qty: 0.002 }, { ...limitBuy, symbol: "BTC/USD" }));
    expect([seen[0]!.url, JSON.parse(seen[0]!.body!)]).toEqual(["https://api.coinbase.com/api/v3/brokerage/orders/edit", { order_id: CB_ORD, size: "0.002", price: "60000" }]);
    expect([s.ref, s.status]).toEqual([CB_ORD, "open"]);
    answer({ body: { success: false, errors: [{ edit_failure_reason: "CANNOT_EDIT_TO_BELOW_FILLED_SIZE", preview_failure_reason: "UNKNOWN_PREVIEW_FAILURE_REASON" }] } });
    const r = said(await t.amend!(CB_ORD, "BTC/USD", { qty: 0.0001 }, { ...limitBuy, symbol: "BTC/USD" }), ALL_SECRETS);
    expect([r.code, r.message, seen.length]).toEqual(["E_VENUE_REJECTED", "Coinbase did not change the order (CANNOT_EDIT_TO_BELOW_FILLED_SIZE)", 3]);
    const stop = said(await t.amend!(CB_ORD, "BTC/USD", { stopPrice: 80100 }, { symbol: "BTC/USD", side: "sell", type: "stop_limit", qty: 0.001, stopPrice: 80000, limitPrice: 79900, clientId: CID }), ALL_SECRETS);
    expect([stop.code, seen.length]).toEqual(["E_VENUE_RAIL_CLOSED", 3]);
  });

  it("Kraken: AmendOrder keeps the txid (its answer is the change's own id, which is not the order's): order_qty, limit_price, trigger_price", async () => {
    const { t, seen, answer } = kraken();
    answer({ body: { error: [], result: { amend_id: "TJSMEH-AA67V-YUSQ6O" } } }, krQuery("open", "0.00000000", "0", "0", "0"), { body: { error: [], result: { amend_id: "TJSMEH-AA67V-YUSQ7P" } } }, krQuery("open", "0.00000000", "0", "0", "0"));
    const s = ok(await t.amend!(KR_ORD, "BTC/USD", { qty: 0.002, limitPrice: 60100 }, { ...limitBuy, symbol: "BTC/USD" }));
    expect([seen[0]!.url, form(seen[0]!.body)]).toEqual(["https://api.kraken.com/0/private/AmendOrder", { nonce: String(NOW), txid: KR_ORD, order_qty: "0.002", limit_price: "60100" }]);
    expect([s.ref, s.status, form(seen[1]!.body).txid]).toEqual([KR_ORD, "open", KR_ORD]);
    ok(await t.amend!(KR_ORD, "BTC/USD", { stopPrice: 80100 }, { symbol: "BTC/USD", side: "sell", type: "stop", qty: 0.001, stopPrice: 80000, clientId: CID }));
    expect(form(seen[2]!.body)).toEqual({ nonce: String(NOW + 2), txid: KR_ORD, trigger_price: "80100" });
  });

  it("an order that filled before the change reached it is said to be filled, and nothing is changed", async () => {
    const { t, answer } = okx();
    answer({ body: { code: "1", msg: "All operations failed", data: [{ clOrdId: "", ordId: OKX_ORD, reqId: "", sCode: "51503", sMsg: "Order modification failed as the order has been filled, canceled or does not exist" }] } }, okxOrder("filled", "0.001", "59995.2"));
    const r = said(await t.amend!(OKX_ORD, "BTC/USDT", { limitPrice: 60100 }, limitBuy), ALL_SECRETS);
    expect([r.code, r.message, r.detail]).toEqual(["E_VENUE_REJECTED", "OKX: the order is filled already, so nothing was changed", { order: OKX_ORD, status: "filled" }]);
    // a trigger order that fired before its change reached it: what stands now is the order it placed
    answer({ body: { code: "1", msg: "", data: [{ algoClOrdId: "", algoId: OKX_ALGO, reqId: "", sCode: "51400", sMsg: "Order modification failed as the order has been canceled or does not exist" }] } }, okxAlgo("effective", { ordId: OKX_CHILD }), okxOrder("live", "0", "", { ordId: OKX_CHILD, side: "sell", px: "79900" }));
    const fired = said(await t.amend!(`trigger:${OKX_ALGO}`, "BTC/USDT", { stopPrice: 80100 }, { symbol: "BTC/USDT", side: "sell", type: "stop_limit", qty: 0.001, stopPrice: 80000, limitPrice: 79900, clientId: CID }), ALL_SECRETS);
    expect([fired.message, fired.detail]).toEqual([`OKX: this stop has fired, so nothing was changed. The order it placed (${OKX_CHILD}) is what stands now: it is followed from the next look, and can be changed then`, { order: `trigger:${OKX_ALGO}`, placed: OKX_CHILD }]);
  });
});

describe("what is held, and a perpetual's leverage", () => {
  it("OKX positions: dollar-settled perpetuals only, in contracts, with what they are worth; an inverse one and an empty one are not listed", async () => {
    const { t, seen, answer } = okxPerp();
    const row = (instId: string, posQty: string, over: Dict = {}) => ({ adl: "1", availPos: "", avgPx: "80000", cTime: "1", ccy: "USDT", imr: "17.1", instId, instType: "SWAP", interest: "0", last: "85580.1", lever: "5", liqPx: "102000", markPx: "85580.1", mgnMode: "cross", mgnRatio: "100", mmr: "0.6", notionalUsd: "855.801", pos: posQty, posCcy: "", posId: "1", posSide: "net", uTime: "2", upl: "-55.8", uplRatio: "-0.3", realizedPnl: "0", ...over });
    answer({ body: { code: "0", msg: "", data: [row("BTC-USDT-SWAP", "-1"), row("BTC-USD-SWAP", "3", { ccy: "BTC" }), row("BTC-USDT-SWAP", "0", { posId: "2" })] } });
    const list = ok(await t.positions!());
    expect(seen.map((r) => r.url)).toEqual(["https://www.okx.com/api/v5/account/positions"]);
    expect(list.map(({ native: _native, ...p }) => p)).toEqual([{ symbol: "BTC/USDT:USDT", name: "BTC/USDT perpetual", kind: "perp", side: "short", qty: 1, entryPrice: 80000, markPrice: 85580.1, usd: 855.801, unrealizedUsd: -55.8, leverage: 5, marginMode: "cross", liquidationPrice: 102000 }]);
  });

  it("Binance positions: GET /fapi/v3/positionRisk after its leverage brackets; Bybit's once per settle coin, USDT and USDC", async () => {
    const { t, seen, answer } = binance();
    answer({ body: [{ symbol: "BTCUSDT", brackets: [{ bracket: 1, initialLeverage: 125, notionalCap: 50000, notionalFloor: 0, maintMarginRatio: 0.004, cum: 0 }] }] }, { body: [{ symbol: "BTCUSDT", positionSide: "BOTH", positionAmt: "0.002", entryPrice: "90000.0", breakEvenPrice: "90036.0", markPrice: "91000.0", unRealizedProfit: "2.0", liquidationPrice: "45000.0", isolatedMargin: "0", notional: "182.0", marginAsset: "USDT", isolatedWallet: "0", initialMargin: "36.4", maintMargin: "0.728", positionInitialMargin: "36.4", openOrderInitialMargin: "0", adl: 1, bidNotional: "0", askNotional: "0", updateTime: 1791230000456 }] });
    const list = ok(await t.positions!());
    expect(seen.map((r) => r.url.split("?")[0])).toEqual(["https://fapi.binance.com/fapi/v1/leverageBracket", "https://fapi.binance.com/fapi/v3/positionRisk"]);
    expect(list.map((p) => [p.symbol, p.kind, p.side, p.qty, p.entryPrice, p.markPrice, p.usd, p.unrealizedUsd, p.liquidationPrice])).toEqual([["BTC/USDT:USDT", "perp", "long", 0.002, 90000, 91000, 182, 2, 45000]]);
    const y = bybitBoth();
    const posRow = { positionIdx: 0, riskId: 1, riskLimitValue: "2000000", symbol: "BTCUSDT", side: "Sell", size: "0.002", avgPrice: "90000", positionValue: "180", tradeMode: 0, autoAddMargin: 0, positionStatus: "Normal", leverage: "5", markPrice: "91000", liqPrice: "108000", bustPrice: "", positionIM: "36", positionMM: "1", takeProfit: "", stopLoss: "", trailingStop: "0", unrealisedPnl: "-2", curRealisedPnl: "0", cumRealisedPnl: "0", adlRankIndicator: 2, createdTime: "1791230000123", updatedTime: "1791230000456", seq: 1, isReduceOnly: false };
    y.answer(bybitLinearList([posRow]), bybitLinearList([]));
    const held = ok(await y.t.positions!());
    expect(y.seen.map((r) => r.url)).toEqual(["https://api.bybit.com/v5/position/list?settleCoin=USDT&limit=200&category=linear", "https://api.bybit.com/v5/position/list?settleCoin=USDC&limit=200&category=linear"]);
    expect(held.map((p) => [p.symbol, p.side, p.qty, p.usd, p.leverage, p.liquidationPrice])).toEqual([["BTC/USDT:USDT", "short", 0.002, 180, 5, 108000]]);
  });

  it("OKX leverage: the cross leverage, as the account's orders there go in cross margin; isolated is refused, as is more than the market takes", async () => {
    const { t, seen, answer } = okxPerp();
    answer({ body: { code: "0", msg: "", data: [{ instId: "BTC-USDT-SWAP", lever: "5", mgnMode: "cross", posSide: "" }] } });
    const r = ok(await t.setLeverage!("BTC/USDT:USDT", 5));
    expect(okxSigned(seen[0]!, "/api/v5/account/set-leverage")).toEqual({ lever: 5, mgnMode: "cross", instId: "BTC-USDT-SWAP" });
    expect(r).toEqual({ leverage: 5, marginMode: "cross", native: { instId: "BTC-USDT-SWAP", lever: "5", mgnMode: "cross", posSide: "" } });
    const iso = said(await t.setLeverage!("BTC/USDT:USDT", 5, "isolated"), ALL_SECRETS);
    const big = said(await t.setLeverage!("BTC/USDT:USDT", 101), ALL_SECRETS);
    const spotLev = said(await t.setLeverage!("BTC/USDT", 2), ALL_SECRETS);
    expect([iso.message, big.message, spotLev.message, seen.length]).toEqual(["OKX: OKX takes the margin mode on each order, and the account's orders there go in cross margin: the leverage it sets is cross", "OKX: it takes at most 100x in BTC/USDT perpetual", "OKX: leverage is set on a perpetual or a future; BTC/USDT spot is spot", 1]);
  });

  it("Binance leverage: the margin type per symbol, then the leverage; a margin type already set is not a refusal", async () => {
    const { t, seen, answer } = binance();
    answer({ status: 400, body: { code: -4046, msg: "No need to change margin type." } }, { body: { leverage: 5, maxNotionalValue: "50000000", symbol: "BTCUSDT" } });
    const r = ok(await t.setLeverage!("BTC/USDT:USDT", 5, "isolated"));
    expect(seen.map((q) => `${q.method} ${q.url}`)).toEqual(["POST https://fapi.binance.com/fapi/v1/marginType", "POST https://fapi.binance.com/fapi/v1/leverage"]);
    expect([form(seen[0]!.body).marginType, form(seen[1]!.body).leverage]).toEqual(["ISOLATED", "5"]);
    expect([r.leverage, r.marginMode]).toEqual([5, "isolated"]);
  });

  it("Bybit leverage: set-leverage, a leverage already set is not a refusal; a unified account's margin mode is the whole account's, so it is refused", async () => {
    const { t, seen, answer } = bybitBoth();
    answer({ body: { retCode: 110043, retMsg: "Set leverage not modified", result: {}, retExtInfo: {}, time: 1 } });
    const r = ok(await t.setLeverage!("BTC/USDT:USDT", 5));
    expect([seen[0]!.url, JSON.parse(seen[0]!.body!)]).toEqual(["https://api.bybit.com/v5/position/set-leverage", { symbol: "BTCUSDT", buyLeverage: "5", sellLeverage: "5", category: "linear" }]);
    expect(r.leverage).toBe(5);
    const mm = said(await t.setLeverage!("BTC/USDT:USDT", 5, "isolated"), ALL_SECRETS);
    expect([mm.message, seen.length]).toEqual(["Bybit: Bybit sets a unified account's margin mode for the whole account, not one market: set it at Bybit, then set the leverage here without one", 1]);
  });

  it("no exchange here has a close of its own: the account closes with a reduce-only order; Coinbase and Kraken list no positions and set no leverage", () => {
    for (const t of [okx().t, binance().t, bybit(true).t, coinbase().t, kraken().t]) expect(t.close).toBeUndefined();
    for (const t of [coinbase().t, kraken().t]) expect([t.positions, t.setLeverage]).toEqual([undefined, undefined]);
    for (const t of [okx().t, binance().t, bybit(true).t, coinbase().t, kraken().t]) expect(typeof t.amend).toBe("function");
  });
});
