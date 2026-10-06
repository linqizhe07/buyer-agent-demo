/** The account's own state: who may sign, and for what.
 *
 * Ported from the account pages of Hyperliquid's interface — API wallets,
 * builder-fee approvals, sub-accounts, multi-sig, account type — plus the two
 * things a buyer-side account needs that a single venue does not: a spending
 * approval (an agent key may move money only inside one) and an address book
 * (a destination is a chain AND an address, added by the owner, usable a day
 * later, never learned from history).
 *
 * It also keeps how the owner steers: a watchlist and intents, signed like
 * the rest, which agents read and report on. Those are words, not authority:
 * no limit below reads them, and nothing in them makes or widens one.
 *
 * Everything here is a pure function of (state, a signed owner action, the
 * time). The engine (exchange.ts) checks the signature and the nonce first;
 * this file decides what the action does to the state, and refuses what the
 * account's own limits forbid. The limits are Hyperliquid's where it has one
 * (an agent key lives at most 180 days; a builder's fee is capped at 0.1%; ten
 * approvals; ten signers), and three of its habits are deliberately NOT
 * copied: the expiry lives in a field, not inside the agent's name; a revoked
 * key is never authorised again; a destination is not "anywhere, in five
 * minutes".
 */
import type { Refusal } from "../../core/errors.ts";
import { no } from "../refuse.ts";
import { agentCode } from "../accounts.ts";
import { micro, simKey, ZERO, type Envelope, type Hex, type Jwk, type OwnerAction } from "./sign.ts";

const DAY = 86_400_000;
export const MAX_AGENT_DAYS = 180;
export const MAX_AGENTS = 4;
export const MAX_BUILDER_FEE = 0.001;
export const MAX_APPROVALS = 10;
export const MAX_SIGNERS = 10;
export const MAX_SUB_ACCOUNTS = 10;
export const DESTINATION_COOLING_MS = DAY;
/** what an earn limit names, said where one names anything else */
export const EARN_NAMES = 'an earn limit names venues ("okx") or one product at a venue ("okx:savings:USDT"), not every account';
/** steering (none of it is authority): markets watched, intents open, reports on one intent, and how long an owner's or an agent's words may be */
export const MAX_WATCH = 50;
export const MAX_INTENTS = 20;
/** reports on one intent from one agent key, until the owner sets the intent's words again */
export const MAX_REPORTS = 50;
export const INTENT_TEXT = 200;
export const AGENT_TEXT = 280;
/** what an agent may ask, held in memory only: at most this many waiting, each for a day, one agent's share of them, and so many an hour per key */
export const MAX_ASKS = 20;
export const ASK_TTL_MS = DAY;
export const ASKS_PER_AGENT = MAX_ASKS / MAX_AGENTS;
export const ASKS_PER_HOUR = 5;
export const ASK_KINDS = ["letIn", "limit", "venue", "topup", "session", "leverage", "mode"] as const;
export type AskKind = (typeof ASK_KINDS)[number];
export const REPORT_STATUSES = ["taking", "done", "cannot", "note"] as const;

export interface OwnerKey {
  /** a lower-case address for an EOA, `device:<kid>` for a device key */
  id: string;
  kind: "eoa" | "device";
  label: string;
  jwk?: Jwk | undefined;
  addedAt: string;
}

export interface AgentKey {
  address: Hex;
  name: string;
  /** the flight-number prefix this agent flies under */
  code: string;
  /** ms */
  validUntil: number;
  approvedAt: string;
  revokedAt?: string | undefined;
}

export interface FeeApproval {
  builder: Hex;
  /** a fraction: 0.0005 is 0.05% */
  maxFeeRate: number;
  at: string;
}

export interface SpendApproval {
  id: string;
  agent: Hex;
  /** `venues`: moving money between the user's own venues · `trade`: placing orders at them (dollars of orders, not dollars sent) ·
   * `payees`: paying someone else · `earn`: putting money into a venue's earn products (dollars put in; taking it back out counts nothing) */
  scope: "venues" | "trade" | "payees" | "earn";
  /** venue ids, or payee hosts; `*` is every own venue (never every payee). An earn limit may also name one product at a venue,
   * `<venue>:<product id>` (`okx:savings:USDT`, `metamask:8453:0x…`) */
  allow: string[];
  perPaymentMicro: number;
  budgetMicro: number;
  /** the same destination may be refilled once per window; 0 is no limit */
  windowHours: number;
  validUntil: number;
  spentMicro: number;
  /** held by a card that is waiting or a payment that has not landed */
  reservedMicro: number;
  /** per destination, when it was last used */
  last: Record<string, number>;
  /** per payee host, the receiving address it was first paid at */
  payTo: Record<string, string>;
  /** the owner's signed approval itself: checked again at every spend */
  envelope: Envelope;
  at: string;
  revokedAt?: string | undefined;
}

