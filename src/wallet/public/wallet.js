/* The wallet page renders /api/overview; it decides nothing the service did not. */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const money = (n) => (Number.isFinite(Number(n)) ? "$" + Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 2 }) : "∞");
const KIND_ORDER = ["cex", "dex-perp", "dex-spot", "prediction", "rwa", "broker"];
const KIND_NOTE = {
  cex: "一把 ccxt 形状的席位接 100+ 家；差别只在 API key 的权限表",
  "dex-perp": "场所自己签发 trade-only、会过期的 agent key；EVM 上则是一份委托",
  "dex-spot": "EVM 链上：委托 caveats 由链强制；Solana 没有原生委托，所以钱包插件其实是策略签名器插件",
  prediction: "订单簿在上、结算在链上或受监管的法币账户里；CLOB key 只下单，钱只经链上委托",
  rwa: "合规门控是设计：白名单、身份绑定地址、发行方可冻结；agent 的智能账户先过 KYC 才拿得到代币",
  broker: "法币 ACH 轨道，不经钱包；券商 key 钉在 paper host",
};
const ENF = { chain: ["ok", "链上强制"], venue: ["ok", "场所侧强制"], signer: ["ok", "签名器强制"], issuer: ["ok", "发行方强制"], seat: ["soft", "席位启动时核对"], wallet: ["no", "钱包侧"] };
let O = null;

async function load() {
  O = await (await fetch("/api/overview")).json();
  render();
}

function render() {
  renderHeader(); renderAccount(); renderOverview(); renderConnectors(); renderPolicy(); renderFlows();
}

function renderHeader() {
  const total = O.home.totalUsd + O.exposure.used;
  $("addr").textContent = `${O.account.smartAccount.slice(0, 10)}… · 非托管 · 用户自持`;
  $("h-total").textContent = money(total);
  $("h-exposure").textContent = `${money(O.exposure.used)} / ${money(O.exposure.cap)}`;
  const connected = O.connectors.filter((c) => c.status === "connected").length;
  $("h-connectors").textContent = `${connected} 接入 / ${O.connectors.length} 目录`;
  $("h-session").textContent = O.session.expired ? "已撤销" : `至 ${O.session.expiresAt.slice(0, 10)}`;
  const lamp = $("lamp");
  lamp.className = "lamp" + (O.session.expired ? " revoked" : "");
  lamp.innerHTML = `<i></i>${O.session.expired ? "REVOKED" : O.account.mode === "beast" ? "BEAST" : "GUARD"}`;
}

function renderAccount() {
  $("account-card").innerHTML = `<span class="who">用户</span><h3>用户智能账户</h3><div class="addr">${esc(O.account.smartAccount)}</div><p class="dim">EIP-7702 升级的 EOA；非托管；钱在这里。钱包服务进程持钥，没有任何席位拿到它的引用</p><p>在家 ${money(O.home.totalUsd)} · 在场所 ${money(O.exposure.used)}</p>`;
  $("agent-card").innerHTML = `<span class="who agent">agent</span><h3>agent 身份 · 会话钥匙</h3><div class="addr">${esc(O.account.agentKey)}</div><p class="dim">另一把钥匙、另一个地址，永远不持有资金；只能在下面的授权范围内代签，每一笔都带着它的签名可追溯</p><p>${O.grants.filter((g) => !g.revoked).length} 份授权有效 · ${O.grants.filter((g) => g.revoked).length} 份已撤销</p>`;
  const mode = O.account.mode;
  $("mode-card").innerHTML = `<h3>模式</h3><div class="modes"><button type="button" data-mode="guard" class="${mode === "guard" ? "on" : ""}">Guard</button><button type="button" data-mode="beast" class="${mode === "beast" ? "on" : ""}">Beast</button></div><p class="dim">${mode === "guard" ? "Guard：额度、协议 allowlist，且每一笔都停在一张卡上等人点" : "Beast：额度与 allowlist 照旧，只有可疑的交易才送人审（骨架里只是显示）"}</p><p class="dim small">session 至 ${esc(O.session.expiresAt.slice(0, 16).replace("T", " "))}${O.session.expired ? " · 已撤销" : ""}</p>`;
  for (const b of $("mode-card").querySelectorAll("button")) b.addEventListener("click", () => act("/api/mode", { mode: b.dataset.mode }));
  $("grants").querySelector("tbody").innerHTML = O.grants.map((g) => {
    const [cls, label] = ENF[g.enforcedBy] || ENF.wallet;
    return `<tr class="${g.revoked ? "revoked" : ""}"><td><b>${esc(g.name)}</b><br><span class="mono dim">${esc(g.venue)}</span></td><td>${esc(g.kind)}</td><td>${esc(g.scope)}</td><td class="cap">${money(g.capUsd)}</td><td class="used">${money(g.usedUsd)}</td><td class="mono">${esc(g.expiresAt.slice(0, 10))}</td><td class="enf"><span class="badge ${cls}">${label}</span></td><td class="act">${g.revoked ? '<span class="badge no">已撤销</span>' : `<button type="button" data-revoke="${esc(g.venue)}">撤销</button>`}</td></tr>`;
  }).join("");
  for (const b of $("grants").querySelectorAll("button[data-revoke]")) b.addEventListener("click", () => act("/api/revoke", { venue: b.dataset.revoke }));
}

