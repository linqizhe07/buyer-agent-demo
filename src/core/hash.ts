import { createHash } from "node:crypto";

/** Canonical JSON: object keys sorted recursively, no whitespace, so the same
 * value always hashes the same. Arrays keep their order. */
export function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export function sha256(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/** First `n` hex chars of a hash, for cards and log lines. */
export function short(hash: string, n = 8): string {
  return hash.slice(0, n);
}
