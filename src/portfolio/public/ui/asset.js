/* One asset, in the drawer: what is held of it and where, every connected venue's price for it, its price history, the positions and the
   open orders in it, what was paid for it and its lines on the statement — with Buy · Sell · Hand to agent. One read, GET /api/account/asset
   (?key=crypto:BTC&interval=1h); the buttons go through the same doors as everywhere else: an order is the ticket's (openTicket), a close
   is a signed liveClose, a cancel a signed liveCancel. */

/* the bars the price history can be read in, and how many of them the drawer draws (the venue gives about three hundred) */
const ASSET_BARS = [["5m", "5m"], ["1h", "1h"], ["1d", "1d"]];
const ASSET_MAX_BARS = 96;
/* what the drawer shows: the asset's key, the bar asked for, the last answer, and which ask is the latest */
const ASSET = { key: "", interval: "1h", body: null, seq: 0, html: "", chart: null };

/* an asset's name as a person reads it: a coin or a share by its symbol, an event contract by its question where a position names it,
   cash by its currency */
function assetTitle(key, d) {
  const [cls, ...rest] = String(key).split(":");
  const sym = rest.join(":");
  if (cls === "event") return ((d && (d.positions || []).find((p) => p.kind === "event")) || {}).name || (d && d.row && d.row.asset) || sym;
  if (cls === "cash") return `Cash · ${sym}`;
  return (d && d.row && d.row.asset) || sym;
}
/* a price in its own unit: an event contract in cents (its chance), anything else in dollars */
const assetPx = (cls, n) => (n === undefined || n === null ? "—" : cls === "event" ? `${Number((Number(n) * 100).toFixed(1))}¢` : Number(n) >= 1 ? money(n) : `$${px(n)}`);

/** The price history as candles: an up bar hollow, a down bar filled, so neither is told by its colour alone. `bars` oldest first; the
 * last ASSET_MAX_BARS are drawn. Returns { svg, first, last, hi, lo } or null when there are fewer than two bars */
function assetCandles(bars, { w = 420, h = 170 } = {}) {
  const b = (bars || []).filter((x) => [x.o, x.h, x.l, x.c].every((n) => Number.isFinite(n))).slice(-ASSET_MAX_BARS);
  if (b.length < 2) return null;
  const hi = Math.max(...b.map((x) => x.h));
  const lo = Math.min(...b.map((x) => x.l));
  const span = hi - lo || Math.abs(hi) || 1;
  const step = w / b.length;
  const y = (v) => Number((((hi - v) / span) * (h - 12) + 6).toFixed(2));
  const width = Math.max(1, Number((step * 0.62).toFixed(2)));
  const marks = b.map((x, i) => {
    const cx = Number((i * step + step / 2).toFixed(2));
    const up = x.c >= x.o;
    const top = y(Math.max(x.o, x.c));
    const height = Math.max(0.8, Number((y(Math.min(x.o, x.c)) - top).toFixed(2)));
    return `<line x1="${cx}" x2="${cx}" y1="${y(x.h)}" y2="${y(x.l)}" class="${up ? "c-up" : "c-down"}"/><rect x="${Number((cx - width / 2).toFixed(2))}" y="${top}" width="${width}" height="${height}" class="${up ? "c-up" : "c-down"}" data-i="${i}"/>`;
  });
  return { svg: `<svg class="as-chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-hidden="true" focusable="false">${marks.join("")}</svg>`, bars: b, first: b[0], last: b[b.length - 1], hi, lo };
}

