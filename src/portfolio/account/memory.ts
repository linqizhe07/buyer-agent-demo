/** WHAT EACH AGENT REMEMBERS ABOUT YOU, kept by the account — the Demo v2 canvas's F13 ("Account › Memory: what Gravit remembers about
 * you"). An agent that comes back (a new session, a restart, another program holding the same seat) reads it again; the owner reads every
 * word of it on the page, changes it, forgets it, and decides with three switches what an agent may add.
 *
 * One list a key, in three parts — Style · Rules · Venues and people — each note saying where it came from:
 *
 *   you said        the owner wrote it, or changed it (setMemory, signed)
 *   it learned      the agent kept it, with its own key (agentRemember), and said how ("from your questions", "from the order you
 *                   declined", "by comparing the venues"): its words, never the owner's
 *   from your limit what the owner's signed limits and mode say, written out by the account as they stand (service.ts memoryLimits): not
 *                   kept here, never out of date, changed only by changing the limit
 *
 * The switches, an agent each, the owner's to sign (setMemoryRules):
 *
 *   learn   the agent may keep new notes; off, it uses the ones it has
 *   ask     what it learns waits for the owner first: a new note is kept `waiting`, shown in Waiting for you, read by no agent until the
 *           owner keeps it (setMemory with its words) or forgets it
 *   share   the other agents on the account read it too; off, only this agent does
 *
 * Forgotten is gone: one note from its file, Forget all the file itself — there is no bin. The words of a note never reach the ledger
 * (account/exchange.ts keeps them out), so nothing forgotten is kept anywhere else.
 *
 * Words, not authority. No limit, door or card reads this file: a note that says "the owner allows $10,000 an order" allows nothing, and
 * what an agent may do is still only its limits and the owner's cards.
 *
 * What is never kept: a private key, a recovery phrase, an API key or secret, a password, a signed token, a public IP address — refused
 * (memoryProblem) without the words being said back. The place the user is in is not written here by the account (live/location.ts uses
 * it in memory only).
 *
 * Files: <home>/memory/agent-<address>.json (the notes) and rules.json (the switches, which Forget all leaves as they were), written whole
 * each time (a temporary file, then a rename), readable by this system user only. The home is the trust boundary, as it is for the ledger
 * and the key files: agents on the same system user are not walled off from each other's files — the MCP seat reads only what is its to
 * read, and that is a convention of the seat, not a wall.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { english } from "viem/accounts";
import type { Refusal } from "../../core/errors.ts";
import { no, unaddressed } from "../refuse.ts";

/** the longest note, in characters */
export const NOTE_TEXT = 500;
/** the longest "how it learned it" */
export const HOW_TEXT = 80;
/** notes one agent's memory holds, the ones waiting for the owner included */
export const MAX_NOTES = 100;
/** an agent key's changes to its memory in an hour */
export const MEMORY_WRITES_PER_HOUR = 120;
/** what a note is about: F13's three parts */
export const TOPICS = ["style", "rules", "venues"] as const;
export type Topic = (typeof TOPICS)[number];
export const TOPIC_WORDS: Record<Topic, string> = { style: "Style", rules: "Rules", venues: "Venues and people" };

export interface MemoryNote {
  /** `note-0003`, in its agent's memory */
  id: string;
  topic: Topic;
  text: string;
  /** you: the owner wrote it or changed it · agent: the agent learned it */
  from: "you" | "agent";
  /** how the agent learned it, in its words ("from your questions"); an agent's note only */
  how?: string | undefined;
  /** when it was first kept (ISO) */
  at: string;
  /** when it was last changed */
  updatedAt?: string | undefined;
  /** an agent's new note while the owner asks to be asked first: no agent reads it until the owner keeps it */
  waiting?: boolean | undefined;
}

/** the owner's switches for one agent's memory */
export interface MemoryRules {
  /** it may keep new notes */
  learn: boolean;
  /** what it learns waits for the owner first */
  ask: boolean;
  /** the other agents on the account read it too */
  share: boolean;
}
export const DEFAULT_RULES: MemoryRules = { learn: true, ask: false, share: false };

interface AgentFile {
  v: 2;
  address: string;
  seq: number;
  notes: MemoryNote[];
}
interface RulesFile {
  v: 1;
  rules: Record<string, MemoryRules>;
}

const isAddress = (s: string): boolean => /^0x[0-9a-f]{40}$/.test(s);

// ---- what is never kept --------------------------------------------------------------

