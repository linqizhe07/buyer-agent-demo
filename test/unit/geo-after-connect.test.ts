import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { isRefusal, type Refusal } from "../../src/core/errors.ts";
import type { AccountPage } from "../../src/portfolio/account/exchange.ts";
import { signOwner, simKey, type OwnerAction } from "../../src/portfolio/account/sign.ts";
import { exchangeSaidNo, type ExchangeClient, type OpenExchange } from "../../src/portfolio/live/exchange.ts";
import { lostAnswer } from "../../src/portfolio/live/exchange-trade.ts";
import { register } from "../../src/portfolio/live/index.ts";
import { heldTo, HYPERLIQUID_RULE, locator, PLACE_MS } from "../../src/portfolio/live/location.ts";
import type { RunMm } from "../../src/portfolio/live/metamask.ts";
import type { PublicSource } from "../../src/portfolio/live/public-markets.ts";
import type { LiveTrader, Market } from "../../src/portfolio/live/trade.ts";
import type { Http } from "../../src/portfolio/live/types.ts";
import type { LiveWriter } from "../../src/portfolio/live/writes.ts";
import { no } from "../../src/portfolio/refuse.ts";
import { PortfolioService } from "../../src/portfolio/service.ts";

/** AFTER THE ACCOUNTS ARE CONNECTED (2026-10-10): a connected venue that starts refusing the network the Account runs on — the user moved, or
 * the venue changed its line — is a state the account lists, not an error it prints. The owner's words: list what serves the user's
 * network; the refusals are not wanted as error text. So: its balance keeps its last good numbers and says "not served" (and a check that
 * finds it answering lets go at once, balance included); Markets, the comparison and the money door neither ask it nor offer it, and name it
 * once; a money move asks nothing of a venue held back, and a fresh place rule met there holds it for every read and door; a network whose
 * address names no place is said as that, and not asked again every few seconds. Every venue is a stand-in; the addresses are from the
 * documentation ranges (RFC 5737) */
type NoNonce<T> = T extends unknown ? Omit<T, "nonce"> : never;
const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));
const owner = simKey("owner:geo-after-connect");
let seq = 0;

const BTC: Market = { symbol: "BTC/USDT", name: "BTC/USDT", kind: "spot", base: "BTC", quote: "USDT", price: 60_000, bid: 59_990, ask: 60_010, minQty: 0.0001, qtyStep: 0.0001, priceStep: 0.1, open: true, types: ["market", "limit"] };
const PLACE = (venue: string, name: string): Refusal => no("E_VENUE_GEOBLOCKED", { venue, message: `${name} does not serve this location: that is its own rule, and the account does not look for a way around it`, native: { status: 451, said: "Service unavailable from a restricted location (203.0.113.9)" } });

/** what each stand-in venue answers this network now, and what reached it: `451` everything, `iplist` a key bound to another address,
 * `orders` only its order calls refusing this network (its reads answer) */
