/** TRADING from the user's own wallet: token swaps on six EVM chains, routed by LI.FI and sent by the WALLET.
 *
 * LI.FI (li.quest/v1) is a keyless aggregator: it finds a route across a chain's DEXes and answers one transaction for the wallet to send.
 * This process never signs and never sends a transaction. It asks LI.FI, checks what LI.FI answered, and hands the wallet, in order:
 *
 *   an approval        `approve(LI.FI's contract, exactly the amount sold)` on the token sold, when the wallet has not allowed enough
 *   the swap           the transaction LI.FI built, checked before anyone sees it: it goes to LI.FI's own contract, it pays THIS wallet, it
 *                      spends exactly what LI.FI quoted, and the least it pays is the least LI.FI quoted
 *
 *   markets            GET /v1/tokens (kept five minutes): a few well-known tokens first, then any token LI.FI verifies, found by symbol
 *   a market           GET /v1/token: LI.FI's price in dollars, now
 *   a sell             GET /v1/quote with fromAmount: exactly this much of the token, for USDC
 *   a buy              GET /v1/quote/toAmount: this much of the token, for the USDC LI.FI works out
 *   the swap again     once the approval is on chain: a fresh quote, held to the same order (its size, side and worst price), the swap alone
 *   the hash sent      read back from the chain and held to the swap that was built (sender, contract, call, coin, chain) before it is followed
 *   what became of it  GET /v1/status by the hash the wallet sent; the chain's own receipt while LI.FI has not seen it
 *
 * A market order's worst price is kept on chain: the least a route pays (`toAmountMin`, enforced by LI.FI's contract) is held to it, and to
 * 2% from LI.FI's price, whichever is tighter. A DEX has no price grid, so nothing is rounded.
 *
 * Every market is a token against the chain's USDC: `WETH/USDC@Base`. A swap is one transaction: it goes through whole or reverts. There is
 * no book, no limit order, and nothing to call back once the wallet has sent it.
 *
 * LI.FI's terms (2025-09-04) exclude sanctioned parties and places, and US persons: the market note says so, and a refusal by LI.FI on
 * those grounds is reported as LI.FI's own rule.
 */
import { decodeEventLog, decodeFunctionData, encodeFunctionData, erc20Abi, formatUnits, getAddress, parseAbi, parseUnits, toEventSelector, type Hex } from "viem";
import { isRefusal, type Refusal } from "../../core/errors.ts";
import { no } from "../refuse.ts";
import { CHAIN_BY_ID, CHAINS, STABLECOINS, type ChainName, type ChainReader } from "./chain.ts";
import { DONE, badOrder, floorTo, inDollars, pick, plain, type LiveTrader, type Market, type OrderRequest, type OrderState } from "./trade.ts";
import { REGION, isStable, num, redact, unreachable, venueSaidNo, type Http, type HttpReply } from "./types.ts";

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
/** a transaction the wallet has just sent may not yet have reached the endpoint this process reads the chain through: it is looked for this
 * many times, this far apart, before the account says it cannot see it */
const SEEN_TRIES = 5;
const SEEN_MS = 2_000;
const NATIVE: Hex = "0x0000000000000000000000000000000000000000";
/** LI.FI's contract on all six chains (GET /v1/chains `diamondAddress`, read 2026-10-05): the swap goes to it and the approval names it. It is
 * pinned rather than taken from LI.FI's answer, because an approval is the one thing a forged answer could abuse; if LI.FI ever moves it,
 * swaps are refused here, never sent elsewhere. */
export const LIFI_DIAMOND: Hex = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";
/** the chains swapped on: the ones in chain.ts that LI.FI serves AND that have a USDC to price against (Robinhood Chain has none here) */
export const DEX_CHAINS: ChainName[] = ["Ethereum", "Optimism", "BNB Chain", "Polygon", "Base", "Arbitrum"];

/** LI.FI's same-chain swaps (GenericSwapFacetV3, github.com/lifinance/contracts): the only calls handed to a wallet from here */
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

const NOTE = "swapped through LI.FI (its fee 0.25%) at up to 0.5% slippage, sent by your wallet, which pays the network fee; LI.FI's terms exclude US persons and sanctioned places";

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
}

