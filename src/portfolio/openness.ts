/** The user's OPENNESS dial — how much of each credential's native scope the
 * agent may use, and when a human is asked. Pure functions.
 *
 * Three layers decide what "maximally open" means, and the wallet owns only
 * the middle one:
 *   1. the credential's native scope (accounts.ts) — the venue enforces it;
 *      the wallet cannot widen it, so E_WALLET_SCOPE is a pre-check that spares
 *      the agent a venue 401 and shows it the same line the venue would draw;
 *   2. this dial — `open`: no wallet-side caps, no cards; the agent reaches the
 *      edge of every credential. The one thing that still stops to ask is a
 *      `move` to an address the user has never used (the MetaMask blueprint:
 *      beast skips policy but still blocks malicious transactions).
 *      `guard`: every write above the account's free allowance is a card, and
 *      the daily cap is a hard line. Per-account reach narrows further;
 *      revocation leaves only reads. Reads are never gated by anything here.
 *   3. the venue's own second line — what the adapter returns when a write is
 *      tried anyway (bypass): -2015, rc 57, a revert, a 403.
 */
import type { Refusal } from "../core/errors.ts";
import { no } from "./refuse.ts";
import { CAP_LABEL, ENFORCER_LABEL, KIND_LABEL, WRITE_CAPS, capabilityOf, destinationOf, usdOf, type Account, type Capability, type Intent, type ScopeEnforcer } from "./accounts.ts";
import { eventState, parseEventSymbol } from "./events.ts";

export type Mode = "open" | "guard";

export const MODE_LABEL: Record<Mode, string> = {
  open: "Open: the agent reaches the edge of every credential; no wallet-side caps, no cards. It still asks before the dangerous ones: a transfer to a never-used address, an order in a market that is past its close and not yet resolved",
  guard: "Guard: each account has a no-ask allowance; above it the write waits on a card. The daily cap is a hard line",
};

export interface GuardKnobs {
  /** USD per write the agent may do without a card, unless the account has its own line */
  defaultCardAboveUsd: number;
  cardAboveUsd: Record<string, number>;
  /** USD the agent may move in any rolling 24 h, all accounts together — a refusal, not a card */
  dailyCapUsd: number;
}

export interface Openness {
  mode: Mode;
  /** per account, the write capabilities the user opened; missing = everything the credential can do */
  reach: Record<string, Capability[]>;
  /** accounts whose grant the user pulled; reads continue */
  revoked: string[];
  /** destinations the user has used before; a `move` anywhere else is a card even in open mode */
  knownDestinations: string[];
  blocklist: string[];
  guard: GuardKnobs;
  sessionExpiresAt: string;
  /** the most leverage an agent may set on a perpetual (live-orders.ts); 1 unless the owner signed more */
  maxLeverage?: number | undefined;
}

export function parseOpenness(raw: unknown): Openness {
  const o = (raw ?? {}) as Partial<Omit<Openness, "guard">> & { guard?: Partial<GuardKnobs> };
  return {
    mode: o.mode === "guard" ? "guard" : "open",
    reach: Object.fromEntries(Object.entries(o.reach ?? {}).map(([k, v]) => [k, [...v]])),
    revoked: [...(o.revoked ?? [])],
    knownDestinations: [...(o.knownDestinations ?? [])],
    blocklist: [...(o.blocklist ?? [])],
    guard: {
      defaultCardAboveUsd: o.guard?.defaultCardAboveUsd ?? 0,
      cardAboveUsd: { ...(o.guard?.cardAboveUsd ?? {}) },
      dailyCapUsd: o.guard?.dailyCapUsd ?? Number.POSITIVE_INFINITY,
    },
    sessionExpiresAt: o.sessionExpiresAt ?? "2099-01-01T00:00:00Z",
  };
}

export function isExpired(now: string, until: string): boolean {
  return Date.parse(now) >= Date.parse(until);
}

