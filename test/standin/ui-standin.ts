/** A STAND-IN ACCOUNT: the real account page, server and doors, over stand-in venues — to look at and click through the page with NO
 * network and NO real money.
 *
 *   npx tsx test/standin/ui-standin.ts --port 4821      (never 4820: that port is the real account's)
 *     --cap 250        the most one order or movement may be worth (the server's --live-cap)
 *     --tick 3000      how often prices move, in milliseconds
 *
 * It starts the account exactly as `npm run account` does — real accounts only, trading on with a small cap, a pairing code printed here —
 * on a fresh temporary home, with every live connection's reach replaced by a stand-in (test/standin/venues.ts): the venues, the public
 * market data, the network (every request answers "no network"), the chains (an agent wallet's balance is the stand-in's), the payees (no
 * one is paid) and the mm command line. Nothing leaves the process.
 *
 * What it seeds, all of it through the account's own door — owner actions signed by the stand-in's seed key, agent actions by a simulated
 * agent key, the way the tests sign them:
 *
 *   venues        Stand-in Exchange (spot and perpetuals, a BTC perpetual it already held, and earn: a flexible USDT product and a bonded
 *                 ETH one), Stand-in Predictions (event contracts), Stand-in Wallet (tokens, an RWA among them), Stand-in Broker (AAPL,
 *                 NVDA and SPY in New York's market hours by the stand-in's clock; $2,000 in cash, 3 AAPL and 2 NVDA held); agents may set
 *                 leverage up to 5x. Each trader says the kinds of market it trades itself (live/trade.ts `kinds`)
 *   the owner's   a market buy of ETH, a resting limit buy of SOL (it fills when the price comes down to it), a limit sell of BTC above the
 *   own trading   market, a stop under SOL, 5x on the ETH perpetual and a long there, 50 YES contracts on the Fed, WETH bought from the
 *                 wallet, a limit placed and canceled; at the broker, while the US market is open, market buys of half a share of AAPL and
 *                 a share of NVDA (while it is closed no market order is taken: the broker held them already), and a limit buy of a
 *                 quarter share of SPY under the market — on the book, or held by the broker until the open; a fraction of a share is a
 *                 day order, so it lapses at its session's close; spot to futures, USDC swapped for USDT, $25 withdrawn to the agent's
 *                 wallet, $150 of USDT put into the flexible earn product (done on the next tick)
 *   the agent     "Claude Code": let in for 30 days, a trading limit ($150 an order, $600 in all, at the three venues), a limit between the
 *                 user's own places and a payees limit, an agent wallet; in Beast it places a limit buy of SOL inside its limit, then
 *                 in Guard it asks for a market buy of ETH, which waits on a card for the owner
 *   steering      two intents (one to Claude Code, one to every agent), Claude Code's report on the first, two asks (a bigger budget, a
 *                 venue connected), three watched markets — one at a venue that is not connected
 *   memory        the owner's About you, and two notes Claude Code keeps (account/memory.ts); the conversation the account kept as all of
 *                 the above passed (Account → Memory)
 *   the curve     net worth points over the last seven days, off the stand-in's own price curves, so the curve draws at once
 *
 * PAIRING. The seed key paired first, with the code, the way a browser does. The page then asks this browser for the code too: typed
 * right, the seed key signs one owner action (convertToMultiSigUser) that makes this browser an owner beside it, one signature enough.
 * The seed key stays an owner because every limit it signed is checked against the owners each time it is used: a limit whose signer is
 * gone no longer stands. A second browser after that waits until an owner lets it in under Devices, as on the real account.
 *
 * The agent wallet's key is made in the home the way a real one is (account/keystore.ts), so its address is a real address on every EVM
 * chain: its balance here is the stand-in chain's, and nothing real should ever be sent to it.
 *
 * While it runs: prices move every few seconds, a resting order fills when the price crosses it (at the broker, only while the US market
 * is open), a stop fires, the fifteen-minute bitcoin market rolls over and settles; Claude Code reports when its order fills, and when its
 * card expires unanswered the seed key closes it and Claude Code asks again (in Guard only).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isRefusal, type Refusal } from "../../src/core/errors.ts";
import { no } from "../../src/portfolio/refuse.ts";
import { cardHash, type Outcome } from "../../src/portfolio/account/exchange.ts";
import { agentWalletKey } from "../../src/portfolio/account/keystore.ts";
import { NetWorthLog, networthPath } from "../../src/portfolio/account/networth.ts";
import { isJwk, kidOf, signAgent, signDevice, simKey, type AgentAction, type OwnerAction, type SimKey } from "../../src/portfolio/account/sign.ts";
import { isOwner } from "../../src/portfolio/account/state.ts";
import type { LiveDeps } from "../../src/portfolio/live/index.ts";
import { isStable, type LiveBalance } from "../../src/portfolio/live/types.ts";
import { pairingCode, startPortfolioServer, type PortfolioServerHandle } from "../../src/portfolio/server.ts";
import { loadOpenness, PortfolioService } from "../../src/portfolio/service.ts";
import { DAY, toStep } from "./model.ts";
import { makeWorld, publicSources, registerStandins, standinChain, standinPrice, standinSender, stockSession, tick, type World } from "./venues.ts";

type NoNonce<T> = T extends unknown ? Omit<T, "nonce"> : never;
const HOUR = 3_600_000;
export const REAL_PORT = 4820;
export const AGENT_NAME = "Claude Code";

export interface StandinOptions {
  /** 0: any free port (tests) */
  port: number;
  /** the most one order or movement may be worth ($250) */
  capUsd?: number | undefined;
  /** how often prices move and resting orders are looked at (3000 ms); 0: only when `step()` is called */
  tickMs?: number | undefined;
  /** how often the agent looks at its orders and its card (15000 ms); 0: only when `step()` is called */
  agentMs?: number | undefined;
  /** how often the net worth curve gets a point (60000 ms) */
  snapshotMs?: number | undefined;
  /** the real clock (a stand-in's in tests) */
  clock?: (() => number) | undefined;
  /** the pairing code (a fresh one unless given) */
  code?: string | undefined;
  /** where the account keeps its ledger (a fresh temporary home unless given) */
  home?: string | undefined;
}

