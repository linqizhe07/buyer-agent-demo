/* Markets: what there is to trade — at the venues the owner connected, and (read without a key, "Connect to trade") at the venues not
   connected — from GET /api/account/explore, in the tabs it returns; what closes soon as Yes/No cards whose prices are asked again only while
   a card is in view and the page is in view (GET /api/account/quotes); the movers; the most traded; what the owner watches; one market in
   the drawer (its price, its history, every venue's price for it, what is held, what the agents are doing in it); and the Venues board: each
   connected venue's health, whether agents may act there, and the catalogue to connect another.
   Every button does what it says through the account's own door: an order opens the ticket and is signed there; ★ is a signed setWatch;
   "Open to agents" closes for free (POST /api/revoke) and reopens signed (setPolicy restore); "Connect to trade" opens that connection's own
   form; Disconnect is a signed disconnectVenue. Where a venue refuses, its own words are shown, and what fixes it. Nothing here is a sample. */

/* what the pane holds between draws: the shell's last ctx; each explore read by its path ({ at, body, good, pending }); the rows drawn, by
   their data-i; fresh prices by "venue|symbol"; the cards in view; the market in the drawer */
const MKT = { ctx: null, got: new Map(), good: null, reg: [], quotes: new Map(), seen: new Set(), io: null, poll: 0, tick: 0, el: null, open: null, drawerWired: false };
/* an explore read is asked again after this long, when the pane is drawn (the account keeps the same answer thirty seconds) */
const MKT_TTL = 20_000;
/* how often the cards in view, and the market in the drawer, ask for a fresh price; how long one is shown as fresh */
const MKT_POLL_MS = 5_000;
const MKT_FRESH_MS = 30_000;
/* the explore tabs the account knows (it returns only those with something in them), and the pane's own two */
const MKT_TAB_IDS = ["now", "crypto", "stocks", "rwas", "predictions", "perps", "macro", "sports"];
const MKT_SORTS = ["volume", "movers", "closing"];
const MKT_KIND = { coin: "Crypto", stock: "Stock", perp: "Perpetual", rwa: "Tokenized asset", event: "Prediction" };
/* every market at once, for the Watching tab and for a market asked for by name */
const MKT_ALL = "/api/account/explore?limit=200";
const MKT_PAINTED = new WeakMap();

// ---- words and numbers -------------------------------------------------------------------------------

/* a price in dollars: cents for a dollar or more, the first four figures below that */
const mkUsd = (n) => (n === undefined || n === null || n === "" || !Number.isFinite(Number(n)) ? "—" : Math.abs(Number(n)) >= 1 ? money(n) : `$${px(Number(Number(n).toPrecision(4)))}`);
/* dollars traded, short: $1.9B · $120M · $880k */
function mkVol(n) {
  if (n === undefined || n === null || n === "" || !Number.isFinite(Number(n))) return "—";
  const a = Math.abs(Number(n));
  const [d, s] = a >= 1e9 ? [1e9, "B"] : a >= 1e6 ? [1e6, "M"] : a >= 1e3 ? [1e3, "k"] : [1, ""];
  const v = Number(n) / d;
  return `$${s ? (Math.abs(v) >= 100 ? v.toFixed(0) : String(Number(v.toFixed(1)))) : String(Math.round(v))}${s}`;
}
/* a count, short: 12.3k contracts */
const mkCount = (n) => mkVol(n).slice(1);
/* an event contract's price, which is its probability, in cents: 62¢; under a cent as it is (0.4¢) */
function mkCents(p) {
  if (p === undefined || p === null || p === "" || !Number.isFinite(Number(p))) return "—";
  const c = Number(p) * 100;
  return `${c >= 1 || c === 0 ? Math.round(c) : Number(c.toFixed(1))}¢`;
}
/* how long until it closes: 2d 04:12 · 06:48:10; "Closed" once the time has passed */
function mkLeft(ms) {
  if (!(ms > 0)) return "Closed";
  const s = Math.floor(ms / 1000);
  const p2 = (x) => String(x).padStart(2, "0");
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `Closes in ${d}d ${p2(h)}:${p2(m)}` : `Closes in ${p2(h)}:${p2(m)}:${p2(s % 60)}`;
}
/* an outcome as a person says it: YES → Yes, UP → Up; a named outcome as it is */
const mkLabel = (l) => { const s = String(l || ""); return s.length <= 5 && s === s.toUpperCase() ? s.charAt(0) + s.slice(1).toLowerCase() : s; };
/* a sentence from a venue, without its last full stop (it is put inside one of ours) */
const mkSaid = (t) => String(t || "").trim().replace(/[.\s]+$/, "");
/* one price from a fresh market, by what the element shows: "c" a contract's price in cents (the ask where there is one: what a buy pays),
   "usd" a price, "bid" / "ask" in dollars, "bid-c" / "ask-c" in cents */
function mkFmt(m, fmt = "c") {
  const pick = { c: m.ask ?? m.price, "c-last": m.price ?? m.ask, usd: m.price ?? m.ask, bid: m.bid, ask: m.ask, "bid-c": m.bid, "ask-c": m.ask }[fmt];
  return ["c", "c-last", "bid-c", "ask-c"].includes(fmt) ? mkCents(pick) : mkUsd(pick);
}

// ---- what a row is, and what can be done with it --------------------------------------------------------

const mkVenue = (id) => (A ? A.venues.find((v) => v.id === id && v.live) : undefined);
/* a fresh price for a market at a connected venue, while it is fresh */
const mkFresh = (pair) => { const q = MKT.quotes.get(pair); return q && Date.now() - q.at < MKT_FRESH_MS ? q.market : null; };
/* the markets one row is, venue by venue: an outcome's, when one is named, or the row's own */
const mkLegs = (item, oi) => (oi !== undefined && item.outcomes && item.outcomes[oi] ? item.outcomes[oi].at : item.at.map((a) => ({ venue: a.venue, symbol: a.symbol })));
const mkAtOf = (item, venue) => item.at.find((a) => a.venue === venue) || { venue, venueName: venue, symbol: "", connected: false, canTrade: false, public: false };
/* a market's legs at the venues connected live, as "venue|symbol": what the quotes read asks for */
const mkPairsOf = (item, oi) => mkLegs(item, oi).filter((l) => mkVenue(l.venue)).map((l) => `${l.venue}|${l.symbol}`);
const mkAllPairs = (item) => [...new Set(item.kind === "event" && item.outcomes ? item.outcomes.flatMap((o, oi) => mkPairsOf(item, oi)) : mkPairsOf(item))];
/* the first leg at a connected venue: whose fresh price the drawer shows */
const mkLeadLeg = (item, oi) => mkLegs(item, oi).find((l) => mkVenue(l.venue)) || null;

/** why a connected venue takes no order for it — the venue's words where it gave some — and what fixes it */
function mkWhyNot(v, a) {
  const w = A.connectLive && A.connectLive.writes;
  if (!writesOn()) return `Trading is off on this server${w && w.turnOn ? `: start it with ${w.turnOn}` : ""}.`;
  if (watched(v)) return `${v.name} is a watched address: nothing is traded from it. Connect it as a browser wallet, which signs to show it is yours, to trade from it.`;
  if (a.open === false) return `${v.name}: ${mkSaid(a.note) || "the market is closed now"}.`;
  if (v.trade && v.trade.can === false) return `${v.name}: ${mkSaid(a.note) || "this key can't trade"}. ${keyHowFor(v)} Then connect it again.`;
  if (v.noTradeBecause) return `${v.name}: ${mkSaid(v.noTradeBecause)}.`;
  return `${v.name}: ${mkSaid(a.note) || "no order is placed here from the account"}.`;
}

/** what a Buy (or one outcome's button) does for a row: an order at the first connected venue that takes one; else "Connect to trade" at
 * a venue whose public prices list it; else why not, in the venue's words */
function mkRoute(item, oi) {
  if (!A) return { act: "why", text: "" };
  // a server started read-only places nothing anywhere: connecting another venue would not change that
  if (!writesOn()) return { act: "why", text: mkWhyNot({}, {}) };
  let refused = null;
  for (const l of mkLegs(item, oi)) {
    const v = mkVenue(l.venue);
    if (!v) continue;
    const a = mkAtOf(item, l.venue);
    if (canTrade(v) && a.canTrade !== false && a.open !== false) return { act: "trade", venue: v.id, symbol: l.symbol, venueName: v.name };
    refused = refused || { venue: v.id, text: mkWhyNot(v, a) };
  }
  const pub = item.at.find((a) => a.public && a.connector && connectionOf(a.connector));
  if (pub) return { act: "connect", connector: pub.connector, venue: pub.connectTo || "", venueName: pub.venueName, note: pub.note || "" };
  if (refused) return { act: "why", venue: refused.venue, text: refused.text };
  const p0 = item.at.find((a) => a.public);
  return { act: "why", text: p0 ? (p0.note ? `${p0.venueName}: ${mkSaid(p0.note)}.` : `This server can't connect ${p0.venueName}.`) : "No venue on the account trades it." };
}

/* a public listing's market is watched under the venue it would be once connected */
const mkVenueOfLeg = (item, venue) => { const a = mkAtOf(item, venue); return a.public && a.connectTo ? a.connectTo : venue; };
/* a watchlist entry is one of this row's markets (any venue, any outcome) */
const mkIsWatch = (item, w) => [...item.at.map((a) => ({ venue: a.venue, symbol: a.symbol })), ...(item.outcomes || []).flatMap((o) => o.at)].some((l) => l.symbol === w.symbol && (l.venue === w.venue || mkVenueOfLeg(item, l.venue) === w.venue));
/** the watchlist entry this row is, if the owner watches it */
const mkWatchEntry = (item) => (A && A.watch ? A.watch.find((w) => mkIsWatch(item, w)) || null : null);
/** what ★ watches for a row: its market at the first connected venue, else at the venue its public prices come from */
function mkWatchTarget(item) {
  const c = item.at.find((a) => a.connected);
  if (c) return { venue: c.venue, symbol: c.symbol };
  const p = item.at.find((a) => a.public && a.connectTo);
  return p ? { venue: p.connectTo, symbol: p.symbol } : null;
}
/** the watchlist change one ★ signs: off for the entry that is watched, on for the row's first venue; null when there is nothing to name */
function mkWatchDraft(item) {
  const w = mkWatchEntry(item);
  if (w) return { type: "setWatch", venue: w.venue, symbol: w.symbol, on: "" };
  const t = mkWatchTarget(item);
  return t ? { type: "setWatch", venue: t.venue, symbol: t.symbol, on: "true" } : null;
}
/** the asset the Asset read knows it as (its price history, what is held, its orders): a coin or a perpetual's coin, a share, a token, an
 * event contract at a connected venue */
