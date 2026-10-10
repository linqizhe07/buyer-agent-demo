/** The agent portfolio manager, in-process: the adapters, the openness dial,
 * the approval queue, the FLIGHT BOARD and a hash-chained ledger behind one
 * object. The HTTP server, the MCP server and the scripted demo all drive
 * this; it binds no port itself, so the unit tests and the headless demo run
 * anywhere.
 *
 * The airport: every agent request is a FLIGHT with a number whose prefix is
 * the agent's code (PM-0001 the page's scripted agent, CC-0002 Claude Code
 * over MCP, TD-0003 the terminal demo). A flight has LEGS — one per account
 * the money touches — and a leg can be an ok, a refusal in plain words, or a
 * card waiting for the human. Every ledger row carries the flight and the
 * agent, so the flight log reads end to end.
 *
 *   openFlight / fly / note     the page agent's multi-leg flights
 *   execute(account, intent, agent)  one-leg flight (the MCP server's write)
 *   quote / order               the tower's routing service: one order priced
 *                               at every venue (CEX books, DEX pools) and split
 *                               across them; `order` flies the slices as one
 *                               flight
 *   flyBatch                    the slices of one order: ONE decision — the
 *                               wallet judges the whole order (splitting never
 *                               slips under an allowance) and raises one card,
 *                               not one per slice
 *   decide(approvalId, …)       the human's answer to a card, as one more leg
 *   read / overview             never gated; one read across every account
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ledger, type LedgerRow } from "../agent/ledger.ts";
import { isRefusal, type Refusal } from "../core/errors.ts";
import { no, unaddressed, unaddressedDeep } from "./refuse.ts";
import { describeIntent, ENFORCER_LABEL, KIND_LABEL, KIND_ORDER, PRICES, qtyText, r2, SCRIPT_AGENT, tradeKinds, usdOf, WRITE_CAPS, type Account, type AccountAdapter, type AgentId, type Capability, type ExecOk, type ExecResult, type Holding, type Intent } from "./accounts.ts";
import { alpacaAccount, type AlpacaSeed } from "./adapters/alpaca.ts";
import { binanceAccount, type BinanceSeed } from "./adapters/binance.ts";
import { hyperliquidAccount, type HyperliquidSeed } from "./adapters/hyperliquid.ts";
import { kalshiAccount, type KalshiSeed } from "./adapters/kalshi.ts";
import { metamaskLiveAccount, metamaskSimAccount, type MetamaskSimSeed, type MmLiveOptions } from "./adapters/metamask.ts";
import { polymarketLiveAccount, polymarketSimAccount, type PolymarketSeed } from "./adapters/polymarket.ts";
import { okxAccount, type OkxSeed } from "./adapters/okx.ts";
import { ondoAccount, type OndoSeed } from "./adapters/ondo.ts";
import { compileOpenness, effectiveReach, evaluate, isExpired, parseOpenness, type AskReason, type Card, type Mode, type Openness, type OpennessRow } from "./openness.ts";
import { aggregate, liquidity, type Aggregate, type Liquidity } from "./portfolio.ts";
import { ladder, type Ladder } from "./rails.ts";
import { chainName } from "./accounts.ts";
import { eventState, eventSymbol, eventTop, EVENTS, isEventSymbol, PREDICTION_VENUES, type EventState } from "./events.ts";
import { orderPlan, type OrderPlan, type Part } from "./router.ts";
import type { Side } from "./venues.ts";
import { cents, detailOf, plainRefusal, routeLine, sayOf, waitWords } from "./words.ts";
import { HOW_TEXT, MAX_NOTES, MemoryStore, NOTE_TEXT, TOPIC_WORDS, TOPICS, type MemoryNote, type MemoryRules, type Topic } from "./account/memory.ts";
import { etDate } from "./account/calendar.ts";
import { AccountEngine, CARD_TTL_MS, slug, type AccountPage, type AccountSeed, type AgentAsk, type CardOffer, type DeclinedAsk, type Outcome } from "./account/exchange.ts";
import { assetKey, byAsset, change24h, withEarn, type AssetRow, type DayChange, type EarnHeld, type MoneySummary } from "./account/holdings.ts";
import { NetWorthLog, networthPath, type NetWorthHistory, type NetWorthSnapshot } from "./account/networth.ts";
import { costBasis, ordersOf, type CostBasis, type LoggedOrder, type VenuePosition } from "./account/costbasis.ts";
import type { LiveOrder } from "./account/live-orders.ts";
import type { LiveEarn } from "./account/live-earn.ts";
import type { Payment } from "./account/payments.ts";
import { exploreAcross, type Exploration, type ExploreSort, type ExploreVenue } from "./live/explore.ts";
import { holdBackMs, publicSources, type PublicSource } from "./live/public-markets.ts";
import { TABS, type TabId } from "./live/categories.ts";
import { CHAIN_BY_ID, CHAINS, type ChainName } from "./live/chain.ts";
import { mountPayees, type PayeeWorld } from "./account/payees.ts";
import { doorOf, EXCHANGES } from "./account/doors.ts";
import { isSelfCustody, plug, type PlugSeed } from "./adapters/exchange.ts";
import { liveAccount } from "./adapters/live.ts";
import { KEY_SHAPES, keyFileStatus, liveOptions, openLive, parseConnector, type LiveDeps } from "./live/index.ts";
import { exchangeEarner, type EarnPosition, type EarnProduct, type LiveEarner } from "./live/earn.ts";
import { exchangeEarnHook } from "./live/exchange-trade.ts";
import type { LiveVenue } from "./account/live-moves.ts";
import { CANDLE_INTERVALS, DONE, floorTo, inDollars, type Candle, type CandleInterval, type LiveTrader, type Market, type MarketKind, type MarketStats, type Position } from "./live/trade.ts";
import { compareAcross, normalBase, type Comparison, type PlaceRule } from "./live/compare.ts";
import { fold, type StatementLine } from "./account/statement.ts";
import { WalletProofs } from "./live/proof.ts";
import { proofHolds, readHistory, rebuild, runOf, type DialSnapshot, type Rebuilt, type RunMark } from "./account/restore.ts";
import { RealPayer } from "./account/pay-real.ts";
import { agentWalletKey, agentWalletKeyPath, hasKey } from "./account/keystore.ts";
import { agentWalletSource, agentWalletVenue } from "./live/agent-wallet.ts";
import { guardedHttp, type PayHttp } from "./live/guarded-http.ts";
import { publicSender } from "./live/chain.ts";
import { agentStatus, type SubAccount } from "./account/state.ts";
import { publicChain } from "./live/chain.ts";
import { realMm } from "./live/metamask.ts";
import { publicPrices } from "./live/prices.ts";
import { ROBINHOOD_MCP } from "./live/robinhood.ts";
import { OAuthSignIn } from "./live/signin.ts";
import { reachBanUntil, reachKeepMs, reachOf, type Reach } from "./live/reach.ts";
import { EDITIONS, KNOWN_EXCHANGES, venuesHere, verdictOf, type AvailabilityDeps, type VenueHere } from "./live/availability.ts";
import { termsHere, VENUE_TERMS } from "./live/eligibility.ts";
import { locator, type Locator } from "./live/location.ts";
import { isStable, realHttp } from "./live/types.ts";
import { isPlain } from "./account/state.ts";
import type { AgentAction, Envelope, Hex } from "./account/sign.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const FIXTURES = join(ROOT, "fixtures", "home", "portfolio");

export interface Seeds {
  binance: BinanceSeed;
  okx: OkxSeed;
  metamask: MetamaskSimSeed;
  polymarket: PolymarketSeed;
  kalshi: KalshiSeed;
  ondo: OndoSeed;
  /** the two front-line venues the account layer adds; absent in the original set */
  alpaca?: AlpacaSeed | undefined;
  hyperliquid?: HyperliquidSeed | undefined;
}

/** `classic`: the accounts the portfolio demo was built on · `frontline`: those plus a stock broker and Hyperliquid, with the two changes that make them reachable (an OKX key that can withdraw to verified addresses, USDC on Arbitrum in the wallet) */
export type VenueSet = "classic" | "frontline";

export interface ServiceOptions {
  /** where the ledger goes (`$BUYER_HOME`); never the repo */
  home: string;
  now?: () => string;
  /** replace the simulated MetaMask account with the real `mm` CLI (reads; writes stay off unless PORTFOLIO_MM_WRITES=1) */
  live?: boolean;
  mm?: MmLiveOptions;
  seeds?: Seeds;
  /** which accounts are mounted when no seeds are given (default `classic`) */
  venues?: VenueSet;
  /** mount the account layer (signed instructions, agent keys, spending approvals, payments with a clock). On by default with `frontline`; the original demo runs without it */
  account?: AccountSeed | undefined;
  openness?: unknown;
  /** start from an empty ledger even when a file with this name exists: a scripted run on a fixed clock gets the same file name every time and would otherwise append to its previous run */
  freshLedger?: boolean;
  /** a real account starts from nothing instead of continuing its ledgers (account/restore.ts): `--fresh` */
  fresh?: boolean | undefined;
  /** how a payee is asked when an agent pays with real money (live/guarded-http.ts); a stand-in in tests */
  payHttp?: PayHttp | undefined;
  /** the venues the owner could plug in (default: fixtures `connectable.json`) */
  connectable?: Record<string, PlugSeed> | undefined;
  /** stand-ins for what a live connection reaches — the exchange library, HTTP, the chain, the real clock — so tests never leave the process */
  liveDeps?: Partial<LiveDeps> | undefined;
  /** REAL money at venues connected live (the server's `--live-writes`): the most one movement may be, and the code the first owner types.
   * Absent: live venues are read, and nothing moves at them */
  liveWrites?: { capUsd: number; pairingCode: string } | undefined;
  /** the code the first owner types when nothing moves money either (a read-only real account): an owner paired without one would own the
   * account's later runs, money and all. With liveWrites, its own code is the one */
  pairingCode?: string | undefined;
  /** REAL accounts only (the server's default): no simulated venue is mounted, and the account layer has no simulated payee, plug-in
   * or clock. What is on the service is what the owner connected through each venue's own interface */
  real?: boolean | undefined;
  /** the keyless public market data Markets reads beside the connected venues (default: live/public-markets.ts publicSources over the live
   * connection's network and exchange library); stand-ins in tests */
  publicMarkets?: PublicSource[] | undefined;
}

/** one slice of an order (or any step an agent flies): where, what, and the agent's words for it */
export interface BatchStep {
  account: string;
  intent: Intent;
  say?: string | undefined;
  compare?: string | undefined;
}

export interface Approval {
  id: string;
  at: string;
  account: string;
  intent: Intent;
  usd: number;
  reason: string;
  status: "pending" | "approved" | "rejected";
  /** what made the wallet ask */
  why: AskReason;
  flight: string;
  decidedAt?: string | undefined;
  result?: ExecResult | undefined;
  /** a split order waits on ONE card: every slice it covers (`account` / `intent` above are its first slice) */
  batch?: BatchStep[] | undefined;
  /** the order in words — `Sell 3 ETH (3 slices)` */
  title?: string | undefined;
  /** what each slice came back with, once approved */
  results?: ExecResult[] | undefined;
  /** lines the agent holds back until the card is approved and the writes have landed (where the proceeds are) */
  notes?: string[] | undefined;
  /** the account layer: the agent's signed instruction this card would release, and who signed it. Such a card is answered with the owner's signature, not with `decide` */
  action?: AgentAction | undefined;
  actionHash?: Hex | undefined;
  signer?: string | undefined;
  /** the account layer: a card does not wait for ever */
  expiresAt?: string | undefined;
  /** the account layer: what a payee asked for, when the card is about a payment to someone else */
  offer?: CardOffer | undefined;
  /** the account layer: what releasing the card produced (the payment, and what it bought), for the agent that asked */
  outcome?: unknown;
  /** the account layer: the spending approval this card holds its share of */
  approval?: string | undefined;
}

export type Pending = { ok: true; pending: true; approval: Approval };
export type ExecuteOutcome = ExecOk | Refusal | Pending;

export function isPending(v: ExecuteOutcome): v is Pending {
  return v.ok === true && (v as Pending).pending === true;
}

export type Mark = "ok" | "no" | "wait" | "note";

export interface Leg {
  seq: number;
  mark: Mark;
  /** a sentence a person reads; the code is on the ledger */
  text: string;
  account?: string | undefined;
  intent?: Intent | undefined;
  usd?: number | undefined;
  approvalId?: string | undefined;
  /** what this leg was chosen over: the other routes, the other venues; for a DEX swap, its route */
  compare?: string | undefined;
  /** a split order's proportions, drawn as one bar under the agent's narration */
  parts?: Part[] | undefined;
}

export interface Flight {
  no: string;
  agent: AgentId;
  at: string;
  /** what the agent was asked, in its words */
  request: string;
  legs: Leg[];
}

export interface MarketView {
  id: string;
  title: string;
  closesAt: string;
  /** open · awaiting (past its close, not yet resolved) · resolved */
  state: EventState;
  resolved?: string;
  /** what to pass as `base` to quote or order: `<id>:YES`, `<id>:NO` */
  symbols: string[];
  venues: Array<{ venue: string; name: string; ticker: string; yes: { bid?: number | undefined; ask?: number | undefined; bidSize?: number | undefined; askSize?: number | undefined }; rules: string }>;
}

export interface AccountView extends Account {
  kindLabel: string;
  enforcerLabel: string;
  reach: Capability[];
  revoked: boolean;
  usd: number;
  holdings: Holding[];
  readError?: string | undefined;
}

export interface Overview {
  now: string;
  live: boolean;
  mode: Mode;
  session: { expiresAt: string; expired: boolean };
  portfolio: Aggregate;
  liquidity: Liquidity;
  /** liquidity as amount × time × cost: how soon each holding can be at the hub chain, and for how much */
  ladder: Ladder;
  accounts: AccountView[];
  /** the simulation's dial, compiled per account, and the agent's day against its cap: the original statement's. A real account has none
   * of them (its venues are real, its limits are the owner's signed ones), so they are left out there */
  compiled?: OpennessRow[] | undefined;
  openness?: Openness | undefined;
  approvals: Approval[];
  flights: Flight[];
  agents: Array<AgentId & { flights: number }>;
  ledger: LedgerRow[];
  chain: { ok: boolean; rows: number; at?: number };
  daily?: { used: number; cap: number } | undefined;
  counters: { writes: number; refusals: number; cards: number };
  ledgerPath: string;
}

export function loadSeeds(venues: VenueSet = "classic"): Seeds {
  const base = JSON.parse(readFileSync(join(FIXTURES, "accounts.json"), "utf8")) as Seeds;
  if (venues === "classic") return base;
  const f = JSON.parse(readFileSync(join(FIXTURES, "frontline.json"), "utf8")) as { alpaca: AlpacaSeed; hyperliquid: HyperliquidSeed; okx: Partial<OkxSeed>; metamask: { allowlistAdd: string[]; holdingsAdd: MetamaskSimSeed["holdings"] } };
  return { ...base, alpaca: f.alpaca, hyperliquid: f.hyperliquid, okx: { ...base.okx, ...f.okx }, metamask: { ...base.metamask, allowlist: [...base.metamask.allowlist, ...f.metamask.allowlistAdd], holdings: [...base.metamask.holdings, ...f.metamask.holdingsAdd] } };
}

/** the venues the user has and has not plugged in: the simulated exchange side of each */
export function loadConnectable(): Record<string, PlugSeed> {
  const { note: _note, ...venues } = JSON.parse(readFileSync(join(FIXTURES, "connectable.json"), "utf8")) as Record<string, unknown>;
  return venues as Record<string, PlugSeed>;
}

export function loadOpenness(): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, "openness.json"), "utf8"));
}

export class PortfolioService {
  private adapters = new Map<string, AccountAdapter>();
  private openness: Openness;
  private ledger: Ledger;
  private approvals: Approval[] = [];
  private seq = 0;
  readonly flights: Flight[] = [];
  private flightSeq = 0;
  readonly counters = { writes: 0, refusals: 0, cards: 0 };
  readonly now: () => string;
  readonly live: boolean;
  /** the account layer, when it is mounted */
  readonly account: AccountEngine | undefined;
  /** what the agents remember, kept with the account layer (account/memory.ts): the conversation, their notes, the owner's About you */
  readonly memory: MemoryStore | undefined;
  /** the simulated payees an agent's payment can reach (x402, MPP, ACP, AP2), mounted with the account layer */
  readonly payees: PayeeWorld | undefined;
  /** the page's scripted agent, when a server has one: the owner talks to it through a signed instruction */
  sayHandler: ((text: string) => Promise<unknown>) | undefined;
  /** told when the owner connects or disconnects a venue: the server takes a net worth snapshot then (account/networth.ts) */
  onConnection: ((e: NonNullable<NetWorthSnapshot["event"]>) => void) | undefined;
  /** how far the simulated clock has been pushed ahead of the one the service was given */
  private skewMs = 0;
  /** venues the owner can plug into the account, by id */
  private catalog: Record<string, PlugSeed> = {};
  /** the simulated wallet's own allowlist: the hub sends only to what is on it */
  private walletAllow: string[] = [];
  /** a simulated venue whose place a live connection has taken: it comes back when the live one is unplugged */
  private readonly shadowed = new Map<string, AccountAdapter>();
  /** what real money can be asked of each venue connected live, and how */
  private readonly liveVenues = new Map<string, LiveVenue>();
  /** each venue connected live that has earn products (live/earn.ts), and how they are reached */
  private readonly earners = new Map<string, LiveEarner>();
  /** wallets that proved an address is the user's, by signing the sentence the account wrote */
  readonly proofs: WalletProofs;
  /** a real account restarted: what it brought back from its ledgers, and the restore still under way (venues connecting again) */
  restored: RestoreReport | undefined;
  restoring: Promise<void> | undefined;
  /** the venues of a restarted account are being connected again: what they hold is not on the account yet */
  private reconnecting = false;

  private constructor(
    private readonly opts: ServiceOptions,
    private readonly seeds: Seeds,
    /** the accounts that read the real `mm` CLI (`--mm`): the MetaMask wallet and its Polymarket deposit wallet */
    private readonly liveAccounts: { metamask: AccountAdapter; polymarket: AccountAdapter } | undefined,
  ) {
    // the adapters and the ledger keep this one function: with no skew it answers exactly what the given clock answers
    const base = opts.now ?? (() => new Date().toISOString());
    this.now = () => (this.skewMs === 0 ? base() : new Date(Date.parse(base()) + this.skewMs).toISOString());
    this.live = liveAccounts !== undefined;
    this.proofs = opts.liveDeps?.proofs ?? new WalletProofs(opts.liveDeps?.clock);
    this.openness = parseOpenness(opts.openness ?? loadOpenness());
    // real money starts Guard: every move an agent asks for waits for the owner until the owner signs the dial open
    if (opts.real) this.openness = { ...this.openness, mode: "guard" };
    this.ledger = this.openLedger();
    this.mount();
    this.memory = opts.account !== undefined || opts.venues === "frontline" ? new MemoryStore(join(opts.home, "memory"), () => Date.parse(this.now())) : undefined;
    this.account = opts.account !== undefined || opts.venues === "frontline" ? new AccountEngine(this.host(), opts.account ?? {}) : undefined;
    if (this.account) this.catalog = opts.connectable ?? loadConnectable();
    // the payees are simulated hosts: a real account has none. A real account pays real ones, from agent wallets (account/pay-real.ts)
    this.payees = this.account && !opts.real ? mountPayees(this.account) : undefined;
    if (this.account && opts.real && opts.liveWrites) this.account.usePayer(new RealPayer(this.account, { http: opts.payHttp ?? guardedHttp, chain: this.liveDeps().chain, wallet: (name) => agentWalletKey(opts.home, name), clock: () => this.liveDeps().clock(), capUsd: () => opts.liveWrites?.capUsd ?? 0 }));
    if (this.account && !opts.freshLedger) this.rememberNonces(this.account);
  }

  /** A signature outlives the process that first saw it. On start, every signed envelope in this home's ledgers has its nonce marked used again,
   * so an instruction — or an approval the owner has since revoked — cannot be replayed into a freshly started, empty account. Each nonce is
   * remembered exactly (it refuses its own reuse and nothing else), so a row that was tampered with can make the account refuse more, never
   * less, and cannot lock a signer out. (A scripted run that asks for a fresh ledger declares it starts from nothing.) */
  private rememberNonces(engine: AccountEngine): void {
    const dir = join(this.opts.home, "portfolio");
    for (const name of existsSync(dir) ? readdirSync(dir).sort() : []) {
      if (!/^ledger-.*\.jsonl$/.test(name)) continue;
      for (const row of new Ledger(join(dir, name), this.now).all()) if (row.signer && row.envelope) engine.recall(row.signer, row.envelope as Envelope);
    }
  }

