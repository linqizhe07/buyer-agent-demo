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
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ledger, type LedgerRow } from "../agent/ledger.ts";
import { isRefusal, type Refusal } from "../core/errors.ts";
import { no } from "./refuse.ts";
import { describeIntent, ENFORCER_LABEL, KIND_LABEL, KIND_ORDER, PRICES, qtyText, r2, SCRIPT_AGENT, usdOf, WRITE_CAPS, type Account, type AccountAdapter, type AgentId, type Capability, type ExecOk, type ExecResult, type Holding, type Intent } from "./accounts.ts";
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
import { AccountEngine, CARD_TTL_MS, type AccountPage, type AccountSeed, type CardOffer, type Outcome } from "./account/exchange.ts";
import { mountPayees, type PayeeWorld } from "./account/payees.ts";
import { doorOf, EXCHANGES } from "./account/doors.ts";
import { isSelfCustody, plug, type PlugSeed } from "./adapters/exchange.ts";
import { liveAccount } from "./adapters/live.ts";
import { keyFileStatus, liveOptions, openLive, type LiveDeps } from "./live/index.ts";
import type { LiveVenue } from "./account/live-moves.ts";
import type { LiveTrader, Market, Position } from "./live/trade.ts";
import { compareAcross, type Comparison } from "./live/compare.ts";
import { fold, type StatementLine } from "./account/statement.ts";
import { WalletProofs } from "./live/proof.ts";
import { proofHolds, readHistory, rebuild, type DialSnapshot, type Rebuilt, type RunMark } from "./account/restore.ts";
import { RealPayer } from "./account/pay-real.ts";
import { agentWalletKey, agentWalletKeyPath, hasKey } from "./account/keystore.ts";
import { agentWalletSource, agentWalletVenue } from "./live/agent-wallet.ts";
import { guardedHttp, type PayHttp } from "./live/guarded-http.ts";
import { publicSender } from "./live/chain.ts";
import type { SubAccount } from "./account/state.ts";
import { publicChain } from "./live/chain.ts";
import { realMm } from "./live/metamask.ts";
import { publicPrices } from "./live/prices.ts";
import { ROBINHOOD_MCP } from "./live/robinhood.ts";
import { OAuthSignIn } from "./live/signin.ts";
import { realHttp } from "./live/types.ts";
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
  compiled: OpennessRow[];
  openness: Openness;
  approvals: Approval[];
  flights: Flight[];
  agents: Array<AgentId & { flights: number }>;
  ledger: LedgerRow[];
  chain: { ok: boolean; rows: number; at?: number };
  daily: { used: number; cap: number };
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
  /** the simulated payees an agent's payment can reach (x402, MPP, ACP, AP2), mounted with the account layer */
  readonly payees: PayeeWorld | undefined;
  /** the page's scripted agent, when a server has one: the owner talks to it through a signed instruction */
  sayHandler: ((text: string) => Promise<unknown>) | undefined;
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
  /** wallets that proved an address is the user's, by signing the sentence the account wrote */
  readonly proofs: WalletProofs;
  /** a real account restarted: what it brought back from its ledgers, and the restore still under way (venues connecting again) */
  restored: RestoreReport | undefined;
  restoring: Promise<void> | undefined;

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
    // real money starts Conservative: every move an agent asks for waits for the owner until the owner signs the dial open
    if (opts.real) this.openness = { ...this.openness, mode: "guard" };
    this.ledger = this.openLedger();
    this.mount();
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
      log: (row) => void this.ledger.append(row),
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
      order: async (base, side, qty, agent) => {
        const r = await this.order(base, side, qty, agent);
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
          return { ok: true, summary: "Aggressive: agents trade and move inside their limits without asking" };
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
          return { ok: true, summary: `agents may act again, until ${this.openness.sessionExpiresAt.slice(0, 10)}` };
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
      connect: (venue, connector, label, credentialRef) => (connector.startsWith("live:") ? this.plugLive(venue, connector, label, credentialRef) : this.plugIn(venue, connector, label, credentialRef)),
      disconnect: (venue) => this.unplug(venue),
      live: () => ({ ...liveOptions(this.opts.home), writes: this.liveWritesView() }),
      liveMoney: () => ({ writes: () => this.liveWritesView(), venue: (id) => (this.adapters.get(id)?.account.watchOnly ? this.liveVenues.get(id) : undefined), realNow: () => this.liveDeps().clock() }),
      pairingCode: () => this.opts.liveWrites?.pairingCode ?? this.opts.pairingCode,
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
    const v = this.adapters.get(venue)?.account.watchOnly ? this.liveVenues.get(venue) : undefined;
    if (!v) return no("E_WALLET_ACCOUNT_UNKNOWN", { venue, message: `"${venue}" is not a venue connected live` });
    if (!v.trader) return no("E_VENUE_RAIL_CLOSED", { venue, message: `${v.name}: ${v.noTradeBecause ?? "no orders are placed here from the account"}` });
    const trader = v.trader;
    return this.marketReads.get(`markets|${venue}|${query.trim().toUpperCase()}`, 60_000, () => trader.markets(query));
  }

  /** what is held at a venue connected live, fifteen seconds old at most (the page asks often; the venue is asked once) */
  async livePositions(venue: string): Promise<Position[] | Refusal> {
    if (!this.account) return no("E_ACCOUNT_BAD_ACTION", { message: "the account layer is not mounted" });
    const engine = this.account;
    return this.marketReads.get(`positions|${venue}`, 15_000, () => engine.trade.positions(venue));
  }

  /** one market at a venue connected live, with a price a few seconds old at most. An order itself is always valued at a fresh one */
  async liveMarket(venue: string, symbol: string): Promise<Market | Refusal> {
    const v = this.adapters.get(venue)?.account.watchOnly ? this.liveVenues.get(venue) : undefined;
    if (!v) return no("E_WALLET_ACCOUNT_UNKNOWN", { venue, message: `"${venue}" is not a venue connected live` });
    if (!v.trader) return no("E_VENUE_RAIL_CLOSED", { venue, message: `${v.name}: ${v.noTradeBecause ?? "no orders are placed here from the account"}` });
    const trader = v.trader;
    return this.marketReads.get(`market|${venue}|${symbol}`, 3_000, () => trader.market(symbol));
  }
  /** The same thing at every venue connected live that trades it — a coin, a stock — ranked by the price an order would take there (the ask
   * for a buy, the bid for a sell). Kept fifteen seconds. A price far from the others' (more than 10% from their middle) is marked: it may be
   * another token under the same name */
  async liveCompare(base: string, side: "buy" | "sell", usd?: number): Promise<Comparison | Refusal> {
    const b = base.trim();
    if (!b || b.length > 40) return no("E_ACCOUNT_BAD_ACTION", { message: "name what to compare: BTC, ETH, AAPL" });
    if (side !== "buy" && side !== "sell") return no("E_ACCOUNT_BAD_ACTION", { message: "compare a buy or a sell" });
    // each venue's reads go through the same short-lived cache as the order ticket's: a new amount or the other side asks no venue again
    const venues = [...this.liveVenues.values()].filter((v) => v.trader && this.adapters.get(v.id)?.account.watchOnly).map((v) => {
      const t = v.trader!;
      const trader: LiveTrader = Object.assign(Object.create(t) as LiveTrader, {
        markets: (q: string) => this.marketReads.get(`markets|${v.id}|${q.trim().toUpperCase()}`, 60_000, () => t.markets(q)),
        market: (sym: string) => this.marketReads.get(`market|${v.id}|${sym}`, 3_000, () => t.market(sym)),
      });
      return { id: v.id, name: v.name, trader };
    });
    return this.marketReads.get(`compare|${b.toUpperCase()}|${side}|${usd ?? ""}`, 15_000, () => compareAcross(venues, b, side, { timeoutMs: 4_000, ...(usd !== undefined ? { usd } : {}) }));
  }

  /** the order ticket's reads, kept for a moment and shared while they are in flight: a page (or anything else on this machine) asking
   * again and again costs the venue one request, not one each — the venue's rate limit is for the orders */
  private readonly marketReads = new ReadCache();

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
    const adapter = await liveAccount(venue, opened.source, { connector, first: opened.first, clock: deps.clock, ...(opened.price ? { price: opened.price } : {}) });
    const src = opened.source;
    // who showed the address is the user's: the wallet that signed the account's sentence, or the mm session on this machine
    const proven = src.address === undefined ? undefined : connector === "live:metamask" ? "the mm session on this machine" : deps.proofs.proven(src.address)?.wallet;
    Object.assign(adapter.account, { ...(proven ? { proven } : {}), ...(src.writer ? { liveCan: src.writer.can } : {}), ...(src.noTradeBecause ? { noTradeBecause: src.noTradeBecause } : {}), ...(src.readOnlyBecause ? { readOnlyBecause: src.readOnlyBecause } : {}) });
    // what the key may do is read from the trader each time: a venue can say it only after connecting (Kalshi's key scopes)
    const trader = src.trader;
    if (trader) Object.defineProperty(adapter.account, "liveTrade", { get: () => ({ can: trader.can, what: trader.what, positions: !!trader.positions, amend: !!trader.amend, leverage: !!trader.setLeverage, close: !!trader.close }), enumerable: true, configurable: true });
    this.liveVenues.set(venue, { id: venue, name: adapter.account.name, kind: adapter.account.kind, ...(src.address ? { address: src.address } : {}), ...(proven ? { proven } : {}), ...(src.writer ? { writer: src.writer } : {}), ...(src.readOnlyBecause ? { readOnlyBecause: src.readOnlyBecause } : {}), ...(src.trader ? { trader: src.trader } : {}), ...(src.noTradeBecause ? { noTradeBecause: src.noTradeBecause } : {}), via: src.via });
    if (sim) this.shadowed.set(venue, sim);
    this.adapters.set(venue, adapter);
    const usd = r2((await adapter.read()).reduce((s, h) => s + h.usd, 0));
    // what this connection may do with the money there: nothing unless the server moves real money, and then only what the owner signs
    const writes = this.opts.liveWrites;
    const can = src.writer?.can;
    const leaves = !!can && (can.withdraw !== false || (can.ledgers.length > 1 && can.transfer !== false) || can.swap !== false || !!can.send);
    const mode = !src.writer ? `read only: ${src.readOnlyBecause ?? "nothing is sent to it from here"}` : !writes ? "read only: this server was started without real-money writes" : src.address !== undefined && !proven && src.writer.can.send === "wallet" ? "watched: no wallet signed for this address, so nothing is sent to or from it" : !leaves ? "this key only reads: money can be sent to it, nothing leaves it from here" : `real money moves only when you sign it, at most ${cents(writes.capUsd)} a movement`;
    // the wallet's proof rides on the connection's row: a restarted account checks the signature again rather than forgetting it was given
    const proof = src.address !== undefined && connector !== "live:metamask" ? deps.proofs.proven(src.address) : undefined;
    const kept = proof?.message && proof.signature ? { address: proof.address, wallet: proof.wallet, at: proof.at, message: proof.message, signature: proof.signature } : undefined;
    return { ok: true, summary: `${adapter.account.name} connected live · ${cents(usd)} there now · ${opened.summary} · ${mode}${sim && !this.opts.real ? " · it stands in for the simulated one until it is unplugged" : ""}`, native: { connector, probe: opened.source.probe.native ?? null, ...(kept ? { proof: kept } : {}) } };
  }

  private unplug(venue: string): Refusal | { ok: true; summary: string } {
    const a = this.adapters.get(venue);
    if (!a) return no("E_WALLET_ACCOUNT_UNKNOWN", { venue });
    if (!a.account.plugged) return no("E_ACCOUNT_BAD_ACTION", { venue, message: `${a.account.name} is one of the venues the account opened with: only a venue that was plugged in can be unplugged` });
    this.liveVenues.delete(venue);
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
      return { ok: true, summary: `${a.account.name} disconnected: the account no longer reads it. ${a.account.address ? "Nothing was ever held for it here" : "The key at the venue is untouched: delete it there"}` };
    }
    this.adapters.delete(venue);
    const listed = this.walletAllow.indexOf(a.account.address ?? venue);
    if (listed >= 0) this.walletAllow.splice(listed, 1);
    return { ok: true, summary: `${a.account.name} unplugged: the account no longer reads it or routes through it. The credential at the venue is untouched: delete it there` };
  }

  /** the account layer's front door: one signed instruction */
  async exchange(envelope: Envelope): Promise<Outcome> {
    if (!this.account) return no("E_ACCOUNT_BAD_ACTION", { message: "the account layer is not mounted on this service" });
    return this.account.exchange(envelope);
  }

  /** what the Account page reads */
  async accountView(): Promise<AccountPage | undefined> {
    const page = await this.account?.view();
    // a real account's page waits only on cards about its real venues; the statement page answers the simulation's own
    if (page && this.opts.real) page.cards = page.cards.filter((c) => this.adapters.get(this.approvals.find((a) => a.id === c.id)?.account ?? "")?.account.watchOnly);
    if (page && this.restored) page.restore = this.restored;
    return page;
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
    if (fresh) return;
    // a replayed agent wallet is the key file it was made with: one that is gone is not made again under the same name
    const home = this.opts.home;
    const r = await rebuild(history.rows, engine.state, { ...engine.applyOptions(), codeRequired: (this.opts.liveWrites?.pairingCode ?? this.opts.pairingCode) !== undefined, walletAddress: (name) => (hasKey(agentWalletKeyPath(home, name)) ? (() => { const k = agentWalletKey(home, name); return isRefusal(k) ? k : (k.address as Hex); })() : no("E_ACCOUNT_CREDENTIAL", { message: `the key file of the agent wallet "${name}" is gone from ${agentWalletKeyPath(home, name)}` })) });
    engine.adopt(r.state, r.ids);
    this.seq = Math.max(this.seq, r.ids.card);
    if (r.dial) this.adoptDial(r.dial);
    const report: RestoreReport = { runs: history.files.length, from: history.files[0] ?? "", owner: r.owner, agents: r.state.agents.filter((a) => a.revokedAt === undefined && a.validUntil > Date.parse(this.now())).length, limits: r.state.spends.filter((x) => x.revokedAt === undefined && x.validUntil > Date.parse(this.now())).length, mode: this.openness.mode === "open" ? "Aggressive" : "Conservative", venues: r.connections.map((c) => ({ venue: c.venue, ok: false, why: "connecting again" })), orders: r.orders.length, payments: r.payments.length + r.authorisations.length, skipped: [...r.skipped, ...(history.broken ? [`${history.broken.file}: its hash chain breaks${history.broken.at ? ` at row ${history.broken.at}` : ""}, so nothing after the break (and nothing older) was brought back`] : [])], state: "restoring" };
    this.restored = report;
    this.restoring = engine.serially(() => this.reconnect(r, report)).catch(() => undefined);
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
  }

  /** the restore's second half: the venues, from the same credential references the owner signed; then what was in flight, followed again */
  private async reconnect(r: Rebuilt, report: RestoreReport): Promise<void> {
    const engine = this.account!;
    // the agent wallets the owner made: their keys are where they were made, in this home
    for (const sub of r.state.subAccounts) await this.plugAgentWallet(sub);
    for (const [i, c] of r.connections.entries()) {
      // a wallet's proof is the signature it gave, checked again; one that no longer checks out connects the address as watched
      if (c.proof && (await proofHolds(c.proof))) this.proofs.keep(c.proof);
      let out: Awaited<ReturnType<PortfolioService["plugLive"]>>;
      try {
        out = c.connector.startsWith("live:") ? await this.plugLive(c.venue, c.connector, c.label, c.credentialRef) : no("E_ACCOUNT_BAD_ACTION", { venue: c.venue, message: "not a live connection" });
      } catch (err) {
        out = no("E_VENUE_UNREACHABLE", { venue: c.venue, message: String((err as Error)?.message ?? err).slice(0, 160) });
      }
      report.venues[i] = isRefusal(out) ? { venue: c.venue, ok: false, why: out.message } : { venue: c.venue, ok: true };
      this.ledger.append({ kind: "note", venue: c.venue, reason: isRefusal(out) ? `not connected again after the restart: ${out.message}` : `connected again after the restart · ${out.summary}` });
    }
    for (const o of r.orders) engine.trade.adopt(o);
    for (const p of r.payments) engine.live.adopt(p);
    for (const k of r.authorisations) engine.adoptAuthorisation(k);
    report.state = "done";
    const back = report.venues.filter((v) => v.ok).length;
    this.ledger.append({ kind: "note", venue: "*", reason: `restored after a restart: ${report.owner ? "your device is still the owner" : "no owner yet"} · ${report.agents} agent${report.agents === 1 ? "" : "s"} · ${report.limits} limit${report.limits === 1 ? "" : "s"} · ${back} of ${report.venues.length} venue${report.venues.length === 1 ? "" : "s"} connected again · ${report.orders} order${report.orders === 1 ? "" : "s"} and ${report.payments} movement${report.payments === 1 ? "" : "s"} followed again · ${report.mode}${report.skipped.length ? ` · ${report.skipped.length} not brought back` : ""}`, detail: { restore: report } });
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

  async overview(): Promise<Overview> {
    const now = this.now();
    const accounts = this.accounts();
    const views = await this.views();
    const holdings = views.flatMap((v) => v.holdings);
    const agents = new Map<string, AgentId & { flights: number }>();
    for (const f of this.flights) {
      const a = agents.get(f.agent.id) ?? { ...f.agent, flights: 0 };
      a.flights++;
      agents.set(f.agent.id, a);
    }
    return {
      now,
      live: this.live,
      mode: this.openness.mode,
      session: { expiresAt: this.openness.sessionExpiresAt, expired: isExpired(now, this.openness.sessionExpiresAt) },
      portfolio: aggregate(accounts, holdings),
      liquidity: liquidity(views),
      ladder: ladder(views),
      accounts: views,
      compiled: compileOpenness(accounts, this.openness),
      openness: this.openness,
      approvals: [...this.approvals],
      flights: this.flights.slice(-40),
      agents: [...agents.values()],
      ledger: [...this.ledger.all()].reverse().slice(0, 80),
      chain: this.ledger.verifyChain(),
      daily: { used: this.dailyOutUsd(now), cap: this.openness.guard.dailyCapUsd },
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

  /** the event contracts an agent can trade: each question, its state, and every venue's top of book */
  markets(): MarketView[] {
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
    const dir = join(this.opts.home, "portfolio");
    const lines: StatementLine[] = [];
    const current = this.ledger.path();
    for (const name of existsSync(dir) ? readdirSync(dir).sort() : []) {
      if (!/^ledger-.*\.jsonl$/.test(name) || join(dir, name) === current) continue;
      for (const row of new Ledger(join(dir, name), this.now).all()) if (row.kind === "statement" && row.detail) lines.push(row.detail as StatementLine);
    }
    const before = new Set(lines.map((l) => l.key));
    const now = new Set<string>();
    for (const row of this.ledger.all()) if (row.kind === "statement" && row.detail) {
      lines.push(row.detail as StatementLine);
      now.add((row.detail as StatementLine).key);
    }
    // a line an earlier run left unfinished is not followed by this one: it says so, and counts only what had happened
    const final = new Set(["filled", "canceled", "rejected", "expired", "settled", "failed", "returned"]);
    return fold(lines).map((l) => (before.has(l.key) && !now.has(l.key) && !final.has(l.status) ? { ...l, status: "not followed since a restart", ...(l.status === "waiting for wallet" ? { amountUsd: 0 } : {}) } : l));
  }

  /** this run's ledger rows, oldest first */
  ledgerRows(): readonly LedgerRow[] {
    return this.ledger.all();
  }
}

/** what a restarted account brought back from its ledgers (account/restore.ts), as the page and the log say it */
export interface RestoreReport {
  /** how many earlier runs the account continues, and the first of them */
  runs: number;
  from: string;
  owner: boolean;
  agents: number;
  limits: number;
  mode: "Conservative" | "Aggressive";
  venues: Array<{ venue: string; ok: boolean; why?: string }>;
  orders: number;
  payments: number;
  skipped: string[];
  state: "restoring" | "done";
}

/** answers kept for a short while, and one request in flight per key */
class ReadCache {
  private readonly kept = new Map<string, { at: number; value: Promise<unknown> }>();
  get<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const hit = this.kept.get(key);
    if (hit && now - hit.at < ttlMs) return hit.value as Promise<T>;
    // a refusal is not kept: the next ask asks the venue again
    const value = load().then(
      (v) => {
        if (isRefusal(v)) this.kept.delete(key);
        return v;
      },
      (err: unknown) => {
        this.kept.delete(key);
        throw err;
      },
    );
    this.kept.set(key, { at: now, value });
    if (this.kept.size > 500) for (const [k, v] of this.kept) if (now - v.at >= 60_000) this.kept.delete(k);
    return value;
  }
}
