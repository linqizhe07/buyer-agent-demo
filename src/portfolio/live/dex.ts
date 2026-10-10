/** TRADING from the user's own wallet: token swaps on seven EVM chains, routed by LI.FI and sent by the WALLET — tokenised shares among
 * them: Robinhood's Stock Tokens, Ondo Stocks and xStocks.
 *
 * LI.FI (li.quest/v1) is a keyless aggregator: it finds a route across a chain's DEXes and answers one transaction for the wallet to send.
 * This process never signs and never sends a transaction. It asks LI.FI, checks what LI.FI answered, and hands the wallet, in order:
 *
 *   an approval        `approve(LI.FI's contract, exactly the amount sold)` on the token sold, when the wallet has not allowed enough
 *   the swap           the transaction LI.FI built, checked before anyone sees it: it goes to LI.FI's own contract, it pays THIS wallet, it
 *                      spends exactly what LI.FI quoted, and the least it pays is the least LI.FI quoted
 *
 *   markets            GET /v1/tokens (kept five minutes): a few well-known tokens first, then any token LI.FI verifies, found by symbol;
 *                      and the tokens an issuer stands behind (below), found by address
 *   a market           GET /v1/token: LI.FI's price in dollars, now
 *   a sell             GET /v1/quote with fromAmount: exactly this much of the token, for the chain's dollar
 *   a buy              GET /v1/quote/toAmount: this much of the token, for the dollars LI.FI works out
 *   the swap again     once the approval is on chain: a fresh quote, held to the same order (its size, side and worst price), the swap alone
 *   the hash sent      read back from the chain and held to the swap that was built (sender, contract, call, coin, chain) before it is followed
 *   what became of it  GET /v1/status by the hash the wallet sent; the chain's own receipt while LI.FI has not seen it
 *
 * A market order's worst price is kept on chain: the least a route pays (`toAmountMin`, enforced by LI.FI's contract) is held to it, and to
 * 2% from LI.FI's price, whichever is tighter. A DEX has no price grid, so nothing is rounded.
 *
 * Every market is a token against the chain's dollar: USDC on six chains (`WETH/USDC@Base`), and USDG on Robinhood Chain, where LI.FI lists
 * no USDC and Robinhood pairs its Stock Tokens with Paxos's USDG (`NVDA/USDG@Robinhood Chain`). A swap is one transaction: it goes through
 * whole or reverts. There is no book, no limit order, and nothing to call back once the wallet has sent it.
 *
 * TOKENS AN ISSUER STANDS BEHIND (category RWA, with the issuer's name and its own eligibility words). A symbol proves nothing — LI.FI's
 * list holds a "NET" and a "BULL" on Robinhood Chain that are not Robinhood's — so each is recognised by what its issuer publishes, and
 * confirmed with the issuer again before an order is built (kept a minute):
 *
 *   Robinhood Stock Tokens  on Robinhood Chain: an address on Robinhood's own list (api.robinhood.com/rhj/assets, robinhood.ts), whether or
 *                           not LI.FI's list carries it (LI.FI routes them by address; Robinhood names it among their aggregators)
 *   Ondo Stocks             on Ethereum and BNB Chain: the best known from Ondo's own list of its tokens, and any LI.FI verifies under
 *                           Ondo's `<TICKER>on` symbols; confirmed by Ondo's GMTokenManager (`gmTokenAccepted`) and the token's pause
 *                           manager (`isTokenPaused`), both read from the chain
 *   xStocks                 on Ethereum, BNB Chain, Arbitrum and Optimism: the best known from xStocks' own list, and any LI.FI verifies
 *                           as an "xStock"; confirmed by xStocks' keyless GET api.xstocks.fi/api/v2/public/assets/{symbol}
 *   OUSG, BUIDL             shown, never swapped: their contracts move them only between wallets the issuer has approved, so a swap
 *                           cannot deliver them, and the account refuses with the issuer's rule (E_VENUE_TRANSFER_RESTRICTED)
 *
 * Ondo and xStocks also issue on Solana: a wallet here is an EVM address, so those are not offered. Every issuer above excludes US persons
 * (and other places); the account does not know where its owner lives, so the issuer's words go with each market, the owner reads them
 * before signing, and a refusal by an issuer's contract (a sanctions list, a blocklist, a pause) is reported as the issuer's own rule.
 *
 * LI.FI's terms (2025-09-04) exclude sanctioned parties and places, and US persons: the market note says so, and a refusal by LI.FI on
 * those grounds is reported as LI.FI's own rule.
 */
import { decodeEventLog, decodeFunctionData, encodeFunctionData, erc20Abi, formatUnits, getAddress, parseAbi, parseUnits, toEventSelector, type Hex } from "viem";
import { isRefusal, type Refusal } from "../../core/errors.ts";
import { no } from "../refuse.ts";
import { RWA_CATEGORY } from "./categories.ts";
import { CHAIN_BY_ID, CHAINS, STABLECOINS, type ChainName, type ChainReader, type Mined, type SentTx, type TokenRef } from "./chain.ts";
import { holdBackMs } from "./public-markets.ts";
import { STOCK_TOKEN_ISSUER, STOCK_TOKEN_TERMS, stockTokens, type StockToken } from "./robinhood.ts";
import { DONE, badOrder, floorTo, inDollars, pick, plain, type LiveTrader, type Market, type OrderRequest, type OrderState } from "./trade.ts";
import { edgeRefused, edgeWords, REGION, isStable, notTheApi, notTheApiWords, num, redact, unreachable, venueSaidNo, type Http, type HttpReply, type LiveBalance } from "./types.ts";

const LIFI = "https://li.quest/v1";
const NAME = "LI.FI";
/** sent with every quote, so LI.FI's `/v1/analytics/transfers?integrator=` finds the account's swaps; it is also written into the swap's calldata */
const INTEGRATOR = "account-demo";
/** the most the price may move between the quote and the block, as LI.FI enforces it on chain (`toAmountMin`) */
const SLIPPAGE = 0.005;
/** the room the account counts a market buy at (account/live-orders.ts): a route that costs more than that, or pays less, is not handed on */
const ROOM = 0.02;
const LIST_MS = 5 * 60_000;
/** a retry with the same order id inside this long is the same order: the same transactions, not a second quote */
const QUOTE_MS = 60_000;
/** what an issuer said of a token (its own list, its own contract) is good this long */
const CONFIRM_MS = 60_000;
/** a transaction the wallet has just sent may not yet have reached the endpoint this process reads the chain through: it is looked for this
 * many times, this far apart, before the account says it cannot see it */
const SEEN_TRIES = 5;
const SEEN_MS = 2_000;
const NATIVE: Hex = "0x0000000000000000000000000000000000000000";
/** LI.FI's contract on the six USDC chains (GET /v1/chains `diamondAddress`, read 2026-10-05): the swap goes to it and the approval names it.
 * It is pinned rather than taken from LI.FI's answer, because an approval is the one thing a forged answer could abuse; if LI.FI ever moves
 * it, swaps are refused here, never sent elsewhere. */
