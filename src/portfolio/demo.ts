/** `npm run portfolio:demo` — ten beats, ✓/✗/FAIL lines, exit 0 iff no
 * assertion failed. No port is opened unless `--serve`; the accounts are
 * in-process simulators; `--mm` swaps the MetaMask account and its Polymarket
 * deposit wallet for the real `mm` CLI (reads live; writes stay off unless
 * PORTFOLIO_MM_WRITES=1).
 *
 *   npm run portfolio:demo                     headless, everything simulated
 *   npm run portfolio:demo -- --mm             the MetaMask and Polymarket beats read the real wallet
 *   npm run portfolio:demo -- --serve --hold   also open the page at :4820 and keep it up
 */
import { formatRefusal, isRefusal, type Refusal } from "../core/errors.ts";
import { agentCode, CAP_LABEL, describeIntent, qtyText, r2, type Intent } from "./accounts.ts";
import { AgentSession } from "./agent.ts";
import { etaLabel } from "./rails.ts";
import { bestVenue, fillAt, splitOrder, venueQuotes } from "./venues.ts";
import { defaultHome, startPortfolioServer } from "./server.ts";
import { isPending, PortfolioService, type ExecuteOutcome } from "./service.ts";

const argv = process.argv.slice(2);
const flag = (f: string) => argv.includes(f);
const value = (f: string) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};

/** a simulated clock: a run prints the same timestamps on stage and in the test */
let ms = Date.UTC(2026, 9, 3, 9, 0, 0);
const now = () => new Date(ms).toISOString();
const tick = (s = 1) => void (ms += s * 1000);

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
const show = (r: ExecuteOutcome | Refusal): void => {
  if (isRefusal(r)) console.log(formatRefusal(r));
  else if (isPending(r)) console.log(`  ▣ card ${r.approval.id} · $${r.approval.usd} · ${r.approval.reason}`);
  else console.log(`  ✓ ${r.account} · ${r.status} · ${r.summary}${r.ref ? ` · ${r.ref}` : ""}`);
};
const code = (r: ExecuteOutcome | Refusal): string => (isRefusal(r) ? r.code : isPending(r) ? "pending" : r.status);

const STRANGER = "0x7a11…stranger";
const COLD = "0x9C0d4E3b7a2f1c8d9e0f1a2b3c4d5e6f7a8b9c0d";
const ATTACKER = "0xd759…attacker";
const FED = "FED-DEC-HIKE25:YES";

export const PROVEN = [
  "eight accounts the user already has — two CEXs, the on-chain agent wallet, two prediction markets, an RWA position, a card, a bank — come in as one shape; in front of the agent a credential is only a reference",
  "open mode: four writes across four accounts with zero cards. The agent's reach is the edge of each credential's native scope",
  "liquidity = amount × time × cost: one ladder to Ethereum (now / minutes / T+1 / closed), and a closed runway still carries its quote (how long and how much if it were opened)",
  "cross-chain with quotes and a choice of route: three bridges and the CEX hops are compared, the cheapest open one is taken, its fee comes out of what arrives, and the gap is stated with its reason",
  "execution liquidity: one order is quoted at both CEX books and at the DEX pools on each chain (spread, depth, taker or LP fee, gas); a venue that does not hold the asset says so",
  "order splitting: an order no single venue can take goes to OKX, a DEX and Binance by marginal net price and inventory, each slice at the price it was quoted; gas is paid only where it earns itself back, and one more leg has to add at least $1",
  "the same router at size: 400 ETH (inventory ignored) split four ways nets over $400 more than the best single venue. Depth is what a large order pays for",
  "where it sells decides whether the money can move: the DEX slice's USDC stays on-chain and mobile, the CEX slices' USDT is stuck behind keys that cannot withdraw",
  "prediction markets are venues like the others: one question listed at Polymarket and at Kalshi, each with its own book, fee and cash, is quoted at both and bought across both; funding Polymarket is a bridge from the on-chain wallet straight into its deposit wallet; winnings are redeemed at $1",
  "one order, one card: in Guard a split order is judged as a whole (splitting cannot slip it under the allowance), asks once, and one yes fills every slice",
  "routing is the tower's service: an agent arriving over MCP gets the same route through portfolio_quote / portfolio_order, and the flight is logged under its own name",
  "every flight has a number (agent code + sequence) and every ledger row says which agent's which flight it belongs to",
  "the edge is held by the credential and the venue, and the wallet neither adds to it nor takes from it: the wallet's pre-check (E_WALLET_SCOPE) and the venue's own second line once the wallet is bypassed (-2015 / 403 / 404 / rc 57 / revert) draw the same line",
  "open mode still asks before the dangerous ones: a transfer to a never-used address, an order in a prediction market that is past its close and not yet resolved. A blocklisted address is refused outright; MetaMask's own Guard still sends an over-the-line transfer to MFA",
  "guard tightens with one switch: a card above the no-ask allowance, an account switched off keeps reads only, reach narrows per account; reads never stop in any mode",
  "every step — read, intent, card, fill, refusal, bypass — is a row on one hash-chained ledger",
];
export const NOT_PROVEN = [
  "the accounts are local simulations: the permission error codes of Binance / OKX have the real shape; the Mastercard agentic token's format is illustrative (the decline codes are real); Ondo simulates only the allowlist transfer restriction and T+1; Kalshi's error codes and tickers are illustrative",
  "bridge fees, arrival times, withdrawal fees, spreads, depth, the pools' virtual reserves, gas and the prediction markets' books are illustrative tables (real shapes, not market data); an arrival time is only a quote, the simulation delivers at once",
  "books and pools are stateless: a fill does not move a price; there is no market data, no MEV, no slippage protection. Slices settle one after another, not atomically: one filled and another refused is a partial fill (visible on the ledger, not rolled back)",
  "a question listed at two venues settles by two sets of rules: buying it at both is not one position. The agent says so; it does not hedge it",
  "the MetaMask and Polymarket accounts are read-only when live: real-money writes are off (PORTFOLIO_MM_WRITES) and only print the mm command they would run. Live reads that have been exercised: balances, the spot price, the Polymarket book and order preview, the geoblock check. Not exercised: bridge and DEX quotes (they need a funded wallet), a Polymarket portfolio (this wallet has never been set up)",
  "prices are a fixed table; nothing is reconciled against a venue's own statement",
  "switching an account off is the wallet's side only: deleting the key at the exchange or freezing the token at the issuer is an operator action that is not done here",
  "a scripted agent is not an LLM making the same decisions; no alpha is shown",
];

