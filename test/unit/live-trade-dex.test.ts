import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, erc20Abi, getAddress, parseAbi, parseAbiParameters, type Hex } from "viem";
import { isRefusal, type Refusal } from "../../src/core/errors.ts";
import { walletSource } from "../../src/portfolio/live/address.ts";
import { STABLECOINS, type ChainName, type ChainReader, type Mined, type SentTx } from "../../src/portfolio/live/chain.ts";
import { LIFI_DIAMOND, LIFI_SWAP_ABI, dexTrader } from "../../src/portfolio/live/dex.ts";
import type { LiveTrader, Market, OrderRequest, OrderState } from "../../src/portfolio/live/trade.ts";
import type { Http } from "../../src/portfolio/live/types.ts";

/** Swaps from the user's own wallet through LI.FI, with every real thing replaced by a stand-in: LI.FI's API is an Http that records each
 * request and answers what the test says, and the chain is a reader that holds what the test says. Nothing leaves the process; the wallet
 * address is made up and no key exists anywhere in this file — LI.FI takes none, and the wallet signs, never this process. */

const WALLET = getAddress("0x00000000000000000000000000000000000a11ce");
const NATIVE: Hex = "0x0000000000000000000000000000000000000000";
const usdcOn = (c: ChainName) => STABLECOINS.find((t) => t.chain === c && t.asset === "USDC")!.address;
const USDC_BASE = usdcOn("Base");
const USDC_ETH = usdcOn("Ethereum");
const WETH = getAddress("0x4200000000000000000000000000000000000006");
const CBBTC = getAddress("0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf");
const WBTC = getAddress("0x2260fac5e5542a773aa44fbcfedf7c193bc2c599");
const made = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const PEPE = made(0x1001);
const SIX = made(0x1002);
const TXID: Hex = "0xb9cf949dbddf7a8d9b89df32c250b57ee382fb3c732c99415b1fc0726be38d34";
const HASH: Hex = "0x268762998feda84a4a6241b389e57bba1dfcd6346a7415a61d09e7c6a927b84d";
/** the id of a second quote for the same order (a swap built again) */
const TXID2: Hex = "0x5e1f00000000000000000000000000000000000000000000000000000000beef";
/** what the account gives a venue as its order id: thirty-two hex digits, not the account's `ord-0001` */
const CLIENT = "9f86d081884c7d659a2feaa0c55ad015";
const FEE_COLLECTOR = made(0xfee);
const SOME_DEX = made(0xde);
const T = Date.parse("2026-10-05T14:00:00.000Z");

const tok = (chainId: number, address: Hex, symbol: string, decimals: number, priceUSD: string | undefined, verificationStatus = "verified", name = symbol) => ({ chainId, address, symbol, name, decimals, ...(priceUSD !== undefined ? { priceUSD } : {}), verificationStatus });
/** LI.FI's GET /v1/tokens, shaped as it answers: { tokens: { "<chain id>": [Token] } } */
const TOKENS = {
  tokens: {
    "8453": [
      tok(8453, USDC_BASE, "USDC", 6, "1.0003", "verified", "USD Coin"),
      tok(8453, NATIVE, "ETH", 18, "2708.18"),
      tok(8453, WETH, "WETH", 18, "2708.18", "verified", "Wrapped Ether"),
      tok(8453, CBBTC, "cbBTC", 8, "121000", "verified", "Coinbase Wrapped BTC"),
      tok(8453, made(0xae), "AERO", 18, "0.81", "verified", "Aerodrome"),
      tok(8453, getAddress("0xfde4c96c8593536e31f229ea8f37b2ada2699bb2"), "USDT", 6, "1.0", "verified", "Tether"),
      tok(8453, PEPE, "PEPE", 18, "0.0000101", "verified", "Pepe"),
      tok(8453, SIX, "SIX", 6, "3.5", "verified", "Six Decimals"),
      tok(8453, made(0x1003), "NOPRICE", 18, undefined, "verified"),
      tok(8453, made(0x1004), "SCAM", 18, "5", "flagged"),
      tok(8453, made(0x1005), "DUP", 18, "1.5"),
      tok(8453, made(0x1006), "DUP", 18, "1.6"),
      tok(8453, made(0x1007), "MAYBE", 18, "2", "unverified"),
    ],
    "1": [tok(1, USDC_ETH, "USDC", 6, "1.0001", "verified", "USD Coin"), tok(1, NATIVE, "ETH", 18, "2707.9"), tok(1, WBTC, "WBTC", 8, "120950", "verified", "Wrapped BTC")],
  },
};

type Answer = { status?: number; body?: unknown; text?: string } | Error;
interface Asked {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
}
/** LI.FI, as the test says it answers: the first rule whose pattern the URL starts with (or matches) answers; anything else is no network */
function lifi(rules: Array<[string | RegExp, Answer]>): Http & { asked: Asked[] } {
  const asked: Asked[] = [];
  const http = (async (url, init = {}) => {
    asked.push({ method: init.method ?? "GET", url, headers: init.headers ?? {}, body: init.body });
    for (const [m, a] of rules) {
      if (!(typeof m === "string" ? url.startsWith(m) : m.test(url))) continue;
      if (a instanceof Error) throw a;
      return { status: a.status ?? 200, body: a.body, text: a.text ?? JSON.stringify(a.body ?? "") };
    }
    return { status: 599, body: undefined, text: "no network in tests" };
  }) as Http & { asked: Asked[] };
  http.asked = asked;
  return http;
}
const lifiCalls = (h: { asked: Asked[] }) => h.asked.filter((a) => a.url.startsWith("https://li.quest/"));

/** a chain that holds what the test says: `"Base:USDC"` → whole tokens, `"Base"` → the chain's own coin; `txs` the transactions it knows by
 * hash (shown only from the `seenAfter`-th look on). The options are read at every call, so a test can change what the chain holds */
interface ChainHolds {
  held?: Record<string, number>;
  allowance?: bigint | undefined;
  receipts?: Record<string, Mined>;
  txs?: Record<string, SentTx>;
  seenAfter?: number;
  decimals?: Record<string, number>;
  down?: ChainName[];
}
function chainStandIn(o: ChainHolds = {}): ChainReader & { asked: string[] } {
  const asked: string[] = [];
  let looks = 0;
  const down = (c: ChainName) => (o.down ?? []).includes(c);
  const decimals: Record<string, number> = { [USDC_BASE.toLowerCase()]: 6, [USDC_ETH.toLowerCase()]: 6, [WETH.toLowerCase()]: 18, [CBBTC.toLowerCase()]: 8, [WBTC.toLowerCase()]: 8, [PEPE.toLowerCase()]: 18, [SIX.toLowerCase()]: 6, ...o.decimals };
  return {
    asked,
    async tokens(holder, refs) {
      asked.push(`tokens:${holder}:${refs.map((r) => `${r.chain}:${r.asset}`).join(",")}`);
      const chains = [...new Set(refs.map((r) => r.chain))];
      return { rows: refs.filter((r) => !down(r.chain)).map((r) => ({ chain: r.chain, asset: r.asset, amount: o.held?.[`${r.chain}:${r.asset}`] ?? 0 })), failed: chains.filter(down) };
    },
    async native(holder, chains) {
      asked.push(`native:${holder}:${chains.join(",")}`);
      return { rows: chains.filter((c) => !down(c)).map((c) => ({ chain: c, asset: c === "BNB Chain" ? "BNB" : c === "Polygon" ? "POL" : "ETH", amount: o.held?.[c] ?? 0 })), failed: chains.filter(down) };
    },
    async uint(chain, address, signature, args = []) {
      asked.push(`uint:${chain}:${address}:${signature}:${args.join(",")}`);
      return o.allowance;
    },
    async decimals(chain, token) {
      asked.push(`decimals:${chain}:${token}`);
      return down(chain) ? undefined : decimals[token.toLowerCase()];
    },
    async receipt(chain, hash) {
      asked.push(`receipt:${chain}:${hash}`);
      return o.receipts?.[hash.toLowerCase()];
    },
    async transaction(chain, hash) {
      asked.push(`tx:${chain}:${hash}`);
      return ++looks > (o.seenAfter ?? 0) ? o.txs?.[hash.toLowerCase()] : undefined;
    },
  };
}
/** the same chain read through a reader that cannot read a transaction by its hash, only its receipt */
function receiptsOnly(o: ChainHolds = {}): ChainReader & { asked: string[] } {
  const { transaction: _none, ...rest } = chainStandIn(o);
  return rest;
}

