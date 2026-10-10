/** Reading an address from the chains it can hold dollars on, and Robinhood Chain, where Robinhood's Stock Tokens live.
 *
 * Seven EVM chains, each through a public JSON-RPC endpoint (the ones the `viem` library ships as defaults; `PORTFOLIO_RPC_<CHAIN>` puts
 * your own in its place — public endpoints are rate-limited, and whoever runs one sees the address asked about and the machine asking).
 * A token's decimals are read from the token itself rather than assumed: the same dollar is 6 decimals on one chain and 18 on another.
 * A chain that does not answer is left out and named, so one slow endpoint does not blank the wallet — and an endpoint that refuses this
 * network (a 429, a 403 edge page, a 451) is a chain that did not answer, never a wallet that holds nothing. A wait an endpoint asks for
 * (its Retry-After) is kept here as a hold, not slept through inside a read: one per-IP 429 saying "an hour" does not stall the wallet.
 *
 * The reader only reads (`eth_call`, `eth_getBalance`, a transaction and its receipt by hash). The one thing that SENDS is `publicSender`:
 * a dollar transfer from an agent wallet the account holds the key of (account/keystore.ts), and nothing else.
 */
import { createPublicClient, createWalletClient, encodeFunctionData, erc20Abi, formatUnits, http, HttpRequestError, InternalRpcError, keccak256, parseAbi, RpcError, RpcRequestError, TimeoutError, TransactionNotFoundError, TransactionReceiptNotFoundError, UnknownRpcError, type Chain, type Hex, type PublicClient } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { getTransactionCount } from "viem/actions";
import type { Refusal } from "../../core/errors.ts";
import { no } from "../refuse.ts";
import { edgeRefused, edgeWords, notTheApiWords, REGION, retryAfterMs, transportCode } from "./types.ts";

/** a mined transaction, as much of it as a payment needs */
export interface Mined {
  status: "success" | "reverted";
  from: Hex;
  to: Hex | null;
  logs: Array<{ address: Hex; topics: Hex[]; data: Hex }>;
}
import { arbitrum, base, bsc, mainnet, optimism, polygon, robinhood } from "viem/chains";

export type ChainName = "Ethereum" | "Optimism" | "BNB Chain" | "Polygon" | "Base" | "Arbitrum" | "Robinhood Chain";

export interface TokenRef {
  chain: ChainName;
  asset: string;
  address: Hex;
}

export interface ChainBalance {
  chain: ChainName;
  asset: string;
  amount: number;
}

/** what a reader read across chains: the balances, the chains that did not answer, and — where the reader can say — why, in the account's
 * words (the endpoint rate-limiting this machine, refusing this network, an edge's page): nothing of this network's is in them */
export interface PerChain {
  rows: ChainBalance[];
  failed: ChainName[];
  said?: Partial<Record<ChainName, string>> | undefined;
}

export interface ChainReader {
  /** token balances of one holder, in whole tokens; `failed` names the chains that did not answer. A token whose own balance call reverted
   * has no row: that is not a balance of nothing */
  tokens(holder: Hex, refs: TokenRef[]): Promise<PerChain>;
  /** each chain's own coin */
  native(holder: Hex, chains: ChainName[]): Promise<PerChain>;
  /** one read-only call that answers a uint256 (a price oracle); `undefined` when it reverts or the chain does not answer */
  uint(chain: ChainName, address: Hex, signature: string, args?: unknown[]): Promise<bigint | undefined>;
  /** a token's own decimals; `undefined` when the chain does not answer */
  decimals(chain: ChainName, token: Hex): Promise<number | undefined>;
  /** a token's own symbol (an earn vault's shares: account/holdings.ts withEarn); `undefined` when the chain does not answer. Optional: a
   * reader without it leaves the vault's shares to be told apart by what they are worth */
  symbol?(chain: ChainName, token: Hex): Promise<string | undefined>;
  /** a transaction once it is mined; `undefined` while it is not — the chain answered that it has no receipt for it. A chain whose endpoint
   * does not answer, or refuses this network, THROWS a refusal in the endpoint's words (publicChain): that is not "not mined yet" */
  receipt(chain: ChainName, hash: Hex): Promise<Mined | undefined>;
  /** a transaction by its hash, mined or still waiting to be: who sent it, where, the call and the coin it carries; `undefined` when the
   * chain answered that it does not know it (one that does not answer throws, as receipt does). Optional: a reader without it leaves a sent
   * transaction to be judged by its receipt */
  transaction?(chain: ChainName, hash: Hex): Promise<SentTx | undefined>;
  /** EIP-3009: has this authorisation's nonce been used on the token (USDC's `authorizationState`)? `undefined` when the chain does not answer */
  authorizationUsed?(chain: ChainName, token: Hex, authorizer: Hex, nonce: Hex): Promise<boolean | undefined>;
  /** how many transactions an address has had mined on a chain (the nonce its next one takes); `undefined` when the chain does not answer.
   * Optional: a reader without it never judges a send whose answer was lost by its nonce */
  nonce?(chain: ChainName, address: Hex): Promise<number | undefined>;
}

