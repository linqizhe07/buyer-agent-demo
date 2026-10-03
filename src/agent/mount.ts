/** Mounting a plugin: spawn the seat as a real stdio MCP server, list its
 * tools, audit them against the manifest, and only then register anything.
 *
 * The child's environment is built by `childEnvFor`: the SDK's default base
 * (HOME, PATH, ...) scrubbed of every KEY/SECRET/TOKEN/PASSWORD name, plus the
 * home path, the venue, the venue URL and ONE credential reference. A
 * refused mount closes the transport, which kills the child.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "node:path";
import { auditManifest, type AuditResult } from "../contract/audit.ts";
import { childEnvFor } from "../contract/env-scrub.ts";
import { toolFullName, type Manifest } from "../contract/manifest.ts";
import type { Bus } from "../core/bus.ts";
import { refuse } from "../core/errors.ts";
import type { RegisteredTool, ToolCallOutcome, ToolRegistry } from "./registry.ts";

export interface PluginHandle {
  manifest: Manifest;
  audit: AuditResult;
  pid: number | null;
  alive(): boolean;
  close(): Promise<void>;
}

export interface MountDeps {
  home: string;
  repoRoot: string;
  venueUrl: string;
  signerUrl?: string | undefined;
  bus: Bus;
  registry: ToolRegistry;
  /** called for every write tool that mounts: the gate's allow-list grows here */
  onWriteTool?: (fullName: string, manifest: Manifest) => void;
  timeoutMs?: number;
}

/** `["tsx", "src/x.ts"]` → `node --import tsx src/x.ts`, so a seat starts
 * from the same Node the host runs, with no PATH lookup. */
export function resolveCommand(command: string[], repoRoot: string): { command: string; args: string[] } {
  const [head, ...rest] = command;
  if (head === "tsx") return { command: process.execPath, args: ["--import", "tsx", ...rest] };
  if (head === "node") return { command: process.execPath, args: rest };
  return { command: head!.startsWith(".") ? join(repoRoot, head!) : head!, args: rest };
}

export async function mountPlugin(manifest: Manifest, deps: MountDeps): Promise<PluginHandle> {
  const timeoutMs = deps.timeoutMs ?? 20_000;
  const { command, args } = resolveCommand(manifest.command, deps.repoRoot);
  const env = childEnvFor(manifest, {
    base: getDefaultEnvironment(),
    home: deps.home,
    venueUrl: deps.venueUrl,
    signerUrl: deps.signerUrl,
  });
  deps.bus.emit("plugin/spawn", {
    venue: manifest.venue,
    serverName: manifest.serverName,
    command: [command, ...args],
    envNames: Object.keys(env).sort(),
    credentialRef: manifest.identity?.ref ?? null,
  });

  const transport = new StdioClientTransport({ command, args, cwd: deps.repoRoot, env, stderr: "pipe" });
  transport.stderr?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (line.trim()) deps.bus.emit("plugin/stderr", { venue: manifest.venue, line });
    }
  });
  const client = new Client({ name: "buyer-agent", version: "0.1.0" });
  // the transport forgets its process on close, so the pid is captured once it exists
  let seenPid: number | null = null;
  const pidOf = (): number | null => {
    const live = (transport as { pid?: number | null }).pid ?? null;
    if (live !== null) seenPid = live;
    return seenPid;
  };
  const alive = (): boolean => {
    const pid = pidOf();
    if (pid === null) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const close = async (): Promise<void> => {
    try {
      await client.close();
    } catch {
      /* already gone */
    }
  };

  let listed;
  try {
    await withTimeout(client.connect(transport), timeoutMs, `${manifest.venue}: connect`);
    pidOf(); // remember the child's pid while the transport still has it
    listed = (await withTimeout(client.listTools(), timeoutMs, `${manifest.venue}: listTools`)).tools;
  } catch (err) {
    await close();
    const refusal = refuse("E_MOUNT_SPAWN_FAILED", {
      venue: manifest.venue,
      detail: { error: err instanceof Error ? err.message : String(err) },
    });
    deps.bus.emit("plugin/refused", { venue: manifest.venue, refusal });
    return {
      manifest,
      audit: { ok: false, venue: manifest.venue, mounted: { read: [], write: [] }, denied: [], refusal },
      pid: pidOf(),
      alive,
      close,
    };
  }

  const audit = auditManifest(
    manifest,
    listed.map((t) => ({ name: t.name, description: t.description, annotations: t.annotations })),
  );
  if (!audit.ok) {
    deps.bus.emit("plugin/refused", {
      venue: manifest.venue,
      serverName: manifest.serverName,
      listed: listed.map((t) => t.name),
      refusal: audit.refusal,
    });
    await close();
    return { manifest, audit, pid: pidOf(), alive, close };
  }

  for (const t of listed) {
    const cls = manifest.tools.write.includes(t.name) ? "write" : manifest.tools.read.includes(t.name) ? "read" : null;
    if (cls === null) continue; // deny: exists on the server, never mounted
    const name = toolFullName(manifest.serverName, t.name);
    const tool: RegisteredTool = {
      name,
      venue: manifest.venue,
      serverName: manifest.serverName,
      raw: t.name,
      cls,
      description: t.description ?? "",
      inputSchema: t.inputSchema,
      call: async (callArgs) => parseResult(await client.callTool({ name: t.name, arguments: callArgs })),
    };
    deps.registry.register(tool);
    if (cls === "write") deps.onWriteTool?.(name, manifest);
  }
  deps.bus.emit("plugin/mounted", {
    venue: manifest.venue,
    serverName: manifest.serverName,
    title: manifest.title,
    pid: pidOf(),
    read: audit.mounted.read,
    write: audit.mounted.write,
    denied: audit.denied,
    keyLives: manifest.keyLives,
    native: manifest.native,
    limits: manifest.limits ?? null,
    credentialRef: manifest.identity?.ref ?? null,
    signer: manifest.signer.kind,
  });
  return { manifest, audit, pid: pidOf(), alive, close };
}

function parseResult(result: unknown): ToolCallOutcome {
  const r = result as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  const text = r.content?.find((c) => c.type === "text")?.text ?? "";
  let payload: unknown = text;
  try {
    payload = text.length ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  return { isError: r.isError === true, payload };
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
