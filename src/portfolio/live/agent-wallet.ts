/** An AGENT WALLET: a wallet the account itself holds the key of (account/keystore.ts), made when the owner signs one into being, so that
 * an agent can pay for things without the owner there — x402, an MPP charge — from money the owner put in it, and nothing more.
 *
 * Read like any wallet, from the chains: its dollar stablecoins, and each chain's own coin (what a transfer OUT of it pays its gas with).
 * Money comes in the way it comes into any place of the user's: a withdrawal from an exchange, a send from the owner's own wallet, a
 * bridge. Money goes out two ways only:
 *   - a PAYMENT an agent asked for, inside its payees limit (account/pay-real.ts): an EIP-3009 authorisation this key signs, which the
 *     payee's facilitator settles — no gas from here;
 *   - a SEND to another place of the user's (the owner taking money back, or an agent inside its limit between the user's own places):
 *     a token transfer this key signs and sends, paying its gas in the chain's own coin. With none of that coin on the chain, nothing goes.
 * It places no orders: an agent trades at the venues.
 */
import { formatUnits, parseUnits, type Hex } from "viem";
import { isRefusal, type Refusal } from "../../core/errors.ts";
import { no } from "../refuse.ts";
import type { SimKey } from "../account/sign.ts";
import { CHAINS, STABLECOINS, type ChainName, type ChainReader, type ChainSender } from "./chain.ts";
import { asRefusal, type LiveBalance, type LiveSource } from "./types.ts";
import { tokenOn, walletWriter, type LiveWriter } from "./writes.ts";

/** where an agent wallet holds and pays dollars: the chains that carry Circle's USDC (BNB Chain's is another issuer's) */
export const AGENT_CHAINS: ChainName[] = ["Base", "Arbitrum", "Optimism", "Polygon", "Ethereum"];
const TOKENS = STABLECOINS.filter((t) => AGENT_CHAINS.includes(t.chain));

export const agentWalletVenue = (name: string): string => `agent-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`;

export interface AgentWalletRequest {
  venue: string;
  label: string;
  key: SimKey;
  chain: ChainReader;
  sender: ChainSender;
}

export async function agentWalletSource(req: AgentWalletRequest): Promise<{ source: LiveSource; first: LiveBalance[] } | Refusal> {
  const address = req.key.account.address as Hex;
  const name = req.label || "Agent wallet";
  const read = async (): Promise<LiveBalance[]> => {
    const [tokens, coins] = await Promise.all([req.chain.tokens(address, TOKENS), req.chain.native(address, AGENT_CHAINS)]);
    if (tokens.failed.length === AGENT_CHAINS.length) throw no("E_VENUE_UNREACHABLE", { venue: req.venue, message: "none of the chains answered: the public endpoints may be rate-limiting this machine" });
    return [...tokens.rows, ...coins.rows].filter((b) => b.amount > 0).map((b) => ({ asset: b.asset, amount: b.amount, where: b.chain }));
  };
  const base = walletWriter(address, req.chain);
  const writer: LiveWriter = {
    ...base,
    can: { withdraw: false, ledgers: [], transfer: false, swap: false, receive: true, send: "account" },
    async send(r) {
      const t = tokenOn(r.asset, r.network);
      if (!t) return no("E_VENUE_CURRENCY", { venue: req.venue, message: `${r.asset} on ${r.network} is not a token this account knows` });
      const decimals = await req.chain.decimals(r.network, t.address);
      if (decimals === undefined) return no("E_VENUE_UNREACHABLE", { venue: req.venue, message: `${r.network} did not answer` });
      // a transfer out pays its gas in the chain's own coin: none there, nothing is sent (and nothing is signed)
      const gas = await req.chain.native(address, [r.network]);
      const coin = gas.rows[0]?.amount ?? 0;
      if (gas.failed.length) return no("E_VENUE_UNREACHABLE", { venue: req.venue, message: `${r.network} did not answer` });
      if (!(coin > 0)) return no("E_WALLET_INSUFFICIENT", { venue: req.venue, message: `${name} has no ${CHAINS[r.network].coin} on ${r.network} to pay the transfer's gas: send it a little (a dollar's worth is plenty) and try again`, detail: { network: r.network, coin: CHAINS[r.network].coin } });
      const units = parseUnits(String(r.amount), decimals);
      const sent = await req.sender.transfer({ chain: r.network, account: req.key.account, token: t.address, to: r.to, units });
      if ("error" in sent) return no("E_VENUE_REJECTED", { venue: req.venue, message: `${r.network} did not take the transfer: ${sent.error}`, native: { error: sent.error } });
      return { ref: sent.hash, status: "pending", native: { hash: sent.hash, chain: r.network, token: t.address, to: r.to, amount: formatUnits(units, decimals) } };
    },
  };
  try {
    const first = await read();
    const source: LiveSource = {
      name,
      kind: "agent-wallet",
      reference: address,
      via: "a wallet this account holds the key of · read from the chains",
      address,
      writer,
      noTradeBecause: "an agent wallet pays for things; agents trade at the venues",
      probe: { can: ["pay", "send"], note: `this account holds its key: agents pay from it inside their payees limit, and a send out pays its gas in each chain's own coin · dollar stablecoins and gas on ${AGENT_CHAINS.join(", ")}`, native: { address, chains: AGENT_CHAINS } },
      read,
    };
    return { source, first };
  } catch (err) {
    return isRefusal(err) ? err : asRefusal(req.venue, name, err);
  }
}