export const LIFI_DIAMOND: Hex = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";
/** LI.FI's contract on Robinhood Chain is another address (GET /v1/chains `diamondAddress` for 4663, read 2026-10-06), pinned the same way */
const LIFI_DIAMOND_ROBINHOOD: Hex = "0xB477751B76CF82d00a686A1232f5fCD772414Af3";
/** the contract a swap on a chain goes to, and an approval names */
export const diamondOn = (c: ChainName): Hex => (c === "Robinhood Chain" ? LIFI_DIAMOND_ROBINHOOD : LIFI_DIAMOND);
/** the chains swapped on: every chain in chain.ts, each against its dollar (LI.FI serves all seven) */
export const DEX_CHAINS: ChainName[] = ["Ethereum", "Optimism", "BNB Chain", "Polygon", "Base", "Arbitrum", "Robinhood Chain"];
/** USDG on Robinhood Chain, from Paxos's own list of USDG contracts (docs.paxos.com/guides/stablecoin/usdg/mainnet, read 2026-10-06) */
export const USDG_ROBINHOOD: TokenRef = { chain: "Robinhood Chain", asset: "USDG", address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" };

/** LI.FI's same-chain swaps (GenericSwapFacetV3, github.com/lifinance/contracts): the only calls handed to a wallet from here. The contract on
 * Robinhood Chain answers the same calls (a quote read there on 2026-10-06 decodes as swapTokensMultipleV3ERC20ToERC20) */
const SWAP_DATA = "(address callTo,address approveTo,address sendingAssetId,address receivingAssetId,uint256 fromAmount,bytes callData,bool requiresDeposit)";
export const LIFI_SWAP_ABI = parseAbi(
  ["Single", "Multiple"].flatMap((m) => ["ERC20ToERC20", "ERC20ToNative", "NativeToERC20"].map((k) => `function swapTokens${m}V3${k}(bytes32 _transactionId,string _integrator,string _referrer,address _receiver,uint256 _minAmountOut,${SWAP_DATA}${m === "Multiple" ? "[]" : ""} _swapData)`)) as string[],
);
const SWAP_DONE = parseAbi(["event LiFiGenericSwapCompleted(bytes32 indexed transactionId, string integrator, string referrer, address receiver, address fromAssetId, address toAssetId, uint256 fromAmount, uint256 toAmount)"]);
const SWAP_DONE_TOPIC = toEventSelector(SWAP_DONE[0]);
const ALLOWANCE = "function allowance(address owner, address spender) view returns (uint256)";

/** where to start: the chain's own coin and the best-known tokens, the most used first */
const WELL_KNOWN: Array<[ChainName, string]> = [
  ["Base", "ETH"], ["Ethereum", "ETH"], ["Arbitrum", "ETH"], ["Base", "cbBTC"], ["Ethereum", "WBTC"], ["Optimism", "ETH"], ["BNB Chain", "BNB"], ["Polygon", "POL"],
  ["Base", "WETH"], ["Base", "AERO"], ["Ethereum", "WETH"], ["Ethereum", "LINK"], ["Ethereum", "UNI"], ["Ethereum", "AAVE"], ["Arbitrum", "WBTC"], ["Arbitrum", "ARB"],
  ["Optimism", "OP"], ["Polygon", "WBTC"], ["BNB Chain", "BTCB"], ["BNB Chain", "CAKE"],
];
/** how many of the well-known coins come before the tokenised shares in the markets to start from */
const COINS_FIRST = 12;
/** the tokenised shares to start from, after those coins (those LI.FI prices) */
const RWA_START: Array<[ChainName, string]> = [
  ["Robinhood Chain", "NVDA"], ["Robinhood Chain", "TSLA"], ["Robinhood Chain", "AAPL"], ["Robinhood Chain", "SPY"],
  ["Ethereum", "TSLAon"], ["Ethereum", "NVDAx"], ["Ethereum", "TSLAx"], ["BNB Chain", "NVDAon"],
];

const NOTE = "swapped through LI.FI (its fee 0.25%) at up to 0.5% slippage, sent by your wallet, which pays the network fee; LI.FI's terms exclude US persons and sanctioned places";

// ---- the issuers ---------------------------------------------------------------------------------------------------------------------

type IssuerId = "robinhood" | "ondo" | "xstocks" | "ousg" | "buidl";

interface Issuer {
  /** what one of its tokens is called, in a market's name and a holding's line */
  kind: string;
  /** who issues it */
  issuer: string;
  /** the chains this wallet can swap it on */
  chains: ChainName[];
  /** whom it is not for, in the issuer's own words; for a restricted token, the rule that keeps it from being swapped */
  terms: string;
  /** its contract moves it only between wallets the issuer approved: no swap can deliver it, so none is built */
  restricted?: true | undefined;
}

/** Each issuer's own words, read 2026-10-06: docs.robinhood.com/chain/stock-tokens; docs.ondo.finance/ondo-stocks/eligibility and
 * /secondary-market-restrictions, and the token contract's own compliance check (its errors are UserSanctioned and UserBlocked);
 * docs.xstocks.fi; docs.ondo.finance/addresses (OUSG's OndoIDRegistry). BUIDL's whitelist is enforced by its contract, as Securitize
 * describes the fund */
const ISSUERS: Record<IssuerId, Issuer> = {
  robinhood: { kind: "Robinhood Stock Token", issuer: STOCK_TOKEN_ISSUER, chains: ["Robinhood Chain"], terms: STOCK_TOKEN_TERMS },
  ondo: {
    kind: "Ondo Stock",
    issuer: "Ondo Global Markets",
    chains: ["Ethereum", "BNB Chain"],
    terms: "Ondo: U.S. persons, and anyone in a jurisdiction Ondo prohibits (the United States and Canada among them), are “prohibited from subscribing for, acquiring or redeeming Ondo Stocks”; buying one on a secondary market represents that you are not one of them, redeeming it at Ondo needs Ondo's own KYC, and the token checks Ondo's sanctions list and blocklist on every transfer",
  },
  xstocks: { kind: "xStock", issuer: "Backed (xStocks)", chains: ["Ethereum", "BNB Chain", "Arbitrum", "Optimism"], terms: "xStocks: “not intended for distribution in the United States, to any US person, or in any other prohibited jurisdiction”" },
  ousg: {
    kind: "Ondo fund token",
    issuer: "Ondo Finance",
    chains: ["Ethereum", "Polygon"],
    terms: "OUSG moves only between addresses registered in Ondo's OndoIDRegistry: it is subscribed and redeemed at Ondo, after Ondo's own checks, and a swap cannot deliver it to a wallet Ondo has not registered",
    restricted: true,
  },
  buidl: {
    kind: "BlackRock fund token",
    issuer: "BlackRock, through Securitize",
    chains: ["Ethereum", "Polygon"],
    terms: "BUIDL moves only between wallets Securitize has approved for the fund: a swap cannot deliver it to a wallet that is not approved",
    restricted: true,
  },
};

/** Ondo's GMTokenManager on each chain (docs.ondo.finance/addresses, read 2026-10-06): `gmTokenAccepted(token)` says whether a token is an
 * Ondo Stock it mints and redeems */
const ONDO_MANAGER: Partial<Record<ChainName, Hex>> = { Ethereum: "0x2c158BC456e027b2AfFCCadF1BDBD9f5fC4c5C8c", "BNB Chain": "0x91f8Aff3738825e8eB16FC6f6b1A7A4647bDB299" };
const XSTOCKS = "https://api.xstocks.fi/api/v2";
/** what xStocks' own list calls each chain */
const XSTOCKS_NETWORK: Partial<Record<ChainName, string>> = { Ethereum: "Ethereum", "BNB Chain": "BinanceSmartChain", Arbitrum: "Arbitrum", Optimism: "Optimism" };
/** Ondo's ticker symbols: the share's ticker and "on" (NVDAon); its dollar token USDon is not a share */
const ONDO_SYMBOL = /^[A-Z][A-Z0-9.]*on$/;
/** Ondo's portfolio tokens carry the same suffix but are not Ondo Stocks: its GMTokenManager does not take them */
const ONDO_NOT_A_STOCK = /\bportfolio\b|powered by blackrock/i;

interface Known {
  issuer: "ondo" | "xstocks";
  chain: ChainName;
  symbol: string;
  /** the share it tracks, in words */
  underlying: string;
  address: Hex;
}

/** The best-known tokenised shares, from each issuer's own list, read 2026-10-06: Ondo's spreadsheet of its tokens (linked from
 * docs.ondo.finance/addresses; each one below answered `gmTokenAccepted` true on Ondo's GMTokenManager that day) and xStocks' GET
 * /public/assets/{symbol} (an xStock has one address on every chain). They are listed even where LI.FI's token list leaves them out (it
 * lists no NVDAon on Ethereum, and routes it), read in every wallet (issuedHoldings), and confirmed with the issuer again before an order */
const KNOWN: Known[] = [
  ...(
    [
      ["NVDAon", "NVIDIA", "0x2D1F7226Bd1F780AF6B9A49DCC0aE00E8Df4bDEE", "0xa9ee28c80f960b889dfbd1902055218cba016f75"],
      ["TSLAon", "Tesla", "0xf6b1117ec07684D3958caD8BEb1b302bfD21103f", "0x2494b603319d4d9f9715c9f4496d9e0364b59d93"],
      ["AAPLon", "Apple", "0x14c3abF95Cb9C93a8b82C1CdCB76D72Cb87b2d4c", "0x390a684ef9cade28a7ad0dfa61ab1eb3842618c4"],
      ["MSFTon", "Microsoft", "0xB812837b81a3a6b81d7CD74CfB19A7f2784555E5", "0x6bfe75d1ad432050ea973c3a3dcd88f02e2444c3"],
      ["AMZNon", "Amazon", "0xbb8774FB97436d23d74C1b882E8E9A69322cFD31", "0x4553cfe1c09f37f38b12dc509f676964e392f8fc"],
      ["GOOGLon", "Alphabet Class A", "0xbA47214eDd2bb43099611b208f75E4b42FDcfEDc", "0x091fc7778e6932d4009b087b191d1ee3bac5729a"],
      ["METAon", "Meta Platforms", "0x59644165402b611b350645555B50Afb581C71EB2", "0xd7df5863a3e742f0c767768cdfcb63f09e0422f6"],
      ["SPYon", "SPDR S&P 500 ETF", "0xFeDC5f4a6c38211c1338aa411018DFAf26612c08", "0x6a708ead771238919d85930b5a0f10454e1c331a"],
      ["QQQon", "Invesco QQQ", "0x0e397938C1Aa0680954093495B70A9F5e2249aBa", "0x0cde6936d305d5b34667fc46425e852efd73559a"],
      ["COINon", "Coinbase", "0xF042cfa86cf1D598a75Bdb55c3507a1F39f9493b", "0xf8589b526fdd65f7f301c605a6e04f0f1b4b3620"],
    ] as const
  ).flatMap(([symbol, underlying, eth, bnb]): Known[] => [
    { issuer: "ondo", chain: "Ethereum", symbol, underlying, address: getAddress(eth) },
    { issuer: "ondo", chain: "BNB Chain", symbol, underlying, address: getAddress(bnb) },
  ]),
  ...(
    [
      ["NVDAx", "NVIDIA", "0xc845b2894dbddd03858fd2d643b4ef725fe0849d"],
      ["TSLAx", "Tesla", "0x8ad3c73f833d3f9a523ab01476625f269aeb7cf0"],
      ["AAPLx", "Apple", "0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a"],
      ["MSFTx", "Microsoft", "0x5621737f42dae558b81269fcb9e9e70c19aa6b35"],
      ["AMZNx", "Amazon.com", "0x3557ba345b01efa20a1bddc61f573bfd87195081"],
      ["GOOGLx", "Alphabet", "0xe92f673ca36c5e2efd2de7628f815f84807e803f"],
      ["METAx", "Meta", "0x96702be57cd9777f835117a809c7124fe4ec989a"],
      ["SPYx", "SP500", "0x90a2a4c76b5d8c0bc892a69ea28aa775a8f2dd48"],
      ["QQQx", "Nasdaq", "0xa753a7395cae905cd615da0b82a53e0560f250af"],
      ["COINx", "Coinbase", "0x364f210f430ec2448fc68a49203040f6124096f0"],
    ] as const
  ).flatMap(([symbol, underlying, address]): Known[] => (["Ethereum", "BNB Chain"] as const).map((chain) => ({ issuer: "xstocks", chain, symbol, underlying, address: getAddress(address) }))),
];

/** The fund tokens shown with their issuer's rule and never swapped, wherever LI.FI's list has them or not: OUSG on Ethereum and Polygon
 * (docs.ondo.finance/addresses), BUIDL on Polygon (LI.FI verifies it) and on Ethereum; each contract's own name, symbol and decimals were
 * read on 2026-10-06 */
const RESTRICTED: Array<{ issuer: "ousg" | "buidl"; chain: ChainName; symbol: string; name: string; decimals: number; address: Hex }> = [
  { issuer: "ousg", chain: "Ethereum", symbol: "OUSG", name: "Ondo Short-Term U.S. Government Bond Fund", decimals: 18, address: "0x1B19C19393e2d034D8Ff31ff34c81252FcBbee92" },
  { issuer: "ousg", chain: "Polygon", symbol: "OUSG", name: "Ondo Short-Term U.S. Government Bond Fund", decimals: 18, address: "0xbA11C5effA33c4D6F8f593CFA394241CfE925811" },
  { issuer: "buidl", chain: "Ethereum", symbol: "BUIDL", name: "BlackRock USD Institutional Digital Liquidity Fund", decimals: 6, address: "0x7712c34205737192402172409a8F7ccef8aA2AEc" },
  { issuer: "buidl", chain: "Polygon", symbol: "BUIDL", name: "BlackRock USD Institutional Digital Liquidity Fund", decimals: 6, address: "0x2893Ef551B6dD69F661Ac00F11D93E5Dc5Dc0e99" },
];

/** a token an issuer stands behind, as a market carries it: the shared shape, its issuer, and whom it is not for in the issuer's words */
export type RwaMarket = Market & { category: string; issuer: string; eligibility: string };

export interface DexRequest {
  venue: string;
  /** the wallet: the swaps are from it and to it */
  address: Hex;
  /** the wallet that proved the address is the user's; a watched address trades nothing */
  proven?: string | undefined;
  http: Http;
  chain: ChainReader;
  now?: (() => number) | undefined;
  /** waits between looks at the chain for a transaction the wallet sent (tests pass one that does not wait) */
  pause?: ((ms: number) => Promise<void>) | undefined;
}

interface Tok {
  chain: ChainName;
  address: Hex;
  symbol: string;
  name: string;
  decimals: number;
  priceUSD: number;
  verified: boolean;
  /** the issuer that stands behind it, when one does */
  issuer?: IssuerId | undefined;
  /** the share it tracks, in words, where the issuer's list says */
  underlying?: string | undefined;
}

interface Listed {
  /** when LI.FI's list was read: it is kept five minutes */
  at: number;
  /** LI.FI's list as it answered, by chain id: the markets are built again from it when Robinhood's list answers after it */
  all: Obj;
  /** by the account's symbol in capitals */
  bySymbol: Map<string, { base: Tok; usdc: Tok }>;
  markets: Market[];
  /** why Robinhood Chain's Stock Tokens are not listed this time, in Robinhood's own answer, and until when that is kept before Robinhood's
   * list is asked again (its own hold: twenty seconds for no answer, ten minutes for a place rule or an edge, a ban's own time) */
  robinhoodUnread?: { until: number; said: Refusal } | undefined;
}

/** an order prepared for the wallet: kept so that a retry is the same order, and so that the hash the wallet sends can be judged */
interface Route {
  key: string;
  at: number;
  /** the account's id for the order, as place() was given it */
  clientId: string;
  state: OrderState;
  base: Tok;
  usdc: Tok;
  transactionId: Hex;
  /** the price per token the swap was held to: the most a buy pays, the least a sell takes; a swap built again is held to it too */
  bound: number;
}

type Obj = Record<string, unknown>;
type WalletTx = NonNullable<OrderState["walletTxs"]>[number];
type Leg = { sendingAssetId: Hex; receivingAssetId: Hex; fromAmount: bigint; requiresDeposit: boolean };
/** what an issuer said of a token: fine, or the market is closed now (a pause), or something to say beside it */
type Confirmed = { closed?: string | undefined; said?: string | undefined };

const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as Obj[]) : []);
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const big = (v: unknown): bigint | undefined => (/^(0x[0-9a-fA-F]+|\d+)$/.test(str(v)) ? BigInt(str(v)) : undefined);
const same = (a: unknown, b: string): boolean => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
const HASH = /^0x[0-9a-fA-F]{64}$/;
const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const chainId = (c: ChainName): number => CHAINS[c].chain.id;
/** the dollar a chain's markets are priced in and paid with: USDC (Circle's, chain.ts), and USDG on Robinhood Chain */
const dollarOn = (c: ChainName): { symbol: string; address: Hex } => (c === "Robinhood Chain" ? { symbol: "USDG", address: USDG_ROBINHOOD.address } : { symbol: "USDC", address: STABLECOINS.find((t) => t.chain === c && t.asset === "USDC")!.address });
const DOLLARS = new Set(DEX_CHAINS.map((c) => dollarOn(c).symbol));
/** a size in at most eight places, or the token's own decimals when it has fewer, so the size the owner signs is the size sent */
const stepOf = (decimals: number): number => 10 ** -Math.min(decimals, 8);
/** an address a contract answered as a uint256 word */
const addressOf = (word: bigint): Hex => getAddress(`0x${word.toString(16).padStart(40, "0").slice(-40)}`);
/** the share a token tracks, without its issuer's words around it ("Tesla (Ondo Tokenized)", "NVIDIA • Robinhood Token", "Tesla xStock") */
const underlyingOf = (t: Tok): string => t.underlying ?? (t.name.replace(/\s*\(Ondo Tokenized[^)]*\)\s*$/i, "").replace(/\s*•\s*Robinhood Token\s*$/i, "").replace(/\s+xStock\s*$/i, "").trim() || t.symbol);

