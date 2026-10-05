/** The key file of a live connection: a small JSON file in the HOME directory that the user writes and this process reads.
 *
 *   <home>/credentials/binance/api-key.json      {"apiKey": "…", "secret": "…"}
 *
 * The page hands over WHERE the file is, never what is in it; the ledger records the path. Three things are checked before a byte of it is
 * used: the path stays inside the home directory, the file is readable by its owner only, and it holds the fields this venue needs. The
 * values go to the venue's client and nowhere else — not into a refusal, a log line or a view.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Refusal } from "../../core/errors.ts";
import { no } from "../refuse.ts";

export interface KeyShape {
  required: string[];
  optional?: string[];
  /** one line the page shows: what to put in the file */
  example: string;
}

export type KeyFile = Record<string, string>;

/** where a venue's key file goes when the owner does not say */
export const defaultKeyRef = (venue: string): string => `credentials/${venue}/api-key.json`;

const inside = (home: string, path: string): boolean => {
  const rel = relative(home, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

/** May this file be read as a secret? It has to be inside the home directory (a link that leads out of it is outside it), a plain file,
 * and readable by its owner only. Answers the file's text, or the refusal. `how`: what to tell the owner when it is not there. */
export function readSecretFile(home: string, where: string, venue: string, how: string): { text: string; shown: string } | Refusal {
  const path = isAbsolute(where) ? resolve(where) : resolve(join(home, where));
  const shown = inside(resolve(home), path) ? `${relative(resolve(home), path).split(sep).join("/")}` : where;
  if (!inside(resolve(home), path)) return no("E_ACCOUNT_CREDENTIAL", { venue, message: `a key file lives inside the home directory (${home}); "${where}" is outside it`, detail: { home } });
  if (!existsSync(path)) return no("E_ACCOUNT_CREDENTIAL", { venue, message: `there is no key file at ${shown}. ${how}`, detail: { expected: join(home, shown) } });
  const real = realpathSync(path);
  if (!inside(realpathSync(resolve(home)), real)) return no("E_ACCOUNT_CREDENTIAL", { venue, message: `${shown} is a link to a file outside the home directory: not read`, detail: { home } });
  const stat = statSync(real);
  if (!stat.isFile()) return no("E_ACCOUNT_CREDENTIAL", { venue, message: `${shown} is not a file` });
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) return no("E_ACCOUNT_CREDENTIAL", { venue, message: `${shown} can be read by other users of this machine (mode ${(stat.mode & 0o777).toString(8)}): run chmod 600 on it first`, detail: { mode: (stat.mode & 0o777).toString(8) } });
  return { text: readFileSync(real, "utf8"), shown };
}

/** Read a key file. `ref` is a path inside the home directory (relative to it, or absolute and still inside it). */
export function loadKeyFile(home: string, ref: string, shape: KeyShape, venue: string): KeyFile | Refusal {
  const where = ref.trim() || defaultKeyRef(venue);
  const file = readSecretFile(home, where, venue, `Create it as ${join(home, defaultKeyRef(venue))} — ${shape.example} — then: chmod 600 on the file`);
  if ("ok" in file) return file;
  const shown = file.shown;
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.text);
  } catch {
    return no("E_ACCOUNT_CREDENTIAL", { venue, message: `${shown} is not JSON. It should hold ${shape.example}` });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return no("E_ACCOUNT_CREDENTIAL", { venue, message: `${shown} should hold one JSON object: ${shape.example}` });
  const out: KeyFile = {};
  for (const field of [...shape.required, ...(shape.optional ?? [])]) {
    const v = (parsed as Record<string, unknown>)[field];
    if (typeof v === "string" && v.trim() !== "") out[field] = v.trim();
  }
  const missing = shape.required.filter((f) => out[f] === undefined);
  // the names of the missing fields are said; no value from the file ever is
  if (missing.length) return no("E_ACCOUNT_CREDENTIAL", { venue, message: `${shown} is missing ${missing.map((m) => `"${m}"`).join(", ")}. It should hold ${shape.example}`, detail: { missing } });
  return out;
}
