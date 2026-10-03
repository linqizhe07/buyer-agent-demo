/** A bank account reached through an aggregation token (Open Banking / Plaid
 * shape): balances and statements, nothing else. A transfer has to start in
 * the bank's own app; the token's 403 is the bank's own second line. */
import { refuse } from "../../core/errors.ts";
import { classOf, r2, type Account, type AccountAdapter, type Holding, type Intent } from "../accounts.ts";

export interface BankSeed {
  name: string;
  mask: string;
  aggregator: string;
  balances: Record<string, number>;
}

export function bankAccount(seed: BankSeed): AccountAdapter {
  const account: Account = {
    id: "chase",
    name: `${seed.name} ${seed.mask}`,
    kind: "bank",
    provider: "Chase（经聚合）",
    credentialRef: "home/credentials/chase/aggregation-token.json",
    credentialKind: seed.aggregator,
    scope: { can: ["read"], limits: ["聚合 token 只读：余额与流水", "转账只能在银行自己的 App / 网银发起（ACH / 电汇），不经 agent"], enforcedBy: "bank" },
    settlement: "ACH T+1 · 电汇当日（都不经 agent）",
    live: false,
  };
  return {
    account,
    async read(): Promise<Holding[]> {
      return Object.entries(seed.balances).map(([asset, amount]) => ({ account: account.id, asset, amount, usd: r2(amount), class: classOf(asset) }));
    },
    async execute(i: Intent) {
      return refuse("E_VENUE_PERMISSION", { venue: "chase", message: `银行聚合 token 只读：「${i.kind}」被银行拒绝`, native: { status: 403, error_code: "PRODUCT_NOT_ENABLED", error_message: "read-only access token: transfers are not enabled for this item" } });
    },
  };
}
