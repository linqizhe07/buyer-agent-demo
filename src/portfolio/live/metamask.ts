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
 *
 * No amend, close or leverage: mm 7.0.0 has no command that changes a Polymarket order in place or closes a position at its own call
 * (selling the shares is an order), and nothing of the kind for a swap. Its perpetuals have them, and this trader does not trade those.
 *
 * What moves money (`swap execute`, `predict place`) runs only when MetaMask's own switch is on as well as this server's:
 * PORTFOLIO_MM_WRITES=1, as for `mm transfer` (writes.ts). Otherwise the command that would run is printed and nothing runs. MetaMask's
 * Guard still judges every swap (its rolling 24-hour outflow, its allowlists): above its line it asks the owner by email or on MetaMask
 * Mobile, and mm waits up to ten minutes for the answer.
 */
import { execFile } from "node:child_process";
import { formatUnits, parseUnits } from "viem";
import { isRefusal, type Code, type Refusal } from "../../core/errors.ts";
import { holdingsOf, type MmBalance, type MmShow } from "../adapters/metamask.ts";
import { no } from "../refuse.ts";
import { CHAINS, STABLECOINS, type ChainName } from "./chain.ts";
import { badOrder, ceilTo, DONE, floorTo, inDollars, onStep, pick, plain, type LiveTrader, type Market, type OrderRequest, type OrderState, type OrderStatus, type Position, type TimeInForce } from "./trade.ts";
import { num, redact, REGION, type LiveBalance, type LiveSource } from "./types.ts";
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
 * Anything else (a crash, a Node too old for mm) is UNPARSEABLE with mm's raw words. */
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
  if (exitCode === 0) {
    const summary = lines.find((o) => o !== undefined && "_summary" in o);
    if (summary) return { ok: true, data: summary._summary, notices };
    const whole = obj(jsonOf(stdout));
    if (whole?.ok === true && "data" in whole) return { ok: true, data: whole.data, notices };
  }
  const errLines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .reverse();
  const error = failureIn(jsonOf(stderr)) ?? errLines.map((l) => failureIn(jsonOf(l))).find((f) => f !== undefined) ?? failureIn(jsonOf(stdout)) ?? lines.map((o) => failureIn(o)).find((f) => f !== undefined);
  if (error) return { ok: false, error, notices };
  const raw = (stderr.trim() || stdout.trim()).replace(/\s+/g, " ").slice(0, 300);
  return { ok: false, error: { code: "UNPARSEABLE", message: raw || `mm exited with ${exitCode ?? "a signal"} and said nothing` }, notices };
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

