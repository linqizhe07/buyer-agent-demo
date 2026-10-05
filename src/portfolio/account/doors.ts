/** The doors: for each venue, how money gets in and out, how it moves around
 * inside, how one stablecoin becomes another there — and who may open each.
 *
 * Hyperliquid's interface shows the doors ONE venue gives its user. The
 * account has to know the same doors at EVERY venue, because a transfer
 * between two venues is one venue's way out, a rail, and the other venue's way
 * in. This file is that knowledge, as data:
 *
 *   Rail     one way in or out: the protocol it speaks, the tokens and chains
 *            it carries, its minimum, its fee, how long it takes or which
 *            clock it keeps, whether it is final — and its ACCESS:
 *              agent   an authorised agent key may, inside a spending approval
 *              owner   the owner signs it, with a key the venue itself accepts
 *              venue   it is started at the venue by the account holder; the
 *                      account can only watch it
 *              closed  nobody can here, with the reason and what would open it
 *   doorOf   a venue's rails, read off its credential's real scope
 *   plan     a movement as legs through the hub (the on-chain wallet), with
 *            the fee, the arrival, the strictest access on the way and a hash
 *            of the route — which is what the owner's signature covers
 *   native   the venue's own request for a leg: Hyperliquid's typed data, a
 *            signed REST call, a CCTP burn. It goes on the ledger row.
 *            Nothing is sent anywhere.
 *
 * Protocol shapes follow the venues' documentation as read on 2026-10-04.
 * Fees and times are the documented ones where a document gives them (CCTP's
 * forwarding fee, Hyperliquid's minimum, the ACH cut-offs) and illustrative
 * where it does not (network fees, gas).
 */
import { createHmac } from "node:crypto";
import { encodeFunctionData, keccak256, stringToHex } from "viem";
import type { Refusal } from "../../core/errors.ts";
import { canonical } from "../../core/hash.ts";
import { no } from "../refuse.ts";
import { r2, type Account, type AccountKind, type Holding } from "../accounts.ts";
import { bridgeQuotes, pick } from "../rails.ts";
import { achArrival } from "./calendar.ts";
import { HL_MIN_DEPOSIT, HL_MIN_SWAP } from "../adapters/hyperliquid.ts";
import { simKey, type Hex } from "./sign.ts";

export type Access = "agent" | "owner" | "venue" | "closed";
const STRICTNESS: Access[] = ["agent", "owner", "venue", "closed"];
export const strictest = (a: Access, b: Access): Access => (STRICTNESS.indexOf(a) >= STRICTNESS.indexOf(b) ? a : b);

export type FrontLine = "Stocks" | "Exchange" | "On-chain" | "RWA" | "Prediction";
export const FRONT_LINE: Record<AccountKind, FrontLine> = { broker: "Stocks", cex: "Exchange", perp: "Exchange", "agent-wallet": "On-chain", rwa: "RWA", prediction: "Prediction" };

export interface Rail {
  id: string;
  protocol: string;
  tokens: string[];
  /** the chains this rail touches on the wallet's side; empty for a rail that is not on a chain (ACH) */
  chains: string[];
  access: Access;
  /** when it is not the agent's: why, as a phrase */
  why?: string | undefined;
  /** what would open it */
  opens?: string | undefined;
  minUsd?: number | undefined;
  fee: (usd: number, chain?: string) => number;
  /** seconds, for a rail that never closes */
  etaSec: number;
  /** a rail that keeps bank hours lands by the calendar instead */
  clock?: "ach" | undefined;
  /** once it has landed it cannot come back */
  final: boolean;
  /** how long the other side may still return it */
  returnDays?: number | undefined;
}

export interface Door {
  venue: string;
  name: string;
  frontLine: FrontLine;
  /** the venue itself does not serve this customer's region: every rail is closed */
  restricted?: string | undefined;
  /** a live venue connected read-only: the account sends it nothing, so every rail is closed */
  watchOnly?: string | undefined;
  in: Rail[];
  out: Rail[];
  /** sub-ledgers money moves between at once, and who may move it */
  inside: Array<{ from: string; to: string; protocol: string; access: Access }>;
  swap: Array<{ pair: [string, string]; feeBps: number; minUsd: number; access: Access; protocol: string }>;
  /** the agent's credential at this venue, in the venue's own terms */
  agentKey: { model: string; can: string; cannot: string };
}

const HUB = "metamask";
const EVM = ["Arbitrum", "Base", "Ethereum"];
const GAS: Record<string, number> = { Base: 0.01, Arbitrum: 0.02, Polygon: 0.01, Optimism: 0.02, Ethereum: 1.5 };
const CEX_WITHDRAW_FEE: Record<string, number> = { Arbitrum: 0.8, Base: 0.5, Ethereum: 4.5 };
/** CCTP V2 fast-transfer fee into HyperCore, in basis points by source chain (Circle: none from Arbitrum) */
const CCTP_FAST_BPS: Record<string, number> = { Arbitrum: 0, Base: 1.3, Ethereum: 1 };
export const CCTP_FORWARD_FEE = 0.2;
export const CCTP_DOMAIN: Record<string, number> = { Ethereum: 0, Optimism: 2, Arbitrum: 3, Base: 6, Polygon: 7, HyperEVM: 19 };
const free = () => 0;
const whyRegion = "the venue does not serve this region";
export const whyWatchOnly = "a live venue, connected read-only: the account reads it and sends it nothing";

