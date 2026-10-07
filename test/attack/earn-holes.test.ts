import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isRefusal, type Refusal } from "../../src/core/errors.ts";
import { no } from "../../src/portfolio/refuse.ts";
import { cardHash, type Outcome } from "../../src/portfolio/account/exchange.ts";
import type { LiveEarn } from "../../src/portfolio/account/live-earn.ts";
import { signAgent, signOwner, simKey, type AgentAction, type Envelope, type OwnerAction } from "../../src/portfolio/account/sign.ts";
import type { EarnPosition, EarnProduct, LiveEarner } from "../../src/portfolio/live/earn.ts";
import { register, type LiveDeps } from "../../src/portfolio/live/index.ts";
import { metamaskSource, MmError, type RunMm } from "../../src/portfolio/live/metamask.ts";
import { krakenEarner } from "../../src/portfolio/live/earn.ts";
import ccxt from "ccxt";
import { PortfolioService } from "../../src/portfolio/service.ts";

/** ATTACKS on the earn door, and on Hyperliquid's line for perpetuals: what an agent (or a tampered request) tries, and what stops it.
 *
 *   the cap            no supply or withdrawal worth more than the server's --live-cap, the owner's or an agent's
 *   the earn limit     an agent cannot put in more than one supply's line, more than what is left, or anywhere the limit does not name —
 *                      not with two cards waiting at once, not by approving a card after the owner shrank the limit
 *   the destination    a withdrawal names none: a field that would carry one is not part of what is signed, a `lands` that is not the
 *                      product's own is refused, another venue's product is not this venue's, and no adapter is handed one
 *   replay             the same signed request is one request, in this run and the next
 *   Guard       an agent's request is a card, every time
 *   MetaMask's switch  mm's earn moves nothing unless PORTFOLIO_MM_WRITES is 1 — held here in an env object, never in the shell
 *   Hyperliquid        a perpetual's order, close or leverage from a place Hyperliquid's terms close is refused before anything is sent
 *   a status blip      Kraken's status call failing for its own reasons (a nonce, the key) is not the request failing: it stays under way,
 *                      and the agent's earn budget is not given back while Kraken may still be allocating
 *   a thin vault       a vault named by its id is held to the same floor as the list shown: an agent cannot reach one the owner never saw
 *   every account      an earn limit names its venues: "*" is refused when prepared, before anything is signed, and at the door
 */
type NoNonce<T> = T extends unknown ? Omit<T, "nonce"> : never;
const START = Date.parse("2026-10-05T14:00:00.000Z");
const DAY = 86_400_000;
const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));
const owner = simKey("owner");
const cc = simKey("agent:claude-code");
const ATTACKER = "0x00000000000000000000000000000000000BAD00";

// ---- a venue that earns, remembering every call it is asked to run ----------------------------------------------------------

interface Venue {
  earner: LiveEarner;
  products: Record<string, EarnProduct>;
  held: EarnPosition[];
  calls: Array<{ what: "supply" | "withdraw"; args: unknown[] }>;
}
const USDT: EarnProduct = { id: "savings:USDT", asset: "USDT", name: "USDT · Simple Earn Flexible", apy: 0.06, rateKind: "apr", lockDays: 0, priceUsd: 1, lands: "your Stand-in funding account", canSupply: true, canWithdraw: true };
function standIn(products: EarnProduct[] = [USDT]): Venue {
  const v: Venue = { products: Object.fromEntries(products.map((p) => [p.id, { ...p }])), held: [{ product: USDT.id, id: USDT.id, asset: "USDT", amount: 90, usd: 90 }], calls: [], earner: undefined as never };
  v.earner = {
    can: true,
    what: "a stand-in's earn",
    products: async () => Object.values(v.products),
    product: async (id) => (v.products[id] ? { ...v.products[id]! } : no("E_VENUE_REJECTED", { venue: "x", message: `no product ${id} here` })),
    positions: async () => v.held.map((h) => ({ ...h })),
    async supply(...args) {
      v.calls.push({ what: "supply", args });
      return { ref: `s-${v.calls.length}`, status: "done", native: {} };
    },
    async withdraw(...args) {
      v.calls.push({ what: "withdraw", args });
      return { ref: `w-${v.calls.length}`, status: "done", native: {} };
    },
  };
  return v;
}
const venues = new Map<string, Venue>();
register({ kind: "standin-earn-attack", label: "a venue that earns", needs: "key-file", example: "", venues: [], async open(req) {
  const v = venues.get(req.venue)!;
  return { source: { name: req.label || "Stand-in", kind: "cex", reference: "standin", via: "a stand-in", probe: { can: ["read", "trade"], note: "" }, read: async () => [{ asset: "USDT", amount: 500, usd: 500 }], earner: v.earner } as never, first: [{ asset: "USDT", amount: 500, usd: 500 }], summary: "connected" };
} });