/** LI.FI's GET /v1/quote answer for a same-chain swap, with a transaction built the way LI.FI's contract takes it; `bad` breaks one thing */
function quote(o: { from: Hex; to: Hex; fromAmount: bigint; toAmount: bigint; toAmountMin: bigint; fromPrice: string; toPrice: string; approvalReset?: boolean; id?: Hex; bad?: { receiver?: Hex; txTo?: Hex; approvalAddress?: Hex; minOnChain?: bigint; value?: bigint; txId?: Hex; deposit?: boolean } | undefined }) {
  const kind = o.from === NATIVE ? "NativeToERC20" : o.to === NATIVE ? "ERC20ToNative" : "ERC20ToERC20";
  const legs = [
    { callTo: FEE_COLLECTOR, approveTo: FEE_COLLECTOR, sendingAssetId: o.from, receivingAssetId: o.from, fromAmount: o.fromAmount, callData: "0x" as Hex, requiresDeposit: true },
    { callTo: SOME_DEX, approveTo: SOME_DEX, sendingAssetId: o.from, receivingAssetId: o.to, fromAmount: (o.fromAmount * 9975n) / 10000n, callData: "0x1234" as Hex, requiresDeposit: o.bad?.deposit ?? false },
  ];
  const data = encodeFunctionData({ abi: LIFI_SWAP_ABI, functionName: `swapTokensMultipleV3${kind}`, args: [o.bad?.txId ?? o.id ?? TXID, "account-demo", NATIVE, o.bad?.receiver ?? WALLET, o.bad?.minOnChain ?? o.toAmountMin, legs] } as never);
  const value = o.bad?.value ?? (o.from === NATIVE ? o.fromAmount : 0n);
  return {
    type: "lifi",
    id: "19515eef-f73e-4483-b732-b9e5987d6f26:0",
    tool: "nordstern",
    action: { fromChainId: 8453, toChainId: 8453, fromToken: { address: o.from, decimals: 0, priceUSD: o.fromPrice }, toToken: { address: o.to, priceUSD: o.toPrice }, fromAmount: o.fromAmount.toString(), slippage: 0.005, fromAddress: WALLET, toAddress: WALLET },
    estimate: { tool: "nordstern", approvalAddress: o.bad?.approvalAddress ?? LIFI_DIAMOND, fromAmount: o.fromAmount.toString(), toAmount: o.toAmount.toString(), toAmountMin: o.toAmountMin.toString(), ...(o.from === NATIVE ? { skipApproval: true } : {}), ...(o.approvalReset ? { approvalReset: true } : {}), feeCosts: [{ name: "LIFI Fixed Fee", percentage: "0.0025", amountUSD: "0.0680", included: true }], gasCosts: [{ type: "SEND", price: "6000000", estimate: "286117", limit: "771952", amount: "1716702000000", amountUSD: "0.0046" }], fromAmountUSD: "27.19", toAmountUSD: "27.08" },
    transactionId: o.id ?? TXID,
    transactionRequest: { value: `0x${value.toString(16)}`, to: o.bad?.txTo ?? LIFI_DIAMOND, data, chainId: 8453, gasPrice: "0x5b8d80", gasLimit: "0xbc770", from: WALLET },
  };
}

/** a 0.01 WETH buy on Base: about $27.18 of USDC, at least 0.00995 WETH */
const BUY = { from: USDC_BASE, to: WETH, fromAmount: 27_180_000n, toAmount: 10_000_000_000_000_000n, toAmountMin: 9_950_000_000_000_000n, fromPrice: "1.0003", toPrice: "2708.18" };
/** a 0.005 ETH sell on Base: at least $13.4723 of USDC */
const SELL_ETH = { from: NATIVE, to: USDC_BASE, fromAmount: 5_000_000_000_000_000n, toAmount: 13_540_000n, toAmountMin: 13_472_300n, fromPrice: "2708.18", toPrice: "1.0003" };

const BUY_URL = `https://li.quest/v1/quote/toAmount?fromChain=8453&toChain=8453&fromToken=${USDC_BASE}&toToken=${WETH}&toAmount=10000000000000000&fromAddress=${WALLET}&slippage=0.005&integrator=account-demo&order=CHEAPEST`;
const SELL_URL = `https://li.quest/v1/quote?fromChain=8453&toChain=8453&fromToken=${NATIVE}&toToken=${USDC_BASE}&fromAmount=5000000000000000&fromAddress=${WALLET}&slippage=0.005&integrator=account-demo&order=CHEAPEST`;
const STATUS_URL = `https://li.quest/v1/status?txHash=${HASH}&fromChain=8453&toChain=8453`;

/** a trader whose looks at the chain do not wait: `pause` hears how long it would have */
function trader(http: Http, chain: ChainReader, o: { proven?: string | undefined; now?: () => number; pause?: (ms: number) => Promise<void> } = { proven: "OKX Wallet" }): LiveTrader {
  return dexTrader({ venue: "wallet-1", address: WALLET, proven: o.proven, http, chain, now: o.now ?? (() => T), pause: o.pause ?? (async () => {}) });
}
const refusal = (x: unknown): Refusal => {
  if (!isRefusal(x)) throw new Error(`expected a refusal, got ${JSON.stringify(x)}`);
  return x;
};
const ok = <T>(x: T | Refusal): T => {
  if (isRefusal(x)) throw new Error(`${x.code}: ${x.message}`);
  return x;
};

describe("a wallet's swaps through LI.FI: the markets", () => {
  it("markets(query): a few well-known tokens first, then LI.FI's verified tokens; all priced in the chain's USDC, never a stablecoin, an unpriced, a flagged or an ambiguous one", async () => {
    const http = lifi([["https://li.quest/v1/tokens?", { body: TOKENS }]]);
    const t = trader(http, chainStandIn());
    const first = ok(await t.markets(""));
    expect(first.map((m) => m.symbol)).toEqual(["ETH/USDC@Base", "ETH/USDC@Ethereum", "cbBTC/USDC@Base", "WBTC/USDC@Ethereum", "WETH/USDC@Base", "AERO/USDC@Base", "PEPE/USDC@Base", "SIX/USDC@Base"]);
    expect(first.every((m) => m.quote === "USDC" && m.kind === "token" && m.price! > 0)).toBe(true);
    expect(ok(await t.markets("pepe")).map((m) => m.symbol)).toEqual(["PEPE/USDC@Base"]);
    expect(ok(await t.markets("btc")).map((m) => m.symbol)).toEqual(["cbBTC/USDC@Base", "WBTC/USDC@Ethereum"]);
    // a chain's coins first; after them the tokenised shares an issuer lists there (live-rwa.test.ts), found even where LI.FI's list has none
    const eth = ok(await t.markets("@ethereum"));
    expect(eth.slice(0, 2).map((m) => m.symbol)).toEqual(["ETH/USDC@Ethereum", "WBTC/USDC@Ethereum"]);
    expect(eth.slice(2).every((m) => m.category === "RWA" && m.symbol.endsWith("/USDC@Ethereum"))).toBe(true);
    for (const q of ["USDT", "NOPRICE", "SCAM", "DUP", "MAYBE"]) expect(ok(await t.markets(q))).toEqual([]);
    // the list is asked once and kept five minutes
    expect(lifiCalls(http).map((a) => `${a.method} ${a.url}`)).toEqual(["GET https://li.quest/v1/tokens?chains=1,10,56,137,8453,42161,4663"]);
  });

  it("the list is asked again after five minutes", async () => {
    let now = T;
    const http = lifi([["https://li.quest/v1/tokens?", { body: TOKENS }]]);
    const t = trader(http, chainStandIn(), { proven: "OKX Wallet", now: () => now });
    await t.markets("");
    now += 4 * 60_000;
    await t.markets("eth");
    now += 2 * 60_000;
    await t.markets("eth");
    expect(lifiCalls(http)).toHaveLength(2);
  });

  it("market(): LI.FI's price now, no book, a size in the token's decimals (eight places at most), $1 the least, market orders only, open", async () => {
    const http = lifi([
      ["https://li.quest/v1/tokens?", { body: TOKENS }],
      [`https://li.quest/v1/token?chain=8453&token=${WETH}`, { body: { ...tok(8453, WETH, "WETH", 18, "2710.5", "verified", "Wrapped Ether"), marketCapUSD: 1 } }],
      [`https://li.quest/v1/token?chain=8453&token=${SIX}`, { body: tok(8453, SIX, "SIX", 6, "3.5") }],
      [`https://li.quest/v1/token?chain=8453&token=${PEPE}`, { body: tok(8453, PEPE, "PEPE", 18, "0.0000101", "flagged") }],
    ]);
    const t = trader(http, chainStandIn());
    const m = ok(await t.market("weth/usdc@base"));
    expect(m).toEqual({ symbol: "WETH/USDC@Base", name: "Wrapped Ether on Base", kind: "token", base: "WETH", quote: "USDC", price: 2710.5, qtyStep: 1e-8, minNotional: 1, open: true, note: expect.stringContaining("LI.FI"), types: ["market"] } satisfies Market);
    expect([m.bid, m.ask, m.minQty, m.priceStep, m.contractSize]).toEqual([undefined, undefined, undefined, undefined, undefined]);
    expect(m.note).toContain("US persons");
    expect(ok(await t.market("SIX/USDC@Base")).qtyStep).toBe(0.000001);
    expect(lifiCalls(http).map((a) => a.url)).toContain(`https://li.quest/v1/token?chain=8453&token=${WETH}`);
    // what is not a dollar market, not a chain swapped on, not one token, or flagged by LI.FI now
    expect(refusal(await t.market("WETH/EUR@Base")).code).toBe("E_ACCOUNT_UNPRICED");
    expect(refusal(await t.market("WETH/USDT@Base")).message).toBe("swaps here are against the chain's USDC: WETH/USDC@Base");
    expect(refusal(await t.market("WETH/USDC@Solana")).code).toBe("E_ACCOUNT_BAD_ACTION");
    // Robinhood Chain is swapped on against its own dollar, USDG: LI.FI lists no USDC there
    expect(refusal(await t.market("WETH/USDC@Robinhood Chain")).message).toBe("swaps here are against the chain's USDG: WETH/USDG@Robinhood Chain");
    expect(refusal(await t.market("DUP/USDC@Base")).message).toBe("LI.FI lists no single verified token DUP on Base: search the markets for its symbol");
    expect(refusal(await t.market("SCAM/USDC@Base")).code).toBe("E_ACCOUNT_BAD_ACTION");
    expect(refusal(await t.market("PEPE/USDC@Base")).code).toBe("E_VENUE_ORDER_INVALID");
  });
});

