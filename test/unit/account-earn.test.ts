import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isRefusal, type Refusal } from "../../src/core/errors.ts";
import { no } from "../../src/portfolio/refuse.ts";
import { cardHash, type Outcome } from "../../src/portfolio/account/exchange.ts";
import type { LiveEarn } from "../../src/portfolio/account/live-earn.ts";
import { signAgent, signOwner, simKey, type AgentAction, type OwnerAction } from "../../src/portfolio/account/sign.ts";
import type { EarnPosition, EarnProduct, EarnState, LiveEarner } from "../../src/portfolio/live/earn.ts";
import { register, type LiveDeps } from "../../src/portfolio/live/index.ts";
import { PortfolioService } from "../../src/portfolio/service.ts";

/** EARN at venues connected live, against a stand-in venue whose earn answers like a real one and remembers every request it is asked to
 * run. The door's rules are what is tested here — the switch, the cap, the owner's signature and what it holds, the agent's earn limit, the
 * two modes, withdrawals, the page, the read, a restart. Each venue's own language is tested in live-earn.test.ts. */
type NoNonce<T> = T extends unknown ? Omit<T, "nonce"> : never;
const START = Date.parse("2026-10-05T14:00:00.000Z");
const DAY = 86_400_000;
const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));
const owner = simKey("owner");
const cc = simKey("agent:claude-code");

interface Venue {
  earner: LiveEarner;
  products: Record<string, EarnProduct>;
  held: EarnPosition[];
  supplied: Array<{ product: string; amount: number; clientId: string }>;
  withdrawn: Array<{ product: string; amount: number; clientId: string; all: boolean }>;
  /** what a request is when it is sent, and what the venue says of it later */
  sendAs: EarnState["status"];
  later: Record<string, EarnState["status"]>;
  can: boolean | "unknown";
}
const USDT: EarnProduct = { id: "savings:USDT", asset: "USDT", name: "USDT · Simple Earn Flexible", apy: 0.0615, rateKind: "apr", protocol: "Stand-in Earn", lockDays: 0, priceUsd: 1, lands: "your Stand-in funding account", canSupply: true, canWithdraw: true, note: "lent hourly" };
const ETH: EarnProduct = { id: "staking:ETH", asset: "ETH", name: "ETH · bonded", apy: 0.03, rateKind: "apr", lockDays: 14, minAmount: 0.001, priceUsd: 2500, lands: "your Stand-in spot balance", canSupply: true, canWithdraw: true };

function standIn(): Venue {
  const v: Venue = { products: { [USDT.id]: { ...USDT }, [ETH.id]: { ...ETH } }, held: [{ product: USDT.id, id: USDT.id, asset: "USDT", amount: 40, usd: 40 }], supplied: [], withdrawn: [], sendAs: "done", later: {}, can: true, earner: undefined as never };
  v.earner = {
    get can() {
      return v.can;
    },
    what: "a stand-in's earn",
    async products(asset) {
      return Object.values(v.products).filter((p) => !asset || p.asset === asset);
    },
    async product(id) {
      return v.products[id] ? { ...v.products[id]! } : no("E_VENUE_REJECTED", { venue: "ex", message: `no product ${id}` });
    },
    async positions() {
      return v.held.map((h) => ({ ...h }));
    },
    async supply(p, amount, clientId) {
      v.supplied.push({ product: p.id, amount, clientId });
      return { ref: `s-${v.supplied.length}`, status: v.sendAs, native: { id: v.supplied.length } };
    },
    async withdraw(p, amount, clientId, all) {
      v.withdrawn.push({ product: p.id, amount, clientId, all });
      return { ref: `w-${v.withdrawn.length}`, status: v.sendAs, native: { id: v.withdrawn.length } };
    },
    async status(ref) {
      return { ref, status: v.later[ref] ?? "pending", native: {} };
    },
  };
  return v;
}

let current: Venue | undefined;
register({ kind: "standin-earn", label: "a venue that earns", needs: "key-file", example: "", venues: [], async open(req) {
  const v = current!;
  return { source: { name: req.label || "Stand-in", kind: "cex", reference: "standin", via: "a stand-in", probe: { can: ["read", "trade"], note: "" }, read: async () => [{ asset: "USDT", amount: 500, usd: 500 }], readOnlyBecause: "the stand-in moves no money", earner: v.earner } as never, first: [{ asset: "USDT", amount: 500, usd: 500 }], summary: "connected" };
} });

