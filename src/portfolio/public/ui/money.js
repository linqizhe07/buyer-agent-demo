/* Money: receiving money at an account, moving real money between the owner's accounts, a wallet sending it, and the agents' own wallets.
   (The dollars that are ready are the Portfolio's Cash ready.) */

// ---- real money -------------------------------------------------------------------------

/* the chain an agent wallet's money and gas sit on: the first chain (of those money moves on) with a dollar on it, else with anything on
   it; "" when it holds nothing yet. A move to it starts on that chain */
function fundedChainOf(venueId) {
  const v = A.venues.find((x) => x.id === venueId);
  const nets = networksOf();
  const rows = ((v && v.holdings) || []).filter((h) => h.amount > 0 && nets.includes(String(h.note || "")));
  const dollars = rows.filter((h) => isDollar(h.asset));
  return ((dollars[0] || rows[0]) || {}).note || "";
}

/** the account built the transaction; the wallet shows it to you and sends it; the page tells the account which transaction it was */
async function sendFromWallet(p, tx, txs) {
  const key = `${p.id}@${p.at}`;
  if (INFLIGHT.has(key)) throw new Error(`${p.id} is already waiting for your wallet: finish it there`);
  INFLIGHT.add(key);
  try {
    await sendPaymentOnce(p, key, tx, txs);
  } finally {
    INFLIGHT.delete(key);
  }
}
async function sendPaymentOnce(p, key, tx, txs) {
  const paymentId = p.id;
  // asked again first: the account may already have a hash for it (another tab, a reload), and then that one is reported, nothing is sent
  const now = ((await (await fetch("/api/account")).json()).payments || []).find((x) => x.id === p.id && x.at === p.at);
  if (!now || !(now.status === "authorized" || (now.status === "failed" && now.live && now.live.expired))) throw new Error(`${p.id} is no longer waiting for your wallet (${now ? now.status : "gone"}): nothing was sent`);
  if (now.live && now.live.reported) SENT.set(key, now.live.reported);
  const all = txs && txs.length ? txs : [tx];
  const w = await walletFor(all[0].from);
  const send = async (t) => {
    try {
      await w.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: t.chainIdHex }] });
    } catch (err) {
      throw new Error(`${w.info.name} did not switch to the right network: ${(err && err.message) || err}`);
    }
    return w.provider.request({ method: "eth_sendTransaction", params: [{ from: t.from, to: t.to, data: t.data, value: t.value, ...(t.gas ? { gas: t.gas } : {}) }] });
  };
  // a bridge's approval first, on chain before the transfer; a transfer the wallet already sent is reported again, never sent twice
  let hash = SENT.get(key);
  if (!hash) {
    for (const t of all.slice(0, -1)) await mined(w, await send(t));
    hash = await send(all[all.length - 1]);
    SENT.set(key, hash);
  }
  const r = await postJson("/api/account/live/sent", { payment: paymentId, hash });
  if (r.status !== 200) throw new Error(`${Owner.why(r) || "the account could not take the transaction"}. Your wallet sent ${short(hash)}: “Report again” reports that same transaction, it does not send another`);
  SENT.delete(key);
  said = `${w.info.name} sent it: ${short(hash)}`;
}

/** move real money at an account: what is possible there, the address and fee the account finds, then your signature — in the one sheet,
 * the quote asked again as the form changes (core.js quoteDialog). `preset` { kind, to, amount }: opened to fill an agent wallet, that
 * wallet is where it goes, and the sum it asked for */
