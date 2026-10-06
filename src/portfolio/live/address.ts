/** Venues that are read by ADDRESS: no key, no credential — what the venue or the chain says about an address.
 *
 *   a wallet        dollar stablecoins and the chain's own coin on seven EVM chains, read from the chains (chain.ts) — USDG on Robinhood
 *                   Chain among them, the dollar its Stock Tokens are bought and sold with — Robinhood's Stock Tokens on Robinhood Chain,
 *                   priced by Robinhood's own bid (robinhood.ts), and the best-known Ondo Stocks and xStocks, priced by LI.FI (dex.ts).
 *                   The tokenised shares are held as RWAs, and a proven wallet sells each through the market its row finds by symbol
 *                   and chain (`NVDA/USDG@Robinhood Chain`, `NVDAon/USDC@Ethereum`)
 *   Hyperliquid     POST /info `clearinghouseState` (perps: account value, withdrawable) and `spotClearinghouseState` (spot balances)
 *   Polymarket      GET data-api /v2/positions?user= (title, outcome, current_size, current_value) + pUSD at that address on Polygon
 *   Ondo            OUSG, rOUSG and USDY at an address on Ethereum, priced by Ondo's own on-chain oracle
 *
 * An address is public: anyone can read it. Whether it is the USER's is a separate question, answered by the wallet signing a sentence
 * (proof.ts) — `proven` says which it is, and the page shows a watched address as watched.
 */
import { getAddress, isAddress, type Hex } from "viem";
import type { Refusal } from "../../core/errors.ts";
import { no } from "../refuse.ts";
import { STABLECOINS, type ChainName, type ChainReader, type TokenRef } from "./chain.ts";
import { dexTrader, issuedHoldings, USDG_ROBINHOOD } from "./dex.ts";
import { stockTokenHoldings } from "./robinhood.ts";
import { walletWriter } from "./writes.ts";
import { walletBridge } from "./wallet-bridge.ts";
import { asRefusal, num, unreachable, venueSaidNo, type Http, type LiveBalance, type LiveProbe, type LiveSource } from "./types.ts";

export interface AddressRequest {
  venue: string;
  label: string;
  address: string;
  /** the wallet that proved the address is the user's, when one did */
  proven?: string | undefined;
  http: Http;
  chain: ChainReader;
}

type Opened = { source: LiveSource; first: LiveBalance[] } | Refusal;

const checked = (venue: string, address: string): Hex | Refusal => (isAddress(address, { strict: false }) ? getAddress(address) : no("E_ACCOUNT_BAD_ACTION", { venue, message: "an address is 0x and forty hex digits" }));
const whose = (proven: string | undefined): string => (proven ? `proven yours: ${proven} signed for it` : "watched, not proven yours: nobody signed for it");
const probeOf = (req: AddressRequest, note: string, native: unknown): LiveProbe => ({ can: [], note: `${whose(req.proven)} · ${note}`, native });

// ---- a wallet -----------------------------------------------------------------------------

export { STABLECOINS };
const ALL_CHAINS: ChainName[] = ["Ethereum", "Optimism", "BNB Chain", "Polygon", "Base", "Arbitrum", "Robinhood Chain"];

export async function walletSource(req: AddressRequest): Promise<Opened> {
  const address = checked(req.venue, req.address);
  if (typeof address !== "string") return address;
  const name = req.label || req.proven || "Wallet";
  let unread: string[] = [];
  const read = async (): Promise<LiveBalance[]> => {
    const [tokens, coins, stocks, issued] = await Promise.all([
      req.chain.tokens(address, [...STABLECOINS, USDG_ROBINHOOD]),
      req.chain.native(address, ALL_CHAINS),
      stockTokenHoldings(address, req.chain, req.http, Date.now()),
      issuedHoldings(address, req.chain, req.http).catch(() => ({ rows: [] as LiveBalance[], failed: ["Ethereum", "BNB Chain"] as ChainName[] })),
    ]);
    const chains = [...new Set([...tokens.failed, ...coins.failed])];
    if (chains.length === ALL_CHAINS.length) throw no("E_VENUE_UNREACHABLE", { venue: req.venue, message: "none of the chains answered: the public endpoints may be rate-limiting this machine" });
    unread = [...new Set<string>([...chains, ...issued.failed]), ...(stocks.unread ? [stocks.unread] : [])];
    // USDG is a dollar (Paxos's), counted one for one like every other dollar stablecoin here
    const dollar = (b: { asset: string; amount: number; chain: ChainName }): LiveBalance => (b.chain === USDG_ROBINHOOD.chain && b.asset === USDG_ROBINHOOD.asset ? { asset: b.asset, amount: b.amount, usd: b.amount, where: b.chain, class: "stable" } : { asset: b.asset, amount: b.amount, where: b.chain });
    return [...[...tokens.rows, ...coins.rows].filter((b) => b.amount > 0).map(dollar), ...stocks.rows, ...issued.rows];
  };
  try {
    const first = await read();
    const source: LiveSource = { name, kind: "agent-wallet", reference: address, via: `${req.proven ?? "an address"} · read from the chains`, address, writer: { ...walletWriter(address, req.chain), bridge: walletBridge(address, req.chain, req.http, req.venue) }, trader: dexTrader({ venue: req.venue, address, proven: req.proven, http: req.http, chain: req.chain }), probe: probeOf(req, `dollar stablecoins and each chain's own coin on ${ALL_CHAINS.join(", ")}, and Robinhood's Stock Tokens and the best-known Ondo Stocks and xStocks${unread.length ? ` (no answer this time: ${unread.join("; ")})` : ""}`, { address, chains: ALL_CHAINS, unread }), read };
    return { source, first };
  } catch (err) {
    return asRefusal(req.venue, name, err);
  }
}