/** How one kind of exchange account is reached. Plugging in an exchange the account has never seen is picking one of these and handing over a
 * credential REFERENCE: no line of code names the new exchange. Its doors then follow from what the exchange says that key may do — `rails`
 * below reads the account's scope, which the adapter fills from the exchange's own answer about the key. */
export interface ExchangeProfile {
  id: string;
  label: string;
  /** what the credential is, in the exchange's own terms */
  credential: string;
  /** the call that tells what a key may do, where the exchange has one */
  probe: string;
  deposit: string;
  withdraw: string;
  convert: string;
  inside: Array<{ from: string; to: string; protocol: string; access: Access }>;
}

export const EXCHANGES: Record<string, ExchangeProfile> = {
  binance: { id: "binance", label: "Binance · its own REST API", credential: "API key and secret (HMAC-SHA256 over the query and body)", probe: "GET /sapi/v1/account/apiRestrictions", deposit: "GET /sapi/v1/capital/deposit/address", withdraw: "POST /sapi/v1/capital/withdraw/apply", convert: "POST /sapi/v1/convert/acceptQuote", inside: [{ from: "spot", to: "funding", protocol: "POST /sapi/v1/asset/transfer (MAIN_FUNDING)", access: "closed" }] },
  okx: { id: "okx", label: "OKX · its own REST API", credential: "API key, secret and passphrase (HMAC-SHA256, base64)", probe: "the key's Read / Trade / Withdraw permissions, set when it is created", deposit: "GET /api/v5/asset/deposit-address", withdraw: "POST /api/v5/asset/withdrawal", convert: "POST /api/v5/asset/convert/trade", inside: [{ from: "trading", to: "funding", protocol: "POST /api/v5/asset/transfer (18 → 6)", access: "agent" }] },
  /** any exchange the unified library covers: the request is the library's call, and the library writes the exchange's own */
  unified: { id: "unified", label: "Any exchange · the unified library (ccxt)", credential: "API key and secret, kept in the home directory and handed to the library", probe: "what the exchange showed when the key was made, corrected by its first refusal (the library has no single call for a key's permissions)", deposit: "fetchDepositAddress (unified API)", withdraw: "withdraw (unified API)", convert: "createOrder on the USDC/USDT market (unified API)", inside: [] },
};

export const exchangeOf = (a: Pick<Account, "id" | "connector">): ExchangeProfile => EXCHANGES[a.connector ?? a.id] ?? EXCHANGES.unified!;

