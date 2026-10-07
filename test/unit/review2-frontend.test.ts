/** review2 · frontend lens — FAILING tests that pin down what the static review of src/portfolio/public found. Each `it` is one finding
 * (its F-number from the review's REPORT.md is in the name); the assertion says what the page should do, so the test goes green when the
 * finding is fixed. The page's scripts run as the page runs them — owner.js then ui/*.js in account.html's order, in one global scope —
 * over the same stand-in browser test/unit/page-scripts.test.ts uses. Nothing here reaches a network or a real venue. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createContext, runInContext, Script } from "node:vm";
import { describe, expect, it } from "vitest";

const PUBLIC = fileURLToPath(new URL("../../src/portfolio/public/", import.meta.url));
const html = readFileSync(join(PUBLIC, "account.html"), "utf8");
const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1] ?? "");
const source = (src: string) => readFileSync(join(PUBLIC, src.replace(/^\//, "")), "utf8");

/** the page's scripts in a stand-in browser: elements take listeners and report nothing; `fetch` is the caller's; the device key never answers */
function page(opts: { fetch?: (path: string, init?: { method?: string; body?: string }) => Promise<unknown> } = {}) {
  const element = (): Record<string, unknown> => ({ addEventListener() {}, removeAttribute() {}, setAttribute() {}, querySelectorAll: () => [], querySelector: () => null, classList: { add() {}, remove() {}, toggle() {} }, dataset: {}, style: {}, hidden: false, value: "", textContent: "", innerHTML: "" });
  const sandbox: Record<string, unknown> = {
    document: { getElementById: element, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, body: element(), documentElement: { dataset: { theme: "cream" }, setAttribute() {} }, hidden: false, activeElement: null },
    location: { hash: "", origin: "http://127.0.0.1:4861" },
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
  const run = <T = unknown>(code: string): T => runInContext(code, ctx) as T;
  return { run, out: <T = any>(code: string): T => JSON.parse(run<string>(`JSON.stringify(${code})`)) as T };
}

describe("review2 · frontend: the page's helpers and flows", () => {
  it("F1 · 'Require both' under Devices is offered only with a way to give the second signature: the page never sends cosignatures, and the door refuses an owner action signed below the threshold", () => {
    // agents-mount.js draws "Require both" (threshold = every signer); owner.js Owner.submit sends { action, nonce, signature } and nothing else;
    // exchange.ts take() refuses `signers.size < threshold` (E_ACCOUNT_THRESHOLD) — so after one click every owner action from the page, the
    // convertToMultiSigUser that would lower the threshold included, is refused: the owner is locked out of the page's owner actions
    const devices = source("ui/agents-mount.js");
    const owner = source("owner.js");
    const offersBoth = /data-both="1"/.test(devices);
    const canCosign = /cosignatures/.test(owner) || /cosignatures/.test(source("ui/core.js"));
    expect(!offersBoth || canCosign, "a 'Require both' the page cannot complete").toBe(true);
  });

  it("F2 · a CSV cell that starts with = + - @ is neutralised before it is saved (download(): balances and the statement)", () => {
    const p = page();
    // what a venue, an agent's note or a market name can put in a cell; a spreadsheet runs each as a formula when the file is opened
    for (const hostile of ['=HYPERLINK("http://x")', "+1+1", "-2+3", "@SUM(1)", "=cmd|' /C calc'!A0"]) {
      const cell = p.run<string>(`csvCell(${JSON.stringify(hostile)})`);
      // a guard is a leading apostrophe, a space or a tab (what spreadsheet exporters do), with the cell then quoted
      expect(cell, hostile).toMatch(/^"?['\t ]/);
    }
  });

  it("F3 · a prepare that never reaches the account (the service restarting) comes back as a refusal the sheets can show, not a rejection that leaves 'Asking…' on screen", async () => {
    const p = page({ fetch: async () => { throw new TypeError("Failed to fetch"); } });
    // Owner.prepare / Owner.submit / postJson are awaited in every ticket and sheet with only `r.status !== 200` handled
    const r = await p.run<Promise<{ status: number; body: { error?: string } }>>('Owner.prepare({ type: "setWatch", venue: "ex", symbol: "BTC/USDT", on: "true" })');
    expect(r.status).not.toBe(200);
    expect(typeof r.body).toBe("object");
    const j = await p.run<Promise<{ status: number }>>('postJson("/api/account/bridge-routes", {})');
    expect(j.status).not.toBe(200);
  });

  it("F4 · setMode('guard') says Guard only when the account took it: a refusal or a dead connection is shown, not announced as done", async () => {
    const p = page({ fetch: async () => ({ status: 503, statusText: "Service Unavailable", ok: false, json: async () => ({ ok: false, error: "the account is restarting" }) }) });
    p.run('A = { mode: "open", venues: [], keys: [], signers: { owners: [], pendingDevices: [] } }; Object.defineProperty(Owner, "role", { get: () => "owner", configurable: true }); load = async () => {}');
    await p.run<Promise<void>>('setMode("guard")');
    expect(p.run("said")).toBe("");
    expect(p.run("flash")).not.toBe("");
  });

  it("F5 · Revoke under Agents asks first: a one-click revoke of an agent key (tombstoned for good) is not an action the page takes without a yes", () => {
    const src = source("ui/agents-mount.js");
    const line = src.split("\n").find((l) => l.includes("button[data-revoke]")) ?? "";
    expect(line, "the revoke handler").toMatch(/confirmSheet/);
  });

  it("F6 · the connect dialog's key-file check stops when its form is replaced (back → another venue), not only when the dialog closes", () => {
    const src = source("ui/connect.js");
    // the interval is cleared on the dialog's close alone; a second openConnect over the same #modal-form leaves two checks writing one form
    const i = src.indexOf("const timer = setInterval(check, 2000);");
    expect(i).toBeGreaterThan(0);
    const after = src.slice(i, i + 400);
    expect(after).toMatch(/isConnected|modal-form|replaced|MutationObserver|clearInterval\(timer\)[\s\S]*(back|openPicker)/);
  });

  it("F7 · the Trade pane keeps the focused button through a refresh, as Markets (data-fk) and Portfolio (pfPut) do", () => {
    const src = source("ui/trade.js");
    // Under way is drawn on every render: a focused Change · Cancel · Review must not go to <body> every 20 s (Positions and Recent fills left the pane)
    for (const fn of ["function tkDrawOpen"]) {
      const body = src.slice(src.indexOf(fn), src.indexOf(fn) + 2600);
      expect(body, fn).toMatch(/activeElement|data-fk|PAINTED|=== html|!== html/);
    }
  });

  it("F8 · nyDay/nyTime say nothing (a dash) for a time that is not one, instead of throwing out of a whole sheet or drawer", () => {
    const p = page();
    for (const bad of ["undefined", '""', '"garbage"', "null"]) {
      expect(() => p.run(`nyDay(${bad})`), `nyDay(${bad})`).not.toThrow();
      expect(() => p.run(`nyTime(${bad})`), `nyTime(${bad})`).not.toThrow();
    }
  });

  it("F9 · money() puts the sign before the dollar: -$1,234.50, never $-1,234.50; fine() never shows $0.; nothing shows NaN", () => {
    const p = page();
    expect(p.run("money(-1234.5)")).toBe("-$1,234.50");
    expect(p.run("fine(-0.001)")).toBe("-$0.001");
    expect(p.run("fine(4e-7)")).not.toBe("$0.");
    expect(p.run("fine(4e-7)")).toMatch(/^\$\d/);
    // a string from a venue that is not a number is not "$NaN" on the page
    expect(p.run('money("abc")')).not.toContain("NaN");
    expect(p.run('px("abc")')).not.toBe("NaN");
    expect(p.run("qtyOf(undefined)")).not.toBe("NaN");
  });

  it("F10 · a cents price reads the same in Markets (mkCents) and on the ticket (tkCents): the figure clicked is the figure signed; a limit in cents is held to 0–100", () => {
    const p = page();
    // 62.5¢ is a real Polymarket price (0.1¢ ticks); Markets rounds it to 63¢, the ticket shows 62.5¢
    expect(p.run("mkCents(0.625)")).toBe(p.run("tkCents(0.625)"));
    expect(p.run("mkCents(0.995)")).toBe(p.run("tkCents(0.995)"));
    // a chance is never more than 100¢ or less than 0: a limit typed in cents is held to it before it is prepared
    expect(Number(p.run("tkPriceIn('150', true)"))).toBeLessThanOrEqual(1);
    expect(Number(p.run("tkPriceIn('-5', true)"))).toBeGreaterThanOrEqual(0);
  });

  it("F11 · api() keeps no answer that never came from the account: a gateway's non-JSON 5xx is not cached for the caller's ttl", async () => {
    let n = 0;
    const p = page({ fetch: async () => { n++; return { status: 502, statusText: "Bad Gateway", ok: false, json: async () => { throw new SyntaxError("not JSON"); } }; } });
    const first = await p.run<Promise<{ ok: boolean }>>('api("/api/account/holdings?cost=1", { ttl: 8000 })');
    expect(first.ok).toBe(false);
    await p.run<Promise<unknown>>('api("/api/account/holdings?cost=1", { ttl: 8000 })');
    // asked again within the ttl: the account is asked again, since the first answer was no answer
    expect(n).toBe(2);
  });
});
