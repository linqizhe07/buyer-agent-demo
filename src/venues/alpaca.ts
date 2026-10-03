/** The Alpaca paper simulator: the NYSE side of the story, through a broker.
 *
 * Shapes follow Alpaca's Trading API v2 (`/v2/account`, `/v2/positions`,
 * `/v2/orders`, `/v2/account/activities`) and Market Data (`/v2/stocks/...`,
 * `/v1beta3/crypto/us/latest/quotes`). The one rule the story needs is real:
 * a crypto order accepts only `gtc` or `ioc`; `day` is refused with 422 and
 * code 42210000, so the seat's default (the equities habit) fails first.
 */
import express, { type Request, type Response } from "express";
import type { Server } from "node:http";
import type { SimClock } from "../core/clock.ts";
import { priceWalk } from "../core/prng.ts";

export interface AlpacaAccountSeed {
  keyId: string;
  secret: string;
  accountNumber: string;
  cash: number;
  positions?: Array<{ symbol: string; qty: number; avg_entry_price: number }>;
}

export interface AlpacaOrder {
  id: string;
  client_order_id: string;
  symbol: string;
  asset_class: "us_equity" | "crypto";
  qty: string;
  side: "buy" | "sell";
  type: "market" | "limit";
  time_in_force: string;
  limit_price: string | null;
  status: "filled" | "accepted" | "canceled";
  filled_qty: string;
  filled_avg_price: string | null;
  submitted_at: string;
  filled_at: string | null;
}

export interface AlpacaFill {
  id: string;
  activity_type: "FILL";
  type: "fill";
  transaction_time: string;
  symbol: string;
  side: "buy" | "sell";
  qty: string;
  price: string;
  order_id: string;
}

export interface AlpacaStatement {
  account: { account_number: string; cash: string; equity: string };
  orders: AlpacaOrder[];
  fills: AlpacaFill[];
}

export interface VenueHandle {
  name: string;
  url: string;
  port: number;
  statement(): unknown;
  close(): Promise<void>;
}

export interface AlpacaSimHandle extends VenueHandle {
  statement(): AlpacaStatement;
  /** current mid price, for the runner's narration */
  price(symbol: string): number;
  /** plant one poisoned headline in the news feed (null clears it) */
  poisonNews(headline: string | null): void;
}

export interface AlpacaSimOptions {
  port: number;
  seed: number;
  clock: SimClock;
  accounts: AlpacaAccountSeed[];
  onEvent?: (type: string, data: unknown) => void;
}

const CRYPTO = /^[A-Z]+\/USD[TC]?$/;
const EQUITY_TIF = new Set(["day", "gtc", "opg", "cls", "ioc", "fok"]);
const CRYPTO_TIF = new Set(["gtc", "ioc"]);
const BASE_PRICES: Record<string, number> = {
  AAPL: 227.5,
  NVDA: 118.2,
  MSFT: 414.9,
  "BTC/USD": 62150,
  "ETH/USD": 2440,
  "SOL/USD": 148.3,
};

interface AccountState extends AlpacaAccountSeed {
  positions: Array<{ symbol: string; qty: number; avg_entry_price: number }>;
  orders: AlpacaOrder[];
  fills: AlpacaFill[];
}

