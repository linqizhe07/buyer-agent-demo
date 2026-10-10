/** EARN at venues connected live: the account's door for putting the user's money to work in a venue's own products, and taking it back.
 *
 * A product is the venue's own — a DeFi vault the MetaMask Agent Wallet deposits into through mm, OKX's Simple Earn Flexible, a Kraken Earn
 * strategy (live/earn.ts) — and money goes in or comes out by ONE venue call, only when all of this holds:
 *
 *   1. the server moves real money (it does unless it was started `--read-only`); for the MetaMask Agent Wallet, MetaMask's own switch too
 *      (PORTFOLIO_MM_WRITES=1), exactly as for its swaps and orders;
 *   2. the venue offers the product now, takes money into it (a supply) or out of it (a withdrawal), and the asset is the product's own;
 *   3. it is worth no more than the most one movement may be on this server (`--live-cap`), valued at the asset's price now;
 *   4. the OWNER signed it — the venue, the product, the exact amount, what it is worth, where money taken out lands, and ten minutes — or an
 *      AGENT asked inside the earn limit the owner signed for it (which venues or products, how much one supply, how much in all, until
 *      when), with the dial open to it (the session, the venue switched on, `subscribe` / `redeem` reach). Guard mode: the agent's
 *      request is a card the owner signs, and the owner's yes runs exactly the card; Beast: a supply inside its limit runs at once, and
 *      a withdrawal inside its per-supply line;
 *   5. the venue itself agrees: its own key permissions, tiers, minimums and region rules still apply, and its refusal is the answer.
 *
 * Money taken out lands where it came from, at the same venue, always: neither action names a destination, and no adapter sends one. A
 * supply counts against an agent's earn limit (dollars put in); a withdrawal only brings the user's money back and counts nothing, but is
 * still the owner's to see. Every request is a line on the statement (type "earn") and a row on the ledger, and one still under way when the
 * account stops is followed again after a restart (account/restore.ts): nothing is sent again, it is only asked about.
 */
import { createHash, randomBytes } from "node:crypto";
import { keccak256, stringToHex, type Hex } from "viem";
import { isRefusal, type Refusal } from "../../core/errors.ts";
import { canonical } from "../../core/hash.ts";
import { no } from "../refuse.ts";
import { isExpired } from "../openness.ts";
import type { EarnPosition, EarnProduct, EarnState, LiveEarner } from "../live/earn.ts";
import { holdBackMs } from "../live/public-markets.ts";
import { plain } from "../live/trade.ts";
import { isStable } from "../live/types.ts";
import type { CardLike, Outcome } from "./exchange.ts";
import type { LiveEngine, LiveVenue } from "./live-moves.ts";
import type { StatementLine } from "./statement.ts";
import { CARD_TTL_MS } from "./mode-rules.ts";
import { micro, type AgentAction, type Envelope, type OwnerAction } from "./sign.ts";
import { covers, spendFor, type AgentKey, type SpendApproval } from "./state.ts";

export type LiveEarnAction = Extract<OwnerAction, { type: "liveEarn" }>;
export type AgentLiveEarnAction = Extract<AgentAction, { type: "agentLiveEarn" }>;
export type EarnKind = "supply" | "withdraw";

/** one request the account made of a venue's earn, as the page, the ledger and an agent see it */
export interface LiveEarn {
  /** the account's id: `earn-0001` */
  id: string;
  /** what the venue was given as its idempotency key, where it takes one: new in every run of the account */
  clientId: string;
  at: string;
  updatedAt: string;
  venue: string;
  venueName: string;
  kind: EarnKind;
  product: string;
  productName: string;
  asset: string;
  /** in the asset; a withdrawal of all of it says so (`all`) */
  amount: number;
  all?: boolean | undefined;
  /** what it was worth in dollars when it was asked */
  usd: number;
  apy?: number | undefined;
  rateKind?: "apy" | "apr" | undefined;
  lockDays?: number | undefined;
  /** where money taken out lands: the venue it came from */
  lands: string;
  status: EarnState["status"];
  /** the venue's id for it, or the transaction's hash */
  ref: string;
  signer: string;
  authority: "owner" | "agent";
  agent?: string | undefined;
  card?: string | undefined;
  /** the earn limit a supply counts against, until it is done */
  approval?: string | undefined;
  note: string;
  native: unknown;
}

/** what the owner is shown before signing: the product, its yield and lock, the amount, what it is worth, where money taken out lands */
export interface EarnQuote {
  words: string;
  kind: EarnKind;
  venue: string;
  venueName: string;
  product: string;
  productName: string;
  asset: string;
  amount: number;
  usd: number;
  apy?: number | undefined;
  apyHigh?: number | undefined;
  rateKind?: "apy" | "apr" | undefined;
  lockDays?: number | undefined;
  minAmount?: number | undefined;
  protocol?: string | undefined;
  chain?: string | undefined;
  lands: string;
  note?: string | undefined;
  /** a withdrawal: what is held in it now */
  held?: { amount: number; asset: string; usd?: number | undefined } | undefined;
  capUsd: number;
}

