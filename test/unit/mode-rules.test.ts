/** The mode rules (account/mode-rules.ts): what the Mode sheet and portfolio_account say Guard and Beast do with an agent's request, door by
 * door — held to the doors themselves where that can be read without a venue: their shape, the one card-expiry number (written once, the
 * doors' literals equal to it until they import it), and the words that must agree with the doors' code (a cancel is never a card; Guard is
 * a card wherever a door raises one; Beast goes at once, and says where it still raises a card). Nothing here reaches a venue. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CARD_TTL_MS as fromTheDoor } from "../../src/portfolio/account/exchange.ts";
import { CARD_TTL_MS, cardMinutes, MODE_RULES, modeRules } from "../../src/portfolio/account/mode-rules.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (p: string) => readFileSync(`${ROOT}${p}`, "utf8");

describe("the mode rules", () => {
  it("are rows with a door and both modes' words, each door once; the page gets a copy of its own", () => {
    expect(MODE_RULES.length).toBeGreaterThanOrEqual(9);
    for (const r of MODE_RULES) {
      for (const k of ["door", "guard", "beast"] as const) {
        expect(typeof r[k], `${r.door} · ${k}`).toBe("string");
        expect(r[k].trim().length, `${r.door} · ${k}`).toBeGreaterThan(0);
      }
    }
    expect(new Set(MODE_RULES.map((r) => r.door)).size).toBe(MODE_RULES.length);
    expect(modeRules()).toEqual({ rows: [...MODE_RULES], cardMinutes });
    const m = modeRules();
    m.rows.pop();
    expect(modeRules().rows).toHaveLength(MODE_RULES.length);
  });

  it("say what the doors do: a cancel is never a card; leverage with no position is at once; every other door is a card in Guard and at once in Beast, saying where Beast still raises one", () => {
    const byDoor = Object.fromEntries(MODE_RULES.map((r) => [r.door, r]));
    // live-orders.ts cancel(): "Never a card: taking an order off the book moves nothing"
    const cancel = MODE_RULES.find((r) => /cancel/i.test(r.door));
    expect(cancel).toBeDefined();
    expect(cancel!.guard).toMatch(/never a card/i);
    expect(cancel!.beast).toMatch(/never a card/i);
    // live-orders.ts leverage(): a card only where a position is open in the market
    const noPos = MODE_RULES.find((r) => /no position/i.test(r.door));
    expect(noPos).toBeDefined();
    expect(noPos!.guard).toMatch(/^At once/);
    expect(noPos!.beast).toMatch(/^At once/);
    expect(noPos!.guard).not.toMatch(/card/i);
    for (const r of MODE_RULES) {
      if (r === cancel || r === noPos) continue;
      expect(r.guard, r.door).toMatch(/card/i);
      expect(r.beast, r.door).toMatch(/at once/i);
    }
    // where Beast still raises a card, the row says so: a derivative close and a leverage change above the per-order line (live-orders.ts
    // close() and leverage()), an earn withdrawal above the per-supply line (live-earn.ts agent()), a first payment to a payee (pay-real.ts)
    for (const door of ["Close a derivative position", "Change leverage with a position open", "Take money out of earn", "Pay from its agent wallet"]) expect(byDoor[door]?.beast, door).toMatch(/card/i);
    // and where it never does, the row is one phrase (live-orders.ts agent(), live-moves.ts agent(), live-earn.ts supply)
    for (const door of ["Place or enlarge an order", "Move money between your accounts", "Put money into earn"]) expect(byDoor[door]?.beast, door).toBe("At once");
    // a plain sell of a holding counts like a sell order (live-orders.ts close(): "counts against the trading limit like one")
    expect(byDoor["Close a spot, stock or contract holding"]?.beast).toMatch(/trading limit/);
  });

  it("carry the one card-expiry number — thirty minutes, written once, re-exported by the door — and every door that raises a card uses it", () => {
    expect(cardMinutes).toBe(30);
    expect(CARD_TTL_MS).toBe(30 * 60_000);
    expect(fromTheDoor).toBe(CARD_TTL_MS);
    const exchange = read("src/portfolio/account/exchange.ts");
    expect(exchange).not.toMatch(/^export const CARD_TTL_MS/m);
    expect(exchange).toMatch(/expiresAt: new Date\(now \+ CARD_TTL_MS\)/);
    // the live doors import the one constant: no card's expiry is written as a number of its own anywhere in the account
    for (const f of ["src/portfolio/account/live-orders.ts", "src/portfolio/account/live-earn.ts", "src/portfolio/account/live-moves.ts"]) {
      const src = read(f);
      expect(src, f).toMatch(/import \{ CARD_TTL_MS \} from "\.\/mode-rules\.ts";/);
      expect(src, f).toMatch(/expiresAt: new Date\(now \+ CARD_TTL_MS\)/);
      expect(src, f).not.toMatch(/expiresAt: new Date\(\w+ \+ \d+ \* 60_000\)/);
    }
  });

  it("travel with the account page and the agents' account read, and everything a person or an agent reads says Guard and Beast", () => {
    const exchange = read("src/portfolio/account/exchange.ts");
    expect(exchange).toMatch(/modeRules: \{ rows: ModeRule\[\]; cardMinutes: number \};/);
    expect(exchange).toMatch(/modeRules: modeRules\(\),/);
    const mcp = read("src/portfolio/mcp.ts");
    expect(mcp).toMatch(/modeRules\?: \{ rows: Array<\{ door: string; guard: string; beast: string \}>; cardMinutes: number \}/);
    expect(mcp).toContain("...(a.modeRules ? { modeRules: a.modeRules } : {})");
    expect(mcp).toContain("mode: a.mode,");
    // the wire values stay what the signed rows and the old ledgers say
    expect(read("src/portfolio/server.ts")).toContain('if (mode !== "open" && mode !== "guard")');
    expect(read("src/portfolio/service.ts")).toContain('mode: "Guard" | "Beast";');
    expect(read("src/portfolio/service.ts")).toContain('summary: "Beast: agents trade and move inside their limits without asking"');
    for (const f of ["src/portfolio/account/live-orders.ts", "src/portfolio/account/live-moves.ts", "src/portfolio/account/live-earn.ts", "src/portfolio/account/pay-real.ts", "src/portfolio/account/restore.ts", "src/portfolio/account/sign.ts", "src/portfolio/account/exchange.ts", "src/portfolio/service.ts", "src/portfolio/mcp.ts", "test/standin/ui-standin.ts", "README.md", "COOKBOOK.md"]) expect(read(f), f).not.toMatch(/Conservative|Aggressive/);
  });
});
