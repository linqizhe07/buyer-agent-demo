/** The Hyperliquid simulator: a perp DEX whose master account can approve an
 * AGENT key that trades but cannot withdraw and expires when the venue says.
 *
 * Shapes follow Hyperliquid's API: `POST /info {type}` for reads and
 * `POST /exchange {action, nonce, signature}` for writes, with the actions
 * `approveAgent`, `order`, `cancel`, `withdraw3`. Signing is an ed25519 stand-in
 * for EIP-712: `signature = {pubkey, sig over canonical({action, nonce})}` and
 * the signer's address is derived from the pubkey. The three venue-side rules
 * the story needs are enforced here, not in the agent: an agent key cannot
 * withdraw, an expired agent key cannot act, and nonces must increase.
 */
import express from "express";
import type { Server } from "node:http";
import type { SimClock } from "../core/clock.ts";
import { evmAddressOf, verify } from "../core/ed25519.ts";
import { canonical } from "../core/hash.ts";
import { priceWalk } from "../core/prng.ts";
import type { VenueHandle } from "./alpaca.ts";

export interface HlMasterSeed {
  address: string;
  accountValue: number;
}

export interface HlFill {
  coin: string;
  px: string;
  sz: string;
  side: "B" | "A";
  time: number;
  oid: number;
  tid: number;
  fee: string;
  closedPnl: string;
}

export interface HlAgentRecord {
  address: string;
  master: string;
  name: string;
  validUntil: number;
}

export interface HlStatement {
  masters: Array<{ address: string; accountValue: string; positions: Array<{ coin: string; szi: string; entryPx: string }> }>;
  fills: HlFill[];
  agents: HlAgentRecord[];
  deposits: Array<{ to: string; amount: string; txId: string; time: number }>;
  withdrawals: Array<{ destination: string; amount: string; time: number }>;
}

export interface HlSimHandle extends VenueHandle {
  statement(): HlStatement;
  price(coin: string): number;
}

export interface HlSimOptions {
  port: number;
  seed: number;
  clock: SimClock;
  masters: HlMasterSeed[];
  onEvent?: (type: string, data: unknown) => void;
}

const UNIVERSE = [
  { name: "BTC", szDecimals: 5, base: 62150 },
  { name: "ETH", szDecimals: 4, base: 2440 },
  { name: "SOL", szDecimals: 2, base: 148.3 },
];

interface MasterState {
  address: string;
  accountValue: number;
  positions: Map<string, { szi: number; entryPx: number }>;
  resting: Array<{ oid: number; coin: string; side: "B" | "A"; limitPx: number; sz: number; timestamp: number }>;
}

