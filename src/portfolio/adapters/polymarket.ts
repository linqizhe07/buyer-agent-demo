/** Polymarket as one account among the others: a prediction market. The
 * credential is a CLOB API key derived from the wallet's signature plus a
 * DEPOSIT WALLET on Polygon that holds pUSD and the outcome shares — the shape
 * MetaMask's `mm predict` sets up. Two shapes, one interface:
 *
 *   polymarketSimAccount   in-memory. `trade` fills an event contract against
 *                          the venue's book (venues.ts → events.ts): 5 shares
 *                          minimum, a taker fee, paid in pUSD. `move` is a
 *                          withdrawal of pUSD through the relayer; money sent
 *                          to the deposit wallet from another account (a bridge
 *                          from the on-chain wallet) is credited here. `redeem`
 *                          turns the winning shares of a settled market into
 *                          $1 each. The venue's own lines: a restricted region
 *                          gets no orders (PREDICT_GEOBLOCKED), a settled
 *                          market takes none.
 *   polymarketLiveAccount  reads the real `mm predict` (status, geoblock) and
 *                          the real market behind a contract (top of book, an
 *                          order preview — public data, no funds needed). When
 *                          the caller's region is restricted the credential's
 *                          scope simply has no `trade`. Writes build the exact
 *                          `mm predict` command and run it only when
 *                          PORTFOLIO_MM_WRITES=1.
 */
import { priceOf, r2, r8, usdOf, type Account, type AccountAdapter, type Capability, type Holding, type Intent, type LiveMarket } from "../accounts.ts";
import { eventState, parseEventSymbol, PREDICTION_VENUES } from "../events.ts";
import { no } from "../refuse.ts";
import { fillAt } from "../venues.ts";
import { mm, type MmLiveOptions } from "./metamask.ts";

export interface Geoblock {
  blocked: boolean;
  country?: string | undefined;
  region?: string | undefined;
}

export interface PolymarketSeed {
  depositWallet: string;
  pusd: number;
  positions: Array<{ symbol: string; shares: number }>;
  /** where the user is, as the venue sees it */
  geoblock?: Geoblock;
}

const V = PREDICTION_VENUES.polymarket!;
const place = (g: Geoblock) => `${g.country ?? "this region"}${g.region ? `-${g.region}` : ""}`;
const regionLimit = (g: Geoblock) => (g.blocked ? `region ${place(g)}: restricted, Polymarket takes no orders from here (PREDICT_GEOBLOCKED)` : `region ${place(g)}: not restricted`);
const RULES = [`orders: ${V.minOrder} shares minimum, matched on the CLOB; trades are signed by the deposit wallet, not the owner address`, "funds are pUSD on Polygon in the deposit wallet; deposits and withdrawals go through the relayer", "outcomes are decided by UMA's oracle; a winning share is redeemed at $1"];

/** a position as a holding: valued at the mark, or at $1 / $0 once the market has settled */
function positionRow(account: string, symbol: string, shares: number, now: string): Holding {
  const p = parseEventSymbol(symbol);
  const settled = p?.event.resolved;
  const row: Holding = { account, asset: symbol, amount: shares, usd: r2(shares * priceOf(symbol)), class: "event", note: p ? (settled ? `${p.event.title} · ${p.outcome} · settled ${settled}` : `${p.event.title} · ${p.outcome} · ${eventState(p.event, now) === "awaiting" ? "closed, awaiting resolution" : `closes ${p.event.closesAt.slice(0, 10)}`}`) : undefined };
  if (settled !== undefined && settled === p?.outcome) row.redeemable = true;
  return row;
}

