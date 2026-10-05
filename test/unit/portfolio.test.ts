import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isRefusal } from "../../src/core/errors.ts";
import { type Account, type Intent } from "../../src/portfolio/accounts.ts";
import { binanceAccount } from "../../src/portfolio/adapters/binance.ts";
import { kalshiAccount } from "../../src/portfolio/adapters/kalshi.ts";
import { metamaskSimAccount } from "../../src/portfolio/adapters/metamask.ts";
import { geoblockOf, liveScope, polymarketSimAccount } from "../../src/portfolio/adapters/polymarket.ts";
import { eventMark, eventState, EVENTS, findEvent, isEventSymbol, levelsFor, parseEventSymbol, rawEvent } from "../../src/portfolio/events.ts";
import { okxAccount } from "../../src/portfolio/adapters/okx.ts";
import { ondoAccount } from "../../src/portfolio/adapters/ondo.ts";
import { compileOpenness, effectiveReach, evaluate, parseOpenness } from "../../src/portfolio/openness.ts";
import { aggregate, liquidity } from "../../src/portfolio/portfolio.ts";
import { bridgeQuotes, etaLabel, ladder, pick, routesToHub } from "../../src/portfolio/rails.ts";
import { orderPlan } from "../../src/portfolio/router.ts";
import { parseOrder, quoteView } from "../../src/portfolio/server.ts";
import { bestVenue, EXTRA_LEG_MIN_GAIN_USD, fillAt, splitOrder, venueQuotes } from "../../src/portfolio/venues.ts";
import { isPending, loadOpenness, loadSeeds, PortfolioService } from "../../src/portfolio/service.ts";

const now = "2026-10-03T09:00:00.000Z";
const clock = () => now;
const seeds = loadSeeds();
const openness = parseOpenness(loadOpenness());
const binance = () => binanceAccount(seeds.binance);
const COLD = "0x9C0d4E3b7a2f1c8d9e0f1a2b3c4d5e6f7a8b9c0d";

describe("adapters apply only the credential's native scope (layer 1 / layer 3)", () => {
  it("Binance: SPOT trades fill, a withdrawal is -2015 because the key has no WITHDRAW", async () => {
    const b = binance();
    expect(b.account.scope.can).toEqual(["read", "trade"]);
    const t = await b.execute({ kind: "trade", symbol: "BTCUSDT", side: "sell", qty: 0.05 });
    expect(t).toMatchObject({ ok: true, status: "filled", usd: 3107.34, native: { price: 62146.8, feeUsd: 3.11, netUsd: 3104.23 } });
    const w = await b.execute({ kind: "move", asset: "BTC", amount: 0.1, to: "wallet-main" });
    expect(w).toMatchObject({ ok: false, code: "E_VENUE_PERMISSION", layer: "VENUE", native: { code: -2015 } });
    const bal = await b.read();
    expect(bal.find((h) => h.asset === "BTC")?.amount).toBeCloseTo(0.25, 8);
  });
  it("Binance with WITHDRAW still only pays out to the whitelist (-4026)", async () => {
    const b = binanceAccount({ ...seeds.binance, permissions: ["SPOT", "WITHDRAW"] });
    expect(b.account.scope.can).toContain("move");
    expect(await b.execute({ kind: "move", asset: "BTC", amount: 0.1, to: COLD })).toMatchObject({ code: "E_VENUE_WITHDRAW_WHITELIST", native: { code: -4026 } });
    expect(await b.execute({ kind: "move", asset: "BTC", amount: 0.1, to: "wallet-main" })).toMatchObject({ ok: true, status: "sent" });
  });
  it("OKX: trade fills, withdraw is refused by the exchange, no `pay`", async () => {
    const o = okxAccount(seeds.okx);
    expect(await o.execute({ kind: "trade", symbol: "ETH-USDT", side: "buy", qty: 0.5 })).toMatchObject({ ok: true, status: "filled" });
    expect(await o.execute({ kind: "move", asset: "ETH", amount: 0.1, to: "wallet-main" })).toMatchObject({ code: "E_VENUE_PERMISSION", native: { code: "50114" } });
    expect(await o.execute({ kind: "pay", merchant: "x", mcc: "7372", amountUsd: 1 })).toMatchObject({ code: "E_VENUE_REJECTED" });
  });
  it("Ondo: subscribe mints at NAV, redeem is T+1 pending, OUSG only moves to the allowlist", async () => {
    const o = ondoAccount(seeds.ondo, clock);
    expect(await o.execute({ kind: "subscribe", fund: "OUSG", amountUsd: 1500 })).toMatchObject({ ok: true, status: "minted" });
    expect(await o.execute({ kind: "redeem", fund: "OUSG", amountUsd: 500 })).toMatchObject({ ok: true, status: "pending" });
    expect(await o.execute({ kind: "move", asset: "OUSG", amount: 1, to: COLD })).toMatchObject({ code: "E_VENUE_TRANSFER_RESTRICTED" });
    expect(await o.execute({ kind: "move", asset: "OUSG", amount: 1, to: "wallet-main" })).toMatchObject({ ok: true, status: "sent" });
    expect((await o.read()).some((h) => h.note?.includes("T+1"))).toBe(true);
  });
  it("MetaMask (sim): Guard's own rule lives inside the adapter — over the 24 h line or off the allowlist comes back AWAITING_MFA", async () => {
    const m = metamaskSimAccount(seeds.metamask, clock);
    expect(await m.execute({ kind: "move", asset: "USDC", amount: 100, to: "wallet-main" })).toMatchObject({ ok: true, status: "sent" });
    expect(await m.execute({ kind: "move", asset: "USDC", amount: 1000, to: "wallet-main" })).toMatchObject({ ok: true, status: "sent" });
    expect(await m.execute({ kind: "move", asset: "USDC", amount: 500, to: "wallet-main" })).toMatchObject({ ok: true, status: "pending", native: { status: "AWAITING_MFA" } });
    expect(await m.execute({ kind: "move", asset: "USDC", amount: 10, to: COLD })).toMatchObject({ status: "pending", native: { reason: "recipient not in allowlist" } });
  });
  it("MetaMask (sim): a move whose chain differs from the holding's is a bridge, and money credited by a rail shows up on the destination chain", async () => {
    const m = metamaskSimAccount(seeds.metamask, clock);
    const r = await m.execute({ kind: "move", asset: "USDC", amount: 200, to: "0x5a1e…kyc", fromChainId: 8453, chainId: 1 });
    expect(r).toMatchObject({ ok: true, status: "sent", native: { bridge: true, from: "Base", to: "Ethereum" } });
    expect((await m.read()).find((h) => h.asset === "USDC")?.amount).toBe(1000);
    m.credit!("USDC", 50, "Ethereum");
    expect((await m.read()).filter((h) => h.asset === "USDC").map((h) => h.note)).toEqual(["Base", "Ethereum"]);
  });
});

describe("openness.evaluate (layer 2)", () => {
  const acct = (a: Account) => a;
  const bin = acct(binance().account);
  const ondo = acct(ondoAccount(seeds.ondo, clock).account);
  const base = { openness, now, dailyOutUsd: 0 };
  const trade: Intent = { kind: "trade", symbol: "BTCUSDT", side: "sell", qty: 0.05 };
  it("open: in-scope writes pass with no card; a move to a stranger is a card; the blocklist refuses", () => {
    expect(evaluate({ ...base, intent: trade, account: bin })).toMatchObject({ ok: true, card: null, usd: 3107.5 });
    expect(evaluate({ ...base, intent: { kind: "move", asset: "USDC", amount: 300, to: COLD }, account: ondo })).toMatchObject({ ok: true, card: null });
    expect(evaluate({ ...base, intent: { kind: "move", asset: "USDC", amount: 300, to: "0x7a11…stranger" }, account: ondo })).toMatchObject({ ok: true, card: { reason: expect.stringContaining("never used before") } });
    expect(evaluate({ ...base, intent: { kind: "move", asset: "USDC", amount: 300, to: "0xd759…attacker" }, account: ondo })).toMatchObject({ code: "E_WALLET_BLOCKLIST" });
  });
  it("the credential's scope comes before the user's reach: E_WALLET_SCOPE, then E_WALLET_REACH, then revoked, then session", () => {
    expect(evaluate({ ...base, intent: { kind: "move", asset: "BTC", amount: 0.1, to: COLD }, account: bin })).toMatchObject({ code: "E_WALLET_SCOPE", detail: { enforcedBy: "venue" } });
    expect(evaluate({ ...base, intent: { kind: "pay", merchant: "x", mcc: "6513", amountUsd: 1 }, account: ondo })).toMatchObject({ code: "E_WALLET_SCOPE" });
    expect(evaluate({ ...base, intent: { kind: "move", asset: "USDC", amount: 1, to: COLD }, account: ondo, openness: { ...openness, reach: { ondo: ["subscribe", "redeem"] } } })).toMatchObject({ code: "E_WALLET_REACH" });
    expect(evaluate({ ...base, intent: trade, account: bin, openness: { ...openness, revoked: ["binance"] } })).toMatchObject({ code: "E_WALLET_ACCOUNT_REVOKED" });
    expect(evaluate({ ...base, intent: trade, account: bin, openness: { ...openness, sessionExpiresAt: now } })).toMatchObject({ code: "E_WALLET_SESSION_EXPIRED" });
  });
  it("guard: a card above the free allowance, none below, a hard daily cap", () => {
    const guard = { ...openness, mode: "guard" as const };
    expect(evaluate({ ...base, openness: guard, intent: trade, account: bin })).toMatchObject({ ok: true, card: { reason: expect.stringContaining("no-ask allowance") } });
    expect(evaluate({ ...base, openness: guard, intent: { kind: "trade", symbol: "BTCUSDT", side: "sell", qty: 0.005 }, account: bin })).toMatchObject({ ok: true, card: null });
    expect(evaluate({ ...base, openness: guard, intent: trade, account: bin, dailyOutUsd: 38000 })).toMatchObject({ code: "E_WALLET_DAILY_CAP" });
  });
  it("guard: a slice of a split order is judged by the whole order — splitting cannot slip it under the allowance", () => {
    const guard = { ...openness, mode: "guard" as const };
    const slice: Intent = { kind: "trade", symbol: "ETHUSDT", side: "sell", qty: 0.15 };
    expect(evaluate({ ...base, openness: guard, intent: slice, account: bin })).toMatchObject({ ok: true, card: null, usd: 366 });
    expect(evaluate({ ...base, openness: guard, intent: slice, account: bin, orderUsd: 1464 })).toMatchObject({ ok: true, usd: 366, card: { reason: expect.stringContaining("slices are counted together") } });
    expect(evaluate({ ...base, intent: slice, account: bin, orderUsd: 1464 })).toMatchObject({ ok: true, card: null });
  });
  it("effectiveReach is scope ∩ reach, and only `read` once revoked", () => {
    expect(effectiveReach(bin, openness)).toEqual(["read", "trade"]);
    expect(effectiveReach(ondo, { ...openness, reach: { ondo: ["subscribe"] } })).toEqual(["read", "subscribe"]);
    expect(effectiveReach(ondo, { ...openness, revoked: ["ondo"] })).toEqual(["read"]);
  });
  it("compileOpenness gives every account its three layers", () => {
    const rows = compileOpenness([bin, ondo], openness);
    expect(rows.map((r) => r.layer1.enforcedBy)).toEqual(["venue", "issuer"]);
    expect(rows[0]!.layer2.walletKeeps[0]).toMatch(/no cards/);
    expect(rows[1]!.layer2.walletKeeps[0]).toMatch(/new address/);
    expect(rows[1]!.layer3).toMatch(/KYC allowlist/);
  });
});