export async function startHyperliquidSim(opts: HlSimOptions): Promise<HlSimHandle> {
  const walks = new Map<string, () => number>();
  const last = new Map<string, number>();
  const price = (coin: string): number => {
    const u = UNIVERSE.find((x) => x.name === coin);
    if (!u) throw new Error(`unknown coin ${coin}`);
    let w = walks.get(coin);
    if (!w) {
      w = priceWalk(opts.seed + UNIVERSE.indexOf(u), u.base, 0.0008, 1);
      walks.set(coin, w);
    }
    const px = w();
    last.set(coin, px);
    return px;
  };

  const masters = new Map<string, MasterState>();
  for (const m of opts.masters) masters.set(m.address, { address: m.address, accountValue: m.accountValue, positions: new Map(), resting: [] });
  const agents = new Map<string, HlAgentRecord>();
  const nonces = new Map<string, number>();
  const fills: HlFill[] = [];
  const deposits: HlStatement["deposits"] = [];
  const withdrawals: HlStatement["withdrawals"] = [];
  /** 10x: a tenth of the open notional stays as margin and cannot be withdrawn */
  const withdrawable = (m: MasterState) =>
    Math.max(0, m.accountValue - [...m.positions.entries()].reduce((s, [coin, p]) => s + Math.abs(p.szi) * (last.get(coin) ?? price(coin)) * 0.1, 0));
  let oidSeq = 1000;
  let tidSeq = 5000;
  const emit = (type: string, data: unknown) => opts.onEvent?.(type, data);

  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.setHeader("x-demo-venue", "hyperliquid-sim");
    next();
  });

  app.post("/info", (req, res) => {
    const body = req.body as Record<string, unknown>;
    const type = String(body.type);
    const user = typeof body.user === "string" ? body.user.toLowerCase() : undefined;
    switch (type) {
      case "meta":
        res.json({ universe: UNIVERSE.map(({ name, szDecimals }) => ({ name, szDecimals })) });
        return;
      case "l2Book": {
        const coin = String(body.coin);
        if (!UNIVERSE.some((u) => u.name === coin)) {
          res.status(400).json({ error: `unknown coin ${coin}` });
          return;
        }
        const mid = price(coin);
        const tick = mid * 0.0002;
        const bids = [0, 1, 2].map((i) => ({ px: (mid - tick * (i + 1)).toFixed(1), sz: (0.5 + i * 0.3).toFixed(3), n: 2 + i }));
        const asks = [0, 1, 2].map((i) => ({ px: (mid + tick * (i + 1)).toFixed(1), sz: (0.4 + i * 0.3).toFixed(3), n: 1 + i }));
        res.json({ coin, time: opts.clock.now(), levels: [bids, asks] });
        return;
      }
      case "userState": {
        const m = user ? masters.get(user) : undefined;
        if (!m) {
          res.json({ marginSummary: { accountValue: "0.0", totalMarginUsed: "0.0" }, withdrawable: "0.0", assetPositions: [] });
          return;
        }
        const assetPositions = [...m.positions.entries()].map(([coin, p]) => ({
          type: "oneWay",
          position: {
            coin,
            szi: String(p.szi),
            entryPx: p.entryPx.toFixed(1),
            positionValue: (Math.abs(p.szi) * (last.get(coin) ?? price(coin))).toFixed(2),
            unrealizedPnl: ((last.get(coin) ?? price(coin)) - p.entryPx) * p.szi,
          },
        }));
        res.json({
          marginSummary: { accountValue: m.accountValue.toFixed(2), totalMarginUsed: (m.accountValue - withdrawable(m)).toFixed(2) },
          withdrawable: withdrawable(m).toFixed(2),
          assetPositions,
        });
        return;
      }
      case "openOrders": {
        const m = user ? masters.get(user) : undefined;
        res.json(m ? m.resting.map((o) => ({ coin: o.coin, side: o.side, limitPx: o.limitPx.toFixed(1), sz: String(o.sz), oid: o.oid, timestamp: o.timestamp })) : []);
        return;
      }
      case "userFills":
        res.json(fills);
        return;
      case "extraAgents": {
        res.json([...agents.values()].filter((a) => a.master === user).map((a) => ({ address: a.address, name: a.name, validUntil: a.validUntil })));
        return;
      }
      default:
        res.status(400).json({ error: `unknown info type ${type}` });
    }
  });

  app.post("/exchange", (req, res) => {
    const body = req.body as { action?: Record<string, unknown>; nonce?: number; signature?: { pubkey?: string; sig?: string } };
    const err = (response: string, http = 200) => {
      emit("sim/refused", { venue: "hyperliquid", response, action: body.action?.type });
      res.status(http).json({ status: "err", response });
    };
    const action = body.action;
    const nonce = Number(body.nonce);
    const sig = body.signature;
    if (!action || !sig?.pubkey || !sig.sig || !Number.isFinite(nonce)) return err("Malformed request", 400);
    if (!verify(sig.pubkey, canonical({ action, nonce }), sig.sig)) return err("Invalid signature", 401);
    const signer = evmAddressOf(sig.pubkey);
    if (nonce <= (nonces.get(signer) ?? 0)) return err("Invalid nonce");
    nonces.set(signer, nonce);

    let master: MasterState | undefined;
    let viaAgent: HlAgentRecord | undefined;
    if (masters.has(signer)) master = masters.get(signer);
    else {
      viaAgent = agents.get(signer);
      if (!viaAgent) return err(`Unknown agent ${signer}`);
      if (opts.clock.now() >= viaAgent.validUntil) return err(`Agent key expired at ${new Date(viaAgent.validUntil).toISOString()}`);
      master = masters.get(viaAgent.master);
    }
    if (!master) return err("Unknown account");

    switch (String(action.type)) {
      case "approveAgent": {
        if (viaAgent) return err("Agents cannot approve agents");
        const agentAddress = String(action.agentAddress).toLowerCase();
        const name = String(action.agentName ?? "");
        const m = /valid_until (\d+)/.exec(name);
        const validUntil = m ? Number(m[1]) : opts.clock.now() + 24 * 3600_000;
        agents.set(agentAddress, { address: agentAddress, master: master.address, name, validUntil });
        emit("sim/agent-approved", { venue: "hyperliquid", agentAddress, master: master.address, validUntil });
        res.json({ status: "ok", response: { type: "default" } });
        return;
      }
      case "order": {
        const orders = (action.orders as Array<Record<string, unknown>>) ?? [];
        const statuses: unknown[] = [];
        for (const o of orders) {
          const u = UNIVERSE[Number(o.a)];
          if (!u) {
            statuses.push({ error: `unknown asset ${String(o.a)}` });
            continue;
          }
          const isBuy = Boolean(o.b);
          const limitPx = Number(o.p);
          const sz = Number(o.s);
          const tif = String((o.t as { limit?: { tif?: string } })?.limit?.tif ?? "Gtc");
          const mid = price(u.name);
          const crosses = isBuy ? limitPx >= mid : limitPx <= mid;
          const oid = ++oidSeq;
          if (crosses) {
            const pos = master.positions.get(u.name) ?? { szi: 0, entryPx: mid };
            const signed = isBuy ? sz : -sz;
            const newSzi = pos.szi + signed;
            pos.entryPx = pos.szi === 0 || Math.sign(newSzi) !== Math.sign(pos.szi) ? mid : (pos.entryPx * Math.abs(pos.szi) + mid * sz) / (Math.abs(pos.szi) + sz);
            pos.szi = Number(newSzi.toFixed(u.szDecimals));
            if (pos.szi === 0) master.positions.delete(u.name);
            else master.positions.set(u.name, pos);
            const fill: HlFill = {
              coin: u.name,
              px: mid.toFixed(1),
              sz: String(sz),
              side: isBuy ? "B" : "A",
              time: opts.clock.now(),
              oid,
              tid: ++tidSeq,
              fee: (sz * mid * 0.00035).toFixed(4),
              closedPnl: "0.0",
            };
            fills.push(fill);
            master.accountValue -= Number(fill.fee);
            emit("sim/fill", { venue: "hyperliquid", oid, coin: u.name, side: fill.side, sz, px: mid, viaAgent: viaAgent?.address ?? null });
            statuses.push({ filled: { totalSz: String(sz), avgPx: mid.toFixed(1), oid } });
          } else if (tif === "Ioc") {
            statuses.push({ error: "Order could not immediately match against any resting orders." });
          } else {
            master.resting.push({ oid, coin: u.name, side: isBuy ? "B" : "A", limitPx, sz, timestamp: opts.clock.now() });
            statuses.push({ resting: { oid } });
          }
        }
        res.json({ status: "ok", response: { type: "order", data: { statuses } } });
        return;
      }
      case "cancel": {
        const cancels = (action.cancels as Array<{ a: number; o: number }>) ?? [];
        const statuses = cancels.map((c) => {
          const i = master!.resting.findIndex((o) => o.oid === Number(c.o));
          if (i < 0) return { error: `Order ${String(c.o)} not found` };
          master!.resting.splice(i, 1);
          return "success";
        });
        res.json({ status: "ok", response: { type: "cancel", data: { statuses } } });
        return;
      }
      case "withdraw3": {
        if (viaAgent) return err("Agent keys cannot withdraw");
        const amount = Number(action.amount);
        if (!(amount > 0) || amount > withdrawable(master)) return err("Insufficient withdrawable balance");
        master.accountValue = Number((master.accountValue - amount).toFixed(2));
        withdrawals.push({ destination: String(action.destination), amount: String(amount), time: opts.clock.now() });
        emit("sim/withdrawal", { venue: "hyperliquid", amount, destination: String(action.destination) });
        res.json({ status: "ok", response: { type: "default" } });
        return;
      }
      default:
        return err(`Unknown action ${String(action.type)}`, 400);
    }
  });

  /** The bridge delivering USDC to a master account (not an API the agent calls; what the chain does). */
  app.post("/bridge/deposit", (req, res) => {
    const { to, amount, txId } = req.body as { to: string; amount: number; txId: string };
    const m = masters.get(String(to).toLowerCase());
    if (!m || !(Number(amount) > 0)) {
      res.status(404).json({ message: "no such account" });
      return;
    }
    m.accountValue = Number((m.accountValue + Number(amount)).toFixed(2));
    deposits.push({ to: m.address, amount: String(amount), txId, time: opts.clock.now() });
    emit("sim/deposit", { venue: "hyperliquid", amount: Number(amount), txId });
    res.json({ credited: true, amount: Number(amount) });
  });

  const server: Server = await new Promise((resolve, reject) => {
    const s = app.listen(opts.port, "127.0.0.1", () => resolve(s));
    s.on("error", reject);
  });

  return {
    name: "hyperliquid",
    url: `http://127.0.0.1:${opts.port}`,
    port: opts.port,
    price: (coin) => last.get(coin) ?? price(coin),
    statement: () => ({
      masters: [...masters.values()].map((m) => ({
        address: m.address,
        accountValue: m.accountValue.toFixed(2),
        positions: [...m.positions.entries()].map(([coin, p]) => ({ coin, szi: String(p.szi), entryPx: p.entryPx.toFixed(1) })),
      })),
      fills: [...fills],
      agents: [...agents.values()],
      deposits: [...deposits],
      withdrawals: [...withdrawals],
    }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
