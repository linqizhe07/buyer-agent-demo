import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isRefusal, type Refusal } from "../../src/core/errors.ts";
import type { Outcome } from "../../src/portfolio/account/exchange.ts";
import { signAgent, signOwner, simKey, type AgentAction, type OwnerAction } from "../../src/portfolio/account/sign.ts";
import type { ExchangeClient, OpenExchange } from "../../src/portfolio/live/exchange.ts";
import type { LiveDeps } from "../../src/portfolio/live/index.ts";
import { PortfolioService } from "../../src/portfolio/service.ts";

/** The server's account holds REAL accounts only: no simulated venue, payee, plug-in or clock reaches it. The exchange here is a stand-in
 * that answers like the exchange library; the key is made up on the spot. */
type NoNonce<T> = T extends unknown ? Omit<T, "nonce"> : never;
const START = Date.parse("2026-10-05T14:00:00.000Z");
const DAY = 86_400_000;
const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));

const owner = simKey("owner");
const cc = simKey("agent:claude-code");

function fakeExchange(id: string): ExchangeClient {
  return {
    id,
    name: id === "binance" ? "Binance" : id.toUpperCase(),
    requiredCredentials: { apiKey: true, secret: true },
    markets: { "ETH/USDT": {} },
    async loadMarkets() {},
    async fetchTime() {
      return 1;
    },
    async fetchBalance(params = {}) {
      return params.type === "funding" ? { total: { USDT: 50 } } : { total: { USDT: 400, ETH: 0.1 } };
    },
    async fetchTickers() {
      return { "ETH/USDT": { last: 2000 } };
    },
    async sapiGetAccountApiRestrictions() {
      return { ipRestrict: true, enableReading: true, enableWithdrawals: false, enableSpotAndMarginTrading: false, permitsUniversalTransfer: false };
    },
  };
}

async function boot() {
  const home = mkdtempSync(join(tmpdir(), "account-real-"));
  homes.push(home);
  let n = 0;
  const open: OpenExchange = async (id) => (id === "binance" ? fakeExchange(id) : undefined);
  const liveDeps: Partial<LiveDeps> = { openExchange: open, clock: () => START, http: async () => ({ status: 599, body: undefined, text: "no network in tests" }), price: async (asset) => ({ ETH: 2000 })[asset] };
  const svc = await PortfolioService.create({ home, now: () => new Date(START).toISOString(), venues: "frontline", real: true, liveDeps, account: { owners: [{ id: owner.address, kind: "eoa", label: "owner", addedAt: new Date(START).toISOString() }] } });
  const own = async (a: NoNonce<OwnerAction>) => svc.exchange(await signOwner(owner, { ...a, nonce: START + ++n } as OwnerAction));
  const ag = async (a: NoNonce<AgentAction>) => svc.exchange(await signAgent(cc, { ...a, nonce: START + ++n } as AgentAction));
  const keyFile = (ref: string) => {
    const path = join(home, ref);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ apiKey: "made-up-key-0001", secret: "made-up-secret-0001" }));
    chmodSync(path, 0o600);
  };
  return { svc, own, ag, keyFile, page: async () => (await svc.accountView())! };
}

const refusal = (o: Outcome): Refusal => {
  if (!isRefusal(o)) throw new Error(`expected a refusal, got ${o.kind}`);
  return o;
};
const summary = (o: Outcome): string => {
  if (isRefusal(o) || o.kind !== "account") throw new Error(`expected a summary, got ${isRefusal(o) ? `${o.code}: ${o.message}` : o.kind}`);
  return o.summary;
};

