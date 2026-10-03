/* The control room renders the bus; it computes nothing the runner did not say. */
const STAGES = [
  ["intent", "意图"], ["contract", "清单分类"], ["mandate", "授权书"], ["card", "审批卡"],
  ["signer", "签名 · 密钥"], ["venue", "市场"], ["ledger", "账本"],
];
const S = {
  meta: null, run: {}, clock: "–", plugins: {}, pipeline: null, card: null, cards: [], ledger: [],
  recon: {}, beat: null, lines: [], refusals: [], trace: [], summary: null, agentKey: null, done: false, lastRead: {},
};
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const short = (s, n = 10) => (s && String(s).length > n ? String(s).slice(0, n) + "…" : String(s ?? ""));
const money = (n) => "$" + Number(n || 0).toFixed(2);

fetch("/meta.json").then((r) => r.json()).then((meta) => {
  S.meta = meta;
  for (const m of meta.manifests) S.plugins[m.venue] = { ...m, status: "pending" };
  renderAll();
  connect();
});

function connect() {
  const es = new EventSource("/events");
  es.onmessage = (ev) => {
    const e = JSON.parse(ev.data);
    if (e.type === "ready") return;
    try { apply(e); } catch (err) { console.error("bad event", e.type, err); }
    renderAll();
  };
  es.onerror = () => { $("lamp").textContent = "RECONNECTING"; };
}

/** a new run on the same page (the runner restarted) starts from a clean slate */
function resetRun() {
  Object.assign(S, { run: {}, clock: "–", pipeline: null, card: null, cards: [], ledger: [], recon: {}, beat: null, lines: [], refusals: [], trace: [], summary: null, agentKey: null, done: false, lastRead: {}, wallet: null });
  for (const v of Object.keys(S.plugins)) S.plugins[v] = { ...S.plugins[v], status: "pending", refusal: undefined };
}

function pushRefusal(r, extra = {}) {
  if (!r) return;
  S.refusals.push({ ...r, ...extra });
  S.lines.push({ cls: "no", text: `✗ ${r.code}${r.venue ? " [" + r.venue + "]" : ""} · ${r.message}` });
}

