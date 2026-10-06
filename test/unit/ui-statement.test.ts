/** The Statement (ui/statement.js), run as the page runs it — every page script in account.html's order, in one global scope — over a
 * stand-in for the browser: money put into or taken out of an earn product is a line of its own kind beside trades and transfers, filtered,
 * added up and downloaded like them, and shown as it is (it stays the owner's, so it is neither money in nor money out); the Trade pane's
 * Recent fills stay trades only. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext, Script } from "node:vm";
import { describe, expect, it } from "vitest";

const PUBLIC = fileURLToPath(new URL("../../src/portfolio/public/", import.meta.url));
const html = readFileSync(join(PUBLIC, "account.html"), "utf8");
const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1] ?? "");

/** the page's scripts in a stand-in browser: elements take listeners and report nothing; the device key never answers, so nothing is drawn */
function page() {
  const element = (): Record<string, unknown> => ({ addEventListener() {}, removeAttribute() {}, setAttribute() {}, querySelectorAll: () => [], querySelector: () => null, classList: { add() {}, remove() {}, toggle() {} }, dataset: {}, style: {}, hidden: false, value: "", textContent: "", innerHTML: "" });
  const sandbox: Record<string, unknown> = {
    document: { getElementById: element, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, body: element(), documentElement: { dataset: { theme: "cream" }, setAttribute() {} }, hidden: false, activeElement: null },
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
  const run = <T = unknown>(code: string): T => runInContext(code, ctx) as T;
  const out = <T = unknown>(code: string): T => JSON.parse(run<string>(`JSON.stringify(${code})`)) as T;
  return { run, out, set: (name: string, value: unknown) => run(`${name} = ${JSON.stringify(value)}`) };
}

const AGENT = "0x3a087530887bd175ccc38828ee3776e5b6ea1ac6";
/* the lines as GET /api/account/statement gives them: a buy and a sell, a transfer, money into earn by an agent and out of earn by the owner,
   and a supply the venue refused */
const LINES = [
  { key: "o1", id: "ord-0001", at: "2026-10-05T14:00:00.000Z", updatedAt: "2026-10-05T14:00:01.000Z", type: "trade", kind: "buy", account: "ex", accountName: "Exchange", description: "Buy 0.01 BTC · market", amountUsd: -620, status: "filled", by: "You" },
  { key: "o2", id: "ord-0002", at: "2026-10-05T15:00:00.000Z", updatedAt: "2026-10-05T15:00:01.000Z", type: "trade", kind: "sell", account: "ex", accountName: "Exchange", description: "Sell 0.1 ETH · market", amountUsd: 230, status: "filled", by: "You" },
  { key: "p1", id: "pay-0001", at: "2026-10-05T16:00:00.000Z", updatedAt: "2026-10-05T16:05:00.000Z", type: "transfer", kind: "withdraw", account: "ex", accountName: "Exchange", to: "wallet", toName: "Wallet", description: "Withdraw 50 USDC · Base", amountUsd: 50, feeUsd: 0.5, status: "settled", by: "You" },
  { key: "earn:e1", id: "earn-0001", at: "2026-10-05T17:00:00.000Z", updatedAt: "2026-10-05T17:00:02.000Z", type: "earn", kind: "supply", account: "ex", accountName: "Exchange", description: "Supply 100 USDT · USDT Flexible · 5.2% APY", amountUsd: 100, status: "done", by: "Claude Code, inside its limit", agent: AGENT, agentName: "Claude Code", ref: "purchase:USDT:abc" },
  { key: "earn:e2", id: "earn-0002", at: "2026-10-05T18:00:00.000Z", updatedAt: "2026-10-05T18:00:02.000Z", type: "earn", kind: "withdraw", account: "ex", accountName: "Exchange", description: "Withdraw 40 USDT · USDT Flexible · back to Exchange", amountUsd: 40, status: "pending", by: "You" },
  { key: "earn:e3", id: "earn-0003", at: "2026-10-05T19:00:00.000Z", updatedAt: "2026-10-05T19:00:02.000Z", type: "earn", kind: "supply", account: "ex", accountName: "Exchange", description: "Supply 500 USDT · USDT Flexible", amountUsd: 500, status: "rejected", by: "You" },
];

describe("money into and out of earn, on the Statement", () => {
  it("is a kind of its own in the filter, offered once there is an earn line (or earn is what is shown)", () => {
    const p = page();
    expect(p.out("stmtKinds(" + JSON.stringify(LINES) + ")")).toEqual([["", "Trades, transfers and earn"], ["trade", "Trades"], ["transfer", "Transfers"], ["earn", "Earn"]]);
    const noEarn = LINES.filter((l) => l.type !== "earn");
    expect(p.out("stmtKinds(" + JSON.stringify(noEarn) + ")")).toEqual([["", "Trades and transfers"], ["trade", "Trades"], ["transfer", "Transfers"]]);
    expect(p.out("stmtKinds(" + JSON.stringify(noEarn) + ', "earn").map((x) => x[0])')).toEqual(["", "trade", "transfer", "earn"]);
  });

  it("adds up what went into earn and came out of it beside what was bought, sold and moved — never what the venue refused", () => {
    const p = page();
    expect(p.run(`stmtTotals(${JSON.stringify(LINES)})`)).toBe("6 transactions · bought $620.00 · sold $230.00 · moved $50.00 · into earn $100.00 · out of earn $40.00 · fees $0.50");
    expect(p.run(`stmtTotals(${JSON.stringify(LINES.filter((l) => l.type === "earn"))})`)).toBe("3 transactions · into earn $100.00 · out of earn $40.00");
  });

  it("shows an earn line's amount as it is (it stays the owner's), and its states in words", () => {
    const p = page();
    expect(p.out(`${JSON.stringify(LINES)}.map(amountOf)`)).toEqual(["−$620.00", "+$230.00", "$50.00", "$100.00", "$40.00", "$500.00"]);
    expect(p.out('["done", "pending", "rejected"].map((s) => ST[s])')).toEqual([["Done", "settled"], ["On the way", "pending"], ["Rejected", "failed"]]);
  });

  it("downloads earn lines in the CSV with the rest: their kind, product, amount, who and the venue's reference", () => {
    const p = page();
    const rows = p.out<string[][]>(`stmtCsv(${JSON.stringify(LINES)})`);
    expect(rows[0]).toEqual(["date", "id", "type", "kind", "account", "to", "description", "amount_usd", "fee_usd", "status", "by", "agent", "ref"]);
    expect(rows).toHaveLength(LINES.length + 1);
    expect(rows[4]).toEqual(["2026-10-05T17:00:00.000Z", "earn-0001", "earn", "supply", "Exchange", "", "Supply 100 USDT · USDT Flexible · 5.2% APY", 100, "", "done", "Claude Code, inside its limit", AGENT, "purchase:USDT:abc"]);
    // the filter and the CSV are one: the Statement downloads what it shows
    const src = readFileSync(join(PUBLIC, "ui/statement.js"), "utf8");
    expect(src).toContain('select("type", stmtKinds(S, view.type), view.type)');
    expect(src).toContain("stmtCsv(lines)");
  });

  it("leaves the Trade pane's Recent fills to trades: an earn line done is not a fill", () => {
    const p = page();
    p.set("A", { now: "2026-10-06T12:00:00.000Z", venues: [], keys: [] });
    p.set("S", LINES);
    p.run("var SEC = { hidden: true, innerHTML: '', querySelector: () => ({ addEventListener() {} }) }; tkDrawFills(SEC)");
    const drawn = p.run<string>("SEC.innerHTML");
    expect(drawn).toContain("Buy 0.01 BTC");
    expect(drawn).toContain("Sell 0.1 ETH");
    expect(drawn).not.toContain("USDT Flexible");
    expect(drawn).not.toContain("Withdraw 50 USDC");
  });
});