export function polymarketSimAccount(seed: PolymarketSeed, now: () => string): AccountAdapter {
  let pusd = seed.pusd;
  const positions = new Map<string, number>(seed.positions.map((p) => [p.symbol, p.shares]));
  const geo: Geoblock = seed.geoblock ?? { blocked: false };
  let seq = 0;
  const can: Capability[] = geo.blocked ? ["read", "move", "redeem"] : ["read", "trade", "move", "redeem"];
  const account: Account = {
    id: "polymarket",
    name: "Polymarket",
    kind: "prediction",
    provider: "Polymarket (through MetaMask's mm predict)",
    credentialRef: "home/credentials/polymarket/clob-key.json",
    credentialKind: `CLOB API key + deposit wallet ${seed.depositWallet} (derived from the wallet's signature)`,
    scope: { can, limits: [regionLimit(geo), ...RULES], enforcedBy: "venue" },
    settlement: "the CLOB fills instantly · a market settles when UMA resolves the question · $1 per winning share",
    live: false,
    address: seed.depositWallet,
    chain: "Polygon",
    ...(geo.blocked ? { closed: { trade: `takes no orders from ${place(geo)}` } } : {}),
  };
  const short = (extra: Record<string, unknown>) => no("E_VENUE_INSUFFICIENT", { venue: "polymarket", native: { error: "not enough balance / allowance", ...extra } });
  return {
    account,
    credit(asset, amount) {
      if (asset === "USDC" || asset === "pUSD") pusd = r2(pusd + amount);
    },
    async read(): Promise<Holding[]> {
      const rows: Holding[] = [];
      if (pusd > 0) rows.push({ account: account.id, asset: "pUSD", amount: pusd, usd: pusd, class: "stable", note: "Polygon" });
      for (const [symbol, shares] of positions) if (shares > 0) rows.push(positionRow(account.id, symbol, shares, now()));
      return rows;
    },
    async execute(i: Intent) {
      if (i.kind === "trade") {
        const p = parseEventSymbol(i.symbol);
        if (!p || !p.event.listings.polymarket) return no("E_VENUE_REJECTED", { venue: "polymarket", message: `Polymarket lists no market for ${i.symbol}`, native: { error: "market not found" } });
        if (geo.blocked) return no("E_VENUE_GEOBLOCKED", { venue: "polymarket", message: `Polymarket takes no orders from ${place(geo)}`, native: { error: "PREDICT_GEOBLOCKED", country: geo.country, region: geo.region } });
        if (eventState(p.event, now()) === "resolved") return no("E_VENUE_MARKET_CLOSED", { venue: "polymarket", message: `"${p.event.title}" has settled (${p.event.resolved}); it takes no more orders`, native: { error: "market is closed", resolved: p.event.resolved } });
        if (i.qty < V.minOrder) return no("E_VENUE_REJECTED", { venue: "polymarket", message: `Polymarket takes orders of ${V.minOrder} shares or more`, native: { error: "INVALID_ORDER_MIN_SIZE", min: V.minOrder } });
        const f = fillAt("polymarket", i.symbol, i.side, i.qty);
        if (!f) return no("E_VENUE_REJECTED", { venue: "polymarket", message: "the book is not deep enough for this order", native: { error: "not enough liquidity to fill (FAK)" } });
        const held = positions.get(i.symbol) ?? 0;
        if (i.side === "buy") {
          if (pusd < f.netUsd) return short({ need: f.netUsd, have: pusd });
          pusd = r2(pusd - f.netUsd);
          positions.set(i.symbol, r8(held + i.qty));
        } else {
          if (held < i.qty) return short({ asset: i.symbol, have: held });
          positions.set(i.symbol, r8(held - i.qty));
          pusd = r2(pusd + f.netUsd);
        }
        const orderID = `0xpm${String(++seq).padStart(4, "0")}`;
        return { ok: true as const, account: account.id, status: "filled" as const, summary: `${i.side.toUpperCase()} ${i.qty} ${i.symbol} @ ${f.price} · fee ${f.feeUsd}`, usd: f.grossUsd, ref: `polymarket:order:${orderID}`, native: { orderID, status: "matched", price: f.price, grossUsd: f.grossUsd, feeUsd: f.feeUsd, netUsd: f.netUsd, impactBps: f.impactBps } };
      }
      if (i.kind === "move") {
        if (i.asset !== "pUSD" && i.asset !== "USDC") return no("E_VENUE_REJECTED", { venue: "polymarket", message: "only pUSD leaves the deposit wallet; outcome shares are sold or redeemed, not sent", native: { error: "unsupported asset" } });
        if (pusd < i.amount) return short({ need: i.amount, have: pusd });
        pusd = r2(pusd - i.amount);
        return { ok: true as const, account: account.id, status: "sent" as const, summary: `withdraw ${i.amount} pUSD → ${i.to} (Polygon, through the relayer)`, usd: usdOf(i), ref: `polymarket:withdraw:${++seq}`, native: { relayer: true } };
      }
      if (i.kind === "redeem") {
        const won = [...positions.entries()].find(([symbol, shares]) => shares > 0 && symbol.startsWith(`${i.fund}:`) && parseEventSymbol(symbol)?.event.resolved === parseEventSymbol(symbol)?.outcome);
        if (!won) return no("E_VENUE_REJECTED", { venue: "polymarket", message: `nothing to redeem for ${i.fund}: the market has not settled in this position's favour`, native: { error: "no redeemable position" } });
        const shares = Math.min(won[1], i.amountUsd);
        positions.set(won[0], r8(won[1] - shares));
        pusd = r2(pusd + shares);
        return { ok: true as const, account: account.id, status: "sent" as const, summary: `redeem ${shares} ${won[0]} → $${shares} pUSD`, usd: shares, ref: `polymarket:redeem:${++seq}`, native: { redeemed: shares, relayer: true } };
      }
      return no("E_VENUE_REJECTED", { venue: "polymarket", message: `a prediction-market account has no "${i.kind}" action`, native: { error: "unsupported" } });
    },
  };
}

