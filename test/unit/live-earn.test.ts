import { describe, expect, it } from "vitest";
import { isRefusal, type Refusal } from "../../src/core/errors.ts";
import { exchangeEarner, krakenEarner, okxEarner, type EarnProduct, type LiveEarner } from "../../src/portfolio/live/earn.ts";
import type { ExchangeClient } from "../../src/portfolio/live/exchange.ts";
import { metamaskSource, MmError, type MmNotice, type RunMm } from "../../src/portfolio/live/metamask.ts";

/** EARN at the venues that have an interface for it, each in its own language, against stand-ins that answer in the shapes each documents:
 * mm 7.0.0's `mm earn` (its SDK's Vault and VaultPosition, LI.FI's earn API underneath), OKX's Simple Earn Flexible (API v5
 * finance/savings) and Kraken Earn (/0/private/Earn/*), both through the exchange library's implicit calls. Nothing leaves the process;
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

  it("only OKX and Kraken have earn through their keys here: any other exchange has none", () => {
    const none = exchangeEarner({ client: client("binance", [], {}), venue: "binance", name: "Binance", key: KEY, can: ["read"] });
    expect(none).toBeUndefined();
    expect(exchangeEarner({ client: client("okx", [], {}), venue: "okx", name: "OKX", key: KEY, can: [] })).toBeDefined();
    expect(exchangeEarner({ client: client("kraken", [], {}), venue: "kraken", name: "Kraken", key: KEY, can: [] })).toBeDefined();
  });
});