const net: Record<string, "ok" | "451" | "iplist" | "orders"> = {};
const calls: string[] = [];
afterEach(() => {
  for (const k of Object.keys(net)) delete net[k];
  calls.length = 0;
});
const answer = <T>(venue: string, name: string, what: string, ok: () => T): Promise<T> => {
  calls.push(`${venue} ${what}`);
  return net[venue] === "451" ? Promise.reject(PLACE(venue, name)) : Promise.resolve(ok());
};
const refusing = <T>(venue: string, name: string, what: string, ok: () => T): Promise<T | Refusal> => {
  calls.push(`${venue} ${what}`);
  return Promise.resolve(net[venue] === "451" ? PLACE(venue, name) : ok());
};
register({
  kind: "geo-standin",
  label: "a stand-in exchange",
  needs: "key-file",
  example: "",
  venues: [],
  async open(req: { venue: string; label: string }) {
    const venue = req.venue;
    const name = req.label || "Stand-in";
    if (net[venue] === "451") return PLACE(venue, name);
    if (net[venue] === "iplist") return no("E_VENUE_PERMISSION", { venue, message: `${name}: this machine's current address is not on the key's IP list: add it at ${name}, or make a key without one`, detail: { ipList: true } });
    const resting = new Map<string, { qty: number; status: "open" | "canceled" }>();
    const trader: LiveTrader = {
      can: true,
      what: "spot",
      markets: () => refusing(venue, name, "markets", () => [BTC]),
      market: (sym) => refusing(venue, name, "market", () => ({ ...BTC, symbol: sym })),
      place: async (o) => {
        calls.push(`${venue} place`);
        if (net[venue] === "451" || net[venue] === "orders") return PLACE(venue, name);
        const ref = `r-${resting.size + 1}`;
        resting.set(ref, { qty: o.qty, status: "open" });
        return { ref, status: "open", filledQty: 0, native: {} };
      },
      cancel: async (ref) => {
        calls.push(`${venue} cancel`);
        if (net[venue] === "451") return PLACE(venue, name);
        const r = resting.get(ref);
        if (r) r.status = "canceled";
        return { ref, status: "canceled", filledQty: 0, native: {} };
      },
      status: async (ref) => ({ ref, status: resting.get(ref)?.status ?? "open", filledQty: 0, native: {} }),
    };
    const writer: LiveWriter = {
      can: { withdraw: true, ledgers: ["spot"], transfer: false, swap: false, receive: true, send: false },
      depositAddress: (asset) => refusing(venue, name, `deposit address ${asset}`, () => ({ address: "0x00000000000000000000000000000000000000d1" as const })),
      withdrawFee: async () => (calls.push(`${venue} withdraw fee`), 1),
      withdraw: async (r) => (calls.push(`${venue} withdraw`), net[venue] === "451" ? PLACE(venue, name) : { ref: r.clientId, status: "pending" as const, native: {} }),
    };
    const first = [{ asset: "USDC", amount: 100, usd: 100 }];
    return { source: { name, kind: "cex", reference: "standin", via: "a stand-in", probe: { can: ["read", "trade", "withdraw"], note: "" }, read: () => answer(venue, name, "balance", () => first), trader, writer }, first, summary: "connected" };
  },
} as never);

/** a real account on stand-ins, on a clock the test moves */
async function account(o: { publicMarkets?: PublicSource[]; openExchange?: OpenExchange } = {}) {
  const home = mkdtempSync(join(tmpdir(), "geo-after-connect-"));
  homes.push(home);
  let now = Date.parse("2026-10-10T15:00:00.000Z");
  const svc = await PortfolioService.create({ home, venues: "frontline", real: true, publicMarkets: o.publicMarkets ?? [], liveDeps: { clock: () => now, http: async () => ({ status: 404, body: undefined, text: "" }), price: async () => undefined, mm: (async () => ({ authenticated: true })) as unknown as RunMm, ...(o.openExchange ? { openExchange: o.openExchange } : {}) }, liveWrites: { capUsd: 100, pairingCode: "K7QX-M2PA" }, account: { owners: [{ id: owner.address, kind: "eoa", label: "owner", addedAt: new Date().toISOString() }] } } as never);
  await svc.restoring;
  const own = async (a: NoNonce<OwnerAction>) => svc.exchange(await signOwner(owner, { ...a, nonce: Date.now() + ++seq } as OwnerAction));
  const connect = async (venue: string, label: string) => {
    const r = await own({ type: "connectVenue", venue, connector: "live:geo-standin", label, credentialRef: "" });
    if (isRefusal(r)) throw new Error(r.message);
  };
  const page = async () => (await svc.accountView()) as AccountPage;
  const venue = async (id: string) => (await page()).venues.find((v) => v.id === id)!;
  return { svc, own, connect, page, venue, pass: (ms: number) => (now += ms) };
}

