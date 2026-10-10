/* Earn and Sell many: the two sheets for money you already hold. openEarn(preset) puts money into a venue's earn products and takes it out
   again — prepared by the account (the product, its yield and lock, where money taken out lands), shown, and signed as liveEarn;
   openSellMany(preset) sells up to ten holdings at market, one signature each (a perpetual's or a future's position is closed instead).
   Both read the account's own doors (GET /api/account/earn · /api/account/sellable), narrow to the top bar's lens (portfolio.js pfVenueIn)
   or to the venue a preset names, and live in the one sheet (core openSheet): the Portfolio opens them from Cash ready (Earn…), an earn
   row's Withdraw… and the Assets tools (Sell many…). preset { venue, side: "withdraw" | "supply", product } for Earn; { venue } for Sell
   many. */

// ---- Earn ---------------------------------------------------------------------------------------

/** what is ready at a product's venue in its asset, to put in: not what is on its way, nor what is already in an earn product there */
function enReady(p) {
  const v = ((typeof A !== "undefined" && A && A.venues) || []).find((x) => x.id === p.venue);
  return ((v && v.holdings) || []).filter((h) => String(h.asset || "").toUpperCase() === String(p.asset || "").toUpperCase() && !h.inTransit && h.class !== "earn").reduce((s, h) => s + h.amount, 0);
}
/** the products Earn lists: to put money in, those the venue says take it now first — among them, those in an asset ready at their venue
 * (a venue may list hundreds, most in coins not held there: Binance) — and the others with their reason; to take it out, those something
 * is in */
function enList(view, kind) {
  const held = (p) => view.positions.some((h) => h.venue === p.venue && h.product === p.id && h.amount > 0);
  if (kind === "withdraw") return view.products.filter(held);
  const open = view.products.filter((p) => p.canSupply);
  const ready = new Set(open.filter((p) => enReady(p) > 0));
  return [...open.filter((p) => ready.has(p)), ...open.filter((p) => !ready.has(p)), ...view.products.filter((p) => !p.canSupply)];
}
/* a connected venue that does not serve the network the account runs on now (core servedHere): nothing goes in or out of earn there from
   here, so its products are not offered; it is named once instead */
const enAwayAt = (id) => !servedHere(((typeof A !== "undefined" && A && A.venues) || []).find((v) => v.id === id));
/** what Earn could not list, each venue once: the ones that do not serve this network now (the read's place rule, or a venue on the account
 * that earns and is marked so) — a state, named in one quiet line — and the reads that failed, each in its own words */
function enMissing(missing, within) {
  const mine = (missing || []).filter((m) => within(m.venue));
  const away = new Map();
  for (const m of mine) if (awayMiss(m) && !away.has(m.venue)) away.set(m.venue, m);
  for (const v of (typeof A !== "undefined" && A && A.venues) || []) if (v.live && v.earn && !servedHere(v) && within(v.id) && !away.has(v.id)) away.set(v.id, { venue: v.id, venueName: v.name, why: (v.notServed && v.notServed.said) || "" });
  const seen = new Set(away.keys());
  return { away: [...away.values()], failed: mine.filter((m) => !seen.has(m.venue) && seen.add(m.venue)) };
}
/* money into or out of one product, as the account prepares it: the product's own asset, the amount typed — or "all" of it out */
const enDraft = (p, kind, amount) => ({ type: "liveEarn", venue: p.venue, kind: kind === "withdraw" ? "withdraw" : "supply", product: p.id, asset: p.asset, amount: String(amount ?? "").trim() });
/* a yield as the venue states it: 5.2% APY, or a range */
const enRate = (x) => (x.apy === undefined ? "" : `${(x.apy * 100).toFixed(2)}%${x.apyHigh !== undefined ? `–${(x.apyHigh * 100).toFixed(2)}%` : ""} ${(x.rateKind || "apy").toUpperCase()}`);
/** one product as a row to pick: its name and yield, one line "venue · asset · lock" (and what is in it, on Take out), the other facts on
 * hover; a product not taking money now keeps a small Closed tag and its reason */
