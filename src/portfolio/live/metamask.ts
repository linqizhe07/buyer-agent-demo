/** The MetaMask Agent Wallet, read and traded through MetaMask's own `mm` command line on this machine.
 *
 *   mm wallet show       the wallet's address and its Guard policy (what MetaMask itself lets the wallet do without asking)
 *   mm wallet balance    what it holds, per chain, with MetaMask's own dollar values
 *
 * The CLI holds the session; this process holds nothing. It is the wallet the account was built around, so it is also the one other
 * connections send to. Reading needs the CLI to be signed in (`mm wallet show` working in a terminal).
 *
 * TRADING, through the commands mm 7.0.0 documents for it and nothing else:
 *
 *   a swap               `<TOKEN>/USDC@<chain>`. `mm swap quote` moves nothing; `mm swap execute --quote-id` sends the quote just made,
 *                        never a blind re-quote; `mm swap status --quote-id` until MetaMask's Bridge API says COMPLETE or FAILED. A swap is
 *                        exact-input: a sell spends exactly the tokens, a buy spends qty × ask in USDC and gets about qty, never exactly
 *   a prediction order   `<market slug>:<outcome>` at Polymarket. `mm predict geoblock` first, then `mm predict place --order-type`: a limit
 *                        order GTC (it rests, and `--post-only` keeps it a maker), or FAK (IOC) or FOK at its limit; a market order FAK, or
 *                        FOK, at its worst price. `mm predict orders` while it rests; `mm predict cancel --order-id`
 *   what is held         `mm predict positions`: the shares the Predict deposit wallet holds. A swap leaves tokens in the wallet itself,
 *                        which `mm wallet balance` reads already: mm has no positions of its own for them
 *   what to trade        `mm predict events list`: Polymarket's events, busiest first, for the account's market discovery. A read
 *   a perpetual          `<COIN>-PERP` at Hyperliquid (`BTC-PERP`), through `mm perps` (perps.md): `mm perps markets` for the market, its
 *                        mark price, funding and largest leverage; `mm perps open --type market|limit --leverage` (a market order is
 *                        Hyperliquid's IOC within `--max-slippage-bps` of the mark, a limit order rests GTC); `mm perps orders` while it
 *                        rests and `mm perps cancel --order-id`; `mm perps positions`; `mm perps close --symbol --size` (Hyperliquid's own
 *                        reduce-only IOC); `mm perps modify --leverage`. Every order, close and leverage change first holds this machine's
 *                        place to Hyperliquid's own line: mm 7.0.0 has no region check for its perpetuals, so the place is the one mm says
 *                        (`mm predict geoblock` answers where this machine is), held to Hyperliquid's Terms of Use §1.6, which close the
 *                        venue to anyone located in the United States, Ontario or a sanctioned territory. Restricted, or not known, and
 *                        nothing is sent
 *
 * No amend: mm 7.0.0 has no command that changes an order in place. A Polymarket position is closed by selling its shares (an order); a
 * swap has neither close nor leverage.
 *
 * EARN, through `mm earn` (earn.md: LI.FI's earn API): mmEarner below. The vaults (`mm earn markets`), what the wallet holds in them (`mm
 * earn positions`), money in (`mm earn supply --vault --chain-id`) and out (`mm earn withdraw --vault --chain-id`): from the wallet, back
 * to the wallet, on the vault's own chain — never `--from-chain-id`, never anywhere else.
 *
 * What moves money (`swap execute`, `predict place`, `perps open`, `perps close`, `perps modify`, `earn supply`, `earn withdraw`) runs only
 * when MetaMask's own switch is on as well as this server's: PORTFOLIO_MM_WRITES=1, as for `mm transfer` (writes.ts). Otherwise the command
 * that would run is printed and nothing runs. MetaMask's Guard still judges every one (its rolling 24-hour outflow, its allowlists): above
 * its line it asks the owner by email or on MetaMask Mobile, and mm waits up to ten minutes for the answer.
 */
import { execFile } from "node:child_process";
import { formatUnits, parseUnits } from "viem";
import { isRefusal, type Code, type Refusal } from "../../core/errors.ts";
import { holdingsOf, type MmBalance, type MmShow } from "../adapters/metamask.ts";
import { no } from "../refuse.ts";
import { CHAIN_BY_ID, CHAINS, STABLECOINS, type ChainName } from "./chain.ts";
import { known as knownFigure, once, type EarnPosition, type EarnProduct, type EarnSource, type EarnState, type LiveEarner } from "./earn.ts";
import { HL_TERMS, HYPERLIQUID_RULE, placeOf, type Locator } from "./location.ts";
import { CLOSE_ONLY_WORDS, polymarketScope, readablePlace } from "./polymarket-clob.ts";
import type { Price } from "./prices.ts";
import { badOrder, ceilTo, DONE, floorTo, inDollars, onStep, pick, plain, type LiveTrader, type Market, type MarketKind, type OrderRequest, type OrderState, type OrderStatus, type Position, type TimeInForce } from "./trade.ts";
import { asRefusal, edgeWords, isStable, num, redact, REGION, type LiveBalance, type LiveSource } from "./types.ts";
import { mmWriter } from "./writes.ts";

/** one mm command, its `data` back; a failure throws mm's own error. A write asks for a longer wait than a read */
export type RunMm = <T>(args: string[], opts?: { timeoutMs?: number }) => Promise<T>;

// ---- the command line ------------------------------------------------------------------------------

/** a line mm prints while a command waits, such as `AWAITING_MFA` while MetaMask's Guard asks the owner */
export interface MmNotice {
  kind?: string;
  source?: string;
  pollingId?: string;
  expiresAt?: string;
  authMethod?: string | null;
  message?: string;
}
export interface MmFailure {
  code: string;
  message: string;
  hint?: string | undefined;
}
export type MmParsed = { ok: true; data: unknown; notices: MmNotice[] } | { ok: false; error: MmFailure; notices: MmNotice[] };

/** mm's own failure, as the runner throws it: its code, its words, its hint, and the notices it printed before it failed */
export class MmError extends Error {
  readonly code: string;
  readonly said: string;
  readonly hint: string | undefined;
  readonly notices: MmNotice[];
  constructor(f: MmFailure, notices: MmNotice[] = []) {
    super(`${f.code}: ${f.message}`);
    this.name = "MmError";
    this.code = f.code;
    this.said = f.message;
    this.hint = f.hint;
    this.notices = notices;
  }
}

const jsonOf = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};
const obj = (v: unknown): Record<string, unknown> | undefined => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
/** a figure the venue gave, or nothing when it gave none: unlike num(), a figure that is not there is not read as 0 (a resolved outcome
 * that lost really is worth 0) */
const known = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

function failureIn(v: unknown): MmFailure | undefined {
  const o = obj(v);
  const e = o?.ok === false ? obj(o.error) : obj(o?._error);
  if (!e) return undefined;
  return { code: str(e.code) || "UNKNOWN", message: str(e.message), ...(str(e.hint) ? { hint: str(e.hint) } : {}) };
}

/** What mm printed, read the three ways mm 7.0.0 prints it with `--json` (its headless runner):
 *   success      stdout, one JSON document `{"ok": true, "data": …}`, exit 0
 *   failure      stderr, one JSON document `{"ok": false, "error": {code, message, hint}}`, exit 1
 *   a pause      stdout turns into JSON lines: `{"_notice": …}` for each notice (Guard's AWAITING_MFA), then `{"_summary": …}` on success;
 *                a failure after a notice is `{"_error": …}` on stderr
 * An answer printed whole is mm's answer whatever the exit code: mm 7.0.0's SIGINT and SIGTERM handlers exit 130 or 143 after it has
 * answered. Anything else (a crash, a Node too old for mm) is UNPARSEABLE with mm's raw words — never with JSON mm printed, which may say
 * where this machine is (`mm predict geoblock`'s answer does). */
export function parseMm(stdout: string, stderr: string, exitCode: number | null): MmParsed {
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => obj(jsonOf(l)));
  const notices = lines.flatMap((o) => {
    const n = obj(o?._notice);
    return n ? [n as MmNotice] : [];
  });
  const answer = (): MmParsed | undefined => {
    const summary = lines.find((o) => o !== undefined && "_summary" in o);
    if (summary) return { ok: true, data: summary._summary, notices };
    const whole = obj(jsonOf(stdout));
    return whole?.ok === true && "data" in whole ? { ok: true, data: whole.data, notices } : undefined;
  };
  if (exitCode === 0) {
    const a = answer();
    if (a) return a;
  }
  const errLines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .reverse();
  const failed = failureIn(jsonOf(stderr)) ?? errLines.map((l) => failureIn(jsonOf(l))).find((f) => f !== undefined);
  if (failed) return { ok: false, error: failed, notices };
  const late = answer();
  if (late) return late;
  const error = failureIn(jsonOf(stdout)) ?? lines.map((o) => failureIn(o)).find((f) => f !== undefined);
  if (error) return { ok: false, error, notices };
  const printed = lines.some((o) => o !== undefined);
  const raw = (stderr.trim() || (printed ? "" : stdout.trim())).replace(/\s+/g, " ").slice(0, 300);
  return { ok: false, error: { code: "UNPARSEABLE", message: raw || (printed ? `mm printed an answer this could not read and exited with ${exitCode ?? "a signal"}` : `mm exited with ${exitCode ?? "a signal"} and said nothing`) }, notices };
}

function runMm(bin: string, args: string[], timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // SIGINT at the timeout: mm's headless runner turns it into its own ABORTED answer, where the default SIGTERM kills it mid-word
    const child = execFile(bin, args, { timeout: timeoutMs, killSignal: "SIGINT", env: process.env, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err?.code === "ENOENT") return reject(new MmError({ code: "ENOENT", message: `the mm command line is not installed on this machine (spawn ${bin} ENOENT)` }));
      const exit = !err ? 0 : typeof err.code === "number" ? err.code : null;
      const r = parseMm(String(stdout ?? ""), String(stderr ?? ""), exit);
      if (r.ok) return resolve(r.data);
      // stopped at the timeout without an answer of its own: a wallet job it started may still finish on MetaMask's side
      if (err?.killed && r.error.code === "UNPARSEABLE") return reject(new MmError({ code: "MM_TIMEOUT", message: `mm did not finish in ${Math.round(timeoutMs / 1000)} s` }, r.notices));
      reject(new MmError(r.error, r.notices));
    });
    child.stdin?.end();
  });
}

/** the real mm: argv elements, never a shell string; `--json` always, because a user's own `mm config set format` would otherwise win */
export const realMm =
  (bin = process.env.PORTFOLIO_MM_BIN ?? "mm", timeoutMs = 45_000): RunMm =>
  <T>(args: string[], opts?: { timeoutMs?: number }) =>
    runMm(bin, args.includes("--json") ? args : [...args, "--json"], opts?.timeoutMs ?? timeoutMs) as Promise<T>;

// ---- the source --------------------------------------------------------------------------------------

/** `price`: a dollar price for an earn vault's asset that is not a dollar stablecoin (live/prices.ts); without one, only stablecoin vaults
 * are valued, and money goes into no other */
export async function metamaskSource(req: { venue: string; label: string; run: RunMm; env?: Record<string, string | undefined> | undefined; now?: (() => number) | undefined; price?: Price | undefined; where?: Locator | undefined }): Promise<{ source: LiveSource & EarnSource; first: LiveBalance[] } | Refusal> {
  const name = req.label || "MetaMask Agent Wallet";
  const env = req.env ?? process.env;
  const voice = mmVoice(req.venue, req.run, env);
  let show: MmShow;
  try {
    show = await req.run<MmShow>(["wallet", "show"]);
  } catch (err) {
    // `mm wallet show` asks MetaMask's servers for the wallet and its policy: a network that does not reach them, a rate limit or a place
    // rule is told as what it is (saidNo), and only mm's own "not signed in" sends the owner to sign in again
    const f = voice.failureOf(err);
    const native = { command: "mm wallet show", code: f.code, said: voice.said(f.message) };
    if (f.code === "ENOENT") return no("E_ACCOUNT_CREDENTIAL", { venue: req.venue, message: "the mm command line is not installed on this machine", native });
    if (f.code === "UNSUPPORTED_NODE") return no("E_ACCOUNT_CREDENTIAL", { venue: req.venue, message: `mm could not run on this machine: ${native.said}`, native });
    if ((UNAUTHORIZED.has(f.code) && !/introspect failed with HTTP 5\d\d/i.test(f.message)) || SIGNED_OUT.has(f.code)) return no("E_ACCOUNT_CREDENTIAL", { venue: req.venue, message: "mm could not show the wallet: sign in with the mm command line first (mm wallet show must work in a terminal)", native });
    return voice.saidNo(f, "MetaMask", "show the wallet", ["wallet", "show"], "order");
  }
  const yaml = show.policyYaml ?? "";
  const rolling = /rolling_24h:\s*([\d.]+)/.exec(yaml)?.[1];
  const read = async (): Promise<LiveBalance[]> => {
    let b: MmBalance;
    try {
      b = await req.run<MmBalance>(["wallet", "balance"]);
    } catch (err) {
      throw voice.saidNo(voice.failureOf(err), "MetaMask", "read the balance", ["wallet", "balance"], "order");
    }
    return holdingsOf(b).map((h) => ({ asset: h.asset, amount: h.amount, usd: h.usd, ...(h.note ? { where: h.note } : {}) }));
  };
  try {
    const first = await read();
    const trader = mmTrader({ venue: req.venue, name, address: show.address, run: req.run, env, now: req.now ?? Date.now, where: req.where });
    const earner = mmEarner({ venue: req.venue, name, address: show.address, run: req.run, env, now: req.now ?? Date.now, price: req.price });
    const source: LiveSource & EarnSource = { name, kind: "agent-wallet", reference: "the mm command line's session on this machine", via: "MetaMask · mm command line", address: show.address, probe: { can: ["read", "transfer", "swap"], note: `MetaMask's Guard decides what goes out without asking (${rolling !== undefined ? `$${rolling} a rolling day` : "its policy"}); above that it asks you by email`, native: { address: show.address, tradingMode: show.tradingMode, rolling24h: rolling ?? null } }, read, writer: mmWriter(show.address as `0x${string}`, req.run, req.env, mmSendVoice("metamask", req.run, env)), trader, earner };
    return { source, first };
  } catch (err) {
    return err as Refusal;
  }
}

// ---- trading -------------------------------------------------------------------------------------------

/** how long mm waits for a wallet job (Guard's approval by email or MetaMask Mobile, signing, broadcast): its own maximum */
const WALLET_TIMEOUT_S = 600;
/** a write's child process outlives the wallet job by a minute, so that mm's own answer arrives rather than a kill */
export const MM_WRITE_TIMEOUT_MS = (WALLET_TIMEOUT_S + 60) * 1000;
const LIST_MS = 5 * 60_000;
/** a price market() read this recently is the one place() sizes a swap and bounds a market order by */
const FRESH_MS = 60_000;
/** mm's own default, sent anyway: the quote's minDestAssetAmount follows from it, and the chain enforces that */
const SLIPPAGE_PCT = "0.5";
/** a market order's worst price when the account sends none: the room account/live-orders.ts counts a market buy at */
const ROOM = 0.02;
/** a swap's price is quoted for about this many dollars */
const REF_USD = 100;
const NATIVE = /^0x0{40}$/i;
const SWAPS = "MetaMask's swaps";
const PM = "Polymarket";
/** the chains swapped on: those with a USDC whose address is pinned in chain.ts, so the dollar side of a swap is never found by its symbol */
const SWAP_CHAINS = (Object.keys(CHAINS) as ChainName[]).filter((c) => STABLECOINS.some((t) => t.chain === c && t.asset === "USDC"));
const usdcOn = (c: ChainName): string => STABLECOINS.find((t) => t.chain === c && t.asset === "USDC")!.address;
/** where to start: each chain's own coin, then the best-known tokens */
const WELL_KNOWN: Array<[ChainName, string]> = [
  ["Base", "ETH"], ["Ethereum", "ETH"], ["Arbitrum", "ETH"], ["Optimism", "ETH"], ["BNB Chain", "BNB"], ["Polygon", "POL"],
  ["Base", "cbBTC"], ["Ethereum", "WBTC"], ["Arbitrum", "WBTC"], ["Base", "WETH"], ["Ethereum", "WETH"], ["Arbitrum", "WETH"],
  ["Ethereum", "LINK"], ["Ethereum", "UNI"], ["Ethereum", "AAVE"], ["Arbitrum", "ARB"], ["Optimism", "OP"], ["Base", "AERO"],
  ["Polygon", "WETH"], ["BNB Chain", "BTCB"],
];
const SWAP_NOTE = "a swap your MetaMask Agent Wallet sends through MetaMask's swap API, at up to 0.5% slippage; prices are for about $100 and include MetaMask's fee, not the network fee. A swap is exact-input: a buy spends qty × ask in USDC and gets about qty. MetaMask's Guard may ask you to approve it first";
const PM_NOTE = "a Polymarket order through mm, paid in pUSD from your Predict deposit wallet (mm predict setup and a deposit come first). A limit order rests until canceled (GTC), post-only if you ask; IOC fills what it can at once and cancels the rest, FOK fills all at once or not at all; a market order is IOC at its worst price, or FOK. An IOC or FOK buy spends size × price and may get more shares. Polymarket's taker fee comes on top";
/** the times in force Polymarket takes through `mm predict place --order-type`, by the name each has there: GTC rests until canceled, FAK
 * fills what it can at once and cancels the rest (the account's IOC), FOK fills all at once or not at all. GTD is not offered: it needs an
 * expiry, which the account's order does not carry */
