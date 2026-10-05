/** Rails: how money gets from where it sits to where it is needed, with a price
 * and a clock. Liquidity here is not only an amount — it is amount × time ×
 * cost. Three things live in this file:
 *
 *   bridgeQuotes   candidate cross-chain routes for a stablecoin: a simulated
 *                  table shaped like a bridge aggregator's answer — a
 *                  market-maker bridge that is fast and priced in bps, CCTP
 *                  that is a flat fee and waits for finality, the canonical
 *                  L2 → L1 bridge that costs only gas and takes seven days
 *   routesToHub    every way one holding can reach the hub chain, OPEN or
 *                  CLOSED — a closed route keeps its quote, so the user sees
 *                  what opening that runway would buy
 *   ladder         the liquidity ladder: holdings bucketed by how soon they can
 *                  be at the hub (now · minutes · T+1 · days · closed)
 *
 * The hub is Ethereum because that is where the RWA issuer settles. Fees and
 * times are illustrative; when the MetaMask wallet is live and funded the
 * bridge quotes come from `mm swap quote` instead (adapters/metamask.ts).
 */
import { r2, type AccountKind, type Capability, type Holding, type RouteQuote } from "./accounts.ts";

export type { RouteQuote };

export const HUB_CHAIN = "Ethereum";
const CHAINS = new Set(["Ethereum", "Base", "Polygon", "Arbitrum", "Optimism"]);
const ROLLUPS = new Set(["Base", "Arbitrum", "Optimism"]);

export type Bucket = "now" | "minutes" | "t1" | "days" | "closed";
export const BUCKET_LABEL: Record<Bucket, string> = { now: "Now", minutes: "Minutes", t1: "T+1", days: "Days", closed: "Closed" };
const BUCKET_ORDER: Bucket[] = ["now", "minutes", "t1", "days", "closed"];

export function etaLabel(sec: number): string {
  if (sec <= 60) return "instant";
  if (sec < 3600) return `~${Math.round(sec / 60)} min`;
  if (sec <= 2 * 86400) return "T+1";
  return `${Math.round(sec / 86400)} days`;
}

export function bucketOf(sec: number): Exclude<Bucket, "closed"> {
  if (sec <= 60) return "now";
  if (sec < 3600) return "minutes";
  if (sec <= 2 * 86400) return "t1";
  return "days";
}

/** what a CEX charges to turn a stablecoin into USDC and send it to the hub chain */
export function cexWithdrawFee(usd: number): number {
  return r2(usd * 0.001 + 4.5);
}

/** the canonical bridge is the rollup's own exit to Ethereum: it exists only from an L2 to L1 */
export function bridgeQuotes(usd: number, toChain: string = HUB_CHAIN, fromChain: string = "Base"): RouteQuote[] {
  const all: RouteQuote[] = [
    { id: "lp", label: "liquidity bridge", feeUsd: r2(usd * 0.0005 + 0.4), etaSec: 120, open: true, source: "sim" },
    { id: "cctp", label: "CCTP (native USDC)", feeUsd: 1.2, etaSec: 900, open: true, source: "sim" },
    { id: "canonical", label: "canonical bridge", feeUsd: 2.5, etaSec: 7 * 86400, open: true, source: "sim" },
  ];
  return toChain === HUB_CHAIN && ROLLUPS.has(fromChain) ? all : all.filter((q) => q.id !== "canonical");
}

/** the best OPEN route: by cost then time, or by time then cost */
export function pick(quotes: RouteQuote[], strategy: "cost" | "speed" = "cost"): RouteQuote | undefined {
  return quotes.filter((q) => q.open).sort((a, b) => (strategy === "cost" ? a.feeUsd - b.feeUsd || a.etaSec - b.etaSec : a.etaSec - b.etaSec || a.feeUsd - b.feeUsd))[0];
}

/** what the rails need to know about an account: where it is, what the agent may do there now, what it holds */
export interface RailAccount {
  id: string;
  name: string;
  kind: AccountKind;
  chain?: string | undefined;
  /** scope ∩ reach; a revoked account keeps only `read` */
  reach: Capability[];
  revoked: boolean;
  holdings: Holding[];
  /** why the venue closed a capability for this credential (see Account.closed) */
  closed?: Partial<Record<Capability, string>> | undefined;
}

export function chainOf(a: RailAccount, h: Pick<Holding, "note">): string | undefined {
  return h.note && CHAINS.has(h.note) ? h.note : a.chain;
}

const route = (id: string, label: string, feeUsd: number, etaSec: number, open: boolean, why: string): RouteQuote => ({ id, label, feeUsd, etaSec, open, why: open ? undefined : why, source: "sim" });

