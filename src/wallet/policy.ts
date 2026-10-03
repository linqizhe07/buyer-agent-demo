/** One wallet policy, compiled to each venue's native restriction, plus the
 * two decisions the wallet makes itself: fund a venue, take a float back.
 *
 * The policy is the MetaMask Agent Wallet's four knobs — asset/amount per
 * period, protocol allowlist, time window, revocation — written once:
 *   float per venue · daily cap · total exposure · withdraw whitelist ·
 *   session expiry · per-venue revocation · guard/beast mode.
 * The compile is the "smart" part worth showing: on an EVM chain the same
 * knobs ARE a delegation's caveats (enforced by the chain); on a CEX they
 * become an API-key permission set; on a perp DEX an `approveAgent` with
 * `valid_until`; on Solana a policy signer's allowlist; on an RWA issuer the
 * delegation plus the issuer's own transfer restrictions. The venue enforces
 * what it can; the wallet keeps only what no venue can enforce.
 * Pure functions; the skeleton server and the tests call them.
 */
import { refuse, type Refusal } from "../core/errors.ts";
import { CATALOG, connectorOf, KEY_LABEL, KIND_LABEL, type Connector, type Rail } from "./catalog.ts";

export type WalletMode = "guard" | "beast";

export interface WalletPolicy {
  /** USD that may sit at a venue at once, net of what came back */
  floats: Record<string, number>;
  /** USD that may be out at all venues together */
  totalExposureCapUsd: number;
  /** USD that may leave the wallet in any rolling 24 h */
  dailyCapUsd: number;
  /** labels of addresses a venue may withdraw to; "wallet-main" is the wallet itself */
  withdrawWhitelist: string[];
  sessionExpiresAt: string;
  /** guard: every move needs a card · beast: only suspicious moves go to a human (display only in the skeleton) */
  mode: WalletMode;
  /** venues whose grant the user revoked; funding stops, recalling never does */
  revoked: string[];
}

export function parsePolicy(raw: unknown): WalletPolicy {
  const o = (raw ?? {}) as Partial<WalletPolicy>;
  const floats = { ...(o.floats ?? {}) };
  return {
    floats,
    totalExposureCapUsd: typeof o.totalExposureCapUsd === "number" ? o.totalExposureCapUsd : Object.values(floats).reduce((s, n) => s + n, 0),
    dailyCapUsd: typeof o.dailyCapUsd === "number" ? o.dailyCapUsd : Number.POSITIVE_INFINITY,
    withdrawWhitelist: o.withdrawWhitelist?.length ? [...o.withdrawWhitelist] : ["wallet-main"],
    sessionExpiresAt: o.sessionExpiresAt ?? "2099-01-01T00:00:00Z",
    mode: o.mode === "beast" ? "beast" : "guard",
    revoked: [...(o.revoked ?? [])],
  };
}

export function isExpired(now: string, until: string): boolean {
  return Date.parse(now) >= Date.parse(until);
}

export type Enforcer = "chain" | "venue" | "signer" | "issuer" | "seat" | "wallet";

export const ENFORCER_LABEL: Record<Enforcer, string> = {
  chain: "链上强制（DelegationManager）",
  venue: "场所侧强制",
  signer: "签名器强制",
  issuer: "发行方强制（转让限制）",
  seat: "席位启动时核对",
  wallet: "钱包侧",
};

export interface CompiledRestriction {
  venue: string;
  name: string;
  kind: string;
  keyModel: string;
  /** what the chain / venue / signer / issuer / seat enforces, in its own vocabulary */
  restrictions: string[];
  enforcedBy: Enforcer;
  /** what only the wallet can enforce */
  walletSide: string[];
}

