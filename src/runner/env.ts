/** The run environment: one home, one clock, one bus, one id factory, the
 * venue simulators, the registry of mounted tools, the plugin handles, and
 * the agent (gate, mandates, ledger, answerer). */
import { createWriteStream, mkdirSync, rmSync, type WriteStream } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Agent } from "../agent/agent.ts";
import { AutoAnswerer, type Answerer } from "../agent/answerer.ts";
import { Gate } from "../agent/gate.ts";
import { Ledger } from "../agent/ledger.ts";
import { MandateStore } from "../agent/mandates.ts";
import type { PluginHandle } from "../agent/mount.ts";
import { ToolRegistry } from "../agent/registry.ts";
import type { Manifest } from "../contract/manifest.ts";
import { Bus } from "../core/bus.ts";
import { SimClock } from "../core/clock.ts";
import { IdFactory } from "../core/ids.ts";
import type { VenueHandle } from "../venues/alpaca.ts";
import type { RunArgs } from "./args.ts";
import { seedHome } from "./setup.ts";

export const DEFAULT_HOME = join(homedir(), ".buyer-agent-demo");

/** The seats, in the order the story mounts them (grows with the phases). */
export const VENUE_ORDER: readonly string[] = ["alpaca", "hyperliquid", "binance", "solana"];

export interface DemoEnv {
  args: RunArgs;
  home: string;
  /** files the seed step copied this run */
  seeded: string[];
  clock: SimClock;
  bus: Bus;
  ids: IdFactory;
  /** counters the control-room header shows */
  counters: { fills: number; refusals: number; lossUsd: number };
  /** registered teardown steps, run in reverse order */
  cleanups: Array<() => Promise<void> | void>;
  /** venue simulators by venue id (plus `signer`) */
  venues: Record<string, VenueHandle | undefined>;
  registry: ToolRegistry;
  plugins: Map<string, PluginHandle>;
  manifests: Map<string, Manifest>;
  /** every mounted write tool, by public name, with the manifest that classified it */
  writeTools: Map<string, Manifest>;
  gate: Gate;
  mandates: MandateStore;
  ledger: Ledger;
  answerer: Answerer;
  agent: Agent;
}

export function resolveHome(args: RunArgs): string {
  return args.home ?? process.env.BUYER_HOME ?? DEFAULT_HOME;
}

export function createEnv(args: RunArgs, answerer?: Answerer): DemoEnv {
  const home = resolveHome(args);
  if (args.fresh) {
    if (home !== DEFAULT_HOME) throw new Error(`--fresh only wipes the default home (${DEFAULT_HOME}); ${home} is yours to clean`);
    rmSync(home, { recursive: true, force: true });
  }
  mkdirSync(join(home, "runs"), { recursive: true });
  const seeded = seedHome(home, args.fresh);

  const clock = new SimClock();
  const runLog: WriteStream = createWriteStream(join(home, "runs", "last.jsonl"), { flags: "w" });
  const bus = new Bus({ sink: (line) => runLog.write(line + "\n"), simNow: () => clock.iso() });
  const ids = new IdFactory();
  const counters = { fills: 0, refusals: 0, lossUsd: 0 };
  const registry = new ToolRegistry();
  const manifests = new Map<string, Manifest>();
  const gate = new Gate({ bus, eventsFile: join(home, "ledger", "events.jsonl"), now: () => clock.iso() });
  const mandates = new MandateStore(home);
  const ledger = new Ledger(join(home, "ledger", "ledger.jsonl"), () => clock.iso(), (row) => bus.emit("ledger/row", row));
  const chosenAnswerer = answerer ?? new AutoAnswerer();
  const agent = new Agent({ registry, gate, mandates, ledger, answerer: chosenAnswerer, bus, clock, ids, manifests, counters });

  return {
    args,
    home,
    seeded,
    clock,
    bus,
    ids,
    counters,
    cleanups: [() => new Promise<void>((resolve) => runLog.end(resolve))],
    venues: {},
    registry,
    plugins: new Map(),
    manifests,
    writeTools: new Map(),
    gate,
    mandates,
    ledger,
    answerer: chosenAnswerer,
    agent,
  };
}

export async function disposeEnv(env: DemoEnv): Promise<void> {
  for (const step of [...env.cleanups].reverse()) {
    try {
      await step();
    } catch (err) {
      console.error(`[env] cleanup failed: ${(err as Error).message}`);
    }
  }
}