function mkAssetKey(item) {
  const base = String(item.base || "").toUpperCase();
  if (item.kind === "coin" || item.kind === "perp") return base ? `crypto:${base}` : "";
  if (item.kind === "stock") return base ? `equity:${base}` : "";
  if (item.kind === "rwa") return base ? `rwa:${base}` : "";
  if (item.kind === "event") {
    const c = item.at.find((a) => a.connected);
    return c ? `event:${c.symbol}` : "";
  }
  return "";
}
/** what the agents are doing in it: their open orders, their cards waiting on the owner, the owner's intents about it */
function mkAgentsOn(item) {
  if (!A) return { orders: [], cards: [], intents: [] };
  const syms = new Set([...item.at.map((a) => a.symbol), ...(item.outcomes || []).flatMap((o) => o.at.map((x) => x.symbol))]);
  const base = item.kind === "event" ? "" : String(item.base || "").toUpperCase();
  const hit = (sym) => syms.has(sym) || (!!base && String(sym || "").split("/")[0].toUpperCase() === base);
  const shown = (c, n) => ((c.shown || []).find((x) => x.name === n) || {}).value || "";
  return {
    orders: A.orders.filter((o) => o.agent && ["open", "partial", "pending"].includes(o.status) && (hit(o.symbol) || (!!base && String(o.base || "").toUpperCase() === base))),
    cards: A.cards.filter((c) => c.agent && hit(shown(c, "symbol"))),
    intents: (A.intents || []).filter((x) => hit(x.symbol)),
  };
}
/* the lens narrows Markets to one venue's markets; under an agent's lens every market stays (agents hold no markets of their own) */
const mkInLens = (item, lens) => !lens || lens.kind !== "venue" || item.at.some((a) => a.venue === lens.id || a.connectTo === lens.id);

/* the venues that did not answer this read, each in its own words (a venue's rule for this location is said as its rule, nothing more) */
function mkMissingLine(missing) {
  const seen = new Set();
  const list = (missing || []).filter((m) => !m.symbol && !seen.has(m.venue) && seen.add(m.venue));
  if (!list.length) return "";
  const one = (m) => `<b>${esc(m.venueName)}</b>: ${m.said ? `“${esc(mkSaid(m.said))}”${m.code === "E_VENUE_GEOBLOCKED" ? " — its own rule for this location" : ""}` : esc(mkSaid(m.why))}`;
  return `<p class="mk-missing">Not shown: ${list.map(one).join(" · ")}.</p>`;
}

// ---- drawing -----------------------------------------------------------------------------------------

/** who stands behind a tokenised asset and whom it is for, in the issuer's own words: the row's, else the first listing that carries them;
 * null for anything else */
function mkIssuer(item) {
  const a = ((item && item.at) || []).find((x) => x.issuer || x.eligibility) || {};
  const issuer = (item && item.issuer) || a.issuer || "";
  const eligibility = (item && item.eligibility) || a.eligibility || "";
  return issuer || eligibility ? { issuer, eligibility } : null;
}
/* the issuer's words, short enough for a row (all of them in the title, and in the drawer) */
const mkClip = (t, n = 72) => { const s = String(t || "").trim(); return s.length > n ? `${s.slice(0, n - 1).replace(/\s+\S*$/, "")}…` : s; };
/* a row's issuer line: who issues it, and the start of whom it is for */
function mkIssuerLine(item) {
  const i = mkIssuer(item);
  if (!i) return "";
  const all = [i.issuer ? `Issued by ${i.issuer}` : "", i.eligibility].filter(Boolean).join(" · ");
  return `<span class="mk-iss" title="${esc(all)}">${esc([i.issuer ? `Issued by ${i.issuer}` : "", mkClip(i.eligibility, i.issuer ? 56 : 72)].filter(Boolean).join(" · "))}</span>`;
}

/* a row's letter tile: its symbol; an event's, the venue's word for what it is about */
const mkAv = (item, size = "") => avatar(item.kind === "event" ? String(item.category || "Event").slice(0, 4) : item.base || item.name, size);
/* the line under a market's name: its symbol, what kind of thing it is */
const mkSub = (item) => (item.kind === "perp" ? (/perp/i.test(item.name) ? item.base || "" : `${item.base || ""} · Perpetual`) : item.base && item.base !== item.name ? item.base : MKT_KIND[item.kind] || "");
/* a row, by its place in what was drawn (data-i) */
const mkReg = (item) => MKT.reg.push(item) - 1;
const mkPublicOnly = (item) => !item.at.some((a) => a.connected);
/* a toggle drawn the same way every time (seg() numbers itself, which would redraw the pane on every read) */
const mkSeg = (items, on, act, label) => `<div class="seg" role="group" aria-label="${esc(label)}">${items.map(([v, l]) => `<button type="button" data-act="${act}" data-v="${esc(v)}" data-fk="${act}:${esc(v)}" aria-pressed="${String(v === on)}">${esc(l)}</button>`).join("")}</div>`;
const mkDis = () => (owns() ? "" : ' disabled title="Only a browser that signs for the owner can do this"');

function mkStar(item, i) {
  const on = !!mkWatchEntry(item);
  const can = on || !!mkWatchTarget(item);
  return can ? `<button type="button" class="icon-btn mk-star" data-act="watch" data-i="${i}" data-fk="watch:${esc(item.key)}" aria-pressed="${String(on)}" aria-label="${on ? "Stop watching" : "Watch"} ${esc(item.name)}"${mkDis()}>${icon("star")}</button>` : "";
}
/* where a row is listed: the connected venues, then the public ones (read without a key) */
function mkWhere(item) {
  const seen = new Set();
  const at = [...item.at.filter((a) => a.connected), ...item.at.filter((a) => !a.connected)].filter((a) => !seen.has(a.venueName) && seen.add(a.venueName));
  return `<span class="mk-where">${at.map((a) => (a.connected ? esc(a.venueName) : `<span class="pub" title="Public prices, read without a key">${esc(a.venueName)}</span>`)).join(" · ")}</span>`;
}
/* the same, as a line under the market's name: drawn in place of the Where column when the window is too narrow for it (markets.css) */
const mkWhereLine = (item) => `<div class="mk-where-l">${mkWhere(item)}</div>`;
/* the buttons on a row: Trade and Hand to agent where an order can go, Connect to trade where only public prices list it, else why not */
function mkActs(item, i) {
  const r = mkRoute(item);
  const k = esc(item.key);
  if (r.act === "trade") return `<div class="acts"><button type="button" class="btn btn-sm" data-act="trade" data-i="${i}" data-fk="trade:${k}"${mkDis()}>Trade</button>${typeof openHandToAgent === "function" ? `<button type="button" class="btn btn-sm" data-act="hand" data-i="${i}" data-fk="hand:${k}"${mkDis()}>Hand to agent</button>` : ""}</div>`;
  if (r.act === "connect") return `<div class="acts"><button type="button" class="btn btn-sm" data-act="connect" data-connector="${esc(r.connector)}" data-name="${esc(r.venueName)}" data-fk="connect:${k}"${mkDis()}>${icon("plug", "sm")}Connect to trade</button></div>`;
  return `<div class="acts"><button type="button" class="link dim mk-why" data-act="open" data-i="${i}" data-fk="why:${k}" title="${esc(r.text)}">Can't trade here · why</button></div>`;
}
/* a row's price now: the fresh one from its venue when there is one, else what the explore read said */
function mkPriceOf(item) {
  const lead = mkLeadLeg(item);
  const m = lead && mkFresh(`${lead.venue}|${lead.symbol}`);
  return m && (m.price ?? m.ask) !== undefined ? (m.price ?? m.ask) : item.price;
}
function mkTable(items, empty) {
  const cols = [
    { label: "", sr: "Watch", cell: (x) => mkStar(x.item, x.i) },
    { label: "Market", cls: "mk-c-name", cell: (x) => `<button type="button" class="mk-name" data-act="open" data-i="${x.i}" data-fk="open:${esc(x.item.key)}">${mkAv(x.item)}<span><b>${esc(x.item.name)}</b><span class="dim">${esc(mkSub(x.item))}</span>${mkIssuerLine(x.item)}</span></button>${mkWhereLine(x.item)}` },
    { label: "Where", cls: "mk-c-where", cell: (x) => mkWhere(x.item) },
    { label: "Price", r: true, cell: (x) => { const l = mkLeadLeg(x.item); return `<span${l ? ` data-q="${esc(`${l.venue}|${l.symbol}`)}" data-fmt="usd"` : ""}>${mkUsd(mkPriceOf(x.item))}</span>`; } },
    { label: "24h", r: true, cell: (x) => chg(x.item.changePct24h) },
    { label: "Volume", r: true, cell: (x) => mkVol(x.item.volumeUsd24h) },
    { label: "", sr: "Actions", r: true, cell: (x) => mkActs(x.item, x.i) },
  ];
  return table(cols, items.map((item) => ({ item, i: mkReg(item) })), { empty, cls: "mk-t" });
}

