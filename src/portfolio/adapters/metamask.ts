/** The MetaMask Agent Wallet as one account among the others — the on-chain
 * one: it swaps on DEX pools, it bridges, and it is the only account that can
 * be LIVE. Two shapes, one interface:
 *
 *   metamaskSimAccount   in-memory, holdings per chain. `trade` is a DEX swap
 *                        on ONE chain — the one the intent names, or the chain
 *                        where the swap nets the most among those that hold
 *                        enough. venues.ts prices it (`dex:<chain>`: the route
 *                        across that chain's pools, their LP fees, gas once),
 *                        and the proceeds land on that chain. A `move` whose chain
 *                        differs from the holding's is a BRIDGE over the route
 *                        the intent names (rails.ts quotes it); the fee comes
 *                        out of what arrives. Guard mode's own policy (24 h
 *                        outflow, allowlist) is simulated INSIDE the adapter
 *                        because it is MetaMask's rule, not the portfolio
 *                        wallet's: over the line a transfer comes back
 *                        AWAITING_MFA.
 *   metamaskLiveAccount  reads the real `mm` CLI (address, trading mode, the
 *                        policy YAML, balances), a real spot price (`mm price
 *                        spot`) and real swap / bridge quotes (`mm swap quote
 *                        --all-quotes`, which needs a funded wallet). Writes build
 *                        the exact `mm` command — `transfer`, or `swap
 *                        execute` for a swap or a bridge — and run it ONLY
 *                        when PORTFOLIO_MM_WRITES=1; otherwise they come back
 *                        as a structured refusal that carries the command, so
 *                        the demo never moves real money by accident.
 */
import { execFile } from "node:child_process";
import { no } from "../refuse.ts";
import { evmAddressOf, keyFromSeed } from "../../core/ed25519.ts";
import { baseOf, chainName, classOf, priceOf, r2, r8, usdOf, type Account, type AccountAdapter, type Holding, type Intent, type RouteQuote } from "../accounts.ts";
import { bridgeQuotes } from "../rails.ts";
import { chainKey, dexChains, dexVenue, fillAt, type Fill } from "../venues.ts";

export interface MetamaskSimSeed {
  seed: string;
  tradingMode: "guard" | "beast";
  rolling24hUsd: number;
  allowlist: string[];
  holdings: Array<{ asset: string; amount: number; chain: string }>;
}

const scopeLimits = (mode: string, rolling: number, allowlistCount: number) => [
  `trading mode ${mode}${mode === "guard" ? ": outflow policy + allowlist; over the line → MFA (approved by email)" : ": policy skipped, malicious transactions still blocked"}`,
  `24 h outflow limit $${rolling}${rolling === 0 ? " (= every transfer needs a human)" : ""}`,
  `address allowlist: ${allowlistCount} entr${allowlistCount === 1 ? "y" : "ies"}`,
  "server wallet: the key lives on MetaMask's side, the agent holds a CLI session; DEX swaps and bridges both go through mm swap",
];

/** the receipt of a swap: the fill, the chain, and how it was routed across that chain's pools */
const swapReceipt = (f: Fill) => ({ price: f.price, grossUsd: f.grossUsd, feeUsd: f.feeUsd, netUsd: f.netUsd, impactBps: f.impactBps, chain: f.chain, gasUsd: f.gasUsd, route: f.route });
const routeText = (f: Fill) => (f.route ?? []).map((r) => r.dex).join(" + ");

