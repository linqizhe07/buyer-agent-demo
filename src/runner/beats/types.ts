import type { DemoEnv } from "../env.ts";
import type { Checker } from "../narration.ts";

export type ScenarioName =
  | "mount"
  | "rogue"
  | "read"
  | "fund"
  | "alpaca"
  | "hyperliquid"
  | "binance"
  | "solana"
  | "injection"
  | "reconcile"
  | "summary";

export const SCENARIO_ORDER: readonly ScenarioName[] = [
  "mount",
  "rogue",
  "read",
  "fund",
  "alpaca",
  "hyperliquid",
  "binance",
  "solana",
  "injection",
  "reconcile",
  "summary",
];

export interface BeatContext extends Checker {
  env: DemoEnv;
  /** narration line */
  say(line: string): void;
}

export interface Beat {
  name: ScenarioName;
  /** printed as `Scenario N: <title>` */
  title: string;
  run(ctx: BeatContext): Promise<void>;
}