function enRow(p, { chosen = "", kind = "supply", held = null } = {}) {
  const id = `${p.venue}|${p.id}`;
  const lock = p.lockDays ? `locked ${p.lockDays} days` : p.lockDays === 0 ? "out at once" : "";
  const line = [p.venueName, p.asset, lock, held && held.amount > 0 ? `in it: ${qtyOf(held.amount)} ${held.asset}` : ""].filter(Boolean).join(" · ");
  const facts = [p.protocol, p.chain, p.minAmount ? `at least ${qtyOf(p.minAmount)} ${p.asset}` : "", p.lands ? `taken out, it lands in ${p.lands}` : ""].filter(Boolean).join(" · ");
  const closed = kind === "supply" && !p.canSupply;
  return `<button type="button" class="en-at${closed ? " off" : ""}" data-prod="${esc(id)}" data-fk="en:${esc(id)}" aria-pressed="${String(id === chosen)}"${facts ? ` title="${esc(facts)}"` : ""}><span><b>${esc(p.name)}</b>${closed ? ' <span class="tag">Closed</span>' : ""}<span class="why">${esc(line)}</span>${closed && p.why ? `<span class="why">${esc(p.why)}</span>` : ""}</span><span class="tab-nums en-at-r">${esc(enRate(p))}</span></button>`;
}

/** Earn, in the sheet: Put in | Take out, the products the connected venues offer (a vault through the MetaMask Agent Wallet, an exchange's
 * flexible savings), the amount — or all of it, out — and the signature. After it went through, what is held and what earns are read again
 * and the sheet redrawn in place */
