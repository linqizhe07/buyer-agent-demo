import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isRefusal, type Refusal } from "../../src/core/errors.ts";
import { metamaskSource, MmError, parseMm, realMm, type MmNotice, type RunMm } from "../../src/portfolio/live/metamask.ts";
import { inDollars, type LiveTrader, type Market, type OrderRequest, type Position } from "../../src/portfolio/live/trade.ts";
import type { LiveSource } from "../../src/portfolio/live/types.ts";

/** TRADING through MetaMask's mm command line, against a stand-in for mm that records every command and answers what each test says, in
 * the shapes mm 7.0.0 prints (the trade spec, section 7). The real mm never runs here, nothing leaves the process, and MetaMask's own switch
 * (PORTFOLIO_MM_WRITES) lives in an env object made per test, never in the shell. */
const WALLET = "0x00000000000000000000000000000000000000Aa";
/** Circle's USDC on Base, as chain.ts pins it: the dollar side of every swap on Base */
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ZERO = "0x0000000000000000000000000000000000000000";
/** a made-up token address, standing for the WETH mm resolves on Base */
const WETH_BASE = "0x00000000000000000000000000000000000Be7e5";
const HASH = `0x${"ab".repeat(32)}`;
const HASH2 = `0x${"cd".repeat(32)}`;
const TID_YES = `1${"2345678901".repeat(7)}3`;
const TID_NO = `9${"8765432109".repeat(7)}1`;
const CID = `0x${"c0ffee00".repeat(8)}`;
const SLUG = "fed-cuts-rates-in-december";
const ORDER = `0x5f${"0".repeat(60)}11`;
const NOW = Date.parse("2026-10-05T14:00:00.000Z");
const ON = { PORTFOLIO_MM_WRITES: "1" };
const CLIENT = "0123456789abcdef0123456789abcdef";
const PASSWORD = "made-up-byok-password-0001";

type Answer = unknown;
interface Call {
  args: string[];
  timeoutMs?: number;
}

/** "swap quote", "predict place", "predict markets get", "wallet requests list" … */
const commandOf = (args: string[]): string => args.slice(0, ["markets", "requests"].includes(args[1] ?? "") ? 3 : 2).join(" ");

/** mm as a stand-in: an answer by command (a list is answered in turn, its last one from then on; a function sees the argv); an MmError is
 * thrown as mm's own failure; anything not set up fails the way mm would */
function standIn(answers: Record<string, Answer>): { run: RunMm; calls: Call[] } {
  const calls: Call[] = [];
  const run: RunMm = async <T>(args: string[], opts?: { timeoutMs?: number }): Promise<T> => {
    calls.push({ args: [...args], ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) });
    if (args.includes("--yes")) throw new Error("mm swap quote --yes executes at once: it must never be sent");
    const a = answers[commandOf(args)];
    const next = Array.isArray(a) ? (a.length > 1 ? a.shift() : a[0]) : a;
    if (next === undefined) throw new MmError({ code: "NOT_SET_UP", message: `not set up in this test: mm ${args.join(" ")}` });
    const out = typeof next === "function" ? (next as (args: string[]) => unknown)(args) : next;
    if (out instanceof Error) throw out;
    return out as T;
  };
  return { run, calls };
}

const SHOW = { address: WALLET, tradingMode: "guard", policyYaml: "rolling_24h: 50" };
const BALANCE = { currency: "usd", totalValue: "40", chains: [{ chainName: "Base", tokens: [{ symbol: "USDC", balance: "40", value: "40" }] }] };

async function boot(answers: Record<string, Answer> = {}, env: Record<string, string | undefined> = ON): Promise<{ t: LiveTrader; source: LiveSource; calls: Call[]; answers: Record<string, Answer>; clock: { now: number } }> {
  const clock = { now: NOW };
  const all: Record<string, Answer> = { "wallet show": SHOW, "wallet balance": BALANCE, ...answers };
  const s = standIn(all);
  const opened = await metamaskSource({ venue: "metamask", label: "", run: s.run, env, now: () => clock.now });
  if (isRefusal(opened)) throw new Error(opened.message);
  s.calls.splice(0);
  return { t: opened.source.trader!, source: opened.source, calls: s.calls, answers: all, clock };
}

const refusal = (x: unknown): Refusal => {
  if (!isRefusal(x)) throw new Error(`expected a refusal, got ${JSON.stringify(x)}`);
  expect(JSON.stringify(x)).not.toContain(PASSWORD);
  return x;
};
const ok = <T>(x: T | Refusal): T => {
  if (isRefusal(x)) throw new Error(`expected an answer, got ${x.code}: ${x.message}`);
  return x;
};
const argvs = (calls: Call[]) => calls.map((c) => c.args);
const fail = (code: string, message: string, hint?: string, notices: MmNotice[] = []) => new MmError({ code, message, ...(hint ? { hint } : {}) }, notices);

// ---- what mm answers, shaped like the 7.0.0 source and the trade spec's worked examples ----------------------

const ETH = { address: ZERO, decimals: 18, symbol: "ETH" };
const WETH = { address: WETH_BASE, decimals: 18, symbol: "WETH" };
const USDC = { address: USDC_BASE, decimals: 6, symbol: "USDC" };
type Tok = typeof ETH;

function quoteData(o: { id: string; src: Tok; dst: Tok; spend: string; get: string; least: string; feeUsd?: string; warnings?: string[]; wallet?: string }) {
  const chain = 8453;
  return {
    quoteId: o.id,
    createdAt: "2026-10-05T14:00:00.000Z",
    request: { walletAddress: o.wallet ?? WALLET, srcChainId: chain, destChainId: chain, srcChainName: "Base", destChainName: "Base", srcAsset: o.src, destAsset: o.dst, srcAssetAmount: o.spend, slippage: 0.5 },
    quote: {
      quoteId: o.id,
      bridgeId: "lifi",
      srcChainId: chain,
      destChainId: chain,
      srcAssetAmount: o.spend,
      destAssetAmount: o.get,
      minDestAssetAmount: o.least,
      srcAsset: { ...o.src, chainId: chain },
      destAsset: { ...o.dst, chainId: chain },
      feeData: { metabridge: { amount: "0", asset: { ...o.src, chainId: chain }, quoteBpsFee: 87.5, baseBpsFee: 87.5, usd: o.feeUsd ?? "0.88" } },
      protocols: ["uniswap"],
      steps: [],
      slippage: 0.5,
      priceData: { totalFromAmountUsd: "100", totalToAmountUsd: "99.2", priceImpact: "0.0011" },
      gasIncluded: false,
      gasIncluded7702: false,
      estimatedProcessingTimeInSeconds: 0,
      requiresApproval: false,
      networkFee: { amount: "0.0000021", symbol: "ETH" },
    },
    strategy: ["cost", "speed"],
    ...(o.warnings ? { warnings: o.warnings } : {}),
  };
}

/** quotes by `<from>><to>:<amount>`: what the account asks for is exactly what is answered, or the stand-in says it was not set up */
const quotes = (table: Record<string, unknown>) => (args: string[]) => {
  const key = `${args[3]}>${args[5]}:${args[7]}`;
  return table[key] ?? fail("NOT_SET_UP", `no quote for ${key}`);
};
/** ETH on Base: $100 buys 0.04 ETH (ask 2500); 0.04 ETH sells for $99.20 (bid 2480) */
const ETH_PRICES = {
  [`${USDC_BASE}>ETH:100`]: quoteData({ id: "q-ask", src: USDC, dst: ETH, spend: "100000000", get: "40000000000000000", least: "39800000000000000" }),
  [`ETH>${USDC_BASE}:0.04`]: quoteData({ id: "q-bid", src: ETH, dst: USDC, spend: "40000000000000000", get: "99200000", least: "98704000" }),
};
const SELL_HALF = quoteData({ id: "q-sell", src: ETH, dst: USDC, spend: "500000000000000000", get: "1240000000", least: "1233800000", feeUsd: "10.85" });
const BUY_FIFTH = quoteData({ id: "q-buy", src: USDC, dst: ETH, spend: "500000000", get: "200000000000000000", least: "199000000000000000", feeUsd: "4.37" });
const SUBMITTED = { quoteId: "q-sell", status: "submitted", transactions: [{ kind: "trade", txHash: HASH, chainId: 8453, chainName: "Base", explorerUrl: `https://basescan.org/tx/${HASH}` }], route: "sequential", gasIncluded: false, gasIncluded7702: false };

const swapStatus = (status: string, legs: unknown[] = []) => ({ quoteId: "q", status, crossChain: false, transactions: legs });
const leg = (kind: string, status: string, amount: string, assetSymbol: string, txHash = HASH) => ({ kind, status, chainId: 8453, chainName: "Base", txHash, explorerUrl: "", amount, assetSymbol, assetAddress: assetSymbol === "USDC" ? USDC_BASE : ZERO });

