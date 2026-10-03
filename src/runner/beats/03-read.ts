import type { Beat } from "./types.ts";

/** Reads need no card: they go through the same execute() as writes and come
 * back without an approval/asked event. One read per venue, side by side. */
export const readBeat: Beat = {
  name: "read",
  title: "跨四个场所读行情、持仓与余额，读不需要卡",
  async run(ctx) {
    const { env } = ctx;
    const askedBefore = env.gate.history().filter((e) => e.type === "approval/asked").length;

    const account = await env.agent.execute("mcp__alpaca__account");
    const acct = (account.ok ? account.payload : {}) as { status?: string; cash?: string; equity?: string };
    ctx.check(account.ok && acct.status === "ACTIVE", `alpaca · account ACTIVE · cash $${acct.cash} · equity $${acct.equity}`, "read");

    const positions = await env.agent.execute("mcp__alpaca__positions");
    const rows = (positions.ok ? positions.payload : []) as Array<{ symbol: string; qty: string; current_price: string }>;
    ctx.check(positions.ok && rows.length > 0, `alpaca · ${rows.length} positions: ${rows.map((r) => `${r.symbol} ${r.qty} @ ${r.current_price}`).join(", ")}`, "read");

    const quote = await env.agent.execute("mcp__alpaca__quote", { symbol: "BTC/USD" });
    const q = (quote.ok ? quote.payload : {}) as { ap?: number; bp?: number };
    ctx.check(quote.ok && typeof q.ap === "number", `alpaca · quote BTC/USD ask ${q.ap} bid ${q.bp}`, "read");

    const hl = await env.agent.execute("mcp__hyperliquid__userState");
    const ms = (hl.ok ? hl.payload : {}) as { marginSummary?: { accountValue?: string } };
    ctx.check(hl.ok && ms.marginSummary !== undefined, `hyperliquid · master account value $${ms.marginSummary?.accountValue}`, "read");

    const bn = await env.agent.execute("mcp__binance__fetchBalance");
    const b = (bn.ok ? bn.payload : {}) as { free?: Record<string, number>; permissions?: string[]; canWithdraw?: boolean };
    ctx.check(
      bn.ok && b.canWithdraw === false,
      `binance · USDT ${b.free?.USDT} · BTC ${b.free?.BTC} · key permissions ${b.permissions?.join(",")} · canWithdraw ${b.canWithdraw}`,
      "read",
    );

    const sol = await env.agent.execute("mcp__solana__getBalance");
    const s = (sol.ok ? sol.payload : {}) as { sol?: number; address?: string };
    ctx.check(sol.ok && typeof s.sol === "number", `solana · ${s.sol} SOL at ${String(s.address).slice(0, 8)}… (the signer's account; the seat holds no key)`, "read");

    const askedAfter = env.gate.history().filter((e) => e.type === "approval/asked").length;
    ctx.check(askedAfter === askedBefore, "no approval card was raised for any read", "read");
    ctx.check(env.ledger.byKind("read").length >= 6, `reads are ledger rows too (${env.ledger.byKind("read").length} so far)`, "ledger");
  },
};
