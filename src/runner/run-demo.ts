/** `npm run demo` — ten scenarios, ✓/✗/FAIL lines, a Summary, exit 0 iff no
 * assertion failed. Mirrors agentpay's demo runner: `--only <name>` runs one
 * scenario, `--from <name>` resumes at one, `--live` opens the control room and
 * waits for a human at every card. */
import { HttpAnswerer } from "../agent/http-answerer.ts";
import { codesTable, DECISIONS, startControlRoom, type ControlRoomHandle, type ControlRoomMeta } from "../control-room/server.ts";
import { parseArgs } from "./args.ts";
import { BEATS } from "./beats/index.ts";
import { NEXT, NOT_PROVEN, PROVEN } from "./beats/10-summary.ts";
import { SCENARIO_ORDER, type ScenarioName } from "./beats/types.ts";
import { createEnv, disposeEnv, VENUE_ORDER, type DemoEnv } from "./env.ts";
import { createChecker, heading, note } from "./narration.ts";
import { loadVenueManifest, mountVenue, startVenues } from "./setup.ts";

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const failures: string[] = [];

  const selected = selectScenarios(args.only, args.from);
  const answerer = args.live ? new HttpAnswerer() : undefined;
  const env: DemoEnv = createEnv(args, answerer);
  const started = Date.now();
  let room: ControlRoomHandle | undefined;
  if (args.live || args.room) {
    const manifests = [...VENUE_ORDER, "rogue-yield"].map((v) => loadVenueManifest(v));
    const meta = (): ControlRoomMeta => ({
      manifests: manifests.map((m) => ({ venue: m.venue, serverName: m.serverName, title: m.title, native: m.native, keyLives: m.keyLives, limits: m.limits, tools: m.tools, identityRef: m.identity?.ref ?? null, signer: m.signer.kind })),
      decisions: DECISIONS,
      proven: PROVEN,
      notProven: NOT_PROVEN,
      next: NEXT,
      codes: codesTable(),
      live: args.live,
      mandates: VENUE_ORDER.flatMap((v) => env.mandates.forVenue(v)).map((m) => ({ id: m.id, venue: m.venue, purpose: m.purpose, notionalLimitUsd: m.notionalLimitUsd, perOrderCapUsd: m.perOrderCapUsd, symbols: m.symbols, recipients: m.recipients, validUntil: m.validUntil, spentUsd: m.spentUsd, status: m.status })),
    });
    room = await startControlRoom({ port: args.port, bus: env.bus, meta, answerer });
  }

  heading("Setup");
  note(`home ${env.home}`);
  note(env.seeded.length ? `seeded ${env.seeded.length} files into the home (${env.seeded.join(", ")})` : "home already seeded");
  note(`sim clock ${env.clock.iso()} · driver ${args.driver} · answerer ${args.live ? "human (control room)" : "stand-in (auto)"}`);
  note("四家市场均为本地模拟 · all four venues are local simulators");
  if (room) note(`control room ${room.url}${args.live ? " · every card waits for you there" : " · watching the stand-in"}`);
  env.bus.emit("run/start", { scenarios: selected, live: args.live, driver: args.driver, home: env.home, room: room?.url ?? null });

  try {
    await startVenues(env);
    note(`venues up: ${Object.entries(env.venues).map(([k, v]) => `${k} ${v?.url}`).join(" · ")}`);
    // the seats mount in setup so `--only` / `--from` still have an agent to drive; scenario 1 reports the audit
    for (const venue of VENUE_ORDER) await mountVenue(env, venue);
    note(`seats mounted: ${VENUE_ORDER.map((v) => `${v}${env.plugins.get(v)?.audit.ok ? "" : " (REFUSED)"}`).join(" · ")}`);
    for (const name of selected) {
      const beat = BEATS[name];
      const index = SCENARIO_ORDER.indexOf(name) + 1;
      heading(`Scenario ${index}: ${beat.title}`);
      env.bus.emit("beat/start", { scenario: name, index, title: beat.title });
      const checker = createChecker(name, env.bus, failures);
      try {
        await beat.run({ ...checker, env, say: note });
      } catch (err) {
        const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
        console.log(`FAIL [${name}] threw: ${message}`);
        failures.push(`${name}: threw ${err instanceof Error ? err.message : String(err)}`);
      }
      env.bus.emit("beat/end", { scenario: name, failures: failures.filter((f) => f.startsWith(`${name}:`)).length });
    }
  } finally {
    heading("Summary");
    note(`scenarios ${selected.length} · fills ${env.counters.fills} · refusals ${env.counters.refusals} · loss $${env.counters.lossUsd.toFixed(2)}`);
    note(`run log ${env.home}/runs/last.jsonl · ${((Date.now() - started) / 1000).toFixed(1)}s`);
    env.bus.emit("summary", { failures: [...failures], counters: env.counters });
    if (room && args.hold) {
      note("holding the control room open (Ctrl-C to stop)");
      await new Promise<void>((resolve) => process.once("SIGINT", () => resolve()));
    }
    await disposeEnv(env);
    await room?.close();
  }

  if (failures.length) {
    console.log(`\nFAILED ASSERTIONS (${failures.length}):`);
    for (const f of failures) console.log(`  - ${f}`);
    return 1;
  }
  console.log("\nALL SCENARIO ASSERTIONS PASSED");
  return 0;
}

function selectScenarios(only: string | undefined, from: string | undefined): ScenarioName[] {
  const known = (n: string): ScenarioName => {
    if (!(SCENARIO_ORDER as readonly string[]).includes(n)) {
      console.error(`unknown scenario "${n}"; known: ${SCENARIO_ORDER.join(", ")}`);
      process.exit(2);
    }
    return n as ScenarioName;
  };
  if (only) return [known(only)];
  if (from) {
    const start = SCENARIO_ORDER.indexOf(known(from));
    return SCENARIO_ORDER.slice(start);
  }
  return [...SCENARIO_ORDER];
}

main().then(
  (code) => process.stdout.write("", () => process.exit(code)),
  (err) => {
    console.error(err);
    process.stdout.write("", () => process.exit(1));
  },
);