const marketGet = (over: Record<string, unknown> = {}) => ({
  command: "markets get",
  result: { market: { id: "900001", slug: SLUG, question: "Fed cuts rates in December?", conditionId: CID, active: true, closed: false, acceptingOrders: true, enableOrderBook: true, negRisk: false, orderMinSize: 5, orderPriceMinTickSize: 0.01, endDate: "2026-12-31T00:00:00Z", outcomes: [{ name: "Yes", price: 0.175, tokenId: TID_YES }, { name: "No", price: 0.825, tokenId: TID_NO }], ...over } },
});
/** bids ascending and asks descending, as the CLOB lists them: the best of each is the last */
const bookOf = (over: Record<string, unknown> = {}) => ({
  command: "book",
  result: { chainId: 137, tokenId: TID_YES, book: { market: CID, asset_id: TID_YES, timestamp: "1791225581396", hash: "d966", bids: [{ price: "0.01", size: "22536.8" }, { price: "0.17", size: "500" }], asks: [{ price: "0.99", size: "1876.08" }, { price: "0.18", size: "400" }], min_order_size: "5", tick_size: "0.01", neg_risk: false, last_trade_price: "0.170", ...over } },
});
const NOT_BLOCKED = { command: "geoblock", result: { blocked: false, ip: "203.0.113.9", country: "IE", region: "L" } };
const placed = (response: Record<string, unknown>) => ({ command: "place", params: {}, result: { chainId: 137, ownerAddress: WALLET, depositWalletAddress: "0x00000000000000000000000000000000000000Dd", tickSize: "0.01", negRisk: false, balanceAllowance: { balance: "25000000", allowances: {} }, response: { orderId: ORDER, status: "live", success: true, makingAmount: "0", takingAmount: "0", ...response } } });
const openOrders = (orders: Array<Record<string, unknown>>) => ({ command: "orders", params: { market: CID }, result: { chainId: 137, ownerAddress: WALLET, orders } });
const order = () => ({ id: ORDER, market: CID, asset_id: TID_YES, owner: "made-up-api-owner", maker_address: "0x00000000000000000000000000000000000000Dd", side: "BUY", price: "0.18", original_size: "10", size_matched: "0", outcome: "Yes", order_type: "GTC", status: "LIVE", created_at: 1791225581, expiration: "0" });
const PM_MARKET = { "predict markets get": marketGet(), "predict book": bookOf() };

// ---- the command line's three shapes ------------------------------------------------------------------------

describe("what mm prints, read the way it prints it", () => {
  it("reads a success, a failure on stderr, and a Guard pause in JSON lines", () => {
    expect(parseMm(JSON.stringify({ ok: true, data: { address: WALLET } }, null, 2), "", 0)).toEqual({ ok: true, data: { address: WALLET }, notices: [] });
    const failed = parseMm("", JSON.stringify({ ok: false, error: { code: "INSUFFICIENT_FUNDS", message: "Insufficient USDC balance to execute this swap.", hint: "Check balances" } }, null, 2), 1);
    expect(failed).toEqual({ ok: false, error: { code: "INSUFFICIENT_FUNDS", message: "Insufficient USDC balance to execute this swap.", hint: "Check balances" }, notices: [] });
    const notice = { kind: "AWAITING_MFA", source: "swap:execute", pollingId: "pl_123", authMethod: "browser", message: "Approve in your email" };
    const paused = parseMm(`${JSON.stringify({ _notice: notice })}\n${JSON.stringify({ _summary: { quoteId: "q", status: "submitted" }, _hint: "Run mm swap status" })}\n`, "Intent: Swap 0.5 ETH\nTx submitted: https://basescan.org/tx/0xabc\n", 0);
    expect(paused).toEqual({ ok: true, data: { quoteId: "q", status: "submitted" }, notices: [notice] });
    const timedOut = parseMm(`${JSON.stringify({ _notice: notice })}\n`, `${JSON.stringify({ _error: { code: "JOB_TIMEOUT", message: "Timed out", hint: "mm wallet requests watch pl_123" } })}\n`, 1);
    expect(timedOut).toEqual({ ok: false, error: { code: "JOB_TIMEOUT", message: "Timed out", hint: "mm wallet requests watch pl_123" }, notices: [notice] });
    // a crash, or a Node too old for mm, is not JSON: its words are kept
    const crashed = parseMm("", "Error: Cannot find module\n    at foo (bar.js:1)", 1);
    expect(!crashed.ok && crashed.error.code).toBe("UNPARSEABLE");
    expect(!crashed.ok && crashed.error.message).toContain("Cannot find module");
    // exit 0 with something that is not mm's envelope (a user's `mm config set format toon`) is not taken as data
    expect(parseMm("quoteId: q\nstatus: submitted", "", 0).ok).toBe(false);
  });

  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it("the real runner adds --json, gives a write its own wait, and throws mm's own error (against a fake mm script, not mm)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-mm-"));
    dirs.push(dir);
    const bin = join(dir, "mm");
    const script = [
      `#!${process.execPath}`,
      "const args = process.argv.slice(2);",
      "if (args[0] === 'wallet') process.stdout.write(JSON.stringify({ ok: true, data: { args } }, null, 2));",
      "else if (args[0] === 'swap') { process.stdout.write(JSON.stringify({ _notice: { kind: 'AWAITING_MFA', pollingId: 'pl_1' } }) + '\\n'); process.stdout.write(JSON.stringify({ _summary: { quoteId: 'q1', status: 'submitted' } }) + '\\n'); }",
      "else if (args[0] === 'predict') { process.stderr.write(JSON.stringify({ ok: false, error: { code: 'PREDICT_GEOBLOCKED', message: 'blocked here', hint: 'h' } }, null, 2)); process.exit(1); }",
      "else if (args[0] === 'sleep') setTimeout(() => {}, 5000);",
      "else { process.stderr.write('Error: something broke\\n    at x'); process.exit(1); }",
    ].join("\n");
    writeFileSync(bin, script, { mode: 0o755 });
    const run = realMm(bin, 4000);
    expect(await run(["wallet", "show"])).toEqual({ args: ["wallet", "show", "--json"] });
    expect(await run(["wallet", "show", "--json"])).toEqual({ args: ["wallet", "show", "--json"] });
    expect(await run(["swap", "execute", "--quote-id", "q1", "--wallet-timeout", "600", "--json"], { timeoutMs: 4000 })).toEqual({ quoteId: "q1", status: "submitted" });
    const geo = (await run(["predict", "geoblock"]).catch((e: unknown) => e)) as MmError;
    expect(geo).toBeInstanceOf(MmError);
    expect([geo.code, geo.said, geo.hint]).toEqual(["PREDICT_GEOBLOCKED", "blocked here", "h"]);
    expect(((await run(["sleep"], { timeoutMs: 300 }).catch((e: unknown) => e)) as MmError).code).toBe("MM_TIMEOUT");
    expect(((await run(["crash"]).catch((e: unknown) => e)) as MmError).code).toBe("UNPARSEABLE");
    expect(((await realMm(join(dir, "not-there"))(["wallet", "show"]).catch((e: unknown) => e)) as MmError).code).toBe("ENOENT");
  });
});

// ---- the source -------------------------------------------------------------------------------------------------

describe("the MetaMask Agent Wallet's source", () => {
  it("still reads as it did, and now carries a trader for swaps and Polymarket orders", async () => {
    const s = standIn({ "wallet show": SHOW, "wallet balance": BALANCE });
    const opened = ok(await metamaskSource({ venue: "metamask", label: "", run: s.run, env: ON, now: () => NOW }));
    expect(argvs(s.calls)).toEqual([["wallet", "show"], ["wallet", "balance"]]);
    expect(opened.first).toEqual([{ asset: "USDC", amount: 40, usd: 40, where: "Base" }]);
    expect(opened.source.probe.can).toEqual(["read", "transfer", "swap"]);
    expect(opened.source.writer?.can.send).toBe("mm");
    const t = opened.source.trader!;
    expect(t.can).toBe("unknown");
    expect(t.what).toBe("token swaps against USDC on Ethereum, Optimism, BNB Chain, Polygon, Base, Arbitrum, and Polymarket prediction orders, sent by MetaMask's mm");
    expect(opened.source.noTradeBecause).toBeUndefined();
    // a session that cannot show the wallet is still refused as before
    const none = standIn({ "wallet show": fail("ENOENT", "the mm command line is not installed on this machine (spawn mm ENOENT)") });
    expect(refusal(await metamaskSource({ venue: "metamask", label: "", run: none.run, env: ON })).message).toBe("the mm command line is not installed on this machine");
  });
});

// ---- swaps ----------------------------------------------------------------------------------------------------------