/** What a send came to. A hash: the node took it — or, with `answerLost`, it was sent and its answer never came (a timeout, a gateway's 5xx,
 * a cut connection, a page in the node's place), so the node may have it: it is followed by that hash, never sent again. An error: the node
 * said no, or (`unanswered`) nothing was sent at all, or (`inFlight`) an earlier send from the wallet is still waiting to be mined */
export type Sent = { hash: Hex; nonce?: number | undefined; answerLost?: true | undefined; said?: string | undefined } | { error: string; unanswered?: true | undefined; inFlight?: true | undefined };

/** Sending, from a key the account holds: one token transfer, gas paid in the chain's own coin by the sender. Nothing else is ever sent */
export interface ChainSender {
  transfer(r: { chain: ChainName; account: PrivateKeyAccount; token: Hex; to: Hex; units: bigint }): Promise<Sent>;
}

/** a transaction as it was sent: what a wallet's transaction is checked against before the account follows it */
export interface SentTx {
  from: Hex;
  to: Hex | null;
  data: Hex;
  value: bigint;
  chainId?: number | undefined;
}

/** Dollar stablecoins by chain, read 2026-10-05. USDC: Circle's own addresses (developers.circle.com), except BNB Chain's, which is
 * Binance-pegged. USDT: Tether's on Ethereum; USDT0 on Arbitrum, Polygon (both upgraded in place) and OP Mainnet (a new address, the
 * bridged one kept beside it); Binance-pegged on BNB Chain; bridged on Base (not issued by Tether). A token's decimals are read from the
 * token itself, never taken from here: the two on BNB Chain have 18, the rest 6. */
