/** Real money at a live venue: HOW each kind of venue is asked to move it, and how the account learns that it did.
 *
 * Nothing here decides WHETHER money moves. The account's door does that (account/live-moves.ts): the server's switch, the owner's
 * signature, the cap, a destination that is the user's own. This file only speaks each venue's language:
 *
 *   an exchange (the unified library)   its deposit address on a network · withdraw · transfer between its own ledgers · a stablecoin swap
 *   a browser wallet                    the transaction the WALLET is asked to send — nothing here signs, and nothing here can
 *                                       · whether that transaction is on chain, and is the payment that was asked for
 *   the MetaMask Agent Wallet           `mm transfer`, behind MetaMask's own switch (PORTFOLIO_MM_WRITES) as well as this server's
 *
 * Every function returns the venue's own answer (`native`), with nothing secret in it, for the ledger.
 */
import { decodeEventLog, encodeFunctionData, erc20Abi, getAddress, isAddress, parseUnits, type Hex } from "viem";
import type { Refusal } from "../../core/errors.ts";
import { no } from "../refuse.ts";
import { CHAINS, STABLECOINS, type ChainName, type ChainReader } from "./chain.ts";
import type { ExchangeClient } from "./exchange.ts";
import { redact } from "./types.ts";

export interface LiveReceipt {
  /** the venue's own id for what it started */
  ref: string;
  /** done at once (a transfer between its own ledgers, a filled swap), or on its way */
  status: "pending" | "settled";
  /** what arrived, when the venue says (a swap) */
  received?: number | undefined;
  native: unknown;
}

export interface WalletTx {
  chainId: number;
  /** the hex form a wallet's `eth_sendTransaction` takes */
  chainIdHex: Hex;
  from: Hex;
  to: Hex;
  data: Hex;
  value: "0x0";
}

export type Landed = "pending" | "settled" | "failed";

export interface LiveWriter {
  /** what can be asked of this venue, as far as is known before asking */
  can: {
    /** an exchange withdrawal: `unknown` when the exchange has no call that says what the key may do */
    withdraw: boolean | "unknown";
    /** the venue's own ledgers money moves between */
    ledgers: string[];
    /** a move between those ledgers: a permission of its own at Binance, part of trading at OKX; `unknown` as for withdraw */
    transfer: boolean | "unknown";
    swap: boolean | "unknown";
    /** money can be sent to it */
    receive: boolean;
    /** money leaves it by the user's wallet, by mm, or not by this account */
    send: "wallet" | "mm" | false;
  };
  /** where money for this venue goes on a network: the exchange's own deposit address, or the wallet's own address */
  depositAddress(asset: string, network: ChainName): Promise<{ address: Hex; tag?: string | undefined } | Refusal>;
  /** what the venue charges to withdraw, in the asset, when it says */
  withdrawFee?(asset: string, network: ChainName): Promise<number | undefined>;
  withdraw?(r: { asset: string; amount: number; address: Hex; tag?: string | undefined; network: ChainName; clientId: string }): Promise<LiveReceipt | Refusal>;
  transfer?(r: { asset: string; amount: number; from: string; to: string }): Promise<LiveReceipt | Refusal>;
  swap?(r: { sell: string; buy: string; amount: number }): Promise<LiveReceipt | Refusal>;
  /** a browser wallet: the transaction the wallet is asked to send */
  walletTx?(r: { asset: string; amount: number; to: Hex; network: ChainName }): Promise<WalletTx | Refusal>;
  /** the MetaMask Agent Wallet: mm sends it */
  send?(r: { asset: string; amount: number; to: Hex; network: ChainName }): Promise<LiveReceipt | Refusal>;
  /** has something this venue started landed? */
  landed?(ref: string, asset: string, sinceMs: number): Promise<Landed>;
  /** a browser wallet's transaction: on chain, and the payment that was asked for? */
  confirm?(hash: Hex, expected: { asset: string; amount: number; to: Hex; network: ChainName }): Promise<Landed | Refusal>;
}

// ---- tokens ------------------------------------------------------------------------------------

/** the token for a dollar stablecoin on a chain. "USDT" finds USDT0 where USDT0 replaced it (Arbitrum, Polygon) or stands beside it */
export function tokenOn(asset: string, network: ChainName): { asset: string; address: Hex } | undefined {
  const want = asset.toUpperCase();
  const rows = STABLECOINS.filter((t) => t.chain === network);
  const exact = rows.find((t) => t.asset.toUpperCase() === want);
  if (exact) return { asset: exact.asset, address: exact.address };
  const usdt = want === "USDT" || want === "USDT0" ? rows.find((t) => t.asset.toUpperCase() === "USDT0" || t.asset.toUpperCase() === "USDT") : undefined;
  return usdt ? { asset: usdt.asset, address: usdt.address } : undefined;
}

