/** REAL money, at venues connected live: the account's door for it.
 *
 * Everything else in the account moves simulated money. This moves the user's own money at the user's own venues, so it has its own
 * door, and nothing it does is mixed with a simulated leg. A movement is ONE venue call — an exchange withdrawal, a transfer between an
 * exchange's own ledgers, a stablecoin swap, or a transaction the user's own wallet sends — and it goes through only when all of this holds:
 *
 *   1. the server was started with real-money writes on (`--live-writes`); otherwise nothing here moves anything;
 *   2. the OWNER signed it: the exact destination address, the most the venue may charge, and the moment after which it is void. An agent
 *      can only ask: its request is a card, every time, whatever its spending approval says;
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
import { CHAINS, type ChainName } from "../live/chain.ts";
import { isStable } from "../live/types.ts";
import type { Landed, LiveReceipt, LiveWriter, WalletTx } from "../live/writes.ts";
import type { CardLike, Outcome } from "./exchange.ts";
import type { Payment, PaymentKind } from "./payments.ts";
import { micro, type AgentAction, type Envelope, type OwnerAction } from "./sign.ts";
import { covers, spendFor, type AgentKey } from "./state.ts";

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
  via: string;
}

/** what the engine's host gives this door */
export interface LiveMoney {
  writes(): { on: boolean; capUsd: number; turnOn: string };
  venue(id: string): LiveVenue | undefined;
  /** the real clock: a live venue does not follow the simulation's */
  realNow(): number;
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
  };
  state: { agents: AgentKey[] } & Parameters<typeof spendFor>[0];
  nextPaymentId(): string;
  patchSpend(id: string, f: (s: import("./state.ts").SpendApproval) => import("./state.ts").SpendApproval): void;
}

const KINDS = ["withdraw", "send", "transfer", "swap"] as const;
const NETWORKS = Object.keys(CHAINS) as ChainName[];
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
}

export class LiveMoves {
  private readonly polled = new Map<string, number>();
  constructor(private readonly e: LiveEngine) {}

  private money(): LiveMoney | undefined {
    return this.e.host.liveMoney?.();
  }

