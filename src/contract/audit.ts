/** The mount audit: the manifest meets what the server actually advertises.
 *
 * Pure. Called once per plugin right after `listTools()`, before anything is
 * registered. The rules, in order:
 *   1. a listed tool the manifest does not classify  → refuse the whole mount
 *   2. a classified tool the server does not list   → refuse (manifest drift)
 *   3. a `read` tool whose server annotation says it writes → refuse
 *      (the annotation is an untrusted hint; the manifest is the operator's
 *      word; when they disagree the stricter reading wins)
 *   4. `deny` tools are never registered; `write` tools register and their
 *      full names join the gate's allow-list.
 */
import { refuse, type Refusal } from "../core/errors.ts";
import type { Manifest } from "./manifest.ts";

export interface ListedTool {
  name: string;
  description?: string | undefined;
  annotations?: { readOnlyHint?: boolean | undefined; destructiveHint?: boolean | undefined } | undefined;
}

export interface AuditResult {
  ok: boolean;
  venue: string;
  /** raw names to register, by class */
  mounted: { read: string[]; write: string[] };
  /** listed on the server, refused by the manifest, never registered */
  denied: string[];
  /** the rule that fired, when `ok` is false */
  refusal?: Refusal;
}

export function auditManifest(manifest: Manifest, listed: ListedTool[]): AuditResult {
  const venue = manifest.venue;
  const listedNames = listed.map((t) => t.name);
  const classified = new Set([...manifest.tools.read, ...manifest.tools.write, ...manifest.tools.deny]);

  const unclassified = listedNames.filter((n) => !classified.has(n));
  if (unclassified.length) {
    return {
      ok: false,
      venue,
      mounted: { read: [], write: [] },
      denied: [],
      refusal: refuse("E_MOUNT_UNCLASSIFIED", {
        venue,
        message: `${unclassified.join(", ")} 未分类，整包拒绝挂载`,
        detail: { unclassified, listed: listedNames },
      }),
    };
  }

  const missing = [...manifest.tools.read, ...manifest.tools.write].filter((n) => !listedNames.includes(n));
  if (missing.length) {
    return {
      ok: false,
      venue,
      mounted: { read: [], write: [] },
      denied: [],
      refusal: refuse("E_MOUNT_MISSING_TOOL", { venue, detail: { missing, listed: listedNames } }),
    };
  }

  const underClassified = listed
    .filter((t) => manifest.tools.read.includes(t.name) && t.annotations?.readOnlyHint === false)
    .map((t) => t.name);
  if (underClassified.length) {
    return {
      ok: false,
      venue,
      mounted: { read: [], write: [] },
      denied: [],
      refusal: refuse("E_MOUNT_READONLY_MISMATCH", { venue, detail: { tools: underClassified } }),
    };
  }

  return {
    ok: true,
    venue,
    mounted: { read: [...manifest.tools.read], write: [...manifest.tools.write] },
    denied: listedNames.filter((n) => manifest.tools.deny.includes(n)),
  };
}
