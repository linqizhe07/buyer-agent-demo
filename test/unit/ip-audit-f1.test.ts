import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { isRefusal, type Refusal } from "../../src/core/errors.ts";
import { cardHash, type Outcome } from "../../src/portfolio/account/exchange.ts";
import { signAgent, signOwner, simKey, type AgentAction, type OwnerAction } from "../../src/portfolio/account/sign.ts";
import { liveAccount } from "../../src/portfolio/adapters/live.ts";
import type { ExchangeClient, OpenExchange } from "../../src/portfolio/live/exchange.ts";
import { register, type LiveDeps } from "../../src/portfolio/live/index.ts";
import type { RunMm } from "../../src/portfolio/live/metamask.ts";
import type { Listing, PublicSource } from "../../src/portfolio/live/public-markets.ts";
import type { LiveTrader, Market } from "../../src/portfolio/live/trade.ts";
import { bannedNo, type LiveSource } from "../../src/portfolio/live/types.ts";
import { no } from "../../src/portfolio/refuse.ts";
import { PortfolioService } from "../../src/portfolio/service.ts";

/** The IP audit's findings on the service's own keeping (2026-10-09): how a venue's hold is kept — the later of its refusals, reads that
 * waited their turn, a ban of this address across the keyless source and the keyed connection, another party's refusal apart from the
 * venue's, a write that never reached the venue — what a re-check of the network the user is on now learns again, a restart that asks
 * again for a venue that did not answer at login, and a balance read that waits out the venue's hold. Nothing leaves the process; every
 * venue is a stand-in. Addresses are from the documentation ranges (RFC 5737, RFC 3849) */
type NoNonce<T> = T extends unknown ? Omit<T, "nonce"> : never;
const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));
afterEach(() => vi.useRealTimers());
const home = () => {
  const h = mkdtempSync(join(tmpdir(), "ip-audit-f1-"));
  homes.push(h);
  return h;
};
const owner = simKey("owner");
const cc = simKey("agent:claude-code");
const MIN = 60_000;
let seq = 0;
const refusal = (x: unknown): Refusal => {
  if (!isRefusal(x)) throw new Error(`expected a refusal, got ${JSON.stringify(x).slice(0, 200)}`);
  return x;
};
const ok = <T>(x: T | Refusal): T => {
  if (isRefusal(x)) throw new Error(`${x.code}: ${x.message}`);
  return x;
};

const BTC: Market = { symbol: "BTC/USDT", name: "BTC/USDT", kind: "spot", base: "BTC", quote: "USDT", price: 60_000, bid: 59_990, ask: 60_010, minQty: 0.0001, qtyStep: 0.0001, priceStep: 0.1, open: true, types: ["market", "limit"] };
/** what the stand-in venue answers each read, and how many reads reached it */
const desk = { answer: (_what: string, sym: string): Promise<unknown> => Promise.resolve({ ...BTC, symbol: sym }), asked: 0, opens: [] as Array<() => Refusal | undefined> };
const trader: LiveTrader = {
  can: true,
  what: "spot",
  async markets(q) {
    desk.asked++;
    return (await desk.answer("markets", q)) as Market[] | Refusal;
  },
  async market(symbol) {
    desk.asked++;
    return (await desk.answer("market", symbol)) as Market | Refusal;
  },
  async positions() {
    return [];
  },
  async place(o) {
    return { ref: "r-1", status: "open", filledQty: 0, native: { qty: o.qty } };
  },
  async cancel(ref) {
    return { ref, status: "canceled", filledQty: 0, native: {} };
  },
  async status(ref) {
    return { ref, status: "open", filledQty: 0, native: {} };
  },
};
register({
  kind: "f1-standin",
  label: "a stand-in venue",
  needs: "key-file",
  example: "",
  venues: [],
  async open(req) {
    // a queue of how the next connects go: a refusal (no answer at login), or through
    const next = desk.opens.shift()?.();
    if (next) return next;
    return { source: { name: req.label || "Stand-in", kind: "cex", reference: "standin", via: "a stand-in", probe: { can: ["read", "trade"], note: "" }, read: async () => [{ asset: "USDT", amount: 500, usd: 500 }], trader, readOnlyBecause: "the stand-in moves no money" }, first: [{ asset: "USDT", amount: 500, usd: 500 }], summary: "connected" };
  },
});

