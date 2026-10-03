/** What the terminal prints, and the one rule behind it.
 *
 *   ✓ [layer] venue · what     a check that passed
 *   ✗ E_LAYER_REASON · why     a REFUSAL — expected, shown on purpose; it is the product
 *   FAIL [scenario] what       an assertion that failed — the run exits 1
 *   ! [bypass] ...             the runner deliberately stepping around the agent
 *     plain text               narration
 *
 * `✗` and `FAIL` are different things: the audience sees seven ✗ lines in a
 * passing run, and the e2e test asserts there is no FAIL line.
 */
import type { Bus } from "../core/bus.ts";
import { formatRefusal, type Refusal } from "../core/errors.ts";

export function heading(title: string): void {
  console.log(`\n==== ${title}`);
}

export function note(line: string): void {
  console.log(`  ${line}`);
}

export function bypass(line: string): void {
  console.log(`! [bypass] ${line}`);
}

export function showRefusal(r: Refusal): void {
  console.log(formatRefusal(r));
}

export interface Checker {
  /** prints ✓ or FAIL, records the failure, returns `cond` so callers can branch */
  check(cond: boolean, what: string, layer?: string): boolean;
  readonly failures: string[];
}

export function createChecker(scenario: string, bus: Bus, failures: string[]): Checker {
  return {
    failures,
    check(cond, what, layer) {
      const tag = layer ? `[${layer}] ` : "";
      if (cond) {
        console.log(`✓ ${tag}${what}`);
      } else {
        console.log(`FAIL [${scenario}] ${what}`);
        failures.push(`${scenario}: ${what}`);
      }
      bus.emit("beat/check", { scenario, ok: cond, what, layer: layer ?? null });
      return cond;
    },
  };
}
