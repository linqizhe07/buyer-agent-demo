/* The account page: the user's real accounts on one page, each read through the venue's own interface. It renders /api/account and
   signs what the owner asks for; it decides nothing the account did not. */
/* THE CONTRACT. The page is plain scripts sharing one global scope, run in this order after owner.js (the device key: Owner.prepare ·
   Owner.submit · Owner.act · Owner.why · Owner.role):
     core (this file) · connect · money · asset · intent · portfolio · markets · trade · statement · agents-mount · shell (draws and starts it).
   Each top-level name is declared once across them all (test/unit/page-scripts.test.ts). Declare what the shell calls as top-level
   `function` declarations.

   What the page holds
     A            what GET /api/account said last (null until the first load)        S     the statement's lines (GET /api/account/statement)
     busy         an owner action is being signed and sent                            view  { month, account, type, agent } the statement's
     flash, said  a refusal / what was done: set them, then load() or render(), and          filters · lens: the top bar's lens, see lensNow()
                  the shell shows each once as a toast
     ROUTE        { tab: "portfolio" | "markets" | "trade", params } from the hash (#/markets?tab=crypto&q=btc · #/trade?tile=swap)
   Doing
     load()                       read the account and the statement again, then render() (shell.js): the chrome, the visible pane, and
                                  the redraw of whatever sheet or drawer is open
     forget(prefix)               the reads kept by api() whose path starts so, dropped: after an action changed what they said
     own(draft, then)             one owner action: prepare, sign with this browser's key, send at POST /api/exchange; then(r) after it
                                  went through; a refusal lands in flash in the venue's or the account's own words, what it did in said
                                  (saidOf(body): the summary, or the order or payment as it stands). Then load()
     api(path, { ttl })           a JSON GET: one request at a time per path, kept ttl ms when asked. Resolves to the body, refusals
                                  included ({ ok:false, refusal }); refusalOf(body) is its sentence
     postJson(path, body)         a JSON POST → { status, body }
   Drawing (strings of HTML; escape what came from outside with esc)
     esc · money · fine (a cent or less as it was) · px (a price) · short (an address) · qty / qtyOf (an amount) · plural · nyDay · nyTime
     chg(n, unit)                 a change, ▲ up / ▼ down with a word for screen readers, never colour alone; unit "%" · "$" · "¢" · ""
     avatar(sym, size)            a letter tile where a logo would be ("sm" · "lg")      icon(name, cls)  one of the sprite's stroke icons
     table(cols, rows, opts)      cols [{ label, r, cls, cell(row, i) }] (cls on the column's head and cells) · opts { empty, rowAttr(row, i), cls }
     seg(items, on, onChange, { label })   a toggle; items [[value, label], …]; onChange(value) when another is pressed
     field · select · formOf      the form helpers;  download(name, rows) a CSV;  copyText(text, button)
     whatYouSign(prepared)        the fields the owner signs, exactly as Owner.submit signs them (prepared.shown)
   Sheets, the drawer, asking
     openSheet(html, { title, wide, redraw }) → the sheet's body element; closeSheet(). One sheet at a time (dialog#modal); redraw() runs
                                  after each load while it is open. An earlier dialog may still write #modal-form directly: it replaces the sheet
     openDrawer(html, { title, redraw }) → the drawer's body; closeDrawer(). A side sheet on the right; the page stays usable behind it
     confirmSheet(text, { danger, title, yes, no }) → Promise<boolean>      pickSheet(title, options, { current, note }) → Promise<value|null>
                                  (options [[value, label, hint], …] or { value, label, hint, disabled }); both stack over an open sheet
     quoteDialog({ title, sub, fields, draft, show, block, done, go, wide }) prepare → show → sign and send, in one sheet: draft(form)
                                  returns the draft, or a sentence saying what is missing; show(prepared, form) the quote in words (HTML);
                                  block(prepared, form) a sentence when the account would refuse what was prepared (shown before the sign
                                  button, which stays off and says why); done(r, prepared) after it went through (may return words for the
                                  toast). The quote is asked again as the form changes (the latest ask wins) and when its ten minutes run out;
                                  a refusal shows in the venue's words
     toast(text | { html }, kind, { ms })   kind "ok" · "no" (read out at once, stays longer) · "info"
   Where the page is
     go(tab, params, { replace }) · onRoute(fn(tab, params, moved)) — moved: another tab than before · lensNow() → { kind: "all" | "venue" |
     "agent", id, name } · inLens(venue, agent)
   What an account can do
     connected() · nameOf(id) · keyName(address) · owns() · writesOn() · canTrade(v) · canMove(v) · keyOnlyReads(v) · watched(v)
   What the panes define (the shell calls each if it is there): renderPortfolio(ctx) [portfolio.js] · renderMarkets(ctx) [markets.js] ·
     renderTrade(ctx) [trade.js], ctx = { el (#pane-…), owner, lens, params }; render() redraws only the visible pane, so keep what the owner is
     typing in an element you do not redraw. And the openers other parts call: openTicket(preset) · openClose(position) [trade.js] ·
     openHandToAgent(preset) [intent.js] · openReceive(venue) [money.js] · openLiveMove(venueId, preset) [money.js] · openAsset(key)
     [asset.js] · declineAsk(ask) [portfolio.js] · openMarket(item) [markets.js] · openPicker() / openConnect(option, opts) / connectVia(connector,
     opts) [connect.js] · openStatement() [statement.js] · openAgents() / openSettings() [agents-mount.js]. Ask before calling one: typeof
     openTicket === "function". A pane that throws says so in its place.
   The classes the panes draw with (ui/shell.css; colours, radii, shadows and fonts only from ui/tokens.css, Cream and Black alike). The
   look is Clean cards (M2): Manrope everywhere, labels in sentence case, numbers in Manrope 800 with tabular figures (.num .num-m), IBM
   Plex Mono (.mono) only for a hash, an address or a line that is signed; content in white cards on the ground, pills for buttons and toggles.
     a card         .card — white, a hairline of its own (--card-border), radius 16 (--radius-m), padding 18–20, a soft shadow
                    (--shadow-card; none in Black), its parts 14 apart; cards sit 20 apart in a column (.col-main .col-side). A .sec drawn
                    in a pane IS a card (the same look), so `class="sec"` and `class="card"` are one; inside a card, a sheet or the drawer a
                    .sec is a plain part under a hairline. .card-t: a card that is mostly a table (it runs nearly to the card's foot; a card
                    whose last child is a table() does this by itself) · .card-lift: sits a little higher (the ticket: --shadow-lift,
                    radius 20) · .card-warn or .callout: waiting on the owner (warn fill, soft orange edge; its first .label in warn-text)
                    · .box: a card with radius 20 (a market card) · .panel: the sticky ticket (a lifted card)
     a card header  .card-head (or .sec-head) — one row: .h2 (20px 700) or .label on the left, .tools (links, a seg, a small button) on
                    the right; the first child of the card
     quick actions  .quick holding .quick-card buttons (or .btn): four equal cards, 52 high, an icon (icon()) and a word
     a pill         .btn (on the second surface, no outline) · .btn-primary (filled in the text colour) · .btn-ghost (the same pill, its
                    word dimmed) · .btn-danger (down on its fill) · .btn-sm (36 high; the rest 44) · .btn-block · a status word: .pill
                    (.warm) · a chip: .chip (a white pill with the card's shadow; .warm .bad) · a small word beside a name: .tag (.up .warn)
     a seg          seg() → .seg: a pill track on the second surface, the pressed button a white pill with the card's shadow. A toggle
                    drawn by hand is <div class="seg" role="group"> of buttons with aria-pressed
     and the rest   .cols .col-main .col-side (two columns, the side one 340–380) · .label .h2 · .icon-btn (44 round) .link · .tabs
                    (category tabs: buttons with aria-pressed, underlined) · .t (table(), at home in a card: light row rules) .acts ·
                    .cards-grid .tile-grid .choice (a tile that is a card) · .yes .no-btn (tinted up and down) · .av (avatar(), round)
                    .who · .bar with .legend-l .sw-k · .feed · .spark (.area .line) · .skel .skel-rows · .fld .row2 · .quote .path ·
                    .empty .msg (ok · no · wait) · .up .down .flat (▲/▼ always with the colour) .warn-t */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
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
/* what the money is in, by class: its name, and its colour on the allocation bar (tokens.css) */
const CLASS = { cash: ["Cash", "var(--alloc-cash)"], stable: ["Stablecoins", "var(--alloc-stable)"], crypto: ["Crypto", "var(--alloc-crypto)"], equity: ["Stocks", "var(--alloc-equity)"], event: ["Predictions", "var(--alloc-event)"], rwa: ["RWA", "var(--alloc-rwa)"], earn: ["Earning", "var(--alloc-earn)"] };
let A = null;
let busy = false;
let flash = "";
let said = "";
let allStatement = false;
/* the statement's lines (every transaction, from every run's ledger) */
let S = [];
/* the statement's filters (month, account, type, agent) and the lens the top bar narrows the panes to */
const view = { month: "", account: "", type: "", agent: "", lens: "" };
/* when the account was last read, for the shell's refresh */
let loadedAt = 0;
/* a connection's summary, short: its name and balance; the rest behind "details" */
const sayHtml = (s) => {
  const m = /^(.+?) connected live · (\$[\d,.]+) there now · (.+)$/.exec(s || "");
  return m ? `<b>${esc(m[1])}</b> connected · ${esc(m[2])}<details class="inl"><summary>details</summary>${esc(m[3])}</details>` : esc(s);
};

