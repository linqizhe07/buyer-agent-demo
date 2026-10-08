/* The account page: the user's real accounts on one page, each read through the venue's own interface. It renders /api/account and
   signs what the owner asks for; it decides nothing the account did not. */
/* THE CONTRACT. The page is plain scripts sharing one global scope, run in this order after owner.js (the device key: Owner.prepare ·
   Owner.submit · Owner.act · Owner.why · Owner.role):
     core (this file) · connect · money · asset · intent · portfolio · earn · markets · trade · statement · agents-mount · shell (draws and
     starts it).
   Each top-level name is declared once across them all (test/unit/page-scripts.test.ts). Declare what the shell calls as top-level
   `function` declarations.

   What the page holds
     A            what GET /api/account said last (null until the first load)        S     the statement's lines (GET /api/account/statement)
     busy         an owner action is being signed and sent                            view  { month, account, type, agent } the statement's
     flash, said  a refusal / what was done: set them, then load() or render(), and          filters · lens: the top bar's lens, see lensNow()
                  the shell shows each once as a toast
     ROUTE        { tab: "portfolio" | "markets" | "trade", params } from the hash (#/markets?tab=crypto&q=btc · #/trade?kind=perps)
   Doing
     load()                       read the account and the statement again, then render() (shell.js): the chrome, the visible pane, and
                                  the redraw of whatever sheet or drawer is open; the latest read wins over a slower earlier one
     forget(prefix)               the reads kept by api() whose path starts so, dropped: after an action changed what they said
     own(draft, then)             one owner action: prepare, sign with this browser's key, send at POST /api/exchange; then(r) after it
                                  went through; a refusal lands in flash in the venue's or the account's own words, what it did in said
                                  (saidOf(body): the summary, or the order or payment as it stands). Then load(). An account that does
                                  not answer is a refusal too (NO_ANSWER), never an exception out of a sheet
     cancelOrder(o, then)         a signed liveCancel of one order: an agent's after a yes, the owner's own with one click
     api(path, { ttl })           a JSON GET: one request at a time per path, kept ttl ms when asked. Resolves to the body, refusals
                                  included ({ ok:false, refusal }); refusalOf(body) is its sentence. Nothing that never came from the
                                  account (no answer, a gateway's page) is kept
     postJson(path, body)         a JSON POST → { status, body }; no answer → NO_ANSWER ({ status: 0, body: { ok: false, error } })
     debounce(fn, ms)             later(ms): fn once, a little later, however often it is asked      thenLoad(fn)  a button's work, then load()
   Drawing (strings of HTML; escape what came from outside with esc)
     esc · money (-$1,234.50) · fine (a cent or less as it was) · px (a price) · usd (a price in dollars, four figures under $1) · cents
     (an event contract's price, 62.5¢, held to 0–100) · short (an address) · qtyOf (an amount) · plural · nyDay · nyTime (a dash for a
     time that is not one) · typeText (an order's type) · isLive (an order on a book) · byOf (who did it) · readOnlyWords (a venue's words)
     chg(n, unit)                 a change, ▲ up / ▼ down with a word for screen readers, never colour alone; unit "%" · "$" · "¢" · ""
     avatar(sym, size)            a letter tile where a logo would be ("sm" · "lg")      icon(name, cls)  one of the sprite's stroke icons
     table(cols, rows, opts)      cols [{ label, r, cls, cell(row, i) }] (cls on the column's head and cells) · opts { empty, rowAttr(row, i), cls }
     seg(items, on, onChange, { label })   a toggle; items [[value, label], …]; onChange(value) when another is pressed
     paint(el, html)              el's HTML written only where it changed: the new HTML is laid over what is there (morphKids) — an element
                                  kept where it stands (or by its key among its siblings: data-k, else data-key), only the attributes and
                                  text that differ written, a row that did not change left alone; the focused control stays focused (and
                                  is found again by data-fk · data-key · its place only when it went). What every part drawn again on each
                                  read draws with. Listen on the part (one listener, by data attributes), never on what it drew: a control
                                  drawn again may be the same element. setText(el, t) an element's words set in place (its one text node)
     everySecond(fn)              fn() once a second, as the second turns over (every countdown and clock on the page, together; held while
                                  the page scrolls) → a function that stops it. fn reads and decides; it returns its writes as a function,
                                  and every write of that second is made in one frame (none at all in a second where nothing changed); false
                                  stops it. nextFrame(fn) the next frame (at once where there are none) · still() the owner asked for no
                                  motion · afterMotion(el, ms, fn) once el's own transition or animation ended (ms at the most; at once
                                  under still()) · whenStill(fn) once the page is not scrolling · paneLater(tab, fn) once a pane coming in
                                  has come in
     field · select · formFields(form) · setOptions(select, opts, value)   the form helpers;  download(name, rows) a CSV;  copyText(text, button)
     whatYouSign(prepared, { open, notes })   the fields the owner signs, exactly as Owner.submit signs them (prepared.shown); notes a word
                                  beside a field, by name
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
                                  toast); signNotes(prepared, form) words beside the signed fields, by name. The quote is asked again as the
                                  form changes (the latest ask wins) and when its ten minutes run out; a refusal shows in the venue's words
     toast(text | { html }, kind, { ms })   kind "ok" · "no" (read out at once, stays longer) · "info"
   Where the page is
     go(tab, params, { replace }) · onRoute(fn(tab, params, moved)) — moved: another tab than before · lensNow() → { kind: "all" | "venue" |
     "agent", id, name } · inLens(venue, agent)
   What an account can do
     connected() · nameOf(id) · keyName(address) · owns() · writesOn() · canTrade(v) · canMove(v) · keyOnlyReads(v) · watched(v) ·
     isAgentWallet(v) (never disconnected: emptied with Take back…) · modeOf(m) ("guard" | "open", whichever word a read uses) ·
     dollarsOf() · isDollar(asset) · networksOf() · bridgeChainsOf() (the lists the account publishes, the page's own as the fallback)
   A browser wallet sending what the account built: PROVIDERS (proven address → wallet) · SENT · INFLIGHT · walletFor(address) · mined(w, hash)
   What the panes define (the shell calls each if it is there): renderPortfolio(ctx) [portfolio.js] · renderMarkets(ctx) [markets.js] ·
     renderTrade(ctx) [trade.js], ctx = { el (#pane-…), owner, lens, params }; render() redraws only the visible pane, so keep what the owner is
     typing in an element you do not redraw. And the openers other parts call: openTicket(preset) · openClose(position) [trade.js] ·
     openHandToAgent(preset) [intent.js] · openReceive(venue) [money.js] · openLiveMove(venueId, preset) [money.js] · openAsset(key)
     [asset.js] · declineAsk(ask) [portfolio.js] · openMarket(item) [markets.js] · openPicker() / openConnect(option, opts) / connectVia(connector,
     opts) [connect.js] · openStatement() [statement.js] · openAgents() / openSettings() / openMode() [agents-mount.js; only the rail's
     "What changes ›" opens the Mode sheet] · openEarn(preset) / openSellMany(preset) [earn.js]. Ask before calling one: typeof
     openTicket === "function". A pane that throws says so in its place.
   The classes the panes draw with (ui/shell.css; colours, radii, shadows and fonts only from ui/tokens.css, Cream and Black alike). The
   look is Clean cards (M2): Manrope everywhere, labels in sentence case, numbers in Manrope 800 with tabular figures (.num .num-m), IBM
   Plex Mono (.mono) only for a hash, an address or a line that is signed; content in white cards on the ground, pills for buttons and toggles.
     a card         .card — white, a hairline of its own (--card-border), radius 16 (--radius-m), padding 18–20, a soft shadow
                    (--shadow-card; none in Black), its parts 14 apart; cards sit 20 apart in a column (.col-main .col-side). A .sec drawn
                    in a pane IS a card (the same look), so `class="sec"` and `class="card"` are one; inside a card, a sheet or the drawer a
                    .sec is a plain part under a hairline. A card whose last child is a table() runs the table nearly to its foot by itself
                    · .callout: waiting on the owner (warn fill, soft orange edge; its first .label in warn-text) · .box: a card with radius
                    20 (a market card) · .panel: the sticky ticket (a lifted card, --shadow-lift)
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
/* a figure from outside, as a number: nothing given counts as 0; anything that is not a number (a venue's "n/a") is NaN, which every
   formatter below shows as a dash, never as "NaN" */