  /** what the account layer may use of the service: the venues, the dial, the flight board, the ledger. A real account sees only the venues
   * connected live: the simulated ones stay on the statement page */
  private host(): ConstructorParameters<typeof AccountEngine>[0] {
    const real = this.opts.real === true;
    const shown = (a: AccountAdapter | undefined) => (!real || a?.account.watchOnly ? a : undefined);
    return {
      real,
      now: () => this.now(),
      adapter: (id) => shown(this.adapters.get(id)),
      accounts: () => this.accounts().filter((a) => !real || a.watchOnly),
      views: async () => (await this.views()).filter((v) => !real || v.watchOnly),
      policy: () => this.openness,
      dailyOutUsd: (now) => this.dailyOutUsd(now),
      log: (row) => void this.ledger.append(unaddressedRow(row)),
      openFlight: (agent, request) => this.openFlight(agent, request),
      say: (no, text, mark = "note", extra = {}) => {
        const f = this.flight(no);
        if (!f) return;
        const leg = this.note(f, text, mark);
        if (extra.usd !== undefined) leg.usd = extra.usd;
        if (extra.approvalId !== undefined) leg.approvalId = extra.approvalId;
        if (extra.account !== undefined) leg.account = extra.account;
      },
      raiseCard: (no, c) => {
        const now = this.now();
        const approval: Approval = { id: `card-${String(++this.seq).padStart(4, "0")}`, at: now, account: c.account, intent: c.intent, usd: c.usd, reason: c.reason, status: "pending", why: c.why, flight: no, action: c.action, actionHash: c.actionHash, signer: c.signer, expiresAt: c.expiresAt, ...(c.offer ? { offer: c.offer } : {}), ...(c.approval ? { approval: c.approval } : {}) };
        this.approvals.unshift(approval);
        this.counters.cards++;
        const f = this.flight(no);
        this.ledger.append({ kind: "card", venue: c.account, intentId: approval.id, tool: c.action.type, outcome: "pending", reason: c.reason, notionalUsd: c.usd, flight: no, ...(f ? { agent: f.agent.id } : {}) });
        if (f) f.legs.push({ seq: f.legs.length + 1, mark: "wait", text: `${describeIntent(c.intent)}: ${waitWords(c.why)}`, account: c.account, intent: c.intent, usd: c.usd, approvalId: approval.id });
        return approval;
      },
      card: (id) => this.approvals.find((x) => x.id === id),
      cards: () => this.approvals,
      execute: async (accountId, intent, agent, signer) => {
        const r = await this.execute(accountId, intent, agent);
        // a card this raised remembers which agent key asked for it: it is answered only while that key stands
        if (signer && isPending(r)) r.approval.signer = signer;
        return r;
      },
      order: async (base, side, qty, agent, signer) => {
        const r = await this.order(base, side, qty, agent);
        // the card a routed order raised remembers which agent key asked for it, as an executed intent's does
        if (signer) for (const o of r.outcomes) if (isPending(o)) o.approval.signer = signer;
        return { flight: r.flight.no, legs: r.flight.legs.map((l) => `${l.mark === "ok" ? "✓" : l.mark === "no" ? "✗" : l.mark === "wait" ? "▣" : "·"} ${l.text}`), outcomes: r.outcomes };
      },
      decide: (id, decision) => this.decide(id, decision),
      closeCard: (id, status, note, outcome) => {
        const ap = this.approvals.find((x) => x.id === id);
        if (!ap) return;
        ap.status = status;
        ap.decidedAt = this.now();
        if (outcome !== undefined) ap.outcome = outcome;
        const f = this.flight(ap.flight);
        this.ledger.append({ kind: "card", venue: ap.account, intentId: ap.id, outcome: status, reason: note || ap.reason, notionalUsd: ap.usd, flight: ap.flight, ...(f ? { agent: f.agent.id } : {}) });
        if (f && note) this.note(f, note, "no");
      },
      widen: async (change, value) => {
        if (change === "say") {
          if (!this.sayHandler) return no("E_ACCOUNT_BAD_ACTION", { message: "no page agent is listening on this service" });
          return { ok: true, summary: `the owner told the page's agent: ${value.slice(0, 80)}`, data: await this.sayHandler(value) };
        }
        // a real account keeps the real clock, and its connections and payments are not the simulation's to wipe
        if (real && (change === "advance" || change === "reset")) return no("E_ACCOUNT_BAD_ACTION", { message: change === "reset" ? "this server holds your real accounts: it is not reset from here (restart it for a fresh one, and connect the accounts again)" : "this account runs on the real clock: nothing here is simulated" });
        if (change === "advance") {
          const minutes = Number(value);
          if (!(minutes > 0) || minutes > 60 * 24 * 30) return no("E_ACCOUNT_BAD_ACTION", { message: "the simulated clock moves ahead by 1 minute to 30 days" });
          return { ok: true, summary: `simulated clock +${minutes} min`, data: { now: await this.advance(minutes * 60_000) } };
        }
        if (change === "mode" && value === "open") {
          this.setMode("open");
          return { ok: true, summary: "Beast: agents trade and move inside their limits without asking" };
        }
        if (change === "maxLeverage") {
          // the most leverage an agent may set on a perpetual: widening, so it is the owner's to sign
          const lev = Number(value);
          if (!/^\d{1,3}$/.test(value) || !(lev >= 1)) return no("E_ACCOUNT_BAD_ACTION", { message: "the agents' leverage cap is a whole number, 1 or more" });
          this.openness = { ...this.openness, maxLeverage: lev };
          this.ledger.append({ kind: "note", venue: "*", reason: `agents may set leverage up to ${lev}x`, detail: this.dialNow() });
          return { ok: true, summary: `agents may set leverage up to ${lev}x` };
        }
        if (change === "session") {
          // a new session for the agents: thirty days from now. Widening, so it is the owner's to sign
          this.openness = { ...this.openness, sessionExpiresAt: new Date(Date.parse(this.now()) + 30 * 86_400_000).toISOString() };
          this.ledger.append({ kind: "note", venue: "*", reason: `a new session for the agents, until ${this.openness.sessionExpiresAt}`, detail: this.dialNow() });
          // the day as the page writes dates (New York, no year); the exact moment is the dial's, on the account page
          return { ok: true, summary: `agents may act again, until ${nyDay(this.openness.sessionExpiresAt)}` };
        }
        if (change === "restore") {
          const r = this.restore(value);
          return isRefusal(r) ? r : { ok: true, summary: `${this.nameOf(value)} is open to the agent again` };
        }
        if (change === "reach") {
          const [account, caps] = value.split(":");
          const r = this.setReach(account ?? "", (caps ?? "").split(",").filter(Boolean) as Capability[]);
          return isRefusal(r) ? r : { ok: true, summary: `reach at ${this.nameOf(account ?? "")} → ${r.reach.join(", ")}` };
        }
        if (change === "reset") {
          this.reset();
          return { ok: true, summary: "the simulation was reset" };
        }
        return no("E_ACCOUNT_BAD_ACTION", { message: `"${change}" is not a policy change the owner signs here` });
      },
      // a venue connected or disconnected is said to whoever keeps the net worth curve: the total moves, and that is not a gain or a loss
      connect: async (venue, connector, label, credentialRef) => {
        const r = connector.startsWith("live:") ? await this.plugLive(venue, connector, label, credentialRef) : this.plugIn(venue, connector, label, credentialRef);
        // connected by the owner: a restore still waiting to bring it back has nothing left to do
        if (!isRefusal(r)) this.stopComingBack(venue, true);
        if (!isRefusal(r)) this.onConnection?.({ kind: "connect", venue, name: this.nameOf(venue) });
        return r;
      },
      disconnect: (venue) => {
        const name = this.nameOf(venue);
        const r = this.unplug(venue);
        if (!isRefusal(r)) this.onConnection?.({ kind: "disconnect", venue, name });
        return r;
      },
      live: () => ({ ...liveOptions(this.opts.home), writes: this.liveWritesView() }),
      liveMoney: () => {
        // the doors (orders, earn) and the reads keep ONE hold per venue: what holds a venue's reads back holds its doors' asks, and a refusal
        // a door met holds its reads — the later of the two ends it, as for every read (ReadCache.hold)
        const money = {
          writes: () => this.liveWritesView(),
          venue: (id: string) => (this.adapters.get(id)?.account.watchOnly ? this.liveVenues.get(id) : undefined),
          realNow: () => this.liveDeps().clock(),
          held: (venue: string): Refusal | undefined => this.marketReads.heldOf(venue),
          // mm reaches several venues (its swaps, Polymarket, Hyperliquid): a door's refusal at one of them holds the connection only when it
          // is mm's own (not installed, signed out) — one place rule must not freeze the others
          hold: (venue: string, r: Refusal): void => void ((this.adapters.get(venue)?.account.connector !== "live:metamask" || connectionWide(r)) && this.marketReads.hold(venue, r)),
          // a venue still waiting to come back after the restart: why (restoreWaiting) — its open orders are not "unfollowed" meanwhile
          waiting: (venue: string): string | undefined => this.restoreWaiting(venue),
        };
        return money;
      },
      liveEarn: () => ({ earner: (id) => (this.adapters.get(id)?.account.watchOnly ? this.earners.get(id) : undefined) }),
      venueVerdict: (venue) => {
        // the venue an agent names, as the connection the owner would make for it: an exchange by its own id, or a kind (a venue traded
        // through its -trade connection when there is one: Hyperliquid, Polymarket)
        // only an answer asked in the last ten minutes refuses at the door — counted from when the venue was asked, not from when the list
        // was put together (a rebuilt list reuses answers it kept): an older one may be of another network (a laptop moves), and then the
        // owner is asked, and the venue's own answer decides when they connect. The list takes each connection's newest answer as it comes
        const now = this.liveDeps().clock();
        const fresh = (connector: string): VenueHere | undefined => {
          const x = this.venuesKept?.v.find((y) => y.connector === connector);
          return x?.asked !== undefined && now - Date.parse(x.asked) < 600_000 ? x : undefined;
        };
        const main = fresh(`live:exchange:${venue}`) ?? fresh(`live:${venue}-trade`);
        const plain = fresh(`live:${venue}`);
        const shut = (x: VenueHere): boolean => x.verdict === "not-served" || x.verdict === "closed";
        // the trading connection refuses this network or offers no way in, and the venue read by its address does not: the ask goes to the
        // owner, for the connection that is open (Hyperliquid or Polymarket watched by its address, read only)
        if (main && plain && shut(main) && !shut(plain)) return { name: plain.name, verdict: plain.verdict, said: `${main.name} ${main.verdict === "not-served" ? "does not serve the network this account runs on" : "offers no way in for this account"}; ${plain.name} can be connected by its address, read only` };
        const v = main ?? plain;
        // an edition is asked for by its venue id, as the agent names venues: the exchange's own id, or the connection's kind
        const edition = v?.edition ? { venue: v.edition.connector.replace(/^live:(exchange:)?/, ""), name: v.edition.name } : undefined;
        return v ? { name: v.name, verdict: v.verdict, ...(v.said ? { said: v.said } : {}), ...(edition ? { edition } : {}) } : undefined;
      },
      pairingCode: () => this.opts.liveWrites?.pairingCode ?? this.opts.pairingCode,
      memory: () => this.memory,
      ...(real && this.opts.liveWrites
        ? {
            agentWalletAddress: (name: string) => {
              const k = agentWalletKey(this.opts.home, name);
              return isRefusal(k) ? k : (k.address as Hex);
            },
            agentWalletUp: (sub: SubAccount) => this.plugAgentWallet(sub),
          }
        : {}),
      connectable: () =>
        Object.entries(real ? {} : this.catalog)
          .filter(([id]) => !this.adapters.has(id))
          .map(([id, v]) => ({ id, name: v.name, connector: v.connector, via: isSelfCustody(v) ? "A self-custody wallet · by its address" : (EXCHANGES[v.connector]?.label ?? v.connector), credential: isSelfCustody(v) ? "no key: its address" : (EXCHANGES[v.connector]?.credential ?? "API key"), credentialRef: isSelfCustody(v) ? v.address : `home/credentials/${id}/api-key.json`, asks: isSelfCustody(v) ? "the chain: the address can be read and sent to, and nothing leaves it without your signature in that wallet" : (EXCHANGES[v.connector]?.probe ?? "what the key may do") })),
    };
  }

  /** Plug in a venue the owner already has. No code names it: the connector says how it is spoken to, the venue's own answer about the credential
   * says what may be done there, and the account's doors for it are compiled from that answer. */
  private plugIn(venue: string, connector: string, label: string, credentialRef: string): Refusal | { ok: true; summary: string; native?: unknown } {
    if (this.opts.real) return no("E_ACCOUNT_BAD_ACTION", { venue, message: `this account connects real venues only, through their own interfaces: "${connector}" is a simulated connector` });
    if (this.adapters.has(venue)) return no("E_ACCOUNT_BAD_ACTION", { venue, message: `${this.nameOf(venue)} is already on the account` });
    const seed = this.catalog[venue];
    if (!seed) return no("E_WALLET_ACCOUNT_UNKNOWN", { venue, message: `nothing answers as "${venue}" with that credential; what can be plugged in: ${Object.keys(this.catalog).join(", ") || "nothing"}`, detail: { connectable: Object.keys(this.catalog) } });
    if (seed.connector !== connector) return no("E_VENUE_REJECTED", { venue, message: `${seed.name} did not answer through "${connector}": it is reached through "${seed.connector}"`, detail: { connector: seed.connector } });
    const name = label.trim().slice(0, 40) || seed.name;
    const { adapter, probe } = plug(venue, { ...seed, name }, credentialRef.trim().slice(0, 120) || `home/credentials/${venue}/api-key.json`);
    this.adapters.set(venue, adapter);
    // the hub sends only to destinations on the wallet's own allowlist. In the simulation the owner's signature on this action adds the venue's
    // deposit destination to it; a real wallet's policy is the wallet's, and the owner adds it there
    const destination = adapter.account.address ?? venue;
    if (!this.live && !this.walletAllow.includes(destination)) this.walletAllow.push(destination);
    const door = doorOf(adapter.account);
    const who = (x: string | undefined) => (x === "agent" ? "an agent's key may" : x === "owner" ? "yours to sign" : x === "venue" ? "only at the venue itself" : "closed");
    const said = isSelfCustody(seed) ? `${name} plugged in by its address · ${probe.note}` : `${name} plugged in · the venue says this credential can ${probe.can.join(", ")} · ${probe.note}`;
    return { ok: true, summary: `${said} · money in: ${who(door.in[0]?.access)}; money out: ${who(door.out[0]?.access)}${this.live ? " · add its deposit address to the wallet's own allowlist before sending there" : ""}`, native: { connector, probe: probe.native } };
  }

  private liveWritesView(): { on: boolean; capUsd: number; turnOn: string } {
    return { on: this.opts.liveWrites !== undefined, capUsd: this.opts.liveWrites?.capUsd ?? 0, turnOn: "npm run account" };
  }

  /** what a venue connected live trades: a few markets, or the ones matching a query (a minute old at most) */
  async liveMarkets(venue: string, query: string): Promise<Market[] | Refusal> {
    const v = this.tradingVenue(venue);
    return isRefusal(v) ? v : this.kept(v).markets(query);
  }

  /** what is held at a venue connected live, fifteen seconds old at most (the page asks often; the venue is asked once) */
  async livePositions(venue: string): Promise<Position[] | Refusal> {
    if (!this.account) return no("E_ACCOUNT_BAD_ACTION", { message: "the account layer is not mounted" });
    const engine = this.account;
    // the mm connection's positions hold nothing else of it (kept)
    const at = this.adapters.get(venue)?.account.connector === "live:metamask" ? `${venue}#positions` : venue;
    return this.marketReads.get(`positions|${venue}`, 15_000, () => engine.trade.positions(venue).catch((err: unknown) => thrownBy(venue, this.nameOf(venue), err)), this.liveVenues.has(venue) ? at : undefined);
  }

  /** one market at a venue connected live, with a price a few seconds old at most. An order itself is always valued at a fresh one */
  async liveMarket(venue: string, symbol: string): Promise<Market | Refusal> {
    const v = this.tradingVenue(venue);
    return isRefusal(v) ? v : this.kept(v).market(symbol);
  }
  /** The same thing at every venue connected live that trades it — a coin, a stock — ranked by the price an order would take there (the ask
   * for a buy, the bid for a sell). Kept fifteen seconds. A price far from the others' (more than 10% from their middle) is marked: it may be
   * another token under the same name. `asset` says which is meant where a name is both a coin and a stock */
  async liveCompare(base: string, side: "buy" | "sell", usd?: number, asset?: "crypto" | "stock"): Promise<Comparison | Refusal> {
    const b = base.trim();
    if (!b || b.length > 40) return no("E_ACCOUNT_BAD_ACTION", { message: "name what to compare: BTC, ETH, AAPL" });
    if (side !== "buy" && side !== "sell") return no("E_ACCOUNT_BAD_ACTION", { message: "compare a buy or a sell" });
    // each venue's reads go through the same short-lived cache as the order ticket's: a new amount or the other side asks no venue again.
    // A venue whose own place rule bars an order from this network says so on its row (placeRuleOf)
    const venues = this.tradingVenues().map((v) => ({ id: v.id, name: v.name, trader: this.kept(v), connector: this.adapters.get(v.id)?.account.connector }));
    return this.marketReads.get(`compare|${b.toUpperCase()}|${side}|${usd ?? ""}|${asset ?? ""}`, 15_000, async () => {
      const placed = await Promise.all(venues.map(async ({ connector, ...v }) => ({ ...v, ...(await this.placed(connector)) })));
      return compareAcross(placed, b, side, { timeoutMs: 4_000, ...(usd !== undefined ? { usd } : {}), ...(asset ? { asset } : {}) });
    });
  }

  /** A trading connection's own place rule for the network the account runs on — Hyperliquid's line, Polymarket's blocked or close-only —
   * as the list of where the user can connect judged it in the last ten minutes, or as the connection's keyless question answers now
   * (waited for two seconds at most: its answer is kept for the next time). What the comparison and Markets mark the venue's rows with;
   * the rule's own words, never the place or an address. A rule the venue's terms state (terms-exclude) is shown, not applied, and an
   * unknown place or no answer is no rule */
  private async placed(connector: string | undefined): Promise<{ place?: PlaceRule }> {
    if (connector !== "live:hyperliquid-trade" && connector !== "live:polymarket-trade") return {};
    const kept = this.venuesKept?.v.find((x) => x.connector === connector);
    let rule: { verdict: string; said?: string | undefined } | undefined = kept?.asked !== undefined && this.liveDeps().clock() - Date.parse(kept.asked) < 600_000 ? kept : undefined;
    if (!rule) {
      let t: ReturnType<typeof setTimeout> | undefined;
      const r = await Promise.race([this.connectReach([connector]).then(([x]) => x), new Promise<undefined>((go) => (t = setTimeout(() => go(undefined), 2_000)))]).finally(() => clearTimeout(t));
      rule = r ? verdictOf(r, undefined, "key-file") : undefined;
    }
    const words = unaddressed(rule?.said ?? "");
    if (rule?.verdict === "not-served" || rule?.verdict === "closed") return { place: { rule: "closed", words } };
    if (rule?.verdict === "close-only") return { place: { rule: "close-only", words } };
    return {};
  }

  /** the order ticket's reads, kept for a moment and shared while they are in flight: a page (or anything else on this machine) asking
   * again and again costs the venue one request, not one each — the venue's rate limit is for the orders */
  private readonly marketReads = new ReadCache();

  /** a venue connected live that orders are placed through, or why it is not one */
  private tradingVenue(venue: string): LiveVenue | Refusal {
    const v = this.adapters.get(venue)?.account.watchOnly ? this.liveVenues.get(venue) : undefined;
    if (!v) return no("E_WALLET_ACCOUNT_UNKNOWN", { venue, message: `"${venue}" is not a venue connected live` });
    if (!v.trader) return no("E_VENUE_RAIL_CLOSED", { venue, message: `${v.name}: ${v.noTradeBecause ?? "no orders are placed here from the account"}` });
    return v;
  }

  /** every venue connected live that orders are placed through */
  private tradingVenues(): LiveVenue[] {
    return [...this.liveVenues.values()].filter((v) => v.trader && this.adapters.get(v.id)?.account.watchOnly);
  }

  /** A venue's trader as every read here asks it: each answer kept a while (a market's price three seconds; its listings, its 24 hours and
   * its price history a minute; its events five), at most two of its reads on their way at once, and how it answered remembered for the
   * venue's health. A trader that throws has answered in a way the account cannot read: that is a refusal like any other (held back as a
   * venue that did not answer), never an exception that takes a whole read down. Orders never pass through this: they are the account's
   * door's (account/live-orders.ts) */
  private kept(v: LiveVenue): LiveTrader {
    const t = v.trader!;
    const c = this.marketReads;
    const id = v.id;
    // the trader's reads also wait out a hold of a party that answers for the trader (LI.FI, for a wallet's swaps); the venue's other reads
    // (what it holds, its deposit address, its earn) do not
    // the mm connection reaches several venues (swaps, Polymarket, perpetuals): each read is held under the one it asks (mmInner), and only
    // what is mm's own (mm not running, signed out) holds them all; its listings and positions hold nothing else either
    const mm = this.adapters.get(id)?.account.connector === "live:metamask";
    const inner = (part: string | undefined): string => (mm ? `${id}#${part ?? "markets"}` : id);
    const read = <T>(key: string, ttlMs: number, load: () => Promise<T | Refusal>, at = id): Promise<T | Refusal> => c.get(key, ttlMs, () => load().catch((err: unknown) => thrownBy(id, v.name, err)), at, true);
    return Object.assign(Object.create(t) as LiveTrader, {
      markets: (q: string) => read(`markets|${id}|${q.trim().toUpperCase()}`, 60_000, () => t.markets(q), inner("markets")),
      market: (sym: string) => read(`market|${id}|${sym}`, 3_000, () => t.market(sym), inner(mmInner(sym))),
      ...(t.stats ? { stats: (symbols?: string[]) => read(`stats|${id}|${symbols ? [...symbols].sort().join(",") : ""}`, 60_000, () => t.stats!(symbols), inner("markets")) } : {}),
      ...(t.events ? { events: (o: { category?: string | undefined; closingWithinMs?: number | undefined; limit: number }) => read(`events|${id}|${o.category ?? ""}|${o.closingWithinMs ?? ""}|${o.limit}`, 300_000, () => t.events!(o), inner("predict")) } : {}),
      ...(t.candles ? { candles: (sym: string, interval: CandleInterval, sinceMs: number) => read(`candles|${id}|${sym}|${interval}`, 60_000, () => t.candles!(sym, interval, sinceMs), inner(mmInner(sym))) } : {}),
    });
  }

  /** A keyless public source as Markets, the Portfolio's 24 hours and the Market sheet read it: through the same cache as a venue's reads,
   * under the source's id — so an answer on its way is shared, a source that refuses this location (451), rate-limits this machine (429)
   * or does not answer is not asked again for the keep (a geoblock holds it back ten minutes), and a throw is a refusal. The source's own
   * keeping of the bodies it downloads (live/public-markets.ts) sits under this. Its holds, kept answers and health are under a name of its
   * own (`public:okx`), apart from a venue connected with a key under the same id: a keyless refusal neither holds that connection back nor
   * stands for its health — save a ban of this machine's address, which covers both */
  private keptPublic(s: PublicSource): PublicSource {
    const c = this.marketReads;
    const id = s.id;
    const ns = `public:${id}`;
    const read = <T>(key: string, ttlMs: number, load: () => Promise<T | Refusal>, venue = ns): Promise<T | Refusal> => c.get(key, ttlMs, () => load().catch((err: unknown) => thrownBy(id, s.name, err)), venue);
    // a source whose price history comes from another host than its listings (Polymarket's CLOB, beside Gamma): a refusal of the history
    // holds back the history alone
    const history = s.historyApart ? `${ns}#history` : ns;
    this.publicRaw.set(ns, s);
    return {
      ...s,
      listings: (o) => read(`public-listings|${ns}|${(o.q ?? "").trim().toUpperCase()}|${o.limit}`, PUBLIC_KEEP_MS, () => s.listings(o)),
      ...(s.stats ? { stats: (symbols?: string[]) => read(`public-stats|${ns}|${symbols ? [...symbols].sort().join(",") : ""}`, PUBLIC_KEEP_MS, () => s.stats!(symbols)) } : {}),
      ...(s.events ? { events: (o: { category?: string | undefined; closingWithinMs?: number | undefined; limit: number }) => read(`public-events|${ns}|${o.category ?? ""}|${o.closingWithinMs ?? ""}|${o.limit}`, PUBLIC_KEEP_MS, () => s.events!(o)) } : {}),
      ...(s.candles ? { candles: (sym: string, interval: CandleInterval, sinceMs: number) => read(`public-candles|${history}|${sym}|${interval}`, 60_000, () => s.candles!(sym, interval, sinceMs), history) } : {}),
    };
  }
  /** each keyless source as it was made, by its name in the read cache: what a re-check that finds its venue answering again tells it */
  private readonly publicRaw = new Map<string, PublicSource>();

  // ---- the wallet: what you own (Portfolio), what there is to trade (Markets), what can be sold (Trade) --------------------------------

  /** how each venue connected live has answered the account's reads lately: when it last answered, when it last failed and in its own
   * words, how long its last read took. A venue not read since it was connected has no entry yet */
  venueHealth(): Record<string, VenueHealth> {
    const out: Record<string, VenueHealth> = {};
    for (const id of this.liveVenues.keys()) {
      const h = this.adapters.get(id)?.account.watchOnly ? this.marketReads.healthOf(id) : undefined;
      if (h) out[id] = h;
    }
    return out;
  }

  /** the real clock: what venues, public markets and the net worth curve are timed by (a stand-in's in tests) */
  private realNow(): number {
    return (this.opts.liveDeps?.clock ?? Date.now)();
  }

  private publicMade: PublicSource[] | undefined;
  /** the keyless public sources, made once and kept (what each keeps — its answers for a while, its exchange client — lives in it), each
   * read through the account's own cache (`keptPublic`) */
  private publicMarkets(): PublicSource[] {
    if (!this.publicMade) {
      const deps = this.liveDeps();
      this.publicMade = (this.opts.publicMarkets ?? publicSources({ http: deps.http, open: deps.openExchange, clock: deps.clock })).map((s) => this.keptPublic(s));
    }
    return this.publicMade;
  }

  /** MARKETS: everything there is to trade — what the connected venues list, and what the venues not connected publish without a key
   * (marked "Connect to trade") — as one list, with its tabs, its movers, what closes soon and what trades most (live/explore.ts). A public
   * source is left out when its venue is connected: the connected venue speaks for itself. Robinhood's Stock Tokens, which no connection
   * trades, are always read. The same question is answered from what was found for thirty seconds; each venue's reads are kept as `kept`
   * keeps them. Nothing is ordered or signed */
  async explore(o: { tab?: string | undefined; q?: string | undefined; sort?: string | undefined; limit?: number | undefined } = {}): Promise<Exploration | Refusal> {
    if (!this.account) return no("E_ACCOUNT_BAD_ACTION", { message: "the account layer is not mounted" });
    const tab = o.tab?.trim() || undefined;
    if (tab !== undefined && !TABS.some((t) => t.id === tab)) return no("E_ACCOUNT_BAD_ACTION", { message: `a tab is one of ${TABS.map((t) => t.id).join(", ")}` });
    const sort = o.sort?.trim() || undefined;
    if (sort !== undefined && !EXPLORE_SORTS.includes(sort as ExploreSort)) return no("E_ACCOUNT_BAD_ACTION", { message: `markets are sorted by ${EXPLORE_SORTS.join(", ")}` });
    const q = (o.q ?? "").trim();
    if (q.length > 60) return no("E_ACCOUNT_BAD_ACTION", { message: "a search is at most 60 characters" });
    const limit = o.limit === undefined ? 60 : Math.floor(o.limit);
    if (!(limit >= 1 && limit <= 200)) return no("E_ACCOUNT_BAD_ACTION", { message: "a limit is 1 to 200 markets" });
    // each connected venue with the connection it was made with: exploreAcross leaves out the public source that connection speaks for
    // and its own place rule for this network, where it has one that bars an order from here (placed)
    const connected: ExploreVenue[] = this.tradingVenues().map((v) => {
      const connector = this.adapters.get(v.id)?.account.connector;
      return { id: v.id, name: v.name, trader: this.kept(v), ...(connector ? { connector } : {}) };
    });
    return this.marketReads.get(`explore|${tab ?? ""}|${q.toUpperCase()}|${sort ?? ""}|${limit}`, 30_000, async () => {
      const placed = await Promise.all(connected.map(async (v) => ({ ...v, ...(await this.placed(v.connector)) })));
      return exploreAcross({ connected: placed, public: this.publicMarkets() }, { q, limit, clock: () => this.realNow(), ...(tab ? { tab: tab as TabId } : {}), ...(sort ? { sort: sort as ExploreSort } : {}) });
    });
  }

  /** PORTFOLIO: what the account holds, by asset across every venue (account/holdings.ts), the dollars that are ready and where they can go,
   * and what the holdings did in the last 24 hours — each coin's and share's own 24-hour change as a venue reports it (the connected
   * venues' first, then the exchanges' public tickers), never estimated: what no venue reports is `missing`. `cost`: also what was paid for
   * what is held (account/costbasis.ts), from the account's own orders and each venue's positions */
  async holdings(opts: { cost?: boolean | undefined } = {}): Promise<HoldingsView | Refusal> {
    const h = await this.held(opts);
    return isRefusal(h) ? h : h.view;
  }

