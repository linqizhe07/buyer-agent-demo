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
import { no, unaddressed } from "../refuse.ts";
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
  /** what the last read could not read this time (a chain or a part that did not answer, its last good rows kept), when anything: the read
   * is then shown as stale, and asked again soon */
  unread?(): string | undefined;
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
  /** how long the venue asked to be left alone (a 429's or a 418's Retry-After), when it said: at most an hour */
  retryAfterMs?: number | undefined;
  /** a redirect's target, its host only — never followed, and never its path, which may carry a place or an address */
  location?: string | undefined;
}
export type Http = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number }) => Promise<HttpReply>;

/** the real network: one request, a timeout (the body's too), no redirect followed — a redirect comes back as the answer it is, with the
 * host it pointed at, so it is told as the venue answering and not as "did not answer" */
export const realHttp: Http = async (url, init = {}) => {
  const r = await fetch(url, { method: init.method ?? "GET", ...(init.headers ? { headers: init.headers } : {}), ...(init.body !== undefined ? { body: init.body } : {}), signal: AbortSignal.timeout(init.timeoutMs ?? 10_000), redirect: "manual" });
  const wait = retryAfterMs(r.headers.get("retry-after"));
  if (r.status >= 300 && r.status < 400) {
    await r.body?.cancel().catch(() => undefined);
    const host = hostOf(r.headers.get("location"), url);
    return { status: r.status, body: undefined, text: "", ...(host ? { location: host } : {}), ...(wait ? { retryAfterMs: wait } : {}) };
  }
  const text = await r.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: r.status, body, text: text.slice(0, 2000), ...(wait ? { retryAfterMs: wait } : {}) };
};

/** a Retry-After header — seconds, or an HTTP date — as milliseconds from now; nothing when it says nothing usable. An hour at most */
export function retryAfterMs(header: string | null | undefined, now: number = Date.now()): number | undefined {
  const h = String(header ?? "").trim();
  if (!h) return undefined;
  const ms = /^\d+(\.\d+)?$/.test(h) ? Number(h) * 1000 : Date.parse(h) - now;
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, 3_600_000) : undefined;
}

/** the host a redirect points at, with any address in it taken out; a relative one is the same host */
function hostOf(location: string | null, from: string): string | undefined {
  if (!location) return undefined;
  try {
    return unaddressed(new URL(location, from).host);
  } catch {
    return undefined;
  }
}

/** take anything secret out of a string before it is shown, logged or thrown — and this machine's public address, before anything cuts the
 * text short: an address cut in half still says roughly where the user is */
export function redact(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join("•••");
  return unaddressed(out);
}

/** how venues say "not from where you are": Binance answers 451 with "restricted location", Bybit's edge answers 403 with "block access from
 * your country". Only words about a place: a product's or a tier's "eligibility", or "not permitted in your account", is not one, and
 * reading it as one would tell a user a venue does not serve them when it does */
export const REGION = /restricted (location|jurisdiction|region|countr)|unavailable from a restricted|(block(ed|s)?|den(y|ied)) access from your (country|region)|not (available|permitted|supported|eligible|offered) (in|for|from) your (country|region|jurisdiction|location|state|area)|geo-?block|\b451 Unavailable|\bHTTP 451\b|\bdoes not support (?:user participation in )?your (?:ip )?region\b|\bcountry (?:and region )?restrictions\b|\bblacklist(?:ed)? country\b|\bcountry_is_banned\b/i;

/** A venue saying the address this machine reaches it from is not on the key's IP list — each in its own code or words: OKX 50110, Bybit
 * 10010 ("Unmatched IP"), Bitget 40018 ("Invalid IP"), KuCoin 400006, Crypto.com 40103, MEXC 406 and 700006, Gate IP_FORBIDDEN, Bitstamp
 * "IP address not allowed", Phemex "Request IP mismatch", Coinbase International "ip not allowed", Upbit no_authorization_i_p ("This is not a
 * verified IP") (ccxt's error tables, 2026-10-08). The key is good and the place is served: the address changed, or the key was bound to
 * another machine's. Binance's -2015 names IP among three causes and is not this */
