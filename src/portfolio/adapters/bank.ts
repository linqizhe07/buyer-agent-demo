/** A bank account reached through an aggregation token (Open Banking / Plaid
 * shape): balances and statements, nothing else. A transfer has to start in
 * the bank's own app; the token's 403 is the bank's own second line. */
import { no } from "../refuse.ts";
import { classOf, r2, type Account, type AccountAdapter, type Holding, type Intent, type VenueResult } from "../accounts.ts";

export interface BankSeed {
  name: string;
  mask: string;
  aggregator: string;
  balances: Record<string, number>;
}

export function bankAccount(seed: BankSeed): AccountAdapter {
  const balances: Record<string, number> = { ...seed.balances };
  const account: Account = {
    id: "chase",
    name: `${seed.name} ${seed.mask}`,
    kind: "bank",
    provider: "Chase (via an aggregator)",
    credentialRef: "home/credentials/chase/aggregation-token.json",
    credentialKind: seed.aggregator,
    scope: { can: ["read"], limits: ["read-only aggregation token: balances and transactions", "transfers start only in the bank's own app or site (ACH / wire), never through the agent"], enforcedBy: "bank" },
    settlement: "ACH T+1 · wire same day (neither goes through the agent)",
    live: false,
  };
  return {
    account,
    async read(): Promise<Holding[]> {
      return Object.entries(balances).map(([asset, amount]) => ({ account: account.id, asset, amount, usd: r2(amount), class: classOf(asset) }));
    },
    /** an ACH credit landing: a venue paid out to this account */
    credit(asset, amount) {
      balances[asset] = r2((balances[asset] ?? 0) + amount);
    },
    /** an ACH debit a venue pulls on a relationship the account holder set up THERE. The aggregation token still cannot start one: `execute` refuses */
    debit(asset, amount): VenueResult {
      if ((balances[asset] ?? 0) < amount) return no("E_VENUE_RETURNED", { venue: "chase", message: "the bank returned the ACH debit: insufficient funds", native: { return_code: "R01", description: "Insufficient funds" } });
      balances[asset] = r2((balances[asset] ?? 0) - amount);
      return { ok: true as const };
    },
    async execute(i: Intent) {
      return no("E_VENUE_PERMISSION", { venue: "chase", message: `the bank's aggregation token is read-only: \"${i.kind}\" is refused by the bank`, native: { status: 403, error_code: "PRODUCT_NOT_ENABLED", error_message: "read-only access token: transfers are not enabled for this item" } });
    },
  };
}