const evm = (address: string): Hex | undefined => (isAddress(address, { strict: false }) ? getAddress(address) : undefined);
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

// ---- an exchange ---------------------------------------------------------------------------------

/** how the unified library names an EVM network, exchange by exchange: the first one this exchange's currency lists is used */
export const NETWORK_CODES: Record<ChainName, string[]> = {
  Ethereum: ["ERC20", "ETH"],
  Arbitrum: ["ARBITRUM", "ARB", "ARBONE", "ARBI"],
  Base: ["BASE"],
  Optimism: ["OPTIMISM", "OP"],
  Polygon: ["MATIC", "POLYGON", "POL"],
  "BNB Chain": ["BEP20", "BSC"],
  // no exchange this account knows lists it as a network
  "Robinhood Chain": [],
};

type Net = { fee?: number | undefined; withdraw?: boolean | undefined; deposit?: boolean | undefined };

/** what the key may do, in the exchange's own words (the probe in live/exchange.ts). Each exchange draws the lines in its own place: a move
 * between a Binance account's own wallets is a permission of its own, at OKX it comes with trading. Where the exchange has no call that
 * says, its first refusal will. */
function keyMay(exchange: string, said: string[]): { withdraw: boolean | "unknown"; transfer: boolean | "unknown"; swap: boolean | "unknown" } {
  if (!said.length) return { withdraw: "unknown", transfer: "unknown", swap: "unknown" };
  const has = (p: string) => said.includes(p);
  if (exchange.startsWith("binance")) return { withdraw: has("withdraw"), transfer: has("move between its own wallets"), swap: has("trade spot and margin") };
  if (exchange.startsWith("okx")) return { withdraw: has("withdraw"), transfer: has("trade"), swap: has("trade") };
  const all = said.join(" ");
  return { withdraw: /withdraw/.test(all), transfer: "unknown", swap: /trade/.test(all) };
}