  private async held(opts: { cost?: boolean | undefined }): Promise<{ view: HoldingsView; page: AccountPage } | Refusal> {
    const page = await this.accountView();
    if (!page) return no("E_ACCOUNT_BAD_ACTION", { message: "the account layer is not mounted" });
    const { rows, money } = byAsset(page.venues, { writes: page.connectLive?.writes?.on === true });
    const [day, pos] = await Promise.all([this.dayStats(rows), opts.cost ? this.allPositions() : undefined]);
    const held: HeldRow[] = rows.map((r) => {
      const s = day.stats.get(r.key);
      const pct = s ? pctOf(s) : undefined;
      return pct === undefined || !s ? r : { ...r, changePct24h: Number(pct.toFixed(4)), changeFrom: { venue: s.venue, venueName: s.venueName } };
    });
    const view: HoldingsView = { asOf: page.now, totalUsd: page.totalUsd, rows: held, money, change24h: change24h(rows, day.stats), missing: day.missing };
    if (pos && !isRefusal(pos)) {
      view.positions = pos.positions;
      // money in an earn product was not bought: what was paid is its asset's own row's
      view.cost = costBasis(this.allOrders(), rows.filter((r) => r.class !== "earn"), pos.positions);
      view.missing = [...view.missing, ...pos.missing];
    }
    return { view, page };
  }

  /** Each held coin's and share's last 24 hours, as a venue reports them: the connected venues' well-known markets first, then the shares
   * still without a figure at the venues that trade shares, then the coins still without one in the exchanges' public tickers. Every source
   * has four seconds; a figure is taken only where it says a change */
  private async dayStats(rows: readonly AssetRow[]): Promise<{ stats: Map<string, MarketStats & { venue: string; venueName: string }>; missing: ReadMissing[] }> {
    const want = new Set(rows.filter((r) => r.usd > 0 && (r.class === "crypto" || r.class === "equity")).map((r) => r.key));
    // money in an earn product changes as its coin does: the coin's 24 hours are asked for too
    for (const r of rows) if (r.class === "earn" && r.usd > 0 && r.earn && !isStable(r.earn.asset)) want.add(assetKey(r.earn.asset, "crypto"));
    const stats = new Map<string, MarketStats & { venue: string; venueName: string }>();
    const missing: ReadMissing[] = [];
    if (!want.size) return { stats, missing };
    const take = (key: string | undefined, s: MarketStats | undefined, venue: string, venueName: string) => {
      if (key !== undefined && s && want.has(key) && !stats.has(key) && pctOf(s) !== undefined) stats.set(key, { ...s, venue, venueName });
    };
    const ask = async (v: { id: string; name: string }, run: () => Promise<Map<string, MarketStats> | Refusal>, keyOf: (symbol: string) => string | undefined) => {
      const got = await within(STATS_MS, run(), v.id, v.name);
      if (isRefusal(got)) return void missing.push({ venue: v.id, venueName: v.name, why: got.message, code: got.code, part: "stats" });
      for (const [symbol, s] of got) take(keyOf(symbol), s, v.id, v.name);
    };
    // a venue trades shares when its connector's kinds say so, or its trader says it in words ("US stocks and ETFs")
    const venues = this.tradingVenues().filter((v) => v.trader!.stats).map((v) => ({ v, shares: (v.trader!.kinds ?? tradeKinds(this.adapters.get(v.id)?.account.connector, v.trader!.what)).includes("stock") || /\b(stocks?|shares?|ETFs?)\b/i.test(v.trader!.what) }));
    // a pair (BTC/USDT, BTC-USD, WETH/USDC@Base) is a coin's; a bare ticker is a share's, and only at a venue that trades shares. A
    // perpetual's, a future's or an event's (with a colon) speaks for nothing held
    const statKey = (shares: boolean) => (symbol: string): string | undefined => {
      if (symbol.includes(":")) return undefined;
      if (/[/@]/.test(symbol) || /-(USD|USDT|USDC)$/i.test(symbol)) return `crypto:${normalBase(symbol, "spot")}`;
      return shares ? `equity:${symbol.toUpperCase()}` : undefined;
    };
    await Promise.all(venues.map(({ v, shares }) => ask(v, () => this.kept(v).stats!(), statKey(shares))));
    const tickers = [...want].filter((k) => k.startsWith("equity:") && !stats.has(k)).map((k) => k.slice("equity:".length)).slice(0, 40);
    if (tickers.length) await Promise.all(venues.filter((x) => x.shares).map(({ v }) => ask(v, () => this.kept(v).stats!(tickers), statKey(true))));
    const coins = [...want].filter((k) => k.startsWith("crypto:") && !stats.has(k)).map((k) => k.slice("crypto:".length));
    if (coins.length) {
      // a source's ticker call takes forty symbols at a time: the coins go in lots of thirteen (three dollar pairs each), so every held
      // coin gets its 24 hours, however many are held. Each lot is kept under the source's id (`keptPublic`), as a venue's reads are
      const lots: string[][] = [];
      for (let i = 0; i < coins.length; i += 13) lots.push(coins.slice(i, i + 13).flatMap((c) => ["USD", "USDT", "USDC"].map((q) => `${c}/${q}`)));
      const exchanges = this.publicMarkets().filter((s) => s.kind === "exchange" && s.stats);
      const got = await Promise.all(exchanges.map(async (s) => ({ s, rs: await Promise.all(lots.map((symbols) => within(STATS_MS, s.stats!(symbols), s.id, s.name))) })));
      // in the sources' own order: the first that says a change for a coin is the one shown; a source that refused is named once
      for (const { s, rs } of got) {
        let said = false;
        for (const r of rs) {
          if (isRefusal(r)) {
            if (!said) missing.push({ venue: s.id, venueName: s.name, why: r.message, code: r.code, part: "stats" });
            said = true;
          } else for (const [symbol, x] of r) take(`crypto:${normalBase(symbol, "spot")}`, x, s.id, s.name);
        }
      }
    }
    return { stats, missing };
  }

  /** every position at every venue connected live that lists them, each venue's read kept fifteen seconds and all of them asked at once;
   * a venue that could not be read is in `missing` */
  async allPositions(): Promise<{ positions: VenuePosition[]; missing: ReadMissing[] } | Refusal> {
    if (!this.account) return no("E_ACCOUNT_BAD_ACTION", { message: "the account layer is not mounted" });
    const venues = this.tradingVenues().filter((v) => v.trader!.positions);
    const got = await Promise.all(venues.map(async (v) => ({ v, r: await this.livePositions(v.id) })));
    const positions: VenuePosition[] = [];
    const missing: ReadMissing[] = [];
    for (const { v, r } of got) {
      if (isRefusal(r)) missing.push({ venue: v.id, venueName: v.name, why: r.message, code: r.code, part: "positions" });
      else positions.push(...r.map((p) => ({ ...p, venue: v.id, venueName: v.name })));
    }
    return { positions, missing };
  }

  /** EARN: the products the venues connected live offer (DeFi vaults through the MetaMask Agent Wallet's mm, OKX's Simple Earn, Kraken
   * Earn), in one asset when asked, and what the user has in them — at one venue, or at every venue that earns. Products are kept a minute
   * and what is held fifteen seconds, read through the same short-lived cache as the venues' markets; a venue that could not be read is in
   * `missing` with its own words. A read: what goes in or out is the account's earn door's (account/live-earn.ts) */
  async earn(o: { venue?: string | undefined; asset?: string | undefined } = {}): Promise<EarnView | Refusal> {
    if (!this.account) return no("E_ACCOUNT_BAD_ACTION", { message: "the account layer is not mounted" });
    const asset = o.asset?.trim().toUpperCase() ?? "";
    if (asset !== "" && !/^[A-Z0-9.]{1,20}$/.test(asset)) return no("E_ACCOUNT_BAD_ACTION", { message: "an asset is its symbol: USDC, BTC" });
    const ids = [...this.earners.keys()].filter((id) => this.adapters.get(id)?.account.watchOnly && (!o.venue || id === o.venue));
    if (o.venue && !ids.length) return no("E_VENUE_RAIL_CLOSED", { venue: o.venue, message: this.adapters.get(o.venue)?.account.watchOnly ? `${this.nameOf(o.venue)} offers no earn products to the account` : `"${o.venue}" is not a venue connected live` });
    const products: EarnView["products"] = [];
    const positions: EarnView["positions"] = [];
    const missing: ReadMissing[] = [];
    await Promise.all(ids.map(async (id) => {
      const x = this.earners.get(id)!;
      const name = this.nameOf(id);
      const c = this.marketReads;
      const [ps, held] = await Promise.all([
        within(STATS_MS * 2, c.get(`earn-products|${id}|${asset}`, 60_000, () => x.products(asset || undefined), id), id, name),
        within(STATS_MS * 2, c.get(`earn-positions|${id}`, 15_000, () => x.positions(), id), id, name),
      ]);
      if (isRefusal(ps)) missing.push({ venue: id, venueName: name, why: ps.message, code: ps.code, part: "earn" });
      else products.push(...ps.filter((p) => !asset || p.asset.toUpperCase() === asset).map((p) => ({ ...p, venue: id, venueName: name })));
      if (isRefusal(held)) missing.push({ venue: id, venueName: name, why: held.message, code: held.code, part: "earn" });
      else positions.push(...held.filter((h) => !asset || h.asset.toUpperCase() === asset || products.some((p) => p.venue === id && p.id === h.product)).map((h) => ({ ...h, venue: id, venueName: name })));
    }));
    // the highest yield first; what is held, the most dollars first
    products.sort((a, b) => (b.apy ?? -1) - (a.apy ?? -1));
    positions.sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
    const venues = ids.map((id) => {
      const x = this.earners.get(id)!;
      return { venue: id, venueName: this.nameOf(id), can: x.can, what: x.what, ...(x.whyNot ? { whyNot: x.whyNot } : {}) };
    });
    return { asOf: new Date(this.realNow()).toISOString(), venues, products, positions, missing, writes: this.liveWritesView() };
  }

  /** Where to send `asset` on `network` so that it lands at `venue`: an exchange's own deposit address, as the exchange gives it (asked of it
   * now, kept a minute); a wallet's own address, when a wallet signed to show it is the user's (or the account holds its key). A watched
   * address, or a venue the account sends nothing to, gives none */
  async receive(venue: string, asset: string, network: string): Promise<ReceiveAddress | Refusal> {
    if (!this.account) return no("E_ACCOUNT_BAD_ACTION", { message: "the account layer is not mounted" });
    const v = this.adapters.get(venue)?.account.watchOnly ? this.liveVenues.get(venue) : undefined;
    if (!v) return no("E_WALLET_ACCOUNT_UNKNOWN", { venue, message: `"${venue}" is not a venue connected live` });
    const a = asset.trim().toUpperCase();
    if (!/^[A-Z0-9.]{1,15}$/.test(a)) return no("E_ACCOUNT_BAD_ACTION", { message: "name what is to be received: USDC, USDT, ETH" });
    if (!Object.hasOwn(CHAINS, network)) return no("E_ACCOUNT_BAD_ACTION", { message: `a network is one of ${Object.keys(CHAINS).join(", ")}` });
    const chain = network as ChainName;
    const base = { venue: v.id, venueName: v.name, asset: a, network: chain };
    // a venue that is an address of the user's own: only when a wallet signed for it. A Polymarket wallet lives on Polygon alone and takes
    // pUSD, so it is not "the same on every EVM chain" (Polymarket connected by its key carries no address: its writer answers below)
    if (v.address !== undefined) {
      if (!v.proven) return no("E_ACCOUNT_DESTINATION", { venue: v.id, message: `${v.name} is watched, not proven yours: the account gives no address to send to it. Connect it again from the wallet itself` });
      if (v.kind === "prediction") {
        if (chain !== "Polygon" || a !== "PUSD") return no("E_ACCOUNT_BAD_ACTION", { venue: v.id, message: `${v.name}'s wallet lives on Polygon and holds pUSD: send pUSD on Polygon, nothing on another chain` });
        return { ...base, address: v.address, whose: v.proven, note: "the Polymarket wallet, on Polygon: pUSD only" };
      }
      return { ...base, address: v.address, whose: v.proven, note: "the wallet's own address: the same on every EVM chain" };
    }
    if (!v.writer) return no("E_VENUE_RAIL_CLOSED", { venue: v.id, message: `${v.name}: ${v.readOnlyBecause ?? "the account reads it and sends it nothing"}` });
    if (!v.writer.can.receive) return no("E_VENUE_RAIL_CLOSED", { venue: v.id, message: `${v.name} takes nothing sent from here` });
    const writer = v.writer;
    const r = await this.marketReads.get(`receive|${v.id}|${a}|${chain}`, 60_000, () => writer.depositAddress(a, chain).catch((err: unknown) => thrownBy(v.id, v.name, err)), v.id);
    if (isRefusal(r)) return r;
    // the venue's own words about sending there (a bridge's minimum, what it is credited as) travel with the address
    return { ...base, address: r.address, ...(r.tag ? { tag: r.tag } : {}), ...(r.note ? { note: r.note } : {}), whose: `${v.name}'s own deposit address, as ${v.name} gives it` };
  }

  /** One point on the net worth curve (account/networth.ts): the account page's total, by class and by venue (every venue connected, with
   * what it holds, 0 included), and which venues' numbers are stale; with `event`, the venue connected or disconnected just now. None while
   * a restart is still connecting the venues again: a venue that is not back yet is not money gone */
  async snapshot(event?: NetWorthSnapshot["event"]): Promise<{ written: boolean; at: string } | Refusal | undefined> {
    if (!this.account || this.reconnecting) return undefined;
    const page = await this.accountView();
    if (!page) return undefined;
    const byClass: Record<string, number> = {};
    const byVenue: Record<string, number> = {};
    for (const v of page.venues) {
      byVenue[v.id] = v.usd;
      for (const h of v.holdings) if (h.usd > 0) byClass[h.class] = r2((byClass[h.class] ?? 0) + h.usd);
    }
    // what the account itself has paid out to someone else, in all, from every run's statement: the curve's change adds it back
    const paidOutUsd = r2(this.statement().filter((l) => l.kind === "pay" && l.status === "settled").reduce((sum, l) => sum + Math.abs(l.amountUsd), 0));
    return this.netWorth().append({ usd: page.totalUsd, byClass, byVenue, stale: page.venues.filter((v) => v.stale).map((v) => v.id), paidOutUsd, ...(event ? { event } : {}) });
  }

  private netWorthLog: NetWorthLog | undefined;
  private netWorth(): NetWorthLog {
    return (this.netWorthLog ??= new NetWorthLog(networthPath(this.opts.home), () => this.realNow()));
  }

  /** the net worth curve over the last day (1d), week (1w) or month (1m), or all of it: one point per bucket, the connections and
   * disconnections in it, and how the holdings changed — connections left out, the account's own payments to payees added back, a venue's
   * own deposits and withdrawals in it (account/networth.ts). It starts at the first snapshot: nothing before is known */
  history(range: string): NetWorthHistory | Refusal {
    if (!this.account) return no("E_ACCOUNT_BAD_ACTION", { message: "the account layer is not mounted" });
    return this.netWorth().read(range, this.realNow());
  }

  /** One asset, as the Asset sheet shows it: its holdings row (when it is held), the same thing at every connected venue (live/compare.ts),
   * its price history at the first of them that keeps one, its positions, the account's open orders in it, its statement lines and what was
   * paid for it. `key` is a holdings key (`crypto:BTC`, `equity:AAPL`, `stable:USDC`, `event:<symbol>`); `coin:` and `stock:` are taken for
   * `crypto:` and `equity:`. A read */
  async asset(key: string, interval = "1h"): Promise<AssetDetail | Refusal> {
    const k = assetKeyOf(key);
    if (!k) return no("E_ACCOUNT_BAD_ACTION", { message: "an asset is named by its key: crypto:BTC, equity:AAPL, stable:USDC, rwa:USDY, event:<symbol>" });
    if (!(CANDLE_INTERVALS as readonly string[]).includes(interval)) return no("E_ACCOUNT_BAD_ACTION", { message: `price history is by ${CANDLE_INTERVALS.join(", ")}` });
    const h = await this.held({ cost: true });
    if (isRefusal(h)) return h;
    const row = h.view.rows.find((r) => r.key === k.key);
    const positions = (h.view.positions ?? []).filter((p) => sameThing(k, p.kind, p.symbol, p.symbol));
    const orders = h.page.orders.filter((o) => !DONE.has(o.status) && sameThing(k, o.kind, o.base, o.symbol));
    const missing: ReadMissing[] = [];
    let compare: Comparison | undefined;
    if (k.cls === "crypto" || k.cls === "equity") {
      const c = await this.liveCompare(k.name, "buy", undefined, k.cls === "equity" ? "stock" : "crypto");
      if (isRefusal(c)) missing.push({ venue: "*", venueName: "every venue", why: c.message, code: c.code, part: "compare" });
      else compare = c;
    }
    const candles = await this.candlesFor(k, interval as CandleInterval, compare, positions, row);
    if (candles.missing) missing.push(candles.missing);
    // the statement's lines about it: its orders, and for a dollar the movements of that dollar
    const keys = new Set<string>();
    const { before, now } = this.statementRows();
    for (const r of [...before, ...now]) {
      const n = (r.native ?? {}) as { order?: Partial<LiveOrder>; payment?: Partial<Payment> };
      if (n.order && typeof n.order.kind === "string" && sameThing(k, n.order.kind as MarketKind, String(n.order.base ?? ""), String(n.order.symbol ?? ""))) keys.add(r.detail.key);
      else if (n.payment && (k.cls === "stable" || k.cls === "cash") && [n.payment.token, n.payment.sourceToken].some((t) => typeof t === "string" && t.toUpperCase() === k.name)) keys.add(r.detail.key);
    }
    const lines = keys.size ? this.statement().filter((l) => keys.has(l.key)).slice(0, 50) : [];
    const held = new Set(positions.map((p) => `position:${p.venue}:${p.symbol}`));
    const cost = (h.view.cost ?? []).filter((c) => c.key === k.key || held.has(c.key));
    return { key: k.key, ...(row ? { row } : {}), ...(compare ? { compare } : {}), ...(candles.got ? { candles: candles.got } : {}), positions, orders, lines, cost, missing };
  }

