import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isRefusal, type Refusal } from "../../src/core/errors.ts";
import { no } from "../../src/portfolio/refuse.ts";
import { cardHash, type Outcome } from "../../src/portfolio/account/exchange.ts";
import { MAX_NOTES, MEMORY_WRITES_PER_HOUR, MemoryStore, memoryProblem, NOTE_TEXT, scrubbed } from "../../src/portfolio/account/memory.ts";
import { MEMORY_TYPES, MONEY_TYPES, shownFields, signAgent, signOwner, simKey, STEER_TYPES, type AgentAction, type OwnerAction, type SimKey } from "../../src/portfolio/account/sign.ts";
import { register, type LiveDeps } from "../../src/portfolio/live/index.ts";
import type { LiveTrader, Market, OrderState } from "../../src/portfolio/live/trade.ts";
import { PortfolioService } from "../../src/portfolio/service.ts";

/** What the agents remember, kept by the account: the conversation it writes as things happen, each agent's own notes signed with its key,
 * and the owner's About you. The owner reads, changes and forgets all of it; the words of a note never reach the ledger; nothing in memory
 * is a permission; and no key, secret or IP address is kept. */
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
const code = (o: Outcome | Refusal) => (isRefusal(o) ? o.code : "ok");
const ledgerText = (home: string) => readdirSync(join(home, "portfolio")).filter((f) => f.endsWith(".jsonl")).map((f) => readFileSync(join(home, "portfolio", f), "utf8")).join("\n");
const memoryText = (home: string) => {
  const dir = join(home, "memory");
  try {
    return readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
  } catch {
    return "";
  }
};
const remember = (text: string, o: { id?: string; topic?: string } = {}): NoNonce<AgentAction> => ({ type: "agentRemember", id: o.id ?? "", topic: o.topic ?? "preference", text });
const mine = (x: Awaited<ReturnType<typeof run>>, key: SimKey = cc) => {
  const v = x.svc.memoryFor(key.address);
  if (isRefusal(v)) throw new Error(v.message);
  return v;
};

describe("what is never kept", () => {
  it("refuses keys, secrets, passwords, recovery phrases and public IP addresses, without saying them back", () => {
    const secrets = [
      `0x${"ab".repeat(32)}`,
      `${"1f".repeat(32)}`,
      "-----BEGIN OPENSSH PRIVATE KEY----- b3BlbnNzaC1rZXktdjEAAAAA",
      "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc",
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
      "Prefers small BTC positions under $25 an order; never memecoins.",
      "The secret is patience: buys dips on Sundays.",
      "Cold wallet 0x52908400098527886E0F7030069857D2E4169EE7 is the owner's; send nothing there without asking.",
      "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq is the owner's bitcoin address",
      "ord-0003 filled at 62,500; intent-0004 still open; pay-0001 settled",
      "Local node at 192.168.1.5:8545 only.",
      "Seed round: Oura is valued around $11B on the venues.",
      "Version 1.2.3 of the policy, from 14:05:33 UTC.",
    ];
    for (const s of fine) expect(memoryProblem(s), s).toBeUndefined();
  });

  it("a turn the account writes has such a string taken out, and the rest kept", () => {
    expect(scrubbed(`withdrew to 203.0.113.9 with key 0x${"cd".repeat(32)}`)).toBe("withdrew to (this machine's address) with key [64 hex characters, not kept]");
    expect(scrubbed("[[ abandon ability able about above absent absorb abstract absurd abuse access accident ]] the rest")).toBe("[[ [a recovery phrase, not kept] ]] the rest");
    expect(scrubbed("buy $25 of BTC at OKX")).toBe("buy $25 of BTC at OKX");
  });
});