// ---- live --------------------------------------------------------------------

interface PredictStatus {
  result?: { account?: { depositWalletAddress?: string; deployed?: boolean; credentials?: boolean; setupComplete?: boolean } };
}

interface PredictMarket {
  result?: { market?: { question?: string; conditionId?: string; bestBid?: number; bestAsk?: number; outcomes?: Array<{ name?: string; tokenId?: string }> } };
}

/** what `mm predict geoblock` says, without the caller's IP: the portfolio has no use for it */
export function geoblockOf(data: unknown): Geoblock {
  const r = ((data ?? {}) as { result?: { blocked?: unknown; country?: unknown; region?: unknown } }).result ?? {};
  return { blocked: r.blocked === true, country: typeof r.country === "string" ? r.country : undefined, region: typeof r.region === "string" ? r.region : undefined };
}

/** what the credential can do right now: nothing but reads until `mm predict setup` has run, and no orders from a restricted region */
export function liveScope(setupComplete: boolean, geo: Geoblock): Capability[] {
  const can: Capability[] = ["read"];
  if (setupComplete && !geo.blocked) can.push("trade");
  if (setupComplete) can.push("move", "redeem");
  return can;
}

export async function polymarketLiveAccount(opts: MmLiveOptions = {}): Promise<AccountAdapter> {
  const bin = opts.bin ?? "mm";
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const status = (await mm<PredictStatus>(bin, ["predict", "status"], timeoutMs)).result?.account ?? {};
  const geo = geoblockOf(await mm<unknown>(bin, ["predict", "geoblock"], timeoutMs));
  const setup = status.setupComplete === true;
  const wallet = status.depositWalletAddress ?? "";
  const account: Account = {
    id: "polymarket",
    name: "Polymarket",
    kind: "prediction",
    provider: "Polymarket (through MetaMask's mm predict · LIVE)",
    credentialRef: "~/.metamask-agent-wallet (mm predict)",
    credentialKind: `CLOB API key + deposit wallet ${wallet.slice(0, 10)}… (derived from the wallet's signature)`,
    scope: {
      can: liveScope(setup, geo),
      limits: [regionLimit(geo), `deposit wallet ${status.deployed ? "deployed" : "not deployed"} · ${status.credentials ? "CLOB credentials stored" : "no CLOB credentials"}${setup ? "" : " (mm predict setup has not been run)"}`, ...RULES],
      enforcedBy: "venue",
    },
    settlement: "the CLOB fills instantly · a market settles when UMA resolves the question · $1 per winning share",
    live: true,
    address: wallet,
    chain: "Polygon",
    ...(geo.blocked ? { closed: { trade: `takes no orders from ${place(geo)}` } } : setup ? {} : { closed: { trade: "has not been set up (mm predict setup)" } }),
  };
  const real = async (symbol: string) => {
    const p = parseEventSymbol(symbol);
    const slug = p?.event.listings.polymarket?.realSlug;
    if (!p || !slug) return undefined;
    const market = (await mm<PredictMarket>(bin, ["predict", "markets", "get", "--market", slug], timeoutMs)).result?.market;
    const tokenId = market?.outcomes?.find((o) => o.name?.toUpperCase() === p.outcome)?.tokenId;
    return market && tokenId ? { market, tokenId, outcome: p.outcome } : undefined;
  };
  return {
    account,
    async read(): Promise<Holding[]> {
      // nothing can be held before setup: no deposit wallet, no credentials. After setup the snapshot comes from `mm predict portfolio`; its shape has not been exercised (this wallet has never been set up)
      if (!setup) return [];
      const snap = await mm<{ result?: { balance?: unknown; pusd?: unknown } }>(bin, ["predict", "portfolio"], timeoutMs);
      const cash = Number(snap.result?.balance ?? snap.result?.pusd ?? NaN);
      return Number.isFinite(cash) && cash > 0 ? [{ account: account.id, asset: "pUSD", amount: cash, usd: r2(cash), class: "stable", note: "Polygon" }] : [];
    },
    /** the real market behind a contract: public data, read-only, works without funds and from a restricted region */
    async market(symbol: string, side: "buy" | "sell", qty: number): Promise<LiveMarket | undefined> {
      const m = await real(symbol);
      if (!m) return undefined;
      const yes = m.outcome === "YES";
      const { bestBid, bestAsk } = m.market;
      const q = (await mm<{ result?: { quote?: { filledSize?: number; cost?: number; proceeds?: number; averagePrice?: number } } }>(bin, ["predict", "quote", "--token-id", m.tokenId, "--side", side, "--size", String(qty)], timeoutMs)).result?.quote;
      return {
        question: m.market.question ?? symbol,
        bid: yes ? bestBid : bestAsk === undefined ? undefined : Number((1 - bestAsk).toFixed(4)),
        ask: yes ? bestAsk : bestBid === undefined ? undefined : Number((1 - bestBid).toFixed(4)),
        filled: q?.filledSize,
        averagePrice: q?.averagePrice,
        amountUsd: side === "buy" ? q?.cost : q?.proceeds,
      };
    },
    async execute(i: Intent) {
      if (i.kind === "trade" && geo.blocked) return no("E_VENUE_GEOBLOCKED", { venue: "polymarket", message: `Polymarket takes no orders from ${place(geo)}`, native: { error: "PREDICT_GEOBLOCKED", country: geo.country, region: geo.region } });
      if (!setup) return no("E_VENUE_REJECTED", { venue: "polymarket", message: "mm predict setup has not been run: there is no deposit wallet and no CLOB credential to act with", native: { error: "PREDICT_NOT_SET_UP" } });
      let cmd: string[] | undefined;
      if (i.kind === "trade") {
        const m = await real(i.symbol);
        const f = fillAt("polymarket", i.symbol, i.side, i.qty);
        if (m && f) cmd = [bin, "predict", "place", "--token-id", m.tokenId, "--side", i.side, "--size", String(i.qty), "--price", String(i.side === "buy" ? Math.ceil(f.price * 100) / 100 : Math.floor(f.price * 100) / 100), "--order-type", "FAK"];
      } else if (i.kind === "move") cmd = [bin, "predict", "withdraw", "--amount", String(i.amount), "--to", i.to];
      else if (i.kind === "redeem") cmd = [bin, "predict", "redeem", "--all"];
      if (!cmd) return no("E_VENUE_REJECTED", { venue: "polymarket", message: `no mm predict command for this "${i.kind}"`, native: { error: "UNSUPPORTED" } });
      const command = cmd.join(" ");
      if (process.env.PORTFOLIO_MM_WRITES !== "1") return no("E_WALLET_LIVE_WRITES_OFF", { venue: "polymarket", tool: `portfolio_${i.kind}`, message: `real-money writes are off (PORTFOLIO_MM_WRITES≠1). The command that would run: ${command}`, detail: { command, depositWallet: wallet } });
      try {
        const r = await mm<Record<string, unknown>>(bin, cmd.slice(1), timeoutMs);
        return { ok: true as const, account: account.id, status: "pending" as const, summary: `${command} → submitted`, usd: usdOf(i), ref: "polymarket:job", native: r };
      } catch (err) {
        return no("E_VENUE_REJECTED", { venue: "polymarket", message: "mm predict did not succeed", native: { error: (err as Error).message } });
      }
    },
  };
}