function openLiveMove(venueId, preset = {}) {
  const v = A.venues.find((x) => x.id === venueId);
  if (!v || !v.liveCan) return;
  if (!servedHere(v)) return void toast(`${v.name} does not serve this network now: nothing is moved from it until a check of this network finds it answering.`);
  const c = v.liveCan;
  const ledgers = c.ledgers || [];
  const kinds = [...(c.withdraw !== false && !c.send ? [["withdraw", "Withdraw to another account of yours"]] : []), ...(c.send ? [["send", "Send from this wallet"]] : []), ...(c.send === "wallet" && v.proven ? [["bridge", "Across chains"]] : []), ...(ledgers.length > 1 && c.transfer !== false ? [["transfer", "Between its own ledgers"]] : []), ...(c.swap !== false && !c.send ? [["swap", "Swap stablecoins"]] : [])];
  if (!kinds.length) return void toast(`${v.name} moves nothing from here: ${v.readOnlyBecause || (v.liveCan && v.liveCan.why && v.liveCan.why.withdraw) || "its key may not withdraw, transfer or swap"}.`, "no");
  // where it can go: the accounts that receive and serve the network the account runs on now; one that does not is named once, under the
  // form, and offered when a check of this network finds it answering
  const dests = A.venues.filter((x) => x.id !== v.id && x.watchOnly && x.liveCan && x.liveCan.receive && !x.readOnlyBecause && servedHere(x));
  const notHere = A.venues.filter((x) => x.id !== v.id && x.watchOnly && x.liveCan && x.liveCan.receive && !x.readOnlyBecause && !servedHere(x));
  // what can leave: the dollars this venue holds (of the stablecoins the account knows); what it can become: any of them
  const heldDollars = [...new Set((v.holdings || []).filter((h) => h.amount > 0 && isDollar(h.asset)).map((h) => String(h.asset).toUpperCase()))];
  const assets = (heldDollars.length ? heldDollars : dollarsOf().filter((a) => a !== "USD").slice(0, 2)).map((a) => [a, a]);
  const toAssets = dollarsOf().filter((a) => a !== "USD").map((a) => [a, a]);
  const amount = (ph) => field("Amount", `<input name="amount" inputmode="decimal" placeholder="${ph}" autocomplete="off" />`);
  const nets = (name, sel, list = networksOf()) => select(name, list.map((x) => [x, x]), sel);
  const chains = bridgeChainsOf();
  /* the fields each kind of move needs */
  const bodyOf = (k) => (k === "transfer"
    ? `<div class="row2">${field("From", select("fromLedger", ledgers.map((l) => [l, l])))}${field("To", select("toLedger", ledgers.map((l) => [l, l]), ledgers[1]))}</div><div class="row2">${field("Currency", select("asset", assets))}${amount("50")}</div>`
    : k === "swap"
      ? `<div class="row2">${field("Sell", select("asset", assets, assets[0][0]))}${field("Buy", select("toAsset", toAssets, toAssets.find(([a]) => a !== assets[0][0])[0]))}</div>${amount("50")}`
      : k === "bridge"
        ? `${field("To", select("to", [[v.id, "This wallet, on the other chain"], ...dests.filter((d) => !d.address || d.proven).map((d) => [d.id, d.name])]))}<div class="row2">${field("From chain", nets("network", chains[0], chains))}${field("To chain", nets("toLedger", chains[1] || chains[0], chains))}</div><div class="row2">${field("Send", select("asset", assets))}${field("Arrives as", select("toAsset", toAssets, assets[0][0]))}</div>${amount("25")}`
        : `${dests.length ? field("To", select("to", dests.map((d) => [d.id, `${d.name}${d.address ? (d.proven ? "" : " · watched") : ""}`, !!d.address && !d.proven]))) : notHere.length ? "" : '<div class="path dim">Connect where it should go first: another exchange, or your wallet from the wallet itself.</div>'}${notHere.length ? `<div class="path dim small">Not served on this network now: ${notHere.map((d) => esc(d.name)).join(", ")}.</div>` : ""}<div class="row2">${field("Network", nets("network"))}${field("Currency", select("asset", assets))}</div>${amount("25")}${k === "withdraw" ? '<div class="path"><button type="button" class="link dim" data-fees>Fees on every network</button><span class="dim small" data-fees-list></span></div>' : ""}`);
  const draftOf = (form) => {
    const f = formFields(form);
    const k = f.kind;
    return { type: "liveMove", kind: k, from: v.id, to: k === "transfer" || k === "swap" ? v.id : f.to || "", fromLedger: f.fromLedger || "", toLedger: f.toLedger || "", asset: f.asset || "USDC", toAsset: k === "swap" || k === "bridge" ? f.toAsset || f.asset : f.asset || "USDC", network: k === "transfer" || k === "swap" ? "" : f.network || "", amount: String(f.amount || "").trim() };
  };
  const eta = (sec) => (sec < 90 ? `~${Math.max(1, Math.round(sec))} s` : sec < 5400 ? `~${Math.round(sec / 60)} min` : `~${Math.round(sec / 3600)} h`);
  const q = quoteDialog({
    title: `Move money · ${v.name}`,
    sub: `Only to your own accounts. Up to ${esc(money(A.connectLive.writes.capUsd))} a move.`,
    fields: `${field("What", select("kind", kinds, kinds.some(([k]) => k === preset.kind) ? preset.kind : kinds[0][0]))}<div class="mv-body" data-move-body></div>`,
    draft(form) {
      const d = draftOf(form);
      if (!(Number(d.amount) > 0)) return "Fill it in to see where it goes and what it costs.";
      if (d.kind !== "transfer" && d.kind !== "swap" && !d.to) return "Connect where it should go first.";
      return d;
    },
    show(p, form) {
      const a = p.action;
      const to = A.venues.find((x) => x.id === a.to) || {};
      if (a.kind === "bridge") {
        // the route the account signs for (the cheapest), and the others, from the same answer the bridge will be held to
        const d = draftOf(form);
        postJson("/api/account/bridge-routes", { draft: d }).then((rr) => {
          const el = form.querySelector("[data-routes]");
          if (!el || q.prepared !== p) return;
          const routes = rr.status === 200 && Array.isArray(rr.body.routes) ? rr.body.routes : [];
          const best = routes[0];
          el.innerHTML = rr.status !== 200 ? esc(Owner.why(rr) || "No route answered.") : `${best ? `<b>Via ${esc(best.tool)}</b> · at least ${money(best.receiveUsd)} ${esc(a.toAsset)} arrives · ${esc(eta(best.etaSec))}${best.gasUsd ? ` · network fee about ${fine(best.gasUsd)} in your wallet` : ""}` : "No route answered."}${routes.length > 1 ? `<br />Other routes: ${routes.slice(1).map((x) => `${esc(x.tool)} fee ${fine(x.feeUsd)}, ${esc(eta(x.etaSec))}`).join(" · ")}` : ""}`;
        }).catch((err) => {
          // the routes are a word of advice beside the quote the account signs for: a failure here is said, and stops nothing
          const el = form.querySelector("[data-routes]");
          if (el && q.prepared === p) el.textContent = `The routes could not be read: ${String((err && err.message) || err).slice(0, 120)}`;
        });
        return `<div class="big"><span>${esc(a.amount)} ${esc(a.asset)} · ${esc(a.network)} → ${esc(a.toLedger)}</span><span>fee up to ${esc(a.maxFee)}</span></div><div class="path" data-routes>Finding the routes…</div><div class="path"><b>To</b> ${esc(a.to === v.id ? "this wallet" : to.name || a.to)} · <span class="mono">${esc(a.toAddress)}</span> on ${esc(a.toLedger)}</div><div class="path">Your wallet sends it; it lands on ${esc(a.toLedger)} when the bridge delivers. Can't be undone.</div>`;
      }
      return `<div class="big"><span>${esc(a.amount)} ${esc(a.asset)}${a.kind === "swap" ? ` → ${esc(a.toAsset)}` : ""}</span><span>${a.kind === "send" ? "network fee in your wallet" : `fee up to ${esc(a.maxFee)} ${esc(a.asset)}`}</span></div>${a.toAddress ? `<div class="path"><b>To</b> ${esc(to.name || a.to)} · <span class="mono">${esc(a.toAddress)}</span> on ${esc(a.network)}</div><div class="path">${to.address ? (/holds its key/.test(to.proven || "") ? "The agent wallet's own address: this account holds its key." : "The address your wallet signed for.") : `${esc(to.name || a.to)}'s deposit address, checked again before sending.`}</div>` : `<div class="path">${a.kind === "transfer" ? `${esc(a.fromLedger)} → ${esc(a.toLedger)} at ${esc(v.name)}` : `a market order at ${esc(v.name)}`}</div>`}<div class="path">Can't be undone.</div>`;
    },
    // a move out of a wallet is sent by the wallet itself: the account built it, the wallet shows it and sends it
    async done(r) {
      const out = r.body.kind === "result" ? r.body.result : null;
      if (!(out && out.wallet)) return r.body.payment ? r.body.payment.note || "Sent" : "";
      const m = q.form.querySelector("[data-msg]");
      if (m) [m.className, m.textContent] = ["msg wait", "Waiting for your wallet…"];
      try {
        await sendFromWallet(out.payment, out.wallet, out.walletTxs);
      } catch (err) {
        throw new Error(`${String((err && err.message) || err).slice(0, 200)}. It waits in the Statement, under way: “Send from wallet…”`);
      }
      return said;
    },
  });
  const form = q.form;
  const box = form.querySelector("[data-move-body]");
  /* a withdrawal's fee on every network the destination takes, side by side: one click picks the network */
  const feesEverywhere = async () => {
    const list = box.querySelector("[data-fees-list]");
    const d = draftOf(form);
    if (!(Number(d.amount) > 0)) return void (list.textContent = " · type an amount first");
    list.textContent = " · asking…";
    const rows = await Promise.all(networksOf().map(async (n) => {
      const r = await Owner.prepare({ ...d, network: n });
      return r.status === 200 ? { n, fee: Number(r.body.action.maxFee) } : { n, why: Owner.why(r) };
    }));
    if (!list.isConnected) return;
    const okRows = rows.filter((x) => x.fee !== undefined).sort((a, b) => a.fee - b.fee);
    list.innerHTML = ` · ${okRows.map((x) => `<button type="button" class="link" data-net="${esc(x.n)}">${esc(x.n)} ${esc(x.fee.toFixed(2))} ${esc(d.asset)}</button>`).join(" · ") || "no network takes it"}${rows.length > okRows.length ? ` · not on ${esc(rows.filter((x) => x.fee === undefined).map((x) => x.n).join(", "))}` : ""}`;
  };
  /* money to an agent wallet starts on the chain that wallet already holds money or gas on (its first, when it holds nothing yet) */
  const followTo = () => {
    if (!form.elements.to || !form.elements.network) return;
    const n = fundedChainOf(form.elements.to.value);
    if (n && [...form.elements.network.options].some((o) => o.value === n)) form.elements.network.value = n;
  };
  const draw = () => {
    box.innerHTML = bodyOf(form.elements.kind.value);
    followTo();
  };
  form.elements.kind.addEventListener("change", draw);
  box.addEventListener("change", (e) => {
    if (e.target && e.target.name === "to") followTo();
  });
  box.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("button");
    if (!b) return;
    if (b.hasAttribute("data-fees")) feesEverywhere();
    else if (b.dataset.net) {
      form.elements.network.value = b.dataset.net;
      q.requote();
    }
  });
  draw();
  if (preset.to && form.elements.to && [...form.elements.to.options].some((o) => o.value === preset.to)) {
    form.elements.to.value = preset.to;
    followTo();
  }
  if (preset.amount && form.elements.amount && Number(preset.amount) > 0) form.elements.amount.value = String(preset.amount);
  q.requote();
}