// ---- Hyperliquid --------------------------------------------------------------------------

const HL_INFO = "https://api.hyperliquid.xyz/info";

export async function hyperliquidSource(req: AddressRequest): Promise<Opened> {
  const address = checked(req.venue, req.address);
  if (typeof address !== "string") return address;
  const name = req.label || "Hyperliquid";
  const info = async (type: string): Promise<Record<string, unknown>> => {
    let r;
    try {
      r = await req.http(HL_INFO, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type, user: address }) });
    } catch (err) {
      throw unreachable(req.venue, name, err);
    }
    if (r.status !== 200 || !r.body || typeof r.body !== "object") throw venueSaidNo(req.venue, name, r.status, r.text);
    return r.body as Record<string, unknown>;
  };
  const read = async (): Promise<LiveBalance[]> => {
    const perps = await info("clearinghouseState");
    const spot = await info("spotClearinghouseState");
    const margin = (perps.marginSummary ?? {}) as Record<string, unknown>;
    const out: LiveBalance[] = [];
    // the perps ledger is one dollar figure: what the account is worth there, open positions marked
    if (num(margin.accountValue) > 0) out.push({ asset: "USDC", amount: num(margin.accountValue), usd: num(margin.accountValue), where: `perps · ${num(perps.withdrawable).toFixed(2)} withdrawable`, class: "stable" });
    for (const b of (Array.isArray(spot.balances) ? spot.balances : []) as Array<Record<string, unknown>>) if (num(b.total) > 0) out.push({ asset: String(b.coin ?? "?"), amount: num(b.total), where: "spot" });
    return out;
  };
  try {
    const first = await read();
    const source: LiveSource = { name, kind: "perp", reference: address, via: "Hyperliquid info API · by address", address, readOnlyBecause: "Hyperliquid moves money only on a signature by the account's own key, and it does not serve this location: it is read, never written", noTradeBecause: "Hyperliquid does not serve this location, and it has no check the account could ask first: no order is placed there from here", probe: probeOf(req, "the perps account value and the spot balances are two ledgers, reported as the venue reports them", { calls: ["POST /info clearinghouseState", "POST /info spotClearinghouseState"], user: address }), read };
    return { source, first };
  } catch (err) {
    return asRefusal(req.venue, name, err);
  }
}

// ---- Polymarket ---------------------------------------------------------------------------

