import { bypass, showRefusal } from "../narration.ts";
import { binanceBypassWithdraw } from "../operator.ts";
import type { Beat } from "./types.ts";

const ATTACKER = "0xb14705888f4a68391a09aa5968dd25d16c3bba7b";

export const binanceBeat: Beat = {
  name: "binance",
  title: "Binance 经第三方 ccxt 形状的 MCP server：一行代码没改，只配了一张清单",
  async run(ctx) {
    const { env } = ctx;
    const live = env.args.live;

    ctx.say("这个席位是第三方 ccxt 形状的 MCP server（模拟）。我们没改它的代码，只配了清单：createOrder 是写，withdraw 不挂载。key 是 trade-only、绑 IP 的。");
    const r1 = await env.agent.execute("mcp__binance__createOrder", { symbol: "BTC/USDT", type: "market", side: "buy", amount: 0.005 });
    if (!r1.ok) showRefusal(r1);
    const p1 = r1.ok ? (r1.payload as { average?: number; filled?: number; id?: string }) : {};
    ctx.check(
      (r1.ok && r1.outcome === "filled") || (live && !r1.ok && r1.code === "E_CARD_REJECTED"),
      r1.ok ? `binance · createOrder went through the card and filled ${p1.filled} BTC/USDT @ ${p1.average} · order ${p1.id} · 名义 $${r1.notionalUsd.toFixed(2)}` : "binance · the human rejected the order card",
      "venue",
    );

    ctx.say("agent 试着调 withdraw：server 上有这个工具，清单没挂它。");
    const nm = await env.agent.execute("mcp__binance__withdraw", { code: "USDT", amount: 100, address: ATTACKER });
    if (!nm.ok) showRefusal(nm);
    ctx.check(!nm.ok && nm.code === "E_MOUNT_TOOL_NOT_MOUNTED", "binance · withdraw is not on the mounted surface: refused before any card (E_MOUNT_TOOL_NOT_MOUNTED)", "mount");
    const asked = env.gate.history().filter((e) => e.type === "approval/asked" && e.data.toolName === "mcp__binance__withdraw").length;
    ctx.check(asked === 0, "no card was raised for the unmounted tool", "card");

    bypass("把 key 偷出去，从白名单之外的 IP 直接调交易所的提币接口。");
    const w = await binanceBypassWithdraw(env, { coin: "USDT", amount: 100, address: ATTACKER, sourceIp: "203.0.113.9" });
    if (w.refusal) {
      showRefusal(w.refusal);
      env.counters.refusals++;
    }
    ctx.check(
      w.refusal?.code === "E_VENUE_PERMISSION",
      "the VENUE refused: -2015 Invalid API-key, IP, or permissions — trade-only key, wrong IP",
      "venue",
    );
    ctx.say("3Commas 的教训仍然成立：不能提币 ≠ 不会亏钱。所以授权书限品种、限名义、限频率，账本把每一笔显出来。");
  },
};
