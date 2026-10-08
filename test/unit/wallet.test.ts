import { describe, expect, it } from "vitest";
import { CATALOG } from "../../src/wallet/catalog.ts";
import { buildOverview, floatsOf } from "../../src/wallet/overview.ts";
import { compilePolicy, dailyOutUsd, evaluateFund, evaluateRecall, grantsOf, parsePolicy } from "../../src/wallet/policy.ts";

const policy = parsePolicy({ floats: { binance: 3000, hyperliquid: 3000, polymarket: 1000, ondo: 2000, xstocks: 1000, solana: 500 }, totalExposureCapUsd: 6000, dailyCapUsd: 5000, withdrawWhitelist: ["wallet-main"], sessionExpiresAt: "2026-10-09T00:00:00Z" });
const now = "2026-10-02T15:00:00.000Z";
const balances = { USDT: 4000, USDC: 6000, "USDC.e": 1000, SOL: 0 };
const outs = (xs: Array<[string, number]>) => xs.map(([venue, amount], i) => ({ id: `t${i}`, direction: "out" as const, venue, asset: "USDT", amount, at: now }));
const floatsAfter = (xs: Array<[string, number]>) => floatsOf(policy, outs(xs));

describe("connector catalog", () => {
  it("covers CEX, DEX perps, DEX spot, prediction markets, RWA and a broker in one shape", () => {
    const kinds = new Set(CATALOG.map((c) => c.kind));
    expect([...kinds].sort()).toEqual(["broker", "cex", "dex-perp", "dex-spot", "prediction", "rwa"]);
    expect(CATALOG.filter((c) => c.kind === "prediction").map((c) => c.id)).toEqual(["polymarket", "kalshi", "polymarket-us"]);
    expect(CATALOG.filter((c) => c.kind === "rwa").map((c) => c.id)).toEqual(["ondo", "xstocks", "buidl", "robinhood-stocks", "centrifuge"]);
    expect(new Set(CATALOG.map((c) => c.id)).size).toBe(CATALOG.length);
  });
  it("marks exactly the four demo seats as mounted", () => {
    expect(CATALOG.filter((c) => c.seatMounted).map((c) => c.id).sort()).toEqual(["alpaca", "binance", "hyperliquid", "solana"]);
  });
  it("names the protocol allowlist for every delegation-shaped venue (MetaMask blueprint)", () => {
    for (const c of CATALOG.filter((c) => c.keyModel === "delegation" || c.keyModel === "clob-key+delegation")) expect(c.targets?.length).toBeGreaterThan(0);
  });
});

describe("compilePolicy", () => {
  const rows = compilePolicy(policy);
  const row = (v: string) => rows.find((r) => r.venue === v)!;
  it("gives every connector a native restriction and names who enforces it", () => {
    expect(rows.length).toBe(CATALOG.length);
    for (const r of rows) expect(r.restrictions.length).toBeGreaterThan(0);
    expect(row("binance").enforcedBy).toBe("venue");
    expect(row("hyperliquid").restrictions.join(" ")).toContain("valid_until");
    expect(row("solana").enforcedBy).toBe("signer");
    expect(row("kalshi").restrictions.join(" ")).toContain("ACH");
    expect(row("alpaca").enforcedBy).toBe("seat");
  });
  it("compiles on-chain venues to a delegation with caveats the chain enforces", () => {
    expect(row("uniswap").enforcedBy).toBe("chain");
    expect(row("uniswap").restrictions.join(" ")).toContain("Universal Router");
    expect(row("polymarket").enforcedBy).toBe("chain");
    expect(row("polymarket").restrictions.join(" ")).toContain("CTF Exchange");
    expect(row("gmx").restrictions.join(" ")).toContain("revoke");
  });
  it("adds the issuer's transfer restrictions on top for RWA", () => {
    expect(row("ondo").enforcedBy).toBe("issuer");
    expect(row("ondo").restrictions.join(" ")).toContain("KYC");
    expect(row("xstocks").enforcedBy).toBe("issuer");
    expect(row("buidl").restrictions.join(" ")).toContain("Securitize");
  });
  it("keeps float, exposure and the daily cap on the wallet side, where no venue can enforce them", () => {
    expect(row("binance").walletSide).toEqual(["float ≤ $3000", "总敞口 ≤ $6000", "$5000 / 日"]);
    expect(row("okx").walletSide[0]).toMatch(/没有 float/);
    expect(row("alpaca").walletSide[0]).toMatch(/法币/);
  });
});

describe("grantsOf", () => {
  it("lists one grant per connected venue with scope, cap, used, expiry, revoked", () => {
    const g = grantsOf(policy, floatsAfter([["binance", 2000], ["ondo", 500]]));
    expect(g.map((x) => x.venue)).toEqual(["binance", "hyperliquid", "solana", "polymarket", "ondo", "xstocks"]);
    expect(g.find((x) => x.venue === "ondo")).toMatchObject({ scope: "Ondo subscribe / redeem · DEX router", capUsd: 2000, usedUsd: 500, revoked: false, enforcedBy: "issuer" });
    expect(g.find((x) => x.venue === "binance")).toMatchObject({ scope: "API key：SPOT only", usedUsd: 2000, enforcedBy: "venue" });
  });
});

