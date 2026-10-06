/* PORTFOLIO — what the owner has, in one place: the net worth and its curve, what waits for the owner (the agents' cards and what they
   asked for), the dollars that are ready, what the money is in, what the agents did, and every asset, position and account — all narrowed
   by the top bar's lens. Every button does what it says through the account's own door: a card approved is the owner's signature on it
   (approveCard), a position closed a signed liveClose, an account disconnected a signed disconnectVenue, and Grant… opens the owner's own
   form for what an agent asked (a limit: approveSpend · a wallet: createSubAccount, or a top-up move · a session, leverage or the mode:
   setPolicy · a venue: its connection), and Decline… is the owner's signed answerAsk. Reads: GET /api/account/holdings?cost=1 · /history ·
   /positions · /agents · /earn. */

/* what the pane keeps between draws: the segment and the curve's range, the last answer of each read, and what each part last drew */
const PF = { tab: "assets", range: "1w", hold: null, holdErr: "", hist: new Map(), pos: null, agents: null, earn: null, last: new Map(), curve: null };
const PF_RANGES = [["1d", "1D"], ["1w", "1W"], ["1m", "1M"], ["all", "All"]];
const PF_TABS = [["assets", "Assets"], ["positions", "Positions"], ["accounts", "Accounts"]];
const PF_RANGE_WORDS = { "1d": "past day", "1w": "past week", "1m": "past month", all: "since the start" };
const r2pf = (n) => Number(Number(n || 0).toFixed(2)) || 0;
const pfDollars = (cls) => cls === "cash" || cls === "stable";
/* the stablecoins an earn product's dollars are counted in */
const PF_DOLLAR_ASSETS = new Set(["USD", "USDC", "USDT", "USDG", "DAI", "PYUSD", "FDUSD", "USDE", "USDS", "TUSD"]);
/* a row worth a dollar a dollar: cash, a stablecoin, or a stablecoin in an earn product */
const pfDollarRow = (r) => pfDollars(r.class) || (r.class === "earn" && PF_DOLLAR_ASSETS.has(String(r.asset || "").toUpperCase()));
/* an agent wallet's place on the account (live/agent-wallet.ts agentWalletVenue) */
const pfWalletVenue = (name) => `agent-${slug(name)}`;

// ---- what the lens lets through ------------------------------------------------------------------------------------------------------

/** the venues the lens shows: every account, one venue, or the wallets of one agent */
function pfVenueIn(l = lensNow()) {
  if (l.kind === "all") return () => true;
  if (l.kind === "venue") return (id) => id === l.id;
  const mine = new Set((A.subAccounts || []).filter((s) => String(s.agent).toLowerCase() === l.id.toLowerCase()).map((s) => pfWalletVenue(s.name)));
  return (id) => mine.has(id);
}
/* the venue a card is about, from what its agent asked (its "venue" field) */
const pfCardVenue = (c) => ((c.shown || []).find((f) => f.name === "venue") || {}).value || "";
/* a card or an ask is in the lens: under an agent, that agent's; under a venue, about that venue */
function pfAboutIn(agent, venue, l = lensNow()) {
  if (l.kind === "all") return true;
  if (l.kind === "agent") return !!agent && String(agent).toLowerCase() === l.id.toLowerCase();
  return venue === l.id;
}

/** holdings rows narrowed to the venues let through: each row keeps only those venues' lines, its amount and dollars added up again */
function pfRowsIn(rows, venueIn) {
  return (rows || []).map((r) => {
    const lines = r.venues.filter((x) => venueIn(x.venue));
    if (lines.length === r.venues.length) return r;
    if (!lines.length) return null;
    return { ...r, venues: lines, amount: Number(lines.reduce((s, x) => s + x.amount, 0).toFixed(10)), usd: r2pf(lines.reduce((s, x) => s + x.usd, 0)) };
  }).filter(Boolean).sort((a, b) => b.usd - a.usd);
}

/** What the rows gained or lost in the last 24 hours, from each row's own 24-hour change as a venue reported it: the dollars now against
 * the same amount at yesterday's price (account/holdings.ts change24h, for rows the lens narrowed). Dollars change by nothing; a row no
 * venue spoke for is left out and named in `missing` */
function pfDayChange(rows) {
  let usd = 0;
  let before = 0;
  let covered = 0;
  let of = 0;
  const missing = [];
  for (const r of rows || []) {
    if (!(r.usd > 0)) continue;
    of += r.usd;
    if (pfDollarRow(r)) {
      covered += r.usd;
      before += r.usd;
      continue;
    }
    const pct = r.changePct24h;
    if (typeof pct !== "number" || !Number.isFinite(pct) || !(pct > -100)) {
      missing.push(r.key);
      continue;
    }
    const then = r.usd / (1 + pct / 100);
    covered += r.usd;
    before += then;
    usd += r.usd - then;
  }
  return { usd: r2pf(usd), ...(covered > 0 && before > 0 ? { pct: r2pf((usd / before) * 100) } : {}), coveredUsd: r2pf(covered), ofUsd: r2pf(of), missing };
}

/** the dollars that are ready, at the venues let through: what can move between the owner's accounts, what stays at its venue (the two add
 * up to what is ready), and — overlapping both — what can trade where it is */
function pfCash(m, venueIn) {
  if (!m) return null;
  const vs = (m.venues || []).filter((v) => venueIn(v.venue));
  const ready = r2pf(vs.reduce((s, v) => s + v.usd, 0));
  const canMove = r2pf(vs.filter((v) => v.movesOut).reduce((s, v) => s + v.usd, 0));
  return { ready, canMove, stays: r2pf(ready - canMove), trades: r2pf(vs.filter((v) => v.tradesHere).reduce((s, v) => s + v.usd, 0)), venues: vs };
}

/** what the money is in: each class's dollars and its share, largest first */
function pfAlloc(rows) {
  const by = {};
  for (const r of rows || []) if (r.usd > 0) by[r.class] = (by[r.class] || 0) + r.usd;
  const total = Object.values(by).reduce((s, x) => s + x, 0);
  if (!(total > 0)) return [];
  return Object.entries(by).map(([cls, usd]) => ({ cls, usd: r2pf(usd), pct: Number(((usd / total) * 100).toFixed(1)) })).sort((a, b) => b.usd - a.usd);
}

/** the net worth curve as two paths in a w × h box (the line, and the area under it), from points oldest first; null with fewer than two */
function pfCurve(points, w = 600, h = 140) {
  const p = (points || []).filter((x) => Number.isFinite(x.usd) && !Number.isNaN(Date.parse(x.at)));
  if (p.length < 2) return null;
  const t0 = Date.parse(p[0].at);
  const ts = Date.parse(p[p.length - 1].at) - t0 || 1;
  const lo = Math.min(...p.map((x) => x.usd));
  const hi = Math.max(...p.map((x) => x.usd));
  const pad = (hi - lo) * 0.1 || Math.max(1, Math.abs(hi) * 0.01);
  const top = hi + pad;
  const span = top - (lo - pad);
  const pts = p.map((x) => [Number((((Date.parse(x.at) - t0) / ts) * w).toFixed(1)), Number((((top - x.usd) / span) * h).toFixed(1))]);
  const line = `M${pts.map(([x, y]) => `${x},${y}`).join("L")}`;
  return { line, area: `${line}L${w},${h}L0,${h}Z`, pts, points: p, lo, hi, w, h, at: (ms) => Number((((ms - t0) / ts) * w).toFixed(1)) };
}

/** what waits for the owner, agent by agent: each agent's cards and its asks */
function pfGroups(cards, asks) {
  const g = new Map();
  const add = (agent, name) => {
    const k = String(agent || "").toLowerCase();
    if (!g.has(k)) g.set(k, { agent: k, name: name || (k ? short(k) : "An agent"), cards: [], asks: [] });
    return g.get(k);
  };
  for (const c of cards || []) add(c.agent, c.agentName).cards.push(c);
  for (const a of asks || []) add(a.agent, a.agentName).asks.push(a);
  return [...g.values()];
}

/** What the agents did, newest first: their orders and payments as the statement has them (✓ done · ✗ refused or failed · · under way),
 * what waits for the owner (▣), what the account refused them on the way (✗, from their flights), and what they reported on the owner's
 * intents (›). Each item names its agent's key and, where it has one, its venue */
function pfActivity({ agents = [], lines = [], intents = [], cards = [] } = {}) {
  const out = [];
  const flightAt = new Map(agents.flatMap((a) => (a.flights || []).map((f) => [f.no, f.at])));
  for (const c of cards) out.push({ at: flightAt.get(c.flight) || "", mark: "▣", cls: "wait", word: "waiting", text: c.reason, sub: `${c.agentName || "An agent"} · waiting for you`, agent: c.agent || "", venue: pfCardVenue(c) });
  for (const l of lines) {
    if (!l.agent) continue;
    const done = l.status === "filled" || l.status === "settled" || l.status === "done";
    const bad = ["rejected", "failed", "returned"].includes(l.status);
    out.push({ at: l.updatedAt || l.at, mark: done ? "✓" : bad ? "✗" : "·", cls: done ? "ok" : bad ? "no" : "", word: done ? "done" : bad ? "refused" : "under way", text: l.description, sub: [l.by || l.agentName, l.status, l.accountName].filter(Boolean).join(" · "), agent: l.agent, venue: l.account });
  }
  for (const a of agents) for (const f of a.flights || []) for (const leg of f.legs || []) if (String(leg).startsWith("✗")) out.push({ at: f.at, mark: "✗", cls: "no", word: "refused", text: f.request, sub: `${a.name} · ${String(leg).slice(1).trim()}`, agent: a.address, venue: "" });
  for (const i of intents) for (const r of i.byAgent || []) out.push({ at: r.at, mark: "›", cls: "say", word: "reported", text: r.note || r.status, sub: `${r.byName} · ${r.status} · on “${i.text}”`, agent: r.by, venue: i.venue });
  return out.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
}

