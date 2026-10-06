/* Where the owner steers the agents: the two modes (also in the rail), the agents' session and leverage, the agents and their limits, the
   agent wallets, the devices that sign. Two sheets: Agents and Settings. Another team's Agent module mounts in the Agents sheet later
   (openAgents is its mount point); until then its sections render as they always have, and behave the same. */

/** the mode: loosening (Aggressive) is the owner's to sign; tightening (Conservative) needs no signature */
async function setMode(mode) {
  if (!A || mode === A.mode || !owns()) return;
  if (mode === "open") return void own({ type: "setPolicy", change: "mode", value: "open" });
  await postJson("/api/mode", { mode: "guard" });
  said = "Conservative: every agent order waits for you.";
  await load();
}
const modeNote = () => (A.mode === "open" ? "Agents trade inside their limits without asking." : "Every agent order waits for you.");

/* the agents' session and the most leverage they may set: what the owner opens to agents beyond their limits */
function renderDial(L, owner) {
  const el = $("dial");
  if (!el) return;
  const d = A.dial;
  if (!d || !writesOn()) return void (el.innerHTML = '<div class="set"><div><b>Agents\' session</b><span class="note-s">This server places no orders (it was started read-only), so there is no session or leverage to open.</span></div></div>');
  // leverage is offered only where a connected venue sets it from here
  const lev = L.some((v) => v.trade && v.trade.leverage);
  el.innerHTML = `<div class="set"><div><b>Agents' session</b><span class="note-s">${d.sessionEnded ? "Ended: agents can do nothing until you start a new one." : `Agents may act until ${esc(nyDay(d.sessionExpiresAt))}.`}</span></div>${owner ? `<button type="button" class="btn btn-sm" id="session-new">${d.sessionEnded ? "Start a new one" : "Renew for 30 days"}</button>` : ""}</div>${lev ? `<div class="set"><div><b>Their leverage</b><span class="note-s">The most an agent may set on a perpetual: up to ${esc(String(d.maxLeverage))}x${Number(d.maxLeverage) === 1 ? " (none)" : ""}.</span></div>${owner ? '<button type="button" class="btn btn-sm" id="lev-cap">Change</button>' : ""}</div>` : ""}`;
  if ($("session-new")) $("session-new").addEventListener("click", () => own({ type: "setPolicy", change: "session", value: "30d" }));
  if ($("lev-cap")) $("lev-cap").addEventListener("click", async () => {
    const now = Number(d.maxLeverage) || 1;
    const steps = [...new Set([1, 2, 3, 5, 10, 20, now])].sort((a, b) => a - b);
    const v = await pickSheet("The most leverage an agent may set", steps.map((n) => [n, `${n}x`, n === 1 ? "none" : n === now ? "now" : ""]), { current: now, note: "On a perpetual, at a venue that sets leverage from here. Your signature changes it." });
    if (v !== null && Number(v) !== now) own({ type: "setPolicy", change: "maxLeverage", value: String(v) });
  });
}

// ---- the sheets -----------------------------------------------------------------------------

/** the Agents sheet: the agents and their limits, the wallets they pay from, the devices that sign. The other team's module mounts here */
function openAgents() {
  openSheet('<div class="old"><section class="sheet-sec" aria-labelledby="agents-h"><h3 class="h2" id="agents-h">Agents</h3><div id="agents"></div></section><section class="sheet-sec" id="wallets-sec" aria-labelledby="wallets-h"><h3 class="h2" id="wallets-h">Agent wallets</h3><div id="wallets"></div></section><section class="sheet-sec" aria-labelledby="devices-h"><h3 class="h2" id="devices-h">Devices</h3><div id="devices"></div></section></div>', { title: "Agents", wide: true, redraw: drawAgents });
  drawAgents();
}
function drawAgents() {
  if (!$("agents")) return;
  const owner = owns();
  renderAgents(connected(), owner);
  // the agent wallets are drawn by money.js, which holds what moves money
  $("wallets-sec").hidden = typeof renderWallets !== "function";
  if (typeof renderWallets === "function") renderWallets(owner);
  renderDevices(owner);
}

