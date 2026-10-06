/* Handing something to an agent: the owner's words (an intent) — to which agent, where, which way, about how much, until when — signed, which
   agents read over MCP and report on; and, when asked, a trading limit to do it with. An intent grants nothing: an agent acts only inside its
   limits, and in Conservative every order it asks for comes to the owner as a card first. The open intents are listed with what the agents
   reported, each to change or withdraw. */

const HTA_DAYS = [["1", "1 day"], ["3", "3 days"], ["7", "7 days"], ["30", "30 days"]];
const HTA_TEXT = 200;
/* what an agent says of an intent, in a word */
const HTA_REPORT = { taking: "Taking it on", done: "Done", cannot: "Can't do it", note: "Note" };
/* what the words box suggests, by what is being handed over */
const HTA_HINT = {
  trade: "e.g. Build a SOL position under $140, a little at a time",
  perps: "e.g. Keep a small BTC long; close it if it falls 5%",
  predictions: "e.g. Buy Yes on a Fed cut in December, under 60¢",
  swap: "e.g. Turn my WETH into USDC if ETH falls under $2,000",
  earn: "e.g. Keep idle USDC earning, never more than $500 in",
};

/** The owner's words, and when asked a limit for them, as the account signs them. `v` is the composer's fields: agent ("*" for every agent),
 * venue, symbol, side, usd, text, days (or `until`, a moment: words being changed keep the end of the limit given with them), and
 * withLimit with perOrder, budget and scope ("trade", or "earn" when what is handed over is earning). A limit is for one agent, at the
 * venue named — when none is, every venue on the account for trading, and for earning the venues that earn (`earnAt`, comma-separated: an
 * earn limit names its venues) — and it ends when the words do: the same moment, and withdrawing the words ends it too (htaWithdrawDrafts) */
function htaDrafts(v, now) {
  const until = Number(v.until) > now ? Number(v.until) : now + Number(v.days || 7) * DAY;
  const agent = v.agent && v.agent !== "*" ? String(v.agent).toLowerCase() : "*";
  const intent = { type: "setIntent", id: v.id || "", agent, venue: String(v.venue || "").trim(), symbol: String(v.symbol || "").trim(), side: v.side === "buy" || v.side === "sell" ? v.side : "", usd: String(v.usd || "").trim(), text: String(v.text || "").trim().slice(0, HTA_TEXT), validUntil: until };
  const budget = String(v.budget || "").trim();
  const scope = v.scope === "earn" ? "earn" : "trade";
  const allow = intent.venue || (scope === "earn" ? String(v.earnAt || "").trim() : "*");
  const limit = v.withLimit && agent !== "*" && allow ? { type: "approveSpend", agent, scope, allow, perPayment: String(v.perOrder || "").trim() || budget, budget, windowHours: 0, validUntil: until } : null;
  return { intent, limit };
}

/** the limit given with an open intent: the agent's limit of the kind the composer gives (trading or earning) that ends the same moment as
 * the words — signed together, they end together */
function htaLimitOf(x) {
  if (!x || x.agent === "*" || !A) return null;
  return A.spend.find((s) => (s.scope === "trade" || s.scope === "earn") && s.agent === x.agent.toLowerCase() && s.validUntil === x.validUntil && !s.expired) || null;
}

/** withdrawing an intent, as the account signs it: the words, and the limit given with them (its end, a budget of nothing), so the agent's
 * authority ends when the owner's words do */
function htaWithdrawDrafts(x, now) {
  const words = { type: "setIntent", id: x.id, agent: x.agent, venue: "", symbol: "", side: "", usd: "", text: "", validUntil: 0 };
  const lim = htaLimitOf(x);
  return lim ? [words, { type: "approveSpend", agent: lim.agent, scope: lim.scope, allow: lim.allow.join(","), perPayment: "0", budget: "0", windowHours: 0, validUntil: now + DAY }] : [words];
}