/** the issuer LI.FI's listing of a token shows it to be from, where it names one; Robinhood Chain's tokens are Robinhood's only by its list */
function issuerOf(c: ChainName, t: Tok, robinhood: ReadonlySet<string> | undefined): IssuerId | undefined {
  if (c === "Robinhood Chain") return robinhood?.has(t.address.toLowerCase()) ? "robinhood" : undefined;
  if (!t.verified) return undefined;
  if (ISSUERS.ondo.chains.includes(c) && ONDO_SYMBOL.test(t.symbol) && t.symbol !== "USDon" && !ONDO_NOT_A_STOCK.test(t.name)) return "ondo";
  if (ISSUERS.xstocks.chains.includes(c) && /\bxStock$/i.test(t.name.trim()) && /x$/.test(t.symbol)) return "xstocks";
  if (ISSUERS.ousg.chains.includes(c) && t.symbol === "OUSG" && /\bondo\b/i.test(t.name)) return "ousg";
  if (ISSUERS.buidl.chains.includes(c) && t.symbol === "BUIDL" && /\bblackrock\b/i.test(t.name)) return "buidl";
  return undefined;
}

/** `WETH/USDC@Base`, `NVDA/USDG@Robinhood Chain` → its parts; the chain is one swapped on, and the quote is that chain's dollar */
function parseSymbol(venue: string, symbol: string): { base: string; quote: string; chain: ChainName } | Refusal {
  const m = /^(.+)\/(.+)@(.+)$/.exec(symbol.trim());
  const chain = m ? DEX_CHAINS.find((c) => c.toLowerCase() === m[3]!.trim().toLowerCase()) : undefined;
  if (!m || !chain) {
    const solana = m && /^solana$/i.test(m[3]!.trim());
    return no("E_ACCOUNT_BAD_ACTION", { venue, message: solana ? `${m[1]!.trim()} on Solana is not swapped from here: this wallet is an EVM address, and swaps here are on ${DEX_CHAINS.join(", ")}` : `a market here is a token against the chain's dollar: <TOKEN>/USDC@<chain> on ${DEX_CHAINS.filter((c) => c !== "Robinhood Chain").join(", ")}, or <TOKEN>/USDG@Robinhood Chain (for example WETH/USDC@Base, NVDA/USDG@Robinhood Chain)` });
  }
  const quote = m[2]!.trim();
  const dollar = dollarOn(chain).symbol;
  if (!inDollars(quote) && !DOLLARS.has(quote.toUpperCase())) return no("E_ACCOUNT_UNPRICED", { venue, message: `${symbol} is priced in ${quote}: the account trades markets priced in dollars, so that every limit means dollars` });
  if (quote.toUpperCase() !== dollar) return no("E_ACCOUNT_BAD_ACTION", { venue, message: `swaps here are against the chain's ${dollar}: ${m[1]!.trim()}/${dollar}@${chain}` });
  return { base: m[1]!.trim(), quote: dollar, chain };
}

/** a refusal made again through no(), with what is added inside its native or its detail — never spread over it after, which would undo the
 * address scrub no() does */
const remade = (r: Refusal, extra: { native?: Record<string, unknown>; detail?: Record<string, unknown> }): Refusal =>
  no(r.code, { ...(r.venue !== undefined ? { venue: r.venue } : {}), ...(r.tool !== undefined ? { tool: r.tool } : {}), message: r.message, native: { ...(r.native && typeof r.native === "object" ? (r.native as Record<string, unknown>) : {}), ...extra.native }, ...(r.detail || extra.detail ? { detail: { ...r.detail, ...extra.detail } } : {}) });
/** a refusal given by another party than the venue it was met at (LI.FI, for a wallet's swaps and bridges): `native.party` names it, so the
 * account holds that party back and not the wallet (service.ts) */
export const byParty = (r: Refusal, party: string): Refusal => remade(r, { native: { party } });
/** an issuer's refusal about one token (xStocks' record of it, Robinhood's Stock Token list, Ondo's contract): `detail.scope`, so nothing
 * else of the wallet is held back for it (public-markets.ts holdBackMs). This file keeps it for that token for the hold its own refusal
 * says (`issuerHoldMs`) */
const forProduct = (r: Refusal): Refusal => remade(r, { detail: { scope: "product" } });
/** how long an issuer's refusal holds that token back: holdBackMs read without the product scope that keeps it from holding anything else */
const issuerHoldMs = (r: Refusal, now: number): number => holdBackMs({ ...r, detail: { ...r.detail, scope: undefined } }, now);

/** LI.FI's answer when it is not a yes, as one of the account's refusals, with LI.FI's own words (cleaned of any address before they are
 * cut). LI.FI ANSWERING is read first — a request it did not take, no route — and only then words about a place, in LI.FI's own top-level
 * message: a DEX or a bridge LI.FI asked from its own servers may say "unavailable from a restricted jurisdiction", and that is the tool's
 * word about LI.FI's servers, quoted with the tool's name, never LI.FI's rule for this network */
export function lifiNo(venue: string, r: HttpReply): Refusal {
  const b = obj(r.body);
  const said = redact(r.text, []).replace(/\s+/g, " ").trim().slice(0, 220);
  const native = { status: r.status, said, party: "lifi" };
  // LI.FI's own words: its top-level message when it answered JSON, the page when it did not — never what a tool it asked said, nested in
  // its answer
  const own = r.body !== undefined && typeof r.body === "object" ? str(b.message) : r.text;
  if (r.status === 451 || REGION.test(own)) return byParty(venueSaidNo(venue, NAME, r.status, r.text, [], r), "lifi");
  if (r.status === 400) return no("E_VENUE_ORDER_INVALID", { venue, message: `${NAME}: ${str(b.message) || "it did not take the request as written"}`, native });
  if (r.status === 404 && num(b.code) === 1002) {
    // no route: `errors` is { filteredOut: [{ reason }], failed: [{ subpaths: { path: [{ tool, code, message }] } }] }, or a flat list of the same
    const errors = b.errors;
    const tools = Array.isArray(errors) ? arr(errors) : arr(obj(errors).failed).flatMap((f) => Object.values(obj(f.subpaths)).flatMap(arr));
    const reasons = [...arr(obj(errors).filteredOut).map((f) => str(f.reason)), ...tools.map((t) => `${str(t.tool)}: ${str(t.code)}${t.message ? ` (${str(t.message)})` : ""}`)].filter(Boolean);
    const codes = tools.map((t) => str(t.code));
    if (codes.length && codes.every((c) => c === "RPC_ERROR" || c === "TOOL_TIMEOUT" || c === "RATE_LIMIT_EXCEEDED")) return no("E_VENUE_UNREACHABLE", { venue, message: `${NAME} could not reach the DEXes on that chain just now: try again in a minute`, native: { ...native, codes } });
    return no("E_VENUE_ORDER_INVALID", { venue, message: `${NAME}: no route for this swap${reasons.length ? `: ${[...new Set(reasons)].slice(0, 3).join("; ")}` : ""}`, native: { ...native, codes } });
  }
  // a 403 is LI.FI's (or its edge's) no to this request: its own words when it gives some; a page with none refuses this network. It answers
  // from a US network (checked 2026-10-08: /v1/chains and /v1/quote both 200), so nothing here says whom its terms exclude
  if (edgeRefused(r.status, r.text)) return no("E_VENUE_GEOBLOCKED", { venue, message: edgeWords(NAME, r.status, r.text), native: { status: r.status, edge: true, party: "lifi" } });
  if (r.status === 403) return no("E_VENUE_PERMISSION", { venue, message: `${NAME} refused this request (HTTP 403)${str(b.message) ? `: “${str(b.message)}”` : ""}. That is its own answer, and the account does not look for a way around it`, native });
  if (r.status === 429) return no("E_VENUE_UNREACHABLE", { venue, message: `${NAME} is rate-limiting this machine: without a key it answers 75 quotes in two hours. Try again later`, native: { ...native, ...(r.retryAfterMs ? { until: Date.now() + r.retryAfterMs } : {}) } });
  return byParty(venueSaidNo(venue, NAME, r.status, own || said, [], r), "lifi");
}

/** LI.FI holding this machine back — a place rule or an edge page (ten minutes), a ban or a wait it named (its own time), a rate limit (a
 * minute), no answer (twenty seconds): public-markets.ts holdBackMs. Kept by the network it is asked through, so the wallet's prices of its
 * tokenised shares, its swaps and its bridges ask LI.FI alike: one refusal is one answer, and one hold, for all of them. LI.FI saying the
 * DEXes or bridges it asked did not answer is about them, not about this machine reaching LI.FI, and holds nothing */
const lifiHeld = new WeakMap<Http, { until: number; said: Refusal }>();
export function lifiHold(http: Http, said: Refusal, now: number): void {
  const ms = holdBackMs(said, now);
  if (ms <= 0 || (said.native as { codes?: unknown } | undefined)?.codes !== undefined) return;
  const was = lifiHeld.get(http);
  if (!was || was.until <= now || was.until < now + ms) lifiHeld.set(http, { until: now + ms, said });
}
/** the refusal that holds LI.FI back now, if one does, as met at `venue` */
export function lifiHolding(http: Http, now: number, venue: string): Refusal | undefined {
  const h = lifiHeld.get(http);
  return h && now < h.until ? { ...h.said, venue } : undefined;
}

