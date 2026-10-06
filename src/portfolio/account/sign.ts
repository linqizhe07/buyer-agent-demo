/** Keys and signatures of the account.
 *
 * The account's own protocol is shaped like Hyperliquid's, which has two
 * signing classes, and so does this:
 *
 *   owner actions    human-readable EIP-712 typed data, one type per action
 *                    (Hyperliquid's "user-signed actions": UsdSend, SendAsset,
 *                    ApproveAgent …). Signed by an owner key. Two kinds of
 *                    owner key exist: an EOA (secp256k1; the terminal demo
 *                    plays the owner with one) and the owner's DEVICE key
 *                    (P-256, generated in the browser and not extractable —
 *                    the server only ever holds its public half).
 *   agent requests   one type for everything, Agent(source, actionHash, nonce)
 *                    (Hyperliquid's "L1 actions"), signed by an agent key the
 *                    owner authorised. An agent key can never sign an owner
 *                    action: the types do not overlap.
 *
 * The domain is the account's own, so nothing signed here is a valid
 * Hyperliquid action. `HL` carries Hyperliquid's own domain and types for two
 * uses: the conformance test (the SDK's published signatures must recover
 * under this encoder) and the native request the Hyperliquid door builds.
 *
 * Every key in this file is DERIVED FROM A LABEL at run time:
 * sha256("buyer-agent-demo/sim/" + label). Nothing is read from disk and
 * nothing is secret — anyone who reads this file can derive the same keys.
 * Their addresses are real-format addresses on every EVM chain: never send
 * anything to one. The demo shows the checks; it does not keep a secret.
 */
import { createECDH, createHash, createPrivateKey, createPublicKey, sign as nodeSign, verify as nodeVerify, type KeyObject } from "node:crypto";
import { hashTypedData, keccak256, recoverTypedDataAddress, serializeSignature, stringToHex, parseSignature, type Hex, type TypedDataDomain } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { canonical } from "../../core/hash.ts";

export type { Hex };

export const ZERO: Hex = "0x0000000000000000000000000000000000000000";

/** {r, s, v} — the signature shape Hyperliquid's exchange endpoint takes */
export interface Sig {
  r: Hex;
  s: Hex;
  v: number;
}

/** an owner's device signature: ES256 over the typed data, by the key the browser holds */
export interface DeviceSig {
  kid: string;
  es256: string;
}

export type AnySig = Sig | DeviceSig;

export interface Jwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
}

// ---- the actions --------------------------------------------------------------

/** what the owner's signature covers besides the intent: the exact route, the most it may cost, the latest it may land */
interface Quoted {
  /** hash of the legs this instruction will run (doors.ts); a different route needs a new signature */
  route: Hex;
  maxFee: string;
  /** ms; the latest arrival the owner agreed to */
  deadline: number;
}

/** Deposit, Withdraw, Transfer and Send are all this one action — the difference is where it goes (Hyperliquid's app does the same) */
export interface SendAsset extends Quoted {
  type: "sendAsset";
  /** `self` for the user's own venues, otherwise the recipient's address */
  destination: string;
  /** a venue ledger: `okx` · `hyperliquid` · `hyperliquid:spot` · `metamask:Base` · `chase` */
  sourceDex: string;
  /** a venue ledger, or — for a third party — the chain the address lives on */
  destinationDex: string;
  token: string;
  amount: string;
  fromSubAccount: string;
  nonce: number;
}

