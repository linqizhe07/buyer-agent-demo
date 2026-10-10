import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isRefusal, type Refusal } from "../../src/core/errors.ts";
import { no } from "../../src/portfolio/refuse.ts";
import type { Outcome } from "../../src/portfolio/account/exchange.ts";
import { MAX_NOTES, MEMORY_WRITES_PER_HOUR, MemoryStore, memoryProblem, NOTE_TEXT, type MemoryNote } from "../../src/portfolio/account/memory.ts";
import { MEMORY_TYPES, MONEY_TYPES, shownFields, signAgent, signOwner, simKey, STEER_TYPES, type AgentAction, type OwnerAction, type SimKey } from "../../src/portfolio/account/sign.ts";
import { register, type LiveDeps } from "../../src/portfolio/live/index.ts";
import type { LiveTrader, Market, OrderState } from "../../src/portfolio/live/trade.ts";
import { PortfolioService } from "../../src/portfolio/service.ts";

/** What each agent remembers about the owner, kept by the account — the Demo v2 canvas's F13. Its notes in three parts, each saying where it
 * came from (the owner said it; the agent learned it, and how); what the owner's limits say, written out as they stand; the owner's three
 * switches (learn · ask first · share). The owner reads, changes and forgets every word; forgetting is deletion, the file itself for
 * Forget all; the words never reach the ledger; nothing in memory is a permission; and no key, secret or IP address is kept. */
