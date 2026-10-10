import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, keccak256, multicall3Abi, parseAbiItem, type Hex } from "viem";
import { afterAll, describe, expect, it, vi } from "vitest";
import { isRefusal, type Refusal } from "../../src/core/errors.ts";
import { cardHash, type Outcome } from "../../src/portfolio/account/exchange.ts";
import { signAgent, signOwner, simKey, type AgentAction, type OwnerAction } from "../../src/portfolio/account/sign.ts";
import { agentWalletSource } from "../../src/portfolio/live/agent-wallet.ts";
import { bridgeRoutes, bridgeStatus } from "../../src/portfolio/live/bridge.ts";
import { publicChain, publicSender, type ChainName, type ChainReader, type ChainSender, type Mined, type Sent } from "../../src/portfolio/live/chain.ts";
import { dexTrader, issuedHoldings, LIFI_DIAMOND } from "../../src/portfolio/live/dex.ts";
import type { ExchangeClient, OpenExchange } from "../../src/portfolio/live/exchange.ts";
import { guardedHttp, privateAddress, type PayRequest, type PayResponse } from "../../src/portfolio/live/guarded-http.ts";
import { register, type LiveDeps } from "../../src/portfolio/live/index.ts";
import { publicPrices } from "../../src/portfolio/live/prices.ts";
import { holdBackMs } from "../../src/portfolio/live/public-markets.ts";
import type { LiveTrader, Market, OrderState } from "../../src/portfolio/live/trade.ts";
import type { Http, HttpReply } from "../../src/portfolio/live/types.ts";
import type { LiveWriter } from "../../src/portfolio/live/writes.ts";
import { PortfolioService } from "../../src/portfolio/service.ts";
import { binance451, json, MIN, network, NOW, refusing } from "./live-public-markets-fixtures.ts";

/** The IP audit's findings in the chains, the agent wallet, the wallet's swaps and bridges, the payee guard, agent payments and the public
 * prices: what this machine's network does to them — an RPC refusing or rate-limiting this address, a broadcast whose answer is lost, LI.FI's
 * edge or ban, an issuer's place rule, a DNS64 network, a filter's sinkhole, a geo-redirect, an outage at login. Against stand-ins only:
 * nothing leaves the process (the payee guard's DNS is scripted), and the only addresses are documentation ones. */

// the payee guard's lookup, scripted: nothing is resolved or connected for real
const dns = vi.hoisted(() => ({ answer: undefined as undefined | ((host: string) => { err?: Error | undefined; addrs?: Array<{ address: string; family: number }> | undefined } | undefined) }));
vi.mock("node:dns", async (orig) => {
  const real = await orig<typeof import("node:dns")>();
  return {
    ...real,
    lookup: (host: string, opts: unknown, cb: (err: Error | null, addrs?: unknown) => void) => {
      const a = dns.answer?.(host);
      if (!a) return (real.lookup as unknown as (h: string, o: unknown, c: unknown) => void)(host, opts, cb);
      setImmediate(() => (a.err ? cb(a.err) : cb(null, a.addrs)));
    },
  };
});

const BASE_USDC: Hex = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BASE_USDT: Hex = "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2";
const ETH_USDC: Hex = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WETH: Hex = "0x4200000000000000000000000000000000000006";
const USDG: Hex = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const RH_NVDA: Hex = "0x00000000000000000000000000000000000a0001";
const IMPOSTOR_NVDA: Hex = "0x00000000000000000000000000000000000b0002";
const NVDAX: Hex = "0xc845b2894dbddd03858fd2d643b4ef725fe0849d";
const WALLET: Hex = "0x00000000000000000000000000000000000000A1";
const DEST: Hex = "0x00000000000000000000000000000000000000D5";
const HASH: Hex = `0x${"ab".repeat(32)}`;
const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
/** what an address in this network's words would look like: none may survive into a refusal, an order or a note */
const ADDRESSES = /203\.0\.113\.\d+|198\.51\.100\.\d+|2001:db8::\d+|10\.10\.34\.3\d/;

const refusal = (o: unknown): Refusal => {
  if (!isRefusal(o)) throw new Error(`expected a refusal, got ${JSON.stringify(o).slice(0, 200)}`);
  return o;
};
const page = (status: number, title: string, extra = ""): HttpReply => ({ status, body: undefined, text: `<html><head><title>${title}</title></head><body>${title}${extra}</body></html>` });

// ---- the chains (chain.ts) ---------------------------------------------------------------------------------------------------------------

/** a JSON-RPC endpoint answered by method: a result, an error, or a whole HTTP answer; every method asked is recorded */
function rpc(answer: (method: string, params: unknown[]) => { result?: unknown; error?: unknown } | Response | Promise<never>) {
  const asked: string[] = [];
  const raw: Array<{ method: string; params: unknown[] }> = [];
  const fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
    asked.push(body.method);
    raw.push({ method: body.method, params: body.params });
    const a = await answer(body.method, body.params);
    if (a instanceof Response) return a;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...a }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, asked, raw };
}
/** aggregate3's answer: each call's success and its return data */
const aggregate = (results: Array<{ success: boolean; returnData: Hex }>) => encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: results });
const word = (n: bigint | number, type: "uint256" | "uint8" = "uint256") => encodeAbiParameters([{ type }], [type === "uint8" ? Number(n) : BigInt(n)]);
let endpoints = 0;
const env = () => ({ PORTFOLIO_RPC_BASE: `https://rpc-${++endpoints}.example/base` });

