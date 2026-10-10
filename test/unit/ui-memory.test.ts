import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createContext, runInContext, Script } from "node:vm";
import { describe, expect, it } from "vitest";

/** The Account's Memory pane (ui/memory.js) — the Demo v2 canvas's F13 — run as the page runs it: plain scripts in one global scope after
 * ui/core.js, here in a vm with a stand-in document. What is checked is what the owner reads and presses: what an agent remembers in three
 * parts (Style · Rules · Venues and people), each note saying where it came from (You said · It learned … · From your limit), a waiting note
 * with keep and forget, every word an agent wrote escaped, Where it's used, the three switches, Export and Forget all — and nothing that
 * signs offered to a browser that only looks */
const UI = fileURLToPath(new URL("../../src/portfolio/public/ui/", import.meta.url));
const FILES = ["core.js", "memory.js"];

function page() {
  const element = (): Record<string, unknown> => ({ addEventListener() {}, removeAttribute() {}, setAttribute() {}, querySelectorAll: () => [], querySelector: () => null, classList: { add() {}, remove() {}, toggle() {} }, dataset: {}, style: {} });
  const sandbox: Record<string, unknown> = {
    document: { getElementById: element, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, body: element(), documentElement: { dataset: { theme: "cream" } } },
    location: { hash: "", origin: "http://127.0.0.1:4820" },
    history: { replaceState() {} },
    Owner: { role: "owner", kid: "k1", why: () => "" },
    Event: class {
      constructor(readonly type: string) {}
    },
    addEventListener() {},
    dispatchEvent: () => true,
    console,
    URLSearchParams,
    Intl,
    setTimeout,
    clearTimeout,
    fetch: () => new Promise(() => {}),
  };
  const ctx = createContext(sandbox);
  sandbox.window = runInContext("globalThis", ctx);
  for (const f of FILES) new Script(readFileSync(`${UI}${f}`, "utf8"), { filename: f }).runInContext(ctx);
  const run = <T = unknown>(code: string): T => runInContext(code, ctx) as T;
  return { run, set: (name: string, value: unknown) => run(`${name} = ${JSON.stringify(value)}`) };
}

const NOW = "2026-10-09T18:00:00.000Z";
const CC = "0x3a087530887bd175ccc38828ee3776e5b6ea1ac6";
const GONE = "0x9999999999999999999999999999999999999999";
const note = (id: string, topic: string, text: string, extra: Record<string, unknown> = {}) => ({ id, topic, text, from: "you", at: "2026-10-02T15:00:00.000Z", ...extra });
const MEMORY = {
  ok: true,
  asOf: NOW,
  agents: [
    {
      address: CC,
      name: "Claude Code",
      code: "CC",
      status: "ok",
      rules: { learn: true, ask: true, share: false },
      notes: [
        note("note-0001", "style", "Value over hype <b>always</b>"),
        note("note-0002", "style", "Watches the tech supply chain <img src=x onerror=alert(1)>", { from: "agent", how: "from your questions", at: "2026-10-06T15:00:00.000Z" }),
        note("note-0003", "venues", "BTC is cheaper at the exchange than at the DEX", { from: "agent", how: "by comparing the venues" }),
        note("note-0004", "rules", "Ask before adding to a position", { from: "agent", how: "from the order you declined", waiting: true }),
      ],
      fromLimits: [
        { id: "spend-0001", from: "limit", topic: "rules", text: "Up to $25 an order, $100 in all, at OKX · until Thu, Oct 15", at: "2026-10-08T15:00:00.000Z" },
        { id: "mode", from: "mode", topic: "rules", text: "Real money goes through you first: every order waits for you on a card (Guard)" },
      ],
    },
    { address: GONE, name: "", code: "", status: "gone", rules: { learn: true, ask: false, share: false }, notes: [note("note-0001", "style", "x")], fromLimits: [] },
  ],
  limits: { noteText: 500, howText: 80, maxNotes: 100, topics: [] },
};
const ACCOUNT = { now: NOW, mode: "guard", liveUsd: 1000, venues: [], keys: [{ address: CC, name: "Claude Code", code: "CC", status: "ok" }], spend: [], cards: [], asks: [], orders: [], payments: [], intents: [], watch: [], requests: [], subAccounts: [], connectLive: { writes: { on: true, capUsd: 250 }, options: [] } };

