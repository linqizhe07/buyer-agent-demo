/** Attacks on how money in earn products is counted beside a venue's balance:
 *
 *   share look-alike  a vault whose share symbol its chain gave is matched by that symbol alone: when the wallet's balance does not list the
 *                     shares, another protocol's token of the same worth (Aave's aBasUSDC beside a Morpho vault) is someone else's money,
 *                     and it stays counted — the venue's total, the live total and the net worth do not lose it
 *   late earn         an earn read that is late (over three seconds) or fails, beside a NEW balance read, never pairs that new balance with
 *                     the positions read before it: money that just moved between the two (a withdrawal out of a product) is not counted
 *                     twice, nor (a supply into one) not at all. The venue shows its last pair, read together, and is marked stale, so a
 *                     net worth point taken then is `partial`; past two minutes the newer balance stands, still marked
 *
 * Every venue, the network and the chain are stand-ins; nothing leaves the process. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isRefusal, type Refusal } from "../../src/core/errors.ts";
import { no } from "../../src/portfolio/refuse.ts";
import { withEarn, type EarnHeld } from "../../src/portfolio/account/holdings.ts";
import { signOwner, simKey, type OwnerAction } from "../../src/portfolio/account/sign.ts";
import type { EarnPosition, LiveEarner } from "../../src/portfolio/live/earn.ts";
import { register, type LiveDeps } from "../../src/portfolio/live/index.ts";
import type { LiveTrader } from "../../src/portfolio/live/trade.ts";
import type { Http, LiveBalance } from "../../src/portfolio/live/types.ts";
import { PortfolioService } from "../../src/portfolio/service.ts";

type NoNonce<T> = T extends unknown ? Omit<T, "nonce"> : never;
const START = Date.parse("2026-10-06T10:00:00.000Z");
const owner = simKey("owner");
const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));

/** what each stand-in venue holds, and what its earn says: an answer, a refusal, or a read that waits until the test lets it go */
const world: Record<string, { balances: LiveBalance[]; earn: EarnPosition[] | Refusal | Promise<EarnPosition[]> }> = {};
const earnerOf = (venue: string): LiveEarner => ({
  can: true,
  what: "earn",
  products: async () => [],
  product: async () => no("E_VENUE_REJECTED", { venue, message: "none" }),
  positions: async () => world[venue]!.earn,
  supply: async () => no("E_VENUE_REJECTED", { venue, message: "not here" }),
  withdraw: async () => no("E_VENUE_REJECTED", { venue, message: "not here" }),
});
const trader: LiveTrader = { can: false, what: "nothing", markets: async () => [], market: async () => no("E_VENUE_REJECTED", { message: "none" }), place: async () => no("E_VENUE_REJECTED", { message: "none" }), cancel: async () => no("E_VENUE_REJECTED", { message: "none" }), status: async () => no("E_VENUE_REJECTED", { message: "none" }) } as unknown as LiveTrader;
register({ kind: "pair-earn", label: "a venue that earns", needs: "key-file", example: "", venues: [], async open(req) {
  world[req.venue] ??= { balances: [], earn: [] };
  const read = async () => world[req.venue]!.balances;
  return { source: { name: req.label || req.venue, kind: "cex", reference: "standin", via: "a stand-in", probe: { can: ["read"], note: "" }, read, trader, readOnlyBecause: "the stand-in moves no money", earner: earnerOf(req.venue) }, first: await read(), summary: "connected" };
} });
const nowhere: Http = async () => ({ status: 404, body: { error: "not here" }, text: "not here" });

