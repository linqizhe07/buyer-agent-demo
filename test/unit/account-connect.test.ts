import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeFunctionData } from "viem";
import { afterAll, describe, expect, it } from "vitest";
import { isRefusal, type Refusal } from "../../src/core/errors.ts";
import type { Outcome } from "../../src/portfolio/account/exchange.ts";
import { cctpForwardHook } from "../../src/portfolio/account/doors.ts";
import { signAgent, signOwner, simKey, type AgentAction, type Hex, type OwnerAction, type SimKey } from "../../src/portfolio/account/sign.ts";
import { PortfolioService } from "../../src/portfolio/service.ts";

type NoNonce<T> = T extends unknown ? Omit<T, "nonce"> : never;
const START = Date.parse("2026-10-05T14:00:00.000Z");
const MIN = 60_000;
const DAY = 86_400_000;
const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));

const owner = simKey("owner");
const cc = simKey("agent:claude-code");

async function boot() {
  let t = START;
  let n = 0;
  const home = mkdtempSync(join(tmpdir(), "account-connect-"));
  homes.push(home);
  const svc = await PortfolioService.create({ home, now: () => new Date(t).toISOString(), venues: "frontline", account: { owners: [{ id: owner.address, kind: "eoa", label: "owner", addedAt: new Date(START).toISOString() }] } });
  const engine = svc.account!;
  const nonce = () => t + ++n;
  const own = async (a: NoNonce<OwnerAction>, by: SimKey = owner) => svc.exchange(await signOwner(by, { ...a, nonce: nonce() } as OwnerAction));
  const ag = async (a: NoNonce<AgentAction>) => svc.exchange(await signAgent(cc, { ...a, nonce: nonce() } as AgentAction));
  const pass = async (ms: number) => {
    t += ms;
    await engine.settle();
  };
  const connect = (venue: string, connector: string, label = "") => own({ type: "connectVenue", venue, connector, label, credentialRef: "" });
  const transfer = (sourceDex: string, destinationDex: string, amount: string) => ag({ type: "agentSendAsset", destination: "self", sourceDex, destinationDex, token: "USDC", amount, fromSubAccount: "", maxFee: "5" });
  const send = async (a: { sourceDex: string; destinationDex: string; amount: string }) => {
    const base = { destination: "self", sourceDex: a.sourceDex, destinationDex: a.destinationDex, token: "USDC", amount: a.amount };
    const r = await engine.resolve(base, "owner");
    if (isRefusal(r)) return r;
    return own({ type: "sendAsset", ...base, fromSubAccount: "", route: r.route.hash, maxFee: String(r.route.feeUsd), deadline: r.route.arrivalMs + MIN });
  };
  const held = async (id: string, asset: string, where?: string) => (await svc.read(id)).filter((h) => h.asset === asset && !h.inTransit && (where === undefined || h.note === where || h.note?.startsWith(where))).reduce((s, h) => s + h.amount, 0);
  const agent = async (allow: string) => {
    await own({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: t + 30 * DAY });
    await own({ type: "approveSpend", agent: cc.address, scope: "venues", allow, perPayment: "600", budget: "5000", windowHours: 0, validUntil: t + 30 * DAY });
  };
  const venue = async (id: string) => (await engine.view()).venues.find((v) => v.id === id);
  return { svc, engine, own, ag, pass, connect, transfer, send, held, agent, venue, now: () => t };
}

const code = (o: Outcome): string => (isRefusal(o) ? o.code : o.kind);
const refusal = (o: Outcome): Refusal => {
  if (!isRefusal(o)) throw new Error(`expected a refusal, got ${o.kind}`);
  return o;
};
const paid = (o: Outcome) => {
  if (isRefusal(o) || o.kind !== "payment") throw new Error(`expected a payment, got ${isRefusal(o) ? `${o.code}: ${o.message}` : o.kind}`);
  return o.payment;
};