const BIP39 = new Set<string>(english);
/** a key block: PEM, an SSH or PGP private key */
const KEY_BLOCK = /-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|KEY BLOCK|ENCRYPTED|OPENSSH)[A-Z0-9 ]*-----/;
/** sixty-four hex characters: a private key (a transaction is named by its order or payment id instead) */
const HEX64 = /(?<![0-9a-fA-F])(?:0x)?[0-9a-fA-F]{64}(?![0-9a-fA-F])/;
/** a signed token: a JWT or a JWS */
const JWT = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*/;
/** keys that say what they are by their first letters */
const PREFIXED = /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}|\bsk-[A-Za-z0-9_-]{16,}|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bAIza[0-9A-Za-z_-]{30,}/;
/** a secret given its name: "password is …", "api secret = …"; and the words that mean a secret only before an = or a colon ("secret: …",
 * not "the secret is patience") */
const LABELLED = /\b(?:(?:password|passphrase|passwd|pass ?code|api[ _-]?(?:key|secret)|private[ _-]?key|secret[ _-]?key|seed[ _-]?phrase|recovery[ _-]?phrase|mnemonic)\s*(?:is|=|:)|(?:secret|seed|2fa|otp|totp|token|pin)\s*[=:])\s*\S{4,}/i;
/** a long random run of letters and digits: what an API secret looks like */
const LONG_RUN = /[A-Za-z0-9+/=_-]{40,}/g;

