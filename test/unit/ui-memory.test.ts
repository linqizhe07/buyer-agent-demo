import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createContext, runInContext, Script } from "node:vm";
import { describe, expect, it } from "vitest";

/** The Account's Memory pane (ui/memory.js), run as the page runs it — plain scripts in one global scope after ui/core.js — here in a vm with a
 * stand-in document. What is checked is what the owner reads and presses: the conversation drawn as round 7 draws a channel (the owner's
 * words on the right, the agent's on the left, the account's refusals with their code, a time line when the day changes), every word an
 * agent wrote escaped, the agents picked by their own pills, About you and an agent's notes with their topic and who wrote them, every
 * signed change (setMemory, forgetMemory) wired, and nothing that signs offered to a browser that only looks */
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
const turn = (id: string, at: string, who: string, kind: string, text: string, extra: Record<string, unknown> = {}) => ({ id, at, who, kind, text, ...extra });
const MEMORY = {
  ok: true,
  asOf: NOW,
  about: [{ id: "note-0001", topic: "rule", text: "Never leverage above 3x <b>without</b> asking.", at: "2026-10-08T12:00:00.000Z", by: "owner" }],
  everyone: { turns: [], total: 0, dropped: 0 },
  agents: [
    {
      address: CC,
      name: "Claude Code",
      code: "CC",
      status: "ok",
      notes: [{ id: "note-0001", topic: "preference", text: "Owner likes limit orders <img src=x onerror=alert(1)>", at: "2026-10-09T17:00:00.000Z", by: "agent" }],
      conversation: {
        total: 4,
        more: false,
        dropped: 0,
        turns: [
          turn("turn-000001", "2026-10-08T15:00:00.000Z", "owner", "intent", "Build a SOL position (buy SOL/USDT at Ex about $300) · until Mon 12 Oct", { ref: "intent-0003" }),
          turn("all-000001", "2026-10-09T17:00:00.000Z", "owner", "watch", "Watching BTC/USDT at Ex"),
          turn("turn-000002", "2026-10-09T17:01:00.000Z", "agent", "report", "On it: <script>alert(1)</script>", { ref: "intent-0003" }),
          turn("turn-000003", "2026-10-09T17:02:00.000Z", "account", "refusal", "buy 1 BTC/USDT at Ex, market: refused — $60,000 is over the $150 an order the limit allows", { code: "E_MANDATE_PER_ORDER_CAP" }),
        ],
      },
    },
    { address: GONE, name: "", code: "", status: "gone", notes: [], conversation: { total: 0, more: false, dropped: 0, turns: [] } },
  ],
  limits: { noteText: 500, maxNotes: 100, maxAbout: 50, maxTurns: 500, topics: ["preference", "rule", "fact", "lesson", "progress", "other"] },
};
const ACCOUNT = { now: NOW, mode: "guard", liveUsd: 1000, venues: [], keys: [{ address: CC, name: "Claude Code", code: "CC", status: "ok" }], spend: [], cards: [], asks: [], orders: [], payments: [], intents: [], watch: [], requests: [], subAccounts: [], connectLive: { writes: { on: true, capUsd: 250 }, options: [] } };

describe("the Memory pane", () => {
  it("draws the conversation as round 7 draws a channel, escaping every word an agent wrote", () => {
    const p = page();
    p.set("A", ACCOUNT);
    p.set("MEM.page", MEMORY);
    const html = p.run<string>(`memChatHtml(MEM.page.agents[0], true)`);
    // your words on the right, the agent's on the left with its letter, the account's refusal with its code
    expect(html).toContain('class="mem-turn from-you" data-k="turn-000001"');
    expect(html).toContain('class="mem-turn from-agent" data-k="turn-000002"');
    expect(html).toMatch(/class="mem-turn from-account" data-k="turn-000003"><div class="bub"><span class="mem-code">✗ E_MANDATE_PER_ORDER_CAP<\/span>/);
    // what an agent wrote is text, never markup
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    // a time line when the day changes: one for the 8th, one for the 9th
    expect(html.match(/class="mem-time"/g)).toHaveLength(2);
    // the words to every agent say so, and forgetting one says it is every agent's
    expect(html).toMatch(/Watching · to every agent/);
    expect(html).toMatch(/data-mem-act="forget-turn" data-agent="0x3a08[0-9a-f]+" data-id="all-000001"[^>]*title="Forget this turn \(every agent&#39;s\)"/);
    expect(html).toContain('data-mem-act="forget-chat"');
  });

  it("shows About you and an agent's notes with their topic and who wrote them; an agent the account no longer lists is named by its key", () => {
    const p = page();
    p.set("A", ACCOUNT);
    p.set("MEM.page", MEMORY);
    const about = p.run<string>("memAboutHtml(true)");
    expect(about).toContain("Every agent on the account reads these");
    expect(about).toContain("&lt;b&gt;without&lt;/b&gt;");
    expect(about).toContain('data-mem-form="about-add" data-scope="about"');
    const notes = p.run<string>("memNotesHtml(MEM.page.agents[0], true)");
    expect(notes).toContain("What Claude Code keeps");
    expect(notes).toContain("1 note of 100");
    expect(notes).toContain('<span class="chip">Preference</span>');
    expect(notes).toContain("its own");
    expect(notes).not.toContain("<img");
    for (const act of ["edit", "to-about", "forget-note", "forget-notes", "add"]) expect(notes, act).toContain(`data-mem-act="${act}"`);
    const who = p.run<string>("memWhoHtml(memAgents(), memAgents()[0])");
    expect(who).toContain('data-mem-agent="0x3a087530887bd175ccc38828ee3776e5b6ea1ac6"');
    expect(who).toContain("An earlier key 0x999999…9999");
  });

  it("offers nothing that signs to a browser that only looks", () => {
    const p = page();
    p.set("A", ACCOUNT);
    p.set("MEM.page", MEMORY);
    const all = p.run<string>("memChatHtml(MEM.page.agents[0], false) + memNotesHtml(MEM.page.agents[0], false) + memAboutHtml(false)");
    const buttons = [...all.matchAll(/<button\b[^>]*data-mem-act="(forget-[a-z]+|edit|to-about|add)"[^>]*>/g)];
    expect(buttons.length).toBeGreaterThan(5);
    for (const b of buttons) expect(b[0], b[1]).toContain(" disabled");
  });
});