describe("aggregate", () => {
  it("sums what the user owns, by class and by account", async () => {
    const adapters = [binance(), okxAccount(seeds.okx), ondoAccount(seeds.ondo, clock)];
    const holdings = (await Promise.all(adapters.map((a) => a.read()))).flat();
    const agg = aggregate(adapters.map((a) => a.account), holdings);
    const expected = 0.3 * 62150 + 2 * 2440 + 5000 + 1.5 * 2440 + 2500 + 18 * 110.42 + 3000;
    expect(agg.totalUsd).toBeCloseTo(expected, 2);
    expect(agg.byClass.map((c) => c.class)).toEqual(["stable", "crypto", "rwa"]);
    expect(agg.byAccount.find((a) => a.account === "ondo")?.usd).toBeCloseTo(18 * 110.42 + 3000, 2);
    expect(agg.byClass.reduce((s, c) => s + c.pct, 0)).toBeGreaterThanOrEqual(98);
  });
});

/** the four accounts of the original world, or all six with the two prediction markets */
async function worldWith(prediction: boolean) {
  const adapters = [binance(), okxAccount(seeds.okx), metamaskSimAccount(seeds.metamask, clock), ...(prediction ? [kalshiAccount(seeds.kalshi, clock), polymarketSimAccount(seeds.polymarket, clock)] : []), ondoAccount(seeds.ondo, clock)];
  const accounts = await Promise.all(adapters.map(async (a) => ({ id: a.account.id, name: a.account.name, kind: a.account.kind, chain: a.account.chain, reach: a.account.scope.can, revoked: false, holdings: await a.read(), closed: a.account.closed })));
  return { accounts, liquidity: liquidity(accounts), ladder: ladder(accounts) };
}
const world = () => worldWith(false);
const ctxOf = async () => ({ cryptoPct: 51, ondoAddress: "0x5a1e…kyc", ...(await world()) });

describe("liquidity: amount × time × cost", () => {
  it("tells mobile liquidity from stuck, with the reason", async () => {
    const { accounts, liquidity: L } = await world();
    expect(L.mobileUsd).toBe(4200);
    expect(L.mobile.map((s) => `${s.account}:${s.chain}`)).toEqual(["metamask:Base", "ondo:Ethereum"]);
    expect(L.stuckUsd).toBe(7500);
    expect(Object.fromEntries(L.stuck.map((s) => [s.account, s.why]))).toEqual({ binance: "key cannot withdraw", okx: "key cannot withdraw" });
    const off = liquidity(accounts.map((v) => (v.id === "metamask" ? { ...v, revoked: true, reach: ["read" as const] } : v)));
    expect(off.stuck.find((s) => s.account === "metamask")?.why).toBe("switched off");
  });
  it("quotes three bridges: the cheapest open one depends on size, and the fastest is a different answer", () => {
    expect(bridgeQuotes(1200).map((q) => [q.id, q.feeUsd, q.etaSec])).toEqual([["lp", 1, 120], ["cctp", 1.2, 900], ["canonical", 2.5, 604800]]);
    expect(pick(bridgeQuotes(1200))?.id).toBe("lp");
    expect(pick(bridgeQuotes(50000))?.id).toBe("cctp");
    expect(pick(bridgeQuotes(50000), "speed")?.id).toBe("lp");
    expect(pick(bridgeQuotes(1200).map((q) => ({ ...q, open: false })))).toBeUndefined();
    expect([etaLabel(0), etaLabel(120), etaLabel(86400), etaLabel(604800)]).toEqual(["instant", "~2 min", "T+1", "7 days"]);
  });
  it("builds the ladder to the hub — now, minutes, T+1, closed — and a closed route keeps its quote", async () => {
    const { ladder: L } = await world();
    expect(L.rows.map((r) => [r.bucket, r.usd])).toEqual([["now", 3000], ["minutes", 1200], ["t1", 1987.56], ["closed", 7500]]);
    expect(L.rows[1]!.items[0]).toMatchObject({ account: "metamask", chain: "Base", open: true, route: { id: "lp", feeUsd: 1, etaSec: 120 } });
    expect(L.rows[2]!.items[0]).toMatchObject({ account: "ondo", asset: "OUSG", route: { id: "redeem", etaSec: 86400, feeUsd: 0 } });
    expect(Object.fromEntries(L.rows[3]!.items.map((it) => [it.account, [it.open, it.route.why, it.route.feeUsd, it.route.etaSec]]))).toEqual({ binance: [false, "key cannot withdraw", 9.5, 600], okx: [false, "key cannot withdraw", 7, 600] });
    expect([L.openUsd, L.closedUsd]).toEqual([6187.56, 7500]);
  });
  it("lists a CEX hop as a cross-chain route, closed until a key can withdraw", async () => {
    const { accounts } = await world();
    const mm = accounts.find((a) => a.id === "metamask")!;
    const usdc = mm.holdings.find((h) => h.asset === "USDC")!;
    expect(routesToHub(mm, usdc, accounts).map((q) => [q.id, q.open])).toEqual([["lp", true], ["cctp", true], ["canonical", true], ["cex:binance", false], ["cex:okx", false]]);
    const opened = accounts.map((a) => (a.id === "binance" ? { ...a, reach: [...a.reach, "move" as const] } : a));
    expect(routesToHub(mm, usdc, opened).find((q) => q.id === "cex:binance")).toMatchObject({ open: true, feeUsd: 4.5 });
  });
});

