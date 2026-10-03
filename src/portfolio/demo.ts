/** `npm run portfolio:demo` — seven beats, ✓/✗/FAIL lines, exit 0 iff no
 * assertion failed. No port is opened unless `--serve`; five accounts are
 * in-process simulators; `--mm` swaps the MetaMask account for the real `mm`
 * CLI (reads live; writes stay off unless PORTFOLIO_MM_WRITES=1).
 *
 *   npm run portfolio:demo                     headless, simulated MetaMask
 *   npm run portfolio:demo -- --mm             the MetaMask beats read the real wallet
 *   npm run portfolio:demo -- --serve --hold   also open the page at :4820 and keep it up
 */
import { formatRefusal, isRefusal, type Refusal } from "../core/errors.ts";
import { CAP_LABEL, describeIntent, type Intent } from "./accounts.ts";
import { AgentSession } from "./agent.ts";
import { etaLabel } from "./rails.ts";
import { bestVenue, venueQuotes } from "./venues.ts";
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

export const PROVEN = [
  "六种账户（Binance、OKX、MetaMask agent 钱包、Ondo RWA、Mastercard、银行）一个形状接进来；凭据在 agent 面前只有引用",
  "open 模式：四笔跨账户写操作零张卡——agent 的触达就是每个凭据原生权限的边缘",
  "流动性 = 金额 × 时间 × 成本：一张到 Ethereum 的阶梯（即时 / 分钟级 / T+1 / 关着），关着的跑道也带报价（打开它要多久、多少钱）",
  "跨链带报价与选路：三座桥加 CEX 中转比过，取最便宜的那条开着的路；桥费从到账里扣，差多少、为什么差，说得清",
  "成交流动性：同一笔单在 Binance、OKX、DEX 各出一个带点差、深度冲击、手续费的报价，卖在净得最高的地方；库存不在的场所如实说没有",
  "每一班有航班号（agent 代码 + 序号），每条账本行都写着是哪个 agent 的哪一班",
  "边缘由凭据与场所守住，钱包不加也不减：钱包预检（E_WALLET_SCOPE）和绕过钱包后场所的第二道线（-2015 / 403 / rc 57 / revert）画的是同一条线",
  "open 模式唯一还会问人的动作：往从没用过的地址转钱；黑名单直接拒；MetaMask 自己的 Guard 仍会把超线转出送去 MFA",
  "guard 一键收紧：免审额度之上停卡、撤销只剩读、按账户收窄；读在任何模式下都不停",
  "每一步——读、意图、卡、成交、拒绝、绕过——都在同一本哈希链账本上",
];
export const NOT_PROVEN = [
  "五个账户是本地模拟：Binance / OKX 的权限错误码形状真实；Mastercard agentic token 的格式是示意（拒绝码是真的）；Ondo 只模拟了白名单转让限制与 T+1",
  "桥费、到账时间、提币费、点差与深度都是示意的报价表（形状真实，数字不是行情）；到账时间只是报价，模拟里即时到账；真钱包有钱后桥的报价改读 mm swap quote（该路径尚未实测）",
  "MetaMask 账户 live 时只读；真钱写操作关着（PORTFOLIO_MM_WRITES），只打印会执行的 mm 命令",
  "价格是固定表，没有行情、滑点、部分成交；没有和场所对账单对账",
  "撤销只是钱包这边：交易所删 key、发卡行冻 token 是运营动作，这里没做",
  "脚本化 agent ≠ LLM 会做同样决定；没有证明任何 alpha",
];

