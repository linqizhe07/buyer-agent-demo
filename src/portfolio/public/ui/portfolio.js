/* PORTFOLIO — what the owner has, in one place: the net worth and its curve, what waits for the owner (the agents' cards and what they
   asked for), the agents at work (the owner's words to them and what they did), the dollars that are ready, what the money is in, and
   every asset, position and account — all narrowed by the top bar's lens. Every button does what it says through the account's own door:
   a card approved is the owner's signature on it (approveCard), a position closed a signed liveClose, an account disconnected a signed
   disconnectVenue, an account closed to agents a free POST /api/revoke and reopened a signed setPolicy restore, a key that can't trade
   replaced through a signed disconnect and the venue's own connect form, and Grant… opens the owner's own form for what an agent asked
   (a limit: approveSpend · a wallet: createSubAccount, or a top-up move · a session, leverage or the mode: setPolicy · a venue: its
   connection), and Decline… is the owner's signed answerAsk. Money already held goes to its own sheets: Earn… and an earn row's Withdraw…
   open the Earn sheet (ui/earn.js openEarn), Sell many… the Sell many sheet (openSellMany). Reads: GET /api/account/holdings?cost=1 ·
   /history · /positions · /agents (· /earn, to find which product an earn row is in). */

/* what the pane keeps between draws: the segment and the curve's range, the last answer of each read, what the curve last drew, the key
   of the intents last mounted under Agents at work, and the card a "Review" elsewhere asked to be shown */
const PF = { tab: "assets", range: "1w", hold: null, holdErr: "", hist: new Map(), pos: null, agents: null, earn: null, curve: null, intentsKey: "", hiWant: "", soon: false, hover: null };
const PF_RANGES = [["1d", "1D"], ["1w", "1W"], ["1m", "1M"], ["all", "All"]];
const PF_TABS = [["assets", "Assets"], ["positions", "Positions"]];
const PF_RANGE_WORDS = { "1d": "past day", "1w": "past week", "1m": "past month", all: "since the start" };
const r2pf = (n) => Number(Number(n || 0).toFixed(2)) || 0;
const pfDollars = (cls) => cls === "cash" || cls === "stable";
/* a row worth a dollar a dollar: cash, a stablecoin, or a dollar stablecoin (as the account lists them, core isDollar) in an earn product */
const pfDollarRow = (r) => pfDollars(r.class) || (r.class === "earn" && isDollar(r.asset));
/* an agent wallet's place on the account (live/agent-wallet.ts agentWalletVenue) */
const pfWalletVenue = (name) => `agent-${slug(name)}`;
/* a venue's sentence without its full stop, so it reads on in another */
const pfSaid = (t) => String(t || "").trim().replace(/[.\s]+$/, "");
/* the connections the owner signed whose venues have not answered this network yet (connectLive.waiting): on the account, waiting, read
   nowhere. The account asks each venue again when a check of this network finds it answering, and sends it nothing until then */
const pfWaiting = (venueIn = () => true, a = A) => (((a && a.connectLive) || {}).waiting || []).filter((w) => venueIn(w.venue));
/* a waiting connection that a restart could not bring back carries what its venue held at its last good read (lastUsd, lastAt): shown dim
   on its row, counted in no total */
const pfLastRead = (w) => !!w && w.lastUsd !== undefined && w.lastUsd !== null && Number.isFinite(Number(w.lastUsd));

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

/** what the money is in: each class's dollars and its share, largest first. Money in an earn product is still the dollar or the coin it is
 * (the Assets rows say where it earns), so it counts with them, not as a class of its own */
