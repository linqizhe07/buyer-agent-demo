import { describe, expect, it } from "vitest";
import { isRefusal, type Refusal } from "../../src/core/errors.ts";
import { exchangeEarner, krakenEarner, kucoinEarner, okxEarner, type EarnProduct, type LiveEarner } from "../../src/portfolio/live/earn.ts";
import type { ExchangeClient } from "../../src/portfolio/live/exchange.ts";
import { metamaskSource, MmError, type MmNotice, type RunMm } from "../../src/portfolio/live/metamask.ts";

/** EARN at the venues that have an interface for it, each in its own language, against stand-ins that answer in the shapes each documents:
 * mm 7.0.0's `mm earn` (its SDK's Vault and VaultPosition, LI.FI's earn API underneath), OKX's Simple Earn Flexible (API v5
 * finance/savings) and Kraken Earn (/0/private/Earn/*), both through the exchange library's implicit calls; Binance's Simple Earn Flexible
 * has a file of its own (live-earn-binance.test.ts), run through the real library. Nothing leaves the process;
 * MetaMask's own switch lives in an env object made per test, never in the shell. */
const WALLET = "0x00000000000000000000000000000000000000Aa";
const VAULT = "0x7BfA7C4f149E7415b73bdeDfe609237e29CBF34A";
const VAULT2 = "0x00000000000000000000000000000000000Ba5e5";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const HASH = `0x${"ab".repeat(32)}`;
const NOW = Date.parse("2026-10-05T14:00:00.000Z");
const ON = { PORTFOLIO_MM_WRITES: "1" };
const CLIENT = "0123456789abcdef0123456789abcdef";

interface Call {
  args: string[];
  timeoutMs?: number;
}
const commandOf = (args: string[]): string => args.slice(0, args[0] === "wallet" ? 3 : 2).join(" ");
function standIn(answers: Record<string, unknown>): { run: RunMm; calls: Call[] } {
  const calls: Call[] = [];
  const run: RunMm = async <T>(args: string[], opts?: { timeoutMs?: number }): Promise<T> => {
    calls.push({ args: [...args], ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) });
    // an answer is mm's data as it is (a list of vaults is a list); a function sees the argv
    const a = answers[commandOf(args)];
    const out = typeof a === "function" ? (a as (args: string[]) => unknown)(args) : a;
    if (out === undefined) throw new MmError({ code: "NOT_SET_UP", message: `not set up in this test: mm ${args.join(" ")}` });
    if (out instanceof Error) throw out;
    return out as T;
  };
  return { run, calls };
}
const fail = (code: string, message: string, hint?: string, notices: MmNotice[] = []) => new MmError({ code, message, ...(hint ? { hint } : {}) }, notices);
const ok = <T>(x: T | Refusal): T => {
  if (isRefusal(x)) throw new Error(`expected an answer, got ${x.code}: ${x.message}`);
  return x;
};
const refusal = (x: unknown): Refusal => {
  if (!isRefusal(x)) throw new Error(`expected a refusal, got ${JSON.stringify(x)}`);
  return x;
};

/** a vault of `mm earn markets`, as mm 7.0.0's LiFiEarnClient maps it (apy as a fraction, as LI.FI's earn API states it) */
const vault = (over: Record<string, unknown> = {}) => ({ address: VAULT, chainId: 8453, name: "Steakhouse USDC", protocol: { name: "morpho" }, underlyingTokens: [{ address: USDC_BASE, symbol: "USDC", decimals: 6 }], lpTokens: [{ address: VAULT, symbol: "steakUSDC", decimals: 18 }], apy: { base: 0.0534, reward: null, total: 0.0534 }, apy7d: 0.0538, apy30d: 0.0545, tvlUsd: 12_500_000, isTransactional: true, isRedeemable: true, ...over });
/** a row of `mm earn positions`: balanceNative in the asset's base units, as LI.FI's earn API gives it */
const position = (over: Record<string, unknown> = {}) => ({ chainId: 8453, vaultAddress: VAULT, protocolName: "morpho", asset: { address: VAULT, symbol: "steakUSDC", decimals: 18, name: "Steakhouse USDC" }, balanceUsd: 5000, balanceNative: "4901960784313725490196", ...over });
const SHOW = { address: WALLET, tradingMode: "guard", policyYaml: "rolling_24h: 50" };
const BALANCE = { currency: "usd", totalValue: "40", chains: [] };

async function mm(answers: Record<string, unknown>, env: Record<string, string | undefined> = ON, price?: (a: string) => Promise<number | undefined>): Promise<{ e: LiveEarner; calls: Call[]; answers: Record<string, unknown> }> {
  const all = { "wallet show": SHOW, "wallet balance": BALANCE, ...answers };
  const s = standIn(all);
  const opened = await metamaskSource({ venue: "metamask", label: "", run: s.run, env, now: () => NOW, ...(price ? { price } : {}) });
  if (isRefusal(opened)) throw new Error(opened.message);
  s.calls.splice(0);
  return { e: opened.source.earner!, calls: s.calls, answers: all };
}
const argvs = (calls: Call[]) => calls.map((c) => c.args);

