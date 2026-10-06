/* The shell, loaded last: the rail, the top bar and the three panes, drawn from what /api/account said, and the page started — the route
   from the hash, pairing, the first load, and a fresh read every 20 seconds while nothing is being signed, no sheet is open, nothing outside
   the search is being typed, and the page is in view. */

/** the whole page from A: the chrome, the visible pane, whatever sheet or drawer is open, then what was done or refused as a toast */
function render() {
  if (!A) return;
  const L = connected();
  const owner = owns();
  $("main").removeAttribute("aria-busy");
  renderChrome(L, owner);
  drawPane(L, owner);
  for (const open of [SHEET, DRAWER]) {
    if (!open || !open.redraw) continue;
    try {
      open.redraw();
    } catch (err) {
      console.error(err);
    }
  }
  speak();
}

/* the rail and the top bar: the tab's title with what waits, the clock, trading on or off, the mode, the counts, the lens, pairing, a restart */
function renderChrome(L, owner) {
  // what waits for the owner: the cards to approve, and what the agents asked for (both answered under Portfolio's Waiting for you)
  const waiting = A.cards.length + (A.asks || []).length;
  document.title = `${waiting ? `(${waiting}) ` : ""}Account`;
  $("stamp").textContent = `${ny(A.now, { weekday: "short", day: "numeric", month: "short" }).replace(",", "")} · ${nyTime(A.now)} New York`;
  $("writes").innerHTML = writesOn() ? `<span class="pill warm" title="Orders and moves go through only when you sign them, or inside a limit you gave an agent">Trading on · up to ${money(A.connectLive.writes.capUsd)} an order</span>` : '<span class="pill" title="Started with --read-only">Read-only</span>';
  for (const b of document.querySelectorAll("button[data-set-mode]")) {
    b.setAttribute("aria-pressed", String(b.dataset.setMode === A.mode));
    b.disabled = !owner;
  }
  $("mode-note").textContent = modeNote();
  count("count-portfolio", waiting, `${plural(waiting, "thing")} waiting for you`);
  // agents knocking to be let in, which the Agents sheet answers
  count("count-agents", A.requests.length, `${plural(A.requests.length, "agent")} asking to be let in`);
  // a lens on a venue disconnected, or an agent revoked, is let go
  const l = lensNow();
  if ((l.kind === "venue" && !L.some((v) => v.id === l.id)) || (l.kind === "agent" && !A.keys.some((k) => k.address.toLowerCase() === l.id.toLowerCase()))) view.lens = "";
  $("lens-name").textContent = lensNow().name;
  $("lens").setAttribute("aria-label", `Showing ${lensNow().name}: choose what the page shows`);
  drawBanner(owner);
  drawRestoreNotice();
}
const count = (id, n, label) => {
  const el = $(id);
  el.hidden = !n;
  el.textContent = n ? String(n) : "";
  el.title = n ? label : "";
};

/* pairing: on a server that moves real money the first browser pairs with the code the terminal printed; a code half typed is not wiped
   by a refresh (the banner is drawn again only when this browser's role changes) */
function drawBanner(owner) {
  const b = $("banner");
  if (b.dataset.role === Owner.role) return;
  b.dataset.role = Owner.role;
  b.hidden = owner;
  if (Owner.role === "needs-code") {
    b.innerHTML = '<form id="code-form" class="codeform"><label for="code-in">Enter the pairing code shown in the terminal.</label><input id="code-in" name="code" placeholder="XXXX-XXXX" maxlength="9" autocomplete="off" spellcheck="false" required /><button type="submit" class="btn btn-primary">Pair</button><span class="msg" id="code-msg" role="status"></span></form>';
    $("code-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const r = await Owner.ready($("code-form").elements.code.value);
      if (r.refusal) return void (($("code-msg").className = "msg no"), ($("code-msg").textContent = r.refusal));
      await load();
    });
  } else b.textContent = Owner.role === "pending" ? "This browser can look but not sign. Add it under Devices from your other browser." : owner ? "" : "This browser can't make a signing key, so it can only look.";
}