export type OwnerAction =
  | SendAsset
  | { type: "swap"; venue: string; sell: string; buy: string; amount: string; minReceive: string; nonce: number }
  /** an explicit `validUntil` (ms): Hyperliquid carries the expiry inside the agent's NAME, which is not copied here */
  | { type: "approveAgent"; agentAddress: Hex; agentName: string; validUntil: number; nonce: number }
  | { type: "approveBuilderFee"; builder: Hex; maxFeeRate: string; nonce: number }
  /** a spending approval: which venues or payees, how much per payment, how much in all, how often, until when. A budget of "0" revokes */
  | { type: "approveSpend"; agent: Hex; scope: string; allow: string; perPayment: string; budget: string; windowHours: number; validUntil: number; nonce: number }
  | { type: "createSubAccount"; name: string; agent: Hex; float: string; nonce: number }
  | { type: "userSetAbstraction"; abstraction: string; nonce: number }
  | { type: "convertToMultiSigUser"; signers: string; nonce: number }
  | { type: "setDestination"; label: string; address: string; chain: string; token: string; nonce: number }
  /** the owner's answer to a card: it names the card AND the hash of what the card would release */
  | { type: "approveCard"; card: string; action: Hex; decision: string; nonce: number }
  /** widening the agent's reach is the owner's to sign; tightening needs no signature */
  | { type: "setPolicy"; change: string; value: string; nonce: number }
  /** plug a venue the user already has into the account: which one, how it is reached, and where its credential lives (a reference, never the value) */
  | { type: "connectVenue"; venue: string; connector: string; label: string; credentialRef: string; nonce: number }
  | { type: "disconnectVenue"; venue: string; nonce: number }
  /** REAL money at venues connected live: the owner signs the exact destination address the venue gave, the most the venue may charge, and
   * the moment after which it is void. `kind`: withdraw (from an exchange) · send (from a wallet) · transfer (between an exchange's own
   * ledgers) · swap (one dollar stablecoin for another at an exchange) · bridge (from a wallet to another chain: `network` is the chain it
   * leaves, `toLedger` the chain it lands on, `maxFee` the most the bridge may charge) */
  | { type: "liveMove"; kind: string; from: string; fromLedger: string; to: string; toLedger: string; asset: string; toAsset: string; network: string; amount: string; toAddress: string; maxFee: string; deadline: number; nonce: number }
  /** An ORDER at a venue connected live, on the owner's signature: the market, the side, the exact size in the market's own units, the limit
   * price ("" for a market order), the most the order may be worth in dollars when it is placed (a price that has moved past it is a new
   * signature), and the moment after which it is void */
  | { type: "liveOrder"; venue: string; symbol: string; side: string; orderType: string; qty: string; limitPrice: string; /** a stop or stop-limit order's trigger; "" otherwise */ stopPrice: string; /** "gtc" · "ioc" · "fok" · "day", or "" for the venue's own default */ tif: string; /** "true" or "" */ postOnly: string; reduceOnly: string; maxNotional: string; deadline: number; nonce: number }
  /** cancel an order the account placed (its id on the account, `ord-0001`) */
  | { type: "liveCancel"; venue: string; order: string; nonce: number }
  /** change an open order in place: its new size, limit and stop ("" keeps what it was), the most it may then be worth, and ten minutes */
  | { type: "liveAmend"; venue: string; order: string; qty: string; limitPrice: string; stopPrice: string; maxNotional: string; deadline: number; nonce: number }
  /** close a position at a venue: all of it ("" ), or this much of it */
  | { type: "liveClose"; venue: string; symbol: string; qty: string; nonce: number }
  /** a perpetual's leverage, and its margin mode ("cross" · "isolated" · "" to keep it) */
  | { type: "liveLeverage"; venue: string; symbol: string; leverage: string; marginMode: string; nonce: number }
  /** a market the owner keeps an eye on — at a venue on the account or one that is not — which agents read: `on` "true" watches it, "" stops */
  | { type: "setWatch"; venue: string; symbol: string; on: string; nonce: number }
  /** The owner's words to an agent (`agent`: its address) or to every agent ("*"): what the owner would like done, where, which way and about
   * how much. It grants nothing — the agent acts only inside its limits, and its cards are still the owner's to answer; `usd` guides it and
   * limits nothing. `id` "" is a new intent, an intent's id changes that one, and a `validUntil` of 0 withdraws it */
  | { type: "setIntent"; id: string; agent: string; venue: string; symbol: string; side: string; usd: string; text: string; validUntil: number; nonce: number }
  /** EARN at a venue connected live, on the owner's signature: money into one of the venue's products (`kind` supply) or back out of it
   * (withdraw), in the product's own asset, the exact amount; the most it may be worth in dollars when it runs (a price that has moved past
   * it is a new signature), where money taken out lands (always the venue it came from), and the moment after which it is void */
  | { type: "liveEarn"; venue: string; kind: string; product: string; asset: string; amount: string; maxUsd: string; lands: string; deadline: number; nonce: number }
  /** the owner's answer to an agent's ask (`ask`: its id, `ask-0003`) that is not the thing asked for: `decision` "decline". Granting an
   * ask is the owner's own action for it (a limit, a venue connected, a top-up …), which closes the ask; this closes it without one. It
   * moves nothing and widens nothing */
  | { type: "answerAsk"; ask: string; decision: string; nonce: number };

