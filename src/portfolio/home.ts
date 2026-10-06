/** Where the account keeps what outlives a run: ledgers, key files, seat keys, agent wallets. One place, shared by the server, the MCP seat
 * and the command lines, so that all of them find the same things. `BUYER_HOME` moves it; `--home` moves it for one server. */
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export const defaultHome = (): string => process.env.BUYER_HOME ?? join(homedir(), ".buyer-agent-demo");

/** a terminal demo's home: `--home` or `BUYER_HOME` when given, else a fresh folder of its own. Never the default home: a demo starts its
 * ledger over, and a fresh-start ledger in the account's own home would end the chain that the running account restores from */
export const demoHome = (prefix: string): string => process.env.BUYER_HOME ?? mkdtempSync(join(tmpdir(), prefix));