describe("the Memory pane (F13)", () => {
  it("shows what the agent remembers in three parts, each note saying where it came from; a waiting note offers keep and forget", () => {
    const p = page();
    p.set("A", ACCOUNT);
    p.set("MEM.page", MEMORY);
    const html = p.run<string>("memNotesHtml(MEM.page.agents[0], true)");
    expect(html).toContain("What Claude Code remembers about you");
    expect(html).toContain("6 notes · only on this machine");
    // the parts in order, the limit's lines first under Rules
    const parts = [...html.matchAll(/<h3 class="mem-part-h">([^<]+)<\/h3>/g)].map((m) => m[1]);
    expect(parts).toEqual(["Style", "Rules", "Venues and people"]);
    expect(html.indexOf("Up to $25 an order")).toBeLessThan(html.indexOf("Ask before adding"));
    // where each came from
    expect(html).toContain("You said · 2 Oct");
    expect(html).toContain("It learned from your questions · 6 Oct");
    expect(html).toContain("It learned by comparing the venues");
    expect(html).toContain("From your limit · 8 Oct");
    expect(html).toContain("From your mode: Guard | Beast, at the top");
    // what an agent wrote is text, never markup
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;b&gt;always&lt;/b&gt;");
    // the waiting note: Waits for you, keep and forget; the others edit and forget; a limit's line is changed in the limit form
    expect(html).toMatch(/data-k="note-0004"[\s\S]*?Waits for you[\s\S]*?data-mem-act="keep"[\s\S]*?data-mem-act="forget-note"/);
    expect(html.match(/data-mem-act="edit"/g)).toHaveLength(3);
    expect(html.match(/data-mem-act="limit"/g)).toHaveLength(1);
    expect(html).toContain('data-mem-form="add"');
    expect(html).toContain('placeholder="Add one thing it should remember…"');
  });

  it("says where it is used, and draws the three switches as they stand with Export and Forget all", () => {
    const p = page();
    p.set("A", ACCOUNT);
    p.set("MEM.page", MEMORY);
    const uses = p.run<string>("memUsesHtml(MEM.page.agents[0])");
    expect(uses).toContain("Where it's used");
    expect(uses).toContain("Claude Code reads it when a session starts (portfolio_memory)");
    expect(uses).toContain("Do not read it: only Claude Code does");
    expect(uses).toContain("Words, not permission");
    const sw = p.run<string>("memSwitchesHtml(MEM.page.agents[0], true)");
    expect([...sw.matchAll(/role="switch" class="pf-switch" aria-checked="(true|false)" aria-label="([^"]+)"/g)].map((m) => [m[2], m[1]])).toEqual([
      ["Let Claude Code remember new things", "true"],
      ["Ask me before keeping what it learns", "true"],
      ["Other agents can read it", "false"],
    ]);
    expect(sw).toContain('data-mem-act="export"');
    expect(sw).toContain('data-mem-act="forget-all"');
    expect(sw).toContain("Forget all deletes the file: there is no bin.");
    const who = p.run<string>("memWhoHtml(memAgents(), memAgents()[0])");
    expect(who).toContain("An earlier key 0x999999…9999");
  });

  it("offers nothing that signs to a browser that only looks", () => {
    const p = page();
    p.set("A", ACCOUNT);
    p.set("MEM.page", MEMORY);
    const all = p.run<string>("memNotesHtml(MEM.page.agents[0], false) + memSwitchesHtml(MEM.page.agents[0], false)");
    const buttons = [...all.matchAll(/<button\b[^>]*data-mem-act="(edit|keep|forget-note|forget-all|limit|switch)"[^>]*>/g)];
    expect(buttons.length).toBeGreaterThan(8);
    for (const b of buttons) expect(b[0], b[1]).toContain(" disabled");
  });
});