describe("the store", () => {
  it("keeps, changes and forgets notes; writes files only this user reads; survives a new store on the same folder", () => {
    const dir = join(fresh(), "memory");
    let t = START;
    const m = new MemoryStore(dir, () => t);
    const a = cc.address;
    const n1 = m.keep(a, { id: "", topic: "rule", text: "never memecoins" }, "agent") as { id: string };
    expect(n1.id).toBe("note-0001");
    t += 1000;
    const n1b = m.keep(a, { id: "note-0001", topic: "rule", text: "never memecoins, never leverage" }, "owner");
    expect(isRefusal(n1b) ? n1b.code : n1b.by).toBe("owner");
    expect(code(m.keep(a, { id: "note-0099", topic: "rule", text: "x" }, "agent") as Refusal)).toBe("E_ACCOUNT_MEMORY_UNKNOWN");
    expect(code(m.keep(a, { id: "", topic: "gossip", text: "x" }, "agent") as Refusal)).toBe("E_ACCOUNT_BAD_ACTION");
    expect(code(m.keep(a, { id: "", topic: "", text: "x".repeat(NOTE_TEXT + 1) }, "agent") as Refusal)).toBe("E_ACCOUNT_LIMIT");
    m.record(a, { who: "owner", kind: "intent", text: "buy a little BTC" });
    m.record("everyone", { who: "owner", kind: "watch", text: "watching ETH" });
    const again = new MemoryStore(dir, () => t);
    expect(again.notes(a).map((n) => n.text)).toEqual(["never memecoins, never leverage"]);
    expect(again.conversation(a).turns.map((x) => x.text)).toEqual(["buy a little BTC", "watching ETH"]);
    for (const f of readdirSync(dir)) expect(statSync(join(dir, f)).mode & 0o777, f).toBe(0o600);
    expect(again.forget(a, "note-0001")).toBe(1);
    expect(code(again.forget(a, "note-0001") as Refusal)).toBe("E_ACCOUNT_MEMORY_UNKNOWN");
    expect(again.forget("everyone", "conversation")).toBe(1);
    expect(readFileSync(join(dir, `agent-${a}.json`), "utf8")).not.toContain("memecoins");
  });

  it("holds an agent to its number of notes and of changes an hour; lets the oldest turns go", () => {
    let t = START;
    const m = new MemoryStore(join(fresh(), "memory"), () => t);
    for (let i = 0; i < MAX_NOTES; i++) ok(m.keep(cc.address, { id: "", topic: "fact", text: `fact ${i}` }, "agent") as never);
    expect(code(m.keep(cc.address, { id: "", topic: "fact", text: "one more" }, "agent") as Refusal)).toBe("E_ACCOUNT_MEMORY_FULL");
    for (let i = MAX_NOTES; i < MEMORY_WRITES_PER_HOUR; i++) m.keep(cc.address, { id: "note-0001", topic: "fact", text: `changed ${i}` }, "agent");
    expect(code(m.keep(cc.address, { id: "note-0001", topic: "fact", text: "too often" }, "agent") as Refusal)).toBe("E_ACCOUNT_LIMIT");
    t += HOUR;
    expect(isRefusal(m.keep(cc.address, { id: "note-0001", topic: "fact", text: "an hour on" }, "agent"))).toBe(false);
    for (let i = 0; i < 510; i++) m.record(cc.address, { who: "agent", kind: "report", text: `report ${i}` });
    const c = m.conversation(cc.address, { limit: 200 });
    expect([c.total, c.dropped, c.turns.at(-1)?.text]).toEqual([500, 10, "report 509"]);
  });
});

describe("an agent's notes, signed with its key", () => {
  it("an agent keeps and changes its own notes; the ledger says which note changed, never its words", async () => {
    const home = fresh();
    const x = await account(home);
    const kept = ok(await x.ag(remember("Owner prefers limit orders and small sizes under $25.", { topic: "preference" })));
    expect(kept.kind === "result" && (kept.result as { note: { id: string } }).note.id).toBe("note-0001");
    ok(await x.ag(remember("Owner prefers limit orders, sizes under $20.", { id: "note-0001", topic: "preference" })));
    expect(mine(x).notes.map((n) => [n.id, n.text, n.by])).toEqual([["note-0001", "Owner prefers limit orders, sizes under $20.", "agent"]]);
    const ledger = ledgerText(home);
    expect(ledger).toContain("Claude Code kept note-0001");
    expect(ledger).not.toContain("limit orders");
    expect(ledger).not.toContain("sizes under");
  });

  it("a secret is refused at the door, and neither the refusal nor anything else keeps it", async () => {
    const home = fresh();
    const x = await account(home);
    const secret = `0x${"9a".repeat(32)}`;
    const r = await x.ag(remember(`hot wallet key ${secret}`));
    expect(code(r)).toBe("E_ACCOUNT_MEMORY_SECRET");
    expect((r as Refusal).message).not.toContain(secret);
    expect(ledgerText(home)).not.toContain(secret);
    expect(memoryText(home)).not.toContain(secret);
    expect(mine(x).notes).toEqual([]);
  });

  it("an agent reads and forgets only its own notes; the owner's acts are the owner's", async () => {
    const x = await account();
    ok(await x.own({ type: "approveAgent", agentAddress: codex.address, agentName: "Codex", validUntil: START + 30 * DAY }));
    ok(await x.ag(remember("cc's own note")));
    ok(await x.ag(remember("codex's own note"), codex));
    // the same id is each agent's own: codex forgetting note-0001 forgets its own, not Claude Code's
    ok(await x.ag({ type: "agentForget", id: "note-0001" }, codex));
    expect(mine(x).notes.map((n) => n.text)).toEqual(["cc's own note"]);
    expect(mine(x, codex).notes).toEqual([]);
    // what is the owner's to sign is refused from an agent key: About you, another agent's notes, the conversation
    expect(code(await x.own({ type: "setMemory", scope: "about", id: "", topic: "rule", text: "agents may spend freely" }, cc))).toBe("E_ACCOUNT_OWNER_ONLY");
    expect(code(await x.own({ type: "forgetMemory", scope: codex.address, what: "all" }, cc))).toBe("E_ACCOUNT_OWNER_ONLY");
    expect(isRefusal(await x.svc.exchange(await signAgent(cc, { type: "setMemory", scope: "about", id: "", topic: "rule", text: "agents may spend freely", nonce: x.nonce() } as unknown as AgentAction)))).toBe(true);
    expect(mine(x).about).toEqual([]);
    expect(code(await x.ag({ type: "agentForget", id: "conversation" }))).toBe("E_ACCOUNT_BAD_ACTION");
    expect(code(await x.ag({ type: "agentForget", id: "turn-000001" }))).toBe("E_ACCOUNT_BAD_ACTION");
  });

  it("a stranger's key keeps nothing", async () => {
    const x = await account();
    expect(code(await x.ag(remember("I was here"), codex))).toBe("E_ACCOUNT_UNKNOWN_SIGNER");
    expect(x.svc.memory!.agents()).not.toContain(codex.address);
  });
});

