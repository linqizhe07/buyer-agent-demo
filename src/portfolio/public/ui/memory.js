/* The Account's Memory: what the agents remember (account/memory.ts on the server), every word of it the owner's to read, change and
   forget. Three things, as GET /api/account/memory gives them:
     About you       the owner's notes, signed, which every agent on the account reads
     its notes       what one agent chose to keep (portfolio_remember), signed with its own key
     conversation    what passed between the owner and that agent, as the account wrote it when it happened — drawn the way round 7 draws a
                     channel: the owner's words on the right in the accent, the agent's on the left, the account's answer to the agent (a
                     refusal and its code) a line of its own
   A change to a note, and every forgetting, is the owner's signed action (setMemory, forgetMemory: own()). Forgotten is gone from the
   account; the ledger never held the words. Words, never a permission: no limit reads any of it. */

const MEM = { page: null, err: "", agent: "", edit: "", adding: false, older: new Map(), olderAsked: "", soon: false, stuck: "" };
const MEM_TOPICS = [["preference", "Preference"], ["rule", "Rule"], ["fact", "Fact"], ["lesson", "Lesson"], ["progress", "Progress"], ["other", "Other"]];
const MEM_LOOK_ONLY = "This browser can look but not sign";
/* an agent's name as the account knows it, or the key it was: a key the account no longer lists keeps its memory until the owner forgets it */
const memName = (a) => a.name || `An earlier key ${short(a.address)}`;
/* a note's or a turn's time, as the page says times */
const memWhen = (iso) => (nyDay(iso) === nyDay(A.now) ? `Today ${nyTime(iso)}` : `${nyDay(iso)} ${nyTime(iso)}`);

/** the Memory pane (the shell calls it on every read, on the route and on the lens) */
function renderMemory({ el, owner, params = {} }) {
  if (/^0x[0-9a-f]{40}$/.test(String(params.agent || ""))) MEM.agent = params.agent;
  // an agent in the lens is the one shown
  const l = lensNow();
  if (l.kind === "agent") MEM.agent = l.id.toLowerCase();
  if (!el.firstElementChild || el.firstElementChild.dataset.mem !== "1") {
    el.innerHTML = '<div class="mem" data-mem="1"><div class="mem-who" data-mem-part="who"></div><div class="cols"><div class="col-main"><section class="sec mem-chat" data-mem-part="chat" aria-labelledby="mem-chat-h"></section><section class="sec mem-notes" data-mem-part="notes" aria-labelledby="mem-notes-h"></section></div><div class="col-side"><section class="sec mem-about" data-mem-part="about" aria-labelledby="mem-about-h"></section><section class="sec mem-how" data-mem-part="how" aria-label="How memory works"></section></div></div></div>';
    memWire(el);
  }
  memDraw(el, owner);
  memRead();
}