function bar(net, cap) {
  const pct = Number.isFinite(cap) && cap ? Math.min(100, Math.round((Math.max(0, net) / cap) * 100)) : 0;
  const cls = pct >= 100 ? " full" : pct >= 75 ? " hot" : "";
  return `<div class="bar${cls}"><i style="width:${pct}%"></i></div>`;
}

function renderOverview() {
  const bals = Object.entries(O.home.balances).map(([a, n]) => `<div class="bal"><span>${esc(a)}</span><span>${Number(n).toLocaleString("en-US")}</span></div>`).join("");
  $("home-card").innerHTML = `<h3>在家 · 智能账户</h3><div class="big">${money(O.home.totalUsd)}</div>${bals}<p class="dim">稳定币按 1:1 计；非稳定币不在家里放</p>`;
  const rows = O.floats.map((f) => `<div class="float-row"><span>${esc(f.name)}</span><span class="mono">${money(f.net)} / ${money(f.cap)}</span></div>${bar(f.net, f.cap)}`).join("");
  const fiat = O.connectors.filter((c) => c.rail === "fiat" && c.seatMounted).map((c) => `<p class="dim">${esc(c.name)}：法币轨道，不经钱包</p>`).join("");
  $("floats-card").innerHTML = `<h3>在场所 · float</h3><p class="dim">每家场所只放得下策略允许的钱：它最多也只能丢这么多</p>${rows}${fiat}`;
  $("exposure-card").innerHTML = `<h3>总敞口</h3><div class="big">${money(O.exposure.used)}<span class="dim" style="font-size:14px"> / ${money(O.exposure.cap)}</span></div>${bar(O.exposure.used, O.exposure.cap)}<p class="dim">所有场所加起来，同一时刻在外面的钱；场所做不到这条，只有钱包能</p><h3 style="margin-top:10px">24 小时出金</h3><div class="big">${money(O.daily.used)}<span class="dim" style="font-size:14px"> / ${money(O.daily.cap)}</span></div>${bar(O.daily.used, O.daily.cap)}<p class="dim">提币白名单：${esc(O.policy.withdrawWhitelist.join(", "))}</p>`;
}

function renderConnectors() {
  const groups = KIND_ORDER.map((k) => {
    const cs = O.connectors.filter((c) => c.kind === k);
    if (!cs.length) return "";
    const label = cs[0].kindLabel;
    const cards = cs.map((c) => `
      <div class="card conn ${c.status}${c.revoked ? " revoked" : ""}">
        <div class="status">${c.seatMounted ? '<span class="seat-tag">席位</span>' : ""}<span class="dot ${c.status === "connected" ? "on" : "off"}"></span></div>
        <h3>${esc(c.name)}</h3>
        <div class="line">${esc(c.instrument)}${c.chain ? " · " + esc(c.chain) : ""}</div>
        <div class="line">钥匙：${esc(c.keyLabel)}</div>
        <div class="line">注资轨道：${esc(c.railLabel)}${c.rail !== "fiat" ? " · " + esc(c.asset) : ""}</div>
        ${c.targets ? `<div class="line">allowedTargets：${esc(c.targets.join(" · "))}</div>` : ""}
        <div class="native">${esc(c.native)}</div>
        <div class="float">${c.floatCap !== null ? `float ${money(c.net)} / ${money(c.floatCap)}` : c.rail === "fiat" ? "不经钱包" : "可接入 · 未配 float"}</div>
        <div class="chips"><span class="chip">${esc(c.seat)}</span><span class="chip">${esc(c.keyModel)}</span></div>
        ${c.revoked ? '<span class="rev">已撤销</span>' : ""}
      </div>`).join("");
    return `<div class="kind">${esc(label)}<small>${esc(KIND_NOTE[k])}</small></div><div class="cards">${cards}</div>`;
  }).join("");
  $("connectors").innerHTML = groups;
}