/** an agent wallet filled from one of the owner's accounts that can send money: the only one, or the one picked */
async function topUpFrom(walletVenue, amount = "") {
  const sources = connected().filter((v) => canMove(v) && !v.id.startsWith("agent-"));
  if (!sources.length) return void toast("None of your accounts can send money from here: connect one whose key may withdraw, or a wallet you prove is yours.", "no");
  const from = sources.length === 1 ? sources[0].id : await pickSheet("Top up from", sources.map((x) => [x.id, x.name, money(x.usd)]), { note: `Into ${nameOf(walletVenue)}. You sign the move on the next step.` });
  if (from && sources.some((x) => x.id === from)) openLiveMove(from, { to: walletVenue, amount });
}

// ---- receiving --------------------------------------------------------------------------

/* the networks an address can be asked for: the chains money moves on and the chains a bridge joins, as the account publishes them (the
   page's own six and Robinhood Chain on an account that does not publish them yet) */
const receiveNetworks = () => (A && Array.isArray(A.networks) && A.networks.length ? [...new Set([...networksOf(), ...bridgeChainsOf()])] : [...NETWORKS_KNOWN, "Robinhood Chain"]);
/* an account gives an address to send to: a wallet proven yours (or one whose key the account holds), or a venue whose key or sign-in
   gives deposit addresses. A watched address gives none, and neither does a venue the account only reads */