/** the first three steps of a fresh account, ticked from what the account says */
function pfSteps(a) {
  const agents = (a.keys || []).filter((k) => k.status === "ok");
  return [
    { id: "connect", done: (a.venues || []).some((v) => v.live), title: "Connect an account" },
    { id: "agent", done: agents.length > 0, title: "Connect an agent" },
    { id: "limit", done: (a.spend || []).some((s) => !s.expired && s.budgetUsd > 0 && agents.some((k) => k.address === s.agent)), title: "Give it a limit" },
  ];
}

// ---- drawing ----------------------------------------------------------------------------------------------------------------------

/** the Portfolio pane (the shell calls it on every read, on the route and on the lens) */
function renderPortfolio({ el, owner, params = {} }) {
  if (params.view && PF_TABS.some(([v]) => v === params.view)) PF.tab = params.view;
  const mode = connected().length ? "full" : "fresh";
  if (!el.firstElementChild || el.firstElementChild.dataset.pf !== mode) {
    el.innerHTML = mode === "fresh"
      ? '<div class="pf pf-fresh" data-pf="fresh"><div data-pf-part="worth"></div><div data-pf-part="steps"></div><div data-pf-part="waiting"></div></div>'
      : '<div class="pf cols" data-pf="full"><div class="col-main"><div data-pf-part="steps"></div><section class="sec pf-worth" data-pf-part="worth" aria-label="Net worth"></section><div class="quick" data-pf-part="quick"></div><section class="sec pf-table" data-pf-part="table" aria-label="Assets, positions and accounts"></section></div><div class="col-side"><div data-pf-part="waiting"></div><section class="sec pf-cash" data-pf-part="cash" aria-label="Cash ready"></section><section class="sec pf-alloc" data-pf-part="alloc" aria-label="Allocation"></section><section class="sec pf-act" data-pf-part="activity" aria-label="Agent activity"></section></div></div>';
    PF.last.clear();
  }
  pfWire(el);
  pfDraw(el, owner);
  pfRead();
}

/* one part, drawn again only when what it shows changed: a focused button keeps its focus through the page's refresh */
function pfPut(el, part, html) {
  const node = el.querySelector(`[data-pf-part="${part}"]`);
  if (!node) return;
  node.hidden = !html;
  if (PF.last.get(part) === html) return;
  PF.last.set(part, html);
  node.innerHTML = html;
}

function pfDraw(el, owner) {
  const l = lensNow();
  const venueIn = pfVenueIn(l);
  const rows = PF.hold && PF.hold.rows ? pfRowsIn(PF.hold.rows, venueIn) : null;
  pfPut(el, "steps", pfStepsHtml(owner, el.firstElementChild.dataset.pf === "fresh"));
  pfPut(el, "worth", pfWorthHtml(l, venueIn, rows));
  pfPut(el, "waiting", pfWaitingHtml(l, owner));
  if (el.firstElementChild.dataset.pf === "fresh") return;
  pfPut(el, "quick", pfQuickHtml(l, venueIn, owner));
  pfPut(el, "table", pfTableHtml(l, venueIn, rows, owner));
  pfPut(el, "cash", pfCashHtml(venueIn, owner));
  pfPut(el, "alloc", pfAllocHtml(rows));
  pfPut(el, "activity", pfActivityHtml(l));
}
/* draw again when an answer came back, if the Portfolio is still what is shown */
function pfAgain() {
  const el = $("pane-portfolio");
  if (!A || ROUTE.tab !== "portfolio" || !el || !el.querySelector("[data-pf]")) return;
  try {
    pfDraw(el, owns());
  } catch (err) {
    console.error(err);
  }
}

/* the reads behind the pane, each kept a little while (the page reads again every 20 seconds) */
function pfRead() {
  api("/api/account/holdings?cost=1", { ttl: 8_000 }).then((b) => {
    if (b && b.ok) [PF.hold, PF.holdErr] = [b, ""];
    else PF.holdErr = refusalOf(b) || "The account did not answer.";
    pfAgain();
  });
  pfReadHistory();
  if (PF.tab === "positions") pfReadPositions();
  if (A.keys.length) api("/api/account/agents", { ttl: 15_000 }).then((b) => { if (b && b.ok) PF.agents = b; pfAgain(); });
}
function pfReadHistory() {
  const range = PF.range;
  api(`/api/account/history?range=${range}`, { ttl: 60_000 }).then((b) => {
    PF.hist.set(range, b && b.ok ? b : { error: refusalOf(b) || "The account did not answer." });
    pfAgain();
  });
}
function pfReadPositions() {
  api("/api/account/positions", { ttl: 8_000 }).then((b) => {
    PF.pos = b && b.ok ? b : { error: refusalOf(b) || "The account did not answer.", positions: [], missing: [] };
    pfAgain();
  });
  if (connected().some((v) => v.earn)) api("/api/account/earn", { ttl: 15_000 }).then((b) => { PF.earn = b && b.ok ? b : { error: refusalOf(b) || "The account did not answer.", positions: [], missing: [] }; pfAgain(); });
}

/* a toggle of the pane's own (Range, Assets/Positions/Accounts): its markup stays the same from draw to draw, so a part is drawn again
   only when what it shows changed; its clicks are heard by the pane */
const pfSeg = (name, items, on, label) => `<div class="seg" role="group" aria-label="${esc(label)}">${items.map(([v, t]) => `<button type="button" data-pf-${name}="${esc(v)}" aria-pressed="${String(v === on)}">${esc(t)}</button>`).join("")}</div>`;
const pfBtn = (act, label, { cls = "btn", data = {}, off = false, title = "" } = {}) => `<button type="button" class="${cls}" data-pf-act="${act}"${Object.entries(data).map(([k, v]) => ` data-${k}="${esc(v)}"`).join("")}${off ? " disabled" : ""}${title ? ` title="${esc(title)}"` : ""}>${label}</button>`;
const PF_LOOK_ONLY = "This browser can look but not sign";

/* the three steps, until they are done: on a fresh account the page's main content, afterwards a short reminder of what is left */
function pfStepsHtml(owner, fresh) {
  const steps = pfSteps(A);
  if (steps.every((s) => s.done)) return "";
  const n = steps.filter((s) => s.done).length;
  const trading = connected().some(canTrade);
  const asking = A.requests.length;
  const how = {
    connect: ["An exchange, a broker, a wallet or a prediction market, read through its own interface. Nothing moves without your signature.", A.connectLive ? pfBtn("connect", "Connect an account", { cls: "btn btn-primary btn-sm", off: !owner, title: owner ? "" : PF_LOOK_ONLY }) : ""],
    agent: [asking ? `${plural(asking, "agent")} asking to be let in.` : `Copy the command and run it where your agent runs; then let it in here.${A.agentSetup && A.agentSetup.command ? "" : " Run it in this account's folder."}`, `${pfBtn("setup", `${icon("copy", "sm")}Copy setup command`, { cls: "btn btn-sm" })}${asking ? pfBtn("letin", "Let it in…", { cls: "btn btn-primary btn-sm", data: { agent: A.requests[0].address }, off: !owner }) : ""}`],
    limit: [trading ? "It acts only inside a limit you sign: where, how much an order, how much in all. In Conservative each order still waits for you." : "Connect an account that trades first: a limit names where an agent may trade.", pfBtn("limit", "Give a limit…", { cls: "btn btn-primary btn-sm", off: !owner || !trading || !steps[1].done })],
  };
  return `<section class="callout pf-steps" aria-labelledby="pf-steps-h"><div class="pf-steps-h"><h2 class="label warn-t" id="pf-steps-h">${fresh ? "Get started" : "Next steps"} · ${n} of 3</h2></div><ol>${steps.map((s, i) => `<li class="${s.done ? "done" : ""}"><span class="pf-tick" aria-hidden="true">${s.done ? "✓" : i + 1}</span><div><b>${esc(s.title)}</b>${s.done ? '<span class="sr"> (done)</span>' : `<span class="dim small">${esc(how[s.id][0])}</span>`}</div>${s.done ? "" : `<div class="pf-step-acts">${how[s.id][1]}</div>`}</li>`).join("")}</ol></section>`;
}

