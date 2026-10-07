/** Where the account keeps what outlives a run: ledgers, key files, seat keys, agent wallets. One place, shared by the server, the MCP seat
 * and the command lines, so that all of them find the same things. `BUYER_HOME` moves it; `--home` moves it for one server. */
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export const defaultHome = (): string => process.env.BUYER_HOME ?? join(homedir(), ".buyer-agent-demo");

/** a terminal demo's home: a fresh folder of its own under the system's temp dir, every time. Never the account's home — and never
 * `BUYER_HOME` either, which names that home: a demo starts its ledger over, and a fresh-start ledger in the account's own home would end
 * the chain the running account restores from, and land on its statement beside the real venues' lines. `--home` is the one way to put a
 * demo somewhere else, and each demo reads that flag itself before asking here */
export const demoHome = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));
