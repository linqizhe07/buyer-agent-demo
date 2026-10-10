/** REAL money, at venues connected live: the account's door for it.
 *
 * Everything else in the account moves simulated money. This moves the user's own money at the user's own venues, so it has its own
 * door, and nothing it does is mixed with a simulated leg. A movement is ONE venue call — an exchange withdrawal, a transfer between an
 * exchange's own ledgers, a stablecoin swap, or a transaction the user's own wallet sends — and it goes through only when all of this holds:
 *
 *   1. the server was started with real-money writes on (`--live-writes`); otherwise nothing here moves anything;
 *   2. the OWNER signed it: the exact destination address, the most the venue may charge, and the moment after which it is void. An agent
 *      asks: in Guard (the dial at `guard`, a real account's default) its request is a card, every time; in Beast (the dial at `open`,
 *      which only the owner's signature sets) a request inside its spending approval runs without one;
 *   3. it is no more than the most one movement may be on this server (`--live-cap`, $100 unless the server was started otherwise);
 *   4. money leaves for the user's own places only: an exchange's own deposit address (asked of that exchange when the owner signs, and
 *      asked again when it runs), or a wallet that signed the account's sentence to show it is the user's. Never an address someone typed;
 *   5. the venue itself agrees — its own key permissions, withdrawal allowlist and checks still apply, and its refusal is the answer.
 *
 * Nothing here signs a blockchain transaction: a wallet's transaction is handed to the wallet, and the wallet asks the user.
 */
import { getAddress, isAddress, keccak256, stringToHex, type Hex } from "viem";
import { isRefusal, type Refusal } from "../../core/errors.ts";
import { canonical } from "../../core/hash.ts";
import { no } from "../refuse.ts";
import type { AccountKind } from "../accounts.ts";
import { STABLECOINS, type ChainName } from "../live/chain.ts";
import { isStable } from "../live/types.ts";
import { holdBackMs } from "../live/public-markets.ts";
import type { LiveTrader } from "../live/trade.ts";
import type { Landed, LiveReceipt, LiveWriter, WalletTx } from "../live/writes.ts";
import type { BridgeRoute } from "../live/bridge.ts";
import { randomBytes } from "node:crypto";
import type { CardLike, Outcome } from "./exchange.ts";
import { paymentLine } from "./statement.ts";
import type { Payment, PaymentKind } from "./payments.ts";
import { CARD_TTL_MS } from "./mode-rules.ts";
import { micro, type AgentAction, type Envelope, type OwnerAction } from "./sign.ts";
import { covers, spendFor, type AgentKey, type SpendApproval } from "./state.ts";
import { isExpired, type Openness } from "../openness.ts";

export type LiveMoveAction = Extract<OwnerAction, { type: "liveMove" }>;
export type AgentLiveMoveAction = Extract<AgentAction, { type: "agentLiveMove" }>;
type Fields = Omit<LiveMoveAction, "type" | "nonce" | "toAddress" | "maxFee" | "deadline"> & { maxFee: string };

/** a venue connected live, as the door sees it */
export interface LiveVenue {
  id: string;
  name: string;
  kind: AccountKind;
  address?: string | undefined;
  /** who showed this address is the user's: the wallet that signed, or the mm session on this machine */
  proven?: string | undefined;
  writer?: LiveWriter | undefined;
  readOnlyBecause?: string | undefined;
  /** how orders are placed here, when they can be (live/trade.ts) */
  trader?: LiveTrader | undefined;
  /** why no order is placed here, when none is */
  noTradeBecause?: string | undefined;
  via: string;
}

/** what the engine's host gives this door */
export interface LiveMoney {
  writes(): { on: boolean; capUsd: number; turnOn: string };
  venue(id: string): LiveVenue | undefined;
  /** the real clock: a live venue does not follow the simulation's */
  realNow(): number;
  /** the hold a venue is under, shared with the reads and the other doors (service.ts): the refusal that holds it back now (its place rule,
   * its edge, a ban or a wait it asked for), when one does — nothing is asked of it until then */
  held?(venue: string): Refusal | undefined;
  /** a venue's answer that holds it back, given to that shared hold */
  hold?(venue: string, r: Refusal): void;
  /** the same for the earn door, whose place in the hold is its own where a connection reaches several venues (mm's earn is LI.FI's) */
  earnHeld?(venue: string): Refusal | undefined;
  earnHold?(venue: string, r: Refusal): void;
  /** a venue on the account whose venue has not answered this network yet — connected by the owner so, or not back after a restart — and is
   * asked again (service.ts waiting), in the words that say why: what is
   * followed there waits for it rather than being let go */
  waiting?(venue: string): string | undefined;
}

/** what this door uses of the engine */
export interface LiveEngine {
  payments: Payment[];
  host: {
    now(): string;
    log(row: Record<string, unknown>): void;
    liveMoney?(): LiveMoney;
    raiseCard: (flight: string, card: Parameters<import("./exchange.ts").Host["raiseCard"]>[1]) => CardLike;
    openFlight(agent: { id: string; name: string; code: string }, request: string): { no: string };
    say(flight: string, text: string, mark?: "ok" | "no" | "wait" | "note"): void;
    /** the dial: `guard` is Guard, `open` is Beast; and the agents' session, the venues switched off, what is opened where */
    policy(): Openness;
  };
  /** does a spending approval's own owner signature still check out against the owners now */
  stillSigned(s: SpendApproval): Promise<boolean>;
  state: { agents: AgentKey[] } & Parameters<typeof spendFor>[0];
  nextPaymentId(): string;
  patchSpend(id: string, f: (s: import("./state.ts").SpendApproval) => import("./state.ts").SpendApproval): void;
}

const KINDS = ["withdraw", "send", "transfer", "swap", "bridge"] as const;
/** real money moves in dollar stablecoins, so on the chains that carry one. A bridge goes by its own chains (bridge.ts BRIDGE_CHAINS), which
 * add Robinhood Chain in USDG: money crosses into it and out of it, but is not sent or withdrawn on it */
const NETWORKS = [...new Set(STABLECOINS.map((s) => s.chain))] as ChainName[];
const TTL_MS = 10 * 60_000;
const POLL_MS = 20_000;
const same = (a: string | undefined, b: string | undefined) => (a ?? "").toLowerCase() === (b ?? "").toLowerCase();
const usd = (n: number) => `$${n.toFixed(2)}`;