export function compilePolicy(policy: WalletPolicy, catalog: Connector[] = CATALOG): CompiledRestriction[] {
  const home = policy.withdrawWhitelist.join(", ");
  const until = policy.sessionExpiresAt.replace("T", " ").replace(":00Z", "Z");
  const daily = Number.isFinite(policy.dailyCapUsd) ? `$${policy.dailyCapUsd} / 日` : "无日上限";
  return catalog.map((c) => {
    const cap = policy.floats[c.id];
    const revoked = policy.revoked.includes(c.id);
    const walletSide = c.rail === "fiat" ? ["法币轨道不经钱包：没有 float"] : cap !== undefined ? [`float ≤ $${cap}`, `总敞口 ≤ $${policy.totalExposureCapUsd}`, daily, ...(revoked ? ["已撤销：不再注资，仍可提回"] : [])] : ["没有 float：钱包不给它注资"];
    const row = (restrictions: string[], enforcedBy: Enforcer): CompiledRestriction => ({ venue: c.id, name: c.name, kind: KIND_LABEL[c.kind], keyModel: KEY_LABEL[c.keyModel], restrictions, enforcedBy, walletSide });
    const targets = (c.targets ?? ["场所合约"]).join(" · ");
    const delegation = [
      "EIP-7702：用户 EOA 升级为智能账户，钱不动；agent 只拿会话钥匙",
      `ERC-7710 委托 caveats：allowedTargets = ${targets} · spendLimit = float（${daily}）· expiry = ${until}`,
      "DelegationManager 链上强制；用户或授权的 watchdog 随时发 revoke 交易，与任何服务器是否在线无关",
    ];
    if (c.kind === "rwa") {
      const first = c.keyModel === "delegation" ? delegation[1]! : `策略签名器只放行 swap 程序；recipients allowlist = ${home}`;
      return row([first, "代币转让限制（allowlist / ERC-3643）：agent 的智能账户先过发行方 KYC 白名单；issuer 可冻结", "一级申赎只对白名单；赎回 T+1 或锁定期由 issuer 强制"], "issuer");
    }
    switch (c.keyModel) {
      case "delegation":
        return row(delegation, "chain");
      case "clob-key+delegation":
        return row(["CLOB API key：只下单 / 撤单，由钱包签名派生，可随时轮换", delegation[1]!, "市场 allowlist（condition id）· 单市场上限"], "chain");
      case "api-key-permissions":
        return row(["API key 权限：只开 trade（SPOT），不开 WITHDRAW", "IP 白名单 = 席位所在机器", `提币地址白名单 = ${home}`, `key 到期 ≤ ${until}`], "venue");
      case "agent-key":
        return row(["approveAgent：trade-only，不可提币 / 转账 / 再授权", `valid_until = ${until}（场所侧强制）`, `提币只能由主账户发起，且只到 ${home}`], "venue");
      case "policy-signer":
        return row(["programs allowlist = swap / transfer 程序", `recipients allowlist = ${home}`, "per-tx cap · daily cap", `session 到期 = ${until}`], "signer");
      case "api-key-rsa":
        return row(["RSA key：trade / read，不含出入金", "出入金 ACH 经 web：钱包不碰", `key 到期 ≤ ${until}`], "venue");
      case "broker-key":
        return row(["paper key 钉在 paper host（席位启动时核对）", "法币 ACH 不经钱包", "加密单 tif 由插件合同吸收为 gtc / ioc"], "seat");
    }
  });
}

// ---- grants: the MetaMask-style view of the same policy ---------------------

export interface Grant {
  venue: string;
  name: string;
  kind: string;
  /** what the agent may touch there */
  scope: string;
  capUsd: number;
  usedUsd: number;
  expiresAt: string;
  revoked: boolean;
  enforcedBy: Enforcer;
}

export function grantsOf(policy: WalletPolicy, floats: Record<string, FloatState>, catalog: Connector[] = CATALOG): Grant[] {
  const compiled = compilePolicy(policy, catalog);
  return catalog
    .filter((c) => c.rail !== "fiat" && policy.floats[c.id] !== undefined)
    .map((c) => ({
      venue: c.id,
      name: c.name,
      kind: KIND_LABEL[c.kind],
      scope: c.targets ? c.targets.join(" · ") : c.keyModel === "api-key-permissions" ? "API key：SPOT only" : c.keyModel === "agent-key" ? "approveAgent：trade-only" : c.keyModel === "policy-signer" ? "签名器 allowlist" : KEY_LABEL[c.keyModel],
      capUsd: policy.floats[c.id]!,
      usedUsd: Math.max(0, floats[c.id]?.net ?? 0),
      expiresAt: policy.sessionExpiresAt,
      revoked: policy.revoked.includes(c.id),
      enforcedBy: compiled.find((r) => r.venue === c.id)?.enforcedBy ?? "wallet",
    }));
}

// ---- the two decisions the wallet makes itself ------------------------------

export interface FloatState {
  venue: string;
  cap: number;
  out: number;
  in: number;
  net: number;
}

export interface TransferLike {
  direction: "out" | "in";
  amount: number;
  at: string;
}

/** USD that left the wallet in the 24 h before `now` */
export function dailyOutUsd(transfers: TransferLike[], now: string): number {
  const since = Date.parse(now) - 24 * 3600 * 1000;
  return Number(transfers.filter((t) => t.direction === "out" && Date.parse(t.at) > since).reduce((s, t) => s + t.amount, 0).toFixed(2));
}

export interface FundInput {
  venue: string;
  amountUsd: number;
  balances: Record<string, number>;
  floats: Record<string, FloatState>;
  policy: WalletPolicy;
  now: string;
  /** what already left in the last 24 h (default 0) */
  dailyOut?: number;
  catalog?: Connector[];
}

export type FundVerdict = { ok: true; venue: string; asset: string; rail: Rail; chain?: string } | Refusal;

export function exposureUsd(floats: Record<string, FloatState>): number {
  return Number(Object.values(floats).reduce((s, f) => s + Math.max(0, f.net), 0).toFixed(2));
}

