/* The Account's Memory — the Demo v2 canvas's F13: what an agent remembers about you (account/memory.ts on the server), every word of it
   yours to read, change and forget, and three switches for what it may add. GET /api/account/memory gives it agent by agent:
     its notes       in three parts, Style · Rules · Venues and people, each saying where it came from — You said (yours), It learned … (the
                     agent's, in its words), and the waiting ones it learned while you asked to be asked first
     its limits      what the limits you signed for it and your mode say, as they stand ("From your limit"): changed only by changing them
     its switches    remember new things · ask me first · other agents can read it
   A change is your signed action (setMemory, forgetMemory, setMemoryRules: own()). Export writes the memory out as a JSON file; Forget all
   deletes its file, and there is no bin. Words, never a permission: no limit reads any of it. */

const MEM = { page: null, err: "", agent: "", edit: "", soon: false };
const MEM_PARTS = [["style", "Style"], ["rules", "Rules"], ["venues", "Venues and people"]];
const MEM_LOOK_ONLY = "This browser can look but not sign";
/* an agent's name as the account knows it, or the key it was: a key the account no longer lists keeps its memory until you forget it */
const memName = (a) => a.name || `An earlier key ${short(a.address)}`;
/* the day a note was kept, as F13 writes it: Oct 2 */
const memDay = (iso) => (iso ? ny(iso, { month: "short", day: "numeric" }) : "");

/** the Memory pane (the shell calls it on every read, on the route and on the lens) */
function renderMemory({ el, owner, params = {} }) {
  if (/^0x[0-9a-f]{40}$/.test(String(params.agent || ""))) MEM.agent = params.agent;
  // an agent in the lens is the one shown
  const l = lensNow();
  if (l.kind === "agent") MEM.agent = l.id.toLowerCase();
  if (!el.firstElementChild || el.firstElementChild.dataset.mem !== "2") {
    el.innerHTML = '<div class="mem" data-mem="2"><div class="mem-who" data-mem-part="who"></div><div class="mem-grid"><section class="sec mem-card" data-mem-part="notes" aria-labelledby="mem-h"></section><div class="mem-side"><section class="sec" data-mem-part="uses" aria-labelledby="mem-uses-h"></section><section class="sec" data-mem-part="switches" aria-labelledby="mem-sw-h"></section></div></div></div>';
    memWire(el);
  }
  memDraw(el, owner);
  memRead();
}

/* the read behind the pane, kept a few seconds (the page reads again every 20 seconds) */
function memRead() {
  api("/api/account/memory", { ttl: 4_000 }).then((b) => {
    if (b && b.ok) [MEM.page, MEM.err] = [b, ""];
    else MEM.err = refusalOf(b) || "The account did not answer.";
    memAgain();
  });
}
function memAgain() {
  if (MEM.soon) return;
  MEM.soon = true;
  nextFrame(() =>
    paneLater("memory", () => {
      MEM.soon = false;
      const el = $("pane-memory");
      if (!A || ROUTE.tab !== "memory" || !el || !el.querySelector("[data-mem]")) return;
      try {
        memDraw(el, owns());
      } catch (err) {
        console.error(err);
      }
    }),
  );
}
/* one part, drawn again only where what it shows changed (core paint) */
function memPut(el, part, html) {
  const node = el.querySelector(`[data-mem-part="${part}"]`);
  if (!node) return false;
  node.hidden = !html;
  return paint(node, html);
}

/* the agents with a memory, the ones standing first; an agent in the lens alone */
function memAgents() {
  const rank = { ok: 0, expired: 1, revoked: 2, gone: 3 };
  const l = lensNow();
  return ((MEM.page && MEM.page.agents) || [])
    .filter((a) => l.kind !== "agent" || a.address === l.id.toLowerCase())
    .slice()
    .sort((a, b) => (rank[a.status] ?? 4) - (rank[b.status] ?? 4) || memName(a).localeCompare(memName(b)));
}

function memDraw(el, owner) {
  if (!MEM.page) {
    memPut(el, "who", "");
    memPut(el, "notes", MEM.err ? `<div class="msg no">${esc(MEM.err)}</div>` : '<div class="skel-rows" aria-hidden="true"><span class="skel"></span><span class="skel"></span><span class="skel" style="width:60%"></span></div>');
    memPut(el, "uses", "");
    memPut(el, "switches", "");
    return;
  }
  const agents = memAgents();
  const a = agents.find((x) => x.address === MEM.agent) || agents[0];
  if (a) MEM.agent = a.address;
  memPut(el, "who", memWhoHtml(agents, a));
  if (!a) {
    memPut(el, "notes", `<div class="card-head"><h2 class="h2" id="mem-h">Memory</h2></div><p class="dim">No agent has been let in yet. Once one is, what it remembers about you is kept here — what you tell it, and what it learns — and every word of it is yours to change or forget.</p><div>${memBtn("agents", "Agents…", { cls: "btn btn-sm" })}</div>`);
    memPut(el, "uses", "");
    memPut(el, "switches", "");
    return;
  }
  memPut(el, "notes", memNotesHtml(a, owner));
  memPut(el, "uses", memUsesHtml(a));
  memPut(el, "switches", memSwitchesHtml(a, owner));
}