// ---- the MetaMask Agent Wallet through a stand-in mm, its switch in an env object -----------------------------------------------

const WALLET = "0x00000000000000000000000000000000000000Aa";
const VAULT = "0x7bfa7c4f149e7415b73bdedfe609237e29cbf34a";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BTC_ROW = { venue: "hyperliquid", symbol: "BTC", maxLeverage: 40, sizeDecimals: 5, markPrice: "60000.0", fundingRate: "0.0000125", volume24h: "2500000000.0" };
const BTC_POS = { venue: "hyperliquid", symbol: "BTC", side: "long", size: "0.001", entryPrice: "59000.0", positionValue: "60.0", unrealizedPnl: "1.0", marginUsed: "12.0", leverage: 5 };
interface Mm {
  calls: string[][];
  answers: Record<string, unknown>;
  env: Record<string, string | undefined>;
}
let mm: Mm = { calls: [], answers: {}, env: {} };
const mmRun: RunMm = async <T>(args: string[]): Promise<T> => {
  mm.calls.push([...args]);
  const key = args.slice(0, args[0] === "predict" && args[1] === "markets" ? 3 : 2).join(" ");
  const a = mm.answers[key];
  const out = typeof a === "function" ? (a as (x: string[]) => unknown)(args) : a;
  if (out === undefined) throw new MmError({ code: "NOT_SET_UP", message: `not set up: mm ${args.join(" ")}` });
  if (out instanceof Error) throw out;
  return out as T;
};
register({ kind: "standin-mm", label: "the MetaMask Agent Wallet through a stand-in mm", needs: "cli", example: "", venues: [], async open(req) {
  const o = await metamaskSource({ venue: req.venue, label: req.label, run: mmRun, env: mm.env, now: () => START });
  return isRefusal(o) ? o : { ...o, summary: "connected" };
} });
const MM_ANSWERS = (): Record<string, unknown> => ({
  "wallet show": { address: WALLET, tradingMode: "guard", policyYaml: "rolling_24h: 50" },
  "wallet balance": { currency: "usd", totalValue: "40", chains: [] },
  "earn markets": [{ address: VAULT, chainId: 8453, name: "Steakhouse USDC", protocol: { name: "morpho" }, underlyingTokens: [{ address: USDC_BASE, symbol: "USDC", decimals: 6 }], apy: { total: 0.0534 }, tvlUsd: 12_500_000, isTransactional: true, isRedeemable: true }],
  "earn positions": [{ chainId: 8453, vaultAddress: VAULT, protocolName: "morpho", asset: { address: USDC_BASE, symbol: "USDC", decimals: 6 }, balanceUsd: 30, balanceNative: "30000000" }],
  "earn supply": { hash: `0x${"ab".repeat(32)}`, symbol: "USDC", chainId: 8453, vaultName: "Steakhouse USDC", protocol: "morpho" },
  "perps markets": (args: string[]) => (args.includes("--symbol") && args[args.indexOf("--symbol") + 1] !== "BTC" ? [] : [BTC_ROW]),
  "perps positions": () => [BTC_POS],
  "predict positions": { command: "positions", params: {}, result: { positions: [] } },
  "predict geoblock": { command: "geoblock", result: { blocked: true, ip: "198.51.100.23", country: "US", region: "PA" } },
  "perps open": { venue: "hyperliquid", symbol: "BTC", orderId: "1", status: "filled", averagePrice: "60000", filledSize: "0.001" },
});

