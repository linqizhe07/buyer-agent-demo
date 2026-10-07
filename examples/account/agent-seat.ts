/** An agent seat in one file: it holds a key, signs ONE instruction, and posts it to the account's door (POST /api/exchange).
 * The account it talks to holds the user's REAL accounts (`npm run account`): an agent places orders there, and asks for money to move
 * between them — inside the limit the owner signed for this seat on the Account page. Conservative mode: every order is a card the owner
 * signs. Aggressive: inside the limit it is placed at once.
 *
 *   npm run account -- --live-cap 5                                                # the service, in another terminal ($5 an order at most)
 *   npx tsx examples/account/agent-seat.ts whoami                                  # this seat's key; knocks if the owner has not authorised it
 *   npx tsx examples/account/agent-seat.ts markets okx BTC                         # what a venue trades
 *   npx tsx examples/account/agent-seat.ts order okx buy BTC/USDT '$5'             # a market order for $5 of BTC
 *   npx tsx examples/account/agent-seat.ts order okx sell BTC/USDT 0.0001 70000    # a limit order: 0.0001 BTC at 70,000
 *   npx tsx examples/account/agent-seat.ts order okx sell ETH/USDT:USDT 0.1 stop=2800 reduce   # a stop that only shrinks a position
 *   npx tsx examples/account/agent-seat.ts order okx buy BTC/USDT 0.001 60000 tif=ioc post      # flags the market lists: tif, post-only, reduce-only
 *   npx tsx examples/account/agent-seat.ts amend okx ord-0001 limit=61000 qty=0.002            # change an order of this seat's in place
 *   npx tsx examples/account/agent-seat.ts positions okx                                       # what is held there
 *   npx tsx examples/account/agent-seat.ts close okx ETH/USDT:USDT                             # close it (all of it; or a qty after the symbol)
 *   npx tsx examples/account/agent-seat.ts pay https://api.example.com/quote 0.05 research     # pay for a URL from the agent wallet "research"
 *   npx tsx examples/account/agent-seat.ts cancel okx ord-0001                     # take an order of this seat's off the book
 *   npx tsx examples/account/agent-seat.ts move withdraw okx wallet 5 USDC Arbitrum   # from an exchange to another place of the user's
 *   npx tsx examples/account/agent-seat.ts move bridge wallet wallet 5 USDC Arbitrum Base   # from a wallet to the same wallet on another chain
 *   npx tsx examples/account/agent-seat.ts move transfer okx okx 5 USDT funding trading   # between an exchange's own ledgers
 *   npx tsx examples/account/agent-seat.ts move swap okx okx 5 USDT USDC              # one stablecoin for another there
 *
 * The rules an agent meets in the simulated account — routes between venues, floats, paying an API (x402, MPP, AP2) — are walked through
 * in-process by examples/account/headless.ts. PORTFOLIO_URL overrides http://127.0.0.1:4820. PORTFOLIO_AGENT names the seat (default
 * "example-seat"): the seat's key is its own, made the first time it runs and kept in <home>/seats/<name>.json, readable by the user alone
 * (PORTFOLIO_SEAT_KEYS=sim derives it from the name instead — public, for demos). The seat never holds a venue credential: it signs a request,
 * and the account does the rest. */
import { signAgent, simKey, type AgentAction } from "../../src/portfolio/account/sign.ts";
import { mustKey, seatKey } from "../../src/portfolio/account/keystore.ts";
import { defaultHome } from "../../src/portfolio/home.ts";

const BASE = process.env.PORTFOLIO_URL ?? "http://127.0.0.1:4820";
const NAME = process.env.PORTFOLIO_AGENT ?? "example-seat";
const SLUG = NAME.toLowerCase().replace(/[^a-z0-9]+/g, "-");
const key = process.env.PORTFOLIO_SEAT_KEYS === "sim" ? simKey(`agent:${SLUG}`) : mustKey(seatKey(defaultHome(), SLUG));
const [cmd, kind = "", from = "", to = "", amount = "", e = "", f = "", g = ""] = process.argv.slice(2);

type Reply = { status: number; body: Record<string, any> };
type Unsigned<T> = T extends unknown ? Omit<T, "nonce"> : never;