describe("a swap through mm", () => {
  it("is priced by two quotes that move nothing: the ask from $100 of USDC, the bid from that much of the token", async () => {
    const x = await boot({ "swap quote": quotes(ETH_PRICES) }, {});
    const m = ok(await x.t.market("ETH/usdc@base"));
    expect(m).toEqual<Market>({ symbol: "ETH/USDC@Base", name: "ETH on Base", kind: "token", base: "ETH", quote: "USDC", price: 2490, bid: 2480, ask: 2500, qtyStep: 1e-8, open: true, note: expect.stringContaining("exact-input: a buy spends qty × ask in USDC and gets about qty") as unknown as string, types: ["market"] });
    // a swap is a market order and nothing more: no time in force, post-only, reduce-only or leverage is said
    expect(Object.keys(m).filter((k) => ["tifs", "postOnly", "reduceOnly", "maxLeverage"].includes(k))).toEqual([]);
    // the dollar side by its pinned address, never by symbol; never --yes, never --all-quotes; quotes run with MetaMask's switch off
    expect(argvs(x.calls)).toEqual([
      ["swap", "quote", "--from", USDC_BASE, "--to", "ETH", "--amount", "100", "--from-chain-id", "8453", "--slippage", "0.5", "--json"],
      ["swap", "quote", "--from", "ETH", "--to", USDC_BASE, "--amount", "0.04", "--from-chain-id", "8453", "--slippage", "0.5", "--json"],
    ]);
    expect(x.calls.every((c) => c.timeoutMs === undefined)).toBe(true);
  });

  it("names a token by the address mm resolved, and carries MetaMask's warnings", async () => {
    const x = await boot({
      "swap quote": quotes({
        [`${USDC_BASE}>WETH:100`]: quoteData({ id: "a", src: USDC, dst: WETH, spend: "100000000", get: "40000000000000000", least: "39800000000000000", warnings: ["High price impact (6.1%)."] }),
        [`${WETH_BASE}>${USDC_BASE}:0.04`]: quoteData({ id: "b", src: WETH, dst: USDC, spend: "40000000000000000", get: "99200000", least: "98704000" }),
      }),
    });
    const m = ok(await x.t.market("WETH/USDC@Base"));
    expect([m.symbol, m.name, m.qtyStep]).toEqual(["WETH/USDC@Base", "WETH on Base (0x0000…e7e5, as MetaMask resolves it)", 1e-8]);
    expect(m.note).toContain("MetaMask warns: High price impact (6.1%).");
    expect(x.calls[1]!.args[3]).toBe(WETH_BASE);
  });

  it("refuses a market not priced in dollars, a stablecoin other than the chain's USDC, and a quote of another token", async () => {
    const x = await boot({ "swap quote": quotes({ [`${USDC_BASE}>ETH:100`]: quoteData({ id: "a", src: USDC, dst: WETH, spend: "100000000", get: "40000000000000000", least: "39800000000000000" }) }) });
    expect(refusal(await x.t.market("BTC/EUR@Base")).code).toBe("E_ACCOUNT_UNPRICED");
    expect(refusal(await x.t.market("ETH/USDT@Base")).code).toBe("E_ACCOUNT_BAD_ACTION");
    expect(refusal(await x.t.market("ETH/USDC@Robinhood Chain")).code).toBe("E_ACCOUNT_BAD_ACTION");
    // a token that would reach mm's argv as a flag (--yes executes a quote at once) is never asked about
    expect(refusal(await x.t.market("--yes/USDC@Base")).code).toBe("E_ACCOUNT_BAD_ACTION");
    expect(x.calls).toEqual([]);
    const other = refusal(await x.t.market("ETH/USDC@Base"));
    expect([other.code, other.message]).toEqual(["E_VENUE_REJECTED", `mm quoted something other than what was asked (100 USDC for WETH 0x0000…e7e5, chain 8453→8453): nothing was swapped`]);
    expect(x.calls.length).toBe(1);
  });

  it("a market sell: a fresh quote of exactly the tokens, then execute by that quote's id, with a wait longer than Guard's", async () => {
    const x = await boot({ "swap quote": quotes({ ...ETH_PRICES, [`ETH>${USDC_BASE}:0.5`]: SELL_HALF }), "swap execute": SUBMITTED });
    ok(await x.t.market("ETH/USDC@Base"));
    x.calls.splice(0);
    const r = ok(await x.t.place({ symbol: "ETH/USDC@Base", side: "sell", type: "market", qty: 0.5, worstPrice: 2430.4, clientId: CLIENT }));
    expect(x.calls).toEqual([
      { args: ["swap", "quote", "--from", "ETH", "--to", USDC_BASE, "--amount", "0.5", "--from-chain-id", "8453", "--slippage", "0.5", "--json"] },
      { args: ["swap", "execute", "--quote-id", "q-sell", "--wallet-timeout", "600", "--json"], timeoutMs: 660_000 },
    ]);
    // submitted is a broadcast, not a fill: pending until mm swap status says COMPLETE
    expect([r.ref, r.status, r.filledQty, r.feeUsd]).toEqual([`q-sell?tx=${HASH}`, "pending", 0, 10.85]);
    // mm takes no client order id: the account's id goes nowhere on the command line, and a retry with it is the same order
    expect(JSON.stringify(x.calls)).not.toContain(CLIENT);
    expect(await x.t.place({ symbol: "ETH/USDC@Base", side: "sell", type: "market", qty: 0.5, worstPrice: 2430.4, clientId: CLIENT })).toBe(r);
    expect(x.calls.length).toBe(2);
  });

  it("a market buy spends qty × ask in USDC (a swap is exact-input), and a relay job without a hash yet rides in the id", async () => {
    const x = await boot({ "swap quote": quotes({ ...ETH_PRICES, [`${USDC_BASE}>ETH:500`]: BUY_FIFTH }), "swap execute": { quoteId: "q-buy", status: "pending", transactions: [], route: "gasless", gasIncluded: true, gasIncluded7702: true, gasless: true, pendingJob: { pollingId: "pl_9", kind: "transaction" } } });
    ok(await x.t.market("ETH/USDC@Base"));
    x.calls.splice(0);
    const r = ok(await x.t.place({ symbol: "ETH/USDC@Base", side: "buy", type: "market", qty: 0.2, worstPrice: 2550, clientId: CLIENT }));
    expect(argvs(x.calls)).toEqual([
      ["swap", "quote", "--from", USDC_BASE, "--to", "ETH", "--amount", "500", "--from-chain-id", "8453", "--slippage", "0.5", "--json"],
      ["swap", "execute", "--quote-id", "q-buy", "--wallet-timeout", "600", "--json"],
    ]);
    expect([r.ref, r.status, r.filledQty, r.feeUsd]).toEqual(["q-buy?job=pl_9", "pending", 0, 4.37]);
    expect((r.native as { answer: { pollingId: string } }).answer.pollingId).toBe("pl_9");
  });

  it("is never a limit order, and is not sent when the least it pays falls outside the worst price", async () => {
    const x = await boot({ "swap quote": quotes({ ...ETH_PRICES, [`${USDC_BASE}>ETH:500`]: quoteData({ id: "q-dear", src: USDC, dst: ETH, spend: "500000000", get: "190000000000000000", least: "189000000000000000" }) }) });
    ok(await x.t.market("ETH/USDC@Base"));
    x.calls.splice(0);
    expect(refusal(await x.t.place({ symbol: "ETH/USDC@Base", side: "buy", type: "limit", qty: 0.2, limitPrice: 2400, clientId: CLIENT })).code).toBe("E_VENUE_ORDER_INVALID");
    expect(refusal(await x.t.place({ symbol: "ETH/USDC@Base", side: "sell", type: "market", qty: 0.123456789, clientId: CLIENT })).code).toBe("E_VENUE_ORDER_INVALID");
    expect(x.calls).toEqual([]);
    const moved = refusal(await x.t.place({ symbol: "ETH/USDC@Base", side: "buy", type: "market", qty: 0.2, clientId: CLIENT }));
    expect([moved.code, moved.message]).toEqual(["E_ACCOUNT_REQUOTE", "the price moved: at worst this swap buys at 2645.502646 USDC per ETH, over the 2550 allowed. Nothing was swapped"]);
    expect(x.calls.map((c) => c.args[1])).toEqual(["quote"]);
  });

  it("stays a market order: a time in force, post-only, reduce-only or a stop is refused before anything is asked", async () => {
    const x = await boot({ "swap quote": quotes(ETH_PRICES), "swap execute": SUBMITTED });
    ok(await x.t.market("ETH/USDC@Base"));
    x.calls.splice(0);
    const sell = (o: Partial<OrderRequest>, clientId: string) => x.t.place({ symbol: "ETH/USDC@Base", side: "sell", type: "market", qty: 0.5, clientId, ...o });
    const flags: Array<[Partial<OrderRequest>, string]> = [[{ tif: "fok" }, "s1"], [{ tif: "ioc" }, "s2"], [{ tif: "gtc" }, "s3"], [{ postOnly: true }, "s4"], [{ reduceOnly: true }, "s5"]];
    for (const [o, id] of flags) {
      const r = refusal(await sell(o, id));
      expect([r.code, r.message]).toEqual(["E_VENUE_ORDER_INVALID", "MetaMask's swaps: a swap takes no time in force, post-only or reduce-only: it lands whole on chain, or reverts"]);
    }
    expect(refusal(await sell({ type: "stop", stopPrice: 2400, worstPrice: 2350 }, "s6")).message).toBe("MetaMask's swaps: a swap is a market order: mm takes no limit or stop price");
    expect(refusal(await sell({ type: "stop_limit", stopPrice: 2400, limitPrice: 2390 }, "s7")).code).toBe("E_VENUE_ORDER_INVALID");
    // a stop price on a market order is not dropped quietly
    expect(refusal(await sell({ stopPrice: 2400 }, "s8")).message).toBe("MetaMask's swaps: a swap is a market order: mm takes no limit or stop price");
    expect(x.calls).toEqual([]);
  });

  it("with MetaMask's own switch off, prints the commands that would run and runs none", async () => {
    const x = await boot({ "swap quote": quotes(ETH_PRICES) }, {});
    ok(await x.t.market("ETH/USDC@Base"));
    x.calls.splice(0);
    const r = refusal(await x.t.place({ symbol: "ETH/USDC@Base", side: "sell", type: "market", qty: 0.5, clientId: CLIENT }));
    expect([r.code, r.message]).toEqual(["E_WALLET_LIVE_WRITES_OFF", `MetaMask's own switch is off (PORTFOLIO_MM_WRITES is not 1). The commands that would run: mm swap quote --from ETH --to ${USDC_BASE} --amount 0.5 --from-chain-id 8453 --slippage 0.5 --json, then mm swap execute --quote-id <that quote's quoteId> --wallet-timeout 600 --json`]);
    expect(x.calls).toEqual([]);
  });

  it("a Guard pause that outlasts mm's wait is pending, not refused, and is followed to its fill through the wallet job", async () => {
    const notice = { kind: "AWAITING_MFA", source: "swap:execute", pollingId: "pl_123", authMethod: "browser", message: "Approve in your email" };
    const x = await boot({
      "swap quote": quotes({ ...ETH_PRICES, [`${USDC_BASE}>ETH:500`]: BUY_FIFTH }),
      "swap execute": fail("JOB_TIMEOUT", "Timed out waiting for the wallet job.", "Run `mm wallet requests watch pl_123` to keep tracking it.", [notice]),
      "swap status": (args: string[]) => (args.includes("--tx-hash") ? swapStatus("COMPLETE", [leg("trade", "confirmed", "495.63", "USDC", HASH2), leg("receive", "confirmed", "0.2", "ETH", HASH2)]) : swapStatus("QUOTED")),
      "wallet requests list": { requests: [{ pollingId: "pl_123", kind: "transaction", namespace: "eip155", submittedAt: "2026-10-05T14:00:01Z", status: "CONFIRMED", txHash: HASH2, intent: { action: "swap", summary: "Swap 500 USDC for ~0.2 ETH on Base via uniswap" } }] },
    });
    ok(await x.t.market("ETH/USDC@Base"));
    const r = ok(await x.t.place({ symbol: "ETH/USDC@Base", side: "buy", type: "market", qty: 0.2, clientId: CLIENT }));
    expect([r.ref, r.status]).toEqual(["q-buy?job=pl_123", "pending"]);
    expect((r.native as { waiting: string }).waiting).toContain("MetaMask's Guard asked you to approve this swap");
    x.calls.splice(0);
    const s = ok(await x.t.status(r.ref, "ETH/USDC@Base"));
    expect(argvs(x.calls)).toEqual([
      ["swap", "status", "--quote-id", "q-buy", "--json"],
      ["wallet", "requests", "list", "--json"],
      ["swap", "status", "--quote-id", "q-buy", "--tx-hash", HASH2, "--json"],
    ]);
    // what was spent is what place() quoted (MetaMask's fee inside it), and what arrived is mm's figure
    expect([s.ref, s.status, s.filledQty, s.avgPrice, s.feeUsd]).toEqual([`q-buy?tx=${HASH2}`, "filled", 0.2, 2500, 4.37]);
  });

  it("an execute paused for Guard with no hash yet is pending; a revert, a denial and a missing balance are refused", async () => {
    const x = await boot({ "swap quote": quotes({ ...ETH_PRICES, [`ETH>${USDC_BASE}:0.5`]: SELL_HALF }) });
    ok(await x.t.market("ETH/USDC@Base"));
    const sell = (clientId: string) => x.t.place({ symbol: "ETH/USDC@Base", side: "sell", type: "market", qty: 0.5, clientId });
    x.answers["swap execute"] = fail("EXECUTE_FAILED", "Swap is awaiting MFA approval (request pl_7). Approve it, then run mm swap status.");
    expect([ok(await sell("a1")).ref, ok(await sell("a1")).status]).toEqual(["q-sell?job=pl_7", "pending"]);
    // an execute that ended with no envelope (killed, crashed) may have submitted its job: pending, never refused
    x.answers["swap execute"] = fail("UNPARSEABLE", "Error: something broke at x");
    expect([ok(await sell("a0")).ref, ok(await sell("a0")).status]).toEqual(["q-sell", "pending"]);
    x.answers["swap execute"] = fail("TX_REVERTED", "The transaction reverted on chain; funds may have been spent on gas.");
    expect(refusal(await sell("a2")).code).toBe("E_VENUE_REJECTED");
    x.answers["swap execute"] = fail("TX_DENIED", "The approval was denied on the paired device / registered email.");
    const denied = refusal(await sell("a3"));
    expect([denied.code, denied.message]).toEqual(["E_VENUE_PERMISSION", "MetaMask's Guard asked you to approve this, and it was denied: nothing was sent"]);
    x.answers["swap execute"] = fail("INSUFFICIENT_FUNDS", "Insufficient ETH balance to execute this swap. Fund the wallet or lower the amount and re-quote.", "Check balances with `mm wallet balance`.");
    const poor = refusal(await sell("a4"));
    expect(poor.code).toBe("E_VENUE_INSUFFICIENT");
    expect(poor.native).toEqual({ command: "mm swap execute --quote-id q-sell --wallet-timeout 600 --json", code: "INSUFFICIENT_FUNDS", said: "Insufficient ETH balance to execute this swap. Fund the wallet or lower the amount and re-quote.", hint: "Check balances with `mm wallet balance`." });
    x.answers["swap execute"] = fail("WRONG_WALLET_MODE", "This command needs a server wallet.");
    expect(refusal(await sell("a5")).code).toBe("E_VENUE_PERMISSION");
    // a refused id may be tried again: it placed nothing
    x.answers["swap execute"] = SUBMITTED;
    expect(ok(await sell("a5")).status).toBe("pending");
  });

  it("maps MetaMask's soft and hard quote refusals, and keeps a BYOK password out of every word", async () => {
    const x = await boot({}, { ...ON, MM_PASSWORD: PASSWORD });
    const quoteSays = async (answer: unknown) => {
      x.answers["swap quote"] = answer;
      return refusal(await x.t.market("ETH/USDC@Base"));
    };
    expect((await quoteSays({ kind: "unavailable", reason: "AMOUNT_TOO_LOW", message: "Amount below the provider minimum.", hint: "Increase --amount" })).code).toBe("E_VENUE_ORDER_INVALID");
    expect((await quoteSays({ kind: "unavailable", reason: "RWA_GEO_RESTRICTED", message: "This asset is restricted in your region." })).code).toBe("E_VENUE_GEOBLOCKED");
    expect((await quoteSays({ kind: "unavailable", reason: "RWA_MARKET_UNAVAILABLE", message: "This RWA market is currently unavailable." })).code).toBe("E_VENUE_MARKET_CLOSED");
    expect((await quoteSays({ kind: "unavailable", reason: "NO_QUOTES", message: "No routes found for this request." })).code).toBe("E_VENUE_REJECTED");
    expect((await quoteSays(fail("TOKEN_NOT_FOUND", "Token PEPE was not found on Base."))).code).toBe("E_VENUE_ORDER_INVALID");
    expect((await quoteSays(fail("AUTH_FAILED", "Authentication failed."))).code).toBe("E_VENUE_UNAUTHORIZED");
    expect((await quoteSays(fail("RATE_LIMITED", "Too many requests."))).code).toBe("E_VENUE_UNREACHABLE");
    expect((await quoteSays(fail("BRIDGE_API_ERROR", "Bridge API returned HTTP 429."))).code).toBe("E_VENUE_UNREACHABLE");
    const leaked = await quoteSays(fail("WALLET_ERROR", `could not unlock with --password ${PASSWORD}`));
    expect((leaked.native as { said: string }).said).toBe("could not unlock with --password •••");
  });

  it("keeps a BYOK mnemonic out of every word too, from the trader and from the source's own reads", async () => {
    const MNEMONIC = "made up words that are not a real phrase\nsecond line of the made up phrase";
    const env = { ...ON, MM_MNEMONIC: MNEMONIC };
    const x = await boot({ "swap quote": fail("WALLET_ERROR", `invalid mnemonic: ${MNEMONIC}`) }, env);
    const r = refusal(await x.t.market("ETH/USDC@Base"));
    expect(JSON.stringify(r)).not.toContain("made up words");
    expect((r.native as { said: string }).said).toBe("invalid mnemonic: •••");
    const s = standIn({ "wallet show": fail("WALLET_ERROR", `invalid mnemonic: ${MNEMONIC}`) });
    const none = refusal(await metamaskSource({ venue: "metamask", label: "", run: s.run, env }));
    expect(JSON.stringify(none)).not.toContain("made up words");
  });

  it("status: every state mm swap status has, and a wallet job denied or expired", async () => {
    const x = await boot();
    const at = async (answer: unknown, ref = "q-old") => {
      x.answers["swap status"] = answer;
      return ok(await x.t.status(ref, "ETH/USDC@Base"));
    };
    expect((await at(swapStatus("QUOTED"))).status).toBe("pending");
    expect((await at(swapStatus("PENDING", [leg("trade", "pending", "0.5", "ETH")]))).status).toBe("open");
    const sent = await at(swapStatus("SUBMITTED", [leg("trade", "submitted", "0.5", "ETH")]));
    expect([sent.status, sent.ref]).toEqual(["open", `q-old?tx=${HASH}`]);
    expect((await at(swapStatus("UNKNOWN"))).status).toBe("pending");
    expect((await at(swapStatus("FAILED", [leg("trade", "failed", "0.5", "ETH")]))).status).toBe("rejected");
    // after a restart nothing is remembered of the order: mm's own legs say which side it was and what moved
    const done = await at(swapStatus("COMPLETE", [leg("trade", "confirmed", "0.5", "ETH"), leg("receive", "confirmed", "1240", "USDC")]));
    expect([done.status, done.filledQty, done.avgPrice]).toEqual(["filled", 0.5, 2480]);
    x.answers["wallet requests list"] = { requests: [{ pollingId: "pl_1", status: "DENIED" }, { pollingId: "pl_2", status: "EXPIRED" }, { pollingId: "pl_3", status: "AWAITING_MFA" }] };
    expect((await at(swapStatus("QUOTED"), "q-old?job=pl_1")).status).toBe("rejected");
    expect((await at(swapStatus("QUOTED"), "q-old?job=pl_2")).status).toBe("expired");
    expect((await at(swapStatus("QUOTED"), "q-old?job=pl_3")).status).toBe("pending");
    // a quote this machine no longer has (pruned after 24 hours, or another machine's) is an order mm does not know
    x.answers["swap status"] = fail("QUOTE_NOT_FOUND", 'Quote "q-gone" was not found. Run `mm swap quote` first.');
    expect(refusal(await x.t.status("q-gone", "ETH/USDC@Base")).code).toBe("E_ACCOUNT_ORDER_UNKNOWN");
  });

  it("cannot be called back: a swap still on its way is refused, a finished one is read back as it stands", async () => {
    const x = await boot({ "swap status": swapStatus("PENDING", [leg("trade", "pending", "0.5", "ETH")]) });
    const r = refusal(await x.t.cancel("q-sell", "ETH/USDC@Base"));
    expect(r.code).toBe("E_VENUE_REJECTED");
    expect(r.message).toContain("have no cancel");
    x.answers["swap status"] = swapStatus("COMPLETE", [leg("trade", "confirmed", "0.5", "ETH"), leg("receive", "confirmed", "1240", "USDC")]);
    expect(ok(await x.t.cancel("q-sell", "ETH/USDC@Base")).status).toBe("filled");
    expect(x.calls.every((c) => c.args[0] === "swap" && c.args[1] === "status")).toBe(true);
  });
});