async function boot(o: { writes?: boolean; cap?: number; home?: string; nonceFrom?: number; venue?: Venue; later?: number } = {}) {
  let real = 5_000_000;
  let n = o.nonceFrom ?? 0;
  const home = o.home ?? mkdtempSync(join(tmpdir(), "account-earn-"));
  if (!o.home) homes.push(home);
  const venue = o.venue ?? standIn();
  current = venue;
  const liveDeps: Partial<LiveDeps> = { clock: () => real, http: async () => ({ status: 599, body: undefined, text: "" }), price: async () => undefined };
  // a later run is started later: its ledger is a file of its own, continuing the earlier one
  const svc = await PortfolioService.create({ home, now: () => new Date(START + (o.later ?? 0)).toISOString(), venues: "frontline", real: true, liveDeps, ...(o.writes === false ? {} : { liveWrites: { capUsd: o.cap ?? 100, pairingCode: "K7QX-M2PA" } }), account: { owners: [{ id: owner.address, kind: "eoa", label: "owner", addedAt: new Date(START).toISOString() }] } });
  const engine = svc.account!;
  const nonce = () => START + ++n;
  const own = async (a: NoNonce<OwnerAction>) => svc.exchange(await signOwner(owner, { ...a, nonce: nonce() } as OwnerAction));
  const ag = async (a: NoNonce<AgentAction>, key = cc) => svc.exchange(await signAgent(key, { ...a, nonce: nonce() } as AgentAction));
  if (!o.home) {
    const connected = await own({ type: "connectVenue", venue: "ex", connector: "live:standin-earn", label: "Stand-in", credentialRef: "" });
    if (isRefusal(connected)) throw new Error(connected.message);
  }
  const prepared = (draft: Record<string, unknown>) => engine.prepare({ type: "liveEarn", venue: "ex", ...draft });
  /** what the page does: prepare, then sign exactly what came back */
  const earn = async (draft: Record<string, unknown>, change: Record<string, unknown> = {}) => {
    const p = await prepared(draft);
    if (isRefusal(p)) return p;
    const { nonce: _n, ...rest } = p.action as Extract<OwnerAction, { type: "liveEarn" }>;
    return own({ ...rest, ...change } as NoNonce<OwnerAction>);
  };
  const letIn = async (limit: { allow?: string; perSupply?: string; budget?: string } = {}) => {
    await own({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: START + 30 * DAY });
    return own({ type: "approveSpend", agent: cc.address, scope: "earn", allow: limit.allow ?? "ex", perPayment: limit.perSupply ?? "50", budget: limit.budget ?? "100", windowHours: 0, validUntil: START + 7 * DAY });
  };
  const limit = () => engine.state.spends.find((s) => s.scope === "earn" && s.revokedAt === undefined)!;
  return { svc, engine, venue, home, own, ag, earn, prepared, letIn, limit, tick: (ms: number) => (real += ms), page: async () => (await svc.accountView())!, nonce: () => n };
}

const refusal = (o: unknown): Refusal => {
  if (!isRefusal(o)) throw new Error(`expected a refusal, got ${JSON.stringify(o).slice(0, 200)}`);
  return o;
};
const sent = (o: Outcome): LiveEarn => {
  const e = !isRefusal(o) && o.kind === "result" ? (o.result as { earn?: LiveEarn }).earn : undefined;
  if (!e) throw new Error(`expected an earn request, got ${isRefusal(o) ? `${o.code}: ${o.message}` : JSON.stringify(o).slice(0, 200)}`);
  return e;
};
const carded = (o: Outcome) => {
  if (isRefusal(o) || o.kind !== "card") throw new Error(`expected a card, got ${isRefusal(o) ? `${o.code}: ${o.message}` : o.kind}`);
  return o.card;
};
const ask = (o: Partial<Extract<AgentAction, { type: "agentLiveEarn" }>> = {}) => ({ type: "agentLiveEarn" as const, venue: "ex", kind: "supply", product: "savings:USDT", asset: "USDT", amount: "25", ...o });

