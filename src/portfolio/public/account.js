/* The Account page: it renders /api/account and signs what the owner asks for. It decides nothing the account did not. */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const money = (n) => "$" + Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/* only an address is shortened; a merchant id or a host is shown whole */
const short = (a) => (/^0x[0-9a-fA-F]{16,}$/.test(String(a)) ? `${String(a).slice(0, 8)}…${String(a).slice(-4)}` : String(a));
/* a payment to an API can be a cent or less: show what it was, not $0.00 */
const fine = (n) => (n && Math.abs(n) < 0.01 ? "$" + Number(n).toFixed(6).replace(/0+$/, "") : money(n));
const SPEAKS = { x402: "x402", "mpp-charge": "MPP · charge", "mpp-session": "MPP · session", acp: "ACP · card", ap2: "AP2 · mandates" };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + "s"}`;
const ny = (iso, opts) => new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", ...opts }).format(new Date(iso));
const nyDay = (iso) => ny(iso, { weekday: "short", day: "numeric", month: "short" }).replace(",", "");
const nyTime = (iso) => ny(iso, { hour: "2-digit", minute: "2-digit", hour12: false });
const ZERO = "0x0000000000000000000000000000000000000000";
const DAY = 86_400_000;
const TABS = [["balances", "Balances"], ["runways", "Runways"], ["payments", "Payments"], ["keys", "Agent keys"], ["approvals", "Approvals"], ["subs", "Sub-accounts"], ["signers", "Signers"]];
const WHO = { agent: "Agent", owner: "You sign", venue: "At the venue", closed: "Closed" };
let A = null;
let tab = TABS.some(([id]) => id === location.hash.slice(1)) ? location.hash.slice(1) : "balances";
let busy = false;
let flash = "";
let said = "";

const nameOf = (id) => (A.venues.find((v) => v.id === id) || {}).name || (String(id).startsWith("sub:") ? `float “${String(id).slice(4)}”` : id);
const keyName = (address) => (A.keys.find((k) => k.address === address) || {}).name || short(address);
const nowMs = () => Date.parse(A.now);
const lands = (iso) => (nyDay(iso) === nyDay(A.now) ? nyTime(iso) : nyDay(iso));

async function load() {
  const r = await fetch("/api/account");
  if (r.status === 404) {
    document.querySelector("main").innerHTML = '<p class="dim">This server runs the original eight accounts without the account layer (<span class="mono">--classic</span>). <a href="/">Back to the statement</a>.</p>';
    return;
  }
  A = await r.json();
  // the service was restarted under this page: it no longer knows this browser's key, so offer it again
  if (Owner.kid && !A.signers.owners.some((o) => o.id === `device:${Owner.kid}`) && !A.signers.pendingDevices.some((d) => d.kid === Owner.kid)) {
    await Owner.ready();
    A = await (await fetch("/api/account")).json();
  }
  render();
}

/** one owner action: prepare, sign with this browser's device key, send, show what came back */
async function own(draft, then) {
  if (busy) return null;
  busy = true;
  document.body.classList.add("busy");
  try {
    const r = await Owner.act(draft);
    const refused = r.status >= 400 || (r.body.kind === "result" && r.body.result && r.body.result.ok === false);
    flash = refused ? Owner.why(r) || "Refused" : "";
    said = !refused && r.body && r.body.summary ? r.body.summary : "";
    await load();
    if (then && !refused) then(r);
    return r;
  } finally {
    busy = false;
    document.body.classList.remove("busy");
  }
}

function render() {
  const pendingPay = A.payments.filter((p) => p.status === "pending").length;
  $("stamp").textContent = `${ny(A.now, { weekday: "short", day: "numeric", month: "short", year: "numeric" }).replace(",", "")} · New York ${nyTime(A.now)} · ${plural(A.venues.length, "venue")}`.toUpperCase();
  for (const b of $("mode").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.mode === A.mode));
  $("mode-note").textContent = A.mode === "open" ? "Open · an agent key still needs your approval to move anything" : "Guard · asks above the no-ask limit";
  $("total").textContent = money(A.totalUsd);
  $("sub").textContent = `Across ${plural(A.venues.length, "venue")}${A.inFlightUsd ? ` · ${money(A.inFlightUsd)} in flight` : ""}${A.heldUsd ? ` · ${fine(A.heldUsd)} held in a session’s escrow` : ""} · ${plural(A.activeKeys, "agent key")} · ${A.cards.length} waiting for you`;
  for (const b of $("type").querySelectorAll("button")) b.setAttribute("aria-pressed", String((b.dataset.type === "unifiedAccount") === (A.type === "Unified")));
  $("type-note").textContent = A.type === "Unified" ? "Unified · an agent may leave the source to the account, along routes you approved" : "Separate · every movement names where the money comes from";
  const owner = Owner.role === "owner";
  $("banner").hidden = owner;
  $("banner").textContent = Owner.role === "pending" ? "This browser is not a signer of this account yet. The owner’s device makes it one under Signers." : owner ? "" : "This browser could not make a device key, so it can look but not sign.";
  for (const b of document.querySelectorAll("#acts button, #type button, #mode button[data-mode=open]")) b.disabled = !owner;
  renderWaiting(owner);
  const counts = { payments: pendingPay || "", keys: A.keys.filter((k) => k.status === "ok").length || "", approvals: A.spend.length + A.fees.length || "", subs: A.subAccounts.length || "", signers: A.signers.owners.length };
  $("tabs").innerHTML = TABS.map(([id, label]) => `<button type="button" role="tab" data-tab="${id}" aria-selected="${id === tab}">${label}${counts[id] ? `<span class="n">${counts[id]}</span>` : ""}</button>`).join("");
  for (const b of $("tabs").querySelectorAll("button")) b.addEventListener("click", () => { tab = b.dataset.tab; flash = ""; said = ""; history.replaceState(null, "", `#${tab}`); render(); });
  $("panel").innerHTML = `<div class="msg ${flash ? "no" : said ? "ok" : ""}" id="flash">${esc(flash || said)}</div>${PANEL[tab](owner)}`;
  WIRE[tab] && WIRE[tab]();
  $("foot").innerHTML = `${plural(A.venues.length, "venue", "venues")} and every payee are local simulations · each request is built in its venue’s own format, and signed where the account holds the key · nothing here settles anywhere <span class="clock">· simulated clock <button type="button" class="link dim" data-skip="60">+1 hour</button> <button type="button" class="link dim" data-skip="1440">+1 day</button> <button type="button" class="link dim" data-skip="4320">+3 days</button></span>`;
  for (const b of $("foot").querySelectorAll("button[data-skip]")) {
    b.disabled = !owner;
    b.addEventListener("click", () => own({ type: "setPolicy", change: "advance", value: b.dataset.skip }));
  }
}

