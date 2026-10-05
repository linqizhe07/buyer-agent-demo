/** The whole account in one script, with no server and no browser: the owner signs, an agent signs, time passes.
 * Every line that changes anything is ONE signed instruction through `svc.exchange(...)` — copy the ones you need.
 *
 *   npx tsx examples/account/headless.ts
 *
 * The clock is simulated (it moves only when the script says so), the venues and the payees are in-process, the home is a temporary
 * directory. The owner here is a wallet key made from a label, as in the tests; on the page the owner is the browser's device key. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRefusal } from "../../src/core/errors.ts";
import { cardHash, type Outcome } from "../../src/portfolio/account/exchange.ts";
import { signAgent, signOwner, simKey, type AgentAction, type OwnerAction } from "../../src/portfolio/account/sign.ts";
import { loadOpenness, PortfolioService } from "../../src/portfolio/service.ts";

const MIN = 60_000;
const DAY = 86_400_000;
let ms = Date.UTC(2026, 9, 5, 14, 0, 0); // Monday 5 October 2026, 10:00 in New York
const now = () => new Date(ms).toISOString();

const owner = simKey("owner");
const agent = simKey("agent:example-seat");

const svc = await PortfolioService.create({
  home: mkdtempSync(join(tmpdir(), "account-example-")),
  now,
  venues: "frontline", // the ten venues, with the account layer on top
  freshLedger: true,
  openness: { ...(loadOpenness() as object), sessionExpiresAt: new Date(ms + 30 * DAY).toISOString() },
  account: { owners: [{ id: owner.address, kind: "eoa", label: "owner", addedAt: now() }] },
});
const account = svc.account!;

// ---- signing: an owner action is typed data a person can read; an agent's request is one type under a key the owner authorised ----
type Unsigned<T> = T extends unknown ? Omit<T, "nonce"> : never;
let n = 0;
const nonce = () => ms + ++n; // the account's clock, in milliseconds
const own = async (a: Unsigned<OwnerAction>): Promise<Outcome> => svc.exchange(await signOwner(owner, { ...a, nonce: nonce() } as OwnerAction));
const ask = async (a: Unsigned<AgentAction>): Promise<Outcome> => svc.exchange(await signAgent(agent, { ...a, nonce: nonce() } as AgentAction));
/** time passes, and whatever was in flight and is due lands */
const pass = async (millis: number) => {
  ms += millis;
  await account.settle();
};
/** the owner moves money the way the page does: ask for the route first, then sign its hash, its fee and its latest arrival */
const move = async (sourceDex: string, destinationDex: string, amount: string): Promise<Outcome> => {
  const fields = { destination: "self", sourceDex, destinationDex, token: "USDC", amount };
  const planned = await account.resolve(fields, "owner");
  if (isRefusal(planned)) return planned;
  return own({ type: "sendAsset", ...fields, fromSubAccount: "", route: planned.route.hash, maxFee: String(planned.route.feeUsd), deadline: planned.route.arrivalMs + MIN });
};
/** the owner's yes to a card: a signature over the card AND the hash of what it will release */
const approve = (o: Outcome): Promise<Outcome> => (!isRefusal(o) && o.kind === "card" ? own({ type: "approveCard", card: o.card.id, action: cardHash(o.card), decision: "approve" }) : Promise.resolve(o));
const pay = (url: string, maxAmount: string, fromSubAccount: string, close = false) => ask({ type: "agentPay", url, maxAmount, fromSubAccount, ...(close ? { close: true } : {}) });

const show = (what: string, o: Outcome): Outcome => {
  const line = isRefusal(o) ? `✗ ${o.code} · ${o.message}` : o.kind === "card" ? `▣ ${o.card.id} waits for the owner · ${o.card.reason}` : o.kind === "payment" ? `✓ ${o.payment.id} · ${o.payment.from} → ${o.payment.to} · $${o.payment.amountUsd} · ${o.payment.status}${o.payment.note ? ` · ${o.payment.note}` : ""}` : o.kind === "account" ? `✓ ${o.summary}` : o.kind === "order" ? `✓ ${o.order.id} · ${o.order.side} ${o.order.qty} ${o.order.symbol} · ${o.order.status}` : `✓ ${JSON.stringify(o.result).slice(0, 120)}`;
  console.log(`${what.padEnd(34)} ${line}`);
  return o;
};
const float = () => (account.sub("research")?.balanceMicro ?? 0) / 1e6;