export type AgentAction =
  | { type: "agentSendAsset"; destination: string; sourceDex: string; destinationDex: string; token: string; amount: string; fromSubAccount: string; maxFee: string; nonce: number }
  | { type: "agentSwap"; venue: string; sell: string; buy: string; amount: string; minReceive: string; nonce: number }
  /** "pay for this resource, up to this much": the account answers the payee's protocol, the agent never holds the float's key.
   * `fromSubAccount` names the float that pays; "" is the main account, which pays by card. `builder` is Hyperliquid's builder fee: `f` in tenths
   * of a basis point, to address `b`. `cnf` and `mandates` are the agent's part of an AP2 checkout: its P-256 key, then the two closed mandates
   * it signed with it. `close` ends a payment session at this payee and brings the rest of the deposit back. */
  | { type: "agentPay"; url: string; maxAmount: string; fromSubAccount: string; builder?: { b: Hex; f: number } | undefined; cnf?: Jwk | undefined; mandates?: { checkout: string; payment: string } | undefined; close?: boolean | undefined; /** how the payee is asked (GET unless said), and a POST's body — part of what the agent signs */ method?: string | undefined; body?: string | undefined; contentType?: string | undefined; nonce: number }
  /** the older single-account write (trade · subscribe · redeem), now under the agent's key */
  | { type: "agentExecute"; account: string; intent: Record<string, unknown>; nonce: number }
  | { type: "agentOrder"; base: string; side: string; qty: number; nonce: number }
  /** an agent asking for real money to move at venues connected live: it is never done on the agent's word — the owner is asked, every time */
  | { type: "agentLiveMove"; kind: string; from: string; fromLedger: string; to: string; toLedger: string; asset: string; toAsset: string; network: string; amount: string; maxFee: string; nonce: number }
  /** an agent's ORDER at a venue connected live: a size in the market's units (`qty`) or in dollars (`usd`), one of the two; a limit price, or
   * "" for a market order. Inside its trading limit: Aggressive places it at once, Conservative asks the owner on a card */
  | { type: "agentLiveOrder"; venue: string; symbol: string; side: string; orderType: string; qty: string; usd: string; limitPrice: string; /** optional: a stop's trigger, the time in force, post-only, reduce-only ("true") */ stopPrice?: string | undefined; tif?: string | undefined; postOnly?: string | undefined; reduceOnly?: string | undefined; nonce: number }
  /** an agent cancels an order it placed itself */
  | { type: "agentLiveCancel"; venue: string; order: string; nonce: number }
  /** an agent changes an order it placed itself: its new size, limit or stop ("" keeps what it was) */
  | { type: "agentLiveAmend"; venue: string; order: string; qty: string; limitPrice: string; stopPrice: string; nonce: number }
  /** an agent closes a position (all of it: qty "") at a venue inside its trading limit */
  | { type: "agentLiveClose"; venue: string; symbol: string; qty: string; nonce: number }
  /** an agent sets a perpetual's leverage, up to the most the owner allows agents */
  | { type: "agentLiveLeverage"; venue: string; symbol: string; leverage: string; marginMode: string; nonce: number }
  /** an agent tells the owner how an intent addressed to it (or to every agent) stands: `status` taking · done · cannot · note, a note in its
   * own words, and `refs` — what it did, by id (`ord-0003,pay-0001`, a transaction's hash), comma-separated */
  | { type: "agentReport"; intent: string; status: string; note: string; refs: string; nonce: number }
  /** An agent asks the owner for what only the owner signs: `kind` letIn (its key let in) · limit · venue (one connected) · topup (its wallet) ·
   * session · leverage · mode. Asking grants nothing: the owner's own signed action is the answer, and it closes the ask */
  | { type: "agentAsk"; kind: string; venue: string; usd: string; text: string; nonce: number }
  /** an agent puts money into a venue's earn product (`kind` supply) or takes it back out (withdraw: `amount` "all" is all of it), inside
   * the earn limit the owner signed for it. It names no destination: what comes out lands where it came from. Conservative: a card;
   * Aggressive: inside its limit, at once */
  | { type: "agentLiveEarn"; venue: string; kind: string; product: string; asset: string; amount: string; nonce: number };

export type Action = OwnerAction | AgentAction;

export const OWNER_TYPES = ["sendAsset", "swap", "approveAgent", "approveBuilderFee", "approveSpend", "createSubAccount", "userSetAbstraction", "convertToMultiSigUser", "setDestination", "approveCard", "setPolicy", "connectVenue", "disconnectVenue", "liveMove", "liveOrder", "liveCancel", "liveAmend", "liveClose", "liveLeverage", "setWatch", "setIntent", "liveEarn", "answerAsk"] as const;
export const AGENT_TYPES = ["agentSendAsset", "agentSwap", "agentPay", "agentExecute", "agentOrder", "agentLiveMove", "agentLiveOrder", "agentLiveCancel", "agentLiveAmend", "agentLiveClose", "agentLiveLeverage", "agentReport", "agentAsk", "agentLiveEarn"] as const;
/** an instruction that moves money is good for minutes after it is signed, not for the two days of the nonce window */
export const MONEY_TYPES: ReadonlySet<string> = new Set(["sendAsset", "swap", "approveCard", "agentSendAsset", "agentSwap", "agentPay", "agentExecute", "agentOrder", "liveMove", "agentLiveMove", "liveOrder", "agentLiveOrder", "liveAmend", "agentLiveAmend", "liveClose", "agentLiveClose", "liveEarn", "agentLiveEarn"]);
/** how the owner steers and the agents answer: a watchlist, intents, reports, asks. None moves money and none is read by a limit (state.ts
 * covers, spendFor): they are words between the owner and the agents, and authority still comes only from limits, cards and the cap */
export const STEER_TYPES: ReadonlySet<string> = new Set(["setWatch", "setIntent", "answerAsk", "agentReport", "agentAsk"]);
export const MONEY_TTL_MS = 10 * 60_000;

export function isOwnerAction(a: { type: string }): a is OwnerAction {
  return (OWNER_TYPES as readonly string[]).includes(a.type);
}

export function isAgentAction(a: { type: string }): a is AgentAction {
  return (AGENT_TYPES as readonly string[]).includes(a.type);
}