const PM_ORDER_TYPES: Partial<Record<TimeInForce, "GTC" | "FAK" | "FOK">> = { gtc: "GTC", ioc: "FAK", fok: "FOK" };
const PM_TIFS = Object.keys(PM_ORDER_TYPES) as TimeInForce[];
const HL = "Hyperliquid";
/** the smallest order Hyperliquid takes, in dollars of notional ("Order must have minimum value of $10") */
const HL_MIN_USD = 10;
/** Hyperliquid's price rule: at most five significant figures (a whole number always passes), and at most 6 − szDecimals decimals */
const HL_PRICE_DECIMALS = 6;
const PERP_NOTE = "a Hyperliquid perpetual through mm, margined in USDC in your Hyperliquid account (mm perps deposit comes first). A market order is Hyperliquid's IOC within the worst price; a limit order rests until canceled (GTC). It opens at the leverage set for it here (1x unless set); funding is paid or received every hour. Before every order the account holds this machine's place to Hyperliquid's own line (its Terms of Use §1.6)";
// Hyperliquid's own line (its Terms of Use §1.6: the United States, Ontario, the sanctioned territories) is one rule for every path to
// Hyperliquid, kept in location.ts (HYPERLIQUID_RULE, HL_TERMS); this path holds the place `mm predict geoblock` names to it (hlLine), and
// the account's own sources' when mm cannot say

const INSUFFICIENT = new Set(["INSUFFICIENT_FUNDS", "INSUFFICIENT_GAS", "INSUFFICIENT_BALANCE", "INSUFFICIENT_LP_BALANCE", "PREDICT_INSUFFICIENT_BALANCE", "PREDICT_INSUFFICIENT_FUNDING_BALANCE", "PREDICT_INSUFFICIENT_GAS"]);
const INVALID = new Set(["INVALID_AMOUNT", "INVALID_INPUT", "INVALID_SWAP_PARAMS", "AMOUNT_TOO_LOW", "AMOUNT_TOO_HIGH", "SLIPPAGE_TOO_HIGH", "SLIPPAGE_TOO_LOW", "TOKEN_NOT_FOUND", "TOKEN_NOT_SUPPORTED", "NATIVE_ASSET_UNSUPPORTED", "UNSUPPORTED_CHAIN", "REFUEL_UNSUPPORTED_ROUTE", "RWA_NATIVE_TOKEN_UNSUPPORTED", "INVALID_TICK_SIZE", "INVALID_ORDER_TYPE", "INVALID_SIDE", "PREDICT_ORDER_SIZE_TOO_SMALL", "MISSING_FLAG", "MISSING_SWAP_PARAMS", "MISSING_CHAIN", "INVALID_CHAIN", "INVALID_SYMBOL", "INVALID_SIZE", "INVALID_LEVERAGE", "INVALID_PRICE", "INVALID_SLIPPAGE", "AMBIGUOUS_VAULT"]);
const PERMISSION = new Set(["WRONG_WALLET_MODE", "TX_DENIED", "TX_EXPIRED", "PREDICT_SETUP_REQUIRED", "PREDICT_AUTH_REQUIRED", "PREDICT_INSUFFICIENT_ALLOWANCE"]);
const UNAUTHORIZED = new Set(["AUTH_FAILED", "AUTH_ERROR", "TOKEN_INVALID", "TOKEN_REFRESH_FAILED", "NOT_INITIALIZED", "PREDICT_AUTH_INVALID"]);
/** mm has no session on this machine at all: the owner signs in with mm */
const SIGNED_OUT = new Set(["MISSING_AUTH_TOKEN", "AUTH_REQUIRED"]);
/** a place rule of the venue's, for everything mm reaches there. MetaMask's RWA_GEO_RESTRICTED is not one: it is one asset's rule (saidNo) */
const REGION_CODES = new Set(["PREDICT_GEOBLOCKED", "PREDICT_UNAVAILABLE_FOR_LEGAL_REASONS"]);
const DOWN = new Set(["RATE_LIMITED", "NETWORK_UNREACHABLE", "NETWORK_TIMEOUT", "QUOTE_RETRY", "MM_TIMEOUT", "JOB_TIMEOUT", "ABORTED", "ENOENT", "UNSUPPORTED_NODE"]);
const UNKNOWN_ORDER = new Set(["QUOTE_NOT_FOUND", "MISSING_QUOTE_ID", "REQUEST_NOT_FOUND"]);
/** a swap mm stopped waiting for that MetaMask may still send: JOB_TIMEOUT and RELAY_TIMEOUT say "the job may still complete"; an execute
 * that ended with no envelope at all (killed, crashed) may have submitted its job too (trade spec 1.4) */
const MAY_LAND = new Set(["JOB_TIMEOUT", "RELAY_TIMEOUT", "MM_TIMEOUT", "ABORTED", "UNPARSEABLE"]);
/** a write whose connection dropped or timed out: mm 7.0.0's NETWORK_UNREACHABLE ("Could not reach the Polymarket endpoint (fetch failed).")
 * does not tell a connection refused before the request from one reset after it, so it may have landed; so may one a gateway answered
 * with a 5xx */
const LOST = new Set(["NETWORK_UNREACHABLE", "NETWORK_TIMEOUT"]);
const LOST_WORDS = /fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|other side closed|\b(?:bad gateway|service unavailable|gateway time-?out|internal server error)\b|\bHTTP 5\d\d\b|failed: 5\d\d\b/i;
/** mm's own failure of Polymarket's location check, which mm runs before anything is sent (`predict geoblock`, and `predict place`'s sign-in
 * step): "Polymarket check geoblock failed: <the HTTP reason>". The operation's name is mm's, not Polymarket's word about a place */
const CHECK_FAILED = /^Polymarket check geoblock failed: /i;
/** that check answered by a bare 403: the server in front of Polymarket refusing this network, by place or by the address's standing */
const CHECK_403 = /^Polymarket check geoblock failed: (?:Forbidden|403)\s*$/i;

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const short = (s: string): string => (s.length > 14 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s);
const sig = (x: number): number => Number(x.toPrecision(10));

interface Asset {
  symbol: string;
  address: string;
  decimals: number;
}

interface Quoted {
  id: string;
  src: Asset;
  dst: Asset;
  /** atomic, as mm converted what was asked */
  srcAtomic: bigint;
  /** what the wallet spends (MetaMask's fee inside it), what the quote pays, and the least it pays, which the chain enforces */
  spent: number;
  got: number;
  least: number;
  chains: number[];
  wallet: string;
  feeUsd: number | undefined;
  warnings: string[];
  native: Record<string, unknown>;
}

interface SwapSpot {
  kind: "swap";
  chain: ChainName;
  chainId: number;
  usdc: string;
  token: Asset & { native: boolean };
}
interface PmSpot {
  kind: "predict";
  tokenId: string;
  conditionId: string;
  tick: number;
  min: number;
}
/** a Hyperliquid perpetual as `mm perps markets` lists it: its coin, the decimals of a size, the most leverage it takes */
interface PerpSpot {
  kind: "perp";
  coin: string;
  szDecimals: number;
  maxLeverage: number | undefined;
  mark: number | undefined;
}
interface Seen {
  m: Market;
  at: number;
  spot: SwapSpot | PmSpot | PerpSpot;
}
interface PmInfo {
  slug: string;
  question: string;
  conditionId: string;
  outcomes: Array<{ name: string; tokenId: string; price: number }>;
  active: boolean;
  closed: boolean;
  accepting: boolean;
  orderBook: boolean;
  endDate: string;
  tick: number;
  min: number;
  at: number;
  /** what Gamma's market says beyond the order rules, which mm passes on: the pUSD traded in it in 24 hours (`volume24hr`, the market's,
   * which its outcomes share), the change of its price in 24 hours (`oneDayPriceChange`, absolute: the first outcome's, whose price
   * Gamma's market price is), and its event's category when the caller knows it */
  volume24h?: number | undefined;
  change24h?: number | undefined;
  category?: string | undefined;
}

type Parsed = { kind: "swap"; token: string; chain: ChainName } | { kind: "predict"; tokenId: string } | { kind: "predict"; slug: string; outcome: string } | { kind: "perp"; coin: string };

/** `<COIN>-PERP` (BTC-PERP, kPEPE-PERP): a perpetual on Hyperliquid's main market, by the coin's name there */
const PERP = /^([A-Za-z0-9]{1,20})-PERP$/i;

/** `ETH/USDC@Base` is a swap; `<slug>:<outcome>` or an outcome's token id is a Polymarket order; `BTC-PERP` a Hyperliquid perpetual */
function parseSymbol(venue: string, symbol: string): Parsed | Refusal {
  const s = symbol.trim();
  const pp = PERP.exec(s);
  if (pp) return { kind: "perp", coin: pp[1]! };
  // the token goes to mm as its own argv element after --to: one that starts with "-" would be read as a flag (--yes executes at once)
  const sw = /^([^/@\s-][^/@\s]*)\/([^/@\s]+)@(.+)$/.exec(s);
  if (sw) {
    const quote = sw[2]!;
    if (!inDollars(quote)) return no("E_ACCOUNT_UNPRICED", { venue, message: `${s} is priced in ${quote}: the account trades markets priced in dollars, so that every limit means dollars` });
    const chain = SWAP_CHAINS.find((c) => same(c, sw[3]!.trim()));
    if (quote.toUpperCase() !== "USDC" || !chain) return no("E_ACCOUNT_BAD_ACTION", { venue, message: `a swap here is a token against the chain's USDC: <TOKEN>/USDC@<chain>, on ${SWAP_CHAINS.join(", ")} (for example ETH/USDC@Base)` });
    return { kind: "swap", token: sw[1]!, chain };
  }
  if (/^\d{20,80}$/.test(s)) return { kind: "predict", tokenId: s };
  const pm = /^([a-z0-9][a-z0-9-]*):(.+)$/i.exec(s);
  if (pm) return { kind: "predict", slug: pm[1]!, outcome: pm[2]!.trim() };
  return no("E_ACCOUNT_BAD_ACTION", { venue, message: "a market here is a swap, <TOKEN>/USDC@<chain> (for example ETH/USDC@Base), a Polymarket outcome, <market slug>:<outcome> (for example will-it-rain-tomorrow:Yes), or a Hyperliquid perpetual, <COIN>-PERP (for example BTC-PERP)" });
}

/** a swap's id at mm is its quote id; the trade's hash, or the wallet job waiting for Guard's approval, rides after it */
const refOf = (quoteId: string, hash?: string, job?: string): string => (hash ? `${quoteId}?tx=${hash}` : job ? `${quoteId}?job=${job}` : quoteId);
function refParts(ref: string): { quoteId: string; tx: string | undefined; job: string | undefined } | undefined {
  const m = /^([^?\s]+)(?:\?(tx|job)=(\S+))?$/.exec(ref);
  return m ? { quoteId: m[1]!, tx: m[2] === "tx" ? m[3] : undefined, job: m[2] === "job" ? m[3] : undefined } : undefined;
}

/** Polymarket's POST /order answer gives makingAmount and takingAmount as strings, and whether they are decimals or 6-decimal base units is
 * not settled (its docs show placeholders, mm's own examples decimals). Read as decimals; an integer far larger than the order could be is
 * read as base units. */
function amountOf(v: unknown, what: "shares" | "usd", qty: number): number {
  const n = num(v);
  const integer = typeof v === "string" && !v.includes(".");
  return integer && n > qty * (what === "shares" ? 1e5 : 10) ? n / 1e6 : n;
}

/** both amounts of one answer are in the same unit. The dollars decide it: as a decimal they never exceed the order's shares (a price is
 * under 1), so an integer above that is base units, and so are the shares beside it (a small partial fill in base units would otherwise be
 * read as millions of shares). With no dollars, the shares are read alone */
function amountsOf(sharesV: unknown, usdV: unknown, qty: number): { shares: number; usd: number } {
  const usd = amountOf(usdV, "usd", qty);
  if (!(num(usdV) > 0)) return { shares: amountOf(sharesV, "shares", qty), usd };
  return { shares: usd !== num(usdV) ? num(sharesV) / 1e6 : num(sharesV), usd };
}

export interface MmTraderDeps {
  venue: string;
  name: string;
  address: string;
  run: RunMm;
  /** where this machine is, from the account's own sources (location.ts), for when mm cannot say: a network that blocks Polymarket blocks
   * `mm predict geoblock` too, and the users Hyperliquid serves there must not be refused for that */
  where?: Locator | undefined;
  /** where MetaMask's own switch is read: PORTFOLIO_MM_WRITES */
  env: Record<string, string | undefined>;
  now: () => number;
}

/** mm's language, as the trader and the earner both speak it: its failures read, its refusals turned into the account's (mm's own code and
 * words in `native`), MetaMask's own switch, and the BYOK secrets mm reads from its environment kept out of everything shown */
function mmVoice(venue: string, run: RunMm, env: Record<string, string | undefined>) {
  // the BYOK secrets mm reads from its environment (its skill: set MM_PASSWORD and MM_MNEMONIC rather than pass them inline)
  const secrets = [env.MM_PASSWORD, env.MM_MNEMONIC];
  // redacted before the whitespace is folded, so a secret over several lines is still found
  const said = (s: string): string => redact(s, secrets).replace(/\s+/g, " ").trim().slice(0, 240);
  const cmd = (args: string[]): string => `mm ${args.join(" ")}`;
  const writesOn = (): boolean => env.PORTFOLIO_MM_WRITES === "1";
  const off = (commands: string[][]): Refusal =>
    no("E_WALLET_LIVE_WRITES_OFF", { venue, message: `MetaMask's own switch is off (PORTFOLIO_MM_WRITES is not 1). ${commands.length > 1 ? "The commands that would run" : "The command that would run"}: ${commands.map(cmd).join(", then ")}`, detail: { commands: commands.map(cmd) } });

  const failureOf = (err: unknown): MmFailure & { notices: MmNotice[] } => {
    if (err instanceof MmError) return { code: err.code, message: err.said, hint: err.hint, notices: err.notices };
    const text = String((err as { message?: unknown })?.message ?? err);
    // the older runner (adapters/metamask.ts) put mm's error object into the message as JSON
    const j = obj(jsonOf(text));
    if (j && (j.code !== undefined || j.message !== undefined)) return { code: str(j.code) || "UNKNOWN", message: str(j.message), hint: str(j.hint) || undefined, notices: [] };
    return { code: /ENOENT/.test(text) ? "ENOENT" : "UNKNOWN", message: text, notices: [] };
  };

  /** mm's refusal as the account's, with mm's own code and words in `native` (and `extra`, what the caller read of the answer) */
  const saidNo = (f: MmFailure, who: string, doing: string, args: string[], when: "order" | "track", extra: Record<string, unknown> = {}): Refusal => {
    const words = said(f.message);
    const native = { command: cmd(args), code: f.code, said: words, ...(f.hint ? { hint: said(f.hint) } : {}), ...extra };
    const say = (code: Code, message: string): Refusal => no(code, { venue, message, native });
    const m = f.message;
    // a place rule keeps only mm's code: mm's words for one may name the place ("… not available in your region (<region>, <country>)"),
    // and its own name for what failed ("Polymarket check geoblock failed: …") is not a word about a place
    if (REGION_CODES.has(f.code) || REGION.test(m.replace(/^Polymarket [a-z ]+ failed: /i, ""))) return no("E_VENUE_GEOBLOCKED", { venue, message: `${who} does not serve this location: that is its own rule, and the account does not look for a way around it`, native: { command: cmd(args), code: f.code } });
    if (CHECK_403.test(m)) return no("E_VENUE_GEOBLOCKED", { venue, message: edgeWords(PM, 403, ""), native: { command: cmd(args), code: f.code, status: 403, edge: true } });
    // MetaMask will not swap this one asset from here (an RWA stock token's rule): that asset's no, in MetaMask's words — not the venue's
    // place, so nothing else mm reaches is held back for it
    if (f.code === "RWA_GEO_RESTRICTED") return say("E_VENUE_REJECTED", `${who} will not trade this asset from here: MetaMask says "${words}" — its own rule for this one asset, and the account does not look for a way around it`);
    // Polymarket holds this wallet to closing positions: a state of the wallet, as the CLOB connection reads it (polymarket-clob.ts), never
    // "does not serve this location" — sells still go
    if (/closed only mode/i.test(m)) return no("E_VENUE_PERMISSION", { venue, message: `${PM} holds this wallet to closing positions (its words: ${words}): a buy opens one, so nothing was placed; a sell of shares the wallet holds still goes`, native: { ...native, closeOnly: true } });
    if (INSUFFICIENT.has(f.code) || /insufficient (funds|balance|native balance|token balance|margin)|not enough balance/i.test(m)) return say("E_VENUE_INSUFFICIENT", `${who}: not enough to ${doing} (${words})`);
    if (f.code === "TX_DENIED" || f.code === "TX_EXPIRED") return say("E_VENUE_PERMISSION", `MetaMask's Guard asked you to approve this, and ${f.code === "TX_DENIED" ? "it was denied" : "the approval window passed"}: nothing was sent`);
    if (f.code === "PREDICT_SETUP_REQUIRED" || f.code === "PREDICT_AUTH_REQUIRED") return say("E_VENUE_PERMISSION", `the wallet is not set up to trade on ${PM}: run mm predict setup --wait in a terminal first`);
    if (f.code === "PREDICT_INSUFFICIENT_ALLOWANCE") return say("E_VENUE_PERMISSION", `the Predict deposit wallet has not allowed ${PM}'s exchange to use its funds: run mm predict approve --wait in a terminal`);
    if (PERMISSION.has(f.code) || /address banned/i.test(m)) return say("E_VENUE_PERMISSION", `${who} refused to ${doing}: ${words}`);
    // MetaMask's sign-in server failing (AUTH_ERROR "introspect failed with HTTP 5xx") is no answer, not a session that lapsed
    if (f.code === "AUTH_ERROR" && /introspect failed with HTTP 5\d\d/i.test(m)) return say("E_VENUE_UNREACHABLE", `MetaMask's sign-in server did not answer just now: try again in a minute`);
    if (UNAUTHORIZED.has(f.code) || /unauthori[sz]ed|invalid api key/i.test(m)) return say("E_VENUE_UNAUTHORIZED", who === PM ? `${PM} no longer accepts mm's trading credentials: run mm predict auth --refresh in a terminal` : "mm is not signed in, or MetaMask no longer accepts its session: sign in with mm in a terminal (mm wallet show must work)");
    if (f.code === "RWA_MARKET_UNAVAILABLE" || /not yet ready|no orderbook exists|cancel-only|post-only mode|trading is currently disabled/i.test(m)) return say("E_VENUE_MARKET_CLOSED", `${who} takes no orders here now: ${words}`);
    // a post-only order that would have taken at once is refused as written ("invalid post-only order: order crosses book")
    if (INVALID.has(f.code) || /invalid price|invalid tick size|tick size rule|align to tick|lower than the minimum|invalid expiration|invalid post-only order|crosses (the )?book|minimum value of \$/i.test(m)) return say("E_VENUE_ORDER_INVALID", `${who}: ${words}`);
    // an outage or a rate limit, in mm's words or the HTTP reason it passes on ("Polymarket fetch positions failed: Bad Gateway")
    if (DOWN.has(f.code) || /too many requests|HTTP (429|5\d\d)|order timed out|\b425\b|ECONNRESET|ETIMEDOUT|\b(?:service unavailable|bad gateway|gateway time-?out|internal server error)\b|failed: (?:429|5\d\d)\b/i.test(m)) return say("E_VENUE_UNREACHABLE", f.code === "ENOENT" || f.code === "UNSUPPORTED_NODE" ? `mm could not run on this machine: ${words}` : `${who} did not answer in time, or is limiting requests: try again in a minute`);
    if (when === "track" && (UNKNOWN_ORDER.has(f.code) || /invalid orderid|not found/i.test(m))) return say("E_ACCOUNT_ORDER_UNKNOWN", `${who} does not know this order: ${words}`);
    return say("E_VENUE_REJECTED", `${who} refused to ${doing}: ${words}`);
  };

  const call = async (args: string[], who: string, doing: string, when: "order" | "track", opts?: { timeoutMs?: number }): Promise<unknown> => {
    try {
      return await (opts ? run<unknown>(args, opts) : run<unknown>(args));
    } catch (err) {
      throw saidNo(failureOf(err), who, doing, args, when);
    }
  };
  const unread = (who: string, args: string[]): Refusal => no("E_VENUE_REJECTED", { venue, message: `${who} answered in a way this connection could not read`, native: { command: cmd(args) } });

  /** a wallet job mm stopped waiting for (Guard asking the owner, a timeout that may still land): its polling id, from mm's notices or words */
  const jobOf = (f: MmFailure & { notices: MmNotice[] }): string | undefined => f.notices.find((n) => str(n.pollingId))?.pollingId ?? /requests watch\s+([\w-]+)/.exec(`${f.hint ?? ""} ${f.message}`)?.[1] ?? /\(request ([\w-]+)\)/.exec(f.message)?.[1];
  /** is it a wallet job that may still go through, rather than a refusal: Guard's approval asked for, or mm stopped waiting */
  const mayLand = (f: MmFailure & { notices: MmNotice[] }): { mfa: boolean } | undefined => {
    const mfa = (f.code === "EXECUTE_FAILED" && /awaiting MFA approval/i.test(f.message)) || f.notices.some((n) => n.kind === "AWAITING_MFA");
    const noHash = f.code === "EXECUTE_FAILED" && /no hash is available yet/i.test(f.message);
    return MAY_LAND.has(f.code) || mfa || noHash ? { mfa } : undefined;
  };
  /** is it a write whose answer was lost on the way — mm stopped waiting, or the connection dropped or a gateway answered after mm sent
   * it — so that it may have been taken: never told as refused. A failure of the location check mm runs first sent nothing */
  const lost = (f: MmFailure): boolean => !CHECK_FAILED.test(f.message) && (MAY_LAND.has(f.code) || LOST.has(f.code) || LOST_WORDS.test(f.message));

  return { said, cmd, writesOn, off, failureOf, saidNo, call, unread, jobOf, mayLand, lost };
}

