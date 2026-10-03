/* The statement page: it renders /api/overview and decides nothing the service did not. */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const money = (n) => "$" + Math.round(Number(n || 0)).toLocaleString("en-US");
const cents = (n) => "$" + Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const time = (iso) => String(iso || "").slice(11, 16);
const KIND = { cex: "CEX", rwa: "RWA", "agent-wallet": "链上", card: "卡", bank: "银行" };
const CAP = { read: "读", trade: "交易", move: "转出", pay: "支付", subscribe: "申购", redeem: "赎回" };
const CLASS_COLOR = { cash: "#1b1b1b", stable: "#8aa37b", crypto: "#e8702a", rwa: "#6a7fb5" };
let O = null;
let busy = false;

async function load() {
  O = await (await fetch("/api/overview")).json();
  render();
}

function render() {
  renderTop();
  renderWorth();
  renderAccounts();
  renderSay();
  renderTurns();
  $("foot").textContent = `${O.accounts.filter((a) => !a.live).length} 个账户为本地模拟${O.live ? " · MetaMask 为真钱包（只读）" : " · MetaMask 为模拟"} · 页面上的 agent 是关键词脚本，不是 LLM · 价格、订单簿与 DEX 池子为固定表`;
}

function renderTop() {
  const flights = O.flights || [];
  $("stamp").textContent = `${String(O.now).slice(0, 10)} · ${O.accounts.length} 个账户 · AGENT ${O.mode.toUpperCase()}${O.live ? " · METAMASK LIVE" : ""}${flights.length ? ` · 今天 ${flights.length} 班 · ${(O.agents || []).length} 个 agent` : ""}`;
  for (const b of $("mode").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.mode === O.mode));
  $("mode-note").textContent = O.mode === "open" ? "Open · 只有转到新地址才问你" : `Guard · 超过 ${money(O.openness.guard.defaultCardAboveUsd)} 问你`;
}

function renderWorth() {
  $("total").textContent = cents(O.portfolio.totalUsd);
  const pending = O.approvals.filter((a) => a.status === "pending").length;
  $("today").textContent = `净值 · 今天 agent 动了 ${money(O.daily.used)} · 拦下 ${O.counters.refusals} 笔 · 等你 ${pending} 笔`;
  $("alloc-bar").innerHTML = O.portfolio.byClass.map((c) => `<i style="width:${c.pct}%;background:${CLASS_COLOR[c.class] || "#5a5751"}"></i>`).join("");
  $("alloc-legend").innerHTML = O.portfolio.byClass.map((c) => `<span style="color:${CLASS_COLOR[c.class] || "#5a5751"}">■ ${esc(c.label)} ${c.pct}% · ${money(c.usd)}</span>`).join("");
  const Ld = O.ladder;
  const eta = (s) => (s <= 60 ? "即时" : s < 3600 ? `~${Math.round(s / 60)} 分钟` : s <= 172800 ? "T+1" : `${Math.round(s / 86400)} 天`);
  const rowHtml = (r) => {
    const items = r.items.map((it) => {
      const where = `${esc(it.name)} ${esc(it.asset)}${it.chain && it.chain !== Ld.hub ? ` <span class="dim">${esc(it.chain)} → ${esc(Ld.hub)}</span>` : ""}`;
      const usd = r.items.length > 1 ? ` ${money(it.usd)}` : "";
      if (r.bucket === "closed") return `${where}${usd} <span class="dim">${esc(it.route.why || "")}；若打开 ${eta(it.route.etaSec)} · ${cents(it.route.feeUsd)}</span>`;
      return `${where}${usd} <span class="dim">${esc(it.route.label)}${r.bucket === "minutes" || r.bucket === "days" ? ` ${eta(it.route.etaSec)}` : ""}</span>`;
    }).join(" · ");
    return `<div class="liq-row ${r.bucket}"><b>${esc(r.label)}</b><span class="amt mono">${money(r.usd)}</span><span class="src">${items}</span><span class="fee mono dim">${r.bucket === "closed" ? "" : cents(r.feeUsd)}</span></div>`;
  };
  $("liquidity").innerHTML = `<div class="liq-head mono dim">流动性阶梯 · 到 ${esc(Ld.hub)}（RWA 结算链）要多久、多少钱</div>${Ld.rows.map(rowHtml).join("")}`;
}

