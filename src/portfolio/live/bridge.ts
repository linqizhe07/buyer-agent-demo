/** MOVING the user's dollars from one chain to another, from the user's own wallet: routed by LI.FI, checked here, sent by the WALLET.
 *
 * A bridge is not a swap. The wallet sends one transaction on the chain the money leaves; the money arrives on the other chain later,
 * paid by a third party — a relayer from its own capital (Across), a pool (Stargate), or Circle minting what was burned (CCTP). So there
 * are four endings, not two: delivered, delivered as another token, refunded, or still on its way (for days, now and then). This process
 * never signs and never sends: it asks LI.FI, checks what LI.FI answered against the calldata itself, and hands the wallet, in order:
 *
 *   an approval        `approve(LI.FI's contract, exactly the amount sent)` on the stablecoin, when the wallet has not allowed enough
 *   the transfer       the transaction LI.FI built, checked before anyone sees it (below)
 *
 *   routes             GET /v1/quote twice, `order=CHEAPEST` and `order=FASTEST` (the default order IS cheapest, so there is no third ask):
 *                      two real choices, each ready to sign. `/v1/advanced/routes` is a POST and answers no transaction, so it is not used
 *   the hash sent      read back from the chain and held to the transaction that was built (sender, contract, call, coin, chain)
 *   what became of it  GET /v1/status by the hash; the chain's own receipt while LI.FI has not seen it
 *
 * What a route must show before a wallet sees it, every one of these read from the calldata, not from LI.FI's summary:
 *   · it goes to LI.FI's own contract, for these two chains, from this wallet, of exactly this amount;
 *   · it pays exactly the address asked (`to`): in LI.FI's own record of the transfer AND in the bridge's own recipient field, which the
 *     bridge's contract enforces on chain. Only bridges whose contract does so are asked for at all (`allowBridges`): Across, Stargate
 *     (fast mode) and Circle's CCTP (through Polymer or Celer). Relay and LayerSwap deliver by an off-chain order, where the recipient in
 *     the calldata is LI.FI's word only; Mayan's least amount sits inside data this file does not decode. They are not offered;
 *   · no call on the destination chain (`allowDestinationCall=false`): the bridge pays the address itself, never LI.FI's receiver contract,
 *     so no swap after the bridge can fail ("delivered as another token" is still possible on Stargate, whose pools can pay out another
 *     dollar stablecoin when short — LI.FI's intermediate-tokens guide — and bridgeStatus says so);
 *   · the least that arrives, as the bridge's own contract holds it (Across: what is bridged × `outputAmountMultiplier`, the figure its
 *     contract recomputes; Stargate's `minAmountLD`; Polymer's CCTP amount less its capped fees), is at least 97% of what was sent, after
 *     any fee paid on top in the chain's coin. Celer's CCTP is the exception: its fee is set in Celer's own contract, not in the call, so
 *     its least is LI.FI's, held under what is burned less the call's fee cap;
 *   · the coin it carries is exactly the fees LI.FI says are paid on top (Stargate's LayerZero fee), and nothing else.
 *
 * Robinhood Chain (4663) is bridged to and from in USDG, Paxos's dollar there (dex.ts USDG_ROBINHOOD), through Across — the one bridge
 * here LI.FI routes to it — and through LI.FI's own contract on THAT chain, which is not the one on the others (dex.ts diamondOn): every
 * check above names the contract of the chain the money leaves. Where no bridge carries a transfer, LI.FI's own reason is the refusal.
 *
 * LI.FI answers 75 quotes in two hours to a machine without a key, shared with the swaps (dex.ts): one set of routes costs two.
 */
import { decodeEventLog, decodeFunctionData, encodeFunctionData, erc20Abi, formatUnits, getAddress, isAddress, pad, parseAbi, parseUnits, toEventSelector, type Hex } from "viem";
import { isRefusal, type Refusal } from "../../core/errors.ts";
import { no } from "../refuse.ts";
import { CHAIN_BY_ID, CHAINS, STABLECOINS, type ChainName, type ChainReader, type Mined } from "./chain.ts";
import { byParty, diamondOn, lifiHold, lifiHolding, USDG_ROBINHOOD } from "./dex.ts";
import { edgeRefused, edgeWords, REGION, isStable, notTheApi, notTheApiWords, num, redact, unreachable, venueSaidNo, type Http, type HttpReply } from "./types.ts";
import { tokenOn, type WalletTx } from "./writes.ts";

const LIFI = "https://li.quest/v1";
const NAME = "LI.FI";
/** sent with every quote: LI.FI writes it into the transfer's calldata and its on-chain log, so the account can find its own transfers */
const INTEGRATOR = "account-demo";
/** used by the pool and solver routes only (Stargate here); Across and CCTP deliver an exact amount */
const SLIPPAGE = 0.005;
/** the least share of the amount sent that must arrive, at worst */
const FLOOR = 0.97;
/** an Across route whose fill deadline is closer than this is stale: asked again rather than handed on */
const DEADLINE_ROOM_S = 120;
const ZERO: Hex = "0x0000000000000000000000000000000000000000";
const ZERO32: Hex = `0x${"0".repeat(64)}`;
/** LI.FI's fee contract (github.com/lifinance/contracts deployments, the same on all six chains): the first leg of every quote pays LI.FI's fee through it */
const FEE_FORWARDER: Hex = "0xCE40449B773a3E6E5e769ADb4e567179d4828cbd";
/** LI.FI's stand-in receiver for a transfer to a non-EVM chain (LiFiData.sol) */
const NON_EVM: Hex = "0x11f111f111f111F111f111f111F111f111f111F1";
const HASH = /^0x[0-9a-fA-F]{64}$/;
const ALLOWANCE = "function allowance(address owner, address spender) view returns (uint256)";

/** the dollars a bridge carries: the stablecoins the account pays in (chain.ts) and USDG on Robinhood Chain, where Robinhood's Stock Tokens
 * are bought (dex.ts). USDG is not in chain.ts's list because the wallet reads it beside that list already (address.ts): listed twice, it
 * would be read twice */
const BRIDGED = [...STABLECOINS, USDG_ROBINHOOD];
/** the chains that carry a dollar this account bridges */
export const BRIDGE_CHAINS: ChainName[] = [...new Set(BRIDGED.map((s) => s.chain))];
/** a dollar stablecoin on a chain, as a bridge carries it: chain.ts's (writes.ts tokenOn), or USDG on Robinhood Chain */
function dollarOn(asset: string, chain: ChainName): { asset: string; address: Hex } | undefined {
  if (chain === USDG_ROBINHOOD.chain) return asset.toUpperCase() === USDG_ROBINHOOD.asset ? { asset: USDG_ROBINHOOD.asset, address: USDG_ROBINHOOD.address } : undefined;
  return tokenOn(asset, chain);
}
/** where the USDC in chain.ts is Circle's own, so Circle's CCTP burns and mints it (BNB Chain's is Binance-pegged) */
const CCTP_CHAINS: ChainName[] = ["Ethereum", "Optimism", "Polygon", "Base", "Arbitrum"];
/** LayerZero V2 endpoint ids, which Stargate's `dstEid` names (Base's 30184 seen in a live quote; the rest are LayerZero's published ids) */
const LZ_EID: Partial<Record<ChainName, number>> = { Ethereum: 30101, "BNB Chain": 30102, Polygon: 30109, Arbitrum: 30110, Optimism: 30111, Base: 30184 };
/** Stargate V2's asset ids (USDC 1 seen live) */
const STARGATE_ASSET: Record<string, number> = { USDC: 1, USDT: 2 };

type Facet = "AcrossV4" | "Stargate" | "CelerCircleBridge" | "PolymerCCTP";
/** The bridges offered: LI.FI's key → the contract facet that must carry it, a name for people, and how long it took in practice (p90 of
 * LI.FI's completed transfers between these six chains, 2026-10-05: "usually within", next to the route's own estimate) */
