/** The Mode sheet and the chrome around the mode (ui/agents-mount.js, ui/shell.js, account.html), run as the page runs them — every page
 * script in account.html's order, one global scope — over the stand-in browser the other ui-* tests use, with the elements kept by id so
 * what is drawn into them can be read: the sheet's switch, its table from what the account says (A.modeRules) with the mode in force marked,
 * the footer's cap and minutes; Guard a free POST, Beast a signature; the Settings and Agents sheets as the IA round left them; and the
 * chrome that round removed stays gone. Nothing leaves the process. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createContext, runInContext, Script } from "node:vm";
import { describe, expect, it } from "vitest";

const PUBLIC = fileURLToPath(new URL("../../src/portfolio/public/", import.meta.url));
const html = readFileSync(join(PUBLIC, "account.html"), "utf8");
const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1] ?? "");
const source = (src: string) => readFileSync(join(PUBLIC, src.replace(/^\//, "")), "utf8");

/** the page's scripts in a stand-in browser: after the scripts loaded, every element is kept by its id, so a sheet's body can be read back */
function page(opts: { fetch?: (path: string, init?: { method?: string; body?: string }) => Promise<unknown> } = {}) {
  const element = (): Record<string, unknown> => ({ addEventListener() {}, removeAttribute() {}, setAttribute() {}, querySelectorAll: () => [], querySelector: () => null, classList: { add() {}, remove() {}, toggle() {} }, dataset: {}, style: {}, hidden: false, value: "", textContent: "", innerHTML: "", contains: () => false, open: false, title: "" });
  const kept: Record<string, Record<string, unknown>> = {};
  let started = false;
  const sandbox: Record<string, unknown> = {
    document: { getElementById: (id: string) => (started ? (kept[id] ??= element()) : element()), querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, body: element(), documentElement: { dataset: { theme: "cream" }, setAttribute() {} }, hidden: false, activeElement: null, title: "" },
    location: { hash: "", origin: "http://127.0.0.1:4895" },
    history: { replaceState() {} },
    localStorage: { getItem: () => null, setItem() {} },
    MutationObserver: class {
      observe() {}
    },
    Event: class {
      constructor(readonly type: string) {}
    },
    addEventListener() {},
    dispatchEvent: () => true,
    scrollTo() {},
    indexedDB: { open: () => ({}) },
    fetch: opts.fetch ?? (() => new Promise(() => {})),
    console,
    URLSearchParams,
    Intl,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval() {},
  };
  const ctx = createContext(sandbox);
  sandbox.window = runInContext("globalThis", ctx);
  for (const src of scripts) new Script(source(src), { filename: src }).runInContext(ctx);
  started = true;
  const run = <T = unknown>(code: string): T => runInContext(code, ctx) as T;
  // the sheet's frame is not drawn here: what a sheet asks the shell to draw is kept, and its body elements are the kept ones
  run('var SHEETS = []; openSheet = (html, o) => { SHEETS.push({ html, title: o && o.title, wide: !!(o && o.wide) }); return { addEventListener() {}, querySelector: () => null }; }; load = async () => {}; renderWallets = () => {}');
  return { run, out: <T = unknown>(code: string): T => JSON.parse(run<string>(`JSON.stringify(${code})`)) as T, set: (name: string, v: unknown) => run(`${name} = ${JSON.stringify(v)}`), el: (id: string) => kept[id] ?? {} };
}

const OWNER = 'Object.defineProperty(Owner, "role", { get: () => "owner", configurable: true })';
const LOOKER = 'Object.defineProperty(Owner, "role", { get: () => "pending", configurable: true })';
const RULES = {
  rows: [
    { door: "Place or enlarge an order", guard: "Waits on a card", beast: "At once" },
    { door: "Cancel its own order", guard: "At once, never a card", beast: "At once, never a card" },
    { door: "Pay from its agent wallet", guard: "Waits on a card", beast: "At once for a payee it paid before; the first payment to a payee still waits on a card, unless its limit says any payee" },
  ],
  cardMinutes: 30,
};
const account = (extra: Record<string, unknown> = {}) => ({ now: "2026-10-06T17:00:00.000Z", mode: "guard", liveUsd: 1000, venues: [{ id: "ex", name: "Exchange", live: true, usd: 1000, holdings: [], trade: { can: true, kinds: ["spot"] } }], keys: [], spend: [], cards: [], asks: [], orders: [], payments: [], intents: [], watch: [], requests: [], subAccounts: [], signers: { owners: [], pendingDevices: [], threshold: 1 }, connectLive: { writes: { on: true, capUsd: 250 }, options: [] }, dial: { sessionExpiresAt: "2026-11-05T00:00:00.000Z", sessionEnded: false, maxLeverage: 1 }, health: {}, modeRules: RULES, ...extra });