const connected = () => A.venues.filter((v) => v.live);
const nameOf = (id) => (A.venues.find((v) => v.id === id) || {}).name || id;
const keyName = (address) => (A.keys.find((k) => k.address === address) || {}).name || short(address);
const nowMs = () => Date.parse(A.now);
/* this browser signs for the owner (the others only look) */
const owns = () => Owner.role === "owner";

async function load() {
  const [r, st] = await Promise.all([fetch("/api/account"), fetch("/api/account/statement").catch(() => null)]);
  S = st && st.ok ? ((await st.json()).lines || []) : S;
  if (r.status === 404) return void ($("main").innerHTML = '<p class="dim">This server runs the simulated statement (<span class="mono">--classic</span>). <a href="/">Open it</a>.</p>');
  A = await r.json();
  // the service was restarted under this page: it no longer knows this browser's key, so offer it again
  if (Owner.kid && !A.signers.owners.some((o) => o.id === `device:${Owner.kid}`) && !A.signers.pendingDevices.some((d) => d.kid === Owner.kid)) {
    await Owner.ready();
    A = await (await fetch("/api/account")).json();
  }
  // this browser was waiting, and another device of the owner's let it sign: it signs from now on, without a reload
  if (Owner.role === "pending" && A.signers.owners.some((o) => o.id === `device:${Owner.kid}`)) await Owner.ready();
  loadedAt = Date.now();
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
    said = refused ? "" : saidOf(r.body);
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

/* what an action did, in a few words: the account's own summary, or the order or payment as it now stands */
function saidOf(body) {
  if (!body) return "";
  if (body.summary) return body.summary;
  const o = body.kind === "order" && body.order;
  if (o) return `${o.status === "filled" ? (o.side === "buy" ? "Bought" : "Sold") : o.status === "partial" ? "Part filled" : o.status === "canceled" ? "Canceled" : ["rejected", "expired"].includes(o.status) ? "Not filled" : "Placed"}: ${o.id}${o.note ? ` · ${o.note}` : ""}`;
  const p = body.kind === "payment" && body.payment;
  return p ? p.note || `${p.id}: ${p.status}` : "";
}

/* a JSON read as the page asks it: one request at a time per path (a second ask while the first is out gets the same answer), and the
   answer kept `ttl` milliseconds when asked. What comes back is the body, a refusal included; a request that never reached the account is
   { ok: false, error } and is not kept */
const API = new Map();
function api(path, { ttl = 0 } = {}) {
  const hit = API.get(path);
  if (hit && hit.pending) return hit.pending;
  if (hit && ttl > 0 && Date.now() - hit.at < ttl) return Promise.resolve(hit.body);
  if (API.size > 200) for (const [k, v] of API) if (!v.pending && Date.now() - v.at > 600_000) API.delete(k);
  let reached = true;
  const pending = fetch(path)
    .then((r) => r.json().catch(() => ({ ok: false, error: `${r.status} ${r.statusText}`.trim() })))
    .catch((err) => ((reached = false), { ok: false, error: String((err && err.message) || err) }))
    .then((body) => {
      if (reached) API.set(path, { at: Date.now(), body });
      else API.delete(path);
      return body;
    });
  API.set(path, { ...(hit || {}), pending });
  return pending;
}
/* a refusal as one sentence, from a read's body */
const refusalOf = (body) => (body && body.refusal && body.refusal.message) || (body && body.error) || "";
/* the reads kept whose path starts so, dropped (one still on its way finishes and is kept): after an action changed what they said */
function forget(prefix) {
  for (const [k, v] of [...API]) if (k.startsWith(prefix) && !v.pending) API.delete(k);
}

// ---- drawing ------------------------------------------------------------------------------

const qtyOf = (n) => Number(n).toLocaleString("en-US", { maximumFractionDigits: Math.abs(n) >= 1000 ? 2 : 8 });
const qty = qtyOf;
/* one icon from the sprite in account.html: stroke drawings, nobody's logo */
const icon = (name, cls = "") => `<svg class="ico${cls ? ` ${cls}` : ""}" aria-hidden="true" focusable="false"><use href="#i-${esc(name)}"></use></svg>`;
/* a letter tile where a logo would be */
const avatar = (sym, size = "") => `<span class="av${size ? ` ${size}` : ""}" aria-hidden="true">${esc(String(sym || "?").replace(/[^A-Za-z0-9$]/g, "").slice(0, 4).toUpperCase() || "?")}</span>`;
/** a change, up or down: the glyph, a word for a screen reader, the amount — never the colour alone */
function chg(n, unit = "%") {
  if (n === undefined || n === null || n === "" || !Number.isFinite(Number(n))) return '<span class="flat">—</span>';
  const v = Number(n);
  const a = Math.abs(v);
  const amount = unit === "$" ? fine(a) : unit === "¢" ? `${Number(a.toFixed(1))}¢` : unit === "%" ? `${a >= 1 ? a.toFixed(1) : a.toFixed(2)}%` : px(a);
  if (v === 0) return `<span class="flat">${amount}</span>`;
  return `<span class="${v > 0 ? "up" : "down"}"><span aria-hidden="true">${v > 0 ? "▲" : "▼"}</span><span class="sr">${v > 0 ? "up" : "down"}</span> ${amount}</span>`;
}
/** a table: `cols` [{ label, r (right-aligned), cls, cell(row, i) → HTML }], `rows` any list; opts.empty the words when there are none,
 * opts.rowAttr(row, i) the attributes of a row (e.g. `class="click" data-key="…"`), opts.cls a class for the table */
function table(cols, rows, { empty = "Nothing here.", rowAttr, cls = "" } = {}) {
  if (!rows || !rows.length) return `<p class="empty">${esc(empty)}</p>`;
  const td = (c) => [c.r ? "r" : "", c.cls || ""].filter(Boolean).join(" ");
  return `<div class="t-wrap"><table class="t${cls ? ` ${cls}` : ""}"><thead><tr>${cols.map((c) => `<th scope="col"${td(c) ? ` class="${td(c)}"` : ""}>${c.label ? esc(c.label) : `<span class="sr">${esc(c.sr || "Actions")}</span>`}</th>`).join("")}</tr></thead><tbody>${rows.map((row, i) => `<tr${rowAttr ? ` ${rowAttr(row, i)}` : ""}>${cols.map((c) => `<td${td(c) ? ` class="${td(c)}"` : ""}>${c.cell(row, i)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
/* a toggle: one pressed at a time; what pressing another does is kept here by the toggle's id (the page draws with innerHTML, so a click on
   any toggle is heard once, on the document: shell.js) */
const SEGS = new Map();
let segN = 0;
function seg(items, on, onChange, { label = "" } = {}) {
  const id = `seg-${++segN}`;
  if (SEGS.size > 100) for (const k of SEGS.keys()) if (!document.querySelector(`[data-seg="${k}"]`)) SEGS.delete(k);
  if (onChange) SEGS.set(id, onChange);
  const pairs = items.map((x) => (Array.isArray(x) ? x : [x, x]));
  return `<div class="seg" role="group"${label ? ` aria-label="${esc(label)}"` : ""} data-seg="${id}">${pairs.map(([v, l]) => `<button type="button" data-v="${esc(v)}" aria-pressed="${String(String(v) === String(on))}">${esc(l)}</button>`).join("")}</div>`;
}

// ---- forms, files, the clipboard --------------------------------------------------------

const field = (label, html) => `<label>${label}${html}</label>`;
const select = (name, opts, sel) => `<select name="${name}">${opts.map(([v, l, dis]) => `<option value="${esc(v)}"${v === sel ? " selected" : ""}${dis ? " disabled" : ""}>${esc(l)}</option>`).join("")}</select>`;
const formOf = (id) => Object.fromEntries(new FormData($(id)).entries());
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
const postJson = async (path, body) => { const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };

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

// ---- toasts -------------------------------------------------------------------------------

/** what was done ("ok"), what was refused ("no": read out at once and kept longer), or a word in passing ("info") */
function toast(content, kind = "ok", { ms } = {}) {
  const region = kind === "no" ? $("alerts") : $("toasts");
  if (!region || !content) return null;
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = `<span class="mk" aria-hidden="true">${kind === "no" ? "✗" : kind === "ok" ? "✓" : "·"}</span><div class="tx">${typeof content === "object" ? content.html : esc(content)}</div><button type="button" class="icon-btn" aria-label="Dismiss">${icon("x", "sm")}</button>`;
  el.querySelector("button").addEventListener("click", () => el.remove());
  region.appendChild(el);
  // over an open sheet too: the stack is a popover, raised to the top each time it speaks
  const stack = region.parentElement;
  if (stack && stack.showPopover) {
    try {
      if (stack.matches(":popover-open")) stack.hidePopover();
      stack.showPopover();
    } catch {
      // a browser without popovers shows the stack where it is
    }
  }
  const all = document.querySelectorAll(".toast");
  if (all.length > 4) all[0].remove();
  const life = ms ?? (kind === "no" ? 14000 : 6000);
  let timer = 0;
  const start = () => { if (life > 0) timer = setTimeout(() => el.remove(), life); };
  el.addEventListener("mouseenter", () => clearTimeout(timer));
  el.addEventListener("mouseleave", start);
  el.addEventListener("focusin", () => clearTimeout(timer));
  start();
  return el;
}

// ---- the sheet, the drawer, asking ----------------------------------------------------------

/* what the sheet (dialog#modal) and the drawer (dialog#drawer) are showing: a redraw to run after each load while open */
let SHEET = null;
let DRAWER = null;
const head = (title, close) => `<header class="sheet-h">${title ? `<h2 id="${close}-title">${esc(title)}</h2>` : "<span></span>"}<button type="button" class="icon-btn" data-${close}-close aria-label="Close">${icon("x")}</button></header>`;

/** the one sheet: a title, a body of the caller's, a close button; `wide` for a table (the Statement). Returns the body */
function openSheet(html, { title = "", wide = false, redraw } = {}) {
  const d = $("modal");
  $("modal-form").replaceChildren();
  d.classList.toggle("wide", !!wide);
  d.setAttribute("aria-labelledby", "sheet-title");
  // what an action from the sheet did, said in the sheet as well: under a modal sheet the toasts can be seen but not reached
  $("sheet").innerHTML = `${head(title, "sheet")}<div class="msg sheet-msg" data-sheet-msg role="status"></div><div class="sheet-b">${html}</div>`;
  SHEET = { redraw: redraw || null };
  if (!d.open) d.showModal();
  return $("sheet").querySelector(".sheet-b");
}
function closeSheet() {
  if ($("modal").open) $("modal").close();
}

/** the drawer: a side sheet on the right for one thing (an asset, a market, the menu); the page behind stays usable. Returns the body */
function openDrawer(html, { title = "", redraw } = {}) {
  const d = $("drawer");
  const back = DRAWER ? DRAWER.back : document.activeElement;
  d.innerHTML = `${head(title, "drawer")}<div class="sheet-b">${html}</div>`;
  d.setAttribute("aria-labelledby", "drawer-title");
  DRAWER = { redraw: redraw || null, back };
  if (!d.open) d.show();
  const first = d.querySelector(".sheet-b button, .sheet-b a, .sheet-b input, .sheet-b select") || d.querySelector("[data-drawer-close]");
  if (first) first.focus();
  return d.querySelector(".sheet-b");
}
function closeDrawer() {
  if ($("drawer").open) $("drawer").close();
}

/* the small asking dialog (dialog#ask): over an open sheet, without replacing it. A second ask answers the first "no" */
let ASKING = null;
function asking(html, read) {
  const d = $("ask");
  if (ASKING) ASKING(null);
  return new Promise((resolve) => {
    let done = false;
    const answer = (v) => {
      if (done) return;
      done = true;
      ASKING = null;
      resolve(v);
    };
    ASKING = answer;
    d.innerHTML = html;
    d.returnValue = "";
    d.addEventListener("close", () => answer(read(d.returnValue)), { once: true });
    if (!d.open) d.showModal();
  });
}
/** a yes or no, over whatever is open: true only for the yes */
function confirmSheet(text, { danger = false, title = "", yes = "Yes", no = "Cancel" } = {}) {
  return asking(`<form method="dialog" class="ask-f">${title ? `<h2>${esc(title)}</h2>` : ""}<p>${esc(text)}</p><div class="end"><button type="submit" value="" class="btn">${esc(no)}</button><button type="submit" value="yes" class="btn ${danger ? "btn-danger" : "btn-primary"}">${esc(yes)}</button></div></form>`, (v) => v === "yes");
}
/** one of a few, over whatever is open: the value picked, or null */
function pickSheet(title, options, { current, note = "" } = {}) {
  const opts = options.map((o) => (Array.isArray(o) ? { value: o[0], label: o[1], hint: o[2] } : o));
  return asking(`<form method="dialog" class="ask-f"><h2>${esc(title)}</h2>${note ? `<p class="dim small">${esc(note)}</p>` : ""}<div class="picks">${opts.map((o, i) => `<button type="submit" value="${i}"${o.disabled ? " disabled" : ""}${current !== undefined && String(o.value) === String(current) ? ' aria-current="true"' : ""}><span>${esc(o.label)}</span>${o.hint ? `<span class="dim small">${esc(o.hint)}</span>` : ""}</button>`).join("")}</div><div class="end"><button type="submit" value="" class="btn">Cancel</button></div></form>`, (v) => (v === "" || !opts[Number(v)] ? null : opts[Number(v)].value));
}

/* the fields the owner signs, as the device key signs them (owner.js builds the signing input from these, not from the server) */
const whatYouSign = (p, { open = false } = {}) => (p && p.shown ? `<details class="signs"${open ? " open" : ""}><summary>What you sign</summary><pre>${esc(p.shown.map((f) => `${f.name}: ${f.value}`).join("\n"))}</pre></details>` : "");
/* a refusal at the door, the way own() reads one */
const refusedAt = (r) => r.status >= 400 || (r.body && r.body.ok === false) || (r.body && r.body.kind === "result" && r.body.result && r.body.result.ok === false);

/** prepare → show → sign and send, in one sheet. The account prepares the exact action from what is typed (asked again as it changes; the
 * latest ask wins), shows it in words with what is signed, and the signature is good for ten minutes — asked again when they run out */
function quoteDialog({ title, sub = "", fields = "", draft, show, block, done, go = "Sign and send", wide = false }) {
  const body = openSheet(`${sub ? `<p class="dim small">${sub}</p>` : ""}<form class="qd" novalidate>${fields}<div class="quote real" data-q><span class="dim">Fill it in to see what it would be.</span></div><div data-sign></div><div class="msg no" data-block role="alert" hidden></div><div class="msg" data-msg role="status"></div><div class="end"><button type="button" class="btn" data-sheet-close>Cancel</button><button type="submit" class="btn btn-primary" data-go disabled>${esc(go)}</button></div></form>`, { title, wide });
  const form = body.querySelector("form.qd");
  const box = form.querySelector("[data-q]");
  const sign = form.querySelector("[data-sign]");
  const stop = form.querySelector("[data-block]");
  const msg = form.querySelector("[data-msg]");
  const btn = form.querySelector("[data-go]");
  /* what the account would refuse, said before the sign button, which stays off with the same words */
  const refuse = (why) => {
    stop.hidden = !why;
    stop.textContent = why || "";
    btn.title = why || "";
  };
  let prepared = null;
  let seq = 0;
  let timer = 0;
  let tick = 0;
  const say = (text, state = "") => { msg.className = `msg${text && state ? ` ${state}` : ""}`; msg.textContent = text || ""; };
  const left = () => {
    const el = box.querySelector("[data-left]");
    if (!form.isConnected || !prepared || !el) return void clearInterval(tick);
    const ms = prepared.action.deadline - Date.now();
    if (ms <= 0) return void requote();
    el.textContent = `Your signature is good for ${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")} more.`;
  };
  const requote = async () => {
    if (!form.isConnected) return;
    const my = ++seq;
    prepared = null;
    btn.disabled = true;
    sign.innerHTML = "";
    refuse("");
    clearInterval(tick);
    const d = draft(form);
    if (!d || typeof d === "string") return void (box.innerHTML = `<span class="dim">${esc(d || "Fill it in to see what it would be.")}</span>`);
    box.innerHTML = '<span class="dim">Asking…</span>';
    const r = await Owner.prepare(d);
    if (!form.isConnected || my !== seq) return;
    if (r.status !== 200) return void (box.innerHTML = `<div class="msg no">${esc(Owner.why(r) || "Refused")}</div>`);
    prepared = r.body;
    box.innerHTML = `${show ? show(prepared, form) : `<div class="big"><span>${esc((prepared.quote && prepared.quote.words) || prepared.action.type)}</span></div>`}${prepared.action.deadline ? '<div class="left-t" data-left></div>' : ""}`;
    sign.innerHTML = whatYouSign(prepared);
    const no = block ? block(prepared, form) : "";
    refuse(no);
    btn.disabled = !owns() || !!no;
    if (prepared.action.deadline) {
      left();
      tick = setInterval(left, 1000);
    }
  };
  const later = (ms = 350) => { clearTimeout(timer); timer = setTimeout(requote, ms); };
  form.addEventListener("input", () => later());
  form.addEventListener("change", () => later(0));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!prepared || busy || !stop.hidden) return;
    const p = prepared;
    btn.disabled = true;
    say("Sending it…", "wait");
    const r = await Owner.submit(p);
    if (refusedAt(r)) {
      say(Owner.why(r) || "Refused", "no");
      return void requote();
    }
    try {
      said = (done ? await done(r, p) : "") || saidOf(r.body);
    } catch (err) {
      flash = String((err && err.message) || err).slice(0, 240);
    }
    closeSheet();
    await load();
  });
  later(0);
  return { form, requote: () => later(0), get prepared() { return prepared; } };
}