/* the net worth, today's change and the curve */
function pfWorthHtml(l, venueIn, rows) {
  const L = connected().filter((v) => venueIn(v.id));
  if (!connected().length) return `<section class="sec pf-worth"><div class="label">Net worth</div><div class="num">${money(0)}</div><p class="dim">Nothing is connected yet. Connect an account and what it holds shows here.</p></section>`;
  const usd = l.kind === "all" ? A.liveUsd : L.reduce((s, v) => s + v.usd, 0);
  const label = l.kind === "all" ? "Net worth" : l.kind === "venue" ? `Net worth · ${l.name}` : `${l.name} · agent wallets`;
  const day = !PF.hold ? null : l.kind === "all" ? PF.hold.change24h : pfDayChange(rows || []);
  const missingWords = day && day.missing.length ? `No 24-hour figure for ${day.missing.map((k) => k.split(":").slice(1).join(":")).join(", ")}` : "";
  const today = !day ? '<span class="skel" style="width:180px" aria-hidden="true"></span>' : day.ofUsd > 0 ? `<span>${chg(day.usd, "$")}${day.pct !== undefined ? ` <span class="tab-nums">(${Math.abs(day.pct).toFixed(2)}%)</span>` : ""} <span class="dim">today</span>${day.coveredUsd < day.ofUsd - 0.5 ? ` <span class="dim small" title="${esc(missingWords)}">· on ${money(day.coveredUsd)} of ${money(day.ofUsd)}</span>` : ""}</span>` : '<span class="dim">Nothing priced here yet.</span>';
  const away = l.kind === "all" && A.inFlightUsd ? ` <span class="dim small">· ${money(A.inFlightUsd)} on the way</span>` : "";
  const head = `<div class="pf-worth-h"><div class="pf-worth-n"><div class="label">${esc(label)}</div><div class="num">${money(usd)}</div><div class="pf-today">${today}${away}</div>${PF.holdErr && !PF.hold ? `<div class="msg no">${esc(PF.holdErr)}</div>` : ""}</div>${l.kind === "all" ? pfSeg("range", PF_RANGES, PF.range, "Range") : ""}</div>`;
  if (l.kind !== "all") return `${head}<p class="dim small pf-note">The curve covers all accounts together. ${pfBtn("all", "Show all accounts", { cls: "link" })}</p>`;
  return `${head}${pfCurveHtml(PF.hist.get(PF.range))}`;
}

function pfCurveHtml(h) {
  PF.curve = null;
  if (!h) return '<div class="skel pf-skel-curve" aria-hidden="true"></div>';
  if (h.error) return `<div class="msg no">${esc(h.error)}</div>`;
  const c = pfCurve(h.points);
  if (!c) return `<p class="dim small pf-note">${h.first ? `The curve draws once the account has two points: the first was taken ${esc(nyDay(h.first))} ${esc(nyTime(h.first))}.` : "The curve starts with the account's first snapshot, a few minutes after an account is connected."}</p>`;
  PF.curve = c;
  const since = h.first && Date.parse(h.first) > Date.parse(h.from) + 60_000 ? `since ${nyDay(h.first)}` : PF_RANGE_WORDS[h.range] || "";
  const ticks = (h.events || []).map((e) => { const x = c.at(Date.parse(e.at)); return x >= 0 && x <= c.w ? `<line x1="${x}" x2="${x}" y1="0" y2="${c.h}" class="pf-ev"><title>${esc(`${e.kind === "connect" ? "Connected" : "Disconnected"} ${e.name || e.venue} · ${nyDay(e.at)} ${nyTime(e.at)}`)}</title></line>` : ""; }).join("");
  const first = c.points[0];
  const last = c.points[c.points.length - 1];
  const words = `Net worth from ${money(first.usd)} on ${nyDay(first.at)} to ${money(last.usd)} on ${nyDay(last.at)}; low ${money(c.lo)}, high ${money(c.hi)}`;
  return `<div class="pf-plot"><svg class="spark pf-curve" viewBox="0 0 ${c.w} ${c.h}" preserveAspectRatio="none" role="img" aria-label="${esc(words)}" data-pf-curve><path class="area" d="${c.area}"/><path class="line" d="${c.line}"/>${ticks}<line class="pf-cursor" x1="-10" x2="-10" y1="0" y2="${c.h}"/></svg><div class="pf-read small tab-nums" data-pf-read aria-hidden="true"></div></div><p class="small pf-range">${chg(h.changeUsd, "$")}${h.changePct !== undefined ? ` <span class="tab-nums">(${Math.abs(h.changePct).toFixed(2)}%)</span>` : ""} <span class="dim">${esc(since)}${h.paidOutUsd ? ` · ${money(h.paidOutUsd)} paid out by agents, not counted as a loss` : ""}${h.events && h.events.length ? ` · connections left out of the change` : ""}${h.partial ? " · a venue's last good number is in it" : ""}</span></p>`;
}

/* Trade · Move · Receive · Hand to agent: each shown only where some account (or agent) can do it */
function pfQuickHtml(l, venueIn, owner) {
  const L = connected().filter((v) => venueIn(v.id));
  const off = !owner;
  const t = owner ? "" : PF_LOOK_ONLY;
  const b = [
    L.some(canTrade) ? pfBtn("trade", `${icon("trade")}Trade`, { cls: "quick-card", off, title: t }) : "",
    L.some(canMove) ? pfBtn("move", `${icon("move")}Move`, { cls: "quick-card", off, title: t }) : "",
    L.some(canReceive) ? pfBtn("receive", `${icon("receive")}Receive`, { cls: "quick-card" }) : "",
    typeof openHandToAgent === "function" && A.keys.some((k) => k.status === "ok") ? pfBtn("hand", `${icon("agent")}Hand to agent`, { cls: "quick-card", off, title: t }) : "",
  ].filter(Boolean);
  return b.join("");
}

/* what waits for the owner: the agents' cards and asks, agent by agent, and the agents asking to be let in */
function pfWaitingHtml(l, owner) {
  const cards = A.cards.filter((c) => pfAboutIn(c.agent, pfCardVenue(c), l));
  const asks = (A.asks || []).filter((a) => pfAboutIn(a.agent, a.venue, l));
  const knocks = l.kind === "all" ? A.requests : [];
  const n = cards.length + asks.length + knocks.length;
  if (!n) return "";
  const soonest = cards.map((c) => Date.parse(c.expiresAt)).filter((x) => x > 0).sort((a, b) => a - b)[0];
  const mins = soonest ? Math.max(0, Math.round((soonest - nowMs()) / 60_000)) : 0;
  const off = !owner;
  const card = (c) => `<div class="pf-item"><div class="pf-item-t"><b>${esc(c.reason)}</b><span class="dim small">${fine(c.usd)}${c.expiresAt ? ` · answer by ${esc(pfWhen(c.expiresAt))}` : ""}</span><details class="more"><summary>What it asks</summary><pre>${esc((c.shown || []).filter((f) => f.value !== "" && f.name !== "nonce").map((f) => `${f.name}: ${f.value}`).join("\n"))}</pre></details></div><div class="pf-btns">${pfBtn("reject", "Reject", { cls: "btn btn-sm", data: { card: c.id }, off })}${pfBtn("approve", "Approve", { cls: "btn btn-sm btn-primary", data: { card: c.id }, off })}</div></div>`;
  const ask = (a) => `<div class="pf-item pf-ask"><div class="pf-item-t"><b>${esc(a.text || PF_ASK_WORDS[a.kind] || a.kind)}</b><span class="dim small">${esc([`Asks for ${PF_ASK_WORDS[a.kind] || a.kind}`, a.usd && (a.kind === "limit" || a.kind === "topup") ? money(Number(a.usd)) : "", a.venue ? `at ${pfVenueName(a.venue)}` : "", a.at ? `asked ${pfWhen(a.at)}` : ""].filter(Boolean).join(" · "))}</span>${pfGrantable(a) ? "" : `<span class="dim small">${esc(pfWhyNot(a))}</span>`}</div><div class="pf-btns">${pfBtn("decline", "Decline…", { cls: "btn btn-sm", data: { ask: a.id }, off })}${pfGrantable(a) ? pfBtn("grant", "Grant…", { cls: "btn btn-sm btn-primary", data: { ask: a.id }, off }) : ""}</div></div>`;
  const knock = (r) => `<div class="pf-item pf-ask"><div class="pf-item-t"><b>${esc(r.name || "An agent")} asks to be let in</b><span class="dim small"><span class="mono">${esc(short(r.address))}</span> · ${esc(nyDay(r.at))} ${esc(nyTime(r.at))}</span></div><div class="pf-btns">${pfBtn("letin", "Let in…", { cls: "btn btn-sm btn-primary", data: { agent: r.address }, off })}</div></div>`;
  const groups = pfGroups(cards, asks).map((g) => `<div class="pf-grp"><div class="pf-grp-h"><div class="who">${avatar((A.keys.find((k) => k.address === g.agent) || {}).code || g.name, "sm")}<div><b>${esc(g.name)}</b><span class="dim">${esc([g.cards.length ? plural(g.cards.length, "card") : "", g.asks.length ? plural(g.asks.length, "ask") : ""].filter(Boolean).join(" · "))}</span></div></div>${g.cards.length > 1 ? pfBtn("approve-all", `Approve all ${g.cards.length}`, { cls: "btn btn-sm", data: { agent: g.agent }, off }) : ""}</div>${g.cards.map(card).join("")}${g.asks.map(ask).join("")}</div>`).join("");
  return `<section class="callout pf-wait" aria-labelledby="pf-wait-h"><div class="pf-wait-h"><h2 class="label warn-t" id="pf-wait-h">Waiting for you · ${n}</h2>${soonest ? `<span class="dim small">answer in ${mins < 1 ? "under a minute" : plural(mins, "min")}</span>` : ""}</div>${groups}${knocks.map(knock).join("")}</section>`;
}
/* a venue by its name: a connected one's, or the name of the connection that would connect it */
function pfVenueName(id) {
  const v = A.venues.find((x) => x.id === id);
  if (v) return v.name;
  const o = ((A.connectLive && A.connectLive.options) || []).find((x) => x.kind === id);
  return o ? o.label.split(" · ")[0] : id;
}
/* a time as it is read: today's by the clock, another day's with its day */
const pfWhen = (iso) => (nyDay(iso) === nyDay(A.now) ? nyTime(iso) : `${nyDay(iso)} ${nyTime(iso)}`);
/* what each kind of ask asks for, in words */
const PF_ASK_WORDS = { letIn: "to be let in", limit: "a bigger limit", venue: "a venue connected", topup: "money in its wallet", session: "a new session", leverage: "more leverage", mode: "Aggressive mode" };
/* an ask the owner can grant from here: the form it needs exists on this account */
function pfGrantable(a) {
  if (a.kind === "venue") return !!A.connectLive;
  if (a.kind === "limit") return writesOn();
  if (a.kind === "topup") return writesOn() && (connected().some((v) => canMove(v) && !v.id.startsWith("agent-")) || !A.subAccounts.some((s) => s.agent.toLowerCase() === String(a.agent).toLowerCase()));
  if (a.kind === "session" || a.kind === "leverage") return writesOn() && !!A.dial;
  if (a.kind === "mode") return A.mode !== "open";
  return a.kind === "letIn";
}
const pfWhyNot = (a) => (!writesOn() && a.kind !== "venue" && a.kind !== "mode" && a.kind !== "letIn" ? "This server was started read-only." : a.kind === "mode" ? "Already Aggressive." : a.kind === "topup" ? "None of your accounts can send money from here." : "Nothing here can grant it.");

