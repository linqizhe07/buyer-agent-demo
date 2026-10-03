/** Kalshi as one account among the others: a CFTC-regulated prediction
 * exchange, in-memory. The credential is an API key id whose requests are
 * signed with an RSA key; it reads and trades. Money does not move through it:
 * deposits and payouts go by ACH or debit card from the account page, so the
 * credential's scope has no `move` at all. Contracts are whole numbers, priced
 * in cents, and settle by the exchange's own rulebook. The fee is Kalshi's
 * published 0.07 × C × P × (1 − P), rounded up to the cent. Error codes are
 * illustrative; the shapes are real. */
import { priceOf, r2, r8, type Account, type AccountAdapter, type Holding, type Intent } from "../accounts.ts";
import { eventState, parseEventSymbol } from "../events.ts";
import { no } from "../refuse.ts";
import { fillAt } from "../venues.ts";

export interface KalshiSeed {
  usd: number;
  positions: Array<{ symbol: string; shares: number }>;
  /** the most one market may hold, in USD at cost */
  positionLimitUsd: number;
}

export function kalshiAccount(seed: KalshiSeed, now: () => string): AccountAdapter {
  let usd = seed.usd;
  const positions = new Map<string, number>(seed.positions.map((p) => [p.symbol, p.shares]));
  let seq = 0;
  const account: Account = {
    id: "kalshi",
    name: "Kalshi",
    kind: "prediction",
    provider: "Kalshi (CFTC-regulated exchange)",
    credentialRef: "home/credentials/kalshi/api-key.json",
    credentialKind: "API key id + RSA-PSS signed requests",
    scope: {
      can: ["read", "trade"],
      limits: ["deposits and payouts go by ACH or debit card from the account page, never through the API: this key cannot move money", "whole contracts only, priced 1–99¢", `position limit $${seed.positionLimitUsd.toLocaleString("en-US")} per market`, "a regulated exchange: the account belongs to a verified US person"],
      enforcedBy: "venue",
    },
    settlement: "fills instantly · settles by the exchange's rulebook · $1 per winning contract",
    live: false,
  };
  const reject = (code: string, message: string, native: string) => no("E_VENUE_REJECTED", { venue: "kalshi", message, native: { error: { code, message: native } } });
  return {
    account,
    async read(): Promise<Holding[]> {
      const rows: Holding[] = [];
      if (usd > 0) rows.push({ account: account.id, asset: "USD", amount: usd, usd, class: "cash" });
      for (const [symbol, shares] of positions) {
        const p = parseEventSymbol(symbol);
        if (shares > 0) rows.push({ account: account.id, asset: symbol, amount: shares, usd: r2(shares * priceOf(symbol)), class: "event", note: p ? `${p.event.title} · ${p.outcome} · closes ${p.event.closesAt.slice(0, 10)}` : undefined });
      }
      return rows;
    },
    async execute(i: Intent) {
      if (i.kind === "move") return no("E_VENUE_PERMISSION", { venue: "kalshi", message: "Kalshi: the API has no way to move money; deposits and payouts go by ACH from the account page", native: { status: 404, error: { code: "not_found", message: "no such endpoint" } } });
      if (i.kind !== "trade") return reject("invalid_request", `a Kalshi account has no "${i.kind}" action`, "unsupported action");
      const p = parseEventSymbol(i.symbol);
      const listing = p?.event.listings.kalshi;
      if (!p || !listing) return reject("market_not_found", `Kalshi lists no market for ${i.symbol}`, "market not found");
      if (eventState(p.event, now()) !== "open") return no("E_VENUE_MARKET_CLOSED", { venue: "kalshi", message: `${listing.ticker} is closed: Kalshi takes no orders after a market's close`, native: { error: { code: "market_closed", message: "market is closed" } } });
      if (!Number.isInteger(i.qty)) return reject("invalid_order", "Kalshi trades whole contracts only", "count must be a whole number");
      const f = fillAt("kalshi", i.symbol, i.side, i.qty);
      if (!f) return reject("insufficient_liquidity", "the book is not deep enough for this order", "order could not be filled (IOC)");
      const held = positions.get(i.symbol) ?? 0;
      if (i.side === "buy") {
        if (r2(held * priceOf(i.symbol) + f.grossUsd) > seed.positionLimitUsd) return reject("position_limit_exceeded", `this would pass Kalshi's $${seed.positionLimitUsd.toLocaleString("en-US")} position limit for the market`, "position limit exceeded");
        if (usd < f.netUsd) return no("E_VENUE_INSUFFICIENT", { venue: "kalshi", native: { error: { code: "insufficient_balance", message: "insufficient balance" } } });
        usd = r2(usd - f.netUsd);
        positions.set(i.symbol, r8(held + i.qty));
      } else {
        if (held < i.qty) return no("E_VENUE_INSUFFICIENT", { venue: "kalshi", native: { error: { code: "insufficient_position", message: "not enough contracts to sell" } } });
        positions.set(i.symbol, r8(held - i.qty));
        usd = r2(usd + f.netUsd);
      }
      const order_id = `kx-${String(++seq).padStart(4, "0")}`;
      return { ok: true as const, account: account.id, status: "filled" as const, summary: `${i.side.toUpperCase()} ${i.qty} ${listing.ticker} ${p.outcome} @ ${Math.round(f.price * 1000) / 10}¢ · fee ${f.feeUsd}`, usd: f.grossUsd, ref: `kalshi:order:${order_id}`, native: { order_id, status: "executed", price: f.price, grossUsd: f.grossUsd, feeUsd: f.feeUsd, netUsd: f.netUsd, impactBps: f.impactBps } };
    },
  };
}
