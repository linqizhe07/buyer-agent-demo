import { reconcileVenue, type ReconcileResult } from "../../agent/reconcile.ts";
import type { AlpacaStatement } from "../../venues/alpaca.ts";
import type { BinanceStatement } from "../../venues/binance.ts";
import type { HlStatement } from "../../venues/hyperliquid.ts";
import type { ChainStatement } from "../../venues/solana-chain.ts";
import type { WalletStatement } from "../../venues/wallet.ts";
import { showRefusal } from "../narration.ts";
import { withdrawToWallet } from "../operator.ts";
import type { Beat } from "./types.ts";

const ATTACKER = "0xb14705888f4a68391a09aa5968dd25d16c3bba7b";

export const reconcileBeat: Beat = {
  name: "reconcile",
  title: "提回与对账：float 回主钱包，账本 vs 四家场所与钱包自己的流水",
  async run(ctx) {
    const { env } = ctx;
    const results: ReconcileResult[] = [];

    ctx.say("交易结束，操作员把 float 提回主钱包。场所的提币白名单只有主钱包地址：先试一个别的地址。");
    const bad = await withdrawToWallet(env, "binance", { amount: 100, destination: ATTACKER });
    if (bad.refusal) showRefusal(bad.refusal);
    ctx.check(bad.refusal?.code === "E_VENUE_WITHDRAW_WHITELIST", "the VENUE refused the withdrawal: address not in the whitelist, even with the operator's WITHDRAW key", "venue");
    const w1 = await withdrawToWallet(env, "binance");
    const w2 = await withdrawToWallet(env, "hyperliquid");
    ctx.check(w1.ok && w2.ok, `float back home: binance $${w1.amount} USDT · hyperliquid $${w2.amount} USDC (withdrawable; margin stays)`, "wallet");

    const alpaca = env.venues.alpaca?.statement() as AlpacaStatement | undefined;
    if (alpaca) results.push(reconcileVenue(env.ledger, { venue: "alpaca", fillIds: alpaca.fills.map((f) => f.order_id), withdrawals: 0 }));
    const hl = env.venues.hyperliquid?.statement() as HlStatement | undefined;
    const walletAddr = (env.venues.wallet as { address?: string } | undefined)?.address;
    if (hl) results.push(reconcileVenue(env.ledger, { venue: "hyperliquid", fillIds: hl.fills.map((f) => String(f.oid)), withdrawals: hl.withdrawals.filter((w) => w.destination !== walletAddr).length }));
    const bn = env.venues.binance?.statement() as BinanceStatement | undefined;
    if (bn) results.push(reconcileVenue(env.ledger, { venue: "binance", fillIds: bn.trades.map((t) => String(t.orderId)), withdrawals: bn.withdrawals.filter((w) => w.address !== walletAddr).length }));
    const sol = env.venues.solana?.statement() as ChainStatement | undefined;
    if (sol) results.push(reconcileVenue(env.ledger, { venue: "solana", fillIds: sol.transactions.map((t) => t.signature), withdrawals: 0 }));

    // the wallet's flows against the venues' deposit / withdrawal records (venue withdrawals here are the operator's, to the wallet)
    const wallet = env.venues.wallet?.statement() as WalletStatement | undefined;
    if (wallet && hl && bn) {
      const outBn = wallet.transfers.filter((t) => t.venue === "binance" && t.direction === "out").reduce((s, t) => s + t.amount, 0);
      const outHl = wallet.transfers.filter((t) => t.venue === "hyperliquid" && t.direction === "out").reduce((s, t) => s + t.amount, 0);
      const inBn = wallet.transfers.filter((t) => t.venue === "binance" && t.direction === "in").reduce((s, t) => s + t.amount, 0);
      const inHl = wallet.transfers.filter((t) => t.venue === "hyperliquid" && t.direction === "in").reduce((s, t) => s + t.amount, 0);
      const depBn = bn.deposits.reduce((s, d) => s + Number(d.amount), 0);
      const depHl = hl.deposits.reduce((s, d) => s + Number(d.amount), 0);
      const wdBn = bn.withdrawals.reduce((s, d) => s + Number(d.amount), 0);
      const wdHl = hl.withdrawals.reduce((s, d) => s + Number(d.amount), 0);
      const okFlows = outBn === depBn && outHl === depHl && inBn === wdBn && inHl === wdHl;
      const onlyToWallet = [...bn.withdrawals, ...hl.withdrawals].every((w) => ("address" in w ? w.address : w.destination) === wallet.address);
      ctx.check(okFlows && onlyToWallet, `wallet · out $${outBn + outHl} = venue deposits $${depBn + depHl} · in $${inBn + inHl} = venue withdrawals $${wdBn + wdHl} · every withdrawal landed at the wallet`, "reconcile");
      ctx.say(`  float still at the venues: binance net $${wallet.floats.binance?.net} (held as BTC) · hyperliquid net $${wallet.floats.hyperliquid?.net} (margin on the open position)`);
      env.ledger.append({ kind: "reconcile", venue: "wallet", outcome: okFlows && onlyToWallet ? "matched" : "diff", detail: { outBn, outHl, inBn, inHl, depBn, depHl, wdBn, wdHl } });
      env.bus.emit("reconcile/result", { venue: "wallet", ok: okFlows && onlyToWallet, ledgerFills: 0, venueFills: 0, matched: 0, missingAtVenue: [], unknownAtVenue: [], refusals: 0, bypassAttempts: 0, venueWithdrawals: 0, flows: { outBn, outHl, inBn, inHl } });
    }

    for (const r of results) {
      env.ledger.append({ kind: "reconcile", venue: r.venue, outcome: r.ok ? "matched" : "diff", detail: r });
      env.bus.emit("reconcile/result", r);
      ctx.check(
        r.ok,
        `${r.venue} · ledger ${r.ledgerFills} fills ↔ venue ${r.venueFills} · matched ${r.matched} · missing ${r.missingAtVenue.length} · unknown ${r.unknownAtVenue.length} · refusals ${r.refusals} · bypass attempts ${r.bypassAttempts} · withdrawals elsewhere ${r.venueWithdrawals}`,
        "reconcile",
      );
    }
    const fills = results.reduce((s, r) => s + r.matched, 0);
    const refusals = results.reduce((s, r) => s + r.refusals, 0);
    const okCount = results.filter((r) => r.ok).length;
    const atMount = env.ledger.byKind("mount-refusal").filter((r) => !results.some((x) => x.venue === r.venue)).length;
    ctx.check(okCount === results.length && results.length === 4, `reconcile ${okCount}/${results.length} · fills ${fills} · refusals ${refusals} at the venues + ${atMount} at mount · diff 0 · ledger matches`, "reconcile");
    const chain = env.ledger.verifyChain();
    ctx.check(chain.ok, `ledger chain verified after reconcile: ${chain.rows} rows`, "ledger");
    if (okCount === results.length) env.counters.lossUsd = 0;
  },
};