describe("a real account", () => {
  it("starts with nothing on it: no simulated venue, payee or plug-in anywhere on the service", async () => {
    const x = await boot();
    const p = await x.page();
    expect([p.real, p.venues, p.connectable, p.pay, p.liveUsd, p.totalUsd]).toEqual([true, [], [], { payees: [], sessions: [] }, 0, 0]);
    expect(p.connectLive?.options.some((o) => o.connector === "live:exchange")).toBe(true);
    expect(x.svc.payees).toBeUndefined();
    expect(x.svc.accounts()).toEqual([]);
    // real money starts Conservative: every move an agent asks for waits for the owner
    expect(x.svc.policy().mode).toBe("guard");
    expect((await x.svc.overview()).portfolio.totalUsd).toBe(0);
  });

  it("a real connection is the account's, and disconnecting it leaves nothing behind", async () => {
    const x = await boot();
    x.keyFile("credentials/binance/api-key.json");
    const said = summary(await x.own({ type: "connectVenue", venue: "binance", connector: "live:exchange:binance", label: "", credentialRef: "" }));
    expect(said).toMatch(/^Binance connected live · \$650\.00 there now · /);
    expect(said).not.toContain("simulated");
    const p = await x.page();
    expect(p.venues.map((v) => [v.id, v.live, v.usd])).toEqual([["binance", true, 650]]);
    expect([p.liveUsd, p.totalUsd]).toEqual([650, 650]);
    expect(x.svc.adapter("binance")!.account.watchOnly).toBeTruthy();

    const gone = summary(await x.own({ type: "disconnectVenue", venue: "binance" }));
    expect(gone).toBe("Binance disconnected: the account no longer reads it. The key at the venue is untouched: delete it there");
    expect((await x.page()).venues).toEqual([]);
    expect(x.svc.adapter("binance")).toBeUndefined();
  });

  it("what moves only simulated money is refused at the door, and so are a simulated connector and the simulated clock", async () => {
    const x = await boot();
    summary(await x.own({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: START + 30 * DAY }));
    const realOnly = (o: Outcome) => {
      const r = refusal(o);
      expect(r.code).toBe("E_ACCOUNT_BAD_ACTION");
      expect(r.message).toContain("this account holds real accounts only");
      return r;
    };
    realOnly(await x.own({ type: "sendAsset", destination: "self", sourceDex: "metamask", destinationDex: "okx", token: "USDC", amount: "100", fromSubAccount: "", route: `0x${"00".repeat(32)}`, maxFee: "1", deadline: START + DAY }));
    realOnly(await x.own({ type: "createSubAccount", name: "cc-float", agent: cc.address, float: "50" }));
    realOnly(await x.own({ type: "setDestination", label: "friend", address: `0x${"ab".repeat(20)}`, chain: "Base", token: "USDC" }));
    realOnly(await x.own({ type: "approveSpend", agent: cc.address, scope: "payees", allow: "data.sim", perPayment: "1", budget: "5", windowHours: 0, validUntil: START + DAY }));
    realOnly(await x.ag({ type: "agentSendAsset", destination: "self", sourceDex: "okx", destinationDex: "metamask", token: "USDC", amount: "10", fromSubAccount: "", maxFee: "1" }));
    realOnly(await x.ag({ type: "agentPay", url: "https://data.sim/v1/quotes", maxAmount: "0.05", fromSubAccount: "cc-float" }));
    const prepared = await x.svc.account!.prepare({ type: "sendAsset", sourceDex: "metamask", destinationDex: "okx", amount: "10" });
    expect(isRefusal(prepared) && prepared.message).toContain("real accounts only");
    // moving between the account's real venues is still the owner's to approve for an agent: "all of them" is the venues connected when it is signed
    expect(refusal(await x.own({ type: "approveSpend", agent: cc.address, scope: "venues", allow: "*", perPayment: "50", budget: "200", windowHours: 0, validUntil: START + 7 * DAY })).message).toBe("a spending approval names where the money may go");
    x.keyFile("credentials/binance/api-key.json");
    summary(await x.own({ type: "connectVenue", venue: "binance", connector: "live:exchange:binance", label: "", credentialRef: "" }));
    expect(summary(await x.own({ type: "approveSpend", agent: cc.address, scope: "venues", allow: "*", perPayment: "50", budget: "200", windowHours: 0, validUntil: START + 7 * DAY }))).toContain("spending approval: venues");
    expect((await x.page()).spend.map((s) => s.allow)).toEqual([["binance"]]);

    expect(refusal(await x.own({ type: "connectVenue", venue: "bybit", connector: "unified", label: "Bybit", credentialRef: "home/credentials/bybit/api-key.json" })).message).toContain('"unified" is a simulated connector');
    expect(refusal(await x.own({ type: "setPolicy", change: "advance", value: "60" })).message).toBe("this account runs on the real clock: nothing here is simulated");
    expect(refusal(await x.own({ type: "setPolicy", change: "reset", value: "" })).message).toContain("it is not reset from here");
  });

  it("the simulated trading demo is not on it: an agent's trade at a simulated venue finds no such account", async () => {
    const x = await boot();
    const r = await x.svc.execute("ondo", { kind: "move", asset: "USDC", amount: 300, to: "0x7a11…stranger" });
    expect(isRefusal(r) && r.code).toBe("E_WALLET_ACCOUNT_UNKNOWN");
    expect((await x.page()).cards).toEqual([]);
  });
});
