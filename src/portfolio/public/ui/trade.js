/* Trading: the Trade pane — what can be traded where (one tile for each thing a connected venue really does), what is under way, the
   positions, the latest fills — and its order ticket in the panel on the right: the market first, then where, then the order, with its
   variants (predictions, perpetuals, a swap, selling many at once, earning). Each is prepared by the account, shown in words with what is
   signed, and placed by the owner's signature; a venue that refuses says so in its own words. Also: the ticket that changes an open order,
   and a wallet sending what the account built for a DEX order. */

// ---- an order in words, changing one, a wallet sending one -------------------------------

/* an order's type in words: market, a limit, a stop and where it triggers */
const typeText = (o) => (o.type === "limit" ? `limit ${px(o.limitPrice)}` : o.type === "stop" ? `stop at ${px(o.stopPrice)}` : o.type === "stop_limit" ? `stop ${px(o.stopPrice)}, limit ${px(o.limitPrice)}` : "market") + (o.tif ? ` · ${o.tif.toUpperCase()}` : "") + (o.postOnly ? " · post-only" : "") + (o.reduceOnly ? " · reduce-only" : "");
/* an event contract's price as a person reads it: cents, which is also the market's chance in percent */
const tkCents = (p) => (p === undefined || p === null || p === "" || !Number.isFinite(Number(p)) ? "—" : `${Number((Number(p) * 100).toFixed(1))}¢`);
/* a price typed on a ticket: an event contract's in cents (62 → 0.62), anything else as it was typed */
const tkPriceIn = (s, cents) => {
  const t = String(s ?? "").trim();
  if (!cents || t === "" || !Number.isFinite(Number(t))) return t;
  return String(Number((Number(t) / 100).toFixed(6)));
};

/** change an open order in place: a new size, limit or stop. The account values it afresh and shows what it would be worth; your signature changes it */
function openAmend(o) {
  if (!o) return;
  const limited = o.type === "limit" || o.type === "stop_limit";
  const stopped = o.type === "stop" || o.type === "stop_limit";
  const ev = o.kind === "event";
  const was = (n) => (ev ? String(Number((Number(n) * 100).toFixed(2))) : String(n));
  quoteDialog({
    title: `Change ${o.id}`,
    sub: esc(`${o.venueName} · ${o.side === "buy" ? "Buy" : "Sell"} ${qtyOf(o.qty)} ${ev ? "contracts" : o.base} · ${typeText(o)}. Leave a field empty to keep it.`),
    fields: `<div class="row">${field("Size", `<input name="qty" inputmode="decimal" placeholder="${esc(String(o.qty))}" autocomplete="off" />`)}${stopped ? field(ev ? "Stop (¢)" : "Stop price", `<input name="stopPrice" inputmode="decimal" placeholder="${esc(was(o.stopPrice))}" autocomplete="off" />`) : ""}${limited ? field(ev ? "Limit (¢)" : "Limit price", `<input name="limitPrice" inputmode="decimal" placeholder="${esc(was(o.limitPrice))}" autocomplete="off" />`) : ""}</div>`,
    draft: (form) => {
      const f = Object.fromEntries(new FormData(form).entries());
      const d = { type: "liveAmend", venue: o.venue, order: o.id, qty: String(f.qty || "").trim(), limitPrice: tkPriceIn(f.limitPrice, ev), stopPrice: tkPriceIn(f.stopPrice, ev) };
      return d.qty || d.limitPrice || d.stopPrice ? d : "Type what changes.";
    },
    show: (p) => {
      const q = p.quote.order;
      return `<div class="big"><span>${esc(q.words)}</span><span>≈ ${money(q.notionalUsd)}</span></div><div class="path">${o.side === "buy" ? `costs at most ${money(q.maxUsd)}` : `worth about ${money(q.maxUsd)}`}</div>`;
    },
    done: (r) => (r.body.order ? `Changed: ${r.body.order.id} · ${r.body.order.note}` : ""),
    go: "Sign and change",
  });
}

/** wait for a transaction a wallet sent to be on chain, asked of the wallet itself (a swap after an approval needs the approval first) */
async function mined(w, hash, ms = 120_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const r = await w.provider.request({ method: "eth_getTransactionReceipt", params: [hash] }).catch(() => null);
    if (r && r.blockNumber) {
      if (r.status === "0x0") throw new Error(`transaction ${short(hash)} failed on chain`);
      return;
    }
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error(`transaction ${short(hash)} is not on chain yet: try again in a minute`);
}

/** the wallet each proven address was proven with, while this page is open */
const PROVIDERS = new Map();

/** the wallet that proved `address`, asked again if this page has forgotten it; it has to answer with that same address */
async function walletFor(address) {
  const known = PROVIDERS.get(address.toLowerCase());
  if (known) return known;
  for (const w of await findWallets()) {
    const accounts = await w.provider.request({ method: "eth_requestAccounts" }).catch(() => []);
    if ((accounts || []).some((a) => a.toLowerCase() === address.toLowerCase())) {
      PROVIDERS.set(address.toLowerCase(), w);
      return w;
    }
  }
  throw new Error(`no wallet in this browser answers for ${short(address)}: open this page where that wallet is installed`);
}

/** what a wallet has already sent, by a key no other run of the account reuses (an order's client id; a payment's id and time), while this
   page is open; the account itself keeps the hash once it has been reported */
const SENT = new Map();
/** payments and orders whose wallet flow is running in this page: never two at once for one */
const INFLIGHT = new Set();

/* Robinhood Chain, for a wallet that does not know it yet: the wallet shows it to the owner before adding it (chain 4663; its own RPC and
   explorer, as Robinhood publishes them) */
const TK_ROBINHOOD_CHAIN = { chainId: "0x1237", chainName: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: ["https://rpc.mainnet.chain.robinhood.com/"], blockExplorerUrls: ["https://robin.etherscan.io/"] };
/* a wallet's "I don't know that chain" (EIP-3085: 4902), as wallets wrap it */
const tkUnknownChain = (err) => !!err && (err.code === 4902 || (err.data && err.data.originalError && err.data.originalError.code === 4902));

/** the wallet on the transaction's chain: switched to it; a wallet that does not know Robinhood Chain is offered it first */
async function tkSwitchChain(w, chainIdHex) {
  try {
    await w.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainIdHex }] });
  } catch (err) {
    if (!(tkUnknownChain(err) && String(chainIdHex).toLowerCase() === TK_ROBINHOOD_CHAIN.chainId)) throw new Error(`${w.info.name} did not switch to the right network: ${(err && err.message) || err}`);
    try {
      await w.provider.request({ method: "wallet_addEthereumChain", params: [TK_ROBINHOOD_CHAIN] });
      await w.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainIdHex }] });
    } catch (err2) {
      throw new Error(`${w.info.name} did not add Robinhood Chain: ${(err2 && err2.message) || err2}`);
    }
  }
}

/** a DEX order: the account built the transactions (an approval first, when one is needed); the wallet shows each one and sends it */
async function sendOrderFromWallet(o) {
  if (INFLIGHT.has(o.clientId)) throw new Error(`${o.id} is already waiting for your wallet: finish it there`);
  INFLIGHT.add(o.clientId);
  try {
    await sendOrderOnce(o);
  } finally {
    INFLIGHT.delete(o.clientId);
  }
}
async function sendOrderOnce(o) {
  // asked again first: an order taken back since this page last read it is not sent
  const now = ((await (await fetch("/api/account")).json()).orders || []).find((x) => x.id === o.id);
  if (!now || now.ref || !["pending"].includes(now.status)) throw new Error(`${o.id} is no longer waiting for your wallet (${now ? now.status : "gone"}): nothing was sent`);
  // the account already has a hash for it: that one is reported again, nothing new is sent
  if (now.reported) SENT.set(o.clientId, now.reported);
  const txs = now.walletTxs || [];
  if (!txs.length) return;
  const w = await walletFor(txs[0].from);
  const send = async (tx) => {
    await tkSwitchChain(w, tx.chainIdHex);
    return w.provider.request({ method: "eth_sendTransaction", params: [{ from: tx.from, to: tx.to, data: tx.data, value: tx.value, ...(tx.gas ? { gas: tx.gas } : {}) }] });
  };
  let swap = txs[txs.length - 1];
  if (txs.length > 1 && !SENT.get(o.clientId)) {
    // the approval first, on chain before the swap; then the swap built again from a fresh quote, so a slow approval leaves no stale swap
    for (const tx of txs.slice(0, -1)) await mined(w, await send(tx));
    const fresh = await postJson("/api/account/live/order-requote", { order: o.id });
    if (fresh.status === 200 && fresh.body.order && fresh.body.order.walletTxs) swap = fresh.body.order.walletTxs[fresh.body.order.walletTxs.length - 1];
    else if (fresh.status !== 200 && !(fresh.body.refusal && /cannot build the swap again/.test(fresh.body.refusal.message))) throw new Error(Owner.why(fresh) || "the swap could not be built again");
  }
  // a swap the wallet already sent is reported again, never sent twice: the chain may simply not show it yet
  const hash = SENT.get(o.clientId) || (await send(swap));
  SENT.set(o.clientId, hash);
  const r = await postJson("/api/account/live/order-sent", { order: o.id, hash });
  if (r.status !== 200) throw new Error(`${Owner.why(r) || "the account could not take the transaction"}. Your wallet sent ${short(hash)}: “Report again” reports that same transaction, it does not send another`);
  SENT.delete(o.clientId);
  said = `${w.info.name} sent it: ${short(hash)}`;
}

/* what an order's size is counted in, by the kind of market (a coin's own name when it is "") */
const UNITS = { spot: "", perp: "contracts", future: "contracts", stock: "shares", crypto: "", event: "contracts", token: "" };

// ---- the pane: what this account can trade, and what is under way -------------------------

/* the pane's own state: Do it myself or Hand to agent (kept in this browser), a ticket asked for before the pane was drawn, the tile the
   route opened, the positions as last read, and which ticket is current (a ticket replaced by another writes nothing late) */
const TK = { mode: "self", pending: null, tileDone: "", pos: null, gen: 0, legs: null, connecting: null, draftLooked: false };
try {
  TK.mode = localStorage.getItem("account.tradeMode") === "agent" ? "agent" : "self";
} catch {
  // storage off: Do it myself
}
onRoute((tab) => {
  if (tab !== "trade") TK.tileDone = "";
});

/* the tiles: one for each thing a connected venue does from here */
const TK_TILES = [["trade", "trade", "Buy & sell"], ["swap", "swap", "Swap"], ["perps", "perps", "Perps"], ["predictions", "prediction", "Predictions"], ["sellmany", "sellmany", "Sell many"], ["move", "move", "Move"], ["earn", "earn", "Earn"]];
/* the stablecoins and cash a swap reads as dollars */
const TK_DOLLARS = new Set(["USD", "USDC", "USDT", "USDG", "DAI", "PYUSD", "FDUSD", "USDE", "USDS", "TUSD"]);
const tkDollar = (asset) => TK_DOLLARS.has(String(asset || "").toUpperCase());
/* a wallet that swaps stablecoins for each other at its venue (an exchange's own convert) */
const tkStableSwap = (v) => writesOn() && !!v.liveCan && !v.readOnlyBecause && !watched(v) && v.liveCan.swap !== false && !v.liveCan.send;
const tkKinds = (v) => (v.trade && v.trade.kinds) || [];
/* why a venue that offers something cannot do it now, in its own words where it gave some */
const tkWhyNot = (v) => v.noTradeBecause || (v.trade && v.trade.can === false ? "this key can't trade" : watched(v) ? "a watched address: nothing is traded from it" : "orders are not placed here");

/** The tiles at these venues: each with the venues that offer it, those that can do it now, and a line under its name. A tile no connected
 * venue offers is not drawn; one whose venues all refuse is drawn with their words (opening it says how to fix it) */
function tkTilesFor(L) {
  if (!writesOn()) return [];
  const offer = (kinds) => L.filter((v) => v.trade && tkKinds(v).some((k) => kinds.includes(k)));
  const names = (vs) => vs.map((v) => v.name).join(", ");
  const out = [];
  const add = (id, offering, able, sub, cant) => {
    if (!offering.length) return;
    const [, ic, label] = TK_TILES.find((t) => t[0] === id);
    out.push({ id, icon: ic, label, venues: offering.map((v) => v.id), able: able.map((v) => v.id), sub: able.length ? sub(able) : cant || `${offering[0].name}: ${tkWhyNot(offering[0])}` });
  };
  const spot = offer(["spot", "crypto", "stock", "token"]);
  const spotAble = spot.filter(canTrade);
  add("trade", spot, spotAble, (vs) => {
    const k = new Set(vs.flatMap(tkKinds));
    const coins = k.has("spot") || k.has("crypto") || k.has("token");
    return coins && k.has("stock") ? "Coins and stocks" : k.has("stock") ? "Stocks" : k.has("token") && !k.has("spot") && !k.has("crypto") ? "Tokens from your wallet" : "Coins";
  });
  const swapping = [...new Set([...L.filter(tkStableSwap), ...offer(["spot", "token", "crypto"])])];
  add("swap", swapping, swapping.filter((v) => tkStableSwap(v) || canTrade(v)), (vs) => (vs.some((v) => tkKinds(v).includes("token") && canTrade(v)) ? "Tokens on-chain" : vs.some((v) => canTrade(v)) ? "Coins, through dollars" : "Stablecoins"));
  const perps = offer(["perp", "future"]);
  add("perps", perps, perps.filter(canTrade), (vs) => `At ${names(vs)}`);
  const events = offer(["event"]);
  add("predictions", events, events.filter(canTrade), names);
  const traders = L.filter((v) => v.trade);
  add("sellmany", traders, traders.filter(canTrade), () => "Up to 10 at once");
  const movers = L.filter((v) => v.liveCan && !watched(v));
  add("move", movers, movers.filter(canMove), () => "Between your accounts", movers.length ? `${movers[0].name}: ${movers[0].readOnlyBecause || "this key can't move money"}` : "");
  const earners = L.filter((v) => v.earn);
  add("earn", earners, earners.filter((v) => v.earn.can !== false), (vs) => (vs.length === 1 ? `${vs[0].earn.what || vs[0].name}` : names(vs)), earners.length ? `${earners[0].name}: ${earners[0].earn.whyNot || "this key can't put money to earn"}` : "");
  return out;
}

/** the Trade pane: the switch between doing it yourself and handing it to an agent, the tiles, the owner's words to agents (when handing
 * over), what is under way, the positions and the latest fills; the panel on the right keeps the ticket (or the composer) across redraws */
