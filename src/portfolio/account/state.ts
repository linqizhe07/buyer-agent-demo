/** The account's own state: who may sign, and for what.
 *
 * Ported from the account pages of Hyperliquid's interface — API wallets,
 * builder-fee approvals, sub-accounts, multi-sig, account type — plus the two
 * things a buyer-side account needs that a single venue does not: a spending
 * approval (an agent key may move money only inside one) and an address book
 * (a destination is a chain AND an address, added by the owner, usable a day
 * later, never learned from history).
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
   * `payees`: paying someone else */
  scope: "venues" | "trade" | "payees";
  /** venue ids, or payee hosts; `*` is every own venue (never every payee) */
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

export interface AccountState {
  /** Hyperliquid's word for the account type: `disabled` (each venue pays from its own balance) or `unifiedAccount` */
  abstraction: "disabled" | "unifiedAccount";
  owners: OwnerKey[];
  threshold: number;
  /** device keys that asked to be paired and are not signers yet */
  pendingDevices: Array<{ kid: string; jwk: Jwk; at: string }>;
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
  seq: number;
}

export function emptyState(): AccountState {
  return { abstraction: "disabled", owners: [], threshold: 1, pendingDevices: [], agents: [], tombstones: [], requests: [], fees: [], spends: [], subAccounts: [], destinations: [], payees: [], seq: 0 };
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

/** What an account-shaping owner action does to the state, or why the account refuses it. `envelope` is kept where the action is a standing approval. */
export function applyOwner(state: AccountState, action: OwnerAction, envelope: Envelope, nowMs: number, venuesNow: string[] = []): AccountState | Refusal {
  const at = new Date(nowMs).toISOString();
  const s: AccountState = { ...state };
  switch (action.type) {
    case "approveAgent": {
      const name = action.agentName.trim();
      if (!name || name.length > 32) return bad("an agent key needs a name of 1 to 32 characters");
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
      // a new approval under an existing name replaces the old key, and the old key is gone for good
      const replaced = s.agents.filter((k) => k.revokedAt === undefined && (k.name === name || k.address === address));
      // the same key approved again (a longer expiry) simply takes the old entry's place; a different key under the name retires the old one for good
      const kept = s.agents.filter((k) => !(replaced.includes(k) && k.address === address)).map((k) => (replaced.includes(k) ? retire(k) : k));
      if (kept.filter((k) => k.revokedAt === undefined && nowMs < k.validUntil).length >= MAX_AGENTS) return limit(`at most ${MAX_AGENTS} agent keys at a time: revoke one first`, { max: MAX_AGENTS });
      return { ...s, agents: [...kept, { address, name, code: agentCode(name), validUntil: action.validUntil, approvedAt: at }], tombstones: [...s.tombstones, ...replaced.filter((k) => k.address !== address).map((k) => k.address)], requests: s.requests.filter((r) => r.address !== address) };
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
      if (action.scope !== "venues" && action.scope !== "trade" && action.scope !== "payees") return bad('a spending approval covers "venues", "trade" or "payees"');
      // `*` (every venue of the user's own) is written out as the venues on the account NOW: a venue plugged in later is not in it
      const named = action.allow.split(",").map((x) => x.trim()).filter(Boolean);
      const ownVenues = action.scope === "venues" || action.scope === "trade";
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
      if (action.scope === "payees" && named.includes("*")) return bad("an approval never covers every payee: name them");
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
      if (Number.isNaN(cap) || !(cap > 0)) return bad("a sub-account's float is more than zero");
      if (agentStatus(s, agent, nowMs) !== "ok") return bad("a sub-account belongs to an agent key that is authorised now");
      if (s.subAccounts.some((x) => x.name === name)) return bad(`a sub-account named "${name}" exists`);
      if (s.subAccounts.length >= MAX_SUB_ACCOUNTS) return limit(`at most ${MAX_SUB_ACCOUNTS} sub-accounts`, { max: MAX_SUB_ACCOUNTS });
      const seq = s.seq + 1;
      return { ...s, seq, subAccounts: [...s.subAccounts, { id: `sub-${String(seq).padStart(4, "0")}`, name, agent, address: simKey(`sub-account:${name}`).address, capMicro: cap, balanceMicro: 0, at }] };
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
        else if (pending) owners.push({ id, kind: "device", label: "device", jwk: pending.jwk, addedAt: at });
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
    default:
      return bad(`"${action.type}" does not change the account's settings`);
  }
}

/** the standing approval that covers this agent and scope right now, if any */
export function spendFor(s: AccountState, agent: string, scope: SpendApproval["scope"], nowMs: number): SpendApproval | Refusal {
  const all = s.spends.filter((x) => x.agent === agent.toLowerCase() && x.scope === scope);
  const live = all.find((x) => x.revokedAt === undefined);
  if (!live) return no("E_MANDATE_NONE", { message: scope === "venues" ? "the owner has not approved this agent to move money between venues" : scope === "trade" ? "the owner has not approved this agent to trade: it gets a trading limit on the account page (Agents)" : "the owner has not approved this agent to pay anyone", detail: { scope, hadOne: all.length > 0 } });
  if (nowMs >= live.validUntil) return no("E_MANDATE_EXPIRED", { detail: { approval: live.id, validUntil: new Date(live.validUntil).toISOString() } });
  return live;
}

/** Does this approval cover a payment of `amount` to `target` now? The answer names the limit that said no. */
export function covers(a: SpendApproval, target: string, amountMicro: number, nowMs: number): Refusal | null {
  if (!a.allow.includes(target) && !(a.scope === "venues" && a.allow.includes("*"))) return no("E_MANDATE_RECIPIENT", { message: a.scope === "trade" ? `the trading limit does not cover "${target}" (it covers ${a.allow.join(", ")})` : `"${target}" is not in the spending approval (${a.allow.join(", ")})`, detail: { approval: a.id, allow: a.allow, target } });
  if (amountMicro > a.perPaymentMicro) return no("E_MANDATE_PER_ORDER_CAP", { ...(a.scope === "trade" ? { message: `an order of $${(amountMicro / 1e6).toFixed(2)} is more than the $${(a.perPaymentMicro / 1e6).toFixed(2)} an order the trading limit allows` } : {}), detail: { approval: a.id, perPayment: a.perPaymentMicro / 1e6, amount: amountMicro / 1e6 } });
  const left = a.budgetMicro - a.spentMicro - a.reservedMicro;
  if (amountMicro > left) return no("E_MANDATE_BUDGET", { message: `the spending approval has $${(left / 1e6).toFixed(2)} left of $${(a.budgetMicro / 1e6).toFixed(2)}; $${(amountMicro / 1e6).toFixed(2)} is more than that`, detail: { approval: a.id, budget: a.budgetMicro / 1e6, spent: a.spentMicro / 1e6, reserved: a.reservedMicro / 1e6, amount: amountMicro / 1e6 } });
  const last = a.last[target];
  if (a.windowHours > 0 && last !== undefined && nowMs - last < a.windowHours * 3_600_000) return no("E_MANDATE_RATE", { message: `"${target}" was refilled ${Math.round((nowMs - last) / 60_000)} min ago; the approval allows one every ${a.windowHours} h`, detail: { approval: a.id, windowHours: a.windowHours, lastAt: new Date(last).toISOString() } });
  return null;
}