function openEarn(preset = {}) {
  if (!A) return;
  const venueIn = pfVenueIn(lensNow());
  const inLens = (id) => (preset.venue ? id === preset.venue : venueIn(id));
  let kind = preset.side === "withdraw" ? "withdraw" : "supply";
  let view = null;
  let chosen = preset.venue && preset.product ? `${preset.venue}|${preset.product}` : "";
  const body = openSheet('<div class="en" data-earn><div class="skel-rows" aria-hidden="true"><span class="skel"></span><span class="skel"></span><span class="skel" style="width:60%"></span></div></div>', { title: "Earn", redraw: () => refresh() });
  const root = body.querySelector("[data-earn]");
  const live = () => !!root && root.isConnected;
  const draw = () => {
    if (!live() || !view) return;
    const products = enList(view, kind);
    const held = (p) => view.positions.find((h) => h.venue === p.venue && h.product === p.id);
    if (!chosen || !products.some((p) => `${p.venue}|${p.id}` === chosen)) chosen = products.length ? `${products[0].venue}|${products[0].id}` : "";
    // a venue that does not serve this network now is a state, named once in a quiet line (its words folded away); a read that failed says so
    const miss = enMissing(view.missing, inLens);
    const awayIds = new Set(miss.away.map((m) => m.venue));
    // the sheet opened for one venue that does not serve this network now: that, in place of an empty list
    const presetAway = !!preset.venue && (awayIds.has(preset.venue) || enAwayAt(preset.venue));
    const awayName = presetAway ? (miss.away.find((m) => m.venue === preset.venue) || {}).venueName || nameOf(preset.venue) : "";
    const refusing = view.venues.filter((v) => v.can === false && inLens(v.venue) && !awayIds.has(v.venue)).map((v) => `<p class="dim small">${esc(v.venueName)}: ${esc(v.whyNot || "this key can't put money to earn")}</p>`).join("");
    const missing = miss.failed.map((m) => `<p class="dim small">${esc(m.venueName)} could not be read: ${esc(m.why)}</p>`).join("");
    const away = awayLine(miss.away, { fold: true, named: !presetAway });
    const none = presetAway ? `${awayName} doesn't serve the network you're on now. What it holds in earn stays there, and shows here again when it answers.` : kind === "supply" ? "No product takes money from here right now." : "Nothing is earning to take out.";
    const hand = typeof openHandToAgent === "function" && A.keys.some((k) => k.status === "ok") ? '<button type="button" class="btn btn-sm" data-en-hand>Hand to agent</button>' : "";
    root.innerHTML = `<div class="en-top"><div data-kind></div>${hand}</div>${products.length ? `<div class="en-where" role="group" aria-label="Product">${products.slice(0, 12).map((p) => enRow(p, { chosen, kind, held: held(p) })).join("")}</div>` : `<p class="empty">${esc(none)}</p>`}<form class="en-form" novalidate autocomplete="off"${products.length ? "" : " hidden"}><div class="row2"><label class="fld"><span data-amt-l>Amount</span><input name="amount" inputmode="decimal" placeholder="25" /></label><div class="en-max"><span class="en-max-l">${kind === "withdraw" ? '<button type="button" class="link" data-all>All of it</button> · ' : ""}<button type="button" class="link" data-max>Max</button></span><span class="dim small" data-have></span></div></div><div class="quote real" data-q><span class="dim">Type an amount.</span></div><div data-sign></div><div class="msg" data-msg role="status"></div><button type="submit" class="btn btn-primary btn-block" data-go disabled>${kind === "supply" ? "Sign and put in" : "Sign and take out"}</button></form>${refusing}${away}${missing}`;
    root.querySelector("[data-kind]").innerHTML = seg([["supply", "Put in"], ["withdraw", "Take out"]], kind, (v) => {
      kind = v;
      draw();
    }, { label: "Put in or take out" });
    const handBtn = root.querySelector("[data-en-hand]");
    if (handBtn) handBtn.addEventListener("click", () => openHandToAgent({ kind: "earn", venue: preset.venue || (chosen ? chosen.split("|")[0] : "") }));
    const form = root.querySelector("form");
    const product = () => products.find((p) => `${p.venue}|${p.id}` === chosen);
    for (const b of root.querySelectorAll("button[data-prod]")) b.addEventListener("click", () => {
      // an amount typed for one asset is not carried to a product in another: the field starts again
      const was = product();
      chosen = b.dataset.prod;
      const now = product();
      if (form && was && now && String(was.asset || "").toUpperCase() !== String(now.asset || "").toUpperCase()) form.elements.amount.value = "";
      for (const x of root.querySelectorAll("button[data-prod]")) x.setAttribute("aria-pressed", String(x === b));
      later(0);
    });
    if (!products.length) return;
    const have = () => {
      const p = product();
      if (!p) return 0;
      if (kind === "withdraw") return held(p) ? held(p).amount : 0;
      return enReady(p);
    };
    const q = (s) => form.querySelector(s);
    const box = q("[data-q]");
    const sign = q("[data-sign]");
    const btn = q("[data-go]");
    const msg = q("[data-msg]");
    let prepared = null;
    let seq = 0;
    let stopLeft = () => {};
    // the signature's minutes, on the page's one clock (core everySecond): false stops it; a change is written in the clock's frame
    const left = () => {
      const el = box.querySelector("[data-left]");
      if (!live() || !prepared || !el) return false;
      const ms = prepared.action.deadline - Date.now();
      if (ms <= 0) return void requote();
      const t = `Your signature is good for ${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")} more.`;
      if (el.textContent !== t) return () => setText(el, t);
    };
    const requote = async () => {
      if (!live() || !form.isConnected) return;
      const my = ++seq;
      prepared = null;
      btn.disabled = true;
      sign.innerHTML = "";
      stopLeft();
      const p = product();
      if (!p) return;
      q("[data-amt-l]").textContent = `Amount (${p.asset})`;
      q("[data-have]").textContent = `${qtyOf(have())} ${p.asset} ${kind === "withdraw" ? "in it" : "at " + p.venueName}`;
      const amount = String(form.elements.amount.value || "").trim();
      // "all" takes everything out of a product: the door takes the word itself, for a withdrawal only
      const all = kind === "withdraw" && amount.toLowerCase() === "all";
      if (!all && !(Number(amount) > 0)) return void (box.innerHTML = `<div class="big"><span>${esc(p.name)}</span><span>${esc(enRate(p))}</span></div><div class="path">${esc(`Money taken out lands in ${p.lands}.`)}${p.minAmount ? ` · at least ${esc(qtyOf(p.minAmount))} ${esc(p.asset)}` : ""}</div><div class="path">${kind === "withdraw" ? "Type an amount, or take all of it." : "Type an amount."}</div>`);
      box.innerHTML = `<span class="dim">Asking ${esc(p.venueName)}…</span>`;
      const r = await Owner.prepare(enDraft(p, kind, all ? "all" : amount));
      if (!live() || my !== seq) return;
      if (r.status !== 200) return void (box.innerHTML = `<div class="msg no">${esc(Owner.why(r) || "Refused")}</div>`);
      prepared = r.body;
      const x = prepared.quote.earn;
      box.innerHTML = `<div class="big"><span>${esc(x.words)}</span><span>≈ ${money(x.usd)}</span></div><div class="path">${esc([enRate(x), x.lockDays ? `locked ${x.lockDays} days after you ask for it back` : x.lockDays === 0 ? "out at once" : "", x.protocol, x.chain].filter(Boolean).join(" · "))}</div><div class="path"><b>Taken out, it lands in</b> ${esc(x.lands)}</div>${x.held ? `<div class="path">In it now: ${esc(qtyOf(x.held.amount))} ${esc(x.held.asset)}${x.held.usd !== undefined ? ` (${money(x.held.usd)})` : ""}</div>` : ""}${x.note ? `<div class="path">${esc(x.note)}</div>` : ""}<div class="left-t" data-left></div>`;
      sign.innerHTML = whatYouSign(prepared);
      btn.disabled = !owns();
      const now = left();
      if (typeof now === "function") now();
      stopLeft = everySecond(left);
    };
    const later = debounce(requote);
    form.addEventListener("input", () => later());
    q("[data-max]").addEventListener("click", () => {
      form.elements.amount.value = String(have() || "");
      later(0);
    });
    const allBtn = q("[data-all]");
    if (allBtn) allBtn.addEventListener("click", () => {
      form.elements.amount.value = "all";
      later(0);
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!prepared || busy || !owns()) return;
      btn.disabled = true;
      msg.className = "msg wait";
      msg.textContent = "Sending it…";
      busy = true;
      document.body.classList.add("busy");
      let r;
      try {
        r = await Owner.submit(prepared);
      } finally {
        busy = false;
        document.body.classList.remove("busy");
      }
      if (!live()) return void load();
      if (refusedAt(r)) {
        msg.className = "msg no";
        msg.textContent = Owner.why(r) || "Refused";
        return void requote();
      }
      const earn = r.body.result && r.body.result.earn;
      said = earn ? `${earn.kind === "withdraw" ? "Taking out" : "Putting in"} ${earn.all ? "all" : qtyOf(earn.amount)} ${earn.asset} · ${earn.productName}: ${earn.status === "done" ? "done" : earn.status}${earn.note ? ` · ${earn.note}` : ""}` : saidOf(r.body);
      msg.className = "msg ok";
      msg.textContent = said;
      form.elements.amount.value = "";
      // what is held and what earns are read again, not kept; the sheet is drawn again in place from the fresh read
      forget("/api/account/earn");
      forget("/api/account/holdings");
      await load();
      if (live()) await refresh();
    });
    later(0);
  };
  /* the products and what is in them, read again (each load while the sheet is open, and after a signature) */
  const refresh = async () => {
    if (!live()) return;
    const b = await api(`/api/account/earn${preset.venue ? `?${new URLSearchParams({ venue: preset.venue })}` : ""}`);
    if (!live()) return;
    // the one venue asked about refused this network: the state the sheet says, not an error
    const geo = !!b && b.ok === false && !!b.refusal && b.refusal.code === "E_VENUE_GEOBLOCKED";
    if (preset.venue && b && b.ok === false && (geo || enAwayAt(preset.venue))) {
      view = { products: [], positions: [], venues: [], missing: [{ venue: preset.venue, venueName: nameOf(preset.venue), why: refusalOf(b), code: "E_VENUE_GEOBLOCKED" }] };
      return void draw();
    }
    if (!b || b.ok === false) return void (root.innerHTML = `<div class="msg no">${esc(refusalOf(b) || "Earn could not be read.")}</div>`);
    // nothing is offered at a venue that does not serve this network now (marked on the account, or refused in this read)
    const away = new Set((b.missing || []).filter(awayMiss).map((m) => m.venue));
    const here = (id) => inLens(id) && !away.has(id) && !enAwayAt(id);
    view = { products: (b.products || []).filter((p) => here(p.venue)), positions: (b.positions || []).filter((h) => here(h.venue)), venues: b.venues || [], missing: b.missing || [] };
    draw();
  };
  refresh();
}

