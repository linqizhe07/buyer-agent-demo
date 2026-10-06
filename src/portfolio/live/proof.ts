/** Proof that an address is the user's: the wallet signs a sentence the account wrote.
 *
 * The sentence is a Sign-In with Ethereum message (EIP-4361): it names this page, the address, a nonce the account made, and when it was
 * issued and when it lapses. Signing it moves nothing and grants nothing; the wallet shows it as text. An address connected without this is
 * still readable — anyone can read an address — but it is shown as watched, not as the user's own.
 *
 * The time here is the real clock: a wallet does not follow the simulation's.
 */
import { randomBytes } from "node:crypto";
import { getAddress, isAddress, verifyMessage, type Hex } from "viem";
import type { Refusal } from "../../core/errors.ts";
import { no } from "../refuse.ts";

const TTL_MS = 10 * 60_000;

export interface Challenge {
  address: Hex;
  message: string;
  nonce: string;
  expiresAt: number;
}

export interface Proof {
  address: Hex;
  wallet: string;
  at: number;
  /** the sentence and the wallet's signature over it: kept with the connection, so a restarted account can check the proof again */
  message?: string | undefined;
  signature?: Hex | undefined;
  /** brought back from the connection's row after a restart (and checked again there): it does not lapse */
  kept?: boolean | undefined;
}

export function siweMessage(f: { domain: string; address: Hex; statement: string; uri: string; chainId: number; nonce: string; issuedAt: string; expirationTime: string }): string {
  return `${f.domain} wants you to sign in with your Ethereum account:\n${f.address}\n\n${f.statement}\n\nURI: ${f.uri}\nVersion: 1\nChain ID: ${f.chainId}\nNonce: ${f.nonce}\nIssued At: ${f.issuedAt}\nExpiration Time: ${f.expirationTime}`;
}

export class WalletProofs {
  private readonly open = new Map<string, Challenge & { wallet: string }>();
  private readonly done = new Map<string, Proof>();

  constructor(private readonly clock: () => number = Date.now) {}

  /** the sentence for this address to sign; one outstanding challenge per address */
  challenge(address: string, wallet: string, page: { domain: string; uri: string }, chainId = 1): Challenge | Refusal {
    if (!isAddress(address, { strict: false })) return no("E_ACCOUNT_BAD_ACTION", { message: "that is not an address" });
    const checksummed = getAddress(address);
    const now = this.clock();
    const nonce = randomBytes(12).toString("hex");
    const message = siweMessage({ domain: page.domain, address: checksummed, statement: "Show this wallet's balances on my account page. Read-only: this is not a transaction and it lets nothing be moved.", uri: page.uri, chainId: Number.isInteger(chainId) && chainId > 0 ? chainId : 1, nonce, issuedAt: new Date(now).toISOString(), expirationTime: new Date(now + TTL_MS).toISOString() });
    const c = { address: checksummed, message, nonce, expiresAt: now + TTL_MS, wallet: wallet.trim().slice(0, 40) || "wallet" };
    this.open.set(checksummed.toLowerCase(), c);
    return { address: c.address, message: c.message, nonce: c.nonce, expiresAt: c.expiresAt };
  }

  /** the wallet's signature over the sentence the account wrote for it — that sentence, not one the page sends back */
  async prove(address: string, signature: string): Promise<Proof | Refusal> {
    const key = String(address).toLowerCase();
    const c = this.open.get(key);
    if (!c) return no("E_ACCOUNT_BAD_ACTION", { message: "no sentence is waiting to be signed for that address: ask for one first" });
    if (this.clock() > c.expiresAt) {
      this.open.delete(key);
      return no("E_ACCOUNT_EXPIRED", { message: "the sentence to sign has lapsed: ask for a new one" });
    }
    if (!/^0x[0-9a-fA-F]+$/.test(signature)) return no("E_ACCOUNT_BAD_SIGNATURE", { message: "that is not a signature" });
    let ok = false;
    try {
      ok = await verifyMessage({ address: c.address, message: c.message, signature: signature as Hex });
    } catch {
      ok = false;
    }
    // an ordinary key's signature is checked here; a contract wallet's would need the chain, and is left as "watched"
    if (!ok) return no("E_ACCOUNT_BAD_SIGNATURE", { message: "the signature is not that address's over the sentence it was given. A contract wallet cannot be proven this way: connect it by its address, and it is shown as watched" });
    this.open.delete(key);
    const proof: Proof = { address: c.address, wallet: c.wallet, at: this.clock(), message: c.message, signature: signature as Hex };
    this.done.set(key, proof);
    return proof;
  }

  /** a proof given in the last ten minutes, or one a restart brought back with its connection */
  proven(address: string): Proof | undefined {
    const p = this.done.get(String(address).toLowerCase());
    return p && (p.kept || this.clock() - p.at <= TTL_MS) ? p : undefined;
  }

  /** a proof kept on a connection's row, ALREADY checked again by the caller (account/restore.ts `proofHolds`) */
  keep(p: { address: Hex; wallet: string; at: number; message: string; signature: Hex }): void {
    this.done.set(p.address.toLowerCase(), { ...p, kept: true });
  }
}