export interface Envelope {
  action: Action;
  nonce: number;
  signature: AnySig;
  /** further owner signatures over the same action, when the account needs more than one */
  cosignatures?: AnySig[] | undefined;
}

// ---- typed data ---------------------------------------------------------------

type Field = { name: string; type: "string" | "address" | "uint64" | "bytes32" | "bool" };

/** environment, version and chain are in the domain: a signature made for the simulation is nothing anywhere else */
export const ACCOUNT_DOMAIN: TypedDataDomain = { name: "AgentAccountSignTransaction", version: "1", chainId: 424242, verifyingContract: ZERO };
export const AGENT_DOMAIN: TypedDataDomain = { name: "AgentAccountExchange", version: "1", chainId: 424242, verifyingContract: ZERO };
const CHAIN_FIELD: Field = { name: "accountChain", type: "string" };
export const ACCOUNT_CHAIN = "Simulation";

const quoted: Field[] = [{ name: "route", type: "bytes32" }, { name: "maxFee", type: "string" }, { name: "deadline", type: "uint64" }];
const NONCE: Field = { name: "nonce", type: "uint64" };

const OWNER_FIELDS: Record<OwnerAction["type"], { primary: string; fields: Field[] }> = {
  sendAsset: { primary: "AccountTransaction:SendAsset", fields: [{ name: "destination", type: "string" }, { name: "sourceDex", type: "string" }, { name: "destinationDex", type: "string" }, { name: "token", type: "string" }, { name: "amount", type: "string" }, { name: "fromSubAccount", type: "string" }, ...quoted, NONCE] },
  swap: { primary: "AccountTransaction:Swap", fields: [{ name: "venue", type: "string" }, { name: "sell", type: "string" }, { name: "buy", type: "string" }, { name: "amount", type: "string" }, { name: "minReceive", type: "string" }, NONCE] },
  approveAgent: { primary: "AccountTransaction:ApproveAgent", fields: [{ name: "agentAddress", type: "address" }, { name: "agentName", type: "string" }, { name: "validUntil", type: "uint64" }, NONCE] },
  approveBuilderFee: { primary: "AccountTransaction:ApproveBuilderFee", fields: [{ name: "maxFeeRate", type: "string" }, { name: "builder", type: "address" }, NONCE] },
  approveSpend: { primary: "AccountTransaction:ApproveSpend", fields: [{ name: "agent", type: "address" }, { name: "scope", type: "string" }, { name: "allow", type: "string" }, { name: "perPayment", type: "string" }, { name: "budget", type: "string" }, { name: "windowHours", type: "uint64" }, { name: "validUntil", type: "uint64" }, NONCE] },
  createSubAccount: { primary: "AccountTransaction:CreateSubAccount", fields: [{ name: "name", type: "string" }, { name: "agent", type: "address" }, { name: "float", type: "string" }, NONCE] },
  userSetAbstraction: { primary: "AccountTransaction:UserSetAbstraction", fields: [{ name: "abstraction", type: "string" }, NONCE] },
  convertToMultiSigUser: { primary: "AccountTransaction:ConvertToMultiSigUser", fields: [{ name: "signers", type: "string" }, NONCE] },
  setDestination: { primary: "AccountTransaction:SetDestination", fields: [{ name: "label", type: "string" }, { name: "address", type: "string" }, { name: "chain", type: "string" }, { name: "token", type: "string" }, NONCE] },
  approveCard: { primary: "AccountApproval:Card", fields: [{ name: "card", type: "string" }, { name: "action", type: "bytes32" }, { name: "decision", type: "string" }, NONCE] },
  setPolicy: { primary: "AccountTransaction:SetPolicy", fields: [{ name: "change", type: "string" }, { name: "value", type: "string" }, NONCE] },
  connectVenue: { primary: "AccountTransaction:ConnectVenue", fields: [{ name: "venue", type: "string" }, { name: "connector", type: "string" }, { name: "label", type: "string" }, { name: "credentialRef", type: "string" }, NONCE] },
  disconnectVenue: { primary: "AccountTransaction:DisconnectVenue", fields: [{ name: "venue", type: "string" }, NONCE] },
  liveMove: { primary: "AccountTransaction:LiveMove", fields: [{ name: "kind", type: "string" }, { name: "from", type: "string" }, { name: "fromLedger", type: "string" }, { name: "to", type: "string" }, { name: "toLedger", type: "string" }, { name: "asset", type: "string" }, { name: "toAsset", type: "string" }, { name: "network", type: "string" }, { name: "amount", type: "string" }, { name: "toAddress", type: "string" }, { name: "maxFee", type: "string" }, { name: "deadline", type: "uint64" }, NONCE] },
  liveOrder: { primary: "AccountTransaction:LiveOrder", fields: [{ name: "venue", type: "string" }, { name: "symbol", type: "string" }, { name: "side", type: "string" }, { name: "orderType", type: "string" }, { name: "qty", type: "string" }, { name: "limitPrice", type: "string" }, { name: "stopPrice", type: "string" }, { name: "tif", type: "string" }, { name: "postOnly", type: "string" }, { name: "reduceOnly", type: "string" }, { name: "maxNotional", type: "string" }, { name: "deadline", type: "uint64" }, NONCE] },
  liveCancel: { primary: "AccountTransaction:LiveCancel", fields: [{ name: "venue", type: "string" }, { name: "order", type: "string" }, NONCE] },
  liveAmend: { primary: "AccountTransaction:LiveAmend", fields: [{ name: "venue", type: "string" }, { name: "order", type: "string" }, { name: "qty", type: "string" }, { name: "limitPrice", type: "string" }, { name: "stopPrice", type: "string" }, { name: "maxNotional", type: "string" }, { name: "deadline", type: "uint64" }, NONCE] },
  liveClose: { primary: "AccountTransaction:LiveClose", fields: [{ name: "venue", type: "string" }, { name: "symbol", type: "string" }, { name: "qty", type: "string" }, NONCE] },
  liveLeverage: { primary: "AccountTransaction:LiveLeverage", fields: [{ name: "venue", type: "string" }, { name: "symbol", type: "string" }, { name: "leverage", type: "string" }, { name: "marginMode", type: "string" }, NONCE] },
  setWatch: { primary: "AccountTransaction:SetWatch", fields: [{ name: "venue", type: "string" }, { name: "symbol", type: "string" }, { name: "on", type: "string" }, NONCE] },
  // `agent` is text, not an address: it may be "*", every agent
  setIntent: { primary: "AccountTransaction:SetIntent", fields: [{ name: "id", type: "string" }, { name: "agent", type: "string" }, { name: "venue", type: "string" }, { name: "symbol", type: "string" }, { name: "side", type: "string" }, { name: "usd", type: "string" }, { name: "text", type: "string" }, { name: "validUntil", type: "uint64" }, NONCE] },
  liveEarn: { primary: "AccountTransaction:LiveEarn", fields: [{ name: "venue", type: "string" }, { name: "kind", type: "string" }, { name: "product", type: "string" }, { name: "asset", type: "string" }, { name: "amount", type: "string" }, { name: "maxUsd", type: "string" }, { name: "lands", type: "string" }, { name: "deadline", type: "uint64" }, NONCE] },
  answerAsk: { primary: "AccountTransaction:AnswerAsk", fields: [{ name: "ask", type: "string" }, { name: "decision", type: "string" }, NONCE] },
};
/** what reaches a real venue: its signed text says "real money" */
const LIVE_TYPES: ReadonlySet<string> = new Set(["liveMove", "liveOrder", "liveCancel", "liveAmend", "liveClose", "liveLeverage", "liveEarn"]);
/** what the owner's signature says about the money: a live move is real money, and the signed text says so */
export const LIVE_CHAIN = "Live · real money";

