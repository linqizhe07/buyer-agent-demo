import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isRefusal } from "../../src/core/errors.ts";
import { signAgent, signOwner, simKey, type AgentAction, type OwnerAction } from "../../src/portfolio/account/sign.ts";
import { venuesHere, verdictOf, type AvailabilityDeps } from "../../src/portfolio/live/availability.ts";
import { termsHere } from "../../src/portfolio/live/eligibility.ts";
import type { ExchangeClient, OpenExchange } from "../../src/portfolio/live/exchange.ts";
import type { RunMm } from "../../src/portfolio/live/metamask.ts";
import type { Reach } from "../../src/portfolio/live/reach.ts";
import { startPortfolioServer } from "../../src/portfolio/server.ts";
import { PortfolioService } from "../../src/portfolio/service.ts";

/** Where this user can connect (live/availability.ts): each venue's own answer to this network, and its own terms matched to where the
 * network is — the place used in memory only, never in the answer */
const AT = "2026-10-08T15:00:00.000Z";
const reach = (connector: string, state: Reach["state"], said?: string): Reach => ({ connector, state, ...(said ? { said } : {}), at: AT });
const OKX_TERMS = { url: "https://www.okx.com/help/terms-of-service", read: "2026-10-08", says: "Restricted Persons… the United States…" };

const deps = (place: { country?: string; region?: string } | undefined, answers: Reach[]): AvailabilityDeps & { asked: string[][] } => {
  const asked: string[][] = [];
  return {
    asked,
    connections: [
      { connector: "live:exchange:okx", name: "OKX", group: "Exchanges", needs: "key-file" },
      { connector: "live:exchange:binance", name: "Binance", group: "Exchanges", needs: "key-file" },
      { connector: "live:metamask", name: "MetaMask Agent Wallet", group: "Wallets", needs: "cli" },
      { connector: "live:hyperliquid", name: "Hyperliquid · by address", group: "Markets and tokens", needs: "address" },
    ],
    reach: async (cs) => (asked.push(cs), answers.filter((a) => cs.includes(a.connector))),
    terms: (c, p) => (c === "live:exchange:okx" ? { ...OKX_TERMS, excludesHere: p?.country === undefined ? undefined : p.country === "US" } : undefined),
    place: async () => place,
    connected: (c) => c === "live:metamask",
    clock: () => Date.parse(AT),
  };
};

describe("where this user can connect", () => {
  it("a venue that refuses this network is not served; one whose terms exclude the place says so in its words; the rest are connectable", async () => {
    const answers = [reach("live:exchange:okx", "ok"), reach("live:exchange:binance", "location", "Binance does not serve this location: that is its own rule"), reach("live:metamask", "ok")];
    const d = deps({ country: "US", region: "NY" }, answers);
    const v = await venuesHere(d);
    expect(v.map((x) => [x.name, x.verdict, x.connected])).toEqual([
      ["OKX", "terms-exclude", false],
      ["Binance", "not-served", false],
      ["MetaMask Agent Wallet", "connectable", true],
      ["Hyperliquid · by address", "connectable", false],
    ]);
    expect(v[0]!.said).toContain("its terms exclude where you are (https://www.okx.com/help/terms-of-service, read 2026-10-08): “Restricted Persons… the United States…”");
    expect(v[0]!.said).toContain("the venue checks residency when an account is opened; the account does not");
    expect(v[1]!.said).toBe("Binance does not serve this location: that is its own rule");
    // the address-based one is read only, and asked like the rest: nothing answered for it here, so it carries no time it was asked
    expect(v[3]).toMatchObject({ readOnly: true, verdict: "connectable" });
    expect(v[3]!.asked).toBeUndefined();
    expect(v[0]!.asked).toBe(AT);
    expect(d.asked).toEqual([["live:exchange:okx", "live:exchange:binance", "live:metamask", "live:hyperliquid"]]);
    // the place itself is never in the answer
    expect(JSON.stringify(v)).not.toMatch(/"US"|\bNY\b|country|region/);
  });

  it("the same venues from a place their terms do not exclude: OKX is connectable, and its terms are still there to read", async () => {
    const v = await venuesHere(deps({ country: "SG" }, [reach("live:exchange:okx", "ok"), reach("live:exchange:binance", "ok"), reach("live:metamask", "ok")]));
    expect(v.map((x) => x.verdict)).toEqual(["connectable", "connectable", "connectable", "connectable"]);
    expect(v[0]!.terms).toMatchObject({ url: OKX_TERMS.url, excludesHere: false });
  });

  it("where the network is cannot be learned: the terms are not judged (shown, unknown), and nothing is refused for it", async () => {
    const v = await venuesHere(deps(undefined, [reach("live:exchange:okx", "ok"), reach("live:exchange:binance", "ok"), reach("live:metamask", "ok")]));
    expect(v[0]).toMatchObject({ verdict: "connectable", terms: { excludesHere: undefined } });
  });

  it("verdictOf: the venue's answer first (refused, set up, closed, no answer), then its terms; read-by-address is never judged by terms", () => {
    const t = { ...OKX_TERMS, excludesHere: true };
    expect(verdictOf(reach("c", "location", "no"), t, "key-file")).toEqual({ verdict: "not-served", said: "no" });
    expect(verdictOf(reach("c", "setup", "mm login"), undefined, "cli")).toEqual({ verdict: "setup", said: "mm login" });
    expect(verdictOf(reach("c", "closed", "none"), undefined, "sign-in")).toEqual({ verdict: "closed", said: "none" });
    expect(verdictOf(reach("c", "unreachable", "later"), t, "key-file")).toEqual({ verdict: "no-answer", said: "later" });
    expect(verdictOf(reach("c", "ok"), t, "key-file").verdict).toBe("terms-exclude");
    expect(verdictOf(undefined, t, "address")).toEqual({ verdict: "connectable" });
    expect(verdictOf(reach("c", "ok"), { ...t, excludesHere: undefined }, "key-file")).toEqual({ verdict: "connectable" });
  });
});