function renderWaiting(owner) {
  const el = $("waiting");
  el.hidden = !A.cards.length;
  el.innerHTML = A.cards.map((c) => `<div class="card"><span class="mark">▣</span><span class="txt">${esc(c.reason)}<span class="dim"> · ${esc(c.flight)}${c.expiresAt ? ` · answer by ${nyTime(c.expiresAt)}` : ""}</span><details><summary>What this approval covers</summary><pre>${esc(c.shown.map((f) => `${f.name}: ${f.value}`).join("\n"))}</pre></details></span><span class="mono">${fine(c.usd)}</span><span class="btns"><button type="button" class="warm" data-card="${esc(c.id)}" data-decision="approve">Approve</button><button type="button" data-card="${esc(c.id)}" data-decision="reject">Reject</button></span></div>`).join("");
  for (const b of el.querySelectorAll("button[data-card]")) {
    b.disabled = !owner;
    b.addEventListener("click", () => {
      const c = A.cards.find((x) => x.id === b.dataset.card);
      own({ type: "approveCard", card: c.id, action: c.hash, decision: b.dataset.decision });
    });
  }
}

const runway = (l) => `<span class="${l.access === "agent" ? "" : "dim"}" title="${esc([l.why, l.opens].filter(Boolean).join(" · "))}">${esc(l.text)}</span>`;
const who = (access) => `<span class="who ${esc(access)}">${WHO[access] || access}</span>`;
const field = (label, html) => `<label>${label}${html}</label>`;
const select = (name, opts, sel) => `<select name="${name}">${opts.map(([v, l, dis]) => `<option value="${esc(v)}"${v === sel ? " selected" : ""}${dis ? " disabled" : ""}>${esc(l)}</option>`).join("")}</select>`;
const formOf = (id) => Object.fromEntries(new FormData($(id)).entries());