/** Hand something to an agent. preset { agent, venue, symbol, side, usd, text, kind ("trade" · "perps" · "predictions" · "swap" · "earn"),
 * intent (an open one, to change its words) }. On the Trade pane the composer takes the panel; anywhere else it opens in a sheet, with the
 * open intents under it */
function openHandToAgent(preset = {}) {
  if (!A) return;
  if (typeof tkHandInPanel === "function" && tkHandInPanel(preset)) return;
  const change = (x) => htaMount($("sheet").querySelector("[data-hta]"), { intent: x }, { inSheet: true });
  const body = openSheet('<div data-hta></div><section class="sheet-sec hta-open" aria-labelledby="hta-open-h"><h3 class="h2" id="hta-open-h">Your words to agents</h3><div data-hta-list></div></section>', {
    title: "Hand to agent",
    redraw: () => {
      const l = $("sheet").querySelector("[data-hta-list]");
      if (l) htaIntents(l, owns(), { change });
    },
  });
  htaMount(body.querySelector("[data-hta]"), preset, { inSheet: true });
  htaIntents(body.querySelector("[data-hta-list]"), owns(), { change });
}

/** the composer, drawn into `el`: in the Trade pane's panel (with its own head and a close) or in a sheet. The account prepares the words
 * (and the limit) as they are typed; what is signed is shown before the signature */