describe("execution liquidity: the same order at every venue", () => {
  it("quotes with spread, depth and fee, and the fill is the quote", async () => {
    expect(fillAt("binance", "ETH", "sell", 1)).toMatchObject({ price: 2439.88, grossUsd: 2439.88, feeUsd: 2.44, netUsd: 2437.44 });
    expect(fillAt("okx", "ETH", "sell", 1)).toMatchObject({ price: 2440.97, feeUsd: 1.95, netUsd: 2439.02 });
    const big = fillAt("okx", "ETH", "sell", 400)!;
    expect(big.impactBps).toBeGreaterThan(9);
    expect(big.price).toBeLessThan(2439);
    const o = okxAccount(seeds.okx);
    expect(await o.execute({ kind: "trade", symbol: "ETH-USDT", side: "sell", qty: 1 })).toMatchObject({ ok: true, native: { price: 2440.97, netUsd: 2439.02 } });
    expect((await o.read()).find((h) => h.asset === "USDT")?.amount).toBeCloseTo(2500 + 2439.02, 2);
  });
  it("a DEX fill is a route across one chain's pools: LP fees, gas once, impact from the pool's curve", () => {
    expect(fillAt("dex:Base", "ETH", "sell", 1)).toMatchObject({ kind: "dex", name: "DEX (Base)", symbol: "ETH-USDC", quote: "USDC", chain: "Base", price: 2439.94, grossUsd: 2439.94, feeUsd: 1.27, netUsd: 2438.67, gasUsd: 0.05, route: [{ pool: "base:aero", dex: "Aerodrome", qty: 1 }] });
    // on Ethereum the same pool fee, but one swap's gas is $4: a small position is expensive to trade there
    expect(fillAt("dex:Ethereum", "ETH", "sell", 0.15)).toMatchObject({ chain: "Ethereum", gasUsd: 4, feeUsd: 4.18, netUsd: 361.78 });
    // a buy takes the pool that sits a hair under the reference
    expect(fillAt("dex:Base", "ETH", "buy", 0.4)).toMatchObject({ netUsd: 976.47, route: [{ dex: "Uniswap v3 0.05%", qty: 0.4 }] });
    // size: the route water-fills two pools until their marginal prices are equal, and the price moves
    const big = fillAt("dex:Base", "ETH", "sell", 21)!;
    expect(big.route?.map((r) => r.dex)).toEqual(["Aerodrome", "Uniswap v3 0.05%"]);
    expect(big.route!.reduce((s, r) => s + r.qty, 0)).toBeCloseTo(21, 6);
    expect(big.impactBps).toBeGreaterThan(3);
    expect(fillAt("dex:Base", "ETH", "sell", 400)!.impactBps).toBeGreaterThan(big.impactBps * 10);
    // a 30 bps pool is not worth routing through at this size; an asset without a pool has no DEX quote
    expect(fillAt("dex:Ethereum", "ETH", "sell", 100)?.route?.map((r) => r.dex)).toEqual(["Uniswap v3 0.05%"]);
    expect(fillAt("dex:Base", "SOL", "sell", 1)).toBeUndefined();
  });
  it("quotes the whole order at every venue — two books, the pools on each chain that holds inventory — and says why a venue cannot take it", async () => {
    const { accounts } = await world();
    const eth = venueQuotes("ETH", "sell", 1, accounts);
    expect(eth.map((q) => [q.venue, q.account, q.ok, q.why, q.have])).toEqual([["binance", "binance", true, undefined, 2], ["okx", "okx", true, undefined, 1.5], ["dex:Base", "metamask", true, undefined, 1], ["dex:Ethereum", "metamask", false, "has only 0.15 ETH", 0.15]]);
    expect(eth.map((q) => q.netUsd)).toEqual([2437.44, 2439.02, 2438.67, 2434.53]);
    expect(bestVenue(eth, "sell")).toMatchObject({ venue: "okx", netUsd: 2439.02 });
    const btc = venueQuotes("BTC", "sell", 0.05, accounts);
    expect(btc.map((q) => [q.venue, q.ok, q.why])).toEqual([["binance", true, undefined], ["okx", false, "has no BTC"], ["dex", false, "has no BTC on-chain"]]);
    const small = venueQuotes("ETH", "sell", 0.1, accounts);
    expect(small.find((q) => q.venue === "dex:Ethereum")).toMatchObject({ ok: true });
    expect(bestVenue(small, "sell")?.venue).toBe("okx");
    const buy = venueQuotes("ETH", "buy", 0.5, accounts);
    expect(buy.map((q) => [q.venue, q.why])).toEqual([["binance", undefined], ["okx", undefined], ["dex:Base", "is short of USDC"]]);
    expect(bestVenue(buy, "buy")?.venue).toBe("binance");
    // a small buy: the DEX wins on merit — a 5 bps pool and cents of gas against a 10 bps taker fee
    expect(bestVenue(venueQuotes("ETH", "buy", 0.4, accounts), "buy")).toMatchObject({ venue: "dex:Base", netUsd: 976.47 });
    const off = accounts.map((a) => (a.id === "okx" ? { ...a, revoked: true, reach: ["read" as const] } : a));
    expect(venueQuotes("ETH", "sell", 1, off).find((q) => q.venue === "okx")).toMatchObject({ ok: false, why: "is switched off" });
    expect(venueQuotes("SOL", "sell", 1, accounts).map((q) => q.venue)).toEqual(["binance", "okx"]);
  });
  it("the on-chain wallet swaps on one chain — the one the intent names, or where it nets the most — and the proceeds land there", async () => {
    const m = metamaskSimAccount(seeds.metamask, clock);
    expect(m.account.scope.can).toEqual(["read", "trade", "move"]);
    expect(await m.execute({ kind: "trade", symbol: "ETH-USDC", side: "sell", qty: 0.1 })).toMatchObject({ ok: true, status: "filled", native: { chain: "Base", gasUsd: 0.05, route: [{ dex: "Aerodrome" }] } });
    expect(await m.execute({ kind: "trade", symbol: "ETH-USDC", side: "sell", qty: 0.1, chainId: 1 })).toMatchObject({ ok: true, native: { chain: "Ethereum", gasUsd: 4 } });
    const rows = await m.read();
    expect(rows.filter((h) => h.asset === "ETH").map((h) => [h.note, h.amount])).toEqual([["Ethereum", 0.05], ["Base", 0.9]]);
    expect(rows.filter((h) => h.asset === "USDC").map((h) => h.note)).toEqual(["Base", "Ethereum"]);
    expect(await m.execute({ kind: "trade", symbol: "ETH-USDC", side: "sell", qty: 2 })).toMatchObject({ code: "E_VENUE_INSUFFICIENT" });
    expect(await m.execute({ kind: "trade", symbol: "ETH-USDC", side: "sell", qty: 0.5, chainId: 1 })).toMatchObject({ code: "E_VENUE_INSUFFICIENT", native: { chain: "Ethereum" } });
    expect(await m.execute({ kind: "trade", symbol: "SOL-USDC", side: "sell", qty: 1 })).toMatchObject({ code: "E_VENUE_REJECTED" });
    const buy = await m.execute({ kind: "trade", symbol: "ETH-USDC", side: "buy", qty: 0.4 });
    expect(buy).toMatchObject({ ok: true, native: { chain: "Base", netUsd: 976.47 } });
  });
});

describe("the order router: one order, split across venues", () => {
  const qtys = (p: ReturnType<typeof splitOrder>) => p.slices.map((s) => [s.venue, s.qty]);
  it("no venue holds 3 ETH: each slice goes where its marginal net price is best, limited by inventory", async () => {
    const { accounts } = await world();
    const p = splitOrder("ETH", "sell", 3, accounts);
    expect(p).toMatchObject({ feasible: true, lot: 0.01, netUsd: 7315.91, avgPrice: 2440.44 });
    expect([p.single, p.gainUsd, p.richer]).toEqual([undefined, undefined, undefined]);
    expect(qtys(p)).toEqual([["okx", 1.5], ["dex:Base", 1], ["binance", 0.5]]);
    expect(p.slices.map((s) => [s.account, s.netUsd])).toEqual([["okx", 3658.52], ["metamask", 2438.67], ["binance", 1218.72]]);
    // every slice is exactly what fillAt quotes for that size — the adapters execute with the same function
    for (const s of p.slices) expect(fillAt(s.venue, "ETH", "sell", s.qty)).toMatchObject({ netUsd: s.netUsd, price: s.price });
    // gas is a fixed cost: the 0.15 ETH on Ethereum would cost more to swap than it adds
    expect(p.passed).toEqual([{ venue: "dex:Ethereum", name: "DEX (Ethereum)", have: 0.15, deltaUsd: -3.83, gasUsd: 4 }]);
  });
  it("does not split when one venue is best, and splits when a split nets more than the best single venue", async () => {
    const { accounts } = await world();
    const one = splitOrder("ETH", "sell", 1, accounts);
    expect(qtys(one)).toEqual([["okx", 1]]);
    expect(one.single).toMatchObject({ venue: "okx", netUsd: 2439.02 });
    expect(one.richer).toBeUndefined();
    const two = splitOrder("ETH", "sell", 2, accounts);
    expect(qtys(two)).toEqual([["okx", 1.5], ["dex:Base", 0.5]]);
    expect(two).toMatchObject({ netUsd: 4877.84, single: { venue: "binance", netUsd: 4874.86 }, gainUsd: 2.98 });
    expect(qtys(splitOrder("BTC", "sell", 0.05, accounts))).toEqual([["binance", 0.05]]);
  });
  it("one more leg has to add at least $1: a richer split that earns less is named, not taken", async () => {
    const { accounts } = await world();
    expect(EXTRA_LEG_MIN_GAIN_USD).toBe(1);
    const p = splitOrder("ETH", "buy", 0.5, accounts);
    expect(qtys(p)).toEqual([["binance", 0.5]]);
    expect(p.richer?.gainUsd).toBeGreaterThan(0.5);
    expect(p.richer?.gainUsd).toBeLessThan(1);
    expect(p.richer?.slices.map((s) => s.venue).sort()).toEqual(["binance", "dex:Base"]);
    expect(splitOrder("ETH", "buy", 0.5, accounts, { minGainPerLegUsd: 0.5 }).slices.length).toBe(2);
  });
  it("buys split by what each venue can pay for; a venue the user switched off is not routed to", async () => {
    const { accounts } = await world();
    const buy = splitOrder("ETH", "buy", 3, accounts);
    expect(qtys(buy)).toEqual([["dex:Base", 0.49], ["binance", 2.04], ["okx", 0.47]]);
    expect(buy.slices.reduce((s, x) => s + x.qty, 0)).toBeCloseTo(3, 8);
    expect(buy.slices.find((s) => s.venue === "dex:Base")!.netUsd).toBeLessThanOrEqual(1200);
    expect(buy.slices.find((s) => s.venue === "binance")!.netUsd).toBeLessThanOrEqual(5000);
    const off = accounts.map((a) => (a.id === "okx" ? { ...a, revoked: true, reach: ["read" as const] } : a));
    expect(qtys(splitOrder("ETH", "sell", 3, off))).toEqual([["dex:Base", 1], ["binance", 2]]);
  });
  it("says how much the venues could take together when they cannot take the order", async () => {
    const { accounts } = await world();
    expect(splitOrder("ETH", "sell", 5, accounts)).toMatchObject({ feasible: false, maxQty: 4.65, slices: [] });
    expect(splitOrder("BTC", "sell", 5, accounts)).toMatchObject({ feasible: false, maxQty: 0.3 });
    expect(splitOrder("ETH", "buy", 4, accounts)).toMatchObject({ feasible: false, maxQty: 3.55 });
    expect(splitOrder("SOL", "sell", 1, accounts)).toMatchObject({ feasible: false, maxQty: 0 });
  });
  it("at size the split is about depth: 400 ETH across two books and two chains' pools beats the best single venue by hundreds of dollars", async () => {
    const { accounts } = await world();
    const whale = splitOrder("ETH", "sell", 400, accounts, { ignoreInventory: true });
    expect(qtys(whale)).toEqual([["okx", 181], ["dex:Base", 21], ["dex:Ethereum", 103], ["binance", 95]]);
    expect(whale).toMatchObject({ lot: 1, netUsd: 975071.31, single: { venue: "okx", netUsd: 974655.65 }, gainUsd: 415.66 });
    expect(whale.slices.find((s) => s.venue === "dex:Base")?.route?.length).toBe(2);
    // the venues end near the same marginal price (a fill rounds its price to the cent, hence the slack): no slice could move and net more
    const marginal = (venue: string, q: number) => fillAt(venue, "ETH", "sell", q + 1)!.netUsd - fillAt(venue, "ETH", "sell", q)!.netUsd;
    const ends = whale.slices.map((s) => marginal(s.venue, s.qty));
    expect(Math.max(...ends) - Math.min(...ends)).toBeLessThan(2);
    // …while alone, the best single venue's last ETH sells more than $4 below its second
    expect(marginal("okx", 1) - marginal("okx", 399)).toBeGreaterThan(4);
  });
});

