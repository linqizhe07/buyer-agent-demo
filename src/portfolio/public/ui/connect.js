/* Connecting an account: the wallets this browser has, and every kind of account as tiles, each with its one short form. The picker
   (openPicker) is reached from Portfolio › Accounts "Connect an account" and Get started; a listing's "Connect to trade" and an agent's
   ask for a venue open the one connection's form straight away (connectVia → openConnect). Nothing else on the page draws the catalogue. */

// ---- wallets in this browser ------------------------------------------------------------

/* Wallets this browser has, as they announce themselves (EIP-6963): the listener is added first and never removed, then the page asks, and
   every wallet answers again. window.ethereum is used only when nothing announced itself, as the EIP says. */
const WALLETS = new Map();
window.addEventListener("eip6963:announceProvider", (e) => { const d = e.detail; if (d && d.info && d.provider) WALLETS.set(d.info.uuid || d.info.rdns || d.info.name, d); });
window.dispatchEvent(new Event("eip6963:requestProvider"));
const findWallets = async () => {
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  await new Promise((r) => setTimeout(r, 120));
  const found = [...WALLETS.values()];
  const eth = window.ethereum;
  if (!found.length && eth) found.push({ info: { name: eth.isOkxWallet || eth.isOKExWallet ? "OKX Wallet" : eth.isBinance ? "Binance Wallet" : eth.isCoinbaseWallet ? "Coinbase Wallet" : eth.isMetaMask ? "MetaMask" : "Browser wallet" }, provider: eth });
  return found;
};
const hexOf = (text) => "0x" + [...new TextEncoder().encode(text)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** ask the wallet for its address, then for its signature on the sentence the account wrote: that is what shows the address is yours */
async function proveWallet(w) {
  const accounts = await w.provider.request({ method: "eth_requestAccounts" });
  const address = accounts && accounts[0];
  if (!address) throw new Error("the wallet gave no address");
  const chainId = parseInt(await w.provider.request({ method: "eth_chainId" }).catch(() => "0x1"), 16) || 1;
  const c = await postJson("/api/account/wallet/challenge", { address, wallet: w.info.name, chainId });
  if (c.status !== 200) throw new Error(Owner.why(c) || "no sentence to sign");
  const signature = await w.provider.request({ method: "personal_sign", params: [hexOf(c.body.message), address] });
  const p = await postJson("/api/account/wallet/prove", { address, signature });
  if (p.status !== 200) throw new Error(Owner.why(p) || "the signature did not check");
  PROVIDERS.set(String(p.body.address).toLowerCase(), w);
  return { address: p.body.address, wallet: w.info.name };
}

// ---- connecting an account --------------------------------------------------------------

let EXCHANGES = null;
/* the connect form's check of its key file, or its sign-in poll: one at a time, stopped the moment another form takes the dialog */
let CONNECT_TIMER = 0;

/* every kind of account that can be connected, as tiles: the owner picks what it is, not how it is reached */
const TILES = [
  ["Exchanges", [["exchange", "okx", "OKX"], ["exchange", "kraken", "Kraken"], ["exchange", "coinbase", "Coinbase"], ["exchange", "bybit", "Bybit"], ["exchange", "binance", "Binance"], ["exchange", "", "Another exchange"]]],
  ["Brokers", [["robinhood", "", "Robinhood"], ["alpaca", "", "Alpaca"], ["robinhood-crypto", "", "Robinhood Crypto"]]],
  ["Wallets", [["wallet", "", "Browser wallet"], ["metamask", "", "MetaMask Agent Wallet"], ["wallet", "watch", "Watch an address"]]],
  ["Markets and tokens", [["kalshi", "", "Kalshi"], ["polymarket-us", "", "Polymarket US"], ["polymarket-trade", "", "Polymarket"], ["polymarket", "", "Polymarket · by address"], ["hyperliquid-trade", "", "Hyperliquid"], ["hyperliquid", "", "Hyperliquid · by address"], ["ondo", "", "Ondo · OUSG"]]],
];
const HOW = { "key-file": "API key", "sign-in": "Sign in", address: "Address", cli: "mm on this machine" };
/* the page at each venue where an API key is made (the venues' own account pages) */
const API_PAGES = { okx: "https://www.okx.com/account/my-api", binance: "https://www.binance.com/en/my/settings/api-management", binanceus: "https://www.binance.us/settings/api-management", coinbase: "https://portal.cdp.coinbase.com/api-keys/secret", bybit: "https://www.bybit.com/app/user/api-management", kraken: "https://pro.kraken.com/app/settings/api", kucoin: "https://www.kucoin.com/account/api", bitget: "https://www.bitget.com/account/newapi", alpaca: "https://app.alpaca.markets/dashboard/overview", kalshi: "https://kalshi.com/account/profile", "polymarket-us": "https://polymarket.us/developer", "robinhood-crypto": "https://robinhood.com/account/crypto", "hyperliquid-trade": "https://app.hyperliquid.xyz/API" };
/* what to tick when making the key, in each venue's own words (read 2026-10-05): trading on, withdrawals off */
const KEY_HOW = {
  okx: "Tick Read and Trade (and Transfer, to move between Funding and Trading). Leave Withdraw off. Add this machine's IP: a trading key with no IP expires after 14 days unused. The passphrase you set goes in \"password\".",
  binance: "Tick Enable Reading and Enable Spot & Margin Trading; leave Enable Withdrawals off. Binance lets a System-generated key trade only when it is restricted to trusted IPs, so add this machine's IP, or make a Self-generated Ed25519 key and put its private key in \"secret\".",
  okxus: "Make the key at OKX US (us.okx.com): a US account's key works there and nowhere else. Tick Read and Trade; leave Withdraw off. Add this machine's IP. The passphrase you set goes in \"password\".",
  binanceus: "Edit restrictions: keep Enable Read, check Enable Spot Trading, leave withdrawals off. Restrict it to this machine's IP: a key with no IP list that goes unused for 90 days is reset to read-only.",
  coinbase: "Create a Secret API key with the ECDSA signature algorithm (not Ed25519). Permissions: View and Trade; leave Transfer off. \"apiKey\" is the key's name (organizations/…/apiKeys/…), \"secret\" its private key, line breaks included.",
  kraken: "Permissions: Query Funds, Query Open Orders & Trades, Query Closed Orders & Trades, Create & Modify Orders, Cancel/Close Orders. Leave Withdraw Funds off.",
  bybit: "System-generated, Read-Write. Tick Orders and Positions, and spot Trade. Leave Withdrawal off. A key with no IP stops working after 90 days.",
  kucoin: "API Trading. Permissions: General and Spot (add Margin or Futures if you trade them); leave Withdrawal off. Add this machine's IP: a trading key with no IP is disabled after 30 days unused. The passphrase goes in \"password\".",
  gate: "API v4 key. Spot: Read and Write; leave Withdrawal off. Bind this machine's IP: without one the key lasts 90 days.",
  bitget: "Read/write with the Trade permission; leave Withdraw and Transfer off. Bind this machine's IP. The passphrase goes in \"password\".",
  alpaca: "Generate a key in your Live account (or Paper, to try it first). Alpaca keys have no permissions to choose: any key can trade, and none can move cash.",
  kalshi: "Create New API Key (Ed25519). If scopes are offered, take read and write::trade and leave write::transfer off.",
  "polymarket-us": "Verify your identity in the Polymarket US app first. On its developer page, sign in with the same method you use in the app (Apple, Google or email) — Polymarket US says switching methods may break API key access — and create a key: its Key ID goes in \"keyId\", its Secret Key in \"secretKey\" (the secret is shown only once). Its API moves no money in or out.",
  "robinhood-crypto": "Add key with your Ed25519 public key, and enable reading accounts, holdings, orders, products and quotes, and placing crypto orders.",
  "polymarket-trade": "Put in the private key of the wallet that signs for your Polymarket account. If the money sits in a Polymarket wallet, add \"funderAddress\" (the address in your profile menu) and \"signatureType\": 1 (Proxy), 2 (Safe) or 3 (Deposit Wallet); leave both empty for a plain wallet. Polymarket checks your location before anything else.",
  "hyperliquid-trade": "More → API: name an API wallet, Generate, copy its private key, then Authorize API Wallet with your account's own wallet (valid up to 180 days). An API wallet signs trades for your account and can never withdraw. \"walletAddress\" is your account's own address; \"privateKey\" is the API wallet's, never your account's own key. Hyperliquid's terms (§1.6) are checked for where you are before anything else.",
};
const keyHow = (venue) => KEY_HOW[venue] || "Turn on reading and trading; leave withdrawals off. Bind this machine's IP if the exchange offers it.";
const optionOf = (kind) => ((A.connectLive || {}).options || []).find((o) => o.kind === kind);
/* an address-based connection numbers itself after the first of its kind */
const BY_ADDRESS = new Set(["wallet", "polymarket", "hyperliquid", "ondo"]);
const isOn = (kind, extra) => (kind === "wallet" ? false : A.venues.some((v) => v.id === (extra || kind) || (BY_ADDRESS.has(kind) && v.id.startsWith(`${kind}-`))));

/* what each tile's venue answered from this machine before any key was made: its own first, keyless question (GET
   /api/account/connect/reach, live/reach.ts). A venue that does not serve this location says so on its tile and in its form, in its own
   words, before a key is made that it would refuse; nothing here looks for a way around it */
const REACH = new Map();
/* the connection a tile asks about: an exchange by its id; the ones read by address ask their host one keyless question about nobody
   (Polymarket's data API, Hyperliquid's info endpoint, each chain's public endpoint): a network may refuse or filter it too */
const tileConnector = (kind, extra) => (kind === "exchange" ? (extra ? `live:exchange:${extra}` : "") : `live:${kind}`);
/* the tile a connection is: [kind, extra] (`live:exchange:binanceus` → exchange, binanceus) */
const tileOf = (connector) => { const m = /^live:(exchange:)?([a-z0-9-]+)$/.exec(connector || ""); return m ? (m[1] ? ["exchange", m[2]] : [m[2], ""]) : null; };
/* a venue that cannot be used from here and its edition for where the user is (the account's detection: a separate company that answers
   this network and whose own terms serve the place — Binance.US for Binance) */
const editionOf = (connector) => { const v = typeof VENUES !== "undefined" && connector ? VENUES.get(connector) : undefined; return v && v.edition ? v.edition : null; };
/* a tile's second line once its venue said no */
const REACH_WORD = { location: "Not served here", setup: "Set up first", closed: "Not available" };
async function askReach(connectors, force = false) {
  const list = [...new Set(connectors.filter(Boolean))];
  if (!list.length) return;
  const got = await api(`/api/account/connect/reach?${new URLSearchParams({ connector: list.join(","), ...(force ? { force: "1" } : {}) })}`);
  for (const r of got && Array.isArray(got.reach) ? got.reach : []) REACH.set(r.connector, r);
}
/* a trading connection whose venue can also be watched by an address: the address one, its tile's name, and the offer to watch instead */
const WATCH_INSTEAD = { "polymarket-trade": ["polymarket", "Polymarket · by address", "Watch a Polymarket wallet by its address instead"], "hyperliquid-trade": ["hyperliquid", "Hyperliquid · by address", "Watch a Hyperliquid account by its address instead"] };
/* the form's note: the venue's no in its words and when it was asked, "Check again"; Polymarket's and Hyperliquid's add the way to see the
   account there by its address, and a venue with an edition for where the user is (Binance.US for Binance) offers that edition's form */
function reachNoteHtml(r, kind) {
  if (!r || r.state === "ok") return "";
  return `${reachSaysHtml(r, kind)}${r.edition && optionOf((tileOf(r.edition.connector) || [])[0]) ? ` <button type="button" class="link" data-reach="edition" title="${esc(r.edition.said)}">Connect ${esc(r.edition.name)} instead</button>` : ""}`;
}
function reachSaysHtml(r, kind) {
  // the venue lets this location only close what is held: its words, and the form stays open — connected, what is held can be sold
  if (r.state === "close-only") return `${esc(r.said || "")}${r.at ? ` <span class="dim">(asked ${esc(nyTime(r.at))})</span>` : ""} <button type="button" class="link" data-reach="again">Check again</button>`;
  // the venue's own terms exclude where the user is: its words, said once; the venue checks residency when an account is opened
  if (r.state === "terms") return `${esc(r.said || "")}${r.at ? ` <span class="dim">(asked ${esc(nyTime(r.at))})</span>` : ""}`;
  const w = WATCH_INSTEAD[kind];
  const instead = r.state === "location" && w && optionOf(w[0]) ? ` <button type="button" class="link" data-reach="watch">${esc(w[2])}</button>` : "";
  return `${esc(r.said || "")}${r.at ? ` <span class="dim">(asked ${esc(nyTime(r.at))})</span>` : ""} <button type="button" class="link" data-reach="again">Check again</button>${instead}`;
}
/* what a tile's venue answered, from this form's own check (REACH, the freshest) or the account's detection (core VENUES): a venue that
   refuses this network, wants something on this machine first, or offers no way in closes the form (`shut`); one that lets this location
   only close what is held, or whose own terms exclude where the user is, says so in its words and does not close it — connected, what is
   held can be sold; the venue's sign-up checks residency, the account only shows it */
function tileSays(connector) {
  const t = tileSaysOwn(connector);
  return t ? { ...t, edition: editionOf(connector) } : null;
}
function tileSaysOwn(connector) {
  if (!connector) return null;
  const r = REACH.get(connector);
  const v = typeof VENUES !== "undefined" ? VENUES.get(connector) : undefined;
  if ((r && r.state === "close-only") || (!r && v && v.verdict === "close-only")) return { word: "Close only here", state: "close-only", said: (r || v).said || "", at: r ? r.at : v.asked, shut: false };
  if (r && REACH_WORD[r.state]) return { word: REACH_WORD[r.state], state: r.state, said: r.said || "", at: r.at, shut: true };
  if (!r && v && VENUE_NO[v.verdict]) return { word: VENUE_NO[v.verdict], state: v.verdict === "not-served" ? "location" : v.verdict, said: v.said || "", at: v.asked, shut: true };
  if (v && v.verdict === "terms-exclude") return { word: "Its terms exclude where you are", state: "terms", said: v.said || "", at: v.asked, shut: false };
  return null;
}
/* the tiles of the open picker, marked from what their venues answered */
function markTiles() {
  for (const b of document.querySelectorAll("#modal button.tile")) {
    const t = tileSays(tileConnector(b.dataset.kind, b.dataset.extra));
    if (!t || b.querySelector("em.on")) continue;
    b.classList.add("tile-off");
    b.title = t.said;
    b.querySelector("span").innerHTML = `<em class="off">${esc(t.word)}</em>`;
  }
}

/** the tiles, grouped; `wide` lays them out across the page instead of inside the dialog. A way of connecting the server offers that no tile
 * above names is still a tile, under "More", by the server's own name for it: nothing the account can connect is left off */
function catalog(owner, wide = "") {
  const shown = new Set(TILES.flatMap(([, tiles]) => tiles.map(([kind, extra]) => tileConnector(kind, extra))));
  const tile = ([kind, extra, name], edition = false) => {
    const o = optionOf(kind);
    if (!o) return "";
    const how = kind === "wallet" ? (extra === "watch" ? "Address" : "Sign one sentence") : o.needs === "cli" && kind !== "metamask" ? "On this machine" : HOW[o.needs] || "";
    const on = isOn(kind, extra);
    const t = on ? null : tileSays(tileConnector(kind, extra));
    const word = t && t.word;
    const own = `<button type="button" class="tile${word ? " tile-off" : ""}" data-kind="${esc(kind)}" data-extra="${esc(extra)}"${word ? ` title="${esc(t.said)}"` : ""}${owner ? "" : " disabled"}><b>${esc(name)}</b><span>${on ? '<em class="on">Connected</em> · add another' : word ? `<em class="off">${esc(word)}</em>` : esc(edition ? `${how} · serves where you are` : how)}</span></button>`;
    // beside a venue that cannot be used from here: its edition for where the user is, as a tile of its own
    const ed = !edition && t && t.edition && !shown.has(t.edition.connector) ? tileOf(t.edition.connector) : null;
    return own + (ed ? tile([ed[0], ed[1], t.edition.name], true) : "");
  };
  const named = new Set(TILES.flatMap(([, tiles]) => tiles.map(([kind]) => kind)));
  const more = ((A.connectLive || {}).options || []).filter((o) => !named.has(o.kind)).map((o) => [o.kind, "", o.label.split(" · ")[0]]);
  return [...TILES, ["More", more]].map(([title, tiles]) => { const t = tiles.map((x) => tile(x)).join(""); return t ? `<div class="pick-h">${esc(title)}</div><div class="pick ${wide}">${t}</div>` : ""; }).join("");
}

/** what a connection is (`live:exchange:okx`, `live:kalshi`, `live:polymarket-trade`) as the server offers it: its way of connecting, and the
 * exchange for an exchange; null when this server offers no such connection */
function connectionOf(connector) {
  if (!A || !A.connectLive) return null;
  const ex = /^live:exchange:([a-z0-9-]+)$/.exec(String(connector || ""));
  if (ex) {
    const o = optionOf("exchange");
    return o ? { o, exchange: ex[1] } : null;
  }
  const o = (A.connectLive.options || []).find((x) => x.connector === connector);
  return o ? { o, exchange: "" } : null;
}
/** "Connect to trade": the one short form for the connection a public listing names, opened straight away. False when this server offers
 * no such connection (nothing opens) */
function connectVia(connector, { name = "", label = "", ref = "" } = {}) {
  const c = connectionOf(connector);
  if (!c) return false;
  // a browser wallet names itself when it signs; a watched address is named by the owner. `label` keeps a venue's own name when it is
  // connected again (a second account the owner named), so it comes back as the same venue; `ref` its own key file (venues[].keyFile)
  openConnect(c.o, { exchange: c.exchange, name: c.o.kind === "wallet" ? "" : name, label, ref });
  return true;
}
/** the connection a venue on the account was made with: the one the account names for it (venues[].connector), when this server still
 * offers it; on an account that does not name it, what its id says (an exchange's own id, or the connector's kind); "" otherwise */
function connectorOfVenue(v) {
  if (!A || !A.connectLive || !v) return "";
  if (v.connector) return connectionOf(v.connector) ? v.connector : "";
  const own = (A.connectLive.options || []).find((o) => o.kind === v.id && o.needs !== "address");
  if (own) return own.connector;
  const ex = optionOf("exchange");
  return ex && (ex.venues || []).includes(v.id) ? `live:exchange:${v.id}` : "";
}
/** what to tick at a venue for a key that trades, by the connection it was made with (an exchange by its own id: a second OKX account is
 * still OKX); by its id on an account that does not name the connection */
function keyHowFor(v) {
  const c = String((v && v.connector) || "");
  const ex = /^live:exchange:([a-z0-9-]+)$/.exec(c);
  const kind = /^live:([a-z0-9-]+)$/.exec(c);
  return keyHow(ex ? ex[1] : kind ? kind[1] : String((v && v.id) || "").replace(/-.*$/, ""));
}

/* what each key file holds, until the server says exactly (an exchange's own list comes from the exchange library) */
const FIELDS = { exchange: ["apiKey", "secret"], alpaca: ["keyId", "secret"], kalshi: ["keyId", "privateKeyFile"], "polymarket-us": ["keyId", "secretKey"], "robinhood-crypto": ["apiKey", "privateKey"], "polymarket-trade": ["privateKey", "funderAddress", "signatureType"], "hyperliquid-trade": ["walletAddress", "privateKey"] };
/* a shell word, quoted */
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
/* the one command that makes a key file: the folder, an empty template if there is no file yet (an existing one is never overwritten),
   owner-only permissions, and an editor to fill it in */
const keyCommand = (path, fields) => {
  const dir = path.replace(/\/[^/]*$/, "");
  const file = path.slice(dir.length + 1);
  const template = `{${fields.map((f) => `"${f}": ""`).join(", ")}}`;
  return `mkdir -p ${shq(dir)} && cd ${shq(dir)} && ( [ -e ${shq(file)} ] || printf '%s\\n' ${shq(template)} > ${shq(file)} ) && chmod 600 ${shq(file)} && nano ${shq(file)}`;
};

/** every way of connecting an account, as tiles, in the dialog */
function openPicker() {
  if (!A.connectLive) return;
  clearInterval(CONNECT_TIMER);
  $("modal-form").innerHTML = `<h2 id="modal-form-title">Connect an account</h2>
    ${catalog(Owner.role === "owner")}
    <div class="dim small">${writesOn() ? "Orders go through only when you sign them, or inside a limit you give an agent." : "Read-only: this server places no orders."}</div>
    <div class="end"><button type="button" id="modal-cancel">Cancel</button></div>`;
  $("modal-cancel").addEventListener("click", () => $("modal").close());
  for (const b of $("modal-form").querySelectorAll("button.tile")) b.addEventListener("click", () => openConnect(optionOf(b.dataset.kind), { exchange: b.dataset.kind === "exchange" ? b.dataset.extra : "", watch: b.dataset.extra === "watch", name: b.querySelector("b").textContent, back: true }));
  if (!$("modal").open) $("modal").showModal();
  // each venue's first question, asked as the list opens (kept on the server): a tile whose venue says no is marked while the owner reads
  const again = () => {
    if ($("modal").open && ($("modal-form-title") || {}).textContent === "Connect an account") markTiles();
  };
  askReach(TILES.flatMap(([, tiles]) => tiles.map(([kind, extra]) => tileConnector(kind, extra)))).then(again);
  if (typeof readVenues === "function") readVenues().then(again);
}

/** one way of connecting, as one short form */
async function openConnect(o, { exchange = "", watch = false, name = "", back = false, label: shownAs = "", ref: keyRef = "" } = {}) {
  if (!o) return;
  clearInterval(CONNECT_TIMER);
  /* the venue's name, and what the dialog is called: watching an address connects nothing that could move */
  const title = o.kind === "exchange" && !exchange ? "an exchange" : name || o.label.split(" · ")[0];
  const heading = watch ? "Watch an address" : o.kind === "wallet" ? "Connect a browser wallet" : `Connect ${title}`;
  $("modal-form").innerHTML = `${back ? '<button type="button" class="link dim back" id="modal-back">← All accounts</button>' : ""}<h2 id="modal-form-title">${esc(heading)}</h2>
    <div class="reach-note" id="reach-note" hidden></div>
    <div id="live-body"></div>
    <div class="msg" id="modal-msg"></div>
    <div class="end"><button type="button" id="modal-cancel">Cancel</button><button type="submit" class="ink" id="modal-go"${Owner.role === "owner" ? "" : " disabled"}>${watch ? "Watch it" : "Connect"}</button></div>`;
  const form = $("modal-form");
  // this form's own body: a check or a poll started here stops once another form has taken the dialog (back → another venue)
  const body = $("live-body");
  let proven = null;
  /* "no" a refusal · "ok" done · "wait" the venue or the wallet is being asked */
  const say = (text, state) => { $("modal-msg").className = `msg${text && state ? ` ${state}` : ""}`; $("modal-msg").textContent = text || ""; };
  $("modal-cancel").addEventListener("click", () => $("modal").close());
  if (back) $("modal-back").addEventListener("click", () => openPicker());
  const exchangeId = () => (o.kind !== "exchange" ? "" : exchange || (form.elements.exchange ? form.elements.exchange.value : ""));
  const exchangeName = () => (EXCHANGES || []).find((x) => x.id === exchangeId())?.name || name || exchangeId();
  /* the venue this becomes on the account: the exchange's own id, or a second account when the owner names it so; the kind of connection;
     an address-based one numbered after the first */
  const venueId = () => {
    const label = (form.elements.label ? form.elements.label.value : "").trim();
    const ref = (form.elements.ref ? form.elements.ref.value : "").trim();
    if (o.kind === "exchange") return label && slug(label) !== slug(exchangeName()) ? slug(label) : exchangeId();
    if (o.needs === "address") return A.venues.some((v) => v.id === o.kind) ? `${o.kind}-${ref.slice(2, 8).toLowerCase()}` : o.kind;
    return o.kind;
  };
  /* what this form's venue answered from here before anything was made (live/reach.ts): a no closes the way in — the steps folded away,
     Connect off — and says why in the venue's words; "Check again" asks it again now */
  const connNow = () => (o.kind === "exchange" ? (exchangeId() ? `live:exchange:${exchangeId()}` : "") : tileConnector(o.kind, ""));
  let reachShut = false;
  const showReach = () => {
    const note = $("reach-note");
    if (!note || body.isConnected === false) return;
    const t = tileSays(connNow());
    const was = reachShut;
    reachShut = !!(t && t.shut);
    note.hidden = !t;
    note.className = `reach-note msg ${reachShut ? "no" : "wait"}`;
    note.innerHTML = t ? reachNoteHtml(t, o.kind) : "";
    for (const el of form.querySelectorAll("#live-body .steps, #live-body details.opts")) el.hidden = reachShut;
    if (reachShut) $("modal-go").disabled = true;
    else if (was) $("modal-go").disabled = Owner.role !== "owner" || (o.needs === "sign-in" && !form.elements.ref.value);
  };
  const reachAsk = (force = false) => {
    const c = connNow();
    if (!c || (!force && REACH.has(c))) return void showReach();
    askReach([c], force).then(showReach);
  };
  $("reach-note").addEventListener("click", (e) => {
    const b = e.target.closest("[data-reach]");
    if (!b) return;
    const w = WATCH_INSTEAD[o.kind];
    if (b.dataset.reach === "watch" && w) return void openConnect(optionOf(w[0]), { name: w[1], back });
    // the venue's edition for where the user is: its own form
    const ed = b.dataset.reach === "edition" ? editionOf(connNow()) : null;
    const et = ed && tileOf(ed.connector);
    if (et && optionOf(et[0])) return void openConnect(optionOf(et[0]), { exchange: et[0] === "exchange" ? et[1] : "", name: ed.name, back });
    $("reach-note").className = "reach-note msg wait";
    $("reach-note").textContent = "Asking again…";
    reachAsk(true);
  });

  if (o.needs === "key-file") {
    const pick = o.kind === "exchange" && !exchange;
    // the exchanges this server connects, read once; a read that failed is asked again the next time, not kept as an empty list
    if (o.kind === "exchange" && !EXCHANGES) {
      const got = await api("/api/account/exchanges");
      EXCHANGES = got && Array.isArray(got.exchanges) ? got.exchanges : null;
      if (body.isConnected === false) return;
      if (!EXCHANGES) say(refusalOf(got) || "The list of exchanges could not be read. Close this and try again.", "no");
    }
    const vname = o.kind === "exchange" ? exchangeName() : title;
    const page = API_PAGES[o.kind === "exchange" ? exchangeId() : o.kind];
    $("live-body").innerHTML = `${pick ? field("Exchange", select("exchange", (EXCHANGES || []).map((x) => [x.id, x.name]))) : ""}
      <div class="steps">
        <div class="step"><i>1</i><div>Make an API key at <span id="kf-venue">${esc(vname)}</span> that can trade, with withdrawals off<span id="kf-pagewrap"${page ? "" : " hidden"}> · <a href="${esc(page || "#")}" target="_blank" rel="noopener" id="kf-page">open its API page</a></span>.<div class="dim small kf-how" id="kf-how">${esc(keyHow(o.kind === "exchange" ? exchangeId() : o.kind))}</div></div></div>
        <div class="step"><i>2</i><div>Save it here, readable only by you:<div class="pathbox"><code id="kf-path">…</code><button type="button" class="link" data-copy="path">Copy</button></div><div class="kf-cmd"><button type="button" class="btn btn-sm" data-copy="cmd">Copy setup command</button><span class="dim small" id="kf-fields"></span></div></div></div>
        <div class="step"><i>3</i><div class="msg wait" id="kf-status">Looking for the file…</div></div>
      </div>
      <details class="opts"><summary>More options</summary><div class="row">${field("Shown as", '<input name="label" maxlength="40" autocomplete="off" />')}${field("Key file", '<input name="ref" maxlength="160" autocomplete="off" spellcheck="false" />')}</div></details>`;
    let path = "";
    let fields = [];
    /* the key file: a venue's own when it is connected again (the one the account signed for it); otherwise the one the server reads for
       the venue by default, credentials/<venue>/api-key.json — so naming a second account at an exchange gives it a file of its own, never
       the first account's — until the owner types one */
    let refTyped = false;
    const refFor = () => keyRef || `credentials/${venueId()}/api-key.json`;
    const pathOf = (ref) => (ref.startsWith("/") ? ref : `${A.connectLive.home.replace(/\/$/, "")}/${ref}`);
    const show = () => {
      $("kf-path").textContent = path;
      $("kf-fields").textContent = fields.length ? `Fields: ${fields.join(", ")}` : "";
    };
    const fill = () => {
      form.elements.label.value = shownAs && !pick ? shownAs : vname && !pick ? vname : exchangeName();
      form.elements.ref.value = refFor();
      refTyped = false;
      if (pick) {
        // the exchange picked in the list: its name, and its API page when this page knows it
        $("kf-venue").textContent = exchangeName();
        $("kf-how").textContent = keyHow(exchangeId());
        const p = API_PAGES[exchangeId()];
        $("kf-pagewrap").hidden = !p;
        if (p) $("kf-page").href = p;
      }
      // shown at once from what the page knows; the server's check below says it exactly
      path = pathOf(form.elements.ref.value);
      fields = o.kind === "exchange" ? ((EXCHANGES || []).find((x) => x.id === exchangeId())?.needs || FIELDS.exchange).filter((f) => ["apiKey", "secret", "password", "uid"].includes(f)) : FIELDS[o.kind] || [];
      show();
    };
    /* the server says whether the file is there, private and complete — names of fields only, never what is in them */
    const check = async () => {
      if (!$("modal").open || body.isConnected === false || !$("kf-status")) return;
      const q = new URLSearchParams({ kind: o.kind, venue: venueId(), ref: form.elements.ref.value.trim(), exchange: exchangeId() });
      const resp = await fetch(`/api/account/keyfile?${q}`).catch(() => null);
      if (body.isConnected === false || !$("kf-status")) return;
      // a server from before this check: the owner saves the file and connects, and the connection says what is wrong, if anything
      if (!resp || !resp.ok) return void (($("kf-status").className = "msg wait"), ($("kf-status").textContent = "Save the file, then Connect."));
      const r = await resp.json().catch(() => null);
      if (!r || !r.ok) return;
      path = r.path;
      fields = o.kind === "kalshi" ? [...r.fields, "privateKeyFile"] : r.fields;
      show();
      const st = $("kf-status");
      if (r.ready) return void ((st.className = "msg ok"), (st.textContent = "Ready."));
      if (r.mode) return void ((st.className = "msg no"), (st.innerHTML = `Others on this machine can read it. <button type="button" class="link" data-copy="chmod">Copy fix</button>`));
      if (r.missing) return void ((st.className = "msg no"), (st.textContent = `Missing: ${r.missing.join(", ")}.`));
      if (/there is no key file/.test(r.message)) return void ((st.className = "msg wait"), (st.textContent = "Waiting for the file…"));
      st.className = "msg no";
      st.textContent = r.message;
    };
    fill();
    if (pick) form.elements.exchange.addEventListener("change", () => { fill(); check(); reachAsk(); });
    const typed = () => { path = pathOf(form.elements.ref.value.trim()); show(); check(); };
    form.elements.ref.addEventListener("input", () => { refTyped = true; typed(); });
    // a new name is a new venue: its file follows it, until one is typed
    form.elements.label.addEventListener("input", () => { if (!refTyped && !keyRef) { form.elements.ref.value = refFor(); typed(); } });
    form.addEventListener("click", (e) => {
      const b = e.target.closest("[data-copy]");
      if (!b) return;
      const what = b.dataset.copy;
      copyText(what === "path" ? path : what === "chmod" ? `chmod 600 ${shq(path)}` : keyCommand(path, fields), b);
    });
    check();
    const timer = setInterval(check, 2000);
    // stopped when the dialog closes; and the next openConnect or openPicker stops it first, so a form replaced from the back button (another
    // venue) is never written to by this form's check
    CONNECT_TIMER = timer;
    $("modal").addEventListener("close", () => clearInterval(timer), { once: true });
  } else if (o.needs === "address") {
    const wallets = o.kind === "wallet" && !watch ? await findWallets() : [];
    const walletTiles = wallets.length ? `<div class="wallets">${wallets.map((w, i) => `<button type="button" data-wallet="${i}">${/^data:image\//.test(w.info.icon || "") ? `<img src="${esc(w.info.icon)}" alt="" width="18" height="18" />` : ""}${esc(w.info.name)}</button>`).join("")}</div><div class="path dim small">Your wallet gives its address and signs one sentence. Nothing is approved or moved.</div><div class="or">or watch an address</div>` : o.kind === "wallet" && !watch ? '<div class="path dim small">No wallet in this browser. Open this page where your wallet is installed, or watch an address.</div>' : "";
    $("live-body").innerHTML = `${walletTiles}<div class="row">${field("Address", '<input name="ref" maxlength="80" autocomplete="off" spellcheck="false" placeholder="0x…" />')}${field("Shown as", '<input name="label" maxlength="40" autocomplete="off" />')}</div>${o.kind !== "wallet" ? `<div class="path dim small">${esc(o.example)}</div>` : ""}`;
    form.elements.label.value = shownAs || (name && !/watch|browser/i.test(name) ? name : "");
    form.elements.ref.addEventListener("input", () => { proven = null; });
    for (const b of $("live-body").querySelectorAll("button[data-wallet]")) {
      b.addEventListener("click", async () => {
        const w = wallets[Number(b.dataset.wallet)];
        say(`Waiting for ${w.info.name}…`, "wait");
        try {
          proven = await proveWallet(w);
          form.elements.ref.value = proven.address;
          if (!form.elements.label.value) form.elements.label.value = w.info.name;
          say(`${w.info.name} signed: ${short(proven.address)} is yours.`, "ok");
        } catch (err) {
          say(String((err && err.message) || err).slice(0, 200), "no");
        }
      });
    }
  } else if (o.needs === "sign-in") {
    const who = o.label.split(" · ")[0];
    $("live-body").innerHTML = `<div class="steps"><div class="step"><i>1</i><div>Sign in on ${esc(who)}’s own page and approve. <span class="dim">Reads every Robinhood account; trades only in your Agentic account, on your signature or inside a limit you give an agent.</span></div></div><div class="step"><i>2</i><div><button type="button" class="btn btn-sm" id="signin-go">Sign in at ${esc(who)}…</button></div></div></div><input type="hidden" name="ref" value="" /><input type="hidden" name="label" value="${esc(who)}" />`;
    $("modal-go").disabled = true;
    $("signin-go").addEventListener("click", async () => {
      // the tab opens inside the click, so no popup blocker stops it; it goes to the venue once its address is known
      const tabWin = window.open("about:blank", "_blank");
      say(`Asking ${who} where to sign in…`, "wait");
      const r = await fetch("/api/account/signin/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ connector: o.kind }) }).then((x) => x.json()).catch(() => ({ ok: false }));
      if (!r.ok) {
        if (tabWin) tabWin.close();
        return say((r.refusal && r.refusal.message) || r.error || "the sign-in could not start", "no");
      }
      if (tabWin) {
        tabWin.opener = null;
        tabWin.location.href = r.url;
        say(`Sign in on ${who}’s page, then come back.`, "wait");
      } else {
        $("modal-msg").className = "msg wait";
        $("modal-msg").innerHTML = `<a href="${esc(r.url)}" target="_blank" rel="noopener">Open ${esc(who)}’s sign-in page</a>, then come back.`;
      }
      const until = Date.now() + 15 * 60_000;
      // the poll ends with this form: the dialog closed, or another connection's form in its place
      const poll = async () => {
        if (!$("modal").open || body.isConnected === false) return;
        const st = await fetch(`/api/account/signin/status?state=${encodeURIComponent(r.state)}`).then((x) => x.json()).catch(() => ({}));
        if (st.status === "ready") {
          form.elements.ref.value = r.state;
          $("modal-go").disabled = Owner.role !== "owner";
          return say("Signed in. Connect it.", "ok");
        }
        if (st.status === "failed") return say(st.error || "the sign-in did not finish", "no");
        if (Date.now() > until) return say("The sign-in ran out: start again.", "no");
        CONNECT_TIMER = setTimeout(poll, 1500);
      };
      poll();
    });
  } else {
    $("live-body").innerHTML = `<div class="path dim small">${esc(o.example)}</div><input type="hidden" name="ref" value="" /><input type="hidden" name="label" value="" />`;
  }

  reachAsk();

  form.onsubmit = async (e) => {
    e.preventDefault();
    if (reachShut) return;
    const ref = (form.elements.ref.value || "").trim();
    const label = (form.elements.label.value || "").trim();
    if (o.needs === "address" && !/^0x[0-9a-fA-F]{40}$/.test(ref)) return say("An address is 0x and 40 hex digits.", "no");
    $("modal-go").disabled = true;
    say("Asking the venue…", "wait");
    const r = await Owner.act({ type: "connectVenue", venue: venueId(), connector: o.kind === "exchange" ? `live:exchange:${exchangeId()}` : `live:${o.kind}`, label, credentialRef: ref });
    $("modal-go").disabled = Owner.role !== "owner";
    if (r.status >= 400) return say(Owner.why(r) || "Refused", "no");
    $("modal").close();
    flash = "";
    said = r.body.summary || "";
    await load();
  };
  if (!$("modal").open) $("modal").showModal();
}
