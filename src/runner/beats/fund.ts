import { showRefusal } from "../narration.ts";
import type { Beat } from "./types.ts";

export const fundBeat: Beat = {
  name: "fund",
  title: "钱包接入 CEX 与 DEX：agent 申请注资，钱包按 float 上限注入",
  async run(ctx) {
    const { env } = ctx;
    const live = env.args.live;
    ctx.say("钱包是用户的、非托管、在 agent 之外。agent 不能动钱包，只能申请注资；申请过授权书和审批卡，钱包再按每个场所的 float 上限决定给不给。");
    const bal = await env.agent.execute("wallet_balance");
    const b0 = (bal.ok ? bal.payload : {}) as { balances?: Record<string, number>; address?: string };
    ctx.check(bal.ok && typeof b0.balances?.USDT === "number", `wallet · USDT ${b0.balances?.USDT} · USDC ${b0.balances?.USDC} · address ${String(b0.address).slice(0, 10)}…`, "read");

    const r1 = await env.agent.execute("wallet_fund_request", { venue: "binance", amountUsd: 2000, purpose: "现货试单 float" });
    if (!r1.ok) showRefusal(r1);
    ctx.check((r1.ok && r1.outcome === "funded") || (live && !r1.ok && r1.code === "E_CARD_REJECTED"), r1.ok ? "wallet → binance · funded $2000 USDT via the CEX deposit address" : "wallet · the human rejected the first funding card", "wallet");
    const r2 = await env.agent.execute("wallet_fund_request", { venue: "hyperliquid", amountUsd: 2000, purpose: "永续试单 float" });
    if (!r2.ok) showRefusal(r2);
    ctx.check((r2.ok && r2.outcome === "funded") || (live && !r2.ok && r2.code === "E_CARD_REJECTED"), r2.ok ? "wallet → hyperliquid · funded $2000 USDC via the bridge" : "wallet · the human rejected the second funding card", "wallet");

    ctx.say("agent 再申请给 Binance 加 $2500：授权书放行（单笔 ≤ $3000），卡批准，但钱包的 binance float 上限是 $3000。");
    const r3 = await env.agent.execute("wallet_fund_request", { venue: "binance", amountUsd: 2500, purpose: "再加一点" });
    if (!r3.ok) showRefusal(r3);
    ctx.check((!r3.ok && r3.code === "E_WALLET_FLOAT_CAP") || (live && !r3.ok && r3.code === "E_CARD_REJECTED"), !r3.ok && r3.code === "E_WALLET_FLOAT_CAP" ? "the WALLET refused: binance float would be $4500 > $3000 — a poor float is a design" : "wallet · the human rejected the third card", "wallet");

    const bn = await env.agent.execute("mcp__binance__fetchBalance");
    const usdt = bn.ok ? (bn.payload as { free: Record<string, number> }).free.USDT : -1;
    const hl = await env.agent.execute("mcp__hyperliquid__userState");
    const av = hl.ok ? Number((hl.payload as { marginSummary: { accountValue: string } }).marginSummary.accountValue) : -1;
    ctx.check(usdt === 2000 && av === 2000, `venues credited: binance USDT ${usdt} · hyperliquid account value $${av}`, "venue");
    const noSeatHoldsIt = [...env.plugins.values()].every((p) => p.manifest.identity?.ref !== "wallet/main");
    ctx.check(noSeatHoldsIt, "no seat holds the wallet's key: the tool is in-process and carries no credential", "wallet");
  },
};