describe("plugging in a venue the user already has", () => {
  it("is one owner signature and no code: the venue appears with doors compiled from what it says about the key", async () => {
    const x = await boot();
    const before = await x.engine.view();
    expect(before.connectable.map((c) => [c.id, c.connector, c.via])).toEqual([
      ["bybit", "unified", "Any exchange · the unified library (ccxt)"],
      ["kraken", "unified", "Any exchange · the unified library (ccxt)"],
      ["okx-second", "okx", "OKX · its own REST API"],
      ["okx-wallet", "wallet", "A self-custody wallet · by its address"],
    ]);
    const done = await x.connect("bybit", "unified");
    expect(!isRefusal(done) && done.kind === "account" && done.summary).toBe("Bybit plugged in · the venue says this credential can read, trade · withdrawals stay at the exchange: this key has no withdraw permission · money in: an agent's key may; money out: only at the venue itself");
    const after = await x.engine.view();
    expect(after.venues).toHaveLength(9);
    const bybit = after.venues.find((v) => v.id === "bybit")!;
    // 3,200 USDT and 0.4 ETH, read from the exchange
    expect([bybit.name, bybit.frontLine, bybit.usd, bybit.cashUsd, bybit.plugged]).toEqual(["Bybit", "Exchange", 4176, 3200, true]);
    expect([bybit.in.access, bybit.out.access, bybit.out.why]).toEqual(["agent", "venue", "this key has no withdraw permission"]);
    expect(bybit.agentKey).toEqual({ model: "API key with separate permissions, used through the unified library", can: "read, trade", cannot: "withdraw" });
    expect(bybit.runways.map((r) => `${r.dir}: ${r.protocol} [${r.access}]`)).toEqual(["In: fetchDepositAddress (unified API) [agent]", "Out: withdraw (unified API) [venue]", "Swap: createOrder on the USDC/USDT market (unified API) [agent]"]);
    expect(after.totalUsd).toBe(before.totalUsd + 4176);
    expect(after.connectable.map((c) => c.id)).toEqual(["kraken", "okx-second", "okx-wallet"]);
    // the statement page and its liquidity map take the new venue as they take the others
    const o = await x.svc.overview();
    expect(o.accounts.map((a) => a.id)).toContain("bybit");
    expect(o.portfolio.totalUsd).toBeGreaterThan(0);
    // the ledger has the owner's signed instruction and the venue's answer about the key
    const row = x.svc.rows().find((r) => r.tool === "connectVenue" && r.outcome === "ok")!;
    expect(row.native).toEqual({ connector: "unified", probe: { permissions: ["read", "trade"], ipRestrict: true } });
    expect(row.signer).toBe(owner.address);
  });

  it("\"every venue\" in an approval is the venues the account had when it was signed: one plugged in later is not in it", async () => {
    const x = await boot();
    await x.agent("*");
    const standing = x.engine.state.spends.find((s) => s.revokedAt === undefined)!;
    expect(standing.allow).toEqual(["alpaca", "binance", "okx", "hyperliquid", "metamask", "kalshi", "polymarket", "ondo"]);
    await x.connect("kraken", "unified");
    await x.connect("okx-wallet", "wallet");
    // neither as a source nor as a place to put money: the agent cannot drain the new exchange, nor park money in a wallet the account holds no key for
    expect(code(await x.transfer("kraken", "hyperliquid", "300"))).toBe("E_MANDATE_RECIPIENT");
    expect(code(await x.transfer("metamask", "okx-wallet", "50"))).toBe("E_MANDATE_RECIPIENT");
    expect(code(await x.transfer("okx", "hyperliquid", "100"))).toBe("payment");
  });

  it("only the owner plugs a venue in, and only one that answers through the connector named", async () => {
    const x = await boot();
    await x.agent("*");
    expect(code(await x.own({ type: "connectVenue", venue: "bybit", connector: "unified", label: "", credentialRef: "" }, cc))).toBe("E_ACCOUNT_OWNER_ONLY");
    expect(code(await x.connect("ftx", "unified"))).toBe("E_WALLET_ACCOUNT_UNKNOWN");
    expect(code(await x.connect("bybit", "okx"))).toBe("E_VENUE_REJECTED");
    expect(code(await x.connect("okx", "okx"))).toBe("E_ACCOUNT_BAD_ACTION");
    expect(code(await x.connect("bybit", "unified", "Bybit · main"))).toBe("account");
    expect((await x.venue("bybit"))!.name).toBe("Bybit · main");
    expect(code(await x.connect("bybit", "unified"))).toBe("E_ACCOUNT_BAD_ACTION");
    expect((await x.engine.view()).venues).toHaveLength(9);
  });

  it("a key that withdraws to the user's own verified address gives the agent a way out — once the owner names the venue in an approval", async () => {
    const x = await boot();
    await x.agent("okx,metamask,hyperliquid");
    await x.connect("kraken", "unified");
    await x.connect("bybit", "unified");
    expect((await x.venue("kraken"))!.out).toMatchObject({ access: "agent" });
    // plugged in is not approved: the agent's approval was signed before this venue existed here
    const early = refusal(await x.transfer("kraken", "hyperliquid", "300"));
    expect([early.code, early.message]).toEqual(["E_MANDATE_RECIPIENT", '"kraken" is not in the spending approval (okx, metamask, hyperliquid): it cannot be a source']);
    await x.agent("okx,metamask,hyperliquid,kraken,bybit");
    const p = paid(await x.transfer("kraken", "hyperliquid", "300"));
    expect(p.legs.map((l) => `${l.step}:${l.venue}`)).toEqual(["out:kraken", "out:metamask", "in:hyperliquid"]);
    // the leg at Kraken is the unified library's call, not a request this code wrote for Kraken
    expect(p.legs[0]!.native).toMatchObject({ library: "ccxt · unified API", exchange: "kraken", call: "withdraw", args: ["USDC", 300, expect.stringMatching(/^0x/), undefined, { network: "ARBONE" }] });
    await x.pass(7 * MIN);
    expect([p.status, await x.held("kraken", "USDC"), await x.held("hyperliquid", "USDC", "perps")]).toEqual(["settled", 1200, 1798.98]);
    // the same request at the venue whose key cannot withdraw
    const closed = refusal(await x.transfer("bybit", "hyperliquid", "300"));
    expect([closed.code, closed.message]).toEqual(["E_VENUE_RAIL_CLOSED", "Bybit: this key has no withdraw permission"]);
  });

  it("money goes into a plugged exchange through its deposit address, and the wallet lets it", async () => {
    const x = await boot();
    await x.agent("metamask,kraken");
    await x.connect("kraken", "unified");
    const p = paid(await x.transfer("metamask", "kraken", "100"));
    expect(p.legs.map((l) => `${l.step}:${l.venue}`)).toEqual(["out:metamask", "in:kraken"]);
    await x.pass(3 * MIN);
    expect([p.status, await x.held("kraken", "USDC")]).toEqual(["settled", 1500 + p.receiveUsd]);
    expect(p.legs[1]!.native).toMatchObject({ call: "fetchDepositAddress", exchange: "kraken" });
  });

  it("a read-only key at an exchange that has its own profile: balances, and every runway named in that exchange's own calls", async () => {
    const x = await boot();
    await x.connect("okx-second", "okx");
    const v = (await x.venue("okx-second"))!;
    expect([v.name, v.usd, v.out.access]).toEqual(["OKX · second account", 800, "venue"]);
    expect(v.runways.map((r) => `${r.dir}: ${r.protocol} [${r.access}]`)).toEqual(["In: GET /api/v5/asset/deposit-address [agent]", "Out: POST /api/v5/asset/withdrawal [venue]", "Inside: POST /api/v5/asset/transfer (18 → 6) [agent]", "Swap: POST /api/v5/asset/convert/trade [closed]"]);
    expect(v.agentKey.cannot).toBe("trade or withdraw");
    expect(code(await x.own({ type: "swap", venue: "okx-second", sell: "USDT", buy: "USDC", amount: "100", minReceive: "99" }))).toBe("E_VENUE_RAIL_CLOSED");
  });

  it("a self-custody wallet is plugged in by its address: money goes in at once, and comes out only when the owner signs in that wallet", async () => {
    const x = await boot();
    expect(code(await x.connect("okx-wallet", "wallet"))).toBe("account");
    await x.agent("*");
    const v = (await x.venue("okx-wallet"))!;
    expect([v.name, v.frontLine, v.usd, v.in.access, v.out.access, v.out.why]).toEqual(["OKX Wallet", "On-chain", 850, "agent", "owner", "the key is in the wallet: only you can sign there"]);
    expect(v.agentKey.cannot).toBe("move anything out: the key never leaves the wallet");
    const no = refusal(await x.transfer("okx-wallet", "hyperliquid", "200"));
    expect([no.code, no.message]).toEqual(["E_ACCOUNT_OWNER_ONLY", "OKX Wallet: the key is in the wallet: only you can sign there"]);
    // before the owner signs here, the page is told which leg is signed in the wallet itself; a leg INTO the wallet needs no such thing
    const shown = await x.engine.prepare({ type: "sendAsset", destination: "self", sourceDex: "okx-wallet", destinationDex: "hyperliquid", token: "USDC", amount: "200" });
    const into = await x.engine.prepare({ type: "sendAsset", destination: "self", sourceDex: "metamask", destinationDex: "okx-wallet", token: "USDC", amount: "50" });
    expect([!isRefusal(shown) && shown.quote?.signAt, !isRefusal(into) && into.quote?.signAt]).toEqual(["OKX Wallet", undefined]);
    const p = paid(await x.send({ sourceDex: "okx-wallet", destinationDex: "hyperliquid", amount: "200" }));
    expect([p.authority, p.legs.map((l) => `${l.step}:${l.venue}:${l.chain}`)]).toEqual(["owner", ["out:okx-wallet:Arbitrum", "out:metamask:Arbitrum", "in:hyperliquid:Arbitrum"]]);
    expect(p.legs[0]!.native).toMatchObject({ wallet: "okx-wallet", method: "eth_sendTransaction", signs: "the owner, in that wallet: the account holds no key for it" });
    await x.pass(3 * MIN);
    expect([p.status, await x.held("okx-wallet", "USDC", "Arbitrum")]).toEqual(["settled", 440]);
    // and the agent can send money TO it
    const back = paid(await x.transfer("metamask", "okx-wallet", "50"));
    await x.pass(MIN);
    expect(back.status).toBe("settled");
    expect((await x.venue("okx-wallet"))!.usd).toBeGreaterThan(650 + 49);
  });

  it("is unplugged with one signature too — but not while money is on its way, and not a venue the account opened with", async () => {
    const x = await boot();
    await x.connect("kraken", "unified");
    await x.agent("*");
    paid(await x.transfer("kraken", "hyperliquid", "300"));
    const busy = refusal(await x.own({ type: "disconnectVenue", venue: "kraken" }));
    expect([busy.code, busy.message]).toEqual(["E_ACCOUNT_BAD_ACTION", "Kraken has a payment in flight (pay-0001): it can be unplugged when that has landed"]);
    await x.pass(7 * MIN);
    expect(code(await x.own({ type: "disconnectVenue", venue: "okx" }))).toBe("E_ACCOUNT_BAD_ACTION");
    expect(code(await x.own({ type: "disconnectVenue", venue: "kraken" }, cc))).toBe("E_ACCOUNT_OWNER_ONLY");
    expect(code(await x.own({ type: "disconnectVenue", venue: "kraken" }))).toBe("account");
    expect((await x.engine.view()).venues.map((v) => v.id)).not.toContain("kraken");
    expect(code(await x.transfer("kraken", "hyperliquid", "100"))).toBe("E_WALLET_ACCOUNT_UNKNOWN");
    // it can be plugged in again; and a reset starts from the venues the account opened with
    expect(code(await x.connect("kraken", "unified"))).toBe("account");
    x.svc.reset();
    expect((await x.engine.view()).venues).toHaveLength(8);
  });
});