interface Plan {
  f: Fields;
  kind: (typeof KINDS)[number];
  src: LiveVenue & { writer: LiveWriter };
  dst: LiveVenue;
  amount: number;
  network?: ChainName | undefined;
  toAddress?: Hex | undefined;
  tag?: string | undefined;
  /** what the venue says it charges, in the asset */
  fee: number;
  /** a bridge: the chain it lands on, the route the account picked (the cheapest that passes bridge.ts's checks), and the others */
  toNetwork?: ChainName | undefined;
  route?: BridgeRoute | undefined;
  routes?: BridgeRoute[] | undefined;
}

export class LiveMoves {
  private readonly polled = new Map<string, number>();
  /** the one sweep on its way: a second caller waits for it rather than asking every venue again */
  private sweep: Promise<void> | undefined;
  private readonly routesSeen = new Map<string, { at: number; routes: BridgeRoute[] }>();
  /** this run of the account: a payment's line on the statement is told apart from another run's payment of the same id */
  private readonly runId = randomBytes(6).toString("hex");
  constructor(private readonly e: LiveEngine) {}

  /** the payment's line on the statement, as it stands now — and the payment itself, so that a restarted account follows it again. A payment
   * keeps the run that made it: its line is the same line whichever run writes it */
  private line(p: Payment): void {
    const names = (id: string) => this.money()?.venue(id)?.name ?? id;
    const run = p.run ?? this.runId;
    const l = paymentLine(p, run, names, (address) => this.e.state.agents.find((k) => k.address === address)?.name ?? address);
    this.e.host.log({ kind: "statement", venue: p.from, reason: `${l.id} · ${l.description} · ${l.status}`, detail: l, native: { payment: p, run } });
  }

  /** A movement an earlier run started and did not see land (account/restore.ts): followed again. Nothing is sent: the venue or the chain is
   * only asked whether it has landed. One handed to a wallet keeps the ten minutes it was given, and no more */
  adopt(p: Payment & { run: string }): void {
    if (this.e.payments.some((x) => x.id === p.id && (x.run ?? this.runId) === p.run)) return;
    const back: Payment = { ...p };
    this.e.payments.push(back);
    this.polled.delete(p.id);
    this.line(back);
  }

  private money(): LiveMoney | undefined {
    return this.e.host.liveMoney?.();
  }

  /** the refusal that keeps a venue back now, from the account's one hold (shared with its reads and the other doors): only what the venue
   * asked for — its place rule or its edge, a ban, a wait it named — not a read that only did not answer. Nothing is asked of it meanwhile */
  private heldNow(venue: string): Refusal | undefined {
    const r = this.money()?.held?.(venue);
    return r && (r.code === "E_VENUE_GEOBLOCKED" || typeof (r.native as { until?: unknown } | undefined)?.until === "number") && holdBackMs(r) > 0 ? r : undefined;
  }
  /** a venue asked for what a movement needs (its deposit address, its fee, the movement itself): its answer that asks to be left alone holds
   * it for every read and door, as the order door's does */
  private async asked<T>(venue: string, call: () => Promise<T | Refusal>): Promise<T | Refusal> {
    const r = await call();
    if (isRefusal(r) && (r.code === "E_VENUE_GEOBLOCKED" || typeof (r.native as { until?: unknown } | undefined)?.until === "number") && holdBackMs(r) > 0) this.money()?.hold?.(venue, r);
    return r;
  }
  /** a venue on the account that is not read yet: connected and waiting for its venue to answer this network (service.ts waiting) */
  private notYet(id: string, end: "from" | "to"): Refusal | undefined {
    const w = this.money()?.waiting?.(id);
    return w ? no(end === "to" ? "E_ACCOUNT_DESTINATION" : "E_VENUE_UNREACHABLE", { venue: id, message: `${w}: no money is moved ${end === "to" ? "to" : "from"} it until it answers` }) : undefined;
  }