/* a button of the pane's: what it does and about what (data-fk names it, so a redraw gives it its focus back) */
const memBtn = (act, label, { cls = "link", data = {}, off = false, title = "", aria = "" } = {}) =>
  `<button type="button" class="${cls}" data-mem-act="${act}"${Object.entries(data).map(([k, v]) => ` data-${k}="${esc(v)}"`).join("")} data-fk="${esc(["mem", act, ...Object.values(data)].join(":"))}"${off ? " disabled" : ""}${title ? ` title="${esc(title)}"` : ""}${aria ? ` aria-label="${esc(aria)}"` : ""}>${label}</button>`;

/* the agents, as a row of pills: whose memory is shown */
function memWhoHtml(agents, shown) {
  if (agents.length < 2) return "";
  return `<div class="seg mem-pick" role="group" aria-label="Whose memory">${agents
    .map((a) => `<button type="button" data-mem-agent="${esc(a.address)}" data-fk="mem-agent:${esc(a.address)}" aria-pressed="${String(a === shown)}">${esc(memName(a))}${a.status !== "ok" ? `<span class="dim small"> · ${esc(a.status === "gone" ? "key gone" : a.status)}</span>` : ""}</button>`)
    .join("")}</div>`;
}

// ---- what it remembers about you (F13's card) --------------------------------------------------------------------------------------

/* where a note came from, as F13 says it */
const memFrom = (n) => (n.from === "you" ? "You said" : n.how ? `It learned ${n.how}` : "It learned this");

/* one note: its words, where it came from and when; edit and forget — or, waiting for you, keep and forget */
function memNoteHtml(a, n, owner) {
  if (MEM.edit === `${a.address}:${n.id}`) return `<li class="mem-row editing" data-k="${esc(n.id)}">${memFormHtml({ form: "edit", agent: a.address, id: n.id, topic: n.topic, text: n.text, yes: "Sign and save" })}</li>`;
  const off = !owner;
  const t = off ? MEM_LOOK_ONLY : "";
  const keys = n.waiting
    ? `${memBtn("keep", icon("check"), { cls: "mem-key keep", data: { agent: a.address, id: n.id }, off, title: t || "Keep it: what it learned, now read", aria: `Keep: ${n.text.slice(0, 60)}` })}${memBtn("forget-note", icon("trash"), { cls: "mem-key bad", data: { agent: a.address, id: n.id }, off, title: t || "Forget", aria: `Forget: ${n.text.slice(0, 60)}` })}`
    : `${memBtn("edit", icon("pencil"), { cls: "mem-key", data: { agent: a.address, id: n.id }, off, title: t || "Edit", aria: `Edit: ${n.text.slice(0, 60)}` })}${memBtn("forget-note", icon("trash"), { cls: "mem-key bad", data: { agent: a.address, id: n.id }, off, title: t || "Forget", aria: `Forget: ${n.text.slice(0, 60)}` })}`;
  return `<li class="mem-row${n.waiting ? " waiting" : ""}" data-k="${esc(n.id)}"><div class="mem-row-t"><div class="mem-text">${esc(n.text)}</div><div class="mem-from">${esc(memFrom(n))} · ${esc(memDay(n.updatedAt || n.at))}${n.waiting ? ' · <span class="pill warm">Waits for you</span>' : ""}</div></div>${keys}</li>`;
}

/* a line of From your limit: what a signed limit (or the mode) says, as it stands; changed only where it is changed — a limit in its form,
   the mode with Guard | Beast at the top of the Account */
function memLimitHtml(a, x, owner) {
  const change = x.from === "mode" ? "" : memBtn("limit", icon("pencil"), { cls: "mem-key", data: { agent: a.address }, off: !owner, title: owner ? "Change the limit: a new signature" : MEM_LOOK_ONLY, aria: "Change the limit" });
  return `<li class="mem-row from-limit" data-k="${esc(x.id)}"><div class="mem-row-t"><div class="mem-text">${esc(x.text)}</div><div class="mem-from">${x.from === "mode" ? "From your mode: Guard | Beast, at the top" : `From your limit${x.at ? ` · ${esc(memDay(x.at))}` : ""}`}</div></div>${change}</li>`;
}

