import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createContext, runInContext, Script } from "node:vm";
import { describe, expect, it } from "vitest";

/** Receive (ui/money.js openReceive), run as the page runs it — ui/core.js, ui/connect.js, ui/money.js in one global scope, in a vm with a
 * stand-in document. The sheet is a flat list, one row an account × network: a wallet whose address is the same on every EVM network has
 * ONE row saying so, an exchange a row a network with an asset chip (exchanges give an address per asset), each address read lazily as
 * its row comes into view through GET /api/account/receive, a refusal in the venue's own words inside the row, and the accounts that
 * give no address as footer lines in the venue's words. The sheet's elements are stand-ins here: nodes made for every row the HTML names */
const UI = fileURLToPath(new URL("../../src/portfolio/public/ui/", import.meta.url));
const FILES = ["core.js", "connect.js", "money.js"];

type Node = Record<string, any>;
/** a node with what the sheet's code reads and writes on one */
const node = (extra: Node = {}): Node => ({ hidden: false, isConnected: true, innerHTML: "", textContent: "", className: "", value: "", dataset: {}, listeners: {} as Record<string, (e: unknown) => void>, addEventListener(type: string, fn: (e: unknown) => void) { this.listeners[type] = fn; }, focus() {}, hasAttribute: () => false, closest: () => null, querySelector: () => null, querySelectorAll: () => [], ...extra });

/** the sheet as openReceive would find it: a root with its list, search, footer and a node for every row (and sub-node) the HTML names */
function fakeSheet(html: string) {
  const rows = new Map<string, Node>();
  for (const m of html.matchAll(/data-rcv-row="([^"]+)"/g)) {
    const id = m[1]!;
    const text = new RegExp(`data-rcv-row="${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" data-text="([^"]*)"`).exec(html)?.[1] ?? "";
    const parts: Record<string, Node> = { "[data-rcv-addr]": node(), "[data-rcv-acts]": node(), "[data-rcv-note]": node(), "[data-rcv-tag]": node() };
    rows.set(id, node({ dataset: { rcvRow: id, text: text.replace(/&amp;/g, "&") }, parts, querySelector: (s: string) => parts[s] ?? null }));
  }
  const foot = new Map<string, Node>();
  for (const m of html.matchAll(/data-rcv-no="([^"]+)" data-text="([^"]*)"/g)) foot.set(m[1]!, node({ dataset: { rcvNo: m[1], text: m[2] }, why: node(), querySelector: (s: string) => (s === "[data-rcv-why]" ? foot.get(m[1]!)!.why : null) }));
  const list = node({ querySelector: (s: string) => { const m = /^\[data-rcv-row="(.+)"\]$/.exec(s); return m ? rows.get(m[1]!.replace(/\\(.)/g, "$1")) ?? null : null; } });
  const simple: Record<string, Node> = { "[data-rcv-list]": list, "[data-rcv-q]": node(), "[data-rcv-none]": node(), "[data-rcv-only]": node(), "[data-rcv-all]": node() };
  const root = node({
    querySelector: (s: string) => {
      if (simple[s]) return simple[s];
      const f = /^\[data-rcv-no="(.+)"\] \[data-rcv-why\]$/.exec(s);
      return f ? foot.get(f[1]!.replace(/\\(.)/g, "$1"))?.why ?? null : null;
    },
    querySelectorAll: (s: string) => (s === "[data-rcv-no]" ? [...foot.values()] : []),
  });
  const body = node({ querySelector: (s: string) => (s === "[data-rcv]" ? root : null) });
  return { body, root, list, rows, foot, simple };
}