  /** ONE MARKET'S PRICE HISTORY, as the Market sheet and the Asset sheet draw it: at a venue connected live, its trader's own (live/trade.ts
   * candles); at a venue not connected, its public source's, without a key (live/public-markets.ts: the exchanges' keyless OHLCV, Kalshi's
   * public candlesticks, Polymarket's prices-history). `venue` is a venue's id on the account or a public source's id as Markets lists it;
   * `symbol` the market as that venue names it. Bars of 5m, 1h or 1d, about three hundred, each answer kept a minute. The symbol is only ever
   * handed to the venue's own client or put in a fixed host's query string, encoded: nothing here is asked of a host the symbol names */
  async candles(venue: string, symbol: string, interval: string): Promise<CandlesView | Refusal> {
    if (!this.account) return no("E_ACCOUNT_BAD_ACTION", { message: "the account layer is not mounted" });
    const id = venue.trim();
    const sym = symbol.trim();
    if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(id)) return no("E_ACCOUNT_BAD_ACTION", { message: "a venue is named by its id: lower-case letters, digits and dashes" });
    if (!sym || sym.length > 160 || !isPlain(sym)) return no("E_ACCOUNT_BAD_ACTION", { message: "a market is named by its symbol at that venue: 1 to 160 characters of plain text" });
    if (!(CANDLE_INTERVALS as readonly string[]).includes(interval)) return no("E_ACCOUNT_BAD_ACTION", { message: `price history is by ${CANDLE_INTERVALS.join(", ")}` });
    const iv = interval as CandleInterval;
    const since = this.realNow() - CANDLE_SPAN[iv];
    const live = this.adapters.get(id)?.account.watchOnly ? this.liveVenues.get(id) : undefined;
    if (live) {
      if (!live.trader) return no("E_VENUE_RAIL_CLOSED", { venue: id, message: `${live.name}: ${live.noTradeBecause ?? "no markets are read here from the account"}` });
      if (!live.trader.candles) return no("E_VENUE_RAIL_CLOSED", { venue: id, message: `${live.name} keeps no price history the account can read` });
      const got = await within(CANDLE_MS, this.kept(live).candles!(sym, iv, since), id, live.name);
      return isRefusal(got) ? got : { venue: id, venueName: live.name, symbol: sym, interval: iv, candles: got };
    }
    const src = this.publicMarkets().find((x) => x.id === id);
    if (!src) return no("E_WALLET_ACCOUNT_UNKNOWN", { venue: id, message: `"${id.slice(0, 40)}" is neither a venue connected live nor a public market source: Markets names both` });
    if (!src.candles) return no("E_VENUE_RAIL_CLOSED", { venue: id, message: `${src.name} publishes no price history` });
    // kept a minute under the source's id (`keptPublic`): a source that refused this location is not asked again for ten minutes
    const got = await within(CANDLE_MS, src.candles(sym, iv, since), id, src.name);
    return isRefusal(got) ? got : { venue: id, venueName: src.name, symbol: sym, interval: iv, candles: got, public: true };
  }

  /** price history for the Asset sheet: at the first venue in the comparison whose trader keeps it (its spot or stock market before a
   * perpetual), or — an event contract — at a venue that holds it; at most two venues are asked, each within its time. A coin no connected
   * venue keeps a history of (a wallet's, a by-address venue's) is then asked of the exchanges' keyless public bars, as the Market sheet
   * reads them — its dollar pair at the first two sources that publish one. Only when every source refused is there none, in their words */
  private async candlesFor(k: AssetKey, interval: CandleInterval, compare: Comparison | undefined, positions: VenuePosition[], row: HeldRow | undefined): Promise<{ got?: CandleSeries; missing?: ReadMissing }> {
    const tries: Array<{ v: LiveVenue; symbol: string }> = [];
    const add = (venue: string, symbol: string) => {
      const v = this.liveVenues.get(venue);
      if (v?.trader?.candles && this.adapters.get(venue)?.account.watchOnly && !tries.some((t) => t.v.id === venue && t.symbol === symbol)) tries.push({ v, symbol });
    };
    for (const r of compare?.rows ?? []) if (r.kind !== "perp") add(r.venue, r.symbol);
    for (const r of compare?.rows ?? []) if (r.kind === "perp") add(r.venue, r.symbol);
    if (k.cls === "event") {
      for (const p of positions) add(p.venue, p.symbol);
      for (const l of row?.venues ?? []) add(l.venue, row!.asset);
    }
    const since = this.realNow() - CANDLE_SPAN[interval];
    let missing: ReadMissing | undefined;
    for (const t of tries.slice(0, 2)) {
      const got = await within(CANDLE_MS, this.kept(t.v).candles!(t.symbol, interval, since), t.v.id, t.v.name);
      if (isRefusal(got)) missing ??= { venue: t.v.id, venueName: t.v.name, why: got.message, code: got.code, part: "candles" };
      else if (got.length) return { got: { venue: t.v.id, venueName: t.v.name, symbol: t.symbol, interval, bars: got } };
    }
    if (k.cls === "crypto") {
      for (const s of this.publicMarkets().filter((x) => x.kind === "exchange" && x.candles).slice(0, 2)) {
        for (const quote of ["USD", "USDT", "USDC"]) {
          const symbol = `${k.name}/${quote}`;
          const got = await within(CANDLE_MS, s.candles!(symbol, interval, since), s.id, s.name);
          if (isRefusal(got)) missing ??= { venue: s.id, venueName: s.name, why: got.message, code: got.code, part: "candles" };
          else if (got.length) return { got: { venue: s.id, venueName: s.name, symbol, interval, bars: got, public: true } };
        }
      }
    }
    return missing ? { missing } : {};
  }

  /** TRADE · Sell many: everything held that is not a dollar, venue by venue, with what selling all of it there would sign — a sell order in
   * a dollar market at that venue (a wallet's token in its pair with USDC on the chain it is held on), its size down to the market's step;
   * a perpetual or a future, its close; an event contract, its shares sold. Each says whether an order could go now, and if not why.
   * Nothing is placed: each one is still an order the owner signs, or an agent places inside its limit */
  async sellable(): Promise<{ items: Sellable[]; missing: ReadMissing[] } | Refusal> {
    const page = await this.accountView();
    if (!page) return no("E_ACCOUNT_BAD_ACTION", { message: "the account layer is not mounted" });
    const writes = page.connectLive?.writes?.on === true;
    const { rows } = byAsset(page.venues, { writes });
    const pos = await this.allPositions();
    if (isRefusal(pos)) return pos;
    const listsPositions = new Set(this.tradingVenues().filter((v) => v.trader!.positions).map((v) => v.id));
    const jobs: Array<Promise<Sellable>> = [];
    for (const row of rows) {
      // a dollar is not sold; money in an earn product is taken out first (a liveEarn withdraw), then sold
      if (row.class === "stable" || row.class === "cash" || row.class === "earn") continue;
      // an event contract at a venue that lists positions is sold from its position, below
      for (const line of row.venues) if (!(row.class === "event" && listsPositions.has(line.venue))) jobs.push(this.sellLine(row, line, writes));
    }
    for (const p of pos.positions) if (p.kind === "perp" || p.kind === "future" || p.kind === "event") jobs.push(this.sellPosition(p, writes));
    const items = (await Promise.all(jobs)).sort((a, b) => Number(b.ready) - Number(a.ready) || (b.usd ?? 0) - (a.usd ?? 0));
    return { items, missing: pos.missing };
  }

  /** what selling one venue's part of a holding would sign there */
  private async sellLine(row: AssetRow, line: AssetRow["venues"][number], writes: boolean): Promise<Sellable> {
    const base = { key: row.key, asset: row.asset, venue: line.venue, venueName: line.venueName, action: "sell" as const, held: line.amount };
    const not = (why: string): Sellable => ({ ...base, sellQty: 0, ready: false, why });
    if (line.inTransit) return not("on its way: it is not at the venue yet");
    if (line.watched) return not("a watched address: nothing is sold from it here");
    const v = this.liveVenues.get(line.venue);
    if (!v?.trader || !this.adapters.get(line.venue)?.account.watchOnly) return not(v?.noTradeBecause ?? "no orders are placed here from the account");
    const t = this.kept(v);
    const found = row.class === "event" ? await t.market(row.asset) : await dollarMarket(t, row, line);
    if (isRefusal(found)) return not(found.message);
    if (!found) return not(`${v.name} lists no dollar market for ${row.asset}${line.note ? ` (${line.note.split(" · ")[0]})` : ""}`);
    const fresh = row.class === "event" ? found : await t.market(found.symbol);
    const m = isRefusal(fresh) ? found : fresh;
    return this.sellOf(base, v, m, line.amount, writes);
  }

  /** a position's way out: a perpetual or a future closed at its venue, an event contract's shares sold */
  private async sellPosition(p: VenuePosition, writes: boolean): Promise<Sellable> {
    const v = this.liveVenues.get(p.venue)!;
    const base = { key: `position:${p.venue}:${p.symbol}`, asset: p.kind === "event" ? p.name : normalBase(p.symbol, p.kind) || p.symbol, venue: p.venue, venueName: p.venueName ?? v.name, held: p.qty };
    if (p.kind === "event") {
      const m = await this.kept(v).market(p.symbol);
      if (isRefusal(m)) return { ...base, action: "sell", symbol: p.symbol, kind: p.kind, side: p.side, sellQty: 0, ready: false, why: m.message };
      return this.sellOf({ ...base, action: "sell" }, v, m, p.qty, writes);
    }
    const why = !writes ? "this server was started read-only" : v.trader!.can === false ? (v.trader!.whyNot ?? "this key may not trade") : undefined;
    return { ...base, action: "close", symbol: p.symbol, kind: p.kind, side: p.side, sellQty: p.qty, ...(p.markPrice !== undefined ? { price: p.markPrice } : {}), ...(p.usd !== undefined ? { usd: r2(p.usd) } : {}), ready: why === undefined, ...(why ? { why } : {}) };
  }

  /** a sell of `held` in market `m`: down to its step, at its bid (its price where it shows no book), and whether it could go now */
  private sellOf(base: Omit<Sellable, "sellQty" | "ready" | "symbol" | "kind" | "price" | "usd" | "why">, v: LiveVenue, m: Market, held: number, writes: boolean): Sellable {
    const qty = floorTo(held, m.qtyStep);
    const price = m.bid ?? m.price;
    const usd = price !== undefined ? r2(qty * price * (m.contractSize ?? 1)) : undefined;
    const why = !writes ? "this server was started read-only" : v.trader!.can === false ? (v.trader!.whyNot ?? "this key may not trade") : !m.open ? (m.note ?? "the market is closed now") : !(qty > 0) ? "less than one step of size" : m.minQty !== undefined && qty < m.minQty ? `below the smallest order there (${m.minQty} ${m.base})` : m.minNotional !== undefined && usd !== undefined && usd < m.minNotional ? `below the smallest order there ($${m.minNotional})` : undefined;
    return { ...base, symbol: m.symbol, kind: m.kind, sellQty: qty, ...(price !== undefined ? { price } : {}), ...(usd !== undefined ? { usd } : {}), ready: why === undefined, ...(why ? { why } : {}) };
  }

  /** a fresh price for each of a few markets at venues connected live (each kept three seconds, as the order ticket's): what the page polls
   * for the cards it shows */
  async quotes(pairs: Array<{ venue: string; symbol: string }>): Promise<Array<{ venue: string; symbol: string; market?: Market; refusal?: Refusal }> | Refusal> {
    if (!this.account) return no("E_ACCOUNT_BAD_ACTION", { message: "the account layer is not mounted" });
    if (!pairs.length || pairs.length > 12) return no("E_ACCOUNT_BAD_ACTION", { message: "quotes are asked for 1 to 12 markets at once, each venue|symbol" });
    return Promise.all(pairs.map(async (p) => {
      const r = await this.liveMarket(p.venue, p.symbol);
      return isRefusal(r) ? { ...p, refusal: r } : { ...p, market: r };
    }));
  }

  /** THE AGENTS, one by one — what the Agent module reads: each key's standing and expiry, each limit the owner signed for it with what is
   * spent, held and left, the cards it is waiting on, its orders, its payments, its wallets, the owner's intents addressed to it (or to
   * every agent) and what it has asked the owner for, and its recent flights. Keys that asked to be let in are in `requests`. A read: what
   * an agent may do is still only what its limits and the owner's cards say */
  async agents(): Promise<AgentsView | Refusal> {
    const page = await this.accountView();
    if (!page) return no("E_ACCOUNT_BAD_ACTION", { message: "the account layer is not mounted" });
    // a key approved again after its first approval ran out is listed twice: the later approval is the one that stands
    const keys = new Map<string, AccountPage["keys"][number]>();
    for (const k of page.keys) {
      const was = keys.get(k.address);
      if (!was || Date.parse(k.approvedAt) >= Date.parse(was.approvedAt)) keys.set(k.address, k);
    }
    const agents: AgentView[] = [...keys.values()].map((k) => ({
      address: k.address,
      name: k.name,
      code: k.code,
      status: k.status,
      validUntil: k.validUntil,
      approvedAt: k.approvedAt,
      limits: page.spend.filter((s) => s.agent === k.address).map((s) => ({ id: s.id, scope: s.scope, allow: s.allow, perPaymentUsd: s.perPaymentUsd, budgetUsd: s.budgetUsd, spentUsd: s.spentUsd, reservedUsd: s.reservedUsd, leftUsd: Number(Math.max(0, s.budgetUsd - s.spentUsd - s.reservedUsd).toFixed(6)), windowHours: s.windowHours, validUntil: s.validUntil, expired: s.expired })),
      cards: page.cards.filter((c) => c.agent === k.address),
      orders: page.orders.filter((o) => o.agent === k.address).slice(0, 20),
      payments: page.payments.filter((p) => p.agent === k.address).slice(0, 20),
      earns: page.earns.filter((e) => e.agent === k.address).slice(0, 20),
      wallets: page.subAccounts.filter((s) => s.agent === k.address).map((s) => {
        const venue = agentWalletVenue(s.name);
        const live = page.venues.find((v) => v.id === venue);
        return { ...s, venue, ...(live ? { usd: live.usd } : {}) };
      }),
      intents: page.intents.filter((i) => i.agent === k.address || i.agent === "*"),
      asks: page.asks.filter((a) => a.agent === k.address),
      declinedAsks: page.declinedAsks.filter((a) => a.agent === k.address),
      memory: this.memory ? { notes: this.memory.notes(k.address).filter((n) => !n.waiting).length, waiting: this.memory.notes(k.address).filter((n) => n.waiting).length } : { notes: 0, waiting: 0 },
      flights: this.flights.filter((f) => f.agent.name === k.name && f.agent.code === k.code).slice(-10).reverse().map((f) => ({ no: f.no, at: f.at, request: f.request, legs: f.legs.map((l) => `${l.mark === "ok" ? "✓" : l.mark === "no" ? "✗" : l.mark === "wait" ? "▣" : "·"} ${l.text}`) })),
    }));
    // the mode as every other read wires it (`guard` is Guard, `open` is Beast): the page puts the words on it
    return { asOf: page.now, mode: this.openness.mode === "open" ? "open" : "guard", agents, requests: page.requests };
  }

  /** MEMORY, as the owner reads it (Account › Memory; the canvas's F13): each agent the account let in (an earlier key included) and any
   * whose memory outlived its key — its notes (the waiting ones too), the owner's switches for it, and what its limits say as they stand */
  memoryView(): MemoryPage | Refusal {
    if (!this.account || !this.memory) return no("E_ACCOUNT_BAD_ACTION", { message: "the account layer is not mounted" });
    const nowMs = Date.parse(this.now());
    // the key that stands for an address, when there is one; else its latest
    const keys = new Map<string, { name: string; code: string; status: string }>();
    for (const k of this.account.state.agents) {
      const status = agentStatus(this.account.state, k.address, nowMs);
      if (!keys.has(k.address) || status === "ok") keys.set(k.address, { name: k.name, code: k.code, status });
    }
    const addresses = [...new Set([...keys.keys(), ...this.memory.agents()])];
    return {
      asOf: this.now(),
      agents: addresses.map((address) => {
        const k = keys.get(address);
        return { address, name: k?.name ?? "", code: k?.code ?? "", status: k?.status ?? "gone", rules: this.memory!.rules(address), notes: this.memory!.notes(address), fromLimits: this.memoryLimits(address) };
      }),
      limits: MEMORY_LIMITS,
    };
  }

  /** MEMORY, as one agent reads it (portfolio_memory): its notes kept, the ones waiting for the owner, what its limits say, and the memory of
   * every other agent whose owner's switch shares it; `q` narrows the notes to what mentions it. Words, never a permission */
  memoryFor(address: string, o: { q?: string | undefined } = {}): AgentMemoryView | Refusal {
    if (!this.account || !this.memory) return no("E_ACCOUNT_BAD_ACTION", { message: "the account layer is not mounted" });
    const a = address.trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(a)) return no("E_ACCOUNT_BAD_ACTION", { message: "an agent's memory is read by the address of its key" });
    const own = this.memory.notes(a);
    const shared = this.memory.agents().filter((x) => x !== a && this.memory!.rules(x).share);
    return {
      asOf: this.now(),
      rules: this.memory.rules(a),
      notes: MemoryStore.matching(own.filter((n) => !n.waiting), o.q),
      waiting: own.filter((n) => n.waiting),
      fromLimits: this.memoryLimits(a),
      sharedWithYou: shared.map((x) => ({ agent: x, name: this.account!.agentName(x), notes: MemoryStore.matching(this.memory!.notes(x).filter((n) => !n.waiting), o.q) })).filter((x) => x.notes.length),
      limits: MEMORY_LIMITS,
    };
  }

  /** the agents' notes waiting for the owner (the switch "ask me first"), as Waiting for you shows them */
  memoryAsks(): Array<{ agent: string; agentName: string; id: string; topic: Topic; text: string; how?: string | undefined; at: string }> {
    if (!this.account || !this.memory) return [];
    return this.memory.waiting().map(({ address, note }) => ({ agent: address, agentName: this.account!.agentName(address), id: note.id, topic: note.topic, text: note.text, ...(note.how ? { how: note.how } : {}), at: note.at }));
  }

  /** "From your limit" (F13): what the owner's signed limits for this agent say, as they stand, and the mode — written out by the account,
   * kept nowhere, so never out of date; changed only by changing the limit or the mode */
  private memoryLimits(address: string): MemoryFromLimit[] {
    if (!this.account) return [];
    const nowMs = Date.parse(this.now());
    const dollars = (micro: number) => `$${(micro / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
    const where = (allow: string[]) => (allow.includes("*") ? "every venue" : allow.map((v) => this.account!.name(v.split(":")[0]!)).join(", "));
    const items: MemoryFromLimit[] = this.account.state.spends
      .filter((x) => x.agent === address && x.revokedAt === undefined && x.budgetMicro > 0 && nowMs < x.validUntil)
      .map((x) => {
        const words =
          x.scope === "trade"
            ? `Up to ${dollars(x.perPaymentMicro)} an order, ${dollars(x.budgetMicro)} in all, at ${where(x.allow)}`
            : x.scope === "venues"
              ? `Moves money between your own accounts (${where(x.allow)}): up to ${dollars(x.perPaymentMicro)} a move, ${dollars(x.budgetMicro)} in all`
              : x.scope === "payees"
                ? `Pays ${x.allow.includes("*") ? "any payee" : x.allow.join(", ")} from its wallet: up to ${dollars(x.perPaymentMicro)} a payment, ${dollars(x.budgetMicro)} in all`
                : `Puts money into earn at ${where(x.allow)}: up to ${dollars(x.perPaymentMicro)} at a time, ${dollars(x.budgetMicro)} in all`;
        return { id: x.id, from: "limit" as const, topic: "rules" as const, text: `${words} · until ${etDate(x.validUntil)}`, at: x.at };
      });
    if (!items.length) return items;
    const open = this.openness.mode === "open";
    return [...items, { id: "mode", from: "mode", topic: "rules", text: open ? "Inside its limits it acts at once: your mode is Beast" : "Real money goes through you first: every order waits for you on a card (Guard)" }];
  }

  /** every order the account ever placed, as last logged, with each row at which more of it filled (account/costbasis.ts ordersOf): every run's */
  private allOrders(): LoggedOrder[] {
    const { before, now } = this.statementRows();
    return ordersOf([...before, ...now].map((r) => ({ kind: "statement", native: r.native })));
  }

  /** what a live connection reaches: the real network, unless a test handed in stand-ins */
  private liveDeps(): LiveDeps {
    // made once: the chain clients and the price cache are kept between connections
    return (this.liveMade ??= { home: this.opts.home, http: realHttp, clock: Date.now, mm: realMm(this.opts.mm?.bin, this.opts.mm?.timeoutMs), chain: this.opts.liveDeps?.chain ?? publicChain(), price: this.opts.liveDeps?.price ?? publicPrices({ open: this.opts.liveDeps?.openExchange, clock: this.opts.liveDeps?.clock }), signIn: (kind) => this.signIn(kind), ...this.opts.liveDeps, proofs: this.proofs });
  }
  private liveMade: LiveDeps | undefined;

  /** the sign-in at a venue that speaks OAuth to MCP clients (Robinhood): one per venue, its tokens in memory only */
  private readonly signIns = new Map<string, OAuthSignIn>();
  signIn(kind: string): OAuthSignIn | undefined {
    if (kind !== "robinhood") return undefined;
    let s = this.signIns.get(kind);
    if (!s) {
      const deps = this.liveDeps();
      s = new OAuthSignIn({ resource: ROBINHOOD_MCP, name: "Robinhood", venue: "robinhood", http: deps.http, clock: deps.clock });
      this.signIns.set(kind, s);
    }
    return s;
  }
  /** whether a key file in this server's home is ready for a connection; names, never values */
  keyFile(kind: string, venue: string, ref: string, needs: string[] = []): ReturnType<typeof keyFileStatus> {
    return keyFileStatus(this.opts.home, kind, venue, ref, needs);
  }
  /** what each connection's venue answers from this machine before any key is made (live/reach.ts): its own first, keyless question. Kept
   * per connection (a location rule ten minutes, an answer two), asked once while an answer is on its way; `force` asks again now — save a
   * venue's own running ban of this machine's address, learned here or by its reads, which is waited out: asking a venue again from the
   * address it banned lengthens the ban */
  private readonly reaches = new Map<string, { r: Reach; until: number; ban?: true | undefined } | { pending: Promise<Reach> }>();
  connectReach(connectors: string[], force = false): Promise<Reach[]> {
    // a forced check learns the place again too (the laptop may have moved since it was learned): the probes that hold a venue's line to
    // the place (Hyperliquid's) ask it of the network the user is on now
    if (force) this.whereMade = undefined;
    return this.reachEach(connectors, force);
  }
  private reachEach(connectors: string[], force: boolean): Promise<Reach[]> {
    const deps = this.liveDeps();
    return Promise.all(
      connectors.map((c) => {
        const kept = this.reaches.get(c);
        if (kept && "pending" in kept) return kept.pending;
        if (kept && kept.until > deps.clock() && (!force || kept.ban)) return Promise.resolve(kept.r);
        const id = c.replace(/^live:(exchange:)?/, "");
        const banned = this.marketReads.banOf(id);
        if (banned) return Promise.resolve<Reach>({ connector: c, state: "unreachable", said: banned.refusal.message, at: new Date(banned.at).toISOString() });
        const pending = reachOf(c, { http: deps.http, clock: deps.clock, open: deps.openExchange, mm: deps.mm, signIn: (k) => this.signIn(k), where: this.where() })
          .catch((): Reach => ({ connector: c, state: "unreachable", said: "no answer just now; connecting asks again", at: new Date(deps.clock()).toISOString() }))
          .then((r) => {
            const now = deps.clock();
            const ban = reachBanUntil(r, now);
            this.reaches.set(c, { r, until: now + reachKeepMs(r, now), ...(ban ? { ban: true as const } : {}) });
            // the venue's reads (its connection's, its keyless source's) wait out the same ban — held on the wall clock, as they are timed
            if (ban) this.marketReads.hold(id, no("E_VENUE_UNREACHABLE", { venue: id, message: r.said ?? `${id} has banned this machine's address`, native: { ban: true, until: Date.now() + (ban - now) } }));
            this.reached(c, r, force);
            return r;
          });
        this.reaches.set(c, { pending });
        return pending;
      }),
    );
  }
  /** what a connection's newest answer changes. The list of where the user can connect, and the door's check of an agent's ask, take it
   * at once (a forced "Check again" is not overruled by an older answer kept in the list). A re-check the user (or the half-hourly watch)
   * asked for that finds the venue answering lets go of what was held from the network before: its keyless source's place hold and kept
   * refusals, a connected venue's — and asks a venue that did not come back after the restart again now */
  private reached(c: string, r: Reach, force: boolean): void {
    const kept = this.venuesKept;
    const i = kept ? kept.v.findIndex((x) => x.connector === c) : -1;
    const was = kept && i >= 0 ? kept.v[i]! : undefined;
    if (kept && was && (was.asked === undefined || Date.parse(r.at) >= Date.parse(was.asked))) {
      const now = verdictOf(r, was.terms, was.needs);
      if (now.verdict !== was.verdict) {
        // its edition, and the editions beside it, are judged again at the next read of the list
        const { said: _said, edition: _edition, ...rest } = was;
        this.venuesKept = { ...kept, v: kept.v.map((x, j) => (j === i ? { ...rest, verdict: now.verdict, ...(now.said ? { said: now.said } : {}), asked: r.at } : x)), sure: false };
      } else this.venuesKept = { ...kept, v: kept.v.map((x, j) => (j === i ? { ...was, asked: r.at } : x)) };
    }
    if (!force || r.state !== "ok") return;
    for (const [ns, s] of this.publicRaw) {
      if (s.connector !== c) continue;
      this.marketReads.release(ns);
      if (s.historyApart) this.marketReads.release(`${ns}#history`);
      // the source's own keeping of a refusal from the network before, where it has a way to let go of it
      s.reset?.();
    }
    for (const [id, a] of this.adapters) if (a.account.watchOnly && a.account.connector === c) this.marketReads.release(id);
    for (const [venue, w] of this.comingBack) if (w.c.connector === c) void this.tryAgain(venue);
  }
  /** WHERE THIS USER CAN CONNECT (live/availability.ts): every venue the account knows, judged from the network it runs on — the venue's
   * own answer to it (connectReach) and its own terms matched to where it is (in memory only). Asked automatically (watchVenues: at
   * start and every 30 minutes on the real server) and on request; one answer kept, and asked once while on its way. `sure`: every venue
   * answered and the place was learned */
  private venuesKept: { at: number; v: VenueHere[]; sure: boolean } | undefined;
  private venuesPending: { p: Promise<VenueHere[]>; force: boolean } | undefined;
  /** the residency hooks: each venue's own published terms (live/eligibility.ts), held to where this network is (live/location.ts: the
   * place learned on the machine the account runs on — the user's own — in memory only). Without a place the terms are shown, not judged;
   * either way they are never enforced. A test sets its own */
  venueTerms: AvailabilityDeps["terms"] = termsHere;
  venuePlace: AvailabilityDeps["place"] = () => this.where().place({ splits: (country) => SPLIT.has(country) });
  private whereMade: Locator | undefined;
  private where(): Locator {
    const deps = this.liveDeps();
    return (this.whereMade ??= locator({ http: deps.http, clock: deps.clock }));
  }
  async venuesHere(force = false): Promise<VenueHere[]> {
    const deps = this.liveDeps();
    // kept 30 minutes when every venue answered and the place was learned. Otherwise it is asked again after twenty seconds — only what did
    // not answer, and the place, are asked again then (the answers come from each connection's own keep) — behind the list kept, which is
    // answered at once for those 30 minutes: one venue that does not answer never makes every read wait for its probe
    const kept = this.venuesKept;
    const age = kept ? deps.clock() - kept.at : Infinity;
    if (!force && kept && (age < 20_000 || (kept.sure && age < 30 * 60_000))) return kept.v;
    if (!force && kept && age < 30 * 60_000) {
      void this.askVenues(false).catch(() => undefined);
      return kept.v;
    }
    return this.askVenues(force);
  }
  private askVenues(force: boolean): Promise<VenueHere[]> {
    // a check on its way answers this one too — unless this one is forced and that one is not: then this one is asked after it, of the
    // network the user is on now, and its answer is the one kept
    const before = this.venuesPending;
    if (before && (!force || before.force)) return before.p;
    const p = (before ? before.p.catch(() => undefined) : Promise.resolve()).then(() => this.assembleVenues(force));
    const mine = { p, force };
    this.venuesPending = mine;
    return p.finally(() => {
      if (this.venuesPending === mine) this.venuesPending = undefined;
    });
  }
  private async assembleVenues(force: boolean): Promise<VenueHere[]> {
    const deps = this.liveDeps();
    // a forced check learns the place again too: the laptop may be on another network than the one the place was learned on, and the
    // terms and editions are matched to where it is now (the old locator's own timer drops what it kept)
    if (force) this.whereMade = undefined;
    const page = await this.accountView();
    const on = new Set((page?.venues ?? []).map((v) => v.connector).filter((c): c is string => !!c));
    const ask = this.venuePlace;
    let placed = ask === undefined;
    const v = await venuesHere({
      connections: venueCatalog(liveOptions(this.opts.home).options),
      reach: (cs) => this.reachEach(cs, force),
      terms: this.venueTerms,
      place: ask
        ? async () => {
            const p = await ask();
            placed = p !== undefined;
            return p;
          }
        : undefined,
      connected: (c) => on.has(c),
      clock: deps.clock,
    });
    this.venuesKept = { at: deps.clock(), v, sure: placed && !v.some((x) => x.verdict === "no-answer") };
    return v;
  }
  /** the real server keeps the answer fresh without anyone asking: soon after it starts, then every 30 minutes (never in tests) */
  watchVenues(everyMs = 30 * 60_000): () => void {
    const run = () => void this.venuesHere(true).catch(() => undefined);
    const first = setTimeout(run, 3_000);
    const every = setInterval(run, everyMs);
    first.unref?.();
    every.unref?.();
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }
  /** which sign-in a state that came back belongs to */
  signInHolding(state: string): OAuthSignIn | undefined {
    return [...this.signIns.values()].find((s) => s.has(state));
  }

  /** Connect a venue the user REALLY has, read-only. The venue is asked through its own interface (live/): what it holds, and what it says the
   * credential may do. A live connection on the id of a simulated venue takes that venue's place until it is unplugged; either way every
   * door through it is shut, because the account sends a live venue nothing. */
  private async plugLive(venue: string, connector: string, label: string, credentialRef: string): Promise<Refusal | { ok: true; summary: string; native?: unknown }> {
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(venue)) return no("E_ACCOUNT_BAD_ACTION", { venue, message: "a venue's id is lower-case letters, digits and dashes" });
    const sim = this.adapters.get(venue);
    if (sim?.account.watchOnly) return no("E_ACCOUNT_BAD_ACTION", { venue, message: `${sim.account.name} is already connected live: unplug it before connecting it again` });
    const deps = this.liveDeps();
    const opened = await openLive({ venue, connector, label: label.trim().slice(0, 40) || sim?.account.name || "", reference: credentialRef.trim().slice(0, 200) }, deps);
    if (isRefusal(opened)) return opened;
    // its balance reads follow the same hold as its market reads: a venue that banned this address, or refuses this network, is asked
    // neither for one nor the other until the hold runs out (of the mm connection's, only what is mm's own holds its other reads)
    const adapter = await liveAccount(venue, opened.source, { connector, first: opened.first, clock: deps.clock, ...(opened.price ? { price: opened.price } : {}), held: () => this.marketReads.heldOf(venue), refused: (r) => void ((connector !== "live:metamask" || connectionWide(r)) && this.marketReads.hold(venue, r)) });
    const src = opened.source;
    // a venue's own words for what it does not do here, as the page and the ledger show them, with this machine's address taken out (not all
    // of them passed through no())
    if (src.readOnlyBecause) src.readOnlyBecause = unaddressed(src.readOnlyBecause);
    if (src.noTradeBecause) src.noTradeBecause = unaddressed(src.noTradeBecause);
    // who showed the address is the user's: the wallet that signed the account's sentence, or the mm session on this machine
    const proven = src.address === undefined ? undefined : connector === "live:metamask" ? "the mm session on this machine" : deps.proofs.proven(src.address)?.wallet;
    Object.assign(adapter.account, { ...(proven ? { proven } : {}), ...(src.writer ? { liveCan: src.writer.can } : {}), ...(src.noTradeBecause ? { noTradeBecause: src.noTradeBecause } : {}), ...(src.readOnlyBecause ? { readOnlyBecause: src.readOnlyBecause } : {}) });
    // what the key may do is read from the trader each time: a venue can say it only after connecting (Kalshi's key scopes)
    const trader = src.trader;
    // the kinds of market its trader offers, where it says them itself (the mm trader: tokens, event contracts, perpetuals); the page falls
    // back to the connector's own (accounts.ts tradeKinds) where it does not
    if (trader) Object.defineProperty(adapter.account, "liveTrade", { get: () => ({ can: trader.can, what: trader.what, ...(trader.kinds ? { kinds: [...trader.kinds] } : {}), positions: !!trader.positions, amend: !!trader.amend, leverage: !!trader.setLeverage, close: !!trader.close }), enumerable: true, configurable: true });
    this.liveVenues.set(venue, { id: venue, name: adapter.account.name, kind: adapter.account.kind, ...(src.address ? { address: src.address } : {}), ...(proven ? { proven } : {}), ...(src.writer ? { writer: src.writer } : {}), ...(src.readOnlyBecause ? { readOnlyBecause: src.readOnlyBecause } : {}), ...(src.trader ? { trader: src.trader } : {}), ...(src.noTradeBecause ? { noTradeBecause: src.noTradeBecause } : {}), via: src.via });
    // its earn: the source's own (the mm wallet's vaults), or — at OKX and Kraken — the exchange's, through the trader's own client and key
    const hook = exchangeEarnHook(src.trader);
    const earner = src.earner ?? (hook ? exchangeEarner({ ...hook, price: deps.price, now: deps.clock }) : undefined);
    if (earner) this.earners.set(venue, earner);
    else this.earners.delete(venue);
    if (sim) this.shadowed.set(venue, sim);
    this.adapters.set(venue, adapter);
    // the venue has just answered this network: no hold, kept read or health under its id from before carries over (a keyless source's
    // refusal on the network the user left, an earlier connection's)
    this.marketReads.forget(venue, true);
    // Markets and the comparison were answered from what the venues listed before this one: they are asked again
    this.marketReads.forgetAll(["explore", "compare"]);
    const usd = r2((await adapter.read()).reduce((s, h) => s + h.usd, 0));
    // what this connection may do with the money there: nothing unless the server moves real money, and then only what the owner signs
    const writes = this.opts.liveWrites;
    const can = src.writer?.can;
    const leaves = !!can && (can.withdraw !== false || (can.ledgers.length > 1 && can.transfer !== false) || can.swap !== false || !!can.send);
    const mode = !src.writer ? `read only: ${src.readOnlyBecause ?? "nothing is sent to it from here"}` : !writes ? "read only: this server was started without real-money writes" : src.address !== undefined && !proven && src.writer.can.send === "wallet" ? "watched: no wallet signed for this address, so nothing is sent to or from it" : !leaves ? "this key only reads: money can be sent to it, nothing leaves it from here" : `real money moves only when you sign it, at most ${cents(writes.capUsd)} a movement`;
    // the wallet's proof rides on the connection's row: a restarted account checks the signature again rather than forgetting it was given
    const proof = src.address !== undefined && connector !== "live:metamask" ? deps.proofs.proven(src.address) : undefined;
    const kept = proof?.message && proof.signature ? { address: proof.address, wallet: proof.wallet, at: proof.at, message: proof.message, signature: proof.signature } : undefined;
    return { ok: true, summary: unaddressed(`${adapter.account.name} connected live · ${cents(usd)} there now · ${opened.summary} · ${mode}${sim && !this.opts.real ? " · it stands in for the simulated one until it is unplugged" : ""}`), native: { connector, probe: opened.source.probe.native ?? null, ...(kept ? { proof: kept } : {}) } };
  }

  private unplug(venue: string): Refusal | { ok: true; summary: string } {
    const a = this.adapters.get(venue);
    // a venue still waiting to come back after a restart is not on the account yet: disconnecting it stops the asking, and the ledger row
    // keeps a later restart from bringing it back
    if (!a && this.stopComingBack(venue, false)) return { ok: true, summary: `${venue} is no longer asked to come back after the restart: the account will not connect it again. The key at the venue is untouched: delete it there` };
    if (!a) return no("E_WALLET_ACCOUNT_UNKNOWN", { venue });
    if (!a.account.plugged) return no("E_ACCOUNT_BAD_ACTION", { venue, message: `${a.account.name} is one of the venues the account opened with: only a venue that was plugged in can be unplugged` });
    // an agent wallet is the account's own: this account holds its key, and the money in it is the owner's. Disconnecting it would only
    // hide that money (and leave the wallet with no way back on the page); it is emptied instead, and goes with the agent's sub-account
    if (a.account.connector === "live:agent-wallet") return no("E_ACCOUNT_BAD_ACTION", { venue, message: `${a.account.name} is an agent wallet: it is not disconnected, because it holds money this account has the key for. Empty it with Take back… first; it leaves the account with the agent's sub-account` });
    this.liveVenues.delete(venue);
    this.earners.delete(venue);
    this.earnSeen.delete(venue);
    this.marketReads.forget(venue);
    // Markets and the comparison were answered with this venue among the connected ones: they are asked again
    this.marketReads.forgetAll(["explore", "compare"]);
    // a live connection that stood in for a simulated venue: the simulated one comes back
    const sim = this.shadowed.get(venue);
    if (sim) {
      this.shadowed.delete(venue);
      this.adapters.set(venue, sim);
      // on a real account the simulated one comes back to the statement page only
      return { ok: true, summary: `${a.account.name} disconnected: the account no longer reads the real venue${this.opts.real ? "" : ", and the simulated one is back"}. The key at the venue is untouched: delete it there` };
    }
    if (a.account.watchOnly) {
      this.adapters.delete(venue);
      // what it holds stays where it is, at the venue or at the address: only the account's reading of it ends. A venue read by its
      // address had no key here to delete; one connected by a key keeps that key at the venue
      return { ok: true, summary: `${a.account.name} disconnected: the account no longer reads it. ${a.account.address ? "What is at the address stays there; it was read by its address, so there is no key to delete" : "The key at the venue is untouched: delete it there"}` };
    }
    this.adapters.delete(venue);
    const listed = this.walletAllow.indexOf(a.account.address ?? venue);
    if (listed >= 0) this.walletAllow.splice(listed, 1);
    return { ok: true, summary: `${a.account.name} unplugged: the account no longer reads it or routes through it. The credential at the venue is untouched: delete it there` };
  }

  /** the account layer's front door: one signed instruction. A write that reached a venue changes what that venue's reads say, so what was
   * kept of them goes (positions, prices, earn): the next page read sees the new position, leverage or balance within one poll, not when
   * the keep runs out. A card changes nothing at the venue yet; a refusal changes nothing at all — nor does a card the owner rejected, or a
   * move or order still waiting for the wallet to send it. Only a venue the outcome says was reached is taken as having answered, which
   * lifts a hold it set (a ban, its place rule): the other end of a move that only waits for the money is not */
  async exchange(envelope: Envelope): Promise<Outcome> {
    if (!this.account) return no("E_ACCOUNT_BAD_ACTION", { message: "the account layer is not mounted on this service" });
    const r = await this.account.exchange(envelope);
    if (isRefusal(r) || r.kind === "card") return r;
    const reached = reachedVenue(r);
    if (reached === "no") return r;
    const action = (envelope.action && typeof envelope.action === "object" ? envelope.action : {}) as { type?: unknown; card?: unknown };
    const card = action.type === "approveCard" ? this.approvals.find((x) => x.id === action.card) : undefined;
    const move = (card?.action as { type?: unknown } | undefined)?.type ?? action.type;
    const from = r.kind === "payment" ? r.payment.from : undefined;
    for (const v of this.venuesWritten(envelope.action)) {
      // a move's destination answered only when its deposit address was asked of it (an exchange's own answer; a wallet's address is its
      // own). A write whose answer was lost may have landed: what was kept of the venue's reads goes, and its hold stands
      const asked = reached === "yes" && (!(move === "liveMove" || move === "agentLiveMove") || v === from || this.liveVenues.get(v)?.address === undefined);
      this.marketReads.drop(v, asked);
    }
    return r;
  }

  /** the venues a signed instruction writes at, when it is one that writes at a venue: an order and what is done to it, a movement's two
   * ends, money into or out of earn, and a card the owner approved (the venue of what it released) */
  private venuesWritten(action: unknown): string[] {
    const a = (action && typeof action === "object" ? action : {}) as { type?: unknown; venue?: unknown; from?: unknown; to?: unknown; card?: unknown };
    const text = (x: unknown): string[] => (typeof x === "string" && x ? [x] : []);
    switch (a.type) {
      case "liveOrder":
      case "agentLiveOrder":
      case "liveCancel":
      case "agentLiveCancel":
      case "liveAmend":
      case "agentLiveAmend":
      case "liveClose":
      case "agentLiveClose":
      case "liveLeverage":
      case "agentLiveLeverage":
      case "liveEarn":
      case "agentLiveEarn":
        return text(a.venue);
      case "liveMove":
      case "agentLiveMove":
        return [...new Set([...text(a.from), ...text(a.to)])];
      case "approveCard": {
        const card = this.approvals.find((x) => x.id === a.card);
        return card ? [...new Set([...text(card.account), ...(card.action ? this.venuesWritten(card.action) : [])])] : [];
      }
      default:
        return [];
    }
  }

  /** what the Account page reads: the engine's page, with what each venue connected live has in its earn products added to that venue
   * (account/holdings.ts withEarn) — so the venue's total, the live total and the net worth curve count it, once */
  async accountView(): Promise<AccountPage | undefined> {
    const page = await this.account?.view();
    // a real account's page waits only on cards about its real venues; the statement page answers the simulation's own
    if (page && this.opts.real) page.cards = page.cards.filter((c) => this.adapters.get(this.approvals.find((a) => a.id === c.id)?.account ?? "")?.account.watchOnly);
    if (page && this.restored) page.restore = this.restored;
    if (page) await this.withEarnings(page);
    // the key file a venue connected by API key reads, as the owner signed it (a path, never what is in it): a new key for the venue goes
    // in the same file, and connecting it again starts from that file — a second account at an exchange never from the first one's
    if (page) {
      for (const v of page.venues) {
        const kind = v.live && v.connector ? parseConnector(v.connector)?.kind : undefined;
        const ref = this.adapters.get(v.id)?.account.credentialRef;
        if (kind && KEY_SHAPES[kind] && ref) v.keyFile = ref;
      }
    }
    return page;
  }

  /** what each venue connected live had in its earn products when it last answered, with the balance it was read beside (that read's `asOf`,
   * and its lines as the engine gave them, before any earn was added): a read that fails or is late keeps these, marked stale, so a venue
   * that blinks does not look like money gone — and while they are young, the two are shown together, one moment's pair */
  private readonly earnSeen = new Map<string, { asOf: string; base: AccountPage["venues"][number]["holdings"]; held: EarnHeld[] }>();
  /** an earn vault's share token's symbol, by product id, as its chain gave it (read once: a token does not rename itself) */
  private readonly shareSymbols = new Map<string, string>();

  /** Each venue connected live that earns: its earn positions, added to its holdings with the balance lines that are the same money left
   * out, and the venue's total, the live total and the account's total moved by what that changes. The positions are read again whenever
   * the venue's balance is (they are kept under the balance's own `asOf`), so the two are always one moment's pair: money that went from
   * the balance into a product is never counted in both, or in neither, for the half minute one of them is older than the other. The page
   * waits at most three seconds for a venue's earn; when it is slower, or does not answer, the venue is marked stale (so a net worth point
   * taken then is `partial`) and shows the last pair the two were read in together — its balance from then as well as its earn, while that
   * pair is under two minutes old — so money that just moved between them is not counted twice or not at all. An older pair is not shown in
   * place of a newer balance: the newer balance stands, beside the earn as last read, and the venue stays marked. The read carries on for
   * next time */
  private async withEarnings(page: AccountPage): Promise<void> {
    const venues = page.venues.filter((v) => v.live && this.earners.has(v.id) && this.adapters.get(v.id)?.account.watchOnly);
    if (!venues.length) return;
    const now = this.realNow();
    const got = await Promise.all(venues.map(async (v) => {
      const id = v.id;
      const x = this.earners.get(id)!;
      const asOf = this.adapters.get(id)?.account.asOf ?? "";
      const base = v.holdings;
      // a pair is kept only if it is not older than the one already kept: a late answer to an older read does not push out a newer pair
      const keep = (r: EarnPosition[]): EarnHeld[] => {
        const held = r.map(heldOf);
        const was = this.earnSeen.get(id);
        if (!was || was.asOf <= asOf) this.earnSeen.set(id, { asOf, base, held });
        return held;
      };
      const read = this.marketReads.get(`earn-held|${id}|${asOf}`, KEEP_HELD_MS, () => x.positions(), id);
      // whenever it answers, the next page has it, beside the balance it was read with
      void read.then((r) => (isRefusal(r) ? undefined : keep(r))).catch(() => undefined);
      const r = await within(3_000, read, id, this.nameOf(id));
      if (!isRefusal(r)) {
        const held = keep(r);
        return { v, base, held, stale: false, shares: await this.vaultShares(held) };
      }
      const seen = this.earnSeen.get(id);
      // its earn has never answered: there is nothing of it to show, and no pair — and the venue is marked, so a net worth point taken now
      // is partial and what later turns up in its earn products is money that appeared, not a gain
      if (!seen) return { v, base, held: [] as EarnHeld[], stale: true, shares: new Map<string, string>(), why: "its earn has not answered yet: what is in its earn products is not counted" };
      const shares = await this.vaultShares(seen.held);
      // the earn last answered beside this very balance read: the two are one moment's, only that moment is not now
      if (seen.asOf === asOf) return { v, base, held: seen.held, stale: seen.held.length > 0, shares };
      const at = Date.parse(seen.asOf);
      if (Number.isFinite(at) && now - at <= PAIR_MS) return { v, base: seen.base, held: seen.held, stale: true, shares, asOf: seen.asOf, why: `its earn did not answer in time, so its balance and its earn are both as read together at ${new Date(at).toISOString().slice(11, 19)} UTC` };
      return { v, base, held: seen.held, stale: true, shares, why: "its earn did not answer: what is in its earn products is the last read, beside a newer balance" };
    }));
    let delta = 0;
    for (const { v, base, held, stale, shares, asOf, why } of got) {
      if (why) {
        v.stale ??= why;
        if (asOf) v.asOf = asOf;
      }
      if (!held.length && base === v.holdings) continue;
      const before = v.usd;
      v.holdings = withEarn({ name: v.name, holdings: base }, held, { stale, shares }).holdings;
      v.usd = Number(v.holdings.reduce((s, h) => s + h.usd, 0).toFixed(2));
      v.cashUsd = Number(v.holdings.filter((h) => (h.class === "stable" || h.class === "cash") && !h.inTransit).reduce((s, h) => s + h.usd, 0).toFixed(2));
      delta += v.usd - before;
    }
    if (delta === 0) return;
    page.liveUsd = Number((page.liveUsd + delta).toFixed(2));
    page.totalUsd = Number((page.totalUsd + delta).toFixed(2));
  }

  /** the share token's symbol of each vault held (`<chain id>:<vault>` products), read from its chain once and kept; at most two seconds */
  private async vaultShares(held: EarnHeld[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const chain = this.liveDeps().chain;
    await Promise.all(held.map(async (p) => {
      const m = /^(\d{1,9}):(0x[0-9a-fA-F]{40})$/.exec(p.product);
      if (!m) return;
      const known = this.shareSymbols.get(p.product);
      if (known) return void out.set(p.product, known);
      const name = CHAIN_BY_ID.get(Number(m[1]));
      if (!name || !chain.symbol) return;
      const sym = await within(2_000, chain.symbol(name, m[2] as Hex).then((x) => x ?? no("E_VENUE_UNREACHABLE", { message: "no symbol" })), "chain", name);
      if (typeof sym === "string") {
        this.shareSymbols.set(p.product, sym);
        out.set(p.product, sym);
      }
    }));
    return out;
  }

  /** push the simulated clock ahead and land whatever came due on the way */
  async advance(ms: number): Promise<string> {
    if (!(ms > 0)) return this.now();
    this.skewMs += ms;
    this.ledger.append({ kind: "note", venue: "*", reason: `simulated clock +${Math.round(ms / 60_000)} min → ${this.now()}` });
    await this.account?.settle();
    return this.now();
  }

  static async create(opts: ServiceOptions): Promise<PortfolioService> {
    const seeds = opts.seeds ?? loadSeeds(opts.venues);
    // the `mm` reads stand in for two simulated accounts; a real service has none to stand in for (MetaMask is connected like any account)
    const live = opts.live && !opts.real ? { metamask: await metamaskLiveAccount(opts.mm), polymarket: await polymarketLiveAccount(opts.mm) } : undefined;
    const svc = new PortfolioService(opts, seeds, live);
    if (opts.real && svc.account && !opts.freshLedger) await svc.continueRuns();
    return svc;
  }

  /** A real account continues its earlier runs (account/restore.ts): this run's first row says which file it continues; the owner, the agents,
   * their limits, the dial and the ids come back at once — every signature checked again — and the venues are connected again in the
   * background, the door holding every instruction until they have been. `--fresh` starts from nothing instead */
  private async continueRuns(): Promise<void> {
    const engine = this.account!;
    const history = readHistory(join(this.opts.home, "portfolio"), this.ledger.path(), this.now);
    const fresh = this.opts.fresh === true || history.last === null;
    const mark: RunMark = { v: 1, continues: fresh ? null : history.last, fresh, n: history.lastRun + 1 };
    // a fresh account's first row also holds its dial, so that a restart keeps the session it started with rather than starting a new one
    this.ledger.append({ kind: "note", venue: "*", reason: fresh ? `account run started fresh${this.opts.fresh ? " (--fresh): nothing earlier is brought back" : ""}` : `account run started: it continues ${history.last}`, detail: { run: mark, ...(fresh ? this.dialNow() : {}) } });
    // the statement reads these files, the account's other runs and this run's — and no ledger that no account run wrote
    this.ledgerChain = fresh ? [] : history.files;
    if (fresh) return;
    // a replayed agent wallet is the key file it was made with: one that is gone is not made again under the same name (the wallet is
    // named, never the file: the message reaches the page and the agents' seats)
    const home = this.opts.home;
    const r = await rebuild(history.rows, engine.state, { ...engine.applyOptions(), codeRequired: (this.opts.liveWrites?.pairingCode ?? this.opts.pairingCode) !== undefined, walletAddress: (name) => (hasKey(agentWalletKeyPath(home, name)) ? (() => { const k = agentWalletKey(home, name); return isRefusal(k) ? k : (k.address as Hex); })() : no("E_ACCOUNT_CREDENTIAL", { message: `the agent wallet "${name}" is not brought back: its key file is gone from this account's home, and an agent wallet is the key it was made with`, detail: { wallet: name } })) });
    engine.adopt(r.state, r.ids);
    this.seq = Math.max(this.seq, r.ids.card);
    if (r.dial) this.adoptDial(r.dial);
    const report: RestoreReport = { runs: history.files.length, from: history.files[0] ?? "", owner: r.owner, agents: r.state.agents.filter((a) => a.revokedAt === undefined && a.validUntil > Date.parse(this.now())).length, limits: r.state.spends.filter((x) => x.revokedAt === undefined && x.validUntil > Date.parse(this.now())).length, mode: this.openness.mode === "open" ? "Beast" : "Guard", venues: r.connections.map((c) => ({ venue: c.venue, ok: false, why: "connecting again" })), orders: r.orders.length, payments: r.payments.length + r.authorisations.length + r.earns.length, skipped: [...r.skipped, ...(history.broken ? [`${history.broken.file}: its hash chain breaks${history.broken.at ? ` at row ${history.broken.at}` : ""}, so nothing after the break (and nothing older) was brought back`] : [])], state: "restoring" };
    this.restored = report;
    this.reconnecting = true;
    this.restoring = engine
      .serially(() => this.reconnect(r, report))
      .catch(() => undefined)
      .finally(() => void (this.reconnecting = false));
  }

  /** an agent wallet on the account: read from the chains, proven the user's (the account holds its key), a place money can be sent to */
  private async plugAgentWallet(sub: SubAccount): Promise<void> {
    const venue = agentWalletVenue(sub.name);
    if (this.adapters.get(venue)?.account.watchOnly) return;
    const key = agentWalletKey(this.opts.home, sub.name);
    if (isRefusal(key)) return void this.ledger.append({ kind: "note", venue, reason: `the agent wallet "${sub.name}" is not shown: ${key.message}` });
    const deps = this.liveDeps();
    const opened = await agentWalletSource({ venue, label: `Agent wallet · ${sub.name}`, key, chain: deps.chain, sender: deps.sender ?? publicSender() });
    if (isRefusal(opened)) return void this.ledger.append({ kind: "note", venue, reason: `the agent wallet "${sub.name}" could not be read: ${opened.message}` });
    const adapter = await liveAccount(venue, opened.source, { connector: "live:agent-wallet", first: opened.first, clock: deps.clock, price: deps.price });
    const proven = "this account holds its key";
    Object.assign(adapter.account, { proven, liveCan: opened.source.writer!.can, noTradeBecause: opened.source.noTradeBecause, plugged: true });
    this.liveVenues.set(venue, { id: venue, name: adapter.account.name, kind: adapter.account.kind, address: key.address, proven, writer: opened.source.writer!, noTradeBecause: opened.source.noTradeBecause!, via: opened.source.via });
    this.adapters.set(venue, adapter);
    // one more venue on the account: Markets and the comparison are asked again
    this.marketReads.forgetAll(["explore", "compare"]);
  }

  /** the restore's second half: the venues, from the same credential references the owner signed; then what was in flight, followed again */
  private async reconnect(r: Rebuilt, report: RestoreReport): Promise<void> {
    const engine = this.account!;
    // the agent wallets the owner made: their keys are where they were made, in this home
    for (const sub of r.state.subAccounts) await this.plugAgentWallet(sub);
    for (const [i, c] of r.connections.entries()) {
      // a wallet's proof is the signature it gave, checked again; one that no longer checks out connects the address as watched
      if (c.proof && (await proofHolds(c.proof))) this.proofs.keep(c.proof);
      const out = await this.plugAgain(c);
      if (isRefusal(out) && passingAtStart(out)) {
        // not an answer of the venue's or the key's: how this network was just then. Asked again later, never given up for the run
        const w = { c, i, report, tries: 0, last: out };
        this.comingBack.set(c.venue, w);
        report.venues[i] = { venue: c.venue, ok: false, why: "connecting again", waiting: true, said: this.waitLater(w) };
        this.ledger.append({ kind: "note", venue: c.venue, reason: `not connected again after the restart yet: ${report.venues[i]!.said}` });
        continue;
      }
      report.venues[i] = isRefusal(out) ? { venue: c.venue, ok: false, why: out.message } : { venue: c.venue, ok: true };
      this.ledger.append({ kind: "note", venue: c.venue, reason: isRefusal(out) ? `not connected again after the restart: ${out.message}` : `connected again after the restart · ${out.summary}` });
    }
    for (const o of r.orders) engine.trade.adopt(o);
    for (const p of r.payments) engine.live.adopt(p);
    for (const e of r.earns) engine.earn.adopt(e);
    for (const k of r.authorisations) engine.adoptAuthorisation(k);
    report.state = "done";
    const back = report.venues.filter((v) => v.ok).length;
    const waiting = report.venues.filter((v) => v.waiting).length;
    this.ledger.append({ kind: "note", venue: "*", reason: `restored after a restart: ${report.owner ? "your device is still the owner" : "no owner yet"} · ${report.agents} agent${report.agents === 1 ? "" : "s"} · ${report.limits} limit${report.limits === 1 ? "" : "s"} · ${back} of ${report.venues.length} venue${report.venues.length === 1 ? "" : "s"} connected again${waiting ? ` (${waiting} asked again when ${waiting === 1 ? "it answers" : "they answer"})` : ""} · ${report.orders} order${report.orders === 1 ? "" : "s"} and ${report.payments} movement${report.payments === 1 ? "" : "s"} followed again · ${report.mode}${report.skipped.length ? ` · ${report.skipped.length} not brought back` : ""}`, detail: { restore: report } });
  }

  /** one saved connection, connected again from the credential reference the owner signed; a throw is no answer (its words, with this
   * machine's address taken out before they are cut) */
  private async plugAgain(c: Rebuilt["connections"][number]): Promise<Awaited<ReturnType<PortfolioService["plugLive"]>>> {
    try {
      return c.connector.startsWith("live:") ? await this.plugLive(c.venue, c.connector, c.label, c.credentialRef) : no("E_ACCOUNT_BAD_ACTION", { venue: c.venue, message: "not a live connection" });
    } catch (err) {
      return no("E_VENUE_UNREACHABLE", { venue: c.venue, message: unaddressed(String((err as Error)?.message ?? err)).slice(0, 160) });
    }
  }

  /** The restore's connections that did not come back at start-up because the network did not let them just then (no network yet at
   * login, a captive portal, an outage, a ban until its time, Hyperliquid's place not known just now, a place rule or edge page of a network
   * the laptop was passing through), by venue. Each is asked again — on a backoff (15 s, 30 s, 1 min … a quarter of an hour at most; a held
   * refusal not before its hold runs out), and at once when a re-check of this network finds its venue answering — until it connects. The
   * owner connecting or disconnecting the venue meanwhile wins, and ends it. A place rule or an edge page is asked again only by such a
   * re-check: the venue's own rule is not knocked on, only learned again when the network has changed */
  private readonly comingBack = new Map<string, { c: Rebuilt["connections"][number]; i: number; report: RestoreReport; tries: number; last: Refusal; timer?: ReturnType<typeof setTimeout> | undefined; asking?: boolean | undefined }>();

  /** the next ask for a connection waiting to come back, and the words for it */
  private waitLater(w: { c: Rebuilt["connections"][number]; tries: number; last: Refusal; timer?: ReturnType<typeof setTimeout> | undefined }): string {
    if (w.timer) clearTimeout(w.timer);
    w.timer = undefined;
    if (w.last.code === "E_VENUE_GEOBLOCKED") return `${w.last.message} — asked again when a check of this network finds it answering (Check again, or the half-hourly check)`;
    const ms = Math.max(COMING_BACK_MS[Math.min(w.tries, COMING_BACK_MS.length - 1)]!, holdBackMs(w.last));
    w.timer = setTimeout(() => void this.tryAgain(w.c.venue), ms);
    w.timer.unref?.();
    return `${w.last.message} — asked again in ${waitText(ms)}`;
  }

  /** a connection that did not come back after the restart, asked again now: through the door's line, as the restore itself was, so an
   * instruction is not let through halfway; a venue the owner connected in the meantime is left as the owner connected it */
  private async tryAgain(venue: string): Promise<void> {
    const w = this.comingBack.get(venue);
    // asked already (a re-check and the backoff at once): one ask at a time
    if (!w || w.asking || !this.account) return;
    if (w.timer) clearTimeout(w.timer);
    w.timer = undefined;
    w.asking = true;
    // the venue's own keyless question first, outside the account's line: a venue this network still leaves unanswered (or refuses) is not
    // connected under the line, which every signed instruction waits on — one blackholed venue must not stall the others' orders and cancels
    let out: Awaited<ReturnType<PortfolioService["plugAgain"]>> | undefined;
    try {
      const here = await this.connectReach([w.c.connector]).then(([x]) => x, () => undefined);
      out = here && (here.state === "unreachable" || here.state === "location")
        ? no(here.state === "location" ? "E_VENUE_GEOBLOCKED" : "E_VENUE_UNREACHABLE", { venue, message: here.said ?? `${w.c.label || venue} did not answer`, ...(here.until ? { native: { until: here.until } } : {}) })
        : await this.account.serially(async () => (this.comingBack.get(venue) !== w || this.adapters.get(venue)?.account.watchOnly ? undefined : this.plugAgain(w.c)));
    } finally {
      w.asking = false;
    }
    // stopped meanwhile (the owner connected or disconnected it), or connected some other way: nothing more to ask
    if (this.comingBack.get(venue) !== w) return;
    if (out === undefined) return void this.stopComingBack(venue, true);
    w.tries++;
    if (!isRefusal(out)) {
      this.comingBack.delete(venue);
      w.report.venues[w.i] = { venue, ok: true };
      this.ledger.append({ kind: "note", venue, reason: `connected again after the restart (asked ${w.tries + 1} times) · ${out.summary}` });
      return;
    }
    if (!passingAtStart(out)) {
      this.comingBack.delete(venue);
      w.report.venues[w.i] = { venue, ok: false, why: out.message };
      this.ledger.append({ kind: "note", venue, reason: `not connected again after the restart: ${out.message}` });
      return;
    }
    w.last = out;
    w.report.venues[w.i] = { venue, ok: false, why: "connecting again", waiting: true, said: this.waitLater(w) };
  }

  /** the owner connected or disconnected a venue that was waiting to come back after the restart: the owner's act stands, and no more is
   * asked for it. `connected`: what the restore's report says of it now */
  private stopComingBack(venue: string, connected: boolean): boolean {
    const w = this.comingBack.get(venue);
    if (!w) return false;
    if (w.timer) clearTimeout(w.timer);
    this.comingBack.delete(venue);
    w.report.venues[w.i] = connected ? { venue, ok: true } : { venue, ok: false, why: "disconnected by the owner while it was waiting to come back" };
    return true;
  }

  /** while a venue is waiting to come back after the restart: why, in the words its restore line gives — what the account's door tells
   * someone who asks it to act there meanwhile (a cancel is not "unfollowed" while the venue may still answer) */
  restoreWaiting(venue: string): string | undefined {
    const w = this.comingBack.get(venue);
    return w ? `${w.c.label || venue} has not come back after the restart yet: ${w.report.venues[w.i]?.said ?? w.last.message}` : undefined;
  }

  /** the dial as the ledger last recorded it, the agents' session included: a restart neither opens a session the owner ended nor lengthens one
   * (a new session is the owner's to sign) */
  private adoptDial(d: DialSnapshot): void {
    // never later than this start would give a new account: a row cannot lengthen the session past what a restart grants anyway
    const session = d.sessionExpiresAt && (!this.openness.sessionExpiresAt || Date.parse(d.sessionExpiresAt) < Date.parse(this.openness.sessionExpiresAt)) ? d.sessionExpiresAt : this.openness.sessionExpiresAt;
    this.openness = { ...this.openness, mode: d.mode, revoked: d.revoked, reach: d.reach as Openness["reach"], ...(session ? { sessionExpiresAt: session } : {}), ...(d.maxLeverage !== undefined ? { maxLeverage: d.maxLeverage } : {}) };
  }

  /** the dial now, as the note rows record it after each change: a restart reads the last one */
  private dialNow(): { dial: DialSnapshot } {
    const ended = !!this.openness.sessionExpiresAt && Date.parse(this.openness.sessionExpiresAt) <= Date.parse(this.now());
    return { dial: { mode: this.openness.mode === "open" ? "open" : "guard", revoked: [...this.openness.revoked], reach: { ...this.openness.reach }, ...(this.openness.sessionExpiresAt ? { sessionExpiresAt: this.openness.sessionExpiresAt } : {}), ...(ended ? { ended: true } : {}), ...(this.openness.maxLeverage !== undefined ? { maxLeverage: this.openness.maxLeverage } : {}) } };
  }

  private openLedger(): Ledger {
    const stamp = this.now().replace(/[:.]/g, "-");
    const file = join(this.opts.home, "portfolio", `ledger-${stamp}.jsonl`);
    if (this.opts.freshLedger) rmSync(file, { force: true });
    return new Ledger(file, this.now);
  }

  /** the five simulators are rebuilt from the seeds; the live account is kept (its state is MetaMask's, not ours) */
  private mount(): void {
    const s = this.seeds;
    // a fresh mount is the simulation from its seeds: whatever was connected live is gone with the rest
    this.shadowed.clear();
    this.liveVenues?.clear();
    this.earners?.clear();
    // a real service starts empty: the owner connects what is there
    if (this.opts.real) return void (this.adapters = new Map());
    // the simulated wallet reads its allowlist from this array, so a venue plugged in later can be added to it
    this.walletAllow.length = 0;
    this.walletAllow.push(...s.metamask.allowlist);
    const list: AccountAdapter[] = [binanceAccount(s.binance), okxAccount(s.okx), this.liveAccounts?.metamask ?? metamaskSimAccount({ ...s.metamask, allowlist: this.walletAllow }, this.now), this.liveAccounts?.polymarket ?? polymarketSimAccount(s.polymarket, this.now), kalshiAccount(s.kalshi, this.now), ondoAccount(s.ondo, this.now)];
    if (s.alpaca) list.push(alpacaAccount(s.alpaca, this.now));
    if (s.hyperliquid) list.push(hyperliquidAccount(s.hyperliquid, this.now));
    this.adapters = new Map(list.map((a) => [a.account.id, a]));
  }

  accounts(): Account[] {
    return [...this.adapters.values()].map((a) => a.account).sort((x, y) => KIND_ORDER.indexOf(x.kind) - KIND_ORDER.indexOf(y.kind) || x.id.localeCompare(y.id));
  }

  adapter(id: string): AccountAdapter | undefined {
    return this.adapters.get(id);
  }

  nameOf(id: string): string {
    return this.adapters.get(id)?.account.name ?? id;
  }

  policy(): Openness {
    return this.openness;
  }

  // ---- reads: never gated -----------------------------------------------------

  async read(accountId?: string): Promise<Holding[]> {
    const targets = accountId ? [this.adapters.get(accountId)].filter((a): a is AccountAdapter => !!a) : [...this.adapters.values()];
    const rows = (await Promise.all(targets.map((a) => a.read()))).flat();
    this.ledger.append({ kind: "read", venue: accountId ?? "*", tool: "portfolio_read", outcome: `${rows.length} holdings across ${targets.length} account(s) · no card` });
    return rows;
  }

  async views(): Promise<AccountView[]> {
    return Promise.all(
      this.accounts().map(async (acct) => {
        const a = this.adapters.get(acct.id)!;
        let holdings: Holding[] = [];
        let readError: string | undefined;
        try {
          holdings = await a.read();
        } catch (err) {
          readError = (err as Error).message;
        }
        const view: AccountView = {
          ...acct,
          kindLabel: KIND_LABEL[acct.kind],
          enforcerLabel: ENFORCER_LABEL[acct.scope.enforcedBy],
          reach: effectiveReach(acct, this.openness),
          revoked: this.openness.revoked.includes(acct.id),
          usd: r2(holdings.reduce((s, h) => s + h.usd, 0)),
          holdings,
        };
        if (readError !== undefined) view.readError = readError;
        return view;
      }),
    );
  }

  /** the account holds real accounts only (the server's default): no simulated venue, dial or payee is on it */
  get real(): boolean {
    return this.opts.real === true;
  }

  /** The statement page's whole view. On a real account every venue is read as the account page reads it (`accountView`: what is in its
   * earn products counted, once, with its balance), so the totals here are the ones /api/account and /holdings give; the simulation's dial,
   * its compiled openness and the agent's day against its cap are left out, and `live` says whether venues connected live are on it */
  async overview(): Promise<Overview> {
    const now = this.now();
    const accounts = this.accounts();
    const views = await this.views();
    const page = this.real && this.account ? await this.accountView() : undefined;
    if (page) {
      for (const v of views) {
        const pv = page.venues.find((x) => x.id === v.id);
        if (!pv) continue;
        v.usd = pv.usd;
        v.holdings = pv.holdings.map((h) => ({ account: v.id, asset: h.asset, amount: h.amount, usd: h.usd, class: h.class, ...(h.note ? { note: h.note } : {}), ...(h.inTransit ? { inTransit: true } : {}) }));
      }
    }
    const holdings = views.flatMap((v) => v.holdings);
    const agents = new Map<string, AgentId & { flights: number }>();
    for (const f of this.flights) {
      const a = agents.get(f.agent.id) ?? { ...f.agent, flights: 0 };
      a.flights++;
      agents.set(f.agent.id, a);
    }
    const portfolio = aggregate(accounts, holdings);
    // the account page's total also counts money in flight between venues and what open payment sessions hold: the same number here
    if (page) portfolio.totalUsd = page.totalUsd;
    return {
      now,
      live: page ? views.some((v) => v.live === true) : this.live,
      mode: this.openness.mode,
      session: { expiresAt: this.openness.sessionExpiresAt, expired: isExpired(now, this.openness.sessionExpiresAt) },
      portfolio,
      // a real account's dollars move as each venue's own writer says they can (account/holdings.ts movesOut), and no route to a hub is
      // quoted from the simulation's rail table: the ladder is empty there. The simulated statement keeps both as they were
      liquidity: page ? liveLiquidity(page) : liquidity(views),
      ladder: page ? ladder([]) : ladder(views),
      accounts: views,
      ...(page ? {} : { compiled: compileOpenness(accounts, this.openness), openness: this.openness, daily: { used: this.dailyOutUsd(now), cap: this.openness.guard.dailyCapUsd } }),
      approvals: [...this.approvals],
      flights: this.flights.slice(-40),
      agents: [...agents.values()],
      ledger: [...this.ledger.all()].reverse().slice(0, 80),
      chain: this.ledger.verifyChain(),
      counters: { ...this.counters },
      ledgerPath: this.ledger.path(),
    };
  }

  /** USD the agent moved through the venues in the 24 h before `now` (ok writes only) */
  dailyOutUsd(now: string): number {
    const since = Date.parse(now) - 24 * 3600 * 1000;
    const moved = this.ledger.byKind("venue").filter((r) => Date.parse(r.ts) > since).reduce((s, r) => s + (r.notionalUsd ?? 0), 0);
    // what an agent key moved through the account layer counts too; what the owner signed never does
    const viaAccount = this.account ? this.ledger.byKind("action").filter((r) => r.outcome === "accepted" && r.agent !== undefined && Date.parse(r.ts) > since).reduce((s, r) => s + (r.notionalUsd ?? 0), 0) : 0;
    return r2(moved + viaAccount);
  }

  // ---- flights ------------------------------------------------------------------

  openFlight(agent: AgentId, request: string): Flight {
    const no = `${agent.code}-${String(++this.flightSeq).padStart(4, "0")}`;
    const f: Flight = { no, agent, at: this.now(), request, legs: [] };
    this.flights.push(f);
    this.ledger.append({ kind: "note", venue: "*", flight: no, agent: agent.id, reason: `flight ${no} · ${agent.name} · ${request}` });
    return f;
  }

  flight(no: string): Flight | undefined {
    return this.flights.find((f) => f.no === no);
  }

  note(f: Flight, text: string, mark: Mark = "note"): Leg {
    const leg: Leg = { seq: f.legs.length + 1, mark, text };
    f.legs.push(leg);
    return leg;
  }

  /** one leg of a flight: the wallet's checks, then the venue; the leg is written in the agent's words */
  async fly(f: Flight, accountId: string, intent: Intent, say?: string, compare?: string): Promise<ExecuteOutcome> {
    const r = await this.write(f, accountId, intent);
    const words = say ?? sayOf(intent, this.nameOf(accountId));
    if (isPending(r)) {
      const leg: Leg = { seq: f.legs.length + 1, mark: "wait", text: `${words}: ${waitWords(r.approval.why)}`, account: accountId, intent, usd: r.approval.usd, approvalId: r.approval.id };
      if (compare !== undefined) leg.compare = compare;
      f.legs.push(leg);
    } else this.land(f, words, accountId, intent, r, compare);
    return r;
  }

  /** a write that reached its venue, as a leg: the fill and what it netted, or the refusal in plain words; a DEX swap shows its route */
  private land(f: Flight, words: string, accountId: string, intent: Intent, r: ExecResult, compare?: string): Leg {
    const leg: Leg = { seq: f.legs.length + 1, mark: "ok", text: words, account: accountId, intent };
    if (isRefusal(r)) {
      leg.mark = "no";
      leg.text = `${words}: ${plainRefusal(r, (id) => this.nameOf(id))}`;
      if (compare !== undefined) leg.compare = compare;
    } else {
      leg.text = `${words}${detailOf(intent, r)}`;
      leg.usd = r.usd;
      const line = [routeLine(r.native), compare].filter((x): x is string => !!x).join("; ");
      if (line) leg.compare = line;
    }
    f.legs.push(leg);
    return leg;
  }

  /** the slices of ONE order. The wallet judges the order as a whole — its total against the allowance and the daily cap — and asks the human once; nothing goes to a venue until every slice has passed. */
  async flyBatch(f: Flight, title: string, steps: BatchStep[]): Promise<ExecuteOutcome[]> {
    if (steps.length <= 1) {
      const out: ExecuteOutcome[] = [];
      for (const s of steps) out.push(await this.fly(f, s.account, s.intent, s.say, s.compare));
      return out;
    }
    const ctx = { flight: f.no, agent: f.agent.id };
    const now = this.now();
    const daily = this.dailyOutUsd(now);
    const orderUsd = r2(steps.reduce((s, x) => s + usdOf(x.intent), 0));
    const label = `${title} (${steps.length} slices)`;
    let refusal: Refusal | undefined;
    let card: Card | undefined;
    let before = 0;
    for (const s of steps) {
      const tool = `portfolio_${s.intent.kind}`;
      const a = this.adapters.get(s.account);
      if (!a) {
        const r = no("E_WALLET_ACCOUNT_UNKNOWN", { venue: s.account, tool, detail: { known: [...this.adapters.keys()] } });
        this.ledger.append({ kind: "openness-refusal", venue: s.account, tool, code: r.code, reason: r.message, args: { ...s.intent }, ...ctx });
        refusal ??= r;
        continue;
      }
      this.ledger.append({ kind: "intent", venue: s.account, tool, args: { ...s.intent }, notionalUsd: usdOf(s.intent), reason: `${label} · ${describeIntent(s.intent)}`, ...ctx });
      const v = evaluate({ intent: s.intent, account: a.account, openness: this.openness, now, dailyOutUsd: daily + before, orderUsd });
      before += usdOf(s.intent);
      if (isRefusal(v)) {
        this.ledger.append({ kind: "openness-refusal", venue: s.account, tool, code: v.code, reason: v.message, detail: v.detail, ...ctx });
        refusal ??= v;
      } else if (v.card) card ??= v.card;
    }
    if (refusal) {
      this.counters.refusals++;
      f.legs.push({ seq: f.legs.length + 1, mark: "no", text: `${label}: ${plainRefusal(refusal, (id) => this.nameOf(id))}` });
      return steps.map(() => refusal);
    }
    if (card) {
      const first = steps[0]!;
      const approval: Approval = { id: `card-${String(++this.seq).padStart(4, "0")}`, at: now, account: first.account, intent: first.intent, usd: orderUsd, reason: card.reason, status: "pending", why: card.why, flight: f.no, batch: steps.map((s) => ({ ...s })), title: label, ...this.cardLife(now) };
      this.approvals.unshift(approval);
      this.counters.cards++;
      this.ledger.append({ kind: "card", venue: "*", intentId: approval.id, tool: "portfolio_order", outcome: "pending", reason: card.reason, notionalUsd: orderUsd, args: { slices: steps.map((s) => ({ account: s.account, ...s.intent })) }, ...ctx });
      f.legs.push({ seq: f.legs.length + 1, mark: "wait", text: `${label}: ${waitWords(card.why)}`, usd: orderUsd, approvalId: approval.id });
      return steps.map(() => ({ ok: true, pending: true, approval }));
    }
    const out: ExecuteOutcome[] = [];
    for (const s of steps) {
      const r = await this.settle(this.adapters.get(s.account)!, s.intent, undefined, ctx);
      this.land(f, s.say ?? sayOf(s.intent, this.nameOf(s.account)), s.account, s.intent, r, s.compare);
      out.push(r);
    }
    return out;
  }

  // ---- the routing service --------------------------------------------------------

  /** one order priced at every venue and split across them; a read (no card, nothing moves) */
  async quote(base: string, side: Side, qty: number): Promise<OrderPlan> {
    const plan = orderPlan(base, side, qty, await this.views(), this.now());
    this.ledger.append({ kind: "read", venue: "*", tool: "portfolio_quote", outcome: `${plan.title} · ${plan.split.quotes.length} venue(s) quoted · ${plan.split.slices.length} slice(s) · no card` });
    return plan;
  }

  /** route an order and fly it: one flight, one leg per slice, one card at most */
  async order(base: string, side: Side, qty: number, agent: AgentId = SCRIPT_AGENT): Promise<{ flight: Flight; plan: OrderPlan; outcomes: ExecuteOutcome[] }> {
    const plan = await this.quote(base, side, qty);
    const f = this.openFlight(agent, plan.title);
    const first = this.note(f, plan.narration);
    if (plan.parts) first.parts = plan.parts;
    const outcomes = await this.flyBatch(f, plan.title, plan.steps);
    await this.closeOrder(f, plan, outcomes);
    return { flight: f, plan, outcomes };
  }

  /** the event contracts an agent can trade on the simulated statement: each question, its state, and every venue's top of book. A real
   * account has no fixture: its event markets are what its venues list (explore) */
  markets(): MarketView[] {
    if (this.real) return [];
    const now = this.now();
    return EVENTS.map((e) => ({
      id: e.id,
      title: e.title,
      closesAt: e.closesAt,
      state: eventState(e, now),
      ...(e.resolved ? { resolved: e.resolved } : {}),
      symbols: [eventSymbol(e.id, "YES"), eventSymbol(e.id, "NO")],
      venues: Object.entries(e.listings).map(([venue, l]) => ({ venue, name: PREDICTION_VENUES[venue]?.name ?? venue, ticker: l.ticker, yes: eventTop(venue, eventSymbol(e.id, "YES")), rules: l.rules })),
    }));
  }

  /** the lines after an order's legs: what the plan left out, what the live wallet adds, and — only once it has filled — where the proceeds are (a pending card keeps that line until it is approved) */
  async closeOrder(f: Flight, plan: OrderPlan, outcomes: Array<ExecuteOutcome | null>): Promise<void> {
    for (const n of [...plan.notes, ...(await this.liveNotes(plan))]) this.note(f, n);
    if (!plan.after.length) return;
    const pending = outcomes.find((r): r is Pending => r !== null && isPending(r));
    if (pending) pending.approval.notes = plan.after;
    else if (outcomes.some((r) => r !== null && r.ok === true)) for (const n of plan.after) this.note(f, n);
  }

  /** what the LIVE MetaMask wallet can add to an order, read-only: the real spot price, and — for a DEX slice — the real swap quote, or why it could not be read */
  async liveNotes(plan: OrderPlan): Promise<string[]> {
    const mm = this.adapters.get("metamask");
    if (!this.live || !mm) return [];
    const notes: string[] = [];
    if (isEventSymbol(plan.base)) {
      // the real Polymarket book behind this contract: public data, readable even where orders are not taken
      try {
        const m = await this.adapters.get("polymarket")?.market?.(plan.base, plan.side, plan.qty);
        if (m) notes.push(`Live Polymarket book for "${m.question}" (mm predict): bid ${m.bid ?? "–"} · ask ${m.ask ?? "–"}${m.amountUsd !== undefined && m.filled ? `; ${plan.side === "buy" ? "buying" : "selling"} ${qtyText(m.filled)} there would ${plan.side === "buy" ? "cost" : "bring"} about ${cents(m.amountUsd)}` : ""}. The venue quotes above use the fixed table.`);
      } catch {
        // a market that has since closed, or a CLI that does not answer, is not worth a line
      }
      return notes;
    }
    if (!plan.steps.length) return [];
    try {
      const spot = await mm.spot?.(plan.base);
      if (spot !== undefined) notes.push(`Live spot price ${cents(spot)} (mm price spot); the venue quotes above use the fixed table at ${cents(PRICES[plan.base] ?? 0)}.`);
    } catch {
      // a price feed that does not answer is not worth a line
    }
    const dex = plan.steps.find((s) => s.account === "metamask" && s.intent.kind === "trade");
    if (dex && mm.quote) {
      try {
        const best = (await mm.quote(dex.intent)).sort((a, b) => (b.outUsd ?? 0) - (a.outUsd ?? 0) || a.feeUsd - b.feeUsd)[0];
        if (best) notes.push(`The live wallet's DEX quote (mm swap quote): ${best.label}${best.outUsd !== undefined ? ` · about ${cents(best.outUsd)} out` : ""} · fee ${cents(best.feeUsd)}.`);
      } catch (err) {
        const message = (err as Error).message;
        notes.push(`The live wallet could not give a DEX quote (${/"code":"([A-Z_]+)"/.exec(message)?.[1] ?? message.slice(0, 80)}); the DEX slice uses the simulated pools.`);
      }
    }
    return notes;
  }

  /** the MCP server's (and the demo's) write: a flight of one leg */
  async execute(accountId: string, intent: Intent, agent: AgentId = SCRIPT_AGENT): Promise<ExecuteOutcome> {
    const f = this.openFlight(agent, describeIntent(intent));
    return this.fly(f, accountId, intent);
  }

  private async write(f: Flight, accountId: string, intent: Intent): Promise<ExecuteOutcome> {
    const tool = `portfolio_${intent.kind}`;
    const ctx = { flight: f.no, agent: f.agent.id };
    const a = this.adapters.get(accountId);
    if (!a) {
      const r = no("E_WALLET_ACCOUNT_UNKNOWN", { venue: accountId, tool, detail: { known: [...this.adapters.keys()] } });
      this.counters.refusals++;
      this.ledger.append({ kind: "openness-refusal", venue: accountId, tool, code: r.code, reason: r.message, args: { ...intent }, ...ctx });
      return r;
    }
    const now = this.now();
    this.ledger.append({ kind: "intent", venue: accountId, tool, args: { ...intent }, notionalUsd: usdOf(intent), reason: describeIntent(intent), ...ctx });
    const v = evaluate({ intent, account: a.account, openness: this.openness, now, dailyOutUsd: this.dailyOutUsd(now) });
    if (isRefusal(v)) {
      this.counters.refusals++;
      this.ledger.append({ kind: "openness-refusal", venue: accountId, tool, code: v.code, reason: v.message, detail: v.detail, ...ctx });
      return v;
    }
    // the account layer: a first payment to a payee the owner has never paid is the owner's to approve, in any mode
    const card = v.card;
    if (card) {
      const approval: Approval = { id: `card-${String(++this.seq).padStart(4, "0")}`, at: now, account: accountId, intent, usd: v.usd, reason: card.reason, status: "pending", why: card.why, flight: f.no, ...this.cardLife(now) };
      this.approvals.unshift(approval);
      this.counters.cards++;
      this.ledger.append({ kind: "card", venue: accountId, intentId: approval.id, tool, outcome: "pending", reason: card.reason, notionalUsd: v.usd, args: { ...intent }, ...ctx });
      return { ok: true, pending: true, approval };
    }
    return this.settle(a, intent, undefined, ctx);
  }

  /** with the account layer mounted a card expires; without it (the original demo) a card is as it always was */
  private cardLife(now: string): { expiresAt?: string } {
    return this.account ? { expiresAt: new Date(Date.parse(now) + CARD_TTL_MS).toISOString() } : {};
  }

  /** Is what a card would release still allowed, now? The card was raised under the conditions of that moment: the session may have ended since,
   * the account may have been switched off, the address blocklisted, the day's cap used up. A second card is not asked for; a refusal stops it. */
  private recheck(ap: Approval, now: string): Refusal | null {
    const steps: Array<{ account: string; intent: Intent }> = ap.batch ?? [{ account: ap.account, intent: ap.intent }];
    const orderUsd = ap.batch ? r2(steps.reduce((s, x) => s + usdOf(x.intent), 0)) : undefined;
    const daily = this.dailyOutUsd(now);
    let before = 0;
    for (const s of steps) {
      const a = this.adapters.get(s.account);
      if (!a) return no("E_WALLET_ACCOUNT_UNKNOWN", { venue: s.account });
      const v = evaluate({ intent: s.intent, account: a.account, openness: this.openness, now, dailyOutUsd: daily + before, ...(orderUsd !== undefined ? { orderUsd } : {}) });
      before += usdOf(s.intent);
      if (isRefusal(v)) return v;
    }
    return null;
  }

  private async settle(a: AccountAdapter, intent: Intent, approvalId: string | undefined, ctx: { flight?: string | undefined; agent?: string | undefined }, via?: string): Promise<ExecResult> {
    const r = await a.execute(intent);
    const prefix = via ? `${via} · ` : "";
    if (isRefusal(r)) {
      this.counters.refusals++;
      this.ledger.append({ kind: "venue-refusal", venue: a.account.id, intentId: approvalId, tool: `portfolio_${intent.kind}`, code: r.code, reason: `${prefix}${r.message}`, native: r.native, detail: r.detail, ...ctx });
      return r;
    }
    this.counters.writes++;
    this.ledger.append({ kind: "venue", venue: a.account.id, intentId: approvalId, tool: `portfolio_${intent.kind}`, outcome: r.status, notionalUsd: r.usd, reason: `${prefix}${r.summary}`, venueOrderId: r.ref, native: r.native, ...ctx });
    // the rail delivers: a move that landed at one of our own accounts credits it there
    if (intent.kind === "move" && r.status === "sent") {
      const dest = [...this.adapters.values()].find((d) => d.account.id !== a.account.id && (d.account.address === intent.to || d.account.id === intent.to));
      if (dest?.credit) {
        // a bridge takes its fee out of what arrives
        const arrived = typeof (r.native as { arrived?: unknown } | undefined)?.arrived === "number" ? (r.native as { arrived: number }).arrived : intent.amount;
        dest.credit(intent.asset, arrived, chainName(intent.chainId) ?? dest.account.chain);
        this.ledger.append({ kind: "funding", venue: dest.account.id, tool: "rail", notionalUsd: r2(arrived * (r.usd / intent.amount)), reason: `${arrived} ${intent.asset} arrived from ${a.account.id}${chainName(intent.chainId) ? ` on ${chainName(intent.chainId)}` : ""}`, ...ctx });
      }
    }
    return r;
  }

  async decide(approvalId: string, decision: "approve" | "reject"): Promise<ExecResult> {
    const ap = this.approvals.find((x) => x.id === approvalId && x.status === "pending");
    if (!ap) return no("E_CARD_NOT_GRANTED", { tool: "portfolio_approve", message: `no pending card ${approvalId}` });
    if (ap.action) return no("E_ACCOUNT_OWNER_SURFACE", { tool: "portfolio_approve", message: `card ${ap.id} releases a signed instruction: it is answered with the owner's signature (approveCard), not here`, detail: { approval: ap.id } });
    const f = this.flight(ap.flight);
    const ctx = { flight: ap.flight, agent: f?.agent.id };
    ap.decidedAt = this.now();
    const where = ap.batch ? "*" : ap.account;
    if (decision === "reject") {
      ap.status = "rejected";
      const r = no("E_CARD_REJECTED", { venue: ap.account, tool: ap.batch ? "portfolio_order" : `portfolio_${ap.intent.kind}`, message: `the human rejected this card: ${ap.title ?? describeIntent(ap.intent)}`, detail: { approval: ap.id } });
      ap.result = r;
      this.counters.refusals++;
      this.ledger.append({ kind: "card", venue: where, intentId: ap.id, outcome: "rejected", code: r.code, reason: r.message, ...ctx });
      if (f) this.note(f, "You rejected it; nothing moved", "no");
      return r;
    }
    ap.status = "approved";
    this.ledger.append({ kind: "card", venue: where, intentId: ap.id, outcome: "approved", reason: ap.reason, notionalUsd: ap.usd, ...ctx });
    const stale = this.recheck(ap, ap.decidedAt);
    if (stale) {
      ap.result = stale;
      this.counters.refusals++;
      this.ledger.append({ kind: "openness-refusal", venue: where, intentId: ap.id, tool: ap.batch ? "portfolio_order" : `portfolio_${ap.intent.kind}`, code: stale.code, reason: `at approval: ${stale.message}`, detail: stale.detail, ...ctx });
      if (f) this.note(f, `Approved, but ${plainRefusal(stale, (id) => this.nameOf(id))}`, "no");
      return stale;
    }
    if (ap.batch) {
      // one yes covers every slice of the order
      const results: ExecResult[] = [];
      for (const s of ap.batch) {
        const r = await this.settle(this.adapters.get(s.account)!, s.intent, ap.id, ctx);
        results.push(r);
        if (f) this.land(f, `Approved · ${s.say ?? sayOf(s.intent, this.nameOf(s.account))}`, s.account, s.intent, r, s.compare);
      }
      ap.results = results;
      const done = results.filter((r): r is ExecOk => !isRefusal(r));
      const summary: ExecResult = results.find(isRefusal) ?? { ok: true, account: [...new Set(ap.batch.map((s) => s.account))].join("+"), status: "filled", summary: `${ap.title ?? "order"} · ${done.length} slices filled`, usd: r2(done.reduce((s, r) => s + r.usd, 0)), ref: `flight:${ap.flight}`, native: { slices: done.map((r) => ({ account: r.account, ref: r.ref, usd: r.usd })) } };
      ap.result = summary;
      if (f && done.length) for (const n of ap.notes ?? []) this.note(f, n);
      return summary;
    }
    const r = await this.settle(this.adapters.get(ap.account)!, ap.intent, ap.id, ctx);
    ap.result = r;
    if (f) {
      if (isRefusal(r)) this.note(f, `Approved, but ${plainRefusal(r, (id) => this.nameOf(id))}`, "no");
      else {
        const leg = this.note(f, `Approved · ${sayOf(ap.intent, this.nameOf(ap.account))}${detailOf(ap.intent, r)}`, "ok");
        leg.usd = r.usd;
        leg.account = ap.account;
        const route = routeLine(r.native);
        if (route) leg.compare = route;
        for (const n of ap.notes ?? []) this.note(f, n);
      }
    }
    return r;
  }

  /** a compromised agent with the credential, talking to the venue directly: the wallet is not consulted, the ledger still sees it (the operator records it) */
  async bypass(accountId: string, intent: Intent): Promise<ExecResult> {
    const a = this.adapters.get(accountId);
    if (!a) return no("E_WALLET_ACCOUNT_UNKNOWN", { venue: accountId });
    this.ledger.append({ kind: "bypass", venue: accountId, tool: `portfolio_${intent.kind}`, args: { ...intent }, reason: `bypassing the wallet, straight to the venue with the credential: ${describeIntent(intent)}` });
    return this.settle(a, intent, undefined, {}, "bypass");
  }

  // ---- the dial -----------------------------------------------------------------

  setMode(mode: Mode): void {
    this.openness = { ...this.openness, mode };
    this.ledger.append({ kind: "note", venue: "*", reason: `mode → ${mode}`, detail: this.dialNow() });
  }

  /** narrow (or restore) what the agent may do at one account; `read` is always on, and a full set means "maximal" (the entry is dropped) */
  setReach(accountId: string, caps: Capability[]): Refusal | { ok: true; reach: Capability[] } {
    const a = this.adapters.get(accountId);
    if (!a) return no("E_WALLET_ACCOUNT_UNKNOWN", { venue: accountId });
    const writes = caps.filter((c): c is Capability => WRITE_CAPS.includes(c) && a.account.scope.can.includes(c));
    const reach = { ...this.openness.reach };
    if (a.account.scope.can.filter((c) => c !== "read").every((c) => writes.includes(c))) delete reach[accountId];
    else reach[accountId] = writes;
    this.openness = { ...this.openness, reach };
    this.ledger.append({ kind: "note", venue: accountId, reason: `reach → ${writes.join(", ") || "read"}`, detail: this.dialNow() });
    return { ok: true, reach: effectiveReach(a.account, this.openness) };
  }

  revoke(accountId: string): Refusal | { ok: true; revoked: string[] } {
    if (!this.adapters.has(accountId)) return no("E_WALLET_ACCOUNT_UNKNOWN", { venue: accountId });
    this.openness = { ...this.openness, revoked: [...new Set([...this.openness.revoked, accountId])] };
    this.ledger.append({ kind: "note", venue: accountId, reason: "revoked: the agent keeps reads only; deleting the key at the exchange or freezing the token at the issuer is an operator action", detail: this.dialNow() });
    return { ok: true, revoked: this.openness.revoked };
  }

  restore(accountId: string): Refusal | { ok: true; revoked: string[] } {
    if (!this.adapters.has(accountId)) return no("E_WALLET_ACCOUNT_UNKNOWN", { venue: accountId });
    this.openness = { ...this.openness, revoked: this.openness.revoked.filter((x) => x !== accountId) };
    this.ledger.append({ kind: "note", venue: accountId, reason: "restored", detail: this.dialNow() });
    return { ok: true, revoked: this.openness.revoked };
  }

  /** end the agent's session: every write stops now, every read continues */
  revokeAll(): { ok: true; sessionExpiresAt: string } {
    this.openness = { ...this.openness, sessionExpiresAt: this.now() };
    this.ledger.append({ kind: "note", venue: "*", reason: "session ended: every write stops, reads continue", detail: this.dialNow() });
    return { ok: true, sessionExpiresAt: this.openness.sessionExpiresAt };
  }

  reset(): void {
    this.openness = parseOpenness(this.opts.openness ?? loadOpenness());
    this.approvals = [];
    this.seq = 0;
    this.flights.length = 0;
    this.flightSeq = 0;
    this.counters.writes = this.counters.refusals = this.counters.cards = 0;
    this.skewMs = 0;
    this.ledger = this.openLedger();
    this.mount();
    this.account?.reset();
  }

  rows(): readonly LedgerRow[] {
    return this.ledger.all();
  }

  verifyChain(): { ok: boolean; rows: number; at?: number } {
    return this.ledger.verifyChain();
  }

  ledgerPath(): string {
    return this.ledger.path();
  }

  /** The statement: every transaction at the real venues, read back from every ledger in this home — this run's and the earlier ones' — the
   * last line written for each, newest first */
  statement(): StatementLine[] {
    const rows = this.statementRows();
    const lines: StatementLine[] = [...rows.before, ...rows.now].map((r) => r.detail);
    const before = new Set(rows.before.map((r) => r.detail.key));
    const now = new Set(rows.now.map((r) => r.detail.key));
    // a line an earlier run left unfinished is not followed by this one: it says so, and counts only what had happened. Finished is each
    // line type's own last word: an order's (live/trade.ts DONE), a movement's (settled, failed, stranded), an earn request's (done, rejected)
    return fold(lines).map((l) => (before.has(l.key) && !now.has(l.key) && !STATEMENT_FINAL.has(l.status) ? { ...l, status: "not followed since a restart", ...(l.status === "waiting for wallet" ? { amountUsd: 0 } : {}) } : l));
  }

  /** the ledger files this run continues (account/restore.ts readHistory, oldest first). Unknown until a real account has read its
   * history: a service that keeps no history reads every ledger in the home, as before */
  private ledgerChain: string[] | undefined;

  /** the statement rows of the account's earlier runs (`before`, oldest file first) and this run's (`now`) — with what each row carries
   * whole (`native`: the order or the payment). An earlier run is a ledger this run continues, or any other ledger in the home that an
   * account run wrote (its first row carries the run mark: an earlier line of runs, one `--fresh` left behind); a ledger no account run
   * wrote — a demo's, a test's, another program's — is not the account's and is not read. An earlier run's file is read once and kept while
   * its size stays the same: the page asks for the statement every few seconds, and an old ledger only grows when another process shares
   * the home */
  private statementRows(): { before: StatementRow[]; now: StatementRow[] } {
    const dir = join(this.opts.home, "portfolio");
    const current = this.ledger.path();
    const before: StatementRow[] = [];
    const seen = new Set<string>();
    const chain = this.ledgerChain === undefined ? undefined : new Set(this.ledgerChain);
    for (const name of existsSync(dir) ? readdirSync(dir).sort() : []) {
      if (!/^ledger-.*\.jsonl$/.test(name) || join(dir, name) === current) continue;
      let size: number;
      try {
        size = statSync(join(dir, name)).size;
      } catch {
        continue;
      }
      seen.add(name);
      let hit = this.oldLedgers.get(name);
      if (!hit || hit.size !== size) {
        const rows = new Ledger(join(dir, name), this.now).all();
        const ours = chain === undefined || chain.has(name) || runOf(rows[0]) !== undefined;
        hit = { size, rows: ours ? statementOf(rows) : [] };
        this.oldLedgers.set(name, hit);
      }
      before.push(...hit.rows);
    }
    for (const name of [...this.oldLedgers.keys()]) if (!seen.has(name)) this.oldLedgers.delete(name);
    return { before, now: statementOf(this.ledger.all()) };
  }
  private readonly oldLedgers = new Map<string, { size: number; rows: StatementRow[] }>();

  /** this run's ledger rows, oldest first */
  ledgerRows(): readonly LedgerRow[] {
    return this.ledger.all();
  }
}