const canReceive = (v) => servedHere(v) && (v.address ? !!v.proven : !!v.liveCan && v.liveCan.receive !== false && !v.readOnlyBecause);
/* what one might send there: the dollars first, then what the account already holds there */
const receiveAssets = (v) => [...new Set(["USDC", "USDT", "ETH", ...(v.holdings || []).filter((h) => h.class !== "cash").map((h) => String(h.asset).toUpperCase())])].filter((a) => /^[A-Z0-9.]{1,15}$/.test(a));
/* the asset an exchange row starts on: the dollar the venue holds most of (what one would send there), else the first it could receive */
const rcvDefaultAsset = (v) => {
  const list = receiveAssets(v);
  const held = (v.holdings || []).filter((h) => h.amount > 0 && h.class !== "cash" && isDollar(h.asset)).sort((a, b) => (b.usd || 0) - (a.usd || 0))[0];
  const a = held ? String(held.asset).toUpperCase() : "";
  return a && list.includes(a) ? a : list[0];
};
/* the EVM networks a wallet's one address is reached on: the five said first, then the others the account publishes */
const RCV_EVM = ["Base", "Arbitrum", "Optimism", "Polygon", "Ethereum"];
const rcvEvmNetworks = () => { const all = receiveNetworks(); return [...RCV_EVM.filter((n) => all.includes(n)), ...all.filter((n) => !RCV_EVM.includes(n))]; };
/* a Polymarket wallet lives on Polygon and takes pUSD alone (service.receive says so for every other chain) */
const rcvPolymarket = (v) => String(v.connector || "") === "live:polymarket" || /^polymarket(-[0-9a-f]+)?$/.test(String(v.id || ""));