export interface SubAccount {
  id: string;
  name: string;
  agent: Hex;
  /** where the float sits on chain; the ACCOUNT holds this key, the agent never does */
  address: Hex;
  capMicro: number;
  balanceMicro: number;
  at: string;
}

export interface Destination {
  label: string;
  address: string;
  chain: string;
  token: string;
  addedAt: string;
  /** a new destination can be used a day after it was added */
  usableAt: string;
}

/** a market the owner watches; the venue need not be on the account (its public prices are read without a key) */
export interface Watch {
  venue: string;
  symbol: string;
  at: string;
}

/** the latest an agent said about an intent */
export interface AgentReport {
  status: (typeof REPORT_STATUSES)[number];
  note: string;
  refs: string[];
  /** the agent key that said it */
  by: Hex;
  at: string;
  /** how many reports this key has made on the intent since the owner last set its words, this one included */
  n: number;
}

/** The owner's words to an agent, signed, kept until they lapse or are withdrawn. Nothing reads one as a limit: an agent still acts only
 * inside its spending approvals, and every card is still the owner's */
export interface OwnerIntent {
  id: string;
  /** an agent key, or `*` for every agent on the account */
  agent: Hex | "*";
  /** "" where the owner leaves it to the agent */
  venue: string;
  symbol: string;
  side: "buy" | "sell" | "";
  /** about how many dollars, as a guide; "" for none */
  usd: string;
  text: string;
  validUntil: number;
  /** the owner's signed intent itself */
  envelope: Envelope;
  at: string;
  /** how many reports agents have made on it since the owner last set its words, and the latest of them */
  reports: number;
  report?: AgentReport | undefined;
  /** each agent's own latest report, in the order they first reported: one agent's word never takes another's place */
  byAgent: AgentReport[];
}

export interface AccountState {
  /** Hyperliquid's word for the account type: `disabled` (each venue pays from its own balance) or `unifiedAccount` */
  abstraction: "disabled" | "unifiedAccount";
  owners: OwnerKey[];
  threshold: number;
  /** device keys that asked to be paired and are not signers yet, with the label the device gave when it asked ("Safari on this Mac") */
  pendingDevices: Array<{ kid: string; jwk: Jwk; at: string; label?: string | undefined }>;
  agents: AgentKey[];
  /** every address that was ever revoked: none is authorised again */
  tombstones: Hex[];
  /** keys that tried to act and are not authorised: the page offers them to the owner */
  requests: Array<{ address: Hex; name: string; at: string }>;
  fees: FeeApproval[];
  spends: SpendApproval[];
  subAccounts: SubAccount[];
  destinations: Destination[];
  /** payees paid before; the first payment to a new one is the owner's to approve */
  payees: string[];
  /** the owner's watchlist and open intents: what agents read to know what the owner wants. Neither is authority */
  watch: Watch[];
  intents: OwnerIntent[];
  seq: number;
}

export function emptyState(): AccountState {
  return { abstraction: "disabled", owners: [], threshold: 1, pendingDevices: [], agents: [], tombstones: [], requests: [], fees: [], spends: [], subAccounts: [], destinations: [], payees: [], watch: [], intents: [], seq: 0 };
}

export type AgentStatus = "ok" | "unknown" | "expired" | "revoked";

export function agentStatus(s: AccountState, address: string, nowMs: number): AgentStatus {
  // an address approved again after its first approval ran out has two entries: the one that stands is the one that counts
  const all = s.agents.filter((x) => x.address === address.toLowerCase());
  const a = all.find((x) => x.revokedAt === undefined) ?? all[0];
  if (!a) return s.tombstones.includes(address.toLowerCase() as Hex) ? "revoked" : "unknown";
  if (a.revokedAt !== undefined) return "revoked";
  return nowMs >= a.validUntil ? "expired" : "ok";
}

export const activeAgents = (s: AccountState, nowMs: number): AgentKey[] => s.agents.filter((a) => a.revokedAt === undefined && nowMs < a.validUntil);
export const deviceKeys = (s: AccountState): Map<string, Jwk> => new Map(s.owners.filter((o) => o.kind === "device" && o.jwk).map((o) => [o.id.slice("device:".length), o.jwk!]));
export const isOwner = (s: AccountState, signer: string): boolean => s.owners.some((o) => o.id === signer);

/** `0.1%` → 0.001 · `0.05%` → 0.0005 · `0` → 0 */
export function parseRate(text: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*%$/.exec(text.trim());
  if (m) return Number(m[1]) / 100;
  return text.trim() === "0" ? 0 : Number.NaN;
}

