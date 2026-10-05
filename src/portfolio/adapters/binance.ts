/** Binance spot, in-memory: the credential is an API key whose PERMISSIONS the
 * exchange enforces (SPOT, WITHDRAW), plus an IP whitelist and a withdrawal
 * address whitelist. The real error codes: -2015 for a key without the
 * permission, -4026 for an address outside the whitelist, -2010 for balance.
 * A trade fills at the venue model's price (venues.ts): spread, depth, fee. */
import { no } from "../refuse.ts";
import { baseOf, classOf, priceOf, r2, r8, usdOf, type Account, type AccountAdapter, type Holding, type Intent, type VenueResult } from "../accounts.ts";
import { fillAt } from "../venues.ts";

export interface BinanceSeed {
  balances: Record<string, number>;
  permissions: Array<"SPOT" | "WITHDRAW">;
  ipWhitelist: string[];
  withdrawWhitelist: string[];
}

export function binanceAccount(seed: BinanceSeed): AccountAdapter {
  const balances: Record<string, number> = { ...seed.balances };
  const canWithdraw = seed.permissions.includes("WITHDRAW");
  let seq = 0;
  const account: Account = {
    id: "binance",
    name: "Binance",
    kind: "cex",
    provider: "Binance",
    credentialRef: "home/credentials/binance/spot-trade.json",
    credentialKind: "API key + HMAC secret",
    scope: {
      can: canWithdraw ? ["read", "trade", "move"] : ["read", "trade"],
      limits: [`key permissions ${seed.permissions.join(" + ")}${canWithdraw ? "" : ": no WITHDRAW, this key cannot withdraw"}`, `IP whitelist ${seed.ipWhitelist.join(", ")}`, `withdrawal address whitelist ${seed.withdrawWhitelist.join(", ")}`],
      enforcedBy: "venue",
    },
    settlement: "spot fills instantly · withdrawals wait for on-chain confirmation",
    live: false,
  };
  const insufficient = () => no("E_VENUE_INSUFFICIENT", { venue: "binance", native: { code: -2010, msg: "Account has insufficient balance for requested action." } });
  return {
    account,
    /** a deposit that reached its confirmations */
    credit(asset, amount) {
      balances[asset] = r8((balances[asset] ?? 0) + amount);
    },
    /** USDT ⇄ USDC through Convert (getQuote, acceptQuote): a quoted rate, good for ten seconds */
    convert(sell, buy, amount): VenueResult {
      if ([sell, buy].sort().join("/") !== "USDC/USDT") return no("E_VENUE_CURRENCY", { venue: "binance", message: `Binance converts USDT and USDC here, not ${sell} for ${buy}`, native: { code: -1121, msg: "Invalid symbol." } });
      if ((balances[sell] ?? 0) < amount) return insufficient();
      const feeUsd = r2(amount * 0.0001);
      const received = r2(amount - feeUsd);
      balances[sell] = r8((balances[sell] ?? 0) - amount);
      balances[buy] = r8((balances[buy] ?? 0) + received);
      return { ok: true as const, ref: `binance:convert:${++seq}`, received, feeUsd, native: { orderId: String(seq), orderStatus: "SUCCESS", fromAsset: sell, toAsset: buy, fromAmount: String(amount), toAmount: String(received) } };
    },
    async read(): Promise<Holding[]> {
      return Object.entries(balances)
        .filter(([, n]) => n > 0)
        .map(([asset, amount]) => ({ account: account.id, asset, amount, usd: r2(amount * priceOf(asset)), class: classOf(asset) }));
    },
    async execute(i: Intent) {
      if (i.kind === "trade") {
        const base = baseOf(i.symbol);
        const f = fillAt("binance", base, i.side, i.qty);
        if (!f) return no("E_VENUE_REJECTED", { venue: "binance", native: { code: -1121, msg: "Invalid symbol." } });
        if (i.side === "buy") {
          if ((balances[f.quote] ?? 0) < f.netUsd) return insufficient();
          balances[f.quote] = r8((balances[f.quote] ?? 0) - f.netUsd);
          balances[base] = r8((balances[base] ?? 0) + i.qty);
        } else {
          if ((balances[base] ?? 0) < i.qty) return insufficient();
          balances[base] = r8((balances[base] ?? 0) - i.qty);
          balances[f.quote] = r8((balances[f.quote] ?? 0) + f.netUsd);
        }
        const orderId = 100000 + ++seq;
        return { ok: true as const, account: account.id, status: "filled" as const, summary: `${i.side.toUpperCase()} ${i.qty} ${base} @ ${f.price} ${f.quote} · fee ${f.feeUsd}`, usd: f.grossUsd, ref: `binance:order:${orderId}`, native: { orderId, status: "FILLED", price: f.price, grossUsd: f.grossUsd, feeUsd: f.feeUsd, netUsd: f.netUsd, impactBps: f.impactBps } };
      }
      if (i.kind === "move") {
        if (!canWithdraw) return no("E_VENUE_PERMISSION", { venue: "binance", message: "Binance: this key has no WITHDRAW permission, the exchange refuses the withdrawal", native: { code: -2015, msg: "Invalid API-key, IP, or permissions for action." } });
        if (!seed.withdrawWhitelist.includes(i.to)) return no("E_VENUE_WITHDRAW_WHITELIST", { venue: "binance", native: { code: -4026, msg: "Withdrawal address is not in the account's whitelist." } });
        if ((balances[i.asset] ?? 0) < i.amount) return insufficient();
        balances[i.asset] = r8((balances[i.asset] ?? 0) - i.amount);
        return { ok: true as const, account: account.id, status: "sent" as const, summary: `withdraw ${i.amount} ${i.asset} → ${i.to}`, usd: usdOf(i), ref: `binance:wd:${++seq}`, native: { id: `wd-${seq}` } };
      }
      return no("E_VENUE_REJECTED", { venue: "binance", message: `a Binance spot account has no \"${i.kind}\" action`, native: { code: -1100, msg: "Illegal characters found in a parameter." } });
    },
  };
}