/** a real account on stand-ins, owned by `owner`, with real-money writes on (cards are raised for agents' orders in Guard) */
async function account(o: { publicMarkets?: PublicSource[]; liveDeps?: Partial<LiveDeps>; at?: string } = {}) {

  const h = o.at ?? home();
  const svc = await PortfolioService.create({ home: h, venues: "frontline", real: true, publicMarkets: o.publicMarkets ?? [], liveDeps: { http: async () => ({ status: 404, body: undefined, text: "" }), price: async () => undefined, mm: (async () => ({ authenticated: true })) as unknown as RunMm, ...o.liveDeps }, liveWrites: { capUsd: 100, pairingCode: "K7QX-M2PA" }, account: { owners: [{ id: owner.address, kind: "eoa", label: "owner", addedAt: new Date().toISOString() }] } });
  await svc.restoring;
  const own = async (a: NoNonce<OwnerAction>) => svc.exchange(await signOwner(owner, { ...a, nonce: Date.now() + ++seq } as OwnerAction));
  const ag = async (a: NoNonce<AgentAction>) => svc.exchange(await signAgent(cc, { ...a, nonce: Date.now() + ++seq } as AgentAction));
  const plug = async (venue = "ex") => ok(await own({ type: "connectVenue", venue, connector: "live:f1-standin", label: "Stand-in", credentialRef: "" }));
  return { svc, own, ag, plug, home: h };
}
const banned = (venue: string, ms = 2 * 3_600_000) => bannedNo(venue, "Stand-in", Date.now() + ms, { status: 418 });

