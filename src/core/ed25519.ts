/** ed25519 with deterministic keys from a 32-byte seed (Node's crypto only).
 *
 * Stands in for Hyperliquid's EIP-712 signing and Solana's ed25519
 * transactions. Addresses are `0x` + the first 20 bytes of sha256(pubkey) for
 * the EVM-shaped venue and base58-free hex for the chain sim; the demo never
 * claims these are real address formats.
 */
import { createHash, createPrivateKey, createPublicKey, sign as nodeSign, verify as nodeVerify, type KeyObject } from "node:crypto";

const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface KeyPair {
  privateKey: KeyObject;
  /** raw 32-byte public key, hex */
  publicKeyHex: string;
}

export function keyFromSeed(seedHex: string): KeyPair {
  const seed = Buffer.from(seedHex, "hex");
  if (seed.length !== 32) throw new Error("an ed25519 seed is 32 bytes");
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" }) as Buffer;
  return { privateKey, publicKeyHex: spki.subarray(spki.length - 32).toString("hex") };
}

export function publicKeyFromHex(publicKeyHex: string): KeyObject {
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKeyHex, "hex")]), format: "der", type: "spki" });
}

export function sign(privateKey: KeyObject, message: string | Uint8Array): string {
  return nodeSign(null, typeof message === "string" ? Buffer.from(message, "utf8") : message, privateKey).toString("hex");
}

export function verify(publicKeyHex: string, message: string | Uint8Array, signatureHex: string): boolean {
  try {
    return nodeVerify(
      null,
      typeof message === "string" ? Buffer.from(message, "utf8") : message,
      publicKeyFromHex(publicKeyHex),
      Buffer.from(signatureHex, "hex"),
    );
  } catch {
    return false;
  }
}

/** `0x` + 20 bytes, derived from the public key (EVM-shaped, for the HL sim). */
export function evmAddressOf(publicKeyHex: string): string {
  return "0x" + createHash("sha256").update(Buffer.from(publicKeyHex, "hex")).digest("hex").slice(0, 40);
}

/** The chain sim's account id: the raw public key hex (Solana uses the pubkey as the address). */
export function chainAddressOf(publicKeyHex: string): string {
  return publicKeyHex;
}