// ---- Polymarket orders ----------------------------------------------------------------------------------------------

describe("a Polymarket order through mm", () => {
  it("market(): the outcome's book, its tick and minimum, and whether Polymarket takes orders in it now", async () => {
    const x = await boot(PM_MARKET);
    const m = ok(await x.t.market(`${SLUG}:yes`));
    expect(m).toEqual<Market>({ symbol: `${SLUG}:Yes`, name: "Fed cuts rates in December? · Yes", kind: "event", base: "Yes", quote: "pUSD", price: 0.175, bid: 0.17, ask: 0.18, minQty: 5, qtyStep: 0.01, priceStep: 0.01, open: true, note: expect.stringContaining("a Polymarket order through mm, paid in pUSD") as unknown as string, types: ["limit", "market"], tifs: ["gtc", "ioc", "fok"], postOnly: true, sellsReduce: true });
    // what mm predict place takes, and nothing it does not: no reduce-only flag, no leverage
    expect(Object.keys(m).filter((k) => k === "reduceOnly" || k === "maxLeverage")).toEqual([]);
    expect(inDollars(m.quote)).toBe(true);
    expect(argvs(x.calls)).toEqual([["predict", "markets", "get", "--market", SLUG, "--json"], ["predict", "book", TID_YES, "--json"]]);
    // by an outcome's token id: the book names the market, the market names the outcome, and the account's symbol is the same
    x.calls.splice(0);
    expect(ok(await x.t.market(TID_YES)).symbol).toBe(`${SLUG}:Yes`);
    expect(argvs(x.calls)).toEqual([["predict", "book", TID_YES, "--json"], ["predict", "markets", "get", "--market", CID, "--json"]]);
    expect(refusal(await x.t.market(`${SLUG}:Maybe`)).message).toBe(`Polymarket's market ${SLUG} has the outcomes Yes, No, not Maybe`);
  });

  it("is closed when Polymarket says so, and when its end date has passed (the window before resolution)", async () => {
    const x = await boot(PM_MARKET);
    const closedBy = async (over: Record<string, unknown>) => {
      x.answers["predict markets get"] = marketGet(over);
      return ok(await x.t.market(`${SLUG}:Yes`));
    };
    expect([(await closedBy({ closed: true })).open, (await closedBy({ closed: true })).note]).toEqual([false, "Polymarket has closed this market"]);
    expect((await closedBy({ acceptingOrders: false })).note).toBe("Polymarket is not accepting orders in this market now");
    expect((await closedBy({ active: false })).note).toBe("Polymarket lists this market as inactive");
    const ended = await closedBy({ endDate: "2026-10-05T03:59:00Z" });
    expect([ended.open, ended.note]).toEqual([false, "its end date (2026-10-05T03:59:00Z) has passed: it is waiting for resolution, when trading it is high-risk, so the account does not"]);
    x.calls.splice(0);
    expect(refusal(await x.t.place({ symbol: `${SLUG}:Yes`, side: "buy", type: "limit", qty: 10, limitPrice: 0.18, clientId: CLIENT })).code).toBe("E_VENUE_MARKET_CLOSED");
    expect(x.calls).toEqual([]);
  });

  it("a limit order: Polymarket's region check first, then a GTC order at the price, accepted only with success and an order id", async () => {
    const x = await boot({ ...PM_MARKET, "predict geoblock": NOT_BLOCKED, "predict place": placed({}) });
    ok(await x.t.market(`${SLUG}:Yes`));
    x.calls.splice(0);
    const r = ok(await x.t.place({ symbol: `${SLUG}:Yes`, side: "buy", type: "limit", qty: 10, limitPrice: 0.18, clientId: CLIENT }));
    expect(x.calls).toEqual([
      { args: ["predict", "geoblock", "--json"] },
      { args: ["predict", "place", "--token-id", TID_YES, "--side", "buy", "--size", "10", "--price", "0.18", "--order-type", "GTC", "--json"], timeoutMs: 660_000 },
    ]);
    expect([r.ref, r.status, r.filledQty, r.avgPrice]).toEqual([ORDER, "open", 0, undefined]);
    expect(JSON.stringify(r)).not.toContain("203.0.113.9");
    expect(JSON.stringify(x.calls)).not.toContain(CLIENT);
    expect(await x.t.place({ symbol: `${SLUG}:Yes`, side: "buy", type: "limit", qty: 10, limitPrice: 0.18, clientId: CLIENT })).toBe(r);
    expect(x.calls.length).toBe(2);
  });

  it("a market order is fill-and-kill at its worst price, snapped to the tick on the safe side and kept inside [tick, 1 − tick]", async () => {
    const x = await boot({ ...PM_MARKET, "predict geoblock": NOT_BLOCKED, "predict place": placed({ status: "matched", makingAmount: "1.8", takingAmount: "10" }) });
    ok(await x.t.market(`${SLUG}:Yes`));
    x.calls.splice(0);
    const buy = ok(await x.t.place({ symbol: `${SLUG}:Yes`, side: "buy", type: "market", qty: 10, worstPrice: 0.18, clientId: "b1" }));
    expect(x.calls[1]!.args).toEqual(["predict", "place", "--token-id", TID_YES, "--side", "buy", "--size", "10", "--price", "0.18", "--order-type", "FAK", "--json"]);
    expect([buy.status, buy.filledQty, buy.avgPrice]).toEqual(["filled", 10, 0.18]);
    // a sell: what did not fill at once was canceled, and what filled is kept
    x.answers["predict place"] = placed({ status: "matched", makingAmount: "4", takingAmount: "0.68" });
    const sell = ok(await x.t.place({ symbol: `${SLUG}:Yes`, side: "sell", type: "market", qty: 10, clientId: "s1" }));
    expect(x.calls[3]!.args.slice(8, 13)).toEqual(["--price", "0.17", "--order-type", "FAK", "--json"]);
    expect([sell.status, sell.filledQty, sell.avgPrice]).toEqual(["canceled", 4, 0.17]);
    // a worst price past 1 − tick is held at 1 − tick
    x.answers["predict book"] = bookOf({ asks: [{ price: "0.99", size: "10" }] });
    ok(await x.t.market(`${SLUG}:Yes`));
    x.answers["predict place"] = placed({ status: "matched", makingAmount: "1800000", takingAmount: "10000000" });
    const dear = ok(await x.t.place({ symbol: `${SLUG}:Yes`, side: "buy", type: "market", qty: 10, clientId: "b2" }));
    expect(x.calls.at(-1)!.args.slice(8, 11)).toEqual(["--price", "0.99", "--order-type"]);
    // amounts in base units (an integer a million times the order) are read as such
    expect([dear.filledQty, dear.avgPrice]).toEqual([10, 0.18]);
  });

  it("every placement status Polymarket answers, and a 200 that is not an acceptance", async () => {
    const x = await boot({ ...PM_MARKET, "predict geoblock": NOT_BLOCKED });
    ok(await x.t.market(`${SLUG}:Yes`));
    let n = 0;
    const answered = async (response: Record<string, unknown>, type: "limit" | "market" = "limit") => {
      x.answers["predict place"] = placed(response);
      return x.t.place({ symbol: `${SLUG}:Yes`, side: "buy", type, qty: 10, ...(type === "limit" ? { limitPrice: 0.18 } : {}), clientId: `c${++n}` });
    };
    expect(ok(await answered({ status: "live" })).status).toBe("open");
    const part = ok(await answered({ status: "live", makingAmount: "0.54", takingAmount: "3" }));
    expect([part.status, part.filledQty, part.avgPrice]).toEqual(["partial", 3, 0.18]);
    expect(ok(await answered({ status: "matched", makingAmount: "1.8", takingAmount: "10" })).status).toBe("filled");
    // a GTC order matched in part: the rest rests on the book, so it is partly filled and still followed, never done
    const rest = ok(await answered({ status: "matched", makingAmount: "0.54", takingAmount: "3" }));
    expect([rest.status, rest.filledQty, rest.avgPrice]).toEqual(["partial", 3, 0.18]);
    // base units: both amounts are read in the unit the dollars show, so a small partial fill is not read as millions of shares
    const small = ok(await answered({ status: "matched", makingAmount: "90000", takingAmount: "500000" }, "market"));
    expect([small.status, small.filledQty, small.avgPrice]).toEqual(["canceled", 0.5, 0.18]);
    expect(ok(await answered({ status: "delayed" })).status).toBe("pending");
    expect(ok(await answered({ status: "unmatched" })).status).toBe("pending");
    const poor = refusal(await answered({ orderId: "", status: "", success: false, errorMsg: "not enough balance / allowance" }));
    expect([poor.code, (poor.native as { said: string }).said]).toEqual(["E_VENUE_INSUFFICIENT", "not enough balance / allowance"]);
    expect(refusal(await answered({ orderId: "", success: true })).code).toBe("E_VENUE_REJECTED");
  });

  it("refuses what Polymarket would not take before asking, and maps what it refuses", async () => {
    const x = await boot({ ...PM_MARKET, "predict geoblock": NOT_BLOCKED });
    ok(await x.t.market(`${SLUG}:Yes`));
    x.calls.splice(0);
    const limit = (qty: number, limitPrice: number, clientId: string) => x.t.place({ symbol: `${SLUG}:Yes`, side: "buy", type: "limit", qty, limitPrice, clientId });
    expect(refusal(await limit(2, 0.18, "v1")).message).toBe("Polymarket: the smallest order in Fed cuts rates in December? · Yes is 5 shares");
    expect(refusal(await limit(10.005, 0.18, "v2")).code).toBe("E_VENUE_ORDER_INVALID");
    expect(refusal(await limit(10, 0.185, "v3")).code).toBe("E_VENUE_ORDER_INVALID");
    expect(refusal(await limit(10, 1, "v4")).message).toBe("Polymarket: a price is between 0.01 and 0.99");
    expect(x.calls).toEqual([]);
    const says = async (err: MmError, id: string) => {
      x.answers["predict place"] = err;
      return refusal(await limit(10, 0.18, id));
    };
    expect((await says(fail("PREDICT_ORDER_SIZE_TOO_SMALL", "order 0x1 is invalid. Size (2) lower than the minimum: 5"), "e1")).code).toBe("E_VENUE_ORDER_INVALID");
    expect((await says(fail("PREDICT_INSUFFICIENT_BALANCE", "Insufficient Predict COLLATERAL balance. Required 1800000 base units, available 0."), "e2")).code).toBe("E_VENUE_INSUFFICIENT");
    const setup = await says(fail("PREDICT_SETUP_REQUIRED", "Predict setup is not complete."), "e3");
    expect([setup.code, setup.message]).toEqual(["E_VENUE_PERMISSION", "the wallet is not set up to trade on Polymarket: run mm predict setup --wait in a terminal first"]);
    expect((await says(fail("PREDICT_AUTH_INVALID", "Unauthorized/Invalid api key"), "e4")).code).toBe("E_VENUE_UNAUTHORIZED");
    expect((await says(fail("PREDICT_UNAVAILABLE_FOR_LEGAL_REASONS", "Unavailable for legal reasons"), "e5")).code).toBe("E_VENUE_GEOBLOCKED");
    expect((await says(fail("PREDICT_ERROR", "'0x00000000000000000000000000000000000000Dd' address in closed only mode"), "e6")).code).toBe("E_VENUE_GEOBLOCKED");
    expect((await says(fail("PREDICT_ERROR", "the market is not yet ready to process new orders"), "e7")).code).toBe("E_VENUE_MARKET_CLOSED");
    expect((await says(fail("PREDICT_ERROR", "Trading is currently cancel-only. Try again later."), "e8")).code).toBe("E_VENUE_MARKET_CLOSED");
    expect((await says(fail("RATE_LIMITED", "Too many requests"), "e9")).code).toBe("E_VENUE_UNREACHABLE");
    expect((await says(fail("PREDICT_ORDER_NOT_FILLED", "order couldn't be fully filled. FOK orders are fully filled or killed."), "e10")).code).toBe("E_VENUE_REJECTED");
  });

  it("from a place Polymarket does not serve: E_VENUE_GEOBLOCKED, and nothing else is asked", async () => {
    const x = await boot({ ...PM_MARKET, "predict geoblock": { command: "geoblock", result: { blocked: true, ip: "198.51.100.23", country: "US", region: "PA" } }, "predict place": placed({}) });
    ok(await x.t.market(`${SLUG}:Yes`));
    x.calls.splice(0);
    const r = refusal(await x.t.place({ symbol: `${SLUG}:Yes`, side: "sell", type: "limit", qty: 10, limitPrice: 0.2, clientId: CLIENT }));
    expect([r.code, r.message]).toEqual(["E_VENUE_GEOBLOCKED", "Polymarket does not take orders from this location (US-PA): that is its own rule, and the account does not look for a way around it. Nothing was placed"]);
    expect(argvs(x.calls)).toEqual([["predict", "geoblock", "--json"]]);
    expect(JSON.stringify(r)).not.toContain("198.51.100.23");
    // mm's own refusal of the check, and an answer that says neither, place nothing either
    x.answers["predict geoblock"] = fail("PREDICT_GEOBLOCKED", "Polymarket is not available in your region.");
    expect(refusal(await x.t.place({ symbol: `${SLUG}:Yes`, side: "sell", type: "limit", qty: 10, limitPrice: 0.2, clientId: "g2" })).code).toBe("E_VENUE_GEOBLOCKED");
    x.answers["predict geoblock"] = { command: "geoblock", result: {} };
    expect(refusal(await x.t.place({ symbol: `${SLUG}:Yes`, side: "sell", type: "limit", qty: 10, limitPrice: 0.2, clientId: "g3" })).code).toBe("E_VENUE_REJECTED");
    expect(x.calls.some((c) => c.args[1] === "place")).toBe(false);
  });

  it("with MetaMask's own switch off, prints the check and the order that would run, and runs neither", async () => {
    const x = await boot(PM_MARKET, {});
    ok(await x.t.market(`${SLUG}:Yes`));
    x.calls.splice(0);
    const r = refusal(await x.t.place({ symbol: `${SLUG}:Yes`, side: "buy", type: "limit", qty: 10, limitPrice: 0.18, clientId: CLIENT }));
    expect([r.code, r.message]).toEqual(["E_WALLET_LIVE_WRITES_OFF", `MetaMask's own switch is off (PORTFOLIO_MM_WRITES is not 1). The commands that would run: mm predict geoblock --json, then mm predict place --token-id ${TID_YES} --side buy --size 10 --price 0.18 --order-type GTC --json`]);
    expect(x.calls).toEqual([]);
  });

  it("status: the order as Polymarket lists it among the open ones, by every status it has", async () => {
    const x = await boot(PM_MARKET);
    const at = async (over: Record<string, unknown>) => {
      x.answers["predict orders"] = openOrders([{ ...order(), ...over }]);
      return ok(await x.t.status(ORDER, `${SLUG}:Yes`));
    };
    expect((await at({})).status).toBe("open");
    // after a restart the market's condition id is looked up once, then kept
    expect(argvs(x.calls)).toEqual([["predict", "markets", "get", "--market", SLUG, "--json"], ["predict", "orders", "--market", CID, "--json"]]);
    const part = await at({ size_matched: "3" });
    expect([part.status, part.filledQty, part.avgPrice]).toEqual(["partial", 3, 0.18]);
    const done = await at({ status: "MATCHED", size_matched: "10" });
    expect([done.status, done.filledQty]).toEqual(["filled", 10]);
    expect((await at({ status: "CANCELED", size_matched: "2" })).status).toBe("canceled");
    expect((await at({ status: "CANCELED_MARKET_RESOLVED" })).status).toBe("canceled");
    expect((await at({ status: "INVALID" })).status).toBe("rejected");
    expect(x.calls.filter((c) => c.args[1] === "markets").length).toBe(1);
    // gone from the open orders: mm 7.0.0 cannot say whether it filled or was canceled, and the account is told exactly that
    x.answers["predict orders"] = openOrders([]);
    const gone = refusal(await x.t.status(ORDER, `${SLUG}:Yes`));
    expect(gone.code).toBe("E_ACCOUNT_ORDER_UNKNOWN");
    expect(gone.message).toContain("mm has no call that says whether it filled, was canceled or expired");
  });

  it("cancel: read as it stands, canceled by its id (no switch: it moves nothing), and an order already matched is filled", async () => {
    const x = await boot({ ...PM_MARKET, "predict orders": openOrders([{ ...order(), size_matched: "3" }]), "predict cancel": { command: "cancel", params: { orderId: ORDER }, result: { chainId: 137, ownerAddress: WALLET, response: { canceled: [ORDER], notCanceled: {} } } } }, {});
    ok(await x.t.market(`${SLUG}:Yes`));
    x.calls.splice(0);
    const c = ok(await x.t.cancel(ORDER, `${SLUG}:Yes`));
    expect(argvs(x.calls)).toEqual([["predict", "orders", "--market", CID, "--json"], ["predict", "cancel", "--order-id", ORDER, "--json"]]);
    expect([c.ref, c.status, c.filledQty, c.avgPrice]).toEqual([ORDER, "canceled", 3, 0.18]);
    expect(x.calls.some((call) => call.args.includes("--all"))).toBe(false);
    x.answers["predict cancel"] = { command: "cancel", result: { response: { canceled: [], notCanceled: { [ORDER]: "order already matched" } } } };
    const matched = ok(await x.t.cancel(ORDER, `${SLUG}:Yes`));
    expect([matched.status, matched.filledQty]).toEqual(["filled", 10]);
    x.answers["predict cancel"] = { command: "cancel", result: { response: { canceled: [], notCanceled: { [ORDER]: "order is being processed" } } } };
    expect(refusal(await x.t.cancel(ORDER, `${SLUG}:Yes`)).message).toBe("Polymarket did not cancel 0x5f00…0011: order is being processed");
    // an order no longer among the open ones is not asked to cancel
    x.answers["predict orders"] = openOrders([]);
    x.calls.splice(0);
    expect(refusal(await x.t.cancel(ORDER, `${SLUG}:Yes`)).code).toBe("E_ACCOUNT_ORDER_UNKNOWN");
    expect(x.calls.map((call) => call.args[1])).toEqual(["orders"]);
  });
});

