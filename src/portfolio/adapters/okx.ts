/** OKX, in-memory: an API key with read / trade / withdraw permissions set
 * separately, a passphrase, and an IP binding. Codes follow OKX's `5xxxx`
 * family (50110 invalid IP, 50114 invalid authorization — the permission code
 * is illustrative, the shape is real). A trade fills at the venue model's
 * price (venues.ts): a little thinner than Binance, a little cheaper. */
import { no } from "../refuse.ts";
import { baseOf, classOf, priceOf, r2, r8, usdOf, type Account, type AccountAdapter, type Capability, type Holding, type Intent, type VenueResult } from "../accounts.ts";
import { fillAt } from "../venues.ts";

export interface OkxSeed {
  balances: Record<string, number>;
  permissions: Array<"read" | "trade" | "withdraw">;
  ipBound: string;
  /** OKX's "verified addresses": the API withdraws only to these, and only the web or the app can add one */
  withdrawWhitelist?: string[] | undefined;
}

export function okxAccount(seed: OkxSeed): AccountAdapter {
  const balances: Record<string, number> = { ...seed.balances };
  const can: Capability[] = ["read"];
  if (seed.permissions.includes("trade")) can.push("trade");
  if (seed.permissions.includes("withdraw")) can.push("move");
  let seq = 0;
  const account: Account = {
    id: "okx",
    name: "OKX",
    kind: "cex",
    provider: "OKX",
    credentialRef: "home/credentials/okx/trade.json",
    credentialKind: "API key + secret + passphrase",
    scope: { can, limits: [`key permissions ${seed.permissions.join(" / ")}${can.includes("move") ? "" : ": withdraw not enabled"}`, `bound to IP ${seed.ipBound}`, "a passphrase goes with every request", ...(seed.withdrawWhitelist ? [`withdraws only to verified addresses (${seed.withdrawWhitelist.join(", ")}); a new one is added at OKX, not through the API`] : [])], enforcedBy: "venue" },
    settlement: "spot fills instantly",
    live: false,
  };
  const insufficient = () => no("E_VENUE_INSUFFICIENT", { venue: "okx", native: { code: "51008", msg: "Order failed. Insufficient USDT balance in account" } });
  return {
    account,
    /** a deposit that reached its confirmations */
    credit(asset, amount) {
      balances[asset] = r8((balances[asset] ?? 0) + amount);
    },
    /** USDT ⇄ USDC through convert (estimate-quote, trade), in the trading account */
    convert(sell, buy, amount): VenueResult {
      if ([sell, buy].sort().join("/") !== "USDC/USDT") return no("E_VENUE_CURRENCY", { venue: "okx", message: `OKX converts USDT and USDC here, not ${sell} for ${buy}`, native: { code: "51001", msg: "Instrument ID does not exist" } });
      if ((balances[sell] ?? 0) < amount) return no("E_VENUE_INSUFFICIENT", { venue: "okx", native: { code: "58350", msg: "Insufficient balance." } });
      const feeUsd = r2(amount * 0.0001);
      const received = r2(amount - feeUsd);
      balances[sell] = r8((balances[sell] ?? 0) - amount);
      balances[buy] = r8((balances[buy] ?? 0) + received);
      return { ok: true as const, ref: `okx:convert:${++seq}`, received, feeUsd, native: { tradeId: `okx-cv-${seq}`, state: "fullyFilled", baseCcy: buy, quoteCcy: sell, fillBaseSz: String(received), fillQuoteSz: String(amount) } };
    },
    async read(): Promise<Holding[]> {
      return Object.entries(balances)
        .filter(([, n]) => n > 0)
        .map(([asset, amount]) => ({ account: account.id, asset, amount, usd: r2(amount * priceOf(asset)), class: classOf(asset) }));
    },
    async execute(i: Intent) {
      if (i.kind === "trade") {
        const base = baseOf(i.symbol);
        const f = fillAt("okx", base, i.side, i.qty);
        if (!f) return no("E_VENUE_REJECTED", { venue: "okx", native: { code: "51001", msg: "Instrument ID does not exist" } });
        if (i.side === "buy") {
          if ((balances[f.quote] ?? 0) < f.netUsd) return insufficient();
          balances[f.quote] = r8((balances[f.quote] ?? 0) - f.netUsd);
          balances[base] = r8((balances[base] ?? 0) + i.qty);
        } else {
          if ((balances[base] ?? 0) < i.qty) return insufficient();
          balances[base] = r8((balances[base] ?? 0) - i.qty);
          balances[f.quote] = r8((balances[f.quote] ?? 0) + f.netUsd);
        }
        const ordId = `okx-${1000 + ++seq}`;
        return { ok: true as const, account: account.id, status: "filled" as const, summary: `${i.side.toUpperCase()} ${i.qty} ${base} @ ${f.price} ${f.quote} · fee ${f.feeUsd}`, usd: f.grossUsd, ref: `okx:order:${ordId}`, native: { ordId, sCode: "0", state: "filled", price: f.price, grossUsd: f.grossUsd, feeUsd: f.feeUsd, netUsd: f.netUsd, impactBps: f.impactBps } };
      }
      if (i.kind === "move") {
        if (!can.includes("move")) return no("E_VENUE_PERMISSION", { venue: "okx", message: "OKX: withdraw is not enabled on this key, the exchange refuses", native: { code: "50114", msg: "Invalid authorization" } });
        if (seed.withdrawWhitelist && !seed.withdrawWhitelist.includes(i.to)) return no("E_VENUE_WITHDRAW_WHITELIST", { venue: "okx", native: { code: "58207", msg: "Withdrawal address isn't on the verified address list." } });
        if ((balances[i.asset] ?? 0) < i.amount) return insufficient();
        balances[i.asset] = r8((balances[i.asset] ?? 0) - i.amount);
        return { ok: true as const, account: account.id, status: "sent" as const, summary: `withdraw ${i.amount} ${i.asset} → ${i.to}`, usd: usdOf(i), ref: `okx:wd:${++seq}` };
      }
      return no("E_VENUE_REJECTED", { venue: "okx", message: `an OKX account has no \"${i.kind}\" action`, native: { code: "50014", msg: "Parameter can not be empty" } });
    },
  };
}