/** the venues' earn, as the engine's host offers it */
export interface EarnDesk {
  earner(venue: string): LiveEarner | undefined;
}

/** what this door uses of the engine, besides what the money door uses */
export interface EarnEngine extends LiveEngine {
  earns: LiveEarn[];
  nextEarnId(): string;
  host: LiveEngine["host"] & { liveEarn?(): EarnDesk | undefined };
}

interface Fields {
  venue: string;
  kind: string;
  product: string;
  asset: string;
  amount: string;
}

interface Plan {
  v: LiveVenue;
  earner: LiveEarner;
  p: EarnProduct;
  kind: EarnKind;
  amount: number;
  all: boolean;
  usd: number;
  held?: EarnPosition | undefined;
}

const TTL_MS = 10 * 60_000;
const POLL_MS = 15_000;
const READ_MS = 15_000;
const DEC = /^\d+(\.\d{1,18})?$/;
const text = (v: unknown) => (typeof v === "string" ? v : "");
const same = (a: string, b: string) => a.toUpperCase() === b.toUpperCase();
const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const qtyText = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 8 });
const cents = (n: number) => Math.ceil(n * 100 - 1e-6) / 100;
const pct = (f: number) => `${(f * 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** a request's line on the statement: money into or out of an earn product, between the user's own places, so neither in nor out */
export function earnLine(e: LiveEarn, agentName: (address: string) => string): Omit<StatementLine, "type"> & { type: "earn" } {
  return {
    key: `earn:${e.clientId}`,
    id: e.id,
    at: e.at,
    updatedAt: e.updatedAt,
    type: "earn",
    kind: e.kind,
    account: e.venue,
    accountName: e.venueName,
    description: `${capital(e.kind)} ${e.all ? "all of the" : qtyText(e.amount)} ${e.asset} · ${e.productName}${e.apy !== undefined ? ` · ${pct(e.apy)} ${(e.rateKind ?? "apy").toUpperCase()}` : ""}${e.kind === "withdraw" ? ` · back to ${e.lands}` : ""}`,
    amountUsd: Number(e.usd.toFixed(2)),
    status: e.status,
    by: e.authority === "agent" ? `${agentName(e.agent ?? "")}, ${e.card ? "approved by you" : "inside its limit"}` : "You",
    ...(e.authority === "agent" && e.agent ? { agent: e.agent, agentName: agentName(e.agent) } : {}),
    ...(e.ref ? { ref: e.ref } : {}),
  };
}

export class LiveEarns {
  private readonly polled = new Map<string, number>();
  /** the venues this door's poll holds back, and why (live-orders.ts holds its own by the same rule): a ban until the venue's time, its
   * place rule or edge for ten minutes */
  private readonly holds = new Map<string, { until: number; r: Refusal }>();
  /** what each waiting card showed the owner: its yes runs exactly this */
  private readonly shown = new Map<string, { product: string; amount: number; all: boolean; usd: number; target: string }>();
  /** this run of the account: part of every client id it sends */
  private readonly run = randomBytes(8).toString("hex");
  constructor(private readonly e: EarnEngine) {}

  private money() {
    return this.e.host.liveMoney?.();
  }

  /** Everything that does not depend on who signed: the switch, the venue, its earn, the product, the asset, the amount, its worth, the cap */
  private async plan(raw: Fields): Promise<Plan | Refusal> {
    const f: Fields = { venue: text(raw.venue), kind: text(raw.kind), product: text(raw.product).trim(), asset: text(raw.asset).trim(), amount: text(raw.amount).trim() };
    const m = this.money();
    if (!m) return no("E_ACCOUNT_BAD_ACTION", { message: "this account has no venues connected live" });
    const w = m.writes();
    if (!w.on) return no("E_WALLET_LIVE_WRITES_OFF", { message: `this server moves no money: it was started read-only. To earn, stop it and start it again with: ${w.turnOn}`, detail: { turnOn: w.turnOn } });
    const v = m.venue(f.venue);
    if (!v) {
      // connected, and waiting for its venue to answer this network: said as that, not as a venue that is not on the account
      const waiting = m.waiting?.(f.venue);
      if (waiting) return no("E_VENUE_UNREACHABLE", { venue: f.venue, message: `${waiting}: nothing goes in or out of earn there until it answers`, detail: { waiting: true } });
      return no("E_WALLET_ACCOUNT_UNKNOWN", { venue: f.venue, message: `"${f.venue}" is not a venue connected live: money goes to earn only at venues connected live` });
    }
    // held back — its place rule or the server in front of it refusing this network, a ban, a wait it named: nothing is asked of it, by the
    // account's one hold shared with its reads and the other doors
    const held0 = this.heldAt(v.id);
    if (held0) return held0;
    const earner = this.e.host.liveEarn?.()?.earner(v.id);
    if (!earner) return no("E_VENUE_RAIL_CLOSED", { venue: v.id, message: `${v.name} offers no earn products to the account: no interface for them is connected there` });
    if (v.address !== undefined && !v.proven) return no("E_VENUE_RAIL_CLOSED", { venue: v.id, message: `${v.name} is watched, not proven yours: nothing goes to earn from it here` });
    if (earner.can === false) return no("E_VENUE_PERMISSION", { venue: v.id, message: `${v.name}: ${earner.whyNot ?? "this key may not move money into earn. That is set on the key at the venue"}` });
    if (f.kind !== "supply" && f.kind !== "withdraw") return no("E_ACCOUNT_BAD_ACTION", { message: 'earn is a "supply" (money in) or a "withdraw" (money back out)' });
    const kind = f.kind as EarnKind;
    if (!f.product || f.product.length > 120) return no("E_ACCOUNT_BAD_ACTION", { message: "earn names its product, as the venue's earn list gives it" });
    if (!/^[A-Za-z0-9.]{1,20}$/.test(f.asset)) return no("E_ACCOUNT_BAD_ACTION", { message: "earn names the product's asset by its symbol: USDC, BTC" });
    const allAsked = f.amount === "all";
    if (allAsked ? kind !== "withdraw" : !DEC.test(f.amount) || !(Number(f.amount) > 0)) return no("E_ACCOUNT_BAD_ACTION", { message: allAsked ? '"all" takes everything out of a product: it is for a withdrawal' : "an amount is a plain decimal, more than zero" });

    // a product this venue answered it does not offer to this network (its rule for this product alone): not offered, nor sent again, for a while
    const not = this.notHere.get(`${v.id}|${f.product}`);
    if (not && kind === "supply" && Date.now() < not.until) return not.r;
    const p = await safely(() => earner.product(f.product), v.id, v.name, READ_MS);
    if (isRefusal(p)) {
      this.holdOn(v.id, p);
      return p;
    }
    if (!same(p.asset, f.asset)) return no("E_ACCOUNT_BAD_ACTION", { venue: v.id, message: `${p.name} takes ${p.asset}, not ${f.asset}` });
    let amount = allAsked ? 0 : Number(f.amount);
    let all = allAsked;
    let held: EarnPosition | undefined;
    if (kind === "supply") {
      if (!p.canSupply) return no("E_VENUE_MARKET_CLOSED", { venue: v.id, message: p.why ?? `${v.name} takes no money into ${p.name} now` });
      if (p.minAmount !== undefined && amount < p.minAmount - 1e-12) return no("E_VENUE_ORDER_INVALID", { venue: v.id, message: `${v.name}: the least that goes into ${p.name} is ${qtyText(p.minAmount)} ${p.asset}`, detail: { minAmount: p.minAmount } });
    } else {
      if (!p.canWithdraw) return no("E_VENUE_MARKET_CLOSED", { venue: v.id, message: `${v.name} lets nothing out of ${p.name} now` });
      const list = await safely(() => earner.positions(), v.id, v.name, READ_MS);
      if (isRefusal(list)) {
        this.holdOn(v.id, list);
        return list;
      }
      held = list.find((x) => x.product === p.id);
      if (!held) return no("E_ACCOUNT_BAD_ACTION", { venue: v.id, message: `${v.name} shows nothing of yours in ${p.name}` });
      // what is held, in the product's asset: as the venue counts it, or — a vault counted in its own shares — by its dollars at the price
      const inAsset = same(held.asset, p.asset) ? held.amount : held.usd !== undefined && p.priceUsd ? held.usd / p.priceUsd : undefined;
      if (allAsked) amount = inAsset ?? 0;
      else if (inAsset !== undefined && amount > inAsset * (1 + 1e-9)) return no("E_VENUE_INSUFFICIENT", { venue: v.id, message: `${v.name} shows ${qtyText(inAsset)} ${p.asset} of yours in ${p.name}: ${qtyText(amount)} is more than that`, detail: { held: inAsset } });
      else if (inAsset !== undefined && amount >= inAsset * (1 - 1e-9)) all = true;
    }
    const price = isStable(p.asset) ? 1 : p.priceUsd;
    const worth = all && held?.usd !== undefined ? held.usd : price !== undefined && amount > 0 ? amount * price : undefined;
    if (worth === undefined) return no("E_ACCOUNT_UNPRICED", { venue: v.id, message: `${p.asset} has no dollar price here right now, so no limit can be judged: nothing goes in or out of ${p.name}` });
    if (worth > w.capUsd + 1e-9) return no("E_ACCOUNT_LIMIT", { venue: v.id, message: `${usd(worth)} is more than the most one movement may be on this server (${usd(w.capUsd)}). It is set when the server starts: --live-cap`, detail: { capUsd: w.capUsd, usd: worth } });
    return { v, earner, p, kind, amount, all, usd: worth, ...(held ? { held } : {}) };
  }

  /** the dial, as it stands: the agents' session, the venue switched off for agents, and — where the owner narrowed a venue's reach — whether
   * it lets agents subscribe (money in) or redeem (money out) there */
  private dial(venue: string, kind: EarnKind): Refusal | null {
    const o = this.e.host.policy();
    if (isExpired(this.e.host.now(), o.sessionExpiresAt)) return no("E_WALLET_SESSION_EXPIRED", { venue, message: "the agent's session has expired: every write stops, reads continue", detail: { sessionExpiresAt: o.sessionExpiresAt } });
    if (o.revoked.includes(venue)) return no("E_WALLET_ACCOUNT_REVOKED", { venue, message: `${venue} is switched off for agents: reads only`, detail: { revoked: o.revoked } });
    const reach = o.reach[venue];
    const cap = kind === "supply" ? "subscribe" : "redeem";
    if (reach && !reach.includes(cap)) return no("E_WALLET_REACH", { venue, message: `the owner did not open ${kind === "supply" ? "putting money to earn" : "taking money out of earn"} at ${this.money()?.venue(venue)?.name ?? venue} to agents`, detail: { reach } });
    return null;
  }

  /** a card closed without an answer (it expired): what it showed is not kept for a yes that cannot come */
  forget(card: string): void {
    this.shown.delete(card);
  }

  /** the agent's earn limit as it stands now, its owner signature still good, the venue (or the product there) in it, the dial open */
  private async limit(signer: string, venue: string, product: string, kind: EarnKind): Promise<{ spend: SpendApproval; target: string } | Refusal> {
    const now = Date.parse(this.e.host.now());
    const spend = spendFor(this.e.state, signer, "earn", now);
    if (isRefusal(spend)) return spend;
    if (!(await this.e.stillSigned(spend))) return no("E_ACCOUNT_BAD_SIGNATURE", { message: "the earn limit's own signature no longer checks out against the account's owners", detail: { approval: spend.id } });
    const narrow = `${venue}:${product}`;
    const target = spend.allow.includes(narrow) ? narrow : venue;
    if (!spend.allow.includes(target)) return covers(spend, narrow, 0, now)!;
    return this.dial(venue, kind) ?? { spend, target };
  }

  private words(p: Plan): string {
    return `${p.kind === "supply" ? "put" : "take"} ${p.all && p.kind === "withdraw" ? "all of the" : qtyText(p.amount)} ${p.p.asset} ${p.kind === "supply" ? "into" : "out of"} ${p.p.name} at ${p.v.name}${p.p.apy !== undefined ? ` (${pct(p.p.apy)}${p.p.apyHigh !== undefined ? `–${pct(p.p.apyHigh)}` : ""} ${(p.p.rateKind ?? "apy").toUpperCase()})` : ""} · about ${usd(p.usd)}`;
  }

  private quoteOf(p: Plan): EarnQuote {
    return { words: this.words(p), kind: p.kind, venue: p.v.id, venueName: p.v.name, product: p.p.id, productName: p.p.name, asset: p.p.asset, amount: p.amount, usd: Number(p.usd.toFixed(2)), ...(p.p.apy !== undefined ? { apy: p.p.apy } : {}), ...(p.p.apyHigh !== undefined ? { apyHigh: p.p.apyHigh } : {}), ...(p.p.rateKind ? { rateKind: p.p.rateKind } : {}), ...(p.p.lockDays !== undefined ? { lockDays: p.p.lockDays } : {}), ...(p.p.minAmount !== undefined ? { minAmount: p.p.minAmount } : {}), ...(p.p.protocol ? { protocol: p.p.protocol } : {}), ...(p.p.chain ? { chain: p.p.chain } : {}), lands: p.p.lands, ...(p.p.note ? { note: p.p.note } : {}), ...(p.held ? { held: { amount: p.held.amount, asset: p.held.asset, ...(p.held.usd !== undefined ? { usd: p.held.usd } : {}) } } : {}), capUsd: this.money()!.writes().capUsd };
  }

  /** what the owner is shown and signs: the product, the exact amount, what it is worth, where money taken out lands, ten minutes */
  async prepare(draft: Record<string, unknown>): Promise<{ action: Omit<LiveEarnAction, "nonce">; quote: EarnQuote } | Refusal> {
    const p = await this.plan({ venue: String(draft.venue ?? ""), kind: String(draft.kind ?? ""), product: String(draft.product ?? ""), asset: String(draft.asset ?? ""), amount: String(draft.amount ?? "") });
    if (isRefusal(p)) return p;
    return { action: { type: "liveEarn", venue: p.v.id, kind: p.kind, product: p.p.id, asset: p.p.asset, amount: plain(p.amount), maxUsd: cents(p.usd).toFixed(2), lands: p.p.lands, deadline: this.money()!.realNow() + TTL_MS }, quote: this.quoteOf(p) };
  }

  /** The owner's signed request: planned again, held to what was signed (its worth, where money taken out lands), sent */
  async owner(a: LiveEarnAction, who: { signer: string; envelope: Envelope; hash: Hex }): Promise<Outcome> {
    const p = await this.plan({ venue: a.venue, kind: a.kind, product: a.product, asset: a.asset, amount: a.amount });
    if (isRefusal(p)) return p;
    if (this.money()!.realNow() > a.deadline) return no("E_ACCOUNT_EXPIRED", { message: "this was good for ten minutes after it was prepared: prepare it again" });
    const held = this.hold(p, Number(a.maxUsd), a.lands, "signed for");
    if (held) return held;
    return this.send(p, { signer: who.signer, authority: "owner", action: who.hash, envelope: who.envelope });
  }

  /** held to what was agreed: the same product, landing where it was said to, worth no more than was agreed (a price that rose past it is a
   * new signature) */
  private hold(p: Plan, worth: number, lands: string | undefined, what: string): Refusal | null {
    if (lands !== undefined && p.p.lands !== lands) return no("E_ACCOUNT_REQUOTE", { venue: p.v.id, message: `${p.p.name} now says money taken out lands in ${p.p.lands}, not ${lands} as ${what}: prepare it again` });
    if (p.usd > worth + 0.005) return no("E_ACCOUNT_REQUOTE", { venue: p.v.id, message: `the price moved: ${qtyText(p.amount)} ${p.p.asset} is worth ${usd(p.usd)} now, more than the ${usd(worth)} ${what}. Nothing moved`, detail: { usd: p.usd, maxUsd: worth } });
    return null;
  }

  /** An agent's request. Its earn limit and the dial first; then Guard: a card the owner signs; Beast: a supply inside its
   * limit at once, a withdrawal inside its per-supply line at once */
  async agent(a: AgentLiveEarnAction, who: { signer: string; envelope: Envelope; hash: Hex; agent: AgentKey }): Promise<Outcome> {
    const now = Date.parse(this.e.host.now());
    const kind = text(a.kind) === "withdraw" ? "withdraw" : "supply";
    const lim = await this.limit(who.signer, text(a.venue), text(a.product).trim(), kind);
    if (isRefusal(lim)) return lim;
    const p = await this.plan({ venue: a.venue, kind: a.kind, product: a.product, asset: a.asset, amount: a.amount });
    if (isRefusal(p)) return p;
    const { spend, target } = lim;
    const flight = this.e.host.openFlight({ id: slug(who.agent.name), name: who.agent.name, code: who.agent.code }, `${this.words(p)} · real money`);
    const amount = micro(p.usd.toFixed(6));
    if (this.e.host.policy().mode === "open") {
      if (p.kind === "supply") {
        const c = covers(spend, target, amount, now);
        if (c) return c;
        const out = await this.charged(spend.id, target, p, { signer: who.signer, authority: "agent", agent: who.agent.address, action: who.hash, approval: spend.id });
        if (isRefusal(out)) return out;
        this.e.host.log({ kind: "action", venue: p.v.id, tool: a.type, signer: who.signer, envelope: who.envelope, outcome: "accepted", notionalUsd: p.usd, reason: `Beast: ${this.words(p)}, inside the earn limit`, flight: flight.no });
        this.e.host.say(flight.no, `${who.agent.name} ${this.words(p)}: inside its limit, so it went without a card (Beast)`, "ok");
        return { ...out, flight: flight.no } as Outcome;
      }
      // a withdrawal brings the user's money back where it was: it counts nothing, and goes at once inside the per-supply line
      if (amount <= spend.perPaymentMicro) {
        const out = await this.send(p, { signer: who.signer, authority: "agent", agent: who.agent.address, action: who.hash, envelope: who.envelope });
        if (!isRefusal(out)) this.e.host.say(flight.no, `${who.agent.name} ${this.words(p)}: inside its line, so it went without a card (Beast)`, "ok");
        return isRefusal(out) ? out : ({ ...out, flight: flight.no } as Outcome);
      }
    }
    // the card holds what it shows, to the cent: a supply holds that much of the limit while it waits; a withdrawal holds none of it
    const worth = cents(p.usd);
    if (p.kind === "supply") {
      const c = covers(spend, target, micro(worth.toFixed(2)), now);
      if (c) return c;
    }
    const offer = { payee: p.v.name, payTo: p.p.name, amount: `${p.kind} ${p.all && p.kind === "withdraw" ? "all of the" : qtyText(p.amount)} ${p.p.asset}`, protocol: `earn${p.p.apy !== undefined ? ` · ${pct(p.p.apy)} ${(p.p.rateKind ?? "apy").toUpperCase()}` : ""}${p.p.lockDays ? ` · out after ${p.p.lockDays} days` : ""}`, network: `worth about ${usd(worth)} · money taken out lands in ${p.p.lands}` };
    // the owner's answer signs the card's hash: the agent's request AND the product, the amount and the worth the owner is shown
    const actionHash = keccak256(stringToHex(canonical({ action: who.hash, offer, product: p.p.id, amount: plain(p.amount), all: p.all, worth: worth.toFixed(2) })));
    const card = this.e.host.raiseCard(flight.no, { account: p.v.id, intent: p.kind === "supply" ? { kind: "subscribe", fund: `${p.v.id}:${p.p.id}`, amountUsd: worth } : { kind: "redeem", fund: `${p.v.id}:${p.p.id}`, amountUsd: worth }, usd: worth, reason: `${who.agent.name} asks to ${this.words(p)}`, why: "live", action: a, actionHash, signer: who.signer, expiresAt: new Date(now + CARD_TTL_MS).toISOString(), offer, ...(p.kind === "supply" ? { approval: spend.id } : {}) });
    this.shown.set(card.id, { product: p.p.id, amount: p.amount, all: p.all, usd: worth, target });
    if (p.kind === "supply") this.e.patchSpend(spend.id, (x) => ({ ...x, reservedMicro: x.reservedMicro + micro(worth.toFixed(2)) }));
    this.e.host.log({ kind: "action", venue: p.v.id, tool: a.type, signer: who.signer, envelope: who.envelope, outcome: "card", notionalUsd: worth, reason: `${card.id} · ${this.words(p)}`, flight: flight.no, intentId: card.id });
    return { ok: true, kind: "card", pending: true, card, flight: flight.no };
  }

  /** The owner approved an agent's request: exactly what the card showed — the product, the amount — judged again against the agent's earn
   * limit as it stands now (answering the card has already freed what it held), the limit's signature and the dial */
  async release(card: CardLike, who: { signer: string; agent: AgentKey }): Promise<Outcome> {
    const a = card.action as AgentLiveEarnAction;
    const shown = this.shown.get(card.id);
    this.shown.delete(card.id);
    if (!shown) return no("E_ACCOUNT_REQUOTE", { message: "this card's request is not known to this run of the account: the agent asks again" });
    const kind = text(a.kind) === "withdraw" ? "withdraw" : "supply";
    const lim = await this.limit(who.signer, text(a.venue), shown.product, kind);
    if (isRefusal(lim)) return lim;
    const p = await this.plan({ venue: a.venue, kind: a.kind, product: shown.product, asset: a.asset, amount: shown.all && kind === "withdraw" ? "all" : plain(shown.amount) });
    if (isRefusal(p)) return p;
    if (p.kind === "supply") {
      const held = this.hold(p, card.usd, undefined, "on the card");
      if (held) return held;
      const c = covers(lim.spend, lim.target, micro(p.usd.toFixed(6)), Date.parse(this.e.host.now()));
      if (c) return c;
      return this.charged(lim.spend.id, lim.target, p, { signer: who.signer, authority: "agent", agent: who.agent.address, card: card.id, action: card.actionHash, approval: lim.spend.id });
    }
    return this.send(p, { signer: who.signer, authority: "agent", agent: who.agent.address, card: card.id, action: card.actionHash });
  }

  /** counted against the earn limit first — and the target's turn in the limit's window taken (`last`: one supply per window there) — both
   * undone if the venue says no: a supply the venue refused (for this network, its place, the key's IP list, a ban) moved nothing, and is
   * not the window's one supply. A request the venue may have taken (its answer lost) is not a refusal: it stays counted */
  private async charged(approval: string, target: string, p: Plan, who: Who): Promise<Outcome> {
    const amount = micro(p.usd.toFixed(6));
    const now = Date.parse(this.e.host.now());
    const was = this.e.state.spends.find((x) => x.id === approval)?.last[target];
    this.e.patchSpend(approval, (x) => ({ ...x, spentMicro: x.spentMicro + amount, last: { ...x.last, [target]: now } }));
    const out = await this.send(p, who);
    if (isRefusal(out)) this.e.patchSpend(approval, (x) => ({ ...x, spentMicro: Math.max(0, x.spentMicro - amount), last: was === undefined ? Object.fromEntries(Object.entries(x.last).filter(([k]) => k !== target)) : { ...x.last, [target]: was } }));
    return out;
  }

  /** the one venue call, and the request it becomes */
  private async send(p: Plan, who: Who): Promise<Outcome> {
    const id = this.e.nextEarnId();
    const clientId = createHash("sha256").update(`${this.run}:${id}`).digest("hex").slice(0, 32);
    const at = new Date(this.money()!.realNow()).toISOString();
    const r = await safely(() => (p.kind === "supply" ? p.earner.supply(p.p, p.amount, clientId) : p.earner.withdraw(p.p, p.amount, clientId, p.all)), p.v.id, p.v.name);
    if (isRefusal(r)) {
      this.e.host.log({ kind: "account-refusal", venue: p.v.id, tool: "live earn", code: r.code, reason: r.message, native: r.native, signer: who.signer, ...(who.envelope ? { envelope: who.envelope } : {}) });
      // the venue's answer that asks to be left alone holds it for every read and door; its rule for this one product is remembered for it
      this.holdOn(p.v.id, r);
      if (p.kind === "supply" && r.code === "E_VENUE_GEOBLOCKED" && (r.detail as { scope?: unknown } | undefined)?.scope === "product") this.notHere.set(`${p.v.id}|${p.p.id}`, { until: Date.now() + 600_000, r });
      return r;
    }
    const e: LiveEarn = {
      id,
      clientId,
      at,
      updatedAt: at,
      venue: p.v.id,
      venueName: p.v.name,
      kind: p.kind,
      product: p.p.id,
      productName: p.p.name,
      asset: p.p.asset,
      amount: p.amount,
      ...(p.all && p.kind === "withdraw" ? { all: true } : {}),
      usd: Number(p.usd.toFixed(6)),
      ...(p.p.apy !== undefined ? { apy: p.p.apy } : {}),
      ...(p.p.rateKind ? { rateKind: p.p.rateKind } : {}),
      ...(p.p.lockDays !== undefined ? { lockDays: p.p.lockDays } : {}),
      lands: p.p.lands,
      status: r.status,
      ref: r.ref,
      signer: who.signer,
      authority: who.authority,
      ...(who.agent ? { agent: who.agent } : {}),
      ...(who.card ? { card: who.card } : {}),
      ...(who.approval && r.status !== "done" ? { approval: who.approval } : {}),
      note: "",
      native: r.native,
    };
    e.note = this.noteOf(e);
    this.e.earns.unshift(e);
    this.polled.set(id, this.money()!.realNow());
    this.e.host.log({ kind: "order", venue: p.v.id, tool: "live earn", outcome: e.status, venueOrderId: e.ref, notionalUsd: p.usd, reason: `${id} · real money · ${this.words(p)}`, native: r.native, signer: who.signer, ...(who.envelope ? { envelope: who.envelope } : {}) });
    if (e.status === "rejected") this.giveBack(e);
    this.line(e);
    // a request is answered as a result that carries it: `result.earn`
    return { ok: true, kind: "result", result: { earn: e } };
  }

  private noteOf(e: LiveEarn): string {
    const waiting = (e.native as { waiting?: unknown } | undefined)?.waiting;
    switch (e.status) {
      case "done":
        return e.kind === "supply" ? `in ${e.productName}: it earns from here` : `out of ${e.productName}: back in ${e.lands}${e.lockDays ? ` after the ${e.lockDays}-day unbonding` : ""}`;
      case "pending":
        return typeof waiting === "string" ? waiting : `${e.venueName} took it and has not finished it yet`;
      case "rejected":
        return `${e.venueName} did not finish it: nothing moved`;
    }
  }

  /** a supply the venue did not finish: what it counted goes back to the limit */
  private giveBack(e: LiveEarn): void {
    if (!e.approval) return;
    if (e.status === "rejected") this.e.patchSpend(e.approval, (x) => ({ ...x, spentMicro: Math.max(0, x.spentMicro - micro(e.usd.toFixed(6))) }));
    if (e.status !== "pending") e.approval = undefined;
  }

  /** the request's line on the statement, as it stands now — and the request itself, so that a restarted account follows it again */
  private line(e: LiveEarn): void {
    const l = earnLine(e, (address) => this.e.state.agents.find((k) => k.address === address)?.name ?? address);
    this.e.host.log({ kind: "statement", venue: e.venue, reason: `${l.id} · ${l.description} · ${l.status}`, detail: l, native: { earn: e } });
  }

  /** A request an earlier run made and did not see finished (account/restore.ts): followed again, as it was. Nothing is sent */
  adopt(e: LiveEarn): void {
    if (this.e.earns.some((x) => x.clientId === e.clientId)) return;
    const back: LiveEarn = { ...e, note: `${e.note ? `${e.note} · ` : ""}followed again after a restart` };
    this.e.earns.push(back);
    this.polled.set(e.id, 0);
    this.line(back);
  }

  /** What became of the requests still under way: each asked of its venue at most every fifteen seconds, for at most fifteen; one sweep at a
   * time. A venue that does not answer is asked again later; the request's share of a limit stays held until the venue says */
  poll(): Promise<void> {
    return (this.sweep ??= this.sweepOnce().finally(() => (this.sweep = undefined)));
  }
  private sweep: Promise<void> | undefined;

  /** the earn products a venue answered it does not offer to this network (`venue|product`), until when, and its answer */
  private readonly notHere = new Map<string, { until: number; r: Refusal }>();
  /** whether a product is offered to this network as far as this door has learned: false while the venue's own rule for it holds */
  offeredHere(venue: string, product: string): boolean {
    const n = this.notHere.get(`${venue}|${product}`);
    return !(n && Date.now() < n.until);
  }

  /** the refusal that holds a venue back now: the host's shared hold where it offers one (a forced re-check or a reconnect lets go of it
   * there) — only what the venue asked for, never a read that did not answer — or else this door's own */
  private heldAt(venue: string): Refusal | undefined {
    const host = this.money() as { held?(venue: string): Refusal | undefined } | undefined;
    if (host?.held) {
      const shared = host.held(venue);
      return shared && this.holdMs(shared, Date.now()) > 0 ? shared : undefined;
    }
    const own = this.holds.get(venue);
    if (own && Date.now() < own.until) return own.r;
    if (own) this.holds.delete(venue);
    return undefined;
  }

  /** a status answer that asks to be left alone — the venue's place rule or edge, a ban of this address or a wait it named — holds the venue
   * back for as long as the one rule says (live/public-markets.ts holdBackMs); a venue that only did not answer is asked again next time */
  private holdOn(venue: string, r: Refusal): void {
    const now = Date.now();
    const ms = this.holdMs(r, now);
    if (!(ms > 0)) return;
    const host = this.money() as { hold?(venue: string, r: Refusal): void } | undefined;
    if (host?.hold) return host.hold(venue, r);
    const was = this.holds.get(venue);
    if (!was || was.until < now + ms) this.holds.set(venue, { until: now + ms, r });
  }

  private holdMs(r: Refusal, now: number): number {
    return r.code === "E_VENUE_GEOBLOCKED" || typeof (r.native as { until?: unknown } | undefined)?.until === "number" ? holdBackMs(r, now) : 0;
  }

  private async sweepOnce(): Promise<void> {
    const m = this.money();
    if (!m) return;
    const now = m.realNow();
    // a venue held back is not asked about any of its requests until the hold runs out
    const due = this.e.earns.filter((x) => x.status === "pending" && !this.heldAt(x.venue) && now - (this.polled.get(x.id) ?? 0) >= POLL_MS);
    await Promise.all(due.map(async (x) => {
      if (this.heldAt(x.venue)) return;
      this.polled.set(x.id, now);
      const earner = this.e.host.liveEarn?.()?.earner(x.venue);
      if (!earner?.status) return;
      const stub: EarnProduct = { id: x.product, asset: x.asset, name: x.productName, lands: x.lands, canSupply: true, canWithdraw: true };
      // what was asked goes with it: a request whose answer was lost is settled by the venue's reads against what it left (live/earn.ts)
      const r = await safely(() => earner.status!(x.ref, stub, x.kind, { amount: x.amount, all: x.all, native: x.native }), x.venue, x.venueName, READ_MS);
      if (isRefusal(r)) this.holdOn(x.venue, r);
      if (isRefusal(r) || r.status === "pending") return;
      Object.assign(x, { status: r.status, ref: r.ref || x.ref, native: r.native, updatedAt: new Date(m.realNow()).toISOString() });
      x.note = this.noteOf(x);
      this.e.host.log({ kind: "order", venue: x.venue, tool: "live earn", outcome: x.status, venueOrderId: x.ref, reason: `${x.id} · ${x.note}` });
      this.giveBack(x);
      this.line(x);
    }));
  }
}

interface Who {
  signer: string;
  authority: "owner" | "agent";
  agent?: string | undefined;
  card?: string | undefined;
  action?: Hex | undefined;
  approval?: string | undefined;
  envelope?: Envelope | undefined;
}

/** A venue call that throws answers as a refusal, never as an exception through the door. A read may be given a time limit; a call that
 * moves money is not raced — a venue slow to answer may still have taken it */
async function safely<T>(call: () => Promise<T | Refusal>, venue: string, name: string, ms?: number): Promise<T | Refusal> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (ms === undefined) return await call();
    return await Promise.race([call(), new Promise<Refusal>((resolve) => (timer = setTimeout(() => resolve(no("E_VENUE_UNREACHABLE", { venue, message: `${name} did not answer in time` })), ms)))]);
  } catch (err) {
    return isRefusal(err) ? err : no("E_VENUE_REJECTED", { venue, message: `${name} answered in a way the account could not read`, native: { error: String((err as Error)?.message ?? err).slice(0, 200) } });
  } finally {
    if (timer) clearTimeout(timer);
  }
}