function htaMount(el, preset = {}, { inSheet = false, close } = {}) {
  if (!el || !A) return;
  const was = preset.intent || null;
  const owner = owns();
  const keys = A.keys.filter((k) => k.status === "ok");
  const lens = lensNow();
  const agent0 = (was && was.agent) || preset.agent || (lens.kind === "agent" ? lens.id.toLowerCase() : keys.length === 1 ? keys[0].address : "*");
  const kind = preset.kind || "trade";
  // what the limit is for: earning has its own; everything else trades
  const scope = kind === "earn" ? "earn" : "trade";
  // where: the accounts that do what is handed over; an earn limit names the venues that earn (never every account)
  const earners = connected().filter((v) => v.earn && v.earn.can !== false);
  const venues = scope === "earn" ? connected().filter((v) => v.earn) : connected().filter((v) => v.trade);
  const v0 = was ? was.venue : preset.venue || (lens.kind === "venue" ? lens.id : "");
  const venueOpts = [["", scope === "earn" ? `Let it choose${earners.length ? ` (${earners.map((v) => v.name).join(", ")})` : ""}` : "Let it choose"], ...venues.map((v) => [v.id, v.name]), ...(v0 && !venues.some((v) => v.id === v0) ? [[v0, preset.venueName || nameOf(v0)]] : [])];
  const side0 = (was && was.side) || preset.side || "";
  // words being changed that a limit was given with keep its end: the two end together
  const tied = was ? htaLimitOf(was) : null;
  const untilField = tied ? `<label class="fld">Until<input name="untilShown" value="${esc(nyDay(was.validUntil))}, with its limit" disabled /><input type="hidden" name="until" value="${esc(String(Date.parse(was.validUntil)))}" /></label>` : `<label class="fld">Until${select("days", HTA_DAYS, "7")}</label>`;
  el.innerHTML = `${inSheet ? "" : `<div class="tk-h"><h2 class="tk-title">${was ? "Change your words" : "Hand to agent"}</h2><button type="button" class="icon-btn" data-hta-close aria-label="Close">${icon("x")}</button></div>`}
    <p class="dim small hta-lead">${was ? `Changing ${esc(was.id)}: what agents said about the old words goes with them.` : "Your words go to the agent; it reads them over MCP and reports back."} They grant nothing: it still acts only inside its limits${A.mode === "open" ? ", and in Aggressive it trades inside them without asking" : ", and in Conservative every order it asks for comes to you first"}.</p>
    ${keys.length ? "" : `<div class="callout"><b>No agent is let in yet</b><span class="dim small">Words to every agent wait for the first one. Run the agent setup command where your agent runs, then let it in under Agents.</span><div class="acts hta-acts"><button type="button" class="btn btn-sm" data-hta-setup>${icon("copy", "sm")}Copy setup command</button><button type="button" class="btn btn-sm" data-hta-agents>${icon("agent", "sm")}Agents</button></div></div>`}
    ${A.dial && A.dial.sessionEnded ? '<p class="msg no">The agents\' session has ended: they can do nothing until you start a new one in Settings.</p>' : ""}
    <form class="tk-form hta-form" novalidate autocomplete="off">
      <input type="hidden" name="id" value="${esc(was ? was.id : "")}" />
      <input type="hidden" name="side" value="${esc(side0)}" />
      <label class="fld">Agent${select("agent", [["*", keys.length ? "Every agent" : "Every agent (none let in yet)"], ...keys.map((k) => [k.address, k.name])], agent0)}</label>
      <div class="row2"><label class="fld">Where${select("venue", venueOpts, v0)}</label><label class="fld">Market<input name="symbol" maxlength="80" placeholder="Let it choose" spellcheck="false" value="${esc((was ? was.symbol : preset.symbol) || "")}" /></label></div>
      <div><div class="label">Which way</div><div data-hta-side></div></div>
      <div class="row2"><label class="fld">About how much ($)<input name="usd" inputmode="decimal" placeholder="Let it decide" value="${esc((was ? was.usd : preset.usd) || "")}" /></label>${untilField}</div>
      ${tied ? `<p class="dim small">${esc(keyName(tied.agent))}'s ${tied.scope === "earn" ? "earn" : "trading"} limit was given with these words (${esc(fine(tied.spentUsd))} of ${esc(fine(tied.budgetUsd))} used): the new words end when it does. To change how long, withdraw them and hand over again.</p>` : ""}
      <label class="fld">Your words<textarea name="text" maxlength="${HTA_TEXT}" rows="3" placeholder="${esc(HTA_HINT[kind] || HTA_HINT.trade)}">${esc((was ? was.text : preset.text) || "")}</textarea><span class="hta-count" data-count aria-live="polite"></span></label>
      <input type="hidden" name="scope" value="${scope}" />
      <fieldset class="hta-limit"${keys.length ? "" : " hidden"}><legend class="sr">A limit</legend><label class="chk1"><input type="checkbox" name="withLimit" /> Also give it ${scope === "earn" ? "an earn limit" : "a trading limit"} for this</label><div data-limit hidden><div class="row2"><label class="fld">${scope === "earn" ? "Each time ($)" : "Per order ($)"}<input name="perOrder" inputmode="decimal" placeholder="25" /></label><label class="fld">In all ($)<input name="budget" inputmode="decimal" placeholder="100" /></label></div><p class="dim small" data-limit-now></p></div></fieldset>
      <div class="quote" data-q><span class="dim">Say what you'd like, in your own words.</span></div>
      <div data-sign></div>
      <div class="msg" data-msg role="status"></div>
      <button type="submit" class="btn btn-primary btn-block" data-go disabled${owner ? "" : ' title="This browser only looks: pair it to sign"'}>Sign and hand over</button>
      ${inSheet ? "" : '<button type="button" class="btn btn-block" data-hta-self>Do it myself instead</button>'}
    </form>`;
  const form = el.querySelector("form");
  const q = (s) => form.querySelector(s);
  const box = q("[data-q]");
  const sign = q("[data-sign]");
  const btn = q("[data-go]");
  const msg = q("[data-msg]");
  const say = (text, state = "") => {
    msg.className = `msg${text && state ? ` ${state}` : ""}`;
    msg.textContent = text || "";
  };
  const closeBtn = el.querySelector("[data-hta-close]");
  if (closeBtn) closeBtn.addEventListener("click", () => (close ? close() : htaMount(el, {}, { inSheet, close })));
  const setupBtn = el.querySelector("[data-hta-setup]");
  if (setupBtn) setupBtn.addEventListener("click", () => typeof copySetup === "function" && copySetup());
  const agentsBtn = el.querySelector("[data-hta-agents]");
  if (agentsBtn) agentsBtn.addEventListener("click", () => typeof openAgents === "function" && openAgents());
  const selfBtn = el.querySelector("[data-hta-self]");
  if (selfBtn) selfBtn.addEventListener("click", () => {
    const f = Object.fromEntries(new FormData(form).entries());
    if (typeof openTicket === "function") openTicket({ venue: f.venue || "", symbol: f.venue ? String(f.symbol || "").trim() : "", side: f.side === "sell" ? "sell" : "buy", ...(Number(f.usd) > 0 ? { amount: f.usd, unit: "usd" } : {}) });
  });
  q("[data-hta-side]").innerHTML = seg([["", "Either"], ["buy", "Buy"], ["sell", "Sell"]], side0, (v) => {
    form.elements.side.value = v;
    later(0);
  }, { label: "Which way" });
  const count = () => {
    const n = [...String(form.elements.text.value || "")].length;
    q("[data-count]").textContent = `${n}/${HTA_TEXT}`;
  };
  /* a limit is one agent's; the one it has now is replaced by it */
  const limitShape = () => {
    const a = form.elements.agent.value;
    const fs = q(".hta-limit");
    const on = form.elements.withLimit.checked;
    q("[data-limit]").hidden = !on;
    if (a === "*") {
      form.elements.withLimit.checked = false;
      form.elements.withLimit.disabled = true;
      q("[data-limit]").hidden = true;
      fs.title = "A limit is one agent's: pick the agent above";
    } else if (scope === "earn" && !form.elements.venue.value && !earners.length) {
      // an earn limit names the venues that earn: with none that can, there is nothing to name
      form.elements.withLimit.checked = false;
      form.elements.withLimit.disabled = true;
      q("[data-limit]").hidden = true;
      fs.title = "None of your accounts can put money to earn now, so there is no earn limit to give";
    } else {
      form.elements.withLimit.disabled = !writesOn();
      fs.title = writesOn() ? "" : "This server was started read-only: no agent trades from it";
    }
    const now = A.spend.find((s) => s.scope === scope && s.agent === a);
    const what = scope === "earn" ? "earn limit" : "trading limit";
    q("[data-limit-now]").textContent = now ? `It replaces ${keyName(a)}'s ${what} now: ${fine(now.spentUsd)} of ${fine(now.budgetUsd)} used, up to ${fine(now.perPaymentUsd)} ${scope === "earn" ? "each time" : "an order"} at ${now.allow.map(nameOf).join(", ")}${now.expired ? " (ran out)" : `, until ${nyDay(now.validUntil)}`}.` : `${a === "*" ? "" : `${keyName(a)} has no ${what} yet: without one it can ${scope === "earn" ? "put nothing to earn" : "place nothing"}.`}`;
  };
  let prepared = [];
  let seq = 0;
  let timer = 0;
  const requote = async () => {
    if (!form.isConnected) return;
    const my = ++seq;
    prepared = [];
    btn.disabled = true;
    btn.textContent = was && form.elements.id.value ? "Sign the new words" : "Sign and hand over";
    sign.innerHTML = "";
    limitShape();
    const f = Object.fromEntries(new FormData(form).entries());
    const d = htaDrafts({ ...f, withLimit: !!f.withLimit, earnAt: earners.map((v) => v.id).join(",") }, nowMs());
    if (!d.intent.text) return void (box.innerHTML = `<span class="dim">Say what you'd like, in your own words (up to ${HTA_TEXT} characters).</span>`);
    if (d.limit && !(Number(d.limit.budget) > 0)) return void (box.innerHTML = '<span class="dim">Type the limit: how much in all, and per order.</span>');
    box.innerHTML = '<span class="dim">Preparing…</span>';
    const r1 = await Owner.prepare(d.intent);
    const r2 = d.limit ? await Owner.prepare(d.limit) : null;
    if (!form.isConnected || my !== seq) return;
    if (r1.status !== 200) return void (box.innerHTML = `<div class="msg no">${esc(Owner.why(r1) || "Refused")}</div>`);
    if (r2 && r2.status !== 200) return void (box.innerHTML = `<div class="msg no">${esc(Owner.why(r2) || "Refused")}</div>`);
    prepared = [r1.body, ...(r2 ? [r2.body] : [])];
    const i = d.intent;
    const who = i.agent === "*" ? "every agent" : keyName(i.agent);
    const where = [i.side ? (i.side === "buy" ? "buy" : "sell") : "", i.symbol || "", i.venue ? `at ${nameOf(i.venue)}` : "", i.usd ? `about ${money(Number(i.usd))}` : ""].filter(Boolean).join(" ");
    box.innerHTML = `<div class="big"><span>${prepared.length > 1 ? "1 · " : ""}Your words to ${esc(who)}</span><span>until ${esc(nyDay(new Date(i.validUntil).toISOString()))}</span></div><div class="path">“${esc(i.text)}”${where ? ` · ${esc(where)}` : ""}</div>${d.limit ? `<div class="big"><span>2 · Its ${d.limit.scope === "earn" ? "earn" : "trading"} limit</span><span>${money(Number(d.limit.budget))} in all</span></div><div class="path">Up to ${money(Number(d.limit.perPayment))} ${d.limit.scope === "earn" ? "each time it puts money in" : "an order"} at ${esc(d.limit.allow === "*" ? "every account on the account now" : d.limit.allow.split(",").map(nameOf).join(", "))}, until ${esc(nyDay(new Date(d.limit.validUntil).toISOString()))}, when your words end; withdrawing them ends it too. ${A.mode === "open" ? "Aggressive: it goes inside it without asking." : "Conservative: each one still waits for you."}</div>` : ""}`;
    sign.innerHTML = prepared.length > 1 ? `${whatYouSign(prepared[0]).replace("What you sign", "What you sign · 1 your words")}${whatYouSign(prepared[1]).replace("What you sign", "What you sign · 2 its limit")}` : whatYouSign(prepared[0]);
    btn.textContent = prepared.length > 1 ? "Sign both and hand over" : was ? "Sign the new words" : "Sign and hand over";
    btn.disabled = !owns();
  };
  const later = (ms = 400) => {
    clearTimeout(timer);
    timer = setTimeout(requote, ms);
  };
  form.addEventListener("input", (e) => {
    if (e.target.name === "text") count();
    later();
  });
  form.addEventListener("change", (e) => {
    if (e.target.name === "agent" || e.target.name === "withLimit" || e.target.name === "venue") limitShape();
    later(0);
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!prepared.length || busy || !owns()) return;
    const all = prepared;
    btn.disabled = true;
    say("Signing…", "wait");
    busy = true;
    document.body.classList.add("busy");
    const done = [];
    let refusal = "";
    try {
      for (const p of all) {
        const r = await Owner.submit(p);
        if (refusedAt(r)) {
          refusal = Owner.why(r) || "Refused";
          break;
        }
        done.push(saidOf(r.body) || p.action.type);
      }
    } finally {
      busy = false;
      document.body.classList.remove("busy");
    }
    if (refusal) {
      flash = done.length ? `${done.join(" · ")} — then refused: ${refusal}` : refusal;
      say(flash, "no");
    } else {
      said = done.join(" · ");
      say(said, "ok");
      // signed: the words, the limit and what it was changing are cleared, so nothing is signed twice by a second press
      form.elements.text.value = "";
      form.elements.id.value = "";
      form.elements.withLimit.checked = false;
      form.elements.perOrder.value = "";
      form.elements.budget.value = "";
      count();
    }
    await load();
    if (form.isConnected) later(0);
  });
  limitShape();
  count();
  later(0);
}

