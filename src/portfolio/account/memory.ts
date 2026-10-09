/** WHAT THE AGENTS REMEMBER, kept by the account — so that an agent that comes back (a new session, a restart, another program holding the
 * same seat) knows the owner and its own work again, and so that the owner can read every word of it, change it and take it away.
 *
 * Two layers:
 *
 *   the conversation   what passed between the owner and each agent, in order, as the account saw it happen: the owner's intents (and
 *                      their withdrawal), a key let in or revoked, a limit given, a card answered, an ask declined; the agent's reports,
 *                      its asks, and every instruction it signed with what came of it (an order placed, a card raised, a refusal and its
 *                      code). Words addressed to every agent ("*") are kept once, in a stream every agent reads from the moment its key
 *                      was let in. The account writes these; no one signs a turn. MAX_TURNS a stream: the oldest are let go
 *   the notes          what an agent chose to keep — a preference, a rule, a fact, a lesson, how far a task has got — signed with its own
 *                      key (agentRemember, agentForget), at most MAX_NOTES each and NOTE_TEXT characters a note. An agent reads only its
 *                      own. Beside them, the owner's "About you": notes the owner signs (setMemory), which every agent reads
 *
 * The owner reads all of it on the page (Account → Memory), signs a change to any note, and signs it away (forgetMemory: one note, one
 * turn, a conversation, everything an agent kept). Forgotten is gone from these files: the words of a note never reach the ledger, whose
 * rows say only who changed which note when (account/exchange.ts keeps them out), so nothing forgotten here is kept anywhere else. What the
 * ledger already holds for its own reasons — a signed intent, a report — stays there, as it always has.
 *
 * Words, not authority. No limit, door or card reads this file: a note that says "the owner allows $10,000 an order" allows nothing, and
 * the owner's own wishes reach the agents as intents and limits the owner signs. A note is what an agent wrote — the owner's About you is
 * the only part the owner signed.
 *
 * What is never kept: a private key, a recovery phrase, an API key or secret, a password, a signed token, a public IP address. A note that
 * looks like one is refused (memoryProblem) without its words being repeated anywhere; a turn the account writes has such a string taken
 * out (scrubbed). The place the user is in is not written here by the account (live/location.ts uses it in memory only).
 *
 * Files: <home>/memory/about.json · everyone.json · agent-<address>.json, written whole each time (a temporary file, then a rename), readable
 * by this system user only. The home is the trust boundary, as it is for the ledger and the key files: agents on the same system user are
 * not walled off from each other's files — the MCP seat reads only its own notes, and that is a convention of the seat, not a wall.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { english } from "viem/accounts";
import type { Refusal } from "../../core/errors.ts";
import { no, unaddressed } from "../refuse.ts";

/** the longest note, in characters */
export const NOTE_TEXT = 500;
/** notes an agent may keep */
export const MAX_NOTES = 100;
/** notes the owner keeps for every agent (About you) */
export const MAX_ABOUT = 50;
/** turns a conversation keeps: the oldest are let go */
export const MAX_TURNS = 500;
/** an agent key's writes to its notes in an hour */
export const MEMORY_WRITES_PER_HOUR = 120;
/** the longest a turn's words are kept */
export const TURN_TEXT = 600;
/** what a note is about */
export const TOPICS = ["preference", "rule", "fact", "lesson", "progress", "other"] as const;
export type Topic = (typeof TOPICS)[number];

export interface MemoryNote {
  /** `note-0003`, within its scope */
  id: string;
  topic: Topic;
  text: string;
  /** when it was first written (ISO) */
  at: string;
  /** when it was last changed, when it was */
  updatedAt?: string | undefined;
  /** who wrote it last: the agent itself, or the owner */
  by: "agent" | "owner";
}