/** the Settings sheet: the mode, trading on or off, the agents' session and leverage, the background, the devices */
function openSettings() {
  openSheet('<section class="sheet-sec"><div class="set"><div><b>Mode</b><span class="note-s" id="set-mode-note"></span></div><div id="set-mode"></div></div><div class="set"><div><b>Trading</b><span class="note-s" id="set-writes"></span></div></div><div id="dial"></div><div class="set"><div><b>Background</b><span class="note-s">Kept in this browser.</span></div><div id="set-theme"></div></div></section><section class="sheet-sec old" aria-labelledby="set-devices-h"><h3 class="h2" id="set-devices-h">Devices</h3><div id="devices"></div></section>', { title: "Settings", redraw: drawSettings });
  drawSettings();
}
function drawSettings() {
  if (!$("set-mode")) return;
  const owner = owns();
  $("set-mode").innerHTML = seg([["guard", "Conservative"], ["open", "Aggressive"]], A.mode, setMode, { label: "Mode" });
  for (const b of $("set-mode").querySelectorAll("button")) b.disabled = !owner;
  $("set-mode-note").textContent = `${modeNote()}${owner ? "" : " Only a browser that signs for you changes it."}`;
  $("set-writes").textContent = writesOn() ? `On: an order or a move goes through only when you sign it, or inside a limit you gave an agent, and is worth up to ${money(A.connectLive.writes.capUsd)} each (set when the account was started).` : "Off: this server was started read-only, so it places no orders and moves no money.";
  $("set-theme").innerHTML = seg([["cream", "Cream"], ["black", "Black"]], document.documentElement.dataset.theme || "cream", setTheme, { label: "Background" });
  renderDial(connected(), owner);
  renderDevices(owner);
}

// ---- agents -----------------------------------------------------------------------------

/* a place an earn limit names, in words: a venue, or one product at a venue */
const earnPlace = (x) => {
  const [v, ...p] = String(x).split(":");
  return p.length ? `${nameOf(v)} (${p.join(":")})` : nameOf(v);
};
/** the end of one limit, as the account signs it: the same agent, kind and places, a budget of nothing */
const endLimitDraft = (l) => ({ type: "approveSpend", agent: l.agent, scope: l.scope, allow: l.allow.join(","), perPayment: "0", budget: "0", windowHours: 0, validUntil: nowMs() + DAY });

