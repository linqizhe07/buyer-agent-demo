import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext, Script, type Context } from "node:vm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPortfolioServer, type PortfolioServerHandle } from "../../src/portfolio/server.ts";
import { PortfolioService } from "../../src/portfolio/service.ts";

/** The account page is plain scripts that share one global scope: owner.js, then ui/*.js in the order account.html names them. Each file
 * the page names is served with its type, nothing else under /ui/ is, every name is declared once across them all, they run in that order
 * as a browser would run them, the shell's contract (ui/core.js) is there for the panes to draw with, and none of them asks with the
 * browser's own prompt, confirm or alert boxes */
const PUBLIC = fileURLToPath(new URL("../../src/portfolio/public/", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "page-scripts-"));
let srv: PortfolioServerHandle;
let html = "";

beforeAll(async () => {
  const svc = await PortfolioService.create({ home, venues: "frontline", real: true, liveDeps: { http: async () => ({ status: 599, body: undefined, text: "" }), price: async () => undefined } });
  srv = await startPortfolioServer({ port: 0, service: svc, snapshotMs: 0 });
  html = await fetch(`${srv.url}/`).then((r) => r.text());
});
afterAll(async () => {
  await srv?.close();
  rmSync(home, { recursive: true, force: true });
});

/** what the page names, in its order: its scripts and its stylesheets, as files (the server names each with its content's hash, ?v=…, so a
 * browser keeps it a year); the face it preloads is its own too (public/fonts), named apart */