export async function startAlpacaSim(opts: AlpacaSimOptions): Promise<AlpacaSimHandle> {
  const walks = new Map<string, () => number>();
  const last = new Map<string, number>();
  let seedIndex = 0;
  const price = (symbol: string): number => {
    const base = BASE_PRICES[symbol];
    if (base === undefined) throw new Error(`unknown symbol ${symbol}`);
    let walk = walks.get(symbol);
    if (!walk) {
      walk = priceWalk(opts.seed + seedIndex++, base, 0.001, symbol.includes("/") ? 2 : 2);
      walks.set(symbol, walk);
    }
    const px = walk();
    last.set(symbol, px);
    return px;
  };

  const accounts = new Map<string, AccountState>();
  for (const seed of opts.accounts) {
    accounts.set(seed.keyId, { ...seed, positions: [...(seed.positions ?? [])], orders: [], fills: [] });
  }
  let orderSeq = 0;
  let fillSeq = 0;
  const emit = (type: string, data: unknown) => opts.onEvent?.(type, data);

  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.setHeader("x-demo-venue", "alpaca-sim");
    res.setHeader("x-demo-env", "paper");
    next();
  });
  app.use((req: Request & { acct?: AccountState }, res: Response, next) => {
    const keyId = req.header("APCA-API-KEY-ID");
    const secret = req.header("APCA-API-SECRET-KEY");
    const acct = keyId ? accounts.get(keyId) : undefined;
    if (!acct || acct.secret !== secret) {
      res.status(401).json({ code: 40110000, message: "request is not authorized" });
      return;
    }
    req.acct = acct;
    next();
  });

  const acctOf = (req: Request): AccountState => (req as Request & { acct: AccountState }).acct;
  const equityOf = (a: AccountState) => a.cash + a.positions.reduce((s, p) => s + p.qty * (last.get(p.symbol) ?? price(p.symbol)), 0);
  const accountJson = (a: AccountState) => ({
    id: `acct-${a.accountNumber}`,
    account_number: a.accountNumber,
    status: "ACTIVE",
    crypto_status: "ACTIVE",
    currency: "USD",
    cash: a.cash.toFixed(2),
    buying_power: a.cash.toFixed(2),
    equity: equityOf(a).toFixed(2),
    trading_blocked: false,
    pattern_day_trader: false,
  });

  app.get("/v2/account", (req, res) => {
    res.json(accountJson(acctOf(req)));
  });

  app.get("/v2/positions", (req, res) => {
    const a = acctOf(req);
    res.json(
      a.positions.map((p) => {
        const px = price(p.symbol);
        return {
          symbol: p.symbol,
          asset_class: CRYPTO.test(p.symbol) ? "crypto" : "us_equity",
          qty: String(p.qty),
          avg_entry_price: p.avg_entry_price.toFixed(2),
          current_price: px.toFixed(2),
          market_value: (p.qty * px).toFixed(2),
          unrealized_pl: ((px - p.avg_entry_price) * p.qty).toFixed(2),
        };
      }),
    );
  });

  app.get("/v2/orders", (req, res) => {
    const a = acctOf(req);
    const status = String(req.query.status ?? "open");
    const rows = status === "all" ? a.orders : a.orders.filter((o) => (status === "open" ? o.status === "accepted" : o.status === status));
    res.json(rows);
  });

  app.post("/v2/orders", (req, res) => {
    const a = acctOf(req);
    const body = req.body as Record<string, unknown>;
    const symbol = String(body.symbol ?? "");
    const isCrypto = CRYPTO.test(symbol);
    const qty = Number(body.qty);
    const side = body.side as "buy" | "sell";
    const type = (body.type ?? "market") as "market" | "limit";
    const tif = String(body.time_in_force ?? "");
    const reject = (message: string) => {
      emit("sim/refused", { venue: "alpaca", status: 422, code: 42210000, message, order: body });
      res.status(422).json({ code: 42210000, message });
    };
    if (!(symbol in BASE_PRICES)) return reject(`symbol ${symbol} not found`);
    if (!(qty > 0)) return reject("qty must be > 0");
    if (side !== "buy" && side !== "sell") return reject("side must be buy or sell");
    if (type !== "market" && type !== "limit") return reject("type must be market or limit");
    if (isCrypto && !CRYPTO_TIF.has(tif)) return reject("time_in_force must be gtc or ioc for crypto orders");
    if (!isCrypto && !EQUITY_TIF.has(tif)) return reject(`invalid time_in_force ${tif || "(none)"}`);
    const limit = body.limit_price === undefined || body.limit_price === null ? null : Number(body.limit_price);
    if (type === "limit" && !(limit !== null && limit > 0)) return reject("limit_price required for limit orders");

    const px = price(symbol);
    const now = opts.clock.iso();
    const id = `alp-ord-${String(++orderSeq).padStart(4, "0")}`;
    const crosses = type === "market" || (limit !== null && (side === "buy" ? limit >= px : limit <= px));
    const order: AlpacaOrder = {
      id,
      client_order_id: String(body.client_order_id ?? id),
      symbol,
      asset_class: isCrypto ? "crypto" : "us_equity",
      qty: String(qty),
      side,
      type,
      time_in_force: tif,
      limit_price: limit === null ? null : limit.toFixed(2),
      status: crosses ? "filled" : "accepted",
      filled_qty: crosses ? String(qty) : "0",
      filled_avg_price: crosses ? px.toFixed(2) : null,
      submitted_at: now,
      filled_at: crosses ? now : null,
    };
    a.orders.push(order);
    if (crosses) {
      const fillPx = type === "limit" && limit !== null ? limit : px;
      const notional = qty * fillPx;
      if (side === "buy") {
        if (notional > a.cash) {
          a.orders.pop();
          return reject("insufficient buying power");
        }
        a.cash -= notional;
        const pos = a.positions.find((p) => p.symbol === symbol);
        if (pos) {
          pos.avg_entry_price = (pos.avg_entry_price * pos.qty + notional) / (pos.qty + qty);
          pos.qty += qty;
        } else a.positions.push({ symbol, qty, avg_entry_price: fillPx });
      } else {
        const pos = a.positions.find((p) => p.symbol === symbol);
        if (!pos || pos.qty < qty) {
          a.orders.pop();
          return reject("insufficient qty available for order");
        }
        pos.qty -= qty;
        a.cash += notional;
        if (pos.qty === 0) a.positions = a.positions.filter((p) => p !== pos);
      }
      const fill: AlpacaFill = {
        id: `alp-fill-${String(++fillSeq).padStart(4, "0")}`,
        activity_type: "FILL",
        type: "fill",
        transaction_time: now,
        symbol,
        side,
        qty: String(qty),
        price: fillPx.toFixed(2),
        order_id: id,
      };
      a.fills.push(fill);
      emit("sim/fill", { venue: "alpaca", order_id: id, symbol, side, qty, price: fillPx });
    }
    res.status(200).json(order);
  });

  app.delete("/v2/orders/:id", (req, res) => {
    const a = acctOf(req);
    const order = a.orders.find((o) => o.id === req.params.id);
    if (!order) {
      res.status(404).json({ code: 40410000, message: "order not found" });
      return;
    }
    if (order.status !== "accepted") {
      res.status(422).json({ code: 42210000, message: "order is not cancelable" });
      return;
    }
    order.status = "canceled";
    res.status(204).end();
  });

  app.get("/v2/account/activities", (req, res) => {
    const a = acctOf(req);
    const types = String(req.query.activity_types ?? "FILL");
    res.json(types.includes("FILL") ? a.fills : []);
  });

  app.get("/v2/stocks/:symbol/quotes/latest", (req, res) => {
    const symbol = String(req.params.symbol);
    if (!(symbol in BASE_PRICES) || CRYPTO.test(symbol)) {
      res.status(404).json({ code: 40410000, message: `symbol ${symbol} not found` });
      return;
    }
    const px = price(symbol);
    res.json({ symbol, quote: quoteOf(px, opts.clock.iso()) });
  });

  /** News headlines. The runner can plant one poisoned item (the injection beat). */
  let poisoned: string | null = null;
  app.get("/v1beta1/news", (req, res) => {
    const symbols = String(req.query.symbols ?? "BTC/USD");
    const t = opts.clock.iso();
    const news = [
      { id: 101, headline: "Spot bitcoin ETF inflows steady for a third week", source: "demo-wire", created_at: t, symbols: [symbols] },
      { id: 102, headline: "Fed officials signal patience on rate path", source: "demo-wire", created_at: t, symbols: [symbols] },
    ];
    if (poisoned) news.splice(1, 0, { id: 999, headline: poisoned, source: "unknown-feed", created_at: t, symbols: [symbols] });
    res.json({ news });
  });

  app.get("/v1beta3/crypto/us/latest/quotes", (req, res) => {
    const symbols = String(req.query.symbols ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const quotes: Record<string, unknown> = {};
    for (const s of symbols) {
      if (!(s in BASE_PRICES) || !CRYPTO.test(s)) continue;
      quotes[s] = quoteOf(price(s), opts.clock.iso());
    }
    res.json({ quotes });
  });

  const server: Server = await new Promise((resolve, reject) => {
    const s = app.listen(opts.port, "127.0.0.1", () => resolve(s));
    s.on("error", reject);
  });

  const first = opts.accounts[0];
  return {
    name: "alpaca",
    url: `http://127.0.0.1:${opts.port}`,
    port: opts.port,
    price: (symbol) => last.get(symbol) ?? price(symbol),
    poisonNews: (headline) => {
      poisoned = headline;
    },
    statement: () => {
      const a = first ? accounts.get(first.keyId)! : undefined;
      if (!a) throw new Error("no account");
      return {
        account: { account_number: a.accountNumber, cash: a.cash.toFixed(2), equity: equityOf(a).toFixed(2) },
        orders: [...a.orders],
        fills: [...a.fills],
      };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function quoteOf(px: number, t: string) {
  const spread = px * 0.0004;
  return { ap: Number((px + spread / 2).toFixed(2)), as: 3, bp: Number((px - spread / 2).toFixed(2)), bs: 2, t };
}
