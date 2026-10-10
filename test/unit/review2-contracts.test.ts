/** review2 · contracts lens: do the three faces agree — the HTTP routes, the MCP tools, the page, and the two documents.
 *
 * Static checks over the source and the docs (nothing is started). A check that fails today is written `it.fails`, the repo's way of
 * pinning a known gap (COOKBOOK §23): when the gap is closed the test goes red, and `it.fails` is turned into `it`. Each names the finding
 * in the review's REPORT.md (F-numbers) it pins. */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OWNER_TYPES } from "../../src/portfolio/account/sign.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const uniq = <T>(xs: Iterable<T>) => [...new Set(xs)].sort();
const matches = (text: string, re: RegExp, group = 1) => uniq([...text.matchAll(re)].map((m) => m[group] ?? ""));
const server = read("src/portfolio/server.ts");
const mcp = read("src/portfolio/mcp.ts");
const cookbook = read("COOKBOOK.md");
const readme = read("README.md");
const UI = "src/portfolio/public/ui";
const pageScripts = readdirSync(join(ROOT, UI)).filter((f) => f.endsWith(".js")).map((f) => read(`${UI}/${f}`)).join("\n");

/** the route list in server.ts's header comment, and the routes express registers */
const headerRoutes = () => {
  const header = server.slice(0, server.indexOf("*/"));
  // a line may name two: "POST /api/revoke {account} · POST /api/restore {account}"
  return matches(header, /(?:GET|POST)\s+(\/api\/[A-Za-z0-9/_-]+)/g);
};
const registeredRoutes = () => matches(server, /app\.(?:get|post)\("(\/api\/[^"]+)"/g);

describe("HTTP routes: the header comment and what is registered", () => {
  it("every route the header comment lists is registered", () => {
    const registered = new Set(registeredRoutes());
    expect(headerRoutes().filter((r) => !registered.has(r))).toEqual([]);
  });
  // F6 (fixed in the service round): statement, compare, exchanges, keyfile, wallet/challenge, wallet/prove, signin/*, bridge-routes,
  // live/order-sent, live/order-requote, live/sent are in the header
  it("every /api route registered is in the header comment (F6)", () => {
    const listed = new Set(headerRoutes());
    expect(registeredRoutes().filter((r) => !listed.has(r))).toEqual([]);
  });
});

