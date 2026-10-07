import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, describe, expect, it } from "vitest";
import { isRefusal, type Refusal } from "../../src/core/errors.ts";
import { no } from "../../src/portfolio/refuse.ts";
import type { Outcome } from "../../src/portfolio/account/exchange.ts";
import { signAgent, signOwner, simKey, type AgentAction, type OwnerAction } from "../../src/portfolio/account/sign.ts";
import { cardHash } from "../../src/portfolio/account/exchange.ts";
import type { BridgeRoute } from "../../src/portfolio/live/bridge.ts";
import { register, type LiveDeps } from "../../src/portfolio/live/index.ts";
import type { WalletBridge } from "../../src/portfolio/live/wallet-bridge.ts";
import type { LiveWriter } from "../../src/portfolio/live/writes.ts";
import { PortfolioService } from "../../src/portfolio/service.ts";

/** Real money ACROSS CHAINS from the user's own wallet, against stand-ins: a wallet whose key is made here and thrown away, an exchange that
 * gives a deposit address, and a bridge that answers routes, checks hashes and says what arrived the way bridge.ts does. The rules tested
 * are the account's: the destination is the user's own, the cheapest route is the one signed for, the hash is held to the transaction that
 * was built, and the money is in no balance until the bridge says it arrived. */
type NoNonce<T> = T extends unknown ? Omit<T, "nonce"> : never;
const START = Date.parse("2026-10-05T14:00:00.000Z");
const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));
const owner = simKey("owner");
const cc = simKey("agent:claude-code");
const DEPOSIT = getAddress("0x00000000000000000000000000000000000dec0d");
const LIFI: Hex = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";

interface Bridge extends WalletBridge {
  asked: Array<Record<string, unknown>>;
  confirms: string[];
  feeUp: number;
  confirmAnswer: "pending" | "ok" | Refusal;
  statusAnswer: { status: "pending" | "settled" | "failed"; received?: number; note: string; native: unknown };
}

function standInBridge(from: Hex): Bridge {
  const tx = (data: Hex) => ({ chainId: 42161, chainIdHex: "0xa4b1" as Hex, from, to: LIFI, data, value: "0x0" as Hex });
  const b: Bridge = {
    chains: ["Ethereum", "Arbitrum", "Base", "Optimism", "Polygon", "BNB Chain"],
    asked: [],
    confirms: [],
    feeUp: 0,
    confirmAnswer: "ok",
    statusAnswer: { status: "settled", received: 24.95, note: "delivered: 24.95 USDC on Base", native: {} },
    async routes(r) {
      b.asked.push(r);
      const routes: BridgeRoute[] = [
        { id: "r-across", tool: "Across", feeUsd: 0.12 + b.feeUp, gasUsd: 0.03, receiveUsd: 24.88, etaSec: 60, approval: { token: from, spender: LIFI, amount: "25000000", txs: [{ ...tx("0x095ea7b3"), what: "approve" }] }, tx: tx("0xaaaa"), native: { tool: "across" } },
        { id: "r-cctp", tool: "CCTP", feeUsd: 0.05 + b.feeUp, gasUsd: 0.03, receiveUsd: 24.95, etaSec: 900, tx: tx("0xcccc"), native: { tool: "cctp" } },
      ];
      return routes;
    },
    async confirm(hash) {
      b.confirms.push(hash);
      return b.confirmAnswer;
    },
    async status() {
      return b.statusAnswer;
    },
  };
  return b;
}