const PANEL = {
  balances: (owner) => `<table><thead><tr><th>Venue</th><th class="hide-s">Front line</th><th class="r">Balance</th><th>Money in</th><th>Money out</th></tr></thead><tbody>${A.venues.map((v) => `<tr><td>${esc(v.name)}${v.plugged ? `<span class="why">${esc(v.via || "plugged in")}${owner ? ` · <button type="button" class="link dim" data-unplug="${esc(v.id)}">Unplug</button>` : ""}</span>` : ""}</td><td class="dim hide-s">${esc(v.frontLine)}</td><td class="r num2">${money(v.usd)}</td>${v.restricted ? `<td colspan="2" class="dim">${esc(v.restricted)}</td>` : `<td>${runway(v.in)}</td><td>${runway(v.out)}</td>`}</tr>`).join("")}</tbody></table>
    ${A.connectable.length ? `<p class="plug dim">${plural(A.connectable.length, "more venue of yours is", "more venues of yours are")} not on this account: ${esc(A.connectable.map((c) => c.name).join(", "))}. <button type="button" class="link" id="plug-open"${owner ? "" : " disabled"}>Plug one in…</button></p>` : ""}`,

  runways: () => `<table><thead><tr><th>Runway</th><th>Carries</th><th class="r">Fee on $1,000</th><th class="r">Lands</th><th>Who</th></tr></thead><tbody>${A.venues.map((v) => `<tr><td colspan="5" class="group">${esc(v.name)}<span class="dim">${esc(v.frontLine)} · agent key here: ${esc(v.agentKey.model)}. It can ${esc(v.agentKey.can)}; it cannot ${esc(v.agentKey.cannot)}.</span></td></tr>${v.runways.length ? v.runways.map((r) => `<tr><td><b>${esc(r.dir)}</b> · ${esc(r.protocol)}${r.minUsd ? `<span class="why">at least $${r.minUsd}</span>` : ""}${!r.final && r.returnDays ? `<span class="why">can be returned for ${r.returnDays} days</span>` : ""}</td><td class="dim">${esc(r.carries)}${r.chains.length ? `<span class="why">${esc(r.chains.join(" · "))}</span>` : ""}</td><td class="r num2">${r.feeOn1000 ? money(r.feeOn1000) : "free"}</td><td class="r num2">${esc(r.lands)}</td><td>${who(r.access)}${r.why ? `<span class="why">${esc(r.why)}</span>` : ""}${r.opens ? `<span class="why">To open it: ${esc(r.opens)}</span>` : ""}</td></tr>`).join("") : '<tr><td colspan="5" class="dim">No balance to move.</td></tr>'}`).join("")}</tbody></table>`,

  payments: () => (A.payments.length ? `<table><thead><tr><th>When</th><th>What</th><th class="r">Amount</th><th class="r hide-s">Fee</th><th>Status</th><th class="hide-s">By</th></tr></thead><tbody>${A.payments.map((p) => {
    const dest = p.external ? `${p.external.label} (${p.external.chain})` : nameOf(p.to);
    const status = p.status === "pending" ? (p.heldUsd !== undefined ? "Session open" : `In flight · lands ${lands(p.settlesAt)}`) : p.status[0].toUpperCase() + p.status.slice(1);
    const by = p.authority === "agent" ? `${keyName(p.agent)}${p.flight ? ` · ${p.flight}` : ""}` : p.authority === "venue" ? `You, at ${nameOf(p.legs[0].venue)}` : "You";
    return `<tr><td class="num2 dim">${nyDay(p.at)} ${nyTime(p.at)}</td><td>${esc(p.kind[0].toUpperCase() + p.kind.slice(1))} · ${esc(nameOf(p.from))}${p.kind === "swap" ? ` · ${esc(p.sourceToken)} → ${esc(p.token)}` : ` → ${esc(dest)}`}<span class="why">${esc(p.note || p.legs.map((l) => l.protocol).join(" · "))}</span></td><td class="r num2">${fine(p.amountUsd)}${p.heldUsd !== undefined ? '<span class="why">deposit</span>' : ""}</td><td class="r num2 hide-s">${p.feeUsd ? fine(p.feeUsd) : "—"}</td><td><span class="st ${esc(p.status)}">${esc(status)}</span>${p.status === "settled" && p.authority === "venue" && !p.legs[p.legs.length - 1].final ? `<span class="why"><button type="button" class="link dim" data-return="${esc(p.id)}">simulate the bank returning it</button></span>` : ""}</td><td class="dim hide-s">${esc(by)}</td></tr>`;
  }).join("")}</tbody></table>` : '<p class="empty">Nothing has moved yet.</p>'),

  keys: (owner) => `${A.requests.length ? `<h3>Asking to be let in</h3><table><tbody>${A.requests.map((r) => `<tr><td class="num2">${esc(short(r.address))}</td><td class="dim">tried to act ${nyDay(r.at)} ${nyTime(r.at)} and is not authorised</td><td class="r"><button type="button" class="link" data-fill="${esc(r.address)}">Authorize…</button></td></tr>`).join("")}</tbody></table>` : ""}
    ${A.keys.length ? `<table><thead><tr><th>Agent</th><th>Key</th><th>Valid until</th><th>Status</th><th></th></tr></thead><tbody>${A.keys.map((k) => `<tr><td>${esc(k.name)} <span class="flight mono">${esc(k.code)}</span></td><td class="num2 dim">${esc(short(k.address))}</td><td class="num2">${nyDay(k.validUntil)}</td><td><span class="st ${k.status === "ok" ? "settled" : esc(k.status)}">${k.status === "ok" ? "Authorised" : esc(k.status)}</span></td><td class="r">${k.status === "ok" && owner ? `<button type="button" class="link" data-revoke="${esc(k.name)}">Revoke</button>` : ""}</td></tr>`).join("")}</tbody></table>` : '<p class="empty">No agent key is authorised. An agent’s key can act for this account without being able to withdraw from it.</p>'}
    <form class="add" id="key-form">${field("Name", '<input class="m" name="name" placeholder="Claude Code" required maxlength="32" />')}${field("Key address", '<input class="l" name="address" placeholder="0x…" required pattern="0x[0-9a-fA-F]{40}" />')}${field("Valid for", select("days", [["7", "7 days"], ["30", "30 days"], ["90", "90 days"], ["180", "180 days"]], "30"))}<button type="submit" class="ink"${owner ? "" : " disabled"}>Authorize key</button></form>`,

  approvals: (owner) => {
    const agents = A.keys.filter((k) => k.status === "ok").map((k) => [k.address, k.name]);
    return `<h3>Spending approvals</h3>${A.spend.length ? `<table><thead><tr><th>Agent</th><th>May</th><th class="r">Per payment</th><th class="r">Used of budget</th><th>Until</th><th></th></tr></thead><tbody>${A.spend.map((s) => `<tr><td>${esc(s.agentName)}</td><td>${s.scope === "venues" ? "move between" : "pay"} ${esc(s.allow.map((x) => (x === "*" ? "all your venues" : nameOf(x))).join(", "))}${s.windowHours ? `<span class="why">one ${s.scope === "venues" ? "refill of the same place" : "payment to the same payee"} every ${s.windowHours} h</span>` : ""}${Object.keys(s.payTo || {}).length ? `<span class="why">pays only at: ${esc(Object.entries(s.payTo).map(([h, a]) => `${h} → ${short(a)}`).join(", "))}</span>` : ""}</td><td class="r num2">${fine(s.perPaymentUsd)}</td><td class="r num2">${fine(s.spentUsd)} of ${fine(s.budgetUsd)}<span class="bar2"><i style="width:${Math.min(100, Math.round(((s.spentUsd + s.reservedUsd) / s.budgetUsd) * 100))}%"></i></span>${s.reservedUsd ? `<span class="why">${fine(s.reservedUsd)} set aside (a card waiting, or a session’s deposit)</span>` : ""}</td><td class="num2">${s.expired ? '<span class="st expired">expired</span>' : nyDay(s.validUntil)}</td><td class="r">${owner ? `<button type="button" class="link" data-unspend="${esc(s.agent)}|${esc(s.scope)}">Revoke</button>` : ""}</td></tr>`).join("")}</tbody></table>` : '<p class="empty">An agent key moves no money until you approve where, how much and until when.</p>'}
    ${agents.length ? `<form class="add" id="spend-form">${field("Agent", select("agent", agents))}${field("May", select("scope", [["venues", "move between venues"], ["payees", "pay"]]))}${field("Where", '<input class="m" name="allow" placeholder="okx, metamask · or data.sim" required />')}${field("Per payment", '<input class="s" name="perPayment" inputmode="decimal" placeholder="500" required />')}${field("Budget", '<input class="s" name="budget" inputmode="decimal" placeholder="2000" required />')}${field("Refill every", select("windowHours", [["0", "no limit"], ["1", "1 hour"], ["24", "24 hours"]], "0"))}${field("For", select("days", [["1", "1 day"], ["7", "7 days"], ["30", "30 days"]], "7"))}<button type="submit" class="ink"${owner ? "" : " disabled"}>Approve</button></form>` : ""}
    <h3>Fee approvals</h3>${A.fees.length ? `<table><thead><tr><th>App</th><th class="r">May charge up to</th><th></th></tr></thead><tbody>${A.fees.map((f) => `<tr><td class="num2">${esc(short(f.builder))}</td><td class="r num2">${esc(f.maxFeeRate)}</td><td class="r">${owner ? `<button type="button" class="link" data-unfee="${esc(f.builder)}">Remove</button>` : ""}</td></tr>`).join("")}</tbody></table>` : '<p class="empty">No app may add a fee to what it sends for you.</p>'}
    <form class="add" id="fee-form">${field("App address", '<input class="l" name="builder" placeholder="0x…" required pattern="0x[0-9a-fA-F]{40}" />')}${field("Max fee", select("rate", [["0.01%", "0.01%"], ["0.05%", "0.05%"], ["0.1%", "0.1%"]], "0.05%"))}<button type="submit"${owner ? "" : " disabled"}>Approve fee</button></form>
    <h3>Payees</h3>${A.pay.payees.length ? `<table><thead><tr><th>Payee</th><th>Speaks</th><th>Paid at</th><th class="r">Payments</th><th class="r">In all</th></tr></thead><tbody>${A.pay.payees.map((y) => `<tr><td>${esc(y.host)}</td><td class="dim">${esc(SPEAKS[y.protocol] || y.protocol)}</td><td class="num2 dim">${esc(short(y.payTo))}</td><td class="r num2">${y.payments}</td><td class="r num2">${fine(y.paidUsd)}</td></tr>`).join("")}</tbody></table>` : '<p class="empty">No one has been paid. The first payment to a payee waits for you: you see who is paid, at which address and how much, and your approval fixes that address.</p>'}
    ${A.pay.sessions.length ? `<h3>Payment sessions</h3><table><thead><tr><th>Payee</th><th>From</th><th class="r">Deposit</th><th class="r">Used</th><th>Status</th><th></th></tr></thead><tbody>${A.pay.sessions.map((y) => `<tr><td>${esc(y.host)}</td><td class="dim">float “${esc(y.subAccount)}”</td><td class="r num2">${fine(y.depositUsd)}</td><td class="r num2">${fine(y.spentUsd)}</td><td><span class="st ${y.status === "open" || y.status === "closing" ? "pending" : "settled"}">${esc(y.status)}</span>${y.note ? `<span class="why">${esc(y.note)}</span>` : ""}</td><td class="r">${y.status === "open" && owner ? `<button type="button" class="link" data-close="${esc(y.id)}">Close</button>` : ""}</td></tr>`).join("")}</tbody></table><p class="dim small">A session’s deposit is yours until a voucher spends it. Closing pays the payee what its vouchers say and sends the rest back to the float; an agent whose key is gone cannot keep one open.</p>` : ""}`;
  },

  subs: (owner) => {
    const agents = A.keys.filter((k) => k.status === "ok").map((k) => [k.address, k.name]);
    return `${A.subAccounts.length ? `<table><thead><tr><th>Sub-account</th><th>Agent</th><th class="r">Float</th><th>Address</th><th></th></tr></thead><tbody>${A.subAccounts.map((s) => `<tr><td>${esc(s.name)}</td><td>${esc(s.agentName)}</td><td class="r num2">${money(s.balanceUsd)} of ${money(s.capUsd)}<span class="bar2"><i style="width:${Math.min(100, Math.round((s.balanceUsd / s.capUsd) * 100))}%"></i></span></td><td class="num2 dim">${esc(short(s.address))} · Base</td><td class="r">${owner ? `<button type="button" class="link" data-topup="${esc(s.name)}">Top up…</button>${s.balanceUsd > 0 ? ` · <button type="button" class="link" data-sweep="${esc(s.name)}">Bring back…</button>` : ""}` : ""}</td></tr>`).join("")}</tbody></table>` : '<p class="empty">A sub-account is an agent’s float: what it can pay with, and the most a mistake can cost.</p>'}
    ${agents.length ? `<form class="add" id="sub-form">${field("Name", '<input class="m" name="name" placeholder="cc-float" required maxlength="16" />')}${field("Agent", select("agent", agents))}${field("Float up to", '<input class="s" name="float" inputmode="decimal" placeholder="200" required />')}<button type="submit" class="ink"${owner ? "" : " disabled"}>Create</button></form>` : '<p class="dim small">Authorize an agent key first.</p>'}`;
  },

  signers: (owner) => `<h3>Who signs for this account</h3><table><tbody>${A.signers.owners.map((o) => `<tr><td>${o.kind === "device" ? "Device key" : "Wallet key"}${o.id === `device:${Owner.kid}` ? " · this browser" : ""}</td><td class="num2 dim">${esc(short(o.id.replace("device:", "")))}</td><td class="r dim">${A.signers.threshold} of ${A.signers.owners.length} must sign</td></tr>`).join("")}${A.signers.pendingDevices.map((d) => `<tr><td>Another browser asked to sign</td><td class="num2 dim">${esc(d.kid)}</td><td class="r">${owner ? `<button type="button" class="link" data-signer="${esc(d.kid)}" data-both="0">Let it sign too</button> · <button type="button" class="link" data-signer="${esc(d.kid)}" data-both="1">Require both</button>` : ""}</td></tr>`).join("")}</tbody></table>
    <h3>Address book</h3>${A.destinations.length ? `<table><thead><tr><th>Recipient</th><th>Address</th><th>Chain</th><th>Token</th><th>Use</th><th></th></tr></thead><tbody>${A.destinations.map((d) => `<tr><td>${esc(d.label)}</td><td class="num2 dim">${esc(short(d.address))}</td><td>${esc(d.chain)}</td><td>${esc(d.token)}</td><td>${d.usable ? '<span class="st settled">Ready</span>' : `<span class="st pending">From ${esc(d.usableOn)}</span>`}</td><td class="r">${owner ? `<button type="button" class="link" data-undest="${esc(d.label)}">Remove</button>` : ""}</td></tr>`).join("")}</tbody></table>` : '<p class="empty">Money leaves your own venues only to an address you put here, on the chain you put it for, a day after you added it.</p>'}
    <form class="add" id="dest-form">${field("Recipient", '<input class="m" name="label" placeholder="contractor" required maxlength="32" />')}${field("Address", '<input class="l" name="address" placeholder="0x…" required pattern="0x[0-9a-fA-F]{40}" />')}${field("Chain", select("chain", [["Base", "Base"], ["Arbitrum", "Arbitrum"], ["Ethereum", "Ethereum"], ["Polygon", "Polygon"]]))}${field("Token", select("token", [["USDC", "USDC"], ["USDT", "USDT"]]))}<button type="submit"${owner ? "" : " disabled"}>Add recipient</button></form>`,
};

