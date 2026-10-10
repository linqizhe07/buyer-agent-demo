import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { isRefusal, type Refusal } from "../../src/core/errors.ts";
import type { AccountPage } from "../../src/portfolio/account/exchange.ts";
import { signAgent, signOwner, simKey, type AgentAction, type OwnerAction } from "../../src/portfolio/account/sign.ts";
import type { ExchangeClient, OpenExchange } from "../../src/portfolio/live/exchange.ts";
import type { LiveDeps } from "../../src/portfolio/live/index.ts";
import type { RunMm } from "../../src/portfolio/live/metamask.ts";
import { PortfolioService } from "../../src/portfolio/service.ts";

/** CONNECT AN ACCOUNT WHEN THE VENUE REFUSES THIS NETWORK (2026-10-10). The owner's rule: what a venue answers the network the Account runs
 * on — its place rule, its edge, no answer — decides nothing about the account's structure. A connection the owner signs is on the account
 * whatever the network said: kept with the key file's place as signed, read nowhere until the venue answers, asked again when a check of
 * this network finds the venue answering, and connected then with no owner action. The venue's own no about the key or the account is
 * final, as before. A user on another network gets the venue's own answer to that network: the same code, two outcomes. Every venue here
 * is a stand-in; the exchange is reached through the exchange connector's own path (exchangeSource), with a stand-in client */
type NoNonce<T> = T extends unknown ? Omit<T, "nonce"> : never;
const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));
afterEach(() => {
  vi.useRealTimers();
  Object.assign(net, { binance: "ok", asked: [] });
});
const owner = simKey("owner");
const cc = simKey("agent:claude-code");
let seq = 0;
const B = "live:exchange:binance";
/** Binance's 451, as its servers answer a network it does not serve (what the builder's machine was answered, 2026-10-07), with an address
 * put in its words so that the scrub can be seen to take it out */
const BINANCE_451 = `binance GET https://api.binance.com/api/v3/time 451 Unavailable For Legal Reasons {"code":0,"msg":"Service unavailable from a restricted location (203.0.113.9) according to 'b. Eligibility' in https://www.binance.com/en/terms. Please contact customer service if you believe you received this message in error."}`;

/** one network: what Binance answers it. `ok` answers; `451` refuses the place; `down` does not answer; `badkey` answers, and refuses the key */
const net = { binance: "ok" as "ok" | "451" | "down" | "badkey", asked: [] as string[] };
const openExchange: OpenExchange = async (id, key) =>
  ({
    id,
    name: id === "binance" ? "Binance" : id,
    has: {},
    requiredCredentials: { apiKey: true, secret: true },
    markets: {},
    async loadMarkets() {},
    async fetchTime() {
      net.asked.push(`${id} time${Object.keys(key).length ? " (with the key)" : ""}`);
      if (id !== "binance") return 1;
      if (net.binance === "451") throw Object.assign(new Error(BINANCE_451), { name: "ExchangeNotAvailable" });
      if (net.binance === "down") throw Object.assign(new Error("binance GET https://api.binance.com/api/v3/time getaddrinfo ENOTFOUND api.binance.com"), { name: "NetworkError" });
      return 1;
    },
    async fetchBalance() {
      net.asked.push(`${id} balance`);
      if (id === "binance" && net.binance === "badkey") throw Object.assign(new Error('binance {"code":-2014,"msg":"API-key format invalid."}'), { name: "AuthenticationError" });
      return { total: { USDT: 25 } };
    },
  }) as unknown as ExchangeClient;

const home = (): string => {
  const h = mkdtempSync(join(tmpdir(), "connect-waiting-"));
  homes.push(h);
  return h;
};
/** a made-up key file for Binance, readable by its owner only, as the connect form has the owner make it */
const keyFile = (h: string, venue = "binance"): void => {
  mkdirSync(join(h, "credentials", venue), { recursive: true });
  writeFileSync(join(h, "credentials", venue, "api-key.json"), JSON.stringify({ apiKey: "made-up-key-0009", secret: "made-up-secret-0009" }), { mode: 0o600 });
};
/** a real account on stand-ins, owned by `owner`, on the network `net` says */
async function account(h: string, deps: Partial<LiveDeps> = {}) {
  const svc = await PortfolioService.create({ home: h, venues: "frontline", real: true, publicMarkets: [], liveDeps: { http: async () => ({ status: 404, body: undefined, text: "" }), price: async () => undefined, mm: (async () => ({ authenticated: true })) as unknown as RunMm, openExchange, ...deps }, liveWrites: { capUsd: 100, pairingCode: "K7QX-M2PA" }, account: { owners: [{ id: owner.address, kind: "eoa", label: "owner", addedAt: new Date().toISOString() }] } });
  await svc.restoring;
  const own = async (a: NoNonce<OwnerAction>) => svc.exchange(await signOwner(owner, { ...a, nonce: Date.now() + ++seq } as OwnerAction));
  const ag = async (a: NoNonce<AgentAction>) => svc.exchange(await signAgent(cc, { ...a, nonce: Date.now() + ++seq } as AgentAction));
  const connect = (venue = "binance", label = "") => own({ type: "connectVenue", venue, connector: `live:exchange:${venue}`, label, credentialRef: "" });
  const waiting = async () => ((await svc.accountView()) as AccountPage).connectLive?.waiting ?? [];
  return { svc, own, ag, connect, waiting };
}
const summary = (x: unknown): string => {
  if (isRefusal(x)) throw new Error(`${x.code}: ${x.message}`);
  return (x as { summary: string }).summary;
};
const refusal = (x: unknown): Refusal => {
  if (!isRefusal(x)) throw new Error(`expected a refusal, got ${JSON.stringify(x).slice(0, 200)}`);
  return x;
};
/** every row of every ledger in the home, as text */
const ledgers = (h: string): string => readdirSync(join(h, "portfolio")).filter((n) => n.endsWith(".jsonl")).map((n) => readFileSync(join(h, "portfolio", n), "utf8")).join("\n");

