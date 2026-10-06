/** The Agents sheet (ui/agents-mount.js), run as the page runs it — every page script in account.html's order, in one global scope — over a
 * stand-in browser that keeps what is drawn into the sheet: each agent's limits as the owner reads them, an earn limit among them, and the
 * control that ends only the earn limit, as the account would sign it. Nothing leaves the process. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createContext, runInContext, Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { malformed, type OwnerAction } from "../../src/portfolio/account/sign.ts";

const PUBLIC = fileURLToPath(new URL("../../src/portfolio/public/", import.meta.url));
const html = readFileSync(join(PUBLIC, "account.html"), "utf8");
const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1] ?? "");

/** the page's scripts in a stand-in browser: the sheet's table is one element that keeps its html; every other id is absent */
function page() {
  const element = (): Record<string, unknown> => ({ addEventListener() {}, removeAttribute() {}, setAttribute() {}, querySelectorAll: () => [], querySelector: () => null, classList: { add() {}, remove() {}, toggle() {} }, dataset: {}, style: {}, hidden: false, value: "", textContent: "", innerHTML: "" });
  const kept: Record<string, Record<string, unknown>> = {};
  let started = false;
  const sandbox: Record<string, unknown> = {
    document: { getElementById: (id: string) => (!started ? element() : id === "agents" ? (kept[id] ??= element()) : null), querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, body: element(), documentElement: { dataset: { theme: "cream" }, setAttribute() {} }, hidden: false, activeElement: null },
    location: { hash: "", origin: "http://127.0.0.1:4821" },
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
    fetch: () => new Promise(() => {}),
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
  for (const src of scripts) new Script(readFileSync(join(PUBLIC, src.replace(/^\//, "")), "utf8"), { filename: src }).runInContext(ctx);
  started = true;
  const run = <T = unknown>(code: string): T => runInContext(code, ctx) as T;
  return { run, sheet: () => String(kept.agents?.innerHTML ?? ""), set: (name: string, value: unknown) => run(`${name} = ${JSON.stringify(value)}`) };
}

const SAVER = "0x8cec51000000000000000000000000000000ea29";
const TRADER = "0x3a087530887bd175ccc38828ee3776e5b6ea1ac6";
const key = (address: string, name: string) => ({ address, name, code: name.slice(0, 2).toUpperCase(), status: "ok", validUntil: "2026-10-13T00:00:00.000Z", approvedAt: "2026-10-06T12:00:00.000Z" });
const limit = (agent: string, scope: string, allow: string[], per: number, budget: number, spent = 0) => ({ id: `spend-${scope}`, agent, scope, allow, perPaymentUsd: per, budgetUsd: budget, spentUsd: spent, reservedUsd: 0, windowHours: 0, validUntil: "2026-10-13T00:00:00.000Z", expired: false });
const account = (spend: unknown[]) => ({
  now: "2026-10-06T12:00:00.000Z",
  venues: [{ id: "ex", name: "Exchange", live: true, usd: 100, holdings: [], trade: { can: true, kinds: ["spot"] }, earn: { can: true, what: "Simple Earn" } }, { id: "wallet", name: "Wallet", live: true, usd: 50, holdings: [], trade: { can: true, kinds: ["token"] } }],
  keys: [key(SAVER, "Saver"), key(TRADER, "Claude Code")],
  spend,
  requests: [],
  cards: [],
  connectLive: { writes: { on: true, capUsd: 250 }, options: [] },
});

describe("the Agents sheet", () => {
  it("shows an earn limit like any other — where, each time, used of the budget, until when — and never calls an agent holding one limitless", () => {
    const p = page();
    p.set("A", account([limit(SAVER, "earn", ["ex", "wallet:8453:0xvault"], 200, 1000, 50), limit(TRADER, "trade", ["ex"], 25, 100), limit(TRADER, "earn", ["ex"], 10, 40)]));
    p.run("renderAgents(connected(), true)");
    const rows = p.sheet().split("<tr>").slice(1);
    const saver = rows.find((r) => r.includes("Saver"))!;
    expect(saver).not.toContain("No limit yet");
    expect(saver).toContain("$50.00 of $1,000.00 used · up to $200.00 each time");
    expect(saver).toContain("puts money to earn at Exchange, Wallet (8453:0xvault)");
    expect(saver).toContain(`data-end-earn="${SAVER}">End earn limit</button>`);
    // beside a trading limit, the earn limit says its own numbers
    const trader = rows.find((r) => r.includes("Claude Code"))!;
    expect(trader).toContain("trades at Exchange");
    expect(trader).toContain("puts money to earn at Exchange up to $10.00 each time ($0.00 of $40.00");
    // an agent with no limit of any kind is said to have none; a browser that only looks gets no control
    p.set("A", account([]));
    p.run("renderAgents(connected(), false)");
    expect(p.sheet()).toContain("No limit yet: it can do nothing");
    expect(p.sheet()).not.toContain("data-end-earn");
  });

  it("ends only the earn limit, as the account signs it: the same agent, kind and places, a budget of nothing", () => {
    const p = page();
    p.set("A", account([]));
    const draft = p.run<Record<string, unknown>>(`JSON.parse(JSON.stringify(endLimitDraft(${JSON.stringify(limit(SAVER, "earn", ["ex", "wallet:8453:0xvault"], 200, 1000))})))`);
    expect(draft).toMatchObject({ type: "approveSpend", agent: SAVER, scope: "earn", allow: "ex,wallet:8453:0xvault", perPayment: "0", budget: "0", windowHours: 0 });
    expect(malformed({ ...draft, nonce: 1 } as OwnerAction)).toBeNull();
  });
});
