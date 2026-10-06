/** LIVE connections: a venue the user really has, reached through its own interface.
 *
 * A source READS: the balance the venue reports, and what the venue says the credential may do. Some sources can also be asked to move
 * money (`writer`, writes.ts) or to place orders (`trader`, trade.ts) — but nothing in this directory decides whether they are: the account's
 * doors do (account/live-moves.ts, account/live-orders.ts), on the owner's signature or inside a limit the owner signed. A wallet's
 * transaction is never signed here: it is handed to the wallet.
 *
 * A source is reached in one of two ways:
 *   · a KEY FILE in the home directory (an exchange, a broker): this process reads the file; no page, no agent and no ledger row ever
 *     carries what is in it;
 *   · an ADDRESS (a wallet, a perp DEX account, a prediction-market wallet, a token position): public data, read from the venue or the chain.
 *
 * The network is injected (`Http`, the exchange client, the chain reader), so the tests run every source against stand-ins and never leave
 * the process.
 */
import { isRefusal, type Refusal } from "../../core/errors.ts";
import { no } from "../refuse.ts";
import type { AccountKind, AssetClass } from "../accounts.ts";
import type { LiveEarner } from "./earn.ts";
import type { LiveTrader } from "./trade.ts";
import type { LiveWriter } from "./writes.ts";

/** what a venue said about the credential or the address it was shown */
export interface LiveProbe {
  /** what the venue says this credential may do there, in its own words; empty when the venue has no way to say */
  can: string[];
  note: string;
  /** the venue's own answer, with nothing secret in it */
  native?: unknown;
}

export interface LiveBalance {
  asset: string;
  /** what is held; a short, where a venue carries one, is negative (and so are its dollars: what buying it back costs) */
  amount: number;
  /** what it is worth in dollars, when the venue or a price says so; absent = no price was found, and it counts as nothing */
  usd?: number | undefined;
  /** which of the venue's own ledgers, or which chain */
  where?: string | undefined;
  class?: AssetClass | undefined;
}

/** one real account or address: read, never written */
export interface LiveSource {
  name: string;
  kind: AccountKind;
  /** what stands where a credential would: the key file's path, or the address */
  reference: string;
  /** how it was reached, one line */
  via: string;
  address?: string | undefined;
  probe: LiveProbe;
  read(): Promise<LiveBalance[]>;
  /** how real money is moved here, when it can be; absent: no money is moved here from the account */
  writer?: LiveWriter | undefined;
  /** why no money is moved here, when none is */
  readOnlyBecause?: string | undefined;
  /** how orders are placed here (trade.ts), when they can be */
  trader?: LiveTrader | undefined;
  /** why no order is placed here, when none is */
  noTradeBecause?: string | undefined;
  /** how money is put to earn here (earn.ts: the mm wallet's vaults), when the source itself has a way; an exchange's earn is reached
   * through its trader's own client instead (exchange-trade.ts exchangeEarnHook) */
  earner?: LiveEarner | undefined;
}

export interface HttpReply {
  status: number;
  /** the body parsed as JSON, when it is JSON */
  body: unknown;
  text: string;
}
export type Http = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number }) => Promise<HttpReply>;

/** the real network: one request, a timeout, no redirect followed */
export const realHttp: Http = async (url, init = {}) => {
  const r = await fetch(url, { method: init.method ?? "GET", ...(init.headers ? { headers: init.headers } : {}), ...(init.body !== undefined ? { body: init.body } : {}), signal: AbortSignal.timeout(init.timeoutMs ?? 10_000), redirect: "error" });
  const text = await r.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: r.status, body, text: text.slice(0, 2000) };
};

/** take anything secret out of a string before it is shown, logged or thrown */
export function redact(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join("•••");
  return out;
}

/** how venues say "not from where you are": Binance answers 451 with "restricted location", Bybit's edge answers 403 with "block access from your country" */
export const REGION = /restricted (location|jurisdiction|region|countr)|unavailable from a restricted|(block(ed|s)?|den(y|ied)) access from your (country|region)|not available in your (country|region|jurisdiction)|not (permitted|supported|eligible) in your|eligibility|geo-?block| 451 /i;

/** A venue's answer that is not a yes, as one of the account's refusals. The venue's own words go with it. A venue that does not serve this
 * location is the venue's rule: it is reported as that, and nothing here looks for another way in. */
export function venueSaidNo(venue: string, name: string, status: number, text: string, secrets: Array<string | undefined> = []): Refusal {
  // redacted before the whitespace is folded: a secret that runs over several lines (a PEM key) is still found
  const said = redact(text, secrets).replace(/\s+/g, " ").trim().slice(0, 220);
  const native = { status, said };
  if (status === 451 || REGION.test(text)) return no("E_VENUE_GEOBLOCKED", { venue, message: `${name} does not serve this location: that is its own rule, and the account does not look for a way around it`, native });
  if (status === 401) return no("E_VENUE_UNAUTHORIZED", { venue, message: `${name} does not accept this key`, native });
  if (status === 403) return no("E_VENUE_PERMISSION", { venue, message: `${name} refused: the key lacks the permission to read, or this machine's IP is not on the key's list`, native });
  if (status === 429) return no("E_VENUE_UNREACHABLE", { venue, message: `${name} is rate-limiting this machine: try again in a minute`, native });
  if (status >= 500 || status === 0) return no("E_VENUE_UNREACHABLE", { venue, message: `${name} did not answer`, native });
  return no("E_VENUE_REJECTED", { venue, message: `${name} refused the request (HTTP ${status})`, native });
}

/** a thrown network failure (DNS, timeout, reset) as a refusal */
export function unreachable(venue: string, name: string, err: unknown, secrets: Array<string | undefined> = []): Refusal {
  const e = err as { name?: string; message?: string };
  return no("E_VENUE_UNREACHABLE", { venue, message: `${name} could not be reached${e?.name === "TimeoutError" ? ": no answer in time" : ""}`, native: { error: redact(String(e?.message ?? err), secrets).slice(0, 200) } });
}

/** whatever was thrown while a venue was being read, as a refusal: the venue's own no if it was one, otherwise "it answered something this could not read" */
export function asRefusal(venue: string, name: string, err: unknown, secrets: Array<string | undefined> = []): Refusal {
  if (isRefusal(err)) return err;
  return no("E_VENUE_REJECTED", { venue, message: `${name} answered in a way this connection could not read`, native: { error: redact(String((err as { message?: string })?.message ?? err), secrets).slice(0, 200) } });
}

export const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
};

/** dollar stablecoins count one for one; everything else needs a price from somewhere. USDG is Paxos's Global Dollar: the dollar Robinhood's
 * Stock Tokens trade against on Robinhood Chain */
export const STABLES = new Set(["USD", "USDC", "USDC.E", "USDT", "USDT0", "USD₮0", "USD₮", "FDUSD", "PYUSD", "DAI", "TUSD", "USDP", "PUSD", "USDG"]);
export const isStable = (asset: string): boolean => STABLES.has(asset.toUpperCase());
