/** The MetaMask Agent Wallet, read through MetaMask's own `mm` command line on this machine.
 *
 *   mm wallet show       the wallet's address and its Guard policy (what MetaMask itself lets the wallet do without asking)
 *   mm wallet balance    what it holds, per chain, with MetaMask's own dollar values
 *
 * The CLI holds the session; this process holds nothing. It is the wallet the account was built around, so it is also the one other
 * connections send to. Reading needs the CLI to be signed in (`mm wallet show` working in a terminal).
 */
import type { Refusal } from "../../core/errors.ts";
import { holdingsOf, mm, type MmBalance, type MmShow } from "../adapters/metamask.ts";
import { no } from "../refuse.ts";
import { redact, type LiveBalance, type LiveSource } from "./types.ts";
import { mmWriter } from "./writes.ts";

export type RunMm = <T>(args: string[]) => Promise<T>;

export const realMm = (bin = process.env.PORTFOLIO_MM_BIN ?? "mm", timeoutMs = 45_000): RunMm => (args) => mm(bin, args, timeoutMs);

export async function metamaskSource(req: { venue: string; label: string; run: RunMm }): Promise<{ source: LiveSource; first: LiveBalance[] } | Refusal> {
  const name = req.label || "MetaMask Agent Wallet";
  let show: MmShow;
  try {
    show = await req.run<MmShow>(["wallet", "show"]);
  } catch (err) {
    const said = redact(String((err as Error)?.message ?? err).slice(0, 200), []);
    return no("E_ACCOUNT_CREDENTIAL", { venue: req.venue, message: /ENOENT|not found/i.test(said) ? "the mm command line is not installed on this machine" : "mm could not show the wallet: sign in with the mm command line first (mm wallet show must work in a terminal)", native: { said } });
  }
  const yaml = show.policyYaml ?? "";
  const rolling = /rolling_24h:\s*([\d.]+)/.exec(yaml)?.[1];
  const read = async (): Promise<LiveBalance[]> => {
    let b: MmBalance;
    try {
      b = await req.run<MmBalance>(["wallet", "balance"]);
    } catch (err) {
      throw no("E_VENUE_UNREACHABLE", { venue: req.venue, message: "mm could not read the balance", native: { said: String((err as Error)?.message ?? err).slice(0, 200) } });
    }
    return holdingsOf(b).map((h) => ({ asset: h.asset, amount: h.amount, usd: h.usd, ...(h.note ? { where: h.note } : {}) }));
  };
  try {
    const first = await read();
    const source: LiveSource = { name, kind: "agent-wallet", reference: "the mm command line's session on this machine", via: "MetaMask · mm command line", address: show.address, probe: { can: ["read", "transfer", "swap"], note: `MetaMask's Guard decides what goes out without asking (${rolling !== undefined ? `$${rolling} a rolling day` : "its policy"}); above that it asks you by email`, native: { address: show.address, tradingMode: show.tradingMode, rolling24h: rolling ?? null } }, read, writer: mmWriter(show.address as `0x${string}`, req.run) };
    return { source, first };
  } catch (err) {
    return err as Refusal;
  }
}