/** what was seeded, by id */
export interface Seeded {
  venues: string[];
  agent: { name: string; address: string; wallet: string };
  orders: Record<string, string>;
  card: string;
  intents: string[];
  asks: number;
  watch: number;
  curvePoints: number;
}

export interface Standin {
  url: string;
  code: string;
  home: string;
  svc: PortfolioService;
  world: World;
  seeded: Seeded;
  /** the seed key: an owner of the account */
  seed: SimKey;
  /** the agent's key */
  agent: SimKey;
  /** what the timers do, once, now: prices step and resting orders fill; the agent looks at its orders and its card */
  step(): Promise<void>;
  close(): Promise<void>;
}

/** every request the stand-in's connections would make, answered: there is no network here */
const noNetwork: LiveDeps["http"] = async () => ({ status: 599, body: undefined, text: "the stand-in reaches no network" });

const ok = <T extends Outcome | Refusal>(what: string, o: T): Exclude<T, Refusal> => {
  if (isRefusal(o)) throw new Error(`the stand-in could not seed ${what}: ${o.code} · ${o.message}`);
  return o as Exclude<T, Refusal>;
};
const orderOf = (what: string, o: Outcome): string => {
  const r = ok(what, o);
  if (r.kind !== "order") throw new Error(`the stand-in could not seed ${what}: it came back as ${r.kind}`);
  return r.order.id;
};