export function metamaskSimAccount(seed: MetamaskSimSeed, now: () => string): AccountAdapter {
  const holdings = seed.holdings.map((h) => ({ ...h }));
  const outflows: Array<{ at: string; usd: number }> = [];
  let seq = 0;
  const address = evmAddressOf(keyFromSeed(seed.seed).publicKeyHex);
  const account: Account = {
    id: "metamask",
    name: "MetaMask Agent Wallet",
    kind: "agent-wallet",
    provider: "MetaMask (server wallet)",
    credentialRef: "home/credentials/metamask/cli-session.json",
    credentialKind: `mm CLI session (from Google sign-in) · ${address.slice(0, 10)}…`,
    scope: { can: ["read", "trade", "move"], limits: scopeLimits(seed.tradingMode, seed.rolling24hUsd, seed.allowlist.length), enforcedBy: "metamask" },
    settlement: "on-chain confirmation · DEX swap · bridge · transfers over policy wait for MFA",
    live: false,
    address,
    chain: "Base",
  };
  const dayOut = (at: string) => r2(outflows.filter((o) => Date.parse(at) - Date.parse(o.at) < 24 * 3600 * 1000).reduce((s, o) => s + o.usd, 0));
  const credit = (asset: string, amount: number, chain = "Base") => {
    const h = holdings.find((x) => x.asset === asset && x.chain === chain);
    if (h) h.amount = r8(h.amount + amount);
    else holdings.push({ asset, amount, chain });
  };
  const insufficient = (extra: Record<string, unknown> = {}) => no("E_VENUE_INSUFFICIENT", { venue: "metamask", native: { error: "INSUFFICIENT_BALANCE", ...extra } });
  return {
    account,
    credit,
    async read(): Promise<Holding[]> {
      return holdings.filter((h) => h.amount > 0).map((h) => ({ account: account.id, asset: h.asset, amount: h.amount, usd: r2(h.amount * priceOf(h.asset)), class: classOf(h.asset), note: h.chain }));
    },
    async execute(i: Intent) {
      if (i.kind === "trade") {
        const base = baseOf(i.symbol);
        const named = chainName(i.chainId);
        const chains = dexChains(base).filter((c) => named === undefined || c === named);
        if (!chains.length) return no("E_VENUE_REJECTED", { venue: "metamask", message: `no ${base} pool on-chain${named ? ` (${named})` : ""}`, native: { error: "TOKEN_NOT_SUPPORTED" } });
        const sell = i.side === "sell";
        // a swap happens on one chain: among the chains that hold enough, the one where it nets the most
        const options = chains
          .map((chain) => ({ fill: fillAt(dexVenue(chain), base, i.side, i.qty), holding: holdings.find((x) => x.asset === (sell ? base : "USDC") && chainKey(x.chain) === chain) }))
          .filter((o): o is { fill: Fill; holding: (typeof holdings)[number] } => o.fill !== undefined && o.holding !== undefined && o.holding.amount >= (sell ? i.qty : o.fill.netUsd))
          .sort((a, b) => (sell ? b.fill.netUsd - a.fill.netUsd : a.fill.netUsd - b.fill.netUsd));
        const pick = options[0];
        if (!pick) return insufficient({ asset: sell ? base : "USDC", ...(named ? { chain: named } : {}) });
        const { fill: f, holding: h } = pick;
        const n = ++seq;
        if (sell) {
          h.amount = r8(h.amount - i.qty);
          credit(f.quote, f.netUsd, h.chain);
          return { ok: true as const, account: account.id, status: "filled" as const, summary: `swap ${i.qty} ${base} → ${f.netUsd} ${f.quote} on ${h.chain} via ${routeText(f)} · fee ${f.feeUsd}`, usd: f.grossUsd, ref: `metamask:swap:${n}`, native: swapReceipt(f) };
        }
        h.amount = r8(h.amount - f.netUsd);
        credit(base, i.qty, h.chain);
        return { ok: true as const, account: account.id, status: "filled" as const, summary: `swap ${f.netUsd} ${f.quote} → ${i.qty} ${base} on ${h.chain} via ${routeText(f)} · fee ${f.feeUsd}`, usd: f.grossUsd, ref: `metamask:swap:${n}`, native: swapReceipt(f) };
      }
      if (i.kind !== "move") return no("E_VENUE_REJECTED", { venue: "metamask", message: `mm takes swap, transfer and bridge here; "${i.kind}" is not one of them`, native: { error: "UNSUPPORTED" } });
      const usd = usdOf(i);
      const at = now();
      const pollingId = `poll-${String(++seq).padStart(4, "0")}`;
      // MetaMask's own Guard comes first: policy is evaluated before the transaction is built
      if (seed.tradingMode === "guard" && (!seed.allowlist.includes(i.to) || dayOut(at) + usd > seed.rolling24hUsd)) {
        return { ok: true as const, account: account.id, status: "pending" as const, summary: `transfer ${i.amount} ${i.asset} → ${i.to}: over MetaMask Guard's line, AWAITING_MFA (the card in the user's inbox)`, usd, ref: `metamask:${pollingId}`, native: { status: "AWAITING_MFA", pollingId, reason: !seed.allowlist.includes(i.to) ? "recipient not in allowlist" : `rolling_24h ${dayOut(at)} + ${usd} > ${seed.rolling24hUsd}` } };
      }
      const fromChain = chainName(i.fromChainId) ?? holdings.find((x) => x.asset === i.asset && x.amount >= i.amount)?.chain ?? holdings.find((x) => x.asset === i.asset)?.chain;
      const h = holdings.find((x) => x.asset === i.asset && x.chain === fromChain);
      if (!h || h.amount < i.amount) return insufficient({ chain: fromChain, asset: i.asset });
      const toChain = chainName(i.chainId) ?? h.chain;
      h.amount = r8(h.amount - i.amount);
      outflows.push({ at, usd });
      if (toChain !== h.chain) {
        const quotes = bridgeQuotes(usd, toChain, h.chain);
        const q = quotes.find((x) => x.id === i.via) ?? quotes[0]!;
        const arrived = r8(i.amount - q.feeUsd / (priceOf(i.asset) || 1));
        return { ok: true as const, account: account.id, status: "sent" as const, summary: `bridge ${i.amount} ${i.asset} ${h.chain} → ${toChain} via ${q.label} · fee $${q.feeUsd} · ${arrived} arrives at ${i.to}`, usd, ref: `metamask:bridge:${pollingId}`, native: { bridge: true, from: h.chain, to: toChain, via: q.id, label: q.label, feeUsd: q.feeUsd, etaSec: q.etaSec, arrived, pollingId } };
      }
      return { ok: true as const, account: account.id, status: "sent" as const, summary: `transfer ${i.amount} ${i.asset} → ${i.to} (${h.chain})`, usd, ref: `metamask:${pollingId}`, native: { status: "confirmed", pollingId } };
    },
  };
}

