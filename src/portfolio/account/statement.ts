/** The STATEMENT: every transaction at the user's real venues, one line each, the way a bank statement lists them.
 *
 * A line is written to the ledger each time a transaction changes (placed, part filled, filled, canceled; sent, landed, failed), as a row of
 * kind "statement" that carries the line itself. The ledger files outlive the process, so the statement does too: it is read back from every
 * ledger in the account's home, and the last line written for a transaction is the one shown. Nothing here moves anything.
 */
import { notionalOf, plain } from "../live/trade.ts";
import type { LiveOrder } from "./live-orders.ts";
import type { Payment } from "./payments.ts";

export interface StatementLine {
  /** one transaction, whichever run of the account wrote it: an order's client id, or a payment's run and id */
  key: string;
  /** the account's own id for it in the run that made it (ord-0001, pay-0001) */
  id: string;
  at: string;
  /** when it was last seen to change */
  updatedAt: string;
  /** an order · a movement of money · money put into a venue's earn product or taken back out (account/live-earn.ts) */
  type: "trade" | "transfer" | "earn";
  /** buy · sell · withdraw · deposit · send · transfer · swap · bridge */
  kind: string;
  account: string;
  accountName: string;
  /** where the money went, for a transfer */
  to?: string | undefined;
  toName?: string | undefined;
  description: string;
  /** the dollars of it: what a trade has filled for (nothing, while nothing has filled); what a transfer moved. A buy is money out
   * (negative), a sell money in; a transfer between the user's own places is neither, and is shown as it is */
  amountUsd: number;
  /** a trade: what the whole order is worth, at its limit or the price it was valued at */
  worthUsd?: number | undefined;
  feeUsd?: number | undefined;
  status: string;
  /** who did it: you, or an agent — on your yes, or inside its limit */
  by: string;
  /** where an agent did it: its key's address, and its name on the account */
  agent?: string | undefined;
  agentName?: string | undefined;
  /** the venue's id for it, or the transaction's hash */
  ref?: string | undefined;
}

const qty = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 8 });
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** an order, as one line */
export function orderLine(o: LiveOrder, agentName: (address: string) => string): StatementLine {
  const filled = o.filledQty > 0 ? notionalOf(o, o.filledQty, o.avgPrice ?? o.price) : 0;
  const sign = o.side === "buy" ? -1 : 1;
  const done = o.filledQty > 0 && o.filledQty < o.qty ? ` · ${qty(o.filledQty)} of ${qty(o.qty)} filled` : "";
  return {
    key: `order:${o.clientId}`,
    id: o.id,
    at: o.at,
    updatedAt: o.updatedAt,
    type: "trade",
    kind: o.side,
    account: o.venue,
    accountName: o.venueName,
    description: `${cap(o.side)} ${qty(o.qty)} ${o.base}${o.name && o.name !== o.base ? ` · ${o.name}` : ""} · ${o.type === "limit" ? `limit ${plain(o.limitPrice ?? 0)}` : o.type === "stop" ? `stop at ${plain(o.stopPrice ?? 0)}` : o.type === "stop_limit" ? `stop at ${plain(o.stopPrice ?? 0)}, limit ${plain(o.limitPrice ?? 0)}` : "market"}${o.avgPrice ? ` · at ${plain(Number(o.avgPrice.toPrecision(10)))}` : ""}${done}`,
    amountUsd: Number((sign * filled).toFixed(2)) || 0,
    worthUsd: Number(notionalOf(o, o.qty, o.limitPrice ?? o.price).toFixed(2)),
    ...(o.feeUsd !== undefined ? { feeUsd: o.feeUsd } : {}),
    // an order the account stopped following (its venue did not come back after a restart, and the owner asked to cancel it) says so
    status: o.unfollowed ? "not followed since a restart" : o.walletTxs && !o.ref && o.status === "pending" ? "waiting for wallet" : o.status,
    by: o.authority === "agent" ? `${agentName(o.agent ?? "")}, ${o.card ? "approved by you" : "inside its limit"}` : "You",
    ...(o.authority === "agent" && o.agent ? { agent: o.agent, agentName: agentName(o.agent) } : {}),
    ...(o.ref ? { ref: o.ref } : {}),
  };
}

/** a movement of real money, as one line */
export function paymentLine(p: Payment, run: string, name: (venue: string) => string, agentName: (address: string) => string): StatementLine {
  // what the venue was asked to do: withdraw, send, transfer, swap, bridge
  const kind = p.live?.kind ?? p.kind;
  const leg = p.legs[0];
  const where = p.from === p.to ? (leg?.fromLedger ? ` · ${leg.fromLedger} → ${leg.toLedger}` : "") : ` · ${name(p.from)} → ${name(p.to)}`;
  return {
    key: `payment:${run}:${p.id}`,
    id: p.id,
    at: p.at,
    updatedAt: p.settledAt ?? p.at,
    type: "transfer",
    kind,
    account: p.from,
    accountName: name(p.from),
    ...(p.to !== p.from ? { to: p.to, toName: name(p.to) } : {}),
    description: `${cap(kind)} ${p.amountUsd} ${p.sourceToken}${p.token !== p.sourceToken ? ` → ${p.token}` : ""}${where}${p.live?.network ? ` · ${p.live.network}${p.live.toNetwork ? ` → ${p.live.toNetwork}` : ""}` : ""}${p.live?.tool ? ` · via ${p.live.tool}` : ""}`,
    amountUsd: Number(p.amountUsd.toFixed(2)),
    // a fee only once the money has moved; a bridge's is what it really cost: what did not arrive, or its quoted fee if that was more
    ...(p.status === "settled" && p.feeUsd ? { feeUsd: p.live?.kind === "bridge" ? Number(Math.max(p.feeUsd, p.amountUsd - p.receiveUsd).toFixed(2)) : p.feeUsd } : {}),
    status: p.status === "authorized" ? "waiting for wallet" : p.status,
    by: p.authority === "agent" ? `${agentName(p.agent ?? "")}, ${p.card ? "approved by you" : "inside its limit"}` : "You",
    ...(p.authority === "agent" && p.agent ? { agent: p.agent, agentName: agentName(p.agent) } : {}),
    ...(p.live?.txHash ? { ref: p.live.txHash } : leg?.ref ? { ref: leg.ref } : {}),
  };
}

/** the last line written for each transaction, newest first */
export function fold(lines: Iterable<StatementLine>): StatementLine[] {
  const last = new Map<string, { line: StatementLine; first: number }>();
  let n = 0;
  // a transaction keeps the place it first appeared in: two started in the same millisecond stay in the order they were started
  for (const l of lines) last.set(l.key, { line: l, first: last.get(l.key)?.first ?? n++ });
  return [...last.values()].sort((a, b) => (a.line.at < b.line.at ? 1 : a.line.at > b.line.at ? -1 : b.first - a.first)).map((x) => x.line);
}