/* the dollars that are ready, where they can go */
function pfCashHtml(venueIn, owner) {
  if (!PF.hold) return `<div class="label">Cash ready</div>${PF.holdErr ? `<div class="msg no">${esc(PF.holdErr)}</div>` : '<span class="skel" aria-hidden="true"></span>'}`;
  const c = pfCash(PF.hold.money, venueIn);
  const L = connected().filter((v) => venueIn(v.id));
  const acts = `${L.some(canReceive) ? pfBtn("receive", "Receive", { cls: "btn btn-sm" }) : ""}${L.some(canMove) ? pfBtn("move", "Move", { cls: "btn btn-sm", off: !owner }) : ""}`;
  const legend = [[c.canMove, "var(--alloc-crypto)", "Can move between your accounts"], [c.stays, "var(--alloc-cash)", "Stays at its venue"]];
  return `<div class="sec-head"><div><div class="label">Cash ready</div><div class="num-m">${money(c.ready)}</div></div><div class="pf-btns">${acts}</div></div>${c.ready > 0 ? `<div class="bar" aria-hidden="true">${legend.filter(([n]) => n > 0).map(([n, col]) => `<span style="flex:${n};background:${col}"></span>`).join("")}</div><div class="legend-l">${legend.map(([n, col, t]) => `<div><span class="sw-k" style="background:${col}" aria-hidden="true"></span><span>${t}</span><span>${money(n)}</span></div>`).join("")}<div><span class="sw-k pf-sw-none" aria-hidden="true"></span><span>Of it, trades where it is</span><span>${money(c.trades)}</span></div></div><details class="more pf-where"><summary>Where it is</summary>${table([
    { label: "Account", cell: (v) => `${esc(v.venueName)}<span class="why">${esc(v.lines.map((x) => `${x.asset}${x.note ? ` (${x.note})` : ""} ${money(x.usd)}`).join(" · "))}</span>` },
    { label: "Ready", r: true, cell: (v) => money(v.usd) },
    { label: "", sr: "Where it can go", cell: (v) => `<span class="dim small">${esc([v.tradesHere ? "trades here" : "", v.movesOut ? "moves out" : v.why || "stays"].filter(Boolean).join(" · "))}</span>` },
  ], c.venues)}</details>` : `<p class="dim small">No cash or dollar stablecoins here.${L.some(canReceive) ? " Receive some to trade with." : ""}</p>`}`;
}

/* what the money is in */
function pfAllocHtml(rows) {
  const s = pfAlloc(rows);
  if (!rows) return '<div class="label">Allocation</div><span class="skel" aria-hidden="true"></span>';
  if (!s.length) return "";
  return `<div class="label">Allocation</div><div class="bar" aria-hidden="true">${s.map((x) => `<span style="flex:${x.usd};background:${(CLASS[x.cls] || ["", "var(--dim)"])[1]}"></span>`).join("")}</div><div class="legend-l">${s.map((x) => `<div><span class="sw-k" style="background:${(CLASS[x.cls] || ["", "var(--dim)"])[1]}" aria-hidden="true"></span><span>${esc((CLASS[x.cls] || [x.cls])[0])}</span><span>${x.pct}% · ${money(x.usd)}</span></div>`).join("")}</div>`;
}

/* what the agents did */
function pfActivityHtml(l) {
  const venueIn = pfVenueIn(l);
  const items = pfActivity({ agents: (PF.agents && PF.agents.agents) || [], lines: S, intents: A.intents || [], cards: A.cards }).filter((x) => (l.kind === "all" ? true : l.kind === "agent" ? String(x.agent).toLowerCase() === l.id.toLowerCase() : !!x.venue && venueIn(x.venue))).slice(0, 8);
  const none = !A.keys.length ? "No agent is connected yet." : "Nothing from an agent yet.";
  return `<div class="sec-head"><div class="label">Agent activity</div>${pfBtn("statement", "Statement", { cls: "link dim" })}</div>${items.length ? `<div class="feed">${items.map((x) => `<div><span class="mk pf-mk ${x.cls}" aria-hidden="true">${x.mark}</span><div><div class="t1"><span class="sr">${esc(x.word)}: </span>${esc(x.text)}</div><div class="t2">${esc(x.sub)}${x.at ? ` · ${esc(nyTime(x.at))}` : ""}</div></div></div>`).join("")}</div>` : `<p class="empty">${none}</p>`}`;
}

// ---- Assets · Positions · Accounts ------------------------------------------------------------------------------------------------

function pfTableHtml(l, venueIn, rows, owner) {
  const tools = PF.tab === "assets" ? pfCostWords(rows) : PF.tab === "accounts" ? `${A.connectLive ? pfBtn("connect", `${icon("plug", "sm")}Connect an account`, { cls: "btn btn-sm", off: !owner }) : ""}${pfBtn("csv", `${icon("download", "sm")}CSV`, { cls: "btn btn-sm btn-ghost" })}` : "";
  const body = PF.tab === "positions" ? pfPositionsHtml(l, venueIn, owner) : PF.tab === "accounts" ? pfAccountsHtml(venueIn, owner) : pfAssetsHtml(l, rows);
  return `<div class="sec-head pf-tabs">${pfSeg("tab", PF_TABS, PF.tab, "Show")}<span class="tools">${tools}</span></div>${body}`;
}

/* how much of what is held has a known cost */
function pfCostWords(rows) {
  if (!rows || !PF.hold || !PF.hold.cost) return "";
  const held = rows.filter((r) => !pfDollarRow(r) && r.class !== "earn" && r.usd > 0);
  if (!held.length) return "";
  const cost = new Map(PF.hold.cost.map((c) => [c.key, c]));
  const full = held.filter((r) => { const c = cost.get(r.key); return c && c.coveredQty >= c.ofQty * 0.999; }).length;
  const part = held.filter((r) => { const c = cost.get(r.key); return c && c.coveredQty > 0 && c.coveredQty < c.ofQty * 0.999; }).length;
  return `<span class="dim small" title="What the account paid is known from its own orders and from venues that report an entry price; coins that came in from elsewhere have a cost it never saw">Cost known for ${full} of ${held.length}${part ? ` · part of ${part} more` : ""}</span>`;
}

/* an asset's name: an event contract by its question (from the position that holds it), cash by its currency, money in an earn product by
   what is in it */
function pfNameOf(r) {
  if (r.class === "event") {
    const p = ((PF.hold && PF.hold.positions) || []).find((x) => x.symbol === r.asset);
    return p ? p.name : r.asset;
  }
  if (r.class === "earn") return `${r.asset} · earning`;
  return r.class === "cash" ? `Cash · ${r.asset}` : r.asset;
}
/* a price as it is read: an event contract in cents (its chance), a dollar to the cent, anything under a dollar to four figures */
const pfPrice = (r) => (r.price === undefined ? "—" : r.class === "event" ? `${Number((r.price * 100).toFixed(1))}¢` : pfDollarRow(r) || r.price >= 1 ? money(r.price) : `$${px(Number(r.price.toPrecision(4)))}`);
/* the earn products an Earning row is in, venue by venue: the product the row's line names, else the one /earn lists at that venue for that
   asset (PF.earn) — each with what can be taken out of it */
function pfEarnLines(r) {
  // the row names its product (holdings: one row a product, `earn:<venue>:<product>`)
  if (r.earn && r.earn.product) return [{ venue: r.earn.venue, venueName: r.earn.venueName, product: r.earn.product, name: r.earn.name || r.earn.product, asset: r.earn.asset || r.asset, amount: r.amount }];
  const e = PF.earn && !PF.earn.error ? PF.earn : null;
  return (r.venues || []).flatMap((x) => {
    const product = x.product || r.product || "";
    const listed = e ? e.positions.filter((p) => p.venue === x.venue && (product ? p.product === product : String(p.asset).toUpperCase() === String(r.asset).toUpperCase())) : [];
    if (listed.length) return listed.map((p) => ({ venue: p.venue, venueName: p.venueName || x.venueName, product: p.product, name: p.name || x.productName || p.product, asset: p.asset, amount: p.amount }));
    return product ? [{ venue: x.venue, venueName: x.venueName, product, name: x.productName || product, asset: r.asset, amount: x.amount }] : [];
  });
}
/* where an Earning row earns: the venue, the product, its yield as the venue says it */
const pfEarnWhere = (r) => (r.earn ? [r.earn.venueName, r.earn.name, r.earn.apy !== undefined ? `${Number((r.earn.apy * 100).toFixed(2))}% a year` : ""] : [...new Set(r.venues.map((x) => [x.venueName, x.productName].filter(Boolean).join(" · ")))]).filter(Boolean).join(" · ");
/* money can be taken out of an earn product at this venue from here: this browser signs, trading is on, the venue earns and its key may */
const pfEarnOutAt = (venue) => { const v = connected().find((x) => x.id === venue); return owns() && writesOn() && !!v && !!v.earn && v.earn.can !== false; };