const AGENT_TYPE = { Agent: [{ name: "source", type: "string" }, { name: "actionHash", type: "bytes32" }, { name: "nonce", type: "uint64" }] } as const;
const AGENT_SOURCE = "sim";

export interface TypedData {
  domain: TypedDataDomain;
  types: Record<string, Field[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

function messageOf(fields: Field[], values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = values[f.name];
    out[f.name] = f.type === "uint64" ? BigInt(Math.trunc(Number(v ?? 0))) : f.type === "bool" ? Boolean(v) : String(v ?? "");
  }
  return out;
}

/** Is this action exactly what its signature covers? An owner action is signed field by field, with numbers as whole uint64s: a field its type does
 * not have is something no signature covers, and a number with a fraction signs as the whole number below it (a nonce of 1000.5 would carry the
 * signature made for 1000 and still look unused). `null` when it is well formed; otherwise what is wrong. */
/** the text fields of the agent requests that reach a real venue: each has to be text, and nothing else rides along */
const AGENT_TEXT: Partial<Record<AgentAction["type"], string[]>> = {
  agentLiveOrder: ["venue", "symbol", "side", "orderType", "qty", "usd", "limitPrice"],
  agentLiveCancel: ["venue", "order"],
  agentLiveMove: ["kind", "from", "fromLedger", "to", "toLedger", "asset", "toAsset", "network", "amount", "maxFee"],
  agentLiveAmend: ["venue", "order", "qty", "limitPrice", "stopPrice"],
  agentLiveClose: ["venue", "symbol", "qty"],
  agentLiveLeverage: ["venue", "symbol", "leverage", "marginMode"],
  agentReport: ["intent", "status", "note", "refs"],
  agentAsk: ["kind", "venue", "usd", "text"],
  agentLiveEarn: ["venue", "kind", "product", "asset", "amount"],
};
/** text fields an agent request MAY carry (when it does, they are text too, and signed like the rest) */
const AGENT_OPTIONAL: Partial<Record<AgentAction["type"], string[]>> = {
  agentLiveOrder: ["stopPrice", "tif", "postOnly", "reduceOnly"],
};

export function malformed(action: Action): string | null {
  if (!Number.isSafeInteger(action.nonce) || action.nonce < 0) return "the nonce is a whole number of milliseconds";
  if (!isOwnerAction(action)) {
    const names = AGENT_TEXT[action.type];
    if (!names) return null;
    const optional = AGENT_OPTIONAL[action.type] ?? [];
    const have = action as unknown as Record<string, unknown>;
    const wrong = names.find((k) => typeof have[k] !== "string") ?? optional.find((k) => have[k] !== undefined && typeof have[k] !== "string");
    if (wrong) return `"${wrong}" is text`;
    const extra = Object.keys(have).find((k) => k !== "type" && k !== "nonce" && !names.includes(k) && !optional.includes(k));
    return extra === undefined ? null : `"${extra}" is not part of "${action.type}"`;
  }
  const fields = OWNER_FIELDS[action.type].fields;
  const have = action as unknown as Record<string, unknown>;
  for (const f of fields) {
    const v = have[f.name];
    if (f.type === "uint64" ? !Number.isSafeInteger(v) || (v as number) < 0 : typeof v !== "string") return `"${f.name}" is ${f.type === "uint64" ? "a whole number, zero or more" : "text"}`;
  }
  const extra = Object.keys(have).find((k) => k !== "type" && !fields.some((f) => f.name === k));
  return extra === undefined ? null : `"${extra}" is not part of what "${action.type}" signs`;
}

/** the typed data an owner signs for an action — and what a card shows, field for field */
export function ownerTypedData(action: OwnerAction): TypedData {
  const def = OWNER_FIELDS[action.type];
  const fields = [CHAIN_FIELD, ...def.fields];
  return { domain: ACCOUNT_DOMAIN, types: { [def.primary]: fields }, primaryType: def.primary, message: messageOf(fields, { ...action, accountChain: LIVE_TYPES.has(action.type) ? LIVE_CHAIN : ACCOUNT_CHAIN }) };
}

/** the fields of an owner action in signing order, as text: what the approval surface renders */
export function shownFields(action: OwnerAction): Array<{ name: string; value: string }> {
  const td = ownerTypedData(action);
  return td.types[td.primaryType]!.filter((f) => f.name !== "accountChain").map((f) => ({ name: f.name, value: String(td.message[f.name]) }));
}

/** keccak of the canonical JSON: what an agent's signature commits to */
export function agentActionHash(action: AgentAction): Hex {
  return keccak256(stringToHex(canonical(action)));
}

function agentTypedData(action: AgentAction): { domain: TypedDataDomain; types: typeof AGENT_TYPE; primaryType: "Agent"; message: { source: string; actionHash: Hex; nonce: bigint } } {
  return { domain: AGENT_DOMAIN, types: AGENT_TYPE, primaryType: "Agent", message: { source: AGENT_SOURCE, actionHash: agentActionHash(action), nonce: BigInt(action.nonce) } };
}

/** one id for one instruction: the EIP-712 digest. The idempotency key, the thing an approval names, the ledger's reference */
export function actionHash(action: Action): Hex {
  // viem's typed-data generics want literal types; these are built at run time
  return isOwnerAction(action) ? hashTypedData(ownerTypedData(action) as never) : hashTypedData(agentTypedData(action) as never);
}

const toSig = (hex: Hex): Sig => {
  const p = parseSignature(hex);
  return { r: p.r, s: p.s, v: Number(p.v ?? BigInt(27 + (p.yParity ?? 0))) };
};
const toHex = (s: Sig): Hex => serializeSignature({ r: s.r, s: s.s, yParity: s.v === 28 || s.v === 1 ? 1 : 0 });
export const isDeviceSig = (s: AnySig): s is DeviceSig => typeof (s as DeviceSig).es256 === "string";

// ---- signing and recovering -----------------------------------------------------

export async function signOwner(key: SimKey, action: OwnerAction): Promise<Envelope> {
  return { action, nonce: action.nonce, signature: toSig(await key.account.signTypedData(ownerTypedData(action) as never)) };
}

export async function cosign(key: SimKey, action: OwnerAction): Promise<Sig> {
  return toSig(await key.account.signTypedData(ownerTypedData(action) as never));
}

export async function signAgent(key: SimKey, action: AgentAction): Promise<Envelope> {
  return { action, nonce: action.nonce, signature: toSig(await key.account.signTypedData(agentTypedData(action) as never)) };
}

/** what a device key signs: the typed data as canonical JSON (bigints as decimal strings). The browser builds the same string from the fields it shows */
export function deviceSigningInput(action: OwnerAction): string {
  const td = ownerTypedData(action);
  const message = Object.fromEntries(Object.entries(td.message).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));
  return canonical({ domain: { name: td.domain.name, version: td.domain.version, chainId: Number(td.domain.chainId) }, primaryType: td.primaryType, message });
}

