/** OKX, in-memory: an API key with read / trade / withdraw permissions set
 * separately, a passphrase, and an IP binding. Codes follow OKX's `5xxxx`
 * family (50110 invalid IP, 50114 invalid authorization — the permission code
 * is illustrative, the shape is real). A trade fills at the venue model's
 * price (venues.ts): a little thinner than Binance, a little cheaper. */
import { refuse } from "../../core/errors.ts";
import { baseOf, classOf, priceOf, r2, r8, usdOf, type Account, type AccountAdapter, type Capability, type Holding, type Intent } from "../accounts.ts";
import { fillAt } from "../venues.ts";

export interface OkxSeed {
  balances: Record<string, number>;
  permissions: Array<"read" | "trade" | "withdraw">;
  ipBound: string;
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
    scope: { can, limits: [`key 权限 ${seed.permissions.join(" / ")}${can.includes("move") ? "" : "：withdraw 没开"}`, `IP 绑定 ${seed.ipBound}`, "passphrase 每次请求都要带"], enforcedBy: "venue" },
    settlement: "现货即时成交",
    live: false,
  };
  const insufficient = () => refuse("E_VENUE_INSUFFICIENT", { venue: "okx", native: { code: "51008", msg: "Order failed. Insufficient USDT balance in account" } });
  return {
    account,
    async read(): Promise<Holding[]> {
      return Object.entries(balances)
        .filter(([, n]) => n > 0)
        .map(([asset, amount]) => ({ account: account.id, asset, amount, usd: r2(amount * priceOf(asset)), class: classOf(asset) }));
    },
    async execute(i: Intent) {
      if (i.kind === "trade") {
        const base = baseOf(i.symbol);
        const f = fillAt("okx", base, i.side, i.qty);
        if (!f) return refuse("E_VENUE_REJECTED", { venue: "okx", native: { code: "51001", msg: "Instrument ID does not exist" } });
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
        if (!can.includes("move")) return refuse("E_VENUE_PERMISSION", { venue: "okx", message: "OKX：这把 key 的 withdraw 权限没开，交易所拒绝", native: { code: "50114", msg: "Invalid authorization" } });
        if ((balances[i.asset] ?? 0) < i.amount) return insufficient();
        balances[i.asset] = r8((balances[i.asset] ?? 0) - i.amount);
        return { ok: true as const, account: account.id, status: "sent" as const, summary: `withdraw ${i.amount} ${i.asset} → ${i.to}`, usd: usdOf(i), ref: `okx:wd:${++seq}` };
      }
      return refuse("E_VENUE_REJECTED", { venue: "okx", message: `OKX 账户没有「${i.kind}」这种操作`, native: { code: "50014", msg: "Parameter can not be empty" } });
    },
  };
}