export async function startStandin(o: StandinOptions): Promise<Standin> {
  if (o.port === REAL_PORT) throw new Error(`port ${REAL_PORT} is the real account's: the stand-in never starts there (use 4821)`);
  registerStandins();
  const clock = o.clock ?? Date.now;
  const world = makeWorld({ clock });
  const madeHome = o.home === undefined;
  const home = o.home ?? mkdtempSync(join(tmpdir(), "ui-standin-"));
  const code = o.code ?? pairingCode();
  const capUsd = o.capUsd ?? 250;
  const month = new Date(clock() + 30 * DAY).toISOString();
  const svc = await PortfolioService.create({
    home,
    venues: "frontline",
    real: true,
    fresh: true,
    liveWrites: { capUsd, pairingCode: code },
    openness: { ...(loadOpenness() as object), sessionExpiresAt: month },
    publicMarkets: publicSources(),
    payHttp: async () => ({ status: 0, headers: {}, body: undefined, error: "the stand-in pays no one: it reaches no network" }),
    liveDeps: {
      http: noNetwork,
      clock,
      chain: standinChain(),
      sender: standinSender,
      price: standinPrice,
      mm: async () => {
        throw no("E_VENUE_UNREACHABLE", { venue: "metamask", message: "the stand-in runs no mm command line" });
      },
      openExchange: async () => undefined,
      openMcp: async () => {
        throw new Error("the stand-in reaches no MCP server");
      },
    },
  });
  await svc.restoring;
  const engine = svc.account!;

  // ---- the two signers the stand-in holds: its seed key (an owner) and the agent's key ----
  const seed = simKey("device:ui-standin-seed");
  const agent = simKey("agent:ui-standin-claude-code");
  const paired = engine.pairDevice(seed.jwk, "Stand-in seed key", code);
  if (isRefusal(paired) || paired.role !== "owner") throw new Error("the stand-in's seed key could not pair as the first owner");
  /** the owner asks, as the page does: prepared by the account, signed over exactly what it shows, sent through the door */
  const own = async (draft: Record<string, unknown>): Promise<Outcome> => {
    const p = await engine.prepare(draft);
    if (isRefusal(p)) return p;
    return svc.exchange({ action: p.action, nonce: p.action.nonce, signature: signDevice(seed, p.action) });
  };
  let agentNonce = 0;
  const ag = async (a: NoNonce<AgentAction>): Promise<Outcome> => {
    agentNonce = Math.max(agentNonce + 1, Date.now());
    return svc.exchange(await signAgent(agent, { ...a, nonce: agentNonce } as AgentAction));
  };
  const price = (book: "ex" | "predict" | "wallet" | "broker", symbol: string, side: "bid" | "ask" | "price" = "price"): number => {
    const m = world[book].market(symbol);
    if (!m?.[side]) throw new Error(`the stand-in has no price for ${symbol}`);
    return m[side]!;
  };
  const now = clock();

  // ---- the venues ----
  ok("Stand-in Exchange", await own({ type: "connectVenue", venue: "ex", connector: "live:standin-exchange", label: "Stand-in Exchange", credentialRef: "" }));
  ok("Stand-in Predictions", await own({ type: "connectVenue", venue: "predict", connector: "live:standin-events", label: "Stand-in Predictions", credentialRef: "" }));
  ok("Stand-in Wallet", await own({ type: "connectVenue", venue: "wallet", connector: "live:standin-wallet", label: "Stand-in Wallet", credentialRef: "" }));
  // the broker keeps New York's market hours by the stand-in's clock. While the market is closed it takes no market order, so the half share
  // of Apple and the share of NVIDIA the owner buys below while it is open were held there already
  const stocksOpen = stockSession(now).open;
  if (!stocksOpen) for (const [symbol, qty] of [["AAPL", 0.5], ["NVDA", 1]] as const) world.broker.add("stocks", symbol, qty);
  ok("Stand-in Broker", await own({ type: "connectVenue", venue: "broker", connector: "live:standin-broker", label: "Stand-in Broker", credentialRef: "" }));
  ok("the agents' leverage cap", await own({ type: "setPolicy", change: "maxLeverage", value: "5" }));

  // ---- the owner's own trading: the statement's first lines ----
  const orders: Record<string, string> = {};
  orders.ethBuy = orderOf("a market buy of ETH", await own({ type: "liveOrder", venue: "ex", symbol: "ETH/USDT", side: "buy", orderType: "market", qty: "0.04" }));
  orders.solLimit = orderOf("a limit buy of SOL", await own({ type: "liveOrder", venue: "ex", symbol: "SOL/USDT", side: "buy", orderType: "limit", qty: "0.5", limitPrice: String(toStep(price("ex", "SOL/USDT", "ask") * 0.997, 0.01, "floor")) }));
  orders.btcSell = orderOf("a limit sell of BTC", await own({ type: "liveOrder", venue: "ex", symbol: "BTC/USDT", side: "sell", orderType: "limit", qty: "0.002", limitPrice: String(toStep(price("ex", "BTC/USDT", "bid") * 1.012, 0.1, "ceil")) }));
  orders.solStop = orderOf("a stop under SOL", await own({ type: "liveOrder", venue: "ex", symbol: "SOL/USDT", side: "sell", orderType: "stop", qty: "0.6", stopPrice: String(toStep(price("ex", "SOL/USDT", "bid") * 0.965, 0.01, "floor")) }));
  ok("5x on the ETH perpetual", await own({ type: "liveLeverage", venue: "ex", symbol: "ETH/USDT:USDT", leverage: "5", marginMode: "cross" }));
  orders.ethPerp = orderOf("a long on the ETH perpetual", await own({ type: "liveOrder", venue: "ex", symbol: "ETH/USDT:USDT", side: "buy", orderType: "market", qty: "0.05" }));
  orders.fedYes = orderOf("50 YES on the Fed", await own({ type: "liveOrder", venue: "predict", symbol: "SI-FEDCUT-DEC:YES", side: "buy", orderType: "market", qty: "50" }));
  orders.weth = orderOf("WETH from the wallet", await own({ type: "liveOrder", venue: "wallet", symbol: "WETH/USDC@Base", side: "buy", orderType: "market", qty: "0.02" }));
  orders.btcCanceled = orderOf("a limit buy of BTC", await own({ type: "liveOrder", venue: "ex", symbol: "BTC/USDT", side: "buy", orderType: "limit", qty: "0.001", limitPrice: String(toStep(price("ex", "BTC/USDT", "bid") * 0.95, 0.1, "floor")) }));
  ok("the BTC limit canceled", await own({ type: "liveCancel", venue: "ex", order: orders.btcCanceled }));
  // stocks: market buys only while the market is open — half a share of Apple (a fraction: a day order, the broker's default) and a whole
  // share of NVIDIA (whole shares only) — and a limit buy of a quarter share of SPY under the market, open or closed: on the book, or held
  // by the broker for the open; a day order, so it lapses at its session's close
  if (stocksOpen) {
    orders.aaplBuy = orderOf("a market buy of AAPL", await own({ type: "liveOrder", venue: "broker", symbol: "AAPL", side: "buy", orderType: "market", qty: "0.5" }));
    orders.nvdaBuy = orderOf("a market buy of NVDA", await own({ type: "liveOrder", venue: "broker", symbol: "NVDA", side: "buy", orderType: "market", qty: "1" }));
  }
  orders.spyLimit = orderOf("a limit buy of SPY", await own({ type: "liveOrder", venue: "broker", symbol: "SPY", side: "buy", orderType: "limit", qty: "0.25", limitPrice: String(toStep(price("broker", "SPY", "bid") * 0.997, 0.01, "floor")) }));
  ok("spot to futures", await own({ type: "liveMove", kind: "transfer", from: "ex", fromLedger: "spot", to: "ex", toLedger: "futures", asset: "USDT", toAsset: "USDT", amount: "200" }));
  ok("USDC for USDT", await own({ type: "liveMove", kind: "swap", from: "ex", to: "ex", asset: "USDC", toAsset: "USDT", amount: "50" }));

  // ---- the agent: let in, its limits, its wallet ----
  ok("Claude Code let in", await own({ type: "approveAgent", agentAddress: agent.address, agentName: AGENT_NAME, validUntil: now + 30 * DAY }));
  ok("Claude Code's trading limit", await own({ type: "approveSpend", agent: agent.address, scope: "trade", allow: "ex,predict,wallet", perPayment: "150", budget: "600", windowHours: 0, validUntil: now + 7 * DAY }));
  // the agent wallet's key is made in the home now, so the stand-in chain can hold its starting dollars and gas before it is first read
  const walletKey = agentWalletKey(home, AGENT_NAME);
  if (isRefusal(walletKey)) throw new Error(`the stand-in could not make the agent wallet's key: ${walletKey.message}`);
  const walletAt = walletKey.address.toLowerCase();
  world.chain.set(`${walletAt}|Base|USDC`, 40);
  world.chain.set(`${walletAt}|Base|ETH`, 0.003);
  ok("Claude Code's agent wallet", await own({ type: "createSubAccount", name: AGENT_NAME, agent: agent.address, float: "100" }));
  const walletVenue = svc.accounts().find((a) => a.address?.toLowerCase() === walletAt)?.id ?? "agent-claude-code";
  ok("Claude Code's limit between your places", await own({ type: "approveSpend", agent: agent.address, scope: "venues", allow: `ex,${walletVenue}`, perPayment: "50", budget: "200", windowHours: 24, validUntil: now + 7 * DAY }));
  ok("Claude Code's payees limit", await own({ type: "approveSpend", agent: agent.address, scope: "payees", allow: "api.example.com", perPayment: "2", budget: "20", windowHours: 0, validUntil: now + 7 * DAY }));
  ok("$25 to the agent's wallet", await own({ type: "liveMove", kind: "withdraw", from: "ex", to: walletVenue, asset: "USDC", toAsset: "USDC", network: "Base", amount: "25" }));
  // money to earn: out of spot at once, done on the next tick (the timer's, or step()'s)
  ok("$150 of USDT to earn", await own({ type: "liveEarn", venue: "ex", kind: "supply", product: "flex:USDT", asset: "USDT", amount: "150" }));

  // ---- Beast: the agent's order inside its limit goes at once; Guard: its next one waits on a card ----
  ok("Beast", await own({ type: "setPolicy", change: "mode", value: "open" }));
  orders.agentSol = orderOf("Claude Code's SOL limit", await ag({ type: "agentLiveOrder", venue: "ex", symbol: "SOL/USDT", side: "buy", orderType: "limit", qty: "", usd: "100", limitPrice: String(toStep(price("ex", "SOL/USDT", "ask") * 0.99, 0.01, "floor")) }));
  svc.setMode("guard");
  const asked = ok("Claude Code's card", await ag({ type: "agentLiveOrder", venue: "ex", symbol: "ETH/USDT", side: "buy", orderType: "market", qty: "", usd: "120", limitPrice: "" }));
  if (asked.kind !== "card") throw new Error(`the stand-in's agent order came back as ${asked.kind}, not a card`);
  let card = asked.card.id;

  // ---- steering: intents, a report, asks, the watchlist ----
  ok("an intent for Claude Code", await own({ type: "setIntent", id: "", agent: agent.address, venue: "ex", symbol: "SOL/USDT", side: "buy", usd: "300", text: "Build a SOL position under $140, a little at a time", validUntil: now + 3 * DAY }));
  ok("an intent for every agent", await own({ type: "setIntent", id: "", agent: "*", venue: "", symbol: "BTC/USDT", side: "", usd: "", text: "Tell me if BTC moves more than 5% in a day", validUntil: now + 7 * DAY }));
  const intents = engine.state.intents.map((i) => i.id);
  const forAgent = engine.state.intents.find((i) => i.agent === agent.address)!.id;
  ok("Claude Code's report", await ag({ type: "agentReport", intent: forAgent, status: "taking", note: `Placed a $100 limit 1% under the market (${orders.agentSol}); I will add on dips under $140.`, refs: orders.agentSol }));
  ok("Claude Code's ask for a bigger budget", await ag({ type: "agentAsk", kind: "limit", venue: "ex", usd: "1000", text: "Raise my trading budget to $1,000 so I can finish the SOL position you asked for" }));
  ok("Claude Code's ask for a venue", await ag({ type: "agentAsk", kind: "venue", venue: "standin-pubex", usd: "", text: "Connect Stand-in Public Exchange: DOGE trades only there" }));
  for (const [venue, symbol] of [["ex", "BTC/USDT"], ["predict", "SI-FEDCUT-DEC:YES"], ["standin-pubex", "DOGE/USD"]] as const) ok(`${symbol} watched`, await own({ type: "setWatch", venue, symbol, on: "true" }));
  // memory (account/memory.ts): the owner's About you, and two notes Claude Code keeps for itself, signed with its key
  ok("About you", await own({ type: "setMemory", scope: "about", id: "", topic: "rule", text: "Small positions: no more than $150 an order, and never leverage above 3x without asking me first." }));
  ok("Claude Code's note on the owner", await ag({ type: "agentRemember", id: "", topic: "preference", text: "The owner builds positions with limit orders on dips, and wants a report after each fill." }));
  ok("Claude Code's note on its task", await ag({ type: "agentRemember", id: "", topic: "progress", text: "SOL position for the owner's intent: first $100 limit placed 1% under the market; add again under $140." }));

  // ---- the net worth curve: points over the last seven days, off the same curves the candles come from ----
  const curvePoints = await drawThePast(svc, world, home, walletVenue, walletAt);

  const server: PortfolioServerHandle = await startPortfolioServer({ port: o.port, service: svc, snapshotMs: o.snapshotMs ?? 60_000 });

  // ---- the browser pairs with the code: the seed key makes it an owner beside it ----
  const pairDevice = engine.pairDevice.bind(engine);
  let misses = 0;
  let handed = false;
  const plain = (x: string) => x.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  engine.pairDevice = (jwk: unknown, label = "this browser", given?: string) => {
    if (handed || !isJwk(jwk) || isOwner(engine.state, `device:${kidOf(jwk)}`)) return pairDevice(jwk, label, given);
    const kid = kidOf(jwk);
    if (given === undefined || given === "") return { ok: true, kid, role: "needs-code" };
    if (misses >= 5) return no("E_ACCOUNT_OWNER_SURFACE", { message: "too many wrong pairing codes: restart the stand-in for a new one" });
    if (plain(given) !== plain(code)) {
      misses++;
      return no("E_ACCOUNT_OWNER_SURFACE", { message: `that is not the pairing code the stand-in printed in its terminal (${5 - misses} tries left)` });
    }
    const asking = pairDevice(jwk, label, given);
    if (isRefusal(asking)) return asking;
    // one owner action, through the door: the account's signers become this browser and the seed key, one signature enough. It is in the
    // door's line before anything this browser can sign
    const action: OwnerAction = { type: "convertToMultiSigUser", signers: JSON.stringify({ authorizedUsers: [`device:${kid}`, `device:${seed.kid}`].sort(), threshold: 1 }), nonce: engine.nextNonce() };
    handed = true;
    void svc.exchange({ action, nonce: action.nonce, signature: signDevice(seed, action) }).then((out) => {
      if (isRefusal(out)) console.error(`the stand-in could not make the browser an owner: ${out.code} · ${out.message}`);
    });
    return { ok: true, kid, role: "owner" };
  };

  // ---- while it runs ----
  let reported = false;
  const agentLooks = async () => {
    // how the orders stand at the venues, as a page read asks
    await engine.settle();
    const mine = engine.orders.find((x) => x.id === orders.agentSol);
    if (!reported && mine?.status === "filled") {
      reported = true;
      await ag({ type: "agentReport", intent: forAgent, status: "note", note: `My SOL limit filled: ${mine.filledQty} SOL at $${mine.avgPrice ?? mine.limitPrice}. I will wait for the next dip under $140.`, refs: mine.id });
    }
    // a card that expired unanswered: the seed key closes it (what it held is freed), and the agent asks again — in Guard only
    const c = engine.host.card(card);
    if (c?.status === "pending" && c.expiresAt && Date.now() >= Date.parse(c.expiresAt)) {
      await own({ type: "approveCard", card: c.id, action: cardHash(c), decision: "reject" });
      if (svc.policy().mode === "guard") {
        const again = await ag({ type: "agentLiveOrder", venue: "ex", symbol: "ETH/USDT", side: "buy", orderType: "market", qty: "", usd: "120", limitPrice: "" });
        if (!isRefusal(again) && again.kind === "card") card = again.card.id;
      }
    }
  };
  const step = async () => {
    tick(world);
    await agentLooks();
  };
  const timers: Array<ReturnType<typeof setInterval>> = [];
  const every = (ms: number, fn: () => unknown) => {
    if (!(ms > 0)) return;
    let busy = false;
    const t = setInterval(() => {
      if (busy) return;
      busy = true;
      Promise.resolve()
        .then(fn)
        .catch((err: unknown) => console.error(`stand-in: ${String((err as Error)?.message ?? err).slice(0, 200)}`))
        .finally(() => void (busy = false));
    }, ms);
    t.unref();
    timers.push(t);
  };
  every(o.tickMs ?? 3_000, () => tick(world));
  every(o.agentMs ?? 15_000, agentLooks);

  const seeded: Seeded = { venues: ["ex", "predict", "wallet", "broker", walletVenue], agent: { name: AGENT_NAME, address: agent.address, wallet: walletVenue }, orders, card, intents, asks: 2, watch: 3, curvePoints };
  return {
    url: server.url,
    code,
    home,
    svc,
    world,
    seeded,
    seed,
    agent,
    step,
    close: async () => {
      for (const t of timers) clearInterval(t);
      await server.close();
      // a home made for a test goes with it; the one the command line made is kept (its ledger, and the agent wallet's key)
      if (madeHome && !isMain && process.env.UI_STANDIN_KEEP !== "1") rmSync(home, { recursive: true, force: true });
    },
  };
}