describe("a venue that cannot be used from here, and its edition for where the user is", () => {
  const ED = { connector: "live:polymarket-us", serves: ["US"], url: "https://docs.polymarket.us/getting-started/what-is-polymarket-us", says: "Built for US residents.", read: "2026-10-08" };
  const base = (place: { country?: string; region?: string } | undefined, answers: Reach[], usTerms: { excludesHere?: boolean } = { excludesHere: false }): AvailabilityDeps => ({
    connections: [
      { connector: "live:polymarket-trade", name: "Polymarket", group: "Markets and tokens", needs: "key-file" },
      { connector: "live:polymarket-us", name: "Polymarket US", group: "Markets and tokens", needs: "key-file" },
    ],
    reach: async (cs) => answers.filter((a) => cs.includes(a.connector)),
    terms: (c) => (c === "live:polymarket-us" ? { url: "https://polymarketexchange.com/files/legal/latest/participant-agreement", read: "2026-10-08", says: "…made-up words for the test…", ...usTerms } : undefined),
    place: async () => place,
    connected: () => false,
    clock: () => Date.parse(AT),
    editions: { "live:polymarket-trade": [ED] },
  });
  const closeOnly = reach("live:polymarket-trade", "close-only", "Polymarket lets this location close positions, not open new ones");

  it("Polymarket lets this network only close, and Polymarket US answers it and says in its own words it is for this place: named beside Polymarket", async () => {
    const v = await venuesHere(base({ country: "US", region: "PA" }, [closeOnly, reach("live:polymarket-us", "ok")]));
    expect(v[0]).toMatchObject({ verdict: "close-only", said: "Polymarket lets this location close positions, not open new ones", edition: { connector: "live:polymarket-us", name: "Polymarket US" } });
    expect(v[0]!.edition!.said).toBe("Polymarket US is for where you are, in its own words: “Built for US residents.” (https://docs.polymarket.us/getting-started/what-is-polymarket-us, read 2026-10-08). A separate company, with its own account and API keys");
    expect(v[1]).toMatchObject({ verdict: "connectable" });
    expect(v[1]!.edition).toBeUndefined();
    expect(JSON.stringify(v)).not.toMatch(/"US"|\bPA\b/);
  });

  it("the edition is offered only when its own words name the place, and only when it can be connected from here", async () => {
    const answers = [closeOnly, reach("live:polymarket-us", "ok")];
    // a place its words do not name (a user elsewhere whom Polymarket lets only close)
    expect((await venuesHere(base({ country: "GB", region: "ENG" }, answers)))[0]!.edition).toBeUndefined();
    // where the user is could not be learned
    expect((await venuesHere(base(undefined, answers)))[0]!.edition).toBeUndefined();
    // it does not answer this network just now, or its own terms exclude the place
    expect((await venuesHere(base({ country: "US", region: "PA" }, [closeOnly, reach("live:polymarket-us", "unreachable", "later")])))[0]!.edition).toBeUndefined();
    expect((await venuesHere(base({ country: "US", region: "PA" }, answers, { excludesHere: true })))[0]!.edition).toBeUndefined();
    // a venue that can be used has no edition named, whatever exists
    expect((await venuesHere(base({ country: "US", region: "PA" }, [reach("live:polymarket-trade", "ok"), reach("live:polymarket-us", "ok")])))[0]!.edition).toBeUndefined();
  });
});