/** a statement row of a ledger: the line as the statement shows it, and the order or payment it was written for */
interface StatementRow {
  detail: StatementLine;
  native: unknown;
}
const statementOf = (rows: readonly LedgerRow[]): StatementRow[] => rows.filter((r) => r.kind === "statement" && r.detail).map((r) => ({ detail: r.detail as StatementLine, native: r.native }));

// ---- what the wallet's reads answer -----------------------------------------------------------------------------------------------

/** a venue, or a part of one, that could not be read for an answer: why, in its own words where it gave some */
export interface ReadMissing {
  venue: string;
  venueName: string;
  why: string;
  code?: string | undefined;
  /** which read: its 24 hours, its positions, its price history, the comparison, its earn */
  part?: "stats" | "positions" | "candles" | "compare" | "earn" | undefined;
}

/** EARN across the venues connected live: which venues earn (and whether the key or wallet may put money in), the products they offer, what
 * is in them, the venues that could not be read, and whether this server moves money at all */
export interface EarnView {
  asOf: string;
  venues: Array<{ venue: string; venueName: string; can: boolean | "unknown"; what: string; whyNot?: string }>;
  products: Array<EarnProduct & { venue: string; venueName: string }>;
  positions: Array<EarnPosition & { venue: string; venueName: string }>;
  missing: ReadMissing[];
  writes: { on: boolean; capUsd: number; turnOn: string };
}