function renderTrade({ el, owner, lens, params }) {
  if (!el.querySelector("[data-tp]")) {
    el.innerHTML = `<div class="cols tp" data-tp><div class="col-main tp-main"><div class="tp-head"><h2 class="h2 tp-title">Trade</h2><div data-tp-mode></div></div><div data-tp-note></div><div class="tile-grid" data-tp-tiles></div><section class="sec" data-tp-intents aria-labelledby="tp-intents-h" hidden></section><section class="sec" data-tp-open aria-labelledby="tp-open-h"></section><section class="sec" data-tp-pos aria-labelledby="tp-pos-h" hidden></section><section class="sec" data-tp-fills aria-labelledby="tp-fills-h" hidden></section></div><aside class="col-side panel tk-panel" id="tk-panel" aria-label="Order ticket"></aside></div>`;
    el.querySelector("[data-tp-mode]").innerHTML = seg([["self", "Do it myself"], ["agent", "Hand to agent"]], TK.mode, tkSetMode, { label: "Who does it" });
    tkRest();
    if (!TK.pending) tkReopenDraft();
  }
  for (const b of el.querySelectorAll("[data-tp-mode] button")) b.setAttribute("aria-pressed", String(b.dataset.v === TK.mode));
  const L = connected();
  const tiles = tkTilesFor(lens.kind === "venue" ? L.filter((v) => v.id === lens.id) : L);
  const note = el.querySelector("[data-tp-note]");
  note.innerHTML = !A.connectLive ? '<p class="empty">This server has no way to connect accounts.</p>' : !writesOn() ? '<p class="empty">This server was started read-only: it places no orders and moves no money from here.</p>' : !L.length ? `<div class="callout"><b>Connect an account that trades</b><span class="dim">An exchange, a broker, a prediction market or your wallet: what it can do shows up here.</span><div><button type="button" class="btn btn-primary" data-tp-connect${owner ? "" : " disabled"}>${icon("plug")}Connect an account</button></div></div>` : !tiles.length ? `<p class="empty">${lens.kind === "venue" ? `${esc(lens.name)} trades nothing from here.` : "None of your accounts trades from here yet."}</p>` : "";
  const c = note.querySelector("[data-tp-connect]");
  if (c) c.addEventListener("click", () => openPicker());
  const grid = el.querySelector("[data-tp-tiles]");
  grid.innerHTML = tiles.map((t) => `<button type="button" class="choice${t.able.length ? "" : " tk-off"}" data-tile="${esc(t.id)}">${icon(t.icon)}<b>${esc(t.label)}</b><span>${esc(t.sub)}</span></button>`).join("");
  for (const b of grid.querySelectorAll("button[data-tile]")) b.addEventListener("click", () => tkTile(tiles.find((t) => t.id === b.dataset.tile), lens));
  const intents = el.querySelector("[data-tp-intents]");
  intents.hidden = TK.mode !== "agent";
  if (TK.mode === "agent") {
    intents.innerHTML = `<div class="sec-head"><h2 class="h2" id="tp-intents-h">Your words to agents</h2><span class="dim small">${A.intents.length ? plural(A.intents.length, "open intent") : ""}</span></div><div data-intent-list></div>`;
    if (typeof htaIntents === "function") htaIntents(intents.querySelector("[data-intent-list]"), owner, { change: (x) => openHandToAgent({ intent: x }) });
  }
  tkDrawOpen(el.querySelector("[data-tp-open]"), owner);
  tkDrawPositions(el.querySelector("[data-tp-pos]"), owner, L);
  tkDrawFills(el.querySelector("[data-tp-fills]"));
  // a venue connected from the ticket's "Connect to trade" is on the account now: the ticket offers it
  if (TK.connecting) {
    const c = TK.connecting;
    const fresh = A.venues.find((v) => v.live && !c.before.has(v.id));
    if (c.gen !== TK.gen) TK.connecting = null;
    else if (fresh) {
      TK.connecting = null;
      c.redo(fresh.id);
    }
  }
  // what was asked for before the pane was drawn, or the tile the route names (#/trade?tile=swap), opens now
  if (TK.pending) {
    const p = TK.pending;
    TK.pending = null;
    tkOpen(p);
  } else if (params.tile && params.tile !== TK.tileDone) {
    TK.tileDone = params.tile;
    const t = tiles.find((x) => x.id === params.tile);
    if (t) tkTile(t, lens);
  }
}

/* Do it myself or Hand to agent: the panel holds the ticket or the composer, and the tiles open the one or the other */
function tkSetMode(m) {
  TK.mode = m === "agent" ? "agent" : "self";
  try {
    localStorage.setItem("account.tradeMode", TK.mode);
  } catch {
    // a private window: the choice holds for this visit
  }
  tkRest();
  if (A) render();
}

/* the panel at rest: the empty ticket, or the composer. At rest nothing takes the focus, so the page keeps refreshing while it is watched */
function tkRest() {
  if (TK.mode === "agent" && typeof htaMount === "function") return void tkHandInPanel({});
  tkOpen({ rest: true });
}

/** a tile: in Do it myself, its ticket; in Hand to agent, the composer for it. A tile whose venues all refuse says why, and how to fix it */
function tkTile(t, lens) {
  if (!t) return;
  const venue = lens && lens.kind === "venue" ? lens.id : t.able[0] || t.venues[0];
  if (TK.mode === "agent" && t.id !== "move" && t.id !== "sellmany") return void openHandToAgent({ kind: t.id, venue: t.able.length ? venue : "" });
  if (!t.able.length) return void tkRefusal(t);
  if (t.id === "move") {
    const vs = connected().filter(canMove);
    if (vs.length === 1) return void openLiveMove(vs[0].id);
    pickSheet("Move money from", vs.map((v) => [v.id, v.name, money(v.usd)]), { note: "Withdraw to another account of yours, between an exchange's own ledgers, or across chains from a wallet." }).then((id) => id && openLiveMove(id));
    return;
  }
  tkOpen({ variant: t.id, venue: lens && lens.kind === "venue" ? lens.id : t.id === "swap" ? "" : t.able.includes(venue) ? venue : t.able[0] });
}

/* a tile none of whose venues can do it now: each venue's own words, and what to change at the venue */
function tkRefusal(t) {
  const panel = $("tk-panel");
  if (!panel) return;
  TK.gen++;
  const vs = t.venues.map((id) => A.venues.find((v) => v.id === id)).filter(Boolean);
  const how = (v) => (t.id === "earn" ? v.earn.whyNot || "" : v.trade && v.trade.can === false ? `${keyHowFor(v)} Then connect it again.` : "");
  panel.innerHTML = `${tkHead(t.label)}<div class="callout"><div class="label warn-t">Not from here yet</div>${vs.map((v) => `<div><b>${esc(v.name)}</b>: ${esc(t.id === "earn" ? v.earn.whyNot || "it can't put money to earn with this key" : t.id === "move" ? v.readOnlyBecause || "this key can't move money" : tkWhyNot(v))}${how(v) && t.id !== "earn" ? `<span class="why">${esc(how(v))}</span>` : ""}</div>`).join("")}</div>`;
  tkWireHead(panel);
}

/* the panel's head: a title, and a close that puts the panel back at rest */
const tkHead = (title) => `<div class="tk-h"><h2 class="tk-title" data-tk-title>${esc(title)}</h2><button type="button" class="icon-btn" data-tk-close aria-label="Close the ticket">${icon("x")}</button></div>`;
const tkWireHead = (panel) => {
  const b = panel.querySelector("[data-tk-close]");
  if (b) b.addEventListener("click", () => {
    tkDraftKeep(null);
    tkOpen({ rest: true });
  });
};

/* the ticket being typed, kept in this browser until it is placed or closed, so a reload does not lose it. Only the ticket's own fields:
   where, which market, which way, how much, the order's type and prices — never anything signed */
const TK_DRAFT = "account.ticket";
const TK_DRAFT_FIELDS = ["variant", "venue", "venueName", "symbol", "side", "outcome", "kind", "key", "base", "name", "amount", "unit", "orderType", "limitPrice", "stopPrice", "tif"];
const TK_DRAFT_MS = 24 * 3_600_000;
function tkDraftRead() {
  try {
    const d = JSON.parse(localStorage.getItem(TK_DRAFT) || "null");
    if (!d || typeof d !== "object" || !d.venue || !d.symbol || !(Date.now() - Number(d.at) < TK_DRAFT_MS)) return null;
    return Object.fromEntries(TK_DRAFT_FIELDS.filter((k) => d[k] !== undefined && d[k] !== "").map((k) => [k, String(d[k]).slice(0, 120)]));
  } catch {
    return null;
  }
}
function tkDraftKeep(d) {
  try {
    if (d) localStorage.setItem(TK_DRAFT, JSON.stringify({ ...d, at: Date.now() }));
    else localStorage.removeItem(TK_DRAFT);
  } catch {
    // storage off (a private window): the draft lives as long as the page
  }
}
/** a draft kept from an earlier visit: opened again, at rest (nothing takes the focus), only if its venue is still connected and still
 * lists its market; otherwise dropped without a word. A ticket opened meanwhile wins */
async function tkReopenDraft() {
  if (TK.draftLooked) return;
  TK.draftLooked = true;
  const d = tkDraftRead();
  if (!d) return void tkDraftKeep(null);
  const v = A.venues.find((x) => x.id === d.venue && x.live);
  if (!v || !canTrade(v)) return void tkDraftKeep(null);
  const gen = TK.gen;
  const body = await api(`/api/account/market?${new URLSearchParams({ venue: d.venue, symbol: d.symbol })}`, { ttl: 3_000 });
  if (!body || body.ok === false || !body.market || (d.variant && !TK_VARIANTS[d.variant])) return void tkDraftKeep(null);
  if (gen !== TK.gen || TK.mode !== "self" || !$("tk-panel")) return;
  tkOpen({ ...d, rest: true });
}

/** Open the order ticket. preset { venue, symbol, side, kind ("perp", "event"…), outcome, variant ("trade" · "perps" · "predictions" · "swap" ·
 * "sellmany" · "earn"), amount, unit, orderType }. It lives in the Trade pane's panel: from another pane, the page goes there first */
function openTicket(preset = {}) {
  if (!A) return;
  if (TK.mode === "agent") {
    TK.mode = "self";
    try {
      localStorage.setItem("account.tradeMode", "self");
    } catch {
      // the choice holds for this visit
    }
  }
  if (ROUTE.tab !== "trade" || !$("tk-panel")) {
    TK.pending = preset || {};
    go("trade");
    return;
  }
  render();
  tkOpen(preset || {});
  tkShowPanel();
}

