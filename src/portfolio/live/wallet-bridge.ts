/** A proven wallet's way ACROSS CHAINS: the routes LI.FI finds for the user's dollars, the check that the hash the wallet reports is the
 * transaction that was built, and what became of the transfer. The rules a route must pass are bridge.ts's; this only binds them to one
 * wallet, its chain reader and the network, so the account's money door (account/live-moves.ts) can ask for them by venue. */
import type { Hex } from "viem";
import type { Refusal } from "../../core/errors.ts";
import { BRIDGE_CHAINS, bridgeRoutes, bridgeStatus, confirmSent, type BridgeRoute, type BridgeStatus, type BridgeTx } from "./bridge.ts";
import type { ChainName, ChainReader } from "./chain.ts";
import type { Http } from "./types.ts";

export interface WalletBridge {
  chains: ChainName[];
  routes(r: { to: Hex; fromChain: ChainName; toChain: ChainName; asset: string; toAsset: string; amount: number }): Promise<BridgeRoute[] | Refusal>;
  confirm(hash: Hex, expected: BridgeTx): Promise<"pending" | "ok" | Refusal>;
  status(r: { hash: Hex; fromChain: ChainName; toChain: ChainName; tool?: string | undefined; to?: Hex | undefined }): Promise<BridgeStatus | Refusal>;
}

export function walletBridge(address: Hex, chain: ChainReader, http: Http, venue: string): WalletBridge {
  return {
    chains: BRIDGE_CHAINS,
    routes: (r) => bridgeRoutes({ http, from: address, to: r.to, fromChain: r.fromChain, toChain: r.toChain, asset: r.asset, toAsset: r.toAsset, amount: r.amount, chain, venue }),
    confirm: (hash, expected) => confirmSent({ chain, expected, hash, venue }),
    status: (r) => bridgeStatus({ http, hash: r.hash, fromChain: r.fromChain, toChain: r.toChain, tool: r.tool, from: address, to: r.to, chain, venue }),
  };
}