describe("a wallet's swaps through LI.FI: placing", () => {
  it("a market buy: LI.FI's exact-output quote for the size asked, checked; an approval of the most the order may cost first, then the swap, for the wallet to send", async () => {
    const q = quote(BUY);
    const http = lifi([
      ["https://li.quest/v1/tokens?", { body: TOKENS }],
      ["https://li.quest/v1/quote/toAmount?", { body: q }],
    ]);
    const chain = chainStandIn({ held: { "Base:USDC": 100, Base: 0.01 }, allowance: 0n });
    const t = trader(http, chain);
    const s = ok(await t.place({ symbol: "WETH/USDC@Base", side: "buy", type: "market", qty: 0.01, clientId: "ord-0001" }));
    const quoted = lifiCalls(http).filter((a) => a.url.includes("/quote"));
    expect(quoted).toEqual([{ method: "GET", url: BUY_URL, headers: { accept: "application/json" }, body: undefined }]);
    // no key, no signature: LI.FI takes none, and nothing here signs
    expect(Object.keys(quoted[0]!.headers)).toEqual(["accept"]);
    expect(s).toEqual({
      ref: "",
      status: "pending",
      filledQty: 0,
      walletTxs: [
        // the approval covers the order at its worst price (0.01 WETH at the price with 2% room), so a swap built again after it still fits
        { chainId: 8453, chainIdHex: "0x2105", from: WALLET, to: USDC_BASE, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [LIFI_DIAMOND, 27_623_435n] }), value: "0x0", what: "approve" },
        // the gas LI.FI's simulation says the route needs goes to the wallet with the swap; the approval's is the wallet's own estimate
        { chainId: 8453, chainIdHex: "0x2105", from: WALLET, to: LIFI_DIAMOND, data: q.transactionRequest.data, value: "0x0", gas: "0xbc770", what: "swap" },
      ],
      native: expect.objectContaining({ clientId: "ord-0001", route: "19515eef-f73e-4483-b732-b9e5987d6f26:0", tool: "nordstern", transactionId: TXID, chain: "Base", sell: { token: "USDC", address: USDC_BASE, amount: "27.18" }, buy: { token: "WETH", address: WETH, expected: "0.01", least: "0.00995" }, gasLimit: "0xbc770", approvals: 1 }),
    } satisfies OrderState);
    // decimals from the tokens themselves, the USDC and the gas from the wallet, the allowance to LI.FI's contract
    expect(chain.asked).toEqual([
      `decimals:Base:${WETH}`,
      `decimals:Base:${USDC_BASE}`,
      `tokens:${WALLET}:Base:USDC`,
      `native:${WALLET}:Base`,
      `uint:Base:${USDC_BASE}:function allowance(address owner, address spender) view returns (uint256):${WALLET},${LIFI_DIAMOND}`,
    ]);
  });

  it("the account's order id: LI.FI takes no client id, so it rides with the order, and a retry with it inside a minute is the same order, not a second quote", async () => {
    let now = T;
    const http = lifi([
      ["https://li.quest/v1/tokens?", { body: TOKENS }],
      ["https://li.quest/v1/quote/toAmount?", { body: quote(BUY) }],
    ]);
    const t = trader(http, chainStandIn({ held: { "Base:USDC": 100, Base: 0.01 }, allowance: 0n }), { proven: "OKX Wallet", now: () => now });
    const first = ok(await t.place({ symbol: "WETH/USDC@Base", side: "buy", type: "market", qty: 0.01, clientId: "ord-0001" }));
    expect((first.native as { clientId: string }).clientId).toBe("ord-0001");
    now += 30_000;
    expect(ok(await t.place({ symbol: "WETH/USDC@Base", side: "buy", type: "market", qty: 0.01, clientId: "ord-0001" }))).toBe(first);
    expect(lifiCalls(http).filter((a) => a.url.includes("/quote"))).toHaveLength(1);
    expect(refusal(await t.place({ symbol: "WETH/USDC@Base", side: "buy", type: "market", qty: 0.02, clientId: "ord-0001" })).message).toBe("ord-0001 was already used for another order");
    // after a minute the quote is stale: a retry is quoted again
    now += 60_000;
    ok(await t.place({ symbol: "WETH/USDC@Base", side: "buy", type: "market", qty: 0.01, clientId: "ord-0001" }));
    expect(lifiCalls(http).filter((a) => a.url.includes("/quote"))).toHaveLength(2);
  });

  it("a market sell of the chain's own coin: exactly this much in (GET /v1/quote with fromAmount), the coin rides as the value, no approval", async () => {
    const q = quote(SELL_ETH);
    const http = lifi([
      ["https://li.quest/v1/tokens?", { body: TOKENS }],
      ["https://li.quest/v1/quote?", { body: q }],
    ]);
    const chain = chainStandIn({ held: { Base: 0.01 } });
    const t = trader(http, chain);
    const s = ok(await t.place({ symbol: "ETH/USDC@Base", side: "sell", type: "market", qty: 0.005, clientId: "ord-0002" }));
    expect(lifiCalls(http).filter((a) => a.url.includes("/quote")).map((a) => `${a.method} ${a.url}`)).toEqual([`GET ${SELL_URL}`]);
    expect(s.walletTxs).toEqual([{ chainId: 8453, chainIdHex: "0x2105", from: WALLET, to: LIFI_DIAMOND, data: q.transactionRequest.data, value: "0x11c37937e08000", gas: "0xbc770", what: "swap" }]);
    expect(chain.asked.some((a) => a.startsWith("uint:"))).toBe(false);
    // the coin is checked before the quote is spent on it, and again with the network fee on top
    expect(chain.asked.filter((a) => a.startsWith("native:"))).toHaveLength(2);
  });

  it("a market sell of a token: approvals by what the wallet already allows, from zero for a token LI.FI says needs it", async () => {
    const SELL_WETH = { from: WETH, to: USDC_BASE, fromAmount: 10_000_000_000_000_000n, toAmount: 27_080_000n, toAmountMin: 26_944_600n, fromPrice: "2708.18", toPrice: "1.0003" };
    const run = async (allowance: bigint | undefined, approvalReset: boolean) => {
      const q = quote({ ...SELL_WETH, approvalReset });
      const http = lifi([
        ["https://li.quest/v1/tokens?", { body: TOKENS }],
        ["https://li.quest/v1/quote?", { body: q }],
      ]);
      const s = ok(await trader(http, chainStandIn({ held: { "Base:WETH": 1, Base: 0.01 }, allowance })).place({ symbol: "WETH/USDC@Base", side: "sell", type: "market", qty: 0.01, clientId: "ord-0003" }));
      expect(lifiCalls(http).find((a) => a.url.includes("/quote"))!.url).toContain(`fromToken=${WETH}&toToken=${USDC_BASE}&fromAmount=10000000000000000&`);
      return s.walletTxs!.map((x) => (x.what === "approve" ? `approve ${BigInt(`0x${x.data.slice(-64)}`)}` : "swap"));
    };
    expect(await run(10n ** 18n, false)).toEqual(["swap"]);
    expect(await run(0n, false)).toEqual(["approve 10000000000000000", "swap"]);
    expect(await run(5n, true)).toEqual(["approve 0", "approve 10000000000000000", "swap"]);
    expect(await run(0n, true)).toEqual(["approve 10000000000000000", "swap"]);
    // the chain did not say: approve anyway (from zero where it must)
    expect(await run(undefined, true)).toEqual(["approve 0", "approve 10000000000000000", "swap"]);
  });

  it("a limit order is not taken: a DEX keeps no book; and nothing is asked of LI.FI", async () => {
    const http = lifi([["https://li.quest/v1/tokens?", { body: TOKENS }]]);
    const no = refusal(await trader(http, chainStandIn()).place({ symbol: "WETH/USDC@Base", side: "buy", type: "limit", qty: 0.01, limitPrice: 2500, clientId: "ord-0004" }));
    expect([no.code, no.message]).toEqual(["E_VENUE_ORDER_INVALID", "LI.FI: a swap is a market order: a DEX keeps no book, so no limit order can rest there"]);
    expect(lifiCalls(http)).toEqual([]);
  });

  it("a swap that does not pay this wallet, goes elsewhere, approves another spender or promises less on chain than quoted is never handed to the wallet", async () => {
    const OTHER = made(0xbad);
    const cases: Array<[Parameters<typeof quote>[0]["bad"], string]> = [
      [{ receiver: OTHER }, "it pays another address than this wallet"],
      [{ txTo: OTHER }, "it is not addressed to LI.FI's own contract"],
      [{ approvalAddress: OTHER }, "it asks the wallet to approve a spender that is not LI.FI's own contract"],
      [{ minOnChain: 1n }, "the least it pays on chain is not the least LI.FI quoted"],
      [{ txId: `0x${"11".repeat(32)}` }, "its id is not the quote's"],
      [{ value: 1n }, "it sends a different amount of the chain's own coin"],
      // a later leg that LI.FI's contract would also pull from the wallet: more spent than sold, for the same least out
      [{ deposit: true }, "it takes more from the wallet than the amount it sells"],
    ];
    for (const [bad, why] of cases) {
      const http = lifi([
        ["https://li.quest/v1/tokens?", { body: TOKENS }],
        ["https://li.quest/v1/quote/toAmount?", { body: quote({ ...BUY, bad }) }],
      ]);
      const no = refusal(await trader(http, chainStandIn({ held: { "Base:USDC": 100, Base: 0.01 }, allowance: 0n })).place({ symbol: "WETH/USDC@Base", side: "buy", type: "market", qty: 0.01, clientId: "ord-0005" }));
      expect([no.code, no.message]).toEqual(["E_VENUE_REJECTED", `LI.FI answered a swap this account will not hand your wallet: ${why}. Nothing was prepared`]);
    }
    // a calldata that is not one of LI.FI's swaps
    const odd = quote(BUY);
    odd.transactionRequest.data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [made(0xbad), 1n] });
    const http = lifi([
      ["https://li.quest/v1/tokens?", { body: TOKENS }],
      ["https://li.quest/v1/quote/toAmount?", { body: odd }],
    ]);
    expect(refusal(await trader(http, chainStandIn({ held: { "Base:USDC": 100, Base: 0.01 } })).place({ symbol: "WETH/USDC@Base", side: "buy", type: "market", qty: 0.01, clientId: "ord-0006" })).message).toContain("its transaction is not one of LI.FI's same-chain swaps");
  });

  it("a route that costs more than the account counted (LI.FI's price with 2% room) is not prepared", async () => {
    const http = lifi([
      ["https://li.quest/v1/tokens?", { body: TOKENS }],
      ["https://li.quest/v1/quote/toAmount?", { body: quote({ ...BUY, fromAmount: 28_000_000n }) }],
    ]);
    const no = refusal(await trader(http, chainStandIn({ held: { "Base:USDC": 100, Base: 0.01 }, allowance: 0n })).place({ symbol: "WETH/USDC@Base", side: "buy", type: "market", qty: 0.01, clientId: "ord-0007" }));
    expect([no.code, no.message]).toEqual(["E_ACCOUNT_REQUOTE", "LI.FI's route costs $28.00 for at least 0.00995 WETH, more than $27.49 (its price 2708.18 with 2% room). Nothing was prepared"]);
  });

  it("a buy is held to 2% per token it is sure to get: $27.18 for at least 0.0098 WETH is 2.4% over, so it is not prepared", async () => {
    const http = lifi([
      ["https://li.quest/v1/tokens?", { body: TOKENS }],
      ["https://li.quest/v1/quote/toAmount?", { body: quote({ ...BUY, toAmountMin: 9_800_000_000_000_000n }) }],
    ]);
    const no = refusal(await trader(http, chainStandIn({ held: { "Base:USDC": 100, Base: 0.01 }, allowance: 0n })).place({ symbol: "WETH/USDC@Base", side: "buy", type: "market", qty: 0.01, clientId: "ord-0008" }));
    expect([no.code, no.message]).toEqual(["E_ACCOUNT_REQUOTE", "LI.FI's route costs $27.18 for at least 0.0098 WETH, more than $27.07 (its price 2708.18 with 2% room). Nothing was prepared"]);
  });

  it("the room is measured from the price the account valued the order at (market()), when the route's price is higher", async () => {
    const http = lifi([
      ["https://li.quest/v1/tokens?", { body: TOKENS }],
      [`https://li.quest/v1/token?chain=8453&token=${WETH}`, { body: tok(8453, WETH, "WETH", 18, "2650", "verified", "Wrapped Ether") }],
      ["https://li.quest/v1/quote/toAmount?", { body: quote(BUY) }],
    ]);
    const t = trader(http, chainStandIn({ held: { "Base:USDC": 100, Base: 0.01 }, allowance: 0n }));
    expect(ok(await t.market("WETH/USDC@Base")).price).toBe(2650);
    const no = refusal(await t.place({ symbol: "WETH/USDC@Base", side: "buy", type: "market", qty: 0.01, clientId: "ord-0009" }));
    expect([no.code, no.message]).toEqual(["E_ACCOUNT_REQUOTE", "LI.FI's route costs $27.18 for at least 0.00995 WETH, more than $26.89 (its price 2650 with 2% room). Nothing was prepared"]);
  });
});

