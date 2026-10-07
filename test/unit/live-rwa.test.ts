import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, erc20Abi, getAddress, parseAbi, parseAbiParameters, type Hex } from "viem";
import { isRefusal, type Refusal } from "../../src/core/errors.ts";
import { walletSource } from "../../src/portfolio/live/address.ts";
import { STABLECOINS, type ChainName, type ChainReader, type Mined, type SentTx } from "../../src/portfolio/live/chain.ts";
import { LIFI_DIAMOND, LIFI_SWAP_ABI, USDG_ROBINHOOD, dexTrader, diamondOn, type RwaMarket } from "../../src/portfolio/live/dex.ts";
import { exploreAcross } from "../../src/portfolio/live/explore.ts";
import type { PublicSource } from "../../src/portfolio/live/public-markets.ts";
import { inDollars, type LiveTrader, type Market } from "../../src/portfolio/live/trade.ts";
import type { Http } from "../../src/portfolio/live/types.ts";

/** Tokenised shares from the user's own wallet, with every real thing replaced by a stand-in: LI.FI, Robinhood's Stock Token list and
 * xStocks' list are an Http that records each request and answers what the test says; the chain is a reader that holds what the test says
 * and answers Ondo's contracts as the test says. The addresses of the issuers' tokens are their real ones (they are pinned in dex.ts); the
 * wallet is made up, and no key exists anywhere in this file — LI.FI takes none, and the wallet signs, never this process. */

const WALLET = getAddress("0x00000000000000000000000000000000000a11ce");
const NATIVE: Hex = "0x0000000000000000000000000000000000000000";
const made = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const usdcOn = (c: ChainName) => STABLECOINS.find((t) => t.chain === c && t.asset === "USDC")!.address;
const USDC_ETH = usdcOn("Ethereum");
const USDC_BNB = usdcOn("BNB Chain");
const USDG = USDG_ROBINHOOD.address;
const DIAMOND_RH = diamondOn("Robinhood Chain");
// the issuers' own tokens
const TSLAON = getAddress("0xf6b1117ec07684D3958caD8BEb1b302bfD21103f");
const NVDAON_ETH = getAddress("0x2D1F7226Bd1F780AF6B9A49DCC0aE00E8Df4bDEE");
const NVDAON_BNB = getAddress("0xa9ee28c80f960b889dfbd1902055218cba016f75");
const NVDAX = getAddress("0xc845b2894dbddd03858fd2d643b4ef725fe0849d");
const TSLAX = getAddress("0x8ad3c73f833d3f9a523ab01476625f269aeb7cf0");
const OUSG = getAddress("0x1B19C19393e2d034D8Ff31ff34c81252FcBbee92");
const NVDA_RH = getAddress("0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC");
const CRM_RH = getAddress("0xd95B44124e475743a7589e68F3D74008A5536D44");
// made up: an Ondo-named token LI.FI verifies, Robinhood's NET, and another token LI.FI lists as NET on Robinhood Chain
const HIMSON = made(0x2001);
const NET_RH = made(0x3001);
const NET_OTHER = made(0x3002);
const ONDO_MANAGER = getAddress("0x2c158BC456e027b2AfFCCadF1BDBD9f5fC4c5C8c");
const PAUSER = made(0x4001);
const TXID: Hex = "0xb9cf949dbddf7a8d9b89df32c250b57ee382fb3c732c99415b1fc0726be38d34";
const HASH: Hex = "0x268762998feda84a4a6241b389e57bba1dfcd6346a7415a61d09e7c6a927b84d";
const T = Date.parse("2026-10-06T14:00:00.000Z");

const tok = (chainId: number, address: Hex, symbol: string, decimals: number, priceUSD: string | undefined, verificationStatus = "verified", name = symbol) => ({ chainId, address, symbol, name, decimals, ...(priceUSD !== undefined ? { priceUSD } : {}), verificationStatus });
/** LI.FI's GET /v1/tokens: no NVDAon on Ethereum (as on 2026-10-06), and on Robinhood Chain nothing verified, an NVDA, and a NET that is not
 * Robinhood's */
