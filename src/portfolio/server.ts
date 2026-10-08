/** The account page — the user's real accounts on one page — and the API behind it and the MCP server.
 *
 *   npm run account                   → http://127.0.0.1:4820 · the Account: real accounts only, connected on the page, trading on
 *                                       (`npm run portfolio` is the same; `--read-only` places and moves nothing; `--live-cap 100` is the most
 *                                       one order or movement may be worth)
 *   npm run account -- --classic      → the original simulated statement (no account layer); `--mm` there reads the real `mm` CLI
 *
 *   GET  /api/overview                 the statement, the liquidity map, the flight board
 *   GET  /api/read?account=binance     holdings (never gated)
 *   POST /api/say     {text}           the user talks to the page agent → a flight (PM-xxxx)
 *   POST /api/approve {id, decision}   the user answers a card → one more leg on that flight
 *   POST /api/execute {account, intent, agent}  an MCP agent's write: a flight of one leg (200 ok · 202 card · 409 refusal)
 *   GET  /api/markets                           the event contracts on the prediction markets: state, close date, each venue's top of book
 *   GET  /api/quote?base=ETH&side=sell&qty=3    one order priced at every venue (CEX books, DEX pools, prediction-market books) and split across them; a read.
 *                                               `base` is an asset (ETH) or an event contract (FED-DEC-HIKE25:YES)
 *   POST /api/order   {base, side, qty, agent}  route the order and fly it: one flight, one leg per slice, one card at most
 *   POST /api/mode    {mode}           open | guard
 *   POST /api/revoke  {account} · POST /api/restore {account}   an account's switch
 *   POST /api/reset
 *
 * With the account layer mounted (the default for this server; `--classic` runs the original accounts without it). It holds REAL accounts
 * only: the venues the owner connects through their own interfaces; no simulated venue is mounted.
 *
 *   GET  /                             the page: net worth, accounts, activity, agents, devices (`/account` sends you here)
 *   GET  /api/account                  what that page reads, with `agentSetup`: the command an agent's owner runs to add this account's MCP seat,
 *                                      and the lists the door accepts (`dollars`, `networks`, `bridgeChains`)
 *   GET  /api/now                      the service's clock (a signer takes its nonce from here)
 *   POST /api/account/pair   {jwk}     a browser offers the public half of its device key; the first one becomes the owner's device
 *   POST /api/account/prepare {draft}  turn what the owner asked for into the exact action to sign (a movement gets its route, fee and arrival;
 *                                      an order its exact size, price and the most it may be worth)
 *   GET  /api/account/exchanges        the exchanges the unified library covers, for the connect form
 *   GET  /api/account/keyfile?kind=&venue=&ref=    whether a key file is in place for a connection: its place, its mode, the fields it misses
 *   GET  /api/account/venues[?force=1]  where this user can connect: every venue the account knows, judged from this network (its own
 *                                      answer, and its terms matched to where the network is — never named) — live/availability.ts
 *   GET  /api/account/connect/reach?connector=[&force=1]   before a key is made: whether each connection's venue answers from here
 *                                      (its first, keyless question; a location rule in the venue's words) — live/reach.ts
 *   POST /api/account/wallet/challenge {address, wallet, chainId}   the sentence a wallet signs to show an address is the owner's (EIP-4361)
 *   POST /api/account/wallet/prove {address, signature}            that signature, checked; the address is then proven, not watched
 *   POST /api/account/signin/start {connector}     a venue's own OAuth sign-in (Robinhood): the page to open, and its state
 *   GET  /api/account/signin/status?state=         how that sign-in stands
 *   GET  /api/account/signin/callback              where the venue sends the owner's browser back
 *   GET  /api/account/statement        every transaction at the real venues, across the account's runs, newest first
 *   GET  /api/account/markets?venue=okx&q=BTC        what a venue connected live trades (a read)
 *   GET  /api/account/market?venue=okx&symbol=BTC/USDT   one market: a fresh price, the smallest order, the steps, open or not (a read)
 *   GET  /api/account/compare?base=BTC&side=buy&usd=     the same coin or stock at every venue connected live, ranked by the price an
 *                                                        order would take there (a read)
 *   GET  /api/account/positions?venue=okx                what is held there: perpetuals, shares, event contracts (a read); no venue: at
 *                                                        every venue that lists positions, and the ones that could not be read
 *   GET  /api/account/explore?tab=&q=&sort=&limit=       Markets: what the connected venues list and what the venues not connected
 *                                                        publish without a key ("Connect to trade"), as one list with tabs, movers,
 *                                                        what closes soon and what trades most
 *   GET  /api/account/holdings?cost=1                    Portfolio: what is held by asset across every venue, the dollars that are ready,
 *                                                        the last 24 hours; `cost=1` adds what was paid
 *   GET  /api/account/history?range=1d|1w|1m|all         the net worth curve
 *   GET  /api/account/receive?venue=&asset=&network=     where to send an asset so that it lands at a venue
 *   GET  /api/account/asset?key=crypto:BTC&interval=1h   one asset: its row, every venue's price, price history, positions, orders, lines
 *   GET  /api/account/quotes?pairs=okx|BTC/USDT,…        fresh prices for up to twelve markets
 *   GET  /api/account/sellable                           everything held that is not a dollar, and what selling it would sign
 *   GET  /api/account/agents                             the agents one by one: keys, limits, cards, orders, payments, wallets, intents
 *   GET  /api/account/candles?venue=&symbol=&interval=   one market's price history (5m · 1h · 1d): a connected venue's own, or a venue not
 *                                                        connected from its public data, without a key; kept a minute
 *   GET  /api/account/earn?venue=&asset=                 Earn: the products the connected venues offer (the MetaMask Agent Wallet's
 *                                                        vaults through mm, OKX Simple Earn, Kraken Earn), what is in them, and the venues
 *                                                        that could not be read (money in or out is a signed liveEarn / agentLiveEarn)
 *   POST /api/account/bridge-routes {draft}              the routes a bridge could take from a wallet of the owner's, the chosen one first
 *   POST /api/account/live/order-sent {order, hash}      the page says which transaction the wallet sent for a DEX order
 *   POST /api/account/live/order-requote {order}         a wallet order whose approval is on chain: the swap built again from a fresh quote
 *   POST /api/account/live/sent {payment, hash}          the page says which transaction the wallet sent for a movement
 *   GET  /ui/<name>.js|css                               the account page's own scripts and styles
 *   POST /api/exchange {action, nonce, signature}   THE door: every instruction, signed — an owner action by an owner key, an agent's by an
 *                                      authorised agent key (200 done · 202 a card is waiting · 401 not a signer · 409 refused)
 *
 * and the routes above change: /api/execute and /api/order take no unsigned caller (an agent signs `agentLiveOrder` / `agentLiveMove` at the
 * door; on a layered simulation `agentExecute` / `agentOrder`); /api/say, /api/approve, /api/restore, /api/reset and opening the dial are the
 * owner's and arrive as signed actions; tightening (Guard, an account off) stays free. On the real account /api/markets and /api/quote
 * answer a refusal: the fixture's event contracts and the simulated router are not on it.
 *
 * Answers under /api/ are never stored by the browser (cache-control: no-store). The page's own files are read from disk once per process
 * (NODE_ENV=development reads them each time) and go out compressed (brotli or gzip, as the browser asks; made once per content) under a
 * weak ETag of their content: the page itself is revalidated each time (no-cache) and names each of its scripts and styles with that
 * content's hash (?v=), which is kept a year unchanged (immutable); a file asked for without it, or with an older one, is revalidated.
 * The fonts (public/fonts, named by their version) are kept a year.
 */