  /** Everything that does not depend on who signed: the switch, the cap, the two venues, a destination that is the user's own, the fee */
  private async plan(f: Fields): Promise<Plan | Refusal> {
    const m = this.money();
    if (!m) return no("E_ACCOUNT_BAD_ACTION", { message: "this account has no venues connected live" });
    const w = m.writes();
    if (!w.on) return no("E_WALLET_LIVE_WRITES_OFF", { message: `this server moves no real money: it was started read-only. To turn it on, stop it and start it again with: ${w.turnOn}`, detail: { turnOn: w.turnOn } });
    if (!(KINDS as readonly string[]).includes(f.kind)) return no("E_ACCOUNT_BAD_ACTION", { message: `a live movement is ${KINDS.join(", ")}` });
    const kind = f.kind as Plan["kind"];
    if (!/^\d+(\.\d{1,6})?$/.test(f.amount) || !(Number(f.amount) > 0)) return no("E_ACCOUNT_BAD_ACTION", { message: "the amount is a plain decimal, more than zero, with at most six places" });
    const amount = Number(f.amount);
    if (!isStable(f.asset) || !isStable(f.toAsset)) return no("E_ACCOUNT_UNPRICED", { message: "real money moves here in dollar stablecoins only, so that the cap means dollars" });
    if (amount > w.capUsd) return no("E_ACCOUNT_LIMIT", { message: `${usd(amount)} is more than the most one real movement may be on this server (${usd(w.capUsd)}). It is set when the server starts: --live-cap`, detail: { capUsd: w.capUsd } });
    const src = m.venue(f.from);
    if (!src) return this.notYet(f.from, "from") ?? no("E_WALLET_ACCOUNT_UNKNOWN", { venue: f.from, message: `"${f.from}" is not a venue connected live: real money moves only between venues connected live` });
    if (!src.writer) return no("E_VENUE_RAIL_CLOSED", { venue: src.id, message: `${src.name}: ${src.readOnlyBecause ?? "this venue is read, not written"}` });
    // a venue that does not serve this network now, or asked to be left alone: not asked for anything, in its own words. A wallet the user
    // sends from themselves (a browser wallet, a bridge from it) is not a venue asked for anything
    const srcHeld = src.writer.can.send === "wallet" ? undefined : this.heldNow(src.id);
    if (srcHeld) return srcHeld;
    const from = src as Plan["src"];
    if (kind === "transfer" || kind === "swap") {
      if (f.to !== f.from) return no("E_ACCOUNT_BAD_ACTION", { message: `a ${kind} stays at one venue` });
      if (kind === "transfer") {
        const ledgers = from.writer.can.ledgers;
        if (from.writer.can.transfer === false && ledgers.length > 1) return no("E_VENUE_RAIL_CLOSED", { venue: src.id, message: `${src.name}: this key may not move money between its own ledgers. That is set on the key at the exchange` });
        if (!from.writer.transfer || !ledgers.includes(f.fromLedger) || !ledgers.includes(f.toLedger) || f.fromLedger === f.toLedger) return no("E_VENUE_RAIL_CLOSED", { venue: src.id, message: `${src.name}: money moves here between ${ledgers.join(" and ") || "no ledgers this account knows"}` });
        if (f.asset !== f.toAsset) return no("E_ACCOUNT_BAD_ACTION", { message: "a transfer between ledgers keeps the currency: swap is the other movement" });
      } else {
        if (!from.writer.swap || from.writer.can.swap === false) return no("E_VENUE_RAIL_CLOSED", { venue: src.id, message: `${src.name}: this key may not trade, so it cannot swap` });
        if (f.asset === f.toAsset) return no("E_ACCOUNT_BAD_ACTION", { message: "a swap is one stablecoin for another" });
      }
      return { f, kind, src: from, dst: src, amount, fee: 0 };
    }
    // money that leaves the venue: to the user's own place, on a network both ends know (a bridge: one of the bridge's own chains)
    if (kind === "bridge") return this.planBridge(f, from, f.network as ChainName, amount);
    if (!(NETWORKS as string[]).includes(f.network)) return no("E_ACCOUNT_BAD_ACTION", { message: `a network is one of ${NETWORKS.join(", ")}` });
    const network = f.network as ChainName;
    // the venue's own reason when it gave one (Polymarket: money leaves by a transfer made at Polymarket; Alpaca: its withdrawal call is sunset)
    if (kind === "withdraw" && (!from.writer.withdraw || from.writer.can.withdraw === false)) return no("E_VENUE_RAIL_CLOSED", { venue: src.id, message: `${src.name}: ${from.writer.can.why?.withdraw ?? "this key may not withdraw. That is set on the key at the exchange"}` });
    if (kind === "send" && !from.writer.can.send) return no("E_VENUE_RAIL_CLOSED", { venue: src.id, message: `${src.name}: ${from.writer.can.why?.send ?? "money leaves it at the venue, not from here"}` });
    // a pasted address is only watched: the account sends nothing from it, as it sends nothing to it
    if (kind === "send" && from.address !== undefined && !from.proven) return no("E_VENUE_RAIL_CLOSED", { venue: src.id, message: `${src.name} is watched, not proven yours: nothing is sent from it here. Connect it again from the wallet itself` });
    if (f.from === f.to) return no("E_ACCOUNT_BAD_ACTION", { message: "the money leaves for another venue" });
    const dst = m.venue(f.to);
    if (!dst) return this.notYet(f.to, "to") ?? no("E_ACCOUNT_DESTINATION", { venue: f.to, message: `"${f.to}" is not a venue connected live: real money goes only to a place of yours the account can see` });
    if (!dst.writer?.can.receive) return no("E_ACCOUNT_DESTINATION", { venue: dst.id, message: `${dst.name}: ${dst.readOnlyBecause ?? "nothing is sent there from here"}` });
    // a wallet's address is the user's only if it was shown to be; an exchange's deposit address is the exchange's own answer
    if (dst.address !== undefined && !dst.proven) return no("E_ACCOUNT_DESTINATION", { venue: dst.id, message: `${dst.name} is watched, not proven yours: real money goes only to an address a wallet signed for. Connect it again from the wallet itself` });
    // an exchange is asked for its deposit address: not while it does not serve this network, or asked to be left alone
    const dstHeld = dst.address === undefined ? this.heldNow(dst.id) : undefined;
    if (dstHeld) return dstHeld;
    const where = await this.asked(dst.id, () => dst.writer!.depositAddress(f.asset, network));
    if (isRefusal(where)) return where;
    const feeAsked = kind === "withdraw" && from.writer.withdrawFee ? await this.asked(from.id, async () => (await from.writer.withdrawFee!(f.asset, network)) ?? 0) : 0;
    if (isRefusal(feeAsked)) return feeAsked;
    const fee = feeAsked;
    return { f, kind, src: from, dst, amount, network, toAddress: where.address, ...(where.tag ? { tag: where.tag } : {}), fee };
  }

