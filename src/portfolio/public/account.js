/* The account page: the user's real accounts on one page, each read through the venue's own interface. It renders /api/account and
   signs what the owner asks for; it decides nothing the account did not. */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const money = (n) => "$" + Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/* only an address is shortened */
const short = (a) => (/^0x[0-9a-fA-F]{16,}$/.test(String(a)) ? `${String(a).slice(0, 8)}…${String(a).slice(-4)}` : String(a));
/* an amount can be a cent or less: show what it was, not $0.00 */
const fine = (n) => (n && Math.abs(n) < 0.01 ? "$" + Number(n).toFixed(6).replace(/0+$/, "") : money(n));
/* a price as a person reads it: no float tails, up to eight decimals */
const px = (n) => (n === undefined || n === null || n === "" ? "—" : Number(Number(n).toPrecision(10)).toLocaleString("en-US", { maximumFractionDigits: 8 }));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + "s"}`;
const ny = (iso, opts) => new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", ...opts }).format(new Date(iso));
const nyDay = (iso) => ny(iso, { weekday: "short", day: "numeric", month: "short" }).replace(",", "");
const nyTime = (iso) => ny(iso, { hour: "2-digit", minute: "2-digit", hour12: false });
const ZERO = "0x0000000000000000000000000000000000000000";
const DAY = 86_400_000;
const CLASS = { cash: ["Cash", "var(--ink)"], stable: ["Stablecoins", "var(--sage)"], crypto: ["Crypto", "var(--orange)"], equity: ["Stocks", "var(--gold)"], event: ["Predictions", "var(--plum)"], rwa: ["RWA", "var(--blue)"] };
let A = null;
let busy = false;
let flash = "";
let said = "";
let allStatement = false;
/* the statement's lines (every transaction, from every run's ledger) and what it is filtered to */
let S = [];
const view = { month: "", account: "", type: "" };
/* a connection's summary, short: its name and balance; the rest behind "details" */
const sayHtml = (s) => {
  const m = /^(.+?) connected live · (\$[\d,.]+) there now · (.+)$/.exec(s || "");
  return m ? `<b>${esc(m[1])}</b> connected · ${esc(m[2])}<details class="inl"><summary>details</summary>${esc(m[3])}</details>` : esc(s);
};

const connected = () => A.venues.filter((v) => v.live);
const nameOf = (id) => (A.venues.find((v) => v.id === id) || {}).name || id;
const keyName = (address) => (A.keys.find((k) => k.address === address) || {}).name || short(address);
const nowMs = () => Date.parse(A.now);

async function load() {
  const [r, st] = await Promise.all([fetch("/api/account"), fetch("/api/account/statement").catch(() => null)]);
  S = st && st.ok ? ((await st.json()).lines || []) : S;
  if (r.status === 404) return void (document.querySelector("main").innerHTML = '<p class="dim">This server runs the simulated statement (<span class="mono">--classic</span>). <a href="/">Open it</a>.</p>');
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
    if (then && !refused) {
      busy = false;
      await then(r);
    }
    await load();
    return r;
  } finally {
    busy = false;
    document.body.classList.remove("busy");
  }
}

function render() {
  const L = connected();
  const owner = Owner.role === "owner";
  document.title = `${A.cards.length ? `(${A.cards.length}) ` : ""}Account`;
  $("stamp").textContent = `${ny(A.now, { weekday: "short", day: "numeric", month: "short", year: "numeric" }).replace(",", "")} · ${nyTime(A.now)} New York`.toUpperCase();
  $("writes").innerHTML = writesOn() ? `<span class="pill warm" title="Orders and moves go through only when you sign them, or inside a limit you gave an agent">Trading on · up to ${money(A.connectLive.writes.capUsd)} an order</span>` : `<span class="pill" title="Started with --read-only">Read-only</span>`;
  for (const b of $("mode").querySelectorAll("button")) {
    b.setAttribute("aria-pressed", String(b.dataset.mode === A.mode));
    b.disabled = !owner;
  }
  $("mode-note").textContent = A.mode === "open" ? "Agents trade inside their limits without asking." : "Every agent order waits for you.";
  $("total").textContent = money(A.liveUsd);
  $("sub").textContent = L.length ? [plural(L.length, "account"), A.inFlightUsd ? `${money(A.inFlightUsd)} on the way` : "", A.cards.length ? `${A.cards.length} waiting for you` : ""].filter(Boolean).join(" · ") : "Connect an account to see it here.";
  $("connect").hidden = !A.connectLive;
  $("connect").disabled = !owner;
  renderAlloc(L);
  renderLiquidity(L);
  $("banner").hidden = owner;
  if (Owner.role === "needs-code") {
    $("banner").innerHTML = `<form id="code-form" class="codeform"><span>Enter the pairing code shown in the terminal.</span><input name="code" placeholder="XXXX-XXXX" maxlength="9" autocomplete="off" spellcheck="false" required /><button type="submit" class="ink">Pair</button><span class="msg" id="code-msg"></span></form>`;
    $("code-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const r = await Owner.ready($("code-form").elements.code.value);
      if (r.refusal) return void ($("code-msg").className = "msg no", $("code-msg").textContent = r.refusal);
      await load();
    });
  } else $("banner").textContent = Owner.role === "pending" ? "This browser can look but not sign. Add it under Devices from your other browser." : owner ? "" : "This browser can't make a signing key, so it can only look.";
  $("flash").className = `msg ${flash ? "no" : said ? "ok" : ""}`;
  $("flash").innerHTML = flash ? esc(flash) : sayHtml(said);
  renderDial(L, owner);
  renderRestored();
  renderWaiting(owner);
  renderAccounts(L, owner);
  renderPositions(L, owner);
  renderStatement(owner);
  renderAgents(L, owner);
  renderWallets(owner);
  renderDevices(owner);
}

/* the agents' session and the most leverage they may set: what the owner opens to agents beyond their limits */
function renderDial(L, owner) {
  const d = A.dial;
  if (!d || !writesOn()) return void ($("dial").innerHTML = "");
  const lev = L.some((v) => v.trade && v.trade.leverage);
  $("dial").innerHTML = `${d.sessionEnded ? `Agents' session ended${owner ? ' · <button type="button" class="link" id="session-new">Start a new one</button>' : ""}` : `Agents may act until ${esc(nyDay(d.sessionExpiresAt))}`}${lev ? ` · their leverage up to ${esc(String(d.maxLeverage))}x${owner ? ' <button type="button" class="link dim" id="lev-cap">Change</button>' : ""}` : ""}`;
  if ($("session-new")) $("session-new").addEventListener("click", () => own({ type: "setPolicy", change: "session", value: "30d" }));
  if ($("lev-cap")) $("lev-cap").addEventListener("click", () => {
    const v = prompt("The most leverage an agent may set on a perpetual (1 = none):", String(d.maxLeverage));
    if (v && /^\d{1,3}$/.test(v.trim())) own({ type: "setPolicy", change: "maxLeverage", value: v.trim() });
  });
}

/* a restart: what the account brought back from its ledgers, and what it could not */
function renderRestored() {
  const r = A.restore;
  if (!r) return void ($("restored").hidden = true);
  const back = r.venues.filter((v) => v.ok);
  const missed = r.venues.filter((v) => !v.ok);
  $("restored").hidden = false;
  $("restored").innerHTML = `${r.state === "restoring" ? "Restoring after a restart…" : `Continued after a restart: ${back.length} of ${plural(r.venues.length, "account")} connected again`}${r.orders + r.payments ? ` · ${plural(r.orders + r.payments, "transaction")} followed again` : ""}${missed.length || r.skipped.length ? `<details class="inl"><summary>details</summary>${[...missed.filter((v) => v.why !== "connecting again").map((v) => `${nameOf(v.venue) || v.venue}: ${v.why}`), ...r.skipped].map((x) => `<div>${esc(x)}</div>`).join("")}</details>` : ""}`;
}

/* what the money is in: the statement's bar, from what the venues say they hold */
function renderAlloc(L) {
  const by = {};
  for (const v of L) for (const h of v.holdings || []) if (h.usd > 0) by[h.class] = (by[h.class] || 0) + h.usd;
  const total = Object.values(by).reduce((s, x) => s + x, 0);
  $("alloc").hidden = !(total > 0);
  if (!(total > 0)) return;
  const slices = Object.keys(CLASS).filter((c) => by[c]).map((c) => ({ c, usd: by[c], pct: Math.round((by[c] / total) * 100) }));
  $("alloc-bar").innerHTML = slices.map((s) => `<i style="width:${(s.usd / total) * 100}%;background:${CLASS[s.c][1]}"></i>`).join("");
  $("alloc-legend").innerHTML = slices.map((s) => `<span style="color:${CLASS[s.c][1]}">■ ${CLASS[s.c][0]} ${s.pct}% · ${money(s.usd)}</span>`).join("");
}

/* Liquidity: the dollars that are ready (cash and dollar stablecoins), where they sit — which account, which ledger or chain — and how far
   they can go from here: traded where they are, moved to another account of yours, or only taken out at the venue itself */
function renderLiquidity(L) {
  const rows = L.flatMap((v) => (v.holdings || []).filter((h) => (h.class === "cash" || h.class === "stable") && h.usd > 0 && !h.inTransit).map((h) => ({ v, h })));
  const total = rows.reduce((s, r) => s + r.h.usd, 0);
  $("liq").hidden = !(total > 0);
  if (!(total > 0)) return;
  const mobile = rows.filter((r) => canMove(r.v)).reduce((s, r) => s + r.h.usd, 0);
  const tradable = rows.filter((r) => canTrade(r.v)).reduce((s, r) => s + r.h.usd, 0);
  $("liq-sum").innerHTML = `<b>${money(total)}</b> in dollars, ready · ${money(tradable)} can trade where it is · ${money(mobile)} can move between your accounts${total - mobile > 0.005 ? ` · ${money(total - mobile)} leaves only at its venue` : ""}`;
  const by = new Map();
  for (const r of rows) {
    const k = r.v.id;
    if (!by.has(k)) by.set(k, { v: r.v, usd: 0, where: [] });
    const e = by.get(k);
    e.usd += r.h.usd;
    e.where.push(`${r.h.asset}${r.h.note ? ` (${r.h.note})` : ""} ${money(r.h.usd)}`);
  }
  $("liq-body").innerHTML = `<table class="liq-t"><tbody>${[...by.values()].sort((a, b) => b.usd - a.usd).map((e) => `<tr><td>${esc(e.v.name)}<span class="why">${esc(e.where.join(" · "))}</span></td><td class="r num2">${money(e.usd)}</td><td class="dim small">${esc([canTrade(e.v) ? "trades here" : "", canMove(e.v) ? "moves out from here" : e.v.readOnlyBecause ? "moves only at the venue" : watched(e.v) ? "watched" : "this key only reads"].filter(Boolean).join(" · "))}</td></tr>`).join("")}</tbody></table>`;
}

function renderWaiting(owner) {
  const el = $("waiting");
  el.hidden = !A.cards.length;
  el.innerHTML = A.cards.map((c) => `<div class="card"><span class="mark">▣</span><span class="txt">${esc(c.reason)}${c.expiresAt ? `<span class="dim"> · answer by ${nyTime(c.expiresAt)}</span>` : ""}<details><summary>Details</summary><pre>${esc(c.shown.map((f) => `${f.name}: ${f.value}`).join("\n"))}</pre></details></span><span class="mono">${fine(c.usd)}</span><span class="btns"><button type="button" class="warm" data-card="${esc(c.id)}" data-decision="approve">Approve</button><button type="button" data-card="${esc(c.id)}" data-decision="reject">Reject</button></span></div>`).join("");
  for (const b of el.querySelectorAll("button[data-card]")) {
    b.disabled = !owner;
    b.addEventListener("click", () => {
      const c = A.cards.find((x) => x.id === b.dataset.card);
      own({ type: "approveCard", card: c.id, action: c.hash, decision: b.dataset.decision });
    });
  }
}

// ---- accounts ---------------------------------------------------------------------------

/* how an account is reached, in a few words */
const caption = (v) => {
  if (v.address) return `${short(v.address)}${v.liveCan && v.liveCan.send === "mm" ? " · mm" : ""}`;
  if (/MCP server/.test(v.via || "")) return "Robinhood sign-in";
  const can = /credential can:? ([^·]+)/.exec(v.via || "");
  return `API key${can ? ` · ${can[1].trim()}` : ""}`;
};
function accountRow(v, owner) {
  const status = v.stale ? `<span class="chip bad" title="${esc(v.stale)}">Read failed</span>` : canTrade(v) ? '<span class="chip warm">Trades</span>' : canMove(v) ? '<span class="chip warm">Can move</span>' : watched(v) ? '<span class="chip">Watched</span>' : v.trade && v.trade.can === false && writesOn() ? '<span class="chip" title="This key cannot trade">Read-only key</span>' : '<span class="chip">Read-only</span>';
  const holds = (v.holdings || []).filter((h) => h.amount);
  const can = v.liveCan && writesOn() && !watched(v) ? ["withdraw", "transfer", "swap"].filter((k) => v.liveCan[k] === true) : [];
  const notes = [v.via, canTrade(v) ? `Trades ${v.trade.what}.` : "", v.trade && v.trade.can === false && writesOn() ? `This key can't trade. ${keyHow(v.id.replace(/-.*$/, ""))} Then connect it again.` : "", can.length ? `Moves money: ${can.join(", ")}.` : "", keyOnlyReads(v) && !canTrade(v) ? "Read-only key: it can receive, not send." : "", watched(v) ? "Watched address: nothing is traded or sent from it." : "", v.proven ? `Proven yours by ${v.proven}.` : "", v.noTradeBecause && writesOn() ? v.noTradeBecause : "", v.readOnlyBecause && writesOn() && !canTrade(v) ? v.readOnlyBecause : "", v.stale ? `Last read failed: ${v.stale}` : ""].filter(Boolean);
  const qty = (n) => Number(n).toLocaleString("en-US", { maximumFractionDigits: Math.abs(n) >= 1000 ? 2 : 6 });
  return `<tr><td><div class="vn">${esc(v.name)}</div><div class="cap dim">${esc(caption(v))}</div><details class="more"><summary>Details</summary>${holds.length ? `<div class="holds">${holds.slice(0, 12).map((h) => `<span>${esc(h.asset)}</span><span>${qty(h.amount)}</span><span class="dim">${h.usd ? money(h.usd) : "no price"}${h.note ? ` · ${esc(h.note)}` : ""}</span>`).join("")}</div>` : '<div class="dim">Nothing held there.</div>'}${notes.map((x) => `<div>${esc(x)}</div>`).join("")}</details></td><td class="r num2">${money(v.usd)}${v.asOf ? `<div class="cap dim">${nyTime(v.asOf)}</div>` : ""}</td><td>${status}</td><td class="r">${owner ? `${canTrade(v) ? `<button type="button" class="ink sm" data-trade="${esc(v.id)}">Trade…</button> ` : ""}${canMove(v) ? `<button type="button" class="sm" data-move="${esc(v.id)}">Move…</button> ` : ""}<button type="button" class="link dim" data-unplug="${esc(v.id)}">Disconnect</button>` : ""}</td></tr>`;
}
function renderAccounts(L, owner) {
  $("accounts-tools").innerHTML = L.length ? '<button type="button" class="link dim" id="csv-balances">Download CSV</button>' : "";
  $("accounts").innerHTML = L.length
    ? `<table class="live-t"><tbody>${L.map((v) => accountRow(v, owner)).join("")}</tbody></table>`
    : A.connectLive ? `<p class="dim first">Nothing connected yet. Pick one:</p>${catalog(owner, "wide")}` : '<p class="empty">This server has no way to connect accounts.</p>';
  const on = (sel, fn) => { for (const el of $("accounts").querySelectorAll(sel)) el.addEventListener("click", () => fn(el)); };
  on("button.tile", (b) => openConnect(optionOf(b.dataset.kind), { exchange: b.dataset.kind === "exchange" ? b.dataset.extra : "", watch: b.dataset.extra === "watch", name: b.querySelector("b").textContent }));
  on("button[data-move]", (b) => openLiveMove(b.dataset.move));
  on("button[data-trade]", (b) => openTrade(b.dataset.trade));
  on("button[data-unplug]", (b) => own({ type: "disconnectVenue", venue: b.dataset.unplug }));
  if ($("csv-balances")) $("csv-balances").addEventListener("click", () => download(`balances-${A.now.slice(0, 10)}.csv`, [["account", "asset", "amount", "usd", "where", "as_of"], ...L.flatMap((v) => (v.holdings || []).map((h) => [v.name, h.asset, h.amount, h.usd, h.note || "", v.asOf || A.now]))]));
}

