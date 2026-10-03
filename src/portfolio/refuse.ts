/** Refusals in English — the portfolio manager's interface language.
 *
 * The codes and layers are the repo's (core/errors.ts); the default sentences
 * in that table are Chinese, the narrative language of the original demo. A
 * refusal raised in this subsystem reaches people through the page and through
 * whatever agent is talking to them over MCP, so every one of them is raised
 * through `no()`, which supplies the English sentence. */
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
  E_VENUE_CARD_DECLINED: "the card issuer declined the authorization",
  E_VENUE_TRANSFER_RESTRICTED: "transfer restricted by the issuer: the recipient is not on the KYC allowlist, the contract reverts",
  E_VENUE_INSUFFICIENT: "not enough balance at the venue",
  E_VENUE_GEOBLOCKED: "the venue does not take orders from this region",
  E_VENUE_MARKET_CLOSED: "the market is past its close or already settled: it takes no more orders",
  E_CARD_REJECTED: "the human rejected this card; the agent gets a clean refusal and does not retry",
  E_CARD_NOT_GRANTED: "no pending card with this id",
};

export function no(code: Code, extra: { venue?: string; tool?: string; detail?: Record<string, unknown>; native?: unknown; message?: string } = {}): Refusal {
  const message = extra.message ?? EN[code];
  return refuse(code, message === undefined ? extra : { ...extra, message });
}
