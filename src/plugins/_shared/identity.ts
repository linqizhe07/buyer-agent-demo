/** The identity record a seat process resolves from its credential REFERENCE.
 *
 * Only plugin children import this module. The host (src/agent, src/runner)
 * never does — a unit test greps for it — so the agent process never holds a
 * credential value, only the reference string it put into the child's
 * environment.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface CredentialRecord {
  kind: "broker-api-key" | "hmac-api-key" | "agent-wallet";
  [key: string]: unknown;
}

export function credentialPath(home: string, ref: string): string {
  const [venue, name] = ref.split("/");
  if (!venue || !name || ref.split("/").length !== 2) throw new Error(`malformed credential ref "${ref}"`);
  return join(home, "credentials", venue, `${name}.json`);
}

/** Resolve `ref` for `venue`. A ref whose prefix is another venue is refused:
 * a seat can only ever read the identity issued for its own market. */
export function loadCredential<T extends CredentialRecord>(ref: string, venue: string, home: string): T {
  const prefix = ref.split("/")[0];
  if (prefix !== venue) throw new Error(`credential ref ${ref} does not belong to venue ${venue}`);
  const file = credentialPath(home, ref);
  const st = statSync(file);
  if ((st.mode & 0o077) !== 0) {
    process.stderr.write(`[identity] warning: ${file} is readable by others (expected mode 0600)\n`);
  }
  return JSON.parse(readFileSync(file, "utf8")) as T;
}