function pfAssetsHtml(l, rows) {
  if (!rows) return PF.holdErr ? `<div class="msg no">${esc(PF.holdErr)}</div>` : '<div class="skel-rows" aria-hidden="true"><span class="skel"></span><span class="skel"></span><span class="skel" style="width:60%"></span></div>';
  const cost = new Map(((PF.hold && PF.hold.cost) || []).map((c) => [c.key, c]));
  const chips = (r) => { const names = [...new Set(r.venues.map((x) => x.venueName))]; return names.length > 3 ? `${names.slice(0, 2).map(esc).join(" · ")} · +${names.length - 2}` : names.map(esc).join(" · "); };
  const since = (r) => {
    const c = cost.get(r.key);
    if (pfDollarRow(r) || !c || !(c.coveredQty > 0) || c.unrealizedUsd === undefined) return `<span class="flat" title="${esc(c ? c.words : "")}">—</span>`;
    return `${chg(c.unrealizedUsd, "$")}${c.coveredQty < c.ofQty * 0.999 ? `<span class="why">for ${esc(qtyOf(c.coveredQty))} of ${esc(qtyOf(c.ofQty))}</span>` : ""}`;
  };
  const t = table([
    { label: "Asset", cell: (r) => `<div class="who">${avatar(r.class === "event" ? (r.asset.endsWith(":NO") ? "NO" : "YES") : r.asset)}<div>${r.class === "earn" ? `<b class="pf-name">${esc(pfNameOf(r))}</b><span class="dim">${esc(pfEarnWhere(r))}</span>${r.venues.some((x) => pfEarnOutAt(x.venue)) ? `<span class="pf-earn-act">${pfBtn("earn-row-out", "Withdraw…", { cls: "link", data: { key: r.key } })}</span>` : ""}` : `<button type="button" class="pf-name" data-pf-act="asset" data-key="${esc(r.key)}">${esc(pfNameOf(r))}</button><span class="dim">${chips(r)}</span>`}</div></div>` },
    { label: "Amount", r: true, cell: (r) => `${esc(qtyOf(r.amount))}${r.unpriced ? `<span class="why">${esc(qtyOf(r.unpriced))} unpriced</span>` : ""}` },
    { label: "Price", r: true, cell: (r) => pfPrice(r) },
    { label: "24h", r: true, cell: (r) => (pfDollarRow(r) ? '<span class="flat">—</span>' : `<span title="${esc(r.changeFrom ? `as ${r.changeFrom.venueName} reports it` : "no venue reported it")}">${chg(r.changePct24h)}</span>`) },
    { label: "Value", r: true, cell: (r) => `<b>${money(r.usd)}</b>` },
    { label: l.kind === "all" ? "Since bought" : "Since bought · all", r: true, cell: since },
  ], rows, { empty: l.kind === "agent" ? "Its wallet holds nothing yet." : "Nothing held here yet.", rowAttr: (r) => (r.class === "earn" ? 'class="pf-earn-row"' : `class="click" data-pf-act="asset" data-key="${esc(r.key)}"`) });
  const miss = (PF.hold.missing || []).filter((m) => m.part !== "positions");
  return `${t}${miss.length ? `<p class="small dim pf-miss">Not read this time: ${miss.map((m) => `${esc(m.venueName)} (${esc(m.why)})`).join(" · ")}</p>` : ""}`;
}

function pfPositionsHtml(l, venueIn, owner) {
  if (!PF.pos) return '<div class="skel-rows" aria-hidden="true"><span class="skel"></span><span class="skel" style="width:60%"></span></div>';
  if (PF.pos.error) return `<div class="msg no">${esc(PF.pos.error)}</div>`;
  const list = PF.pos.positions.filter((p) => p.qty > 0 && venueIn(p.venue));
  const closable = (p) => { const v = connected().find((x) => x.id === p.venue); return owner && !!v && canTrade(v) && !!v.trade.positions; };
  const t = table([
    { label: "Position", cell: (p) => `<b>${esc(p.name)}</b><span class="why">${esc([p.venueName || nameOf(p.venue), `${p.side === "short" ? "short" : "long"} ${qtyOf(p.qty)}`, p.leverage ? `${p.leverage}x${p.marginMode ? ` ${p.marginMode}` : ""}` : ""].filter(Boolean).join(" · "))}</span>` },
    { label: "Value", r: true, cell: (p) => (p.usd !== undefined ? money(p.usd) : "—") },
    { label: "Entry · Mark", r: true, cell: (p) => `${p.entryPrice !== undefined ? esc(px(p.entryPrice)) : "—"} · ${p.markPrice !== undefined ? esc(px(p.markPrice)) : "—"}` },
    { label: "Liquidation", r: true, cell: (p) => (p.liquidationPrice ? esc(px(p.liquidationPrice)) : '<span class="flat">—</span>') },
    { label: "P&L", r: true, cell: (p) => chg(p.unrealizedUsd, "$") },
    { cell: (p) => (closable(p) ? pfBtn("close", "Close…", { cls: "btn btn-sm", data: { venue: p.venue, symbol: p.symbol } }) : "") },
  ], list, { empty: l.kind === "agent" ? "An agent's wallet holds coins, not positions." : "Nothing held in positions." });
  const miss = PF.pos.missing.filter((m) => venueIn(m.venue));
  return `${t}${miss.length ? `<ul class="pf-miss-l">${miss.map((m) => `<li><b>${esc(m.venueName)}</b> could not be read: ${esc(m.why)}</li>`).join("")}</ul>` : ""}${pfEarnHtml(venueIn, owner)}`;
}

/* what is in the venues' earn products, with each one's way out (a signed liveEarn withdrawal) */
function pfEarnHtml(venueIn, owner) {
  if (!connected().some((v) => v.earn && venueIn(v.id))) return "";
  const e = PF.earn;
  if (!e) return '<div class="label pf-sub">Earning</div><span class="skel" aria-hidden="true"></span>';
  if (e.error) return `<div class="label pf-sub">Earning</div><div class="msg no">${esc(e.error)}</div>`;
  const list = e.positions.filter((p) => venueIn(p.venue));
  const out = (p) => { const prod = e.products.find((x) => x.venue === p.venue && x.id === p.product); const v = connected().find((x) => x.id === p.venue); return owner && writesOn() && !!v && !!v.earn && v.earn.can !== false && (!prod || prod.canWithdraw); };
  return `<div class="label pf-sub">Earning</div>${table([
    { label: "Product", cell: (p) => `<b>${esc(p.name || p.product)}</b><span class="why">${esc([p.venueName, p.protocol, p.chain].filter(Boolean).join(" · "))}</span>` },
    { label: "In it", r: true, cell: (p) => `${esc(qtyOf(p.amount))} ${esc(p.asset)}${p.pending ? `<span class="why">${esc(qtyOf(p.pending))} on its way</span>` : ""}` },
    { label: "Value", r: true, cell: (p) => (p.usd !== undefined ? money(p.usd) : "—") },
    { label: "Yield", r: true, cell: (p) => (p.apy !== undefined ? `${Number((p.apy * 100).toFixed(2))}%` : "—") },
    { cell: (p) => (out(p) ? pfBtn("earn-out", "Withdraw…", { cls: "btn btn-sm", data: { venue: p.venue, product: p.product } }) : "") },
  ], list, { empty: "Nothing in an earn product." })}${e.missing.filter((m) => venueIn(m.venue)).map((m) => `<p class="small dim">${esc(m.venueName)}: ${esc(m.why)}</p>`).join("")}`;
}

/* how an account is reached, in a few words */
function pfCaption(v) {
  if (v.address) return `${short(v.address)}${v.proven ? "" : " · watched"}`;
  if (/MCP server/.test(v.via || "")) return "Robinhood sign-in";
  const can = /credential can:? ([^·]+)/.exec(v.via || "");
  return `API key${can ? ` · ${can[1].trim()}` : ""}`;
}
/* an account's standing, as chips */
function pfChips(v) {
  const h = (A.health || {})[v.id];
  return [
    v.stale ? `<span class="chip bad" title="${esc(v.stale)}">Read failed</span>` : "",
    !v.stale && h && h.lastFailAt && (!h.lastOkAt || Date.parse(h.lastFailAt) > Date.parse(h.lastOkAt)) ? `<span class="chip bad" title="${esc(h.message || "")}">Not answering</span>` : "",
    canTrade(v) ? '<span class="chip warm">Trades</span>' : "",
    canMove(v) ? '<span class="chip warm">Moves money</span>' : "",
    canReceive(v) ? '<span class="chip">Receives</span>' : "",
    v.earn && v.earn.can !== false ? '<span class="chip">Earns</span>' : "",
    watched(v) ? '<span class="chip">Watched</span>' : "",
    writesOn() && v.trade && v.trade.can === false ? '<span class="chip" title="This key cannot trade">Read-only key</span>' : "",
    !canTrade(v) && !canMove(v) && !canReceive(v) && !watched(v) && !(v.trade && v.trade.can === false) ? '<span class="chip">Read-only</span>' : "",
  ].filter(Boolean).join(" ");
}

