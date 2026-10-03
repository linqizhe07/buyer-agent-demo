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
import { refuse, type Refusal } from "../core/errors.ts";
import { CAP_LABEL, ENFORCER_LABEL, KIND_LABEL, WRITE_CAPS, capabilityOf, destinationOf, usdOf, type Account, type Capability, type Intent, type ScopeEnforcer } from "./accounts.ts";

export type Mode = "open" | "guard";

export const MODE_LABEL: Record<Mode, string> = {
  open: "Open：agent 触达每个凭据的边缘，钱包不加额度、不发卡；只有往陌生地址转钱才问人",
  guard: "Guard：每个账户有免审额度，超过就停在一张卡上；日上限是硬线",
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

export interface Card {
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

/** write order: session → revoked → credential scope → user reach → blocklist → open: stranger address = card · guard: daily cap, then card above the free allowance (a slice of a split order is judged by the whole order) */
export function evaluate(i: EvaluateInput): Verdict {
  const cap = capabilityOf(i.intent);
  const a = i.account;
  const o = i.openness;
  const tool = `portfolio_${cap}`;
  if (isExpired(i.now, o.sessionExpiresAt)) {
    return refuse("E_WALLET_SESSION_EXPIRED", { venue: a.id, tool, message: "agent 的开放会话已到期：所有写操作停，读照常", detail: { sessionExpiresAt: o.sessionExpiresAt, now: i.now } });
  }
  if (o.revoked.includes(a.id)) {
    return refuse("E_WALLET_ACCOUNT_REVOKED", { venue: a.id, tool, message: `${a.name} 对 agent 的开放已撤销：只剩读`, detail: { revoked: o.revoked } });
  }
  if (!a.scope.can.includes(cap)) {
    return refuse("E_WALLET_SCOPE", {
      venue: a.id,
      tool,
      message: `${a.name} 的凭据本身做不了「${CAP_LABEL[cap]}」（${a.scope.limits[0] ?? a.credentialKind}）：钱包再开放也开不出凭据没有的权限`,
      detail: { can: a.scope.can, want: cap, enforcedBy: a.scope.enforcedBy },
    });
  }
  const reach = o.reach[a.id];
  if (reach && !reach.includes(cap)) {
    return refuse("E_WALLET_REACH", { venue: a.id, tool, message: `用户只把「${reach.map((c) => CAP_LABEL[c]).join(" / ") || "读"}」开放给了 agent：「${CAP_LABEL[cap]}」不在里面`, detail: { reach, want: cap } });
  }
  const dest = destinationOf(i.intent);
  if (dest && o.blocklist.includes(dest)) {
    return refuse("E_WALLET_BLOCKLIST", { venue: a.id, tool, message: `${dest} 在用户的黑名单里`, detail: { destination: dest, blocklist: o.blocklist } });
  }
  const usd = usdOf(i.intent);
  const stranger = i.intent.kind === "move" && !o.knownDestinations.includes(i.intent.to);
  const strangerCard: Card = { reason: `往一个从没用过的地址转 $${usd}（${dest}）：open 模式下唯一还会停下来问人的动作` };
  if (o.mode === "open") return { ok: true, capability: cap, usd, card: stranger ? strangerCard : null };
  if (i.dailyOutUsd + usd > o.guard.dailyCapUsd) {
    return refuse("E_WALLET_DAILY_CAP", { venue: a.id, tool, message: `guard：24 小时内 agent 已动 $${i.dailyOutUsd}，再动 $${usd} 超过日上限 $${o.guard.dailyCapUsd}`, detail: { daily: i.dailyOutUsd, cap: o.guard.dailyCapUsd, amount: usd } });
  }
  const above = o.guard.cardAboveUsd[a.id] ?? o.guard.defaultCardAboveUsd;
  const judged = i.orderUsd ?? usd;
  const card = stranger ? strangerCard : judged > above ? { reason: i.orderUsd === undefined ? `guard：$${usd} 超过 ${a.name} 的免审额度 $${above}` : `guard：这一单合计 $${judged}（拆单合并计）超过 ${a.name} 的免审额度 $${above}` } : null;
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
  venue: "交易所自己再查一次：key 权限、IP、提币白名单（-2015 · -4026 · 50114）",
  network: "发卡行 / 卡组织按 token 范围拒绝授权（rc 57 · 61 · 65 · 54）",
  bank: "银行聚合 token 只读：任何写都是 403",
  issuer: "转让限制合约 revert：收款地址不在 KYC 白名单",
  metamask: "MetaMask Guard：超 24 h 出金或非白名单 → MFA 邮件；恶意交易即使 beast 也拦",
};

export function compileOpenness(accounts: Account[], o: Openness): OpennessRow[] {
  return accounts.map((a) => {
    const opened = effectiveReach(a, o);
    const closed = a.scope.can.filter((c) => !opened.includes(c));
    const revoked = o.revoked.includes(a.id);
    const walletKeeps: string[] = [];
    if (revoked) walletKeeps.push("已撤销：只剩读");
    else if (o.mode === "open") walletKeeps.push(a.scope.can.includes("move") ? "不加额度 · 不发卡 · 转到陌生地址才问人" : "不加额度 · 不发卡");
    else {
      const above = o.guard.cardAboveUsd[a.id] ?? o.guard.defaultCardAboveUsd;
      walletKeeps.push(`免审 ≤ $${above}，超过停卡`, `日上限 $${Number.isFinite(o.guard.dailyCapUsd) ? o.guard.dailyCapUsd : "∞"}（全部账户合计）`);
    }
    if (o.blocklist.length) walletKeeps.push(`黑名单 ${o.blocklist.length} 条`);
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