const on = (selector, event, fn) => { for (const el of $("panel").querySelectorAll(selector)) el.addEventListener(event, (e) => fn(el, e)); };
const submit = (id, fn) => { const f = $(id); if (f) f.addEventListener("submit", (e) => { e.preventDefault(); fn(formOf(id)); }); };

const WIRE = {
  balances: () => {
    on("#plug-open", "click", () => openPlug());
    on("button[data-unplug]", "click", (b) => own({ type: "disconnectVenue", venue: b.dataset.unplug }));
  },
  payments: () => on("button[data-return]", "click", (b) => own({ type: "setPolicy", change: "sim-return", value: b.dataset.return })),
  keys: () => {
    on("button[data-revoke]", "click", (b) => own({ type: "approveAgent", agentAddress: ZERO, agentName: b.dataset.revoke, validUntil: 0 }));
    on("button[data-fill]", "click", (b) => { $("key-form").elements.address.value = b.dataset.fill; $("key-form").elements.name.focus(); });
    submit("key-form", (f) => own({ type: "approveAgent", agentAddress: f.address.toLowerCase(), agentName: f.name.trim(), validUntil: nowMs() + Number(f.days) * DAY }));
  },
  approvals: () => {
    on("button[data-unspend]", "click", (b) => { const [agent, scope] = b.dataset.unspend.split("|"); own({ type: "approveSpend", agent, scope, allow: "", perPayment: "0", budget: "0", windowHours: 0, validUntil: 0 }); });
    on("button[data-unfee]", "click", (b) => own({ type: "approveBuilderFee", builder: b.dataset.unfee, maxFeeRate: "0" }));
    submit("spend-form", (f) => own({ type: "approveSpend", agent: f.agent, scope: f.scope, allow: f.allow.split(",").map((x) => x.trim()).filter(Boolean).join(","), perPayment: f.perPayment.trim(), budget: f.budget.trim(), windowHours: Number(f.windowHours), validUntil: nowMs() + Number(f.days) * DAY }));
    submit("fee-form", (f) => own({ type: "approveBuilderFee", builder: f.builder.toLowerCase(), maxFeeRate: f.rate }));
    on("button[data-close]", "click", (b) => own({ type: "setPolicy", change: "close-session", value: b.dataset.close }));
  },
  subs: () => {
    on("button[data-topup]", "click", (b) => openMove("transfer", { from: "metamask", to: `sub:${b.dataset.topup}` }));
    on("button[data-sweep]", "click", (b) => openMove("transfer", { from: `sub:${b.dataset.sweep}`, to: "metamask" }));
    submit("sub-form", (f) => own({ type: "createSubAccount", name: f.name.trim(), agent: f.agent, float: f.float.trim() }));
  },
  signers: () => {
    on("button[data-signer]", "click", (b) => {
      const users = [...A.signers.owners.map((o) => o.id), `device:${b.dataset.signer}`].sort();
      own({ type: "convertToMultiSigUser", signers: JSON.stringify({ authorizedUsers: users, threshold: b.dataset.both === "1" ? users.length : A.signers.threshold }) });
    });
    on("button[data-undest]", "click", (b) => own({ type: "setDestination", label: b.dataset.undest, address: "", chain: "", token: "" }));
    submit("dest-form", (f) => own({ type: "setDestination", label: f.label.trim(), address: f.address, chain: f.chain, token: f.token }));
  },
};