describe("a wallet's swaps through LI.FI: refusals", () => {
  const BUY_ORDER = { symbol: "WETH/USDC@Base", side: "buy" as const, type: "market" as const, qty: 0.01, clientId: "ord-0010" };

  it("not enough in the wallet: LI.FI does not look, so the account does — the tokens sold, and the network fee", async () => {
    const quoted = () => lifi([
      ["https://li.quest/v1/tokens?", { body: TOKENS }],
      ["https://li.quest/v1/quote", { body: quote(BUY) }],
    ]);
    let http = quoted();
    let no = refusal(await trader(http, chainStandIn({ held: { "Base:USDC": 5, Base: 0.01 } })).place(BUY_ORDER));
    expect([no.code, no.message, no.native]).toEqual(["E_VENUE_INSUFFICIENT", "the wallet holds 5 USDC on Base; this swap needs 27.18", { asset: "USDC", chain: "Base", have: 5, need: 27.18 }]);
    no = refusal(await trader(quoted(), chainStandIn({ held: { "Base:USDC": 100 } })).place(BUY_ORDER));
    expect([no.code, no.message]).toEqual(["E_VENUE_INSUFFICIENT", "the wallet holds 0 ETH on Base; the network fee for this swap is about 0.00000172"]);
    // a sell: checked before a quote is spent on it
    http = quoted();
    no = refusal(await trader(http, chainStandIn({ held: { "Base:WETH": 0.001, Base: 0.01 } })).place({ ...BUY_ORDER, side: "sell" }));
    expect([no.code, no.message]).toEqual(["E_VENUE_INSUFFICIENT", "the wallet holds 0.001 WETH on Base; this swap needs 0.01"]);
    expect(lifiCalls(http).filter((a) => a.url.includes("/quote"))).toEqual([]);
    // a chain that does not answer: nothing is prepared on a guess
    no = refusal(await trader(quoted(), chainStandIn({ down: ["Base"] })).place(BUY_ORDER));
    expect(no.code).toBe("E_VENUE_UNREACHABLE");
  });

  it("a size LI.FI does not take: its own words, as an invalid order", async () => {
    const said = { message: '/toAmount must pass "isBigNumberish" keyword validation', code: 1011 };
    let http = lifi([
      ["https://li.quest/v1/tokens?", { body: TOKENS }],
      ["https://li.quest/v1/quote", { status: 400, body: said }],
    ]);
    let no = refusal(await trader(http, chainStandIn({ held: { "Base:USDC": 100, Base: 0.01 } })).place(BUY_ORDER));
    expect([no.code, no.message, no.native]).toEqual(["E_VENUE_ORDER_INVALID", 'LI.FI: /toAmount must pass "isBigNumberish" keyword validation', { status: 400, said: JSON.stringify(said) }]);
    // no route: too big for the liquidity there, with the reasons LI.FI gives
    const noRoute = { message: "No available quotes for the requested transfer", code: 1002, errors: { filteredOut: [{ overallPath: "8453:USDC~8453:WETH", reason: "Price impact of 99.9% is higher than the max allowed 10%" }], failed: [{ overallPath: "8453:USDC~8453:WETH", subpaths: { "8453:USDC~8453:WETH": [{ errorType: "NO_QUOTE", code: "AMOUNT_TOO_HIGH", tool: "kyberswap", message: "AmountIn is greater than max allowed when route" }] } }] } };
    http = lifi([
      ["https://li.quest/v1/tokens?", { body: TOKENS }],
      ["https://li.quest/v1/quote", { status: 404, body: noRoute }],
    ]);
    no = refusal(await trader(http, chainStandIn()).place(BUY_ORDER));
    expect([no.code, no.message]).toEqual(["E_VENUE_ORDER_INVALID", "LI.FI: no route for this swap: Price impact of 99.9% is higher than the max allowed 10%; kyberswap: AMOUNT_TOO_HIGH (AmountIn is greater than max allowed when route)"]);
    // no route because the DEXes did not answer is LI.FI being unreachable, not a bad order
    http = lifi([
      ["https://li.quest/v1/tokens?", { body: TOKENS }],
      ["https://li.quest/v1/quote", { status: 404, body: { message: "No available quotes", code: 1002, errors: { failed: [{ subpaths: { p: [{ tool: "a", code: "RPC_ERROR" }, { tool: "b", code: "TOOL_TIMEOUT" }] } }] } } }],
    ]);
    expect(refusal(await trader(http, chainStandIn()).place(BUY_ORDER)).code).toBe("E_VENUE_UNREACHABLE");
  });

  it("a watched address trades nothing: no wallet signed for it", async () => {
    const http = lifi([["https://li.quest/v1/tokens?", { body: TOKENS }]]);
    const t = trader(http, chainStandIn(), { proven: undefined });
    expect(t.can).toBe(false);
    // why, in the wallet's own terms: the account says it when an order is asked of it
    expect(t.whyNot).toBe(`${WALLET} is watched, not proven yours: a swap is sent only from a wallet that signed for its address`);
    expect(refusal(await t.requote!(BUY_ORDER)).code).toBe("E_VENUE_PERMISSION");
    expect(trader(http, chainStandIn()).whyNot).toBeUndefined();
    const no = refusal(await t.place(BUY_ORDER));
    expect([no.code, no.message]).toEqual(["E_VENUE_PERMISSION", `${WALLET} is watched, not proven yours: a swap is sent only from a wallet that signed for its address`]);
    expect(lifiCalls(http)).toEqual([]);
  });

  it("LI.FI refusing where the request comes from is its own rule: reported as that", async () => {
    for (const [status, body] of [[403, { message: "Forbidden" }], [451, { message: "Unavailable For Legal Reasons" }], [400, { message: "not available in your region" }]] as const) {
      const http = lifi([
        ["https://li.quest/v1/tokens?", { body: TOKENS }],
        ["https://li.quest/v1/quote", { status, body }],
      ]);
      const no = refusal(await trader(http, chainStandIn({ held: { "Base:USDC": 100, Base: 0.01 } })).place(BUY_ORDER));
      expect(no.code).toBe("E_VENUE_GEOBLOCKED");
      expect(no.message).toMatch(/LI\.FI (does not serve this location|refused this machine \(HTTP 403\)).*the account does not look for a way around it/);
    }
    // the token list too
    const http = lifi([["https://li.quest/v1/tokens?", { status: 403, body: { message: "Forbidden" } }]]);
    expect(refusal(await trader(http, chainStandIn()).markets("")).code).toBe("E_VENUE_GEOBLOCKED");
  });

  it("LI.FI rate-limiting, down, or out of reach", async () => {
    const http = lifi([
      ["https://li.quest/v1/tokens?", { body: TOKENS }],
      ["https://li.quest/v1/quote", { status: 429, body: { message: "Too many requests", code: 1005 } }],
    ]);
    const no = refusal(await trader(http, chainStandIn({ held: { "Base:USDC": 100, Base: 0.01 } })).place(BUY_ORDER));
    expect([no.code, no.message]).toEqual(["E_VENUE_UNREACHABLE", "LI.FI is rate-limiting this machine: without a key it answers 75 quotes in two hours. Try again later"]);
    expect(refusal(await trader(lifi([["https://li.quest/v1/tokens?", { status: 502, body: undefined, text: "bad gateway" }]]), chainStandIn()).markets("")).code).toBe("E_VENUE_UNREACHABLE");
    expect(refusal(await trader(lifi([["https://li.quest/", new Error("getaddrinfo ENOTFOUND li.quest")]]), chainStandIn()).markets("")).code).toBe("E_VENUE_UNREACHABLE");
  });
});

