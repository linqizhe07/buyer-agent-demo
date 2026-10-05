/* The statement page: it renders /api/overview and decides nothing the service did not. */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const money = (n) => "$" + Math.round(Number(n || 0)).toLocaleString("en-US");
const cents = (n) => "$" + Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const time = (iso) => String(iso || "").slice(11, 16);
const KIND = { cex: "CEX", rwa: "RWA", "agent-wallet": "On-chain", prediction: "Prediction", broker: "Stocks", perp: "Perp DEX" };
const CAP = { read: "Read", trade: "Trade", move: "Transfer", pay: "Pay", subscribe: "Subscribe", redeem: "Redeem" };
/* the page's own colours, so the bar follows the paper at night too */
const CLASS_COLOR = { cash: "var(--ink)", stable: "var(--sage)", crypto: "var(--orange)", event: "var(--plum)", rwa: "var(--blue)", equity: "var(--gold)" };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + "s"}`;
let O = null;
let busy = false;
let paired = false;

async function load() {
  O = await (await fetch("/api/overview")).json();
  // with the account layer mounted, this browser's device key is what answers a card, talks to the agent and opens the dial
  if (O.accountLayer && !paired) {
    paired = true;
    await Owner.ready();
  }
  render();
}

const post = (path, body) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });

/** what only the owner may do arrives as a signed action; tightening (Guard, an account off) needs no signature */
function signed(path, body) {
  if (path === "/api/approve") return Owner.act({ type: "approveCard", card: body.id, action: (O.approvals.find((a) => a.id === body.id) || {}).hash, decision: body.decision });
  if (path === "/api/say") return Owner.act({ type: "setPolicy", change: "say", value: body.text });
  if (path === "/api/restore") return Owner.act({ type: "setPolicy", change: "restore", value: body.account });
  if (path === "/api/mode" && body.mode === "open") return Owner.act({ type: "setPolicy", change: "mode", value: "open" });
  return post(path, body);
}

function render() {
  renderTop();
  renderWorth();
  renderAccounts();
  renderSay();
  renderTurns();
  $("foot").textContent = `${plural(O.accounts.filter((a) => !a.live).length, "account is a local simulation", "accounts are local simulations")}${O.live ? " · MetaMask and Polymarket read the real wallet (read-only)" : " · MetaMask and Polymarket are simulated"} · the page agent is a keyword script, not an LLM · prices, books and pools are fixed tables`;
}

function renderTop() {
  const flights = O.flights || [];
  $("pages").hidden = !O.accountLayer;
  $("stamp").textContent = `${String(O.now).slice(0, 10)} · ${plural(O.accounts.length, "account")} · AGENT ${O.mode.toUpperCase()}${O.live ? " · METAMASK LIVE" : ""}${flights.length ? ` · ${plural(flights.length, "flight")} today · ${plural((O.agents || []).length, "agent")}` : ""}`.toUpperCase();
  for (const b of $("mode").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.mode === O.mode));
  $("mode-note").textContent = O.mode === "open" ? "Open · asks only before a new address or a market past its close" : `Guard · asks above ${money(O.openness.guard.defaultCardAboveUsd)}`;
}

function renderWorth() {
  $("total").textContent = cents(O.portfolio.totalUsd);
  const pending = O.approvals.filter((a) => a.status === "pending").length;
  $("today").textContent = `Net worth · agent moved ${money(O.daily.used)} today · ${O.counters.refusals} blocked · ${pending} waiting for you`;
  $("alloc-bar").innerHTML = O.portfolio.byClass.map((c) => `<i style="width:${c.pct}%;background:${CLASS_COLOR[c.class] || "var(--dim)"}"></i>`).join("");
  $("alloc-legend").innerHTML = O.portfolio.byClass.map((c) => `<span style="color:${CLASS_COLOR[c.class] || "var(--dim)"}">■ ${esc(c.label)} ${c.pct}% · ${money(c.usd)}</span>`).join("");
  const Ld = O.ladder;
  const eta = (s) => (s <= 60 ? "instant" : s < 3600 ? `~${Math.round(s / 60)} min` : s <= 172800 ? "T+1" : `${Math.round(s / 86400)} days`);
  const rowHtml = (r) => {
    const items = r.items.map((it) => {
      const where = `${esc(it.name)} ${esc(it.asset)}${it.chain && it.chain !== Ld.hub ? ` <span class="dim">${esc(it.chain)} → ${esc(Ld.hub)}</span>` : ""}`;
      const usd = r.items.length > 1 ? ` ${money(it.usd)}` : "";
      if (r.bucket === "closed") return `${where}${usd} <span class="dim">${esc(it.route.why || "")}; if opened: ${eta(it.route.etaSec)} · ${cents(it.route.feeUsd)}</span>`;
      return `${where}${usd} <span class="dim">${esc(it.route.label)}${r.bucket === "minutes" || r.bucket === "days" ? ` ${eta(it.route.etaSec)}` : ""}</span>`;
    }).join(" · ");
    return `<div class="liq-row ${r.bucket}"><b>${esc(r.label)}</b><span class="amt mono">${money(r.usd)}</span><span class="src">${items}</span><span class="fee mono dim">${r.bucket === "closed" ? "" : cents(r.feeUsd)}</span></div>`;
  };
  $("liquidity").innerHTML = `<div class="liq-head mono dim">LIQUIDITY LADDER · how long and how much to reach ${esc(Ld.hub)}, where RWA settles</div>${Ld.rows.map(rowHtml).join("")}`;
}

function renderAccounts() {
  $("accounts").querySelector("tbody").innerHTML = O.accounts.map((a) => {
    const writesInScope = a.scope.can.filter((c) => c !== "read");
    const writes = a.reach.filter((c) => c !== "read");
    const can = !writesInScope.length ? '<span class="dim">Read only</span>' : a.revoked ? '<span class="dim">Off · read only</span>' : esc(writes.map((c) => CAP[c]).join(" · "));
    const balance = a.readError ? '<span class="dim">read failed</span>' : money(a.usd);
    const sw = !writesInScope.length ? '<span class="dim">—</span>' : `<button type="button" class="sw ${a.revoked ? "off" : "on"}" aria-pressed="${!a.revoked}" data-account="${esc(a.id)}" data-on="${a.revoked ? "0" : "1"}">${a.revoked ? "Off" : "On"}</button>`;
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
      return `<div class="line wait"><span class="t mono dim">${time(t.at)}</span><span class="mark">▣</span><span class="txt">${esc(l.text)}</span><span class="usd mono">${money(l.usd)}</span><span class="acts"><button type="button" class="warm" data-approve="${esc(l.approvalId)}">Approve</button><button type="button" data-reject="${esc(l.approvalId)}">Reject</button></span></div>${cmp}`;
    }
    const st = ap ? (ap.status === "approved" ? "approved" : "rejected") : "";
    return `<div class="line done"><span class="t mono dim">${time(t.at)}</span><span class="mark dim">▣</span><span class="txt dim">${esc(l.text)} · ${st}</span><span class="usd mono dim">${money(l.usd)}</span></div>`;
  }
  return `<div class="line ${l.mark}"><span class="t mono dim">${time(t.at)}</span><span class="mark">${l.mark === "ok" ? "✓" : "✗"}</span><span class="txt">${esc(l.text)}</span><span class="usd mono">${l.usd ? money(l.usd) : ""}</span></div>${cmp}`;
}

function renderTurns() {
  const flights = O.flights || [];
  const el = $("turns");
  if (!flights.length) {
    el.innerHTML = '<p class="dim">No flights yet. Try “Subscribe $5,000 OUSG”.</p>';
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
    await (O && O.accountLayer ? signed(path, body || {}) : post(path, body));
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
