/** The portfolio page — one statement — and the API behind it and the MCP server.
 *
 *   npm run portfolio                 → http://127.0.0.1:4820 (simulated MetaMask)
 *   npm run portfolio -- --mm         → the MetaMask account reads the real `mm` CLI (LIVE)
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
 * With the account layer mounted (the default for this server; `--classic` runs the original eight accounts without it):
 *
 *   GET  /account                      the Account page: balances and runways, payments, agent keys, approvals, sub-accounts, signers
 *   GET  /api/account                  what that page reads
 *   GET  /api/now                      the service's clock (a signer takes its nonce from here)
 *   POST /api/account/pair   {jwk}     a browser offers the public half of its device key; the first one becomes the owner's device
 *   POST /api/account/prepare {draft}  turn what the owner asked for into the exact action to sign (a movement gets its route, fee and arrival)
 *   POST /api/exchange {action, nonce, signature}   THE door: every instruction, signed — an owner action by an owner key, an agent's by an
 *                                      authorised agent key (200 done · 202 a card is waiting · 401 not a signer · 409 refused)
 *
 * and the routes above change: /api/execute and /api/order take no unsigned caller (an agent signs `agentExecute` / `agentOrder` at the door);
 * /api/say, /api/approve, /api/restore, /api/reset and opening the dial are the owner's and arrive as signed actions; tightening (Guard, an
 * account off) stays free.
 */
import { randomBytes } from "node:crypto";
import express from "express";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isRefusal } from "../core/errors.ts";
import { parseIntent, parseOrder } from "./intents.ts";
import { no } from "./refuse.ts";
import { cardHash } from "./account/exchange.ts";
import type { Envelope } from "./account/sign.ts";
import { agentCode, PRICES, type AgentId, type Intent } from "./accounts.ts";
import { AgentSession, PRESETS } from "./agent.ts";
import { exchangeList } from "./live/exchange.ts";
import { parseEventSymbol } from "./events.ts";
import type { OrderPlan } from "./router.ts";
import { isPending, loadOpenness, PortfolioService } from "./service.ts";
import type { Side } from "./venues.ts";

const PUBLIC = fileURLToPath(new URL("./public/", import.meta.url));