export function signDevice(key: SimKey, action: OwnerAction): DeviceSig {
  return { kid: key.kid, es256: es256Sign(key.p256, deviceSigningInput(action)) };
}

/** who signed: a lower-case address for an EOA, `device:<kid>` for a device key. `null` when the signature does not check out */
export async function signerOf(action: Action, sig: AnySig, devices: ReadonlyMap<string, Jwk> = new Map()): Promise<string | null> {
  try {
    if (isDeviceSig(sig)) {
      if (!isOwnerAction(action)) return null;
      const jwk = devices.get(sig.kid);
      return jwk && es256Verify(jwk, deviceSigningInput(action), sig.es256) ? `device:${sig.kid}` : null;
    }
    const data = isOwnerAction(action) ? ownerTypedData(action) : agentTypedData(action);
    return (await recoverTypedDataAddress({ ...(data as never as Parameters<typeof recoverTypedDataAddress>[0]), signature: toHex(sig) })).toLowerCase();
  } catch {
    return null;
  }
}

// ---- nonces ---------------------------------------------------------------------

export type NonceVerdict = "ok" | "used" | "below-floor" | "too-old" | "too-new";
const KEPT = 100;
const DAY = 86_400_000;

/** Hyperliquid's rule: the 100 highest nonces per signer are kept; a new one must be above the smallest of them, never
 * seen, and inside (now − 2 d, now + 1 d). Unlike Hyperliquid, a signer's book is never dropped — not when its key is
 * revoked, not when the account is empty — so an old signed instruction cannot come back with a re-approved key. */