describe("a connected venue that starts refusing the network", () => {
  it("keeps its last good numbers and is said as not served — not 'read failed' — and a check that finds it answering lets its balance go at once", async () => {
    const x = await account();
    await x.connect("ex", "Stand-in Exchange");
    net.ex = "451";
    x.pass(31_000);
    await x.page();
    const held = await x.venue("ex");
    expect(held).toMatchObject({ usd: 100, notServed: { said: expect.stringContaining("Stand-in Exchange does not serve this location") } });
    expect(JSON.stringify(held)).not.toContain("203.0.113.9");
    // the market reads wait it out too: nothing more is asked of it
    calls.length = 0;
    expect(isRefusal(await x.svc.liveMarket("ex", "BTC/USDT"))).toBe(true);
    x.pass(31_000);
    await x.page();
    expect(calls).toEqual([]);
    // the laptop is on a network the venue serves, and the owner presses Check again: the balance is asked at once, not ten minutes on
    net.ex = "ok";
    await x.svc.connectReach(["live:geo-standin"], true);
    await x.page();
    expect(calls).toContain("ex balance");
    const back = await x.venue("ex");
    expect([back.notServed, back.stale]).toEqual([undefined, undefined]);
  });

  it("Markets and the comparison neither ask it nor list it, and name it once without its words; the other venue still trades", async () => {
    const x = await account();
    await x.connect("ex", "Stand-in Exchange");
    await x.connect("ok", "Other Exchange");
    const before = await x.svc.explore({ limit: 50 });
    if (isRefusal(before)) throw new Error(before.message);
    expect(before.items.find((i) => i.key === "coin:BTC")?.at.map((a) => a.venue).sort()).toEqual(["ex", "ok"]);
    net.ex = "451";
    x.pass(31_000);
    await x.page();
    calls.length = 0;
    const after = await x.svc.explore({ limit: 49 });
    if (isRefusal(after)) throw new Error(after.message);
    expect(after.items.find((i) => i.key === "coin:BTC")?.at.map((a) => a.venue)).toEqual(["ok"]);
    expect(after.notes).toContain("Stand-in Exchange does not serve this network: its markets are not listed here.");
    expect(after.missing.map((m) => m.venue)).not.toContain("ex");
    expect(JSON.stringify(after)).not.toMatch(/restricted location|203\.0\.113/);
    const c = await x.svc.liveCompare("BTC", "buy");
    if (isRefusal(c)) throw new Error(c.message);
    expect(c.rows.map((r) => r.venue)).toEqual(["ok"]);
    expect(calls.filter((k) => k.startsWith("ex "))).toEqual([]);
  });

  it("a public source whose venue the list of where the user can connect judged not served is not asked, and is named once", async () => {
    let asked = 0;
    const pub: PublicSource = { id: "binance", name: "Binance", kind: "exchange", connectTo: "binance", connector: "live:exchange:binance", listings: async () => (asked++, [{ ...BTC, types: [] }]) };
    const openExchange: OpenExchange = async (id) => ({ id, name: id === "binance" ? "Binance" : id, has: {}, fetchTime: async () => { if (id === "binance") throw Object.assign(new Error('binance GET https://api.binance.com/api/v3/time 451 {"code":0,"msg":"Service unavailable from a restricted location"}'), { name: "ExchangeNotAvailable" }); return 1; } }) as unknown as ExchangeClient;
    const x = await account({ publicMarkets: [pub], openExchange });
    await x.svc.venuesHere(true);
    const r = await x.svc.explore({ limit: 30 });
    if (isRefusal(r)) throw new Error(r.message);
    expect(asked).toBe(0);
    expect(r.items).toEqual([]);
    expect(r.notes).toContain("Binance does not serve this network: its markets are not listed here.");
  });
});