/** every way one holding can reach the hub chain — open routes and closed ones, each with its quote */
export function routesToHub(a: RailAccount, h: Pick<Holding, "asset" | "usd" | "class" | "note">, accounts: RailAccount[]): RouteQuote[] {
  if (a.revoked) return [route("off", "account switched off", 0, 0, false, "switched off")];
  const may = (c: Capability) => a.reach.includes(c);
  switch (a.kind) {
    case "rwa":
      if (h.class === "rwa") return [route("redeem", "redeem to USDC", 0, 86400, may("redeem"), "redemption not opened")];
      return [route("same-chain", `already on ${HUB_CHAIN}`, 0, 0, may("move") || may("subscribe"), "not opened")];
    case "agent-wallet": {
      if (chainOf(a, h) === HUB_CHAIN) return [route("same-chain", `already on ${HUB_CHAIN}`, 0, 0, may("move"), "transfers not opened")];
      const bridges = bridgeQuotes(h.usd).map((q) => (may("move") ? q : { ...q, open: false, why: "transfers not opened" }));
      const hops = accounts.filter((c) => c.kind === "cex").map((c) => route(`cex:${c.id}`, `via ${c.name}`, 4.5, 900, may("move") && !c.revoked && c.reach.includes("move"), c.revoked ? "switched off" : "key cannot withdraw"));
      return [...bridges, ...hops];
    }
    case "cex":
      return [route("withdraw", `convert to USDC, withdraw to ${HUB_CHAIN}`, cexWithdrawFee(h.usd), 600, may("move"), "key cannot withdraw")];
    case "prediction": {
      // cash at a prediction venue: Polymarket's pUSD leaves through the relayer and a bridge; Kalshi pays out by ACH only
      if (!a.chain) return [route("ach", "ACH payout", 0, 86400, false, "pays out by ACH, not through the agent")];
      if (chainOf(a, h) === HUB_CHAIN) return [route("same-chain", `already on ${HUB_CHAIN}`, 0, 0, may("move"), "transfers not opened")];
      return bridgeQuotes(h.usd, HUB_CHAIN, chainOf(a, h)).map((q) => ({ ...q, label: `withdraw, then ${q.label}`, open: may("move"), why: may("move") ? undefined : "transfers not opened" }));
    }
    case "bank":
      return [route("ach", "ACH to an on-ramp", 0, 86400, false, "read-only; transfers don't go through the agent")];
    case "broker":
      // cash at a broker leaves by ACH to the linked bank, and only the account holder can start that, at the broker
      return [route("ach", "ACH to the linked bank", 0, 86400, false, "started at the broker, not through the agent")];
    case "perp":
      // a perp DEX lets an agent key trade and move between its own balances; a withdrawal is the owner's signature
      return [route("withdraw", "withdraw over CCTP", 0.2, 300, false, "only the owner's key can withdraw")];
    case "card":
      return [];
  }
}

// ---- the liquidity ladder -----------------------------------------------------

export interface LadderItem {
  account: string;
  name: string;
  asset: string;
  chain?: string | undefined;
  usd: number;
  /** the route this money would take: the best open one, or — when every route is closed — the cheapest closed one */
  route: RouteQuote;
  open: boolean;
}

export interface LadderRow {
  bucket: Bucket;
  label: string;
  usd: number;
  /** what moving the whole row to the hub would cost (open rows only) */
  feeUsd: number;
  items: LadderItem[];
}

export interface Ladder {
  hub: string;
  rows: LadderRow[];
  openUsd: number;
  closedUsd: number;
}

export function ladder(accounts: RailAccount[]): Ladder {
  const byBucket = new Map<Bucket, LadderItem[]>();
  for (const a of accounts) {
    for (const h of a.holdings) {
      if ((h.class !== "stable" && h.class !== "cash" && h.class !== "rwa") || h.usd <= 0 || h.inTransit) continue;
      const routes = routesToHub(a, h, accounts);
      const best = pick(routes, "cost");
      const chosen = best ?? [...routes].sort((x, y) => x.feeUsd - y.feeUsd || x.etaSec - y.etaSec)[0];
      if (!chosen) continue;
      const bucket: Bucket = best ? bucketOf(best.etaSec) : "closed";
      const item: LadderItem = { account: a.id, name: a.name, asset: h.asset, chain: chainOf(a, h), usd: h.usd, route: chosen, open: best !== undefined };
      byBucket.set(bucket, [...(byBucket.get(bucket) ?? []), item]);
    }
  }
  const rows = BUCKET_ORDER.filter((b) => byBucket.has(b)).map((b) => {
    const items = byBucket.get(b)!;
    return { bucket: b, label: BUCKET_LABEL[b], usd: r2(items.reduce((s, x) => s + x.usd, 0)), feeUsd: b === "closed" ? 0 : r2(items.reduce((s, x) => s + x.route.feeUsd, 0)), items };
  });
  return {
    hub: HUB_CHAIN,
    rows,
    openUsd: r2(rows.filter((r) => r.bucket !== "closed").reduce((s, r) => s + r.usd, 0)),
    closedUsd: r2(rows.filter((r) => r.bucket === "closed").reduce((s, r) => s + r.usd, 0)),
  };
}