  /** Everything that does not depend on who signed: the switch, the cap, the two venues, a destination that is the user's own, the fee */
  private async plan(f: Fields): Promise<Plan | Refusal> {
    const m = this.money();
    if (!m) return no("E_ACCOUNT_BAD_ACTION", { message: "this account has no venues connected live" });
    const w = m.writes();
    if (!w.on) return no("E_WALLET_LIVE_WRITES_OFF", { message: `this server moves no real money: it was started without real-money writes. To turn them on, stop it and start it again with: ${w.turnOn}`, detail: { turnOn: w.turnOn } });
    if (!(KINDS as readonly string[]).includes(f.kind)) return no("E_ACCOUNT_BAD_ACTION", { message: `a live movement is ${KINDS.join(", ")}` });
    const kind = f.kind as Plan["kind"];
    if (!/^\d+(\.\d{1,6})?$/.test(f.amount) || !(Number(f.amount) > 0)) return no("E_ACCOUNT_BAD_ACTION", { message: "the amount is a plain decimal, more than zero, with at most six places" });
    const amount = Number(f.amount);
    if (!isStable(f.asset) || !isStable(f.toAsset)) return no("E_ACCOUNT_UNPRICED", { message: "real money moves here in dollar stablecoins only, so that the cap means dollars" });
    if (amount > w.capUsd) return no("E_ACCOUNT_LIMIT", { message: `${usd(amount)} is more than the most one real movement may be on this server (${usd(w.capUsd)}). It is set when the server starts: --live-cap`, detail: { capUsd: w.capUsd } });
    const src = m.venue(f.from);
    if (!src) return no("E_WALLET_ACCOUNT_UNKNOWN", { venue: f.from, message: `"${f.from}" is not a venue connected live: real money moves only between venues connected live` });
    if (!src.writer) return no("E_VENUE_RAIL_CLOSED", { venue: src.id, message: `${src.name}: ${src.readOnlyBecause ?? "this venue is read, not written"}` });
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
    // money that leaves the venue: to the user's own place, on a network both ends know
    if (!(NETWORKS as string[]).includes(f.network)) return no("E_ACCOUNT_BAD_ACTION", { message: `a network is one of ${NETWORKS.join(", ")}` });
    const network = f.network as ChainName;
    if (kind === "withdraw" && (!from.writer.withdraw || from.writer.can.withdraw === false)) return no("E_VENUE_RAIL_CLOSED", { venue: src.id, message: `${src.name}: this key may not withdraw. That is set on the key at the exchange` });
    if (kind === "send" && !from.writer.can.send) return no("E_VENUE_RAIL_CLOSED", { venue: src.id, message: `${src.name}: money leaves it at the venue, not from here` });
    // a pasted address is only watched: the account sends nothing from it, as it sends nothing to it
    if (kind === "send" && from.address !== undefined && !from.proven) return no("E_VENUE_RAIL_CLOSED", { venue: src.id, message: `${src.name} is watched, not proven yours: nothing is sent from it here. Connect it again from the wallet itself` });
    if (f.from === f.to) return no("E_ACCOUNT_BAD_ACTION", { message: "the money leaves for another venue" });
    const dst = m.venue(f.to);
    if (!dst) return no("E_ACCOUNT_DESTINATION", { venue: f.to, message: `"${f.to}" is not a venue connected live: real money goes only to a place of yours the account can see` });
    if (!dst.writer?.can.receive) return no("E_ACCOUNT_DESTINATION", { venue: dst.id, message: `${dst.name}: ${dst.readOnlyBecause ?? "nothing is sent there from here"}` });
    // a wallet's address is the user's only if it was shown to be; an exchange's deposit address is the exchange's own answer
    if (dst.address !== undefined && !dst.proven) return no("E_ACCOUNT_DESTINATION", { venue: dst.id, message: `${dst.name} is watched, not proven yours: real money goes only to an address a wallet signed for. Connect it again from the wallet itself` });
    const where = await dst.writer.depositAddress(f.asset, network);
    if (isRefusal(where)) return where;
    const fee = kind === "withdraw" ? ((await from.writer.withdrawFee?.(f.asset, network)) ?? 0) : 0;
    return { f, kind, src: from, dst, amount, network, toAddress: where.address, ...(where.tag ? { tag: where.tag } : {}), fee };
  }

  /** what the owner is shown and signs: the destination address the venue gave, the fee, and ten minutes */
  async prepare(draft: Record<string, unknown>): Promise<Omit<LiveMoveAction, "nonce"> | Refusal> {
    const f: Fields = { kind: String(draft.kind ?? ""), from: String(draft.from ?? ""), fromLedger: String(draft.fromLedger ?? ""), to: String(draft.to ?? draft.from ?? ""), toLedger: String(draft.toLedger ?? ""), asset: String(draft.asset ?? "USDC"), toAsset: String(draft.toAsset ?? draft.asset ?? "USDC"), network: String(draft.network ?? ""), amount: String(draft.amount ?? "").trim(), maxFee: "0" };
    const p = await this.plan(f);
    if (isRefusal(p)) return p;
    // the fee the venue quotes, rounded up to the cent: a fee that grows past it before this runs is a new signature
    return { type: "liveMove", ...f, toAddress: p.toAddress ?? "", maxFee: (Math.ceil(p.fee * 100) / 100).toFixed(2), deadline: this.money()!.realNow() + TTL_MS };
  }

  /** The owner's signed instruction: planned again, compared with what was signed, and run */
  async owner(a: LiveMoveAction, who: { signer: string; envelope: Envelope; hash: Hex }): Promise<Outcome> {
    const p = await this.plan(a);
    if (isRefusal(p)) return p;
    if (this.money()!.realNow() > a.deadline) return no("E_ACCOUNT_EXPIRED", { message: "this real-money instruction was good for ten minutes after it was prepared: prepare it again" });
    const changed = this.changed(p, a.toAddress, a.maxFee);
    if (changed) return changed;
    return this.run(p, { signer: who.signer, authority: "owner", action: who.hash });
  }

