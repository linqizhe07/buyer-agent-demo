import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createContext, runInContext, Script } from "node:vm";
import { describe, expect, it } from "vitest";

/** The Earn and Sell many sheets (ui/earn.js), run as the page runs them — ui/core.js, ui/connect.js, ui/money.js, ui/portfolio.js, ui/earn.js
 * in one global scope, in a vm with a stand-in document. What is checked: the lists and drafts the sheets sign (moved here from the Trade
 * pane's helper tests), "all" of it out of a product, the sheet each opens (its title, the product a preset pre-picks, Take out's "All of
 * it"), and what each reads from the account */
const UI = fileURLToPath(new URL("../../src/portfolio/public/ui/", import.meta.url));
const FILES = ["core.js", "connect.js", "money.js", "portfolio.js", "earn.js"];

type Node = Record<string, any>;
const node = (extra: Node = {}): Node => ({ hidden: false, isConnected: true, innerHTML: "", textContent: "", className: "", value: "", dataset: {}, listeners: {} as Record<string, (e: unknown) => void>, addEventListener(type: string, fn: (e: unknown) => void) { this.listeners[type] = fn; }, setAttribute() {}, querySelector: () => null, querySelectorAll: () => [], ...extra });

function page(answer: (path: string) => unknown) {
  const asked: string[] = [];
  const sheets: Array<{ html: string; title: string; root: Node; redraw?: () => void }> = [];
  const element = (): Node => node();
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
    setInterval: () => 0,
    clearInterval() {},
    fetch: async (path: string) => {
      asked.push(path);
      const body = await answer(path);
      return { status: (body as { ok?: boolean })?.ok === false ? 409 : 200, statusText: "", json: async () => body };
    },
    FormData: class {
      constructor(private readonly f: { values?: Record<string, string> }) {}
      get(k: string) {
        return this.f.values?.[k] ?? null;
      }
      getAll(k: string) {
        const v = this.f.values?.[k];
        return v === undefined ? [] : [v];
      }
    },
  };
  const ctx = createContext(sandbox);
  sandbox.window = runInContext("globalThis", ctx);
  for (const f of FILES) new Script(readFileSync(`${UI}${f}`, "utf8"), { filename: f }).runInContext(ctx);
  const run = <T = unknown>(code: string): T => runInContext(code, ctx) as T;
  /* the one sheet, as a stand-in: the root the sheet draws into records every innerHTML; the seg's and the rows' nodes are found by name */
  (sandbox.window as Record<string, unknown>).openSheet = (html: string, o: { title: string; redraw?: () => void }) => {
    const root = node({
      drawn: [] as string[],
      set innerHTML(v: string) {
        this.drawn.push(v);
        this.html = v;
      },
      get innerHTML() {
        return this.html ?? "";
      },
      querySelector(s: string) {
        if (s === "[data-kind]") return (this.kindNode ??= node());
        if (s === "form") return (this.formNode ??= node({ isConnected: true, elements: { amount: { value: "" } }, querySelector: (q: string) => (this.formParts ??= {})[q] ??= node() }));
        if (s === "[data-en-hand]") return null;
        if (s === "[data-sm-body]") return (this.smBody ??= node({ querySelector(q: string) { if (q === "form") return (this.formNode ??= node({ querySelectorAll: () => [] })); if (q === "[data-review]") return (this.reviewBtn ??= node()); return null; }, insertAdjacentHTML(_w: string, h: string) { this.innerHTML += h; } }));
        return null;
      },
      querySelectorAll(s: string) {
        if (s === "button[data-prod]") return [...String(this.html ?? "").matchAll(/data-prod="([^"]+)"/g)].map((m) => node({ dataset: { prod: m[1] } }));
        return [];
      },
    });
    const body = node({ querySelector: (s: string) => (s === "[data-earn]" || s === "[data-sm]" ? root : null) });
    sheets.push({ html, title: o.title, root, ...(o.redraw ? { redraw: o.redraw } : {}) });
    return body;
  };
  return { run, asked, sheets, set: (name: string, value: unknown) => run(`${name} = ${JSON.stringify(value)}`), out: <T = any>(code: string): T => JSON.parse(run<string>(`JSON.stringify(${code})`)) as T };
}
const settle = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