describe("the router", () => {
  it("routes a subscription bigger than the issuer's fuel: Ondo first, then the cheapest open bridge with its quote, then the gap and the price of closing it", async () => {
    const { plan } = await import("../../src/portfolio/agent.ts");
    const p = plan("Subscribe $5,000 OUSG", await ctxOf());
    expect(p.steps.map((s) => [s.account, s.intent.kind, s.needs])).toEqual([["ondo", "subscribe", undefined], ["metamask", "move", undefined], ["ondo", "subscribe", 1]]);
    expect(p.steps[1]!.intent).toMatchObject({ kind: "move", asset: "USDC", amount: 1200, to: "0x5a1e…kyc", fromChainId: 8453, chainId: 1, via: "lp" });
    expect(p.steps[1]!.compare).toBe("Compared: CCTP (native USDC) $1.20 · ~15 min; canonical bridge $2.50 · 7 days; via Binance closed (key cannot withdraw); via OKX closed (key cannot withdraw)");
    expect(p.steps[2]!.intent).toMatchObject({ amountUsd: 1199 });
    expect(p.narration).toContain("over the liquidity bridge to Ethereum (fee $1.00 · ~2 min)");
    expect(p.narration).toContain("Still $801 short");
    expect(p.notes?.[0]).toContain("open withdrawals on the Binance key and it arrives in ~10 min for about $5.30");
    expect(plan("subscribe 1000 OUSG", await ctxOf()).steps.length).toBe(1);
    // the Chinese for the same sentence still works
    expect(plan("申购 5000 OUSG", await ctxOf()).steps.length).toBe(3);
  });
  it("uses live bridge quotes when the wallet can give them, and says so when it cannot", async () => {
    const { plan } = await import("../../src/portfolio/agent.ts");
    const ctx = await ctxOf();
    const live = plan("Subscribe $5,000 OUSG", { ...ctx, liveBridge: { quotes: [{ id: "mm:0", label: "Across", feeUsd: 0.62, etaSec: 30, open: true, source: "mm" }] } });
    expect(live.steps[1]!.intent).toMatchObject({ via: "mm:0" });
    expect(live.steps[2]!.intent).toMatchObject({ amountUsd: 1199.38 });
    const failed = plan("Subscribe $5,000 OUSG", { ...ctx, liveBridge: { error: "INSUFFICIENT_FUNDS" } });
    expect(failed.steps[1]!.intent).toMatchObject({ via: "lp" });
    expect(failed.notes?.join(" ")).toContain("INSUFFICIENT_FUNDS");
  });
  it("reads the CLI's quote shape, and builds the exact command a swap would run", async () => {
    const { parseMmQuotes, mmCommand } = await import("../../src/portfolio/adapters/metamask.ts");
    expect(parseMmQuotes({ quotes: [{ feeData: { metabridge: { usd: "0.42" } }, gasIncludedBreakdown: { gaslessRelayFee: { usd: 0.2 } }, protocols: ["across"], estimatedProcessingTimeInSeconds: 30 }, { priceData: { totalToAmountUsd: "99" }, protocols: [] }] })).toEqual([
      { id: "mm:0", label: "across", feeUsd: 0.62, etaSec: 30, open: true, source: "mm" },
      { id: "mm:1", label: "MetaMask bridge", feeUsd: 0, etaSec: 0, open: true, source: "mm", outUsd: 99 },
    ]);
    expect(mmCommand("mm", { kind: "trade", symbol: "ETH-USDC", side: "sell", qty: 1, chainId: 8453 })?.join(" ")).toBe("mm swap execute --from ETH --to USDC --amount 1 --from-chain-id 8453");
    expect(mmCommand("mm", { kind: "trade", symbol: "ETH-USDC", side: "buy", qty: 0.4 })?.join(" ")).toBe("mm swap execute --from USDC --to ETH --amount 976.47 --from-chain-id 8453");
  });
  it("trades at the best venue and keeps what it compared", async () => {
    const { plan } = await import("../../src/portfolio/agent.ts");
    const p = plan("Sell 1 ETH", await ctxOf());
    expect(p.steps).toHaveLength(1);
    expect(p.steps[0]).toMatchObject({ account: "okx", intent: { kind: "trade", symbol: "ETH-USDT", side: "sell", qty: 1 } });
    expect(p.steps[0]!.compare).toBe("Compared: DEX (Base) nets $2,438.67 ($0.35 less); Binance nets $2,437.44 ($1.58 less); DEX (Ethereum) has only 0.15 ETH");
    expect(p.narration).toBe("Sell 1 ETH: compared at 4 venues; OKX nets the most ($2,439.02). One venue can take it, so no split.");
    expect(p.order?.after[0]).toBe("The USDT stays at OKX: this key cannot withdraw, so it is stuck there.");
    expect(plan("sell 0.05 BTC", await ctxOf()).steps[0]).toMatchObject({ account: "binance", compare: "Compared: OKX has no BTC; DEX has no BTC on-chain" });
    const none = plan("卖 5 BTC", await ctxOf());
    expect(none.steps).toEqual([]);
    expect(none.narration).toContain("all venues together hold only 0.3 BTC");
    expect(plan("buy 0.5 ETH", await ctxOf()).narration).toContain("A split across DEX (Base) + Binance would save only $0.69, under $1.00.");
  });
  it("splits an order no venue can take alone: one step per slice, the split bar, what it left alone, and where the proceeds end up", async () => {
    const { accounts } = await world();
    const o = orderPlan("ETH", "sell", 3, accounts);
    expect(o.title).toBe("Sell 3 ETH");
    expect(o.narration).toBe("Sell 3 ETH: no single venue holds that much (Binance 2 · OKX 1.5 · DEX (Base) 1 · DEX (Ethereum) 0.15). Split into 3 slices: average 2,440.44, net $7,315.91.");
    expect(o.steps.map((s) => [s.account, s.say])).toEqual([["okx", "Sell 1.5 ETH · OKX"], ["metamask", "Sell 1 ETH · DEX (Base)"], ["binance", "Sell 0.5 ETH · Binance"]]);
    expect(o.steps[1]!.intent).toEqual({ kind: "trade", symbol: "ETH-USDC", side: "sell", qty: 1, chainId: 8453 });
    expect(o.parts).toEqual([{ label: "OKX 1.5", pct: 50, kind: "cex" }, { label: "DEX (Base) 1", pct: 33, kind: "dex" }, { label: "Binance 0.5", pct: 17, kind: "cex" }]);
    expect(o.notes).toEqual(["Compared: DEX (Ethereum)'s 0.15 ETH stays put: one swap costs $4.00 in gas, so using it would net $3.83 less."]);
    expect(o.after).toEqual(["Proceeds: USDT stays at OKX and Binance (keys cannot withdraw); the DEX slice's USDC is on Base, free to move."]);
    const two = orderPlan("ETH", "sell", 2, accounts);
    expect(two.narration).toBe("Sell 2 ETH: the best single venue is Binance (net $4,874.86); split into 2 slices it nets $4,877.84, $2.98 more.");
    expect(quoteView(o)).toMatchObject({ order: "Sell 3 ETH", feasible: true, netUsd: 7315.91, slices: [{ venue: "okx", qty: 1.5 }, { venue: "dex:Base", chain: "Base", gasUsd: 0.05 }, { venue: "binance", qty: 0.5 }], leftOut: [{ venue: "dex:Ethereum" }] });
    expect(parseOrder({ base: "eth", side: "sell", qty: "3" })).toEqual({ base: "ETH", side: "sell", qty: 3 });
    expect(parseOrder({ base: "DOGE", side: "sell", qty: 1 })).toBeNull();
    expect(parseOrder({ base: "ETH", side: "hold", qty: 1 })).toBeNull();
  });
});

