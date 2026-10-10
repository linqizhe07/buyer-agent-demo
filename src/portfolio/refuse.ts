/** Refusals in English — the portfolio manager's interface language.
 *
 * The codes and layers are the repo's (core/errors.ts); the default sentences
 * in that table are Chinese, the narrative language of the original demo. A
 * refusal raised in this subsystem reaches people through the page and through
 * whatever agent is talking to them over MCP, so every one of them is raised
 * through `no()`, which supplies the English sentence. */
import { isIPv6 } from "node:net";
import { refuse, type Code, type Refusal } from "../core/errors.ts";

const EN: Partial<Record<Code, string>> = {
  E_WALLET_ACCOUNT_UNKNOWN: "the portfolio wallet does not know this account",
  E_WALLET_ACCOUNT_REVOKED: "this account is switched off for the agent: reads only",
  E_WALLET_SCOPE: "the credential itself cannot do this: no wallet setting can open it, and the venue would refuse too",
  E_WALLET_REACH: "the user has not opened this action to the agent",
  E_WALLET_BLOCKLIST: "the destination is on the user's blocklist",
  E_WALLET_LIVE_WRITES_OFF: "real-money writes are off in this build: the command is printed, not run",
  E_WALLET_SESSION_EXPIRED: "the agent's session has ended: writes stop, reads continue",
  E_WALLET_DAILY_CAP: "over the wallet's 24-hour cap",
  E_VENUE_PERMISSION: "the credential lacks this permission at the venue",
  E_VENUE_WITHDRAW_WHITELIST: "the address is not on the venue's withdrawal whitelist",
  E_VENUE_REJECTED: "the venue rejected the request",
  E_VENUE_TRANSFER_RESTRICTED: "transfer restricted by the issuer: the recipient is not on the KYC allowlist, the contract reverts",
  E_VENUE_INSUFFICIENT: "not enough balance at the venue",
  E_VENUE_GEOBLOCKED: "the venue does not take orders from this region",
  E_VENUE_MARKET_CLOSED: "the market is closed: it takes no orders now",
  E_VENUE_ORDER_INVALID: "the market does not take this order as written: its size, step or price",
  E_ACCOUNT_ORDER_UNKNOWN: "there is no open order of that id on the account, or it is not this key's",
  E_CARD_REJECTED: "the human rejected this card; the agent gets a clean refusal and does not retry",
  E_CARD_NOT_GRANTED: "no pending card with this id",
  E_VENUE_AGENT_NO_WITHDRAW: "an agent key cannot withdraw here: only the account holder's own signature can",
  E_VENUE_MIN_DEPOSIT: "below the venue's minimum: the venue would not credit it, so it is not sent",
  E_VENUE_RAIL_CLOSED: "this runway is closed",
  E_VENUE_CURRENCY: "the venue does not take this currency: swap first",
  E_VENUE_UNREACHABLE: "the venue did not answer",
  E_ACCOUNT_BAD_SIGNATURE: "the signature does not match the instruction",
  E_ACCOUNT_UNKNOWN_SIGNER: "this key is not authorised on the account",
  E_ACCOUNT_AGENT_EXPIRED: "the agent key has expired",
  E_ACCOUNT_AGENT_REVOKED: "the agent key was revoked",
  E_ACCOUNT_OWNER_ONLY: "only the owner's key can sign this: an agent key cannot withdraw, send, approve or change the account",
  E_ACCOUNT_OWNER_SURFACE: "this needs the owner's device: it cannot come from an agent or from another process",
  E_ACCOUNT_NOT_HOME: "an agent key moves money only between the user's own venues",
  E_ACCOUNT_NONCE: "the nonce was used before or is outside the time window",
  E_ACCOUNT_EXPIRED: "the instruction has expired: a money instruction is good for minutes, not days",
  E_ACCOUNT_THRESHOLD: "not enough signers for this account",
  E_ACCOUNT_FEE_CAP: "the fee is above the rate the owner approved for this app",
  E_ACCOUNT_LIMIT: "over the account's limit",
  E_ACCOUNT_DESTINATION: "the destination is not in the address book for this chain",
  E_ACCOUNT_DEST_COOLING: "a new destination can be used 24 hours after it was added",
  E_ACCOUNT_SOURCE: "no source was named, or none is open",
  E_ACCOUNT_REQUOTE: "the route, the fee or the arrival changed since this was signed: it needs a new signature",
  E_ACCOUNT_CARD_EXPIRED: "the card has expired",
  E_ACCOUNT_BAD_ACTION: "the instruction is malformed",
  E_ACCOUNT_UNPRICED: "this asset has no price here, so no limit can be judged",
  E_ACCOUNT_CREDENTIAL: "the credential this connection needs is not where it was said to be, or cannot be used",
  E_MANDATE_NONE: "no spending approval covers this",
  E_MANDATE_EXPIRED: "the spending approval has expired",
  E_MANDATE_RECIPIENT: "the payee is not in the spending approval",
  E_MANDATE_PER_ORDER_CAP: "above the approval's per-payment maximum",
  E_MANDATE_RATE: "too soon: the approval allows one refill per window",
  E_MANDATE_BUDGET: "the spending approval's budget is used up",
  E_MANDATE_INVALID: "the mandate chain does not hold: the closed mandate does not match the open one or this checkout",
  E_WALLET_FLOAT_CAP: "over the float this sub-account may hold",
  E_WALLET_INSUFFICIENT: "not enough in the sub-account",
  E_PAYEE_CHANGED: "the payee's receiving address is not the one pinned for this host",
  E_PAYEE_OVERCHARGE: "the payee asked for more than was authorised",
  E_PAYEE_REJECTED: "the payee rejected the payment credential",
  E_PAYEE_UNVERIFIED: "the payee's challenge or receipt does not verify",
  E_PAYEE_UNSUPPORTED: "the payee offers no payment method this account supports",
  E_PAYEE_REDIRECT: "the payee redirected the request elsewhere: not followed",
};