function renderPolicy() {
  const p = O.policy;
  const floats = Object.entries(p.floats).map(([v, cap]) => `<div class="policy-item"><span>float · ${esc(v)}</span><b>≤ ${money(cap)}</b></div>`).join("");
  $("policy-card").innerHTML = `<h3>一份策略</h3><p class="dim">人冷静时写的几样东西；右边每一行都从这里编译出来</p>${floats}
    <div class="policy-item"><span>总敞口</span><b>≤ ${money(p.totalExposureCapUsd)}</b></div>
    <div class="policy-item"><span>24 小时出金</span><b>≤ ${money(p.dailyCapUsd)}</b></div>
    <div class="policy-item"><span>提币白名单</span><b>${esc(p.withdrawWhitelist.join(", "))}</b></div>
    <div class="policy-item"><span>session 到期</span><b>${esc(p.sessionExpiresAt.slice(0, 16).replace("T", " "))}</b></div>
    <div class="policy-item"><span>模式</span><b>${esc(p.mode)}</b></div>
    <div class="policy-item"><span>已撤销</span><b>${p.revoked.length ? esc(p.revoked.join(", ")) : "—"}</b></div>
    <p class="dim" style="margin-top:8px">同一份策略换一家场所，只换编译规则，不换钱包</p>`;
  const status = Object.fromEntries(O.connectors.map((c) => [c.id, c.status]));
  $("compiled").querySelector("tbody").innerHTML = O.compiled.map((r) => {
    const [cls, label] = ENF[r.enforcedBy] || ENF.wallet;
    return `<tr class="${status[r.venue]}"><td><b>${esc(r.name)}</b><br><span class="mono dim">${esc(r.venue)} · ${esc(r.kind)}</span></td><td>${esc(r.keyModel)}</td><td><ul>${r.restrictions.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></td><td class="enf"><span class="badge ${cls}">${label}</span></td><td><ul>${r.walletSide.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></td></tr>`;
  }).join("");
}

function renderFlows() {
  const sel = $("f-venue");
  const prev = sel.value;
  sel.innerHTML = O.connectors.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}${c.status === "connected" ? (c.revoked ? "（已撤销）" : "") : "（目录内，未接入）"}</option>`).join("");
  if (prev) sel.value = prev;
  $("attempts").querySelector("tbody").innerHTML = (O.attempts || []).map((a) => {
    const ok = a.result === "ok";
    return `<tr class="${ok ? "ok" : "refusal"}"><td class="mono">${esc(a.at.slice(11, 19))}</td><td>${esc(a.action)}</td><td>${esc(a.venue)}</td><td class="mono">${a.amountUsd ? money(a.amountUsd) : ""}</td><td class="res">${ok ? "✓ " + esc(a.id || "ok") : "✗ " + esc(a.result)}</td><td>${esc(a.message)}</td></tr>`;
  }).join("");
}

async function act(path, body) {
  for (const b of document.querySelectorAll("button")) b.disabled = true;
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  const el = $("result");
  if (j.ok) {
    el.className = "result mono ok";
    el.textContent = j.transfer ? `✓ ${j.transfer.id} · ${j.transfer.direction === "out" ? "→" : "←"} ${j.transfer.venue} · ${j.transfer.amount} ${j.transfer.asset}${j.rail ? " · " + j.rail : ""}`
      : j.revoked ? `✓ 已撤销 ${j.revoked.join(", ")} 的授权 · float 仍可提回` : j.sessionExpiresAt ? `✓ 全部授权已撤销 · ${j.sessionExpiresAt}` : j.mode ? `✓ 模式：${j.mode}` : "✓ 已重置";
  } else if (j.refusal) {
    el.className = "result mono no";
    el.textContent = `✗ ${j.refusal.code} [${j.refusal.layer}] · ${j.refusal.message}`;
  } else {
    el.className = "result mono no";
    el.textContent = `✗ ${r.status}${j.error ? " · " + j.error : ""}`;
  }
  await load();
  for (const b of document.querySelectorAll("button")) b.disabled = false;
}

$("btn-fund").addEventListener("click", () => act("/api/fund", { venue: $("f-venue").value, amountUsd: Number($("f-amount").value), purpose: $("f-purpose").value || undefined }));
$("btn-recall").addEventListener("click", () => act("/api/recall", { venue: $("f-venue").value, amountUsd: Number($("f-amount").value), destination: $("f-dest").value }));
$("btn-revoke-all").addEventListener("click", () => act("/api/revoke"));
$("btn-reset").addEventListener("click", () => act("/api/reset"));
load();
