/** What a plugin child process is allowed to inherit.
 *
 * The identity is a REFERENCE (`BUYER_CRED_REF=alpaca/paper`), never a value:
 * the child resolves it from `$BUYER_HOME/credentials/<ref>.json` itself. The
 * host's own environment is scrubbed the way dsh scrubs a subprocess — every
 * variable whose NAME matches /KEY|SECRET|TOKEN|PASSWORD/i is dropped — and
 * the result is asserted clean, so a stray `APCA_API_SECRET_KEY` in the
 * presenter's shell can never reach a seat it does not belong to.
 */
import type { Manifest } from "./manifest.ts";

export const SECRET_NAME = /KEY|SECRET|TOKEN|PASSWORD/i;

export function scrubEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (SECRET_NAME.test(name)) continue;
    out[name] = value;
  }
  return out;
}

export interface ChildEnvInputs {
  /** the base the SDK would give a child (HOME, PATH, ...) */
  base: Record<string, string | undefined>;
  home: string;
  venueUrl: string;
  signerUrl?: string | undefined;
}

/** The exact environment a seat process starts with. */
export function childEnvFor(manifest: Manifest, inputs: ChildEnvInputs): Record<string, string> {
  const env = scrubEnv({
    ...inputs.base,
    BUYER_HOME: inputs.home,
    BUYER_VENUE: manifest.venue,
    BUYER_VENUE_URL: inputs.venueUrl,
  });
  if (manifest.identity) env.BUYER_CRED_REF = manifest.identity.ref;
  if (manifest.signer.kind === "external-policy-signer") {
    env.BUYER_SIGNER_URL = inputs.signerUrl ?? manifest.signer.url;
  }
  assertClean(env);
  return env;
}

/** Throws if a secret-looking name survived, or more than one ref is present. */
export function assertClean(env: Record<string, string>): void {
  const leaked = Object.keys(env).filter((n) => SECRET_NAME.test(n));
  if (leaked.length) throw new Error(`child env is not clean: ${leaked.join(", ")}`);
  const refs = Object.keys(env).filter((n) => n === "BUYER_CRED_REF");
  if (refs.length > 1) throw new Error("child env carries more than one credential ref");
}