const venue = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, live: true, usd: 0, holdings: [], ...extra });
const ACCOUNT = {
  now: "2026-10-06T12:00:00.000Z",
  liveUsd: 1000,
  connectLive: { writes: { on: true, capUsd: 250 }, options: [] },
  venues: [
    venue("ex", "Exchange", { usd: 900, trade: { can: true, what: "spot", positions: true }, earn: { can: true, what: "Simple Earn Flexible" }, holdings: [{ asset: "USDT", amount: 500, usd: 500, class: "stable" }, { asset: "ETH", amount: 1.8, usd: 4000, class: "crypto" }] }),
    venue("mm", "MetaMask", { usd: 100, earn: { can: true, what: "vaults" }, holdings: [{ asset: "USDC", amount: 40, usd: 40, class: "stable" }] }),
  ],
  keys: [{ address: "0x3a087530887bd175ccc38828ee3776e5b6ea1ac6", name: "Claude Code", code: "CC", status: "ok" }],
  spend: [],
  subAccounts: [],
  cards: [],
  asks: [],
  requests: [],
  intents: [],
  health: {},
};
const EARN = { ok: true, products: [{ venue: "ex", venueName: "Exchange", id: "savings:USDT", name: "USDT Flexible", asset: "USDT", apy: 0.052, canSupply: true, canWithdraw: true, lockDays: 0, lands: "the spot wallet at Exchange" }, { venue: "ex", venueName: "Exchange", id: "locked:ETH", name: "ETH 30 days", asset: "ETH", apy: 0.031, canSupply: false, why: "closed to new money", canWithdraw: true, lockDays: 30, lands: "the spot wallet at Exchange" }, { venue: "mm", venueName: "MetaMask", id: "8453:0xvault", name: "USDC vault", asset: "USDC", apy: 0.04, canSupply: true, canWithdraw: true, protocol: "Aave", chain: "Base", lands: "the wallet on Base" }], positions: [{ venue: "ex", venueName: "Exchange", product: "savings:USDT", id: "p1", asset: "USDT", amount: 150, usd: 150, apy: 0.052, name: "USDT Flexible" }], venues: [{ venue: "ex", venueName: "Exchange", can: true, what: "Simple Earn Flexible" }, { venue: "mm", venueName: "MetaMask", can: true, what: "vaults" }], missing: [] };
const SELLABLE = { ok: true, items: [{ key: "crypto:ETH", asset: "ETH", venue: "ex", venueName: "Exchange", action: "sell", symbol: "ETH/USDT", kind: "spot", held: 1.8, sellQty: 1.8, price: 2200, usd: 3960, ready: true }, { key: "position:ex:ETH/USDT:USDT", asset: "ETH", venue: "ex", venueName: "Exchange", action: "close", symbol: "ETH/USDT:USDT", kind: "perp", side: "long", held: 0.05, sellQty: 0.05, usd: 110, ready: true }, { key: "crypto:DUST", asset: "DUST", venue: "ex", venueName: "Exchange", action: "sell", symbol: "DUST/USDT", held: 0.0001, sellQty: 0, ready: false, why: "under the market's smallest order" }, { key: "crypto:WETH", asset: "WETH", venue: "mm", venueName: "MetaMask", action: "sell", symbol: "WETH/USDC@Base", kind: "token", held: 0.02, sellQty: 0.02, usd: 44, ready: true }], missing: [] };
const answer = (path: string) => (path.startsWith("/api/account/earn") ? EARN : path.startsWith("/api/account/sellable") ? SELLABLE : { ok: false, refusal: { message: `nothing answers ${path}` } });
function account(over: Record<string, unknown> = {}) {
  const p = page(answer);
  p.set("A", { ...ACCOUNT, ...over });
  return p;
}