const num = (n) => (n === undefined || n === null || n === "" ? 0 : Number(n));
/* dollars to the cent, the sign before the dollar: -$1,234.50 */
const money = (n) => {
  const v = num(n);
  return Number.isFinite(v) ? `${v < 0 ? "-" : ""}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—";
};
/* only an address is shortened */
const short = (a) => (/^0x[0-9a-fA-F]{16,}$/.test(String(a)) ? `${String(a).slice(0, 8)}…${String(a).slice(-4)}` : String(a));
/* an amount can be a cent or less: show what it was, not $0.00 — to six decimals, and to two figures below a millionth */
const fine = (n) => {
  const v = num(n);
  if (!Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (!a || a >= 0.01) return money(v);
  const digits = a < 1e-6 ? Number(a.toPrecision(2)).toLocaleString("en-US", { maximumFractionDigits: 12 }) : a.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  return `${v < 0 ? "-" : ""}$${digits}`;
};
/* a price as a person reads it: no float tails, up to eight decimals; a dash for what is not a number */
const px = (n) => (n === undefined || n === null || n === "" || !Number.isFinite(Number(n)) ? "—" : Number(Number(n).toPrecision(10)).toLocaleString("en-US", { maximumFractionDigits: 8 }));
/* a price in dollars: to the cent from a dollar up, the first four figures below that ($0.1212), the sign before the dollar */
const usd = (n) => {
  if (n === undefined || n === null || n === "" || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  return Math.abs(v) >= 1 ? money(v) : `${v < 0 ? "-" : ""}$${px(Number(Math.abs(v).toPrecision(4)))}`;
};
/* an event contract's price — the market's chance for it — in cents, to a tenth of a cent (62.5¢, 99.6¢, 0.4¢), held to 0–100 */
const cents = (p) => {
  if (p === undefined || p === null || p === "" || !Number.isFinite(Number(p))) return "—";
  const c = Math.min(100, Math.max(0, Number(p) * 100));
  return `${Number(c.toFixed(1))}¢`;
};
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + "s"}`;
/* a time in New York; a time that is missing or not one is a dash, never an exception out of a whole sheet. Each way of saying it is made
   once and kept (making a date formatter costs more than using one: a table of times would otherwise make one a cell) */
const NY_FORMATS = new Map();
const ny = (iso, opts) => {
  const ms = typeof iso === "number" ? iso : Date.parse(String(iso ?? ""));
  if (!Number.isFinite(ms)) return "—";
  const k = JSON.stringify(opts || {});
  let f = NY_FORMATS.get(k);
  if (!f) NY_FORMATS.set(k, (f = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", ...opts })));
  return f.format(new Date(ms));
};
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
/* the mode as the account says it, whichever word a read uses for it: "guard" (Guard) or "open" (Beast; the restore report says the word) */
const modeOf = (m) => (m === "open" || m === "Beast" ? "open" : "guard");
/* an agent wallet: a venue whose key this account holds for an agent. It is emptied with Take back…, never disconnected */
const isAgentWallet = (v) => !!v && (v.connector === "live:agent-wallet" || String(v.id || "").startsWith("agent-"));
/* the lists the account publishes — the dollar stablecoins, the chains money moves on, the chains a bridge joins — with the page's own
   lists only where an account does not publish them yet (the dollars as the account's door counts them: live/types.ts STABLES) */
const DOLLARS_KNOWN = ["USD", "USDC", "USDC.E", "USDT", "USDT0", "USD₮0", "USD₮", "FDUSD", "PYUSD", "DAI", "TUSD", "USDP", "PUSD", "USDG"];
const NETWORKS_KNOWN = ["Arbitrum", "Base", "Ethereum", "Optimism", "Polygon", "BNB Chain"];
const dollarsOf = () => (A && Array.isArray(A.dollars) && A.dollars.length ? A.dollars.map((x) => String(x).toUpperCase()) : DOLLARS_KNOWN);
const isDollar = (asset) => dollarsOf().includes(String(asset || "").toUpperCase());
const networksOf = () => (A && Array.isArray(A.networks) && A.networks.length ? A.networks.map(String) : NETWORKS_KNOWN);
const bridgeChainsOf = () => (A && Array.isArray(A.bridgeChains) && A.bridgeChains.length ? A.bridgeChains.map(String) : networksOf());

/* each read of the account is numbered: a slower one that lands after a later one changes nothing (the latest wins) */
let loadSeq = 0;
async function load() {
  const my = ++loadSeq;
  const [r, st] = await Promise.all([fetch("/api/account"), fetch("/api/account/statement").catch(() => null)]);
  const lines = st && st.ok ? (await st.json().catch(() => ({}))).lines : null;
  if (r.status === 404) return void ($("main").innerHTML = '<p class="dim">This server runs the simulated statement (<span class="mono">--classic</span>). <a href="/">Open it</a>.</p>');
  let page = await r.json();
  // the service was restarted under this page: it no longer knows this browser's key, so offer it again
  if (Owner.kid && !page.signers.owners.some((o) => o.id === `device:${Owner.kid}`) && !page.signers.pendingDevices.some((d) => d.kid === Owner.kid)) {
    await Owner.ready();
    page = await (await fetch("/api/account")).json();
  }
  // this browser was waiting, and another device of the owner's let it sign: it signs from now on, without a reload
  if (Owner.role === "pending" && page.signers.owners.some((o) => o.id === `device:${Owner.kid}`)) await Owner.ready();
  if (my !== loadSeq) return;
  if (Array.isArray(lines)) S = lines;
  A = page;
  loadedAt = Date.now();
  render();
}

/** one owner action: prepare, sign with this browser's device key, send, show what came back. A refusal — the account's or the venue's,
 * or no answer at all — lands in `flash` in its own words; nothing is announced as done that was not */
async function own(draft, then) {
  if (busy) return null;
  busy = true;
  document.body.classList.add("busy");
  let r = null;
  try {
    r = await Owner.act(draft);
    const refused = refusedAt(r);
    flash = refused ? Owner.why(r) || "Refused" : "";
    said = refused ? "" : saidOf(r.body);
    if (then && !refused) {
      busy = false;
      await then(r);
    }
  } catch (err) {
    flash = String((err && err.message) || err).slice(0, 240) || "The account did not answer. Try again.";
    said = "";
  } finally {
    busy = false;
    document.body.classList.remove("busy");
  }
  try {
    await load();
  } catch {
    // the account is not answering: the shell's next refresh says so
    render();
  }
  return r;
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
  // an answer that is not JSON never came from the account (a gateway in between): it is not kept either
  const pending = fetch(path)
    .then((r) => r.json().catch(() => ((reached = false), { ok: false, error: `${r.status} ${r.statusText}`.trim() })))
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

const qtyOf = (n) => (n === undefined || n === null || n === "" || !Number.isFinite(Number(n)) ? "—" : Number(n).toLocaleString("en-US", { maximumFractionDigits: Math.abs(Number(n)) >= 1000 ? 2 : 8 }));
/* an order's type in words: market, a limit, a stop and where it triggers */
const typeText = (o) => (o.type === "limit" ? `limit ${px(o.limitPrice)}` : o.type === "stop" ? `stop at ${px(o.stopPrice)}` : o.type === "stop_limit" ? `stop ${px(o.stopPrice)}, limit ${px(o.limitPrice)}` : "market") + (o.tif ? ` · ${o.tif.toUpperCase()}` : "") + (o.postOnly ? " · post-only" : "") + (o.reduceOnly ? " · reduce-only" : "");
/* an order still on a book, or on its way to one */
const isLive = (o) => ["open", "partial", "pending"].includes(o.status);
/* who did it: you, or an agent — on your yes (Guard), or inside its limit (Beast); the account's own words for a line's `by` */
const byOf = (p) => (p.authority !== "agent" ? "You" : `${keyName(p.agent)}, ${p.card ? "approved by you" : "inside its limit"}`);
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
/* a form's fields by name, as typed */
const formFields = (form) => Object.fromEntries(new FormData(form).entries());
/** a select's options set to `opts` ([[value, label, disabled], …]) and its value to `value`: the options are written only when they differ
 * from what it has, so a select that is open, or has the focus, is left as it is and only its value moves */
function setOptions(sel, opts, value) {
  if (!sel) return;
  const want = opts.map(([v, l, dis]) => `${v}\u0000${l}\u0000${dis ? 1 : 0}`).join("\u0001");
  const have = [...(sel.options || [])].map((o) => `${o.value}\u0000${o.textContent}\u0000${o.disabled ? 1 : 0}`).join("\u0001");
  if (want !== have) sel.innerHTML = opts.map(([v, l, dis]) => `<option value="${esc(v)}"${dis ? " disabled" : ""}>${esc(l)}</option>`).join("");
  const v = value === undefined || value === null ? "" : String(value);
  if (opts.some(([x]) => String(x) === v)) sel.value = v;
  else if (opts.length) sel.value = String(opts[0][0]);
}
/* a function that runs `fn` a little later, once, however often it is asked: later(ms) asks (350 ms unless said) */
const debounce = (fn, ms = 350) => {
  let t = 0;
  return (wait = ms) => {
    clearTimeout(t);
    t = setTimeout(fn, wait);
  };
};
/* a button's work that ends in a fresh read: the button rests meanwhile; what went wrong lands in flash */
const thenLoad = (fn) => async (b) => {
  if (b) b.disabled = true;
  try {
    await fn(b);
  } catch (err) {
    flash = String((err && err.message) || err).slice(0, 200);
  }
  await load();
};
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
/* what the page says when a request never reached the account (the service restarting, the network gone) */
const NO_ANSWER = { status: 0, body: { ok: false, error: "The account did not answer. Try again." } };
/* a JSON POST → { status, body }; a request that never reached the account answers as a refusal, so every caller shows it the same way */
const postJson = async (path, body) => {
  try {
    const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  } catch {
    return { status: NO_ANSWER.status, body: { ...NO_ANSWER.body } };
  }
};

/* a table as a CSV file the browser saves. A cell that a spreadsheet would run as a formula (one starting with = + - @ or a tab or return)
   is put behind an apostrophe and quoted, as spreadsheet exporters do; a number is left a number */
const csvCell = (c) => {
  if (typeof c === "number") return Number.isFinite(c) ? String(c) : "";
  let v = String(c ?? "");
  const formula = /^[=+\-@\t\r]/.test(v);
  if (formula) v = `'${v}`;
  return formula || /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};
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
  el.querySelector("button").addEventListener("click", () => toastOut(el));
  region.appendChild(el);
  // over an open sheet too: the stack is a popover, kept open, and raised to the top again only when a sheet opened over it since it last
  // spoke (raising re-inserts it in the top layer)
  const stack = region.parentElement;
  if (stack && stack.showPopover) {
    try {
      if (!stack.matches(":popover-open")) stack.showPopover();
      else if (toastUnder) {
        stack.hidePopover();
        stack.showPopover();
      }
      toastUnder = false;
    } catch {
      // a browser without popovers shows the stack where it is
    }
  }
  toastIn(el);
  const all = document.querySelectorAll(".toast:not([data-out])");
  if (all.length > 4) toastOut(all[0]);
  const life = ms ?? (kind === "no" ? 14000 : 6000);
  let timer = 0;
  const start = () => { if (life > 0) timer = setTimeout(() => toastOut(el), life); };
  el.addEventListener("mouseenter", () => clearTimeout(timer));
  el.addEventListener("mouseleave", start);
  el.addEventListener("focusin", () => clearTimeout(timer));
  start();
  return el;
}
/* a sheet opened over the toast stack since it last spoke (the dialogs' `open`, watched): the next toast raises the stack above it */
let toastUnder = false;
if (typeof MutationObserver === "function") {
  const under = new MutationObserver(() => void (toastUnder = toastUnder || $("modal").open || $("ask").open));
  for (const id of ["modal", "ask"]) if ($(id) && $(id).nodeType === 1) under.observe($(id), { attributes: true, attributeFilter: ["open"] });
}
/* the toasts standing above one in the stack (it is anchored at the bottom: they are the ones its coming and going moves) */
const toastsAbove = (el) => {
  const all = [...document.querySelectorAll(".toast")];
  return all.slice(0, all.indexOf(el)).filter((t) => !t.dataset.out);
};
const TOAST_EASE = "cubic-bezier(.2, .8, .2, 1)";
/* a toast comes in: it rises 16 px as it fades in (160 ms); the toasts above it, pushed up by its height, slide there from where they were
   (their distance read after layout, by a ResizeObserver, never forced) */
function toastIn(el) {
  if (still() || typeof el.animate !== "function") return;
  el.animate([{ opacity: 0, transform: "translateY(16px)" }, { opacity: 1, transform: "none" }], { duration: 160, easing: TOAST_EASE });
  const above = toastsAbove(el);
  if (!above.length || typeof ResizeObserver !== "function") return;
  const ro = new ResizeObserver((entries) => {
    ro.disconnect();
    const e = entries[0];
    const h = (e.borderBoxSize && e.borderBoxSize[0] ? e.borderBoxSize[0].blockSize : e.contentRect.height) + 8;
    for (const t of above) t.animate([{ transform: `translateY(${h}px)` }, { transform: "none" }], { duration: 160, easing: TOAST_EASE });
  });
  ro.observe(el, { box: "border-box" });
}
/* a toast goes: it fades and lifts 8 px (120 ms), then the toasts above it slide down into its place (FLIP: its height read as it starts
   to go, from a layout that is already there) */
function toastOut(el) {
  if (!el || !el.isConnected || el.dataset.out) return;
  el.dataset.out = "1";
  const h = toastsAbove(el).length ? el.offsetHeight + 8 : 0;
  const gone = () => {
    if (!el.isConnected) return;
    const above = toastsAbove(el);
    el.remove();
    if (h && !still()) for (const t of above) if (typeof t.animate === "function") t.animate([{ transform: `translateY(${-h}px)` }, { transform: "none" }], { duration: 160, easing: TOAST_EASE });
  };
  if (still() || typeof el.animate !== "function") return void gone();
  el.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(-8px)" }], { duration: 120, easing: "cubic-bezier(.4, 0, 1, 1)", fill: "forwards" }).finished.then(gone, gone);
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

/** the drawer: a side sheet on the right for one thing (an asset, a market, the menu); the page behind stays usable. It slides in with what
 * it holds now (its parts' skeletons); what its reads bring while it slides is drawn once it rests (drawerLater), and its first control
 * takes the focus then. Returns the body */
function openDrawer(html, { title = "", redraw } = {}) {
  const d = $("drawer");
  const back = DRAWER ? DRAWER.back : document.activeElement;
  const sliding = !d.open && !still();
  d.innerHTML = `${head(title, "drawer")}<div class="sheet-b">${html}</div>`;
  d.setAttribute("aria-labelledby", "drawer-title");
  const me = { redraw: redraw || null, back, sliding, later: [] };
  DRAWER = me;
  paintGen++;
  if (!d.open) d.show();
  const first = d.querySelector(".sheet-b button, .sheet-b a, .sheet-b input, .sheet-b select") || d.querySelector("[data-drawer-close]");
  // it rests: what its reads brought is drawn (in the next frame), and its first control takes the focus once that frame is drawn, so the
  // focus finds the page laid out and lays out nothing of its own
  const rest = () => {
    if (DRAWER !== me) return;
    me.sliding = false;
    for (const fn of me.later.splice(0)) fn();
    nextFrame(() => setTimeout(() => {
      if (DRAWER === me && d.open && first && first.isConnected && first.focus) first.focus({ preventScroll: true });
    }, 0));
  };
  if (sliding) afterMotion(d, 320, rest);
  else rest();
  return d.querySelector(".sheet-b");
}
/** fn now — or, while the drawer is still sliding in, once it rests (asked twice meanwhile, it runs once) */
function drawerLater(fn) {
  if (!DRAWER || !DRAWER.sliding) return void fn();
  if (!DRAWER.later.includes(fn)) DRAWER.later.push(fn);
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
/** a yes or no, over whatever is open: true only for the yes. The dialog is named by its title, or by the question itself (#ask-title) */
function confirmSheet(text, { danger = false, title = "", yes = "Yes", no = "Cancel" } = {}) {
  return asking(`<form method="dialog" class="ask-f">${title ? `<h2 id="ask-title">${esc(title)}</h2><p>${esc(text)}</p>` : `<p id="ask-title">${esc(text)}</p>`}<div class="end"><button type="submit" value="" class="btn">${esc(no)}</button><button type="submit" value="yes" class="btn ${danger ? "btn-danger" : "btn-primary"}">${esc(yes)}</button></div></form>`, (v) => v === "yes");
}
/** one of a few, over whatever is open: the value picked, or null */
function pickSheet(title, options, { current, note = "" } = {}) {
  const opts = options.map((o) => (Array.isArray(o) ? { value: o[0], label: o[1], hint: o[2] } : o));
  return asking(`<form method="dialog" class="ask-f"><h2 id="ask-title">${esc(title)}</h2>${note ? `<p class="dim small">${esc(note)}</p>` : ""}<div class="picks">${opts.map((o, i) => `<button type="submit" value="${i}"${o.disabled ? " disabled" : ""}${current !== undefined && String(o.value) === String(current) ? ' aria-current="true"' : ""}><span>${esc(o.label)}</span>${o.hint ? `<span class="dim small">${esc(o.hint)}</span>` : ""}</button>`).join("")}</div><div class="end"><button type="submit" value="" class="btn">Cancel</button></div></form>`, (v) => (v === "" || !opts[Number(v)] ? null : opts[Number(v)].value));
}

/** a signed cancel of one order (liveCancel). An agent's order is taken off the book only after a yes — the agent placed it inside a limit
 * the owner gave, or on a card the owner approved; the owner's own order goes with one click. Resolves to what own() returned, or null */
async function cancelOrder(o, then) {
  if (!o || !owns()) return null;
  if (o.authority === "agent" || o.agent) {
    const who = o.agent ? keyName(o.agent) : "an agent";
    const ok = await confirmSheet(`Cancel ${who}'s order ${o.id}? It comes off ${o.venueName || nameOf(o.venue)}'s book; the agent is told through the account.`, { title: "Cancel an agent's order", yes: "Cancel the order", no: "Keep it", danger: true });
    if (!ok) return null;
  }
  return own({ type: "liveCancel", venue: o.venue, order: o.id }, then);
}

/* the fields the owner signs, as the device key signs them (owner.js builds the signing input from these, not from the server); `notes` a
   word beside a field, by the field's name (a prediction's limit, typed in cents, read back in cents) */
const whatYouSign = (p, { open = false, notes = null } = {}) => (p && p.shown ? `<details class="signs"${open ? " open" : ""}><summary>What you sign</summary><pre>${p.shown.map((f) => `${esc(f.name)}: ${esc(f.value)}${notes && notes[f.name] ? `   <i>${esc(notes[f.name])}</i>` : ""}`).join("\n")}</pre></details>` : "");
/* a refusal at the door, the way own() reads one */
const refusedAt = (r) => !r || r.status >= 400 || !r.body || r.body.ok === false || (r.body.kind === "result" && r.body.result && r.body.result.ok === false);

/** the element's HTML written only where it changed (morphKids: the rows and words that moved, nothing else), so a redraw every twenty
 * seconds rebuilds nothing, keeps a running animation running and never drops the owner's focus to the page; the control that had the focus
 * and went is found again — by its data-fk or data-key, else by its place among the focusable controls. True when it drew */
const PAINTED = new WeakMap();
/* how many times a part was drawn: what keeps a list of elements (the countdowns) knows when to look again */
let paintGen = 0;
function paint(el, html) {
  if (!el) return false;
  if (PAINTED.get(el) === html) return false;
  const f = document.activeElement;
  const inside = !!(f && el.contains && el.contains(f));
  const key = inside && f.dataset ? f.dataset.fk || f.dataset.key || "" : "";
  const FOCUSABLE = "button, a[href], input, select, textarea, [tabindex]";
  const index = inside && !key && el.querySelectorAll ? [...el.querySelectorAll(FOCUSABLE)].indexOf(f) : -1;
  const inPlace = typeof el.isEqualNode === "function" && !!el.ownerDocument && typeof el.ownerDocument.createElement === "function";
  if (inPlace) {
    const t = el.ownerDocument.createElement("template");
    t.innerHTML = html;
    morphKids(el, t.content);
  } else el.innerHTML = html;
  PAINTED.set(el, html);
  paintGen++;
  if (!inside || !el.querySelectorAll) return true;
  // drawn in place, the control kept its place (it is the same element): nothing to give back, and nothing laid out to give it
  if (inPlace && f.isConnected && el.contains(f)) return true;
  const again = key ? [...el.querySelectorAll("[data-fk], [data-key]")].find((x) => (x.dataset.fk || x.dataset.key) === key) : index >= 0 ? el.querySelectorAll(FOCUSABLE)[index] : null;
  if (again && again.focus) again.focus({ preventScroll: true });
  return true;
}
/* a child's key among its siblings: a row or a card by what it is (data-k), else by the key the page already names it with (data-key) */
const morphKey = (n) => (n.nodeType === 1 ? n.getAttribute("data-k") || n.getAttribute("data-key") || "" : "");
const morphSame = (a, b) => a.nodeType === b.nodeType && (a.nodeType !== 1 || (a.localName === b.localName && a.namespaceURI === b.namespaceURI));
/* a node moved among its siblings keeps its state (the focus, a running animation) where the browser can move it so */
function morphMove(el, node, before) {
  if (typeof el.moveBefore === "function") {
    try {
      return void el.moveBefore(node, before);
    } catch {
      // a browser that cannot move it here: inserted (the focus, if it was in it, is found again by paint)
    }
  }
  el.insertBefore(node, before);
}
/* el's children made to be `to`'s (a template's content, whose nodes are taken as they are needed): kept by key or by place, the rest
   inserted, what is left over removed */
function morphKids(el, to) {
  const keyed = new Map();
  for (let c = el.firstChild; c; c = c.nextSibling) {
    const k = morphKey(c);
    if (k && !keyed.has(k)) keyed.set(k, c);
  }
  let at = el.firstChild;
  for (let n = to.firstChild; n; ) {
    const next = n.nextSibling;
    const k = morphKey(n);
    let m = null;
    if (k) {
      m = keyed.get(k) || null;
      if (m) keyed.delete(k);
      if (m && !morphSame(m, n)) m = null;
    } else if (at && !morphKey(at) && morphSame(at, n)) m = at;
    if (m) {
      if (m === at) at = at.nextSibling;
      else morphMove(el, m, at);
      morphNode(m, n);
    } else el.insertBefore(n, at);
    n = next;
  }
  while (at) {
    const x = at.nextSibling;
    el.removeChild(at);
    at = x;
  }
}
/* one node made to be another of its kind: a text by its words; an element by its attributes, then its children — unless the two are equal
   already (the browser compares them whole). A field the owner may have changed is drawn afresh when it was drawn differently (as a
   rebuild would), unless the owner is in it */
function morphNode(old, neu) {
  if (old.nodeType !== 1) {
    if (old.nodeValue !== neu.nodeValue) old.nodeValue = neu.nodeValue;
    return;
  }
  if (old.isEqualNode(neu)) return;
  if ((old.localName === "input" || old.localName === "select" || old.localName === "textarea") && old !== document.activeElement) return void old.replaceWith(neu);
  // what was painted into it on its own is no longer what it shows
  PAINTED.delete(old);
  const na = neu.attributes;
  for (let i = 0; i < na.length; i++) if (old.getAttribute(na[i].name) !== na[i].value) old.setAttribute(na[i].name, na[i].value);
  const oa = old.attributes;
  for (let i = oa.length - 1; i >= 0; i--) if (!neu.hasAttribute(oa[i].name)) old.removeAttribute(oa[i].name);
  morphKids(old, neu);
}

/* an element's words set in place: its one text node changed (the browser re-lays the words only), else its text replaced */
function setText(el, t) {
  const n = el.firstChild;
  if (n && n.nodeType === 3 && !n.nextSibling) {
    if (n.nodeValue !== t) n.nodeValue = t;
  } else if (el.textContent !== t) el.textContent = t;
}

// ---- time and motion ------------------------------------------------------------------------

/* the next frame, or at once where there are no frames (a page without a window) */
const nextFrame = (fn) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(fn) : fn());
/* the owner asked for no motion: every transition is a cut */
const STILL = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
const still = () => !!(STILL && STILL.matches);
/** fn once `el`'s own transition or animation has ended — `ms` later at the most, at once when nothing moves */
function afterMotion(el, ms, fn) {
  let done = false;
  let t = 0;
  const end = (e) => {
    if (done || (e && e.target !== el)) return;
    done = true;
    clearTimeout(t);
    el.removeEventListener("transitionend", end);
    el.removeEventListener("animationend", end);
    fn();
  };
  if (still() || !el || !el.addEventListener) return void fn();
  el.addEventListener("transitionend", end);
  el.addEventListener("animationend", end);
  t = setTimeout(end, ms);
}
/* the one clock: what counts down or ages on the page is looked at once a second as the second turns over, and what changed is written
   together in one frame — one layout at most, and no frame at all in a second where nothing changed; while the page scrolls it waits for
   the scroll to rest (a scroll's frames are the compositor's, and stay so) */
const SECOND = { fns: new Set(), timer: 0, scrolledAt: 0, scrolling: false };
/* the page is scrolling: from a scroll event to its scrollend (a glide of the compositor's sends few scroll events and one scrollend), and
   for 150 ms after the last scroll event where a browser has no scrollend */
const scrollingNow = () => SECOND.scrolling || Date.now() - SECOND.scrolledAt < 150;
function everySecond(fn) {
  SECOND.fns.add(fn);
  secondArm();
  return () => void SECOND.fns.delete(fn);
}
function secondArm() {
  if (SECOND.timer || !SECOND.fns.size) return;
  // a page without frames ticks on a plain interval (none at all where there is no clock)
  if (typeof requestAnimationFrame !== "function") return void (SECOND.timer = setInterval(secondRun, 1000) || -1);
  SECOND.timer = setTimeout(secondRun, 1004 - (Date.now() % 1000));
}
function secondRun() {
  if (typeof requestAnimationFrame === "function") {
    SECOND.timer = 0;
    // a scroll under way: asked again once it rests
    if (scrollingNow()) return void (SECOND.timer = setTimeout(secondRun, 160));
  }
  const writes = [];
  for (const fn of [...SECOND.fns]) {
    try {
      const w = fn();
      if (w === false) SECOND.fns.delete(fn);
      else if (typeof w === "function") writes.push(w);
    } catch (err) {
      SECOND.fns.delete(fn);
      console.error(err);
    }
  }
  if (writes.length) nextFrame(() => {
    for (const w of writes) {
      try {
        w();
      } catch (err) {
        console.error(err);
      }
    }
  });
  secondArm();
}
/** fn once the page is not scrolling (now, when it is not): a timer's writes wait for the scroll to rest */
function whenStill(fn) {
  if (!scrollingNow()) return void fn();
  setTimeout(() => whenStill(fn), 160);
}
/* a pane coming in (shell.js paneIn, 180 ms) draws what a read brought meanwhile once it has come in: its surface is never redrawn in the
   middle of its own entrance. paneLater(tab, fn): fn now, or then (asked twice meanwhile, once) */
const PANE_IN = new Map();
function paneLater(tab, fn) {
  const coming = PANE_IN.get(tab);
  if (!coming) return void fn();
  if (!coming.later.includes(fn)) coming.later.push(fn);
}
/* while the page scrolls, what passes under a resting pointer changes at once: the hover fades (shell.css) are for a pointer that moves,
   and a fade per row under it would be main-thread frames in the middle of the compositor's scroll. html.scrolling, from the scroll's first
   event until 150 ms after its last scroll or scrollend (so a wheel's glides one after another keep it on, and it is set and taken off once) */
let scrollRest = 0;
let scrollEndLate = 0;
const scrollSeen = () => {
  SECOND.scrolledAt = Date.now();
  if (!scrollRest) document.documentElement.classList.add("scrolling");
  clearTimeout(scrollRest);
  scrollRest = setTimeout(() => {
    scrollRest = 0;
    document.documentElement.classList.remove("scrolling");
  }, 150);
};
if (typeof addEventListener === "function") {
  const ends = typeof window !== "undefined" && "onscrollend" in window;
  addEventListener("scroll", () => {
    // from a scroll to its scrollend the clock waits (a glide sends few scroll events); one whose end never came, two seconds at the most
    if (ends) {
      SECOND.scrolling = true;
      clearTimeout(scrollEndLate);
      scrollEndLate = setTimeout(() => void (SECOND.scrolling = false), 2000);
    }
    scrollSeen();
  }, { passive: true, capture: true });
  if (ends) addEventListener("scrollend", () => {
    SECOND.scrolling = false;
    clearTimeout(scrollEndLate);
    scrollSeen();
  }, { passive: true, capture: true });
}

/** prepare → show → sign and send, in one sheet. The account prepares the exact action from what is typed (asked again as it changes; the
 * latest ask wins), shows it in words with what is signed, and the signature is good for ten minutes — asked again when they run out */
function quoteDialog({ title, sub = "", fields = "", draft, show, block, done, signNotes, go = "Sign and send", wide = false }) {
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
  let stopLeft = () => {};
  const say = (text, state = "") => { msg.className = `msg${text && state ? ` ${state}` : ""}`; msg.textContent = text || ""; };
  // the signature's minutes, on the page's one clock: false stops it; a change is written in the clock's frame
  const left = () => {
    const el = box.querySelector("[data-left]");
    if (!form.isConnected || !prepared || !el) return false;
    const ms = prepared.action.deadline - Date.now();
    if (ms <= 0) return void requote();
    const t = `Your signature is good for ${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")} more.`;
    if (el.textContent !== t) return () => setText(el, t);
  };
  const requote = async () => {
    if (!form.isConnected) return;
    const my = ++seq;
    prepared = null;
    btn.disabled = true;
    sign.innerHTML = "";
    refuse("");
    stopLeft();
    const d = draft(form);
    if (!d || typeof d === "string") return void (box.innerHTML = `<span class="dim">${esc(d || "Fill it in to see what it would be.")}</span>`);
    box.innerHTML = '<span class="dim">Asking…</span>';
    const r = await Owner.prepare(d);
    if (!form.isConnected || my !== seq) return;
    if (r.status !== 200) return void (box.innerHTML = `<div class="msg no">${esc(Owner.why(r) || "Refused")}</div>`);
    prepared = r.body;
    box.innerHTML = `${show ? show(prepared, form) : `<div class="big"><span>${esc((prepared.quote && prepared.quote.words) || prepared.action.type)}</span></div>`}${prepared.action.deadline ? '<div class="left-t" data-left></div>' : ""}`;
    sign.innerHTML = whatYouSign(prepared, { notes: signNotes ? signNotes(prepared, form) : null });
    const no = block ? block(prepared, form) : "";
    refuse(no);
    btn.disabled = !owns() || !!no;
    if (prepared.action.deadline) {
      const now = left();
      if (typeof now === "function") now();
      stopLeft = everySecond(left);
    }
  };
  const later = debounce(requote);
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
const canMove = (v) => writesOn() && !!v.liveCan && !v.readOnlyBecause && !watched(v) && (v.liveCan.withdraw !== false || ((v.liveCan.ledgers || []).length > 1 && v.liveCan.transfer !== false) || v.liveCan.swap !== false || !!v.liveCan.send);
/* WHERE THIS USER CAN CONNECT, as the account judged it from the network it runs on (GET /api/account/venues, live/availability.ts): each
   venue's own answer to that network, and its own terms matched to where the user is (never named). Read when the page is idle and again
   when older than ten minutes; Markets, Trade and the list of accounts read it before offering "Connect to trade", so a venue that would
   refuse is never offered — its words are said instead. connector → { name, verdict, said, terms, needs, group, connected } */
const VENUES = new Map();
let venuesRead = 0;
async function readVenues(force = false) {
  if (!force && venuesRead && Date.now() - venuesRead < 600_000) return VENUES;
  const got = await api(`/api/account/venues${force ? "?force=1" : ""}`);
  if (got && Array.isArray(got.venues)) {
    VENUES.clear();
    for (const v of got.venues) VENUES.set(v.connector, v);
    venuesRead = Date.now();
  }
  return VENUES;
}
/* a venue that would refuse the user if connected — it does not serve this network, needs something on this machine first, or offers no
   way in: its word and its own words; null when it would take the user or was not judged */
const VENUE_NO = { "not-served": "Not served here", closed: "No way in here", setup: "Set up first" };
function venueRefuses(connector) {
  const v = connector && VENUES.get(connector);
  return v && VENUE_NO[v.verdict] ? { word: VENUE_NO[v.verdict], name: v.name, said: v.said || "", verdict: v.verdict } : null;
}
/* a venue whose own published terms exclude where the user is: said, never enforced — connecting is still offered, because the venue's
   own sign-up checks residency; null otherwise */
function venueTermsSay(connector) {
  const v = connector && VENUES.get(connector);
  return v && v.verdict === "terms-exclude" ? { word: "Its terms exclude where you are", name: v.name, said: v.said || "" } : null;
}
/* a venue's own words for why nothing is placed there from here: what it or its key said, else what its way in gives */
const readOnlyWords = (v) => (v.readOnlyBecause || v.noTradeBecause || (v.watchOnly ? "a watched address: nothing is traded or sent from it" : "") || `${v.via || "its connection"} gives no interface for orders here`);

// ---- a browser wallet sending what the account built ----------------------------------------

/** the wallet each proven address was proven with, while this page is open */
const PROVIDERS = new Map();
/** what a wallet has already sent, by a key no other run of the account reuses (an order's client id; a payment's id and time), while this
   page is open; the account itself keeps the hash once it has been reported */
const SENT = new Map();
/** payments and orders whose wallet flow is running in this page: never two at once for one */
const INFLIGHT = new Set();
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
/* writes are on, the venue is written, but this key lets nothing leave it: it can still receive */
const keyOnlyReads = (v) => writesOn() && !!v.liveCan && !v.readOnlyBecause && !watched(v) && !canMove(v);