// ---- statement -------------------------------------------------------------------------

const qtyOf = (n) => Number(n).toLocaleString("en-US", { maximumFractionDigits: Math.abs(n) >= 1000 ? 2 : 8 });
const isLive = (o) => ["open", "partial", "pending"].includes(o.status);
const ST = { "not followed since a restart": ["Not followed since a restart", "failed"], filled: ["Filled", "settled"], settled: ["Done", "settled"], partial: ["Part filled", "pending"], open: ["Open", "pending"], pending: ["On the way", "pending"], "waiting for wallet": ["Waiting for your wallet", "pending"], canceled: ["Canceled", ""], expired: ["Expired", ""], rejected: ["Rejected", "failed"], failed: ["Failed", "failed"], returned: ["Returned", "failed"] };
/* the month a line falls in, in New York time, as its date is shown */
const monthOf = (iso) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(iso)).slice(0, 7);
const monthName = (m) => new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${m}-01T00:00:00Z`));
/* a statement's amount: a buy is money out, a sell money in; a transfer between your own places is shown as it is */
const amountOf = (l) => (l.type === "trade" ? (l.amountUsd ? `${l.amountUsd < 0 ? "−" : "+"}${fine(Math.abs(l.amountUsd))}` : "—") : fine(l.amountUsd));

/** what is still under way: orders on a book, and anything waiting for your wallet — each with what you can do about it */
function renderOpen(owner) {
  const orders = (A.orders || []).filter(isLive);
  const wallet = A.payments.filter((p) => p.live && p.status === "authorized");
  if (!orders.length && !wallet.length) return void ($("open-now").innerHTML = "");
  const orderRow = (o) => {
    const waiting = o.walletTxs && !o.ref;
    const amendable = !waiting && !o.canceling && ((A.venues.find((x) => x.id === o.venue) || {}).trade || {}).amend;
    return `<tr><td>${o.side === "buy" ? "Buy" : "Sell"} ${esc(qtyOf(o.qty))} ${esc(o.contractSize ? "contracts" : o.base)} · ${esc(o.venueName)}<span class="why">${esc([`${nyDay(o.at)} ${nyTime(o.at)}`, byOf(o), typeText(o), o.note].join(" · "))}</span></td><td class="r num2">${fine(o.qty * o.price * (o.contractSize || 1))}</td><td>${owner ? `${waiting ? `<button type="button" class="link" data-order-send="${esc(o.id)}"${INFLIGHT.has(o.clientId) ? " disabled" : ""}>${o.reported ? "Report again" : "Send from wallet…"}</button> · ` : ""}${amendable ? `<button type="button" class="link" data-amend="${esc(o.id)}">Change…</button> · ` : ""}<button type="button" class="link dim" data-cancel="${esc(o.id)}" data-venue="${esc(o.venue)}">Cancel</button>` : `<span class="st pending">${o.canceling ? "Canceling" : "Open"}</span>`}</td></tr>`;
  };
  const payRow = (p) => `<tr><td>${esc(whatOf(p))}<span class="why">${esc(`${nyDay(p.at)} ${nyTime(p.at)} · ${byOf(p)}${p.live.sendBy && !p.live.reported ? ` · send by ${nyTime(p.live.sendBy)}` : ""}`)}</span></td><td class="r num2">${fine(p.amountUsd)}</td><td>${owner ? `<button type="button" class="link" data-wallet-send="${esc(p.id)}"${INFLIGHT.has(`${p.id}@${p.at}`) ? " disabled" : ""}>${p.live.reported ? "Report again" : "Send from wallet…"}</button>` : '<span class="st pending">Waiting for your wallet</span>'}</td></tr>`;
  $("open-now").innerHTML = `<div class="sub-h">Under way</div><table class="open-t"><tbody>${orders.map(orderRow).join("")}${wallet.map(payRow).join("")}</tbody></table>`;
  for (const b of $("open-now").querySelectorAll("button[data-cancel]")) b.addEventListener("click", () => own({ type: "liveCancel", venue: b.dataset.venue, order: b.dataset.cancel }));
  for (const b of $("open-now").querySelectorAll("button[data-amend]")) b.addEventListener("click", () => openAmend(A.orders.find((x) => x.id === b.dataset.amend)));
  const later = (fn) => async (b) => {
    b.disabled = true;
    try {
      await fn(b);
    } catch (err) {
      flash = String((err && err.message) || err).slice(0, 200);
    }
    await load();
  };
  for (const b of $("open-now").querySelectorAll("button[data-order-send]")) b.addEventListener("click", () => later(async () => sendOrderFromWallet(A.orders.find((x) => x.id === b.dataset.orderSend)))(b));
  for (const b of $("open-now").querySelectorAll("button[data-wallet-send]")) b.addEventListener("click", () => later(async () => {
    const p = A.payments.find((x) => x.id === b.dataset.walletSend);
    const n = p && p.legs[0].native;
    if (n && n.walletTx) await sendFromWallet(p, n.walletTx, n.walletTxs);
  })(b));
}

/** Every transaction, one line each, like a bank statement: what, where, how much, who, how it stands. Filtered by month, account and type;
 * downloaded as CSV; printed */
function renderStatement(owner) {
  renderOpen(owner);
  const working = (A.orders || []).filter(isLive);
  const months = [...new Set(S.map((l) => monthOf(l.at)))].sort().reverse();
  if (view.month && view.month !== "all" && !months.includes(view.month)) view.month = "";
  const month = view.month || (months.includes(monthOf(A.now)) ? monthOf(A.now) : "all");
  const lines = S.filter((l) => (month === "all" || monthOf(l.at) === month) && (!view.account || l.account === view.account || l.to === view.account) && (!view.type || l.type === view.type));
  $("statement-tools").innerHTML = `${owner && working.length > 1 ? `<button type="button" class="link" id="cancel-all">Cancel all ${working.length} open</button> · ` : ""}${S.length ? '<button type="button" class="link dim" id="csv-statement">Download CSV</button> · <button type="button" class="link dim" id="print-statement">Print</button>' : ""}`;
  const accounts = [...new Map(S.flatMap((l) => [[l.account, l.accountName], ...(l.to ? [[l.to, l.toName || l.to]] : [])])).entries()];
  $("statement-filters").innerHTML = S.length ? `${select("month", [["all", "All time"], ...months.map((m) => [m, monthName(m)])], month)}${select("account", [["", "All accounts"], ...accounts], view.account)}${select("type", [["", "Trades and transfers"], ["trade", "Trades"], ["transfer", "Transfers"]], view.type)}` : "";
  for (const el of $("statement-filters").querySelectorAll("select")) el.addEventListener("change", () => { view[el.name] = el.value; allStatement = false; renderStatement(owner); });
  if (!S.length) return void ($("statement").innerHTML = `<p class="empty">${connected().length ? "No transactions yet. Trade or move money from an account above, or let an agent trade inside a limit." : "Connect an account to start."}</p>`);
  const sum = (f) => lines.filter(f).reduce((s, l) => s + Math.abs(l.amountUsd), 0);
  // a trade counts what filled; a transfer counts unless it failed or never left; a fee only where money moved
  const moved = (l) => l.type === "transfer" && !["failed", "returned", "waiting for wallet", "not followed since a restart"].includes(l.status);
  const fees = lines.reduce((s, l) => s + (l.type === "transfer" && !moved(l) ? 0 : l.feeUsd || 0), 0);
  const [bought, sold, sent] = [sum((l) => l.kind === "buy"), sum((l) => l.kind === "sell"), sum(moved)];
  const total = [plural(lines.length, "transaction"), bought ? `bought ${money(bought)}` : "", sold ? `sold ${money(sold)}` : "", sent ? `moved ${money(sent)}` : "", fees ? `fees ${fine(fees)}` : ""].filter(Boolean).join(" · ");
  const shown = allStatement ? lines : lines.slice(0, 25);
  $("print-head").innerHTML = `<b>Account statement</b> · ${esc(month === "all" ? "all time" : monthName(month))}${view.account ? ` · ${esc(nameOf(view.account))}` : ""} · printed ${esc(nyDay(A.now))} ${esc(nyTime(A.now))} New York`;
  $("statement").innerHTML = lines.length
    ? `<table class="stmt"><thead><tr><th>Date</th><th>Description</th><th class="hide-s">Account</th><th class="r">Amount</th><th>Status</th></tr></thead><tbody>${shown.map((l) => {
      const [label, cls] = ST[l.status] || [l.status, ""];
      const sub = [l.by, l.type === "trade" && !l.amountUsd && l.worthUsd ? `worth ${fine(l.worthUsd)}` : "", l.feeUsd ? `fee ${fine(l.feeUsd)}` : "", l.ref ? `ref ${short(l.ref)}` : "", l.id].filter(Boolean).join(" · ");
      return `<tr><td class="num2 dim">${esc(nyDay(l.at))}<span class="why">${esc(nyTime(l.at))}</span></td><td>${esc(l.description)}<span class="why">${esc(sub)}</span></td><td class="hide-s">${esc(l.accountName)}${l.toName ? ` → ${esc(l.toName)}` : ""}</td><td class="r num2">${esc(amountOf(l))}</td><td><span class="st ${cls}">${esc(label)}</span></td></tr>`;
    }).join("")}</tbody></table><div class="totals dim small">${esc(total)}</div>${lines.length > shown.length ? `<button type="button" class="link dim more-btn" id="all-statement">Show all ${lines.length}</button>` : ""}`
    : '<p class="empty">Nothing in this view.</p>';
  if ($("all-statement")) $("all-statement").addEventListener("click", () => { allStatement = true; renderStatement(owner); });
  if ($("cancel-all")) $("cancel-all").addEventListener("click", async () => {
    // every open order off the book, one signature each
    for (const o of working) await own({ type: "liveCancel", venue: o.venue, order: o.id });
  });
  if ($("csv-statement")) $("csv-statement").addEventListener("click", () => download(`statement-${month === "all" ? "all" : month}.csv`, [["date", "id", "type", "kind", "account", "to", "description", "amount_usd", "fee_usd", "status", "by", "ref"], ...lines.map((l) => [l.at, l.id, l.type, l.kind, l.accountName, l.toName || "", l.description, l.amountUsd, l.feeUsd ?? "", l.status, l.by, l.ref || ""])]));
  if ($("print-statement")) $("print-statement").addEventListener("click", () => {
    allStatement = true;
    renderStatement(owner);
    document.body.dataset.print = "statement";
    window.print();
    delete document.body.dataset.print;
  });
}

/* an order's type in words: market, a limit, a stop and where it triggers */
const typeText = (o) => (o.type === "limit" ? `limit ${px(o.limitPrice)}` : o.type === "stop" ? `stop at ${px(o.stopPrice)}` : o.type === "stop_limit" ? `stop ${px(o.stopPrice)}, limit ${px(o.limitPrice)}` : "market") + (o.tif ? ` · ${o.tif.toUpperCase()}` : "") + (o.postOnly ? " · post-only" : "") + (o.reduceOnly ? " · reduce-only" : "");

/** change an open order in place: a new size, limit or stop. The account values it afresh and shows what it would be worth; your signature changes it */
function openAmend(o) {
  if (!o) return;
  const limited = o.type === "limit" || o.type === "stop_limit";
  const stopped = o.type === "stop" || o.type === "stop_limit";
  $("modal-form").innerHTML = `<h2>Change ${esc(o.id)} · ${esc(o.venueName)}</h2><div class="dim small">${esc(`${o.side === "buy" ? "Buy" : "Sell"} ${qtyOf(o.qty)} ${o.base} · ${typeText(o)}`)}. Leave a field empty to keep it.</div>
    <div class="row">${field("Size", `<input name="qty" inputmode="decimal" placeholder="${esc(String(o.qty))}" autocomplete="off" />`)}${stopped ? field("Stop price", `<input name="stopPrice" inputmode="decimal" placeholder="${esc(String(o.stopPrice))}" autocomplete="off" />`) : ""}${limited ? field("Limit price", `<input name="limitPrice" inputmode="decimal" placeholder="${esc(String(o.limitPrice))}" autocomplete="off" />`) : ""}</div>
    <div class="quote real" id="quote"><span class="dim">Type what changes.</span></div>
    <details id="signs" hidden><summary>What you sign</summary><pre id="signs-pre"></pre></details>
    <div class="msg" id="modal-msg"></div>
    <div class="end"><button type="button" id="modal-cancel">Cancel</button><button type="submit" class="ink" id="modal-go" disabled>Sign and change</button></div>`;
  const form = $("modal-form");
  let prepared = null;
  let timer = 0;
  let seq = 0;
  const quote = async () => {
    const my = ++seq;
    prepared = null;
    $("modal-go").disabled = true;
    const f = formOf("modal-form");
    const d = { type: "liveAmend", venue: o.venue, order: o.id, qty: String(f.qty || "").trim(), limitPrice: String(f.limitPrice || "").trim(), stopPrice: String(f.stopPrice || "").trim() };
    if (!d.qty && !d.limitPrice && !d.stopPrice) return void ($("quote").innerHTML = '<span class="dim">Type what changes.</span>');
    const r = await Owner.prepare(d);
    if (my !== seq) return;
    if (r.status !== 200) return void ($("quote").innerHTML = `<div class="msg no">${esc(Owner.why(r))}</div>`);
    prepared = r.body;
    const q = prepared.quote.order;
    $("quote").innerHTML = `<div class="big"><span>${esc(q.words)}</span><span>≈ ${money(q.notionalUsd)}</span></div><div class="path">${o.side === "buy" ? `costs at most ${money(q.maxUsd)}` : `worth about ${money(q.maxUsd)}`} · your signature is good for 10 minutes</div>`;
    $("signs-pre").textContent = prepared.shown.map((x) => `${x.name}: ${x.value}`).join("\n");
    $("signs").hidden = false;
    $("modal-go").disabled = Owner.role !== "owner";
  };
  for (const el of form.querySelectorAll("input")) el.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(quote, 350); });
  $("modal-cancel").addEventListener("click", () => $("modal").close());
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (!prepared) return;
    $("modal-go").disabled = true;
    const r = await Owner.submit(prepared);
    if (r.status >= 400 || (r.body && r.body.ok === false)) {
      $("modal-msg").className = "msg no";
      $("modal-msg").textContent = Owner.why(r) || "Refused";
      return void quote();
    }
    said = `Changed: ${r.body.order.id} · ${r.body.order.note}`;
    $("modal").close();
    await load();
  };
  if (!$("modal").open) $("modal").showModal();
  form.elements.qty.focus();
}

// ---- positions --------------------------------------------------------------------------

/* what each venue that lists positions holds: asked when the page loads (the server keeps an answer fifteen seconds) */
const POS = new Map();
function renderPositions(L, owner) {
  const venues = L.filter((v) => v.trade && v.trade.positions);
  $("positions-sec").hidden = !venues.length;
  if (!venues.length) return;
  for (const v of venues) {
    fetch(`/api/account/positions?${new URLSearchParams({ venue: v.id })}`).then((r) => r.json()).then((r) => {
      const before = JSON.stringify(POS.get(v.id) || null);
      POS.set(v.id, r.ok ? r.positions : { error: (r.refusal && r.refusal.message) || "no answer" });
      if (JSON.stringify(POS.get(v.id)) !== before) drawPositions(venues, owner);
    }).catch(() => {});
  }
  drawPositions(venues, owner);
}
function drawPositions(venues, owner) {
  const rows = venues.flatMap((v) => {
    const p = POS.get(v.id);
    if (!p) return [`<tr><td>${esc(v.name)}</td><td colspan="3" class="dim">Asking…</td></tr>`];
    if (p.error) return [`<tr><td>${esc(v.name)}</td><td colspan="3" class="dim">${esc(p.error)}</td></tr>`];
    return p.filter((x) => x.qty > 0).map((x) => `<tr><td>${esc(x.name)}<span class="why">${esc(v.name)} · ${x.side === "long" ? "long" : "short"} ${esc(qtyOf(x.qty))}${x.leverage ? ` · ${x.leverage}x` : ""}${x.entryPrice ? ` · entry ${px(x.entryPrice)}` : ""}${x.markPrice ? ` · mark ${px(x.markPrice)}` : ""}${x.liquidationPrice ? ` · liquidation ${px(x.liquidationPrice)}` : ""}</span></td><td class="r num2">${x.usd !== undefined ? money(x.usd) : "—"}</td><td class="r num2 ${x.unrealizedUsd > 0 ? "up" : x.unrealizedUsd < 0 ? "down" : ""}">${x.unrealizedUsd !== undefined ? `${x.unrealizedUsd >= 0 ? "+" : "−"}${money(Math.abs(x.unrealizedUsd))}` : ""}</td><td class="r">${owner && canTrade(v) ? `<button type="button" class="link" data-close="${esc(x.symbol)}" data-venue="${esc(v.id)}">Close</button>` : ""}</td></tr>`);
  });
  $("positions").innerHTML = rows.length ? `<table class="pos-t"><tbody>${rows.join("")}</tbody></table>` : '<p class="empty">Nothing held in positions.</p>';
  for (const b of $("positions").querySelectorAll("button[data-close]")) b.addEventListener("click", () => {
    if (confirm(`Close the whole position in ${b.dataset.close}? It is sold (or bought back) at market.`)) own({ type: "liveClose", venue: b.dataset.venue, symbol: b.dataset.close, qty: "" }, async () => POS.delete(b.dataset.venue));
  });
}

// ---- agent wallets ------------------------------------------------------------------------

/** Wallets the account holds the key of, so that an agent can pay for things without you there: made by your signature, filled from your own
 * accounts, paid from inside the payees limit you give the agent, and emptied back to you */
function renderWallets(owner) {
  const subs = A.subAccounts || [];
  const live = (s) => A.venues.find((v) => v.id === `agent-${slug(s.name)}`);
  const sources = connected().filter((v) => canMove(v) && !v.id.startsWith("agent-"));
  const rows = subs.map((s) => {
    const v = live(s);
    const coins = v ? (v.holdings || []).filter((h) => h.amount > 0) : [];
    const gas = coins.filter((h) => h.class !== "stable" && h.class !== "cash");
    return `<tr><td>${esc(s.name)}<span class="why">pays for ${esc(s.agentName)} · <span class="mono">${esc(short(s.address))}</span> <button type="button" class="link dim" data-copy="${esc(s.address)}">Copy</button></span></td><td class="r num2">${v ? money(v.usd) : "—"}<span class="why">${esc(coins.filter((h) => !gas.includes(h)).map((h) => `${h.asset} ${qtyOf(h.amount)}${h.note ? ` on ${h.note}` : ""}`).join(" · ") || "empty")}${gas.length ? ` · gas ${esc(gas.map((h) => `${qtyOf(h.amount)} ${h.asset}${h.note ? ` (${h.note})` : ""}`).join(", "))}` : " · no gas yet"}</span></td><td class="r">${owner && v ? `${sources.length ? `<button type="button" class="link" data-topup="${esc(v.id)}">Top up…</button> · ` : ""}<button type="button" class="link dim" data-takeback="${esc(v.id)}">Take back…</button>` : ""}</td></tr>`;
  }).join("");
  const keys = A.keys.filter((k) => k.status === "ok");
  const form = owner && writesOn() && keys.length ? `<form class="add" id="wallet-form">${field("Name", '<input class="m" name="name" placeholder="research" maxlength="16" />')}${field("For agent", select("agent", keys.map((k) => [k.address, k.name])))}${field("Keep up to", '<input class="s" name="float" inputmode="decimal" placeholder="50" />')}<button type="submit" class="ink">Make it</button></form>` : "";
  $("wallets").innerHTML = `${subs.length ? `<table><tbody>${rows}</tbody></table>` : `<p class="empty">${keys.length ? "No agent wallet yet." : "Let an agent in first: a wallet pays for one agent."}</p>`}${form}<p class="dim small hint">The account holds its key; the agent never sees it. It pays x402 and MPP charges in USDC (Base, Arbitrum, Optimism, Polygon, Ethereum) inside the payees limit you give the agent under Agents. Sending money back out pays a little gas in that chain's own coin.</p>`;
  for (const b of $("wallets").querySelectorAll("button[data-copy]")) b.addEventListener("click", () => copyText(b.dataset.copy, b));
  for (const b of $("wallets").querySelectorAll("button[data-takeback]")) b.addEventListener("click", () => openLiveMove(b.dataset.takeback));
  for (const b of $("wallets").querySelectorAll("button[data-topup]")) b.addEventListener("click", () => {
    const from = sources.length === 1 ? sources[0].id : prompt(`Top up from which account? ${sources.map((x) => `${x.id} (${x.name})`).join(", ")}`, sources[0].id);
    if (from && sources.some((x) => x.id === from)) openLiveMove(from, { to: b.dataset.topup });
  });
  const f = $("wallet-form");
  if (f) f.addEventListener("submit", (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(f).entries());
    const name = String(v.name || "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9 _-]{0,15}$/.test(name) || !(Number(v.float) > 0)) return void ((flash = "An agent wallet needs a name (letters and digits, up to 16) and how much it keeps at most."), render());
    own({ type: "createSubAccount", name, agent: v.agent, float: String(v.float).trim() });
  });
}