function pfAccountsHtml(venueIn, owner) {
  const L = connected().filter((v) => venueIn(v.id));
  const ticket = typeof openTicket === "function";
  const off = !owner;
  return table([
    { label: "Account", cell: (v) => `<div class="who">${avatar(v.name)}<div><b>${esc(v.name)}</b><span class="dim">${esc(pfCaption(v))}</span></div></div>` },
    { label: "Value", r: true, cell: (v) => `${money(v.usd)}${v.asOf ? `<span class="why">as of ${esc(nyTime(v.asOf))}</span>` : ""}` },
    { label: "Status", cell: (v) => `<span class="pf-chips">${pfChips(v)}</span>` },
    { cell: (v) => `<div class="acts pf-acts">${ticket && canTrade(v) ? pfBtn("acct-trade", "Trade…", { cls: "btn btn-sm", data: { venue: v.id }, off }) : ""}${canMove(v) ? pfBtn("acct-move", "Move…", { cls: "btn btn-sm", data: { venue: v.id }, off }) : ""}${pfBtn("acct-details", "Details", { cls: "btn btn-sm btn-ghost", data: { venue: v.id } })}${v.plugged ? pfBtn("acct-off", "Disconnect", { cls: "btn btn-sm btn-ghost", data: { venue: v.id }, off }) : ""}</div>` },
  ], L, { empty: "No account here.", cls: "pf-acct-t" });
}

// ---- what the buttons do ---------------------------------------------------------------------------------------------------------

/* the pane's clicks, heard once on the pane itself (its parts are drawn again and again) */
function pfWire(el) {
  if (el.dataset.pfWired) return;
  el.dataset.pfWired = "1";
  el.addEventListener("click", (e) => {
    const t = e.target.closest && e.target.closest("[data-pf-act], [data-pf-range], [data-pf-tab]");
    if (!t || !el.contains(t) || t.disabled) return;
    if (t.dataset.pfRange) {
      if (PF.range === t.dataset.pfRange) return;
      PF.range = t.dataset.pfRange;
      pfAgain();
      return void pfReadHistory();
    }
    if (t.dataset.pfTab) {
      if (PF.tab === t.dataset.pfTab) return;
      PF.tab = t.dataset.pfTab;
      if (PF.tab === "positions") pfReadPositions();
      return void go("portfolio", { ...ROUTE.params, view: PF.tab }, { replace: true });
    }
    pfAct(t.dataset.pfAct, t.dataset);
  });
  // the curve under the pointer: the point nearest it, in figures
  el.addEventListener("mousemove", (e) => {
    const svg = e.target.closest && e.target.closest("svg[data-pf-curve]");
    const c = PF.curve;
    if (!svg || !c) return;
    const box = svg.getBoundingClientRect();
    const x = ((e.clientX - box.left) / (box.width || 1)) * c.w;
    let i = 0;
    for (let k = 1; k < c.pts.length; k++) if (Math.abs(c.pts[k][0] - x) < Math.abs(c.pts[i][0] - x)) i = k;
    const p = c.points[i];
    const cur = svg.querySelector(".pf-cursor");
    if (cur) for (const a of ["x1", "x2"]) cur.setAttribute(a, String(c.pts[i][0]));
    const out = el.querySelector("[data-pf-read]");
    if (out) out.textContent = `${money(p.usd)} · ${nyDay(p.at)} ${nyTime(p.at)}${p.partial ? " · a venue's last good number" : ""}`;
  });
  el.addEventListener("mouseleave", () => {
    const out = el.querySelector("[data-pf-read]");
    if (out) out.textContent = "";
    const cur = el.querySelector(".pf-cursor");
    if (cur) for (const a of ["x1", "x2"]) cur.setAttribute(a, "-10");
  }, true);
}

async function pfAct(act, d) {
  const l = lensNow();
  switch (act) {
    case "connect": return void (typeof openPicker === "function" && openPicker());
    case "setup": return void copySetup();
    case "letin": return void pfLetIn(A.requests.find((r) => r.address === d.agent) || (A.asks || []).find((a) => a.agent === d.agent && a.kind === "letIn") || { address: d.agent });
    case "limit": return void pfLimitForm({});
    case "trade": return void pfTrade(l.kind === "venue" ? { venue: l.id } : {});
    case "move": return void pfMove(pfVenueIn(l));
    case "receive": return void openReceive(l.kind === "venue" ? l.id : "");
    case "hand": return void (typeof openHandToAgent === "function" && openHandToAgent(l.kind === "agent" ? { agent: l.id } : l.kind === "venue" ? { venue: l.id } : {}));
    case "approve":
    case "reject": {
      const c = A.cards.find((x) => x.id === d.card);
      if (c) await own({ type: "approveCard", card: c.id, action: c.hash, decision: act });
      return;
    }
    case "approve-all": return void pfApproveAll(d.agent);
    case "grant": return void pfGrant((A.asks || []).find((a) => a.id === d.ask));
    case "decline": return void declineAsk((A.asks || []).find((a) => a.id === d.ask));
    case "asset": return void (typeof openAsset === "function" && openAsset(d.key));
    case "close": return void pfClose(d.venue, d.symbol);
    case "earn-out": return void pfEarnOut(d.venue, d.product);
    case "earn-row-out": return void pfEarnRowOut(d.key);
    case "acct-trade": return void pfTrade({ venue: d.venue });
    case "acct-move": return void openLiveMove(d.venue);
    case "acct-details": return void pfDetails(d.venue);
    case "acct-off": return void pfDisconnect(d.venue);
    case "csv": return void downloadBalances();
    case "statement": return void openStatement();
    case "all":
      view.lens = "";
      return void render();
    default:
  }
}

/* the order ticket (the Trade pane's), at a venue when one is named */
function pfTrade(preset) {
  if (typeof openTicket === "function") return openTicket(preset);
  go("trade");
}
/* Move: from the one account that can, or the one picked */
async function pfMove(venueIn) {
  const M = connected().filter((v) => canMove(v) && venueIn(v.id));
  if (!M.length) return;
  const from = M.length === 1 ? M[0].id : await pickSheet("Move money from", M.map((v) => [v.id, v.name, money(v.usd)]), { note: "Only to your own accounts: another exchange of yours, your wallet, an agent wallet." });
  if (from) openLiveMove(from);
}

/* every card one agent is waiting on, approved one after another: each is this browser's signature, and a refusal stops the rest */
async function pfApproveAll(agent) {
  const cs = A.cards.filter((c) => String(c.agent || "").toLowerCase() === agent && pfAboutIn(c.agent, pfCardVenue(c)));
  if (!cs.length) return;
  const name = cs[0].agentName || keyName(agent);
  const total = cs.reduce((s, c) => s + c.usd, 0);
  if (!(await confirmSheet(`Approve all ${cs.length} of ${name}'s cards: up to ${money(total)} in all, each one signed by this browser as you'd sign it alone.`, { title: "Approve all", yes: `Approve ${cs.length}` }))) return;
  for (const c of cs) {
    if (!A.cards.some((x) => x.id === c.id)) continue;
    const r = await own({ type: "approveCard", card: c.id, action: c.hash, decision: "approve" });
    if (!r || refusedAt(r)) break;
  }
}

/* close a position: the Trade pane's close (what it is worth as the account prepared it, refused before the sign button when it is over
   this server's cap for an order) */
function pfClose(venue, symbol) {
  const p = ((PF.pos && PF.pos.positions) || []).find((x) => x.venue === venue && x.symbol === symbol);
  if (p && typeof openClose === "function") openClose(p);
}

/** An agent's ask, turned down: asked first, then the owner's signed answerAsk. The agent reads the no over MCP; nothing on the account
 * changes, and no limit, money or connection is touched */
async function declineAsk(a) {
  if (!a || !owns()) return;
  const who = a.agentName || keyName(a.agent || "");
  const ok = await confirmSheet(`Decline ${who}'s ask${a.text ? `: “${a.text}”` : ` for ${PF_ASK_WORDS[a.kind] || a.kind}`}? It is told no. Nothing on the account changes.`, { title: "Decline the ask", yes: "Decline", no: "Keep it" });
  if (ok) await own({ type: "answerAsk", ask: a.id, decision: "decline" });
}

/* disconnect an account, after a yes: nothing at the venue changes */
async function pfDisconnect(venue) {
  const v = A.venues.find((x) => x.id === venue);
  if (!v) return;
  const ok = await confirmSheet(`Disconnect ${v.name}? Its balances leave this page and agents can no longer trade there. Nothing at ${v.name} itself changes, and you can connect it again.`, { title: "Disconnect", danger: true, yes: "Disconnect" });
  if (ok) {
    closeDrawer();
    await own({ type: "disconnectVenue", venue });
  }
}

