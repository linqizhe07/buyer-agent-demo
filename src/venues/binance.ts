/** The Binance spot simulator: a centralized exchange whose API keys carry
 * PERMISSIONS (SPOT trade, WITHDRAW) and an IP whitelist.
 *
 * Shapes follow Binance's spot REST API: `X-MBX-APIKEY`, signed endpoints
 * with `timestamp`/`recvWindow` and `signature = HMAC-SHA256(secret, params)`,
 * `/api/v3/order`, `/api/v3/account`, `/api/v3/myTrades`,
 * `/sapi/v1/capital/withdraw/apply`, and the real error codes: -1022 for a bad
 * signature, -1021 for a stale timestamp, -2015 for a key without the
 * permission or from the wrong IP. The source IP is the `X-Demo-Source-IP`
 * header (default 127.0.0.1) so the story can show the whitelist refusing.
 */
import express, { type Request, type Response } from "express";
import { createHmac } from "node:crypto";
import type { Server } from "node:http";
import type { SimClock } from "../core/clock.ts";
import { priceWalk } from "../core/prng.ts";
import type { VenueHandle } from "./alpaca.ts";

export interface BinanceAccountSeed {
  id: string;
  balances: Record<string, number>;
  /** per-coin deposit addresses the venue issued */
  depositAddresses: Record<string, string>;
  /** withdrawals may only go here (the user's main wallet) */
  withdrawWhitelist: string[];
}

export interface BinanceKeySeed {
  apiKey: string;
  secret: string;
  permissions: Array<"SPOT" | "WITHDRAW">;
  ipWhitelist: string[];
  /** the account this key operates */
  account: string;
}

export interface BinanceOrder {
  symbol: string;
  orderId: number;
  clientOrderId: string;
  transactTime: number;
  price: string;
  origQty: string;
  executedQty: string;
  cummulativeQuoteQty: string;
  status: "FILLED" | "NEW" | "CANCELED";
  timeInForce: string;
  type: "MARKET" | "LIMIT";
  side: "BUY" | "SELL";
  fills: Array<{ price: string; qty: string; commission: string; commissionAsset: string }>;
}

export interface BinanceTrade {
  symbol: string;
  id: number;
  orderId: number;
  price: string;
  qty: string;
  quoteQty: string;
  commission: string;
  commissionAsset: string;
  time: number;
  isBuyer: boolean;
}

export interface BinanceStatement {
  balances: Array<{ asset: string; free: string; locked: string }>;
  orders: BinanceOrder[];
  trades: BinanceTrade[];
  deposits: Array<{ coin: string; address: string; amount: string; txId: string; time: number }>;
  withdrawals: Array<{ coin: string; address: string; amount: string; time: number }>;
}

export interface BinanceSimHandle extends VenueHandle {
  statement(): BinanceStatement;
  price(symbol: string): number;
}

export interface BinanceSimOptions {
  port: number;
  seed: number;
  clock: SimClock;
  accounts: BinanceAccountSeed[];
  keys: BinanceKeySeed[];
  onEvent?: (type: string, data: unknown) => void;
}

const SYMBOLS: Record<string, { base: string; quote: string; px: number }> = {
  BTCUSDT: { base: "BTC", quote: "USDT", px: 62150 },
  ETHUSDT: { base: "ETH", quote: "USDT", px: 2440 },
  SOLUSDT: { base: "SOL", quote: "USDT", px: 148.3 },
};

interface AccountState extends BinanceAccountSeed {
  orders: BinanceOrder[];
  trades: BinanceTrade[];
}

interface KeyState extends BinanceKeySeed {
  acct: AccountState;
}

type AuthedRequest = Request & { key?: KeyState; params2?: Record<string, string> };