function renderAccounts() {
  $("accounts").querySelector("tbody").innerHTML = O.accounts.map((a) => {
    const writesInScope = a.scope.can.filter((c) => c !== "read");
    const writes = a.reach.filter((c) => c !== "read");
    const can = !writesInScope.length ? '<span class="dim">只读</span>' : a.revoked ? '<span class="dim">关 · 只读</span>' : esc(writes.map((c) => CAP[c]).join(" · "));
    const credit = a.holdings.find((h) => h.class === "credit");
    const balance = a.kind === "card" ? `<span class="dim">额度 ${money(credit ? credit.usd : 0)}</span>` : a.readError ? '<span class="dim">读取失败</span>' : money(a.usd);
    const sw = !writesInScope.length ? '<span class="dim">—</span>' : `<button type="button" class="sw ${a.revoked ? "off" : "on"}" aria-pressed="${!a.revoked}" data-account="${esc(a.id)}" data-on="${a.revoked ? "0" : "1"}">${a.revoked ? "关" : "开"}</button>`;
    return `<tr class="${a.revoked ? "off" : ""}"><td>${esc(a.name)}${a.live ? ' <span class="live">LIVE</span>' : ""}</td><td class="type dim">${esc(KIND[a.kind] || a.kind)}</td><td class="r mono">${balance}</td><td class="pad">${can}</td><td class="sw">${sw}</td></tr>`;
  }).join("");
  for (const b of $("accounts").querySelectorAll("button[data-account]")) b.addEventListener("click", () => act(b.dataset.on === "1" ? "/api/revoke" : "/api/restore", { account: b.dataset.account }));
}

function renderSay() {
  $("chips").innerHTML = (O.presets || []).map((p) => `<button type="button" data-say="${esc(p)}">${esc(p)}</button>`).join("");
  for (const b of $("chips").querySelectorAll("button")) b.addEventListener("click", () => say(b.dataset.say));
}

function lineHtml(l, t, byId) {
  const cmp = l.compare ? `<div class="line cmp"><span class="t"></span><span class="mark"></span><span class="txt">${esc(l.compare)}</span><span class="usd"></span></div>` : "";
  // a split order: one bar, one segment per venue, sized by its share of the order
  const split = l.parts && l.parts.length ? `<div class="line split"><span class="t"></span><span class="mark"></span><span class="txt"><span class="parts">${l.parts.map((p) => `<i class="${esc(p.kind)}" style="flex:${Math.max(p.pct, 8)}"><b></b>${esc(p.label)}</i>`).join("")}</span></span><span class="usd"></span></div>` : "";
  if (l.mark === "note") return `<div class="line note"><span class="t"></span><span class="mark">·</span><span class="txt">${esc(l.text)}</span><span class="usd"></span></div>${split}`;
  if (l.mark === "wait") {
    const ap = byId[l.approvalId];
    if (ap && ap.status === "pending") {
      return `<div class="line wait"><span class="t mono dim">${time(t.at)}</span><span class="mark">▣</span><span class="txt">${esc(l.text)}</span><span class="usd mono">${money(l.usd)}</span><span class="acts"><button type="button" class="warm" data-approve="${esc(l.approvalId)}">批准</button><button type="button" data-reject="${esc(l.approvalId)}">拒绝</button></span></div>${cmp}`;
    }
    const st = ap ? (ap.status === "approved" ? "已批准" : "已拒绝") : "";
    return `<div class="line done"><span class="t mono dim">${time(t.at)}</span><span class="mark dim">▣</span><span class="txt dim">${esc(l.text)} · ${st}</span><span class="usd mono dim">${money(l.usd)}</span></div>`;
  }
  return `<div class="line ${l.mark}"><span class="t mono dim">${time(t.at)}</span><span class="mark">${l.mark === "ok" ? "✓" : "✗"}</span><span class="txt">${esc(l.text)}</span><span class="usd mono">${l.usd ? money(l.usd) : ""}</span></div>${cmp}`;
}

function renderTurns() {
  const flights = O.flights || [];
  const el = $("turns");
  if (!flights.length) {
    el.innerHTML = '<p class="dim">还没有航班。试试「申购 5000 OUSG」。</p>';
    return;
  }
  const byId = Object.fromEntries(O.approvals.map((a) => [a.id, a]));
  el.innerHTML = flights.map((f) => `<div class="turn"><div class="line you"><span class="t mono dim">${time(f.at)}</span><span class="mark"></span><span class="txt"><span class="flight mono">${esc(f.no)}</span> ${esc(f.agent.name)} · ${esc(f.request)}</span><span class="usd"></span></div>${f.legs.map((l) => lineHtml(l, f, byId)).join("")}</div>`).join("");
  for (const b of el.querySelectorAll("button[data-approve]")) b.addEventListener("click", () => act("/api/approve", { id: b.dataset.approve, decision: "approve" }));
  for (const b of el.querySelectorAll("button[data-reject]")) b.addEventListener("click", () => act("/api/approve", { id: b.dataset.reject, decision: "reject" }));
}

async function act(path, body, after) {
  if (busy) return;
  busy = true;
  for (const b of document.querySelectorAll("button")) b.disabled = true;
  try {
    await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
    await load();
    if (after) after();
  } finally {
    busy = false;
    for (const b of document.querySelectorAll("button")) b.disabled = false;
  }
}

function say(text) {
  if (!text || !text.trim()) return;
  act("/api/say", { text: text.trim() }, () => {
    $("say").value = "";
    const last = $("turns").lastElementChild;
    if (last) last.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });
}

for (const b of $("mode").querySelectorAll("button")) b.addEventListener("click", () => act("/api/mode", { mode: b.dataset.mode }));
$("say-form").addEventListener("submit", (e) => {
  e.preventDefault();
  say($("say").value);
});
load();
setInterval(() => {
  if (!busy && document.activeElement !== $("say")) load();
}, 30000);