/** the nonce is the account's own clock in milliseconds: a money instruction is good for ten minutes around it */
const now = async (): Promise<number> => Number(((await (await fetch(`${BASE}/api/now`)).json()) as { ms: number }).ms);
let last = 0;
async function send(action: Unsigned<AgentAction>): Promise<Reply> {
  last = Math.max(await now(), last + 1);
  const envelope = await signAgent(key, { ...action, nonce: last } as AgentAction);
  const r = await fetch(`${BASE}/api/exchange`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope) });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
}

/** 200 done · 202 the owner is asked first (a card) · 401 not a signer · 409 refused, with a code that says which line was crossed */
function say(r: Reply): void {
  const x = r.body;
  if (x.refusal) console.log(`${r.status} ✗ ${x.refusal.code} · ${x.refusal.message}`);
  else if (x.kind === "order") console.log(`${r.status} ✓ ${x.order.id} · ${x.order.side} ${x.order.qty} ${x.order.symbol} at ${x.order.venueName} · ${x.order.status} · ${x.order.note}`);
  else if (x.kind === "card") console.log(`${r.status} ▣ ${x.card.id} waits for the owner · ${x.card.reason}`);
  else if (x.kind === "payment") console.log(`${r.status} ✓ ${x.payment.id} · ${x.payment.kind} ${x.payment.from} → ${x.payment.to} · $${x.payment.amountUsd} · ${x.payment.status}${x.payment.note ? ` · ${x.payment.note}` : ""}`);
  else console.log(`${r.status} ${JSON.stringify(x).slice(0, 300)}`);
}

