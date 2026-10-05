/** A brokerage account at Alpaca, read through its Trading API (docs.alpaca.markets, read 2026-10-05).
 *
 *   GET /v2/account     cash, equity, buying_power                    (numbers arrive as strings)
 *   GET /v2/positions   symbol, qty, market_value, asset_class        (a bare array)
 *
 * Two headers carry the key (APCA-API-KEY-ID, APCA-API-SECRET-KEY); nothing is signed. An individual key has no scopes: any key can place
 * orders, and none can move cash — deposits and withdrawals are not in this API at all, which is why the account's door for this venue says
 * "at the venue". This file only ever sends the two GETs above.
 */
import type { Refusal } from "../../core/errors.ts";
import type { KeyFile, KeyShape } from "./credentials.ts";
import { asRefusal, num, unreachable, venueSaidNo, type Http, type LiveBalance, type LiveSource } from "./types.ts";

export const ALPACA_KEY: KeyShape = { required: ["keyId", "secret"], optional: ["paper"], example: '{"keyId": "…", "secret": "…"} (add "paper": "true" for a paper-trading account)' };

const LIVE = "https://api.alpaca.markets";
const PAPER = "https://paper-api.alpaca.markets";

export async function alpacaSource(req: { venue: string; label: string; reference: string; key: KeyFile; http: Http }): Promise<{ source: LiveSource; first: LiveBalance[] } | Refusal> {
  const paper = req.key.paper === "true";
  const base = paper ? PAPER : LIVE;
  // a paper account says so in its name, whatever the owner called it
  const name = `${req.label || "Alpaca"}${paper && !/paper/i.test(req.label) ? " · paper" : ""}`;
  const secrets = [req.key.keyId, req.key.secret];
  const get = async (path: string): Promise<unknown> => {
    let r;
    try {
      r = await req.http(`${base}${path}`, { headers: { "APCA-API-KEY-ID": req.key.keyId!, "APCA-API-SECRET-KEY": req.key.secret!, accept: "application/json" } });
    } catch (err) {
      throw unreachable(req.venue, name, err, secrets);
    }
    if (r.status !== 200 || r.body === undefined) throw venueSaidNo(req.venue, name, r.status, r.text, secrets);
    return r.body;
  };
  const read = async (): Promise<LiveBalance[]> => {
    const account = (await get("/v2/account")) as Record<string, unknown>;
    const positions = (await get("/v2/positions")) as Array<Record<string, unknown>>;
    if (!account || typeof account !== "object") throw venueSaidNo(req.venue, name, 200, "the account came back empty", secrets);
    return [
      { asset: "USD", amount: num(account.cash), usd: num(account.cash), where: "cash", class: "cash" },
      ...(Array.isArray(positions) ? positions : []).map((p): LiveBalance => ({ asset: String(p.symbol ?? "?"), amount: Math.abs(num(p.qty)), usd: num(p.market_value), where: String(p.asset_class ?? "") === "crypto" ? "crypto" : "stocks", class: String(p.asset_class ?? "") === "crypto" ? "crypto" : "equity" })),
    ];
  };
  try {
    const first = await read();
    const source: LiveSource = { name, kind: "broker", reference: req.reference, via: `Alpaca Trading API${paper ? " · paper" : ""}`, probe: { can: ["read", "trade"], note: "an Alpaca key has no scopes: any key can place orders, and no key can move cash", native: { calls: ["GET /v2/account", "GET /v2/positions"], paper } }, read, readOnlyBecause: "Alpaca's API moves no cash: deposits and withdrawals are made at Alpaca" };
    return { source, first };
  } catch (err) {
    return asRefusal(req.venue, name, err, secrets);
  }
}