/** one run of the real account; its clock can be moved, and one venue that earns is connected with what the test gives it */
async function venueWith(balances: LiveBalance[], earn: EarnPosition[]) {
  const home = mkdtempSync(join(tmpdir(), "earn-pair-"));
  homes.push(home);
  let t = START;
  let n = 0;
  // the chain names a vault's share token "steakUSDC"; nothing is priced from outside
  const liveDeps: Partial<LiveDeps> = { clock: () => t, http: nowhere, price: async () => undefined, chain: { symbol: async () => "steakUSDC" } as never };
  const svc = await PortfolioService.create({ home, now: () => new Date(t).toISOString(), venues: "frontline", real: true, liveDeps, liveWrites: { capUsd: 1000, pairingCode: "K7QX-M2PA" }, publicMarkets: [], account: { owners: [{ id: owner.address, kind: "eoa" as const, label: "owner", addedAt: new Date(START).toISOString() }] } });
  await svc.restoring;
  const own = async (a: NoNonce<OwnerAction>) => svc.exchange(await signOwner(owner, { ...a, nonce: t + ++n } as OwnerAction));
  const venue = `p${Math.random().toString(36).slice(2, 8)}`;
  world[venue] = { balances, earn };
  const ok = await own({ type: "connectVenue", venue, connector: "live:pair-earn", label: "Earner", credentialRef: "" });
  if (isRefusal(ok)) throw new Error(ok.message);
  const read = async () => {
    const page = (await svc.accountView())!;
    return { page, v: page.venues.find((x) => x.id === venue)! };
  };
  return { svc, venue, read, pass: (ms: number) => void (t += ms) };
}

type Line = { asset: string; amount: number; usd: number; class: "crypto" | "stable"; note: string; inTransit: boolean };
const line = (asset: string, usd: number, note: string, cls: Line["class"] = "crypto"): Line => ({ asset, amount: usd, usd, class: cls, note, inTransit: false });
const sum = (rows: Array<{ usd: number }>) => Number(rows.reduce((s, h) => s + h.usd, 0).toFixed(2));
const VAULT = "8453:0x1111111111111111111111111111111111111111";

describe("a vault's shares are matched by the symbol its chain gave, and by nothing else", () => {
  const held: EarnHeld[] = [{ product: VAULT, asset: "USDC", amount: 500, usd: 500, chain: "Base", name: "Steakhouse USDC" }];
  const shares = new Map([[VAULT, "steakUSDC"]]);

  it("the shares not in the balance: another protocol's token of the same worth is not taken for them", () => {
    const v = { name: "MetaMask Agent Wallet", holdings: [line("aBasUSDC", 500, "Base"), line("ETH", 400, "Base")] };
    const r = withEarn(v, held, { shares });
    expect(r.dropped).toEqual([]);
    expect(sum(r.holdings)).toBe(1_400);
    // the shares in the balance under that symbol: they, and only they, are the position
    const listed = withEarn({ ...v, holdings: [...v.holdings, line("steakUSDC", 500, "Base")] }, held, { shares });
    expect(listed.dropped.map((h) => h.asset)).toEqual(["steakUSDC"]);
    expect(sum(listed.holdings)).toBe(1_400);
    // where the chain gave no symbol, a line on the vault's chain that carries its asset and is worth what the position is stands in for it
    expect(withEarn(v, held, {}).dropped.map((h) => h.asset)).toEqual(["aBasUSDC"]);
  });

  it("on the account: the venue's total, the live total and the account's total keep the other protocol's $500", async () => {
    const { read } = await venueWith([{ asset: "aBasUSDC", amount: 500, usd: 500, where: "Base" }, { asset: "ETH", amount: 0.1, usd: 400, where: "Base" }], [{ product: VAULT, id: "x", asset: "USDC", amount: 500, usd: 500, chain: "Base" }]);
    const { page, v } = await read();
    expect(v.holdings.map((h) => h.asset).sort()).toEqual(["ETH", "USDC", "aBasUSDC"]);
    expect([v.usd, page.liveUsd, page.totalUsd]).toEqual([1_400, 1_400, 1_400]);
  });
});

