/** The MetaMask Agent Wallet as one account among the others — the on-chain
 * one: it swaps (a DEX route through MetaMask's aggregator), it bridges, and
 * it is the only account that can be LIVE. Two shapes, one interface:
 *
 *   metamaskSimAccount   in-memory, holdings per chain. `trade` is a swap on
 *                        the chain where the asset sits (venues.ts prices it:
 *                        pool fee, price impact, gas). A `move` whose chain
 *                        differs from the holding's is a BRIDGE over the route
 *                        the intent names (rails.ts quotes it); the fee comes
 *                        out of what arrives. Guard mode's own policy (24 h
 *                        outflow, allowlist) is simulated INSIDE the adapter
 *                        because it is MetaMask's rule, not the portfolio
 *                        wallet's: over the line a transfer comes back
 *                        AWAITING_MFA.
 *   metamaskLiveAccount  reads the real `mm` CLI (address, trading mode, the
 *                        policy YAML, balances) and can READ real bridge
 *                        quotes (`mm swap quote --all-quotes`). Writes build
 *                        the exact `mm` command — `transfer`, or `swap
 *                        execute` for a swap or a bridge — and run it ONLY
 *                        when PORTFOLIO_MM_WRITES=1; otherwise they come back
 *                        as a structured refusal that carries the command, so
 *                        the demo never moves real money by accident.
 */
import { execFile } from "node:child_process";
import { refuse } from "../../core/errors.ts";
import { evmAddressOf, keyFromSeed } from "../../core/ed25519.ts";
import { baseOf, chainName, classOf, priceOf, r2, r8, usdOf, type Account, type AccountAdapter, type Holding, type Intent, type RouteQuote } from "../accounts.ts";
import { bridgeQuotes } from "../rails.ts";
import { DEX_GAS_USD, fillAt } from "../venues.ts";

export interface MetamaskSimSeed {
  seed: string;
  tradingMode: "guard" | "beast";
  rolling24hUsd: number;
  allowlist: string[];
  holdings: Array<{ asset: string; amount: number; chain: string }>;
}

const scopeLimits = (mode: string, rolling: number, allowlistCount: number) => [
  `trading mode ${mode}${mode === "guard" ? "：出金策略 + 白名单，超线 → MFA（邮件里批）" : "：跳过策略，恶意交易仍拦"}`,
  `24 h 出金上限 $${rolling}${rolling === 0 ? "（= 任何转出都要人批）" : ""}`,
  `地址白名单 ${allowlistCount} 条`,
  "server wallet：密钥在 MetaMask 服务端，agent 拿到的是 CLI 会话；链上 swap 与跨链都走 mm swap",
];