describe("Earn's lists and drafts", () => {
  it("lists the products — to put in, the ones taking money first; to take out, the ones something is in — and drafts money in or out in the product's own asset", () => {
    const p = account();
    const view = { products: [{ venue: "okx", id: "savings:BTC", asset: "BTC", canSupply: false, why: "closed to new money" }, { venue: "okx", id: "savings:USDT", asset: "USDT", canSupply: true }, { venue: "mm", id: "8453:0xvault", asset: "USDC", canSupply: true }], positions: [{ venue: "mm", product: "8453:0xvault", asset: "mUSDC", amount: 12 }, { venue: "okx", product: "savings:USDT", asset: "USDT", amount: 0 }] };
    expect(p.out<Array<{ id: string }>>(`enList(${JSON.stringify(view)}, "supply")`).map((x) => x.id)).toEqual(["savings:USDT", "8453:0xvault", "savings:BTC"]);
    expect(p.out<Array<{ id: string }>>(`enList(${JSON.stringify(view)}, "withdraw")`).map((x) => x.id)).toEqual(["8453:0xvault"]);
    expect(p.out('enDraft({ venue: "mm", id: "8453:0xvault", asset: "USDC" }, "withdraw", " 5 ")')).toEqual({ type: "liveEarn", venue: "mm", kind: "withdraw", product: "8453:0xvault", asset: "USDC", amount: "5" });
    expect(p.out('enDraft({ venue: "okx", id: "savings:USDT", asset: "USDT" }, "anything", "10").kind')).toBe("supply");
    // all of it out: the word itself, which the door takes for a withdrawal
    expect(p.out('enDraft({ venue: "okx", id: "savings:USDT", asset: "USDT" }, "withdraw", "all")')).toEqual({ type: "liveEarn", venue: "okx", kind: "withdraw", product: "savings:USDT", asset: "USDT", amount: "all" });
    expect(p.out('[enRate({ apy: 0.0534 }), enRate({ apy: 0.02, apyHigh: 0.05, rateKind: "apr" }), enRate({})]')).toEqual(["5.34% APY", "2.00%–5.00% APR", ""]);
  });

  it("draws a product as one row: name and yield, one line venue · asset · lock (and what is in it), the other facts on hover; a closed one tagged", () => {
    const p = account();
    const open = p.run<string>(`enRow(${JSON.stringify(EARN.products[2])}, { chosen: "mm|8453:0xvault", kind: "supply" })`);
    expect(open).toContain('aria-pressed="true"');
    expect(open).toContain("<b>USDC vault</b>");
    expect(open).toContain('<span class="why">MetaMask · USDC</span>');
    expect(open).toContain('title="Aave · Base · taken out, it lands in the wallet on Base"');
    expect(open).toContain("4.00% APY");
    expect(open).not.toContain("Closed");
    const closed = p.run<string>(`enRow(${JSON.stringify(EARN.products[1])}, { chosen: "", kind: "supply" })`);
    expect(closed).toContain('class="en-at off"');
    expect(closed).toContain('<span class="tag">Closed</span>');
    expect(closed).toContain("closed to new money");
    expect(closed).toContain("Exchange · ETH · locked 30 days");
    // on Take out a closed product is just a product, with what is in it
    const out = p.run<string>(`enRow(${JSON.stringify(EARN.products[0])}, { chosen: "", kind: "withdraw", held: { amount: 150, asset: "USDT" } })`);
    expect(out).toContain("Exchange · USDT · out at once · in it: 150 USDT");
    expect(out).not.toContain("Closed");
    // no tk- class anywhere in earn.js
    expect(readFileSync(`${UI}earn.js`, "utf8")).not.toMatch(/class="[^"]*\btk-/);
  });
});

describe("the Earn sheet", () => {
  it("opens as the sheet Earn, reads /api/account/earn, pre-picks the preset's product on Take out and offers All of it; Put in lists the open products first", async () => {
    const p = account();
    // Hand to agent needs the composer (ui/intent.js), which is not on this page: a stand-in says it is there
    p.run("globalThis.openHandToAgent = () => {}");
    p.run('openEarn({ venue: "ex", side: "withdraw", product: "savings:USDT" })');
    await settle();
    expect(p.sheets).toHaveLength(1);
    const s = p.sheets[0]!;
    expect(s.title).toBe("Earn");
    expect(typeof s.redraw).toBe("function");
    expect(p.asked).toEqual(["/api/account/earn?venue=ex"]);
    const html = String(s.root.innerHTML);
    // Take out: the one product something is in, pressed
    expect(html).toContain('data-prod="ex|savings:USDT" data-fk="en:ex|savings:USDT" aria-pressed="true"');
    expect(html).not.toContain('data-prod="ex|locked:ETH"');
    expect(html).toContain('<button type="button" class="link" data-all>All of it</button>');
    expect(html).toContain("Sign and take out");
    expect(html).toContain("Hand to agent");
    // the lens: the preset's venue only — MetaMask's vault is not listed
    expect(html).not.toContain("USDC vault");
    // no standing cap sentence
    expect(html).not.toMatch(/Up to \$250/);
    // Put in, over every venue: the open products first, the closed one last with its tag
    const q = account();
    q.run("openEarn({})");
    await settle();
    const put = String(q.sheets[0]!.root.innerHTML);
    expect(q.asked).toEqual(["/api/account/earn"]);
    const order = [...put.matchAll(/data-prod="([^"]+)"/g)].map((m) => m[1]);
    expect(order).toEqual(["ex|savings:USDT", "mm|8453:0xvault", "ex|locked:ETH"]);
    expect(put).toContain("Sign and put in");
    expect(put).not.toContain("data-all");
  });

  it("says in the venue's words when a venue can't put money to earn, and when Earn could not be read", async () => {
    const p = page((path) => (path.startsWith("/api/account/earn") ? { ...EARN, venues: [{ venue: "ex", venueName: "Exchange", can: false, what: "", whyNot: "this key may not use Simple Earn" }], missing: [{ venue: "mm", venueName: "MetaMask", why: "mm did not answer" }] } : {}));
    p.set("A", ACCOUNT);
    p.run("openEarn({})");
    await settle();
    const html = String(p.sheets[0]!.root.innerHTML);
    expect(html).toContain("Exchange: this key may not use Simple Earn");
    expect(html).toContain("MetaMask could not be read: mm did not answer");
    const q = page(() => ({ ok: false, refusal: { message: "the account layer is not mounted" } }));
    q.set("A", ACCOUNT);
    q.run("openEarn({})");
    await settle();
    expect(String(q.sheets[0]!.root.innerHTML)).toBe('<div class="msg no">the account layer is not mounted</div>');
  });
});