  /** ACROSS CHAINS, from a proven wallet: to the same wallet on another chain, to another wallet that proved it is the user's, or to an
   * exchange's own deposit address on the chain it lands on. `network` is the chain the money leaves, `toLedger` the chain it lands on.
   * The routes are LI.FI's, each checked against its own calldata (bridge.ts); the cheapest is the one signed for, and its fee is the most
   * any route may charge when it runs */
  private async planBridge(f: Fields, from: Plan["src"], network: ChainName, amount: number): Promise<Plan | Refusal> {
    const m = this.money()!;
    const bridge = from.writer.bridge;
    if (!bridge || from.writer.can.send !== "wallet") return no("E_VENUE_RAIL_CLOSED", { venue: from.id, message: `${from.name}: money crosses chains here only from a wallet of yours, which sends it itself` });
    if (from.address === undefined || !from.proven) return no("E_VENUE_RAIL_CLOSED", { venue: from.id, message: `${from.name} is watched, not proven yours: nothing is sent from it here. Connect it again from the wallet itself` });
    if (!(bridge.chains as string[]).includes(network)) return no("E_ACCOUNT_BAD_ACTION", { message: `a bridge leaves one of ${bridge.chains.join(", ")}` });
    if (!(bridge.chains as string[]).includes(f.toLedger) || f.toLedger === network) return no("E_ACCOUNT_BAD_ACTION", { message: `a bridge lands on another chain: one of ${bridge.chains.filter((c) => c !== network).join(", ")}` });
    const toNetwork = f.toLedger as ChainName;
    let dst: LiveVenue = from;
    let toAddress = from.address as Hex;
    if (f.to !== f.from) {
      const d = m.venue(f.to);
      if (!d) return this.notYet(f.to, "to") ?? no("E_ACCOUNT_DESTINATION", { venue: f.to, message: `"${f.to}" is not a venue connected live: real money goes only to a place of yours the account can see` });
      if (!d.writer?.can.receive) return no("E_ACCOUNT_DESTINATION", { venue: d.id, message: `${d.name}: ${d.readOnlyBecause ?? "nothing is sent there from here"}` });
      if (d.address !== undefined && !d.proven) return no("E_ACCOUNT_DESTINATION", { venue: d.id, message: `${d.name} is watched, not proven yours: real money goes only to an address a wallet signed for. Connect it again from the wallet itself` });
      const dHeld = d.address === undefined ? this.heldNow(d.id) : undefined;
      if (dHeld) return dHeld;
      const where = await this.asked(d.id, () => d.writer!.depositAddress(f.toAsset, toNetwork));
      if (isRefusal(where)) return where;
      if (where.tag) return no("E_ACCOUNT_DESTINATION", { venue: d.id, message: `${d.name} takes ${f.toAsset} on ${toNetwork} with a memo, which a bridge does not carry` });
      dst = d;
      toAddress = where.address;
    }
    // the routes for this exact draft, asked once a minute at most: LI.FI answers a machine without a key 75 quotes in two hours, and a route is
    // good for a couple of minutes (an Across fill deadline is checked against two minutes of room in bridge.ts)
    const key = [from.id, toAddress, network, toNetwork, f.asset, f.toAsset, amount].join("|");
    const now = m.realNow();
    const seen = this.routesSeen.get(key);
    const routes = seen && now - seen.at < 60_000 ? seen.routes : await bridge.routes({ to: toAddress, fromChain: network, toChain: toNetwork, asset: f.asset, toAsset: f.toAsset, amount });
    if (isRefusal(routes)) return routes;
    if (!seen || seen.routes !== routes) this.routesSeen.set(key, { at: now, routes });
    if (!routes.length) return no("E_VENUE_RAIL_CLOSED", { venue: from.id, message: `no bridge carries ${f.asset} from ${network} to ${toNetwork} for ${usd(amount)} right now` });
    // a route costs, at worst, what may fail to arrive (the amount less the least that arrives) and any fee paid on top in the chain's coin:
    // that is what is ranked, and what the owner's signature caps
    const worst = (r: BridgeRoute) => Number((amount - r.receiveUsd + Number((r.native.paidOnTop as { usd?: number } | undefined)?.usd ?? 0)).toFixed(6));
    const route = [...routes].sort((a, b) => worst(a) - worst(b) || a.etaSec - b.etaSec)[0]!;
    return { f, kind: "bridge", src: from, dst, amount, network, toNetwork, toAddress, fee: Math.max(route.feeUsd, worst(route)), route, routes };
  }

  /** what the owner is shown and signs: the destination address the venue gave, the fee, and ten minutes */
  async prepare(draft: Record<string, unknown>): Promise<Omit<LiveMoveAction, "nonce"> | Refusal> {
    const f: Fields = { kind: String(draft.kind ?? ""), from: String(draft.from ?? ""), fromLedger: String(draft.fromLedger ?? ""), to: String(draft.to ?? draft.from ?? ""), toLedger: String(draft.toLedger ?? ""), asset: String(draft.asset ?? "USDC"), toAsset: String(draft.toAsset ?? draft.asset ?? "USDC"), network: String(draft.network ?? ""), amount: String(draft.amount ?? "").trim(), maxFee: "0" };
    const p = await this.plan(f);
    if (isRefusal(p)) return p;
    // the fee the venue quotes, rounded up to the cent: a fee that grows past it before this runs is a new signature
    return { type: "liveMove", ...f, toAddress: p.toAddress ?? "", maxFee: (Math.ceil(p.fee * 100) / 100).toFixed(2), deadline: this.money()!.realNow() + TTL_MS };
  }

  /** a bridge's routes as the owner is shown them: the one signed for first, then the others */
  async bridgeRoutes(draft: Record<string, unknown>): Promise<Array<{ tool: string; feeUsd: number; gasUsd: number; receiveUsd: number; etaSec: number; picked: boolean }> | Refusal> {
    const f: Fields = { kind: "bridge", from: String(draft.from ?? ""), fromLedger: "", to: String(draft.to ?? draft.from ?? ""), toLedger: String(draft.toLedger ?? ""), asset: String(draft.asset ?? "USDC"), toAsset: String(draft.toAsset ?? draft.asset ?? "USDC"), network: String(draft.network ?? ""), amount: String(draft.amount ?? "").trim(), maxFee: "0" };
    const p = await this.plan(f);
    if (isRefusal(p)) return p;
    return (p.routes ?? []).map((r) => ({ tool: r.tool, feeUsd: r.feeUsd, gasUsd: r.gasUsd, receiveUsd: r.receiveUsd, etaSec: r.etaSec, picked: r === p.route })).sort((a, b) => Number(b.picked) - Number(a.picked));
  }

  /** The owner's signed instruction: planned again, compared with what was signed, and run */
  async owner(a: LiveMoveAction, who: { signer: string; envelope: Envelope; hash: Hex }): Promise<Outcome> {
    const p = await this.plan(a);
    if (isRefusal(p)) return p;
    if (this.money()!.realNow() > a.deadline) return no("E_ACCOUNT_EXPIRED", { message: "this real-money instruction was good for ten minutes after it was prepared: prepare it again" });
    const changed = this.changed(p, a.toAddress, a.maxFee);
    if (changed) return changed;
    return this.run(p, { signer: who.signer, authority: "owner", action: who.hash, deadline: a.deadline });
  }