function renderAgents(L, owner) {
  const keys = A.keys.filter((k) => k.status === "ok" || k.status === "expired");
  const limitOf = (k, scope) => A.spend.find((s) => s.scope === scope && s.agent === k.address);
  const asking = A.requests.map((r) => `<tr><td class="num2 mono">${esc(short(r.address))}</td><td class="dim">asked to be let in · ${nyDay(r.at)} ${nyTime(r.at)}</td><td class="r">${owner ? `<button type="button" class="link" data-fill="${esc(r.address)}">Let in…</button>` : ""}</td></tr>`).join("");
  const rows = keys.map((k) => {
    const t = limitOf(k, "trade");
    const m = limitOf(k, "venues");
    const y = limitOf(k, "payees");
    const n = limitOf(k, "earn");
    const s = t || m || y || n;
    const pays = y ? `pays ${y.allow.includes("*") ? "any payee" : y.allow.join(", ")} up to ${fine(y.perPaymentUsd)} each (${fine(y.spentUsd)} of ${fine(y.budgetUsd)})` : "";
    // an earn limit names venues, or one product at a venue ("okx:savings:USDT")
    const earnsAt = n ? n.allow.map(earnPlace).join(", ") : "";
    const earns = n ? (s === n ? `puts money to earn at ${earnsAt}` : `puts money to earn at ${earnsAt} up to ${fine(n.perPaymentUsd)} each time (${fine(n.spentUsd)} of ${fine(n.budgetUsd)}${n.reservedUsd ? `, ${fine(n.reservedUsd)} waiting` : ""}${n.expired ? ", expired" : `, until ${nyDay(n.validUntil)}`})`) : "";
    const where = [t ? `trades at ${t.allow.map(nameOf).join(", ")}` : "", m ? `moves money between ${m.allow.map(nameOf).join(", ")}` : "", t || m ? pays : y ? `pays ${y.allow.includes("*") ? "any payee" : y.allow.join(", ")}` : "", earns].filter(Boolean).join(" · ");
    const limit = s ? `${fine(s.spentUsd)} of ${fine(s.budgetUsd)} used · up to ${fine(s.perPaymentUsd)} ${t ? "an order" : m ? "a move" : y ? "a payment" : "each time"}<span class="why">${esc(where)}${s.reservedUsd ? ` · ${fine(s.reservedUsd)} waiting` : ""}${s.expired ? " · limit expired" : ` · until ${nyDay(s.validUntil)}`}</span>` : '<span class="dim">No limit yet: it can do nothing</span>';
    const endEarn = n && owner && k.status === "ok" ? ` · <button type="button" class="link dim" data-end-earn="${esc(k.address)}">End earn limit</button>` : "";
    return `<tr><td>${esc(k.name)}<span class="why"><span class="mono">${esc(short(k.address))}</span>${k.status === "expired" ? " · expired" : ` · until ${nyDay(k.validUntil)}`}</span></td><td>${limit}</td><td class="r">${owner && k.status === "ok" ? `<button type="button" class="link dim" data-limit="${esc(k.address)}">Change limit</button>${endEarn} · <button type="button" class="link dim" data-revoke="${esc(k.name)}">Revoke</button>` : ""}</td></tr>`;
  }).join("");
  const T = L.filter(canTrade);
  const M = L.filter(canMove);
  const form = owner && A.connectLive ? `<form class="add" id="agent-form">${field("Agent", select("agent", [["", "New agent…"], ...keys.filter((k) => k.status === "ok").map((k) => [k.address, k.name])]))}<span class="newonly">${field("Name", '<input class="m" name="name" placeholder="Claude Code" maxlength="32" />')}${field("Key address", '<input class="l" name="address" placeholder="0x…" pattern="0x[0-9a-fA-F]{40}" />')}</span>${T.length ? `<fieldset class="chk"><legend>May trade at</legend>${T.map((v) => `<label><input type="checkbox" name="allow" value="${esc(v.id)}" checked /> ${esc(v.name)}</label>`).join("")}${M.length > 1 ? '<label class="also"><input type="checkbox" name="move" /> and move money between my accounts</label>' : ""}</fieldset>${field("Per order", '<input class="s" name="perPayment" inputmode="decimal" placeholder="25" />')}${field("Budget", '<input class="s" name="budget" inputmode="decimal" placeholder="100" />')}` : ""}<details class="pay"${A.spend.some((x) => x.scope === "payees") ? " open" : ""}><summary>Payments from an agent wallet</summary><div class="row">${field("May pay", '<input class="l" name="payees" placeholder="api.example.com, data.example.com" />')}<label class="chk1"><input type="checkbox" name="anyPayee" /> any payee</label></div><div class="row">${field("Per payment", '<input class="s" name="payPer" inputmode="decimal" placeholder="1" />')}${field("Budget", '<input class="s" name="payBudget" inputmode="decimal" placeholder="20" />')}</div></details>${field("For", select("days", [["1", "1 day"], ["7", "7 days"], ["30", "30 days"], ["90", "90 days"]], "30"))}<button type="button" class="link" id="everything">Everything</button><button type="submit" class="ink">Save</button></form><p class="dim small hint">${T.length ? "An agent trades only inside its limit. Conservative: each order waits for you. Aggressive: it goes at once." : "Connect an account that trades to give an agent a limit."}</p>` : "";
  $("agents").innerHTML = `${keys.length || asking ? `<table><tbody>${asking}${rows}</tbody></table>` : '<p class="empty">No agents yet.</p>'}${form}`;
  const f = $("agent-form");
  if (!f) return;
  const isNew = () => !f.elements.agent.value;
  const sync = () => {
    f.querySelector(".newonly").hidden = !isNew();
    const k = keys.find((x) => x.address === f.elements.agent.value);
    if (f.elements.move) f.elements.move.checked = !!(k && limitOf(k, "venues"));
  };
  f.elements.agent.addEventListener("change", sync);
  sync();
  // the widest an agent can be let in: every account it can trade at, money between all of them, any payee — you still type the amounts
  if ($("everything")) $("everything").addEventListener("click", () => {
    for (const el of f.querySelectorAll('input[name="allow"]')) el.checked = true;
    if (f.elements.move) f.elements.move.checked = true;
    if (f.elements.anyPayee) { f.elements.anyPayee.checked = true; f.querySelector("details.pay").open = true; }
    (f.elements.perPayment || f.elements.payPer).focus();
  });
  for (const b of $("agents").querySelectorAll("button[data-fill]")) b.addEventListener("click", () => { f.elements.agent.value = ""; sync(); f.elements.address.value = b.dataset.fill; f.elements.name.focus(); });
  for (const b of $("agents").querySelectorAll("button[data-limit]")) b.addEventListener("click", () => { f.elements.agent.value = b.dataset.limit; sync(); if (f.elements.perPayment) f.elements.perPayment.focus(); });
  for (const b of $("agents").querySelectorAll("button[data-revoke]")) b.addEventListener("click", () => own({ type: "approveAgent", agentAddress: ZERO, agentName: b.dataset.revoke, validUntil: 0 }));
  // the earn limit alone ends (a budget of nothing): its trading and other limits stand
  for (const b of $("agents").querySelectorAll("button[data-end-earn]")) b.addEventListener("click", () => {
    const n = A.spend.find((x) => x.scope === "earn" && x.agent === b.dataset.endEarn);
    if (n) own(endLimitDraft(n));
  });
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(f).entries());
    const allow = new FormData(f).getAll("allow").map(String);
    const until = nowMs() + Number(v.days) * DAY;
    const budget = String(v.budget || "").trim();
    const per = String(v.perPayment || "").trim() || budget;
    const moving = !!v.move;
    /* a trading limit, then — when asked — a limit to move money between the same accounts (both ends of a move must be named), or the
       end of one that is no longer wanted. Each is the owner's signature */
    const limits = (agent) => {
      const had = A.spend.find((s) => s.scope === "venues" && s.agent === agent);
      const moveTo = M.filter((x) => allow.includes(x.id)).map((x) => x.id);
      const move = moving && moveTo.length > 1 ? () => own({ type: "approveSpend", agent, scope: "venues", allow: moveTo.join(","), perPayment: per, budget, windowHours: 0, validUntil: until }) : had && !moving ? () => own({ type: "approveSpend", agent, scope: "venues", allow: had.allow.join(","), perPayment: "0", budget: "0", windowHours: 0, validUntil: until }) : undefined;
      return own({ type: "approveSpend", agent, scope: "trade", allow: allow.length === T.length ? "*" : allow.join(","), perPayment: per, budget, windowHours: 0, validUntil: until }, move);
    };
    /* payments from an agent wallet: the hosts it may pay (or any, when ticked), each payment's most, and a budget of its own */
    const payBudget = String(v.payBudget || "").trim();
    const payees = v.anyPayee ? "*" : String(v.payees || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean).join(",");
    const pay = (agent) => (payBudget && payees ? own({ type: "approveSpend", agent, scope: "payees", allow: payees, perPayment: String(v.payPer || "").trim() || payBudget, budget: payBudget, windowHours: 0, validUntil: until }) : undefined);
    if (budget && !allow.length) return void ((flash = "Pick at least one account it may trade at."), render());
    if (payBudget && !payees) return void ((flash = "Name the hosts it may pay, or tick any payee."), render());
    if (!isNew()) {
      if (!budget && !payBudget) return void ((flash = "Type a budget to change its limit."), render());
      if (budget) await limits(v.agent);
      if (payBudget) await pay(v.agent);
      return;
    }
    if (!String(v.name || "").trim() || !/^0x[0-9a-fA-F]{40}$/.test(String(v.address || ""))) return void ((flash = "A new agent needs a name and its key's 0x address."), render());
    const address = String(v.address).toLowerCase();
    // letting an agent in is its key, then (when budgets are given) its limits: one signature each
    await own({ type: "approveAgent", agentAddress: address, agentName: String(v.name).trim(), validUntil: until }, async () => {
      if (budget) await limits(address);
      if (payBudget) await pay(address);
    });
  });
}