/** the swap LI.FI answered, held to what was asked before a wallet is shown it (the checks are the ones in LI.FI's own contract) */
function verifyRoute(q: Obj, want: { chainId: number; diamond: Hex; owner: Hex; from: Hex; to: Hex }): { fromAmount: bigint; minOut: bigint; value: bigint } | string {
  const tx = obj(q.transactionRequest);
  const action = obj(q.action);
  const est = obj(q.estimate);
  const fromAmount = big(action.fromAmount);
  const minOut = big(est.toAmountMin);
  if (num(tx.chainId) !== want.chainId || num(action.fromChainId) !== want.chainId || num(action.toChainId) !== want.chainId) return "it is for another chain";
  if (!same(tx.to, want.diamond)) return "it is not addressed to LI.FI's own contract";
  if (want.from !== NATIVE && !same(est.approvalAddress, want.diamond)) return "it asks the wallet to approve a spender that is not LI.FI's own contract";
  if (!same(action.fromAddress, want.owner) || (action.toAddress !== undefined && !same(action.toAddress, want.owner))) return "it is not from and to this wallet";
  if (!same(obj(action.fromToken).address, want.from) || !same(obj(action.toToken).address, want.to)) return "it swaps other tokens than the ones asked";
  if (fromAmount === undefined || fromAmount <= 0n || big(est.fromAmount) !== fromAmount) return "its amounts do not agree";
  if (minOut === undefined || minOut <= 0n) return "it names no least amount out";
  let d: { functionName: string; args: readonly unknown[] };
  try {
    d = decodeFunctionData({ abi: LIFI_SWAP_ABI, data: str(tx.data) as Hex }) as unknown as typeof d;
  } catch {
    return "its transaction is not one of LI.FI's same-chain swaps";
  }
  const kind = want.from === NATIVE ? "NativeToERC20" : want.to === NATIVE ? "ERC20ToNative" : "ERC20ToERC20";
  if (!d.functionName.endsWith(kind)) return `its transaction is a ${d.functionName}, not a swap of these two tokens`;
  const [txId, , , receiver, minAmountOut, swapData] = d.args as [Hex, string, string, Hex, bigint, Leg | readonly Leg[]];
  const legs: readonly Leg[] = Array.isArray(swapData) ? swapData : [swapData as Leg];
  if (!same(receiver, want.owner)) return "it pays another address than this wallet";
  if (minAmountOut !== minOut) return "the least it pays on chain is not the least LI.FI quoted";
  if (!same(q.transactionId, txId)) return "its id is not the quote's";
  if (!legs.length || !same(legs[0]!.sendingAssetId, want.from) || legs[0]!.fromAmount !== fromAmount || !same(legs[legs.length - 1]!.receivingAssetId, want.to)) return "what it spends or buys is not what LI.FI quoted";
  // LI.FI's contract pulls from the wallet every leg marked `requiresDeposit` (only the first, in every quote read live): a later one would
  // take more than the amount sold — of this token or of any other the wallet lets LI.FI's contract spend — for the same least out
  if (legs.slice(1).some((l) => l.requiresDeposit)) return "it takes more from the wallet than the amount it sells";
  const value = big(tx.value) ?? 0n;
  if (want.from === NATIVE ? value !== fromAmount : value !== 0n) return "it sends a different amount of the chain's own coin";
  return { fromAmount, minOut, value };
}

/** LI.FI's price of a tokenised share a wallet holds, by the network asked through, then by chain and address: kept a minute */
const issuedPrices = new WeakMap<Http, Map<string, { at: number; price: number }>>();
const PRICE_MS = 60_000;

/** The best-known Ondo Stocks and xStocks (KNOWN) an address holds, read from the chains, each held one priced by LI.FI's GET /v1/token
 * (nothing is asked when nothing is held; a price is kept a minute). They are held as RWAs, and sold from the wallet as the market their row
 * finds by symbol and chain (`NVDAon/USDC@Ethereum`). A chain that does not answer is named in `failed`, not thrown. LI.FI refusing this
 * machine is `unpriced`, in LI.FI's words: the tokens are shown without a price, LI.FI is not asked for the others in this read, and not
 * again while its refusal holds it back (lifiHold) — the trader's reads of the same markets see the same refusal */
export async function issuedHoldings(holder: Hex, chain: ChainReader, http: Http, opts: { venue?: string | undefined; now?: (() => number) | undefined } = {}): Promise<{ rows: LiveBalance[]; failed: ChainName[]; unpriced?: Refusal | undefined }> {
  const venue = opts.venue ?? "wallet";
  const now = opts.now ?? Date.now;
  const read = await chain.tokens(
    holder,
    KNOWN.map((k) => ({ chain: k.chain, asset: k.symbol, address: k.address })),
  );
  const held = read.rows.filter((b) => b.amount > 0);
  const prices = issuedPrices.get(http) ?? new Map<string, { at: number; price: number }>();
  issuedPrices.set(http, prices);
  let refused = lifiHolding(http, now(), venue);
  const rows: LiveBalance[] = [];
  // one at a time: a refusal from LI.FI stops the asking for the rest of this read
  for (const b of held) {
    const k = KNOWN.find((x) => x.chain === b.chain && x.symbol === b.asset)!;
    const key = `${k.chain}|${k.address.toLowerCase()}`;
    const kept = prices.get(key);
    let price = kept && now() - kept.at < PRICE_MS ? kept.price : undefined;
    if (price === undefined && !refused) {
      try {
        const r = await http(`${LIFI}/token?chain=${chainId(k.chain)}&token=${k.address}`, { headers: { accept: "application/json" }, timeoutMs: 10_000 });
        const t = obj(r.body);
        if (r.status === 200 && same(t.address, k.address) && num(t.priceUSD) > 0) prices.set(key, { at: now(), price: (price = num(t.priceUSD)) });
        else if (r.status !== 200) refused = lifiNo(venue, r);
        // a 200 that is not LI.FI's price of this token: no price this time, the token shown and counted for nothing
      } catch (err) {
        refused = byParty(unreachable(venue, NAME, err), "lifi");
      }
      if (refused) lifiHold(http, refused, now());
    }
    rows.push({ asset: b.asset, amount: b.amount, ...(price !== undefined ? { usd: b.amount * price } : {}), where: `${b.chain} · ${ISSUERS[k.issuer].kind}`, class: "rwa" });
  }
  return { rows, failed: read.failed, ...(refused && rows.some((r) => r.usd === undefined) ? { unpriced: refused } : {}) };
}