export type TurnWho = "owner" | "agent" | "account";
export interface MemoryTurn {
  /** `turn-000041` in an agent's conversation, `all-000007` in the one to every agent */
  id: string;
  at: string;
  who: TurnWho;
  /** intent · withdraw · letIn · revoke · limit · wallet · card · declined · mode · venue · watch (the owner's); report · ask · did (the
   * agent's); refusal (the account's answer to the agent) */
  kind: string;
  text: string;
  /** what it is about, by its id on the account: intent-0003, card-0007, ord-0005, ask-0002, pay-0001 */
  ref?: string | undefined;
  /** a refusal's code */
  code?: string | undefined;
}

/** one agent's conversation as it reads it: its own and the words to every agent since its key was let in, latest last */
export interface Conversation {
  turns: MemoryTurn[];
  /** how many turns there are in all (the ones shown included) */
  total: number;
  /** whether there are older ones than the first shown */
  more: boolean;
  /** turns let go since the conversation began, oldest first, to keep MAX_TURNS */
  dropped: number;
}

interface NotesFile {
  v: 1;
  seq: number;
  notes: MemoryNote[];
}
interface TurnsFile {
  v: 1;
  seq: number;
  turns: MemoryTurn[];
  dropped: number;
}
type AgentFile = NotesFile & TurnsFile & { address: string; turnSeq: number };

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

