/** Reading an address from the chains it can hold dollars on.
 *
 * Six EVM chains, each through a public JSON-RPC endpoint (the ones the `viem` library ships as defaults; `PORTFOLIO_RPC_<CHAIN>` puts
 * your own in its place — public endpoints are rate-limited, and whoever runs one sees the address asked about and the machine asking).
 * A token's decimals are read from the token itself rather than assumed: the same dollar is 6 decimals on one chain and 18 on another.
 * A chain that does not answer is left out and named, so one slow endpoint does not blank the wallet.
 *
 * Only `eth_call` and `eth_getBalance` are ever sent: nothing here can sign, and nothing here sends a transaction.
 */
import { createPublicClient, erc20Abi, formatUnits, http, parseAbi, type Chain, type Hex, type PublicClient } from "viem";

/** a mined transaction, as much of it as a payment needs */
export interface Mined {
  status: "success" | "reverted";
  from: Hex;
  to: Hex | null;
  logs: Array<{ address: Hex; topics: Hex[]; data: Hex }>;
}
import { arbitrum, base, bsc, mainnet, optimism, polygon } from "viem/chains";

export type ChainName = "Ethereum" | "Optimism" | "BNB Chain" | "Polygon" | "Base" | "Arbitrum";

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

export interface ChainReader {
  /** token balances of one holder, in whole tokens; `failed` names the chains that did not answer */
  tokens(holder: Hex, refs: TokenRef[]): Promise<{ rows: ChainBalance[]; failed: ChainName[] }>;
  /** each chain's own coin */
  native(holder: Hex, chains: ChainName[]): Promise<{ rows: ChainBalance[]; failed: ChainName[] }>;
  /** one read-only call that answers a uint256 (a price oracle); `undefined` when it reverts or the chain does not answer */
  uint(chain: ChainName, address: Hex, signature: string, args?: unknown[]): Promise<bigint | undefined>;
  /** a token's own decimals; `undefined` when the chain does not answer */
  decimals(chain: ChainName, token: Hex): Promise<number | undefined>;
  /** a transaction once it is mined; `undefined` while it is not (or the chain does not answer) */
  receipt(chain: ChainName, hash: Hex): Promise<Mined | undefined>;
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
};
export const CHAIN_BY_ID = new Map<number, ChainName>(Object.entries(CHAINS).map(([name, c]) => [c.chain.id, name as ChainName]));

export function publicChain(env: Record<string, string | undefined> = process.env): ChainReader {
  const clients = new Map<ChainName, PublicClient>();
  const client = (name: ChainName): PublicClient => {
    let c = clients.get(name);
    if (!c) {
      const { chain, env: key } = CHAINS[name];
      // an endpoint the owner chose, or the library's public default
      c = createPublicClient({ chain, transport: http(env[key] || undefined, { timeout: 9_000, retryCount: 1 }) }) as PublicClient;
      clients.set(name, c);
    }
    return c;
  };
  const perChain = async <T>(names: ChainName[], read: (name: ChainName) => Promise<T[]>): Promise<{ rows: T[]; failed: ChainName[] }> => {
    const failed: ChainName[] = [];
    const rows = (await Promise.all(names.map((n) => read(n).catch(() => (failed.push(n), [] as T[]))))).flat();
    return { rows, failed };
  };
  return {
    tokens(holder, refs) {
      const names = [...new Set(refs.map((r) => r.chain))];
      return perChain(names, async (name) => {
        const mine = refs.filter((r) => r.chain === name);
        // one request per chain: each token's balance and its own decimals
        const answers = await client(name).multicall({ allowFailure: true, contracts: mine.flatMap((r) => [{ address: r.address, abi: erc20Abi, functionName: "balanceOf", args: [holder] } as const, { address: r.address, abi: erc20Abi, functionName: "decimals" } as const]) });
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
    async receipt(chain, hash) {
      try {
        const r = await client(chain).getTransactionReceipt({ hash });
        return { status: r.status, from: r.from, to: r.to, logs: r.logs.map((l) => ({ address: l.address, topics: [...l.topics] as Hex[], data: l.data })) };
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