/* the form a note is written in (F13's add row, and an edit in place): its words and its part, then signed (setMemory) */
function memFormHtml({ form, agent, id = "", topic = "style", text = "", yes }) {
  const max = (MEM.page && MEM.page.limits && MEM.page.limits.noteText) || 500;
  const field = form === "add"
    ? `<input id="mem-add-text" name="text" maxlength="${max}" placeholder="Add one thing it should remember…" autocomplete="off" />`
    : `<textarea id="mem-edit-text" name="text" rows="2" maxlength="${max}">${esc(text)}</textarea>`;
  return `<form class="mem-form ${form}" data-mem-form="${esc(form)}" data-agent="${esc(agent)}" data-id="${esc(id)}"><label class="sr" for="mem-${esc(form)}-text">${form === "add" ? "Add one thing it should remember" : "The note"}</label>${field}<label class="sr" for="mem-${esc(form)}-topic">Which part</label><select id="mem-${esc(form)}-topic" name="topic">${MEM_PARTS.map(([v, t]) => `<option value="${v}"${v === topic ? " selected" : ""}>${t}</option>`).join("")}</select>${form === "add" ? "" : memBtn("cancel", "Cancel", { cls: "btn btn-sm btn-ghost" })}<button type="submit" class="btn btn-primary btn-sm"${owns() ? "" : ` disabled title="${MEM_LOOK_ONLY}"`}>${esc(yes)}</button><div class="msg" data-mem-msg role="status"></div></form>`;
}

function memNotesHtml(a, owner) {
  const notes = a.notes;
  const lines = a.fromLimits || [];
  const count = notes.length + lines.length;
  const head = `<div class="card-head"><h2 class="h2" id="mem-h">What ${esc(memName(a))} remembers about you</h2><span class="dim small">${plural(count, "note")} · only on this machine</span></div>`;
  const parts = MEM_PARTS.map(([part, words]) => {
    const rows = [...(part === "rules" ? lines.map((x) => memLimitHtml(a, x, owner)) : []), ...notes.filter((n) => n.topic === part).map((n) => memNoteHtml(a, n, owner))];
    return rows.length ? `<div class="mem-part"><h3 class="mem-part-h">${esc(words)}</h3><ul class="mem-rows">${rows.join("")}</ul></div>` : "";
  }).join("");
  const empty = parts ? "" : `<p class="dim small">Nothing yet. What you tell it, and what it learns, shows here — each saying where it came from.</p>`;
  return `${head}${parts}${empty}${memFormHtml({ form: "add", agent: a.address, yes: "Add" })}`;
}

// ---- where it is used, and the switches (F13's right column) --------------------------------------------------------------------

function memUsesHtml(a) {
  const name = memName(a);
  const rows = [
    ["Its sessions", `${name} reads it when a session starts (portfolio_memory)`],
    ["Other agents", a.rules.share ? "Read it too: you switched it on" : `Do not read it: only ${name} does`],
    ["Your limits", "Written out as they stand; changing one is still a signed limit"],
  ];
  return `<h2 class="h2" id="mem-uses-h">Where it's used</h2><div class="mem-uses">${rows.map(([chip, words]) => `<div><span class="chip">${esc(chip)}</span><span>${esc(words)}</span></div>`).join("")}</div><p class="dim small">Every memory says where it came from: you said, it learned, from your limit. For what it learns, the switches are below. Words, not permission: no limit reads them.</p>`;
}

/* a switch of F13's: the row's words, and the track (role switch); flipping it is a signature */
const memSwitch = (a, key, title, sub, owner) =>
  `<div class="mem-sw"><div><div class="mem-sw-t">${esc(title)}</div><div class="dim small">${esc(sub)}</div></div><button type="button" role="switch" class="pf-switch" aria-checked="${String(!!a.rules[key])}" aria-label="${esc(title)}" data-mem-act="switch" data-agent="${esc(a.address)}" data-key="${key}" data-fk="mem-switch:${key}"${owner ? "" : ` disabled title="${MEM_LOOK_ONLY}"`}><span class="track" aria-hidden="true"></span></button></div>`;

function memSwitchesHtml(a, owner) {
  const name = memName(a);
  return `<h2 class="h2" id="mem-sw-h">Switches</h2>${memSwitch(a, "learn", `Let ${name} remember new things`, "Off: it uses only the ones it has", owner)}${memSwitch(a, "ask", "Ask me before keeping what it learns", "Each new memory waits for you, under Waiting for you", owner)}${memSwitch(a, "share", "Other agents can read it", `Off: only ${name} sees it`, owner)}<div class="mem-end">${memBtn("export", "Export", { cls: "btn btn-sm", data: { agent: a.address } })}${memBtn("forget-all", "Forget all", { cls: "btn btn-sm btn-danger", data: { agent: a.address }, off: !owner || !a.notes.length, title: owner ? "" : MEM_LOOK_ONLY })}</div><p class="dim small">Export is a JSON file. Forget all deletes the file: there is no bin.</p>`;
}

