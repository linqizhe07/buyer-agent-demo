/** A Mastercard, in-memory, reached through an AGENTIC TOKEN: a tokenized
 * credential the cardholder issued to this agent with a scope (merchant
 * categories, per-transaction and daily amounts, expiry). The issuer and the
 * network decline outside the scope with ISO-8583 response codes: 57 not
 * permitted to cardholder, 61 exceeds amount limit, 65 exceeds frequency, 54
 * expired, 51 insufficient funds. The token format is illustrative (Agent Pay
 * shaped); the decline codes are the real ones. */
import { refuse } from "../../core/errors.ts";
import { r2, type Account, type AccountAdapter, type Holding, type Intent } from "../accounts.ts";

export interface MastercardSeed {
  last4: string;
  creditLimitUsd: number;
  availableUsd: number;
  token: { id: string; maxPerTxnUsd: number; dailyUsd: number; mccAllow: Record<string, string>; expiresAt: string };
}

export function mastercardAccount(seed: MastercardSeed, now: () => string): AccountAdapter {
  let available = seed.availableUsd;
  const spent: Array<{ at: string; usd: number }> = [];
  let seq = 0;
  const t = seed.token;
  const account: Account = {
    id: "mastercard",
    name: `Mastercard ··${seed.last4}`,
    kind: "card",
    provider: "Mastercard（发卡行 + 卡组织）",
    credentialRef: "home/credentials/mastercard/agentic-token.json",
    credentialKind: `agentic token ${t.id}（替代卡号，绑定这个 agent）`,
    scope: {
      can: ["read", "pay"],
      limits: [`单笔 ≤ $${t.maxPerTxnUsd} · 日 ≤ $${t.dailyUsd}`, `MCC 白名单 ${Object.entries(t.mccAllow).map(([k, v]) => `${k} ${v}`).join(" · ")}`, `token 到期 ${t.expiresAt.slice(0, 10)}`, "每笔授权带 agent 身份；持卡人可单独冻结这枚 token，不动卡"],
      enforcedBy: "network",
    },
    settlement: "授权即时 · 清算 T+1 · 账单月结",
    live: false,
  };
  const decline = (rc: string, text: string, extra: Record<string, unknown> = {}) => refuse("E_VENUE_CARD_DECLINED", { venue: "mastercard", message: `发卡行拒绝：rc ${rc} ${text}`, native: { responseCode: rc, text, ...extra } });
  const dailySpent = (at: string) => r2(spent.filter((s) => Date.parse(at) - Date.parse(s.at) < 24 * 3600 * 1000).reduce((s, x) => s + x.usd, 0));
  return {
    account,
    async read(): Promise<Holding[]> {
      return [{ account: account.id, asset: "USD · 可用额度", amount: available, usd: available, class: "credit", note: `额度 $${seed.creditLimitUsd}；负债侧，不计入总资产` }];
    },
    async execute(i: Intent) {
      if (i.kind !== "pay") return refuse("E_VENUE_REJECTED", { venue: "mastercard", message: `一张卡没有「${i.kind}」这种操作`, native: { responseCode: "12", text: "Invalid transaction" } });
      const at = now();
      if (Date.parse(at) >= Date.parse(t.expiresAt)) return decline("54", "Expired card (agentic token expired)");
      if (!(i.mcc in t.mccAllow)) return decline("57", "Transaction not permitted to cardholder", { reason: `MCC ${i.mcc} not in the agentic token's scope` });
      if (i.amountUsd > t.maxPerTxnUsd) return decline("61", "Exceeds withdrawal amount limit", { maxPerTxnUsd: t.maxPerTxnUsd });
      if (dailySpent(at) + i.amountUsd > t.dailyUsd) return decline("65", "Exceeds withdrawal frequency limit", { dailyUsd: t.dailyUsd, spentToday: dailySpent(at) });
      if (i.amountUsd > available) return decline("51", "Insufficient funds");
      available = r2(available - i.amountUsd);
      spent.push({ at, usd: i.amountUsd });
      const approvalCode = String((++seq * 7919) % 1_000_000).padStart(6, "0");
      return { ok: true as const, account: account.id, status: "authorized" as const, summary: `$${i.amountUsd} → ${i.merchant} (MCC ${i.mcc} ${t.mccAllow[i.mcc]})`, usd: i.amountUsd, ref: `mastercard:auth:${approvalCode}`, native: { responseCode: "00", approvalCode, tokenId: t.id } };
    },
  };
}
