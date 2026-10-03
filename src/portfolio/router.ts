/** An order as a flight: the router's plan (venues.ts) in the agent's words —
 * what it compared, one step per slice, what it left alone and why, and where
 * the proceeds end up (a sale on a CEX whose key cannot withdraw leaves the
 * money stuck there; a sale on a DEX leaves it on-chain, free to move).
 *
 * Pure. The service flies it: every slice is a leg, and the whole order is ONE
 * decision for the human — one card, not one per slice. */
import { chainIdOf, qtyText, type Intent } from "./accounts.ts";
import type { RailAccount } from "./rails.ts";
import { EXTRA_LEG_MIN_GAIN_USD, splitOrder, type Side, type Slice, type SplitPlan } from "./venues.ts";
import { cents } from "./words.ts";

export interface Step {
  account: string;
  intent: Intent;
  /** the agent's own words for this action */
  say: string;
  /** what this step was chosen over (other routes, other venues) */
  compare?: string | undefined;
  /** index of a step that must have succeeded first (a subscribe after a bridge) */
  needs?: number | undefined;
}

/** one segment of the split bar on the page */
export interface Part {
  label: string;
  pct: number;
  kind: "cex" | "dex";
}

export interface OrderPlan {
  base: string;
  side: Side;
  qty: number;
  /** `卖出 3 ETH` */
  title: string;
  split: SplitPlan;
  narration: string;
  /** one per slice, best price first; empty when the order cannot be done */
  steps: Step[];
  /** about the plan: what was left out and why */
  notes: string[];
  /** about the outcome — where the proceeds are. Said only once the order has actually filled (after the card, if there is one) */
  after: string[];
  parts?: Part[] | undefined;
}

const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const price = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** a name followed by a number or a word: a full-width bracket already carries its own space */
export const lead = (name: string): string => (name.endsWith("）") ? name : `${name} `);

export function orderPlan(base: string, side: Side, qty: number, accounts: RailAccount[]): OrderPlan {
  const split = splitOrder(base, side, qty, accounts);
  const sell = side === "sell";
  const verb = sell ? "卖出" : "买入";
  const got = sell ? "净得" : "共付";
  const title = `${verb} ${qtyText(qty)} ${base}`;
  const out: OrderPlan = { base, side, qty, title, split, narration: "", steps: [], notes: [], after: [] };

  if (!split.feasible) {
    const reasons = split.quotes.filter((q) => !q.ok).map((q) => `${lead(q.name)}${q.why ?? "接不了"}`).join("；");
    out.narration = !split.quotes.length
      ? `${title}：没有接入能交易 ${base} 的场所。`
      : split.maxQty > 0
        ? `${title}：所有场所加起来${sell ? `只有 ${qtyText(split.maxQty)} ${base}，卖不了这么多` : `只买得起 ${qtyText(split.maxQty)} ${base}`}——${reasons}。`
        : `${title}：现在没有一个场所接得了——${reasons || "没有库存"}。`;
    return out;
  }

  const stepOf = (s: Slice, compare?: string): Step => ({
    account: s.account,
    intent: { kind: "trade", symbol: s.symbol, side, qty: s.qty, ...(s.chain ? { chainId: chainIdOf(s.chain) } : {}) },
    say: `${verb} ${qtyText(s.qty)} ${base} · ${s.name}`,
    compare,
  });

  if (split.slices.length === 1) {
    const best = split.slices[0]!;
    const rest = split.quotes.filter((q) => q.venue !== best.venue);
    const priced = rest.filter((q) => q.ok).sort((a, b) => (sell ? b.netUsd - a.netUsd : a.netUsd - b.netUsd));
    const others = [...priced.map((q) => `${lead(q.name)}${got} ${cents(q.netUsd)}（${sell ? "少" : "多"} ${cents(Math.abs(best.netUsd - q.netUsd))}）`), ...rest.filter((q) => !q.ok).map((q) => `${lead(q.name)}${q.why ?? "接不了"}`)];
    const richer = split.richer ? `——拆成 ${split.richer.slices.map((s) => s.name).join(" + ")} 只${sell ? "多" : "省"} ${cents(split.richer.gainUsd)}，不到 ${cents(EXTRA_LEG_MIN_GAIN_USD)}` : "";
    out.narration = `${title}：${split.quotes.length} 个场所比过，${lead(best.name)}${sell ? "净得最多" : "花得最少"}（${cents(best.netUsd)}），一处接得下，不用拆${richer}。`;
    out.steps = [stepOf(best, others.length ? `比过：${others.join("；")}` : undefined)];
  } else {
    const n = split.slices.length;
    const haves = split.quotes.filter((q) => q.have > 0).map((q) => `${lead(q.name)}${sell ? qtyText(q.have) : money(q.have)}`).join(" · ");
    out.narration = split.single
      ? `${title}：一处接得下的最好是 ${split.single.name}（${got} ${cents(split.single.netUsd)}）；拆成 ${n} 片${got} ${cents(split.netUsd)}，${sell ? "多" : "省"} ${cents(split.gainUsd ?? 0)}。`
      : `${title}：没有一个场所${sell ? "接得下" : "的钱够"}（${haves}）。拆成 ${n} 片，均价 ${price(split.avgPrice)}，${got} ${cents(split.netUsd)}。`;
    out.steps = split.slices.map((s) => stepOf(s));
    out.parts = split.slices.map((s) => ({ label: `${lead(s.name)}${qtyText(s.qty)}`, pct: Math.round((s.qty / qty) * 100), kind: s.kind }));
    const passed = split.passed.map((p) => `${lead(p.name)}${sell ? `的 ${qtyText(p.have)} ${base} 没动` : "没用"}：${p.gasUsd !== undefined && p.gasUsd >= 1 ? `一笔 swap 的 gas ${cents(p.gasUsd)}，` : ""}用上它反而${sell ? "少" : "多花"} ${cents(-p.deltaUsd)}`);
    // a richer split exists but its extra leg earns less than the threshold: say so, and say what it was
    if (split.richer) passed.unshift(`再多拆一片（${split.richer.slices.map((s) => `${lead(s.name)}${qtyText(s.qty)}`).join(" · ")}）只${sell ? "多" : "省"} ${cents(split.richer.gainUsd)}，不到 ${cents(EXTRA_LEG_MIN_GAIN_USD)}，不多飞一段`);
    if (passed.length) out.notes.push(`比过：${passed.join("；")}。`);
  }

  // where the proceeds are: stuck at a CEX whose key cannot withdraw, or on-chain and free to move
  if (sell) {
    const stuck = split.slices.filter((s) => s.kind === "cex" && !accounts.find((a) => a.id === s.account)?.reach.includes("move"));
    const onchain = split.slices.filter((s) => s.kind === "dex");
    if (split.slices.length === 1) {
      if (stuck[0]) out.after.push(`卖出的 ${stuck[0].quote} 留在 ${stuck[0].name}：这把 key 提不出来，它困在那里。`);
      else if (onchain[0]) out.after.push(`卖出的 ${onchain[0].quote} 在 ${onchain[0].chain} 上，随时能动。`);
    } else {
      const where: string[] = [];
      if (stuck.length) where.push(`${stuck[0]!.quote} 留在 ${stuck.map((s) => s.name).join("、")}（key 提不出来）`);
      if (onchain.length) where.push(`DEX 那片的 ${onchain[0]!.quote} 在 ${onchain.map((s) => s.chain).join("、")} 上，随时能动`);
      if (where.length) out.after.push(`卖出的钱：${where.join("；")}。`);
    }
  }
  return out;
}