export const IP_LIST = /\bunmatched ip\b|\binvalid ip\b|\bip_forbidden\b|\bip non white ?list\b|\bip (?:white ?list|allow ?list)\b|\bip address not (?:allowed|whitelisted|in)\b|\b(?:request|accessing|your) ip\b[^{}"]{0,60}\bnot (?:in|on|included|allowed|whitelisted)\b|"(?:50110|10010|40018|400006|40103|700006)"|\bretCode"?\s*:\s*10010\b|\bcode"?\s*:\s*(?:40103|700006)\b|\bip mismatch\b|\bip not allowed\b|\bno_authorization_i_?p\b|\bnot a verified ip\b/i;
/** the account's sentence for it: the venue, the key, and what the owner does — the address itself is never said or kept */
export const ipListWords = (name: string): string => `${name} refuses this key from this machine's address: the key is bound to a list of IP addresses, and the one this machine reaches ${name} from now is not on it. Add this machine's current address to the key's IP list at ${name} (or make the key again with it), then try again`;

/** An answer from the server in front of a venue rather than from its API: an HTML page refusing the request — a CDN's or a firewall's
 * ("Access Denied", "Request blocked", "Attention Required", "Just a moment") — with no reason of the venue's. It refuses this network, by
 * place or by the address's standing; it does not say which, and it is the same for every key. A venue's own JSON "access denied" is not one */
const EDGE_PAGE = /<(?:!doctype html|html|head|title|body)[\s>]|\baccess denied\b|\brequest (?:could not be satisfied|blocked)\b|\battention required\b|\bjust a moment\b|\bcf-ray\b|\bedgesuite\b|\bincapsula\b/i;
/** Cloudflare's short plain-text refusal to a client that is not a browser, the whole body: "error code: 1009" (the site bans this
 * country or region), 1006–1008 (this address is banned), 1010 (the client's signature), 1012 (access denied), 1020 (a firewall rule). The
 * leading words let the library's "Forbidden error code: 1009" match. 1015, its rate limit, comes as a 429 and stays one */
const EDGE_TEXT = /^(?:[A-Za-z][A-Za-z' -]{0,40} )?error code: 10(?:0[6-9]|1[02]|20)\s*$/i;
export function edgeRefused(status: number, text: string): boolean {
  // 403 only: a 401 page ("401 Authorization Required", Alpaca's own) is the API asking for a key
  if (status !== 403) return false;
  const body = String(text ?? "").trim();
  return !/^[{[]/.test(body) && (EDGE_PAGE.test(body) || EDGE_TEXT.test(body));
}

/** A 2xx answer that is not the venue's API speaking: a page (a filtering network's block page, a captive portal, a challenge served with
 * 200 or 202) where the API answers JSON. It is not the venue's yes, nor its no: the account reads it as no answer, and keeps what it knew */
export function notTheApi(r: Pick<HttpReply, "status" | "body" | "text">): boolean {
  return r.status >= 200 && r.status < 300 && r.status !== 204 && r.body === undefined && /^\s*</.test(String(r.text ?? ""));
}
/** the account's sentence for it */
export const notTheApiWords = (name: string): string => `${name} did not answer: something on this network answered in its place with a page that is not ${name}'s API. Nothing it said is taken as ${name}'s answer`;
/** the page's own title or heading, when it has one: the only words such a page gives */
export const edgeTitle = (text: string): string => (/<title[^>]*>([^<]{1,80})<\/title>|<h1[^>]*>([^<]{1,80})<\/h1>/i.exec(String(text ?? "")) ?? []).slice(1).find(Boolean)?.trim() ?? "";
/** the account's sentence for it */
export const edgeWords = (name: string, status: number, text: string): string => {
  const t = edgeTitle(text);
  return `${name} refuses this network: the server in front of it answered HTTP ${status}${t ? ` (“${t}”)` : ""} and gave no reason — by place, or by this address's standing, it does not say. That is its own answer, and the account does not look for a way around it`;
};

/** a venue that has banned the address this machine reaches it from for too many requests, until when it says (Binance's HTTP 418: "IP
 * banned until <ms>"): nothing is asked of it before then */
export function bannedUntil(text: string): number | undefined {
  const m = /banned until (\d{13})\b/i.exec(String(text ?? ""));
  return m ? Number(m[1]) : undefined;
}

/** A venue's answer that is not a yes, as one of the account's refusals. The venue's own words go with it. A venue that does not serve this
 * location is the venue's rule: it is reported as that, and nothing here looks for another way in. */
export function venueSaidNo(venue: string, name: string, status: number, text: string, secrets: Array<string | undefined> = [], reply: Pick<HttpReply, "retryAfterMs" | "location"> = {}): Refusal {
  // redacted before the whitespace is folded: a secret that runs over several lines (a PEM key) is still found
  const said = redact(text, secrets).replace(/\s+/g, " ").trim().slice(0, 220);
  const native = { status, said };
  const waited = reply.retryAfterMs ? { until: Date.now() + reply.retryAfterMs } : {};
  if (status === 451 || REGION.test(text)) return no("E_VENUE_GEOBLOCKED", { venue, message: `${name} does not serve this location: that is its own rule, and the account does not look for a way around it`, native });
  if (edgeRefused(status, text)) return no("E_VENUE_GEOBLOCKED", { venue, message: edgeWords(name, status, text), native: { status, edge: true } });
  if (IP_LIST.test(text)) return no("E_VENUE_PERMISSION", { venue, message: ipListWords(name), native, detail: { ipList: true } });
  if (status === 418 || bannedUntil(text) !== undefined) return bannedNo(venue, name, bannedUntil(text) ?? (reply.retryAfterMs ? Date.now() + reply.retryAfterMs : undefined), native);
  if (status === 401) return no("E_VENUE_UNAUTHORIZED", { venue, message: `${name} does not accept this key`, native });
  if (status === 403) return no("E_VENUE_PERMISSION", { venue, message: `${name} refused: the key lacks the permission to read, or this machine's IP is not on the key's list`, native });
  if (status === 429) return rateLimitedNo(venue, name, reply.retryAfterMs, native);
  if (status >= 500 || status === 0) return no("E_VENUE_UNREACHABLE", { venue, message: `${name} did not answer`, native: { ...native, ...waited } });
  if (status >= 300 && status < 400) return redirectedNo(venue, name, status, reply.location);
  if (notTheApi({ status, body: undefined, text })) return no("E_VENUE_UNREACHABLE", { venue, message: notTheApiWords(name), native: { status, page: true } });
  return no("E_VENUE_REJECTED", { venue, message: `${name} refused the request (HTTP ${status})`, native });
}

/** What an HTTP answer says of this network rather than of the key or the order, read on the answer as it came — before anything reads its
 * words as the venue's: the server in front of the venue refusing this network (its page: by place or by the address's standing, held as a
 * place rule, and none of the page kept — a page's "permission" or "location" is not the venue's own rule), a page in the API's place (no
 * answer), a key bound to other addresses, a ban or a rate limit for as long as the venue asked, a redirect (answered, not followed).
 * Nothing when it is none of these */
export function networkNo(venue: string, name: string, r: HttpReply, native: Record<string, unknown>): Refusal | undefined {
  if (edgeRefused(r.status, r.text)) return no("E_VENUE_GEOBLOCKED", { venue, message: edgeWords(name, r.status, r.text), native: { status: r.status, edge: true } });
  if (notTheApi(r)) return no("E_VENUE_UNREACHABLE", { venue, message: notTheApiWords(name), native: { status: r.status, page: true } });
  if (IP_LIST.test(r.text)) return no("E_VENUE_PERMISSION", { venue, message: ipListWords(name), native, detail: { ipList: true } });
  if (r.status === 418 || bannedUntil(r.text) !== undefined) return bannedNo(venue, name, bannedUntil(r.text) ?? (r.retryAfterMs ? Date.now() + r.retryAfterMs : undefined), native);
  if (r.status === 429) return rateLimitedNo(venue, name, r.retryAfterMs, native);
  if (r.status >= 300 && r.status < 400) return redirectedNo(venue, name, r.status, r.location);
  return undefined;
}

/** a venue that has banned this machine's address for too many requests, until when it said (or for ten minutes, when it gave no time):
 * nothing is asked of it before then */
export function bannedNo(venue: string, name: string, until: number | undefined, native: Record<string, unknown> = {}): Refusal {
  const to = until ?? Date.now() + 600_000;
  return no("E_VENUE_UNREACHABLE", { venue, message: `${name} has banned this machine's address for too many requests${until ? ` until ${new Date(until).toISOString()}` : " for a while"}: nothing is asked of it before then`, native: { ...native, until: to, ban: true } });
}

/** a venue rate-limiting this machine: held for as long as it asked (its Retry-After), or a minute when it did not say — and the sentence
 * says the hold that is kept */
export function rateLimitedNo(venue: string, name: string, waitMs: number | undefined, native: Record<string, unknown> = {}): Refusal {
  const ms = waitMs ?? 60_000;
  const words = ms >= 120_000 ? `${Math.round(ms / 60_000)} minutes` : ms > 60_000 || ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : "a minute";
  return no("E_VENUE_UNREACHABLE", { venue, message: `${name} is rate-limiting this machine: try again in ${words}`, native: { ...native, status: 429, until: Date.now() + ms } });
}

/** a venue that sent the request somewhere else (a 3xx): not followed. It answered — this is not "did not answer" — and no place is read
 * from where it pointed: only the venue's own words say a place */
export function redirectedNo(venue: string, name: string, status: number, location: string | undefined): Refusal {
  return no("E_VENUE_REJECTED", { venue, message: `${name} answered HTTP ${status}, sending the request on${location ? ` to ${location}` : ""}: not followed`, native: { status, ...(location ? { location } : {}) } });
}

/** a thrown network failure (DNS, timeout, reset, a certificate that is not the venue's) as a refusal. A failure of the connection itself
 * keeps only its code: a certificate's words name the hosts of whatever answered in the venue's place */
export function unreachable(venue: string, name: string, err: unknown, secrets: Array<string | undefined> = []): Refusal {
  const e = err as { name?: string; message?: string };
  const code = transportCode(err);
  if (code && /^(?:ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|SELF_SIGNED_|DEPTH_ZERO_|EPROTO$)/.test(code)) return no("E_VENUE_UNREACHABLE", { venue, message: `${name} could not be reached from this network: something on it answered in ${name}'s place, with a certificate that is not ${name}'s`, native: { error: e?.name ?? "Error", code } });
  return no("E_VENUE_UNREACHABLE", { venue, message: `${name} could not be reached${e?.name === "TimeoutError" ? ": no answer in time" : ""}`, native: { error: redact(String(e?.message ?? err), secrets).slice(0, 200), ...(code ? { code } : {}) } });
}

/** the code a failure of the connection carries — on the error, its cause, or the first of an AggregateError's — when it is one */
export function transportCode(err: unknown): string | undefined {
  const e = err as { code?: unknown; cause?: { code?: unknown; errors?: Array<{ code?: unknown }> }; errors?: Array<{ code?: unknown }> } | undefined;
  for (const c of [e?.code, e?.cause?.code, e?.errors?.[0]?.code, e?.cause?.errors?.[0]?.code]) if (typeof c === "string" && /^(?:E[A-Z0-9_]+|ERR_[A-Z0-9_]+|UND_ERR_[A-Z_]+|CERT_[A-Z_]+|UNABLE_TO_[A-Z_]+|SELF_SIGNED_[A-Z_]+|DEPTH_ZERO_[A-Z_]+)$/.test(c)) return c;
  return undefined;
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

/** how a perpetual's margin is held: across the account, or per position */
export type MarginMode = "cross" | "isolated";

/** What a trader says about a market, or its last 24 hours, beyond what trade.ts names today: carried as JSON to the page and to agents, so
 * each is set only where it is true, and left out where nothing is known. (trade.ts's Market and MarketStats name the same two fields once
 * their owner adds them; until then a trader returns `Market & MarketExtras`.) */
export interface MarketExtras {
  /** the margin modes a perpetual's leverage is set with here, where the venue sets one per market (Binance: both; OKX: the account's orders
   * go in cross margin, so cross); `[]` where the venue sets none per market (a unified Bybit account: the whole account's); absent where
   * leverage is not set from the account at all. The page draws a Margin choice only from this list */
  marginModes?: MarginMode[] | undefined;
  /** where the 24-hour figures came from, when they are not the venue's own ticker read against its docs: the exchange library's unified
   * reading of a ticker the account has not checked (its 24-hour window, and its volume, are the library's word) */
  statsFrom?: string | undefined;
}

/** dollar stablecoins count one for one; everything else needs a price from somewhere. USDG is Paxos's Global Dollar: the dollar Robinhood's
 * Stock Tokens trade against on Robinhood Chain */
export const STABLES = new Set(["USD", "USDC", "USDC.E", "USDT", "USDT0", "USD₮0", "USD₮", "FDUSD", "PYUSD", "DAI", "TUSD", "USDP", "PUSD", "USDG"]);
export const isStable = (asset: string): boolean => STABLES.has(asset.toUpperCase());