/** fund order: session → amount → known venue → connected (rail + float) → revoked → float cap → exposure cap → daily cap → balance */
export function evaluateFund(i: FundInput): FundVerdict {
  const catalog = i.catalog ?? CATALOG;
  const tool = "wallet_fund_request";
  if (isExpired(i.now, i.policy.sessionExpiresAt)) return refuse("E_WALLET_SESSION_EXPIRED", { venue: i.venue, tool, detail: { sessionExpiresAt: i.policy.sessionExpiresAt, now: i.now } });
  if (!(Number(i.amountUsd) > 0)) return refuse("E_WALLET_BAD_AMOUNT", { venue: i.venue, tool });
  const c = connectorOf(i.venue, catalog);
  if (!c) return refuse("E_WALLET_UNKNOWN_VENUE", { venue: i.venue, tool, detail: { known: catalog.map((x) => x.id) } });
  const cap = i.policy.floats[c.id];
  if (c.rail === "fiat" || cap === undefined) {
    return refuse("E_WALLET_NOT_CONNECTED", {
      venue: c.id,
      tool,
      message: c.rail === "fiat" ? `${c.name} 走法币轨道（ACH），不经钱包；在目录里，但钱包不给它注资` : `${c.name} 在目录里，但策略没有给它 float：可接入，未接入`,
      detail: { rail: c.rail, seatMounted: c.seatMounted, hasFloat: cap !== undefined },
    });
  }
  if (i.policy.revoked.includes(c.id)) return refuse("E_WALLET_GRANT_REVOKED", { venue: c.id, tool, message: `${c.name} 的授权已撤销：不再注资，float 仍可提回`, detail: { revoked: i.policy.revoked } });
  const net = i.floats[c.id]?.net ?? 0;
  if (net + i.amountUsd > cap) return refuse("E_WALLET_FLOAT_CAP", { venue: c.id, tool, message: `${c.name} 的 float 会到 $${net + i.amountUsd} > 上限 $${cap}`, detail: { net, cap, amount: i.amountUsd } });
  const exposure = exposureUsd(i.floats);
  if (exposure + i.amountUsd > i.policy.totalExposureCapUsd) return refuse("E_WALLET_EXPOSURE_CAP", { venue: c.id, tool, message: `总敞口会到 $${exposure + i.amountUsd} > 上限 $${i.policy.totalExposureCapUsd}`, detail: { exposure, cap: i.policy.totalExposureCapUsd, amount: i.amountUsd } });
  const daily = i.dailyOut ?? 0;
  if (daily + i.amountUsd > i.policy.dailyCapUsd) return refuse("E_WALLET_DAILY_CAP", { venue: c.id, tool, message: `24 小时内已出 $${daily}，再出 $${i.amountUsd} 超过日上限 $${i.policy.dailyCapUsd}`, detail: { daily, cap: i.policy.dailyCapUsd, amount: i.amountUsd } });
  const balance = i.balances[c.asset] ?? 0;
  if (balance < i.amountUsd) return refuse("E_WALLET_INSUFFICIENT", { venue: c.id, tool, message: `钱包只有 ${balance} ${c.asset}，不够 ${i.amountUsd}`, detail: { asset: c.asset, balance, amount: i.amountUsd } });
  return c.chain ? { ok: true, venue: c.id, asset: c.asset, rail: c.rail, chain: c.chain } : { ok: true, venue: c.id, asset: c.asset, rail: c.rail };
}

export interface RecallInput {
  venue: string;
  amountUsd: number;
  /** where the venue is asked to send it; the venue's whitelist is the real line, this is the wallet's pre-check */
  destination: string;
  floats: Record<string, FloatState>;
  policy: WalletPolicy;
  now: string;
  catalog?: Connector[];
}

export type RecallVerdict = { ok: true; venue: string; asset: string } | Refusal;

/** recall order: amount → known venue → whitelist → float short. A revoked or expired session can still recall: taking money home is never blocked. */
export function evaluateRecall(i: RecallInput): RecallVerdict {
  const catalog = i.catalog ?? CATALOG;
  const tool = "wallet_recall";
  if (!(Number(i.amountUsd) > 0)) return refuse("E_WALLET_BAD_AMOUNT", { venue: i.venue, tool });
  const c = connectorOf(i.venue, catalog);
  if (!c) return refuse("E_WALLET_UNKNOWN_VENUE", { venue: i.venue, tool });
  if (!i.policy.withdrawWhitelist.includes(i.destination)) {
    return refuse("E_VENUE_WITHDRAW_WHITELIST", { venue: c.id, tool, message: `${c.name} 的提币白名单只有 ${i.policy.withdrawWhitelist.join(", ")}；${i.destination} 不在里面`, detail: { destination: i.destination, whitelist: i.policy.withdrawWhitelist } });
  }
  const net = i.floats[c.id]?.net ?? 0;
  if (net < i.amountUsd) return refuse("E_WALLET_FLOAT_SHORT", { venue: c.id, tool, message: `${c.name} 里的 float 只有 $${net}，提不回 $${i.amountUsd}`, detail: { net, amount: i.amountUsd } });
  return { ok: true, venue: c.id, asset: c.asset };
}
