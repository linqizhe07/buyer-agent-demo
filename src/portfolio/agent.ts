/** The agent behind the page's one sentence box.
 *
 * A keyword script, not an LLM — but its plans are ROUTED, not canned:
 *
 *   "Subscribe $5,000 OUSG"  reads the liquidity ladder: fuel already at the
 *                     issuer first; then what the on-chain wallet holds on
 *                     another chain, over the cheapest open bridge (the quote
 *                     and what it beat go on the leg; the fee comes out of what
 *                     arrives); then the gap, with the closed runways and what
 *                     opening one would cost.
 *   "Sell 1 ETH"      quotes the same order at every venue (two CEX books, the
 *                     DEX pools on each chain the wallet holds the asset on)
 *                     and sells where the net is highest; a venue that does not
 *                     hold the asset says so.
 *   "Sell 3 ETH"      no venue holds that much, so the order is SPLIT: each
 *                     slice goes where its marginal price is best (router.ts,
 *                     venues.ts). The slices fly as one order — one card at
 *                     most — and the DEX slice shows its route.
 *   "Buy 1,000 YES · Fed hike"  an event contract: the same question at
 *                     Polymarket and at Kalshi, each with its own book, fee
 *                     and cash; the order is routed and split like any other.
 *   "Fund Polymarket with 300"  bridges USDC from the on-chain wallet straight
 *                     into the Polymarket deposit wallet on Polygon.
 *
 * Every plan flies as one flight with one leg per account the money touches;
 * the service writes the legs in plain words. It also understands the Chinese
 * for each of these.
 */
import { PAGE_AGENT, qtyText, type RouteQuote } from "./accounts.ts";
import { eventSymbol, findEvent, parseEventSymbol, type Outcome } from "./events.ts";
import type { Mode } from "./openness.ts";
import type { Liquidity } from "./portfolio.ts";
import { bridgeQuotes, cexWithdrawFee, etaLabel, pick, routesToHub, type Ladder, type RailAccount } from "./rails.ts";
import { orderPlan, type OrderPlan, type Step } from "./router.ts";
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
  /** the Polymarket deposit wallet (a funding bridge's destination) */
  polymarketAddress?: string | undefined;
  /** the clock, for a market's state (open, past its close, settled) */
  now?: string | undefined;
  /** bridge quotes read from the live MetaMask wallet, or why they could not be read */
  liveBridge?: { quotes?: RouteQuote[] | undefined; error?: string | undefined } | undefined;
}

export const PRESETS = ["Subscribe $5,000 OUSG", "Sell 3 ETH", "Buy 1,000 YES · Fed hike", "Rebalance", "Pay a bill", "Withdraw to cold wallet", "Send to a new address"];
const COLD = "0x9C0d4E3b7a2f1c8d9e0f1a2b3c4d5e6f7a8b9c0d";
const STRANGER = "0x7a11…stranger";
const BASE = 8453;
const ETHEREUM = 1;
const POLYGON = 137;
const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const amount = (n: number) => (Number.isInteger(n) ? money(n) : cents(n));
const r2 = (n: number) => Number(n.toFixed(2));
const routeWords = (q: RouteQuote) => (q.open ? `${q.label} ${cents(q.feeUsd)} · ${etaLabel(q.etaSec)}` : `${q.label} closed (${q.why ?? "unavailable"})`);

/** the on-chain wallet's USDC that sits on Base, ready to bridge */
function baseUsdc(ctx: PlanContext) {
  const mm = ctx.accounts.find((a) => a.id === "metamask");
  const usdc = mm?.holdings.find((h) => h.asset === "USDC" && h.usd > 0 && (h.note === "Base" || h.note === undefined));
  return mm && usdc && !mm.revoked && mm.reach.includes("move") ? { mm, usdc } : undefined;
}

