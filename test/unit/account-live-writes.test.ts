import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { decodeFunctionData, encodeAbiParameters, erc20Abi, getAddress, keccak256, stringToHex, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, describe, expect, it } from "vitest";
import { isRefusal, type Refusal } from "../../src/core/errors.ts";
import { cardHash, type Outcome } from "../../src/portfolio/account/exchange.ts";
import { signAgent, signOwner, simKey, type AgentAction, type OwnerAction } from "../../src/portfolio/account/sign.ts";
import type { ChainName, ChainReader, Mined } from "../../src/portfolio/live/chain.ts";
import type { ExchangeClient, OpenExchange } from "../../src/portfolio/live/exchange.ts";
import type { LiveDeps } from "../../src/portfolio/live/index.ts";
import { exchangeWriter } from "../../src/portfolio/live/writes.ts";
import { PortfolioService } from "../../src/portfolio/service.ts";

/** REAL-money writes, against stand-ins for everything real: an exchange that records what it is asked, a chain that holds what the test
 * says, a wallet key made here and thrown away. Nothing in this file leaves the process, and no key in it is anyone's. */
type NoNonce<T> = T extends unknown ? Omit<T, "nonce"> : never;
const START = Date.parse("2026-10-05T14:00:00.000Z");
const DAY = 86_400_000;
const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));
const owner = simKey("owner");
const cc = simKey("agent:claude-code");
/** OKX's deposit address in this test, as the account writes it (checksummed) */
const OKX_DEPOSIT = getAddress("0x00000000000000000000000000000000000dec0d");
const USDC_ARB = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";

type Call = [string, ...unknown[]];

/** an exchange that answers like the library does, and remembers every call that would move money */
function okxStandIn(opts: { perm?: string; fee?: number; deposit?: Hex } = {}): ExchangeClient & { calls: Call[]; withdrawals: Array<{ id: string; status: string }> } {
  const calls: Call[] = [];
  const withdrawals: Array<{ id: string; status: string }> = [];
  let fee = opts.fee ?? 0.1;
  const x = {
    id: "okx",
    name: "OKX",
    requiredCredentials: { apiKey: true, secret: true, password: true },
    has: { createMarketBuyOrderWithCost: true },
    calls,
    withdrawals,
    markets: { "USDC/USDT": {}, "ETH/USDT": {} } as Record<string, unknown>,
    get currencies() {
      return { USDC: { networks: { ARBITRUM: { fee, withdraw: true, deposit: true }, ERC20: { fee: 2, withdraw: true, deposit: true } } }, USDT: { networks: { ARBITRUM: { fee, withdraw: true, deposit: true } } } };
    },
    setFee(f: number) {
      fee = f;
    },
    async loadMarkets() {},
    async fetchTime() {
      return 1;
    },
    async fetchBalance(params: Record<string, unknown> = {}) {
      return params.type === "funding" ? { total: { USDT: 300 } } : { total: { USDC: 500, USDT: 200 } };
    },
    async fetchTickers() {
      return {};
    },
    async privateGetAccountConfig() {
      return { data: [{ perm: opts.perm ?? "read_only,trade,withdraw", ip: "203.0.113.7" }] };
    },
    async fetchDepositAddress(code: string, params?: Record<string, unknown>) {
      calls.push(["fetchDepositAddress", code, params]);
      return { address: opts.deposit ?? OKX_DEPOSIT, tag: null };
    },
    async withdraw(code: string, amount: number, address: string, tag?: string, params?: Record<string, unknown>) {
      calls.push(["withdraw", code, amount, address, tag, params]);
      const id = `wd-${withdrawals.length + 1}`;
      withdrawals.push({ id, status: "pending" });
      return { id, status: "pending", txid: null };
    },
    async fetchWithdrawals() {
      calls.push(["fetchWithdrawals"]);
      return withdrawals;
    },
    async transfer(code: string, amount: number, from: string, to: string) {
      calls.push(["transfer", code, amount, from, to]);
      return { id: "tr-1", status: "ok" };
    },
    async createOrder(symbol: string, type: string, side: string, amount: number) {
      calls.push(["createOrder", symbol, type, side, amount]);
      return { id: "o-1", cost: amount, status: "closed" };
    },
    async createMarketBuyOrderWithCost(symbol: string, cost: number) {
      calls.push(["createMarketBuyOrderWithCost", symbol, cost]);
      return { id: "o-2", filled: cost - 0.01, status: "closed" };
    },
  };
  return x as unknown as ExchangeClient & { calls: Call[]; withdrawals: Array<{ id: string; status: string }> };
}