export async function startBinanceSim(opts: BinanceSimOptions): Promise<BinanceSimHandle> {
  const walks = new Map<string, () => number>();
  const last = new Map<string, number>();
  const price = (symbol: string): number => {
    const s = SYMBOLS[symbol];
    if (!s) throw new Error(`unknown symbol ${symbol}`);
    let w = walks.get(symbol);
    if (!w) {
      w = priceWalk(opts.seed + Object.keys(SYMBOLS).indexOf(symbol), s.px, 0.0009, 2);
      walks.set(symbol, w);
    }
    const px = w();
    last.set(symbol, px);
    return px;
  };
  const accounts = new Map<string, AccountState>();
  for (const a of opts.accounts) accounts.set(a.id, { ...a, balances: { ...a.balances }, orders: [], trades: [] });
  const keys = new Map<string, KeyState>();
  for (const k of opts.keys) {
    const acct = accounts.get(k.account);
    if (!acct) throw new Error(`key ${k.apiKey} names unknown account ${k.account}`);
    keys.set(k.apiKey, { ...k, acct });
  }
  const deposits: BinanceStatement["deposits"] = [];
  const withdrawals: BinanceStatement["withdrawals"] = [];
  let orderSeq = 100000;
  let tradeSeq = 500000;
  const emit = (type: string, data: unknown) => opts.onEvent?.(type, data);

  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use((_req, res, next) => {
    res.setHeader("x-demo-venue", "binance-sim");
    next();
  });

  const fail = (res: Response, http: number, code: number, msg: string, extra?: Record<string, unknown>) => {
    emit("sim/refused", { venue: "binance", code, msg, ...extra });
    res.status(http).json({ code, msg });
  };

  /** merge query + body params (ccxt sends POST params in the body) */
  const paramsOf = (req: Request): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.query)) out[k] = String(v);
    if (req.body && typeof req.body === "object") for (const [k, v] of Object.entries(req.body as Record<string, unknown>)) out[k] = String(v);
    return out;
  };

  /** API key + IP whitelist; the key's permissions are checked per endpoint */
  const apiKeyAuth = (req: AuthedRequest, res: Response, next: () => void) => {
    const apiKey = req.header("X-MBX-APIKEY");
    const key = apiKey ? keys.get(apiKey) : undefined;
    if (!key) return fail(res, 401, -2014, "API-key format invalid.");
    const ip = req.header("X-Demo-Source-IP") ?? "127.0.0.1";
    if (key.ipWhitelist.length && !key.ipWhitelist.includes(ip)) {
      return fail(res, 401, -2015, "Invalid API-key, IP, or permissions for action.", { ip, reason: "ip-not-whitelisted" });
    }
    req.key = key;
    req.params2 = paramsOf(req);
    next();
  };

  const signed = (req: AuthedRequest, res: Response, next: () => void) => {
    const p = req.params2!;
    const { signature, ...rest } = p;
    const ts = Number(rest.timestamp);
    const recv = Number(rest.recvWindow ?? 5000);
    if (!signature) return fail(res, 400, -1022, "Signature for this request is not valid.");
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > recv) return fail(res, 400, -1021, "Timestamp for this request is outside of the recvWindow.");
    const query = Object.entries(rest)
      .map(([k, v]) => `${k}=${v}`)
      .join("&");
    const expected = createHmac("sha256", req.key!.secret).update(query).digest("hex");
    if (expected !== signature) return fail(res, 400, -1022, "Signature for this request is not valid.");
    next();
  };

  const needs = (perm: "SPOT" | "WITHDRAW") => (req: AuthedRequest, res: Response, next: () => void) => {
    if (!req.key!.permissions.includes(perm)) {
      return fail(res, 401, -2015, "Invalid API-key, IP, or permissions for action.", { reason: `missing-${perm}` });
    }
    next();
  };

  app.get("/api/v3/ping", (_req, res) => res.json({}));
  app.get("/api/v3/time", (_req, res) => res.json({ serverTime: Date.now() }));
  app.get("/api/v3/exchangeInfo", (_req, res) =>
    res.json({ symbols: Object.entries(SYMBOLS).map(([symbol, s]) => ({ symbol, baseAsset: s.base, quoteAsset: s.quote, status: "TRADING" })) }),
  );
  app.get("/api/v3/ticker/price", (req, res) => {
    const symbol = String(req.query.symbol ?? "");
    if (!SYMBOLS[symbol]) return fail(res, 400, -1121, "Invalid symbol.");
    res.json({ symbol, price: price(symbol).toFixed(2) });
  });

  app.get("/api/v3/account", apiKeyAuth, signed, (req: AuthedRequest, res) => {
    const k = req.key!;
    res.json({
      canTrade: k.permissions.includes("SPOT"),
      canWithdraw: k.permissions.includes("WITHDRAW"),
      permissions: k.permissions,
      balances: Object.entries(k.acct.balances).map(([asset, free]) => ({ asset, free: free.toFixed(8), locked: "0.00000000" })),
    });
  });

  app.get("/sapi/v1/capital/deposit/address", apiKeyAuth, signed, (req: AuthedRequest, res) => {
    const coin = req.params2!.coin ?? "";
    const address = req.key!.acct.depositAddresses[coin];
    if (!address) return fail(res, 400, -1121, `No deposit address for ${coin}.`);
    res.json({ coin, address, tag: "" });
  });

  /** The chain delivering a deposit to one of this venue's addresses (not an API; what the world does). */
  app.post("/__sim/deposit", (req, res) => {
    const { address, coin, amount, txId } = req.body as { address: string; coin: string; amount: number; txId: string };
    const acct = [...accounts.values()].find((a) => a.depositAddresses[coin] === address);
    if (!acct || !(Number(amount) > 0)) {
      res.status(404).json({ message: "no such deposit address" });
      return;
    }
    acct.balances[coin] = (acct.balances[coin] ?? 0) + Number(amount);
    deposits.push({ coin, address, amount: String(amount), txId, time: opts.clock.now() });
    emit("sim/deposit", { venue: "binance", coin, amount: Number(amount), txId });
    res.json({ credited: true, coin, amount: Number(amount) });
  });

  app.post("/api/v3/order", apiKeyAuth, signed, needs("SPOT"), (req: AuthedRequest, res) => {
    const k = req.key!.acct;
    const p = req.params2!;
    const symbol = p.symbol ?? "";
    const s = SYMBOLS[symbol];
    if (!s) return fail(res, 400, -1121, "Invalid symbol.");
    const side = p.side as "BUY" | "SELL";
    const type = (p.type ?? "MARKET") as "MARKET" | "LIMIT";
    const qty = Number(p.quantity);
    if (!(qty > 0)) return fail(res, 400, -1013, "Filter failure: LOT_SIZE");
    if (side !== "BUY" && side !== "SELL") return fail(res, 400, -1102, "Mandatory parameter 'side' was not sent, was empty/null, or malformed.");
    const limit = p.price !== undefined ? Number(p.price) : undefined;
    if (type === "LIMIT" && !(limit !== undefined && limit > 0)) return fail(res, 400, -1102, "Mandatory parameter 'price' was not sent for LIMIT.");
    const px = price(symbol);
    const crosses = type === "MARKET" || (limit !== undefined && (side === "BUY" ? limit >= px : limit <= px));
    const fillPx = type === "LIMIT" && limit !== undefined ? limit : px;
    const orderId = ++orderSeq;
    const now = opts.clock.now();
    const order: BinanceOrder = {
      symbol,
      orderId,
      clientOrderId: p.newClientOrderId ?? `demo-${orderId}`,
      transactTime: now,
      price: limit !== undefined ? limit.toFixed(2) : "0.00000000",
      origQty: qty.toFixed(8),
      executedQty: crosses ? qty.toFixed(8) : "0.00000000",
      cummulativeQuoteQty: crosses ? (qty * fillPx).toFixed(8) : "0.00000000",
      status: crosses ? "FILLED" : "NEW",
      timeInForce: p.timeInForce ?? "GTC",
      type,
      side,
      fills: [],
    };
    if (crosses) {
      const quoteAmt = qty * fillPx;
      if (side === "BUY") {
        if ((k.balances[s.quote] ?? 0) < quoteAmt) return fail(res, 400, -2010, "Account has insufficient balance for requested action.");
        k.balances[s.quote] = (k.balances[s.quote] ?? 0) - quoteAmt;
        k.balances[s.base] = (k.balances[s.base] ?? 0) + qty;
      } else {
        if ((k.balances[s.base] ?? 0) < qty) return fail(res, 400, -2010, "Account has insufficient balance for requested action.");
        k.balances[s.base] = (k.balances[s.base] ?? 0) - qty;
        k.balances[s.quote] = (k.balances[s.quote] ?? 0) + quoteAmt;
      }
      const commission = (quoteAmt * 0.001).toFixed(8);
      order.fills.push({ price: fillPx.toFixed(2), qty: qty.toFixed(8), commission, commissionAsset: s.quote });
      k.trades.push({
        symbol,
        id: ++tradeSeq,
        orderId,
        price: fillPx.toFixed(2),
        qty: qty.toFixed(8),
        quoteQty: quoteAmt.toFixed(8),
        commission,
        commissionAsset: s.quote,
        time: now,
        isBuyer: side === "BUY",
      });
      emit("sim/fill", { venue: "binance", orderId, symbol, side, qty, price: fillPx });
    }
    k.orders.push(order);
    res.json(order);
  });

  app.delete("/api/v3/order", apiKeyAuth, signed, needs("SPOT"), (req: AuthedRequest, res) => {
    const k = req.key!.acct;
    const orderId = Number(req.params2!.orderId);
    const order = k.orders.find((o) => o.orderId === orderId);
    if (!order) return fail(res, 400, -2011, "Unknown order sent.");
    if (order.status !== "NEW") return fail(res, 400, -2011, "Unknown order sent.");
    order.status = "CANCELED";
    res.json(order);
  });

  app.get("/api/v3/openOrders", apiKeyAuth, signed, (req: AuthedRequest, res) => {
    const symbol = req.params2!.symbol;
    res.json(req.key!.acct.orders.filter((o) => o.status === "NEW" && (!symbol || o.symbol === symbol)));
  });

  app.get("/api/v3/myTrades", apiKeyAuth, signed, (req: AuthedRequest, res) => {
    const symbol = req.params2!.symbol;
    res.json(req.key!.acct.trades.filter((t) => !symbol || t.symbol === symbol));
  });

  app.post("/sapi/v1/capital/withdraw/apply", apiKeyAuth, signed, needs("WITHDRAW"), (req: AuthedRequest, res) => {
    const p = req.params2!;
    const acct = req.key!.acct;
    const amount = Number(p.amount);
    const coin = p.coin ?? "";
    const address = p.address ?? "";
    if (acct.withdrawWhitelist.length && !acct.withdrawWhitelist.includes(address)) {
      return fail(res, 400, -4026, "Withdrawal address is not in the account's whitelist.", { address, reason: "not-whitelisted" });
    }
    if (!(amount > 0) || (acct.balances[coin] ?? 0) < amount) return fail(res, 400, -2010, "Account has insufficient balance for requested action.");
    acct.balances[coin] = Number(((acct.balances[coin] ?? 0) - amount).toFixed(8));
    withdrawals.push({ coin, address, amount: String(amount), time: opts.clock.now() });
    emit("sim/withdrawal", { venue: "binance", coin, amount, address });
    res.json({ id: `wd-${withdrawals.length}` });
  });

  const server: Server = await new Promise((resolve, reject) => {
    const s = app.listen(opts.port, "127.0.0.1", () => resolve(s));
    s.on("error", reject);
  });

  const first = opts.accounts[0];
  return {
    name: "binance",
    url: `http://127.0.0.1:${opts.port}`,
    port: opts.port,
    price: (symbol) => last.get(symbol) ?? price(symbol),
    statement: () => {
      const a = first ? accounts.get(first.id)! : undefined;
      if (!a) throw new Error("no account");
      return {
        balances: Object.entries(a.balances).map(([asset, free]) => ({ asset, free: free.toFixed(8), locked: "0.00000000" })),
        orders: [...a.orders],
        trades: [...a.trades],
        deposits: [...deposits],
        withdrawals: [...withdrawals],
      };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