describe("a venue's hold in the service's read cache", () => {
  it("is kept until the LATER of its refusals: a timeout after a ban does not cut it to twenty seconds, nor does one after a place rule", async () => {
    const { svc, plug } = await account();
    await plug();
    // two reads at once: the ban lands first, the timeout of the other a moment later
    desk.answer = (_w, sym) => (sym === "A" ? Promise.resolve(banned("ex")) : new Promise((r) => setTimeout(() => r(no("E_VENUE_UNREACHABLE", { venue: "ex", message: "Stand-in did not answer" })), 20)));
    const [a, b] = await Promise.all([svc.liveMarket("ex", "A"), svc.liveMarket("ex", "B")]);
    expect([refusal(a).message, refusal(b).message]).toEqual([expect.stringContaining("has banned this machine's address"), "Stand-in did not answer"]);
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 5 * MIN });
    desk.asked = 0;
    // five minutes on: a 20-second hold would have run out; the ban's holds, in its words, and nothing is asked
    expect(refusal(await svc.liveMarket("ex", "C")).message).toContain("has banned this machine's address");
    expect(desk.asked).toBe(0);
    vi.useRealTimers();

    // a place rule, then no answer: the place rule's ten minutes stand, in its words
    const p = await account();
    await p.plug();
    desk.answer = (_w, sym) => (sym === "A" ? Promise.resolve(no("E_VENUE_GEOBLOCKED", { venue: "ex", message: "Stand-in does not serve this location" })) : new Promise((r) => setTimeout(() => r(no("E_VENUE_UNREACHABLE", { venue: "ex", message: "Stand-in did not answer" })), 20)));
    await Promise.all([p.svc.liveMarket("ex", "A"), p.svc.liveMarket("ex", "B")]);
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + MIN });
    expect(refusal(await p.svc.liveMarket("ex", "C")).message).toBe("Stand-in does not serve this location");
  });

  it("a read that waited its turn is not sent after the venue answered a ban: ten reads, at most the two already on their way reach it", async () => {
    const { svc, plug } = await account();
    await plug();
    desk.asked = 0;
    desk.answer = () => new Promise((r) => setTimeout(() => r(banned("ex")), 10));
    const all = await Promise.all(Array.from({ length: 10 }, (_, i) => svc.liveMarket("ex", `S${i}`)));
    expect(all.every((x) => isRefusal(x) && /banned this machine's address/.test(x.message))).toBe(true);
    expect(desk.asked).toBe(2);
  });

  it("another party's refusal (LI.FI for a wallet's swaps) holds the trader's reads only, and is not the venue's own health", async () => {
    const { svc, plug } = await account();
    await plug("w");
    desk.answer = () => Promise.resolve(no("E_VENUE_GEOBLOCKED", { venue: "w", message: "LI.FI refuses this network", native: { status: 403, edge: true, party: "lifi" } }));
    expect(refusal(await svc.liveMarket("w", "WETH/USDC@Base")).message).toBe("LI.FI refuses this network");
    desk.asked = 0;
    // the trader's other reads wait it out, asking nothing; what the wallet holds is still read
    expect(refusal(await svc.liveMarkets("w", "ETH")).message).toBe("LI.FI refuses this network");
    expect(desk.asked).toBe(0);
    expect(ok(await svc.livePositions("w"))).toEqual([]);
    expect(svc.venueHealth().w?.lastFailAt).toBeUndefined();
  });

  it("a keyless source's refusal on the network before does not hold the venue connected after under the same id — a ban of the address does", async () => {
    const edge = no("E_VENUE_GEOBLOCKED", { venue: "okx", message: "OKX refuses this network: the server in front of it answered HTTP 403", native: { status: 403, edge: true } });
    let pub: Listing[] | Refusal = edge;
    const okxPublic: PublicSource = { id: "okx", name: "OKX", kind: "exchange", connectTo: "okx", connector: "live:exchange:okx", listings: async () => pub };
    const { svc, plug } = await account({ publicMarkets: [okxPublic] });
    const source = (svc as unknown as { publicMarkets(): PublicSource[] }).publicMarkets()[0]!;
    expect(refusal(await source.listings({ limit: 5 })).code).toBe("E_VENUE_GEOBLOCKED");
    // connected on the next network, under the same id: its own reads reach it, and its health is its own
    await plug("okx");
    desk.answer = (_w, sym) => Promise.resolve({ ...BTC, symbol: sym });
    expect(ok(await svc.liveMarket("okx", "BTC/USDT")).symbol).toBe("BTC/USDT");
    expect(svc.venueHealth().okx).toMatchObject({ lastOkAt: expect.any(String) });
    expect(svc.venueHealth().okx?.lastFailAt).toBeUndefined();
    // the keyless source is still held by its own refusal
    pub = [];
    expect(refusal(await source.listings({ limit: 5 })).code).toBe("E_VENUE_GEOBLOCKED");
    // a ban of this machine's address, met by the keyless source, holds the keyed connection too
    const stats: PublicSource = { ...okxPublic, id: "okx", listings: async () => banned("okx") };
    const b = await account({ publicMarkets: [stats] });
    await b.plug("okx");
    const s2 = (b.svc as unknown as { publicMarkets(): PublicSource[] }).publicMarkets()[0]!;
    expect(refusal(await s2.listings({ limit: 5 })).message).toContain("has banned this machine's address");
    desk.asked = 0;
    expect(refusal(await b.svc.liveMarket("okx", "BTC/USDT")).message).toContain("has banned this machine's address");
    expect(desk.asked).toBe(0);
  });

  it("a card the owner rejected reached no venue: the venue's ban stands", async () => {
    const { svc, own, ag, plug } = await account();
    await plug();
    desk.answer = (_w, sym) => Promise.resolve({ ...BTC, symbol: sym });
    ok(await own({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: Date.now() + 30 * 86_400_000 }));
    ok(await own({ type: "approveSpend", agent: cc.address, scope: "trade", allow: "*", perPayment: "50", budget: "100", windowHours: 0, validUntil: Date.now() + 7 * 86_400_000 }));
    const asked = ok(await ag({ type: "agentLiveOrder", venue: "ex", symbol: "BTC/USDT", side: "buy", orderType: "limit", qty: "0.0005", usd: "", limitPrice: "50000" })) as Outcome;
    if (isRefusal(asked) || asked.kind !== "card") throw new Error(`expected a card, got ${JSON.stringify(asked).slice(0, 200)}`);
    // the venue bans this address meanwhile
    desk.answer = () => Promise.resolve(banned("ex"));
    refusal(await svc.liveMarket("ex", "ETH/USDT"));
    const rejected = ok(await own({ type: "approveCard", card: asked.card.id, action: cardHash(asked.card), decision: "reject" })) as Outcome;
    expect(!isRefusal(rejected) && rejected.kind === "result" && isRefusal(rejected.result) && rejected.result.code).toBe("E_CARD_REJECTED");
    desk.asked = 0;
    expect(refusal(await svc.liveMarket("ex", "SOL/USDT")).message).toContain("has banned this machine's address");
    expect(desk.asked).toBe(0);
    // the doors share the one hold: they see the ban, and a shorter refusal one of them meets does not cut it
    const money = svc.account!.host.liveMoney!() as unknown as { held(v: string): Refusal | undefined; hold(v: string, r: Refusal): void };
    expect(money.held("ex")?.message).toContain("has banned this machine's address");
    money.hold("ex", no("E_VENUE_UNREACHABLE", { venue: "ex", message: "Stand-in did not answer" }));
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + MIN });
    expect(money.held("ex")?.message).toContain("has banned this machine's address");
  });
});

