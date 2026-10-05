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
 *   npx tsx examples/account/agent-seat.ts cancel okx ord-0001                     # take an order of this seat's off the book
 *   npx tsx examples/account/agent-seat.ts move withdraw okx wallet 5 USDC Arbitrum   # from an exchange to another place of the user's
 *   npx tsx examples/account/agent-seat.ts move transfer okx okx 5 USDT funding trading   # between an exchange's own ledgers
 *   npx tsx examples/account/agent-seat.ts move swap okx okx 5 USDT USDC              # one stablecoin for another there
 *
 * The rules an agent meets in the simulated account — routes between venues, floats, paying an API (x402, MPP, AP2) — are walked through
 * in-process by examples/account/headless.ts. PORTFOLIO_URL overrides http://127.0.0.1:4820. PORTFOLIO_AGENT names the seat (default
 * "example-seat"): the seat's key is derived from that name, so it is PUBLIC. A real seat makes its own key and keeps it in the operating
 * system's key store. The seat never holds a venue credential: it signs a request, and the account does the rest. */
import { signAgent, simKey, type AgentAction } from "../../src/portfolio/account/sign.ts";

const BASE = process.env.PORTFOLIO_URL ?? "http://127.0.0.1:4820";
const NAME = process.env.PORTFOLIO_AGENT ?? "example-seat";
const key = simKey(`agent:${NAME.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`);
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
  // order <venue> <buy|sell> <symbol> <qty | $usd> [limit price]
  const [venue, side, symbol, size] = [kind, from, to, amount];
  const usd = size.startsWith("$");
  say(await send({ type: "agentLiveOrder", venue, symbol, side, orderType: e ? "limit" : "market", qty: usd ? "" : size, usd: usd ? size.slice(1) : "", limitPrice: e }));
} else if (cmd === "cancel") {
  say(await send({ type: "agentLiveCancel", venue: kind, order: from }));
} else if (cmd === "move" && ["withdraw", "send", "transfer", "swap"].includes(kind)) {
  // withdraw: from an exchange · send: from a wallet · transfer: between an exchange's own ledgers · swap: one stablecoin for another there.
  // The account asks the destination for its address and the venue for its fee: the card the owner signs shows both
  const inside = kind === "transfer" || kind === "swap";
  say(await send({ type: "agentLiveMove", kind, from, fromLedger: kind === "transfer" ? f : "", to: inside ? from : to, toLedger: kind === "transfer" ? g : "", asset: e || "USDC", toAsset: kind === "swap" ? f || "USDC" : e || "USDC", network: inside ? "" : f, amount, maxFee: "0" }));
} else {
  console.log("usage: whoami · markets <venue> [query] · order <venue> buy|sell <symbol> <qty|$usd> [limit] · cancel <venue> <order> · move withdraw|send <from> <to> <usd> [asset] [network] · move transfer <venue> <venue> <usd> [asset] <fromLedger> <toLedger> · move swap <venue> <venue> <usd> <sell> <buy>");
}