// ---- live --------------------------------------------------------------------

export interface MmLiveOptions {
  bin?: string;
  timeoutMs?: number;
  /** seconds a balance read stays fresh (the CLI takes a few seconds per call) */
  cacheSeconds?: number;
}

interface MmEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: unknown;
}

/** run the `mm` CLI and take `data` out of its JSON envelope; a failure rejects with the CLI's own error */
export function mm<T>(bin: string, args: string[], timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, { timeout: timeoutMs, env: process.env, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const text = String(stdout ?? "");
      let parsed: MmEnvelope<T> | undefined;
      try {
        parsed = JSON.parse(text) as MmEnvelope<T>;
      } catch {
        parsed = undefined;
      }
      if (parsed?.ok && parsed.data !== undefined) return resolve(parsed.data);
      reject(new Error(parsed?.error ? JSON.stringify(parsed.error) : err ? `${err.message}${stderr ? ` · ${String(stderr).trim()}` : ""}` : text.slice(0, 400)));
    });
    child.stdin?.end();
  });
}

interface MmShow {
  address: string;
  tradingMode: string;
  policyYaml?: string;
  mode?: string;
  name?: string | null;
}

interface MmBalance {
  currency: string;
  totalValue: string;
  chains: unknown[];
}

/** a defensive read of `mm wallet balance`: the per-chain shape is not pinned, so take what looks like {symbol, balance, value} */
function holdingsOf(b: MmBalance): Holding[] {
  const rows: Holding[] = [];
  const walk = (v: unknown, chain: string | undefined) => {
    if (Array.isArray(v)) return v.forEach((x) => walk(x, chain));
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    const chainLabel = typeof o.chainName === "string" ? o.chainName : typeof o.name === "string" && (o.chainId !== undefined || o.assets || o.tokens) ? o.name : chain;
    const symbol = typeof o.symbol === "string" ? o.symbol : undefined;
    const amount = Number(o.balance ?? o.amount ?? NaN);
    const usd = Number(o.value ?? o.usd ?? o.fiatValue ?? NaN);
    if (symbol && Number.isFinite(amount)) {
      rows.push({ account: "metamask", asset: symbol, amount, usd: Number.isFinite(usd) ? r2(usd) : r2(amount * priceOf(symbol)), class: classOf(symbol), note: chainLabel });
      return;
    }
    for (const x of Object.values(o)) if (typeof x === "object" && x !== null) walk(x, chainLabel);
  };
  walk(b.chains, undefined);
  if (!rows.length && Number(b.totalValue) > 0) rows.push({ account: "metamask", asset: b.currency.toUpperCase(), amount: Number(b.totalValue), usd: r2(Number(b.totalValue)), class: "cash", note: "mm wallet balance · totalValue" });
  return rows;
}