/* on a window too narrow for two columns the panel sits under the pane: brought into view */
function tkShowPanel() {
  const p = $("tk-panel");
  if (!p || !p.getBoundingClientRect) return;
  const r = p.getBoundingClientRect();
  if (r.top > window.innerHeight || r.bottom < 0) p.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* the composer in the panel, when the Trade pane is showing (intent.js asks this first) */
function tkHandInPanel(preset) {
  const panel = $("tk-panel");
  if (ROUTE.tab !== "trade" || !panel || typeof htaMount !== "function") return false;
  if (TK.mode !== "agent") {
    TK.mode = "agent";
    try {
      localStorage.setItem("account.tradeMode", "agent");
    } catch {
      // for this visit
    }
    if (A) render();
  }
  TK.gen++;
  htaMount(panel, preset || {}, { close: () => tkHandInPanel({}) });
  tkShowPanel();
  return true;
}

/* which ticket a preset opens */
const tkVariantOf = (p) => p.variant || (p.kind === "perp" || p.kind === "future" ? "perps" : p.kind === "event" ? "predictions" : "trade");
function tkOpen(preset) {
  const panel = $("tk-panel");
  if (!panel || !A) return;
  const variant = tkVariantOf(preset);
  if (variant === "swap") return void tkSwap(panel, preset);
  if (variant === "sellmany") return void tkSellMany(panel, preset);
  if (variant === "earn") return void tkEarn(panel, preset);
  tkTicket(panel, variant, preset);
}

// ---- the ticket: market, where, the order ------------------------------------------------------

const TK_TYPE_NAMES = { market: "Market", limit: "Limit", stop: "Stop", stop_limit: "Stop limit" };
const TK_TIF_NAMES = { gtc: "Until canceled", ioc: "Fill now, rest canceled", fok: "All now or nothing", day: "Today only" };
const TK_LIMITED = ["limit", "stop_limit"];
const TK_STOPPED = ["stop", "stop_limit"];
/* what each ticket searches: the Markets tab it reads, the kinds of row it keeps */
const TK_VARIANTS = {
  trade: { title: "Buy & sell", tab: "", kinds: ["coin", "stock", "rwa"], hint: "Search BTC, AAPL, a token…" },
  perps: { title: "Perps", tab: "perps", kinds: ["perp"], hint: "Search BTC, ETH, SOL…" },
  predictions: { title: "Predictions", tab: "predictions", kinds: ["event"], hint: "Search the Fed, an election, a game…" },
};
/* a market's kind as the Markets rows name it */
const tkRowKind = (m) => (m.kind === "event" ? "event" : m.kind === "perp" || m.kind === "future" ? "perp" : m.kind === "stock" ? "stock" : m.category === "RWA" ? "rwa" : "coin");

/** an order's draft from the ticket's fields: the market and side picked, the size in dollars or in the market's units, the limit and stop
 * (an event contract's typed in cents), the time in force and the flags the market takes */
function tkOrderDraft(f, { venue, symbol, side, event }) {
  const t = f.orderType || "market";
  const amount = String(f.amount || "").trim();
  return { type: "liveOrder", venue, symbol, side, orderType: t, ...(f.unit === "qty" ? { qty: amount } : { usd: amount }), limitPrice: TK_LIMITED.includes(t) ? tkPriceIn(f.limitPrice, event) : "", stopPrice: TK_STOPPED.includes(t) ? tkPriceIn(f.stopPrice, event) : "", tif: f.tif || "", postOnly: t === "limit" && f.postOnly ? "true" : "", reduceOnly: f.reduceOnly ? "true" : "" };
}

/** The ticket: find the market (at the connected venues and at the venues that publish prices without a key), pick where (the best price of
 * your accounts first; a venue not connected says "Connect to trade"), then the order as that market takes it. The account prepares the
 * exact order; you see it in words and what you sign; your signature places it */
function tkTicket(panel, variant, preset) {
  const gen = ++TK.gen;
  const V = TK_VARIANTS[variant] || TK_VARIANTS.trade;
  const owner = owns();
  const LOOK = owner ? "" : "This browser only looks: pair it to sign";
  const cap = A.connectLive && A.connectLive.writes ? A.connectLive.writes.capUsd : 0;
  panel.innerHTML = `${tkHead(V.title)}<form class="tk-form" novalidate autocomplete="off">
    <div class="tk-find" data-find data-live><label class="fld">Market<input type="search" name="q" placeholder="${esc(V.hint)}" spellcheck="false" autocomplete="off" /></label><div class="tk-res" data-res aria-live="polite"></div></div>
    <div class="tk-picked" data-picked hidden></div>
    <div class="tk-out" data-outcomes hidden></div>
    <div class="tk-where-w" data-where-w hidden><div class="label">Where</div><div class="tk-where" data-where></div></div>
    <div class="tk-stack" data-body hidden>
      <div class="tk-side" data-side></div>
      <div class="row2"><label class="fld">Amount<input name="amount" inputmode="decimal" placeholder="25" autocomplete="off" /></label><label class="fld">In<select name="unit"><option value="usd">Dollars</option><option value="qty">Units</option></select></label></div>
      <div class="row2"><label class="fld">Order<select name="orderType"><option value="market">Market</option><option value="limit">Limit</option></select></label><label class="fld" data-limit hidden><span data-limit-l>Limit price</span><input name="limitPrice" inputmode="decimal" autocomplete="off" /></label></div>
      <div class="row2" data-stop hidden><label class="fld"><span data-stop-l>Stop price</span><input name="stopPrice" inputmode="decimal" autocomplete="off" /></label></div>
      <div class="tk-more" data-more hidden><span data-tif></span><label class="chk1" data-post hidden><input type="checkbox" name="postOnly" /> Post-only</label><label class="chk1" data-reduce hidden><input type="checkbox" name="reduceOnly" /> Reduce-only</label></div>
      <div class="tk-lev" data-lev hidden></div>
      <div class="tk-facts" data-facts></div>
      <div class="quote real" data-q><span class="dim">Type an amount.</span></div>
      <div data-sign></div>
      <div class="msg" data-msg role="status"></div>
      <button type="submit" class="btn btn-primary btn-block" data-go disabled${owner ? "" : ` title="${LOOK}"`}>Sign and place</button>
      <div class="tk-cap dim small">${cap ? `Up to ${money(cap)} an order.` : ""}</div>
    </div>
    <button type="button" class="btn btn-block" data-hand>${icon("agent")}Hand to agent instead</button>
  </form>`;
  tkWireHead(panel);
  const form = panel.querySelector("form");
  const q = (sel) => form.querySelector(sel);
  const live = () => gen === TK.gen && form.isConnected;
  const res = q("[data-res]");
  const msg = q("[data-msg]");
  const btn = q("[data-go]");
  const say = (text, state = "") => {
    msg.className = `msg${text && state ? ` ${state}` : ""}`;
    msg.textContent = text || "";
  };
  let item = null;
  let picked = null;
  let outcome = preset.outcome || "";
  let side = preset.side === "sell" ? "sell" : "buy";
  let mk = null;
  let prepared = null;
  let ranked = null;
  let seq = 0;
  let tick = 0;
  let timer = 0;
  let presetUsed = false;
  q("[data-side]").innerHTML = seg([["buy", "Buy"], ["sell", "Sell"]], side, (v) => {
    side = v;
    panelTitle();
    drawOutcomes();
    if (item && item.kind === "event") drawWhere(picked);
    rank();
    keep();
    later(0);
  }, { label: "Buy or sell" });

  // ---- finding the market ----
  let sseq = 0;
  const search = async () => {
    const text = form.elements.q.value.trim();
    const my = ++sseq;
    res.innerHTML = '<p class="dim small">Searching your accounts and the public venues…</p>';
    const body = await api(`/api/account/explore?${new URLSearchParams({ ...(text ? { q: text } : {}), ...(V.tab ? { tab: V.tab } : {}), limit: "24" })}`, { ttl: 15_000 });
    if (!live() || my !== sseq) return;
    if (!body || body.ok === false) return void (res.innerHTML = `<p class="msg no">${esc(refusalOf(body) || "The markets could not be read.")}</p>`);
    let items = (body.items || []).filter((x) => V.kinds.includes(x.kind));
    // the venue the ticket was opened for comes first
    if (preset.venue) items = [...items.filter((x) => x.at.some((a) => a.venue === preset.venue)), ...items.filter((x) => !x.at.some((a) => a.venue === preset.venue))];
    items = items.slice(0, 8);
    const said = (body.missing || []).filter((m) => m.said || m.code === "E_VENUE_GEOBLOCKED");
    res.innerHTML = `${items.length ? `<ul class="tk-list" role="list">${items.map((x, i) => `<li><button type="button" data-i="${i}">${avatar(x.base || x.category || "?", "sm")}<span class="tk-rn"><b>${esc(x.name)}</b><span class="dim small">${esc(tkWhereWords(x))}</span></span><span class="tk-rp"><span class="tab-nums">${x.kind === "event" ? esc(tkCents(x.price)) : x.price ? `$${esc(px(x.price))}` : ""}</span>${x.kind === "event" ? "" : chg(x.changePct24h)}</span></button></li>`).join("")}</ul>` : `<p class="empty">${text ? `Nothing matches “${esc(text)}” at your accounts or the public venues.` : "Type to find a market."}</p>`}${said.map((m) => `<p class="tk-said dim small">${esc(m.venueName)}: “${esc(m.said || m.why)}” — the venue's own rule.</p>`).join("")}`;
    for (const b of res.querySelectorAll("button[data-i]")) b.addEventListener("click", () => pick(items[Number(b.dataset.i)]));
  };
  let findTimer = 0;
  form.elements.q.addEventListener("input", () => {
    clearTimeout(findTimer);
    findTimer = setTimeout(search, 300);
  });

  /* a row picked: its name and price; its outcomes (an event); where it is listed, ranked */
  const pick = (x, at) => {
    item = x;
    q("[data-find]").hidden = true;
    const pk = q("[data-picked]");
    pk.hidden = false;
    pk.innerHTML = `${avatar(x.base || x.category || "?")}<span class="tk-rn"><b>${esc(x.name)}</b><span class="dim small">${esc([x.category, x.closeTime ? `closes ${nyDay(x.closeTime)} ${nyTime(x.closeTime)} New York` : "", x.kind === "perp" && x.fundingRate !== undefined ? `funding ${(x.fundingRate * 100).toFixed(4)}%` : ""].filter(Boolean).join(" · "))}</span></span>${x.kind === "event" ? "" : `<span class="tk-rp"><span class="tab-nums">${x.price ? `$${esc(px(x.price))}` : ""}</span>${chg(x.changePct24h)}</span>`}<button type="button" class="link" data-change>Change</button>`;
    pk.querySelector("[data-change]").addEventListener("click", () => {
      tkDraftKeep(null);
      item = null;
      picked = null;
      mk = null;
      pk.hidden = true;
      q("[data-outcomes]").hidden = true;
      q("[data-where-w]").hidden = true;
      q("[data-body]").hidden = true;
      q("[data-find]").hidden = false;
      form.elements.q.focus();
      search();
    });
    if (x.kind === "event") panel.querySelector("[data-tk-title]").textContent = "Predictions";
    panelTitle();
    drawOutcomes();
    ranked = null;
    drawWhere(at);
    if (["coin", "stock", "rwa"].includes(x.kind) && x.base) rank();
  };
  /* a perpetual is bought long and sold short: the words follow the market */
  const longShort = () => item && item.kind === "perp";
  const panelTitle = () => {
    if (item && item.kind !== "event") panel.querySelector("[data-tk-title]").textContent = `${longShort() ? (side === "sell" ? "Short" : "Long") : side === "sell" ? "Sell" : "Buy"} ${item.base || item.name}`;
    for (const b of q("[data-side]").querySelectorAll("button[data-v]")) b.textContent = longShort() ? (b.dataset.v === "sell" ? "Short" : "Long") : b.dataset.v === "sell" ? "Sell" : "Buy";
  };
  const drawOutcomes = () => {
    const box = q("[data-outcomes]");
    const outs = item && item.kind === "event" ? item.outcomes || [] : [];
    box.hidden = !outs.length;
    if (!outs.length) return void (box.innerHTML = "");
    if (!outcome || !outs.some((o) => o.label.toUpperCase() === outcome.toUpperCase())) outcome = outs[0].label;
    box.innerHTML = outs.slice(0, 6).map((o, i) => `<button type="button" class="${i === 0 ? "yes" : i === 1 && outs.length === 2 ? "no-btn" : "yes tk-oth"}" data-out="${esc(o.label)}" aria-pressed="${String(o.label.toUpperCase() === outcome.toUpperCase())}">${esc(o.label)} ${esc(tkCents(side === "sell" ? o.bid ?? o.price : o.ask ?? o.price))}</button>`).join("");
    for (const b of box.querySelectorAll("button[data-out]")) b.addEventListener("click", () => {
      outcome = b.dataset.out;
      for (const x of box.querySelectorAll("button")) x.setAttribute("aria-pressed", String(x === b));
      drawWhere(picked);
      if (picked) choose(picked).then(keep);
    });
  };
  /* the symbol an outcome trades under at a venue */
  const symbolAt = (a) => {
    if (!item || item.kind !== "event") return a.symbol;
    const o = (item.outcomes || []).find((x) => x.label.toUpperCase() === outcome.toUpperCase());
    const there = o && o.at.find((x) => x.venue === a.venue);
    return there ? there.symbol : a.symbol;
  };
  /* where it is listed: your accounts that trade it (the best price first, when the venues were compared), the ones that cannot (in their
     words), and the venues not connected that publish it ("Connect to trade") */
  const drawWhere = (prefer) => {
    if (!item) return;
    const box = q("[data-where]");
    const w = q("[data-where-w]");
    const rows = tkWhereRows(item, ranked);
    if (item.kind === "event") {
      const o = (item.outcomes || []).find((x) => x.label.toUpperCase() === outcome.toUpperCase());
      for (const r of rows) if (o && r.state !== "public") r.price = side === "sell" ? o.bid ?? o.price : o.ask ?? o.price;
    }
    w.hidden = !rows.length;
    const none = !rows.some((r) => r.state === "able");
    // a tokenised asset: who issues it and whom it is for, in the issuer's words, once above the places (not again on each)
    const iss = typeof mkIssuer === "function" ? mkIssuer(item) : null;
    const said = (t) => !!iss && !!t && !!iss.eligibility && (t.includes(iss.eligibility) || iss.eligibility.includes(t));
    for (const r of rows) {
      if (said(r.note)) r.note = "";
      if (said(r.why)) r.why = `${r.venueName} takes no order for it: the issuer's terms above`;
    }
    box.innerHTML = `${iss ? `<p class="tk-iss small">${iss.issuer ? `Issued by <b>${esc(iss.issuer)}</b>.` : ""}${iss.eligibility ? ` <span class="dim">${esc(iss.eligibility)}</span>` : ""}</p>` : ""}${none && rows.length ? `<p class="dim small">${rows.some((r) => r.state === "public" && r.connector) ? "None of your accounts trades it yet: connect one where it is listed." : "None of your accounts can trade it now."}</p>` : ""}${rows.map((r, i) => {
      // a public listing: connect the venue to trade it there; a source nothing is traded through says so in its own words
      if (r.state === "public") return `<div class="tk-at pub"><span><b>${esc(r.venueName)}</b> <span class="tag">Public</span>${!r.connector && r.note ? `<span class="why">${esc(r.note)}</span>` : ""}</span><span class="tk-at-r">${r.price ? `<span class="tab-nums">${esc(item.kind === "event" ? tkCents(r.price) : `$${px(r.price)}`)}</span>${r.connector ? '<span class="tk-sep"> · </span>' : ""}` : ""}${r.connector ? `<button type="button" class="link" data-connect="${i}">Connect to trade</button>` : ""}</span></div>`;
      if (r.state === "off") return `<div class="tk-at off"><span><b>${esc(r.venueName)}</b><span class="why">${esc(r.why)}${r.how ? ` ${esc(r.how)}` : ""}</span></span></div>`;
      return `<button type="button" class="tk-at" data-at="${i}" aria-pressed="${String(!!picked && picked.venue === r.venue)}"><span><b>${esc(r.venueName)}</b>${r.best ? ' <span class="tag up">Best</span>' : ""}${r.closed ? ' <span class="tag">Closed</span>' : ""}${r.note ? `<span class="why">${esc(r.note)}</span>` : ""}</span><span class="tab-nums tk-at-r">${r.price ? esc(item.kind === "event" ? tkCents(r.price) : `$${px(r.price)}`) : ""}${r.worse ? `<span class="why">${esc(Math.abs(r.worse).toFixed(2))}% ${r.worse > 0 ? "worse" : "better, check"}</span>` : ""}</span></button>`;
    }).join("")}`;
    for (const b of box.querySelectorAll("button[data-at]")) b.addEventListener("click", () => choose(rows[Number(b.dataset.at)]));
    for (const b of box.querySelectorAll("button[data-connect]")) b.addEventListener("click", () => {
      // once the venue is connected (the next read of the account shows it), this market is looked up again so it is offered there
      TK.connecting = { gen, before: new Set(A.venues.filter((v) => v.live).map((v) => v.id)), redo: (id) => live() && refind(id) };
      tkConnectTo(rows[Number(b.dataset.connect)]);
    });
    const able = rows.filter((r) => r.state === "able");
    if (!picked || !able.some((r) => r.venue === picked.venue)) {
      const first = (prefer && able.find((r) => r.venue === prefer.venue && (!prefer.symbol || r.symbol === prefer.symbol))) || (preset.venue && able.find((r) => r.venue === preset.venue)) || able.find((r) => r.best) || able[0];
      if (first) choose(first);
      else {
        picked = null;
        q("[data-body]").hidden = true;
      }
    }
  };
  /* after "Connect to trade": the market read again — what was kept of it at the venues and in the public listings is dropped — so the
     venue just connected is where it trades, picked; a market it does not list stays as it was, its places read again */
  const refind = async (venue) => {
    for (const k of [...API.keys()]) if (/^\/api\/account\/(explore|compare|market)\?/.test(k)) API.delete(k);
    if (!item) return void search();
    const was = item;
    const body = await api(`/api/account/explore?${new URLSearchParams({ q: was.base || was.name, ...(V.tab ? { tab: V.tab } : {}), limit: "24" })}`);
    if (!live() || item !== was) return;
    const again = ((body && body.items) || []).find((x) => x.key === was.key);
    if (again) return void pick(again, { venue });
    ranked = null;
    drawWhere(picked);
    rank();
  };
  /* the same thing at your other accounts, by the price this order would take there: the best is one click away */
  let rseq = 0;
  const rank = async () => {
    if (!item || !["coin", "stock", "rwa"].includes(item.kind) || !item.base) return;
    const my = ++rseq;
    const f = Object.fromEntries(new FormData(form).entries());
    const usd = f.unit === "usd" && Number(f.amount) > 0 ? String(Number(f.amount)) : "";
    const body = await api(`/api/account/compare?${new URLSearchParams({ base: item.base, side, ...(usd ? { usd } : {}) })}`, { ttl: 10_000 });
    if (!live() || my !== rseq || !body || body.ok === false) return;
    ranked = body.rows || [];
    panelTitle();
    drawWhere(picked);
  };

  // ---- the order, as the market takes it ----
  const unitName = (m) => (m.kind === "event" ? "Contracts" : UNITS[m.kind] ? UNITS[m.kind][0].toUpperCase() + UNITS[m.kind].slice(1) : m.base);
  const choose = async (r) => {
    picked = { venue: r.venue, symbol: symbolAt(r), venueName: r.venueName };
    const rows = tkWhereRows(item, ranked);
    for (const b of q("[data-where]").querySelectorAll("button[data-at]")) {
      const row = rows[Number(b.dataset.at)];
      b.setAttribute("aria-pressed", String(!!row && row.venue === picked.venue));
    }
    q("[data-body]").hidden = false;
    const want = picked;
    const body = await api(`/api/account/market?${new URLSearchParams({ venue: want.venue, symbol: want.symbol })}`, { ttl: 3_000 });
    if (!live() || picked !== want) return;
    if (!body || body.ok === false) {
      mk = null;
      q("[data-q]").innerHTML = `<div class="msg no">${esc(refusalOf(body) || "No such market there.")}</div>`;
      return;
    }
    fit(body.market);
    later(0);
  };
  /* the market as the venue lists it: which order types, times in force and flags it takes — the ticket offers those and nothing else */
  const shape = () => {
    const t = form.elements.orderType.value;
    const ev = !!mk && mk.kind === "event";
    q("[data-limit]").hidden = !TK_LIMITED.includes(t);
    q("[data-stop]").hidden = !TK_STOPPED.includes(t);
    q("[data-limit-l]").textContent = ev ? "Limit (¢)" : "Limit price";
    q("[data-stop-l]").textContent = ev ? "Stop (¢)" : "Stop price";
    q("[data-post]").hidden = !(mk && mk.postOnly && t === "limit");
    // the times in force this order type takes here (a venue may take "Today only" for a stop and not for a limit)
    const sel = q("[data-tif] select");
    if (mk && sel) {
      const allowed = (mk.tifsByType && mk.tifsByType[t]) || mk.tifs || [];
      const keep = sel.value;
      sel.innerHTML = [["", "The venue's default"], ...allowed.map((x) => [x, TK_TIF_NAMES[x] || x])].map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join("");
      sel.value = allowed.includes(keep) ? keep : "";
    }
  };
  const fit = (m) => {
    mk = m;
    const v = A.venues.find((x) => x.id === picked.venue) || {};
    const keep = form.elements.orderType.value;
    form.elements.orderType.innerHTML = (m.types && m.types.length ? m.types : ["market"]).map((t) => `<option value="${esc(t)}">${esc(TK_TYPE_NAMES[t] || t)}</option>`).join("");
    form.elements.orderType.value = (m.types || []).includes(preset.orderType) && !presetUsed ? preset.orderType : (m.types || []).includes(keep) ? keep : (m.types || ["market"])[0];
    q("[data-tif]").innerHTML = m.tifs && m.tifs.length ? `<label class="fld">Time in force${select("tif", [["", "The venue's default"], ...m.tifs.map((t) => [t, TK_TIF_NAMES[t] || t])], presetUsed ? "" : preset.tif || "")}</label>` : "";
    q("[data-reduce]").hidden = !m.reduceOnly;
    q("[data-more]").hidden = !(m.tifs && m.tifs.length) && !m.postOnly && !m.reduceOnly;
    form.elements.unit.options[1].textContent = unitName(m);
    if (m.price) form.elements.limitPrice.placeholder = m.kind === "event" ? String(Number((m.price * 100).toFixed(1))) : String(Number(Number(m.price).toPrecision(10)));
    if (!presetUsed) {
      // what the ticket was opened with, once
      if (preset.amount) form.elements.amount.value = String(preset.amount);
      if (preset.unit === "qty" || preset.unit === "usd") form.elements.unit.value = preset.unit;
      if (preset.limitPrice) form.elements.limitPrice.value = String(preset.limitPrice);
      if (preset.stopPrice) form.elements.stopPrice.value = String(preset.stopPrice);
      presetUsed = true;
    }
    // a perpetual's leverage, where the venue lets it be set from here: its own signature
    const lev = q("[data-lev]");
    lev.hidden = !(v.trade && v.trade.leverage && (m.kind === "perp" || m.kind === "future"));
    lev.innerHTML = lev.hidden ? "" : `<div class="row2"><label class="fld">Leverage<input name="leverage" inputmode="numeric" placeholder="${m.maxLeverage ? `up to ${esc(String(m.maxLeverage))}` : "3"}" /></label><label class="fld">Margin${select("marginMode", [["", "As it is"], ["cross", "Cross"], ["isolated", "Isolated"]])}</label></div><div class="tk-lev-go"><button type="button" class="btn btn-sm" data-lev-prep>Set leverage…</button><span class="dim small">Its own signature, before the order.</span></div><div data-lev-sign></div>`;
    if (!lev.hidden) tkLeverage(lev, picked, m, live);
    facts();
    shape();
  };
  /* what the owner should know of this market before ordering: an event's payout and chance, a perpetual's funding and the position held */
  const facts = () => {
    const box = q("[data-facts]");
    if (!mk) return void (box.innerHTML = "");
    const m = mk;
    const lines = [];
    if (m.kind === "event") {
      const p = side === "sell" ? m.bid ?? m.price : m.ask ?? m.price;
      lines.push(`<b>${esc(m.outcome || outcome || "This outcome")}</b> at ${esc(tkCents(p))} — the market gives it ${p ? `${Math.round(p * 100)}%` : "no price"}. Each contract pays $1.00 if it happens, nothing if not.`);
      if (m.closeTime || (item && item.closeTime)) lines.push(`Closes ${esc(nyDay(m.closeTime || item.closeTime))} ${esc(nyTime(m.closeTime || item.closeTime))} New York.`);
    } else {
      if (m.bid || m.ask) lines.push(`Bid ${esc(px(m.bid))} · ask ${esc(px(m.ask))} ${esc(m.quote)}${m.changePct24h !== undefined ? ` · 24h ${chg(m.changePct24h)}` : ""}`);
      if (m.kind === "perp" || m.kind === "future") {
        if (m.fundingRate !== undefined) lines.push(`Funding ${esc((m.fundingRate * 100).toFixed(4))}% a period${m.nextFundingAt ? `, next paid ${esc(nyTime(m.nextFundingAt))} New York` : ""}${m.maxLeverage ? ` · up to ${esc(String(m.maxLeverage))}x here` : ""}.`);
        const held = ((TK.pos && TK.pos.positions) || []).find((x) => x.venue === picked.venue && x.symbol === m.symbol && x.qty > 0);
        lines.push(held ? `You hold ${esc(held.side)} ${esc(qtyOf(held.qty))}${held.leverage ? ` at ${esc(String(held.leverage))}x` : ""}${held.liquidationPrice ? ` · liquidation at ${esc(px(held.liquidationPrice))}` : ""}${held.entryPrice ? ` · entry ${esc(px(held.entryPrice))}` : ""}.` : "Nothing held here yet: the venue names a liquidation price once a position is open.");
      }
    }
    // the issuer and its terms: said once, above the places (Where), when the row carries them; else here, from the market
    if (m.issuer && !(m.note || "").includes(m.issuer) && !(typeof mkIssuer === "function" && item && mkIssuer(item))) lines.push(`Issued by ${esc(m.issuer)}.${m.eligibility ? ` ${esc(m.eligibility)}` : ""}`);
    if (!m.open) lines.push(`<b>Closed now.</b> ${esc(m.note || "")}`);
    else if (m.note) lines.push(esc(m.note));
    box.innerHTML = lines.map((l) => `<div>${l}</div>`).join("");
  };

  // ---- the quote, what is signed, the signature ----
  const draft = () => tkOrderDraft(Object.fromEntries(new FormData(form).entries()), { venue: picked.venue, symbol: picked.symbol, side, event: !!mk && mk.kind === "event" });
  const box = q("[data-q]");
  const sign = q("[data-sign]");
  const left = () => {
    const el = box.querySelector("[data-left]");
    if (!live() || !prepared || !el) return void clearInterval(tick);
    const ms = prepared.action.deadline - Date.now();
    if (ms <= 0) return void requote(true);
    el.textContent = `Your signature is good for ${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")} more.`;
  };
  /* the order prepared again from the fields: not when nothing changed and its ten minutes have a while to run; what is signed stays open
     if it was */
  let asked = "";
  const requote = async (force = false) => {
    if (!live()) return;
    if (!picked || !mk) return;
    const d = draft();
    const key = JSON.stringify(d);
    if (!force && prepared && key === asked && prepared.action.deadline - Date.now() > 30_000) return;
    const open = !!sign.querySelector("details[open]");
    const my = ++seq;
    prepared = null;
    asked = key;
    btn.disabled = true;
    btn.title = LOOK;
    sign.innerHTML = "";
    clearInterval(tick);
    facts();
    // a tokenised asset its issuer has closed or keeps from being swapped: the issuer's words, and no button that would only be refused
    const shut = tkShut(item, mk);
    if (shut) {
      box.innerHTML = `<div class="msg no">${esc(shut)}</div>`;
      btn.title = shut;
      return;
    }
    const amount = Number(d.qty || d.usd);
    if (!(amount > 0) || (TK_LIMITED.includes(d.orderType) && !(Number(d.limitPrice) > 0)) || (TK_STOPPED.includes(d.orderType) && !(Number(d.stopPrice) > 0))) {
      box.innerHTML = `<div class="big"><span>${esc(mk.name)}</span><span>${mk.kind === "event" ? esc(tkCents(mk.price)) : mk.price ? `${esc(px(mk.price))} ${esc(mk.quote)}` : "no price"}</span></div><div class="path">${!(amount > 0) ? "Type an amount." : TK_LIMITED.includes(d.orderType) && !(Number(d.limitPrice) > 0) ? "Type the limit price." : "Type the stop price."}</div>`;
      return;
    }
    box.innerHTML = `<span class="dim">Asking ${esc(picked.venueName || nameOf(picked.venue))}…</span>`;
    const r = await Owner.prepare(d);
    if (!live() || my !== seq) return;
    if (r.status !== 200) return void (box.innerHTML = `<div class="msg no">${esc(Owner.why(r) || "Refused")}</div>${tkHowToFix(picked.venue, r)}`);
    prepared = r.body;
    box.innerHTML = `${tkOrderWords(prepared, mk)}<div class="left-t" data-left></div>`;
    sign.innerHTML = whatYouSign(prepared, { open });
    btn.disabled = !owns();
    left();
    tick = setInterval(left, 1000);
  };
  const later = (ms = 350) => {
    clearTimeout(timer);
    timer = setTimeout(requote, ms);
  };
  let rankTimer = 0;
  /* what is typed is kept in this browser (tkDraftKeep) while there is an amount or a price in it; placing it, or closing the ticket, drops it */
  const keep = () => {
    if (!item || !picked || !mk) return;
    const f = Object.fromEntries(new FormData(form).entries());
    if (!String(f.amount || "").trim() && !String(f.limitPrice || "").trim()) return void tkDraftKeep(null);
    tkDraftKeep({ variant: item.kind === "event" ? "predictions" : item.kind === "perp" ? "perps" : "trade", venue: picked.venue, venueName: picked.venueName || "", symbol: picked.symbol, side, outcome, kind: item.kind, key: item.key, base: item.base || "", name: item.name, amount: f.amount || "", unit: f.unit || "", orderType: f.orderType || "", limitPrice: f.limitPrice || "", stopPrice: f.stopPrice || "", tif: f.tif || "" });
  };
  form.addEventListener("input", (e) => {
    const n = e.target && e.target.name;
    if (n === "q" || n === "leverage" || n === "marginMode") return;
    keep();
    if (n === "amount" || n === "unit") {
      clearTimeout(rankTimer);
      rankTimer = setTimeout(rank, 600);
    }
    later();
  });
  form.addEventListener("change", (e) => {
    const n = e.target && e.target.name;
    if (n === "q" || n === "leverage" || n === "marginMode") return;
    keep();
    shape();
    later(0);
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!prepared || busy || !owns()) return;
    const p = prepared;
    btn.disabled = true;
    say(`Placing it at ${nameOf(p.action.venue)}…`, "wait");
    busy = true;
    document.body.classList.add("busy");
    let r;
    try {
      r = await Owner.submit(p);
    } finally {
      busy = false;
      document.body.classList.remove("busy");
    }
    if (!live()) return void load();
    if (refusedAt(r)) {
      say(Owner.why(r) || "Refused", "no");
      return void requote(true);
    }
    prepared = null;
    const o = r.body.kind === "order" ? r.body.order : null;
    let words = saidOf(r.body);
    let bad = false;
    if (o && o.walletTxs && !o.ref) {
      try {
        say("Waiting for your wallet…", "wait");
        await sendOrderFromWallet(o);
        words = said || words;
      } catch (err) {
        words = `${String((err && err.message) || err).slice(0, 200)}. It waits under Under way: “Send from wallet…”`;
        bad = true;
      }
    }
    if (bad) flash = words;
    else said = words;
    form.elements.amount.value = "";
    tkDraftKeep(null);
    say(words, bad ? "no" : "ok");
    await load();
    if (live()) requote(true);
  });
  q("[data-hand]").addEventListener("click", () => {
    const f = Object.fromEntries(new FormData(form).entries());
    openHandToAgent({ venue: picked ? picked.venue : preset.venue || "", symbol: picked ? picked.symbol : "", side, usd: f.unit === "usd" ? String(f.amount || "").trim() : "", name: item ? item.name : "" });
  });

  // ---- what the ticket was opened with ----
  if (preset.venue && preset.symbol) tkPresetItem(preset).then((x) => live() && x && pick(x, { venue: preset.venue, symbol: preset.symbol }));
  else {
    if (preset.symbol) form.elements.q.value = String(preset.symbol);
    search();
    // opened on purpose (the "t" key, a tile): the cursor goes to the search; the panel at rest takes no focus
    if (!preset.symbol && !preset.venue && !preset.rest) setTimeout(() => live() && form.elements.q.focus({ preventScroll: true }), 0);
  }
}