let pending: { address: Hex; bridge: Bridge } | undefined;
register({ kind: "standin-bridge-wallet", label: "a wallet that bridges", needs: "address", example: "", venues: [], async open(req) {
  const w = pending!;
  const writer: LiveWriter = { can: { withdraw: false, ledgers: [], transfer: false, swap: false, receive: true, send: "wallet" }, async depositAddress() { return { address: w.address }; }, bridge: w.bridge };
  return { source: { name: req.label || "My wallet", kind: "agent-wallet", reference: w.address, via: "a stand-in", address: w.address, probe: { can: [], note: "" }, read: async () => [{ asset: "USDC", amount: 80, usd: 80, where: "Arbitrum" }], writer }, first: [{ asset: "USDC", amount: 80, usd: 80, where: "Arbitrum" }], summary: "connected" };
} });
register({ kind: "standin-bridge-exchange", label: "an exchange that takes deposits", needs: "key-file", example: "", venues: [], async open(req) {
  const writer: LiveWriter = { can: { withdraw: false, ledgers: [], transfer: false, swap: false, receive: true, send: false }, async depositAddress(asset, network) { return network === "BNB Chain" ? no("E_VENUE_RAIL_CLOSED", { message: `no ${asset} deposits on ${network}` }) : { address: DEPOSIT }; } };
  return { source: { name: req.label || "Exchange", kind: "cex", reference: "standin", via: "a stand-in", probe: { can: [], note: "" }, read: async () => [], writer }, first: [], summary: "connected" };
} });

async function boot(o: { proven?: boolean; home?: string; nonceFrom?: number; laterMs?: number; fresh?: boolean } = {}) {
  let real = 5_000_000;
  let n = o.nonceFrom ?? 0;
  const home = o.home ?? mkdtempSync(join(tmpdir(), "account-bridge-"));
  if (!o.home) homes.push(home);
  const liveDeps: Partial<LiveDeps> = { clock: () => real, http: async () => ({ status: 599, body: undefined, text: "" }), price: async () => undefined };
  // a later run starts later: its ledger is a file of its own
  // a later run of the same home continues the account (its venues connect again); `fresh` starts it from nothing
  const continuing = o.home !== undefined && !o.fresh && pending !== undefined;
  const w = continuing ? { address: pending!.address, signMessage: async () => "0x" as Hex } : privateKeyToAccount(generatePrivateKey());
  const bridge = continuing ? pending!.bridge : standInBridge(w.address);
  pending = { address: w.address, bridge };
  const svc = await PortfolioService.create({ home, now: () => new Date(START + (o.laterMs ?? 0)).toISOString(), venues: "frontline", real: true, liveDeps, liveWrites: { capUsd: 100, pairingCode: "K7QX-M2PA" }, fresh: o.fresh === true, account: { owners: [{ id: owner.address, kind: "eoa", label: "owner", addedAt: new Date(START).toISOString() }] } });
  await svc.restoring;
  const own = async (a: NoNonce<OwnerAction>) => svc.exchange(await signOwner(owner, { ...a, nonce: START + ++n } as OwnerAction));
  if (o.proven !== false && !continuing) {
    const c = svc.proofs.challenge(w.address, "OKX Wallet", { domain: "127.0.0.1:4820", uri: "http://127.0.0.1:4820/account" });
    if (isRefusal(c)) throw new Error(c.message);
    await svc.proofs.prove(w.address, await w.signMessage({ message: c.message }));
  }
  for (const [venue, connector] of [["wallet", "live:standin-bridge-wallet"], ["ex", "live:standin-bridge-exchange"]] as const) {
    if (svc.account!.host.adapter(venue)) continue;
    const r = await own({ type: "connectVenue", venue, connector, label: "", credentialRef: venue === "wallet" ? w.address : "" });
    if (isRefusal(r)) throw new Error(r.message);
  }
  const engine = svc.account!;
  const draft = { kind: "bridge", from: "wallet", to: "wallet", asset: "USDC", toAsset: "USDC", network: "Arbitrum", toLedger: "Base", amount: "25" };
  const move = async (d: Record<string, unknown> = {}) => {
    const p = await engine.prepare({ type: "liveMove", ...draft, ...d });
    if (isRefusal(p)) return p;
    const { nonce: _n, ...rest } = p.action as Extract<OwnerAction, { type: "liveMove" }>;
    return own(rest);
  };
  const ag = async (a: NoNonce<AgentAction>) => svc.exchange(await signAgent(cc, { ...a, nonce: START + ++n } as AgentAction));
  return { svc, engine, bridge, wallet: w, own, ag, move, draft, home, tick: (ms: number) => (real += ms) };
}