function rails(a: Account): Pick<Door, "in" | "out" | "inside" | "swap" | "agentKey"> {
  const canMove = a.scope.can.includes("move");
  switch (a.kind) {
    case "broker":
      return {
        in: [{ id: "ach", protocol: "ACH from the linked bank", tokens: ["USD"], chains: [], access: "venue", why: "started at the broker by the account holder", opens: "broker-partner access: an ACH relationship and a transfer are Broker API calls, not something an app's key or OAuth scope can make", fee: free, etaSec: 0, clock: "ach", final: false, returnDays: 60 }],
        out: [{ id: "ach", protocol: "ACH to the linked bank", tokens: ["USD"], chains: [], access: "venue", why: "started at the broker by the account holder", opens: "broker-partner access; and only settled cash leaves, to the bank the deposit came from", fee: free, etaSec: 0, clock: "ach", final: true }],
        inside: [],
        swap: [],
        agentKey: { model: "trading API key, or OAuth with the `trading` scope", can: "read the account, place orders", cannot: "move cash: no key scope and no OAuth scope does" },
      };
    case "cex": {
      // which calls these are is the exchange's profile; who may make them is what the exchange says about the key
      const x = exchangeOf(a);
      const canTrade = a.scope.can.includes("trade");
      const outRail: Rail = canMove
        ? { id: "withdraw", protocol: x.withdraw, tokens: ["USDC", "USDT"], chains: EVM, access: "agent", why: "only to addresses already verified at the exchange", fee: (_usd, chain) => CEX_WITHDRAW_FEE[chain ?? "Arbitrum"] ?? 1, etaSec: 300, final: true }
        : { id: "withdraw", protocol: x.withdraw, tokens: ["USDC", "USDT"], chains: EVM, access: "venue", why: "this key has no withdraw permission", opens: "a withdrawal started at the exchange; or a key with the withdraw permission, an IP restriction and a whitelist that holds only your own addresses", fee: (_usd, chain) => CEX_WITHDRAW_FEE[chain ?? "Arbitrum"] ?? 1, etaSec: 300, final: true };
      return {
        in: [{ id: "deposit", protocol: x.deposit, tokens: ["USDC", "USDT"], chains: EVM, access: "agent", minUsd: 1, fee: free, etaSec: 120, final: true }],
        out: [outRail],
        inside: x.inside,
        swap: [{ pair: ["USDT", "USDC"], feeBps: 1, minUsd: 1, access: canTrade ? "agent" : "closed", protocol: x.convert }],
        agentKey: { model: a.connector === "unified" ? "API key with separate permissions, used through the unified library" : "API key with separate permissions, bound to an IP", can: [["read", true], ["trade", canTrade], ["withdraw to verified addresses", canMove]].filter(([, on]) => on).map(([w]) => w).join(", "), cannot: canMove ? "withdraw anywhere else, or add an address" : canTrade ? "withdraw" : "trade or withdraw" },
      };
    }
    case "perp":
      return {
        in: [{ id: "cctp", protocol: "CCTP V2 → HyperCore (depositForBurnWithHook)", tokens: ["USDC"], chains: EVM, access: "agent", minUsd: HL_MIN_DEPOSIT, fee: (usd, chain) => r2(CCTP_FORWARD_FEE + (usd * (CCTP_FAST_BPS[chain ?? "Arbitrum"] ?? 1)) / 10_000), etaSec: 60, final: true }],
        out: [{ id: "withdraw", protocol: "sendToEvmWithData (user-signed)", tokens: ["USDC"], chains: ["Arbitrum"], access: "owner", why: "only the master account's signature can withdraw", fee: () => r2(CCTP_FORWARD_FEE + 0.03), etaSec: 300, final: true }],
        inside: [{ from: "perps", to: "spot", protocol: "sendAsset · agentSendAsset", access: "agent" }, { from: "spot", to: "perps", protocol: "sendAsset · agentSendAsset", access: "agent" }],
        swap: [{ pair: ["USDC", "USDT"], feeBps: 1.4, minUsd: HL_MIN_SWAP, access: "agent", protocol: "spot IOC order" }],
        agentKey: { model: "API wallet approved by the master account (approveAgent)", can: "place orders, move collateral between the account's own balances", cannot: "withdraw, or send to anyone else" },
      };
    case "agent-wallet":
      // a self-custody wallet plugged in by its address: the account reads it and can send to it, and holds no key for it
      if (a.connector === "wallet")
        return {
          in: [{ id: "receive", protocol: "on-chain transfer", tokens: ["USDC", "USDT"], chains: [...EVM, "Polygon"], access: "agent", fee: free, etaSec: 15, final: true }],
          out: [{ id: "transfer", protocol: "on-chain transfer, signed in the wallet", tokens: ["USDC", "USDT"], chains: [...EVM, "Polygon"], access: "owner", why: "the key is in the wallet: only you can sign there", fee: (_usd, chain) => GAS[chain ?? "Base"] ?? 0.05, etaSec: 15, final: true }],
          inside: [],
          swap: [],
          agentKey: { model: "none: an address the account reads", can: "see the balance, send money to it", cannot: "move anything out: the key never leaves the wallet" },
        };
      return {
        in: [{ id: "receive", protocol: "on-chain transfer", tokens: ["USDC", "USDT"], chains: [...EVM, "Polygon"], access: "agent", fee: free, etaSec: 15, final: true }],
        out: [{ id: "transfer", protocol: "on-chain transfer (mm transfer)", tokens: ["USDC", "USDT"], chains: [...EVM, "Polygon"], access: canMove ? "agent" : "owner", why: "inside the wallet's own Guard policy: its allowlist and its 24-hour outflow", fee: (_usd, chain) => GAS[chain ?? "Base"] ?? 0.05, etaSec: 15, final: true }],
        inside: [{ from: "chain", to: "chain", protocol: "bridge (mm swap execute): liquidity bridge · CCTP · canonical", access: canMove ? "agent" : "owner" }],
        swap: [{ pair: ["USDC", "USDT"], feeBps: 5, minUsd: 1, access: a.scope.can.includes("trade") ? "agent" : "owner", protocol: "DEX swap (mm swap execute)" }],
        agentKey: { model: "CLI session under the wallet's Guard policy", can: "swap, transfer and bridge inside the policy", cannot: "go past the allowlist or the 24-hour outflow without the owner's MFA" },
      };
    case "rwa":
      return {
        in: [{ id: "transfer", protocol: "USDC to the KYC'd address", tokens: ["USDC"], chains: ["Ethereum"], access: "agent", fee: free, etaSec: 15, final: true }],
        out: [{ id: "transfer", protocol: "USDC from the KYC'd address", tokens: ["USDC"], chains: ["Ethereum"], access: canMove ? "agent" : "owner", fee: () => GAS.Ethereum!, etaSec: 15, final: true }],
        inside: [],
        swap: [],
        agentKey: { model: "a KYC-allowlisted address the wallet signs for", can: "subscribe and redeem at NAV, move USDC", cannot: "send the fund's token to an address the issuer has not allowlisted" },
      };
    case "prediction":
      return a.chain
        ? {
            in: [{ id: "deposit", protocol: "bridge into the deposit wallet", tokens: ["USDC", "pUSD"], chains: ["Polygon"], access: "agent", minUsd: 1, fee: free, etaSec: 30, final: true }],
            out: [{ id: "withdraw", protocol: "relayed withdrawal from the deposit wallet", tokens: ["pUSD", "USDC"], chains: ["Polygon"], access: canMove ? "agent" : "owner", fee: free, etaSec: 60, final: true }],
            inside: [],
            swap: [],
            agentKey: { model: "CLOB key derived from the wallet", can: "place and cancel orders, move pUSD", cannot: "trade where the venue takes no orders" },
          }
        : {
            in: [{ id: "ach", protocol: "ACH from a bank account", tokens: ["USD"], chains: [], access: "venue", why: "started at the exchange's own page", opens: "nothing in the API: deposits go by ACH or debit card from the account page", fee: free, etaSec: 0, clock: "ach", final: false, returnDays: 60 }],
            out: [{ id: "ach", protocol: "ACH payout", tokens: ["USD"], chains: [], access: "venue", why: "started at the exchange's own page", opens: "nothing in the API", fee: free, etaSec: 0, clock: "ach", final: true }],
            inside: [],
            swap: [],
            agentKey: { model: "API key id + RSA-signed requests", can: "read, trade", cannot: "move money: the API has no such call" },
          };
  }
}