/* a Markets row's venues, in a few words */
const tkWhereWords = (x) => {
  const conn = x.at.filter((a) => a.connected);
  const pub = x.at.filter((a) => a.public);
  return [conn.length ? conn.map((a) => a.venueName).join(", ") : "", pub.length ? `${plural(pub.length, "public venue")}` : ""].filter(Boolean).join(" · ") || "—";
};

/** where a row is listed, as the ticket shows it: your accounts that can trade it (ranked by `compare` rows where the venues were compared —
 * the best first), the ones that cannot (with their words and how to fix it), the venues that publish it without a key ("Connect to trade") */
function tkWhereRows(item, ranked) {
  if (!item) return [];
  const rows = [];
  const seen = new Set();
  for (const r of ranked || []) {
    const v = A.venues.find((x) => x.id === r.venue);
    if (!v) continue;
    seen.add(r.venue);
    const able = canTrade(v) && r.canTrade !== false;
    rows.push(able ? { state: "able", venue: r.venue, venueName: r.venueName, symbol: r.symbol, price: r.price, best: !!r.best, closed: !r.open, worse: r.best ? 0 : r.worse, note: r.ready === false && r.open ? r.note || "" : "" } : { state: "off", venue: r.venue, venueName: r.venueName, why: tkWhyNot(v), how: tkHow(v) });
  }
  for (const a of item.at || []) {
    if (a.public) {
      if (a.connectTo && A.venues.some((v) => v.id === a.connectTo && v.live)) continue;
      rows.push({ state: "public", venue: a.venue, venueName: a.venueName, symbol: a.symbol, price: a.price, connector: a.connector, connectTo: a.connectTo, note: a.note || "" });
      continue;
    }
    if (seen.has(a.venue)) continue;
    const v = A.venues.find((x) => x.id === a.venue);
    if (!v) continue;
    seen.add(a.venue);
    const able = canTrade(v) && a.canTrade !== false;
    rows.push(able ? { state: "able", venue: a.venue, venueName: a.venueName, symbol: a.symbol, price: a.price, closed: a.open === false, note: a.note || "" } : { state: "off", venue: a.venue, venueName: a.venueName, why: a.note || tkWhyNot(v), how: tkHow(v) });
  }
  const order = { able: 0, off: 1, public: 2 };
  return rows.sort((x, y) => order[x.state] - order[y.state]);
}
/* a tokenised asset that takes no order now — its issuer closed it, or keeps it from being swapped (no order types) — in the issuer's words;
   "" for anything else, and for one that is open */