describe("connecting a venue that refuses this network", () => {
  it("is taken, not refused: the connection is on the account, waiting, with Binance's words; the key is shown to no one; the agents are told; and it connects by itself once a check of this network finds Binance answering", async () => {
    const h = home();
    keyFile(h);
    net.binance = "451";
    const x = await account(h);
    const said = summary(await x.connect());
    expect(said).toContain("Binance is on the account, waiting for the venue to answer this network");
    expect(said).toContain("Binance does not serve this location");
    expect(said).toContain("asked again when a check of this network finds it answering");
    expect(said).toContain("the key file stays where you saved it");
    // the venue's words carried, the address in them not; the key never left this process (the clock refused first)
    expect(said).not.toContain("203.0.113.9");
    expect(net.asked).toEqual(["binance time (with the key)"]);
    expect(x.svc.adapter("binance")).toBeUndefined();
    // the page: one waiting connection, the key file's place as signed
    expect(await x.waiting()).toEqual([{ venue: "binance", name: "Binance", connector: B, needs: "key-file", keyFile: "credentials/binance/api-key.json", said: expect.stringContaining("Binance does not serve this location"), code: "E_VENUE_GEOBLOCKED", by: "venue", since: expect.any(String), how: "connect" }]);
    expect(x.svc.waitingWords("binance")).toContain("Binance is connected but has not answered this network yet");
    // the list of where the user can connect: on the account, waiting — Binance's own verdict for this network beside it
    const here = (await x.svc.venuesHere(true)).find((v) => v.connector === B)!;
    expect(here).toMatchObject({ verdict: "not-served", connected: true, waiting: expect.stringContaining("Check again") });
    // an agent asking the owner to connect Binance: there is nothing to ask for
    summary(await x.own({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: Date.now() + 30 * 86_400_000 }));
    const ask = refusal(await x.ag({ type: "agentAsk", kind: "venue", venue: "binance", usd: "0", text: "connect Binance" }));
    expect([ask.code, ask.message]).toEqual(["E_VENUE_GEOBLOCKED", expect.stringContaining("Binance is connected already and waits for the venue to answer the network this account runs on")]);
    // the ledger carries the owner's signed connection — and no address from Binance's words
    expect(ledgers(h)).toContain('"type":"connectVenue"');
    expect(ledgers(h)).not.toContain("203.0.113.9");

    // a forced check while Binance still refuses: its keyless question is asked (no key), its rule is not knocked on, the wait stands
    net.asked = [];
    await x.svc.connectReach([B], true);
    await new Promise((r) => setTimeout(r, 50));
    expect(net.asked).toEqual(["binance time"]);
    expect((await x.waiting())[0]!.said).not.toContain("203.0.113.9");
    // the laptop is on a network Binance serves, and the owner presses Check again: connected, with no owner action
    net.binance = "ok";
    net.asked = [];
    await x.svc.connectReach([B], true);
    await vi.waitFor(() => expect(x.svc.adapter("binance")?.account.watchOnly).toBeTruthy());
    expect(await x.waiting()).toEqual([]);
    expect(x.svc.waitingWords("binance")).toBeUndefined();
    expect(net.asked).toContain("binance balance");
    expect(ledgers(h)).toContain("Binance answered this network and is connected");
    expect(((await x.svc.accountView()) as AccountPage).venues.find((v) => v.id === "binance")).toMatchObject({ live: true });
  });

  it("the same connection on a network Binance serves is connected at once: one code, two outcomes, nothing of the builder's network in either", async () => {
    const h = home();
    keyFile(h);
    net.binance = "ok";
    const x = await account(h);
    expect(summary(await x.connect())).toContain("Binance connected live");
    expect(await x.waiting()).toEqual([]);
    expect(x.svc.adapter("binance")?.account.watchOnly).toBeTruthy();
  });

  it("a venue that did not answer is kept too, asked again on a backoff, and connected when it answers", async () => {
    const h = home();
    keyFile(h);
    // the clock is faked with the timers: the venue's keyless answer is kept twenty seconds on the account's clock, as long as the first wait
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    net.binance = "down";
    const x = await account(h);
    const said = summary(await x.connect());
    expect(said).toContain("waiting for the venue to answer this network");
    expect(said).toMatch(/asked again in \d+ s/);
    expect((await x.waiting())[0]).toMatchObject({ code: "E_VENUE_UNREACHABLE", how: "connect", said: expect.stringMatching(/asked again in 20 s$/) });
    // twenty seconds on (a venue that did not answer is held that long before anything asks it again), still down: asked, and waiting longer
    await vi.advanceTimersByTimeAsync(21_000);
    expect((await x.waiting())[0]!.said).toMatch(/asked again in 30 s$/);
    // the network is up: the next ask connects it
    net.binance = "ok";
    await vi.advanceTimersByTimeAsync(31_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(x.svc.adapter("binance")?.account.watchOnly).toBeTruthy();
    expect(await x.waiting()).toEqual([]);
  });

  it("the venue's own no about the key, or a key file that is not there, is a refusal as before: nothing is kept on a no that is not the network's", async () => {
    const h = home();
    const x = await account(h);
    // no key file yet: the account's own check, before anything is sent
    const none = refusal(await x.connect());
    expect(none.code).toBe("E_ACCOUNT_CREDENTIAL");
    expect(await x.waiting()).toEqual([]);
    // the key file is there, and Binance refuses the key itself
    keyFile(h);
    net.binance = "badkey";
    const bad = refusal(await x.connect());
    expect([bad.code, bad.message]).toEqual(["E_VENUE_UNAUTHORIZED", "Binance does not accept this key"]);
    expect(await x.waiting()).toEqual([]);
    expect(x.svc.adapter("binance")).toBeUndefined();
  });

  it("after a wait, a venue that answers and refuses the connection itself stops the asking but keeps the connection in view, with its words; no check asks it again, and the owner's next signature connects it", async () => {
    const h = home();
    keyFile(h);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    net.binance = "down";
    const x = await account(h);
    summary(await x.connect());
    // the network is up, and Binance refuses the key: not asked again on its own, said so, still on the account for the owner to decide
    net.binance = "badkey";
    await vi.advanceTimersByTimeAsync(21_000);
    await vi.waitFor(async () => expect((await x.waiting())[0]).toMatchObject({ stopped: true, code: "E_VENUE_UNAUTHORIZED", by: "venue", said: "Binance does not accept this key. Not asked again: connect it again, or disconnect it" }));
    expect(x.svc.waitingWords("binance")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(net.asked.filter((a) => a.includes("balance"))).toHaveLength(1);
    // to the lists and the agents it is neither connected nor waiting: nothing is read from it, and the owner decides; an agent's ask for
    // it goes to the owner, as for any venue that answers this network
    const listed = (await x.svc.venuesHere(true)).find((v) => v.connector === B)!;
    expect([listed.connected, listed.waiting, listed.verdict]).toEqual([false, undefined, "connectable"]);
    summary(await x.own({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: Date.now() + 30 * 86_400_000 }));
    expect(isRefusal(await x.ag({ type: "agentAsk", kind: "venue", venue: "binance", usd: "0", text: "connect Binance" }))).toBe(false);
    // the owner mended the key at Binance: a check of the network (Check again, the half-hourly one) does not knock on Binance with the
    // key for them; their own signature does, and connects it
    net.binance = "ok";
    vi.useRealTimers();
    await x.svc.connectReach([B], true);
    await new Promise((r) => setTimeout(r, 50));
    expect([x.svc.adapter("binance"), net.asked.filter((a) => a.includes("balance")).length]).toEqual([undefined, 1]);
    expect(summary(await x.connect())).toContain("Binance connected live");
    expect(await x.waiting()).toEqual([]);
    // the agents' list no longer says it waits
    expect((await x.svc.venuesHere(true)).find((v) => v.connector === B)).toMatchObject({ connected: true, verdict: "connectable" });
    expect((await x.svc.venuesHere(true)).find((v) => v.connector === B)!.waiting).toBeUndefined();
  });

  it("a stopped connection is disconnected like a waiting one, and says whose no it was", async () => {
    const h = home();
    keyFile(h);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    net.binance = "down";
    const x = await account(h);
    summary(await x.connect());
    net.binance = "badkey";
    await vi.advanceTimersByTimeAsync(21_000);
    await vi.waitFor(async () => expect((await x.waiting())[0]?.stopped).toBe(true));
    const gone = summary(await x.own({ type: "disconnectVenue", venue: "binance" }));
    expect(gone).toContain("Binance is disconnected: the venue had refused the connection, and the account will not ask it again");
    expect(await x.waiting()).toEqual([]);
  });

  it("a restart whose key file is gone keeps the connection in view as this account's own no, not the venue's", async () => {
    const h = home();
    keyFile(h);
    net.binance = "451";
    const a = await account(h);
    summary(await a.connect());
    rmSync(join(h, "credentials"), { recursive: true, force: true });
    net.binance = "ok";
    const b = await account(h);
    expect(b.svc.restored?.venues).toEqual([{ venue: "binance", ok: false, why: expect.stringContaining("there is no key file at credentials/binance/api-key.json") }]);
    expect((await b.waiting())[0]).toMatchObject({ venue: "binance", stopped: true, by: "account", code: "E_ACCOUNT_CREDENTIAL", how: "restart", said: expect.stringContaining("Not asked again: connect it again, or disconnect it") });
    expect(b.svc.waitingWords("binance")).toBeUndefined();
    const listed = (await b.svc.venuesHere(true)).find((v) => v.connector === B)!;
    expect([listed.connected, listed.waiting]).toEqual([false, undefined]);
    expect(summary(await b.own({ type: "disconnectVenue", venue: "binance" }))).toContain("Binance is disconnected: this account could not open it");
    expect(b.svc.restored?.venues).toEqual([{ venue: "binance", ok: false, why: "disconnected by the owner after it could not be connected" }]);
  });

  it("connected again by the owner while a restart was bringing it back, the restore report follows the connection to its end", async () => {
    const h = home();
    keyFile(h);
    net.binance = "451";
    const a = await account(h);
    summary(await a.connect());
    const b = await account(h);
    expect(b.svc.restored?.venues[0]).toMatchObject({ ok: false, waiting: true });
    // the owner connects it again from its tile while Binance still refuses: the same wait, under the owner's new signature
    summary(await b.connect("binance", "Binance · spot"));
    expect((await b.waiting())[0]).toMatchObject({ name: "Binance · spot", how: "connect" });
    expect(b.svc.restored?.venues[0]).toMatchObject({ venue: "binance", ok: false, waiting: true });
    // Binance answers: connected, and the restart's report says so too
    net.binance = "ok";
    await b.svc.connectReach([B], true);
    await vi.waitFor(() => expect(b.svc.adapter("binance")).toBeDefined());
    expect(b.svc.restored?.venues).toEqual([{ venue: "binance", ok: true }]);
    expect(await b.waiting()).toEqual([]);
  });

  it("outlives a restart: the signed connection is brought back waiting, with no owner action; disconnected while waiting, it is gone for good", async () => {
    const h = home();
    keyFile(h);
    net.binance = "451";
    const a = await account(h);
    summary(await a.connect("binance", "Binance · main"));
    expect((await a.waiting())[0]).toMatchObject({ name: "Binance · main", how: "connect" });
    // a restart on the same network: the restore meets the same refusal and keeps the connection waiting, as the owner left it
    const b = await account(h);
    expect(b.svc.restored?.venues).toEqual([{ venue: "binance", ok: false, why: "connecting again", waiting: true, said: expect.stringContaining("does not serve this location") }]);
    expect((await b.waiting())[0]).toMatchObject({ venue: "binance", name: "Binance · main", how: "restart", code: "E_VENUE_GEOBLOCKED", keyFile: "credentials/binance/api-key.json" });
    expect(b.svc.waitingWords("binance")).toContain("has not come back after the restart yet");
    // the owner disconnects it while it waits: the asking ends, the key file is left alone
    const gone = summary(await b.own({ type: "disconnectVenue", venue: "binance" }));
    expect(gone).toContain("Binance · main is disconnected: it was waiting to come back after the restart");
    expect(gone).toContain("The key at the venue is untouched");
    expect(await b.waiting()).toEqual([]);
    expect(b.svc.restored?.venues).toEqual([{ venue: "binance", ok: false, why: "disconnected by the owner while it was waiting to come back" }]);
    // another restart: nothing to bring back
    const c = await account(h);
    expect(c.svc.restored?.venues).toEqual([]);
    expect(await c.waiting()).toEqual([]);
    expect(ledgers(h)).not.toContain("203.0.113.9");
  });

  it("connecting a waiting venue again replaces the wait: a new label, the same key file", async () => {
    const h = home();
    keyFile(h);
    net.binance = "451";
    const x = await account(h);
    summary(await x.connect());
    summary(await x.connect("binance", "Binance · spot"));
    const w = await x.waiting();
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ name: "Binance · spot", keyFile: "credentials/binance/api-key.json" });
  });
});