const BRIDGES: Record<string, { facet: Facet; name: string; p90Sec: number }> = {
  across: { facet: "AcrossV4", name: "Across", p90Sec: 10 },
  stargateV2: { facet: "Stargate", name: "Stargate", p90Sec: 92 },
  polymerStandard: { facet: "PolymerCCTP", name: "CCTP", p90Sec: 1512 },
  polymer: { facet: "PolymerCCTP", name: "CCTP fast", p90Sec: 42 },
  celercircle: { facet: "CelerCircleBridge", name: "CCTP (Celer)", p90Sec: 1393 },
  celercirclefast: { facet: "CelerCircleBridge", name: "CCTP fast (Celer)", p90Sec: 1094 },
};
const ORDERS = ["CHEAPEST", "FASTEST"] as const;
type Order = (typeof ORDERS)[number];

// ---- LI.FI's bridge calls (github.com/lifinance/contracts, main, read 2026-10-05) ---------------------------------------------------

const BRIDGE_DATA = "(bytes32 transactionId,string bridge,string integrator,address referrer,address sendingAssetId,address receiver,uint256 minAmount,uint256 destinationChainId,bool hasSourceSwaps,bool hasDestinationCall)";
const SWAP_DATA = "(address callTo,address approveTo,address sendingAssetId,address receivingAssetId,uint256 fromAmount,bytes callData,bool requiresDeposit)[]";
const FACET_DATA: Record<Facet, string> = {
  AcrossV4: "(bytes32 receiverAddress,bytes32 refundAddress,bytes32 sendingAssetId,bytes32 receivingAssetId,uint256 outputAmount,uint128 outputAmountMultiplier,bytes32 exclusiveRelayer,uint32 quoteTimestamp,uint32 fillDeadline,uint32 exclusivityParameter,bytes message)",
  Stargate: "(uint16 assetId,(uint32 dstEid,bytes32 to,uint256 amountLD,uint256 minAmountLD,bytes extraOptions,bytes composeMsg,bytes oftCmd) sendParams,(uint256 nativeFee,uint256 lzTokenFee) fee,address refundAddress)",
  CelerCircleBridge: "(uint256 maxFee,uint32 minFinalityThreshold)",
  PolymerCCTP: "(uint256 polymerTokenFee,uint256 maxCCTPFee,bytes32 nonEVMReceiver,bytes32 solanaReceiverATA,uint32 minFinalityThreshold,address refundRecipient,bytes hookData)",
};
/** the only calls handed to a wallet from here: `startBridgeTokensVia<Facet>` and `swapAndStartBridgeTokensVia<Facet>` of the four facets */
export const LIFI_BRIDGE_ABI = parseAbi(
  Object.entries(FACET_DATA).flatMap(([f, t]) => [`function startBridgeTokensVia${f}(${BRIDGE_DATA} _bridgeData,${t} _data)`, `function swapAndStartBridgeTokensVia${f}(${BRIDGE_DATA} _bridgeData,${SWAP_DATA} _swapData,${t} _data)`]) as string[],
);
const FEE_ABI = parseAbi(["function forwardERC20Fees(address token,(address recipient,uint256 amount)[] distributions)", "function forwardNativeFees((address recipient,uint256 amount)[] distributions)"]);
const STARTED = parseAbi([`event LiFiTransferStarted(${BRIDGE_DATA} bridgeData)`]);
/** what LI.FI's contract logs on the sending chain when a transfer starts (0xcba69f43…44f1, seen live) */
export const TRANSFER_STARTED_TOPIC = toEventSelector(STARTED[0]);

export interface BridgeData {
  transactionId: Hex;
  bridge: string;
  integrator: string;
  referrer: Hex;
  sendingAssetId: Hex;
  receiver: Hex;
  minAmount: bigint;
  destinationChainId: bigint;
  hasSourceSwaps: boolean;
  hasDestinationCall: boolean;
}
interface SwapLeg {
  callTo: Hex;
  approveTo: Hex;
  sendingAssetId: Hex;
  receivingAssetId: Hex;
  fromAmount: bigint;
  callData: Hex;
  requiresDeposit: boolean;
}
interface AcrossV4Data {
  receiverAddress: Hex;
  refundAddress: Hex;
  sendingAssetId: Hex;
  receivingAssetId: Hex;
  outputAmount: bigint;
  /** on `swapAndStart…`, what the relayer must deliver is what is bridged × this / 1e18 (and `outputAmount` is thrown away) */
  outputAmountMultiplier: bigint;
  fillDeadline: number;
  message: Hex;
}
/** AcrossFacetV4's MULTIPLIER_BASE */
const MULTIPLIER_BASE = 10n ** 18n;
interface StargateData {
  assetId: number;
  sendParams: { dstEid: number; to: Hex; amountLD: bigint; minAmountLD: bigint; extraOptions: Hex; composeMsg: Hex; oftCmd: Hex };
  fee: { nativeFee: bigint; lzTokenFee: bigint };
  refundAddress: Hex;
}
interface CelerData {
  maxFee: bigint;
  minFinalityThreshold: number;
}
interface PolymerData {
  polymerTokenFee: bigint;
  maxCCTPFee: bigint;
  nonEVMReceiver: Hex;
  solanaReceiverATA: Hex;
  minFinalityThreshold: number;
  refundRecipient: Hex;
  hookData: Hex;
}

/** a LI.FI bridge call taken apart: which facet, LI.FI's record of the transfer, the legs on the sending chain, the bridge's own data */
export function decodeBridgeCall(data: string): { facet: Facet; bridgeData: BridgeData; swaps: SwapLeg[]; facetData: Record<string, unknown> } | undefined {
  try {
    const d = decodeFunctionData({ abi: LIFI_BRIDGE_ABI, data: data as Hex }) as unknown as { functionName: string; args: readonly unknown[] };
    const facet = /^(?:swapAndS|s)tartBridgeTokensVia(\w+)$/.exec(d.functionName)?.[1] as Facet | undefined;
    if (!facet || !(facet in FACET_DATA)) return undefined;
    const three = d.args.length === 3;
    return { facet, bridgeData: d.args[0] as BridgeData, swaps: three ? [...(d.args[1] as SwapLeg[])] : [], facetData: d.args[three ? 2 : 1] as Record<string, unknown> };
  } catch {
    return undefined;
  }
}

// ---- small helpers ---------------------------------------------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as Obj[]) : []);
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" || typeof v === "bigint" ? String(v) : "");
const big = (v: unknown): bigint | undefined => (typeof v === "bigint" ? v : typeof v === "number" && Number.isInteger(v) && v >= 0 ? BigInt(v) : /^(0x[0-9a-fA-F]+|\d+)$/.test(str(v)) ? BigInt(str(v)) : undefined);
const same = (a: unknown, b: unknown): boolean => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
/** an address as a bridge writes it into a 32-byte field */
const word = (a: Hex): Hex => pad(a.toLowerCase() as Hex, { size: 32 });
const evm = (a: unknown): Hex | undefined => (typeof a === "string" && isAddress(a, { strict: false }) ? getAddress(a) : undefined);
const chainId = (c: ChainName): number => CHAINS[c].chain.id;
const hexOf = (n: bigint): Hex => `0x${n.toString(16)}`;
const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const round = (n: number, places = 6) => Number(n.toFixed(places));
/** a stablecoin's family, for a bridge that carries one asset across unchanged: USDT0 is Tether's USDT */
const family = (asset: string) => (asset.toUpperCase().startsWith("USDT") ? "USDT" : asset.toUpperCase());
/** the decimals a dollar stablecoin has on a chain when no chain reader is given: 18 on BNB Chain, 6 elsewhere (chain.ts) */
const usualDecimals = (c: ChainName) => (c === "BNB Chain" ? 18 : 6);
/** LI.FI's key for a bridge, from its key or the name shown for it */
const keyOf = (tool: string | undefined): string | undefined => {
  if (!tool) return undefined;
  const t = tool.trim().toLowerCase();
  return Object.keys(BRIDGES).find((k) => k.toLowerCase() === t || BRIDGES[k]!.name.toLowerCase() === t);
};

/** LI.FI's answer to a quote when it is not a yes, as one of the account's refusals, with LI.FI's own words (cleaned of any address before
 * they are cut). LI.FI ANSWERING is read first — a request it did not take, no route — and only then words about a place, in LI.FI's own
 * top-level message: a bridge LI.FI asked from its own servers may say "unavailable from a restricted jurisdiction", and that is the
 * bridge's word, quoted with its name, never LI.FI's rule for this network */
