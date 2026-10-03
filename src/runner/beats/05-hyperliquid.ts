import { bypass, showRefusal } from "../narration.ts";
import { hlApproveAgent, hlBypassWithdraw, hlExtraAgents } from "../operator.ts";
import type { Beat } from "./types.ts";

const ATTACKER = "0xb14705888f4a68391a09aa5968dd25d16c3bba7b";

export const hyperliquidBeat: Beat = {
  name: "hyperliquid",
  title: "Hyperliquid agent wallet：能交易、不能提币、会过期（场所侧的第二道线）",
  async run(ctx) {
    const { env } = ctx;
    const live = env.args.live;

    ctx.say("操作员用主账户签发一把 agent key：能下单撤单、不能提币、60 秒后过期。主账户的钥匙从不进入任何插件。");
    const approval = await hlApproveAgent(env, 60_000);
    const agents = await hlExtraAgents(env);
    ctx.check(
      agents.some((a) => a.address === approval.agentAddress && a.validUntil === approval.validUntil),
      `hyperliquid · venue lists agent ${approval.agentAddress.slice(0, 10)}… for master ${approval.master.slice(0, 10)}… · valid until T+60s (venue-enforced)`,
      "venue",
    );

    const book = await env.agent.execute("mcp__hyperliquid__l2Book", { coin: "BTC" });
    const mid = (book.ok ? (book.payload as { mid: number }).mid : 0) || 0;
    const limitPx = Number((mid * 1.001).toFixed(1));
    ctx.say(`agent 决定：买 0.02 BTC 永续，限价 ${limitPx}（mid ${mid}），Ioc。`);
    const r1 = await env.agent.execute("mcp__hyperliquid__order", { coin: "BTC", is_buy: true, sz: 0.02, limit_px: limitPx, tif: "Ioc" });
    if (!r1.ok) showRefusal(r1);
    const p1 = r1.ok ? (r1.payload as { avgPx?: string; oid?: number }) : {};
    ctx.check(
      (r1.ok && r1.outcome === "filled") || (live && !r1.ok && r1.code === "E_CARD_REJECTED"),
      r1.ok ? `hyperliquid · filled 0.02 BTC @ ${p1.avgPx} · oid ${p1.oid} · 名义 $${r1.notionalUsd.toFixed(2)} · signed by the agent key` : "hyperliquid · the human rejected the order card",
      "venue",
    );

    bypass("故意绕过闸门：像工作区里的一个 shell 那样读出 agent key（R1），直接签一笔 withdraw3 打到场所。");
    const w = await hlBypassWithdraw(env, ATTACKER, 500);
    if (w.refusal) {
      showRefusal(w.refusal);
      env.counters.refusals++;
    }
    ctx.check(
      w.refusal?.code === "E_VENUE_AGENT_NO_WITHDRAW",
      "the VENUE refused the withdrawal: agent keys cannot withdraw — our gate was not even in the path",
      "venue",
    );

    env.clock.advance(61_000);
    await new Promise((r) => setTimeout(r, 5)); // the seat's nonce is wall-clock ms; let it pass the bypass's
    ctx.say(`SIM CLOCK → ${env.clock.iso()} (T+61s). agent 再下一单。`);
    env.bus.emit("clock/advanced", { to: env.clock.iso(), deltaMs: 61_000 });
    const r2 = await env.agent.execute("mcp__hyperliquid__order", { coin: "BTC", is_buy: true, sz: 0.01, limit_px: limitPx, tif: "Ioc" });
    if (!r2.ok) showRefusal(r2);
    ctx.check(
      (!r2.ok && r2.code === "E_VENUE_AGENT_EXPIRED") || (live && !r2.ok && r2.code === "E_CARD_REJECTED"),
      !r2.ok && r2.code === "E_VENUE_AGENT_EXPIRED"
        ? "hyperliquid · card approved, then the VENUE refused: agent key expired at T+60s"
        : "hyperliquid · the human rejected the second card",
      "venue",
    );
    const after = await hlExtraAgents(env);
    const rec = after.find((a) => a.address === approval.agentAddress);
    ctx.check(rec !== undefined && rec.validUntil <= env.clock.now(), "the venue's own record shows the key past its validUntil", "venue");

    const kinds = env.ledger.byVenue("hyperliquid").map((r) => r.kind);
    ctx.check(kinds.includes("bypass") && kinds.includes("venue-refusal"), `hyperliquid ledger rows: ${[...new Set(kinds)].join(", ")}`, "ledger");
  },
};