const whatOf = (p) => (p.kind === "swap" ? `Swap at ${nameOf(p.from)} · ${p.sourceToken} → ${p.token}` : p.kind === "transfer" && p.from === p.to ? `Transfer at ${nameOf(p.from)} · ${p.legs[0].fromLedger} → ${p.legs[0].toLedger}` : `${p.kind[0].toUpperCase() + p.kind.slice(1)} · ${nameOf(p.from)} → ${nameOf(p.to)}${p.live && p.live.network ? ` · ${p.live.network}` : ""}`);
/* who did it: you, or an agent — on your yes (Conservative), or inside its limit (Aggressive) */
const byOf = (p) => (p.authority !== "agent" ? "You" : `${keyName(p.agent)}, ${p.card ? "approved by you" : "inside its limit"}`);

/* a table as a CSV file the browser saves */
const csvCell = (c) => { const v = String(c ?? ""); return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
function download(name, rows) {
  const url = URL.createObjectURL(new Blob([`${rows.map((r) => r.map(csvCell).join(",")).join("\n")}\n`], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- agents -----------------------------------------------------------------------------

function renderAgents(L, owner) {
  const keys = A.keys.filter((k) => k.status === "ok" || k.status === "expired");
  const limitOf = (k, scope) => A.spend.find((s) => s.scope === scope && s.agent === k.address);
  const asking = A.requests.map((r) => `<tr><td class="num2">${esc(short(r.address))}</td><td class="dim">asked to be let in · ${nyDay(r.at)} ${nyTime(r.at)}</td><td class="r">${owner ? `<button type="button" class="link" data-fill="${esc(r.address)}">Let in…</button>` : ""}</td></tr>`).join("");
  const rows = keys.map((k) => {
    const t = limitOf(k, "trade");
    const m = limitOf(k, "venues");
    const y = limitOf(k, "payees");
    const s = t || m || y;
    const pays = y ? `pays ${y.allow.includes("*") ? "any payee" : y.allow.join(", ")} up to ${fine(y.perPaymentUsd)} each (${fine(y.spentUsd)} of ${fine(y.budgetUsd)})` : "";
    const where = [t ? `trades at ${t.allow.map(nameOf).join(", ")}` : "", m ? `moves money between ${m.allow.map(nameOf).join(", ")}` : "", t || m ? pays : y ? `pays ${y.allow.includes("*") ? "any payee" : y.allow.join(", ")}` : ""].filter(Boolean).join(" · ");
    const limit = s ? `${fine(s.spentUsd)} of ${fine(s.budgetUsd)} used · up to ${fine(s.perPaymentUsd)} ${t ? "an order" : m ? "a move" : "a payment"}<span class="why">${esc(where)}${s.reservedUsd ? ` · ${fine(s.reservedUsd)} waiting` : ""}${s.expired ? " · limit expired" : ` · until ${nyDay(s.validUntil)}`}</span>` : '<span class="dim">No limit yet: it can do nothing</span>';
    return `<tr><td>${esc(k.name)}<span class="why mono">${esc(short(k.address))}${k.status === "expired" ? " · expired" : ` · until ${nyDay(k.validUntil)}`}</span></td><td>${limit}</td><td class="r">${owner && k.status === "ok" ? `<button type="button" class="link dim" data-limit="${esc(k.address)}">Change limit</button> · <button type="button" class="link dim" data-revoke="${esc(k.name)}">Revoke</button>` : ""}</td></tr>`;
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
  $("devices").innerHTML = `<table><tbody>${A.signers.owners.map((o) => `<tr><td>${o.id === `device:${Owner.kid}` ? "This browser" : o.kind === "device" ? "Another browser" : "Wallet key"}</td><td class="num2 dim">${esc(short(o.id.replace("device:", "")))}</td><td class="r dim">${A.signers.threshold} of ${A.signers.owners.length} must sign</td></tr>`).join("")}${A.signers.pendingDevices.map((d) => `<tr><td>A browser asked to sign</td><td class="num2 dim">${esc(d.kid)}</td><td class="r">${owner ? `<button type="button" class="link" data-signer="${esc(d.kid)}" data-both="0">Let it sign</button> · <button type="button" class="link" data-signer="${esc(d.kid)}" data-both="1">Require both</button>` : ""}</td></tr>`).join("")}</tbody></table>`;
  for (const b of $("devices").querySelectorAll("button[data-signer]")) {
    b.addEventListener("click", () => {
      const users = [...A.signers.owners.map((o) => o.id), `device:${b.dataset.signer}`].sort();
      own({ type: "convertToMultiSigUser", signers: JSON.stringify({ authorizedUsers: users, threshold: b.dataset.both === "1" ? users.length : A.signers.threshold }) });
    });
  }
}

const field = (label, html) => `<label>${label}${html}</label>`;
const select = (name, opts, sel) => `<select name="${name}">${opts.map(([v, l, dis]) => `<option value="${esc(v)}"${v === sel ? " selected" : ""}${dis ? " disabled" : ""}>${esc(l)}</option>`).join("")}</select>`;
const formOf = (id) => Object.fromEntries(new FormData($(id)).entries());

// ---- wallets in this browser ------------------------------------------------------------

/* Wallets this browser has, as they announce themselves (EIP-6963): the listener is added first and never removed, then the page asks, and
   every wallet answers again. window.ethereum is used only when nothing announced itself, as the EIP says. */
const WALLETS = new Map();
window.addEventListener("eip6963:announceProvider", (e) => { const d = e.detail; if (d && d.info && d.provider) WALLETS.set(d.info.uuid || d.info.rdns || d.info.name, d); });
window.dispatchEvent(new Event("eip6963:requestProvider"));
const findWallets = async () => {
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  await new Promise((r) => setTimeout(r, 120));
  const found = [...WALLETS.values()];
  const eth = window.ethereum;
  if (!found.length && eth) found.push({ info: { name: eth.isOkxWallet || eth.isOKExWallet ? "OKX Wallet" : eth.isBinance ? "Binance Wallet" : eth.isCoinbaseWallet ? "Coinbase Wallet" : eth.isMetaMask ? "MetaMask" : "Browser wallet" }, provider: eth });
  return found;
};
const hexOf = (text) => "0x" + [...new TextEncoder().encode(text)].map((b) => b.toString(16).padStart(2, "0")).join("");
const postJson = async (path, body) => { const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };

/** ask the wallet for its address, then for its signature on the sentence the account wrote: that is what shows the address is yours */
async function proveWallet(w) {
  const accounts = await w.provider.request({ method: "eth_requestAccounts" });
  const address = accounts && accounts[0];
  if (!address) throw new Error("the wallet gave no address");
  const chainId = parseInt(await w.provider.request({ method: "eth_chainId" }).catch(() => "0x1"), 16) || 1;
  const c = await postJson("/api/account/wallet/challenge", { address, wallet: w.info.name, chainId });
  if (c.status !== 200) throw new Error(Owner.why(c) || "no sentence to sign");
  const signature = await w.provider.request({ method: "personal_sign", params: [hexOf(c.body.message), address] });
  const p = await postJson("/api/account/wallet/prove", { address, signature });
  if (p.status !== 200) throw new Error(Owner.why(p) || "the signature did not check");
  PROVIDERS.set(String(p.body.address).toLowerCase(), w);
  return { address: p.body.address, wallet: w.info.name };
}

// ---- real money -------------------------------------------------------------------------

/** the wallet each proven address was proven with, while this page is open */
const PROVIDERS = new Map();
const writesOn = () => !!(A.connectLive && A.connectLive.writes && A.connectLive.writes.on);
const watched = (v) => !!v.address && !v.proven;
/* an order can be placed here: trading is on, the venue trades, the key may (or has not said), and a wallet is proven yours */
const canTrade = (v) => writesOn() && !!v.trade && v.trade.can !== false && !watched(v);
const canMove = (v) => writesOn() && !!v.liveCan && !v.readOnlyBecause && !watched(v) && (v.liveCan.withdraw !== false || (v.liveCan.ledgers.length > 1 && v.liveCan.transfer !== false) || v.liveCan.swap !== false || !!v.liveCan.send);
/* writes are on, the venue is written, but this key lets nothing leave it: it can still receive */
const keyOnlyReads = (v) => writesOn() && !!v.liveCan && !v.readOnlyBecause && !watched(v) && !canMove(v);
const NETWORKS = ["Arbitrum", "Base", "Ethereum", "Optimism", "Polygon", "BNB Chain"];

/** the wallet that proved `address`, asked again if this page has forgotten it; it has to answer with that same address */
async function walletFor(address) {
  const known = PROVIDERS.get(address.toLowerCase());
  if (known) return known;
  for (const w of await findWallets()) {
    const accounts = await w.provider.request({ method: "eth_requestAccounts" }).catch(() => []);
    if ((accounts || []).some((a) => a.toLowerCase() === address.toLowerCase())) {
      PROVIDERS.set(address.toLowerCase(), w);
      return w;
    }
  }
  throw new Error(`no wallet in this browser answers for ${short(address)}: open this page where that wallet is installed`);
}

/** the account built the transaction; the wallet shows it to you and sends it; the page tells the account which transaction it was */
async function sendFromWallet(p, tx, txs) {
  const key = `${p.id}@${p.at}`;
  if (INFLIGHT.has(key)) throw new Error(`${p.id} is already waiting for your wallet: finish it there`);
  INFLIGHT.add(key);
  try {
    await sendPaymentOnce(p, key, tx, txs);
  } finally {
    INFLIGHT.delete(key);
  }
}
async function sendPaymentOnce(p, key, tx, txs) {
  const paymentId = p.id;
  // asked again first: the account may already have a hash for it (another tab, a reload), and then that one is reported, nothing is sent
  const now = ((await (await fetch("/api/account")).json()).payments || []).find((x) => x.id === p.id && x.at === p.at);
  if (!now || !(now.status === "authorized" || (now.status === "failed" && now.live && now.live.expired))) throw new Error(`${p.id} is no longer waiting for your wallet (${now ? now.status : "gone"}): nothing was sent`);
  if (now.live && now.live.reported) SENT.set(key, now.live.reported);
  const all = txs && txs.length ? txs : [tx];
  const w = await walletFor(all[0].from);
  const send = async (t) => {
    try {
      await w.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: t.chainIdHex }] });
    } catch (err) {
      throw new Error(`${w.info.name} did not switch to the right network: ${(err && err.message) || err}`);
    }
    return w.provider.request({ method: "eth_sendTransaction", params: [{ from: t.from, to: t.to, data: t.data, value: t.value, ...(t.gas ? { gas: t.gas } : {}) }] });
  };
  // a bridge's approval first, on chain before the transfer; a transfer the wallet already sent is reported again, never sent twice
  let hash = SENT.get(key);
  if (!hash) {
    for (const t of all.slice(0, -1)) await mined(w, await send(t));
    hash = await send(all[all.length - 1]);
    SENT.set(key, hash);
  }
  const r = await postJson("/api/account/live/sent", { payment: paymentId, hash });
  if (r.status !== 200) throw new Error(`${Owner.why(r) || "the account could not take the transaction"}. Your wallet sent ${short(hash)}: “Report again” reports that same transaction, it does not send another`);
  SENT.delete(key);
  said = `${w.info.name} sent it: ${short(hash)}`;
}

/** move real money at an account: what is possible there, the address and fee the account finds, then your signature */
function openLiveMove(venueId, preset = {}) {
  const v = A.venues.find((x) => x.id === venueId);
  if (!v || !v.liveCan) return;
  const c = v.liveCan;
  const kinds = [...(c.withdraw !== false && !c.send ? [["withdraw", "Withdraw to another account of yours"]] : []), ...(c.send ? [["send", "Send from this wallet"]] : []), ...(c.send === "wallet" && v.proven ? [["bridge", "Across chains"]] : []), ...(c.ledgers.length > 1 && c.transfer !== false ? [["transfer", "Between its own ledgers"]] : []), ...(c.swap !== false && !c.send ? [["swap", "Swap stablecoins"]] : [])];
  const dests = A.venues.filter((x) => x.id !== v.id && x.watchOnly && x.liveCan && x.liveCan.receive && !x.readOnlyBecause);
  $("modal-form").innerHTML = `<h2>Move money · ${esc(v.name)}</h2><div class="dim small">Up to ${money(A.connectLive.writes.capUsd)} a move.</div>
    ${field("What", select("kind", kinds))}
    <div id="move-body"></div>
    <div class="quote real" id="quote"><span class="dim">Fill it in to see where it goes and what it costs.</span></div>
    <details id="signs" hidden><summary>What you sign</summary><pre id="signs-pre"></pre></details>
    <div class="msg" id="modal-msg"></div>
    <div class="end"><button type="button" id="modal-cancel">Cancel</button><button type="submit" class="ink" id="modal-go" disabled>Sign and send</button></div>`;
  const form = $("modal-form");
  let prepared = null;
  let timer = 0;
  // the latest ask wins: an answer to an older one is dropped (each ask of a bridge costs LI.FI quotes)
  let seq = 0;
  const say = (text, state) => { $("modal-msg").className = `msg${text && state ? ` ${state}` : ""}`; $("modal-msg").textContent = text || ""; };
  const body = () => {
    const k = form.elements.kind.value;
    const assets = [["USDC", "USDC"], ["USDT", "USDT"]];
    $("move-body").innerHTML = k === "transfer"
      ? `<div class="row">${field("From", select("fromLedger", c.ledgers.map((l) => [l, l])))}${field("To", select("toLedger", c.ledgers.map((l) => [l, l]), c.ledgers[1]))}</div><div class="row">${field("Currency", select("asset", assets))}${field("Amount", '<input name="amount" inputmode="decimal" placeholder="50" autocomplete="off" required />')}</div>`
      : k === "swap"
        ? `<div class="row">${field("Sell", select("asset", assets, "USDT"))}${field("Buy", select("toAsset", assets, "USDC"))}</div>${field("Amount", '<input name="amount" inputmode="decimal" placeholder="50" autocomplete="off" required />')}`
        : k === "bridge"
          ? `${field("To", select("to", [[v.id, "This wallet, on the other chain"], ...dests.filter((d) => !d.address || d.proven).map((d) => [d.id, d.name])]))}<div class="row">${field("From chain", select("network", NETWORKS.map((x) => [x, x]), "Arbitrum"))}${field("To chain", select("toLedger", NETWORKS.map((x) => [x, x]), "Base"))}</div><div class="row">${field("Send", select("asset", assets))}${field("Arrives as", select("toAsset", assets))}</div>${field("Amount", '<input name="amount" inputmode="decimal" placeholder="25" autocomplete="off" required />')}`
        : `${dests.length ? field("To", select("to", dests.map((d) => [d.id, `${d.name}${d.address ? (d.proven ? "" : " · watched") : ""}`, !!d.address && !d.proven]))) : '<div class="path dim">Connect where it should go first: another exchange, or your wallet from the wallet itself.</div>'}<div class="row">${field("Network", select("network", NETWORKS.map((x) => [x, x])))}${field("Currency", select("asset", assets))}</div>${field("Amount", '<input name="amount" inputmode="decimal" placeholder="25" autocomplete="off" required />')}${k === "withdraw" ? '<div class="path"><button type="button" class="link dim" id="fees-all">Fees on every network</button><span id="fees-list" class="dim small"></span></div>' : ""}`;
    if ($("fees-all")) $("fees-all").addEventListener("click", feesEverywhere);
    for (const el of form.querySelectorAll("#move-body select, #move-body input")) el.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(quote, 300); });
    quote();
  };
  const draft = () => {
    const f = formOf("modal-form");
    const k = f.kind;
    return { type: "liveMove", kind: k, from: v.id, to: k === "transfer" || k === "swap" ? v.id : f.to || "", fromLedger: f.fromLedger || "", toLedger: f.toLedger || "", asset: f.asset || "USDC", toAsset: k === "swap" || k === "bridge" ? f.toAsset || f.asset : f.asset || "USDC", network: k === "transfer" || k === "swap" ? "" : f.network || "", amount: String(f.amount || "").trim() };
  };
  /* a withdrawal's fee on every network the destination takes, side by side: one click picks the network */
  const feesEverywhere = async () => {
    const d = draft();
    if (!(Number(d.amount) > 0)) return void ($("fees-list").textContent = " · type an amount first");
    $("fees-list").textContent = " · asking…";
    const rows = await Promise.all(NETWORKS.map(async (n) => {
      const r = await Owner.prepare({ ...d, network: n });
      return r.status === 200 ? { n, fee: Number(r.body.action.maxFee) } : { n, why: Owner.why(r) };
    }));
    const okRows = rows.filter((x) => x.fee !== undefined).sort((a, b) => a.fee - b.fee);
    $("fees-list").innerHTML = ` · ${okRows.map((x) => `<button type="button" class="link" data-net="${esc(x.n)}">${esc(x.n)} ${esc(x.fee.toFixed(2))} ${esc(d.asset)}</button>`).join(" · ") || "no network takes it"}${rows.length > okRows.length ? ` · not on ${esc(rows.filter((x) => x.fee === undefined).map((x) => x.n).join(", "))}` : ""}`;
    for (const b of $("fees-list").querySelectorAll("button[data-net]")) b.addEventListener("click", () => { form.elements.network.value = b.dataset.net; quote(); });
  };
  const quote = async () => {
    const my = ++seq;
    prepared = null;
    $("modal-go").disabled = true;
    $("signs").hidden = true;
    const d = draft();
    if (!(Number(d.amount) > 0)) return void ($("quote").innerHTML = '<span class="dim">Fill it in to see where it goes and what it costs.</span>');
    $("quote").innerHTML = `<span class="dim">Asking ${esc(v.name)}…</span>`;
    const r = await Owner.prepare(d);
    if (my !== seq) return;
    if (r.status !== 200) return void ($("quote").innerHTML = `<div class="msg no">${esc(Owner.why(r))}</div>`);
    prepared = r.body;
    const a = prepared.action;
    const to = A.venues.find((x) => x.id === a.to) || {};
    if (a.kind === "bridge") {
      // the route the account signs for (the cheapest), and the others, from the same answer the bridge will be held to
      const rr = await postJson("/api/account/bridge-routes", { draft: d });
      if (my !== seq) return;
      const routes = rr.status === 200 ? rr.body.routes : [];
      const best = routes[0];
      const eta = (s) => (s < 90 ? `~${Math.max(1, Math.round(s))} s` : s < 5400 ? `~${Math.round(s / 60)} min` : `~${Math.round(s / 3600)} h`);
      $("quote").innerHTML = `<div class="big"><span>${esc(a.amount)} ${esc(a.asset)} · ${esc(a.network)} → ${esc(a.toLedger)}</span><span>fee up to ${esc(a.maxFee)}</span></div>${best ? `<div class="path"><b>Via ${esc(best.tool)}</b> · at least ${money(best.receiveUsd)} ${esc(a.toAsset)} arrives · ${esc(eta(best.etaSec))}${best.gasUsd ? ` · network fee about ${fine(best.gasUsd)} in your wallet` : ""}</div>` : ""}${routes.length > 1 ? `<div class="path">Other routes: ${routes.slice(1).map((x) => `${esc(x.tool)} fee ${fine(x.feeUsd)}, ${esc(eta(x.etaSec))}`).join(" · ")}</div>` : ""}<div class="path"><b>To</b> ${esc(a.to === v.id ? "this wallet" : to.name || a.to)} · <span class="mono">${esc(a.toAddress)}</span> on ${esc(a.toLedger)}</div><div class="path">Your wallet sends it; it lands on ${esc(a.toLedger)} when the bridge delivers. Can't be undone. Your signature is good for 10 minutes.</div>`;
      $("signs-pre").textContent = prepared.shown.map((x) => `${x.name}: ${x.value}`).join("\n");
      $("signs").hidden = false;
      $("modal-go").disabled = Owner.role !== "owner";
      return;
    }
    $("quote").innerHTML = `<div class="big"><span>${esc(a.amount)} ${esc(a.asset)}${a.kind === "swap" ? ` → ${esc(a.toAsset)}` : ""}</span><span>${a.kind === "send" ? "network fee in your wallet" : `fee up to ${esc(a.maxFee)} ${esc(a.asset)}`}</span></div>${a.toAddress ? `<div class="path"><b>To</b> ${esc(to.name || a.to)} · <span class="mono">${esc(a.toAddress)}</span> on ${esc(a.network)}</div><div class="path">${to.address ? "The address your wallet signed for." : `${esc(to.name || a.to)}'s deposit address, checked again before sending.`}</div>` : `<div class="path">${a.kind === "transfer" ? `${esc(a.fromLedger)} → ${esc(a.toLedger)} at ${esc(v.name)}` : `a market order at ${esc(v.name)}`}</div>`}<div class="path">Can't be undone. Your signature is good for 10 minutes.</div>`;
    $("signs-pre").textContent = prepared.shown.map((x) => `${x.name}: ${x.value}`).join("\n");
    $("signs").hidden = false;
    $("modal-go").disabled = Owner.role !== "owner";
  };
  form.elements.kind.addEventListener("change", body);
  $("modal-cancel").addEventListener("click", () => $("modal").close());
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (!prepared) return;
    $("modal-go").disabled = true;
    say(`Sending it to ${v.name}…`, "wait");
    const r = await Owner.submit(prepared);
    if (r.status >= 400 || (r.body && r.body.ok === false)) {
      say(Owner.why(r) || "Refused", "no");
      return void quote();
    }
    const out = r.body.kind === "result" ? r.body.result : null;
    if (out && out.wallet) {
      try {
        say("Waiting for your wallet…", "wait");
        await sendFromWallet(out.payment, out.wallet, out.walletTxs);
      } catch (err) {
        flash = `${String((err && err.message) || err).slice(0, 200)}. It waits in the Statement, under way: “Send from wallet…”`;
      }
    } else said = r.body.payment ? `${r.body.payment.note || "Sent"}` : "";
    $("modal").close();
    await load();
  };
  body();
  // opened to fill an agent wallet: that wallet is where it goes
  if (preset.to && form.elements.to && [...form.elements.to.options].some((o) => o.value === preset.to)) {
    form.elements.to.value = preset.to;
    form.elements.to.dispatchEvent(new Event("input"));
  }
  $("modal").showModal();
}