// ---- where the page is ----------------------------------------------------------------------

const TABS = ["portfolio", "markets", "trade"];
const ROUTE = { tab: "portfolio", params: {} };
const ROUTED = [];
const routeOf = (hash) => {
  const m = /^#\/([a-z]+)(?:\?(.*))?$/.exec(hash || "");
  return { tab: m && TABS.includes(m[1]) ? m[1] : "portfolio", params: Object.fromEntries(new URLSearchParams((m && m[2]) || "")) };
};
const hashOf = (tab, params = {}) => {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "")).toString();
  return `#/${TABS.includes(tab) ? tab : "portfolio"}${q ? `?${q}` : ""}`;
};
/** go to a tab, with what it should show (#/markets?tab=crypto&q=btc); `replace` keeps the browser's history as it was */
function go(tab, params = {}, { replace = false } = {}) {
  const h = hashOf(tab, params);
  if (h === location.hash) return void routed();
  if (replace) {
    history.replaceState(null, "", h);
    routed();
  } else location.hash = h;
}
const onRoute = (fn) => void ROUTED.push(fn);
/* the hash says where the page is: everyone listening is told (the shell first: it shows the pane) */
function routed() {
  const r = routeOf(location.hash);
  const moved = r.tab !== ROUTE.tab;
  ROUTE.tab = r.tab;
  ROUTE.params = r.params;
  for (const fn of ROUTED) fn(ROUTE.tab, ROUTE.params, moved);
}

