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
 *
 * A read in part is never kept as a whole one: a chain that does not answer this time (its endpoint refusing or rate-limiting this machine)
 * keeps what it last said, marked as not read this time (`unread()` says which), so an agent wallet's dollars never vanish because this
 * network was refused one answer.
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

/** a row kept from the last read that answered, said as not read this time */
const notRead = (b: LiveBalance, why: string): LiveBalance => ({ ...b, where: `${b.where ?? ""}${b.where ? " · " : ""}not read this time: ${why}` });

export async function agentWalletSource(req: AgentWalletRequest): Promise<{ source: LiveSource; first: LiveBalance[] } | Refusal> {
  const address = req.key.account.address as Hex;
  const name = req.label || "Agent wallet";
  /** the chains the last read could not read, each in its endpoint's words where the reader gave them */
  let unread: string[] = [];
  /** the last rows each part gave when it answered — a chain's dollars, its own coin — kept for a read in which it does not */
  const last = new Map<string, LiveBalance[]>();
  const read = async (): Promise<LiveBalance[]> => {
    const [tokens, coins] = await Promise.all([req.chain.tokens(address, TOKENS), req.chain.native(address, AGENT_CHAINS)]);
    // a chain is not read when either of its reads failed; what its endpoint said, where the reader can say (rate-limiting this machine,
    // refusing this network), or else that it did not answer
    const why = (c: ChainName): string => tokens.said?.[c] ?? coins.said?.[c] ?? `${c} did not answer`;
    const down = AGENT_CHAINS.filter((c) => tokens.failed.includes(c) || coins.failed.includes(c));
    if (down.length === AGENT_CHAINS.length) throw no("E_VENUE_UNREACHABLE", { venue: req.venue, message: `none of the chains answered: ${[...new Set(down.filter((c) => tokens.said?.[c] ?? coins.said?.[c]).map(why))].slice(0, 2).join("; ") || "the public endpoints may be rate-limiting this machine"}` });
    unread = down.map(why);
    const out: LiveBalance[] = [];
    const held = (rows: Array<{ chain: ChainName; asset: string; amount: number }>, c: ChainName): LiveBalance[] => rows.filter((b) => b.chain === c && b.amount > 0).map((b) => ({ asset: b.asset, amount: b.amount, where: b.chain }));
    for (const c of AGENT_CHAINS) {
      for (const [key, failed, rows] of [[`tokens:${c}`, tokens.failed.includes(c), held(tokens.rows, c)], [`coin:${c}`, coins.failed.includes(c), held(coins.rows, c)]] as const) {
        if (!failed) {
          last.set(key, rows);
          out.push(...rows);
        } else out.push(...(last.get(key) ?? []).map((b) => notRead(b, why(c))));
      }
    }
    return out;
  };
  const base = walletWriter(address, req.chain);
  /** sends whose answer was lost, by hash: the nonce each was signed with, so the chain can say once it has mined another in its place */
  const lost = new Map<string, { chain: ChainName; nonce: number }>();
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
      if (gas.failed.length) return no("E_VENUE_UNREACHABLE", { venue: req.venue, message: `${r.network} did not answer${gas.said?.[r.network] ? ` (${gas.said[r.network]})` : ""}` });
      if (!(coin > 0)) return no("E_WALLET_INSUFFICIENT", { venue: req.venue, message: `${name} has no ${CHAINS[r.network].coin} on ${r.network} to pay the transfer's gas: send it a little (a dollar's worth is plenty) and try again`, detail: { network: r.network, coin: CHAINS[r.network].coin } });
      const units = parseUnits(String(r.amount), decimals);
      const sent = await req.sender.transfer({ chain: r.network, account: req.key.account, token: t.address, to: r.to, units });
      if ("error" in sent) {
        // nothing was sent: the endpoint did not answer before, or an earlier send is still waiting to be mined — not the chain saying no
        if (sent.unanswered || sent.inFlight) return no("E_VENUE_UNREACHABLE", { venue: req.venue, message: `nothing was sent: ${sent.error}`, native: { error: sent.error, ...(sent.inFlight ? { inFlight: true } : {}) } });
        return no("E_VENUE_REJECTED", { venue: req.venue, message: `${r.network} did not take the transfer: ${sent.error}`, native: { error: sent.error } });
      }
      const native = { hash: sent.hash, chain: r.network, token: t.address, to: r.to, amount: formatUnits(units, decimals), ...(sent.nonce !== undefined ? { nonce: sent.nonce } : {}) };
      if (!sent.answerLost) return { ref: sent.hash, status: "pending", native };
      // sent, and its answer lost: the node may have it. A pending payment followed by its hash (live-moves), the agent's limit charged, and
      // never sent again — a retry would be a second transfer beside the first
      if (sent.nonce !== undefined) lost.set(sent.hash.toLowerCase(), { chain: r.network, nonce: sent.nonce });
      return { ref: sent.hash, status: "pending", native: { ...native, answerLost: true, unsure: true, said: `the transfer was signed and sent as ${sent.hash.slice(0, 10)}…, and ${sent.said ?? `${r.network}'s endpoint did not answer`}: it is followed by its hash, not sent again` } };
    },
    /** the chain's word on a send: its receipt (walletWriter's check, transfer by transfer). An endpoint that does not answer leaves it on its
     * way. A send whose answer was lost and that the chain never shows is failed only once the chain has mined another transaction of this
     * wallet's at its nonce — then it never can be — and not on a guess about time */
    async confirm(hash, expected) {
      let seen: Awaited<ReturnType<NonNullable<LiveWriter["confirm"]>>>;
      try {
        seen = await base.confirm!(hash, expected);
      } catch {
        return "pending";
      }
      const was = lost.get(hash.toLowerCase());
      if (seen !== "pending" || !was || !req.chain.nonce) {
        if (seen !== "pending") lost.delete(hash.toLowerCase());
        return seen;
      }
      const mined = await req.chain.nonce(was.chain, address);
      if (mined === undefined || mined <= was.nonce) return "pending";
      // mined just now, between the two reads?
      try {
        if (await req.chain.receipt(was.chain, hash)) return await base.confirm!(hash, expected);
      } catch {
        return "pending";
      }
      lost.delete(hash.toLowerCase());
      return no("E_VENUE_REJECTED", { venue: req.venue, message: `${was.chain} never mined ${hash.slice(0, 10)}…: another transaction from ${name} took its place (nonce ${was.nonce}), so this transfer did not happen`, native: { hash, nonce: was.nonce } });
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
      noTradeBecause: "An agent wallet pays for things; agents trade at the venues it funds.",
      probe: { can: ["pay", "send"], note: `this account holds its key: agents pay from it inside their payees limit, and a send out pays its gas in each chain's own coin · dollar stablecoins and gas on ${AGENT_CHAINS.join(", ")}`, native: { address, chains: AGENT_CHAINS } },
      read,
      unread: () => (unread.length ? `not read this time (kept from the last read): ${unread.join("; ")}` : undefined),
    };
    return { source, first };
  } catch (err) {
    return isRefusal(err) ? err : asRefusal(req.venue, name, err);
  }
}