/* a restart: what the account brought back from its ledgers, and what it could not */
function drawRestoreNotice() {
  const r = A.restore;
  const el = $("restored");
  if (!r) return void (el.hidden = true);
  const back = r.venues.filter((v) => v.ok);
  const missed = r.venues.filter((v) => !v.ok && v.why !== "connecting again");
  el.hidden = false;
  el.innerHTML = `${r.state === "restoring" ? "Restoring after a restart…" : `Continued after a restart: ${back.length} of ${plural(r.venues.length, "account")} connected again`}${r.orders + r.payments ? ` · ${plural(r.orders + r.payments, "transaction")} followed again` : ""}${missed.length || r.skipped.length ? `<details class="inl"><summary>details</summary>${[...missed.map((v) => `${nameOf(v.venue) || v.venue}: ${v.why}`), ...r.skipped].map((x) => `<div>${esc(x)}</div>`).join("")}</details>` : ""}`;
}

/* what was done, or refused, said once: as a toast, and in the open sheet when it came from there */
function speak() {
  if (flash || said) {
    const m = SHEET && $("sheet").querySelector("[data-sheet-msg]");
    if (m) {
      m.className = `msg sheet-msg ${flash ? "no" : "ok"}`;
      m.innerHTML = flash ? esc(flash) : sayHtml(said);
    }
    if (flash) toast(flash, "no");
    else toast({ html: sayHtml(said) }, "ok");
  }
  flash = "";
  said = "";
}

// ---- the panes -------------------------------------------------------------------------------

/** the visible pane, by its own renderer (renderPortfolio in portfolio.js, renderMarkets in markets.js, renderTrade in trade.js); a pane that
 * fails to draw, or whose script did not load, says so where it would have been */
function drawPane(L, owner) {
  const tab = ROUTE.tab;
  const el = $(`pane-${tab}`);
  const draw = { portfolio: typeof renderPortfolio === "function" ? renderPortfolio : null, markets: typeof renderMarkets === "function" ? renderMarkets : null, trade: typeof renderTrade === "function" ? renderTrade : null }[tab];
  try {
    if (!draw) throw new Error(`its script did not load. Reload the page`);
    draw({ el, owner, lens: lensNow(), params: ROUTE.params });
  } catch (err) {
    console.error(err);
    el.innerHTML = `<p class="pane-error" role="alert">This part of the page could not be drawn: ${esc((err && err.message) || err)}</p>`;
  }
}

/* the route: the pane it names is shown, the rail marks it, the search shows what Markets is searching for */
onRoute((tab, params, moved) => {
  for (const s of document.querySelectorAll("section[data-pane]")) s.hidden = s.dataset.pane !== tab;
  for (const a of document.querySelectorAll(".rail-nav a[data-tab]")) {
    if (a.dataset.tab === tab) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  if (document.activeElement !== $("search")) $("search").value = tab === "markets" ? params.q || "" : "";
  if (moved) window.scrollTo(0, 0);
  if (A) drawPane(connected(), owns());
});
window.addEventListener("hashchange", routed);

// ---- the top bar ------------------------------------------------------------------------------

/* the lens: All accounts, one connected venue, or one agent — what the panes are narrowed to */
function lensMenu(open) {
  const m = $("lens-menu");
  $("lens").setAttribute("aria-expanded", String(!!open && !!A));
  if (!open || !A) return void (m.hidden = true);
  const keys = A.keys.filter((k) => k.status === "ok" || k.status === "expired");
  const item = (v, label, hint) => `<button type="button" role="menuitemradio" aria-checked="${String(view.lens === v)}" data-lens="${esc(v)}"><span>${esc(label)}</span>${hint ? `<span class="dim">${esc(hint)}</span>` : ""}</button>`;
  const L = connected();
  m.innerHTML = `${item("", "All accounts", money(A.liveUsd))}${L.length ? `<div class="menu-h" role="presentation">Accounts</div>${L.map((v) => item(`venue:${v.id}`, v.name, money(v.usd))).join("")}` : ""}${keys.length ? `<div class="menu-h" role="presentation">Agents</div>${keys.map((k) => item(`agent:${k.address}`, k.name, k.status === "expired" ? "expired" : short(k.address))).join("")}` : ""}`;
  m.hidden = false;
  (m.querySelector('[aria-checked="true"]') || m.querySelector("button")).focus();
}
$("lens").addEventListener("click", () => lensMenu($("lens-menu").hidden));
$("lens-menu").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-lens]");
  if (!b) return;
  view.lens = b.dataset.lens;
  lensMenu(false);
  $("lens").focus();
  render();
});
$("lens-menu").addEventListener("keydown", (e) => {
  const items = [...$("lens-menu").querySelectorAll("button")];
  const i = items.indexOf(document.activeElement);
  const to = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: items.length - 1 }[e.key];
  if (to !== undefined) {
    e.preventDefault();
    items[(to + items.length) % items.length].focus();
  } else if (e.key === "Escape" || e.key === "Tab") {
    if (e.key === "Escape") e.preventDefault();
    lensMenu(false);
    if (e.key === "Escape") $("lens").focus();
  }
});