/* one account, in the drawer: what it holds, how it is reached, what it can do from here and why not */
function pfDetails(venue) {
  const draw = () => {
    const v = A.venues.find((x) => x.id === venue);
    if (!v) return '<p class="empty">This account is no longer connected.</p>';
    const owner = owns();
    const h = (A.health || {})[v.id];
    const can = v.liveCan && writesOn() && !watched(v) ? ["withdraw", "transfer", "swap"].filter((k) => v.liveCan[k] === true) : [];
    const notes = [
      canTrade(v) ? `Trades ${v.trade.what}.` : "",
      v.trade && v.trade.can === false && writesOn() ? `This key can't trade. ${keyHowFor(v)} Then connect it again.` : "",
      can.length ? `Moves money: ${can.join(", ")}.` : "",
      keyOnlyReads(v) && !canTrade(v) ? "Read-only key: it can receive, not send." : "",
      watched(v) ? "Watched address: nothing is traded or sent from it." : "",
      v.proven ? `Proven yours: ${v.proven}.` : "",
      v.earn ? `Earn: ${v.earn.what}${v.earn.can === false && v.earn.whyNot ? ` · ${v.earn.whyNot}` : ""}.` : "",
      v.noTradeBecause && writesOn() ? v.noTradeBecause : "",
      v.readOnlyBecause && writesOn() && !canTrade(v) ? v.readOnlyBecause : "",
      v.stale ? `Last read failed: ${v.stale}` : "",
      h && h.lastFailAt ? `Last failed ${nyDay(h.lastFailAt)} ${nyTime(h.lastFailAt)}: ${h.message || h.code || ""}` : "",
      h && h.lastOkAt ? `Last answered ${nyTime(h.lastOkAt)}${h.ms ? ` in ${h.ms} ms` : ""}.` : "",
    ].filter(Boolean);
    const ticket = typeof openTicket === "function";
    return `<div class="pf-det"><div class="who">${avatar(v.name, "lg")}<div><b>${esc(v.name)}</b><span class="dim">${esc(pfCaption(v))}</span></div></div><div class="pf-det-v"><div class="label">Value</div><div class="num-m">${money(v.usd)}</div>${v.asOf ? `<span class="dim small">as of ${esc(nyDay(v.asOf))} ${esc(nyTime(v.asOf))}</span>` : ""}</div><div class="pf-chips">${pfChips(v)}</div><div class="as-acts">${ticket && canTrade(v) ? `<button type="button" class="btn btn-sm btn-primary" data-det="trade"${owner ? "" : " disabled"}>Trade…</button>` : ""}${canMove(v) ? `<button type="button" class="btn btn-sm" data-det="move"${owner ? "" : " disabled"}>Move…</button>` : ""}${canReceive(v) ? '<button type="button" class="btn btn-sm" data-det="receive">Receive</button>' : ""}<button type="button" class="btn btn-sm btn-ghost" data-det="lens">Show only this</button></div><section class="sec as-sec"><div class="label">Holds</div>${table([
      { label: "Asset", cell: (x) => `${esc(x.asset)}${x.note ? `<span class="why">${esc(x.note)}</span>` : ""}` },
      { label: "Amount", r: true, cell: (x) => esc(qtyOf(x.amount)) },
      { label: "Value", r: true, cell: (x) => (x.usd ? money(x.usd) : '<span class="dim">no price</span>') },
    ], (v.holdings || []).filter((x) => x.amount), { empty: "Nothing held there." })}</section><section class="sec as-sec"><div class="label">From here</div><ul class="pf-notes">${notes.map((x) => `<li>${esc(x)}</li>`).join("") || "<li>Read only.</li>"}</ul>${v.via ? `<p class="small dim">${esc(v.via)}</p>` : ""}</section>${v.plugged ? `<div class="end"><button type="button" class="btn btn-sm btn-danger" data-det="off"${owner ? "" : " disabled"}>Disconnect…</button></div>` : ""}</div>`;
  };
  const v = A.venues.find((x) => x.id === venue);
  if (!v) return;
  let drawn = draw();
  const body = openDrawer(drawn, { title: v.name, redraw: () => { const html = draw(); if (html !== drawn) [body.innerHTML, drawn] = [html, html]; } });
  body.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("button[data-det]");
    if (!b || b.disabled) return;
    const act = b.dataset.det;
    if (act === "off") return void pfDisconnect(venue);
    closeDrawer();
    if (act === "trade") pfTrade({ venue });
    else if (act === "move") openLiveMove(venue);
    else if (act === "receive") openReceive(venue);
    else if (act === "lens") {
      view.lens = `venue:${venue}`;
      render();
    }
  });
}

// ---- granting what an agent asked -----------------------------------------------------------------------------------------------------

/* each kind of ask, answered by the owner's own form or signature: the account closes the ask once the answer went through */
async function pfGrant(a) {
  if (!a || !pfGrantable(a)) return;
  if (a.kind === "limit") return pfLimitForm({ agent: a.agent, venue: a.venue, usd: a.usd, ask: a });
  if (a.kind === "letIn") return pfLetIn({ address: a.agent, name: a.agentName });
  if (a.kind === "venue") return pfConnectVenue(a.venue);
  if (a.kind === "topup") {
    const sub = A.subAccounts.find((s) => s.agent.toLowerCase() === String(a.agent).toLowerCase());
    return sub ? topUpFrom(pfWalletVenue(sub.name), a.usd) : pfWalletForm(a);
  }
  if (a.kind === "session") {
    const d = A.dial;
    if (await confirmSheet(`${d.sessionEnded ? "Start a new session" : "Renew the agents' session"}: they may act for 30 more days, still only inside their limits.${a.text ? ` ${a.agentName} said: “${a.text}”` : ""}`, { title: "Agents' session", yes: d.sessionEnded ? "Start it" : "Renew" })) await own({ type: "setPolicy", change: "session", value: "30d" });
    return;
  }
  if (a.kind === "leverage") {
    const now = Number(A.dial.maxLeverage) || 1;
    const steps = [...new Set([1, 2, 3, 5, 10, 20, now])].sort((x, y) => x - y);
    const v = await pickSheet("The most leverage an agent may set", steps.map((n) => [n, `${n}x`, n === now ? "now" : n === 1 ? "none" : ""]), { current: now, note: `${a.agentName} asks: ${a.text || "more leverage"}. On a perpetual, at a venue that sets leverage from here.` });
    if (v !== null && Number(v) !== now) await own({ type: "setPolicy", change: "maxLeverage", value: String(v) });
    return;
  }
  if (a.kind === "mode" && (await confirmSheet(`Switch to Aggressive: agents' orders inside their limits go at once, without a card. ${a.agentName} said: “${a.text || "Aggressive mode"}”`, { title: "Aggressive mode", yes: "Switch" }))) await setMode("open");
}

/* a venue an agent asked for: its own connection form, or every way of connecting when the page has no form for it by name */
function pfConnectVenue(venue) {
  if (typeof openConnect !== "function" || typeof optionOf !== "function") return;
  const opts = (A.connectLive && A.connectLive.options) || [];
  const byKind = optionOf(venue);
  if (byKind) return void openConnect(byKind, { name: byKind.label.split(" · ")[0] });
  const ex = opts.find((o) => o.kind === "exchange" && (o.venues || []).includes(venue));
  if (ex) return void openConnect(ex, { exchange: venue });
  const any = opts.find((o) => (o.venues || []).includes(venue));
  if (any) return void openConnect(any, {});
  openPicker();
}