/** What a transfer mm was asked to send needs of mm's language (live/writes.ts mmWriter): whether a failure is a job that may still land (mm
 * stopped waiting, Guard is asking the owner) — then it is followed, never told as "not sent" — and, for one that may, how its wallet job
 * stands now (`mm wallet requests list`) */
export function mmSendVoice(venue: string, run: RunMm, env: Record<string, string | undefined>): MmSendVoice {
  const { failureOf, saidNo, call, jobOf, mayLand, said } = mmVoice(venue, run, env);
  return {
    mayLand(err) {
      const f = failureOf(err);
      const m = mayLand(f);
      return m ? { job: jobOf(f), code: f.code, said: said(f.message), mfa: m.mfa } : undefined;
    },
    refusal: (err, args) => saidNo(failureOf(err), "MetaMask", "send it", args, "order"),
    async landed(job) {
      let data: unknown;
      try {
        data = await call(["wallet", "requests", "list", "--json"], "MetaMask", `read wallet request ${job}`, "track");
      } catch {
        return "pending";
      }
      const j = arr(obj(data)?.requests)
        .map(obj)
        .find((x) => str(x?.pollingId) === job);
      const st = str(j?.status).toUpperCase();
      if (st === "DENIED" || st === "EXPIRED" || st === "FAILED" || st === "BROADCAST_FAILED") return "failed";
      return st === "COMPLETE" || st === "CONFIRMED" || (st !== "" && str(j?.txHash) !== "" && st !== "PENDING") ? "settled" : "pending";
    },
  };
}
export interface MmSendVoice {
  mayLand(err: unknown): { job?: string | undefined; code: string; said: string; mfa: boolean } | undefined;
  refusal(err: unknown, args: string[]): Refusal;
  landed(job: string): Promise<"pending" | "settled" | "failed">;
}