/* one outcome's button on a card: what a buy pays now, in cents; it trades, or connects, or says why not */
function mkYn(item, i, o, oi) {
  const leg = mkLeadLeg(item, oi);
  const m = leg && mkFresh(`${leg.venue}|${leg.symbol}`);
  const r = mkRoute(item, oi);
  const label = mkLabel(o.label);
  const after = r.act === "connect" ? `: connect ${r.venueName} to trade` : r.act === "why" ? ": can't be traded here" : "";
  return `<button type="button" class="${oi === 0 ? "yes" : "no-btn"}" data-act="yn" data-i="${i}" data-o="${oi}" data-fk="yn:${esc(item.key)}:${oi}"${r.act !== "why" ? mkDis() : ""}>${esc(label)} · <span${leg ? ` data-q="${esc(`${leg.venue}|${leg.symbol}`)}" data-fmt="c"` : ""}>${mkCents(m ? m.ask ?? m.price : o.ask ?? o.price)}</span>${after ? `<span class="sr">${esc(after)}</span>` : ""}</button>`;
}
/* an event as a card: where, how much traded, a live countdown, the question, and its first two outcomes to buy */
function mkCard(item) {
  const i = mkReg(item);
  const outs = (item.outcomes || []).slice(0, 2);
  const pairs = mkAllPairs(item);
  const names = [...new Set(item.at.map((a) => a.venueName))].slice(0, 2).join(" · ");
  const vol = item.volumeUsd24h !== undefined ? `${mkVol(item.volumeUsd24h)} vol` : item.contracts24h !== undefined ? `${mkCount(item.contracts24h)} contracts` : "";
  const left = item.closeTime ? Date.parse(item.closeTime) - Date.now() : NaN;
  const more = (item.outcomes || []).length - outs.length;
  return `<div class="box mk-card"${pairs.length ? ` data-pairs="${esc(pairs.slice(0, 4).join(","))}"` : ""}><div class="mk-card-top"><span class="dim">${esc([names, vol].filter(Boolean).join(" · "))}${mkPublicOnly(item) ? ' <span class="tag">Connect to trade</span>' : ""}</span>${item.closeTime ? `<span class="mk-close" data-close="${esc(item.closeTime)}"${left > 0 ? "" : " data-closed"}>${esc(mkLeft(left))}</span>` : ""}</div><button type="button" class="mk-card-q" data-act="open" data-i="${i}" data-fk="open:${esc(item.key)}">${esc(item.name)}</button><div class="mk-card-foot">${outs.length ? `<div class="mk-yn">${outs.map((o, oi) => mkYn(item, i, o, oi)).join("")}</div>` : ""}${more > 0 ? `<button type="button" class="link dim" data-act="open" data-i="${i}" data-fk="more:${esc(item.key)}">${plural(more, "more outcome")}</button>` : ""}</div></div>`;
}
const mkCards = (items) => `<div class="cards-grid mk-cards">${items.map(mkCard).join("")}</div>`;
/* a mover: its letter tile, its name, its 24 hours, the venue that says it */
function mkChip(item) {
  const i = mkReg(item);
  return `<button type="button" class="mk-chip" data-act="open" data-i="${i}" data-fk="chip:${esc(item.key)}">${avatar(item.base || item.name, "sm")}<b>${esc(item.base || item.name)}${item.kind === "perp" ? ' <span class="tag">Perp</span>' : ""}</b>${chg(item.changePct24h)}${item.changeFrom ? `<span class="v">${esc(item.changeFrom.venueName)}</span>` : ""}</button>`;
}
const mkSkelCards = (n) => `<div class="cards-grid" aria-hidden="true">${Array.from({ length: n }, () => '<div class="box mk-card"><span class="skel" style="width:50%"></span><span class="skel" style="height:36px"></span><span class="skel" style="height:44px"></span></div>').join("")}</div>`;
const mkSkel = () => `<div class="mk-block" aria-busy="true"><span class="sr" role="status">Reading the markets…</span>${mkSkelCards(3)}<div class="skel-rows" aria-hidden="true"><span class="skel"></span><span class="skel"></span><span class="skel"></span><span class="skel" style="width:60%"></span></div></div>`;

/* the tabs: the ones the explore read returned, "All results" while searching, then Watching (when anything is watched) and Venues */
function mkTabs(p, body) {
  const items = [...(p.q ? [["", "All results"]] : []), ...((body && body.tabs) || []).map((t) => [t.id, t.label]), ...((A.watch || []).length ? [["watching", "Watching"]] : []), ["venues", "Venues"]];
  return `<div class="tabs mk-tabs" role="group" aria-label="Markets">${items.map(([id, l]) => `<button type="button" data-act="tab" data-tab="${esc(id)}" data-fk="tab:${esc(id)}" aria-pressed="${String(id === p.tab)}">${esc(l)}</button>`).join("")}</div>`;
}

/* one chip a thing: two movers of one base (BTC spot and BTC's perpetual) keep the first, which moved most */
const mkOnePerBase = (items) => { const seen = new Set(); return items.filter((x) => { const b = String(x.base || x.key).toUpperCase(); return !seen.has(b) && seen.add(b); }); };
/* Now: what closes soon, what moves, what trades most */
function mkNowHtml(body, lens) {
  const closing = body.closing.filter((x) => mkInLens(x, lens)).slice(0, 6);
  const movers = mkOnePerBase(body.movers.filter((x) => mkInLens(x, lens)));
  const traded = body.mostTraded.filter((x) => mkInLens(x, lens));
  const preds = body.tabs.some((t) => t.id === "predictions");
  const out = [];
  if (closing.length) out.push(`<section class="mk-block" aria-labelledby="mk-h-closing"><div class="sec-head"><h2 class="h2" id="mk-h-closing">Closing soon</h2>${preds ? '<button type="button" class="link dim" data-act="tab" data-tab="predictions" data-fk="all-preds">All predictions</button>' : ""}</div>${mkCards(closing)}</section>`);
  if (movers.length) out.push(`<section class="mk-block" aria-labelledby="mk-h-movers"><div class="sec-head"><h2 class="h2" id="mk-h-movers">Movers</h2><span class="dim small">24h · on your venues and public prices</span></div><div class="mk-chips">${movers.map(mkChip).join("")}</div></section>`);
  const narrowed = lens && lens.kind === "venue";
  if (traded.length || !narrowed) out.push(`<section class="sec" aria-labelledby="mk-h-traded"><div class="sec-head"><h2 class="h2" id="mk-h-traded">Most traded</h2></div>${mkTable(traded, "Nothing is trading at your venues or in the public listings right now.")}</section>`);
  if (!out.length) out.push(`<p class="empty">Nothing at ${esc(lens.name)} is in Now. Its markets are under the other tabs.</p>`);
  return out.join("");
}
/* any other tab, or a search: a sort, the events as cards, everything else in a table */
function mkListHtml(p, body, lens) {
  const items = body.items.filter((x) => mkInLens(x, lens));
  const events = items.filter((x) => x.kind === "event");
  const rest = items.filter((x) => x.kind !== "event");
  const sorts = [["volume", "Most traded"], ["movers", "Biggest moves"], ...(events.length || ["predictions", "macro", "sports"].includes(p.tab) ? [["closing", "Closing soonest"]] : [])];
  const head = `<div class="mk-bar">${p.q ? `<p class="mk-q">${plural(items.length, "market")} for “${esc(p.q)}” <button type="button" class="link dim" data-act="clear-q" data-fk="clear-q">Clear</button></p>` : "<span></span>"}${items.length > 1 ? mkSeg(sorts, p.sort || "volume", "sort", "Sort by") : ""}</div>`;
  if (!items.length) return `${head}<p class="empty">${p.q ? `Nothing matches “${esc(p.q)}” at your venues or in the public listings.` : "Nothing here right now."}</p>`;
  return `${head}${events.length ? `<section class="mk-block" aria-label="Predictions">${mkCards(events)}</section>` : ""}${rest.length ? `<section class="sec" aria-label="Markets">${mkTable(rest, "")}</section>` : ""}`;
}

/* a watched market not in the explore read (a quiet one, or a venue no longer listing it): enough of a row to price it, open it, trade or
   connect it, and stop watching it */
function mkPseudo(w, body) {
  const v = mkVenue(w.venue);
  const rows = body ? [...body.items, ...body.closing, ...body.movers, ...body.mostTraded] : [];
  const pub = rows.flatMap((x) => x.at).find((a) => a.public && a.connectTo === w.venue && a.connector);
  const opt = A.connectLive && (A.connectLive.options || []).find((o) => o.kind === w.venue);
  const ev = /:/.test(w.symbol) && !/\//.test(w.symbol);
  const at = v
    ? { venue: v.id, venueName: v.name, symbol: w.symbol, connected: true, canTrade: v.trade ? v.trade.can : false, public: false }
    : { venue: w.venue, venueName: pub ? pub.venueName : w.venue, symbol: w.symbol, connected: false, canTrade: false, public: true, connectTo: w.venue, connector: pub ? pub.connector : opt ? opt.connector : "" };
  return { key: `watch:${w.venue}|${w.symbol}`, kind: ev ? "event" : "coin", name: w.symbol, ...(ev ? {} : { base: w.symbol.split(/[/@:]/)[0] }), tabs: [], at: [at] };
}
/* Watching: the owner's watchlist (which agents read), each priced fresh where its venue is connected */
function mkWatchingHtml(lens) {
  const g = MKT.got.get(MKT_ALL);
  if (!g || (!g.pending && Date.now() - (g.at || 0) > MKT_TTL)) mkFetch(MKT_ALL);
  const body = g && g.good;
  const all = body ? [...body.items, ...body.closing, ...body.movers, ...body.mostTraded] : [];
  const rows = (A.watch || []).map((w) => {
    const item = all.find((x) => mkIsWatch(x, w)) || mkPseudo(w, body);
    const oi = item.outcomes ? item.outcomes.findIndex((o) => o.at.some((l) => l.symbol === w.symbol)) : -1;
    return { w, item, oi: oi >= 0 ? oi : undefined };
  }).filter((x) => mkInLens(x.item, lens));
  if (!rows.length) return '<div class="card"><p class="empty">Nothing watched. Press ★ on a market to watch it: your agents read the watchlist.</p></div>';
  const cols = [
    { label: "", sr: "Watch", cell: (x) => mkStar(x.item, x.i) },
    { label: "Market", cls: "mk-c-name", cell: (x) => `<button type="button" class="mk-name" data-act="open" data-i="${x.i}" data-fk="open:${esc(x.item.key)}">${mkAv(x.item)}<span><b>${esc(x.item.name)}</b><span class="dim">${esc(x.oi !== undefined ? mkLabel(x.item.outcomes[x.oi].label) : x.item.base || MKT_KIND[x.item.kind] || "")}</span></span></button>${mkWhereLine(x.item)}` },
    { label: "Where", cls: "mk-c-where", cell: (x) => mkWhere(x.item) },
    { label: "Price", r: true, cell: (x) => {
      const ev = x.item.kind === "event";
      const m = mkVenue(x.w.venue) ? mkFresh(`${x.w.venue}|${x.w.symbol}`) : null;
      const o = x.oi !== undefined ? x.item.outcomes[x.oi] : null;
      const shown = m ? (ev ? mkCents(m.price ?? m.ask) : mkUsd(m.price ?? m.ask)) : ev ? mkCents(o ? o.price : x.item.price) : mkUsd(x.item.price);
      return `<span${mkVenue(x.w.venue) ? ` data-q="${esc(`${x.w.venue}|${x.w.symbol}`)}" data-fmt="${ev ? "c-last" : "usd"}"` : ""}>${shown}</span>`;
    } },
    { label: "24h", r: true, cell: (x) => (x.item.kind === "event" ? chg(x.oi !== undefined && x.item.outcomes[x.oi].change24h !== undefined ? x.item.outcomes[x.oi].change24h * 100 : undefined, "¢") : chg(x.item.changePct24h)) },
    { label: "Watched", cell: (x) => `<span class="dim small">${esc(nyDay(x.w.at))}</span>` },
    { label: "", sr: "Actions", r: true, cell: (x) => mkActs(x.item, x.i) },
  ];
  return `<div class="card"><p class="dim small">Your agents read this list over MCP; watching a market grants nothing.</p>${table(cols, rows.map((x) => ({ ...x, i: mkReg(x.item) })), { cls: "mk-t", rowAttr: (x) => (mkVenue(x.w.venue) ? `data-pairs="${esc(`${x.w.venue}|${x.w.symbol}`)}"` : "") })}</div>`;
}

