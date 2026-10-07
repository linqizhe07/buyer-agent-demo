/** Attack on connecting a venue again with a new key — "Connect a new key" — when it is a SECOND account at an exchange:
 *
 *   rekey      "OKX Trading" (id okx-trading) reads its key from its own file. Connected again, the form used to start from the FIRST OKX
 *              account's file (credentials/okx/api-key.json): the check said "Ready." against that file, and the signed connectVenue made
 *              okx-trading read and trade the first account — its money counted twice, orders "at OKX Trading" landing in account one. The
 *              account now names each key-file venue's own file (venues[].keyFile, a path and never what is in it), the confirm names it,
 *              and the form starts from it
 *   new name   with no file named (an account from before), or when the owner names a second account in the form, the file follows the
 *              venue: credentials/<venue>/api-key.json, which is the file the server reads for that venue by default — never the first
 *              account's — until the owner types one
 *
 * The exchange library is a stand-in and the key files hold made-up values in a temporary home; nothing leaves the process. */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext, Script } from "node:vm";
import { afterAll, describe, expect, it } from "vitest";
import { isRefusal } from "../../src/core/errors.ts";
import { signOwner, simKey, type OwnerAction } from "../../src/portfolio/account/sign.ts";
import type { ExchangeClient, OpenExchange } from "../../src/portfolio/live/exchange.ts";
import type { LiveDeps } from "../../src/portfolio/live/index.ts";
import { PortfolioService } from "../../src/portfolio/service.ts";

type NoNonce<T> = T extends unknown ? Omit<T, "nonce"> : never;
const START = Date.parse("2026-10-06T10:00:00.000Z");
const PUBLIC = fileURLToPath(new URL("../../src/portfolio/public/", import.meta.url));
const owner = simKey("owner");
const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));

describe("the account names each key-file venue's own file", () => {
  it("two OKX accounts, each from its own file: venues[].keyFile is the file each was signed with — a path, not what is in it", async () => {
    const home = mkdtempSync(join(tmpdir(), "rekey-"));
    homes.push(home);
    const key = { apiKey: "made-up-key-0001", secret: "made-up-secret-0001", password: "made-up-passphrase" };
    for (const ref of ["credentials/okx/api-key.json", "credentials/okx2/key.json"]) {
      const path = join(home, ref);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(key));
      chmodSync(path, 0o600);
    }
    const client = { id: "okx", name: "OKX", requiredCredentials: { apiKey: true, secret: true, password: true }, markets: {}, loadMarkets: async () => ({}), fetchTime: async () => 1, fetchBalance: async () => ({ total: { USDT: 100 } }), fetchTickers: async () => ({}), privateGetAccountConfig: async () => ({ data: [{ perm: "read_only", ip: "", acctLv: "2" }] }) } as unknown as ExchangeClient;
    const open: OpenExchange = async (id) => (id === "okx" ? client : undefined);
    const liveDeps: Partial<LiveDeps> = { openExchange: open, clock: () => START, http: async () => ({ status: 599, body: undefined, text: "no network in tests" }), price: async () => undefined };
    let n = 0;
    const svc = await PortfolioService.create({ home, now: () => new Date(START).toISOString(), venues: "frontline", real: true, liveDeps, publicMarkets: [], account: { owners: [{ id: owner.address, kind: "eoa" as const, label: "owner", addedAt: new Date(START).toISOString() }] } });
    await svc.restoring;
    const own = async (a: NoNonce<OwnerAction>) => svc.exchange(await signOwner(owner, { ...a, nonce: START + ++n } as OwnerAction));
    for (const [venue, label, credentialRef] of [["okx", "OKX", ""], ["okx-trading", "OKX Trading", "credentials/okx2/key.json"]] as const) {
      const r = await own({ type: "connectVenue", venue, connector: "live:exchange:okx", label, credentialRef });
      if (isRefusal(r)) throw new Error(r.message);
    }
    const page = (await svc.accountView())!;
    expect(page.venues.filter((v) => v.live).map((v) => [v.id, v.connector, v.keyFile])).toEqual([
      ["okx", "live:exchange:okx", "credentials/okx/api-key.json"],
      ["okx-trading", "live:exchange:okx", "credentials/okx2/key.json"],
    ]);
    expect(JSON.stringify(page)).not.toContain("made-up");
  });
});