import { createHash, randomBytes } from "node:crypto";
import express from "express";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isRefusal, type Refusal } from "../core/errors.ts";
import { parseIntent, parseOrder } from "./intents.ts";
import { no } from "./refuse.ts";
import { cardHash, type AccountPage } from "./account/exchange.ts";
import type { Envelope } from "./account/sign.ts";
import { agentCode, PRICES, type AgentId, type Intent } from "./accounts.ts";
import { AgentSession, PRESETS } from "./agent.ts";
import { BRIDGE_CHAINS } from "./live/bridge.ts";
import { STABLECOINS } from "./live/chain.ts";
import { exchangeList } from "./live/exchange.ts";
import { STABLES } from "./live/types.ts";
import { parseEventSymbol } from "./events.ts";
import type { OrderPlan } from "./router.ts";
import { isPending, loadOpenness, PortfolioService } from "./service.ts";
import { defaultHome } from "./home.ts";
import type { Side } from "./venues.ts";

const PUBLIC = fileURLToPath(new URL("./public/", import.meta.url));
/** the MCP seat an agent mounts (mcp.ts), by its absolute path: the command the page hands an agent's owner runs from any folder */
const MCP_ENTRY = fileURLToPath(new URL("./mcp.ts", import.meta.url));

/** the lists the door accepts, published with the page so that the page and the seats draw their choices from the same place: the dollar
 * stablecoins a movement may be in (live/types.ts), the chains they travel on (live/chain.ts STABLECOINS) and the chains a bridge goes
 * between (live/bridge.ts, Robinhood Chain in USDG among them) */
export const DOOR_LISTS = { dollars: [...STABLES], networks: [...new Set(STABLECOINS.map((s) => s.chain))], bridgeChains: [...BRIDGE_CHAINS] } as const;

/** one of the page's own files as the wire carries it: its bytes, the hash of its content (its ETag, and the ?v= the page names it with),
 * and its brotli and gzip forms, each made the first time a browser asks for it */
interface PageFile {
  body: Buffer;
  hash: string;
  br?: Buffer;
  gz?: Buffer;
}
/** the page's own files, read from disk once per process and kept (NODE_ENV=development reads them each time, for work on the page — and
 * keeps what was made of one whose content did not change); a name that is not there is none */
const pages = new Map<string, PageFile>();
function pageFile(rel: string): PageFile | undefined {
  const kept = pages.get(rel);
  if (kept !== undefined && process.env.NODE_ENV !== "development") return kept;
  let body: Buffer;
  try {
    body = readFileSync(join(PUBLIC, rel));
  } catch {
    return undefined;
  }
  const hash = createHash("sha256").update(body).digest("hex").slice(0, 16);
  if (kept && kept.hash === hash) return kept;
  const made: PageFile = { body, hash };
  pages.set(rel, made);
  return made;
}
/** the scripts and styles the page names, each named with its content's hash (?v=…): a browser keeps them a year, and a changed file is a
 * new name. The page so named is kept beside the page as written, until either changes */
const ASSET_REF = /(\b(?:src|href)=")(\/(?:ui\/[a-z0-9-]+\.(?:js|css)|owner\.js|account\.css))(")/g;
const versioned = new Map<string, { from: string; made: PageFile }>();
function pageVersioned(rel: string): PageFile | undefined {
  const page = pageFile(rel);
  if (!page) return undefined;
  const text = page.body.toString("utf8").replace(ASSET_REF, (all, pre: string, path: string, post: string) => {
    const f = pageFile(path.slice(1));
    return f ? `${pre}${path}?v=${f.hash}${post}` : all;
  });
  const kept = versioned.get(rel);
  if (kept && kept.from === text) return kept.made;
  const body = Buffer.from(text, "utf8");
  const made: PageFile = { body, hash: createHash("sha256").update(body).digest("hex").slice(0, 16) };
  versioned.set(rel, { from: text, made });
  return made;
}
/** the encoding a browser asked for, of the two kept: brotli first, then gzip, else none (one it refused with q=0 is not used) */
function encodingFor(accept: string | undefined): "br" | "gzip" | "" {
  const ok = new Set(
    String(accept ?? "")
      .split(",")
      .map((x) => x.trim().toLowerCase().split(";"))
      .filter(([, q]) => !q || !/^q=0(\.0*)?$/.test(q.trim()))
      .map(([name]) => name),
  );
  return ok.has("br") ? "br" : ok.has("gzip") ? "gzip" : "";
}
/** one of the page's own files on the wire: compressed as the browser asks (not a font, which is compressed already, nor a file under a
 * kilobyte), under a weak ETag of its content (the same for every encoding of it), answered 304 when the browser has it */