/** what the agent may actually do at an account: native scope ∩ the user's reach; a revoked account keeps only `read` */
export function effectiveReach(a: Account, o: Openness): Capability[] {
  if (o.revoked.includes(a.id)) return a.scope.can.filter((c) => c === "read");
  const r = o.reach[a.id];
  return a.scope.can.filter((c) => c === "read" || !r || r.includes(c));
}

/** why a write waits for the human: a never-used address · a prediction market past its close and not yet resolved · the Guard allowance · a first payment to a payee the owner has not paid before (the account layer) */
/** `live`: real money at a venue connected live — the owner signs every one */
export type AskReason = "stranger" | "awaiting" | "allowance" | "payee" | "live";

export interface Card {
  why: AskReason;
  reason: string;
}

export type Verdict = { ok: true; capability: Capability; usd: number; card: Card | null } | Refusal;

export interface EvaluateInput {
  intent: Intent;
  account: Account;
  openness: Openness;
  now: string;
  /** USD the agent already moved in the last 24 h (guard's daily cap) */
  dailyOutUsd: number;
  /** when this intent is one slice of a split order: the WHOLE order's notional. Guard judges the free allowance against it, so splitting an order can never slip it under the line */
  orderUsd?: number | undefined;
}

/** write order: session → revoked → credential scope → user reach → blocklist → the dangerous ones (a stranger address, a market past its close) = card in ANY mode · guard: daily cap, then a card above the free allowance (a slice of a split order is judged by the whole order) */
export function evaluate(i: EvaluateInput): Verdict {
  const cap = capabilityOf(i.intent);
  const a = i.account;
  const o = i.openness;
  const tool = `portfolio_${cap}`;
  if (isExpired(i.now, o.sessionExpiresAt)) {
    return no("E_WALLET_SESSION_EXPIRED", { venue: a.id, tool, message: "the agent's session has expired: every write stops, reads continue", detail: { sessionExpiresAt: o.sessionExpiresAt, now: i.now } });
  }
  if (o.revoked.includes(a.id)) {
    return no("E_WALLET_ACCOUNT_REVOKED", { venue: a.id, tool, message: `${a.name} is switched off for the agent: reads only`, detail: { revoked: o.revoked } });
  }
  if (!a.scope.can.includes(cap)) {
    return no("E_WALLET_SCOPE", {
      venue: a.id,
      tool,
      message: `the ${a.name} credential itself cannot ${CAP_LABEL[cap]} (${a.scope.limits[0] ?? a.credentialKind}): no wallet setting can open what the credential does not have`,
      detail: { can: a.scope.can, want: cap, enforcedBy: a.scope.enforcedBy },
    });
  }
  const reach = o.reach[a.id];
  if (reach && !reach.includes(cap)) {
    return no("E_WALLET_REACH", { venue: a.id, tool, message: `the user opened only "${reach.map((c) => CAP_LABEL[c]).join(" / ") || "read"}" to the agent: "${CAP_LABEL[cap]}" is not in it`, detail: { reach, want: cap } });
  }
  const dest = destinationOf(i.intent);
  if (dest && o.blocklist.includes(dest)) {
    return no("E_WALLET_BLOCKLIST", { venue: a.id, tool, message: `${dest} is on the user's blocklist`, detail: { destination: dest, blocklist: o.blocklist } });
  }
  const usd = usdOf(i.intent);
  const stranger = i.intent.kind === "move" && !o.knownDestinations.includes(i.intent.to);
  // a prediction market past its close and not yet resolved: the book is still open, but its price is not odds — a resolution can surprise
  const market = i.intent.kind === "trade" ? parseEventSymbol(i.intent.symbol)?.event : undefined;
  const awaiting = market !== undefined && eventState(market, i.now) === "awaiting";
  const dangerous: Card | null = stranger
    ? { why: "stranger", reason: `a transfer of $${usd} to an address never used before (${dest}): open mode still stops to ask about this one` }
    : awaiting
      ? { why: "awaiting", reason: `an order in "${market.title}", which closed on ${market.closesAt.slice(0, 10)} and is not yet resolved: the price there is not odds, so open mode still stops to ask` }
      : null;
  if (o.mode === "open") return { ok: true, capability: cap, usd, card: dangerous };
  if (i.dailyOutUsd + usd > o.guard.dailyCapUsd) {
    return no("E_WALLET_DAILY_CAP", { venue: a.id, tool, message: `guard: the agent has moved $${i.dailyOutUsd} in the last 24 h; $${usd} more would pass the daily cap $${o.guard.dailyCapUsd}`, detail: { daily: i.dailyOutUsd, cap: o.guard.dailyCapUsd, amount: usd } });
  }
  const above = o.guard.cardAboveUsd[a.id] ?? o.guard.defaultCardAboveUsd;
  const judged = i.orderUsd ?? usd;
  const card: Card | null = dangerous ?? (judged > above ? { why: "allowance", reason: i.orderUsd === undefined ? `guard: $${usd} is above ${a.name}'s no-ask allowance $${above}` : `guard: this order totals $${judged} (its slices are counted together), above ${a.name}'s no-ask allowance $${above}` } : null);
  return { ok: true, capability: cap, usd, card };
}

