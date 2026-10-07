/** `npm run account:demo` — the ACCOUNT, in fourteen beats. Each beat lets something through and
 * turns something away; ✓ / ✗ / FAIL lines; exit 0 iff no assertion failed. No port is opened; the
 * venues and the payees are in-process simulations; nothing leaves the process. (The Account page
 * shows real accounts only, so this run's simulated state is not served to it.)
 *
 * The account is the airport between a trading agent and the user's money. Its functions are the
 * ones on Hyperliquid's own account pages — deposit, withdraw, transfer, swap, send, account type,
 * sub-accounts, agent keys, fee approvals, signers — opened on EIGHT venues instead of one, and
 * extended with the two things a buyer-side account needs: a spending approval, and an answer to the
 * protocols an agent is asked to pay in (x402, MPP, AP2).
 *
 *   npm run account:demo                     headless
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ledger } from "../agent/ledger.ts";
import { formatRefusal, isRefusal, type Refusal } from "../core/errors.ts";
import { etDate, whenLabel } from "./account/calendar.ts";
import { cardHash, type CardLike, type Outcome } from "./account/exchange.ts";
import * as X from "./account/protocols.ts";
import { hlRecover, hlTypedData, signAgent, signerOf, signOwner, simKey, ZERO, type Action, type AgentAction, type AnySig, type Hex, type OwnerAction, type SimKey } from "./account/sign.ts";
import { demoHome } from "./home.ts";
import { loadOpenness, PortfolioService } from "./service.ts";

const argv = process.argv.slice(2);
const value = (f: string) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};

/** a simulated clock, a week after the portfolio demo's: Saturday 10 October 2026, 10:00 in New York */
let ms = Date.UTC(2026, 9, 10, 14, 0, 0);
const now = () => new Date(ms).toISOString();
const MIN = 60_000;
const DAY = 86_400_000;