function tkShut(item, m) {
  if (!m || !((item && item.kind === "rwa") || m.issuer)) return "";
  const none = Array.isArray(m.types) && !m.types.length;
  if (m.open !== false && !none) return "";
  const iss = typeof mkIssuer === "function" && item ? mkIssuer(item) : null;
  const words = String(m.note || "").trim().replace(/[.\s]+$/, "") || (iss && iss.eligibility) || m.eligibility || "the issuer takes no order for it now";
  return `${none ? "No order for it here" : "Closed now"}${m.issuer ? ` · ${m.issuer}` : ""}: ${words}.`;
}
/* what to change at the venue so that its key trades */
const tkHow = (v) => (v.trade && v.trade.can === false && /^[a-z]/.test(v.id) && !v.address ? `${keyHowFor(v)} Then connect it again.` : "");
/* a refusal that says the key may not trade, with what to change at the venue */
function tkHowToFix(venue, r) {
  const v = A.venues.find((x) => x.id === venue);
  const code = r && r.body && r.body.refusal && r.body.refusal.code;
  if (!v || !/PERMISSION|KEY|SCOPE/.test(String(code || ""))) return "";
  return `<div class="path">${esc(keyHowFor(v))} Then connect it again.</div>`;
}

/** an order the account prepared, in words: how much, at what, what it may cost at most; an event contract's in cents with what it pays */
function tkOrderWords(p, m) {
  const a = p.action;
  const q = p.quote.order;
  const ev = q.kind === "event";
  const unit = UNITS[q.kind] || q.base;
  const at = (n) => (ev ? tkCents(n) : `${px(n)} ${q.quote}`);
  const how = a.orderType === "stop" ? `when the price reaches ${esc(at(a.stopPrice))}, at market` : a.orderType === "stop_limit" ? `when the price reaches ${esc(at(a.stopPrice))}, a limit at ${esc(at(a.limitPrice))}` : `at ${esc(at(a.limitPrice || q.price))}`;
  const flags = [a.tif ? TK_TIF_NAMES[a.tif] : "", a.postOnly ? "post-only" : "", a.reduceOnly ? "reduce-only" : ""].filter(Boolean).join(" · ");
  const n = Number(a.qty);
  const what = ev ? `${m && m.outcome ? m.outcome : q.name}` : unit === q.base ? q.base : `${unit} · ${q.base}`;
  return `<div class="big"><span>${a.side === "buy" ? "Buy" : "Sell"} ${esc(a.qty)} ${esc(ev ? `contracts · ${what}` : what)}</span><span>≈ ${money(q.notionalUsd)}</span></div><div class="path">${esc(q.name)} ${how}${(a.orderType === "market" || a.orderType === "stop") && a.side === "buy" ? ` · up to ${money(q.maxUsd)} if the price moves` : ""}</div>${ev && a.side === "buy" && n > 0 ? `<div class="path"><b>Pays ${money(n)}</b> if it happens (the most it can pay) · costs about ${money(q.notionalUsd)}</div>` : ""}${ev && a.side === "sell" && n > 0 ? `<div class="path">You get about ${money(q.notionalUsd)} for ${esc(plural(n, "contract"))} now, instead of $1.00 each if it happens.</div>` : ""}${flags ? `<div class="path">${esc(flags)}</div>` : ""}${q.note ? `<div class="path">${esc(q.note)}</div>` : ""}`;
}

/** a ticket opened on one market at one venue: the row it would be on Markets, with its outcomes (an event) and the other places it is listed */
async function tkPresetItem(preset) {
  const v = A.venues.find((x) => x.id === preset.venue);
  const body = await api(`/api/account/market?${new URLSearchParams({ venue: preset.venue, symbol: preset.symbol })}`, { ttl: 3_000 });
  if (!body || body.ok === false) {
    toast(refusalOf(body) || `${(v && v.name) || preset.venue} lists no ${preset.symbol}`, "no");
    return null;
  }
  const m = body.market;
  const kind = tkRowKind(m);
  const at = [{ venue: preset.venue, venueName: (v && v.name) || preset.venue, symbol: m.symbol, connected: true, canTrade: v && v.trade ? v.trade.can : false, public: false, price: m.price, open: m.open }];
  const x = { key: `${kind}:${m.base}`, kind, name: kind === "event" && m.group ? m.group.title : m.kind === "perp" ? m.name : m.base, base: kind === "event" ? undefined : m.base, price: m.price, changePct24h: m.changePct24h, closeTime: m.closeTime, category: m.category, fundingRate: m.fundingRate, at };
  if (kind === "event" && m.group) {
    // its other outcomes, as the venue lists them under the same question
    const sib = await api(`/api/account/markets?${new URLSearchParams({ venue: preset.venue, q: m.group.id })}`, { ttl: 30_000 });
    const outs = ((sib && sib.markets) || []).filter((s) => s.group && s.group.id === m.group.id);
    x.outcomes = (outs.length ? outs : [m]).map((s) => ({ label: s.outcome || s.name, price: s.price, bid: s.bid, ask: s.ask, at: [{ venue: preset.venue, symbol: s.symbol }] }));
    if (!preset.outcome) preset.outcome = m.outcome || "";
    return x;
  }
  if (kind !== "event" && m.base) {
    // where else it is listed: the public venues that publish it ("Connect to trade") and your other accounts
    const ex = await api(`/api/account/explore?${new URLSearchParams({ q: m.base, limit: "12" })}`, { ttl: 15_000 });
    const row = ((ex && ex.items) || []).find((r) => r.kind === kind && (r.base || "").toUpperCase() === String(m.base).toUpperCase());
    if (row) x.at = [...at, ...row.at.filter((a) => a.venue !== preset.venue)];
  }
  return x;
}

/** Connect to trade: the one short form for the connection the row names (connect.js connectVia), opened straight away */
function tkConnectTo(a) {
  if (!owns()) return void toast("This browser only looks: pair it to connect an account.", "no");
  if (!connectVia(a.connector, { name: a.venueName })) toast(`${a.venueName} can't be connected from this server.`, "no");
}

/** a perpetual's leverage from the ticket: prepared, shown field by field, then its own signature */
function tkLeverage(box, at, m, live) {
  const out = box.querySelector("[data-lev-sign]");
  box.querySelector("[data-lev-prep]").addEventListener("click", async () => {
    const lev = String(box.querySelector('input[name="leverage"]').value || "").trim();
    const mode = box.querySelector('select[name="marginMode"]').value;
    if (!/^\d{1,3}$/.test(lev) || !(Number(lev) >= 1)) return void (out.innerHTML = '<div class="msg no">Leverage is a whole number, 1 or more.</div>');
    out.innerHTML = '<span class="dim small">Asking…</span>';
    const r = await Owner.prepare({ type: "liveLeverage", venue: at.venue, symbol: m.symbol, leverage: lev, marginMode: mode });
    if (!live()) return;
    if (r.status !== 200) return void (out.innerHTML = `<div class="msg no">${esc(Owner.why(r) || "Refused")}</div>`);
    const p = r.body;
    out.innerHTML = `<div class="path">${esc(m.name)}: ${esc(lev)}x${mode ? `, ${esc(mode)}` : ""} at ${esc(at.venueName || nameOf(at.venue))}.</div>${whatYouSign(p, { open: true })}<button type="button" class="btn btn-sm" data-lev-go${owns() ? "" : " disabled"}>Sign leverage</button>`;
    out.querySelector("[data-lev-go]").addEventListener("click", async (e) => {
      e.target.disabled = true;
      const s = await Owner.submit(p);
      if (!live()) return;
      const res = s.body && s.body.result;
      if (!refusedAt(s)) {
        // the position's leverage and liquidation are read again
        TK.pos = null;
        if (A) render();
      }
      out.innerHTML = refusedAt(s) ? `<div class="msg no">${esc(Owner.why(s) || "Refused")}</div>` : `<div class="msg ok">${esc(m.name)}: ${esc(String((res && res.leverage) || lev))}x${res && res.marginMode ? `, ${esc(res.marginMode)}` : ""}</div>`;
    });
  });
}

// ---- under way, positions, fills ---------------------------------------------------------------

/* what is held is shown under every lens but a venue's: an agent's lens narrows what was done, not what is held */
const tkInVenue = (venue) => {
  const l = lensNow();
  return l.kind !== "venue" || l.id === venue;
};
/* cards for trading the owner answers here: an agent's order, its change, its close, money it puts to earn */
const tkTradeCard = (c) => /order|amend|close|earn|trade/i.test(String(c.kind || ""));
const tkCardVenue = (c) => ((c.shown || []).find((f) => f.name === "venue") || {}).value || "";
/* who did it, in a word: you, or an agent (and whether you approved it or it was inside its limit) */
const tkBy = (o) => (o.authority !== "agent" ? "You" : `${keyName(o.agent)}${o.card ? " · approved by you" : " · inside its limit"}`);

/** Under way: orders on a book or waiting for a wallet (Change, Cancel, Send from wallet), what agents asked to trade and waits for you
 * (Approve, Reject), money on its way and money going in or out of earn — in the lens */
function tkDrawOpen(sec, owner) {
  const orders = (A.orders || []).filter((o) => ["open", "partial", "pending"].includes(o.status) && inLens(o.venue, o.agent));
  const cards = A.cards.filter((c) => tkTradeCard(c) && inLens(tkCardVenue(c), c.agent));
  const pays = A.payments.filter((p) => p.live && ["pending", "authorized"].includes(p.status) && inLens(p.from, p.agent));
  const earns = (A.earns || []).filter((x) => x.status === "pending" && inLens(x.venue, x.agent));
  const cancellable = orders.filter((o) => !(o.walletTxs && !o.ref) && !o.canceling);
  const rows = [...cards.map((c) => ({ c })), ...orders.map((o) => ({ o })), ...pays.map((p) => ({ p })), ...earns.map((x) => ({ x }))];
  const n = rows.length;
  // where it is and who placed it: their own columns where the card has the room, else a line under the order (trade.css)
  const whereOf = (r) => (r.c ? nameOf(tkCardVenue(r.c)) || "—" : r.o ? r.o.venueName : r.p ? nameOf(r.p.from) : r.x.venueName);
  const byOf = (r) => (r.c ? r.c.agentName || "An agent" : r.o ? tkBy(r.o) : r.p ? tkBy(r.p) : tkBy(r.x));
  const byLine = (r) => { const b = byOf(r); return `by ${b === "You" || b === "An agent" ? b.toLowerCase() : b}`; };
  sec.innerHTML = `<div class="sec-head"><h2 class="h2" id="tp-open-h">Under way</h2><span class="tools">${n ? `<span class="dim small">${n}</span>` : ""}${owner && cancellable.length > 1 ? `<button type="button" class="link" data-cancel-all>Cancel all ${cancellable.length}</button>` : ""}</span></div>${table([
    { label: "Order", cell: (r) => `${tkOpenWhat(r)}<span class="why tp-wb-l">${esc(whereOf(r))} · ${esc(byLine(r))}</span>` },
    { label: "Where", cls: "tp-wb", cell: (r) => esc(whereOf(r)) },
    { label: "By", cls: "tp-by tp-wb", cell: (r) => esc(byOf(r)) },
    { label: "Status", cell: (r) => tkOpenStatus(r) },
    { label: "", r: true, cell: (r) => (owner ? tkOpenActs(r) : "") },
  ], rows, { empty: "Nothing under way. Orders on a book, and what an agent asks you to approve, show up here." })}`;
  const on = (sel, fn) => { for (const b of sec.querySelectorAll(sel)) b.addEventListener("click", () => fn(b)); };
  on("button[data-card]", (b) => {
    const c = A.cards.find((x) => x.id === b.dataset.card);
    if (c) own({ type: "approveCard", card: c.id, action: c.hash, decision: b.dataset.decision });
  });
  on("button[data-amend]", (b) => openAmend(A.orders.find((x) => x.id === b.dataset.amend)));
  on("button[data-cancel]", (b) => own({ type: "liveCancel", venue: b.dataset.venue, order: b.dataset.cancel }));
  const later = (fn) => async (b) => {
    b.disabled = true;
    try {
      await fn();
    } catch (err) {
      flash = String((err && err.message) || err).slice(0, 200);
    }
    await load();
  };
  on("button[data-order-send]", (b) => later(() => sendOrderFromWallet(A.orders.find((x) => x.id === b.dataset.orderSend)))(b));
  on("button[data-wallet-send]", (b) => later(async () => {
    const p = A.payments.find((x) => x.id === b.dataset.walletSend);
    const nat = p && p.legs[0].native;
    if (nat && nat.walletTx) await sendFromWallet(p, nat.walletTx, nat.walletTxs);
  })(b));
  const all = sec.querySelector("[data-cancel-all]");
  if (all) all.addEventListener("click", async () => {
    if (!(await confirmSheet(`Cancel all ${cancellable.length} open orders${lensNow().kind === "all" ? "" : ` in ${lensNow().name}`}? Each comes off its venue's book, one signature each.`, { title: "Cancel every open order", yes: `Cancel ${cancellable.length} orders`, no: "Keep them", danger: true }))) return;
    for (const o of cancellable) await own({ type: "liveCancel", venue: o.venue, order: o.id });
  });
}
function tkOpenWhat(r) {
  if (r.c) return `${esc(r.c.reason)}<details class="inl"><summary>details</summary><pre class="tk-pre">${esc(r.c.shown.map((f) => `${f.name}: ${f.value}`).join("\n"))}</pre></details>`;
  if (r.o) {
    const o = r.o;
    const ev = o.kind === "event";
    return `${o.side === "buy" ? "Buy" : "Sell"} ${esc(qtyOf(o.qty))} ${esc(ev ? "contracts" : o.contractSize ? "contracts" : o.base)} · ${esc(ev ? (o.type === "limit" ? `limit ${tkCents(o.limitPrice)}` : "market") : typeText(o))}<span class="why">${esc([o.name, o.filledQty ? `${qtyOf(o.filledQty)} filled` : "", o.id].filter(Boolean).join(" · "))}</span>`;
  }
  if (r.p) return `${esc(typeof whatOf === "function" ? whatOf(r.p) : `${r.p.kind} ${r.p.id}`)}<span class="why">${esc([money(r.p.amountUsd), r.p.note, r.p.id].filter(Boolean).join(" · "))}</span>`;
  const x = r.x;
  return `${x.kind === "withdraw" ? "Take out of" : "Put into"} ${esc(x.productName)} · ${esc(x.all ? "all" : qtyOf(x.amount))} ${esc(x.asset)}<span class="why">${esc([money(x.usd), x.note, x.id].filter(Boolean).join(" · "))}</span>`;
}
function tkOpenStatus(r) {
  if (r.c) return `<span class="tp-st warn-t">Waiting for you</span>${r.c.expiresAt ? `<span class="why">answer by ${esc(nyTime(r.c.expiresAt))}</span>` : ""}`;
  if (r.o) {
    const o = r.o;
    const note = o.note ? `<span class="why">${esc(o.note)}</span>` : "";
    if (o.canceling) return `<span class="tp-st dim">Canceling</span>${note}`;
    if (o.walletTxs && !o.ref) return `<span class="tp-st warn-t">Waiting for your wallet</span>${note}`;
    return `${o.status === "partial" ? '<span class="tp-st">Part filled</span>' : o.status === "pending" ? '<span class="tp-st dim">On the way</span>' : '<span class="tp-st">Open</span>'}${note}`;
  }
  if (r.p) return r.p.status === "authorized" ? '<span class="tp-st warn-t">Waiting for your wallet</span>' : '<span class="tp-st dim">On the way</span>';
  return '<span class="tp-st dim">On the way</span>';
}
function tkOpenActs(r) {
  if (r.c) return `<div class="acts"><button type="button" class="btn btn-sm btn-primary" data-card="${esc(r.c.id)}" data-decision="approve">Approve</button><button type="button" class="btn btn-sm" data-card="${esc(r.c.id)}" data-decision="reject">Reject</button></div>`;
  if (r.o) {
    const o = r.o;
    const waiting = o.walletTxs && !o.ref;
    const amendable = !waiting && !o.canceling && ((A.venues.find((x) => x.id === o.venue) || {}).trade || {}).amend;
    return `<div class="acts">${waiting ? `<button type="button" class="btn btn-sm" data-order-send="${esc(o.id)}"${INFLIGHT.has(o.clientId) ? " disabled" : ""}>${o.reported ? "Report again" : "Send from wallet…"}</button>` : ""}${amendable ? `<button type="button" class="btn btn-sm" data-amend="${esc(o.id)}">Change</button>` : ""}${o.canceling ? "" : `<button type="button" class="btn btn-sm" data-cancel="${esc(o.id)}" data-venue="${esc(o.venue)}">Cancel</button>`}</div>`;
  }
  if (r.p && r.p.status === "authorized") return `<div class="acts"><button type="button" class="btn btn-sm" data-wallet-send="${esc(r.p.id)}"${INFLIGHT.has(`${r.p.id}@${r.p.at}`) ? " disabled" : ""}>${r.p.live && r.p.live.reported ? "Report again" : "Send from wallet…"}</button></div>`;
  return "";
}