function lifiNo(venue: string, r: HttpReply): Refusal {
  const b = obj(r.body);
  const said = redact(r.text, []).replace(/\s+/g, " ").trim().slice(0, 220);
  const native = { status: r.status, said, party: "lifi" };
  // LI.FI's own words: its top-level message when it answered JSON, the page when it did not — never what a tool it asked said, nested in
  // its answer
  const own = r.body !== undefined && typeof r.body === "object" ? str(b.message) : r.text;
  if (r.status === 451 || REGION.test(own)) return byParty(venueSaidNo(venue, NAME, r.status, r.text, [], r), "lifi");
  if (r.status === 400) return no("E_VENUE_ORDER_INVALID", { venue, message: `${NAME}: ${str(b.message) || "it did not take the transfer as written"}`, native });
  if (r.status === 404 && num(b.code) === 1002) {
    // no route: `errors` is { filteredOut: [{ reason }], failed: [{ subpaths: { path: [{ tool, code, message }] } }] }, or a flat list of the same
    const errors = b.errors;
    const tools = Array.isArray(errors) ? arr(errors) : arr(obj(errors).failed).flatMap((f) => Object.values(obj(f.subpaths)).flatMap(arr));
    const reasons = [...arr(obj(errors).filteredOut).map((f) => str(f.reason)), ...tools.map((t) => `${str(t.tool)}: ${str(t.code)}${t.message ? ` (${str(t.message)})` : ""}`)].filter(Boolean);
    const codes = tools.map((t) => str(t.code));
    if (codes.length && codes.every((c) => c === "RPC_ERROR" || c === "TOOL_TIMEOUT" || c === "RATE_LIMIT_EXCEEDED")) return no("E_VENUE_UNREACHABLE", { venue, message: `${NAME} could not reach the bridges just now: try again in a minute`, native: { ...native, codes } });
    return no("E_VENUE_ORDER_INVALID", { venue, message: `${NAME} has no route for this transfer through a bridge that pays the address itself${reasons.length ? `: ${[...new Set(reasons)].slice(0, 3).join("; ")}` : ""}`, native: { ...native, codes } });
  }
  // a 403 is LI.FI's (or its edge's) no to this request: its own words when it gives some; a page with none refuses this network. It answers
  // from a US network (checked 2026-10-08: /v1/chains and /v1/quote both 200), so nothing here says whom its terms exclude
  if (edgeRefused(r.status, r.text)) return no("E_VENUE_GEOBLOCKED", { venue, message: edgeWords(NAME, r.status, r.text), native: { status: r.status, edge: true, party: "lifi" } });
  if (r.status === 403) return no("E_VENUE_PERMISSION", { venue, message: `${NAME} refused this request (HTTP 403)${str(b.message) ? `: “${str(b.message)}”` : ""}. That is its own answer, and the account does not look for a way around it`, native });
  if (r.status === 429) return no("E_VENUE_UNREACHABLE", { venue, message: `${NAME} is rate-limiting this machine: without a key it answers 75 quotes in two hours, shared with swaps. Try again later`, native: { ...native, ...(r.retryAfterMs ? { until: Date.now() + r.retryAfterMs } : {}) } });
  return byParty(venueSaidNo(venue, NAME, r.status, own || said, [], r), "lifi");
}

// ---- routes ------------------------------------------------------------------------------------------------------------------------

/** a transaction for the wallet's `eth_sendTransaction`: the gas LI.FI's simulation found is given, the gas price is the wallet's to choose */
export interface BridgeTx {
  chainId: number;
  chainIdHex: Hex;
  from: Hex;
  to: Hex;
  data: Hex;
  value: Hex;
  gas?: Hex | undefined;
}

export interface BridgeApproval {
  /** the stablecoin approved */
  token: Hex;
  /** LI.FI's contract */
  spender: Hex;
  /** exactly the amount sent, in the token's smallest unit */
  amount: string;
  /** what the wallet sends, in order: `approve(spender, 0)` first only where the token takes a new allowance from zero (Ethereum's USDT) */
  txs: WalletTx[];
}

export interface BridgeRoute {
  /** LI.FI's id for the route */
  id: string;
  /** the bridge, as people call it: "Across", "CCTP", "Stargate" */
  tool: string;
  /** everything paid besides gas, in dollars: the dollars that do not arrive (LI.FI's 0.25%, the bridge's fee) plus any fee paid on top in the chain's coin */
  feeUsd: number;
  /** the network fee on the sending chain, as LI.FI prices it */
  gasUsd: number;
  /** what arrives at worst, in dollars: the least the bridge's contract delivers (`toAmountMin`, or the lower floor the calldata allows) */
  receiveUsd: number;
  /** LI.FI's estimate of the time to arrival: an estimate, never a deadline */
  etaSec: number;
  /** present when the wallet must approve first: then, once the approval is on chain, ask for routes again — a fresh transaction, no approval */
  approval?: BridgeApproval | undefined;
  tx: BridgeTx;
  /** the route as LI.FI answered it, and the checks it passed: nothing secret */
  native: Record<string, unknown>;
}

export interface BridgeRouteRequest {
  http: Http;
  /** the wallet the money leaves: the caller has checked it is the user's, proven */
  from: Hex;
  /** where it arrives: the same wallet, another of the user's, or an exchange's own deposit address on that chain (the caller has checked it is the user's) */
  to: Hex;
  fromChain: ChainName;
  toChain: ChainName;
  /** a dollar stablecoin leaving (USDC, USDT, USDT0) */
  asset: string;
  /** a dollar stablecoin arriving */
  toAsset: string;
  /** dollars, at most six places */
  amount: number;
  integrator?: string | undefined;
  /** reads the sending chain: the token's decimals, the wallet's balances, its allowance to LI.FI's contract. Without it the usual decimals
   * are assumed (18 on BNB Chain, 6 elsewhere, cross-checked with LI.FI's), balances are not looked at, and an approval always goes first */
  chain?: ChainReader | undefined;
  /** the venue the refusals name */
  venue?: string | undefined;
  now?: (() => number) | undefined;
}

interface Want {
  fromChain: ChainName;
  toChain: ChainName;
  from: Hex;
  to: Hex;
  fromToken: Hex;
  toToken: Hex;
  fromFamily: string;
  toFamily: string;
  fromAmount: bigint;
  fromDecimals: number;
  toDecimals: number;
  integrator: string;
  nowSec: number;
}
interface Checked {
  key: string;
  toAmount: bigint;
  toAmountMin: bigint;
  /** the least the calldata lets arrive, as the bridge's contract holds it */
  floor: bigint;
  /** the coin the transaction carries, and the part of it that is fees paid on top */
  value: bigint;
  onTop: bigint;
  onTopUsd: number;
  transactionId: Hex;
}

/** The transfer LI.FI answered, held to what was asked before a wallet is shown it. Every check is on the calldata (what LI.FI's contract
 * and the bridge's contract will do), with LI.FI's summary required to agree with it. A string is the reason it is refused */