const unversioned = (u: string) => u.replace(/\?v=[0-9a-f]{16}$/, "");
const scripts = () => [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => unversioned(m[1] ?? ""));
const styles = () => [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"/g)].map((m) => unversioned(m[1] ?? "")).filter((h) => h.startsWith("/"));
const source = (src: string) => readFileSync(join(PUBLIC, src.replace(/^\//, "")), "utf8");
/** the files this shell's builder owns: the page, the contract, the shell, the statement, the agents' mount point */
const SHELL = ["account.html", "ui/core.js", "ui/shell.js", "ui/statement.js", "ui/agents-mount.js"];

/** a GET sent exactly as written: fetch would make "/ui/../server.ts" into "/server.ts" before it left */
const raw = (path: string) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const u = new URL(srv.url);
    const req = request({ host: u.hostname, port: u.port, path, method: "GET" }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });

/** a stand-in for the browser, enough for the scripts to load: every element is one that takes listeners and reports nothing; the device
 * key is asked for and never answers (indexedDB.open returns no request that fires), so nothing is fetched or drawn after the start */
function browser(opts: { fetch?: (path: string) => Promise<unknown> } = {}) {
  const opened: string[] = [];
  const stored: string[] = [];
  const element = (): Record<string, unknown> => ({ addEventListener() {}, removeAttribute() {}, setAttribute() {}, querySelectorAll: () => [], querySelector: () => null, classList: { add() {}, remove() {}, toggle() {} }, dataset: {}, style: {}, hidden: false, value: "", textContent: "", innerHTML: "" });
  const sandbox: Record<string, unknown> = {
    document: { getElementById: element, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, body: element(), documentElement: { dataset: { theme: "cream" }, setAttribute() {} }, hidden: false, activeElement: null },
    location: { hash: "", origin: "http://127.0.0.1:4820" },
    history: { replaceState() {} },
    localStorage: {
      getItem: () => null,
      setItem: (k: string) => {
        stored.push(k);
        throw new Error("storage is off in this window");
      },
    },
    MutationObserver: class {
      observe() {}
    },
    Event: class {
      constructor(readonly type: string) {}
    },
    addEventListener() {},
    dispatchEvent: () => true,
    scrollTo() {},
    indexedDB: { open: (name: string) => (opened.push(name), {}) },
    fetch: opts.fetch ? (path: string) => opts.fetch!(path) : () => new Promise(() => {}),
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
  const files = scripts().map((src) => ({ src, text: source(src) }));
  for (const f of files) new Script(f.text, { filename: f.src }).runInContext(ctx);
  return { ctx, opened, stored, run: (code: string) => runInContext(code, ctx) as unknown };
}

describe("the account page's scripts", () => {
  it("serves every script and stylesheet the page names, as the file it is and with its type; every script in ui/ is named once, core first and shell last", async () => {
    const named = scripts();
    expect(named[0]).toBe("/owner.js");
    expect(named[1]).toBe("/ui/core.js");
    expect(named[named.length - 1]).toBe("/ui/shell.js");
    expect(new Set(named).size).toBe(named.length);
    const onDisk = readdirSync(join(PUBLIC, "ui")).filter((f) => f.endsWith(".js")).map((f) => `/ui/${f}`);
    expect(named.filter((s) => s.startsWith("/ui/")).sort()).toEqual(onDisk.sort());
    // the order the contract names: what moves money and what connects before the panes that use it, the statement and the agents' mount
    // point after them, the shell last
    expect(named).toEqual(["/owner.js", "/ui/core.js", "/ui/connect.js", "/ui/money.js", "/ui/asset.js", "/ui/intent.js", "/ui/portfolio.js", "/ui/earn.js", "/ui/markets.js", "/ui/trade.js", "/ui/statement.js", "/ui/agents-mount.js", "/ui/shell.js"]);
    // each ui script waits for the page to be parsed and runs in the order named
    for (const m of html.matchAll(/<script\b([^>]*)\bsrc="(\/ui\/[^"]+)"/g)) expect(m[1], m[2] ?? "").toMatch(/\bdefer\b/);
    // the tokens first (both backgrounds), then the shell, then what the earlier renderers still draw; the classic page's sheet is not needed
    expect(styles()).toEqual(["/ui/tokens.css", "/ui/shell.css", "/account.css", "/ui/portfolio.css", "/ui/markets.css", "/ui/trade.css"]);
    for (const path of [...named, ...styles()]) {
      const r = await fetch(`${srv.url}${path}`);
      expect(r.status, path).toBe(200);
      expect(r.headers.get("content-type"), path).toMatch(path.endsWith(".css") ? /^text\/css\b/ : /^application\/javascript\b/);
      expect(await r.text(), path).toBe(source(path));
      // the page names it with its content's hash: asked for so, it is kept a year as it is; the browser that asks gets it compressed
      const hash = createHash("sha256").update(readFileSync(join(PUBLIC, path.slice(1)))).digest("hex").slice(0, 16);
      expect(html, path).toContain(`"${path}?v=${hash}"`);
      const kept = await fetch(`${srv.url}${path}?v=${hash}`, { headers: { "accept-encoding": "br, gzip" } });
      expect(kept.headers.get("cache-control"), path).toBe("public, max-age=31536000, immutable");
      expect(kept.headers.get("content-encoding"), path).toBe(statSync(join(PUBLIC, path.slice(1))).size >= 1024 ? "br" : null);
      expect(await kept.text(), path).toBe(source(path));
    }
    // the page's face is its own: preloaded before the first paint, served from here and kept a year (no font is asked of another host)
    const preload = [...html.matchAll(/<link\b[^>]*\brel="preload"[^>]*\bhref="([^"]+)"/g)].map((m) => m[1] ?? "");
    expect(preload).toEqual(["/fonts/manrope-v20-latin.woff2"]);
    const font = await fetch(`${srv.url}${preload[0]}`);
    expect([font.status, font.headers.get("content-type"), font.headers.get("cache-control")]).toEqual([200, "font/woff2", "public, max-age=31536000, immutable"]);
    expect(html).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    for (const path of ["/fonts/../server.ts", "/fonts/OFL.txt", "/fonts/nope.woff2"]) expect((await raw(path)).status, path).toBe(404);
  });

  it("answers nothing else under /ui/: no folder, no second dot, nothing encoded, no other kind of file, nothing that is not there", async () => {
    for (const path of ["/ui/..%2Fserver.ts", "/ui/a.ts", "/ui/x/y.js", "/ui/../server.ts", "/ui/%2e%2e%2fserver.ts", "/ui/..%2f..%2fserver.ts", "/ui/%2E%2E/server.ts", "/ui/core%2ejs", "/ui/core.js%00.ts", "/ui/Core.js", "/ui/core.min.js", "/ui/core.js/", "/ui/core.ts", "/ui/nothing-here.js", "/ui/nothing-here.css", "/ui/tokens.css.map", "/ui/", "/ui", "/account.js"]) {
      const r = await raw(path);
      expect(r.status, path).toBe(404);
      expect(r.body, path).not.toMatch(/startPortfolioServer|function render\(/);
    }
  });

  it("is the desktop shell: a rail with Portfolio · Markets · Trade, a top bar, three panes, one sheet, a drawer, an asking dialog, toasts that speak, and the background set before the first paint", () => {
    // the background is read before any stylesheet, in a guarded read: a window with storage off still paints Cream
    const head = html.slice(0, html.indexOf("</head>"));
    expect(head.indexOf('localStorage.getItem("account.theme")')).toBeGreaterThan(0);
    expect(head.indexOf('localStorage.getItem("account.theme")')).toBeLessThan(head.indexOf("/ui/tokens.css"));
    expect(head).toMatch(/try\s*\{[^}]*localStorage/);
    for (const tab of ["portfolio", "markets", "trade"]) {
      expect(html, tab).toMatch(new RegExp(`<section class="pane" data-pane="${tab}"[^>]*>[\\s\\S]*?<div id="pane-${tab}">`));
      expect(html, tab).toMatch(new RegExp(`<a href="#/${tab}" data-tab="${tab}">`));
    }
    for (const id of ["lens", "lens-menu", "search", "open-statement", "open-agents", "open-settings", "mode", "mode-note", "mode-more", "banner", "restored", "modal", "sheet", "modal-form", "drawer", "ask"]) expect(html, id).toContain(`id="${id}"`);
    // the IA round took the "+ Trade" pill (the nav item and the t key are the way), the ⧉ and the ≡ Menu off the chrome
    for (const gone of ["rail-trade", "copy-setup", "open-menu"]) expect(html, gone).not.toContain(`id="${gone}"`);
    expect(html).toMatch(/<dialog id="modal"><div id="sheet"><\/div><form method="dialog" id="modal-form"><\/form><\/dialog>/);
    expect(html).toMatch(/<div id="toasts" role="status" aria-live="polite"><\/div><div id="alerts" role="alert"/);
    // the search lives in the page, so a refresh neither freezes nor wipes it
    expect(html).toMatch(/<form class="search" id="search-form" role="search" data-live>/);
    // the mode at the rail's foot (Guard | Beast; the wire values stay guard | open); the background is a Settings matter, drawn there
    expect(html).not.toContain("data-set-theme");
    expect(html).toContain('data-set-mode="guard"');
    expect(html).toContain('data-set-mode="open"');
  });

  it("draws every icon it names from its own sprite: no outside logo, no icon missing", () => {
    const sprite = new Set([...html.matchAll(/<symbol id="i-([a-z-]+)"/g)].map((m) => m[1]));
    const used = new Set([...[...html.matchAll(/href="#i-([a-z-]+)"/g)].map((m) => m[1]), ...readdirSync(join(PUBLIC, "ui")).filter((f) => f.endsWith(".js")).flatMap((f) => [...source(`ui/${f}`).matchAll(/\bicon\("([a-z-]+)"/g)].map((m) => m[1]))]);
    expect([...used].filter((n) => !sprite.has(n))).toEqual([]);
    expect(html).not.toMatch(/<img\b[^>]*src="https?:/);
  });

  it("declares every name once: joined in the page's order they compile as one script, and each runs in turn in one global scope as a browser runs them", () => {
    const files = scripts().map((src) => ({ src, text: source(src) }));
    // two `const`s of one name, or a `const` and a function, in one script is a SyntaxError
    expect(() => new Script(files.map((f) => f.text).join("\n;\n"), { filename: "account-page.js" })).not.toThrow();
    // two top-level functions of one name are not: the later would replace the earlier without a word
    const names = files.flatMap((f) => [...f.text.matchAll(/^(?:async\s+)?function\s*\*?\s*([\w$]+)|^(?:const|let|var|class)\s+([\w$]+)/gm)].map((m) => m[1] ?? m[2]));
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);

    // what a script touches as it loads: the elements it hangs listeners on, the wallets' announcement, the route, the background (whose
    // storage may be off) and — from shell.js, last — the device key, which is asked for and never answers here, so nothing is fetched or drawn
    const b = browser();
    expect(b.opened).toEqual(["buyer-agent-owner"]);
    expect(b.stored).toEqual(["account.theme"]);
    // the shell and the contract it gives the panes
    const contract = ["render", "load", "own", "cancelOrder", "api", "forget", "refusalOf", "toast", "openSheet", "closeSheet", "openDrawer", "closeDrawer", "confirmSheet", "pickSheet", "whatYouSign", "quoteDialog", "paint", "go", "onRoute", "routed", "lensNow", "inLens", "chg", "avatar", "icon", "table", "seg", "field", "select", "formFields", "setOptions", "debounce", "thenLoad", "download", "copyText", "esc", "money", "fine", "px", "usd", "cents", "short", "qtyOf", "typeText", "isLive", "byOf", "readOnlyWords", "owns", "writesOn", "canTrade", "canMove", "isAgentWallet", "modeOf", "dollarsOf", "isDollar", "networksOf", "bridgeChainsOf", "walletFor", "mined"];
    const mine = ["openStatement", "renderStatement", "openAgents", "openSettings", "openMode", "renderAgents", "renderDevices", "renderDial", "setMode", "setTheme", "copySetup", "downloadBalances", "lensMenu", "drawPane"];
    // what the other parts already define, and the shell calls
    const there = ["openPicker", "openConnect", "connectVia", "keyHowFor", "openLiveMove", "openAmend", "renderWallets", "openClose", "declineAsk"];
    const all = [...contract, ...mine, ...there];
    expect(b.run(`[${all.join(", ")}].map((f) => typeof f)`), all.join(" ")).toEqual(Array(all.length).fill("function"));
    // what the panes are to define: a function when it is there, and nothing else under that name
    const panes = ["renderPortfolio", "renderMarkets", "renderTrade", "openTicket", "openHandToAgent", "openReceive", "openAsset", "openMarket"];
    for (const p of panes) expect(["function", "undefined"], p).toContain(b.run(`typeof ${p}`));
    expect(b.run("[A, busy, flash, said, S.length, ROUTE.tab, view.lens]")).toEqual([null, false, "", "", 0, "portfolio", ""]);
  });

  it("gives the panes helpers that say up and down without colour alone, tables, toggles and the route, each as written in the contract", () => {
    const b = browser();
    const r = (code: string) => b.run(code);
    // a change: ▲ up / ▼ down, a word for a screen reader, the amount; nothing known is a dash
    expect(r('chg(2.14)')).toBe('<span class="up"><span aria-hidden="true">▲</span><span class="sr">up</span> 2.1%</span>');
    expect(r('chg(-0.6)')).toBe('<span class="down"><span aria-hidden="true">▼</span><span class="sr">down</span> 0.60%</span>');
    expect(r('chg(-38.2, "$")')).toContain("▼</span><span class=\"sr\">down</span> $38.20");
    expect(r('chg(3, "¢")')).toContain("▲</span><span class=\"sr\">up</span> 3¢");
    expect(r("chg(undefined)")).toBe('<span class="flat">—</span>');
    expect(r("chg(0)")).toBe('<span class="flat">0.00%</span>');
    // a letter tile, escaped; a table with its header and an empty table's words
    expect(r('avatar("usdc")')).toBe('<span class="av" aria-hidden="true">USDC</span>');
    expect(r('avatar("<b>")')).toBe('<span class="av" aria-hidden="true">B</span>');
    const t = String(r('table([{ label: "Asset", cell: (x) => esc(x.a) }, { label: "Value", r: true, cell: (x) => money(x.v) }, { cell: () => "" }], [{ a: "BTC<", v: 5 }], { rowAttr: () => \'class="click"\' })'));
    expect(t).toContain('<th scope="col">Asset</th><th scope="col" class="r">Value</th><th scope="col"><span class="sr">Actions</span></th>');
    expect(t).toContain('<tr class="click"><td>BTC&lt;</td><td class="r">$5.00</td><td></td></tr>');
    expect(r('table([{ label: "A", cell: () => "" }], [], { empty: "Nothing held." })')).toBe('<p class="empty">Nothing held.</p>');
    // a toggle: the pressed one says so; what pressing another does is kept by its id
    const s = String(r('seg([["1d", "1D"], ["1w", "1W"]], "1w", () => {}, { label: "Range" })'));
    expect(s).toMatch(/^<div class="seg" role="group" aria-label="Range" data-seg="seg-\d+"><button type="button" data-v="1d" aria-pressed="false">1D<\/button><button type="button" data-v="1w" aria-pressed="true">1W<\/button><\/div>$/);
    expect(r(`SEGS.has(${JSON.stringify(/data-seg="([^"]+)"/.exec(s)?.[1])})`)).toBe(true);
    // what the owner signs, as the device key signs it
    expect(r('whatYouSign({ shown: [{ name: "venue", value: "okx" }, { name: "symbol", value: "BTC/USDT" }] })')).toBe('<details class="signs"><summary>What you sign</summary><pre>venue: okx\nsymbol: BTC/USDT</pre></details>');
    expect(r("whatYouSign(null)")).toBe("");
    // the route: the hash names the tab and what it shows; anything else is the Portfolio
    expect(r('JSON.stringify(routeOf("#/markets?tab=crypto&q=btc"))')).toBe('{"tab":"markets","params":{"tab":"crypto","q":"btc"}}');
    expect(r('routeOf("#/nowhere").tab')).toBe("portfolio");
    expect(r('routeOf("").tab')).toBe("portfolio");
    expect(r('hashOf("trade", { tile: "swap", q: "" })')).toBe("#/trade?tile=swap");
    // before the account is read, the lens is every account and every row is in it
    expect(r('JSON.stringify(lensNow())')).toBe('{"kind":"all","id":"","name":"All accounts"}');
    expect(r('inLens("okx", "0xabc")')).toBe(true);
    expect(r('esc(`<a href="x" title=\'y\'>&`)')).toBe("&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;");
  });

  it("asks the account once for a read that is already on its way, keeps it as long as asked, and keeps nothing that never arrived", async () => {
    const asked: string[] = [];
    let fail = false;
    const b = browser({
      fetch: async (path) => {
        asked.push(path);
        if (fail) throw new Error("connection refused");
        return { status: 200, statusText: "OK", json: async () => ({ ok: true, path, n: asked.length }) };
      },
    });
    const ctx: Context = b.ctx;
    const api = (path: string, ttl?: number) => runInContext(`api(${JSON.stringify(path)}${ttl ? `, { ttl: ${ttl} }` : ""})`, ctx) as Promise<{ ok: boolean; n?: number; error?: string }>;
    const [one, two] = await Promise.all([api("/api/account/holdings"), api("/api/account/holdings")]);
    expect(asked).toEqual(["/api/account/holdings"]);
    expect(one).toEqual(two);
    // kept: asked again within its ttl, it is not fetched again; without a ttl it is
    expect((await api("/api/account/holdings", 60_000)).n).toBe(1);
    expect((await api("/api/account/holdings")).n).toBe(2);
    // a request that never reached the account is an answer of its own, not kept
    fail = true;
    expect(await api("/api/account/explore", 60_000)).toEqual({ ok: false, error: "connection refused" });
    fail = false;
    expect((await api("/api/account/explore", 60_000)).ok).toBe(true);
    expect(runInContext('refusalOf({ ok: false, refusal: { message: "OKX: this key cannot trade" } })', ctx)).toBe("OKX: this key cannot trade");
  });

  it("keeps nothing of the page as it was before its panes: no bridge to the earlier sections, none of their renderers, and no rule in account.css that nothing draws any more", () => {
    // all three panes draw themselves: the shell's bridge to the earlier sections, and what only it called, are gone
    expect(source("ui/shell.js")).not.toMatch(/\bEARLIER\b/);
    const b = browser();
    const gone = ["EARLIER", "renderLiquidity", "renderAlloc", "renderWaiting", "renderAccounts", "renderPositions", "openTrade", "tkClose", "tkConnectArgs"];
    expect(b.run(`[${gone.map((n) => `typeof ${n}`).join(", ")}]`), gone.join(" ")).toEqual(Array(gone.length).fill("undefined"));
    // every class and id account.css styles is one a script (or the page) still draws
    const css = source("account.css").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{[^}]*\}/g, " ");
    const drawn = [html, ...readdirSync(join(PUBLIC, "ui")).filter((f) => f.endsWith(".js")).map((f) => source(`ui/${f}`))].join("\n");
    const classes = new Set([...drawn.matchAll(/class="([^"]*)"/g)].flatMap((m) => (m[1] ?? "").split(/[^\w-]+/)).filter(Boolean));
    const ids = new Set([...drawn.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]));
    expect([...new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1] ?? ""))].filter((c) => !classes.has(c))).toEqual([]);
    expect([...new Set([...css.matchAll(/#([a-zA-Z][\w-]*)/g)].map((m) => m[1] ?? ""))].filter((i) => !ids.has(i))).toEqual([]);
  });

  it("copies the agent setup command the account gives — from the Agents sheet and the first steps alike — and the command run from its folder when it gives none", async () => {
    const b = browser();
    const copied: string[] = [];
    b.run("var COPIED = []; copyText = async (t) => { COPIED.push(t); }; var TOASTS = []; toast = (t) => TOASTS.push(t.html || t)");
    await b.run("copySetup()");
    b.run('A = { agentSetup: { command: "claude mcp add portfolio -e PORTFOLIO_URL=http://127.0.0.1:4820 -- npx tsx /Users/x/demo/src/portfolio/mcp.ts", url: "http://127.0.0.1:4820" } }');
    await b.run("copySetup()");
    copied.push(...(b.run("COPIED") as string[]));
    expect(copied).toEqual(["claude mcp add portfolio -e PORTFOLIO_URL=http://127.0.0.1:4820 -- npx tsx src/portfolio/mcp.ts", "claude mcp add portfolio -e PORTFOLIO_URL=http://127.0.0.1:4820 -- npx tsx /Users/x/demo/src/portfolio/mcp.ts"]);
    const said = b.run("TOASTS") as string[];
    expect(said[0]).toContain("Run it in this account's folder");
    expect(said[1]).toContain("Run it where your agent runs, then let the agent in under Agents.");
    // one copy, two places: the Agents sheet's button and the first steps' button both call it (the top bar's ⧉ and the menu are gone)
    expect(source("ui/agents-mount.js")).toContain('$("agents-setup").addEventListener("click", copySetup);');
    expect(source("ui/portfolio.js")).toContain("copySetup()");
    expect(source("ui/shell.js")).not.toContain("copy-setup");
  });

  it("asks nothing with the browser's own prompt, confirm or alert boxes: none in the shell's files, and the page as a whole adds none", () => {
    for (const f of SHELL) for (const fn of ["prompt", "confirm", "alert"]) expect((source(f).match(new RegExp(`\\b${fn}\\s*\\(`, "g")) ?? []).length, `${fn} in ${f}`).toBe(0);
    /* the last two — which account tops up an agent wallet (money.js) and closing a position (portfolio.js) — ask with pickSheet and
       confirmSheet now: none is left anywhere on the page */
    const ASKS_NOW: Record<string, number> = { prompt: 0, confirm: 0, alert: 0 };
    const page = [html, ...scripts().map(source)].join("\n");
    for (const [fn, most] of Object.entries(ASKS_NOW)) expect((page.match(new RegExp(`\\b${fn}\\s*\\(`, "g")) ?? []).length, fn).toBeLessThanOrEqual(most);
  });
});