function pfAlloc(rows) {
  const by = {};
  for (const r of rows || []) {
    if (!(r.usd > 0)) continue;
    const cls = r.class === "earn" ? (isDollar(r.asset) ? "stable" : "crypto") : r.class;
    by[cls] = (by[cls] || 0) + r.usd;
  }
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
function pfGroups(cards, asks, mems) {
  const g = new Map();
  const add = (agent, name) => {
    const k = String(agent || "").toLowerCase();
    if (!g.has(k)) g.set(k, { agent: k, name: name || (k ? short(k) : "An agent"), cards: [], asks: [], mems: [] });
    return g.get(k);
  };
  for (const c of cards || []) add(c.agent, c.agentName).cards.push(c);
  for (const a of asks || []) add(a.agent, a.agentName).asks.push(a);
  // what an agent learned while the owner asks to be asked first (Account › Memory): kept only on the owner's yes
  for (const m of mems || []) add(m.agent, m.agentName).mems.push(m);
  return [...g.values()];
}

/** What the agents did, newest first — done ✓ or refused ✗, nothing else: their orders and payments as the statement has them, and what
 * the account refused them on the way (from their flights). What waits for the owner is under Waiting for you; what they report on the
 * owner's words is under the words themselves (Agents at work). Each item names its agent's key and, where it has one, its venue */
function pfAgentLines({ agents = [], lines = [] } = {}) {
  const out = [];
  for (const l of lines) {
    if (!l.agent) continue;
    const done = l.status === "filled" || l.status === "settled" || l.status === "done";
    const bad = ["rejected", "failed", "returned"].includes(l.status);
    if (!done && !bad) continue;
    out.push({ at: l.updatedAt || l.at, mark: done ? "✓" : "✗", cls: done ? "ok" : "no", word: done ? "done" : "refused", text: l.description, sub: [l.by || l.agentName, l.status, l.accountName].filter(Boolean).join(" · "), agent: l.agent, venue: l.account });
  }
  for (const a of agents) for (const f of a.flights || []) for (const leg of f.legs || []) if (String(leg).startsWith("✗")) out.push({ at: f.at, mark: "✗", cls: "no", word: "refused", text: f.request, sub: `${a.name} · ${String(leg).slice(1).trim()}`, agent: a.address, venue: "" });
  return out.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
}

/** the first three steps of a fresh account, ticked from what the account says */
function pfSteps(a) {
  const agents = (a.keys || []).filter((k) => k.status === "ok");
  return [
    // a connection waiting for its venue to answer this network is on the account too: the step is done. One the venue refused (stopped)
    // is not connected until the owner connects it again
    { id: "connect", done: (a.venues || []).some((v) => v.live) || pfWaiting(() => true, a).some((w) => !w.stopped), title: "Connect an account" },
    { id: "agent", done: agents.length > 0, title: "Connect an agent" },
    { id: "limit", done: (a.spend || []).some((s) => !s.expired && s.budgetUsd > 0 && agents.some((k) => k.address === s.agent)), title: "Give it a limit" },
  ];
}

// ---- what an account can do from here, in words (moved here from the Venues board) --------------------------------------------------

/** a venue's health, as its reads went: `bad` when the last read failed, `read` when it ever answered, `away` when it does not serve the
 * network the account runs on now (its place rule, or the server in front of it): a state, said as one, not a read that failed — its
 * numbers are the last good read's, and it is asked again when a check of this network finds it answering */
function pfHealth(v) {
  const h = (A.health || {})[v.id] || {};
  const failed = h.lastFailAt && (!h.lastOkAt || Date.parse(h.lastFailAt) >= Date.parse(h.lastOkAt));
  if (v.notServed || (failed && h.code === "E_VENUE_GEOBLOCKED")) return { bad: false, away: true, read: !!(h.lastOkAt || v.asOf), text: `${pfSaid((v.notServed && v.notServed.said) || h.message) || `${v.name} does not serve this location`}. Its numbers are from the last good read${v.asOf ? ` at ${nyTime(v.asOf)}` : ""}; it is asked again when a check of this network finds it answering.` };
  if (failed) return { bad: true, read: !!h.lastOkAt, text: `Didn't answer at ${nyTime(h.lastFailAt)}: ${pfSaid(h.message || h.code)}.` };
  if (v.stale) return { bad: true, read: true, text: `Last read failed: ${pfSaid(v.stale)}.` };
  if (h.lastOkAt) return { bad: false, read: true, text: `Answered at ${nyTime(h.lastOkAt)}${h.ms !== undefined ? ` · ${h.ms} ms` : ""}` };
  return { bad: false, read: !!v.asOf, text: v.asOf ? `Read at ${nyTime(v.asOf)}` : "Not read yet" };
}
/** what a connected venue trades from here, or why not — and whether a new key would fix it (`rekey`: the key can't trade and the
 * connection it was made with is still offered here, so a key that can is connected in its place) */
function pfTrades(v) {
  if (!writesOn()) return { can: false, text: "Read-only: this server places no orders." };
  if (watched(v)) return { can: false, text: "Watched address: nothing is traded from it." };
  // close-only on this network: what is held there is sold or closed from here, and nothing new is bought
  if (canTrade(v) && v.closeOnly) return { can: true, text: "Sells only on this network: what you hold there can be sold or closed; nothing new is bought." };
  if (canTrade(v)) return { can: true, text: `Trades ${v.trade.what}.` };
  if (v.trade && v.trade.can === false) return { can: false, rekey: typeof connectorOfVenue === "function" && !!connectorOfVenue(v), text: `This key can't trade. ${typeof keyHowFor === "function" ? keyHowFor(v) : ""}`.trim() };
  // nothing is placed here from the account: the venue's own words (as it said them), or what its way in gives
  return { can: false, text: pfSaid(readOnlyWords(v)) };
}

// ---- drawing ----------------------------------------------------------------------------------------------------------------------

/** the Portfolio pane (the shell calls it on every read, on the route and on the lens) */
function renderPortfolio({ el, owner, params = {} }) {
  if (params.view && PF_TABS.some(([v]) => v === params.view)) PF.tab = params.view;
  // the accounts were a third view here; they are the Account's Venues now (round 7, F5): an old link goes there
  if (params.view === "accounts") queueMicrotask(() => go("venues", {}, { replace: true }));
  const mode = connected().length ? "full" : "fresh";
  if (!el.firstElementChild || el.firstElementChild.dataset.pf !== mode) {
    el.innerHTML = mode === "fresh"
      ? '<div class="pf pf-fresh" data-pf="fresh"><div data-pf-part="worth"></div><div data-pf-part="steps"></div><div data-pf-part="waiting"></div></div>'
      : '<div class="pf cols" data-pf="full"><div class="col-main"><div data-pf-part="steps"></div><section class="sec pf-worth" data-pf-part="worth" aria-label="Net worth"></section><div class="quick" data-pf-part="quick"></div><section class="sec pf-table" data-pf-part="table" aria-label="Assets, positions and accounts"></section></div><div class="col-side"><div data-pf-part="waiting"></div><section class="sec pf-agents" data-pf-part="agents" aria-label="Agents at work"></section><section class="sec pf-cash" data-pf-part="cash" aria-label="Cash ready"></section><section class="sec pf-alloc" data-pf-part="alloc" aria-label="Allocation"></section></div></div>';
  }
  pfWire(el);
  pfDraw(el, owner);
  pfRead();
  if (PF.hiWant) {
    pfShowCard(el, PF.hiWant);
    PF.hiWant = "";
  }
}

/* one part, drawn again only when what it shows changed, the focused button focused again (core paint). True when it drew */
function pfPut(el, part, html) {
  const node = el.querySelector(`[data-pf-part="${part}"]`);
  if (!node) return false;
  node.hidden = !html;
  return paint(node, html);
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
  pfIntents(el, pfPut(el, "agents", pfAgentsHtml(l)));
  pfPut(el, "cash", pfCashHtml(l, venueIn, owner));
  pfPut(el, "alloc", pfAllocHtml(rows));
}
/* draw again when an answer came back, if the Portfolio is still what is shown: once a frame, however many answers land in it */
function pfAgain() {
  if (PF.soon) return;
  PF.soon = true;
  // and, while the pane is still coming in, once it has (core paneLater)
  nextFrame(() => paneLater("portfolio", pfAgainSoon));
}
function pfAgainSoon() {
  PF.soon = false;
  pfAgainNow();
}
function pfAgainNow() {
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
}

/* a toggle of the pane's own (Range, Assets/Positions/Accounts): its markup stays the same from draw to draw, so a part is drawn again
   only when what it shows changed; its clicks are heard by the pane */
const pfSeg = (name, items, on, label) => `<div class="seg" role="group" aria-label="${esc(label)}">${items.map(([v, t]) => `<button type="button" data-pf-${name}="${esc(v)}" data-fk="pf-${name}:${esc(v)}" aria-pressed="${String(v === on)}">${esc(t)}</button>`).join("")}</div>`;
/* a button of the pane's: what it does and about what (data-fk names it, so a redraw gives it its focus back) */
const pfBtn = (act, label, { cls = "btn", data = {}, off = false, title = "" } = {}) => `<button type="button" class="${cls}" data-pf-act="${act}"${Object.entries(data).map(([k, v]) => ` data-${k}="${esc(v)}"`).join("")} data-fk="${esc([act, ...Object.values(data)].join(":"))}"${off ? " disabled" : ""}${title ? ` title="${esc(title)}"` : ""}>${label}</button>`;
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
    limit: [trading ? "It acts only inside a limit you sign: where, how much an order, how much in all. In Guard each order still waits for you." : "Connect an account that trades first: a limit names where an agent may trade.", pfBtn("limit", "Give a limit…", { cls: "btn btn-primary btn-sm", off: !owner || !trading || !steps[1].done })],
  };
  return `<section class="callout pf-steps" aria-labelledby="pf-steps-h"><div class="pf-steps-h"><h2 class="label warn-t" id="pf-steps-h">${fresh ? "Get started" : "Next steps"} · ${n} of 3</h2></div><ol>${steps.map((s, i) => `<li class="${s.done ? "done" : ""}"><span class="pf-tick" aria-hidden="true">${s.done ? "✓" : i + 1}</span><div><b>${esc(s.title)}</b>${s.done ? '<span class="sr"> (done)</span>' : `<span class="dim small">${esc(how[s.id][0])}</span>`}</div>${s.done ? "" : `<div class="pf-step-acts">${how[s.id][1]}</div>`}</li>`).join("")}</ol></section>`;
}

/* the net worth: the figure, ONE change line that follows the range (1D is today, from the holdings' own 24 hours; the others from the
   curve's history), the curve, and one ⓘ holding the footnotes */
function pfWorthHtml(l, venueIn, rows) {
  const L = connected().filter((v) => venueIn(v.id));
  if (!connected().length) {
    // nothing read yet; a connection may be on the account all the same, waiting for its venue to answer this network (one the venue
    // refused is under Venues, with Connect again)
    const w = pfWaiting().filter((x) => !x.stopped).length;
    return `<section class="sec pf-worth"><div class="label">Net worth</div><div class="num">${money(0)}</div><p class="dim">${w ? `Nothing is read yet: ${plural(w, "connection")} ${w === 1 ? "waits for its venue" : "wait for their venues"} to answer this network (see Venues).` : "Nothing is connected yet. Connect an account and what it holds shows here."}</p></section>`;
  }
  // the figure and today's change come from one read where they can (the holdings read says both), so they never disagree by a tick
  const usd = l.kind === "all" ? (PF.hold && Number.isFinite(Number(PF.hold.totalUsd)) ? Number(PF.hold.totalUsd) : A.liveUsd) : L.reduce((s, v) => s + v.usd, 0);
  const label = l.kind === "all" ? "Net worth" : l.kind === "venue" ? `Net worth · ${l.name}` : `${l.name} · agent wallets`;
  const day = !PF.hold ? null : l.kind === "all" ? PF.hold.change24h : pfDayChange(rows || []);
  const h = l.kind === "all" ? PF.hist.get(PF.range) : null;
  const today = l.kind !== "all" || PF.range === "1d";
  const notes = pfWorthNotes(l, today ? day : null, today ? null : h);
  const info = notes.length ? `<details class="more pf-info"><summary aria-label="About these figures" title="${esc(notes.join(" "))}">ⓘ</summary><ul class="pf-info-l">${notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></details>` : "";
  const head = `<div class="pf-worth-h"><div class="pf-worth-n"><div class="label">${esc(label)}</div><div class="num">${money(usd)}</div><div class="pf-today">${today ? pfTodayLine(day) : pfRangeLine(h)}${info}</div>${PF.holdErr && !PF.hold ? `<div class="msg no">${esc(PF.holdErr)}</div>` : ""}</div>${l.kind === "all" ? pfSeg("range", PF_RANGES, PF.range, "Range") : ""}</div>`;
  if (l.kind !== "all") return `${head}<p class="dim small pf-note">The curve covers all accounts together. ${pfBtn("all", "Show all accounts", { cls: "link" })}</p>`;
  return `${head}${pfCurveHtml(h)}`;
}
/* today's change, from each row's own 24 hours */
function pfTodayLine(day) {
  if (!day) return '<span class="skel" style="width:180px" aria-hidden="true"></span>';
  if (!(day.ofUsd > 0)) return '<span class="dim">Nothing priced here yet.</span>';
  return `<span>${chg(day.usd, "$")}${day.pct !== undefined ? ` <span class="tab-nums">(${Math.abs(day.pct).toFixed(2)}%)</span>` : ""} <span class="dim">today</span></span>`;
}
/* the change over the range, from the curve's history: since the first point when the range starts before it */
function pfRangeLine(h) {
  if (!h) return '<span class="skel" style="width:180px" aria-hidden="true"></span>';
  if (h.error) return '<span class="dim">The curve could not be read.</span>';
  const since = h.first && Date.parse(h.first) > Date.parse(h.from) + 60_000 ? `since ${nyDay(h.first)}` : PF_RANGE_WORDS[h.range] || "";
  return `<span>${chg(h.changeUsd, "$")}${h.changePct !== undefined ? ` <span class="tab-nums">(${Math.abs(h.changePct).toFixed(2)}%)</span>` : ""} <span class="dim">${esc(since)}</span></span>`;
}
/* the footnotes behind the one ⓘ: what the change covers, what is on the way, what the curve leaves out or carries */
function pfWorthNotes(l, day, h) {
  const notes = [];
  if (day && day.ofUsd > 0 && day.coveredUsd < day.ofUsd - 0.5) notes.push(`The 24-hour change covers ${money(day.coveredUsd)} of ${money(day.ofUsd)}: no 24-hour figure for ${day.missing.map((k) => k.split(":").slice(1).join(":")).join(", ")}.`);
  if (l.kind === "all" && A.inFlightUsd) notes.push(`${money(A.inFlightUsd)} on the way between your accounts is counted in the figure.`);
  if (h && !h.error) {
    if (h.paidOutUsd) notes.push(`${money(h.paidOutUsd)} paid out by agents is not counted as a loss.`);
    if (h.events && h.events.length) notes.push("Connections and disconnections are left out of the change.");
    if (h.partial) notes.push("A venue's last good number is in it.");
  }
  return notes;
}