/** a holdings row with its market's last 24 hours, from the venue that reports them */
export interface HeldRow extends AssetRow {
  changePct24h?: number | undefined;
  changeFrom?: { venue: string; venueName: string } | undefined;
}

export interface HoldingsView {
  asOf: string;
  /** the account page's total: the venues, and what is in flight or held in escrow between them */
  totalUsd: number;
  rows: HeldRow[];
  /** the dollars that are ready, and where they can go (account/holdings.ts) */
  money: MoneySummary;
  /** what the rows did in the last 24 hours, and how much of them that covers */
  change24h: DayChange;
  missing: ReadMissing[];
  /** asked with `cost`: what was paid (account/costbasis.ts), and the positions it was read with */
  cost?: CostBasis[] | undefined;
  positions?: VenuePosition[] | undefined;
}

export interface ReceiveAddress {
  venue: string;
  venueName: string;
  asset: string;
  network: ChainName;
  address: string;
  /** a memo the venue needs with it, when it does */
  tag?: string | undefined;
  /** whose address it is, in words: the venue's own deposit address, or the wallet that showed it is the user's */
  whose: string;
  note?: string | undefined;
}

/** one market's price history, as GET /api/account/candles answers it */
export interface CandlesView {
  venue: string;
  venueName: string;
  symbol: string;
  interval: CandleInterval;
  /** oldest first */
  candles: Candle[];
  /** read from the venue's public market data, without a key: the venue is not connected */
  public?: true | undefined;
}

