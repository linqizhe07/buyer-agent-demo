/** Boilerplate shared by every seat process: the environment contract with the
 * host, the stdio MCP server, and the two result shapes a tool returns. */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export interface PluginEnv {
  home: string;
  venue: string;
  venueUrl: string;
  credRef: string | null;
  signerUrl: string | null;
}

/** What the host put into this child's environment — nothing else is read. */
export function pluginEnv(): PluginEnv {
  const need = (name: string): string => {
    const v = process.env[name];
    if (!v) throw new Error(`${name} missing: a seat only starts under the host, with its manifest`);
    return v;
  };
  return {
    home: need("BUYER_HOME"),
    venue: need("BUYER_VENUE"),
    venueUrl: need("BUYER_VENUE_URL"),
    credRef: process.env.BUYER_CRED_REF ?? null,
    signerUrl: process.env.BUYER_SIGNER_URL ?? null,
  };
}

let pluginName = "seat";

export function log(line: string): void {
  process.stderr.write(`[${pluginName}] ${line}\n`);
}

/** A successful tool result: the payload as JSON text. */
export function ok(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

/** A failed tool result. The venue's own error travels verbatim under
 * `venueError`; the host classifies it into an `E_VENUE_*` code. */
export function fail(payload: { venueError?: unknown; error?: string; [k: string]: unknown }): CallToolResult {
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, ...payload }) }] };
}

export async function serve(
  info: { name: string; version: string },
  register: (server: McpServer) => void | Promise<void>,
): Promise<void> {
  pluginName = info.name;
  const server = new McpServer(info);
  await register(server);
  await server.connect(new StdioServerTransport());
  log("up (stdio)");
}

/** The venue answered with a non-2xx: wrap it for the host. */
export function venueFailure(status: number, body: unknown): CallToolResult {
  const b = (body && typeof body === "object" ? body : { message: String(body) }) as Record<string, unknown>;
  return fail({ venueError: { status, ...b } });
}