// ---- the three-layer table the UI and the README show -------------------------

export interface OpennessRow {
  account: string;
  name: string;
  kind: string;
  credentialRef: string;
  credentialKind: string;
  /** layer 1: what the credential can do, who enforces it */
  layer1: { can: Capability[]; limits: string[]; enforcedBy: ScopeEnforcer; enforcerLabel: string };
  /** layer 2: what the user opened, what the wallet still keeps */
  layer2: { opened: Capability[]; closed: Capability[]; revoked: boolean; walletKeeps: string[] };
  /** layer 3: the venue's own second line, in its vocabulary */
  layer3: string;
}

const SECOND_LINE: Record<ScopeEnforcer, string> = {
  venue: "the exchange checks again itself: key permissions, IP, withdrawal whitelist (-2015 · -4026 · 50114)",
  issuer: "the transfer-restriction contract reverts: recipient not on the KYC allowlist",
  metamask: "MetaMask Guard: over the 24 h outflow or off the allowlist → MFA by email; malicious transactions are blocked even in beast mode",
};

export function compileOpenness(accounts: Account[], o: Openness): OpennessRow[] {
  return accounts.map((a) => {
    const opened = effectiveReach(a, o);
    const closed = a.scope.can.filter((c) => !opened.includes(c));
    const revoked = o.revoked.includes(a.id);
    const walletKeeps: string[] = [];
    if (revoked) walletKeeps.push("switched off: reads only");
    else if (o.mode === "open") walletKeeps.push(a.scope.can.includes("move") ? "no caps · no cards · asks before a transfer to a new address" : a.kind === "prediction" ? "no caps · no cards · asks before an order in a market past its close" : "no caps · no cards");
    else {
      const above = o.guard.cardAboveUsd[a.id] ?? o.guard.defaultCardAboveUsd;
      walletKeeps.push(`no-ask ≤ $${above}, a card above it`, `daily cap $${Number.isFinite(o.guard.dailyCapUsd) ? o.guard.dailyCapUsd : "∞"} (all accounts together)`);
    }
    if (o.blocklist.length) walletKeeps.push(`blocklist: ${o.blocklist.length} address${o.blocklist.length === 1 ? "" : "es"}`);
    return {
      account: a.id,
      name: a.name,
      kind: KIND_LABEL[a.kind],
      credentialRef: a.credentialRef,
      credentialKind: a.credentialKind,
      layer1: { can: a.scope.can, limits: a.scope.limits, enforcedBy: a.scope.enforcedBy, enforcerLabel: ENFORCER_LABEL[a.scope.enforcedBy] },
      layer2: { opened, closed, revoked, walletKeeps },
      layer3: SECOND_LINE[a.scope.enforcedBy],
    };
  });
}

export { WRITE_CAPS };
