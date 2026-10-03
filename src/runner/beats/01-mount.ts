import { showRefusal } from "../narration.ts";
import { VENUE_ORDER } from "../env.ts";
import type { Beat } from "./types.ts";

/** The seats were mounted in setup (so `--only` works); this beat shows the
 * audience what each one handed over at the door and what the audit said. */
export const mountBeat: Beat = {
  name: "mount",
  title: "挂载场所插件 · 每个插件先交清单，boot audit 再放行",
  async run(ctx) {
    const { env } = ctx;
    for (const venue of VENUE_ORDER) {
      const handle = env.plugins.get(venue);
      if (!handle) {
        ctx.check(false, `${venue} · no plugin handle`, "mount");
        continue;
      }
      const m = handle.manifest;
      ctx.say(`${m.title}`);
      ctx.say(`  原生给的：${m.native}`);
      ctx.say(`  钥匙放在：${m.keyLives}`);
      ctx.say(`  清单：read ${m.tools.read.join(", ")} · write ${m.tools.write.join(", ") || "(none)"} · deny ${m.tools.deny.join(", ") || "(none)"}`);
      if (!handle.audit.ok && handle.audit.refusal) showRefusal(handle.audit.refusal);
      ctx.check(
        handle.audit.ok,
        `${venue} · mounted ${handle.audit.mounted.read.length} read + ${handle.audit.mounted.write.length} write tools, ${handle.audit.denied.length} denied, seat pid ${handle.pid}`,
        "mount",
      );
    }
    const tools = env.registry.list();
    ctx.check(
      tools.length > 0 && tools.every((t) => t.cls === "read" || t.cls === "write"),
      `every mounted tool is classified: ${tools.filter((t) => t.cls === "read").length} read, ${tools.filter((t) => t.cls === "write").length} write`,
      "mount",
    );
    ctx.check(
      [...env.writeTools.keys()].every((n) => env.registry.get(n)?.cls === "write" && env.gate.isWriteTool(n)),
      `gate allow-list = the manifests' write tools: ${env.gate.allowed().join(", ")}`,
      "mount",
    );
    const spawns = env.bus.all().filter((e) => e.type === "plugin/spawn");
    const clean = spawns.every((e) => (e.data as { envNames: string[] }).envNames.every((n) => !/KEY|SECRET|TOKEN|PASSWORD/i.test(n)));
    ctx.check(clean && spawns.length === VENUE_ORDER.length, "every seat started with a scrubbed environment: no KEY/SECRET/TOKEN/PASSWORD name, one credential ref", "mount");
  },
};