/** Points on the net worth curve for the last seven days (every four hours, then every half hour over the last day): each venue's holdings
 * as they are now — read from the stand-in's books, since the account's own read of a venue is up to thirty seconds old — priced on the
 * stand-in's curves at that moment. Money the total counts and no venue holds (a withdrawal on its way) is carried as it is now. Written
 * before the server takes its first point, so the curve runs on into it */
async function drawThePast(svc: PortfolioService, world: World, home: string, walletVenue: string, walletAt: string): Promise<number> {
  const page = await svc.accountView();
  if (!page) return 0;
  const chain = [...world.chain].filter(([k]) => k.startsWith(`${walletAt}|`)).map(([k, amount]): LiveBalance => {
    const asset = k.split("|")[2]!;
    return { asset, amount, ...(isStable(asset) ? { class: "stable" as const } : {}) };
  });
  // what is in earn is the exchange's too (the account page counts it there), priced on the same curves
  const earned: LiveBalance[] = [...world.earn.held].filter(([, amount]) => amount > 0).map(([product, amount]) => {
    const asset = world.earn.specs.find((x) => x.id === product)!.asset;
    return { asset, amount, ...(isStable(asset) ? { class: "stable" as const } : {}) };
  });
  const held: Array<[string, LiveBalance[]]> = [["ex", [...world.ex.read(), ...earned]], ["predict", world.predict.read()], ["wallet", world.wallet.read()], ["broker", world.broker.read()], [walletVenue, chain]];
  const log = new NetWorthLog(networthPath(home), world.clock);
  const now = world.clock();
  const keyOf = (asset: string): { key: string; flip: boolean } | undefined => {
    const a = asset.toUpperCase();
    if (a.includes(":")) {
      const id = asset.slice(0, asset.lastIndexOf(":"));
      return world.prices.has(`ev:${id}`) ? { key: `ev:${id}`, flip: /:(NO|DOWN)$/i.test(asset) } : undefined;
    }
    const k = a === "WETH" ? "ETH" : a === "CBBTC" || a === "WBTC" ? "BTC" : a;
    return world.prices.has(k) ? { key: k, flip: false } : undefined;
  };
  const other = page.inFlightUsd + page.heldUsd;
  const times: number[] = [];
  for (let t = now - 7 * DAY; t < now - DAY; t += 4 * HOUR) times.push(t);
  for (let t = now - DAY; t < now - 10 * 60_000; t += HOUR / 2) times.push(t);
  let written = 0;
  for (const t of times) {
    const byVenue: Record<string, number> = {};
    const byClass: Record<string, number> = {};
    for (const [venue, rows] of held) {
      let sum = 0;
      for (const b of rows) {
        const cls = b.class ?? (isStable(b.asset) ? "stable" : "crypto");
        const k = cls === "stable" || cls === "cash" ? undefined : keyOf(b.asset);
        const p = k ? world.prices.at(k.key, t) : undefined;
        const usd = cls === "stable" || cls === "cash" ? b.amount : p === undefined ? (b.usd ?? 0) : b.amount * (k!.flip ? 1 - p : p);
        sum += usd;
        byClass[cls] = (byClass[cls] ?? 0) + usd;
      }
      byVenue[venue] = sum;
    }
    const usd = Object.values(byVenue).reduce((s, x) => s + x, 0) + other;
    const r = log.append({ at: t, usd, byClass, byVenue, stale: [], paidOutUsd: 0 });
    if (!isRefusal(r) && r.written) written++;
  }
  return written;
}

