import { mountBeat } from "./01-mount.ts";
import { rogueBeat } from "./02-rogue.ts";
import { readBeat } from "./03-read.ts";
import { fundBeat } from "./fund.ts";
import { alpacaBeat } from "./04-alpaca.ts";
import { hyperliquidBeat } from "./05-hyperliquid.ts";
import { binanceBeat } from "./06-binance.ts";
import { solanaBeat } from "./07-solana.ts";
import { injectionBeat } from "./08-injection.ts";
import { reconcileBeat } from "./09-reconcile.ts";
import { summaryBeat } from "./10-summary.ts";
import type { Beat, ScenarioName } from "./types.ts";

/** One entry per scenario, in SCENARIO_ORDER. Phases replace the stubs. */
export const BEATS: Record<ScenarioName, Beat> = {
  mount: mountBeat,
  rogue: rogueBeat,
  read: readBeat,
  fund: fundBeat,
  alpaca: alpacaBeat,
  hyperliquid: hyperliquidBeat,
  binance: binanceBeat,
  solana: solanaBeat,
  injection: injectionBeat,
  reconcile: reconcileBeat,
  summary: summaryBeat,
};