export async function metamaskSource(req: { venue: string; label: string; run: RunMm; env?: Record<string, string | undefined> | undefined; now?: (() => number) | undefined }): Promise<{ source: LiveSource; first: LiveBalance[] } | Refusal> {
  const name = req.label || "MetaMask Agent Wallet";
  const env = req.env ?? process.env;
  // redacted before it is cut short, so half a secret is never kept
  const saidOf = (err: unknown): string => redact(String((err as Error)?.message ?? err), [env.MM_PASSWORD, env.MM_MNEMONIC]).slice(0, 200);
  let show: MmShow;
  try {
    show = await req.run<MmShow>(["wallet", "show"]);
  } catch (err) {
    const said = saidOf(err);
    return no("E_ACCOUNT_CREDENTIAL", { venue: req.venue, message: /ENOENT|not found/i.test(said) ? "the mm command line is not installed on this machine" : "mm could not show the wallet: sign in with the mm command line first (mm wallet show must work in a terminal)", native: { said } });
  }
  const yaml = show.policyYaml ?? "";
  const rolling = /rolling_24h:\s*([\d.]+)/.exec(yaml)?.[1];
  const read = async (): Promise<LiveBalance[]> => {
    let b: MmBalance;
    try {
      b = await req.run<MmBalance>(["wallet", "balance"]);
    } catch (err) {
      throw no("E_VENUE_UNREACHABLE", { venue: req.venue, message: "mm could not read the balance", native: { said: saidOf(err) } });
    }
    return holdingsOf(b).map((h) => ({ asset: h.asset, amount: h.amount, usd: h.usd, ...(h.note ? { where: h.note } : {}) }));
  };
  try {
    const first = await read();
    const trader = mmTrader({ venue: req.venue, name, address: show.address, run: req.run, env, now: req.now ?? Date.now });
    const source: LiveSource = { name, kind: "agent-wallet", reference: "the mm command line's session on this machine", via: "MetaMask · mm command line", address: show.address, probe: { can: ["read", "transfer", "swap"], note: `MetaMask's Guard decides what goes out without asking (${rolling !== undefined ? `$${rolling} a rolling day` : "its policy"}); above that it asks you by email`, native: { address: show.address, tradingMode: show.tradingMode, rolling24h: rolling ?? null } }, read, writer: mmWriter(show.address as `0x${string}`, req.run, req.env), trader };
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

const INSUFFICIENT = new Set(["INSUFFICIENT_FUNDS", "INSUFFICIENT_GAS", "PREDICT_INSUFFICIENT_BALANCE", "PREDICT_INSUFFICIENT_FUNDING_BALANCE", "PREDICT_INSUFFICIENT_GAS"]);
const INVALID = new Set(["INVALID_AMOUNT", "INVALID_INPUT", "INVALID_SWAP_PARAMS", "AMOUNT_TOO_LOW", "AMOUNT_TOO_HIGH", "SLIPPAGE_TOO_HIGH", "SLIPPAGE_TOO_LOW", "TOKEN_NOT_FOUND", "TOKEN_NOT_SUPPORTED", "NATIVE_ASSET_UNSUPPORTED", "UNSUPPORTED_CHAIN", "REFUEL_UNSUPPORTED_ROUTE", "RWA_NATIVE_TOKEN_UNSUPPORTED", "INVALID_TICK_SIZE", "INVALID_ORDER_TYPE", "INVALID_SIDE", "PREDICT_ORDER_SIZE_TOO_SMALL", "MISSING_FLAG", "MISSING_SWAP_PARAMS", "MISSING_CHAIN", "INVALID_CHAIN"]);
const PERMISSION = new Set(["WRONG_WALLET_MODE", "TX_DENIED", "TX_EXPIRED", "PREDICT_SETUP_REQUIRED", "PREDICT_AUTH_REQUIRED", "PREDICT_INSUFFICIENT_ALLOWANCE"]);
const UNAUTHORIZED = new Set(["AUTH_FAILED", "AUTH_ERROR", "TOKEN_INVALID", "TOKEN_REFRESH_FAILED", "NOT_INITIALIZED", "PREDICT_AUTH_INVALID"]);
const REGION_CODES = new Set(["PREDICT_GEOBLOCKED", "PREDICT_UNAVAILABLE_FOR_LEGAL_REASONS", "RWA_GEO_RESTRICTED"]);
const DOWN = new Set(["RATE_LIMITED", "NETWORK_UNREACHABLE", "QUOTE_RETRY", "MM_TIMEOUT", "ENOENT", "UNSUPPORTED_NODE"]);
const UNKNOWN_ORDER = new Set(["QUOTE_NOT_FOUND", "MISSING_QUOTE_ID", "REQUEST_NOT_FOUND"]);
/** a swap mm stopped waiting for that MetaMask may still send: JOB_TIMEOUT and RELAY_TIMEOUT say "the job may still complete"; an execute
 * that ended with no envelope at all (killed, crashed) may have submitted its job too (trade spec 1.4) */
const MAY_LAND = new Set(["JOB_TIMEOUT", "RELAY_TIMEOUT", "MM_TIMEOUT", "ABORTED", "UNPARSEABLE"]);

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
interface Seen {
  m: Market;
  at: number;
  spot: SwapSpot | PmSpot;
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
}

type Parsed = { kind: "swap"; token: string; chain: ChainName } | { kind: "predict"; tokenId: string } | { kind: "predict"; slug: string; outcome: string };

/** `ETH/USDC@Base` is a swap; `<slug>:<outcome>` or an outcome's token id is a Polymarket order */
function parseSymbol(venue: string, symbol: string): Parsed | Refusal {
  const s = symbol.trim();
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
  return no("E_ACCOUNT_BAD_ACTION", { venue, message: "a market here is a swap, <TOKEN>/USDC@<chain> (for example ETH/USDC@Base), or a Polymarket outcome, <market slug>:<outcome> (for example will-it-rain-tomorrow:Yes)" });
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
  /** where MetaMask's own switch is read: PORTFOLIO_MM_WRITES */
  env: Record<string, string | undefined>;
  now: () => number;
}

export function mmTrader(d: MmTraderDeps): LiveTrader {
  const { venue, run, env, now } = d;
  // the BYOK secrets mm reads from its environment (its skill: set MM_PASSWORD and MM_MNEMONIC rather than pass them inline)
  const secrets = [env.MM_PASSWORD, env.MM_MNEMONIC];
  // redacted before the whitespace is folded, so a secret over several lines is still found
  const said = (s: string): string => redact(s, secrets).replace(/\s+/g, " ").trim().slice(0, 240);
  const cmd = (args: string[]): string => `mm ${args.join(" ")}`;
  const writesOn = (): boolean => env.PORTFOLIO_MM_WRITES === "1";
  const off = (commands: string[][]): Refusal =>
    no("E_WALLET_LIVE_WRITES_OFF", { venue, message: `MetaMask's own switch is off (PORTFOLIO_MM_WRITES is not 1). ${commands.length > 1 ? "The commands that would run" : "The command that would run"}: ${commands.map(cmd).join(", then ")}`, detail: { commands: commands.map(cmd) } });

  const seen = new Map<string, Seen>();
  const infos = new Map<string, PmInfo>();
  /** what place() knew of a swap, for reading its fill: lost on a restart, when mm's own legs are read instead */
  const swaps = new Map<string, { side: "buy" | "sell"; qty: number; spent: number; feeUsd: number | undefined }>();
  /** mm takes no client order id (7.0.0), so the account's id is honoured here: a retry with it is the same order, not a second one */
  const placing = new Map<string, Promise<OrderState | Refusal>>();
  let chains: { at: number; list: ChainName[] } | undefined;

  const failureOf = (err: unknown): MmFailure & { notices: MmNotice[] } => {
    if (err instanceof MmError) return { code: err.code, message: err.said, hint: err.hint, notices: err.notices };
    const text = String((err as { message?: unknown })?.message ?? err);
    // the older runner (adapters/metamask.ts) put mm's error object into the message as JSON
    const j = obj(jsonOf(text));
    if (j && (j.code !== undefined || j.message !== undefined)) return { code: str(j.code) || "UNKNOWN", message: str(j.message), hint: str(j.hint) || undefined, notices: [] };
    return { code: /ENOENT/.test(text) ? "ENOENT" : "UNKNOWN", message: text, notices: [] };
  };

  /** mm's refusal as the account's, with mm's own code and words in `native` */
  const saidNo = (f: MmFailure, who: string, doing: string, args: string[], when: "order" | "track"): Refusal => {
    const words = said(f.message);
    const native = { command: cmd(args), code: f.code, said: words, ...(f.hint ? { hint: said(f.hint) } : {}) };
    const say = (code: Code, message: string): Refusal => no(code, { venue, message, native });
    const m = f.message;
    if (REGION_CODES.has(f.code) || /closed only mode/i.test(m) || REGION.test(m)) return say("E_VENUE_GEOBLOCKED", `${who} does not serve this location: that is its own rule, and the account does not look for a way around it`);
    if (INSUFFICIENT.has(f.code) || /insufficient (funds|balance|native balance|token balance)|not enough balance/i.test(m)) return say("E_VENUE_INSUFFICIENT", `${who}: not enough to ${doing} (${words})`);
    if (f.code === "TX_DENIED" || f.code === "TX_EXPIRED") return say("E_VENUE_PERMISSION", `MetaMask's Guard asked you to approve this, and ${f.code === "TX_DENIED" ? "it was denied" : "the approval window passed"}: nothing was sent`);
    if (f.code === "PREDICT_SETUP_REQUIRED" || f.code === "PREDICT_AUTH_REQUIRED") return say("E_VENUE_PERMISSION", `the wallet is not set up to trade on ${PM}: run mm predict setup --wait in a terminal first`);
    if (f.code === "PREDICT_INSUFFICIENT_ALLOWANCE") return say("E_VENUE_PERMISSION", `the Predict deposit wallet has not allowed ${PM}'s exchange to use its funds: run mm predict approve --wait in a terminal`);
    if (PERMISSION.has(f.code) || /address banned/i.test(m)) return say("E_VENUE_PERMISSION", `${who} refused to ${doing}: ${words}`);
    if (UNAUTHORIZED.has(f.code) || /unauthori[sz]ed|invalid api key/i.test(m)) return say("E_VENUE_UNAUTHORIZED", who === PM ? `${PM} no longer accepts mm's trading credentials: run mm predict auth --refresh in a terminal` : "mm is not signed in, or MetaMask no longer accepts its session: sign in with mm in a terminal (mm wallet show must work)");
    if (f.code === "RWA_MARKET_UNAVAILABLE" || /not yet ready|no orderbook exists|cancel-only|post-only mode|trading is currently disabled/i.test(m)) return say("E_VENUE_MARKET_CLOSED", `${who} takes no orders here now: ${words}`);
    // a post-only order that would have taken at once is refused as written ("invalid post-only order: order crosses book")
    if (INVALID.has(f.code) || /invalid price|invalid tick size|tick size rule|align to tick|lower than the minimum|invalid expiration|invalid post-only order|crosses (the )?book/i.test(m)) return { ...badOrder(venue, who, words), native };
    if (DOWN.has(f.code) || /too many requests|HTTP (429|5\d\d)|order timed out|\b425\b|ECONNRESET|ETIMEDOUT/i.test(m)) return say("E_VENUE_UNREACHABLE", f.code === "ENOENT" || f.code === "UNSUPPORTED_NODE" ? `mm could not run on this machine: ${words}` : `${who} did not answer in time, or is limiting requests: try again in a minute`);
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

  /** an execute mm stopped waiting for: Guard is asking the owner, or the job may still finish. It is pending, never refused, so it is not sent twice */
  function swapStuck(f: MmFailure & { notices: MmNotice[] }, q: Quoted, args: string[]): OrderState | Refusal {
    const mfa = (f.code === "EXECUTE_FAILED" && /awaiting MFA approval/i.test(f.message)) || f.notices.some((n) => n.kind === "AWAITING_MFA");
    const noHash = f.code === "EXECUTE_FAILED" && /no hash is available yet/i.test(f.message);
    if (!MAY_LAND.has(f.code) && !(f.code === "EXECUTE_FAILED" && (mfa || noHash))) return saidNo(f, SWAPS, `swap ${q.native.spend} for ${q.dst.symbol}`, args, "order");
    const job = f.notices.find((n) => str(n.pollingId))?.pollingId ?? /requests watch\s+([\w-]+)/.exec(`${f.hint ?? ""} ${f.message}`)?.[1] ?? /\(request ([\w-]+)\)/.exec(f.message)?.[1];
    return {
      ref: refOf(q.id, undefined, job),
      status: "pending",
      filledQty: 0,
      ...(q.feeUsd !== undefined ? { feeUsd: q.feeUsd } : {}),
      native: { command: cmd(args), quote: q.native, waiting: mfa ? "MetaMask's Guard asked you to approve this swap, by email or on MetaMask Mobile: it goes when you approve it" : "mm stopped waiting before it saw the swap sent: MetaMask may still send it", code: f.code, said: said(f.message), ...(job ? { pollingId: job } : {}) },
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
      return e as Refusal;
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
      return e as Refusal;
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

  /** `mm predict markets get --market <slug | id | condition id>`: kept five minutes for lookups, asked again for a fresh market */
  async function pmInfo(key: string, fresh: boolean): Promise<PmInfo | Refusal> {
    const hit = infos.get(key.toLowerCase());
    if (hit && !fresh && now() - hit.at < LIST_MS) return hit;
    const args = ["predict", "markets", "get", "--market", key, "--json"];
    let data: unknown;
    try {
      data = await call(args, PM, `look up ${key}`, "order");
    } catch (e) {
      return e as Refusal;
    }
    const m = obj(obj(obj(data)?.result)?.market);
    if (!m) return unread(PM, args);
    const info: PmInfo = { slug: str(m.slug), question: str(m.question) || str(m.slug), conditionId: str(m.conditionId), outcomes: outcomesOf(m), active: m.active === true, closed: m.closed === true, accepting: m.acceptingOrders !== false, orderBook: m.enableOrderBook !== false, endDate: str(m.endDate), tick: num(m.orderPriceMinTickSize), min: num(m.orderMinSize), at: now() };
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
      return e as Refusal;
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
    const m: Market = { symbol, name: `${info.question} · ${outcome.name}`, kind: "event", base: outcome.name, quote: "pUSD", price: price !== undefined ? sig(price) : undefined, bid: book.bid, ask: book.ask, minQty: min || undefined, qtyStep: 0.01, priceStep: tick, open: why === undefined, note: why ?? PM_NOTE, types: ["limit", "market"], tifs: [...PM_TIFS], postOnly: true, sellsReduce: true };
    seen.set(symbol.toUpperCase(), { m, at: now(), spot: { kind: "predict", tokenId, conditionId: info.conditionId, tick, min } });
    return m;
  }

  /** `mm predict geoblock`: Polymarket's own check of where this machine is. Blocked, and nothing else is asked */
  async function geoblock(args: string[]): Promise<Refusal | undefined> {
    let data: unknown;
    try {
      data = await call(args, PM, "say whether it serves this location", "order");
    } catch (e) {
      return e as Refusal;
    }
    const g = obj(obj(data)?.result) ?? obj(data);
    // the IP mm reports is left out of everything kept
    const where = { country: str(g?.country), region: str(g?.region) };
    if (g?.blocked === true) return no("E_VENUE_GEOBLOCKED", { venue, message: `${PM} does not take orders from this location (${[where.country, where.region].filter(Boolean).join("-") || "as mm predict geoblock says"}): that is its own rule, and the account does not look for a way around it. Nothing was placed`, native: { command: cmd(args), blocked: true, ...where } });
    if (g?.blocked !== false) return no("E_VENUE_REJECTED", { venue, message: `mm did not say whether ${PM} serves this location, so nothing was placed`, native: { command: cmd(args) } });
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
    const blocked = await geoblock(geo);
    if (blocked) return blocked;
    let data: unknown;
    try {
      data = await call(args, PM, `${o.side} ${plain(o.qty)} ${m.base} shares in ${m.name}`, "order", { timeoutMs: MM_WRITE_TIMEOUT_MS });
    } catch (e) {
      return e as Refusal;
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
      return e as Refusal;
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
      return e as Refusal;
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

  // ---- the trader --------------------------------------------------------------------------------------

  async function market(symbol: string): Promise<Market | Refusal> {
    const p = parseSymbol(venue, symbol);
    if (isRefusal(p)) return p;
    return p.kind === "swap" ? swapMarket(p) : pmMarket(p);
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
    return s.spot.kind === "swap" ? placeSwap(o, s as Seen & { spot: SwapSpot }) : placePm(o, s as Seen & { spot: PmSpot });
  }

  /** the chains mm swaps on (`mm chains list`, kept five minutes), among those with a pinned USDC */
  async function swapChains(): Promise<ChainName[] | Refusal> {
    if (chains && now() - chains.at < LIST_MS) return chains.list;
    const args = ["chains", "list", "--json"];
    let data: unknown;
    try {
      data = await call(args, "MetaMask", "list its chains", "order");
    } catch (e) {
      return e as Refusal;
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
    return info.outcomes.map((o) => ({ symbol: info.slug ? `${info.slug}:${o.name}` : o.tokenId, name: `${info.question} · ${o.name}`, kind: "event", base: o.name, quote: "pUSD", price: o.price || undefined, minQty: info.min || undefined, qtyStep: 0.01, priceStep: info.tick || undefined, open: why === undefined, note: why ?? PM_NOTE, types: ["limit", "market"], tifs: [...PM_TIFS], postOnly: true, sellsReduce: true }));
  };
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
    what: `token swaps against USDC on ${SWAP_CHAINS.join(", ")}, and Polymarket prediction orders, sent by MetaMask's mm`,
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
      const key = q ? pmKey(q) : undefined;
      if (key) {
        const info = await pmInfo(key, false);
        if (!isRefusal(info)) out.push(...pmListed(info));
      }
      return out.slice(0, 20);
    },
    market,
    place(o) {
      const prior = placing.get(o.clientId);
      if (prior) return prior;
      const p = placeOnce(o);
      placing.set(o.clientId, p);
      // a refusal placed nothing: the same id may be tried again
      void p.then((r) => {
        if (isRefusal(r)) placing.delete(o.clientId);
      });
      return p;
    },
    async cancel(ref, symbol) {
      const p = parseSymbol(venue, symbol);
      if (isRefusal(p)) return p;
      if (p.kind === "predict") return cancelPm(ref, symbol);
      const s = await swapStatus(ref, symbol);
      if (isRefusal(s) || DONE.has(s.status)) return s;
      return no("E_VENUE_REJECTED", { venue, message: `${SWAPS} have no cancel: a swap mm sent lands whole or reverts on chain, and one waiting for Guard's approval is stopped by denying it in the email or on MetaMask Mobile`, native: s.native });
    },
    async status(ref, symbol) {
      const p = parseSymbol(venue, symbol);
      if (isRefusal(p)) return p;
      if (p.kind === "swap") return swapStatus(ref, symbol);
      const r = await pmOpen(ref, symbol);
      return isRefusal(r) ? r : r.state;
    },
    // what is held at Polymarket. No amend, close or setLeverage: mm has no command for any of them here (selling the shares is an order)
    positions: pmPositions,
  };
}
