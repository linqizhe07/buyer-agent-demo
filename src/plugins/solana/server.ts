/** The Solana seat: holds NO key. It turns an intent into a request to the
 * policy signer, and a signed transaction into an RPC call to the chain.
 * If the signer refuses, the refusal comes back structured as `signerRefusal`
 * and the host names it `E_SIGNER_*`. */
import { z } from "zod";
import { http } from "../_shared/http.ts";
import { fail, log, ok, pluginEnv, serve } from "../_shared/server.ts";

const env = pluginEnv();
if (!env.signerUrl) throw new Error("the solana seat needs a policy signer (BUYER_SIGNER_URL)");
if (env.credRef) throw new Error("the solana seat must not receive a credential ref: the signer holds the key");
const rpcUrl = `${env.venueUrl.replace(/\/$/, "")}/rpc`;
const signerUrl = env.signerUrl.replace(/\/$/, "");
let rpcId = 0;

async function rpc(method: string, params: unknown[] = []) {
  const r = await http(rpcUrl, { method: "POST", body: { jsonrpc: "2.0", id: ++rpcId, method, params } });
  const body = r.body as { result?: unknown; error?: { code: number; message: string } };
  if (body.error) return { ok: false as const, error: body.error };
  return { ok: true as const, result: body.result };
}

const policy = (await http(`${signerUrl}/policy`)).body as { address: string; perTxCapLamports: number; recipients: string[] };
log(`no credential · signer at ${signerUrl} for ${policy.address.slice(0, 8)}… · per-tx cap ${policy.perTxCapLamports} lamports`);

await serve({ name: "solana-seat", version: "0.1.0" }, (server) => {
  server.registerTool(
    "getBalance",
    { description: "Lamport balance of the signer's account.", inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => {
      const r = await rpc("getBalance", [policy.address]);
      if (!r.ok) return fail({ venueError: r.error });
      return ok({ address: policy.address, lamports: (r.result as { value: number }).value, sol: (r.result as { value: number }).value / 1e9 });
    },
  );
  server.registerTool(
    "getRecentTransactions",
    { description: "Recent transactions of the signer's account.", inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => {
      const r = await rpc("getSignaturesForAddress", [policy.address]);
      return r.ok ? ok(r.result) : fail({ venueError: r.error });
    },
  );
  server.registerTool(
    "transfer",
    {
      description: "Transfer SOL (lamports) to an address: the intent goes to the policy signer, the signed tx to the chain.",
      inputSchema: { to: z.string(), lamports: z.number().int().positive(), memo: z.string().optional() },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ to, lamports, memo }) => {
      const bh = await rpc("getLatestBlockhash");
      if (!bh.ok) return fail({ venueError: bh.error });
      const recentBlockhash = (bh.result as { value: { blockhash: string } }).value.blockhash;
      const s = await http(`${signerUrl}/sign`, { method: "POST", body: { intent: { to, lamports, program: "system", token: "SOL", memo }, recentBlockhash } });
      const signed = s.body as { refused?: boolean; reason?: string; detail?: unknown; signedTx?: string; signature?: string; from?: string };
      if (s.status >= 400 || signed.refused) return fail({ signerRefusal: { reason: signed.reason ?? "unavailable", detail: signed.detail ?? null } });
      const sent = await rpc("sendTransaction", [signed.signedTx]);
      if (!sent.ok) return fail({ venueError: sent.error });
      return ok({ status: "confirmed", signature: sent.result, from: signed.from, to, lamports, memo: memo ?? null });
    },
  );
});