/** a run that is an address, not a secret: an EVM address, a bech32 address (one case only) */
const anAddress = (run: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(run) || /^(?:bc|tb|ltc)1[0-9a-z]{20,90}$/.test(run);

function longSecret(text: string): boolean {
  for (const m of text.matchAll(LONG_RUN)) {
    const run = m[0];
    if (anAddress(run)) continue;
    // mixed case and digits; and longer than a base58 address (Solana's are 32 to 44) or with a letter base58 leaves out
    if (/[A-Z]/.test(run) && /[a-z]/.test(run) && /[0-9]/.test(run) && (run.length >= 48 || /[0OIl+/=_-]/.test(run))) return true;
  }
  return false;
}

/** a word of a recovery phrase as written: the word, perhaps with a comma or a full stop after it */
const phraseWord = (part: string): boolean => /^[A-Za-z]+[.,;:]?$/.test(part) && BIP39.has(part.replace(/[^A-Za-z]/g, "").toLowerCase());

/** twelve or more words in a row from the BIP-39 list: a recovery phrase */
function phraseRun(text: string): boolean {
  let run = 0;
  for (const part of text.split(/\s+/).filter(Boolean)) {
    run = phraseWord(part) ? run + 1 : 0;
    if (run >= 12) return true;
  }
  return false;
}

/** Why these words cannot be kept, or undefined when they can. Never says the words back */
export function memoryProblem(text: string): string | undefined {
  if (KEY_BLOCK.test(text)) return "it holds a key block";
  if (HEX64.test(text)) return "it holds 64 hex characters in a row, which is what a private key looks like (name a transaction by its order or payment id: ord-0003, pay-0001)";
  if (JWT.test(text)) return "it holds a signed token";
  if (PREFIXED.test(text) || LABELLED.test(text)) return "it holds what looks like a password, an API key or a secret";
  if (phraseRun(text)) return "it holds twelve or more words of a wallet's recovery phrase list in a row";
  if (longSecret(text)) return "it holds a long random string, which is what an API secret looks like";
  if (unaddressed(text) !== text) return "it holds a public IP address, and the account keeps none";
  return undefined;
}

/** words as they are kept: no control characters, one space between words, at most one empty line, trimmed */
const tidy = (text: string): string => String(text ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

// ---- the store -------------------------------------------------------------------------

export class MemoryStore {
  private readonly cache = new Map<string, AgentFile>();
  private rulesFile: RulesFile | undefined;
  /** changes to its memory in the last hour, by agent key: kept in memory, a restart starts the count again */
  private readonly writes = new Map<string, number[]>();

  constructor(
    private readonly dir: string,
    private readonly nowMs: () => number,
  ) {}

  private path(address: string): string {
    return join(this.dir, `agent-${address}.json`);
  }

  private save(path: string, data: unknown): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 1)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
    try {
      chmodSync(path, 0o600);
    } catch {
      /* a file system without modes */
    }
  }

  /** a file that does not read as one is left beside it, unread, and memory starts again */
  private readJson(path: string): unknown {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      try {
        renameSync(path, `${path}.unread-${this.nowMs()}`);
      } catch {
        /* nothing to keep aside */
      }
      return undefined;
    }
  }

  /** one agent's file; one that is not there is not held either, so asking about any number of addresses keeps nothing */
  private file(address: string): AgentFile {
    const hit = this.cache.get(address);
    if (hit) return hit;
    const empty: AgentFile = { v: 2, address, seq: 0, notes: [] };
    const p = this.path(address);
    if (!existsSync(p)) return empty;
    const got = this.readJson(p) as Partial<AgentFile> | undefined;
    const file: AgentFile = got && got.v === 2 && Array.isArray(got.notes) ? { ...empty, ...got, address } : empty;
    this.cache.set(address, file);
    return file;
  }

  private write(address: string, file: AgentFile): void {
    this.save(this.path(address), file);
    this.cache.set(address, file);
  }

  private rulesOf(): RulesFile {
    if (this.rulesFile) return this.rulesFile;
    const p = join(this.dir, "rules.json");
    const got = existsSync(p) ? (this.readJson(p) as Partial<RulesFile> | undefined) : undefined;
    this.rulesFile = got && got.v === 1 && got.rules && typeof got.rules === "object" ? { v: 1, rules: got.rules } : { v: 1, rules: {} };
    return this.rulesFile;
  }

  /** the agents with a note kept, waiting ones included, by address. An address only asked about is not one */
  agents(): string[] {
    const addresses = new Set<string>(this.cache.keys());
    if (existsSync(this.dir)) for (const name of readdirSync(this.dir)) {
      const m = /^agent-(0x[0-9a-f]{40})\.json$/.exec(name);
      if (m) addresses.add(m[1]!);
    }
    return [...addresses].filter((a) => this.file(a).notes.length > 0).sort();
  }

  /** one agent's notes, the ones waiting for the owner included */
  notes(address: string): MemoryNote[] {
    return isAddress(address) ? [...this.file(address).notes] : [];
  }

  /** the agents' notes waiting for the owner, oldest first */
  waiting(): Array<{ address: string; note: MemoryNote }> {
    return this.agents().flatMap((address) => this.file(address).notes.filter((n) => n.waiting).map((note) => ({ address, note }))).sort((a, b) => a.note.at.localeCompare(b.note.at));
  }

  rules(address: string): MemoryRules {
    return { ...DEFAULT_RULES, ...(this.rulesOf().rules[address] ?? {}) };
  }

  setRules(address: string, rules: MemoryRules): MemoryRules | Refusal {
    if (!isAddress(address)) return no("E_ACCOUNT_BAD_ACTION", { message: "an agent's memory is named by the address of its key" });
    const file = this.rulesOf();
    this.rulesFile = { v: 1, rules: { ...file.rules, [address]: { learn: rules.learn, ask: rules.ask, share: rules.share } } };
    this.save(join(this.dir, "rules.json"), this.rulesFile);
    return this.rules(address);
  }

  /** Keep a note, or change one (`id` "" is a new one). The agent (by "agent") keeps what it learned — while its switch lets it, waiting for
   * the owner when the owner asks to be asked first — and changes only its own; the owner (by "owner") writes and changes any, and keeps a
   * waiting one by signing its words as they are. The words are checked first: what must never be kept is refused, unrepeated */
  keep(address: string, input: { id: string; topic: string; text: string; how?: string | undefined }, by: "agent" | "owner"): MemoryNote | Refusal {
    if (!isAddress(address)) return no("E_ACCOUNT_BAD_ACTION", { message: "an agent's memory is named by the address of its key" });
    const text = tidy(input.text);
    if (!text) return no("E_ACCOUNT_BAD_ACTION", { message: "a note has words: to take one away, forget it" });
    if (text.length > NOTE_TEXT) return no("E_ACCOUNT_LIMIT", { message: `a note is at most ${NOTE_TEXT} characters; this one is ${text.length}`, detail: { max: NOTE_TEXT, length: text.length } });
    const topic = (input.topic.trim().toLowerCase() || "style") as Topic;
    if (!TOPICS.includes(topic)) return no("E_ACCOUNT_BAD_ACTION", { message: `a note is about one of ${TOPICS.join(", ")} (${TOPICS.map((t) => TOPIC_WORDS[t]).join(" · ")})`, detail: { topics: [...TOPICS] } });
    const how = by === "agent" ? tidy(input.how ?? "") : "";
    if (how.length > HOW_TEXT) return no("E_ACCOUNT_LIMIT", { message: `how it was learned is at most ${HOW_TEXT} characters`, detail: { max: HOW_TEXT } });
    const problem = memoryProblem(`${text}\n${how}`);
    if (problem) return no("E_ACCOUNT_MEMORY_SECRET", { message: `not kept: ${problem}. The account keeps no keys, secrets, passwords or IP addresses in memory` });
    const now = this.nowMs();
    const rules = this.rules(address);
    const file = this.file(address);
    const id = input.id.trim();
    const was = id ? file.notes.find((n) => n.id === id) : undefined;
    if (id && !was) return no("E_ACCOUNT_MEMORY_UNKNOWN", { message: `there is no note "${id.slice(0, 20)}" in this memory: a new note has the id ""`, detail: { id: id.slice(0, 20) } });
    if (by === "agent") {
      if (!rules.learn) return no("E_ACCOUNT_MEMORY_OFF", { message: "the owner switched off new memories for this agent: it uses the ones it has" });
      if (was && was.from === "you") return no("E_ACCOUNT_BAD_ACTION", { message: `${was.id} is the owner's words: the owner changes them` });
      // asked first: what it learns waits for the owner, and a note already kept is not changed behind the owner's back
      if (was && rules.ask && !was.waiting) return no("E_ACCOUNT_BAD_ACTION", { message: `the owner asks to be asked first: a note it kept is not changed — keep a new one (it waits for the owner), or forget ${was.id}` });
      const times = (this.writes.get(address) ?? []).filter((t) => now - t < 3_600_000);
      if (times.length >= MEMORY_WRITES_PER_HOUR) return no("E_ACCOUNT_LIMIT", { message: `at most ${MEMORY_WRITES_PER_HOUR} changes to an agent's memory an hour`, detail: { perHour: MEMORY_WRITES_PER_HOUR } });
      this.writes.set(address, [...times, now]);
    }
    const at = new Date(now).toISOString();
    if (was) {
      // the owner keeping a waiting note signs its words as they are: it stays what the agent learned. Any other change by the owner makes
      // the words the owner's
      const keeps = by === "owner" && was.waiting && text === was.text && topic === was.topic;
      const note: MemoryNote = keeps
        ? { ...was, waiting: undefined, updatedAt: at }
        : by === "owner"
          ? { id: was.id, topic, text, from: "you", at: was.at, updatedAt: at }
          : { ...was, topic, text, how: how || was.how, updatedAt: at };
      this.write(address, { ...file, notes: file.notes.map((n) => (n === was ? clean(note) : n)) });
      return clean(note);
    }
    if (file.notes.length >= MAX_NOTES) return no("E_ACCOUNT_MEMORY_FULL", { message: `this memory holds ${MAX_NOTES} notes already: forget one, or change one, first`, detail: { max: MAX_NOTES } });
    const note: MemoryNote = clean({ id: `note-${String(file.seq + 1).padStart(4, "0")}`, topic, text, from: by === "owner" ? "you" : "agent", how: how || undefined, at, waiting: by === "agent" && rules.ask ? true : undefined });
    this.write(address, { ...file, seq: file.seq + 1, notes: [...file.notes, note] });
    return note;
  }

  /** Forget one note (`note-0003`), or `all`: the agent's file itself, deleted — there is no bin. An agent forgets only notes it learned;
   * the owner's words are the owner's to forget. How many went */
  forget(address: string, what: string, by: "agent" | "owner"): number | Refusal {
    if (!isAddress(address)) return no("E_ACCOUNT_BAD_ACTION", { message: "an agent's memory is named by the address of its key" });
    const w = what.trim();
    const file = this.file(address);
    if (w === "all") {
      if (by === "agent") return no("E_ACCOUNT_BAD_ACTION", { message: "forgetting everything is the owner's: an agent forgets one of its own notes" });
      const gone = file.notes.length;
      rmSync(this.path(address), { force: true });
      this.cache.delete(address);
      return gone;
    }
    const was = file.notes.find((n) => n.id === w);
    if (!was) return no("E_ACCOUNT_MEMORY_UNKNOWN", { message: `there is no "${w.slice(0, 20)}" in this memory: it was forgotten already, or never kept`, detail: { what: w.slice(0, 20) } });
    if (by === "agent" && was.from === "you") return no("E_ACCOUNT_BAD_ACTION", { message: `${was.id} is the owner's words: the owner forgets them` });
    this.write(address, { ...file, notes: file.notes.filter((n) => n !== was) });
    return 1;
  }

  /** notes that match `q`, any case, by their words, how, topic or id */
  static matching(notes: MemoryNote[], q: string | undefined): MemoryNote[] {
    const k = (q ?? "").trim().toLowerCase();
    return k ? notes.filter((n) => n.text.toLowerCase().includes(k) || (n.how ?? "").toLowerCase().includes(k) || n.topic === k || n.id === k) : notes;
  }
}

/** a note without the fields it does not carry */
const clean = (n: MemoryNote): MemoryNote => Object.fromEntries(Object.entries(n).filter(([, v]) => v !== undefined && v !== "")) as unknown as MemoryNote;