function chainStandIn(held: Record<string, number> = {}): ChainReader & { receipts: Record<string, Mined> } {
  const receipts: Record<string, Mined> = {};
  return {
    receipts,
    async tokens(_holder, refs) {
      return { rows: refs.map((r) => ({ chain: r.chain, asset: r.asset, amount: held[`${r.chain}:${r.asset}`] ?? 0 })), failed: [] };
    },
    async native(_holder, chains) {
      return { rows: chains.map((c: ChainName) => ({ chain: c, asset: "ETH", amount: 0 })), failed: [] };
    },
    async uint() {
      return undefined;
    },
    async decimals() {
      return 6;
    },
    async receipt(_chain, hash) {
      return receipts[hash.toLowerCase()];
    },
  };
}

async function boot(o: { writes?: boolean; cap?: number; exchange?: ReturnType<typeof okxStandIn>; owners?: boolean } = {}) {
  let t = START;
  let real = 5_000_000;
  let n = 0;
  const home = mkdtempSync(join(tmpdir(), "account-live-writes-"));
  homes.push(home);
  const okx = o.exchange ?? okxStandIn();
  const chain = chainStandIn({ "Arbitrum:USDC": 80 });
  const open: OpenExchange = async (id) => (id === "okx" ? okx : undefined);
  const mmCalls: string[][] = [];
  const liveDeps: Partial<LiveDeps> = { openExchange: open, clock: () => real, chain, price: async () => undefined, http: async () => ({ status: 599, body: undefined, text: "" }), mm: async <T>(args: string[]) => { mmCalls.push(args); return (args[1] === "show" ? { address: "0x00000000000000000000000000000000000000Aa", tradingMode: "guard", policyYaml: "rolling_24h: 50" } : args[1] === "balance" ? { currency: "usd", totalValue: "40", chains: [{ chainName: "Base", tokens: [{ symbol: "USDC", balance: "40", value: "40" }] }] } : {}) as T; } };
  const svc = await PortfolioService.create({ home, now: () => new Date(t).toISOString(), venues: "frontline", liveDeps, ...(o.writes === false ? {} : { liveWrites: { capUsd: o.cap ?? 100, pairingCode: "K7QX-M2PA" } }), account: o.owners === false ? {} : { owners: [{ id: owner.address, kind: "eoa", label: "owner", addedAt: new Date(START).toISOString() }] } });
  const engine = svc.account!;
  const nonce = () => t + ++n;
  const own = async (a: NoNonce<OwnerAction>) => svc.exchange(await signOwner(owner, { ...a, nonce: nonce() } as OwnerAction));
  const ownEnvelope = async (a: NoNonce<OwnerAction>) => signOwner(owner, { ...a, nonce: nonce() } as OwnerAction);
  const ag = async (a: NoNonce<AgentAction>) => svc.exchange(await signAgent(cc, { ...a, nonce: nonce() } as AgentAction));
  const keyFile = (ref: string, content: unknown) => {
    const path = join(home, ref);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(content));
    chmodSync(path, 0o600);
  };
  keyFile("credentials/okx/api-key.json", { apiKey: "made-up-key", secret: "made-up-secret", password: "made-up-pass" });
  /** a wallet made here: it signs the account's sentence, then it is connected, proven */
  const provenWallet = async (venue = "wallet-mine") => {
    const w = privateKeyToAccount(generatePrivateKey());
    const c = svc.proofs.challenge(w.address, "OKX Wallet", { domain: "127.0.0.1:4820", uri: "http://127.0.0.1:4820/account" });
    if (isRefusal(c)) throw new Error(c.message);
    await svc.proofs.prove(w.address, await w.signMessage({ message: c.message }));
    const r = await own({ type: "connectVenue", venue, connector: "live:wallet", label: "", credentialRef: w.address });
    if (isRefusal(r)) throw new Error(r.message);
    return w;
  };
  const connectOkx = () => own({ type: "connectVenue", venue: "okx", connector: "live:exchange:okx", label: "", credentialRef: "" });
  /** what the page does: prepare (the account fills in the address, the fee and the deadline), then the owner signs exactly that */
  const prepared = async (draft: Record<string, unknown>) => {
    const p = await engine.prepare({ type: "liveMove", ...draft });
    if (isRefusal(p)) return p;
    return p.action as Extract<OwnerAction, { type: "liveMove" }>;
  };
  const move = async (draft: Record<string, unknown>, change: Partial<Extract<OwnerAction, { type: "liveMove" }>> = {}) => {
    const a = await prepared(draft);
    if (isRefusal(a)) return a;
    const { nonce: _n, ...rest } = a;
    return own({ ...rest, ...change } as NoNonce<OwnerAction>);
  };
  return { svc, engine, okx, chain, own, ownEnvelope, ag, connectOkx, provenWallet, prepared, move, mmCalls, tick: (ms: number) => (real += ms), pass: (ms: number) => (t += ms) };
}