// ---- the Venues board ------------------------------------------------------------------------------------

/* how a connected venue has answered lately, in its own words when it failed (a rule for this location is said as its rule) */
function mkHealth(v) {
  const h = (A.health || {})[v.id] || {};
  const failed = h.lastFailAt && (!h.lastOkAt || Date.parse(h.lastFailAt) >= Date.parse(h.lastOkAt));
  if (failed && h.code === "E_VENUE_GEOBLOCKED") return { bad: true, text: `${mkSaid(h.message) || `${v.name} does not serve this location`}. That is ${v.name}'s own rule for this location.` };
  if (failed) return { bad: true, text: `Didn't answer at ${nyTime(h.lastFailAt)}: ${mkSaid(h.message || h.code)}.` };
  if (v.stale) return { bad: true, text: `Last read failed: ${mkSaid(v.stale)}.` };
  if (h.lastOkAt) return { bad: false, text: `Answered at ${nyTime(h.lastOkAt)}${h.ms !== undefined ? ` · ${h.ms} ms` : ""}` };
  return { bad: false, text: v.asOf ? `Read at ${nyTime(v.asOf)}` : "Not read yet" };
}
/* what a connected venue trades from here, or why not and what fixes it */
function mkTrades(v) {
  if (!writesOn()) return { can: false, text: mkWhyNot(v, {}) };
  if (watched(v)) return { can: false, text: "Watched address: nothing is traded from it." };
  if (canTrade(v)) return { can: true, text: `Trades ${v.trade.what}` };
  if (v.trade && v.trade.can === false) return { can: false, rekey: !!connectorOfVenue(v), text: `This key can't trade. ${keyHowFor(v)}` };
  return { can: false, text: v.noTradeBecause ? mkSaid(v.noTradeBecause) : "Read only" };
}
function mkVenuesHtml(owner, lens) {
  const L = connected().filter((v) => !lens || lens.kind !== "venue" || v.id === lens.id);
  const revoked = new Set((A.dial && A.dial.revoked) || []);
  const cols = [
    { label: "Venue", cell: (v) => `<div class="who">${avatar(v.name, "sm")}<div><b>${esc(v.name)}</b><span class="dim">${esc(money(v.usd))}${v.asOf ? ` · balances at ${esc(nyTime(v.asOf))}` : ""}</span></div></div>` },
    { label: "Health", cell: (v) => { const h = mkHealth(v); return `<span class="mk-health${h.bad ? " bad" : ""}"><span aria-hidden="true">${h.bad ? "✗" : "✓"}</span> ${esc(h.text)}</span>`; } },
    { label: "Trading", cls: "mk-trading", cell: (v) => { const t = mkTrades(v); return `<span class="${t.can ? "" : "dim"}">${esc(t.text)}</span>${t.rekey ? ` <button type="button" class="link" data-act="rekey" data-venue="${esc(v.id)}" data-fk="rekey:${esc(v.id)}"${mkDis()}>Connect a new key</button>` : ""}`; } },
    { label: "Open to agents", cell: (v) => { const on = !revoked.has(v.id); return `<button type="button" role="switch" class="mk-switch" aria-checked="${String(on)}" data-act="agents" data-venue="${esc(v.id)}" data-fk="agents:${esc(v.id)}" aria-label="${esc(v.name)} open to agents"${on || owner ? "" : ' disabled title="Reopening is signed: only a browser that signs for the owner can"'}><span class="track" aria-hidden="true"></span><span>${on ? "Open" : "Closed"}</span></button>`; } },
    { label: "", sr: "Actions", r: true, cell: (v) => `<div class="acts">${canTrade(v) ? `<button type="button" class="btn btn-sm" data-act="trade-at" data-venue="${esc(v.id)}" data-fk="trade-at:${esc(v.id)}"${mkDis()}>Trade</button>` : ""}${canMove(v) && typeof openLiveMove === "function" ? `<button type="button" class="btn btn-sm" data-act="move" data-venue="${esc(v.id)}" data-fk="move:${esc(v.id)}"${mkDis()}>Move</button>` : ""}${v.plugged ? `<button type="button" class="link dim" data-act="unplug" data-venue="${esc(v.id)}" data-fk="unplug:${esc(v.id)}"${mkDis()}>Disconnect</button>` : ""}</div>` },
  ];
  // the public sources that did not answer from here, in their own words
  const body = MKT.good && MKT.good.body;
  const seen = new Set();
  const away = ((body && body.missing) || []).filter((m) => !m.connected && !m.symbol && !seen.has(m.venue) && seen.add(m.venue));
  // what the agents asked the owner to connect
  const asks = (A.asks || []).filter((a) => a.kind === "venue" && !mkVenue(a.venue));
  const rows = body ? [...body.items, ...body.closing, ...body.movers, ...body.mostTraded] : [];
  const askConnector = (venue) => { const a = rows.flatMap((x) => x.at).find((x) => x.public && x.connectTo === venue && x.connector); const o = A.connectLive && (A.connectLive.options || []).find((x) => x.kind === venue); return a ? a.connector : o ? o.connector : ""; };
  return `<section class="sec" aria-labelledby="mk-h-yours"><div class="sec-head"><h2 class="h2" id="mk-h-yours">Your venues</h2><span class="dim small">Closing a venue to agents is free; reopening it is signed. Either way they keep reading it.</span></div>${table(cols, L, { empty: "Nothing connected yet: pick a venue below.", cls: "mk-t mk-vt" })}</section>
    ${asks.length ? `<section class="callout" aria-label="Your agents asked"><div class="label">Your agents asked</div>${asks.map((a) => { const c = askConnector(a.venue); return `<div class="mk-ask"><span><b>${esc(a.agentName)}</b>: “${esc(a.text)}”</span><span class="acts">${typeof declineAsk === "function" ? `<button type="button" class="btn btn-sm" data-act="decline" data-ask="${esc(a.id)}" data-fk="decline:${esc(a.id)}"${mkDis()}>Decline…</button>` : ""}${c && connectionOf(c) ? `<button type="button" class="btn btn-sm" data-act="connect" data-connector="${esc(c)}" data-name="" data-fk="ask:${esc(a.id)}"${mkDis()}>${icon("plug", "sm")}Connect</button>` : ""}</span></div>`; }).join("")}</section>` : ""}
    ${away.length ? `<section class="sec" aria-labelledby="mk-h-away"><div class="sec-head"><h2 class="h2" id="mk-h-away">Not reachable from here</h2></div><div class="feed">${away.map((m) => `<div><span class="mk" aria-hidden="true">✗</span><div><div class="t1">${esc(m.venueName)}</div><div class="t2">${m.said ? `“${esc(mkSaid(m.said))}”${m.code === "E_VENUE_GEOBLOCKED" ? " — its own rule for this location." : ""}` : esc(m.why)}</div></div></div>`).join("")}</div></section>` : ""}
    <section class="sec" aria-labelledby="mk-h-connect"><div class="sec-head"><h2 class="h2" id="mk-h-connect">Connect a venue</h2><span class="dim small">${writesOn() ? "Orders go through only when you sign them, or inside a limit you give an agent." : "Read-only: this server places no orders."}</span></div>${A.connectLive ? catalog(owner, "wide") : '<p class="empty">This server has no way to connect accounts.</p>'}</section>`;
}

// ---- the pane ----------------------------------------------------------------------------------------

/* the route's tab, search and sort, as the pane reads them: an unknown tab is Now (All results while searching) */
function mkParams(params) {
  const q = String((params && params.q) || "").trim().slice(0, 60);
  let tab = String((params && params.tab) || "");
  if (!["watching", "venues", ...MKT_TAB_IDS].includes(tab)) tab = q ? "" : "now";
  const sort = MKT_SORTS.includes(params && params.sort) ? params.sort : "";
  return { tab, q, sort };
}
const mkPath = (p, limit) => `/api/account/explore?${new URLSearchParams(Object.entries({ tab: p.tab, q: p.q, sort: p.sort, limit: limit ? String(limit) : "" }).filter(([, v]) => v)).toString()}`;