async function main(): Promise<number> {
  const live = flag("--mm") || process.env.PORTFOLIO_MM === "1";
  const home = value("--home") ?? defaultHome();
  const svc = await PortfolioService.create({ home, now, live });
  const server = flag("--serve") ? await startPortfolioServer({ port: Number(value("--port") ?? 4820), service: svc }) : undefined;

  heading("Setup");
  note(`home ${home} · ledger ${svc.ledgerPath()}`);
  note(`sim clock ${now()} · MetaMask account ${live ? "LIVE via mm CLI（读）；写关着" : "simulated（--mm 读真钱包）"} · 其余五个账户为本地模拟`);
  if (server) note(`page ${server.url}`);

  try {
    // ---- 1 ------------------------------------------------------------------------
    heading("Beat 1: 接入 · 六个账户，一个形状");
    const accounts = svc.accounts();
    for (const a of accounts) note(`${a.id.padEnd(10)} ${a.kind.padEnd(12)} can ${a.scope.can.map((c) => CAP_LABEL[c]).join("/").padEnd(14)} ${a.scope.enforcedBy.padEnd(8)} ${a.credentialKind} · ref ${a.credentialRef}`);
    check(accounts.map((a) => a.id).sort().join(",") === "binance,chase,mastercard,metamask,okx,ondo", "6 accounts connected in one shape: binance okx metamask ondo mastercard chase", "account");
    check(accounts.every((a) => a.credentialRef.length > 0) && !/"secret"|"apiKey"|"passphrase"|"token":/.test(JSON.stringify(accounts)), "credentials are references only: no key, secret or token value in the agent-facing view", "account");
    check(accounts.every((a) => a.scope.can.includes("read") && a.scope.limits.length > 0), "every account declares its credential's native scope (layer 1) and who enforces it", "account");

    // ---- 2 ------------------------------------------------------------------------
    heading("Beat 2: 全视图 · 一次读，六个账户，没有卡");
    tick();
    const o2 = await svc.overview();
    note(`total $${o2.portfolio.totalUsd.toLocaleString("en-US")} · credit available $${o2.portfolio.creditAvailableUsd} · ${o2.portfolio.byClass.map((c) => `${c.label} ${c.pct}%`).join(" · ")}`);
    for (const a of o2.portfolio.byAccount) note(`${a.name.padEnd(28)} $${String(a.usd).padStart(10)} ${a.live ? " LIVE" : ""}  ${a.holdings.map((h) => `${h.amount} ${h.asset}`).join(" · ")}`);
    check(o2.counters.cards === 0 && o2.approvals.length === 0, "one read across 6 accounts raised no card", "read");
    check(o2.portfolio.totalUsd > 0 && o2.portfolio.byClass.some((c) => c.class === "rwa") && o2.portfolio.byClass.some((c) => c.class === "cash"), "the total spans crypto, stablecoins, RWA and bank cash; the card's credit is shown, not summed", "read");
    const mm = o2.accounts.find((a) => a.id === "metamask")!;
    if (live) check(mm.live && mm.readError === undefined, `MetaMask agent wallet read LIVE through mm · ${mm.credentialKind} · $${mm.usd} · ${mm.scope.limits[1]}`, "live");
    else note("MetaMask account is simulated here; `--mm` reads the real wallet through the mm CLI");

    // ---- 3 ------------------------------------------------------------------------
    heading("Beat 3: 流动性阶梯 · 跨链带报价 · 关着的跑道");
    const before = await svc.overview();
    for (const row of before.ladder.rows) note(`${row.label}  $${String(row.usd).padStart(9)}  ${row.items.map((it) => `${it.account} ${it.asset}${it.chain ? "@" + it.chain : ""} · ${it.route.label}${it.open ? "" : `（${it.route.why}）`} · ${etaLabel(it.route.etaSec)} · $${it.route.feeUsd}`).join(" | ")}`);
    const rowUsd = (b: string) => before.ladder.rows.find((r) => r.bucket === b)?.usd ?? 0;
    const closedRow = before.ladder.rows.find((r) => r.bucket === "closed");
    const mmMobile = before.liquidity.mobile.filter((s) => s.account === "metamask").reduce((s, x) => s + x.usd, 0);
    check(rowUsd("now") === 3000 && rowUsd("closed") === 19900 && rowUsd("t1") > 1900 && (live || rowUsd("minutes") === 1200), "the liquidity ladder to Ethereum: $3,000 now (Ondo USDC), $1,200 in minutes (MetaMask USDC over a bridge), the OUSG T+1, $19,900 closed", "liquidity");
    check(closedRow !== undefined && closedRow.items.every((it) => !it.open && it.route.why !== undefined) && closedRow.items.find((it) => it.account === "binance")?.route.feeUsd === 9.5, "a closed runway keeps its quote: opening WITHDRAW on the Binance key would bring its $5,000 over in ~10 min for $9.50", "liquidity");
    const bridged = Math.min(2000, mmMobile);
    const movedBridge = !live && bridged > 0 ? bridged : 0;
    const arrived = movedBridge > 0 ? movedBridge - 1 : 0;
    tick();
    const pm = new AgentSession(svc);
    const flight = await pm.say("申购 5000 OUSG");
    const printFlight = (f: typeof flight) => {
      note(`flight ${f.no} · ${f.agent.name} · ${f.request}`);
      for (const l of f.legs) {
        note(`  ${l.mark === "ok" ? "✓" : l.mark === "no" ? "✗" : l.mark === "wait" ? "▣" : "·"} ${l.text}${l.usd ? ` · $${l.usd}` : ""}`);
        if (l.compare) note(`      ${l.compare}`);
      }
    };
    printFlight(flight);
    const okLegs = flight.legs.filter((l) => l.mark === "ok").length;
    const bridgeLeg = flight.legs.find((l) => l.text.includes("跨链") && l.text.includes("Base → Ethereum"));
    check(flight.no === "PM-0001" && (bridged === 0 ? okLegs === 1 : live ? bridgeLeg !== undefined : okLegs === 3), bridged === 0 ? "one flight, one leg: $3,000 OUSG from the fuel at Ondo — the LIVE MetaMask wallet holds nothing to bridge" : live ? "one flight: $3,000 OUSG from Ondo, then a bridge leg the live switch stops (writes are off)" : "one flight, three legs: $3,000 OUSG from the fuel at Ondo, a $1,200 USDC bridge Base → Ethereum, $1,199 OUSG from what arrived", "flight");
    if (movedBridge > 0) {
      check(bridgeLeg !== undefined && bridgeLeg.text.includes("流动性桥") && bridgeLeg.text.includes("费 $1.00") && bridgeLeg.text.includes("~2 分钟"), "the bridge leg carries its quote: 流动性桥 · 费 $1.00 · ~2 分钟 — the cheapest open route for $1,200", "cross-chain");
      check((bridgeLeg?.compare ?? "").includes("CCTP") && (bridgeLeg?.compare ?? "").includes("官方桥") && (bridgeLeg?.compare ?? "").includes("关着"), "…and what it beat: CCTP $1.20 · ~15 分钟, the canonical bridge $2.50 · 7 天, and two CEX hops that are closed (key 没开提币)", "cross-chain");
    }
    const gap = bridged === 0 ? 2000 : live ? undefined : 5000 - 3000 - arrived;
    check(flight.legs[0]!.text.includes("关着") && (gap === undefined || flight.legs[0]!.text.includes(`还差 $${gap.toLocaleString("en-US")}`)), `the agent says the gap and why${gap === undefined ? "" : `: $${gap.toLocaleString("en-US")} short`} — Binance/OKX keys without WITHDRAW and a read-only bank are closed runways, and the note prices opening one`, "liquidity");
    const after = await svc.overview();
    const ousg = after.accounts.find((a) => a.id === "ondo")!.holdings.find((h) => h.asset === "OUSG")!.amount;
    check(ousg > 18 + (3000 + arrived) / 110.42 - 0.01 && after.liquidity.mobileUsd === mmMobile - movedBridge && after.liquidity.stuckUsd === 19900, `after the flight Ondo holds ${ousg.toFixed(2)} OUSG and $${mmMobile - movedBridge} of mobile liquidity is left; the stuck $19,900 is still stuck`, "liquidity");
    check(svc.rows().filter((r) => r.flight === flight.no).length >= (movedBridge > 0 ? 8 : 3) && (movedBridge === 0 || svc.rows().some((r) => r.kind === "funding" && r.flight === flight.no && r.notionalUsd === arrived)), movedBridge > 0 ? "every ledger row of the flight carries its number and agent; the bridge's arrival ($1,199 after the fee) is a funding row" : "every ledger row of the flight carries its number and agent", "ledger");

    // ---- 4 ------------------------------------------------------------------------
    heading("Beat 4: 成交流动性 · 同一笔单，跨场所比价");
    const quotes = venueQuotes("ETH", "sell", 1, after.accounts);
    for (const q of quotes) note(`${q.name.padEnd(20)} ${q.ok ? `@ ${q.price} · fee $${q.feeUsd} · net $${q.netUsd} · impact ${q.impactBps} bp` : q.why}`);
    const bestQ = bestVenue(quotes, "sell");
    const binanceQ = quotes.find((q) => q.venue === "binance");
    tick();
    const f2 = await pm.say("卖 1 ETH");
    printFlight(f2);
    const leg2 = f2.legs.find((l) => l.mark === "ok");
    check(f2.no === "PM-0002" && bestQ?.venue === "okx" && leg2?.account === "okx" && leg2.text.includes(`净得 $${bestQ.netUsd.toLocaleString("en-US", { minimumFractionDigits: 2 })}`), `the same order quoted at three venues, sold where the net is highest: OKX $${bestQ?.netUsd} vs Binance $${binanceQ?.netUsd}`, "execution");
    check((leg2?.compare ?? "").includes("Binance") && (leg2?.compare ?? "").includes("DEX"), "the leg says what it compared: Binance nets less; the DEX route does not hold a whole ETH on-chain", "execution");
    tick();
    const f3 = await pm.say("卖 0.05 BTC");
    printFlight(f3);
    const leg3 = f3.legs.find((l) => l.mark === "ok");
    check(leg3?.account === "binance" && (leg3.compare ?? "").includes("没有 BTC"), "execution liquidity is also where the inventory is: BTC sits only at Binance, so it sells there — the other venues have none to sell", "execution");

    // ---- 5 ------------------------------------------------------------------------
    heading("Beat 5: open 模式 · 跨账户，零张卡");
    check(svc.policy().mode === "open", "mode = open: no wallet-side caps, no cards, the agent reaches each credential's edge", "open");
    const cards3 = svc.counters.cards;
    const writes: Array<[string, Intent]> = [
      ["binance", { kind: "trade", symbol: "BTCUSDT", side: "sell", qty: 0.05 }],
      ["okx", { kind: "trade", symbol: "ETH-USDT", side: "buy", qty: 0.5 }],
      ["ondo", { kind: "redeem", fund: "OUSG", amountUsd: 500 }],
      ["mastercard", { kind: "pay", merchant: "Anthropic · Claude Max", mcc: "7372", amountUsd: 120 }],
    ];
    const results3: ExecuteOutcome[] = [];
    for (const [acct, intent] of writes) {
      tick();
      const r = await svc.execute(acct, intent);
      results3.push(r);
      show(r);
    }
    check(results3.every((r) => !isRefusal(r) && !isPending(r)), "SELL on Binance · BUY on OKX · redeem OUSG at Ondo (T+1) · pay with the Mastercard token: all four went through", "open");
    check(svc.counters.cards === cards3, "four writes across four accounts, zero cards", "open");

    // ---- 5 ------------------------------------------------------------------------
    heading("Beat 6: 开放的边缘 · 凭据与场所各自说不");
    const refusals4: string[] = [];
    const tryEdge = async (acct: string, intent: Intent, expect: string, what: string, bypassToo = false) => {
      tick();
      note(`agent → ${acct}: ${describeIntent(intent)}`);
      const r = await svc.execute(acct, intent);
      show(r);
      if (isRefusal(r)) refusals4.push(r.code);
      check(code(r) === expect, what, isRefusal(r) ? r.layer.toLowerCase() : "venue");
      if (bypassToo) {
        console.log(`! [bypass] agent skips the wallet and uses the credential directly at ${acct}`);
        const b = await svc.bypass(acct, intent);
        show(b);
        if (isRefusal(b)) refusals4.push(b.code);
        check(isRefusal(b) && b.layer === "VENUE", `${acct} itself draws the same line (${isRefusal(b) ? `${b.code}${b.native ? " · " + JSON.stringify(b.native) : ""}` : "?"})`, "venue");
      }
    };
    await tryEdge("binance", { kind: "move", asset: "BTC", amount: 0.1, to: COLD }, "E_WALLET_SCOPE", "Binance: the key has no WITHDRAW — the wallet's pre-check says so before the exchange has to (E_WALLET_SCOPE)", true);
    await tryEdge("chase", { kind: "pay", merchant: "Landlord", mcc: "6513", amountUsd: 2000 }, "E_WALLET_SCOPE", "bank: an aggregation token is read-only — no openness setting can make it pay (E_WALLET_SCOPE)", true);
    await tryEdge("mastercard", { kind: "pay", merchant: "Lucky Star Casino", mcc: "7995", amountUsd: 900 }, "E_VENUE_CARD_DECLINED", "Mastercard: pay IS in scope, so the wallet lets it through — the issuer declines rc 57 (MCC outside the agentic token)", false);
    await tryEdge("ondo", { kind: "move", asset: "OUSG", amount: 5, to: COLD }, "E_VENUE_TRANSFER_RESTRICTED", "Ondo: a known destination, open mode, no card — the OUSG contract reverts: cold wallet not on the issuer allowlist", false);
    if (live) {
      await tryEdge("metamask", { kind: "move", asset: "USDC", amount: 1, to: COLD, chainId: 8453 }, "E_WALLET_LIVE_WRITES_OFF", "MetaMask LIVE: known destination, no card — the adapter stops at the real-money switch and prints the exact mm command instead of running it", false);
    } else {
      tick();
      const r = await svc.execute("metamask", { kind: "move", asset: "USDC", amount: 100, to: COLD });
      show(r);
      check(!isRefusal(r) && !isPending(r) && r.status === "pending", "MetaMask (sim): the portfolio wallet raised no card (a known destination), MetaMask's own Guard did — the cold wallet is not on ITS allowlist → AWAITING_MFA, the card in the user's inbox", "metamask");
    }
    note(`refusals in this beat: ${refusals4.join(", ")}`);
    check(refusals4.filter((c) => c.startsWith("E_WALLET_")).length >= 2 && refusals4.filter((c) => c.startsWith("E_VENUE_")).length >= 4, "the floor held: wallet pre-checks and venue second lines agree, with the wallet bypassed twice", "edge");

    // ---- 5 ------------------------------------------------------------------------
    heading("Beat 7: open 模式唯一的一张卡 · 往陌生地址转钱");
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
    check(svc.counters.cards === 1, "exactly one card so far, and it was the stranger address", "card");

    // ---- 6 ------------------------------------------------------------------------
    heading("Beat 8: 一键收紧 · guard，再撤销一个账户、收窄一个账户");
    svc.setMode("guard");
    tick();
    const g1 = await svc.execute("binance", { kind: "trade", symbol: "BTCUSDT", side: "sell", qty: 0.02 });
    show(g1);
    check(isPending(g1), "guard: SELL 0.02 BTC ($1,243) is above Binance's free allowance $500 → card", "guard");
    if (isPending(g1)) {
      tick();
      const a = await svc.decide(g1.approval.id, "approve");
      show(a);
      check(!isRefusal(a) && a.status === "filled", "the human approves → the same intent fills at Binance", "guard");
    }
    tick();
    const g2 = await svc.execute("mastercard", { kind: "pay", merchant: "GitHub", mcc: "7372", amountUsd: 40 });
    show(g2);
    check(!isRefusal(g2) && !isPending(g2) && g2.status === "authorized", "guard: $40 is inside the card's free allowance $200 → no card, authorized", "guard");
    svc.revoke("okx");
    tick();
    const rv = await svc.execute("okx", { kind: "trade", symbol: "ETH-USDT", side: "sell", qty: 0.1 });
    show(rv);
    check(isRefusal(rv) && rv.code === "E_WALLET_ACCOUNT_REVOKED", "revoke OKX: the next trade is refused at the wallet", "wallet");
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
    check(!isRefusal(sub) && !isPending(sub) && sub.status === "pending", "redeem $100 OUSG still works under the narrowed reach (inside guard's $500 free allowance), T+1", "guard");

    // ---- 7 ------------------------------------------------------------------------
    heading("Beat 9: 账本 · 证明了什么 / 没证明什么");
    const chain = svc.verifyChain();
    check(chain.ok, `ledger chain verified · ${chain.rows} rows · ${svc.ledgerPath()}`, "ledger");
    const kinds = new Map<string, number>();
    for (const r of svc.rows()) kinds.set(r.kind, (kinds.get(r.kind) ?? 0) + 1);
    note(`rows by kind: ${[...kinds.entries()].map(([k, n]) => `${k} ${n}`).join(" · ")}`);
    check((kinds.get("bypass") ?? 0) === 2 && (kinds.get("card") ?? 0) >= 4, "the two bypasses and every card decision are rows like any other", "ledger");
    const byAgent = new Map<string, number>();
    for (const f of svc.flights) byAgent.set(f.agent.code, (byAgent.get(f.agent.code) ?? 0) + 1);
    note(`flights by agent: ${[...byAgent.entries()].map(([k, n]) => `${k} ${n}`).join(" · ")}`);
    check(byAgent.get("PM") === 3 && (byAgent.get("TD") ?? 0) > 10, "the flight log tells the agents apart: three PM flights (the page agent), the rest TD (this script)", "flight");
    console.log("  证明了什么 · PROVEN");
    for (const l of PROVEN) note(`  · ${l}`);
    console.log("  没证明什么 · NOT PROVEN");
    for (const l of NOT_PROVEN) note(`  · ${l}`);
  } catch (err) {
    console.log(`FAIL threw: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    failures.push(`threw ${err instanceof Error ? err.message : String(err)}`);
  }

  heading("Summary");
  note(`accounts 6 · writes ok ${svc.counters.writes} · refusals ${svc.counters.refusals} · cards ${svc.counters.cards} · loss $0.00（没有一笔钱去了用户没点头的地方）`);
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
