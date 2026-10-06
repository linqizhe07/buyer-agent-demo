/** Where the account keeps what outlives a run: ledgers, key files, seat keys, agent wallets. One place, shared by the server, the MCP seat
 * and the command lines, so that all of them find the same things. `BUYER_HOME` moves it; `--home` moves it for one server. */
import { homedir } from "node:os";
import { join } from "node:path";

export const defaultHome = (): string => process.env.BUYER_HOME ?? join(homedir(), ".buyer-agent-demo");
