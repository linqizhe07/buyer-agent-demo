/* The statement: every transaction, one line each — trades, transfers, and money into or out of an earn product — in a wide sheet the clock
   in the top bar opens; filtered, added up, downloaded as CSV, printed. Orders still open are the Trade pane's working list, not here. */

// ---- statement -------------------------------------------------------------------------

const ST = { "not followed since a restart": ["Not followed since a restart", "failed"], filled: ["Filled", "settled"], settled: ["Done", "settled"], done: ["Done", "settled"], partial: ["Part filled", "pending"], open: ["Open", "pending"], pending: ["On the way", "pending"], "waiting for wallet": ["Waiting for your wallet", "pending"], canceled: ["Canceled", ""], expired: ["Expired", ""], rejected: ["Rejected", "failed"], failed: ["Failed", "failed"], returned: ["Returned", "failed"] };
/* the month a line falls in, in New York time, as its date is shown; a line whose time is not one has no month (it shows under All time) */
const monthOf = (iso) => {
  const ms = Date.parse(String(iso ?? ""));
  return Number.isFinite(ms) ? new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(ms)).slice(0, 7) : "";
};
const monthName = (m) => (/^\d{4}-\d{2}$/.test(String(m)) ? new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${m}-01T00:00:00Z`)) : String(m));
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

/** the Statement, in a wide sheet: every line, narrowed to the lens when the lens is one venue or one agent */
function openStatement() {
  const l = lensNow();
  if (l.kind === "venue") view.account = l.id;
  if (l.kind === "agent") view.agent = l.id.toLowerCase();
  openSheet('<div class="old"><div class="stmt-tools" id="statement-tools"></div><div class="print-head" id="print-head"></div><div><div class="filters" id="statement-filters"></div><div id="statement"></div></div></div>', { title: "Statement", wide: true, redraw: () => renderStatement(owns()) });
  allStatement = false;
  renderStatement(owns());
}

/** Every transaction, one line each, like a bank statement: what, where, how much, who, how it stands. Filtered by month, account, type and
 * who did it; downloaded as CSV; printed. Draws only while the Statement is open */
function renderStatement(owner) {
  if (!$("statement")) return;
  const months = [...new Set(S.map((l) => monthOf(l.at)).filter(Boolean))].sort().reverse();
  if (view.month && view.month !== "all" && !months.includes(view.month)) view.month = "";
  const month = view.month || (months.includes(monthOf(A.now)) ? monthOf(A.now) : "all");
  // who did what: you, and each agent a line names (by its key; its name as the account knows it, or as the line recorded it)
  const agents = [...new Map(S.filter((l) => l.agent).map((l) => [lineBy(l), l.agentName || keyName(l.agent)])).entries()];
  if (view.agent && view.agent !== "you" && !agents.some(([a]) => a === view.agent)) view.agent = "";
  const lines = S.filter((l) => (month === "all" || monthOf(l.at) === month) && (!view.account || l.account === view.account || l.to === view.account) && (!view.type || l.type === view.type) && (!view.agent || lineBy(l) === view.agent));
  $("statement-tools").innerHTML = S.length ? `<button type="button" class="btn btn-sm" id="csv-statement">${icon("download", "sm")}Download CSV</button><button type="button" class="btn btn-sm" id="print-statement">${icon("print", "sm")}Print</button>` : "";
  const accounts = [...new Map(S.flatMap((l) => [[l.account, l.accountName], ...(l.to ? [[l.to, l.toName || l.to]] : [])])).entries()];
  /* the filters: each select's options and value, by its name. The selects are made once and then kept — their options and values follow
     the lines (setOptions) — so one that is open under the pointer is never rebuilt by a read of the account */
  const filters = $("statement-filters");
  const lists = S.length ? { month: [[["all", "All time"], ...months.map((m) => [m, monthName(m)])], month], account: [[["", "All accounts"], ...accounts], view.account], type: [stmtKinds(S, view.type), view.type], ...(agents.length ? { agent: [[["", "You and every agent"], ["you", "You"], ...agents], view.agent] } : {}) } : {};
  if ([...filters.querySelectorAll("select")].map((s) => s.name).join() !== Object.keys(lists).join()) {
    filters.innerHTML = Object.entries(lists).map(([name, [opts, val]]) => select(name, opts, val)).join("");
    for (const el of filters.querySelectorAll("select")) {
      el.setAttribute("aria-label", { month: "Month", account: "Account", type: "Kind", agent: "Who" }[el.name]);
      el.addEventListener("change", () => { view[el.name] = el.value; allStatement = false; renderStatement(owner); });
    }
  } else for (const [name, [opts, val]] of Object.entries(lists)) setOptions(filters.querySelector(`select[name="${name}"]`), opts, val);
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
  if ($("csv-statement")) $("csv-statement").addEventListener("click", () => download(`statement-${month === "all" ? "all" : month}${view.type ? `-${view.type}` : ""}.csv`, stmtCsv(lines)));
  if ($("print-statement")) $("print-statement").addEventListener("click", () => {
    allStatement = true;
    renderStatement(owner);
    document.body.dataset.print = "statement";
    window.print();
    delete document.body.dataset.print;
  });
}

/* a payment in a few words (the Trade pane's working list reads it for money on its way) */
const whatOf = (p) => (p.kind === "swap" ? `Swap at ${nameOf(p.from)} · ${p.sourceToken} → ${p.token}` : p.kind === "transfer" && p.from === p.to ? `Transfer at ${nameOf(p.from)} · ${p.legs[0].fromLedger} → ${p.legs[0].toLedger}` : `${p.kind[0].toUpperCase() + p.kind.slice(1)} · ${nameOf(p.from)} → ${nameOf(p.to)}${p.live && p.live.network ? ` · ${p.live.network}` : ""}`);