const TOKENS = {
  tokens: {
    "1": [
      tok(1, USDC_ETH, "USDC", 6, "1.0001", "verified", "USD Coin"),
      tok(1, NATIVE, "ETH", 18, "2700"),
      tok(1, TSLAON, "TSLAon", 18, "380", "verified", "Tesla (Ondo Tokenized)"),
      tok(1, NVDAX, "NVDAx", 18, "239.9", "verified", "NVIDIA xStock"),
      tok(1, HIMSON, "HIMSon", 18, "29.8", "verified", "Hims & Hers Health (Ondo Tokenized)"),
      tok(1, made(0x2002), "MAG7Xon", 18, "102", "verified", "Ondo Magnificent 7 and Crypto Portfolio"),
      tok(1, OUSG, "OUSG", 18, "116.8", "verified", "Ondo Short-Term U.S. Government Bond Fund"),
    ],
    "56": [tok(56, USDC_BNB, "USDC", 18, "1"), tok(56, NATIVE, "BNB", 18, "600"), tok(56, NVDAON_BNB, "NVDAon", 18, "239.85", "verified", "Nvdia Corporation"), tok(56, TSLAX, "TSLAx", 18, "379.9", "verified", "Tesla xStock")],
    "4663": [
      tok(4663, USDG, "USDG", 6, "1.0003", "unverified", "USDG"),
      tok(4663, NATIVE, "ETH", 18, "2700", "unverified"),
      tok(4663, NVDA_RH, "NVDA", 18, "239.8", "unverified", "NVIDIA"),
      tok(4663, NET_OTHER, "NET", 18, "0.01", "unverified", "NetNet"),
    ],
  },
};
/** Robinhood's own list (GET api.robinhood.com/rhj/assets): its NET is at another address than LI.FI's NET; CRM is not on LI.FI's list */
const RH_ASSETS = {
  assets: [
    { tokenSymbol: "NVDA", tokenName: "NVIDIA • Robinhood Token", status: "ASSET_STATUS_ACTIVE", tokenDecimals: 18, deployments: [{ contractAddress: NVDA_RH, chainId: 4663 }] },
    { tokenSymbol: "NET", tokenName: "Cloudflare • Robinhood Token", status: "ASSET_STATUS_ACTIVE", tokenDecimals: 18, deployments: [{ contractAddress: NET_RH, chainId: 4663 }] },
    { tokenSymbol: "CRM", tokenName: "Salesforce • Robinhood Token", status: "ASSET_STATUS_ACTIVE", tokenDecimals: 18, deployments: [{ contractAddress: CRM_RH, chainId: 4663 }] },
  ],
};
/** xStocks' own record of a token (GET api.xstocks.fi/api/v2/public/assets/{symbol}), as it answers: one address on every chain */
const xstock = (symbol: string, address: Hex, halted = false) => ({ id: "x", name: `${symbol} xStock`, symbol, isTradingHalted: halted, trading: { isTradingHalted: halted, openNow: true }, deployments: ["Ethereum", "BinanceSmartChain", "Arbitrum", "Optimism", "Solana"].map((network) => ({ network, address: network === "Solana" ? "Xs…" : address.toLowerCase() })) });

type Answer = { status?: number; body?: unknown } | Error | ((url: string) => { status?: number; body?: unknown });
/** the network, as the test says it answers: the first rule whose pattern the URL starts with answers; anything else is no network */
function net(rules: Array<[string, Answer]>): Http & { asked: string[] } {
  const asked: string[] = [];
  const http = (async (url) => {
    asked.push(url);
    for (const [m, a] of rules) {
      if (!url.startsWith(m)) continue;
      if (a instanceof Error) throw a;
      const r = typeof a === "function" ? a(url) : a;
      return { status: r.status ?? 200, body: r.body, text: JSON.stringify(r.body ?? "") };
    }
    return { status: 599, body: undefined, text: "no network in tests" };
  }) as Http & { asked: string[] };
  http.asked = asked;
  return http;
}
const BASE_RULES: Array<[string, Answer]> = [
  ["https://li.quest/v1/tokens?", { body: TOKENS }],
  ["https://api.robinhood.com/rhj/assets", { body: RH_ASSETS }],
];

/** a chain that holds what the test says (`"Ethereum:USDC"` → whole tokens, `"Ethereum"` → its coin) and answers Ondo's contracts as told */
interface Holds {
  held?: Record<string, number>;
  /** gmTokenAccepted by token; tokenPauseManager answers PAUSER; isTokenPaused by token */
  accepted?: Record<string, bigint | undefined>;
  paused?: Record<string, bigint | undefined>;
  allowance?: bigint;
  receipts?: Record<string, Mined>;
  txs?: Record<string, SentTx>;
}
function chainOf(o: Holds = {}): ChainReader & { asked: string[] } {
  const asked: string[] = [];
  const decimals: Record<string, number> = { [USDC_ETH.toLowerCase()]: 6, [USDC_BNB.toLowerCase()]: 18, [USDG.toLowerCase()]: 6 };
  return {
    asked,
    async tokens(holder, refs) {
      asked.push(`tokens:${refs.map((r) => `${r.chain}:${r.asset}`).join(",")}`);
      return { rows: refs.map((r) => ({ chain: r.chain, asset: r.asset, amount: o.held?.[`${r.chain}:${r.asset}`] ?? 0 })), failed: [] };
    },
    async native(holder, chains) {
      asked.push(`native:${chains.join(",")}`);
      return { rows: chains.map((c) => ({ chain: c, asset: c === "BNB Chain" ? "BNB" : c === "Polygon" ? "POL" : "ETH", amount: o.held?.[c] ?? 0 })), failed: [] };
    },
    async uint(chain, address, signature, args = []) {
      const fn = /function\s+(\w+)/.exec(signature)?.[1] ?? "";
      asked.push(`uint:${chain}:${address}:${fn}:${args.join(",")}`);
      if (fn === "gmTokenAccepted") return o.accepted?.[String(args[0]).toLowerCase()];
      if (fn === "tokenPauseManager") return BigInt(PAUSER);
      if (fn === "isTokenPaused") return address === PAUSER ? o.paused?.[String(args[0]).toLowerCase()] : undefined;
      if (fn === "allowance") return o.allowance;
      return undefined;
    },
    async decimals(chain, token) {
      asked.push(`decimals:${chain}:${token}`);
      return decimals[token.toLowerCase()] ?? 18;
    },
    async receipt(chain, hash) {
      asked.push(`receipt:${chain}:${hash}`);
      return o.receipts?.[hash.toLowerCase()];
    },
    async transaction(chain, hash) {
      asked.push(`tx:${chain}:${hash}`);
      return o.txs?.[hash.toLowerCase()];
    },
  };
}