describe("the MetaMask Agent Wallet's earn: LI.FI's vaults through mm earn", () => {
  it("lists the vaults that hold at least $1M, the highest yield first, one asset in and the same out, landing back in the wallet on the vault's chain", async () => {
    const x = await mm({ "earn markets": [vault(), vault({ address: VAULT2, chainId: 1, name: "LP of two", underlyingTokens: [{ symbol: "USDC" }, { symbol: "WETH" }] }), vault({ address: VAULT2, chainId: 42161, name: "WETH vault", underlyingTokens: [{ address: VAULT2, symbol: "WETH", decimals: 18 }], apy: { total: 0.021 } })] }, ON, async (a) => (a === "WETH" ? 3000 : undefined));
    const list = ok(await x.e.products());
    expect(argvs(x.calls)).toEqual([["earn", "markets", "--min-tvl", "1000000", "--sort", "apy", "--limit", "40", "--json"]]);
    expect(list.map((p) => p.id)).toEqual([`8453:${VAULT.toLowerCase()}`, `42161:${VAULT2.toLowerCase()}`]);
    expect(list[0]).toEqual<EarnProduct>({ id: `8453:${VAULT.toLowerCase()}`, asset: "USDC", name: "Steakhouse USDC · morpho", apy: 0.0534, rateKind: "apy", protocol: "morpho", chain: "Base", tvlUsd: 12_500_000, priceUsd: 1, lands: "your MetaMask Agent Wallet on Base", canSupply: true, canWithdraw: true, note: expect.stringContaining("through LI.FI") as unknown as string });
    expect(list[1]).toMatchObject({ asset: "WETH", chain: "Arbitrum", priceUsd: 3000, apy: 0.021 });
    // one asset: --token, never an argv element that could be read as a flag
    x.calls.splice(0);
    x.answers["earn markets"] = [vault()];
    ok(await x.e.products("USDC"));
    expect(x.calls[0]!.args).toEqual(["earn", "markets", "--token", "USDC", "--min-tvl", "1000000", "--sort", "apy", "--limit", "40", "--json"]);
    expect(refusal(await x.e.products("--yes")).code).toBe("E_ACCOUNT_BAD_ACTION");
  });

  it("one vault is read afresh on its chain; a vault mm no longer lists is still one money can come out of, where the wallet holds some", async () => {
    const x = await mm({ "earn markets": [vault()], "earn positions": [position({ vaultAddress: VAULT2 })] });
    const p = ok(await x.e.product(`8453:${VAULT}`));
    expect(x.calls[0]!.args).toEqual(["earn", "markets", "--chain-id", "8453", "--limit", "200", "--json"]);
    expect(p.canSupply).toBe(true);
    const gone = ok(await x.e.product(`8453:${VAULT2}`));
    expect([gone.canSupply, gone.canWithdraw, gone.asset, gone.lands]).toEqual([false, true, "steakUSDC", "your MetaMask Agent Wallet on Base"]);
    expect(refusal(await x.e.product(`1:${VAULT2}`)).code).toBe("E_VENUE_REJECTED");
    expect(refusal(await x.e.product("savings:USDT")).code).toBe("E_ACCOUNT_BAD_ACTION");
  });

  it("what the wallet holds in vaults: base units read as the asset's own, with LI.FI's dollars", async () => {
    const x = await mm({ "earn positions": [position(), position({ vaultAddress: VAULT2, asset: { address: USDC_BASE, symbol: "USDC", decimals: 6 }, balanceUsd: 1523.45, balanceNative: "1523450000" }), position({ balanceNative: "0" })] });
    const held = ok(await x.e.positions());
    expect(argvs(x.calls)).toEqual([["earn", "positions", "--json"]]);
    expect(held.map((h) => [h.product, h.asset, h.amount, h.usd])).toEqual([
      [`8453:${VAULT.toLowerCase()}`, "steakUSDC", 4901.9607843137255, 5000],
      [`8453:${VAULT2.toLowerCase()}`, "USDC", 1523.45, 1523.45],
    ]);
  });

  it("money in: mm earn supply --vault on the vault's own chain, from the wallet (never --from-chain-id); with MetaMask's switch off the command is said and nothing runs", async () => {
    const off = await mm({}, {});
    const p = { id: `8453:${VAULT.toLowerCase()}`, asset: "USDC", name: "Steakhouse USDC · morpho", lands: "your MetaMask Agent Wallet on Base", canSupply: true, canWithdraw: true };
    const r = refusal(await off.e.supply(p, 25, CLIENT));
    expect([r.code, (r.detail as { commands: string[] }).commands]).toEqual(["E_WALLET_LIVE_WRITES_OFF", [`mm earn supply --vault ${VAULT.toLowerCase()} --amount 25 --chain-id 8453 --wallet-timeout 600 --json`]]);
    expect(off.calls).toEqual([]);
    const x = await mm({ "earn supply": { hash: HASH, symbol: "USDC", chainId: 8453, vaultName: "Steakhouse USDC", protocol: "morpho", positionReflected: false, position: null } });
    const s = ok(await x.e.supply(p, 25, CLIENT));
    expect(x.calls).toEqual([{ args: ["earn", "supply", "--vault", VAULT.toLowerCase(), "--amount", "25", "--chain-id", "8453", "--wallet-timeout", "600", "--json"], timeoutMs: 660_000 }]);
    expect([s.ref, s.status]).toEqual([HASH, "done"]);
    // the same client id again is the same request: nothing runs twice
    expect(ok(await x.e.supply(p, 25, CLIENT)).ref).toBe(HASH);
    expect(x.calls).toHaveLength(1);
  });

  it("money out: mm earn withdraw --vault back to the wallet itself (it takes no destination); all of it with --all", async () => {
    const x = await mm({ "earn withdraw": { hash: HASH, symbol: "USDC", chainId: 8453, vaultName: "Steakhouse USDC", protocol: "morpho" } });
    const p = { id: `8453:${VAULT.toLowerCase()}`, asset: "USDC", name: "Steakhouse USDC", lands: "your MetaMask Agent Wallet on Base", canSupply: true, canWithdraw: true };
    ok(await x.e.withdraw(p, 10, CLIENT, false));
    ok(await x.e.withdraw(p, 10, "f".repeat(32), true));
    expect(argvs(x.calls)).toEqual([
      ["earn", "withdraw", "--vault", VAULT.toLowerCase(), "--chain-id", "8453", "--amount", "10", "--wallet-timeout", "600", "--json"],
      ["earn", "withdraw", "--vault", VAULT.toLowerCase(), "--chain-id", "8453", "--all", "--wallet-timeout", "600", "--json"],
    ]);
    expect(argvs(x.calls).flat().some((a) => /^--(to|destination|address|from-chain-id|from-token)$/.test(a))).toBe(false);
  });

  it("Guard asking the owner is a request on its way, never a refusal: mm wallet requests list says when it was approved, denied or lapsed", async () => {
    const x = await mm({ "earn supply": fail("EXECUTE_FAILED", "Wallet job awaiting MFA approval. Run mm wallet requests watch pl_42 to follow it.", "mm wallet requests watch pl_42"), "wallet requests list": { requests: [{ pollingId: "pl_42", status: "PENDING", intent: { summary: "Supply 25 USDC to morpho" } }] } });
    const p = { id: `8453:${VAULT.toLowerCase()}`, asset: "USDC", name: "Steakhouse USDC", lands: "your MetaMask Agent Wallet on Base", canSupply: true, canWithdraw: true };
    const s = ok(await x.e.supply(p, 25, CLIENT));
    expect([s.ref, s.status]).toEqual(["job:pl_42", "pending"]);
    expect(ok(await x.e.status!("job:pl_42", p, "supply")).status).toBe("pending");
    x.answers["wallet requests list"] = { requests: [{ pollingId: "pl_42", status: "BROADCAST", txHash: HASH, intent: { summary: "Supply 25 USDC to morpho" } }] };
    expect(ok(await x.e.status!("job:pl_42", p, "supply"))).toMatchObject({ ref: HASH, status: "done" });
    x.answers["wallet requests list"] = { requests: [{ pollingId: "pl_42", status: "DENIED" }] };
    expect(ok(await x.e.status!("job:pl_42", p, "supply")).status).toBe("rejected");
  });

  it("mm's refusals are the account's, in mm's words", async () => {
    const x = await mm({ "earn supply": fail("INSUFFICIENT_FUNDS", "Insufficient USDC balance."), "earn withdraw": fail("NOT_REDEEMABLE", "Vault does not support withdrawals") });
    const p = { id: `8453:${VAULT.toLowerCase()}`, asset: "USDC", name: "Steakhouse USDC", lands: "your MetaMask Agent Wallet on Base", canSupply: true, canWithdraw: true };
    expect(refusal(await x.e.supply(p, 25, CLIENT)).code).toBe("E_VENUE_INSUFFICIENT");
    const w = refusal(await x.e.withdraw(p, 5, CLIENT, false));
    expect([w.code, (w.native as { code: string; said: string }).code, (w.native as { said: string }).said]).toEqual(["E_VENUE_REJECTED", "NOT_REDEEMABLE", "Vault does not support withdrawals"]);
  });
});