describe("a late or failed earn read never pairs a new balance with the old positions", () => {
  it("a withdrawal out of a product, then the earn fails: not counted twice — the last pair shows, marked, and the curve's point is partial", async () => {
    const { svc, venue, read, pass } = await venueWith([{ asset: "USDT", amount: 300, usd: 300 }], [{ product: "savings:USDT", id: "x", asset: "USDT", amount: 1_000, usd: 1_000 }]);
    const first = await read();
    expect([first.v.usd, first.v.stale]).toEqual([1_300, undefined]);
    // $1,000 came out of the product into the balance; the balance is read again after thirty seconds, and the earn does not answer
    world[venue] = { balances: [{ asset: "USDT", amount: 1_300, usd: 1_300 }], earn: no("E_VENUE_REJECTED", { venue, message: "earn is down for maintenance" }) };
    pass(31_000);
    const { page, v } = await read();
    expect(v.usd).toBe(1_300);
    expect(page.totalUsd).toBe(1_300);
    expect(v.holdings.map((h) => [h.asset, h.usd, h.class])).toEqual([["USDT", 300, "stable"], ["USDT", 1_000, "earn"]]);
    expect(v.stale).toMatch(/its earn did not answer in time, so its balance and its earn are both as read together at 10:00:00 UTC/);
    expect(v.asOf).toBe(new Date(START).toISOString());
    expect(await svc.snapshot()).toMatchObject({ written: true });
    const curve = svc.history("1d");
    if (isRefusal(curve)) throw new Error(curve.message);
    expect(curve.points.at(-1)).toMatchObject({ usd: 1_300, partial: true });
    // the earn answers again: the new pair, and nothing marked
    world[venue]!.earn = [];
    const back = await read();
    expect([back.v.usd, back.v.stale, back.v.holdings.map((h) => h.class)]).toEqual([1_300, undefined, ["stable"]]);
  });

  it("a supply into a product, then an earn read over three seconds: not counted as gone — and once it answers, the new pair", async () => {
    const { venue, read, pass } = await venueWith([{ asset: "USDT", amount: 1_300, usd: 1_300 }], []);
    expect((await read()).v.usd).toBe(1_300);
    // the earn answered once with nothing in it; now $1,000 has gone in, and the earn read for the new balance is slow
    let answer!: (p: EarnPosition[]) => void;
    world[venue] = { balances: [{ asset: "USDT", amount: 300, usd: 300 }], earn: new Promise<EarnPosition[]>((resolve) => (answer = resolve)) };
    pass(31_000);
    const { v } = await read();
    // the pair of thirty seconds ago — $1,300 in the balance, nothing in earn — not $300 beside an empty earn; marked, as not now's
    expect([v.usd, v.holdings.map((h) => [h.asset, h.usd])]).toEqual([1_300, [["USDT", 1_300]]]);
    expect(v.stale).toMatch(/its earn did not answer in time/);
    answer([{ product: "savings:USDT", id: "x", asset: "USDT", amount: 1_000, usd: 1_000 }]);
    await new Promise((r) => setTimeout(r, 0));
    const after = await read();
    expect([after.v.usd, after.v.stale, after.v.holdings.map((h) => [h.asset, h.usd, h.class])]).toEqual([1_300, undefined, [["USDT", 300, "stable"], ["USDT", 1_000, "earn"]]]);
  }, 15_000);

  it("past two minutes without an answer the newer balance stands, beside the earn as last read — and the venue stays marked", async () => {
    const { venue, read, pass } = await venueWith([{ asset: "USDT", amount: 300, usd: 300 }], [{ product: "savings:USDT", id: "x", asset: "USDT", amount: 1_000, usd: 1_000 }]);
    await read();
    world[venue] = { balances: [{ asset: "USDT", amount: 450, usd: 450 }], earn: no("E_VENUE_REJECTED", { venue, message: "earn is down for maintenance" }) };
    pass(121_000);
    const { page, v } = await read();
    expect(v.holdings.map((h) => [h.asset, h.usd])).toEqual([["USDT", 450], ["USDT", 1_000]]);
    expect(v.asOf).toBe(new Date(START + 121_000).toISOString());
    expect(v.stale).toMatch(/what is in its earn products is the last read, beside a newer balance/);
    expect(page.venues.filter((x) => x.stale).map((x) => x.id)).toEqual([venue]);
  });
});