/* one explore read: the last answer is kept with the last one that was not a refusal, so a failure never blanks what was drawn */
function mkFetch(path) {
  const was = MKT.got.get(path);
  if (was && was.pending) return;
  MKT.got.set(path, { ...(was || {}), pending: true });
  api(path).then((body) => {
    const ok = !!body && body.ok !== false && Array.isArray(body.items);
    MKT.got.set(path, { at: Date.now(), body, good: ok ? body : was && was.good, goodAt: ok ? Date.now() : was && was.goodAt });
    if (ok && path !== MKT_ALL) MKT.good = { body, at: Date.now() };
    if (ok && path === MKT_ALL && !MKT.good) MKT.good = { body, at: Date.now() };
    if (A && ROUTE.tab === "markets" && MKT.ctx) mkRedraw();
    if (MKT.open) mkDrawerRedraw();
  });
}
const mkRedraw = () => renderMarkets({ ...MKT.ctx, owner: owns(), lens: lensNow(), params: ROUTE.params });

/* the pane's HTML replaces the old only when it changed, and the button that had the focus has it again */
function mkPaint(el, html) {
  if (MKT_PAINTED.get(el) === html) return false;
  const f = document.activeElement;
  const fk = f && f.dataset && el.contains && el.contains(f) ? f.dataset.fk : "";
  el.innerHTML = html;
  MKT_PAINTED.set(el, html);
  if (fk) for (const x of el.querySelectorAll("[data-fk]")) if (x.dataset.fk === fk) { x.focus(); break; }
  return true;
}

/** MARKETS: the shell calls this with { el, owner, lens, params } each time the account is read and whenever the route moves here */
function renderMarkets(ctx) {
  MKT.ctx = ctx;
  if (MKT.el !== ctx.el) {
    ctx.el.addEventListener("click", mkPaneClick);
    MKT.el = ctx.el;
  }
  MKT.reg = [];
  const p = mkParams(ctx.params);
  let body = "";
  let tabsFrom = null;
  if (p.tab === "venues") {
    // the venues not reachable from here, and the connections the agents asked for, come from a markets read: one is made if none was
    if (!MKT.good) mkFetch(mkPath({ tab: "now", q: "", sort: "" }));
    body = mkVenuesHtml(ctx.owner, ctx.lens);
  }
  else if (p.tab === "watching") body = mkWatchingHtml(ctx.lens);
  else {
    const path = mkPath(p);
    const g = MKT.got.get(path);
    if (!g || (!g.pending && Date.now() - (g.at || 0) > MKT_TTL)) mkFetch(path);
    const got = g && g.good;
    tabsFrom = got;
    const failed = g && g.body && !(g.body.ok !== false && Array.isArray(g.body.items)) ? refusalOf(g.body) || "the account did not answer" : "";
    // a tab this read does not have (nothing is in it now): every result while searching, else the first tab it has
    if (got && got.tabs.length && p.tab && !got.tabs.some((t) => t.id === p.tab)) return void go("markets", { ...ctx.params, tab: p.q ? "" : got.tabs[0].id, sort: "" }, { replace: true });
    if (got) body = `${p.tab === "now" ? mkNowHtml(got, ctx.lens) : mkListHtml(p, got, ctx.lens)}${failed ? `<p class="mk-missing">Couldn't read the markets again just now: ${esc(mkSaid(failed))}. This is what was read at ${esc(nyTime(new Date(g.goodAt).toISOString()))}.</p>` : ""}${mkMissingLine(got.missing)}`;
    else if (failed) body = `<div class="mk-fail"><div class="msg no">Couldn't read the markets: ${esc(mkSaid(failed))}.</div><button type="button" class="btn btn-sm" data-act="retry" data-fk="retry">Try again</button></div>`;
    else body = mkSkel();
  }
  mkPaint(ctx.el, `<div class="mk">${mkTabs(p, tabsFrom || (MKT.good && MKT.good.body))}${body}</div>`);
  mkObserve(ctx.el);
  mkStart();
}

/* one click handler for the pane, which is drawn again and again */
function mkPaneClick(e) {
  const t = e.target;
  const tile = t && t.closest && t.closest("button.tile");
  if (tile && !tile.disabled) return void openConnect(optionOf(tile.dataset.kind), { exchange: tile.dataset.kind === "exchange" ? tile.dataset.extra : "", watch: tile.dataset.extra === "watch", name: tile.querySelector("b").textContent });
  const b = t && t.closest && t.closest("[data-act]");
  if (!b || b.disabled) return;
  const item = MKT.reg[Number(b.dataset.i)];
  const v = b.dataset.venue;
  switch (b.dataset.act) {
    case "tab": return void go("markets", { q: ROUTE.params.q, tab: b.dataset.tab });
    case "sort": return void go("markets", { ...ROUTE.params, sort: b.dataset.v === "volume" ? "" : b.dataset.v }, { replace: true });
    case "clear-q": return void go("markets", { ...ROUTE.params, q: "", tab: ROUTE.params.tab || "" }, { replace: true });
    case "retry": for (const g of MKT.got.values()) g.at = 0; return void mkRedraw();
    case "agents": return void mkAgentsSwitch(v, b.getAttribute("aria-checked") === "true");
    case "unplug": return void mkUnplug(v);
    case "rekey": return void mkRekey(v);
    case "trade-at": return void mkTicket({ venue: v });
    case "move": return void openLiveMove(v);
    case "connect": return void connectVia(b.dataset.connector, { name: b.dataset.name });
    case "decline": return void declineAsk((A.asks || []).find((a) => a.id === b.dataset.ask));
    default: return void (item && mkAct(b, item));
  }
}
/* what a row's button does, from the pane or the drawer */
function mkAct(b, item) {
  const act = b.dataset.act;
  if (act === "open") return void openMarket(item);
  if (act === "watch") return void mkToggleWatch(item);
  if (act === "trade") return void mkTrade(item, "buy");
  if (act === "yn") return void mkTrade(item, "buy", Number(b.dataset.o));
  if (act === "hand") return void mkHand(item);
}

// ---- doing: the ticket, the agent, the watchlist, the venues ---------------------------------------------

/** the ticket, preset: the Trade pane's own (openTicket) */
function mkTicket(preset, item) {
  const kind = item ? { perp: "perp", event: "event", stock: "stock" }[item.kind] : undefined;
  const variant = { perp: "perps", event: "predictions" }[kind] || "trade";
  const p = { ...preset, ...(item ? { key: item.key, base: item.base, name: item.name, variant, ...(kind ? { kind } : {}) } : {}) };
  // the ticket is the Trade pane's panel on the right, where this drawer would cover it
  if (mkDrawerBody()) closeDrawer();
  if (typeof openTicket === "function") openTicket(p);
}
/** Buy (or one outcome's button): the ticket at the venue that takes the order, the connection where only public prices list it, else the
 * venue's own words for why not */
function mkTrade(item, side, oi) {
  const r = mkRoute(item, oi);
  if (r.act === "trade") return void mkTicket({ venue: r.venue, symbol: r.symbol, side, ...(oi !== undefined && item.outcomes ? { outcome: item.outcomes[oi].label } : {}) }, item);
  if (r.act === "connect") return void connectVia(r.connector, { name: r.venueName });
  toast(r.text || "No venue on the account trades it.", "no");
}
/** Hand to agent: the owner's intent for it, which agents read (signed in the intent sheet; it grants nothing — the limits do) */
function mkHand(item, side = "buy") {
  if (typeof openHandToAgent !== "function") return;
  const r = mkRoute(item);
  const t = r.act === "trade" ? { venue: r.venue, symbol: r.symbol, venueName: r.venueName } : mkHandTarget(item);
  openHandToAgent({ ...t, side, name: item.name, key: item.key, base: item.base });
}
/** where an agent is pointed for a row no connected venue trades: its first connected venue, else the venue its public prices come from —
 * by that venue's name, since the account does not know it yet */
function mkHandTarget(item) {
  const c = item.at.find((a) => a.connected);
  if (c) return { venue: c.venue, symbol: c.symbol, venueName: c.venueName };
  const p = item.at.find((a) => a.public && a.connectTo);
  return p ? { venue: p.connectTo, symbol: p.symbol, venueName: p.venueName } : {};
}
/** ★: a signed setWatch (agents read the watchlist over MCP) */
async function mkToggleWatch(item) {
  const d = mkWatchDraft(item);
  if (d && owns()) await own(d);
}
/** "Open to agents": closing is free (POST /api/revoke: agents keep reads only); reopening widens what they may do, so it is signed */
async function mkAgentsSwitch(venueId, isOpen) {
  const v = mkVenue(venueId);
  if (!v || busy) return;
  if (!isOpen) return void (owns() && (await own({ type: "setPolicy", change: "restore", value: venueId })));
  const r = await postJson("/api/revoke", { account: venueId });
  if (r.status >= 400 || (r.body && r.body.ok === false)) flash = Owner.why(r) || "Refused";
  else said = `${v.name} is closed to agents: they keep reading it, and place or move nothing there. Reopening it is signed.`;
  await load();
}
/** Disconnect: asked first, then a signed disconnectVenue. The key at the venue, and its file here, are left as they are */
async function mkUnplug(venueId) {
  const v = mkVenue(venueId);
  if (!v || !owns()) return;
  if (await confirmSheet(`Disconnect ${v.name}? The account stops reading it, and nothing is placed or moved there from here. The key at ${v.name}, and its file on this machine, are left as they are: connect it again any time.`, { danger: true, title: "Disconnect", yes: "Disconnect" })) await own({ type: "disconnectVenue", venue: venueId });
}
/** a venue whose key can't trade: disconnect it (signed), then its connect form for a key that can */
async function mkRekey(venueId) {
  const v = mkVenue(venueId);
  const connector = connectorOfVenue(v);
  if (!v || !connector || !owns()) return;
  // the file this venue's key is read from, as the account signed it: a second account at an exchange has its own
  const ref = v.keyFile || "";
  const file = !ref ? "" : ref.startsWith("/") ? ref : `${String((A.connectLive && A.connectLive.home) || "").replace(/\/$/, "")}/${ref}`;
  if (!(await confirmSheet(`${v.name}'s key can't trade. ${keyHowFor(v)} Save the new key in the same file${file ? `, ${file}` : ""}, then the account disconnects ${v.name} (nothing there moves) and opens its connect form.`, { title: "Connect a new key", yes: "Disconnect and continue" }))) return;
  const r = await own({ type: "disconnectVenue", venue: venueId });
  // connected again under its own name and from its own file, so it comes back as the same venue reading the same account
  if (r && !refusedAt(r)) connectVia(connector, { name: v.name, label: v.name, ref });
}