/** the router: fuel at the issuer first, then what the on-chain wallet can bridge (cheapest open route), then the gap and what closing it would take */
function routeToOndo(usdWanted: number, ctx: PlanContext): Plan {
  const atOndo = ctx.liquidity.mobile.filter((s) => s.account === "ondo").reduce((s, x) => s + x.usd, 0);
  const onBase = baseUsdc(ctx);
  const steps: Step[] = [];
  const fuel: string[] = [];
  const notes: string[] = [];
  let need = usdWanted;
  if (atOndo > 0 && need > 0) {
    const x = Math.min(need, atOndo);
    steps.push({ account: "ondo", intent: { kind: "subscribe", fund: "OUSG", amountUsd: x }, say: `Subscribe ${money(x)} OUSG · USDC at the Ondo address` });
    fuel.push(`${money(atOndo)} USDC at the Ondo address (instant)`);
    need = r2(need - x);
  }
  if (need > 0 && onBase && ctx.ondoAddress) {
    const x = Math.min(need, onBase.usdc.usd);
    const sim = routesToHub(onBase.mm, { ...onBase.usdc, usd: x }, ctx.accounts);
    const live = ctx.liveBridge?.quotes ?? [];
    const quotes = live.length ? [...live, ...sim.filter((q) => q.id.startsWith("cex:"))] : sim;
    const best = pick(quotes, "cost");
    if (best) {
      const arrival = r2(x - best.feeUsd);
      const bridge = steps.length;
      steps.push({ account: "metamask", intent: { kind: "move", asset: "USDC", amount: x, to: ctx.ondoAddress, fromChainId: BASE, chainId: ETHEREUM, via: best.id }, say: `Bridge ${money(x)} USDC: Base → Ethereum → Ondo address`, compare: `Compared: ${quotes.filter((q) => q.id !== best.id).map(routeWords).join("; ")}` });
      steps.push({ account: "ondo", intent: { kind: "subscribe", fund: "OUSG", amountUsd: arrival }, say: `Subscribe ${amount(arrival)} OUSG · the bridged USDC`, needs: bridge });
      fuel.push(`MetaMask has ${money(onBase.usdc.usd)} USDC on Base, over the ${best.label} to Ethereum (fee ${cents(best.feeUsd)} · ${etaLabel(best.etaSec)})`);
      if (ctx.liveBridge?.error) notes.push(`The live wallet could not give bridge quotes (${ctx.liveBridge.error}); the quotes above are simulated.`);
      need = r2(need - arrival);
    }
  }
  const closed = ctx.ladder.rows.find((r) => r.bucket === "closed")?.items ?? [];
  const narration = `Subscribe ${money(usdWanted)} OUSG. Fuel: ${fuel.length ? fuel.join("; ") : "no stablecoins I can move"}.` + (need > 0 ? ` Still ${amount(need)} short: ${closed.map((it) => `${it.name} ${money(it.usd)} (${it.route.why ?? "closed"})`).join(", ") || "no other source"}. Those runways are closed right now.` : "");
  if (need > 0) {
    const cex = closed.find((it) => it.route.id === "withdraw" && it.usd >= need);
    notes.push(cex ? `The missing ${amount(need)}: open withdrawals on the ${cex.name} key and it arrives in ${etaLabel(cex.route.etaSec)} for about ${cents(cexWithdrawFee(need))}; ACH from the bank is T+1. Neither goes through me.` : `The missing ${amount(need)} has to come from somewhere else; not through me.`);
    // money the agent could move but that is parked for something else: say it is there rather than take it
    const parked = ctx.liquidity.mobile.filter((s) => ctx.accounts.find((a) => a.id === s.account)?.kind === "prediction");
    if (parked.length) notes.push(`${parked.map((s) => `${s.name} holds ${money(s.usd)} ${s.asset}`).join("; ")}: it could come over in minutes, but it is parked for betting. Say so and I'll move it.`);
  }
  return { narration, steps, notes };
}

/** an order routed across every venue: one slice where one venue is best, several where no venue can take it alone or a split nets more */
function trade(side: Side, qty: number, base: string, ctx: PlanContext): Plan {
  const order = orderPlan(base, side, qty, ctx.accounts, ctx.now);
  return { narration: order.narration, steps: order.steps, order };
}

