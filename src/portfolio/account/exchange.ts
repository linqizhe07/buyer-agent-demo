/** The account's front door: every instruction comes in here, signed.
 *
 *   exchange(envelope)
 *     1. the signature        who signed? An owner key, an agent key, or nobody the account knows
 *     2. the same envelope    seen before → the first result, and nothing runs twice
 *     3. the signing class    an owner action from an agent key is refused, the way Hyperliquid
 *                             refuses a withdrawal signed by an API wallet; an account that needs
 *                             two signers gets two
 *     4. the nonce            Hyperliquid's window, spent only now that the signer is known to be
 *                             allowed; a money instruction is also only good for ten minutes
 *     5. the action           account settings (state.ts) · a movement (doors.ts plans it,
 *                             payments.ts flies it) · a swap · a payment to someone else · the
 *                             owner's answer to a card · a change of policy · real money at venues
 *                             connected live: an order (live-orders.ts), a movement (live-moves.ts),
 *                             money into or out of an earn product (live-earn.ts)
 *
 * What an AGENT key may ask for is narrow: move money between the user's own venues, swap, or
 * pay — each inside a spending approval the owner signed, each through doors that admit an
 * agent, each still judged by the openness dial (Guard's allowance and daily cap, an account
 * switched off, an ended session). Anything else is the owner's to sign.
 *
 * Alongside both, the steering, which is words and not authority: the owner signs a
 * watchlist and intents (what it would like done, by whom); an agent reports on an intent
 * addressed to it, and asks for what only the owner signs (a limit, a venue, a top-up …). An ask
 * is kept in memory for a day and closed by the owner's own signed answer; a key nobody let in
 * may ask one thing — to be let in, under a name — and is remembered like any stranger, nothing
 * spent. The owner may also decline an ask (answerAsk): it is closed, and the agent that asked is shown it was declined for a day.
 * No limit reads any of these.
 *
 * What the OWNER signs is exact: the route (its hash), the most it may cost and the latest it
 * may land. If the route, the fee or the arrival has changed by the time it runs, it is refused
 * and has to be signed again. An approval of a card names the card AND the hash of what it
 * releases, and releasing it runs every check again.
 */
import { keccak256, stringToHex } from "viem";
import type { LedgerRowInput } from "../../agent/ledger.ts";
import { isRefusal, type Refusal } from "../../core/errors.ts";
import { canonical } from "../../core/hash.ts";
import { no } from "../refuse.ts";
import { r2, tradeKinds, type Account, type AccountAdapter, type AgentId, type ExecResult, type Holding, type Intent } from "../accounts.ts";
import { agentWalletVenue } from "../live/agent-wallet.ts";
import { evaluate, type AskReason, type Openness } from "../openness.ts";
import { parseIntent, parseOrder } from "../intents.ts";
import { achArrival, etDate, whenLabel } from "./calendar.ts";
import { doorOf, plan, type Door, type Leg, type Rail, type Route, type RouteRequest, type VenueView, whyWatchOnly } from "./doors.ts";
import { heldUsd, inFlightUsd, launch, newPayment, settleDue, type Advance, type Authority, type Money, type Payment, type PaymentKind } from "./payments.ts";
import { actionHash, isAgentAction, isDeviceSig, isJwk, isOwnerAction, kidOf, malformed, micro, MONEY_TTL_MS, MONEY_TYPES, NonceBook, ownerTypedData, shownFields, signerOf, type Action, type AgentAction, type AnySig, type Envelope, type Hex, type Jwk, type OwnerAction, type SendAsset } from "./sign.ts";
import { LiveMoves, type LiveMoney } from "./live-moves.ts";
import { LiveOrders, type CloseQuote, type LiveOrder, type OrderQuote } from "./live-orders.ts";
import { LiveEarns, type EarnDesk, type EarnQuote, type LiveEarn } from "./live-earn.ts";
import type { KeptAuthorisation } from "./pay-real.ts";
import { CARD_TTL_MS, modeRules, type ModeRule } from "./mode-rules.ts";
import { activeAgents, agentStatus, applyOwner, applyReport, ASK_TTL_MS, askProblem, ASKS_PER_AGENT, ASKS_PER_HOUR, cleanName, covers, deviceKeys, EARN_NAMES, emptyState, isOwner, MAX_ASKS, nameHolder, refsOf, spendFor, type AccountState, type AgentKey, type AgentReport, type AskKind, type OwnerKey, type SpendApproval, type SubAccount } from "./state.ts";

const HUB = "metamask";
/** devices that have asked to sign and wait for an owner, at most, at one time */
const MAX_PENDING_DEVICES = 10;
const STABLE = new Set(["USD", "USDC", "USDT", "pUSD"]);
/** how long a card waits for the owner: written once, in account/mode-rules.ts (the page and the agents read it from there) */
export { CARD_TTL_MS };
/** how long the answer to an instruction is kept for the same envelope again: the nonce window. An envelope older than that is refused as
 * too old before the table is asked, so an entry past it is never read */
const RESULTS_KEPT_MS = 2 * 86_400_000;
/** what moves or holds only simulated money: routes between simulated venues, swaps and orders at them, floats, the address book, payees, app fees */
const SIMULATED_ONLY = new Set(["sendAsset", "swap", "agentSendAsset", "agentSwap", "agentPay", "createSubAccount", "userSetAbstraction", "setDestination", "approveBuilderFee", "agentExecute", "agentOrder"]);
/** what a real account with agent wallets also takes: an agent wallet, made by the owner's signature, and an agent's payment from one */
const REAL_PAYS = new Set(["agentPay", "createSubAccount"]);
const realOnly = (type: string) => no("E_ACCOUNT_BAD_ACTION", { tool: type, message: `this account holds real accounts only: "${type}" acts on simulated venues. Real orders are liveOrder (the owner) and agentLiveOrder (an agent); real money moves with liveMove and agentLiveMove`, detail: { use: ["liveOrder", "agentLiveOrder", "liveMove", "agentLiveMove"] } });

/** a card as the engine needs it from the flight board */
export interface CardLike {
  id: string;
  account: string;
  intent: Intent;
  usd: number;
  reason: string;
  status: "pending" | "approved" | "rejected";
  flight: string;
  batch?: Array<{ account: string; intent: Intent }> | undefined;
  /** the agent's signed instruction this card would release (an engine card); absent on a card the older write path raised */
  action?: AgentAction | undefined;
  actionHash?: Hex | undefined;
  signer?: string | undefined;
  expiresAt?: string | undefined;
  payment?: string | undefined;
  /** a card about a payment to someone else: what the payee asked for. The hash the owner signs covers these fields */
  offer?: CardOffer | undefined;
  /** the spending approval this card holds its share of: released there, and nowhere else, when the card is answered */
  approval?: string | undefined;
}

export interface CardOffer {
  payee: string;
  payTo: string;
  amount: string;
  protocol: string;
  network: string;
  /** a real-money movement: the most its fee may be, as the owner is shown it */
  fee?: string | undefined;
  /** a metered session: the most that is locked in escrow when it opens, and the escrow contract that holds it */
  deposit?: string | undefined;
  escrow?: string | undefined;
}

export interface FlightLike {
  no: string;
}

/** what the engine needs from the service it lives in */
export interface Host {
  /** the account holds real accounts only: the host shows it the venues connected live, and what moves only simulated money is refused */
  readonly real?: boolean | undefined;
  now(): string;
  adapter(id: string): AccountAdapter | undefined;
  accounts(): Account[];
  views(): Promise<VenueView[]>;
  policy(): Openness;
  dailyOutUsd(now: string): number;
  log(row: LedgerRowInput): void;
  openFlight(agent: AgentId, request: string): FlightLike;
  say(flight: string, text: string, mark?: "ok" | "no" | "wait" | "note", extra?: { usd?: number; approvalId?: string; account?: string }): void;
  raiseCard(flight: string, card: { account: string; intent: Intent; usd: number; reason: string; why: AskReason; action: AgentAction; actionHash: Hex; signer: string; expiresAt: string; offer?: CardOffer | undefined; approval?: string | undefined }): CardLike;
  card(id: string): CardLike | undefined;
  cards(): CardLike[];
  /** the older write path: one account, one intent. `signer` is the agent key that asked: a card this raises is answered only while that key stands */
  execute(accountId: string, intent: Intent, agent: AgentId, signer?: string): Promise<unknown>;
  order(base: string, side: "buy" | "sell", qty: number, agent: AgentId, signer?: string): Promise<unknown>;
  /** answer a card the older write path raised (it re-checks and settles) */
  decide(id: string, decision: "approve" | "reject"): Promise<ExecResult>;
  /** `outcome`: what releasing the card produced — kept on the card, because the agent that asked was not the one who answered */
  closeCard(id: string, status: "approved" | "rejected", note: string, outcome?: unknown): void;
  /** a change only the owner signs: opening the dial, switching an account back on, widening reach — and the owner's own acts on the simulation (talking to the page's agent, pushing the clock) */
  widen(change: string, value: string): Promise<Refusal | { ok: true; summary: string; data?: unknown }>;
  /** plug in a venue the owner names, and unplug one that was plugged in */
  connect(venue: string, connector: string, label: string, credentialRef: string): Refusal | { ok: true; summary: string; native?: unknown } | Promise<Refusal | { ok: true; summary: string; native?: unknown }>;
  disconnect(venue: string): Refusal | { ok: true; summary: string };
  /** the venues the owner could plug in, and how each is reached */
  connectable(): Connectable[];
  /** the LIVE connections this service can make: real venues, read through their own interfaces (absent on a host that has none) */
  live?(): LiveOptions;
  /** real money at venues connected live: whether this server moves it, and the venues (absent: none) */
  liveMoney?(): LiveMoney;
  /** when the server moves real money, the code it printed in its terminal: the first device becomes the owner only with it */
  pairingCode?(): string | undefined;
  /** a real account's agent wallets (live/agent-wallet.ts): the address of the key made for one, and the wallet shown on the account once
   * the owner has signed it into being */
  agentWalletAddress?(name: string): Hex | Refusal;
  agentWalletUp?(sub: SubAccount): Promise<void>;
  /** the earn of the venues connected live (live/earn.ts): each venue's earner, where it has one (absent: none earns) */
  liveEarn?(): EarnDesk | undefined;
  /** where the user can connect, as the host last judged it from the network it runs on (live/availability.ts): a venue that refuses this
   * network, or offers no way in, is never asked of the owner by an agent. Undefined: not judged yet */
  venueVerdict?(venue: string): { name: string; verdict: string; said?: string | undefined } | undefined;
}

/** one way of connecting a real venue, as the page offers it */
export interface LiveOption {
  /** what `connectVenue.connector` carries: `live:exchange:binance`, `live:alpaca`, `live:wallet` … */
  connector: string;
  label: string;
  /** a key file in the home directory, an address, the venue's own command line, or a sign-in on the venue's own page */
  needs: "key-file" | "address" | "cli" | "sign-in";
  /** what goes in the key file, or what kind of address */
  example: string;
  /** where the key file is looked for when the owner does not say */
  defaultRef?: string | undefined;
  /** the venues already on the account that this is the real side of */
  venues: string[];
  kind: string;
}

export interface LiveOptions {
  /** the home directory key files live in */
  home: string;
  options: LiveOption[];
  /** whether this server moves real money, the most one movement may be, and how to turn it on */
  writes?: { on: boolean; capUsd: number; turnOn: string } | undefined;
}

export interface Connectable {
  id: string;
  name: string;
  connector: string;
  /** how it is reached, in words */
  via: string;
  credential: string;
  credentialRef: string;
  /** what the account asks the venue about the credential */
  asks: string;
}

export type Outcome =
  | { ok: true; kind: "account"; summary: string }
  /** `data`: what a payee gave back for the money, when the payment bought something */
  | { ok: true; kind: "payment"; payment: Payment; flight?: string | undefined; data?: unknown }
  | { ok: true; kind: "card"; pending: true; card: CardLike; flight?: string | undefined }
  | { ok: true; kind: "result"; result: unknown; flight?: string | undefined }
  /** an order at a venue connected live, as it stands */
  | { ok: true; kind: "order"; order: LiveOrder; flight?: string | undefined }
  | Refusal;

/** something an agent asked the owner for, waiting: in memory only, for a day, until the owner's signed answer closes it */
export interface AgentAsk {
  id: string;
  agent: Hex;
  agentName: string;
  kind: AskKind;
  /** the venue it is about, or "" */
  venue: string;
  /** the dollars it is about (a limit, a top-up), or "" */
  usd: string;
  text: string;
  at: string;
  expiresAt: string;
}

/** an ask the owner declined (answerAsk): shown to the agent that asked for a day after, in memory only */
export type DeclinedAsk = AgentAsk & { declinedAt: string };
/** how long a declined ask is shown to the agent that asked it */
export const DECLINED_SHOWN_MS = 86_400_000;

export interface AccountSeed {
  owners?: OwnerKey[] | undefined;
}

export type PayAction = Extract<AgentAction, { type: "agentPay" }>;

/** the payment protocols the account answers on an agent's behalf, and the payees it has met (payees.ts mounts one) */
export interface Payer {
  pay(action: PayAction, who: { signer: string; agent: AgentKey; envelope: Envelope; hash: Hex }, released?: CardLike): Promise<Outcome>;
  /** land what time has made due: a session's deposit coming back after its grace period */
  tick(nowMs: number): void;
  /** the owner ends a payment session itself (by its channel id, or its payee's host) */
  closeByOwner(id: string): Promise<Refusal | { ok: true; summary: string }>;
  /** an authorisation a payee still held when the last run stopped, followed again (account/restore.ts) */
  adopt?(k: KeptAuthorisation): void;
  reset(): void;
  view(): PayView;
}

export interface PayView {
  payees: Array<{ host: string; protocol: string; payTo: string; paidUsd: number; payments: number; lastAt: string }>;
  sessions: Array<{ id: string; host: string; subAccount: string; depositUsd: number; spentUsd: number; status: string; openedAt: string; note?: string | undefined }>;
}

/** an instruction's route and where it ends, once the destination has been checked */
export interface Resolved {
  route: Route;
  /** what a spending approval has to name: a venue id, `sub:<name>`, or the address book label */
  target: string;
  usd: number;
  amountMicro: number;
  home: boolean;
  external?: Payment["external"];
  float?: SubAccount;
}

