/** A venue the owner PLUGS IN: an exchange wallet reached by API key, or a self-custody wallet reached by its address — in-memory.
 *
 * Nothing in this file names an exchange. What it needs to know about one comes from two places: the connector the owner picked (how the
 * exchange is spoken to — account/doors.ts `EXCHANGES`) and the exchange's own answer about the key it was given: read, trade, withdraw, and
 * the addresses a withdrawal may go to. The account's doors are compiled from that answer, so a key that cannot withdraw gets a way out that
 * is "at the exchange", and one that can — to verified addresses that are the user's own — gets one an agent may use.
 *
 * The scope of what is plugged in is the WALLET: balances, the ways in and out, a stablecoin swap. Orders at a plugged exchange are not
 * built here (the account layer is about money, not trading).
 *
 * In the simulation the "exchange side" is a seed: the balances it holds and what it says about the key. Through the unified library there
 * is no single call that returns a key's permissions; a real connector learns them from the exchange's own endpoint where it has one
 * (Binance: GET /sapi/v1/account/apiRestrictions) and from the first refusal where it has none. The refusals below carry the library's own
 * exception names (PermissionDenied, InvalidAddress, InsufficientFunds).
 */
import { no } from "../refuse.ts";
import { classOf, priceOf, r2, r8, usdOf, type Account, type AccountAdapter, type Capability, type Holding, type Intent, type VenueResult } from "../accounts.ts";

export interface ExchangeWalletSeed {
  name: string;
  /** how it is reached: `binance` · `okx` · `unified` (account/doors.ts) */
  connector: string;
  balances: Record<string, number>;
  /** what the exchange says this key may do */
  key: { permissions: Array<"read" | "trade" | "withdraw">; ipBound?: string | undefined; whitelist?: string[] | undefined };
}

export interface SelfCustodySeed {
  name: string;
  connector: "wallet";
  address: string;
  holdings: Array<{ asset: string; amount: number; chain: string }>;
}

export type PlugSeed = ExchangeWalletSeed | SelfCustodySeed;
export const isSelfCustody = (s: PlugSeed): s is SelfCustodySeed => s.connector === "wallet";

/** what the venue reported about the credential when it was plugged in, in words */
export interface Probe {
  can: string[];
  note: string;
  native: unknown;
}

export interface Plugged {
  adapter: AccountAdapter;
  probe: Probe;
}

export function exchangeWallet(id: string, seed: ExchangeWalletSeed, credentialRef: string): Plugged {
  const balances: Record<string, number> = { ...seed.balances };
  const perms = new Set(seed.key.permissions);
  const can: Capability[] = ["read", ...(perms.has("trade") ? (["trade"] as const) : []), ...(perms.has("withdraw") ? (["move"] as const) : [])];
  const whitelist = seed.key.whitelist;
  let seq = 0;
  const account: Account = {
    id,
    name: seed.name,
    kind: "cex",
    provider: `${seed.name} (plugged in)`,
    credentialRef,
    credentialKind: "API key with separate permissions",
    scope: { can, limits: [`key permissions ${seed.key.permissions.join(" / ")}${perms.has("withdraw") ? "" : ": withdraw not enabled"}`, ...(seed.key.ipBound ? [`bound to IP ${seed.key.ipBound}`] : []), ...(whitelist ? [`withdraws only to verified addresses (${whitelist.join(", ")})`] : [])], enforcedBy: "venue" },
    settlement: "deposits after the chain's confirmations · withdrawals in minutes",
    live: false,
    connector: seed.connector,
    plugged: true,
  };
  const denied = (what: string) => no("E_VENUE_PERMISSION", { venue: id, message: `${seed.name}: this key cannot ${what}`, native: { error: "PermissionDenied", exchange: id } });
  const short = () => no("E_VENUE_INSUFFICIENT", { venue: id, native: { error: "InsufficientFunds", exchange: id } });
  const adapter: AccountAdapter = {
    account,
    async read(): Promise<Holding[]> {
      return Object.entries(balances).filter(([, amount]) => amount > 0).map(([asset, amount]) => ({ account: id, asset, amount, usd: r2(amount * priceOf(asset)), class: classOf(asset) }));
    },
    async execute(i: Intent) {
      if (i.kind !== "move") return no("E_VENUE_REJECTED", { venue: id, message: `${seed.name} is plugged in as a wallet: balances, deposits, withdrawals, a stablecoin swap. A "${i.kind}" is not built for a plugged venue`, native: { error: "NotSupported" } });
      if (!perms.has("withdraw")) return denied("withdraw");
      if (whitelist && !whitelist.includes(i.to)) return no("E_VENUE_WITHDRAW_WHITELIST", { venue: id, native: { error: "InvalidAddress", exchange: id, address: i.to } });
      if ((balances[i.asset] ?? 0) < i.amount) return short();
      balances[i.asset] = r8((balances[i.asset] ?? 0) - i.amount);
      return { ok: true as const, account: id, status: "sent" as const, summary: `${i.amount} ${i.asset} → ${i.to}`, usd: usdOf(i), ref: `${id}:wd:${++seq}`, native: { id: `wd-${seq}`, status: "ok" } };
    },
    credit(asset, amount) {
      balances[asset] = r8((balances[asset] ?? 0) + amount);
    },
    convert(sell, buy, amount): VenueResult {
      if (!perms.has("trade")) return denied("trade");
      if ([sell, buy].sort().join("/") !== "USDC/USDT") return no("E_VENUE_CURRENCY", { venue: id, message: `${seed.name} swaps USDT and USDC here, not ${sell} for ${buy}`, native: { error: "BadSymbol" } });
      if ((balances[sell] ?? 0) < amount) return short();
      const feeUsd = r2(amount * 0.0001);
      const received = r2(amount - feeUsd);
      balances[sell] = r8((balances[sell] ?? 0) - amount);
      balances[buy] = r8((balances[buy] ?? 0) + received);
      return { ok: true as const, ref: `${id}:order:${++seq}`, received, feeUsd, native: { id: `order-${seq}`, status: "closed", symbol: "USDC/USDT", filled: received } };
    },
    /** the account holder at the exchange's own site, where a withdrawal is theirs to start */
    startAtVenue(direction, asset, amount): VenueResult {
      if (direction !== "out") return { ok: true as const, native: { address: `deposit address shown at ${seed.name}`, coin: asset } };
      if ((balances[asset] ?? 0) < amount) return short();
      balances[asset] = r8((balances[asset] ?? 0) - amount);
      return { ok: true as const, ref: `${id}:wd:${++seq}`, native: { id: `wd-${seq}`, status: "ok" } };
    },
  };
  const words = [...seed.key.permissions];
  return { adapter, probe: { can: words, note: perms.has("withdraw") ? `withdrawals only to ${whitelist?.length ? `its verified addresses (${whitelist.join(", ")})` : "addresses verified at the exchange"}` : "withdrawals stay at the exchange: this key has no withdraw permission", native: { permissions: seed.key.permissions, ...(seed.key.ipBound ? { ipRestrict: true } : {}), ...(whitelist ? { withdrawWhitelist: whitelist } : {}) } } };
}

