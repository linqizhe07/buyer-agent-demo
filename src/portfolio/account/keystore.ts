/** Keys this machine makes for itself and keeps: an agent seat's key, and the key of an agent wallet the account pays from.
 *
 * Each is a file of its own in the account's home, readable by the user alone (mode 0600, in a 0700 directory), made the first time it is
 * asked for and the same key ever after. Nothing about it is derived from a name: a key derived from a label is a key anyone who knows the
 * label holds, which is what the simulation's keys are (sign.ts `simKey`) and what a real seat must not be.
 *
 *   <home>/seats/<name>.json            an agent seat: signs its requests to the account (secp256k1) and AP2 mandates (P-256)
 *   <home>/agent-wallets/<name>.json    an agent wallet: the account signs payments with it; the agent never sees it
 *
 * The file holds the private halves. It is never logged, never sent, and never shown on a page: what leaves this file is an address.
 */
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { isRefusal, type Refusal } from "../../core/errors.ts";
import { no } from "../refuse.ts";
import { kidOf, type Hex, type Jwk, type SimKey } from "./sign.ts";

/** what the file holds */
interface KeyFile {
  v: 1;
  kind: "seat" | "agent-wallet";
  name: string;
  /** secp256k1, 0x and 64 hex digits */
  secp256k1: Hex;
  /** P-256, as a private JWK */
  p256: Jwk & { d: string };
  createdAt: string;
}

export const slugOf = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "seat";

export const seatKeyPath = (home: string, name: string): string => join(home, "seats", `${slugOf(name)}.json`);
export const agentWalletKeyPath = (home: string, name: string): string => join(home, "agent-wallets", `${slugOf(name)}.json`);

function fromFile(f: KeyFile, label: string): SimKey {
  const account = privateKeyToAccount(f.secp256k1);
  const jwk: Jwk = { kty: "EC", crv: "P-256", x: f.p256.x, y: f.p256.y };
  return { label, account, address: account.address.toLowerCase() as Hex, p256: createPrivateKey({ key: { ...f.p256 }, format: "jwk" }), jwk, kid: kidOf(jwk) };
}

function parse(text: string): KeyFile | undefined {
  try {
    const f = JSON.parse(text) as Partial<KeyFile>;
    const p = f.p256 as Partial<KeyFile["p256"]> | undefined;
    if (f.v !== 1 || typeof f.secp256k1 !== "string" || !/^0x[0-9a-f]{64}$/i.test(f.secp256k1) || !p || p.kty !== "EC" || p.crv !== "P-256" || !p.x || !p.y || !p.d) return undefined;
    return f as KeyFile;
  } catch {
    return undefined;
  }
}

/** The key in `path`, or a new one written there if there is none yet. A file another user can read, or one that does not parse, is a refusal:
 * the account does not sign with a key it cannot vouch for, and it does not quietly replace one either. */
export function loadOrCreateKey(path: string, kind: KeyFile["kind"], name: string): SimKey | Refusal {
  const label = `${kind}:${slugOf(name)}`;
  // a refusal names the key, never the file's path: the path says where the account's home is, and a refusal travels to pages and seats.
  // Whoever needs the path reads it in `detail`
  const whose = `the key file of the ${kind === "seat" ? "agent seat" : "agent wallet"} "${name}"`;
  if (existsSync(path)) {
    const mode = statSync(path).mode & 0o777;
    if (mode & 0o077) return no("E_ACCOUNT_CREDENTIAL", { message: `${whose} can be read by other users of this machine (mode ${mode.toString(8)}): make it the user's alone (chmod 600) before it is used`, detail: { path, mode: mode.toString(8) } });
    const f = parse(readFileSync(path, "utf8"));
    if (!f) return no("E_ACCOUNT_CREDENTIAL", { message: `${whose} is not a key file this account wrote: move it aside, and a new key is made`, detail: { path } });
    return fromFile(f, label);
  }
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const d = privateKey.export({ format: "jwk" }) as { kty: "EC"; crv: "P-256"; x: string; y: string; d: string };
  const f: KeyFile = { v: 1, kind, name, secp256k1: generatePrivateKey(), p256: { kty: "EC", crv: "P-256", x: d.x, y: d.y, d: d.d }, createdAt: new Date().toISOString() };
  try {
    // `wx`: if another process made it a moment ago, its key is the key — this one is not written over it
    writeFileSync(path, `${JSON.stringify(f, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return loadOrCreateKey(path, kind, name);
    throw err;
  }
  return fromFile(f, label);
}

/** an agent seat's own key: made on first use, kept in the home */
export function seatKey(home: string, name: string): SimKey | Refusal {
  return loadOrCreateKey(seatKeyPath(home, name), "seat", name);
}

/** the key of an agent wallet the account pays from */
export function agentWalletKey(home: string, name: string): SimKey | Refusal {
  return loadOrCreateKey(agentWalletKeyPath(home, name), "agent-wallet", name);
}

/** whether a key exists, without making one */
export const hasKey = (path: string): boolean => existsSync(path);

/** the key, or a thrown error with the refusal's words: for a command line that has nothing better to do with a refusal than to say it */
export function mustKey(k: SimKey | Refusal): SimKey {
  if (isRefusal(k)) throw new Error(k.message);
  return k;
}