function verify(q: Obj, w: Want): Checked | string {
  const tx = obj(q.transactionRequest);
  const action = obj(q.action);
  const est = obj(q.estimate);
  const key = str(q.tool);
  const bridge = BRIDGES[key];
  if (!bridge) return `it goes by ${key || "an unnamed tool"}, which is not one of the bridges whose own contract pays exactly the address named (${Object.keys(BRIDGES).join(", ")})`;
  if (est.tool !== undefined && str(est.tool) !== key) return "its estimate names another bridge than its route";
  const fromId = chainId(w.fromChain);
  const toId = chainId(w.toChain);
  if (num(tx.chainId) !== fromId || num(action.fromChainId) !== fromId || num(action.toChainId) !== toId) return `it is not a transfer from ${w.fromChain} to ${w.toChain}`;
  if (!same(tx.to, diamondOn(w.fromChain))) return `it is not addressed to LI.FI's own contract on ${w.fromChain}`;
  if (!same(est.approvalAddress, diamondOn(w.fromChain))) return `it asks the wallet to approve a spender that is not LI.FI's own contract on ${w.fromChain}`;
  if (!same(action.fromAddress, w.from)) return "it is not from this wallet";
  if (!same(action.toAddress, w.to)) return `it pays ${str(action.toAddress) || "no address"}, not ${w.to}`;
  for (const s of arr(q.includedSteps)) {
    const a = obj(s.action);
    if (str(s.type) === "cross" && a.toAddress !== undefined && !same(a.toAddress, w.to)) return `its bridge step pays ${str(a.toAddress)}, not ${w.to}`;
    if (num(a.fromChainId) === toId) return `it makes a call on ${w.toChain} after the bridge`;
  }
  if (!same(obj(action.fromToken).address, w.fromToken) || !same(obj(action.toToken).address, w.toToken)) return "it moves other tokens than the ones asked";
  if (num(obj(action.fromToken).decimals) !== w.fromDecimals || num(obj(action.toToken).decimals) !== w.toDecimals) return "its tokens' decimals are not the tokens' own";
  if (big(action.fromAmount) !== w.fromAmount || big(est.fromAmount) !== w.fromAmount) return "it does not send exactly the amount asked";
  const toAmount = big(est.toAmount);
  const toAmountMin = big(est.toAmountMin);
  if (toAmount === undefined || toAmountMin === undefined || toAmountMin <= 0n || toAmountMin > toAmount) return "it names no least amount to arrive";

  const call = decodeBridgeCall(str(tx.data));
  if (!call) return "its transaction is not one of LI.FI's bridge calls this account reads";
  if (call.facet !== bridge.facet) return `its transaction is a ${call.facet} call, not ${bridge.name}'s`;
  const bd = call.bridgeData;
  if (!same(bd.transactionId, q.transactionId)) return "its id is not the quote's";
  if (bd.bridge !== key) return "the bridge written into its call is not the route's";
  if (bd.integrator !== w.integrator) return "it is not written for this account's integrator name";
  if (!same(bd.referrer, ZERO)) return "it names a referrer";
  if (!same(bd.receiver, w.to) || same(bd.receiver, NON_EVM)) return `LI.FI's contract would record the transfer as paying ${bd.receiver}, not ${w.to}`;
  if (bd.destinationChainId !== BigInt(toId)) return `its call sends the money to chain ${bd.destinationChainId}, not ${w.toChain}`;
  if (bd.hasDestinationCall) return `it hands the money to a contract on ${w.toChain} to call on, instead of paying the address itself`;
  if (bd.hasSourceSwaps !== call.swaps.length > 0) return "its call says it swaps first and does not, or the other way round";

  // what leaves the wallet: exactly the amount, pulled once; LI.FI's fee forwarded only as LI.FI's own fee entry says; the rest bridged
  const legs = call.swaps;
  if (legs.length) {
    const first = legs[0]!;
    if (!same(first.sendingAssetId, w.fromToken) || first.fromAmount !== w.fromAmount || !same(legs[legs.length - 1]!.receivingAssetId, bd.sendingAssetId)) return "what it takes from the wallet, or what it bridges, is not what LI.FI quoted";
    // LI.FI's contract pulls from the wallet every leg marked `requiresDeposit`: a later one would take more than the amount sent
    if (legs.slice(1).some((l) => l.requiresDeposit)) return "it takes more from the wallet than the amount it sends";
    if (same(first.callTo, FEE_FORWARDER)) {
      let fee: { functionName: string; args: readonly unknown[] };
      try {
        fee = decodeFunctionData({ abi: FEE_ABI, data: first.callData }) as unknown as typeof fee;
      } catch {
        return "its fee leg is not a call LI.FI's fee contract takes";
      }
      const token = fee.functionName === "forwardERC20Fees" ? (fee.args[0] as Hex) : ZERO;
      const dist = (fee.functionName === "forwardERC20Fees" ? fee.args[1] : fee.args[0]) as ReadonlyArray<{ recipient: Hex; amount: bigint }>;
      const forwarded = dist.reduce((s, d) => s + d.amount, 0n);
      const disclosed = arr(est.feeCosts).filter((f) => f.feeSplit !== undefined).reduce((s, f) => s + (big(f.amount) ?? 0n), 0n);
      if (!same(token, w.fromToken) || !same(first.receivingAssetId, first.sendingAssetId) || forwarded !== disclosed) return "the fee its call pays is not the fee LI.FI states";
      if (legs.length === 1 && w.fromAmount - forwarded !== bd.minAmount) return "what it bridges is not the amount sent less LI.FI's fee";
    }
  } else if (!same(bd.sendingAssetId, w.fromToken) || bd.minAmount !== w.fromAmount) return "what it bridges is not the amount asked";

  // the coin it carries: the fees LI.FI says are paid on top, in the sending chain's own coin, and nothing more
  let onTop = 0n;
  let onTopUsd = 0;
  for (const f of arr(est.feeCosts)) {
    if (f.included !== false) continue;
    const t = obj(f.token);
    if (!same(t.address, ZERO) || num(t.chainId) !== fromId) return `it charges a fee on top (${str(f.name)}) in something other than ${w.fromChain}'s own coin`;
    onTop += big(f.amount) ?? 0n;
    onTopUsd += num(f.amountUSD);
  }
  const value = big(tx.value ?? "0x0");
  if (value === undefined || value !== (same(w.fromToken, ZERO) ? w.fromAmount : 0n) + onTop) return `it carries ${value ?? "an unreadable amount of"} wei of ${CHAINS[w.fromChain].coin}, not the fees it states are paid on top`;

  // the bridge's own contract: it pays exactly `to`, and the least it delivers
  let floor: bigint;
  const fd = call.facetData;
  if (call.facet === "AcrossV4") {
    const a = fd as unknown as AcrossV4Data;
    if (!same(a.receiverAddress, word(w.to))) return `Across would pay ${a.receiverAddress}, not ${w.to}`;
    if (!same(a.refundAddress, word(w.from))) return "Across would refund another address than this wallet";
    if (!same(a.sendingAssetId, word(bd.sendingAssetId)) || !same(a.receivingAssetId, word(w.toToken))) return `Across would deliver another token than ${w.toToken}`;
    if (a.outputAmount !== toAmountMin) return "the amount Across must deliver is not the least LI.FI quoted";
    if (a.message !== "0x") return "it gives Across a message to run on arrival";
    if (a.fillDeadline <= w.nowSec + DEADLINE_ROOM_S) return "its Across deadline is minutes away or past: ask again";
    if (call.swaps.length) {
      // `swapAndStartBridgeTokensViaAcrossV4` (every quote here: LI.FI's fee is a leg) throws `outputAmount` away and asks the relayer for
      // what is bridged after the legs × `outputAmountMultiplier` / 1e18 (AcrossFacetV4.sol). What is bridged is at least `minAmount`
      // (SwapperV2 reverts below it), so this is the least Across delivers. The multiplier is rounded: up to one unit per 10^18 bridged,
      // plus one for the division (77 units of 10^-6 on a live 18-place BNB Chain quote)
      const asked = (bd.minAmount * a.outputAmountMultiplier) / MULTIPLIER_BASE;
      const room = bd.minAmount / MULTIPLIER_BASE + 1n;
      if (asked + room < toAmountMin) return "Across's contract would ask the relayer for less than the least LI.FI quoted: its output multiplier is short";
      if (asked > toAmount + room) return "Across's contract would ask the relayer for more than LI.FI quoted, which no relayer fills: its output multiplier is off";
      floor = asked;
    } else floor = a.outputAmount;
  } else if (call.facet === "Stargate") {
    const s = fd as unknown as StargateData;
    if (!same(s.sendParams.to, word(w.to))) return `Stargate would pay ${s.sendParams.to}, not ${w.to}`;
    if (!same(s.refundAddress, w.from)) return "Stargate would refund another address than this wallet";
    if (s.sendParams.dstEid !== LZ_EID[w.toChain]) return `Stargate would send it to LayerZero endpoint ${s.sendParams.dstEid}, not ${w.toChain}'s`;
    if (w.fromFamily !== w.toFamily || s.assetId !== STARGATE_ASSET[w.toFamily]) return "Stargate carries one asset across unchanged, and this is not it";
    if (s.sendParams.composeMsg !== "0x" || s.sendParams.oftCmd !== "0x") return "it gives Stargate a call to make on arrival, or rides its slower bus";
    // LayerZero options can buy a drop of coin to any address on arrival, paid out of the fee sent on top: none were ever in a live quote
    if (s.sendParams.extraOptions !== "0x") return "it gives LayerZero extra options (which can pay coin to another address on arrival)";
    if (s.sendParams.minAmountLD !== toAmountMin) return "the least Stargate delivers is not the least LI.FI quoted";
    if (s.fee.nativeFee !== onTop || s.fee.lzTokenFee !== 0n) return "the fee it pays LayerZero is not the fee it states";
    floor = s.sendParams.minAmountLD;
  } else {
    // Circle's CCTP: USDC burned on one chain, minted to the receiver on the other, one for one less the fees
    if (!CCTP_CHAINS.includes(w.fromChain) || !CCTP_CHAINS.includes(w.toChain) || w.fromFamily !== "USDC" || w.toFamily !== "USDC" || !same(bd.sendingAssetId, tokenOn("USDC", w.fromChain)?.address)) return "CCTP moves Circle's USDC to Circle's USDC, and this is not that";
    if (call.facet === "PolymerCCTP") {
      const p = fd as unknown as PolymerData;
      if (p.hookData !== "0x" || !same(p.nonEVMReceiver, ZERO32) || !same(p.solanaReceiverATA, ZERO32)) return "it gives CCTP something to run, or a receiver off this chain";
      if (!same(p.refundRecipient, w.from)) return "it would refund another address than this wallet";
      // `maxCCTPFee` is a cap: the least that is minted sits a little under LI.FI's figure in fast mode, and on it in standard mode
      floor = bd.minAmount - p.polymerTokenFee - p.maxCCTPFee;
      if (floor <= 0n || floor > toAmountMin || toAmountMin > bd.minAmount - p.polymerTokenFee) return "the least CCTP mints does not agree with the least LI.FI quoted";
    } else {
      const c = fd as unknown as CelerData;
      // Celer's own fee is set in Celer's contract, not in this call: LI.FI's least is held under what is burned less the capped fee
      if (toAmountMin > bd.minAmount - c.maxFee) return "the least LI.FI quoted is more than CCTP can mint from what is burned";
      floor = toAmountMin;
    }
  }
  return { key, toAmount, toAmountMin, floor, value, onTop, onTopUsd, transactionId: bd.transactionId };
}