describe("earn at venues connected live: the owner's door", () => {
  it("the owner's request: prepared with the product's yield, lock and where it lands, signed as shown, sent once, a statement line of type earn", async () => {
    const x = await boot();
    const p = await x.prepared({ kind: "supply", product: "savings:USDT", asset: "USDT", amount: "25" });
    if (isRefusal(p)) throw new Error(p.message);
    expect([p.action, p.accountChain, p.primaryType]).toEqual([{ type: "liveEarn", venue: "ex", kind: "supply", product: "savings:USDT", asset: "USDT", amount: "25", maxUsd: "25.00", lands: "your Stand-in funding account", deadline: 5_600_000, nonce: p.action.nonce }, "Live · real money", "AccountTransaction:LiveEarn"]);
    expect(p.quote?.earn).toMatchObject({ kind: "supply", productName: "USDT · Simple Earn Flexible", apy: 0.0615, rateKind: "apr", lockDays: 0, lands: "your Stand-in funding account", usd: 25, capUsd: 100 });
    expect(p.shown.map((f) => f.name)).toEqual(["venue", "kind", "product", "asset", "amount", "maxUsd", "lands", "deadline", "nonce"]);
    const e = sent(await x.earn({ kind: "supply", product: "savings:USDT", asset: "USDT", amount: "25" }));
    expect([e.id, e.kind, e.product, e.amount, e.usd, e.status, e.authority, e.lands]).toEqual(["earn-0001", "supply", "savings:USDT", 25, 25, "done", "owner", "your Stand-in funding account"]);
    expect(x.venue.supplied).toEqual([{ product: "savings:USDT", amount: 25, clientId: e.clientId }]);
    expect(e.clientId).toMatch(/^[0-9a-f]{32}$/);
    expect((await x.page()).earns.map((y) => [y.id, y.status])).toEqual([["earn-0001", "done"]]);
    const line = x.svc.statement().find((l) => l.id === "earn-0001")!;
    expect([line.type, line.kind, line.amountUsd, line.by, line.status]).toEqual(["earn", "supply", 25, "You", "done"]);
    expect(line.description).toBe("Supply 25 USDT · USDT · Simple Earn Flexible · 6.15% APR");
  });

  it("nothing moves on a read-only server, above the server's cap, at a venue with no earn, or for an asset the product does not take", async () => {
    const ro = await boot({ writes: false });
    expect(refusal(await ro.prepared({ kind: "supply", product: "savings:USDT", asset: "USDT", amount: "25" })).code).toBe("E_WALLET_LIVE_WRITES_OFF");
    const x = await boot({ cap: 50 });
    const big = refusal(await x.prepared({ kind: "supply", product: "staking:ETH", asset: "ETH", amount: "0.03" }));
    expect([big.code, big.message]).toEqual(["E_ACCOUNT_LIMIT", "$75.00 is more than the most one movement may be on this server ($50.00). It is set when the server starts: --live-cap"]);
    expect(refusal(await x.prepared({ venue: "nowhere", kind: "supply", product: "savings:USDT", asset: "USDT", amount: "5" })).code).toBe("E_WALLET_ACCOUNT_UNKNOWN");
    expect(refusal(await x.prepared({ kind: "supply", product: "savings:USDT", asset: "USDC", amount: "5" })).message).toBe("USDT · Simple Earn Flexible takes USDT, not USDC");
    expect(refusal(await x.prepared({ kind: "supply", product: "staking:ETH", asset: "ETH", amount: "0.0005" })).code).toBe("E_VENUE_ORDER_INVALID");
    expect(refusal(await x.prepared({ kind: "lend", product: "savings:USDT", asset: "USDT", amount: "5" })).code).toBe("E_ACCOUNT_BAD_ACTION");
    expect(refusal(await x.prepared({ kind: "supply", product: "savings:USDT", asset: "USDT", amount: "all" })).code).toBe("E_ACCOUNT_BAD_ACTION");
    x.venue.can = false;
    expect(refusal(await x.prepared({ kind: "supply", product: "savings:USDT", asset: "USDT", amount: "5" })).code).toBe("E_VENUE_PERMISSION");
    x.venue.products["savings:USDT"]!.canSupply = false;
    x.venue.can = true;
    expect(refusal(await x.prepared({ kind: "supply", product: "savings:USDT", asset: "USDT", amount: "5" })).code).toBe("E_VENUE_MARKET_CLOSED");
    expect([ro.venue.supplied.length, x.venue.supplied.length]).toEqual([0, 0]);
  });

  it("held to what was signed: a price that rose past it, a product that now lands elsewhere, ten minutes", async () => {
    const x = await boot();
    const p = await x.prepared({ kind: "supply", product: "staking:ETH", asset: "ETH", amount: "0.01" });
    if (isRefusal(p)) throw new Error(p.message);
    const { nonce: _n, ...rest } = p.action as Extract<OwnerAction, { type: "liveEarn" }>;
    x.venue.products["staking:ETH"]!.priceUsd = 2700;
    expect(refusal(await x.own(rest))).toMatchObject({ code: "E_ACCOUNT_REQUOTE", message: "the price moved: 0.01 ETH is worth $27.00 now, more than the $25.00 signed for. Nothing moved" });
    x.venue.products["staking:ETH"]!.priceUsd = 2500;
    x.venue.products["staking:ETH"]!.lands = "somewhere else";
    expect(refusal(await x.own(rest)).code).toBe("E_ACCOUNT_REQUOTE");
    x.venue.products["staking:ETH"]!.lands = ETH.lands;
    x.tick(11 * 60_000);
    expect(refusal(await x.own(rest)).code).toBe("E_ACCOUNT_EXPIRED");
    expect(x.venue.supplied).toHaveLength(0);
  });

  it("a withdrawal goes back where the money came from: no more than is held, all of it when asked, and it counts against nothing", async () => {
    const x = await boot();
    expect(refusal(await x.prepared({ kind: "withdraw", product: "savings:USDT", asset: "USDT", amount: "41" })).code).toBe("E_VENUE_INSUFFICIENT");
    expect(refusal(await x.prepared({ kind: "withdraw", product: "staking:ETH", asset: "ETH", amount: "0.01" })).code).toBe("E_ACCOUNT_BAD_ACTION");
    const all = await x.prepared({ kind: "withdraw", product: "savings:USDT", asset: "USDT", amount: "all" });
    if (isRefusal(all)) throw new Error(all.message);
    expect([all.action.type === "liveEarn" && all.action.amount, all.quote?.earn?.held]).toEqual(["40", { amount: 40, asset: "USDT", usd: 40 }]);
    const e = sent(await x.earn({ kind: "withdraw", product: "savings:USDT", asset: "USDT", amount: "all" }));
    expect([e.kind, e.all, e.amount, e.usd]).toEqual(["withdraw", true, 40, 40]);
    expect(x.venue.withdrawn).toEqual([{ product: "savings:USDT", amount: 40, clientId: e.clientId, all: true }]);
    expect(x.svc.statement().find((l) => l.id === e.id)!.description).toBe("Withdraw all of the USDT · USDT · Simple Earn Flexible · 6.15% APR · back to your Stand-in funding account");
  });

  it("a request the venue has not finished is followed until it says: done, or rejected", async () => {
    const x = await boot();
    x.venue.sendAs = "pending";
    const e = sent(await x.earn({ kind: "supply", product: "savings:USDT", asset: "USDT", amount: "10" }));
    expect([e.status, e.note]).toEqual(["pending", "Stand-in took it and has not finished it yet"]);
    x.venue.later[e.ref] = "done";
    x.tick(20_000);
    await x.engine.settle();
    expect((await x.page()).earns[0]).toMatchObject({ id: e.id, status: "done", note: "in USDT · Simple Earn Flexible: it earns from here" });
    expect(x.svc.statement().find((l) => l.id === e.id)!.status).toBe("done");
  });
});