interface Listed {
  at: number;
  /** by the account's symbol in capitals */
  bySymbol: Map<string, { base: Tok; usdc: Tok }>;
  markets: Market[];
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

const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as Obj[]) : []);
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const big = (v: unknown): bigint | undefined => (/^(0x[0-9a-fA-F]+|\d+)$/.test(str(v)) ? BigInt(str(v)) : undefined);
const same = (a: unknown, b: string): boolean => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
const HASH = /^0x[0-9a-fA-F]{64}$/;
const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const chainId = (c: ChainName): number => CHAINS[c].chain.id;
const usdcOn = (c: ChainName): Hex => STABLECOINS.find((t) => t.chain === c && t.asset === "USDC")!.address;
/** a size in at most eight places, or the token's own decimals when it has fewer, so the size the owner signs is the size sent */
const stepOf = (decimals: number): number => 10 ** -Math.min(decimals, 8);

/** `WETH/USDC@Base` → its parts; the chain is one of the six */
function parseSymbol(venue: string, symbol: string): { base: string; quote: string; chain: ChainName } | Refusal {
  const m = /^(.+)\/(.+)@(.+)$/.exec(symbol.trim());
  const chain = m ? DEX_CHAINS.find((c) => c.toLowerCase() === m[3]!.trim().toLowerCase()) : undefined;
  if (!m || !chain) return no("E_ACCOUNT_BAD_ACTION", { venue, message: `a market here is a token against the chain's USDC: <TOKEN>/USDC@<chain>, on ${DEX_CHAINS.join(", ")} (for example WETH/USDC@Base)` });
  const quote = m[2]!.trim();
  if (!inDollars(quote)) return no("E_ACCOUNT_UNPRICED", { venue, message: `${symbol} is priced in ${quote}: the account trades markets priced in dollars, so that every limit means dollars` });
  if (quote.toUpperCase() !== "USDC") return no("E_ACCOUNT_BAD_ACTION", { venue, message: `swaps here are against the chain's USDC: ${m[1]!.trim()}/USDC@${chain}` });
  return { base: m[1]!.trim(), quote: "USDC", chain };
}

/** LI.FI's answer when it is not a yes, as one of the account's refusals, with LI.FI's own words */
function lifiNo(venue: string, r: HttpReply): Refusal {
  const b = obj(r.body);
  const said = redact(r.text.replace(/\s+/g, " ").trim().slice(0, 220), []);
  const native = { status: r.status, said };
  if (r.status === 451 || REGION.test(r.text)) return venueSaidNo(venue, NAME, r.status, r.text);
  // LI.FI asks no key, so a 403 is not about one (docs.li.fi/api-reference/api-key-security). It is the likely shape of LI.FI refusing where
  // the request comes from — not observed, so read conservatively: as LI.FI's own rule, never as something to get around
  if (r.status === 403) return no("E_VENUE_GEOBLOCKED", { venue, message: `${NAME} refused this machine (HTTP 403): that is its own rule — its terms exclude US persons and sanctioned places — and the account does not look for a way around it`, native });
  if (r.status === 400) return { ...badOrder(venue, NAME, str(b.message) || "it did not take the request as written"), native };
  if (r.status === 404 && num(b.code) === 1002) {
    // no route: `errors` is { filteredOut: [{ reason }], failed: [{ subpaths: { path: [{ tool, code, message }] } }] }, or a flat list of the same
    const errors = b.errors;
    const tools = Array.isArray(errors) ? arr(errors) : arr(obj(errors).failed).flatMap((f) => Object.values(obj(f.subpaths)).flatMap(arr));
    const reasons = [...arr(obj(errors).filteredOut).map((f) => str(f.reason)), ...tools.map((t) => `${str(t.tool)}: ${str(t.code)}${t.message ? ` (${str(t.message)})` : ""}`)].filter(Boolean);
    const codes = tools.map((t) => str(t.code));
    if (codes.length && codes.every((c) => c === "RPC_ERROR" || c === "TOOL_TIMEOUT" || c === "RATE_LIMIT_EXCEEDED")) return no("E_VENUE_UNREACHABLE", { venue, message: `${NAME} could not reach the DEXes on that chain just now: try again in a minute`, native: { ...native, codes } });
    return { ...badOrder(venue, NAME, `no route for this swap${reasons.length ? `: ${[...new Set(reasons)].slice(0, 3).join("; ")}` : ""}`), native: { ...native, codes } };
  }
  if (r.status === 429) return no("E_VENUE_UNREACHABLE", { venue, message: `${NAME} is rate-limiting this machine: without a key it answers 75 quotes in two hours. Try again later`, native });
  return venueSaidNo(venue, NAME, r.status, r.text);
}