// ---- trading ----------------------------------------------------------------------------

/** wait for a transaction a wallet sent to be on chain, asked of the wallet itself (a swap after an approval needs the approval first) */
async function mined(w, hash, ms = 120_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const r = await w.provider.request({ method: "eth_getTransactionReceipt", params: [hash] }).catch(() => null);
    if (r && r.blockNumber) {
      if (r.status === "0x0") throw new Error(`transaction ${short(hash)} failed on chain`);
      return;
    }
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error(`transaction ${short(hash)} is not on chain yet: try again in a minute`);
}

/** a DEX order: the account built the transactions (an approval first, when one is needed); the wallet shows each one and sends it */
/** what a wallet has already sent, by a key no other run of the account reuses (an order's client id; a payment's id and time), while this
   page is open; the account itself keeps the hash once it has been reported */
const SENT = new Map();
/** payments and orders whose wallet flow is running in this page: never two at once for one */
const INFLIGHT = new Set();

async function sendOrderFromWallet(o) {
  if (INFLIGHT.has(o.clientId)) throw new Error(`${o.id} is already waiting for your wallet: finish it there`);
  INFLIGHT.add(o.clientId);
  try {
    await sendOrderOnce(o);
  } finally {
    INFLIGHT.delete(o.clientId);
  }
}
async function sendOrderOnce(o) {
  // asked again first: an order taken back since this page last read it is not sent
  const now = ((await (await fetch("/api/account")).json()).orders || []).find((x) => x.id === o.id);
  if (!now || now.ref || !["pending"].includes(now.status)) throw new Error(`${o.id} is no longer waiting for your wallet (${now ? now.status : "gone"}): nothing was sent`);
  // the account already has a hash for it: that one is reported again, nothing new is sent
  if (now.reported) SENT.set(o.clientId, now.reported);
  const txs = now.walletTxs || [];
  if (!txs.length) return;
  const w = await walletFor(txs[0].from);
  const send = async (tx) => {
    try {
      await w.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: tx.chainIdHex }] });
    } catch (err) {
      throw new Error(`${w.info.name} did not switch to the right network: ${(err && err.message) || err}`);
    }
    return w.provider.request({ method: "eth_sendTransaction", params: [{ from: tx.from, to: tx.to, data: tx.data, value: tx.value, ...(tx.gas ? { gas: tx.gas } : {}) }] });
  };
  let swap = txs[txs.length - 1];
  if (txs.length > 1 && !SENT.get(o.clientId)) {
    // the approval first, on chain before the swap; then the swap built again from a fresh quote, so a slow approval leaves no stale swap
    for (const tx of txs.slice(0, -1)) await mined(w, await send(tx));
    const fresh = await postJson("/api/account/live/order-requote", { order: o.id });
    if (fresh.status === 200 && fresh.body.order && fresh.body.order.walletTxs) swap = fresh.body.order.walletTxs[fresh.body.order.walletTxs.length - 1];
    else if (fresh.status !== 200 && !(fresh.body.refusal && /cannot build the swap again/.test(fresh.body.refusal.message))) throw new Error(Owner.why(fresh) || "the swap could not be built again");
  }
  // a swap the wallet already sent is reported again, never sent twice: the chain may simply not show it yet
  const hash = SENT.get(o.clientId) || (await send(swap));
  SENT.set(o.clientId, hash);
  const r = await postJson("/api/account/live/order-sent", { order: o.id, hash });
  if (r.status !== 200) throw new Error(`${Owner.why(r) || "the account could not take the transaction"}. Your wallet sent ${short(hash)}: “Report again” reports that same transaction, it does not send another`);
  SENT.delete(o.clientId);
  said = `${w.info.name} sent it: ${short(hash)}`;
}