function page(answer: (q: URLSearchParams) => unknown) {
  const asked: string[] = [];
  const sheets: Array<{ html: string; title: string; fake: ReturnType<typeof fakeSheet> }> = [];
  const observed: Node[] = [];
  let fire: ((entries: Array<{ isIntersecting: boolean; target: Node }>) => void) | null = null;
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
    IntersectionObserver: class {
      constructor(cb: (entries: Array<{ isIntersecting: boolean; target: Node }>) => void) {
        fire = cb;
      }
      observe(el: Node) {
        observed.push(el);
      }
    },
    fetch: async (path: string) => {
      asked.push(path);
      const q = new URLSearchParams(path.slice(path.indexOf("?") + 1));
      const body = await answer(q);
      return { status: (body as { ok?: boolean })?.ok === false ? 409 : 200, statusText: "", json: async () => body };
    },
  };
  const ctx = createContext(sandbox);
  sandbox.window = runInContext("globalThis", ctx);
  for (const f of FILES) new Script(readFileSync(`${UI}${f}`, "utf8"), { filename: f }).runInContext(ctx);
  const run = <T = unknown>(code: string): T => runInContext(code, ctx) as T;
  // the one sheet, as a stand-in: what was asked to be drawn, and the nodes made for it
  (sandbox.window as Record<string, unknown>).openSheet = (html: string, o: { title: string }) => {
    const fake = fakeSheet(html);
    sheets.push({ html, title: o.title, fake });
    return fake.body;
  };
  return { run, asked, sheets, observed, fire: (entries: Array<{ isIntersecting: boolean; target: Node }>) => fire && fire(entries), set: (name: string, value: unknown) => run(`${name} = ${JSON.stringify(value)}`) };
}
const settle = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

const venue = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, live: true, usd: 0, holdings: [], ...extra });
const WALLET = "0x90cd4774dfc70d05260f7a2b7ac44a3dc021cf5b";
const ACCOUNT = {
  now: "2026-10-06T12:00:00.000Z",
  liveUsd: 1000,
  networks: ["Base", "Arbitrum", "Ethereum", "Optimism", "Polygon", "BNB Chain"],
  bridgeChains: ["Base", "Arbitrum", "Robinhood Chain"],
  connectLive: { writes: { on: true, capUsd: 250 }, options: [] },
  venues: [
    venue("ex", "Exchange", { usd: 900, trade: { can: true, what: "spot" }, liveCan: { withdraw: true, ledgers: ["spot"], transfer: false, swap: true, receive: true, send: false }, holdings: [{ asset: "USDT", amount: 500, usd: 500, class: "stable" }, { asset: "USDC", amount: 100, usd: 100, class: "stable" }, { asset: "BTC", amount: 0.01, usd: 600, class: "crypto" }] }),
    venue("agent-claude-code", "Agent wallet · Claude Code", { usd: 100, address: WALLET, proven: "this account holds its key", liveCan: { withdraw: false, ledgers: [], transfer: false, swap: false, receive: true, send: "account" }, connector: "live:agent-wallet" }),
    venue("polymarket", "Polymarket", { usd: 0, address: "0x1111111111111111111111111111111111111111", proven: "MetaMask signed for it", connector: "live:polymarket" }),
    venue("watch", "Watched", { usd: 0, address: "0x2222222222222222222222222222222222222222", proven: "" }),
    venue("alpaca", "Alpaca", { usd: 0, trade: { can: true, what: "stocks" }, readOnlyBecause: "Alpaca's API moves no cash", liveCan: { receive: false } }),
  ],
  keys: [],
  spend: [],
  subAccounts: [],
  cards: [],
  asks: [],
  requests: [],
  intents: [],
  health: {},
};
/** the account's answer to GET /api/account/receive, venue by venue */
const ANSWER = (q: URLSearchParams) => {
  const venueId = q.get("venue");
  const asset = q.get("asset");
  const network = q.get("network");
  if (venueId === "ex") return network === "BNB Chain" ? { ok: false, refusal: { message: `Exchange: ${asset} is not on BNB Chain` } } : { venue: "ex", venueName: "Exchange", asset, network, address: `0xEX${asset}${network!.replace(/\s/g, "")}`, whose: "Exchange's own deposit address, as Exchange gives it", ...(network === "Polygon" ? { tag: "memo-77" } : {}) };
  if (venueId === "agent-claude-code") return { venue: venueId, venueName: "Agent wallet · Claude Code", asset, network, address: WALLET, whose: "this account holds its key", note: "the wallet's own address: the same on every EVM chain" };
  if (venueId === "polymarket") return { venue: venueId, venueName: "Polymarket", asset, network, address: "0x1111111111111111111111111111111111111111", whose: "MetaMask signed for it", note: "the Polymarket wallet, on Polygon: pUSD only" };
  if (venueId === "watch") return { ok: false, refusal: { message: "Watched is watched, not proven yours: the account gives no address to send to it. Connect it again from the wallet itself" } };
  if (venueId === "alpaca") return { ok: false, refusal: { message: "Alpaca: Alpaca's API moves no cash" } };
  return { ok: false, refusal: { message: `"${venueId}" is not a venue connected live` } };
};
function account(over: Record<string, unknown> = {}) {
  const p = page(ANSWER);
  p.set("A", { ...ACCOUNT, ...over });
  return p;
}