export interface CandleSeries {
  venue: string;
  venueName: string;
  symbol: string;
  interval: CandleInterval;
  /** oldest first */
  bars: Candle[];
  /** read from an exchange's keyless public bars: the venue is not connected */
  public?: true | undefined;
}

export interface AssetDetail {
  key: string;
  /** its holdings row, when the account holds it */
  row?: HeldRow | undefined;
  /** the same thing at every connected venue, priced for a buy */
  compare?: Comparison | undefined;
  candles?: CandleSeries | undefined;
  positions: VenuePosition[];
  /** the account's open orders in it */
  orders: LiveOrder[];
  /** its lines on the statement, newest first */
  lines: StatementLine[];
  /** what was paid for it: its row's, and its positions' */
  cost: CostBasis[];
  missing: ReadMissing[];
}

export interface Sellable {
  /** its holdings row, or its position (`position:<venue>:<symbol>`) */
  key: string;
  asset: string;
  venue: string;
  venueName: string;
  /** what selling it signs: a sell order in a dollar market there, or — a perpetual, a future — the position's close */
  action: "sell" | "close";
  /** the market, as an order there names it */
  symbol?: string | undefined;
  kind?: MarketKind | undefined;
  side?: "long" | "short" | undefined;
  /** what is held there, and what a sell of all of it is, down to the market's step */
  held: number;
  sellQty: number;
  /** the bid (the price where the market shows no book), and what the sell is worth at it */
  price?: number | undefined;
  usd?: number | undefined;
  /** an order could go now: the server trades, the key may, the market is open and the size is at least its smallest */
  ready: boolean;
  why?: string | undefined;
}

export interface AgentView {
  address: string;
  name: string;
  code: string;
  /** ok · expired · revoked */
  status: string;
  validUntil: string;
  approvedAt: string;
  /** each limit the owner signed for it: `trade` (orders), `venues` (moving money between the user's own places), `payees` (paying others),
   * `earn` (money put into venues' earn products) */
  limits: Array<{ id: string; scope: string; allow: string[]; perPaymentUsd: number; budgetUsd: number; spentUsd: number; reservedUsd: number; leftUsd: number; windowHours: number; validUntil: string; expired: boolean }>;
  /** the cards it is waiting on the owner for */
  cards: AccountPage["cards"];
  orders: LiveOrder[];
  payments: Payment[];
  /** what it put into earn products, or took out */
  earns: LiveEarn[];
  /** its agent wallets, with what the chains say they hold where they are read */
  wallets: Array<AccountPage["subAccounts"][number] & { venue: string; usd?: number | undefined }>;
  /** the owner's open intents addressed to it or to every agent: words, none of them a limit */
  intents: AccountPage["intents"];
  asks: AgentAsk[];
  /** what the owner declined of its asks in the last day */
  declinedAsks: DeclinedAsk[];
  flights: Array<{ no: string; at: string; request: string; legs: string[] }>;
  /** what it remembers about the owner (account/memory.ts): its notes kept, and the ones waiting for the owner */
  memory: { notes: number; waiting: number };
}

/** the most a memory takes, and its three parts with their words */
const MEMORY_LIMITS = { noteText: NOTE_TEXT, howText: HOW_TEXT, maxNotes: MAX_NOTES, topics: TOPICS.map((t) => ({ id: t, words: TOPIC_WORDS[t] })) };

/** a line of "From your limit": a signed limit (its id) or the mode, as they stand */
export interface MemoryFromLimit {
  id: string;
  from: "limit" | "mode";
  topic: "rules";
  text: string;
  /** when the limit was signed */
  at?: string | undefined;
}

/** the owner's view of what the agents remember */
export interface MemoryPage {
  asOf: string;
  /** `status` ok · expired · revoked, or gone: memory kept for a key the account no longer lists */
  agents: Array<{ address: string; name: string; code: string; status: string; rules: MemoryRules; notes: MemoryNote[]; fromLimits: MemoryFromLimit[] }>;
  limits: typeof MEMORY_LIMITS;
}

/** one agent's view of its memory */
export interface AgentMemoryView {
  asOf: string;
  rules: MemoryRules;
  notes: MemoryNote[];
  waiting: MemoryNote[];
  fromLimits: MemoryFromLimit[];
  sharedWithYou: Array<{ agent: string; name: string; notes: MemoryNote[] }>;
  limits: typeof MEMORY_LIMITS;
}

export interface AgentsView {
  asOf: string;
  /** guard (Guard: every agent order waits for the owner) · open (Beast: inside their limits, at once) */
  mode: "guard" | "open";
  agents: AgentView[];
  /** keys that asked to be let in, with the name they gave */
  requests: AccountPage["requests"];
}

const EXPLORE_SORTS: readonly ExploreSort[] = ["volume", "movers", "closing"];
/** how long a venue has for its 24 hours, and for its price history */
const STATS_MS = 4_000;
const CANDLE_MS = 6_000;
/** how far back the Asset sheet's price history goes, by bar: about three hundred bars */
const CANDLE_SPAN: Readonly<Record<CandleInterval, number>> = { "5m": 86_400_000, "1h": 12 * 86_400_000, "1d": 300 * 86_400_000 };

/** an answer within `ms`, or the venue's not answering as a refusal; a throw is a refusal too. The call is not stopped (nothing here can
 * stop one): its answer is just not waited for */
function within<T>(ms: number, p: Promise<T | Refusal>, venue: string, name: string): Promise<T | Refusal> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<Refusal>((resolve) => {
    timer = setTimeout(() => resolve(no("E_VENUE_UNREACHABLE", { venue, message: `${name} did not answer in ${ms / 1000} seconds` })), ms);
  });
  const said = p.catch((err: unknown) => no("E_VENUE_UNREACHABLE", { venue, message: `${name}: ${String((err as Error)?.message ?? err).slice(0, 160)}` }));
  return Promise.race([said, late]).finally(() => clearTimeout(timer));
}

/** an earn position as the holdings read it */
const heldOf = (p: EarnPosition): EarnHeld => ({ product: p.product, asset: p.asset, amount: p.amount, ...(p.usd !== undefined ? { usd: p.usd } : {}), ...(p.apy !== undefined ? { apy: p.apy } : {}), ...(p.accrued !== undefined ? { accrued: p.accrued } : {}), ...(p.accruedUsd !== undefined ? { accruedUsd: p.accruedUsd } : {}), ...(p.name ? { name: p.name } : {}), ...(p.chain ? { chain: p.chain } : {}) });

/** a market's 24-hour change in percent: the venue's own, or its change in price against its own price a day ago. Never a guess */
function pctOf(s: MarketStats): number | undefined {
  if (typeof s.changePct24h === "number" && Number.isFinite(s.changePct24h) && s.changePct24h > -100) return s.changePct24h;
  if (typeof s.change24h === "number" && Number.isFinite(s.change24h) && typeof s.price === "number" && s.price > 0 && s.price - s.change24h > 0) return (s.change24h / (s.price - s.change24h)) * 100;
  return undefined;
}

type AssetKey = { key: string; cls: string; name: string };
/** a holdings key as account/holdings.ts writes it (a coin by its one name, anything else by its symbol in capitals); Markets' `coin:` and
 * `stock:` are its `crypto:` and `equity:` */
function assetKeyOf(raw: string): AssetKey | undefined {
  const m = /^(crypto|coin|stable|cash|equity|stock|rwa|event):(.{1,120})$/.exec(raw.trim());
  if (!m || /[\u0000-\u001f\u007f]/.test(m[2]!)) return undefined;
  const cls = m[1] === "coin" ? "crypto" : m[1] === "stock" ? "equity" : m[1]!;
  const name = cls === "crypto" ? normalBase(m[2]!, "crypto") || m[2]!.trim().toUpperCase() : m[2]!.trim().toUpperCase();
  return name ? { key: `${cls}:${name}`, cls, name } : undefined;
}

/** is a market (an order's, a position's) the asset `k`: a coin by its one name in any market but a stock's or an event's (a perpetual on it
 * included), a share by its ticker, an event contract by its symbol */