/** the exact command a write would run: `transfer` on one chain, `swap execute` for a swap or (across chains) a bridge */
export function mmCommand(bin: string, i: Intent): string[] | null {
  if (i.kind === "move") {
    const to = i.chainId ?? 8453;
    const from = i.fromChainId ?? to;
    if (from !== to) return [bin, "swap", "execute", "--from", i.asset, "--to", i.asset, "--amount", String(i.amount), "--from-chain-id", String(from), "--to-chain-id", String(to), "--to-address", i.to];
    return [bin, "transfer", "--to", i.to, "--amount", String(i.amount), "--chain-id", String(to), "--token", i.asset];
  }
  if (i.kind === "trade") {
    const base = baseOf(i.symbol);
    if (i.side === "sell") return [bin, "swap", "execute", "--from", base, "--to", "USDC", "--amount", String(i.qty), "--from-chain-id", String(i.chainId ?? 1)];
    const chain = i.chainId ?? 8453;
    const cost = fillAt(dexVenue(chainName(chain) ?? "Base"), base, "buy", i.qty)?.netUsd ?? r2(i.qty * priceOf(base));
    return [bin, "swap", "execute", "--from", "USDC", "--to", base, "--amount", String(cost), "--from-chain-id", String(chain)];
  }
  return null;
}

/** CAIP-19 ids the price API knows (`mm price spot --asset-ids`) */
const CAIP19: Record<string, string> = {
  ETH: "eip155:1/slip44:60",
  BTC: "bip122:000000000019d6689c085ae165831e93/slip44:0",
  SOL: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/slip44:501",
};

/** read candidate quotes out of `mm swap quote --all-quotes`; field names follow the CLI's own quote presentation (feeData.metabridge.usd, gasIncludedBreakdown.gaslessRelayFee.usd, priceData.totalToAmountUsd, protocols). Not exercised yet: an empty wallet gets INSUFFICIENT_FUNDS instead of quotes. */
export function parseMmQuotes(data: unknown): RouteQuote[] {
  const out: RouteQuote[] = [];
  const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : 0);
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (o.feeData || o.priceData) {
      const fee = num((o.feeData as { metabridge?: { usd?: unknown } } | undefined)?.metabridge?.usd) + num((o.gasIncludedBreakdown as { gaslessRelayFee?: { usd?: unknown } } | undefined)?.gaslessRelayFee?.usd);
      const protocols = Array.isArray(o.protocols) ? o.protocols.filter((p): p is string => typeof p === "string") : [];
      const q: RouteQuote = { id: `mm:${out.length}`, label: protocols.join(" + ") || "MetaMask bridge", feeUsd: r2(fee), etaSec: num(o.estimatedProcessingTimeInSeconds), open: true, source: "mm" };
      const outUsd = num((o.priceData as { totalToAmountUsd?: unknown } | undefined)?.totalToAmountUsd);
      if (outUsd > 0) q.outUsd = r2(outUsd);
      out.push(q);
      return;
    }
    for (const x of Object.values(o)) if (typeof x === "object" && x !== null) walk(x);
  };
  walk(data);
  return out;
}