// ---- the five actions -------------------------------------------------------------------

const MOVE = {
  deposit: { title: "Deposit", verb: "Deposit", hint: "Money into a venue, from another place of yours." },
  withdraw: { title: "Withdraw", verb: "Withdraw", hint: "From a venue back to your wallet or your bank." },
  transfer: { title: "Transfer", verb: "Transfer", hint: "Between your own venues, or inside one." },
};

/** every place money can sit, as a select option: a venue, a venue's own ledger, a float */
function places() {
  const out = [];
  for (const v of A.venues) {
    if (v.frontLine === "Card") continue;
    // a venue is listed ledger by ledger only when its own balances say which ledger holds what (Hyperliquid's perps and spot); otherwise as one place
    const split = v.ledgers.filter((l) => v.holdings.some((h) => (h.note || "").startsWith(l)));
    if (split.length) for (const l of v.ledgers) out.push({ id: `${v.id}:${l}`, venue: v.id, label: `${v.name} · ${l}`, cash: v.holdings.filter((h) => !h.inTransit && (h.note || "").startsWith(l)).reduce((s, h) => s + h.usd, 0), fiat: v.fiat, restricted: !!v.restricted });
    else out.push({ id: v.id, venue: v.id, label: v.name, cash: v.cashUsd, fiat: v.fiat, restricted: !!v.restricted });
  }
  for (const s of A.subAccounts) out.push({ id: `sub:${s.name}`, venue: "sub", label: `Float · ${s.name}`, cash: s.balanceUsd, fiat: false, float: true });
  return out;
}