const isMain = !!process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const args = process.argv.slice(2);
  const at = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const port = Number(at("--port") ?? 4821);
  if (!Number.isInteger(port) || port < 0) throw new Error("--port is a port number");
  if (port === REAL_PORT) {
    console.error(`port ${REAL_PORT} is the real account's: the stand-in never starts there. Use --port 4821`);
    process.exit(1);
  }
  const capUsd = Number(at("--cap") ?? 250);
  const tickMs = Number(at("--tick") ?? 3_000);
  if (!(capUsd > 0) || !(tickMs > 0)) throw new Error("--cap is dollars and --tick milliseconds, both more than zero");
  const s = await startStandin({ port, capUsd, tickMs }).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "EADDRINUSE") {
      console.error(`port ${port} is already in use: is a stand-in running already? Open http://127.0.0.1:${port}, or pick another with --port`);
      process.exit(1);
    }
    throw e;
  });
  const v = s.seeded;
  console.log(
    [
      "STAND-IN ACCOUNT · no network, no real money: every venue, price and fill on this page is made up (test/standin)",
      `  page          ${s.url}`,
      `  pairing code  ${s.code}  — type it on the page: your browser becomes an owner beside the stand-in's seed key`,
      `  home          ${s.home}  (fresh, kept after you stop; its ledger is ${s.svc.ledgerPath()})`,
      `  trading       on, at most $${capUsd} an order or a movement`,
      `  agent wallet  ${v.agent.wallet} holds a real key made in this home, so its address is a real one: send it nothing real`,
      `  seeded        venues ${v.venues.join(", ")} · ${Object.keys(v.orders).length} orders · ${v.agent.name} with trade, venues and payees limits and an agent wallet · 1 card waiting (${v.card}) · ${v.intents.length} intents · a report · ${v.asks} asks · ${v.watch} watched markets · ${v.curvePoints} net worth points over 7 days`,
      `  prices move every ${tickMs / 1000} s · Ctrl-C to stop`,
    ].join("\n"),
  );
  const stop = () => s.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