/* the search lives in the page itself (data-live), so a refresh neither freezes nor wipes it: what is typed goes to Markets */
let searchTimer = 0;
const searchFor = (q, now) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => go("markets", { ...(ROUTE.tab === "markets" ? ROUTE.params : {}), q: q.trim() }, { replace: ROUTE.tab === "markets" }), now ? 0 : 250);
};
$("search").addEventListener("input", () => searchFor($("search").value));
$("search").addEventListener("blur", () => {
  if (ROUTE.tab !== "markets") $("search").value = "";
});
$("search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  searchFor($("search").value, true);
});

/* the command that connects an agent's MCP seat to this account, as the account gives it (A.agentSetup { command, url }: the path to its MCP
   server written out, so it runs anywhere); on an account that does not give it, the command run from this account's folder */
const agentSetup = () => (A && A.agentSetup && A.agentSetup.command) || `claude mcp add portfolio -e PORTFOLIO_URL=${location.origin} -- npx tsx src/portfolio/mcp.ts`;
async function copySetup() {
  const cmd = agentSetup();
  const given = !!(A && A.agentSetup && A.agentSetup.command);
  await copyText(cmd);
  toast({ html: `Copied: <span class="mono">${esc(cmd)}</span>. Run it ${given ? "where your agent runs" : "in this account's folder"}, then let the agent in under Agents.` }, "info", { ms: 9000 });
}
/* what every account holds, as a CSV file */
function downloadBalances() {
  download(`balances-${A.now.slice(0, 10)}.csv`, [["account", "asset", "amount", "usd", "where", "as_of"], ...connected().flatMap((v) => (v.holdings || []).map((h) => [v.name, h.asset, h.amount, h.usd, h.note || "", v.asOf || A.now]))]);
}
/* the menu, in the drawer: everything the rail's foot holds, for a window too narrow to show it, and the rest */
function openMenu() {
  if (!A) return;
  const item = (act, ic, label) => `<button type="button" data-menu="${act}">${icon(ic)}${esc(label)}</button>`;
  const body = openDrawer(`<nav class="menu-list" aria-label="Menu">${A.connectLive ? item("connect", "plug", "Connect an account") : ""}${item("agents", "agent", "Agents")}${item("settings", "sliders", "Settings")}${item("statement", "clock", "Statement")}${item("setup", "copy", "Copy agent setup command")}${connected().length ? item("csv", "download", "Download balances (CSV)") : ""}</nav><div class="group"><div class="label">Background</div>${seg([["cream", "Cream"], ["black", "Black"]], document.documentElement.dataset.theme || "cream", setTheme, { label: "Background" })}</div><div class="group"><div class="label">Mode</div>${seg([["guard", "Conservative"], ["open", "Aggressive"]], A.mode, setMode, { label: "Mode" })}<span class="note-s">${esc(modeNote())}</span></div>`, { title: "Menu" });
  if (!owns()) for (const b of body.querySelectorAll('[data-v="guard"], [data-v="open"]')) b.disabled = true;
  const acts = { connect: openPicker, agents: openAgents, settings: openSettings, statement: openStatement, setup: copySetup, csv: downloadBalances };
  body.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-menu]");
    if (!b) return;
    closeDrawer();
    acts[b.dataset.menu]();
  });
}
$("open-statement").addEventListener("click", () => A && openStatement());
$("copy-setup").addEventListener("click", copySetup);
$("open-menu").addEventListener("click", openMenu);

// ---- the rail ---------------------------------------------------------------------------------