function openMove(kind, preset = {}) {
  const all = places();
  const from = all.filter((p) => (!p.float || kind === "transfer") && !p.restricted && p.cash > 0 && (kind !== "withdraw" || !["metamask", "chase"].includes(p.venue)));
  const to = all.filter((p) => !p.restricted && (kind === "withdraw" ? ["metamask", "chase"].includes(p.venue) : kind === "deposit" ? !p.float && p.venue !== "chase" : true));
  const opt = (p) => [p.id, `${p.label} · ${money(p.cash)}`];
  const defFrom = preset.from || (kind === "deposit" ? "metamask" : kind === "withdraw" ? "hyperliquid:perps" : "okx");
  const defTo = preset.to || (kind === "deposit" ? "hyperliquid:perps" : kind === "withdraw" ? "metamask" : "hyperliquid:perps");
  const m = MOVE[kind];
  $("modal-form").innerHTML = `<h2>${m.title}</h2><div class="dim small">${m.hint}</div>
    <div class="row">${field("From", select("from", from.map(opt), from.some((p) => p.id === defFrom) ? defFrom : (from[0] || {}).id))}${field("To", select("to", to.map(opt), to.some((p) => p.id === defTo) ? defTo : (to[0] || {}).id))}</div>
    ${field("Amount (USD)", '<input name="amount" inputmode="decimal" placeholder="500" autocomplete="off" required />')}
    <div class="quote" id="quote"><span class="dim">Type an amount to see the route, the fee and when it lands.</span></div>
    <details id="signs" hidden><summary>What you sign</summary><pre id="signs-pre"></pre></details>
    <div class="msg" id="modal-msg"></div>
    <div class="end"><button type="button" id="modal-cancel">Cancel</button><button type="submit" class="ink" id="modal-go" disabled>${m.verb}</button></div>`;
  let prepared = null;
  let timer = 0;
  const f = $("modal-form");
  const draft = () => {
    const v = formOf("modal-form");
    const src = all.find((p) => p.id === v.from) || {};
    const dst = all.find((p) => p.id === v.to) || {};
    // inside one venue the ledgers matter; between venues the venue is enough
    const inside = src.venue === dst.venue && !dst.float;
    return { type: "sendAsset", destination: "self", sourceDex: inside || src.float ? v.from : src.venue, destinationDex: dst.float ? v.to : inside ? v.to : dst.venue, token: src.fiat || dst.fiat ? "USD" : "USDC", amount: String(v.amount || "").trim() };
  };
  const quote = async () => {
    prepared = null;
    $("modal-go").disabled = true;
    $("signs").hidden = true;
    const d = draft();
    if (!(Number(d.amount) > 0)) return void ($("quote").innerHTML = '<span class="dim">Type an amount to see the route, the fee and when it lands.</span>');
    const r = await Owner.prepare(d);
    if (r.status !== 200) return void ($("quote").innerHTML = `<div class="msg no">${esc(Owner.why(r))}</div>${r.body.refusal && r.body.refusal.detail && r.body.refusal.detail.opens ? `<div class="path">To open it: ${esc(r.body.refusal.detail.opens)}</div>` : ""}`);
    prepared = r.body;
    const q = prepared.quote;
    $("quote").innerHTML = `<div class="big"><span>Arrives ${money(q.receiveUsd)}</span><span>fee ${money(q.feeUsd)} · lands ${esc(q.lands)}</span></div><div class="path">${esc(q.legs.map((l) => (l.step === "swap" ? `swap at ${l.venue}` : l.step === "bridge" ? l.protocol : l.step === "in" ? `into ${l.venue}` : l.step === "venue" ? l.protocol : l.step === "shift" ? `inside ${l.venue}` : `out of ${l.venue}`)).join(" → "))}</div>${q.startAt ? `<div class="path">Only you can start this, at ${esc(q.startAt)}. Here that step is simulated; the account then watches for it.</div>` : ""}${q.signAt ? `<div class="path">${esc(q.signAt)} keeps its own key: you sign this one in that wallet. Here that step is simulated; the account then sees the address pay.</div>` : ""}${q.final ? "" : '<div class="path">An ACH is not final: the bank can still return it.</div>'}`;
    $("signs-pre").textContent = prepared.shown.map((x) => `${x.name}: ${x.value}`).join("\n");
    $("signs").hidden = false;
    $("modal-go").textContent = q.startAt ? `Start at ${q.startAt}` : q.signAt ? `Sign in ${q.signAt}` : m.verb;
    $("modal-go").disabled = Owner.role !== "owner";
  };
  for (const el of f.querySelectorAll("select, input")) el.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(quote, 200); });
  $("modal-cancel").addEventListener("click", () => $("modal").close());
  f.onsubmit = async (e) => {
    e.preventDefault();
    if (!prepared) return;
    $("modal-go").disabled = true;
    const r = await Owner.submit(prepared);
    if (r.status >= 400) {
      $("modal-msg").className = "msg no";
      $("modal-msg").textContent = Owner.why(r) || "Refused";
      return void quote();
    }
    $("modal").close();
    tab = "payments";
    flash = "";
    history.replaceState(null, "", "#payments");
    await load();
  };
  $("modal").showModal();
}