const UNITS = { spot: "", perp: "contracts", future: "contracts", stock: "shares", crypto: "", event: "contracts", token: "" };

/** place an order at an account: the market, buy or sell, how much, market or limit. The account asks the venue for the price and the
 * market's steps, shows what the order is worth, and your signature places it */
function openTrade(venueId, preset = {}) {
  const v = A.venues.find((x) => x.id === venueId);
  if (!v || !v.trade) return;
  const cap = A.connectLive.writes.capUsd;
  $("modal-form").innerHTML = `<h2>Trade · ${esc(v.name)}</h2><div class="dim small">${esc(v.trade.what[0].toUpperCase() + v.trade.what.slice(1))} · up to ${money(cap)} an order.</div>
    ${field("Market", '<input name="symbol" list="mk-list" autocomplete="off" spellcheck="false" placeholder="Search" required /><datalist id="mk-list"></datalist>')}
    <div class="row">${field("Side", '<div class="seg" id="tk-side"><button type="button" data-side="buy" aria-pressed="true">Buy</button><button type="button" data-side="sell" aria-pressed="false">Sell</button></div>')}${field("Type", select("orderType", [["market", "Market"], ["limit", "Limit"]]))}</div>
    <div class="row">${field("Amount", '<input name="amount" inputmode="decimal" placeholder="25" autocomplete="off" required />')}${field("In", select("unit", [["usd", "Dollars"], ["qty", "Units"]]))}</div>
    <div class="row"><div id="tk-stop" hidden>${field("Stop price", '<input name="stopPrice" inputmode="decimal" autocomplete="off" />')}</div><div id="tk-limit" hidden>${field("Limit price", '<input name="limitPrice" inputmode="decimal" autocomplete="off" />')}</div></div>
    <div class="row" id="tk-more" hidden><span id="tk-tif"></span><label class="chk1" id="tk-post" hidden><input type="checkbox" name="postOnly" /> Post-only</label><label class="chk1" id="tk-reduce" hidden><input type="checkbox" name="reduceOnly" /> Reduce-only</label></div>
    <div class="path" id="tk-lev" hidden></div>
    <div class="quote real" id="quote"><span class="dim">Pick a market to see its price.</span></div>
    <div class="path elsewhere" id="elsewhere"></div>
    <details id="signs" hidden><summary>What you sign</summary><pre id="signs-pre"></pre></details>
    <div class="msg" id="modal-msg"></div>
    <div class="end"><button type="button" id="modal-cancel">Cancel</button><button type="submit" class="ink" id="modal-go" disabled>Sign and place</button></div>`;
  const form = $("modal-form");
  // this ticket's own quote box: once another ticket replaces it, nothing late from this one is written or signed
  const mine = $("quote");
  const stale = () => !mine.isConnected;
  let side = "buy";
  let prepared = null;
  let timer = 0;
  let found = [];
  const say = (text, state) => { $("modal-msg").className = `msg${text && state ? ` ${state}` : ""}`; $("modal-msg").textContent = text || ""; };
  /* the markets matching what was typed, as the venue lists them */
  const suggest = async () => {
    const q = form.elements.symbol.value.trim();
    const r = await fetch(`/api/account/markets?${new URLSearchParams({ venue: v.id, q })}`).then((x) => x.json()).catch(() => ({}));
    if (stale() || !r.ok) return;
    found = r.markets || [];
    $("mk-list").innerHTML = found.map((m) => `<option value="${esc(m.symbol)}">${esc(m.name !== m.symbol ? m.name : m.kind)}${m.price ? ` · ${esc(px(m.price))}` : ""}</option>`).join("");
  };
  const LIMITED = ["limit", "stop_limit"];
  const STOPPED = ["stop", "stop_limit"];
  const draft = () => {
    const f = formOf("modal-form");
    const amount = String(f.amount || "").trim();
    return { type: "liveOrder", venue: v.id, symbol: String(f.symbol || "").trim(), side, orderType: f.orderType, ...(f.unit === "qty" ? { qty: amount } : { usd: amount }), limitPrice: LIMITED.includes(f.orderType) ? String(f.limitPrice || "").trim() : "", stopPrice: STOPPED.includes(f.orderType) ? String(f.stopPrice || "").trim() : "", tif: f.tif || "", postOnly: f.orderType === "limit" && f.postOnly ? "true" : "", reduceOnly: f.reduceOnly ? "true" : "" };
  };
  /* the market as the venue lists it: which order types, times in force and flags it takes — the ticket offers those and nothing else */
  let mk = null;
  const TYPE_NAMES = { market: "Market", limit: "Limit", stop: "Stop", stop_limit: "Stop limit" };
  const TIF_NAMES = { gtc: "Until canceled", ioc: "Fill now, rest canceled", fok: "All now or nothing", day: "Today only" };
  const shape = () => {
    const t = form.elements.orderType.value;
    $("tk-limit").hidden = !LIMITED.includes(t);
    $("tk-stop").hidden = !STOPPED.includes(t);
    $("tk-post").hidden = !(mk && mk.postOnly && t === "limit");
    // the times in force this order type takes here (a venue may take "Today only" for a stop and not for a limit)
    const sel = $("tk-tif").querySelector("select");
    if (mk && sel) {
      const allowed = (mk.tifsByType && mk.tifsByType[t]) || mk.tifs || [];
      const keep = sel.value;
      sel.innerHTML = [["", "The venue's default"], ...allowed.map((x) => [x, TIF_NAMES[x] || x])].map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join("");
      sel.value = allowed.includes(keep) ? keep : "";
    }
  };
  const fit = (m) => {
    mk = m;
    const keep = form.elements.orderType.value;
    form.elements.orderType.innerHTML = (m.types || ["market", "limit"]).map((t) => `<option value="${esc(t)}">${esc(TYPE_NAMES[t] || t)}</option>`).join("");
    if ((m.types || []).includes(keep)) form.elements.orderType.value = keep;
    $("tk-tif").innerHTML = m.tifs && m.tifs.length ? field("Time in force", select("tif", [["", "The venue's default"], ...m.tifs.map((t) => [t, TIF_NAMES[t] || t])])) : "";
    if ($("tk-tif").querySelector("select")) $("tk-tif").querySelector("select").addEventListener("change", () => later(0));
    $("tk-reduce").hidden = !m.reduceOnly;
    $("tk-more").hidden = !(m.tifs && m.tifs.length) && !m.postOnly && !m.reduceOnly;
    // a perpetual's leverage, where the venue lets it be set from here: the owner's signature
    $("tk-lev").hidden = !(v.trade.leverage && (m.kind === "perp" || m.kind === "future"));
    $("tk-lev").innerHTML = $("tk-lev").hidden ? "" : `Leverage <input name="leverage" class="xs" inputmode="numeric" placeholder="${m.maxLeverage ? `up to ${m.maxLeverage}` : "3"}" /> ${select("marginMode", [["", "Margin as it is"], ["cross", "Cross"], ["isolated", "Isolated"]])} <button type="button" class="link" id="lev-set">Set</button>`;
    if ($("lev-set")) $("lev-set").addEventListener("click", async () => {
      const f = formOf("modal-form");
      if (!/^\d{1,3}$/.test(String(f.leverage || "").trim())) return say("Leverage is a whole number, 1 or more.", "no");
      const r = await Owner.act({ type: "liveLeverage", venue: v.id, symbol: m.symbol, leverage: String(f.leverage).trim(), marginMode: f.marginMode || "" });
      say(r.status >= 400 ? Owner.why(r) : `${m.name}: ${r.body.result.leverage}x${r.body.result.marginMode ? `, ${r.body.result.marginMode}` : ""}`, r.status >= 400 ? "no" : "ok");
    });
    shape();
  };
  let mkFor = "";
  const loadMarket = async (symbol) => {
    if (!symbol || symbol === mkFor) return;
    mkFor = symbol;
    const r = await fetch(`/api/account/market?${new URLSearchParams({ venue: v.id, symbol })}`).then((x) => x.json()).catch(() => ({}));
    if (stale() || mkFor !== symbol) return;
    if (r.ok) fit(r.market);
  };
  let seq = 0;
  const quote = async () => {
    if (stale()) return;
    const my = ++seq;
    prepared = null;
    $("modal-go").disabled = true;
    $("signs").hidden = true;
    const d = draft();
    if (!d.symbol) return void ($("quote").innerHTML = '<span class="dim">Pick a market to see its price.</span>');
    loadMarket(d.symbol);
    if (!(Number(d.qty || d.usd) > 0) || (LIMITED.includes(d.orderType) && !(Number(d.limitPrice) > 0)) || (STOPPED.includes(d.orderType) && !(Number(d.stopPrice) > 0))) {
      // the market alone: its price, so the owner knows what to type
      const r = await fetch(`/api/account/market?${new URLSearchParams({ venue: v.id, symbol: d.symbol })}`).then((x) => x.json()).catch(() => ({}));
      if (stale() || my !== seq) return;
      if (!r.ok) return void ($("quote").innerHTML = `<div class="msg no">${esc((r.refusal && r.refusal.message) || "No such market here.")}</div>`);
      const m = r.market;
      if (m.kind !== "event") elsewhere(m.base);
      const unit = UNITS[m.kind] || m.base;
      form.elements.unit.options[1].textContent = unit ? unit[0].toUpperCase() + unit.slice(1) : m.base;
      if (m.price) form.elements.limitPrice.placeholder = String(Number(Number(m.price).toPrecision(10)));
      return void ($("quote").innerHTML = `<div class="big"><span>${esc(m.name)}</span><span>${m.price ? esc(px(m.price)) : "no price"} ${esc(m.quote)}</span></div>${m.bid || m.ask ? `<div class="path">Bid ${esc(px(m.bid))} · ask ${esc(px(m.ask))}</div>` : ""}${m.open ? "" : `<div class="path"><b>Closed now.</b> ${esc(m.note || "")}</div>`}${m.open && m.note ? `<div class="path">${esc(m.note)}</div>` : ""}<div class="path">Type an amount.</div>`);
    }
    $("quote").innerHTML = `<span class="dim">Asking ${esc(v.name)}…</span>`;
    const r = await Owner.prepare(d);
    if (stale() || my !== seq) return;
    if (r.status !== 200) return void ($("quote").innerHTML = `<div class="msg no">${esc(Owner.why(r))}</div>`);
    prepared = r.body;
    const a = prepared.action;
    const q = prepared.quote.order;
    if (q.kind !== "event") elsewhere(q.base);
    const unit = UNITS[q.kind] || q.base;
    const how = a.orderType === "stop" ? `when the price reaches ${esc(px(a.stopPrice))} ${esc(q.quote)}, at market` : a.orderType === "stop_limit" ? `when the price reaches ${esc(px(a.stopPrice))}, a limit at ${esc(px(a.limitPrice))} ${esc(q.quote)}` : `at ${esc(px(a.limitPrice || q.price))} ${esc(q.quote)}`;
    const flags = [a.tif ? TIF_NAMES[a.tif] : "", a.postOnly ? "post-only" : "", a.reduceOnly ? "reduce-only" : ""].filter(Boolean).join(" · ");
    $("quote").innerHTML = `<div class="big"><span>${a.side === "buy" ? "Buy" : "Sell"} ${esc(a.qty)} ${esc(unit === q.base ? q.base : `${unit} · ${q.base}`)}</span><span>≈ ${money(q.notionalUsd)}</span></div><div class="path">${esc(q.name)} ${how}${(a.orderType === "market" || a.orderType === "stop") && a.side === "buy" ? ` · up to ${money(q.maxUsd)} if the price moves` : ""}</div>${flags ? `<div class="path">${esc(flags)}</div>` : ""}${q.note ? `<div class="path">${esc(q.note)}</div>` : ""}<div class="path">Your signature is good for 10 minutes.</div>`;
    $("signs-pre").textContent = prepared.shown.map((x) => `${x.name}: ${x.value}`).join("\n");
    $("signs").hidden = false;
    $("modal-go").disabled = Owner.role !== "owner";
  };
  /* the same thing at the owner's other venues, by the price this order would take there: the best is one click away */
  let compared = "";
  const elsewhere = async (base) => {
    const d = draft();
    const key = `${base}|${d.side}|${d.usd || ""}`;
    if (!base || key === compared) return;
    compared = key;
    if (connected().filter(canTrade).length < 2) return void ($("elsewhere").innerHTML = "");
    const r = await fetch(`/api/account/compare?${new URLSearchParams({ base, side: d.side, ...(d.usd ? { usd: d.usd } : {}) })}`).then((x) => x.json()).catch(() => ({}));
    if (compared !== key || stale() || !r.ok) return;
    const rows = (r.rows || []).filter((x) => x.open);
    if (rows.length < 2) return void ($("elsewhere").innerHTML = "");
    const here = rows.find((x) => x.venue === v.id);
    const best = rows[0];
    $("elsewhere").innerHTML = `${here && best.venue === v.id ? "Best price of your accounts." : `${esc(best.venueName)} is ${here ? `${esc(String(Math.abs(here.worse ?? 0).toFixed(2)))}% better` : "where it is"}${d.side === "buy" ? " to buy" : " to sell"}: ${esc(px(best.price))} · <button type="button" class="link" data-there="${esc(best.venue)}" data-symbol="${esc(best.symbol)}">Trade there</button>`}<span class="dim"> · ${rows.filter((x) => x !== best).slice(0, 3).map((x) => `${esc(x.venueName)} ${esc(px(x.price))}${x.ready === false ? " (check)" : ""}`).join(" · ")}</span>`;
    const b = $("elsewhere").querySelector("button[data-there]");
    if (b) b.addEventListener("click", () => { const f = formOf("modal-form"); openTrade(b.dataset.there, { symbol: b.dataset.symbol, side, amount: f.amount, unit: f.unit, orderType: f.orderType }); });
  };
  const later = (ms = 350) => { clearTimeout(timer); timer = setTimeout(quote, ms); };
  let sugTimer = 0;
  form.elements.symbol.addEventListener("input", () => { clearTimeout(sugTimer); sugTimer = setTimeout(suggest, 250); later(600); });
  for (const el of [form.elements.amount, form.elements.limitPrice, form.elements.stopPrice]) el.addEventListener("input", () => later());
  for (const el of [form.elements.unit, form.elements.orderType, form.elements.postOnly, form.elements.reduceOnly]) el.addEventListener("change", () => { shape(); later(0); });
  for (const b of $("tk-side").querySelectorAll("button")) b.addEventListener("click", () => { side = b.dataset.side; for (const x of $("tk-side").querySelectorAll("button")) x.setAttribute("aria-pressed", String(x === b)); later(0); });
  $("modal-cancel").addEventListener("click", () => $("modal").close());
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (!prepared) return;
    $("modal-go").disabled = true;
    say(`Placing it at ${v.name}…`, "wait");
    const r = await Owner.submit(prepared);
    if (r.status >= 400 || (r.body && r.body.ok === false)) {
      say(Owner.why(r) || "Refused", "no");
      return void quote();
    }
    const o = r.body.kind === "order" ? r.body.order : null;
    if (o && o.walletTxs && !o.ref) {
      try {
        say("Waiting for your wallet…", "wait");
        await sendOrderFromWallet(o);
      } catch (err) {
        flash = `${String((err && err.message) || err).slice(0, 200)}. It waits under Orders: “Send from wallet…”`;
      }
    } else if (o) said = `${o.status === "filled" ? (o.side === "buy" ? "Bought" : "Sold") : o.status === "partial" ? "Part filled" : ["canceled", "rejected", "expired"].includes(o.status) ? "Not filled" : "Placed"}: ${o.id} · ${o.note}`;
    $("modal").close();
    await load();
  };
  suggest();
  // opened from another venue's "Trade there": the same order, here
  if (preset.symbol) {
    form.elements.symbol.value = preset.symbol;
    if (preset.side) { side = preset.side; for (const x of $("tk-side").querySelectorAll("button")) x.setAttribute("aria-pressed", String(x.dataset.side === side)); }
    if (preset.orderType) form.elements.orderType.value = preset.orderType;
    if (preset.unit) form.elements.unit.value = preset.unit;
    if (preset.amount) form.elements.amount.value = preset.amount;
    shape();
    later(0);
  }
  if (!$("modal").open) $("modal").showModal();
  form.elements.symbol.focus();
}