export function no(code: Code, extra: { venue?: string; tool?: string; detail?: Record<string, unknown>; native?: unknown; message?: string } = {}): Refusal {
  const message = extra.message ?? EN[code];
  // a venue that repeats the address this machine reached it from (OKX's and MEXC's IP-list answers do, an edge's error page may) has it
  // taken out here, where every refusal is made: a refusal is logged and lands in the ledger, and an address says where the user is
  const clean = { ...extra, ...(extra.native !== undefined ? { native: unaddressedDeep(extra.native) } : {}), ...(extra.detail !== undefined ? { detail: unaddressedDeep(extra.detail) as Record<string, unknown> } : {}) };
  return refuse(code, message === undefined ? clean : { ...clean, message: unaddressed(message) });
}

/** a public network address (IPv4, or IPv6) in a venue's words, as "this machine's address"; a loopback or private one says nothing about
 * where the user is and stays */
// an IPv4 address with no digit or dotted digit run touching it: "ip_<addr>" and "IP<addr>" are still found, a longer dotted number is not
const IPV4 = /(?<![\d.])(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}(?!\d|\.\d)/g;
// a run of hex digits, colons and dots with at least two colons: the IPv6 address in it, if any, is the longest part of it that starts at its
// beginning or just after a colon and is one ("IP:<addr>", "whitelist:<addr>" are found)
const V6_RUN = /[0-9a-f:.]*:[0-9a-f:.]*:[0-9a-f:.]*/gi;
const PRIVATE_V4 = /^(?:127\.|10\.|0\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/;
const saysNothing6 = (ip: string): boolean => /^(?:::1$|fe80:|f[cd][0-9a-f]{2}:)/i.test(ip) || ip.split(":").filter(Boolean).length < 3;
function scrub6(run: string): string {
  for (let i = 0; i < run.length; i++) {
    if (i > 0 && run[i - 1] !== ":") continue;
    // trailing punctuation is the sentence's, not the address's; an address is at most 45 characters
    for (let end = Math.min(run.length, i + 45); end > i; end--) {
      const ip = run.slice(i, end);
      if (/[.:]$/.test(ip) && !ip.endsWith("::")) continue;
      if (isIPv6(ip)) return saysNothing6(ip) ? run : `${run.slice(0, i)}(this machine's address)${run.slice(end)}`;
    }
  }
  return run;
}
export function unaddressed(text: string): string {
  if (typeof text !== "string" || !/[.:]/.test(text)) return text;
  return text.replace(IPV4, (ip) => (PRIVATE_V4.test(ip) ? ip : "(this machine's address)")).replace(V6_RUN, scrub6);
}
const unaddressedDeep = (v: unknown, depth = 0): unknown => {
  if (typeof v === "string") return unaddressed(v);
  if (depth > 6 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => unaddressedDeep(x, depth + 1));
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, unaddressedDeep(x, depth + 1)]));
};