export async function metamaskLiveAccount(opts: MmLiveOptions = {}): Promise<AccountAdapter> {
  const bin = opts.bin ?? "mm";
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const cacheMs = (opts.cacheSeconds ?? 30) * 1000;
  const show = await mm<MmShow>(bin, ["wallet", "show"], timeoutMs);
  const yaml = show.policyYaml ?? "";
  const rolling = Number(/rolling_24h:\s*([\d.]+)/.exec(yaml)?.[1] ?? NaN);
  const allowlistCount = (yaml.match(/^\s+- "?0x/gm) ?? []).length;
  const account: Account = {
    id: "metamask",
    name: "MetaMask Agent Wallet",
    kind: "agent-wallet",
    provider: "MetaMask (server wallet · LIVE)",
    credentialRef: "~/.metamask-agent-wallet (mm CLI session)",
    credentialKind: `mm CLI session · ${show.address.slice(0, 10)}…`,
    scope: { can: ["read", "trade", "move"], limits: scopeLimits(show.tradingMode, Number.isFinite(rolling) ? rolling : 0, allowlistCount), enforcedBy: "metamask" },
    settlement: "on-chain confirmation · DEX swap · bridge (mm swap) · transfers over policy wait for MFA (email)",
    live: true,
    address: show.address,
    chain: "EVM",
  };
  let cache: { at: number; rows: Holding[] } | undefined;
  return {
    account,
    async read(): Promise<Holding[]> {
      if (cache && Date.now() - cache.at < cacheMs) return cache.rows;
      const b = await mm<MmBalance>(bin, ["wallet", "balance"], timeoutMs);
      cache = { at: Date.now(), rows: holdingsOf(b) };
      return cache.rows;
    },
    /** real quotes, read-only: `--all-quotes` compares and never executes. A `move` across chains is a bridge quote; a `trade` is a DEX swap quote on its chain. */
    async quote(i: Intent): Promise<RouteQuote[]> {
      if (i.kind === "trade") {
        const base = baseOf(i.symbol);
        const chain = String(i.chainId ?? (i.side === "sell" ? 1 : 8453));
        const amount = i.side === "sell" ? i.qty : r2(i.qty * priceOf(base));
        const [from, to] = i.side === "sell" ? [base, "USDC"] : ["USDC", base];
        return parseMmQuotes(await mm<unknown>(bin, ["swap", "quote", "--from", from, "--to", to, "--amount", String(amount), "--from-chain-id", chain, "--all-quotes"], timeoutMs));
      }
      if (i.kind !== "move" || i.fromChainId === undefined || i.chainId === undefined || i.fromChainId === i.chainId) return [];
      const data = await mm<unknown>(bin, ["swap", "quote", "--from", i.asset, "--to", i.asset, "--amount", String(i.amount), "--from-chain-id", String(i.fromChainId), "--to-chain-id", String(i.chainId), "--to-address", i.to, "--all-quotes"], timeoutMs);
      return parseMmQuotes(data);
    },
    /** a real spot price from MetaMask's price API (read-only; works on an empty wallet) */
    async spot(asset: string): Promise<number | undefined> {
      const id = CAIP19[asset];
      if (!id) return undefined;
      const data = await mm<{ prices?: Array<{ assetId?: string; price?: number }> }>(bin, ["price", "spot", "--asset-ids", id], timeoutMs);
      const price = data.prices?.find((p) => p.assetId === id)?.price;
      return typeof price === "number" && price > 0 ? r2(price) : undefined;
    },
    async execute(i: Intent) {
      const cmd = mmCommand(bin, i);
      if (!cmd) return no("E_VENUE_REJECTED", { venue: "metamask", message: `mm takes swap, transfer and bridge here; "${i.kind}" is not one of them`, native: { error: "UNSUPPORTED" } });
      const command = cmd.join(" ");
      if (process.env.PORTFOLIO_MM_WRITES !== "1") {
        return no("E_WALLET_LIVE_WRITES_OFF", { venue: "metamask", tool: `portfolio_${i.kind}`, message: `real-money writes are off (PORTFOLIO_MM_WRITES≠1). The command that would run: ${command}; once it runs, MetaMask Guard still decides on MFA by its own 24 h outflow and allowlist`, detail: { command, address: show.address, tradingMode: show.tradingMode } });
      }
      try {
        const r = await mm<Record<string, unknown>>(bin, cmd.slice(1), timeoutMs);
        const pollingId = typeof r.pollingId === "string" ? r.pollingId : undefined;
        return { ok: true as const, account: account.id, status: "pending" as const, summary: `${command} → ${pollingId ?? "submitted"}`, usd: usdOf(i), ref: `metamask:${pollingId ?? "tx"}`, native: r };
      } catch (err) {
        return no("E_VENUE_REJECTED", { venue: "metamask", message: "mm did not succeed", native: { error: (err as Error).message } });
      }
    },
  };
}