export class NonceBook {
  private readonly kept = new Map<string, number[]>();
  /** nonces read back from the ledgers of earlier runs: each refuses its own reuse and nothing else */
  private readonly seen = new Map<string, Set<number>>();

  check(signer: string, nonce: number, nowMs: number): NonceVerdict {
    if (!(nonce > nowMs - 2 * DAY)) return "too-old";
    if (!(nonce < nowMs + DAY)) return "too-new";
    const set = this.kept.get(signer) ?? [];
    if (set.includes(nonce) || this.seen.get(signer)?.has(nonce)) return "used";
    if (set.length >= KEPT && nonce <= set[0]!) return "below-floor";
    return "ok";
  }

  /** call only after the signer has been found to be allowed: a nonce spent on a refused stranger would let anyone burn a signer's future */
  use(signer: string, nonce: number): void {
    const set = [...(this.kept.get(signer) ?? []), nonce].sort((a, b) => a - b);
    this.kept.set(signer, set.slice(-KEPT));
  }

  /** a nonce an earlier process saw: remembered exactly, whatever the clock says now, and without moving the signer's floor */
  remember(signer: string, nonce: number): void {
    const set = this.seen.get(signer) ?? new Set<number>();
    set.add(nonce);
    this.seen.set(signer, set);
  }

  signers(): string[] {
    return [...new Set([...this.kept.keys(), ...this.seen.keys()])];
  }
}

// ---- keys -----------------------------------------------------------------------

export interface SimKey {
  label: string;
  account: PrivateKeyAccount;
  /** lower-case */
  address: Hex;
  p256: KeyObject;
  jwk: Jwk;
  kid: string;
}

const b64u = (b: Uint8Array | string): string => Buffer.from(b).toString("base64url");
const keys = new Map<string, SimKey>();

/** a key pair of each curve from a label; see the note at the top of this file */
export function simKey(label: string): SimKey {
  const hit = keys.get(label);
  if (hit) return hit;
  const seed = createHash("sha256").update(`buyer-agent-demo/sim/${label}`).digest();
  const account = privateKeyToAccount(`0x${seed.toString("hex")}`);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(createHash("sha256").update(`buyer-agent-demo/sim/p256/${label}`).digest());
  const pub = ecdh.getPublicKey();
  const jwk: Jwk = { kty: "EC", crv: "P-256", x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) };
  const p256 = createPrivateKey({ key: { ...jwk, d: b64u(ecdh.getPrivateKey()) }, format: "jwk" });
  const key: SimKey = { label, account, address: account.address.toLowerCase() as Hex, p256, jwk, kid: kidOf(jwk) };
  keys.set(label, key);
  return key;
}

/** a short id for a P-256 public key: the first 8 bytes of sha256(x ‖ y) */
export function kidOf(jwk: Jwk): string {
  return createHash("sha256").update(Buffer.from(jwk.x, "base64url")).update(Buffer.from(jwk.y, "base64url")).digest("hex").slice(0, 16);
}

/** ES256 as JWS wants it: raw r ‖ s, base64url. Node's signatures are randomised: never print one in a deterministic run */
export function es256Sign(key: KeyObject, data: string | Uint8Array): string {
  return b64u(nodeSign("sha256", Buffer.from(data), { key, dsaEncoding: "ieee-p1363" }));
}