// ---- devices ----------------------------------------------------------------------------

function renderDevices(owner) {
  if (!$("devices")) return;
  $("devices").innerHTML = `<table><tbody>${A.signers.owners.map((o) => `<tr><td>${o.id === `device:${Owner.kid}` ? "This browser" : o.kind === "device" ? "Another browser" : "Wallet key"}</td><td class="num2 mono dim">${esc(short(o.id.replace("device:", "")))}</td><td class="r dim">${A.signers.threshold} of ${A.signers.owners.length} must sign</td></tr>`).join("")}${A.signers.pendingDevices.map((d) => `<tr><td>A browser asked to sign</td><td class="num2 mono dim">${esc(d.kid)}</td><td class="r">${owner ? `<button type="button" class="link" data-signer="${esc(d.kid)}" data-both="0">Let it sign</button> · <button type="button" class="link" data-signer="${esc(d.kid)}" data-both="1">Require both</button>` : ""}</td></tr>`).join("")}</tbody></table>`;
  for (const b of $("devices").querySelectorAll("button[data-signer]")) {
    b.addEventListener("click", () => {
      const users = [...A.signers.owners.map((o) => o.id), `device:${b.dataset.signer}`].sort();
      own({ type: "convertToMultiSigUser", signers: JSON.stringify({ authorizedUsers: users, threshold: b.dataset.both === "1" ? users.length : A.signers.threshold }) });
    });
  }
}
