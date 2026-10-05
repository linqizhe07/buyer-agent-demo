/** The two views the portfolio manager exists for: one total across every
 * account, and the LIQUIDITY map — where the fuel is. Mobile liquidity is a
 * stablecoin or cash the agent may move to another account or chain; stuck
 * liquidity sits where the credential cannot take it out (a CEX key without
 * WITHDRAW, a broker that moves cash only by an ACH started there, an account
 * the user switched off). */
import { CLASS_LABEL, CLASS_ORDER, KIND_LABEL, r2, type Account, type AccountKind, type AssetClass, type Capability, type Holding } from "./accounts.ts";

export interface ClassSlice {
  class: AssetClass;
  label: string;
  usd: number;
  pct: number;
}

export interface AccountSlice {
  account: string;
  name: string;
  kind: AccountKind;
  kindLabel: string;
  live: boolean;
  usd: number;
  pct: number;
  holdings: Holding[];
}

export interface Aggregate {
  totalUsd: number;
  byClass: ClassSlice[];
  byAccount: AccountSlice[];
}

const pctOf = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

export function aggregate(accounts: Account[], holdings: Holding[]): Aggregate {
  const totalUsd = r2(holdings.reduce((s, h) => s + h.usd, 0));
  const byClass = CLASS_ORDER.map((c) => ({ class: c, label: CLASS_LABEL[c], usd: r2(holdings.filter((h) => h.class === c).reduce((s, h) => s + h.usd, 0)) }))
    .filter((s) => s.usd > 0)
    .map((s) => ({ ...s, pct: pctOf(s.usd, totalUsd) }));
  const byAccount = accounts.map((a) => {
    const hs = holdings.filter((h) => h.account === a.id);
    const usd = r2(hs.reduce((s, h) => s + h.usd, 0));
    return { account: a.id, name: a.name, kind: a.kind, kindLabel: KIND_LABEL[a.kind], live: a.live, usd, pct: pctOf(usd, totalUsd), holdings: hs };
  });
  return { totalUsd, byClass, byAccount };
}

// ---- liquidity: where the fuel is, and which runways are closed --------------

export interface LiquidityInput {
  id: string;
  name: string;
  kind: AccountKind;
  chain?: string | undefined;
  /** what the agent may do there now (scope ∩ reach, revoked → read only) */
  reach: Capability[];
  revoked: boolean;
  holdings: Holding[];
}

export interface LiquiditySource {
  account: string;
  name: string;
  asset: string;
  chain?: string | undefined;
  usd: number;
}

export interface StuckSource extends LiquiditySource {
  /** why the agent cannot move it, in the user's words */
  why: string;
}

export interface Liquidity {
  mobileUsd: number;
  stuckUsd: number;
  mobile: LiquiditySource[];
  stuck: StuckSource[];
}

const CHAINS = new Set(["Ethereum", "Base", "Polygon", "Arbitrum", "Optimism"]);

export function liquidity(accounts: LiquidityInput[]): Liquidity {
  const mobile: LiquiditySource[] = [];
  const stuck: StuckSource[] = [];
  for (const a of accounts) {
    for (const h of a.holdings) {
      if ((h.class !== "stable" && h.class !== "cash") || h.usd <= 0 || h.inTransit) continue;
      const chain = h.note && CHAINS.has(h.note) ? h.note : a.chain;
      const src: LiquiditySource = { account: a.id, name: a.name, asset: h.asset, chain, usd: h.usd };
      if (a.revoked) stuck.push({ ...src, why: "switched off" });
      else if (a.reach.includes("move")) mobile.push(src);
      else stuck.push({ ...src, why: a.kind === "cex" ? "key cannot withdraw" : a.kind === "prediction" ? "pays out by ACH, not through the agent" : a.kind === "broker" ? "leaves by ACH started at the broker" : a.kind === "perp" ? "only the owner's key can withdraw" : "credential cannot transfer out" });
    }
  }
  return { mobileUsd: r2(mobile.reduce((s, x) => s + x.usd, 0)), stuckUsd: r2(stuck.reduce((s, x) => s + x.usd, 0)), mobile, stuck };
}