describe("PortfolioService", () => {
  const home = mkdtempSync(join(tmpdir(), "portfolio-"));
  afterAll(() => rmSync(home, { recursive: true, force: true }));
  let ms = Date.parse(now);
  const tick = () => new Date((ms += 1000)).toISOString();

  it("open mode: cross-account writes with zero cards; a stranger address is the one card; guard adds cards; revoke keeps reads; the ledger chains", async () => {
    const svc = await PortfolioService.create({ home, now: tick });
    const r1 = await svc.execute("binance", { kind: "trade", symbol: "BTCUSDT", side: "sell", qty: 0.05 });
    const r2 = await svc.execute("ondo", { kind: "subscribe", fund: "OUSG", amountUsd: 1500 });
    const r3 = await svc.execute("okx", { kind: "trade", symbol: "ETH-USDT", side: "buy", qty: 0.5 });
    for (const r of [r1, r2, r3]) expect(isRefusal(r) || isPending(r)).toBe(false);
    expect(svc.counters).toMatchObject({ writes: 3, cards: 0 });

    expect(await svc.execute("binance", { kind: "move", asset: "BTC", amount: 0.1, to: COLD })).toMatchObject({ code: "E_WALLET_SCOPE" });
    expect(await svc.bypass("binance", { kind: "move", asset: "BTC", amount: 0.1, to: COLD })).toMatchObject({ code: "E_VENUE_PERMISSION", native: { code: -2015 } });

    const p = await svc.execute("ondo", { kind: "move", asset: "USDC", amount: 300, to: "0x7a11…stranger" });
    expect(isPending(p)).toBe(true);
    if (isPending(p)) {
      expect(await svc.decide(p.approval.id, "reject")).toMatchObject({ code: "E_CARD_REJECTED" });
      expect(await svc.decide(p.approval.id, "approve")).toMatchObject({ code: "E_CARD_NOT_GRANTED" });
    }
    expect(svc.counters.cards).toBe(1);

    svc.setMode("guard");
    const g = await svc.execute("binance", { kind: "trade", symbol: "BTCUSDT", side: "sell", qty: 0.02 });
    expect(isPending(g)).toBe(true);
    if (isPending(g)) expect(await svc.decide(g.approval.id, "approve")).toMatchObject({ ok: true, status: "filled" });

    svc.revoke("okx");
    expect(await svc.execute("okx", { kind: "trade", symbol: "ETH-USDT", side: "sell", qty: 0.1 })).toMatchObject({ code: "E_WALLET_ACCOUNT_REVOKED" });
    expect((await svc.read("okx")).length).toBeGreaterThan(0);
    svc.setReach("ondo", ["subscribe", "redeem"]);
    expect(await svc.execute("ondo", { kind: "move", asset: "USDC", amount: 100, to: COLD })).toMatchObject({ code: "E_WALLET_REACH" });
    expect(await svc.execute("nope", { kind: "trade", symbol: "BTCUSDT", side: "sell", qty: 1 })).toMatchObject({ code: "E_WALLET_ACCOUNT_UNKNOWN" });

    const o = await svc.overview();
    expect(o.mode).toBe("guard");
    expect(o.accounts.find((a) => a.id === "okx")).toMatchObject({ revoked: true, reach: ["read"] });
    expect(o.accounts.find((a) => a.id === "ondo")?.reach).toEqual(["read", "subscribe", "redeem"]);
    expect(o.approvals.length).toBe(2);
    expect(o.chain.ok).toBe(true);
    expect(JSON.stringify(o)).not.toContain(seeds.metamask.seed);
    const kinds = new Set(svc.rows().map((r) => r.kind));
    for (const k of ["intent", "venue", "venue-refusal", "openness-refusal", "card", "bypass", "read", "note"]) expect(kinds.has(k as never)).toBe(true);
    expect(svc.verifyChain()).toMatchObject({ ok: true });

    expect(svc.flights.length).toBeGreaterThan(5);
    expect(svc.flights.every((f) => /^TD-\d{4}$/.test(f.no))).toBe(true);
    expect(svc.rows().filter((r) => r.kind === "venue").every((r) => typeof r.flight === "string" && r.agent === "demo")).toBe(true);
    svc.reset();
    expect(svc.flights.length).toBe(0);
    expect(svc.policy().mode).toBe("open");
    expect(svc.counters).toEqual({ writes: 0, refusals: 0, cards: 0 });
    expect((await svc.read("binance")).find((h) => h.asset === "BTC")?.amount).toBe(0.3);
  });
});

describe("the keyword agent behind the page", () => {
  const home = mkdtempSync(join(tmpdir(), "portfolio-agent-"));
  afterAll(() => rmSync(home, { recursive: true, force: true }));
  let ms = Date.parse(now);
  const tick = () => new Date((ms += 1000)).toISOString();

  it("maps the presets and a sentence with a number to plans; anything else to the menu", async () => {
    const { plan } = await import("../../src/portfolio/agent.ts");
    const ctx = await ctxOf();
    expect(plan("Rebalance", ctx).steps.map((s) => [s.account, s.intent.kind])).toEqual([["okx", "trade"], ["ondo", "subscribe"]]);
    // no card is on the account: a bill is not the agent's to pay, and it says why
    expect(plan("pay 200 to GitHub", ctx)).toMatchObject({ steps: [], narration: expect.stringContaining("no card on this account") });
    expect(plan("subscribe 1000 OUSG", ctx).steps[0]?.intent).toMatchObject({ kind: "subscribe", amountUsd: 1000 });
    expect(plan("Withdraw to cold wallet", ctx).steps[0]?.intent).toMatchObject({ kind: "move", asset: "BTC" });
    expect(plan("Send to a new address", ctx).steps[0]?.intent).toMatchObject({ kind: "move", to: "0x7a11…stranger" });
    expect(plan("buy 0.5 ETH", ctx).steps[0]).toMatchObject({ account: "binance", intent: { side: "buy", qty: 0.5 } });
    expect(plan("tighten to Guard", ctx)).toMatchObject({ mode: "guard", steps: [] });
    // every preset is understood, and so is the Chinese for each of them
    const { PRESETS } = await import("../../src/portfolio/agent.ts");
    const world8 = { ...ctx, ...(await worldWith(true)), polymarketAddress: "0x9e7a…deposit", now };
    for (const preset of PRESETS) expect(plan(preset, world8).steps.length, preset).toBeGreaterThan(0);
    for (const zh of ["再平衡", "申购 1000 OUSG", "提到冷钱包", "转给新地址", "卖 1 ETH", "买 300 份加息 YES"]) expect(plan(zh, world8).steps.length, zh).toBeGreaterThan(0);
    expect(plan("收紧到 Guard", ctx)).toMatchObject({ mode: "guard" });
    expect(plan("what is the weather today", ctx).steps).toEqual([]);
  });

  it("flies in plain words: numbered flights, fills with what they netted and what they beat, a refusal without codes, one card, and the decision as one more leg", async () => {
    const { AgentSession } = await import("../../src/portfolio/agent.ts");
    const { agentCode } = await import("../../src/portfolio/accounts.ts");
    const svc = await PortfolioService.create({ home, now: tick });
    const agent = new AgentSession(svc);
    const f1 = await agent.say("Rebalance");
    expect(f1.no).toBe("PM-0001");
    expect(f1.legs.map((l) => l.mark)).toEqual(["note", "ok", "ok", "note"]);
    expect(f1.legs[1]).toMatchObject({ account: "okx" });
    expect(f1.legs[1]?.text).toBe("Sell 1 ETH · OKX @ 2,440.97 · net $2,439.02");
    expect(f1.legs[1]?.compare).toContain("Binance nets $2,437.44");
    expect(f1.legs[3]?.text).toContain("stuck there");
    const f2 = await agent.say("Withdraw to cold wallet");
    expect(f2.legs[1]).toMatchObject({ mark: "no" });
    expect(f2.legs[1]?.text).toBe("Withdraw 0.1 BTC to the cold wallet · Binance: the Binance credential can't transfer out; not done");
    expect(f2.legs[1]?.text).not.toMatch(/E_WALLET/);
    const f3 = await agent.say("Send to a new address");
    expect(f3.legs[1]).toMatchObject({ mark: "wait" });
    const id = f3.legs[1]?.approvalId;
    expect(id).toBeTruthy();
    expect(await svc.decide(id!, "reject")).toMatchObject({ code: "E_CARD_REJECTED" });
    expect(f3.legs[2]).toMatchObject({ mark: "no", text: "You rejected it; nothing moved" });
    expect(await svc.decide(id!, "approve")).toMatchObject({ code: "E_CARD_NOT_GRANTED" });
    const f4 = await agent.say("Tighten to Guard");
    expect(svc.policy().mode).toBe("guard");
    expect(f4.legs[1]?.text).toBe("Now in Guard");
    await agent.say("Switch back to Open");
    const f6 = await agent.say("Subscribe $5,000 OUSG");
    expect(f6.no).toBe("PM-0006");
    const ok6 = f6.legs.filter((l) => l.mark === "ok");
    expect(ok6.map((l) => l.text.split(" ")[0])).toEqual(["Subscribe", "Bridge", "Subscribe"]);
    expect(ok6[1]?.text).toBe("Bridge $1,200 USDC: Base → Ethereum → Ondo address · liquidity bridge · fee $1.00 · ~2 min");
    expect(ok6[1]?.compare).toContain("CCTP");
    expect(ok6[2]?.usd).toBe(1199);
    expect(f6.legs[0]?.text).toContain("short");
    expect((await svc.read("ondo")).find((h) => h.asset === "USDC")).toBeUndefined();
    expect(svc.rows().find((r) => r.kind === "funding")).toMatchObject({ venue: "ondo", notionalUsd: 1199, flight: "PM-0006" });
    const mcp = await svc.execute("binance", { kind: "trade", symbol: "BTCUSDT", side: "sell", qty: 0.001 }, { id: "claude-code", name: "claude-code", code: agentCode("claude-code") });
    expect(mcp).toMatchObject({ ok: true });
    expect(svc.flights.at(-1)).toMatchObject({ no: "CC-0007", agent: { code: "CC" } });
    expect(agentCode("Cursor IDE")).toBe("CI");
    expect(agentCode("codex")).toBe("CO");
    svc.reset();
    expect(svc.flights.length).toBe(0);
  });
});