// ---- a Polymarket order's time in force and post-only ------------------------------------------------------------------

describe("a Polymarket order's time in force and post-only, as mm predict place takes them", () => {
  const BUY = { symbol: `${SLUG}:Yes`, side: "buy", type: "limit", qty: 10, limitPrice: 0.18 } as const;
  /** what mm was sent from the price on: the price, the order type, --post-only when asked */
  const tail = (calls: Call[]) => {
    const a = calls.find((c) => c.args[1] === "place")!.args;
    return a.slice(a.indexOf("--price"));
  };

  it("each time in force is the order type mm takes: GTC rests, IOC is FAK, FOK is FOK; a market order is FAK unless FOK is asked", async () => {
    // a resting order is live on the book; one that fills at once comes back matched
    const answer = (args: string[]) => placed(args.includes("GTC") ? {} : args.includes("sell") ? { status: "matched", makingAmount: "10", takingAmount: "1.7" } : { status: "matched", makingAmount: "1.8", takingAmount: "10" });
    const x = await boot({ ...PM_MARKET, "predict geoblock": NOT_BLOCKED, "predict place": answer });
    ok(await x.t.market(`${SLUG}:Yes`));
    const sent = async (o: Partial<OrderRequest>, clientId: string) => {
      x.calls.splice(0);
      const r = ok(await x.t.place({ ...BUY, clientId, ...o }));
      return [...tail(x.calls), r.status];
    };
    expect(await sent({}, "t1")).toEqual(["--price", "0.18", "--order-type", "GTC", "--json", "open"]);
    expect(await sent({ tif: "gtc" }, "t2")).toEqual(["--price", "0.18", "--order-type", "GTC", "--json", "open"]);
    // IOC and FOK at a limit: the limit is the worst price a fill may take
    expect(await sent({ tif: "ioc" }, "t3")).toEqual(["--price", "0.18", "--order-type", "FAK", "--json", "filled"]);
    expect(await sent({ tif: "fok" }, "t4")).toEqual(["--price", "0.18", "--order-type", "FOK", "--json", "filled"]);
    const atMarket = { type: "market", limitPrice: undefined, worstPrice: 0.18 } as const;
    expect(await sent(atMarket, "t5")).toEqual(["--price", "0.18", "--order-type", "FAK", "--json", "filled"]);
    expect(await sent({ ...atMarket, tif: "ioc" }, "t6")).toEqual(["--price", "0.18", "--order-type", "FAK", "--json", "filled"]);
    expect(await sent({ ...atMarket, tif: "fok" }, "t7")).toEqual(["--price", "0.18", "--order-type", "FOK", "--json", "filled"]);
    // a FOK sell at market: its worst price snapped up to the tick, never looser
    expect(await sent({ side: "sell", type: "market", limitPrice: undefined, worstPrice: 0.1666, tif: "fok" }, "t8")).toEqual(["--price", "0.17", "--order-type", "FOK", "--json", "filled"]);
  });

  it("what mm or Polymarket would not take is refused before anything is asked: a GTC market order, DAY, post-only that could take, reduce-only, a stop", async () => {
    const x = await boot({ ...PM_MARKET, "predict geoblock": NOT_BLOCKED, "predict place": placed({}) });
    ok(await x.t.market(`${SLUG}:Yes`));
    x.calls.splice(0);
    const refused = async (o: Partial<OrderRequest>, clientId: string) => {
      const r = refusal(await x.t.place({ ...BUY, clientId, ...o }));
      expect(r.code).toBe("E_VENUE_ORDER_INVALID");
      return r.message;
    };
    expect(await refused({ type: "market", limitPrice: undefined, tif: "gtc" }, "r1")).toBe("Polymarket: a market order fills at once (IOC or FOK): only a limit order rests until canceled");
    expect(await refused({ tif: "day" }, "r2")).toBe("Polymarket: mm places GTC, IOC or FOK orders here, not DAY");
    expect(await refused({ tif: "ioc", postOnly: true }, "r3")).toBe("Polymarket: a post-only order rests on the book or is refused, and IOC never rests: mm takes --post-only only for an order that rests (GTC)");
    expect(await refused({ tif: "fok", postOnly: true }, "r4")).toContain("FOK never rests");
    expect(await refused({ type: "market", limitPrice: undefined, postOnly: true }, "r5")).toBe("Polymarket: post-only is for a limit order");
    // mm has no reduce-only flag: a reduce-only order is not sent as a plain one
    expect(await refused({ reduceOnly: true }, "r6")).toBe("Polymarket: mm takes no reduce-only flag for an order here");
    expect(await refused({ side: "sell", type: "market", limitPrice: undefined, reduceOnly: true }, "r7")).toBe("Polymarket: mm takes no reduce-only flag for an order here");
    expect(await refused({ type: "stop", limitPrice: undefined, stopPrice: 0.2, worstPrice: 0.21 }, "r8")).toBe("Polymarket: mm places limit and market orders here, not stop orders");
    expect(await refused({ type: "stop_limit", stopPrice: 0.2 }, "r9")).toBe("Polymarket: mm places limit and market orders here, not stop-limit orders");
    expect(await refused({ stopPrice: 0.2 }, "r10")).toBe("Polymarket: mm places no stop orders here, so an order carries no stop price");
    // a time in force from outside the type (an agent's JSON): nothing but GTC, FAK or FOK ever reaches mm's argv
    expect(await refused({ tif: "constructor" as unknown as OrderRequest["tif"] }, "r11")).toBe("Polymarket: mm places GTC, IOC or FOK orders here, not CONSTRUCTOR");
    // with MetaMask's switch on, not even Polymarket's region check was asked
    expect(x.calls).toEqual([]);
  });

  it("post-only rides on a GTC limit order as --post-only; one priced to take at once is refused as written", async () => {
    const x = await boot({ ...PM_MARKET, "predict geoblock": NOT_BLOCKED, "predict place": placed({}) });
    ok(await x.t.market(`${SLUG}:Yes`));
    x.calls.splice(0);
    const r = ok(await x.t.place({ ...BUY, limitPrice: 0.17, postOnly: true, clientId: "p1" }));
    expect(x.calls).toEqual([
      { args: ["predict", "geoblock", "--json"] },
      { args: ["predict", "place", "--token-id", TID_YES, "--side", "buy", "--size", "10", "--price", "0.17", "--order-type", "GTC", "--post-only", "--json"], timeoutMs: 660_000 },
    ]);
    expect([r.status, r.filledQty]).toEqual(["open", 0]);
    x.calls.splice(0);
    ok(await x.t.place({ ...BUY, limitPrice: 0.17, tif: "gtc", postOnly: true, clientId: "p2" }));
    expect(tail(x.calls)).toEqual(["--price", "0.17", "--order-type", "GTC", "--post-only", "--json"]);
    // Polymarket's own words for a post-only order that would have taken at once
    x.answers["predict place"] = fail("PREDICT_ERROR", "invalid post-only order: order crosses book");
    const crossed = refusal(await x.t.place({ ...BUY, postOnly: true, clientId: "p3" }));
    expect([crossed.code, crossed.message]).toEqual(["E_VENUE_ORDER_INVALID", "Polymarket: invalid post-only order: order crosses book"]);
    // in Polymarket's post-only mode, an order that is not post-only is turned away in its words
    x.answers["predict place"] = fail("PREDICT_ERROR", "post-only mode: only post-only orders and cancels are allowed");
    const plainOne = refusal(await x.t.place({ ...BUY, clientId: "p4" }));
    expect([plainOne.code, plainOne.message]).toEqual(["E_VENUE_MARKET_CLOSED", "Polymarket takes no orders here now: post-only mode: only post-only orders and cancels are allowed"]);
  });

  it("what became of an IOC or FOK order: IOC's unfilled rest is canceled, FOK fills whole, and a FOK Polymarket killed placed nothing", async () => {
    const x = await boot({ ...PM_MARKET, "predict geoblock": NOT_BLOCKED });
    ok(await x.t.market(`${SLUG}:Yes`));
    x.answers["predict place"] = placed({ status: "matched", makingAmount: "0.54", takingAmount: "3" });
    const ioc = ok(await x.t.place({ ...BUY, tif: "ioc", clientId: "i1" }));
    expect([ioc.status, ioc.filledQty, ioc.avgPrice]).toEqual(["canceled", 3, 0.18]);
    // the same answer to a GTC order: its rest is still on the book
    const gtc = ok(await x.t.place({ ...BUY, clientId: "g1" }));
    expect([gtc.status, gtc.filledQty]).toEqual(["partial", 3]);
    // a FOK buy spends size × price whole, and gets more shares than asked when the book is better
    x.answers["predict place"] = placed({ status: "matched", makingAmount: "1.8", takingAmount: "10.5" });
    const fok = ok(await x.t.place({ ...BUY, tif: "fok", clientId: "f1" }));
    expect([fok.status, fok.filledQty, fok.avgPrice]).toEqual(["filled", 10.5, 0.1714285714]);
    x.answers["predict place"] = fail("PREDICT_ORDER_NOT_FILLED", "order couldn't be fully filled. FOK orders are fully filled or killed.");
    expect(refusal(await x.t.place({ ...BUY, tif: "fok", clientId: "f2" })).code).toBe("E_VENUE_REJECTED");
    // killed, it placed nothing: the same id may be tried again
    x.answers["predict place"] = placed({ status: "matched", makingAmount: "1.8", takingAmount: "10" });
    expect(ok(await x.t.place({ ...BUY, tif: "fok", clientId: "f2" })).status).toBe("filled");
  });

  it("with MetaMask's own switch off (anything but 1 is off), a post-only or FOK order prints what would run and runs nothing", async () => {
    for (const env of [{}, { PORTFOLIO_MM_WRITES: "true" }, { PORTFOLIO_MM_WRITES: "0" }]) {
      const x = await boot(PM_MARKET, env);
      ok(await x.t.market(`${SLUG}:Yes`));
      x.calls.splice(0);
      const post = refusal(await x.t.place({ ...BUY, limitPrice: 0.17, postOnly: true, clientId: CLIENT }));
      expect([post.code, post.message]).toEqual(["E_WALLET_LIVE_WRITES_OFF", `MetaMask's own switch is off (PORTFOLIO_MM_WRITES is not 1). The commands that would run: mm predict geoblock --json, then mm predict place --token-id ${TID_YES} --side buy --size 10 --price 0.17 --order-type GTC --post-only --json`]);
      const fok = refusal(await x.t.place({ ...BUY, side: "sell", type: "market", limitPrice: undefined, worstPrice: 0.17, tif: "fok", clientId: "w2" }));
      expect(fok.code).toBe("E_WALLET_LIVE_WRITES_OFF");
      expect((fok.detail as { commands: string[] }).commands).toEqual(["mm predict geoblock --json", `mm predict place --token-id ${TID_YES} --side sell --size 10 --price 0.17 --order-type FOK --json`]);
      expect(x.calls).toEqual([]);
    }
  });
});