export const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
export const agentIdOf = (k: AgentKey): AgentId => ({ id: slug(k.name), name: k.name, code: k.code });
const dex = (s: string): { venue: string; ledger?: string | undefined } => {
  const [venue, ledger] = s.split(":");
  return { venue: venue ?? "", ...(ledger ? { ledger } : {}) };
};
const money = (usd: number) => `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const eta = (sec: number) => (sec < 60 ? "now" : sec < 3600 ? `~${Math.round(sec / 60)} min` : `~${Math.round(sec / 3600)} h`);

/** the hash an approval of a card has to name: the agent's instruction itself, or — for a card the older write path raised — the card's contents */
export function cardHash(c: CardLike): Hex {
  return c.actionHash ?? keccak256(stringToHex(canonical({ card: c.id, account: c.account, intent: c.intent, batch: c.batch?.map((s) => ({ account: s.account, intent: s.intent })) ?? null, usd: c.usd })));
}

export function routeWords(r: Route, names: (id: string) => string, nowMs: number): string {
  const hops = r.legs.map((l) => (l.step === "swap" ? `swap to ${l.token} at ${names(l.venue)}` : l.step === "shift" ? `${l.fromLedger} → ${l.toLedger} at ${names(l.venue)}` : l.step === "bridge" ? l.protocol : l.step === "in" ? `into ${names(l.venue)} (${l.protocol.split(" (")[0]})` : l.venue === HUB ? `the wallet sends it${l.chain ? ` on ${l.chain}` : ""}` : `out of ${names(l.venue)}${l.chain ? ` on ${l.chain}` : ""}`));
  return `${hops.join(" · ")} · fee ${money(r.feeUsd)} · lands ${whenLabel(nowMs, r.arrivalMs)}`;
}

export class AccountEngine {
  state: AccountState;
  readonly nonces = new NonceBook();
  payments: Payment[] = [];
  /** orders placed at venues connected live, newest first */
  orders: LiveOrder[] = [];
  private orderSeq = 0;
  /** the answer to each instruction taken, by its digest, for the nonce window: the same envelope again gets the same answer */
  private results = new Map<string, { at: number; out: Outcome }>();
  /** instructions an earlier run of this account took, read back from its ledgers: none of them is taken again */
  private readonly taken = new Set<string>();
  /** cards closed because nobody answered them in time (expireCards): an owner answering one late is told it expired, not that it is unknown */
  private readonly expired = new Set<string>();
  private seq = 0;
  private payer: Payer | undefined;
  /** the door for REAL money at venues connected live (account/live-moves.ts) */
  readonly live: LiveMoves;
  /** the door for ORDERS at venues connected live (account/live-orders.ts) */
  readonly trade: LiveOrders;
  /** the door for EARN at venues connected live (account/live-earn.ts) */
  readonly earn: LiveEarns;
  /** money put into earn products, or taken out, newest first */
  earns: LiveEarn[] = [];
  private earnSeq = 0;
  /** wrong pairing codes since the server started: after a few, none is accepted until it restarts */
  private codeMisses = 0;
  /** what agents have asked the owner for: in memory only, never rebuilt after a restart */
  private asks: AgentAsk[] = [];
  private askSeq = 0;
  /** per agent key, when its asks were taken in the last hour */
  private readonly askTimes = new Map<string, number[]>();
  /** asks the owner declined: in memory only, shown to the agent that asked for a day */
  private declined: DeclinedAsk[] = [];
  /** an ask the agent asked again, by its old id: the id of the ask that took its place. A replaced ask takes a new id, so the owner's
   * answer, signed by id, is only ever about the words the owner was shown */
  private readonly askReplaced = new Map<string, string>();

  constructor(
    readonly host: Host,
    private readonly seed: AccountSeed = {},
  ) {
    this.state = { ...emptyState(), owners: [...(seed.owners ?? [])] };
    this.live = new LiveMoves(this as never);
    this.trade = new LiveOrders(this as never);
    this.earn = new LiveEarns(this as never);
  }

  /** everything but the nonce books goes back to the start: an old signed envelope must not come back to life with the account */
  reset(): void {
    // the paired owner stays the owner: a reset that emptied the owners would hand the account to whoever paired next
    this.state = { ...emptyState(), owners: this.seed.owners?.length ? [...this.seed.owners] : this.state.owners, threshold: this.seed.owners?.length ? 1 : this.state.threshold };
    this.payments = [];
    this.orders = [];
    this.orderSeq = 0;
    this.earns = [];
    this.earnSeq = 0;
    this.results = new Map();
    this.seq = 0;
    this.asks = [];
    this.declined = [];
    this.askReplaced.clear();
    this.payer?.reset();
  }

  /** an authorisation a payee still held when the last run stopped: the payer that pays real money follows it again */
  adoptAuthorisation(k: KeptAuthorisation): void {
    this.payer?.adopt?.(k);
  }

  usePayer(p: Payer): void {
    this.payer = p;
  }

  /** a real account pays someone else only through agent wallets, and only with a payer that pays real money mounted */
  private paysReal(): boolean {
    return !!this.payer && !!this.host.agentWalletAddress;
  }

  /** how the owner's standing instructions shape a real account (state.ts ApplyOptions) */
  applyOptions(): { anyPayee: boolean; walletAddress?: (name: string) => Hex | Refusal } {
    return this.host.real && this.host.agentWalletAddress ? { anyPayee: true, walletAddress: (name) => this.host.agentWalletAddress!(name) } : { anyPayee: false };
  }

  /** An instruction an earlier process took, as its ledger recorded it. A signature outlives the process that first saw it: the instruction is
   * remembered by what it IS (its digest), so it is not taken again whoever of its signers presents it, in whatever order. */
  recall(signer: string, envelope: Envelope): void {
    try {
      const a = envelope.action;
      if (!a || typeof a.type !== "string" || (!isOwnerAction(a) && !isAgentAction(a))) return;
      this.taken.add(isOwnerAction(a) ? `owner:${actionHash(a)}` : `${signer}:${actionHash(a)}`);
      if (typeof envelope.nonce === "number") this.nonces.remember(signer, envelope.nonce);
    } catch {
      // a row that does not parse remembers nothing
    }
  }

  nowMs(): number {
    return Date.parse(this.host.now());
  }

  nextPaymentId(): string {
    return `pay-${String(++this.seq).padStart(4, "0")}`;
  }

  nextOrderId(): string {
    return `ord-${String(++this.orderSeq).padStart(4, "0")}`;
  }

  nextEarnId(): string {
    return `earn-${String(++this.earnSeq).padStart(4, "0")}`;
  }

  private money(): Money {
    return { adapter: (id) => this.host.adapter(id), hub: this.host.adapter(HUB)?.account.address ?? HUB };
  }

  name(id: string): string {
    return this.host.adapter(id)?.account.name ?? id;
  }

  // ---- the owner's device ---------------------------------------------------------

  /** A browser offers the public half of its device key. The first one becomes the owner's device (trust on first use: whoever opens the
   * page first holds the account — a real product pairs out of band); a later one waits until the owner makes it a signer. */
  pairDevice(jwk: unknown, label = "this browser", code?: string): { ok: true; kid: string; role: "owner" | "pending" | "needs-code" } | Refusal {
    if (!isJwk(jwk)) return no("E_ACCOUNT_BAD_ACTION", { message: "a device key is a P-256 public key (JWK)" });
    const kid = kidOf(jwk);
    const id = `device:${kid}`;
    if (isOwner(this.state, id)) return { ok: true, kid, role: "owner" };
    // a server that moves real money does not hand the account to the first browser to ask: the owner types the code its terminal printed
    const expected = this.host.pairingCode?.();
    if (this.state.owners.length === 0 && expected !== undefined) {
      if (code === undefined || code === "") return { ok: true, kid, role: "needs-code" };
      if (this.codeMisses >= 5) return no("E_ACCOUNT_OWNER_SURFACE", { message: "too many wrong pairing codes: restart the server for a new one" });
      const plain = (x: string) => x.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
      if (plain(code) !== plain(expected)) {
        this.codeMisses++;
        return no("E_ACCOUNT_OWNER_SURFACE", { message: `that is not the pairing code this server printed in its terminal (${5 - this.codeMisses} tries left)` });
      }
    }
    if (this.state.owners.length === 0) {
      this.state = { ...this.state, owners: [{ id, kind: "device", label, jwk: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, addedAt: this.host.now() }] };
      // its PUBLIC key rides on the row: a restarted account knows its owner's device again (account/restore.ts)
      // and whether it typed the pairing code: a restart that asks for one does not take an owner who paired without it
      this.host.log({ kind: "action", venue: "*", tool: "account_pair", signer: id, reason: `the first device to open the account became its owner's device (${label})`, native: { jwk: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, label, ...(expected !== undefined ? { code: true } : {}) } });
      return { ok: true, kid, role: "owner" };
    }
    if (!this.state.pendingDevices.some((d) => d.kid === kid)) {
      // a waiting device is only asking; an owner's signature makes it a signer (convertToMultiSigUser). At most ten wait at a time
      if (this.state.pendingDevices.length >= MAX_PENDING_DEVICES) return no("E_ACCOUNT_OWNER_SURFACE", { message: `${MAX_PENDING_DEVICES} devices are waiting already: the owner lets one in from a device that signs, or the server is restarted` });
      const key = { kty: "EC" as const, crv: "P-256" as const, x: jwk.x, y: jwk.y };
      // the label it gave goes with it: let in later, it is shown under that name, not as "device"
      this.state = { ...this.state, pendingDevices: [...this.state.pendingDevices, { kid, jwk: key, at: this.host.now(), label }] };
      // its PUBLIC key rides on the row too, so that the owner's signature making it a signer can be checked again after a restart
      this.host.log({ kind: "action", venue: "*", tool: "account_pair", signer: id, reason: `a device asked to sign for the account (${label}); it waits until an owner lets it in`, native: { jwk: key, label, pending: true } });
    }
    return { ok: true, kid, role: "pending" };
  }

  // ---- the front door ---------------------------------------------------------------

  private queue: Promise<unknown> = Promise.resolve();

  /** Instructions are taken ONE AT A TIME, in the order they arrive. Every check below reads the account and then waits on something (a venue, a
   * payee, a signature): two requests let in together would each see the budget as it was before the other spent it. A limit that two requests can
   * each pass alone is not a limit. */
  exchange(envelope: Envelope): Promise<Outcome> {
    return this.serially(() => this.take(envelope));
  }

  /** run `fn` in the same line as the instructions: what changes an order or a payment never runs in the middle of one */
  serially<T>(fn: () => Promise<T>): Promise<T> {
    const turn = this.queue.then(fn);
    this.queue = turn.catch(() => undefined);
    return turn;
  }

  private async take(envelope: Envelope): Promise<Outcome> {
    const action = envelope?.action as Action | undefined;
    if (!action || typeof action.type !== "string" || (!isOwnerAction(action) && !isAgentAction(action))) return this.refused(no("E_ACCOUNT_BAD_ACTION", { message: "not an instruction this account knows" }), envelope);
    // exactly what the signature covers, and nothing else: no fraction in a number, no field the type does not sign
    const wrong = malformed(action);
    if (wrong || envelope.nonce !== action.nonce) return this.refused(no("E_ACCOUNT_BAD_ACTION", { message: wrong ?? "the envelope's nonce is the action's nonce" }), envelope);
    const now = this.nowMs();
    const signer = await signerOf(action, envelope.signature, deviceKeys(this.state));
    if (!signer) return this.refused(no("E_ACCOUNT_BAD_SIGNATURE", { detail: { type: action.type } }), envelope);
    const hash = actionHash(action);

    let agent: AgentKey | undefined;
    // everyone whose signature counts on this envelope: the nonce is theirs, all of them
    const signers = new Set([signer]);
    if (isOwnerAction(action)) {
      if (!isOwner(this.state, signer)) {
        const status = agentStatus(this.state, signer, now);
        return this.refused(status === "unknown" ? no("E_ACCOUNT_UNKNOWN_SIGNER", { detail: { signer } }) : no("E_ACCOUNT_OWNER_ONLY", { message: `"${action.type}" is the owner's to sign: an agent key cannot withdraw, send, approve or change the account`, detail: { signer, type: action.type } }), envelope, signer);
      }
      for (const extra of envelope.cosignatures ?? []) {
        const who = await signerOf(action, extra as AnySig, deviceKeys(this.state));
        if (who && isOwner(this.state, who)) signers.add(who);
      }
    } else {
      if (isDeviceSig(envelope.signature)) return this.refused(no("E_ACCOUNT_BAD_ACTION", { message: "a device key signs owner actions" }), envelope, signer);
      const status = agentStatus(this.state, signer, now);
      if (status === "unknown") {
        if (isOwner(this.state, signer)) return this.refused(no("E_ACCOUNT_BAD_ACTION", { message: "an owner signs owner actions; this one is an agent's" }), envelope, signer);
        // remember the stranger so the owner can be offered the choice; its nonce is NOT spent. One that asks to be let in (agentAsk letIn) is
        // remembered under the name it gave — cleaned, and never a name that is, or looks like, the name of a key on the account that was not
        // revoked (an expired one included): letting the stranger in under it would retire that key for good
        const claimed = action.type === "agentAsk" && action.kind === "letIn" ? cleanName(action.text) : "";
        const taken = claimed !== "" && nameHolder(this.state, claimed) !== undefined;
        const name = taken ? "" : claimed;
        const known = this.state.requests.find((r) => r.address === signer);
        if (!known) this.state = { ...this.state, requests: [...this.state.requests, { address: signer as Hex, name, at: this.host.now() }].slice(-8) };
        else if (name && known.name !== name) this.state = { ...this.state, requests: this.state.requests.map((r) => (r === known ? { ...r, name } : r)) };
        const asked = taken ? `; it asked to be let in as "${claimed}", which is, or looks like, the name of an agent key on the account, so it is shown without a name` : name ? `; it asked to be let in as "${name}"` : "";
        return this.refused(no("E_ACCOUNT_UNKNOWN_SIGNER", { message: `this key is not authorised on the account: the owner lets it in under Agents${asked}`, detail: { signer, ...(name ? { asked: name } : {}) } }), envelope, signer);
      }
      if (status === "expired") return this.refused(no("E_ACCOUNT_AGENT_EXPIRED", { detail: { signer } }), envelope, signer);
      if (status === "revoked") return this.refused(no("E_ACCOUNT_AGENT_REVOKED", { detail: { signer } }), envelope, signer);
      agent = this.state.agents.find((k) => k.address === signer && k.revokedAt === undefined)!;
    }

    // The same instruction again: the first answer, and nothing runs twice. An owner's instruction is ONE instruction whoever of the owners
    // signed first (two signatures changing places are not a new one); an agent's is its own. Answers older than the nonce window are let go
    const key = isOwnerAction(action) ? `owner:${hash}` : `${signer}:${hash}`;
    for (const [k, kept] of this.results) if (now - kept.at > RESULTS_KEPT_MS) this.results.delete(k);
    const seen = this.results.get(key);
    if (seen) return seen.out;
    if (this.taken.has(key)) return this.refused(no("E_ACCOUNT_NONCE", { message: "an earlier run of this account already took this instruction: it is not taken twice", detail: { nonce: action.nonce, verdict: "used" } }), envelope, signer);
    if (signers.size < this.state.threshold && isOwnerAction(action)) return this.refused(no("E_ACCOUNT_THRESHOLD", { message: `this account needs ${this.state.threshold} signers; ${signers.size} signed`, detail: { threshold: this.state.threshold, signed: [...signers] } }), envelope, signer);

    for (const who of signers) {
      const verdict = this.nonces.check(who, action.nonce, now);
      if (verdict !== "ok") return this.refused(no("E_ACCOUNT_NONCE", { message: verdict === "used" ? "this nonce was used before" : verdict === "below-floor" ? "this nonce is below the signer's floor" : verdict === "too-old" ? "this nonce is more than two days old" : "this nonce is more than a day ahead", detail: { nonce: action.nonce, verdict } }), envelope, signer);
    }
    // a money instruction is good for ten minutes around the moment it is dated: not later, and not dated ahead to be kept for later
    if (MONEY_TYPES.has(action.type) && Math.abs(now - action.nonce) > MONEY_TTL_MS) return this.refused(no("E_ACCOUNT_EXPIRED", { message: now > action.nonce ? `signed ${Math.round((now - action.nonce) / 60_000)} min ago: a money instruction is good for ${MONEY_TTL_MS / 60_000} minutes` : `dated ${Math.round((action.nonce - now) / 60_000)} min ahead: a money instruction is good for ${MONEY_TTL_MS / 60_000} minutes around its date`, detail: { signedAt: new Date(action.nonce).toISOString() } }), envelope, signer);
    for (const who of signers) this.nonces.use(who, action.nonce);
    // taken, on the record before anything runs: a later run of the account reads this row and does not take the same instruction again,
    // whatever became of it (a money instruction is good for ten minutes, and a restart can come inside them)
    this.host.log({ kind: "action", venue: "*", tool: action.type, signer, envelope, outcome: "taken", reason: `${action.type} taken: it is not taken again, by this run of the account or a later one`, ...(agent ? { agent: slug(agent.name) } : {}) });

    // an order or a cancel is not kept waiting while the account asks other venues how their orders stand
    await this.settle(["liveCancel", "agentLiveCancel", "liveOrder", "agentLiveOrder"].includes(action.type));
    const out = await this.run(action, envelope, signer, agent, hash);
    this.results.set(key, { at: now, out });
    if (!isRefusal(out) && isOwnerAction(action)) this.answered(action, envelope);
    if (isRefusal(out)) this.host.log({ kind: "account-refusal", venue: out.venue ?? "*", tool: action.type, code: out.code, reason: out.message, detail: out.detail, native: out.native, signer, envelope, ...(agent ? { agent: slug(agent.name) } : {}) });
    return out;
  }

  /** a refusal BEFORE the signer was accepted: it is logged, the nonce is untouched, and it is not remembered (a stranger must not be able to fill the result table) */
  private refused(r: Refusal, envelope: Envelope | undefined, signer?: string): Refusal {
    this.host.log({ kind: "account-refusal", venue: "*", tool: String((envelope?.action as { type?: unknown } | undefined)?.type ?? "?"), code: r.code, reason: r.message, detail: r.detail, ...(signer ? { signer } : {}) });
    return r;
  }

  private async run(action: Action, envelope: Envelope, signer: string, agent: AgentKey | undefined, hash: Hex): Promise<Outcome> {
    const now = this.nowMs();
    if (this.host.real && ((SIMULATED_ONLY.has(action.type) && !(REAL_PAYS.has(action.type) && this.paysReal())) || (action.type === "approveSpend" && action.scope === "payees" && micro(action.budget) > 0 && !this.paysReal()))) return realOnly(action.type === "approveSpend" ? "approveSpend · payees" : action.type);
    switch (action.type) {
      case "approveAgent":
      case "approveBuilderFee":
      case "approveSpend":
      case "createSubAccount":
      case "userSetAbstraction":
      case "convertToMultiSigUser":
      case "setDestination":
      case "setWatch":
      case "setIntent": {
        // "every venue" is the venues on the account when the owner signs: one plugged in later is not covered until it is named
        const here = action.type === "approveSpend" ? [...this.host.accounts().map((a) => a.id), ...this.state.subAccounts.map((x) => `sub:${x.name}`)] : [];
        const next = applyOwner(this.state, action, envelope, now, here, this.applyOptions());
        if (isRefusal(next)) return next;
        this.state = next;
        const summary = this.summary(action);
        // a limit over "every venue" is written out as the venues there were: the row keeps that list, so a restart rebuilds the same limit
        const made = action.type === "approveSpend" ? next.spends.find((x) => x.envelope === envelope) : undefined;
        this.host.log({ kind: "action", venue: "*", tool: action.type, signer, envelope, outcome: "ok", reason: summary, ...(made ? { native: { allow: made.allow } } : {}) });
        // an agent wallet the owner just made: shown on the account, read from the chains, a place of the user's money can be sent to
        if (action.type === "createSubAccount" && this.host.real) {
          const sub = next.subAccounts.find((x) => x.name === action.name.trim());
          if (sub) await this.host.agentWalletUp?.(sub);
        }
        return { ok: true, kind: "account", summary };
      }
      case "setPolicy": {
        // a session's deposit is the owner's: the owner can end the session whether or not the agent that opened it still can
        const r = action.change === "close-session" ? ((await this.payer?.closeByOwner(action.value)) ?? no("E_PAYEE_UNSUPPORTED", { message: "this account has no payment protocol mounted" })) : await this.host.widen(action.change, action.value);
        if (isRefusal(r)) return r;
        this.host.log({ kind: "action", venue: "*", tool: action.type, signer, envelope, outcome: "ok", reason: r.summary });
        return !("data" in r) || r.data === undefined ? { ok: true, kind: "account", summary: r.summary } : { ok: true, kind: "result", result: r.data };
      }
      case "connectVenue":
      case "disconnectVenue": {
        // a venue with money on its way to it or from it stays plugged in until that has landed; an order still open there keeps it
        // plugged in too — disconnected, the account could neither follow the order nor cancel it. Both hold only while the venue IS
        // connected: one that did not come back after a restart is connected again so that its open order can be followed, or canceled
        const connected = this.host.adapter(action.venue) !== undefined;
        const busy = connected ? this.payments.find((p) => (p.status === "pending" || (p.status === "authorized" && p.live)) && (p.from === action.venue || p.to === action.venue)) : undefined;
        if (busy) return no("E_ACCOUNT_BAD_ACTION", { venue: action.venue, message: `${this.name(action.venue)} has a payment in flight (${busy.id}): it can be ${action.type === "connectVenue" ? "connected live" : "unplugged"} when that has landed`, detail: { payment: busy.id } });
        const open = connected ? this.trade.openAt(action.venue) : undefined;
        if (open) return no("E_ACCOUNT_BAD_ACTION", { venue: action.venue, message: `${this.name(action.venue)} has an open order (${open.id}): cancel it, or let it fill, before ${action.type === "connectVenue" ? "connecting it again" : "disconnecting it"}`, detail: { order: open.id } });
        const r = action.type === "connectVenue" ? await this.host.connect(action.venue, action.connector, action.label, action.credentialRef) : this.host.disconnect(action.venue);
        if (isRefusal(r)) return r;
        this.host.log({ kind: "action", venue: action.venue, tool: action.type, signer, envelope, outcome: "ok", reason: r.summary, ...("native" in r && r.native !== undefined ? { native: r.native } : {}) });
        return { ok: true, kind: "account", summary: r.summary };
      }
      case "approveCard":
        return this.answerCard(action, envelope, signer);
      case "answerAsk":
        return this.decline(action, envelope, signer);
      case "liveMove":
        return this.live.owner(action, { signer, envelope, hash });
      case "agentLiveMove":
        return this.live.agent(action, { signer, envelope, hash, agent: agent! });
      case "liveOrder":
        return this.trade.owner(action, { signer, envelope, hash });
      case "liveCancel":
        return this.trade.cancel(action, { signer, authority: "owner", envelope });
      case "agentLiveOrder":
        return this.trade.agent(action, { signer, envelope, hash, agent: agent! });
      case "agentLiveCancel":
        return this.trade.cancel(action, { signer, authority: "agent", agent: agent!, envelope });
      case "liveAmend":
        return this.trade.amend(action, { signer, authority: "owner", envelope, hash });
      case "agentLiveAmend":
        return this.trade.amend(action, { signer, authority: "agent", agent: agent!, envelope, hash });
      case "liveClose":
        return this.trade.close(action, { signer, authority: "owner", envelope, hash });
      case "agentLiveClose":
        return this.trade.close(action, { signer, authority: "agent", agent: agent!, envelope, hash });
      case "liveLeverage":
        return this.trade.leverage(action, { signer, authority: "owner", envelope });
      case "agentLiveLeverage":
        return this.trade.leverage(action, { signer, authority: "agent", envelope, agent: agent!, hash });
      case "liveEarn":
        return this.earn.owner(action, { signer, envelope, hash });
      case "agentLiveEarn":
        return this.earn.agent(action, { signer, envelope, hash, agent: agent! });
      case "sendAsset":
        return this.move(action, { signer, authority: "owner", envelope, hash });
      case "swap":
        return this.swap(action.venue, action.sell, action.buy, action.amount, action.minReceive, { signer, authority: "owner", envelope, hash });
      case "agentSendAsset":
        return this.move(action, { signer, authority: "agent", agent: agent!, envelope, hash });
      case "agentSwap":
        return this.swap(action.venue, action.sell, action.buy, action.amount, action.minReceive, { signer, authority: "agent", agent: agent!, envelope, hash });
      case "agentPay":
        if (!this.payer) return no("E_PAYEE_UNSUPPORTED", { message: "this account has no payment protocol mounted" });
        return this.payer.pay(action, { signer, agent: agent!, envelope, hash });
      case "agentExecute": {
        const kind = String((action.intent as { kind?: unknown }).kind);
        if (kind === "move" || kind === "pay") return no("E_ACCOUNT_BAD_ACTION", { message: `money leaves through agentSendAsset (between the user's own venues) or agentPay, not through "${kind}"`, detail: { kind } });
        // the intent is free JSON under the signature: it is this parse that says it is one (a positive, finite amount of a known thing)
        const intent = parseIntent(action.intent);
        if (!intent || typeof action.account !== "string") return no("E_ACCOUNT_BAD_ACTION", { message: "not an intent: trade {symbol, side, qty} · subscribe / redeem {fund, amountUsd}, each more than zero" });
        this.host.log({ kind: "action", venue: action.account, tool: action.type, signer, envelope, outcome: "handed on", reason: `${agent!.name} · ${intent.kind} at ${this.name(action.account)}`, agent: slug(agent!.name) });
        return { ok: true, kind: "result", result: await this.host.execute(action.account, intent, agentIdOf(agent!), signer) };
      }
      case "agentReport":
        return this.report(action, envelope, signer, agent!);
      case "agentAsk":
        return this.ask(action, agent!);
      case "agentOrder": {
        const order = parseOrder({ base: action.base, side: action.side, qty: action.qty });
        if (!order) return no("E_ACCOUNT_BAD_ACTION", { message: "not an order: {base: an asset or an event contract, side: buy | sell, qty: more than zero}" });
        this.host.log({ kind: "action", venue: "*", tool: action.type, signer, envelope, outcome: "handed on", reason: `${agent!.name} · ${order.side} ${order.qty} ${order.base}`, agent: slug(agent!.name) });
        return { ok: true, kind: "result", result: await this.host.order(order.base, order.side, order.qty, agentIdOf(agent!), signer) };
      }
    }
  }

  private summary(a: OwnerAction): string {
    switch (a.type) {
      case "approveAgent":
        return a.agentAddress.toLowerCase() === "0x0000000000000000000000000000000000000000" ? `agent key "${a.agentName}" revoked` : `agent key "${a.agentName}" authorised until ${etDate(a.validUntil)}`;
      case "approveBuilderFee":
        return a.maxFeeRate.trim() === "0" ? `fee approval for ${a.builder.slice(0, 10)}… removed` : `${a.builder.slice(0, 10)}… may charge up to ${a.maxFeeRate}`;
      case "approveSpend": {
        // what the limit is for, when the owner tied it to an intent; and how often, when the owner set a window
        const answers = a.intent?.trim() ? ` · for ${a.intent.trim()}` : "";
        const window = (what: string) => (a.windowHours > 0 ? ` · one ${what} every ${a.windowHours} h at each ${a.scope === "payees" ? "payee" : "venue"}` : "");
        if (a.scope === "trade") return micro(a.budget) === 0 ? "trading limit revoked" : `trading limit: ${a.allow.trim() === "*" ? "every venue on the account now" : a.allow} · up to $${a.perPayment} an order · $${a.budget} of orders in all (a close that sells a holding counts like an order; a derivative position closed reduce-only does not)${window("order")} · until ${etDate(a.validUntil)}${answers}`;
        if (a.scope === "earn") return micro(a.budget) === 0 ? "earn limit revoked" : `earn limit: ${a.allow.trim() === "*" ? "every venue on the account now" : a.allow} · up to $${a.perPayment} put in at a time · $${a.budget} in all${window("supply")} · until ${etDate(a.validUntil)}${answers}`;
        return micro(a.budget) === 0 ? `spending approval (${a.scope}) revoked` : `spending approval: ${a.scope} ${a.allow.trim() === "*" ? (a.scope === "venues" ? "every venue on the account now" : "every payee") : a.allow} · up to $${a.perPayment} a payment · $${a.budget} in all${window("payment")} · until ${etDate(a.validUntil)}${answers}`;
      }
      case "createSubAccount":
        return `sub-account "${a.name}" created with a float of up to $${a.float}`;
      case "userSetAbstraction":
        return `account type → ${a.abstraction === "unifiedAccount" ? "Unified" : "Separate"}`;
      case "convertToMultiSigUser":
        return `signers changed: ${(JSON.parse(a.signers) as { threshold: number; authorizedUsers: string[] }).threshold} of ${(JSON.parse(a.signers) as { authorizedUsers: string[] }).authorizedUsers.length}`;
      case "setDestination":
        return a.address === "" ? `destination "${a.label}" removed` : `destination "${a.label}" added on ${a.chain}: usable in 24 hours`;
      case "setWatch":
        return a.on === "true" ? `watching ${a.symbol.trim()} at ${a.venue.trim()}` : `no longer watching ${a.symbol.trim()} at ${a.venue.trim()}`;
      case "setIntent": {
        if (a.validUntil === 0) return `intent ${a.id} withdrawn`;
        const it = this.state.intents.find((x) => x.envelope.action === a);
        return `intent ${it?.id ?? a.id} for ${a.agent === "*" ? "every agent" : this.agentName(a.agent)}: "${a.text.trim()}" · until ${etDate(a.validUntil)}`;
      }
      default:
        return a.type;
    }
  }

  // ---- steering: the owner's words, the agents' answers ----------------------------------

  /** an agent key's name on the account, or its address when the account has no name for it */
  agentName(address: string): string {
    const a = address.toLowerCase();
    return this.state.agents.find((k) => k.address === a && k.revokedAt === undefined)?.name ?? this.state.agents.find((k) => k.address === a)?.name ?? address;
  }

  /** An agent's report on an intent addressed to it (or to every agent): its latest word on the intent, and a row on the ledger that a restart
   * folds again. A ref that names an order or a payment the account holds names one this key made: the owner reads a report's refs as what
   * the agent did, so another's (the owner's, another agent's) is refused. It changes nothing else */
  private report(a: Extract<AgentAction, { type: "agentReport" }>, envelope: Envelope, signer: string, agent: AgentKey): Outcome {
    const theirs = refsOf(a.refs).find((ref) => {
      const made = this.orders.find((o) => o.id === ref) ?? this.payments.find((p) => p.id === ref);
      return made !== undefined && made.agent !== agent.address;
    });
    if (theirs) return no("E_ACCOUNT_BAD_ACTION", { message: `${theirs} is not an order or a payment this agent made: a report's refs name its own`, detail: { ref: theirs } });
    const next = applyReport(this.state, a, signer, this.nowMs());
    if (isRefusal(next)) return next;
    this.state = next;
    const it = next.intents.find((x) => x.id === a.intent)!;
    const report = it.byAgent.find((r) => r.by === agent.address) as AgentReport;
    this.host.log({ kind: "action", venue: it.venue || "*", tool: a.type, signer, envelope, outcome: "ok", reason: `${agent.name} on ${it.id}: ${report.status}${report.note ? ` · ${report.note}` : ""}`, agent: slug(agent.name) });
    return { ok: true, kind: "result", result: { intent: it.id, report, reports: it.reports } };
  }

  /** the asks still waiting: a day old at most, and from keys that have not been revoked */
  private waitingAsks(nowMs: number): AgentAsk[] {
    this.asks = this.asks.filter((x) => nowMs < Date.parse(x.expiresAt) && agentStatus(this.state, x.agent, nowMs) !== "revoked");
    return this.asks;
  }

  /** An agent asks the owner for something only the owner signs. Kept in memory for a day, one ask per agent, kind and venue (asking again
   * replaces it, under a new id), a few at a time per agent so that one cannot crowd out the others, and five an hour per key. It grants nothing */
  private ask(a: Extract<AgentAction, { type: "agentAsk" }>, agent: AgentKey): Outcome {
    const now = this.nowMs();
    const wrong = askProblem(a);
    if (wrong) return no("E_ACCOUNT_BAD_ACTION", { message: wrong });
    // a venue the owner could not connect from here at all (it refuses this network, or offers no way in) is not asked of the owner: the
    // agent is told why, in the venue's own words. One whose own terms exclude where the user is is asked: the owner sees its terms in the
    // form and decides — shown, never enforced, as the venue's own sign-up checks residency
    if (a.kind === "venue" && a.venue) {
      const v = this.host.venueVerdict?.(a.venue);
      if (v && (v.verdict === "not-served" || v.verdict === "closed")) {
        const why = v.verdict === "closed" ? "E_ACCOUNT_BAD_ACTION" : "E_VENUE_GEOBLOCKED";
        return no(why, { venue: a.venue, message: `the owner is not asked: ${v.name} ${v.verdict === "not-served" ? "does not serve the network this account runs on" : "offers no way in for this account"}${v.said ? ` — ${v.said}` : ""}. portfolio_venues lists where the user can connect` });
      }
    }
    const waiting = this.waitingAsks(now);
    const times = (this.askTimes.get(agent.address) ?? []).filter((t) => now - t < 3_600_000);
    if (times.length >= ASKS_PER_HOUR) return no("E_ACCOUNT_LIMIT", { message: `at most ${ASKS_PER_HOUR} asks an hour from one agent key: the owner sees the ones already waiting`, detail: { perHour: ASKS_PER_HOUR, waiting: waiting.filter((x) => x.agent === agent.address).map((x) => x.id) } });
    const same = waiting.find((x) => x.agent === agent.address && x.kind === a.kind && x.venue === a.venue);
    if (!same && waiting.filter((x) => x.agent === agent.address).length >= ASKS_PER_AGENT) return no("E_ACCOUNT_LIMIT", { message: `${agent.name} has ${ASKS_PER_AGENT} asks waiting for the owner already: one is answered, or lapses, first`, detail: { perAgent: ASKS_PER_AGENT } });
    if (!same && waiting.length >= MAX_ASKS) return no("E_ACCOUNT_LIMIT", { message: `${MAX_ASKS} asks are waiting for the owner already`, detail: { max: MAX_ASKS } });
    this.askTimes.set(agent.address, [...times, now]);
    // asked again: new words, so a new id — an answer the owner signed for the old words is not taken for these
    const entry: AgentAsk = { id: `ask-${String(++this.askSeq).padStart(4, "0")}`, agent: agent.address, agentName: agent.name, kind: a.kind as AskKind, venue: a.venue, usd: a.usd, text: a.text.trim(), at: new Date(now).toISOString(), expiresAt: new Date(now + ASK_TTL_MS).toISOString() };
    this.asks = same ? waiting.map((x) => (x === same ? entry : x)) : [...waiting, entry];
    if (same) {
      this.askReplaced.set(same.id, entry.id);
      // a bounded memory, oldest out first: a day's askings again at most, and one older than a day has nothing waiting behind it
      if (this.askReplaced.size > MAX_ASKS * 24) this.askReplaced.delete(this.askReplaced.keys().next().value!);
    }
    this.host.log({ kind: "action", venue: a.venue || "*", tool: a.type, signer: agent.address, outcome: "asked", reason: `${agent.name} asks the owner: ${a.kind}${a.venue ? ` at ${a.venue}` : ""}${a.usd ? ` · $${a.usd}` : ""}${entry.text ? ` · ${entry.text}` : ""}`, agent: slug(agent.name) });
    return { ok: true, kind: "result", result: { ask: entry, replaced: !!same } };
  }

  /** The owner declines an ask: it is closed without the thing asked for, kept a day so the agent that asked is shown it was declined, and
   * a row on the ledger says so. Only a waiting ask can be declined, and "decline" is the only answer this action gives — granting one is
   * the owner's own action for it. It changes nothing else: no limit, no venue, no key */
  private decline(a: Extract<OwnerAction, { type: "answerAsk" }>, envelope: Envelope, signer: string): Outcome {
    const now = this.nowMs();
    if (a.decision !== "decline") return no("E_ACCOUNT_BAD_ACTION", { message: 'an ask is answered here with "decline"; granting it is the owner\'s own action for what was asked (a limit, a venue connected, a top-up …), which closes it' });
    const ask = this.waitingAsks(now).find((x) => x.id === a.ask.trim());
    // the agent asked again while the owner read the old words: the decline was of those, so it is not taken for the new ones
    const instead = !ask ? this.replacementOf(a.ask.trim(), now) : undefined;
    if (instead) return no("E_ACCOUNT_BAD_ACTION", { message: `${instead.agentName} changed this ask since it was shown (it is ${instead.id} now): read it again, then answer that one`, detail: { ask: a.ask.trim().slice(0, 40), now: instead.id } });
    if (!ask) return no("E_ACCOUNT_BAD_ACTION", { message: `there is no waiting ask "${a.ask.trim().slice(0, 40)}": it was answered, it lapsed, or the account restarted since`, detail: { ask: a.ask.trim().slice(0, 40) } });
    this.asks = this.asks.filter((x) => x !== ask);
    this.declined = [...this.declinedAsks(now).filter((x) => x.id !== ask.id), { ...ask, declinedAt: new Date(now).toISOString() }].slice(-MAX_ASKS * 2);
    const summary = `declined ${ask.agentName}'s ask: ${ask.kind}${ask.venue ? ` at ${ask.venue}` : ""}${ask.usd ? ` · $${ask.usd}` : ""}`;
    this.host.log({ kind: "action", venue: ask.venue || "*", tool: a.type, signer, envelope, outcome: "ok", reason: summary, agent: slug(ask.agentName), native: { ask: ask.id, kind: ask.kind, agent: ask.agent } });
    return { ok: true, kind: "account", summary };
  }

  /** the waiting ask that took the place of an ask the agent asked again (over as many askings again as there were) */
  private replacementOf(id: string, nowMs: number): AgentAsk | undefined {
    let next = this.askReplaced.get(id);
    for (let hops = 0; next && hops < 64; hops++) {
      const waiting = this.waitingAsks(nowMs).find((x) => x.id === next);
      if (waiting) return waiting;
      next = this.askReplaced.get(next);
    }
    return undefined;
  }

  /** the asks the owner declined in the last day */
  private declinedAsks(nowMs: number): DeclinedAsk[] {
    this.declined = this.declined.filter((x) => nowMs - Date.parse(x.declinedAt) < DECLINED_SHOWN_MS);
    return this.declined;
  }

  /** The owner's signed action that answers what agents asked closes those asks: a key let in (letIn), a limit (limit), an agent wallet made
   * or topped up (topup), a venue connected (venue), a new session, a leverage cap, a mode. Run only after the action went through. An ask
   * that names a venue is answered by an action about that venue; one that names none, by any */
  private answered(a: OwnerAction, envelope: Envelope): void {
    const close = (kind: AskKind, agent?: string, venues?: string[]) => {
      this.asks = this.asks.filter((x) => !(x.kind === kind && (agent === undefined || x.agent === agent) && (venues === undefined || x.venue === "" || venues.includes(x.venue))));
    };
    if (a.type === "approveAgent") close("letIn", a.agentAddress.toLowerCase());
    else if (a.type === "approveSpend") {
      // a revoke grants nothing, so it answers no ask; a limit answers the asks for one at the venues it covers ("every venue" as it was written out)
      if (micro(a.budget) === 0) return;
      const made = this.state.spends.find((x) => x.envelope === envelope);
      close("limit", a.agent.toLowerCase(), made?.allow ?? a.allow.split(",").map((x) => x.trim()).filter(Boolean));
    } else if (a.type === "createSubAccount") close("topup", a.agent.toLowerCase());
    else if (a.type === "connectVenue") close("venue", undefined, [a.venue]);
    else if (a.type === "setPolicy" && (a.change === "session" || a.change === "maxLeverage" || a.change === "mode")) close(a.change === "maxLeverage" ? "leverage" : a.change);
    else if (a.type === "liveMove") {
      // a top-up: real money moved into an agent's wallet
      const sub = this.state.subAccounts.find((x) => agentWalletVenue(x.name) === a.to);
      if (sub) close("topup", sub.agent);
    }
  }

  // ---- movements ----------------------------------------------------------------------

  /** the sub-account a `sub:<name>` ledger names */
  sub(name: string): SubAccount | undefined {
    return this.state.subAccounts.find((s) => s.name === name || s.id === name);
  }

  /** plan a movement the way the door would run it; also what the page shows before anything is signed */
  async quote(req: RouteRequest): Promise<Route | Refusal> {
    return plan(req, await this.host.views(), this.nowMs());
  }

  /** Where an instruction would go and through what, with the checks on the destination that do not depend on who signed: a third party has to be
   * in the address book, on the chain it was added for, past its day of cooling and not on the blocklist; a float has room; a source is named or,
   * for an agent on a Unified account, picked. The page asks this before the owner signs, and the door asks it again when the instruction arrives. */
  async resolve(action: Pick<SendAsset, "destination" | "sourceDex" | "destinationDex" | "token" | "amount">, authority: Authority, spend?: SpendApproval): Promise<Resolved | Refusal> {
    const now = this.nowMs();
    const amountMicro = micro(action.amount);
    if (Number.isNaN(amountMicro) || !(amountMicro > 0)) return no("E_ACCOUNT_BAD_ACTION", { message: "the amount is a plain decimal, more than zero" });
    if (!STABLE.has(action.token)) return no("E_ACCOUNT_UNPRICED", { message: `the account moves dollars and dollar stablecoins; "${action.token}" has no price here, so no limit can be judged`, detail: { token: action.token } });
    const usd = amountMicro / 1e6;
    const src = dex(action.sourceDex);
    const dst = dex(action.destinationDex);
    const home = action.destination === "self";
    const views = await this.host.views();

    // someone else: only the owner, only an address in the book, on the chain it was added for, after its day of cooling
    let external: Payment["external"];
    if (!home) {
      if (authority === "agent") return no("E_ACCOUNT_NOT_HOME", { detail: { destination: action.destination } });
      if (this.host.policy().blocklist.some((x) => x.toLowerCase() === action.destination.toLowerCase())) return no("E_WALLET_BLOCKLIST", { message: `${action.destination} is on the blocklist`, detail: { destination: action.destination } });
      const same = this.state.destinations.filter((d) => d.address === action.destination.toLowerCase());
      const entry = same.find((d) => d.chain === action.destinationDex);
      if (!entry) return no("E_ACCOUNT_DESTINATION", { message: same.length ? `that address is in the address book on ${same.map((d) => d.chain).join(", ")}, not on ${action.destinationDex}: a destination is an address on a chain` : "that address is not in the address book: the owner adds it first, and it can be used a day later", detail: { destination: action.destination, chain: action.destinationDex, knownOn: same.map((d) => d.chain) } });
      if (entry.token !== action.token) return no("E_ACCOUNT_DESTINATION", { message: `"${entry.label}" was added for ${entry.token}, not ${action.token}`, detail: { label: entry.label, token: entry.token } });
      if (now < Date.parse(entry.usableAt)) return no("E_ACCOUNT_DEST_COOLING", { message: `"${entry.label}" was added ${Math.round((now - Date.parse(entry.addedAt)) / 3_600_000)} h ago: it can be used from ${etDate(Date.parse(entry.usableAt))}`, detail: { label: entry.label, usableAt: entry.usableAt } });
      external = { label: entry.label, address: entry.address, chain: entry.chain };
    }

    // a float: money from the wallet into an agent's sub-account
    const float = home && dst.venue === "sub" ? this.sub(dst.ledger ?? "") : undefined;
    if (home && dst.venue === "sub" && !float) return no("E_WALLET_ACCOUNT_UNKNOWN", { message: `there is no sub-account "${dst.ledger ?? ""}"` });
    const target = float ? `sub:${float.name}` : home ? dst.venue : (external?.label ?? action.destination);

    let route: Route | Refusal;
    if (src.venue === "sub") {
      // a float going home: the account holds its key, and only the owner says when it comes back (an agent whose key was revoked leaves its float here)
      const from = this.sub(src.ledger ?? "");
      if (!from) return no("E_WALLET_ACCOUNT_UNKNOWN", { message: `there is no sub-account "${src.ledger ?? ""}"` });
      if (authority === "agent") return no("E_ACCOUNT_OWNER_ONLY", { message: "a float goes back to the wallet on the owner's signature" });
      if (!home || dst.venue !== HUB) return no("E_ACCOUNT_SOURCE", { message: "a float goes back to the on-chain wallet it was filled from" });
      if (amountMicro > from.balanceMicro) return no("E_WALLET_INSUFFICIENT", { message: `the float "${from.name}" holds ${money(from.balanceMicro / 1e6)}`, detail: { subAccount: from.name, balance: from.balanceMicro / 1e6 } });
      const leg: Leg = { step: "in", venue: HUB, rail: "receive", protocol: "on-chain transfer from the float, signed with the key the account holds", token: "USDC", chain: "Base", feeUsd: 0.01, etaSec: 15, access: "owner", final: true };
      route = { from: `sub:${from.name}`, to: HUB, sourceToken: "USDC", token: "USDC", amountUsd: usd, legs: [leg], feeUsd: leg.feeUsd, receiveUsd: r2(usd - leg.feeUsd), arrivalMs: now + leg.etaSec * 1000, access: "owner", hash: keccak256(stringToHex(canonical({ sweep: from.name, legs: [[leg.step, leg.venue, leg.chain]] }))) };
      return { route, target: HUB, usd, amountMicro, home };
    }
    if (src.venue === "") {
      // no source named: only an agent on a Unified account may leave the choice to the account, and only among the venues its approval names
      if (authority !== "agent" || !spend) return no("E_ACCOUNT_SOURCE", { message: "name where the money comes from" });
      if (this.state.abstraction !== "unifiedAccount") return no("E_ACCOUNT_SOURCE", { message: "no source was named, and this account is Separate: name one, or the owner turns on Unified so the account may pick", detail: { abstraction: this.state.abstraction } });
      route = this.pickSource(views, target, float ? HUB : dst.venue, usd, spend, now);
    } else if (float && src.venue !== HUB) {
      return no("E_ACCOUNT_SOURCE", { message: "a float is filled from the on-chain wallet: move the money there first", detail: { source: src.venue } });
    } else if (float) {
      route = this.floatRoute(views, usd, now);
    } else {
      const inside = src.venue === dst.venue && home;
      route = plan({ from: src.venue, to: target, amountUsd: usd, ...(home && action.token !== "USD" ? { token: action.token } : {}), ...(inside && src.ledger ? { fromLedger: src.ledger } : {}), ...(inside && dst.ledger ? { toLedger: dst.ledger } : {}), ...(external ? { external: { address: external.address, chain: external.chain } } : {}) }, views, now);
    }
    if (isRefusal(route)) return route;
    // what is already on its way to the float counts towards its cap: refills launched together must not add up past it
    const coming = float ? Math.round(this.payments.filter((p) => p.status === "pending" && p.to === `sub:${float.name}`).reduce((x, p) => x + p.receiveUsd, 0) * 1e6) : 0;
    if (float && float.balanceMicro + coming + amountMicro > float.capMicro) return no("E_WALLET_FLOAT_CAP", { message: `"${float.name}" may hold ${money(float.capMicro / 1e6)}; it holds ${money(float.balanceMicro / 1e6)}${coming ? `, ${money(coming / 1e6)} is on its way to it,` : ""} and ${money(usd)} more would pass that`, detail: { cap: float.capMicro / 1e6, balance: float.balanceMicro / 1e6, coming: coming / 1e6, amount: usd } });
    return { route, target, usd, amountMicro, home, ...(external ? { external } : {}), ...(float ? { float } : {}) };
  }

  private async move(action: SendAsset | Extract<AgentAction, { type: "agentSendAsset" }>, who: { signer: string; authority: Authority; agent?: AgentKey; envelope: Envelope; hash: Hex }, released?: CardLike): Promise<Outcome> {
    const now = this.nowMs();
    let spend: SpendApproval | undefined;
    if (who.authority === "agent") {
      const s = spendFor(this.state, who.signer, "venues", now);
      if (isRefusal(s)) return s;
      if (!(await this.stillSigned(s))) return no("E_ACCOUNT_BAD_SIGNATURE", { message: "the spending approval's own signature no longer checks out against the account's owners", detail: { approval: s.id } });
      spend = s;
    }
    const resolved = await this.resolve(action, who.authority, spend);
    if (isRefusal(resolved)) return resolved;
    const { route, target, usd, amountMicro, home, external, float } = resolved;

    // whose leg is the strictest one on the way
    const b = route.blocker;
    if (route.access === "closed") return no("E_VENUE_RAIL_CLOSED", { venue: b?.venue ?? route.from, message: `${this.name(b?.venue ?? route.from)}: ${b?.why ?? "this runway is closed"}`, detail: { step: b?.step, ...(b?.opens ? { opens: b.opens } : {}) } });
    if (route.access === "venue") return no("E_VENUE_RAIL_CLOSED", { venue: b!.venue, message: `${this.name(b!.venue)}: ${b!.why}${who.authority === "agent" ? "" : "; do that leg there, then move it on from the wallet"}`, detail: { step: b!.step, ...(b!.opens ? { opens: b!.opens } : {}) } });
    if (route.access === "owner" && who.authority === "agent") return no("E_ACCOUNT_OWNER_ONLY", { venue: b!.venue, message: `${this.name(b!.venue)}: ${b!.why}`, detail: { step: b!.step } });

    const maxFee = micro(action.maxFee);
    if (Number.isNaN(maxFee) || route.feeUsd * 1e6 > maxFee) return no("E_ACCOUNT_REQUOTE", { message: `the route costs ${money(route.feeUsd)}, more than the ${money((maxFee || 0) / 1e6)} that was agreed`, detail: { feeUsd: route.feeUsd, maxFee: action.maxFee, route: route.hash } });
    if (action.type === "sendAsset") {
      if (action.route !== route.hash) return no("E_ACCOUNT_REQUOTE", { message: "the route is not the one that was signed", detail: { signed: action.route, now: route.hash, legs: route.legs.map((l) => `${l.step}:${l.venue}`) } });
      if (route.arrivalMs > action.deadline) return no("E_ACCOUNT_REQUOTE", { message: `it would land ${whenLabel(now, route.arrivalMs)}, later than the ${etDate(action.deadline)} that was agreed`, detail: { arrival: new Date(route.arrivalMs).toISOString(), deadline: new Date(action.deadline).toISOString() } });
    }

    let flight: FlightLike | undefined;
    let cardId: string | undefined;
    if (who.authority === "agent") {
      const a = who.agent!;
      // the account picked the source for the card that is now released: if it would pick another today, that is not what the owner saw
      if (released && released.account !== route.from) return no("E_ACCOUNT_REQUOTE", { message: `the card was for money from ${this.name(released.account)}; the account would now take it from ${this.name(route.from)}: it is asked again`, detail: { card: released.id } });
      // both ends have to be in the approval: an agent moves money only along routes the owner drew. (A card that is being released gave its
      // share of the budget back before this ran, so it is judged like any other — every limit, not only the one that first said no.)
      const judged = covers(spend!, target, amountMicro, now) ?? (spend!.allow.includes("*") || spend!.allow.includes(route.from) ? null : no("E_MANDATE_RECIPIENT", { message: `"${route.from}" is not in the spending approval (${spend!.allow.join(", ")}): it cannot be a source`, detail: { approval: spend!.id, allow: spend!.allow, source: route.from } }));
      if (judged) return judged;
      const source = this.host.adapter(route.from)!.account;
      const policy = this.host.policy();
      const v = evaluate({ intent: { kind: "move", asset: route.sourceToken, amount: usd, to: target }, account: { ...source, scope: { ...source.scope, can: [...new Set([...source.scope.can, "move" as const])] } }, openness: { ...policy, knownDestinations: [...policy.knownDestinations, target] }, now: this.host.now(), dailyOutUsd: this.host.dailyOutUsd(this.host.now()) });
      if (isRefusal(v)) return v;
      flight = released ? { no: released.flight } : this.host.openFlight(agentIdOf(a), `${float ? "Refill" : "Transfer"} ${money(usd)} · ${this.name(route.from)} → ${float ? `float "${float.name}"` : this.name(route.to)}`);
      if (!released) this.host.say(flight.no, routeWords(route, (id) => this.name(id), now));
      if (v.card && !released) {
        const card = this.host.raiseCard(flight.no, { account: route.from, intent: { kind: "move", asset: route.sourceToken, amount: usd, to: target }, usd, reason: v.card.reason, why: v.card.why, action: action as AgentAction, actionHash: who.hash, signer: who.signer, expiresAt: new Date(now + CARD_TTL_MS).toISOString(), approval: spend!.id });
        // the card holds its share of the budget while it waits, so several waiting cards cannot each fit and together overrun
        this.patchSpend(spend!.id, (x) => ({ ...x, reservedMicro: x.reservedMicro + amountMicro }));
        this.host.log({ kind: "action", venue: route.from, tool: action.type, signer: who.signer, envelope: who.envelope, outcome: "card", notionalUsd: usd, reason: v.card.reason, flight: flight.no, agent: slug(a.name), intentId: card.id });
        return { ok: true, kind: "card", pending: true, card, flight: flight.no };
      }
      cardId = released?.id;
    }

    const kind: PaymentKind = float ? "refill" : !home ? "send" : route.from === route.to ? "transfer" : route.to === HUB ? "withdraw" : route.from === HUB ? "deposit" : "transfer";
    const p = newPayment(`pay-${String(++this.seq).padStart(4, "0")}`, kind, float ? { ...route, to: `sub:${float.name}` } : route, this.host.now(), { signer: who.signer, authority: who.authority, ...(who.agent ? { agent: who.agent.address } : {}), ...(flight ? { flight: flight.no } : {}), action: who.hash, ...(spend ? { approval: spend.id } : {}), ...(cardId ? { card: cardId } : {}), ...(external ? { external } : {}) });
    this.payments.unshift(p);
    // a float on its way home leaves the float as the payment starts
    const leaving = route.from.startsWith("sub:") ? this.sub(route.from.slice(4)) : undefined;
    if (leaving) this.state = { ...this.state, subAccounts: this.state.subAccounts.map((x) => (x.id === leaving.id ? { ...x, balanceMicro: x.balanceMicro - amountMicro } : x)) };
    if (spend) this.patchSpend(spend.id, (x) => ({ ...x, spentMicro: x.spentMicro + amountMicro, last: { ...x.last, [target]: now } }));
    this.host.log({ kind: "action", venue: route.from, tool: action.type, signer: who.signer, ...(released ? { intentId: released.id } : { envelope: who.envelope }), outcome: "accepted", notionalUsd: usd, reason: `${p.id} · ${this.name(route.from)} → ${float ? `float "${float.name}"` : external ? `${external.label} (${external.chain})` : this.name(route.to)} · ${routeWords(route, (id) => this.name(id), now)}`, payment: p.id, ...(flight ? { flight: flight.no } : {}), ...(who.agent ? { agent: slug(who.agent.name) } : {}) });
    const events = await launch(p, now, this.money());
    this.record(events);
    if (p.status === "failed") {
      // nothing left: a float that was on its way home is whole again, and the budget it would have used is free
      if (leaving) this.state = { ...this.state, subAccounts: this.state.subAccounts.map((x) => (x.id === leaving.id ? { ...x, balanceMicro: x.balanceMicro + amountMicro } : x)) };
      if (spend) this.patchSpend(spend.id, (x) => ({ ...x, spentMicro: x.spentMicro - amountMicro, last: Object.fromEntries(Object.entries(x.last).filter(([k]) => k !== target)) }));
      const r = events.find((e) => e.refusal)?.refusal;
      return r ?? no("E_VENUE_REJECTED", { venue: route.from });
    }
    return { ok: true, kind: "payment", payment: p, ...(flight ? { flight: flight.no } : {}) };
  }

  patchSpend(id: string, f: (s: SpendApproval) => SpendApproval): void {
    const before = this.state.spends.find((s) => s.id === id);
    this.state = { ...this.state, spends: this.state.spends.map((s) => (s.id === id ? f(s) : s)) };
    const after = this.state.spends.find((s) => s.id === id);
    // what a limit has USED goes on the ledger whenever it changes (not what cards hold for a moment): a restart picks up from there
    if (before && after && (before.spentMicro !== after.spentMicro || JSON.stringify(before.last) !== JSON.stringify(after.last) || JSON.stringify(before.payTo) !== JSON.stringify(after.payTo)))
      this.host.log({ kind: "spend", venue: "*", intentId: id, notionalUsd: after.spentMicro / 1e6, detail: { spentMicro: after.spentMicro, last: after.last, payTo: after.payTo } });
  }

  /** the account as a restart rebuilt it from its ledgers (account/restore.ts): its owners, agents, limits — and the ids it had reached */
  adopt(state: AccountState, ids: { order: number; payment: number; earn?: number | undefined }): void {
    this.state = state;
    this.orderSeq = Math.max(this.orderSeq, ids.order);
    this.earnSeq = Math.max(this.earnSeq, ids.earn ?? 0);
    this.seq = Math.max(this.seq, ids.payment);
  }

  /** is the approval still the owner's? Its own signed envelope is checked against the account's CURRENT owners, every time it is used */
  async stillSigned(s: SpendApproval): Promise<boolean> {
    const a = s.envelope.action;
    if (a.type !== "approveSpend" || a.agent.toLowerCase() !== s.agent || micro(a.budget) !== s.budgetMicro || micro(a.perPayment) !== s.perPaymentMicro || a.validUntil !== s.validUntil) return false;
    const signer = await signerOf(a, s.envelope.signature, deviceKeys(this.state));
    return signer !== null && isOwner(this.state, signer);
  }

  /** Unified: among the venues the approval names, the one whose money lands soonest, then for the least */
  private pickSource(views: VenueView[], target: string, to: string, usd: number, spend: SpendApproval, now: number): Route | Refusal {
    const options: Route[] = [];
    const closed: string[] = [];
    for (const v of views) {
      if (v.id === to || (!spend.allow.includes("*") && !spend.allow.includes(v.id))) continue;
      const have = v.holdings.filter((h) => !h.inTransit && (h.class === "stable" || h.class === "cash")).reduce((s, h) => s + h.usd, 0);
      if (have < usd) continue;
      const r = target.startsWith("sub:") ? (v.id === HUB ? this.floatRoute(views, usd, now) : no("E_ACCOUNT_SOURCE", {})) : plan({ from: v.id, to, amountUsd: usd }, views, now);
      if (isRefusal(r)) continue;
      if (r.access === "agent") options.push(r);
      else closed.push(`${v.name} (${r.blocker?.why ?? r.access})`);
    }
    options.sort((a, b) => a.arrivalMs - b.arrivalMs || a.feeUsd - b.feeUsd);
    return options[0] ?? no("E_ACCOUNT_SOURCE", { message: `no open source holds ${money(usd)} that could reach ${this.name(to)}${closed.length ? `; closed: ${closed.join(", ")}` : ""}`, detail: { closed } });
  }

  /** the wallet's own transfer on Base into a sub-account's address */
  private floatRoute(views: VenueView[], usd: number, now: number): Route | Refusal {
    const hub = views.find((v) => v.id === HUB);
    const rail = hub ? doorOf(hub).out[0] : undefined;
    if (!hub || !rail) return no("E_WALLET_ACCOUNT_UNKNOWN", { venue: HUB });
    const have = hub.holdings.filter((h) => h.asset === "USDC" && h.note === "Base").reduce((s, h) => s + h.amount, 0);
    if (have < usd) return no("E_VENUE_INSUFFICIENT", { venue: HUB, message: `the wallet holds ${money(have)} USDC on Base; ${money(usd)} is more than that` });
    const leg: Leg = { step: "out", venue: HUB, rail: rail.id, protocol: rail.protocol, token: "USDC", chain: "Base", feeUsd: rail.fee(usd, "Base"), etaSec: rail.etaSec, access: rail.access, final: true };
    const legs = [leg];
    return { from: HUB, to: HUB, sourceToken: "USDC", token: "USDC", amountUsd: usd, legs, feeUsd: leg.feeUsd, receiveUsd: r2(usd - leg.feeUsd), arrivalMs: now + leg.etaSec * 1000, access: leg.access, hash: keccak256(stringToHex(canonical({ float: true, legs: legs.map((l) => [l.step, l.venue, l.chain]) }))) };
  }

  private async swap(venue: string, sell: string, buy: string, amount: string, minReceive: string, who: { signer: string; authority: Authority; agent?: AgentKey; envelope: Envelope; hash: Hex }): Promise<Outcome> {
    const now = this.nowMs();
    const a = this.host.adapter(venue);
    if (!a) return no("E_WALLET_ACCOUNT_UNKNOWN", { venue });
    const amountMicro = micro(amount);
    if (Number.isNaN(amountMicro) || !(amountMicro > 0)) return no("E_ACCOUNT_BAD_ACTION", { message: "the amount is a plain decimal, more than zero" });
    if (!STABLE.has(sell) || !STABLE.has(buy)) return no("E_ACCOUNT_UNPRICED", { message: "a swap here is one dollar stablecoin for another", detail: { sell, buy } });
    const usd = amountMicro / 1e6;
    const door = doorOf(a.account);
    const sw = door.swap.find((s) => s.pair.includes(sell) && s.pair.includes(buy) && sell !== buy);
    if (!sw) return no("E_VENUE_CURRENCY", { venue, message: `${a.account.name} does not swap ${sell} for ${buy}`, detail: { swaps: door.swap.map((s) => s.pair.join("/")) } });
    if (sw.access === "closed") return no("E_VENUE_RAIL_CLOSED", { venue, message: `${a.account.name}: ${door.watchOnly ? whyWatchOnly : door.restricted ? "the venue does not serve this region" : "this key cannot trade here"}` });
    if (who.authority === "agent" && sw.access !== "agent") return no("E_ACCOUNT_OWNER_ONLY", { venue, message: `a swap at ${a.account.name} is the owner's to sign` });
    if (usd < sw.minUsd) return no("E_VENUE_MIN_DEPOSIT", { venue, message: `${a.account.name}: a swap is at least $${sw.minUsd}`, detail: { minUsd: sw.minUsd } });
    const expected = r2(usd - (usd * sw.feeBps) / 10_000);
    const floor = micro(minReceive);
    if (Number.isNaN(floor) || expected * 1e6 < floor) return no("E_ACCOUNT_REQUOTE", { message: `the swap would bring ${money(expected)}, less than the ${money((floor || 0) / 1e6)} that was agreed`, detail: { expected, minReceive } });
    let flight: FlightLike | undefined;
    let spend: SpendApproval | undefined;
    if (who.authority === "agent") {
      const s = spendFor(this.state, who.signer, "venues", now);
      if (isRefusal(s)) return s;
      if (!(await this.stillSigned(s))) return no("E_ACCOUNT_BAD_SIGNATURE", { message: "the spending approval's own signature no longer checks out against the account's owners", detail: { approval: s.id } });
      // the venue has to be named, the amount inside the per-payment line, and the budget has to hold it: a swap is the agent using the user's money
      const limit = covers(s, venue, amountMicro, now);
      if (limit) return limit;
      // and the dial: an ended session, a venue switched off, a key that cannot trade there, Guard's daily cap. Above Guard's no-ask line it is the owner's
      const v = evaluate({ intent: { kind: "trade", symbol: `${buy}-${sell}`, side: "buy", qty: usd }, account: a.account, openness: this.host.policy(), now: this.host.now(), dailyOutUsd: this.host.dailyOutUsd(this.host.now()) });
      if (isRefusal(v)) return v;
      if (v.card) return no("E_ACCOUNT_OWNER_ONLY", { venue, message: `${v.card.reason}: a swap that size is the owner's to sign` });
      spend = s;
      flight = this.host.openFlight(agentIdOf(who.agent!), `Swap ${money(usd)} ${sell} → ${buy} · ${a.account.name}`);
    }
    const r = a.convert?.(sell, buy, usd) ?? no("E_VENUE_CURRENCY", { venue });
    if (isRefusal(r)) {
      if (flight) this.host.say(flight.no, `Swap ${sell} → ${buy} at ${a.account.name}: ${r.message}`, "no");
      return r;
    }
    const at = this.host.now();
    const leg = { step: "swap" as const, venue, rail: "swap", protocol: sw.protocol, token: buy, feeUsd: r.feeUsd ?? 0, etaSec: 0, access: sw.access, final: true, status: "settled" as const, startedAt: at, settlesAt: at, ref: r.ref, native: r.native };
    const p: Payment = { id: `pay-${String(++this.seq).padStart(4, "0")}`, kind: "swap", at, from: venue, to: venue, sourceToken: sell, token: buy, amountUsd: usd, feeUsd: r.feeUsd ?? 0, receiveUsd: r.received ?? expected, legs: [leg], status: "settled", settlesAt: at, settledAt: at, signer: who.signer, authority: who.authority, ...(who.agent ? { agent: who.agent.address } : {}), ...(flight ? { flight: flight.no } : {}), action: who.hash };
    this.payments.unshift(p);
    if (spend) this.patchSpend(spend.id, (x) => ({ ...x, spentMicro: x.spentMicro + amountMicro }));
    this.host.log({ kind: "action", venue, tool: who.authority === "agent" ? "agentSwap" : "swap", signer: who.signer, envelope: who.envelope, outcome: "settled", notionalUsd: usd, reason: `${p.id} · ${usd} ${sell} → ${p.receiveUsd} ${buy} at ${a.account.name} · fee ${money(p.feeUsd)}`, payment: p.id, native: r.native, ...(flight ? { flight: flight.no } : {}), ...(who.agent ? { agent: slug(who.agent.name) } : {}) });
    if (flight) this.host.say(flight.no, `Swapped ${money(usd)} ${sell} → ${money(p.receiveUsd)} ${buy} at ${a.account.name} · fee ${money(p.feeUsd)}`, "ok", { usd, account: venue });
    return { ok: true, kind: "payment", payment: p, ...(flight ? { flight: flight.no } : {}) };
  }

  // ---- the owner's answer to a card -----------------------------------------------------

  private async answerCard(action: Extract<OwnerAction, { type: "approveCard" }>, envelope: Envelope, signer: string): Promise<Outcome> {
    const card = this.host.card(action.card);
    // a card that ran out of time was closed by the account already (expireCards): an answer that comes now is told so
    if (card && card.status !== "pending" && this.expired.has(card.id)) return no("E_ACCOUNT_CARD_EXPIRED", { detail: { card: card.id, expiredAt: card.expiresAt } });
    if (!card || card.status !== "pending") return no("E_CARD_NOT_GRANTED", { message: `no pending card ${action.card}` });
    if (action.action !== cardHash(card)) return no("E_ACCOUNT_BAD_SIGNATURE", { message: "this approval names a different instruction than the one the card holds", detail: { card: card.id } });
    let held = card.action !== undefined;
    const release = () => {
      if (!held) return;
      held = false;
      // in the approval that was holding it — which may have been replaced since; never in whatever approval happens to be live now
      if (card.approval) this.patchSpend(card.approval, (x) => ({ ...x, reservedMicro: Math.max(0, x.reservedMicro - micro(String(card.usd))) }));
    };
    const now = this.nowMs();
    if (card.expiresAt && now >= Date.parse(card.expiresAt)) {
      release();
      this.host.closeCard(card.id, "rejected", "The card expired before it was answered; nothing moved");
      return no("E_ACCOUNT_CARD_EXPIRED", { detail: { card: card.id, expiredAt: card.expiresAt } });
    }
    this.host.log({ kind: "action", venue: card.account, tool: "approveCard", signer, envelope, outcome: action.decision, reason: `${card.id} · ${action.decision}`, intentId: card.id, flight: card.flight });
    if (action.decision !== "approve") {
      if (!card.action) return { ok: true, kind: "result", result: await this.host.decide(card.id, "reject"), flight: card.flight };
      release();
      this.host.closeCard(card.id, "rejected", "You rejected it; nothing moved");
      return { ok: true, kind: "result", result: no("E_CARD_REJECTED", { venue: card.account, detail: { card: card.id } }), flight: card.flight };
    }
    // a card the older write path raised: the service re-checks it and settles it — if the agent key that asked for it still stands
    if (!card.action) {
      const asked = card.signer ? agentStatus(this.state, card.signer, now) : "ok";
      if (asked !== "ok") {
        this.host.closeCard(card.id, "rejected", "The agent key that asked for this no longer stands; nothing moved");
        return no(asked === "expired" ? "E_ACCOUNT_AGENT_EXPIRED" : "E_ACCOUNT_AGENT_REVOKED", { detail: { card: card.id, signer: card.signer } });
      }
      return { ok: true, kind: "result", result: await this.host.decide(card.id, "approve"), flight: card.flight };
    }
    // the agent's own instruction is run again from the top: its key, its approval, the doors, the dial. Only the card itself is not asked twice
    const key = this.state.agents.find((k) => k.address === card.signer);
    const status = agentStatus(this.state, card.signer ?? "", now);
    let again: Outcome;
    if (!key || status !== "ok") again = no(status === "expired" ? "E_ACCOUNT_AGENT_EXPIRED" : "E_ACCOUNT_AGENT_REVOKED", { detail: { signer: card.signer } });
    else if (card.action.type === "agentLiveMove") {
      release();
      again = await this.live.release(card, { signer: key.address, agent: key });
    } else if (card.action.type === "agentLiveOrder") {
      release();
      again = await this.trade.release(card, { signer: key.address, agent: key });
    } else if (card.action.type === "agentLiveAmend") {
      release();
      again = await this.trade.releaseAmend(card, { signer: key.address, agent: key });
    } else if (card.action.type === "agentLiveClose") {
      release();
      again = await this.trade.releaseClose(card, { signer: key.address, agent: key });
    } else if (card.action.type === "agentLiveLeverage") {
      release();
      again = await this.trade.releaseLeverage(card, { signer: key.address, agent: key });
    } else if (card.action.type === "agentLiveEarn") {
      release();
      again = await this.earn.release(card, { signer: key.address, agent: key });
    } else if (card.action.type === "agentSendAsset" || (card.action.type === "agentPay" && this.payer)) {
      // what the card held of the budget goes back first: the instruction is then judged against the approval like any other — every limit of it
      release();
      again = card.action.type === "agentSendAsset" ? await this.move(card.action, { signer: key.address, authority: "agent", agent: key, envelope, hash: card.actionHash! }, card) : await this.payer!.pay(card.action, { signer: key.address, agent: key, envelope, hash: actionHash(card.action) }, card);
    } else again = no("E_ACCOUNT_BAD_ACTION", { message: "this card holds an instruction that cannot be released" });
    release();
    if (isRefusal(again)) {
      this.host.closeCard(card.id, "approved", `Approved, but it no longer passes: ${again.message}`, again);
      return again;
    }
    this.host.closeCard(card.id, "approved", "", again);
    return again;
  }

  // ---- time -----------------------------------------------------------------------------

  /** Cards nobody answered inside their thirty minutes: each gives back what it held of its limit — exactly as the owner's answer would —
   * and is closed, so that a dead card never holds an agent's limit past its time. Run before anything reads or moves */
  expireCards(nowMs: number): void {
    for (const card of this.host.cards()) {
      if (card.status !== "pending" || !card.expiresAt || nowMs < Date.parse(card.expiresAt)) continue;
      // in the approval that was holding it — which may have been replaced since — never in whatever approval happens to be live now
      if (card.action !== undefined && card.approval) this.patchSpend(card.approval, (x) => ({ ...x, reservedMicro: Math.max(0, x.reservedMicro - micro(String(card.usd))) }));
      this.trade.forget(card.id);
      this.earn.forget(card.id);
      this.expired.add(card.id);
      if (this.expired.size > 500) this.expired.delete(this.expired.values().next().value!);
      this.host.closeCard(card.id, "rejected", "The card expired before it was answered; nothing moved");
    }
  }

  /** land whatever is due; called before anything reads or moves */
  async settle(quick = false): Promise<void> {
    this.expireCards(this.nowMs());
    this.record(await settleDue(this.payments, this.nowMs(), this.money()));
    this.payer?.tick(this.nowMs());
    if (quick) return;
    // asking venues how things stand never takes the account down: a venue that throws is asked again next time
    try {
      await this.live.poll();
    } catch (err) {
      this.host.log({ kind: "note", venue: "*", tool: "live poll", reason: `asking how payments stand failed: ${String((err as Error)?.message ?? err).slice(0, 160)}` });
    }
    // a page read waits for the venues a few seconds at most: what arrives later is shown on the next read. The timer is cleared whichever
    // side wins, so a read does not keep the process alive after it is done
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.all([this.trade.poll(), this.earn.poll()]), new Promise((resolve) => (timer = setTimeout(resolve, 3_000)))]);
    } catch (err) {
      this.host.log({ kind: "note", venue: "*", tool: "order poll", reason: `asking how orders stand failed: ${String((err as Error)?.message ?? err).slice(0, 160)}` });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private record(events: Advance[]): void {
    for (const e of events) {
      const p = e.payment;
      const flight = p.flight;
      if (e.event === "started" && e.leg) this.host.log({ kind: "payment", venue: e.leg.venue, tool: e.leg.protocol, outcome: "leg started", payment: p.id, reason: `${p.id} · ${e.leg.step} at ${this.name(e.leg.venue)}${e.leg.chain ? ` (${e.leg.chain})` : ""} · due ${e.leg.settlesAt}`, native: e.leg.native, ...(e.leg.ref ? { venueOrderId: e.leg.ref } : {}), ...(flight ? { flight } : {}) });
      if (e.event === "settled") {
        const float = p.to.startsWith("sub:") ? this.sub(p.to.slice(4)) : undefined;
        if (float) this.state = { ...this.state, subAccounts: this.state.subAccounts.map((s) => (s.id === float.id ? { ...s, balanceMicro: s.balanceMicro + Math.round(p.receiveUsd * 1e6) } : s)) };
        this.host.log({ kind: "payment", venue: p.to, tool: "settled", outcome: "settled", payment: p.id, notionalUsd: p.receiveUsd, reason: `${p.id} · ${money(p.receiveUsd)} ${p.token} landed at ${float ? `float "${float.name}"` : p.external ? `${p.external.label} (${p.external.chain})` : this.name(p.to)} · fees ${money(p.feeUsd)}`, ...(flight ? { flight } : {}) });
        if (flight) this.host.say(flight, `${money(p.receiveUsd)} ${p.token} landed at ${float ? `float "${float.name}"` : this.name(p.to)} · fees ${money(p.feeUsd)}`, "ok", { usd: p.amountUsd, account: p.to });
      }
      if (e.event === "failed" || e.event === "stranded") {
        this.host.log({ kind: "payment", venue: e.leg?.venue ?? p.from, tool: e.leg?.protocol ?? "leg", outcome: e.event, payment: p.id, code: e.refusal?.code, reason: `${p.id} · ${e.event}: ${e.refusal?.message ?? ""}${p.note ? ` · ${p.note}` : ""}`, native: e.refusal?.native, ...(flight ? { flight } : {}) });
        if (flight) this.host.say(flight, e.event === "failed" ? `${this.name(e.leg?.venue ?? p.from)} refused: ${e.refusal?.message ?? "refused"}. Nothing moved` : (p.note ?? "stranded"), "no");
      }
    }
  }

  /** every settled leg at a venue that keeps a statement should be on that statement, and every line on it should be a payment the account knows */
  reconcile(): { ok: boolean; matched: number; breaks: string[] } {
    const breaks: string[] = [];
    let matched = 0;
    for (const a of this.host.accounts()) {
      const lines = this.host.adapter(a.id)?.statement?.();
      if (!lines) continue;
      const refs = new Set(this.payments.flatMap((p) => p.legs.map((l) => l.ref)).filter((x): x is string => !!x));
      const landed = this.payments.filter((p) => p.status === "settled" && p.to === a.id && p.legs[p.legs.length - 1]!.step === "in");
      let credits = lines.filter((l) => l.direction === "in" && !refs.has(l.id));
      for (const p of landed) {
        const i = credits.findIndex((l) => Math.abs(l.amount - p.receiveUsd) < 0.005);
        if (i < 0) breaks.push(`${p.id}: ${money(p.receiveUsd)} should be on ${a.name}'s statement and is not`);
        else {
          matched++;
          credits = credits.filter((_, j) => j !== i);
        }
      }
      for (const l of lines) if (refs.has(l.id)) matched++;
      for (const l of credits) breaks.push(`${a.name} ${l.id}: ${money(l.amount)} ${l.asset} came in and no payment of the account explains it`);
      for (const l of lines.filter((x) => x.direction === "out" && !refs.has(x.id) && !this.payments.some((p) => p.from === a.id && Math.abs(p.amountUsd - x.amount) < 0.005))) breaks.push(`${a.name} ${l.id}: ${money(l.amount)} ${l.asset} went out and no payment of the account explains it`);
    }
    if (breaks.length) this.host.log({ kind: "reconcile", venue: "*", outcome: "break", reason: breaks.join(" | ") });
    return { ok: breaks.length === 0, matched, breaks };
  }

  // ---- what the page reads -------------------------------------------------------------------

  async view(): Promise<AccountPage> {
    await this.settle();
    const now = this.nowMs();
    const views = await this.host.views();
    const label = (r: Rail | undefined, name: string): RunwayLabel => {
      if (!r) return { text: "—", access: "closed" };
      const when = r.clock === "ach" ? etDate(achArrival(now)) : eta(r.etaSec);
      const what = r.id === "cctp" ? "CCTP" : r.clock === "ach" ? "ACH" : r.id === "deposit" || r.id === "withdraw" || r.id === "transfer" || r.id === "receive" ? r.tokens.filter((t) => t !== "pUSD").join(" · ") : r.protocol;
      if (r.access === "closed") return { text: "Closed", access: r.access, why: r.why };
      if (r.access === "venue") return { text: `At ${name} · ${when}`, access: r.access, why: r.why, opens: r.opens };
      if (r.access === "owner") return { text: `Yours to sign · ${when}`, access: r.access, why: r.why };
      return { text: `${what} · ${when}`, access: r.access };
    };
    // which venues earn, and whether the key or wallet may put money in there: what the earn screens and agents are drawn from
    const desk = this.host.liveEarn?.();
    const earnOf = (id: string): { earn?: { can: boolean | "unknown"; what: string; whyNot?: string } } => {
      const x = desk?.earner(id);
      return x ? { earn: { can: x.can, what: x.what, ...(x.whyNot ? { whyNot: x.whyNot } : {}) } } : {};
    };
    const venues = views.map((v) => {
      const d = doorOf(v);
      const stable = (h: Holding) => h.class === "stable" || h.class === "cash";
      const rail = (dir: string, x: Rail): RunwayRow => ({ dir, protocol: x.protocol, carries: x.tokens.join(" · "), chains: x.chains, feeOn1000: x.fee(1000, x.chains[0]), lands: x.clock === "ach" ? etDate(achArrival(now)) : eta(x.etaSec), access: x.access, ...(x.why ? { why: x.why } : {}), ...(x.opens ? { opens: x.opens } : {}), ...(x.minUsd !== undefined ? { minUsd: x.minUsd } : {}), final: x.final, ...(x.returnDays ? { returnDays: x.returnDays } : {}) });
      const runways: RunwayRow[] = [...d.in.map((x) => rail("In", x)), ...d.out.map((x) => rail("Out", x)), ...d.inside.map((x) => ({ dir: "Inside", protocol: x.protocol, carries: `${x.from} → ${x.to}`, chains: [], feeOn1000: 0, lands: "now", access: x.access, final: true })), ...d.swap.map((x) => ({ dir: "Swap", protocol: x.protocol, carries: x.pair.join(" ⇄ "), chains: [], feeOn1000: r2((1000 * x.feeBps) / 10_000), lands: "now", access: x.access, minUsd: x.minUsd, final: true }))];
      return { id: v.id, name: v.name, ...(v.connector ? { connector: v.connector } : {}), frontLine: d.frontLine, usd: r2(v.holdings.reduce((s, h) => s + h.usd, 0)), cashUsd: r2(v.holdings.filter((h) => stable(h) && !h.inTransit).reduce((s, h) => s + h.usd, 0)), holdings: v.holdings.map((h) => ({ asset: h.asset, amount: h.amount, usd: h.usd, class: h.class, note: h.note, inTransit: h.inTransit === true })), ...(d.restricted ? { restricted: d.restricted } : {}), ...(v.plugged ? { plugged: true, via: v.watchOnly ? `${v.provider} · ${v.scope.limits[0] ?? ""}` : v.connector === "wallet" ? "plugged in by address" : `plugged in · ${v.scope.limits[0] ?? ""}` } : {}), ...(v.watchOnly ? { live: true as const, watchOnly: v.watchOnly, ...(v.asOf ? { asOf: v.asOf } : {}), ...(v.stale ? { stale: v.stale } : {}), ...(v.proven ? { proven: v.proven } : {}), ...(v.liveCan ? { liveCan: v.liveCan } : {}), ...(v.liveTrade ? { trade: { ...v.liveTrade, kinds: v.liveTrade.kinds ?? tradeKinds(v.connector, v.liveTrade.what) } } : {}), ...earnOf(v.id), ...(v.noTradeBecause ? { noTradeBecause: v.noTradeBecause } : {}), ...(v.readOnlyBecause ? { readOnlyBecause: v.readOnlyBecause } : {}), ...(v.address ? { address: v.address } : {}) } : v.live ? { live: true as const } : {}), in: label(d.in[0], v.name), out: label(d.out[0], v.name), fiat: (d.in[0] ?? d.out[0])?.chains.length === 0, ledgers: [...new Set(d.inside.flatMap((x) => (x.from === "chain" ? [] : [x.from, x.to])))], swaps: d.swap.map((x) => ({ pair: x.pair, feeBps: x.feeBps, minUsd: x.minUsd, access: x.access })), agentKey: d.agentKey, runways };
    });
    const owners = this.state.owners.map((o) => ({ id: o.id, kind: o.kind, label: o.label }));
    return {
      now: this.host.now(),
      type: this.state.abstraction === "unifiedAccount" ? "Unified" : "Separate",
      totalUsd: r2(venues.reduce((s, v) => s + v.usd, 0) + inFlightUsd(this.payments) + heldUsd(this.payments) + this.state.subAccounts.reduce((s, x) => s + x.balanceMicro / 1e6, 0)),
      inFlightUsd: inFlightUsd(this.payments),
      heldUsd: heldUsd(this.payments),
      venues,
      payments: this.payments.slice(0, 40),
      orders: this.orders.slice(0, 60),
      earns: this.earns.slice(0, 40),
      keys: this.state.agents.map((k) => ({ address: k.address, name: k.name, code: k.code, validUntil: new Date(k.validUntil).toISOString(), approvedAt: k.approvedAt, status: agentStatus(this.state, k.address, now) })),
      requests: this.state.requests,
      spend: this.state.spends.filter((s) => s.revokedAt === undefined).map((s) => ({ id: s.id, agent: s.agent, agentName: this.state.agents.find((k) => k.address === s.agent)?.name ?? s.agent, scope: s.scope, allow: s.allow, perPaymentUsd: s.perPaymentMicro / 1e6, budgetUsd: s.budgetMicro / 1e6, spentUsd: s.spentMicro / 1e6, reservedUsd: s.reservedMicro / 1e6, windowHours: s.windowHours, validUntil: new Date(s.validUntil).toISOString(), expired: now >= s.validUntil, payTo: s.payTo, ...(s.intent ? { intent: s.intent } : {}) })),
      fees: this.state.fees.map((f) => ({ builder: f.builder, maxFeeRate: `${r2(f.maxFeeRate * 100)}%` })),
      cards: this.host.cards().filter((c) => c.status === "pending").map((c) => ({ id: c.id, flight: c.flight, usd: c.usd, reason: c.reason, hash: cardHash(c), kind: c.action?.type ?? c.intent.kind, ...(c.signer ? { agent: c.signer, agentName: this.agentName(c.signer) } : {}), ...(c.expiresAt ? { expiresAt: c.expiresAt } : {}), shown: c.action ? [...Object.entries(c.offer ?? {}).map(([name, value]) => ({ name, value: String(value) })), ...Object.entries(c.action).filter(([k]) => k !== "type" && k !== "mandates" && k !== "cnf").map(([name, value]) => ({ name, value: typeof value === "object" ? JSON.stringify(value) : String(value) }))] : [{ name: "account", value: c.account }, { name: "what", value: JSON.stringify(c.intent) }] })),
      pay: this.payer?.view() ?? { payees: [], sessions: [] },
      connectable: this.host.connectable(),
      liveUsd: r2(venues.filter((v) => "live" in v && v.live).reduce((s, v) => s + v.usd, 0)),
      ...(this.host.live ? { connectLive: this.host.live() } : {}),
      // a real account's agent wallet is read from the chains as the venue `agent-<name>`: what it holds is that venue's number. The
      // simulated float's balance stands only where no such venue is on the account
      subAccounts: this.state.subAccounts.map((s) => {
        const live = venues.find((v) => v.id === agentWalletVenue(s.name));
        return { id: s.id, name: s.name, agent: s.agent, agentName: this.state.agents.find((k) => k.address === s.agent)?.name ?? s.agent, address: s.address, capUsd: s.capMicro / 1e6, balanceUsd: live ? live.usd : s.balanceMicro / 1e6 };
      }),
      signers: { owners, threshold: this.state.threshold, pendingDevices: this.state.pendingDevices.map((d) => ({ kid: d.kid, at: d.at })) },
      destinations: this.state.destinations.map((d) => ({ ...d, usable: now >= Date.parse(d.usableAt), usableOn: etDate(Date.parse(d.usableAt)) })),
      activeKeys: activeAgents(this.state, now).length,
      watch: this.state.watch.map((w) => ({ venue: w.venue, symbol: w.symbol, at: w.at })),
      intents: this.state.intents.filter((x) => now < x.validUntil).map((x) => ({ id: x.id, agent: x.agent, agentName: x.agent === "*" ? "every agent" : this.agentName(x.agent), venue: x.venue, symbol: x.symbol, side: x.side, usd: x.usd, text: x.text, validUntil: new Date(x.validUntil).toISOString(), at: x.at, reports: x.reports, ...(x.report ? { report: { ...x.report, byName: this.agentName(x.report.by) } } : {}), byAgent: x.byAgent.map((r) => ({ ...r, byName: this.agentName(r.by) })) })),
      asks: this.waitingAsks(now).map((x) => ({ ...x })),
      declinedAsks: this.declinedAsks(now).map((x) => ({ ...x })),
      modeRules: modeRules(),
      ...(this.host.real ? { real: true as const } : {}),
    };
  }

  private lastNonce = 0;

  /** a nonce for an instruction signed now: the clock, never the same one twice */
  nextNonce(): number {
    // asked for often (anyone can ask), it climbs at most a second past the clock: it cannot be pushed ahead until instructions look post-dated
    const now = this.nowMs();
    this.lastNonce = Math.max(now, Math.min(this.lastNonce + 1, now + 1000));
    return this.lastNonce;
  }

  /** Turn what the owner asked for on the page into the exact action they will sign: for a movement, the route is planned now and its hash, its
   * fee and its latest arrival go INTO the action. The page shows these fields and the device signs these fields; nothing is signed that is not shown. */
  async prepare(draft: Record<string, unknown>): Promise<Prepared | Refusal> {
    const type = String(draft.type ?? "");
    if (this.host.real && SIMULATED_ONLY.has(type) && !(REAL_PAYS.has(type) && this.paysReal())) return realOnly(type);
    const nonce = this.nextNonce();
    let action: OwnerAction;
    let quote: Prepared["quote"];
    if (type === "sendAsset") {
      const fields = { destination: String(draft.destination ?? "self"), sourceDex: String(draft.sourceDex ?? ""), destinationDex: String(draft.destinationDex ?? ""), token: String(draft.token ?? "USDC"), amount: String(draft.amount ?? "") };
      const r = await this.resolve(fields, "owner");
      if (isRefusal(r)) return r;
      const { route } = r;
      const b = route.blocker;
      if (route.access === "closed" || route.access === "venue") return no("E_VENUE_RAIL_CLOSED", { venue: b?.venue ?? route.from, message: `${this.name(b?.venue ?? route.from)}: ${b?.why ?? "this runway is closed"}`, detail: { ...(b?.opens ? { opens: b.opens } : {}) } });
      action = { type: "sendAsset", ...fields, fromSubAccount: "", route: route.hash, maxFee: String(route.feeUsd), deadline: route.arrivalMs + MONEY_TTL_MS, nonce };
      // a leg out of a wallet the account holds no key for is signed in that wallet: the page says so before the owner signs here
      const inWallet = route.legs.find((l) => l.step === "out" && this.host.adapter(l.venue)?.account.connector === "wallet");
      quote = { words: routeWords(route, (id) => this.name(id), this.nowMs()), feeUsd: route.feeUsd, receiveUsd: route.receiveUsd, lands: whenLabel(this.nowMs(), route.arrivalMs), access: route.access, ...(inWallet ? { signAt: this.name(inWallet.venue) } : {}), final: route.legs[route.legs.length - 1]!.final, legs: route.legs.map((l) => ({ step: l.step, venue: this.name(l.venue), protocol: l.protocol, feeUsd: l.feeUsd })) };
    } else if (type === "liveMove") {
      // real money: the destination address is asked of the destination venue here, never taken from the page
      const r = await this.live.prepare(draft);
      if (isRefusal(r)) return r;
      action = { ...r, nonce };
      const fee = Number(r.maxFee);
      const writes = this.host.liveMoney?.().writes();
      quote = { words: `${r.kind} ${r.amount} ${r.asset}${r.kind === "swap" ? ` for ${r.toAsset}` : ""}`, feeUsd: fee, receiveUsd: r2(Math.max(0, Number(r.amount) - fee)), lands: r.kind === "transfer" || r.kind === "swap" ? "at once" : "when the venue has sent it", access: "owner", final: true, legs: [], live: { toAddress: r.toAddress, network: r.network, capUsd: writes?.capUsd ?? 0 } };
    } else if (type === "liveOrder" || type === "liveAmend") {
      // an order (or a change to one): the market, its price and its steps are asked of the venue here; the exact size and the most it may be
      // worth go into the action
      const r = type === "liveOrder" ? await this.trade.prepare(draft) : await this.trade.prepareAmend(draft);
      if (isRefusal(r)) return r;
      action = { ...r.action, nonce };
      quote = { words: r.quote.words, feeUsd: 0, receiveUsd: r.quote.notionalUsd, lands: "at once", access: "owner", final: true, legs: [], order: r.quote };
    } else if (type === "liveClose") {
      // a position closed at market: what it is worth now and whether that is over the server's cap, before anything is shown to sign —
      // the door holds the close to the same cap when it runs
      const r = await this.trade.prepareClose(draft);
      if (isRefusal(r)) return r;
      action = { ...r.action, nonce };
      quote = { words: r.quote.words, feeUsd: 0, receiveUsd: r.quote.worthUsd, lands: "at once", access: "owner", final: true, legs: [], close: r.quote };
    } else if (type === "liveEarn") {
      // money into or out of a venue's earn product: the product, its yield and the asset's price are asked of the venue here; the exact
      // amount, what it is worth and where money taken out lands go into the action
      const r = await this.earn.prepare(draft);
      if (isRefusal(r)) return r;
      action = { ...r.action, nonce };
      quote = { words: r.quote.words, feeUsd: 0, receiveUsd: r.quote.usd, lands: r.quote.kind === "withdraw" ? r.quote.lands : "in the product", access: "owner", final: true, legs: [], earn: r.quote };
    } else if (isOwnerAction({ type })) {
      action = { ...draft, type, nonce } as unknown as OwnerAction;
      // a limit that names no intent carries no `intent` field at all: it then signs exactly as a limit always has
      if (action.type === "approveSpend" && typeof action.intent === "string" && action.intent.trim() === "") delete action.intent;
      // an earn limit over "every account" is refused here, before it is shown and signed, as the door would refuse it
      if (action.type === "approveSpend" && action.scope === "earn" && String(action.allow).split(",").some((x) => x.trim() === "*")) return no("E_ACCOUNT_BAD_ACTION", { message: EARN_NAMES });
    } else return no("E_ACCOUNT_BAD_ACTION", { message: `"${type}" is not something the owner signs` });
    const wrong = malformed(action);
    if (wrong) return no("E_ACCOUNT_BAD_ACTION", { message: wrong });
    const data = ownerTypedData(action);
    return { ok: true, action, primaryType: data.primaryType, domain: { name: String(data.domain.name), version: String(data.domain.version), chainId: Number(data.domain.chainId) }, accountChain: String(data.message.accountChain), shown: shownFields(action), ...(quote ? { quote } : {}) };
  }
}