/** LiFiGenericSwapCompleted, as LI.FI's contract logs it */
function swapLog(o: { receiver?: Hex; fromAsset: Hex; toAsset: Hex; fromAmount: bigint; toAmount: bigint; txId?: Hex }) {
  const abi = parseAbi(["event LiFiGenericSwapCompleted(bytes32 indexed transactionId, string integrator, string referrer, address receiver, address fromAssetId, address toAssetId, uint256 fromAmount, uint256 toAmount)"]);
  return {
    address: LIFI_DIAMOND.toLowerCase() as Hex,
    topics: encodeEventTopics({ abi, eventName: "LiFiGenericSwapCompleted", args: { transactionId: o.txId ?? TXID } }) as Hex[],
    data: encodeAbiParameters(parseAbiParameters("string, string, address, address, address, uint256, uint256"), ["account-demo", NATIVE, o.receiver ?? WALLET, o.fromAsset, o.toAsset, o.fromAmount, o.toAmount]),
  };
}

describe("a wallet's swaps through LI.FI: what became of them", () => {
  const SYMBOL = "WETH/USDC@Base";
  const done = (over: Record<string, unknown> = {}) => ({
    transactionId: TXID,
    sending: { txHash: HASH, amount: "27180000", token: { address: USDC_BASE, symbol: "USDC", decimals: 6 }, chainId: 8453, gasAmountUSD: "0.0049" },
    receiving: { txHash: HASH, amount: "10000000000000000", token: { address: WETH, symbol: "WETH", decimals: 18 }, chainId: 8453 },
    feeCosts: [{ name: "LIFI Fixed Fee", amountUSD: "0.068", included: true }],
    lifiExplorerLink: `https://scan.li.fi/tx/${HASH}`,
    fromAddress: WALLET.toLowerCase(),
    toAddress: WALLET.toLowerCase(),
    tool: "nordstern",
    status: "DONE",
    substatus: "COMPLETED",
    substatusMessage: "The transfer is complete.",
    ...over,
  });
  const at = (answer: Answer, chain = chainStandIn()) => {
    const http = lifi([
      ["https://li.quest/v1/tokens?", { body: TOKENS }],
      ["https://li.quest/v1/status?", answer],
    ]);
    return { http, t: trader(http, chain) };
  };

  it("sent(): a hash for an order no swap was built for has nothing to be held to, so it is not followed; nor what is not a hash", async () => {
    const chain = chainStandIn({ txs: { [HASH]: { from: WALLET, to: LIFI_DIAMOND, data: "0x", value: 0n, chainId: 8453 } } });
    const { t } = at({ body: done() }, chain);
    const no = refusal(await t.sent!("ord-0001", HASH));
    expect([no.code, no.message]).toEqual(["E_ACCOUNT_ORDER_UNKNOWN", `no swap was built here for ord-0001: there is nothing to hold ${HASH} to, so it is not followed`]);
    expect(refusal(await t.sent!("ord-0001", "0x1234" as Hex)).code).toBe("E_ACCOUNT_BAD_ACTION");
    expect(chain.asked).toEqual([]);
  });

  it("DONE · COMPLETED, a buy: filled, the WETH received, dollars a WETH with LI.FI's fee inside, the fee and gas in dollars", async () => {
    const { t, http } = at({ body: done() });
    const s = ok(await t.status(HASH, SYMBOL));
    expect(lifiCalls(http).filter((a) => a.url.includes("/status")).map((a) => `${a.method} ${a.url}`)).toEqual([`GET ${STATUS_URL}`]);
    expect([s.ref, s.status, s.filledQty, s.avgPrice, s.feeUsd]).toEqual([HASH, "filled", 0.01, 2718, 0.0729]);
    expect(s.native).toEqual({ side: "buy", status: "DONE", substatus: "COMPLETED", said: "The transfer is complete.", tool: "nordstern", transactionId: TXID, explorer: `https://scan.li.fi/tx/${HASH}` });
  });

  it("DONE · COMPLETED, a sell: the token sold is what filled, the USDC received is the price", async () => {
    const { t } = at({ body: done({ sending: { amount: "9940000000000000", token: { address: NATIVE, symbol: "ETH", decimals: 18 }, gasAmountUSD: "0.0049" }, receiving: { amount: "26904064", token: { address: USDC_BASE, symbol: "USDC", decimals: 6 } } }) });
    const s = ok(await t.status(HASH, "ETH/USDC@Base"));
    expect([s.status, s.filledQty]).toEqual(["filled", 0.00994]);
    expect(s.avgPrice).toBeCloseTo(2706.6462777, 6);
  });

  it("DONE · REFUNDED: canceled, nothing filled; PARTIAL: money moved, so the chain decides, never 'nothing filled'; FAILED: rejected", async () => {
    const r = ok(await at({ body: done({ substatus: "REFUNDED" }) }).t.status(HASH, SYMBOL));
    expect([r.status, r.filledQty]).toEqual(["canceled", 0]);
    const chain = chainStandIn();
    const p = ok(await at({ body: done({ substatus: "PARTIAL" }) }, chain).t.status(HASH, SYMBOL));
    expect([p.status, p.filledQty]).toEqual(["pending", 0]);
    expect(chain.asked).toContain(`receipt:Base:${HASH}`);
    const f = ok(await at({ body: done({ status: "FAILED", substatus: "SLIPPAGE_EXCEEDED", substatusMessage: "Return amount is not enough" }) }).t.status(HASH, SYMBOL));
    expect([f.status, f.filledQty, (f.native as { substatus: string }).substatus]).toEqual(["rejected", 0, "SLIPPAGE_EXCEEDED"]);
  });

  it("PENDING, NOT_FOUND, LI.FI's 404 for a hash it has not seen, or LI.FI out of reach: the chain's receipt answers", async () => {
    const answers: Answer[] = [{ body: { status: "PENDING", substatus: "WAIT_SOURCE_CONFIRMATIONS" } }, { body: { status: "NOT_FOUND" } }, { status: 404, body: { message: `Transaction hash '${HASH}' not found on chain '8453'`, code: 1003 } }, new Error("socket hang up")];
    for (const a of answers) {
      // not mined yet
      const chain = chainStandIn();
      const s = ok(await at(a, chain).t.status(HASH, SYMBOL));
      expect([s.status, s.filledQty]).toEqual(["pending", 0]);
      expect(chain.asked).toContain(`receipt:Base:${HASH}`);
    }
    // reverted: nothing moved but the fee
    const reverted = ok(await at({ status: 404, body: { code: 1003 } }, chainStandIn({ receipts: { [HASH]: { status: "reverted", from: WALLET, to: LIFI_DIAMOND, logs: [] } } })).t.status(HASH, SYMBOL));
    expect([reverted.status, reverted.filledQty]).toEqual(["rejected", 0]);
    // mined: LI.FI's contract says what this wallet received
    const mined: Mined = { status: "success", from: WALLET, to: LIFI_DIAMOND, logs: [swapLog({ receiver: made(0xbad), fromAsset: USDC_BASE, toAsset: WETH, fromAmount: 1n, toAmount: 1n }), swapLog({ fromAsset: USDC_BASE, toAsset: WETH, fromAmount: 27_180_000n, toAmount: 10_000_000_000_000_000n })] };
    const filled = ok(await at({ status: 404, body: { code: 1003 } }, chainStandIn({ receipts: { [HASH]: mined } })).t.status(HASH, SYMBOL));
    expect([filled.status, filled.filledQty, filled.avgPrice]).toEqual(["filled", 0.01, 2718]);
    // mined, with no swap to this wallet in it: not counted as anything on a guess
    const other: Mined = { status: "success", from: WALLET, to: LIFI_DIAMOND, logs: [swapLog({ receiver: made(0xbad), fromAsset: USDC_BASE, toAsset: WETH, fromAmount: 1n, toAmount: 1n })] };
    expect(ok(await at({ status: 404, body: { code: 1003 } }, chainStandIn({ receipts: { [HASH]: other } })).t.status(HASH, SYMBOL)).status).toBe("pending");
  });

  it("an order LI.FI does not know, or a swap to someone else: not this order", async () => {
    expect(refusal(await at({ body: done() }).t.status("0x1234", SYMBOL)).code).toBe("E_ACCOUNT_ORDER_UNKNOWN");
    expect(refusal(await at({ body: done() }).t.status("", SYMBOL)).code).toBe("E_ACCOUNT_ORDER_UNKNOWN");
    const bad = refusal(await at({ status: 400, body: { message: "/txHash Not a valid txHash", code: 1011 } }).t.status(HASH, SYMBOL));
    expect([bad.code, bad.message]).toEqual(["E_ACCOUNT_ORDER_UNKNOWN", `LI.FI does not know ${HASH}: /txHash Not a valid txHash`]);
    expect(refusal(await at({ body: done({ toAddress: made(0xbad) }) }).t.status(HASH, SYMBOL)).code).toBe("E_ACCOUNT_ORDER_UNKNOWN");
  });

  it("cancel(): before the wallet sends, the order is dropped; once sent, only the chain decides; a done swap comes back as it is", async () => {
    expect(ok(await at({ body: done() }).t.cancel("", SYMBOL))).toEqual({ ref: "", status: "canceled", filledQty: 0, native: { canceled: "before the wallet sent it" } });
    const pending = refusal(await at({ body: { status: "PENDING" } }).t.cancel(HASH, SYMBOL));
    expect([pending.code, pending.message]).toEqual(["E_VENUE_REJECTED", `LI.FI has no cancel: the wallet sent ${HASH}, and on chain it either goes through whole or reverts. Only the wallet can replace it (the same nonce) before it is mined`]);
    const filled = ok(await at({ body: done() }).t.cancel(HASH, SYMBOL));
    expect([filled.status, filled.filledQty]).toEqual(["filled", 0.01]);
  });

  it("from place to fill: the hash the wallet sends is judged against the route that was prepared", async () => {
    const http = lifi([
      ["https://li.quest/v1/tokens?", { body: TOKENS }],
      ["https://li.quest/v1/quote/toAmount?", { body: quote(BUY) }],
      ["https://li.quest/v1/status?", { status: 404, body: { code: 1003 } }],
    ]);
    const mined: Mined = { status: "success", from: WALLET, to: LIFI_DIAMOND, logs: [swapLog({ txId: `0x${"22".repeat(32)}`, fromAsset: USDC_BASE, toAsset: WETH, fromAmount: 1n, toAmount: 1n }), swapLog({ fromAsset: USDC_BASE, toAsset: WETH, fromAmount: 27_180_000n, toAmount: 10_000_000_000_000_000n })] };
    const t = trader(http, chainStandIn({ held: { "Base:USDC": 100, Base: 0.01 }, allowance: 0n, receipts: { [HASH]: mined } }));
    ok(await t.place({ symbol: SYMBOL, side: "buy", type: "market", qty: 0.01, clientId: "ord-0001" }));
    expect(ok(await t.sent!("ord-0001", HASH)).native).toEqual({ sent: HASH, clientId: "ord-0001", transactionId: TXID });
    const s = ok(await t.status(HASH, SYMBOL));
    expect([s.status, s.filledQty, s.avgPrice, (s.native as { transactionId: string }).transactionId]).toEqual(["filled", 0.01, 2718, TXID]);
  });
});