/** The owner's open intents, in the lens (an agent's lens: those to it and to every agent): the words, where and until when, the latest
 * report of each agent on them — and Change words, Withdraw (a signed setIntent with no time left) */
function htaIntents(el, owner, { change } = {}) {
  if (!el || !A) return;
  const lens = lensNow();
  const list = (A.intents || []).filter((x) => lens.kind !== "agent" || x.agent === "*" || x.agent.toLowerCase() === lens.id.toLowerCase()).filter((x) => lens.kind !== "venue" || !x.venue || x.venue === lens.id);
  if (!list.length) return void (el.innerHTML = '<p class="empty">No open intents. Hand something to an agent and it shows here, with what the agent reports.</p>');
  const rep = (r) => `<div class="hta-rep"><span class="tag${r.status === "done" ? " up" : r.status === "cannot" ? " warn" : ""}">${esc(HTA_REPORT[r.status] || r.status)}</span> ${esc(r.note)}${r.refs && r.refs.length ? ` <span class="dim">${esc(r.refs.join(", "))}</span>` : ""}<span class="why">${esc(r.byName)} · ${esc(nyDay(r.at))} ${esc(nyTime(r.at))}</span></div>`;
  el.innerHTML = `<ul class="hta-list" role="list">${list.map((x) => {
    const meta = [x.agent === "*" ? "every agent" : x.agentName, x.side, x.symbol, x.venue ? `at ${nameOf(x.venue)}` : "", x.usd ? `about ${money(Number(x.usd))}` : "", `until ${nyDay(x.validUntil)}`].filter(Boolean).join(" · ");
    const others = (x.byAgent || []).filter((r) => !x.report || r.by !== x.report.by || r.at !== x.report.at);
    const lim = htaLimitOf(x);
    const limLine = lim ? `<div class="dim small">With its ${lim.scope === "earn" ? "earn" : "trading"} limit: ${esc(fine(lim.spentUsd))} of ${esc(fine(lim.budgetUsd))} used, up to ${esc(fine(lim.perPaymentUsd))} ${lim.scope === "earn" ? "each time" : "an order"} at ${esc(lim.allow.map(nameOf).join(", "))}. It ends with these words.</div>` : "";
    return `<li class="hta-it"><div class="hta-top"><b>“${esc(x.text)}”</b><span class="dim small">${esc(meta)} · ${esc(x.id)}</span></div>${limLine}${x.report ? rep(x.report) : '<div class="dim small">No report yet.</div>'}${others.map(rep).join("")}${x.reports > 1 ? `<div class="dim small">${esc(plural(x.reports, "report"))} on these words</div>` : ""}${owner ? `<div class="acts hta-acts"><button type="button" class="btn btn-sm" data-hta-change="${esc(x.id)}">Change words</button><button type="button" class="btn btn-sm" data-hta-withdraw="${esc(x.id)}">Withdraw</button></div>` : ""}</li>`;
  }).join("")}</ul>`;
  for (const b of el.querySelectorAll("button[data-hta-withdraw]")) b.addEventListener("click", async () => {
    const x = A.intents.find((i) => i.id === b.dataset.htaWithdraw);
    if (!x) return;
    const [words, end] = htaWithdrawDrafts(x, nowMs());
    if (!end) return void own(words);
    const lim = htaLimitOf(x);
    // the limit given with the words ends with them: two signatures, said before either
    const yes = await confirmSheet(`Withdraw these words, and end the ${lim.scope === "earn" ? "earn" : "trading"} limit you gave ${keyName(lim.agent)} with them (${fine(lim.spentUsd)} of ${fine(lim.budgetUsd)} used)? Two signatures: the words, then the limit.`, { title: "Withdraw", yes: "Withdraw both", danger: true });
    if (yes) own(words, () => own(end));
  });
  for (const b of el.querySelectorAll("button[data-hta-change]")) b.addEventListener("click", () => {
    const x = A.intents.find((i) => i.id === b.dataset.htaChange);
    if (x && change) change(x);
  });
}