describe("the Mode sheet", () => {
  it("is the switch, one sentence, and the doors' table from the account with the mode in force lit and tagged Now; the foot says the cap and the minutes", () => {
    const p = page();
    p.run(OWNER);
    p.set("A", account());
    p.run("openMode()");
    expect(p.out("SHEETS")).toEqual([{ html: '<div id="mode-sheet"></div>', title: "Mode", wide: false }]);
    const body = String(p.el("mode-sheet").innerHTML);
    // the switch is the rail's own buttons, pressed as the account says, enabled for an owner
    expect(body).toContain('<button type="button" data-set-mode="guard" aria-pressed="true">Guard</button>');
    expect(body).toContain('<button type="button" data-set-mode="open" aria-pressed="false">Beast</button>');
    expect(body).toContain("Guard: what agents ask for waits for you on a card. Beast: inside the limits you signed, it goes at once. Guard is one click; Beast is signed.");
    expect(body).not.toContain("Only a browser that signs for you changes it.");
    // the table: the account's rows, in its words, the Guard column lit
    expect(body).toContain('<th scope="col">An agent, inside its limit</th><th scope="col" class="now">Guard <span class="tag up">Now</span></th><th scope="col">Beast</th>');
    expect(body.match(/<tr><td>/g)).toHaveLength(3);
    expect(body).toContain('<tr><td>Cancel its own order</td><td class="now">At once, never a card</td><td>At once, never a card</td></tr>');
    expect(body).toContain("the first payment to a payee still waits on a card, unless its limit says any payee");
    expect(body.match(/class="now"/g)).toHaveLength(4);
    expect(body).toContain("In both modes: anything over a limit is refused · your own actions are yours to sign, up to $250.00 each · a card nobody answers in 30 minutes expires.");
    // Beast in force: the other column lights, and the table is the same table
    p.set("A", account({ mode: "open" }));
    p.run("drawMode()");
    const beast = String(p.el("mode-sheet").innerHTML);
    expect(beast).toContain('<th scope="col">Guard</th><th scope="col" class="now">Beast <span class="tag up">Now</span></th>');
    expect(beast).toContain('data-set-mode="open" aria-pressed="true"');
    expect(beast).toContain('<tr><td>Place or enlarge an order</td><td>Waits on a card</td><td class="now">At once</td></tr>');
    expect(beast.match(/class="now"/g)).toHaveLength(4);
  });

  it("says what it cannot do: a browser that only looks gets the switch off; a read-only server, no cap; an account without rules, no table made up", () => {
    const p = page();
    p.run(LOOKER);
    p.set("A", account({ connectLive: { writes: { on: false }, options: [] }, modeRules: undefined }));
    p.run("openMode()");
    const body = String(p.el("mode-sheet").innerHTML);
    expect(body).toContain('data-set-mode="guard" aria-pressed="true" disabled');
    expect(body).toContain('data-set-mode="open" aria-pressed="false" disabled');
    expect(body).toContain("Only a browser that signs for you changes it.");
    expect(body).toContain('<p class="empty">The account did not say what each mode does.</p>');
    expect(body).toContain("In both modes: anything over a limit is refused · this server was started read-only, so nothing is placed or moved.");
    expect(body).not.toContain("$");
  });

  it("switches as the rail does: Guard is a free POST /api/mode said done only when the account took it; Beast is the owner's signature", async () => {
    const posts: Array<{ path: string; body: unknown }> = [];
    const p = page({ fetch: async (path, init) => { posts.push({ path, body: JSON.parse(init?.body ?? "{}") }); return { status: 200, statusText: "OK", ok: true, json: async () => ({ ok: true, mode: "guard" }) }; } });
    p.run(OWNER);
    p.set("A", account({ mode: "open" }));
    await p.run<Promise<void>>('setMode("guard")');
    expect(posts).toEqual([{ path: "/api/mode", body: { mode: "guard" } }]);
    expect(p.out("[said, flash]")).toEqual(["Guard: what agents ask for waits for you on a card.", ""]);
    p.run('var OWNED = []; own = async (d) => { OWNED.push(d); return { status: 200, body: { ok: true } }; }');
    p.set("A", account({ mode: "guard" }));
    await p.run<Promise<void>>('setMode("open")');
    expect(p.out("OWNED")).toEqual([{ type: "setPolicy", change: "mode", value: "open" }]);
    expect(posts).toHaveLength(1);
    // the mode the account already has, or a browser that only looks: nothing is sent
    await p.run<Promise<void>>('setMode("guard")');
    p.run(LOOKER);
    await p.run<Promise<void>>('setMode("open")');
    expect(posts).toHaveLength(1);
    expect(p.out("OWNED")).toHaveLength(1);
  });
});