// ---- connecting an account --------------------------------------------------------------

let EXCHANGES = null;
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

/* every kind of account that can be connected, as tiles: the owner picks what it is, not how it is reached */
const TILES = [
  ["Exchanges", [["exchange", "okx", "OKX"], ["exchange", "kraken", "Kraken"], ["exchange", "coinbase", "Coinbase"], ["exchange", "bybit", "Bybit"], ["exchange", "binance", "Binance"], ["exchange", "", "Another exchange"]]],
  ["Brokers", [["robinhood", "", "Robinhood"], ["alpaca", "", "Alpaca"], ["robinhood-crypto", "", "Robinhood Crypto"]]],
  ["Wallets", [["wallet", "", "Browser wallet"], ["metamask", "", "MetaMask Agent Wallet"], ["wallet", "watch", "Watch an address"]]],
  ["Markets and tokens", [["kalshi", "", "Kalshi"], ["polymarket-trade", "", "Polymarket"], ["polymarket", "", "Polymarket · by address"], ["hyperliquid", "", "Hyperliquid"], ["ondo", "", "Ondo · OUSG"]]],
];
const HOW = { "key-file": "API key", "sign-in": "Sign in", address: "Address", cli: "mm on this machine" };
/* the page at each venue where an API key is made (the venues' own account pages) */
const API_PAGES = { okx: "https://www.okx.com/account/my-api", binance: "https://www.binance.com/en/my/settings/api-management", binanceus: "https://www.binance.us/settings/api-management", coinbase: "https://portal.cdp.coinbase.com/api-keys/secret", bybit: "https://www.bybit.com/app/user/api-management", kraken: "https://pro.kraken.com/app/settings/api", kucoin: "https://www.kucoin.com/account/api", bitget: "https://www.bitget.com/account/newapi", alpaca: "https://app.alpaca.markets/dashboard/overview", kalshi: "https://kalshi.com/account/profile", "robinhood-crypto": "https://robinhood.com/account/crypto" };
/* what to tick when making the key, in each venue's own words (read 2026-10-05): trading on, withdrawals off */
const KEY_HOW = {
  okx: "Tick Read and Trade (and Transfer, to move between Funding and Trading). Leave Withdraw off. Add this machine's IP: a trading key with no IP expires after 14 days unused. The passphrase you set goes in \"password\".",
  binance: "Tick Enable Reading and Enable Spot & Margin Trading; leave Enable Withdrawals off. Binance lets a System-generated key trade only when it is restricted to trusted IPs, so add this machine's IP, or make a Self-generated Ed25519 key and put its private key in \"secret\".",
  binanceus: "Edit restrictions: keep Enable Read, check Enable Spot Trading, leave withdrawals off. Restrict it to this machine's IP: a key with no IP list that goes unused for 90 days is reset to read-only.",
  coinbase: "Create a Secret API key with the ECDSA signature algorithm (not Ed25519). Permissions: View and Trade; leave Transfer off. \"apiKey\" is the key's name (organizations/…/apiKeys/…), \"secret\" its private key, line breaks included.",
  kraken: "Permissions: Query Funds, Query Open Orders & Trades, Query Closed Orders & Trades, Create & Modify Orders, Cancel/Close Orders. Leave Withdraw Funds off.",
  bybit: "System-generated, Read-Write. Tick Orders and Positions, and spot Trade. Leave Withdrawal off. A key with no IP stops working after 90 days.",
  kucoin: "API Trading. Permissions: General and Spot (add Margin or Futures if you trade them); leave Withdrawal off. Add this machine's IP: a trading key with no IP is disabled after 30 days unused. The passphrase goes in \"password\".",
  gate: "API v4 key. Spot: Read and Write; leave Withdrawal off. Bind this machine's IP: without one the key lasts 90 days.",
  bitget: "Read/write with the Trade permission; leave Withdraw and Transfer off. Bind this machine's IP. The passphrase goes in \"password\".",
  alpaca: "Generate a key in your Live account (or Paper, to try it first). Alpaca keys have no permissions to choose: any key can trade, and none can move cash.",
  kalshi: "Create New API Key (Ed25519). If scopes are offered, take read and write::trade and leave write::transfer off.",
  "robinhood-crypto": "Add key with your Ed25519 public key, and enable reading accounts, holdings, orders, products and quotes, and placing crypto orders.",
  "polymarket-trade": "Put in the private key of the wallet that signs for your Polymarket account. If the money sits in a Polymarket wallet, add \"funderAddress\" (the address in your profile menu) and \"signatureType\": 1 (Proxy), 2 (Safe) or 3 (Deposit Wallet); leave both empty for a plain wallet. Polymarket checks your location before anything else.",
};
const keyHow = (venue) => KEY_HOW[venue] || "Turn on reading and trading; leave withdrawals off. Bind this machine's IP if the exchange offers it.";
const optionOf = (kind) => ((A.connectLive || {}).options || []).find((o) => o.kind === kind);
/* an address-based connection numbers itself after the first of its kind */
const BY_ADDRESS = new Set(["wallet", "polymarket", "hyperliquid", "ondo"]);
const isOn = (kind, extra) => (kind === "wallet" ? false : A.venues.some((v) => v.id === (extra || kind) || (BY_ADDRESS.has(kind) && v.id.startsWith(`${kind}-`))));

