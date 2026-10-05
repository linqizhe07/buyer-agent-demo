/** An account at Hyperliquid (HyperCore), in-memory — the venue whose doors
 * this whole account layer was modelled on, now one of the venues behind them.
 *
 * What is real here is the SHAPE of each door, taken from Hyperliquid's docs,
 * its SDK and the app as it ran on 2026-10-04:
 *   in      USDC arrives over Circle's CCTP. The interface takes no deposit
 *           under 5 USDC; a 0.2 USDC forwarding fee comes out of what arrives.
 *   out     a withdrawal is a USER-SIGNED action (`sendToEvmWithData`): only the
 *           master account's key can sign it. An API wallet cannot — "API
 *           wallets … can perform actions on behalf of an account without
 *           having withdrawal permissions". 0.2 USDC, and margin must be kept.
 *   inside  perps ⇄ spot is `sendAsset` to oneself; an API wallet may do it
 *           (`agentSendAsset`, destination = source). Money can go home.
 *   swap    stablecoins trade on the spot book as an IOC order, minimum 10.
 *
 * The balances, the fee on a swap and the margin in use are illustrative
 * numbers. Nothing here talks to Hyperliquid.
 */
import { no } from "../refuse.ts";
import { r2, type Account, type AccountAdapter, type Holding, type Intent, type StatementLine, type VenueResult } from "../accounts.ts";

export interface HyperliquidSeed {
  perpsUsdc: number;
  spotUsdc: number;
  spotUsdt: number;
  /** margin behind open positions: it cannot be withdrawn */
  marginUsed: number;
  /** what the venue says about this customer's region; the venue's own list, never ours */
  geoblock?: { blocked: boolean } | undefined;
}

/** the interface's own minimum for a USDC deposit (the legacy bridge loses anything smaller; the account refuses before sending) */
export const HL_MIN_DEPOSIT = 5;
export const HL_MIN_SWAP = 10;
/** stablecoin pairs pay a fifth of the spot taker fee: 0.014% */
const SWAP_FEE = 0.00014;