export function es256Verify(jwk: Jwk, data: string | Uint8Array, signature: string): boolean {
  try {
    const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, format: "jwk" });
    return nodeVerify("sha256", Buffer.from(data), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

export function isJwk(v: unknown): v is Jwk {
  const j = v as Partial<Jwk> | null;
  return !!j && j.kty === "EC" && j.crv === "P-256" && typeof j.x === "string" && typeof j.y === "string" && Buffer.from(j.x, "base64url").length === 32 && Buffer.from(j.y, "base64url").length === 32;
}

// ---- amounts ----------------------------------------------------------------------

/** amounts travel as decimal strings (as Hyperliquid's do) and are added up as integers of one millionth: no float ever decides a limit */
export function micro(amount: string | number): number {
  const s = typeof amount === "number" ? amount.toFixed(6) : amount.trim();
  const m = /^(\d+)(?:\.(\d{1,18}))?$/.exec(s);
  if (!m) return Number.NaN;
  return Number(m[1]) * 1_000_000 + Number((m[2] ?? "").padEnd(6, "0").slice(0, 6));
}

export function unmicro(units: number): string {
  const sign = units < 0 ? "-" : "";
  const abs = Math.abs(Math.round(units));
  const frac = String(abs % 1_000_000).padStart(6, "0").replace(/0+$/, "");
  return `${sign}${Math.floor(abs / 1_000_000)}${frac ? `.${frac}` : ""}`;
}

export const usdOfMicro = (units: number): number => Number((units / 1_000_000).toFixed(2));

// ---- Hyperliquid's own domain and types -------------------------------------------

/** Hyperliquid's user-signed actions, as its SDK defines them (hyperliquid-python-sdk, utils/signing.py). `chainId` is `signatureChainId` as a number */
export const HL = {
  domain: (signatureChainId: string): TypedDataDomain => ({ name: "HyperliquidSignTransaction", version: "1", chainId: Number.parseInt(signatureChainId, 16), verifyingContract: ZERO }),
  types: {
    "HyperliquidTransaction:UsdSend": [{ name: "hyperliquidChain", type: "string" }, { name: "destination", type: "string" }, { name: "amount", type: "string" }, { name: "time", type: "uint64" }],
    "HyperliquidTransaction:Withdraw": [{ name: "hyperliquidChain", type: "string" }, { name: "destination", type: "string" }, { name: "amount", type: "string" }, { name: "time", type: "uint64" }],
    "HyperliquidTransaction:SendAsset": [{ name: "hyperliquidChain", type: "string" }, { name: "destination", type: "string" }, { name: "sourceDex", type: "string" }, { name: "destinationDex", type: "string" }, { name: "token", type: "string" }, { name: "amount", type: "string" }, { name: "fromSubAccount", type: "string" }, { name: "nonce", type: "uint64" }],
    "HyperliquidTransaction:UsdClassTransfer": [{ name: "hyperliquidChain", type: "string" }, { name: "amount", type: "string" }, { name: "toPerp", type: "bool" }, { name: "nonce", type: "uint64" }],
    "HyperliquidTransaction:ApproveAgent": [{ name: "hyperliquidChain", type: "string" }, { name: "agentAddress", type: "address" }, { name: "agentName", type: "string" }, { name: "nonce", type: "uint64" }],
    "HyperliquidTransaction:ApproveBuilderFee": [{ name: "hyperliquidChain", type: "string" }, { name: "maxFeeRate", type: "string" }, { name: "builder", type: "address" }, { name: "nonce", type: "uint64" }],
    "HyperliquidTransaction:SendToEvmWithData": [{ name: "hyperliquidChain", type: "string" }, { name: "token", type: "string" }, { name: "amount", type: "string" }, { name: "sourceDex", type: "string" }, { name: "destinationRecipient", type: "string" }, { name: "addressEncoding", type: "string" }, { name: "destinationChainId", type: "uint32" as never }, { name: "gasLimit", type: "uint64" }, { name: "data", type: "bytes" as never }, { name: "nonce", type: "uint64" }],
  } satisfies Record<string, Field[]>,
} as const;

export type HlPrimary = keyof typeof HL.types;

/** Hyperliquid typed data for one of its user-signed actions; numbers go in as numbers */
export function hlTypedData(primaryType: HlPrimary, signatureChainId: string, message: Record<string, unknown>): TypedData {
  const fields = HL.types[primaryType] as Field[];
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = message[f.name];
    const t = f.type as string;
    out[f.name] = t === "uint64" ? BigInt(Math.trunc(Number(v ?? 0))) : t === "uint32" ? Number(v ?? 0) : t === "bool" ? Boolean(v) : String(v ?? (t === "bytes" ? "0x" : ""));
  }
  return { domain: HL.domain(signatureChainId), types: { [primaryType]: fields }, primaryType, message: out };
}

export async function hlRecover(data: TypedData, sig: Sig): Promise<string> {
  return (await recoverTypedDataAddress({ ...(data as never as Parameters<typeof recoverTypedDataAddress>[0]), signature: toHex(sig) })).toLowerCase();
}

/** the native Hyperliquid message a door builds, signed with a simulated key on the Testnet label. It is never sent anywhere */
export async function hlSign(key: SimKey, primaryType: HlPrimary, message: Record<string, unknown>, signatureChainId = "0x66eee"): Promise<{ typedData: TypedData; signature: Sig }> {
  const typedData = hlTypedData(primaryType, signatureChainId, { hyperliquidChain: "Testnet", ...message });
  return { typedData, signature: toSig(await key.account.signTypedData(typedData as never)) };
}