describe("the venues the mm connection reaches, a venue's words on the ledger, and a place rule on a comparison's rows", () => {
  it("one inner venue's hold (Polymarket through mm) holds that venue's reads only; mm itself not running holds them all", async () => {
    const { svc, plug } = await account();
    await plug("mm");
    // the connection as mm makes it
    svc.adapter("mm")!.account.connector = "live:metamask";
    desk.answer = (_w, sym) => Promise.resolve(sym.includes(":") ? no("E_VENUE_GEOBLOCKED", { venue: "mm", message: "Polymarket does not serve this location", native: { code: "GEOBLOCKED" } }) : { ...BTC, symbol: sym });
    refusal(await svc.liveMarket("mm", "fed-cut:yes"));
    desk.asked = 0;
    expect(refusal(await svc.liveMarket("mm", "election:no")).message).toBe("Polymarket does not serve this location");
    expect(ok(await svc.liveMarket("mm", "WETH/USDC@Base")).symbol).toBe("WETH/USDC@Base");
    expect(ok(await svc.liveMarket("mm", "BTC-PERP")).symbol).toBe("BTC-PERP");
    expect(ok(await svc.livePositions("mm"))).toEqual([]);
    expect(desk.asked).toBe(2);
    // mm cannot run on this machine: every read of the connection waits it out
    desk.answer = () => Promise.resolve(no("E_VENUE_UNREACHABLE", { venue: "mm", message: "mm could not run on this machine", native: { code: "ENOENT" } }));
    refusal(await svc.liveMarket("mm", "SOL/USDC@Solana"));
    desk.asked = 0;
    expect(refusal(await svc.liveMarket("mm", "ETH-PERP")).message).toBe("mm could not run on this machine");
    expect(refusal(await svc.liveMarkets("mm", "ETH")).message).toBe("mm could not run on this machine");
    expect(desk.asked).toBe(0);
  });

  it("a venue's words that never passed through no() are written to the ledger and shown with this machine's address taken out", async () => {
    register({ kind: "f1-chatty", label: "a chatty stand-in", needs: "key-file", example: "", venues: [], async open() {
      return { source: { name: "Chatty", kind: "cex", reference: "standin", via: "a stand-in", probe: { can: ["read"], note: "" }, read: async () => [], readOnlyBecause: "it sends nothing to 198.51.100.4" }, first: [], summary: "connected from 203.0.113.9 (2001:db8::7)" };
    } });
    const { svc, own } = await account();
    const r = ok(await own({ type: "connectVenue", venue: "chat", connector: "live:f1-chatty", label: "", credentialRef: "" }));
    expect(JSON.stringify([r, svc.rows()])).not.toMatch(/203\.0\.113|2001:db8|198\.51\.100/);
    expect(JSON.stringify(svc.rows())).toContain("connected from (this machine's address)");
    expect(svc.adapter("chat")!.account.readOnlyBecause).toBe("it sends nothing to (this machine's address)");
  });

  it("Hyperliquid's line closes this network: it is left out of the comparison (only where an order could go from here is compared) — no place, no address", async () => {
    const http: LiveDeps["http"] = async (url: string) => (url.includes("polymarket.com/api/geoblock") ? { status: 200, body: { blocked: true, country: "US", region: "PA", ip: "203.0.113.9" }, text: "" } : { status: 404, body: undefined, text: "" });
    const { svc, plug } = await account({ liveDeps: { http } });
    await plug("hl");
    svc.adapter("hl")!.account.connector = "live:hyperliquid-trade";
    desk.answer = (w, q) => Promise.resolve(w === "markets" ? [BTC] : { ...BTC, symbol: q });
    desk.asked = 0;
    const c = ok(await svc.liveCompare("BTC", "buy"));
    expect(c.rows.find((x) => x.venue === "hl")).toBeUndefined();
    expect(desk.asked).toBe(0);
    expect(JSON.stringify(c)).not.toMatch(/203\.0\.113|"US"|\bPA\b/);
  });
});

