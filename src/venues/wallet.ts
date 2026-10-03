/** The main wallet: the user's, non-custodial, outside the agent.
 *
 * It holds stablecoins and a FLOAT policy per venue (how much may sit at a
 * venue, net of what came back). The agent never touches it; it can only ask
 * the host to fund a venue, and that request goes through the mandate and a
 * card first. On a funded request the wallet pays the venue's deposit rail
 * (a CEX deposit address, a DEX bridge) and records the transfer; when the
 * operator withdraws from a venue, the venue's whitelist points back here.
 */
import express from "express";
import { readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import type { SimClock } from "../core/clock.ts";
import { evmAddressOf, keyFromSeed } from "../core/ed25519.ts";
import type { VenueHandle } from "./alpaca.ts";

export interface WalletVenueRail {
  url: string;
  asset: string;
  /** CEX: the deposit address; DEX: the master account the bridge credits */
  destination: string;
  rail: "cex-deposit" | "dex-bridge";
}

export interface WalletTransfer {
  id: string;
  direction: "out" | "in";
  venue: string;
  asset: string;
  amount: number;
  at: string;
  ref: string;
  purpose?: string | undefined;
}

export interface WalletStatement {
  address: string;
  balances: Record<string, number>;
  floats: Record<string, { cap: number; out: number; in: number; net: number }>;
  transfers: WalletTransfer[];
}

export interface WalletHandle extends VenueHandle {
  address: string;
  statement(): WalletStatement;
}

export interface WalletOptions {
  port: number;
  home: string;
  clock: SimClock;
  rails: Record<string, WalletVenueRail>;
  onEvent?: (type: string, data: unknown) => void;
}

export async function startWallet(opts: WalletOptions): Promise<WalletHandle> {
  const cred = JSON.parse(readFileSync(join(opts.home, "credentials", "wallet", "main.json"), "utf8")) as { seed: string };
  const address = evmAddressOf(keyFromSeed(cred.seed).publicKeyHex);
  const policy = JSON.parse(readFileSync(join(opts.home, "wallet", "policy.json"), "utf8")) as { floats: Record<string, number> };
  const balancesFile = join(opts.home, "wallet", "balances.json");
  const balances = JSON.parse(readFileSync(balancesFile, "utf8")) as Record<string, number>;
  const transfers: WalletTransfer[] = [];
  let seq = 0;
  const emit = (type: string, data: unknown) => opts.onEvent?.(type, data);
  const persist = () => writeFileSync(balancesFile, JSON.stringify(balances, null, 2) + "\n");
  const floats = (): WalletStatement["floats"] => {
    const out: WalletStatement["floats"] = {};
    for (const [venue, cap] of Object.entries(policy.floats)) {
      const o = transfers.filter((t) => t.venue === venue && t.direction === "out").reduce((s, t) => s + t.amount, 0);
      const i = transfers.filter((t) => t.venue === venue && t.direction === "in").reduce((s, t) => s + t.amount, 0);
      out[venue] = { cap, out: o, in: i, net: Number((o - i).toFixed(2)) };
    }
    return out;
  };
  const snapshot = () => ({ address, balances: { ...balances }, floats: floats() });

  const app = express();
  app.use(express.json());
  app.get("/balance", (_req, res) => res.json(snapshot()));
  app.get("/transfers", (_req, res) => res.json(transfers));

  app.post("/fund", async (req, res) => {
    const { venue, amountUsd, purpose, ref } = req.body as { venue: string; amountUsd: number; purpose?: string; ref?: string };
    const rail = opts.rails[venue];
    const cap = policy.floats[venue];
    const refuse = (status: number, message: string, extra: Record<string, unknown> = {}) => {
      emit("wallet/refused", { venue, amountUsd, message, ...extra, ...snapshot() });
      res.status(status).json({ message, ...extra });
    };
    if (!rail || cap === undefined) return refuse(404, `wallet does not know venue ${venue}`);
    const amount = Number(amountUsd);
    if (!(amount > 0)) return refuse(400, "amount must be > 0");
    const net = floats()[venue]?.net ?? 0;
    if (net + amount > cap) return refuse(409, `float cap for ${venue} exceeded: net ${net} + ${amount} > ${cap}`, { net, cap, amount });
    if ((balances[rail.asset] ?? 0) < amount) return refuse(409, `insufficient ${rail.asset} in the wallet`, { asset: rail.asset, balance: balances[rail.asset] ?? 0 });
    const id = `fund-${String(++seq).padStart(4, "0")}`;
    const body = rail.rail === "cex-deposit" ? { address: rail.destination, coin: rail.asset, amount, txId: id } : { to: rail.destination, amount, txId: id };
    const path = rail.rail === "cex-deposit" ? "/__sim/deposit" : "/bridge/deposit";
    const r = await fetch(`${rail.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) return refuse(502, `venue did not credit the deposit (${r.status})`);
    balances[rail.asset] = Number(((balances[rail.asset] ?? 0) - amount).toFixed(2));
    persist();
    const row: WalletTransfer = { id, direction: "out", venue, asset: rail.asset, amount, at: opts.clock.iso(), ref: ref ?? id, purpose };
    transfers.push(row);
    emit("wallet/funded", { ...row, ...snapshot() });
    res.json({ status: "funded", id, venue, asset: rail.asset, amount, rail: rail.rail, destination: rail.destination });
  });

  app.post("/receive", (req, res) => {
    const { venue, asset, amount, ref } = req.body as { venue: string; asset: string; amount: number; ref: string };
    const a = Number(amount);
    if (!(a > 0)) {
      res.status(400).json({ message: "amount must be > 0" });
      return;
    }
    balances[asset] = Number(((balances[asset] ?? 0) + a).toFixed(2));
    persist();
    const row: WalletTransfer = { id: `recv-${String(++seq).padStart(4, "0")}`, direction: "in", venue, asset, amount: a, at: opts.clock.iso(), ref };
    transfers.push(row);
    emit("wallet/received", { ...row, ...snapshot() });
    res.json({ status: "received", id: row.id });
  });

  const server: Server = await new Promise((resolve, reject) => {
    const s = app.listen(opts.port, "127.0.0.1", () => resolve(s));
    s.on("error", reject);
  });
  return {
    name: "wallet",
    url: `http://127.0.0.1:${opts.port}`,
    port: opts.port,
    address,
    statement: () => ({ ...snapshot(), transfers: [...transfers] }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
