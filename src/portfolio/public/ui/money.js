/* Money: receiving money at an account, moving real money between the owner's accounts, a wallet sending it, and the agents' own wallets.
   (The dollars that are ready are the Portfolio's Cash ready.) */

// ---- real money -------------------------------------------------------------------------

const NETWORKS = ["Arbitrum", "Base", "Ethereum", "Optimism", "Polygon", "BNB Chain"];

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
  const c = v.liveCan;
  const kinds = [...(c.withdraw !== false && !c.send ? [["withdraw", "Withdraw to another account of yours"]] : []), ...(c.send ? [["send", "Send from this wallet"]] : []), ...(c.send === "wallet" && v.proven ? [["bridge", "Across chains"]] : []), ...(c.ledgers.length > 1 && c.transfer !== false ? [["transfer", "Between its own ledgers"]] : []), ...(c.swap !== false && !c.send ? [["swap", "Swap stablecoins"]] : [])];
  if (!kinds.length) return void toast(`${v.name} moves nothing from here: ${v.readOnlyBecause || "its key may not withdraw, transfer or swap"}.`, "no");
  const dests = A.venues.filter((x) => x.id !== v.id && x.watchOnly && x.liveCan && x.liveCan.receive && !x.readOnlyBecause);
  const assets = [["USDC", "USDC"], ["USDT", "USDT"]];
  const amount = (ph) => field("Amount", `<input name="amount" inputmode="decimal" placeholder="${ph}" autocomplete="off" />`);
  const nets = (name, sel) => select(name, NETWORKS.map((x) => [x, x]), sel);
  /* the fields each kind of move needs */
  const bodyOf = (k) => (k === "transfer"
    ? `<div class="row2">${field("From", select("fromLedger", c.ledgers.map((l) => [l, l])))}${field("To", select("toLedger", c.ledgers.map((l) => [l, l]), c.ledgers[1]))}</div><div class="row2">${field("Currency", select("asset", assets))}${amount("50")}</div>`
    : k === "swap"
      ? `<div class="row2">${field("Sell", select("asset", assets, "USDT"))}${field("Buy", select("toAsset", assets, "USDC"))}</div>${amount("50")}`
      : k === "bridge"
        ? `${field("To", select("to", [[v.id, "This wallet, on the other chain"], ...dests.filter((d) => !d.address || d.proven).map((d) => [d.id, d.name])]))}<div class="row2">${field("From chain", nets("network", "Arbitrum"))}${field("To chain", nets("toLedger", "Base"))}</div><div class="row2">${field("Send", select("asset", assets))}${field("Arrives as", select("toAsset", assets))}</div>${amount("25")}`
        : `${dests.length ? field("To", select("to", dests.map((d) => [d.id, `${d.name}${d.address ? (d.proven ? "" : " · watched") : ""}`, !!d.address && !d.proven]))) : '<div class="path dim">Connect where it should go first: another exchange, or your wallet from the wallet itself.</div>'}<div class="row2">${field("Network", nets("network"))}${field("Currency", select("asset", assets))}</div>${amount("25")}${k === "withdraw" ? '<div class="path"><button type="button" class="link dim" data-fees>Fees on every network</button><span class="dim small" data-fees-list></span></div>' : ""}`);
  const draftOf = (form) => {
    const f = moneyFields(form);
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
          const routes = rr.status === 200 ? rr.body.routes : [];
          const best = routes[0];
          el.innerHTML = rr.status !== 200 ? esc(Owner.why(rr) || "No route answered.") : `${best ? `<b>Via ${esc(best.tool)}</b> · at least ${money(best.receiveUsd)} ${esc(a.toAsset)} arrives · ${esc(eta(best.etaSec))}${best.gasUsd ? ` · network fee about ${fine(best.gasUsd)} in your wallet` : ""}` : "No route answered."}${routes.length > 1 ? `<br />Other routes: ${routes.slice(1).map((x) => `${esc(x.tool)} fee ${fine(x.feeUsd)}, ${esc(eta(x.etaSec))}`).join(" · ")}` : ""}`;
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
    const rows = await Promise.all(NETWORKS.map(async (n) => {
      const r = await Owner.prepare({ ...d, network: n });
      return r.status === 200 ? { n, fee: Number(r.body.action.maxFee) } : { n, why: Owner.why(r) };
    }));
    if (!list.isConnected) return;
    const okRows = rows.filter((x) => x.fee !== undefined).sort((a, b) => a.fee - b.fee);
    list.innerHTML = ` · ${okRows.map((x) => `<button type="button" class="link" data-net="${esc(x.n)}">${esc(x.n)} ${esc(x.fee.toFixed(2))} ${esc(d.asset)}</button>`).join(" · ") || "no network takes it"}${rows.length > okRows.length ? ` · not on ${esc(rows.filter((x) => x.fee === undefined).map((x) => x.n).join(", "))}` : ""}`;
  };
  const draw = () => {
    box.innerHTML = bodyOf(form.elements.kind.value);
  };
  form.elements.kind.addEventListener("change", draw);
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
  if (preset.to && form.elements.to && [...form.elements.to.options].some((o) => o.value === preset.to)) form.elements.to.value = preset.to;
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