describe("the money door and a venue that does not serve the network", () => {
  const draft = (to: string) => ({ type: "liveMove", kind: "withdraw", from: "ex", to, asset: "USDC", toAsset: "USDC", network: "Base", amount: "10" });

  it("a fresh place rule at the destination holds it for every read and door: the next move asks it nothing", async () => {
    const x = await account();
    await x.connect("ex", "Stand-in Exchange");
    await x.connect("dst", "Destination Exchange");
    net.dst = "451";
    const first = await x.svc.account!.prepare(draft("dst") as never);
    expect(isRefusal(first) && first.code).toBe("E_VENUE_GEOBLOCKED");
    expect(calls.filter((k) => k === "dst deposit address USDC")).toHaveLength(1);
    // held: the page says so, and a second move is answered from the hold
    expect((await x.venue("dst")).notServed).toBeDefined();
    const second = await x.svc.account!.prepare(draft("dst") as never);
    expect(isRefusal(second) && second.code).toBe("E_VENUE_GEOBLOCKED");
    expect(calls.filter((k) => k === "dst deposit address USDC")).toHaveLength(1);
    // the source held back since: nothing is asked of it either
    net.ex = "451";
    x.pass(31_000);
    await x.page();
    calls.length = 0;
    net.dst = "ok";
    const third = await x.svc.account!.prepare(draft("dst") as never);
    expect(isRefusal(third) && third.code).toBe("E_VENUE_GEOBLOCKED");
    expect(calls).toEqual([]);
  });

  it("a destination connected but waiting for its venue is said as that, not as 'not a venue connected live'", async () => {
    const x = await account();
    await x.connect("ex", "Stand-in Exchange");
    net.later = "451";
    const r = await x.own({ type: "connectVenue", venue: "later", connector: "live:geo-standin", label: "Later Exchange", credentialRef: "" });
    expect(isRefusal(r)).toBe(false);
    const m = await x.svc.account!.prepare(draft("later") as never);
    expect(isRefusal(m) && [m.code, m.message]).toEqual(["E_ACCOUNT_DESTINATION", expect.stringContaining("Later Exchange is connected but has not answered this network yet")]);
  });
});

describe("a network whose address names no place", () => {
  it("is said as that, held to Hyperliquid's line without 'try again in a moment', and its sources are not asked again on the same network", async () => {
    let asked = 0;
    const http: Http = async (url) => {
      asked++;
      if (url.includes("polymarket.com/api/geoblock")) return { status: 200, body: { blocked: false, country: "XX", region: "" }, text: "" };
      return { status: 200, body: undefined, text: "fl=1\nloc=T1\n" };
    };
    let now = 1_000_000;
    const where = locator({ http, clock: () => now });
    const r = await heldTo(HYPERLIQUID_RULE, where, "hl", "");
    expect(r && [r.code, (r.native as { unplaceable?: boolean }).unplaceable]).toEqual(["E_VENUE_UNREACHABLE", true]);
    expect(r!.message).toContain("this network's address names no place");
    expect(r!.message).not.toContain("Try again in a moment");
    expect(asked).toBe(3);
    now += PLACE_MS / 2;
    expect(await where.verdict(HYPERLIQUID_RULE)).toBe("unknown");
    expect(asked).toBe(3);
    // a source that did not answer is not that: asked again next time
    const quiet = locator({ http: async () => { throw new Error("ENOTFOUND"); }, clock: () => now });
    expect(await quiet.verdict(HYPERLIQUID_RULE)).toBe("unknown");
    expect(quiet.missing?.()).toBe("place");
  });
});