/** LI.FI's quote for a same-chain swap, built the way LI.FI's contract takes it (a fee leg, then the DEX leg), on any chain */
function quote(o: { chainId: number; diamond: Hex; from: Hex; to: Hex; fromAmount: bigint; toAmount: bigint; toAmountMin: bigint; fromPrice: string; toPrice: string }) {
  const legs = [
    { callTo: made(0xfee), approveTo: made(0xfee), sendingAssetId: o.from, receivingAssetId: o.from, fromAmount: o.fromAmount, callData: "0x" as Hex, requiresDeposit: true },
    { callTo: made(0xde), approveTo: made(0xde), sendingAssetId: o.from, receivingAssetId: o.to, fromAmount: (o.fromAmount * 9975n) / 10000n, callData: "0x1234" as Hex, requiresDeposit: false },
  ];
  const data = encodeFunctionData({ abi: LIFI_SWAP_ABI, functionName: "swapTokensMultipleV3ERC20ToERC20", args: [TXID, "account-demo", NATIVE, WALLET, o.toAmountMin, legs] } as never);
  return {
    type: "lifi",
    id: "route-rwa-1",
    tool: "nordstern",
    action: { fromChainId: o.chainId, toChainId: o.chainId, fromToken: { address: o.from, priceUSD: o.fromPrice }, toToken: { address: o.to, priceUSD: o.toPrice, tags: ["rwa"] }, fromAmount: o.fromAmount.toString(), slippage: 0.005, fromAddress: WALLET, toAddress: WALLET },
    estimate: { tool: "nordstern", approvalAddress: o.diamond, fromAmount: o.fromAmount.toString(), toAmount: o.toAmount.toString(), toAmountMin: o.toAmountMin.toString(), feeCosts: [{ name: "LIFI Fixed Fee", percentage: "0.0025", amountUSD: "0.06", included: true }], gasCosts: [{ type: "SEND", limit: "495404", amount: "1716702000000", amountUSD: "0.0046" }], fromAmountUSD: "24.00", toAmountUSD: "23.94" },
    transactionId: TXID,
    transactionRequest: { value: "0x0", to: o.diamond, data, chainId: o.chainId, gasLimit: "0x78f2c", from: WALLET },
  };
}

function trader(http: Http, chain: ChainReader, proven: string | undefined = "OKX Wallet"): LiveTrader {
  return dexTrader({ venue: "wallet-1", address: WALLET, proven, http, chain, now: () => T, pause: async () => {} });
}
const refusal = (x: unknown): Refusal => {
  if (!isRefusal(x)) throw new Error(`expected a refusal, got ${JSON.stringify(x)}`);
  return x;
};
const ok = <T>(x: T | Refusal): T => {
  if (isRefusal(x)) throw new Error(`${x.code}: ${x.message}`);
  return x;
};
const quotes = (h: { asked: string[] }) => h.asked.filter((u) => u.startsWith("https://li.quest/v1/quote"));

