/** Shared by the attacks of the 2026-10-05 review of restore, real payments and the order door: one real account per run on a home, and a
 * stand-in venue that outlives the runs. Nothing here touches the network. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { isRefusal, type Refusal } from "../../src/core/errors.ts";
import { no } from "../../src/portfolio/refuse.ts";
import type { Outcome } from "../../src/portfolio/account/exchange.ts";
import { signAgent, signDevice, signOwner, simKey, type AgentAction, type Envelope, type OwnerAction, type SimKey } from "../../src/portfolio/account/sign.ts";
import { register, type LiveDeps } from "../../src/portfolio/live/index.ts";
import type { LiveTrader, Market, OrderChange, OrderRequest, OrderState, Position } from "../../src/portfolio/live/trade.ts";
import { PortfolioService, type ServiceOptions } from "../../src/portfolio/service.ts";

export type NoNonce<T> = T extends unknown ? Omit<T, "nonce"> : never;
export const START = Date.parse("2026-10-05T14:00:00.000Z");
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const CODE = "K7QX-M2PA";

export const BTC: Market = { symbol: "BTC/USDT", name: "BTC/USDT", kind: "spot", base: "BTC", quote: "USDT", price: 60_000, bid: 59_990, ask: 60_010, minQty: 0.0001, qtyStep: 0.0001, priceStep: 0.1, open: true, types: ["market", "limit", "stop", "stop_limit"], tifs: ["gtc", "ioc"], sellsReduce: true };
export const PERP: Market = { symbol: "BTC/USDT:USDT", name: "BTC perpetual", kind: "perp", base: "BTC", quote: "USDT", price: 60_000, bid: 59_990, ask: 60_010, minQty: 0.0001, qtyStep: 0.0001, priceStep: 0.1, open: true, types: ["market", "limit", "stop", "stop_limit"], tifs: ["gtc", "ioc"], reduceOnly: true, maxLeverage: 50 };

/** one venue that outlives the runs */
export const venue = { placed: [] as OrderRequest[], amended: [] as Array<{ ref: string; change: OrderChange }>, states: new Map<string, OrderState>(), positions: [] as Position[] };
const trader: LiveTrader = {
  can: true,
  what: "spot and perpetuals",
  async markets() {
    return [BTC, PERP];
  },
  async market(symbol) {
    const m = [BTC, PERP].find((x) => x.symbol === symbol);
    return m ? { ...m } : no("E_VENUE_REJECTED", { venue: "ex", message: `no market ${symbol}` });
  },
  async place(o) {
    venue.placed.push(o);
    const ref = `r-${venue.placed.length}`;
    const s: OrderState = o.type === "market" ? { ref, status: "filled", filledQty: o.qty, avgPrice: o.side === "buy" ? 60_010 : 59_990, native: {} } : { ref, status: "open", filledQty: 0, native: {} };
    venue.states.set(ref, s);
    return s;
  },
  async cancel(ref) {
    const s = { ...venue.states.get(ref)!, status: "canceled" as const };
    venue.states.set(ref, s);
    return s;
  },
  async status(ref) {
    return venue.states.get(ref)!;
  },
  async amend(ref, _symbol, change) {
    venue.amended.push({ ref, change });
    return { ...venue.states.get(ref)! };
  },
  async positions() {
    return venue.positions;
  },
};
register({ kind: "standin-attack", label: "a venue that trades", needs: "key-file", example: "", venues: [], async open(req) {
  return { source: { name: req.label || "Stand-in", kind: "cex", reference: "standin", via: "a stand-in", probe: { can: ["read", "trade"], note: "" }, read: async () => [{ asset: "USDT", amount: 500, usd: 500 }], trader, readOnlyBecause: "the stand-in moves no money" }, first: [{ asset: "USDT", amount: 500, usd: 500 }], summary: "connected" };
} });

export const owner = simKey("owner");
export const browser = simKey("device:owner-browser");
export const laptop = simKey("device:owner-laptop");
export const cc = simKey("agent:claude-code");

const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));
export const fresh = (): string => {
  const h = mkdtempSync(join(tmpdir(), "attack-runs-"));
  homes.push(h);
  return h;
};

export interface RunOpts {
  /** the owner is an address given at start, rather than a device paired on the page */
  seedOwner?: boolean;
  /** --read-only: nothing moves, and no trading code */
  readOnly?: boolean;
  /** the code a read-only run asks for too (the server prints one either way) */
  readOnlyCode?: boolean;
  cap?: number;
  extra?: Partial<ServiceOptions>;
}

/** one run of the real account on `home`, `at` ms after the start (each run writes a ledger of its own) */
export async function run(home: string, at: number, o: RunOpts = {}) {
  let real = 5_000_000 + at;
  let n = 0;
  const liveDeps: Partial<LiveDeps> = { clock: () => real, http: async () => ({ status: 599, body: undefined, text: "" }), price: async () => undefined, ...(o.extra?.liveDeps ?? {}) };
  const svc = await PortfolioService.create({
    home,
    now: () => new Date(START + at).toISOString(),
    venues: "frontline",
    real: true,
    ...(o.readOnly ? (o.readOnlyCode ? { pairingCode: CODE } : {}) : { liveWrites: { capUsd: o.cap ?? 100, pairingCode: CODE } }),
    ...(o.seedOwner ? { account: { owners: [{ id: owner.address, kind: "eoa" as const, label: "owner", addedAt: new Date(START).toISOString() }] } } : {}),
    ...(o.extra ?? {}),
    liveDeps,
  });
  await svc.restoring;
  const engine = svc.account!;
  const nonce = () => START + at + ++n;
  /** the owner signs: the seeded address, or a device key (the browser unless another is named), with other devices co-signing */
  const own = async (a: NoNonce<OwnerAction>, by: SimKey = browser, co: SimKey[] = []) => {
    const action = { ...a, nonce: nonce() } as OwnerAction;
    const envelope: Envelope = o.seedOwner ? await signOwner(owner, action) : { action, nonce: action.nonce, signature: signDevice(by, action), ...(co.length ? { cosignatures: co.map((k) => signDevice(k, action)) } : {}) };
    return svc.exchange(envelope);
  };
  const ag = async (a: NoNonce<AgentAction>, key = cc) => svc.exchange(await signAgent(key, { ...a, nonce: nonce() } as AgentAction));
  const trade = () => engine.state.spends.find((s) => s.scope === "trade" && s.revokedAt === undefined);
  return { svc, engine, own, ag, trade, now: () => START + at, tick: (ms: number) => (real += ms) };
}

export const ok = <T extends Outcome | Refusal>(o: T): Exclude<T, Refusal> => {
  if (isRefusal(o)) throw new Error(`${o.code}: ${o.message}`);
  return o as Exclude<T, Refusal>;
};
export const codeOf = (o: Outcome | Refusal): string => (isRefusal(o) ? o.code : o.kind);