  /** what has changed since the owner looked: the destination address, or a fee above what was signed */
  private changed(p: Plan, toAddress: string, maxFee: string): Refusal | null {
    if ((p.toAddress ?? "") !== "" || toAddress !== "") {
      if (!same(p.toAddress, toAddress)) return no("E_ACCOUNT_REQUOTE", { venue: p.dst.id, message: `${p.dst.name} now gives ${p.toAddress} as the address, not the ${toAddress} that was signed for: nothing was sent. Prepare it again`, detail: { signed: toAddress, now: p.toAddress } });
    }
    if (p.fee > Number(maxFee) + 1e-9) return no("E_ACCOUNT_REQUOTE", { venue: p.src.id, message: `${p.src.name} now charges ${p.fee} ${p.f.asset}; the signature allows ${maxFee}: nothing was sent. Prepare it again`, detail: { fee: p.fee, maxFee } });
    return null;
  }

  /** An agent asks. Guard: the owner sees the exact address and fee on a card, and signs that. Beast: inside its spending
   * approval it runs at once — still only to the user's own places, under the server's cap and the venue's own checks */
  /** the agent's spending approval as it stands now: its owner signature still good, the dial open at both ends, both ends named, the
   * amount inside its lines. Asked when the agent asks, and again when the owner answers its card */
  private async standing(a: AgentLiveMoveAction, signer: string): Promise<SpendApproval | Refusal> {
    const now = Date.parse(this.e.host.now());
    const spend = spendFor(this.e.state, signer, "venues", now);
    if (isRefusal(spend)) return spend;
    if (!(await this.e.stillSigned(spend))) return no("E_ACCOUNT_BAD_SIGNATURE", { message: "the spending approval's own signature no longer checks out against the account's owners", detail: { approval: spend.id } });
    // the dial: the agents' session, and each end switched on for agents
    const o = this.e.host.policy();
    if (isExpired(this.e.host.now(), o.sessionExpiresAt)) return no("E_WALLET_SESSION_EXPIRED", { message: "the agent's session has expired: every write stops, reads continue", detail: { sessionExpiresAt: o.sessionExpiresAt } });
    const off = [a.from, a.to].find((x) => o.revoked.includes(x));
    if (off) return no("E_WALLET_ACCOUNT_REVOKED", { venue: off, message: `${off} is switched off for agents: reads only`, detail: { revoked: o.revoked } });
    for (const venue of new Set([a.from, a.to])) {
      const c = covers(spend, venue, micro(a.amount), now);
      if (c) return c;
    }
    return spend;
  }