const refusal = (o: unknown): Refusal => {
  if (!isRefusal(o)) throw new Error(`expected a refusal, got ${JSON.stringify(o).slice(0, 200)}`);
  return o;
};
const handed = (o: Outcome) => {
  if (isRefusal(o) || o.kind !== "result") throw new Error(`expected the wallet's transactions, got ${isRefusal(o) ? `${o.code}: ${o.message}` : o.kind}`);
  return o.result as { payment: { id: string; status: string; live: Record<string, unknown>; receiveUsd: number }; wallet: Record<string, unknown>; walletTxs: Array<Record<string, unknown>> };
};

describe("real money across chains, from a wallet of yours", () => {
  it("the cheapest route is the one signed for: the address it lands at, the most it may charge, ten minutes; the wallet gets the transfer to send", async () => {
    const x = await boot();
    const p = await x.engine.prepare({ type: "liveMove", ...x.draft });
    if (isRefusal(p)) throw new Error(p.message);
    const a = p.action as Extract<OwnerAction, { type: "liveMove" }>;
    expect([a.kind, a.toAddress, a.network, a.toLedger, a.maxFee, p.accountChain]).toEqual(["bridge", x.wallet.address, "Arbitrum", "Base", "0.05", "Live · real money"]);
    expect(x.bridge.asked[0]).toEqual({ to: x.wallet.address, fromChain: "Arbitrum", toChain: "Base", asset: "USDC", toAsset: "USDC", amount: 25 });
    // the routes as the owner sees them: the one signed for first
    expect(((await x.engine.live.bridgeRoutes(x.draft)) as Array<{ tool: string; picked: boolean }>).map((r) => [r.tool, r.picked])).toEqual([["CCTP", true], ["Across", false]]);
    const out = handed(await x.move());
    expect([out.payment.status, out.payment.live.kind, out.payment.live.tool, out.payment.live.toNetwork, out.walletTxs.map((t) => t.data)]).toEqual(["authorized", "bridge", "CCTP", "Base", ["0xcccc"]]);
    expect(out.payment.receiveUsd).toBe(24.95);
  });

  it("the hash the wallet reports is held to the transfer that was built, and the money is in no balance until the bridge says it arrived", async () => {
    const x = await boot();
    const out = handed(await x.move());
    const hash = `0x${"ab".repeat(32)}`;
    x.bridge.confirmAnswer = no("E_VENUE_REJECTED", { message: "transaction 0xabab… is not this transfer" });
    expect(refusal(await x.engine.live.sent(out.payment.id, hash)).code).toBe("E_VENUE_REJECTED");
    expect(x.engine.payments[0]!.status).toBe("authorized");
    x.bridge.confirmAnswer = "ok";
    x.bridge.statusAnswer = { status: "pending", note: "on its way", native: {} };
    const sent = await x.engine.live.sent(out.payment.id, hash);
    expect(!isRefusal(sent) && sent.kind === "payment" && sent.payment.status).toBe("pending");
    x.bridge.statusAnswer = { status: "settled", received: 24.95, note: "delivered: 24.95 USDC on Base", native: {} };
    x.tick(21_000);
    await x.engine.settle();
    const p = x.engine.payments[0]!;
    expect([p.status, p.receiveUsd, p.note]).toEqual(["settled", 24.95, "delivered: 24.95 USDC on Base"]);
    // the statement has it, as a bridge from the wallet
    expect(x.svc.statement().map((l) => [l.kind, l.status])).toEqual([["bridge", "settled"]]);
  });

  it("to an exchange of yours: the exchange's own deposit address on the chain it lands on, and nowhere it takes no deposits", async () => {
    const x = await boot();
    const p = await x.engine.prepare({ type: "liveMove", ...x.draft, to: "ex" });
    if (isRefusal(p)) throw new Error(p.message);
    expect((p.action as Extract<OwnerAction, { type: "liveMove" }>).toAddress).toBe(DEPOSIT);
    expect(refusal(await x.engine.prepare({ type: "liveMove", ...x.draft, to: "ex", toLedger: "BNB Chain" })).code).toBe("E_VENUE_RAIL_CLOSED");
  });

  it("refused: the same chain, a wallet only watched, a fee that grew past what was signed", async () => {
    const x = await boot();
    expect(refusal(await x.engine.prepare({ type: "liveMove", ...x.draft, toLedger: "Arbitrum" })).code).toBe("E_ACCOUNT_BAD_ACTION");
    const p = await x.engine.prepare({ type: "liveMove", ...x.draft });
    if (isRefusal(p)) throw new Error(p.message);
    // a minute later the routes are asked again (they are kept a minute), and the bridge charges more
    x.bridge.feeUp = 1;
    x.tick(61_000);
    const { nonce: _n, ...rest } = p.action as Extract<OwnerAction, { type: "liveMove" }>;
    expect(refusal(await x.own(rest)).code).toBe("E_ACCOUNT_REQUOTE");
    const watched = await boot({ proven: false });
    expect(refusal(await watched.engine.prepare({ type: "liveMove", ...watched.draft })).code).toBe("E_VENUE_RAIL_CLOSED");
  });
});