export interface PortfolioServerOptions {
  port: number;
  service: PortfolioService;
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
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.setHeader("cache-control", "no-store");
    next();
  });
  const file = (name: string, type: string) => (_req: express.Request, res: express.Response) => res.type(type).send(readFileSync(join(PUBLIC, name), "utf8"));
  app.get("/", file("index.html", "html"));
  app.get("/portfolio.js", file("portfolio.js", "application/javascript"));
  app.get("/portfolio.css", file("portfolio.css", "text/css"));
  app.get("/account", file("account.html", "html"));
  app.get("/account.js", file("account.js", "application/javascript"));
  app.get("/account.css", file("account.css", "text/css"));
  app.get("/owner.js", file("owner.js", "application/javascript"));
  // the owner talks to the page's scripted agent through a signed instruction (setPolicy · say); this is where it lands
  svc.sayHandler = async (text) => (await agent.say(text.trim().slice(0, 200))).no;

  const wrap = (fn: (req: express.Request, res: express.Response) => Promise<void> | void) => (req: express.Request, res: express.Response) => {
    Promise.resolve(fn(req, res)).catch((err: unknown) => res.status(500).json({ ok: false, error: (err as Error).message }));
  };
  const bad = (res: express.Response, error: string) => res.status(400).json({ ok: false, error });

  /** the owner's routes and the agents' routes are closed to an unsigned caller once the account layer is mounted */
  const layer = () => svc.account !== undefined;
  const ownerOnly = (res: express.Response, what: string) => void res.status(401).json({ ok: false, refusal: no("E_ACCOUNT_OWNER_SURFACE", { tool: what, message: `${what} is the owner's: it arrives as a signed action at POST /api/exchange` }) });
  const signedOnly = (res: express.Response, what: string, as: string) => void res.status(401).json({ ok: false, refusal: no("E_ACCOUNT_BAD_SIGNATURE", { tool: what, message: `${what} takes no unsigned caller: an authorised agent key signs \`${as}\` at POST /api/exchange` }) });

  app.get("/api/overview", wrap(async (_req, res) => {
    await svc.account?.settle();
    const o = await svc.overview();
    // no signed envelope leaves over HTTP: whoever reads this page learns that a row has one, and the ledger file holds it
    const ledger = layer() ? o.ledger.map(({ envelope, ...row }) => ({ ...row, ...(envelope !== undefined ? { signed: true } : {}) })) : o.ledger;
    res.json({ ...o, ledger, approvals: layer() ? o.approvals.map((a) => ({ ...a, hash: cardHash(a) })) : o.approvals, presets: PRESETS, accountLayer: layer() });
  }));

  app.get("/api/now", (_req, res) => void res.json({ ok: true, now: svc.now(), ms: Date.parse(svc.now()) }));

  app.get("/api/account", wrap(async (_req, res) => {
    const view = await svc.accountView();
    if (!view) return void res.status(404).json({ ok: false, error: "the account layer is not mounted (--classic)" });
    res.json({ ok: true, ...view, mode: svc.policy().mode, live: svc.live });
  }));

  app.post("/api/account/pair", (req, res) => {
    if (!svc.account) return void res.status(404).json({ ok: false, error: "the account layer is not mounted" });
    const { jwk, label, code } = req.body as { jwk?: unknown; label?: unknown; code?: unknown };
    const r = svc.account.pairDevice(jwk, typeof label === "string" && label.trim() ? label.trim().slice(0, 40) : "this browser", typeof code === "string" ? code.slice(0, 20) : undefined);
    res.status(isRefusal(r) ? 400 : 200).json(isRefusal(r) ? { ok: false, refusal: r } : r);
  });

  // the exchanges the unified library covers, for the page's list of real venues (the library is loaded on first ask)
  app.get("/api/account/exchanges", wrap(async (_req, res) => void res.json({ ok: true, exchanges: await exchangeList() })));

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

  // the page says which transaction the wallet sent for a real-money payment that was waiting for it; the chain decides whether it is that one
  app.post("/api/account/live/sent", wrap(async (req, res) => {
    if (!svc.account) return void res.status(404).json({ ok: false, error: "the account layer is not mounted" });
    const { payment, hash } = req.body as { payment?: unknown; hash?: unknown };
    const r = await svc.account.live.sent(String(payment ?? ""), String(hash ?? ""));
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

  app.get("/api/markets", (_req, res) => void res.json({ ok: true, markets: svc.markets() }));

  app.get("/api/quote", wrap(async (req, res) => {
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
  return {
    url: `http://127.0.0.1:${typeof bound === "object" && bound ? bound.port : opts.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** eight characters a person can read off a terminal and type: no 0/O, no 1/I/L */
export function pairingCode(): string {
  const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  const bytes = randomBytes(8);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

export function defaultHome(): string {
  return process.env.BUYER_HOME ?? join(homedir(), ".buyer-agent-demo");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const at = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const port = Number(at("--port") ?? 4820);
  const live = args.includes("--mm") || process.env.PORTFOLIO_MM === "1";
  const classic = args.includes("--classic");
  // REAL money at venues connected live: off unless asked for here, in the terminal, where the code the first owner types is printed
  const capUsd = Number(at("--live-cap") ?? 100);
  if (!(capUsd > 0)) throw new Error("--live-cap is a number of dollars, more than zero");
  const liveWrites = args.includes("--live-writes") && !classic ? { capUsd, pairingCode: pairingCode() } : undefined;
  // the fixture's session ends on a fixed date; a server on the real clock gets thirty days from when it starts
  const openness = loadOpenness() as { sessionExpiresAt?: string };
  const month = new Date(Date.now() + 30 * 86_400_000).toISOString();
  const service = await PortfolioService.create({ home: at("--home") ?? defaultHome(), live, ...(liveWrites ? { liveWrites } : {}), ...(classic ? {} : { venues: "frontline" as const, openness: { ...openness, sessionExpiresAt: (openness.sessionExpiresAt ?? "") > month ? openness.sessionExpiresAt : month } }) });
  const srv = await startPortfolioServer({ port, service }).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "EADDRINUSE") throw e;
    // the usual reason: this server is already running in another terminal
    console.error(`port ${port} is already in use: a portfolio server is probably running already. Open http://127.0.0.1:${port}/account, or start a second one: npm run portfolio -- --port ${port + 1} --home <another directory>`);
    process.exit(1);
  });
  if (liveWrites) console.log(`REAL-MONEY WRITES ARE ON · at most $${liveWrites.capUsd} a movement (--live-cap) · every one is signed by the owner, and money goes only to places shown to be the owner's\n  pairing code: ${liveWrites.pairingCode} — the first browser becomes the owner only with this code, typed on the page`);
  console.log(`agent portfolio manager at ${srv.url} · ${service.accounts().length} accounts · MetaMask ${live ? "LIVE via mm" : "simulated (--mm for live)"}${classic ? " · classic (no account layer)" : ` · account page ${srv.url}/account`} · ledger ${service.ledgerPath()} · Ctrl-C to stop`);
  const stop = () => srv.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
