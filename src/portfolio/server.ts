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
 *   POST /api/mode    {mode}           open | guard
 *   POST /api/revoke  {account} · POST /api/restore {account}   an account's switch
 *   POST /api/reset
 */
import express from "express";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isRefusal } from "../core/errors.ts";
import { agentCode, type AgentId, type Intent } from "./accounts.ts";
import { AgentSession, PRESETS } from "./agent.ts";
import { isPending, PortfolioService } from "./service.ts";

const PUBLIC = fileURLToPath(new URL("./public/", import.meta.url));

export interface PortfolioServerOptions {
  port: number;
  service: PortfolioService;
}

export interface PortfolioServerHandle {
  url: string;
  close(): Promise<void>;
}

/** a lenient parse of the intent the MCP server sends; numbers may arrive as strings */
export function parseIntent(raw: unknown): Intent | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  switch (o.kind) {
    case "trade": {
      const qty = num(o.qty);
      const side = str(o.side);
      if (!str(o.symbol) || !(qty > 0) || (side !== "buy" && side !== "sell")) return null;
      return { kind: "trade", symbol: str(o.symbol).toUpperCase(), side, qty };
    }
    case "move": {
      const amount = num(o.amount);
      if (!str(o.asset) || !(amount > 0) || !str(o.to)) return null;
      const chainId = num(o.chainId);
      return Number.isFinite(chainId) ? { kind: "move", asset: str(o.asset).toUpperCase(), amount, to: str(o.to), chainId } : { kind: "move", asset: str(o.asset).toUpperCase(), amount, to: str(o.to) };
    }
    case "pay": {
      const amountUsd = num(o.amountUsd);
      if (!str(o.merchant) || !str(o.mcc) || !(amountUsd > 0)) return null;
      return { kind: "pay", merchant: str(o.merchant), mcc: str(o.mcc), amountUsd };
    }
    case "subscribe":
    case "redeem": {
      const amountUsd = num(o.amountUsd);
      if (!str(o.fund) || !(amountUsd > 0)) return null;
      return { kind: o.kind, fund: str(o.fund).toUpperCase(), amountUsd };
    }
    default:
      return null;
  }
}

/** the agent an MCP client names itself as; anything else flies as an unnamed MCP agent */
export function parseAgent(raw: unknown): AgentId {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const name = typeof o.name === "string" && o.name.trim() ? o.name.trim().slice(0, 60) : "MCP agent";
  const id = typeof o.id === "string" && o.id.trim() ? o.id.trim().slice(0, 60) : name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const code = typeof o.code === "string" && /^[A-Z]{2,3}$/.test(o.code) ? o.code : agentCode(name);
  return { id, name, code };
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

  const wrap = (fn: (req: express.Request, res: express.Response) => Promise<void> | void) => (req: express.Request, res: express.Response) => {
    Promise.resolve(fn(req, res)).catch((err: unknown) => res.status(500).json({ ok: false, error: (err as Error).message }));
  };
  const bad = (res: express.Response, error: string) => res.status(400).json({ ok: false, error });

  app.get("/api/overview", wrap(async (_req, res) => void res.json({ ...(await svc.overview()), presets: PRESETS })));
  app.get("/api/read", wrap(async (req, res) => void res.json({ ok: true, holdings: await svc.read(typeof req.query.account === "string" ? req.query.account : undefined) })));

  app.post("/api/say", wrap(async (req, res) => {
    const { text } = req.body as { text?: string };
    if (!text || !text.trim()) return void bad(res, "need {text}");
    res.json({ ok: true, flight: await agent.say(text.trim().slice(0, 200)) });
  }));

  app.post("/api/approve", wrap(async (req, res) => {
    const { id, decision } = req.body as { id?: string; decision?: string };
    if (!id || (decision !== "approve" && decision !== "reject")) return void bad(res, "need {id, decision: approve|reject}");
    const r = await svc.decide(id, decision);
    if (isRefusal(r) && r.code === "E_CARD_NOT_GRANTED") return void res.status(404).json({ ok: false, refusal: r });
    res.json({ ok: true, result: r, decision });
  }));

  app.post("/api/execute", wrap(async (req, res) => {
    const { account, intent, agent: who } = req.body as { account?: string; intent?: unknown; agent?: unknown };
    const parsed = parseIntent(intent);
    if (!account || !parsed) return void bad(res, "need {account, intent: {kind: trade|move|pay|subscribe|redeem, ...}}");
    const r = await svc.execute(account, parsed, parseAgent(who));
    if (isRefusal(r)) return void res.status(409).json({ ok: false, refusal: r });
    if (isPending(r)) return void res.status(202).json(r);
    res.json(r);
  }));

  app.post("/api/mode", (req, res) => {
    const { mode } = req.body as { mode?: string };
    if (mode !== "open" && mode !== "guard") return void bad(res, "mode must be open | guard");
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
    const { account } = req.body as { account?: string };
    if (!account) return void bad(res, "need {account}");
    const r = svc.restore(account);
    if (isRefusal(r)) return void res.status(404).json({ ok: false, refusal: r });
    res.json(r);
  });

  app.post("/api/reset", (_req, res) => {
    svc.reset();
    res.json({ ok: true });
  });

  const server: Server = await new Promise((resolve, reject) => {
    const s = app.listen(opts.port, "127.0.0.1", () => resolve(s));
    s.on("error", reject);
  });
  return {
    url: `http://127.0.0.1:${opts.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
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
  const service = await PortfolioService.create({ home: at("--home") ?? defaultHome(), live });
  const srv = await startPortfolioServer({ port, service });
  console.log(`agent portfolio manager at ${srv.url} · ${service.accounts().length} accounts · MetaMask ${live ? "LIVE via mm" : "simulated (--mm for live)"} · ledger ${service.ledgerPath()} · Ctrl-C to stop`);
  const stop = () => srv.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