/* where an order for it could go: the best venue that is ready for a buy; for a sell, the venue that holds the most of it and trades */
function assetTargets(key, d) {
  const cls = String(key).split(":")[0];
  const L = connected();
  const trades = (id) => { const v = L.find((x) => x.id === id); return !!v && canTrade(v); };
  const rows = ((d && d.compare && d.compare.rows) || []).filter((r) => r.open && r.canTrade !== false && trades(r.venue));
  if (cls === "event") {
    const sym = String(key).slice("event:".length);
    const at = [...((d && d.positions) || []).map((p) => p.venue), ...((d && d.row && d.row.venues) || []).map((l) => l.venue)].find(trades);
    return { buy: at ? { venue: at, symbol: sym, kind: "event" } : null, sell: at && d.row ? { venue: at, symbol: sym, kind: "event" } : null };
  }
  const buy = rows[0] ? { venue: rows[0].venue, symbol: rows[0].symbol, kind: rows[0].kind } : null;
  const held = ((d && d.row && d.row.venues) || []).filter((l) => !l.inTransit && !l.watched && trades(l.venue)).sort((a, b) => b.amount - a.amount)[0];
  const sellRow = held && rows.find((r) => r.venue === held.venue);
  return { buy, sell: held ? { venue: held.venue, ...(sellRow ? { symbol: sellRow.symbol, kind: sellRow.kind } : {}) } : null };
}

/** one asset in the drawer: `key` is a holdings key (crypto:BTC · equity:AAPL · stable:USDC · rwa:USDY · event:<symbol>) */
function openAsset(key) {
  if (!A || !key) return;
  if (ASSET.key !== key) {
    ASSET.key = key;
    ASSET.body = null;
    ASSET.chart = null;
  }
  ASSET.html = "";
  openDrawer('<div class="as" data-as></div>', { title: assetTitle(key, ASSET.body), redraw: () => assetRead(false) });
  const d = $("drawer");
  if (!d.dataset.asWired) {
    d.dataset.asWired = "1";
    d.addEventListener("click", assetClick);
    d.addEventListener("mousemove", assetHover);
  }
  assetDraw();
  assetRead(true);
}

/* ask the account for it again (each load while the drawer is open, and when the bar changes); the latest ask wins */
async function assetRead(now) {
  const box = $("drawer").querySelector("[data-as]");
  if (!box || !ASSET.key) return;
  const my = ++ASSET.seq;
  const body = await api(`/api/account/asset?${new URLSearchParams({ key: ASSET.key, interval: ASSET.interval })}`, { ttl: now ? 0 : 10_000 });
  if (my !== ASSET.seq || !$("drawer").querySelector("[data-as]")) return;
  ASSET.body = body;
  assetDraw();
}

function assetDraw() {
  const box = $("drawer").querySelector("[data-as]");
  if (!box) return;
  const key = ASSET.key;
  const cls = key.split(":")[0];
  const d = ASSET.body;
  const title = $("drawer").querySelector("#drawer-title");
  if (title) title.textContent = assetTitle(key, d);
  if (!d || d.ok === false) ASSET.html = "";
  if (!d) return void (box.innerHTML = '<div class="skel-rows" aria-hidden="true"><span class="skel big"></span><span class="skel"></span><span class="skel"></span></div><p class="sr" role="status">Reading it…</p>');
  if (d.ok === false) return void (box.innerHTML = `<div class="msg no">${esc(refusalOf(d) || "The account did not answer.")}</div>`);
  const row = d.row;
  const owner = owns();
  const t = assetTargets(key, d);
  const ticket = typeof openTicket === "function";
  const agents = A.keys.some((k) => k.status === "ok") && typeof openHandToAgent === "function";
  const price = row && row.price !== undefined ? row.price : ((d.compare && d.compare.rows[0]) || (d.positions[0] && { price: d.positions[0].markPrice }) || {}).price;
  const head = `<div class="as-head">${avatar(cls === "event" ? (key.endsWith(":NO") ? "NO" : "YES") : key.split(":").slice(1).join(":"), "lg")}<div><div class="label">${esc((CLASS[cls] || [cls])[0])}${row && row.changeFrom ? ` · 24h at ${esc(row.changeFrom.venueName)}` : ""}</div><div class="as-val"><span class="num-m">${row ? money(row.usd) : assetPx(cls, price)}</span>${row ? `<span class="dim">${esc(qtyOf(row.amount))} ${esc(cls === "event" ? "contracts" : row.asset)} · ${assetPx(cls, row.price)}</span>` : '<span class="dim">Not held</span>'}${row && row.changePct24h !== undefined ? `<span>${chg(row.changePct24h)} <span class="dim">24h</span></span>` : ""}</div></div></div>`;
  const acts = `<div class="as-acts">${ticket && t.buy ? `<button type="button" class="btn btn-primary" data-as-act="buy"${owner ? "" : " disabled"}>Buy</button>` : ""}${ticket && t.sell ? `<button type="button" class="btn" data-as-act="sell"${owner ? "" : " disabled"}>Sell</button>` : ""}${agents ? `<button type="button" class="btn" data-as-act="hand"${owner ? "" : " disabled"}>${icon("agent", "sm")}Hand to agent</button>` : ""}</div>`;
  const html = `${head}${acts}${assetChartSec(cls, d)}${assetHeld(cls, row)}${assetVenues(cls, d)}${assetPositions(d, owner)}${assetOrders(d, owner)}${assetCost(cls, d)}${assetLines(d)}${assetMissing(d)}`;
  // drawn again only when something in it changed: a focused button keeps its focus through the page's refresh
  if (html !== ASSET.html || !box.firstElementChild) box.innerHTML = html;
  ASSET.html = html;
}