/** The routes for moving `amount` dollars from `from` on `fromChain` to `to` on `toChain`, each ready for the wallet to send, the cheapest
 * first (fee plus gas). Two quotes are spent: `order=CHEAPEST` and `order=FASTEST` — LI.FI's default order is CHEAPEST, so asking it a third
 * time would only spend a quote on the same answer. The same bridge from both is shown once, so there are one or two routes. A route LI.FI
 * answered that fails a check is passed over (and named in the others' `native.passedOver`); when none is left, the refusal says why. */
export async function bridgeRoutes(req: BridgeRouteRequest): Promise<BridgeRoute[] | Refusal> {
  const venue = req.venue ?? "lifi";
  const bad = (message: string) => no("E_ACCOUNT_BAD_ACTION", { venue, message });
  if (req.fromChain === req.toChain) return bad(`a bridge moves money between two chains: ${req.fromChain} to ${req.toChain} is a transfer on one chain`);
  for (const c of [req.fromChain, req.toChain]) if (!BRIDGE_CHAINS.includes(c)) return bad(`money is bridged here between ${BRIDGE_CHAINS.join(", ")}: not ${c}`);
  const from = evm(req.from);
  const to = evm(req.to);
  if (!from) return bad("the sending wallet is not an EVM address");
  if (!to || to === ZERO || same(to, NON_EVM)) return bad("the destination is not an address money can be sent to");
  const send = isStable(req.asset) ? dollarOn(req.asset, req.fromChain) : undefined;
  const arrive = isStable(req.toAsset) ? dollarOn(req.toAsset, req.toChain) : undefined;
  const usdgOnly = (c: ChainName) => (c === USDG_ROBINHOOD.chain ? ` (on ${c} the dollar bridged is ${USDG_ROBINHOOD.asset})` : "");
  if (!send) return no("E_ACCOUNT_UNPRICED", { venue, message: `${req.asset} is not a dollar stablecoin this account knows on ${req.fromChain}${usdgOnly(req.fromChain)}: real money is bridged in dollar stablecoins only, so that every limit means dollars` });
  if (!arrive) return no("E_ACCOUNT_UNPRICED", { venue, message: `${req.toAsset} is not a dollar stablecoin this account knows on ${req.toChain}${usdgOnly(req.toChain)}: real money is bridged in dollar stablecoins only, so that every limit means dollars` });
  if (!(Number.isFinite(req.amount) && req.amount > 0) || Math.abs(Number(req.amount.toFixed(6)) - req.amount) > 1e-9) return bad("the amount is dollars, more than zero, with at most six places");
  const integrator = req.integrator ?? INTEGRATOR;
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(integrator)) return bad("an integrator name is letters, digits, dot, dash or underscore");
  const { chain } = req;
  const now = req.now ?? Date.now;

  // the decimals of each token, from the token itself: the same dollar is 6 places on one chain and 18 on another
  const decs = chain ? await Promise.all([chain.decimals(req.fromChain, send.address), chain.decimals(req.toChain, arrive.address)]) : [usualDecimals(req.fromChain), usualDecimals(req.toChain)];
  const [fromDecimals, toDecimals] = decs;
  if (fromDecimals === undefined) return no("E_VENUE_UNREACHABLE", { venue, message: `${req.fromChain} did not answer: ${send.asset}'s decimals could not be read, so nothing was asked of ${NAME}` });
  if (toDecimals === undefined) return no("E_VENUE_UNREACHABLE", { venue, message: `${req.toChain} did not answer: ${arrive.asset}'s decimals could not be read, so nothing was asked of ${NAME}` });
  const fromAmount = parseUnits(req.amount.toFixed(6), fromDecimals);
  // the wallet must hold what it sends: looked at before a quote is spent (keyless quotes are few)
  if (chain) {
    const held = await chain.tokens(from, [{ chain: req.fromChain, asset: send.asset, address: send.address }]);
    // a chain that answered without the token's row (its balance call reverted) has not said the wallet holds nothing
    if (held.failed.length || !held.rows.length) return no("E_VENUE_UNREACHABLE", { venue, message: `${req.fromChain} did not answer${held.said?.[req.fromChain] ? ` (${held.said[req.fromChain]})` : ""}: the wallet's ${send.asset} could not be read, so nothing was asked of ${NAME}` });
    const have = held.rows[0]!.amount;
    if (have + 1e-9 < req.amount) return no("E_VENUE_INSUFFICIENT", { venue, message: `the wallet holds ${have} ${send.asset} on ${req.fromChain}; this transfer sends ${req.amount}`, native: { asset: send.asset, chain: req.fromChain, have, need: req.amount } });
  }

  const ask = async (order: Order): Promise<{ order: Order; quote: Obj } | Refusal> => {
    // LI.FI held back by a refusal it gave this machine (its edge, a ban, a rate limit: dex.ts lifiHold) is not asked meanwhile
    const held = lifiHolding(req.http, now(), venue);
    if (held) return held;
    const q = new URLSearchParams({ fromChain: String(chainId(req.fromChain)), toChain: String(chainId(req.toChain)), fromToken: send.address, toToken: arrive.address, fromAmount: fromAmount.toString(), fromAddress: from, toAddress: to, slippage: String(SLIPPAGE), integrator, order, allowDestinationCall: "false" });
    // the bridges whose own contract pays exactly the address named, as one comma-separated list (LI.FI's own SDK sends it so; checked live)
    const url = `${LIFI}/quote?${q.toString()}&allowBridges=${Object.keys(BRIDGES).join(",")}`;
    let r: HttpReply;
    try {
      r = await req.http(url, { headers: { accept: "application/json" }, timeoutMs: 20_000 });
    } catch (err) {
      const u = byParty(unreachable(venue, NAME, err), "lifi");
      lifiHold(req.http, u, now());
      return u;
    }
    // a 200 that is not LI.FI's JSON (a filtering network's page, an empty answer) is no answer: never read as a route of "an unnamed tool"
    if (r.status === 200) return r.body !== undefined && typeof r.body === "object" ? { order, quote: obj(r.body) } : no("E_VENUE_UNREACHABLE", { venue, message: notTheApi(r) ? notTheApiWords(NAME) : `${NAME} answered something that is not a quote: try again shortly`, native: { status: 200, party: "lifi" } });
    const x = lifiNo(venue, r);
    lifiHold(req.http, x, now());
    return x;
  };
  const answers = await Promise.all(ORDERS.map(ask));
  const got = answers.filter((a): a is { order: Order; quote: Obj } => !isRefusal(a));
  if (!got.length) return answers[0] as Refusal;

  const want: Want = { fromChain: req.fromChain, toChain: req.toChain, from, to, fromToken: send.address, toToken: arrive.address, fromFamily: family(send.asset), toFamily: family(arrive.asset), fromAmount, fromDecimals, toDecimals, integrator, nowSec: Math.floor(now() / 1000) };
  type Kept = { order: Order[]; quote: Obj; c: Checked; receiveUsd: number; feeUsd: number; gasUsd: number; gasWei: bigint };
  const kept: Kept[] = [];
  const dropped: Array<{ order: Order; route: string; tool: string; code: "E_VENUE_REJECTED" | "E_ACCOUNT_REQUOTE" | "E_VENUE_INSUFFICIENT"; why: string }> = [];
  for (const { order, quote } of got) {
    const tool = str(quote.tool);
    const drop = (code: (typeof dropped)[number]["code"], why: string) => dropped.push({ order, route: str(quote.id), tool, code, why });
    const c = verify(quote, want);
    if (typeof c === "string") {
      drop("E_VENUE_REJECTED", `${NAME} answered a ${BRIDGES[tool]?.name ?? tool} transfer this account will not hand your wallet: ${c}`);
      continue;
    }
    const est = obj(quote.estimate);
    // what arrives at worst: the lower of LI.FI's least and the least the bridge's contract holds to
    const worst = c.floor < c.toAmountMin ? c.floor : c.toAmountMin;
    const receiveUsd = Number(formatUnits(worst, toDecimals));
    if (receiveUsd - c.onTopUsd < req.amount * FLOOR - 1e-9) {
      drop("E_ACCOUNT_REQUOTE", `${NAME}'s ${BRIDGES[c.key]!.name} route delivers at worst ${usd(receiveUsd)}${c.onTopUsd > 0 ? ` and charges ${usd(c.onTopUsd)} on top in ${CHAINS[req.fromChain].coin}` : ""}: under ${FLOOR * 100}% of the ${usd(req.amount)} sent`);
      continue;
    }
    const twice = kept.find((k) => k.c.key === c.key);
    if (twice) {
      twice.order.push(order);
      continue;
    }
    const expected = Number(formatUnits(c.toAmount, toDecimals));
    const gas = arr(est.gasCosts);
    kept.push({ order: [order], quote, c, receiveUsd, feeUsd: round(req.amount - expected + c.onTopUsd), gasUsd: round(gas.reduce((s, g) => s + num(g.amountUSD), 0)), gasWei: gas.reduce((s, g) => s + (big(g.amount) ?? 0n), 0n) });
  }

  // the wallet pays the network fee and any fee on top in the chain's own coin: a route it cannot pay for is not offered
  const coin = CHAINS[req.fromChain].coin;
  let coinHeld: number | undefined;
  if (chain && kept.length) {
    const n = await chain.native(from, [req.fromChain]);
    coinHeld = n.failed.length ? undefined : (n.rows[0]?.amount ?? 0);
  }
  const payable = kept.filter((k) => {
    if (coinHeld === undefined) return true;
    const need = Number(formatUnits(k.gasWei + k.c.value, 18));
    if (coinHeld + 1e-18 >= need) return true;
    dropped.push({ order: k.order[0]!, route: str(k.quote.id), tool: k.c.key, code: "E_VENUE_INSUFFICIENT", why: `the wallet holds ${coinHeld} ${coin} on ${req.fromChain}; the ${BRIDGES[k.c.key]!.name} route needs about ${need} for ${k.c.onTop > 0n ? "its network fee and the fee paid on top" : "its network fee"}` });
    return false;
  });
  if (!payable.length) {
    const first = dropped[0]!;
    return no(first.code, { venue, message: `${dropped.map((d) => d.why).join("; ")}. Nothing was prepared`, native: { dropped } });
  }

  // the wallet's allowance to LI.FI's contract: an approval of exactly the amount goes first when it is short (unread: approve anyway)
  const diamond = diamondOn(req.fromChain);
  const allowance = chain ? await chain.uint(req.fromChain, send.address, ALLOWANCE, [from, diamond]) : undefined;
  const id = chainId(req.fromChain);
  const chainIdHex = hexOf(BigInt(id));
  const approve = (n: bigint): WalletTx => ({ chainId: id, chainIdHex, from, to: send.address, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [diamond, n] }), value: "0x0" });

  const routes = payable.map((k): BridgeRoute => {
    const { quote, c } = k;
    const est = obj(quote.estimate);
    const tx = obj(quote.transactionRequest);
    const bridge = BRIDGES[c.key]!;
    const gasLimit = big(tx.gasLimit) ?? big(arr(est.gasCosts)[0]?.limit);
    const reset = est.approvalReset === true;
    const approval: BridgeApproval | undefined =
      allowance !== undefined && allowance >= fromAmount ? undefined : { token: send.address, spender: diamond, amount: fromAmount.toString(), txs: [...(reset && (allowance === undefined || allowance > 0n) ? [approve(0n)] : []), approve(fromAmount)] };
    return {
      id: str(quote.id) || c.transactionId,
      tool: bridge.name,
      feeUsd: k.feeUsd,
      gasUsd: k.gasUsd,
      receiveUsd: k.receiveUsd,
      etaSec: num(est.executionDuration),
      ...(approval ? { approval } : {}),
      tx: { chainId: id, chainIdHex, from, to: diamond, data: str(tx.data) as Hex, value: hexOf(c.value), ...(gasLimit !== undefined && gasLimit > 0n ? { gas: hexOf(gasLimit) } : {}) },
      native: {
        route: str(quote.id),
        tool: c.key,
        toolName: str(obj(quote.toolDetails).name) || bridge.name,
        orders: k.order,
        transactionId: c.transactionId,
        integrator,
        fromChain: req.fromChain,
        toChain: req.toChain,
        send: { asset: send.asset, token: send.address, amount: formatUnits(fromAmount, fromDecimals) },
        arrive: { asset: arrive.asset, token: arrive.address, expected: formatUnits(c.toAmount, toDecimals), least: formatUnits(c.toAmountMin, toDecimals), leastOnChain: formatUnits(c.floor, toDecimals) },
        ...(c.onTop > 0n ? { paidOnTop: { coin, wei: c.onTop.toString(), usd: round(c.onTopUsd) } } : {}),
        usuallyWithinSec: bridge.p90Sec,
        gasLimit: str(tx.gasLimit),
        allowance: allowance === undefined ? "unread" : allowance.toString(),
        ...(est.fromAmountUSD ? { fromAmountUSD: str(est.fromAmountUSD) } : {}),
        ...(est.toAmountUSD ? { toAmountUSD: str(est.toAmountUSD) } : {}),
        ...(dropped.length ? { passedOver: dropped } : {}),
      },
    };
  });
  return routes.sort((a, b) => a.feeUsd + a.gasUsd - (b.feeUsd + b.gasUsd) || a.etaSec - b.etaSec);
}

