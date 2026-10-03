/** The control room: one static page, one SSE stream of the bus, one route
 * to answer a card. It renders what the run emits; it computes nothing.
 *
 *   GET  /            the page
 *   GET  /meta.json   manifests (titles, tools, where the key lives), decisions, texts
 *   GET  /events      SSE: every bus event from `Last-Event-ID` (or 0), then live
 *   GET  /cards.json  cards waiting for a human
 *   POST /approve     {cardId, outcome: "allowed-once" | "rejected"}
 *
 * `npm run control-room -- --replay <runs/last.jsonl>` serves a finished run
 * from its log, for rehearsal without the runner.
 */
import express from "express";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HttpAnswerer } from "../agent/http-answerer.ts";
import type { Bus, BusEvent } from "../core/bus.ts";
import { CODES } from "../core/errors.ts";
import { readJsonl } from "../core/jsonl.ts";
import type { Manifest } from "../contract/manifest.ts";

const PUBLIC = fileURLToPath(new URL("./public/", import.meta.url));

export interface ControlRoomMeta {
  manifests: Array<Pick<Manifest, "venue" | "serverName" | "title" | "native" | "keyLives" | "limits" | "tools"> & { identityRef: string | null; signer: string }>;
  decisions: Array<{ id: string; question: string; options: string[]; recommended: number }>;
  proven: string[];
  notProven: string[];
  next: string[];
  codes: Record<string, { layer: string; zh: string }>;
  live: boolean;
  mandates: Array<{ id: string; venue: string; purpose: string; notionalLimitUsd: number; perOrderCapUsd: number; symbols: string[]; recipients: string[]; validUntil: string; spentUsd: number; status: string }>;
}

export interface ControlRoomOptions {
  port: number;
  bus: Bus;
  meta: () => ControlRoomMeta;
  answerer?: HttpAnswerer | undefined;
}

export interface ControlRoomHandle {
  url: string;
  close(): Promise<void>;
}

export async function startControlRoom(opts: ControlRoomOptions): Promise<ControlRoomHandle> {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.setHeader("cache-control", "no-store");
    next();
  });
  app.get("/", (_req, res) => res.type("html").send(readFileSync(join(PUBLIC, "index.html"), "utf8")));
  app.get("/app.js", (_req, res) => res.type("application/javascript").send(readFileSync(join(PUBLIC, "app.js"), "utf8")));
  app.get("/style.css", (_req, res) => res.type("text/css").send(readFileSync(join(PUBLIC, "style.css"), "utf8")));
  app.get("/meta.json", (_req, res) => res.json(opts.meta()));
  app.get("/cards.json", (_req, res) => res.json(opts.answerer?.waiting() ?? []));

  app.get("/events", (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    const since = Number(req.header("last-event-id") ?? req.query.since ?? 0) || 0;
    const send = (e: BusEvent) => res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
    for (const e of opts.bus.since(since)) send(e);
    res.write(`data: ${JSON.stringify({ seq: 0, type: "ready", data: { last: opts.bus.last() } })}\n\n`);
    const off = opts.bus.on(send);
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    req.on("close", () => {
      off();
      clearInterval(ping);
    });
  });

  app.post("/approve", (req, res) => {
    const { cardId, outcome } = req.body as { cardId?: string; outcome?: string };
    if (!opts.answerer) {
      res.status(409).json({ ok: false, error: "headless run: the stand-in answers cards" });
      return;
    }
    if (!cardId || (outcome !== "allowed-once" && outcome !== "rejected")) {
      res.status(400).json({ ok: false, error: "cardId and outcome (allowed-once | rejected) required" });
      return;
    }
    const found = opts.answerer.decide(cardId, outcome);
    res.status(found ? 200 : 404).json({ ok: found, ...(found ? {} : { error: `no card ${cardId} is waiting` }) });
  });

  const server: Server = await new Promise((resolve, reject) => {
    const s = app.listen(opts.port, "127.0.0.1", () => resolve(s));
    s.on("error", reject);
  });
  return {
    url: `http://127.0.0.1:${opts.port}`,
    // SSE connections are never idle, so `close()` alone would wait for the browser to leave
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

export const DECISIONS: ControlRoomMeta["decisions"] = [
  { id: "D1", question: "托管还是非托管", options: ["非托管：用户自持主账户，agent 只持场所侧受限钥匙", "托管：agent 持主钥匙，靠我们自己的策略引擎"], recommended: 0 },
  { id: "D2", question: "身份记录放哪", options: ["home 目录的凭据库，按操作解析，子进程环境 scrub", "环境变量（仅 paper 可接受）"], recommended: 0 },
  { id: "D3", question: "签名器形态", options: ["本机独立进程；真钱之前换带外设备 / 云 KMS", "面内签名（与 agent 同进程）"], recommended: 0 },
  { id: "D4", question: "manifest 默认", options: ["未分类即拒绝，write 为 allow-list", "默认放行 + 黑名单"], recommended: 0 },
  { id: "D5", question: "第一个样板场所", options: ["Hyperliquid（原生代理钥匙最接近合同形状）", "Binance 先"], recommended: 0 },
];

export function codesTable(): ControlRoomMeta["codes"] {
  return Object.fromEntries(Object.entries(CODES).map(([k, v]) => [k, { layer: v.layer, zh: v.zh }]));
}

/** `npm run control-room -- --replay <file>`: serve a recorded run. */
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { Bus } = await import("../core/bus.ts");
  const { loadManifest } = await import("../contract/manifest.ts");
  const { PROVEN, NOT_PROVEN, NEXT } = await import("../runner/beats/10-summary.ts");
  const args = process.argv.slice(2);
  const replayAt = args.indexOf("--replay");
  const file = replayAt >= 0 ? args[replayAt + 1] : undefined;
  const portAt = args.indexOf("--port");
  const port = portAt >= 0 ? Number(args[portAt + 1]) : 4800;
  const bus = new Bus();
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const manifests = ["alpaca", "hyperliquid", "binance", "solana", "rogue-yield"].map((v) => loadManifest(join(root, "manifests", `${v}.json`)));
  const meta = (): ControlRoomMeta => ({
    manifests: manifests.map((m) => ({ venue: m.venue, serverName: m.serverName, title: m.title, native: m.native, keyLives: m.keyLives, limits: m.limits, tools: m.tools, identityRef: m.identity?.ref ?? null, signer: m.signer.kind })),
    decisions: DECISIONS,
    proven: PROVEN,
    notProven: NOT_PROVEN,
    next: NEXT,
    codes: codesTable(),
    live: false,
    mandates: [],
  });
  const room = await startControlRoom({ port, bus, meta });
  console.log(`control room at ${room.url}${file ? ` · replaying ${file}` : " · empty (no run)"}`);
  if (file) {
    const events = readJsonl<BusEvent>(file);
    const pace = args.includes("--instant") ? 0 : 120;
    for (const e of events) {
      bus.emit(e.type, e.data);
      if (pace) await new Promise((r) => setTimeout(r, pace));
    }
    console.log(`replayed ${events.length} events; keep the page open, Ctrl-C to stop`);
  }
}