describe("across chains: what the review found", () => {
  const agentAsk = { type: "agentLiveMove" as const, kind: "bridge", from: "wallet", fromLedger: "", to: "wallet", toLedger: "Base", asset: "USDC", toAsset: "USDC", network: "Arbitrum", amount: "25", maxFee: "0" };
  const letIn = async (x: Awaited<ReturnType<typeof boot>>) => {
    await x.own({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: START + 30 * 86_400_000 });
    await x.own({ type: "approveSpend", agent: cc.address, scope: "venues", allow: "wallet", perPayment: "100", budget: "200", windowHours: 0, validUntil: START + 7 * 86_400_000 });
  };

  it("an agent's bridge card is held to the fee and the route it showed: a route that got dearer, or another route, is not sent", async () => {
    const x = await boot();
    await letIn(x);
    const r = await x.ag(agentAsk);
    if (isRefusal(r) || r.kind !== "card") throw new Error(`expected a card, got ${JSON.stringify(r).slice(0, 200)}`);
    expect([r.card.offer?.fee, r.card.offer?.protocol]).toEqual(["0.05 USDC", "real money · CCTP, routed by LI.FI, sent by your wallet"]);
    x.bridge.feeUp = 2.5;
    x.tick(61_000);
    expect(refusal(await x.own({ type: "approveCard", card: r.card.id, action: cardHash(r.card), decision: "approve" })).code).toBe("E_ACCOUNT_REQUOTE");
    x.bridge.feeUp = 0;
    const r2 = await x.ag({ ...agentAsk, amount: "20" });
    if (isRefusal(r2) || r2.kind !== "card") throw new Error("expected a card");
    // Across is now the cheaper way: not the way the card showed
    const routes = x.bridge.routes.bind(x.bridge);
    x.bridge.routes = async (q) => {
      const all = await routes(q);
      return isRefusal(all) ? all : all.map((rt) => (rt.tool === "Across" ? { ...rt, receiveUsd: rt.receiveUsd + 0.2 } : rt));
    };
    x.tick(61_000);
    expect(refusal(await x.own({ type: "approveCard", card: r2.card.id, action: cardHash(r2.card), decision: "approve" })).code).toBe("E_ACCOUNT_REQUOTE");
  });

  it("a hash the chain does not show yet is kept, not followed; a second, different hash for the same transfer is not taken", async () => {
    const x = await boot();
    const out = handed(await x.move());
    x.bridge.confirmAnswer = "pending";
    const h1 = `0x${"ab".repeat(32)}`;
    expect(refusal(await x.engine.live.sent(out.payment.id, h1)).code).toBe("E_VENUE_UNREACHABLE");
    expect([x.engine.payments[0]!.status, x.engine.payments[0]!.live?.reported]).toEqual(["authorized", h1]);
    expect(refusal(await x.engine.live.sent(out.payment.id, `0x${"cd".repeat(32)}`)).code).toBe("E_ACCOUNT_BAD_ACTION");
    x.bridge.confirmAnswer = "ok";
    x.bridge.statusAnswer = { status: "pending", note: "on its way", native: {} };
    const again = await x.engine.live.sent(out.payment.id, h1);
    expect(!isRefusal(again) && again.kind === "payment" && again.payment.status).toBe("pending");
  });

  it("a transfer handed to the wallet is to be sent within ten minutes; sent later after all, it is followed", async () => {
    const x = await boot();
    const out = handed(await x.move());
    x.tick(11 * 60_000);
    await x.engine.settle();
    expect([x.engine.payments[0]!.status, (x.engine.payments[0]!.note ?? "").startsWith("not sent in time")]).toEqual(["failed", true]);
    x.bridge.statusAnswer = { status: "pending", note: "on its way", native: {} };
    const late = await x.engine.live.sent(out.payment.id, `0x${"ef".repeat(32)}`);
    expect(!isRefusal(late) && late.kind === "payment" && late.payment.status).toBe("pending");
  });

  it("a bridge on its way when the account stopped is followed by the next run, to the end", async () => {
    const x = await boot();
    const out = handed(await x.move());
    x.bridge.statusAnswer = { status: "pending", note: "on its way", native: {} };
    await x.engine.live.sent(out.payment.id, `0x${"ab".repeat(32)}`);
    expect(x.svc.statement()[0]!.status).toBe("pending");
    const next = await boot({ home: x.home, nonceFrom: 100, laterMs: 3_600_000 });
    // the wallet is connected again from the same address and its proof, checked again; the bridge is followed under its own id
    expect(next.svc.restored).toMatchObject({ runs: 1, venues: [{ venue: "wallet", ok: true }, { venue: "ex", ok: true }], payments: 1, state: "done" });
    expect(next.svc.statement().map((l) => [l.kind, l.status])).toEqual([["bridge", "pending"]]);
    expect(next.engine.payments.map((p) => [p.id, p.status, p.live?.txHash])).toEqual([[out.payment.id, "pending", `0x${"ab".repeat(32)}`]]);
    next.bridge.statusAnswer = { status: "settled", received: 24.9, note: "landed on Base: 24.9 arrived", native: {} };
    next.tick(60_000);
    await next.engine.settle();
    expect(next.svc.statement().map((l) => [l.kind, l.status])).toEqual([["bridge", "settled"]]);
    // a new movement in the new run does not take the old one's id
    expect(next.engine.nextPaymentId()).toBe("pay-0002");
  });

  it("--fresh: a line an earlier run left on its way says this run does not follow it", async () => {
    const x = await boot();
    const out = handed(await x.move());
    x.bridge.statusAnswer = { status: "pending", note: "on its way", native: {} };
    await x.engine.live.sent(out.payment.id, `0x${"ab".repeat(32)}`);
    const next = await boot({ home: x.home, nonceFrom: 100, laterMs: 3_600_000, fresh: true });
    expect(next.svc.restored).toBeUndefined();
    expect(next.svc.statement().map((l) => [l.kind, l.status])).toEqual([["bridge", "not followed since a restart"]]);
  });
});


describe("a bridge goes by the bridge's own chains", () => {
  it("out of Robinhood Chain in USDG: the door asks the bridge for routes from there (it is not a network money is sent or withdrawn on)", async () => {
    const x = await boot();
    x.bridge.chains.push("Robinhood Chain");
    const p = await x.engine.prepare({ type: "liveMove", ...x.draft, network: "Robinhood Chain", asset: "USDG", toAsset: "USDC", toLedger: "Arbitrum" });
    if (isRefusal(p)) throw new Error(p.message);
    expect(x.bridge.asked.at(-1)).toEqual({ to: x.wallet.address, fromChain: "Robinhood Chain", toChain: "Arbitrum", asset: "USDG", toAsset: "USDC", amount: 25 });
    // a chain the bridge does not carry is refused before anything is asked
    const asked = x.bridge.asked.length;
    x.bridge.chains.pop();
    expect(refusal(await x.engine.prepare({ type: "liveMove", ...x.draft, network: "Robinhood Chain", asset: "USDG", toAsset: "USDC", toLedger: "Arbitrum" })).message).toMatch(/^a bridge leaves one of /);
    expect(x.bridge.asked.length).toBe(asked);
  });
});