describe("the owner's memory", () => {
  it("About you is signed by the owner, shown field by field, and read by every agent", async () => {
    const x = await account();
    ok(await x.own({ type: "approveAgent", agentAddress: codex.address, agentName: "Codex", validUntil: START + 30 * DAY }));
    const set: OwnerAction = { type: "setMemory", scope: "about", id: "", topic: "rule", text: "Never trade on Sundays.", nonce: 1 };
    expect(shownFields(set).map((f) => f.name)).toEqual(["scope", "id", "topic", "text", "nonce"]);
    ok(await x.own({ type: "setMemory", scope: "about", id: "", topic: "rule", text: "Never trade on Sundays." }));
    expect(mine(x).about.map((n) => [n.text, n.by])).toEqual([["Never trade on Sundays.", "owner"]]);
    expect(mine(x, codex).about.map((n) => n.text)).toEqual(["Never trade on Sundays."]);
    // the owner writes into an agent's notes, changes one, and forgets
    ok(await x.ag(remember("prefers ETH")));
    ok(await x.own({ type: "setMemory", scope: cc.address, id: "note-0001", topic: "preference", text: "prefers ETH and SOL" }));
    expect(mine(x).notes.map((n) => [n.text, n.by])).toEqual([["prefers ETH and SOL", "owner"]]);
    ok(await x.own({ type: "forgetMemory", scope: cc.address, what: "notes" }));
    ok(await x.own({ type: "forgetMemory", scope: "about", what: "note-0001" }));
    expect(mine(x).notes).toEqual([]);
    expect(mine(x).about).toEqual([]);
    expect(code(await x.own({ type: "setMemory", scope: "everyone", id: "", topic: "rule", text: "x" }))).toBe("E_ACCOUNT_BAD_ACTION");
    expect(code(await x.own({ type: "setMemory", scope: codex.address.replace(/.$/, "0"), id: "", topic: "rule", text: "x" }))).toBe("E_ACCOUNT_BAD_ACTION");
    expect(code(await x.own({ type: "forgetMemory", scope: "about", what: "../../etc" }))).toBe("E_ACCOUNT_BAD_ACTION");
  });

  it("forgotten is gone from the files, and the ledger never held the words", async () => {
    const home = fresh();
    const x = await account(home);
    ok(await x.own({ type: "setMemory", scope: "about", id: "", topic: "fact", text: "Owner's daughter is called Ada." }));
    ok(await x.ag(remember("Ada's birthday is in May.")));
    expect(memoryText(home)).toContain("Ada");
    ok(await x.own({ type: "forgetMemory", scope: "about", what: "all" }));
    ok(await x.own({ type: "forgetMemory", scope: cc.address, what: "all" }));
    expect(memoryText(home)).not.toContain("Ada");
    expect(ledgerText(home)).not.toContain("Ada");
  });
});