describe("earn at venues connected live: an agent, inside the earn limit the owner signed", () => {
  it("no earn limit, no earn: a trading limit is not one; the limit names venues, or one product at a venue", async () => {
    const x = await boot();
    await x.own({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: START + 30 * DAY });
    expect(refusal(await x.ag(ask())).message).toBe("the owner has not approved this agent to put money to earn: it gets an earn limit on the account page (Agents)");
    await x.own({ type: "approveSpend", agent: cc.address, scope: "trade", allow: "ex", perPayment: "50", budget: "100", windowHours: 0, validUntil: START + 7 * DAY });
    expect(refusal(await x.ag(ask())).code).toBe("E_MANDATE_NONE");
    await x.own({ type: "approveSpend", agent: cc.address, scope: "earn", allow: "ex:staking:ETH", perPayment: "50", budget: "100", windowHours: 0, validUntil: START + 7 * DAY });
    expect(refusal(await x.ag(ask())).message).toBe('the earn limit does not cover "ex:savings:USDT" (it covers ex:staking:ETH)');
    expect(carded(await x.ag(ask({ product: "staking:ETH", asset: "ETH", amount: "0.01" }))).reason).toBe("Claude Code asks to put 0.01 ETH into ETH · bonded at Stand-in (3% APR) · about $25.00");
    // an earn limit names venues or products in plain words, nothing else
    expect(refusal(await x.own({ type: "approveSpend", agent: cc.address, scope: "earn", allow: "ex:savings:USDT‮", perPayment: "5", budget: "10", windowHours: 0, validUntil: START + 7 * DAY })).code).toBe("E_ACCOUNT_BAD_ACTION");
    expect(x.venue.supplied).toHaveLength(0);
  });

  it("Guard: a card every time, showing the product, its yield, the amount and where money lands; the owner's yes sends exactly it and counts it", async () => {
    const x = await boot();
    await x.letIn();
    const card = carded(await x.ag(ask()));
    expect([card.usd, card.offer?.payTo, card.offer?.network, x.venue.supplied.length, x.limit().reservedMicro]).toEqual([25, "USDT · Simple Earn Flexible", "worth about $25.00 · money taken out lands in your Stand-in funding account", 0, 25_000_000]);
    const page = await x.page();
    expect(page.cards.find((c) => c.id === card.id)).toMatchObject({ kind: "agentLiveEarn", agent: cc.address, agentName: "Claude Code" });
    const e = sent(await x.own({ type: "approveCard", card: card.id, action: cardHash(card), decision: "approve" }));
    expect([e.authority, e.agent, e.card, x.venue.supplied.length, x.limit().spentMicro, x.limit().reservedMicro]).toEqual(["agent", cc.address, card.id, 1, 25_000_000, 0]);
    const line = x.svc.statement().find((l) => l.id === e.id)!;
    expect([line.by, line.agentName]).toEqual(["Claude Code, approved by you", "Claude Code"]);
    // a no sends nothing and frees what the card held
    const two = carded(await x.ag(ask({ amount: "10" })));
    await x.own({ type: "approveCard", card: two.id, action: cardHash(two), decision: "reject" });
    expect([x.venue.supplied.length, x.limit().reservedMicro, x.limit().spentMicro]).toEqual([1, 0, 25_000_000]);
  });

  it("Beast: a supply inside the limit goes at once, nothing past the per-supply line or the budget; a withdrawal inside the line at once, counting nothing", async () => {
    const x = await boot();
    await x.letIn({ perSupply: "30", budget: "40" });
    await x.own({ type: "setPolicy", change: "mode", value: "open" });
    const e = sent(await x.ag(ask()));
    expect([e.authority, e.card, x.limit().spentMicro]).toEqual(["agent", undefined, 25_000_000]);
    expect(refusal(await x.ag(ask({ amount: "31" }))).code).toBe("E_MANDATE_PER_ORDER_CAP");
    expect(refusal(await x.ag(ask({ amount: "20" }))).code).toBe("E_MANDATE_BUDGET");
    const w = sent(await x.ag(ask({ kind: "withdraw", amount: "20" })));
    expect([w.kind, x.limit().spentMicro, x.venue.withdrawn.length]).toEqual(["withdraw", 25_000_000, 1]);
    // above the line, a withdrawal is the owner's card even in Beast
    expect(carded(await x.ag(ask({ kind: "withdraw", amount: "all" }))).usd).toBe(40);
    // a supply the venue later rejects gives its count back
    x.venue.sendAs = "pending";
    await x.own({ type: "approveSpend", agent: cc.address, scope: "earn", allow: "ex", perPayment: "30", budget: "100", windowHours: 0, validUntil: START + 7 * DAY });
    const p = sent(await x.ag(ask({ amount: "15" })));
    expect(x.limit().spentMicro).toBe(15_000_000);
    x.venue.later[p.ref] = "rejected";
    x.tick(20_000);
    await x.engine.settle();
    expect([x.limit().spentMicro, (await x.page()).earns[0]!.status]).toEqual([0, "rejected"]);
  });

  it("the dial: a venue switched off for agents, an ended session", async () => {
    const x = await boot();
    await x.letIn();
    x.svc.revoke("ex");
    expect(refusal(await x.ag(ask())).code).toBe("E_WALLET_ACCOUNT_REVOKED");
    x.svc.revokeAll();
    expect(refusal(await x.ag(ask())).code).toBe("E_WALLET_SESSION_EXPIRED");
    expect(x.venue.supplied).toHaveLength(0);
  });
});