/** an owner action ready to be shown and signed */
export interface Prepared {
  ok: true;
  action: OwnerAction;
  primaryType: string;
  domain: { name: string; version: string; chainId: number };
  accountChain: string;
  shown: Array<{ name: string; value: string }>;
  quote?: { words: string; feeUsd: number; receiveUsd: number; lands: string; access: string; signAt?: string; live?: { toAddress: string; network: string; capUsd: number }; order?: OrderQuote; close?: CloseQuote; earn?: EarnQuote; final: boolean; legs: Array<{ step: string; venue: string; protocol: string; feeUsd: number }> } | undefined;
}

/** one rail of a venue as the Runways tab shows it */
export interface RunwayRow {
  dir: string;
  protocol: string;
  carries: string;
  chains: string[];
  feeOn1000: number;
  lands: string;
  access: string;
  why?: string;
  opens?: string;
  minUsd?: number;
  final: boolean;
  returnDays?: number;
}

export interface RunwayLabel {
  text: string;
  access: "agent" | "owner" | "venue" | "closed";
  why?: string | undefined;
  opens?: string | undefined;
}

export interface AccountPage {
  now: string;
  type: "Separate" | "Unified";
  totalUsd: number;
  inFlightUsd: number;
  /** what open payment sessions hold in escrow that is still the user's */
  heldUsd: number;
  venues: Array<{ id: string; name: string; /** the connection it was made with, as the owner signed it (`live:exchange:okx`, `live:wallet`, `live:metamask`) */ connector?: string; /** a venue connected by API key: the key file it reads, as the owner signed it (a path in the home folder, never what is in it) */ keyFile?: string; frontLine: string; usd: number; cashUsd: number; holdings: Array<{ asset: string; amount: number; usd: number; class: Holding["class"]; note?: string | undefined; inTransit: boolean; /** class `earn`: the product it is in (live/earn.ts), its yield and its name, as the venue says them */ earn?: EarnHolding | undefined }>; restricted?: string; /** the owner plugged it in: it can be unplugged */ plugged?: boolean; via?: string; /** its balances are the real venue's */ live?: true; /** connected read-only: every door through it is shut */ watchOnly?: string; asOf?: string; stale?: string; proven?: string; liveCan?: Account["liveCan"]; readOnlyBecause?: string; /** orders can be placed here: may the key trade, and what is traded */ trade?: Account["liveTrade"]; noTradeBecause?: string; /** money can be put to earn here (live/earn.ts): may the key or wallet put money in, and what is earned */ earn?: { can: boolean | "unknown"; what: string; whyNot?: string }; address?: string; in: RunwayLabel; out: RunwayLabel; /** it moves dollars by ACH, not stablecoins on a chain */ fiat: boolean; ledgers: string[]; swaps: Array<{ pair: [string, string]; feeBps: number; minUsd: number; access: string }>; agentKey: Door["agentKey"]; runways: RunwayRow[] }>;
  payments: Payment[];
  /** orders placed at venues connected live, newest first */
  orders: LiveOrder[];
  /** money put into earn products at venues connected live, or taken out, newest first */
  earns: LiveEarn[];
  keys: Array<{ address: string; name: string; code: string; validUntil: string; approvedAt: string; status: string }>;
  requests: AccountState["requests"];
  /** the standing limits. `intent`: the open intent the owner tied the limit to when signing it (its id), where there is one */
  spend: Array<{ id: string; agent: string; agentName: string; scope: string; allow: string[]; perPaymentUsd: number; budgetUsd: number; spentUsd: number; reservedUsd: number; windowHours: number; validUntil: string; expired: boolean; payTo: Record<string, string>; intent?: string }>;
  fees: Array<{ builder: string; maxFeeRate: string }>;
  /** cards waiting for the owner. `kind`: the agent's instruction type (agentLiveOrder, agentLiveMove …); a card the older write path raised
   * names its intent's kind (trade, move …). `agent`: the key that asked, and its name on the account */
  cards: Array<{ id: string; flight: string; usd: number; reason: string; hash: Hex; kind: string; agent?: string; agentName?: string; expiresAt?: string; shown: Array<{ name: string; value: string }> }>;
  subAccounts: Array<{ id: string; name: string; agent: string; agentName: string; address: string; capUsd: number; balanceUsd: number }>;
  signers: { owners: Array<{ id: string; kind: string; label: string }>; threshold: number; pendingDevices: Array<{ kid: string; at: string }> };
  destinations: Array<AccountState["destinations"][number] & { usable: boolean; usableOn: string }>;
  activeKeys: number;
  /** the payees the account has paid and the payment sessions it holds open */
  pay: PayView;
  /** venues the owner has and could plug in */
  connectable: Connectable[];
  /** how much of the total is real money at venues connected live */
  liveUsd: number;
  /** the real venues this service can connect, read-only */
  connectLive?: LiveOptions | undefined;
  /** the account holds real accounts only: every venue on it is connected live */
  real?: true;
  /** a real account that restarted: what it brought back from its ledgers (service.ts RestoreReport) */
  restore?: unknown;
  /** the markets the owner watches, which agents read */
  watch: Array<{ venue: string; symbol: string; at: string }>;
  /** the owner's open intents — words to an agent (`agent` its address) or to every agent (`*`), none of them a limit — each with how many
   * reports agents made on it since the owner last set its words, the latest of them, and each agent's own latest (`byAgent`) */
  intents: Array<{ id: string; agent: string; agentName: string; venue: string; symbol: string; side: string; usd: string; text: string; validUntil: string; at: string; reports: number; report?: AgentReport & { byName: string }; byAgent: Array<AgentReport & { byName: string }> }>;
  /** what agents have asked the owner for and is still waiting (in memory: a restart clears it) */
  asks: AgentAsk[];
  /** what the owner declined in the last day (answerAsk), for the agent that asked to see (in memory: a restart clears it) */
  declinedAsks: DeclinedAsk[];
  /** what Guard and Beast do with an agent's request, door by door, and how long a card waits (minutes), as the doors themselves have it
   * (account/mode-rules.ts): the Mode sheet draws its table from here */
  modeRules: { rows: ModeRule[]; cardMinutes: number };
}

/** money in a venue's earn product, as a holding on the account page: the product, what goes in and comes out, its yield */
export interface EarnHolding {
  product: string;
  /** what goes in and comes out (the position may be counted in the vault's own shares) */
  asset: string;
  name?: string | undefined;
  apy?: number | undefined;
  accrued?: number | undefined;
  accruedUsd?: number | undefined;
  /** the venue's last read of it failed: this is the last good number */
  stale?: true | undefined;
}

export type { Jwk };
