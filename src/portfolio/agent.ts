/** The agent behind the page's one sentence box.
 *
 * A keyword script, not an LLM — but its plans are ROUTED, not canned:
 *
 *   "申购 5000 OUSG"  reads the liquidity ladder: fuel already at the issuer
 *                     first; then what the on-chain wallet holds on another
 *                     chain, over the cheapest open bridge (the quote and what
 *                     it beat go on the leg; the fee comes out of what
 *                     arrives); then the gap, with the closed runways and what
 *                     opening one would cost.
 *   "卖 1 ETH"        quotes the same order at every venue (two CEX books, the
 *                     DEX pools on each chain the wallet holds the asset on)
 *                     and sells where the net is highest; a venue that does not
 *                     hold the asset says so.
 *   "卖 3 ETH"        no venue holds that much, so the order is SPLIT: each
 *                     slice goes where its marginal price is best (router.ts,
 *                     venues.ts). The slices fly as one order — one card at
 *                     most — and the DEX slice shows its route.
 *
 * Every plan flies as one flight with one leg per account the money touches;
 * the service writes the legs in plain words.
 */
import { PAGE_AGENT, type RouteQuote } from "./accounts.ts";
import type { Mode } from "./openness.ts";
import type { Liquidity } from "./portfolio.ts";
import { cexWithdrawFee, etaLabel, pick, routesToHub, type Ladder, type RailAccount } from "./rails.ts";
import { lead, orderPlan, type OrderPlan, type Step } from "./router.ts";
import { isPending, PortfolioService, type ExecuteOutcome, type Flight } from "./service.ts";
import type { Side } from "./venues.ts";
import { cents } from "./words.ts";

export type { Step };

export interface Plan {
  narration: string;
  steps: Step[];
  /** lines after the legs (what the agent wants the user to know) */
  notes?: string[] | undefined;
  mode?: Mode | undefined;
  /** when the plan trades: the routed order. Its slices are the FIRST `order.steps.length` steps and fly as one order (one card at most); its own notes close the flight */
  order?: OrderPlan | undefined;
}

export interface PlanContext {
  cryptoPct: number;
  liquidity: Liquidity;
  ladder: Ladder;
  accounts: RailAccount[];
  /** where the Ondo position lives (the bridge's destination) */
  ondoAddress: string | undefined;
  /** bridge quotes read from the live MetaMask wallet, or why they could not be read */
  liveBridge?: { quotes?: RouteQuote[] | undefined; error?: string | undefined } | undefined;
}

export const PRESETS = ["申购 5000 OUSG", "卖 3 ETH", "再平衡", "付账单", "提到冷钱包", "转给新地址"];
const COLD = "0x9C0d4E3b7a2f1c8d9e0f1a2b3c4d5e6f7a8b9c0d";
const STRANGER = "0x7a11…stranger";
const BASE = 8453;
const ETHEREUM = 1;
const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const amount = (n: number) => (Number.isInteger(n) ? money(n) : cents(n));
const r2 = (n: number) => Number(n.toFixed(2));