export function metamaskSimAccount(seed: MetamaskSimSeed, now: () => string): AccountAdapter {
  const holdings = seed.holdings.map((h) => ({ ...h }));
  const outflows: Array<{ at: string; usd: number }> = [];
  let seq = 0;
  const address = evmAddressOf(keyFromSeed(seed.seed).publicKeyHex);
  const account: Account = {
    id: "metamask",
    name: "MetaMask Agent Wallet",
    kind: "agent-wallet",
    provider: "MetaMask（server wallet）",
    credentialRef: "home/credentials/metamask/cli-session.json",
    credentialKind: `mm CLI 会话（Google 登录派生）· ${address.slice(0, 10)}…`,
    scope: { can: ["read", "trade", "move"], limits: scopeLimits(seed.tradingMode, seed.rolling24hUsd, seed.allowlist.length), enforcedBy: "metamask" },
    settlement: "链上确认 · DEX swap · 跨链 bridge · 超策略的转出等 MFA",
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
  const insufficient = (extra: Record<string, unknown> = {}) => refuse("E_VENUE_INSUFFICIENT", { venue: "metamask", native: { error: "INSUFFICIENT_BALANCE", ...extra } });
  return {
    account,
    credit,
    async read(): Promise<Holding[]> {
      return holdings.filter((h) => h.amount > 0).map((h) => ({ account: account.id, asset: h.asset, amount: h.amount, usd: r2(h.amount * priceOf(h.asset)), class: classOf(h.asset), note: h.chain }));
    },
    async execute(i: Intent) {
      if (i.kind === "trade") {
        const base = baseOf(i.symbol);
        const n = ++seq;
        if (i.side === "sell") {
          const h = holdings.find((x) => x.asset === base && x.amount >= i.qty);
          if (!h) return insufficient({ asset: base });
          const f = fillAt("metamask", base, "sell", i.qty, DEX_GAS_USD[h.chain]);
          if (!f) return refuse("E_VENUE_REJECTED", { venue: "metamask", native: { error: "TOKEN_NOT_SUPPORTED" } });
          h.amount = r8(h.amount - i.qty);
          credit(f.quote, f.netUsd, h.chain);
          return { ok: true as const, account: account.id, status: "filled" as const, summary: `swap ${i.qty} ${base} → ${f.netUsd} ${f.quote} on ${h.chain} · fee ${f.feeUsd}`, usd: f.grossUsd, ref: `metamask:swap:${n}`, native: { price: f.price, grossUsd: f.grossUsd, feeUsd: f.feeUsd, netUsd: f.netUsd, impactBps: f.impactBps, chain: h.chain } };
        }
        for (const c of holdings.filter((x) => x.asset === "USDC").sort((a, b) => (DEX_GAS_USD[a.chain] ?? 4) - (DEX_GAS_USD[b.chain] ?? 4))) {
          const f = fillAt("metamask", base, "buy", i.qty, DEX_GAS_USD[c.chain]);
          if (!f || c.amount < f.netUsd) continue;
          c.amount = r8(c.amount - f.netUsd);
          credit(base, i.qty, c.chain);
          return { ok: true as const, account: account.id, status: "filled" as const, summary: `swap ${f.netUsd} ${f.quote} → ${i.qty} ${base} on ${c.chain} · fee ${f.feeUsd}`, usd: f.grossUsd, ref: `metamask:swap:${n}`, native: { price: f.price, grossUsd: f.grossUsd, feeUsd: f.feeUsd, netUsd: f.netUsd, impactBps: f.impactBps, chain: c.chain } };
        }
        return insufficient({ asset: "USDC" });
      }
      if (i.kind !== "move") return refuse("E_VENUE_REJECTED", { venue: "metamask", message: `mm 这里接了 swap、transfer 与 bridge；「${i.kind}」不在`, native: { error: "UNSUPPORTED" } });
      const usd = usdOf(i);
      const at = now();
      const pollingId = `poll-${String(++seq).padStart(4, "0")}`;
      // MetaMask's own Guard comes first: policy is evaluated before the transaction is built
      if (seed.tradingMode === "guard" && (!seed.allowlist.includes(i.to) || dayOut(at) + usd > seed.rolling24hUsd)) {
        return { ok: true as const, account: account.id, status: "pending" as const, summary: `transfer ${i.amount} ${i.asset} → ${i.to}：MetaMask Guard 超线，AWAITING_MFA（用户邮箱里的那张卡）`, usd, ref: `metamask:${pollingId}`, native: { status: "AWAITING_MFA", pollingId, reason: !seed.allowlist.includes(i.to) ? "recipient not in allowlist" : `rolling_24h ${dayOut(at)} + ${usd} > ${seed.rolling24hUsd}` } };
      }
      const fromChain = chainName(i.fromChainId) ?? holdings.find((x) => x.asset === i.asset && x.amount >= i.amount)?.chain ?? holdings.find((x) => x.asset === i.asset)?.chain;
      const h = holdings.find((x) => x.asset === i.asset && x.chain === fromChain);
      if (!h || h.amount < i.amount) return insufficient({ chain: fromChain, asset: i.asset });
      const toChain = chainName(i.chainId) ?? h.chain;
      h.amount = r8(h.amount - i.amount);
      outflows.push({ at, usd });
      if (toChain !== h.chain) {
        const quotes = bridgeQuotes(usd);
        const q = quotes.find((x) => x.id === i.via) ?? quotes[0]!;
        const arrived = r8(i.amount - q.feeUsd / (priceOf(i.asset) || 1));
        return { ok: true as const, account: account.id, status: "sent" as const, summary: `bridge ${i.amount} ${i.asset} ${h.chain} → ${toChain} via ${q.label} · fee $${q.feeUsd} · ${arrived} arrives at ${i.to}`, usd, ref: `metamask:bridge:${pollingId}`, native: { bridge: true, from: h.chain, to: toChain, via: q.id, label: q.label, feeUsd: q.feeUsd, etaSec: q.etaSec, arrived, pollingId } };
      }
      return { ok: true as const, account: account.id, status: "sent" as const, summary: `transfer ${i.amount} ${i.asset} → ${i.to}（${h.chain}）`, usd, ref: `metamask:${pollingId}`, native: { status: "confirmed", pollingId } };
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

function mm<T>(bin: string, args: string[], timeoutMs: number): Promise<T> {
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
    if (i.side === "sell") return [bin, "swap", "execute", "--from", base, "--to", "USDC", "--amount", String(i.qty), "--from-chain-id", "1"];
    const cost = fillAt("metamask", base, "buy", i.qty)?.netUsd ?? r2(i.qty * priceOf(base));
    return [bin, "swap", "execute", "--from", "USDC", "--to", base, "--amount", String(cost), "--from-chain-id", "8453"];
  }
  return null;
}

/** read candidate quotes out of `mm swap quote --all-quotes`; field names follow the CLI's own quote presentation (feeData.metabridge.usd, gasIncludedBreakdown.gaslessRelayFee.usd, protocols). Not exercised yet: an empty wallet gets INSUFFICIENT_FUNDS instead of quotes. */
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
      out.push({ id: `mm:${out.length}`, label: protocols.join(" + ") || "MetaMask bridge", feeUsd: r2(fee), etaSec: num(o.estimatedProcessingTimeInSeconds), open: true, source: "mm" });
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
    provider: "MetaMask（server wallet · LIVE）",
    credentialRef: "~/.metamask-agent-wallet（mm CLI 会话）",
    credentialKind: `mm CLI 会话 · ${show.address.slice(0, 10)}…`,
    scope: { can: ["read", "trade", "move"], limits: scopeLimits(show.tradingMode, Number.isFinite(rolling) ? rolling : 0, allowlistCount), enforcedBy: "metamask" },
    settlement: "链上确认 · DEX swap · 跨链 bridge（mm swap）· 超策略的转出等 MFA（邮件）",
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
    /** real bridge quotes, read-only: `--all-quotes` compares and never executes */
    async quote(i: Intent): Promise<RouteQuote[]> {
      if (i.kind !== "move" || i.fromChainId === undefined || i.chainId === undefined || i.fromChainId === i.chainId) return [];
      const data = await mm<unknown>(bin, ["swap", "quote", "--from", i.asset, "--to", i.asset, "--amount", String(i.amount), "--from-chain-id", String(i.fromChainId), "--to-chain-id", String(i.chainId), "--to-address", i.to, "--all-quotes"], timeoutMs);
      return parseMmQuotes(data);
    },
    async execute(i: Intent) {
      const cmd = mmCommand(bin, i);
      if (!cmd) return refuse("E_VENUE_REJECTED", { venue: "metamask", message: `mm 这里接了 swap、transfer 与 bridge；「${i.kind}」不在`, native: { error: "UNSUPPORTED" } });
      const command = cmd.join(" ");
      if (process.env.PORTFOLIO_MM_WRITES !== "1") {
        return refuse("E_WALLET_LIVE_WRITES_OFF", { venue: "metamask", tool: `portfolio_${i.kind}`, message: `真钱写操作关着（PORTFOLIO_MM_WRITES≠1）。会执行的命令：${command}；执行后 MetaMask Guard 自己还会按 24 h 出金与白名单决定要不要 MFA`, detail: { command, address: show.address, tradingMode: show.tradingMode } });
      }
      try {
        const r = await mm<Record<string, unknown>>(bin, cmd.slice(1), timeoutMs);
        const pollingId = typeof r.pollingId === "string" ? r.pollingId : undefined;
        return { ok: true as const, account: account.id, status: "pending" as const, summary: `${command} → ${pollingId ?? "submitted"}`, usd: usdOf(i), ref: `metamask:${pollingId ?? "tx"}`, native: r };
      } catch (err) {
        return refuse("E_VENUE_REJECTED", { venue: "metamask", message: "mm 没有成功", native: { error: (err as Error).message } });
      }
    },
  };
}