describe("a split order as a flight", () => {
  const home = mkdtempSync(join(tmpdir(), "portfolio-split-"));
  afterAll(() => rmSync(home, { recursive: true, force: true }));
  let ms = Date.parse(now);
  const tick = () => new Date((ms += 1000)).toISOString();
  const eth = async (svc: PortfolioService, account: string) => (await svc.read(account)).filter((h) => h.asset === "ETH").reduce((s, h) => s + h.amount, 0);

  it("open: three slices land at three venues at the quoted prices; the DEX slice shows its route and its USDC stays on-chain", async () => {
    const { AgentSession } = await import("../../src/portfolio/agent.ts");
    const svc = await PortfolioService.create({ home, now: tick });
    const f = await new AgentSession(svc).say("Sell 3 ETH");
    expect(f.legs.map((l) => l.mark)).toEqual(["note", "ok", "ok", "ok", "note", "note"]);
    expect(f.legs[0]?.parts?.map((p) => `${p.label}:${p.kind}`)).toEqual(["OKX 1.5:cex", "DEX (Base) 1:dex", "Binance 0.5:cex"]);
    expect(f.legs[1]).toMatchObject({ account: "okx", text: "Sell 1.5 ETH · OKX @ 2,440.97 · net $3,658.52" });
    expect(f.legs[2]).toMatchObject({ account: "metamask", text: "Sell 1 ETH · DEX (Base) @ 2,439.94 · net $2,438.67", compare: "Route: Aerodrome · gas $0.05" });
    expect(f.legs[3]).toMatchObject({ account: "binance", text: "Sell 0.5 ETH · Binance @ 2,439.88 · net $1,218.72" });
    expect(f.legs[4]?.text).toContain("$4.00 in gas");
    expect(f.legs[5]?.text).toContain("free to move");
    expect([await eth(svc, "okx"), await eth(svc, "binance"), await eth(svc, "metamask")]).toEqual([0, 1.5, 0.15]);
    expect((await svc.read("metamask")).find((h) => h.asset === "USDC" && h.note === "Base")?.amount).toBe(3638.67);
    const o = await svc.overview();
    expect(o.liquidity.mobile.find((s) => s.account === "metamask")?.usd).toBe(3638.67);
    expect(o.counters).toMatchObject({ writes: 3, cards: 0, refusals: 0 });
    expect(svc.rows().filter((r) => r.kind === "venue" && r.flight === f.no).map((r) => r.venue)).toEqual(["okx", "metamask", "binance"]);
    // nothing left that can take 3 ETH: the agent says how much there is instead of selling something else
    const again = await new AgentSession(svc).say("Sell 3 ETH");
    expect(again.legs.map((l) => l.mark)).toEqual(["note"]);
    expect(again.legs[0]?.text).toContain("all venues together hold only 1.65 ETH");
  });

  it("guard: the whole order is ONE card; nothing moves until it is answered; one yes fills every slice, one no moves nothing", async () => {
    const { AgentSession } = await import("../../src/portfolio/agent.ts");
    const svc = await PortfolioService.create({ home, now: tick });
    svc.setMode("guard");
    const agent = new AgentSession(svc);
    const f = await agent.say("Sell 3 ETH");
    expect(f.legs.map((l) => l.mark)).toEqual(["note", "wait", "note"]);
    expect(f.legs[1]).toMatchObject({ text: "Sell 3 ETH (3 slices): above the no-ask limit, needs your OK", usd: 7320 });
    expect(svc.counters).toMatchObject({ cards: 1, writes: 0 });
    const ap = (await svc.overview()).approvals[0]!;
    expect(ap).toMatchObject({ status: "pending", why: "allowance", usd: 7320, title: "Sell 3 ETH (3 slices)", reason: expect.stringContaining("slices are counted together") });
    expect(ap.batch?.map((s) => s.account)).toEqual(["okx", "metamask", "binance"]);
    expect([await eth(svc, "okx"), await eth(svc, "binance"), await eth(svc, "metamask")]).toEqual([1.5, 2, 1.15]);
    expect(await svc.decide(ap.id, "approve")).toMatchObject({ ok: true, status: "filled", account: "okx+metamask+binance", usd: 7321.33 });
    expect(f.legs.slice(3).map((l) => [l.mark, l.text.split(" @")[0]])).toEqual([["ok", "Approved · Sell 1.5 ETH · OKX"], ["ok", "Approved · Sell 1 ETH · DEX (Base)"], ["ok", "Approved · Sell 0.5 ETH · Binance"], ["note", "Proceeds: USDT stays at OKX and Binance (keys cannot withdraw); the DEX slice's USDC is on Base, free to move."]]);
    expect(f.legs[4]?.compare).toBe("Route: Aerodrome · gas $0.05");
    expect([await eth(svc, "okx"), await eth(svc, "binance"), await eth(svc, "metamask")]).toEqual([0, 1.5, 0.15]);
    expect(svc.counters).toMatchObject({ cards: 1, writes: 3 });
    expect(await svc.decide(ap.id, "approve")).toMatchObject({ code: "E_CARD_NOT_GRANTED" });
    const g = await agent.say("Sell 1.6 ETH");
    const id = g.legs.find((l) => l.approvalId)?.approvalId;
    expect(g.legs.find((l) => l.mark === "wait")?.text).toContain("2 slices");
    expect(await svc.decide(id!, "reject")).toMatchObject({ code: "E_CARD_REJECTED" });
    expect(g.legs.at(-1)).toMatchObject({ mark: "no", text: "You rejected it; nothing moved" });
    expect(g.legs.some((l) => l.text.startsWith("Proceeds"))).toBe(false);
    expect([await eth(svc, "binance"), await eth(svc, "metamask")]).toEqual([1.5, 0.15]);
    expect(svc.verifyChain()).toMatchObject({ ok: true });
  });

  it("the tower routes for any agent: a quote is a read, an order flies under the caller's name", async () => {
    const svc = await PortfolioService.create({ home, now: tick });
    const q = await svc.quote("ETH", "sell", 3);
    expect(q.split.slices.map((s) => s.venue)).toEqual(["okx", "dex:Base", "binance"]);
    expect(svc.counters).toEqual({ writes: 0, refusals: 0, cards: 0 });
    expect(svc.flights.length).toBe(0);
    expect(svc.rows().at(-1)).toMatchObject({ kind: "read", tool: "portfolio_quote" });
    const r = await svc.order("ETH", "sell", 3, { id: "claude-code", name: "claude-code", code: "CC" });
    expect(r.flight.no).toBe("CC-0001");
    expect(r.outcomes.map((x) => (isRefusal(x) || isPending(x) ? "?" : x.status))).toEqual(["filled", "filled", "filled"]);
    expect(r.flight.legs.at(-1)?.text).toContain("free to move");
    expect(svc.rows().filter((x) => x.kind === "venue").every((x) => x.flight === "CC-0001" && x.agent === "claude-code")).toBe(true);
    const none = await svc.order("ETH", "sell", 9, { id: "claude-code", name: "claude-code", code: "CC" });
    expect(none.outcomes).toEqual([]);
    expect(none.flight.legs.map((l) => l.mark)).toEqual(["note"]);
    // a buy on the DEX: the wallet has USDC on Base again, so the pool route wins a small order on merit
    const buy = await svc.order("ETH", "buy", 0.4);
    expect(buy.plan.split.slices.map((s) => s.venue)).toEqual(["dex:Base"]);
    expect(buy.flight.legs[1]).toMatchObject({ mark: "ok", account: "metamask", text: "Buy 0.4 ETH · DEX (Base) @ 2,439.82 · cost $976.47" });
    expect(buy.flight.legs[1]?.compare).toBe("Route: Uniswap v3 0.05% · gas $0.05; Compared: Binance costs $977.03 ($0.56 more); OKX costs $977.37 ($0.90 more)");
  });
});

