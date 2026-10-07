/* One holding, in THE ONE DRAWER (ui/markets.js openMarket): a Portfolio row opens the market drawer by its holdings key — crypto:BTC ·
   equity:AAPL · stable:USDC · rwa:USDY · event:<symbol>, cash too. The market is found in what Markets has read, or read once by name; a
   holding no public source lists (a stablecoin, cash, a coin only one venue knows) still opens, from the asset read alone
   (GET /api/account/asset?key=&interval=): what is held and where, positions, open orders and what was paid, at the price the venue last
   read. The drawer's buttons go through the same doors as everywhere else: an order is the ticket's (openTicket), a close a signed liveClose
   (openClose), a cancel a signed liveCancel (cancelOrder). */

/* an asset's name as a person reads it: a coin or a share by its symbol, an event contract by its question where a position names it,
   cash by its currency */
function assetTitle(key, d) {
  const [cls, ...rest] = String(key).split(":");
  const sym = rest.join(":");
  if (cls === "event") return ((d && (d.positions || []).find((p) => p.kind === "event")) || {}).name || (d && d.row && d.row.asset) || sym;
  if (cls === "cash") return `Cash · ${sym}`;
  return (d && d.row && d.row.asset) || sym;
}

/** OPEN ONE HOLDING in the market drawer: `key` is a holdings key (crypto:BTC · equity:AAPL · stable:USDC · rwa:USDY · event:<symbol>).
 * The market Markets lists for it opens as itself; a holding no listing carries opens from the asset read */
async function openAsset(key) {
  if (!A || !key || typeof openMarket !== "function") return;
  const it = typeof mkFindByKey === "function" ? await mkFindByKey(key) : null;
  if (it) return void openMarket(it);
  const d = await api(`/api/account/asset?${new URLSearchParams({ key, interval: "1h" })}`, { ttl: 10_000 });
  if (!d || d.ok === false) return void toast(refusalOf(d) || "The account did not answer.", "no");
  openMarket(assetItemOf(key, d));
}

/** a holding no listing carries, as the row Markets would draw for it: enough to open the drawer, trade it where a connected venue takes an
 * order (the asset read's comparison, venue by venue) and sell what is held there; `heldKey` keeps the drawer's asset read on this key,
 * `held` says its price is the venue's last read */
function assetItemOf(key, d) {
  const [cls, ...rest] = String(key).split(":");
  const sym = rest.join(":");
  const kind = { crypto: "coin", equity: "stock", rwa: "rwa", event: "event", stable: "stable", cash: "cash" }[cls] || "coin";
  const row = d.row || null;
  const rows = (d.compare && Array.isArray(d.compare.rows) ? d.compare.rows : []).filter((r) => r.symbol);
  const at = rows.map((r) => ({ venue: r.venue, venueName: r.venueName || nameOf(r.venue), symbol: r.symbol, connected: true, canTrade: r.canTrade === undefined ? true : r.canTrade, public: false, price: r.price, open: r.open, note: r.note }));
  // an event contract held: its market where a position or a holding names it
  if (kind === "event") for (const p of [...(d.positions || []), ...((row && row.venues) || []).map((h) => ({ venue: h.venue, venueName: h.venueName, symbol: row.asset, markPrice: row.price }))]) if (p.symbol && !at.some((a) => a.venue === p.venue)) at.push({ venue: p.venue, venueName: p.venueName || nameOf(p.venue), symbol: p.symbol, connected: true, canTrade: "unknown", public: false, price: p.markPrice });
  // where it is held and nothing prices it: the venue is named, with no market to trade
  for (const h of (row && row.venues) || []) if (!at.some((a) => a.venue === h.venue)) at.push({ venue: h.venue, venueName: h.venueName || nameOf(h.venue), symbol: "", connected: true, canTrade: false, public: false, note: h.note });
  const p0 = (d.positions || [])[0];
  const price = row && row.price !== undefined ? row.price : rows[0] && rows[0].price !== undefined ? rows[0].price : p0 && p0.markPrice !== undefined ? p0.markPrice : undefined;
  return { key, heldKey: key, held: true, kind, name: assetTitle(key, d), ...(kind === "event" ? {} : { base: (row && row.asset) || sym }), price, changePct24h: row ? row.changePct24h : undefined, changeFrom: row ? row.changeFrom : undefined, tabs: [], at };
}