describe("tokenised shares a wallet swaps: the markets", () => {
  it("each issuer's tokens, found by address, priced in the chain's dollar, carrying the issuer and its own words", async () => {
    const http = net(BASE_RULES);
    const t = trader(http, chainOf());
    // to start from: the coins, then the best-known tokenised shares LI.FI prices
    const first = ok(await t.markets("")).map((m) => m.symbol);
    expect(first).toEqual(["ETH/USDC@Ethereum", "BNB/USDC@BNB Chain", "NVDA/USDG@Robinhood Chain", "TSLAon/USDC@Ethereum", "NVDAx/USDC@Ethereum", "NVDAon/USDC@BNB Chain", "MAG7Xon/USDC@Ethereum", "TSLAx/USDC@BNB Chain", "HIMSon/USDC@Ethereum"]);
    // "RWA" finds the tokens issuers stand behind (twenty at most, like any search); one market is found by its symbol
    const rwa = ok(await t.markets("RWA")) as RwaMarket[];
    expect(rwa.length).toBe(20);
    expect(rwa.every((m) => m.category === "RWA")).toBe(true);
    const by = { get: async (symbol: string) => (ok(await t.markets(symbol.split("/")[0]!)) as RwaMarket[]).find((m) => m.symbol === symbol), has: async (symbol: string) => (ok(await t.markets(symbol.split("/")[0]!)) as RwaMarket[]).some((m) => m.symbol === symbol && m.category === "RWA") };
    // a Robinhood Stock Token: against USDG, named by Robinhood's list, with Robinhood's words
    expect(await by.get("NVDA/USDG@Robinhood Chain")).toEqual({
      symbol: "NVDA/USDG@Robinhood Chain",
      name: "NVIDIA · Robinhood Stock Token on Robinhood Chain",
      kind: "token",
      base: "NVDA",
      quote: "USDG",
      price: 239.8,
      qtyStep: 1e-8,
      minNotional: 1,
      open: true,
      note: expect.stringContaining("Robinhood Stock Token, issued by Robinhood Assets (Jersey) Limited. Robinhood: Stock Tokens “may not be offered, sold, or delivered"),
      types: ["market"],
      category: "RWA",
      issuer: "Robinhood Assets (Jersey) Limited",
      eligibility: expect.stringContaining("U.S. persons"),
    } satisfies RwaMarket);
    // Robinhood's list makes a token on Robinhood Chain a Stock Token: CRM though LI.FI's list leaves it out (unpriced until opened); NET at
    // Robinhood's own address, never the other NET LI.FI lists there
    expect(await by.get("CRM/USDG@Robinhood Chain")).toMatchObject({ name: "Salesforce · Robinhood Stock Token on Robinhood Chain", price: undefined, issuer: "Robinhood Assets (Jersey) Limited" });
    expect((await by.get("NET/USDG@Robinhood Chain"))?.name).toBe("Cloudflare · Robinhood Stock Token on Robinhood Chain");
    // Ondo Stocks: the best known from Ondo's own list (NVDAon on Ethereum, which LI.FI's list leaves out), and one LI.FI verifies under
    // Ondo's symbols; its portfolio token is not an Ondo Stock
    expect(await by.get("TSLAon/USDC@Ethereum")).toMatchObject({ name: "Tesla · Ondo Stock on Ethereum", issuer: "Ondo Global Markets", price: 380, open: true });
    expect((await by.get("TSLAon/USDC@Ethereum"))!.eligibility).toContain("“prohibited from subscribing for, acquiring or redeeming Ondo Stocks”");
    expect((await by.get("NVDAon/USDC@BNB Chain"))?.name).toBe("NVIDIA · Ondo Stock on BNB Chain");
    expect((await by.get("HIMSon/USDC@Ethereum"))?.issuer).toBe("Ondo Global Markets");
    expect(await by.has("MAG7Xon/USDC@Ethereum")).toBe(false);
    expect(ok(await t.markets("NVDAon")).map((m) => m.symbol)).toEqual(["NVDAon/USDC@BNB Chain", "NVDAon/USDC@Ethereum"]);
    // xStocks, with their issuer's words
    expect(await by.get("NVDAx/USDC@Ethereum")).toMatchObject({ name: "NVIDIA · xStock on Ethereum", issuer: "Backed (xStocks)", eligibility: expect.stringContaining("not intended for distribution in the United States") });
    // OUSG is shown with Ondo's rule, and takes no order
    expect(await by.get("OUSG/USDC@Ethereum")).toMatchObject({ open: false, types: [], issuer: "Ondo Finance", eligibility: expect.stringContaining("OndoIDRegistry") });
    // an issuer's name finds its tokens
    const ondo = ok(await t.markets("ondo"));
    expect(ondo.map((m) => m.symbol)).toEqual(expect.arrayContaining(["TSLAon/USDC@Ethereum", "NVDAon/USDC@BNB Chain", "NVDAon/USDC@Ethereum"]));
    expect(ondo.filter((m) => m.category === "RWA").every((m) => (m as RwaMarket).issuer.startsWith("Ondo"))).toBe(true);
    expect(ok(await t.markets("backed")).every((m) => (m as RwaMarket).issuer === "Backed (xStocks)")).toBe(true);
    // one list from LI.FI, one from Robinhood, kept
    expect(http.asked).toEqual(["https://li.quest/v1/tokens?chains=1,10,56,137,8453,42161,4663", "https://api.robinhood.com/rhj/assets"]);
  });

  it("market(): the issuer is asked first — Ondo's GMTokenManager and the token's pause manager, xStocks' own list, Robinhood's list — then LI.FI's price now", async () => {
    const http = net([
      ...BASE_RULES,
      [`https://li.quest/v1/token?chain=1&token=${TSLAON}`, { body: tok(1, TSLAON, "TSLAon", 18, "381.2", "verified") }],
      [`https://li.quest/v1/token?chain=1&token=${NVDAX}`, { body: tok(1, NVDAX, "NVDAx", 18, "240.1", "verified") }],
      [`https://li.quest/v1/token?chain=4663&token=${CRM_RH}`, { body: tok(4663, CRM_RH, "CRM", 18, "228.44", "unverified") }],
      [`https://li.quest/v1/token?chain=4663&token=${NET_RH}`, { body: tok(4663, NET_RH, "NET", 18, "205.5", "unverified") }],
      ["https://api.xstocks.fi/api/v2/public/assets/NVDAx", { body: xstock("NVDAx", NVDAX) }],
    ]);
    const chain = chainOf({ accepted: { [TSLAON.toLowerCase()]: 1n }, paused: { [TSLAON.toLowerCase()]: 0n } });
    const t = trader(http, chain);
    const ondo = ok(await t.market("TSLAon/USDC@Ethereum"));
    expect([ondo.price, ondo.open, ondo.note]).toEqual([381.2, true, expect.stringContaining("Ondo: U.S. persons")]);
    expect(chain.asked).toEqual([`uint:Ethereum:${ONDO_MANAGER}:gmTokenAccepted:${TSLAON}`, `uint:Ethereum:${TSLAON}:tokenPauseManager:`, `uint:Ethereum:${PAUSER}:isTokenPaused:${TSLAON}`]);
    expect(ok(await t.market("NVDAx/USDC@Ethereum")).price).toBe(240.1);
    expect(http.asked).toContain("https://api.xstocks.fi/api/v2/public/assets/NVDAx");
    // a Stock Token LI.FI's list leaves out is priced when opened; NET is asked for at Robinhood's address
    expect(ok(await t.market("CRM/USDG@Robinhood Chain")).price).toBe(228.44);
    expect(ok(await t.market("NET/USDG@Robinhood Chain")).price).toBe(205.5);
    expect(http.asked).not.toContain(`https://li.quest/v1/token?chain=4663&token=${NET_OTHER}`);
    // what an issuer said is kept a minute
    await t.market("TSLAon/USDC@Ethereum");
    expect(chain.asked.filter((a) => a.includes("gmTokenAccepted"))).toHaveLength(1);
  });
});