function sameThing(k: AssetKey, kind: MarketKind, base: string, symbol: string): boolean {
  const b = base || symbol;
  if (k.cls === "event") return kind === "event" && symbol.toUpperCase() === k.name;
  if (k.cls === "equity") return kind === "stock" && normalBase(b, "stock") === k.name;
  if (k.cls === "rwa") return kind === "token" && b.toUpperCase() === k.name;
  return kind !== "stock" && kind !== "event" && normalBase(b, kind) === k.name;
}

/** a holding's dollar market at its venue: the same thing (a coin by its one name, a share by its ticker, a token by its symbol), priced in
 * dollars, not a perpetual, a future or an event; from a wallet, the pair on the chain it is held on, and none on another */
async function dollarMarket(t: LiveTrader, row: AssetRow, line: AssetRow["venues"][number]): Promise<Market | Refusal | undefined> {
  const list = await t.markets(row.asset);
  if (isRefusal(list)) return list;
  const want = row.asset.toUpperCase();
  const fits = list.filter((m) => {
    if (!inDollars(m.quote) || m.kind === "perp" || m.kind === "future" || m.kind === "event") return false;
    if (row.class === "equity") return m.kind === "stock" && normalBase(m.base || m.symbol, "stock") === want;
    if (row.class === "rwa") return m.kind !== "stock" && (m.base || "").toUpperCase() === want;
    return m.kind !== "stock" && normalBase(m.base || m.symbol, m.kind) === want;
  });
  if (fits.some((m) => m.symbol.includes("@"))) {
    const chain = (line.note ?? "").split(" · ")[0]!.trim();
    return chain ? fits.find((m) => m.symbol.endsWith(`@${chain}`)) : undefined;
  }
  return fits.find((m) => m.quote.toUpperCase() === "USD") ?? fits[0];
}

/** what a restarted account brought back from its ledgers (account/restore.ts), as the page and the log say it */
export interface RestoreReport {
  /** how many earlier runs the account continues, and the first of them */
  runs: number;
  from: string;
  owner: boolean;
  agents: number;
  limits: number;
  mode: "Guard" | "Beast";
  /** each connection brought back: connected again, or why not — `waiting` while it is asked again (the network did not let it just then) */
  venues: Array<{ venue: string; ok: boolean; why?: string; waiting?: boolean; said?: string }>;
  orders: number;
  payments: number;
  skipped: string[];
  state: "restoring" | "done";
}

/** how a venue has answered the account's reads lately */
export interface VenueHealth {
  /** when it last answered (a refusal about the request itself is an answer) */
  lastOkAt?: string | undefined;
  /** when it last failed — it did not answer, it is rate-limiting this machine, it does not serve this location, the key may not read —
   * the code of that failure and the venue's words for it */
  lastFailAt?: string | undefined;
  code?: string | undefined;
  message?: string | undefined;
  /** how long its last read took, in milliseconds */
  ms?: number | undefined;
}

/** what a venue's earn positions are kept for at most, beside the balance read they belong to */
const KEEP_HELD_MS = 120_000;
/** how old a venue's last balance-and-earn pair may be and still be shown whole when its earn is late: past it, the newer balance stands */
const PAIR_MS = 120_000;

/** the venues the account knows, as connections to judge (live/availability.ts): each well-known exchange by its own id, and every other
 * way of connecting the server offers, under the names and groups the page gives them */
const EXCHANGE_NAMES: Record<string, string> = { okx: "OKX", okxus: "OKX US", kraken: "Kraken", coinbase: "Coinbase", bybit: "Bybit", binance: "Binance", binanceus: "Binance.US", kucoin: "KuCoin", gate: "Gate", bitget: "Bitget", mexc: "MEXC", deribit: "Deribit", krakenfutures: "Kraken Futures", kucoinfutures: "KuCoin Futures", cryptocom: "Crypto.com", gemini: "Gemini", bitstamp: "Bitstamp", bitfinex: "Bitfinex", htx: "HTX" };
const KIND_HERE: Record<string, { name: string; group: VenueHere["group"] }> = {
  alpaca: { name: "Alpaca", group: "Brokers" },
  robinhood: { name: "Robinhood", group: "Brokers" },
  "robinhood-crypto": { name: "Robinhood Crypto", group: "Brokers" },
  metamask: { name: "MetaMask Agent Wallet", group: "Wallets" },
  wallet: { name: "A wallet (a browser wallet, or an address watched)", group: "Wallets" },
  kalshi: { name: "Kalshi", group: "Markets and tokens" },
  "polymarket-us": { name: "Polymarket US", group: "Markets and tokens" },
  "polymarket-trade": { name: "Polymarket", group: "Markets and tokens" },
  polymarket: { name: "Polymarket · by address", group: "Markets and tokens" },
  "hyperliquid-trade": { name: "Hyperliquid", group: "Markets and tokens" },
  hyperliquid: { name: "Hyperliquid · by address", group: "Markets and tokens" },
  ondo: { name: "Ondo · OUSG", group: "Markets and tokens" },
};
export function venueCatalog(options: Array<{ kind?: string; needs: VenueHere["needs"]; label: string }>): AvailabilityDeps["connections"] {
  const exchanges = options.some((o) => o.kind === "exchange") ? KNOWN_EXCHANGES.map((id) => ({ connector: `live:exchange:${id}`, name: EXCHANGE_NAMES[id] ?? id, group: "Exchanges" as const, needs: "key-file" as const })) : [];
  const others = options.filter((o) => o.kind && o.kind !== "exchange").map((o) => ({ connector: `live:${o.kind}`, name: KIND_HERE[o.kind!]?.name ?? o.label.split(" · ")[0]!, group: KIND_HERE[o.kind!]?.group ?? ("Markets and tokens" as const), needs: o.needs }));
  return [...exchanges, ...others];
}

/** how long a venue that cannot be asked just now is not asked again: it did not answer, it is rate-limiting this machine, or it does not
 * serve this location — and ten minutes when it does not serve this location, a rule that does not change by the minute */
const FAIL_KEEP_MS = 20_000;
/** how long a public source's listings, tickers and events are kept here (its own keeping of the bodies it downloads sits under it) */
const PUBLIC_KEEP_MS = 20_000;
/* the one rule for how long a refusal holds a venue back lives with the public sources (live/public-markets.ts holdBackMs): the same rule
   for a venue connected with a key and for a keyless source */
const holdsBack = (r: Refusal): boolean => holdBackMs(r) > 0;
/** a read that failed because of the venue or the key, not because of what was asked */
const venueFailed = (r: Refusal): boolean => holdsBack(r) || r.code === "E_VENUE_PERMISSION";
/** the venue's ban of this machine's address (its 418, or "banned until"): it covers every request from here, keyless or keyed */
const isBan = (r: Refusal): boolean => {
  const n = r.native as { ban?: unknown; status?: unknown } | undefined;
  return n?.ban === true || n?.status === 418;
};
/** a hold on the venue's own time — a ban, or a wait it named (`native.until`) that has not run out: no re-check from here lifts it */
const ownTime = (r: Refusal, now: number): boolean => {
  const until = (r.native as { until?: unknown } | undefined)?.until;
  return isBan(r) || (typeof until === "number" && until > now);
};
/** the party that gave a refusal, when it is not the venue itself (LI.FI, for a wallet's swaps): its hold is its own (`native.party`) */
const partyOf = (r: Refusal): string | undefined => {
  const p = (r.native as { party?: unknown } | undefined)?.party;
  return typeof p === "string" && p ? p : undefined;
};
/** the venue a read cache name stands for: `public:okx` is OKX's keyless source, read apart from an OKX connected with a key */
const bareVenue = (venue: string): string => venue.replace(/^public:/, "");
/** a read cache name that is the venue's, one of its parties' (`venue|party`) or one of its parts' (`venue#part`) */
const ofVenue = (name: string, venue: string): boolean => name === venue || name.startsWith(`${venue}|`) || name.startsWith(`${venue}#`);
/** the connection a read cache name is part of: `mm#swaps` (one of the venues mm reaches) is part of `mm`, whose own hold holds it too */
const baseVenue = (venue: string): string => venue.replace(/#.*$/, "");
/** one of the venues mm reaches, by the form of the symbol: a token swap (TOKEN/USDC@chain), a perpetual (COIN-PERP), a prediction market
 * (slug:outcome, or a token id). One asset's rule or one inner venue's hold is that venue's, not every read of the mm connection */
const mmInner = (symbol: string): string | undefined => (symbol.includes("@") ? "swaps" : /-PERP$/i.test(symbol) ? "perps" : symbol.includes(":") || /^\d{10,}$/.test(symbol) ? "predict" : undefined);
/** mm itself cannot be asked (not installed, the node it needs, signed out): every read of the mm connection waits it out */
const MM_WIDE: ReadonlySet<string> = new Set(["ENOENT", "UNSUPPORTED_NODE", "MISSING_AUTH_TOKEN", "AUTH_REQUIRED", "AUTH_FAILED", "AUTH_ERROR", "TOKEN_INVALID", "TOKEN_REFRESH_FAILED", "NOT_INITIALIZED"]);
const connectionWide = (r: Refusal): boolean => r.code === "E_ACCOUNT_CREDENTIAL" || MM_WIDE.has(String((r.native as { code?: unknown } | undefined)?.code));
/** how many of one venue's reads are on their way at once: the rest wait their turn */
const PER_VENUE = 2;
/** the longest anything is kept */
const KEEP_MAX_MS = 300_000;
/** the last word of each statement line type: an order's, a movement's (account/payments.ts), an earn request's (live/earn.ts EarnState) */
const STATEMENT_FINAL: ReadonlySet<string> = new Set([...DONE, "settled", "failed", "stranded", "done"]);

/** a connector that threw has answered in a way the account cannot read: the venue's refusal for it, with no word of the exception on the
 * wire (the exception is written to the server's log, once per throw; a thrower is held back like a venue that did not answer) */
function thrownBy(venue: string, name: string, err: unknown): Refusal {
  if (isRefusal(err)) return err;
  console.error(`${venue}: a read threw: ${String((err as Error)?.message ?? err).slice(0, 300)}`);
  return no("E_VENUE_UNREACHABLE", { venue, message: `${name} answered in a way the account could not read` });
}

/** the countries whose parts the lists in use name (US states in Binance.US's list, in a venue's terms): the place's part is looked up for
 * these when the first source gave only the country (location.ts place's `splits`) */
const SPLIT: ReadonlySet<string> = new Set(
  [...Object.values(EDITIONS).flatMap((es) => es.flatMap((e) => e.serves)), ...Object.values(VENUE_TERMS).flatMap((t) => [...(t.excludes ?? []), ...(t.serves ?? []), ...(t.routes?.places ?? [])])]
    .filter((code) => code.includes("-"))
    .map((code) => code.split("-")[0]!),
);

/** a refusal met while connecting a venue again after a restart that is how this network was just then, not the venue's or the key's
 * answer: no answer (no network yet at login, a captive portal's page, an outage, a ban or rate limit until its time, Hyperliquid's place
 * not known just now), a redirect a portal answered in the venue's place, and a place rule or an edge page met on a network the laptop may
 * only be passing through. Asked again later; a key, a permission or anything else the venue said is final, as before */
function passingAtStart(r: Refusal): boolean {
  const status = (r.native as { status?: unknown } | undefined)?.status;
  return r.code === "E_VENUE_UNREACHABLE" || (r.code === "E_VENUE_GEOBLOCKED" && holdBackMs(r) > 0) || (r.code === "E_VENUE_REJECTED" && typeof status === "number" && status >= 300 && status < 400);
}
/** how long a venue that did not come back after the restart waits before it is asked again: longer each time, a quarter of an hour at most */
const COMING_BACK_MS = [15_000, 30_000, 60_000, 120_000, 300_000, 900_000];
/** a wait, as a person says it */
const waitText = (ms: number): string => (ms < 90_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);

/** A row on its way to the ledger with this machine's address taken out of the words in it — its reason, native and detail — so a venue's
 * words that never passed through no() do not write the address down. A row with no words is passed as it is; the signed envelope and a
 * wallet's proof (the sentence it signed, checked again at a restart) are kept exactly as signed */
function unaddressedRow<T extends { reason?: unknown; native?: unknown; detail?: unknown }>(row: T): T {
  const words = (v: unknown): boolean => (typeof v === "string" ? /[.:]/.test(v) : v !== null && typeof v === "object");
  if (!words(row.reason) && !words(row.native) && !words(row.detail)) return row;
  const native = row.native as { proof?: unknown } | undefined;
  return {
    ...row,
    ...(typeof row.reason === "string" ? { reason: unaddressed(row.reason) } : {}),
    ...(words(row.native) ? { native: native && typeof native === "object" && !Array.isArray(native) && "proof" in native ? { ...(unaddressedDeep({ ...native, proof: undefined }) as object), proof: native.proof } : unaddressedDeep(row.native) } : {}),
    ...(words(row.detail) ? { detail: unaddressedDeep(row.detail) } : {}),
  };
}

/** whether an outcome reached a venue: "no" for a card the owner rejected (its result a refusal), a move or order still waiting for the
 * wallet to send it (or taken back before it was), and an order the account stopped following because its venue is not connected;
 * "maybe" for a write whose answer was lost (`unsure`: it may have landed); "yes" for every other */
function reachedVenue(r: Exclude<Outcome, Refusal>): "yes" | "maybe" | "no" {
  const unsure = (native: unknown): boolean => (native as { unsure?: unknown } | undefined)?.unsure === true;
  if (r.kind === "result") {
    const x = (r.result && typeof r.result === "object" ? r.result : {}) as { wallet?: unknown; walletTxs?: unknown };
    return isRefusal(r.result) || x.wallet !== undefined || x.walletTxs !== undefined ? "no" : "yes";
  }
  if (r.kind === "order") return (r.order.walletTxs && !r.order.ref) || r.order.unfollowed ? "no" : unsure(r.order.native) ? "maybe" : "yes";
  if (r.kind === "payment") return r.payment.status === "authorized" ? "no" : unsure(r.payment.legs[0]?.native) ? "maybe" : "yes";
  return "yes";
}

/** a day as the page writes one: New York, weekday, day and month — "Thu Nov 5" */
const nyDay = (iso: string): string => new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short", day: "numeric", month: "short" }).replace(",", "");

/** the liquidity map of a real account: each venue's ready dollars, movable or not as that venue's own writer says (account/holdings.ts
 * movesOut and why), never by the kind of venue it is. A wallet's line names the chain the dollars are on */
function liveLiquidity(page: AccountPage): Liquidity {
  const { money } = byAsset(page.venues, { writes: page.connectLive?.writes?.on === true });
  const out: Liquidity = { mobileUsd: 0, stuckUsd: 0, mobile: [], stuck: [] };
  for (const v of money.venues) {
    for (const l of v.lines) {
      const first = (l.note ?? "").split(" · ")[0]!.trim();
      const src = { account: v.venue, name: v.venueName, asset: l.asset, ...(Object.hasOwn(CHAINS, first) ? { chain: first } : {}), usd: l.usd };
      if (v.movesOut) out.mobile.push(src);
      else out.stuck.push({ ...src, why: v.why ?? "stays where it is" });
    }
  }
  out.mobileUsd = r2(out.mobile.reduce((s, x) => s + x.usd, 0));
  out.stuckUsd = r2(out.stuck.reduce((s, x) => s + x.usd, 0));
  return out;
}

/** Answers kept for a short while, and one request in flight per key: an answer still on its way is waited for whatever its age, so a venue
 * that takes ten seconds to say no is asked once, not once per poll. A refusal is not kept — the next ask asks the venue again — except one
 * that says the venue cannot be asked just now, which is kept twenty seconds (ten minutes for a geoblock) and holds back EVERY read of that
 * venue for as long, so a page polling every few seconds does not hammer a venue that is down, rate-limiting or refusing this location.
 * With a venue named: at most two of its reads on their way at once, and how each one went is its health.
 *
 * A hold ends when the LATER of the venue's refusals says (a timeout after a ban does not shorten the ban), a read that waited its turn is
 * not sent into a hold set while it waited, and a ban of this machine's address holds the venue's keyless source and its keyed connection
 * alike. A refusal from another party than the venue (`native.party`: LI.FI pricing a wallet's swaps) holds that party's reads only, and
 * one from a part of a connection (`mm#swaps`, one of the venues mm reaches; `public:polymarket#history`, a source's other host) holds that
 * part only — while the connection's own hold holds every part of it */
class ReadCache {
  private readonly kept = new Map<string, { at: number; value: Promise<unknown>; failed: boolean; settled: boolean }>();
  private readonly slots = new Map<string, { busy: number; waiting: Array<() => void> }>();
  private readonly health = new Map<string, VenueHealth>();
  /** a venue that said it cannot be asked just now: until when, and the refusal that stands for every read of it meanwhile. A party's own
   * hold is kept under `venue|party` */
  private readonly down = new Map<string, { until: number; refusal: Refusal }>();
  /** a ban of this machine's address, by the venue it is of (`binance` for the keyed connection and the keyless source both), and when it
   * was answered */
  private readonly bans = new Map<string, { until: number; refusal: Refusal; at: number }>();

  /** `parties`: the read is one of the venue's trader's (its markets, prices, history), which another party may answer for */
  get<T>(key: string, ttlMs: number, load: () => Promise<T>, venue?: string, parties = false): Promise<T> {
    const now = Date.now();
    const hit = this.kept.get(key);
    if (hit && (!hit.settled || now - hit.at < (hit.failed ? FAIL_KEEP_MS : ttlMs))) return hit.value as Promise<T>;
    const held = venue === undefined ? undefined : this.holding(venue, parties);
    if (held) return Promise.resolve(held.refusal as unknown as T);
    const entry: { at: number; value: Promise<unknown>; failed: boolean; settled: boolean } = { at: now, value: Promise.resolve(), failed: false, settled: false };
    // a read that waited its turn asks again whether the venue is held: it may have answered a ban, its place rule or an edge page to the
    // reads ahead of it. One turned away is not sent, and changes nothing of the venue's health
    const run =
      venue === undefined
        ? load
        : () =>
            this.slot(venue, () => {
              const since = this.holding(venue, parties);
              return since ? Promise.resolve(since.refusal as unknown as T) : this.timed(venue, load);
            });
    const value = run().then(
      (v) => {
        entry.settled = true;
        if (isRefusal(v) && this.kept.get(key) === entry) {
          if (holdsBack(v)) Object.assign(entry, { at: Date.now(), failed: true });
          else this.kept.delete(key);
        }
        return v;
      },
      (err: unknown) => {
        entry.settled = true;
        if (this.kept.get(key) === entry) this.kept.delete(key);
        throw err;
      },
    );
    entry.value = value;
    this.kept.set(key, entry);
    if (this.kept.size > 500) for (const [k, v] of this.kept) if (v.settled && now - v.at >= KEEP_MAX_MS) this.kept.delete(k);
    return value;
  }

  /** a venue disconnected, or connected afresh: what was kept of its answers, its hold-backs and its health go with it (a venue connected
   * again under the same id starts afresh). A ban of this machine's address stays — disconnecting does not lift it — unless the venue
   * `answered` just now (a connection it took) */
  forget(venue: string, answered = false): void {
    const ban = this.bans.get(bareVenue(venue));
    this.drop(venue, true);
    if (ban && !answered) this.bans.set(bareVenue(venue), ban);
    for (const k of [...this.health.keys()]) if (ofVenue(k, venue)) this.health.delete(k);
  }

  /** a write at a venue: what was kept of its reads goes, so the next read sees what the write changed. When the venue `answered` the
   * write it is not held back either; when nothing says it was reached (a card rejected, a move still waiting for the wallet), a hold it
   * set — a ban, its place rule — stands. Its health stays */
  drop(venue: string, answered = true): void {
    for (const k of [...this.kept.keys()]) if (ofVenue(k.split("|")[1] ?? "", venue)) this.kept.delete(k);
    if (!answered) return;
    for (const k of [...this.down.keys()]) if (ofVenue(k, venue)) this.down.delete(k);
    for (const k of [...this.bans.keys()]) if (ofVenue(k, bareVenue(venue))) this.bans.delete(k);
  }

  /** a re-check the user (or the half-hourly watch) asked for found the venue answering the network the user is on now: a hold learned on
   * the network before — its place rule, an edge page, no answer — and the refusals kept with it go. A hold on the venue's own time (a
   * ban, a wait it named) stands until then. Its health stays */
  release(venue: string): void {
    const now = Date.now();
    for (const [k, d] of [...this.down]) if ((k === venue || k.startsWith(`${venue}#`)) && !ownTime(d.refusal, now)) this.down.delete(k);
    if (this.holding(venue, false)) return;
    for (const [k, v] of this.kept) if (v.failed && v.settled && ofVenue(k.split("|")[1] ?? "", venue)) this.kept.delete(k);
  }

  /** every answer kept under these first segments (`explore`, `compare`): what a venue connected or disconnected changes */
  forgetAll(prefixes: readonly string[]): void {
    for (const k of [...this.kept.keys()]) if (prefixes.some((p) => k.startsWith(`${p}|`))) this.kept.delete(k);
  }

  /** the venue's health, as its reads through here went */
  healthOf(venue: string): VenueHealth | undefined {
    const h = this.health.get(venue);
    return h ? { ...h } : undefined;
  }

  /** the refusal that holds the venue back now, if one does: its own hold, or a ban of this machine's address learned by its keyless
   * source or its connection. What the venue's balance reads (adapters/live.ts) and its market reads follow alike */
  heldOf(venue: string): Refusal | undefined {
    return this.holding(venue, false)?.refusal;
  }

  /** a running ban of this machine's address by the venue, and when it was answered */
  banOf(venue: string): { refusal: Refusal; at: number } | undefined {
    const b = this.bans.get(bareVenue(venue));
    return b && Date.now() < b.until ? b : undefined;
  }

  /** a refusal the venue gave elsewhere on the account (its balance read, an order or earn door, the keyless probe's ban): held as one of
   * these, by the same rule — it lengthens a hold, never cuts one */
  hold(venue: string, r: Refusal): void {
    if (holdsBack(r)) this.holdBack(venue, r);
  }

  private holding(venue: string, parties: boolean): { until: number; refusal: Refusal } | undefined {
    const now = Date.now();
    const base = baseVenue(venue);
    for (const at of base === venue ? [venue] : [venue, base]) {
      const own = this.down.get(at);
      if (own && now < own.until) return own;
      const ban = this.bans.get(bareVenue(at));
      if (ban && now < ban.until) return ban;
    }
    if (parties) for (const [k, d] of this.down) if (k.startsWith(`${venue}|`) && now < d.until) return d;
    return undefined;
  }

  /** held back until the later of what is held and what this refusal says: a 429 or a timeout that lands after a ban does not shorten
   * it, nor does a 20-second "no answer" shorten a ten-minute place rule. Reads meanwhile answer in the words of the longer hold */
  private holdBack(venue: string, r: Refusal): void {
    const now = Date.now();
    const until = now + holdBackMs(r, now);
    const at = partyOf(r) ? `${venue}|${partyOf(r)}` : connectionWide(r) ? baseVenue(venue) : venue;
    const was = this.down.get(at);
    if (!was || was.until <= now || was.until < until) this.down.set(at, { until, refusal: r });
    if (isBan(r) && !partyOf(r)) {
      const b = this.bans.get(bareVenue(at));
      if (!b || b.until <= now || b.until < until) this.bans.set(bareVenue(at), { until, refusal: r, at: now });
    }
  }

  /** one of the venue's two places in line (one line for a whole connection, its parts included), handed straight to the next read
   * waiting when it is done */
  private async slot<T>(venue: string, run: () => Promise<T>): Promise<T> {
    let s = this.slots.get(baseVenue(venue));
    if (!s) this.slots.set(baseVenue(venue), (s = { busy: 0, waiting: [] }));
    const line = s;
    if (line.busy < PER_VENUE) line.busy++;
    else await new Promise<void>((go) => line.waiting.push(go));
    try {
      return await run();
    } finally {
      const next = line.waiting.shift();
      if (next) next();
      else line.busy--;
    }
  }

  /** one read, timed for the venue's health; a venue that said it cannot be asked just now is held back for the keep, whenever it said so.
   * Another party's refusal is that party's health and hold, not the venue's */
  private async timed<T>(venue: string, load: () => Promise<T>): Promise<T> {
    const start = Date.now();
    const note = (h: VenueHealth, at = venue) => this.health.set(at, { ...this.health.get(at), ...h, ms: Date.now() - start });
    try {
      const v = await load();
      if (isRefusal(v) && venueFailed(v)) {
        note({ lastFailAt: new Date().toISOString(), code: v.code, message: v.message }, partyOf(v) ? `${venue}|${partyOf(v)}` : connectionWide(v) ? baseVenue(venue) : venue);
        if (holdsBack(v)) this.holdBack(venue, v);
      } else {
        note({ lastOkAt: new Date().toISOString() });
        // a part that answered: the connection answered
        if (baseVenue(venue) !== venue) note({ lastOkAt: new Date().toISOString() }, baseVenue(venue));
      }
      return v;
    } catch (err) {
      // the readers above turn a throw into a refusal before it gets here; one that still throws is held back the same way, and the
      // exception's words stay in the server's log
      const r = thrownBy(venue, venue, err);
      note({ lastFailAt: new Date().toISOString(), code: r.code, message: r.message });
      this.holdBack(venue, r);
      throw err;
    }
  }
}