/* the read behind the pane, kept a few seconds (the page reads again every 20 seconds) */
function memRead() {
  api("/api/account/memory?turns=200", { ttl: 4_000 }).then((b) => {
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

/* the agents with memory, the ones standing first */
function memAgents() {
  const rank = { ok: 0, expired: 1, revoked: 2, gone: 3 };
  return ((MEM.page && MEM.page.agents) || []).slice().sort((a, b) => (rank[a.status] ?? 4) - (rank[b.status] ?? 4) || memName(a).localeCompare(memName(b)));
}

function memDraw(el, owner) {
  if (!MEM.page) {
    const wait = MEM.err ? `<div class="msg no">${esc(MEM.err)}</div>` : '<div class="skel-rows" aria-hidden="true"><span class="skel"></span><span class="skel"></span><span class="skel" style="width:60%"></span></div>';
    memPut(el, "who", "");
    memPut(el, "chat", wait);
    memPut(el, "notes", "");
    memPut(el, "about", "");
    memPut(el, "how", "");
    return;
  }
  // an agent in the lens is the only one shown
  const l = lensNow();
  const agents = memAgents().filter((a) => l.kind !== "agent" || a.address === l.id.toLowerCase());
  const shown = agents.find((a) => a.address === MEM.agent) || agents[0];
  if (shown) MEM.agent = shown.address;
  memPut(el, "who", memWhoHtml(agents, shown));
  if (shown) {
    const drew = memPut(el, "chat", memChatHtml(shown, owner));
    if (drew && MEM.stuck !== shown.address) {
      // a conversation shown for the first time opens at its latest turn
      MEM.stuck = shown.address;
      const box = el.querySelector(".mem-turns-box");
      if (box) box.scrollTop = box.scrollHeight;
    }
    memPut(el, "notes", memNotesHtml(shown, owner));
  } else {
    memPut(el, "chat", `<div class="card-head"><h2 class="h2" id="mem-chat-h">Conversation</h2></div><div class="empty"><p>No agent has been let in yet. Once one is, the account keeps what passes between you here — your words, its reports and asks, every instruction it signs and what came of it — and the notes it keeps for itself.</p><div class="acts">${memBtn("agents", "Agents…", { cls: "btn btn-sm" })}</div></div>`);
    memPut(el, "notes", "");
  }
  memPut(el, "about", memAboutHtml(owner));
  memPut(el, "how", memHowHtml());
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

// ---- the conversation, as round 7 draws a channel ----------------------------------------------------------------------------------

/* what a turn is, in a word or two, under its bubble */
const MEM_KIND = { intent: "Your words", withdraw: "Withdrawn", letIn: "Let in", revoke: "Revoked", limit: "A limit", wallet: "A wallet", card: "A card", declined: "Declined", policy: "The mode", venue: "An account", watch: "Watching", report: "Report", ask: "Asks", did: "Did", refusal: "Refused" };

function memTurns(a) {
  const seen = new Set();
  return [...(MEM.older.get(a.address) || []), ...a.conversation.turns].filter((t) => !seen.has(t.id) && seen.add(t.id));
}

function memChatHtml(a, owner) {
  const turns = memTurns(a);
  const c = a.conversation;
  const more = c.total > turns.length || (c.more && !MEM.older.has(a.address));
  const sub = c.total ? `${plural(c.total, "turn")}${c.dropped ? ` · the ${plural(c.dropped, "oldest turn")} let go` : ""}` : "Nothing yet";
  const head = `<div class="card-head"><div><h2 class="h2" id="mem-chat-h">Conversation with ${esc(memName(a))}</h2><span class="dim small">${esc(sub)} · it reads this back in every session</span></div><span class="tools">${c.total ? memBtn("forget-chat", "Forget the conversation", { cls: "btn btn-sm btn-ghost", data: { agent: a.address }, off: !owner, title: owner ? "" : MEM_LOOK_ONLY }) : ""}</span></div>`;
  if (!turns.length) return `${head}<div class="empty"><p>Nothing has passed between you and ${esc(memName(a))} yet. Your words to it (Hand to agent), its reports and asks, and every instruction it signs will be kept here, for it to read back.</p></div>`;
  let lastAt = 0;
  const rows = [];
  for (const t of turns) {
    const at = Date.parse(t.at);
    // a line with the time when the day changes, or after half an hour of nothing
    if (!lastAt || nyDay(t.at) !== nyDay(new Date(lastAt).toISOString()) || at - lastAt > 30 * 60_000) rows.push(`<li class="mem-time"><span>${esc(memWhen(t.at))}</span></li>`);
    lastAt = at;
    rows.push(memTurnHtml(a, t, owner));
  }
  const earlier = more ? `<li class="mem-earlier">${memBtn("earlier", MEM.olderAsked === a.address ? "Reading…" : "Earlier turns", { cls: "btn btn-sm btn-ghost", data: { agent: a.address }, off: MEM.olderAsked === a.address })}</li>` : "";
  return `${head}<div class="mem-turns-box"><ol class="mem-turns">${earlier}${rows.join("")}</ol></div>`;
}

function memTurnHtml(a, t, owner) {
  const all = t.id.startsWith("all-");
  const mark = [MEM_KIND[t.kind] || t.kind, t.ref || "", all ? "to every agent" : "", nyTime(t.at)].filter(Boolean).join(" · ");
  const rm = memBtn("forget-turn", icon("x", "sm"), { cls: "mem-rm", data: { agent: a.address, id: t.id }, off: !owner, title: owner ? (all ? "Forget this turn (every agent's)" : "Forget this turn") : MEM_LOOK_ONLY, aria: `Forget: ${t.text.slice(0, 60)}` });
  if (t.who === "account")
    return `<li class="mem-turn from-account" data-k="${esc(t.id)}"><div class="bub"><span class="mem-code">✗ ${esc(t.code || "refused")}</span> ${esc(t.text)}</div><span class="mem-meta">${esc(mark)}</span>${rm}</li>`;
  if (t.who === "owner")
    return `<li class="mem-turn from-you" data-k="${esc(t.id)}"><span class="sr">You: </span><div class="bub">${esc(t.text)}</div><span class="mem-meta">${esc(mark)}</span>${rm}</li>`;
  return `<li class="mem-turn from-agent" data-k="${esc(t.id)}">${avatar(memName(a).slice(0, 1), "sm")}<span class="sr">${esc(memName(a))}: </span><div class="bub">${esc(t.text)}</div><span class="mem-meta">${esc(mark)}</span>${rm}</li>`;
}

// ---- notes -----------------------------------------------------------------------------------------------------------------------

/* one note: its topic, its words, who wrote it last and when; edit, forget, and (an agent's) copy to About you */
function memNoteHtml(scope, n, owner) {
  const key = `${scope}:${n.id}`;
  if (MEM.edit === key) return `<li class="mem-note editing" data-k="${esc(n.id)}">${memFormHtml({ form: "edit", scope, id: n.id, topic: n.topic, text: n.text, yes: "Sign and save" })}</li>`;
  const by = n.by === "owner" ? "written by you" : scope === "about" ? "" : "its own";
  const when = memWhen(n.updatedAt || n.at);
  const acts = [
    memBtn("edit", "Edit", { data: { scope, id: n.id }, off: !owner, title: owner ? "" : MEM_LOOK_ONLY }),
    scope !== "about" ? memBtn("to-about", "Copy to About you", { data: { scope, id: n.id }, off: !owner, title: owner ? "Copy to About you, which every agent reads" : MEM_LOOK_ONLY }) : "",
    memBtn("forget-note", "Forget", { data: { scope, id: n.id }, off: !owner, title: owner ? "" : MEM_LOOK_ONLY }),
  ].filter(Boolean);
  return `<li class="mem-note" data-k="${esc(n.id)}"><div class="mem-note-h"><span class="chip">${esc((MEM_TOPICS.find(([v]) => v === n.topic) || [n.topic, n.topic])[1])}</span><span class="dim small">${esc([by, when].filter(Boolean).join(" · "))}</span></div><p class="mem-text">${esc(n.text)}</p><div class="mem-acts">${acts.join("")}</div></li>`;
}

/* the form a note is written in: its words and its topic, then signed (setMemory) */
function memFormHtml({ form, scope, id = "", topic = "preference", text = "", yes }) {
  const max = (MEM.page && MEM.page.limits && MEM.page.limits.noteText) || 500;
  return `<form class="mem-form" data-mem-form="${esc(form)}" data-scope="${esc(scope)}" data-id="${esc(id)}"><label class="sr" for="mem-${esc(form)}-${esc(scope)}-text">The note</label><textarea id="mem-${esc(form)}-${esc(scope)}-text" name="text" rows="3" maxlength="${max}" placeholder="${scope === "about" ? "What every agent should know about you: a preference, a rule, a fact" : "A note for this agent to read back"}" required>${esc(text)}</textarea><div class="mem-form-row"><label class="sr" for="mem-${esc(form)}-${esc(scope)}-topic">Topic</label><select id="mem-${esc(form)}-${esc(scope)}-topic" name="topic">${MEM_TOPICS.map(([v, t]) => `<option value="${v}"${v === topic ? " selected" : ""}>${t}</option>`).join("")}</select><span class="grow"></span>${form === "about-add" ? "" : memBtn("cancel", "Cancel", { cls: "btn btn-sm btn-ghost" })}<button type="submit" class="btn btn-primary btn-sm"${owns() ? "" : ` disabled title="${MEM_LOOK_ONLY}"`}>${esc(yes)}</button></div><div class="msg" data-mem-msg role="status"></div></form>`;
}

function memNotesHtml(a, owner) {
  const notes = a.notes;
  const max = (MEM.page.limits && MEM.page.limits.maxNotes) || 100;
  const head = `<div class="card-head"><div><h2 class="h2" id="mem-notes-h">What ${esc(memName(a))} keeps</h2><span class="dim small">${notes.length ? `${plural(notes.length, "note")} of ${max}` : "No notes yet"} · read by it and by you</span></div><span class="tools">${notes.length ? memBtn("forget-notes", "Forget every note", { cls: "btn btn-sm btn-ghost", data: { agent: a.address }, off: !owner, title: owner ? "" : MEM_LOOK_ONLY }) : ""}</span></div>`;
  const list = notes.length ? `<ul class="mem-list">${notes.map((n) => memNoteHtml(a.address, n, owner)).join("")}</ul>` : `<p class="dim small">${esc(memName(a))} keeps notes with portfolio_remember: a preference of yours it learned, a rule, a lesson, how far a task has got. You read every word here.</p>`;
  const add = MEM.adding === a.address ? memFormHtml({ form: "agent-add", scope: a.address, yes: "Sign and keep" }) : `<div>${memBtn("add", `${icon("plus", "sm")}Write a note for ${esc(memName(a))}`, { cls: "btn btn-sm", data: { agent: a.address }, off: !owner, title: owner ? "" : MEM_LOOK_ONLY })}</div>`;
  return `${head}${list}${add}`;
}

function memAboutHtml(owner) {
  const notes = MEM.page.about;
  const max = (MEM.page.limits && MEM.page.limits.maxAbout) || 50;
  const head = `<div class="card-head"><div><h2 class="h2" id="mem-about-h">About you</h2><span class="dim small">Every agent on the account reads these${notes.length ? ` · ${plural(notes.length, "note")} of ${max}` : ""}</span></div></div>`;
  const list = notes.length ? `<ul class="mem-list">${notes.map((n) => memNoteHtml("about", n, owner)).join("")}</ul>` : '<p class="dim small">Nothing yet. What you write here, every agent reads when it starts: how you like to trade, what never to do, what to keep in mind.</p>';
  return `${head}${list}${memFormHtml({ form: "about-add", scope: "about", yes: "Sign and keep" })}`;
}

function memHowHtml() {
  return `<div class="label">How memory works</div><ul class="mem-how-l"><li>The account writes the conversation as it happens: your words to an agent, its reports and asks, every instruction it signs and what came of it.</li><li>An agent reads it back with About you and its own notes (portfolio_memory) when a session starts, and keeps notes with its own key.</li><li>Forgetting takes it away for good. The ledger never held the words: it says only who changed which note, and when.</li><li>Words, not permission: what an agent may do is still only its limits and your cards.</li><li>Never kept: keys, secrets, passwords, recovery phrases, IP addresses.</li></ul>`;
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
      MEM.adding = false;
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
const memNote = (scope, id) => (scope === "about" ? MEM.page.about : ((MEM.page.agents.find((a) => a.address === scope) || {}).notes || [])).find((n) => n.id === id);

async function memAct(act, d) {
  const a = (MEM.page && MEM.page.agents.find((x) => x.address === d.agent)) || null;
  switch (act) {
    case "agents":
      return void (typeof openAgents === "function" && openAgents());
    case "edit":
      MEM.edit = `${d.scope}:${d.id}`;
      return void memAgain();
    case "add":
      MEM.adding = d.agent;
      return void memAgain();
    case "cancel":
      MEM.edit = "";
      MEM.adding = false;
      return void memAgain();
    case "to-about": {
      const n = memNote(d.scope, d.id);
      if (n) await own({ type: "setMemory", scope: "about", id: "", topic: n.topic, text: n.text }, memChanged);
      return;
    }
    case "forget-note": {
      const n = memNote(d.scope, d.id);
      if (!n) return;
      const whose = d.scope === "about" ? "About you" : `${memName(MEM.page.agents.find((x) => x.address === d.scope) || { address: d.scope })}'s notes`;
      if (!(await confirmSheet(`Forget this note from ${whose}? It is gone from the account, not hidden.`, { danger: true, title: "Forget a note", yes: "Forget" }))) return;
      await own({ type: "forgetMemory", scope: d.scope, what: d.id }, memChanged);
      return;
    }
    case "forget-turn": {
      const all = d.id.startsWith("all-");
      if (!(await confirmSheet(all ? "Forget this turn? It was said to every agent: none of them reads it again." : "Forget this turn? The agent does not read it again.", { danger: true, title: "Forget a turn", yes: "Forget" }))) return;
      MEM.older.delete(d.agent);
      await own({ type: "forgetMemory", scope: all ? "everyone" : d.agent, what: d.id }, memChanged);
      return;
    }
    case "forget-chat":
    case "forget-notes": {
      if (!a) return;
      const chat = act === "forget-chat";
      if (!(await confirmSheet(chat ? `Forget the whole conversation with ${memName(a)}? It does not read any of it again. The words said to every agent stay theirs: forget those one by one.` : `Forget every note ${memName(a)} keeps? It is gone from the account, not hidden.`, { danger: true, title: chat ? "Forget the conversation" : "Forget every note", yes: "Forget" }))) return;
      MEM.older.delete(a.address);
      await own({ type: "forgetMemory", scope: a.address, what: chat ? "conversation" : "notes" }, memChanged);
      return;
    }
    case "earlier": {
      if (!a) return;
      const first = memTurns(a)[0];
      MEM.olderAsked = a.address;
      memAgain();
      const b = await api(`/api/account/memory/agent?address=${a.address}&limit=100${first ? `&before=${encodeURIComponent(first.id)}` : ""}`);
      MEM.olderAsked = "";
      if (b && b.ok) MEM.older.set(a.address, [...b.conversation.turns, ...(MEM.older.get(a.address) || [])]);
      else toast(refusalOf(b) || "The account did not answer.", "no");
      return void memAgain();
    }
    default:
  }
}

/* a note written or changed: signed by the owner (setMemory), then the pane reads again */
async function memSave(f) {
  const msg = f.querySelector("[data-mem-msg]");
  const text = String(f.elements.text.value || "").trim();
  const topic = String(f.elements.topic.value || "other");
  const max = (MEM.page && MEM.page.limits && MEM.page.limits.noteText) || 500;
  const say = (t) => msg && ((msg.className = "msg no"), (msg.textContent = t));
  if (!text) return void say("Write the note first.");
  if (text.length > max) return void say(`A note is at most ${max} characters; this one is ${text.length}.`);
  const r = await own({ type: "setMemory", scope: f.dataset.scope, id: f.dataset.id || "", topic, text }, () => {
    memChanged();
    MEM.edit = "";
    MEM.adding = false;
    if (f.dataset.memForm === "about-add") f.reset();
  });
  // refused: the account's own words stay beside the form, the words typed stay in it
  if (r && refusedAt(r)) say(Owner.why(r) || "Refused");
}