export function doorOf(a: Account): Door {
  const r = rails(a);
  const door: Door = { venue: a.id, name: a.name, frontLine: FRONT_LINE[a.kind], ...r };
  // a live venue is read, not written: whatever its key could do there, the account starts nothing through it
  if (a.watchOnly !== undefined) {
    const shut = (x: Rail): Rail => ({ ...x, access: "closed", why: whyWatchOnly, opens: "nothing yet: live connections are read-only" });
    return { ...door, watchOnly: a.watchOnly, in: r.in.map(shut), out: r.out.map(shut), inside: r.inside.map((x) => ({ ...x, access: "closed" as const })), swap: r.swap.map((x) => ({ ...x, access: "closed" as const })), agentKey: { model: a.address ? "none: an address the account reads" : "a read-only connection with the key in the home directory", can: "nothing: no agent key reaches a live venue", cannot: "trade, move or pay there" } };
  }
  if (a.restricted === undefined) return door;
  const shut = (x: Rail): Rail => ({ ...x, access: "closed", why: whyRegion, opens: undefined });
  return { ...door, restricted: a.restricted, in: r.in.map(shut), out: r.out.map(shut), inside: r.inside.map((x) => ({ ...x, access: "closed" as const })), swap: r.swap.map((x) => ({ ...x, access: "closed" as const })) };
}

// ---- routes ---------------------------------------------------------------------

export interface Leg {
  /** `out` leave a venue · `in` enter one · `bridge` wallet, chain to chain · `swap` one stablecoin into another · `shift` inside one venue */
  step: "out" | "in" | "bridge" | "swap" | "shift";
  venue: string;
  rail: string;
  protocol: string;
  /** what is moving when this leg ends */
  token: string;
  chain?: string | undefined;
  /** for a shift: the sub-ledgers */
  fromLedger?: string | undefined;
  toLedger?: string | undefined;
  feeUsd: number;
  etaSec: number;
  clock?: "ach" | undefined;
  access: Access;
  why?: string | undefined;
  opens?: string | undefined;
  final: boolean;
}

export interface Route {
  from: string;
  to: string;
  /** what leaves the source */
  sourceToken: string;
  /** what arrives */
  token: string;
  amountUsd: number;
  legs: Leg[];
  feeUsd: number;
  receiveUsd: number;
  arrivalMs: number;
  /** the strictest access among the legs */
  access: Access;
  /** the leg that is not the agent's to fly, when there is one */
  blocker?: { venue: string; step: Leg["step"]; access: Access; why: string; opens?: string | undefined } | undefined;
  /** what the owner's signature covers: where it goes and through what */
  hash: Hex;
}

export interface RouteRequest {
  from: string;
  /** a venue id, or — for a send to someone else — the address book entry it goes to */
  to: string;
  amountUsd: number;
  /** what should arrive; default: what the destination takes */
  token?: string | undefined;
  fromLedger?: string | undefined;
  toLedger?: string | undefined;
  /** a third party: where on chain it lives */
  external?: { address: string; chain: string } | undefined;
}

/** what the planner needs to know of a venue: its account, and what it holds */
export interface VenueView extends Account {
  holdings: Holding[];
}

export const routeHash = (r: Pick<Route, "from" | "to" | "token" | "legs">): Hex =>
  keccak256(stringToHex(canonical({ from: r.from, to: r.to, token: r.token, legs: r.legs.map((l) => [l.step, l.venue, l.rail, l.token, l.chain ?? "", l.fromLedger ?? "", l.toLedger ?? ""]) })));

/** pUSD is USDC sitting in a prediction market's deposit wallet: it arrives and leaves as USDC */
const same = (a: string, b: string) => (a === "pUSD" ? "USDC" : a) === (b === "pUSD" ? "USDC" : b);
const held = (v: VenueView, token: string, chain?: string) => v.holdings.filter((h) => !h.inTransit && h.asset === token && (chain === undefined || h.note === chain)).reduce((s, h) => s + h.amount, 0);
const legOf = (step: Leg["step"], venue: string, rail: Rail, token: string, chain: string | undefined, usd: number): Leg => ({ step, venue, rail: rail.id, protocol: rail.protocol, token, ...(chain ? { chain } : {}), feeUsd: rail.fee(usd, chain), etaSec: rail.etaSec, ...(rail.clock ? { clock: rail.clock } : {}), access: rail.access, ...(rail.why ? { why: rail.why } : {}), ...(rail.opens ? { opens: rail.opens } : {}), final: rail.final });