// ---- what is held ------------------------------------------------------------------------------------------------------------

describe("positions(): what the Predict deposit wallet holds at Polymarket", () => {
  const DEPOSIT = "0x00000000000000000000000000000000000000Dd";
  /** one row of Polymarket's Data API GET /positions, with every field it documents, as mm passes it on */
  const row = (over: Record<string, unknown> = {}) => ({ proxyWallet: DEPOSIT, asset: TID_YES, conditionId: CID, size: 25, avgPrice: 0.16, initialValue: 4, currentValue: 4.375, cashPnl: 0.375, percentPnl: 9.375, totalBought: 25, realizedPnl: 0, percentRealizedPnl: 0, curPrice: 0.175, redeemable: false, mergeable: false, title: "Fed cuts rates in December?", slug: SLUG, icon: "https://example.invalid/fed.png", eventSlug: "fed-decision-in-december", outcome: "Yes", outcomeIndex: 0, oppositeOutcome: "No", oppositeAsset: TID_NO, endDate: "2026-12-31", negativeRisk: false, ...over });
  /** `mm predict positions --json`: the rows under result.positions, beside the owner and the deposit wallet (mm calls it makerAddress) */
  const held = (rows: unknown[]) => ({ command: "positions", params: {}, result: { chainId: 137, ownerAddress: WALLET, makerAddress: DEPOSIT, positions: rows } });
  const RESOLVED = `5${"1".repeat(76)}`;
  const ODD = `7${"3".repeat(76)}`;

  it("each holding as the account's position, under the symbol market() opens; a read, so it runs with MetaMask's switch off", async () => {
    const x = await boot(
      {
        ...PM_MARKET,
        "predict positions": held([
          row(),
          // nothing held is not a position
          row({ asset: TID_NO, outcome: "No", size: 0, currentValue: 0 }),
          // resolved and lost: still held until it is redeemed, and worth 0
          row({ asset: RESOLVED, conditionId: `0x${"ab".repeat(32)}`, slug: "will-it-rain-on-october-1", title: "Will it rain on October 1?", outcome: "No", size: 40, avgPrice: 0.3, curPrice: 0, currentValue: 0, cashPnl: -12, redeemable: true }),
          // a slug the account's symbols cannot carry: named by its token id; figures given as strings are read as numbers
          row({ asset: ODD, slug: "Odd Slug!", size: "7.5", avgPrice: "0.5", curPrice: "0.52", currentValue: "3.9", cashPnl: "0.15" }),
        ]),
      },
      {},
    );
    const list = ok(await x.t.positions!());
    expect(argvs(x.calls)).toEqual([["predict", "positions", "--json"]]);
    expect(list.map((p) => p.symbol)).toEqual([`${SLUG}:Yes`, "will-it-rain-on-october-1:No", ODD]);
    expect(list[0]).toEqual<Position>({ symbol: `${SLUG}:Yes`, name: "Fed cuts rates in December? · Yes", kind: "event", side: "long", qty: 25, entryPrice: 0.16, markPrice: 0.175, usd: 4.375, unrealizedUsd: 0.375, native: { tokenId: TID_YES, conditionId: CID, outcome: "Yes", size: 25, avgPrice: 0.16, curPrice: 0.175, currentValue: 4.375, cashPnl: 0.375, redeemable: false, endDate: "2026-12-31" } });
    expect(list[1]).toMatchObject({ name: "Will it rain on October 1? · No (resolved)", side: "long", qty: 40, entryPrice: 0.3, markPrice: 0, usd: 0, unrealizedUsd: -12, native: { redeemable: true } });
    expect(list[2]).toMatchObject({ qty: 7.5, entryPrice: 0.5, markPrice: 0.52, usd: 3.9, unrealizedUsd: 0.15 });
    // the position's symbol is the market market() opens, so a sell of those shares goes to the same outcome
    x.calls.splice(0);
    expect(ok(await x.t.market(list[0]!.symbol)).symbol).toBe(list[0]!.symbol);
    expect(argvs(x.calls)).toEqual([["predict", "markets", "get", "--market", SLUG, "--json"], ["predict", "book", TID_YES, "--json"]]);
  });

  it("a wallet that never set up Predict holds nothing there; mm's other refusals are the account's, in mm's words", async () => {
    const x = await boot({ "predict positions": fail("PREDICT_SETUP_REQUIRED", `Run Predict setup for owner ${WALLET} before this operation.`) }, { ...ON, MM_PASSWORD: PASSWORD });
    expect(ok(await x.t.positions!())).toEqual([]);
    const says = async (answer: unknown) => {
      x.answers["predict positions"] = answer;
      return refusal(await x.t.positions!());
    };
    expect((await says(fail("AUTH_FAILED", "Authentication failed."))).code).toBe("E_VENUE_UNAUTHORIZED");
    expect((await says(fail("NOT_INITIALIZED", "Project not initialized."))).code).toBe("E_VENUE_UNAUTHORIZED");
    expect((await says(fail("RATE_LIMITED", "Too many requests"))).code).toBe("E_VENUE_UNREACHABLE");
    expect((await says(fail("NETWORK_UNREACHABLE", "fetch failed"))).code).toBe("E_VENUE_UNREACHABLE");
    const down = await says(fail("PREDICT_ERROR", "Polymarket fetch positions failed: Bad Gateway"));
    expect([down.code, down.message, (down.native as { command: string }).command]).toEqual(["E_VENUE_REJECTED", "Polymarket refused to list what the Predict deposit wallet holds: Polymarket fetch positions failed: Bad Gateway", "mm predict positions --json"]);
    const unread = await says({ command: "positions", params: {}, result: { chainId: 137, ownerAddress: WALLET } });
    expect([unread.code, unread.message]).toEqual(["E_VENUE_REJECTED", "Polymarket answered in a way this connection could not read"]);
    const leaked = await says(fail("WALLET_ERROR", `could not unlock with --password ${PASSWORD}`));
    expect((leaked.native as { said: string }).said).toBe("could not unlock with --password •••");
  });

  it("offers no amend, close or leverage: mm has no command for them here, and selling the shares is an order", async () => {
    const x = await boot();
    expect(typeof x.t.positions).toBe("function");
    expect([x.t.amend, x.t.close, x.t.setLeverage]).toEqual([undefined, undefined, undefined]);
  });
});

