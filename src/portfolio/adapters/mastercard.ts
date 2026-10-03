/** A Mastercard, in-memory, reached through an AGENTIC TOKEN: a tokenized
 * credential the cardholder issued to this agent with a scope (merchant
 * categories, per-transaction and daily amounts, expiry). The issuer and the
 * network decline outside the scope with ISO-8583 response codes: 57 not
 * permitted to cardholder, 61 exceeds amount limit, 65 exceeds frequency, 54
 * expired, 51 insufficient funds. The token format is illustrative (Agent Pay
 * shaped); the decline codes are the real ones. */
import { no } from "../refuse.ts";
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
    provider: "Mastercard (issuer + network)",
    credentialRef: "home/credentials/mastercard/agentic-token.json",
    credentialKind: `agentic token ${t.id} (stands in for the card number, bound to this agent)`,
    scope: {
      can: ["read", "pay"],
      limits: [`per transaction ≤ $${t.maxPerTxnUsd} · per day ≤ $${t.dailyUsd}`, `MCC allowlist ${Object.entries(t.mccAllow).map(([k, v]) => `${k} ${v}`).join(" · ")}`, `token expires ${t.expiresAt.slice(0, 10)}`, "every authorization carries the agent's identity; the cardholder can freeze this token alone, without touching the card"],
      enforcedBy: "network",
    },
    settlement: "authorization instant · clearing T+1 · billed monthly",
    live: false,
  };
  const decline = (rc: string, text: string, extra: Record<string, unknown> = {}) => no("E_VENUE_CARD_DECLINED", { venue: "mastercard", message: `issuer declined: rc ${rc} ${text}`, native: { responseCode: rc, text, ...extra } });
  const dailySpent = (at: string) => r2(spent.filter((s) => Date.parse(at) - Date.parse(s.at) < 24 * 3600 * 1000).reduce((s, x) => s + x.usd, 0));
  return {
    account,
    async read(): Promise<Holding[]> {
      return [{ account: account.id, asset: "USD · available credit", amount: available, usd: available, class: "credit", note: `limit $${seed.creditLimitUsd}; a liability, not counted in net worth` }];
    },
    async execute(i: Intent) {
      if (i.kind !== "pay") return no("E_VENUE_REJECTED", { venue: "mastercard", message: `a card has no \"${i.kind}\" action`, native: { responseCode: "12", text: "Invalid transaction" } });
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