describe("MCP tools: the header comment, the registry, the docs", () => {
  const registered = matches(mcp, /registerTool\(\s*"(portfolio_[a-z_]+)"/g);
  const header = matches(mcp.slice(0, mcp.indexOf("*/")), /(portfolio_[a-z_]+)/g);
  // F7 (fixed in the service round): the header names live_amend · live_positions · live_close · live_leverage · wait · statement, and files
  // only the tools of the simulation under --classic
  it("the header comment names every registered tool (F7)", () => {
    expect(registered.filter((t) => !header.includes(t))).toEqual([]);
  });
  it("every tool README and COOKBOOK name is registered, and README names every tool", () => {
    const inDocs = matches(`${readme}\n${cookbook}`, /(portfolio_[a-z_]+)/g);
    expect(inDocs.filter((t) => !registered.includes(t))).toEqual([]);
    const inReadme = matches(readme, /(portfolio_[a-z_]+)/g);
    expect(registered.filter((t) => !inReadme.includes(t))).toEqual([]);
  });
  it("a tool the header files under --classic is not one that refuses without the account layer (F7)", () => {
    const classic = mcp.slice(mcp.indexOf("On the simulated statement (--classic)"), mcp.indexOf("*/"));
    const underClassic = matches(classic, /(portfolio_[a-z_]+)/g);
    // portfolio_transfer and portfolio_pay answer "this service runs without the account layer (--classic)" and stop
    const refusing = underClassic.filter((t) => {
      const at = mcp.indexOf(`"${t}"`);
      const body = mcp.slice(at, mcp.indexOf("server.registerTool", at + 1));
      return /if \(!\(await layer\(\)\)\) return text\(\{ ok: false, error: "this service runs without the account layer/.test(body);
    });
    expect(refusing).toEqual([]);
  });
});

describe("the page against the door and /api/account", () => {
  it("every draft type the page signs is an owner action", () => {
    const drafts = matches(pageScripts, /type:\s*"([a-zA-Z]+)"/g).filter((t) => t !== "Kind");
    expect(drafts.filter((t) => !(OWNER_TYPES as readonly string[]).includes(t))).toEqual([]);
  });
  it("every A.<field> the page reads is a field of /api/account", () => {
    const exchange = read("src/portfolio/account/exchange.ts");
    const iface = exchange.slice(exchange.indexOf("export interface AccountPage {"));
    const body = iface.slice(0, iface.indexOf("\n}\n"));
    // beside the page object: the dial, the venues' health, the agents' memories waiting for the owner (service.ts memoryAsks), the agent
    // setup command, and the lists the door accepts (server.ts DOOR_LISTS)
    const sent = new Set([...matches(body, /^  ([a-zA-Z]+)\??:/gm), "ok", "mode", "live", "dial", "health", "memoryAsks", "agentSetup", "dollars", "networks", "bridgeChains"]);
    const readByPage = matches(pageScripts, /\bA\.([a-zA-Z_]+)/g);
    expect(readByPage.filter((f) => !sent.has(f))).toEqual([]);
  });
  it("every api() path the page reads is a registered GET route", () => {
    const gets = new Set(matches(server, /app\.get\("(\/api\/[^"]+)"/g));
    const paths = uniq([...pageScripts.matchAll(/api\(\s*[`"'](\/api\/[a-zA-Z0-9/_-]+)/g)].map((m) => m[1] ?? ""));
    expect(paths.filter((p) => !gets.has(p))).toEqual([]);
  });
});

describe("refusal codes: what the real account raises and what the COOKBOOK table explains", () => {
  const table = cookbook.slice(cookbook.indexOf("## 拒绝码速查"));
  const explained = new Set(matches(table, /(E_[A-Z0-9_]+)/g));
  /** the modules a real account's owner or agent meets: the door, the three live doors, the reads, the server, the seat */
  const files = ["src/portfolio/account/exchange.ts", "src/portfolio/account/state.ts", "src/portfolio/account/live-orders.ts", "src/portfolio/account/live-moves.ts", "src/portfolio/account/live-earn.ts", "src/portfolio/account/restore.ts", "src/portfolio/account/pay-real.ts", "src/portfolio/service.ts", "src/portfolio/server.ts", "src/portfolio/mcp.ts", ...readdirSync(join(ROOT, "src/portfolio/live")).filter((f) => f.endsWith(".ts")).map((f) => `src/portfolio/live/${f}`)];
  const raised = uniq(files.flatMap((f) => matches(read(f), /no\("(E_[A-Z0-9_]+)"/g)));
  it("every code in the table is a code of core/errors.ts", () => {
    const known = new Set(matches(read("src/core/errors.ts"), /(E_[A-Z0-9_]+)/g));
    expect([...explained].filter((c) => !known.has(c))).toEqual([]);
  });
  // F8: E_CARD_NOT_GRANTED · E_CARD_REJECTED · E_VENUE_BAD_SIGNER · E_VENUE_CURRENCY · E_WALLET_ACCOUNT_UNKNOWN · E_WALLET_REACH · E_WALLET_UNKNOWN_VENUE
  // were missing from the COOKBOOK's table once; the table now names every code the real account raises
  it("every code the real account can raise is in the table (F8)", () => {
    expect(raised.filter((c) => !explained.has(c))).toEqual([]);
  });
});

describe("the docs' flags and scripts exist", () => {
  it("every --flag the COOKBOOK's 怎么跑 table and §11c name is read by the server or the stand-in", () => {
    const standin = read("test/standin/ui-standin.ts");
    const parsed = new Set([...matches(server, /(?:at\("|includes\(")(--[a-z-]+)"/g), ...matches(standin, /(?:at\("|includes\(")(--[a-z-]+)"/g)]);
    const run = cookbook.slice(cookbook.indexOf("## 0 · 怎么跑"), cookbook.indexOf("## 1 ·"));
    const standinDoc = cookbook.slice(cookbook.indexOf("## 11c"), cookbook.indexOf("# 下半"));
    const named = matches(`${run}\n${standinDoc}`, /(--(?:port|home|read-only|live-cap|classic|fresh|cap|tick|mm))\b/g);
    expect(named.filter((f) => !parsed.has(f))).toEqual([]);
  });
  it("every npm script the docs run is in package.json", () => {
    const scripts = Object.keys((JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts);
    const named = matches(`${readme}\n${cookbook}`, /npm run ([a-z:-]+)/g);
    expect(named.filter((s) => !scripts.includes(s))).toEqual([]);
  });
  // F15: README and COOKBOOK count the attack files; the count once said 26 when the folder held 29
  it("the attack folder has as many files as the docs say (F15)", () => {
    const n = readdirSync(join(ROOT, "test/attack")).filter((f) => f.endsWith(".test.ts")).length;
    expect(/二十六个文件/.test(cookbook) && /二十六个文件/.test(readme) ? 26 : n).toBe(n);
  });
});