describe("the venue's own request on each leg", () => {
  it("OKX: the fee is charged on top of the amount, so the funding account is filled with both; the chain is named OKX's way", async () => {
    const x = await boot();
    await x.agent("*");
    const p = paid(await x.transfer("okx", "hyperliquid", "500"));
    const wd = p.legs[1]!.native as { before: { body: { amt: string; from: string; to: string } }; body: { amt: string; chain: string; dest: string } };
    // 499.95 is in flight after the swap; 0.80 is OKX's fee; 499.15 arrives
    expect([wd.before.body, wd.body.amt, wd.body.chain, wd.body.dest]).toEqual([{ ccy: "USDC", amt: "499.95", from: "18", to: "6", type: "0" }, "499.15", "USDC-Arbitrum One", "4"]);
    expect(p.legs[0]!.native).toMatchObject({ body: { baseCcy: "USDC", quoteCcy: "USDT", side: "buy", rfqSz: "500", rfqSzCcy: "USDT" } });
  });

  it("Hyperliquid: the deposit is real CCTP calldata that credits the Hyperliquid account; its own actions are built and left for the key that owns them", async () => {
    const x = await boot();
    await x.agent("*");
    const p = paid(await x.transfer("metamask", "hyperliquid", "300"));
    await x.pass(2 * MIN);
    const burn = p.legs[1]!.native as { to: string; data: Hex; args: { maxFee: string; hookData: string; burnToken: string }; signs: string };
    const call = decodeFunctionData({ abi: [{ type: "function", name: "depositForBurnWithHook", stateMutability: "nonpayable", inputs: [{ name: "amount", type: "uint256" }, { name: "destinationDomain", type: "uint32" }, { name: "mintRecipient", type: "bytes32" }, { name: "burnToken", type: "address" }, { name: "destinationCaller", type: "bytes32" }, { name: "maxFee", type: "uint256" }, { name: "minFinalityThreshold", type: "uint32" }, { name: "hookData", type: "bytes" }], outputs: [] }], data: burn.data });
    const account = simKey("hyperliquid:master-account").address;
    // 299.98 USDC after the wallet's gas, to HyperEVM (domain 19), minted to and callable only by Circle's forwarder, with the Hyperliquid account in the hook
    expect([call.args[0], call.args[1], call.args[2], call.args[4], call.args[6], call.args[7]]).toEqual([299_980_000n, 19, "0x000000000000000000000000b21d281dedb17ae5b501f6aa8256fe38c4e45757", "0x000000000000000000000000b21d281dedb17ae5b501f6aa8256fe38c4e45757", 1000, cctpForwardHook(account, false)]);
    // the fee ceiling leaves room for the forwarder's gas, which moves: 0.20 forwarding + 0.05
    expect([burn.args.maxFee, burn.signs]).toEqual(["250000", "the on-chain wallet (after an approve of the same amount): not signed here"]);
    // inside Hyperliquid an agent's move is `agentSendAsset` to the account itself; the owner's withdrawal is a user-signed action nobody here can sign
    const shift = paid(await x.transfer("hyperliquid:perps", "hyperliquid:spot", "100"));
    expect(shift.legs[0]!.native).toMatchObject({ type: "agentSendAsset", destination: account, sourceDex: "", destinationDex: "spot", token: "USDC:0x6d1e7cde53ba9467b783cb7c530ce054", signature: null });
    const out = paid(await x.send({ sourceDex: "hyperliquid", destinationDex: "metamask", amount: "200" }));
    expect(out.legs[0]!.native).toMatchObject({ type: "sendToEvmWithData", hyperliquidChain: "Testnet", signatureChainId: "0x66eee", primaryType: "HyperliquidTransaction:SendToEvmWithData", signature: null });
  });

  it("a regulated exchange with no funding API moves dollars only by ACH started there: the account routes nothing into it", async () => {
    const x = await boot();
    const r = await x.engine.resolve({ destination: "self", sourceDex: "metamask", destinationDex: "kalshi", token: "USD", amount: "100" }, "owner");
    expect(isRefusal(r) && [r.code, r.venue, r.message]).toEqual(["E_VENUE_RAIL_CLOSED", "kalshi", "Kalshi moves dollars only by ACH with your own bank, started at Kalshi: nothing between it and your other venues goes through the account"]);
    expect(x.engine.payments).toHaveLength(0);
  });
});