const code = (o: Outcome): string => (isRefusal(o) ? o.code : o.kind);
const refusal = (o: Outcome | Refusal | unknown): Refusal => {
  if (!isRefusal(o)) throw new Error(`expected a refusal, got ${JSON.stringify(o).slice(0, 200)}`);
  return o;
};
const paidLive = (o: Outcome) => {
  if (isRefusal(o) || o.kind !== "payment") throw new Error(`expected a payment, got ${isRefusal(o) ? `${o.code}: ${o.message}` : o.kind}`);
  return o.payment;
};
const withdraws = (x: { okx: { calls: Call[] } }) => x.okx.calls.filter((c) => c[0] === "withdraw");

describe("real money at venues connected live", () => {
  it("moves nothing on a server started without real-money writes, and says how to turn them on", async () => {
    const x = await boot({ writes: false });
    await x.connectOkx();
    await x.provenWallet();
    const no = refusal(await x.prepared({ kind: "withdraw", from: "okx", to: "wallet-mine", asset: "USDC", network: "Arbitrum", amount: "25" }));
    expect([no.code, no.message]).toEqual(["E_WALLET_LIVE_WRITES_OFF", "this server moves no real money: it was started without real-money writes. To turn them on, stop it and start it again with: npm run portfolio -- --live-writes"]);
    expect(withdraws(x)).toHaveLength(0);
  });

  it("an exchange withdrawal to a wallet that proved it is yours: the owner signs the address the account found, and it lands when the exchange says", async () => {
    const x = await boot();
    await x.connectOkx();
    const w = await x.provenWallet();
    const a = await x.prepared({ kind: "withdraw", from: "okx", to: "wallet-mine", asset: "USDC", network: "Arbitrum", amount: "25" });
    if (isRefusal(a)) throw new Error(a.message);
    // what the owner sees and signs: the wallet's own address, the fee OKX quotes, ten minutes on the real clock
    expect([a.toAddress, a.maxFee, a.deadline - 5_000_000]).toEqual([w.address, "0.10", 600_000]);
    const view = await x.engine.prepare({ type: "liveMove", kind: "withdraw", from: "okx", to: "wallet-mine", asset: "USDC", network: "Arbitrum", amount: "25" });
    if (isRefusal(view)) throw new Error(view.message);
    expect([view.accountChain, view.quote?.live]).toEqual(["Live · real money", { toAddress: w.address, network: "Arbitrum", capUsd: 100 }]);

    const p = paidLive(await x.move({ kind: "withdraw", from: "okx", to: "wallet-mine", asset: "USDC", network: "Arbitrum", amount: "25" }));
    expect(withdraws(x)).toEqual([["withdraw", "USDC", 25, w.address, undefined, { network: "ARBITRUM", clientId: p.id.replace(/[^A-Za-z0-9]/g, "") }]]);
    expect([p.status, p.kind, p.live, p.feeUsd, p.authority]).toEqual(["pending", "withdraw", { kind: "withdraw", toAddress: w.address, network: "Arbitrum" }, 0.1, "owner"]);

    // the exchange is asked whether it went, at most every twenty seconds
    x.okx.withdrawals[0]!.status = "ok";
    await x.engine.settle();
    expect(p.status).toBe("pending");
    x.tick(21_000);
    await x.engine.settle();
    expect([p.status, p.note]).toEqual(["settled", "landed: OKX says it is done"]);
    const rows = x.svc.rows().filter((r) => r.tool === "live withdraw").map((r) => r.outcome);
    expect(rows).toEqual(["pending", "settled"]);
  });

  it("money goes only to a place shown to be yours, at the address that was signed, for no more than was signed, within ten minutes", async () => {
    const x = await boot();
    await x.connectOkx();
    // a wallet connected by pasting its address is watched, not proven
    const stranger = privateKeyToAccount(generatePrivateKey());
    await x.own({ type: "connectVenue", venue: "wallet-pasted", connector: "live:wallet", label: "", credentialRef: stranger.address });
    const watched = refusal(await x.prepared({ kind: "withdraw", from: "okx", to: "wallet-pasted", asset: "USDC", network: "Arbitrum", amount: "25" }));
    expect([watched.code, watched.message]).toEqual(["E_ACCOUNT_DESTINATION", "Wallet is watched, not proven yours: real money goes only to an address a wallet signed for. Connect it again from the wallet itself"]);
    // nor is anything sent from it
    const fromWatched = refusal(await x.prepared({ kind: "send", from: "wallet-pasted", to: "okx", asset: "USDC", network: "Arbitrum", amount: "5" }));
    expect([fromWatched.code, fromWatched.message]).toEqual(["E_VENUE_RAIL_CLOSED", "Wallet is watched, not proven yours: nothing is sent from it here. Connect it again from the wallet itself"]);

    const w = await x.provenWallet();
    // the signed address is someone else's: nothing is sent
    const swapped = refusal(await x.move({ kind: "withdraw", from: "okx", to: "wallet-mine", asset: "USDC", network: "Arbitrum", amount: "25" }, { toAddress: stranger.address }));
    expect(swapped.code).toBe("E_ACCOUNT_REQUOTE");
    expect(swapped.message).toContain(`now gives ${w.address} as the address, not the ${stranger.address} that was signed for`);
    // more than the cap
    expect(code(await x.move({ kind: "withdraw", from: "okx", to: "wallet-mine", asset: "USDC", network: "Arbitrum", amount: "150" }))).toBe("E_ACCOUNT_LIMIT");
    // the fee went up after the owner signed
    const a = await x.prepared({ kind: "withdraw", from: "okx", to: "wallet-mine", asset: "USDC", network: "Arbitrum", amount: "25" });
    if (isRefusal(a)) throw new Error(a.message);
    (x.okx as unknown as { setFee(f: number): void }).setFee(0.6);
    const { nonce: _n, ...signed } = a;
    expect(refusal(await x.own(signed)).message).toBe("OKX now charges 0.6 USDC; the signature allows 0.10: nothing was sent. Prepare it again");
    (x.okx as unknown as { setFee(f: number): void }).setFee(0.1);
    // signed eleven minutes ago, by the real clock
    x.tick(11 * 60_000);
    expect(refusal(await x.own({ ...signed })).code).toBe("E_ACCOUNT_EXPIRED");
    // a venue that is only read is never a source or a destination
    expect(withdraws(x)).toHaveLength(0);
  });

  it("the same signed instruction twice is one withdrawal", async () => {
    const x = await boot();
    await x.connectOkx();
    await x.provenWallet();
    const a = await x.prepared({ kind: "withdraw", from: "okx", to: "wallet-mine", asset: "USDC", network: "Arbitrum", amount: "10" });
    if (isRefusal(a)) throw new Error(a.message);
    const envelope = await signOwner(owner, a);
    const first = await x.svc.exchange(envelope);
    const again = await x.svc.exchange(envelope);
    expect([code(first), again === first || JSON.stringify(again) === JSON.stringify(first), withdraws(x).length]).toEqual(["payment", true, 1]);
  });

  it("between an exchange's own ledgers, and a stablecoin swap there: one call each, done at once", async () => {
    const x = await boot();
    await x.connectOkx();
    const moved = paidLive(await x.move({ kind: "transfer", from: "okx", to: "okx", fromLedger: "funding", toLedger: "trading", asset: "USDT", network: "", amount: "50" }));
    expect([moved.status, x.okx.calls.filter((c) => c[0] === "transfer")]).toEqual(["settled", [["transfer", "USDT", 50, "funding", "trading"]]]);
    expect(code(await x.move({ kind: "transfer", from: "okx", to: "okx", fromLedger: "funding", toLedger: "somewhere", asset: "USDT", network: "", amount: "50" }))).toBe("E_VENUE_RAIL_CLOSED");
    // USDT for USDC: the market is USDC/USDT, so it is a buy of USDC spending USDT — by cost, as OKX takes it
    const swapped = paidLive(await x.move({ kind: "swap", from: "okx", to: "okx", asset: "USDT", toAsset: "USDC", network: "", amount: "20" }));
    expect([swapped.status, swapped.receiveUsd, x.okx.calls.filter((c) => c[0] === "createMarketBuyOrderWithCost")]).toEqual(["settled", 19.99, [["createMarketBuyOrderWithCost", "USDC/USDT", 20]]]);
    paidLive(await x.move({ kind: "swap", from: "okx", to: "okx", asset: "USDC", toAsset: "USDT", network: "", amount: "5" }));
    expect(x.okx.calls.filter((c) => c[0] === "createOrder")).toEqual([["createOrder", "USDC/USDT", "market", "sell", 5]]);
    // a key OKX says may only read cannot trade
    const y = await boot({ exchange: okxStandIn({ perm: "read_only" }) });
    await y.connectOkx();
    expect(refusal(await y.move({ kind: "swap", from: "okx", to: "okx", asset: "USDT", toAsset: "USDC", network: "", amount: "20" })).message).toBe("OKX: this key may not trade, so it cannot swap");
  });

  it("a key that only reads: nothing leaves the exchange, and the exchange can still receive from your wallet", async () => {
    const x = await boot({ exchange: okxStandIn({ perm: "read_only" }) });
    const connected = await x.connectOkx();
    expect(!isRefusal(connected) && connected.kind === "account" && connected.summary).toContain("· this key only reads: money can be sent to it, nothing leaves it from here");
    const okx = (await x.svc.accountView())!.venues.find((v) => v.id === "okx")!;
    expect(okx.liveCan).toEqual({ withdraw: false, ledgers: ["trading", "funding"], transfer: false, swap: false, receive: true, send: false });
    // asked anyway — by an agent, or a page that did not know — the account says no before OKX is asked
    const t = refusal(await x.move({ kind: "transfer", from: "okx", to: "okx", fromLedger: "funding", toLedger: "trading", asset: "USDT", network: "", amount: "5" }));
    expect([t.code, t.message]).toEqual(["E_VENUE_RAIL_CLOSED", "OKX: this key may not move money between its own ledgers. That is set on the key at the exchange"]);
    await x.provenWallet();
    expect(refusal(await x.move({ kind: "withdraw", from: "okx", to: "wallet-mine", asset: "USDC", network: "Arbitrum", amount: "5" })).message).toBe("OKX: this key may not withdraw. That is set on the key at the exchange");
    // the other way it works: your wallet sends to OKX's own deposit address
    const sent = await x.move({ kind: "send", from: "wallet-mine", to: "okx", asset: "USDC", network: "Arbitrum", amount: "3" });
    expect(!isRefusal(sent) && sent.kind).toBe("result");
    expect(x.okx.calls.map((c) => c[0])).toEqual(["fetchDepositAddress", "fetchDepositAddress"]);
  });

  it("what a key may do is read in each exchange's own terms", () => {
    const may = (id: string, said: string[]) => {
      const c = exchangeWriter({ id } as unknown as ExchangeClient, id, id, [], { can: said }, ["spot", "funding"]).can;
      return [c.withdraw, c.transfer, c.swap];
    };
    // Binance: a move between the account's own wallets is a permission of its own, and trading futures is not trading spot
    expect(may("binance", ["read", "trade spot and margin"])).toEqual([false, false, true]);
    expect(may("binance", ["read", "move between its own wallets", "withdraw"])).toEqual([true, true, false]);
    expect(may("binance", ["read", "trade futures"])).toEqual([false, false, false]);
    // OKX: moving between its own accounts comes with trading
    expect(may("okx", ["read", "trade"])).toEqual([false, true, true]);
    expect(may("okx", ["read"])).toEqual([false, false, false]);
    // an exchange that does not say: its first refusal will
    expect(may("kraken", [])).toEqual(["unknown", "unknown", "unknown"]);
  });

  it("from your own wallet: the account builds the transaction, your wallet sends it, and the chain says whether it was this payment", async () => {
    const x = await boot();
    await x.connectOkx();
    const w = await x.provenWallet();
    const r = await x.move({ kind: "send", from: "wallet-mine", to: "okx", asset: "USDC", network: "Arbitrum", amount: "25" });
    if (isRefusal(r) || r.kind !== "result") throw new Error(`expected a wallet transaction, got ${JSON.stringify(r).slice(0, 200)}`);
    const { payment, wallet } = r.result as { payment: { id: string; status: string; kind: string }; wallet: { chainId: number; chainIdHex: string; from: string; to: string; data: Hex } };
    // nothing was signed here: this is what the wallet is asked to send — 25 USDC to OKX's own deposit address, on Arbitrum
    expect([payment.status, payment.kind, wallet.chainId, wallet.chainIdHex, wallet.from, wallet.to]).toEqual(["authorized", "deposit", 42161, "0xa4b1", w.address, USDC_ARB]);
    expect(decodeFunctionData({ abi: erc20Abi, data: wallet.data })).toEqual({ functionName: "transfer", args: [OKX_DEPOSIT, 25_000_000n] });

    // the wallet sent it; the chain has a transfer of exactly that
    const hash = keccak256(stringToHex("a made-up transaction")) as Hex;
    const topic = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}` as Hex;
    const transferTopic = keccak256(stringToHex("Transfer(address,address,uint256)"));
    x.chain.receipts[hash.toLowerCase()] = { status: "success", from: w.address, to: USDC_ARB as Hex, logs: [{ address: USDC_ARB as Hex, topics: [transferTopic, topic(w.address), topic(OKX_DEPOSIT)], data: encodeAbiParameters([{ type: "uint256" }], [25_000_000n]) }] };
    const sent = await x.engine.live.sent(payment.id, hash);
    expect(!isRefusal(sent) && sent.kind === "payment" && [sent.payment.status, sent.payment.live?.txHash]).toEqual(["settled", hash]);

    // a transaction that is not this payment does not settle it
    const r2 = await x.move({ kind: "send", from: "wallet-mine", to: "okx", asset: "USDC", network: "Arbitrum", amount: "30" });
    const id2 = (r2 as { result: { payment: { id: string } } }).result.payment.id;
    const other = keccak256(stringToHex("another made-up transaction")) as Hex;
    x.chain.receipts[other.toLowerCase()] = { status: "success", from: w.address, to: USDC_ARB as Hex, logs: [{ address: USDC_ARB as Hex, topics: [transferTopic, topic(w.address), topic(OKX_DEPOSIT)], data: encodeAbiParameters([{ type: "uint256" }], [1_000_000n]) }] };
    const wrong = await x.engine.live.sent(id2, other);
    expect(!isRefusal(wrong) && wrong.kind === "payment" && [wrong.payment.status, wrong.payment.note]).toEqual(["failed", `transaction ${other.slice(0, 10)}… is on Arbitrum, but it is not this payment: no transfer of 30 USDC from ${w.address} to ${OKX_DEPOSIT}`]);
    expect(code(await x.engine.live.sent("pay-9999", hash))).toBe("E_ACCOUNT_BAD_ACTION");
  });

  it("an agent can only ask: a card every time, showing the address and the fee, and the owner's yes is what moves it", async () => {
    const x = await boot();
    await x.connectOkx();
    const w = await x.provenWallet();
    await x.own({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: START + 30 * DAY });
    await x.own({ type: "approveSpend", agent: cc.address, scope: "venues", allow: "okx,wallet-mine", perPayment: "100", budget: "200", windowHours: 0, validUntil: START + 7 * DAY });
    const ask = { type: "agentLiveMove" as const, kind: "withdraw", from: "okx", fromLedger: "", to: "wallet-mine", toLedger: "", asset: "USDC", toAsset: "USDC", network: "Arbitrum", amount: "40", maxFee: "1" };
    const r = await x.ag(ask);
    if (isRefusal(r) || r.kind !== "card") throw new Error(`expected a card, got ${JSON.stringify(r).slice(0, 200)}`);
    expect([r.card.offer?.payTo, r.card.offer?.network, (r.card as { why?: string }).why, withdraws(x).length]).toEqual([w.address, "Arbitrum", "live", 0]);
    expect(r.card.reason).toBe("Claude Code asks to send 40 USDC from OKX to OKX Wallet on Arbitrum. This is real money: you sign the address and the fee");
    const spend = () => x.engine.state.spends.find((s) => s.scope === "venues" && s.revokedAt === undefined)!;
    expect(spend().reservedMicro).toBe(40_000_000);
    // the owner says yes: now it moves, and it counts in the approval
    const yes = await x.own({ type: "approveCard", card: r.card.id, action: cardHash(r.card), decision: "approve" });
    expect([code(yes), withdraws(x).length, spend().spentMicro, spend().reservedMicro]).toEqual(["payment", 1, 40_000_000, 0]);
    // outside its approval it is not even a card
    expect(code(await x.ag({ ...ask, amount: "150" }))).toBe("E_MANDATE_PER_ORDER_CAP");
    expect(code(await x.ag({ ...ask, to: "okx", kind: "swap", toAsset: "USDT" }))).not.toBe("payment");
    // a no moves nothing
    const r2 = await x.ag({ ...ask, amount: "5" });
    if (isRefusal(r2) || r2.kind !== "card") throw new Error("expected a card");
    await x.own({ type: "approveCard", card: r2.card.id, action: cardHash(r2.card), decision: "reject" });
    expect(withdraws(x).length).toBe(1);
  });

  it("the MetaMask Agent Wallet sends only when MetaMask's own switch is on too", async () => {
    const x = await boot();
    await x.connectOkx();
    await x.own({ type: "connectVenue", venue: "metamask", connector: "live:metamask", label: "", credentialRef: "" });
    // Robinhood Chain is read, not paid on: it carries no dollar stablecoin this account knows
    expect(refusal(await x.move({ kind: "send", from: "metamask", to: "okx", asset: "USDC", network: "Robinhood Chain", amount: "10" })).message).toBe("a network is one of Ethereum, Optimism, BNB Chain, Polygon, Base, Arbitrum");
    // OKX takes USDC on Arbitrum and Ethereum here: Base is not one of its networks, and the account says so before anything else
    expect(refusal(await x.move({ kind: "send", from: "metamask", to: "okx", asset: "USDC", network: "Base", amount: "10" })).message).toBe("OKX does not carry USDC on Base: it lists ARBITRUM, ERC20");
    const off = refusal(await x.move({ kind: "send", from: "metamask", to: "okx", asset: "USDC", network: "Arbitrum", amount: "10" }));
    expect([off.code, off.message]).toEqual(["E_WALLET_LIVE_WRITES_OFF", `MetaMask's own switch is off (PORTFOLIO_MM_WRITES is not 1). The command that would run: mm transfer --to ${OKX_DEPOSIT} --amount 10 --chain-id 42161 --token USDC`]);
    expect(x.mmCalls.some((c) => c[0] === "transfer")).toBe(false);
  });

  it("a venue that is only read is never a source or a destination of real money", async () => {
    const http = async (url: string) => (url.endsWith("/v2/account") ? { status: 200, body: { cash: "100" }, text: "" } : { status: 200, body: [], text: "" });
    const x = await boot();
    (x.svc as unknown as { opts: { liveDeps: Partial<LiveDeps> } }).opts.liveDeps.http = http as never;
    await x.connectOkx();
    const home = (x.svc as unknown as { opts: { home: string } }).opts.home;
    mkdirSync(join(home, "credentials/alpaca"), { recursive: true });
    writeFileSync(join(home, "credentials/alpaca/api-key.json"), JSON.stringify({ keyId: "made-up", secret: "made-up-too" }), { mode: 0o600 });
    expect(code(await x.own({ type: "connectVenue", venue: "alpaca", connector: "live:alpaca", label: "", credentialRef: "" }))).toBe("account");
    const to = refusal(await x.prepared({ kind: "withdraw", from: "okx", to: "alpaca", asset: "USDC", network: "Arbitrum", amount: "10" }));
    expect([to.code, to.message]).toEqual(["E_ACCOUNT_DESTINATION", "Alpaca: Alpaca's API moves no cash: deposits and withdrawals are made at Alpaca"]);
    const from = refusal(await x.prepared({ kind: "send", from: "alpaca", to: "okx", asset: "USDC", network: "Arbitrum", amount: "10" }));
    expect(from.message).toBe("Alpaca: Alpaca's API moves no cash: deposits and withdrawals are made at Alpaca");
    // and a simulated venue is not a live one
    expect(refusal(await x.prepared({ kind: "withdraw", from: "okx", to: "binance", asset: "USDC", network: "Arbitrum", amount: "10" })).code).toBe("E_ACCOUNT_DESTINATION");
  });
});

describe("a server that moves real money", () => {
  it("makes the first browser the owner only with the code its terminal printed", async () => {
    const x = await boot({ owners: false });
    const jwk = { kty: "EC", crv: "P-256", x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU", y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0" };
    const first = x.engine.pairDevice(jwk);
    expect(!isRefusal(first) && first.role).toBe("needs-code");
    const wrong = x.engine.pairDevice(jwk, "this browser", "AAAA-BBBB");
    expect(isRefusal(wrong) && wrong.message).toBe("that is not the pairing code this server printed in its terminal (4 tries left)");
    const right = x.engine.pairDevice(jwk, "this browser", "k7qx m2pa");
    expect(!isRefusal(right) && right.role).toBe("owner");
    // a server without real money keeps the simulation's first-come rule
    const y = await boot({ owners: false, writes: false });
    const plain = y.engine.pairDevice(jwk);
    expect(!isRefusal(plain) && plain.role).toBe("owner");
  });
});