if (cmd === "whoami") {
  const account = (await (await fetch(`${BASE}/api/account`)).json()) as { keys: Array<{ address: string; name: string; status: string; validUntil: string }>; spend: Array<{ agent: string; scope: string; allow: string[]; perPaymentUsd: number; budgetUsd: number; spentUsd: number; reservedUsd: number }> };
  const mine = account.keys.find((k) => k.address === key.address);
  console.log(`seat "${NAME}" · key ${key.address}`);
  if (mine?.status === "ok") {
    console.log(`authorised as "${mine.name}" until ${mine.validUntil}`);
    for (const s of account.spend.filter((x) => x.agent === key.address)) console.log(`  ${s.scope === "trade" ? "may trade at" : "may ask to move between"} ${s.allow.join(", ")} · $${s.perPaymentUsd} ${s.scope === "trade" ? "an order" : "a movement"} · $${(s.budgetUsd - s.spentUsd - s.reservedUsd).toFixed(2)} left of $${s.budgetUsd}`);
  } else if (mine?.status === "revoked") {
    console.log("this key was revoked, and a revoked key is never authorised again: the seat needs a new key (here: another PORTFOLIO_AGENT name)");
  } else {
    // knock: a signed request from a key the account does not know is refused, and the owner sees the key under "Asking to be let in"
    say(await send({ type: "agentLiveMove", kind: "transfer", from: "", fromLedger: "", to: "", toLedger: "", asset: "USDC", toAsset: "USDC", network: "", amount: "1", maxFee: "0" }));
    console.log(`not authorised${mine ? ` (${mine.status})` : ""}: the owner opens ${BASE} → Agents → "Let in…"`);
  }
} else if (cmd === "markets") {
  // markets <venue> [query]: what the venue trades, priced in dollars
  const r = (await (await fetch(`${BASE}/api/account/markets?${new URLSearchParams({ venue: kind, q: from })}`)).json()) as { ok: boolean; markets?: Array<{ symbol: string; name: string; price?: number; open: boolean; minQty?: number }>; refusal?: { code: string; message: string } };
  if (!r.ok) console.log(`✗ ${r.refusal?.code} · ${r.refusal?.message}`);
  else for (const m of r.markets ?? []) console.log(`${m.symbol.padEnd(28)} ${String(m.price ?? "—").padStart(12)}  ${m.open ? "" : "closed  "}${m.name !== m.symbol ? m.name : ""}`);
} else if (cmd === "order" && (from === "buy" || from === "sell")) {
  // order <venue> <buy|sell> <symbol> <qty | $usd> [limit price] [stop=<price>] [tif=gtc|ioc|fok|day] [post] [reduce]
  const [venue, side, symbol, size] = [kind, from, to, amount];
  const rest = process.argv.slice(7);
  const opt = (k: string) => rest.find((x) => x.startsWith(`${k}=`))?.slice(k.length + 1);
  const limit = rest.find((x) => /^\d/.test(x)) ?? "";
  const stop = opt("stop") ?? "";
  const usd = size.startsWith("$");
  const orderType = stop ? (limit ? "stop_limit" : "stop") : limit ? "limit" : "market";
  say(await send({ type: "agentLiveOrder", venue, symbol, side, orderType, qty: usd ? "" : size, usd: usd ? size.slice(1) : "", limitPrice: limit, ...(stop ? { stopPrice: stop } : {}), ...(opt("tif") ? { tif: opt("tif") } : {}), ...(rest.includes("post") ? { postOnly: "true" } : {}), ...(rest.includes("reduce") ? { reduceOnly: "true" } : {}) }));
} else if (cmd === "amend") {
  // amend <venue> <order> [qty=…] [limit=…] [stop=…]
  const rest = process.argv.slice(5);
  const opt = (k: string) => rest.find((x) => x.startsWith(`${k}=`))?.slice(k.length + 1) ?? "";
  say(await send({ type: "agentLiveAmend", venue: kind, order: from, qty: opt("qty"), limitPrice: opt("limit"), stopPrice: opt("stop") }));
} else if (cmd === "positions") {
  const r = (await (await fetch(`${BASE}/api/account/positions?${new URLSearchParams({ venue: kind })}`)).json()) as { ok: boolean; positions?: Array<{ symbol: string; side: string; qty: number; usd?: number; unrealizedUsd?: number; leverage?: number }>; refusal?: { code: string; message: string } };
  if (!r.ok) console.log(`✗ ${r.refusal?.code} · ${r.refusal?.message}`);
  else for (const p of r.positions ?? []) console.log(`${p.symbol.padEnd(24)} ${p.side.padEnd(5)} ${String(p.qty).padStart(12)}  ${p.usd !== undefined ? `$${p.usd.toFixed(2)}` : ""}${p.unrealizedUsd !== undefined ? ` (${p.unrealizedUsd >= 0 ? "+" : ""}${p.unrealizedUsd.toFixed(2)})` : ""}${p.leverage ? ` ${p.leverage}x` : ""}`);
} else if (cmd === "close") {
  // close <venue> <symbol> [qty]: never counted — it only shrinks what is held; a card in Conservative, and in Aggressive above the per-order limit
  say(await send({ type: "agentLiveClose", venue: kind, symbol: from, qty: to }));
} else if (cmd === "pay") {
  // pay <https url> <max dollars> <agent wallet>: the account asks the payee, and pays x402 or an MPP charge in USDC from the agent wallet
  say(await send({ type: "agentPay", url: kind, maxAmount: from, fromSubAccount: to }));
} else if (cmd === "cancel") {
  say(await send({ type: "agentLiveCancel", venue: kind, order: from }));
} else if (cmd === "move" && kind === "bridge") {
  // bridge <from wallet> <to: the same wallet or another place of the user's> <usd> [asset] <from chain> <to chain>
  say(await send({ type: "agentLiveMove", kind, from, fromLedger: "", to: to || from, toLedger: g, asset: e || "USDC", toAsset: e || "USDC", network: f, amount, maxFee: "0" }));
} else if (cmd === "move" && ["withdraw", "send", "transfer", "swap"].includes(kind)) {
  // withdraw: from an exchange · send: from a wallet · transfer: between an exchange's own ledgers · swap: one stablecoin for another there.
  // The account asks the destination for its address and the venue for its fee: the card the owner signs shows both
  const inside = kind === "transfer" || kind === "swap";
  say(await send({ type: "agentLiveMove", kind, from, fromLedger: kind === "transfer" ? f : "", to: inside ? from : to, toLedger: kind === "transfer" ? g : "", asset: e || "USDC", toAsset: kind === "swap" ? f || "USDC" : e || "USDC", network: inside ? "" : f, amount, maxFee: "0" }));
} else {
  console.log("usage: whoami · markets <venue> [query] · order <venue> buy|sell <symbol> <qty|$usd> [limit] [stop=…] [tif=…] [post] [reduce] · amend <venue> <order> [qty=…] [limit=…] [stop=…] · positions <venue> · close <venue> <symbol> [qty] · pay <url> <max $> <agent wallet> · cancel <venue> <order> · move bridge <wallet> <to> <usd> [asset] <fromChain> <toChain> · move withdraw|send <from> <to> <usd> [asset] [network] · move transfer <venue> <venue> <usd> [asset] <fromLedger> <toLedger> · move swap <venue> <venue> <usd> <sell> <buy>");
}