export function dexTrader(req: DexRequest): LiveTrader {
  const { venue, http, chain } = req;
  const owner = getAddress(req.address);
  const now = req.now ?? Date.now;
  const pause = req.pause ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let listed: Listed | undefined;
  /** the price market() last showed for a symbol: the one the account valued the order at, just before it asks place() */
  const valued = new Map<string, number>();
  const routes = new Map<string, Route>();
  const byHash = new Map<string, Route>();
  /** what each issuer last said of a token, by chain and address, and until when it is kept */
  const confirmed = new Map<string, { until: number; said: Confirmed | Refusal }>();
  /** LI.FI asked — not while a refusal of its holds it back (lifiHold), and one that holds it back is kept for every later ask */
  const call = async (path: string, timeoutMs = 10_000): Promise<HttpReply | Refusal> => {
    const held = lifiHolding(http, now(), venue);
    if (held) return held;
    try {
      return await http(`${LIFI}${path}`, { headers: { accept: "application/json" }, timeoutMs });
    } catch (err) {
      const u = byParty(unreachable(venue, NAME, err), "lifi");
      lifiHold(http, u, now());
      return u;
    }
  };
  /** LI.FI's no, as lifiNo reads it, held back as long as it says */
  const lifiSaid = (r: HttpReply): Refusal => {
    const x = lifiNo(venue, r);
    lifiHold(http, x, now());
    return x;
  };
  /** a 200 that is not LI.FI's JSON (a filtering network's page, a captive portal, an empty or cut answer): no answer, kept nowhere, and none
   * of the page's text in it — such a page may print this machine's address */
  const notLifi = (r: HttpReply, what: string): Refusal => no("E_VENUE_UNREACHABLE", { venue, message: notTheApi(r) ? notTheApiWords(NAME) : `${NAME} answered something that is not ${what}: try again shortly`, native: { status: r.status, party: "lifi" } });

  const marketOf = (t: Tok, price: number | undefined): Market => {
    const dollar = dollarOn(t.chain).symbol;
    const m: Market = { symbol: `${t.symbol}/${dollar}@${t.chain}`, name: `${t.name} on ${t.chain}`, kind: "token", base: t.symbol, quote: dollar, price: price !== undefined && price > 0 ? price : undefined, qtyStep: stepOf(t.decimals), minNotional: 1, open: true, note: NOTE, types: ["market"] };
    if (!t.issuer) return m;
    const is = ISSUERS[t.issuer];
    const rwa: RwaMarket = { ...m, name: `${underlyingOf(t)} · ${is.kind} on ${t.chain}`, category: RWA_CATEGORY, issuer: is.issuer, eligibility: is.terms, note: `${is.kind}, issued by ${is.issuer}. ${is.terms} · ${NOTE}` };
    // a token whose contract moves it only between wallets its issuer approved takes no order here: it is shown with the issuer's rule
    return is.restricted ? { ...rwa, open: false, types: [] } : rwa;
  };

  /** LI.FI's token list for the seven chains, kept five minutes. A token is found by its symbol only when exactly one token on that chain
   * carries it (LI.FI says symbols are not unique: Base has a USDT and a USD₮0), and never when LI.FI flags it. A token an issuer stands
   * behind is found by its address, first (see the top of this file) */
  const list = async (): Promise<Listed | Refusal> => {
    const fresh = listed && now() - listed.at < LIST_MS ? listed : undefined;
    // kept, unless Robinhood's list was unread when it was built and its hold is over: then Robinhood is asked again, and the markets built
    // again from LI.FI's kept list — not left unread for as long as LI.FI's list is kept
    if (fresh && !(fresh.robinhoodUnread && now() >= fresh.robinhoodUnread.until)) return fresh;
    let all: Obj;
    let at: number;
    if (fresh) ({ all, at } = fresh);
    else {
      const r = await call(`/tokens?chains=${DEX_CHAINS.map(chainId).join(",")}`, 20_000);
      if (isRefusal(r)) return r;
      if (r.status !== 200) return lifiSaid(r);
      if (r.body === undefined || typeof r.body !== "object") return notLifi(r, "its token list");
      // the answer is { tokens: { "<chain id>": [Token] } } (docs.li.fi shows the chain ids at the top; what LI.FI sends wraps them)
      all = obj(obj(r.body).tokens ?? r.body);
      at = now();
    }
    // Robinhood's own list: what makes a token on Robinhood Chain a Stock Token
    let robinhood: StockToken[] | undefined;
    let robinhoodUnread: Listed["robinhoodUnread"];
    try {
      robinhood = (await stockTokens(http, now())).filter((t) => t.chain === "Robinhood Chain");
    } catch (err) {
      const said = robinhoodNo(err);
      robinhoodUnread = { until: now() + Math.max(issuerHoldMs(said, now()), 20_000), said };
    }
    const rhSet = robinhood ? new Set(robinhood.map((t) => t.address.toLowerCase())) : undefined;
    const bySymbol = new Map<string, { base: Tok; usdc: Tok }>();
    const known: Market[] = [];
    const rest: Market[] = [];
    const issued: Market[] = [];
    const found = new Map<ChainName, { usdc: Tok; find: (symbol: string) => Tok | undefined; tokens: Tok[]; byAddress: Map<string, Tok> }>();
    for (const c of DEX_CHAINS) {
      const tokens = arr(all[String(chainId(c))])
        .filter((t) => str(t.verificationStatus) !== "flagged" && /^0x[0-9a-fA-F]{40}$/.test(str(t.address)) && Number.isInteger(t.decimals))
        .map((t): Tok => ({ chain: c, address: getAddress(str(t.address)), symbol: str(t.symbol), name: str(t.name) || str(t.symbol), decimals: Number(t.decimals), priceUSD: num(t.priceUSD), verified: str(t.verificationStatus) === "verified" }));
      const usdc = tokens.find((t) => same(t.address, dollarOn(c).address));
      if (!usdc) continue;
      for (const t of tokens) t.issuer = issuerOf(c, t, rhSet);
      const byAddress = new Map(tokens.map((t) => [t.address.toLowerCase(), t]));
      const find = (symbol: string): Tok | undefined => {
        const s = symbol.toUpperCase();
        if (s === CHAINS[c].coin) return tokens.find((t) => t.address === NATIVE);
        const named = tokens.filter((t) => t.address !== NATIVE && !t.issuer && t.symbol.toUpperCase() === s);
        if (named.length === 1) return named[0];
        const verified = named.filter((t) => t.verified);
        return verified.length === 1 ? verified[0] : undefined;
      };
      found.set(c, { usdc, find, tokens, byAddress });
    }
    const add = (t: Tok, usdc: Tok, into: Market[]) => {
      const m = marketOf(t, t.priceUSD);
      const key = m.symbol.toUpperCase();
      if (bySymbol.has(key) || (!t.issuer && isStable(t.symbol)) || t.symbol.includes("/") || t.symbol.includes("@")) return;
      bySymbol.set(key, { base: t, usdc });
      // a token an issuer stands behind is listed even unpriced (LI.FI's list leaves some out, and routes them): market() prices it
      if (m.price !== undefined || t.issuer) into.push(m);
    };
    // the tokens issuers stand behind, by address: Robinhood's Stock Tokens as LI.FI lists them, or as Robinhood does where LI.FI's list
    // leaves one out; the best-known Ondo Stocks and xStocks from their issuers' lists; then any other LI.FI verifies under an issuer's name
    const rh = found.get("Robinhood Chain");
    if (rh && robinhood)
      for (const s of robinhood) add({ ...(rh.byAddress.get(s.address.toLowerCase()) ?? { chain: "Robinhood Chain", address: s.address, name: s.name, decimals: s.decimals ?? 18, priceUSD: 0, verified: false }), symbol: s.symbol, issuer: "robinhood" }, rh.usdc, issued);
    for (const k of KNOWN) {
      const f = found.get(k.chain);
      if (!f) continue;
      const listedAs = f.byAddress.get(k.address.toLowerCase());
      add({ ...(listedAs ?? { chain: k.chain, address: k.address, symbol: k.symbol, name: k.underlying, decimals: 18, priceUSD: 0, verified: false }), symbol: k.symbol, issuer: k.issuer, underlying: k.underlying }, f.usdc, issued);
    }
    for (const x of RESTRICTED) {
      const f = found.get(x.chain);
      if (f) add({ ...(f.byAddress.get(x.address.toLowerCase()) ?? { chain: x.chain, address: getAddress(x.address), name: x.name, decimals: x.decimals, priceUSD: 0, verified: false }), symbol: x.symbol, issuer: x.issuer }, f.usdc, issued);
    }
    for (const [, f] of found) for (const t of f.tokens) if (t.issuer && t.issuer !== "robinhood" && f.tokens.filter((x) => x.symbol === t.symbol && x.issuer).length === 1) add(t, f.usdc, issued);
    for (const [c, symbol] of WELL_KNOWN) {
      const f = found.get(c);
      const t = f?.find(symbol);
      if (f && t) add(t, f.usdc, known);
    }
    // then any token LI.FI verifies, by a symbol that names one token on its chain — on Robinhood Chain only while Robinhood's list says
    // which tokens there are its own: without it, a verified "NVDA" there may be another's, and is offered as nothing at all
    for (const [c, f] of found) for (const t of f.tokens) if (!t.issuer && t.verified && f.find(t.symbol) === t && (c !== "Robinhood Chain" || rhSet)) add(t, f.usdc, rest);
    // to start from: the best-known coins, then the best-known tokenised shares LI.FI prices, then the rest
    const startRwa = RWA_START.map(([c, s]) => issued.find((m) => m.symbol.toUpperCase() === `${s}/${dollarOn(c).symbol}@${c}`.toUpperCase() && m.price !== undefined)).filter((m): m is Market => m !== undefined);
    // a list with no chain's dollar in it is not LI.FI's list of these chains: it is not kept
    if (!found.size) return notLifi({ status: 200, body: {}, text: "" }, "its token list");
    listed = { at, all, bySymbol, markets: [...known.slice(0, COINS_FIRST), ...startRwa, ...known.slice(COINS_FIRST), ...rest, ...issued.filter((m) => !startRwa.includes(m))], ...(robinhoodUnread ? { robinhoodUnread } : {}) };
    return listed;
  };
  /** Robinhood's Stock Token list not read, in Robinhood's own answer: its place rule, its edge page, its ban with its time, or no answer —
   * the code and the hold its own (robinhood.ts stockTokens) — as Robinhood's about its tokens, holding back nothing else of the wallet */
  const robinhoodNo = (err: unknown): Refusal => forProduct(isRefusal(err) ? { ...err, venue } : unreachable(venue, "Robinhood's Stock Token list", err));

  const lookup = async (symbol: string): Promise<{ base: Tok; usdc: Tok; chain: ChainName } | Refusal> => {
    const p = parseSymbol(venue, symbol);
    if (isRefusal(p)) return p;
    const l = await list();
    if (isRefusal(l)) return l;
    const hit = l.bySymbol.get(`${p.base}/${p.quote}@${p.chain}`.toUpperCase());
    if (!hit) {
      if (p.chain === "Robinhood Chain") {
        const u = l.robinhoodUnread?.said;
        return u ? { ...u, message: `${u.message}: its tokens on Robinhood Chain cannot be told from others under the same symbols just now` } : no("E_ACCOUNT_BAD_ACTION", { venue, message: `Robinhood's own list names no Stock Token ${p.base} on Robinhood Chain: only Robinhood's Stock Tokens are swapped there from here` });
      }
      // a share an issuer has on another chain: say where it is
      const elsewhere = [...l.bySymbol.values()].filter((h) => h.base.issuer && h.base.symbol.toUpperCase() === p.base.toUpperCase()).map((h) => h.base);
      if (elsewhere.length) return no("E_ACCOUNT_BAD_ACTION", { venue, message: `${elsewhere[0]!.symbol}, issued by ${ISSUERS[elsewhere[0]!.issuer!].issuer}, is swapped here on ${[...new Set(elsewhere.map((t) => t.chain))].join(" and ")}, not on ${p.chain}: ${elsewhere.map((t) => marketOf(t, undefined).symbol).join(", ")}` });
      return no("E_ACCOUNT_BAD_ACTION", { venue, message: `${NAME} lists no single verified token ${p.base} on ${p.chain}: search the markets for its symbol` });
    }
    return { ...hit, chain: p.chain };
  };

  /** the issuer's own word on a token before it is priced or swapped: its list, its contract (kept a minute; an issuer that cannot be asked
   * just now — no answer, its place rule, its edge, its ban — is held back for as long as its own refusal says, holdBackMs). A token whose
   * contract moves it only between approved wallets is refused here, with the issuer's rule */
  const confirm = async (t: Tok): Promise<Confirmed | Refusal> => {
    if (!t.issuer) return {};
    const is = ISSUERS[t.issuer];
    if (is.restricted) return no("E_VENUE_TRANSFER_RESTRICTED", { venue, message: `${t.symbol} on ${t.chain}: ${is.terms}. Nothing was prepared`, native: { token: t.address, chain: t.chain, issuer: is.issuer } });
    const key = `${t.chain}|${t.address.toLowerCase()}`;
    const kept = confirmed.get(key);
    if (kept && now() < kept.until) return kept.said;
    const asked = await askIssuer(t);
    // the issuer's refusal is about this token: it holds back nothing else of the wallet, and this token for as long as it says
    const said = isRefusal(asked) ? forProduct(asked) : asked;
    const ms = isRefusal(said) && (said.code === "E_VENUE_UNREACHABLE" || said.code === "E_VENUE_GEOBLOCKED") ? issuerHoldMs(said, now()) : CONFIRM_MS;
    if (ms > 0) confirmed.set(key, { until: now() + ms, said });
    return said;
  };
  const askIssuer = async (t: Tok): Promise<Confirmed | Refusal> => {
    const native = { token: t.address, chain: t.chain };
    /** the issuer not answering, or refusing this network, in its own refusal — its code, its words, its hold — and what that leaves undone */
    const unconfirmed = (said: Refusal): Refusal => no(said.code, { venue, message: `${said.message}: ${t.symbol} could not be confirmed as its own, so nothing was prepared`, native: { ...(said.native && typeof said.native === "object" ? (said.native as Record<string, unknown>) : {}), ...native } });
    if (t.issuer === "robinhood") {
      let list: StockToken[];
      try {
        list = await stockTokens(http, now());
      } catch (err) {
        // Robinhood's own no (robinhood.ts: its place rule, an edge page, a ban) kept as it is; only a real throw is "did not answer"
        if (isRefusal(err)) return unconfirmed(err);
        return no("E_VENUE_UNREACHABLE", { venue, message: `Robinhood's Stock Token list did not answer: ${t.symbol} could not be confirmed as Robinhood's own token, so nothing was prepared`, native });
      }
      if (!list.some((s) => s.chain === t.chain && same(s.address, t.address))) return no("E_VENUE_REJECTED", { venue, message: `Robinhood's own list no longer names ${t.address} as its ${t.symbol} Stock Token: it is not traded from here`, native });
      return {};
    }
    if (t.issuer === "ondo") {
      const manager = ONDO_MANAGER[t.chain];
      if (!manager) return no("E_ACCOUNT_BAD_ACTION", { venue, message: `Ondo's Stocks are swapped here on ${ISSUERS.ondo.chains.join(" and ")}, not on ${t.chain}`, native });
      const accepted = await chain.uint(t.chain, manager, "function gmTokenAccepted(address token) view returns (uint256)", [t.address]);
      if (accepted === undefined) return no("E_VENUE_UNREACHABLE", { venue, message: `${t.chain} did not answer: Ondo's GMTokenManager could not be asked whether ${t.symbol} is its own, so nothing was prepared`, native });
      if (accepted === 0n) return no("E_VENUE_REJECTED", { venue, message: `Ondo's own GMTokenManager on ${t.chain} does not accept ${t.address} as an Ondo Stock: ${t.symbol} is not traded from here as one`, native: { ...native, manager } });
      // the token stops every transfer while Ondo pauses it (its error is TokenPaused): a swap would only revert
      const pauser = await chain.uint(t.chain, t.address, "function tokenPauseManager() view returns (uint256)");
      const paused = pauser === undefined ? undefined : await chain.uint(t.chain, addressOf(pauser), "function isTokenPaused(address token) view returns (uint256)", [t.address]);
      if (paused === undefined) return no("E_VENUE_UNREACHABLE", { venue, message: `${t.chain} did not answer: whether Ondo has paused ${t.symbol} could not be read, so nothing was prepared`, native });
      return paused === 0n ? {} : { closed: `Ondo has paused ${t.symbol} on ${t.chain} (its token pause manager says so): a transfer of it reverts until Ondo lifts the pause` };
    }
    // xStocks: its own record of the token, keyless
    const network = XSTOCKS_NETWORK[t.chain];
    if (!network) return no("E_ACCOUNT_BAD_ACTION", { venue, message: `xStocks are swapped here on ${ISSUERS.xstocks.chains.join(", ")}, not on ${t.chain}`, native });
    let r: HttpReply;
    try {
      r = await http(`${XSTOCKS}/public/assets/${encodeURIComponent(t.symbol)}`, { headers: { accept: "application/json" }, timeoutMs: 10_000 });
    } catch {
      return no("E_VENUE_UNREACHABLE", { venue, message: `xStocks did not answer: ${t.symbol} could not be confirmed as its own, so nothing was prepared`, native });
    }
    if (r.status === 404) return no("E_VENUE_REJECTED", { venue, message: `xStocks' own list has no ${t.symbol}: it is not traded from here as an xStock`, native });
    if (r.status !== 200) {
      // xStocks' own answer: its place rule, its edge's page, its ban with its time, a rate limit, an outage — read as every answer is. Its
      // API takes no key, so a 401 or a 403 that is none of those is xStocks refusing the request, not a key's permission
      const said = venueSaidNo(venue, "xStocks", r.status, r.text, [], r);
      return unconfirmed(said.code === "E_VENUE_UNAUTHORIZED" || said.code === "E_VENUE_PERMISSION" ? no("E_VENUE_REJECTED", { venue, message: `xStocks refused the request (HTTP ${r.status})`, native: { status: r.status } }) : said);
    }
    // a 200 that is not xStocks' record (a filtering network's page, an empty or cut answer) says nothing of what xStocks lists
    if (r.body === undefined || !Array.isArray(obj(r.body).deployments)) return no("E_VENUE_UNREACHABLE", { venue, message: `xStocks answered something that is not its record of ${t.symbol}: it could not be confirmed as its own, so nothing was prepared`, native: { ...native, status: r.status } });
    const b = obj(r.body);
    const at = arr(b.deployments).find((d) => str(d.network) === network);
    if (!at || !same(at.address, t.address)) return no("E_VENUE_REJECTED", { venue, message: `xStocks' own list does not name ${t.address} as its ${t.symbol} on ${t.chain}: it is not traded from here`, native: { ...native, listed: str(at?.address) || undefined } });
    return b.isTradingHalted === true || obj(b.trading).isTradingHalted === true ? { said: `xStocks reports trading in ${t.symbol} halted: its price may not follow the share until it resumes` } : {};
  };

  /** what the wallet holds of a token on a chain, in whole tokens. An endpoint that refused or rate-limited this machine has not said the
   * wallet holds nothing, and nor has a chain that answered without the token's row (its balance call reverted): both are "did not answer" */
  const holds = async (c: ChainName, t: { address: Hex; symbol: string }): Promise<number | Refusal> => {
    const r = t.address === NATIVE ? await chain.native(owner, [c]) : await chain.tokens(owner, [{ chain: c, asset: t.symbol, address: t.address }]);
    if (r.failed.length || !r.rows.length) return no("E_VENUE_UNREACHABLE", { venue, message: `${c} did not answer${r.said?.[c] ? ` (${r.said[c]})` : ""}: the wallet's ${t.symbol} could not be read, so nothing was prepared` });
    return r.rows[0]!.amount;
  };
  const short = (c: ChainName, asset: string, have: number, need: number, what = "this swap needs"): Refusal => no("E_VENUE_INSUFFICIENT", { venue, message: `the wallet holds ${plain(have, 8)} ${asset} on ${c}; ${what} ${plain(need, 8)}`, native: { asset, chain: c, have, need } });

  /** the token's decimals, from the token itself, agreeing with LI.FI's */
  const decimalsOf = async (c: ChainName, t: Tok): Promise<number | Refusal> => {
    if (t.address === NATIVE) return 18;
    const d = await chain.decimals(c, t.address);
    if (d === undefined) return no("E_VENUE_UNREACHABLE", { venue, message: `${c} did not answer: ${t.symbol}'s decimals could not be read, so nothing was prepared` });
    if (d !== t.decimals) return no("E_VENUE_REJECTED", { venue, message: `${t.symbol} on ${c} says it has ${d} decimals and ${NAME} says ${t.decimals}: nothing was prepared`, native: { token: t.address, chain: d, lifi: t.decimals } });
    return d;
  };

  const lifiNative = (b: Obj) => ({ status: str(b.status), ...(b.substatus ? { substatus: str(b.substatus) } : {}), ...(b.substatusMessage ? { said: str(b.substatusMessage) } : {}), ...(b.tool ? { tool: str(b.tool) } : {}), ...(b.transactionId ? { transactionId: str(b.transactionId) } : {}), ...(b.lifiExplorerLink ? { explorer: str(b.lifiExplorerLink) } : {}) });

  /** an order filled: dollars per base unit, the chain's dollar counted one for one; LI.FI's fee is inside the amounts, so it is inside the
   * price too */
  const filled = (ref: string, buy: boolean, baseAmt: bigint, baseDec: number, usdcAmt: bigint, usdcDec: number, native: unknown, feeUsd?: number): OrderState => {
    const qty = Number(formatUnits(baseAmt, baseDec));
    const dollars = Number(formatUnits(usdcAmt, usdcDec));
    return { ref, status: "filled", filledQty: qty, avgPrice: qty > 0 ? dollars / qty : undefined, ...(feeUsd !== undefined ? { feeUsd } : {}), native: { side: buy ? "buy" : "sell", ...obj(native) } };
  };

  /** the chain's own answer: not mined yet, reverted, or LI.FI's contract saying what this wallet received */
  const fromReceipt = async (ref: Hex, c: ChainName, known: Route | undefined, base: Tok | undefined, lifi: unknown): Promise<OrderState> => {
    const pending: OrderState = { ref, status: "pending", filledQty: 0, native: { lifi, chain: "not mined yet" } };
    let rc: Mined | undefined;
    try {
      rc = await chain.receipt(c, ref);
    } catch (err) {
      // the chain's endpoint not answering, or refusing this network, is not "not mined yet": it is said in its words, and asked again later
      return { ...pending, native: { lifi, chain: isRefusal(err) ? err.message : `${c} did not answer` } };
    }
    if (!rc) return pending;
    if (rc.status === "reverted") return { ref, status: "rejected", filledQty: 0, native: { lifi, receipt: "reverted: nothing moved but the network fee" } };
    const usdc = dollarOn(c).address;
    for (const l of rc.logs) {
      if (!same(l.address, diamondOn(c)) || !same(l.topics[0], SWAP_DONE_TOPIC)) continue;
      let e;
      try {
        e = decodeEventLog({ abi: SWAP_DONE, data: l.data, topics: l.topics as [Hex, ...Hex[]] }).args;
      } catch {
        continue;
      }
      if (!same(e.receiver, owner) || (known && !same(e.transactionId, known.transactionId))) continue;
      const buy = same(e.fromAssetId, usdc);
      if (!buy && !same(e.toAssetId, usdc)) continue;
      const baseAddr = getAddress(buy ? e.toAssetId : e.fromAssetId);
      if (base && !same(baseAddr, base.address)) continue;
      const baseDec = baseAddr === NATIVE ? 18 : (base?.decimals ?? (await chain.decimals(c, baseAddr)));
      const usdcDec = known?.usdc.decimals ?? (await chain.decimals(c, usdc));
      if (baseDec === undefined || usdcDec === undefined) return pending;
      return filled(ref, buy, buy ? e.toAmount : e.fromAmount, baseDec, buy ? e.fromAmount : e.toAmount, usdcDec, { lifi, receipt: "success", transactionId: e.transactionId });
    }
    // mined, but no swap to this wallet in it yet as far as the logs say: LI.FI's status will tell; an order is never counted unfilled on a guess
    return { ...pending, native: { lifi, receipt: "success, no LI.FI swap to this wallet found in its logs" } };
  };

  const status = async (ref: string, symbol: string): Promise<OrderState | Refusal> => {
    if (!HASH.test(ref)) return no("E_ACCOUNT_ORDER_UNKNOWN", { venue, message: `${ref || "an order the wallet has not sent"} is not a transaction hash: there is nothing on chain to ask about`, detail: { ref } });
    const p = parseSymbol(venue, symbol);
    if (isRefusal(p)) return p;
    const c = p.chain;
    const dollar = dollarOn(c).address;
    const known = byHash.get(ref.toLowerCase());
    let base = known?.base;
    if (!base) {
      const hit = await lookup(symbol);
      if (!isRefusal(hit)) base = hit.base;
    }
    const r = await call(`/status?txHash=${ref}&fromChain=${chainId(c)}&toChain=${chainId(c)}`);
    // LI.FI refusing this machine (its edge, a ban, a rate limit) holds it back for every ask, this order's next look too: the chain is the
    // record meanwhile. Its words are cleaned of any address before they are cut, and before they ride on the order to the page and the ledger
    if (!isRefusal(r) && r.status !== 200 && r.status !== 400 && r.status !== 404) lifiSaid(r);
    let lifi: unknown = isRefusal(r) ? { unreachable: r.message } : { status: r.status, said: redact(r.text, []).replace(/\s+/g, " ").trim().slice(0, 220) };
    if (!isRefusal(r) && r.status === 400) return no("E_ACCOUNT_ORDER_UNKNOWN", { venue, message: `${NAME} does not know ${ref}: ${str(obj(r.body).message) || "not a transaction it can look up"}`, native: lifi });
    if (!isRefusal(r) && r.status === 200) {
      const b = obj(r.body);
      const said = lifiNative(b);
      lifi = said;
      if (b.toAddress !== undefined && !same(b.toAddress, owner)) return no("E_ACCOUNT_ORDER_UNKNOWN", { venue, message: `${ref} is a swap to another address, not to this wallet`, native: lifi });
      const st = str(b.status);
      if (st === "FAILED") return { ref, status: "rejected", filledQty: 0, native: lifi };
      if (st === "DONE") {
        const sending = obj(b.sending);
        const receiving = obj(b.receiving);
        const sTok = obj(sending.token);
        const rTok = obj(receiving.token);
        const sub = str(b.substatus);
        const buy = same(sTok.address, dollar);
        const baseTok = buy ? rTok : sTok;
        const moved = { ...said, receiving: { token: str(rTok.symbol), amount: str(receiving.amount) } };
        // REFUNDED: the money came back, nothing filled
        if (sub === "REFUNDED") return { ref, status: "canceled", filledQty: 0, native: moved };
        // PARTIAL (the wallet got another token than the one asked), or a swap of other tokens: money DID move, so it is never counted as
        // "nothing filled" (that would hand an agent back limit it spent). The chain's receipt decides, and without a swap of this market in
        // it the order stays pending
        if ((sub && sub !== "COMPLETED") || (!buy && !same(rTok.address, dollar)) || (base && !same(baseTok.address, base.address))) return fromReceipt(ref as Hex, c, known, base, moved);
        const baseAmt = big(buy ? receiving.amount : sending.amount);
        const usdcAmt = big(buy ? sending.amount : receiving.amount);
        const usdcDec = buy ? sTok.decimals : rTok.decimals;
        if (baseAmt !== undefined && usdcAmt !== undefined && Number.isInteger(baseTok.decimals) && Number.isInteger(usdcDec)) {
          const fees = [...arr(b.feeCosts).map((f) => f.amountUSD), sending.gasAmountUSD].filter((x) => x !== undefined && str(x) !== "");
          return filled(ref, buy, baseAmt, Number(baseTok.decimals), usdcAmt, Number(usdcDec), lifi, fees.length ? Number(fees.reduce((s: number, x) => s + num(x), 0).toFixed(6)) : undefined);
        }
      }
    }
    // not seen yet (404 · 1003, normal for a minute or two), still pending, or LI.FI did not answer: the chain is the record
    return fromReceipt(ref as Hex, c, known, base, lifi);
  };

  const watched = `${owner} is watched, not proven yours: a swap is sent only from a wallet that signed for its address`;
  /** an order id names one order: the same market, side, size and worst price */
  const keyOf = (o: OrderRequest) => `${o.symbol}|${o.side}|${o.qty}|${o.worstPrice ?? ""}`;
  const tidy = () => {
    for (const [id, r] of routes) if (now() - r.at > 60 * 60_000) routes.delete(id);
    for (const [h, r] of byHash) if (now() - r.at > 24 * 60 * 60_000) byHash.delete(h);
  };
  const swapOf = (r: Route): WalletTx | undefined => r.state.walletTxs?.at(-1);
  /** the order's id that a LI.FI swap carries in its call (`_transactionId`), the same one its contract logs when the swap is done */
  const swapIdOf = (data: Hex): Hex | undefined => {
    try {
      return (decodeFunctionData({ abi: LIFI_SWAP_ABI, data }).args as readonly unknown[])[0] as Hex;
    } catch {
      return undefined;
    }
  };

  /** A fresh LI.FI quote for the order, checked, held to its worst price, the wallet's balances and allowance looked at: what place() hands
   * the wallet first, and what requote() hands it again once the approval is on chain (`again`: the swap alone, never an approval, and held
   * to the price the first swap was held to as well) */
  const build = async (o: OrderRequest, again?: { bound?: number | undefined }): Promise<Omit<Route, "key" | "at" | "clientId"> | Refusal> => {
    if (o.worstPrice !== undefined && !(Number.isFinite(o.worstPrice) && o.worstPrice > 0)) return badOrder(venue, NAME, "a market order's worst price is a price more than zero");
    const hit = await lookup(o.symbol);
    if (isRefusal(hit)) return hit;
    const { base, usdc, chain: c } = hit;
    // a token an issuer stands behind: the issuer's own word first, before a quote is spent on it
    const issuer = await confirm(base);
    if (isRefusal(issuer)) return issuer;
    if (issuer.closed) return no("E_VENUE_MARKET_CLOSED", { venue, message: `${issuer.closed}. Nothing was prepared`, native: { token: base.address, chain: c } });
    const id = chainId(c);
    const diamond = diamondOn(c);
    const decs = await Promise.all([decimalsOf(c, base), decimalsOf(c, usdc)]);
    for (const d of decs) if (isRefusal(d)) return d;
    const qty = floorTo(o.qty, stepOf(base.decimals));
    const amount = qty > 0 ? parseUnits(plain(qty, Math.min(base.decimals, 8)), base.decimals) : 0n;
    if (amount <= 0n) return badOrder(venue, NAME, `the smallest size of ${base.symbol} is ${plain(stepOf(base.decimals))}`);
    const buy = o.side === "buy";
    const from = buy ? usdc : base;
    const to = buy ? base : usdc;
    // a sell is exactly this much of the token: see that the wallet has it before a quote is spent on it (keyless quotes are few)
    if (!buy) {
      const have = await holds(c, base);
      if (isRefusal(have)) return have;
      if (have + 1e-12 < qty) return short(c, base.symbol, have, qty);
    }
    const q = new URLSearchParams({ fromChain: String(id), toChain: String(id), fromToken: from.address, toToken: to.address, ...(buy ? { toAmount: amount.toString() } : { fromAmount: amount.toString() }), fromAddress: owner, slippage: String(SLIPPAGE), integrator: INTEGRATOR, order: "CHEAPEST" });
    // a buy names what is received (GET /v1/quote/toAmount: LI.FI works out what is spent); a sell names what is spent (GET /v1/quote)
    const r = await call(`/quote${buy ? "/toAmount" : ""}?${q.toString()}`, 20_000);
    if (isRefusal(r)) return r;
    if (r.status !== 200) return lifiSaid(r);
    if (r.body === undefined || typeof r.body !== "object") return notLifi(r, "a quote");
    const quote = obj(r.body);
    const ok = verifyRoute(quote, { chainId: id, diamond, owner, from: from.address, to: to.address });
    if (typeof ok === "string") return no("E_VENUE_REJECTED", { venue, message: `${NAME} answered a swap this account will not hand your wallet: ${ok}. Nothing was prepared`, native: { route: str(quote.id), tool: str(quote.tool) } });
    const est = obj(quote.estimate);
    const action = obj(quote.action);
    if (!buy && ok.fromAmount !== amount) return no("E_VENUE_REJECTED", { venue, message: `${NAME} quoted selling ${formatUnits(ok.fromAmount, base.decimals)} ${base.symbol}, not the ${plain(qty)} asked. Nothing was prepared` });
    if (buy && ok.minOut * 10_000n < amount * BigInt(Math.round((1 - ROOM) * 10_000))) return no("E_ACCOUNT_REQUOTE", { venue, message: `${NAME}'s route promises at least ${formatUnits(ok.minOut, base.decimals)} ${base.symbol}, short of the ${plain(qty)} asked. Nothing was prepared` });
    // held to the price the account counted the order at: a buy costs at most 2% over LI.FI's price, a sell pays at least 2% under. The
    // price is the tighter of the route's and the one market() showed when the account valued the order, so the room is never measured
    // from a price that moved up after the cap and the signature were checked
    const quoted = num(obj(buy ? action.toToken : action.fromToken).priceUSD);
    if (!(quoted > 0)) return no("E_ACCOUNT_UNPRICED", { venue, message: `${NAME} gave no price for ${base.symbol} with its route, so no limit can be judged. Nothing was prepared` });
    const counted = valued.get(`${base.symbol}/${dollarOn(c).symbol}@${c}`.toUpperCase()) ?? quoted;
    const price = buy ? Math.min(quoted, counted) : Math.max(quoted, counted);
    // the order's own worst price (and, for a swap built again, the price the first one was held to) pulls the room in; it never pushes it out
    const room = buy ? price * (1 + ROOM) : price * (1 - ROOM);
    const given = [o.worstPrice, again?.bound].filter((x): x is number => x !== undefined);
    const tightest = given.length ? (buy ? Math.min(...given) : Math.max(...given)) : undefined;
    const bound = tightest !== undefined && (buy ? tightest < room : tightest > room) ? tightest : room;
    const held = bound === room ? (buy ? `its price ${plain(price)} with 2% room` : `its price ${plain(price)} less 2%`) : bound === o.worstPrice ? `the order's worst price ${plain(bound)} a ${base.symbol}` : `the price the first swap was held to, ${plain(bound)} a ${base.symbol}`;
    const spend = Number(formatUnits(ok.fromAmount, from.decimals));
    const least = Number(formatUnits(ok.minOut, to.decimals));
    // a buy is judged per token it is SURE to get (the least on chain), so 2% over the price is 2% over per token, never 2% more for 2% less.
    // What is judged is what LI.FI's contract enforces: the route spends exactly `spend` and reverts below `least`, so the fill stays inside
    const got = Math.min(qty, least);
    if (buy && spend > got * bound + 1e-9) return no("E_ACCOUNT_REQUOTE", { venue, message: `${NAME}'s route costs ${usd(spend)} for at least ${plain(got)} ${base.symbol}, more than ${usd(got * bound)} (${held}). Nothing was prepared`, detail: { spendUsd: spend, price, worstPrice: bound } });
    if (!buy && least < qty * bound - 1e-9) return no("E_ACCOUNT_REQUOTE", { venue, message: `${NAME}'s route pays at least ${usd(least)} for ${plain(qty)} ${base.symbol}, less than ${usd(qty * bound)} (${held}). Nothing was prepared`, detail: { leastUsd: least, price, worstPrice: bound } });
    // LI.FI does not check balances (a wallet with nothing gets a quote): the wallet must hold what is spent and the network fee
    const gasWei = arr(est.gasCosts).reduce((s, g) => s + (big(g.amount) ?? 0n), 0n);
    const coin = CHAINS[c].coin;
    if (buy) {
      const have = await holds(c, usdc);
      if (isRefusal(have)) return have;
      if (have + 1e-12 < spend) return short(c, dollarOn(c).symbol, have, spend);
    }
    const gas = await holds(c, { address: NATIVE, symbol: coin });
    if (isRefusal(gas)) return gas;
    const gasNeed = Number(formatUnits(gasWei + (from.address === NATIVE ? ok.fromAmount : 0n), 18));
    if (gas + 1e-18 < gasNeed) return short(c, coin, gas, gasNeed, from.address === NATIVE ? `this swap needs, with the network fee,` : "the network fee for this swap is about");

    const chainIdHex = `0x${id.toString(16)}` as Hex;
    const tx = obj(quote.transactionRequest);
    const walletTxs: WalletTx[] = [];
    if (from.address !== NATIVE) {
      // the wallet's allowance to LI.FI's contract; an approval for exactly this swap goes first when it is short (unread: approve anyway)
      const allowed = await chain.uint(c, from.address, ALLOWANCE, [owner, diamond]);
      if (again) {
        // the approval is on chain: the swap goes alone, so the wallet must already allow LI.FI's contract what the fresh route spends
        if (allowed === undefined) return no("E_VENUE_UNREACHABLE", { venue, message: `${c} did not answer: the wallet's allowance to ${NAME}'s contract could not be read, so the swap was not built again` });
        if (allowed < ok.fromAmount) return no("E_ACCOUNT_REQUOTE", { venue, message: `the wallet allows ${NAME}'s contract ${formatUnits(allowed, from.decimals)} ${from.symbol}, and the fresh route spends ${formatUnits(ok.fromAmount, from.decimals)}: take the order back and place it again. Nothing was prepared`, detail: { allowed: allowed.toString(), spends: ok.fromAmount.toString() } });
      } else if (allowed === undefined || allowed < ok.fromAmount) {
        const approve = (n: bigint): WalletTx => ({ chainId: id, chainIdHex, from: owner, to: from.address, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [diamond, n] }), value: "0x0", what: "approve" });
        // a token that takes a new allowance only from zero (Ethereum's USDT): LI.FI says `approvalReset`, and the SDK sets it to zero first
        if (est.approvalReset === true && (allowed === undefined || allowed > 0n)) walletTxs.push(approve(0n));
        // a buy's approval covers the most the order may cost (its size at the price it is held to), not just this quote's cost: the swap
        // built again after the approval may cost a little more, still inside the order, and needs no second approval
        const most = buy ? parseUnits((Math.floor(qty * bound * 10 ** from.decimals) / 10 ** from.decimals).toFixed(from.decimals), from.decimals) : ok.fromAmount;
        walletTxs.push(approve(most > ok.fromAmount ? most : ok.fromAmount));
      }
    }
    // the gas LI.FI's simulation says the route needs (`transactionRequest.gasLimit`, the same as `gasCosts[].limit`): the wallet is given it,
    // as LI.FI's own SDK does. An approval's gas is left to the wallet, which estimates it
    const gasLimit = big(tx.gasLimit) ?? big(arr(est.gasCosts)[0]?.limit);
    walletTxs.push({ chainId: id, chainIdHex, from: owner, to: getAddress(str(tx.to)), data: str(tx.data) as Hex, value: `0x${ok.value.toString(16)}`, ...(gasLimit !== undefined && gasLimit > 0n ? { gas: `0x${gasLimit.toString(16)}` as Hex } : {}), what: "swap" });
    const gasUsd = arr(est.gasCosts).reduce((s, g) => s + num(g.amountUSD), 0);
    const state: OrderState = {
      ref: "",
      status: "pending",
      filledQty: 0,
      walletTxs,
      native: {
        clientId: o.clientId,
        route: str(quote.id),
        tool: str(quote.tool),
        transactionId: str(quote.transactionId),
        chain: c,
        sell: { token: from.symbol, address: from.address, amount: formatUnits(ok.fromAmount, from.decimals) },
        buy: { token: to.symbol, address: to.address, expected: formatUnits(big(est.toAmount) ?? 0n, to.decimals), least: formatUnits(ok.minOut, to.decimals) },
        ...(est.fromAmountUSD ? { fromAmountUSD: str(est.fromAmountUSD) } : {}),
        ...(est.toAmountUSD ? { toAmountUSD: str(est.toAmountUSD) } : {}),
        worstPrice: bound,
        gasLimit: str(tx.gasLimit),
        gasUsd: Number(gasUsd.toFixed(4)),
        approvals: walletTxs.length - 1,
        ...(base.issuer ? { issuer: ISSUERS[base.issuer].issuer } : {}),
        ...(again ? { requoted: true } : {}),
      },
    };
    return { state, base, usdc, transactionId: str(quote.transactionId) as Hex, bound };
  };

  /** The transaction the wallet says it sent, read back from the chain and held to the swap the account built: the same sender, contract,
   * call, coin and chain, or it is not this order's and is not followed. Looked for a few times a few seconds apart: the endpoint this
   * process reads may not yet have seen what the wallet sent through another one */
  const judge = async (hash: Hex, want: WalletTx): Promise<true | Refusal> => {
    const c = CHAIN_BY_ID.get(want.chainId);
    if (!c || !DEX_CHAINS.includes(c)) return no("E_VENUE_REJECTED", { venue, message: `the swap built for this order is for chain ${want.chainId}, not one swapped on here: ${hash} is not followed` });
    const notIt = (why: string[]): Refusal => no("E_VENUE_REJECTED", { venue, message: `transaction ${hash} is not this order's swap: ${why.join("; ")}. The order still waits for your wallet`, native: { hash, chain: c } });
    // the chain's endpoint not answering, or refusing this network, in its words: that is not "not on chain yet"
    let unanswered: Refusal | undefined;
    for (let i = 0; i < SEEN_TRIES; i++) {
      if (i) await pause(SEEN_MS);
      let t: SentTx | undefined;
      let rc: Mined | undefined;
      try {
        t = chain.transaction ? await chain.transaction(c, hash) : undefined;
        rc = t ? undefined : await chain.receipt(c, hash);
        unanswered = undefined;
      } catch (err) {
        unanswered = isRefusal(err) ? err : no("E_VENUE_UNREACHABLE", { venue, message: `${c} did not answer` });
        // a place rule, an edge, or a wait the endpoint named will not end within these few seconds: not asked again now
        if (unanswered.code === "E_VENUE_GEOBLOCKED" || (unanswered.native as { until?: unknown } | undefined)?.until !== undefined) break;
        continue;
      }
      if (t) {
        const why = [
          ...(same(t.from, want.from) ? [] : ["it is from another address"]),
          ...(t.to && same(t.to, want.to) ? [] : [`it goes to another address than ${want.to}`]),
          ...(same(t.data, want.data) ? [] : ["it makes another call than the swap built"]),
          ...(t.value === (big(want.value) ?? 0n) ? [] : ["it sends another amount of the chain's own coin"]),
          ...(t.chainId === undefined || t.chainId === want.chainId ? [] : [`it is for chain ${t.chainId}, not ${want.chainId}`]),
        ];
        return why.length ? notIt(why) : true;
      }
      if (rc) {
        // a reader that cannot read the transaction itself: its receipt (the sender, the contract) and LI.FI's own log of the swap, with the
        // id written into this swap's call, paying this wallet
        const why = [...(same(rc.from, want.from) ? [] : ["it is from another address"]), ...(rc.to && same(rc.to, want.to) ? [] : [`it goes to another address than ${want.to}`])];
        if (why.length) return notIt(why);
        if (rc.status !== "success") return notIt(["it reverted, and without its call nothing ties it to this order"]);
        const id = swapIdOf(want.data);
        const logged =
          id !== undefined &&
          rc.logs.some((l) => {
            if (!same(l.address, diamondOn(c)) || !same(l.topics[0], SWAP_DONE_TOPIC)) return false;
            try {
              const e = decodeEventLog({ abi: SWAP_DONE, data: l.data, topics: l.topics as [Hex, ...Hex[]] }).args;
              return same(e.transactionId, id) && same(e.receiver, owner);
            } catch {
              return false;
            }
          });
        return logged ? true : notIt([`${NAME}'s contract logged no swap with this order's id to this wallet in it`]);
      }
    }
    if (unanswered) return no("E_VENUE_UNREACHABLE", { venue, message: `${unanswered.message}: transaction ${hash} could not be held to this order's swap, so the order still waits for your wallet. Tell the account the hash again once ${c} can be read`, native: { hash, chain: c, unanswered: true } });
    return no("E_VENUE_UNREACHABLE", { venue, message: `${c} does not show transaction ${hash} yet, so it could not be held to this order's swap: the order still waits for your wallet. Tell the account the hash again in a minute`, native: { hash, chain: c } });
  };

  return {
    can: req.proven !== undefined,
    ...(req.proven === undefined ? { whyNot: watched } : {}),
    what: `tokens on ${DEX_CHAINS.join(", ")}, tokenised shares among them (Robinhood Stock Tokens, Ondo Stocks, xStocks)`,

    /** a few letters of a symbol or a name; "RWA", or an issuer's name, finds the tokens issuers stand behind. To start from (nothing typed),
     * only what LI.FI prices and takes orders; a token an issuer lists and LI.FI's list leaves out is found by its symbol, and priced when it
     * is opened */
    async markets(query) {
      const l = await list();
      if (isRefusal(l)) return l;
      const q = query.trim().toUpperCase();
      if (!q) return pick(l.markets.filter((m) => m.price !== undefined && m.open), "");
      if (q === "RWA" || q === "RWAS") return l.markets.filter((m) => m.category === RWA_CATEGORY).slice(0, 20);
      const byIssuer = q.length >= 4 ? l.markets.filter((m) => m.category === RWA_CATEGORY && (m as RwaMarket).issuer.toUpperCase().includes(q)) : [];
      const picked = pick(l.markets, query);
      return [...picked, ...byIssuer.filter((m) => !picked.includes(m))].slice(0, 20);
    },

    async market(symbol) {
      const hit = await lookup(symbol);
      if (isRefusal(hit)) return hit;
      const issuer = await confirm(hit.base);
      if (isRefusal(issuer)) return issuer;
      // the price now, not the list's: GET /v1/token
      const r = await call(`/token?chain=${chainId(hit.chain)}&token=${hit.base.address}`);
      if (isRefusal(r)) return r;
      if (r.status !== 200) return lifiSaid(r);
      if (r.body === undefined || typeof r.body !== "object") return notLifi(r, "its token's price");
      const t = obj(r.body);
      if (!same(t.address, hit.base.address) || num(t.decimals) !== hit.base.decimals) return no("E_VENUE_REJECTED", { venue, message: `${NAME} answered another token for ${symbol}`, native: { asked: hit.base.address, answered: str(t.address) } });
      if (str(t.verificationStatus) === "flagged") return badOrder(venue, NAME, `${NAME} flags ${hit.base.symbol} on ${hit.chain}: it is not traded from here`);
      let m = marketOf(hit.base, num(t.priceUSD));
      if (issuer.said) m = { ...m, note: `${issuer.said} · ${m.note}` };
      if (issuer.closed) m = { ...m, open: false, note: `${issuer.closed} · ${m.note}` };
      if (m.price !== undefined) valued.set(m.symbol.toUpperCase(), m.price);
      return m;
    },

    async place(o: OrderRequest) {
      if (req.proven === undefined) return no("E_VENUE_PERMISSION", { venue, message: watched });
      if (o.type !== "market") return badOrder(venue, NAME, "a swap is a market order: a DEX keeps no book, so no limit order can rest there");
      const key = keyOf(o);
      tidy();
      const held = routes.get(o.clientId);
      if (held) {
        if (held.key !== key) return no("E_ACCOUNT_BAD_ACTION", { venue, message: `${o.clientId} was already used for another order` });
        if (now() - held.at < QUOTE_MS) return held.state;
      }
      const b = await build(o);
      if (isRefusal(b)) return b;
      routes.set(o.clientId, { key, at: now(), clientId: o.clientId, ...b });
      return b.state;
    },

    /** the approval is on chain: the swap built again from a fresh quote, held to the same order — its size, its side, its worst price and
     * the price the first swap was held to — so a slow approval does not leave the wallet a stale swap that reverts */
    async requote(o: OrderRequest) {
      if (req.proven === undefined) return no("E_VENUE_PERMISSION", { venue, message: watched });
      if (o.type !== "market") return badOrder(venue, NAME, "a swap is a market order: a DEX keeps no book, so no limit order can rest there");
      const key = keyOf(o);
      tidy();
      const held = routes.get(o.clientId);
      if (held && held.key !== key) return no("E_ACCOUNT_BAD_ACTION", { venue, message: `${o.clientId} was already used for another order` });
      const b = await build(o, { bound: held?.bound });
      if (isRefusal(b)) return b;
      routes.set(o.clientId, { key, at: now(), clientId: o.clientId, ...b });
      return b.state;
    },

    /** the hash the wallet sent, held on chain to the swap the account built (`expected`; else the one built here for the order) before it is
     * followed: another transaction is refused, and the order keeps waiting for its wallet */
    async sent(ref, hash, expected) {
      if (!HASH.test(hash)) return no("E_ACCOUNT_BAD_ACTION", { venue, message: "a transaction hash is 0x and sixty-four hex digits" });
      // the route the order was built as: by the id it was placed with, or by the swap the account handed the wallet
      const r = routes.get(ref) ?? (expected ? [...routes.values()].find((x) => same(swapOf(x)?.data, expected.data)) : undefined);
      const want = expected ?? (r ? swapOf(r) : undefined);
      if (!want) return no("E_ACCOUNT_ORDER_UNKNOWN", { venue, message: `no swap was built here for ${ref}: there is nothing to hold ${hash} to, so it is not followed` });
      const seen = await judge(hash, want);
      if (isRefusal(seen)) return seen;
      if (r) byHash.set(hash.toLowerCase(), r);
      return { ref: hash, status: "pending", filledQty: 0, native: { sent: hash, ...(r ? { clientId: r.clientId, transactionId: r.transactionId } : {}) } };
    },

    status,

    /** nothing at LI.FI to cancel: before the wallet sends, the order is dropped; after, the chain decides, and only the wallet can replace it */
    async cancel(ref, symbol) {
      if (!ref) return { ref: "", status: "canceled", filledQty: 0, native: { canceled: "before the wallet sent it" } };
      const s = await status(ref, symbol);
      if (isRefusal(s) || DONE.has(s.status)) return s;
      return no("E_VENUE_REJECTED", { venue, message: `${NAME} has no cancel: the wallet sent ${ref}, and on chain it either goes through whole or reverts. Only the wallet can replace it (the same nonce) before it is mined`, native: s.native });
    },
  };
}