describe("a balance read waits out the venue's hold (adapters/live.ts)", () => {
  const source = (read: () => Promise<never>): LiveSource => ({ name: "Stand-in", kind: "cex", reference: "standin", via: "a stand-in", probe: { can: ["read"], note: "" }, read });
  it("a ban until a time, an edge page: not asked again before the hold runs out; the last good numbers stay", async () => {
    let t = 1_000_000;
    let reads = 0;
    const a = await liveAccount("v", source(async () => (reads++, Promise.reject(banned("v", 30 * MIN)))), { connector: "live:f1-standin", clock: () => t, first: [{ asset: "USDT", amount: 5, usd: 5 }], ttlMs: 30_000 });
    t += 31_000;
    expect(await a.read()).toMatchObject([{ asset: "USDT", usd: 5 }]);
    expect(reads).toBe(1);
    // fifteen seconds would have asked again; the ban's thirty minutes do not
    t += 5 * MIN;
    await a.read();
    expect([reads, a.account.stale]).toEqual([1, expect.stringContaining("has banned this machine's address")]);
    t += 26 * MIN;
    await a.read();
    expect(reads).toBe(2);

    let edgeReads = 0;
    const e = await liveAccount("e", source(async () => (edgeReads++, Promise.reject(no("E_VENUE_GEOBLOCKED", { venue: "e", message: "Stand-in refuses this network", native: { status: 403, edge: true } })))), { connector: "live:f1-standin", clock: () => t, ttlMs: 30_000 });
    await e.read();
    t += 9 * MIN;
    await e.read();
    expect(edgeReads).toBe(1);
    t += 2 * MIN;
    await e.read();
    expect(edgeReads).toBe(2);
  });

  it("a hold the service keeps for the venue's market reads holds its balance read too, and its own refusal is handed to them", async () => {
    let reads = 0;
    let held: Refusal | undefined = banned("v");
    const met: Refusal[] = [];
    const a = await liveAccount("v", source(async () => (reads++, Promise.reject(no("E_VENUE_UNREACHABLE", { venue: "v", message: "Stand-in did not answer" })))), { connector: "live:f1-standin", ttlMs: 1, held: () => held, refused: (r) => (met.push(r), false) });
    await a.read();
    expect([reads, a.account.stale]).toEqual([0, expect.stringContaining("has banned this machine's address")]);
    held = undefined;
    await new Promise((r) => setTimeout(r, 2));
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 20_000 });
    await a.read();
    expect([reads, met.map((r) => r.message)]).toEqual([1, ["Stand-in did not answer"]]);
  });

  it("a read in part (an address source that could not read all of it): what was read stands, the page says what was not, asked again soon", async () => {
    let t = 1_000_000;
    let reads = 0;
    let missing: string | undefined = "Base did not answer for 203.0.113.5: its balances there are not counted";
    const src: LiveSource = { name: "Wallet", kind: "cex", reference: "0xabc", via: "chains", address: "0xabc", probe: { can: ["read"], note: "" }, read: async () => (reads++, [{ asset: "USDC", amount: 7, usd: 7 }]), unread: () => missing };
    const a = await liveAccount("w", src, { connector: "live:wallet", clock: () => t, ttlMs: 60_000 });
    expect(await a.read()).toMatchObject([{ asset: "USDC", usd: 7 }]);
    expect(a.account.stale).toBe("Base did not answer for (this machine's address): its balances there are not counted");
    t += 16_000;
    missing = undefined;
    await a.read();
    expect([reads, a.account.stale]).toEqual([2, undefined]);
  });

  it("a raw exception's words are served with this machine's address taken out, before they are cut", async () => {
    const a = await liveAccount("rh", source(async () => Promise.reject(new Error(`Streamable HTTP error: Error POSTing to endpoint: blocked for 203.0.113.7 and 2001:db8::1 in your region ${"x".repeat(150)} 198.51.100.23`))), { connector: "live:f1-standin" });
    await a.read();
    expect(a.account.stale).not.toMatch(/203\.0\.113|2001:db8|198\.51\.100/);
    expect(a.account.stale).toContain("(this machine's address)");
  });
});