function openSwap() {
  const venues = A.venues.filter((v) => !v.restricted && v.swaps.some((s) => s.access !== "closed"));
  $("modal-form").innerHTML = `<h2>Swap</h2><div class="dim small">One dollar stablecoin for another, at a venue that needs it.</div>
    ${field("Venue", select("venue", venues.map((v) => [v.id, v.name])))}
    <div class="row">${field("Sell", select("sell", [["USDT", "USDT"], ["USDC", "USDC"]], "USDT"))}${field("Buy", select("buy", [["USDC", "USDC"], ["USDT", "USDT"]], "USDC"))}</div>
    ${field("Amount", '<input name="amount" inputmode="decimal" placeholder="500" autocomplete="off" required />')}
    <div class="quote" id="quote"></div><div class="msg" id="modal-msg"></div>
    <div class="end"><button type="button" id="modal-cancel">Cancel</button><button type="submit" class="ink" id="modal-go">Swap</button></div>`;
  const calc = () => {
    const v = formOf("modal-form");
    const s = (A.venues.find((x) => x.id === v.venue) || { swaps: [] }).swaps[0];
    const amount = Number(v.amount);
    if (!s || !(amount > 0)) return void ($("quote").innerHTML = '<span class="dim">The venue’s own spot book or convert desk fills it.</span>');
    const out = Math.round(amount * (1 - s.feeBps / 10_000) * 100) / 100;
    $("quote").innerHTML = `<div class="big"><span>You get about ${money(out)} ${esc(v.buy)}</span><span>fee ${money(amount - out)}</span></div><div class="path">At least $${s.minUsd} a swap here. If it would bring less than ${money(Math.round(out * 0.999 * 100) / 100)}, it is not done.</div>`;
    return { s, out };
  };
  for (const el of $("modal-form").querySelectorAll("select, input")) el.addEventListener("input", calc);
  calc();
  $("modal-cancel").addEventListener("click", () => $("modal").close());
  $("modal-form").onsubmit = async (e) => {
    e.preventDefault();
    const v = formOf("modal-form");
    const c = calc();
    if (!c) return;
    const r = await Owner.act({ type: "swap", venue: v.venue, sell: v.sell, buy: v.buy, amount: v.amount.trim(), minReceive: (Math.round(c.out * 0.999 * 100) / 100).toFixed(2) });
    if (r.status >= 400) return void (($("modal-msg").className = "msg no"), ($("modal-msg").textContent = Owner.why(r) || "Refused"));
    $("modal").close();
    tab = "payments";
    history.replaceState(null, "", "#payments");
    await load();
  };
  $("modal").showModal();
}

