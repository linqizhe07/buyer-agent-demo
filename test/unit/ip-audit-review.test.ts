import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import ccxt from "ccxt";
import { isRefusal } from "../../src/core/errors.ts";
import { signOwner, simKey } from "../../src/portfolio/account/sign.ts";
import { guardClient, type ExchangeClient } from "../../src/portfolio/live/exchange.ts";
import { register } from "../../src/portfolio/live/index.ts";
import { exchangeWriter, type LiveReceipt } from "../../src/portfolio/live/writes.ts";
import { no, unaddressed } from "../../src/portfolio/refuse.ts";
import { PortfolioService } from "../../src/portfolio/service.ts";

/** What the review of the IP audit's fixes found at their seams (2026-10-10): the doors' holds must never keep a cancel from the venue nor
 * hold an order back for a read that only did not answer; a forced re-check lets go of what the old network held; the guard leaves an
 * exchange's own web pages alone; a page answered to a withdrawal is "may have", not "refused"; the address scrub stays linear */
const homes: string[] = [];
afterAll(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

const owner = simKey("owner:ip-audit-review");
const PERP = { symbol: "BTC-PERP", name: "BTC perp", kind: "perp", base: "BTC", quote: "USDC", price: 60_000, bid: 59_990, ask: 60_010, minQty: 0.0001, qtyStep: 0.0001, priceStep: 0.1, open: true, types: ["market", "limit"] };

/** a service with one live venue, `mm`, whose trader answers as the test says: its positions refused by an edge, a market read that
 * does not answer */
async function boot(kind: string) {
  const calls: string[] = [];
  const state = { edge: false, slow: false };
  const trader = {
    can: true,
    what: "perpetuals",
    async markets() {
      return [PERP];
    },
    async market(sym: string) {
      calls.push(`market ${sym}`);
      return state.slow ? no("E_VENUE_UNREACHABLE", { venue: "mm", message: "Stand-in did not answer in time" }) : { ...PERP, symbol: sym };
    },
    async positions() {
      calls.push("positions");
      return state.edge ? no("E_VENUE_GEOBLOCKED", { venue: "mm", message: "Stand-in refuses this network: the server in front of it answered HTTP 403", native: { status: 403, edge: true } }) : [];
    },
    async place(o: { qty: number }) {
      calls.push("place");
      return { ref: "777", status: "open", filledQty: 0, native: { qty: o.qty } };
    },
    async cancel(ref: string) {
      calls.push(`cancel ${ref}`);
      return { ref, status: "canceled", filledQty: 0, native: {} };
    },
    async status(ref: string) {
      return { ref, status: "open", filledQty: 0, native: {} };
    },
  };
  register({ kind, label: "stand-in", needs: "key-file", example: "", venues: [], async open(req: { label: string }) {
    return { source: { name: req.label || "Stand-in", kind: "wallet", reference: "standin", via: "a stand-in", probe: { can: ["read", "trade"], note: "" }, read: async () => [{ asset: "USDC", amount: 500, usd: 500 }], trader }, first: [{ asset: "USDC", amount: 500, usd: 500 }], summary: "connected" };
  } } as never);
  const home = mkdtempSync(join(tmpdir(), "ip-audit-review-"));
  homes.push(home);
  const svc = await PortfolioService.create({ home, venues: "frontline", real: true, publicMarkets: [], liveDeps: { http: async () => ({ status: 404, body: undefined, text: "" }), price: async () => undefined, mm: (async () => ({ authenticated: true })) as never }, liveWrites: { capUsd: 100, pairingCode: "K7QX-M2PA" }, account: { owners: [{ id: owner.address, kind: "eoa", label: "owner", addedAt: new Date().toISOString() }] } } as never);
  await svc.restoring;
  let seq = 0;
  const own = async (a: Record<string, unknown>) => svc.exchange(await signOwner(owner, { ...a, nonce: Date.now() + ++seq } as never));
  const c = await own({ type: "connectVenue", venue: "mm", connector: `live:${kind}`, label: "Stand-in", credentialRef: "" });
  if (isRefusal(c)) throw new Error(c.message);
  const order = async (qty: string) => {
    const p = await svc.account!.prepare({ type: "liveOrder", venue: "mm", symbol: "BTC-PERP", side: "buy", orderType: "limit", qty, limitPrice: "50000" } as never);
    if (isRefusal(p)) throw new Error(p.message);
    const { nonce: _n, ...rest } = (p as { action: Record<string, unknown> }).action;
    const placed = await own(rest);
    if (isRefusal(placed)) throw new Error(placed.message);
    return (placed as { order: { id: string } }).order.id;
  };
  const quote = () => svc.account!.prepare({ type: "liveOrder", venue: "mm", symbol: "BTC-PERP", side: "sell", orderType: "limit", qty: "0.001", limitPrice: "70000" } as never);
  return { svc, own, order, quote, calls, state };
}

describe("the doors' holds", () => {
  it("a page read that only did not answer stops no order and no cancel", async () => {
    const x = await boot("ip-review-slow");
    const id = await x.order("0.001");
    x.state.slow = true;
    expect(isRefusal(await x.svc.liveMarket("mm", "SOL-PERP"))).toBe(true);
    x.state.slow = false;
    x.calls.splice(0);
    const c = await x.own({ type: "liveCancel", venue: "mm", order: id });
    expect(isRefusal(c) ? c.message : (c as { order: { status: string } }).order.status).toBe("canceled");
    expect(x.calls).toContain("cancel 777");
    expect(isRefusal(await x.quote())).toBe(false);
  });

  it("an edge's refusal holds the reads, but the owner's cancel is still sent and decided by the venue's own answer; a forced re-check that finds the venue answering lets go", async () => {
    const x = await boot("ip-review-edge");
    const a = await x.order("0.001");
    const b = await x.order("0.002");
    x.state.edge = true;
    expect(isRefusal(await x.svc.livePositions("mm"))).toBe(true);
    x.state.edge = false;
    x.calls.splice(0);
    const c = (await x.own({ type: "liveCancel", venue: "mm", order: a })) as { order: { status: string; unfollowed?: boolean } };
    expect([c.order.status, c.order.unfollowed, x.calls.filter((k) => k.startsWith("cancel"))]).toEqual(["canceled", undefined, ["cancel 777"]]);
    await x.svc.connectReach(["live:ip-review-edge"], true);
    expect(isRefusal(await x.quote())).toBe(false);
    const d = (await x.own({ type: "liveCancel", venue: "mm", order: b })) as { order: { status: string; unfollowed?: boolean } };
    expect([d.order.status, d.order.unfollowed]).toEqual(["canceled", undefined]);
  });
});

describe("the exchange guard and the writer", () => {
  const lib = ccxt as unknown as Record<string, new (o: Record<string, unknown>) => Record<string, unknown>> & { RequestTimeout: new (m: string) => Error; BadResponse: new (m: string) => Error };

  it("an exchange's own web page the library reads on purpose (Gemini's) passes the guard; a page on its API does not", () => {
    const x = guardClient(new lib.gemini!({ enableRateLimit: false }) as unknown as ExchangeClient, lib) as unknown as { urls: { api: Record<string, string> }; handleErrors: (...a: unknown[]) => unknown };
    const web = Object.entries(x.urls.api).find(([k]) => /^web/i.test(k))?.[1];
    expect(web).toBeTruthy();
    expect(() => x.handleErrors(200, "OK", `${web}/trade`, "GET", {}, "<html><body>pairs</body></html>", undefined)).not.toThrow();
    expect(() => x.handleErrors(200, "OK", `${x.urls.api.public}/v1/symbols`, "GET", {}, "<html><body>blocked</body></html>", undefined)).toThrow();
  });

  it("a withdrawal answered by a page in the exchange's place may have been taken: it is followed, never 'refused'", async () => {
    const page = Object.assign(new Error("okx POST https://www.okx.com/api/v5/asset/withdrawal 200 OK <html><title>Blocked</title></html>"), { name: "BadResponse" });
    const stub = { id: "okx", has: { withdraw: true }, loadMarkets: async () => ({}), currencies: { USDC: { networks: { ERC20: { withdraw: true, fee: 1 } } } }, withdraw: async () => { throw page; } } as unknown as ExchangeClient;
    const r = (await exchangeWriter(stub, "okx", "OKX", [], { can: ["read", "withdraw"] }, []).withdraw!({ asset: "USDC", amount: 10, address: "0x000000000000000000000000000000000000dEaD", network: "Ethereum", clientId: "pay-9-x" })) as LiveReceipt;
    expect([r.status, (r.native as { unsure?: boolean }).unsure]).toEqual(["pending", true]);
  });

  it("the address scrub stays linear on a long run of hex (calldata in a chain's error)", () => {
    const hex = `0x${"ab".repeat(50_000)}`;
    const t = Date.now();
    expect(unaddressed(`reverted: ${hex}`)).toBe(`reverted: ${hex}`);
    expect(Date.now() - t).toBeLessThan(500);
  });
});