/** bridge USDC from the on-chain wallet straight into the Polymarket deposit wallet on Polygon */
function fundPolymarket(usd: number, ctx: PlanContext): Plan {
  const onBase = baseUsdc(ctx);
  if (!ctx.polymarketAddress) return { narration: "Polymarket is not connected.", steps: [] };
  if (!onBase || onBase.usdc.usd < usd) return { narration: `Fund Polymarket with ${money(usd)}: MetaMask has ${money(onBase?.usdc.usd ?? 0)} USDC on Base that I can move. Not enough.`, steps: [] };
  const quotes = bridgeQuotes(usd, "Polygon", "Base");
  const best = pick(quotes, "cost")!;
  return {
    narration: `Fund Polymarket with ${money(usd)}: MetaMask has ${money(onBase.usdc.usd)} USDC on Base; over the ${best.label} to Polygon (fee ${cents(best.feeUsd)} · ${etaLabel(best.etaSec)}), straight into the Polymarket deposit wallet.`,
    steps: [{ account: "metamask", intent: { kind: "move", asset: "USDC", amount: usd, to: ctx.polymarketAddress, fromChainId: BASE, chainId: POLYGON, via: best.id }, say: `Bridge ${money(usd)} USDC: Base → Polygon → Polymarket deposit wallet`, compare: `Compared: ${quotes.filter((q) => q.id !== best.id).map(routeWords).join("; ")}` }],
  };
}

/** claim the winning shares of settled markets */
function redeemWinnings(ctx: PlanContext): Plan {
  const won = ctx.accounts.filter((a) => a.kind === "prediction" && !a.revoked && a.reach.includes("redeem")).flatMap((a) => a.holdings.filter((h) => h.redeemable).map((h) => ({ a, h })));
  if (!won.length) return { narration: "Nothing to redeem: no settled market has paid out in your favour.", steps: [] };
  return {
    narration: `Redeem ${cents(won.reduce((s, x) => s + x.h.usd, 0))} of winnings: ${won.map(({ h }) => `${qtyText(h.amount)} shares of "${parseEventSymbol(h.asset)?.event.title ?? h.asset}" (settled ${parseEventSymbol(h.asset)?.outcome})`).join("; ")}.`,
    steps: won.map(({ a, h }) => ({ account: a.id, intent: { kind: "redeem" as const, fund: h.asset.split(":")[0]!, amountUsd: h.usd }, say: `Redeem ${qtyText(h.amount)} winning shares · ${a.name}` })),
  };
}

