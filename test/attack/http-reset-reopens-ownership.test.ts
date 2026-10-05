/** AN ATTACK THAT MUST FAIL (found by an independent review on 2026-10-04, written as it succeeded then, and run with `it.fails`:
 * this test passes only while the attack below does NOT go through) — attacker C, a local process with no key at all, talking HTTP.
 *
 * Two things the unauthenticated surface gives away:
 *   1. `GET /api/overview` returns the last 80 ledger rows whole — including every signed envelope. Reading the ledger file is not needed to
 *      hold the owner's signed approvals (which makes the replays in replay-fractional-nonce / multisig-cosigner-swap an HTTP attack).
 *   2. trust on first use is accepted for the FIRST browser. But `reset()` puts the owners back to the seed — on the server that is nobody —
 *      so the account is up for grabs again: whoever posts a key to `/api/account/pair` next is the owner, and the real owner's browser
 *      (the Account page offers its key again only on its next refresh, up to 20 s later) is left "pending". The new owner authorises its
 *      own agent key and approves its own spending. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { signDevice, simKey, type Envelope, type OwnerAction, type SimKey } from "../../src/portfolio/account/sign.ts";
import { startPortfolioServer, type PortfolioServerHandle } from "../../src/portfolio/server.ts";
import { PortfolioService } from "../../src/portfolio/service.ts";

const START = Date.parse("2026-10-05T14:00:00.000Z");
const DAY = 86_400_000;
const ownersBrowser = simKey("owner-device");
const intruder = simKey("intruder-device");
const cc = simKey("agent:claude-code");
const intrudersAgent = simKey("agent:intruder");
let home: string | undefined;
let server: PortfolioServerHandle | undefined;
afterAll(async () => {
  await server?.close();
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("C · no key, only HTTP", () => {
  it.fails("reads the owner's signed envelopes off /api/overview; after a reset it pairs first and owns the account", async () => {
    let n = 0;
    home = mkdtempSync(join(tmpdir(), "attack-http-"));
    // the server as `npm run portfolio` starts it: the account layer mounted, no owner seeded
    const svc = await PortfolioService.create({ home, now: () => new Date(START).toISOString(), venues: "frontline" });
    server = await startPortfolioServer({ port: 0, service: svc });
    const url = server.url;
    const post = async (path: string, body: unknown) => {
      const r = await fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    const get = async (path: string) => (await (await fetch(`${url}${path}`)).json()) as Record<string, unknown>;
    const signed = (by: SimKey, a: Record<string, unknown>) => {
      const action = { ...a, nonce: START + ++n } as OwnerAction;
      return post("/api/exchange", { action, nonce: action.nonce, signature: signDevice(by, action) });
    };
    const owners = async () => ((await get("/api/account")).signers as { owners: Array<{ id: string }> }).owners.map((o) => o.id);

    // the owner opens the page first and sets the account up
    expect((await post("/api/account/pair", { jwk: ownersBrowser.jwk })).body.role).toBe("owner");
    expect((await signed(ownersBrowser, { type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: START + 30 * DAY })).status).toBe(200);
    expect((await signed(ownersBrowser, { type: "approveSpend", agent: cc.address, scope: "venues", allow: "okx,metamask,hyperliquid", perPayment: "600", budget: "1000", windowHours: 0, validUntil: START + 30 * DAY })).status).toBe(200);

    // 1 · anyone on this machine can read the signed envelopes
    const ledger = (await get("/api/overview")).ledger as Array<{ tool?: string; envelope?: Envelope }>;
    const envelopesReadWithNoKey = ledger.filter((r) => r.envelope !== undefined).map((r) => r.envelope!.action.type).sort();
    expect(envelopesReadWithNoKey).toEqual(["approveAgent", "approveSpend"]);

    // a second browser cannot take the account while the owner holds it
    expect((await post("/api/account/pair", { jwk: intruder.jwk })).body.role).toBe("pending");

    // 2 · the owner resets the simulation (a signed instruction)
    expect((await signed(ownersBrowser, { type: "setPolicy", change: "reset", value: "" })).status).toBe(200);
    expect(await owners()).toEqual([]);
    // the intruder pairs before the owner's page refreshes
    expect((await post("/api/account/pair", { jwk: intruder.jwk })).body.role).toBe("owner");
    expect((await post("/api/account/pair", { jwk: ownersBrowser.jwk })).body.role).toBe("pending");
    expect(await owners()).toEqual([`device:${intruder.kid}`]);

    // the owner's own signature is no longer the owner's; the intruder's is
    expect((await signed(ownersBrowser, { type: "userSetAbstraction", abstraction: "unifiedAccount" })).status).toBe(401);
    expect((await signed(intruder, { type: "approveAgent", agentAddress: intrudersAgent.address, agentName: "Mine", validUntil: START + 30 * DAY })).status).toBe(200);
    expect((await signed(intruder, { type: "approveSpend", agent: intrudersAgent.address, scope: "venues", allow: "*", perPayment: "100000", budget: "100000", windowHours: 0, validUntil: START + 30 * DAY })).status).toBe(200);
    const spend = (await get("/api/account")).spend as Array<{ agent: string; allow: string[]; budgetUsd: number }>;
    const intruderHoldsAnApprovalForEveryVenue = spend.some((s) => s.agent === intrudersAgent.address && s.allow.includes("*") && s.budgetUsd === 100000);
    expect(intruderHoldsAnApprovalForEveryVenue).toBe(true);
  });
});