describe("the editions the account knows, from their own pages", () => {
  const net = (refused: string[]) => ({
    connections: [
      { connector: "live:exchange:binance", name: "Binance", group: "Exchanges" as const, needs: "key-file" as const },
      { connector: "live:exchange:binanceus", name: "Binance.US", group: "Exchanges" as const, needs: "key-file" as const },
      { connector: "live:exchange:okx", name: "OKX", group: "Exchanges" as const, needs: "key-file" as const },
      { connector: "live:exchange:okxus", name: "OKX US", group: "Exchanges" as const, needs: "key-file" as const },
    ],
    reach: async (cs: string[]) => cs.map((c) => reach(c, refused.includes(c) ? "location" : "ok", refused.includes(c) ? "does not serve this location" : undefined)),
    terms: termsHere,
    connected: () => false,
    clock: () => Date.parse(AT),
  });
  it("a user in Pennsylvania: Binance refuses, Binance.US is named in its own words; OKX's terms hand them to OKX US, which is named", async () => {
    const v = await venuesHere({ ...net(["live:exchange:binance"]), place: async () => ({ country: "US", region: "PA" }) });
    const by = new Map(v.map((x) => [x.connector, x]));
    expect(by.get("live:exchange:binance")!.edition).toMatchObject({ name: "Binance.US", said: expect.stringContaining("“This article includes all of the states and regions where Binance.US services are available.”") });
    expect(by.get("live:exchange:okx")).toMatchObject({ verdict: "terms-exclude", edition: { name: "OKX US", said: expect.stringContaining("“The OKX digital asset trading platform for United States customers is provided by OKX INC.”") } });
  });
  it("a user in Texas: Binance.US does not serve it, so it is not named; OKX US does", async () => {
    const v = await venuesHere({ ...net(["live:exchange:binance"]), place: async () => ({ country: "US", region: "TX" }) });
    const by = new Map(v.map((x) => [x.connector, x]));
    expect(by.get("live:exchange:binanceus")!.verdict).toBe("terms-exclude");
    expect(by.get("live:exchange:binance")!.edition).toBeUndefined();
    expect(by.get("live:exchange:okx")!.edition).toMatchObject({ name: "OKX US" });
  });
  it("a user in New York: neither edition serves it, and neither is named", async () => {
    const v = await venuesHere({ ...net(["live:exchange:binance"]), place: async () => ({ country: "US", region: "NY" }) });
    expect(v.every((x) => x.edition === undefined)).toBe(true);
  });
});