function assetChartSec(cls, d) {
  const c = d.candles ? assetCandles(d.candles.bars) : null;
  ASSET.chart = c;
  const bars = `<div class="seg" role="group" aria-label="Bars">${ASSET_BARS.map(([v, l]) => `<button type="button" data-as-bar="${v}" aria-pressed="${String(v === ASSET.interval)}">${l}</button>`).join("")}</div>`;
  if (!c) return d.candles || cls === "stable" || cls === "cash" ? "" : `<section class="sec as-sec"><div class="sec-head"><div class="label">Price</div>${bars}</div><p class="empty">No venue connected here keeps a price history for it.</p></section>`;
  const move = c.first.o ? ((c.last.c - c.first.o) / c.first.o) * 100 : undefined;
  const span = `${nyDay(new Date(c.first.t).toISOString())} – ${nyDay(new Date(c.last.t).toISOString())}`;
  return `<section class="sec as-sec"><div class="sec-head"><div class="label">Price · ${esc(d.candles.venueName)}</div>${bars}</div><div class="as-plot">${c.svg}<div class="as-read small tab-nums" data-as-read aria-hidden="true"></div></div><p class="small"><span class="sr">From ${esc(span)}: </span>Last ${assetPx(cls, c.last.c)} · ${chg(move)} over ${plural(c.bars.length, "bar")} of ${esc(d.candles.interval)} · high ${assetPx(cls, c.hi)} · low ${assetPx(cls, c.lo)} <span class="dim">· ${esc(d.candles.symbol)}</span></p></section>`;
}

function assetHeld(cls, row) {
  if (!row) return "";
  return `<section class="sec as-sec"><div class="label">Held at</div>${table([
    { label: "Account", cell: (l) => `${esc(l.venueName)}${l.note ? `<span class="why">${esc(l.note)}</span>` : ""}` },
    { label: "Amount", r: true, cell: (l) => esc(qtyOf(l.amount)) },
    { label: "Value", r: true, cell: (l) => (l.noPrice ? '<span class="dim">no price</span>' : money(l.usd)) },
    { label: "", sr: "Status", cell: (l) => [l.inTransit ? '<span class="chip warm">On its way</span>' : "", l.watched ? '<span class="chip">Watched</span>' : "", l.stale ? '<span class="chip bad">Last good read</span>' : ""].join(" ") },
  ], row.venues)}</section>`;
}