/** the rows of the Receive list, one account × one network each: a wallet — an agent's, or one proven yours — has ONE row for every EVM
 * network, since its address is the same on each (a Polymarket wallet one row, Polygon · pUSD); an exchange a row a network, each with its
 * own asset chip, since exchanges give an address per asset */
function receiveRows(venues) {
  const rows = [];
  for (const v of venues) {
    if (v.address) {
      if (rcvPolymarket(v)) rows.push({ id: `${v.id}|Polygon`, venue: v, network: "Polygon", networks: ["Polygon"], asset: "PUSD", chip: false, kind: "wallet" });
      else {
        const nets = rcvEvmNetworks();
        rows.push({ id: `${v.id}|evm`, venue: v, network: nets.includes("Base") ? "Base" : nets[0] || "Base", networks: nets, asset: "USDC", chip: false, kind: "wallet" });
      }
      continue;
    }
    for (const n of receiveNetworks()) rows.push({ id: `${v.id}|${n}`, venue: v, network: n, networks: [n], asset: rcvDefaultAsset(v), assets: receiveAssets(v), chip: true, kind: "exchange" });
  }
  return rows;
}
/* the words a row's network line says: one network, or every EVM network with the same address */
const rcvNetworkWords = (row) => (row.networks.length > 1 ? `All EVM networks: ${row.networks.join(", ")}` : row.network);
/* one row, before its address is read: avatar · account · network · the asset chip (exchanges) · the address (read lazily) · Copy · the venue's note */
function rcvRowHtml(row) {
  const v = row.venue;
  const text = [v.name, ...row.networks, row.asset, ...(row.assets || [])].join(" ").toLowerCase();
  return `<div class="rcv-row" role="listitem" data-rcv-row="${esc(row.id)}" data-text="${esc(text)}"><div class="rcv-head">${avatar(v.name)}<div class="rcv-who"><b>${esc(v.name)}</b><span class="dim">${esc(rcvNetworkWords(row))}</span></div>${row.chip ? `<select name="asset" class="rcv-asset" data-rcv-asset aria-label="What to send to ${esc(v.name)} on ${esc(row.network)}">${(row.assets || [row.asset]).map((a) => `<option value="${esc(a)}"${a === row.asset ? " selected" : ""}>${esc(a)}</option>`).join("")}</select>` : ""}</div><div class="rcv-addr dim small" data-rcv-addr>Asking ${esc(v.name)}…</div><div class="rcv-acts" data-rcv-acts hidden><button type="button" class="btn btn-sm" data-rcv-copy data-fk="rcv-copy:${esc(row.id)}">${icon("copy", "sm")}Copy</button></div><div data-rcv-tag></div><p class="path" data-rcv-note></p></div>`;
}
/* the first word of a venue's sentence, up */
const rcvCap = (s) => { const t = String(s || ""); return t.charAt(0).toUpperCase() + t.slice(1); };