/** A self-custody wallet (an exchange's own wallet app, a hardware wallet): plugged in by its ADDRESS. The account reads it and can send to it;
 * it holds no key for it, so money leaves it only when the owner signs in that wallet. */
export function selfCustodyWallet(id: string, seed: SelfCustodySeed): Plugged {
  const held = seed.holdings.map((h) => ({ ...h }));
  let seq = 0;
  const account: Account = {
    id,
    name: seed.name,
    kind: "agent-wallet",
    provider: `${seed.name} (self-custody, plugged in by address)`,
    credentialRef: "none: an address, read from the chain",
    credentialKind: "no credential: the key stays in the wallet",
    scope: { can: ["read"], limits: ["the account can read this address and send to it", "nothing leaves it without the owner signing in the wallet itself"], enforcedBy: "metamask" },
    settlement: "on-chain: seconds",
    live: false,
    address: seed.address,
    connector: "wallet",
    plugged: true,
  };
  const find = (asset: string, chain?: string) => held.find((h) => h.asset === asset && (chain === undefined || h.chain === chain));
  const adapter: AccountAdapter = {
    account,
    async read(): Promise<Holding[]> {
      return held.filter((h) => h.amount > 0).map((h) => ({ account: id, asset: h.asset, amount: h.amount, usd: r2(h.amount * priceOf(h.asset)), class: classOf(h.asset), note: h.chain }));
    },
    async execute(i: Intent) {
      return no("E_WALLET_SCOPE", { venue: id, message: `${seed.name} is the owner's own wallet: the account holds no key for it, so nothing is signed here`, detail: { can: ["read"], want: i.kind } });
    },
    credit(asset, amount, chain) {
      const h = find(asset, chain);
      if (h) h.amount = r8(h.amount + amount);
      else held.push({ asset, amount, chain: chain ?? "Base" });
    },
    /** the owner signs in the wallet itself; the account sees the balance go */
    debit(asset, amount, chain): VenueResult {
      const h = find(asset, chain);
      if (!h || h.amount < amount) return no("E_VENUE_INSUFFICIENT", { venue: id, message: `${seed.name} holds ${h?.amount ?? 0} ${asset}${chain ? ` on ${chain}` : ""}` });
      h.amount = r8(h.amount - amount);
      return { ok: true as const, ref: `${id}:tx:${++seq}` };
    },
  };
  return { adapter, probe: { can: ["read"], note: "an address, not a key: money goes in at once, and comes out when you sign in that wallet", native: { address: seed.address, chains: [...new Set(seed.holdings.map((h) => h.chain))] } } };
}

export function plug(id: string, seed: PlugSeed, credentialRef: string): Plugged {
  return isSelfCustody(seed) ? selfCustodyWallet(id, seed) : exchangeWallet(id, seed, credentialRef);
}
