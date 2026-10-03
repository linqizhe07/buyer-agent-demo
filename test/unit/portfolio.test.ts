import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isRefusal } from "../../src/core/errors.ts";
import { type Account, type Intent } from "../../src/portfolio/accounts.ts";
import { bankAccount } from "../../src/portfolio/adapters/bank.ts";
import { binanceAccount } from "../../src/portfolio/adapters/binance.ts";
import { mastercardAccount } from "../../src/portfolio/adapters/mastercard.ts";
import { metamaskSimAccount } from "../../src/portfolio/adapters/metamask.ts";
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
  it("Mastercard agentic token: in-scope pays authorize; MCC, per-txn, daily and expiry decline with the real response codes", async () => {
    const m = mastercardAccount(seeds.mastercard, clock);
    expect(await m.execute({ kind: "pay", merchant: "Anthropic", mcc: "7372", amountUsd: 120 })).toMatchObject({ ok: true, status: "authorized", native: { responseCode: "00" } });
    expect(await m.execute({ kind: "pay", merchant: "Casino", mcc: "7995", amountUsd: 50 })).toMatchObject({ code: "E_VENUE_CARD_DECLINED", native: { responseCode: "57" } });
    expect(await m.execute({ kind: "pay", merchant: "Anthropic", mcc: "7372", amountUsd: 900 })).toMatchObject({ native: { responseCode: "61" } });
    expect(await m.execute({ kind: "pay", merchant: "Anthropic", mcc: "7372", amountUsd: 500 })).toMatchObject({ ok: true });
    expect(await m.execute({ kind: "pay", merchant: "Anthropic", mcc: "7372", amountUsd: 500 })).toMatchObject({ ok: true });
    expect(await m.execute({ kind: "pay", merchant: "Anthropic", mcc: "7372", amountUsd: 500 })).toMatchObject({ native: { responseCode: "65" } });
    const expired = mastercardAccount(seeds.mastercard, () => "2027-01-01T00:00:00Z");
    expect(await expired.execute({ kind: "pay", merchant: "Anthropic", mcc: "7372", amountUsd: 1 })).toMatchObject({ native: { responseCode: "54" } });
    expect((await m.read())[0]).toMatchObject({ class: "credit" });
  });
  it("bank: read-only aggregation token — every write is the bank's 403", async () => {
    const c = bankAccount(seeds.chase);
    expect(c.account.scope.can).toEqual(["read"]);
    expect(await c.read()).toEqual([{ account: "chase", asset: "USD", amount: 12400, usd: 12400, class: "cash" }]);
    expect(await c.execute({ kind: "pay", merchant: "x", mcc: "6513", amountUsd: 1 })).toMatchObject({ code: "E_VENUE_PERMISSION", native: { status: 403 } });
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
  const chase = acct(bankAccount(seeds.chase).account);
  const ondo = acct(ondoAccount(seeds.ondo, clock).account);
  const base = { openness, now, dailyOutUsd: 0 };
  const trade: Intent = { kind: "trade", symbol: "BTCUSDT", side: "sell", qty: 0.05 };
  it("open: in-scope writes pass with no card; a move to a stranger is a card; the blocklist refuses", () => {
    expect(evaluate({ ...base, intent: trade, account: bin })).toMatchObject({ ok: true, card: null, usd: 3107.5 });
    expect(evaluate({ ...base, intent: { kind: "move", asset: "USDC", amount: 300, to: COLD }, account: ondo })).toMatchObject({ ok: true, card: null });
    expect(evaluate({ ...base, intent: { kind: "move", asset: "USDC", amount: 300, to: "0x7a11…stranger" }, account: ondo })).toMatchObject({ ok: true, card: { reason: expect.stringContaining("从没用过") } });
    expect(evaluate({ ...base, intent: { kind: "move", asset: "USDC", amount: 300, to: "0xd759…attacker" }, account: ondo })).toMatchObject({ code: "E_WALLET_BLOCKLIST" });
  });
  it("the credential's scope comes before the user's reach: E_WALLET_SCOPE, then E_WALLET_REACH, then revoked, then session", () => {
    expect(evaluate({ ...base, intent: { kind: "move", asset: "BTC", amount: 0.1, to: COLD }, account: bin })).toMatchObject({ code: "E_WALLET_SCOPE", detail: { enforcedBy: "venue" } });
    expect(evaluate({ ...base, intent: { kind: "pay", merchant: "x", mcc: "6513", amountUsd: 1 }, account: chase })).toMatchObject({ code: "E_WALLET_SCOPE" });
    expect(evaluate({ ...base, intent: { kind: "move", asset: "USDC", amount: 1, to: COLD }, account: ondo, openness: { ...openness, reach: { ondo: ["subscribe", "redeem"] } } })).toMatchObject({ code: "E_WALLET_REACH" });
    expect(evaluate({ ...base, intent: trade, account: bin, openness: { ...openness, revoked: ["binance"] } })).toMatchObject({ code: "E_WALLET_ACCOUNT_REVOKED" });
    expect(evaluate({ ...base, intent: trade, account: bin, openness: { ...openness, sessionExpiresAt: now } })).toMatchObject({ code: "E_WALLET_SESSION_EXPIRED" });
  });
  it("guard: a card above the free allowance, none below, a hard daily cap", () => {
    const guard = { ...openness, mode: "guard" as const };
    expect(evaluate({ ...base, openness: guard, intent: trade, account: bin })).toMatchObject({ ok: true, card: { reason: expect.stringContaining("免审") } });
    expect(evaluate({ ...base, openness: guard, intent: { kind: "trade", symbol: "BTCUSDT", side: "sell", qty: 0.005 }, account: bin })).toMatchObject({ ok: true, card: null });
    expect(evaluate({ ...base, openness: guard, intent: trade, account: bin, dailyOutUsd: 38000 })).toMatchObject({ code: "E_WALLET_DAILY_CAP" });
  });
  it("guard: a slice of a split order is judged by the whole order — splitting cannot slip it under the allowance", () => {
    const guard = { ...openness, mode: "guard" as const };
    const slice: Intent = { kind: "trade", symbol: "ETHUSDT", side: "sell", qty: 0.15 };
    expect(evaluate({ ...base, openness: guard, intent: slice, account: bin })).toMatchObject({ ok: true, card: null, usd: 366 });
    expect(evaluate({ ...base, openness: guard, intent: slice, account: bin, orderUsd: 1464 })).toMatchObject({ ok: true, usd: 366, card: { reason: expect.stringContaining("拆单合并计") } });
    expect(evaluate({ ...base, intent: slice, account: bin, orderUsd: 1464 })).toMatchObject({ ok: true, card: null });
  });
  it("effectiveReach is scope ∩ reach, and only `read` once revoked", () => {
    expect(effectiveReach(bin, openness)).toEqual(["read", "trade"]);
    expect(effectiveReach(ondo, { ...openness, reach: { ondo: ["subscribe"] } })).toEqual(["read", "subscribe"]);
    expect(effectiveReach(ondo, { ...openness, revoked: ["ondo"] })).toEqual(["read"]);
  });
  it("compileOpenness gives every account its three layers", () => {
    const rows = compileOpenness([bin, chase, ondo], openness);
    expect(rows.map((r) => r.layer1.enforcedBy)).toEqual(["venue", "bank", "issuer"]);
    expect(rows[0]!.layer2.walletKeeps[0]).toMatch(/不发卡/);
    expect(rows[2]!.layer2.walletKeeps[0]).toMatch(/陌生地址/);
    expect(rows[1]!.layer3).toMatch(/403/);
  });
});