describe("R1-18 · a refused or rate-limited RPC is a chain that did not answer, never a wallet that holds nothing", () => {
  const refs = [{ chain: "Base" as ChainName, asset: "USDC", address: BASE_USDC }, { chain: "Base" as ChainName, asset: "USDT", address: BASE_USDT }];

  it("451, a per-IP 429, an edge's 403 page and a refused connection each name the chain as failed, in the endpoint's words — no address in them", async () => {
    const cases: Array<[string, () => Response | Promise<never>, RegExp]> = [
      ["451", () => new Response("Unavailable For Legal Reasons", { status: 451 }), /^Base's endpoint does not serve this location \(HTTP 451\): that is its own rule/],
      ["429", () => new Response("error code: 1015", { status: 429 }), /^Base's endpoint is rate-limiting this machine \(HTTP 429\)/],
      ["edge", () => new Response("<html><head><title>Attention Required!</title></head><body>Your IP 203.0.113.7 has been blocked</body></html>", { status: 403, headers: { "content-type": "text/html" } }), /^Base's endpoint refuses this network: the server in front of it answered HTTP 403 \(“Attention Required!”\)/],
      ["refused", () => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED 203.0.113.7:443"), { code: "ECONNREFUSED" }) })), /^Base's endpoint could not be reached \(ECONNREFUSED\)$/],
    ];
    for (const [name, answer, words] of cases) {
      const node = rpc(() => answer());
      const read = await publicChain(env(), { fetch: node.fetch }).tokens(WALLET, refs);
      expect([name, read.rows, read.failed]).toEqual([name, [], ["Base"]]);
      expect([name, read.said?.Base]).toEqual([name, expect.stringMatching(words)]);
      expect(read.said?.Base).not.toMatch(ADDRESSES);
    }
  });

  it("a token whose own balance call reverted is dropped; the chain answered, so it is not named as failed", async () => {
    const node = rpc((method, params) => {
      if (method !== "eth_call") return { error: { code: -32601, message: "no" } };
      const data = ((params[0] as { data?: Hex; input?: Hex }).data ?? (params[0] as { input?: Hex }).input)!;
      const calls = (decodeFunctionData({ abi: multicall3Abi, data }).args![0] as unknown[]).length;
      expect(calls).toBe(4);
      return { result: aggregate([{ success: true, returnData: word(5_000_000n) }, { success: true, returnData: word(6, "uint8") }, { success: false, returnData: "0x" }, { success: true, returnData: word(6, "uint8") }]) };
    });
    const read = await publicChain(env(), { fetch: node.fetch }).tokens(WALLET, refs);
    expect(read).toEqual({ rows: [{ chain: "Base", asset: "USDC", amount: 5 }], failed: [] });
  });
});

describe("R2-17 · an RPC's Retry-After is a hold, not a sleep inside the read", () => {
  it("a 429 saying an hour fails the read at once, and nothing more is sent to that endpoint until then", async () => {
    let sent = 0;
    const node = rpc(() => {
      sent++;
      return new Response("error code: 1015", { status: 429, headers: { "retry-after": "3600" } });
    });
    const chain = publicChain(env(), { fetch: node.fetch });
    const t0 = Date.now();
    const first = await chain.tokens(WALLET, [{ chain: "Base", asset: "USDC", address: BASE_USDC }]);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(first.failed).toEqual(["Base"]);
    expect(first.said?.Base).toMatch(/^Base's endpoint asked this machine to wait until 20\d\d-\d\d-\d\dT[\d:.]+Z: it is not asked before then$/);
    expect(sent).toBe(1);
    // the hold stands for every read of that endpoint: the balance, the coin, a receipt — none of them sent
    expect((await chain.native(WALLET, ["Base"])).failed).toEqual(["Base"]);
    await expect(chain.receipt("Base", HASH)).rejects.toMatchObject({ code: "E_VENUE_UNREACHABLE", message: expect.stringMatching(/asked this machine to wait until/) });
    expect(sent).toBe(1);
  });
});

describe("R3-11 · a receipt the endpoint could not be asked for is not 'not on chain yet'", () => {
  it("a 451 or an edge page throws the endpoint's refusal; the node answering null is undefined", async () => {
    const refused = publicChain(env(), { fetch: rpc(() => new Response("Unavailable For Legal Reasons", { status: 451 })).fetch });
    await expect(refused.receipt("Base", HASH)).rejects.toMatchObject({ code: "E_VENUE_GEOBLOCKED", message: expect.stringMatching(/^Base's endpoint does not serve this location \(HTTP 451\)/) });
    await expect(refused.transaction!("Base", HASH)).rejects.toMatchObject({ code: "E_VENUE_GEOBLOCKED" });
    const unknown = publicChain(env(), { fetch: rpc(() => ({ result: null })).fetch });
    expect(await unknown.receipt("Base", HASH)).toBeUndefined();
    expect(await unknown.transaction!("Base", HASH)).toBeUndefined();
  });
});

// ---- the agent wallet's send (chain.ts publicSender, agent-wallet.ts) --------------------------------------------------------------------

describe("R2-15 · an agent wallet's send whose answer is lost is followed by its hash, never told as refused", () => {
  const account = simKey("agent-wallet:ip-audit-e").account;
  /** a node: nonces, fees and gas answered; the broadcast answered as `broadcast` says */
  const node = (o: { pending?: number; latest?: number; broadcast: () => { result?: unknown; error?: unknown } | Response | Promise<never> }) =>
    rpc((method, params) => {
      if (method === "eth_getTransactionCount") return { result: `0x${((params[1] === "latest" ? o.latest : o.pending) ?? 7).toString(16)}` };
      if (method === "eth_chainId") return { result: "0x2105" };
      if (method === "eth_estimateGas") return { result: "0xea60" };
      if (method === "eth_maxPriorityFeePerGas") return { result: "0x3b9aca00" };
      if (method === "eth_gasPrice") return { result: "0x3b9aca00" };
      if (method === "eth_getBlockByNumber") return { result: { number: "0x10", hash: HASH, baseFeePerGas: "0x3b9aca00", timestamp: "0x1", transactions: [], gasLimit: "0x1c9c380", gasUsed: "0x0", parentHash: HASH, miner: WALLET, difficulty: "0x0", totalDifficulty: "0x0", extraData: "0x", size: "0x1", nonce: "0x0000000000000000", logsBloom: `0x${"0".repeat(512)}`, sha3Uncles: HASH, stateRoot: HASH, receiptsRoot: HASH, transactionsRoot: HASH, uncles: [], mixHash: HASH } };
      if (method === "eth_sendRawTransaction") return o.broadcast();
      return { error: { code: -32601, message: `the stand-in does not answer ${method}` } };
    });
  const send = (n: ReturnType<typeof node>): Promise<Sent> => publicSender(env(), { fetch: n.fetch }).transfer({ chain: "Base", account, token: BASE_USDC, to: DEST, units: 5_000_000n });
  const rawHash = (n: ReturnType<typeof node>) => keccak256((n.raw.find((r) => r.method === "eth_sendRawTransaction")!.params[0] as Hex));

  it("a gateway's 524 after the broadcast went out: the hash worked out before sending, marked as an answer lost", async () => {
    const n = node({ broadcast: () => new Response("<html><title>A timeout occurred</title>error code: 524</html>", { status: 524 }) });
    const out = await send(n);
    expect(out).toEqual({ hash: rawHash(n), nonce: 7, answerLost: true, said: "Base's endpoint did not answer (HTTP 524)" });
  });

  it("the node's own no is a no; 'already known' is the node having it; a refused connection is nothing sent", async () => {
    expect(await send(node({ broadcast: () => ({ error: { code: -32000, message: "nonce too low: next nonce 8, tx nonce 7" } }) }))).toEqual({ error: "nonce too low: next nonce 8, tx nonce 7" });
    const known = node({ broadcast: () => ({ error: { code: -32000, message: "already known" } }) });
    expect(await send(known)).toEqual({ hash: rawHash(known), nonce: 7 });
    const down = node({ broadcast: () => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED 203.0.113.7:443"), { code: "ECONNREFUSED" }) })) });
    expect(await send(down)).toEqual({ error: "Base's endpoint could not be reached (ECONNREFUSED)", unanswered: true });
  });

  it("an earlier send still waiting to be mined: nothing new is signed, nothing broadcast", async () => {
    const n = node({ pending: 8, latest: 7, broadcast: () => ({ result: HASH }) });
    expect(await send(n)).toEqual({ error: "an earlier transfer from this wallet is still waiting to be mined on Base: nothing new is signed until it is", inFlight: true });
    expect(n.asked).not.toContain("eth_sendRawTransaction");
  });

  /** the agent wallet over a stand-in chain and sender */
  async function agentWallet(answer: Sent) {
    const s = { receipt: (async () => undefined) as ChainReader["receipt"], mined: 7 as number | undefined };
    const chain: ChainReader = {
      tokens: async (_h, refs) => ({ rows: refs.map((r) => ({ chain: r.chain, asset: r.asset, amount: 10 })), failed: [] }),
      native: async (_h, chains) => ({ rows: chains.map((c) => ({ chain: c, asset: "ETH", amount: 0.01 })), failed: [] }),
      uint: async () => undefined,
      decimals: async () => 6,
      receipt: (c, h) => s.receipt(c, h),
      nonce: async () => s.mined,
    };
    const sender: ChainSender = { transfer: async () => answer };
    const opened = await agentWalletSource({ venue: "agent-e", label: "Agent wallet · e", key: simKey("agent-wallet:ip-audit-e"), chain, sender });
    if (isRefusal(opened)) throw new Error(opened.message);
    return { s, w: opened.source.writer!, address: opened.source.address as Hex };
  }
  const expected = { asset: "USDC", amount: 5, to: DEST, network: "Base" as ChainName };

  it("the agent wallet makes it a pending payment, followed by its hash and failed only once the chain mined another at its nonce", async () => {
    const { s, w, address } = await agentWallet({ hash: HASH, nonce: 7, answerLost: true, said: "Base's endpoint did not answer (HTTP 524)" });
    const r = await w.send!({ asset: "USDC", amount: 5, to: DEST, network: "Base" });
    expect(r).toMatchObject({ ref: HASH, status: "pending", native: { hash: HASH, nonce: 7, answerLost: true, unsure: true, said: expect.stringMatching(/^the transfer was signed and sent as 0xabababab…, and Base's endpoint did not answer \(HTTP 524\): it is followed by its hash, not sent again$/) } });
    // the endpoint not answering the receipt, or the chain not showing it with the nonce still at 7: still on its way
    s.receipt = async () => {
      throw refusal({ ok: false, code: "E_VENUE_UNREACHABLE", layer: "venue", message: "Base's endpoint did not answer" });
    };
    expect(await w.confirm!(HASH, expected)).toBe("pending");
    s.receipt = async () => undefined;
    expect(await w.confirm!(HASH, expected)).toBe("pending");
    // mined after all: settled, on the chain's word
    const mined: Mined = { status: "success", from: address, to: BASE_USDC, logs: [{ address: BASE_USDC, topics: encodeEventTopics({ abi: [TRANSFER], eventName: "Transfer", args: { from: address, to: DEST } }) as Hex[], data: word(5_000_000n) }] };
    s.receipt = async () => mined;
    expect(await w.confirm!(HASH, expected)).toBe("settled");
  });

  it("…and failed once another transaction of the wallet's took nonce 7 while the chain never showed this one", async () => {
    const { s, w } = await agentWallet({ hash: HASH, nonce: 7, answerLost: true });
    await w.send!({ asset: "USDC", amount: 5, to: DEST, network: "Base" });
    s.mined = 8;
    const no = refusal(await w.confirm!(HASH, expected));
    expect([no.code, no.message]).toEqual(["E_VENUE_REJECTED", "Base never mined 0xabababab…: another transaction from Agent wallet · e took its place (nonce 7), so this transfer did not happen"]);
  });

  it("a chain that does not answer this time keeps the agent wallet's last rows there, said as not read, and unread() says which", async () => {
    let base = true;
    const chain: ChainReader = {
      tokens: async (_h, refs) => (base ? { rows: refs.map((r) => ({ chain: r.chain, asset: r.asset, amount: r.chain === "Base" && r.asset === "USDC" ? 10 : 0 })), failed: [] } : { rows: refs.filter((r) => r.chain !== "Base").map((r) => ({ chain: r.chain, asset: r.asset, amount: 0 })), failed: ["Base"], said: { Base: "Base's endpoint is rate-limiting this machine (HTTP 429): it is asked again shortly" } }),
      native: async (_h, chains) => ({ rows: chains.map((c) => ({ chain: c, asset: "ETH", amount: 0 })), failed: [] }),
      uint: async () => undefined,
      decimals: async () => 6,
      receipt: async () => undefined,
    };
    const opened = await agentWalletSource({ venue: "agent-e", label: "Agent wallet · e", key: simKey("agent-wallet:ip-audit-e"), chain, sender: { transfer: async () => ({ hash: HASH }) } });
    if (isRefusal(opened)) throw new Error(opened.message);
    expect([opened.first, opened.source.unread?.()]).toEqual([[{ asset: "USDC", amount: 10, where: "Base" }], undefined]);
    base = false;
    expect(await opened.source.read()).toEqual([{ asset: "USDC", amount: 10, where: "Base · not read this time: Base's endpoint is rate-limiting this machine (HTTP 429): it is asked again shortly" }]);
    expect(opened.source.unread?.()).toBe("not read this time (kept from the last read): Base's endpoint is rate-limiting this machine (HTTP 429): it is asked again shortly");
  });

  it("nothing sent is 'did not answer', not 'did not take the transfer'; the node's no is still a rejection", async () => {
    const unanswered = await agentWallet({ error: "Base's endpoint could not be reached (ECONNREFUSED)", unanswered: true });
    const a = refusal(await unanswered.w.send!({ asset: "USDC", amount: 5, to: DEST, network: "Base" }));
    expect([a.code, a.message]).toEqual(["E_VENUE_UNREACHABLE", "nothing was sent: Base's endpoint could not be reached (ECONNREFUSED)"]);
    const said = await agentWallet({ error: "insufficient funds for gas * price + value" });
    expect(refusal(await said.w.send!({ asset: "USDC", amount: 5, to: DEST, network: "Base" })).code).toBe("E_VENUE_REJECTED");
  });
});

// ---- the account, with an agent wallet and a payee network (live-moves, pay-real) ------------------------------------------------------

const START = Date.parse("2026-10-05T14:00:00.000Z");
const DAY = 86_400_000;
const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));
const owner = simKey("owner");
const cc = simKey("agent:claude-code");
const PAYEE: Hex = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const DEPOSIT: Hex = "0x00000000000000000000000000000000000d3905";
type NoNonce<T> = T extends unknown ? Omit<T, "nonce"> : never;

register({ kind: "standin-deposits-e", label: "an exchange that takes deposits", needs: "key-file", example: "", venues: [], async open(req) {
  const writer: LiveWriter = { can: { withdraw: false, ledgers: [], transfer: false, swap: false, receive: true, send: false }, async depositAddress() { return { address: DEPOSIT }; } };
  return { source: { name: req.label || "Exchange", kind: "cex", reference: "standin", via: "a stand-in", probe: { can: [], note: "" }, read: async () => [], writer }, first: [], summary: "connected" };
} });

async function boot(o: { send?: () => Sent; tokens?: ChainReader["tokens"] } = {}) {
  const home = mkdtempSync(join(tmpdir(), "ip-audit-e-"));
  homes.push(home);
  let n = 0;
  let real = START;
  const c = { usdc: 10, gas: 0.01, mined: new Map<string, Mined>() };
  const reader: ChainReader = {
    tokens: o.tokens ?? (async (_h, refs) => ({ rows: refs.map((r) => ({ chain: r.chain, asset: r.asset, amount: r.asset === "USDC" && r.chain === "Base" ? c.usdc : 0 })), failed: [] })),
    native: async (_h, chains) => ({ rows: chains.map((ch) => ({ chain: ch, asset: "ETH", amount: ch === "Base" ? c.gas : 0 })), failed: [] }),
    uint: async () => undefined,
    decimals: async () => 6,
    receipt: async (_c, h) => c.mined.get(h),
    authorizationUsed: async () => false,
    nonce: async () => 7,
  };
  const sender: ChainSender = { transfer: async () => o.send?.() ?? { hash: HASH } };
  const asked: PayRequest[] = [];
  const payHttp = async (req: PayRequest): Promise<PayResponse> => {
    asked.push(req);
    const u = new URL(req.url);
    const v1 = { scheme: "exact", network: "base", maxAmountRequired: "10000", asset: BASE_USDC, payTo: PAYEE, resource: req.url, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } };
    switch (u.host) {
      case "geo.example.com":
        return { status: 451, headers: {}, body: "Unavailable For Legal Reasons" };
      case "words.example.com":
        return { status: 403, headers: {}, body: { error: "This service is not available in your country" } };
      case "edge.example.com":
        return { status: 403, headers: { "content-type": "text/html" }, body: "<html><head><title>Access Denied</title></head><body>Reference 203.0.113.7</body></html>" };
      case "redir.example.com":
        return { status: 302, headers: { location: "https://redir.example.com/unavailable?country=US&region=NY&ip=203.0.113.9" }, body: "" };
      case "away.example.com":
        return { status: 302, headers: { location: "https://blocked.example.net/?country=US&region=NY" }, body: "" };
      case "busy.example.com":
        return { status: 429, headers: {}, body: {} };
      case "down.example.com":
        return { status: 503, headers: {}, body: "Service Unavailable" };
      case "sink.example.com":
        return { status: 0, headers: {}, body: undefined, kind: "filtered-address", error: "on this network the name resolves to a local or reserved address, so the payee was not asked" };
      case "cert.example.com":
        return { status: 0, headers: {}, body: undefined, kind: "certificate", error: "the certificate that answered is not the payee's: something on this network may be answering in its place" };
      case "pay.example.com":
        return { status: 402, headers: {}, body: { x402Version: 1, error: "payment required", accepts: [v1] } };
      default:
        return { status: 404, headers: {}, body: {} };
    }
  };
  const liveDeps: Partial<LiveDeps> = { clock: () => real, chain: reader, sender, http: async () => ({ status: 599, body: undefined, text: "" }), price: async () => undefined };
  const svc = await PortfolioService.create({ home, now: () => new Date(START).toISOString(), venues: "frontline", real: true, liveDeps, payHttp, liveWrites: { capUsd: 100, pairingCode: "K7QX-M2PA" }, account: { owners: [{ id: owner.address, kind: "eoa", label: "owner", addedAt: new Date(START).toISOString() }] } });
  await svc.restoring;
  const engine = svc.account!;
  const nonce = () => START + ++n;
  const own = async (a: NoNonce<OwnerAction>) => svc.exchange(await signOwner(owner, { ...a, nonce: nonce() } as OwnerAction));
  const ag = async (a: NoNonce<AgentAction>) => svc.exchange(await signAgent(cc, { ...a, nonce: nonce() } as AgentAction));
  const ok = async (p: Promise<Outcome>) => {
    const r = await p;
    if (isRefusal(r)) throw new Error(`${r.code}: ${r.message}`);
    return r;
  };
  await ok(own({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: START + 30 * DAY }));
  await ok(own({ type: "createSubAccount", name: "research", agent: cc.address, float: "20" }));
  await ok(own({ type: "approveSpend", agent: cc.address, scope: "payees", allow: "*", perPayment: "1", budget: "5", windowHours: 0, validUntil: START + 7 * DAY }));
  await ok(own({ type: "setPolicy", change: "mode", value: "open" }));
  const pay = (url: string) => ag({ type: "agentPay", url, maxAmount: "0.05", fromSubAccount: "research" });
  return { svc, engine, c, own, ok, pay, asked, tick: (ms: number) => (real += ms), approve: async (id: string) => own({ type: "approveCard", card: id, action: cardHash(engine.host.card(id)!), decision: "approve" }) };
}

describe("R2-15 · through the account: a send whose answer was lost is a pending payment, charged, followed and not sent again", () => {
  it("is recorded pending with its hash, says it may have gone, and settles when the chain shows it", async () => {
    const x = await boot({ send: () => ({ hash: HASH, nonce: 7, answerLost: true, said: "Base's endpoint did not answer (HTTP 524)" }) });
    await x.ok(x.own({ type: "connectVenue", venue: "ex", connector: "live:standin-deposits-e", label: "Exchange", credentialRef: "" }));
    const p = await x.engine.prepare({ type: "liveMove", kind: "send", from: "agent-research", to: "ex", asset: "USDC", toAsset: "USDC", network: "Base", amount: "4" });
    if (isRefusal(p)) throw new Error(p.message);
    const { nonce: _n, ...action } = p.action as Extract<OwnerAction, { type: "liveMove" }>;
    const out = await x.ok(x.own(action));
    expect(out.kind === "payment" && [out.payment.status, out.payment.live?.txHash, out.payment.note]).toEqual(["pending", HASH, expect.stringMatching(/did not answer whether it took it: it may have, so it is followed here and not sent again/)]);
    // the chain shows it: settled, followed by the hash it was sent as
    const wallet = x.engine.state.subAccounts[0]!.address as Hex;
    x.c.mined.set(HASH, { status: "success", from: wallet, to: BASE_USDC, logs: [{ address: BASE_USDC, topics: encodeEventTopics({ abi: [TRANSFER], eventName: "Transfer", args: { from: wallet, to: DEPOSIT } }) as Hex[], data: word(4_000_000n) }] });
    x.tick(30_000);
    await x.engine.settle();
    expect(x.engine.payments[0]!.status).toBe("settled");
  });
});

describe("R2-29 · a payee refusing this network by place is said as that, and a redirect is told by its host only", () => {
  it("451, the payee's place words and an edge page are its rule; 429 and 5xx are the payee busy or down; nothing of a place or an address is copied", async () => {
    const x = await boot();
    const cases: Array<[string, string, RegExp]> = [
      ["https://geo.example.com/q", "E_VENUE_GEOBLOCKED", /^geo\.example\.com does not serve this location: that is its own rule; nothing was paid, and the account does not look for a way around it$/],
      ["https://words.example.com/q", "E_VENUE_GEOBLOCKED", /^words\.example\.com does not serve this location/],
      ["https://edge.example.com/q", "E_VENUE_GEOBLOCKED", /^edge\.example\.com refuses this network: the server in front of it answered HTTP 403 \(“Access Denied”\).*\. Nothing was paid$/],
      ["https://busy.example.com/q", "E_PAYEE_REJECTED", /^busy\.example\.com is busy \(HTTP 429\): nothing was paid; try again later$/],
      ["https://down.example.com/q", "E_PAYEE_REJECTED", /^down\.example\.com did not answer \(HTTP 503\): nothing was paid$/],
      ["https://redir.example.com/q", "E_PAYEE_REDIRECT", /^redir\.example\.com sent the request on to another page of its own: a payment does not follow a redirect$/],
      ["https://away.example.com/q", "E_PAYEE_REDIRECT", /^away\.example\.com sent the request on to blocked\.example\.net: a payment does not follow a redirect$/],
    ];
    for (const [url, code, words] of cases) {
      const no = refusal(await x.pay(url));
      expect([url, no.code, no.message]).toEqual([url, code, expect.stringMatching(words)]);
      expect(JSON.stringify(no)).not.toMatch(/country=|region=|NY\b|ip=/);
      expect(JSON.stringify(no)).not.toMatch(ADDRESSES);
    }
    expect(refusal(await x.pay("https://away.example.com/q")).detail).toEqual({ redirectHost: "blocked.example.net" });
  });
});

describe("R4-19 · a request this network kept from the payee is told as that, in a fixed sentence", () => {
  it("a sinkhole's answer or an interceptor's certificate: 'this network did not let the request reach', no address, no certificate names", async () => {
    const x = await boot();
    const sink = refusal(await x.pay("https://sink.example.com/q"));
    expect([sink.code, sink.message]).toEqual(["E_PAYEE_REJECTED", "this network did not let the request reach sink.example.com (on this network the name resolves to a local or reserved address, so the payee was not asked): nothing was paid"]);
    const cert = refusal(await x.pay("https://cert.example.com/q"));
    expect(cert.message).toBe("this network did not let the request reach cert.example.com (the certificate that answered is not the payee's: something on this network may be answering in its place): nothing was paid");
  });

  it("the guard itself: a filter's sinkhole address, a certificate's altnames and a refused socket's address never reach its words", async () => {
    dns.answer = (host) =>
      host === "sink.payee.example"
        ? { addrs: [{ address: "10.10.34.36", family: 4 }] }
        : host === "cert.payee.example"
          ? { err: Object.assign(new Error("Hostname/IP does not match certificate's altnames: Host: cert.payee.example. is not in the cert's altnames: DNS:login.hotel-wifi.example"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" }) }
          : host === "gone.payee.example"
            ? { err: Object.assign(new Error("connect ECONNREFUSED 203.0.113.7:443"), { code: "ECONNREFUSED" }) }
            : undefined;
    try {
      const sink = await guardedHttp({ method: "GET", url: "https://sink.payee.example/q" });
      expect(sink).toMatchObject({ status: 0, kind: "filtered-address", error: "on this network the name resolves to a local or reserved address, so the payee was not asked" });
      const cert = await guardedHttp({ method: "GET", url: "https://cert.payee.example/q" });
      expect(cert).toMatchObject({ status: 0, kind: "certificate", error: "the certificate that answered is not the payee's: something on this network may be answering in its place" });
      const gone = await guardedHttp({ method: "GET", url: "https://gone.payee.example/q" });
      expect(gone).toMatchObject({ status: 0, kind: "refused", error: "the connection was refused or cut" });
      for (const r of [sink, cert, gone]) expect(JSON.stringify(r)).not.toMatch(/10\.10\.34\.36|altnames|hotel-wifi|203\.0\.113/);
    } finally {
      dns.answer = undefined;
    }
  });
});

describe("R2-18 · NAT64: an IPv4-only payee on an IPv6-only network is judged by the address it carries", () => {
  it("64:ff9b::/96 and the local-use 64:ff9b:1::/48 carrying a public address are public; carrying this machine, the local network or link-local they are not", () => {
    for (const a of ["64:ff9b::cb00:7105", "64:ff9b::203.0.113.5", "64:ff9b::c633:6409", "64:ff9b:1::cb00:7105"]) expect([a, privateAddress(a)]).toEqual([a, false]);
    for (const a of ["64:ff9b::7f00:1", "64:ff9b::a00:1", "64:ff9b::a9fe:a9fe", "64:ff9b::c0a8:101", "64:ff9b:1:1::cb00:7105", "64:ff9b:1::7f00:1"]) expect([a, privateAddress(a)]).toEqual([a, true]);
  });
});

describe("R1-18 · an agent payment's balance check: a chain that did not answer is not $0.00", () => {
  it("a rate-limited or row-less read refuses as 'did not answer', in the endpoint's words, and signs nothing", async () => {
    const limited = await boot({ tokens: async () => ({ rows: [], failed: ["Base"], said: { Base: "Base's endpoint is rate-limiting this machine (HTTP 429): it is asked again shortly" } }) });
    const a = refusal(await limited.pay("https://pay.example.com/q"));
    expect([a.code, a.message]).toEqual(["E_VENUE_UNREACHABLE", "Base did not answer (Base's endpoint is rate-limiting this machine (HTTP 429): it is asked again shortly): the agent wallet's balance there is not known, so nothing is signed"]);
    const rowless = await boot({ tokens: async () => ({ rows: [], failed: [] }) });
    expect(refusal(await rowless.pay("https://pay.example.com/q")).code).toBe("E_VENUE_UNREACHABLE");
  });
});

// ---- the wallet's swaps through LI.FI, its tokenised shares and its bridges (dex.ts, bridge.ts) -----------------------------------------

const tok = (address: Hex, symbol: string, decimals: number, priceUSD: number) => ({ address, symbol, name: symbol, decimals, priceUSD: String(priceUSD), verificationStatus: "verified" });
const TOKENS = { tokens: { "8453": [tok(BASE_USDC, "USDC", 6, 1), tok(WETH, "WETH", 18, 2500)], "1": [tok(ETH_USDC, "USDC", 6, 1)], "4663": [tok(USDG, "USDG", 6, 1), tok(IMPOSTOR_NVDA, "NVDA", 18, 180)] } };
const RH_LIST = { assets: [{ status: "ASSET_STATUS_ACTIVE", tokenSymbol: "NVDA", tokenName: "NVIDIA", tokenDecimals: 18, deployments: [{ chainId: 4663, contractAddress: RH_NVDA }] }] };

/** a wallet's chain: what it holds, the chains that do not answer (and why), a receipt and a transaction as scripted */
function chainOf(o: { held?: Record<string, number>; failed?: ChainName[]; rowless?: boolean; receipt?: ChainReader["receipt"]; transaction?: ChainReader["transaction"] } = {}): ChainReader {
  return {
    async tokens(_h, refs) {
      const failed = [...new Set(refs.map((r) => r.chain))].filter((c) => o.failed?.includes(c));
      return { rows: o.rowless ? [] : refs.filter((r) => !failed.includes(r.chain)).map((r) => ({ chain: r.chain, asset: r.asset, amount: o.held?.[`${r.chain}:${r.asset}`] ?? 0 })), failed, ...(failed.length ? { said: Object.fromEntries(failed.map((c) => [c, `${c}'s endpoint is rate-limiting this machine (HTTP 429): it is asked again shortly`])) } : {}) };
    },
    async native(_h, chains) {
      return { rows: chains.map((c) => ({ chain: c, asset: "ETH", amount: o.held?.[c] ?? 0 })), failed: [] };
    },
    async uint() {
      return undefined;
    },
    async decimals(_c, t) {
      return t.toLowerCase() === WETH.toLowerCase() ? 18 : 6;
    },
    receipt: o.receipt ?? (async () => undefined),
    ...(o.transaction ? { transaction: o.transaction } : {}),
  };
}
let clock = NOW;
const trader = (http: Http, chain: ChainReader = chainOf()): LiveTrader => dexTrader({ venue: "w", address: WALLET, proven: "rabby", http, chain, now: () => clock, pause: async () => undefined });
const ok = <T>(x: T | Refusal): T => {
  if (isRefusal(x)) throw new Error(`${x.code}: ${x.message}`);
  return x;
};
const lifiAsked = (sent: Array<{ url: string }>, path: string) => sent.filter((s) => s.url.includes(`li.quest/v1${path}`)).length;

describe("R2-19 · a tool's place words inside LI.FI's 'no route' are the tool's, not LI.FI's rule for this network", () => {
  it("in a subpath or a filteredOut reason: an invalid order with the tool's name — for a swap and for a bridge", async () => {
    const subpath = { message: "No available quotes for the requested transfer", code: 1002, errors: { failed: [{ subpaths: { "8453:USDC~8453:WETH": [{ tool: "okx", code: "TOOL_SPECIFIC_ERROR", message: "Service unavailable from a restricted jurisdiction" }] } }] } };
    const filtered = { message: "No available quotes for the requested transfer", code: 1002, errors: { filteredOut: [{ reason: "relay: not available in your region" }] } };
    for (const body of [subpath, filtered]) {
      const { http } = network([["li.quest/v1/tokens?", json(TOKENS)], ["li.quest/v1/quote", json(body, 404)]]);
      const swap = refusal(await trader(http, chainOf({ held: { "Base:USDC": 100, Base: 0.01 } })).place({ clientId: "c1", symbol: "WETH/USDC@Base", side: "buy", type: "market", qty: 0.01 }));
      expect(swap.code).toBe("E_VENUE_ORDER_INVALID");
      expect(swap.message).toMatch(/^LI\.FI: no route for this swap: (okx: TOOL_SPECIFIC_ERROR \(Service unavailable from a restricted jurisdiction\)|relay: not available in your region)$/);
      const bridge = refusal(await bridgeRoutes({ http, from: WALLET, to: WALLET, fromChain: "Base", toChain: "Arbitrum", asset: "USDC", toAsset: "USDC", amount: 50 }));
      expect(bridge.code).toBe("E_VENUE_ORDER_INVALID");
    }
  });
});

describe("R1-23 · an address LI.FI or its edge echoes never reaches a refusal or an order", () => {
  it("a 400, a no-route 404 and a /status 429 carrying IPv4 and IPv6 addresses: cleaned before anything is cut", async () => {
    const pad = "x".repeat(205);
    const { http } = network([
      ["li.quest/v1/tokens?", json(TOKENS)],
      ["li.quest/v1/quote", json({ message: `bad request from 203.0.113.44 ${pad} 2001:db8::7`, code: 1011 }, 400)],
      ["li.quest/v1/status", { status: 429, body: undefined, text: `${pad}rate limited: 198.51.100.23 2001:db8::9` }],
    ]);
    const t = trader(http, chainOf({ held: { "Base:USDC": 100, Base: 0.01 } }));
    const bad = refusal(await t.place({ clientId: "c2", symbol: "WETH/USDC@Base", side: "buy", type: "market", qty: 0.01 }));
    expect(bad.code).toBe("E_VENUE_ORDER_INVALID");
    expect(JSON.stringify(bad)).not.toMatch(ADDRESSES);
    const noRoute = network([["li.quest/v1/tokens?", json(TOKENS)], ["li.quest/v1/quote", json({ message: "No available quotes", code: 1002, errors: { filteredOut: [{ reason: "your address 2001:db8::5 is limited" }] } }, 404)]]);
    expect(JSON.stringify(refusal(await trader(noRoute.http, chainOf({ held: { "Base:USDC": 100, Base: 0.01 } })).place({ clientId: "c3", symbol: "WETH/USDC@Base", side: "buy", type: "market", qty: 0.01 })))).not.toMatch(ADDRESSES);
    const st = ok(await t.status(HASH, "WETH/USDC@Base")) as OrderState;
    expect(st.status).toBe("pending");
    expect(JSON.stringify(st)).not.toMatch(ADDRESSES);
  });
});

describe("R2-21 · a 200 that is not LI.FI's or xStocks' answer is no answer, and is kept nowhere", () => {
  it("a page for the token list: 'did not answer', not 'lists no WETH' — and asked again at once, its real list then read", async () => {
    let n = 0;
    const { http, sent } = network([["li.quest/v1/tokens?", () => (++n === 1 ? { status: 200, body: undefined, text: "<html><title>Blocked by your network</title></html>" } : json(TOKENS))]]);
    const t = trader(http);
    const first = refusal(await t.markets("WETH"));
    expect([first.code, first.message]).toEqual(["E_VENUE_UNREACHABLE", "LI.FI did not answer: something on this network answered in its place with a page that is not LI.FI's API. Nothing it said is taken as LI.FI's answer"]);
    expect(ok(await t.markets("WETH")).map((m: Market) => m.symbol)).toContain("WETH/USDC@Base");
    expect(lifiAsked(sent, "/tokens")).toBe(2);
  });

  it("an empty list (no chain's dollar in it) is not kept either; a quote that is not JSON is not 'an unnamed tool'", async () => {
    const empty = network([["li.quest/v1/tokens?", json({ tokens: {} })]]);
    expect(refusal(await trader(empty.http).markets("WETH")).code).toBe("E_VENUE_UNREACHABLE");
    const quotePage = network([["li.quest/v1/quote", { status: 200, body: undefined, text: "" }]]);
    const no = refusal(await bridgeRoutes({ http: quotePage.http, from: WALLET, to: WALLET, fromChain: "Base", toChain: "Arbitrum", asset: "USDC", toAsset: "USDC", amount: 50 }));
    expect([no.code, no.message]).toEqual(["E_VENUE_UNREACHABLE", "LI.FI answered something that is not a quote: try again shortly"]);
  });

  it("xStocks answering a page: it could not confirm, not 'its own list does not name it'", async () => {
    const { http } = network([["li.quest/v1/tokens?", json(TOKENS)], ["api.xstocks.fi", { status: 200, body: undefined, text: "<html>portal</html>" }]]);
    const no = refusal(await trader(http).market("NVDAx/USDC@Ethereum"));
    expect([no.code, no.message]).toEqual(["E_VENUE_UNREACHABLE", "xStocks answered something that is not its record of NVDAx: it could not be confirmed as its own, so nothing was prepared"]);
  });
});

describe("R1-20 · an issuer's refusal of this network keeps its own code, words and hold, as the issuer's", () => {
  it("xStocks' 451 is its place rule, held ten minutes for that token; its ban keeps its time; ETH on the same wallet still answers", async () => {
    clock = NOW;
    const { http, sent } = network([["li.quest/v1/tokens?", json(TOKENS)], ["li.quest/v1/token?", json({ address: WETH, decimals: 18, priceUSD: "2500" })], ["api.xstocks.fi", { status: 451, body: { message: "Unavailable For Legal Reasons" }, text: '{"message":"Unavailable For Legal Reasons"}' }]]);
    const t = trader(http);
    const no = refusal(await t.market("NVDAx/USDC@Ethereum"));
    expect([no.code, no.message]).toEqual(["E_VENUE_GEOBLOCKED", "xStocks does not serve this location: that is its own rule, and the account does not look for a way around it: NVDAx could not be confirmed as its own, so nothing was prepared"]);
    // about that token only: the wallet's other reads are not held back for it (holdBackMs), the token itself is, ten minutes
    expect([no.native, no.detail, holdBackMs(no, NOW)]).toEqual([expect.objectContaining({ status: 451 }), { scope: "product" }, 0]);
    clock = NOW + 9 * MIN;
    expect(refusal(await t.market("NVDAx/USDC@Ethereum")).code).toBe("E_VENUE_GEOBLOCKED");
    expect(sent.filter((s) => s.url.includes("xstocks")).length).toBe(1);
    expect(ok(await t.market("WETH/USDC@Base")).price).toBe(2500);
    const until = NOW + 30 * MIN;
    const banned = network([["li.quest/v1/tokens?", json(TOKENS)], ["api.xstocks.fi", { status: 418, body: undefined, text: `IP banned until ${until}` }]]);
    clock = NOW;
    const ban = refusal(await trader(banned.http).market("NVDAx/USDC@Ethereum"));
    expect([ban.code, (ban.native as { until?: number }).until, ban.detail]).toEqual(["E_VENUE_UNREACHABLE", until, { scope: "product" }]);
  });
});

describe("R2-20 · Robinhood Chain while Robinhood's list cannot be read", () => {
  it("no token there is offered by symbol — Robinhood's NVDA nor an impostor — in Robinhood's own words and code; once it answers (20 s later) NVDA is its Stock Token", async () => {
    clock = NOW;
    let rh = 0;
    const { http, sent } = network([["li.quest/v1/tokens?", json(TOKENS)], ["rhj/assets", () => (++rh === 1 ? { status: 503, body: undefined, text: "Service Unavailable" } : json(RH_LIST))]]);
    const t = trader(http);
    const no = refusal(await t.market("NVDA/USDG@Robinhood Chain"));
    expect([no.code, no.message]).toEqual(["E_VENUE_UNREACHABLE", "Robinhood's Stock Token list did not answer: its tokens on Robinhood Chain cannot be told from others under the same symbols just now"]);
    expect(no.detail).toEqual({ scope: "product" });
    expect(ok(await t.markets("NVDA")).filter((m: Market) => m.symbol.includes("Robinhood"))).toEqual([]);
    clock = NOW + 21_000;
    const now = ok(await t.markets("NVDA")).find((m: Market) => m.symbol === "NVDA/USDG@Robinhood Chain") as Market & { issuer?: string; eligibility?: string };
    expect([now?.issuer, typeof now?.eligibility]).toEqual([expect.stringMatching(/Robinhood/), "string"]);
    // LI.FI's list was read once: only Robinhood's was asked again
    expect(lifiAsked(sent, "/tokens")).toBe(1);
  });

  it("Robinhood's place rule is that, with its code: not 'did not answer'", async () => {
    clock = NOW;
    const { http } = network([["li.quest/v1/tokens?", json(TOKENS)], ["rhj/assets", { status: 451, body: undefined, text: "Unavailable For Legal Reasons" }]]);
    const no = refusal(await trader(http).market("NVDA/USDG@Robinhood Chain"));
    expect([no.code, no.message]).toEqual(["E_VENUE_GEOBLOCKED", expect.stringMatching(/^Robinhood's Stock Token list does not serve this location: that is its own rule/)]);
  });
});

describe("R3-14 · LI.FI refusing to price a wallet's tokenised shares is said, and held — one answer for the wallet and its trader", () => {
  const holder = chainOf({ held: { "Ethereum:NVDAx": 2 } });

  it("an edge page: the shares unpriced with LI.FI's refusal, LI.FI not asked again for ten minutes, and the trader's market the same refusal", async () => {
    const { http, sent } = network([["li.quest/v1/token?", page(403, "Access Denied", " 203.0.113.7")], ["li.quest/v1/tokens?", json(TOKENS)]]);
    const first = await issuedHoldings(WALLET, holder, http, { venue: "w", now: () => NOW });
    expect(first.rows).toEqual([{ asset: "NVDAx", amount: 2, where: "Ethereum · xStock", class: "rwa" }]);
    expect(first.unpriced).toMatchObject({ code: "E_VENUE_GEOBLOCKED", message: expect.stringMatching(/^LI\.FI refuses this network: the server in front of it answered HTTP 403 \(“Access Denied”\)/), native: { edge: true, party: "lifi" } });
    expect(JSON.stringify(first.unpriced)).not.toMatch(ADDRESSES);
    const again = await issuedHoldings(WALLET, holder, http, { venue: "w", now: () => NOW + 9 * MIN });
    expect(again.unpriced?.code).toBe("E_VENUE_GEOBLOCKED");
    expect(lifiAsked(sent, "/token?")).toBe(1);
    // the trader of the same wallet, on the same network: the same refusal, not asked
    clock = NOW + 9 * MIN;
    expect(refusal(await trader(http).markets("WETH")).code).toBe("E_VENUE_GEOBLOCKED");
    expect(lifiAsked(sent, "/tokens")).toBe(0);
  });

  it("a 429 holds a minute, a ban its own time; then LI.FI is asked again and the price is kept", async () => {
    let n = 0;
    const { http, sent } = network([["li.quest/v1/token?", () => (++n === 1 ? { status: 429, body: { message: "Too many requests" }, text: '{"message":"Too many requests"}' } : json({ address: NVDAX, decimals: 18, priceUSD: "180" }))]]);
    expect((await issuedHoldings(WALLET, holder, http, { now: () => NOW })).unpriced?.code).toBe("E_VENUE_UNREACHABLE");
    expect((await issuedHoldings(WALLET, holder, http, { now: () => NOW + 30_000 })).unpriced?.code).toBe("E_VENUE_UNREACHABLE");
    expect(lifiAsked(sent, "/token?")).toBe(1);
    const priced = await issuedHoldings(WALLET, holder, http, { now: () => NOW + 61_000 });
    expect([priced.rows[0]!.usd, priced.unpriced]).toEqual([360, undefined]);
    const banned = network([["li.quest/v1/token?", { status: 418, body: undefined, text: `IP banned until ${NOW + 20 * MIN}` }]]);
    expect((await issuedHoldings(WALLET, holder, banned.http, { now: () => NOW })).unpriced).toMatchObject({ code: "E_VENUE_UNREACHABLE", native: { until: NOW + 20 * MIN } });
    await issuedHoldings(WALLET, holder, banned.http, { now: () => NOW + 19 * MIN });
    expect(lifiAsked(banned.sent, "/token?")).toBe(1);
  });
});

describe("R1-18 · a wallet's swap: an endpoint that did not answer is not a balance of nothing", () => {
  it("a rate-limited chain, and one that answered without the token's row, refuse a sell as 'did not answer', not 'holds 0'", async () => {
    clock = NOW;
    const { http } = network([["li.quest/v1/tokens?", json(TOKENS)]]);
    const limited = refusal(await trader(http, chainOf({ failed: ["Base"] })).place({ clientId: "s1", symbol: "WETH/USDC@Base", side: "sell", type: "market", qty: 1 }));
    expect([limited.code, limited.message]).toEqual(["E_VENUE_UNREACHABLE", "Base did not answer (Base's endpoint is rate-limiting this machine (HTTP 429): it is asked again shortly): the wallet's WETH could not be read, so nothing was prepared"]);
    expect(refusal(await trader(http, chainOf({ rowless: true })).place({ clientId: "s2", symbol: "WETH/USDC@Base", side: "sell", type: "market", qty: 1 })).code).toBe("E_VENUE_UNREACHABLE");
  });
});

describe("R3-11 · the wallet's swap and bridge: an endpoint that refuses this network is said, not 'not mined yet'", () => {
  const geo = (): never => {
    throw refusal({ ok: false, code: "E_VENUE_GEOBLOCKED", layer: "venue", message: "Base's endpoint does not serve this location (HTTP 451): that is its own rule, and the account does not look for a way around it" });
  };
  const want = { chainId: 8453, chainIdHex: "0x2105" as Hex, from: WALLET, to: LIFI_DIAMOND, data: "0x1234" as Hex, value: "0x0" as Hex, what: "swap" };

  it("a hash the wallet sent is held in the endpoint's words, and an order's status keeps them while it waits", async () => {
    clock = NOW;
    const { http } = network([["li.quest/v1/tokens?", json(TOKENS)], ["li.quest/v1/status", json({ message: "Not found", code: 1003 }, 404)]]);
    const t = trader(http, chainOf({ transaction: async () => geo(), receipt: async () => geo() }));
    const no = refusal(await t.sent!("c9", HASH, want));
    expect(no.message).toMatch(/^Base's endpoint does not serve this location \(HTTP 451\).*: transaction 0x[ab]{64} could not be held to this order's swap, so the order still waits for your wallet/);
    const st = ok(await t.status(HASH, "WETH/USDC@Base")) as OrderState;
    expect([st.status, (st.native as { chain?: string }).chain]).toEqual(["pending", expect.stringMatching(/^Base's endpoint does not serve this location/)]);
  });

  it("a bridge LI.FI has not seen, on a chain whose endpoint refuses this network: pending in the endpoint's words", async () => {
    const { http } = network([["li.quest/v1/status", json({ message: "Not found", code: 1003 }, 404)]]);
    const st = await bridgeStatus({ http, hash: HASH, fromChain: "Base", toChain: "Arbitrum", chain: { receipt: async () => geo() } });
    expect(st).toMatchObject({ status: "pending", note: expect.stringMatching(/, and Base's endpoint does not serve this location \(HTTP 451\).*: still on its way as far as anyone here knows$/) });
  });
});

describe("R1-21 · LI.FI's edge, 451 or ban on /status: the chain is still asked, and LI.FI is held back", () => {
  const reverted: Mined = { status: "reverted", from: WALLET, to: LIFI_DIAMOND, logs: [] };
  const mined: Mined = { status: "success", from: WALLET, to: LIFI_DIAMOND, logs: [] };
  const ask = (http: Http, rc: Mined, now = NOW) => bridgeStatus({ http, hash: HASH, fromChain: "Base", toChain: "Arbitrum", from: WALLET, chain: { receipt: async () => rc }, now: () => now });

  it("with a reverted transaction each refusal ends it as failed; with a mined one it stays pending, carrying LI.FI's refusal and its hold", async () => {
    const answers: Array<[HttpReply, string]> = [
      [page(403, "Attention Required! | Cloudflare", " 203.0.113.7"), "E_VENUE_GEOBLOCKED"],
      [{ status: 451, body: undefined, text: "Unavailable For Legal Reasons" }, "E_VENUE_GEOBLOCKED"],
      [{ status: 418, body: undefined, text: `IP banned until ${NOW + 30 * MIN}` }, "E_VENUE_UNREACHABLE"],
    ];
    for (const [answer, code] of answers) {
      expect((await ask(network([["li.quest/v1/status", answer]]).http, reverted)).valueOf()).toMatchObject({ status: "failed" });
      const { http, sent } = network([["li.quest/v1/status", answer]]);
      const st = await ask(http, mined);
      expect(st).toMatchObject({ status: "pending", refusal: { code } });
      expect(JSON.stringify(st)).not.toMatch(ADDRESSES);
      // held back: not asked again five minutes later, and the chain still read
      expect(await ask(http, reverted, NOW + 5 * MIN)).toMatchObject({ status: "failed" });
      expect(lifiAsked(sent, "/status")).toBe(1);
    }
  });
});

// ---- the public prices (prices.ts) -------------------------------------------------------------------------------------------------------

/** a keyless client that lists ETH/USD, its market load failing while `down` says (the library keeps a failed load until told to reload) */
function flaky(o: { down: () => boolean; options?: Record<string, unknown> }) {
  let loading: Promise<unknown> | undefined;
  const counts = { loads: 0, reloads: 0, tickers: 0 };
  const markets = { "ETH/USD": { symbol: "ETH/USD" } };
  const client: ExchangeClient = {
    id: "x",
    ...(o.options ? { options: o.options } : {}),
    loadMarkets(reload?: boolean) {
      if (!loading || reload) {
        counts.loads++;
        if (reload) counts.reloads++;
        loading = o.down() ? Promise.reject(Object.assign(new Error("kraken GET https://api.kraken.com/0/public/AssetPairs fetch failed"), { name: "NetworkError" })) : Promise.resolve(markets);
        loading.catch(() => undefined);
      }
      return loading.then(() => {
        (client as { markets?: unknown }).markets = markets;
        return markets;
      });
    },
    async fetchBalance() {
      return {};
    },
    async fetchTickers(symbols?: string[]) {
      counts.tickers++;
      return Object.fromEntries((symbols ?? []).map((s) => [s, { last: 2500 }]));
    },
  };
  return { client, counts };
}

describe("R1-8 · an exchange whose first market load failed is asked again once its hold is over, its markets loaded afresh", () => {
  it("offline at login, back online: priced again within twenty seconds", async () => {
    let now = NOW;
    let down = true;
    const k = flaky({ down: () => down });
    const price = publicPrices({ open: async () => k.client, clock: () => now, order: ["kraken"] });
    expect(await price("ETH")).toBeUndefined();
    down = false;
    now += 21_000;
    expect(await price("ETH")).toBe(2500);
    expect(k.counts.reloads).toBe(1);
  });

  it("a place rule from the network before is held ten minutes, then asked again with a reload", async () => {
    let now = NOW;
    const binance = refusing(binance451);
    const price = publicPrices({ open: binance.open, clock: () => now, order: ["binance"] });
    expect(await price("ETH")).toBeUndefined();
    now += 9 * MIN;
    expect(await price("SOL")).toBeUndefined();
    expect(binance.counts.loads).toBe(1);
    now += 2 * MIN;
    await price("BNB");
    expect([binance.counts.loads, binance.counts.reloads]).toEqual([2, 1]);
  });
});

describe("R4-10 · a miss because an exchange could not be asked is not kept as 'nobody lists it'", () => {
  it("one blip at every exchange: priced again after twenty seconds, not five minutes", async () => {
    let now = NOW;
    let blip = true;
    const fail = { tickers: 0 };
    const open: OpenExchange = async (id) => ({
      id,
      markets: { "ETH/USD": { symbol: "ETH/USD" } },
      async loadMarkets() {
        return {};
      },
      async fetchBalance() {
        return {};
      },
      async fetchTickers(symbols?: string[]) {
        if (blip) {
          fail.tickers++;
          throw Object.assign(new Error(`${id} GET https://api.${id}.com/tickers request timed out`), { name: "RequestTimeout" });
        }
        return Object.fromEntries((symbols ?? []).map((s) => [s, { last: 2500 }]));
      },
    });
    const price = publicPrices({ open, clock: () => now });
    expect(await price("ETH")).toBeUndefined();
    expect(fail.tickers).toBe(5);
    blip = false;
    now += 10_000;
    expect(await price("ETH")).toBeUndefined();
    now += 11_000;
    expect(await price("ETH")).toBe(2500);
  });

  it("every exchange answered and none lists it: that miss is kept five minutes, as before", async () => {
    let now = NOW;
    let asked = 0;
    const open: OpenExchange = async (id) => ({ id, markets: {}, async loadMarkets() {
      asked++;
      return {};
    }, async fetchBalance() {
      return {};
    }, async fetchTickers() {
      return {};
    } });
    const price = publicPrices({ open, clock: () => now });
    expect(await price("NOTLISTED")).toBeUndefined();
    now += 4 * MIN;
    expect(await price("NOTLISTED")).toBeUndefined();
    expect(asked).toBe(5);
  });
});

describe("R2-6 · the prices load spot markets only: a derivatives host refusing this network is not the answer for a spot price", () => {
  it("Binance, Bybit and OKX are told spot only; an exchange whose option is not a list of types is left as it is", async () => {
    const made = new Map<string, ExchangeClient>();
    const open: OpenExchange = async (id) => {
      const c = flaky({ down: () => false, options: { fetchMarkets: id === "coinbase" ? "fetchMarketsV3" : { types: ["spot", "linear", "inverse"] } } }).client;
      made.set(id, c);
      return c;
    };
    const price = publicPrices({ open, clock: () => NOW, order: ["coinbase", "binance", "bybit", "okx"] });
    await price("NOTLISTED");
    expect(Object.fromEntries([...made].map(([id, c]) => [id, c.options?.fetchMarkets]))).toEqual({ coinbase: "fetchMarketsV3", binance: { types: ["spot"] }, bybit: { types: ["spot"] }, okx: { types: ["spot"] } });
  });
});
