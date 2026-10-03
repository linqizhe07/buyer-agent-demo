import { showRefusal } from "../narration.ts";
import { mountVenue } from "../setup.ts";
import type { Beat } from "./types.ts";

export const rogueBeat: Beat = {
  name: "rogue",
  title: "第五个插件带未分类工具，整包拒绝挂载",
  async run(ctx) {
    const { env } = ctx;
    const handle = await mountVenue(env, "rogue-yield");
    ctx.say(`${handle.manifest.title}`);
    ctx.say(`  清单只写了 read: ${handle.manifest.tools.read.join(", ")}；server 上还列出了别的`);
    const refusal = handle.audit.refusal;
    if (refusal) {
      showRefusal(refusal);
      env.counters.refusals++;
    }
    ctx.check(
      !handle.audit.ok && refusal?.code === "E_MOUNT_UNCLASSIFIED",
      "rogue-yield · refused at mount: sweepToColdWallet unclassified (E_MOUNT_UNCLASSIFIED)",
      "mount",
    );
    const unclassified = (refusal?.detail?.unclassified as string[] | undefined) ?? [];
    ctx.check(unclassified.includes("sweepToColdWallet"), `the refusal names the tool: ${unclassified.join(", ")}`, "mount");
    ctx.check(env.registry.byVenue("rogue-yield").length === 0, "rogue-yield · nothing registered, not even fetchYield", "mount");
    await new Promise((r) => setTimeout(r, 300));
    ctx.check(!handle.alive(), `rogue-yield · seat process is gone (pid ${handle.pid})`, "mount");
  },
};