function apply(e) {
  if (e.simAt) S.clock = e.simAt.replace("T", " ").replace(".000Z", "Z");
  const d = e.data || {};
  switch (e.type) {
    case "run/start": resetRun(); S.run = d; break;
    case "plugin/spawn": S.plugins[d.venue] = { ...(S.plugins[d.venue] || {}), status: "spawning", envNames: d.envNames, credentialRef: d.credentialRef }; break;
    case "plugin/mounted": S.plugins[d.venue] = { ...(S.plugins[d.venue] || {}), ...d, status: "mounted" }; break;
    case "plugin/refused": S.plugins[d.venue] = { ...(S.plugins[d.venue] || {}), status: "refused", refusal: d.refusal }; pushRefusal(d.refusal); break;
    case "beat/start": S.beat = d; S.lines.push({ cls: "head", text: `==== Scenario ${d.index}: ${d.title}` }); break;
    case "beat/check": S.lines.push({ cls: d.ok ? "ok" : "fail", text: `${d.ok ? "✓" : "FAIL"} ${d.layer ? "[" + d.layer + "] " : ""}${d.what}` }); break;
    case "tool/call":
      if (d.cls === "write") S.pipeline = { venue: d.venue, tool: d.tool, intentId: d.intentId, callId: d.callId, stage: "intent", refusedAt: null, code: null, note: "" };
      else S.lastRead = { venue: d.venue, tool: d.tool, at: Date.now() };
      break;
    case "constraint/applied": if (S.pipeline) { S.pipeline.stage = "contract"; S.pipeline.note = `合同改写：${d.rewrite.arg} ${d.rewrite.from ?? "空"} → ${d.rewrite.to}（${d.rewrite.id}）`; } break;
    case "constraint/skipped": if (S.pipeline) { S.pipeline.stage = "contract"; S.pipeline.note = `演示：先不吸收约束 ${d.pending.join(", ")}，看场所怎么说`; } break;
    case "mandate/refused": if (!d.refusal) break; if (S.pipeline) { S.pipeline.stage = "mandate"; S.pipeline.refusedAt = "mandate"; S.pipeline.code = d.refusal.code; } pushRefusal(d.refusal); break;
    case "approval/asked": if (S.pipeline) S.pipeline.stage = "card"; S.card = d.card; break;
    case "approval/decided": S.cards.push({ id: d.cardId, outcome: d.outcome, by: d.by }); if (S.card && S.card.id === d.cardId) S.card = null; if (d.outcome === "rejected" && S.pipeline) { S.pipeline.refusedAt = "card"; S.pipeline.code = "E_CARD_REJECTED"; } break;
    case "card/rejected": pushRefusal({ code: "E_CARD_REJECTED", layer: "CARD", venue: d.venue, message: "人拒绝了这张卡，agent 收到干净错误，不重试" }); break;
    case "gate/denied": if (!d.refusal) break; if (S.pipeline) { S.pipeline.refusedAt = "card"; S.pipeline.code = d.refusal.code; } pushRefusal(d.refusal); break;
    case "tool/refused":
      pushRefusal(d.refusal);
      if (d.refusal && d.refusal.code === "E_MOUNT_TOOL_NOT_MOUNTED") S.pipeline = { venue: d.venue, tool: d.tool, intentId: d.intentId, callId: d.callId, stage: "contract", refusedAt: "contract", code: d.refusal.code, note: "工具不在挂载面：清单没有挂它" };
      break;
    case "signer/refused": if (!d.refusal) break; if (S.pipeline && !d.direct) { S.pipeline.stage = "signer"; S.pipeline.refusedAt = "signer"; S.pipeline.code = d.refusal.code; } pushRefusal(d.refusal, { direct: !!d.direct }); break;
    case "venue/refused": {
      if (!d.refusal) break;
      const wallet = d.refusal.layer === "WALLET";
      if (S.pipeline && !d.bypass && !d.operator) { S.pipeline.stage = wallet ? "signer" : "venue"; S.pipeline.refusedAt = wallet ? "signer" : "venue"; S.pipeline.code = d.refusal.code; }
      pushRefusal(d.refusal, { bypass: !!d.bypass, operator: !!d.operator });
      break;
    }
    case "tool/result": if (S.pipeline && d.callId === S.pipeline.callId) { S.pipeline.stage = "venue"; S.pipeline.note = `场所回了 ${d.outcome}${d.venueOrderId ? " · " + d.venueOrderId : ""}`; } break;
    case "ledger/row": S.ledger.push(d); if (S.pipeline && d.callId === S.pipeline.callId && d.kind === "venue") S.pipeline.stage = "ledger"; break;
    case "reconcile/result": S.recon[d.venue] = d; break;
    case "summary/final": S.summary = d; break;
    case "summary": S.done = true; break;
    case "agent-wallet/approved": S.agentKey = d; break;
    case "wallet/funded": case "wallet/received": case "wallet/refused": S.wallet = { address: d.address, balances: d.balances, floats: d.floats, last: e.type }; break;
    case "funding/withdrawn": S.lines.push({ cls: "ok", text: `  ← ${d.venue} · $${d.amount} ${d.asset} back to the wallet` }); break;
    case "agent/trace": S.trace.push(d); S.lines.push({ cls: "trace", text: `  agent → ${d.line}` }); break;
    default: break;
  }
}

function counters() {
  const fills = S.ledger.filter((r) => r.kind === "venue" && /fill|confirmed/i.test(r.outcome || "")).length;
  const diff = Object.values(S.recon).some((r) => !r.ok);
  return { fills, refusals: S.refusals.length, loss: diff ? "diff!" : money(0) };
}