describe("orders after connect, at a venue that refuses this network", () => {
  const order = { type: "liveOrder", venue: "ex", symbol: "BTC/USDT", side: "buy", orderType: "limit", qty: "0.001", limitPrice: "50000" };
  const sign = async (x: Awaited<ReturnType<typeof account>>) => {
    const p = await x.svc.account!.prepare(order as never);
    if (isRefusal(p)) return p;
    const { nonce: _n, ...rest } = (p as { action: Record<string, unknown> }).action;
    return x.own(rest as never);
  };

  it("an order its order call refused for this network is remembered: the next is refused before it is quoted, nothing sent; a check that finds it answering lets go", async () => {
    const x = await account();
    await x.connect("ex", "Stand-in Exchange");
    net.ex = "orders";
    const first = await sign(x);
    expect(isRefusal(first) && first.code).toBe("E_VENUE_GEOBLOCKED");
    expect(calls.filter((k) => k === "ex place")).toHaveLength(1);
    // its reads still answer: the venue is not held, only no order is offered there
    expect(isRefusal(await x.svc.liveMarket("ex", "BTC/USDT"))).toBe(false);
    const again = await x.svc.account!.prepare(order as never);
    expect(isRefusal(again) && again.code).toBe("E_VENUE_GEOBLOCKED");
    expect(calls.filter((k) => k === "ex place")).toHaveLength(1);
    // the laptop moved; the owner's Check again finds the venue answering: orders are quoted again
    net.ex = "ok";
    await x.svc.connectReach(["live:geo-standin"], true);
    expect(isRefusal(await x.svc.account!.prepare(order as never))).toBe(false);
  });

  it("the owner's cancel the venue refused is sent again by itself once a check finds the venue answering", async () => {
    const x = await account();
    await x.connect("ex", "Stand-in Exchange");
    const placed = await sign(x);
    if (isRefusal(placed)) throw new Error(placed.message);
    const id = (placed as { order: { id: string } }).order.id;
    net.ex = "451";
    const c = await x.own({ type: "liveCancel", venue: "ex", order: id } as never);
    expect((c as { order: { unfollowed?: boolean; note?: string } }).order).toMatchObject({ unfollowed: true, note: expect.stringContaining("sends your cancel again when a check of this network finds") });
    net.ex = "ok";
    calls.length = 0;
    await x.svc.connectReach(["live:geo-standin"], true);
    await x.svc.account!.trade.poll();
    expect(calls).toContain("ex cancel");
    const o = (await x.page()).orders.find((y) => y.id === id)!;
    expect([o.status, o.unfollowed]).toEqual(["canceled", undefined]);
  });
});

describe("what a venue answers, read the right way", () => {
  it("a 451 is the place rule by its status alone, and a write it answered with one is refused, never 'may have gone'", () => {
    const err = Object.assign(new Error("binance POST https://api.binance.com/api/v3/order 451  "), { name: "ExchangeNotAvailable" });
    const r = exchangeSaidNo("binance", "Binance", err, {});
    expect(r.code).toBe("E_VENUE_GEOBLOCKED");
    expect(lostAnswer(err, r)).toBe(false);
    // a 503 under the same name is no answer, which may have taken the write
    const down = Object.assign(new Error("binance POST https://api.binance.com/api/v3/order 503 Service Unavailable"), { name: "ExchangeNotAvailable" });
    expect(lostAnswer(down, exchangeSaidNo("binance", "Binance", down, {}))).toBe(true);
  });

  it("a key bound to another address keeps a restored connection waiting, not stopped, and a re-check reconnects it at home", async () => {
    const x = await account();
    await x.connect("ex", "Stand-in Exchange");
    await x.svc.snapshot();
    // a restart on a café network: the key's IP list does not hold this address
    net.ex = "iplist";
    const home = (x.svc as unknown as { opts: { home: string } }).opts.home;
    const y = await PortfolioService.create({ home, venues: "frontline", real: true, publicMarkets: [], liveDeps: { http: async () => ({ status: 404, body: undefined, text: "" }), price: async () => undefined, mm: (async () => ({ authenticated: true })) as unknown as RunMm }, liveWrites: { capUsd: 100, pairingCode: "K7QX-M2PA" }, account: { owners: [{ id: owner.address, kind: "eoa", label: "owner", addedAt: new Date().toISOString() }] } } as never);
    await y.restoring;
    const w = ((await y.accountView()) as AccountPage).connectLive?.waiting ?? [];
    expect(w[0]).toMatchObject({ venue: "ex", how: "restart", code: "E_VENUE_PERMISSION", lastUsd: 100 });
    expect(w[0]!.stopped).toBeUndefined();
    // home again: the half-hourly check (or Check again) finds it answering, and the key works
    net.ex = "ok";
    await y.connectReach(["live:geo-standin"], true);
    await new Promise((r) => setTimeout(r, 20));
    expect(y.adapter("ex")?.account.watchOnly).toBeTruthy();
  });
});