function sendPage(req: express.Request, res: express.Response, f: PageFile, type: string, cache: string, compress = true): void {
  const enc = compress && f.body.length >= 1024 ? encodingFor(req.headers["accept-encoding"]) : "";
  const etag = `W/"${f.hash}"`;
  res.setHeader("cache-control", cache);
  res.setHeader("etag", etag);
  if (compress) res.setHeader("vary", "Accept-Encoding");
  const asked = String(req.headers["if-none-match"] ?? "");
  if (asked && asked.split(",").some((x) => x.trim().replace(/^W\//, "") === etag.slice(2))) return void res.status(304).end();
  const body = enc === "br" ? (f.br ??= brotliCompressSync(f.body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11, [zlibConstants.BROTLI_PARAM_SIZE_HINT]: f.body.length } })) : enc === "gzip" ? (f.gz ??= gzipSync(f.body, { level: 9 })) : f.body;
  if (enc) res.setHeader("content-encoding", enc);
  res.type(type).send(body);
}
/* a file named with its content's hash is kept a year as it is; any other answer is revalidated each time */
const KEEP_A_YEAR = "public, max-age=31536000, immutable";

/** what the page reads of a REAL account, as it goes on the wire: the simulation's runway rows, doors, swap table, ledgers and address book
 * belong to no venue on it, so they do not travel (the type, account/exchange.ts AccountPage, still names them for the simulated statement);
 * the lists the door accepts go with it. Every field the page or a seat reads stays */
function realPage(view: AccountPage): Record<string, unknown> {
  const { destinations: _destinations, ...top } = view;
  return { ...top, venues: view.venues.map(({ runways: _runways, agentKey: _agentKey, in: _in, out: _out, swaps: _swaps, fiat: _fiat, ledgers: _ledgers, ...v }) => v), ...DOOR_LISTS };
}

/** The command that adds this account's MCP seat to Claude Code: the seat reaches this server at `origin`. A path with anything a shell
 * reads in it is quoted */
export function agentSetupOf(origin: string): { command: string; url: string } {
  const quote = (x: string) => (/^[A-Za-z0-9_./:@%+=,-]+$/.test(x) ? x : `'${x.replace(/'/g, `'\\''`)}'`);
  return { command: `claude mcp add portfolio -e PORTFOLIO_URL=${quote(origin)} -- npx tsx ${quote(MCP_ENTRY)}`, url: origin };
}

export interface PortfolioServerOptions {
  port: number;
  service: PortfolioService;
  /** how often the net worth curve gets a point (account/networth.ts), in milliseconds, on the real clock: 300000 (five minutes) unless
   * said; 0 takes none, nor the points a connection or a disconnection adds. Only with the account layer mounted */
  snapshotMs?: number | undefined;
}

export interface PortfolioServerHandle {
  url: string;
  close(): Promise<void>;
}

export { parseIntent, parseOrder } from "./intents.ts";

/** an order plan as an agent reads it: every venue's quote, the slices, what was left out and why */
export function quoteView(p: OrderPlan): Record<string, unknown> {
  const s = p.split;
  return {
    order: p.title,
    feasible: s.feasible,
    summary: p.narration,
    venues: s.quotes.map((q) => ({ venue: q.venue, account: q.account, name: q.name, canTakeAll: q.ok, ...(q.why ? { why: q.why } : {}), have: q.have, ...(q.price > 0 ? { price: q.price, feeUsd: q.feeUsd, netUsd: q.netUsd, impactBps: q.impactBps } : {}) })),
    slices: s.slices.map((x) => ({ venue: x.venue, account: x.account, name: x.name, qty: x.qty, price: x.price, feeUsd: x.feeUsd, netUsd: x.netUsd, ...(x.chain ? { chain: x.chain, gasUsd: x.gasUsd, route: x.route } : {}) })),
    ...(s.feasible ? { netUsd: s.netUsd, avgPrice: s.avgPrice } : { maxQty: s.maxQty }),
    ...(s.single ? { bestSingleVenue: { venue: s.single.venue, netUsd: s.single.netUsd } } : {}),
    ...(s.gainUsd !== undefined ? { gainOverSingleUsd: s.gainUsd } : {}),
    leftOut: s.passed,
    notes: [...p.notes, ...p.after],
  };
}

/** the agent an MCP client names itself as; anything else flies as an unnamed MCP agent */
export function parseAgent(raw: unknown): AgentId {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const name = typeof o.name === "string" && o.name.trim() ? o.name.trim().slice(0, 60) : "MCP agent";
  const id = typeof o.id === "string" && o.id.trim() ? o.id.trim().slice(0, 60) : name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const code = typeof o.code === "string" && /^[A-Z]{2,3}$/.test(o.code) ? o.code : agentCode(name);
  return { id, name, code };
}

/** the page a venue's sign-in sends the browser back to: whether it finished, in the account page's paper and ink, and nothing else */
function signedInPage(error?: string): string {
  const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Robinhood sign-in</title><style>:root{--paper:#f6f1e7;--ink:#1d1a16;--dim:#6b6358}@media (prefers-color-scheme:dark){:root{--paper:#17150f;--ink:#ece4d4;--dim:#a39a8a}}body{margin:0;padding:56px 16px;background:var(--paper);color:var(--ink);font:17px/1.55 Georgia,"Times New Roman",serif}main{max-width:520px;margin:0 auto}h1{font-weight:400;font-size:28px;margin:0 0 12px}p{color:var(--dim);margin:0}</style></head><body><main><h1>${error ? "The sign-in did not finish" : "Signed in at Robinhood"}</h1><p>${error ? esc(error) : "Go back to the account page: it carries on from here. This tab can be closed."}</p></main>${error ? "" : "<script>setTimeout(() => window.close(), 1500)</script>"}</body></html>`;
}

export async function startPortfolioServer(opts: PortfolioServerOptions): Promise<PortfolioServerHandle> {
  const svc = opts.service;
  const agent = new AgentSession(svc);
  /** this server's own origin, once it listens: what an agent's seat is pointed at */
  let origin = "";
  const app = express();
  app.use(express.json());
  // the account's answers are never stored by the browser (balances, keys, cards); the page's own files are kept and revalidated by their
  // ETag, which express puts on every answer it sends whole
  app.use((req, res, next) => {
    res.setHeader("cache-control", req.path.startsWith("/api/") ? "no-store" : "no-cache");
    next();
  });
  // a page file; one asked for by the hash of what it is now (?v=, as the page names it) is kept a year, anything else revalidated
  const file = (name: string, type: string) => (req: express.Request, res: express.Response) => {
    const f = pageFile(name);
    if (f === undefined) return void res.sendStatus(404);
    sendPage(req, res, f, type, req.query.v === f.hash ? KEEP_A_YEAR : "no-cache");
  };
  // one page: the account when the layer is mounted (its scripts and styles named by their content's hash), the original simulated
  // statement when it is not (--classic)
  app.get("/", (req, res) => {
    if (!svc.account) return file("index.html", "html")(req, res);
    const f = pageVersioned("account.html");
    if (f === undefined) return void res.sendStatus(404);
    sendPage(req, res, f, "html", "no-cache");
  });
  app.get("/portfolio.js", file("portfolio.js", "application/javascript"));
  app.get("/portfolio.css", file("portfolio.css", "text/css"));
  app.get("/account", (_req, res) => res.redirect(302, "/"));
  app.get("/account.css", file("account.css", "text/css"));
  app.get("/owner.js", file("owner.js", "application/javascript"));
  // the account page's own scripts and styles: a plain name in ui/ and .js or .css, nothing else. The pattern is matched on the path as it
  // arrived, before any decoding, so a folder, a second dot or anything percent-encoded is not a name here: it is a 404
  app.get(/^\/ui\/([a-z0-9-]+)\.(js|css)$/, (req, res) => {
    const [name, ext] = [req.params[0], req.params[1]];
    const f = pageFile(join("ui", `${name}.${ext}`));
    if (f === undefined) return void res.sendStatus(404);
    sendPage(req, res, f, ext === "js" ? "application/javascript" : "text/css", req.query.v === f.hash ? KEEP_A_YEAR : "no-cache");
  });
  // the page's two faces (SIL Open Font License, public/fonts/OFL.txt): a plain name and .woff2, nothing else; named by their version, so
  // kept a year
  app.get(/^\/fonts\/([a-z0-9-]+)\.woff2$/, (req, res) => {
    const f = pageFile(join("fonts", `${req.params[0]}.woff2`));
    if (f === undefined) return void res.sendStatus(404);
    sendPage(req, res, f, "font/woff2", KEEP_A_YEAR, false);
  });
  // the owner talks to the page's scripted agent through a signed instruction (setPolicy · say); this is where it lands
  svc.sayHandler = async (text) => (await agent.say(text.trim().slice(0, 200))).no;

  // A route that throws: a refusal thrown is answered as the refusal it is; anything else is answered with one fixed sentence, and what it
  // said goes to this process's log — no exception's words, paths or hosts reach the page or a seat
  const wrap = (fn: (req: express.Request, res: express.Response) => Promise<void> | void) => (req: express.Request, res: express.Response) => {
    Promise.resolve(fn(req, res)).catch((err: unknown) => {
      if (res.headersSent) return;
      if (isRefusal(err)) return void res.status(409).json({ ok: false, refusal: err });
      console.error(`${req.method} ${req.path}: ${String((err as Error)?.stack ?? (err as Error)?.message ?? err).slice(0, 600)}`);
      res.status(500).json({ ok: false, error: "The account hit an error answering this; it was recorded." });
    });
  };
  const bad = (res: express.Response, error: string) => res.status(400).json({ ok: false, error });
  /** a route's query parameters as strings, each cut to its length; one given twice is a malformed request — neither copy is picked */
  const strings = <K extends string>(req: express.Request, res: express.Response, want: Record<K, number>): Record<K, string> | undefined => {
    const out = {} as Record<K, string>;
    for (const k of Object.keys(want) as K[]) {
      const v = req.query[k];
      if (Array.isArray(v)) return void bad(res, `"${k}" is given more than once`);
      out[k] = typeof v === "string" ? v.slice(0, want[k]) : "";
    }
    return out;
  };

  // Only this machine's own pages and programs talk to the account: a request that names another site as its origin, or reaches it under a
  // host name that is not this server's (a DNS-rebinding page), is turned away before any route sees it. The page, the MCP seat and the
  // terminal scripts send no foreign origin and use 127.0.0.1 or localhost
  app.use((req, res, next) => {
    const host = String(req.headers.host ?? "");
    const local = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host);
    const origin = req.headers.origin;
    // a browser says where a request comes from (Fetch Metadata): another site's request is refused, except a top-level navigation — a link to
    // the page, or a venue's sign-in page sending the owner back (Robinhood's OAuth callback)
    const site = req.headers["sec-fetch-site"];
    const topLevel = req.headers["sec-fetch-mode"] === "navigate" && req.headers["sec-fetch-dest"] === "document" && req.method === "GET";
    const foreignOrigin = typeof origin === "string" && origin !== `${req.protocol}://${host}`;
    const foreignSite = (site === "cross-site" || site === "same-site") && !topLevel;
    if (!local || foreignOrigin || foreignSite) return void res.status(403).json({ ok: false, error: "this server answers only its own pages on this machine" });
    next();
  });

  /** the owner's routes and the agents' routes are closed to an unsigned caller once the account layer is mounted */
  const layer = () => svc.account !== undefined;
  const ownerOnly = (res: express.Response, what: string) => void res.status(401).json({ ok: false, refusal: no("E_ACCOUNT_OWNER_SURFACE", { tool: what, message: `${what} is the owner's: it arrives as a signed action at POST /api/exchange` }) });
  // on the real account the door an agent uses is the live one: the older write path is refused there, so it is not the one to point at
  const signedOnly = (res: express.Response, what: string, as: string) => void res.status(401).json({ ok: false, refusal: no("E_ACCOUNT_BAD_SIGNATURE", { tool: what, message: `${what} takes no unsigned caller: an authorised agent key signs ${svc.real ? "`agentLiveOrder` / `agentLiveMove`" : `\`${as}\``} at POST /api/exchange` }) });
  // the fixture's event contracts and the simulated router are the simulated statement's: a real account answers from its venues
  const simulatedOnly = (res: express.Response) => void res.status(409).json({ ok: false, refusal: no("E_ACCOUNT_BAD_ACTION", { message: "this account holds real accounts only: Markets is GET /api/account/explore, a price is GET /api/account/market" }) });

  app.get("/api/overview", wrap(async (_req, res) => {
    await svc.account?.settle();
    const o = await svc.overview();
    // no signed envelope leaves over HTTP: whoever reads this page learns that a row has one, and the ledger file holds it
    const ledger = layer() ? o.ledger.map(({ envelope, ...row }) => ({ ...row, ...(envelope !== undefined ? { signed: true } : {}) })) : o.ledger;
    // a real account quotes no route to a hub from the simulation's rail table: the ladder does not travel
    const { ladder, ...real } = o;
    res.json({ ...(svc.real ? real : o), ledger, approvals: layer() ? o.approvals.map((a) => ({ ...a, hash: cardHash(a) })) : o.approvals, presets: PRESETS, accountLayer: layer() });
  }));

  app.get("/api/now", (_req, res) => void res.json({ ok: true, now: svc.now(), ms: Date.parse(svc.now()) }));

  app.get("/api/account", wrap(async (req, res) => {
    const view = await svc.accountView();
    if (!view) return void res.status(404).json({ ok: false, error: "the account layer is not mounted (--classic)" });
    const o = svc.policy();
    // the dial as the page needs it: the agents' session, the venues switched off for agents, the most leverage they may set
    // and how each venue connected live has answered lately (its health, for the Venues board)
    // and the command an agent's owner runs to add this account's seat (the server's own origin, the seat by its absolute path)
    res.json({ ok: true, ...(view.real ? realPage(view) : view), mode: o.mode, live: svc.live, dial: { sessionExpiresAt: o.sessionExpiresAt, sessionEnded: Date.parse(o.sessionExpiresAt) <= Date.parse(view.now), revoked: o.revoked, maxLeverage: o.maxLeverage ?? 1 }, health: svc.venueHealth(), agentSetup: agentSetupOf(origin || `${req.protocol}://${req.get("host") ?? "127.0.0.1"}`) });
  }));

  app.post("/api/account/pair", (req, res) => {
    if (!svc.account) return void res.status(404).json({ ok: false, error: "the account layer is not mounted" });
    const { jwk, label, code } = req.body as { jwk?: unknown; label?: unknown; code?: unknown };
    const r = svc.account.pairDevice(jwk, typeof label === "string" && label.trim() ? label.trim().slice(0, 40) : "this browser", typeof code === "string" ? code.slice(0, 20) : undefined);
    res.status(isRefusal(r) ? 400 : 200).json(isRefusal(r) ? { ok: false, refusal: r } : r);
  });

  // the exchanges the unified library covers, for the page's list of real venues (the library is loaded on first ask)
  app.get("/api/account/exchanges", wrap(async (_req, res) => void res.json({ ok: true, exchanges: await exchangeList() })));

  // whether a key file is in place for a connection, before the owner connects it: its place, its permissions, the names of missing fields
  app.get("/api/account/keyfile", wrap(async (req, res) => {
    if (!svc.account) return void res.status(404).json({ ok: false, error: "the account layer is not mounted" });
    const q = strings(req, res, { kind: 200, venue: 200, ref: 200, exchange: 200 });
    if (!q) return;
    const needs = q.kind === "exchange" && q.exchange ? ((await exchangeList()).find((x) => x.id === q.exchange)?.needs ?? []) : [];
    res.json({ ok: true, ...svc.keyFile(q.kind, q.venue, q.ref, needs) });
  }));
  // Where this user can connect, every venue the account knows, judged from the network it runs on (live/availability.ts): each venue's own
  // answer to it and its own terms matched to where it is — the place itself is never in the answer. Kept 30 minutes; force=1 asks again
  app.get("/api/account/venues", wrap(async (req, res) => {
    if (!svc.account) return void res.status(404).json({ ok: false, error: "the account layer is not mounted" });
    const q = strings(req, res, { force: 5 });
    if (!q) return;
    const venues = await svc.venuesHere(q.force === "1");
    res.json({ ok: true, venues });
  }));
  // Before a key is made: whether each connection's venue answers from this machine at all (live/reach.ts) — its first, keyless question,
  // so the list of accounts says up front which venue does not serve this location, in its own words. No key, token or address is sent
  app.get("/api/account/connect/reach", wrap(async (req, res) => {
    if (!svc.account) return void res.status(404).json({ ok: false, error: "the account layer is not mounted" });
    const q = strings(req, res, { connector: 2000, force: 5 });
    if (!q) return;
    const list = [...new Set(q.connector.split(",").map((x) => x.trim()).filter(Boolean))];
    if (!list.length || list.length > 24 || list.some((c) => !/^live:[a-z0-9-]{1,40}(?::[a-z0-9-]{1,40})?$/.test(c))) return void bad(res, "connector is a comma-separated list of 1 to 24 connections, like live:exchange:okx,live:kalshi");
    res.json({ ok: true, reach: await svc.connectReach(list, q.force === "1") });
  }));

  // A wallet shows that an address is the user's by signing the sentence the account writes for it (EIP-4361). Nothing is connected by this:
  // connecting is still the owner's signed instruction, and without a proof the address is simply shown as watched.
  app.post("/api/account/wallet/challenge", (req, res) => {
    if (!svc.account) return void res.status(404).json({ ok: false, error: "the account layer is not mounted" });
    const { address, wallet, chainId } = req.body as { address?: unknown; wallet?: unknown; chainId?: unknown };
    const host = req.get("host") ?? "127.0.0.1";
    const r = svc.proofs.challenge(String(address ?? ""), String(wallet ?? ""), { domain: host, uri: `${req.protocol}://${host}/account` }, Number(chainId) || 1);
    res.status(isRefusal(r) ? 400 : 200).json(isRefusal(r) ? { ok: false, refusal: r } : { ok: true, address: r.address, message: r.message, expiresAt: r.expiresAt });
  });
  app.post("/api/account/wallet/prove", wrap(async (req, res) => {
    if (!svc.account) return void res.status(404).json({ ok: false, error: "the account layer is not mounted" });
    const { address, signature } = req.body as { address?: unknown; signature?: unknown };
    const r = await svc.proofs.prove(String(address ?? ""), String(signature ?? ""));
    res.status(isRefusal(r) ? 400 : 200).json(isRefusal(r) ? { ok: false, refusal: r } : { ok: true, address: r.address, wallet: r.wallet });
  }));

  // Signing in at a venue that speaks OAuth to MCP clients (Robinhood). The owner's browser goes to the venue's own page; the code it brings
  // back here is traded once for a token this process keeps in memory. Nothing is connected by this: connecting is still the owner's signed
  // instruction, which names the sign-in by its state.
  app.post("/api/account/signin/start", wrap(async (req, res) => {
    if (!svc.account) return void res.status(404).json({ ok: false, error: "the account layer is not mounted" });
    const kind = String((req.body as { connector?: unknown }).connector ?? "");
    const signIn = svc.signIn(kind);
    if (!signIn) return void bad(res, `there is no sign-in for "${kind.slice(0, 40)}"`);
    const host = req.get("host") ?? "127.0.0.1";
    const r = await signIn.start(`${req.protocol}://${host}/api/account/signin/callback`);
    res.status(isRefusal(r) ? 502 : 200).json(isRefusal(r) ? { ok: false, refusal: r } : { ok: true, url: r.url, state: r.state });
  }));
  app.get("/api/account/signin/status", (req, res) => {
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const signIn = svc.signInHolding(state);
    res.json({ ok: true, ...(signIn ? signIn.status(state) : { status: "unknown" }) });
  });
  app.get("/api/account/signin/callback", wrap(async (req, res) => {
    const text = (v: unknown) => (typeof v === "string" ? v : undefined);
    const q = req.query as Record<string, unknown>;
    const state = text(q.state) ?? "";
    const signIn = svc.signInHolding(state);
    const r = signIn ? await signIn.finish({ state, code: text(q.code), error: text(q.error), error_description: text(q.error_description), iss: text(q.iss) }) : no("E_ACCOUNT_BAD_ACTION", { message: "this sign-in is not one this server started, or it ran out: start it again from the account page" });
    res.status(isRefusal(r) ? 400 : 200).type("html").send(signedInPage(isRefusal(r) ? r.message : undefined));
  }));

  // the statement: every transaction at the real venues, from every ledger in this home (so it outlives a restart), newest first
  app.get("/api/account/statement", wrap(async (_req, res) => {
    if (!svc.account) return void res.status(404).json({ ok: false, error: "the account layer is not mounted" });
    await svc.account.settle();
    res.json({ ok: true, lines: svc.statement() });
  }));

  // the markets a venue connected live trades, and one market with a fresh price: what the order ticket and an agent read before an order
  app.get("/api/account/markets", wrap(async (req, res) => {
    if (!svc.account) return void res.status(404).json({ ok: false, error: "the account layer is not mounted" });
    const q = strings(req, res, { venue: 120, q: 120 });
    if (!q) return;
    const r = await svc.liveMarkets(q.venue, q.q);
    res.status(isRefusal(r) ? 409 : 200).json(isRefusal(r) ? { ok: false, refusal: r } : { ok: true, markets: r });
  }));
  app.get("/api/account/market", wrap(async (req, res) => {
    if (!svc.account) return void res.status(404).json({ ok: false, error: "the account layer is not mounted" });
    const q = strings(req, res, { venue: 160, symbol: 160 });
    if (!q) return;
    const r = await svc.liveMarket(q.venue, q.symbol);
    res.status(isRefusal(r) ? 409 : 200).json(isRefusal(r) ? { ok: false, refusal: r } : { ok: true, market: r });
  }));

  // the same coin or stock at every venue connected live, ranked by the price an order would take there; `asset` (stock | crypto) says
  // which is meant where a name is both a coin and a stock, and anything else there is ignored
  app.get("/api/account/compare", wrap(async (req, res) => {
    if (!svc.account) return void res.status(404).json({ ok: false, error: "the account layer is not mounted" });
    const q = strings(req, res, { base: 60, side: 60, usd: 60, asset: 20 });
    if (!q) return;
    const usd = Number(q.usd);
    const asset = q.asset === "stock" || q.asset === "crypto" ? q.asset : undefined;
    const r = await svc.liveCompare(q.base, q.side === "sell" ? "sell" : "buy", usd > 0 ? usd : undefined, asset);
    res.status(isRefusal(r) ? 409 : 200).json(isRefusal(r) ? { ok: false, refusal: r } : { ok: true, ...r });
  }));

  // what is held at a venue connected live — perpetuals, shares, event contracts — or, with no venue named, at every one that lists positions
  // (each venue that could not be read is in `missing`). A read
  app.get("/api/account/positions", wrap(async (req, res) => {
    if (!svc.account) return void res.status(404).json({ ok: false, error: "the account layer is not mounted" });
    const q = strings(req, res, { venue: 40 });
    if (!q) return;
    if (!q.venue) {
      const all = await svc.allPositions();
      return void res.status(isRefusal(all) ? 409 : 200).json(isRefusal(all) ? { ok: false, refusal: all } : { ok: true, ...all });
    }
    const r = await svc.livePositions(q.venue);
    res.status(isRefusal(r) ? 409 : 200).json(isRefusal(r) ? { ok: false, refusal: r } : { ok: true, positions: r });
  }));

  // ---- the wallet's reads: Portfolio · Markets · Trade, and the agents one by one. None of them orders, moves or signs anything ----
  const mounted = (res: express.Response) => (svc.account ? true : void res.status(404).json({ ok: false, error: "the account layer is not mounted (--classic)" }));
  const answerOf = <T extends object>(res: express.Response, r: T | Refusal, key?: string) => void res.status(isRefusal(r) ? 409 : 200).json(isRefusal(r) ? { ok: false, refusal: r } : key ? { ok: true, [key]: r } : { ok: true, ...r });

  // MARKETS: what there is to trade, at the connected venues and (keyless, "Connect to trade") at the venues not connected. A limit is a
  // plain count of markets (digits), nothing a number parser would also take
  app.get("/api/account/explore", wrap(async (req, res) => {
    if (!mounted(res)) return;
    const q = strings(req, res, { tab: 20, q: 80, sort: 20, limit: 6 });
    if (!q) return;
    if (q.limit && !/^\d{1,3}$/.test(q.limit)) return void bad(res, "limit is a count of markets, 1 to 200, in digits");
    answerOf(res, await svc.explore({ tab: q.tab, q: q.q, sort: q.sort, ...(q.limit ? { limit: Number(q.limit) } : {}) }));
  }));

  // PORTFOLIO: what is held, by asset across every venue, the dollars that are ready, the last 24 hours; `cost=1` adds what was paid
  app.get("/api/account/holdings", wrap(async (req, res) => {
    if (!mounted(res)) return;
    const q = strings(req, res, { cost: 5 });
    if (!q) return;
    answerOf(res, await svc.holdings({ cost: q.cost === "1" }));
  }));

  // the net worth curve: range 1d · 1w · 1m · all
  app.get("/api/account/history", wrap(async (req, res) => {
    if (!mounted(res)) return;
    const q = strings(req, res, { range: 10 });
    if (!q) return;
    answerOf(res, svc.history(q.range || "1d"));
  }));

  // where to send an asset on a network so that it lands at a venue: the exchange's own deposit address, or a proven wallet's own
  app.get("/api/account/receive", wrap(async (req, res) => {
    if (!mounted(res)) return;
    const q = strings(req, res, { venue: 40, asset: 20, network: 30 });
    if (!q) return;
    answerOf(res, await svc.receive(q.venue, q.asset, q.network));
  }));

  // one asset: its row, every venue's price, its price history, positions, open orders, statement lines and cost
  app.get("/api/account/asset", wrap(async (req, res) => {
    if (!mounted(res)) return;
    const q = strings(req, res, { key: 140, interval: 4 });
    if (!q) return;
    answerOf(res, await svc.asset(q.key, q.interval || "1h"));
  }));

  // a fresh price for each of up to twelve markets: ?pairs=okx|BTC/USDT,kalshi|KXFED-25DEC-T4.00:YES (or one ?pair= each). How many is
  // the service's rule, answered as its refusal; the shape of each is this route's
  app.get("/api/account/quotes", wrap(async (req, res) => {
    if (!mounted(res)) return;
    const list = (v: unknown): string[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]).filter((x): x is string => typeof x === "string");
    const pairs = [...list(req.query.pairs).flatMap((x) => x.split(",")), ...list(req.query.pair)].map((x) => x.trim()).filter(Boolean);
    const parsed = pairs.map((x) => ({ venue: x.slice(0, Math.max(0, x.indexOf("|"))), symbol: x.slice(x.indexOf("|") + 1).slice(0, 160) }));
    if (parsed.some((p) => !p.venue || !p.symbol)) return void bad(res, "each market is venue|symbol, e.g. okx|BTC/USDT");
    answerOf(res, await svc.quotes(parsed), "quotes");
  }));

  // TRADE · Sell many: everything held that is not a dollar, with what selling it at its venue would sign
  app.get("/api/account/sellable", wrap(async (_req, res) => {
    if (!mounted(res)) return;
    answerOf(res, await svc.sellable());
  }));

  // the agents one by one: each key's standing, its limits (spent, held, left), cards, orders, payments, wallets, intents, asks, flights
  app.get("/api/account/agents", wrap(async (_req, res) => {
    if (!mounted(res)) return;
    answerOf(res, await svc.agents());
  }));

  // one market's price history: a connected venue's own, or a public source's without a key. The venue is an id the account knows and the
  // symbol plain text: neither ever names a host (service.ts candles)
  app.get("/api/account/candles", wrap(async (req, res) => {
    if (!mounted(res)) return;
    const q = strings(req, res, { venue: 60, symbol: 200, interval: 4 });
    if (!q) return;
    answerOf(res, await svc.candles(q.venue, q.symbol, q.interval || "1h"));
  }));

  // EARN: the products the venues connected live offer, in one asset when asked, and what is in them (each venue not read is in `missing`)
  app.get("/api/account/earn", wrap(async (req, res) => {
    if (!mounted(res)) return;
    const q = strings(req, res, { venue: 40, asset: 20 });
    if (!q) return;
    answerOf(res, await svc.earn({ venue: q.venue || undefined, asset: q.asset || undefined }));
  }));

  // the routes a bridge could take across chains from a wallet of the owner's, the one the account would sign for first (a read)
  app.post("/api/account/bridge-routes", wrap(async (req, res) => {
    if (!svc.account) return void res.status(404).json({ ok: false, error: "the account layer is not mounted" });
    const draft = (req.body as { draft?: unknown }).draft;
    if (!draft || typeof draft !== "object") return void bad(res, "need {draft: {from, to, network, toLedger, asset, toAsset, amount}}");
    const r = await svc.account.live.bridgeRoutes(draft as Record<string, unknown>);
    res.status(isRefusal(r) ? 409 : 200).json(isRefusal(r) ? { ok: false, refusal: r } : { ok: true, routes: r });
  }));

  // the page says which transaction the wallet sent for a DEX order that was waiting for it; the chain decides from then on
  app.post("/api/account/live/order-sent", wrap(async (req, res) => {
    if (!svc.account) return void res.status(404).json({ ok: false, error: "the account layer is not mounted" });
    const { order, hash } = req.body as { order?: unknown; hash?: unknown };
    const r = await svc.account.serially(() => svc.account!.trade.sent(String(order ?? ""), String(hash ?? "")));
    res.status(isRefusal(r) ? 409 : 200).json(isRefusal(r) ? { ok: false, refusal: r } : r);
  }));

  // a wallet order whose approval is on chain: the swap is built again from a fresh quote before the wallet is asked to send it
  app.post("/api/account/live/order-requote", wrap(async (req, res) => {
    if (!svc.account) return void res.status(404).json({ ok: false, error: "the account layer is not mounted" });
    const { order } = req.body as { order?: unknown };
    const r = await svc.account.serially(() => svc.account!.trade.requote(String(order ?? "")));
    res.status(isRefusal(r) ? 409 : 200).json(isRefusal(r) ? { ok: false, refusal: r } : r);
  }));

  // the page says which transaction the wallet sent for a real-money payment that was waiting for it; the chain decides whether it is that one
  app.post("/api/account/live/sent", wrap(async (req, res) => {
    if (!svc.account) return void res.status(404).json({ ok: false, error: "the account layer is not mounted" });
    const { payment, hash } = req.body as { payment?: unknown; hash?: unknown };
    const r = await svc.account.serially(() => svc.account!.live.sent(String(payment ?? ""), String(hash ?? "")));
    res.status(isRefusal(r) ? 409 : 200).json(isRefusal(r) ? { ok: false, refusal: r } : r);
  }));

  app.post("/api/account/prepare", wrap(async (req, res) => {
    if (!svc.account) return void res.status(404).json({ ok: false, error: "the account layer is not mounted" });
    const draft = (req.body as { draft?: unknown }).draft;
    if (!draft || typeof draft !== "object") return void bad(res, "need {draft: {type, ...}}");
    const r = await svc.account.prepare(draft as Record<string, unknown>);
    res.status(isRefusal(r) ? 409 : 200).json(isRefusal(r) ? { ok: false, refusal: r } : r);
  }));

  app.post("/api/exchange", wrap(async (req, res) => {
    const r = await svc.exchange(req.body as Envelope);
    if (isRefusal(r)) return void res.status(["E_ACCOUNT_BAD_SIGNATURE", "E_ACCOUNT_UNKNOWN_SIGNER", "E_ACCOUNT_AGENT_EXPIRED", "E_ACCOUNT_AGENT_REVOKED"].includes(r.code) ? 401 : 409).json({ ok: false, refusal: r });
    res.status(r.kind === "card" ? 202 : 200).json(r);
  }));
  app.get("/api/read", wrap(async (req, res) => void res.json({ ok: true, holdings: await svc.read(typeof req.query.account === "string" ? req.query.account : undefined) })));

  app.post("/api/say", wrap(async (req, res) => {
    if (layer()) return ownerOnly(res, "talking to the page's agent");
    const { text } = req.body as { text?: string };
    if (!text || !text.trim()) return void bad(res, "need {text}");
    res.json({ ok: true, flight: await agent.say(text.trim().slice(0, 200)) });
  }));

  app.post("/api/approve", wrap(async (req, res) => {
    if (layer()) return ownerOnly(res, "answering a card");
    const { id, decision } = req.body as { id?: string; decision?: string };
    if (!id || (decision !== "approve" && decision !== "reject")) return void bad(res, "need {id, decision: approve|reject}");
    const r = await svc.decide(id, decision);
    if (isRefusal(r) && r.code === "E_CARD_NOT_GRANTED") return void res.status(404).json({ ok: false, refusal: r });
    res.json({ ok: true, result: r, decision });
  }));

  app.post("/api/execute", wrap(async (req, res) => {
    if (layer()) return signedOnly(res, "/api/execute", "agentExecute");
    const { account, intent, agent: who } = req.body as { account?: string; intent?: unknown; agent?: unknown };
    const parsed = parseIntent(intent);
    if (!account || !parsed) return void bad(res, "need {account, intent: {kind: trade|move|pay|subscribe|redeem, ...}}");
    const r = await svc.execute(account, parsed, parseAgent(who));
    if (isRefusal(r)) return void res.status(409).json({ ok: false, refusal: r });
    if (isPending(r)) return void res.status(202).json(r);
    res.json(r);
  }));

  app.get("/api/markets", (_req, res) => (svc.real ? simulatedOnly(res) : void res.json({ ok: true, markets: svc.markets() })));

  app.get("/api/quote", wrap(async (req, res) => {
    if (svc.real) return simulatedOnly(res);
    const o = parseOrder(req.query);
    if (!o) return void bad(res, "need ?base=<ETH|BTC|SOL or an event contract like FED-DEC-HIKE25:YES>&side=buy|sell&qty=<number>");
    res.json({ ok: true, quote: quoteView(await svc.quote(o.base, o.side, o.qty)) });
  }));

  app.post("/api/order", wrap(async (req, res) => {
    if (layer()) return signedOnly(res, "/api/order", "agentOrder");
    const o = parseOrder(req.body);
    if (!o) return void bad(res, "need {base: <ETH|BTC|SOL or an event contract like FED-DEC-HIKE25:YES>, side: buy|sell, qty}");
    const r = await svc.order(o.base, o.side, o.qty, parseAgent((req.body as { agent?: unknown }).agent));
    const legs = r.flight.legs.map((l) => `${l.mark === "ok" ? "✓" : l.mark === "no" ? "✗" : l.mark === "wait" ? "▣" : "·"} ${l.text}${l.compare ? ` (${l.compare})` : ""}`);
    const body = { flight: r.flight.no, legs, quote: quoteView(r.plan) };
    const refused = r.outcomes.find(isRefusal);
    const pending = r.outcomes.find(isPending);
    if (!r.plan.steps.length) return void res.status(409).json({ ok: false, error: r.plan.narration, ...body });
    if (refused) return void res.status(409).json({ ok: false, refusal: refused, ...body });
    if (pending) return void res.status(202).json({ ok: true, pending: true, approval: pending.approval, ...body });
    res.json({ ok: true, ...body });
  }));

  app.post("/api/mode", (req, res) => {
    const { mode } = req.body as { mode?: string };
    if (mode !== "open" && mode !== "guard") return void bad(res, "mode must be open | guard");
    // tightening is free; opening the dial is the owner's to sign
    if (layer() && mode === "open") return ownerOnly(res, "opening the dial");
    svc.setMode(mode);
    res.json({ ok: true, mode });
  });

  app.post("/api/revoke", (req, res) => {
    const { account } = req.body as { account?: string };
    if (!account) return void bad(res, "need {account}");
    const r = svc.revoke(account);
    if (isRefusal(r)) return void res.status(404).json({ ok: false, refusal: r });
    res.json(r);
  });

  app.post("/api/restore", (req, res) => {
    if (layer()) return ownerOnly(res, "switching an account back on");
    const { account } = req.body as { account?: string };
    if (!account) return void bad(res, "need {account}");
    const r = svc.restore(account);
    if (isRefusal(r)) return void res.status(404).json({ ok: false, refusal: r });
    res.json(r);
  });

  app.post("/api/reset", (_req, res) => {
    if (layer()) return ownerOnly(res, "resetting the simulation");
    svc.reset();
    res.json({ ok: true });
  });

  const server: Server = await new Promise((resolve, reject) => {
    const s = app.listen(opts.port, "127.0.0.1", () => resolve(s));
    s.on("error", reject);
  });
  const bound = server.address();
  origin = `http://127.0.0.1:${typeof bound === "object" && bound ? bound.port : opts.port}`;

  // The net worth curve: a point every five minutes on the real clock, one once a restart has connected the venues again, and one when the
  // owner connects or disconnects a venue (marked on the curve, never counted as a gain or a loss). One at a time, in order; none after close
  const every = opts.snapshotMs ?? 300_000;
  let closed = false;
  let snapping: Promise<unknown> = Promise.resolve();
  let timer: ReturnType<typeof setInterval> | undefined;
  if (svc.account && every > 0) {
    const snap = (event?: Parameters<NonNullable<PortfolioService["onConnection"]>>[0]) => {
      if (closed) return;
      snapping = snapping.then(() => (closed ? undefined : svc.snapshot(event))).catch(() => undefined);
    };
    svc.onConnection = (e) => snap(e);
    timer = setInterval(() => snap(), every);
    timer.unref();
    void Promise.resolve(svc.restoring).then(() => snap());
  }
  return {
    url: `http://127.0.0.1:${typeof bound === "object" && bound ? bound.port : opts.port}`,
    close: async () => {
      closed = true;
      if (timer) clearInterval(timer);
      svc.onConnection = undefined;
      await snapping;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

/** eight characters a person can read off a terminal and type: no 0/O, no 1/I/L */
export function pairingCode(): string {
  const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  const bytes = randomBytes(8);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

export { defaultHome };

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const at = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const port = Number(at("--port") ?? 4820);
  const classic = args.includes("--classic");
  // the `mm` reads stand in for the simulated statement's MetaMask: a real account connects MetaMask from the page instead
  const live = (args.includes("--mm") || process.env.PORTFOLIO_MM === "1") && classic;
  if (!classic && args.includes("--mm")) console.log("--mm is for --classic: on your account, connect MetaMask from the page (it uses the same mm)");
  // REAL orders and movements at venues connected live: on for the account (an airport where nothing takes off is no airport), off with
  // --read-only. With them on, the first owner pairs with a code printed here, in the terminal; every order is the owner's signature or
  // inside a limit the owner signed, and none is worth more than --live-cap
  const capUsd = Number(at("--live-cap") ?? 100);
  if (!(capUsd > 0)) throw new Error("--live-cap is a number of dollars, more than zero");
  const readOnly = args.includes("--read-only");
  if (readOnly && args.includes("--live-writes")) throw new Error("--read-only and --live-writes say opposite things: pick one");
  // the first owner pairs with a code printed here whether or not trading is on: an owner let in without one would own the account's later
  // runs too, trading and all
  const code = classic ? undefined : pairingCode();
  const liveWrites = !readOnly && !classic ? { capUsd, pairingCode: code! } : undefined;
  // the fixture's session ends on a fixed date; a server on the real clock gets thirty days from when it starts
  const openness = loadOpenness() as { sessionExpiresAt?: string };
  const month = new Date(Date.now() + 30 * 86_400_000).toISOString();
  // a real account continues its earlier runs — the owner's device, the venues, the agents and their limits come back (account/restore.ts);
  // --fresh starts it from nothing
  const fresh = args.includes("--fresh");
  const service = await PortfolioService.create({ home: at("--home") ?? defaultHome(), live, fresh, ...(liveWrites ? { liveWrites } : {}), ...(code ? { pairingCode: code } : {}), ...(classic ? {} : { venues: "frontline" as const, real: true, openness: { ...openness, sessionExpiresAt: (openness.sessionExpiresAt ?? "") > month ? openness.sessionExpiresAt : month } }) });
  const srv = await startPortfolioServer({ port, service }).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "EADDRINUSE") throw e;
    // the usual reason: this server is already running in another terminal
    console.error(`port ${port} is already in use: a portfolio server is probably running already. Open http://127.0.0.1:${port}/account, or start a second one: npm run portfolio -- --port ${port + 1} --home <another directory>`);
    process.exit(1);
  });
  const r = service.restored;
  if (r) console.log(`restored from ${r.runs} earlier run${r.runs === 1 ? "" : "s"} (since ${r.from}): ${r.owner ? "your browser is still the owner" : "no owner yet"} · ${r.agents} agent${r.agents === 1 ? "" : "s"} · ${r.limits} limit${r.limits === 1 ? "" : "s"} · ${r.venues.length} venue${r.venues.length === 1 ? "" : "s"} connecting again · ${r.orders + r.payments} in flight followed again · ${r.mode}${r.skipped.length ? `\n  not brought back: ${r.skipped.join("; ")}` : ""}\n  (--fresh starts the account from nothing)`);
  const owned = (service.account?.state.owners.length ?? 0) > 0;
  if (liveWrites) console.log(`TRADING IS ON · real orders and movements at the accounts you connect · at most $${liveWrites.capUsd} an order or a movement (--live-cap; --read-only turns it off) · every one is signed by you, or inside a limit you signed for an agent · money leaves a venue only for a place shown to be yours${owned ? "" : `\n  pairing code: ${liveWrites.pairingCode} — the first browser becomes the owner only with this code, typed on the page`}`);
  else if (!classic) console.log(`read-only: nothing is traded or moved from this server (started with --read-only)${owned ? "" : `\n  pairing code: ${code} — the first browser becomes the owner only with this code, typed on the page`}`);
  console.log(classic ? `simulated statement at ${srv.url} · ${service.accounts().length} accounts · MetaMask ${live ? "LIVE via mm" : "simulated (--mm for live)"} · no account layer · ledger ${service.ledgerPath()} · Ctrl-C to stop` : `your account at ${srv.url} · real accounts only: connect them on the page · ledger ${service.ledgerPath()} · Ctrl-C to stop`);
  // where the owner can connect, kept fresh without anyone asking: the venues' own answers to this network, and their terms matched to where
  // it is (live/availability.ts) — so the page and the agents know before anyone makes a key
  if (!classic && service.account) service.watchVenues();
  const stop = () => srv.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