function finish(req: RouteRequest, sourceToken: string, token: string, legs: Leg[], nowMs: number): Route {
  const feeUsd = r2(legs.reduce((s, l) => s + l.feeUsd, 0));
  let at = nowMs;
  for (const l of legs) at = l.clock === "ach" ? achArrival(at) : at + l.etaSec * 1000;
  let access: Access = "agent";
  let blocker: Route["blocker"];
  for (const l of legs) {
    if (STRICTNESS.indexOf(l.access) > STRICTNESS.indexOf(access)) {
      access = l.access;
      blocker = { venue: l.venue, step: l.step, access: l.access, why: l.why ?? "not the agent's to do", ...(l.opens ? { opens: l.opens } : {}) };
    }
  }
  const route = { from: req.from, to: req.to, sourceToken, token, amountUsd: req.amountUsd, legs, feeUsd, receiveUsd: r2(req.amountUsd - feeUsd), arrivalMs: at, access, ...(blocker ? { blocker } : {}) };
  return { ...route, hash: routeHash(route) };
}

/** A movement as legs. Venue to venue goes through the hub: the source's way out lands in the on-chain wallet, the wallet
 * changes chain or token if it has to, and the destination's way in takes it. The plan says what each leg costs, when the
 * money lands, and whose signature the strictest leg needs; it refuses what a venue would lose (an amount under its minimum,
 * a fee larger than the amount) before anything leaves. */