/** the router: fuel at the issuer first, then what the on-chain wallet can bridge (cheapest open route), then the gap and what closing it would take */
function routeToOndo(usdWanted: number, ctx: PlanContext): Plan {
  const atOndo = ctx.liquidity.mobile.filter((s) => s.account === "ondo").reduce((s, x) => s + x.usd, 0);
  const mm = ctx.accounts.find((a) => a.id === "metamask");
  const mmBase = mm?.holdings.find((h) => h.asset === "USDC" && h.usd > 0 && (h.note === "Base" || h.note === undefined));
  const steps: Step[] = [];
  const fuel: string[] = [];
  const notes: string[] = [];
  let need = usdWanted;
  if (atOndo > 0 && need > 0) {
    const x = Math.min(need, atOndo);
    steps.push({ account: "ondo", intent: { kind: "subscribe", fund: "OUSG", amountUsd: x }, say: `申购 ${money(x)} OUSG · Ondo 地址上的 USDC` });
    fuel.push(`Ondo 地址上有 ${money(atOndo)} USDC（即时）`);
    need = r2(need - x);
  }
  if (need > 0 && mm && mmBase && !mm.revoked && mm.reach.includes("move") && ctx.ondoAddress) {
    const x = Math.min(need, mmBase.usd);
    const sim = routesToHub(mm, { ...mmBase, usd: x }, ctx.accounts);
    const live = ctx.liveBridge?.quotes ?? [];
    const quotes = live.length ? [...live, ...sim.filter((q) => q.id.startsWith("cex:"))] : sim;
    const best = pick(quotes, "cost");
    if (best) {
      const arrival = r2(x - best.feeUsd);
      const others = quotes.filter((q) => q.id !== best.id).map((q) => (q.open ? `${q.label} ${cents(q.feeUsd)} · ${etaLabel(q.etaSec)}` : `${q.label} 关着（${q.why ?? "不可用"}）`));
      const bridge = steps.length;
      steps.push({ account: "metamask", intent: { kind: "move", asset: "USDC", amount: x, to: ctx.ondoAddress, fromChainId: BASE, chainId: ETHEREUM, via: best.id }, say: `跨链 ${money(x)} USDC：Base → Ethereum → Ondo 地址`, compare: `比过：${others.join("；")}` });
      steps.push({ account: "ondo", intent: { kind: "subscribe", fund: "OUSG", amountUsd: arrival }, say: `申购 ${amount(arrival)} OUSG · 跨链到的 USDC`, needs: bridge });
      fuel.push(`MetaMask 在 Base 上有 ${money(mmBase.usd)} USDC，走${best.label}到 Ethereum（费 ${cents(best.feeUsd)} · ${etaLabel(best.etaSec)}）`);
      if (ctx.liveBridge?.error) notes.push(`真钱包读不到跨链报价（${ctx.liveBridge.error}），上面用的是模拟报价。`);
      need = r2(need - arrival);
    }
  }
  const closed = ctx.ladder.rows.find((r) => r.bucket === "closed")?.items ?? [];
  const narration = `申购 ${money(usdWanted)} OUSG。燃油：${fuel.length ? fuel.join("；") : "没有能动的稳定币"}。` + (need > 0 ? ` 还差 ${amount(need)}：${closed.map((it) => `${it.name} ${money(it.usd)}（${it.route.why ?? "关着"}）`).join("、") || "没有其他来源"}——这几条跑道现在关着。` : "");
  if (need > 0) {
    const cex = closed.find((it) => it.route.id === "withdraw" && it.usd >= need);
    notes.push(cex ? `差的 ${amount(need)}：给 ${cex.name} 的 key 开提币，${etaLabel(cex.route.etaSec)} · 约 ${cents(cexWithdrawFee(need))} 就能到；从银行走 ACH 是 T+1。两样都不经我。` : `差的 ${amount(need)} 得从别处打进来，不经我。`);
  }
  return { narration, steps, notes };
}

/** an order routed across every venue: one slice where one venue is best, several where no venue can take it alone or a split nets more */
function trade(side: Side, qty: number, base: string, ctx: PlanContext): Plan {
  const order = orderPlan(base, side, qty, ctx.accounts);
  return { narration: order.narration, steps: order.steps, order };
}

export function plan(text: string, ctx: PlanContext): Plan {
  const t = text.trim().toLowerCase().replace(/,/g, "");
  const m = /(\d+(?:\.\d+)?)/.exec(t);
  const n = m ? Number(m[1]) : undefined;
  if (/再平衡|rebalance|配置|偏重/.test(t)) {
    const order = orderPlan("ETH", "sell", 1, ctx.accounts);
    const atOndo = ctx.liquidity.mobile.filter((s) => s.account === "ondo").reduce((s, x) => s + x.usd, 0);
    const sub = Math.min(1500, atOndo);
    return {
      narration: `加密 ${ctx.cryptoPct}% 偏重。${order.steps.length ? `卖 1 ETH（${order.split.quotes.length} 个场所比过，在 ${lead(order.split.slices.map((s) => s.name).join(" + "))}成交）` : "ETH 现在卖不了"}${sub > 0 ? `，再用 Ondo 地址上的 USDC 申购 ${money(sub)} OUSG` : ""}。`,
      steps: [...order.steps, ...(sub > 0 ? [{ account: "ondo", intent: { kind: "subscribe" as const, fund: "OUSG", amountUsd: sub }, say: "申购 OUSG · Ondo" }] : [])],
      order,
    };
  }
  const tm = /(卖出|卖|sell|买入|买|buy)\s*(\d+(?:\.\d+)?)\s*(btc|eth|sol)/.exec(t);
  if (tm) return trade(/买|buy/.test(tm[1]!) ? "buy" : "sell", Number(tm[2]), tm[3]!.toUpperCase(), ctx);
  if (/guard|收紧|保守|严一点/.test(t)) return { narration: "收紧到 Guard：超过免审额度我先问你。", steps: [], mode: "guard" };
  if (/open|放开|全开|松一点/.test(t)) return { narration: "放开到 Open：凭据允许的我都做，只有转到新地址才问你。", steps: [], mode: "open" };
  if (/账单|付|pay|支付/.test(t)) {
    const usd = n ?? 120;
    const merchant = /github/.test(t) ? "GitHub" : "Anthropic";
    return { narration: `付 $${usd} 给 ${merchant}，走 Mastercard 的 agentic token。`, steps: [{ account: "mastercard", intent: { kind: "pay", merchant, mcc: "7372", amountUsd: usd }, say: `付 ${merchant} · Mastercard` }] };
  }
  if (/赎回|redeem/.test(t)) {
    const usd = n ?? 500;
    return { narration: `赎回 $${usd} OUSG，T+1 到账。`, steps: [{ account: "ondo", intent: { kind: "redeem", fund: "OUSG", amountUsd: usd }, say: "赎回 OUSG · Ondo" }] };
  }
  if (/申购|ousg|国债|treasur|集中/.test(t)) {
    const usd = n ?? 1000;
    const atOndo = ctx.liquidity.mobile.filter((s) => s.account === "ondo").reduce((s, x) => s + x.usd, 0);
    if (usd <= atOndo) return { narration: `申购 $${usd} OUSG，Ondo 地址上的 USDC 够，按 NAV 即时铸造。`, steps: [{ account: "ondo", intent: { kind: "subscribe", fund: "OUSG", amountUsd: usd }, say: "申购 OUSG · Ondo" }] };
    return routeToOndo(usd, ctx);
  }
  if (/冷钱包|提币|提现|withdraw/.test(t)) {
    return { narration: "把 0.1 BTC 从 Binance 提到你的冷钱包。", steps: [{ account: "binance", intent: { kind: "move", asset: "BTC", amount: 0.1, to: COLD }, say: "提 0.1 BTC 到冷钱包 · Binance" }] };
  }
  if (/新地址|转给|陌生|send to|transfer/.test(t)) {
    const usd = n ?? 300;
    return { narration: `往一个新地址转 $${usd} USDC（从 Ondo 那边的地址）。`, steps: [{ account: "ondo", intent: { kind: "move", asset: "USDC", amount: usd, to: STRANGER }, say: `转 $${usd} USDC 到新地址 ${STRANGER}` }] };
  }
  return { narration: `我能做：${PRESETS.join("、")}，卖 / 买任意数量（如「卖 1 ETH」「买 0.4 ETH」，大单会拆到几个场所），或者说「收紧到 Guard」。`, steps: [] };
}