/** plug in a venue the user already has: pick it, see how it is reached and what the account will ask it, sign */
function openPlug() {
  const list = A.connectable;
  $("modal-form").innerHTML = `<h2>Plug in a venue</h2><div class="dim small">A venue you already have. The account asks it what your key may do there and builds its runways from the answer. Nothing is installed.</div>
    ${field("Venue", select("venue", list.map((c) => [c.id, c.name])))}
    <div class="row">${field("Shown as", '<input name="label" maxlength="40" autocomplete="off" />')}<label><span id="plug-ref">Credential lives at</span><input name="credentialRef" maxlength="120" autocomplete="off" /></label></div>
    <div class="quote" id="quote"></div>
    <div class="msg" id="modal-msg"></div>
    <div class="end"><button type="button" id="modal-cancel">Cancel</button><button type="submit" class="ink" id="modal-go"${Owner.role === "owner" ? "" : " disabled"}>Plug in</button></div>`;
  const form = $("modal-form");
  const show = () => {
    const c = list.find((x) => x.id === form.elements.venue.value) || list[0];
    form.elements.label.value = c.name;
    const wallet = c.connector === "wallet";
    form.elements.credentialRef.value = c.credentialRef;
    form.elements.credentialRef.readOnly = wallet;
    $("plug-ref").textContent = wallet ? "Its address" : "Credential lives at";
    $("quote").innerHTML = `<div class="path"><b>Reached through</b> ${esc(c.via)}</div><div class="path"><b>It takes</b> ${esc(c.credential)}${wallet ? "" : ". This page takes where the credential lives, never the credential"}.</div><div class="path"><b>What it may do there is learned from</b> ${esc(c.asks)}.</div>`;
  };
  form.elements.venue.addEventListener("change", show);
  show();
  $("modal-cancel").addEventListener("click", () => $("modal").close());
  form.onsubmit = async (e) => {
    e.preventDefault();
    const c = list.find((x) => x.id === form.elements.venue.value);
    const r = await Owner.act({ type: "connectVenue", venue: c.id, connector: c.connector, label: form.elements.label.value.trim(), credentialRef: form.elements.credentialRef.value.trim() });
    if (r.status >= 400) return void (($("modal-msg").className = "msg no"), ($("modal-msg").textContent = Owner.why(r) || "Refused"));
    $("modal").close();
    flash = "";
    said = r.body.summary || "";
    tab = "balances";
    history.replaceState(null, "", "#balances");
    await load();
  };
  $("modal").showModal();
}

function openSend() {
  const from = places().filter((p) => !p.float && !p.fiat && !p.restricted && p.cash > 0);
  const book = A.destinations.map((d) => [d.label, `${d.label} · ${d.chain} · ${d.token}${d.usable ? "" : ` · from ${d.usableOn}`}`, !d.usable]);
  $("modal-form").innerHTML = `<h2>Send</h2><div class="dim small">To someone else. It cannot be called back.</div>
    ${book.length ? field("To", select("to", book, (A.destinations.find((d) => d.usable) || {}).label)) : '<div class="quote"><span>Your address book is empty. A recipient is an address on a chain; you add it under Signers, and it can be used a day later.</span></div>'}
    <div class="row">${field("From", select("from", from.map((p) => [p.id, `${p.label} · ${money(p.cash)}`]), "metamask"))}${field("Amount", '<input name="amount" inputmode="decimal" placeholder="300" autocomplete="off" required />')}</div>
    <div class="quote" id="quote"><span class="dim">Type an amount to see the route, the fee and when it lands.</span></div>
    <details id="signs" hidden><summary>What you sign</summary><pre id="signs-pre"></pre></details>
    <div class="msg" id="modal-msg"></div>
    <div class="end"><button type="button" id="modal-cancel">${book.length ? "Cancel" : "Close"}</button><button type="submit" class="ink" id="modal-go" disabled>Send</button></div>`;
  let prepared = null;
  const quote = async () => {
    prepared = null;
    $("modal-go").disabled = true;
    const v = formOf("modal-form");
    const d = A.destinations.find((x) => x.label === v.to);
    if (!d || !(Number(v.amount) > 0)) return;
    const src = places().find((p) => p.id === v.from) || {};
    const r = await Owner.prepare({ type: "sendAsset", destination: d.address, sourceDex: src.venue, destinationDex: d.chain, token: d.token, amount: v.amount.trim() });
    if (r.status !== 200) return void ($("quote").innerHTML = `<div class="msg no">${esc(Owner.why(r))}</div>`);
    prepared = r.body;
    const q = prepared.quote;
    $("quote").innerHTML = `<div class="big"><span>${esc(d.label)} gets ${money(q.receiveUsd)}</span><span>fee ${money(q.feeUsd)} · lands ${esc(q.lands)}</span></div><div class="path">${esc(short(d.address))} on ${esc(d.chain)}</div>${q.signAt ? `<div class="path">${esc(q.signAt)} keeps its own key: you sign this one in that wallet. Here that step is simulated.</div>` : ""}`;
    $("signs-pre").textContent = prepared.shown.map((x) => `${x.name}: ${x.value}`).join("\n");
    $("signs").hidden = false;
    $("modal-go").disabled = Owner.role !== "owner";
  };
  let timer = 0;
  for (const el of $("modal-form").querySelectorAll("select, input")) el.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(quote, 200); });
  $("modal-cancel").addEventListener("click", () => $("modal").close());
  $("modal-form").onsubmit = async (e) => {
    e.preventDefault();
    if (!prepared) return;
    const r = await Owner.submit(prepared);
    if (r.status >= 400) return void (($("modal-msg").className = "msg no"), ($("modal-msg").textContent = Owner.why(r) || "Refused"));
    $("modal").close();
    tab = "payments";
    history.replaceState(null, "", "#payments");
    await load();
  };
  $("modal").showModal();
}

for (const b of $("acts").querySelectorAll("button")) b.addEventListener("click", () => (b.dataset.act === "swap" ? openSwap() : b.dataset.act === "send" ? openSend() : openMove(b.dataset.act)));
for (const b of $("type").querySelectorAll("button")) b.addEventListener("click", () => own({ type: "userSetAbstraction", abstraction: b.dataset.type }));
for (const b of $("mode").querySelectorAll("button")) {
  b.addEventListener("click", async () => {
    // tightening is free; opening the dial is the owner's to sign
    if (b.dataset.mode === "open") return void own({ type: "setPolicy", change: "mode", value: "open" });
    await fetch("/api/mode", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "guard" }) });
    await load();
  });
}

(async () => {
  await Owner.ready();
  await load();
  setInterval(() => { if (!busy && !$("modal").open && !document.activeElement.closest("form")) load(); }, 20000);
})();