// ---- fresh prices and countdowns ---------------------------------------------------------------------------

/* the cards in view: only theirs are priced again */
function mkObserve(root) {
  if (typeof IntersectionObserver !== "function") return;
  if (!MKT.io) MKT.io = new IntersectionObserver((entries) => { for (const e of entries) e.isIntersecting ? MKT.seen.add(e.target) : MKT.seen.delete(e.target); }, { rootMargin: "80px" });
  MKT.io.disconnect();
  for (const x of [...MKT.seen]) if (!x.isConnected) MKT.seen.delete(x);
  for (const x of root.querySelectorAll("[data-pairs]")) MKT.io.observe(x);
}
function mkStart() {
  if (!MKT.tick) MKT.tick = setInterval(mkTick, 1000);
  if (!MKT.poll) MKT.poll = setInterval(mkPoll, MKT_POLL_MS);
}
const mkDrawerBody = () => { const d = $("drawer"); return d && d.open ? d.querySelector("[data-mk-drawer]") : null; };
/** fresh prices for what is in view — the cards and watched rows on screen, the market in the drawer — at most twelve markets a read, and
 * only while the page is in view */
async function mkPoll() {
  if (!A || document.hidden) return;
  const drawer = mkDrawerBody();
  const here = ROUTE.tab === "markets" ? [...MKT.seen].filter((x) => x.isConnected) : [];
  const els = [...(drawer ? drawer.querySelectorAll("[data-pairs]") : []), ...here];
  const pairs = [...new Set(els.flatMap((x) => String(x.dataset.pairs || "").split(",").filter(Boolean)))].slice(0, 12);
  if (!pairs.length) return;
  const body = await api(`/api/account/quotes?pairs=${encodeURIComponent(pairs.join(","))}`);
  if (!body || body.ok === false || !Array.isArray(body.quotes)) return;
  const now = Date.now();
  for (const q of body.quotes) if (q.market) MKT.quotes.set(`${q.venue}|${q.symbol}`, { at: now, market: q.market });
  // only this pane's own prices (each carries its format): other panes' quote boxes use data-q for something else
  for (const el of document.querySelectorAll("[data-q][data-fmt]")) {
    const m = mkFresh(el.dataset.q);
    if (m) el.textContent = mkFmt(m, el.dataset.fmt);
  }
}
/** every market countdown on the page (this pane's and its drawer's), each second; a market that closes sends the next draw to read the
 * markets again (a rolling market's next one takes its place). Only `.mk-close` is a countdown: other panes use data-close for buttons */
function mkTick() {
  if (document.hidden) return;
  let ended = false;
  for (const el of document.querySelectorAll(".mk-close[data-close]")) {
    const left = Date.parse(el.dataset.close) - Date.now();
    el.textContent = mkLeft(left);
    if (left <= 0 && !el.hasAttribute("data-closed")) {
      el.setAttribute("data-closed", "");
      ended = true;
    }
  }
  if (ended) {
    for (const g of MKT.got.values()) g.at = 0;
    setTimeout(() => A && ROUTE.tab === "markets" && MKT.ctx && mkRedraw(), 1500);
  }
}

// ---- one market, in the drawer ----------------------------------------------------------------------------

/* a market from what was read, by itself, by its key, or by its venue and symbol */
function mkResolve(item) {
  if (item && typeof item === "object" && Array.isArray(item.at)) return item;
  const key = typeof item === "string" ? item : item && item.key;
  const venue = item && typeof item === "object" ? item.venue : "";
  const symbol = item && typeof item === "object" ? item.symbol : "";
  for (const g of MKT.got.values()) {
    const b = g.good;
    if (!b) continue;
    for (const x of [...b.items, ...b.closing, ...b.movers, ...b.mostTraded]) {
      if (key && x.key === key) return x;
      if (symbol && [...x.at, ...(x.outcomes || []).flatMap((o) => o.at)].some((a) => a.symbol === symbol && (!venue || a.venue === venue || mkVenueOfLeg(x, a.venue) === venue))) return x;
    }
  }
  return null;
}

/** OPEN ONE MARKET: its price, bid and ask, 24 hours, volume, countdown, price history, every venue's price for it, what is held, what the
 * agents are doing in it, and Buy · Sell · Hand to agent · ★. `item` is a row from the explore read, or { key } / { venue, symbol } /
 * a key, which is looked up (and read once when it is not in what was drawn) */
function openMarket(item) {
  if (!A) return;
  const it = mkResolve(item);
  if (!it) return void mkLookup(item);
  MKT.open = { item: it, interval: "1h", asset: undefined, compare: undefined, candles: undefined };
  const body = openDrawer(`<div class="mk-d" data-mk-drawer>${mkDrawerHtml(MKT.open)}</div>`, { title: it.name, redraw: mkDrawerRedraw });
  if (!MKT.drawerWired) {
    $("drawer").addEventListener("close", () => (MKT.open = null));
    MKT.drawerWired = true;
  }
  body.addEventListener("click", mkDrawerClick);
  mkStart();
  mkDrawerLoad(MKT.open);
  mkPoll();
}
/* a market asked for by name that the pane has not drawn: every market is read once, then it opens — or, at a connected venue, enough of
   it to open anyway */
async function mkLookup(item) {
  const q = String((item && typeof item === "object" ? item.base || item.symbol : String(item || "").replace(/^[a-z]+:/, "")) || "").slice(0, 60);
  const path = mkPath({ tab: "", q, sort: "" }, 200);
  const body = await api(path);
  if (body && body.ok !== false && Array.isArray(body.items)) MKT.got.set(path, { at: Date.now(), body, good: body, goodAt: Date.now() });
  const it = mkResolve(item);
  if (it) return void openMarket(it);
  if (item && typeof item === "object" && item.venue && item.symbol) return void openMarket(mkPseudo({ venue: item.venue, symbol: item.symbol, at: A.now }, null));
  toast("That market isn't listed at your venues or in the public listings right now.", "info");
}
/** the market whose price history the drawer draws: at the first connected venue that lists it, else at a venue whose public prices do —
 * an event's first outcome. Null when no venue lists it */
function mkCandleLeg(item) {
  const legs = mkLegs(item, item.kind === "event" && item.outcomes && item.outcomes.length ? 0 : undefined);
  const l = legs.find((x) => mkVenue(x.venue)) || legs.find((x) => mkAtOf(item, x.venue).public) || legs[0];
  return l ? { venue: l.venue, symbol: l.symbol, venueName: (mkVenue(l.venue) || {}).name || mkAtOf(item, l.venue).venueName || l.venue } : null;
}
/* the bars a candles read gave (GET /api/account/candles: { venue, venueName, symbol, interval, candles: [bars] }) as one series; null when
   it gave none */
function mkSeriesOf(b) {
  if (!b || b.ok === false) return null;
  if (Array.isArray(b.candles)) return { venue: b.venue, venueName: b.venueName, symbol: b.symbol, interval: b.interval, bars: b.candles };
  return b.candles && Array.isArray(b.candles.bars) ? b.candles : Array.isArray(b.bars) ? b : null;
}
/* the candles read is not on this account (an account from before it): the drawer draws from the Asset read as it did */
const mkNoCandles = (b) => !!b && b.ok === false && !b.refusal;

/* what the drawer reads for it: the market's price history (any market, connected or public), the asset (what is held, orders, and the
   history an account without the candles read gives) and, for a coin or a share, every connected venue's price */
function mkDrawerLoad(o) {
  const leg = mkCandleLeg(o.item);
  if (leg && o.candles === undefined) {
    const interval = o.interval;
    o.candles = null;
    api(`/api/account/candles?${new URLSearchParams({ venue: leg.venue, symbol: leg.symbol, interval })}`, { ttl: 30_000 }).then((b) => {
      if (MKT.open !== o || o.interval !== interval) return;
      o.candles = b;
      mkDrawerRedraw();
    });
  }
  const key = mkAssetKey(o.item);
  if (key && o.asset === undefined) {
    const interval = o.interval;
    api(`/api/account/asset?key=${encodeURIComponent(key)}&interval=${interval}`, { ttl: 30_000 }).then((b) => {
      if (MKT.open !== o || o.interval !== interval) return;
      o.asset = b;
      mkDrawerRedraw();
    });
  }
  const base = ["coin", "perp", "stock"].includes(o.item.kind) ? o.item.base : "";
  if (base && o.compare === undefined) {
    o.compare = null;
    api(`/api/account/compare?base=${encodeURIComponent(base)}&side=buy`, { ttl: 15_000 }).then((b) => {
      if (MKT.open !== o) return;
      o.compare = b;
      mkDrawerRedraw();
    });
  }
}
/* after each read of the account (and each answer above): the drawer drawn again in place, the row itself refreshed from the latest read */
function mkDrawerRedraw() {
  const o = MKT.open;
  const el = mkDrawerBody();
  if (!o || !el) return void (MKT.open = el ? MKT.open : null);
  const again = mkResolve({ key: o.item.key });
  if (again && again !== o.item && !String(o.item.key).startsWith("watch:")) o.item = again;
  mkPaint(el, mkDrawerHtml(o));
}
function mkDrawerClick(e) {
  const b = e.target && e.target.closest && e.target.closest("[data-act]");
  const o = MKT.open;
  if (!b || b.disabled || !o) return;
  const v = b.dataset.venue;
  switch (b.dataset.act) {
    case "trade-at": return void mkTicket({ venue: v, symbol: b.dataset.symbol, side: "buy", ...(b.dataset.outcome ? { outcome: b.dataset.outcome } : {}) }, o.item);
    case "sell": return void mkTicket({ venue: v, symbol: b.dataset.symbol, side: "sell" }, o.item);
    case "connect": return void connectVia(b.dataset.connector, { name: b.dataset.name });
    case "rekey": return void mkRekey(v);
    case "interval":
      if (b.dataset.v === o.interval) return;
      o.interval = b.dataset.v;
      o.asset = undefined;
      o.candles = undefined;
      mkDrawerRedraw();
      return void mkDrawerLoad(o);
    case "review":
      closeDrawer();
      return void go("portfolio");
    default: return void mkAct(b, o.item);
  }
}