// ---- Sell many --------------------------------------------------------------------------------

const SM_MAX_LEGS = 10;
/** one leg of Sell many as the owner signs it: a market sell of what is held there, or — a perpetual, a future — the position's close */
function smDraft(item, qty) {
  const n = String(qty ?? "").trim();
  if (item.action === "close") return { type: "liveClose", venue: item.venue, symbol: item.symbol, qty: n && Number(n) < item.held ? n : "" };
  return { type: "liveOrder", venue: item.venue, symbol: item.symbol, side: "sell", orderType: "market", qty: n || String(item.sellQty), limitPrice: "", stopPrice: "", tif: "", postOnly: "", reduceOnly: "" };
}
/* a holding to sell, by name: a position says it is closed */
const smLegName = (x) => (x.action === "close" ? `Close ${x.side || ""} ${x.asset}`.replace(/\s+/g, " ") : x.asset);
/* one prepared leg, in words */
function smLegWords(l) {
  const p = l.prepared;
  if (p.action.type === "liveClose") return `<div class="big"><span>Close ${esc(p.action.qty || `all ${qtyOf(l.item.held)}`)} · ${esc(l.item.asset)}</span><span>${l.item.usd !== undefined ? `≈ ${money(l.item.usd)}` : ""}</span></div><div class="path">${esc(l.item.venueName)} · at market, it only shrinks the position</div>`;
  const q = p.quote.order;
  return `<div class="big"><span>${esc(q.words)}</span><span>≈ ${money(q.notionalUsd)}</span></div><div class="path">${esc(l.item.venueName)} · at market${q.note ? ` · ${esc(q.note)}` : ""}</div>`;
}
/** what the account says can be sold (GET /api/account/sellable), narrowed to the venues let through: the rows an order could go for now,
 * how many others were left out, and the venues that could not be read */
