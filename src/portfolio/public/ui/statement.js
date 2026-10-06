/* The statement: what is still under way, and every transaction, one line each — trades, transfers, and money into or out of an earn
   product — in a wide sheet the clock in the top bar opens. */

// ---- statement -------------------------------------------------------------------------

const isLive = (o) => ["open", "partial", "pending"].includes(o.status);
const ST = { "not followed since a restart": ["Not followed since a restart", "failed"], filled: ["Filled", "settled"], settled: ["Done", "settled"], done: ["Done", "settled"], partial: ["Part filled", "pending"], open: ["Open", "pending"], pending: ["On the way", "pending"], "waiting for wallet": ["Waiting for your wallet", "pending"], canceled: ["Canceled", ""], expired: ["Expired", ""], rejected: ["Rejected", "failed"], failed: ["Failed", "failed"], returned: ["Returned", "failed"] };
/* the month a line falls in, in New York time, as its date is shown */
const monthOf = (iso) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(iso)).slice(0, 7);
const monthName = (m) => new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${m}-01T00:00:00Z`));
/* a statement's amount: a buy is money out, a sell money in; a transfer between your own places, and money into or out of an earn product
   (it stays yours), are shown as they are */
const amountOf = (l) => (l.type === "trade" ? (l.amountUsd ? `${l.amountUsd < 0 ? "−" : "+"}${fine(Math.abs(l.amountUsd))}` : "—") : fine(l.amountUsd));
/** the kinds the Statement filters by: trades and transfers, and earn when there are earn lines (or earn is what it shows now) */
function stmtKinds(lines, now = "") {
  const earn = now === "earn" || (lines || []).some((l) => l.type === "earn");
  return [["", earn ? "Trades, transfers and earn" : "Trades and transfers"], ["trade", "Trades"], ["transfer", "Transfers"], ...(earn ? [["earn", "Earn"]] : [])];
}
/** what the lines in view add up to: how many, bought, sold, moved, put into earn and taken out of it, and the fees where money moved. A
 * trade counts what filled; a transfer counts unless it failed or never left; money into or out of earn unless the venue refused it */
function stmtTotals(lines) {
  const sum = (f) => lines.filter(f).reduce((s, l) => s + Math.abs(l.amountUsd), 0);
  const moved = (l) => l.type === "transfer" && !["failed", "returned", "waiting for wallet", "not followed since a restart"].includes(l.status);
  const earned = (kind) => (l) => l.type === "earn" && l.kind === kind && l.status !== "rejected";
  const fees = lines.reduce((s, l) => s + (l.type === "transfer" && !moved(l) ? 0 : l.feeUsd || 0), 0);
  const [bought, sold, sent, into, out] = [sum((l) => l.type === "trade" && l.kind === "buy"), sum((l) => l.type === "trade" && l.kind === "sell"), sum(moved), sum(earned("supply")), sum(earned("withdraw"))];
  return [plural(lines.length, "transaction"), bought ? `bought ${money(bought)}` : "", sold ? `sold ${money(sold)}` : "", sent ? `moved ${money(sent)}` : "", into ? `into earn ${money(into)}` : "", out ? `out of earn ${money(out)}` : "", fees ? `fees ${fine(fees)}` : ""].filter(Boolean).join(" · ");
}
/** the lines as a CSV's rows, under its header: every kind, earn included, each amount as the account recorded it */
const stmtCsv = (lines) => [["date", "id", "type", "kind", "account", "to", "description", "amount_usd", "fee_usd", "status", "by", "agent", "ref"], ...lines.map((l) => [l.at, l.id, l.type, l.kind, l.accountName, l.toName || "", l.description, l.amountUsd, l.feeUsd ?? "", l.status, l.by, l.agent || "", l.ref || ""])];
/* who a line is by, for the agent filter: "you" for the owner's own, or the agent's key */
const lineBy = (l) => (l.agent ? String(l.agent).toLowerCase() : "you");

/** what is still under way: orders on a book, and anything waiting for your wallet — each with what you can do about it. Drawn into `el`
 * (the Statement's own place unless another is given) */
function renderOpen(owner, el = $("open-now")) {
  if (!el) return;
  const orders = (A.orders || []).filter(isLive);
  const wallet = A.payments.filter((p) => p.live && p.status === "authorized");
  if (!orders.length && !wallet.length) return void (el.innerHTML = "");
  const orderRow = (o) => {
    const waiting = o.walletTxs && !o.ref;
    const amendable = !waiting && !o.canceling && ((A.venues.find((x) => x.id === o.venue) || {}).trade || {}).amend;
    return `<tr><td>${o.side === "buy" ? "Buy" : "Sell"} ${esc(qtyOf(o.qty))} ${esc(o.contractSize ? "contracts" : o.base)} · ${esc(o.venueName)}<span class="why">${esc([`${nyDay(o.at)} ${nyTime(o.at)}`, byOf(o), typeText(o), o.note].join(" · "))}</span></td><td class="r num2">${fine(o.qty * o.price * (o.contractSize || 1))}</td><td>${owner ? `${waiting ? `<button type="button" class="link" data-order-send="${esc(o.id)}"${INFLIGHT.has(o.clientId) ? " disabled" : ""}>${o.reported ? "Report again" : "Send from wallet…"}</button> · ` : ""}${amendable ? `<button type="button" class="link" data-amend="${esc(o.id)}">Change…</button> · ` : ""}<button type="button" class="link dim" data-cancel="${esc(o.id)}" data-venue="${esc(o.venue)}">Cancel</button>` : `<span class="st pending">${o.canceling ? "Canceling" : "Open"}</span>`}</td></tr>`;
  };
  const payRow = (p) => `<tr><td>${esc(whatOf(p))}<span class="why">${esc(`${nyDay(p.at)} ${nyTime(p.at)} · ${byOf(p)}${p.live.sendBy && !p.live.reported ? ` · send by ${nyTime(p.live.sendBy)}` : ""}`)}</span></td><td class="r num2">${fine(p.amountUsd)}</td><td>${owner ? `<button type="button" class="link" data-wallet-send="${esc(p.id)}"${INFLIGHT.has(`${p.id}@${p.at}`) ? " disabled" : ""}>${p.live.reported ? "Report again" : "Send from wallet…"}</button>` : '<span class="st pending">Waiting for your wallet</span>'}</td></tr>`;
  el.innerHTML = `<div class="sub-h">Under way</div><table class="open-t"><tbody>${orders.map(orderRow).join("")}${wallet.map(payRow).join("")}</tbody></table>`;
  for (const b of el.querySelectorAll("button[data-cancel]")) b.addEventListener("click", () => own({ type: "liveCancel", venue: b.dataset.venue, order: b.dataset.cancel }));
  for (const b of el.querySelectorAll("button[data-amend]")) b.addEventListener("click", () => openAmend(A.orders.find((x) => x.id === b.dataset.amend)));
  const later = (fn) => async (b) => {
    b.disabled = true;
    try {
      await fn(b);
    } catch (err) {
      flash = String((err && err.message) || err).slice(0, 200);
    }
    await load();
  };
  for (const b of el.querySelectorAll("button[data-order-send]")) b.addEventListener("click", () => later(async () => sendOrderFromWallet(A.orders.find((x) => x.id === b.dataset.orderSend)))(b));
  for (const b of el.querySelectorAll("button[data-wallet-send]")) b.addEventListener("click", () => later(async () => {
    const p = A.payments.find((x) => x.id === b.dataset.walletSend);
    const n = p && p.legs[0].native;
    if (n && n.walletTx) await sendFromWallet(p, n.walletTx, n.walletTxs);
  })(b));
}

/** the Statement, in a wide sheet: under way, then every line, narrowed to the lens when the lens is one venue or one agent */
function openStatement() {
  const l = lensNow();
  if (l.kind === "venue") view.account = l.id;
  if (l.kind === "agent") view.agent = l.id.toLowerCase();
  openSheet('<div class="old"><div class="stmt-tools" id="statement-tools"></div><div class="print-head" id="print-head"></div><div id="open-now"></div><div><div class="filters" id="statement-filters"></div><div id="statement"></div></div></div>', { title: "Statement", wide: true, redraw: () => renderStatement(owns()) });
  allStatement = false;
  renderStatement(owns());
}

/** Every transaction, one line each, like a bank statement: what, where, how much, who, how it stands. Filtered by month, account, type and
 * who did it; downloaded as CSV; printed. Draws only while the Statement is open */
function renderStatement(owner) {
  if (!$("statement")) return;
  renderOpen(owner);
  const working = (A.orders || []).filter(isLive);
  const months = [...new Set(S.map((l) => monthOf(l.at)))].sort().reverse();
  if (view.month && view.month !== "all" && !months.includes(view.month)) view.month = "";
  const month = view.month || (months.includes(monthOf(A.now)) ? monthOf(A.now) : "all");
  // who did what: you, and each agent a line names (by its key; its name as the account knows it, or as the line recorded it)
  const agents = [...new Map(S.filter((l) => l.agent).map((l) => [lineBy(l), l.agentName || keyName(l.agent)])).entries()];
  if (view.agent && view.agent !== "you" && !agents.some(([a]) => a === view.agent)) view.agent = "";
  const lines = S.filter((l) => (month === "all" || monthOf(l.at) === month) && (!view.account || l.account === view.account || l.to === view.account) && (!view.type || l.type === view.type) && (!view.agent || lineBy(l) === view.agent));
  $("statement-tools").innerHTML = `${owner && working.length > 1 ? `<button type="button" class="btn btn-sm" id="cancel-all">Cancel all ${working.length} open</button>` : ""}${S.length ? `<button type="button" class="btn btn-sm" id="csv-statement">${icon("download", "sm")}Download CSV</button><button type="button" class="btn btn-sm" id="print-statement">${icon("print", "sm")}Print</button>` : ""}`;
  const accounts = [...new Map(S.flatMap((l) => [[l.account, l.accountName], ...(l.to ? [[l.to, l.toName || l.to]] : [])])).entries()];
  $("statement-filters").innerHTML = S.length ? `${select("month", [["all", "All time"], ...months.map((m) => [m, monthName(m)])], month)}${select("account", [["", "All accounts"], ...accounts], view.account)}${select("type", stmtKinds(S, view.type), view.type)}${agents.length ? select("agent", [["", "You and every agent"], ["you", "You"], ...agents], view.agent) : ""}` : "";
  for (const el of $("statement-filters").querySelectorAll("select")) {
    el.setAttribute("aria-label", { month: "Month", account: "Account", type: "Kind", agent: "Who" }[el.name]);
    el.addEventListener("change", () => { view[el.name] = el.value; allStatement = false; renderStatement(owner); });
  }
  if (!S.length) return void ($("statement").innerHTML = `<p class="empty">${connected().length ? "No transactions yet. Trade or move money from an account, or let an agent trade inside a limit." : "Connect an account to start."}</p>`);
  const total = stmtTotals(lines);
  const shown = allStatement ? lines : lines.slice(0, 25);
  const who = view.agent ? (view.agent === "you" ? "you" : (agents.find(([a]) => a === view.agent) || [])[1] || short(view.agent)) : "";
  $("print-head").innerHTML = `<b>Account statement</b> · ${esc(month === "all" ? "all time" : monthName(month))}${view.account ? ` · ${esc(nameOf(view.account))}` : ""}${who ? ` · by ${esc(who)}` : ""} · printed ${esc(nyDay(A.now))} ${esc(nyTime(A.now))} New York`;
  $("statement").innerHTML = lines.length
    ? `<table class="stmt"><thead><tr><th>Date</th><th>Description</th><th>Account</th><th class="r">Amount</th><th>Status</th></tr></thead><tbody>${shown.map((l) => {
      const [label, cls] = ST[l.status] || [l.status, ""];
      const sub = [l.by, l.type === "trade" && !l.amountUsd && l.worthUsd ? `worth ${fine(l.worthUsd)}` : "", l.feeUsd ? `fee ${fine(l.feeUsd)}` : "", l.ref ? `ref ${short(l.ref)}` : "", l.id].filter(Boolean).join(" · ");
      return `<tr><td class="num2 dim">${esc(nyDay(l.at))}<span class="why">${esc(nyTime(l.at))}</span></td><td>${esc(l.description)}<span class="why">${esc(sub)}</span></td><td>${esc(l.accountName)}${l.toName ? ` → ${esc(l.toName)}` : ""}</td><td class="r num2">${esc(amountOf(l))}</td><td><span class="st ${cls}">${esc(label)}</span></td></tr>`;
    }).join("")}</tbody></table><div class="totals dim small">${esc(total)}</div>${lines.length > shown.length ? `<button type="button" class="link dim more-btn" id="all-statement">Show all ${lines.length}</button>` : ""}`
    : '<p class="empty">Nothing in this view.</p>';
  if ($("all-statement")) $("all-statement").addEventListener("click", () => { allStatement = true; renderStatement(owner); });
  if ($("cancel-all")) $("cancel-all").addEventListener("click", async () => {
    if (!(await confirmSheet(`Cancel all ${working.length} open orders? Each comes off its venue's book, one signature each.`, { title: "Cancel every open order", yes: `Cancel ${working.length} orders`, no: "Keep them", danger: true }))) return;
    // every open order off the book, one signature each
    for (const o of working) await own({ type: "liveCancel", venue: o.venue, order: o.id });
  });
  if ($("csv-statement")) $("csv-statement").addEventListener("click", () => download(`statement-${month === "all" ? "all" : month}${view.type ? `-${view.type}` : ""}.csv`, stmtCsv(lines)));
  if ($("print-statement")) $("print-statement").addEventListener("click", () => {
    allStatement = true;
    renderStatement(owner);
    document.body.dataset.print = "statement";
    window.print();
    delete document.body.dataset.print;
  });
}

const whatOf = (p) => (p.kind === "swap" ? `Swap at ${nameOf(p.from)} · ${p.sourceToken} → ${p.token}` : p.kind === "transfer" && p.from === p.to ? `Transfer at ${nameOf(p.from)} · ${p.legs[0].fromLedger} → ${p.legs[0].toLedger}` : `${p.kind[0].toUpperCase() + p.kind.slice(1)} · ${nameOf(p.from)} → ${nameOf(p.to)}${p.live && p.live.network ? ` · ${p.live.network}` : ""}`);
/* who did it: you, or an agent — on your yes (Conservative), or inside its limit (Aggressive) */
const byOf = (p) => (p.authority !== "agent" ? "You" : `${keyName(p.agent)}, ${p.card ? "approved by you" : "inside its limit"}`);