describe("a wallet's swaps through LI.FI: the order's worst price", () => {
  const BUY_ORDER: OrderRequest = { symbol: "WETH/USDC@Base", side: "buy", type: "market", qty: 0.01, clientId: CLIENT };
  const SELL_ORDER: OrderRequest = { symbol: "ETH/USDC@Base", side: "sell", type: "market", qty: 0.005, clientId: CLIENT };
  const buying = (q = quote(BUY)) => lifi([["https://li.quest/v1/tokens?", { body: TOKENS }], ["https://li.quest/v1/quote/toAmount?", { body: q }]]);
  const selling = () => lifi([["https://li.quest/v1/tokens?", { body: TOKENS }], ["https://li.quest/v1/quote?", { body: quote(SELL_ETH) }]]);
  const wallet = () => chainStandIn({ held: { "Base:USDC": 100, Base: 0.01 }, allowance: 0n });

  it("a buy is held to the account's worst price where it is tighter than 2% room: $27.18 for at least 0.00995 WETH is $2,731.66 a WETH", async () => {
    // the room alone (2708.18 + 2% = 2762.34) lets it through; the order's 2720 does not
    const no = refusal(await trader(buying(), wallet()).place({ ...BUY_ORDER, worstPrice: 2720 }));
    expect([no.code, no.message]).toEqual(["E_ACCOUNT_REQUOTE", "LI.FI's route costs $27.18 for at least 0.00995 WETH, more than $27.06 (the order's worst price 2720 a WETH). Nothing was prepared"]);
    expect(no.detail).toMatchObject({ worstPrice: 2720 });
    const s = ok(await trader(buying(), wallet()).place({ ...BUY_ORDER, worstPrice: 2740 }));
    expect(s.walletTxs!.map((x) => x.what)).toEqual(["approve", "swap"]);
    expect((s.native as { worstPrice: number }).worstPrice).toBe(2740);
  });

  it("a sell is held to the least the account's worst price allows: at least $13.4723 for 0.005 ETH is under 2700 a ETH", async () => {
    const no = refusal(await trader(selling(), chainStandIn({ held: { Base: 0.01 } })).place({ ...SELL_ORDER, worstPrice: 2700 }));
    expect([no.code, no.message]).toEqual(["E_ACCOUNT_REQUOTE", "LI.FI's route pays at least $13.47 for 0.005 ETH, less than $13.50 (the order's worst price 2700 a ETH). Nothing was prepared"]);
    expect((ok(await trader(selling(), chainStandIn({ held: { Base: 0.01 } })).place({ ...SELL_ORDER, worstPrice: 2690 })).native as { worstPrice: number }).worstPrice).toBe(2690);
  });

  it("a worst price looser than 2% room never loosens it; one that is not a price is not taken; an order id names one worst price", async () => {
    const no = refusal(await trader(buying(quote({ ...BUY, fromAmount: 28_000_000n })), wallet()).place({ ...BUY_ORDER, worstPrice: 3000 }));
    expect([no.code, no.message]).toEqual(["E_ACCOUNT_REQUOTE", "LI.FI's route costs $28.00 for at least 0.00995 WETH, more than $27.49 (its price 2708.18 with 2% room). Nothing was prepared"]);
    expect((ok(await trader(buying(), wallet()).place({ ...BUY_ORDER, worstPrice: 3000 })).native as { worstPrice: number }).worstPrice).toBeCloseTo(2762.3436, 9);
    // a sell: at least $13.00 for 0.005 ETH is 2600 a ETH, under 2708.18 less 2%, however low the account would let it go
    const low = lifi([["https://li.quest/v1/tokens?", { body: TOKENS }], ["https://li.quest/v1/quote?", { body: quote({ ...SELL_ETH, toAmountMin: 13_000_000n }) }]]);
    const sell = refusal(await trader(low, chainStandIn({ held: { Base: 0.01 } })).place({ ...SELL_ORDER, worstPrice: 1 }));
    expect([sell.code, sell.message]).toEqual(["E_ACCOUNT_REQUOTE", "LI.FI's route pays at least $13.00 for 0.005 ETH, less than $13.27 (its price 2708.18 less 2%). Nothing was prepared"]);
    for (const worstPrice of [0, -1, Number.NaN]) {
      const http = buying();
      const bad = refusal(await trader(http, wallet()).place({ ...BUY_ORDER, worstPrice }));
      expect([bad.code, bad.message]).toEqual(["E_VENUE_ORDER_INVALID", "LI.FI: a market order's worst price is a price more than zero"]);
      expect(lifiCalls(http)).toEqual([]);
    }
    const t = trader(buying(), wallet());
    ok(await t.place({ ...BUY_ORDER, worstPrice: 2740 }));
    expect(refusal(await t.place({ ...BUY_ORDER, worstPrice: 2750 })).message).toBe(`${CLIENT} was already used for another order`);
  });
});