/** Where to send money so that it lands at one of the owner's accounts: a flat list — a search box on top, one warning line, a row for
 * every account × network (the address read lazily as the row comes into view, through GET /api/account/receive; a refusal in the venue's
 * own words inside the row), Copy on each, and at the foot the accounts that give no address, each in its venue's words. `venueId`
 * narrows the list to that account (the Account drawer); the quick action shows every account */
function openReceive(venueId = "") {
  if (!A) return;
  const R = connected().filter(canReceive);
  // the accounts that give no address from here, each asked for its own words — save one that does not serve this network now: named once,
  // in a quiet line, with nothing asked of it
  const none = connected().filter((v) => !canReceive(v) && servedHere(v));
  const away = connected().filter((v) => !servedHere(v));
  if (!R.length) return void toast("None of your accounts gives an address to send to from here. Connect a wallet you prove is yours, or an exchange whose key reads deposit addresses.", "no");
  let only = venueId && R.some((v) => v.id === venueId) ? venueId : "";
  const rows = receiveRows(R);
  const body = openSheet(`<div class="rcv" data-rcv><label class="rcv-search"><span class="sr">Search accounts and networks</span>${icon("search", "sm")}<input type="search" data-rcv-q placeholder="Search accounts and networks" autocomplete="off" spellcheck="false" /></label><p class="path warn-t rcv-warn">Send only the asset on the network the row names: anything else may not arrive.</p><p class="dim small rcv-only" data-rcv-only${only ? "" : " hidden"}>Showing ${esc(only ? nameOf(only) : "")} · <button type="button" class="link" data-rcv-all>All accounts</button></p><div class="rcv-list" data-rcv-list role="list">${rows.map(rcvRowHtml).join("")}</div><p class="empty" data-rcv-none hidden>Nothing matches.</p>${none.length ? `<div class="rcv-foot" data-rcv-foot>${none.map((v) => `<div data-rcv-no="${esc(v.id)}" data-text="${esc(v.name.toLowerCase())}"><b>${esc(v.name)}</b> · <span data-rcv-why>asking…</span></div>`).join("")}</div>` : ""}${away.length ? `<p class="dim small rcv-away">Not served on this network now: ${away.map((v) => esc(v.name)).join(", ")}.</p>` : ""}<div class="end"><button type="button" class="btn" data-sheet-close>Done</button></div></div>`, { title: "Receive" });
  const root = body.querySelector("[data-rcv]");
  const list = root.querySelector("[data-rcv-list]");
  const live = () => !!root && root.isConnected;
  // what each row is and has: its element, the latest ask, the answer that came back
  const states = new Map(rows.map((row) => [row.id, { row, el: list.querySelector(`[data-rcv-row="${rcvSel(row.id)}"]`), seq: 0, asked: false, answer: null }]));
  // reads go one at a time per venue: the account queues a venue's reads too, and the browser's connections stay free for the page
  const queues = new Map();
  const queued = (venue, fn) => {
    const next = (queues.get(venue) || Promise.resolve()).then(fn, fn);
    queues.set(venue, next);
    return next;
  };
  const read = async (st) => {
    const my = ++st.seq;
    st.asked = true;
    const { row, el } = st;
    if (!el) return;
    const addr = el.querySelector("[data-rcv-addr]");
    const acts = el.querySelector("[data-rcv-acts]");
    const note = el.querySelector("[data-rcv-note]");
    const tag = el.querySelector("[data-rcv-tag]");
    addr.className = "rcv-addr dim small";
    addr.textContent = `Asking ${row.venue.name}…`;
    acts.hidden = true;
    tag.innerHTML = "";
    note.textContent = "";
    const r = await queued(row.venue.id, () => api(`/api/account/receive?${new URLSearchParams({ venue: row.venue.id, asset: row.asset, network: row.network })}`, { ttl: 60_000 }));
    if (!live() || my !== st.seq || !el.isConnected) return;
    if (!r || r.ok === false) {
      st.answer = null;
      addr.className = "rcv-addr msg no";
      addr.textContent = refusalOf(r) || "No answer.";
      return;
    }
    st.answer = r;
    addr.className = "rcv-addr mono";
    addr.textContent = r.address;
    acts.hidden = false;
    note.textContent = `${rcvCap(r.whose)}${r.note ? ` · ${r.note}` : ""}.`;
    if (r.tag) tag.innerHTML = `<div class="rcv-tag"><span class="label">Memo / tag — needed with it</span><span class="mono" data-rcv-tagv>${esc(r.tag)}</span><button type="button" class="btn btn-sm" data-rcv-copy-tag data-fk="rcv-tag:${esc(row.id)}">Copy</button></div>`;
  };
  /* the accounts that give no address: the venue's own words for it, asked once each */
  for (const v of none) {
    const line = root.querySelector(`[data-rcv-no="${rcvSel(v.id)}"] [data-rcv-why]`);
    if (!line) continue;
    queued(v.id, () => api(`/api/account/receive?${new URLSearchParams({ venue: v.id, asset: "USDC", network: receiveNetworks()[0] || "Base" })}`, { ttl: 60_000 })).then((r) => {
      if (!live() || !line.isConnected) return;
      line.textContent = r && r.ok === false ? refusalOf(r) || "gives no address to send to from here" : r && r.address ? "gives an address after all: open Receive again" : "did not answer";
    });
  }
  /* a row is asked for its address as it comes into view; without an observer (a browser without one) every row shown is asked at once */
  const observe = typeof IntersectionObserver === "function" ? new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const st = states.get(e.target.dataset.rcvRow);
      if (st && !st.asked) read(st);
    }
  }, { rootMargin: "200px" }) : null;
  const shown = () => [...states.values()].filter((st) => st.el && !st.el.hidden);
  const watch = () => {
    if (!observe) return void shown().forEach((st) => !st.asked && read(st));
    for (const st of shown()) if (!st.asked) observe.observe(st.el);
  };
  /* the search and the one-account filter: rows and footer lines hidden, never rebuilt (a hidden row keeps its address) */
  const input = root.querySelector("[data-rcv-q]");
  const filter = () => {
    const q = String(input.value || "").trim().toLowerCase();
    let any = false;
    for (const st of states.values()) {
      if (!st.el) continue;
      st.el.hidden = (!!only && st.row.venue.id !== only) || (!!q && !st.el.dataset.text.includes(q));
      if (!st.el.hidden) any = true;
    }
    for (const d of root.querySelectorAll("[data-rcv-no]")) d.hidden = (!!only && d.dataset.rcvNo !== only) || (!!q && !d.dataset.text.includes(q));
    root.querySelector("[data-rcv-none]").hidden = any;
    root.querySelector("[data-rcv-only]").hidden = !only;
    watch();
  };
  input.addEventListener("input", filter);
  root.querySelector("[data-rcv-all]").addEventListener("click", () => {
    only = "";
    filter();
    input.focus();
  });
  list.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("button");
    const rowEl = b && b.closest("[data-rcv-row]");
    const st = rowEl && states.get(rowEl.dataset.rcvRow);
    if (!st || !st.answer) return;
    if (b.hasAttribute("data-rcv-copy")) copyText(st.answer.address, b);
    else if (b.hasAttribute("data-rcv-copy-tag")) copyText(st.answer.tag, b);
  });
  // an exchange row asked again for another asset: exchanges give an address per asset
  list.addEventListener("change", (e) => {
    const sel = e.target;
    if (!sel || !sel.hasAttribute || !sel.hasAttribute("data-rcv-asset")) return;
    const rowEl = sel.closest("[data-rcv-row]");
    const st = rowEl && states.get(rowEl.dataset.rcvRow);
    if (!st) return;
    st.row.asset = String(sel.value || "").toUpperCase();
    read(st);
  });
  filter();
}
/* an id inside an attribute selector */
const rcvSel = (id) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : String(id).replace(/["\\]/g, "\\$&"));

// ---- agent wallets ------------------------------------------------------------------------

/** Wallets the account holds the key of, so that an agent can pay for things without you there: made by your signature, filled from your own
 * accounts, paid from inside the payees limit you give the agent, and emptied back to you */
function renderWallets(owner) {
  const subs = A.subAccounts || [];
  const live = (s) => A.venues.find((v) => v.id === `agent-${slug(s.name)}`);
  const sources = connected().filter((v) => canMove(v) && !v.id.startsWith("agent-"));
  const rows = subs.map((s) => {
    const v = live(s);
    const coins = v ? (v.holdings || []).filter((h) => h.amount > 0) : [];
    const gas = coins.filter((h) => h.class !== "stable" && h.class !== "cash");
    return `<tr><td>${esc(s.name)}<span class="why">pays for ${esc(s.agentName)} · <span class="mono">${esc(short(s.address))}</span> <button type="button" class="link dim" data-copy="${esc(s.address)}">Copy</button></span></td><td class="r num2">${v ? money(v.usd) : "—"}<span class="why">${esc(coins.filter((h) => !gas.includes(h)).map((h) => `${h.asset} ${qtyOf(h.amount)}${h.note ? ` on ${h.note}` : ""}`).join(" · ") || "empty")}${gas.length ? ` · gas ${esc(gas.map((h) => `${qtyOf(h.amount)} ${h.asset}${h.note ? ` (${h.note})` : ""}`).join(", "))}` : " · no gas yet"}</span></td><td class="r">${owner && v ? `${sources.length ? `<button type="button" class="link" data-topup="${esc(v.id)}">Top up…</button> · ` : ""}<button type="button" class="link dim" data-takeback="${esc(v.id)}">Take back…</button>` : ""}</td></tr>`;
  }).join("");
  const keys = A.keys.filter((k) => k.status === "ok");
  const form = owner && writesOn() && keys.length ? `<form class="add" id="wallet-form">${field("Name", '<input class="m" name="name" placeholder="research" maxlength="16" />')}${field("For agent", select("agent", keys.map((k) => [k.address, k.name])))}${field("Keep up to", '<input class="s" name="float" inputmode="decimal" placeholder="50" />')}<button type="submit" class="ink">Make it</button></form>` : "";
  $("wallets").innerHTML = `${subs.length ? `<table><tbody>${rows}</tbody></table>` : `<p class="empty">${keys.length ? "No agent wallet yet." : "Let an agent in first: a wallet pays for one agent."}</p>`}${form}<p class="dim small hint">The account holds its key; the agent never sees it. It pays x402 and MPP charges in USDC (Base, Arbitrum, Optimism, Polygon, Ethereum) inside the payees limit you give the agent under Agents. Sending money back out pays a little gas in that chain's own coin.</p>`;
  for (const b of $("wallets").querySelectorAll("button[data-copy]")) b.addEventListener("click", () => copyText(b.dataset.copy, b));
  for (const b of $("wallets").querySelectorAll("button[data-takeback]")) b.addEventListener("click", () => openLiveMove(b.dataset.takeback));
  for (const b of $("wallets").querySelectorAll("button[data-topup]")) b.addEventListener("click", () => topUpFrom(b.dataset.topup));
  const f = $("wallet-form");
  if (f) f.addEventListener("submit", (e) => {
    e.preventDefault();
    const v = formFields(f);
    const name = String(v.name || "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9 _-]{0,15}$/.test(name) || !(Number(v.float) > 0)) return void ((flash = "An agent wallet needs a name (letters and digits, up to 16) and how much it keeps at most."), render());
    own({ type: "createSubAccount", name, agent: v.agent, float: String(v.float).trim() });
  });
}
