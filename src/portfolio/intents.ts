/** What an agent may ask one account to do, parsed leniently and checked strictly: numbers may arrive as strings, and nothing that is not a
 * positive, finite amount of a known thing gets through. The HTTP server parses with these, and so does the account's door (an `agentExecute`
 * carries an intent as free JSON: it is this parse, not the signature, that says it is one). */
import { PRICES, type Intent } from "./accounts.ts";
import { parseEventSymbol } from "./events.ts";
import type { Side } from "./venues.ts";

/** a lenient parse of the intent the MCP server sends; numbers may arrive as strings */
export function parseIntent(raw: unknown): Intent | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  switch (o.kind) {
    case "trade": {
      const qty = num(o.qty);
      const side = str(o.side);
      if (!str(o.symbol) || !(qty > 0) || (side !== "buy" && side !== "sell")) return null;
      const chainId = num(o.chainId);
      return Number.isFinite(chainId) ? { kind: "trade", symbol: str(o.symbol).toUpperCase(), side, qty, chainId } : { kind: "trade", symbol: str(o.symbol).toUpperCase(), side, qty };
    }
    case "move": {
      const amount = num(o.amount);
      if (!str(o.asset) || !(amount > 0) || !str(o.to)) return null;
      const chainId = num(o.chainId);
      return Number.isFinite(chainId) ? { kind: "move", asset: str(o.asset).toUpperCase(), amount, to: str(o.to), chainId } : { kind: "move", asset: str(o.asset).toUpperCase(), amount, to: str(o.to) };
    }
    case "subscribe":
    case "redeem": {
      const amountUsd = num(o.amountUsd);
      if (!str(o.fund) || !(amountUsd > 0)) return null;
      return { kind: o.kind, fund: str(o.fund).toUpperCase(), amountUsd };
    }
    default:
      return null;
  }
}

/** an order for the router: an asset the price table knows or an event contract the catalogue lists, a side, a size */
export function parseOrder(raw: unknown): { base: string; side: Side; qty: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const base = typeof o.base === "string" ? o.base.trim().toUpperCase() : "";
  const known = PRICES[base] !== undefined || parseEventSymbol(base) !== undefined;
  const qty = typeof o.qty === "number" ? o.qty : typeof o.qty === "string" && o.qty.trim() !== "" ? Number(o.qty) : NaN;
  if (!known || !(qty > 0) || (o.side !== "buy" && o.side !== "sell")) return null;
  return { base, side: o.side, qty };
}