export function mmTrader(d: MmTraderDeps): LiveTrader & { kinds: MarketKind[]; positionsOf(symbol: string): Promise<Position[] | Refusal>; held(o: { side: "buy" | "sell"; reduceOnly?: boolean | undefined; symbol?: string | undefined }): Promise<Refusal | undefined> } {
  const { venue, run, env, now } = d;
  const { said, cmd, writesOn, off, failureOf, saidNo, call, unread, lost } = mmVoice(venue, run, env);
  /** an order mm sent whose answer was lost (lost above), and that could not be found taken: it may have been. Said as that — never as
   * refused — with what the owner looks at, and kept under its client id so the same order is not sent again */
  const unsure = (f: MmFailure, who: string, doing: string, args: string[], look: string, detail: Record<string, unknown> = { placed: "unknown" }): Refusal =>
    no("E_VENUE_UNREACHABLE", { venue, message: `${who} did not answer whether it took this (${doing}): it may have. Look at ${look} before asking again`, detail: { unsure: true, ...detail }, native: { command: cmd(args), code: f.code, said: said(f.message) } });
  /** when a resting order's row says it was made, in milliseconds (Polymarket's created_at is in seconds), or nothing */
  const madeAt = (v: unknown): number | undefined => {
    const n = known(v);
    return n === undefined || n <= 0 ? undefined : n > 1e12 ? n : n * 1000;
  };
  /** an order sent within this long of the answer being lost is the one found resting like it (clocks differ a little) */
  const SINCE_MS = 5_000;
  /** the venue ids this trader has already handed out: an order found resting like a lost one is never one the account already follows —
   * a second identical order would otherwise take the first one's id, and cancelling one would cancel the other */
  const handedOut = new Set<string>();

  const seen = new Map<string, Seen>();
  const infos = new Map<string, PmInfo>();
  /** what place() knew of a swap, for reading its fill: lost on a restart, when mm's own legs are read instead */
  const swaps = new Map<string, { side: "buy" | "sell"; qty: number; spent: number; feeUsd: number | undefined }>();
  /** mm takes no client order id (7.0.0), so the account's id is honoured here: a retry with it is the same order, not a second one */
  const placing = new Map<string, Promise<OrderState | Refusal>>();
  let chains: { at: number; list: ChainName[] } | undefined;

  // ---- swaps -------------------------------------------------------------------------------------

  /** never `--yes` (it executes at once) and never `--all-quotes` (each alternative is executable too) */
  const quoteArgs = (from: string, to: string, amount: string, chainId: number): string[] => ["swap", "quote", "--from", from, "--to", to, "--amount", amount, "--from-chain-id", String(chainId), "--slippage", SLIPPAGE_PCT, "--json"];

  const assetOf = (v: unknown): Asset | undefined => {
    const o = obj(v);
    const decimals = Number(o?.decimals);
    return o && str(o.address) && Number.isInteger(decimals) ? { symbol: str(o.symbol), address: str(o.address), decimals } : undefined;
  };
  const human = (atomic: unknown, decimals: number): number => {
    try {
      return Number(formatUnits(BigInt(str(atomic)), decimals));
    } catch {
      return NaN;
    }
  };

  async function quote(args: string[], doing: string): Promise<Quoted | Refusal> {
    let data: unknown;
    try {
      data = await call(args, SWAPS, doing, "order");
    } catch (r) {
      return r as Refusal;
    }
    const x = obj(data);
    // a soft "no quote": exit 0 and an ok envelope, with MetaMask's reason in place of a quote id
    if (x?.kind === "unavailable") return saidNo({ code: str(x.reason) || "NO_QUOTES", message: str(x.message) || "no route", hint: str(x.hint) || undefined }, SWAPS, doing, args, "order");
    const req = obj(x?.request);
    const q = obj(x?.quote);
    const src = assetOf(req?.srcAsset);
    const dst = assetOf(req?.destAsset);
    if (!x || !str(x.quoteId) || !req || !q || !src || !dst) return unread(SWAPS, args);
    let srcAtomic: bigint;
    try {
      srcAtomic = BigInt(str(req.srcAssetAmount));
    } catch {
      return unread(SWAPS, args);
    }
    const spent = human(req.srcAssetAmount, src.decimals);
    const got = human(q.destAssetAmount, dst.decimals);
    const least = human(q.minDestAssetAmount, dst.decimals);
    if (!(spent > 0 && got > 0 && least > 0)) return unread(SWAPS, args);
    // MetaMask's fee, and a gasless relay's, in dollars where the quote says so; the network fee is in the chain's coin and is left out
    const fees = [obj(obj(q.feeData)?.metabridge)?.usd, obj(obj(q.gasIncludedBreakdown)?.gaslessRelayFee)?.usd].filter((v) => v !== undefined && v !== null && str(v) !== "");
    const feeUsd = fees.length ? sig(fees.reduce<number>((s, v) => s + num(v), 0)) : undefined;
    const warnings = arr(x.warnings).map(str).filter(Boolean);
    return {
      id: str(x.quoteId),
      src,
      dst,
      srcAtomic,
      spent,
      got,
      least,
      chains: [num(req.srcChainId), num(req.destChainId)],
      wallet: str(req.walletAddress),
      feeUsd,
      warnings,
      native: { quoteId: str(x.quoteId), spend: `${plain(spent)} ${src.symbol}`, get: `${plain(got)} ${dst.symbol}`, least: `${plain(least)} ${dst.symbol}`, route: arr(q.protocols).map(str).join(" + "), ...(feeUsd !== undefined ? { feeUsd } : {}), ...(warnings.length ? { warnings } : {}) },
    };
  }

  /** what mm resolved is what was asked: the chain, both tokens, the amount and this wallet. Anything else is not swapped */
  function mismatch(q: Quoted, want: { chainId: number; src: { address?: string; symbol?: string }; dst: { address?: string; symbol?: string }; amount: string }, args: string[]): Refusal | undefined {
    const fits = (a: Asset, w: { address?: string; symbol?: string }) => (w.address === undefined || same(a.address, w.address)) && (w.symbol === undefined || same(a.symbol, w.symbol));
    let asked: bigint | undefined;
    try {
      asked = parseUnits(want.amount, q.src.decimals);
    } catch {
      asked = undefined;
    }
    const diff = asked === undefined ? undefined : asked > q.srcAtomic ? asked - q.srcAtomic : q.srcAtomic - asked;
    const ok = q.chains.every((c) => c === want.chainId) && fits(q.src, want.src) && fits(q.dst, want.dst) && (q.wallet === "" || same(q.wallet, d.address)) && diff !== undefined && diff <= 1n;
    if (ok) return undefined;
    return no("E_VENUE_REJECTED", { venue, message: `mm quoted something other than what was asked (${q.native.spend} for ${q.dst.symbol} ${short(q.dst.address)}, chain ${q.chains.join("→")}): nothing was swapped`, native: { command: cmd(args), asked: want, quoted: { src: q.src, dst: q.dst, chains: q.chains, wallet: q.wallet, srcAtomic: String(q.srcAtomic) } } });
  }

  async function swapMarket(p: { token: string; chain: ChainName }): Promise<Market | Refusal> {
    const chainId = CHAINS[p.chain].chain.id;
    const usdc = usdcOn(p.chain);
    // the ask: what $100 of USDC buys; the bid: what that much of the token sells for. Two quotes; neither moves anything
    const askArgs = quoteArgs(usdc, p.token, plain(REF_USD), chainId);
    const a = await quote(askArgs, `price ${p.token} on ${p.chain}`);
    if (isRefusal(a)) return a;
    const badA = mismatch(a, { chainId, src: { address: usdc }, dst: { symbol: p.token }, amount: plain(REF_USD) }, askArgs);
    if (badA) return badA;
    const token = { ...a.dst, native: NATIVE.test(a.dst.address) };
    const ask = a.spent / a.got;
    const step = 10 ** -Math.min(token.decimals, 8);
    const probe = plain(floorTo(REF_USD / ask, step));
    const bidArgs = quoteArgs(token.native ? token.symbol : token.address, usdc, probe, chainId);
    const b = await quote(bidArgs, `price ${token.symbol} on ${p.chain}`);
    if (isRefusal(b)) return b;
    const badB = mismatch(b, { chainId, src: { address: token.address }, dst: { address: usdc }, amount: probe }, bidArgs);
    if (badB) return badB;
    const bid = b.got / b.spent;
    const warnings = [...new Set([...a.warnings, ...b.warnings])];
    const m: Market = { symbol: `${token.symbol}/USDC@${p.chain}`, name: `${token.symbol} on ${p.chain}${token.native ? "" : ` (${short(token.address)}, as MetaMask resolves it)`}`, kind: "token", base: token.symbol, quote: "USDC", price: sig((bid + ask) / 2), bid: sig(bid), ask: sig(ask), qtyStep: step, open: true, note: warnings.length ? `${SWAP_NOTE}. MetaMask warns: ${warnings.join(" ")}` : SWAP_NOTE, types: ["market"] };
    seen.set(m.symbol.toUpperCase(), { m, at: now(), spot: { kind: "swap", chain: p.chain, chainId, usdc, token } });
    return m;
  }

  async function placeSwap(o: OrderRequest, s: Seen & { spot: SwapSpot }): Promise<OrderState | Refusal> {
    const { m, spot } = s;
    if (o.type !== "market" || o.stopPrice !== undefined) return badOrder(venue, SWAPS, "a swap is a market order: mm takes no limit or stop price");
    // nothing more to choose: a swap lands whole on chain or reverts, and mm takes no time in force, post-only or reduce-only for it
    if (o.tif !== undefined || o.postOnly || o.reduceOnly) return badOrder(venue, SWAPS, "a swap takes no time in force, post-only or reduce-only: it lands whole on chain, or reverts");
    if (!(o.qty > 0) || !onStep(o.qty, m.qtyStep)) return badOrder(venue, SWAPS, `a size of ${m.base} moves in steps of ${plain(m.qtyStep ?? 0)}`, { qtyStep: m.qtyStep });
    const sell = o.side === "sell";
    const tokenArg = spot.token.native ? spot.token.symbol : spot.token.address;
    // exact-input: a sell spends exactly qty of the token; a buy spends qty × ask in USDC (to the cent's ten-thousandth), and gets about qty
    const amount = sell ? plain(o.qty) : plain(floorTo(o.qty * m.ask!, 1e-6), 6);
    if (!(Number(amount) > 0)) return badOrder(venue, SWAPS, `${plain(o.qty)} ${m.base} is too small to swap`);
    const worst = o.worstPrice ?? (sell ? m.bid! * (1 - ROOM) : m.ask! * (1 + ROOM));
    const qArgs = quoteArgs(sell ? tokenArg : spot.usdc, sell ? spot.usdc : tokenArg, amount, spot.chainId);
    if (!writesOn()) return off([qArgs, ["swap", "execute", "--quote-id", "<that quote's quoteId>", "--wallet-timeout", String(WALLET_TIMEOUT_S), "--json"]]);
    const q = await quote(qArgs, `${o.side} ${plain(o.qty)} ${m.base} on ${spot.chain}`);
    if (isRefusal(q)) return q;
    const bad = mismatch(q, sell ? { chainId: spot.chainId, src: { address: spot.token.address }, dst: { address: spot.usdc }, amount } : { chainId: spot.chainId, src: { address: spot.usdc }, dst: { address: spot.token.address }, amount }, qArgs);
    if (bad) return bad;
    // the least the quote pays is enforced on chain: it is what keeps the fill inside the worst price
    const atWorst = sell ? q.least / o.qty : q.spent / q.least;
    if (sell ? atWorst < worst * (1 - 1e-9) : atWorst > worst * (1 + 1e-9)) {
      return no("E_ACCOUNT_REQUOTE", { venue, message: `the price moved: at worst this swap ${sell ? "sells" : "buys"} at ${plain(sig(atWorst))} USDC per ${m.base}, ${sell ? "under" : "over"} the ${plain(sig(worst))} allowed. Nothing was swapped`, detail: { worstPrice: worst, atWorst }, native: { command: cmd(qArgs), quote: q.native } });
    }
    const args = ["swap", "execute", "--quote-id", q.id, "--wallet-timeout", String(WALLET_TIMEOUT_S), "--json"];
    swaps.set(q.id, { side: o.side, qty: o.qty, spent: q.spent, feeUsd: q.feeUsd });
    let data: unknown;
    try {
      data = await run<unknown>(args, { timeoutMs: MM_WRITE_TIMEOUT_MS });
    } catch (err) {
      return swapStuck(failureOf(err), q, args);
    }
    const x = obj(data);
    const legs = arr(x?.transactions).map(obj);
    const hash = str(legs.find((t) => t?.kind === "trade")?.txHash);
    const job = str(obj(x?.pendingJob)?.pollingId);
    // submitted is a broadcast, not a confirmation: the swap is pending until mm swap status says COMPLETE
    return {
      ref: refOf(q.id, hash || undefined, job || undefined),
      status: "pending",
      filledQty: 0,
      ...(q.feeUsd !== undefined ? { feeUsd: q.feeUsd } : {}),
      native: { command: cmd(args), quote: q.native, answer: { status: str(x?.status), route: str(x?.route), transactions: legs.map((t) => ({ kind: str(t?.kind), txHash: str(t?.txHash), chainId: num(t?.chainId) })), ...(job ? { pollingId: job } : {}) } },
    };
  }

  /** an execute mm stopped waiting for: Guard is asking the owner, or the job may still finish — or the connection dropped after it was
   * sent. It is pending, never refused, so it is not sent twice: its quote id is followed (mm swap status) */
  function swapStuck(f: MmFailure & { notices: MmNotice[] }, q: Quoted, args: string[]): OrderState | Refusal {
    const mfa = (f.code === "EXECUTE_FAILED" && /awaiting MFA approval/i.test(f.message)) || f.notices.some((n) => n.kind === "AWAITING_MFA");
    const noHash = f.code === "EXECUTE_FAILED" && /no hash is available yet/i.test(f.message);
    if (!lost(f) && !(f.code === "EXECUTE_FAILED" && (mfa || noHash))) return saidNo(f, SWAPS, `swap ${q.native.spend} for ${q.dst.symbol}`, args, "order");
    const job = f.notices.find((n) => str(n.pollingId))?.pollingId ?? /requests watch\s+([\w-]+)/.exec(`${f.hint ?? ""} ${f.message}`)?.[1] ?? /\(request ([\w-]+)\)/.exec(f.message)?.[1];
    return {
      ref: refOf(q.id, undefined, job),
      status: "pending",
      filledQty: 0,
      ...(q.feeUsd !== undefined ? { feeUsd: q.feeUsd } : {}),
      native: { command: cmd(args), quote: q.native, waiting: mfa ? "MetaMask's Guard asked you to approve this swap, by email or on MetaMask Mobile: it goes when you approve it" : MAY_LAND.has(f.code) ? "mm stopped waiting before it saw the swap sent: MetaMask may still send it" : "the connection dropped after the swap was sent: MetaMask may still send it", code: f.code, said: said(f.message), ...(job ? { pollingId: job } : {}) },
    };
  }

  async function swapStatus(ref: string, symbol: string, again = true): Promise<OrderState | Refusal> {
    const r = refParts(ref);
    if (!r) return no("E_ACCOUNT_ORDER_UNKNOWN", { venue, message: `${ref} is not a swap mm made` });
    const args = ["swap", "status", "--quote-id", r.quoteId, ...(r.tx ? ["--tx-hash", r.tx] : []), "--json"];
    let data: unknown;
    try {
      data = await call(args, SWAPS, `read swap ${short(r.quoteId)}`, "track");
    } catch (e) {
      return isRefusal(e) ? e : asRefusal(venue, "MetaMask", e);
    }
    const x = obj(data);
    const st = str(x?.status).toUpperCase();
    const legs = arr(x?.transactions).map(obj);
    const trade = legs.find((l) => l?.kind === "trade");
    const recv = legs.find((l) => l?.kind === "receive");
    const hash = str(trade?.txHash);
    const native: Record<string, unknown> = { command: cmd(args), answer: { status: st, legs: legs.map((l) => ({ kind: str(l?.kind), status: str(l?.status), txHash: str(l?.txHash), amount: str(l?.amount), asset: str(l?.assetSymbol) })) } };
    const base = { ref: !r.tx && hash ? refOf(r.quoteId, hash) : ref, native };
    switch (st) {
      case "COMPLETE": {
        const memo = swaps.get(r.quoteId);
        const p = parseSymbol(venue, symbol);
        const usdc = !isRefusal(p) && p.kind === "swap" ? usdcOn(p.chain) : "";
        const buy = memo ? memo.side === "buy" : same(str(trade?.assetSymbol), "USDC") || (usdc !== "" && same(str(trade?.assetAddress), usdc));
        const out = num(trade?.amount);
        const back = num(recv?.amount);
        const filledQty = buy ? back || (memo?.qty ?? 0) : (memo?.qty ?? out);
        const usd = buy ? (memo?.spent ?? out) : back;
        // for a swap on one chain, mm may report the QUOTED amount received rather than the filled one; the least was enforced on chain
        native.received = "as mm reports it: on one chain this can be the quoted amount, never under the quote's minimum";
        return { ...base, status: "filled", filledQty, ...(filledQty > 0 && usd > 0 ? { avgPrice: sig(usd / filledQty) } : {}), ...(memo?.feeUsd !== undefined ? { feeUsd: memo.feeUsd } : {}) };
      }
      case "FAILED":
        return { ...base, status: "rejected", filledQty: 0 };
      case "PENDING":
      case "SUBMITTED":
        return { ...base, status: "open", filledQty: 0 };
      case "QUOTED":
        return r.job ? jobStatus(r.quoteId, r.job, symbol, base, again) : { ...base, status: "pending", filledQty: 0 };
      default:
        // UNKNOWN, and anything mm adds: still on its way as far as anyone can tell
        return { ...base, status: "pending", filledQty: 0 };
    }
  }

  /** the swap's wallet job, by its polling id: `mm wallet requests list` (server-wallet mode) */
  async function jobStatus(quoteId: string, pollingId: string, symbol: string, base: { ref: string; native: Record<string, unknown> }, again: boolean): Promise<OrderState | Refusal> {
    const args = ["wallet", "requests", "list", "--json"];
    let data: unknown;
    try {
      data = await call(args, "MetaMask", `read wallet request ${pollingId}`, "track");
    } catch (e) {
      return isRefusal(e) ? e : asRefusal(venue, "MetaMask", e);
    }
    const job = arr(obj(data)?.requests)
      .map(obj)
      .find((j) => str(j?.pollingId) === pollingId);
    if (!job) return { ...base, status: "pending", filledQty: 0 };
    const js = str(job.status).toUpperCase();
    const hash = str(job.txHash);
    const intent = str(obj(job.intent)?.summary);
    const native = { ...base.native, job: { pollingId, status: js, ...(hash ? { txHash: hash } : {}), ...(intent ? { intent } : {}) } };
    if (js === "DENIED") return { ...base, native, status: "rejected", filledQty: 0 };
    if (js === "EXPIRED") return { ...base, native, status: "expired", filledQty: 0 };
    if (js === "FAILED" || js === "BROADCAST_FAILED") return { ...base, native, status: "rejected", filledQty: 0 };
    // the trade's own job sent its transaction: from here the swap is read by that hash (an approval's hash is not the trade's)
    if (hash && again && !/^approve\b/i.test(intent)) return swapStatus(refOf(quoteId, hash), symbol, false);
    return { ...base, native, status: "pending", filledQty: 0 };
  }

  // ---- prediction orders -----------------------------------------------------------------------

  const listOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : typeof v === "string" ? arr(jsonOf(v)) : []);
  /** mm folds Gamma's three JSON-encoded lists into outcomes: [{name, price, tokenId}]; Gamma's own shape is read too */
  const outcomesOf = (m: Record<string, unknown>): PmInfo["outcomes"] => {
    const folded = arr(m.outcomes).map(obj);
    if (folded.length && folded.every((o) => o && str(o.tokenId))) return folded.map((o) => ({ name: str(o!.name), tokenId: str(o!.tokenId), price: num(o!.price) }));
    const names = listOf(m.outcomes);
    const ids = listOf(m.clobTokenIds);
    const prices = listOf(m.outcomePrices);
    return names.map((n, i) => ({ name: str(n), tokenId: str(ids[i]), price: num(prices[i]) })).filter((o) => o.tokenId !== "");
  };

  /** one Gamma market as mm passes it on (`markets get`, and each market of `events list`) */
  const infoOf = (m: Record<string, unknown>, category?: string): PmInfo => {
    const volume24h = known(m.volume24hr);
    const change24h = known(m.oneDayPriceChange);
    return { slug: str(m.slug), question: str(m.question) || str(m.slug), conditionId: str(m.conditionId), outcomes: outcomesOf(m), active: m.active === true, closed: m.closed === true, accepting: m.acceptingOrders !== false, orderBook: m.enableOrderBook !== false, endDate: str(m.endDate), tick: num(m.orderPriceMinTickSize), min: num(m.orderMinSize), at: now(), ...(volume24h !== undefined && volume24h >= 0 ? { volume24h } : {}), ...(change24h !== undefined ? { change24h } : {}), ...(category ? { category } : {}) };
  };
  /** what a Polymarket outcome's market says beyond its order rules, as the account's market fields: the change only on the first outcome,
   * the question its outcomes share by its condition id */
  const pmExtra = (info: PmInfo, i: number, outcome: string): Partial<Market> => ({
    ...(i === 0 && info.change24h !== undefined ? { change24h: info.change24h } : {}),
    ...(info.volume24h !== undefined ? { volumeUsd24h: info.volume24h } : {}),
    ...(info.endDate ? { closeTime: info.endDate } : {}),
    ...(info.category ? { category: info.category } : {}),
    group: { id: info.conditionId, title: info.question },
    outcome,
  });

  /** `mm predict markets get --market <slug | id | condition id>`: kept five minutes for lookups, asked again for a fresh market */
  async function pmInfo(key: string, fresh: boolean): Promise<PmInfo | Refusal> {
    const hit = infos.get(key.toLowerCase());
    if (hit && !fresh && now() - hit.at < LIST_MS) return hit;
    const args = ["predict", "markets", "get", "--market", key, "--json"];
    let data: unknown;
    try {
      data = await call(args, PM, `look up ${key}`, "order");
    } catch (e) {
      return isRefusal(e) ? e : asRefusal(venue, "MetaMask", e);
    }
    const m = obj(obj(obj(data)?.result)?.market);
    if (!m) return unread(PM, args);
    const info = infoOf(m);
    if (!info.conditionId || !info.outcomes.length) return unread(PM, args);
    for (const k of [key, info.slug, info.conditionId, ...info.outcomes.map((o) => o.tokenId)]) if (k) infos.set(k.toLowerCase(), info);
    return info;
  }

  /** `mm predict book <token id>`: the CLOB's book for one outcome. Bids and asks are read for their best, whatever their order */
  async function pmBook(tokenId: string): Promise<{ bid: number | undefined; ask: number | undefined; last: number | undefined; tick: number; min: number; market: string } | Refusal> {
    const args = ["predict", "book", tokenId, "--json"];
    let data: unknown;
    try {
      data = await call(args, PM, `read the book of ${short(tokenId)}`, "order");
    } catch (e) {
      return isRefusal(e) ? e : asRefusal(venue, "MetaMask", e);
    }
    const b = obj(obj(obj(data)?.result)?.book);
    if (!b) return unread(PM, args);
    const prices = (side: unknown) => arr(side).map((l) => num(obj(l)?.price)).filter((p) => p > 0 && p < 1);
    const bids = prices(b.bids);
    const asks = prices(b.asks);
    return { bid: bids.length ? Math.max(...bids) : undefined, ask: asks.length ? Math.min(...asks) : undefined, last: num(b.last_trade_price) || undefined, tick: num(b.tick_size), min: num(b.min_order_size), market: str(b.market) };
  }

  /** why the account takes no order in it: Polymarket's own flags, and an end date already passed (the window before resolution) */
  const whyClosed = (info: PmInfo): string | undefined =>
    info.closed ? `${PM} has closed this market` : !info.active ? `${PM} lists this market as inactive` : !info.accepting || !info.orderBook ? `${PM} is not accepting orders in this market now` : info.endDate && Date.parse(info.endDate) <= now() ? `its end date (${info.endDate}) has passed: it is waiting for resolution, when trading it is high-risk, so the account does not` : undefined;

  async function pmMarket(p: { tokenId: string } | { slug: string; outcome: string }): Promise<Market | Refusal> {
    let info: PmInfo | Refusal;
    let tokenId: string;
    let book: Awaited<ReturnType<typeof pmBook>>;
    if ("tokenId" in p) {
      tokenId = p.tokenId;
      book = await pmBook(tokenId);
      if (isRefusal(book)) return book;
      if (!book.market) return no("E_VENUE_REJECTED", { venue, message: `${PM}'s book for ${short(tokenId)} names no market` });
      info = await pmInfo(book.market, true);
      if (isRefusal(info)) return info;
    } else {
      info = await pmInfo(p.slug, true);
      if (isRefusal(info)) return info;
      const o = info.outcomes.find((x) => same(x.name, p.outcome));
      if (!o) return no("E_ACCOUNT_BAD_ACTION", { venue, message: `${PM}'s market ${p.slug} has the outcomes ${info.outcomes.map((x) => x.name).join(", ")}, not ${p.outcome}` });
      tokenId = o.tokenId;
      book = await pmBook(tokenId);
      if (isRefusal(book)) return book;
    }
    const outcome = info.outcomes.find((x) => x.tokenId === tokenId);
    if (!outcome) return no("E_VENUE_REJECTED", { venue, message: `${short(tokenId)} is not one of the outcomes of ${PM}'s market ${info.slug || info.conditionId}` });
    // the CLOB's tick and minimum are the ones it enforces, and a tick can change during a market's life: read with every price
    const tick = book.tick || info.tick;
    const min = book.min || info.min;
    if (!(tick > 0 && tick < 1)) return no("E_VENUE_REJECTED", { venue, message: `${PM} gave no price tick for ${info.question}`, native: { tokenId } });
    const why = whyClosed(info);
    const price = book.bid !== undefined && book.ask !== undefined ? (book.bid + book.ask) / 2 : (book.last ?? (outcome.price || undefined));
    const symbol = info.slug ? `${info.slug}:${outcome.name}` : tokenId;
    // what mm predict place takes here: GTC, IOC (FAK) and FOK, and --post-only; no reduce-only flag and no leverage, so neither is said
    // a sell can only be of shares the deposit wallet holds: it closes a position, never opens one the other way (sellsReduce)
    const m: Market = { symbol, name: `${info.question} · ${outcome.name}`, kind: "event", base: outcome.name, quote: "pUSD", price: price !== undefined ? sig(price) : undefined, bid: book.bid, ask: book.ask, minQty: min || undefined, qtyStep: 0.01, priceStep: tick, open: why === undefined, note: why ?? PM_NOTE, types: ["limit", "market"], tifs: [...PM_TIFS], postOnly: true, sellsReduce: true, ...pmExtra(info, info.outcomes.indexOf(outcome), outcome.name) };
    seen.set(symbol.toUpperCase(), { m, at: now(), spot: { kind: "predict", tokenId, conditionId: info.conditionId, tick, min } });
    return m;
  }

  /** `mm predict geoblock`: Polymarket's own check of where this machine is, read with Polymarket's own lists (polymarketScope). Blocked
   * completely is no, and nothing else is asked; close-only lets a sell go (shares the wallet holds: it closes a position) and not a buy */
  async function geoblock(args: string[], side: "buy" | "sell"): Promise<Refusal | undefined> {
    let data: unknown;
    try {
      data = await run<unknown>(args);
    } catch (err) {
      // the check's own failure is read by mm's code, never by its words: "Polymarket check geoblock failed: Service Unavailable" names the
      // operation, not a place, and mm's region words name the place. Only mm's code is kept
      const f = failureOf(err);
      const native = { command: cmd(args), code: f.code };
      if (REGION_CODES.has(f.code)) return no("E_VENUE_GEOBLOCKED", { venue, message: `${PM} does not serve this location (as mm says): that is its own rule, and the account does not look for a way around it. Nothing was placed`, native });
      if (CHECK_403.test(f.message)) return no("E_VENUE_GEOBLOCKED", { venue, message: `${edgeWords(PM, 403, "")}. Nothing was placed`, native: { ...native, status: 403, edge: true } });
      if (f.code === "ENOENT" || f.code === "UNSUPPORTED_NODE" || UNAUTHORIZED.has(f.code) || SIGNED_OUT.has(f.code)) return saidNo(f, PM, "say whether it serves this location", args, "order");
      // an outage, a rate limit, a dropped connection, an answer mm could not read: no answer, and no answer is not a yes
      return no("E_VENUE_UNREACHABLE", { venue, message: `${PM}'s location check did not answer: nothing goes to Polymarket without it`, native });
    }
    const g = obj(obj(data)?.result) ?? obj(data);
    // the IP and the place mm reports are left out of everything kept: a refusal is logged and lands in the ledger
    const scope = polymarketScope(g);
    if (scope === "blocked") return no("E_VENUE_GEOBLOCKED", { venue, message: `${PM} does not take orders from this location (as mm predict geoblock says): that is its own rule, and the account does not look for a way around it. Nothing was placed`, native: { command: cmd(args), blocked: true } });
    if (scope === "close-only" && side === "buy") return no("E_VENUE_GEOBLOCKED", { venue, message: `${CLOSE_ONLY_WORDS} (as mm predict geoblock says). A buy opens a position, so nothing was placed; a sell of shares the wallet holds closes one`, native: { command: cmd(args), blocked: true, closeOnly: true } });
    if (scope === undefined) return no("E_VENUE_UNREACHABLE", { venue, message: `${PM}'s location check did not answer (mm did not say whether ${PM} serves this location): nothing goes to Polymarket without it`, native: { command: cmd(args) } });
    return undefined;
  }

  /** the order type mm sends Polymarket, or why there is none. A limit order rests (GTC) unless IOC or FOK is asked, at its limit; a market
   * order fills at once, FAK unless FOK is asked, at its worst price. Post-only is for an order that rests: mm refuses --post-only with FOK
   * or FAK, so it is refused here first, before Polymarket's region check or anything else is asked */
  function pmOrderType(o: OrderRequest): "GTC" | "FAK" | "FOK" | Refusal {
    const tif = o.tif ?? (o.type === "market" ? "ioc" : "gtc");
    // its own keys only: "constructor" is not a time in force, and nothing but GTC, FAK or FOK reaches mm's argv
    const ot = Object.hasOwn(PM_ORDER_TYPES, tif) ? PM_ORDER_TYPES[tif] : undefined;
    const names = PM_TIFS.map((t) => t.toUpperCase());
    if (!ot) return badOrder(venue, PM, `mm places ${names.slice(0, -1).join(", ")} or ${names.at(-1)} orders here, not ${String(tif).toUpperCase()}`);
    if (o.type === "market" && ot === "GTC") return badOrder(venue, PM, "a market order fills at once (IOC or FOK): only a limit order rests until canceled");
    if (o.postOnly && o.type !== "limit") return badOrder(venue, PM, "post-only is for a limit order");
    if (o.postOnly && ot !== "GTC") return badOrder(venue, PM, `a post-only order rests on the book or is refused, and ${tif.toUpperCase()} never rests: mm takes --post-only only for an order that rests (GTC)`);
    return ot;
  }

  async function placePm(o: OrderRequest, s: Seen & { spot: PmSpot }): Promise<OrderState | Refusal> {
    const { m, spot } = s;
    const { tick, min, tokenId } = spot;
    // Polymarket through mm takes a limit or a market order, never a stop, and mm has no reduce-only flag for it
    if (o.type !== "limit" && o.type !== "market") return badOrder(venue, PM, `mm places limit and market orders here, not ${String(o.type).replace("_", "-")} orders`);
    if (o.stopPrice !== undefined) return badOrder(venue, PM, "mm places no stop orders here, so an order carries no stop price");
    if (o.reduceOnly) return badOrder(venue, PM, "mm takes no reduce-only flag for an order here");
    const ot = pmOrderType(o);
    if (isRefusal(ot)) return ot;
    if (!(o.qty > 0) || !onStep(o.qty, 0.01)) return badOrder(venue, PM, "a size is in shares, in steps of 0.01", { qtyStep: 0.01 });
    if (min > 0 && o.qty < min - 1e-9) return badOrder(venue, PM, `the smallest order in ${m.name} is ${plain(min)} shares`, { minQty: min });
    // the price mm is sent: a limit order's limit (where it rests, or the worst an IOC or FOK fill may take), or a market order's worst price,
    // snapped to the tick on the safe side. An IOC or FOK buy spends size × price, and may get more shares
    let price: number;
    if (o.type === "limit") {
      price = o.limitPrice ?? NaN;
      if (!(price > 0) || !onStep(price, tick)) return badOrder(venue, PM, `a price in ${m.name} moves in steps of ${plain(tick)}`, { priceStep: tick });
    } else {
      const book = o.side === "buy" ? m.ask : m.bid;
      const worst = o.worstPrice ?? (book === undefined ? undefined : o.side === "buy" ? book * (1 + ROOM) : book * (1 - ROOM));
      if (worst === undefined) return badOrder(venue, PM, `nothing is on the ${o.side === "buy" ? "ask" : "bid"} side of ${m.name}: a limit order can rest there instead`);
      price = o.side === "buy" ? Math.min(floorTo(worst, tick), floorTo(1 - tick, tick)) : Math.max(ceilTo(worst, tick), tick);
    }
    if (price < tick - 1e-9 || price > 1 - tick + 1e-9) return badOrder(venue, PM, `a price is between ${plain(tick)} and ${plain(1 - tick)}`, { priceStep: tick });
    const args = ["predict", "place", "--token-id", tokenId, "--side", o.side, "--size", plain(o.qty, 2), "--price", plain(price, 6), "--order-type", ot, ...(o.postOnly ? ["--post-only"] : []), "--json"];
    const geo = ["predict", "geoblock", "--json"];
    if (!writesOn()) return off([geo, args]);
    const blocked = await geoblock(geo, o.side);
    if (blocked) return blocked;
    const doing = `${o.side} ${plain(o.qty)} ${m.base} shares in ${m.name}`;
    const sent = now();
    let data: unknown;
    try {
      data = await run<unknown>(args, { timeoutMs: MM_WRITE_TIMEOUT_MS });
    } catch (err) {
      const f = failureOf(err);
      if (!lost(f)) return saidNo(f, PM, doing, args, "order");
      return (await pmTaken(spot, o.side, o.qty, price, sent)) ?? unsure(f, PM, doing, args, `${PM}'s open orders and positions in ${m.name}`);
    }
    const res = obj(obj(obj(data)?.result)?.response);
    // an ok envelope is not acceptance: Polymarket can answer 200 with success false and its reason
    if (!(res?.success === true && str(res.orderId) !== "")) return saidNo({ code: "PREDICT_ERROR", message: str(res?.errorMsg) || `${PM} did not take the order and gave no reason` }, PM, `${o.side} in ${m.name}`, args, "order");
    const buy = o.side === "buy";
    const { shares, usd } = amountsOf(buy ? res.takingAmount : res.makingAmount, buy ? res.makingAmount : res.takingAmount, o.qty);
    const st = str(res.status).toLowerCase();
    let status: OrderStatus;
    let filled = shares;
    if (st === "matched") {
      if (shares <= 0) filled = o.qty;
      // FOK filled whole, or it would have been refused. A FAK order never rests: what did not fill at once was canceled. A GTC order's
      // remainder rests on the book: partly filled, still open
      const part = shares > 0 && shares < o.qty - 1e-9;
      status = !part || ot === "FOK" ? "filled" : ot === "FAK" ? "canceled" : "partial";
    } else if (st === "live") status = shares > 0 ? "partial" : "open";
    // delayed: marketable, matched after the market's delay; unmatched: taken, not matched; anything else Polymarket adds: taken, not known
    else status = "pending";
    const avg = shares > 0 && usd > 0 ? sig(usd / shares) : status === "filled" ? price : undefined;
    return { ref: str(res.orderId), status, filledQty: filled, ...(avg !== undefined ? { avgPrice: avg } : {}), native: { command: cmd(args), answer: { orderId: str(res.orderId), status: st, makingAmount: str(res.makingAmount), takingAmount: str(res.takingAmount), transactionHashes: arr(res.transactionHashes).map(str) } } };
  }

  /** an order whose answer was lost, found among the open ones in its market (`mm predict orders`): the same outcome, side, price and size,
   * made since it was sent. mm takes no client id, so nothing else names it, and an order like it made before is not taken for it */
  async function pmTaken(spot: PmSpot, side: "buy" | "sell", qty: number, price: number, sent: number): Promise<OrderState | undefined> {
    const args = ["predict", "orders", "--market", spot.conditionId, "--json"];
    let data: unknown;
    try {
      data = await run<unknown>(args);
    } catch {
      return undefined;
    }
    const o = arr(obj(obj(data)?.result)?.orders)
      .map(obj)
      .find((x) => x && !handedOut.has(str(x.id)) && str(x.asset_id) === spot.tokenId && same(str(x.side), side) && Math.abs(num(x.price) - price) < 1e-9 && Math.abs(num(x.original_size) - qty) < 1e-9 && (madeAt(x.created_at) ?? 0) >= sent - SINCE_MS);
    if (!o) return undefined;
    const matched = num(o.size_matched);
    return { ref: str(o.id), status: matched > 0 ? "partial" : "open", filledQty: matched, ...(matched > 0 && num(o.price) > 0 ? { avgPrice: num(o.price) } : {}), native: { command: cmd(args), found: "mm predict place's answer was lost: this order, resting since then with the same outcome, side, price and size, is it", order: { id: str(o.id), status: str(o.status), side: str(o.side), price: str(o.price), original_size: str(o.original_size), size_matched: str(o.size_matched) } } };
  }

  /** the market's condition id, which `mm predict orders` is filtered by */
  async function conditionOf(symbol: string): Promise<string | Refusal> {
    const hit = seen.get(symbol.trim().toUpperCase());
    if (hit?.spot.kind === "predict") return hit.spot.conditionId;
    const p = parseSymbol(venue, symbol);
    if (isRefusal(p)) return p;
    if (p.kind !== "predict") return no("E_ACCOUNT_BAD_ACTION", { venue, message: `${symbol} is not a ${PM} market` });
    if ("slug" in p) {
      const info = await pmInfo(p.slug, false);
      return isRefusal(info) ? info : info.conditionId;
    }
    const known = infos.get(p.tokenId.toLowerCase());
    if (known && now() - known.at < LIST_MS) return known.conditionId;
    const book = await pmBook(p.tokenId);
    return isRefusal(book) ? book : book.market || no("E_VENUE_REJECTED", { venue, message: `${PM}'s book for ${short(p.tokenId)} names no market` });
  }

  /** the order as `mm predict orders --market` lists it. mm 7.0.0 has no lookup by id, and lists only the open ones */
  async function pmOpen(ref: string, symbol: string): Promise<{ state: OrderState; original: number } | Refusal> {
    const cid = await conditionOf(symbol);
    if (isRefusal(cid)) return cid;
    const args = ["predict", "orders", "--market", cid, "--json"];
    let data: unknown;
    try {
      data = await call(args, PM, `list the open orders in ${short(cid)}`, "track");
    } catch (e) {
      return isRefusal(e) ? e : asRefusal(venue, "MetaMask", e);
    }
    const orders = arr(obj(obj(data)?.result)?.orders).map(obj);
    const o = orders.find((x) => str(x?.id) === ref);
    if (!o) return no("E_ACCOUNT_ORDER_UNKNOWN", { venue, message: `${PM} no longer lists ${short(ref)} among the open orders in this market, and mm has no call that says whether it filled, was canceled or expired: mm predict positions --market ${cid} shows what is held`, native: { command: cmd(args), open: orders.length } });
    const st = str(o.status).toUpperCase();
    const matched = num(o.size_matched);
    const original = num(o.original_size);
    const status: OrderStatus = st === "MATCHED" ? "filled" : st === "CANCELED" || st === "CANCELED_MARKET_RESOLVED" ? "canceled" : st === "INVALID" ? "rejected" : matched > 0 ? "partial" : "open";
    const filledQty = status === "filled" && !matched ? original : matched;
    // a resting order is the maker: it fills at its own price
    return { original, state: { ref, status, filledQty, ...(filledQty > 0 && num(o.price) > 0 ? { avgPrice: num(o.price) } : {}), native: { command: cmd(args), order: { id: ref, status: st, side: str(o.side), price: str(o.price), original_size: str(o.original_size), size_matched: str(o.size_matched), order_type: str(o.order_type), outcome: str(o.outcome) } } } };
  }

  async function cancelPm(ref: string, symbol: string): Promise<OrderState | Refusal> {
    const before = await pmOpen(ref, symbol);
    if (isRefusal(before) || DONE.has(before.state.status)) return isRefusal(before) ? before : before.state;
    // HMAC-signed at the CLOB, no wallet signature: taking an order off the book moves nothing, so MetaMask's switch is not asked
    const args = ["predict", "cancel", "--order-id", ref, "--json"];
    let data: unknown;
    try {
      data = await call(args, PM, `cancel ${short(ref)}`, "track");
    } catch (e) {
      return isRefusal(e) ? e : asRefusal(venue, "MetaMask", e);
    }
    const resp = obj(obj(obj(data)?.result)?.response);
    const canceled = arr(resp?.canceled).map(str);
    const why = str(obj(resp?.notCanceled)?.[ref]);
    const native = { command: cmd(args), answer: { canceled, ...(why ? { notCanceled: why } : {}) }, before: before.state.native };
    if (canceled.includes(ref)) return { ...before.state, status: "canceled", native };
    if (/matched/i.test(why)) return { ...before.state, status: "filled", filledQty: before.original || before.state.filledQty, native };
    return no("E_VENUE_REJECTED", { venue, message: `${PM} did not cancel ${short(ref)}${why ? `: ${said(why)}` : ""}`, native });
  }

  // ---- what is held ------------------------------------------------------------------------------

  /** one of Polymarket's Data API rows as the account's position: shares of one outcome, always held long (no one sells short there), under
   * the symbol the account gives that outcome, so it is the market market() opens and the one a sell of those shares is placed in */
  const positionOf = (p: Record<string, unknown>): Position | undefined => {
    const qty = num(p.size);
    const tokenId = str(p.asset);
    const slug = str(p.slug);
    const outcome = str(p.outcome);
    const symbol = /^[a-z0-9][a-z0-9-]*$/i.test(slug) && outcome ? `${slug}:${outcome}` : tokenId;
    if (!(qty > 0) || !symbol) return undefined;
    const entry = known(p.avgPrice);
    const mark = known(p.curPrice);
    const usd = known(p.currentValue);
    const pnl = known(p.cashPnl);
    // resolved: no longer traded, waiting for mm predict redeem (a winning share pays 1 pUSD, a losing one nothing)
    const resolved = p.redeemable === true;
    return {
      symbol,
      name: `${str(p.title) || slug || short(tokenId)}${outcome ? ` · ${outcome}` : ""}${resolved ? " (resolved)" : ""}`,
      kind: "event",
      side: "long",
      qty,
      ...(entry !== undefined && entry > 0 ? { entryPrice: entry } : {}),
      ...(mark !== undefined ? { markPrice: mark } : {}),
      ...(usd !== undefined ? { usd } : {}),
      ...(pnl !== undefined ? { unrealizedUsd: pnl } : {}),
      native: { tokenId, conditionId: str(p.conditionId), outcome, size: qty, avgPrice: entry, curPrice: mark, currentValue: usd, cashPnl: pnl, redeemable: resolved, ...(p.mergeable === true ? { mergeable: true } : {}), ...(str(p.endDate) ? { endDate: str(p.endDate) } : {}) },
    };
  };

  /** `mm predict positions`: what the Predict deposit wallet holds at Polymarket. mm passes on Polymarket's Data API rows (GET /positions for
   * the deposit wallet) as they come, asked with the API's own defaults: the 100 largest, each of at least one share. A read: it moves
   * nothing, so MetaMask's switch is not asked */
  async function pmPositions(): Promise<Position[] | Refusal> {
    const args = ["predict", "positions", "--json"];
    let data: unknown;
    try {
      data = await run<unknown>(args);
    } catch (err) {
      const f = failureOf(err);
      // mm asks whether the deposit wallet is deployed before it reads anything: a wallet that never set up Predict holds nothing there
      if (f.code === "PREDICT_SETUP_REQUIRED") return [];
      return saidNo(f, PM, "list what the Predict deposit wallet holds", args, "order");
    }
    const rows = obj(obj(data)?.result)?.positions;
    if (!Array.isArray(rows)) return unread(PM, args);
    return rows.flatMap((r) => {
      const p = obj(r);
      const x = p ? positionOf(p) : undefined;
      return x ? [x] : [];
    });
  }

  // ---- perpetuals (Hyperliquid, through mm perps) ------------------------------------------------------------

  let perpList: { at: number; rows: Array<Record<string, unknown>> } | undefined;
  /** the leverage each perpetual opens at: what was set here (setLeverage), else the open position's, else 1x */
  const leverageSet = new Map<string, number>();
  const perpSymbol = (coin: string): string => `${coin}-PERP`;
  const nextHour = (): string => new Date(Math.floor(now() / 3_600_000) * 3_600_000 + 3_600_000).toISOString();

  /** one row of `mm perps markets` (the SDK's PerpsMarket: symbol, maxLeverage, sizeDecimals, markPrice, oraclePrice, fundingRate,
   * openInterest, volume24h — Hyperliquid's own asset context, as strings) as the account's market */
  const perpOf = (r: Record<string, unknown>): { m: Market; spot: PerpSpot } | undefined => {
    const coin = str(r.symbol);
    const sz = Number(r.sizeDecimals);
    if (!/^[A-Za-z0-9]{1,20}$/.test(coin) || !Number.isInteger(sz) || sz < 0 || sz > 10 || r.isHip3 === true) return undefined;
    const mark = knownFigure(r.markPrice);
    const maxLev = knownFigure(r.maxLeverage);
    const funding = knownFigure(r.fundingRate);
    const volume = knownFigure(r.volume24h);
    const step = Number((10 ** -sz).toFixed(sz));
    const m: Market = {
      symbol: perpSymbol(coin),
      name: `${coin} perpetual on ${HL}`,
      kind: "perp",
      base: coin,
      quote: "USDC",
      ...(mark !== undefined && mark > 0 ? { price: mark } : {}),
      minQty: step,
      qtyStep: step,
      priceStep: Number((10 ** -Math.max(0, HL_PRICE_DECIMALS - sz)).toFixed(Math.max(0, HL_PRICE_DECIMALS - sz))),
      minNotional: HL_MIN_USD,
      open: true,
      note: PERP_NOTE,
      types: ["market", "limit"],
      ...(maxLev !== undefined && maxLev >= 1 ? { maxLeverage: maxLev } : {}),
      // Hyperliquid pays funding every hour: the rate is the hour's, and it is paid on the hour
      ...(funding !== undefined ? { fundingRate: funding, nextFundingAt: nextHour() } : {}),
      ...(volume !== undefined && volume >= 0 ? { volumeUsd24h: volume } : {}),
    };
    return { m, spot: { kind: "perp", coin, szDecimals: sz, maxLeverage: maxLev, mark } };
  };

  /** `mm perps markets`: every perpetual of Hyperliquid's main market, kept five minutes. A read: no region check, no switch */
  async function perpRows(): Promise<Array<Record<string, unknown>> | Refusal> {
    if (perpList && now() - perpList.at < LIST_MS) return perpList.rows;
    const args = ["perps", "markets", "--venue", "hyperliquid", "--json"];
    let data: unknown;
    try {
      data = await call(args, HL, "list its perpetuals", "order");
    } catch (e) {
      return isRefusal(e) ? e : asRefusal(venue, "MetaMask", e);
    }
    if (!Array.isArray(data)) return unread(HL, args);
    perpList = { at: now(), rows: data.map((x) => obj(x)).filter((x): x is Record<string, unknown> => x !== undefined) };
    return perpList.rows;
  }

  /** one perpetual, read afresh: `mm perps markets --symbol` */
  async function perpMarket(asked: string): Promise<Market | Refusal> {
    // Hyperliquid names a coin in its own case (kPEPE): the listing already read says which, where it has been read
    const coin = str(perpList?.rows.find((r) => same(str(r.symbol), asked))?.symbol) || asked;
    const args = ["perps", "markets", "--venue", "hyperliquid", "--symbol", coin, "--json"];
    let data: unknown;
    try {
      data = await call(args, HL, `read ${coin}`, "order");
    } catch (e) {
      return isRefusal(e) ? e : asRefusal(venue, "MetaMask", e);
    }
    const row = arr(data).map(obj).find((r) => r && same(str(r.symbol), coin));
    const got = row ? perpOf(row) : undefined;
    if (!got) return no("E_VENUE_REJECTED", { venue, message: `${HL} lists no perpetual ${coin} on its main market`, native: { command: cmd(args) } });
    seen.set(got.m.symbol.toUpperCase(), { m: got.m, at: now(), spot: got.spot });
    return got.m;
  }

  /** Hyperliquid's own line, held to where this machine is. mm 7.0.0 has no region check for its perpetuals: the place is the one mm says
   * (`mm predict geoblock`: Polymarket's look-up of this machine's address, of which only the country and the region are kept — never the
   * address, and never Polymarket's own verdict, which is Polymarket's rule and not Hyperliquid's). Restricted, or not known, and nothing
   * is sent */
  async function hlLine(doing: string): Promise<Refusal | undefined> {
    const args = ["predict", "geoblock", "--json"];
    let country = "";
    let region = "";
    // mm could not say where this machine is: the account's own sources are asked instead (location.ts) — a network that blocks Polymarket
    // blocks mm's check too, and the users Hyperliquid serves there must not be refused for that; not known there either, nothing is sent,
    // and the place not known now is asked again next time (E_VENUE_UNREACHABLE, as location.ts heldTo says it)
    const instead = async (why: string, native: Record<string, unknown>, inCountry?: string): Promise<Refusal | undefined> => {
      // asked now, not the place of a network the user may have left: an order goes from the network this machine is on
      const v = d.where ? await d.where.verdict(HYPERLIQUID_RULE, { fresh: true, ...(inCountry ? { country: inCountry } : {}) }) : "unknown";
      if (v === "served") return undefined;
      if (v === "closed") return no("E_VENUE_GEOBLOCKED", { venue, message: `${HYPERLIQUID_RULE.closedWords}. Nothing was sent to ${doing}`, native: { ...native, terms: HL_TERMS } });
      return no("E_VENUE_UNREACHABLE", { venue, message: `${why}. Try again in a moment`, native });
    };
    try {
      const data = await run<unknown>(args);
      const g = obj(obj(data)?.result) ?? obj(data);
      country = str(g?.country).toUpperCase();
      region = str(g?.region).toUpperCase();
    } catch (err) {
      const f = failureOf(err);
      // mm's region guard answers with the place in its words: "… not available in your region (PA, US)"
      const where = f.code === "PREDICT_GEOBLOCKED" ? /\(([^)]*)\)/.exec(f.message)?.[1]?.split(",").map((x) => x.trim().toUpperCase()) : undefined;
      if (where?.length) {
        country = where.at(-1) ?? "";
        region = where.length > 1 ? where[0]! : "";
      }
      // only mm's code is kept: its words may carry the place, or (an answer printed and an exit that was not 0) the whole of its answer
      if (!readablePlace(country)) return instead(`mm could not say where this machine is, so ${HL}'s own line (its Terms of Use §1.6) could not be checked: nothing was sent`, { command: cmd(args), code: f.code });
    }
    if (!readablePlace(country)) return instead(`mm did not say where this machine is, so ${HL}'s own line (its Terms of Use §1.6) could not be checked: nothing was sent`, { command: cmd(args) });
    // a US territory given as the US and its code is held as the territory itself, as the direct connection holds it (location.ts placeOf)
    ({ country, region } = placeOf(country, region));
    if (HYPERLIQUID_RULE.closes(country, region)) return no("E_VENUE_GEOBLOCKED", { venue, message: `${HL} does not serve this location (where mm places this machine): its Terms of Use (§1.6) close it to anyone located in the United States, Ontario or a sanctioned territory. That is its own rule, and the account does not look for a way around it. Nothing was sent to ${doing}`, native: { command: cmd(args), terms: HL_TERMS } });
    // a country the line closes in part (Canada: Ontario; Ukraine: Crimea, Donetsk, Luhansk) without the part: the account's own sources
    // are asked for it; not known, nothing is sent — said as the direct connection says it (location.ts heldTo), which names no country:
    // that the line closes part of it would tell where the user is
    if (!region && HYPERLIQUID_RULE.splits?.(country)) return instead(`where this machine is could not be learned just now, so ${HL}'s own line (its Terms of Use §1.6) could not be held to it: nothing was sent (${doing})`, { command: cmd(args) }, country);
    return undefined;
  }

  /** an order's answer from `mm perps open` or a row of `mm perps close` (the SDK's: venue, symbol, orderId, status filled · resting ·
   * submitted · rejected, averagePrice, filledSize, error) as the account's order, or Hyperliquid's refusal in its own words */
  const perpState = (row: Record<string, unknown> | undefined, args: string[], qty: number, doing: string, clientId: string): OrderState | Refusal => {
    if (!row) return unread(HL, args);
    const st = str(row.status).toLowerCase();
    const filled = knownFigure(row.filledSize) ?? 0;
    const avg = knownFigure(row.averagePrice);
    const native = { command: cmd(args), answer: { orderId: str(row.orderId), status: st, ...(str(row.averagePrice) ? { averagePrice: str(row.averagePrice) } : {}), ...(str(row.filledSize) ? { filledSize: str(row.filledSize) } : {}), ...(str(row.error) ? { error: said(str(row.error)) } : {}) } };
    if (st === "rejected") return saidNo({ code: "ORDER_REJECTED", message: str(row.error) || `${HL} rejected it and gave no reason` }, HL, doing, args, "order", { answer: native.answer });
    const status: OrderStatus = st === "filled" ? (filled > 0 && filled < qty - 1e-12 ? "canceled" : "filled") : st === "resting" ? (filled > 0 ? "partial" : "open") : "pending";
    // an IOC that filled in part is done: what did not fill at once was canceled. Without an order id the order is the account's own id
    return { ref: str(row.orderId) || `hl:${clientId}`, status, filledQty: status === "filled" && filled === 0 ? qty : filled, ...(avg !== undefined && avg > 0 ? { avgPrice: avg } : {}), native };
  };

  /** a limit price as Hyperliquid takes it: five significant figures at most (a whole number always), and no more decimals than the market's */
  const hlPriceOk = (px: number, szDecimals: number): boolean => {
    if (Number.isInteger(px)) return true;
    const decimals = plain(px).split(".")[1]?.length ?? 0;
    const digits = plain(px).replace(".", "").replace(/^0+/, "").length;
    return decimals <= Math.max(0, HL_PRICE_DECIMALS - szDecimals) && digits <= 5;
  };

  async function leverageFor(coin: string): Promise<number> {
    const set = leverageSet.get(coin.toUpperCase());
    if (set !== undefined) return set;
    const held = await perpPositionsRaw();
    const pos = isRefusal(held) ? undefined : held.find((p) => same(str(p.symbol), coin));
    const lev = knownFigure(pos?.leverage);
    return lev !== undefined && lev >= 1 ? Math.floor(lev) : 1;
  }

  async function placePerp(o: OrderRequest, s: Seen & { spot: PerpSpot }): Promise<OrderState | Refusal> {
    const { m, spot } = s;
    if (o.type !== "market" && o.type !== "limit") return badOrder(venue, HL, `mm places market and limit orders here, not ${String(o.type).replace("_", "-")} orders`);
    if (o.stopPrice !== undefined) return badOrder(venue, HL, "mm places no stop orders here");
    if (o.tif !== undefined) return badOrder(venue, HL, "mm takes no time in force here: a market order is Hyperliquid's IOC, a limit order rests until canceled (GTC)");
    if (o.postOnly || o.reduceOnly) return badOrder(venue, HL, "mm takes no post-only or reduce-only flag for an order here (a position is closed with a close)");
    if (!(o.qty > 0) || !onStep(o.qty, m.qtyStep)) return badOrder(venue, HL, `a size of ${spot.coin} moves in steps of ${plain(m.qtyStep ?? 0)}`, { qtyStep: m.qtyStep });
    const lev = await leverageFor(spot.coin);
    if (spot.maxLeverage !== undefined && lev > spot.maxLeverage) return badOrder(venue, HL, `${spot.coin} takes at most ${spot.maxLeverage}x; it is set to ${lev}x here`);
    const side = o.side === "buy" ? "long" : "short";
    let how: string[];
    if (o.type === "limit") {
      const px = o.limitPrice ?? NaN;
      if (!(px > 0) || !hlPriceOk(px, spot.szDecimals)) return badOrder(venue, HL, `a price in ${spot.coin} has at most five significant figures and ${Math.max(0, HL_PRICE_DECIMALS - spot.szDecimals)} decimals (a whole number always passes)`, { priceStep: m.priceStep });
      how = ["--type", "limit", "--limit-px", plain(px)];
    } else {
      // a market order is Hyperliquid's IOC within --max-slippage-bps of the mark mm reads; the bound is the account's worst price, from
      // the mark this trader read a moment ago
      const mark = m.price;
      const worst = o.worstPrice ?? (mark === undefined ? undefined : side === "long" ? mark * (1 + ROOM) : mark * (1 - ROOM));
      if (mark === undefined || worst === undefined) return badOrder(venue, HL, `${HL} shows no mark price for ${spot.coin} right now: a limit order can be placed instead`);
      const bps = Math.floor((side === "long" ? worst / mark - 1 : 1 - worst / mark) * 10_000 + 1e-9);
      if (!(bps >= 1)) return no("E_ACCOUNT_REQUOTE", { venue, message: `the mark moved past the worst price (${plain(sig(worst))} against ${plain(sig(mark))}): nothing was placed`, detail: { worstPrice: worst, mark } });
      how = ["--type", "market", "--max-slippage-bps", String(Math.min(bps, 1000))];
    }
    const args = ["perps", "open", "--venue", "hyperliquid", "--symbol", spot.coin, "--side", side, "--size", plain(o.qty, spot.szDecimals), "--leverage", String(lev), ...how, "--wallet-timeout", String(WALLET_TIMEOUT_S), "--json"];
    const geo = ["predict", "geoblock", "--json"];
    if (!writesOn()) return off([geo, args]);
    const doing = `${o.side} ${plain(o.qty)} ${spot.coin}`;
    const line = await hlLine(doing);
    if (line) return line;
    const sent = now();
    let data: unknown;
    try {
      data = await run<unknown>(args, { timeoutMs: MM_WRITE_TIMEOUT_MS });
    } catch (err) {
      const f = failureOf(err);
      if (!lost(f)) return saidNo(f, HL, doing, args, "order");
      // a limit order rests, and may be found; a market order is an IOC, filled into the position or gone at once
      const found = o.type === "limit" ? await perpTaken(spot.coin, side, o.qty, o.limitPrice!, sent) : undefined;
      return found ?? unsure(f, HL, doing, args, `${HL}'s open orders and positions in ${spot.coin}`);
    }
    return perpState(obj(data), args, o.qty, doing, o.clientId);
  }

  /** a limit order whose answer was lost, found among the resting ones (`mm perps orders`): the same coin, side, price and size, made since
   * it was sent. An order like it made before is not taken for it, nor one whose row does not say when it was made */
  async function perpTaken(coin: string, side: "long" | "short", qty: number, price: number, sent: number): Promise<OrderState | undefined> {
    const args = ["perps", "orders", "--venue", "hyperliquid", "--json"];
    let data: unknown;
    try {
      data = await run<unknown>(args);
    } catch {
      return undefined;
    }
    const o = arr(data)
      .map(obj)
      .find((x) => x && !handedOut.has(str(x.orderId)) && same(str(x.symbol), coin) && (side === "long" ? ["long", "buy", "b"] : ["short", "sell", "a"]).includes(str(x.side).toLowerCase()) && Math.abs(num(x.limitPrice) - price) < 1e-9 && Math.abs((knownFigure(x.originalSize) ?? num(x.size)) - qty) < 1e-12 && (madeAt(x.timestamp) ?? 0) >= sent - SINCE_MS);
    if (!o || !/^\d{1,20}$/.test(str(o.orderId))) return undefined;
    const filled = Math.max(0, sig(qty - num(o.size)));
    return { ref: str(o.orderId), status: filled > 0 ? "partial" : "open", filledQty: filled, ...(filled > 0 ? { avgPrice: price } : {}), native: { command: cmd(args), found: "mm perps open's answer was lost: this order, resting since then with the same coin, side, price and size, is it", order: { orderId: str(o.orderId), symbol: str(o.symbol), side: str(o.side), size: str(o.size), originalSize: str(o.originalSize), limitPrice: str(o.limitPrice) } } };
  }

  /** `mm perps positions`: the SDK's rows (symbol, side, size, entryPrice, positionValue, unrealizedPnl, marginUsed, leverage,
   * liquidationPrice) of Hyperliquid's main market. An account that never deposited holds nothing there */
  async function perpPositionsRaw(): Promise<Array<Record<string, unknown>> | Refusal> {
    const args = ["perps", "positions", "--venue", "hyperliquid", "--json"];
    let data: unknown;
    try {
      data = await call(args, HL, "list what the Hyperliquid account holds", "order");
    } catch (e) {
      return isRefusal(e) ? e : asRefusal(venue, "MetaMask", e);
    }
    if (!Array.isArray(data)) return unread(HL, args);
    return data.map((x) => obj(x)).filter((x): x is Record<string, unknown> => x !== undefined);
  }

  async function perpPositions(): Promise<Position[] | Refusal> {
    const rows = await perpPositionsRaw();
    if (isRefusal(rows)) return rows;
    return rows.flatMap((r) => {
      const coin = str(r.symbol);
      const qty = knownFigure(r.size) ?? 0;
      if (!/^[A-Za-z0-9]{1,20}$/.test(coin) || r.isHip3 === true || !(qty > 0)) return [];
      const value = knownFigure(r.positionValue);
      const entry = knownFigure(r.entryPrice);
      const pnl = knownFigure(r.unrealizedPnl);
      const lev = knownFigure(r.leverage);
      const liq = knownFigure(r.liquidationPrice);
      const p: Position = { symbol: perpSymbol(coin), name: `${coin} perpetual on ${HL}`, kind: "perp", side: str(r.side) === "short" ? "short" : "long", qty, ...(entry !== undefined && entry > 0 ? { entryPrice: entry } : {}), ...(value !== undefined ? { usd: Math.abs(value), markPrice: Math.abs(value) / qty } : {}), ...(pnl !== undefined ? { unrealizedUsd: pnl } : {}), ...(lev !== undefined ? { leverage: lev } : {}), ...(liq !== undefined && liq > 0 ? { liquidationPrice: liq } : {}), native: { coin, side: str(r.side), size: str(r.size), entryPrice: str(r.entryPrice), positionValue: str(r.positionValue), unrealizedPnl: str(r.unrealizedPnl), marginUsed: str(r.marginUsed), leverage: lev, ...(str(r.liquidationPrice) ? { liquidationPrice: str(r.liquidationPrice) } : {}) } };
      return [p];
    });
  }

  /** the order as `mm perps orders` lists it while it rests. mm 7.0.0 has no look-up by id, and lists only the resting ones */
  async function perpOpen(ref: string, coin: string): Promise<OrderState | Refusal> {
    const args = ["perps", "orders", "--venue", "hyperliquid", "--json"];
    let data: unknown;
    try {
      data = await call(args, HL, "list the resting orders", "track");
    } catch (e) {
      return isRefusal(e) ? e : asRefusal(venue, "MetaMask", e);
    }
    const o = arr(data).map(obj).find((x) => str(x?.orderId) === ref);
    if (!o) return no("E_ACCOUNT_ORDER_UNKNOWN", { venue, message: `${HL} no longer lists ${ref} among the resting orders, and mm has no call that says whether it filled or was canceled: mm perps positions shows what is held`, native: { command: cmd(args), coin } });
    const size = knownFigure(o.size) ?? 0;
    const original = knownFigure(o.originalSize) ?? size;
    const filled = Math.max(0, sig(original - size));
    return { ref, status: filled > 0 ? "partial" : "open", filledQty: filled, ...(filled > 0 && knownFigure(o.limitPrice) ? { avgPrice: knownFigure(o.limitPrice) } : {}), native: { command: cmd(args), order: { orderId: ref, symbol: str(o.symbol), side: str(o.side), size: str(o.size), originalSize: str(o.originalSize), limitPrice: str(o.limitPrice) } } };
  }

  /** `mm perps cancel --order-id`: taking an order off the book moves nothing, so neither the switch nor the region is asked */
  async function cancelPerp(ref: string, coin: string): Promise<OrderState | Refusal> {
    const before = await perpOpen(ref, coin);
    if (isRefusal(before) || DONE.has(before.status)) return before;
    if (!/^\d{1,20}$/.test(ref)) return no("E_ACCOUNT_ORDER_UNKNOWN", { venue, message: `${ref} is not an order id ${HL} gave` });
    const args = ["perps", "cancel", "--venue", "hyperliquid", "--order-id", ref, "--symbol", coin, "--json"];
    let data: unknown;
    try {
      data = await call(args, HL, `cancel ${ref}`, "track");
    } catch (e) {
      return isRefusal(e) ? e : asRefusal(venue, "MetaMask", e);
    }
    const r = obj(data);
    if (r?.ok === true) return { ...before, status: "canceled", native: { command: cmd(args), answer: { orderId: str(r.orderId), ok: true }, before: before.native } };
    return no("E_VENUE_REJECTED", { venue, message: `${HL} did not cancel ${ref}${str(r?.error) ? `: ${said(str(r?.error))}` : ""}`, native: { command: cmd(args) } });
  }

  /** `mm perps close --symbol --size`: Hyperliquid's own reduce-only IOC within 2% of the mid. Region first; then MetaMask's switch */
  async function closePerp(coin: string, qty: number, clientId: string): Promise<OrderState | Refusal> {
    const held = await perpPositionsRaw();
    if (isRefusal(held)) return held;
    const pos = held.find((p) => same(str(p.symbol), coin));
    const have = knownFigure(pos?.size) ?? 0;
    if (!(have > 0)) return no("E_ACCOUNT_BAD_ACTION", { venue, message: `${HL} shows no position in ${coin}` });
    const all = qty >= have - 1e-12;
    const spot = seen.get(perpSymbol(coin).toUpperCase())?.spot;
    const sz = spot?.kind === "perp" ? spot.szDecimals : 8;
    const args = ["perps", "close", "--venue", "hyperliquid", "--symbol", str(pos?.symbol) || coin, ...(all ? [] : ["--size", plain(Math.min(qty, have), sz)]), "--max-slippage-bps", String(ROOM * 10_000), "--wallet-timeout", String(WALLET_TIMEOUT_S), "--json"];
    const geo = ["predict", "geoblock", "--json"];
    if (!writesOn()) return off([geo, args]);
    const doing = `close ${plain(qty)} ${coin}`;
    const line = await hlLine(doing);
    if (line) return line;
    let data: unknown;
    try {
      data = await run<unknown>(args, { timeoutMs: MM_WRITE_TIMEOUT_MS });
    } catch (err) {
      const f = failureOf(err);
      // a close is Hyperliquid's own IOC: it never rests, so only the position says whether it went
      return lost(f) ? unsure(f, HL, doing, args, `${HL}'s position in ${coin}`) : saidNo(f, HL, doing, args, "order");
    }
    const row = arr(data).map(obj).find((r) => r && same(str(r.symbol), coin));
    return perpState(row, args, all ? have : qty, doing, clientId);
  }

  // ---- the trader --------------------------------------------------------------------------------------

  async function market(symbol: string): Promise<Market | Refusal> {
    const p = parseSymbol(venue, symbol);
    if (isRefusal(p)) return p;
    return p.kind === "swap" ? swapMarket(p) : p.kind === "perp" ? perpMarket(p.coin) : pmMarket(p);
  }

  async function fresh(symbol: string): Promise<Seen | Refusal> {
    const hit = seen.get(symbol.trim().toUpperCase());
    if (hit && now() - hit.at <= FRESH_MS) return hit;
    const m = await market(symbol);
    if (isRefusal(m)) return m;
    return seen.get(m.symbol.toUpperCase())!;
  }

  async function placeOnce(o: OrderRequest): Promise<OrderState | Refusal> {
    const s = await fresh(o.symbol);
    if (isRefusal(s)) return s;
    if (!s.m.open) return no("E_VENUE_MARKET_CLOSED", { venue, message: `${s.m.name} takes no orders now${s.m.note ? ` (${s.m.note})` : ""}` });
    return s.spot.kind === "swap" ? placeSwap(o, s as Seen & { spot: SwapSpot }) : s.spot.kind === "perp" ? placePerp(o, s as Seen & { spot: PerpSpot }) : placePm(o, s as Seen & { spot: PmSpot });
  }

  /** one order per client id: a retry with the same id is the same order, never a second one */
  function place(o: OrderRequest): Promise<OrderState | Refusal> {
    const prior = placing.get(o.clientId);
    if (prior) return prior;
    const p = placeOnce(o);
    placing.set(o.clientId, p);
    // a refusal placed nothing: the same id may be tried again — unless it may have been placed (its answer was lost), when the same id is
    // the same answer, never a second order
    void p.then((r) => {
      if (isRefusal(r) && !(r.detail as { unsure?: unknown } | undefined)?.unsure) placing.delete(o.clientId);
      else if (!isRefusal(r) && r.ref) handedOut.add(r.ref);
    });
    return p;
  }

  /** the chains mm swaps on (`mm chains list`, kept five minutes), among those with a pinned USDC */
  async function swapChains(): Promise<ChainName[] | Refusal> {
    if (chains && now() - chains.at < LIST_MS) return chains.list;
    const args = ["chains", "list", "--json"];
    let data: unknown;
    try {
      data = await call(args, "MetaMask", "list its chains", "order");
    } catch (e) {
      return isRefusal(e) ? e : asRefusal(venue, "MetaMask", e);
    }
    const ids = new Set(
      arr(obj(data)?.chains)
        .map(obj)
        .filter((c) => arr(c?.features).map(str).includes("swap"))
        .map((c) => num(c?.chainId)),
    );
    chains = { at: now(), list: SWAP_CHAINS.filter((c) => ids.has(CHAINS[c].chain.id)) };
    return chains.list;
  }

  const listed = (chain: ChainName, token: string): Market => ({ symbol: `${token}/USDC@${chain}`, name: `${token} on ${chain}`, kind: "token", base: token, quote: "USDC", open: true, note: SWAP_NOTE, types: ["market"] });
  const pmListed = (info: PmInfo): Market[] => {
    const why = whyClosed(info);
    return info.outcomes.map((o, i) => ({ symbol: info.slug ? `${info.slug}:${o.name}` : o.tokenId, name: `${info.question} · ${o.name}`, kind: "event", base: o.name, quote: "pUSD", price: o.price || undefined, minQty: info.min || undefined, qtyStep: 0.01, priceStep: info.tick || undefined, open: why === undefined, note: why ?? PM_NOTE, types: ["limit", "market"], tifs: [...PM_TIFS], postOnly: true, sellsReduce: true, ...pmExtra(info, i, o.name) }));
  };
  /** a category as Polymarket's tag slug, which `--tag-slug` takes: "Climate & Science" → climate-science (never a leading "-": it is an argv
   * element, and one that starts with "-" would be read as a flag) */
  const tagSlug = (category: string): string =>
    category
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  /** a Polymarket market is found by what `mm predict markets get` takes: its slug or its condition id (a bare number is not taken for
   * Gamma's market id: a search for "2026" would list an unrelated market). Free text is not searched: the output of
   * `mm predict markets search` is not documented */
  const pmKey = (q: string): string | undefined => {
    const slug = /^([a-z0-9]+(?:-[a-z0-9]+)+)(?::.+)?$/.exec(q)?.[1];
    if (slug) return slug;
    return /^0x[0-9a-fA-F]{64}$/.test(q) ? q : undefined;
  };

  return {
    can: "unknown",
    what: `token swaps against USDC on ${SWAP_CHAINS.join(", ")}, Polymarket prediction orders and Hyperliquid perpetuals, sent by MetaMask's mm`,
    kinds: ["token", "event", "perp"],
    async markets(query) {
      const list = await swapChains();
      if (isRefusal(list)) return list;
      const out = pick(
        WELL_KNOWN.filter(([c]) => list.includes(c)).map(([c, t]) => listed(c, t)),
        query,
      );
      const q = query.trim();
      // a whole swap symbol typed in is offered as it is, priced when it is opened
      const p = q ? parseSymbol(venue, q) : undefined;
      if (p && !isRefusal(p) && p.kind === "swap" && list.includes(p.chain) && !out.some((m) => same(m.symbol, `${p.token}/USDC@${p.chain}`))) out.unshift(listed(p.chain, p.token));
      // Hyperliquid's perpetuals: the busiest few to start from, or the ones matching what was typed (`BTC`, `BTC-PERP`). A venue that does
      // not answer leaves them out of the list, and the list stands
      const rows = await perpRows();
      if (!isRefusal(rows)) {
        const perps = rows.map(perpOf).filter((x): x is { m: Market; spot: PerpSpot } => x !== undefined).sort((a, b) => (b.m.volumeUsd24h ?? 0) - (a.m.volumeUsd24h ?? 0)).map((x) => x.m);
        out.push(...(q ? pick(perps, q.replace(/-PERP$/i, ""), 8) : perps.slice(0, 5)));
      }
      const key = q ? pmKey(q) : undefined;
      if (key) {
        const info = await pmInfo(key, false);
        if (!isRefusal(info)) out.push(...pmListed(info));
      }
      return out.slice(0, 20);
    },
    market,
    place,
    async cancel(ref, symbol) {
      const p = parseSymbol(venue, symbol);
      if (isRefusal(p)) return p;
      if (p.kind === "predict") return cancelPm(ref, symbol);
      if (p.kind === "perp") return cancelPerp(ref, p.coin);
      const s = await swapStatus(ref, symbol);
      if (isRefusal(s) || DONE.has(s.status)) return s;
      return no("E_VENUE_REJECTED", { venue, message: `${SWAPS} have no cancel: a swap mm sent lands whole or reverts on chain, and one waiting for Guard's approval is stopped by denying it in the email or on MetaMask Mobile`, native: s.native });
    },
    async status(ref, symbol) {
      const p = parseSymbol(venue, symbol);
      if (isRefusal(p)) return p;
      if (p.kind === "swap") return swapStatus(ref, symbol);
      if (p.kind === "perp") return perpOpen(ref, p.coin);
      const r = await pmOpen(ref, symbol);
      return isRefusal(r) ? r : r.state;
    },
    /** what is held: the shares at Polymarket and the positions at Hyperliquid. Either venue not answering is the answer: a list without
     * one of them would read as nothing held there */
    async positions() {
      const [pm, hl] = await Promise.all([pmPositions(), perpPositions()]);
      if (isRefusal(pm)) return pm;
      if (isRefusal(hl)) return hl;
      return [...pm, ...hl];
    },
    /** what is held at the one venue a market is at: a close reads only the part it closes, so that Polymarket refusing this network (a
     * network that blocks polymarket.com) never hides — nor keeps from being closed — a perpetual at Hyperliquid, nor the other way */
    async positionsOf(symbol: string) {
      const p = parseSymbol(venue, symbol);
      if (isRefusal(p)) return p;
      return p.kind === "perp" ? perpPositions() : p.kind === "predict" ? pmPositions() : [];
    },
    /** the venue's place rule for an order here, asked before the owner is quoted or an agent's card is raised (account/live-orders.ts
     * placeRule), signing and sending nothing: Polymarket's own check for an outcome (close-only lets a sell through), Hyperliquid's line for
     * a perpetual; a swap has none */
    async held(o: { side: "buy" | "sell"; reduceOnly?: boolean | undefined; symbol?: string | undefined }) {
      const p = parseSymbol(venue, o.symbol ?? "");
      if (isRefusal(p) || p.kind === "swap") return undefined;
      if (p.kind === "perp") return hlLine(`${o.side}${o.reduceOnly ? " to close" : ""} ${p.coin}-PERP`);
      return geoblock(["predict", "geoblock", "--json"], o.reduceOnly ? "sell" : o.side);
    },
    /** a position closed: at Hyperliquid by its own close (mm perps close); at Polymarket by selling the shares, a market order at the
     * account's 2% room under the bid, as the account would send it (no amend: mm has no command that changes an order in place) */
    async close(symbol, qty, clientId) {
      const p = parseSymbol(venue, symbol);
      if (isRefusal(p)) return p;
      if (p.kind === "perp") return closePerp(p.coin, qty, clientId);
      if (p.kind === "predict") return place({ symbol, side: "sell", type: "market", qty, clientId });
      return no("E_VENUE_RAIL_CLOSED", { venue, message: `a token in the wallet is not a position: sell it as a swap (${SWAPS})` });
    },
    /** a perpetual's leverage at Hyperliquid (mm perps modify --leverage): what its next order opens at, and its open position's now. mm
     * sets no margin mode: Hyperliquid's own applies (cross, unless the market is isolated-only) */
    async setLeverage(symbol, leverage, marginMode) {
      const p = parseSymbol(venue, symbol);
      if (isRefusal(p)) return p;
      if (p.kind !== "perp") return no("E_VENUE_RAIL_CLOSED", { venue, message: "leverage is set on a Hyperliquid perpetual here, nothing else" });
      if (marginMode !== undefined) return badOrder(venue, HL, "mm sets no margin mode: Hyperliquid's own applies (cross, unless the market is isolated-only)");
      const s = await fresh(symbol);
      if (isRefusal(s)) return s;
      const spot = s.spot as PerpSpot;
      if (!Number.isInteger(leverage) || leverage < 1 || (spot.maxLeverage !== undefined && leverage > spot.maxLeverage)) return badOrder(venue, HL, `${spot.coin} takes whole leverage from 1x to ${spot.maxLeverage ?? "its maximum"}x`);
      const args = ["perps", "modify", "--venue", "hyperliquid", "--symbol", spot.coin, "--leverage", String(leverage), "--wallet-timeout", String(WALLET_TIMEOUT_S), "--json"];
      const geo = ["predict", "geoblock", "--json"];
      if (!writesOn()) return off([geo, args]);
      const line = await hlLine(`set ${spot.coin} to ${leverage}x`);
      if (line) return line;
      let data: unknown;
      try {
        data = await run<unknown>(args, { timeoutMs: MM_WRITE_TIMEOUT_MS });
      } catch (err) {
        const f = failureOf(err);
        return lost(f) ? unsure(f, HL, `set ${spot.coin} to ${leverage}x`, args, `${HL}'s leverage for ${spot.coin}`, {}) : saidNo(f, HL, `set ${spot.coin} to ${leverage}x`, args, "order");
      }
      const row = arr(data).map(obj).find((r) => r && same(str(r.symbol), spot.coin));
      if (!row || str(row.status).toLowerCase() === "rejected") return saidNo({ code: "ORDER_REJECTED", message: str(row?.error) || `${HL} did not take the leverage` }, HL, `set ${spot.coin} to ${leverage}x`, args, "order");
      leverageSet.set(spot.coin.toUpperCase(), leverage);
      return { leverage, native: { command: cmd(args), answer: { status: str(row.status) } } };
    },

    /** Polymarket's event contracts to discover, through `mm predict events list` (predict.md): its events with Gamma's filters — active
     * ones (--active), the busiest first, in one tag when a category is asked (--tag-slug), ending within the window when one is asked
     * (--end-date-min, --end-date-max; each market's own end date is held to it too). mm answers {result: {events}}, Gamma's events as they
     * come with each market's outcomes folded into {name, price, tokenId} (mm 7.0.0's source). Every outcome of every market open for
     * orders among them is a market, the markets most traded in 24 hours first; a market whose token ids mm could not read is left out. The
     * category is the event's tag that was asked for, in Polymarket's words, or the event's `category` should Gamma send one. A read: the
     * region check is for orders, and MetaMask's switch is not asked. No price history: predict.md documents none for an outcome */
    async events({ category, closingWithinMs, limit }) {
      const n = Math.min(200, Math.floor(limit));
      if (!(n > 0)) return [];
      if (closingWithinMs !== undefined && !(Number.isFinite(closingWithinMs) && closingWithinMs > 0)) return no("E_ACCOUNT_BAD_ACTION", { venue, message: "a window for markets closing soon is a number of milliseconds, more than 0" });
      const tag = category !== undefined ? tagSlug(category) : undefined;
      if (tag === "") return no("E_ACCOUNT_BAD_ACTION", { venue, message: `a category at ${PM} is one of its tags, in words ("Sports", "Crypto"), not "${String(category).slice(0, 40)}"` });
      const at = now();
      const until = closingWithinMs !== undefined ? at + closingWithinMs : undefined;
      // mm's help lists "volume_24hr" for --order, which Gamma refuses ("order fields are not valid", OBSERVED 2026-10-05); mm passes the value
      // on as it is, so Gamma's own field name is sent
      const args = ["predict", "events", "list", "--active", "--order", "volume24hr", "--limit", String(Math.min(20, Math.max(5, Math.ceil(n / 2)))), ...(tag ? ["--tag-slug", tag] : []), ...(until !== undefined ? ["--end-date-min", new Date(at).toISOString(), "--end-date-max", new Date(until).toISOString()] : []), "--json"];
      let data: unknown;
      try {
        data = await call(args, PM, "list its events", "order");
      } catch (e) {
        return isRefusal(e) ? e : asRefusal(venue, "MetaMask", e);
      }
      const events = obj(obj(data)?.result)?.events;
      if (!Array.isArray(events)) return unread(PM, args);
      const rows: Array<{ m: Market; vol: number }> = [];
      const have = new Set<string>();
      for (const e of events.map(obj)) {
        if (!e) continue;
        const asked = tag ? arr(e.tags).map(obj).find((t) => t?.slug === tag) : undefined;
        // an event that lists its tags without the one asked for is not in that category, whatever came back
        if (tag && Array.isArray(e.tags) && !asked) continue;
        const cat = str(asked?.label) || str(e.category) || undefined;
        for (const raw of arr(e.markets).map(obj)) {
          if (!raw) continue;
          const info = infoOf(raw, cat);
          if (!info.conditionId || !info.outcomes.length || !info.outcomes.every((o) => /^\d+$/.test(o.tokenId))) continue;
          if (until !== undefined && !(info.endDate && Date.parse(info.endDate) > at && Date.parse(info.endDate) <= until)) continue;
          for (const m of pmListed(info)) {
            if (!m.open || have.has(m.symbol)) continue;
            have.add(m.symbol);
            rows.push({ m, vol: info.volume24h ?? 0 });
          }
        }
      }
      // the busiest markets first; a market's outcomes stay together, in Gamma's order (the sort is stable)
      return rows
        .sort((a, b) => b.vol - a.vol)
        .map((r) => r.m)
        .slice(0, n);
    },
  };
}

