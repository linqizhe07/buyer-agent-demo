import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/** Append one JSON row to a `.jsonl` file, creating its directory. Synchronous
 * on purpose: a ledger row must be on disk before the next step runs. */
export function appendJsonl(file: string, row: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(row) + "\n", "utf8");
}

/** Read every row of a `.jsonl` file; a missing file is an empty list. */
export function readJsonl<T = unknown>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}