describe("the Receive list", () => {
  it("has one row an account × network: a wallet one row for every EVM network, a Polymarket wallet Polygon alone, an exchange a row a network with its asset chip", () => {
    const p = account();
    const rows = p.run<Array<{ id: string; network: string; networks: string[]; asset: string; chip: boolean; kind: string }>>("receiveRows(A.venues.filter(canReceive))");
    // the exchange: the seven networks the account publishes, each starting on the dollar the venue holds most of
    const ex = rows.filter((r) => r.id.startsWith("ex|"));
    expect(ex.map((r) => r.network)).toEqual(["Base", "Arbitrum", "Ethereum", "Optimism", "Polygon", "BNB Chain", "Robinhood Chain"]);
    expect(new Set(ex.map((r) => `${r.asset} ${r.chip} ${r.kind}`))).toEqual(new Set(["USDT true exchange"]));
    // the agent wallet: ONE row, the five EVM networks first and then the rest, asked once on Base
    const w = rows.find((r) => r.id === "agent-claude-code|evm")!;
    expect(w).toMatchObject({ network: "Base", asset: "USDC", chip: false, kind: "wallet" });
    expect(w.networks).toEqual(["Base", "Arbitrum", "Optimism", "Polygon", "Ethereum", "BNB Chain", "Robinhood Chain"]);
    expect(rows.filter((r) => r.id.startsWith("agent-claude-code|"))).toHaveLength(1);
    // Polymarket by address: Polygon and pUSD, nothing else
    expect(rows.filter((r) => r.id.startsWith("polymarket|"))).toEqual([expect.objectContaining({ network: "Polygon", networks: ["Polygon"], asset: "PUSD", chip: false })]);
    // a watched address and a venue that takes nothing are not rows
    expect(rows.some((r) => r.id.startsWith("watch|") || r.id.startsWith("alpaca|"))).toBe(false);
    expect(p.run("rcvDefaultAsset(A.venues[0])")).toBe("USDT");
    expect(p.run('rcvDefaultAsset({ holdings: [] })')).toBe("USDC");
  });

  it("draws a row with the account, its network words, the full address to come and Copy — the asset select only on an exchange row", () => {
    const p = account();
    const html = p.run<string[]>("receiveRows(A.venues.filter(canReceive)).map(rcvRowHtml)");
    const ex = html.find((h) => h.includes('data-rcv-row="ex|Base"'))!;
    expect(ex).toContain('<select name="asset" class="rcv-asset" data-rcv-asset');
    expect(ex).toContain('<option value="USDT" selected>USDT</option>');
    expect(ex).toContain('<option value="BTC">BTC</option>');
    expect(ex).toContain("<b>Exchange</b>");
    expect(ex).toContain('<span class="dim">Base</span>');
    expect(ex).toContain("data-rcv-copy");
    const w = html.find((h) => h.includes('data-rcv-row="agent-claude-code|evm"'))!;
    expect(w).not.toContain("<select");
    expect(w).toContain("All EVM networks: Base, Arbitrum, Optimism, Polygon, Ethereum, BNB Chain, Robinhood Chain");
    // what the search box matches on
    expect(w).toContain('data-text="agent wallet · claude code base arbitrum optimism polygon ethereum bnb chain robinhood chain usdc"');
  });

  it("opens as one sheet with a search box, one warning line, every row, and the accounts that give no address as footer lines in the venue's words", async () => {
    const p = account();
    p.run('openReceive("")');
    await settle();
    expect(p.sheets).toHaveLength(1);
    const { html, title, fake } = p.sheets[0]!;
    expect(title).toBe("Receive");
    expect(html).toContain('data-rcv-q placeholder="Search accounts and networks"');
    expect(html.match(/Send only the asset on the network the row names/g)).toHaveLength(1);
    expect(fake.rows.size).toBe(7 + 1 + 1);
    // no filter from the quick action: the "Showing" line is hidden
    expect(fake.simple["[data-rcv-only]"]!.hidden).toBe(true);
    // the footer: the watched address and Alpaca, each in the server's own words
    expect([...fake.foot.keys()]).toEqual(["watch", "alpaca"]);
    expect(fake.foot.get("watch")!.why.textContent).toBe("Watched is watched, not proven yours: the account gives no address to send to it. Connect it again from the wallet itself");
    expect(fake.foot.get("alpaca")!.why.textContent).toBe("Alpaca: Alpaca's API moves no cash");
    // no row was asked for its address yet: each waits to come into view
    expect(p.asked.filter((a) => a.includes("venue=ex") || a.includes("venue=agent") || a.includes("venue=polymarket"))).toEqual([]);
    expect(p.observed).toHaveLength(9);
  });

  it("reads an address lazily, as its row comes into view, through GET /api/account/receive — the venue's words on a refusal, a memo tag with its own Copy", async () => {
    const p = account();
    p.run('openReceive("")');
    await settle();
    const { fake } = p.sheets[0]!;
    const row = fake.rows.get("agent-claude-code|evm")!;
    p.fire([{ isIntersecting: true, target: row }, { isIntersecting: false, target: fake.rows.get("ex|Base")! }]);
    await settle();
    expect(p.asked.filter((a) => a.startsWith("/api/account/receive?venue=agent"))).toEqual(["/api/account/receive?venue=agent-claude-code&asset=USDC&network=Base"]);
    expect(row.parts["[data-rcv-addr]"]!.textContent).toBe(WALLET);
    expect(row.parts["[data-rcv-addr]"]!.className).toBe("rcv-addr mono");
    expect(row.parts["[data-rcv-acts]"]!.hidden).toBe(false);
    expect(row.parts["[data-rcv-note]"]!.textContent).toBe("This account holds its key · the wallet's own address: the same on every EVM chain.");
    // seen again: not asked again
    p.fire([{ isIntersecting: true, target: row }]);
    await settle();
    expect(p.asked.filter((a) => a.startsWith("/api/account/receive?venue=agent"))).toHaveLength(1);
    // an exchange row on a network the venue refuses: its words in the row, no Copy
    const bnb = fake.rows.get("ex|BNB Chain")!;
    p.fire([{ isIntersecting: true, target: bnb }]);
    await settle();
    expect(bnb.parts["[data-rcv-addr]"]!.textContent).toBe("Exchange: USDT is not on BNB Chain");
    expect(bnb.parts["[data-rcv-addr]"]!.className).toBe("rcv-addr msg no");
    expect(bnb.parts["[data-rcv-acts]"]!.hidden).toBe(true);
    // a venue that returns a memo tag: a tag row with its own Copy
    const pol = fake.rows.get("ex|Polygon")!;
    p.fire([{ isIntersecting: true, target: pol }]);
    await settle();
    expect(pol.parts["[data-rcv-addr]"]!.textContent).toBe("0xEXUSDTPolygon");
    expect(pol.parts["[data-rcv-tag]"]!.innerHTML).toContain("Memo / tag — needed with it");
    expect(pol.parts["[data-rcv-tag]"]!.innerHTML).toContain("memo-77");
    expect(pol.parts["[data-rcv-tag]"]!.innerHTML).toContain("data-rcv-copy-tag");
    // the asset chip changed: that row is asked again for the new asset (exchanges give an address per asset)
    const sel = node({ value: "BTC", hasAttribute: (a: string) => a === "data-rcv-asset", closest: () => pol });
    fake.list.listeners.change!({ target: sel });
    await settle();
    expect(p.asked[p.asked.length - 1]).toBe("/api/account/receive?venue=ex&asset=BTC&network=Polygon");
    expect(pol.parts["[data-rcv-addr]"]!.textContent).toBe("0xEXBTCPolygon");
    // Copy copies what the row shows
    p.run("var COPIED = []; copyText = async (t) => { COPIED.push(t); }");
    const copy = node({ hasAttribute: (a: string) => a === "data-rcv-copy" });
    copy.closest = (s: string) => (s === "button" ? copy : pol);
    fake.list.listeners.click!({ target: copy });
    expect(p.run("COPIED")).toEqual(["0xEXBTCPolygon"]);
  });

  it("narrows to one account from the Account drawer, widens again on All accounts, and the search hides what does not match", async () => {
    const p = account();
    p.run('openReceive("ex")');
    await settle();
    const { fake } = p.sheets[0]!;
    expect(fake.simple["[data-rcv-only]"]!.hidden).toBe(false);
    expect(fake.rows.get("agent-claude-code|evm")!.hidden).toBe(true);
    expect(fake.rows.get("ex|Base")!.hidden).toBe(false);
    for (const f of fake.foot.values()) expect(f.hidden).toBe(true);
    // the rows shown are the ones watched for their address
    expect(p.observed.map((n) => n.dataset.rcvRow).every((id: string) => id.startsWith("ex|"))).toBe(true);
    fake.simple["[data-rcv-all]"]!.listeners.click!({});
    expect(fake.rows.get("agent-claude-code|evm")!.hidden).toBe(false);
    expect(fake.simple["[data-rcv-only]"]!.hidden).toBe(true);
    // the search: by account, network or asset words
    fake.simple["[data-rcv-q]"]!.value = "polygon";
    fake.simple["[data-rcv-q]"]!.listeners.input!({});
    expect(fake.rows.get("ex|Polygon")!.hidden).toBe(false);
    expect(fake.rows.get("ex|Base")!.hidden).toBe(true);
    // the wallet's one row names every EVM network, Polygon among them
    expect(fake.rows.get("agent-claude-code|evm")!.hidden).toBe(false);
    expect(fake.simple["[data-rcv-none]"]!.hidden).toBe(true);
    fake.simple["[data-rcv-q]"]!.value = "zzz";
    fake.simple["[data-rcv-q]"]!.listeners.input!({});
    expect(fake.simple["[data-rcv-none]"]!.hidden).toBe(false);
    // an unknown venue from the drawer: every account
    p.run('openReceive("nowhere")');
    await settle();
    expect(p.sheets[1]!.fake.simple["[data-rcv-only]"]!.hidden).toBe(true);
  });

  it("says so when no account gives an address, and offers nothing else", async () => {
    const p = account({ venues: [venue("watch", "Watched", { address: "0x2222222222222222222222222222222222222222", proven: "" })] });
    p.run("var TOASTS = []; toast = (t, k) => TOASTS.push([t, k])");
    p.run('openReceive("")');
    await settle();
    expect(p.sheets).toHaveLength(0);
    expect(p.run("TOASTS")).toEqual([["None of your accounts gives an address to send to from here. Connect a wallet you prove is yours, or an exchange whose key reads deposit addresses.", "no"]]);
  });
});