/** Positions at every venue that lists them (read again at most every ten seconds): what is held, entry, mark, liquidation, profit or loss,
 * and Close — a perpetual closed at the venue, an event contract's shares sold — each prepared and shown before you sign */
function tkDrawPositions(sec, owner, L) {
  if (!L.some((v) => v.trade && v.trade.positions)) return void (sec.hidden = true);
  sec.hidden = false;
  const draw = () => {
    if (!sec.isConnected) return;
    const got = TK.pos;
    const rows = got && got.positions ? got.positions.filter((p) => p.qty > 0 && tkInVenue(p.venue)) : [];
    const missing = got && got.missing ? got.missing.filter((m) => tkInVenue(m.venue)) : [];
    const ev = (p) => p.kind === "event";
    sec.innerHTML = `<div class="sec-head"><h2 class="h2" id="tp-pos-h">Positions</h2><span class="tools">${got && got.error ? `<span class="dim small">${esc(got.error)}</span>` : ""}</span></div>${!got ? '<div class="skel-rows" aria-hidden="true"><span class="skel"></span><span class="skel" style="width:70%"></span></div>' : table([
      { label: "Position", cell: (p) => `${esc(p.name)}<span class="why">${esc([p.side === "short" ? "short" : "long", `${qtyOf(p.qty)}${ev(p) ? " contracts" : ""}`, p.leverage ? `${p.leverage}x` : "", p.marginMode || ""].filter(Boolean).join(" · "))}</span><span class="why tp-px-l">${esc([p.entryPrice ? `Entry\u00a0${ev(p) ? tkCents(p.entryPrice) : px(p.entryPrice)}` : "", p.markPrice ? `Mark\u00a0${ev(p) ? tkCents(p.markPrice) : px(p.markPrice)}` : "", p.liquidationPrice ? `Liq.\u00a0${px(p.liquidationPrice)}` : ""].filter(Boolean).join(" · "))}</span>` },
      { label: "Where", cell: (p) => esc(p.venueName || nameOf(p.venue)) },
      { label: "Entry", r: true, cls: "tp-px", cell: (p) => (p.entryPrice ? esc(ev(p) ? tkCents(p.entryPrice) : px(p.entryPrice)) : "—") },
      { label: "Mark", r: true, cls: "tp-px", cell: (p) => (p.markPrice ? esc(ev(p) ? tkCents(p.markPrice) : px(p.markPrice)) : "—") },
      { label: "Liq.", r: true, cls: "tp-px", cell: (p) => (p.liquidationPrice ? esc(px(p.liquidationPrice)) : "—") },
      { label: "P&L", r: true, cell: (p) => chg(p.unrealizedUsd, "$") },
      { label: "", r: true, cell: (p) => {
        const v = A.venues.find((x) => x.id === p.venue);
        return owner && v && canTrade(v) ? `<button type="button" class="btn btn-sm" data-close="${esc(p.symbol)}" data-venue="${esc(p.venue)}">${ev(p) || p.kind === "stock" ? "Sell" : "Close"}</button>` : "";
      } },
    ], rows, { empty: "No open positions." })}${missing.map((m) => `<p class="dim small">${esc(m.venueName)} could not be read: ${esc(m.why)}</p>`).join("")}`;
    for (const b of sec.querySelectorAll("button[data-close]")) b.addEventListener("click", () => openClose(rows.find((p) => p.venue === b.dataset.venue && p.symbol === b.dataset.close)));
  };
  draw();
  if (!TK.pos || Date.now() - (TK.pos.at || 0) > 10_000) {
    api("/api/account/positions").then((body) => {
      TK.pos = body && body.ok !== false ? { at: Date.now(), positions: body.positions || [], missing: body.missing || [] } : { at: Date.now(), positions: (TK.pos && TK.pos.positions) || [], missing: [], error: refusalOf(body) || "The positions could not be read." };
      draw();
    });
  }
}

/* what the account says closing would be, as it prepared it: its worth at the worst price it may fill at, this server's cap for an order and
   whether it is over it, the side and the size. An account that does not say it gives null, and the close is shown as before */
const tkCloseQuote = (prep) => {
  const q = prep && prep.quote;
  const c = q && (q.close || q);
  return c && Number.isFinite(Number(c.worthUsd)) ? c : null;
};
/* the most of it one order may close on this server: the size scaled to the cap, a little under it (the price moves), in the market's own
   steps of a size (contracts whole); nothing when even the smallest order the venue takes would be over it */
function tkClosePart(qty, worthUsd, capUsd, whole, { step = 0, min = 0 } = {}) {
  if (!(qty > 0) || !(worthUsd > 0) || !(capUsd > 0)) return 0;
  const n = (Number(qty) * capUsd * 0.98) / worthUsd;
  const part = step > 0 ? Number((Math.floor(n / step + 1e-9) * step).toPrecision(12)) : whole ? Math.floor(n) : Math.floor(n * 1e6) / 1e6;
  return part > 0 && !(min > 0 && part < min) ? part : 0;
}
/* the close in words: the side and size, what it is worth at the worst price it may fill at, and the cap it is held to. `rules` the market's
   steps of a size, when read */
function tkCloseWords(prep, p, rules = {}) {
  const ev = p.kind === "event";
  const c = tkCloseQuote(prep);
  const pxOf = (n) => (ev ? tkCents(n) : px(n));
  const pnl = p.unrealizedUsd !== undefined ? ` · ${p.unrealizedUsd >= 0 ? "up" : "down"} ${money(Math.abs(p.unrealizedUsd))} now` : "";
  if (!c) return `<div class="big"><span>${esc(prep.action.qty ? `${p.side === "long" ? "Sell" : "Buy back"} ${prep.action.qty}` : `All ${qtyOf(p.qty)}`)}</span><span>${p.usd !== undefined ? `≈ ${money(prep.action.qty ? (p.usd * Number(prep.action.qty)) / p.qty : p.usd)}` : ""}</span></div><div class="path">${esc(p.name)} at ${esc(p.venueName || nameOf(p.venue))}, at market${pnl}</div>`;
  const n = c.qty !== undefined && c.qty !== "" ? Number(c.qty) : prep.action.qty ? Number(prep.action.qty) : p.qty;
  const part = c.overCap ? tkClosePart(n, Number(c.worthUsd), Number(c.capUsd), ev, rules) : 0;
  return `<div class="big"><span>${esc(c.side === "buy" ? "Buy back" : "Sell")} ${esc(qtyOf(n))}${ev ? " contracts" : ""}</span><span>≈ ${esc(money(c.worthUsd))}</span></div><div class="path">${esc(p.name)} at ${esc(p.venueName || nameOf(p.venue))}, at market${c.worstPrice !== undefined ? `, filled no worse than ${esc(pxOf(c.worstPrice))}` : ""}${esc(pnl)}</div>${c.capUsd ? `<div class="path">${c.overCap ? `One order may be worth up to ${esc(money(c.capUsd))} on this server.${part > 0 ? ` Close part of it instead: <button type="button" class="link" data-close-part="${esc(String(part))}">${esc(qtyOf(part))}${ev ? " contracts" : ""}</button>.` : ""}` : `Up to ${esc(money(c.capUsd))} an order on this server.`}</div>` : ""}`;
}
/* a close the account would refuse: worth more than this server lets one order be — in the account's words where it gave them. Said before
   the sign button, which stays off */
function tkCloseBlock(prep) {
  const c = tkCloseQuote(prep);
  if (!c || !c.overCap) return "";
  return c.why ? `${String(c.why).charAt(0).toUpperCase()}${String(c.why).slice(1)}.`.replace(/\.\.$/, ".") : `Worth about ${money(c.worthUsd)}: more than the ${money(c.capUsd)} one order may be on this server, so the account would refuse it. Close part of it.`;
}

/** CLOSE A POSITION, all of it or some — from Trade's Positions, Portfolio's Positions or the Asset drawer: the account prepares the close
 * and says what it is worth at the worst price it may fill at; one worth more than this server's cap for an order is refused here, before the
 * sign button, which stays off and says why (and a part that fits is one click away). What you sign is shown; your signature closes it */
function openClose(p) {
  if (!p) return;
  const ev = p.kind === "event";
  const sells = ev || p.kind === "stock";
  // the market's steps of a size, so a part offered is one the venue takes
  const rules = {};
  const q = quoteDialog({
    title: `${sells ? "Sell" : "Close"} ${p.name}`,
    sub: esc(`${p.venueName || nameOf(p.venue)} · ${p.side} ${qtyOf(p.qty)}${ev ? " contracts" : ""}${p.markPrice ? ` · now ${ev ? tkCents(p.markPrice) : px(p.markPrice)}` : ""}. At market: ${p.side === "short" ? "bought back" : "sold"}, and only ever down to nothing.`),
    fields: field("How much", `<input name="qty" inputmode="decimal" placeholder="All ${esc(qtyOf(p.qty))}" autocomplete="off" />`),
    draft: (form) => ({ type: "liveClose", venue: p.venue, symbol: p.symbol, qty: String(new FormData(form).get("qty") || "").trim() }),
    show: (prep) => tkCloseWords(prep, p, rules),
    block: (prep) => tkCloseBlock(prep),
    // what is held is read again everywhere it is shown, rather than kept
    done: () => {
      TK.pos = null;
      for (const path of ["/api/account/positions", "/api/account/holdings", "/api/account/asset"]) forget(path);
      return "";
    },
    go: sells ? "Sign and sell" : "Sign and close",
  });
  q.form.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("[data-close-part]");
    if (!b) return;
    q.form.elements.qty.value = b.dataset.closePart;
    q.requote();
  });
  api(`/api/account/market?${new URLSearchParams({ venue: p.venue, symbol: p.symbol })}`, { ttl: 30_000 }).then((b) => {
    const m = b && b.ok !== false && b.market;
    if (!m || !q.form.isConnected) return;
    Object.assign(rules, { step: Number(m.qtyStep) || 0, min: Number(m.minQty) || 0 });
    if (tkCloseQuote(q.prepared) && tkCloseQuote(q.prepared).overCap) q.requote();
  });
}

/** the latest fills: the statement's trade lines that filled, newest first, in the lens */
function tkDrawFills(sec) {
  const lines = (S || []).filter((l) => l.type === "trade" && ["filled", "partial"].includes(l.status) && inLens(l.account, l.agent)).slice(0, 8);
  sec.hidden = !lines.length;
  if (!lines.length) return;
  const amount = (l) => (typeof amountOf === "function" ? amountOf(l) : fine(l.amountUsd));
  sec.innerHTML = `<div class="sec-head"><h2 class="h2" id="tp-fills-h">Recent fills</h2><span class="tools"><button type="button" class="link" data-statement>Statement</button></span></div>${table([
    { label: "When", cls: "nw", cell: (l) => `${esc(nyDay(l.at))}<span class="why">${esc(nyTime(l.at))}</span>` },
    { label: "What", cell: (l) => `${esc(l.description)}${l.feeUsd ? `<span class="why">fee ${esc(fine(l.feeUsd))}</span>` : ""}` },
    { label: "Where", cls: "tp-fw", cell: (l) => esc(l.accountName) },
    { label: "Amount", r: true, cell: (l) => esc(amount(l)) },
    { label: "By", cls: "nw", cell: (l) => esc(l.agent ? l.agentName || keyName(l.agent) : "You") },
  ], lines)}`;
  sec.querySelector("[data-statement]").addEventListener("click", () => openStatement());
}

// ---- Sell many --------------------------------------------------------------------------------

/** one leg of Sell many as the owner signs it: a market sell of what is held there, or — a perpetual, a future — the position's close */
function tkSellDraft(item, qty) {
  const n = String(qty ?? "").trim();
  if (item.action === "close") return { type: "liveClose", venue: item.venue, symbol: item.symbol, qty: n && Number(n) < item.held ? n : "" };
  return { type: "liveOrder", venue: item.venue, symbol: item.symbol, side: "sell", orderType: "market", qty: n || String(item.sellQty), limitPrice: "", stopPrice: "", tif: "", postOnly: "", reduceOnly: "" };
}
const TK_MAX_LEGS = 10;

/** Sell many: everything held that is not a dollar, at each venue; pick up to ten, review what each would sign, then one signature each, in
 * turn, each leg's result as it comes back */
