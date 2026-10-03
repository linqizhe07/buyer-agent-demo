/** The tool registry the agent (and an LLM driver) sees: every mounted tool
 * under its public name `mcp__<serverName>__<raw>`, with its class. */
export type ToolClass = "read" | "write";

export interface ToolCallOutcome {
  isError: boolean;
  /** parsed JSON from the first text block, or the raw text */
  payload: unknown;
}

export interface RegisteredTool {
  name: string;
  venue: string;
  serverName: string;
  raw: string;
  cls: ToolClass;
  description: string;
  /** the server's JSON schema for the LLM driver */
  inputSchema: unknown;
  call(args: Record<string, unknown>): Promise<ToolCallOutcome>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): void {
    if (this.tools.has(tool.name)) throw new Error(`tool ${tool.name} is already registered`);
    this.tools.set(tool.name, tool);
  }

  unregisterVenue(venue: string): void {
    for (const [name, t] of this.tools) if (t.venue === venue) this.tools.delete(name);
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  require(name: string): RegisteredTool {
    const t = this.tools.get(name);
    if (!t) throw new Error(`tool ${name} is not mounted`);
    return t;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): RegisteredTool[] {
    return [...this.tools.values()];
  }

  byVenue(venue: string): RegisteredTool[] {
    return this.list().filter((t) => t.venue === venue);
  }

  writeNames(): string[] {
    return this.list()
      .filter((t) => t.cls === "write")
      .map((t) => t.name);
  }
}