describe("a wallet's swaps through LI.FI: the swap built again once the approval is on chain", () => {
  const ORDER: OrderRequest = { symbol: "WETH/USDC@Base", side: "buy", type: "market", qty: 0.01, worstPrice: 2762, clientId: CLIENT };
  /** LI.FI answering the first quote, then (after `next`) the ones the test says */
  const setUp = (holds: ChainHolds = { held: { "Base:USDC": 100, Base: 0.01 }, allowance: 0n }) => {
    const rules: Array<[string | RegExp, Answer]> = [
      ["https://li.quest/v1/tokens?", { body: TOKENS }],
      ["https://li.quest/v1/quote/toAmount?", { body: quote(BUY) }],
    ];
    const http = lifi(rules);
    const chain = chainStandIn(holds);
    const t = trader(http, chain);
    const next = (q: ReturnType<typeof quote>) => rules.unshift(["https://li.quest/v1/quote/toAmount?", { body: q }]);
    return { http, chain, t, holds, next, quotes: () => lifiCalls(http).filter((a) => a.url.includes("/quote")).map((a) => a.url) };
  };

  it("requote(): a fresh quote for the same order, checked as the first was; the wallet is handed the swap alone, with its gas", async () => {
    const x = setUp();
    const first = ok(await x.t.place(ORDER));
    expect(first.walletTxs!.map((w) => w.what)).toEqual(["approve", "swap"]);
    // the wallet's approval is mined: it now allows LI.FI's contract exactly what the first route spends
    x.holds.allowance = 27_180_000n;
    const fresh = quote({ ...BUY, fromAmount: 27_170_000n, id: TXID2 });
    x.next(fresh);
    const again = ok(await x.t.requote!(ORDER));
    expect(x.quotes()).toEqual([BUY_URL, BUY_URL]);
    expect(again).toEqual({
      ref: "",
      status: "pending",
      filledQty: 0,
      walletTxs: [{ chainId: 8453, chainIdHex: "0x2105", from: WALLET, to: LIFI_DIAMOND, data: fresh.transactionRequest.data, value: "0x0", gas: "0xbc770", what: "swap" }],
      native: expect.objectContaining({ clientId: CLIENT, transactionId: TXID2, approvals: 0, requoted: true, worstPrice: 2762 }),
    } satisfies OrderState);
    // the account now holds the new swap: the hash the wallet sends is held to it, and followed as the fresh route
    const swap = again.walletTxs![0]!;
    x.holds.txs = { [HASH]: { from: swap.from, to: swap.to, data: swap.data, value: 0n, chainId: 8453 } };
    expect(ok(await x.t.sent!("ord-0001", HASH, swap)).native).toEqual({ sent: HASH, clientId: CLIENT, transactionId: TXID2 });
    // and the first swap, sent after all, is not this order's any more
    x.holds.txs = { [HASH]: { from: WALLET, to: LIFI_DIAMOND, data: first.walletTxs![1]!.data, value: 0n, chainId: 8453 } };
    expect(refusal(await x.t.sent!("ord-0001", HASH, swap)).message).toBe(`transaction ${HASH} is not this order's swap: it makes another call than the swap built. The order still waits for your wallet`);
  });

  it("held to the same order: a fresh route past its worst price is not built, nor one past the price the first swap was held to when LI.FI's price rose", async () => {
    let x = setUp();
    ok(await x.t.place(ORDER));
    x.holds.allowance = 27_180_000n;
    x.next(quote({ ...BUY, fromAmount: 28_000_000n, id: TXID2 }));
    let no = refusal(await x.t.requote!(ORDER));
    expect([no.code, no.message]).toEqual(["E_ACCOUNT_REQUOTE", "LI.FI's route costs $28.00 for at least 0.00995 WETH, more than $27.48 (the order's worst price 2762 a WETH). Nothing was prepared"]);
    // no worst price from the account: the room is the one the first swap was held to (2708.18 + 2%), not 2% over LI.FI's new price
    const ROOMY: OrderRequest = { symbol: "WETH/USDC@Base", side: "buy", type: "market", qty: 0.01, clientId: CLIENT };
    x = setUp();
    ok(await x.t.place(ROOMY));
    x.holds.allowance = 28_500_000n;
    x.next(quote({ ...BUY, fromAmount: 28_500_000n, toPrice: "2900", id: TXID2 }));
    no = refusal(await x.t.requote!(ROOMY));
    expect([no.code, no.message]).toEqual(["E_ACCOUNT_REQUOTE", "LI.FI's route costs $28.50 for at least 0.00995 WETH, more than $27.49 (the price the first swap was held to, 2762.3436 a WETH). Nothing was prepared"]);
  });

  it("held to the tighter of the order's worst price and the price the first swap was held to, never the looser of the two", async () => {
    // a buy: the order would pay up to 3000, the first swap was held to 2708.18 + 2%; LI.FI's price has risen to 2900
    const LOOSE: OrderRequest = { ...ORDER, worstPrice: 3000 };
    const x = setUp();
    ok(await x.t.place(LOOSE));
    x.holds.allowance = 28_500_000n;
    x.next(quote({ ...BUY, fromAmount: 28_500_000n, toPrice: "2900", id: TXID2 }));
    const buy = refusal(await x.t.requote!(LOOSE));
    expect([buy.code, buy.message]).toEqual(["E_ACCOUNT_REQUOTE", "LI.FI's route costs $28.50 for at least 0.00995 WETH, more than $27.49 (the price the first swap was held to, 2762.3436 a WETH). Nothing was prepared"]);
    // a sell of WETH: the order would take as little as 2000, the first swap was held to 2708.18 less 2%; LI.FI's price has fallen to 2500
    const SELL_WETH = { from: WETH, to: USDC_BASE, fromAmount: 10_000_000_000_000_000n, toAmount: 27_080_000n, toAmountMin: 26_944_600n, fromPrice: "2708.18", toPrice: "1.0003" };
    const SELL: OrderRequest = { symbol: "WETH/USDC@Base", side: "sell", type: "market", qty: 0.01, worstPrice: 2000, clientId: CLIENT };
    const rules: Array<[string | RegExp, Answer]> = [["https://li.quest/v1/tokens?", { body: TOKENS }], ["https://li.quest/v1/quote?", { body: quote(SELL_WETH) }]];
    const holds: ChainHolds = { held: { "Base:WETH": 1, Base: 0.01 }, allowance: 0n };
    const t = trader(lifi(rules), chainStandIn(holds));
    expect(ok(await t.place(SELL)).walletTxs!.map((w) => w.what)).toEqual(["approve", "swap"]);
    holds.allowance = 10_000_000_000_000_000n;
    rules.unshift(["https://li.quest/v1/quote?", { body: quote({ ...SELL_WETH, toAmount: 24_900_000n, toAmountMin: 24_800_000n, fromPrice: "2500", id: TXID2 }) }]);
    const sell = refusal(await t.requote!(SELL));
    expect([sell.code, sell.message]).toEqual(["E_ACCOUNT_REQUOTE", "LI.FI's route pays at least $24.80 for 0.01 WETH, less than $26.54 (the price the first swap was held to, 2654.0164 a WETH). Nothing was prepared"]);
  });

  it("the swap goes alone, so the wallet must already allow what the fresh route spends: short or unread, nothing is built", async () => {
    let x = setUp();
    ok(await x.t.place(ORDER));
    x.holds.allowance = 20_000_000n;
    x.next(quote({ ...BUY, id: TXID2 }));
    let no = refusal(await x.t.requote!(ORDER));
    expect([no.code, no.message]).toEqual(["E_ACCOUNT_REQUOTE", "the wallet allows LI.FI's contract 20 USDC, and the fresh route spends 27.18: take the order back and place it again. Nothing was prepared"]);
    x = setUp();
    ok(await x.t.place(ORDER));
    x.holds.allowance = undefined;
    no = refusal(await x.t.requote!(ORDER));
    expect(no.code).toBe("E_VENUE_UNREACHABLE");
  });

  it("a limit order, or an id that named another order, is not built again", async () => {
    const x = setUp();
    ok(await x.t.place(ORDER));
    expect(refusal(await x.t.requote!({ ...ORDER, type: "limit", limitPrice: 2500 })).code).toBe("E_VENUE_ORDER_INVALID");
    expect(refusal(await x.t.requote!({ ...ORDER, qty: 0.02 })).message).toBe(`${CLIENT} was already used for another order`);
    expect(x.quotes()).toHaveLength(1);
  });
});