describe("Sell many", () => {
  it("drafts the legs: a market sell of what is held (or less), a position's close (all, or part); names each", () => {
    const p = account();
    expect(p.out('smDraft({ action: "sell", venue: "ex", symbol: "ETH/USDT", held: 1.8, sellQty: 1.8 }, "")')).toEqual({ type: "liveOrder", venue: "ex", symbol: "ETH/USDT", side: "sell", orderType: "market", qty: "1.8", limitPrice: "", stopPrice: "", tif: "", postOnly: "", reduceOnly: "" });
    expect(p.out('smDraft({ action: "sell", venue: "ex", symbol: "ETH/USDT", held: 1.8, sellQty: 1.8 }, "0.01")')).toMatchObject({ qty: "0.01" });
    expect(p.out('smDraft({ action: "close", venue: "ex", symbol: "ETH/USDT:USDT", held: 0.05, sellQty: 0.05 }, "0.05")')).toEqual({ type: "liveClose", venue: "ex", symbol: "ETH/USDT:USDT", qty: "" });
    expect(p.out('smDraft({ action: "close", venue: "ex", symbol: "ETH/USDT:USDT", held: 0.05, sellQty: 0.05 }, "0.02")')).toMatchObject({ qty: "0.02" });
    expect(p.out('[smLegName({ action: "close", side: "long", asset: "ETH" }), smLegName({ action: "sell", asset: "SOL" })]')).toEqual(["Close long ETH", "SOL"]);
    expect(p.run("SM_MAX_LEGS")).toBe(10);
    // what can be sold: the ready rows in the lens, how many were left out
    expect(p.out(`smSellable(${JSON.stringify(SELLABLE)}, () => true)`)).toMatchObject({ hidden: 1, missing: [] });
    expect(p.out<{ items: Array<{ key: string }> }>(`smSellable(${JSON.stringify(SELLABLE)}, () => true)`).items.map((x) => x.key)).toEqual(["crypto:ETH", "position:ex:ETH/USDT:USDT", "crypto:WETH"]);
    expect(p.out<{ items: Array<{ key: string }> }>(`smSellable(${JSON.stringify(SELLABLE)}, (v) => v === "mm")`).items.map((x) => x.key)).toEqual(["crypto:WETH"]);
  });

  it("opens as the sheet Sell many with no redraw, asks /api/account/sellable once, lists the ready rows and counts the rest in one line", async () => {
    const p = account();
    p.run("openSellMany({})");
    await settle();
    expect(p.sheets).toHaveLength(1);
    const s = p.sheets[0]!;
    expect(s.title).toBe("Sell many");
    expect(s.redraw).toBeUndefined();
    expect(p.asked).toEqual(["/api/account/sellable"]);
    expect(s.html).toContain("Pick up to 10");
    expect(s.html).not.toMatch(/up to \$250 each/);
    const list = String(s.root.smBody.innerHTML);
    expect(list.match(/<li class="sm-row">/g)).toHaveLength(3);
    expect(list).toContain("<b>Close long ETH</b>");
    expect(list).toContain("<b>WETH</b>");
    expect(list).not.toContain("DUST");
    expect(list).toContain("1 holding can't be sold from here right now and is left out.");
    expect(list).toContain('data-review disabled>Review</button>');
    // at one venue: that venue's rows alone, said in the lead
    const q = account();
    q.run('openSellMany({ venue: "mm" })');
    await settle();
    expect(q.sheets[0]!.html).toContain("isn't a dollar at MetaMask");
    expect(String(q.sheets[0]!.root.smBody.innerHTML).match(/<li class="sm-row">/g)).toHaveLength(1);
  });
});