describe("aggregate", () => {
  it("sums what the user owns, by class and by account, and shows credit without summing it", async () => {
    const adapters = [binance(), okxAccount(seeds.okx), ondoAccount(seeds.ondo, clock), mastercardAccount(seeds.mastercard, clock), bankAccount(seeds.chase)];
    const holdings = (await Promise.all(adapters.map((a) => a.read()))).flat();
    const agg = aggregate(adapters.map((a) => a.account), holdings);
    const expected = 0.3 * 62150 + 2 * 2440 + 5000 + 1.5 * 2440 + 2500 + 18 * 110.42 + 3000 + 12400;
    expect(agg.totalUsd).toBeCloseTo(expected, 2);
    expect(agg.creditAvailableUsd).toBe(4300);
    expect(agg.byClass.map((c) => c.class)).toEqual(["cash", "stable", "crypto", "rwa"]);
    expect(agg.byAccount.find((a) => a.account === "mastercard")?.usd).toBe(0);
    expect(agg.byClass.reduce((s, c) => s + c.pct, 0)).toBeGreaterThanOrEqual(98);
  });
});

async function world() {
  const adapters = [binance(), okxAccount(seeds.okx), metamaskSimAccount(seeds.metamask, clock), ondoAccount(seeds.ondo, clock), mastercardAccount(seeds.mastercard, clock), bankAccount(seeds.chase)];
  const accounts = await Promise.all(adapters.map(async (a) => ({ id: a.account.id, name: a.account.name, kind: a.account.kind, chain: a.account.chain, reach: a.account.scope.can, revoked: false, holdings: await a.read() })));
  return { accounts, liquidity: liquidity(accounts), ladder: ladder(accounts) };
}
const ctxOf = async () => ({ cryptoPct: 51, ondoAddress: "0x5a1e…kyc", ...(await world()) });