/** the tiles, grouped; `wide` lays them out across the page instead of inside the dialog */
function catalog(owner, wide = "") {
  const tile = ([kind, extra, name]) => {
    const o = optionOf(kind);
    if (!o) return "";
    const how = kind === "wallet" ? (extra === "watch" ? "Address" : "Sign one sentence") : HOW[o.needs] || "";
    return `<button type="button" class="tile" data-kind="${esc(kind)}" data-extra="${esc(extra)}"${owner ? "" : " disabled"}><b>${esc(name)}</b><span>${isOn(kind, extra) ? '<em class="on">Connected</em> · add another' : esc(how)}</span></button>`;
  };
  return TILES.map(([title, tiles]) => { const t = tiles.map(tile).join(""); return t ? `<div class="pick-h">${esc(title)}</div><div class="pick ${wide}">${t}</div>` : ""; }).join("");
}

/* what each key file holds, until the server says exactly (an exchange's own list comes from the exchange library) */
const FIELDS = { exchange: ["apiKey", "secret"], alpaca: ["keyId", "secret"], kalshi: ["keyId", "privateKeyFile"], "robinhood-crypto": ["apiKey", "privateKey"], "polymarket-trade": ["privateKey", "funderAddress", "signatureType"] };
/* a shell word, quoted */
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
/* the one command that makes a key file: the folder, an empty template if there is no file yet (an existing one is never overwritten),
   owner-only permissions, and an editor to fill it in */
const keyCommand = (path, fields) => {
  const dir = path.replace(/\/[^/]*$/, "");
  const file = path.slice(dir.length + 1);
  const template = `{${fields.map((f) => `"${f}": ""`).join(", ")}}`;
  return `mkdir -p ${shq(dir)} && cd ${shq(dir)} && ( [ -e ${shq(file)} ] || printf '%s\\n' ${shq(template)} > ${shq(file)} ) && chmod 600 ${shq(file)} && nano ${shq(file)}`;
};
async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const t = document.createElement("textarea");
    t.value = text;
    document.body.appendChild(t);
    t.select();
    document.execCommand("copy");
    t.remove();
  }
  if (button) {
    const was = button.textContent;
    button.textContent = "Copied";
    setTimeout(() => (button.textContent = was), 1400);
  }
}

/** every way of connecting an account, as tiles, in the dialog */
function openPicker() {
  if (!A.connectLive) return;
  $("modal-form").innerHTML = `<h2>Connect an account</h2>
    ${catalog(Owner.role === "owner")}
    <div class="dim small">${writesOn() ? "Orders go through only when you sign them, or inside a limit you give an agent." : "Read-only: this server places no orders."}</div>
    <div class="end"><button type="button" id="modal-cancel">Cancel</button></div>`;
  $("modal-cancel").addEventListener("click", () => $("modal").close());
  for (const b of $("modal-form").querySelectorAll("button.tile")) b.addEventListener("click", () => openConnect(optionOf(b.dataset.kind), { exchange: b.dataset.kind === "exchange" ? b.dataset.extra : "", watch: b.dataset.extra === "watch", name: b.querySelector("b").textContent, back: true }));
  if (!$("modal").open) $("modal").showModal();
}

