/** The Solana chain simulator: a chain, not a venue. A keypair IS the
 * account: whoever holds it holds everything. That is why the Solana seat
 * never holds one — the policy signer does (`policy-signer.ts`).
 *
 * Shape: JSON-RPC at `POST /rpc` with `getBalance`, `getLatestBlockhash`,
 * `sendTransaction`, `getSignaturesForAddress`, `getTransaction`. A
 * "transaction" is base64 JSON `{message, signature}`; the sim verifies the
 * ed25519 signature and that the signer owns `message.from`.
 */
import express from "express";
import type { Server } from "node:http";
import type { SimClock } from "../core/clock.ts";
import { chainAddressOf, verify } from "../core/ed25519.ts";
import { canonical } from "../core/hash.ts";
import type { VenueHandle } from "./alpaca.ts";

export interface ChainAccountSeed {
  address: string;
  lamports: number;
  label: string;
}

export interface ChainTx {
  signature: string;
  slot: number;
  blockTime: number;
  from: string;
  to: string;
  lamports: number;
  program: string;
  memo: string | null;
  status: "confirmed";
}

export interface ChainStatement {
  accounts: Array<{ address: string; lamports: number; label: string }>;
  transactions: ChainTx[];
}

export interface ChainSimHandle extends VenueHandle {
  statement(): ChainStatement;
  balance(address: string): number;
}

export interface ChainSimOptions {
  port: number;
  clock: SimClock;
  accounts: ChainAccountSeed[];
  onEvent?: (type: string, data: unknown) => void;
}

export const LAMPORTS_PER_SOL = 1_000_000_000;

export async function startSolanaChain(opts: ChainSimOptions): Promise<ChainSimHandle> {
  const accounts = new Map<string, { lamports: number; label: string }>();
  for (const a of opts.accounts) accounts.set(a.address, { lamports: a.lamports, label: a.label });
  const txs: ChainTx[] = [];
  let slot = 250_000_000;
  const emit = (type: string, data: unknown) => opts.onEvent?.(type, data);

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use((_req, res, next) => {
    res.setHeader("x-demo-venue", "solana-sim");
    next();
  });

  app.post("/rpc", (req, res) => {
    const { id, method, params } = req.body as { id: unknown; method: string; params?: unknown[] };
    const ok = (result: unknown) => res.json({ jsonrpc: "2.0", id, result });
    const err = (code: number, message: string) => {
      emit("sim/refused", { venue: "solana", code, message, method });
      res.json({ jsonrpc: "2.0", id, error: { code, message } });
    };
    const p = params ?? [];
    slot += 1;
    switch (method) {
      case "getBalance": {
        const address = String(p[0] ?? "");
        return ok({ context: { slot }, value: accounts.get(address)?.lamports ?? 0 });
      }
      case "getLatestBlockhash":
        return ok({ context: { slot }, value: { blockhash: `demo-${slot}`, lastValidBlockHeight: slot + 150 } });
      case "sendTransaction": {
        let tx: { message: Record<string, unknown>; signature: { pubkey: string; sig: string } };
        try {
          tx = JSON.parse(Buffer.from(String(p[0] ?? ""), "base64").toString("utf8"));
        } catch {
          return err(-32602, "invalid transaction encoding");
        }
        const m = tx.message;
        if (!verify(tx.signature.pubkey, canonical(m), tx.signature.sig)) return err(-32003, "Transaction signature verification failure");
        const signer = chainAddressOf(tx.signature.pubkey);
        if (signer !== String(m.from)) return err(-32003, "Transaction signature verification failure: signer is not the account owner");
        if (String(m.program) !== "system") return err(-32002, `Transaction simulation failed: program ${String(m.program)} not deployed`);
        const from = accounts.get(String(m.from));
        const lamports = Number(m.lamports);
        if (!from || !(lamports > 0) || from.lamports < lamports) return err(-32002, "Transaction simulation failed: insufficient lamports");
        const to = String(m.to);
        from.lamports -= lamports;
        const dest = accounts.get(to) ?? { lamports: 0, label: "unknown" };
        dest.lamports += lamports;
        accounts.set(to, dest);
        const row: ChainTx = {
          signature: tx.signature.sig.slice(0, 88),
          slot,
          blockTime: Math.floor(opts.clock.now() / 1000),
          from: String(m.from),
          to,
          lamports,
          program: "system",
          memo: typeof m.memo === "string" ? m.memo : null,
          status: "confirmed",
        };
        txs.push(row);
        emit("sim/confirmed", { venue: "solana", signature: row.signature, from: row.from, to, lamports });
        return ok(row.signature);
      }
      case "getSignaturesForAddress": {
        const address = String(p[0] ?? "");
        return ok(txs.filter((t) => t.from === address || t.to === address).map((t) => ({ signature: t.signature, slot: t.slot, blockTime: t.blockTime, err: null })));
      }
      case "getTransaction": {
        const sig = String(p[0] ?? "");
        return ok(txs.find((t) => t.signature === sig) ?? null);
      }
      default:
        return err(-32601, `Method not found: ${method}`);
    }
  });

  app.get("/history", (req, res) => {
    const address = String(req.query.address ?? "");
    res.json(txs.filter((t) => !address || t.from === address || t.to === address));
  });

  const server: Server = await new Promise((resolve, reject) => {
    const s = app.listen(opts.port, "127.0.0.1", () => resolve(s));
    s.on("error", reject);
  });

  return {
    name: "solana",
    url: `http://127.0.0.1:${opts.port}`,
    port: opts.port,
    balance: (address) => accounts.get(address)?.lamports ?? 0,
    statement: () => ({
      accounts: [...accounts.entries()].map(([address, a]) => ({ address, lamports: a.lamports, label: a.label })),
      transactions: [...txs],
    }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