describe("tokenised shares a wallet swaps: orders built for the wallet", () => {
  it("an Ondo Stock: confirmed by Ondo's contracts, quoted by LI.FI, and handed to the wallet as an approval of USDC and the swap on Ethereum", async () => {
    const q = quote({ chainId: 1, diamond: LIFI_DIAMOND, from: USDC_ETH, to: TSLAON, fromAmount: 19_100_000n, toAmount: 50_000_000_000_000_000n, toAmountMin: 49_750_000_000_000_000n, fromPrice: "1.0001", toPrice: "380" });
    const http = net([...BASE_RULES, ["https://li.quest/v1/quote/toAmount?", { body: q }]]);
    const chain = chainOf({ held: { "Ethereum:USDC": 100, Ethereum: 0.01 }, accepted: { [TSLAON.toLowerCase()]: 1n }, paused: { [TSLAON.toLowerCase()]: 0n }, allowance: 0n });
    const s = ok(await trader(http, chain).place({ symbol: "TSLAon/USDC@Ethereum", side: "buy", type: "market", qty: 0.05, clientId: "ord-0001" }));
    expect(quotes(http)).toEqual([`https://li.quest/v1/quote/toAmount?fromChain=1&toChain=1&fromToken=${USDC_ETH}&toToken=${TSLAON}&toAmount=50000000000000000&fromAddress=${WALLET}&slippage=0.005&integrator=account-demo&order=CHEAPEST`]);
    expect(s.walletTxs).toEqual([
      // the approval covers the order at its worst price: 0.05 TSLAon at $380 with 2% room
      { chainId: 1, chainIdHex: "0x1", from: WALLET, to: USDC_ETH, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [LIFI_DIAMOND, 19_380_000n] }), value: "0x0", what: "approve" },
      { chainId: 1, chainIdHex: "0x1", from: WALLET, to: LIFI_DIAMOND, data: q.transactionRequest.data, value: "0x0", gas: "0x78f2c", what: "swap" },
    ]);
    expect(s.native).toMatchObject({ chain: "Ethereum", issuer: "Ondo Global Markets", sell: { token: "USDC", amount: "19.1" }, buy: { token: "TSLAon", least: "0.04975" } });
    // the issuer first, before a quote is spent on it
    const asked = chain.asked.map((a) => a.split(":").slice(0, 4).join(":"));
    expect(asked.indexOf(`uint:Ethereum:${ONDO_MANAGER}:gmTokenAccepted`)).toBe(0);
  });

  it("a Robinhood Stock Token: against USDG on Robinhood Chain, to LI.FI's contract there; the hash sent is held to the swap, and the chain says it filled", async () => {
    const q = quote({ chainId: 4663, diamond: DIAMOND_RH, from: USDG, to: NVDA_RH, fromAmount: 24_000_000n, toAmount: 100_000_000_000_000_000n, toAmountMin: 99_500_000_000_000_000n, fromPrice: "1.0003", toPrice: "239.8" });
    const http = net([...BASE_RULES, ["https://li.quest/v1/quote/toAmount?", { body: q }], ["https://li.quest/v1/status?", { status: 404, body: { code: 1003, message: "Not found" } }]]);
    const holds: Holds = { held: { "Robinhood Chain:USDG": 50, "Robinhood Chain": 0.01 }, allowance: 0n };
    const chain = chainOf(holds);
    const t = trader(http, chain);
    const s = ok(await t.place({ symbol: "NVDA/USDG@Robinhood Chain", side: "buy", type: "market", qty: 0.1, clientId: "ord-0002" }));
    expect(quotes(http)[0]).toContain(`fromChain=4663&toChain=4663&fromToken=${USDG}&toToken=${NVDA_RH}&toAmount=100000000000000000`);
    expect(DIAMOND_RH).toBe("0xB477751B76CF82d00a686A1232f5fCD772414Af3");
    expect(s.walletTxs).toEqual([
      { chainId: 4663, chainIdHex: "0x1237", from: WALLET, to: USDG, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [DIAMOND_RH, 24_459_600n] }), value: "0x0", what: "approve" },
      { chainId: 4663, chainIdHex: "0x1237", from: WALLET, to: DIAMOND_RH, data: q.transactionRequest.data, value: "0x0", gas: "0x78f2c", what: "swap" },
    ]);
    expect(chain.asked).toContain(`uint:Robinhood Chain:${USDG}:allowance:${WALLET},${DIAMOND_RH}`);
    // the wallet's hash, read back from Robinhood Chain and held to the swap built
    const swap = s.walletTxs!.at(-1)!;
    holds.txs = { [HASH]: { from: WALLET, to: DIAMOND_RH, data: swap.data, value: 0n, chainId: 4663 } };
    expect(ok(await t.sent!("ord-0002", HASH, swap)).native).toMatchObject({ sent: HASH, clientId: "ord-0002" });
    // LI.FI has not seen it yet: the receipt of LI.FI's contract on Robinhood Chain says what the wallet received
    const event = parseAbi(["event LiFiGenericSwapCompleted(bytes32 indexed transactionId, string integrator, string referrer, address receiver, address fromAssetId, address toAssetId, uint256 fromAmount, uint256 toAmount)"]);
    holds.receipts = {
      [HASH]: {
        status: "success",
        from: WALLET,
        to: DIAMOND_RH,
        logs: [{ address: DIAMOND_RH, topics: encodeEventTopics({ abi: event, eventName: "LiFiGenericSwapCompleted", args: { transactionId: TXID } }) as Hex[], data: encodeAbiParameters(parseAbiParameters("string, string, address, address, address, uint256, uint256"), ["account-demo", "", WALLET, USDG, NVDA_RH, 24_000_000n, 100_000_000_000_000_000n]) }],
      },
    };
    const done = ok(await t.status(HASH, "NVDA/USDG@Robinhood Chain"));
    expect([done.status, done.filledQty, done.avgPrice]).toEqual(["filled", 0.1, 240]);
  });

  it("selling an xStock the wallet holds: confirmed against xStocks' own list, the token approved to LI.FI's contract on BNB Chain", async () => {
    const q = quote({ chainId: 56, diamond: LIFI_DIAMOND, from: TSLAX, to: USDC_BNB, fromAmount: 300_000_000_000_000_000n, toAmount: 113_700_000_000_000_000_000n, toAmountMin: 113_100_000_000_000_000_000n, fromPrice: "379.9", toPrice: "1" });
    const http = net([...BASE_RULES, ["https://api.xstocks.fi/api/v2/public/assets/TSLAx", { body: xstock("TSLAx", TSLAX) }], ["https://li.quest/v1/quote?", { body: q }]]);
    const chain = chainOf({ held: { "BNB Chain:TSLAx": 0.3, "BNB Chain": 0.05 }, allowance: 0n });
    const s = ok(await trader(http, chain).place({ symbol: "TSLAx/USDC@BNB Chain", side: "sell", type: "market", qty: 0.3, clientId: "ord-0003" }));
    expect(s.walletTxs!.map((x) => [x.chainId, x.to, x.what])).toEqual([
      [56, TSLAX, "approve"],
      [56, LIFI_DIAMOND, "swap"],
    ]);
    expect(http.asked.indexOf("https://api.xstocks.fi/api/v2/public/assets/TSLAx")).toBeLessThan(http.asked.findIndex((u) => u.startsWith("https://li.quest/v1/quote")));
  });
});