  async agent(a: AgentLiveMoveAction, who: { signer: string; envelope: Envelope; hash: Hex; agent: AgentKey }): Promise<Outcome> {
    const now = Date.parse(this.e.host.now());
    const spend = await this.standing(a, who.signer);
    if (isRefusal(spend)) return spend;
    const amountMicro = micro(a.amount);
    const p = await this.plan(a);
    if (isRefusal(p)) return p;
    // the most the agent said it would pay in fees, when it said one: in either mode
    if (Number(a.maxFee) > 0 && p.fee > Number(a.maxFee) + 1e-9) return no("E_ACCOUNT_REQUOTE", { venue: p.src.id, message: `${p.src.name} charges ${p.fee} ${a.asset}; the request allows ${a.maxFee}: nothing was sent`, detail: { fee: p.fee, maxFee: a.maxFee } });
    const flight = this.e.host.openFlight({ id: who.agent.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), name: who.agent.name, code: who.agent.code }, `${a.kind} ${a.amount} ${a.asset} · real money`);
    if (this.e.host.policy().mode === "open") {
      const out = await this.run(p, { signer: who.signer, authority: "agent", agent: who.agent.address, action: who.hash });
      if (isRefusal(out)) return out;
      this.e.patchSpend(spend.id, (x) => ({ ...x, spentMicro: x.spentMicro + amountMicro }));
      this.e.host.log({ kind: "action", venue: a.from, tool: a.type, signer: who.signer, envelope: who.envelope, outcome: "accepted", notionalUsd: p.amount, reason: `Beast: ${this.words(p)}, inside the approval`, flight: flight.no });
      this.e.host.say(flight.no, `${who.agent.name} ${this.words(p)}: inside its limit, so it went without a card (Beast)`, "ok");
      return out.kind === "payment" || out.kind === "result" ? { ...out, flight: flight.no } : out;
    }
    // the fee on the card is the most the owner's yes lets it cost, rounded up to the cent
    const offer = { payee: p.dst.name, payTo: p.toAddress ?? `${p.f.fromLedger} → ${p.f.toLedger}`, amount: `${a.amount} ${a.asset}${a.kind === "swap" ? ` → ${a.toAsset}` : ""}`, protocol: `real money · ${this.protocol(p)}`, network: p.toNetwork ? `${p.network} → ${p.toNetwork}` : (p.network ?? p.src.name), fee: `${(Math.ceil(p.fee * 100 - 1e-6) / 100).toFixed(2)} ${a.asset}` };
    // the owner's answer signs the card's hash: here that hash covers the agent's request AND the address and fee the owner is shown
    const actionHash = keccak256(stringToHex(canonical({ action: who.hash, offer })));
    const card = this.e.host.raiseCard(flight.no, { account: a.from, intent: { kind: "move", asset: a.asset, amount: p.amount, to: p.toAddress ?? a.to }, usd: p.amount, reason: `${who.agent.name} asks to ${this.words(p)}`, why: "live", action: a, actionHash, signer: who.signer, expiresAt: new Date(now + CARD_TTL_MS).toISOString(), offer: { payee: offer.payee, payTo: offer.payTo, amount: offer.amount, protocol: offer.protocol, network: offer.network, fee: offer.fee }, approval: spend.id });
    this.e.patchSpend(spend.id, (x) => ({ ...x, reservedMicro: x.reservedMicro + amountMicro }));
    this.e.host.log({ kind: "action", venue: a.from, tool: a.type, signer: who.signer, envelope: who.envelope, outcome: "card", notionalUsd: p.amount, reason: `${card.id} · ${this.words(p)}`, flight: flight.no, intentId: card.id });
    return { ok: true, kind: "card", pending: true, card, flight: flight.no };
  }

  /** the owner approved an agent's card: planned again, held to the address and fee on the card, run, and counted in the approval */
  async release(card: CardLike, who: { signer: string; agent: AgentKey }): Promise<Outcome> {
    const a = card.action as AgentLiveMoveAction;
    // the agent's approval as it stands now (answering the card has freed what the card held), its signature, the dial
    const spend = await this.standing(a, who.signer);
    if (isRefusal(spend)) return spend;
    const p = await this.plan(a);
    if (isRefusal(p)) return p;
    // held to the card: the address it showed, the fee it showed (and the agent's own most, when it gave one), and the way it showed
    const shown = card.offer?.payTo ?? "";
    const cardFee = Number.parseFloat(card.offer?.fee ?? "");
    const cap = Math.min(Number.isFinite(cardFee) ? cardFee : 0, Number(a.maxFee) > 0 ? Number(a.maxFee) : Infinity);
    const changed = this.changed(p, p.toAddress ? shown : "", String(cap));
    if (changed) return changed;
    if (card.offer?.protocol !== undefined && card.offer.protocol !== `real money · ${this.protocol(p)}`) return no("E_ACCOUNT_REQUOTE", { venue: p.src.id, message: `the card was for ${card.offer.protocol.replace("real money · ", "")}; it would now go by ${this.protocol(p)}: nothing was sent`, detail: { card: card.offer.protocol } });
    const out = await this.run(p, { signer: who.signer, authority: "agent", agent: who.agent.address, card: card.id, action: card.actionHash });
    if (!isRefusal(out)) this.e.patchSpend(spend.id, (x) => ({ ...x, spentMicro: x.spentMicro + micro(a.amount) }));
    return out;
  }

  private protocol(p: Plan): string {
    return p.kind === "bridge" ? `${p.route?.tool ?? "a bridge"}, routed by LI.FI, sent by your wallet` : p.kind === "withdraw" ? `${p.src.via} withdrawal` : p.kind === "transfer" ? `${p.src.via} transfer` : p.kind === "swap" ? `${p.src.via} market order` : p.src.writer.can.send === "mm" ? "mm transfer" : p.src.writer.can.send === "account" ? "a transfer the account signs with the agent wallet's key" : "a transaction your wallet sends";
  }

  private words(p: Plan): string {
    const f = p.f;
    return p.kind === "bridge" ? `bridge ${f.amount} ${f.asset} from ${p.src.name} on ${p.network} to ${p.dst.id === p.src.id ? "the same wallet" : p.dst.name} on ${p.toNetwork}` : p.kind === "transfer" ? `move ${f.amount} ${f.asset} at ${p.src.name} from ${f.fromLedger} to ${f.toLedger}` : p.kind === "swap" ? `swap ${f.amount} ${f.asset} for ${f.toAsset} at ${p.src.name}` : `send ${f.amount} ${f.asset} from ${p.src.name} to ${p.dst.name} on ${p.network}`;
  }

  /** the one venue call, and the payment it becomes */
  private async run(p: Plan, who: { signer: string; authority: "owner" | "agent"; agent?: string | undefined; card?: string | undefined; action?: Hex | undefined; deadline?: number | undefined }): Promise<Outcome> {
    const f = p.f;
    const id = this.e.nextPaymentId();
    const at = new Date(this.money()!.realNow()).toISOString();
    let r: LiveReceipt | WalletTx | Refusal;
    // a bridge: the approval (when one is needed) and the transfer, for the wallet to send in that order
    const bridgeTxs = p.kind === "bridge" && p.route ? [...(p.route.approval?.txs ?? []), { ...p.route.tx, what: "bridge" } satisfies WalletTx] : undefined;
    // the venue the money leaves, held back since this was planned (its place rule, its edge, a ban): nothing is sent to it, in its words
    const held = bridgeTxs ? undefined : this.heldNow(p.src.id);
    if (held) r = held;
    else if (bridgeTxs) r = bridgeTxs[bridgeTxs.length - 1]!;
    // the exchange's idempotency key: the payment's id AND this run's, since a later run can hand the same payment id out again
    else if (p.kind === "withdraw") r = await p.src.writer.withdraw!({ asset: f.asset, amount: p.amount, address: p.toAddress!, tag: p.tag, network: p.network!, clientId: `${id}-${this.runId}` });
    else if (p.kind === "transfer") r = await p.src.writer.transfer!({ asset: f.asset, amount: p.amount, from: f.fromLedger, to: f.toLedger });
    else if (p.kind === "swap") r = await p.src.writer.swap!({ sell: f.asset, buy: f.toAsset, amount: p.amount });
    else if (p.src.writer.can.send === "mm" || p.src.writer.can.send === "account") r = await p.src.writer.send!({ asset: f.asset, amount: p.amount, to: p.toAddress!, network: p.network! });
    else r = await p.src.writer.walletTx!({ asset: f.asset, amount: p.amount, to: p.toAddress!, network: p.network! });
    if (isRefusal(r)) {
      this.e.host.log({ kind: "account-refusal", venue: p.src.id, tool: `live ${p.kind}`, code: r.code, reason: r.message, native: r.native, signer: who.signer });
      // the venue's own answer that asks to be left alone (not a hold this door took it from) holds it for every read and door
      if (r !== held && (r.code === "E_VENUE_GEOBLOCKED" || typeof (r.native as { until?: unknown } | undefined)?.until === "number") && holdBackMs(r) > 0) this.money()?.hold?.(p.src.id, r);
      return r;
    }
    const wallet = "data" in r ? r : undefined;
    const receipt = "data" in r ? undefined : r;
    const kind: PaymentKind = p.kind === "swap" ? "swap" : p.kind === "transfer" ? "transfer" : p.kind === "bridge" && p.dst.id === p.src.id ? "transfer" : p.dst.kind === "cex" ? "deposit" : "withdraw";
    const status = wallet ? "authorized" : receipt!.status === "settled" ? "settled" : "pending";
    const payment: Payment = {
      id,
      kind,
      at,
      from: p.src.id,
      to: p.dst.id,
      sourceToken: f.asset,
      token: f.toAsset,
      amountUsd: p.amount,
      feeUsd: p.fee,
      receiveUsd: receipt?.received ?? (p.route ? p.route.receiveUsd : Math.max(0, p.amount - p.fee)),
      legs: [{ step: p.kind === "swap" ? "swap" : p.kind === "transfer" ? "shift" : p.kind === "bridge" ? "bridge" : "out", venue: p.src.id, rail: p.kind, protocol: this.protocol(p), token: f.toAsset, ...(p.network ? { chain: p.network } : {}), ...(p.kind === "transfer" ? { fromLedger: f.fromLedger, toLedger: f.toLedger } : {}), feeUsd: p.fee, etaSec: p.route ? p.route.etaSec : p.kind === "withdraw" || p.kind === "send" ? 300 : 0, access: "owner", final: true, status: status === "settled" ? "settled" : "pending", startedAt: at, ...(receipt ? { ref: receipt.ref, native: receipt.native } : { native: { walletTx: wallet, ...(bridgeTxs ? { walletTxs: bridgeTxs, route: p.route!.native } : {}) } }) }],
      status,
      settlesAt: at,
      ...(status === "settled" ? { settledAt: at } : {}),
      signer: who.signer,
      authority: who.authority,
      ...(who.agent ? { agent: who.agent } : {}),
      ...(who.action ? { action: who.action } : {}),
      ...(who.card ? { card: who.card } : {}),
      live: { kind: p.kind, ...(p.toAddress ? { toAddress: p.toAddress } : {}), ...(p.network ? { network: p.network } : {}), ...(p.src.writer.can.send === "account" && receipt ? { txHash: receipt.ref as Hex } : {}), ...(p.toNetwork ? { toNetwork: p.toNetwork } : {}), ...(p.route ? { tool: p.route.tool } : {}), ...(wallet ? { sendBy: new Date(Math.min(who.deadline ?? Infinity, this.money()!.realNow() + TTL_MS)).toISOString() } : {}) },
      note: wallet ? `waiting for your wallet to send it: ${p.src.name} asks you to confirm` : status === "settled" ? `done at ${p.src.name}` : (receipt?.native as { unsure?: unknown } | undefined)?.unsure ? `${p.src.name} did not answer whether it took it: it may have, so it is followed here and not sent again. Look at ${p.src.name} before asking again` : `${p.src.name} took it; waiting for it to land`,
    };
    this.e.payments.unshift(payment);
    // the venue is asked how it went no sooner than twenty seconds after it took it
    this.polled.set(id, this.money()!.realNow());
    this.e.host.log({ kind: "payment", venue: p.src.id, tool: `live ${p.kind}`, outcome: status, payment: id, notionalUsd: p.amount, reason: `${id} · real money · ${this.words(p)}${p.toAddress ? ` · to ${p.toAddress}` : ""}`, native: receipt?.native ?? { walletTx: wallet }, signer: who.signer });
    this.line(payment);
    return wallet ? { ok: true, kind: "result", result: { payment, wallet, ...(bridgeTxs ? { walletTxs: bridgeTxs } : {}) } } : { ok: true, kind: "payment", payment };
  }

  /** the page tells which transaction the wallet sent for a payment that was waiting for it; the chain decides whether it is that payment */
  async sent(paymentId: string, hash: string): Promise<Outcome> {
    const p = this.e.payments.find((x) => x.id === paymentId);
    // waiting for its wallet — or given up on for being late, when the wallet sent it after all: the chain decides, and it is followed
    if (!p?.live || !(p.status === "authorized" || (p.status === "failed" && p.live.expired))) return no("E_ACCOUNT_BAD_ACTION", { message: `no payment ${paymentId} is waiting for a wallet` });
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return no("E_ACCOUNT_BAD_ACTION", { message: "a transaction hash is 0x and sixty-four hex digits" });
    // once a wallet has sent one, that is the transaction: a second, different hash for the same payment is not taken
    if (p.live.reported && !same(p.live.reported, hash)) return no("E_ACCOUNT_BAD_ACTION", { message: `your wallet already sent ${p.live.reported.slice(0, 10)}… for ${p.id}: report that one`, detail: { reported: p.live.reported } });
    if (p.live.kind === "bridge") {
      // the hash is held to the transfer that was built — sender, contract, call, coin, chain — before the account follows it; a hash the
      // chain does not show yet is remembered (so the page reports it again rather than sending again) but not followed
      const src = this.money()?.venue(p.from);
      const expected = (p.legs[0]!.native as { walletTx?: WalletTx } | undefined)?.walletTx;
      if (!src?.writer?.bridge || !expected) return no("E_VENUE_RAIL_CLOSED", { venue: p.from, message: `${src?.name ?? p.from} is no longer connected live` });
      const seen = await src.writer.bridge.confirm(hash as Hex, expected as never);
      if (isRefusal(seen)) return seen;
      if (seen !== "ok") {
        p.live = { ...p.live, reported: hash as Hex };
        return no("E_VENUE_UNREACHABLE", { venue: p.from, message: `${p.live.network} does not show ${hash.slice(0, 10)}… yet (or its endpoint did not answer just now): it is asked again here, and followed once it shows it — or report it again in a moment (“Report again” sends nothing new)`, detail: { reported: hash } });
      }
    }
    p.live = { ...p.live, txHash: hash as Hex, reported: hash as Hex, expired: undefined };
    p.status = "pending";
    p.legs[0]!.ref = hash;
    p.legs[0]!.status = "pending";
    p.note = `sent from the wallet: ${hash.slice(0, 10)}…, waiting for ${p.live.network}`;
    this.e.host.log({ kind: "payment", venue: p.from, tool: "live send", outcome: "pending", payment: p.id, reason: `${p.id} · the wallet sent ${hash}`, native: { txHash: hash } });
    this.line(p);
    this.polled.delete(p.id);
    await this.poll();
    return { ok: true, kind: "payment", payment: p };
  }

  /** what has landed: asked of the venue or the chain, at most every twenty seconds per payment. One sweep at a time, and the payments in it
   * asked all at once — a venue or a chain that this network leaves unanswered holds up its own payments, not every other one in turn */
  poll(): Promise<void> {
    return (this.sweep ??= this.sweepOnce().finally(() => (this.sweep = undefined)));
  }

  private async sweepOnce(): Promise<void> {
    const m = this.money();
    if (!m) return;
    const now = m.realNow();
    const due: Payment[] = [];
    for (const p of this.e.payments) {
      // a bridge transaction the wallet reported, which its chain did not show then: asked again here, and followed once the chain shows it
      if (p.live?.kind === "bridge" && p.status === "authorized" && p.live.reported && !p.live.txHash) {
        if (now - (this.polled.get(p.id) ?? 0) < POLL_MS) continue;
        this.polled.set(p.id, now);
        due.push(p);
        continue;
      }
      // a transaction handed to a wallet and never reported is good for ten minutes, as the signature was: after that it is not sent from here
      if (p.live && p.status === "authorized" && !p.live.reported && p.live.sendBy && now > Date.parse(p.live.sendBy)) {
        Object.assign(p, { status: "failed", note: "not sent in time: the wallet was not asked to send it within ten minutes. Prepare it again" });
        p.live.expired = true;
        Object.assign(p.legs[0]!, { status: "failed" });
        this.e.host.log({ kind: "payment", venue: p.from, tool: `live ${p.live.kind}`, outcome: "failed", payment: p.id, reason: `${p.id} · ${p.note}` });
        this.line(p);
        continue;
      }
      if (!p.live || p.status !== "pending") continue;
      if (now - (this.polled.get(p.id) ?? 0) < POLL_MS) continue;
      // a venue under a hold (a ban until a time, its edge refusing this network) is not asked; its payment stays on its way
      if (p.live.kind !== "bridge" && !p.live.txHash && m.held?.(p.from)) continue;
      this.polled.set(p.id, now);
      due.push(p);
    }
    await Promise.allSettled(due.map((p) => this.ask(m, p, now)));
  }

  /** a reported bridge transaction its chain did not show: the chain is asked again (held to the transfer that was built), and once it shows
   * it the payment is followed as any sent one */
  private async seen(m: LiveMoney, p: Payment): Promise<void> {
    const src = m.venue(p.from);
    const expected = (p.legs[0]!.native as { walletTx?: WalletTx } | undefined)?.walletTx;
    const hash = p.live?.reported;
    if (!p.live || !hash || !src?.writer?.bridge || !expected) return;
    const shown = await src.writer.bridge.confirm(hash, expected as never).catch(() => "pending" as const);
    if (shown !== "ok") return;
    p.live = { ...p.live, txHash: hash, expired: undefined };
    p.status = "pending";
    p.legs[0]!.ref = hash;
    p.legs[0]!.status = "pending";
    p.note = `sent from the wallet: ${hash.slice(0, 10)}…, waiting for ${p.live.network}`;
    this.e.host.log({ kind: "payment", venue: p.from, tool: "live send", outcome: "pending", payment: p.id, reason: `${p.id} · ${p.live.network} shows ${hash}`, native: { txHash: hash } });
    this.line(p);
  }

  /** one payment: asked of its venue or its chain, and its line written when it has landed or failed */
  private async ask(m: LiveMoney, p: Payment, now: number): Promise<void> {
    if (!p.live) return;
    if (p.status === "authorized") return this.seen(m, p);
    const src = m.venue(p.from);
    const leg = p.legs[0]!;
    let landed: Landed | Refusal = "pending";
    let received: number | undefined;
    let said: string | undefined;
    if (p.live.kind === "bridge") {
      // a bridge lands on the other chain, later: LI.FI and the chain say when, and how much arrived. An answer about another transfer, or no
      // answer, keeps it on its way — it is never counted as failed on a guess
      if (!p.live.txHash || !src?.writer?.bridge) return;
      const st = await src.writer.bridge.status({ hash: p.live.txHash, fromChain: p.live.network as ChainName, toChain: p.live.toNetwork as ChainName, tool: p.live.tool, to: p.live.toAddress }).catch(() => undefined);
      // still on its way; when that is because LI.FI refuses this network just now, its words say so on the payment (once)
      if (st && !isRefusal(st) && st.status === "pending" && st.refusal && p.note !== st.refusal.message) {
        p.note = st.refusal.message;
        this.line(p);
      }
      if (!st || isRefusal(st) || st.status === "pending") return;
      if (st.status === "settled") {
        received = st.received;
        landed = "settled";
        said = st.note;
      } else landed = no("E_VENUE_REJECTED", { venue: p.from, message: st.note });
    } else if (p.live.txHash && src?.writer?.confirm) {
      const nonce = (leg.native as { nonce?: unknown } | undefined)?.nonce;
      landed = await src.writer.confirm(p.live.txHash, { asset: p.sourceToken, amount: p.amountUsd, to: p.live.toAddress as Hex, network: p.live.network as ChainName, ...(typeof nonce === "number" ? { nonce } : {}) });
    }
    else if (leg.ref && src?.writer?.landed) landed = await src.writer.landed(leg.ref, p.sourceToken, Date.parse(p.at), { address: p.live.toAddress, amount: p.amountUsd, taken: this.e.payments.filter((x) => x !== p && x.from === p.from).map((x) => x.legs[0]?.ref ?? "").filter(Boolean) });
    if (landed === "pending") return;
    // answered while the sweep ran: stamped again from the answer, so a slow venue does not make every payment due at once
    this.polled.set(p.id, Math.max(now, m.realNow()));
    const at = new Date(now).toISOString();
    if (landed === "settled") {
      Object.assign(p, { status: "settled", settledAt: at, ...(received !== undefined ? { receiveUsd: received } : {}), note: p.live.kind === "bridge" ? (said ?? `landed on ${p.live.toNetwork}${received !== undefined ? `: ${received} arrived` : ""}`) : p.live.txHash ? `landed: the transfer is on ${p.live.network}, in transaction ${p.live.txHash.slice(0, 10)}…` : `landed: ${src?.name ?? p.from} says it is done` });
      Object.assign(leg, { status: "settled", settlesAt: at });
    } else {
      Object.assign(p, { status: "failed", note: isRefusal(landed) ? landed.message : `${src?.name ?? p.from} says it failed` });
      Object.assign(leg, { status: "failed" });
    }
    this.e.host.log({ kind: "payment", venue: p.from, tool: `live ${p.live.kind}`, outcome: p.status, payment: p.id, reason: `${p.id} · ${p.note}` });
    this.line(p);
  }
}

export const isEvmAddress = (a: string): a is Hex => isAddress(a, { strict: false });
export const checksum = (a: string): Hex => getAddress(a);