function assetVenues(cls, d) {
  const c = d.compare;
  if (!c || (!c.rows.length && !c.missing.length)) return "";
  return `<section class="sec as-sec"><div class="label">Every venue's price · to buy</div>${table([
    { label: "Venue", cell: (r) => `${esc(r.venueName)}${r.best ? ' <span class="tag up">Best</span>' : ""}<span class="why">${esc(r.name)}${r.note ? ` · ${esc(r.note)}` : ""}</span>` },
    { label: "Price", r: true, cell: (r) => `${assetPx(cls, r.price)}<span class="why">${esc(r.priceIs)}</span>` },
    { label: "Spread", r: true, cell: (r) => (r.spreadPct !== undefined ? `${Number(r.spreadPct.toFixed(3))}%` : "—") },
    { label: "", sr: "Status", cell: (r) => (!r.open ? '<span class="chip">Closed</span>' : r.canTrade === false ? '<span class="chip">Key can\'t trade</span>' : r.worse !== undefined && r.worse > 0 ? `<span class="dim small">${Number(r.worse.toFixed(2))}% worse</span>` : "") },
  ], c.rows, { empty: "No connected venue prices it." })}${c.missing.length ? `<ul class="as-miss">${c.missing.map((m) => `<li><b>${esc(m.venueName)}</b>: ${esc(m.why)}</li>`).join("")}</ul>` : ""}</section>`;
}

function assetPositions(d, owner) {
  if (!d.positions.length) return "";
  return `<section class="sec as-sec"><div class="label">Positions</div>${table([
    { label: "Position", cell: (p) => `${esc(p.name)}<span class="why">${esc(p.venueName || nameOf(p.venue))} · ${p.side === "short" ? "short" : "long"} ${esc(qtyOf(p.qty))}${p.leverage ? ` · ${esc(p.leverage)}x` : ""}${p.entryPrice ? ` · entry ${esc(px(p.entryPrice))}` : ""}${p.liquidationPrice ? ` · liquidation ${esc(px(p.liquidationPrice))}` : ""}</span>` },
    { label: "Value", r: true, cell: (p) => (p.usd !== undefined ? money(p.usd) : "—") },
    { label: "P&L", r: true, cell: (p) => chg(p.unrealizedUsd, "$") },
    { cell: (p) => (owner && assetClosable(p.venue) ? `<button type="button" class="btn btn-sm" data-as-close="${esc(p.symbol)}" data-venue="${esc(p.venue)}">Close…</button>` : "") },
  ], d.positions)}</section>`;
}
/* a position can be closed from here: trading is on, the venue trades and lists positions */
const assetClosable = (venue) => { const v = connected().find((x) => x.id === venue); return !!v && canTrade(v) && !!v.trade.positions; };

function assetOrders(d, owner) {
  if (!d.orders.length) return "";
  return `<section class="sec as-sec"><div class="label">Open orders</div>${table([
    { label: "Order", cell: (o) => `${o.side === "buy" ? "Buy" : "Sell"} ${esc(qtyOf(o.qty))} ${esc(o.base)}<span class="why">${esc(o.venueName)} · ${esc(typeof typeText === "function" ? typeText(o) : o.type)} · ${esc(o.agent ? keyName(o.agent) : "you")}</span>` },
    { label: "Filled", r: true, cell: (o) => `${esc(qtyOf(o.filledQty || 0))} of ${esc(qtyOf(o.qty))}` },
    { cell: (o) => (owner && !o.canceling ? `<button type="button" class="btn btn-sm btn-ghost" data-as-cancel="${esc(o.id)}" data-venue="${esc(o.venue)}">Cancel</button>` : o.canceling ? '<span class="st pending">Canceling</span>' : "") },
  ], d.orders)}</section>`;
}

function assetCost(cls, d) {
  const c = d.cost.filter((x) => x.coveredQty > 0 || x.realizedUsd);
  if (!c.length) return d.cost.length ? `<section class="sec as-sec"><div class="label">What you paid</div><p class="empty">${esc(d.cost[0].words)}: the account never saw it bought (it came in from elsewhere, or before the account).</p></section>` : "";
  return `<section class="sec as-sec"><div class="label">What you paid</div>${table([
    { label: "Of it", cell: (x) => `${esc(x.class === "position" ? x.asset : "Held")}<span class="why">${esc(x.words)} · from ${esc(x.source)}</span>` },
    { label: "Avg cost", r: true, cell: (x) => (x.avgCostUsd !== undefined ? assetPx(cls === "event" ? "event" : "", x.avgCostUsd) : "—") },
    { label: "Since bought", r: true, cell: (x) => chg(x.unrealizedUsd, "$") },
    { label: "Realised", r: true, cell: (x) => (x.realizedUsd ? chg(x.realizedUsd, "$") : '<span class="flat">—</span>') },
  ], c)}</section>`;
}