/* the lens: what the top bar narrows the panes to — every account (""), one venue ("venue:<id>") or one agent ("agent:<0x…>") */
function lensNow() {
  const m = /^(venue|agent):(.+)$/.exec(view.lens || "");
  if (!m || !A) return { kind: "all", id: "", name: "All accounts" };
  return { kind: m[1], id: m[2], name: m[1] === "venue" ? nameOf(m[2]) : keyName(m[2]) };
}
/* a row is in the lens: every row under "All accounts"; under a venue, that venue's; under an agent, what that agent did */
const inLens = (venue, agent) => {
  const l = lensNow();
  return l.kind === "all" || (l.kind === "venue" ? venue === l.id : !!agent && String(agent).toLowerCase() === l.id.toLowerCase());
};

// ---- what an account can do -------------------------------------------------------------

const writesOn = () => !!(A.connectLive && A.connectLive.writes && A.connectLive.writes.on);
const watched = (v) => !!v.address && !v.proven;
/* an order can be placed here: trading is on, the venue trades, the key may (or has not said), and a wallet is proven yours */
const canTrade = (v) => writesOn() && !!v.trade && v.trade.can !== false && !watched(v);
const canMove = (v) => writesOn() && !!v.liveCan && !v.readOnlyBecause && !watched(v) && (v.liveCan.withdraw !== false || (v.liveCan.ledgers.length > 1 && v.liveCan.transfer !== false) || v.liveCan.swap !== false || !!v.liveCan.send);
/* writes are on, the venue is written, but this key lets nothing leave it: it can still receive */
const keyOnlyReads = (v) => writesOn() && !!v.liveCan && !v.readOnlyBecause && !watched(v) && !canMove(v);
