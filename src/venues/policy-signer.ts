/** The policy signer: a separate process-shaped service that holds the
 * Solana keypair and signs only what its policy admits. The agent's seat
 * sends it INTENTS; it answers with a signed transaction or a refusal. The
 * shape mirrors what Coinbase CDP / Turnkey / Privy policies check (program,
 * token, recipient, per-tx cap, daily cap, session expiry), so it can be
 * swapped for one of them later.
 */
import express from "express";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import type { SimClock } from "../core/clock.ts";
import { chainAddressOf, keyFromSeed, sign } from "../core/ed25519.ts";
import { canonical } from "../core/hash.ts";
import { appendJsonl } from "../core/jsonl.ts";
import type { VenueHandle } from "./alpaca.ts";

export interface SignerPolicy {
  programs: string[];
  tokens: string[];
  recipients: string[];
  perTxCapLamports: number;
  dailyCapLamports: number;
  sessionExpiresAt: string;
}

export type SignerReason = "session_expired" | "program_not_allowlisted" | "token_not_allowlisted" | "recipient_not_allowlisted" | "per_tx_cap" | "daily_cap";

export interface SignIntent {
  to: string;
  lamports: number;
  program?: string;
  token?: string;
  memo?: string;
}

export interface SignerJournalRow {
  at: string;
  intent: SignIntent;
  outcome: "signed" | "refused";
  reason?: SignerReason;
  signature?: string;
}

export interface SignerHandle extends VenueHandle {
  address: string;
  policy(): SignerPolicy;
  statement(): SignerJournalRow[];
}

export interface SignerOptions {
  port: number;
  home: string;
  clock: SimClock;
  onEvent?: (type: string, data: unknown) => void;
}

export function evaluatePolicy(policy: SignerPolicy, intent: SignIntent, nowMs: number, signedTodayLamports: number): { reason: SignerReason; detail: Record<string, unknown> } | null {
  if (nowMs >= Date.parse(policy.sessionExpiresAt)) return { reason: "session_expired", detail: { sessionExpiresAt: policy.sessionExpiresAt } };
  const program = intent.program ?? "system";
  if (!policy.programs.includes(program)) return { reason: "program_not_allowlisted", detail: { program, allowed: policy.programs } };
  const token = intent.token ?? "SOL";
  if (!policy.tokens.includes(token)) return { reason: "token_not_allowlisted", detail: { token, allowed: policy.tokens } };
  if (!policy.recipients.includes(intent.to)) return { reason: "recipient_not_allowlisted", detail: { to: intent.to, allowed: policy.recipients } };
  if (intent.lamports > policy.perTxCapLamports) return { reason: "per_tx_cap", detail: { lamports: intent.lamports, perTxCapLamports: policy.perTxCapLamports } };
  if (signedTodayLamports + intent.lamports > policy.dailyCapLamports) {
    return { reason: "daily_cap", detail: { lamports: intent.lamports, signedTodayLamports, dailyCapLamports: policy.dailyCapLamports } };
  }
  return null;
}

export async function startPolicySigner(opts: SignerOptions): Promise<SignerHandle> {
  const keypair = JSON.parse(readFileSync(join(opts.home, "signer", "keypair.json"), "utf8")) as { seed: string };
  const policy = JSON.parse(readFileSync(join(opts.home, "signer", "policy.json"), "utf8")) as SignerPolicy;
  const kp = keyFromSeed(keypair.seed);
  const address = chainAddressOf(kp.publicKeyHex);
  const journalFile = join(opts.home, "signer", "journal.jsonl");
  const journal: SignerJournalRow[] = [];
  const emit = (type: string, data: unknown) => opts.onEvent?.(type, data);

  const app = express();
  app.use(express.json());
  app.get("/policy", (_req, res) => res.json({ address, ...policy }));
  app.post("/sign", (req, res) => {
    const { intent, recentBlockhash } = req.body as { intent: SignIntent; recentBlockhash?: string };
    const now = opts.clock.now();
    const dayStart = now - 24 * 3600_000;
    const signedToday = journal
      .filter((r) => r.outcome === "signed" && Date.parse(r.at) >= dayStart)
      .reduce((s, r) => s + r.intent.lamports, 0);
    const verdict = evaluatePolicy(policy, intent, now, signedToday);
    if (verdict) {
      const row: SignerJournalRow = { at: opts.clock.iso(), intent, outcome: "refused", reason: verdict.reason };
      journal.push(row);
      appendJsonl(journalFile, row);
      emit("sim/signer-refused", { venue: "solana", reason: verdict.reason, detail: verdict.detail, intent });
      res.json({ refused: true, reason: verdict.reason, detail: verdict.detail });
      return;
    }
    const message = {
      from: address,
      to: intent.to,
      lamports: intent.lamports,
      program: intent.program ?? "system",
      memo: intent.memo ?? null,
      recentBlockhash: recentBlockhash ?? null,
    };
    const sig = sign(kp.privateKey, canonical(message));
    const signedTx = Buffer.from(JSON.stringify({ message, signature: { pubkey: kp.publicKeyHex, sig } })).toString("base64");
    const row: SignerJournalRow = { at: opts.clock.iso(), intent, outcome: "signed", signature: sig.slice(0, 88) };
    journal.push(row);
    appendJsonl(journalFile, row);
    emit("sim/signer-signed", { venue: "solana", intent, signature: row.signature });
    res.json({ signedTx, signature: row.signature, from: address });
  });

  const server: Server = await new Promise((resolve, reject) => {
    const s = app.listen(opts.port, "127.0.0.1", () => resolve(s));
    s.on("error", reject);
  });

  return {
    name: "signer",
    url: `http://127.0.0.1:${opts.port}`,
    port: opts.port,
    address,
    policy: () => ({ ...policy }),
    statement: () => [...journal],
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