/* the price history as a line: the closes, low and high, first and last time; an event's in cents */
function mkChart(series, ev) {
  const bars = ((series && series.bars) || []).filter((b) => Number.isFinite(b.c));
  if (bars.length < 2) return "";
  const W = 400;
  const H = 140;
  const cs = bars.map((b) => b.c);
  const lo = Math.min(...cs);
  const hi = Math.max(...cs);
  const span = hi - lo || 1;
  const x = (i) => ((i / (bars.length - 1)) * W).toFixed(1);
  const y = (c) => (H - 6 - ((c - lo) / span) * (H - 12)).toFixed(1);
  const line = bars.map((b, i) => `${i ? "L" : "M"}${x(i)},${y(b.c)}`).join("");
  const f = (n) => (ev ? mkCents(n) : mkUsd(n));
  const when = (t) => `${nyDay(new Date(t).toISOString())} ${nyTime(new Date(t).toISOString())}`;
  const first = bars[0];
  const last = bars[bars.length - 1];
  return `<svg class="spark mk-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(`Price at ${series.venueName}, ${series.interval} bars: from ${f(first.c)} to ${f(last.c)}, low ${f(lo)}, high ${f(hi)}`)}"><path class="area" d="${line}L${W},${H}L0,${H}Z"/><path class="line" d="${line}"/></svg><div class="mk-axis"><span>${esc(when(first.t))}</span><span>Low ${esc(f(lo))} · High ${esc(f(hi))}</span><span>${esc(when(last.t))}</span></div><p class="dim small">At ${esc(series.venueName)} · ${esc(series.symbol)}</p>`;
}

/* what is held of it, from the Asset read: the row across venues, the positions, what was paid */
function mkHeldHtml(o) {
  const a = o.asset && o.asset.ok !== false ? o.asset : null;
  if (!mkAssetKey(o.item)) return '<p class="empty">Nothing held: no venue on the account lists it.</p>';
  if (!o.asset) return '<div class="skel-rows" aria-hidden="true"><span class="skel"></span></div>';
  if (!a) return `<p class="empty">${esc(refusalOf(o.asset) || "Couldn't read what is held.")}</p>`;
  const ev = o.item.kind === "event";
  const lines = [];
  if (a.row) for (const h of a.row.venues || []) lines.push(`<div><span class="mk" aria-hidden="true">·</span><div><div class="t1">${esc(qtyOf(h.amount))} ${esc(ev ? "contracts" : a.row.asset)} · ${esc(money(h.usd))}</div><div class="t2">${esc(h.venueName)}${h.note ? ` · ${esc(h.note)}` : ""}</div></div></div>`);
  for (const p of a.positions || []) lines.push(`<div><span class="mk" aria-hidden="true">·</span><div><div class="t1">${esc(p.side === "short" ? "Short" : "Long")} ${esc(qtyOf(p.qty))} · ${esc(p.name || p.symbol)} ${p.unrealizedUsd !== undefined ? chg(p.unrealizedUsd, "$") : ""}</div><div class="t2">${esc(p.venueName)}${p.entryPrice !== undefined ? ` · in at ${esc(ev ? mkCents(p.entryPrice) : px(p.entryPrice))}` : ""}${p.markPrice !== undefined ? ` · now ${esc(ev ? mkCents(p.markPrice) : px(p.markPrice))}` : ""}${p.leverage ? ` · ${esc(String(p.leverage))}x` : ""}${p.liquidationPrice ? ` · liquidation ${esc(px(p.liquidationPrice))}` : ""}</div></div></div>`);
  const cost = (a.cost || []).filter((c) => c.words).map((c) => `<p class="dim small">${esc(c.words)}</p>`).join("");
  return lines.length ? `<div class="feed">${lines.join("")}</div>${cost}` : '<p class="empty">You don’t hold any.</p>';
}
/* where a sell can go: a venue that holds it and takes the order — of the row's own kind. A coin, a share or a token is sold from what is
   held (a perpetual position in the same coin is not it: selling there would open a short); a perpetual only closes from its position; an
   event contract from its position, or the contracts held */
function mkSellAt(o) {
  const a = o.asset && o.asset.ok !== false ? o.asset : null;
  if (!a) return null;
  const kind = o.item.kind;
  const perpish = (k) => k === "perp" || k === "future";
  const positions = (a.positions || []).filter((p) => (kind === "perp" ? perpish(p.kind) : kind === "event" ? p.kind === "event" : !perpish(p.kind) && p.kind !== "event")).map((p) => ({ venue: p.venue, symbol: p.symbol }));
  const held = kind === "perp" ? [] : ((a.row && a.row.venues) || []).filter((h) => !h.inTransit && !h.watched).map((h) => ({ venue: h.venue, symbol: (o.item.at.find((x) => x.venue === h.venue) || {}).symbol }));
  const legs = kind === "event" || kind === "perp" ? [...positions, ...held] : [...held, ...positions];
  for (const l of legs) {
    const v = mkVenue(l.venue);
    if (v && l.symbol && canTrade(v)) return { venue: v.id, symbol: l.symbol, venueName: v.name };
  }
  return null;
}
/* every venue's price for it: the connected ones (for a coin or a share, as the comparison priced them for a buy) and the public listings */
function mkAcrossHtml(o) {
  const it = o.item;
  const ev = it.kind === "event";
  const c = o.compare && o.compare.ok !== false && Array.isArray(o.compare.rows) ? o.compare : null;
  const rows = [];
  for (const r of c ? c.rows : []) rows.push({ venue: r.venue, venueName: r.venueName, symbol: r.symbol, price: r.price, spread: r.spreadPct, note: r.note, best: r.best, ready: r.ready, connected: true });
  for (const a of it.at) if (!rows.some((r) => r.venue === a.venue)) rows.push({ venue: a.venue, venueName: a.venueName, symbol: a.symbol, price: a.price, note: a.note, connected: a.connected, public: a.public, connector: a.connector });
  // an order goes here (its note is the venue's: fees, slippage); or only public prices list it (connect it); or the venue says why not
  const takes = (r) => { const v = mkVenue(r.venue); return !!v && canTrade(v) && mkAtOf(it, r.venue).canTrade !== false; };
  const cell = (r) => {
    const v = mkVenue(r.venue);
    if (takes(r)) return `<button type="button" class="btn btn-sm" data-act="trade-at" data-venue="${esc(r.venue)}" data-symbol="${esc(r.symbol)}"${ev && it.outcomes ? ` data-outcome="${esc(it.outcomes[0].label)}"` : ""} data-fk="trade-at:${esc(r.venue)}"${mkDis()}>Trade</button>`;
    if (!v && r.connector && connectionOf(r.connector)) return `<button type="button" class="btn btn-sm" data-act="connect" data-connector="${esc(r.connector)}" data-name="${esc(r.venueName)}" data-fk="connect:${esc(r.venue)}"${mkDis()}>${icon("plug", "sm")}Connect to trade</button>`;
    return v ? `<span class="why">${esc(mkWhyNot(v, mkAtOf(it, r.venue)))}</span>` : r.note ? `<span class="why">${esc(r.note)}</span>` : "";
  };
  const t = table([
    { label: "Venue", cell: (r) => `${esc(r.venueName)}${r.best ? ' <span class="tag up">Best</span>' : ""}${r.public ? ' <span class="tag">Public</span>' : ""}${r.note && takes(r) ? `<span class="why">${esc(r.note)}</span>` : ""}` },
    { label: c ? "Buy at" : "Price", r: true, cell: (r) => (ev ? mkCents(r.price) : mkUsd(r.price)) },
    ...(c ? [{ label: "Spread", r: true, cell: (r) => (r.spread !== undefined ? `${Number(r.spread.toFixed(2))}%` : "—") }] : []),
    { label: "", sr: "Actions", r: true, cell },
  ], rows, { empty: "No venue lists it right now.", cls: "mk-t" });
  const miss = c ? c.missing.filter((m) => !/no .*market|lists no/i.test(m.why)) : [];
  return `${t}${miss.length ? `<p class="mk-missing">Not compared: ${miss.map((m) => `<b>${esc(m.venueName)}</b>: ${esc(mkSaid(m.why))}`).join(" · ")}.</p>` : ""}${o.compare && !c && o.compare !== null ? `<p class="mk-missing">${esc(refusalOf(o.compare))}</p>` : ""}`;
}
/* what the agents are doing in it, and the owner's intents about it */
function mkAgentsHtml(it) {
  const on = mkAgentsOn(it);
  const lines = [
    ...on.cards.map((c) => `<div><span class="mk warn-t" aria-hidden="true">!</span><div><div class="t1">${esc(c.agentName || keyName(c.agent))} asks: ${esc(c.reason)}</div><div class="t2">Waiting for you · <button type="button" class="link" data-act="review" data-fk="review:${esc(c.id)}">Review under Portfolio</button></div></div></div>`),
    ...on.orders.map((x) => `<div><span class="mk" aria-hidden="true">${x.side === "buy" ? "+" : "−"}</span><div><div class="t1">${esc(keyName(x.agent))}: ${esc(x.side === "buy" ? "buy" : "sell")} ${esc(qtyOf(x.qty))} ${esc(x.base)} · ${esc(x.type)}${x.limitPrice ? ` ${esc(px(x.limitPrice))}` : ""}</div><div class="t2">${esc(x.id)} · ${esc(x.venueName)} · ${esc(x.status)}${x.filledQty ? ` · ${esc(qtyOf(x.filledQty))} filled` : ""}</div></div></div>`),
    ...on.intents.map((x) => `<div><span class="mk" aria-hidden="true">→</span><div><div class="t1">You to ${esc(x.agent === "*" ? "every agent" : x.agentName)}: “${esc(x.text)}”</div><div class="t2">${x.report ? `${esc(x.report.byName)}: ${esc(x.report.status)}${x.report.note ? ` · ${esc(x.report.note)}` : ""}` : "No report yet"} · until ${esc(nyDay(x.validUntil))}</div></div></div>`),
  ];
  return lines.length ? `<div class="feed">${lines.join("")}</div>` : `<p class="empty">No agent is working on it.</p>`;
}