export function hyperliquidAccount(seed: HyperliquidSeed, now: () => string): AccountAdapter {
  const bal = { perps: seed.perpsUsdc, spot: seed.spotUsdc, usdt: seed.spotUsdt };
  const lines: StatementLine[] = [];
  let seq = 0;
  const blocked = seed.geoblock?.blocked === true;
  const account: Account = {
    id: "hyperliquid",
    name: "Hyperliquid",
    kind: "perp",
    provider: "Hyperliquid (HyperCore)",
    credentialRef: "home/credentials/hyperliquid/api-wallet.json",
    credentialKind: "API wallet approved by the master account (approveAgent)",
    scope: {
      can: ["read"],
      limits: ["an API wallet places orders and moves collateral between the account's own balances; it cannot withdraw and cannot send to anyone else", "a withdrawal is signed by the master account's key (a user-signed action) and must leave the margin of open positions behind", "every action carries a nonce: the 100 highest are kept per signer"],
      enforcedBy: "venue",
    },
    settlement: "HyperCore balances move at once · USDC in and out rides Circle's CCTP",
    live: false,
    ...(blocked ? { restricted: "Not available in your region" } : {}),
  };
  const withdrawable = () => r2(Math.max(0, bal.perps - seed.marginUsed));
  const line = (direction: "in" | "out", asset: string, amount: number, native: unknown) => lines.push({ id: `hl-${String(++seq).padStart(4, "0")}`, at: now(), direction, asset, amount, status: "settled", native });
  const geo = () => no("E_VENUE_GEOBLOCKED", { venue: "hyperliquid", native: { message: "You are accessing our products and services from a restricted jurisdiction." } });
  return {
    account,
    async read(): Promise<Holding[]> {
      const rows: Holding[] = [];
      if (bal.perps > 0) rows.push({ account: account.id, asset: "USDC", amount: bal.perps, usd: bal.perps, class: "stable", note: seed.marginUsed > 0 ? `perps · $${withdrawable()} withdrawable, $${seed.marginUsed} is margin` : "perps" });
      if (bal.spot > 0) rows.push({ account: account.id, asset: "USDC", amount: bal.spot, usd: bal.spot, class: "stable", note: "spot" });
      if (bal.usdt > 0) rows.push({ account: account.id, asset: "USDT", amount: bal.usdt, usd: bal.usdt, class: "stable", note: "spot" });
      return rows;
    },
    /** the API wallet's own reach: it cannot take money out of the account */
    async execute(i: Intent) {
      if (i.kind === "move") return no("E_VENUE_AGENT_NO_WITHDRAW", { venue: "hyperliquid", message: "Hyperliquid: an API wallet cannot withdraw or send; only the master account's signature can", native: { status: "err", response: "API wallets cannot sign user-signed actions" } });
      return no("E_VENUE_REJECTED", { venue: "hyperliquid", message: `orders at Hyperliquid go through the venue's own seat, not through the account ("${i.kind}")`, native: { status: "err", response: "unsupported here" } });
    },
    credit(asset, amount, where = "perps") {
      if (asset === "USDT") bal.usdt = r2(bal.usdt + amount);
      else if (where === "spot") bal.spot = r2(bal.spot + amount);
      else bal.perps = r2(bal.perps + amount);
      line("in", asset, amount, { type: "deposit", usdc: amount.toFixed(2) });
    },
    /** the master account's signed withdrawal, as the venue judges it */
    debit(asset, amount, where = "perps"): VenueResult {
      if (blocked) return geo();
      const have = asset === "USDT" ? bal.usdt : where === "spot" ? bal.spot : withdrawable();
      if (amount > have) {
        const native = { status: "err", response: "Insufficient balance for withdrawal" };
        const intoMargin = where === "perps" && asset === "USDC" && amount <= bal.perps;
        return intoMargin ? no("E_VENUE_INSUFFICIENT", { venue: "hyperliquid", message: `Hyperliquid: $${amount} would dip into the $${seed.marginUsed} margin behind open positions; $${have} is withdrawable`, native }) : no("E_VENUE_INSUFFICIENT", { venue: "hyperliquid", native });
      }
      if (asset === "USDT") bal.usdt = r2(bal.usdt - amount);
      else if (where === "spot") bal.spot = r2(bal.spot - amount);
      else bal.perps = r2(bal.perps - amount);
      line("out", asset, amount, { type: "withdraw", usdc: amount.toFixed(2) });
      return { ok: true as const, ref: lines[lines.length - 1]!.id };
    },
    /** perps ⇄ spot: collateral moving between the account's own balances */
    shift(asset, amount, from, to): VenueResult {
      if (asset !== "USDC" || !["perps", "spot"].includes(from) || !["perps", "spot"].includes(to) || from === to) return no("E_VENUE_REJECTED", { venue: "hyperliquid", native: { status: "err", response: "Invalid transfer" } });
      const have = from === "perps" ? withdrawable() : bal.spot;
      if (amount > have) return no("E_VENUE_INSUFFICIENT", { venue: "hyperliquid", native: { status: "err", response: "Insufficient balance for transfer" } });
      bal[from as "perps" | "spot"] = r2(bal[from as "perps" | "spot"] - amount);
      bal[to as "perps" | "spot"] = r2(bal[to as "perps" | "spot"] + amount);
      return { ok: true as const, ref: `hl-shift-${++seq}` };
    },
    /** USDC ⇄ USDT on the spot book, as an IOC order */
    convert(sell, buy, amount): VenueResult {
      const pair = [sell, buy].sort().join("/");
      if (pair !== "USDC/USDT") return no("E_VENUE_CURRENCY", { venue: "hyperliquid", message: `Hyperliquid swaps USDC and USDT here, not ${sell} for ${buy}`, native: { status: "err", response: "Unknown spot pair" } });
      if (amount < HL_MIN_SWAP) return no("E_VENUE_MIN_DEPOSIT", { venue: "hyperliquid", message: `Hyperliquid: a stablecoin swap is at least ${HL_MIN_SWAP}`, native: { status: "err", response: "Order must have minimum value of $10" } });
      const have = sell === "USDT" ? bal.usdt : bal.spot;
      if (amount > have) return no("E_VENUE_INSUFFICIENT", { venue: "hyperliquid", message: `Hyperliquid: ${amount} ${sell} is more than the spot balance holds (${have}); move it from perps first`, native: { status: "err", response: "Insufficient spot balance" } });
      const feeUsd = r2(amount * SWAP_FEE);
      const received = r2(amount - feeUsd);
      if (sell === "USDT") {
        bal.usdt = r2(bal.usdt - amount);
        bal.spot = r2(bal.spot + received);
      } else {
        bal.spot = r2(bal.spot - amount);
        bal.usdt = r2(bal.usdt + received);
      }
      return { ok: true as const, ref: `hl-swap-${++seq}`, received, feeUsd, native: { status: "ok", response: { type: "order", data: { statuses: [{ filled: { totalSz: String(amount), avgPx: "1.0" } }] } } } };
    },
    statement: () => [...lines],
  };
}