export function plan(req: RouteRequest, venues: VenueView[], nowMs: number): Route | Refusal {
  const src = venues.find((v) => v.id === req.from);
  const dst = req.external ? undefined : venues.find((v) => v.id === req.to);
  if (!src) return no("E_WALLET_ACCOUNT_UNKNOWN", { venue: req.from });
  if (!dst && !req.external) return no("E_WALLET_ACCOUNT_UNKNOWN", { venue: req.to });
  if (!(req.amountUsd > 0)) return no("E_ACCOUNT_BAD_ACTION", { message: "the amount must be more than zero" });
  const sd = doorOf(src);
  const dd = dst ? doorOf(dst) : undefined;
  const usd = req.amountUsd;

  // inside one venue: perps ⇄ spot, trading → funding
  if (dst && src.id === dst.id) {
    const shift = sd.inside.find((x) => x.from === (req.fromLedger ?? "") && x.to === (req.toLedger ?? ""));
    if (!shift) return no("E_VENUE_RAIL_CLOSED", { venue: src.id, message: `${src.name} has no transfer from "${req.fromLedger ?? "?"}" to "${req.toLedger ?? "?"}"`, detail: { inside: sd.inside.map((x) => `${x.from} → ${x.to}`) } });
    const token = req.token ?? "USDC";
    return finish(req, token, token, [{ step: "shift", venue: src.id, rail: "inside", protocol: shift.protocol, token, fromLedger: shift.from, toLedger: shift.to, feeUsd: 0, etaSec: 0, access: shift.access, ...(shift.access === "closed" ? { why: sd.watchOnly ? whyWatchOnly : sd.restricted ? whyRegion : "this key cannot transfer inside the venue" } : {}), final: true }], nowMs);
  }

  const outRail = src.id === HUB ? undefined : sd.out[0];
  const inRail = !dd || dd.venue === HUB ? undefined : dd.in[0];
  if (src.id !== HUB && !outRail) return no("E_VENUE_RAIL_CLOSED", { venue: src.id, message: `${src.name} has no way out for money` });
  if (dd && dd.venue !== HUB && !inRail) return no("E_VENUE_RAIL_CLOSED", { venue: dd.venue, message: `${dd.name} takes no deposits` });

  // a rail that keeps bank hours never touches the chain: it is an ACH with the user's own bank, started at the venue itself (a broker, a
  // regulated exchange). The bank is not on this account, so nothing between that venue and the others goes through it
  const fiat = (outRail?.chains.length === 0 ? outRail : undefined) ?? (inRail?.chains.length === 0 ? inRail : undefined);
  if (fiat) {
    const at = fiat === outRail ? src : dst!;
    return no("E_VENUE_RAIL_CLOSED", { venue: at.id, message: `${at.name} moves dollars only by ACH with your own bank, started at ${at.name}: nothing between it and your other venues goes through the account`, detail: { rail: fiat.protocol, ...(fiat.opens ? { opens: fiat.opens } : {}) } });
  }

  // on a chain from here on: the on-chain wallet is the hub every such rail meets at
  const hubV = venues.find((v) => v.id === HUB);
  if (!hubV) return no("E_WALLET_ACCOUNT_UNKNOWN", { venue: HUB, message: "moving money between venues needs the on-chain wallet: it is the hub the rails meet at" });
  const hubOut = doorOf(hubV).out[0]!;
  const wantToken = req.token ?? (inRail && !inRail.tokens.some((t) => same(t, "USDC")) ? inRail.tokens[0]! : "USDC");
  if (inRail && !inRail.tokens.some((t) => same(t, wantToken))) return no("E_VENUE_CURRENCY", { venue: dd!.venue, message: `${dd!.name} takes ${inRail.tokens.join(" or ")}, not ${wantToken}`, detail: { takes: inRail.tokens, want: wantToken } });
  const legs: Leg[] = [];

  // what leaves the source: the wanted token if it holds enough of it, else a stablecoin it can turn into it there
  const carried = (outRail ?? hubOut).tokens;
  const sourceToken = carried.find((t) => same(t, wantToken) && held(src, t) >= usd) ?? carried.find((t) => held(src, t) >= usd) ?? wantToken;
  let token = sourceToken;
  if (!same(token, wantToken)) {
    const sw = sd.swap.find((x) => x.pair.includes(token) && x.pair.includes(wantToken));
    if (!sw) return no("E_VENUE_CURRENCY", { venue: dd?.venue ?? src.id, message: `${src.name} holds ${token}, ${dd?.name ?? "the destination"} takes ${wantToken}, and ${src.name} cannot swap one for the other`, detail: { holds: token, takes: wantToken } });
    if (usd < sw.minUsd) return no("E_VENUE_MIN_DEPOSIT", { venue: src.id, message: `${src.name}: a swap is at least $${sw.minUsd}`, detail: { minUsd: sw.minUsd, amountUsd: usd } });
    legs.push({ step: "swap", venue: src.id, rail: "swap", protocol: sw.protocol, token: wantToken, feeUsd: r2((usd * sw.feeBps) / 10_000), etaSec: 0, access: sw.access, ...(sw.access === "closed" ? { why: sd.watchOnly ? whyWatchOnly : sd.restricted ? whyRegion : "this key cannot trade here" } : {}), final: true });
    token = wantToken;
  }

  // which chain it travels on: one both ends share if there is one; otherwise it leaves on the source's and the wallet bridges it
  const candidates = src.kind === "agent-wallet" ? [...EVM, "Polygon"].filter((c) => held(src, sourceToken, c) >= usd) : outRail!.chains;
  if (!candidates.length) return no("E_VENUE_INSUFFICIENT", { venue: src.id, message: `${src.name} does not hold $${usd} of ${sourceToken} on any one chain`, detail: { token: sourceToken, amountUsd: usd } });
  const wanted = req.external ? [req.external.chain] : inRail ? inRail.chains : candidates;
  const leave = candidates.find((c) => wanted.includes(c)) ?? candidates[0]!;
  const arrive = wanted.includes(leave) ? leave : wanted[0]!;

  // the source's way out lands in the wallet
  if (src.id !== HUB) legs.push(legOf("out", src.id, outRail!, token, leave, usd));
  if (leave !== arrive) {
    const q = pick(bridgeQuotes(usd, arrive, leave), "cost")!;
    legs.push({ step: "bridge", venue: HUB, rail: q.id, protocol: `${q.label}: ${leave} → ${arrive}`, token, chain: arrive, feeUsd: q.feeUsd, etaSec: q.etaSec, access: hubOut.access, final: true });
  }
  if (req.external) {
    legs.push({ step: "out", venue: HUB, rail: hubOut.id, protocol: hubOut.protocol, token, chain: arrive, feeUsd: hubOut.fee(usd, arrive), etaSec: hubOut.etaSec, access: "owner", why: "sending to someone else is the owner's to sign", final: true });
  } else if (dd && dd.venue !== HUB) {
    // the wallet's own transaction carries it to the destination's door, and the door takes it in
    legs.push(legOf("out", HUB, hubOut, token, arrive, usd));
    legs.push(legOf("in", dd.venue, inRail!, inRail!.tokens.includes("pUSD") ? "pUSD" : token, arrive, usd));
  }

  const route = finish(req, sourceToken, legs[legs.length - 1]?.token ?? token, legs, nowMs);
  const min = inRail?.minUsd;
  if (min !== undefined && route.receiveUsd < min) return no("E_VENUE_MIN_DEPOSIT", { venue: dd!.venue, message: `${dd!.name} takes no deposit under $${min}: $${route.receiveUsd} would arrive after $${route.feeUsd} in fees, so nothing is sent`, detail: { minUsd: min, wouldArriveUsd: route.receiveUsd, feeUsd: route.feeUsd } });
  if (route.receiveUsd <= 0) return no("E_VENUE_MIN_DEPOSIT", { venue: dd?.venue ?? src.id, message: `the fees ($${route.feeUsd}) are more than the amount ($${usd}): nothing is sent`, detail: { feeUsd: route.feeUsd, amountUsd: usd } });
  return route;
}

// ---- the venue's own request for a leg -----------------------------------------------

const SIM_SECRET = "buyer-agent-demo/sim/cex-api-secret";

/** Binance: `signature = hex(HMAC_SHA256(secret, query + body))` */
export function binanceSign(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/** OKX: `OK-ACCESS-SIGN = base64(HMAC_SHA256(secret, timestamp + METHOD + requestPath + body))` */
export function okxSign(secret: string, timestamp: string, method: string, requestPath: string, body = ""): string {
  return createHmac("sha256", secret).update(`${timestamp}${method.toUpperCase()}${requestPath}${body}`).digest("base64");
}

/** CCTP's hook data for a deposit straight into a HyperCore balance: "cctp-forward" padded to 24 bytes, version 0, length 24, recipient, destination dex (0 perps, 0xFFFFFFFF spot) */
export function cctpForwardHook(recipient: string, spot = false): Hex {
  const magic = Buffer.alloc(24);
  magic.write("cctp-forward", "utf8");
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n >>> 0);
    return b;
  };
  return `0x${Buffer.concat([magic, u32(0), u32(24), Buffer.from(recipient.replace(/^0x/, "").padStart(40, "0").slice(-40), "hex"), u32(spot ? 0xffffffff : 0)]).toString("hex")}`;
}