// ---- what became of it -----------------------------------------------------------------------------------------------------------

export interface BridgeStatus {
  /** settled: it arrived (in the token asked, or — see the note — in another); failed: it did not and will not, or it came back */
  status: "pending" | "settled" | "failed";
  /** what arrived, in dollars, when it arrived in a dollar stablecoin */
  received?: number | undefined;
  /** the transaction that paid it out on the arriving chain */
  receivingHash?: string | undefined;
  note: string;
  native: unknown;
  /** LI.FI's refusal of this machine, when that is why it is still shown as on its way: how long LI.FI is held back (holdBackMs) is its */
  refusal?: Refusal | undefined;
}

/** LI.FI's word on a transfer the wallet sent, by its hash. Pending is the honest answer for as long as nothing has arrived and nothing came
 * back — an hour, or days: an estimate passing proves nothing, and LI.FI not answering proves nothing. A Refusal only for a question
 * that cannot be asked, or an answer that is about another transfer. With `chain`, a hash LI.FI has not seen — or one LI.FI could not be
 * asked about (no answer, its edge, a ban: then `refusal`, and LI.FI is not asked again while it holds) — is looked up on the sending
 * chain, where a reverted transaction is the end of it (nothing left the wallet but the network fee). */
export async function bridgeStatus(req: { http: Http; hash: Hex; fromChain: ChainName; toChain: ChainName; tool?: string | undefined; from?: Hex | undefined; to?: Hex | undefined; chain?: Pick<ChainReader, "receipt"> | undefined; venue?: string | undefined; now?: (() => number) | undefined }): Promise<BridgeStatus | Refusal> {
  const venue = req.venue ?? "lifi";
  const now = req.now ?? Date.now;
  const { hash, fromChain, toChain } = req;
  if (!HASH.test(hash)) return no("E_ACCOUNT_BAD_ACTION", { venue, message: "a transaction hash is 0x and sixty-four hex digits" });
  if (fromChain === toChain || !BRIDGE_CHAINS.includes(fromChain) || !BRIDGE_CHAINS.includes(toChain)) return no("E_ACCOUNT_BAD_ACTION", { venue, message: `a bridged transfer goes between two of ${BRIDGE_CHAINS.join(", ")}` });

  /** What the sending chain says, when LI.FI has not seen the transfer (404 · 1003, NOT_FOUND: normal for a minute or two) or could not say
   * (`refusal`): reverted is the end of it; otherwise it is still on its way. `opening`: the account's sentence for what LI.FI said — never
   * LI.FI's raw text, which on an edge's page may carry this machine's address */
  const unseen = async (lifi: unknown, opening?: string, refusal?: Refusal): Promise<BridgeStatus> => {
    const held = refusal ? { refusal } : {};
    const onItsWay = "still on its way as far as anyone here knows";
    const notSeen = opening === undefined;
    const base = opening ?? `${NAME} has not seen ${hash.slice(0, 10)}… yet`;
    if (!req.chain) return { status: "pending", note: notSeen ? `${base}: normal for a minute or two after it is sent` : `${base}: ${onItsWay}`, native: { lifi }, ...held };
    let rc: Mined | undefined;
    try {
      rc = await req.chain.receipt(fromChain, hash);
    } catch (err) {
      // the chain's endpoint not answering, or refusing this network, is said in its words: it is not "not mined yet"
      return { status: "pending", note: `${base}, and ${isRefusal(err) ? err.message : `${fromChain} did not answer`}: ${onItsWay}`, native: { lifi, chain: "unanswered" }, ...held };
    }
    if (!rc) return { status: "pending", note: `${base}, and ${fromChain} does not show it mined yet`, native: { lifi, chain: "not mined yet" }, ...held };
    const ours = same(rc.to, diamondOn(fromChain)) && (req.from === undefined || same(rc.from, req.from));
    if (rc.status === "reverted" && ours) return { status: "failed", note: `the transaction reverted on ${fromChain}: nothing left the wallet but the network fee`, native: { lifi, receipt: "reverted" } };
    return { status: "pending", note: notSeen ? `${base}; it is mined on ${fromChain}, and LI.FI usually indexes it within a minute or two` : `${base}; it is mined on ${fromChain}, ${onItsWay}`, native: { lifi, receipt: rc.status }, ...held };
  };

  // LI.FI held back by a refusal it gave this machine (dex.ts lifiHold: its edge ten minutes, a ban its own time): not asked, the chain is
  const back = lifiHolding(req.http, now(), venue);
  if (back) return unseen({ held: true }, back.message, back);
  const bridge = keyOf(req.tool);
  const url = `${LIFI}/status?txHash=${hash}&fromChain=${chainId(fromChain)}&toChain=${chainId(toChain)}${bridge ? `&bridge=${bridge}` : ""}`;
  let r: HttpReply;
  try {
    r = await req.http(url, { headers: { accept: "application/json" }, timeoutMs: 10_000 });
  } catch (err) {
    const u = byParty(unreachable(venue, NAME, err), "lifi");
    lifiHold(req.http, u, now());
    return unseen({ lifi: u.native }, `${NAME} could not be asked just now`, u);
  }
  const said = { status: r.status, said: redact(r.text, []).replace(/\s+/g, " ").trim().slice(0, 220) };

  if (r.status === 404) return unseen(said);
  if (r.status !== 200) {
    // LI.FI's no (its edge's page, a 451, a ban, a rate limit, an outage): held back as long as it says, and the chain asked meanwhile —
    // a transfer that reverted is not left pending for as long as LI.FI refuses this network
    const refusal = lifiNo(venue, r);
    lifiHold(req.http, refusal, now());
    return unseen({ status: r.status, ...((refusal.native as { edge?: unknown } | undefined)?.edge ? { edge: true } : {}) }, refusal.message, refusal);
  }
  const b = obj(r.body);
  const sending = obj(b.sending);
  const receiving = obj(b.receiving);
  const sTok = obj(sending.token);
  const rTok = obj(receiving.token);
  const st = str(b.status);
  const sub = str(b.substatus);
  const words = str(b.substatusMessage);
  const lifi = {
    status: st,
    ...(sub ? { substatus: sub } : {}),
    ...(words ? { said: words } : {}),
    ...(b.tool ? { tool: str(b.tool) } : {}),
    ...(b.transactionId ? { transactionId: str(b.transactionId) } : {}),
    ...(b.lifiExplorerLink ? { explorer: str(b.lifiExplorerLink) } : {}),
    ...(b.bridgeExplorerLink ? { bridgeExplorer: str(b.bridgeExplorerLink) } : {}),
    ...(sending.txHash ? { sending: { txHash: str(sending.txHash), chainId: num(sending.chainId), amount: str(sending.amount), token: str(sTok.symbol), address: str(sTok.address) } } : {}),
    ...(receiving.txHash ? { receiving: { txHash: str(receiving.txHash), chainId: num(receiving.chainId), amount: str(receiving.amount), token: str(rTok.symbol), address: str(rTok.address) } } : {}),
  };

  // an answer about another transfer is not this one's
  const notThis = (why: string): Refusal => no("E_VENUE_REJECTED", { venue, message: `${NAME}'s answer for ${hash.slice(0, 10)}… is about another transfer: ${why}`, native: lifi });
  // a refund may be recorded as received on the SENDING chain: that is this transfer coming back, not another transfer (and it maps to failed)
  const refund = (st === "DONE" && sub === "REFUNDED") || st === "FAILED";
  const receivedOn = receiving.chainId === undefined ? undefined : num(receiving.chainId);
  if (st && st !== "NOT_FOUND" && st !== "INVALID") {
    if (![sending.txHash, receiving.txHash, b.transactionId].some((x) => same(x, hash))) return notThis("it names other transactions");
    if ((sending.chainId !== undefined && num(sending.chainId) !== chainId(fromChain)) || (receivedOn !== undefined && receivedOn !== chainId(toChain) && !(refund && receivedOn === chainId(fromChain)))) return notThis(`it is between other chains than ${fromChain} and ${toChain}`);
    if (req.from !== undefined && b.fromAddress !== undefined && !same(b.fromAddress, req.from)) return notThis(`it is from ${str(b.fromAddress)}`);
    if (req.to !== undefined && b.toAddress !== undefined && !same(b.toAddress, req.to)) return notThis(`it pays ${str(b.toAddress)}`);
  }
  /** an amount in whole tokens: exact for the note, a number for the account */
  const amountOf = (side: Obj, tok: Obj): string | undefined => {
    const a = big(side.amount);
    return a !== undefined && Number.isInteger(tok.decimals) ? formatUnits(a, Number(tok.decimals)) : undefined;
  };
  const receivingHash = receiving.txHash ? { receivingHash: str(receiving.txHash) } : {};

  if (st === "DONE" && sub === "COMPLETED") {
    const got = amountOf(receiving, rTok);
    const received = got !== undefined && isStable(str(rTok.symbol)) ? { received: Number(got) } : {};
    return { status: "settled", ...received, ...receivingHash, note: got !== undefined ? `arrived: ${got} ${str(rTok.symbol)} on ${toChain}` : `arrived on ${toChain}, LI.FI says (it gave no amount)`, native: lifi };
  }
  if (st === "DONE" && sub === "PARTIAL") {
    // the bridge delivered, the swap after it did not: the money is on the arriving chain, in the token the bridge carried
    const got = amountOf(receiving, rTok);
    const asked = str(obj(obj(obj(b.quote).action).toToken).symbol);
    const received = got !== undefined && isStable(str(rTok.symbol)) ? { received: Number(got) } : {};
    return { status: "settled", ...received, ...receivingHash, note: `arrived on ${toChain} as ${got ?? "some"} ${str(rTok.symbol) || "of another token"}, not ${asked || "the token asked"}: the money is there, in another token. A swap on ${toChain} turns it into the one asked`, native: lifi };
  }
  if (st === "DONE" && sub === "REFUNDED") {
    return { status: "failed", note: `${NAME} says the transfer was refunded${words ? `: "${words}"` : ""}. The money goes back to the sending wallet on ${fromChain}${sTok.symbol ? `, in ${str(sTok.symbol)}` : ""}`, native: lifi };
  }
  if (st === "FAILED") {
    const refund = sub === "NOT_PROCESSABLE_REFUND_NEEDED" ? ` LI.FI refunds it on ${fromChain}: the refund shows in the sending wallet there` : "";
    return { status: "failed", note: `${NAME} says the transfer failed${sub ? ` (${sub})` : ""}${words ? `: "${words}"` : ""}.${refund}`, native: lifi };
  }
  if (st === "NOT_FOUND") return unseen(lifi);
  if (st === "PENDING") return { status: "pending", note: `on its way${sub ? ` (${sub})` : ""}${words ? `: "${words}"` : ""}`, native: lifi };
  // DONE with a word this account does not read, INVALID, anything new, or a 200 that is not LI.FI's answer at all: neither arrived nor lost,
  // on a guess — the sending chain still says whether it reverted
  return unseen(lifi, `${NAME} says ${st || "nothing readable"}${sub ? `/${sub}` : ""}${words ? `: "${words}"` : ""}: not read here as arrived or as lost`);
}