function renderAll() {
  if (!S.meta) return;
  const c = counters();
  $("c-fills").textContent = c.fills; $("c-refusals").textContent = c.refusals; $("c-loss").textContent = c.loss;
  $("clock").textContent = S.clock; $("run-id").textContent = `run ${S.run.home ? short(S.run.home.split("/").pop(), 24) : "–"}`;
  $("driver").textContent = `driver: ${S.run.driver || "scripted"} · answerer: ${S.meta.live ? "human" : "stand-in"}`;
  const lamp = $("lamp"); lamp.className = "lamp" + (S.card ? " live" : ""); lamp.innerHTML = `<i></i>${S.card ? "LIVE · 等你点卡" : S.done ? "DONE" : "RUNNING"}`;
  $("beat").textContent = S.beat ? `Scenario ${S.beat.index} · ${S.beat.title}` : "–";
  renderFive(); renderPlugins(); renderPipeline(); renderLedger(); renderRecon(); renderDecisions(); renderRefusals(); renderChecks(); renderCard();
}

function renderFive() {
  const mounted = Object.values(S.plugins).filter((p) => p.status === "mounted").length;
  const mandates = (S.meta.mandates || []);
  const items = [
    ["身份", "凭据引用，值在 agent 之外", `ref://alpaca/paper 等 ${Object.values(S.plugins).filter((p) => p.credentialRef).length} 条引用 · 子进程环境 scrub KEY/SECRET/TOKEN`, "home · 操作员"],
    ["钱包", "用户主钱包，非托管，在 agent 之外", S.wallet ? `USDT ${S.wallet.balances.USDT} · USDC ${S.wallet.balances.USDC} · float binance ${S.wallet.floats.binance ? S.wallet.floats.binance.net + "/" + S.wallet.floats.binance.cap : "–"} · hyperliquid ${S.wallet.floats.hyperliquid ? S.wallet.floats.hyperliquid.net + "/" + S.wallet.floats.hyperliquid.cap : "–"}` : `agent 只能申请注资；提币白名单 = 主钱包地址${S.agentKey ? " · HL agent key 由主账户签发" : ""}`, "用户"],
    ["席位", "一个 MCP stdio 进程", `${mounted} 个席位已挂载 · 读 ${Object.values(S.plugins).reduce((s, p) => s + (p.read ? p.read.length : 0), 0)} 写 ${Object.values(S.plugins).reduce((s, p) => s + (p.write ? p.write.length : 0), 0)}`, "agent"],
    ["账本", "只追加 · sha256(prev + row)", `${S.ledger.length} 行 · 拒绝也是一行`, "face · 操作员可读"],
    ["授权书", "人签，含到期", mandates.length ? mandates.map((m) => `${m.venue} ${money(m.spentUsd)}/${money(m.notionalLimitUsd)}`).join(" · ") : "（回放模式不载入授权书）", "操作员"],
  ];
  $("five").innerHTML = items.map(([h, sub, body, who]) => `<div class="card"><span class="who ${who === "agent" ? "agent" : ""}">${esc(who)}</span><h3>${h}</h3><p class="dim">${esc(sub)}</p><p>${esc(body)}</p></div>`).join("");
}

function renderPlugins() {
  const order = ["wallet", "alpaca", "hyperliquid", "binance", "solana", "rogue-yield"];
  $("plugins").innerHTML = order.filter((v) => S.plugins[v]).map((v) => {
    const p = S.plugins[v];
    const refused = p.status === "refused";
    const flash = S.lastRead.venue === v && Date.now() - S.lastRead.at < 1500 ? S.lastRead.tool.split("__").pop() : null;
    const chips = (p.tools ? [...p.tools.read.map((t) => [t, "r"]), ...p.tools.write.map((t) => [t, "w"]), ...p.tools.deny.map((t) => [t, "d"])] : [])
      .map(([t, k]) => `<span class="chip ${k}${flash === t ? " flash" : ""}">${k === "w" ? "✎ " : k === "d" ? "⊘ " : ""}${esc(t)}</span>`).join("");
    const key = v === "hyperliquid" && S.agentKey ? `<p class="keyline">agent key 有效至 ${esc(new Date(S.agentKey.validUntil).toISOString().slice(11, 19))}（场所侧强制）</p>` : "";
    return `<div class="card ${refused ? "refused" : ""}"><h3>${esc(p.title.replace(/（.*$/, ""))}</h3>
      <p class="dim">${esc(p.status === "mounted" ? "seat pid " + p.pid : p.status === "refused" ? (p.refusal ? p.refusal.code : "refused") : p.status)}</p>
      <p>${esc(p.native)}</p><p class="keyline">钥匙：${esc(p.keyLives)}</p>${p.limits ? `<p class="limits">限制：${esc(p.limits)}</p>` : ""}${key}<div class="chips">${chips}</div></div>`;
  }).join("");
}