describe("a wallet's swaps through LI.FI: the hash the wallet sent, held on chain to the swap that was built", () => {
  const ORDER: OrderRequest = { symbol: "WETH/USDC@Base", side: "buy", type: "market", qty: 0.01, worstPrice: 2762, clientId: CLIENT };
  const OTHER = made(0xbad);
  /** an order placed through the trader as the account places it (its id is not the account's `ord-0001`); the swap it handed the wallet */
  const placed = async (holds: ChainHolds, read: (o: ChainHolds) => ChainReader & { asked: string[] } = chainStandIn) => {
    const http = lifi([
      ["https://li.quest/v1/tokens?", { body: TOKENS }],
      ["https://li.quest/v1/quote/toAmount?", { body: quote(BUY) }],
      ["https://li.quest/v1/status?", { status: 404, body: { code: 1003 } }],
    ]);
    // the test's own object, so what it puts on the chain later is what the chain holds
    holds.held ??= { "Base:USDC": 100, Base: 0.01 };
    if (!("allowance" in holds)) holds.allowance = 0n;
    const chain = read(holds);
    const paused: number[] = [];
    const t = trader(http, chain, { proven: "OKX Wallet", pause: async (ms) => void paused.push(ms) });
    const swap = ok(await t.place(ORDER)).walletTxs!.at(-1)!;
    chain.asked.length = 0;
    return { t, chain, swap, paused };
  };
  const asSent = (w: { from: Hex; to: Hex; data: Hex; value: Hex }, over: Partial<SentTx> = {}): SentTx => ({ from: w.from, to: w.to, data: w.data, value: BigInt(w.value), chainId: 8453, ...over });

  it("the transaction, read from the chain by its hash, is the swap built (sender, contract, call, coin, chain): it is followed as this order's route", async () => {
    const holds: ChainHolds = {};
    const { t, chain, swap } = await placed(holds);
    holds.txs = { [HASH]: asSent(swap) };
    // the account names the order by its own id and hands the swap it built: the route is found by that swap
    expect(ok(await t.sent!("ord-0001", HASH, swap))).toEqual({ ref: HASH, status: "pending", filledQty: 0, native: { sent: HASH, clientId: CLIENT, transactionId: TXID } });
    expect(chain.asked).toEqual([`tx:Base:${HASH}`]);
    // followed from then on as that route: the chain's log of a swap with another id in the same transaction is not this order's fill
    holds.receipts = { [HASH]: { status: "success", from: WALLET, to: LIFI_DIAMOND, logs: [swapLog({ txId: `0x${"22".repeat(32)}`, fromAsset: USDC_BASE, toAsset: WETH, fromAmount: 1n, toAmount: 1n }), swapLog({ fromAsset: USDC_BASE, toAsset: WETH, fromAmount: 27_180_000n, toAmount: 10_000_000_000_000_000n })] } };
    const s = ok(await t.status(HASH, "WETH/USDC@Base"));
    expect([s.status, s.filledQty, s.avgPrice]).toEqual(["filled", 0.01, 2718]);
  });

  it("another transaction is refused, in the venue's words, and the order keeps waiting: another sender, contract, call, coin or chain", async () => {
    const cases: Array<[Partial<SentTx>, string]> = [
      [{ from: OTHER }, "it is from another address"],
      [{ to: OTHER }, `it goes to another address than ${LIFI_DIAMOND}`],
      [{ to: null }, `it goes to another address than ${LIFI_DIAMOND}`],
      [{ data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [OTHER, 27_180_000n] }) }, "it makes another call than the swap built"],
      [{ value: 1n }, "it sends another amount of the chain's own coin"],
      [{ chainId: 1 }, "it is for chain 1, not 8453"],
    ];
    for (const [over, why] of cases) {
      const holds: ChainHolds = {};
      const { t, swap } = await placed(holds);
      holds.txs = { [HASH]: asSent(swap, over) };
      const no = refusal(await t.sent!("ord-0001", HASH, swap));
      expect([no.code, no.message]).toEqual(["E_VENUE_REJECTED", `transaction ${HASH} is not this order's swap: ${why}. The order still waits for your wallet`]);
      // nothing about the order changed: the right transaction is still taken
      holds.txs = { [HASH]: asSent(swap) };
      expect(ok(await t.sent!("ord-0001", HASH, swap)).ref).toBe(HASH);
    }
    // two things wrong: both said
    const holds: ChainHolds = {};
    const { t, swap } = await placed(holds);
    holds.txs = { [HASH]: asSent(swap, { from: OTHER, value: 5n }) };
    expect(refusal(await t.sent!("ord-0001", HASH, swap)).message).toBe(`transaction ${HASH} is not this order's swap: it is from another address; it sends another amount of the chain's own coin. The order still waits for your wallet`);
  });

  it("a transaction the chain's endpoint has not seen yet is looked for again a few seconds apart; never seen, it is not followed", async () => {
    let holds: ChainHolds = { seenAfter: 2 };
    let x = await placed(holds);
    holds.txs = { [HASH]: asSent(x.swap) };
    expect(ok(await x.t.sent!("ord-0001", HASH, x.swap)).ref).toBe(HASH);
    expect(x.paused).toEqual([2000, 2000]);
    holds = {};
    x = await placed(holds);
    const no = refusal(await x.t.sent!("ord-0001", HASH, x.swap));
    expect([no.code, no.message]).toEqual(["E_VENUE_UNREACHABLE", `Base does not show transaction ${HASH} yet, so it could not be held to this order's swap: the order still waits for your wallet. Tell the account the hash again in a minute`]);
    expect(x.paused).toEqual([2000, 2000, 2000, 2000]);
    expect(x.chain.asked.filter((a) => a.startsWith("tx:"))).toHaveLength(5);
  });

  it("a chain reader that cannot read a transaction by hash: its receipt (sender, contract) and LI.FI's log of a swap with this order's id, to this wallet", async () => {
    const log = (txId: Hex, receiver: Hex = WALLET) => swapLog({ txId, receiver, fromAsset: USDC_BASE, toAsset: WETH, fromAmount: 27_180_000n, toAmount: 10_000_000_000_000_000n });
    const mined = (over: Partial<Mined>): Mined => ({ status: "success", from: WALLET, to: LIFI_DIAMOND, logs: [log(TXID)], ...over });
    const run = async (m: Mined | undefined) => {
      const holds: ChainHolds = {};
      const x = await placed(holds, receiptsOnly);
      if (m) holds.receipts = { [HASH]: m };
      return { ...x, out: await x.t.sent!("ord-0001", HASH, x.swap) };
    };
    const yes = await run(mined({}));
    expect(ok(yes.out).native).toEqual({ sent: HASH, clientId: CLIENT, transactionId: TXID });
    expect(yes.chain.asked).toEqual([`receipt:Base:${HASH}`]);
    const said = async (m: Mined) => refusal((await run(m)).out).message;
    expect(await said(mined({ logs: [log(TXID2)] }))).toBe(`transaction ${HASH} is not this order's swap: LI.FI's contract logged no swap with this order's id to this wallet in it. The order still waits for your wallet`);
    expect(await said(mined({ logs: [log(TXID, OTHER)] }))).toContain("logged no swap with this order's id to this wallet");
    expect(await said(mined({ from: OTHER }))).toContain("it is from another address");
    expect(await said(mined({ to: OTHER }))).toContain(`it goes to another address than ${LIFI_DIAMOND}`);
    expect(await said(mined({ status: "reverted", logs: [] }))).toContain("it reverted, and without its call nothing ties it to this order");
    // not mined yet, and no way to read it before it is: looked for, then not followed
    expect(refusal((await run(undefined)).out).code).toBe("E_VENUE_UNREACHABLE");
  });

  it("a swap built for a chain not swapped on here is not followed, and the chain is not asked", async () => {
    const { t, chain, swap } = await placed({});
    const no = refusal(await t.sent!("ord-0001", HASH, { ...swap, chainId: 43114, chainIdHex: "0xa86a" }));
    expect([no.code, no.message]).toEqual(["E_VENUE_REJECTED", `the swap built for this order is for chain 43114, not one swapped on here: ${HASH} is not followed`]);
    expect(chain.asked).toEqual([]);
  });
});

describe("the wallet connector carries the trader", () => {
  it("walletSource: a proven wallet trades tokens on the seven chains, tokenised shares among them; a watched one does not; connecting asks LI.FI nothing", async () => {
    const http = lifi([]);
    const proven = await walletSource({ venue: "wallet-1", label: "OKX Wallet", address: WALLET.toLowerCase(), proven: "OKX Wallet", http, chain: chainStandIn({ held: { "Base:USDC": 12 } }) });
    if (isRefusal(proven)) throw new Error(proven.message);
    expect(proven.source.trader).toBeDefined();
    expect([proven.source.trader!.can, proven.source.trader!.what]).toEqual([true, "tokens on Ethereum, Optimism, BNB Chain, Polygon, Base, Arbitrum, Robinhood Chain, tokenised shares among them (Robinhood Stock Tokens, Ondo Stocks, xStocks)"]);
    expect(proven.source.trader!.sent).toBeTypeOf("function");
    // the reads are what they were
    expect(proven.first).toEqual([{ asset: "USDC", amount: 12, where: "Base" }]);
    const watched = await walletSource({ venue: "wallet-2", label: "", address: WALLET, http, chain: chainStandIn() });
    if (isRefusal(watched)) throw new Error(watched.message);
    expect(watched.source.trader!.can).toBe(false);
    expect(lifiCalls(http)).toEqual([]);
  });
});
