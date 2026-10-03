import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Beat } from "./types.ts";

export const PROVEN = [
  "插件合同把第三方工具的写面接进了审批门；未分类的工具进不了 mount",
  "每个席位只拿到一条凭据引用，环境里没有任何 KEY/SECRET/TOKEN；主账户与 keypair 从不进入席位",
  "场所侧代理钥匙的限制在场所里被强制：agent key 不能提币、会过期；trade-only 的 key 换 IP 也提不了币",
  "授权书在卡之前拒绝越界；注入发生后被授权书与签名器两层兜住，人没有被打扰",
  "人点了批准，签名器仍按冷静时写的上限拒签",
  "账本只追加、哈希链可验，且与四家场所自己的对账单对得上",
  "钱包在 agent 之外：agent 只能申请注资，钱包按 float 上限注入 CEX/DEX，提币只回主钱包地址，钱包流水与场所存提对得上",
];
export const NOT_PROVEN = [
  "模拟器不是真场所：接口形状对齐，行为不保证；没有延迟、滑点、部分成交、宕机",
  "本机审批卡可被同机进程伪造（R3a）：答卡的还不是带外设备",
  "门不是围栏（R2）：workspace 里的 shell 能读到 home 里的文件（R1），demo 自己就演了这一点",
  "脚本化 agent 不代表 LLM 会做出同样决定；没有证明任何 alpha",
  "allow-list 之内的乱交易（3Commas 形态）只靠限额限频与账本显形，没有完全解决",
];
export const NEXT = [
  "同一套清单换 testnet/paper 凭据：Alpaca paper、Hyperliquid testnet、Binance spot testnet、真实 ccxt-mcp",
  "答卡设备搬出工作区；签名器换成隔离环境或 Turnkey/Privy/Coinbase 一类底座",
  "写新 charter：托管/非托管、一键撤销四家钥匙的演练、每日对账",
  "最小市场、最小额度的第一把 mainnet key",
];

export const summaryBeat: Beat = {
  name: "summary",
  title: "证明了什么、没证明什么、去 mainnet 的顺序",
  async run(ctx) {
    const { env } = ctx;
    ctx.say("已证明：");
    for (const line of PROVEN) ctx.say(`  ✓ ${line}`);
    ctx.say("没证明：");
    for (const line of NOT_PROVEN) ctx.say(`  – ${line}`);
    ctx.say("去 mainnet 的顺序：");
    NEXT.forEach((line, i) => ctx.say(`  ${i + 1}. ${line}`));

    const codes = [...new Set(env.ledger.all().filter((r) => r.code).map((r) => r.code!))];
    const chain = env.ledger.verifyChain();
    ctx.check(chain.ok, `ledger chain verified: ${chain.rows} rows`, "ledger");
    if (!env.args.live) {
      ctx.check(env.counters.fills === 4, `fills ${env.counters.fills} (one per venue)`, "summary");
      ctx.check(env.counters.refusals === 11, `refusals ${env.counters.refusals} across mount, mandate, wallet, signer and venue layers`, "summary");
    }
    ctx.check(env.counters.lossUsd === 0, "loss $0.00", "summary");
    ctx.say(`refusal codes seen: ${codes.join(", ")}`);
    const summary = { at: env.clock.iso(), counters: env.counters, refusalCodes: codes, proven: PROVEN, notProven: NOT_PROVEN, next: NEXT, ledgerRows: chain.rows };
    writeFileSync(join(env.home, "runs", "summary.json"), JSON.stringify(summary, null, 2) + "\n");
    env.bus.emit("summary/final", summary);
  },
};