console.log("\n1 · the owner plugs in an exchange wallet and lets an agent in");
show("plug in Kraken", await own({ type: "connectVenue", venue: "kraken", connector: "unified", label: "", credentialRef: "" }));
show("authorise the agent's key", await own({ type: "approveAgent", agentAddress: agent.address, agentName: "Example seat", validUntil: ms + 30 * DAY }));
show("it may move between these venues", await own({ type: "approveSpend", agent: agent.address, scope: "venues", allow: "kraken,hyperliquid,metamask", perPayment: "500", budget: "2000", windowHours: 0, validUntil: ms + 7 * DAY }));
show("it may pay these payees", await own({ type: "approveSpend", agent: agent.address, scope: "payees", allow: "data.sim,infer.sim", perPayment: "1", budget: "10", windowHours: 0, validUntil: ms + 7 * DAY }));
show("a float for it", await own({ type: "createSubAccount", name: "research", agent: agent.address, float: "200" }));
show("fill the float with $50", await move("metamask", "sub:research", "50"));
await pass(MIN);

console.log("\n2 · the agent moves money, and only between the user's own venues");
const home = show("Kraken → Hyperliquid, $300", await ask({ type: "agentSendAsset", destination: "self", sourceDex: "kraken", destinationDex: "hyperliquid", token: "USDC", amount: "300", fromSubAccount: "", maxFee: "5" }));
await pass(10 * MIN);
if (!isRefusal(home) && home.kind === "payment") console.log(`${"ten minutes later".padEnd(34)} ${home.payment.id} is ${home.payment.status}: $${home.payment.receiveUsd} arrived, the fee was $${home.payment.feeUsd}`);
show("to an address outside", await ask({ type: "agentSendAsset", destination: "0x7a11000000000000000000000000000000000001", sourceDex: "metamask", destinationDex: "Base", token: "USDC", amount: "50", fromSubAccount: "", maxFee: "5" }));
show("out of Hyperliquid", await ask({ type: "agentSendAsset", destination: "self", sourceDex: "hyperliquid", destinationDex: "metamask", token: "USDC", amount: "50", fromSubAccount: "", maxFee: "5" }));
show("above the per-payment maximum", await ask({ type: "agentSendAsset", destination: "self", sourceDex: "kraken", destinationDex: "hyperliquid", token: "USDC", amount: "600", fromSubAccount: "", maxFee: "5" }));

console.log("\n3 · the agent pays an API (x402): the first payment to a payee is the owner's to approve");
const QUOTE = "https://data.sim/v1/quote?symbol=NVDA";
const first = show("first call to data.sim", await pay(QUOTE, "0.05", "research"));
show("the owner approves the card", await approve(first));
show("the next call asks nobody", await pay(QUOTE, "0.05", "research"));
show("a payee that is not named", await pay("https://other.sim/v1/anything", "0.05", "research"));

console.log("\n4 · a metered service (MPP session): one deposit, then a voucher per call");
const STREAM = "https://infer.sim/v1/stream";
show("the owner approves the deposit", await approve(show("first call to infer.sim", await pay(STREAM, "0.05", "research"))));
show("second call", await pay(STREAM, "0.05", "research"));
console.log(`${"while it is open".padEnd(34)} the float holds $${float().toFixed(2)}; the deposit is in the escrow`);
show("close it", await pay(STREAM, "0.05", "research", true));
console.log(`${"after closing".padEnd(34)} the float holds $${float().toFixed(2)}`);

console.log("\n5 · the owner takes the float back, and the ledger is the evidence");
show("float → wallet", await move("sub:research", "metamask", float().toFixed(2)));
await pass(MIN);
const chain = svc.verifyChain();
const kinds = new Map<string, number>();
for (const row of svc.rows()) kinds.set(row.kind, (kinds.get(row.kind) ?? 0) + 1);
console.log(`${"ledger".padEnd(34)} chain ${chain.ok ? "verified" : `BROKEN at row ${chain.at}`} · ${chain.rows} rows · ${[...kinds].map(([k, v]) => `${k} ${v}`).join(" · ")}`);
console.log(`${"file".padEnd(34)} ${svc.ledgerPath()}\n`);