/* a limit for an agent: where it may act, how much one order (or move) may be, how much in all, until when — the owner's approveSpend */
function pfLimitForm({ agent = "", venue = "", usd = "", ask = null } = {}) {
  const keys = A.keys.filter((k) => k.status === "ok");
  if (!keys.length) return void toast("Let an agent in first: a limit is given to an agent.", "no");
  const L = connected();
  const scopes = [["trade", "Trading", L.filter(canTrade)], ["venues", "Moving money between your accounts", [...L.filter(canMove), ...L.filter((v) => v.id.startsWith("agent-") && !canMove(v))]], ["earn", "Putting money into earn products", L.filter((v) => v.earn && v.earn.can !== false)]].filter(([, , vs]) => vs.length);
  if (!scopes.length) return void toast("No connected account trades or moves money from here, so there is nothing to give a limit for.", "no");
  const who = keys.find((k) => k.address === String(agent).toLowerCase()) || keys[0];
  const had = (a, scope) => A.spend.find((s) => s.agent === a && s.scope === scope && !s.expired);
  const start = had(who.address, "trade");
  const cap = (A.connectLive && A.connectLive.writes && A.connectLive.writes.capUsd) || 0;
  const budget = Number(usd) > 0 ? Number(usd) : start ? start.budgetUsd : 100;
  const per = start ? Math.min(start.perPaymentUsd, budget) : Math.min(cap || budget, budget);
  /* each kind of limit starts from the one of that kind the agent has now, and the venue it asked about. Every account starts ticked only
     when the owner opens the form without an ask and the agent has no such limit: an ask never widens itself to every account, and one
     about a venue this limit can't cover from here starts with nothing ticked beyond what the agent has, and says so */
  const boxes = scopes.map(([scope, , vs], i) => {
    const prior = ((had(who.address, scope) || {}).allow || []).filter((id) => vs.some((v) => v.id === id));
    const now = new Set([...prior, ...(venue && vs.some((v) => v.id === venue) ? [venue] : [])]);
    const all = !now.size && !ask && !venue;
    const outside = venue && !vs.some((v) => v.id === venue) ? `<p class="dim small">It asked about ${esc(nameOf(venue))}, which ${scope === "trade" ? "can't trade" : scope === "earn" ? "can't put money to earn" : "can't move money"} from here: tick where it may.</p>` : "";
    return `<fieldset class="pf-allow" data-scope="${scope}"${i ? " hidden" : ""}><legend>Where</legend><div class="pf-allow-box">${outside}${vs.map((v) => `<label class="chk1"><input type="checkbox" name="allow-${scope}" value="${esc(v.id)}"${all || now.has(v.id) ? " checked" : ""} /> ${esc(v.name)}</label>`).join("")}</div></fieldset>`;
  }).join("");
  const q = quoteDialog({
    title: "Give a limit",
    sub: ask ? `${esc(ask.agentName)} asked: “${esc(ask.text || "a bigger limit")}”${ask.usd ? ` · ${esc(money(Number(ask.usd)))}` : ""}. A limit is the most it may do on its own; in Conservative each order still waits for you.` : "The most an agent may do on its own. In Conservative each order still waits for you; in Aggressive it goes at once inside this limit.",
    fields: `<div class="row2">${field("Agent", select("agent", keys.map((k) => [k.address, k.name]), who.address))}${field("For", select("scope", scopes.map(([sc, t]) => [sc, t]), scopes[0][0]))}</div>${boxes}<div class="row2">${field("Each one up to ($)", `<input name="per" inputmode="decimal" autocomplete="off" value="${esc(String(per))}" />`)}${field("In all ($)", `<input name="budget" inputmode="decimal" autocomplete="off" value="${esc(String(budget))}" />`)}</div>${field("Until", select("days", [["1", "1 day"], ["7", "7 days"], ["30", "30 days"], ["90", "90 days"], ["180", "180 days"]], "30"))}`,
    go: "Sign the limit",
    draft(form) {
      const f = new FormData(form);
      const scope = String(f.get("scope"));
      const allow = f.getAll(`allow-${scope}`).map(String);
      const p = String(f.get("per") || "").trim();
      const b = String(f.get("budget") || "").trim();
      if (!allow.length) return "Pick at least one account.";
      if (!(Number(b) > 0) || !(Number(p) > 0)) return "Type how much each one may be, and how much in all.";
      if (Number(p) > Number(b)) return "Each one can't be more than the whole.";
      return { type: "approveSpend", agent: String(f.get("agent")), scope, allow: allow.join(","), perPayment: p, budget: b, windowHours: 0, validUntil: nowMs() + Number(f.get("days")) * DAY };
    },
    show(p) {
      const a = p.action;
      const name = keyName(a.agent);
      const before = had(a.agent, a.scope);
      const what = { trade: "trade at", venues: "move money between", earn: "put money to earn at" }[a.scope] || a.scope;
      return `<div class="big"><span>${esc(name)} may ${esc(what)} ${esc(a.allow.split(",").map(nameOf).join(", "))}</span></div><div class="path">Up to <b>${esc(money(Number(a.perPayment)))}</b> each, <b>${esc(money(Number(a.budget)))}</b> in all, until ${esc(nyDay(new Date(a.validUntil).toISOString()))}.${cap ? ` No single order goes over ${esc(money(cap))} on this server.` : ""}</div>${before ? `<div class="path">It replaces the limit it has now: ${esc(money(before.perPaymentUsd))} each, ${esc(money(before.spentUsd))} of ${esc(money(before.budgetUsd))} used.</div>` : ""}`;
    },
    done: (r, p) => `Limit signed for ${keyName(p.action.agent)}.`,
  });
  // the boxes follow the kind of limit
  q.form.addEventListener("change", (e) => {
    if (e.target.name !== "scope") return;
    for (const fs of q.form.querySelectorAll("fieldset[data-scope]")) fs.hidden = fs.dataset.scope !== e.target.value;
  });
}

/* an agent let in: its key, its name, for how long — the owner's approveAgent. It may do nothing until it has a limit */
function pfLetIn(r) {
  quoteDialog({
    title: "Let an agent in",
    sub: "It can read the account and ask you for things. It acts only inside a limit you give it next.",
    fields: `${field("Name", `<input name="name" maxlength="32" autocomplete="off" value="${esc(r.name || r.agentName || "")}" />`)}${field("Key address", `<input name="address" autocomplete="off" spellcheck="false" value="${esc(r.address || "")}" />`)}${field("For", select("days", [["1", "1 day"], ["7", "7 days"], ["30", "30 days"], ["90", "90 days"]], "30"))}`,
    go: "Let it in",
    draft(form) {
      const f = new FormData(form);
      const name = String(f.get("name") || "").trim();
      const address = String(f.get("address") || "").trim();
      if (!name) return "Give it a name.";
      if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return "Its key's address is 0x and 40 characters.";
      return { type: "approveAgent", agentAddress: address.toLowerCase(), agentName: name, validUntil: nowMs() + Number(f.get("days")) * DAY };
    },
    show: (p) => `<div class="big"><span>${esc(p.action.agentName)} · ${esc(short(p.action.agentAddress))}</span></div><div class="path">May act on this account until ${esc(nyDay(new Date(p.action.validUntil).toISOString()))}, only inside the limits you give it.</div>`,
    done: (r2, p) => `${p.action.agentName} is in. Give it a limit next.`,
  });
}

/* an agent wallet made for an agent that asked for money and has none: the owner's createSubAccount (filled with a move afterwards) */
function pfWalletForm(a) {
  quoteDialog({
    title: "An agent wallet",
    sub: `${esc(a.agentName)} asked: “${esc(a.text || "money in its wallet")}”. The account holds the wallet's key; the agent never sees it. Fill it from one of your accounts once it is made.`,
    fields: `<div class="row2">${field("Name", `<input name="name" maxlength="16" autocomplete="off" value="${esc(String(a.agentName || "agent").replace(/[^A-Za-z0-9 _-]/g, "").slice(0, 16))}" />`)}${field("Keeps up to ($)", `<input name="float" inputmode="decimal" autocomplete="off" value="${esc(String(Number(a.usd) > 0 ? a.usd : 50))}" />`)}</div>`,
    go: "Make it",
    draft(form) {
      const f = new FormData(form);
      const name = String(f.get("name") || "").trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9 _-]{0,15}$/.test(name)) return "A name of letters and digits, up to 16.";
      if (!(Number(f.get("float")) > 0)) return "How much it keeps at most.";
      return { type: "createSubAccount", name, agent: String(a.agent).toLowerCase(), float: String(f.get("float")).trim() };
    },
    show: (p) => `<div class="big"><span>${esc(p.action.name)} · for ${esc(keyName(p.action.agent))}</span><span>up to ${esc(money(Number(p.action.float)))}</span></div><div class="path">It pays only inside the payees limit you give the agent.</div>`,
    done: (r2, p) => `Agent wallet ${p.action.name} made. Top it up from Agents or Move.`,
  });
}

/* money out of an earn product listed under Positions › Earning */
function pfEarnOut(venue, product) {
  const e = PF.earn;
  const p = e && e.positions.find((x) => x.venue === venue && x.product === product);
  if (p) pfEarnWithdraw(p);
}
/* money out of an Earning row under Assets: the product it is in (the one picked, when it is in more than one) */
async function pfEarnRowOut(key) {
  const r = ((PF.hold && PF.hold.rows) || []).find((x) => x.key === key && x.class === "earn");
  if (!r) return;
  // which product the money is in comes from /earn when the row does not name it
  if (!PF.earn && !(r.earn && r.earn.product) && r.venues.some((x) => !x.product && !r.product)) {
    const b = await api("/api/account/earn", { ttl: 15_000 });
    PF.earn = b && b.ok ? b : { error: refusalOf(b) || "The account did not answer.", positions: [], products: [], missing: [] };
  }
  const lines = pfEarnLines(r).filter((x) => pfEarnOutAt(x.venue));
  if (!lines.length) return void toast(PF.earn && PF.earn.error ? PF.earn.error : `No earn product with ${r.asset} in it answers from here.`, "no");
  const i = lines.length === 1 ? 0 : await pickSheet(`Withdraw ${r.asset} from`, lines.map((x, n) => [n, `${x.name} · ${x.venueName}`, `${qtyOf(x.amount)} ${x.asset}`]));
  if (i !== null && lines[i]) pfEarnWithdraw(lines[i]);
}
/* money out of an earn product, back where it came from: the owner's liveEarn withdrawal, quoted by the venue. `p` { venue, venueName,
   product, name, asset, amount } */
function pfEarnWithdraw(p) {
  const product = p.product;
  const venue = p.venue;
  const prod = PF.earn && !PF.earn.error ? (PF.earn.products || []).find((x) => x.venue === venue && x.id === product) : null;
  quoteDialog({
    title: "Withdraw from earn",
    sub: `${esc(p.name || product)} at ${esc(p.venueName || nameOf(venue))}: ${esc(qtyOf(p.amount))} ${esc(p.asset)} in it.`,
    fields: field(`Amount (${esc((prod && prod.asset) || p.asset)})`, `<input name="amount" inputmode="decimal" autocomplete="off" value="${esc(String(p.amount))}" />`),
    go: "Sign and withdraw",
    draft(form) {
      const amount = String(new FormData(form).get("amount") || "").trim();
      if (!(Number(amount) > 0)) return "How much to take out.";
      return { type: "liveEarn", venue, kind: "withdraw", product, asset: (prod && prod.asset) || p.asset, amount };
    },
    show(pr) {
      const q = (pr.quote && pr.quote.earn) || {};
      return `<div class="big"><span>${esc(q.words || `withdraw ${pr.action.amount} ${pr.action.asset}`)}</span><span>${q.usd !== undefined ? esc(money(q.usd)) : ""}</span></div><div class="path">Lands in <b>${esc(q.lands || pr.action.lands || "")}</b>${q.lockDays ? ` after ${esc(plural(q.lockDays, "day"))}` : ""}.${q.note ? ` ${esc(q.note)}` : ""}</div>`;
    },
    // what is held, and what is in the products, are read again rather than kept
    done: () => {
      forget("/api/account/holdings");
      forget("/api/account/earn");
      return "";
    },
  });
}