export const STABLECOINS: TokenRef[] = [
  { chain: "Ethereum", asset: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
  { chain: "Ethereum", asset: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7" },
  { chain: "Optimism", asset: "USDC", address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" },
  { chain: "Optimism", asset: "USDT0", address: "0x01bFF41798a0BcF287b996046Ca68b395DbC1071" },
  { chain: "Optimism", asset: "USDT", address: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58" },
  { chain: "BNB Chain", asset: "USDC", address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d" },
  { chain: "BNB Chain", asset: "USDT", address: "0x55d398326f99059fF775485246999027B3197955" },
  { chain: "Polygon", asset: "USDC", address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" },
  { chain: "Polygon", asset: "USDT0", address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F" },
  { chain: "Base", asset: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
  { chain: "Base", asset: "USDT", address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2" },
  { chain: "Arbitrum", asset: "USDC", address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" },
  { chain: "Arbitrum", asset: "USDT0", address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9" },
];

export const CHAINS: Record<ChainName, { chain: Chain; coin: string; env: string }> = {
  Ethereum: { chain: mainnet, coin: "ETH", env: "PORTFOLIO_RPC_ETHEREUM" },
  Optimism: { chain: optimism, coin: "ETH", env: "PORTFOLIO_RPC_OPTIMISM" },
  "BNB Chain": { chain: bsc, coin: "BNB", env: "PORTFOLIO_RPC_BNB" },
  Polygon: { chain: polygon, coin: "POL", env: "PORTFOLIO_RPC_POLYGON" },
  Base: { chain: base, coin: "ETH", env: "PORTFOLIO_RPC_BASE" },
  Arbitrum: { chain: arbitrum, coin: "ETH", env: "PORTFOLIO_RPC_ARBITRUM" },
  // Robinhood's own Arbitrum-stack chain (4663), where its Stock Tokens live: they are read here, and traded from the wallet against USDG
  // through LI.FI (dex.ts). No dollar in the table above runs on it, so the account's own payments do not
  "Robinhood Chain": { chain: robinhood, coin: "ETH", env: "PORTFOLIO_RPC_ROBINHOOD" },
};
export const CHAIN_BY_ID = new Map<number, ChainName>(Object.entries(CHAINS).map(([name, c]) => [c.chain.id, name as ChainName]));

/** the endpoint a chain is reached through: the one the owner chose, or the library's public default */
const endpointOf = (name: ChainName, env: Record<string, string | undefined>): string => env[CHAINS[name].env] || CHAINS[name].chain.rpcUrls.default.http[0]!;

/** The waits endpoints asked for (a 429's or a 418's Retry-After, an hour at most), by the endpoint's address: until then nothing is sent to
 * it, by the reader or by the sender. In memory only: a restart asks again */
const holds = new Map<string, number>();

/** a request not sent: the endpoint asked to be left alone until `until` */
class Held extends Error {
  constructor(readonly until: number) {
    super("held");
    this.name = "Held";
  }
}

/** The library's fetch, with the endpoint's wait taken out of its hands: a Retry-After on a 429 or a 418 is kept above as a hold and taken
 * off the answer, so the library backs off its own short while instead of sleeping inside a read for as long as the endpoint said; while
 * the hold lasts, nothing is sent and the read fails at once */
function heldFetch(url: string, base: typeof fetch | undefined): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const until = holds.get(url);
    if (until !== undefined && Date.now() < until) throw new Held(until);
    const r = await (base ?? globalThis.fetch)(input, init);
    if (r.status !== 429 && r.status !== 418) return r;
    const wait = retryAfterMs(r.headers.get("retry-after"));
    if (!wait) return r;
    holds.set(url, Math.max(holds.get(url) ?? 0, Date.now() + wait));
    const headers = new Headers(r.headers);
    headers.delete("retry-after");
    return new Response(r.body, { status: r.status, statusText: r.statusText, headers });
  }) as typeof fetch;
}

/** an error and what caused it, outermost first: the library wraps a transport's failure in a call's, and that in a contract's */
const causes = (err: unknown): unknown[] => {
  const out: unknown[] = [];
  for (let e = err, i = 0; e && i < 8; e = (e as { cause?: unknown }).cause, i++) out.push(e);
  return out;
};
/** the text of what an endpoint answered in place of JSON-RPC (the library keeps it, quoted, as the error's details) */
const pageOf = (details: unknown): string => {
  const d = String(details ?? "");
  try {
    const v: unknown = JSON.parse(d);
    return typeof v === "string" ? v : d;
  } catch {
    return d;
  }
};

/** Why a chain's endpoint gave no answer, as a refusal in the account's words: asked this machine to wait (and until when), rate-limiting
 * it, refusing this network (HTTP 451, region words, an edge's page), down (5xx), not in time, not reachable, or a page in its place. Only
 * the status and an edge page's title are kept — never the page itself, which may print this machine's address — and never the endpoint's
 * URL, which may carry the owner's key for it */
export function endpointNo(chain: ChainName, err: unknown, venue?: string): Refusal {
  const name = `${chain}'s endpoint`;
  const all = causes(err);
  const say = (code: "E_VENUE_UNREACHABLE" | "E_VENUE_GEOBLOCKED", message: string, native: Record<string, unknown> = {}): Refusal => no(code, { ...(venue ? { venue } : {}), message, native: { endpoint: chain, ...native } });
  const held = all.find((e): e is Held => e instanceof Held);
  if (held) return say("E_VENUE_UNREACHABLE", `${name} asked this machine to wait until ${new Date(held.until).toISOString()}: it is not asked before then`, { status: 429, until: held.until });
  const h = all.find((e): e is HttpRequestError => e instanceof HttpRequestError && typeof e.status === "number");
  if (h?.status) {
    const s = h.status;
    const page = pageOf(h.details);
    if (s === 429) return say("E_VENUE_UNREACHABLE", `${name} is rate-limiting this machine (HTTP 429): it is asked again shortly`, { status: s });
    if (s === 418) return say("E_VENUE_UNREACHABLE", `${name} has banned this machine's address for too many requests (HTTP 418)`, { status: s, ban: true });
    if (s === 451 || REGION.test(page)) return say("E_VENUE_GEOBLOCKED", `${name} does not serve this location (HTTP ${s}): that is its own rule, and the account does not look for a way around it`, { status: s });
    if (edgeRefused(s, page)) return say("E_VENUE_GEOBLOCKED", edgeWords(name, s, page), { status: s, edge: true });
    return say("E_VENUE_UNREACHABLE", s >= 500 ? `${name} did not answer (HTTP ${s})` : `${name} refused the request (HTTP ${s})`, { status: s });
  }
  if (all.some((e) => e instanceof TimeoutError)) return say("E_VENUE_UNREACHABLE", `${name} did not answer in time`, { timeout: true });
  const code = all.map(transportCode).find(Boolean);
  if (code && /^(?:ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|SELF_SIGNED_|DEPTH_ZERO_|EPROTO$)/.test(code)) return say("E_VENUE_UNREACHABLE", `${name} could not be reached from this network: something on it answered in the endpoint's place, with a certificate that is not the endpoint's`, { code });
  if (code) return say("E_VENUE_UNREACHABLE", `${name} could not be reached (${code})`, { code });
  // a 2xx that is not JSON-RPC: a filtering network's page, a captive portal
  if (all.some((e) => e instanceof SyntaxError)) return say("E_VENUE_UNREACHABLE", notTheApiWords(name), { page: true });
  const rpc = all.find((e): e is RpcError | RpcRequestError => (e instanceof RpcError || e instanceof RpcRequestError) && typeof e.code === "number");
  if (rpc && (rpc.code === -32005 || rpc.code === 429 || rpc.code === -32007)) return say("E_VENUE_UNREACHABLE", `${name} is rate-limiting this machine (JSON-RPC ${rpc.code}): it is asked again shortly`, { rpc: rpc.code });
  if (rpc) return say("E_VENUE_UNREACHABLE", `${name} answered with an error (JSON-RPC ${rpc.code})`, { rpc: rpc.code });
  return say("E_VENUE_UNREACHABLE", `${name} did not answer`);
}

/** the library's error is the endpoint not answering (or refusing this network), not the chain answering about the call */
const unanswered = (err: unknown): boolean => causes(err).some((e) => e instanceof Held || e instanceof HttpRequestError || e instanceof TimeoutError || ((e instanceof RpcError || e instanceof RpcRequestError) && (e.code === -32005 || e.code === 429 || e.code === -32007)));

export function publicChain(env: Record<string, string | undefined> = process.env, opts: { fetch?: typeof fetch | undefined } = {}): ChainReader {
  const clients = new Map<ChainName, PublicClient>();
  const client = (name: ChainName): PublicClient => {
    let c = clients.get(name);
    if (!c) {
      const { chain } = CHAINS[name];
      // an endpoint the owner chose, or the library's public default; a wait it asks for is a hold here, not a sleep in the library
      const url = endpointOf(name, env);
      c = createPublicClient({ chain, transport: http(url, { timeout: 9_000, retryCount: 1, fetchFn: heldFetch(url, opts.fetch) }) }) as PublicClient;
      clients.set(name, c);
    }
    return c;
  };
  const perChain = async <T>(names: ChainName[], read: (name: ChainName) => Promise<T[]>): Promise<{ rows: T[]; failed: ChainName[]; said?: Partial<Record<ChainName, string>> }> => {
    const failed: ChainName[] = [];
    const said: Partial<Record<ChainName, string>> = {};
    const rows = (await Promise.all(names.map((n) => read(n).catch((err: unknown) => (failed.push(n), (said[n] = endpointNo(n, err).message), [] as T[]))))).flat();
    return { rows, failed, ...(failed.length ? { said } : {}) };
  };
  return {
    tokens(holder, refs) {
      const names = [...new Set(refs.map((r) => r.chain))];
      return perChain(names, async (name) => {
        const mine = refs.filter((r) => r.chain === name);
        // one request per chain: each token's balance and its own decimals
        const answers = await client(name).multicall({ allowFailure: true, contracts: mine.flatMap((r) => [{ address: r.address, abi: erc20Abi, functionName: "balanceOf", args: [holder] } as const, { address: r.address, abi: erc20Abi, functionName: "decimals" } as const]) });
        // the request itself failing (a refusal, a rate limit, no answer) comes back as every call "failing" with the aggregate's error: that
        // is the chain not answering, and it is named — never read as a wallet holding nothing. A token's own call reverting is dropped
        const down = answers.find((a) => a.status === "failure" && (a.error as { functionName?: unknown } | undefined)?.functionName === "aggregate3");
        if (down) throw down.error;
        return mine.flatMap((r, i): ChainBalance[] => {
          const bal = answers[2 * i];
          const dec = answers[2 * i + 1];
          if (bal?.status !== "success" || dec?.status !== "success") return [];
          return [{ chain: name, asset: r.asset, amount: Number(formatUnits(bal.result as bigint, Number(dec.result))) }];
        });
      });
    },
    native(holder, chains) {
      return perChain(chains, async (name) => [{ chain: name, asset: CHAINS[name].coin, amount: Number(formatUnits(await client(name).getBalance({ address: holder }), 18)) }]);
    },
    async decimals(chain, token) {
      try {
        return Number(await client(chain).readContract({ address: token, abi: erc20Abi, functionName: "decimals" }));
      } catch {
        return undefined;
      }
    },
    async symbol(chain, token) {
      try {
        const out = await client(chain).readContract({ address: token, abi: erc20Abi, functionName: "symbol" });
        return typeof out === "string" && out.length <= 40 ? out : undefined;
      } catch {
        return undefined;
      }
    },
    // "not found" is the chain's answer, and is undefined; an endpoint that did not answer, or refused this network, is not that answer: it
    // is thrown, in its own words, so a sent transaction is not told as "not on chain yet" while nobody could look
    async receipt(chain, hash) {
      try {
        const r = await client(chain).getTransactionReceipt({ hash });
        return { status: r.status, from: r.from, to: r.to, logs: r.logs.map((l) => ({ address: l.address, topics: [...l.topics] as Hex[], data: l.data })) };
      } catch (err) {
        if (causes(err).some((e) => e instanceof TransactionReceiptNotFoundError)) return undefined;
        throw endpointNo(chain, err);
      }
    },
    async transaction(chain, hash) {
      try {
        const t = await client(chain).getTransaction({ hash });
        return { from: t.from, to: t.to ?? null, data: t.input, value: t.value, ...(t.chainId !== undefined ? { chainId: t.chainId } : {}) };
      } catch (err) {
        if (causes(err).some((e) => e instanceof TransactionNotFoundError)) return undefined;
        throw endpointNo(chain, err);
      }
    },
    async nonce(chain, address) {
      try {
        return await client(chain).getTransactionCount({ address, blockTag: "latest" });
      } catch {
        return undefined;
      }
    },
    async authorizationUsed(chain, token, authorizer, nonce) {
      try {
        return Boolean(await client(chain).readContract({ address: token, abi: parseAbi(["function authorizationState(address authorizer, bytes32 nonce) view returns (bool)"]), functionName: "authorizationState", args: [authorizer, nonce] }));
      } catch {
        return undefined;
      }
    },
    async uint(chain, address, signature, args = []) {
      try {
        const abi = parseAbi([signature]);
        const name = /function\s+(\w+)/.exec(signature)?.[1] ?? "";
        const out = await client(chain).readContract({ address, abi, functionName: name, args } as never);
        return typeof out === "bigint" ? out : undefined;
      } catch {
        return undefined;
      }
    },
  };
}

/** the node's own words for a no: a JSON-RPC error's message ("nonce too low"), or the library's short sentence — never its long message,
 * which names the endpoint's URL (and with it any key the owner put in that URL). Nothing that could carry the wallet's key is in either */
const nodeWords = (err: unknown): string => {
  const rpc = causes(err).find((e) => e instanceof RpcError || e instanceof RpcRequestError) as { details?: unknown } | undefined;
  const e = err as { shortMessage?: unknown; message?: unknown } | undefined;
  return String(typeof rpc?.details === "string" && rpc.details ? rpc.details : typeof e?.shortMessage === "string" ? e.shortMessage : (e?.message ?? err)).slice(0, 200);
};

/** What a failed broadcast says about the transfer: the node took it after all ("already known"); the node, or the endpoint before it, said
 * no (a JSON-RPC error, a 4xx); nothing was sent (no connection was made, or the endpoint's hold stood) — or the answer was lost after the
 * transaction went out (a timeout, a gateway's 5xx, a cut connection, a page in the node's place, an internal error), and the node may have it */
function broadcastFailed(chain: ChainName, err: unknown): { taken: true } | { refused: string } | { notSent: string } | { lost: string } {
  const all = causes(err);
  const rpc = all.find((e): e is RpcError | RpcRequestError => (e instanceof RpcError || e instanceof RpcRequestError) && typeof e.code === "number");
  if (rpc) {
    if (/already known|known transaction|already imported|alreadyknown/i.test(nodeWords(rpc))) return { taken: true };
    // an internal or unknown error says nothing of whether the node kept the transaction
    return rpc instanceof InternalRpcError || rpc instanceof UnknownRpcError || rpc.code === -32603 ? { lost: endpointNo(chain, err).message } : { refused: nodeWords(rpc) };
  }
  if (all.some((e) => e instanceof Held)) return { notSent: endpointNo(chain, err).message };
  const h = all.find((e): e is HttpRequestError => e instanceof HttpRequestError && typeof e.status === "number");
  if (h?.status && h.status >= 400 && h.status < 500 && h.status !== 408) return { refused: endpointNo(chain, err).message };
  const code = all.map(transportCode).find(Boolean);
  if (!h?.status && code && /^(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|SELF_SIGNED_|DEPTH_ZERO_)/.test(code)) return { notSent: endpointNo(chain, err).message };
  return { lost: endpointNo(chain, err).message };
}

/** The one thing this file sends: a token transfer signed by a key the account holds, through the same endpoints the reader uses. It is
 * prepared and signed HERE, and its hash worked out before anything is sent: a broadcast whose answer never comes back is then a transfer
 * followed by that hash (`answerLost`), not one told as refused — told so, it would be asked again and paid twice. Before signing, the
 * nonce the chain has mined is read: an earlier transfer still waiting to be mined means nothing new is signed over it */
export function publicSender(env: Record<string, string | undefined> = process.env, opts: { fetch?: typeof fetch | undefined } = {}): ChainSender {
  return {
    async transfer({ chain, account, token, to, units }) {
      const { chain: c } = CHAINS[chain];
      const url = endpointOf(chain, env);
      const wallet = createWalletClient({ account, chain: c, transport: http(url, { timeout: 15_000, retryCount: 0, fetchFn: heldFetch(url, opts.fetch) }) });
      let serialized: Hex;
      let nonce: number;
      try {
        const request = await wallet.prepareTransactionRequest({ account, chain: c, to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, units] }) });
        nonce = request.nonce;
        const mined = await getTransactionCount(wallet, { address: account.address, blockTag: "latest" });
        if (nonce > mined) return { error: `an earlier transfer from this wallet is still waiting to be mined on ${chain}: nothing new is signed until it is`, inFlight: true };
        serialized = await account.signTransaction(request as never, { serializer: c.serializers?.transaction as never });
      } catch (err) {
        // nothing has been sent: an endpoint that did not answer is said as that, a node refusing the transfer (a revert, no gas) in its words
        return unanswered(err) ? { error: endpointNo(chain, err).message, unanswered: true } : { error: nodeWords(err) };
      }
      const hash = keccak256(serialized);
      try {
        await wallet.sendRawTransaction({ serializedTransaction: serialized });
        return { hash, nonce };
      } catch (err) {
        const f = broadcastFailed(chain, err);
        if ("taken" in f) return { hash, nonce };
        if ("refused" in f) return { error: f.refused };
        if ("notSent" in f) return { error: f.notSent, unanswered: true };
        return { hash, nonce, answerLost: true, said: f.lost };
      }
    },
  };
}