  /** what has changed since the owner looked: the destination address, or a fee above what was signed */
  private changed(p: Plan, toAddress: string, maxFee: string): Refusal | null {
    if ((p.toAddress ?? "") !== "" || toAddress !== "") {
      if (!same(p.toAddress, toAddress)) return no("E_ACCOUNT_REQUOTE", { venue: p.dst.id, message: `${p.dst.name} now gives ${p.toAddress} as the address, not the ${toAddress} that was signed for: nothing was sent. Prepare it again`, detail: { signed: toAddress, now: p.toAddress } });
    }
    if (p.fee > Number(maxFee) + 1e-9) return no("E_ACCOUNT_REQUOTE", { venue: p.src.id, message: `${p.src.name} now charges ${p.fee} ${p.f.asset}; the signature allows ${maxFee}: nothing was sent. Prepare it again`, detail: { fee: p.fee, maxFee } });
    return null;
  }

  /** An agent asks. It is never done on its word: the owner sees the exact address and fee on a card, and signs that */
  async agent(a: AgentLiveMoveAction, who: { signer: string; envelope: Envelope; hash: Hex; agent: AgentKey }): Promise<Outcome> {
    const now = Date.parse(this.e.host.now());
    const spend = spendFor(this.e.state, who.signer, "venues", now);
    if (isRefusal(spend)) return spend;
    const amountMicro = micro(a.amount);
    for (const venue of new Set([a.from, a.to])) {
      const c = covers(spend, venue, amountMicro, now);
      if (c) return c;
    }
    const p = await this.plan(a);
    if (isRefusal(p)) return p;
    const flight = this.e.host.openFlight({ id: who.agent.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), name: who.agent.name, code: who.agent.code }, `${a.kind} ${a.amount} ${a.asset} · real money`);
    const offer = { payee: p.dst.name, payTo: p.toAddress ?? `${p.f.fromLedger} → ${p.f.toLedger}`, amount: `${a.amount} ${a.asset}${a.kind === "swap" ? ` → ${a.toAsset}` : ""}`, protocol: `real money · ${this.protocol(p)}`, network: p.network ?? p.src.name, fee: `${p.fee} ${a.asset}` };
    // the owner's answer signs the card's hash: here that hash covers the agent's request AND the address and fee the owner is shown
    const actionHash = keccak256(stringToHex(canonical({ action: who.hash, offer })));
    const card = this.e.host.raiseCard(flight.no, { account: a.from, intent: { kind: "move", asset: a.asset, amount: p.amount, to: p.toAddress ?? a.to }, usd: p.amount, reason: `${who.agent.name} asks to ${this.words(p)}. This is real money: you sign the address and the fee`, why: "live", action: a, actionHash, signer: who.signer, expiresAt: new Date(now + 30 * 60_000).toISOString(), offer: { payee: offer.payee, payTo: offer.payTo, amount: offer.amount, protocol: offer.protocol, network: offer.network }, approval: spend.id });
    this.e.patchSpend(spend.id, (x) => ({ ...x, reservedMicro: x.reservedMicro + amountMicro }));
    this.e.host.log({ kind: "action", venue: a.from, tool: a.type, signer: who.signer, envelope: who.envelope, outcome: "card", notionalUsd: p.amount, reason: `${card.id} · ${this.words(p)}`, flight: flight.no, intentId: card.id });
    return { ok: true, kind: "card", pending: true, card, flight: flight.no };
  }

  /** the owner approved an agent's card: planned again, held to the address and fee on the card, run, and counted in the approval */
  async release(card: CardLike, who: { signer: string; agent: AgentKey }): Promise<Outcome> {
    const a = card.action as AgentLiveMoveAction;
    const p = await this.plan(a);
    if (isRefusal(p)) return p;
    const shown = card.offer?.payTo ?? "";
    const changed = this.changed(p, p.toAddress ? shown : "", String(p.fee));
    if (changed) return changed;
    const out = await this.run(p, { signer: who.signer, authority: "agent", agent: who.agent.address, card: card.id, action: card.actionHash });
    if (!isRefusal(out) && card.approval) this.e.patchSpend(card.approval, (x) => ({ ...x, spentMicro: x.spentMicro + micro(a.amount) }));
    return out;
  }

  private protocol(p: Plan): string {
    return p.kind === "withdraw" ? `${p.src.via} withdrawal` : p.kind === "transfer" ? `${p.src.via} transfer` : p.kind === "swap" ? `${p.src.via} market order` : p.src.writer.can.send === "mm" ? "mm transfer" : "a transaction your wallet sends";
  }

  private words(p: Plan): string {
    const f = p.f;
    return p.kind === "transfer" ? `move ${f.amount} ${f.asset} at ${p.src.name} from ${f.fromLedger} to ${f.toLedger}` : p.kind === "swap" ? `swap ${f.amount} ${f.asset} for ${f.toAsset} at ${p.src.name}` : `send ${f.amount} ${f.asset} from ${p.src.name} to ${p.dst.name} on ${p.network}`;
  }

  /** the one venue call, and the payment it becomes */
  private async run(p: Plan, who: { signer: string; authority: "owner" | "agent"; agent?: string | undefined; card?: string | undefined; action?: Hex | undefined }): Promise<Outcome> {
    const f = p.f;
    const id = this.e.nextPaymentId();
    const at = new Date(this.money()!.realNow()).toISOString();
    let r: LiveReceipt | WalletTx | Refusal;
    if (p.kind === "withdraw") r = await p.src.writer.withdraw!({ asset: f.asset, amount: p.amount, address: p.toAddress!, tag: p.tag, network: p.network!, clientId: id });
    else if (p.kind === "transfer") r = await p.src.writer.transfer!({ asset: f.asset, amount: p.amount, from: f.fromLedger, to: f.toLedger });
    else if (p.kind === "swap") r = await p.src.writer.swap!({ sell: f.asset, buy: f.toAsset, amount: p.amount });
    else if (p.src.writer.can.send === "mm") r = await p.src.writer.send!({ asset: f.asset, amount: p.amount, to: p.toAddress!, network: p.network! });
    else r = await p.src.writer.walletTx!({ asset: f.asset, amount: p.amount, to: p.toAddress!, network: p.network! });
    if (isRefusal(r)) {
      this.e.host.log({ kind: "account-refusal", venue: p.src.id, tool: `live ${p.kind}`, code: r.code, reason: r.message, native: r.native, signer: who.signer });
      return r;
    }
    const wallet = "data" in r ? r : undefined;
    const receipt = "data" in r ? undefined : r;
    const kind: PaymentKind = p.kind === "swap" ? "swap" : p.kind === "transfer" ? "transfer" : p.dst.kind === "cex" ? "deposit" : "withdraw";
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
      receiveUsd: receipt?.received ?? Math.max(0, p.amount - p.fee),
      legs: [{ step: p.kind === "swap" ? "swap" : p.kind === "transfer" ? "shift" : "out", venue: p.src.id, rail: p.kind, protocol: this.protocol(p), token: f.toAsset, ...(p.network ? { chain: p.network } : {}), ...(p.kind === "transfer" ? { fromLedger: f.fromLedger, toLedger: f.toLedger } : {}), feeUsd: p.fee, etaSec: p.kind === "withdraw" || p.kind === "send" ? 300 : 0, access: "owner", final: true, status: status === "settled" ? "settled" : "pending", startedAt: at, ...(receipt ? { ref: receipt.ref, native: receipt.native } : { native: { walletTx: wallet } }) }],
      status,
      settlesAt: at,
      ...(status === "settled" ? { settledAt: at } : {}),
      signer: who.signer,
      authority: who.authority,
      ...(who.agent ? { agent: who.agent } : {}),
      ...(who.action ? { action: who.action } : {}),
      ...(who.card ? { card: who.card } : {}),
      live: { kind: p.kind, ...(p.toAddress ? { toAddress: p.toAddress } : {}), ...(p.network ? { network: p.network } : {}) },
      note: wallet ? `waiting for your wallet to send it: ${p.src.name} asks you to confirm` : status === "settled" ? `done at ${p.src.name}` : `${p.src.name} took it; waiting for it to land`,
    };
    this.e.payments.unshift(payment);
    // the venue is asked how it went no sooner than twenty seconds after it took it
    this.polled.set(id, this.money()!.realNow());
    this.e.host.log({ kind: "payment", venue: p.src.id, tool: `live ${p.kind}`, outcome: status, payment: id, notionalUsd: p.amount, reason: `${id} · real money · ${this.words(p)}${p.toAddress ? ` · to ${p.toAddress}` : ""}`, native: receipt?.native ?? { walletTx: wallet }, signer: who.signer });
    return wallet ? { ok: true, kind: "result", result: { payment, wallet } } : { ok: true, kind: "payment", payment };
  }

  /** the page tells which transaction the wallet sent for a payment that was waiting for it; the chain decides whether it is that payment */
  async sent(paymentId: string, hash: string): Promise<Outcome> {
    const p = this.e.payments.find((x) => x.id === paymentId);
    if (!p?.live || p.status !== "authorized") return no("E_ACCOUNT_BAD_ACTION", { message: `no payment ${paymentId} is waiting for a wallet` });
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return no("E_ACCOUNT_BAD_ACTION", { message: "a transaction hash is 0x and sixty-four hex digits" });
    p.live = { ...p.live, txHash: hash as Hex };
    p.status = "pending";
    p.legs[0]!.ref = hash;
    p.note = `sent from the wallet: ${hash.slice(0, 10)}…, waiting for ${p.live.network}`;
    this.e.host.log({ kind: "payment", venue: p.from, tool: "live send", outcome: "pending", payment: p.id, reason: `${p.id} · the wallet sent ${hash}`, native: { txHash: hash } });
    this.polled.delete(p.id);
    await this.poll();
    return { ok: true, kind: "payment", payment: p };
  }

  /** what has landed: asked of the venue or the chain, at most every twenty seconds per payment */
  async poll(): Promise<void> {
    const m = this.money();
    if (!m) return;
    const now = m.realNow();
    for (const p of this.e.payments) {
      if (!p.live || p.status !== "pending") continue;
      if (now - (this.polled.get(p.id) ?? 0) < POLL_MS) continue;
      this.polled.set(p.id, now);
      const src = m.venue(p.from);
      const leg = p.legs[0]!;
      let landed: Landed | Refusal = "pending";
      if (p.live.txHash && src?.writer?.confirm) landed = await src.writer.confirm(p.live.txHash, { asset: p.sourceToken, amount: p.amountUsd, to: p.live.toAddress as Hex, network: p.live.network as ChainName });
      else if (leg.ref && src?.writer?.landed) landed = await src.writer.landed(leg.ref, p.sourceToken, Date.parse(p.at));
      if (landed === "pending") continue;
      const at = new Date(now).toISOString();
      if (landed === "settled") {
        Object.assign(p, { status: "settled", settledAt: at, note: p.live.txHash ? `landed: the transfer is on ${p.live.network}, in transaction ${p.live.txHash.slice(0, 10)}…` : `landed: ${src?.name ?? p.from} says it is done` });
        Object.assign(leg, { status: "settled", settlesAt: at });
      } else {
        Object.assign(p, { status: "failed", note: isRefusal(landed) ? landed.message : `${src?.name ?? p.from} says it failed` });
        Object.assign(leg, { status: "failed" });
      }
      this.e.host.log({ kind: "payment", venue: p.from, tool: `live ${p.live.kind}`, outcome: p.status, payment: p.id, reason: `${p.id} · ${p.note}` });
    }
  }
}

export const isEvmAddress = (a: string): a is Hex => isAddress(a, { strict: false });
export const checksum = (a: string): Hex => getAddress(a);