// ---- the exchanges: OKX Simple Earn Flexible and Kraken Earn, through the exchange library ----------------------------------

const KEY = { apiKey: "made-up-key-0001", secret: "made-up-secret-0001", password: "made-up-pass-0001" };
/** an exchange client as the library would be, with only the implicit calls a test sets */
function client(id: string, calls: Array<[string, Record<string, unknown>]>, answers: Record<string, unknown>): ExchangeClient {
  const c: Record<string, unknown> = { id, fetchBalance: async () => ({}) };
  for (const [name, a] of Object.entries(answers)) {
    c[name] = async (params: Record<string, unknown>) => {
      calls.push([name, params]);
      const next = Array.isArray(a) ? (a.length > 1 ? a.shift() : a[0]) : a;
      if (next instanceof Error) throw next;
      return typeof next === "function" ? (next as (p: unknown) => unknown)(params) : next;
    };
  }
  return c as unknown as ExchangeClient;
}
const named = (name: string, message: string) => Object.assign(new Error(message), { name });

describe("OKX Simple Earn Flexible: finance/savings with the account's own key", () => {
  it("the products: each currency's lending rate (public), lent hourly and out at any time, landing back in the funding account", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const c = client("okx", calls, { publicGetFinanceSavingsLendingRateHistory: { code: "0", msg: "", data: [{ ccy: "USDT", amt: "0", rate: "0.0812", lendingRate: "0.0615", ts: "1791225581000" }] } });
    const e = okxEarner({ client: c, venue: "okx", name: "OKX", key: KEY, can: ["read", "trade"], now: () => NOW });
    const p = ok(await e.product("savings:USDT"));
    expect(calls).toEqual([["publicGetFinanceSavingsLendingRateHistory", { ccy: "USDT", limit: "1" }]]);
    expect(p).toMatchObject({ id: "savings:USDT", asset: "USDT", apy: 0.0615, rateKind: "apr", lockDays: 0, priceUsd: 1, lands: "your OKX funding account", canSupply: true, canWithdraw: true });
    expect(e.can).toBe(true);
    expect(refusal(await e.product("USDT")).code).toBe("E_ACCOUNT_BAD_ACTION");
    // a key that may only read: OKX's Trade permission is what purchase and redemption need
    const readOnly = okxEarner({ client: c, venue: "okx", name: "OKX", key: KEY, can: ["read"], now: () => NOW });
    expect([readOnly.can, readOnly.whyNot]).toEqual([false, "this OKX key may only read: Simple Earn's purchase and redemption need its Trade permission (set on the key at OKX)"]);
  });

  it("what is lent, and earned; money in (purchase) and out (redempt) with no rate and no destination, once per client id", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const c = client("okx", calls, {
      privateGetFinanceSavingsBalance: { code: "0", data: [{ ccy: "USDT", amt: "110.5", earnings: "0.5", rate: "0.01", loanAmt: "110", pendingAmt: "0.5", redemptAmt: "" }, { ccy: "BTC", amt: "0", earnings: "0" }] },
      privatePostFinanceSavingsPurchaseRedempt: (b: Record<string, unknown>) => ({ code: "0", data: [{ ccy: b.ccy, amt: b.amt, side: b.side, rate: "0.01" }] }),
    });
    const e = okxEarner({ client: c, venue: "okx", name: "OKX", key: KEY, can: ["read", "trade"], now: () => NOW });
    const held = ok(await e.positions());
    expect(held).toEqual([expect.objectContaining({ product: "savings:USDT", asset: "USDT", amount: 110.5, usd: 110.5, accrued: 0.5, accruedUsd: 0.5, pending: 0.5 })]);
    const p = { id: "savings:USDT", asset: "USDT", name: "USDT · Simple Earn Flexible", lands: "your OKX funding account", canSupply: true, canWithdraw: true };
    expect(ok(await e.supply(p, 25, CLIENT)).status).toBe("done");
    ok(await e.supply(p, 25, CLIENT));
    ok(await e.withdraw(p, 10, "f".repeat(32), false));
    expect(calls.filter(([n]) => n.startsWith("privatePost"))).toEqual([
      ["privatePostFinanceSavingsPurchaseRedempt", { ccy: "USDT", amt: "25", side: "purchase" }],
      ["privatePostFinanceSavingsPurchaseRedempt", { ccy: "USDT", amt: "10", side: "redempt" }],
    ]);
  });

  it("OKX's refusal in its own words, and what the owner can do about a permission; the key's values never in what is shown", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const c = client("okx", calls, { privatePostFinanceSavingsPurchaseRedempt: [named("PermissionDenied", `okx {"code":"50120","msg":"API key doesn't have permission (key ${KEY.apiKey})"}`)] });
    const e = okxEarner({ client: c, venue: "okx", name: "OKX", key: KEY, can: [], now: () => NOW });
    const r = refusal(await e.supply({ id: "savings:USDT", asset: "USDT", name: "x", lands: "y", canSupply: true, canWithdraw: true }, 5, CLIENT));
    expect(r.code).toBe("E_VENUE_PERMISSION");
    expect(r.message).toContain("Trade permission");
    expect(JSON.stringify(r)).not.toContain(KEY.apiKey);
    expect(e.can).toBe("unknown");
  });
});