export class AgentSession {
  constructor(private readonly svc: PortfolioService) {}

  async say(text: string): Promise<Flight> {
    const o = await this.svc.overview();
    const ondoAddress = o.accounts.find((a) => a.id === "ondo")?.address;
    const ctx: PlanContext = {
      cryptoPct: o.portfolio.byClass.find((c) => c.class === "crypto")?.pct ?? 0,
      liquidity: o.liquidity,
      ladder: o.ladder,
      accounts: o.accounts,
      ondoAddress,
      liveBridge: await this.liveBridgeQuotes(o.liquidity, ondoAddress),
    };
    const p = plan(text, ctx);
    const f = this.svc.openFlight(PAGE_AGENT, text);
    const first = this.svc.note(f, p.narration);
    if (p.order?.parts && p.narration === p.order.narration) first.parts = p.order.parts;
    if (p.mode) {
      this.svc.setMode(p.mode);
      this.svc.note(f, p.mode === "guard" ? "已收紧到 Guard" : "已放开到 Open", "ok");
    }
    // an order's slices fly together: the wallet judges the whole order and asks at most once
    const slices = p.order ? p.order.steps.length : 0;
    const results: Array<ExecuteOutcome | null> = slices > 0 && p.order ? await this.svc.flyBatch(f, p.order.title, p.steps.slice(0, slices)) : [];
    for (const s of p.steps.slice(slices)) {
      const prerequisite = s.needs === undefined ? null : results[s.needs];
      if (s.needs !== undefined && (prerequisite === null || prerequisite === undefined || isPending(prerequisite) || prerequisite.ok !== true)) {
        this.svc.note(f, `${s.say}：前一段没成，跳过`);
        results.push(null);
        continue;
      }
      results.push(await this.svc.fly(f, s.account, s.intent, s.say, s.compare));
    }
    for (const n of p.notes ?? []) this.svc.note(f, n);
    if (p.order) await this.svc.closeOrder(f, p.order, results.slice(0, slices));
    return f;
  }

  /** when the MetaMask wallet is live and holds something to bridge, ask it for real quotes (read-only); say why if it cannot */
  private async liveBridgeQuotes(liq: Liquidity, ondoAddress: string | undefined): Promise<PlanContext["liveBridge"]> {
    const mm = this.svc.adapter("metamask");
    const usd = liq.mobile.filter((s) => s.account === "metamask" && s.asset === "USDC").reduce((s, x) => s + x.usd, 0);
    if (!this.svc.live || !mm?.quote || !ondoAddress || usd <= 0) return undefined;
    try {
      return { quotes: await mm.quote({ kind: "move", asset: "USDC", amount: usd, to: ondoAddress, fromChainId: BASE, chainId: ETHEREUM }) };
    } catch (err) {
      const message = (err as Error).message;
      return { error: /"code":"([A-Z_]+)"/.exec(message)?.[1] ?? message.slice(0, 80) };
    }
  }
}