/** the price history the drawer draws: the market's own bars from the candles read; where the venue refuses them, a quiet line in its words
 * (and the Asset read's bars, when it has some from another venue); on an account without the candles read, the Asset read's, as before */
function mkChartHtml(o, it, leg, key) {
  const ev = it.kind === "event";
  const skel = '<div class="skel-rows" aria-hidden="true"><span class="skel" style="height:120px"></span></div>';
  const a = o.asset && o.asset.ok !== false ? o.asset : null;
  const fromAsset = a && a.candles ? mkChart(a.candles, ev) : "";
  if (leg && !mkNoCandles(o.candles)) {
    if (!o.candles) return skel;
    const series = mkSeriesOf(o.candles);
    const drawn = series ? mkChart(series, ev) : "";
    if (drawn) return drawn;
    const words = mkSaid(refusalOf(o.candles)) || "it did not answer";
    const said = series ? `${leg.venueName} has no ${o.interval} bars for it yet` : words.startsWith(leg.venueName) ? words : `No price history from ${leg.venueName}: ${words}`;
    return `${fromAsset}<p class="mk-quiet">${esc(said)}.</p>`;
  }
  if (!key) return `<p class="empty">Price history comes from a connected venue that trades it${mkPublicOnly(it) ? ": connect one to see it" : ""}.</p>`;
  if (o.asset === undefined) return skel;
  if (!a) return `<p class="empty">${esc(refusalOf(o.asset) || "Couldn't read its price history.")}</p>`;
  return fromAsset || `<p class="empty">${esc((a.missing.find((m) => m.part === "candles") || {}).why || (mkPublicOnly(it) ? "Price history comes from a connected venue that trades it: connect one to see it." : ev ? "The venue keeps price history for a contract you hold." : "No venue on the account keeps price history for it."))}</p>`;
}

function mkDrawerHtml(o) {
  const it = o.item;
  const ev = it.kind === "event";
  const lead = mkLeadLeg(it);
  const fresh = lead && mkFresh(`${lead.venue}|${lead.symbol}`);
  const q = lead ? ` data-q="${esc(`${lead.venue}|${lead.symbol}`)}"` : "";
  const r = mkRoute(it);
  const watchedNow = !!mkWatchEntry(it);
  const o0 = ev && it.outcomes ? it.outcomes[0] : null;
  const sell = mkSellAt(o);
  const left = it.closeTime ? Date.parse(it.closeTime) - Date.now() : NaN;
  const sub = [ev ? it.category || "Prediction" : MKT_KIND[it.kind], it.base && it.base !== it.name ? it.base : "", it.event && it.event.title !== it.name ? it.event.title : ""].filter(Boolean).join(" · ");
  const price = ev ? `<span class="num-m"${q} data-fmt="c-last">${mkCents(fresh ? fresh.price ?? fresh.ask : o0 ? o0.price : it.price)}</span><span class="dim">${esc(o0 ? mkLabel(o0.label) : "")}</span>` : `<span class="num-m"${q} data-fmt="usd">${mkUsd(fresh ? fresh.price ?? fresh.ask : it.price)}</span>`;
  const facts = [
    ["24h", ev ? chg(o0 && o0.change24h !== undefined ? o0.change24h * 100 : it.change24h !== undefined ? it.change24h * 100 : undefined, "¢") : chg(it.changePct24h)],
    ["Bid", `<span${q} data-fmt="${ev ? "bid-c" : "bid"}">${ev ? mkCents(fresh ? fresh.bid : o0 && o0.bid) : mkUsd(fresh && fresh.bid)}</span>`],
    ["Ask", `<span${q} data-fmt="${ev ? "ask-c" : "ask"}">${ev ? mkCents(fresh ? fresh.ask : o0 && o0.ask) : mkUsd(fresh && fresh.ask)}</span>`],
    ["Volume 24h", it.volumeUsd24h !== undefined ? mkVol(it.volumeUsd24h) : it.contracts24h !== undefined ? `${mkCount(it.contracts24h)} contracts` : "—"],
    ...(it.fundingRate !== undefined ? [["Funding", `${Number((it.fundingRate * 100).toFixed(4))}%${it.nextFundingAt ? ` · next ${esc(nyTime(it.nextFundingAt))}` : ""}`]] : []),
    ...(fresh && fresh.maxLeverage ? [["Leverage", `up to ${esc(String(fresh.maxLeverage))}x`]] : []),
    ...(it.closeTime ? [["Closes", `${esc(nyDay(it.closeTime))} ${esc(nyTime(it.closeTime))} New York`]] : []),
  ];
  const outcomes = ev && it.outcomes ? `<div class="mk-outs">${it.outcomes.map((x, oi) => {
    const rr = mkRoute(it, oi);
    const leg = mkLeadLeg(it, oi);
    const m = leg && mkFresh(`${leg.venue}|${leg.symbol}`);
    const btn = rr.act === "trade" ? `<button type="button" class="${oi === 0 ? "yes" : "no-btn"} mk-buy" data-act="yn" data-o="${oi}" data-fk="buy:${oi}"${mkDis()}>Buy ${esc(mkLabel(x.label))}</button>` : rr.act === "connect" && oi === 0 ? `<button type="button" class="btn btn-sm" data-act="connect" data-connector="${esc(rr.connector)}" data-name="${esc(rr.venueName)}" data-fk="connect-o"${mkDis()}>${icon("plug", "sm")}Connect to trade</button>` : "";
    return `<div class="mk-out"><span class="lbl">${esc(mkLabel(x.label))}</span><span class="mk-out-px"${leg ? ` data-q="${esc(`${leg.venue}|${leg.symbol}`)}" data-fmt="c"` : ""}>${mkCents(m ? m.ask ?? m.price : x.ask ?? x.price)}</span>${chg(x.change24h !== undefined ? x.change24h * 100 : undefined, "¢")}${btn}</div>`;
  }).join("")}</div>` : "";
  const acts = [
    !ev && r.act === "trade" ? `<button type="button" class="btn btn-primary" data-act="trade" data-fk="d-buy"${mkDis()}>Buy</button>` : "",
    !ev && r.act === "connect" ? `<button type="button" class="btn btn-primary" data-act="connect" data-connector="${esc(r.connector)}" data-name="${esc(r.venueName)}" data-fk="d-connect"${mkDis()}>${icon("plug", "sm")}Connect to trade</button>` : "",
    sell ? `<button type="button" class="btn" data-act="sell" data-venue="${esc(sell.venue)}" data-symbol="${esc(sell.symbol)}" data-fk="d-sell"${mkDis()}>Sell</button>` : "",
    r.act === "trade" && typeof openHandToAgent === "function" ? `<button type="button" class="btn" data-act="hand" data-fk="d-hand"${mkDis()}>${icon("agent", "sm")}Hand to agent</button>` : "",
    watchedNow || mkWatchTarget(it) ? `<button type="button" class="btn" data-act="watch" data-fk="d-watch" aria-pressed="${String(watchedNow)}"${mkDis()}>${icon("star", `sm${watchedNow ? " mk-on" : ""}`)}${watchedNow ? "Watching" : "Watch"}</button>` : "",
  ].filter(Boolean);
  const v = r.act === "why" && r.venue ? mkVenue(r.venue) : null;
  const why = r.act === "why" ? `<div class="callout"><div class="label">Can't trade it here</div><p>${esc(r.text)}</p>${v && v.trade && v.trade.can === false && connectorOfVenue(v) && writesOn() ? `<div><button type="button" class="btn btn-sm" data-act="rekey" data-venue="${esc(v.id)}" data-fk="d-rekey"${mkDis()}>Connect a new key</button></div>` : ""}</div>` : "";
  const key = mkAssetKey(it);
  const leg = mkCandleLeg(it);
  const chart = mkChartHtml(o, it, leg, key);
  const iss = mkIssuer(it);
  return `<div class="who">${mkAv(it, "lg")}<div><b>${esc(it.name)}</b><span class="dim">${esc(sub)}</span></div></div>
    ${it.closeTime ? `<div class="mk-close" data-close="${esc(it.closeTime)}"${left > 0 ? "" : " data-closed"}>${esc(mkLeft(left))}</div>` : ""}
    <div class="mk-d-px"${lead ? ` data-pairs="${esc(mkAllPairs(it).slice(0, 4).join(","))}"` : ""}>${price}${ev ? "" : `${chg(it.changePct24h)}${it.changeFrom ? `<span class="dim small">24h at ${esc(it.changeFrom.venueName)}</span>` : ""}`}</div>
    <dl class="mk-facts">${facts.map(([k, val]) => `<div><dt>${esc(k)}</dt><dd>${val}</dd></div>`).join("")}</dl>
    ${iss ? `<div class="box mk-iss-box"><div class="label">Issuer</div>${iss.issuer ? `<b>${esc(iss.issuer)}</b>` : ""}${iss.eligibility ? `<p class="small">${esc(iss.eligibility)}</p>` : ""}</div>` : ""}
    ${outcomes}
    ${acts.length ? `<div class="mk-d-acts">${acts.join("")}</div>` : ""}
    ${why}
    <section class="sec" aria-label="Price history"><div class="sec-head"><h2 class="h2">Price</h2>${key || leg ? mkSeg([["5m", "5m"], ["1h", "1h"], ["1d", "1d"]], o.interval, "interval", "Price history by") : ""}</div>${chart}</section>
    <section class="sec" aria-label="Across venues"><h2 class="h2">Across venues</h2>${mkAcrossHtml(o)}</section>
    <section class="sec" aria-label="You hold"><h2 class="h2">You hold</h2>${mkHeldHtml(o)}</section>
    <section class="sec" aria-label="Agents on it"><h2 class="h2">Agents on it</h2>${mkAgentsHtml(it)}</section>`;
}