function pfCurveHtml(h) {
  PF.curve = null;
  if (!h) return '<div class="skel pf-skel-curve" aria-hidden="true"></div>';
  if (h.error) return `<div class="msg no">${esc(h.error)}</div>`;
  const c = pfCurve(h.points);
  if (!c) return `<p class="dim small pf-note">${h.first ? `The curve draws once the account has two points: the first was taken ${esc(nyDay(h.first))} ${esc(nyTime(h.first))}.` : "The curve starts with the account's first snapshot, a few minutes after an account is connected."}</p>`;
  PF.curve = c;
  const ticks = (h.events || []).map((e) => { const x = c.at(Date.parse(e.at)); return x >= 0 && x <= c.w ? `<line x1="${x}" x2="${x}" y1="0" y2="${c.h}" class="pf-ev"><title>${esc(`${e.kind === "connect" ? "Connected" : "Disconnected"} ${e.name || e.venue} · ${nyDay(e.at)} ${nyTime(e.at)}`)}</title></line>` : ""; }).join("");
  const first = c.points[0];
  const last = c.points[c.points.length - 1];
  const words = `Net worth from ${money(first.usd)} on ${nyDay(first.at)} to ${money(last.usd)} on ${nyDay(last.at)}; low ${money(c.lo)}, high ${money(c.hi)}`;
  // the cursor is a line of its own over the curve, moved by a transform (no redraw of the curve as the pointer moves)
  return `<div class="pf-plot"><svg class="spark pf-curve" viewBox="0 0 ${c.w} ${c.h}" preserveAspectRatio="none" role="img" aria-label="${esc(words)}" data-pf-curve><path class="area" d="${c.area}"/><path class="line" d="${c.line}"/>${ticks}</svg><span class="pf-cursor" aria-hidden="true"></span><div class="pf-read small tab-nums" data-pf-read aria-hidden="true"></div></div>`;
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

/* what waits for the owner: the agents' cards and asks, agent by agent, and the agents asking to be let in. Each card says its time once */
function pfWaitingHtml(l, owner) {
  const cards = A.cards.filter((c) => pfAboutIn(c.agent, pfCardVenue(c), l));
  const asks = (A.asks || []).filter((a) => pfAboutIn(a.agent, a.venue, l));
  const mems = (A.memoryAsks || []).filter((m) => pfAboutIn(m.agent, "", l));
  const knocks = l.kind === "all" ? A.requests : [];
  const n = cards.length + asks.length + mems.length + knocks.length;
  if (!n) return "";
  const off = !owner;
  const card = (c) => `<div class="pf-item" data-pf-card="${esc(c.id)}"><div class="pf-item-t"><b>${esc(c.reason)}</b><span class="dim small">${fine(c.usd)}${c.expiresAt ? ` · answer by ${esc(pfWhen(c.expiresAt))}` : ""}</span><details class="more"><summary>What it asks</summary><pre>${esc((c.shown || []).filter((f) => f.value !== "" && f.name !== "nonce").map((f) => `${f.name}: ${f.value}`).join("\n"))}</pre></details></div><div class="pf-btns pf-keys">${pfBtn("reject", `${icon("x")}<span class="sr">Reject</span>`, { cls: "rkey", data: { card: c.id }, off, title: "Reject" })}${pfBtn("approve", `${icon("check")}<span class="sr">Approve</span>`, { cls: "rkey yes-k", data: { card: c.id }, off, title: "Approve: one signature" })}</div></div>`;
  // a venue asked for is connected from here, as the board offered it: its own connect form
  // round 7's keys (F3): a round icon for each answer, its word for the screen reader and on hover; Grant and Connect open the form signed
  const grant = (a) => (a.kind === "venue" ? pfBtn("grant", `${icon("plug")}<span class="sr">Connect</span>`, { cls: "rkey yes-k", data: { ask: a.id }, off, title: "Connect it: opens the form you sign" }) : pfBtn("grant", `${icon("check")}<span class="sr">Grant</span>`, { cls: "rkey yes-k", data: { ask: a.id }, off, title: "Grant: opens the form you sign" }));
  const ask = (a) => `<div class="pf-item pf-ask"><div class="pf-item-t"><b>${esc(a.text || PF_ASK_WORDS[a.kind] || a.kind)}</b><span class="dim small">${esc([`Asks for ${PF_ASK_WORDS[a.kind] || a.kind}`, a.usd && (a.kind === "limit" || a.kind === "topup") ? money(Number(a.usd)) : "", a.venue ? `at ${pfVenueName(a.venue)}` : "", a.at ? `asked ${pfWhen(a.at)}` : ""].filter(Boolean).join(" · "))}</span>${pfGrantable(a) ? "" : `<span class="dim small">${esc(pfWhyNot(a))}</span>`}</div><div class="pf-btns pf-keys">${pfBtn("decline", `${icon("x")}<span class="sr">Decline</span>`, { cls: "rkey", data: { ask: a.id }, off, title: "Decline" })}${pfGrantable(a) ? grant(a) : ""}</div></div>`;
  // a memory it learned, waiting: its words, its part and how it learned them; ✓ keeps it (its words signed as they are), ✗ forgets it
  const mem = (m) => `<div class="pf-item pf-ask"><div class="pf-item-t"><b>Wants to remember: “${esc(m.text)}”</b><span class="dim small">${esc([{ style: "Style", rules: "Rules", venues: "Venues and people" }[m.topic] || m.topic, m.how ? `it learned ${m.how}` : "it learned this", m.at ? pfWhen(m.at) : ""].filter(Boolean).join(" · "))}</span></div><div class="pf-btns pf-keys">${pfBtn("mem-forget", `${icon("x")}<span class="sr">Forget</span>`, { cls: "rkey", data: { agent: m.agent, note: m.id }, off, title: "Forget it" })}${pfBtn("mem-keep", `${icon("check")}<span class="sr">Keep</span>`, { cls: "rkey yes-k", data: { agent: m.agent, note: m.id }, off, title: "Keep it: a signature" })}</div></div>`;
  const knock = (r) => `<div class="pf-item pf-ask"><div class="pf-item-t"><b>${esc(r.name || "An agent")} asks to be let in</b><span class="dim small"><span class="mono">${esc(short(r.address))}</span> · ${esc(nyDay(r.at))} ${esc(nyTime(r.at))}</span></div><div class="pf-btns pf-keys">${pfBtn("letin", `${icon("check")}<span class="sr">Let in</span>`, { cls: "rkey yes-k", data: { agent: r.address }, off, title: "Let it in: opens the form you sign" })}</div></div>`;
  const groups = pfGroups(cards, asks, mems).map((g) => `<div class="pf-grp"><div class="pf-grp-h"><div class="who">${avatar((A.keys.find((k) => k.address === g.agent) || {}).code || g.name, "sm")}<div><b>${esc(g.name)}</b></div></div>${g.cards.length > 1 ? pfBtn("approve-all", `Approve all ${g.cards.length}`, { cls: "btn btn-sm", data: { agent: g.agent }, off }) : ""}</div>${g.cards.map(card).join("")}${g.asks.map(ask).join("")}${g.mems.map(mem).join("")}</div>`).join("");
  return `<section class="callout pf-wait" aria-labelledby="pf-wait-h"><div class="pf-wait-h"><h2 class="label warn-t" id="pf-wait-h">Waiting for you · ${n}</h2></div>${groups}${knocks.map(knock).join("")}</section>`;
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
const PF_ASK_WORDS = { letIn: "to be let in", limit: "a bigger limit", venue: "a venue connected", topup: "money in its wallet", session: "a new session", leverage: "more leverage", mode: "Beast mode" };
/* an ask the owner can grant from here: the form it needs exists on this account */
function pfGrantable(a) {
  if (a.kind === "venue") return !!A.connectLive;
  if (a.kind === "limit") return writesOn();
  if (a.kind === "topup") return writesOn() && (connected().some((v) => canMove(v) && !v.id.startsWith("agent-")) || !A.subAccounts.some((s) => s.agent.toLowerCase() === String(a.agent).toLowerCase()));
  if (a.kind === "session" || a.kind === "leverage") return writesOn() && !!A.dial;
  if (a.kind === "mode") return modeOf(A.mode) !== "open";
  return a.kind === "letIn";
}
const pfWhyNot = (a) => (!writesOn() && a.kind !== "venue" && a.kind !== "mode" && a.kind !== "letIn" ? "This server was started read-only." : a.kind === "mode" ? "Already Beast." : a.kind === "topup" ? "None of your accounts can send money from here." : "Nothing here can grant it.");

/* the agents at work: the owner's open words to them (ui/intent.js draws them, with what each agent reported), then the last five things
   they did — done or refused — and the way to the Statement */
function pfAgentsHtml(l) {
  if (!A.keys.length && !(A.intents || []).length) return "";
  const venueIn = pfVenueIn(l);
  const items = pfAgentLines({ agents: (PF.agents && PF.agents.agents) || [], lines: S }).filter((x) => (l.kind === "all" ? true : l.kind === "agent" ? String(x.agent).toLowerCase() === l.id.toLowerCase() : !!x.venue && venueIn(x.venue))).slice(0, 5);
  const none = !A.keys.length ? "No agent is connected yet." : "Nothing from an agent yet.";
  return `<div class="sec-head"><div class="label">Agents at work</div>${pfBtn("statement", "Statement", { cls: "link dim" })}</div><div data-pf-intents></div>${items.length ? `<div class="feed">${items.map((x) => `<div><span class="mk pf-mk ${x.cls}" aria-hidden="true">${x.mark}</span><div><div class="t1"><span class="sr">${esc(x.word)}: </span>${esc(x.text)}</div><div class="t2">${esc(x.sub)}${x.at ? ` · ${esc(nyTime(x.at))}` : ""}</div></div></div>`).join("")}</div>` : `<p class="empty">${none}</p>`}`;
}
/* the open intents, mounted under Agents at work by ui/intent.js (when it is there): drawn again only when the part was, or when the words,
   the limits given with them, the lens or the owner's role changed — never on a plain refresh, so Change words and Withdraw keep their focus */
function pfIntents(el, drawn) {
  const box = el.querySelector("[data-pf-intents]");
  if (!box || typeof htaIntents !== "function") return;
  const l = lensNow();
  const key = JSON.stringify([owns(), l.kind, l.id, A.intents || [], A.spend || []]);
  if (!drawn && PF.intentsKey === key) return;
  PF.intentsKey = key;
  htaIntents(box, owns(), { change: (x) => typeof openHandToAgent === "function" && openHandToAgent({ intent: x }) });
}

/* the dollars that are ready: one figure, one line, and the way to put them to earn where a venue takes them */
function pfCashHtml(l, venueIn, owner) {
  const L = connected().filter((v) => venueIn(v.id));
  // offered where a venue that serves this network takes money to earn
  const earn = typeof openEarn === "function" && L.some((v) => v.earn && v.earn.can !== false && servedHere(v)) ? pfBtn("earn", "Earn…", { cls: "btn btn-sm", off: !owner, title: owner ? "" : PF_LOOK_ONLY }) : "";
  const head = `<div class="sec-head"><div class="label">Cash ready</div>${earn}</div>`;
  if (!PF.hold) return `${head}${PF.holdErr ? `<div class="msg no">${esc(PF.holdErr)}</div>` : '<span class="skel" aria-hidden="true"></span>'}`;
  const c = pfCash(PF.hold.money, venueIn);
  const line = !(c.ready > 0) ? `No cash or dollar stablecoins here.${L.some(canReceive) ? " Receive some to trade with." : ""}` : c.canMove > 0 ? `${money(c.canMove)} can move between your accounts.` : "None of it can move between your accounts from here.";
  return `${head}<div class="num-m">${money(c.ready)}</div><p class="dim small pf-cash-l">${esc(line)}</p>`;
}

/* what the money is in */
function pfAllocHtml(rows) {
  const s = pfAlloc(rows);
  if (!rows) return '<div class="label">Allocation</div><span class="skel" aria-hidden="true"></span>';
  if (!s.length) return "";
  return `<div class="label">Allocation</div><div class="bar" aria-hidden="true">${s.map((x) => `<span style="flex:${x.usd};background:${(CLASS[x.cls] || ["", "var(--dim)"])[1]}"></span>`).join("")}</div><div class="legend-l">${s.map((x) => `<div><span class="sw-k" style="background:${(CLASS[x.cls] || ["", "var(--dim)"])[1]}" aria-hidden="true"></span><span>${esc((CLASS[x.cls] || [x.cls])[0])}</span><span>${x.pct}% · ${money(x.usd)}</span></div>`).join("")}</div>`;
}

// ---- Assets · Positions · Accounts ------------------------------------------------------------------------------------------------

function pfTableHtml(l, venueIn, rows, owner) {
  const L = connected().filter((v) => venueIn(v.id));
  const tools = PF.tab === "assets" && typeof openSellMany === "function" && L.some(canTrade) ? pfBtn("sellmany", `${icon("sellmany", "sm")}Sell many…`, { cls: "btn btn-sm", off: !owner, title: owner ? "" : PF_LOOK_ONLY }) : "";
  const body = PF.tab === "positions" ? pfPositionsHtml(l, venueIn, owner) : pfAssetsHtml(l, rows);
  return `<div class="sec-head pf-tabs">${pfSeg("tab", PF_TABS, PF.tab, "Show")}<span class="tools">${tools}</span></div>${body}`;
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
/* a price as it is read: an event contract in cents (its chance), a dollar to the cent, anything under a dollar to four figures (core
   cents and usd: a dash for a price that is not a number) */
const pfPrice = (r) => (r.class === "event" ? cents(r.price) : pfDollarRow(r) && Number.isFinite(Number(r.price)) && r.price !== undefined && r.price !== null ? money(r.price) : usd(r.price));
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
const pfEarnOutAt = (venue) => { const v = connected().find((x) => x.id === venue); return owns() && writesOn() && !!v && !!v.earn && v.earn.can !== false && servedHere(v); };

function pfAssetsHtml(l, rows) {
  if (!rows) return PF.holdErr ? `<div class="msg no">${esc(PF.holdErr)}</div>` : '<div class="skel-rows" aria-hidden="true"><span class="skel"></span><span class="skel"></span><span class="skel" style="width:60%"></span></div>';
  const chips = (r) => { const names = [...new Set(r.venues.map((x) => x.venueName))]; return names.length > 3 ? `${names.slice(0, 2).map(esc).join(" · ")} · +${names.length - 2}` : names.map(esc).join(" · "); };
  // the price has a column of its own where the card has the room; narrower, it sits on the line under the name (portfolio.css .pf-px-l)
  const t = table([
    { label: "Asset", cell: (r) => `<div class="who">${avatar(r.class === "event" ? (r.asset.endsWith(":NO") ? "NO" : "YES") : r.asset)}<div>${r.class === "earn" ? `<b class="pf-name">${esc(pfNameOf(r))}</b><span class="dim">${esc(pfEarnWhere(r))}<span class="pf-px-l"> · ${pfPrice(r)}</span></span>${typeof openEarn === "function" && r.venues.some((x) => pfEarnOutAt(x.venue)) ? `<span class="pf-earn-act">${pfBtn("earn-row-out", "Withdraw…", { cls: "link", data: { key: r.key } })}</span>` : ""}` : `<button type="button" class="pf-name" data-pf-act="asset" data-key="${esc(r.key)}">${esc(pfNameOf(r))}</button><span class="dim">${chips(r)}<span class="pf-px-l"> · ${pfPrice(r)}</span></span>`}</div></div>` },
    { label: "Amount", r: true, cell: (r) => `${esc(qtyOf(r.amount))}${r.unpriced ? `<span class="why">${esc(qtyOf(r.unpriced))} unpriced</span>` : ""}` },
    { label: "Price", r: true, cls: "pf-px", cell: (r) => pfPrice(r) },
    { label: "24h", r: true, cell: (r) => (pfDollarRow(r) ? '<span class="flat">—</span>' : `<span title="${esc(r.changeFrom ? `as ${r.changeFrom.venueName} reports it` : "no venue reported it")}">${chg(r.changePct24h)}</span>`) },
    { label: "Value", r: true, cell: (r) => `<b>${money(r.usd)}</b>` },
  ], rows, { empty: l.kind === "agent" ? "Its wallet holds nothing yet." : "Nothing held here yet.", rowAttr: (r) => (r.class === "earn" ? 'class="pf-earn-row"' : `class="click" data-pf-act="asset" data-key="${esc(r.key)}"`) });
  // a venue that does not serve this network now is named once, quietly (its words on hover); a read that failed says so in its words
  const miss = (PF.hold.missing || []).filter((m) => m.part !== "positions");
  const failed = miss.filter((m) => !awayMiss(m));
  return `${t}${awayLine(miss.filter(awayMiss), { cls: "small dim pf-miss" })}${failed.length ? `<p class="small dim pf-miss">Not read this time: ${failed.map((m) => `${esc(m.venueName)} (${esc(m.why)})`).join(" · ")}</p>` : ""}`;
}

function pfPositionsHtml(l, venueIn, owner) {
  if (!PF.pos) return '<div class="skel-rows" aria-hidden="true"><span class="skel"></span><span class="skel" style="width:60%"></span></div>';
  if (PF.pos.error) return `<div class="msg no">${esc(PF.pos.error)}</div>`;
  const list = PF.pos.positions.filter((p) => p.qty > 0 && venueIn(p.venue));
  const closable = (p) => { const v = connected().find((x) => x.id === p.venue); return owner && !!v && canTrade(v) && !!v.trade.positions; };
  // an event contract's prices are its chance, in cents; everything else in the market's quote
  const at = (p, n) => (n === undefined || n === null ? "—" : esc(p.kind === "event" ? cents(n) : px(n)));
  // a derivative is closed; a holding — contracts, shares, coins — is sold
  const verb = (p) => (p.kind === "event" || p.kind === "spot" || p.kind === "stock" || p.kind === "crypto" || p.kind === "token" ? "Sell…" : "Close…");
  const t = table([
    { label: "Position", cell: (p) => `<b>${esc(p.name)}</b><span class="why">${esc([p.venueName || nameOf(p.venue), `${p.side === "short" ? "short" : "long"} ${qtyOf(p.qty)}${p.kind === "event" ? " contracts" : ""}`, p.leverage ? `${p.leverage}x${p.marginMode ? ` ${p.marginMode}` : ""}` : ""].filter(Boolean).join(" · "))}</span>` },
    { label: "Value", r: true, cell: (p) => (p.usd !== undefined ? money(p.usd) : "—") },
    { label: "Entry · Mark", r: true, cell: (p) => `${at(p, p.entryPrice)} · ${at(p, p.markPrice)}` },
    { label: "Liquidation", r: true, cell: (p) => (p.liquidationPrice ? esc(px(p.liquidationPrice)) : '<span class="flat">—</span>') },
    { label: "P&L", r: true, cell: (p) => chg(p.unrealizedUsd, "$") },
    { cell: (p) => (closable(p) ? pfBtn("close", verb(p), { cls: "btn btn-sm", data: { venue: p.venue, symbol: p.symbol } }) : "") },
  ], list, { empty: l.kind === "agent" ? "An agent's wallet holds coins, not positions." : "Nothing held in positions." });
  const miss = PF.pos.missing.filter((m) => venueIn(m.venue));
  const failed = miss.filter((m) => !awayMiss(m));
  return `${t}${awayLine(miss.filter(awayMiss), { cls: "small dim pf-miss" })}${failed.length ? `<ul class="pf-miss-l">${failed.map((m) => `<li><b>${esc(m.venueName)}</b> could not be read: ${esc(m.why)}</li>`).join("")}</ul>` : ""}`;
}

/* how an account is reached, in a few words (the drawer's) */
function pfCaption(v) {
  if (v.address) return `${short(v.address)}${v.proven ? "" : " · watched"}`;
  if (/MCP server/.test(v.via || "")) return "Robinhood sign-in";
  const can = /credential can:? ([^·]+)/.exec(v.via || "");
  return `API key${can ? ` · ${can[1].trim()}` : ""}`;
}
/* an account's standing, as chips: its health first (✓ answers · ✗ not answering, the whole of it on hover), then what it can do from here */
function pfChips(v) {
  const h = pfHealth(v);
  const word = h.away ? "Not served here" : h.bad ? "Not answering" : h.read ? "Answers" : "Not read yet";
  // a venue that does not serve this network: that one state, and what serves the user instead when the venue has an edition for where
  // they are; what it can do from here waits until it answers again
  if (h.away) {
    const ed = v.notServed && v.notServed.edition;
    return [`<span class="chip pf-health away" title="${esc(h.text)}"><span aria-hidden="true">·</span>${esc(word)}</span>`, ed ? `<span class="chip" title="${esc(ed.said)}">${esc(ed.name)} serves where you are</span>` : ""].filter(Boolean).join(" ");
  }
  return [
    `<span class="chip pf-health${h.bad ? " bad" : ""}" title="${esc(h.text)}"><span aria-hidden="true">${h.bad ? "✗" : h.read ? "✓" : "·"}</span>${esc(word)}</span>`,
    // a venue that lets this network only close what is held: that state in a word, its own words on hover; it sells, it buys nothing
    v.closeOnly ? `<span class="chip" title="${esc(v.closeOnly.said || "")}">Close only here</span>` : "",
    canTrade(v) ? `<span class="chip warm">${v.closeOnly ? "Sells only" : "Trades"}</span>` : "",
    canMove(v) ? '<span class="chip warm">Moves money</span>' : "",
    canReceive(v) ? '<span class="chip">Receives</span>' : "",
    v.earn && v.earn.can !== false ? '<span class="chip">Earns</span>' : "",
    watched(v) ? '<span class="chip">Watched</span>' : "",
    // a venue nothing is placed at from here says so in its own words (the key's, the venue's, or its way in), the whole of them on hover
    writesOn() && v.trade && v.trade.can === false ? `<span class="chip" title="${esc(v.noTradeBecause || "this key can't trade")}">${esc(pfClip(v.noTradeBecause || "Key can't trade"))}</span>` : "",
    !canTrade(v) && !canMove(v) && !canReceive(v) && !watched(v) && !(v.trade && v.trade.can === false) ? `<span class="chip" title="${esc(readOnlyWords(v))}">${esc(pfClip(readOnlyWords(v)))}</span>` : "",
  ].filter(Boolean).join(" ");
}
/* a venue's sentence, short enough for a chip (all of it in the chip's title, and under Details) */
const pfClip = (t, n = 44) => { const s = String(t || "").trim(); return s.length > n ? `${s.slice(0, n - 1).replace(/\s+\S*$/, "")}…` : s; };
/* "Open to agents": a switch. Closing is free (POST /api/revoke: agents keep reads only), so any browser may; reopening widens what they
   may do, so it is signed — a browser that only looks finds a closed switch disabled. The word beside the track says the state too */
const pfSwitchHtml = (v, on, owner) => `<button type="button" role="switch" class="pf-switch" aria-checked="${String(on)}" data-pf-act="agents" data-venue="${esc(v.id)}" data-on="${String(on)}" data-fk="agents:${esc(v.id)}" aria-label="${esc(v.name)} open to agents"${on || owner ? "" : ' disabled title="Reopening is signed: only a browser that signs for the owner can"'}><span class="track" aria-hidden="true"></span><span>${on ? "Open" : "Closed"}</span></button>`;

function pfAccountsHtml(venueIn, owner) {
  const L = connected().filter((v) => venueIn(v.id));
  const revoked = new Set((A.dial && A.dial.revoked) || []);
  // under the connected accounts, each connection on the account that nothing was read from: one waiting for its venue to answer this
  // network, or one its venue answered and refused (stopped: the key, the account). Neither has a value, a standing of its own or a
  // switch; the venue's words are on the chip. A waiting one is asked again (free, any browser) or taken off the account (signed); a
  // stopped one is connected again by the owner's new signature, since a check does not retry it, or taken off
  const rows = [...L.map((v) => ({ v })), ...pfWaiting(venueIn).map((w) => ({ w }))];
  const look = owner ? "" : PF_LOOK_ONLY;
  return table([
    { label: "Account", cell: ({ v, w }) => `<div class="who">${avatar((v || w).name)}<div><b>${esc((v || w).name)}</b>${w ? `<span class="dim small">${w.stopped ? (w.by === "account" ? "not connected: the key could not be read" : "the venue refused the connection") : "waiting for the venue"}${pfLastRead(w) && w.lastAt ? ` · last read ${esc(nyTime(w.lastAt))}` : ""}</span>` : ""}</div></div>` },
    // a connection a restart could not bring back: what its venue held at the last good read, dim, in no total
    { label: "Value", r: true, cell: ({ v, w }) => (v ? money(v.usd) : pfLastRead(w) ? `<span class="dim" title="${esc(`Last read before the restart${w.lastAt ? `, ${nyDay(w.lastAt)} ${nyTime(w.lastAt)}` : ""}`)}">${money(w.lastUsd)}</span>` : "—") },
    { label: "Status", cell: ({ v, w }) => `<span class="pf-chips">${v ? pfChips(v) : `${w.stopped ? `<span class="chip pf-health bad" title="${esc(w.said)}"><span aria-hidden="true">✗</span>Not connected</span>` : `<span class="chip" title="${esc(w.said)}">Waiting for the venue</span>`}<span class="dim small">since ${esc(pfWhen(w.since))}</span>`}</span>` },
    { label: "Open to agents", cell: ({ v }) => (v ? pfSwitchHtml(v, !revoked.has(v.id), owner) : "—") },
    // the rest of what an account can do from here — Trade…, Move…, Receive, a new key, Disconnect… — is in its drawer
    { cell: ({ v, w }) => `<div class="acts pf-acts">${v ? `${v.notServed && v.notServed.edition && typeof connectVia === "function" ? pfBtn("edition", `Connect ${v.notServed.edition.name}`, { cls: "btn btn-sm", data: { venue: v.id }, off: !owner, title: owner ? v.notServed.edition.said : PF_LOOK_ONLY }) : ""}${pfBtn("acct-details", "Details", { cls: "btn btn-sm btn-ghost", data: { venue: v.id } })}` : `${w.stopped ? pfBtn("reconnect", "Connect again", { cls: "btn btn-sm", data: { venue: w.venue }, off: !owner, title: look }) : pfBtn("recheck", "Check again", { cls: "btn btn-sm btn-ghost", data: { connector: w.connector }, title: `Ask ${w.name} again now` })}${pfBtn("unwait", "Disconnect", { cls: "btn btn-sm btn-ghost", data: { venue: w.venue }, off: !owner, title: look })}`}</div>` },
  ], rows, { empty: "No account here.", cls: "pf-acct-t" });
}

// ---- the Account's Venues (round 7, F5) ------------------------------------------------------------------------------------------

/** The Account's Venues: every account connected, with its standing, what it is worth, whether agents may act there and its details — and
 * Connect an account. The shell calls it on every read, on the route and on the lens; its clicks are the Portfolio's (pfWire) */
function renderVenues({ el, owner }) {
  if (!el.firstElementChild || el.firstElementChild.dataset.pf !== "venues") el.innerHTML = '<div class="pf pf-venues" data-pf="venues"><section class="sec pf-table" data-pf-part="venues" aria-labelledby="pf-venues-h"></section></div>';
  pfWire(el);
  const venueIn = pfVenueIn(lensNow());
  const L = connected().filter((v) => venueIn(v.id));
  const tools = `${typeof downloadBalances === "function" && L.length ? pfBtn("csv", `${icon("download", "sm")}CSV`, { cls: "btn btn-sm btn-ghost" }) : ""}${A.connectLive ? pfBtn("connect", `${icon("plug", "sm")}Connect an account`, { cls: "btn btn-primary btn-sm", off: !owner, title: owner ? "" : PF_LOOK_ONLY }) : ""}`;
  const agents = A.keys.filter((k) => k.status === "ok").length;
  // the connections on the account that nothing is read from are counted apart from the accounts: the ones waiting for their venue to
  // answer this network, and the ones a venue answered and refused (stopped), connected again only by the owner
  const held = pfWaiting(venueIn);
  const W = held.filter((w) => !w.stopped).length;
  const X = held.length - W;
  const waits = W ? `waiting for ${W === 1 ? "its venue" : "their venues"}` : "";
  const refused = X ? `${X} not connected` : "";
  const sub = L.length
    ? `${plural(L.length, "account")} · ${money(L.reduce((t, v) => t + num(v.usd), 0))}${agents ? ` · where ${agents === 1 ? "your agent" : "your agents"} may act is each one's switch` : ""}${W ? ` · ${W} ${waits}` : ""}${X ? ` · ${refused}` : ""}`
    : held.length
      ? `${[W ? `${plural(W, "connection")} ${waits}: nothing is read from ${W === 1 ? "it until it answers" : "them until they answer"} this network` : "", X ? `${refused}: ${X === 1 ? "connect it again, or disconnect it" : "connect them again, or disconnect them"}` : ""].filter(Boolean).join(" · ")}.`
      : "Connect an exchange, a broker, a wallet or a prediction market: each is read through its own interface, and nothing moves without your signature.";
  pfPut(el, "venues", `<div class="sec-head"><div class="pf-venues-t"><h2 class="h2" id="pf-venues-h">Venues</h2><span class="dim small">${esc(sub)}</span></div><span class="tools">${tools}</span></div>${pfAccountsHtml(venueIn, owner)}`);
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
  // the curve under the pointer: the point nearest it, in figures — the line and the words written as the pointer moves (the browser hands
  // moves over once a frame; a frame asked for here on top would hold the next move back a frame) and only when the nearest point changes;
  // the curve's box read once as the pointer comes onto it (and again when its size changes), never per move
  el.addEventListener("mousemove", (e) => {
    const svg = e.target.closest && e.target.closest("svg[data-pf-curve]");
    if (!svg || !PF.curve) return;
    if (!PF.hover || PF.hover.svg !== svg) pfHoverOn(svg);
    PF.hover.x = e.clientX;
    pfHoverDraw();
  });
}
/* the pointer came onto the curve: its box, kept while it is there; leaving the curve itself (heard on the curve: a part inside it is not
   it) clears the line and the words */
function pfHoverOn(svg) {
  const plot = svg.parentElement;
  const box = svg.getBoundingClientRect();
  PF.hover = { svg, left: box.left, width: box.width, x: 0, i: -1, cur: plot && plot.querySelector(".pf-cursor"), out: plot && plot.querySelector("[data-pf-read]") };
  if (svg.pfHeard) return;
  svg.pfHeard = true;
  svg.addEventListener("mouseleave", () => {
    const h = PF.hover;
    PF.hover = null;
    if (!h) return;
    if (h.out) h.out.textContent = "";
    if (h.cur) h.cur.style.transform = "";
  });
  if (typeof ResizeObserver === "function") new ResizeObserver(() => {
    if (PF.hover && PF.hover.svg === svg) {
      const b = svg.getBoundingClientRect();
      PF.hover.left = b.left;
      PF.hover.width = b.width;
    }
  }).observe(svg);
}
function pfHoverDraw() {
  const h = PF.hover;
  const c = PF.curve;
  if (!h || !c || !h.svg.isConnected) return;
  const x = ((h.x - h.left) / (h.width || 1)) * c.w;
  let i = 0;
  for (let k = 1; k < c.pts.length; k++) if (Math.abs(c.pts[k][0] - x) < Math.abs(c.pts[i][0] - x)) i = k;
  if (i === h.i) return;
  h.i = i;
  const p = c.points[i];
  if (h.cur) h.cur.style.transform = `translateX(${((c.pts[i][0] / c.w) * h.width).toFixed(1)}px)`;
  if (h.out) setText(h.out, `${money(p.usd)} · ${nyDay(p.at)} ${nyTime(p.at)}${p.partial ? " · a venue's last good number" : ""}`);
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
    case "earn": return void (typeof openEarn === "function" && openEarn(l.kind === "venue" ? { venue: l.id } : {}));
    case "sellmany": return void (typeof openSellMany === "function" && openSellMany(l.kind === "venue" ? { venue: l.id } : {}));
    case "approve":
    case "reject": {
      const c = A.cards.find((x) => x.id === d.card);
      if (c) await own({ type: "approveCard", card: c.id, action: c.hash, decision: act });
      return;
    }
    case "approve-all": return void pfApproveAll(d.agent);
    case "mem-keep": {
      // its words signed as they are: kept, and still what the agent learned
      const m = (A.memoryAsks || []).find((x) => x.agent === d.agent && x.id === d.note);
      if (m) await own({ type: "setMemory", scope: m.agent, id: m.id, topic: m.topic, text: m.text }, () => forget("/api/account/memory"));
      return;
    }
    case "mem-forget": return void (await own({ type: "forgetMemory", scope: d.agent, what: d.note }, () => forget("/api/account/memory")));
    case "grant": return void pfGrant((A.asks || []).find((a) => a.id === d.ask));
    case "decline": return void declineAsk((A.asks || []).find((a) => a.id === d.ask));
    case "asset": return void (typeof openAsset === "function" && openAsset(d.key));
    case "close": return void pfClose(d.venue, d.symbol);
    case "earn-row-out": return void pfEarnRowOut(d.key);
    case "agents": return void pfAgentsSwitch(d.venue, d.on === "true");
    case "acct-details": return void pfDetails(d.venue);
    case "recheck": return void pfRecheck(d.connector);
    case "edition": return void pfEdition(d.venue);
    case "reconnect": return void pfReconnect(d.venue);
    case "unwait": return void pfUnwait(d.venue);
    case "csv": return void (typeof downloadBalances === "function" && downloadBalances());
    case "statement": return void (typeof openStatement === "function" && openStatement());
    case "all":
      view.lens = "";
      return void render();
    default:
  }
}
/* a connection its venue answered and refused (stopped: the key, the account), connected again by the owner: the connection's own form, on
   the same name and key file (or address), through connect.js connectVia. A check of this network does not retry it; a new signature does */
function pfReconnect(venue) {
  const w = pfWaiting().find((x) => x.venue === venue);
  if (!w || !owns() || typeof connectVia !== "function") return;
  connectVia(w.connector, { name: w.name, label: w.name, ref: w.keyFile || w.address || "", fromWait: true });
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

/* a waiting connection's venue asked again now: its first, keyless question for this network, forced (connect.js askReach). When it
   answers (close-only is an answer: what is held there can be sold), the account connects the connection; the page reads the account again
   to see. When it still does not, that is said as the state it is, in a neutral word, never as an error in the venue's words (those stay
   on the row's chip, on hover) */
async function pfRecheck(connector) {
  if (typeof askReach === "function") await askReach([connector], true);
  const r = typeof REACH !== "undefined" ? REACH.get(connector) : null;
  const answers = !!r && (r.state === "ok" || r.state === "close-only");
  if (r && !answers) {
    const w = pfWaiting().find((x) => x.connector === connector);
    toast(`${w ? w.name : "The venue"} still doesn't answer this network. It stays on the account and comes back by itself when it does.`, "info");
  }
  await load();
  // the venue answered: the account is connecting the connection behind this answer, and says so on its next read
  if (answers) setTimeout(() => void load(), 2500);
}
/* a connected venue that does not serve this network, and its edition that serves where the user is: that edition's own form (a separate
   company, its own account and keys) */
function pfEdition(venue) {
  const v = A.venues.find((x) => x.id === venue);
  const ed = v && v.notServed && v.notServed.edition;
  if (!ed || !owns() || typeof connectVia !== "function") return;
  connectVia(ed.connector, { name: ed.name });
}
/* a waiting or stopped connection taken off the account, after a yes: nothing was read from its venue in this run, so nothing there changes;
   a key file stays where it is */
async function pfUnwait(venue) {
  const w = pfWaiting().find((x) => x.venue === venue);
  if (!w || !owns()) return;
  const ok = await confirmSheet(`Disconnect ${w.name}? The connection comes off the account and ${w.name} is not asked again. ${w.how === "restart" ? "Nothing has been read from it since the restart" : "Nothing was ever read from it"}${w.keyFile ? ", and its key file stays where it is" : ""}.`, { title: "Disconnect", yes: "Disconnect" });
  if (ok) await own({ type: "disconnectVenue", venue: w.venue });
}

/** "Open to agents": closing is free (POST /api/revoke: agents keep reads only); reopening widens what they may do, so it is signed */
async function pfAgentsSwitch(venueId, isOpen) {
  const v = connected().find((x) => x.id === venueId);
  if (!v || busy) return;
  if (!isOpen) return void (owns() && (await own({ type: "setPolicy", change: "restore", value: venueId })));
  const r = await postJson("/api/revoke", { account: venueId });
  if (r.status >= 400 || (r.body && r.body.ok === false)) flash = Owner.why(r) || "Refused";
  else said = `${v.name} is closed to agents: they keep reading it, and place or move nothing there. Reopening it is signed.`;
  await load();
}

/** a venue whose key can't trade: disconnect it (signed), then its connect form for a key that can */
async function pfRekey(venueId) {
  const v = connected().find((x) => x.id === venueId);
  const connector = v && typeof connectorOfVenue === "function" ? connectorOfVenue(v) : "";
  if (!v || !connector || !owns()) return;
  // the file this venue's key is read from, as the account signed it: a second account at an exchange has its own
  const ref = v.keyFile || "";
  const file = !ref ? "" : ref.startsWith("/") ? ref : `${String((A.connectLive && A.connectLive.home) || "").replace(/\/$/, "")}/${ref}`;
  if (!(await confirmSheet(`${v.name}'s key can't trade. ${keyHowFor(v)} Save the new key in the same file${file ? `, ${file}` : ""}, then the account disconnects ${v.name} (nothing there moves) and opens its connect form.`, { title: "Connect a new key", yes: "Disconnect and continue" }))) return;
  const r = await own({ type: "disconnectVenue", venue: venueId });
  // connected again under its own name and from its own file, so it comes back as the same venue reading the same account
  if (r && !refusedAt(r)) connectVia(connector, { name: v.name, label: v.name, ref });
}

/* one account, in the drawer: what it holds, how it is reached, what it can do from here and why not — and every action on it */
function pfDetails(venue) {
  const draw = () => {
    const v = A.venues.find((x) => x.id === venue);
    if (!v) return '<p class="empty">This account is no longer connected.</p>';
    const owner = owns();
    const h = (A.health || {})[v.id];
    const t = pfTrades(v);
    const can = v.liveCan && writesOn() && !watched(v) ? ["withdraw", "transfer", "swap"].filter((k) => v.liveCan[k] === true) : [];
    const notes = [
      t.text,
      can.length ? `Moves money: ${can.join(", ")}.` : "",
      keyOnlyReads(v) && !canTrade(v) ? "Read-only key: it can receive, not send." : "",
      v.proven ? `Proven yours: ${v.proven}.` : "",
      v.earn ? `Earn: ${v.earn.what}${v.earn.can === false && v.earn.whyNot ? ` · ${v.earn.whyNot}` : ""}.` : "",
      v.noTradeBecause && writesOn() && !t.text.includes(v.noTradeBecause) ? v.noTradeBecause : "",
      v.readOnlyBecause && writesOn() && !canTrade(v) && !t.text.includes(v.readOnlyBecause) ? v.readOnlyBecause : "",
      // where it stands, said once: not served on this network (a state), or a read that failed (its words, and since when)
      pfHealth(v).away ? `Not served on this network now: ${pfHealth(v).text}` : v.stale ? `Could not be read${v.asOf ? ` since ${nyTime(v.asOf)}` : ""}: ${v.stale}` : h && h.lastFailAt && !(h.lastOkAt && Date.parse(h.lastOkAt) > Date.parse(h.lastFailAt)) ? `Last failed ${nyDay(h.lastFailAt)} ${nyTime(h.lastFailAt)}: ${h.message || h.code || ""}` : "",
      v.notServed && v.notServed.edition ? `${v.notServed.edition.said}.` : "",
      h && h.lastOkAt ? `Last answered ${nyTime(h.lastOkAt)}${h.ms ? ` in ${h.ms} ms` : ""}.` : "",
    ].filter(Boolean);
    const ticket = typeof openTicket === "function";
    const btn = (act, label, { primary = false, ghost = false, needsOwner = true } = {}) => `<button type="button" class="btn btn-sm${primary ? " btn-primary" : ghost ? " btn-ghost" : ""}" data-det="${act}" data-fk="det:${act}"${needsOwner && !owner ? " disabled" : ""}>${label}</button>`;
    // an agent wallet is emptied with Take back… (under Agents), never disconnected: the account holds its key and its money
    return `<div class="pf-det"><div class="who">${avatar(v.name, "lg")}<div><b>${esc(v.name)}</b><span class="dim">${esc(pfCaption(v))}</span></div></div><div class="pf-det-v"><div class="label">Value</div><div class="num-m">${money(v.usd)}</div>${v.asOf ? `<span class="dim small">as of ${esc(nyDay(v.asOf))} ${esc(nyTime(v.asOf))}</span>` : ""}</div><div class="pf-chips">${pfChips(v)}</div><div class="pf-det-acts">${ticket && canTrade(v) ? btn("trade", "Trade…", { primary: true }) : ""}${canMove(v) ? btn("move", "Move…") : ""}${canReceive(v) ? btn("receive", "Receive", { needsOwner: false }) : ""}${btn("lens", "Show only this", { ghost: true, needsOwner: false })}${t.rekey ? btn("rekey", "Connect a new key") : ""}</div><section class="sec pf-det-sec"><div class="label">Holds</div>${table([
      { label: "Asset", cell: (x) => `${esc(x.asset)}${x.note ? `<span class="why">${esc(x.note)}</span>` : ""}` },
      { label: "Amount", r: true, cell: (x) => esc(qtyOf(x.amount)) },
      { label: "Value", r: true, cell: (x) => (x.usd ? money(x.usd) : '<span class="dim">no price</span>') },
    ], (v.holdings || []).filter((x) => x.amount), { empty: "Nothing held there." })}</section><section class="sec pf-det-sec"><div class="label">From here</div><ul class="pf-notes">${notes.map((x) => `<li>${esc(x)}</li>`).join("") || `<li>${esc(readOnlyWords(v))}</li>`}</ul>${v.via ? `<p class="small dim">${esc(v.via)}</p>` : ""}</section>${v.plugged && !isAgentWallet(v) ? `<div class="end"><button type="button" class="btn btn-sm btn-danger" data-det="off" data-fk="det:off"${owner ? "" : " disabled"}>Disconnect…</button></div>` : isAgentWallet(v) ? '<p class="dim small">An agent wallet is not disconnected: the account holds its key. Empty it with Take back…, under Agents.</p>' : ""}</div>`;
  };
  const v = A.venues.find((x) => x.id === venue);
  if (!v) return;
  // drawn again after each read in place, and not while the drawer is still sliding in
  const again = () => paint(body, draw());
  const body = openDrawer(draw(), { title: v.name, redraw: () => drawerLater(again) });
  body.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("button[data-det]");
    if (!b || b.disabled) return;
    const act = b.dataset.det;
    if (act === "off") return void pfDisconnect(venue);
    closeDrawer();
    if (act === "trade") pfTrade({ venue });
    else if (act === "move") openLiveMove(venue);
    else if (act === "receive") openReceive(venue);
    else if (act === "rekey") pfRekey(venue);
    else if (act === "lens") {
      view.lens = `venue:${venue}`;
      render();
    }
  });
}

// ---- a card named from elsewhere ----------------------------------------------------------------------------------------------------

/* "Review" on an agent's card elsewhere (Under way, the market drawer) sends here: #/portfolio?card=<id>. The pane shows that card the next
   time it draws; an id that names no card here does nothing */
onRoute((tab, params) => { PF.hiWant = tab === "portfolio" ? String((params && params.card) || "") : ""; });
/* the card named: brought into view and ringed for a moment (outline colour only; no motion under prefers-reduced-motion) */
function pfShowCard(el, id) {
  if (!id || !el || !el.querySelector) return false;
  const safe = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : String(id).replace(/["\\]/g, "\\$&");
  const node = el.querySelector(`[data-pf-card="${safe}"]`);
  if (!node) return false;
  const still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (node.scrollIntoView) node.scrollIntoView({ block: "center", behavior: still ? "auto" : "smooth" });
  node.classList.add("pf-hi");
  const on = () => node.classList.add("on");
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(on);
  else on();
  setTimeout(() => node.classList.remove("on"), 1600);
  setTimeout(() => node.classList.remove("pf-hi"), 1900);
  return true;
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
  if (a.kind === "mode" && (await confirmSheet(`Switch to Beast: agents' orders inside their limits go at once, without a card. ${a.agentName} said: “${a.text || "Beast mode"}”`, { title: "Beast mode", yes: "Switch" }))) await setMode("open");
}

/* a venue an agent asked for: the connection it is reached through, as the board offered it (its one short form, straight away); else
   its own connection form by kind, an exchange's by id, or every way of connecting when the page has no form for it by name */
function pfConnectVenue(venue) {
  if (typeof openConnect !== "function" || typeof optionOf !== "function") return;
  const opts = (A.connectLive && A.connectLive.options) || [];
  const byKind = optionOf(venue);
  const ex = opts.find((o) => o.kind === "exchange" && (o.venues || []).includes(venue));
  const connector = byKind && byKind.connector ? byKind.connector : ex ? `live:exchange:${venue}` : "";
  if (connector && typeof connectVia === "function" && connectVia(connector, { name: byKind ? byKind.label.split(" · ")[0] : "" })) return;
  if (byKind) return void openConnect(byKind, { name: byKind.label.split(" · ")[0] });
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
  const scopes = [["trade", "Trading", L.filter(canTrade)], ["venues", "Moving money between your accounts", [...L.filter(canMove), ...L.filter((v) => v.id.startsWith("agent-") && !canMove(v))]], ["earn", "Putting money into earn products", L.filter((v) => v.earn && v.earn.can !== false && servedHere(v))]].filter(([, , vs]) => vs.length);
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
    sub: ask ? `${esc(ask.agentName)} asked: “${esc(ask.text || "a bigger limit")}”${ask.usd ? ` · ${esc(money(Number(ask.usd)))}` : ""}. A limit is the most it may do on its own; in Guard each order still waits for you.` : "The most an agent may do on its own. In Guard each order still waits for you; in Beast it goes at once inside this limit.",
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
      return `<div class="big"><span>${esc(name)} may ${esc(what)} ${esc(a.allow.split(",").map(nameOf).join(", "))}</span></div><div class="path">Up to <b>${esc(money(Number(a.perPayment)))}</b> each, <b>${esc(money(Number(a.budget)))}</b> in all, until ${esc(nyDay(a.validUntil))}.${cap ? ` No single order goes over ${esc(money(cap))} on this server.` : ""}</div>${before ? `<div class="path">It replaces the limit it has now: ${esc(money(before.perPaymentUsd))} each, ${esc(money(before.spentUsd))} of ${esc(money(before.budgetUsd))} used. What it has used starts again at $0.00 under the new limit.</div>` : ""}`;
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

/* money out of an Earning row under Assets: the Earn sheet (ui/earn.js) on Take out, the product the row is in picked first — the one the
   row names, the one /earn lists at that venue for that asset, or the one the owner picks when the money is in more than one */
async function pfEarnRowOut(key) {
  if (typeof openEarn !== "function") return;
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
  if (i !== null && lines[i]) openEarn({ venue: lines[i].venue, side: "withdraw", product: lines[i].product });
}