function tkSellMany(panel) {
  const gen = ++TK.gen;
  const live = () => gen === TK.gen && panel.isConnected;
  const cap = A.connectLive && A.connectLive.writes ? A.connectLive.writes.capUsd : 0;
  panel.innerHTML = `${tkHead("Sell many")}<p class="dim small">Everything you hold that isn't a dollar. Pick up to ${TK_MAX_LEGS}: each is its own order at market and its own signature${cap ? `, up to ${money(cap)} each` : ""}.</p><div class="tk-stack" data-sm><div class="skel-rows" aria-hidden="true"><span class="skel"></span><span class="skel"></span><span class="skel" style="width:60%"></span></div></div>`;
  tkWireHead(panel);
  const box = panel.querySelector("[data-sm]");
  let items = [];
  const pickList = () => {
    const owner = owns();
    box.innerHTML = `<form class="tk-form" novalidate><ul class="tk-sm" role="list">${items.map((x, i) => `<li class="tk-sm-row${x.ready ? "" : " off"}"><label class="chk1"><input type="checkbox" name="pick" value="${i}"${x.ready ? "" : " disabled"} /><span class="sr">Sell ${esc(x.asset)} at ${esc(x.venueName)}</span></label><span class="tk-rn"><b>${esc(tkLegName(x))}</b><span class="dim small">${esc(`${x.venueName} · ${qtyOf(x.held)} held${x.usd !== undefined ? ` · ≈ ${money(x.usd)}` : ""}`)}</span>${x.why ? `<span class="why">${esc(x.why)}</span>` : ""}</span>${x.ready ? `<input class="tk-sm-q" name="q${i}" inputmode="decimal" value="${esc(String(x.sellQty))}" aria-label="How much ${esc(x.asset)} to sell" />` : ""}</li>`).join("")}</ul><div class="msg" data-msg role="status"></div><button type="submit" class="btn btn-primary btn-block" data-review disabled>Review</button></form>`;
    const form = box.querySelector("form");
    const btn = box.querySelector("[data-review]");
    const count = () => {
      const n = form.querySelectorAll('input[name="pick"]:checked').length;
      btn.disabled = !n || n > TK_MAX_LEGS;
      btn.textContent = n > TK_MAX_LEGS ? `At most ${TK_MAX_LEGS} at once` : n ? `Review ${plural(n, "sale")}` : "Review";
    };
    form.addEventListener("change", count);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const f = new FormData(form);
      const legs = f.getAll("pick").map(Number).slice(0, TK_MAX_LEGS).map((i) => ({ item: items[i], draft: tkSellDraft(items[i], f.get(`q${i}`)) }));
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
    box.innerHTML = `<ol class="tk-legs">${legs.map((l) => `<li>${l.prepared ? `<div class="quote real">${tkLegWords(l)}</div>${whatYouSign(l.prepared)}` : `<div><b>${esc(tkLegName(l.item))}</b> · ${esc(l.item.venueName)}</div><div class="msg no">${esc(l.why)}</div>`}</li>`).join("")}</ol><div class="msg" data-msg role="status"></div><div class="end"><button type="button" class="btn" data-back>Back</button><button type="button" class="btn btn-primary" data-sign${ok.length && owns() ? "" : " disabled"}>Sign and sell ${ok.length}</button></div>`;
    box.querySelector("[data-back]").addEventListener("click", pickList);
    box.querySelector("[data-sign]").addEventListener("click", () => run(ok));
  };
  /* one signature each, in turn: a leg whose ten minutes ran out is prepared again first; a DEX sale goes to the wallet */
  const run = async (legs) => {
    if (busy) return;
    busy = true;
    document.body.classList.add("busy");
    box.innerHTML = `<ol class="tk-legs" data-res>${legs.map((l, i) => `<li data-leg="${i}"><div><b>${esc(tkLegName(l.item))}</b> · ${esc(l.item.venueName)}</div><span class="dim small">waiting</span></li>`).join("")}</ol><div class="end"><button type="button" class="btn" data-done disabled>Done</button></div>`;
    const mark = (i, html) => {
      const li = box.querySelector(`[data-leg="${i}"]`);
      if (li) li.innerHTML = `<div><b>${esc(tkLegName(legs[i].item))}</b> · ${esc(legs[i].item.venueName)}</div>${html}`;
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
    TK.pos = null;
    const d = box.querySelector("[data-done]");
    if (d) {
      d.disabled = false;
      d.addEventListener("click", () => tkSellMany(panel));
    }
    await load();
  };
  api("/api/account/sellable").then((body) => {
    if (!live()) return;
    if (!body || body.ok === false) return void (box.innerHTML = `<div class="msg no">${esc(refusalOf(body) || "What is held could not be read.")}</div>`);
    items = (body.items || []).filter((x) => tkInVenue(x.venue));
    const missing = (body.missing || []).map((m) => `<p class="dim small">${esc(m.venueName)} could not be read: ${esc(m.why)}</p>`).join("");
    if (!items.length) return void (box.innerHTML = `<p class="empty">Nothing to sell: everything here is in dollars.</p>${missing}`);
    pickList();
    if (missing) box.insertAdjacentHTML("beforeend", missing);
  });
}
/* a holding to sell, by name: a position says it is closed */
const tkLegName = (x) => (x.action === "close" ? `Close ${x.side || ""} ${x.asset}`.replace(/\s+/g, " ") : x.asset);
/* one prepared leg, in words */
function tkLegWords(l) {
  const p = l.prepared;
  if (p.action.type === "liveClose") return `<div class="big"><span>Close ${esc(p.action.qty || `all ${qtyOf(l.item.held)}`)} · ${esc(l.item.asset)}</span><span>${l.item.usd !== undefined ? `≈ ${money(l.item.usd)}` : ""}</span></div><div class="path">${esc(l.item.venueName)} · at market, it only shrinks the position</div>`;
  const q = p.quote.order;
  return `<div class="big"><span>${esc(q.words)}</span><span>≈ ${money(q.notionalUsd)}</span></div><div class="path">${esc(l.item.venueName)} · at market${q.note ? ` · ${esc(q.note)}` : ""}</div>`;
}

// ---- Swap ---------------------------------------------------------------------------------------

/** How a swap goes at one venue, from what it lists: one stablecoin for another by the venue's own convert (`convert`, a liveMove swap); a
 * dollar into a coin (`buy`) or a coin into a dollar (`sell`), one order; a coin into another coin (`two`): sold for the dollar both
 * markets share, then bought with what the sale brought — two orders, two signatures. `markets` are the venue's (GET /markets), `chain` the
 * chain the coin is held on (a wallet) */
function tkSwapPlan({ venue, from, to, amount, markets, chain = "", stableSwap = false }) {
  const F = String(from || "").toUpperCase();
  const T = String(to || "").toUpperCase();
  const amt = String(amount || "").trim();
  if (!F || !T) return { mode: "", why: "Pick what to swap and what for." };
  if (F === T) return { mode: "", why: "Pick two different assets." };
  const onChain = (m) => !chain || !m.symbol.includes("@") || m.symbol.endsWith(`@${chain}`);
  const spotLike = (m) => ["spot", "token", "crypto"].includes(m.kind) && m.open !== false;
  const find = (base, quote) => (markets || []).find((m) => spotLike(m) && String(m.base).toUpperCase() === base && (!quote ? tkDollar(m.quote) : String(m.quote).toUpperCase() === quote) && onChain(m));
  if (tkDollar(F) && tkDollar(T)) {
    if (stableSwap) return { mode: "convert", legs: [{ type: "liveMove", kind: "swap", from: venue, to: venue, fromLedger: "", toLedger: "", asset: F, toAsset: T, network: "", amount: amt }] };
    return { mode: "", why: "This venue doesn't swap one stablecoin for another from here." };
  }
  const order = (m, side, size) => ({ type: "liveOrder", venue, symbol: m.symbol, side, orderType: "market", ...size, limitPrice: "", stopPrice: "", tif: "", postOnly: "", reduceOnly: "" });
  if (tkDollar(F)) {
    const m = find(T, F);
    return m ? { mode: "buy", legs: [order(m, "buy", { usd: amt })], market: m } : { mode: "", why: `${T} isn't listed against ${F} here${find(T) ? ` (it trades against ${find(T).quote})` : ""}.` };
  }
  if (tkDollar(T)) {
    const m = find(F, T);
    return m ? { mode: "sell", legs: [order(m, "sell", { qty: amt })], market: m } : { mode: "", why: `${F} isn't listed against ${T} here${find(F) ? ` (it trades against ${find(F).quote})` : ""}.` };
  }
  const first = find(F);
  if (!first) return { mode: "", why: `${F} has no dollar market here.` };
  const second = find(T, String(first.quote).toUpperCase());
  if (!second) return { mode: "", why: `${T} isn't listed against ${first.quote} here, so it can't be bought with what selling ${F} brings.` };
  return { mode: "two", legs: [order(first, "sell", { qty: amt }), order(second, "buy", { usd: "" })], market: first, then: second, via: first.quote };
}
/* what a filled sale brought, in its quote currency, less its fee, down to the cent: what the second leg of a swap spends */
const tkProceeds = (o) => Math.floor(Math.max(0, Number(o.filledQty || 0) * Number(o.avgPrice || o.price || 0) - Number(o.feeUsd || 0)) * 100) / 100;

/** Swap at one venue: a stablecoin for another (the venue's convert), a dollar for a coin or a coin for a dollar (one order), or a coin for
 * another coin — two orders through the dollar both trade against: the sale first; once it has filled, the buy, prepared from what the
 * sale brought and shown before its own signature */
function tkSwap(panel, preset) {
  const gen = ++TK.gen;
  const live = () => gen === TK.gen && panel.isConnected;
  const vs = connected().filter((v) => tkStableSwap(v) || (canTrade(v) && tkKinds(v).some((k) => ["spot", "token", "crypto"].includes(k))));
  if (!vs.length) return void tkOpen({});
  const start = vs.find((v) => v.id === preset.venue) || vs.find((v) => tkKinds(v).includes("token") && canTrade(v)) || vs[0];
  panel.innerHTML = `${tkHead("Swap")}<form class="tk-form" novalidate autocomplete="off">
    <label class="fld">Where${select("venue", vs.map((v) => [v.id, v.name]), start.id)}</label>
    <div class="row2"><label class="fld">From<select name="from"></select></label><label class="fld">To<input name="to" list="tk-swap-to-${gen}" placeholder="USDC, ETH…" spellcheck="false" /><datalist id="tk-swap-to-${gen}"></datalist></label></div>
    <div class="row2"><label class="fld"><span data-amt-l>Amount</span><input name="amount" inputmode="decimal" placeholder="10" /></label><div class="tk-max"><button type="button" class="link" data-max>Max</button><span class="dim small" data-held></span></div></div>
    <div class="quote real" data-q><span class="dim">Pick what to swap.</span></div>
    <div data-sign></div>
    <div class="msg" data-msg role="status"></div>
    <button type="submit" class="btn btn-primary btn-block" data-go disabled>Sign and swap</button>
  </form>`;
  tkWireHead(panel);
  const form = panel.querySelector("form");
  const q = (s) => form.querySelector(s);
  const box = q("[data-q]");
  const sign = q("[data-sign]");
  const btn = q("[data-go]");
  const msg = q("[data-msg]");
  const say = (text, state = "") => {
    msg.className = `msg${text && state ? ` ${state}` : ""}`;
    msg.textContent = text || "";
  };
  let plan = null;
  let prepared = null;
  // the second leg of a coin-for-coin swap, once its sale has filled: { then, usd, sold }
  let second = null;
  let held = [];
  let markets = [];
  let seq = 0;
  let timer = 0;
  const venue = () => A.venues.find((v) => v.id === form.elements.venue.value);
  /* what can be swapped from here: what the venue holds, each chain or ledger apart; and what it lists to swap into */
  const holdings = () => (venue().holdings || []).filter((h) => h.amount > 0 && !h.inTransit && h.class !== "event");
  const fill = async () => {
    const v = venue();
    held = holdings();
    form.elements.from.innerHTML = held.map((h) => `<option value="${esc(`${h.asset}|${h.note || ""}`)}">${esc(h.asset)}${h.note ? ` · ${esc(h.note)}` : ""} — ${esc(qtyOf(h.amount))}</option>`).join("") || '<option value="">Nothing held here</option>';
    const body = await api(`/api/account/markets?${new URLSearchParams({ venue: v.id, q: "" })}`, { ttl: 60_000 });
    if (!live()) return;
    markets = (body && body.markets) || [];
    const into = [...new Set([...markets.filter((m) => ["spot", "token", "crypto"].includes(m.kind)).map((m) => m.base), ...markets.map((m) => m.quote).filter(tkDollar), ...(tkStableSwap(v) ? ["USDC", "USDT"] : [])])];
    q(`#tk-swap-to-${gen}`).innerHTML = into.map((b) => `<option value="${esc(b)}"></option>`).join("");
    later(0);
  };
  /* what is picked to swap from, as the venue holds it now (the page read again since) */
  const fromRow = () => {
    held = holdings();
    return held.find((h) => `${h.asset}|${h.note || ""}` === form.elements.from.value) || null;
  };
  /* an asset typed that the first listing did not hold: the venue's markets for it, once */
  const more = async (text) => {
    if (!text || markets.some((m) => String(m.base).toUpperCase() === text.toUpperCase())) return;
    const body = await api(`/api/account/markets?${new URLSearchParams({ venue: venue().id, q: text })}`, { ttl: 60_000 });
    if (!live() || !body || !body.markets) return;
    markets = [...markets, ...body.markets.filter((m) => !markets.some((x) => x.symbol === m.symbol))];
  };
  const showFirst = (p, v, thenWords) => {
    box.innerHTML = `${plan.mode === "convert" ? `<div class="big"><span>${esc(p.action.amount)} ${esc(p.action.asset)} → ${esc(p.action.toAsset)}</span><span>fee up to ${esc(p.action.maxFee)} ${esc(p.action.asset)}</span></div><div class="path">${esc(v.name)}'s own convert, at once. Can't be undone.</div>` : `${plan.mode === "two" ? '<div class="path"><b>1 · first</b></div>' : ""}${tkOrderWords(p, plan.market)}`}${thenWords}${p.action.deadline ? '<div class="left-t">Your signature is good for 10 minutes.</div>' : ""}`;
  };
  const requote = async () => {
    if (!live() || second) return;
    const my = ++seq;
    prepared = null;
    btn.disabled = true;
    btn.textContent = "Sign and swap";
    sign.innerHTML = "";
    const f = fromRow();
    const to = String(form.elements.to.value || "").trim();
    q("[data-held]").textContent = f ? `${qtyOf(f.amount)} ${f.asset} here` : "";
    q("[data-amt-l]").textContent = f ? `Amount (${f.asset})` : "Amount";
    if (!f || !to) return void (box.innerHTML = '<span class="dim">Pick what to swap and what for.</span>');
    await more(to);
    if (!live() || my !== seq) return;
    const v = venue();
    plan = tkSwapPlan({ venue: v.id, from: f.asset, to, amount: form.elements.amount.value, markets, chain: tkKinds(v).includes("token") ? f.note : "", stableSwap: tkStableSwap(v) });
    if (!plan.mode) return void (box.innerHTML = `<div class="msg no">${esc(plan.why)}</div>`);
    if (!(Number(form.elements.amount.value) > 0)) return void (box.innerHTML = `<div class="path">${esc(tkSwapHow(plan, f.asset, to.toUpperCase()))}</div><div class="path">Type an amount.</div>`);
    box.innerHTML = `<span class="dim">Asking ${esc(v.name)}…</span>`;
    const first = await Owner.prepare(plan.legs[0]);
    if (!live() || my !== seq) return;
    if (first.status !== 200) return void (box.innerHTML = `<div class="msg no">${esc(Owner.why(first) || "Refused")}</div>`);
    let thenWords = "";
    if (plan.mode === "two") {
      // the buy as it would be if the sale brought what it is worth now: an estimate; it is prepared again, and signed, once the sale fills
      const est = Math.floor(Number(first.body.quote.order.notionalUsd) * 100) / 100;
      const r2 = await Owner.prepare({ ...plan.legs[1], usd: String(est) });
      if (!live() || my !== seq) return;
      thenWords = `<div class="path"><b>2 · then</b> ${r2.status === 200 ? `${esc(r2.body.quote.order.words)}, with about ${money(est)} of ${esc(plan.via)}: sized by what the sale brings, prepared and signed once it has filled.` : `buy ${esc(to.toUpperCase())}: ${esc(Owner.why(r2) || "refused")}`}</div>`;
    }
    prepared = first.body;
    showFirst(prepared, v, thenWords);
    sign.innerHTML = whatYouSign(prepared);
    btn.textContent = plan.mode === "two" ? "Sign the sale (1 of 2)" : "Sign and swap";
    btn.disabled = !owns();
    // a signature is good for ten minutes: asked again when they run out
    clearTimeout(timer);
    if (prepared.action.deadline) timer = setTimeout(requote, Math.max(1000, prepared.action.deadline - Date.now()));
  };
  const later = (ms = 350) => {
    clearTimeout(timer);
    timer = setTimeout(requote, ms);
  };
  /* the buy, from what the sale brought: prepared, shown, signed on its own */
  const prepSecond = async () => {
    btn.disabled = true;
    sign.innerHTML = "";
    const v = venue();
    const done = `<div class="path"><b>1 · done</b> ${esc(saidOf({ kind: "order", order: second.sold }))} — it brought ${money(second.usd)}.</div>`;
    box.innerHTML = `${done}<span class="dim">Asking ${esc(v.name)} for the buy…</span>`;
    const r = await Owner.prepare({ type: "liveOrder", venue: v.id, symbol: second.then.symbol, side: "buy", orderType: "market", usd: String(second.usd), limitPrice: "", stopPrice: "", tif: "", postOnly: "", reduceOnly: "" });
    if (!live()) return;
    if (r.status !== 200) return void (box.innerHTML = `${done}<div class="msg no">${esc(Owner.why(r) || "Refused")}</div>`);
    prepared = r.body;
    box.innerHTML = `${done}<div class="path"><b>2 · now</b></div>${tkOrderWords(prepared, second.then)}`;
    sign.innerHTML = whatYouSign(prepared, { open: true });
    btn.textContent = "Sign the buy (2 of 2)";
    btn.disabled = !owns();
    clearTimeout(timer);
    if (prepared.action.deadline) timer = setTimeout(() => second && prepSecond(), Math.max(1000, prepared.action.deadline - Date.now()));
  };
  form.addEventListener("input", (e) => (e.target.name === "venue" ? null : later()));
  form.addEventListener("change", (e) => (e.target.name === "venue" ? fill() : later(0)));
  q("[data-max]").addEventListener("click", () => {
    const f = fromRow();
    if (f) form.elements.amount.value = String(f.amount);
    later(0);
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!prepared || busy || !owns()) return;
    const p = prepared;
    const leg = second ? 2 : 1;
    const mode = plan.mode;
    btn.disabled = true;
    say("Signing…", "wait");
    busy = true;
    document.body.classList.add("busy");
    let r;
    try {
      r = await Owner.submit(p);
    } finally {
      busy = false;
      document.body.classList.remove("busy");
    }
    if (!live()) return void load();
    if (refusedAt(r)) {
      say(Owner.why(r) || "Refused", "no");
      return void (second ? prepSecond() : later(0));
    }
    let o = r.body.kind === "order" ? r.body.order : null;
    if (o && o.walletTxs && !o.ref) {
      try {
        say("Waiting for your wallet…", "wait");
        await sendOrderFromWallet(o);
      } catch (err) {
        flash = `${String((err && err.message) || err).slice(0, 200)}. It waits under Under way: “Send from wallet…”`;
        say(flash, "no");
        return void load();
      }
    }
    if (leg === 2 || mode !== "two") {
      said = leg === 2 ? `Swapped: ${saidOf(r.body)}` : saidOf(r.body) || (r.body.payment ? r.body.payment.note || "Swapped" : "Done");
      say(said, "ok");
      second = null;
      for (const el of form.querySelectorAll("input, select")) el.disabled = false;
      form.elements.amount.value = "";
      await load();
      if (live()) later(0);
      return;
    }
    // the sale went: the buy waits for it to fill, then is prepared from what it brought and shown before its own signature
    for (const el of form.querySelectorAll("input, select")) el.disabled = true;
    say(`${saidOf(r.body)}. Waiting for the sale to fill…`, "wait");
    o = await tkFilled(o, live);
    if (!live()) return;
    if (!o || !["filled", "partial"].includes(o.status) || !(o.filledQty > 0)) {
      for (const el of form.querySelectorAll("input, select")) el.disabled = false;
      flash = `${o ? `${o.id} is ${o.status}` : "The sale has not filled yet"}: the buy waits. It is under Under way; swap again once it fills.`;
      say(flash, "no");
      return void load();
    }
    second = { then: plan.then, usd: tkProceeds(o), sold: o };
    say("", "");
    await load();
    if (live()) prepSecond();
  });
  fill();
}
/* a swap's plan in words, before an amount */
const tkSwapHow = (plan, from, to) => (plan.mode === "convert" ? `${from} → ${to} by the venue's own convert.` : plan.mode === "buy" ? `Buys ${to} with ${from} at market (${plan.market.symbol}).` : plan.mode === "sell" ? `Sells ${from} for ${to} at market (${plan.market.symbol}).` : `Two orders: sells ${from} for ${plan.via} (${plan.market.symbol}), then buys ${to} with what that brings (${plan.then.symbol}) — two signatures.`);