/* the networks an address can be asked for (the account's chains) */
const RECEIVE_NETWORKS = [...NETWORKS, "Robinhood Chain"];
/* an account gives an address to send to: a wallet proven yours (or one whose key the account holds), or a venue whose key or sign-in
   gives deposit addresses. A watched address gives none, and neither does a venue the account only reads */
const canReceive = (v) => (v.address ? !!v.proven : !!v.liveCan && v.liveCan.receive !== false && !v.readOnlyBecause);
/* what one might send there: the dollars first, then what the account already holds there */
const receiveAssets = (v) => [...new Set(["USDC", "USDT", "ETH", ...(v.holdings || []).filter((h) => h.class !== "cash").map((h) => String(h.asset).toUpperCase())])].filter((a) => /^[A-Z0-9.]{1,15}$/.test(a));

/** Where to send money so that it lands at one of the owner's accounts: the exchange's own deposit address, asked of it now (GET
 * /api/account/receive), or a proven wallet's own address. Pick the account, what is sent and on which network; the address comes with
 * whose it is, and a refusal in the venue's own words */
function openReceive(venueId = "") {
  if (!A) return;
  const R = connected().filter(canReceive);
  if (!R.length) return void toast("None of your accounts gives an address to send to from here. Connect a wallet you prove is yours, or an exchange whose key reads deposit addresses.", "no");
  const first = R.find((v) => v.id === venueId) || R[0];
  const body = openSheet(`<form class="qd rcv" novalidate>${field("To", select("venue", R.map((v) => [v.id, v.name]), first.id))}<div class="row2"><span data-rcv-asset></span>${field("Network", select("network", RECEIVE_NETWORKS.map((n) => [n, n]), first.address ? "Base" : "Arbitrum"))}</div><div class="rcv-out" data-rcv-out aria-live="polite"></div><div class="end"><button type="button" class="btn" data-sheet-close>Done</button></div></form>`, { title: "Receive" });
  const form = body.querySelector("form");
  const out = form.querySelector("[data-rcv-out]");
  let seq = 0;
  const assets = () => {
    const v = R.find((x) => x.id === form.elements.venue.value) || first;
    const was = form.elements.asset ? form.elements.asset.value : "";
    const list = receiveAssets(v);
    form.querySelector("[data-rcv-asset]").innerHTML = field("Asset", select("asset", list.map((a) => [a, a]), list.includes(was) ? was : list[0]));
  };
  const ask = async () => {
    const my = ++seq;
    const f = moneyFields(form);
    const v = R.find((x) => x.id === f.venue);
    out.innerHTML = `<p class="dim small">Asking ${esc(v ? v.name : f.venue)}…</p>`;
    const r = await api(`/api/account/receive?${new URLSearchParams({ venue: f.venue, asset: f.asset, network: f.network })}`);
    if (my !== seq || !form.isConnected) return;
    if (r.ok === false) return void (out.innerHTML = `<div class="msg no">${esc(refusalOf(r) || "No answer.")}</div>`);
    out.innerHTML = `<div class="rcv-box"><div class="label">Send ${esc(r.asset)} on ${esc(r.network)} to</div><div class="rcv-addr mono" data-rcv-addr>${esc(r.address)}</div>${r.tag ? `<div class="label">Memo / tag — needed with it</div><div class="rcv-addr mono">${esc(r.tag)}</div>` : ""}<div class="rcv-acts"><button type="button" class="btn btn-sm" data-rcv-copy>${icon("copy", "sm")}Copy address</button>${r.tag ? '<button type="button" class="btn btn-sm" data-rcv-copy-tag>Copy tag</button>' : ""}</div><p class="path">${esc(String(r.whose).charAt(0).toUpperCase() + String(r.whose).slice(1))}${r.note ? ` · ${esc(r.note)}` : ""}.</p><p class="path warn-t">Send only ${esc(r.asset)}, and only on ${esc(r.network)}${r.tag ? `, with the tag` : ""}: anything else may not arrive.</p></div>`;
    out.querySelector("[data-rcv-copy]").addEventListener("click", (e) => copyText(r.address, e.currentTarget));
    if (r.tag) out.querySelector("[data-rcv-copy-tag]").addEventListener("click", (e) => copyText(r.tag, e.currentTarget));
  };
  form.addEventListener("change", (e) => {
    if (e.target.name === "venue") assets();
    ask();
  });
  form.addEventListener("submit", (e) => e.preventDefault());
  assets();
  ask();
}
/* a form's fields by name (core's formOf takes an id) */
const moneyFields = (form) => Object.fromEntries(new FormData(form).entries());

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
    const v = Object.fromEntries(new FormData(f).entries());
    const name = String(v.name || "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9 _-]{0,15}$/.test(name) || !(Number(v.float) > 0)) return void ((flash = "An agent wallet needs a name (letters and digits, up to 16) and how much it keeps at most."), render());
    own({ type: "createSubAccount", name, agent: v.agent, float: String(v.float).trim() });
  });
}