const PM_DATA = "https://data-api.polymarket.com/v2";
/** Polymarket's collateral token since 2026-04-28 (docs.polymarket.com/concepts/pusd): pUSD on Polygon */
const PUSD: TokenRef = { chain: "Polygon", asset: "pUSD", address: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB" };

export async function polymarketSource(req: AddressRequest): Promise<Opened> {
  const address = checked(req.venue, req.address);
  if (typeof address !== "string") return address;
  const name = req.label || "Polymarket";
  let cashUnread = false;
  const read = async (): Promise<LiveBalance[]> => {
    const out: LiveBalance[] = [];
    let cursor = "";
    for (let page = 0; page < 5; page++) {
      let r;
      try {
        r = await req.http(`${PM_DATA}/positions?user=${address}&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { headers: { accept: "application/json" } });
      } catch (err) {
        throw unreachable(req.venue, name, err);
      }
      if (r.status !== 200 || !r.body || typeof r.body !== "object") throw venueSaidNo(req.venue, name, r.status, r.text);
      const body = r.body as { data?: unknown; pagination?: { next_cursor?: unknown } };
      // an outcome held is named as an order there names it, <slug>:<outcome> (polymarket-clob.ts positionOf), so that it is one holding
      // with the account's own orders in it and what they cost; its question in words goes beside it
      for (const p of (Array.isArray(body.data) ? body.data : []) as Array<Record<string, unknown>>) {
        if (!(num(p.current_size) > 0)) continue;
        const slug = typeof p.slug === "string" ? p.slug : "";
        const outcome = typeof p.outcome === "string" ? p.outcome : "";
        const title = String(p.title ?? (slug || "?")).slice(0, 60);
        const named = /^[a-z0-9][a-z0-9-]*$/i.test(slug) && outcome !== "" && !outcome.includes(":");
        out.push({ asset: named ? `${slug}:${outcome}` : `${title} · ${outcome || "?"}`, amount: num(p.current_size), usd: num(p.current_value), where: `${named ? `${title} · ` : ""}${p.redeemable === true ? "redeemable" : "open"}`, class: "event" });
      }
      cursor = typeof body.pagination?.next_cursor === "string" ? body.pagination.next_cursor : "";
      if (!cursor) break;
    }
    // the cash is a token at the same address, on Polygon
    const cash = await req.chain.tokens(address, [PUSD]);
    cashUnread = cash.failed.length > 0;
    for (const b of cash.rows) if (b.amount > 0) out.push({ asset: "pUSD", amount: b.amount, usd: b.amount, where: "cash · Polygon", class: "stable" });
    return out;
  };
  try {
    const first = await read();
    const source: LiveSource = { name, kind: "prediction", reference: address, via: "Polymarket Data API · by address", address, readOnlyBecause: "money goes in and out of Polymarket at Polymarket", noTradeBecause: "connected by its address, it is only read: to trade, connect Polymarket with the account wallet's key (Polymarket's own location check comes first)", probe: probeOf(req, `the address is the account wallet Polymarket shows in the profile menu, not the key that signs for it${cashUnread ? " · the cash could not be read from Polygon this time" : ""}`, { calls: ["GET /v2/positions?user=", "balanceOf pUSD on Polygon"], user: address }), read };
    return { source, first };
  } catch (err) {
    return asRefusal(req.venue, name, err);
  }
}

// ---- Ondo ---------------------------------------------------------------------------------

/** Ondo's tokens on Ethereum and where each one's price is read (docs.ondo.finance/addresses, read 2026-10-05). The price is Ondo's own:
 * `getAssetPrice(token)` on its oracle for OUSG, `getPrice()` on the USDY wrapper; both answer dollars with 18 decimals. */
const ONDO_ORACLE: Hex = "0x9Cad45a8BF0Ed41Ff33074449B357C7a1fAb4094";
const USDY_ORACLE: Hex = "0x87b126e5518b6a1Bb8465779b4607C45C643DF90";
const ONDO_TOKENS: TokenRef[] = [
  { chain: "Ethereum", asset: "OUSG", address: "0x1B19C19393e2d034D8Ff31ff34c81252FcBbee92" },
  { chain: "Ethereum", asset: "rOUSG", address: "0x54043c656F0FAd0652D9Ae2603cDF347c5578d00" },
  { chain: "Ethereum", asset: "USDY", address: "0x96F6eF951840721AdBF46Ac996b59E0235CB985C" },
];

export async function ondoSource(req: AddressRequest): Promise<Opened> {
  const address = checked(req.venue, req.address);
  if (typeof address !== "string") return address;
  const name = req.label || "Ondo";
  const read = async (): Promise<LiveBalance[]> => {
    const held = await req.chain.tokens(address, ONDO_TOKENS);
    if (held.failed.length) throw no("E_VENUE_UNREACHABLE", { venue: req.venue, message: "Ethereum did not answer: the public endpoint may be rate-limiting this machine" });
    const dollars = (raw: bigint | undefined): number | undefined => (raw === undefined ? undefined : Number(raw) / 1e18);
    const ousg = dollars(await req.chain.uint("Ethereum", ONDO_ORACLE, "function getAssetPrice(address token) view returns (uint256)", [ONDO_TOKENS[0]!.address]));
    const usdy = dollars(await req.chain.uint("Ethereum", USDY_ORACLE, "function getPrice() view returns (uint256)"));
    // rOUSG is the rebasing form: each token is a dollar of the fund, by construction
    const price: Record<string, number | undefined> = { OUSG: ousg, rOUSG: 1, USDY: usdy };
    return held.rows.filter((b) => b.amount > 0).map((b) => ({ asset: b.asset, amount: b.amount, ...(price[b.asset] !== undefined ? { usd: b.amount * price[b.asset]! } : {}), where: "Ethereum", class: "rwa" as const }));
  };
  try {
    const first = await read();
    const source: LiveSource = { name, kind: "rwa", reference: address, via: "Ondo tokens on Ethereum · priced by Ondo's oracle", address, readOnlyBecause: "OUSG moves only between addresses Ondo has allowlisted, and subscribing or redeeming is done at Ondo: it is read, never written", noTradeBecause: "OUSG is subscribed and redeemed at Ondo, after Ondo's own checks: there is no order interface for the account to call", probe: probeOf(req, "OUSG, rOUSG and USDY at this address; the price is the one Ondo publishes on-chain, about once a business day", { tokens: ONDO_TOKENS.map((t) => t.address), oracle: ONDO_ORACLE }), read };
    return { source, first };
  } catch (err) {
    return asRefusal(req.venue, name, err);
  }
}