/** a sale's fill, asked of the account every two seconds for up to a minute and a half */
async function tkFilled(o, live) {
  const until = Date.now() + 90_000;
  let now = o;
  while (live() && Date.now() < until) {
    if (now && ["filled", "canceled", "rejected", "expired"].includes(now.status)) return now;
    await new Promise((res) => setTimeout(res, 2000));
    const page = await fetch("/api/account").then((x) => x.json()).catch(() => null);
    now = page ? (page.orders || []).find((x) => x.id === o.id) || now : now;
  }
  return now;
}

// ---- Earn ---------------------------------------------------------------------------------------

/** the products Earn lists: to put money in, those the venue says take it now first (the others with their reason); to take it out, those
 * something is in */
function tkEarnList(view, kind) {
  const held = (p) => view.positions.some((h) => h.venue === p.venue && h.product === p.id && h.amount > 0);
  return kind === "withdraw" ? view.products.filter(held) : [...view.products.filter((p) => p.canSupply), ...view.products.filter((p) => !p.canSupply)];
}
/* money into or out of one product, as the account prepares it: the product's own asset, the amount typed */
const tkEarnDraft = (p, kind, amount) => ({ type: "liveEarn", venue: p.venue, kind: kind === "withdraw" ? "withdraw" : "supply", product: p.id, asset: p.asset, amount: String(amount ?? "").trim() });
/* a yield as the venue states it: 5.2% APY, or a range */
const tkRate = (x) => (x.apy === undefined ? "" : `${(x.apy * 100).toFixed(2)}%${x.apyHigh !== undefined ? `–${(x.apyHigh * 100).toFixed(2)}%` : ""} ${(x.rateKind || "apy").toUpperCase()}`);

/** Earn: the products the connected venues offer (a vault through the MetaMask Agent Wallet, an exchange's flexible savings), what is in
 * them, and money in or out — prepared by the account (the product, its yield and lock, where money taken out lands), shown, and signed */
function tkEarn(panel, preset) {
  const gen = ++TK.gen;
  const live = () => gen === TK.gen && panel.isConnected;
  panel.innerHTML = `${tkHead("Earn")}<div class="tk-stack" data-earn><div class="skel-rows" aria-hidden="true"><span class="skel"></span><span class="skel"></span><span class="skel" style="width:60%"></span></div></div>`;
  tkWireHead(panel);
  const root = panel.querySelector("[data-earn]");
  let kind = preset.side === "withdraw" ? "withdraw" : "supply";
  let view = null;
  let chosen = "";
  const draw = () => {
    const products = tkEarnList(view, kind);
    const held = (p) => view.positions.find((h) => h.venue === p.venue && h.product === p.id);
    if (!chosen || !products.some((p) => `${p.venue}|${p.id}` === chosen)) chosen = products.length ? `${products[0].venue}|${products[0].id}` : "";
    const refusing = view.venues.filter((v) => v.can === false).map((v) => `<p class="dim small">${esc(v.venueName)}: ${esc(v.whyNot || "this key can't put money to earn")}</p>`).join("");
    const missing = view.missing.map((m) => `<p class="dim small">${esc(m.venueName)} could not be read: ${esc(m.why)}</p>`).join("");
    root.innerHTML = `<div data-kind></div>${products.length ? `<div class="tk-where" role="group" aria-label="Product">${products.slice(0, 12).map((p) => `<button type="button" class="tk-at" data-prod="${esc(`${p.venue}|${p.id}`)}" aria-pressed="${String(`${p.venue}|${p.id}` === chosen)}"><span><b>${esc(p.name)}</b><span class="why">${esc([p.venueName, p.asset, p.protocol, p.chain, p.lockDays ? `locked ${p.lockDays} days` : p.lockDays === 0 ? "out at once" : "", held(p) ? `in it: ${qtyOf(held(p).amount)} ${held(p).asset}` : ""].filter(Boolean).join(" · "))}</span>${p.canSupply || kind === "withdraw" ? "" : `<span class="why">${esc(p.why || "not taking money now")}</span>`}</span><span class="tab-nums tk-at-r">${esc(tkRate(p))}</span></button>`).join("")}</div>` : `<p class="empty">${kind === "supply" ? "No product takes money from here right now." : "Nothing is earning to take out."}</p>`}<form class="tk-form" novalidate autocomplete="off"${products.length ? "" : " hidden"}><div class="row2"><label class="fld"><span data-amt-l>Amount</span><input name="amount" inputmode="decimal" placeholder="25" /></label><div class="tk-max"><button type="button" class="link" data-max>Max</button><span class="dim small" data-have></span></div></div><div class="quote real" data-q><span class="dim">Type an amount.</span></div><div data-sign></div><div class="msg" data-msg role="status"></div><button type="submit" class="btn btn-primary btn-block" data-go disabled>${kind === "supply" ? "Sign and put in" : "Sign and take out"}</button></form>${view.positions.length ? `<div class="label">Earning now</div><ul class="tk-earning">${view.positions.map((h) => `<li><span>${esc(h.name || h.product)} <span class="dim small">${esc(h.venueName)}</span></span><span class="tab-nums">${esc(qtyOf(h.amount))} ${esc(h.asset)}${h.usd !== undefined ? ` · ${money(h.usd)}` : ""}${h.apy !== undefined ? ` · ${esc((h.apy * 100).toFixed(2))}%` : ""}</span></li>`).join("")}</ul>` : ""}${refusing}${missing}`;
    root.querySelector("[data-kind]").innerHTML = seg([["supply", "Put in"], ["withdraw", "Take out"]], kind, (v) => {
      kind = v;
      draw();
    }, { label: "Put in or take out" });
    for (const b of root.querySelectorAll("button[data-prod]")) b.addEventListener("click", () => {
      chosen = b.dataset.prod;
      for (const x of root.querySelectorAll("button[data-prod]")) x.setAttribute("aria-pressed", String(x === b));
      later(0);
    });
    const form = root.querySelector("form");
    if (!products.length) return;
    const product = () => products.find((p) => `${p.venue}|${p.id}` === chosen);
    const have = () => {
      const p = product();
      if (!p) return 0;
      if (kind === "withdraw") return held(p) ? held(p).amount : 0;
      const v = A.venues.find((x) => x.id === p.venue);
      return ((v && v.holdings) || []).filter((h) => h.asset.toUpperCase() === p.asset.toUpperCase() && !h.inTransit).reduce((s, h) => s + h.amount, 0);
    };
    const q = (s) => form.querySelector(s);
    const box = q("[data-q]");
    const sign = q("[data-sign]");
    const btn = q("[data-go]");
    const msg = q("[data-msg]");
    let prepared = null;
    let seq = 0;
    let timer = 0;
    let tick = 0;
    const left = () => {
      const el = box.querySelector("[data-left]");
      if (!live() || !prepared || !el) return void clearInterval(tick);
      const ms = prepared.action.deadline - Date.now();
      if (ms <= 0) return void requote();
      el.textContent = `Your signature is good for ${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")} more.`;
    };
    const requote = async () => {
      if (!live() || !form.isConnected) return;
      const my = ++seq;
      prepared = null;
      btn.disabled = true;
      sign.innerHTML = "";
      clearInterval(tick);
      const p = product();
      if (!p) return;
      q("[data-amt-l]").textContent = `Amount (${p.asset})`;
      q("[data-have]").textContent = `${qtyOf(have())} ${p.asset} ${kind === "withdraw" ? "in it" : "at " + p.venueName}`;
      const amount = String(form.elements.amount.value || "").trim();
      if (!(Number(amount) > 0)) return void (box.innerHTML = `<div class="big"><span>${esc(p.name)}</span><span>${esc(tkRate(p))}</span></div><div class="path">${esc(`Money taken out lands in ${p.lands}.`)}${p.minAmount ? ` · at least ${esc(qtyOf(p.minAmount))} ${esc(p.asset)}` : ""}</div><div class="path">Type an amount.</div>`);
      box.innerHTML = `<span class="dim">Asking ${esc(p.venueName)}…</span>`;
      const r = await Owner.prepare(tkEarnDraft(p, kind, amount));
      if (!live() || my !== seq) return;
      if (r.status !== 200) return void (box.innerHTML = `<div class="msg no">${esc(Owner.why(r) || "Refused")}</div>`);
      prepared = r.body;
      const x = prepared.quote.earn;
      box.innerHTML = `<div class="big"><span>${esc(x.words)}</span><span>≈ ${money(x.usd)}</span></div><div class="path">${esc([tkRate(x), x.lockDays ? `locked ${x.lockDays} days after you ask for it back` : x.lockDays === 0 ? "out at once" : "", x.protocol, x.chain].filter(Boolean).join(" · "))}</div><div class="path"><b>Taken out, it lands in</b> ${esc(x.lands)}</div>${x.held ? `<div class="path">In it now: ${esc(qtyOf(x.held.amount))} ${esc(x.held.asset)}${x.held.usd !== undefined ? ` (${money(x.held.usd)})` : ""}</div>` : ""}${x.note ? `<div class="path">${esc(x.note)}</div>` : ""}<div class="path">Up to ${money(x.capUsd)} a movement.</div><div class="left-t" data-left></div>`;
      sign.innerHTML = whatYouSign(prepared);
      btn.disabled = !owns();
      left();
      tick = setInterval(left, 1000);
    };
    const later = (ms = 350) => {
      clearTimeout(timer);
      timer = setTimeout(requote, ms);
    };
    form.addEventListener("input", () => later());
    q("[data-max]").addEventListener("click", () => {
      form.elements.amount.value = String(have() || "");
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
      await load();
      if (live()) tkEarn(panel, { side: kind });
    });
    later(0);
  };
  api(`/api/account/earn${preset.venue ? `?${new URLSearchParams({ venue: preset.venue })}` : ""}`).then((body) => {
    if (!live()) return;
    if (!body || body.ok === false) return void (root.innerHTML = `<div class="msg no">${esc(refusalOf(body) || "Earn could not be read.")}</div>`);
    view = { products: (body.products || []).filter((p) => tkInVenue(p.venue)), positions: (body.positions || []).filter((h) => tkInVenue(h.venue)), venues: body.venues || [], missing: body.missing || [] };
    draw();
  });
}
