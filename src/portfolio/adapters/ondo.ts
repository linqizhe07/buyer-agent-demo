/** An RWA position at an issuer — Ondo's OUSG (tokenized short-term US
 * Treasuries), in-memory. Compliance is the design: the holder's address is on
 * the issuer's KYC allowlist, OUSG can only move to allowlisted addresses (the
 * token contract reverts otherwise), subscription mints at NAV, redemption is
 * T+1. The issuer can freeze an address; that is noted, not simulated. */
import { refuse } from "../../core/errors.ts";
import { priceOf, r2, r8, usdOf, type Account, type AccountAdapter, type Holding, type Intent } from "../accounts.ts";

export interface OndoSeed {
  address: string;
  ousg: number;
  usdc: number;
  allowlist: string[];
}

export function ondoAccount(seed: OndoSeed, now: () => string): AccountAdapter {
  let ousg = seed.ousg;
  let usdc = seed.usdc;
  const pending: Array<{ usd: number; settlesAt: string }> = [];
  let seq = 0;
  const nav = () => priceOf("OUSG");
  const account: Account = {
    id: "ondo",
    name: "Ondo · OUSG",
    kind: "rwa",
    provider: "Ondo Finance（发行方）",
    credentialRef: "home/credentials/ondo/kyc-address.json",
    credentialKind: `KYC 白名单地址 ${seed.address}（签名权在钱包）`,
    scope: {
      can: ["read", "subscribe", "redeem", "move"],
      limits: [`OUSG 转让限制：只能转到发行方白名单地址（${seed.allowlist.join(", ")}）`, "申购即时按 NAV 铸造；赎回 T+1，USDC 次日到", "发行方可冻结地址（合规事件）"],
      enforcedBy: "issuer",
    },
    settlement: "申购 T+0 · 赎回 T+1",
    live: false,
    address: seed.address,
    chain: "Ethereum",
  };
  return {
    account,
    credit(asset, amount) {
      if (asset === "USDC") usdc = r2(usdc + amount);
      else if (asset === "OUSG") ousg = r8(ousg + amount);
    },
    async read(): Promise<Holding[]> {
      const rows: Holding[] = [];
      if (ousg > 0) rows.push({ account: account.id, asset: "OUSG", amount: ousg, usd: r2(ousg * nav()), class: "rwa", note: `NAV $${nav()}` });
      if (usdc > 0) rows.push({ account: account.id, asset: "USDC", amount: usdc, usd: r2(usdc), class: "stable" });
      for (const p of pending) rows.push({ account: account.id, asset: "USDC（赎回在途）", amount: p.usd, usd: p.usd, class: "stable", note: `T+1 · ${p.settlesAt.slice(0, 10)} 到` });
      return rows;
    },
    async execute(i: Intent) {
      if (i.kind === "subscribe") {
        if (i.fund !== "OUSG") return refuse("E_VENUE_REJECTED", { venue: "ondo", native: { error: `unknown fund ${i.fund}` } });
        if (usdc < i.amountUsd) return refuse("E_VENUE_INSUFFICIENT", { venue: "ondo", native: { error: "insufficient USDC for subscription" } });
        const qty = r8(i.amountUsd / nav());
        usdc = r2(usdc - i.amountUsd);
        ousg = r8(ousg + qty);
        return { ok: true as const, account: account.id, status: "minted" as const, summary: `subscribe $${i.amountUsd} → ${qty} OUSG @ NAV ${nav()}`, usd: i.amountUsd, ref: `ondo:mint:${++seq}`, native: { minted: qty, nav: nav() } };
      }
      if (i.kind === "redeem") {
        if (i.fund !== "OUSG") return refuse("E_VENUE_REJECTED", { venue: "ondo", native: { error: `unknown fund ${i.fund}` } });
        const qty = r8(i.amountUsd / nav());
        if (ousg < qty) return refuse("E_VENUE_INSUFFICIENT", { venue: "ondo", native: { error: "insufficient OUSG for redemption" } });
        ousg = r8(ousg - qty);
        const settlesAt = new Date(Date.parse(now()) + 24 * 3600 * 1000).toISOString();
        pending.push({ usd: i.amountUsd, settlesAt });
        return { ok: true as const, account: account.id, status: "pending" as const, summary: `redeem ${qty} OUSG → $${i.amountUsd} USDC，T+1（${settlesAt.slice(0, 10)}）`, usd: i.amountUsd, ref: `ondo:redeem:${++seq}`, native: { burned: qty, settlesAt } };
      }
      if (i.kind === "move") {
        if (i.asset === "OUSG") {
          if (!seed.allowlist.includes(i.to)) return refuse("E_VENUE_TRANSFER_RESTRICTED", { venue: "ondo", message: `OUSG 只能转到发行方白名单地址；${i.to} 不在里面，合约 revert`, native: { revert: "OUSG: transfer restricted (recipient not allowlisted)" } });
          if (ousg < i.amount) return refuse("E_VENUE_INSUFFICIENT", { venue: "ondo", native: { error: "insufficient OUSG" } });
          ousg = r8(ousg - i.amount);
        } else if (i.asset === "USDC") {
          if (usdc < i.amount) return refuse("E_VENUE_INSUFFICIENT", { venue: "ondo", native: { error: "insufficient USDC" } });
          usdc = r2(usdc - i.amount);
        } else return refuse("E_VENUE_REJECTED", { venue: "ondo", native: { error: `no ${i.asset} at this address` } });
        return { ok: true as const, account: account.id, status: "sent" as const, summary: `transfer ${i.amount} ${i.asset} → ${i.to}`, usd: usdOf(i), ref: `ondo:tx:${++seq}` };
      }
      return refuse("E_VENUE_REJECTED", { venue: "ondo", message: `RWA 持仓没有「${i.kind}」这种操作`, native: { error: "unsupported" } });
    },
  };
}