export function exchangeWriter(client: ExchangeClient, venue: string, name: string, secrets: string[], probe: { can: string[] }, ledgers: string[]): LiveWriter {
  const said = (err: unknown) => redact(String((err as { message?: string })?.message ?? err).replace(/\s+/g, " ").slice(0, 240), secrets);
  const fail = (what: string, err: unknown): Refusal => {
    const kind = String((err as { name?: string })?.name ?? "");
    const text = said(err);
    if (kind === "InsufficientFunds" || /insufficient|not enough/i.test(text)) return no("E_VENUE_INSUFFICIENT", { venue, message: `${name}: not enough to ${what}`, native: { error: kind, said: text } });
    if (kind === "InvalidAddress" || /whitelist|address.*(not|un)(verified|allowed|trusted)|58207|-4035/i.test(text)) return no("E_VENUE_WITHDRAW_WHITELIST", { venue, message: `${name} refused the address: an exchange sends only to addresses verified there first, in its own withdrawal settings`, native: { error: kind, said: text } });
    if (kind === "PermissionDenied" || /permission|50120|-2015/i.test(text)) return no("E_VENUE_PERMISSION", { venue, message: `${name}: this key may not ${what}. That is set on the key at the exchange`, native: { error: kind, said: text } });
    return no("E_VENUE_REJECTED", { venue, message: `${name} refused to ${what}`, native: { error: kind, said: text } });
  };
  const network = async (asset: string, chain: ChainName): Promise<{ code: string; net: Net } | Refusal> => {
    try {
      await client.loadMarkets?.();
    } catch (err) {
      return fail("list its currencies", err);
    }
    const nets = (client.currencies?.[asset]?.networks ?? {}) as Record<string, Net>;
    const known = Object.keys(nets);
    const code = NETWORK_CODES[chain].find((c) => known.includes(c)) ?? (known.length ? undefined : NETWORK_CODES[chain][0]);
    if (!code) return no("E_VENUE_RAIL_CLOSED", { venue, message: `${name} does not carry ${asset} on ${chain}: it lists ${known.join(", ") || "no network"}`, detail: { networks: known } });
    return { code, net: nets[code] ?? {} };
  };
  const has = (what: string) => (client.has?.[what] === true ? true : client.has?.[what] === false ? false : undefined);
  return {
    can: { ...keyMay(client.id, probe.can), ledgers, receive: true, send: false },
    async depositAddress(asset, chain) {
      const n = await network(asset, chain);
      if ("ok" in n) return n;
      if (n.net.deposit === false) return no("E_VENUE_RAIL_CLOSED", { venue, message: `${name} takes no ${asset} deposits on ${chain} right now` });
      try {
        const r = (await client.fetchDepositAddress!(asset, { network: n.code })) as { address?: string; tag?: string | null };
        const address = evm(String(r.address ?? ""));
        if (!address) return no("E_VENUE_REJECTED", { venue, message: `${name} gave a deposit address that is not an EVM address` });
        return { address, ...(r.tag ? { tag: String(r.tag) } : {}) };
      } catch (err) {
        return fail(`show its ${asset} deposit address on ${chain}`, err);
      }
    },
    async withdrawFee(asset, chain) {
      const n = await network(asset, chain);
      return "ok" in n || typeof n.net.fee !== "number" ? undefined : n.net.fee;
    },
    async withdraw(r) {
      const n = await network(r.asset, r.network);
      if ("ok" in n) return n;
      if (n.net.withdraw === false) return no("E_VENUE_RAIL_CLOSED", { venue, message: `${name} takes no ${r.asset} withdrawals on ${r.network} right now` });
      // the exchange's own id for the request, where it takes one: a retry is then the same withdrawal, not a second one
      const id = r.clientId.replace(/[^A-Za-z0-9]/g, "").slice(0, 32);
      const idParam = client.id.startsWith("binance") ? { withdrawOrderId: id } : client.id.startsWith("okx") ? { clientId: id } : {};
      try {
        const t = (await client.withdraw!(r.asset, r.amount, r.address, r.tag, { network: n.code, ...idParam })) as { id?: string; txid?: string; status?: string };
        return { ref: String(t.id ?? ""), status: t.status === "ok" ? "settled" : "pending", native: { call: "withdraw", network: n.code, id: t.id ?? null, txid: t.txid ?? null, status: t.status ?? null } };
      } catch (err) {
        return fail(`withdraw ${r.asset}`, err);
      }
    },
    async transfer(r) {
      try {
        const t = (await client.transfer!(r.asset, r.amount, r.from, r.to)) as { id?: string; status?: string };
        return { ref: String(t.id ?? ""), status: "settled", native: { call: "transfer", from: r.from, to: r.to, id: t.id ?? null, status: t.status ?? null } };
      } catch (err) {
        return fail(`move ${r.asset} from ${r.from} to ${r.to}`, err);
      }
    },
    async swap(r) {
      try {
        await client.loadMarkets?.();
      } catch (err) {
        return fail("list its markets", err);
      }
      const markets = client.markets ?? {};
      const sellBase = `${r.sell}/${r.buy}`;
      const buyBase = `${r.buy}/${r.sell}`;
      try {
        if (markets[sellBase]) {
          const o = (await client.createOrder!(sellBase, "market", "sell", r.amount)) as { id?: string; cost?: number; status?: string };
          return { ref: String(o.id ?? ""), status: "settled", ...(typeof o.cost === "number" ? { received: o.cost } : {}), native: { call: "createOrder", symbol: sellBase, side: "sell", amount: r.amount, id: o.id ?? null, status: o.status ?? null } };
        }
        if (markets[buyBase]) {
          // spending a set amount of the quote currency is "buy by cost": only where the exchange takes it, never guessed as an amount of the base
          if (has("createMarketBuyOrderWithCost") !== true) return no("E_VENUE_RAIL_CLOSED", { venue, message: `${name} takes a market buy of ${r.buy} by how much ${r.buy} to get, not by how much ${r.sell} to spend: swap at the exchange` });
          const o = (await client.createMarketBuyOrderWithCost!(buyBase, r.amount)) as { id?: string; filled?: number; status?: string };
          return { ref: String(o.id ?? ""), status: "settled", ...(typeof o.filled === "number" ? { received: o.filled } : {}), native: { call: "createMarketBuyOrderWithCost", symbol: buyBase, cost: r.amount, id: o.id ?? null, status: o.status ?? null } };
        }
      } catch (err) {
        return fail(`swap ${r.sell} for ${r.buy}`, err);
      }
      return no("E_VENUE_RAIL_CLOSED", { venue, message: `${name} has no ${r.sell}/${r.buy} market` });
    },
    async landed(ref, asset, sinceMs) {
      if (!client.fetchWithdrawals) return "pending";
      try {
        const list = (await client.fetchWithdrawals(asset, sinceMs - 60_000)) as Array<{ id?: string; status?: string }>;
        const t = list.find((x) => String(x.id) === ref);
        return t?.status === "ok" ? "settled" : t?.status === "failed" || t?.status === "canceled" ? "failed" : "pending";
      } catch {
        return "pending";
      }
    },
  };
}

