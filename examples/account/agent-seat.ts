/** An agent seat in one file: it holds a key, signs ONE instruction, and posts it to the account's door (POST /api/exchange).
 * Everything an agent can ask of the account is here: move money between the user's own venues, swap a stablecoin, pay for a URL.
 *
 *   npm run portfolio                                                              # the service, in another terminal
 *   npx tsx examples/account/agent-seat.ts whoami                                  # this seat's key; knocks if the owner has not authorised it
 *   npx tsx examples/account/agent-seat.ts transfer okx hyperliquid 300            # between the user's own venues
 *   npx tsx examples/account/agent-seat.ts swap okx USDT USDC 200
 *   npx tsx examples/account/agent-seat.ts pay "https://data.sim/v1/quote?symbol=NVDA" 0.05 research     # x402, from the float "research"
 *   npx tsx examples/account/agent-seat.ts pay https://infer.sim/v1/stream 0.05 research                # MPP session: a deposit, then vouchers
 *   npx tsx examples/account/agent-seat.ts pay https://infer.sim/v1/stream 0.05 research close          # close it: the rest comes back
 *   npx tsx examples/account/agent-seat.ts pay https://shop.sim/items/desk-feed-pro 30 card             # ACP, by the user's card
 *   npx tsx examples/account/agent-seat.ts pay https://shop.sim/items/desk-feed-pro 30 research         # AP2, mandates signed by this seat
 *
 * PORTFOLIO_URL overrides http://127.0.0.1:4820. PORTFOLIO_AGENT names the seat (default "example-seat"): like every key in this
 * simulation the seat's key is derived from that name, so it is PUBLIC. A real seat makes its own key and keeps it in the operating
 * system's key store. The seat never holds a venue credential or a float's key: it signs a request, and the account does the rest. */
import { ap2Answer, type Ap2Needs } from "../../src/portfolio/account/protocols.ts";
import { signAgent, simKey, type AgentAction } from "../../src/portfolio/account/sign.ts";

const BASE = process.env.PORTFOLIO_URL ?? "http://127.0.0.1:4820";
const NAME = process.env.PORTFOLIO_AGENT ?? "example-seat";
const key = simKey(`agent:${NAME.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`);
const [cmd, a = "", b = "", c = "", d = ""] = process.argv.slice(2);

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
  else if (x.kind === "card") console.log(`${r.status} ▣ ${x.card.id} waits for the owner · ${x.card.reason}`);
  else if (x.kind === "payment") console.log(`${r.status} ✓ ${x.payment.id} · ${x.payment.kind} ${x.payment.from} → ${x.payment.to} · $${x.payment.amountUsd} · ${x.payment.status}${x.payment.note ? ` · ${x.payment.note}` : ""}${x.data !== undefined ? ` · bought: ${JSON.stringify(x.data).slice(0, 160)}` : ""}`);
  else console.log(`${r.status} ${JSON.stringify(x).slice(0, 300)}`);
}

if (cmd === "whoami") {
  const account = (await (await fetch(`${BASE}/api/account`)).json()) as { keys: Array<{ address: string; name: string; status: string; validUntil: string }>; spend: Array<{ agent: string; scope: string; allow: string[]; perPaymentUsd: number; budgetUsd: number; spentUsd: number; reservedUsd: number }>; subAccounts: Array<{ agent: string; name: string; balanceUsd: number; capUsd: number }> };
  const mine = account.keys.find((k) => k.address === key.address);
  console.log(`seat "${NAME}" · key ${key.address}`);
  if (mine?.status === "ok") {
    console.log(`authorised as "${mine.name}" until ${mine.validUntil}`);
    for (const s of account.spend.filter((x) => x.agent === key.address)) console.log(`  may ${s.scope === "venues" ? "move between" : "pay"} ${s.allow.join(", ")} · $${s.perPaymentUsd} a payment · $${(s.budgetUsd - s.spentUsd - s.reservedUsd).toFixed(2)} left of $${s.budgetUsd}`);
    for (const f of account.subAccounts.filter((x) => x.agent === key.address)) console.log(`  float "${f.name}" holds $${f.balanceUsd} of $${f.capUsd}`);
  } else if (mine?.status === "revoked") {
    console.log("this key was revoked, and a revoked key is never authorised again: the seat needs a new key (here: another PORTFOLIO_AGENT name)");
  } else {
    // knock: a signed request from a key the account does not know is refused, and the owner sees the key under "Asking to be let in"
    say(await send({ type: "agentSendAsset", destination: "self", sourceDex: "metamask", destinationDex: "metamask", token: "USDC", amount: "1", fromSubAccount: "", maxFee: "0" }));
    console.log(`not authorised${mine ? ` (${mine.status})` : ""}: the owner opens ${BASE}/account → Agent keys → "Authorize…"`);
  }
} else if (cmd === "transfer") {
  // `from` and `to` are the user's own venues (okx, hyperliquid:perps, metamask, sub:<float>): an agent key cannot name an outside address
  say(await send({ type: "agentSendAsset", destination: "self", sourceDex: a, destinationDex: b, token: "USDC", amount: c, fromSubAccount: "", maxFee: d || "5" }));
} else if (cmd === "swap") {
  say(await send({ type: "agentSwap", venue: a, sell: b, buy: c, amount: d, minReceive: String(Math.floor(Number(d) * 99) / 100) }));
} else if (cmd === "pay") {
  // the seat says what it wants paid and the most it may cost; the ACCOUNT asks the payee and speaks whatever protocol the payee does
  const base = { type: "agentPay" as const, url: a, maxAmount: b, fromSubAccount: c === "card" ? "" : c };
  const first = await send({ ...base, ...(d === "close" ? { close: true } : c === "card" ? {} : { cnf: key.jwk }) });
  const needs = first.body.result as Ap2Needs | undefined;
  if (needs?.needs === "mandates") {
    // AP2: the merchant wants this seat's own signature on "this checkout" and "this payment"; the seat signs with its key, then asks again
    console.log(`the merchant asks for mandates on checkout ${needs.checkout.id} (${needs.checkout.total.amount / 100} ${needs.checkout.total.currency}): signing with the seat's key`);
    say(await send({ ...base, mandates: ap2Answer(key.p256, needs, Math.floor((await now()) / 1000)) }));
  } else say(first);
} else {
  console.log("usage: whoami · transfer <from> <to> <usd> [maxFee] · swap <venue> <sell> <buy> <amount> · pay <url> <maxUsd> <float|card> [close]");
}