function assetLines(d) {
  if (!d.lines.length) return "";
  return `<section class="sec as-sec"><div class="label">On the statement</div><div class="feed">${d.lines.slice(0, 8).map((l) => `<div><span class="mk ${l.status === "filled" || l.status === "settled" ? "ok" : ["rejected", "failed"].includes(l.status) ? "no" : ""}" aria-hidden="true">${l.status === "filled" || l.status === "settled" ? "✓" : ["rejected", "failed"].includes(l.status) ? "✗" : "·"}</span><div><div class="t1">${esc(l.description)}</div><div class="t2">${esc([l.accountName, l.agentName ? `${l.agentName}` : "you", l.status, `${nyDay(l.at)} ${nyTime(l.at)}`].join(" · "))}</div></div></div>`).join("")}</div>${d.lines.length > 8 ? '<button type="button" class="link dim" data-as-act="statement">All of it in the Statement</button>' : ""}</section>`;
}

function assetMissing(d) {
  return d.missing.length ? `<p class="small dim as-miss-p">Not read this time: ${d.missing.map((m) => `${esc(m.venueName)} (${esc(m.why)})`).join(" · ")}</p>` : "";
}

/* what the drawer's buttons do */
async function assetClick(e) {
  const t = e.target.closest && e.target.closest("button");
  if (!t || !t.closest("[data-as]") || t.disabled) return;
  const d = ASSET.body;
  if (t.dataset.asBar) {
    ASSET.interval = t.dataset.asBar;
    for (const b of t.parentElement.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b === t));
    return void assetRead(true);
  }
  if (t.dataset.asClose) {
    // the Trade pane's close: what it is worth as the account prepared it, refused before the sign button when over this server's cap
    const p = d.positions.find((x) => x.symbol === t.dataset.asClose && x.venue === t.dataset.venue);
    if (p && typeof openClose === "function") openClose(p);
    return;
  }
  if (t.dataset.asCancel) return void own({ type: "liveCancel", venue: t.dataset.venue, order: t.dataset.asCancel });
  const act = t.dataset.asAct;
  const tg = assetTargets(ASSET.key, d);
  const base = (d && d.row && d.row.asset) || ASSET.key.split(":").slice(1).join(":");
  if (act === "buy" || act === "sell") {
    const at = act === "buy" ? tg.buy : tg.sell;
    if (!at) return;
    closeDrawer();
    if (typeof openTicket === "function") openTicket({ ...at, side: act, base, key: ASSET.key });
  } else if (act === "hand" && typeof openHandToAgent === "function") {
    const at = tg.buy || tg.sell || {};
    closeDrawer();
    openHandToAgent({ venue: at.venue || "", symbol: at.symbol || "", side: "buy", ...(at.kind === "event" ? { kind: "predictions" } : {}) });
  } else if (act === "statement") {
    closeDrawer();
    openStatement();
  }
}

/* the bar under the pointer, in figures */
function assetHover(e) {
  const r = e.target.closest && e.target.closest("rect[data-i]");
  const out = $("drawer").querySelector("[data-as-read]");
  if (!out) return;
  const c = ASSET.chart;
  const b = r && c ? c.bars[Number(r.dataset.i)] : null;
  const cls = ASSET.key.split(":")[0];
  out.textContent = b ? `${nyDay(new Date(b.t).toISOString())} ${nyTime(new Date(b.t).toISOString())} · O ${assetPx(cls, b.o)} H ${assetPx(cls, b.h)} L ${assetPx(cls, b.l)} C ${assetPx(cls, b.c)}` : "";
}