// ---- where the user can connect, judged again from the network the user is on now ----

/** a network: where Polymarket's check says it is, and whether Binance refuses it (451) or bans this address (418) */
const net = { country: "US", region: "PA", binance: "ok" as "ok" | "451" | "418" | "slow", binanceus: "ok" as "ok" | "timeout", asked: [] as string[] };
const http: LiveDeps["http"] = async (url: string) => {
  if (url.includes("polymarket.com/api/geoblock")) {
    const body = { blocked: net.country === "US", country: net.country, region: net.region };
    return { status: 200, body, text: JSON.stringify(body) };
  }
  return url.includes("kalshi") ? { status: 200, body: {}, text: "{}" } : { status: 400, body: undefined, text: "missing headers" };
};
let release: (() => void) | undefined;
const openExchange: OpenExchange = async (id) =>
  ({
    id,
    name: id === "binance" ? "Binance" : id,
    has: {},
    fetchTime: async () => {
      net.asked.push(id);
      // answered as the network was when it was asked
      const was = net.binance;
      if (id === "binance" && was === "slow") await new Promise<void>((r) => (release = r));
      if (id === "binance" && (was === "451" || was === "slow")) throw Object.assign(new Error('binance GET https://api.binance.com/api/v3/time 451 {"code":0,"msg":"Service unavailable from a restricted location"}'), { name: "ExchangeNotAvailable" });
      if (id === "binance" && was === "418") throw Object.assign(new Error(`binance 418 I'm a teapot {"code":-1003,"msg":"Way too much request weight used; IP banned until ${Date.now() + 2 * 3_600_000}. Please use WebSocket Streams for live updates to avoid bans."}`), { name: "DDoSProtection" });
      if (id === "binanceus" && net.binanceus === "timeout") {
        net.binanceus = "ok";
        throw Object.assign(new Error("binanceus GET https://api.binance.us/api/v3/time request timed out (10000 ms)"), { name: "RequestTimeout" });
      }
      return 1;
    },
  }) as unknown as ExchangeClient;
const verdicts = (v: Array<{ connector: string; verdict: string; edition?: { connector: string } | undefined }>, ...cs: string[]) => Object.fromEntries(v.filter((x) => cs.includes(x.connector)).map((x) => [x.connector, [x.verdict, x.edition?.connector ?? ""]]));
const B = "live:exchange:binance";