/** the swap LI.FI answered, held to what was asked before a wallet is shown it (the checks are the ones in LI.FI's own contract) */
function verifyRoute(q: Obj, want: { chainId: number; owner: Hex; from: Hex; to: Hex }): { fromAmount: bigint; minOut: bigint; value: bigint } | string {
  const tx = obj(q.transactionRequest);
  const action = obj(q.action);
  const est = obj(q.estimate);
  const fromAmount = big(action.fromAmount);
  const minOut = big(est.toAmountMin);
  if (num(tx.chainId) !== want.chainId || num(action.fromChainId) !== want.chainId || num(action.toChainId) !== want.chainId) return "it is for another chain";
  if (!same(tx.to, LIFI_DIAMOND)) return "it is not addressed to LI.FI's own contract";
  if (want.from !== NATIVE && !same(est.approvalAddress, LIFI_DIAMOND)) return "it asks the wallet to approve a spender that is not LI.FI's own contract";
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

  const call = async (path: string, timeoutMs = 10_000): Promise<HttpReply | Refusal> => {
    try {
      return await http(`${LIFI}${path}`, { headers: { accept: "application/json" }, timeoutMs });
    } catch (err) {
      return unreachable(venue, NAME, err);
    }
  };

  const marketOf = (t: Tok, price: number | undefined): Market => ({ symbol: `${t.symbol}/USDC@${t.chain}`, name: `${t.name} on ${t.chain}`, kind: "token", base: t.symbol, quote: "USDC", price: price !== undefined && price > 0 ? price : undefined, qtyStep: stepOf(t.decimals), minNotional: 1, open: true, note: NOTE, types: ["market"] });

  /** LI.FI's token list for the six chains, kept five minutes. A token is found by its symbol only when exactly one token on that chain
   * carries it (LI.FI says symbols are not unique: Base has a USDT and a USD₮0), and never when LI.FI flags it */
  const list = async (): Promise<Listed | Refusal> => {
    if (listed && now() - listed.at < LIST_MS) return listed;
    const r = await call(`/tokens?chains=${DEX_CHAINS.map(chainId).join(",")}`, 20_000);
    if (isRefusal(r)) return r;
    if (r.status !== 200) return lifiNo(venue, r);
    // the answer is { tokens: { "<chain id>": [Token] } } (docs.li.fi shows the chain ids at the top; what LI.FI sends wraps them)
    const all = obj(obj(r.body).tokens ?? r.body);
    const bySymbol = new Map<string, { base: Tok; usdc: Tok }>();
    const known: Market[] = [];
    const rest: Market[] = [];
    const found = new Map<ChainName, { usdc: Tok; find: (symbol: string) => Tok | undefined; tokens: Tok[] }>();
    for (const c of DEX_CHAINS) {
      const tokens = arr(all[String(chainId(c))])
        .filter((t) => str(t.verificationStatus) !== "flagged" && /^0x[0-9a-fA-F]{40}$/.test(str(t.address)) && Number.isInteger(t.decimals))
        .map((t): Tok => ({ chain: c, address: getAddress(str(t.address)), symbol: str(t.symbol), name: str(t.name) || str(t.symbol), decimals: Number(t.decimals), priceUSD: num(t.priceUSD), verified: str(t.verificationStatus) === "verified" }));
      const usdc = tokens.find((t) => same(t.address, usdcOn(c)));
      if (!usdc) continue;
      const find = (symbol: string): Tok | undefined => {
        const s = symbol.toUpperCase();
        if (s === CHAINS[c].coin) return tokens.find((t) => t.address === NATIVE);
        const named = tokens.filter((t) => t.address !== NATIVE && t.symbol.toUpperCase() === s);
        if (named.length === 1) return named[0];
        const verified = named.filter((t) => t.verified);
        return verified.length === 1 ? verified[0] : undefined;
      };
      found.set(c, { usdc, find, tokens });
    }
    const add = (t: Tok, usdc: Tok, into: Market[]) => {
      const m = marketOf(t, t.priceUSD);
      const key = m.symbol.toUpperCase();
      if (bySymbol.has(key) || isStable(t.symbol) || t.symbol.includes("/") || t.symbol.includes("@")) return;
      bySymbol.set(key, { base: t, usdc });
      if (m.price !== undefined) into.push(m);
    };
    for (const [c, symbol] of WELL_KNOWN) {
      const f = found.get(c);
      const t = f?.find(symbol);
      if (f && t) add(t, f.usdc, known);
    }
    // then any token LI.FI verifies, by a symbol that names one token on its chain
    for (const [, f] of found) for (const t of f.tokens) if (t.verified && f.find(t.symbol) === t) add(t, f.usdc, rest);
    listed = { at: now(), bySymbol, markets: [...known, ...rest] };
    return listed;
  };

  const lookup = async (symbol: string): Promise<{ base: Tok; usdc: Tok; chain: ChainName } | Refusal> => {
    const p = parseSymbol(venue, symbol);
    if (isRefusal(p)) return p;
    const l = await list();
    if (isRefusal(l)) return l;
    const hit = l.bySymbol.get(`${p.base}/USDC@${p.chain}`.toUpperCase());
    if (!hit) return no("E_ACCOUNT_BAD_ACTION", { venue, message: `${NAME} lists no single verified token ${p.base} on ${p.chain}: search the markets for its symbol` });
    return { ...hit, chain: p.chain };
  };

  /** what the wallet holds of a token on a chain, in whole tokens */
  const holds = async (c: ChainName, t: { address: Hex; symbol: string }): Promise<number | Refusal> => {
    const r = t.address === NATIVE ? await chain.native(owner, [c]) : await chain.tokens(owner, [{ chain: c, asset: t.symbol, address: t.address }]);
    if (r.failed.length) return no("E_VENUE_UNREACHABLE", { venue, message: `${c} did not answer: the wallet's ${t.symbol} could not be read, so nothing was prepared` });
    return r.rows[0]?.amount ?? 0;
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

  /** an order filled: dollars per base unit, USDC counted one for one; LI.FI's fee is inside the amounts, so it is inside the price too */
  const filled = (ref: string, buy: boolean, baseAmt: bigint, baseDec: number, usdcAmt: bigint, usdcDec: number, native: unknown, feeUsd?: number): OrderState => {
    const qty = Number(formatUnits(baseAmt, baseDec));
    const dollars = Number(formatUnits(usdcAmt, usdcDec));
    return { ref, status: "filled", filledQty: qty, avgPrice: qty > 0 ? dollars / qty : undefined, ...(feeUsd !== undefined ? { feeUsd } : {}), native: { side: buy ? "buy" : "sell", ...obj(native) } };
  };

  /** the chain's own answer: not mined yet, reverted, or LI.FI's contract saying what this wallet received */
  const fromReceipt = async (ref: Hex, c: ChainName, known: Route | undefined, base: Tok | undefined, lifi: unknown): Promise<OrderState> => {
    const pending: OrderState = { ref, status: "pending", filledQty: 0, native: { lifi, chain: "not mined yet" } };
    const rc = await chain.receipt(c, ref);
    if (!rc) return pending;
    if (rc.status === "reverted") return { ref, status: "rejected", filledQty: 0, native: { lifi, receipt: "reverted: nothing moved but the network fee" } };
    const usdc = usdcOn(c);
    for (const l of rc.logs) {
      if (!same(l.address, LIFI_DIAMOND) || !same(l.topics[0], SWAP_DONE_TOPIC)) continue;
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
    const known = byHash.get(ref.toLowerCase());
    let base = known?.base;
    if (!base) {
      const hit = await lookup(symbol);
      if (!isRefusal(hit)) base = hit.base;
    }
    const r = await call(`/status?txHash=${ref}&fromChain=${chainId(c)}&toChain=${chainId(c)}`);
    let lifi: unknown = isRefusal(r) ? { unreachable: r.message } : { status: r.status, said: redact(r.text.replace(/\s+/g, " ").trim().slice(0, 220), []) };
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
        const buy = same(sTok.address, usdcOn(c));
        const baseTok = buy ? rTok : sTok;
        const moved = { ...said, receiving: { token: str(rTok.symbol), amount: str(receiving.amount) } };
        // REFUNDED: the money came back, nothing filled
        if (sub === "REFUNDED") return { ref, status: "canceled", filledQty: 0, native: moved };
        // PARTIAL (the wallet got another token than the one asked), or a swap of other tokens: money DID move, so it is never counted as
        // "nothing filled" (that would hand an agent back limit it spent). The chain's receipt decides, and without a swap of this market in
        // it the order stays pending
        if ((sub && sub !== "COMPLETED") || (!buy && !same(rTok.address, usdcOn(c))) || (base && !same(baseTok.address, base.address))) return fromReceipt(ref as Hex, c, known, base, moved);
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
    const id = chainId(c);
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
    if (r.status !== 200) return lifiNo(venue, r);
    const quote = obj(r.body);
    const ok = verifyRoute(quote, { chainId: id, owner, from: from.address, to: to.address });
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
    const counted = valued.get(`${base.symbol}/USDC@${c}`.toUpperCase()) ?? quoted;
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
      if (have + 1e-12 < spend) return short(c, "USDC", have, spend);
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
      const allowed = await chain.uint(c, from.address, ALLOWANCE, [owner, LIFI_DIAMOND]);
      if (again) {
        // the approval is on chain: the swap goes alone, so the wallet must already allow LI.FI's contract what the fresh route spends
        if (allowed === undefined) return no("E_VENUE_UNREACHABLE", { venue, message: `${c} did not answer: the wallet's allowance to ${NAME}'s contract could not be read, so the swap was not built again` });
        if (allowed < ok.fromAmount) return no("E_ACCOUNT_REQUOTE", { venue, message: `the wallet allows ${NAME}'s contract ${formatUnits(allowed, from.decimals)} ${from.symbol}, and the fresh route spends ${formatUnits(ok.fromAmount, from.decimals)}: take the order back and place it again. Nothing was prepared`, detail: { allowed: allowed.toString(), spends: ok.fromAmount.toString() } });
      } else if (allowed === undefined || allowed < ok.fromAmount) {
        const approve = (n: bigint): WalletTx => ({ chainId: id, chainIdHex, from: owner, to: from.address, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [LIFI_DIAMOND, n] }), value: "0x0", what: "approve" });
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
    for (let i = 0; i < SEEN_TRIES; i++) {
      if (i) await pause(SEEN_MS);
      const t = chain.transaction ? await chain.transaction(c, hash) : undefined;
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
      const rc = await chain.receipt(c, hash);
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
            if (!same(l.address, LIFI_DIAMOND) || !same(l.topics[0], SWAP_DONE_TOPIC)) return false;
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
    return no("E_VENUE_UNREACHABLE", { venue, message: `${c} does not show transaction ${hash} yet, so it could not be held to this order's swap: the order still waits for your wallet. Tell the account the hash again in a minute`, native: { hash, chain: c } });
  };

  return {
    can: req.proven !== undefined,
    ...(req.proven === undefined ? { whyNot: watched } : {}),
    what: `tokens on ${DEX_CHAINS.join(", ")}`,

    async markets(query) {
      const l = await list();
      if (isRefusal(l)) return l;
      return pick(l.markets, query);
    },

    async market(symbol) {
      const hit = await lookup(symbol);
      if (isRefusal(hit)) return hit;
      // the price now, not the list's: GET /v1/token
      const r = await call(`/token?chain=${chainId(hit.chain)}&token=${hit.base.address}`);
      if (isRefusal(r)) return r;
      if (r.status !== 200) return lifiNo(venue, r);
      const t = obj(r.body);
      if (!same(t.address, hit.base.address) || num(t.decimals) !== hit.base.decimals) return no("E_VENUE_REJECTED", { venue, message: `${NAME} answered another token for ${symbol}`, native: { asked: hit.base.address, answered: str(t.address) } });
      if (str(t.verificationStatus) === "flagged") return badOrder(venue, NAME, `${NAME} flags ${hit.base.symbol} on ${hit.chain}: it is not traded from here`);
      const m = marketOf(hit.base, num(t.priceUSD));
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