// ---- the hash the wallet sent ------------------------------------------------------------------------------------------------------

/** a transaction by its hash, as a chain reader or a raw RPC answer gives it (`input` or `data`; a value or chain id in hex or decimal) */
export interface SeenTx {
  from: string;
  to: string | null;
  data?: string | undefined;
  input?: string | undefined;
  value: bigint | string | number;
  chainId?: number | string | undefined;
}
export type GetTx = (chain: ChainName, hash: Hex) => Promise<SeenTx | undefined>;

/** Is `hash` the transaction that was built? Read back from the sending chain and held to it: the same sender, LI.FI's contract, the call
 * byte for byte, the same coin, the same chain — or it is refused (a speed-up keeps all of these; a cancel, a smart account's wrapper, a
 * gasless relay through another contract do not). "pending" while the chain does not show it. Only a reader that cannot read a transaction
 * by its hash at all judges by the receipt: LI.FI's own log of the transfer starting, with every field of this transfer's record in it */
export async function confirmSent(req: { chain?: Partial<Pick<ChainReader, "transaction" | "receipt">> | undefined; getTx?: GetTx | undefined; expected: BridgeTx; hash: Hex; venue?: string | undefined }): Promise<"pending" | "ok" | Refusal> {
  const venue = req.venue ?? "lifi";
  const { hash, expected: want } = req;
  if (!HASH.test(hash)) return no("E_ACCOUNT_BAD_ACTION", { venue, message: "a transaction hash is 0x and sixty-four hex digits" });
  const c = CHAIN_BY_ID.get(want.chainId);
  if (!c || !BRIDGE_CHAINS.includes(c)) return no("E_ACCOUNT_BAD_ACTION", { venue, message: `the transaction built is for chain ${want.chainId}, not one money is bridged from here` });
  const notIt = (why: string[]): Refusal => no("E_VENUE_REJECTED", { venue, message: `transaction ${hash} is not the transfer that was built: ${why.join("; ")}. It is not followed; the transfer still waits for your wallet`, native: { hash, chain: c, why } });
  const read = req.getTx ?? (req.chain?.transaction ? (ch: ChainName, h: Hex) => req.chain!.transaction!(ch, h) : undefined);
  if (!read && !req.chain?.receipt) return no("E_ACCOUNT_BAD_ACTION", { venue, message: `nothing here can read ${c}, so ${hash} cannot be held to the transfer` });

  if (read) {
    // a reader that can read the transaction holds it to the call byte for byte: not seen (or not answering) is "pending", asked again
    // later — never judged instead by the receipt, which shows neither the call nor the coin it carried
    const t = await read(c, hash).catch(() => undefined);
    if (!t) return "pending";
    const value = big(t.value);
    const chainIdSeen = t.chainId === undefined ? undefined : num(typeof t.chainId === "string" && t.chainId.startsWith("0x") ? Number(BigInt(t.chainId)) : t.chainId);
    const why = [
      ...(same(t.from, want.from) ? [] : [`it is from ${t.from}, not ${want.from}`]),
      ...(t.to && same(t.to, want.to) ? [] : [`it goes to ${t.to ?? "no address"}, not ${want.to}`]),
      ...(same(t.data ?? t.input, want.data) ? [] : ["its call is not the one built"]),
      ...(value === (big(want.value) ?? 0n) ? [] : [`it carries ${value ?? "an unreadable amount of"} wei of ${CHAINS[c].coin}, not ${big(want.value) ?? 0n}`]),
      ...(chainIdSeen === undefined || chainIdSeen === want.chainId ? [] : [`it is for chain ${chainIdSeen}, not ${want.chainId}`]),
    ];
    return why.length ? notIt(why) : "ok";
  }
  if (!req.chain?.receipt) return "pending";
  const rc = await req.chain.receipt(c, hash).catch(() => undefined);
  if (!rc) return "pending";
  const why = [...(same(rc.from, want.from) ? [] : [`it is from ${rc.from}, not ${want.from}`]), ...(rc.to && same(rc.to, want.to) ? [] : [`it goes to ${rc.to ?? "no address"}, not ${want.to}`])];
  if (why.length) return notIt(why);
  if (rc.status !== "success") return notIt(["it reverted, and a reverted transaction's receipt carries no log that ties it to this transfer"]);
  const built = decodeBridgeCall(want.data);
  if (!built) return no("E_ACCOUNT_BAD_ACTION", { venue, message: `the transaction built is not a LI.FI bridge call, so ${hash} cannot be judged by its receipt alone` });
  const bd = built.bridgeData;
  const logged = rc.logs.some((l) => {
    if (!same(l.address, diamondOn(c)) || !same(l.topics[0], TRANSFER_STARTED_TOPIC)) return false;
    try {
      const e = (decodeEventLog({ abi: STARTED, data: l.data, topics: l.topics as [Hex, ...Hex[]] }).args as unknown as { bridgeData: BridgeData }).bridgeData;
      // every field of LI.FI's record but `minAmount`, which the contract rewrites to what the legs left (at least the built one)
      return (
        same(e.transactionId, bd.transactionId) &&
        e.bridge === bd.bridge &&
        e.integrator === bd.integrator &&
        same(e.referrer, bd.referrer) &&
        same(e.receiver, bd.receiver) &&
        e.destinationChainId === bd.destinationChainId &&
        same(e.sendingAssetId, bd.sendingAssetId) &&
        e.hasSourceSwaps === bd.hasSourceSwaps &&
        e.hasDestinationCall === bd.hasDestinationCall &&
        e.minAmount >= bd.minAmount
      );
    } catch {
      return false;
    }
  });
  return logged ? "ok" : notIt([`${NAME}'s contract logged no transfer with this transfer's id, receiver, destination and amount in it`]);
}