describe("a forced re-check of the network the user is on now", () => {
  afterEach(() => Object.assign(net, { country: "US", region: "PA", binance: "ok", binanceus: "ok", asked: [] }));

  it("learns the place again: moved from Pennsylvania to a place every venue serves, Binance is connectable and no edition is offered — and back", async () => {
    const { svc } = await account({ liveDeps: { http, openExchange } });
    Object.assign(net, { country: "US", region: "PA", binance: "451" });
    expect(verdicts(await svc.venuesHere(true), B)).toEqual({ [B]: ["not-served", "live:exchange:binanceus"] });
    Object.assign(net, { country: "AR", region: "B", binance: "ok" });
    expect(verdicts(await svc.venuesHere(true), B, "live:hyperliquid-trade", "live:polymarket-trade")).toEqual({ [B]: ["connectable", ""], "live:hyperliquid-trade": ["connectable", ""], "live:polymarket-trade": ["connectable", ""] });
    Object.assign(net, { country: "US", region: "PA", binance: "451" });
    expect(verdicts(await svc.venuesHere(true), B)).toEqual({ [B]: ["not-served", "live:exchange:binanceus"] });
  });

  it("is not folded into an ordinary refresh already on its way: it is asked after it, and its answer is the one kept", async () => {
    const { svc } = await account({ liveDeps: { http, openExchange } });
    svc.venuePlace = async () => ({ country: "AR", region: "B" });
    net.binance = "slow";
    const plain = svc.venuesHere(false);
    await vi.waitFor(() => expect(release).toBeDefined());
    // the laptop is on another network now, and the user presses Check again
    net.binance = "ok";
    const forced = svc.venuesHere(true);
    release!();
    expect(verdicts(await plain, B)).toEqual({ [B]: ["not-served", ""] });
    expect(verdicts(await forced, B)).toEqual({ [B]: ["connectable", ""] });
    expect(verdicts(await svc.venuesHere(false), B)).toEqual({ [B]: ["connectable", ""] });
    release = undefined;
  });

  it("a list with a venue that did not answer, or no place, is asked again after twenty seconds, not thirty minutes, behind the list kept: the edition comes back with the answer", async () => {
    let now = Date.parse("2026-10-09T15:00:00.000Z");
    const { svc } = await account({ liveDeps: { http, openExchange, clock: () => now } });
    svc.venuePlace = async () => ({ country: "US", region: "PA" });
    Object.assign(net, { binance: "451", binanceus: "timeout" });
    const first = await svc.venuesHere(false);
    expect(verdicts(first, B, "live:exchange:binanceus")).toEqual({ [B]: ["not-served", ""], "live:exchange:binanceus": ["no-answer", ""] });
    now += 21_000;
    // the list kept is answered at once, and asked again behind it: the next read has the answer
    expect(verdicts(await svc.venuesHere(false), B, "live:exchange:binanceus")).toEqual({ [B]: ["not-served", ""], "live:exchange:binanceus": ["no-answer", ""] });
    await (svc as unknown as { venuesPending?: { p: Promise<unknown> } }).venuesPending?.p;
    expect(verdicts(await svc.venuesHere(false), B, "live:exchange:binanceus")).toEqual({ [B]: ["not-served", "live:exchange:binanceus"], "live:exchange:binanceus": ["connectable", ""] });
    // the agent asking for Binance is told of Binance.US
    expect(svc.account!.host.venueVerdict?.("binance")).toMatchObject({ verdict: "not-served", edition: { venue: "binanceus" } });
  });

  it("the door counts ten minutes from when the venue was asked, and a newer answer stands at once; a venue read by its address is let through", async () => {
    let now = Date.parse("2026-10-09T15:00:00.000Z");
    const { svc } = await account({ liveDeps: { http, openExchange, clock: () => now } });
    // no place learned: the list is rebuilt after twenty seconds, reusing Binance's answer kept ten minutes
    svc.venuePlace = async () => undefined;
    net.binance = "451";
    await svc.venuesHere(true);
    now += 9 * MIN + 59_000;
    await svc.venuesHere(false);
    expect(svc.account!.host.venueVerdict?.("binance")?.verdict).toBe("not-served");
    now += 2_000;
    // the answer itself is ten minutes old: the owner is asked, and Binance's own answer decides when they connect
    expect(svc.account!.host.venueVerdict?.("binance")).toBeUndefined();
    // a forced Check again on a network Binance serves: the door lets the ask through at once
    await svc.venuesHere(true);
    expect(svc.account!.host.venueVerdict?.("binance")?.verdict).toBe("not-served");
    net.binance = "ok";
    await svc.connectReach([B], true);
    expect(svc.account!.host.venueVerdict?.("binance")?.verdict).toBe("connectable");
    // Hyperliquid's line closes this place: its trading connection is not served, its address can still be connected, read only
    svc.venuePlace = async () => ({ country: "US", region: "PA" });
    net.binance = "451";
    await svc.venuesHere(true);
    expect(svc.account!.host.venueVerdict?.("hyperliquid")).toMatchObject({ verdict: "connectable", said: expect.stringContaining("can be connected by its address, read only") });
    expect(svc.account!.host.venueVerdict?.("binance")?.verdict).toBe("not-served");
  });

  it("finds the venue answering, and lets go of a keyless source's place hold from the network before; without one, the hold stands", async () => {
    let listed: Listing[] | Refusal = no("E_VENUE_GEOBLOCKED", { venue: "binance", message: "Binance does not serve this location" });
    const pub: PublicSource = { id: "binance", name: "Binance", kind: "exchange", connectTo: "binance", connector: B, listings: async () => listed };
    const { svc } = await account({ publicMarkets: [pub], liveDeps: { http, openExchange } });
    const source = (svc as unknown as { publicMarkets(): PublicSource[] }).publicMarkets()[0]!;
    expect(refusal(await source.listings({ limit: 5 })).code).toBe("E_VENUE_GEOBLOCKED");
    listed = [];
    // on a network Binance serves: held still, until a re-check asks
    expect(refusal(await source.listings({ limit: 5 })).code).toBe("E_VENUE_GEOBLOCKED");
    await svc.connectReach([B]);
    expect(isRefusal(await source.listings({ limit: 5 }))).toBe(true);
    await svc.connectReach([B], true);
    expect(await source.listings({ limit: 5 })).toEqual([]);
  });

  it("does not ask a venue again while its own ban of this address runs: neither Check again nor the half-hourly check", async () => {
    const { svc } = await account({ liveDeps: { http, openExchange } });
    net.binance = "418";
    const [first] = await svc.connectReach([B], true);
    expect(first).toMatchObject({ state: "unreachable", said: expect.stringContaining("has banned this machine's address for too many requests until") });
    net.asked = [];
    net.binance = "ok";
    await svc.connectReach([B], true);
    await svc.venuesHere(true);
    expect(net.asked.filter((x) => x === "binance")).toEqual([]);
    expect(verdicts(await svc.venuesHere(true), B)).toEqual({ [B]: ["no-answer", ""] });
  });
});