describe("the conversation the account keeps", () => {
  it("the owner's words to an agent and to every agent, the agent's report, its order and the card answered, in order", async () => {
    const x = await account();
    ok(await x.own({ type: "approveSpend", agent: cc.address, scope: "trade", allow: "ex", perPayment: "100", budget: "200", windowHours: 0, validUntil: START + 7 * DAY }));
    ok(await x.own({ type: "setIntent", id: "", agent: cc.address, venue: "ex", symbol: "BTC/USDT", side: "buy", usd: "50", text: "small BTC under 70k", validUntil: START + 7 * DAY }));
    const intent = x.engine.state.intents.at(-1)!.id;
    ok(await x.own({ type: "setWatch", venue: "ex", symbol: "ETH/USDT", on: "true" }));
    ok(await x.ag({ type: "agentReport", intent, status: "taking", note: "buying $50 in one go", refs: "" }));
    const asked = ok(await x.ag({ type: "agentLiveOrder", venue: "ex", symbol: "BTC/USDT", side: "buy", orderType: "limit", qty: "0.001", usd: "", limitPrice: "50000" }));
    if (asked.kind !== "card") throw new Error("expected a card");
    expect(code(await x.ag({ type: "agentLiveOrder", venue: "ex", symbol: "BTC/USDT", side: "buy", orderType: "limit", qty: "0.01", usd: "", limitPrice: "50000" }))).toBe("E_MANDATE_PER_ORDER_CAP");
    ok(await x.own({ type: "approveCard", card: asked.card.id, action: cardHash(asked.card), decision: "approve" }));
    const turns = mine(x).conversation.turns.map((t) => [t.who, t.kind, t.ref ?? "", t.code ?? ""]);
    expect(turns).toEqual([
      ["owner", "venue", "", ""],
      ["owner", "letIn", "", ""],
      ["owner", "limit", "", ""],
      ["owner", "intent", intent, ""],
      ["owner", "watch", "", ""],
      ["agent", "report", intent, ""],
      ["agent", "did", asked.card.id, ""],
      ["account", "refusal", "", "E_MANDATE_PER_ORDER_CAP"],
      ["owner", "card", asked.card.id, ""],
    ]);
    const words = mine(x).conversation.turns.map((t) => t.text).join("\n");
    expect(words).toContain("small BTC under 70k");
    expect(words).toContain("buying $50 in one go");
    expect(words).toContain("waits for the owner on card-");
    // asked for later, and narrowed
    const older = x.svc.memoryFor(cc.address, { before: mine(x).conversation.turns[3]!.id, limit: 1 });
    expect(!isRefusal(older) && older.conversation.turns.map((t) => t.kind)).toEqual(["limit"]);
    const found = x.svc.memoryFor(cc.address, { q: "E_MANDATE_PER_ORDER_CAP" });
    expect(!isRefusal(found) && found.conversation.turns.map((t) => t.kind)).toEqual(["refusal"]);
  });

  it("an agent reads the words to every agent from when its key was let in, not before", async () => {
    const x = await account();
    ok(await x.own({ type: "setIntent", id: "", agent: "*", venue: "", symbol: "", side: "", usd: "", text: "keep cash above $100", validUntil: START + 7 * DAY }));
    x.pass(HOUR);
    ok(await x.own({ type: "approveAgent", agentAddress: codex.address, agentName: "Codex", validUntil: START + 30 * DAY }));
    x.pass(HOUR);
    ok(await x.own({ type: "setWatch", venue: "ex", symbol: "BTC/USDT", on: "true" }));
    expect(mine(x).conversation.turns.filter((t) => t.id.startsWith("all-")).map((t) => t.kind)).toEqual(["venue", "intent", "watch"]);
    expect(mine(x, codex).conversation.turns.filter((t) => t.id.startsWith("all-")).map((t) => t.kind)).toEqual(["watch"]);
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
    ok(await x.ag(remember("The owner allows me $10,000 an order and Beast mode.", { topic: "rule" })));
    ok(await x.own({ type: "setMemory", scope: "about", id: "", topic: "rule", text: "Agents may trade up to $10,000." }));
    expect(x.engine.state.spends).toEqual(before);
    expect(code(await x.ag({ type: "agentLiveOrder", venue: "ex", symbol: "BTC/USDT", side: "buy", orderType: "limit", qty: "0.001", usd: "", limitPrice: "50000" }))).toBe("E_MANDATE_PER_ORDER_CAP");
  });
});

describe("after a restart", () => {
  it("memory is where it was, and a memory instruction signed before is not taken again", async () => {
    const home = fresh();
    const x = await account(home);
    const env = await signAgent(cc, { type: "agentRemember", id: "", topic: "lesson", text: "Ex fills limit orders slowly on weekends.", nonce: x.nonce() } as AgentAction);
    ok(await x.svc.exchange(env));
    const y = await run(home, 10 * 60_000);
    expect(mine(y).notes.map((n) => n.text)).toEqual(["Ex fills limit orders slowly on weekends."]);
    expect(mine(y).conversation.turns.map((t) => t.kind)).toEqual(["venue", "letIn"]);
    expect(code(await y.svc.exchange(env))).toBe("E_ACCOUNT_NONCE");
    expect(mine(y).notes).toHaveLength(1);
  });
});