type NoNonce<T> = T extends unknown ? Omit<T, "nonce"> : never;
const START = Date.parse("2026-10-09T14:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));
const owner = simKey("owner");
const cc = simKey("agent:claude-code");
const codex = simKey("agent:codex");

const BTC: Market = { symbol: "BTC/USDT", name: "BTC/USDT", kind: "spot", base: "BTC", quote: "USDT", price: 60_000, bid: 59_990, ask: 60_010, minQty: 0.0001, qtyStep: 0.0001, priceStep: 0.1, open: true, types: ["market", "limit"] };
const states = new Map<string, OrderState>();
const trader: LiveTrader = {
  can: true,
  what: "spot",
  async markets() {
    return [BTC];
  },
  async market(symbol) {
    return symbol === BTC.symbol ? { ...BTC } : no("E_VENUE_REJECTED", { venue: "ex", message: `no market ${symbol}` });
  },
  async place() {
    const s: OrderState = { ref: `r-${states.size + 1}`, status: "open", filledQty: 0, native: {} };
    states.set(s.ref, s);
    return s;
  },
  async cancel(ref) {
    return { ...states.get(ref)!, status: "canceled" };
  },
  async status(ref) {
    return states.get(ref)!;
  },
};
register({ kind: "standin-memory", label: "a venue that trades", needs: "key-file", example: "", venues: [], async open(req) {
  return { source: { name: req.label || "Stand-in", kind: "cex", reference: "standin", via: "a stand-in", probe: { can: ["read", "trade"], note: "" }, read: async () => [{ asset: "USDT", amount: 500, usd: 500 }], trader, readOnlyBecause: "the stand-in moves no money" }, first: [{ asset: "USDT", amount: 500, usd: 500 }], summary: "connected" };
} });

const fresh = () => {
  const h = mkdtempSync(join(tmpdir(), "account-memory-"));
  homes.push(h);
  return h;
};

async function run(home: string, at = 0) {
  let t = START + at;
  let n = 0;
  const liveDeps: Partial<LiveDeps> = { clock: () => t, http: async () => ({ status: 599, body: undefined, text: "" }), price: async () => undefined };
  const svc = await PortfolioService.create({ home, now: () => new Date(t).toISOString(), venues: "frontline", real: true, liveDeps, liveWrites: { capUsd: 1000, pairingCode: "K7QX-M2PA" }, account: { owners: [{ id: owner.address, kind: "eoa" as const, label: "owner", addedAt: new Date(START).toISOString() }] } });
  await svc.restoring;
  const engine = svc.account!;
  const nonce = () => t + ++n;
  const own = async (a: NoNonce<OwnerAction>, by: SimKey = owner) => svc.exchange(await signOwner(by, { ...a, nonce: nonce() } as OwnerAction));
  const ag = async (a: NoNonce<AgentAction>, key: SimKey = cc) => svc.exchange(await signAgent(key, { ...a, nonce: nonce() } as AgentAction));
  return { svc, engine, own, ag, pass: (ms: number) => void (t += ms), now: () => t, nonce };
}

async function account(home = fresh(), at = 0) {
  const x = await run(home, at);
  ok(await x.own({ type: "connectVenue", venue: "ex", connector: "live:standin-memory", label: "Ex", credentialRef: "" }));
  ok(await x.own({ type: "approveAgent", agentAddress: cc.address, agentName: "Claude Code", validUntil: START + 30 * DAY }));
  return x;
}

const ok = (o: Outcome | Refusal) => {
  if (isRefusal(o)) throw new Error(`${o.code}: ${o.message}`);
  return o;
};
const code = (o: Outcome | Refusal | MemoryNote | number) => (isRefusal(o) ? o.code : "ok");
const ledgerText = (home: string) => readdirSync(join(home, "portfolio")).filter((f) => f.endsWith(".jsonl")).map((f) => readFileSync(join(home, "portfolio", f), "utf8")).join("\n");
const memoryText = (home: string) => {
  const dir = join(home, "memory");
  return existsSync(dir) ? readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8")).join("\n") : "";
};
const learn = (text: string, o: { id?: string; topic?: string; how?: string } = {}): NoNonce<AgentAction> => ({ type: "agentRemember", id: o.id ?? "", topic: o.topic ?? "style", text, how: o.how ?? "from your questions" });
const rules = (scope: string, r: { learn?: boolean; ask?: boolean; share?: boolean }): NoNonce<OwnerAction> => ({ type: "setMemoryRules", scope, learn: r.learn === false ? "off" : "on", ask: r.ask ? "on" : "off", share: r.share ? "on" : "off" });
const read = (x: Awaited<ReturnType<typeof run>>, key: SimKey = cc) => {
  const v = x.svc.memoryFor(key.address);
  if (isRefusal(v)) throw new Error(v.message);
  return v;
};
const page = (x: Awaited<ReturnType<typeof run>>, key: SimKey = cc) => {
  const v = x.svc.memoryView();
  if (isRefusal(v)) throw new Error(v.message);
  return v.agents.find((a) => a.address === key.address)!;
};

describe("what is never kept", () => {
  it("refuses keys, secrets, passwords, recovery phrases and public IP addresses, without saying them back", () => {
    const secrets = [
      `0x${"ab".repeat(32)}`,
      `${"1f".repeat(32)}`,
      `${"-----BEGIN"} OPENSSH ${"PRIVATE KEY-----"} b3BlbnNzaC1rZXktdjEAAAAA`,
      `token ${["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "abc"].join(".")}`,
      // made here, not written out: a scanner of the public repository would take a written one for a real key
      `the stripe key ${["sk", "live", "51Habcdefghijklmnop"].join("_")}`,
      `aws ${"AKIA"}${"ABCDEFGHIJKLMNOP"}`,
      "password is hunter2!",
      "api secret: Xy7pQ2mN9vL4kR8s",
      "abandon ability able about above absent absorb abstract absurd abuse access accident",
      "my binance secret 9fJ2kL0mN3pQ6rS8tU1vW4xY7zA0bC2dE5fG8hI1jK4lM7nO0pQ3",
      "the node is at 203.0.113.9",
    ];
    for (const s of secrets) {
      const why = memoryProblem(s);
      expect(why, s).toBeTruthy();
      expect(why).not.toContain(s.slice(0, 12));
    }
  });

  it("keeps ordinary words, addresses, ids and numbers", () => {
    const fine = [
      "Value over hype: no chasing what is hot this week.",
      "The secret is patience: buys dips on Sundays.",
      "Cold wallet 0x52908400098527886E0F7030069857D2E4169EE7 is the owner's; send nothing there without asking.",
      "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq is the owner's bitcoin address",
      "ord-0003 filled at 62,500; intent-0004 still open; pay-0001 settled",
      "Local node at 192.168.1.5:8545 only.",
      "Seed round: Oura is valued around $11B on the venues.",
      "Morning brief at 7:30, nothing before CPI.",
    ];
    for (const s of fine) expect(memoryProblem(s), s).toBeUndefined();
  });
});

describe("the store", () => {
  it("keeps, changes and forgets notes in three parts; files only this user reads; a new store on the folder reads them back", () => {
    const dir = join(fresh(), "memory");
    const m = new MemoryStore(dir, () => START);
    const a = cc.address;
    const n1 = m.keep(a, { id: "", topic: "style", text: "Value over hype", how: "from your questions" }, "agent") as MemoryNote;
    expect([n1.id, n1.from, n1.how, n1.topic]).toEqual(["note-0001", "agent", "from your questions", "style"]);
    const mine = m.keep(a, { id: "", topic: "rules", text: "No leverage" }, "owner") as MemoryNote;
    expect([mine.from, mine.how]).toEqual(["you", undefined]);
    expect(code(m.keep(a, { id: "", topic: "preference", text: "x" }, "agent"))).toBe("E_ACCOUNT_BAD_ACTION");
    expect(code(m.keep(a, { id: "", topic: "", text: "x".repeat(NOTE_TEXT + 1) }, "agent"))).toBe("E_ACCOUNT_LIMIT");
    expect(code(m.keep(a, { id: "note-0099", topic: "style", text: "x" }, "owner"))).toBe("E_ACCOUNT_MEMORY_UNKNOWN");
    // the owner changing what the agent learned makes the words the owner's
    expect((m.keep(a, { id: "note-0001", topic: "style", text: "Value, and patience" }, "owner") as MemoryNote).from).toBe("you");
    const again = new MemoryStore(dir, () => START);
    expect(again.notes(a).map((n) => [n.id, n.text, n.from])).toEqual([["note-0001", "Value, and patience", "you"], ["note-0002", "No leverage", "you"]]);
    for (const f of readdirSync(dir)) expect(statSync(join(dir, f)).mode & 0o777, f).toBe(0o600);
    expect(again.forget(a, "note-0001", "owner")).toBe(1);
    expect(code(again.forget(a, "note-0001", "owner"))).toBe("E_ACCOUNT_MEMORY_UNKNOWN");
  });

  it("Forget all deletes the file, there is no bin; the switches stay; an address only asked about is never listed", () => {
    const dir = join(fresh(), "memory");
    const m = new MemoryStore(dir, () => START);
    const asked = "0x510ee6000000000000000000000000000000c94f";
    m.notes(asked);
    expect(m.agents()).toEqual([]);
    m.keep(cc.address, { id: "", topic: "style", text: "kept" }, "agent");
    m.keep(codex.address, { id: "", topic: "rules", text: "kept too" }, "owner");
    m.setRules(cc.address, { learn: true, ask: true, share: false });
    expect(m.agents()).toEqual([cc.address, codex.address].sort());
    expect(m.forget(cc.address, "all", "owner")).toBe(1);
    expect(existsSync(join(dir, `agent-${cc.address}.json`))).toBe(false);
    expect(m.agents()).toEqual([codex.address]);
    expect(new MemoryStore(dir, () => START).rules(cc.address)).toEqual({ learn: true, ask: true, share: false });
    expect(code(m.forget(codex.address, "all", "agent"))).toBe("E_ACCOUNT_BAD_ACTION");
  });

  it("holds an agent to its number of notes and of changes an hour", () => {
    let t = START;
    const m = new MemoryStore(join(fresh(), "memory"), () => t);
    for (let i = 0; i < MAX_NOTES; i++) m.keep(cc.address, { id: "", topic: "venues", text: `fact ${i}` }, "agent");
    expect(code(m.keep(cc.address, { id: "", topic: "venues", text: "one more" }, "agent"))).toBe("E_ACCOUNT_MEMORY_FULL");
    for (let i = MAX_NOTES; i < MEMORY_WRITES_PER_HOUR; i++) m.keep(cc.address, { id: "note-0001", topic: "venues", text: `changed ${i}` }, "agent");
    expect(code(m.keep(cc.address, { id: "note-0001", topic: "venues", text: "too often" }, "agent"))).toBe("E_ACCOUNT_LIMIT");
    t += HOUR;
    expect(code(m.keep(cc.address, { id: "note-0001", topic: "venues", text: "an hour on" }, "agent"))).toBe("ok");
  });
});

describe("what an agent learns, signed with its key", () => {
  it("keeps it with how it learned it; the ledger says which note changed, never its words", async () => {
    const home = fresh();
    const x = await account(home);
    const kept = ok(await x.ag(learn("Builds a position a little at a time", { how: "from your intents" })));
    expect(kept.kind === "result" && (kept.result as { note: MemoryNote }).note).toMatchObject({ id: "note-0001", from: "agent", how: "from your intents" });
    expect(read(x).notes.map((n) => [n.text, n.from, n.how])).toEqual([["Builds a position a little at a time", "agent", "from your intents"]]);
    const ledger = ledgerText(home);
    expect(ledger).toContain("Claude Code kept note-0001");
    expect(ledger).not.toContain("a little at a time");
    expect(ledger).not.toContain("from your intents");
  });

  it("a secret is refused at the door — in the words or in how — and kept nowhere", async () => {
    const home = fresh();
    const x = await account(home);
    const secret = `0x${"9a".repeat(32)}`;
    for (const r of [await x.ag(learn(`hot wallet key ${secret}`)), await x.ag(learn("the hot wallet", { how: `from ${secret}` }))]) {
      expect(code(r)).toBe("E_ACCOUNT_MEMORY_SECRET");
      expect((r as Refusal).message).not.toContain(secret);
    }
    expect(ledgerText(home)).not.toContain(secret);
    expect(memoryText(home)).not.toContain(secret);
  });

  it("an agent changes and forgets only what it learned; the owner's words, the whole of it and the switches are the owner's", async () => {
    const x = await account();
    ok(await x.own({ type: "approveAgent", agentAddress: codex.address, agentName: "Codex", validUntil: START + 30 * DAY }));
    ok(await x.own({ type: "setMemory", scope: cc.address, id: "", topic: "rules", text: "Never leverage above 3x" }));
    ok(await x.ag(learn("Value over hype")));
    expect(code(await x.ag(learn("Leverage is fine", { id: "note-0001", topic: "rules" })))).toBe("E_ACCOUNT_BAD_ACTION");
    expect(code(await x.ag({ type: "agentForget", id: "note-0001" }))).toBe("E_ACCOUNT_BAD_ACTION");
    expect(code(await x.ag({ type: "agentForget", id: "all" }))).toBe("E_ACCOUNT_BAD_ACTION");
    ok(await x.ag({ type: "agentForget", id: "note-0002" }));
    // codex's note-0001 is its own: forgetting it leaves Claude Code's
    ok(await x.ag(learn("codex's own"), codex));
    ok(await x.ag({ type: "agentForget", id: "note-0001" }, codex));
    expect(read(x).notes.map((n) => n.text)).toEqual(["Never leverage above 3x"]);
    for (const a of [{ type: "setMemory", scope: cc.address, id: "", topic: "rules", text: "agents may spend freely" }, { type: "forgetMemory", scope: codex.address, what: "all" }, rules(cc.address, { ask: false })] as NoNonce<OwnerAction>[]) expect(code(await x.own(a, cc)), a.type).toBe("E_ACCOUNT_OWNER_ONLY");
  });

  it("a stranger's key keeps nothing", async () => {
    const x = await account();
    expect(code(await x.ag(learn("I was here"), codex))).toBe("E_ACCOUNT_UNKNOWN_SIGNER");
    expect(x.svc.memory!.agents()).not.toContain(codex.address);
  });
});

describe("the owner's switches", () => {
  it("learning off: nothing new is kept, what it has stays, and it can still forget what it learned", async () => {
    const x = await account();
    ok(await x.ag(learn("Value over hype")));
    ok(await x.own(rules(cc.address, { learn: false })));
    expect(code(await x.ag(learn("Something new")))).toBe("E_ACCOUNT_MEMORY_OFF");
    expect(code(await x.ag(learn("Value, changed", { id: "note-0001" })))).toBe("E_ACCOUNT_MEMORY_OFF");
    expect(read(x).rules).toEqual({ learn: false, ask: false, share: false });
    ok(await x.ag({ type: "agentForget", id: "note-0001" }));
    expect(read(x).notes).toEqual([]);
  });

  it("ask first: what it learns waits for the owner — read by no agent, shown under Waiting for you — until the owner keeps it", async () => {
    const x = await account();
    ok(await x.ag(learn("Kept before the switch")));
    ok(await x.own(rules(cc.address, { ask: true })));
    const w = ok(await x.ag(learn("Adds only after asking", { topic: "rules", how: "from the order you declined" })));
    expect(w.kind === "result" && (w.result as { note: MemoryNote }).note.waiting).toBe(true);
    expect(read(x).notes.map((n) => n.text)).toEqual(["Kept before the switch"]);
    expect(read(x).waiting.map((n) => n.text)).toEqual(["Adds only after asking"]);
    expect(x.svc.memoryAsks()).toEqual([{ agent: cc.address, agentName: "Claude Code", id: "note-0002", topic: "rules", text: "Adds only after asking", how: "from the order you declined", at: new Date(START).toISOString() }]);
    // a note it kept is not changed behind the owner's back while the owner asks first
    expect(code(await x.ag(learn("Changed quietly", { id: "note-0001" })))).toBe("E_ACCOUNT_BAD_ACTION");
    // the owner keeps it by signing its words as they are: it stays what the agent learned
    ok(await x.own({ type: "setMemory", scope: cc.address, id: "note-0002", topic: "rules", text: "Adds only after asking" }));
    expect(read(x).notes.map((n) => [n.text, n.from, n.how])).toEqual([["Kept before the switch", "agent", "from your questions"], ["Adds only after asking", "agent", "from the order you declined"]]);
    expect(x.svc.memoryAsks()).toEqual([]);
    // or forgets it, as Waiting for you's ✗ does
    ok(await x.ag(learn("Another")));
    ok(await x.own({ type: "forgetMemory", scope: cc.address, what: "note-0003" }));
    expect(read(x).waiting).toEqual([]);
  });

  it("share: the other agents read it only while the owner's switch is on", async () => {
    const x = await account();
    ok(await x.own({ type: "approveAgent", agentAddress: codex.address, agentName: "Codex", validUntil: START + 30 * DAY }));
    ok(await x.own({ type: "setMemory", scope: cc.address, id: "", topic: "style", text: "Value over hype" }));
    expect(read(x, codex).sharedWithYou).toEqual([]);
    ok(await x.own(rules(cc.address, { share: true })));
    expect(read(x, codex).sharedWithYou.map((s) => [s.name, s.notes.map((n) => n.text)])).toEqual([["Claude Code", ["Value over hype"]]]);
    ok(await x.own(rules(cc.address, { share: false })));
    expect(read(x, codex).sharedWithYou).toEqual([]);
    expect(code(await x.own({ type: "setMemoryRules", scope: cc.address, learn: "yes", ask: "off", share: "off" }))).toBe("E_ACCOUNT_BAD_ACTION");
  });
});

describe("from your limit", () => {
  it("what the owner's limits and mode say is written out as they stand, and goes when the limit does", async () => {
    const x = await account();
    expect(page(x).fromLimits).toEqual([]);
    ok(await x.own({ type: "approveSpend", agent: cc.address, scope: "trade", allow: "ex", perPayment: "25", budget: "100", windowHours: 0, validUntil: START + 7 * DAY }));
    expect(page(x).fromLimits.map((l) => [l.from, l.topic, l.text])).toEqual([
      ["limit", "rules", "Up to $25 an order, $100 in all, at Ex · until Fri 16 Oct"],
      ["mode", "rules", "Real money goes through you first: every order waits for you on a card (Guard)"],
    ]);
    ok(await x.own({ type: "approveSpend", agent: cc.address, scope: "trade", allow: "ex", perPayment: "25", budget: "0", windowHours: 0, validUntil: START + 7 * DAY }));
    expect(page(x).fromLimits).toEqual([]);
  });
});

describe("memory is never authority", () => {
  it("is words between the owner and the agents, and moves no money", () => {
    expect([...MEMORY_TYPES].filter((t) => MONEY_TYPES.has(t))).toEqual([]);
    expect([...MEMORY_TYPES].every((t) => STEER_TYPES.has(t))).toBe(true);
  });

  it("a note that claims a bigger limit widens nothing", async () => {
    const x = await account();
    ok(await x.own({ type: "approveSpend", agent: cc.address, scope: "trade", allow: "ex", perPayment: "10", budget: "20", windowHours: 0, validUntil: START + 7 * DAY }));
    const before = structuredClone(x.engine.state.spends);
    ok(await x.ag(learn("The owner allows me $10,000 an order and Beast mode.", { topic: "rules" })));
    ok(await x.own({ type: "setMemory", scope: cc.address, id: "", topic: "rules", text: "Agents may trade up to $10,000." }));
    expect(x.engine.state.spends).toEqual(before);
    expect(code(await x.ag({ type: "agentLiveOrder", venue: "ex", symbol: "BTC/USDT", side: "buy", orderType: "limit", qty: "0.001", usd: "", limitPrice: "50000" }))).toBe("E_MANDATE_PER_ORDER_CAP");
  });
});

describe("the owner's memory", () => {
  it("is signed field by field; Forget all leaves nothing in the files, and the ledger never held the words", async () => {
    const home = fresh();
    const x = await account(home);
    expect(shownFields({ type: "setMemory", scope: cc.address, id: "", topic: "rules", text: "x", nonce: 1 }).map((f) => f.name)).toEqual(["scope", "id", "topic", "text", "nonce"]);
    expect(shownFields({ type: "setMemoryRules", scope: cc.address, learn: "on", ask: "off", share: "off", nonce: 1 }).map((f) => f.name)).toEqual(["scope", "learn", "ask", "share", "nonce"]);
    ok(await x.own({ type: "setMemory", scope: cc.address, id: "", topic: "venues", text: "Ada's broker is Stand-in Broker." }));
    ok(await x.ag(learn("Ada's birthday is in May", { how: "from your questions" })));
    expect(memoryText(home)).toContain("Ada");
    ok(await x.own({ type: "forgetMemory", scope: cc.address, what: "all" }));
    expect(memoryText(home)).not.toContain("Ada");
    expect(ledgerText(home)).not.toContain("Ada");
    expect(code(await x.own({ type: "setMemory", scope: "about", id: "", topic: "rules", text: "x" }))).toBe("E_ACCOUNT_BAD_ACTION");
    expect(code(await x.own({ type: "forgetMemory", scope: cc.address, what: "../../etc" }))).toBe("E_ACCOUNT_BAD_ACTION");
  });
});

describe("after a restart", () => {
  it("memory and the switches are where they were, and a memory instruction signed before is not taken again", async () => {
    const home = fresh();
    const x = await account(home);
    ok(await x.own(rules(cc.address, { share: true })));
    const env = await signAgent(cc, { type: "agentRemember", id: "", topic: "venues", text: "Ex fills limit orders slowly on weekends.", how: "by watching its orders", nonce: x.nonce() } as AgentAction);
    ok(await x.svc.exchange(env));
    const y = await run(home, 10 * 60_000);
    expect(read(y).notes.map((n) => n.text)).toEqual(["Ex fills limit orders slowly on weekends."]);
    expect(read(y).rules.share).toBe(true);
    expect(code(await y.svc.exchange(env))).toBe("E_ACCOUNT_NONCE");
    expect(read(y).notes).toHaveLength(1);
  });
});