describe("evaluateFund", () => {
  const base = { balances, policy, now };
  it("funds a connected venue", () => {
    expect(evaluateFund({ ...base, venue: "binance", amountUsd: 2000, floats: floatsAfter([]) })).toMatchObject({ ok: true, asset: "USDT", rail: "cex-deposit" });
    expect(evaluateFund({ ...base, venue: "ondo", amountUsd: 1500, floats: floatsAfter([]) })).toMatchObject({ ok: true, asset: "USDC", rail: "onchain" });
  });
  it("refuses a venue that is in the catalog but has no float: E_WALLET_NOT_CONNECTED", () => {
    expect(evaluateFund({ ...base, venue: "okx", amountUsd: 100, floats: floatsAfter([]) })).toMatchObject({ ok: false, code: "E_WALLET_NOT_CONNECTED" });
    expect(evaluateFund({ ...base, venue: "buidl", amountUsd: 100, floats: floatsAfter([]) })).toMatchObject({ code: "E_WALLET_NOT_CONNECTED" });
  });
  it("refuses a fiat-rail venue the same way (Kalshi, Alpaca never pass through the wallet)", () => {
    expect(evaluateFund({ ...base, venue: "kalshi", amountUsd: 100, floats: floatsAfter([]) })).toMatchObject({ code: "E_WALLET_NOT_CONNECTED" });
    expect(evaluateFund({ ...base, venue: "alpaca", amountUsd: 100, floats: floatsAfter([]) })).toMatchObject({ code: "E_WALLET_NOT_CONNECTED" });
  });
  it("refuses an unknown venue, a bad amount, an expired session, a revoked grant", () => {
    expect(evaluateFund({ ...base, venue: "mtgox", amountUsd: 100, floats: floatsAfter([]) })).toMatchObject({ code: "E_WALLET_UNKNOWN_VENUE" });
    expect(evaluateFund({ ...base, venue: "binance", amountUsd: 0, floats: floatsAfter([]) })).toMatchObject({ code: "E_WALLET_BAD_AMOUNT" });
    expect(evaluateFund({ ...base, venue: "binance", amountUsd: 100, floats: floatsAfter([]), now: "2026-10-09T00:00:00.000Z" })).toMatchObject({ code: "E_WALLET_SESSION_EXPIRED" });
    expect(evaluateFund({ ...base, venue: "binance", amountUsd: 100, floats: floatsAfter([]), policy: { ...policy, revoked: ["binance"] } })).toMatchObject({ code: "E_WALLET_GRANT_REVOKED" });
  });
  it("checks the float cap, then the exposure cap, then the daily cap, then the balance", () => {
    expect(evaluateFund({ ...base, venue: "binance", amountUsd: 2500, floats: floatsAfter([["binance", 2000]]) })).toMatchObject({ code: "E_WALLET_FLOAT_CAP" });
    expect(evaluateFund({ ...base, venue: "hyperliquid", amountUsd: 2500, floats: floatsAfter([["binance", 3000], ["polymarket", 1000]]) })).toMatchObject({ code: "E_WALLET_EXPOSURE_CAP" });
    expect(evaluateFund({ ...base, venue: "hyperliquid", amountUsd: 1500, floats: floatsAfter([["binance", 2000], ["ondo", 2000]]), dailyOut: 4000 })).toMatchObject({ code: "E_WALLET_DAILY_CAP" });
    expect(evaluateFund({ ...base, venue: "polymarket", amountUsd: 1000, floats: floatsAfter([]), balances: { ...balances, "USDC.e": 500 } })).toMatchObject({ code: "E_WALLET_INSUFFICIENT" });
    expect(evaluateFund({ ...base, venue: "polymarket", amountUsd: 1000, floats: floatsAfter([]) })).toMatchObject({ ok: true, asset: "USDC.e", chain: "Polygon" });
  });
});

describe("evaluateRecall", () => {
  it("only lets a float come back to the whitelist, only what is there, and even after revocation", () => {
    const floats = floatsAfter([["binance", 2000]]);
    expect(evaluateRecall({ venue: "binance", amountUsd: 500, destination: "wallet-main", floats, policy, now })).toMatchObject({ ok: true, asset: "USDT" });
    expect(evaluateRecall({ venue: "binance", amountUsd: 500, destination: "0xattacker", floats, policy, now })).toMatchObject({ code: "E_VENUE_WITHDRAW_WHITELIST" });
    expect(evaluateRecall({ venue: "binance", amountUsd: 2500, destination: "wallet-main", floats, policy, now })).toMatchObject({ code: "E_WALLET_FLOAT_SHORT" });
    expect(evaluateRecall({ venue: "binance", amountUsd: 500, destination: "wallet-main", floats, policy: { ...policy, revoked: ["binance"], sessionExpiresAt: now }, now })).toMatchObject({ ok: true });
  });
});

describe("buildOverview", () => {
  it("sums exposure and the daily outflow, and marks connectors connected only when the wallet has a float for them", () => {
    const state = { address: "0xabc", agentKey: "0xagent", balances, transfers: [...outs([["binance", 2000]]), { id: "t9", direction: "out" as const, venue: "polymarket", asset: "USDC.e", amount: 400, at: "2026-10-01T10:00:00.000Z" }] };
    const o = buildOverview(state, policy, now);
    expect(o.exposure).toEqual({ used: 2400, cap: 6000, pct: 40 });
    expect(o.daily).toEqual({ used: 2000, cap: 5000, pct: 40 });
    expect(dailyOutUsd(state.transfers, now)).toBe(2000);
    expect(o.home.totalUsd).toBe(11000);
    expect(o.account).toEqual({ smartAccount: "0xabc", agentKey: "0xagent", mode: "guard", custody: "non-custodial" });
    const by = Object.fromEntries(o.connectors.map((c) => [c.id, c.status]));
    expect(by.binance).toBe("connected");
    expect(by.polymarket).toBe("connected");
    expect(by.ondo).toBe("connected");
    expect(by.okx).toBe("catalog");
    expect(by.kalshi).toBe("catalog");
    expect(by.alpaca).toBe("catalog");
    expect(o.grants.length).toBe(6);
    expect(o.session.expired).toBe(false);
  });
});
