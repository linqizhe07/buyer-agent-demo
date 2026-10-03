import { showRefusal } from "../narration.ts";
import type { Beat } from "./types.ts";

export const TREASURY = "c6822637c7d310ec57627be00ba259d253749f4aaf644470cffbe53a35f73242";

export const solanaBeat: Beat = {
  name: "solana",
  title: "Solana 策略签名器：agent 永远摸不到 keypair，人点了批准签名器也可以拒",
  async run(ctx) {
    const { env } = ctx;
    const live = env.args.live;
    const signer = env.venues.signer;
    const policy = (signer as { policy?: () => { perTxCapLamports: number } } | undefined)?.policy?.();

    ctx.say("Solana 上一个 keypair 就是全部权力。所以 key 放在 agent 读不到的签名器进程里，agent 只能发意图，签名器按冷静时写的策略拒签。");
    const bal0 = await env.agent.execute("mcp__solana__getBalance");
    const sol0 = bal0.ok ? (bal0.payload as { sol: number }).sol : 0;
    ctx.say(`agent 决定：向金库转 0.1 SOL 做再平衡（余额 ${sol0} SOL）。`);
    const r1 = await env.agent.execute("mcp__solana__transfer", { to: TREASURY, lamports: 100_000_000, memo: "rebalance" });
    if (!r1.ok) showRefusal(r1);
    const p1 = r1.ok ? (r1.payload as { signature?: string }) : {};
    ctx.check(
      (r1.ok && r1.outcome === "confirmed") || (live && !r1.ok && r1.code === "E_CARD_REJECTED"),
      r1.ok ? `solana · signer signed inside policy, chain confirmed ${String(p1.signature).slice(0, 16)}… · 名义 $${r1.notionalUsd.toFixed(2)}` : "solana · the human rejected the transfer card",
      "signer",
    );

    ctx.say(`agent 决定：再转 0.5 SOL。授权书放行（单笔 $100 内），卡上请故意点批准。签名器的单笔上限是 ${(policy?.perTxCapLamports ?? 0) / 1e9} SOL。`);
    const r2 = await env.agent.execute("mcp__solana__transfer", { to: TREASURY, lamports: 500_000_000, memo: "rebalance-2" });
    if (!r2.ok) showRefusal(r2);
    ctx.check(
      (!r2.ok && r2.code === "E_SIGNER_TX_CAP") || (live && !r2.ok && r2.code === "E_CARD_REJECTED"),
      !r2.ok && r2.code === "E_SIGNER_TX_CAP"
        ? "solana · card approved, then the SIGNER refused: 0.5 SOL over the 0.2 SOL per-tx cap — the finger is not the last line"
        : "solana · the human rejected the second card",
      "signer",
    );
    const journal = (signer?.statement() as Array<{ outcome: string; reason?: string }>) ?? [];
    ctx.check(journal.some((j) => j.outcome === "refused" && j.reason === "per_tx_cap"), "the signer's own journal records the refusal", "signer");
    const bal1 = await env.agent.execute("mcp__solana__getBalance");
    const sol1 = bal1.ok ? (bal1.payload as { sol: number }).sol : -1;
    ctx.check(Math.abs(sol0 - sol1 - 0.1) < 1e-9, `balance moved by exactly the signed transfer: ${sol0} → ${sol1} SOL`, "venue");
  },
};