/** one way of connecting, as one short form */
async function openConnect(o, { exchange = "", watch = false, name = "", back = false } = {}) {
  if (!o) return;
  /* the venue's name, and what the dialog is called: watching an address connects nothing that could move */
  const title = o.kind === "exchange" && !exchange ? "an exchange" : name || o.label.split(" · ")[0];
  const heading = watch ? "Watch an address" : o.kind === "wallet" ? "Connect a browser wallet" : `Connect ${title}`;
  $("modal-form").innerHTML = `${back ? '<button type="button" class="link dim back" id="modal-back">← All accounts</button>' : ""}<h2>${esc(heading)}</h2>
    <div id="live-body"></div>
    <div class="msg" id="modal-msg"></div>
    <div class="end"><button type="button" id="modal-cancel">Cancel</button><button type="submit" class="ink" id="modal-go"${Owner.role === "owner" ? "" : " disabled"}>${watch ? "Watch it" : "Connect"}</button></div>`;
  const form = $("modal-form");
  let proven = null;
  /* "no" a refusal · "ok" done · "wait" the venue or the wallet is being asked */
  const say = (text, state) => { $("modal-msg").className = `msg${text && state ? ` ${state}` : ""}`; $("modal-msg").textContent = text || ""; };
  $("modal-cancel").addEventListener("click", () => $("modal").close());
  if (back) $("modal-back").addEventListener("click", () => openPicker());
  const exchangeId = () => (o.kind !== "exchange" ? "" : exchange || (form.elements.exchange ? form.elements.exchange.value : ""));
  const exchangeName = () => (EXCHANGES || []).find((x) => x.id === exchangeId())?.name || name || exchangeId();
  /* the venue this becomes on the account: the exchange's own id, or a second account when the owner names it so; the kind of connection;
     an address-based one numbered after the first */
  const venueId = () => {
    const label = (form.elements.label ? form.elements.label.value : "").trim();
    const ref = (form.elements.ref ? form.elements.ref.value : "").trim();
    if (o.kind === "exchange") return label && slug(label) !== slug(exchangeName()) ? slug(label) : exchangeId();
    if (o.needs === "address") return A.venues.some((v) => v.id === o.kind) ? `${o.kind}-${ref.slice(2, 8).toLowerCase()}` : o.kind;
    return o.kind;
  };

  if (o.needs === "key-file") {
    const pick = o.kind === "exchange" && !exchange;
    if (o.kind === "exchange" && !EXCHANGES) EXCHANGES = ((await (await fetch("/api/account/exchanges")).json()).exchanges) || [];
    const vname = o.kind === "exchange" ? exchangeName() : title;
    const page = API_PAGES[o.kind === "exchange" ? exchangeId() : o.kind];
    $("live-body").innerHTML = `${pick ? field("Exchange", select("exchange", EXCHANGES.map((x) => [x.id, x.name]))) : ""}
      <div class="steps">
        <div class="step"><i>1</i><div>Make an API key at <span id="kf-venue">${esc(vname)}</span> that can trade, with withdrawals off<span id="kf-pagewrap"${page ? "" : " hidden"}> · <a href="${esc(page || "#")}" target="_blank" rel="noopener" id="kf-page">open its API page</a></span>.<div class="dim small kf-how" id="kf-how">${esc(keyHow(o.kind === "exchange" ? exchangeId() : o.kind))}</div></div></div>
        <div class="step"><i>2</i><div>Save it here, readable only by you:<div class="pathbox"><code id="kf-path">…</code><button type="button" class="link" data-copy="path">Copy</button></div><div class="kf-cmd"><button type="button" class="sm" data-copy="cmd">Copy setup command</button><span class="dim small" id="kf-fields"></span></div></div></div>
        <div class="step"><i>3</i><div class="msg wait" id="kf-status">Looking for the file…</div></div>
      </div>
      <details class="opts"><summary>More options</summary><div class="row">${field("Shown as", '<input name="label" maxlength="40" autocomplete="off" />')}${field("Key file", '<input name="ref" maxlength="160" autocomplete="off" spellcheck="false" />')}</div></details>`;
    let path = "";
    let fields = [];
    const show = () => {
      $("kf-path").textContent = path;
      $("kf-fields").textContent = fields.length ? `Fields: ${fields.join(", ")}` : "";
    };
    const fill = () => {
      form.elements.label.value = vname && !pick ? vname : exchangeName();
      form.elements.ref.value = `credentials/${o.kind === "exchange" ? exchangeId() : o.kind}/api-key.json`;
      if (pick) {
        // the exchange picked in the list: its name, and its API page when this page knows it
        $("kf-venue").textContent = exchangeName();
        $("kf-how").textContent = keyHow(exchangeId());
        const p = API_PAGES[exchangeId()];
        $("kf-pagewrap").hidden = !p;
        if (p) $("kf-page").href = p;
      }
      // shown at once from what the page knows; the server's check below says it exactly
      path = `${A.connectLive.home.replace(/\/$/, "")}/${form.elements.ref.value}`;
      fields = o.kind === "exchange" ? ((EXCHANGES || []).find((x) => x.id === exchangeId())?.needs || FIELDS.exchange).filter((f) => ["apiKey", "secret", "password", "uid"].includes(f)) : FIELDS[o.kind] || [];
      show();
    };
    /* the server says whether the file is there, private and complete — names of fields only, never what is in them */
    const check = async () => {
      if (!$("modal").open || !$("kf-status")) return;
      const q = new URLSearchParams({ kind: o.kind, venue: venueId(), ref: form.elements.ref.value.trim(), exchange: exchangeId() });
      const resp = await fetch(`/api/account/keyfile?${q}`).catch(() => null);
      if (!$("kf-status")) return;
      // a server from before this check: the owner saves the file and connects, and the connection says what is wrong, if anything
      if (!resp || !resp.ok) return void (($("kf-status").className = "msg wait"), ($("kf-status").textContent = "Save the file, then Connect."));
      const r = await resp.json().catch(() => null);
      if (!r || !r.ok) return;
      path = r.path;
      fields = o.kind === "kalshi" ? [...r.fields, "privateKeyFile"] : r.fields;
      show();
      const st = $("kf-status");
      if (r.ready) return void ((st.className = "msg ok"), (st.textContent = "Ready."));
      if (r.mode) return void ((st.className = "msg no"), (st.innerHTML = `Others on this machine can read it. <button type="button" class="link" data-copy="chmod">Copy fix</button>`));
      if (r.missing) return void ((st.className = "msg no"), (st.textContent = `Missing: ${r.missing.join(", ")}.`));
      if (/there is no key file/.test(r.message)) return void ((st.className = "msg wait"), (st.textContent = "Waiting for the file…"));
      st.className = "msg no";
      st.textContent = r.message;
    };
    fill();
    if (pick) form.elements.exchange.addEventListener("change", () => { fill(); check(); });
    form.elements.ref.addEventListener("input", () => { path = `${A.connectLive.home.replace(/\/$/, "")}/${form.elements.ref.value.trim()}`; show(); check(); });
    form.addEventListener("click", (e) => {
      const b = e.target.closest("[data-copy]");
      if (!b) return;
      const what = b.dataset.copy;
      copyText(what === "path" ? path : what === "chmod" ? `chmod 600 ${shq(path)}` : keyCommand(path, fields), b);
    });
    check();
    const timer = setInterval(check, 2000);
    $("modal").addEventListener("close", () => clearInterval(timer), { once: true });
  } else if (o.needs === "address") {
    const wallets = o.kind === "wallet" && !watch ? await findWallets() : [];
    const walletTiles = wallets.length ? `<div class="wallets">${wallets.map((w, i) => `<button type="button" data-wallet="${i}">${/^data:image\//.test(w.info.icon || "") ? `<img src="${esc(w.info.icon)}" alt="" width="18" height="18" />` : ""}${esc(w.info.name)}</button>`).join("")}</div><div class="path dim small">Your wallet gives its address and signs one sentence. Nothing is approved or moved.</div><div class="or">or watch an address</div>` : o.kind === "wallet" && !watch ? '<div class="path dim small">No wallet in this browser. Open this page where your wallet is installed, or watch an address.</div>' : "";
    $("live-body").innerHTML = `${walletTiles}<div class="row">${field("Address", '<input name="ref" maxlength="80" autocomplete="off" spellcheck="false" placeholder="0x…" />')}${field("Shown as", '<input name="label" maxlength="40" autocomplete="off" />')}</div>${o.kind !== "wallet" ? `<div class="path dim small">${esc(o.example)}</div>` : ""}`;
    form.elements.label.value = name && !/watch|browser/i.test(name) ? name : "";
    form.elements.ref.addEventListener("input", () => { proven = null; });
    for (const b of $("live-body").querySelectorAll("button[data-wallet]")) {
      b.addEventListener("click", async () => {
        const w = wallets[Number(b.dataset.wallet)];
        say(`Waiting for ${w.info.name}…`, "wait");
        try {
          proven = await proveWallet(w);
          form.elements.ref.value = proven.address;
          if (!form.elements.label.value) form.elements.label.value = w.info.name;
          say(`${w.info.name} signed: ${short(proven.address)} is yours.`, "ok");
        } catch (err) {
          say(String((err && err.message) || err).slice(0, 200), "no");
        }
      });
    }
  } else if (o.needs === "sign-in") {
    const who = o.label.split(" · ")[0];
    $("live-body").innerHTML = `<div class="steps"><div class="step"><i>1</i><div>Sign in on ${esc(who)}’s own page and approve. <span class="dim">Reads every Robinhood account; trades only in your Agentic account, on your signature or inside a limit you give an agent.</span></div></div><div class="step"><i>2</i><div><button type="button" class="sm" id="signin-go">Sign in at ${esc(who)}…</button></div></div></div><input type="hidden" name="ref" value="" /><input type="hidden" name="label" value="${esc(who)}" />`;
    $("modal-go").disabled = true;
    $("signin-go").addEventListener("click", async () => {
      // the tab opens inside the click, so no popup blocker stops it; it goes to the venue once its address is known
      const tabWin = window.open("about:blank", "_blank");
      say(`Asking ${who} where to sign in…`, "wait");
      const r = await fetch("/api/account/signin/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ connector: o.kind }) }).then((x) => x.json()).catch(() => ({ ok: false }));
      if (!r.ok) {
        if (tabWin) tabWin.close();
        return say((r.refusal && r.refusal.message) || r.error || "the sign-in could not start", "no");
      }
      if (tabWin) {
        tabWin.opener = null;
        tabWin.location.href = r.url;
        say(`Sign in on ${who}’s page, then come back.`, "wait");
      } else {
        $("modal-msg").className = "msg wait";
        $("modal-msg").innerHTML = `<a href="${esc(r.url)}" target="_blank" rel="noopener">Open ${esc(who)}’s sign-in page</a>, then come back.`;
      }
      const until = Date.now() + 15 * 60_000;
      const poll = async () => {
        if (!$("modal").open) return;
        const st = await fetch(`/api/account/signin/status?state=${encodeURIComponent(r.state)}`).then((x) => x.json()).catch(() => ({}));
        if (st.status === "ready") {
          form.elements.ref.value = r.state;
          $("modal-go").disabled = Owner.role !== "owner";
          return say("Signed in. Connect it.", "ok");
        }
        if (st.status === "failed") return say(st.error || "the sign-in did not finish", "no");
        if (Date.now() > until) return say("The sign-in ran out: start again.", "no");
        setTimeout(poll, 1500);
      };
      poll();
    });
  } else {
    $("live-body").innerHTML = `<div class="path dim small">${esc(o.example)}</div><input type="hidden" name="ref" value="" /><input type="hidden" name="label" value="" />`;
  }

  form.onsubmit = async (e) => {
    e.preventDefault();
    const ref = (form.elements.ref.value || "").trim();
    const label = (form.elements.label.value || "").trim();
    if (o.needs === "address" && !/^0x[0-9a-fA-F]{40}$/.test(ref)) return say("An address is 0x and 40 hex digits.", "no");
    $("modal-go").disabled = true;
    say("Asking the venue…", "wait");
    const r = await Owner.act({ type: "connectVenue", venue: venueId(), connector: o.kind === "exchange" ? `live:exchange:${exchangeId()}` : `live:${o.kind}`, label, credentialRef: ref });
    $("modal-go").disabled = Owner.role !== "owner";
    if (r.status >= 400) return say(Owner.why(r) || "Refused", "no");
    $("modal").close();
    flash = "";
    said = r.body.summary || "";
    await load();
  };
  if (!$("modal").open) $("modal").showModal();
}

$("connect").addEventListener("click", () => openPicker());
for (const b of $("mode").querySelectorAll("button")) {
  b.addEventListener("click", async () => {
    if (b.dataset.mode === A.mode) return;
    // loosening is the owner's to sign; tightening needs no signature
    if (b.dataset.mode === "open") return void own({ type: "setPolicy", change: "mode", value: "open" });
    await fetch("/api/mode", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "guard" }) });
    said = "Conservative: every agent order waits for you.";
    await load();
  });
}

(async () => {
  await Owner.ready();
  await load();
  setInterval(() => { if (!busy && !$("modal").open && !document.activeElement.closest("form")) load(); }, 20000);
})();