async function boot(o: { cap?: number; home?: string; nonceFrom?: number; later?: number; mmEnv?: Record<string, string | undefined> } = {}) {
  let n = o.nonceFrom ?? 0;
  const home = o.home ?? mkdtempSync(join(tmpdir(), "earn-holes-"));
  if (!o.home) homes.push(home);
  let real = 5_000_000;
  // a wallet the account was shown to be the user's: the stand-in mm's address
  const liveDeps: Partial<LiveDeps> = { clock: () => real, http: async () => ({ status: 599, body: undefined, text: "" }), price: async () => undefined, proofs: { proven: (a: string) => (a.toLowerCase() === WALLET.toLowerCase() ? { address: a, wallet: "the stand-in mm's wallet", at: 0 } : undefined), keep: () => undefined } as never };
  if (!o.home) {
    venues.set("ex", standIn());
    venues.set("ex2", standIn([{ ...USDT, id: "savings:USDC", asset: "USDC", name: "USDC · elsewhere" }]));
    mm = { calls: [], answers: MM_ANSWERS(), env: o.mmEnv ?? {} };
  }
  const svc = await PortfolioService.create({ home, now: () => new Date(START + (o.later ?? 0)).toISOString(), venues: "frontline", real: true, liveDeps, liveWrites: { capUsd: o.cap ?? 100, pairingCode: "K7QX-M2PA" }, account: { owners: [{ id: owner.address, kind: "eoa", label: "owner", addedAt: new Date(START).toISOString() }] } });
  const engine = svc.account!;
  const nonce = () => START + (o.later ?? 0) + ++n;
  const own = async (a: NoNonce<OwnerAction>) => svc.exchange(await signOwner(owner, { ...a, nonce: nonce() } as OwnerAction));
  const ag = async (a: NoNonce<AgentAction>) => svc.exchange(await signAgent(cc, { ...a, nonce: nonce() } as AgentAction));
  if (!o.home) {
    for (const [venue, connector] of [["ex", "live:standin-earn-attack"], ["ex2", "live:standin-earn-attack"], ["mmw", "live:standin-mm"]] as const) {
      const c = await own({ type: "connectVenue", venue, connector, label: venue === "mmw" ? "MetaMask Agent Wallet" : venue === "ex" ? "Stand-in" : "Elsewhere", credentialRef: "" });
      if (isRefusal(c)) throw new Error(c.message);
    }
  }
  const letIn = async (limit: { scope?: string; allow?: string; per?: string; budget?: string } = {}) => {
    await own({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: START + 30 * DAY });
    return own({ type: "approveSpend", agent: cc.address, scope: limit.scope ?? "earn", allow: limit.allow ?? "ex", perPayment: limit.per ?? "50", budget: limit.budget ?? "100", windowHours: 0, validUntil: START + 7 * DAY });
  };
  const earnLimit = () => engine.state.spends.find((s) => s.scope === "earn" && s.revokedAt === undefined)!;
  const signed = async (draft: Record<string, unknown>, change: Record<string, unknown> = {}) => {
    const p = await engine.prepare({ type: "liveEarn", venue: "ex", ...draft });
    if (isRefusal(p)) throw new Error(p.message);
    const { nonce: _n, ...rest } = p.action as Extract<OwnerAction, { type: "liveEarn" }>;
    return { ...rest, ...change } as NoNonce<OwnerAction>;
  };
  return { svc, engine, home, own, ag, letIn, earnLimit, signed, nonce: () => n, ex: venues.get("ex")!, ex2: venues.get("ex2")!, tick: (ms: number) => (real += ms) };
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
const ask = (o: Record<string, unknown> = {}) => ({ type: "agentLiveEarn" as const, venue: "ex", kind: "supply", product: "savings:USDT", asset: "USDT", amount: "25", ...o });

describe("ATTACK: earn past the server's cap", () => {
  it("the owner's signature does not lift the cap, nor an agent's limit that is bigger than it", async () => {
    const x = await boot({ cap: 20 });
    // signed by hand for more than the cap: planned again at the door, and refused there
    const big = refusal(await x.own({ type: "liveEarn", venue: "ex", kind: "supply", product: "savings:USDT", asset: "USDT", amount: "25", maxUsd: "25.00", lands: USDT.lands, deadline: 5_600_000 }));
    expect(big.code).toBe("E_ACCOUNT_LIMIT");
    await x.letIn({ per: "1000", budget: "5000" });
    await x.own({ type: "setPolicy", change: "mode", value: "open" });
    expect(refusal(await x.ag(ask())).code).toBe("E_ACCOUNT_LIMIT");
    // a withdrawal too: money coming back is still a movement of real money
    expect(refusal(await x.ag(ask({ kind: "withdraw", amount: "21" }))).code).toBe("E_ACCOUNT_LIMIT");
    expect(x.ex.calls).toEqual([]);
    expect(x.earnLimit().spentMicro).toBe(0);
  });
});

describe("ATTACK: earn past the agent's earn limit", () => {
  it("not past one supply's line, not past what is left, not with two cards waiting at once, not by approving after the owner shrank it", async () => {
    const x = await boot();
    await x.letIn({ per: "30", budget: "50" });
    expect(refusal(await x.ag(ask({ amount: "31" }))).code).toBe("E_MANDATE_PER_ORDER_CAP");
    // two cards: the first holds its share while it waits, so the second cannot also fit
    const one = carded(await x.ag(ask({ amount: "30" })));
    expect(refusal(await x.ag(ask({ amount: "30" }))).code).toBe("E_MANDATE_BUDGET");
    // the owner shrinks the limit: the card waiting under the old one is judged against the new one when it is answered
    await x.own({ type: "approveSpend", agent: cc.address, scope: "earn", allow: "ex", perPayment: "10", budget: "10", windowHours: 0, validUntil: START + 7 * DAY });
    const late = refusal(await x.own({ type: "approveCard", card: one.id, action: cardHash(one), decision: "approve" }));
    expect(late.code).toBe("E_MANDATE_PER_ORDER_CAP");
    // and a venue the limit does not name is not covered, whatever its product
    expect(refusal(await x.ag(ask({ venue: "ex2", product: "savings:USDC", asset: "USDC", amount: "5" }))).code).toBe("E_MANDATE_RECIPIENT");
    // a trading limit is not an earn limit, and an earn limit is not a trading limit
    expect(refusal(await x.ag({ type: "agentLiveOrder", venue: "ex", symbol: "BTC/USDT", side: "buy", orderType: "market", qty: "", usd: "5", limitPrice: "" })).code).toBe("E_MANDATE_NONE");
    expect(x.ex.calls).toEqual([]);
  });
});

describe("ATTACK: a withdrawal sent anywhere else", () => {
  it("no request carries a destination: a field that would is not part of what is signed, `lands` is the product's own, another venue's product is not this one's", async () => {
    const x = await boot();
    await x.letIn();
    await x.own({ type: "setPolicy", change: "mode", value: "open" });
    for (const extra of [{ toAddress: ATTACKER }, { destination: ATTACKER }, { to: "ex2" }]) {
      const r = refusal(await x.ag({ ...ask({ kind: "withdraw", amount: "10" }), ...extra } as never));
      expect([r.code, r.message]).toEqual(["E_ACCOUNT_BAD_ACTION", `"${Object.keys(extra)[0]}" is not part of "agentLiveEarn"`]);
      const o = refusal(await x.own({ ...(await x.signed({ kind: "withdraw", product: "savings:USDT", asset: "USDT", amount: "10" })), ...extra } as never));
      expect(o.message).toBe(`"${Object.keys(extra)[0]}" is not part of what "liveEarn" signs`);
    }
    // the owner signed where it lands: anything but the product's own place is refused before the venue is asked
    expect(refusal(await x.own(await x.signed({ kind: "withdraw", product: "savings:USDT", asset: "USDT", amount: "10" }, { lands: ATTACKER }))).code).toBe("E_ACCOUNT_REQUOTE");
    // another venue's product named at this venue: this venue has none of that name
    expect(refusal(await x.ag(ask({ kind: "withdraw", product: "savings:USDC", asset: "USDC", amount: "5" }))).message).toBe("no product savings:USDC here");
    expect(x.ex.calls).toEqual([]);
    // what reaches the venue is the product, the amount, the account's id and whether it is all of it — and nothing that says where
    sent(await x.ag(ask({ kind: "withdraw", amount: "10" })));
    expect(x.ex.calls).toHaveLength(1);
    const [p, amount, clientId, all, ...rest] = x.ex.calls[0]!.args as [EarnProduct, number, string, boolean, ...unknown[]];
    expect([p.id, amount, typeof clientId, all, rest]).toEqual(["savings:USDT", 10, "string", false, []]);
    // and mm's withdrawal: back to the wallet on the vault's chain, no flag that would send it elsewhere
    mm.env.PORTFOLIO_MM_WRITES = "1";
    mm.answers["earn withdraw"] = { hash: `0x${"cd".repeat(32)}`, symbol: "USDC", chainId: 8453 };
    sent(await x.own({ type: "liveEarn", venue: "mmw", kind: "withdraw", product: `8453:${VAULT}`, asset: "USDC", amount: "10", maxUsd: "10.00", lands: "your MetaMask Agent Wallet on Base", deadline: 5_600_000 }));
    const argv = mm.calls.find((a) => a[1] === "withdraw")!;
    expect(argv).toEqual(["earn", "withdraw", "--vault", VAULT, "--chain-id", "8453", "--amount", "10", "--wallet-timeout", "600", "--json"]);
  });
});

describe("ATTACK: replaying a signed earn request", () => {
  it("the same envelope is one request; the same nonce again is refused; an old one has lapsed; a later run of the account does not take it again", async () => {
    const x = await boot();
    const action = { ...(await x.signed({ kind: "supply", product: "savings:USDT", asset: "USDT", amount: "5" })), nonce: START + 1_000 } as OwnerAction;
    const env: Envelope = await signOwner(owner, action);
    const a = sent(await x.svc.exchange(env));
    const b = sent(await x.svc.exchange(env));
    expect([a.id, b.id, x.ex.calls.length]).toEqual(["earn-0001", "earn-0001", 1]);
    // the agent's request with a nonce already used
    await x.letIn();
    await x.own({ type: "setPolicy", change: "mode", value: "open" });
    const first = await signAgent(cc, { ...ask({ amount: "5" }), nonce: START + 2_000 } as AgentAction);
    sent(await x.svc.exchange(first));
    const again = await signAgent(cc, { ...ask({ amount: "6" }), nonce: START + 2_000 } as AgentAction);
    expect(refusal(await x.svc.exchange(again)).code).toBe("E_ACCOUNT_NONCE");
    // dated eleven minutes ago: a money instruction lapses in ten
    const old = await signAgent(cc, { ...ask({ amount: "4" }), nonce: START - 11 * 60_000 } as AgentAction);
    expect(refusal(await x.svc.exchange(old)).code).toBe("E_ACCOUNT_EXPIRED");
    expect(x.ex.calls).toHaveLength(2);
    // a later run reads the earlier one's ledger: the owner's envelope was taken there, and is not taken again
    const y = await boot({ home: x.home, nonceFrom: x.nonce() + 100, later: 60_000 });
    await y.svc.restoring;
    const r = refusal(await y.svc.exchange(env));
    expect(["E_ACCOUNT_NONCE", "E_ACCOUNT_EXPIRED"]).toContain(r.code);
    expect(x.ex.calls).toHaveLength(2);
  });
});

describe("ATTACK: an agent that hopes Guard lets it through", () => {
  it("in Guard every request inside the limit is a card, a supply and a withdrawal alike; nothing reaches the venue until the owner signs", async () => {
    const x = await boot();
    await x.letIn();
    expect(carded(await x.ag(ask({ amount: "5" }))).usd).toBe(5);
    expect(carded(await x.ag(ask({ kind: "withdraw", amount: "5" }))).usd).toBe(5);
    expect(x.ex.calls).toEqual([]);
  });
});

describe("ATTACK: MetaMask's own switch", () => {
  it("mm's earn moves nothing while PORTFOLIO_MM_WRITES is not 1, whoever signs: the command that would run is said, and only reads ran", async () => {
    const x = await boot({ mmEnv: {} });
    const r = refusal(await x.own({ type: "liveEarn", venue: "mmw", kind: "supply", product: `8453:${VAULT}`, asset: "USDC", amount: "10", maxUsd: "10.00", lands: "your MetaMask Agent Wallet on Base", deadline: 5_600_000 }));
    expect([r.code, (r.detail as { commands: string[] }).commands]).toEqual(["E_WALLET_LIVE_WRITES_OFF", [`mm earn supply --vault ${VAULT} --amount 10 --chain-id 8453 --wallet-timeout 600 --json`]]);
    expect(mm.calls.some((a) => a[0] === "earn" && (a[1] === "supply" || a[1] === "withdraw"))).toBe(false);
    // an agent inside its limit, Beast: the same switch
    await x.letIn({ allow: "mmw" });
    await x.own({ type: "setPolicy", change: "mode", value: "open" });
    expect(refusal(await x.ag(ask({ venue: "mmw", product: `8453:${VAULT}`, asset: "USDC", amount: "5" }))).code).toBe("E_WALLET_LIVE_WRITES_OFF");
    expect(x.earnLimit().spentMicro).toBe(0);
    expect(mm.calls.some((a) => a[0] === "earn" && (a[1] === "supply" || a[1] === "withdraw"))).toBe(false);
  });
});

describe("ATTACK: a perpetual from a place Hyperliquid's terms close", () => {
  it("an order, a close and a leverage change at Hyperliquid are refused in Hyperliquid's words before anything is sent, whoever signs", async () => {
    const x = await boot({ mmEnv: { PORTFOLIO_MM_WRITES: "1" } });
    const p = await x.engine.prepare({ type: "liveOrder", venue: "mmw", symbol: "BTC-PERP", side: "buy", orderType: "market", qty: "0.001" });
    if (isRefusal(p)) throw new Error(p.message);
    const { nonce: _n, ...rest } = p.action as Extract<OwnerAction, { type: "liveOrder" }>;
    const r = refusal(await x.own(rest as NoNonce<OwnerAction>));
    expect(r.code).toBe("E_VENUE_GEOBLOCKED");
    expect(r.message).toContain("Hyperliquid does not serve this location (US-PA");
    expect(r.message).toContain("does not look for a way around it");
    expect(refusal(await x.own({ type: "liveClose", venue: "mmw", symbol: "BTC-PERP", qty: "" })).code).toBe("E_VENUE_GEOBLOCKED");
    expect(refusal(await x.own({ type: "liveLeverage", venue: "mmw", symbol: "BTC-PERP", leverage: "2", marginMode: "" })).code).toBe("E_VENUE_GEOBLOCKED");
    // an agent inside its trading limit, Beast: the same line, and its limit is not used
    await x.letIn({ scope: "trade", allow: "mmw", per: "100", budget: "100" });
    await x.own({ type: "setPolicy", change: "mode", value: "open" });
    expect(refusal(await x.ag({ type: "agentLiveOrder", venue: "mmw", symbol: "BTC-PERP", side: "buy", orderType: "market", qty: "0.001", usd: "", limitPrice: "" })).code).toBe("E_VENUE_GEOBLOCKED");
    expect(x.engine.state.spends.find((s) => s.scope === "trade" && s.revokedAt === undefined)!.spentMicro).toBe(0);
    expect(mm.calls.some((a) => a[0] === "perps" && ["open", "close", "modify"].includes(a[1] ?? ""))).toBe(false);
    // where Hyperliquid serves, the same order goes
    mm.answers["predict geoblock"] = { command: "geoblock", result: { blocked: false, ip: "203.0.113.9", country: "IE", region: "L" } };
    const ok = await x.own({ ...(rest as NoNonce<OwnerAction>), deadline: 5_600_000 } as NoNonce<OwnerAction>);
    expect(isRefusal(ok) ? ok.code : ok.kind).toBe("order");
    expect(mm.calls.filter((a) => a[0] === "perps" && a[1] === "open")).toHaveLength(1);
  });
});

// ---- Kraken Earn, through its own adapter over a stand-in exchange client ----------------------------------------------------------

const STRATEGY = "ESUSDC0-FLEXI-KRAKEN";
interface KrakenStub {
  allocated: Array<Record<string, unknown>>;
  /** what AllocateStatus answers next, in turn: an answer, or an error the exchange library would throw */
  status: Array<unknown>;
}
const kraken: KrakenStub = { allocated: [], status: [] };
const krakenClient = {
  id: "kraken",
  async privatePostEarnStrategies() {
    return { error: [], result: { items: [{ id: STRATEGY, asset: "USDC", lock_type: { type: "instant" }, apr_estimate: { low: "4.0000", high: "4.0000" }, user_min_allocation: "1", can_allocate: true, can_deallocate: true, allocation_restriction_info: [] }] } };
  },
  async privatePostEarnAllocate(body: Record<string, unknown>) {
    kraken.allocated.push(body);
    return { error: [], result: true };
  },
  async privatePostEarnAllocateStatus() {
    const next = kraken.status.shift() ?? { error: [], result: { pending: true } };
    if (next instanceof Error) throw next;
    return next;
  },
  async privatePostEarnAllocations() {
    return { error: [], result: { items: [] } };
  },
};
register({ kind: "standin-kraken-attack", label: "Kraken Earn over a stand-in client", needs: "key-file", example: "", venues: [], async open(req) {
  const earner = krakenEarner({ client: krakenClient as never, venue: req.venue, name: "Kraken", key: { apiKey: "k", secret: "s" } as never, can: [] });
  return { source: { name: "Kraken", kind: "cex", reference: "standin", via: "a stand-in", probe: { can: ["read", "trade"], note: "" }, read: async () => [{ asset: "USDC", amount: 500, usd: 500 }], earner } as never, first: [{ asset: "USDC", amount: 500, usd: 500 }], summary: "connected" };
} });

describe("ATTACK: a Kraken status call that fails for its own reasons", () => {
  it("a nonce or a key refused while asking how an allocation stands leaves it under way and its budget held; only Earn's own words reject it", async () => {
    const x = await boot();
    kraken.allocated = [];
    kraken.status = [new ccxt.InvalidNonce('kraken {"error":["EAPI:Invalid nonce"]}'), new ccxt.AuthenticationError('kraken {"error":["EAPI:Invalid key"]}'), { error: [], result: { pending: false } }];
    const c = await x.own({ type: "connectVenue", venue: "kr", connector: "live:standin-kraken-attack", label: "Kraken", credentialRef: "" });
    if (isRefusal(c)) throw new Error(c.message);
    await x.letIn({ allow: "kr", per: "50", budget: "100" });
    await x.own({ type: "setPolicy", change: "mode", value: "open" });
    const e = sent(await x.ag(ask({ venue: "kr", product: STRATEGY, asset: "USDC", amount: "25" })));
    expect([e.status, kraken.allocated.length, x.earnLimit().spentMicro]).toEqual(["pending", 1, 25_000_000]);
    const now = () => x.engine.earns.find((y) => y.id === e.id)!;
    // the nonce, then the key: neither is the allocation failing — it is asked again, and the agent's budget stays spent
    for (const _ of [1, 2]) {
      x.tick(20_000);
      await x.engine.settle();
      expect([now().status, x.earnLimit().spentMicro]).toEqual(["pending", 25_000_000]);
    }
    x.tick(20_000);
    await x.engine.settle();
    expect([now().status, x.earnLimit().spentMicro]).toEqual(["done", 25_000_000]);
    // Earn's own words about the request do reject it, and give its share of the budget back
    kraken.status = [new ccxt.InsufficientFunds('kraken {"error":["EEarnings:Insufficient funds:Insufficient funds to complete the (de)allocation request"]}')];
    const f = sent(await x.ag(ask({ venue: "kr", product: STRATEGY, asset: "USDC", amount: "10" })));
    expect(x.earnLimit().spentMicro).toBe(35_000_000);
    x.tick(20_000);
    await x.engine.settle();
    expect([x.engine.earns.find((y) => y.id === f.id)!.status, x.earnLimit().spentMicro]).toEqual(["rejected", 25_000_000]);
  });
});

describe("ATTACK: an agent naming a thin vault by its id", () => {
  it("the vaults shown hold $1M or more, and so does any vault the door puts money into: one named by its id that holds less is refused", async () => {
    const x = await boot({ mmEnv: { PORTFOLIO_MM_WRITES: "1" } });
    const THIN = "0x1111111111111111111111111111111111111111";
    const vaults = [
      { address: VAULT, chainId: 8453, name: "Steakhouse USDC", protocol: { name: "morpho" }, underlyingTokens: [{ address: USDC_BASE, symbol: "USDC", decimals: 6 }], apy: { total: 0.0534 }, tvlUsd: 12_500_000, isTransactional: true, isRedeemable: true },
      { address: THIN, chainId: 8453, name: "Fresh USDC 90%", protocol: { name: "morpho" }, underlyingTokens: [{ address: USDC_BASE, symbol: "USDC", decimals: 6 }], apy: { total: 0.9 }, tvlUsd: 4_000, isTransactional: true, isRedeemable: true },
    ];
    mm.answers["earn markets"] = (args: string[]) => {
      const i = args.indexOf("--min-tvl");
      return vaults.filter((v) => i < 0 || v.tvlUsd >= Number(args[i + 1]));
    };
    await x.letIn({ allow: "mmw", per: "50", budget: "100" });
    await x.own({ type: "setPolicy", change: "mode", value: "open" });
    const r = refusal(await x.ag(ask({ venue: "mmw", product: `8453:${THIN}`, asset: "USDC", amount: "5" })));
    expect(r.code).toBe("E_VENUE_MARKET_CLOSED");
    expect(r.message).toContain("this vault holds $4,000: the account puts money only into vaults holding $1,000,000 or more");
    // the owner's own page is held to it too
    expect(refusal(await x.engine.prepare({ type: "liveEarn", venue: "mmw", kind: "supply", product: `8453:${THIN}`, asset: "USDC", amount: "5" })).code).toBe("E_VENUE_MARKET_CLOSED");
    expect(mm.calls.some((a) => a[0] === "earn" && a[1] === "supply")).toBe(false);
    expect(x.earnLimit().spentMicro).toBe(0);
    // a vault the owner was shown still goes
    sent(await x.ag(ask({ venue: "mmw", product: `8453:${VAULT}`, asset: "USDC", amount: "5" })));
    expect(mm.calls.filter((a) => a[0] === "earn" && a[1] === "supply")).toHaveLength(1);
  });
});

describe("ATTACK: an earn limit over every account", () => {
  it("is refused when it is prepared — before the owner is shown it or signs anything — and at the door", async () => {
    const x = await boot();
    await x.own({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: START + 30 * DAY });
    const draft = { type: "approveSpend", agent: cc.address, scope: "earn", allow: "*", perPayment: "5", budget: "10", windowHours: 0, validUntil: START + 7 * DAY } as const;
    const p = refusal(await x.engine.prepare({ ...draft }));
    expect([p.code, p.message]).toEqual(["E_ACCOUNT_BAD_ACTION", 'an earn limit names venues ("okx") or one product at a venue ("okx:savings:USDT"), not every account']);
    expect(refusal(await x.own({ ...draft, allow: "ex,*" })).code).toBe("E_ACCOUNT_BAD_ACTION");
    expect(x.engine.state.spends.some((s) => s.scope === "earn")).toBe(false);
  });
});