describe("tokenised shares a wallet swaps: refused, with the reason", () => {
  it("a fund token whose contract moves it only between approved wallets: the issuer's rule, and no quote asked", async () => {
    const http = net(BASE_RULES);
    const t = trader(http, chainOf({ held: { "Ethereum:USDC": 1000, Ethereum: 1 } }));
    const r = refusal(await t.place({ symbol: "OUSG/USDC@Ethereum", side: "buy", type: "market", qty: 1, clientId: "ord-0004" }));
    expect([r.code, r.message]).toEqual(["E_VENUE_TRANSFER_RESTRICTED", "OUSG on Ethereum: OUSG moves only between addresses registered in Ondo's OndoIDRegistry: it is subscribed and redeemed at Ondo, after Ondo's own checks, and a swap cannot deliver it to a wallet Ondo has not registered. Nothing was prepared"]);
    expect(refusal(await t.market("OUSG/USDC@Ethereum")).code).toBe("E_VENUE_TRANSFER_RESTRICTED");
    // BUIDL on Ethereum, though LI.FI's list leaves it out: shown untradable, with Securitize's rule
    expect(ok(await t.markets("BUIDL")).map((m) => [m.symbol, m.open, m.types])).toEqual([["BUIDL/USDC@Ethereum", false, []]]);
    expect(refusal(await t.market("BUIDL/USDC@Ethereum")).message).toBe("BUIDL on Ethereum: BUIDL moves only between wallets Securitize has approved for the fund: a swap cannot deliver it to a wallet that is not approved. Nothing was prepared");
    expect(quotes(http)).toEqual([]);
  });

  it("Ondo's contracts: a token its GMTokenManager does not accept is not traded as an Ondo Stock; a paused one shows closed and is not prepared", async () => {
    const http = net(BASE_RULES);
    const chain = chainOf({ held: { "Ethereum:USDC": 1000, Ethereum: 1 }, accepted: { [HIMSON.toLowerCase()]: 0n, [TSLAON.toLowerCase()]: 1n }, paused: { [TSLAON.toLowerCase()]: 1n } });
    const t = trader(http, chain);
    const no = refusal(await t.market("HIMSon/USDC@Ethereum"));
    expect([no.code, no.message]).toEqual(["E_VENUE_REJECTED", `Ondo's own GMTokenManager on Ethereum does not accept ${HIMSON} as an Ondo Stock: HIMSon is not traded from here as one`]);
    const paused = net([...BASE_RULES, [`https://li.quest/v1/token?chain=1&token=${TSLAON}`, { body: tok(1, TSLAON, "TSLAon", 18, "380") }]]);
    const t2 = trader(paused, chain);
    const m = ok(await t2.market("TSLAon/USDC@Ethereum"));
    expect([m.open, m.note!.startsWith("Ondo has paused TSLAon on Ethereum (its token pause manager says so)")]).toEqual([false, true]);
    const r = refusal(await t2.place({ symbol: "TSLAon/USDC@Ethereum", side: "buy", type: "market", qty: 0.05, clientId: "ord-0005" }));
    expect(r.code).toBe("E_VENUE_MARKET_CLOSED");
    expect(quotes(paused)).toEqual([]);
    // a chain that does not answer is not a yes
    const down = trader(net(BASE_RULES), chainOf({}));
    expect(refusal(await down.market("TSLAon/USDC@Ethereum")).code).toBe("E_VENUE_UNREACHABLE");
  });

  it("an xStock its issuer does not list at that address, or not at all, is not traded; one it reports halted says so", async () => {
    const other = net([...BASE_RULES, ["https://api.xstocks.fi/api/v2/public/assets/NVDAx", { body: xstock("NVDAx", made(0x5001)) }]]);
    expect(refusal(await trader(other, chainOf()).market("NVDAx/USDC@Ethereum")).message).toBe(`xStocks' own list does not name ${NVDAX} as its NVDAx on Ethereum: it is not traded from here`);
    const gone = net([...BASE_RULES, ["https://api.xstocks.fi/api/v2/public/assets/NVDAx", { status: 404, body: { message: "Not found" } }]]);
    expect(refusal(await trader(gone, chainOf()).market("NVDAx/USDC@Ethereum")).code).toBe("E_VENUE_REJECTED");
    const halted = net([...BASE_RULES, ["https://api.xstocks.fi/api/v2/public/assets/NVDAx", { body: xstock("NVDAx", NVDAX, true) }], [`https://li.quest/v1/token?chain=1&token=${NVDAX}`, { body: tok(1, NVDAX, "NVDAx", 18, "239") }]]);
    expect(ok(await trader(halted, chainOf()).market("NVDAx/USDC@Ethereum")).note).toMatch(/^xStocks reports trading in NVDAx halted/);
  });

  it("a chain this wallet does not swap the token on: Solana, a chain its issuer does not issue on, a Stock Token Robinhood does not list", async () => {
    const t = trader(net(BASE_RULES), chainOf());
    expect(refusal(await t.market("TSLAx/USDC@Solana")).message).toBe("TSLAx on Solana is not swapped from here: this wallet is an EVM address, and swaps here are on Ethereum, Optimism, BNB Chain, Polygon, Base, Arbitrum, Robinhood Chain");
    expect(refusal(await t.market("NVDAon/USDC@Base")).message).toBe("NVDAon, issued by Ondo Global Markets, is swapped here on Ethereum and BNB Chain, not on Base: NVDAon/USDC@Ethereum, NVDAon/USDC@BNB Chain");
    expect(refusal(await t.market("AAPL/USDG@Robinhood Chain")).message).toBe("Robinhood's own list names no Stock Token AAPL on Robinhood Chain: only Robinhood's Stock Tokens are swapped there from here");
    expect(refusal(await t.market("NVDA/USDC@Robinhood Chain")).message).toBe("swaps here are against the chain's USDG: NVDA/USDG@Robinhood Chain");
    // Robinhood's list did not answer: its tokens cannot be told from others under the same symbols, and that is the reason given
    const blind = trader(net([["https://li.quest/v1/tokens?", { body: TOKENS }]]), chainOf());
    const r = refusal(await blind.market("NVDA/USDG@Robinhood Chain"));
    expect([r.code, r.message]).toEqual(["E_VENUE_UNREACHABLE", expect.stringMatching(/^Robinhood's Stock Token list did not answer.*: its tokens on Robinhood Chain cannot be told from others under the same symbols just now$/)]);
    expect(ok(await blind.markets("NET")).map((m) => m.symbol)).toEqual([]);
  });
});

describe("tokenised shares in a wallet", () => {
  it("held as RWAs: USDG counted as dollars, a Stock Token at Robinhood's bid, an Ondo Stock and an xStock at LI.FI's price — each sellable by the market its row finds", async () => {
    const http = net([
      ...BASE_RULES,
      ["https://api.robinhood.com/rhj/prices/NVDA", { body: { quotes: [{ tokenSymbol: "NVDA", tokenBid: "239.5", tokenAsk: "239.6", currency: "USD" }] } }],
      [`https://li.quest/v1/token?chain=1&token=${NVDAON_ETH}`, { body: tok(1, NVDAON_ETH, "NVDAon", 18, "240") }],
      [`https://li.quest/v1/token?chain=56&token=${TSLAX}`, { body: tok(56, TSLAX, "TSLAx", 18, "380") }],
    ]);
    const chain = chainOf({ held: { "Robinhood Chain:USDG": 50, "Robinhood Chain:NVDA": 0.1, "Ethereum:NVDAon": 0.2, "BNB Chain:TSLAx": 0.3 } });
    const opened = await walletSource({ venue: "wallet-1", label: "OKX Wallet", address: WALLET, proven: "OKX Wallet", http, chain });
    if (isRefusal(opened)) throw new Error(opened.message);
    expect(opened.first).toEqual([
      { asset: "USDG", amount: 50, usd: 50, where: "Robinhood Chain", class: "stable" },
      { asset: "NVDA", amount: 0.1, usd: 0.1 * 239.5, where: "Robinhood Chain · Stock Token", class: "rwa" },
      { asset: "NVDAon", amount: 0.2, usd: 0.2 * 240, where: "Ethereum · Ondo Stock", class: "rwa" },
      { asset: "TSLAx", amount: 0.3, usd: 0.3 * 380, where: "BNB Chain · xStock", class: "rwa" },
    ]);
    expect(opened.source.probe.note).toContain("and Robinhood's Stock Tokens and the best-known Ondo Stocks and xStocks");
    // the market a holding's row finds: its symbol, on the chain it is held on (service.ts dollarMarket)
    const sells = async (asset: string, chainName: string) => ok(await opened.source.trader!.markets(asset)).filter((m) => (m.base || "").toUpperCase() === asset.toUpperCase() && m.symbol.endsWith(`@${chainName}`)).map((m) => m.symbol);
    expect(await sells("NVDA", "Robinhood Chain")).toEqual(["NVDA/USDG@Robinhood Chain"]);
    expect(await sells("NVDAon", "Ethereum")).toEqual(["NVDAon/USDC@Ethereum"]);
    expect(await sells("TSLAx", "BNB Chain")).toEqual(["TSLAx/USDC@BNB Chain"]);
  });

  it("nothing held: LI.FI is not asked for a price", async () => {
    const http = net(BASE_RULES);
    const opened = await walletSource({ venue: "wallet-1", label: "", address: WALLET, http, chain: chainOf() });
    if (isRefusal(opened)) throw new Error(opened.message);
    expect(opened.first).toEqual([]);
    expect(http.asked.filter((u) => u.startsWith("https://li.quest/"))).toEqual([]);
  });
});

describe("tokenised shares on the Markets screen", () => {
  it("a wallet's tokenised shares are RWA rows, tradable at the wallet with the issuer's words; a fund token is shown untradable with its rule", async () => {
    const wallet = trader(net(BASE_RULES), chainOf());
    const stockTokens: PublicSource = {
      id: "robinhood-stock-tokens",
      name: "Robinhood Stock Tokens",
      kind: "tokens",
      connectTo: "robinhood-wallet",
      connector: "live:wallet",
      readOnly: "Robinhood's own prices",
      listings: async () => [{ symbol: "AAPL", name: "Apple • Robinhood Token", kind: "token", base: "AAPL", quote: "USD", price: 230.4, open: true, types: [] } satisfies Market],
    };
    const x = await exploreAcross({ connected: [{ id: "wallet-1", name: "OKX Wallet", trader: wallet, connector: "live:wallet" }], public: [stockTokens] }, { tab: "rwas", clock: () => T });
    const row = (key: string) => x.items.find((i) => i.key === key);
    expect(row("rwa:TSLAON")).toMatchObject({ kind: "rwa", name: "Tesla · Ondo Stock on Ethereum", tabs: ["all", "rwas"], category: "RWA" });
    expect(row("rwa:TSLAON")!.at).toEqual([{ venue: "wallet-1", venueName: "OKX Wallet", symbol: "TSLAon/USDC@Ethereum", connected: true, canTrade: true, public: false, price: 380, open: true, note: expect.stringContaining("Ondo: U.S. persons"), issuer: "Ondo Global Markets", eligibility: expect.stringContaining("Ondo: U.S. persons") }]);
    // the row carries the issuer and its words too, from the venue that says them
    expect(row("rwa:TSLAON")).toMatchObject({ issuer: "Ondo Global Markets", eligibility: expect.stringContaining("Ondo: U.S. persons") });
    expect(row("rwa:NVDAX")!.at[0]).toMatchObject({ venue: "wallet-1", canTrade: true });
    // the public Stock Token list stays beside them, to connect
    expect(row("rwa:AAPL")!.at[0]).toMatchObject({ venue: "robinhood-stock-tokens", connected: false, canTrade: false });
    // the RWAs tab holds them, and (All apart, which holds every row) they are in no other tab
    expect(x.items.every((i) => i.kind === "rwa" && i.tabs.join() === "all,rwas")).toBe(true);
    const fund = await exploreAcross({ connected: [{ id: "wallet-1", name: "OKX Wallet", trader: wallet, connector: "live:wallet" }] }, { q: "OUSG", clock: () => T });
    expect(fund.items.find((i) => i.key === "rwa:OUSG")!.at[0]).toMatchObject({ connected: true, canTrade: false, open: false, note: expect.stringContaining("OndoIDRegistry") });
  });

  it("a Robinhood Stock Token at a connected wallet is a row to trade: USDG, the dollar it trades against on Robinhood Chain, is a dollar", async () => {
    // the order door and the Markets screen keep only markets priced in dollars: USDG is one, so "Connect to trade" on a Stock Token leads somewhere
    expect([inDollars("USDG"), inDollars("usdg")]).toEqual([true, true]);
    const wallet = trader(net(BASE_RULES), chainOf());
    const x = await exploreAcross({ connected: [{ id: "wallet-1", name: "OKX Wallet", trader: wallet, connector: "live:wallet" }] }, { q: "NVDA", clock: () => T });
    const at = x.items.flatMap((i) => i.at).find((a) => a.symbol === "NVDA/USDG@Robinhood Chain");
    expect(at).toMatchObject({ venue: "wallet-1", connected: true, canTrade: true });
  });
});