// ---- the page --------------------------------------------------------------------------------------------------------------------------

/** the page's scripts (core.js, connect.js, markets.js) in a stand-in browser with just enough of a document for the connect form: inputs
 * that keep a value and their listeners, a dialog that is open, and reads answered here */
function page() {
  const asked: string[] = [];
  const acts: unknown[] = [];
  const confirms: string[] = [];
  type El = Record<string, unknown> & { on: Record<string, Array<(e?: unknown) => unknown>>; value: string };
  const el = (extra: Record<string, unknown> = {}): El => {
    const on: El["on"] = {};
    return { on, addEventListener: (type: string, f: (e?: unknown) => unknown) => void (on[type] ??= []).push(f), removeAttribute() {}, setAttribute() {}, querySelectorAll: () => [], querySelector: () => null, classList: { add() {}, remove() {}, toggle() {} }, dataset: {}, style: {}, hidden: false, value: "", textContent: "", innerHTML: "", contains: () => false, open: true, showModal() {}, close() {}, ...extra } as El;
  };
  const form = el({ elements: { label: el(), ref: el() } });
  const byId = new Map<string, El>([["modal-form", form]]);
  const sandbox: Record<string, unknown> = {
    document: { getElementById: (id: string) => byId.get(id) ?? (byId.set(id, el()), byId.get(id)), querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, body: el(), documentElement: { dataset: {} }, hidden: false, activeElement: null },
    location: { hash: "#/markets", origin: "http://127.0.0.1:4877" },
    history: { replaceState() {} },
    Owner: { role: "owner", why: () => "", act: async (d: unknown) => (acts.push(d), { status: 200, body: { summary: "connected" } }) },
    Event: class {
      constructor(readonly type: string) {}
    },
    addEventListener() {},
    dispatchEvent: () => true,
    fetch: async (path: string) => {
      asked.push(path);
      const body = path === "/api/account/exchanges" ? { exchanges: [{ id: "okx", name: "OKX", needs: ["apiKey", "secret", "password"] }] } : path.startsWith("/api/account/keyfile") ? { ok: true, ready: false, path: "", fields: [], message: "there is no key file" } : {};
      return { ok: true, status: 200, json: async () => body };
    },
    console,
    URLSearchParams,
    Intl,
    Date,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval() {},
  };
  const ctx = createContext(sandbox);
  sandbox.window = runInContext("globalThis", ctx);
  for (const f of ["ui/core.js", "ui/connect.js", "ui/money.js", "ui/portfolio.js"]) new Script(readFileSync(join(PUBLIC, f), "utf8"), { filename: f }).runInContext(ctx);
  const run = <T = unknown>(code: string) => runInContext(code, ctx) as T;
  run("load = async () => {}; confirmSheet = async (t) => (CONFIRMS.push(t), true); own = async (d) => (ACTS.push(d), { status: 200, body: { ok: true, kind: 'account', summary: 'done' } })");
  sandbox.CONFIRMS = confirms;
  sandbox.ACTS = acts;
  const fire = (e: El, type: string) => (e.on[type] ?? []).forEach((f) => f());
  const keyfileAsks = () => asked.filter((p) => p.startsWith("/api/account/keyfile")).map((p) => Object.fromEntries(new URLSearchParams(p.split("?")[1])));
  return { run, form: form as El & { elements: { label: El; ref: El } }, acts, confirms, fire, keyfileAsks, settle: () => new Promise((r) => setTimeout(r, 5)) };
}