async function main(): Promise<number> {
  const live = flag("--mm") || process.env.PORTFOLIO_MM === "1";
  const home = value("--home") ?? defaultHome();
  const svc = await PortfolioService.create({ home, now, live });
  const server = flag("--serve") ? await startPortfolioServer({ port: Number(value("--port") ?? 4820), service: svc }) : undefined;

  heading("Setup");
  note(`home ${home} · ledger ${svc.ledgerPath()}`);
  note(`sim clock ${now()} · MetaMask and Polymarket ${live ? "LIVE through the mm CLI (reads); writes are off" : "simulated (--mm reads the real wallet)"} · the other accounts are local simulations`);
  if (server) note(`page ${server.url}`);

  try {
    // ---- 1 ------------------------------------------------------------------------
    heading("Beat 1: Connect · eight accounts, one shape");
    const accounts = svc.accounts();
    for (const a of accounts) note(`${a.id.padEnd(10)} ${a.kind.padEnd(12)} can ${a.scope.can.map((c) => CAP_LABEL[c]).join("/").padEnd(34)} ${a.scope.enforcedBy.padEnd(8)} ${a.credentialKind} · ref ${a.credentialRef}`);
    check(accounts.map((a) => a.id).sort().join(",") === "binance,chase,kalshi,mastercard,metamask,okx,ondo,polymarket", "8 accounts connected in one shape: binance okx metamask kalshi polymarket ondo mastercard chase", "account");
    check(accounts.every((a) => a.credentialRef.length > 0) && !/"secret"|"apiKey"|"passphrase"|"token":/.test(JSON.stringify(accounts)), "credentials are references only: no key, secret or token value in the agent-facing view", "account");
    check(accounts.every((a) => a.scope.can.includes("read") && a.scope.limits.length > 0), "every account declares its credential's native scope (layer 1) and who enforces it", "account");

    // ---- 2 ------------------------------------------------------------------------
    heading("Beat 2: One read · eight accounts, no card");
    tick();
    const o2 = await svc.overview();
    note(`total $${o2.portfolio.totalUsd.toLocaleString("en-US")} · credit available $${o2.portfolio.creditAvailableUsd} · ${o2.portfolio.byClass.map((c) => `${c.label} ${c.pct}%`).join(" · ")}`);
    for (const a of o2.portfolio.byAccount) note(`${a.name.padEnd(28)} $${String(a.usd).padStart(10)} ${a.live ? " LIVE" : ""}  ${a.holdings.map((h) => `${h.amount} ${h.asset}`).join(" · ")}`);
    check(o2.counters.cards === 0 && o2.approvals.length === 0, "one read across 8 accounts raised no card", "read");
    check(o2.portfolio.totalUsd > 0 && ["rwa", "cash", "event"].every((c) => o2.portfolio.byClass.some((x) => x.class === c)), "the total spans crypto, stablecoins, prediction-market positions, RWA and bank cash; the card's credit is shown, not summed", "read");
    const mm = o2.accounts.find((a) => a.id === "metamask")!;
    const pmAcct = o2.accounts.find((a) => a.id === "polymarket")!;
    if (live) {
      check(mm.live && mm.readError === undefined, `MetaMask agent wallet read LIVE through mm · ${mm.credentialKind} · $${mm.usd} · ${mm.scope.limits[1]}`, "live");
      check(pmAcct.live && pmAcct.readError === undefined, `Polymarket read LIVE through mm predict · ${pmAcct.scope.limits[0]} · ${pmAcct.scope.limits[1]}`, "live");
    } else note("MetaMask and Polymarket are simulated here; `--mm` reads the real wallet through the mm CLI");

    // ---- 3 ------------------------------------------------------------------------
    heading("Beat 3: Liquidity ladder · quoted cross-chain routes · closed runways");
    const before = await svc.overview();
    for (const row of before.ladder.rows) note(`${row.label.padEnd(8)} $${String(row.usd).padStart(9)}  ${row.items.map((it) => `${it.account} ${it.asset}${it.chain ? "@" + it.chain : ""} · ${it.route.label}${it.open ? "" : ` (${it.route.why})`} · ${etaLabel(it.route.etaSec)} · $${it.route.feeUsd}`).join(" | ")}`);
    const rowUsd = (b: string) => before.ladder.rows.find((r) => r.bucket === b)?.usd ?? 0;
    const closedRow = before.ladder.rows.find((r) => r.bucket === "closed");
    const mobileAt = (o: typeof before, id: string) => o.liquidity.mobile.filter((s) => s.account === id).reduce((s, x) => s + x.usd, 0);
    const mmMobile = mobileAt(before, "metamask");
    const pmMobile = mobileAt(before, "polymarket");
    check(rowUsd("now") === 3000 && rowUsd("closed") === 20400 && rowUsd("t1") > 1900 && (live || rowUsd("minutes") === 1800), "the liquidity ladder to Ethereum: $3,000 now (Ondo USDC), $1,800 in minutes (MetaMask USDC over a bridge, Polymarket pUSD withdrawn and bridged), the OUSG T+1, $20,400 closed", "liquidity");
    check(closedRow !== undefined && closedRow.items.every((it) => !it.open && it.route.why !== undefined) && closedRow.items.find((it) => it.account === "binance")?.route.feeUsd === 9.5 && closedRow.items.find((it) => it.account === "kalshi")?.route.why === "pays out by ACH, not through the agent", "a closed runway keeps its quote: opening WITHDRAW on the Binance key would bring its $5,000 over in ~10 min for $9.50; Kalshi's cash pays out by ACH only", "liquidity");
    const bridged = Math.min(2000, mmMobile);
    const movedBridge = !live && bridged > 0 ? bridged : 0;
    const arrived = movedBridge > 0 ? movedBridge - 1 : 0;
    tick();
    const pm = new AgentSession(svc);
    const flight = await pm.say("Subscribe $5,000 OUSG");
    const printFlight = (f: typeof flight, from = 0) => {
      if (from === 0) note(`flight ${f.no} · ${f.agent.name} · ${f.request}`);
      for (const l of f.legs.slice(from)) {
        note(`  ${l.mark === "ok" ? "✓" : l.mark === "no" ? "✗" : l.mark === "wait" ? "▣" : "·"} ${l.text}${l.usd ? ` · $${l.usd}` : ""}`);
        if (l.parts) note(`      [${l.parts.map((p) => `${p.label} ${p.pct}%`).join(" | ")}]`);
        if (l.compare) note(`      ${l.compare}`);
      }
    };
    printFlight(flight);
    const okLegs = flight.legs.filter((l) => l.mark === "ok").length;
    const bridgeLeg = flight.legs.find((l) => l.text.startsWith("Bridge") && l.text.includes("Base → Ethereum"));
    check(flight.no === "PM-0001" && (bridged === 0 ? okLegs === 1 : live ? bridgeLeg !== undefined : okLegs === 3), bridged === 0 ? "one flight, one leg: $3,000 OUSG from the fuel at Ondo — the LIVE MetaMask wallet holds nothing to bridge" : live ? "one flight: $3,000 OUSG from Ondo, then a bridge leg the live switch stops (writes are off)" : "one flight, three legs: $3,000 OUSG from the fuel at Ondo, a $1,200 USDC bridge Base → Ethereum, $1,199 OUSG from what arrived", "flight");
    if (movedBridge > 0) {
      check(bridgeLeg !== undefined && bridgeLeg.text.includes("liquidity bridge") && bridgeLeg.text.includes("fee $1.00") && bridgeLeg.text.includes("~2 min"), "the bridge leg carries its quote: liquidity bridge · fee $1.00 · ~2 min — the cheapest open route for $1,200", "cross-chain");
      check((bridgeLeg?.compare ?? "").includes("CCTP") && (bridgeLeg?.compare ?? "").includes("canonical bridge") && (bridgeLeg?.compare ?? "").includes("closed"), "…and what it beat: CCTP $1.20 · ~15 min, the canonical bridge $2.50 · 7 days, and two CEX hops that are closed (key cannot withdraw)", "cross-chain");
    }
    const gap = bridged === 0 ? 2000 : live ? undefined : 5000 - 3000 - arrived;
    check(flight.legs[0]!.text.includes("closed") && (gap === undefined || flight.legs[0]!.text.includes(`Still $${gap.toLocaleString("en-US")} short`)), `the agent says the gap and why${gap === undefined ? "" : `: $${gap.toLocaleString("en-US")} short`} — keys without WITHDRAW, ACH-only cash and a read-only bank are closed runways, and the note prices opening one`, "liquidity");
    if (!live) check(flight.legs.some((l) => l.mark === "note" && l.text.includes("Polymarket holds $600 pUSD") && l.text.includes("parked for betting")), "money it could move but that is parked for something else is named, not taken: Polymarket's $600 pUSD stays where it is", "liquidity");
    const after = await svc.overview();
    const ousg = after.accounts.find((a) => a.id === "ondo")!.holdings.find((h) => h.asset === "OUSG")!.amount;
    check(ousg > 18 + (3000 + arrived) / 110.42 - 0.01 && after.liquidity.mobileUsd === mmMobile - movedBridge + pmMobile && after.liquidity.stuckUsd === 20400, `after the flight Ondo holds ${ousg.toFixed(2)} OUSG and $${mmMobile - movedBridge + pmMobile} of mobile liquidity is left; the stuck $20,400 is still stuck`, "liquidity");
    check(svc.rows().filter((r) => r.flight === flight.no).length >= (movedBridge > 0 ? 8 : 3) && (movedBridge === 0 || svc.rows().some((r) => r.kind === "funding" && r.flight === flight.no && r.notionalUsd === arrived)), movedBridge > 0 ? "every ledger row of the flight carries its number and agent; the bridge's arrival ($1,199 after the fee) is a funding row" : "every ledger row of the flight carries its number and agent", "ledger");

    // ---- 4 ------------------------------------------------------------------------
    heading("Beat 4: Execution liquidity · CEX books + DEX pools · one order across three venues");
    const quotes = venueQuotes("ETH", "sell", 1, after.accounts);
    for (const q of quotes) note(`${q.name.padEnd(16)} ${q.price > 0 ? `@ ${q.price} · fee $${q.feeUsd} · net $${q.netUsd} · impact ${q.impactBps} bp${q.route ? ` · ${q.route.map((r) => r.dex).join(" + ")} · gas $${q.gasUsd}` : ""}` : ""}${q.ok ? "" : `  ← ${q.why}`}`);
    const bestQ = bestVenue(quotes, "sell");
    const netAt = (venue: string) => quotes.find((q) => q.venue === venue)?.netUsd;
    check(bestQ?.venue === "okx" && bestQ.netUsd === 2439.02 && netAt("binance") === 2437.44 && (live || (quotes.length === 4 && netAt("dex:Base") === 2438.67)), live ? "one order (1 ETH) quoted at the venues that could take it: OKX nets $2,439.02, Binance $2,437.44; the LIVE wallet holds no ETH on-chain, so the DEX says so" : "one order (1 ETH) quoted at four venues — two CEX books, the DEX pools on two chains: OKX nets $2,439.02, DEX on Base $2,438.67 (5 bps LP fee + 5¢ gas), Binance $2,437.44", "execution");
    if (!live) check(quotes.find((q) => q.venue === "dex:Ethereum")?.why === "has only 0.15 ETH" && quotes.find((q) => q.venue === "dex:Base")?.route?.[0]?.dex === "Aerodrome", "a DEX quote is a route across that chain's pools (Aerodrome on Base); the 0.15 ETH on Ethereum cannot take the order alone, and says so", "execution");
    tick();
    const f2 = await pm.say("Sell 3 ETH");
    printFlight(f2);
    const fills = f2.legs.filter((l) => l.mark === "ok");
    const dexLeg = fills.find((l) => l.account === "metamask");
    check(f2.no === "PM-0002" && fills.map((l) => l.account).join(",") === (live ? "okx,binance" : "okx,metamask,binance") && f2.legs[0]!.text.includes("no single venue holds that much") && (f2.legs[0]!.parts?.length ?? 0) === fills.length, live ? "no venue holds 3 ETH, so the order is SPLIT by marginal net price and inventory: OKX 1.5 · Binance 1.5 (the LIVE wallet has nothing on-chain to add)" : "no venue holds 3 ETH, so the order is SPLIT by marginal net price and inventory: OKX 1.5 (best price) · DEX on Base 1 · Binance 0.5 — one flight, three legs", "split");
    if (!live) {
      check(f2.legs[0]!.text.includes("net $7,315.91") && fills[0]!.text.includes("net $3,658.52") && dexLeg !== undefined && dexLeg.text.includes("DEX (Base)") && dexLeg.text.includes("net $2,438.67") && fills[2]!.text.includes("net $1,218.72"), "each slice filled at the price it was quoted: $3,658.52 + $2,438.67 + $1,218.72 = $7,315.91 net", "split");
      const twoCex = r2((fillAt("okx", "ETH", "sell", 1.5)?.netUsd ?? 0) + (fillAt("binance", "ETH", "sell", 1.5)?.netUsd ?? 0));
      const earned = r2(7315.91 - twoCex);
      check((dexLeg?.compare ?? "").includes("Route: Aerodrome") && (dexLeg?.compare ?? "").includes("gas $0.05") && earned > 1, `the DEX slice shows its route — Aerodrome on Base, gas $0.05 — and it earned its place: $${earned} more than the two CEXs alone (OKX 1.5 + Binance 1.5 = $${twoCex.toLocaleString("en-US")}); one more leg has to add at least $1`, "dex");
      check(f2.legs.some((l) => l.mark === "note" && l.text.includes("$4.00 in gas") && l.text.includes("$3.83 less")), "a fixed cost is paid only where it earns itself back: the 0.15 ETH on Ethereum stays put — one swap's gas ($4) would cost more than it adds", "dex");
    }
    const after4 = await svc.overview();
    const onchainUsdc = mobileAt(after4, "metamask");
    if (!live) check(onchainUsdc === 2438.67 && f2.legs.some((l) => l.text.includes("free to move")) && after4.liquidity.stuckUsd === r2(20400 + 3658.52 + 1218.72), "where it sells decides whether the money can move afterwards: the DEX slice's $2,438.67 USDC is on Base (mobile liquidity again), the two CEX slices' USDT is stuck behind keys that cannot withdraw", "liquidity");
    check(svc.rows().filter((r) => r.flight === f2.no && r.kind === "venue").length === fills.length && svc.counters.cards === 0, "every slice is its own ledger row under the same flight; open mode raised no card", "ledger");
    tick();
    const f3 = await pm.say("Sell 0.05 BTC");
    printFlight(f3);
    const leg3 = f3.legs.find((l) => l.mark === "ok");
    check(leg3?.account === "binance" && (leg3.compare ?? "").includes("has no BTC") && f3.legs[0]!.text.includes("no split"), "execution liquidity is also where the inventory is: BTC sits only at Binance, so it sells there, unsplit — OKX and the chain have none to sell", "execution");
    tick();
    const cc = { id: "claude-code", name: "claude-code", code: agentCode("claude-code") };
    const routed = await svc.order("ETH", "buy", 0.4, cc);
    printFlight(routed.flight);
    const boughtAt = routed.plan.split.slices[0];
    check(routed.flight.no === "CC-0004" && routed.outcomes.length === 1 && !isRefusal(routed.outcomes[0]!) && boughtAt?.venue === (live ? "binance" : "dex:Base"), live ? "routing is the tower's service, not the page agent's: an MCP agent (Claude Code) asks for 0.4 ETH and flies CC-0004 — Binance, the LIVE wallet has no USDC on-chain" : `routing is the tower's service, not the page agent's: an MCP agent (Claude Code) asks for 0.4 ETH and flies CC-0004 — the DEX on Base wins it on merit ($${boughtAt?.netUsd} against Binance's $977.03: a 5 bps pool and 5¢ of gas beat a 10 bps taker fee)`, "dex");
    const whale = splitOrder("ETH", "sell", 400, after4.accounts, { ignoreInventory: true });
    note(`what-if, depth only (inventory ignored): SELL 400 ETH · best single venue ${whale.single?.name} nets $${whale.single?.netUsd.toLocaleString("en-US")} · split nets $${whale.netUsd.toLocaleString("en-US")}`);
    for (const s of whale.slices) note(`  ${s.name.padEnd(16)} ${String(s.qty).padStart(4)} ETH @ ${s.price} · impact ${s.impactBps} bp${s.route ? ` · ${s.route.map((r) => `${r.dex} ${qtyText(r.qty)}`).join(" + ")}` : ""}`);
    check(whale.slices.length === 4 && whale.single?.venue === "okx" && (whale.gainUsd ?? 0) > 400, `the same router at size: 400 ETH split across two books and two chains' pools nets $${whale.gainUsd} more than the best single venue — depth is what a large order pays for`, "split");

    // ---- 5 ------------------------------------------------------------------------
    heading("Beat 5: Prediction markets · one question, two venues");
    for (const m of svc.markets()) note(`${m.id.padEnd(18)} ${m.state.padEnd(9)} closes ${m.closesAt.slice(0, 10)}  ${m.venues.map((v) => `${v.name} ${v.yes.bid ?? "–"}/${v.yes.ask ?? "–"}`).join(" · ").padEnd(44)} ${m.title}`);
    const o5 = await svc.overview();
    const eq = venueQuotes(FED, "buy", 300, o5.accounts);
    for (const q of eq) note(`${q.name.padEnd(12)} ${q.price > 0 ? `300 YES @ ${q.price} · fee $${q.feeUsd} · cost $${q.netUsd}` : ""}${q.ok ? "" : `  ← ${q.why}`}`);
    const costAt = (venue: string) => eq.find((q) => q.venue === venue);
    check(costAt("kalshi")?.netUsd === 223.14 && (live ? costAt("polymarket")?.ok === false : costAt("polymarket")?.netUsd === 224.89), live ? `one question at two venues: Kalshi asks 0.73 (300 YES cost $223.14 with its fee); Polymarket ${costAt("polymarket")?.why} — the venue's own line, read live from mm predict geoblock` : "one question at two venues, each with its own book and fee: 300 YES cost $223.14 at Kalshi (ask 0.73, fee 7% × p × (1 − p)) and $224.89 at Polymarket (ask 0.74, fee 5% × p × (1 − p))", "prediction");
    const want = live ? 600 : 1000;
    tick();
    const f5 = await pm.say(`Buy ${want.toLocaleString("en-US")} YES · Fed hike`);
    printFlight(f5);
    const bought = f5.legs.filter((l) => l.mark === "ok");
    if (live) {
      check(f5.no === "PM-0005" && bought.map((l) => l.account).join(",") === "kalshi" && (bought[0]?.compare ?? "").includes("Polymarket takes no orders from"), "the order goes where it may: Kalshi takes all of it; Polymarket is named with the reason it cannot", "prediction");
      check(f5.legs.some((l) => l.mark === "note" && l.text.startsWith("Live Polymarket book")), "the Polymarket book behind this question is read LIVE (mm predict: top of book and an order preview — public data, no funds, readable even where orders are not taken)", "live");
    } else {
      check(f5.no === "PM-0005" && bought.map((l) => l.account).join(",") === "kalshi,polymarket" && f5.legs[0]!.text.includes("no single venue has the cash for it (Kalshi $500 · Polymarket $600)") && f5.legs[0]!.text.includes("cost $747.29"), "neither venue has the cash for 1,000 shares, so the order is split like any other: Kalshi's cheaper 400, then Polymarket — $747.29 in all", "prediction");
      check(bought[0]!.text === "Buy 400 YES · Kalshi @ 0.73 · cost $297.52" && bought[1]!.text === "Buy 600 YES · Polymarket @ 0.74 · cost $449.77", "each slice filled at its venue's book and fee: 400 @ 0.73 at Kalshi ($297.52), 600 @ 0.74 at Polymarket ($449.77)", "prediction");
      check(f5.legs.some((l) => l.text.includes("pays $1 if this resolves YES")) && f5.legs.some((l) => l.text.includes("the same question can resolve differently at each")), "the agent says what the position is ($1 per share if YES, by 2026-12-09) and the catch of holding one question at two venues: they settle by different rules", "prediction");
    }
    const o5b = await svc.overview();
    const sharesAt = (o: typeof o5b, id: string) => o.accounts.find((a) => a.id === id)!.holdings.find((h) => h.asset === FED)?.amount ?? 0;
    check(sharesAt(o5b, "kalshi") === (live ? 750 : 550) && sharesAt(o5b, "polymarket") === (live ? 0 : 600) && (o5b.portfolio.byClass.find((c) => c.class === "event")?.usd ?? 0) > 500, `the positions are holdings like any other, valued at the mark: Kalshi ${sharesAt(o5b, "kalshi")} YES, Polymarket ${sharesAt(o5b, "polymarket")} YES`, "prediction");
    tick();
    const f6 = await pm.say("Fund Polymarket with 300");
    printFlight(f6);
    if (live) check(f6.legs.length === 1 && f6.legs[0]!.text.includes("Not enough"), "funding Polymarket needs USDC in the on-chain wallet: the LIVE wallet has none, and the agent says so instead of trying", "cross-chain");
    else {
      const leg6 = f6.legs.find((l) => l.mark === "ok");
      check(leg6 !== undefined && leg6.text.includes("Base → Polygon → Polymarket deposit wallet") && leg6.text.includes("fee $0.55") && svc.rows().some((r) => r.kind === "funding" && r.venue === "polymarket" && r.flight === f6.no && r.notionalUsd === 299.45), "funding a prediction market is a cross-chain route too: $300 USDC bridged Base → Polygon straight into the Polymarket deposit wallet, $299.45 arrives after the $0.55 fee", "cross-chain");
    }
    tick();
    const f7 = await pm.say("Redeem winnings");
    printFlight(f7);
    if (live) check(f7.legs.length === 1 && f7.legs[0]!.text.startsWith("Nothing to redeem"), "nothing to redeem in the LIVE wallet, and the agent says so", "prediction");
    else check(f7.legs.some((l) => l.mark === "ok" && l.text === "Redeem 80 winning shares · Polymarket · paid out") && mobileAt(await svc.overview(), "polymarket") === r2(600 - 449.77 + 299.45 + 80), "a settled market pays out: 80 winning shares of the September question are redeemed at $1 each — $80 back in pUSD", "prediction");

    // ---- 6 ------------------------------------------------------------------------
    heading("Beat 6: Open mode · cross-account writes, zero cards");
    check(svc.policy().mode === "open", "mode = open: no wallet-side caps, no cards, the agent reaches each credential's edge", "open");
    const cards6 = svc.counters.cards;
    const writes: Array<[string, Intent]> = [
      ["binance", { kind: "trade", symbol: "BTCUSDT", side: "sell", qty: 0.05 }],
      ["okx", { kind: "trade", symbol: "ETH-USDT", side: "buy", qty: 0.5 }],
      ["ondo", { kind: "redeem", fund: "OUSG", amountUsd: 500 }],
      ["mastercard", { kind: "pay", merchant: "Anthropic · Claude Max", mcc: "7372", amountUsd: 120 }],
    ];
    const results6: ExecuteOutcome[] = [];
    for (const [acct, intent] of writes) {
      tick();
      const r = await svc.execute(acct, intent);
      results6.push(r);
      show(r);
    }
    check(results6.every((r) => !isRefusal(r) && !isPending(r)), "SELL on Binance · BUY on OKX · redeem OUSG at Ondo (T+1) · pay with the Mastercard token: all four went through", "open");
    check(svc.counters.cards === cards6 && cards6 === 0, "four writes across four accounts, zero cards — and none in the three beats before", "open");

    // ---- 7 ------------------------------------------------------------------------
    heading("Beat 7: The edge of open · the credential and the venue each say no");
    const refusals7: string[] = [];
    const tryEdge = async (acct: string, intent: Intent, expect: string, what: string, bypassToo = false) => {
      tick();
      note(`agent → ${acct}: ${describeIntent(intent)}`);
      const r = await svc.execute(acct, intent);
      show(r);
      if (isRefusal(r)) refusals7.push(r.code);
      check(code(r) === expect, what, isRefusal(r) ? r.layer.toLowerCase() : "venue");
      if (bypassToo) {
        console.log(`! [bypass] agent skips the wallet and uses the credential directly at ${acct}`);
        const b = await svc.bypass(acct, intent);
        show(b);
        if (isRefusal(b)) refusals7.push(b.code);
        check(isRefusal(b) && b.layer === "VENUE", `${acct} itself draws the same line (${isRefusal(b) ? `${b.code}${b.native ? " · " + JSON.stringify(b.native) : ""}` : "?"})`, "venue");
      }
    };
    await tryEdge("binance", { kind: "move", asset: "BTC", amount: 0.1, to: COLD }, "E_WALLET_SCOPE", "Binance: the key has no WITHDRAW — the wallet's pre-check says so before the exchange has to (E_WALLET_SCOPE)", true);
    await tryEdge("chase", { kind: "pay", merchant: "Landlord", mcc: "6513", amountUsd: 2000 }, "E_WALLET_SCOPE", "bank: an aggregation token is read-only — no openness setting can make it pay (E_WALLET_SCOPE)", true);
    await tryEdge("kalshi", { kind: "move", asset: "USD", amount: 100, to: "wallet-main" }, "E_WALLET_SCOPE", "Kalshi: the API key trades, it does not move money — payouts go by ACH from the account page (E_WALLET_SCOPE)", true);
    await tryEdge("mastercard", { kind: "pay", merchant: "Lucky Star Casino", mcc: "7995", amountUsd: 900 }, "E_VENUE_CARD_DECLINED", "Mastercard: pay IS in scope, so the wallet lets it through — the issuer declines rc 57 (MCC outside the agentic token)", false);
    await tryEdge("ondo", { kind: "move", asset: "OUSG", amount: 5, to: COLD }, "E_VENUE_TRANSFER_RESTRICTED", "Ondo: a known destination, open mode, no card — the OUSG contract reverts: cold wallet not on the issuer allowlist", false);
    if (live) {
      await tryEdge("polymarket", { kind: "trade", symbol: FED, side: "buy", qty: 10 }, "E_WALLET_SCOPE", "Polymarket LIVE: this credential has no `trade` — the wallet's pre-check says so (E_WALLET_SCOPE), and the venue's own line is the region", true);
      await tryEdge("metamask", { kind: "move", asset: "USDC", amount: 1, to: COLD, chainId: 8453 }, "E_WALLET_LIVE_WRITES_OFF", "MetaMask LIVE: known destination, no card — the adapter stops at the real-money switch and prints the exact mm command instead of running it", false);
    } else {
      await tryEdge("polymarket", { kind: "trade", symbol: "FED-SEP-HOLD:YES", side: "buy", qty: 10 }, "E_VENUE_MARKET_CLOSED", "Polymarket: trading IS in scope, so the wallet lets it through — the venue refuses: that market has settled", false);
      tick();
      const r = await svc.execute("metamask", { kind: "move", asset: "USDC", amount: 100, to: COLD });
      show(r);
      check(!isRefusal(r) && !isPending(r) && r.status === "pending", "MetaMask (sim): the portfolio wallet raised no card (a known destination), MetaMask's own Guard did — the cold wallet is not on ITS allowlist → AWAITING_MFA, the card in the user's inbox", "metamask");
    }
    note(`refusals in this beat: ${refusals7.join(", ")}`);
    check(refusals7.filter((c) => c.startsWith("E_WALLET_")).length >= 3 && refusals7.filter((c) => c.startsWith("E_VENUE_")).length >= 5, `the floor held: wallet pre-checks and venue second lines agree, with the wallet bypassed ${live ? "four" : "three"} times`, "edge");

    // ---- 8 ------------------------------------------------------------------------
    heading("Beat 8: What open mode still asks about · the dangerous ones");
    tick();
    const p = await svc.execute("ondo", { kind: "move", asset: "USDC", amount: 300, to: STRANGER });
    show(p);
    check(isPending(p), `a move to ${STRANGER} stops on a card even in open mode (the MetaMask-beast rule: skip policy, still catch the dangerous one)`, "card");
    if (isPending(p)) {
      tick();
      const d = await svc.decide(p.approval.id, "reject");
      show(d);
      check(isRefusal(d) && d.code === "E_CARD_REJECTED", "the human rejects: the agent gets a clean E_CARD_REJECTED, nothing moved", "card");
    }
    tick();
    const bl = await svc.execute("ondo", { kind: "move", asset: "USDC", amount: 300, to: ATTACKER });
    show(bl);
    check(isRefusal(bl) && bl.code === "E_WALLET_BLOCKLIST", "a blocklisted destination is refused outright, no card, no venue call", "wallet");
    if (!live) {
      tick();
      const late = await svc.execute("polymarket", { kind: "trade", symbol: "GOV-SHUTDOWN-OCT1:YES", side: "buy", qty: 100 });
      show(late);
      check(isPending(late) && late.approval.why === "awaiting", "an order in a market that is past its close and not yet resolved also stops on a card: a 97¢ share there is not a 97% chance — the resolution can still surprise", "card");
      if (isPending(late)) {
        tick();
        const d = await svc.decide(late.approval.id, "reject");
        show(d);
        check(isRefusal(d) && d.code === "E_CARD_REJECTED", "the human rejects that one too", "card");
      }
    }
    check(svc.counters.cards === (live ? 1 : 2), live ? "exactly one card so far, and it was the stranger address" : "exactly two cards so far, both dangerous ones: the stranger address and the market past its close", "card");

    // ---- 9 ------------------------------------------------------------------------
    heading("Beat 9: Guard · one switch tightens; switch an account off, narrow another");
    svc.setMode("guard");
    tick();
    const g1 = await svc.execute("binance", { kind: "trade", symbol: "BTCUSDT", side: "sell", qty: 0.02 });
    show(g1);
    check(isPending(g1), "guard: SELL 0.02 BTC ($1,243) is above Binance's no-ask allowance $500 → card", "guard");
    if (isPending(g1)) {
      tick();
      const a = await svc.decide(g1.approval.id, "approve");
      show(a);
      check(!isRefusal(a) && a.status === "filled", "the human approves → the same intent fills at Binance", "guard");
    }
    tick();
    const g2 = await svc.execute("mastercard", { kind: "pay", merchant: "GitHub", mcc: "7372", amountUsd: 40 });
    show(g2);
    check(!isRefusal(g2) && !isPending(g2) && g2.status === "authorized", "guard: $40 is inside the card's no-ask allowance $200 → no card, authorized", "guard");
    tick();
    const cardsBefore = svc.counters.cards;
    // a little more ETH than any one venue still holds, so the order has to be split
    const ethHeld = (await svc.overview()).accounts.flatMap((a) => a.holdings.filter((h) => h.asset === "ETH").map((h) => h.amount));
    const guardQty = r2(Math.max(...ethHeld) + 0.1);
    const f9 = await pm.say(`Sell ${guardQty} ETH`);
    printFlight(f9);
    const waits = f9.legs.filter((l) => l.mark === "wait");
    check(waits.length === 1 && svc.counters.cards === cardsBefore + 1 && waits[0]!.text.includes("2 slices") && !f9.legs.some((l) => l.mark === "ok"), `guard: a split order is ONE decision — the wallet judges the whole $${(guardQty * 2440).toLocaleString("en-US")} (splitting cannot slip it under the $500 allowance), raises one card, and nothing has gone to a venue yet`, "guard");
    if (waits[0]?.approvalId) {
      tick();
      const legsBefore = f9.legs.length;
      const a9 = await svc.decide(waits[0].approvalId, "approve");
      show(a9);
      printFlight(f9, legsBefore);
      const landed = f9.legs.filter((l) => l.mark === "ok");
      check(!isRefusal(a9) && landed.length === 2 && landed.every((l) => l.text.startsWith("Approved")) && landed.map((l) => l.account).join(",") === "okx,binance", `one yes covers every slice: OKX 0.5 and Binance ${qtyText(guardQty - 0.5)} fill on the same card`, "guard");
    }
    svc.revoke("okx");
    tick();
    const rv = await svc.execute("okx", { kind: "trade", symbol: "ETH-USDT", side: "sell", qty: 0.1 });
    show(rv);
    check(isRefusal(rv) && rv.code === "E_WALLET_ACCOUNT_REVOKED", "switch OKX off: the next trade is refused at the wallet", "wallet");
    const okxRows = await svc.read("okx");
    check(okxRows.length > 0, `…and OKX still reads (${okxRows.map((h) => `${h.amount} ${h.asset}`).join(" · ")}): reads are never revoked`, "read");
    svc.setReach("ondo", ["subscribe", "redeem"]);
    tick();
    const rc = await svc.execute("ondo", { kind: "move", asset: "USDC", amount: 100, to: COLD });
    show(rc);
    check(isRefusal(rc) && rc.code === "E_WALLET_REACH", "narrow Ondo to subscribe/redeem: a move is refused as E_WALLET_REACH while subscribe still works", "wallet");
    tick();
    const sub = await svc.execute("ondo", { kind: "redeem", fund: "OUSG", amountUsd: 100 });
    show(sub);
    check(!isRefusal(sub) && !isPending(sub) && sub.status === "pending", "redeem $100 OUSG still works under the narrowed reach (inside guard's $500 no-ask allowance), T+1", "guard");

    // ---- 10 -----------------------------------------------------------------------
    heading("Beat 10: Ledger · what this proves, and what it does not");
    const chain = svc.verifyChain();
    check(chain.ok, `ledger chain verified · ${chain.rows} rows · ${svc.ledgerPath()}`, "ledger");
    const kinds = new Map<string, number>();
    for (const r of svc.rows()) kinds.set(r.kind, (kinds.get(r.kind) ?? 0) + 1);
    note(`rows by kind: ${[...kinds.entries()].map(([k, n]) => `${k} ${n}`).join(" · ")}`);
    check((kinds.get("bypass") ?? 0) === (live ? 4 : 3) && (kinds.get("card") ?? 0) >= 4, "every bypass and every card decision is a row like any other", "ledger");
    const byAgent = new Map<string, number>();
    for (const f of svc.flights) byAgent.set(f.agent.code, (byAgent.get(f.agent.code) ?? 0) + 1);
    note(`flights by agent: ${[...byAgent.entries()].map(([k, n]) => `${k} ${n}`).join(" · ")}`);
    check(byAgent.get("PM") === 7 && byAgent.get("CC") === 1 && (byAgent.get("TD") ?? 0) > 10, "the flight log tells the agents apart: seven PM flights (the page agent), one CC (Claude Code, routed by the tower), the rest TD (this script)", "flight");
    console.log("  PROVEN");
    for (const l of PROVEN) note(`  · ${l}`);
    console.log("  NOT PROVEN");
    for (const l of NOT_PROVEN) note(`  · ${l}`);
  } catch (err) {
    console.log(`FAIL threw: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    failures.push(`threw ${err instanceof Error ? err.message : String(err)}`);
  }

  heading("Summary");
  note(`accounts 8 · writes ok ${svc.counters.writes} · refusals ${svc.counters.refusals} · cards ${svc.counters.cards} · loss $0.00 (no money went anywhere the user had not agreed to)`);
  note(`ledger ${svc.ledgerPath()}`);
  if (server && flag("--hold")) {
    note(`holding the page open at ${server.url} (Ctrl-C to stop)`);
    await new Promise<void>((resolve) => process.once("SIGINT", () => resolve()));
  }
  await server?.close();
  if (failures.length) {
    console.log(`\nFAILED ASSERTIONS (${failures.length}):`);
    for (const f of failures) console.log(`  - ${f}`);
    return 1;
  }
  console.log("\nALL PORTFOLIO ASSERTIONS PASSED");
  return 0;
}

main().then(
  (c) => process.stdout.write("", () => process.exit(c)),
  (err) => {
    console.error(err);
    process.stdout.write("", () => process.exit(1));
  },
);