describe("Kraken Earn: /0/private/Earn with the account's own key", () => {
  const STRATEGIES = { error: [], result: { items: [
    { id: "ESRFUO3-Q62XD-WIOIL7", asset: "DOT", lock_type: { type: "instant", payout_frequency: 604800 }, apr_estimate: { low: "8.0000", high: "12.0000" }, user_min_allocation: "0.01", allocation_fee: "0.0000", deallocation_fee: "0.0000", auto_compound: { type: "enabled" }, yield_source: { type: "staking" }, can_allocate: true, can_deallocate: true, allocation_restriction_info: [] },
    { id: "ESDQCOL-WTZEU-NU55QF", asset: "ETH", lock_type: { type: "bonded", payout_frequency: 604800, unbonding_period: 1_209_600 }, apr_estimate: { low: "3.0000", high: "3.0000" }, user_min_allocation: "0.001", can_allocate: false, can_deallocate: true, allocation_restriction_info: ["tier"] },
    { id: "ESFLEX0-REWRD-USDC00", asset: "USDC", lock_type: { type: "flex" }, apr_estimate: { low: "4.0", high: "4.0" }, can_allocate: true, can_deallocate: true },
  ] } };

  it("the strategies Kraken offers this account, the ones that run account-wide left out; an APR range; bonded ones say how long money stays", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const e = krakenEarner({ client: client("kraken", calls, { privatePostEarnStrategies: STRATEGIES }), venue: "kraken", name: "Kraken", key: KEY, can: [], now: () => NOW, price: async (a) => (a === "DOT" ? 4 : 2500) });
    const list = ok(await e.products());
    expect(list.map((p) => p.id)).toEqual(["ESRFUO3-Q62XD-WIOIL7", "ESDQCOL-WTZEU-NU55QF"]);
    expect(list[0]).toMatchObject({ asset: "DOT", apy: 0.08, apyHigh: 0.12, rateKind: "apr", minAmount: 0.01, lockDays: 0, priceUsd: 4, lands: "your Kraken spot balance", canSupply: true });
    expect(list[1]).toMatchObject({ asset: "ETH", apy: 0.03, lockDays: 14, canSupply: false, why: "Kraken does not take an allocation here now (tier)" });
    expect(list[1]!.apyHigh).toBeUndefined();
    expect(e.can).toBe("unknown");
  });

  it("money in and out is asynchronous: Allocate / Deallocate answer at once, AllocateStatus / DeallocateStatus say when it is done or what failed", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const c = client("kraken", calls, {
      privatePostEarnStrategies: STRATEGIES,
      privatePostEarnAllocate: { error: [], result: true },
      privatePostEarnDeallocate: { error: [], result: true },
      privatePostEarnAllocateStatus: [{ error: [], result: { pending: true } }, { error: [], result: { pending: false } }, named("InsufficientFunds", "kraken EEarnings:Insufficient funds:Insufficient funds to complete the (de)allocation request")],
      privatePostEarnAllocations: { error: [], result: { converted_asset: "USD", total_allocated: "49.2398", items: [{ strategy_id: "ESRFUO3-Q62XD-WIOIL7", native_asset: "DOT", amount_allocated: { total: { native: "10.5", converted: "42.0" } }, total_rewarded: { native: "0.2", converted: "0.8" } }] } },
    });
    const e = krakenEarner({ client: c, venue: "kraken", name: "Kraken", key: KEY, can: [], now: () => NOW });
    const p = ok(await e.product("ESRFUO3-Q62XD-WIOIL7"));
    const s = ok(await e.supply(p, 4.3, CLIENT));
    expect([s.status, s.ref]).toEqual(["pending", `allocate:ESRFUO3-Q62XD-WIOIL7:${CLIENT}`]);
    expect(calls.find(([n]) => n === "privatePostEarnAllocate")).toEqual(["privatePostEarnAllocate", { strategy_id: "ESRFUO3-Q62XD-WIOIL7", amount: "4.3" }]);
    expect(ok(await e.status!(s.ref, p, "supply")).status).toBe("pending");
    expect(ok(await e.status!(s.ref, p, "supply")).status).toBe("done");
    expect(ok(await e.status!(s.ref, p, "supply")).status).toBe("rejected");
    ok(await e.withdraw(p, 1, "f".repeat(32), false));
    expect(calls.find(([n]) => n === "privatePostEarnDeallocate")).toEqual(["privatePostEarnDeallocate", { strategy_id: "ESRFUO3-Q62XD-WIOIL7", amount: "1" }]);
    const held = ok(await e.positions());
    expect(held).toEqual([expect.objectContaining({ product: "ESRFUO3-Q62XD-WIOIL7", asset: "DOT", amount: 10.5, usd: 42, apy: 0.08, accrued: 0.2, accruedUsd: 0.8 })]);
    expect(calls.find(([n]) => n === "privatePostEarnAllocations")![1]).toEqual({ converted_asset: "USD", hide_zero_allocations: true });
  });

  it("Kraken's refusals in its own words, with what the owner can do: the Earn Funds permission, the verification tier, a busy strategy", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const c = client("kraken", calls, { privatePostEarnAllocate: [named("PermissionDenied", "kraken EGeneral:Permission denied"), named("PermissionDenied", "kraken EEarnings:Permission denied:The user's tier is not high enough"), named("ExchangeError", "kraken EEarnings:Busy:Another (de)allocation for the same strategy is in progress")] });
    const e = krakenEarner({ client: c, venue: "kraken", name: "Kraken", key: KEY, can: [], now: () => NOW });
    const p = { id: "ESRFUO3-Q62XD-WIOIL7", asset: "DOT", name: "DOT", lands: "your Kraken spot balance", canSupply: true, canWithdraw: true };
    const perm = refusal(await e.supply(p, 1, "1".repeat(32)));
    expect([perm.code, perm.message.includes('"Earn Funds" permission')]).toEqual(["E_VENUE_PERMISSION", true]);
    const tier = refusal(await e.supply(p, 1, "2".repeat(32)));
    expect([tier.code, tier.message.includes("Intermediate verification tier")]).toEqual(["E_VENUE_PERMISSION", true]);
    expect(refusal(await e.supply(p, 1, "3".repeat(32))).code).toBe("E_VENUE_UNREACHABLE");
  });

  it("OKX, Kraken, KuCoin and Binance have earn through their keys: Binance (binance.com) where the library has its Simple Earn calls — a 451 to one machine decides nothing for others — and no other exchange", () => {
    const simpleEarn = Object.fromEntries(["sapiGetSimpleEarnFlexibleList", "sapiGetSimpleEarnFlexiblePosition", "sapiPostSimpleEarnFlexibleSubscribe", "sapiPostSimpleEarnFlexibleRedeem", "sapiGetSimpleEarnFlexibleHistoryRedemptionRecord"].map((c) => [c, { rows: [], total: 0 }]));
    expect(exchangeEarner({ client: client("binance", [], simpleEarn), venue: "binance", name: "Binance", key: KEY, can: ["read"] })?.what).toBe("Simple Earn Flexible: out at any time");
    // a library without the calls offers none; Binance.US documents no Simple Earn; its futures clients are not where the money lands
    expect(exchangeEarner({ client: client("binance", [], {}), venue: "binance", name: "Binance", key: KEY, can: ["read"] })).toBeUndefined();
    expect(exchangeEarner({ client: client("binanceus", [], simpleEarn), venue: "binanceus", name: "Binance.US", key: KEY, can: ["read"] })).toBeUndefined();
    expect(exchangeEarner({ client: client("binanceusdm", [], simpleEarn), venue: "binanceusdm", name: "Binance USDⓈ-M", key: KEY, can: [] })).toBeUndefined();
    expect(exchangeEarner({ client: client("bybit", [], {}), venue: "bybit", name: "Bybit", key: KEY, can: [] })).toBeUndefined();
    expect(exchangeEarner({ client: client("okx", [], {}), venue: "okx", name: "OKX", key: KEY, can: [] })).toBeDefined();
    expect(exchangeEarner({ client: client("kraken", [], {}), venue: "kraken", name: "Kraken", key: KEY, can: [] })).toBeDefined();
    expect(exchangeEarner({ client: client("kucoin", [], {}), venue: "kucoin", name: "KuCoin", key: KEY, can: [] })?.what).toBe("KuCoin Earn: flexible savings, fixed terms and staking");
  });
});