describe("liquidity: amount × time × cost", () => {
  it("tells mobile liquidity from stuck, with the reason", async () => {
    const { accounts, liquidity: L } = await world();
    expect(L.mobileUsd).toBe(4200);
    expect(L.mobile.map((s) => `${s.account}:${s.chain}`)).toEqual(["metamask:Base", "ondo:Ethereum"]);
    expect(L.stuckUsd).toBe(19900);
    expect(Object.fromEntries(L.stuck.map((s) => [s.account, s.why]))).toEqual({ binance: "key 没开提币", okx: "key 没开提币", chase: "只读，转账不经 agent" });
    const off = liquidity(accounts.map((v) => (v.id === "metamask" ? { ...v, revoked: true, reach: ["read" as const] } : v)));
    expect(off.stuck.find((s) => s.account === "metamask")?.why).toBe("你关了");
  });
  it("quotes three bridges: the cheapest open one depends on size, and the fastest is a different answer", () => {
    expect(bridgeQuotes(1200).map((q) => [q.id, q.feeUsd, q.etaSec])).toEqual([["lp", 1, 120], ["cctp", 1.2, 900], ["canonical", 2.5, 604800]]);
    expect(pick(bridgeQuotes(1200))?.id).toBe("lp");
    expect(pick(bridgeQuotes(50000))?.id).toBe("cctp");
    expect(pick(bridgeQuotes(50000), "speed")?.id).toBe("lp");
    expect(pick(bridgeQuotes(1200).map((q) => ({ ...q, open: false })))).toBeUndefined();
    expect([etaLabel(0), etaLabel(120), etaLabel(86400), etaLabel(604800)]).toEqual(["即时", "~2 分钟", "T+1", "7 天"]);
  });
  it("builds the ladder to the hub — now, minutes, T+1, closed — and a closed route keeps its quote", async () => {
    const { ladder: L } = await world();
    expect(L.rows.map((r) => [r.bucket, r.usd])).toEqual([["now", 3000], ["minutes", 1200], ["t1", 1987.56], ["closed", 19900]]);
    expect(L.rows[1]!.items[0]).toMatchObject({ account: "metamask", chain: "Base", open: true, route: { id: "lp", feeUsd: 1, etaSec: 120 } });
    expect(L.rows[2]!.items[0]).toMatchObject({ account: "ondo", asset: "OUSG", route: { id: "redeem", etaSec: 86400, feeUsd: 0 } });
    expect(Object.fromEntries(L.rows[3]!.items.map((it) => [it.account, [it.open, it.route.why, it.route.feeUsd, it.route.etaSec]]))).toEqual({ binance: [false, "key 没开提币", 9.5, 600], okx: [false, "key 没开提币", 7, 600], chase: [false, "只读，转账不经 agent", 0, 86400] });
    expect([L.openUsd, L.closedUsd]).toEqual([6187.56, 19900]);
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
    expect(fillAt("dex:Base", "ETH", "sell", 1)).toMatchObject({ kind: "dex", name: "DEX（Base）", symbol: "ETH-USDC", quote: "USDC", chain: "Base", price: 2439.94, grossUsd: 2439.94, feeUsd: 1.27, netUsd: 2438.67, gasUsd: 0.05, route: [{ pool: "base:aero", dex: "Aerodrome", qty: 1 }] });
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
    expect(eth.map((q) => [q.venue, q.account, q.ok, q.why, q.have])).toEqual([["binance", "binance", true, undefined, 2], ["okx", "okx", true, undefined, 1.5], ["dex:Base", "metamask", true, undefined, 1], ["dex:Ethereum", "metamask", false, "只有 0.15 ETH", 0.15]]);
    expect(eth.map((q) => q.netUsd)).toEqual([2437.44, 2439.02, 2438.67, 2434.53]);
    expect(bestVenue(eth, "sell")).toMatchObject({ venue: "okx", netUsd: 2439.02 });
    const btc = venueQuotes("BTC", "sell", 0.05, accounts);
    expect(btc.map((q) => [q.venue, q.ok, q.why])).toEqual([["binance", true, undefined], ["okx", false, "没有 BTC"], ["dex", false, "链上没有 BTC"]]);
    const small = venueQuotes("ETH", "sell", 0.1, accounts);
    expect(small.find((q) => q.venue === "dex:Ethereum")).toMatchObject({ ok: true });
    expect(bestVenue(small, "sell")?.venue).toBe("okx");
    const buy = venueQuotes("ETH", "buy", 0.5, accounts);
    expect(buy.map((q) => [q.venue, q.why])).toEqual([["binance", undefined], ["okx", undefined], ["dex:Base", "USDC 不够"]]);
    expect(bestVenue(buy, "buy")?.venue).toBe("binance");
    // a small buy: the DEX wins on merit — a 5 bps pool and cents of gas against a 10 bps taker fee
    expect(bestVenue(venueQuotes("ETH", "buy", 0.4, accounts), "buy")).toMatchObject({ venue: "dex:Base", netUsd: 976.47 });
    const off = accounts.map((a) => (a.id === "okx" ? { ...a, revoked: true, reach: ["read" as const] } : a));
    expect(venueQuotes("ETH", "sell", 1, off).find((q) => q.venue === "okx")).toMatchObject({ ok: false, why: "你关了" });
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
    expect(p.passed).toEqual([{ venue: "dex:Ethereum", name: "DEX（Ethereum）", have: 0.15, deltaUsd: -3.83, gasUsd: 4 }]);
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
    const p = plan("申购 5000 OUSG", await ctxOf());
    expect(p.steps.map((s) => [s.account, s.intent.kind, s.needs])).toEqual([["ondo", "subscribe", undefined], ["metamask", "move", undefined], ["ondo", "subscribe", 1]]);
    expect(p.steps[1]!.intent).toMatchObject({ kind: "move", asset: "USDC", amount: 1200, to: "0x5a1e…kyc", fromChainId: 8453, chainId: 1, via: "lp" });
    expect(p.steps[1]!.compare).toBe("比过：CCTP（原生 USDC） $1.20 · ~15 分钟；官方桥 $2.50 · 7 天；经 Binance 中转 关着（key 没开提币）；经 OKX 中转 关着（key 没开提币）");
    expect(p.steps[2]!.intent).toMatchObject({ amountUsd: 1199 });
    expect(p.narration).toContain("走流动性桥到 Ethereum（费 $1.00 · ~2 分钟）");
    expect(p.narration).toContain("还差 $801");
    expect(p.notes?.[0]).toContain("给 Binance 的 key 开提币，~10 分钟 · 约 $5.30");
    expect(plan("申购 1000 OUSG", await ctxOf()).steps.length).toBe(1);
  });
  it("uses live bridge quotes when the wallet can give them, and says so when it cannot", async () => {
    const { plan } = await import("../../src/portfolio/agent.ts");
    const ctx = await ctxOf();
    const live = plan("申购 5000 OUSG", { ...ctx, liveBridge: { quotes: [{ id: "mm:0", label: "Across", feeUsd: 0.62, etaSec: 30, open: true, source: "mm" }] } });
    expect(live.steps[1]!.intent).toMatchObject({ via: "mm:0" });
    expect(live.steps[2]!.intent).toMatchObject({ amountUsd: 1199.38 });
    const failed = plan("申购 5000 OUSG", { ...ctx, liveBridge: { error: "INSUFFICIENT_FUNDS" } });
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
    const p = plan("卖 1 ETH", await ctxOf());
    expect(p.steps).toHaveLength(1);
    expect(p.steps[0]).toMatchObject({ account: "okx", intent: { kind: "trade", symbol: "ETH-USDT", side: "sell", qty: 1 } });
    expect(p.steps[0]!.compare).toBe("比过：DEX（Base）净得 $2,438.67（少 $0.35）；Binance 净得 $2,437.44（少 $1.58）；DEX（Ethereum）只有 0.15 ETH");
    expect(p.narration).toBe("卖出 1 ETH：4 个场所比过，OKX 净得最多（$2,439.02），一处接得下，不用拆。");
    expect(p.order?.after[0]).toContain("留在 OKX");
    expect(plan("卖 0.05 BTC", await ctxOf()).steps[0]).toMatchObject({ account: "binance", compare: "比过：OKX 没有 BTC；DEX 链上没有 BTC" });
    const none = plan("卖 5 BTC", await ctxOf());
    expect(none.steps).toEqual([]);
    expect(none.narration).toContain("所有场所加起来只有 0.3 BTC");
    expect(plan("买 0.5 ETH", await ctxOf()).narration).toContain("只省 $0.69，不到 $1.00");
  });
  it("splits an order no venue can take alone: one step per slice, the split bar, what it left alone, and where the proceeds end up", async () => {
    const { accounts } = await world();
    const o = orderPlan("ETH", "sell", 3, accounts);
    expect(o.title).toBe("卖出 3 ETH");
    expect(o.narration).toBe("卖出 3 ETH：没有一个场所接得下（Binance 2 · OKX 1.5 · DEX（Base）1 · DEX（Ethereum）0.15）。拆成 3 片，均价 2,440.44，净得 $7,315.91。");
    expect(o.steps.map((s) => [s.account, s.say])).toEqual([["okx", "卖出 1.5 ETH · OKX"], ["metamask", "卖出 1 ETH · DEX（Base）"], ["binance", "卖出 0.5 ETH · Binance"]]);
    expect(o.steps[1]!.intent).toEqual({ kind: "trade", symbol: "ETH-USDC", side: "sell", qty: 1, chainId: 8453 });
    expect(o.parts).toEqual([{ label: "OKX 1.5", pct: 50, kind: "cex" }, { label: "DEX（Base）1", pct: 33, kind: "dex" }, { label: "Binance 0.5", pct: 17, kind: "cex" }]);
    expect(o.notes).toEqual(["比过：DEX（Ethereum）的 0.15 ETH 没动：一笔 swap 的 gas $4.00，用上它反而少 $3.83。"]);
    expect(o.after).toEqual(["卖出的钱：USDT 留在 OKX、Binance（key 提不出来）；DEX 那片的 USDC 在 Base 上，随时能动。"]);
    const two = orderPlan("ETH", "sell", 2, accounts);
    expect(two.narration).toBe("卖出 2 ETH：一处接得下的最好是 Binance（净得 $4,874.86）；拆成 2 片净得 $4,877.84，多 $2.98。");
    expect(quoteView(o)).toMatchObject({ order: "卖出 3 ETH", feasible: true, netUsd: 7315.91, slices: [{ venue: "okx", qty: 1.5 }, { venue: "dex:Base", chain: "Base", gasUsd: 0.05 }, { venue: "binance", qty: 0.5 }], leftOut: [{ venue: "dex:Ethereum" }] });
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
    const r3 = await svc.execute("mastercard", { kind: "pay", merchant: "Anthropic", mcc: "7372", amountUsd: 120 });
    for (const r of [r1, r2, r3]) expect(isRefusal(r) || isPending(r)).toBe(false);
    expect(svc.counters).toMatchObject({ writes: 3, cards: 0 });

    expect(await svc.execute("binance", { kind: "move", asset: "BTC", amount: 0.1, to: COLD })).toMatchObject({ code: "E_WALLET_SCOPE" });
    expect(await svc.bypass("binance", { kind: "move", asset: "BTC", amount: 0.1, to: COLD })).toMatchObject({ code: "E_VENUE_PERMISSION", native: { code: -2015 } });
    expect(await svc.execute("mastercard", { kind: "pay", merchant: "Casino", mcc: "7995", amountUsd: 900 })).toMatchObject({ code: "E_VENUE_CARD_DECLINED" });

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
    expect(await svc.execute("mastercard", { kind: "pay", merchant: "GitHub", mcc: "7372", amountUsd: 40 })).toMatchObject({ ok: true, status: "authorized" });

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
    expect(plan("再平衡", ctx).steps.map((s) => [s.account, s.intent.kind])).toEqual([["okx", "trade"], ["ondo", "subscribe"]]);
    expect(plan("付 200 给 GitHub", ctx).steps[0]?.intent).toEqual({ kind: "pay", merchant: "GitHub", mcc: "7372", amountUsd: 200 });
    expect(plan("申购 1000 OUSG", ctx).steps[0]?.intent).toMatchObject({ kind: "subscribe", amountUsd: 1000 });
    expect(plan("提到冷钱包", ctx).steps[0]?.intent).toMatchObject({ kind: "move", asset: "BTC" });
    expect(plan("转给新地址", ctx).steps[0]?.intent).toMatchObject({ kind: "move", to: "0x7a11…stranger" });
    expect(plan("买 0.5 ETH", ctx).steps[0]).toMatchObject({ account: "binance", intent: { side: "buy", qty: 0.5 } });
    expect(plan("收紧到 Guard", ctx)).toMatchObject({ mode: "guard", steps: [] });
    expect(plan("今天天气", ctx).steps).toEqual([]);
  });

  it("flies in plain words: numbered flights, fills with what they netted and what they beat, a refusal without codes, one card, and the decision as one more leg", async () => {
    const { AgentSession } = await import("../../src/portfolio/agent.ts");
    const { agentCode } = await import("../../src/portfolio/accounts.ts");
    const svc = await PortfolioService.create({ home, now: tick });
    const agent = new AgentSession(svc);
    const f1 = await agent.say("再平衡");
    expect(f1.no).toBe("PM-0001");
    expect(f1.legs.map((l) => l.mark)).toEqual(["note", "ok", "ok", "note"]);
    expect(f1.legs[1]).toMatchObject({ account: "okx" });
    expect(f1.legs[1]?.text).toBe("卖出 1 ETH · OKX @ 2,440.97 · 净得 $2,439.02");
    expect(f1.legs[1]?.compare).toContain("Binance 净得 $2,437.44");
    expect(f1.legs[3]?.text).toContain("困在那里");
    const f2 = await agent.say("提到冷钱包");
    expect(f2.legs[1]).toMatchObject({ mark: "no" });
    expect(f2.legs[1]?.text).toMatch(/做不了「转出」/);
    expect(f2.legs[1]?.text).not.toMatch(/E_WALLET/);
    const f3 = await agent.say("转给新地址");
    expect(f3.legs[1]).toMatchObject({ mark: "wait" });
    const id = f3.legs[1]?.approvalId;
    expect(id).toBeTruthy();
    expect(await svc.decide(id!, "reject")).toMatchObject({ code: "E_CARD_REJECTED" });
    expect(f3.legs[2]).toMatchObject({ mark: "no", text: "你拒了，没动" });
    expect(await svc.decide(id!, "approve")).toMatchObject({ code: "E_CARD_NOT_GRANTED" });
    const f4 = await agent.say("收紧到 Guard");
    expect(svc.policy().mode).toBe("guard");
    expect(f4.legs[1]?.text).toBe("已收紧到 Guard");
    await agent.say("放开到 Open");
    const f6 = await agent.say("申购 5000 OUSG");
    expect(f6.no).toBe("PM-0006");
    const ok6 = f6.legs.filter((l) => l.mark === "ok");
    expect(ok6.map((l) => l.text.slice(0, 2))).toEqual(["申购", "跨链", "申购"]);
    expect(ok6[1]?.text).toBe("跨链 $1,200 USDC：Base → Ethereum → Ondo 地址 · 流动性桥 · 费 $1.00 · ~2 分钟");
    expect(ok6[1]?.compare).toContain("CCTP");
    expect(ok6[2]?.usd).toBe(1199);
    expect(f6.legs[0]?.text).toContain("还差");
    expect((await svc.read("ondo")).find((h) => h.asset === "USDC")).toBeUndefined();
    expect(svc.rows().find((r) => r.kind === "funding")).toMatchObject({ venue: "ondo", notionalUsd: 1199, flight: "PM-0006" });
    const mcp = await svc.execute("mastercard", { kind: "pay", merchant: "Anthropic", mcc: "7372", amountUsd: 20 }, { id: "claude-code", name: "claude-code", code: agentCode("claude-code") });
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
    const f = await new AgentSession(svc).say("卖 3 ETH");
    expect(f.legs.map((l) => l.mark)).toEqual(["note", "ok", "ok", "ok", "note", "note"]);
    expect(f.legs[0]?.parts?.map((p) => `${p.label}:${p.kind}`)).toEqual(["OKX 1.5:cex", "DEX（Base）1:dex", "Binance 0.5:cex"]);
    expect(f.legs[1]).toMatchObject({ account: "okx", text: "卖出 1.5 ETH · OKX @ 2,440.97 · 净得 $3,658.52" });
    expect(f.legs[2]).toMatchObject({ account: "metamask", text: "卖出 1 ETH · DEX（Base） @ 2,439.94 · 净得 $2,438.67", compare: "路由：Aerodrome · gas $0.05" });
    expect(f.legs[3]).toMatchObject({ account: "binance", text: "卖出 0.5 ETH · Binance @ 2,439.88 · 净得 $1,218.72" });
    expect(f.legs[4]?.text).toContain("gas $4.00");
    expect(f.legs[5]?.text).toContain("随时能动");
    expect([await eth(svc, "okx"), await eth(svc, "binance"), await eth(svc, "metamask")]).toEqual([0, 1.5, 0.15]);
    expect((await svc.read("metamask")).find((h) => h.asset === "USDC" && h.note === "Base")?.amount).toBe(3638.67);
    const o = await svc.overview();
    expect(o.liquidity.mobile.find((s) => s.account === "metamask")?.usd).toBe(3638.67);
    expect(o.counters).toMatchObject({ writes: 3, cards: 0, refusals: 0 });
    expect(svc.rows().filter((r) => r.kind === "venue" && r.flight === f.no).map((r) => r.venue)).toEqual(["okx", "metamask", "binance"]);
    // nothing left that can take 3 ETH: the agent says how much there is instead of selling something else
    const again = await new AgentSession(svc).say("卖 3 ETH");
    expect(again.legs.map((l) => l.mark)).toEqual(["note"]);
    expect(again.legs[0]?.text).toContain("所有场所加起来只有 1.65 ETH");
  });

  it("guard: the whole order is ONE card; nothing moves until it is answered; one yes fills every slice, one no moves nothing", async () => {
    const { AgentSession } = await import("../../src/portfolio/agent.ts");
    const svc = await PortfolioService.create({ home, now: tick });
    svc.setMode("guard");
    const agent = new AgentSession(svc);
    const f = await agent.say("卖 3 ETH");
    expect(f.legs.map((l) => l.mark)).toEqual(["note", "wait", "note"]);
    expect(f.legs[1]).toMatchObject({ text: "卖出 3 ETH（3 片）：超过免审额度，需要你点一下", usd: 7320 });
    expect(svc.counters).toMatchObject({ cards: 1, writes: 0 });
    const ap = (await svc.overview()).approvals[0]!;
    expect(ap).toMatchObject({ status: "pending", usd: 7320, title: "卖出 3 ETH（3 片）", reason: expect.stringContaining("拆单合并计") });
    expect(ap.batch?.map((s) => s.account)).toEqual(["okx", "metamask", "binance"]);
    expect([await eth(svc, "okx"), await eth(svc, "binance"), await eth(svc, "metamask")]).toEqual([1.5, 2, 1.15]);
    expect(await svc.decide(ap.id, "approve")).toMatchObject({ ok: true, status: "filled", account: "okx+metamask+binance", usd: 7321.33 });
    expect(f.legs.slice(3).map((l) => [l.mark, l.text.split(" @")[0]])).toEqual([["ok", "你批了 · 卖出 1.5 ETH · OKX"], ["ok", "你批了 · 卖出 1 ETH · DEX（Base）"], ["ok", "你批了 · 卖出 0.5 ETH · Binance"], ["note", "卖出的钱：USDT 留在 OKX、Binance（key 提不出来）；DEX 那片的 USDC 在 Base 上，随时能动。"]]);
    expect(f.legs[4]?.compare).toBe("路由：Aerodrome · gas $0.05");
    expect([await eth(svc, "okx"), await eth(svc, "binance"), await eth(svc, "metamask")]).toEqual([0, 1.5, 0.15]);
    expect(svc.counters).toMatchObject({ cards: 1, writes: 3 });
    expect(await svc.decide(ap.id, "approve")).toMatchObject({ code: "E_CARD_NOT_GRANTED" });
    const g = await agent.say("卖 1.6 ETH");
    const id = g.legs.find((l) => l.approvalId)?.approvalId;
    expect(g.legs.find((l) => l.mark === "wait")?.text).toContain("2 片");
    expect(await svc.decide(id!, "reject")).toMatchObject({ code: "E_CARD_REJECTED" });
    expect(g.legs.at(-1)).toMatchObject({ mark: "no", text: "你拒了，没动" });
    expect(g.legs.some((l) => l.text.includes("卖出的钱"))).toBe(false);
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
    expect(r.flight.legs.at(-1)?.text).toContain("随时能动");
    expect(svc.rows().filter((x) => x.kind === "venue").every((x) => x.flight === "CC-0001" && x.agent === "claude-code")).toBe(true);
    const none = await svc.order("ETH", "sell", 9, { id: "claude-code", name: "claude-code", code: "CC" });
    expect(none.outcomes).toEqual([]);
    expect(none.flight.legs.map((l) => l.mark)).toEqual(["note"]);
    // a buy on the DEX: the wallet has USDC on Base again, so the pool route wins a small order on merit
    const buy = await svc.order("ETH", "buy", 0.4);
    expect(buy.plan.split.slices.map((s) => s.venue)).toEqual(["dex:Base"]);
    expect(buy.flight.legs[1]).toMatchObject({ mark: "ok", account: "metamask", text: "买入 0.4 ETH · DEX（Base） @ 2,439.82 · 共付 $976.47" });
    expect(buy.flight.legs[1]?.compare).toBe("路由：Uniswap v3 0.05% · gas $0.05；比过：Binance 共付 $977.03（多 $0.56）；OKX 共付 $977.37（多 $0.90）");
  });
});