// ---- a browser wallet ------------------------------------------------------------------------------

const TRANSFER = { type: "event", name: "Transfer", inputs: [{ indexed: true, name: "from", type: "address" }, { indexed: true, name: "to", type: "address" }, { indexed: false, name: "value", type: "uint256" }] } as const;

export function walletWriter(address: Hex, chain: ChainReader): LiveWriter {
  const amountIn = async (asset: string, amount: number, network: ChainName): Promise<{ token: Hex; units: bigint } | Refusal> => {
    const t = tokenOn(asset, network);
    if (!t) return no("E_VENUE_CURRENCY", { message: `${asset} on ${network} is not a token this account knows` });
    const decimals = await chain.decimals(network, t.address);
    if (decimals === undefined) return no("E_VENUE_UNREACHABLE", { message: `${network} did not answer` });
    return { token: t.address, units: parseUnits(String(amount), decimals) };
  };
  return {
    can: { withdraw: false, ledgers: [], transfer: false, swap: false, receive: true, send: "wallet" },
    async depositAddress() {
      return { address };
    },
    async walletTx(r) {
      const a = await amountIn(r.asset, r.amount, r.network);
      if ("ok" in a) return a;
      const chainId = CHAINS[r.network].chain.id;
      return { chainId, chainIdHex: `0x${chainId.toString(16)}`, from: address, to: a.token, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [r.to, a.units] }), value: "0x0" };
    },
    async confirm(hash, expected) {
      const mined = await chain.receipt(expected.network, hash);
      if (!mined) return "pending";
      if (mined.status !== "success") return "failed";
      const a = await amountIn(expected.asset, expected.amount, expected.network);
      if ("ok" in a) return a;
      // the payment is a Transfer of that token, from this wallet, to that address, of that amount: anything else is not it
      const ok = mined.logs.some((l) => {
        if (!same(l.address, a.token)) return false;
        try {
          const e = decodeEventLog({ abi: [TRANSFER], topics: l.topics as [Hex, ...Hex[]], data: l.data });
          return same(e.args.from, address) && same(e.args.to, expected.to) && e.args.value === a.units;
        } catch {
          return false;
        }
      });
      return ok ? "settled" : no("E_VENUE_REJECTED", { message: `transaction ${hash.slice(0, 10)}… is on ${expected.network}, but it is not this payment: no transfer of ${expected.amount} ${expected.asset} from ${address} to ${expected.to}` });
    },
  };
}

// ---- the MetaMask Agent Wallet -----------------------------------------------------------------------

export function mmWriter(address: Hex, run: <T>(args: string[]) => Promise<T>, env: Record<string, string | undefined> = process.env): LiveWriter {
  return {
    can: { withdraw: false, ledgers: [], transfer: false, swap: false, receive: true, send: "mm" },
    async depositAddress() {
      return { address };
    },
    async send(r) {
      const t = tokenOn(r.asset, r.network);
      const args = ["transfer", "--to", r.to, "--amount", String(r.amount), "--chain-id", String(CHAINS[r.network].chain.id), "--token", t?.asset ?? r.asset];
      // MetaMask's own switch stays MetaMask's: this server turning writes on does not turn it on
      if (env.PORTFOLIO_MM_WRITES !== "1") return no("E_WALLET_LIVE_WRITES_OFF", { venue: "metamask", message: `MetaMask's own switch is off (PORTFOLIO_MM_WRITES is not 1). The command that would run: mm ${args.join(" ")}` });
      try {
        const out = await run<Record<string, unknown>>(args);
        return { ref: String(out.hash ?? out.txHash ?? out.pollingId ?? "mm"), status: "settled", native: { call: `mm ${args.join(" ")}`, answer: out } };
      } catch (err) {
        return no("E_VENUE_REJECTED", { venue: "metamask", message: "mm did not send it", native: { said: String((err as Error)?.message ?? err).slice(0, 200) } });
      }
    },
  };
}