describe("prediction markets: event contracts", () => {
  const FED = "FED-DEC-HIKE25:YES";
  const at = "2026-10-03T09:00:00.000Z";

  it("a contract is a question with a close date, a book per venue, and a state", () => {
    expect(EVENTS.map((e) => [e.id, eventState(e, at), Object.keys(e.listings)])).toEqual([["FED-DEC-HIKE25", "open", ["polymarket", "kalshi"]], ["GOV-SHUTDOWN-OCT1", "awaiting", ["polymarket"]], ["FED-SEP-HOLD", "resolved", ["polymarket"]]]);
    expect([isEventSymbol(FED), isEventSymbol("ETH"), isEventSymbol("ETH-USDC")]).toEqual([true, false, false]);
    expect(parseEventSymbol(FED)).toMatchObject({ outcome: "YES", event: { title: "Fed hikes 25 bps in December" } });
    expect(parseEventSymbol("NOPE:YES")).toBeUndefined();
    // a share is worth its mark, and $1 or $0 once the question is settled
    expect([eventMark(FED), eventMark("FED-DEC-HIKE25:NO"), eventMark("FED-SEP-HOLD:YES"), eventMark("FED-SEP-HOLD:NO")]).toEqual([0.735, 0.265, 1, 0]);
    expect([findEvent("buy 1000 yes · fed hike")?.id, findEvent("买 300 份加息")?.id, findEvent("shutdown")?.id, findEvent("eth")]).toEqual(["FED-DEC-HIKE25", "FED-DEC-HIKE25", "GOV-SHUTDOWN-OCT1", undefined]);
  });

  it("an order walks the book level by level and pays a fee shaped like p × (1 − p); NO is the mirror of YES", () => {
    expect(levelsFor("polymarket", FED, "buy")?.map((l) => [l.price, l.size])).toEqual([[0.74, 700], [0.75, 2500], [0.76, 6000]]);
    expect(levelsFor("polymarket", "FED-DEC-HIKE25:NO", "buy")?.map((l) => [l.price, l.size])).toEqual([[0.27, 600], [0.28, 1800], [0.29, 5000]]);
    expect(rawEvent("polymarket", FED, "buy", 800)).toMatchObject({ gross: 700 * 0.74 + 100 * 0.75, best: 0.74 });
    expect(rawEvent("polymarket", FED, "buy", 50_000)).toBeUndefined();
    expect(fillAt("polymarket", FED, "buy", 400)).toMatchObject({ kind: "prediction", name: "Polymarket", quote: "pUSD", price: 0.74, grossUsd: 296, feeUsd: 3.85, netUsd: 299.85 });
    expect(fillAt("polymarket", FED, "buy", 800)).toMatchObject({ price: 0.7412, grossUsd: 593, feeUsd: 7.67, netUsd: 600.67 });
    // Kalshi: a cent cheaper at the top, a higher fee rate, rounded UP to the cent
    expect(fillAt("kalshi", FED, "buy", 400)).toMatchObject({ name: "Kalshi", quote: "USD", price: 0.73, grossUsd: 292, feeUsd: 5.52, netUsd: 297.52 });
    expect(0.07 * 0.73 * 0.27 * 400).toBeLessThan(5.52);
    expect(fillAt("kalshi", FED, "sell", 150)).toMatchObject({ price: 0.72, grossUsd: 108, netUsd: 105.88 });
    // the venues' own order rules: 5 shares minimum at Polymarket, whole contracts at Kalshi
    expect(fillAt("polymarket", FED, "buy", 3)).toBeUndefined();
    expect(fillAt("kalshi", FED, "buy", 10.5)).toBeUndefined();
    expect(fillAt("kalshi", "GOV-SHUTDOWN-OCT1:YES", "buy", 10)).toBeUndefined();
  });

  it("the same question is quoted at both venues, and bought across both when neither has the cash", async () => {
    const { accounts } = await worldWith(true);
    const q = venueQuotes(FED, "buy", 300, accounts);
    expect(q.map((x) => [x.venue, x.ok, x.netUsd, x.have])).toEqual([["kalshi", true, 223.14, 500], ["polymarket", true, 224.89, 600]]);
    expect(bestVenue(q, "buy")?.venue).toBe("kalshi");
    const big = splitOrder(FED, "buy", 1000, accounts);
    expect(big.slices.map((s) => [s.venue, s.qty, s.price, s.netUsd])).toEqual([["kalshi", 400, 0.73, 297.52], ["polymarket", 600, 0.74, 449.77]]);
    expect(big).toMatchObject({ feasible: true, lot: 10, netUsd: 747.29, avgPrice: 0.736 });
    expect(big.single).toBeUndefined();
    // a split that beats the best single venue
    expect(splitOrder(FED, "buy", 600, accounts)).toMatchObject({ netUsd: 447.44, single: { venue: "polymarket", netUsd: 449.77 }, gainUsd: 2.33 });
    expect(splitOrder(FED, "buy", 2000, accounts)).toMatchObject({ feasible: false, maxQty: 1450 });
    // a sale goes where the shares are
    expect(splitOrder(FED, "sell", 150, accounts).slices.map((s) => [s.venue, s.qty, s.netUsd])).toEqual([["kalshi", 150, 105.88]]);
    expect(venueQuotes(FED, "sell", 150, accounts).find((x) => x.venue === "polymarket")).toMatchObject({ ok: false, why: "has no shares" });
    // a settled market has no book: nothing routes there
    expect(splitOrder("FED-SEP-HOLD:YES", "buy", 10, accounts)).toMatchObject({ feasible: false, quotes: [] });
  });

  it("Polymarket: fills in pUSD, takes a bridge deposit, withdraws, redeems winnings; a restricted region gets no orders", async () => {
    const pm = polymarketSimAccount(seeds.polymarket, clock);
    expect(pm.account).toMatchObject({ kind: "prediction", chain: "Polygon", address: "0x9e7a…deposit", scope: { can: ["read", "trade", "move", "redeem"], enforcedBy: "venue" } });
    expect((await pm.read()).map((h) => [h.asset, h.amount, h.usd, h.class, h.redeemable])).toEqual([["pUSD", 600, 600, "stable", undefined], ["FED-SEP-HOLD:YES", 80, 80, "event", true]]);
    expect(await pm.execute({ kind: "trade", symbol: FED, side: "buy", qty: 400 })).toMatchObject({ ok: true, status: "filled", usd: 296, native: { status: "matched", price: 0.74, netUsd: 299.85 } });
    expect(await pm.execute({ kind: "trade", symbol: FED, side: "buy", qty: 3 })).toMatchObject({ code: "E_VENUE_REJECTED", native: { error: "INVALID_ORDER_MIN_SIZE" } });
    expect(await pm.execute({ kind: "trade", symbol: FED, side: "buy", qty: 800 })).toMatchObject({ code: "E_VENUE_INSUFFICIENT" });
    expect(await pm.execute({ kind: "trade", symbol: "FED-SEP-HOLD:YES", side: "buy", qty: 10 })).toMatchObject({ code: "E_VENUE_MARKET_CLOSED", layer: "VENUE" });
    expect(await pm.execute({ kind: "trade", symbol: "ETH-USDC", side: "buy", qty: 10 })).toMatchObject({ code: "E_VENUE_REJECTED" });
    pm.credit!("USDC", 299.45, "Polygon");
    expect(await pm.execute({ kind: "redeem", fund: "FED-SEP-HOLD", amountUsd: 80 })).toMatchObject({ ok: true, status: "sent", usd: 80 });
    expect(await pm.execute({ kind: "redeem", fund: "FED-DEC-HIKE25", amountUsd: 10 })).toMatchObject({ code: "E_VENUE_REJECTED" });
    expect(await pm.execute({ kind: "move", asset: "pUSD", amount: 100, to: "wallet-main" })).toMatchObject({ ok: true, status: "sent" });
    expect((await pm.read()).map((h) => [h.asset, h.amount])).toEqual([["pUSD", 579.6], ["FED-DEC-HIKE25:YES", 400]]);
    const blocked = polymarketSimAccount({ ...seeds.polymarket, geoblock: { blocked: true, country: "US", region: "NY" } }, clock);
    expect(blocked.account).toMatchObject({ scope: { can: ["read", "move", "redeem"] }, closed: { trade: "takes no orders from US-NY" } });
    expect(blocked.account.scope.limits[0]).toContain("PREDICT_GEOBLOCKED");
    expect(await blocked.execute({ kind: "trade", symbol: FED, side: "buy", qty: 10 })).toMatchObject({ code: "E_VENUE_GEOBLOCKED", message: "Polymarket takes no orders from US-NY", native: { error: "PREDICT_GEOBLOCKED", country: "US", region: "NY" } });
    // the live read: what `mm predict geoblock` and `mm predict status` say becomes the credential's scope; the caller's IP is dropped
    expect(geoblockOf({ result: { blocked: true, ip: "203.0.113.9", country: "US", region: "NY" } })).toEqual({ blocked: true, country: "US", region: "NY" });
    expect([liveScope(false, { blocked: true }), liveScope(true, { blocked: true }), liveScope(true, { blocked: false })]).toEqual([["read"], ["read", "move", "redeem"], ["read", "trade", "move", "redeem"]]);
  });

  it("Kalshi: whole contracts paid in USD; the key trades and cannot move money", async () => {
    const k = kalshiAccount(seeds.kalshi, clock);
    expect(k.account.scope.can).toEqual(["read", "trade"]);
    expect((await k.read()).map((h) => [h.asset, h.amount, h.usd, h.class])).toEqual([["USD", 500, 500, "cash"], [FED, 150, 110.25, "event"]]);
    expect(await k.execute({ kind: "trade", symbol: FED, side: "buy", qty: 400 })).toMatchObject({ ok: true, status: "filled", native: { status: "executed", price: 0.73, feeUsd: 5.52 } });
    expect(await k.execute({ kind: "trade", symbol: FED, side: "buy", qty: 10.5 })).toMatchObject({ code: "E_VENUE_REJECTED", native: { error: { code: "invalid_order" } } });
    expect(await k.execute({ kind: "trade", symbol: FED, side: "buy", qty: 400 })).toMatchObject({ code: "E_VENUE_INSUFFICIENT", native: { error: { code: "insufficient_balance" } } });
    expect(await k.execute({ kind: "trade", symbol: "GOV-SHUTDOWN-OCT1:YES", side: "buy", qty: 10 })).toMatchObject({ code: "E_VENUE_REJECTED", native: { error: { code: "market_not_found" } } });
    expect(await k.execute({ kind: "move", asset: "USD", amount: 100, to: "wallet-main" })).toMatchObject({ code: "E_VENUE_PERMISSION", native: { status: 404 } });
    expect(await k.execute({ kind: "trade", symbol: FED, side: "sell", qty: 550 })).toMatchObject({ ok: true, status: "filled" });
    expect(await kalshiAccount({ ...seeds.kalshi, usd: 50_000, positionLimitUsd: 300 }, clock).execute({ kind: "trade", symbol: FED, side: "buy", qty: 400 })).toMatchObject({ code: "E_VENUE_REJECTED", native: { error: { code: "position_limit_exceeded" } } });
  });

  it("the ladder and the liquidity map know them: Polymarket's pUSD can come back in minutes, Kalshi's cash only by ACH", async () => {
    const { ladder: L, liquidity: Liq } = await worldWith(true);
    expect(L.rows.map((r) => [r.bucket, r.usd])).toEqual([["now", 3000], ["minutes", 1800], ["t1", 1987.56], ["closed", 8000]]);
    expect(L.rows[1]!.items.find((it) => it.account === "polymarket")).toMatchObject({ asset: "pUSD", chain: "Polygon", open: true, route: { id: "lp", label: "withdraw, then liquidity bridge", feeUsd: 0.7 } });
    expect(L.rows[3]!.items.find((it) => it.account === "kalshi")).toMatchObject({ open: false, route: { id: "ach", why: "pays out by ACH, not through the agent" } });
    expect(Liq.mobile.map((s) => s.account)).toEqual(["metamask", "polymarket", "ondo"]);
    expect(Liq.stuck.find((s) => s.account === "kalshi")?.why).toBe("pays out by ACH, not through the agent");
    // Polygon is not a rollup of Ethereum: there is no canonical exit to compare
    expect(bridgeQuotes(600, "Ethereum", "Polygon").map((q) => q.id)).toEqual(["lp", "cctp"]);
    expect(bridgeQuotes(300, "Polygon", "Base").map((q) => [q.id, q.feeUsd])).toEqual([["lp", 0.55], ["cctp", 1.2]]);
  });

  it("open mode still asks before an order in a market past its close; a settled market is the venue's refusal", () => {
    const pm = polymarketSimAccount(seeds.polymarket, clock).account;
    const base = { openness, now: at, dailyOutUsd: 0, account: pm };
    expect(evaluate({ ...base, intent: { kind: "trade", symbol: FED, side: "buy", qty: 400 } })).toMatchObject({ ok: true, card: null, usd: 294 });
    expect(evaluate({ ...base, intent: { kind: "trade", symbol: "GOV-SHUTDOWN-OCT1:YES", side: "buy", qty: 100 } })).toMatchObject({ ok: true, usd: 96, card: { why: "awaiting", reason: expect.stringContaining("is not yet resolved") } });
    expect(evaluate({ ...base, openness: { ...openness, mode: "guard" }, intent: { kind: "trade", symbol: "GOV-SHUTDOWN-OCT1:YES", side: "buy", qty: 1 } })).toMatchObject({ card: { why: "awaiting" } });
    expect(evaluate({ ...base, intent: { kind: "trade", symbol: "FED-SEP-HOLD:YES", side: "buy", qty: 10 } })).toMatchObject({ ok: true, card: null });
    expect(evaluate({ ...base, intent: { kind: "trade", symbol: FED, side: "buy", qty: 400 }, account: { ...pm, scope: { ...pm.scope, can: ["read", "move", "redeem"] } } })).toMatchObject({ code: "E_WALLET_SCOPE" });
    expect(compileOpenness([pm], openness)[0]!.layer2.walletKeeps[0]).toMatch(/new address/);
    expect(compileOpenness([kalshiAccount(seeds.kalshi, clock).account], openness)[0]!.layer2.walletKeeps[0]).toMatch(/market past its close/);
  });

  it("the page agent's sentences: an order, funding over a bridge, redeeming winnings", async () => {
    const { plan } = await import("../../src/portfolio/agent.ts");
    const ctx = { cryptoPct: 52, ondoAddress: "0x5a1e…kyc", polymarketAddress: "0x9e7a…deposit", now: at, ...(await worldWith(true)) };
    const buy = plan("Buy 1,000 YES · Fed hike", ctx);
    expect(buy.narration).toBe("Buy 1,000 YES · Fed hikes 25 bps in December: no single venue has the cash for it (Kalshi $500 · Polymarket $600). Split into 2 slices: average 0.736, cost $747.29.");
    expect(buy.steps.map((s) => [s.account, s.intent, s.say])).toEqual([
      ["kalshi", { kind: "trade", symbol: FED, side: "buy", qty: 400 }, "Buy 400 YES · Kalshi"],
      ["polymarket", { kind: "trade", symbol: FED, side: "buy", qty: 600 }, "Buy 600 YES · Polymarket"],
    ]);
    expect(buy.order?.parts).toEqual([{ label: "Kalshi 400", pct: 40, kind: "prediction" }, { label: "Polymarket 600", pct: 60, kind: "prediction" }]);
    expect(buy.order?.after).toEqual(["Each share pays $1 if this resolves YES (closes 2026-12-09), $0 if not; until then it can be sold back at the bid.", "Kalshi settles by its own rulebook, Polymarket settles by UMA's optimistic oracle: the same question can resolve differently at each."]);
    expect(plan("buy 300 no fed hike", ctx).steps[0]?.intent).toMatchObject({ symbol: "FED-DEC-HIKE25:NO", side: "buy", qty: 300 });
    expect(plan("sell 150 yes fed hike", ctx).steps.map((s) => [s.account, s.compare])).toEqual([["kalshi", "Compared: Polymarket has no shares"]]);
    expect(plan("buy 10 yes september hold", ctx)).toMatchObject({ steps: [], narration: expect.stringContaining("this market has settled (YES)") });
    const fund = plan("Fund Polymarket with 300", ctx);
    expect(fund.steps[0]).toMatchObject({ account: "metamask", intent: { kind: "move", asset: "USDC", amount: 300, to: "0x9e7a…deposit", fromChainId: 8453, chainId: 137, via: "lp" }, say: "Bridge $300 USDC: Base → Polygon → Polymarket deposit wallet", compare: "Compared: CCTP (native USDC) $1.20 · ~15 min" });
    expect(plan("fund polymarket with 5000", ctx)).toMatchObject({ steps: [], narration: expect.stringContaining("Not enough") });
    const redeem = plan("Redeem winnings", ctx);
    expect(redeem.steps[0]).toMatchObject({ account: "polymarket", intent: { kind: "redeem", fund: "FED-SEP-HOLD", amountUsd: 80 }, say: "Redeem 80 winning shares · Polymarket" });
    // the OUSG router names the cash that is parked at Polymarket instead of taking it
    expect(plan("Subscribe $5,000 OUSG", ctx).notes?.[1]).toBe("Polymarket holds $600 pUSD: it could come over in minutes, but it is parked for betting. Say so and I'll move it.");
  });

  it("flies: a split buy across both venues, the funding bridge that lands in the deposit wallet, the card for a market past its close", async () => {
    const home = mkdtempSync(join(tmpdir(), "portfolio-predict-"));
    let t = Date.parse(at);
    const tick = () => new Date((t += 1000)).toISOString();
    const { AgentSession } = await import("../../src/portfolio/agent.ts");
    const svc = await PortfolioService.create({ home, now: tick });
    const agent = new AgentSession(svc);
    expect(svc.accounts().map((a) => a.id)).toEqual(["binance", "okx", "metamask", "kalshi", "polymarket", "ondo"]);
    const o = await svc.overview();
    expect(o.portfolio.totalUsd).toBe(44968.81);
    expect(o.portfolio.byClass.map((c) => [c.class, c.label, c.usd])).toEqual([["cash", "Cash", 500], ["stable", "Stablecoins", 12300], ["crypto", "Crypto", 29991], ["event", "Predictions", 190.25], ["rwa", "RWA", 1987.56]]);
    expect(svc.markets().map((m) => [m.id, m.state, m.venues.map((v) => `${v.venue} ${v.yes.bid}/${v.yes.ask}`)])).toEqual([["FED-DEC-HIKE25", "open", ["polymarket 0.73/0.74", "kalshi 0.72/0.73"]], ["GOV-SHUTDOWN-OCT1", "awaiting", ["polymarket 0.95/0.97"]], ["FED-SEP-HOLD", "resolved", ["polymarket undefined/undefined"]]]);
    const f1 = await agent.say("Buy 1,000 YES · Fed hike");
    expect(f1.legs.map((l) => l.mark)).toEqual(["note", "ok", "ok", "note", "note"]);
    expect(f1.legs.slice(1, 3).map((l) => l.text)).toEqual(["Buy 400 YES · Kalshi @ 0.73 · cost $297.52", "Buy 600 YES · Polymarket @ 0.74 · cost $449.77"]);
    expect((await svc.read("kalshi")).map((h) => [h.asset, h.amount])).toEqual([["USD", 202.48], ["FED-DEC-HIKE25:YES", 550]]);
    const f2 = await agent.say("Fund Polymarket with 300");
    expect(f2.legs[1]).toMatchObject({ mark: "ok", account: "metamask", text: "Bridge $300 USDC: Base → Polygon → Polymarket deposit wallet · liquidity bridge · fee $0.55 · ~2 min" });
    expect(svc.rows().find((r) => r.kind === "funding")).toMatchObject({ venue: "polymarket", notionalUsd: 299.45, flight: f2.no });
    expect((await svc.read("polymarket")).find((h) => h.asset === "pUSD")?.amount).toBe(449.68);
    const f3 = await agent.say("Redeem winnings");
    expect(f3.legs[1]).toMatchObject({ mark: "ok", text: "Redeem 80 winning shares · Polymarket · paid out", usd: 80 });
    // open mode, and still a card: the market is past its close
    const f4 = await agent.say("buy 100 yes shutdown");
    expect(f4.legs[1]).toMatchObject({ mark: "wait", text: "Buy 100 YES · Polymarket: this market is past its close and not yet resolved, needs your OK" });
    expect((await svc.overview()).approvals[0]).toMatchObject({ status: "pending", why: "awaiting" });
    expect(await svc.decide(f4.legs[1]!.approvalId!, "approve")).toMatchObject({ ok: true, status: "filled" });
    expect(f4.legs.at(-1)?.text).toContain("pays $1 if this resolves YES");
    // the venue's own line once the wallet is out of the way; an MCP agent routes an event order like any other
    expect(await svc.execute("kalshi", { kind: "move", asset: "USD", amount: 50, to: "wallet-main" })).toMatchObject({ code: "E_WALLET_SCOPE" });
    expect(await svc.bypass("kalshi", { kind: "move", asset: "USD", amount: 50, to: "wallet-main" })).toMatchObject({ code: "E_VENUE_PERMISSION" });
    const r = await svc.order(FED, "sell", 100, { id: "codex", name: "codex", code: "CO" });
    expect(r.flight.no).toBe("CO-0006");
    expect(r.plan.split.slices.map((s) => s.venue)).toEqual(["polymarket"]);
    expect(parseOrder({ base: "fed-dec-hike25:yes", side: "buy", qty: 10 })).toEqual({ base: "FED-DEC-HIKE25:YES", side: "buy", qty: 10 });
    expect(parseOrder({ base: "NOPE:YES", side: "buy", qty: 10 })).toBeNull();
    expect(svc.verifyChain()).toMatchObject({ ok: true });
    rmSync(home, { recursive: true, force: true });
  });
});