const venue = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, live: true, usd: 100, cashUsd: 0, holdings: [], asOf: new Date(START).toISOString(), plugged: true, connector: "live:exchange:okx", ...extra });
const account = (venues: unknown[]) => ({ now: new Date(START).toISOString(), venues, connectLive: { home: "/home/x", writes: { on: true, capUsd: 250 }, options: [{ kind: "exchange", connector: "live:exchange", needs: "key-file", label: "Exchange account · API key", venues: ["okx", "kraken"] }] }, watch: [], cards: [], orders: [], intents: [], asks: [], keys: [], requests: [], dial: { revoked: [] }, health: {}, mode: "guard" });
const first = venue("okx", "OKX", { keyFile: "credentials/okx/api-key.json", trade: { can: true, what: "spot", kinds: ["spot"] } });

describe("Connect a new key, for a second account at an exchange", () => {
  it("starts from that account's own file, names it in the confirm, and signs the connection with it", async () => {
    const p = page();
    p.run(`A = ${JSON.stringify(account([first, venue("okx-trading", "OKX Trading", { keyFile: "credentials/okx2/key.json", trade: { can: false, what: "spot", kinds: ["spot"] } })]))}`);
    await p.run("pfRekey('okx-trading')");
    await p.settle();
    expect(p.confirms[0]).toContain("Save the new key in the same file, /home/x/credentials/okx2/key.json, then");
    expect(p.acts).toEqual([{ type: "disconnectVenue", venue: "okx-trading" }]);
    expect([p.form.elements.label.value, p.form.elements.ref.value]).toEqual(["OKX Trading", "credentials/okx2/key.json"]);
    expect(p.keyfileAsks()[0]).toMatchObject({ venue: "okx-trading", ref: "credentials/okx2/key.json", exchange: "okx" });
    await (p.form.onsubmit as (e: unknown) => Promise<void>)({ preventDefault() {} });
    expect(p.acts.at(-1)).toEqual({ type: "connectVenue", venue: "okx-trading", connector: "live:exchange:okx", label: "OKX Trading", credentialRef: "credentials/okx2/key.json" });
  });

  it("on an account that names no file: the venue's own default, credentials/okx-trading/api-key.json — never the first account's", async () => {
    const p = page();
    p.run(`A = ${JSON.stringify(account([first, venue("okx-trading", "OKX Trading", { trade: { can: false, what: "spot", kinds: ["spot"] } })]))}`);
    await p.run("pfRekey('okx-trading')");
    await p.settle();
    expect(p.confirms[0]).toContain("Save the new key in the same file, then");
    expect(p.form.elements.ref.value).toBe("credentials/okx-trading/api-key.json");
    await (p.form.onsubmit as (e: unknown) => Promise<void>)({ preventDefault() {} });
    expect(p.acts.at(-1)).toMatchObject({ venue: "okx-trading", credentialRef: "credentials/okx-trading/api-key.json" });
  });

  it("connecting a second account from the OKX tile: naming it moves the file with it, until the owner types one", async () => {
    const p = page();
    p.run(`A = ${JSON.stringify(account([first]))}`);
    await p.run("openConnect(optionOf('exchange'), { exchange: 'okx', name: 'OKX' })");
    expect([p.form.elements.label.value, p.form.elements.ref.value]).toEqual(["OKX", "credentials/okx/api-key.json"]);
    p.form.elements.label.value = "OKX Trading";
    p.fire(p.form.elements.label, "input");
    expect(p.form.elements.ref.value).toBe("credentials/okx-trading/api-key.json");
    expect(p.keyfileAsks().at(-1)).toMatchObject({ venue: "okx-trading", ref: "credentials/okx-trading/api-key.json" });
    // a file the owner types stays, whatever the name becomes
    p.form.elements.ref.value = "credentials/okx-desk/key.json";
    p.fire(p.form.elements.ref, "input");
    p.form.elements.label.value = "OKX Desk";
    p.fire(p.form.elements.label, "input");
    expect(p.form.elements.ref.value).toBe("credentials/okx-desk/key.json");
    await (p.form.onsubmit as (e: unknown) => Promise<void>)({ preventDefault() {} });
    expect(p.acts.at(-1)).toEqual({ type: "connectVenue", venue: "okx-desk", connector: "live:exchange:okx", label: "OKX Desk", credentialRef: "credentials/okx-desk/key.json" });
  });
});