const limit = (message: string, detail: Record<string, unknown> = {}): Refusal => no("E_ACCOUNT_LIMIT", { message, detail });
const bad = (message: string): Refusal => no("E_ACCOUNT_BAD_ACTION", { message });
const isAddress = (v: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(v);
/** a venue's id on the account: lower-case letters, digits and dashes */
const VENUE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** What is text on a page, and nothing else is taken: letters, marks, digits, punctuation, symbols and spaces — an allow-list, not a list of
 * what to refuse. So a control, a line or paragraph break, a format character (the zero-width ones, the marks that turn the direction of
 * what follows — U+061C among them — the soft hyphen, the annotation marks, and Unicode's Tag characters, which spell out words a model reads
 * and a person never sees), a private-use, unassigned or lone surrogate code point are all refused; and so is what Unicode itself says is
 * shown as nothing (Default_Ignorable_Code_Point: variation selectors, the combining grapheme joiner, the Hangul fillers) */
const PLAIN = /^[\p{L}\p{M}\p{N}\p{P}\p{S}\p{Zs}]*$/u;
const IGNORED = /\p{Default_Ignorable_Code_Point}/u;
const NOT_PLAIN_ALL = /[^\p{L}\p{M}\p{N}\p{P}\p{S}\p{Zs}]|\p{Default_Ignorable_Code_Point}/gu;
export const isPlain = (text: string): boolean => PLAIN.test(text) && !IGNORED.test(text);
/** a length as a person counts it: in characters (code points), not in UTF-16 halves */
export const charCount = (text: string): number => [...text].length;
/** words an owner or an agent signed, kept as they were signed: at most `max` characters, and nothing hidden in them. Markup is kept as
 * text: what shows it escapes it */
export function wordsProblem(text: string, max: number, what: string): string | null {
  const n = charCount(text);
  if (n > max) return `${what} is at most ${max} characters (${n} were sent)`;
  return isPlain(text) ? null : `${what} is plain text: no control, line-break, invisible, zero-width or direction-changing characters`;
}

/** a name a key that is not let in gave itself (agentAsk letIn): made safe to keep — its compatibility forms folded (ＣＯＤＥＸ is Codex),
 * nothing hidden, one space between words, at most 32 characters, the most an agent key's name may be */
export function cleanName(text: string): string {
  const one = text.normalize("NFKC").replace(NOT_PLAIN_ALL, " ").replace(/\s+/gu, " ").trim();
  return [...one].slice(0, 32).join("").trim();
}

/** letters of other scripts drawn like Latin ones, as capitals and as small letters: Cyrillic and Greek, which is where look-alike names come from */
const LOOKS_UPPER: Record<string, string> = { А: "a", В: "b", Е: "e", К: "k", М: "m", Н: "h", О: "o", Р: "p", С: "c", Т: "t", У: "y", Х: "x", І: "l", Ј: "j", Ѕ: "s", Ү: "y", Һ: "h", Ԁ: "d", Α: "a", Β: "b", Ε: "e", Ζ: "z", Η: "h", Ι: "l", Κ: "k", Μ: "m", Ν: "n", Ο: "o", Ρ: "p", Τ: "t", Υ: "y", Χ: "x" };
const LOOKS_LOWER: Record<string, string> = { а: "a", е: "e", о: "o", р: "p", с: "c", у: "y", х: "x", і: "i", ј: "j", ѕ: "s", ԁ: "d", һ: "h", ӏ: "l", ԛ: "q", ԝ: "w", ү: "y", ɡ: "g", ɑ: "a", α: "a", ε: "e", ι: "i", κ: "k", ν: "v", ο: "o", ρ: "p", τ: "t", υ: "u", χ: "x" };

/** A name as it LOOKS, for telling whether two names would be taken for one: compatibility forms folded (ＣＯＤＥＸ, ℭodex), accents and
 * case dropped, the Cyrillic and Greek letters drawn like Latin ones read as those, i and 1 as l, 0 as o, rn as m, vv as w, and everything
 * but letters and digits left out ("Code x", "Code-x", "Codex" are one name). Only ever compared, never shown */
export function nameSkeleton(name: string): string {
  const folded = [...name.normalize("NFKD").replace(/\p{M}/gu, "")].map((ch) => LOOKS_UPPER[ch] ?? ch).join("").toLowerCase();
  return [...folded]
    .map((ch) => LOOKS_LOWER[ch] ?? ch)
    .join("")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .replace(/[i1]/g, "l")
    .replace(/0/g, "o")
    .replace(/rn/g, "m")
    .replace(/vv/g, "w");
}

/** The agent key that stands under a name that looks like `name` (nameSkeleton): every key not revoked, an expired one included — approving
 * another key under its name would retire it for good. `except`: a key's own address, which does not take its own name */
export function nameHolder(s: AccountState, name: string, except?: string): AgentKey | undefined {
  const k = nameSkeleton(name);
  if (!k) return undefined;
  return s.agents.find((a) => a.revokedAt === undefined && a.address !== except?.toLowerCase() && nameSkeleton(a.name) === k);
}

/** a report's refs, as the agent signed them: comma-separated ids */
export const refsOf = (text: string): string[] => text.split(",").map((x) => x.trim()).filter(Boolean);

/** what is wrong with an agent's ask, before anything is kept: its kind, the venue it names, its dollars, its words */
export function askProblem(a: { kind: string; venue: string; usd: string; text: string }): string | null {
  if (!(ASK_KINDS as readonly string[]).includes(a.kind)) return `an ask is one of ${ASK_KINDS.join(", ")}`;
  if (a.venue !== "" && !VENUE_ID.test(a.venue)) return "an ask's venue is a venue id (lower-case letters, digits and dashes), or none";
  if (a.kind === "venue" && a.venue === "") return "an ask for a venue names it";
  if (a.usd !== "" && Number.isNaN(micro(a.usd))) return "an ask's dollars are a plain decimal, or none";
  return wordsProblem(a.text, AGENT_TEXT, "an ask's text");
}

/** An agent's report on an intent, or why it is not taken: the key stands now, the intent is open and addressed to this key or to every
 * agent, and this key has room for one more report on it. Each agent's latest word is kept apart (`byAgent`), and so is its count: one agent
 * neither replaces another's word nor fills the intent so that another cannot speak. A report changes nothing but those words */
export function applyReport(state: AccountState, a: { intent: string; status: string; note: string; refs: string }, signer: string, nowMs: number): AccountState | Refusal {
  const by = signer.toLowerCase() as Hex;
  if (agentStatus(state, by, nowMs) !== "ok") return no("E_ACCOUNT_UNKNOWN_SIGNER", { message: "a report comes from an agent key that is authorised now", detail: { signer: by } });
  const it = state.intents.find((x) => x.id === a.intent && nowMs < x.validUntil);
  if (!it) return bad(`there is no open intent "${a.intent}"`);
  if (it.agent !== "*" && it.agent !== by) return bad(`${it.id} is addressed to another agent: an agent reports on the intents addressed to it, or to every agent`);
  if (!(REPORT_STATUSES as readonly string[]).includes(a.status)) return bad(`a report's status is ${REPORT_STATUSES.join(", ")}`);
  const wrong = wordsProblem(a.note, AGENT_TEXT, "a report's note");
  if (wrong) return bad(wrong);
  const refs = refsOf(a.refs);
  if (refs.length > 10 || refs.some((r) => !/^[A-Za-z0-9:_./-]{1,80}$/.test(r))) return bad("a report's refs are at most 10 ids (an order's, a payment's, a transaction's hash), comma-separated");
  const mine = it.byAgent.find((r) => r.by === by);
  if ((mine?.n ?? 0) >= MAX_REPORTS) return limit(`at most ${MAX_REPORTS} reports from one agent on one intent: the owner reads its latest`, { intent: it.id, max: MAX_REPORTS });
  const report: AgentReport = { status: a.status as AgentReport["status"], note: a.note.trim(), refs, by, at: new Date(nowMs).toISOString(), n: (mine?.n ?? 0) + 1 };
  const byAgent = mine ? it.byAgent.map((r) => (r === mine ? report : r)) : [...it.byAgent, report];
  return { ...state, intents: state.intents.map((x) => (x === it ? { ...x, reports: x.reports + 1, report, byAgent } : x)) };
}

/** how an account that holds REAL money shapes these: a payees limit may cover every payee (the agent wallet's float, the per-payment line
 * and the budget bound it), and an agent wallet's address is the address of a key this machine made for it (account/keystore.ts) */
export interface ApplyOptions {
  anyPayee?: boolean | undefined;
  walletAddress?: ((name: string) => Hex | Refusal) | undefined;
}

/** What an account-shaping owner action does to the state, or why the account refuses it. `envelope` is kept where the action is a standing approval. */
/** a sub-account's name as its key file and venue know it: lower case, letters and digits, the rest one dash (keystore.ts slugOf) */
const nameKey = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

export function applyOwner(state: AccountState, action: OwnerAction, envelope: Envelope, nowMs: number, venuesNow: string[] = [], opts: ApplyOptions = {}): AccountState | Refusal {
  const at = new Date(nowMs).toISOString();
  const s: AccountState = { ...state };
  switch (action.type) {
    case "approveAgent": {
      const name = action.agentName.trim();
      if (!name || charCount(name) > 32) return bad("an agent key needs a name of 1 to 32 characters");
      const unplain = wordsProblem(name, 32, "an agent key's name");
      if (unplain) return bad(unplain);
      const address = action.agentAddress.toLowerCase() as Hex;
      const retire = (k: AgentKey) => ({ ...k, revokedAt: at });
      if (address === ZERO) {
        // Hyperliquid's way to revoke: approve the zero address under the same name
        const victim = s.agents.find((k) => k.name === name && k.revokedAt === undefined);
        if (!victim) return bad(`no active agent key is named "${name}"`);
        return { ...s, agents: s.agents.map((k) => (k === victim ? retire(k) : k)), tombstones: [...s.tombstones, victim.address] };
      }
      if (!isAddress(address)) return bad("an agent key is an address");
      if (s.tombstones.includes(address)) return limit("this key was revoked once: a revoked key is never authorised again, generate a new one", { address });
      if (isOwner(s, address)) return bad("an owner key cannot also be an agent key");
      if (!(action.validUntil > nowMs)) return limit("the key's expiry must be in the future", { validUntil: action.validUntil });
      if (action.validUntil > nowMs + MAX_AGENT_DAYS * DAY) return limit(`an agent key lives at most ${MAX_AGENT_DAYS} days`, { maxDays: MAX_AGENT_DAYS });
      // a name that only LOOKS like a key's name would stand beside it as a second "Codex": the same name replaces that key, another name is another key
      const like = nameHolder(s, name, address);
      if (like && like.name !== name) return bad(`"${name}" looks like the name of the agent key "${like.name}": approving it under "${like.name}" replaces that key; any other key needs a name of its own`);
      // a new approval under an existing name replaces the old key, and the old key is gone for good
      const replaced = s.agents.filter((k) => k.revokedAt === undefined && (k.name === name || k.address === address));
      // the same key approved again (a longer expiry) simply takes the old entry's place; a different key under the name retires the old one for good
      const kept = s.agents.filter((k) => !(replaced.includes(k) && k.address === address)).map((k) => (replaced.includes(k) ? retire(k) : k));
      if (kept.filter((k) => k.revokedAt === undefined && nowMs < k.validUntil).length >= MAX_AGENTS) return limit(`at most ${MAX_AGENTS} agent keys at a time: revoke one first`, { max: MAX_AGENTS });
      // a key still waiting that gave itself the same name loses it: letting it in under that name would replace the key just let in
      const requests = s.requests.filter((r) => r.address !== address).map((r) => (r.name && nameSkeleton(r.name) === nameSkeleton(name) ? { ...r, name: "" } : r));
      return { ...s, agents: [...kept, { address, name, code: agentCode(name), validUntil: action.validUntil, approvedAt: at }], tombstones: [...s.tombstones, ...replaced.filter((k) => k.address !== address).map((k) => k.address)], requests };
    }
    case "approveBuilderFee": {
      const rate = parseRate(action.maxFeeRate);
      const builder = action.builder.toLowerCase() as Hex;
      if (Number.isNaN(rate) || !isAddress(builder)) return bad('a fee approval names a builder address and a rate like "0.05%"');
      if (rate === 0) return { ...s, fees: s.fees.filter((f) => f.builder !== builder) };
      if (rate > MAX_BUILDER_FEE) return limit(`a builder's fee is capped at ${MAX_BUILDER_FEE * 100}%`, { maxFeeRate: `${MAX_BUILDER_FEE * 100}%` });
      const others = s.fees.filter((f) => f.builder !== builder);
      if (others.length >= MAX_APPROVALS) return limit(`at most ${MAX_APPROVALS} fee approvals`, { max: MAX_APPROVALS });
      return { ...s, fees: [...others, { builder, maxFeeRate: rate, at }] };
    }
    case "approveSpend": {
      const agent = action.agent.toLowerCase() as Hex;
      if (action.scope !== "venues" && action.scope !== "trade" && action.scope !== "payees" && action.scope !== "earn") return bad('a spending approval covers "venues", "trade", "payees" or "earn"');
      // `*` (every venue of the user's own) is written out as the venues on the account NOW: a venue plugged in later is not in it
      const named = action.allow.split(",").map((x) => x.trim()).filter(Boolean);
      const ownVenues = action.scope === "venues" || action.scope === "trade" || action.scope === "earn";
      const allow = ownVenues && named.includes("*") ? [...new Set([...venuesNow, ...named.filter((x) => x !== "*")])] : named;
      const perPayment = micro(action.perPayment);
      const budget = micro(action.budget);
      if (Number.isNaN(perPayment) || Number.isNaN(budget)) return bad("the amounts of a spending approval are plain decimals");
      const standing = s.spends.filter((x) => x.agent === agent && x.scope === action.scope && x.revokedAt === undefined);
      if (budget === 0) {
        if (!standing.length) return bad("there is no spending approval of that kind to revoke");
        return { ...s, spends: s.spends.map((x) => (standing.includes(x) ? { ...x, revokedAt: at } : x)) };
      }
      if (agentStatus(s, agent, nowMs) !== "ok") return bad("a spending approval is for an agent key that is authorised now");
      if (!allow.length) return bad("a spending approval names where the money may go");
      // an earn limit names venues, or one product at a venue: plain text an agent reads, nothing hidden in it — and never "every account",
      // which would name accounts that earn nothing (and agent wallets)
      if (action.scope === "earn" && named.includes("*")) return bad(EARN_NAMES);
      if (action.scope === "earn" && allow.some((x) => !/^[a-z0-9][a-z0-9-]{0,39}(:[A-Za-z0-9:._-]{1,80})?$/.test(x))) return bad(EARN_NAMES);
      if (action.scope === "payees" && named.includes("*") && !opts.anyPayee) return bad("an approval never covers every payee: name them");
      if (!(perPayment > 0) || perPayment > budget) return bad("the per-payment maximum is more than zero and no more than the budget");
      if (!(action.validUntil > nowMs) || action.validUntil > nowMs + MAX_AGENT_DAYS * DAY) return limit(`a spending approval ends in the future, at most ${MAX_AGENT_DAYS} days away`, { maxDays: MAX_AGENT_DAYS });
      const seq = s.seq + 1;
      const spend: SpendApproval = { id: `spend-${String(seq).padStart(4, "0")}`, agent, scope: action.scope, allow, perPaymentMicro: perPayment, budgetMicro: budget, windowHours: Math.max(0, Math.trunc(action.windowHours)), validUntil: action.validUntil, spentMicro: 0, reservedMicro: 0, last: {}, payTo: {}, envelope, at };
      // one standing approval per agent and scope: a new one replaces the old
      return { ...s, seq, spends: [...s.spends.map((x) => (standing.includes(x) ? { ...x, revokedAt: at } : x)), spend] };
    }
    case "createSubAccount": {
      const name = action.name.trim();
      const agent = action.agent.toLowerCase() as Hex;
      const cap = micro(action.float);
      if (!name || name.length > 16) return bad("a sub-account's name is 1 to 16 characters");
      if (!nameKey(name)) return bad("a sub-account's name has a letter or a digit in it");
      if (Number.isNaN(cap) || !(cap > 0)) return bad("a sub-account's float is more than zero");
      if (agentStatus(s, agent, nowMs) !== "ok") return bad("a sub-account belongs to an agent key that is authorised now");
      // a wallet's key file and its place on the page go by its name in lower case, letters and digits only: "Ops", "ops" and "o.p.s" would
      // be one key, so they are one name
      const same = s.subAccounts.find((x) => nameKey(x.name) === nameKey(name));
      if (same) return bad(same.name === name ? `a sub-account named "${name}" exists` : `"${name}" is the same name as the sub-account "${same.name}" (a name is told apart by its letters and digits, not their case or the marks between them)`);
      if (s.subAccounts.length >= MAX_SUB_ACCOUNTS) return limit(`at most ${MAX_SUB_ACCOUNTS} sub-accounts`, { max: MAX_SUB_ACCOUNTS });
      const address = opts.walletAddress ? opts.walletAddress(name) : simKey(`sub-account:${name}`).address;
      if (typeof address !== "string") return address;
      const seq = s.seq + 1;
      return { ...s, seq, subAccounts: [...s.subAccounts, { id: `sub-${String(seq).padStart(4, "0")}`, name, agent, address: address.toLowerCase() as Hex, capMicro: cap, balanceMicro: 0, at }] };
    }
    case "userSetAbstraction":
      if (action.abstraction !== "disabled" && action.abstraction !== "unifiedAccount") return bad('the account type is "disabled" (separate) or "unifiedAccount"');
      return { ...s, abstraction: action.abstraction };
    case "convertToMultiSigUser": {
      let parsed: { authorizedUsers?: unknown; threshold?: unknown };
      try {
        parsed = JSON.parse(action.signers) as typeof parsed;
      } catch {
        return bad("signers is JSON: {authorizedUsers, threshold}");
      }
      const users = Array.isArray(parsed.authorizedUsers) ? parsed.authorizedUsers.map((u) => String(u)) : [];
      const threshold = Number(parsed.threshold);
      if (!users.length || users.length > MAX_SIGNERS) return limit(`an account has 1 to ${MAX_SIGNERS} signers`, { max: MAX_SIGNERS });
      if ([...users].sort().join() !== users.join() || new Set(users).size !== users.length) return bad("authorizedUsers is a sorted list without repeats");
      if (!Number.isInteger(threshold) || threshold < 1 || threshold > users.length) return bad("the threshold is between 1 and the number of signers");
      const owners: OwnerKey[] = [];
      for (const id of users) {
        const known = s.owners.find((o) => o.id === id);
        const pending = s.pendingDevices.find((d) => `device:${d.kid}` === id);
        if (known) owners.push(known);
        // a device let in keeps the label it paired under: the owner sees which browser it is, not "device"
        else if (pending) owners.push({ id, kind: "device", label: pending.label?.trim() || "device", jwk: pending.jwk, addedAt: at });
        else if (isAddress(id) && id === id.toLowerCase()) owners.push({ id, kind: "eoa", label: "co-signer", addedAt: at });
        else return bad(`"${id}" is not a signer this account knows: a device is paired first, an address is lower-case`);
      }
      return { ...s, owners, threshold, pendingDevices: s.pendingDevices.filter((d) => !users.includes(`device:${d.kid}`)) };
    }
    case "setDestination": {
      const label = action.label.trim();
      if (!label || label.length > 32) return bad("a destination needs a label of 1 to 32 characters");
      if (action.address === "") return { ...s, destinations: s.destinations.filter((d) => d.label !== label) };
      if (!isAddress(action.address)) return no("E_ACCOUNT_DESTINATION", { message: "a destination's address is 0x and 40 hex digits; anything else is not an address", detail: { address: action.address } });
      if (!action.chain.trim() || !action.token.trim()) return bad("a destination is an address ON A CHAIN, for one token");
      const entry: Destination = { label, address: action.address.toLowerCase(), chain: action.chain.trim(), token: action.token.trim(), addedAt: at, usableAt: new Date(nowMs + DESTINATION_COOLING_MS).toISOString() };
      const others = s.destinations.filter((d) => d.label !== label);
      if (others.length >= 50) return limit("at most 50 destinations", { max: 50 });
      return { ...s, destinations: [...others, entry] };
    }
    case "setWatch": {
      const venue = action.venue.trim();
      const symbol = action.symbol.trim();
      if (!VENUE_ID.test(venue)) return bad("a watched market names its venue: lower-case letters, digits and dashes");
      if (!symbol || charCount(symbol) > 80 || !isPlain(symbol)) return bad("a watched market names its symbol: 1 to 80 characters of plain text");
      if (action.on !== "true" && action.on !== "") return bad('"on" is "true" to watch a market, or "" to stop');
      const others = s.watch.filter((w) => !(w.venue === venue && w.symbol === symbol));
      if (action.on === "") return others.length === s.watch.length ? bad(`${symbol} at ${venue} is not watched`) : { ...s, watch: others };
      // watched already: it stays where it was
      if (others.length < s.watch.length) return s;
      if (s.watch.length >= MAX_WATCH) return limit(`at most ${MAX_WATCH} watched markets: stop watching one first`, { max: MAX_WATCH });
      return { ...s, watch: [...s.watch, { venue, symbol, at }] };
    }
    case "setIntent": {
      // an intent that has lapsed is gone: it counts for nothing, and it cannot be changed or reported on
      const open = s.intents.filter((x) => nowMs < x.validUntil);
      if (action.validUntil === 0) {
        if (!action.id) return bad("an intent is withdrawn by its id");
        return open.some((x) => x.id === action.id) ? { ...s, intents: open.filter((x) => x.id !== action.id) } : bad(`there is no open intent "${action.id}" to withdraw`);
      }
      const agent: OwnerIntent["agent"] = action.agent === "*" ? "*" : (action.agent.toLowerCase() as Hex);
      if (agent !== "*" && (!isAddress(agent) || agentStatus(s, agent, nowMs) !== "ok")) return bad('an intent is for an agent key that is authorised now, or for every agent ("*")');
      const venue = action.venue.trim();
      const symbol = action.symbol.trim();
      if (venue !== "" && !VENUE_ID.test(venue)) return bad("an intent's venue is a venue id (lower-case letters, digits and dashes), or left to the agent");
      if (charCount(symbol) > 80 || !isPlain(symbol)) return bad("an intent's market is at most 80 characters of plain text, or left to the agent");
      if (action.side !== "buy" && action.side !== "sell" && action.side !== "") return bad('an intent\'s side is "buy", "sell", or left to the agent');
      const usd = action.usd.trim();
      if (usd !== "" && Number.isNaN(micro(usd))) return bad("an intent's dollars are a plain decimal, or none: they guide the agent and limit nothing");
      const text = action.text.trim();
      const wrong = text ? wordsProblem(action.text, INTENT_TEXT, "an intent") : `an intent says what the owner wants, in 1 to ${INTENT_TEXT} characters`;
      if (wrong) return bad(wrong);
      if (!(action.validUntil > nowMs) || action.validUntil > nowMs + MAX_AGENT_DAYS * DAY) return limit(`an intent ends in the future, at most ${MAX_AGENT_DAYS} days away (0 withdraws it)`, { maxDays: MAX_AGENT_DAYS });
      const fields = { agent, venue, symbol, side: action.side as OwnerIntent["side"], usd, text, validUntil: action.validUntil, envelope, at };
      if (action.id) {
        const was = open.find((x) => x.id === action.id);
        // new words: what agents said about the old ones goes with them, and every agent may report on the new ones afresh
        return was ? { ...s, intents: open.map((x) => (x === was ? { ...was, ...fields, reports: 0, report: undefined, byAgent: [] } : x)) } : bad(`there is no open intent "${action.id}" to change: a new one has the id ""`);
      }
      if (open.length >= MAX_INTENTS) return limit(`at most ${MAX_INTENTS} intents open at a time: withdraw one first`, { max: MAX_INTENTS });
      const seq = s.seq + 1;
      return { ...s, seq, intents: [...open, { id: `intent-${String(seq).padStart(4, "0")}`, ...fields, reports: 0, byAgent: [] }] };
    }
    default:
      return bad(`"${action.type}" does not change the account's settings`);
  }
}

/** the standing approval that covers this agent and scope right now, if any */
export function spendFor(s: AccountState, agent: string, scope: SpendApproval["scope"], nowMs: number): SpendApproval | Refusal {
  const all = s.spends.filter((x) => x.agent === agent.toLowerCase() && x.scope === scope);
  const live = all.find((x) => x.revokedAt === undefined);
  if (!live) return no("E_MANDATE_NONE", { message: scope === "venues" ? "the owner has not approved this agent to move money between venues" : scope === "trade" ? "the owner has not approved this agent to trade: it gets a trading limit on the account page (Agents)" : scope === "earn" ? "the owner has not approved this agent to put money to earn: it gets an earn limit on the account page (Agents)" : "the owner has not approved this agent to pay anyone", detail: { scope, hadOne: all.length > 0 } });
  if (nowMs >= live.validUntil) return no("E_MANDATE_EXPIRED", { detail: { approval: live.id, validUntil: new Date(live.validUntil).toISOString() } });
  return live;
}

/** Does this approval cover a payment of `amount` to `target` now? The answer names the limit that said no. */
export function covers(a: SpendApproval, target: string, amountMicro: number, nowMs: number): Refusal | null {
  if (!a.allow.includes(target) && !((a.scope === "venues" || a.scope === "payees") && a.allow.includes("*"))) return no("E_MANDATE_RECIPIENT", { message: a.scope === "trade" ? `the trading limit does not cover "${target}" (it covers ${a.allow.join(", ")})` : a.scope === "earn" ? `the earn limit does not cover "${target}" (it covers ${a.allow.join(", ")})` : `"${target}" is not in the spending approval (${a.allow.join(", ")})`, detail: { approval: a.id, allow: a.allow, target } });
  if (amountMicro > a.perPaymentMicro) return no("E_MANDATE_PER_ORDER_CAP", { ...(a.scope === "trade" ? { message: `an order of $${(amountMicro / 1e6).toFixed(2)} is more than the $${(a.perPaymentMicro / 1e6).toFixed(2)} an order the trading limit allows` } : {}), detail: { approval: a.id, perPayment: a.perPaymentMicro / 1e6, amount: amountMicro / 1e6 } });
  const left = a.budgetMicro - a.spentMicro - a.reservedMicro;
  if (amountMicro > left) return no("E_MANDATE_BUDGET", { message: `the spending approval has $${(left / 1e6).toFixed(2)} left of $${(a.budgetMicro / 1e6).toFixed(2)}; $${(amountMicro / 1e6).toFixed(2)} is more than that`, detail: { approval: a.id, budget: a.budgetMicro / 1e6, spent: a.spentMicro / 1e6, reserved: a.reservedMicro / 1e6, amount: amountMicro / 1e6 } });
  const last = a.last[target];
  if (a.windowHours > 0 && last !== undefined && nowMs - last < a.windowHours * 3_600_000) return no("E_MANDATE_RATE", { message: `"${target}" was refilled ${Math.round((nowMs - last) / 60_000)} min ago; the approval allows one every ${a.windowHours} h`, detail: { approval: a.id, windowHours: a.windowHours, lastAt: new Date(last).toISOString() } });
  return null;
}