describe("earn on the page, in the read, and after a restart", () => {
  it("the venues that earn are said on the page; the earn read answers products, what is held, and what could not be read", async () => {
    const x = await boot();
    const v = (await x.page()).venues.find((y) => y.id === "ex")!;
    expect(v.earn).toEqual({ can: true, what: "a stand-in's earn" });
    const r = await x.svc.earn({});
    if (isRefusal(r)) throw new Error(r.message);
    expect(r.products.map((p) => [p.venue, p.id, p.apy])).toEqual([["ex", "savings:USDT", 0.0615], ["ex", "staking:ETH", 0.03]]);
    expect(r.positions.map((p) => [p.venue, p.product, p.amount])).toEqual([["ex", "savings:USDT", 40]]);
    expect([r.missing, r.writes.on, r.venues]).toEqual([[], true, [{ venue: "ex", venueName: "Stand-in", can: true, what: "a stand-in's earn" }]]);
    const eth = await x.svc.earn({ asset: "ETH" });
    if (isRefusal(eth)) throw new Error(eth.message);
    expect([eth.products.map((p) => p.id), eth.positions]).toEqual([["staking:ETH"], []]);
    expect(refusal(await x.svc.earn({ venue: "nowhere" })).code).toBe("E_VENUE_RAIL_CLOSED");
    // a venue that does not answer is said, in its words, and the rest stands
    const down = standIn();
    down.earner.positions = async () => no("E_VENUE_UNREACHABLE", { venue: "ex", message: "Stand-in did not answer" });
    const z = await boot({ venue: down });
    const partial = await z.svc.earn({});
    if (isRefusal(partial)) throw new Error(partial.message);
    expect([partial.products.length, partial.positions, partial.missing]).toEqual([2, [], [{ venue: "ex", venueName: "Stand-in", why: "Stand-in did not answer", code: "E_VENUE_UNREACHABLE", part: "earn" }]]);
  });

  it("after a restart: the earn limit comes back verified, and a request the venue had not finished is followed again — nothing is sent again", async () => {
    const x = await boot();
    await x.letIn({ perSupply: "30", budget: "100" });
    x.venue.sendAs = "pending";
    const e = sent(await x.earn({ kind: "supply", product: "savings:USDT", asset: "USDT", amount: "10" }));
    const y = await boot({ home: x.home, nonceFrom: x.nonce() + 60_000, venue: x.venue, later: 60_000 });
    await y.svc.restoring;
    expect(y.limit()).toMatchObject({ scope: "earn", allow: ["ex"], perPaymentMicro: 30_000_000 });
    const back = y.engine.earns.find((z) => z.clientId === e.clientId)!;
    expect([back.id, back.status, back.note]).toEqual([e.id, "pending", "Stand-in took it and has not finished it yet · followed again after a restart"]);
    expect(x.venue.supplied).toHaveLength(1);
    // the next request takes the next id, never one an earlier run used
    y.venue.sendAs = "done";
    expect(sent(await y.earn({ kind: "supply", product: "savings:USDT", asset: "USDT", amount: "5" })).id).toBe("earn-0002");
    y.venue.later[e.ref] = "done";
    y.tick(20_000);
    await y.engine.settle();
    expect(y.engine.earns.find((z) => z.clientId === e.clientId)!.status).toBe("done");
  });
});
