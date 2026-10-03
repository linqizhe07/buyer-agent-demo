import { showRefusal } from "../narration.ts";
import type { Beat } from "./types.ts";

const INTENT = { symbol: "BTC/USD", qty: 0.01, side: "buy", order_type: "market", time_in_force: "day" };

export const alpacaBeat: Beat = {
  name: "alpaca",
  title: "Alpaca paper 加密单：场所拒 day，合同吸收 gtc，改过的单子再问一次",
  async run(ctx) {
    const { env } = ctx;
    const live = env.args.live;

    ctx.say("agent 决定：买 0.01 BTC/USD 市价单。它按美股习惯写了 time_in_force=day。");
    const first = await env.agent.execute("mcp__alpaca__place_order", INTENT, { absorb: false });
    if (!first.ok) showRefusal(first);
    const venueSaidNo = !first.ok && first.code === "E_VENUE_INVALID_TIF";
    const humanSaidNo = !first.ok && first.code === "E_CARD_REJECTED";
    ctx.check(
      venueSaidNo || (live && humanSaidNo),
      venueSaidNo ? "alpaca · card #1 approved, then the VENUE refused tif=day: 422 code 42210000" : "alpaca · the human rejected card #1",
      "venue",
    );
    if (venueSaidNo) {
      const native = first.native as { status?: number; code?: number } | undefined;
      ctx.check(native?.status === 422 && native?.code === 42210000, "the venue's own error travels verbatim (status 422, code 42210000)", "venue");
      ctx.check(env.ledger.byVenue("alpaca").filter((r) => r.kind === "venue-refusal").length === 1, "the refusal is a ledger row", "ledger");
    }

    ctx.say("插件合同里有一条约束：加密单的 tif 只能是 gtc/ioc。合同吸收它，但改过的单子不悄悄发出去，回来再问一次。");
    const second = await env.agent.execute("mcp__alpaca__place_order", INTENT, { absorb: true });
    if (second.ok) {
      const rw = second.rewrites.find((r) => r.arg === "time_in_force");
      ctx.check(rw?.to === "gtc", `constraint rewrite shown on card #2: tif: ${String(rw?.from)} → ${String(rw?.to)}`, "contract");
      const p = second.payload as { filled_avg_price?: string; qty?: string; id?: string };
      ctx.check(
        second.outcome === "filled",
        `alpaca · filled ${p.qty} BTC/USD @ ${p.filled_avg_price} · venue order ${second.venueOrderId} · 名义 $${second.notionalUsd.toFixed(2)}`,
        "venue",
      );
      const m = env.mandates.forVenue("alpaca")[0];
      ctx.check((m?.spentUsd ?? 0) >= second.notionalUsd, `mandate ${m?.id} booked $${m?.spentUsd.toFixed(2)} of $${m?.notionalLimitUsd}`, "mandate");
    } else {
      showRefusal(second);
      ctx.check(live && second.code === "E_CARD_REJECTED", "alpaca · the human rejected card #2", "card");
    }

    const chain = env.ledger.verifyChain();
    ctx.check(chain.ok, `ledger chain verified: ${chain.rows} rows, every hash links to the previous`, "ledger");
    const kinds = new Set(env.ledger.byVenue("alpaca").map((r) => r.kind));
    ctx.check(
      ["intent", "card"].every((k) => kinds.has(k as never)),
      `alpaca ledger rows: ${[...kinds].join(", ")}`,
      "ledger",
    );
  },
};