describe("nothing this machine was answered is in the account", () => {
  it("the same account on two networks gives two answers: each user is judged from their own", async () => {
    const network = (polymarket: Record<string, unknown>, binance451: boolean) => ({
      http: async (url: string) => (url.includes("polymarket.com/api/geoblock") ? { status: 200, body: polymarket, text: JSON.stringify(polymarket) } : { status: 404, body: undefined, text: "" }),
      openExchange: (async (id: string) => ({ id, name: id, has: {}, fetchTime: async () => { if (binance451 && id === "binance") throw Object.assign(new Error('binance GET https://api.binance.com/api/v3/time 451 {"code":0,"msg":"Service unavailable from a restricted location"}'), { name: "ExchangeNotAvailable" }); return 1; } })) as unknown as OpenExchange,
    });
    const judged = async (n: ReturnType<typeof network>) => {
      const home = mkdtempSync(join(tmpdir(), "live-availability-two-"));
      try {
        const svc = await PortfolioService.create({ home, venues: "frontline", real: true, publicMarkets: [], liveDeps: { http: n.http, openExchange: n.openExchange, mm: (async () => ({ authenticated: true })) as unknown as RunMm, price: async () => undefined } });
        const v = await svc.venuesHere(true);
        return Object.fromEntries(v.filter((x) => x.connector === "live:polymarket-trade" || x.connector === "live:exchange:binance").map((x) => [x.connector, x.verdict]));
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    };
    // a network in the United States (as the builder's is) and one in a place both venues serve: the same code, two answers
    expect(await judged(network({ blocked: true, country: "US", region: "PA" }, true))).toEqual({ "live:exchange:binance": "not-served", "live:polymarket-trade": "close-only" });
    expect(await judged(network({ blocked: false, country: "AR", region: "B" }, false))).toEqual({ "live:exchange:binance": "connectable", "live:polymarket-trade": "connectable" });
  });
});

// ---- the service: detected without anyone asking, served over HTTP and MCP, and an agent's ask for a venue that cannot be connected ----

describe("where this user can connect, from the service", () => {
  const home = mkdtempSync(join(tmpdir(), "live-availability-"));
  afterAll(() => rmSync(home, { recursive: true, force: true }));
  const owner = simKey("owner");
  const cc = simKey("agent:claude-code");
  type NoNonce<T> = T extends unknown ? Omit<T, "nonce"> : never;
  let n = 0;

  it("every known venue judged from this network; the page's and the agents' route; an agent cannot ask the owner for a venue that refuses it", async () => {
    const BINANCE_451 = 'binance GET https://api.binance.com/api/v3/time 451 Unavailable For Legal Reasons {"code":0,"msg":"Service unavailable from a restricted location according to \'b. Eligibility\' in https://www.binance.com/en/terms."}';
    const openExchange: OpenExchange = async (id) => ({ id, name: id, has: {}, fetchTime: async () => { if (id === "binance") throw Object.assign(new Error(BINANCE_451), { name: "ExchangeNotAvailable" }); return 1; } }) as unknown as ExchangeClient;
    const http = async (url: string) => (url.includes("polymarket.com/api/geoblock") ? { status: 200, body: { blocked: false }, text: '{"blocked":false}' } : url.includes("alpaca") ? { status: 401, body: undefined, text: "401" } : url.includes("kalshi") ? { status: 200, body: {}, text: "{}" } : { status: 400, body: undefined, text: "missing headers" });
    const svc = await PortfolioService.create({ home, venues: "frontline", real: true, publicMarkets: [], liveDeps: { http, openExchange, mm: (async () => ({ authenticated: true })) as unknown as RunMm, price: async () => undefined }, account: { owners: [{ id: owner.address, kind: "eoa", label: "owner", addedAt: new Date().toISOString() }] } });
    const server = await startPortfolioServer({ port: 0, service: svc, snapshotMs: 3_600_000 });
    try {
      const v = (await (await fetch(`${server.url}/api/account/venues`)).json()) as { ok: boolean; venues: Array<{ connector: string; verdict: string; said?: string; group: string; needs: string }> };
      expect(v.ok).toBe(true);
      const by = new Map(v.venues.map((x) => [x.connector, x]));
      expect(by.get("live:exchange:binance")).toMatchObject({ verdict: "not-served", group: "Exchanges", needs: "key-file" });
      expect(by.get("live:exchange:binance")!.said).toContain("Service unavailable from a restricted location");
      expect(by.get("live:exchange:okx")).toMatchObject({ verdict: "connectable" });
      expect(by.get("live:exchange:binanceus")).toMatchObject({ verdict: "connectable" });
      expect(by.get("live:kalshi")).toMatchObject({ verdict: "connectable", group: "Markets and tokens" });
      expect(by.get("live:metamask")).toMatchObject({ verdict: "connectable", group: "Wallets", needs: "cli" });
      expect(by.get("live:wallet")).toMatchObject({ verdict: "connectable", needs: "address" });
      // an agent asks the owner to connect Binance: not asked, told why in Binance's words; OKX is asked
      const own = async (a: NoNonce<OwnerAction>) => svc.exchange(await signOwner(owner, { ...a, nonce: Date.now() + ++n } as OwnerAction));
      const ag = async (a: NoNonce<AgentAction>) => svc.exchange(await signAgent(cc, { ...a, nonce: Date.now() + ++n } as AgentAction));
      const approved = await own({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: Date.now() + 30 * 86_400_000 });
      expect(isRefusal(approved)).toBe(false);
      const no = await ag({ type: "agentAsk", kind: "venue", venue: "binance", usd: "0", text: "connect Binance so I can trade there" });
      expect(isRefusal(no) && no.code).toBe("E_VENUE_GEOBLOCKED");
      expect(isRefusal(no) && no.message).toContain("the owner is not asked: Binance does not serve the network this account runs on");
      const yes = await ag({ type: "agentAsk", kind: "venue", venue: "okx", usd: "0", text: "connect OKX so I can trade there" });
      expect(isRefusal(yes)).toBe(false);
      // a venue whose own terms exclude where the user is: judged so, and still asked of the owner (shown, never enforced)
      svc.venueTerms = (c, place) => (c === "live:exchange:kraken" ? { url: "https://www.kraken.com/legal", read: "2026-10-08", says: "…not available in…", excludesHere: place?.country === "ZZ" } : undefined);
      svc.venuePlace = async () => ({ country: "ZZ" });
      const judged = (await (await fetch(`${server.url}/api/account/venues?force=1`)).json()) as { venues: Array<{ connector: string; verdict: string; terms?: { excludesHere?: boolean } }> };
      expect(judged.venues.find((x) => x.connector === "live:exchange:kraken")).toMatchObject({ verdict: "terms-exclude", terms: { excludesHere: true } });
      expect(JSON.stringify(judged)).not.toContain("ZZ");
      const asked = await ag({ type: "agentAsk", kind: "venue", venue: "kraken", usd: "0", text: "connect Kraken" });
      expect(isRefusal(asked)).toBe(false);
    } finally {
      await server.close();
    }
  });
});