describe("the chrome around the mode", () => {
  it("the Account's header (round 7, F5): Guard | Beast with a note and What changes to the sheet; the status pill says Trading on and the most a move may be, or Read-only; no '+ Trade', no Background", () => {
    expect(html).toMatch(/<div class="seg" role="group" aria-label="Mode" id="mode"><button type="button" data-set-mode="guard" aria-pressed="false">Guard<\/button><button type="button" data-set-mode="open" aria-pressed="false">Beast<\/button><\/div>\s*<button type="button" class="icon-btn" id="mode-more" aria-label="What changes between Guard and Beast"[^>]*>/);
    // the note under the Account's tabs says what the mode does with what agents ask for
    expect(html).toMatch(/<span class="note-s dim" id="mode-note"><\/span>/);
    for (const gone of ['id="rail-trade"', 'id="bg-label"', "data-set-theme", 'id="copy-setup"', 'id="open-menu"', 'id="i-menu"', "rail-trade"]) expect(html, gone).not.toContain(gone);
    const shell = source("ui/shell.js");
    expect(shell).toContain('$("mode-more").addEventListener("click", () => A && openMode());');
    expect(shell).not.toMatch(/openMenu|copy-setup|open-menu|rail-trade|data-set-theme|menu-list/);
    const p = page();
    p.run(OWNER);
    p.set("A", account());
    p.run("renderChrome(connected(), true)");
    expect(p.el("writes").innerHTML).toBe('<span class="pill up" title="Orders and moves go through only when you sign them, or inside a limit you gave an agent">Trading on · $250 a move</span>');
    expect(p.el("mode-note").textContent).toBe("What agents ask for waits for you on a card.");
    p.set("A", account({ mode: "open", connectLive: { writes: { on: false }, options: [] } }));
    p.run("renderChrome(connected(), true)");
    expect(p.el("writes").innerHTML).toBe('<span class="pill" title="Started with --read-only">Read-only</span>');
    expect(p.el("mode-note").textContent).toBe("Inside their limits, agents act at once.");
    // only the rail's link opens the sheet (the contract comment in core.js names it, so comments are left out of the count)
    const callers = scripts.map((s) => source(s).replace(/\/\*[\s\S]*?\*\//g, "")).join("\n").split("\n").filter((l) => /\bopenMode\(\)/.test(l) && !/^function openMode/.test(l));
    expect(callers).toEqual(['$("mode-more").addEventListener("click", () => A && openMode());']);
  });

  it("the top bar is the lens and the Statement, with the Account's header on its tabs (the mode, What changes, Settings) and the search on Markets' and Trade's; the Settings sheet is Trading · the agents' session and leverage · Background · Devices, with no Mode; the Agents sheet has the setup command and no Devices", () => {
    const top = html.slice(html.indexOf('<header class="topbar">'), html.indexOf("</header>"));
    expect([...top.matchAll(/<button\b[^>]*\bid="([^"]+)"/g)].map((m) => m[1])).toEqual(["lens", "mode-more", "open-settings", "open-statement"]);
    expect(top).toMatch(/<div class="acct-tools" data-only="account">/);
    expect(top).toMatch(/id="search-form"[^>]*data-only="trading"/);
    const p = page();
    p.run(OWNER);
    p.set("A", account());
    p.run("openSettings()");
    const settings = p.out<Array<{ html: string; title: string }>>("SHEETS")[0]!;
    expect(settings.title).toBe("Settings");
    expect(settings.html).not.toMatch(/<b>Mode<\/b>|set-mode/);
    expect(settings.html).toContain("<b>Trading</b>");
    expect(settings.html).toContain('<div id="dial"></div>');
    expect(settings.html).toContain("<b>Background</b>");
    expect(settings.html).toContain('<h3 class="h2" id="set-devices-h">Devices</h3><div id="devices"></div>');
    // the cap is said here, once
    expect(p.el("set-writes").textContent).toBe("On: an order or a move goes through only when you sign it, or inside a limit you gave an agent, and is worth up to $250.00 each (set when the account was started).");
    expect(String(p.el("set-theme").innerHTML)).toMatch(/data-v="cream" aria-pressed="true">Cream<\/button><button type="button" data-v="black" aria-pressed="false">Black<\/button>/);
    expect(String(p.el("dial").innerHTML)).toContain("Agents' session");
    // the agents' table itself is ui-agents.test's: here only the sheet around it
    p.run("renderAgents = () => {}; openAgents()");
    const agents = p.out<Array<{ html: string; title: string; wide: boolean }>>("SHEETS")[1]!;
    expect([agents.title, agents.wide]).toEqual(["Agents", true]);
    expect(agents.html).not.toContain('id="devices"');
    expect(agents.html).toContain('<h3 class="h2" id="agents-h">Agents</h3><div id="agents"></div>');
    expect(agents.html).toContain('<h3 class="h2" id="wallets-h">Agent wallets</h3><div id="wallets"></div>');
    expect(agents.html).toMatch(/<button type="button" class="btn btn-sm" id="agents-setup"><svg class="ico sm"[^>]*><use href="#i-copy"><\/use><\/svg>Copy agent setup command<\/button>/);
    expect(source("ui/agents-mount.js")).toContain('$("agents-setup").addEventListener("click", copySetup);');
    for (const f of ["ui/agents-mount.js", "ui/shell.js", "ui/core.js", "account.html"]) expect(source(f), f).not.toMatch(/Conservative|Aggressive/);
  });

  it("sheets and the drawer move in transform and opacity only — a sheet in 180 ms and out in 120, the drawer sliding in from the edge in 220 and out in 160 — not under reduced motion; the shell waits for the fade before clearing what a sheet showed", () => {
    const css = source("ui/shell.css");
    expect(css).toMatch(/#modal, #ask \{ opacity: 0; transform: translateY\(12px\) scale\(0\.98\); transition: transform 120ms [^;]*, opacity 120ms [^;]*, overlay 120ms allow-discrete, display 120ms allow-discrete; \}/);
    expect(css).toMatch(/#modal\[open\], #ask\[open\] \{ opacity: 1; transform: none; transition-property: transform, opacity; transition-duration: 180ms; transition-timing-function: cubic-bezier\(\.2, \.8, \.2, 1\); \}/);
    expect(css).toMatch(/#drawer \{ opacity: 0; transform: translateX\(100%\); transition: transform 160ms [^;]*, opacity 160ms [^;]*, overlay 160ms allow-discrete, display 160ms allow-discrete; \}/);
    expect(css).toMatch(/#drawer\[open\] \{ opacity: 1; transform: none; transition-property: transform, opacity; transition-duration: 220ms; transition-timing-function: cubic-bezier\(\.2, \.8, \.2, 1\); \}/);
    expect(css).toMatch(/@starting-style \{[\s\S]*#drawer\[open\] \{ opacity: 0; transform: translateX\(100%\); \}/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*#modal, #drawer, #ask, #modal::backdrop, #ask::backdrop \{ transition: none; \}/);
    // nothing animates a layout property
    for (const m of css.matchAll(/transition:([^;]*);/g)) expect(m[1], m[0]).not.toMatch(/\b(height|width|top|left|right|bottom|margin|padding|box-shadow)\b/);
    for (const m of css.matchAll(/@keyframes [\w-]+ \{([^}]*\}[^}]*)\}/g)) expect(m[1], m[0]).not.toMatch(/\b(height|width|top|left|margin|box-shadow)\s*:/);
    expect(css).not.toContain("#open-now");
    const shell = source("ui/shell.js");
    // the content stays until the longer of the two fades (the drawer's 160 ms) is over
    expect(shell).toContain("const FADE_MS = 200;");
    expect(shell).toMatch(/\$\("modal"\)\.addEventListener\("close", \(\) => \{\s*SHEET = null;[\s\S]*?setTimeout\(\(\) => \{\s*if \(\$\("modal"\)\.open\) return;\s*\$\("sheet"\)\.replaceChildren\(\);/);
  });
});
