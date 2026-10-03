/** Size a write intent in USD from the manifest's sizing rule and, when the
 * rule says so, a price read through the plugin's OWN quote tool. The host
 * learns the price the same way the agent would — through the seat. */
import type { Manifest } from "../contract/manifest.ts";
import { toolFullName } from "../contract/manifest.ts";
import type { IntentSize } from "./mandates.ts";
import type { ToolRegistry } from "./registry.ts";

function pick(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined), obj);
}

export async function sizeIntent(
  manifest: Manifest,
  raw: string,
  args: Record<string, unknown>,
  registry: ToolRegistry,
): Promise<IntentSize & { priceUsd?: number }> {
  const rule = manifest.sizing[raw];
  const venue = manifest.venue;
  if (!rule) return { kind: "other", venue, notionalUsd: 0 };
  if (rule.kind === "cancel" || rule.kind === "other") return { kind: rule.kind, venue, notionalUsd: 0 };

  const priceFrom = async (): Promise<number> => {
    if (rule.limitPrice && args[rule.limitPrice] !== undefined) return Number(args[rule.limitPrice]);
    if (rule.unitUsd !== undefined) return rule.unitUsd;
    if (rule.quote) {
      const quoteArgs: Record<string, unknown> = {};
      for (const [quoteArg, intentArg] of Object.entries(rule.quote.args)) quoteArgs[quoteArg] = args[intentArg];
      const tool = registry.require(toolFullName(manifest.serverName, rule.quote.tool));
      const r = await tool.call(quoteArgs);
      if (r.isError) throw new Error(`sizing: quote failed for ${venue}/${raw}`);
      const px = Number(pick(r.payload, rule.quote.price));
      if (!Number.isFinite(px)) throw new Error(`sizing: no price at ${rule.quote.price}`);
      return px;
    }
    throw new Error(`sizing rule for ${venue}/${raw} has no price source`);
  };

  if (rule.kind === "order") {
    const symbol = rule.symbol ? String(args[rule.symbol]) : undefined;
    const qty = rule.qty ? Number(args[rule.qty]) : 0;
    const price = await priceFrom();
    return { kind: "order", venue, symbol, notionalUsd: Number((qty * price).toFixed(2)), priceUsd: price };
  }
  // transfer
  const recipient = rule.recipient ? String(args[rule.recipient]) : undefined;
  const amount = rule.amount ? Number(args[rule.amount]) : 0;
  const price = await priceFrom();
  return { kind: "transfer", venue, recipient, notionalUsd: Number((amount * price).toFixed(2)), priceUsd: price };
}