function smSellable(body, inVenue) {
  const mine = (body.items || []).filter((x) => inVenue(x.venue));
  return { items: mine.filter((x) => x.ready), hidden: mine.filter((x) => !x.ready).length, missing: (body.missing || []).filter((m) => !m.venue || inVenue(m.venue)) };
}

/** Sell many, in the sheet: everything held that is not a dollar, at each venue; pick up to ten, review what each would sign, then one
 * signature each, in turn, each leg's result as it comes back. Nothing redraws the sheet mid-run: a result stays where it landed */
function openSellMany(preset = {}) {
  if (!A) return;
  const venueIn = pfVenueIn(lensNow());
  const inVenue = (id) => (preset.venue ? id === preset.venue : venueIn(id));
  const body = openSheet(`<div class="sm" data-sm><p class="dim small">Everything you hold that isn't a dollar${preset.venue ? ` at ${esc(nameOf(preset.venue))}` : ""}. Pick up to ${SM_MAX_LEGS}: each is its own order at market and its own signature.</p><div class="sm-body" data-sm-body><div class="skel-rows" aria-hidden="true"><span class="skel"></span><span class="skel"></span><span class="skel" style="width:60%"></span></div></div></div>`, { title: "Sell many" });
  const root = body.querySelector("[data-sm]");
  const box = root.querySelector("[data-sm-body]");
  const live = () => !!root && root.isConnected;
  let items = [];
  let hidden = 0;
  const pickList = () => {
    const owner = owns();
    box.innerHTML = `<form class="sm-form" novalidate><ul class="sm-list" role="list">${items.map((x, i) => `<li class="sm-row"><label class="chk1"><input type="checkbox" name="pick" value="${i}" /><span class="sr">Sell ${esc(x.asset)} at ${esc(x.venueName)}</span></label><span class="sm-rn"><b>${esc(smLegName(x))}</b><span class="dim small">${esc(`${x.venueName} · ${qtyOf(x.held)} held${x.usd !== undefined ? ` · ≈ ${money(x.usd)}` : ""}`)}</span></span><input class="sm-q" name="q${i}" inputmode="decimal" value="${esc(String(x.sellQty))}" aria-label="How much ${esc(x.asset)} to sell" /></li>`).join("")}</ul>${hidden ? `<p class="dim small">${esc(plural(hidden, "holding"))} can't be sold from here right now and ${hidden === 1 ? "is" : "are"} left out.</p>` : ""}<div class="msg" data-msg role="status"></div><button type="submit" class="btn btn-primary btn-block" data-review disabled>Review</button></form>`;
    const form = box.querySelector("form");
    const btn = box.querySelector("[data-review]");
    const count = () => {
      const n = form.querySelectorAll('input[name="pick"]:checked').length;
      btn.disabled = !n || n > SM_MAX_LEGS;
      btn.textContent = n > SM_MAX_LEGS ? `At most ${SM_MAX_LEGS} at once` : n ? `Review ${plural(n, "sale")}` : "Review";
    };
    form.addEventListener("change", count);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const f = new FormData(form);
      const legs = f.getAll("pick").map(Number).slice(0, SM_MAX_LEGS).map((i) => ({ item: items[i], draft: smDraft(items[i], f.get(`q${i}`)) }));
      if (legs.length) review(legs);
    });
    if (!owner) btn.title = "This browser only looks: pair it to sign";
  };
  /* each leg prepared by the account: what it would sign, or why it would not go */
  const review = async (legs) => {
    box.innerHTML = '<p class="dim small">Asking each venue…</p>';
    for (const l of legs) {
      const r = await Owner.prepare(l.draft);
      l.prepared = r.status === 200 ? r.body : null;
      l.why = r.status === 200 ? "" : Owner.why(r) || "Refused";
      if (!live()) return;
    }
    const ok = legs.filter((l) => l.prepared);
    box.innerHTML = `<ol class="sm-legs">${legs.map((l) => `<li>${l.prepared ? `<div class="quote real">${smLegWords(l)}</div>${whatYouSign(l.prepared)}` : `<div><b>${esc(smLegName(l.item))}</b> · ${esc(l.item.venueName)}</div><div class="msg no">${esc(l.why)}</div>`}</li>`).join("")}</ol><div class="msg" data-msg role="status"></div><div class="end"><button type="button" class="btn" data-back>Back</button><button type="button" class="btn btn-primary" data-sign${ok.length && owns() ? "" : " disabled"}>Sign and sell ${ok.length}</button></div>`;
    box.querySelector("[data-back]").addEventListener("click", pickList);
    box.querySelector("[data-sign]").addEventListener("click", () => run(ok));
  };
  /* one signature each, in turn: a leg whose signature has under fifteen seconds left is prepared again first; a DEX sale goes to the wallet */
  const run = async (legs) => {
    if (busy) return;
    busy = true;
    document.body.classList.add("busy");
    box.innerHTML = `<ol class="sm-legs" data-res>${legs.map((l, i) => `<li data-leg="${i}"><div><b>${esc(smLegName(l.item))}</b> · ${esc(l.item.venueName)}</div><span class="dim small">waiting</span></li>`).join("")}</ol><div class="end"><button type="button" class="btn" data-done disabled>Done</button></div>`;
    const mark = (i, html) => {
      const li = box.querySelector(`[data-leg="${i}"]`);
      if (li) li.innerHTML = `<div><b>${esc(smLegName(legs[i].item))}</b> · ${esc(legs[i].item.venueName)}</div>${html}`;
    };
    let done = 0;
    try {
      for (let i = 0; i < legs.length; i++) {
        const l = legs[i];
        mark(i, '<span class="dim small">signing…</span>');
        let p = l.prepared;
        if (p.action.deadline && p.action.deadline - Date.now() < 15_000) {
          const again = await Owner.prepare(l.draft);
          if (again.status !== 200) {
            mark(i, `<div class="msg no">${esc(Owner.why(again) || "Refused")}</div>`);
            continue;
          }
          p = again.body;
        }
        const r = await Owner.submit(p);
        if (refusedAt(r)) {
          mark(i, `<div class="msg no">${esc(Owner.why(r) || "Refused")}</div>`);
          continue;
        }
        const o = r.body.kind === "order" ? r.body.order : null;
        if (o && o.walletTxs && !o.ref) {
          if (typeof sendOrderFromWallet !== "function") {
            mark(i, '<div class="msg no">Your wallet has to send it: it waits under Trade › Under way, “Send from wallet…”.</div>');
            continue;
          }
          mark(i, '<span class="dim small">waiting for your wallet…</span>');
          try {
            await sendOrderFromWallet(o);
          } catch (err) {
            mark(i, `<div class="msg no">${esc(String((err && err.message) || err).slice(0, 200))}. It waits under Under way.</div>`);
            continue;
          }
        }
        done++;
        mark(i, `<div class="msg ok">${esc(saidOf(r.body) || "Done")}</div>`);
      }
    } finally {
      busy = false;
      document.body.classList.remove("busy");
    }
    said = `Sell many: ${done} of ${plural(legs.length, "sale")} went through`;
    forget("/api/account/positions");
    const d = box.querySelector("[data-done]");
    if (d) {
      d.disabled = false;
      d.addEventListener("click", () => openSellMany(preset));
    }
    await load();
  };
  api("/api/account/sellable").then((b) => {
    if (!live()) return;
    if (!b || b.ok === false) return void (box.innerHTML = `<div class="msg no">${esc(refusalOf(b) || "What is held could not be read.")}</div>`);
    const s = smSellable(b, inVenue);
    items = s.items;
    hidden = s.hidden;
    // a venue that does not serve this network now is named once, quietly; a read that failed says so in its words
    const missing = `${awayLine(s.missing.filter(awayMiss))}${s.missing.filter((m) => !awayMiss(m)).map((m) => `<p class="dim small">${esc(m.venueName)} could not be read: ${esc(m.why)}</p>`).join("")}`;
    if (!items.length) return void (box.innerHTML = `<p class="empty">${hidden ? `Nothing here can be sold right now: ${plural(hidden, "holding")} ${hidden === 1 ? "is" : "are"} left out.` : "Nothing to sell: everything here is in dollars."}</p>${missing}`);
    pickList();
    if (missing) box.insertAdjacentHTML("beforeend", missing);
  });
}