function renderPipeline() {
  const p = S.pipeline;
  const idx = p ? STAGES.findIndex(([k]) => k === p.stage) : -1;
  $("pipeline").innerHTML = STAGES.map(([k, label], i) => {
    let cls = "station";
    if (p && p.refusedAt === k) cls += " no";
    else if (p && k === "card" && S.card) cls += " wait";
    else if (p && i <= idx) cls += " lit";
    const small = p && p.refusedAt === k ? p.code : p && i <= idx && k === "intent" ? short(p.intentId, 12) : "";
    return `<div class="${cls}">${label}<small>${esc(small)}</small></div>`;
  }).join("");
  $("pipe-line").textContent = p ? `[${p.venue}] ${p.tool.split("__").pop()} · ${p.callId}${p.note ? " · " + p.note : ""}${p.refusedAt ? " · 停在「" + (STAGES.find(([k]) => k === p.refusedAt) || [])[1] + "」" : ""}` : "等待第一笔写操作";
  $("trace").innerHTML = S.trace.slice(-3).map((t) => `<div class="${t.poisoned ? "poison" : ""}">agent → ${esc(t.line)}</div>`).join("");
}

function renderLedger() {
  const rows = S.ledger.slice(-80).reverse();
  $("ledger").querySelector("tbody").innerHTML = rows.map((r) => {
    const refusal = /refusal$/.test(r.kind) || (r.kind === "bypass" && r.outcome === "refused");
    const fill = r.kind === "venue" && /fill|confirmed/i.test(r.outcome || "");
    return `<tr class="${refusal ? "refusal" : fill ? "fill" : ""}"><td>${r.seq}</td><td class="mono">${esc((r.ts || "").slice(11, 19))}</td><td>${esc(r.venue)}</td><td class="mono">${esc(r.intentId || "")}</td><td class="kind">${esc(r.kind)}</td><td>${esc(r.code || r.outcome || "")}</td><td>${r.notionalUsd ? money(r.notionalUsd) : ""}</td><td class="hash">${esc(short(r.prev, 8))}</td></tr>`;
  }).join("");
}

function renderRecon() {
  const order = ["alpaca", "hyperliquid", "binance", "solana", "wallet"];
  $("reconcile").innerHTML = order.map((v) => {
    const r = S.recon[v];
    if (!r) return `<div class="card"><span class="tick">·</span><h3>${v}</h3><p class="dim">等待对账</p></div>`;
    if (v === "wallet") return `<div class="card ${r.ok ? "ok" : "diff"}"><span class="tick">${r.ok ? "✓" : "✗"}</span><h3>wallet</h3><p>注入 $${r.flows.outBn + r.flows.outHl} = 场所入账 · 提回 $${r.flows.inBn + r.flows.inHl} = 场所提出</p><p class="dim">提币只回主钱包地址</p></div>`;
    return `<div class="card ${r.ok ? "ok" : "diff"}"><span class="tick">${r.ok ? "✓" : "✗"}</span><h3>${v}</h3><p>账本 ${r.ledgerFills} 笔 ↔ 场所 ${r.venueFills} 笔 · 匹配 ${r.matched}</p><p>拒绝 ${r.refusals} · 旁路尝试 ${r.bypassAttempts} · 场所提币 ${r.venueWithdrawals}</p><p class="dim">缺 ${r.missingAtVenue.length} · 多 ${r.unknownAtVenue.length}</p></div>`;
  }).join("");
}