export function plan(text: string, ctx: PlanContext): Plan {
  const t = text.trim().toLowerCase().replace(/,/g, "");
  const m = /(\d+(?:\.\d+)?)/.exec(t);
  const n = m ? Number(m[1]) : undefined;
  if (/再平衡|rebalance|overweight|偏重/.test(t)) {
    const order = orderPlan("ETH", "sell", 1, ctx.accounts, ctx.now);
    const atOndo = ctx.liquidity.mobile.filter((s) => s.account === "ondo").reduce((s, x) => s + x.usd, 0);
    const sub = Math.min(1500, atOndo);
    return {
      narration: `Crypto is ${ctx.cryptoPct}% of the portfolio, overweight. ${order.steps.length ? `Sell 1 ETH (compared at ${order.split.quotes.length} venues, filled at ${order.split.slices.map((s) => s.name).join(" + ")})` : "ETH cannot be sold right now"}${sub > 0 ? `, then subscribe ${money(sub)} OUSG with the USDC at the Ondo address` : ""}.`,
      steps: [...order.steps, ...(sub > 0 ? [{ account: "ondo", intent: { kind: "subscribe" as const, fund: "OUSG", amountUsd: sub }, say: "Subscribe OUSG · Ondo" }] : [])],
      order,
    };
  }
  const side = /(卖出|卖|sell|买入|买|buy)\s*\$?(\d+(?:\.\d+)?)/.exec(t);
  const spot = /(卖出|卖|sell|买入|买|buy)\s*(\d+(?:\.\d+)?)\s*(btc|eth|sol)\b/.exec(t);
  if (spot) return trade(/买|buy/.test(spot[1]!) ? "buy" : "sell", Number(spot[2]), spot[3]!.toUpperCase(), ctx);
  const event = findEvent(t);
  if (side && event) {
    const outcome: Outcome = /\bno\b|否/.test(t) ? "NO" : "YES";
    return trade(/买|buy/.test(side[1]!) ? "buy" : "sell", Number(side[2]), eventSymbol(event.id, outcome), ctx);
  }
  if (/polymarket/.test(t) && /fund|top ?up|deposit|充/.test(t)) return fundPolymarket(n ?? 300, ctx);
  if (/winnings|claim|兑付|领奖/.test(t)) return redeemWinnings(ctx);
  if (/guard|tighten|收紧|保守|严一点/.test(t)) return { narration: "Tightening to Guard: above the no-ask limit I ask you first.", steps: [], mode: "guard" };
  if (/\bopen\b|loosen|放开|全开|松一点/.test(t)) return { narration: "Opening up: I do whatever the credentials allow, and only stop to ask before something dangerous (a new address, a market past its close).", steps: [], mode: "open" };
  if (/账单|付|\bpay\b|\bbill\b|支付/.test(t)) {
    const usd = n ?? 120;
    const merchant = /github/.test(t) ? "GitHub" : "Anthropic";
    return { narration: `Pay $${usd} to ${merchant} with the Mastercard agentic token.`, steps: [{ account: "mastercard", intent: { kind: "pay", merchant, mcc: "7372", amountUsd: usd }, say: `Pay ${merchant} · Mastercard` }] };
  }
  if (/赎回|redeem/.test(t)) {
    const usd = n ?? 500;
    return { narration: `Redeem $${usd} OUSG; it settles T+1.`, steps: [{ account: "ondo", intent: { kind: "redeem", fund: "OUSG", amountUsd: usd }, say: "Redeem OUSG · Ondo" }] };
  }
  if (/申购|subscribe|ousg|国债|treasur/.test(t)) {
    const usd = n ?? 1000;
    const atOndo = ctx.liquidity.mobile.filter((s) => s.account === "ondo").reduce((s, x) => s + x.usd, 0);
    if (usd <= atOndo) return { narration: `Subscribe $${usd} OUSG: the USDC at the Ondo address covers it, minted at NAV right away.`, steps: [{ account: "ondo", intent: { kind: "subscribe", fund: "OUSG", amountUsd: usd }, say: "Subscribe OUSG · Ondo" }] };
    return routeToOndo(usd, ctx);
  }
  if (/冷钱包|cold|提币|提现|withdraw/.test(t)) {
    return { narration: "Withdraw 0.1 BTC from Binance to your cold wallet.", steps: [{ account: "binance", intent: { kind: "move", asset: "BTC", amount: 0.1, to: COLD }, say: "Withdraw 0.1 BTC to the cold wallet · Binance" }] };
  }
  if (/新地址|new address|转给|陌生|send to|transfer/.test(t)) {
    const usd = n ?? 300;
    return { narration: `Send $${usd} USDC to a new address (from the Ondo address).`, steps: [{ account: "ondo", intent: { kind: "move", asset: "USDC", amount: usd, to: STRANGER }, say: `Send $${usd} USDC to new address ${STRANGER}` }] };
  }
  return { narration: `I can do: ${PRESETS.join(" / ")}. Also: sell or buy any size (“sell 1 ETH”, “buy 0.4 ETH”; a large order is split across venues), “fund Polymarket with 300”, “redeem winnings”, or “tighten to Guard”.`, steps: [] };
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
      polymarketAddress: o.accounts.find((a) => a.id === "polymarket")?.address,
      now: o.now,
      liveBridge: await this.liveBridgeQuotes(o.liquidity, ondoAddress),
    };
    const p = plan(text, ctx);
    const f = this.svc.openFlight(PAGE_AGENT, text);
    const first = this.svc.note(f, p.narration);
    if (p.order?.parts && p.narration === p.order.narration) first.parts = p.order.parts;
    if (p.mode) {
      this.svc.setMode(p.mode);
      this.svc.note(f, p.mode === "guard" ? "Now in Guard" : "Now in Open", "ok");
    }
    // an order's slices fly together: the wallet judges the whole order and asks at most once
    const slices = p.order ? p.order.steps.length : 0;
    const results: Array<ExecuteOutcome | null> = slices > 0 && p.order ? await this.svc.flyBatch(f, p.order.title, p.steps.slice(0, slices)) : [];
    for (const s of p.steps.slice(slices)) {
      const prerequisite = s.needs === undefined ? null : results[s.needs];
      if (s.needs !== undefined && (prerequisite === null || prerequisite === undefined || isPending(prerequisite) || prerequisite.ok !== true)) {
        this.svc.note(f, `${s.say}: the leg before it did not complete, skipped`);
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