/** the text with every run of twelve or more such words put away */
function withoutPhrases(text: string): string {
  const out: string[] = [];
  let run: string[] = [];
  let words = 0;
  const flush = () => {
    if (words >= 12) {
      const tail = run[run.length - 1] ?? "";
      out.push("[a recovery phrase, not kept]", /^\s+$/.test(tail) ? tail : "");
    } else out.push(...run);
    run = [];
    words = 0;
  };
  for (const part of text.split(/(\s+)/)) {
    if (part === "" || /^\s+$/.test(part)) {
      if (words > 0) run.push(part);
      else out.push(part);
    } else if (phraseWord(part)) {
      run.push(part);
      words++;
    } else {
      flush();
      out.push(part);
    }
  }
  flush();
  return out.join("");
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

/** a turn's words with anything that must not be kept taken out: the account writes turns itself, from what was already said */
export function scrubbed(text: string): string {
  let t = unaddressed(String(text ?? ""));
  t = t.replace(new RegExp(KEY_BLOCK.source + "[\\s\\S]*?-----END[^-]*-----", "g"), "[a key block, not kept]");
  t = t.replace(new RegExp(HEX64.source, "g"), "[64 hex characters, not kept]");
  t = t.replace(new RegExp(JWT.source, "g"), "[a token, not kept]");
  t = t.replace(new RegExp(PREFIXED.source, "g"), "[a key, not kept]");
  t = t.replace(new RegExp(LABELLED.source, "gi"), "[a secret, not kept]");
  t = t.replace(LONG_RUN, (run) => (!anAddress(run) && longSecret(run) ? "[a long string, not kept]" : run));
  if (phraseRun(t)) t = withoutPhrases(t);
  return t.length > TURN_TEXT ? `${t.slice(0, TURN_TEXT - 1)}…` : t;
}

/** a note's words as they are kept: one line of spaces between words, trimmed */
const tidy = (text: string): string => String(text ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

// ---- the store -------------------------------------------------------------------------

export type Scope = "about" | "everyone" | string;

export class MemoryStore {
  private readonly cache = new Map<string, NotesFile | TurnsFile | AgentFile>();
  /** writes to its notes in the last hour, by agent key: kept in memory, a restart starts the count again */
  private readonly writes = new Map<string, number[]>();
  /** the time of the last turn written: two turns in one millisecond are a millisecond apart, so that an agent's turns and the words to
   * every agent, kept in two files, read back in the order they happened */
  private lastTurnMs = 0;

  constructor(
    private readonly dir: string,
    private readonly nowMs: () => number,
  ) {}

  private path(scope: Scope): string {
    return join(this.dir, scope === "about" ? "about.json" : scope === "everyone" ? "everyone.json" : `agent-${scope}.json`);
  }

  private read<T extends NotesFile | TurnsFile | AgentFile>(scope: Scope, empty: () => T): T {
    const hit = this.cache.get(scope);
    if (hit) return hit as T;
    let file = empty();
    const p = this.path(scope);
    // nothing kept there: not held either, so asking about any number of addresses keeps nothing
    if (!existsSync(p)) return file;
    try {
      const got = JSON.parse(readFileSync(p, "utf8")) as T;
      if (got && got.v === 1) file = { ...empty(), ...got };
    } catch {
      // a file that does not read as one is started again; the broken one is left beside it, unread
      try {
        renameSync(p, `${p}.unread-${this.nowMs()}`);
      } catch {
        /* nothing to keep aside */
      }
    }
    this.cache.set(scope, file);
    return file;
  }

  private write(scope: Scope, file: NotesFile | TurnsFile | AgentFile): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const p = this.path(scope);
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(file, null, 1)}\n`, { mode: 0o600 });
    renameSync(tmp, p);
    try {
      chmodSync(p, 0o600);
    } catch {
      /* a file system without modes */
    }
    this.cache.set(scope, file);
  }

  private aboutFile = (): NotesFile => this.read<NotesFile>("about", () => ({ v: 1, seq: 0, notes: [] }));
  private everyoneFile = (): TurnsFile => this.read<TurnsFile>("everyone", () => ({ v: 1, seq: 0, turns: [], dropped: 0 }));
  private agentFile = (address: string): AgentFile => this.read<AgentFile>(address, () => ({ v: 1, address, seq: 0, notes: [], turnSeq: 0, turns: [], dropped: 0 }));

  /** the agents with something kept — a note or a turn — by address. An address only asked about (a read of its memory) is not one: what
   * is listed is what was written, so a read can never put an agent on the owner's page */
  agents(): string[] {
    const addresses = new Set<string>([...this.cache.keys()].filter(isAddress));
    if (existsSync(this.dir)) for (const name of readdirSync(this.dir)) {
      const m = /^agent-(0x[0-9a-f]{40})\.json$/.exec(name);
      if (m) addresses.add(m[1]!);
    }
    return [...addresses].filter((a) => {
      const f = this.agentFile(a);
      return f.notes.length > 0 || f.turns.length > 0;
    }).sort();
  }

  /** the owner's notes for every agent */
  about(): MemoryNote[] {
    return [...this.aboutFile().notes];
  }

  /** an agent's own notes */
  notes(address: string): MemoryNote[] {
    return isAddress(address) ? [...this.agentFile(address).notes] : [];
  }

  /** Keep a note, or change one: `id` "" is a new note. An agent (by "agent") writes only into its own notes and only so often; the owner
   * (by "owner") writes About you, or into an agent's notes. The words are checked first: what must never be kept is refused, unrepeated */
  keep(scope: Scope, input: { id: string; topic: string; text: string }, by: "agent" | "owner"): MemoryNote | Refusal {
    if (scope !== "about" && !isAddress(scope)) return no("E_ACCOUNT_BAD_ACTION", { message: `notes are kept for "about" (the owner's, for every agent) or for one agent by its address, not for "${String(scope).slice(0, 44)}"` });
    const text = tidy(input.text);
    if (!text) return no("E_ACCOUNT_BAD_ACTION", { message: "a note has words: to take one away, forget it" });
    if (text.length > NOTE_TEXT) return no("E_ACCOUNT_LIMIT", { message: `a note is at most ${NOTE_TEXT} characters; this one is ${text.length}`, detail: { max: NOTE_TEXT, length: text.length } });
    const topic = (input.topic.trim().toLowerCase() || "other") as Topic;
    if (!TOPICS.includes(topic)) return no("E_ACCOUNT_BAD_ACTION", { message: `a note's topic is one of ${TOPICS.join(", ")}`, detail: { topics: [...TOPICS] } });
    const problem = memoryProblem(text);
    if (problem) return no("E_ACCOUNT_MEMORY_SECRET", { message: `not kept: ${problem}. The account keeps no keys, secrets, passwords or IP addresses in memory`, detail: { scope: scope === "about" ? "about" : "agent" } });
    const now = this.nowMs();
    if (by === "agent") {
      const times = (this.writes.get(scope) ?? []).filter((t) => now - t < 3_600_000);
      if (times.length >= MEMORY_WRITES_PER_HOUR) return no("E_ACCOUNT_LIMIT", { message: `at most ${MEMORY_WRITES_PER_HOUR} changes to an agent's notes an hour`, detail: { perHour: MEMORY_WRITES_PER_HOUR } });
      this.writes.set(scope, [...times, now]);
    }
    const file = scope === "about" ? this.aboutFile() : this.agentFile(scope);
    const at = new Date(now).toISOString();
    const id = input.id.trim();
    if (id) {
      const was = file.notes.find((n) => n.id === id);
      if (!was) return no("E_ACCOUNT_MEMORY_UNKNOWN", { message: `there is no note "${id.slice(0, 20)}" ${scope === "about" ? "in About you" : "in this agent's notes"}: a new note has the id ""`, detail: { id: id.slice(0, 20) } });
      const note: MemoryNote = { ...was, topic, text, updatedAt: at, by };
      this.write(scope, { ...file, notes: file.notes.map((n) => (n === was ? note : n)) });
      return note;
    }
    const max = scope === "about" ? MAX_ABOUT : MAX_NOTES;
    if (file.notes.length >= max) return no("E_ACCOUNT_MEMORY_FULL", { message: `${scope === "about" ? "About you" : "this agent's notes"} hold${scope === "about" ? "s" : ""} ${max} notes already: forget one, or change one, first`, detail: { max } });
    const note: MemoryNote = { id: `note-${String(file.seq + 1).padStart(4, "0")}`, topic, text, at, by };
    this.write(scope, { ...file, seq: file.seq + 1, notes: [...file.notes, note] });
    return note;
  }

  /** Forget: one note (`note-0003`), one turn (`turn-000041`, `all-000007`), every note (`notes`), the conversation (`conversation`), or
   * everything kept for the scope (`all`). Gone from the file, not hidden. How many went */
  forget(scope: Scope, what: string): number | Refusal {
    const w = what.trim();
    const unknown = (where: string) => no("E_ACCOUNT_MEMORY_UNKNOWN", { message: `there is no "${w.slice(0, 20)}" ${where}: it was forgotten already, or never kept`, detail: { what: w.slice(0, 20) } });
    if (scope === "about") {
      const file = this.aboutFile();
      const whole = w === "notes" || w === "all";
      if (!whole && !file.notes.some((n) => n.id === w)) return unknown("in About you");
      const left = whole ? [] : file.notes.filter((n) => n.id !== w);
      const gone = file.notes.length - left.length;
      if (gone > 0) this.write("about", { ...file, notes: left });
      return gone;
    }
    if (scope === "everyone") {
      const file = this.everyoneFile();
      const whole = w === "conversation" || w === "all";
      if (!whole && !file.turns.some((t) => t.id === w)) return unknown("in the words to every agent");
      const left = whole ? [] : file.turns.filter((t) => t.id !== w);
      const gone = file.turns.length - left.length;
      if (gone > 0) this.write("everyone", { ...file, turns: left });
      return gone;
    }
    if (!isAddress(scope)) return no("E_ACCOUNT_BAD_ACTION", { message: `memory is forgotten for "about", "everyone" or one agent by its address, not for "${String(scope).slice(0, 44)}"` });
    const file = this.agentFile(scope);
    const allNotes = w === "notes" || w === "all";
    const allTurns = w === "conversation" || w === "all";
    if (!allNotes && !allTurns && !file.notes.some((n) => n.id === w) && !file.turns.some((t) => t.id === w)) return unknown("kept for this agent");
    const notes = allNotes ? [] : file.notes.filter((n) => n.id !== w);
    const turns = allTurns ? [] : file.turns.filter((t) => t.id !== w);
    const gone = file.notes.length - notes.length + (file.turns.length - turns.length);
    if (gone > 0) this.write(scope, { ...file, notes, turns });
    return gone;
  }

  /** a turn of the conversation, as the account saw it: for one agent (its address) or for every agent ("everyone") */
  record(scope: Scope, turn: { who: TurnWho; kind: string; text: string; ref?: string | undefined; code?: string | undefined }): MemoryTurn | undefined {
    if (scope !== "everyone" && !isAddress(scope)) return undefined;
    const text = scrubbed(tidy(turn.text));
    if (!text) return undefined;
    this.lastTurnMs = Math.max(this.nowMs(), this.lastTurnMs + 1);
    const at = new Date(this.lastTurnMs).toISOString();
    if (scope === "everyone") {
      const file = this.everyoneFile();
      const t: MemoryTurn = { id: `all-${String(file.seq + 1).padStart(6, "0")}`, at, who: turn.who, kind: turn.kind, text, ...(turn.ref ? { ref: turn.ref } : {}), ...(turn.code ? { code: turn.code } : {}) };
      const turns = [...file.turns, t];
      const over = Math.max(0, turns.length - MAX_TURNS);
      this.write("everyone", { ...file, seq: file.seq + 1, turns: turns.slice(over), dropped: file.dropped + over });
      return t;
    }
    const file = this.agentFile(scope);
    const t: MemoryTurn = { id: `turn-${String(file.turnSeq + 1).padStart(6, "0")}`, at, who: turn.who, kind: turn.kind, text, ...(turn.ref ? { ref: turn.ref } : {}), ...(turn.code ? { code: turn.code } : {}) };
    const turns = [...file.turns, t];
    const over = Math.max(0, turns.length - MAX_TURNS);
    this.write(scope, { ...file, turnSeq: file.turnSeq + 1, turns: turns.slice(over), dropped: file.dropped + over });
    return t;
  }

  /** the words to every agent, latest last */
  everyone(): { turns: MemoryTurn[]; dropped: number } {
    const f = this.everyoneFile();
    return { turns: [...f.turns], dropped: f.dropped };
  }

  /** One agent's conversation, as the agent reads it: its own turns and, from `sinceMs` (when its key was let in), the words to every agent;
   * latest last, `limit` of them (50 unless said, 200 at most) before the turn `before`, or matching `q` (any case) */
  conversation(address: string, o: { sinceMs?: number | undefined; before?: string | undefined; limit?: number | undefined; q?: string | undefined } = {}): Conversation {
    if (!isAddress(address)) return { turns: [], total: 0, more: false, dropped: 0 };
    const own = this.agentFile(address);
    const all = this.everyoneFile().turns.filter((t) => o.sinceMs === undefined || Date.parse(t.at) >= o.sinceMs);
    let merged = [...own.turns, ...all].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
    const q = (o.q ?? "").trim().toLowerCase();
    if (q) merged = merged.filter((t) => t.text.toLowerCase().includes(q) || t.kind === q || t.ref === q || (t.code ?? "").toLowerCase() === q);
    const total = merged.length;
    const cut = o.before ? merged.findIndex((t) => t.id === o.before) : -1;
    const upto = cut >= 0 ? merged.slice(0, cut) : merged;
    const limit = Math.max(1, Math.min(200, Math.trunc(o.limit ?? 50)));
    const turns = upto.slice(-limit);
    return { turns, total, more: upto.length > turns.length, dropped: own.dropped };
  }

  /** notes that match `q`, any case, by their words or topic */
  static matching(notes: MemoryNote[], q: string | undefined): MemoryNote[] {
    const k = (q ?? "").trim().toLowerCase();
    return k ? notes.filter((n) => n.text.toLowerCase().includes(k) || n.topic === k || n.id === k) : notes;
  }
}