function renderDecisions() {
  const rows = S.meta.decisions.map((d) => `<tr><td><b>${d.id}</b> ${esc(d.question)}</td>${d.options.map((o, i) => `<td class="${i === d.recommended ? "rec" : ""}">${esc(o)}</td>`).join("")}</tr>`).join("");
  $("decisions").innerHTML = `<table><thead><tr><th>决定</th><th>推荐</th><th>备选</th></tr></thead><tbody>${rows}</tbody></table>`;
  const li = (xs) => xs.map((x) => `<li>${esc(x)}</li>`).join("");
  $("proof").innerHTML = `<div class="card"><h3>已证明</h3><ul>${li(S.meta.proven)}</ul></div><div class="card"><h3>没证明</h3><ul>${li(S.meta.notProven)}</ul></div><div class="card"><h3>去 mainnet 的顺序</h3><ol style="padding-left:18px;font-size:13px">${li(S.meta.next)}</ol></div>`;
}

function renderRefusals() {
  $("refusals").querySelector("tbody").innerHTML = S.refusals.map((r, i) => `<tr><td>${i + 1}</td><td class="layer">${esc(r.layer)}</td><td class="code">${esc(r.code)}</td><td>${esc(r.venue || "")}${r.bypass ? " <span class='badge'>旁路</span>" : ""}${r.direct ? " <span class='badge'>直接递给签名器</span>" : ""}</td><td>${esc(r.message)}${r.native ? ` <span class="dim mono">${esc(short(typeof r.native === "string" ? r.native : (r.native.msg || r.native.message || r.native.response || JSON.stringify(r.native)), 90))}</span>` : ""}</td></tr>`).join("");
}

function renderChecks() {
  const el = $("checks");
  el.innerHTML = S.lines.slice(-200).map((l) => `<span class="${l.cls}">${esc(l.text)}</span>`).join("\n");
  el.scrollTop = el.scrollHeight;
}

function renderCard() {
  const m = $("modal");
  const c = S.card;
  if (!c) { m.classList.add("hidden"); return; }
  m.classList.remove("hidden");
  $("card-id").textContent = `${c.id} · ${c.callId}`;
  $("card-line").textContent = c.line;
  const rw = Object.fromEntries((c.rewrites || []).map((r) => [r.arg, r]));
  const rows = [["市场", c.venue], ["动作", c.raw]];
  for (const [k, v] of Object.entries(c.fields || {})) rows.push([k, v, rw[k]]);
  rows.push(["名义额", money(c.notionalUsd)]);
  $("card-fields").innerHTML = rows.map(([k, v, r]) => r
    ? `<tr><td>${esc(k)}</td><td class="diff"><span class="from">${esc(r.from ?? "空")}</span><span class="to">${esc(r.to)}</span> <span class="dim">改写 · ${esc(r.id)}</span></td></tr>`
    : `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("");
  $("card-meta").textContent = `${c.mandate ? `授权书 ${c.mandate.id} 余额 ${money(c.mandate.remainingUsd)} · ` : "无授权书 · "}将发出内容的 hash ${short(c.argsHash, 16)} · ${c.askedAt}`;
  const live = S.meta.live;
  $("btn-approve").disabled = !live; $("btn-reject").disabled = !live;
  $("card-note").textContent = live ? "你看到的就是要签出去的；改过的单子已经高亮" : "无头运行：替身在答卡";
}

async function decide(outcome) {
  if (!S.card) return;
  $("btn-approve").disabled = true; $("btn-reject").disabled = true;
  const r = await fetch("/approve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cardId: S.card.id, outcome }) });
  if (!r.ok) { $("card-note").textContent = `答卡失败：${(await r.json()).error}`; $("btn-approve").disabled = false; $("btn-reject").disabled = false; }
}
$("btn-approve").addEventListener("click", () => decide("allowed-once"));
$("btn-reject").addEventListener("click", () => decide("rejected"));
setInterval(() => { if (S.meta && S.lastRead.at && Date.now() - S.lastRead.at < 1600) renderPlugins(); }, 400);