describe("a venue that did not answer when the account started", () => {
  it("is asked again, not dropped for the run: connected once the network lets it, with no owner action", async () => {
    const h = home();
    const a = await account({ at: h });
    await a.plug();
    // the restart, before the network is up: the venue does not answer the first connect
    desk.opens.push(() => no("E_VENUE_UNREACHABLE", { venue: "ex", message: "Stand-in could not be reached", native: { code: "ENOTFOUND" } }));
    const b = await account({ at: h });
    // the page shows it as connecting again; why, and when it is asked next, beside it
    expect(b.svc.restored?.venues).toEqual([{ venue: "ex", ok: false, why: "connecting again", waiting: true, said: expect.stringMatching(/^Stand-in could not be reached — asked again in \d+ s$/) }]);
    expect(b.svc.waitingWords("ex")).toContain("has not come back after the restart yet");
    expect(b.svc.adapter("ex")).toBeUndefined();
    // a re-check finds its connection answering: it is asked again now
    await b.svc.connectReach(["live:f1-standin"], true);
    await vi.waitFor(() => expect(b.svc.restored?.venues).toEqual([{ venue: "ex", ok: true }]));
    expect(b.svc.adapter("ex")?.account.watchOnly).toBeTruthy();
    expect(b.svc.waitingWords("ex")).toBeUndefined();
  });

  it("on its own backoff too; a key the venue refuses is final, as before", async () => {
    const h = home();
    const a = await account({ at: h });
    await a.plug();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    desk.opens.push(() => no("E_VENUE_UNREACHABLE", { venue: "ex", message: "Stand-in could not be reached" }));
    desk.opens.push(() => no("E_VENUE_UNREACHABLE", { venue: "ex", message: "Stand-in could not be reached" }));
    const b = await account({ at: h });
    expect(b.svc.restored?.venues[0]).toMatchObject({ ok: false, waiting: true });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(b.svc.restored?.venues[0]).toMatchObject({ ok: false, waiting: true, said: expect.stringContaining("asked again in 30 s") });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(b.svc.restored?.venues[0]).toEqual({ venue: "ex", ok: true });
    vi.useRealTimers();
    desk.opens.push(() => no("E_ACCOUNT_CREDENTIAL", { venue: "ex", message: "the key file is gone" }));
    const c = await account({ at: h });
    expect(c.svc.restored?.venues[0]).toEqual({ venue: "ex", ok: false, why: "the key file is gone" });
    expect(c.svc.waitingWords("ex")).toBeUndefined();
  });
});