/* the background, kept in this browser (account.html reads it before the first paint) */
function setTheme(t) {
  const v = t === "black" ? "black" : "cream";
  document.documentElement.dataset.theme = v;
  try {
    localStorage.setItem("account.theme", v);
  } catch {
    // a private window: the choice holds for this visit only
  }
  for (const b of document.querySelectorAll("button[data-set-theme]")) b.setAttribute("aria-pressed", String(b.dataset.setTheme === v));
}
setTheme(document.documentElement.dataset.theme);
$("rail-trade").addEventListener("click", () => go("trade"));
$("open-agents").addEventListener("click", () => A && openAgents());
$("open-settings").addEventListener("click", () => A && openSettings());

/* one click handler for what is drawn over and over: a toggle (seg), the background, the mode, a sheet's or the drawer's close button, and a
   click outside the lens's menu */
document.addEventListener("click", (e) => {
  const t = e.target;
  if (!t || !t.closest) return;
  if (!$("lens-menu").hidden && !t.closest("#lens-menu") && !t.closest("#lens")) lensMenu(false);
  const sb = t.closest("[data-seg] button");
  if (sb) {
    if (sb.disabled || sb.getAttribute("aria-pressed") === "true") return;
    const g = sb.closest("[data-seg]");
    for (const x of g.querySelectorAll("button")) x.setAttribute("aria-pressed", String(x === sb));
    const fn = SEGS.get(g.dataset.seg);
    if (fn) fn(sb.dataset.v);
    return;
  }
  const th = t.closest("button[data-set-theme]");
  if (th) return void setTheme(th.dataset.setTheme);
  const md = t.closest("button[data-set-mode]");
  if (md && !md.disabled) return void setMode(md.dataset.setMode);
  if (t.closest("[data-sheet-close]")) return void closeSheet();
  if (t.closest("[data-drawer-close]")) closeDrawer();
});

// ---- the sheet, the drawer, the keys --------------------------------------------------------------

$("modal").addEventListener("close", () => {
  SHEET = null;
  $("sheet").replaceChildren();
  $("modal").classList.remove("wide");
  $("modal").removeAttribute("aria-labelledby");
});
/* an earlier dialog (connect, move, trade, change an order) draws straight into #modal-form: it replaces whatever sheet was open */
new MutationObserver(() => {
  if (!$("modal-form").childElementCount || !SHEET) return;
  SHEET = null;
  $("sheet").replaceChildren();
  $("modal").classList.remove("wide");
  $("modal").removeAttribute("aria-labelledby");
}).observe($("modal-form"), { childList: true });
$("drawer").addEventListener("close", () => {
  const back = DRAWER && DRAWER.back;
  DRAWER = null;
  $("drawer").replaceChildren();
  if (back && back.isConnected && back.focus) back.focus();
});

/* "/" searches, "t" opens the ticket, Escape closes the lens's menu or the drawer (a sheet closes on Escape by itself) */
document.addEventListener("keydown", (e) => {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
  const modal = $("modal").open || $("ask").open;
  if (e.key === "Escape") {
    if (!$("lens-menu").hidden) return void lensMenu(false);
    if ($("drawer").open && !modal) closeDrawer();
    return;
  }
  const typing = e.target && e.target.closest && e.target.closest("input, textarea, select, [contenteditable]");
  if (typing || modal) return;
  if (e.key === "/") {
    e.preventDefault();
    $("search").focus();
    $("search").select();
  } else if (e.key === "t" && A) {
    e.preventDefault();
    if (typeof openTicket === "function") openTicket({});
    else go("trade");
  }
});

// ---- reading again, and the start ---------------------------------------------------------------

const REFRESH_MS = 20_000;
/* a fresh read may come now: nothing is being signed, no sheet or question is open, the page is in view, and nothing is being typed
   but the search */
function quiet() {
  if (busy || document.hidden || $("modal").open || $("ask").open) return false;
  const f = document.activeElement;
  return !(f && f.closest && f.closest("form, [contenteditable]") && !f.closest("[data-live]"));
}
/* the account went away (a restart): said once, and asked again on the next turn */
let unreachable = false;
async function refresh() {
  try {
    await load();
    if (unreachable) toast("The account answers again.", "ok");
    unreachable = false;
  } catch {
    if (!unreachable) toast(`The account did not answer. Trying again every ${REFRESH_MS / 1000} seconds.`, "no");
    unreachable = true;
  }
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && A && Date.now() - loadedAt > REFRESH_MS && quiet()) refresh();
});

routed();
(async () => {
  await Owner.ready();
  await refresh();
  setInterval(() => {
    if (A && quiet()) refresh();
  }, REFRESH_MS);
})();
