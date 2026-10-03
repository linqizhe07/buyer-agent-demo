/** The plugin contract: one manifest per venue row.
 *
 * A manifest is the OPERATOR's word about a market plugin: which process is the
 * seat, which credential reference is the identity, where signing happens, and
 * — the part that makes the approval gate honest — which tools read and which
 * write. A tool the manifest does not classify never mounts (D4).
 */
import { readFileSync } from "node:fs";
import { z } from "zod";

export const ConstraintSchema = z.object({
  id: z.string(),
  tool: z.string(),
  /** applies when `args[when.arg]` matches this regex */
  when: z.object({ arg: z.string(), matches: z.string() }),
  /** then `args[require.arg]` must be one of `oneOf`; absent or wrong → `default` */
  require: z.object({ arg: z.string(), oneOf: z.array(z.string()).min(1), default: z.string() }),
  /** what the venue answers when the constraint is NOT absorbed, and which
   * refusal code the host gives that answer */
  venueError: z
    .object({
      status: z.number().optional(),
      code: z.union([z.number(), z.string()]).optional(),
      message: z.string().optional(),
      refusal: z.string().optional(),
    })
    .optional(),
});
export type Constraint = z.infer<typeof ConstraintSchema>;

/** How the host sizes a write intent in USD before the mandate check, from
 * argument NAMES (never values): the manifest says which arg is the symbol,
 * which is the quantity, and which read tool quotes the price. */
export const SizingSchema = z.object({
  kind: z.enum(["order", "transfer", "cancel", "other"]),
  symbol: z.string().optional(),
  qty: z.string().optional(),
  limitPrice: z.string().optional(),
  recipient: z.string().optional(),
  amount: z.string().optional(),
  /** constant USD per unit of `amount`, for venues without a quote tool in the demo */
  unitUsd: z.number().optional(),
  /** quote through one of the plugin's own read tools: `args` maps the quote tool's
   * argument name → the intent's argument name; `price` is a dotted path in the result */
  quote: z.object({ tool: z.string(), args: z.record(z.string(), z.string()), price: z.string() }).optional(),
});
export type Sizing = z.infer<typeof SizingSchema>;

export const IdentitySchema = z.object({
  /** `<venue>/<name>` → `$BUYER_HOME/credentials/<venue>/<name>.json`; the value never leaves the plugin child */
  ref: z.string().regex(/^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/),
  kind: z.enum(["broker-api-key", "hmac-api-key", "agent-wallet"]),
});

export const SignerSchema = z.discriminatedUnion("kind", [
  /** the plugin signs with the identity it holds (Alpaca, Binance, Hyperliquid agent key) */
  z.object({ kind: z.literal("in-plugin") }),
  /** a separate process holds the key and enforces a policy (Solana) */
  z.object({ kind: z.literal("external-policy-signer"), url: z.string() }),
  /** nothing to sign (read-only plugins) */
  z.object({ kind: z.literal("none") }),
]);

export const ManifestSchema = z.object({
  manifestVersion: z.literal(1),
  /** short id, also the credentials sub-directory */
  venue: z.string().regex(/^[a-z][a-z0-9-]*$/),
  /** the MCP server name; public tool names are `mcp__<serverName>__<raw>` */
  serverName: z.string().regex(/^[A-Za-z0-9_-]+$/),
  /** display name for the board */
  title: z.string(),
  /** the seat: how to spawn the stdio MCP server, relative to the repo root */
  command: z.array(z.string()).min(1),
  /** one line: what the venue natively gives an agent */
  native: z.string(),
  /** one line for the board: where the key lives */
  keyLives: z.string(),
  /** one line for the board: the venue-side limits this seat runs under */
  limits: z.string().optional(),
  identity: IdentitySchema.nullable(),
  signer: SignerSchema,
  tools: z.object({
    read: z.array(z.string()),
    write: z.array(z.string()),
    /** exists on the server, never mounted */
    deny: z.array(z.string()).default([]),
  }),
  /** which argument names the approval card shows for each write tool */
  card: z.record(z.string(), z.array(z.string())).default({}),
  /** how each write tool is sized for the mandate check */
  sizing: z.record(z.string(), SizingSchema).default({}),
  constraints: z.array(ConstraintSchema).default([]),
  /** the venue's own refusals the host should name: a regex over the venue's
   * message, and the `E_VENUE_*` code it becomes (the message still travels verbatim) */
  venueErrors: z.array(z.object({ match: z.string(), refusal: z.string() })).default([]),
});
export type Manifest = z.infer<typeof ManifestSchema>;

export function parseManifest(json: unknown, source = "manifest"): Manifest {
  const result = ManifestSchema.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`invalid ${source}: ${issues}`);
  }
  const m = result.data;
  const overlap = m.tools.read.filter((t) => m.tools.write.includes(t) || m.tools.deny.includes(t));
  const overlap2 = m.tools.write.filter((t) => m.tools.deny.includes(t));
  if (overlap.length || overlap2.length) {
    throw new Error(`invalid ${source}: a tool is in two classes: ${[...overlap, ...overlap2].join(", ")}`);
  }
  return m;
}

export function loadManifest(file: string): Manifest {
  return parseManifest(JSON.parse(readFileSync(file, "utf8")), file);
}

/** dsh mints `mcp__<serverName>__<rawName>`; so do we, so the names port back. */
export function toolFullName(serverName: string, raw: string): string {
  return `mcp__${serverName}__${raw}`;
}

/** `mcp__alpaca__place_order` → `{ serverName: "alpaca", raw: "place_order" }` */
export function splitFullName(name: string): { serverName: string; raw: string } | null {
  const m = /^mcp__([A-Za-z0-9_-]+?)__(.+)$/.exec(name);
  return m ? { serverName: m[1]!, raw: m[2]! } : null;
}