// ---- what the buttons do -----------------------------------------------------------------------------------------------------------

function memWire(el) {
  el.addEventListener("click", (e) => {
    const t = e.target.closest && e.target.closest("[data-mem-act], [data-mem-agent]");
    if (!t || !el.contains(t) || t.disabled) return;
    if (t.dataset.memAgent) {
      if (MEM.agent === t.dataset.memAgent) return;
      MEM.agent = t.dataset.memAgent;
      MEM.edit = "";
      // the agent picked is the route's, so a read that comes later draws the same one (#/memory?agent=0x…)
      return void go("memory", { agent: MEM.agent }, { replace: true });
    }
    memAct(t.dataset.memAct, t.dataset);
  });
  el.addEventListener("submit", (e) => {
    const f = e.target.closest && e.target.closest("form[data-mem-form]");
    if (!f) return;
    e.preventDefault();
    memSave(f);
  });
}

/* after a signed change: what the pane read is read again */
const memChanged = () => forget("/api/account/memory");
const memAgent = (address) => ((MEM.page && MEM.page.agents) || []).find((x) => x.address === address);
const memNote = (address, id) => ((memAgent(address) || {}).notes || []).find((n) => n.id === id);

async function memAct(act, d) {
  const a = memAgent(d.agent);
  switch (act) {
    case "agents":
      return void (typeof openAgents === "function" && openAgents());
    case "edit":
      MEM.edit = `${d.agent}:${d.id}`;
      return void memAgain();
    case "cancel":
      MEM.edit = "";
      return void memAgain();
    case "limit":
      // a limit is changed where limits are signed
      return void (typeof pfLimitForm === "function" && pfLimitForm({ agent: d.agent }));
    case "keep": {
      // what it learned, kept: its words signed as they are, so it stays what the agent learned
      const n = memNote(d.agent, d.id);
      if (n) await own({ type: "setMemory", scope: d.agent, id: n.id, topic: n.topic, text: n.text }, memChanged);
      return;
    }
    case "forget-note": {
      const n = memNote(d.agent, d.id);
      if (!n) return;
      if (!n.waiting && !(await confirmSheet(`Forget “${n.text.slice(0, 80)}${n.text.length > 80 ? "…" : ""}”? It is gone from the account, not hidden.`, { danger: true, title: "Forget a memory", yes: "Forget" }))) return;
      await own({ type: "forgetMemory", scope: d.agent, what: n.id }, memChanged);
      return;
    }
    case "forget-all": {
      if (!a) return;
      if (!(await confirmSheet(`Forget everything ${memName(a)} remembers about you? Its file is deleted: there is no bin. Your switches for it stay as they are.`, { danger: true, title: "Forget all", yes: "Forget all" }))) return;
      await own({ type: "forgetMemory", scope: a.address, what: "all" }, memChanged);
      return;
    }
    case "switch": {
      if (!a || !["learn", "ask", "share"].includes(d.key)) return;
      const r = { ...a.rules, [d.key]: !a.rules[d.key] };
      const w = (b) => (b ? "on" : "off");
      await own({ type: "setMemoryRules", scope: a.address, learn: w(r.learn), ask: w(r.ask), share: w(r.share) }, memChanged);
      return;
    }
    case "export": {
      if (!a) return;
      const data = { agent: { name: memName(a), address: a.address }, exportedAt: A.now, rules: a.rules, notes: a.notes, fromLimits: a.fromLimits || [] };
      const url = URL.createObjectURL(new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `memory-${slug(memName(a)) || a.address.slice(2, 10)}-${String(A.now).slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return;
    }
    default:
  }
}

/* a note written or changed: signed by the owner (setMemory), then the pane reads again */
async function memSave(f) {
  const msg = f.querySelector("[data-mem-msg]");
  const text = String(f.elements.text.value || "").trim();
  const topic = String(f.elements.topic.value || "style");
  const max = (MEM.page && MEM.page.limits && MEM.page.limits.noteText) || 500;
  const say = (t) => msg && ((msg.className = "msg no"), (msg.textContent = t));
  if (!text) return void say("Write it first.");
  if (text.length > max) return void say(`A note is at most ${max} characters; this one is ${text.length}.`);
  const r = await own({ type: "setMemory", scope: f.dataset.agent, id: f.dataset.id || "", topic, text }, () => {
    memChanged();
    MEM.edit = "";
    if (f.dataset.memForm === "add") f.reset();
  });
  // refused: the account's own words stay beside the form, the words typed stay in it
  if (r && refusedAt(r)) say(Owner.why(r) || "Refused");
}