const failures: string[] = [];
const heading = (t: string) => console.log(`\n==== ${t}`);
const note = (l: string) => console.log(`  ${l}`);
const check = (cond: boolean, what: string, layer?: string): boolean => {
  if (cond) console.log(`✓ ${layer ? `[${layer}] ` : ""}${what}`);
  else {
    console.log(`FAIL ${what}`);
    failures.push(what);
  }
  return cond;
};
const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: n !== 0 && Math.abs(n) < 0.01 ? 6 : 2 })}`;
const code = (o: Outcome): string => (isRefusal(o) ? o.code : o.kind);
const show = (o: Outcome): Outcome => {
  if (isRefusal(o)) console.log(`  ${formatRefusal(o)}`);
  else if (o.kind === "payment") console.log(`  ✓ ${o.payment.id} · ${o.payment.kind} · ${o.payment.from} → ${o.payment.external?.label ?? o.payment.to} · ${usd(o.payment.amountUsd)}${o.payment.feeUsd ? ` · fee ${usd(o.payment.feeUsd)}` : ""} · ${o.payment.status}${o.payment.status === "pending" && o.payment.heldUsd === undefined ? `, lands ${whenLabel(ms, Date.parse(o.payment.settlesAt))}` : ""}${o.payment.note ? ` · ${o.payment.note}` : ""}`);
  else if (o.kind === "card") console.log(`  ▣ ${o.card.id} · ${usd(o.card.usd)} · ${o.card.reason}`);
  else if (o.kind === "account") console.log(`  ✓ ${o.summary}`);
  return o;
};
const refused = (o: Outcome, want: string): Refusal | undefined => (isRefusal(o) && o.code === want ? o : undefined);
const short = (a: string) => `${a.slice(0, 8)}…${a.slice(-4)}`;

export const PROVEN = [
  "eight venues the user already has — a stock broker, two exchanges, Hyperliquid, the on-chain wallet, two prediction markets, an RWA fund — each with its own doors: how money gets in, how it gets out, how long that takes, and who may start it (the agent's key, only the owner, only at the venue itself, nobody)",
  "every instruction is signed, the way Hyperliquid's are: an owner action is typed data a person can read; an agent's request is one type under an agent key the owner authorised, with an expiry and a revocation that sticks. The same encoder recovers Hyperliquid's own SDK test signature",
  "one instruction runs once: the same envelope again is the first answer; a used nonce, a stale money instruction, a changed envelope are refused",
  "an agent key moves money only between the user's own venues, through doors that admit an agent: not to an address, not out of Hyperliquid, not past a key that cannot withdraw, not into or out of the broker",
  "money in flight is in no balance: each leg lands when its rail says, a chain leg in seconds to minutes, and the account says how much is on its way",
  "a spending approval is a line many small payments cannot add up past: per payment, in all, which venues or payees, until when; a waiting card holds its share of the budget",
  "a card is answered with the owner's signature over the card and the hash of what it releases; an agent cannot answer its own; an answer is judged again; a card expires",
  "someone else is paid only at an address the owner put in the book, on the chain it was added for, a day after it was added",
  "a float is the most a mistake can cost: a sub-account per agent, filled from the wallet up to its cap; Unified lets the agent leave the source to the account, along routes the owner approved",
  "a venue the user already has is plugged in with one owner signature and no code: an exchange wallet by a credential reference, through its own API where the account has its profile and through the unified library otherwise; a self-custody wallet by its address. Its doors are compiled from what the venue says the credential may do, and it is in no spending approval until the owner names it",
  "paying an API: the account asks the payee itself and speaks its protocol (x402, MPP charge, MPP session with an escrow and vouchers). Nothing is sent to a host the owner did not name; the first payment is a card that shows the receiving address, and approving pins it; a changed address, a higher price, a redirect, an unknown escrow contract are refusals",
  "a metered session locks a deposit once and spends from it by signed vouchers; closing sends the rest home, and a payee that goes silent cannot keep it: the escrow returns it after a grace period",
  "buying something from a float under AP2: open mandates issued from the owner's approval, closed mandates signed by the agent's own key, receipts signed by the merchant and its processor",
  "an app's fee rides on a payment only inside the rate the owner approved for that app",
  "the ledger is evidence: every accepted instruction is a row with its signed envelope, the signatures recover from the file, a changed row breaks the chain, and the account's payments are compared with the venues' own statements",
];
export const NOT_PROVEN = [
  "every venue and every payee is a local simulation. Each leg's request is built in its venue's own format. Signed for real: the account's own instructions (EIP-712), the exchanges' REST calls (HMAC, with a simulated secret), EIP-3009 authorisations, MPP vouchers and a session's opening transaction, AP2 mandates and receipts (ES256). Built and left unsigned: Hyperliquid's own actions and the CCTP burn — they need keys the account does not hold. None of it was sent to the real thing: there is no interoperability test here",
  "fees, minimums and arrival times are the documented ones where a document gives them (read 2026-10-04) and illustrative where it does not; none is a measurement",
  "a plugged-in exchange shows what the exchange says its key may do; through the unified library there is no single call that returns that, so a real connector learns it from the exchange's own endpoint where one exists and from the first refusal where none does. What is plugged in is the wallet (balances, ways in and out, a stablecoin swap), not order routing",
  "the keys are derived from labels in the source: they are public. The demo shows the checks, it does not keep a secret. On the page the owner's key is a real device key the browser will not export — and the first browser to open the page becomes the owner",
  "a float is still a hot key the account holds: what bounds it is its size. Nothing here is enforced by a chain or by a venue on the account's behalf, except the escrow's cap on a session",
  "the broker's cash moves only at the broker, by an ACH with the holder's own bank: the account cannot start it, and opening that runway takes a broker-partner relationship, not code. No bank and no card is on the account: a bank needs an aggregator's production access, and a card has no interface an individual can hand an agent",
  "an address the owner approves on a card is trusted because the owner looked at it: nothing here says whose address it is. No sanctions screening, no Travel Rule, no KYC of a payee",
  "one person holding all eight accounts, in one region, with all of them reachable, is an assumption: a venue's own region rules are the venue's and are not modelled beyond a door that is closed",
  "custody, licences and who pays when something goes wrong are not software and are not here",
];

async function main(): Promise<number> {
  const home = value("--home") ?? demoHome("account-demo-");
  const owner = simKey("owner");
  const cc = simKey("agent:claude-code");
  const codex = simKey("agent:codex");
  // the fixture's agent session ends on a fixed date: this run gets one that outlasts it
  const svc = await PortfolioService.create({ home, now, venues: "frontline", freshLedger: true, openness: { ...(loadOpenness() as object), sessionExpiresAt: "2026-11-30T00:00:00Z" }, account: { owners: [{ id: owner.address, kind: "eoa", label: "owner", addedAt: now() }] } });
  const engine = svc.account!;
  const world = svc.payees!;

  let n = 0;
  const nonce = () => ms + ++n;
  type NoNonce<T> = T extends unknown ? Omit<T, "nonce"> : never;
  const own = async (a: NoNonce<OwnerAction>, by: SimKey = owner) => svc.exchange(await signOwner(by, { ...a, nonce: nonce() } as OwnerAction));
  const ag = async (key: SimKey, a: NoNonce<AgentAction>) => svc.exchange(await signAgent(key, { ...a, nonce: nonce() } as AgentAction));
  const pass = async (millis: number) => {
    ms += millis;
    await engine.settle();
  };
  /** the owner signs a movement the way the page does: ask for the route, then sign its hash, its fee and its latest arrival */
  const send = async (a: { destination?: string; sourceDex: string; destinationDex: string; token?: string; amount: string }, over: Partial<{ route: Hex }> = {}) => {
    const base = { destination: a.destination ?? "self", sourceDex: a.sourceDex, destinationDex: a.destinationDex, token: a.token ?? "USDC", amount: a.amount };
    const r = await engine.resolve(base, "owner");
    if (isRefusal(r)) return r;
    return own({ type: "sendAsset", ...base, fromSubAccount: "", route: r.route.hash, maxFee: String(r.route.feeUsd), deadline: r.route.arrivalMs + MIN, ...over });
  };
  const transfer = (key: SimKey, sourceDex: string, destinationDex: string, amount: string, over: Partial<{ destination: string; token: string; maxFee: string }> = {}) => ag(key, { type: "agentSendAsset", destination: "self", sourceDex, destinationDex, token: "USDC", amount, fromSubAccount: "", maxFee: "5", ...over });
  type PayExtra = Partial<Pick<Extract<AgentAction, { type: "agentPay" }>, "builder" | "cnf" | "mandates" | "close">>;
  const pay = (url: string, maxAmount: string, from = "research", extra: PayExtra = {}, key: SimKey = cc) => ag(key, { type: "agentPay", url, maxAmount, fromSubAccount: from, ...extra });
  const answer = (card: CardLike, decision = "approve", by: SimKey = owner) => own({ type: "approveCard", card: card.id, action: cardHash(card), decision }, by);
  /** pay; when the account asks the owner first, show the card and approve it */
  const payOk = async (url: string, maxAmount: string, from = "research", extra: PayExtra = {}) => {
    const r = await pay(url, maxAmount, from, extra);
    if (isRefusal(r) || r.kind !== "card") return r;
    show(r);
    return answer(r.card);
  };
  const held = async (id: string, asset: string, where?: string) => (await svc.read(id)).filter((h) => h.asset === asset && !h.inTransit && (where === undefined || h.note === where || h.note?.startsWith(where))).reduce((s, h) => s + h.amount, 0);
  const float = () => (engine.sub("research")?.balanceMicro ?? 0) / 1e6;
  const spend = (scope: "venues" | "payees", key: SimKey = cc) => engine.state.spends.find((s) => s.scope === scope && s.agent === key.address && s.revokedAt === undefined)!;
  const lastPaid = () => svc.rows().filter((r) => r.kind === "action" && r.tool === "agentPay" && r.outcome === "accepted").at(-1)!;

  heading("Setup");
  note(`home ${home} · ledger ${svc.ledgerPath()}`);
  note(`sim clock ${now()} (${etDate(ms)}, a Saturday in New York) · eight venues and three payees, all local simulations`);
  note(`keys derived from labels, public by construction: owner ${short(owner.address)} · agent "Claude Code" ${short(cc.address)} · agent "Codex" ${short(codex.address)}`);

  try {
    // ---- 1 ------------------------------------------------------------------------
    heading("Beat 1: The airport · eight venues, each with its doors");
    const v1 = await engine.view();
    for (const v of v1.venues) note(`${v.name.padEnd(26)} ${v.frontLine.padEnd(18)} ${usd(v.usd).padStart(11)}   in: ${`${v.in.text} [${v.in.access}]`.padEnd(36)} out: ${v.out.text} [${v.out.access}]`);
    const door = (id: string) => v1.venues.find((v) => v.id === id)!;
    check(v1.venues.length === 8 && v1.totalUsd > 0, `8 venues on one account · ${usd(v1.totalUsd)} in all · account type ${v1.type}`, "account");
    check(door("alpaca").in.access === "venue" && door("alpaca").out.access === "venue", "the broker's cash moves only at the broker: the account can watch that runway, not start it", "doors");
    check(door("binance").out.access === "venue" && door("hyperliquid").out.access === "owner" && door("okx").out.access === "agent", "three exchanges, three different ways out: only at Binance itself (this key cannot withdraw) · only the owner's signature (Hyperliquid) · the agent's key, to a whitelisted address (OKX)", "doors");
    const unsigned = await svc.exchange({ action: { type: "agentSendAsset", destination: "self", sourceDex: "okx", destinationDex: "hyperliquid", token: "USDC", amount: "100", fromSubAccount: "", maxFee: "5", nonce: ms }, nonce: ms, signature: { r: `0x${"00".repeat(32)}`, s: `0x${"00".repeat(32)}`, v: 27 } });
    show(unsigned);
    check(!!refused(unsigned, "E_ACCOUNT_BAD_SIGNATURE"), "an instruction with no real signature gets nowhere: E_ACCOUNT_BAD_SIGNATURE", "door");

    // ---- 2 ------------------------------------------------------------------------
    heading("Beat 2: Keys · who may sign, until when, and never again");
    const stranger = show(await transfer(cc, "okx", "hyperliquid", "100"));
    check(!!refused(stranger, "E_ACCOUNT_UNKNOWN_SIGNER") && engine.state.requests.some((r) => r.address === cc.address), "a key nobody authorised is refused, and remembered so the owner can be asked: E_ACCOUNT_UNKNOWN_SIGNER", "keys");
    check(code(show(await own({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: ms + 30 * DAY }))) === "account", "the owner authorises it: a name, an address, an expiry (an explicit field, not hidden in the name)", "keys");
    const self = show(await own({ type: "approveSpend", agent: cc.address, scope: "venues", allow: "*", perPayment: "1000000", budget: "1000000", windowHours: 0, validUntil: ms + DAY }, cc));
    check(!!refused(self, "E_ACCOUNT_OWNER_ONLY"), "an agent key cannot sign what is the owner's — not even its own spending approval: E_ACCOUNT_OWNER_ONLY", "keys");
    await own({ type: "approveAgent", agentAddress: codex.address, agentName: "Codex", validUntil: ms + MIN });
    await pass(2 * MIN);
    check(!!refused(show(await transfer(codex, "okx", "hyperliquid", "100")), "E_ACCOUNT_AGENT_EXPIRED"), "a key stops on its date: E_ACCOUNT_AGENT_EXPIRED", "keys");
    await own({ type: "approveAgent", agentAddress: codex.address, agentName: "Codex", validUntil: ms + 30 * DAY });
    await own({ type: "approveAgent", agentAddress: ZERO, agentName: "Codex", validUntil: 0 });
    check(!!refused(show(await transfer(codex, "okx", "hyperliquid", "100")), "E_ACCOUNT_AGENT_REVOKED"), "revoked the way Hyperliquid revokes (the zero address under the same name): E_ACCOUNT_AGENT_REVOKED", "keys");
    const back = show(await own({ type: "approveAgent", agentAddress: codex.address, agentName: "Codex", validUntil: ms + 30 * DAY }));
    check(!!refused(back, "E_ACCOUNT_LIMIT"), "and a revoked key is never authorised again — Hyperliquid drops a revoked key's nonces, so there an old signed action can come back; here it cannot", "keys");
    // conformance: Hyperliquid's own SDK test vector (tests/signing_test.py, Testnet), recovered by this encoder. Only the signature and the address are here
    const sdk = await hlRecover(hlTypedData("HyperliquidTransaction:UsdSend", "0x66eee", { hyperliquidChain: "Testnet", destination: "0x5e9ee1089755c3435139848e47e6635505d5a13a", amount: "1", time: 1687816341423 }), { r: "0x637b37dd731507cdd24f46532ca8ba6eec616952c56218baeff04144e4a77073", s: "0x11a6a24900e6e314136d2592e2f8d502cd89b7c15b198e1bee043c9589f9fad7", v: 27 });
    check(sdk === "0x14791697260e4c9a71f18484c9f997b308e59325", "the encoder is Hyperliquid's: the signature in its SDK's own test recovers to the SDK's test address", "conformance");

    // ---- 3 ------------------------------------------------------------------------
    heading("Beat 3: One instruction, once");
    check(!!refused(show(await transfer(cc, "okx", "hyperliquid", "500")), "E_MANDATE_NONE"), "an authorised key with no spending approval moves nothing: E_MANDATE_NONE", "approval");
    show(await own({ type: "approveSpend", agent: cc.address, scope: "venues", allow: "okx,metamask,hyperliquid", perPayment: "600", budget: "1000", windowHours: 0, validUntil: ms + 30 * DAY }));
    const envelope = await signAgent(cc, { type: "agentSendAsset", destination: "self", sourceDex: "okx", destinationDex: "hyperliquid", token: "USDC", amount: "500", fromSubAccount: "", maxFee: "5", nonce: nonce() });
    const first = show(await svc.exchange(envelope));
    const again = await svc.exchange(envelope);
    const p3 = !isRefusal(first) && first.kind === "payment" ? first.payment : undefined;
    check(again === first && engine.payments.length === 1, "the same signed envelope sent twice is ONE transfer: the second gets the first answer and nothing runs again", "replay");
    if (p3) {
      note(`route: ${p3.legs.map((l) => `${l.step} at ${l.venue}${l.chain ? ` (${l.chain})` : ""}`).join(" → ")} · fee ${usd(p3.feeUsd)} · ${usd(p3.receiveUsd)} arrives`);
      note(`the leg that is flying carries OKX's own request: ${(p3.legs[1]!.native as { method?: string }).method ?? "POST"} ${(p3.legs[1]!.native as { path?: string }).path ?? ""}, HMAC-signed the way OKX wants it`);
    }
    const reused = await signAgent(cc, { type: "agentSendAsset", destination: "self", sourceDex: "okx", destinationDex: "hyperliquid", token: "USDC", amount: "50", fromSubAccount: "", maxFee: "5", nonce: envelope.nonce });
    check(!!refused(show(await svc.exchange(reused)), "E_ACCOUNT_NONCE"), "a used nonce under another instruction: E_ACCOUNT_NONCE", "replay");
    const stale = await signAgent(cc, { type: "agentSendAsset", destination: "self", sourceDex: "okx", destinationDex: "hyperliquid", token: "USDC", amount: "50", fromSubAccount: "", maxFee: "5", nonce: ms - 11 * MIN });
    check(!!refused(show(await svc.exchange(stale)), "E_ACCOUNT_EXPIRED"), "a money instruction signed eleven minutes ago: E_ACCOUNT_EXPIRED (Hyperliquid's window is two days; a transfer here is good for ten minutes)", "replay");
    const fresh = await signAgent(cc, { type: "agentSendAsset", destination: "self", sourceDex: "okx", destinationDex: "hyperliquid", token: "USDC", amount: "50", fromSubAccount: "", maxFee: "5", nonce: nonce() });
    const forged = await svc.exchange({ ...fresh, action: { ...fresh.action, amount: "5000" } as Action });
    check(isRefusal(forged) && forged.code === "E_ACCOUNT_UNKNOWN_SIGNER", "an envelope changed after signing is somebody else's signature: E_ACCOUNT_UNKNOWN_SIGNER", "replay");

    // ---- 4 ------------------------------------------------------------------------
    heading("Beat 4: In flight · money that has left is nowhere until it lands");
    const flying = await engine.view();
    note(`OKX USDT ${await held("okx", "USDT")} · Hyperliquid perps USDC ${await held("hyperliquid", "USDC", "perps")} · in flight ${usd(flying.inFlightUsd)}`);
    check((await held("okx", "USDT")) === 2000 && (await held("hyperliquid", "USDC", "perps")) === 1500 && flying.inFlightUsd === 499.95, "$500 left OKX, Hyperliquid has not got it, and the account says so: $499.95 in flight (after the swap fee)", "time");
    await pass(6 * MIN + 20_000);
    check(p3?.status === "settled" && (await held("hyperliquid", "USDC", "perps")) === 1998.93, `six minutes later it has landed: Hyperliquid perps ${await held("hyperliquid", "USDC", "perps")} USDC (500 less $1.07 of fees), each leg at its own time`, "time");
    note(`the last leg is Circle's ${(p3?.legs[3]?.native as { function?: string } | undefined)?.function ?? "?"}, through Circle's forwarder into the Hyperliquid balance — the default deposit route from Arbitrum on 2026-10-04`);

    // ---- 5 ------------------------------------------------------------------------
    heading("Beat 5: Home only · what an agent key can never do");
    const cold = "0x9C0d4E3b7a2f1c8d9e0f1a2b3c4d5e6f7a8b9c0d";
    check(!!refused(show(await transfer(cc, "metamask", "Base", "100", { destination: cold })), "E_ACCOUNT_NOT_HOME"), "to an address — even the user's own cold wallet: E_ACCOUNT_NOT_HOME", "home");
    check(!!refused(show(await transfer(cc, "hyperliquid", "metamask", "100")), "E_ACCOUNT_OWNER_ONLY"), "out of Hyperliquid: E_ACCOUNT_OWNER_ONLY (an API wallet cannot withdraw there either)", "home");
    const closed = show(await transfer(cc, "binance", "hyperliquid", "100"));
    check(!!refused(closed, "E_VENUE_RAIL_CLOSED"), `past a key that cannot withdraw: E_VENUE_RAIL_CLOSED · to open it: ${String((isRefusal(closed) ? (closed.detail as { opens?: string } | undefined)?.opens : "") ?? "").slice(0, 90)}`, "home");
    check(!!refused(show(await transfer(cc, "okx", "hyperliquid", "4")), "E_VENUE_MIN_DEPOSIT"), "under the 5 USDC minimum of Hyperliquid's interface: refused BEFORE it leaves (on its legacy bridge a deposit under the minimum was lost)", "home");
    const out = show(await send({ sourceDex: "hyperliquid", destinationDex: "metamask", amount: "200" }));
    const p5 = !isRefusal(out) && out.kind === "payment" ? out.payment : undefined;
    const hlOut = p5?.legs[0]?.native as { type?: string; signature?: unknown } | undefined;
    check(p5?.authority === "owner" && hlOut?.type === "sendToEvmWithData" && hlOut.signature === null, "the owner signs the withdrawal — the account's own SendAsset, with the route in it. Hyperliquid's sendToEvmWithData for that leg is built and left for the wallet that owns the Hyperliquid account: the account holds no such key", "owner");
    check(!!refused(show(await send({ sourceDex: "hyperliquid", destinationDex: "metamask", amount: "200" }, { route: `0x${"00".repeat(32)}` })), "E_ACCOUNT_REQUOTE"), "the owner's signature covers the exact route: a different route than the one signed is E_ACCOUNT_REQUOTE", "owner");
    await pass(5 * MIN);

    // ---- 6 ------------------------------------------------------------------------
    heading("Beat 6: The stock market · the broker's cash moves only at the broker");
    const fund = show(await send({ sourceDex: "metamask", destinationDex: "alpaca", amount: "100" }));
    check(!!refused(fund, "E_VENUE_RAIL_CLOSED"), "not even the owner can fund the broker from here: its cash moves only by an ACH with your own bank, started at Alpaca, and no bank is on this account", "broker");
    check(!!refused(show(await transfer(cc, "alpaca", "hyperliquid", "100", { token: "USD" })), "E_VENUE_RAIL_CLOSED"), "and an agent cannot take money out of it: no trading key and no OAuth scope moves cash there", "broker");

    // ---- 7 ------------------------------------------------------------------------
    heading("Beat 7: Limits · many small ones cannot pass a line a big one cannot");
    check(code(show(await transfer(cc, "okx", "hyperliquid", "400"))) === "payment", "$400 more is inside the approval ($900 of $1,000 used)", "approval");
    check(!!refused(show(await transfer(cc, "okx", "hyperliquid", "200")), "E_MANDATE_BUDGET"), "$200 more is not: E_MANDATE_BUDGET", "approval");
    check(!!refused(show(await transfer(cc, "okx", "hyperliquid", "700")), "E_MANDATE_PER_ORDER_CAP"), "$700 at once is above the per-payment line: E_MANDATE_PER_ORDER_CAP", "approval");
    check(!!refused(show(await transfer(cc, "okx", "ondo", "100", { maxFee: "10" })), "E_MANDATE_RECIPIENT"), "a venue the approval does not name: E_MANDATE_RECIPIENT", "approval");
    check(!!refused(show(await transfer(cc, "okx", "hyperliquid", "100", { token: "ETH" })), "E_ACCOUNT_UNPRICED"), "an asset with no price here cannot be judged against a limit, so it is refused: E_ACCOUNT_UNPRICED", "approval");
    await pass(7 * MIN);

    // ---- 8 ------------------------------------------------------------------------
    heading("Beat 8: Cards · the owner's signature, and judged again when it is given");
    show(await own({ type: "approveSpend", agent: cc.address, scope: "venues", allow: "okx,metamask,hyperliquid,sub:research", perPayment: "600", budget: "3000", windowHours: 0, validUntil: ms + 30 * DAY }));
    svc.setMode("guard");
    const asked = show(await transfer(cc, "okx", "hyperliquid", "550"));
    const card8 = !isRefusal(asked) && asked.kind === "card" ? asked.card : undefined;
    check(!!card8 && spend("venues").reservedMicro === 550_000_000, "Guard: $550 is above OKX's $500 no-ask line, so it waits on a card — and the card holds $550 of the budget while it waits", "card");
    check(!!card8 && !!refused(show(await answer(card8, "approve", cc)), "E_ACCOUNT_OWNER_ONLY"), "the agent cannot answer its own card: E_ACCOUNT_OWNER_ONLY", "card");
    check(!!card8 && !!refused(show(await own({ type: "approveCard", card: card8.id, action: `0x${"11".repeat(32)}`, decision: "approve" })), "E_ACCOUNT_BAD_SIGNATURE"), "an approval that names another instruction than the card holds: E_ACCOUNT_BAD_SIGNATURE", "card");
    const released = card8 ? show(await answer(card8)) : undefined;
    check(!!released && code(released) === "payment" && spend("venues").reservedMicro === 0, "the owner's signature releases it: every check runs again, then the transfer flies on the same flight", "card");
    const late = show(await transfer(cc, "okx", "hyperliquid", "550"));
    await pass(31 * MIN);
    check(!isRefusal(late) && late.kind === "card" && !!refused(show(await answer(late.card)), "E_ACCOUNT_CARD_EXPIRED") && spend("venues").reservedMicro === 0, "a card does not wait for ever: answered after 31 minutes it is E_ACCOUNT_CARD_EXPIRED, and its share of the budget is free again", "card");
    check(!!refused(show(await own({ type: "setPolicy", change: "mode", value: "open" }, cc)), "E_ACCOUNT_OWNER_ONLY"), "tightening (Guard) took no signature; opening the dial again is the owner's to sign, not the agent's", "dial");
    show(await own({ type: "setPolicy", change: "mode", value: "open" }));
    await pass(7 * MIN);

    // ---- 9 ------------------------------------------------------------------------
    heading("Beat 9: Someone else · an address is an address ON A CHAIN, added by the owner, usable a day later");
    const contractor = "0x7A11000000000000000000000000000000000001";
    const to = { destination: contractor, sourceDex: "metamask", destinationDex: "Base", amount: "300" };
    check(!!refused(show(await send(to)), "E_ACCOUNT_DESTINATION"), "an address that is not in the book: E_ACCOUNT_DESTINATION (Hyperliquid's Send goes to any unsanctioned address and cannot be called back)", "book");
    show(await own({ type: "setDestination", label: "contractor", address: contractor, chain: "Base", token: "USDC" }));
    check(!!refused(show(await send(to)), "E_ACCOUNT_DEST_COOLING"), "added a minute ago: E_ACCOUNT_DEST_COOLING", "book");
    await pass(DAY + MIN);
    check(!!refused(show(await send({ ...to, destinationDex: "Arbitrum" })), "E_ACCOUNT_DESTINATION"), "the right address on the wrong chain is a different destination", "book");
    const sent = show(await send(to));
    check(code(sent) === "payment" && !isRefusal(sent) && sent.kind === "payment" && sent.payment.kind === "send" && sent.payment.authority === "owner", "a day later, on its chain, signed by the owner: sent", "book");
    check(!!refused(show(await send({ destination: "0xD759…ATTACKER", sourceDex: "metamask", destinationDex: "Base", amount: "10" })), "E_WALLET_BLOCKLIST"), "the blocklist is not fooled by capital letters: E_WALLET_BLOCKLIST", "book");
    await pass(2 * MIN);

    // ---- 10 -----------------------------------------------------------------------
    heading("Beat 10: Floats and Unified · the most a mistake can cost, and who picks the source");
    show(await own({ type: "createSubAccount", name: "research", agent: cc.address, float: "60" }));
    check(!!refused(show(await send({ sourceDex: "metamask", destinationDex: "sub:research", amount: "80" })), "E_WALLET_FLOAT_CAP"), "a float has a cap the owner set: $80 into a $60 float is E_WALLET_FLOAT_CAP", "float");
    show(await send({ sourceDex: "metamask", destinationDex: "sub:research", amount: "50" }));
    await pass(MIN);
    check(float() > 49 && float() < 50, `the float "research" holds ${usd(float())} (50 less gas): the agent pays from it and never holds its key`, "float");
    check(!!refused(show(await transfer(cc, "", "hyperliquid", "300")), "E_ACCOUNT_SOURCE"), "a transfer that names no source, on a Separate account: E_ACCOUNT_SOURCE", "unified");
    show(await own({ type: "userSetAbstraction", abstraction: "unifiedAccount" }));
    const picked = show(await transfer(cc, "", "hyperliquid", "300"));
    check(!isRefusal(picked) && picked.kind === "payment" && picked.payment.from === "metamask", "Unified: the account picks the open source that lands soonest among the venues the approval names — the wallet's USDC on Arbitrum, 75 seconds away", "unified");
    await pass(3 * MIN);

    // ---- 11 -----------------------------------------------------------------------
    heading("Beat 11: Paying an API · x402 and MPP, answered by the account");
    const QUOTE = "https://data.sim/v1/quotes?symbol=NVDA";
    check(!!refused(show(await pay(QUOTE, "0.05")), "E_MANDATE_NONE"), "moving money between venues was approved; paying anyone was not: E_MANDATE_NONE", "pay");
    show(await own({ type: "approveSpend", agent: cc.address, scope: "payees", allow: "data.sim", perPayment: "0.02", budget: "0.05", windowHours: 0, validUntil: ms + 30 * DAY }));
    check(!!refused(show(await pay("https://evil.sim/v1/quotes", "0.05")), "E_MANDATE_RECIPIENT") && world.sent.length === 0, "a host the owner did not name: E_MANDATE_RECIPIENT, and not one request went out to it", "pay");
    const first11 = show(await pay(QUOTE, "0.05"));
    const card11 = !isRefusal(first11) && first11.kind === "card" ? first11.card : undefined;
    check(!!card11 && card11.offer?.payTo === world.data.payTo && float() > 49.9, `the first payment to a payee waits for the owner, who sees who is paid, at which address (${short(world.data.payTo)}) and how much — read from the payee's own 402, not from the agent`, "pay");
    const paid11 = card11 ? show(await answer(card11)) : undefined;
    check(!!paid11 && !isRefusal(paid11) && paid11.kind === "payment" && (paid11.data as { symbol?: string } | undefined)?.symbol === "NVDA" && spend("payees").payTo["data.sim"] === world.data.payTo, "approved: an EIP-3009 authorisation signed by the float's key, settled, receipt checked against the ledger, the quote returned — and that address is now pinned for data.sim", "x402");
    for (let i = 0; i < 4; i++) await pay(QUOTE, "0.02");
    check(!!refused(show(await pay(QUOTE, "0.02")), "E_MANDATE_BUDGET") && Math.round(spend("payees").spentMicro) === 50_000, "five one-cent calls fit a five-cent budget; the sixth is E_MANDATE_BUDGET — splitting does not help", "pay");
    show(await own({ type: "approveSpend", agent: cc.address, scope: "payees", allow: "data.sim,infer.sim,shop.sim", perPayment: "30", budget: "70", windowHours: 0, validUntil: ms + 30 * DAY }));
    note("a new approval starts with no pinned address: each payee is confirmed once more");
    await payOk(QUOTE, "0.05");
    const honest = world.data.payTo;
    world.data.payTo = simKey("attacker").address;
    const before11 = float();
    check(!!refused(show(await pay(QUOTE, "0.05")), "E_PAYEE_CHANGED") && float() === before11 && world.chain.balance(simKey("attacker").address) === 0, "the payee's 402 now names another receiving address: E_PAYEE_CHANGED, nothing moves (nothing in x402's own checks ties the receiving address to the host that was asked)", "x402");
    world.data.payTo = honest;
    world.data.priceMicro = 500_000;
    check(!!refused(show(await pay(QUOTE, "0.05")), "E_PAYEE_OVERCHARGE"), "the payee asks fifty cents for what the agent agreed five for: E_PAYEE_OVERCHARGE", "x402");
    world.data.priceMicro = 10_000;
    world.data.redirect = "https://evil.sim/pay";
    check(!!refused(show(await pay(QUOTE, "0.05")), "E_PAYEE_REDIRECT"), "the payee redirects the request: E_PAYEE_REDIRECT — a payment does not follow one", "x402");
    world.data.redirect = undefined;
    const wire = (lastPaid().native as { payload: X.X402Payload }).payload;
    const replay = await world.fetch({ method: "GET", url: QUOTE, headers: { "PAYMENT-SIGNATURE": X.b64json(wire) } }, ms);
    check(replay.status === 402 && X.unb64json<X.X402Required>(replay.headers["payment-required"] ?? "")?.error === "invalid_transaction_state", "the signed authorisation itself, replayed straight at the payee: 402 invalid_transaction_state — its nonce is spent", "x402");
    const builder = simKey("builder").address;
    check(!!refused(show(await pay(QUOTE, "0.05", "research", { builder: { b: builder, f: 50 } })), "E_ACCOUNT_FEE_CAP"), "an app adds its fee to the payment without the owner's approval: E_ACCOUNT_FEE_CAP", "fee");
    show(await own({ type: "approveBuilderFee", builder, maxFeeRate: "0.05%" }));
    check(!!refused(show(await pay(QUOTE, "0.05", "research", { builder: { b: builder, f: 100 } })), "E_ACCOUNT_FEE_CAP"), "approved at 0.05%, the app asks 0.1%: E_ACCOUNT_FEE_CAP", "fee");
    check(code(show(await pay(QUOTE, "0.05", "research", { builder: { b: builder, f: 50 } }))) === "payment" && world.chain.balance(builder) === 5, "at the approved rate the fee rides along: five millionths of a dollar on a one-cent call", "fee");

    const charged = await payOk("https://infer.sim/v1/answers", "0.05");
    show(charged);
    const mpp = lastPaid().native as { challenge: X.MppChallenge; credential: X.MppCredential };
    check(code(charged) === "payment" && (mpp.credential.payload as { authorization: X.Eip3009 }).authorization.nonce === X.mppChargeNonce(mpp.challenge), "MPP charge: the payee's challenge is answered with an authorisation whose nonce is a hash of that challenge — it cannot be lifted into another", "mpp");
    const STREAM = "https://infer.sim/v1/stream";
    const opened = float();
    await pay(STREAM, "0.05");
    await pay(STREAM, "0.05");
    const third = show(await pay(STREAM, "0.05"));
    check(!isRefusal(third) && third.kind === "payment" && third.payment.heldUsd === 0.47 && Math.round((opened - float()) * 1e6) === 500_000, "MPP session: fifty cents went into an escrow once; three calls are three signed vouchers, each for the new total. The payee has taken nothing yet", "mpp");
    const done11 = show(await pay(STREAM, "0", "research", { close: true }));
    check(!isRefusal(done11) && done11.kind === "payment" && done11.payment.status === "settled" && Math.round((opened - float()) * 1e6) === 30_000 && world.chain.balance(world.escrow.address) === 0, "closed: the payee takes the three cents its last voucher says, the escrow sends forty-seven back to the float", "mpp");
    world.infer.escrowContract = simKey("contract:the-payees-own").address;
    check(!!refused(show(await pay(STREAM, "0.05")), "E_PAYEE_UNVERIFIED"), "the payee names an escrow contract of its own choosing: no deposit goes into it", "mpp");
    world.infer.escrowContract = undefined;
    await pay(STREAM, "0.05");
    world.down.add("infer.sim");
    const dark = show(await pay(STREAM, "0", "research", { close: true }));
    const before17 = float();
    await pass(17 * MIN);
    check(!isRefusal(dark) && dark.kind === "payment" && dark.payment.status === "settled" && Math.round((float() - before17) * 1e6) === 500_000, "the payee goes silent with a deposit in escrow: the account asks the escrow itself, and seventeen minutes later all fifty cents are back — a voucher nobody collected was never spent", "mpp");
    world.down.clear();

    // ---- 12 -----------------------------------------------------------------------
    heading("Beat 12: Buying something · AP2 from a float");
    const ITEM = "https://shop.sim/items/desk-feed-pro";
    check(!!refused(show(await pay(ITEM, "30", "")), "E_PAYEE_UNSUPPORTED"), "a shop is paid from a float: a payment that names none is refused (no card is on the account)", "ap2");
    world.shop.checkoutCents = 60_000;
    check(!!refused(show(await payOk(ITEM, "30", "research", { cnf: cc.jwk })), "E_PAYEE_OVERCHARGE"), "the owner approves the shop at its page's $29; the checkout the merchant then signs totals $600: E_PAYEE_OVERCHARGE, nothing is signed", "ap2");
    world.shop.checkoutCents = undefined;
    const needsOut = await payOk(ITEM, "30", "research", { cnf: cc.jwk });
    const needs = !isRefusal(needsOut) && needsOut.kind === "result" ? (needsOut.result as X.Ap2Needs) : undefined;
    check(needs?.needs === "mandates" && needs.checkout.total.amount === 2900 && X.ap2CheckoutHash(needs.checkout.jwt) === needs.checkout.hash, "AP2: the merchant signs the checkout; the account turns the owner's spending approval into two OPEN mandates that name the agent's key, and hands both to the agent", "ap2");
    const iat = Math.floor(ms / 1000);
    const stolen = needs ? show(await pay(ITEM, "30", "research", { mandates: X.ap2Answer(codex.p256, needs, iat) })) : undefined;
    check(!!stolen && !!refused(stolen, "E_ACCOUNT_BAD_SIGNATURE"), "closed mandates signed by another key than the open mandate names: refused before any credential leaves", "ap2");
    const cheap = needs ? X.ap2Close("payment", { transaction_id: needs.checkout.hash, payee: needs.checkout.merchant, payment_amount: { amount: 1, currency: "USD" }, payment_instrument: needs.instrument }, { ...needs.sign.payment, iat }, needs.open.payment, cc.p256) : "";
    const signed = needs ? X.ap2Answer(cc.p256, needs, iat) : undefined;
    check(!!signed && !!refused(show(await pay(ITEM, "30", "research", { mandates: { checkout: signed.checkout, payment: cheap } })), "E_MANDATE_INVALID"), "a payment mandate for one cent against a $29 checkout: E_MANDATE_INVALID", "ap2");
    const before12 = float();
    const ap2 = signed ? show(await pay(ITEM, "30", "research", { mandates: signed })) : undefined;
    const receipts = (lastPaid().native as { receipts?: { checkout?: { status?: string }; payment?: { status?: string } } }).receipts;
    check(!!ap2 && code(ap2) === "payment" && Math.round((before12 - float()) * 100) === 2900 && receipts?.checkout?.status === "Success" && receipts.payment?.status === "Success", "the agent's own key signs \"this checkout\" and \"this payment\"; the merchant verifies the first, the account (as credential provider) the second, and the merchant's processor reads it too; merchant and processor each sign a receipt naming the mandate it answers; $29.00 leaves the float", "ap2");

    // ---- 13 -----------------------------------------------------------------------
    heading("Beat 13: Plug in an exchange wallet · no code, one signature");
    const shelf = (await engine.view()).connectable;
    note(`venues the owner has that the account does not reach yet: ${shelf.map((c) => `${c.name} (${c.via})`).join(" · ")}`);
    check(!!refused(show(await own({ type: "connectVenue", venue: "bybit", connector: "unified", label: "", credentialRef: "" }, cc)), "E_ACCOUNT_OWNER_ONLY"), "an agent cannot plug a venue in: E_ACCOUNT_OWNER_ONLY", "plug");
    const plugged = show(await own({ type: "connectVenue", venue: "bybit", connector: "unified", label: "", credentialRef: "" }));
    const bybit = (await engine.view()).venues.find((v) => v.id === "bybit");
    check(code(plugged) === "account" && bybit?.usd === 4176 && bybit.in.access === "agent" && bybit.out.access === "venue", "one owner signature and Bybit is on the account: its $4,176 is read, and its doors are compiled from what Bybit says about the key — read and trade, so money can go in and the way out is at Bybit itself", "plug");
    const stuck = show(await transfer(cc, "bybit", "hyperliquid", "300"));
    check(!!refused(stuck, "E_VENUE_RAIL_CLOSED") && String((isRefusal(stuck) ? (stuck.detail as { opens?: string } | undefined)?.opens : "") ?? "").includes("whitelist"), "the agent cannot pull money out of it — and the refusal says what would open that door: a key that can withdraw, to a whitelist of your own addresses", "plug");
    show(await own({ type: "connectVenue", venue: "kraken", connector: "unified", label: "", credentialRef: "" }));
    check(!!refused(show(await transfer(cc, "kraken", "hyperliquid", "300")), "E_MANDATE_RECIPIENT"), "Kraken's key CAN withdraw to the user's own wallet; but a venue plugged in today is in no spending approval signed before it: E_MANDATE_RECIPIENT", "plug");
    show(await own({ type: "approveSpend", agent: cc.address, scope: "venues", allow: "okx,metamask,hyperliquid,sub:research,kraken", perPayment: "600", budget: "3000", windowHours: 0, validUntil: ms + 30 * DAY }));
    const viaKraken = show(await transfer(cc, "kraken", "hyperliquid", "300"));
    const krakenLeg = !isRefusal(viaKraken) && viaKraken.kind === "payment" ? (viaKraken.payment.legs[0]!.native as { library?: string; call?: string }) : undefined;
    check(krakenLeg?.call === "withdraw" && krakenLeg.library === "ccxt · unified API", "named in an approval, it works like the venues the account opened with: Kraken → wallet → Hyperliquid. The leg at Kraken is the unified library's `withdraw` call: no line of code here names Kraken", "plug");
    await pass(7 * MIN);
    show(await own({ type: "connectVenue", venue: "okx-wallet", connector: "wallet", label: "", credentialRef: "" }));
    check(!!refused(show(await transfer(cc, "okx-wallet", "hyperliquid", "100")), "E_ACCOUNT_OWNER_ONLY"), "a self-custody wallet is plugged in by its address: the account reads it and can send to it, and nothing leaves it unless the owner signs in that wallet", "plug");
    check(!!refused(show(await own({ type: "connectVenue", venue: "bybit", connector: "unified", label: "", credentialRef: "" })), "E_ACCOUNT_BAD_ACTION") && code(show(await own({ type: "disconnectVenue", venue: "bybit" }))) === "account" && (await engine.view()).venues.length === 10, "plugged in once, and unplugged with one signature: the account stops reading Bybit; the key at Bybit is the owner's to delete there", "plug");

    // ---- 14 -----------------------------------------------------------------------
    heading("Beat 14: The ledger as evidence");
    const chain = svc.verifyChain();
    check(chain.ok, `ledger chain verified · ${chain.rows} rows · ${svc.ledgerPath()}`, "ledger");
    const onDisk = readFileSync(svc.ledgerPath(), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { kind: string; signer?: string; envelope?: { action: Action; signature: AnySig } });
    const signedRows = onDisk.filter((r) => r.kind === "action" && r.envelope && r.signer);
    let recovered = 0;
    for (const r of signedRows) if ((await signerOf(r.envelope!.action, r.envelope!.signature)) === r.signer) recovered++;
    check(signedRows.length > 30 && recovered === signedRows.length, `${signedRows.length} accepted instructions are on the file with their signed envelopes, and every signature recovers to the signer the row names`, "ledger");
    const copy = join(home, "portfolio", "tampered-copy.jsonl");
    const lines = readFileSync(svc.ledgerPath(), "utf8").trim().split("\n");
    const target = lines.findIndex((l) => l.includes('"notionalUsd":500'));
    writeFileSync(copy, `${lines.map((l, i) => (i === target ? l.replace('"notionalUsd":500', '"notionalUsd":5') : l)).join("\n")}\n`);
    const tampered = new Ledger(copy, now).verifyChain();
    check(target >= 0 && !tampered.ok && tampered.at === target + 1, `one amount changed in a copy of the file: the chain breaks at row ${tampered.at ?? "?"}`, "ledger");
    const rec = engine.reconcile();
    check(rec.ok && rec.matched > 0, `the account's payments against the venues' own statements: ${rec.matched} matched, no break`, "reconcile");
    svc.adapter("hyperliquid")!.credit!("USDC", 77);
    const broken = engine.reconcile();
    note(broken.breaks.join(" | "));
    check(!broken.ok && broken.breaks.length === 1, "a credit at a venue that no payment of the account explains is a break, by name", "reconcile");
    const kinds = new Map<string, number>();
    for (const r of svc.rows()) kinds.set(r.kind, (kinds.get(r.kind) ?? 0) + 1);
    note(`rows by kind: ${[...kinds.entries()].map(([k, c]) => `${k} ${c}`).join(" · ")}`);
    const v13 = await engine.view();
    note(`payments ${engine.payments.length} · payees ${v13.pay.payees.map((p) => `${p.host} ${usd(p.paidUsd)}`).join(" · ")} · float "research" ${usd(float())} · total ${usd(v13.totalUsd)}`);
    console.log("  PROVEN");
    for (const l of PROVEN) note(`  · ${l}`);
    console.log("  NOT PROVEN");
    for (const l of NOT_PROVEN) note(`  · ${l}`);
  } catch (err) {
    console.log(`FAIL threw: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    failures.push(`threw ${err instanceof Error ? err.message : String(err)}`);
  }

  heading("Summary");
  const refusals = svc.rows().filter((r) => r.kind === "account-refusal").length;
  note(`venues ${svc.accounts().length} (8 at the start, 2 plugged in) · payments ${engine.payments.length} · refusals at the account's door ${refusals} · cards ${svc.counters.cards} · loss $0.00 (no money went anywhere the owner had not signed for)`);
  note(`ledger ${svc.ledgerPath()}`);
  if (failures.length) {
    console.log(`\nFAILED ASSERTIONS (${failures.length}):`);
    for (const f of failures) console.log(`  - ${f}`);
    return 1;
  }
  console.log("\nALL ACCOUNT ASSERTIONS PASSED");
  return 0;
}

main().then(
  (c) => process.stdout.write("", () => process.exit(c)),
  (err) => {
    console.error(err);
    process.stdout.write("", () => process.exit(1));
  },
);