export const CCTP = { tokenMessengerV2: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d", forwarder: "0xb21D281DEdb17AE5B501F6AA8256fe38C4e45757" } as const;
/** Circle's USDC on the chains the wallet holds it (the token a CCTP burn names). From Circle's published addresses, not re-read for this build */
const USDC_ON: Record<string, `0x${string}`> = { Arbitrum: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", Base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", Ethereum: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" };
const DEPOSIT_WITH_HOOK = [{ type: "function", name: "depositForBurnWithHook", stateMutability: "nonpayable", inputs: [{ name: "amount", type: "uint256" }, { name: "destinationDomain", type: "uint32" }, { name: "mintRecipient", type: "bytes32" }, { name: "burnToken", type: "address" }, { name: "destinationCaller", type: "bytes32" }, { name: "maxFee", type: "uint256" }, { name: "minFinalityThreshold", type: "uint32" }, { name: "hookData", type: "bytes" }], outputs: [] }] as const;
const pad32 = (address: string): Hex => `0x${address.replace(/^0x/, "").padStart(64, "0")}`;
/** the unified library's names for the chains (as the library spells them; not re-read for this build) */
const UNIFIED_NETWORK: Record<string, string> = { Arbitrum: "ARBONE", Base: "BASE", Ethereum: "ERC20", Polygon: "MATIC", Optimism: "OPTIMISM" };
/** OKX names a chain as `<ccy>-<chain>`; the exact labels are whatever GET /api/v5/asset/currencies returns */
const OKX_CHAIN: Record<string, string> = { Arbitrum: "Arbitrum One", Ethereum: "ERC20", Base: "Base" };
const HL_SPOT_USDC = "USDC:0x6d1e7cde53ba9467b783cb7c530ce054";
/** the address of the wallet that owns the simulated Hyperliquid account: what a deposit's hook credits and what signs a withdrawal. Derived from a label, like every key here */
const hlAccount = (): string => simKey("hyperliquid:master-account").address;

export interface NativeCtx {
  /** what is in flight when the leg starts */
  amount: string;
  /** where this leg sends it: an address, or — for a venue's own leg — the account there */
  to: string;
  nowMs: number;
  account?: string | undefined;
  /** what the source held before a swap leg turned it into `leg.token` */
  from?: string | undefined;
  /** by whose authority the leg flies: an agent's leg at Hyperliquid is `agentSendAsset`, the owner's is `sendAsset` */
  authority?: string | undefined;
  /** how the venue is reached (`EXCHANGES`), and what kind of venue it is */
  connector?: string | undefined;
  kind?: AccountKind | undefined;
}

/** What the venue would be sent for this leg, in its own shape. Nothing leaves this process.
 * What is SIGNED here: the exchanges' REST calls (HMAC, with a simulated secret). What is BUILT and left unsigned: Hyperliquid's actions and the
 * CCTP burn — the first needs the key of the wallet that owns the Hyperliquid account, the second the on-chain wallet's, and the account layer
 * holds neither. Through the unified library the request is the library's call: the library writes and signs the exchange's own. */
export function nativeRequest(leg: Leg, ctx: NativeCtx): Record<string, unknown> {
  const { amount, to, nowMs } = ctx;
  const via = ctx.connector ?? leg.venue;
  if (via === "binance" && leg.step === "out") {
    const query = `coin=${leg.token}&network=${(leg.chain ?? "").toUpperCase()}&address=${to}&amount=${amount}&withdrawOrderId=${ctx.account ?? "acct"}-${nowMs}&recvWindow=5000&timestamp=${nowMs}`;
    return { method: "POST", path: "/sapi/v1/capital/withdraw/apply", headers: { "X-MBX-APIKEY": "(reference)" }, query, signature: binanceSign(SIM_SECRET, query) };
  }
  if (via === "binance" && leg.step === "swap") return { method: "POST", path: "/sapi/v1/convert/getQuote → /sapi/v1/convert/acceptQuote", body: { fromAsset: ctx.from ?? "USDT", toAsset: leg.token, fromAmount: amount, walletType: "SPOT", validTime: "10s" } };
  if (via === "okx" && leg.step === "out") {
    // "Withdrawal fee is not included in withdrawal amount": `amt` is what arrives, and the funding account has to hold amt + fee — so that is what is moved into it first
    const amt = String(r2(Number(amount) - leg.feeUsd));
    const body = JSON.stringify({ ccy: leg.token, amt, dest: "4", toAddr: to, chain: `${leg.token}-${OKX_CHAIN[leg.chain ?? ""] ?? leg.chain ?? ""}`, clientId: `${nowMs}` });
    const ts = new Date(nowMs).toISOString();
    return { before: { method: "POST", path: "/api/v5/asset/transfer", body: { ccy: leg.token, amt: amount, from: "18", to: "6", type: "0" } }, method: "POST", path: "/api/v5/asset/withdrawal", headers: { "OK-ACCESS-KEY": "(reference)", "OK-ACCESS-TIMESTAMP": ts, "OK-ACCESS-PASSPHRASE": "(reference)", "OK-ACCESS-SIGN": okxSign(SIM_SECRET, ts, "POST", "/api/v5/asset/withdrawal", body) }, body: JSON.parse(body) as unknown };
  }
  if (via === "okx" && leg.step === "swap") return { method: "POST", path: "/api/v5/asset/convert/estimate-quote → /api/v5/asset/convert/trade", body: { baseCcy: leg.token, quoteCcy: ctx.from ?? "USDT", side: "buy", rfqSz: amount, rfqSzCcy: ctx.from ?? "USDT" } };
  if (ctx.kind === "cex") {
    // any other exchange: the unified library's call
    const call = leg.step === "out" ? { call: "withdraw", args: [leg.token, Number(amount), to, undefined, { network: UNIFIED_NETWORK[leg.chain ?? ""] ?? leg.chain }] } : leg.step === "swap" ? { call: "createOrder", args: [`${leg.token}/${ctx.from ?? "USDT"}`, "market", "buy", Number(amount)] } : leg.step === "in" ? { call: "fetchDepositAddress", args: [leg.token, { network: UNIFIED_NETWORK[leg.chain ?? ""] ?? leg.chain }] } : { call: "transfer", args: [leg.token, Number(amount), leg.fromLedger, leg.toLedger] };
    return { library: "ccxt · unified API", exchange: leg.venue, ...call, signs: "the library, with the key in the home directory: it writes the exchange's own request" };
  }
  if (leg.venue === "hyperliquid" && leg.step === "in") {
    // Circle's forwarder mints on HyperEVM and credits the HyperCore balance of the address in the hook: the Hyperliquid account itself.
    // `maxFee` is a ceiling (only the fee executed is taken): the 0.20 USDC forwarding fee, the fast-transfer fee, and room for the forwarder's gas, which moves
    const units = BigInt(Math.round(Number(amount) * 1_000_000));
    const maxFee = BigInt(Math.round((leg.feeUsd + 0.05) * 1_000_000));
    const burnToken = USDC_ON[leg.chain ?? "Arbitrum"] ?? USDC_ON.Arbitrum!;
    const hookData = cctpForwardHook(hlAccount(), false);
    const args = { amount: String(units), destinationDomain: CCTP_DOMAIN.HyperEVM!, mintRecipient: pad32(CCTP.forwarder), burnToken, destinationCaller: pad32(CCTP.forwarder), maxFee: String(maxFee), minFinalityThreshold: 1000, hookData };
    return { chain: leg.chain, to: CCTP.tokenMessengerV2, function: "depositForBurnWithHook", args, data: encodeFunctionData({ abi: DEPOSIT_WITH_HOOK, functionName: "depositForBurnWithHook", args: [units, args.destinationDomain, args.mintRecipient, burnToken, args.destinationCaller, maxFee, 1000, hookData] }), signs: "the on-chain wallet (after an approve of the same amount): not signed here" };
  }
  if (leg.venue === "hyperliquid") {
    const unsigned = { hyperliquidChain: "Testnet", signature: null };
    const owner = { ...unsigned, signatureChainId: "0x66eee", signs: "the wallet that owns the Hyperliquid account — a user-signed action; the account layer holds no such key, so this is built and not signed" };
    if (leg.step === "out") return { type: "sendToEvmWithData", token: "USDC", amount, sourceDex: "", destinationRecipient: to, addressEncoding: "hex", destinationChainId: CCTP_DOMAIN[leg.chain ?? "Arbitrum"], gasLimit: 200000, data: "0x", nonce: nowMs, primaryType: "HyperliquidTransaction:SendToEvmWithData", ...owner };
    if (leg.step === "shift") {
      const fields = { destination: hlAccount(), sourceDex: leg.fromLedger === "spot" ? "spot" : "", destinationDex: leg.toLedger === "spot" ? "spot" : "", token: HL_SPOT_USDC, amount, fromSubAccount: "", nonce: nowMs };
      // an API wallet's version is an L1 action (signed as Agent(source, connectionId) over the action's hash), and its destination has to be the account itself
      return ctx.authority === "agent" ? { type: "agentSendAsset", ...fields, ...unsigned, signs: "the API wallet approved at Hyperliquid — an L1 action; built and not signed" } : { type: "sendAsset", ...fields, primaryType: "HyperliquidTransaction:SendAsset", ...owner };
    }
    if (leg.step === "swap") return { type: "order", orders: [{ a: "USDC/USDT (spot)", b: leg.token === "USDT", p: "1.0", s: amount, r: false, t: { limit: { tif: "Ioc" } } }], grouping: "na", ...unsigned, signs: "the API wallet approved at Hyperliquid — an L1 action; built and not signed" };
  }
  if (leg.step === "in" && leg.protocol.startsWith("on-chain transfer from the float")) return { method: "eth_sendTransaction", call: `transfer(address,uint256) on ${leg.token}`, to, amount, chain: leg.chain, signs: "the float's key, which the account holds" };
  if (ctx.connector === "wallet") return { wallet: leg.venue, method: "eth_sendTransaction", call: `transfer(address,uint256) on ${leg.token}`, to, amount, chain: leg.chain, signs: "the owner, in that wallet: the account holds no key for it" };
  if (leg.step === "bridge") return { command: "mm swap execute", from: leg.protocol, token: leg.token, amount, via: leg.rail };
  return { command: "mm transfer", token: leg.token, amount, to, chain: leg.chain };
}
