/** The wallet's one view: the account and the agent's identity, where the
 * money is, what the agent may touch (grants), who enforces what. */
import { CATALOG, KIND_LABEL, KEY_LABEL, RAIL_LABEL, SEAT_LABEL, type Connector } from "./catalog.ts";
import { compilePolicy, dailyOutUsd, exposureUsd, grantsOf, isExpired, type CompiledRestriction, type FloatState, type Grant, type WalletPolicy } from "./policy.ts";

export interface Transfer {
  id: string;
  direction: "out" | "in";
  venue: string;
  asset: string;
  amount: number;
  at: string;
  purpose?: string | undefined;
}

export interface WalletState {
  /** the user's smart account (an EIP-7702-upgraded EOA in the blueprint) */
  address: string;
  /** the agent's own session key: never holds funds, only signs inside the grants */
  agentKey: string;
  balances: Record<string, number>;
  transfers: Transfer[];
}

export type ConnectorStatus = "connected" | "catalog";

export interface ConnectorView extends Connector {
  status: ConnectorStatus;
  kindLabel: string;
  keyLabel: string;
  railLabel: string;
  seatLabel: string;
  floatCap: number | null;
  net: number;
  revoked: boolean;
}

export interface WalletOverview {
  account: { smartAccount: string; agentKey: string; mode: WalletPolicy["mode"]; custody: "non-custodial" };
  now: string;
  session: { expiresAt: string; expired: boolean };
  home: { balances: Record<string, number>; totalUsd: number };
  floats: Array<FloatState & { name: string; pct: number }>;
  exposure: { used: number; cap: number; pct: number };
  daily: { used: number; cap: number; pct: number };
  grants: Grant[];
  connectors: ConnectorView[];
  compiled: CompiledRestriction[];
  policy: WalletPolicy;
  transfers: Transfer[];
}

export function floatsOf(policy: WalletPolicy, transfers: Transfer[]): Record<string, FloatState> {
  const out: Record<string, FloatState> = {};
  for (const [venue, cap] of Object.entries(policy.floats)) {
    const o = transfers.filter((t) => t.venue === venue && t.direction === "out").reduce((s, t) => s + t.amount, 0);
    const i = transfers.filter((t) => t.venue === venue && t.direction === "in").reduce((s, t) => s + t.amount, 0);
    out[venue] = { venue, cap, out: Number(o.toFixed(2)), in: Number(i.toFixed(2)), net: Number((o - i).toFixed(2)) };
  }
  return out;
}

/** stablecoins count 1:1; nothing else is held at home in this skeleton */
const USD_LIKE = new Set(["USDC", "USDT", "USDC.e", "USD"]);
const pctOf = (used: number, cap: number) => (Number.isFinite(cap) && cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0);

export function buildOverview(state: WalletState, policy: WalletPolicy, now: string, catalog: Connector[] = CATALOG): WalletOverview {
  const floats = floatsOf(policy, state.transfers);
  const used = exposureUsd(floats);
  const daily = dailyOutUsd(state.transfers, now);
  const totalUsd = Number(Object.entries(state.balances).filter(([a]) => USD_LIKE.has(a)).reduce((s, [, n]) => s + n, 0).toFixed(2));
  const connectors: ConnectorView[] = catalog.map((c) => {
    const cap = c.rail === "fiat" ? null : (policy.floats[c.id] ?? null);
    return {
      ...c,
      status: cap !== null ? "connected" : "catalog",
      kindLabel: KIND_LABEL[c.kind],
      keyLabel: KEY_LABEL[c.keyModel],
      railLabel: RAIL_LABEL[c.rail],
      seatLabel: SEAT_LABEL[c.seat],
      floatCap: cap,
      net: floats[c.id]?.net ?? 0,
      revoked: policy.revoked.includes(c.id),
    };
  });
  return {
    account: { smartAccount: state.address, agentKey: state.agentKey, mode: policy.mode, custody: "non-custodial" },
    now,
    session: { expiresAt: policy.sessionExpiresAt, expired: isExpired(now, policy.sessionExpiresAt) },
    home: { balances: { ...state.balances }, totalUsd },
    floats: Object.values(floats).map((f) => ({ ...f, name: catalog.find((c) => c.id === f.venue)?.name ?? f.venue, pct: pctOf(Math.max(0, f.net), f.cap) })),
    exposure: { used, cap: policy.totalExposureCapUsd, pct: pctOf(used, policy.totalExposureCapUsd) },
    daily: { used: daily, cap: policy.dailyCapUsd, pct: pctOf(daily, policy.dailyCapUsd) },
    grants: grantsOf(policy, floats, catalog),
    connectors,
    compiled: compilePolicy(policy, catalog),
    policy,
    transfers: [...state.transfers].reverse(),
  };
}