// ---- markets ------------------------------------------------------------------------------------------------------------

describe("markets(query)", () => {
  const CHAINS_LIST = {
    chains: [
      { key: "base", chainNamespace: "eip155", caip2: "eip155:8453", chainId: 8453, name: "Base", features: ["swap"], selected: true },
      { key: "ethereum", chainNamespace: "eip155", caip2: "eip155:1", chainId: 1, name: "Ethereum", features: ["swap"] },
      { key: "arbitrum", chainNamespace: "eip155", caip2: "eip155:42161", chainId: 42161, name: "Arbitrum One", features: ["swap", "perps"] },
      { key: "polygon", chainNamespace: "eip155", caip2: "eip155:137", chainId: 137, name: "Polygon", features: ["predict"] },
      { key: "linea", chainNamespace: "eip155", caip2: "eip155:59144", chainId: 59144, name: "Linea", features: ["swap"] },
    ],
  };

  it("well-known dollar markets first, only on chains mm swaps on and that have a pinned USDC, from a list kept five minutes", async () => {
    const x = await boot({ "chains list": CHAINS_LIST });
    const first = ok(await x.t.markets(""));
    expect(first.length).toBeLessThanOrEqual(20);
    expect(first.slice(0, 3).map((m) => m.symbol)).toEqual(["ETH/USDC@Base", "ETH/USDC@Ethereum", "ETH/USDC@Arbitrum"]);
    expect(first.every((m) => inDollars(m.quote) && m.types.join() === "market" && m.open)).toBe(true);
    expect(first.every((m) => !("tifs" in m) && !("postOnly" in m) && !("reduceOnly" in m))).toBe(true);
    // Polygon has no swap here, Linea no pinned USDC: neither is offered
    expect(first.some((m) => /@(Polygon|Optimism|BNB Chain)$/.test(m.symbol) || m.symbol.includes("Linea"))).toBe(false);
    expect(ok(await x.t.markets("wbtc")).map((m) => m.symbol)).toEqual(["WBTC/USDC@Ethereum", "WBTC/USDC@Arbitrum"]);
    expect(x.calls.filter((c) => c.args[0] === "chains").length).toBe(1);
    expect(x.calls[0]!.args).toEqual(["chains", "list", "--json"]);
    x.clock.now += 5 * 60_000 + 1;
    ok(await x.t.markets(""));
    expect(x.calls.filter((c) => c.args[0] === "chains").length).toBe(2);
  });

  it("a whole swap symbol is offered as typed, a non-dollar one is not, and a Polymarket slug lists its outcomes", async () => {
    const gamma = marketGet({ outcomes: '["Yes", "No"]', clobTokenIds: JSON.stringify([TID_YES, TID_NO]), outcomePrices: '["0.175", "0.825"]' });
    const x = await boot({ "chains list": CHAINS_LIST, "predict markets get": gamma });
    expect(ok(await x.t.markets("PEPE/USDC@Base")).map((m) => m.symbol)).toEqual(["PEPE/USDC@Base"]);
    expect(ok(await x.t.markets("PEPE/EUR@Base"))).toEqual([]);
    expect(ok(await x.t.markets("PEPE/USDC@Polygon"))).toEqual([]);
    const pm = ok(await x.t.markets(SLUG));
    expect(pm.map((m) => [m.symbol, m.quote, m.price, m.minQty, m.priceStep, m.open])).toEqual([
      [`${SLUG}:Yes`, "pUSD", 0.175, 5, 0.01, true],
      [`${SLUG}:No`, "pUSD", 0.825, 5, 0.01, true],
    ]);
    // listed as market() opens them: GTC, IOC and FOK, post-only, and no reduce-only
    expect(pm.map((m) => [m.types.join(), m.tifs?.join(), m.postOnly, "reduceOnly" in m])).toEqual([
      ["limit,market", "gtc,ioc,fok", true, false],
      ["limit,market", "gtc,ioc,fok", true, false],
    ]);
    expect(x.calls.at(-1)!.args).toEqual(["predict", "markets", "get", "--market", SLUG, "--json"]);
    // free text is not searched at Polymarket: mm's search output is not documented
    x.calls.splice(0);
    ok(await x.t.markets("fed"));
    ok(await x.t.markets("2026"));
    expect(x.calls.some((c) => c.args[0] === "predict")).toBe(false);
  });

  it("says so when mm cannot list its chains", async () => {
    const x = await boot({ "chains list": fail("AUTH_FAILED", "Authentication failed.") });
    expect(refusal(await x.t.markets("")).code).toBe("E_VENUE_UNAUTHORIZED");
  });
});