// ---- earn (DeFi vaults, through mm earn) -------------------------------------------------------------------------

export interface MmEarnerDeps extends MmTraderDeps {
  /** a dollar price for a vault's asset that is not a dollar stablecoin */
  price?: Price | undefined;
}

const EARN = "MetaMask's earn vaults";
/** the vaults offered to start from: those holding at least this much, the highest yield first (a thin vault's yield is not a yield) */
const EARN_MIN_TVL = "1000000";
/** dollars as a vault's size is said: $4,000 · $1,000,000 */
const usdWords = (n: number): string => `$${Math.round(n).toLocaleString("en-US")}`;
const VAULT_ID = /^(\d{1,10}):(0x[0-9a-fA-F]{40})$/;

/** The MetaMask Agent Wallet's earn: LI.FI's vaults through `mm earn` (earn.md). A product's id is `<chain id>:<vault address>`. Money goes
 * in from the wallet on the vault's own chain and comes back to the wallet there: `--from-chain-id` is never sent, and `mm earn withdraw`
 * takes no destination. mm lists only vaults that take deposits AND withdrawals (its own filter). Every supply and withdrawal waits for
 * MetaMask's own switch as well as the server's, and MetaMask's Guard may ask the owner to approve it (mm waits up to ten minutes) */
export function mmEarner(d: MmEarnerDeps): LiveEarner {
  const { venue, run, env, now } = d;
  const { said, cmd, writesOn, off, failureOf, saidNo, call, unread, jobOf, mayLand, lost } = mmVoice(venue, run, env);
  const lists = new Map<string, { at: number; rows: Array<Record<string, unknown>> }>();
  const apys = new Map<string, number>();
  const submit = once<EarnState>();
  const chainOf = (id: number): string => CHAIN_BY_ID.get(id) ?? `chain ${id}`;
  const landsOn = (id: number): string => `your ${d.name} on ${chainOf(id)}`;
  const priceOf = async (asset: string): Promise<number | undefined> => {
    if (isStable(asset)) return 1;
    try {
      const p = await d.price?.(asset);
      return p !== undefined && p > 0 ? p : undefined;
    } catch {
      return undefined;
    }
  };

  /** one vault of `mm earn markets` (the SDK's Vault: address, chainId, name, protocol {name}, underlyingTokens, apy {base, reward, total} as
   * fractions, apy7d, apy30d, tvlUsd, isTransactional, isRedeemable) as a product: one asset in, the same asset out */
  const productOf = async (v: Record<string, unknown>): Promise<EarnProduct | undefined> => {
    const chainId = Number(v.chainId);
    const address = str(v.address);
    const under = arr(v.underlyingTokens).map(obj);
    if (!Number.isInteger(chainId) || !/^0x[0-9a-fA-F]{40}$/.test(address) || under.length !== 1 || !str(under[0]?.symbol)) return undefined;
    const asset = str(under[0]!.symbol);
    const apy = knownFigure(obj(v.apy)?.total) ?? knownFigure(v.apy30d) ?? undefined;
    const id = `${chainId}:${address.toLowerCase()}`;
    if (apy !== undefined) apys.set(id, apy);
    const protocol = str(obj(v.protocol)?.name) || undefined;
    const tvl = knownFigure(v.tvlUsd);
    const price = await priceOf(asset);
    // the floor the list is asked with holds at the door too: a vault named by its id is taken only if it holds as much as the ones shown
    const thin = tvl === undefined || tvl < Number(EARN_MIN_TVL);
    const closed = v.isTransactional === false;
    return {
      id,
      asset,
      name: `${str(v.name) || short(address)}${protocol ? ` · ${protocol}` : ""}`,
      ...(apy !== undefined ? { apy, rateKind: "apy" as const } : {}),
      ...(protocol ? { protocol } : {}),
      chain: chainOf(chainId),
      ...(tvl !== undefined ? { tvlUsd: tvl } : {}),
      ...(price !== undefined ? { priceUsd: price } : {}),
      lands: landsOn(chainId),
      canSupply: !closed && !thin,
      canWithdraw: v.isRedeemable !== false,
      ...(closed ? { why: `${EARN}: this vault takes no deposits now` } : thin ? { why: `${tvl === undefined ? "mm does not say how much this vault holds" : `this vault holds ${usdWords(tvl)}`}: the account puts money only into vaults holding ${usdWords(Number(EARN_MIN_TVL))} or more (a thin vault's yield is not a yield). Money already in it can still come out` } : {}),
      note: `a DeFi vault on ${chainOf(chainId)}${protocol ? ` (${protocol})` : ""}, through LI.FI: your ${d.name} puts ${asset} in and takes it back out on ${chainOf(chainId)}. Its yield moves with the market, and the vault's contracts carry their own risk. MetaMask's Guard may ask you to approve it first`,
    };
  };

  /** `mm earn markets`, kept five minutes for each way it is asked */
  async function vaults(args: string[], key: string): Promise<Array<Record<string, unknown>> | Refusal> {
    const hit = lists.get(key);
    if (hit && now() - hit.at < LIST_MS) return hit.rows;
    let data: unknown;
    try {
      data = await call(args, EARN, "list its vaults", "order");
    } catch (e) {
      return isRefusal(e) ? e : asRefusal(venue, "MetaMask", e);
    }
    if (!Array.isArray(data)) return unread(EARN, args);
    const rows = data.map((x) => obj(x)).filter((x): x is Record<string, unknown> => x !== undefined);
    lists.set(key, { at: now(), rows });
    return rows;
  }

  /** `mm earn positions`: the SDK's rows (chainId, vaultAddress, protocolName, asset {address, symbol, decimals}, balanceUsd, balanceNative in
   * the asset's base units, LI.FI's earn API says) */
  async function held(): Promise<Array<Record<string, unknown>> | Refusal> {
    const args = ["earn", "positions", "--json"];
    let data: unknown;
    try {
      data = await call(args, EARN, "list what the wallet holds in vaults", "order");
    } catch (e) {
      return isRefusal(e) ? e : asRefusal(venue, "MetaMask", e);
    }
    if (!Array.isArray(data)) return unread(EARN, args);
    return data.map((x) => obj(x)).filter((x): x is Record<string, unknown> => x !== undefined);
  }
  const amountOfRow = (r: Record<string, unknown>): number => {
    const raw = str(r.balanceNative);
    const decimals = Number(obj(r.asset)?.decimals);
    if (raw.includes(".") || !Number.isInteger(decimals)) return num(raw);
    try {
      return Number(formatUnits(BigInt(raw), decimals));
    } catch {
      return 0;
    }
  };

  /** money in or out: one wallet job. A job mm stopped waiting for (Guard asking the owner, a timeout), or one whose connection dropped after
   * it was sent, is pending, never refused: it may still go through, and is not sent twice */
  const send = (args: string[], doing: string, clientId: string): Promise<EarnState | Refusal> =>
    submit(clientId, async () => {
      if (!writesOn()) return off([args]);
      let data: unknown;
      try {
        data = await run<unknown>(args, { timeoutMs: MM_WRITE_TIMEOUT_MS });
      } catch (err) {
        const f = failureOf(err);
        const waits = mayLand(f) ?? (lost(f) ? { mfa: false } : undefined);
        if (!waits) return saidNo(f, EARN, doing, args, "order");
        const job = jobOf(f);
        return { ref: job ? `job:${job}` : `earn:${clientId}`, status: "pending", native: { command: cmd(args), waiting: waits.mfa ? "MetaMask's Guard asked you to approve this, by email or on MetaMask Mobile: it goes when you approve it" : MAY_LAND.has(f.code) ? "mm stopped waiting before it saw the transaction sent: MetaMask may still send it" : "the connection dropped after it was sent: MetaMask may still send it (mm wallet requests list shows it)", code: f.code, said: said(f.message), ...(job ? { pollingId: job } : {}) } };
      }
      const x = obj(data);
      const hash = str(x?.hash);
      const job = str(obj(x?.pendingJob)?.pollingId);
      if (!hash && !job) return unread(EARN, args);
      return { ref: hash || `job:${job}`, status: hash ? "done" : "pending", native: { command: cmd(args), answer: { hash, ...(job ? { pollingId: job } : {}), vault: str(x?.vaultName), protocol: str(x?.protocol), symbol: str(x?.symbol), chainId: num(x?.chainId) } } };
    });

  const vaultOf = (p: EarnProduct): { chainId: number; address: string } | Refusal => {
    const m = VAULT_ID.exec(p.id);
    return m ? { chainId: Number(m[1]), address: m[2]! } : no("E_ACCOUNT_BAD_ACTION", { venue, message: `a vault here is <chain id>:<vault address> (for example 8453:0x…), not "${p.id.slice(0, 60)}"` });
  };

  return {
    can: "unknown",
    what: "DeFi vaults through MetaMask's mm earn (LI.FI)",
    async products(asset) {
      const token = asset?.trim();
      if (token !== undefined && token !== "" && !/^[A-Za-z0-9.]{1,20}$/.test(token)) return no("E_ACCOUNT_BAD_ACTION", { venue, message: "an asset is its symbol: USDC, WETH" });
      const args = ["earn", "markets", ...(token ? ["--token", token] : []), "--min-tvl", EARN_MIN_TVL, "--sort", "apy", "--limit", "40", "--json"];
      const rows = await vaults(args, `top|${(token ?? "").toUpperCase()}`);
      if (isRefusal(rows)) return rows;
      const out: EarnProduct[] = [];
      for (const r of rows) {
        const p = await productOf(r);
        if (p && (!token || same(p.asset, token))) out.push(p);
      }
      return out;
    },
    async product(id) {
      const m = VAULT_ID.exec(id.trim());
      if (!m) return no("E_ACCOUNT_BAD_ACTION", { venue, message: `a vault here is <chain id>:<vault address> (for example 8453:0x…), not "${id.slice(0, 60)}"` });
      const chainId = m[1]!;
      lists.delete(`chain|${chainId}`);
      const rows = await vaults(["earn", "markets", "--chain-id", chainId, "--limit", "200", "--json"], `chain|${chainId}`);
      if (isRefusal(rows)) return rows;
      const row = rows.find((r) => same(str(r.address), m[2]!));
      const listed = row ? await productOf(row) : undefined;
      if (listed) return listed;
      // a vault mm no longer lists (it stopped taking deposits): money can still come out of it, where the wallet holds some
      const mine = await held();
      if (isRefusal(mine)) return mine;
      const pos = mine.find((r) => String(r.chainId) === chainId && same(str(r.vaultAddress), m[2]!));
      if (!pos) return no("E_VENUE_REJECTED", { venue, message: `${EARN}: mm lists no vault ${short(m[2]!)} on ${chainOf(Number(chainId))} that takes deposits and withdrawals, and the wallet holds nothing in it` });
      const asset = str(obj(pos.asset)?.symbol);
      const price = await priceOf(asset);
      return { id: `${chainId}:${m[2]!.toLowerCase()}`, asset, name: `${str(obj(pos.asset)?.name) || asset}${str(pos.protocolName) ? ` · ${str(pos.protocolName)}` : ""}`, ...(str(pos.protocolName) ? { protocol: str(pos.protocolName) } : {}), chain: chainOf(Number(chainId)), ...(price !== undefined ? { priceUsd: price } : {}), lands: landsOn(Number(chainId)), canSupply: false, canWithdraw: true, why: `${EARN}: mm no longer lists this vault as taking deposits` };
    },
    async positions() {
      const rows = await held();
      if (isRefusal(rows)) return rows;
      return rows.flatMap((r) => {
        const chainId = Number(r.chainId);
        const address = str(r.vaultAddress);
        const amount = amountOfRow(r);
        if (!Number.isInteger(chainId) || !/^0x[0-9a-fA-F]{40}$/.test(address) || !(amount > 0)) return [];
        const id = `${chainId}:${address.toLowerCase()}`;
        const usd = knownFigure(r.balanceUsd);
        const apy = apys.get(id);
        const pos: EarnPosition = { product: id, id, asset: str(obj(r.asset)?.symbol), amount, ...(usd !== undefined ? { usd } : {}), ...(apy !== undefined ? { apy } : {}), name: `${str(obj(r.asset)?.name) || str(obj(r.asset)?.symbol)}${str(r.protocolName) ? ` · ${str(r.protocolName)}` : ""}`, chain: chainOf(chainId), ...(str(r.protocolName) ? { protocol: str(r.protocolName) } : {}) };
        return [pos];
      });
    },
    async supply(p, amount, clientId) {
      const v = vaultOf(p);
      if (isRefusal(v)) return v;
      // the vault's own chain, from the wallet: never --from-chain-id, so nothing is bridged on the way in
      const args = ["earn", "supply", "--vault", v.address, "--amount", plain(amount), "--chain-id", String(v.chainId), "--wallet-timeout", String(WALLET_TIMEOUT_S), "--json"];
      return send(args, `put ${plain(amount)} ${p.asset} into ${p.name}`, clientId);
    },
    async withdraw(p, amount, clientId, all) {
      const v = vaultOf(p);
      if (isRefusal(v)) return v;
      // back to the wallet itself, on the vault's chain: mm earn withdraw takes no destination
      const args = ["earn", "withdraw", "--vault", v.address, "--chain-id", String(v.chainId), ...(all ? ["--all"] : ["--amount", plain(amount)]), "--wallet-timeout", String(WALLET_TIMEOUT_S), "--json"];
      return send(args, `take ${all ? "all" : plain(amount)} ${p.asset} out of ${p.name}`, clientId);
    },
    /** a job that was waiting: `mm wallet requests list` (server-wallet mode) says whether Guard's approval came, was denied or lapsed */
    async status(ref) {
      if (/^0x[0-9a-fA-F]{64}$/.test(ref)) return { ref, status: "done", native: { hash: ref } };
      const job = /^job:([\w-]+)$/.exec(ref)?.[1];
      if (!job) return { ref, status: "pending", native: { note: "mm stopped waiting without naming its wallet job: mm wallet requests list shows it" } };
      const args = ["wallet", "requests", "list", "--json"];
      let data: unknown;
      try {
        data = await call(args, "MetaMask", `read wallet request ${job}`, "track");
      } catch (e) {
        return isRefusal(e) ? e : asRefusal(venue, "MetaMask", e);
      }
      const j = arr(obj(data)?.requests)
        .map(obj)
        .find((x) => str(x?.pollingId) === job);
      if (!j) return { ref, status: "pending", native: { command: cmd(args), job } };
      const st = str(j.status).toUpperCase();
      const hash = str(j.txHash);
      const native = { command: cmd(args), job: { pollingId: job, status: st, ...(hash ? { txHash: hash } : {}), ...(str(obj(j.intent)?.summary) ? { intent: str(obj(j.intent)?.summary) } : {}) } };
      if (st === "DENIED" || st === "EXPIRED" || st === "FAILED" || st === "BROADCAST_FAILED") return { ref, status: "rejected", native };
      // an approval's own transaction is not the deposit's: the job is done when its intent is the earn move itself and it has a hash
      if (hash && !/^approve\b/i.test(str(obj(j.intent)?.summary))) return { ref: hash, status: "done", native };
      return { ref, status: "pending", native };
    },
  };
}