describe("KuCoin Earn: /api/v1/earn with the account's own key, through the library's implicit calls", () => {
  const NOW_MS = NOW;
  /** KuCoin's product rows, shaped as its docs' schema (get-savings-products, get-promotion-products): returnRate an annualized fraction,
   * redeemPeriod in days, times in milliseconds */
  const SAVINGS = { code: "200000", data: [
    { id: "2152", currency: "USDT", category: "DEMAND", type: "DEMAND", precision: 8, productUpperLimit: "1000000", productRemainAmount: "500000", userUpperLimit: "10000", userLowerLimit: "1", redeemPeriod: 0, lockStartTime: 1791100000000, lockEndTime: null, applyStartTime: 1791100000000, applyEndTime: null, returnRate: "0.0432", incomeCurrency: "USDT", earlyRedeemSupported: 0, status: "ONGOING", redeemType: "MANUAL", incomeReleaseType: "DAILY", interestDate: 1791200000000, duration: 0, newUserOnly: 0 },
    { id: "2153", currency: "KCS", category: "DEMAND", type: "DEMAND", precision: 8, productUpperLimit: "100000", productRemainAmount: "0", userUpperLimit: "100", userLowerLimit: "1", redeemPeriod: 1, lockStartTime: 1791100000000, lockEndTime: null, applyStartTime: 1791100000000, applyEndTime: null, returnRate: "0.02", incomeCurrency: "KCS", earlyRedeemSupported: 0, status: "ONGOING", redeemType: "MANUAL", incomeReleaseType: "DAILY", interestDate: 1791200000000, duration: 0, newUserOnly: 0 },
  ] };
  const PROMOTION = { code: "200000", data: [
    { id: "2611", currency: "USDC", category: "ACTIVITY", type: "TIME", precision: 6, productUpperLimit: "200000", productRemainAmount: "150000", userUpperLimit: "5000", userLowerLimit: "10", redeemPeriod: 1, lockStartTime: 1791300000000, lockEndTime: 1793892000000, applyStartTime: 1791100000000, applyEndTime: 1791300000000, returnRate: "0.12", incomeCurrency: "USDC", earlyRedeemSupported: 1, status: "ONGOING", redeemType: "AUTO", incomeReleaseType: "AFTER", interestDate: 1791300000000, duration: 30, newUserOnly: 0 },
    // income in another currency than what goes in: not one asset in and out, so not offered
    { id: "2612", currency: "BTC", category: "ACTIVITY", type: "TIME", precision: 8, productRemainAmount: "10", userLowerLimit: "0.001", redeemPeriod: 1, lockEndTime: 1793892000000, returnRate: "0.05", incomeCurrency: "USDT", earlyRedeemSupported: 0, status: "ONGOING", redeemType: "AUTO", incomeReleaseType: "AFTER", duration: 30 },
    { id: "2613", currency: "ETH", category: "ACTIVITY", type: "TIME", precision: 8, productRemainAmount: "0", userLowerLimit: "0.01", redeemPeriod: 1, lockEndTime: 1793892000000, returnRate: "0.03", incomeCurrency: "ETH", earlyRedeemSupported: 0, status: "FULL", redeemType: "AUTO", incomeReleaseType: "AFTER", duration: 30 },
  ] };
  const EMPTY = { code: "200000", data: [] };
  const LISTS = { earnGetEarnSavingProducts: SAVINGS, earnGetEarnPromotionProducts: PROMOTION, earnGetEarnStakingProducts: EMPTY, earnGetEarnKcsStakingProducts: EMPTY, earnGetEarnEthStakingProducts: EMPTY };
  /** one page of hold-assets (get-account-holding): the holding's orderId is what a redemption names */
  const holding = (over: Record<string, unknown> = {}) => ({ orderId: "2767291", productId: "2152", productCategory: "DEMAND", productType: "DEMAND", currency: "USDT", incomeCurrency: "USDT", returnRate: "0.0432", holdAmount: "110.5", redeemedAmount: "0", redeemingAmount: "0", lockStartTime: 1791100000000, lockEndTime: null, purchaseTime: 1791150000000, redeemPeriod: 0, status: "LOCKED", earlyRedeemSupported: 0, ...over });
  const page = (items: unknown[]) => ({ code: "200000", data: { totalNum: items.length, totalPage: 1, currentPage: 1, pageSize: 100, items } });

  it("the products: savings (flexible) and promotions (fixed terms) as KuCoin lists them, the rate its annualized fraction, the least that goes in, where money lands; a full one says so, and one paying in another currency is not offered", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const e = kucoinEarner({ client: client("kucoin", calls, LISTS), venue: "kucoin", name: "KuCoin", key: KEY, can: ["read", "trade spot", "earn"], now: () => NOW_MS, price: async (a) => (a === "KCS" ? 10 : undefined) });
    expect(e.can).toBe(true);
    const list = ok(await e.products());
    expect(calls.map(([n, p]) => [n, p])).toEqual([["earnGetEarnSavingProducts", {}], ["earnGetEarnPromotionProducts", {}], ["earnGetEarnStakingProducts", {}], ["earnGetEarnKcsStakingProducts", {}], ["earnGetEarnEthStakingProducts", {}]]);
    expect(list.map((p) => p.id)).toEqual(["2152", "2153", "2611", "2613"]);
    expect(list[0]).toMatchObject({ id: "2152", asset: "USDT", name: "USDT · Savings (flexible)", apy: 0.0432, rateKind: "apr", protocol: "KuCoin Earn", minAmount: 1, lockDays: 0, priceUsd: 1, lands: "your KuCoin trading account", canSupply: true, canWithdraw: true });
    expect(list[0]!.why).toBeUndefined();
    expect(list[1]).toMatchObject({ asset: "KCS", priceUsd: 10, canSupply: false, why: "KuCoin says it is full", lockDays: 1 });
    expect(list[2]).toMatchObject({ id: "2611", asset: "USDC", name: "USDC · Promotion (30 days)", apy: 0.12, minAmount: 10, lockDays: 1, canSupply: true, canWithdraw: true });
    expect(list[2]!.note).toContain("a fixed term to 2026-11-05, redeemable early where KuCoin allows it");
    expect(list[3]).toMatchObject({ id: "2613", asset: "ETH", canSupply: false, canWithdraw: false, why: "KuCoin lists it as FULL" });
    // one asset when asked: KuCoin is asked for that currency, and only its products come back
    calls.splice(0);
    expect(ok(await e.products("usdt")).map((p) => p.id)).toEqual(["2152"]);
    expect(calls[0]).toEqual(["earnGetEarnSavingProducts", { currency: "USDT" }]);
    // a key without KuCoin's Earn permission may only read
    const readOnly = kucoinEarner({ client: client("kucoin", [], LISTS), venue: "kucoin", name: "KuCoin", key: KEY, can: ["read", "trade spot"], now: () => NOW_MS });
    expect([readOnly.can, readOnly.whyNot]).toEqual([false, "this KuCoin key lacks the Earn permission: purchase and redemption need it (set on the key at KuCoin)"]);
    expect(kucoinEarner({ client: client("kucoin", [], LISTS), venue: "kucoin", name: "KuCoin", key: KEY, can: [] }).can).toBe("unknown");
  });

  it("one product is read afresh by KuCoin's id; what is held comes holding by holding; money in is POST earn/orders from the trading account, credited at once", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const c = client("kucoin", calls, { ...LISTS, earnGetEarnHoldAssets: page([holding(), holding({ orderId: "2767292", productId: "2611", productCategory: "ACTIVITY", productType: "TIME", currency: "USDC", incomeCurrency: "USDC", returnRate: "0.12", holdAmount: "50", redeemingAmount: "20", status: "REDEEMING", lockEndTime: 1793892000000 }), holding({ orderId: "2767293", holdAmount: "0" })]), earnPostEarnOrders: { code: "200000", data: { orderId: "2767299", orderTxId: "6603694" } } });
    const e = kucoinEarner({ client: c, venue: "kucoin", name: "KuCoin", key: KEY, can: ["read", "earn"], now: () => NOW_MS });
    const p = ok(await e.product("2152"));
    expect(p.id).toBe("2152");
    expect(refusal(await e.product("savings:USDT")).code).toBe("E_ACCOUNT_BAD_ACTION");
    expect(refusal(await e.product("9999")).message).toBe("KuCoin lists no Earn product 9999 now");
    const held = ok(await e.positions());
    expect(calls.find(([n]) => n === "earnGetEarnHoldAssets")![1]).toEqual({ currentPage: 1, pageSize: 100 });
    expect(held).toEqual([
      { product: "2152", id: "2767291", asset: "USDT", amount: 110.5, usd: 110.5, apy: 0.0432, name: "USDT · KuCoin Earn (demand)", protocol: "KuCoin Earn" },
      { product: "2611", id: "2767292", asset: "USDC", amount: 50, usd: 50, apy: 0.12, pending: 20, name: "USDC · KuCoin Earn (activity)", protocol: "KuCoin Earn" },
    ]);
    const s = ok(await e.supply(p, 25, CLIENT));
    expect([s.ref, s.status, s.native]).toEqual([`purchase:2152:${CLIENT}`, "done", { request: { productId: "2152", amount: "25", accountType: "TRADE" }, answer: { orderId: "2767299", orderTxId: "6603694" } }]);
    // the same client id again is the same request: nothing is bought twice
    ok(await e.supply(p, 25, CLIENT));
    expect(calls.filter(([n]) => n === "earnPostEarnOrders")).toHaveLength(1);
    expect(ok(await e.status!(s.ref, p, "supply")).status).toBe("done");
  });

  it("money out: each holding previewed (GET earn/redeem-preview), then DELETE earn/orders back to the trading account, PENDING until hold-assets shows nothing redeeming; all of it takes every holding", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    let redeeming = "0";
    const c = client("kucoin", calls, {
      ...LISTS,
      earnGetEarnHoldAssets: (params: Record<string, unknown>) => page(params.productId === "2152" ? [holding({ orderId: "A1", holdAmount: "60", redeemingAmount: redeeming }), holding({ orderId: "A2", holdAmount: "50.5" })] : []),
      earnGetEarnRedeemPreview: (params: Record<string, unknown>) => ({ code: "200000", data: { currency: "USDT", redeemAmount: params.orderId === "A1" ? "60" : "50.5", penaltyInterestAmount: "0", redeemPeriod: 0, deliverTime: 1791230000000, manualRedeemable: true, redeemAll: true } }),
      earnDeleteEarnOrders: (params: Record<string, unknown>) => ({ code: "200000", data: { orderTxId: `tx-${String(params.orderId)}`, deliverTime: 1791230000000, status: "PENDING", amount: params.amount } }),
    });
    const e = kucoinEarner({ client: c, venue: "kucoin", name: "KuCoin", key: KEY, can: ["read", "earn"], now: () => NOW_MS });
    const p = ok(await e.product("2152"));
    // a part: the first holding gives it
    const part = ok(await e.withdraw(p, 10, CLIENT, false));
    expect([part.ref, part.status]).toEqual([`redeem:2152:${CLIENT}`, "pending"]);
    expect(calls.filter(([n]) => n === "earnGetEarnRedeemPreview").map(([, q]) => q)).toEqual([{ orderId: "A1", fromAccountType: "TRADE" }]);
    expect(calls.filter(([n]) => n === "earnDeleteEarnOrders").map(([, q]) => q)).toEqual([{ orderId: "A1", amount: "10", fromAccountType: "TRADE" }]);
    expect((part.native as { answers: unknown[] }).answers).toEqual([{ orderTxId: "tx-A1", deliverTime: 1791230000000, status: "PENDING", amount: "10" }]);
    // while KuCoin shows the amount still redeeming the request is under way; once it does not, it is done
    redeeming = "10";
    expect(ok(await e.status!(part.ref, p, "withdraw")).status).toBe("pending");
    redeeming = "0";
    expect(ok(await e.status!(part.ref, p, "withdraw")).status).toBe("done");
    // all of it: every holding, each its whole amount
    calls.splice(0);
    ok(await e.withdraw(p, 0, "e".repeat(32), true));
    expect(calls.filter(([n]) => n === "earnDeleteEarnOrders").map(([, q]) => q)).toEqual([{ orderId: "A1", amount: "60", fromAccountType: "TRADE" }, { orderId: "A2", amount: "50.5", fromAccountType: "TRADE" }]);
    // more than is held is refused before anything is asked; nothing held, the same
    expect(refusal(await e.withdraw(p, 500, "d".repeat(32), false)).code).toBe("E_VENUE_INSUFFICIENT");
    const other = refusal(await e.withdraw({ ...p, id: "2611", name: "USDC · Promotion (30 days)" }, 1, "c".repeat(32), false));
    expect([other.code, other.message]).toEqual(["E_VENUE_REJECTED", "nothing of yours is in USDC · Promotion (30 days) at KuCoin"]);
  });

  it("an early redemption KuCoin would penalise is refused with its figure, for the owner to confirm at KuCoin; one KuCoin does not redeem by hand is refused with when it is delivered; KuCoin's permission no says what the owner can do", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const c = client("kucoin", calls, {
      ...LISTS,
      earnGetEarnHoldAssets: page([holding({ orderId: "P1", productId: "2611", productCategory: "ACTIVITY", productType: "TIME", currency: "USDC", holdAmount: "100", lockEndTime: 1793892000000, earlyRedeemSupported: 1 })]),
      earnGetEarnRedeemPreview: [{ code: "200000", data: { currency: "USDC", redeemAmount: "100", penaltyInterestAmount: "0.75", redeemPeriod: 1, deliverTime: 1791316400000, manualRedeemable: true, redeemAll: true } }, { code: "200000", data: { currency: "USDC", redeemAmount: "100", penaltyInterestAmount: "0", redeemPeriod: 1, deliverTime: 1793978400000, manualRedeemable: false, redeemAll: true } }],
      // the redemption call is there, and never reached
      earnDeleteEarnOrders: { code: "200000", data: { orderTxId: "never", deliverTime: 0, status: "PENDING", amount: "0" } },
      earnPostEarnOrders: named("AuthenticationError", `kucoin {"code":"400007","msg":"Access denied, require more permission (key ${KEY.apiKey})"}`),
    });
    const e = kucoinEarner({ client: c, venue: "kucoin", name: "KuCoin", key: KEY, can: [], now: () => NOW_MS });
    const p = { id: "2611", asset: "USDC", name: "USDC · Promotion (30 days)", lands: "your KuCoin trading account", canSupply: true, canWithdraw: true };
    const penalty = refusal(await e.withdraw(p, 100, "1".repeat(32), false));
    expect([penalty.code, penalty.message]).toEqual(["E_VENUE_REJECTED", "KuCoin says redeeming 100 USDC from USDC · Promotion (30 days) now forfeits 0.75 USDC of interest, and asks for that to be confirmed: the account does not confirm it for you. Redeem it at KuCoin if you mean to, or after 2026-11-05"]);
    const auto = refusal(await e.withdraw(p, 100, "2".repeat(32), false));
    expect([auto.code, auto.message]).toEqual(["E_VENUE_RAIL_CLOSED", "KuCoin says this holding in USDC · Promotion (30 days) is not redeemed by hand now: it is delivered on 2026-11-05"]);
    expect(calls.some(([n]) => n === "earnDeleteEarnOrders")).toBe(false);
    const perm = refusal(await e.supply(p, 10, "3".repeat(32)));
    expect([perm.code, perm.message]).toEqual(["E_VENUE_PERMISSION", "KuCoin refused to put 10 USDC into USDC · Promotion (30 days): purchase and redemption need the key's Earn permission (set on the key at KuCoin)"]);
    expect(JSON.stringify(perm)).not.toContain(KEY.apiKey);
  });
});
