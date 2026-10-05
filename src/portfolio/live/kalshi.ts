/** A Kalshi account, read through its trade API v2 (docs.kalshi.com, read 2026-10-05).
 *
 *   GET /trade-api/v2/portfolio/balance      balance, in cents
 *   GET /trade-api/v2/portfolio/positions    market_positions[]: ticker, position_fp (contracts; negative = NO), market_exposure_dollars (cost)
 *
 * Each request carries three headers: the key's id, a millisecond timestamp, and a signature over `timestamp + METHOD + path` — the path
 * with its `/trade-api/v2` prefix and without the query string — made with the private key that came with the id: RSA-PSS (SHA-256, MGF1
 * SHA-256, salt as long as the digest) for an RSA key, the string signed directly for an Ed25519 one. The private key is a PEM file the
 * key file points to; it is read in this process and used for nothing but these signatures.
 *
 * Kalshi's API has no call that moves money in or out: this connection could not start a deposit or a withdrawal if it wanted to.
 */
import { constants, createPrivateKey, sign as cryptoSign, type KeyObject } from "node:crypto";
import type { Refusal } from "../../core/errors.ts";
import { no } from "../refuse.ts";
import { readSecretFile, type KeyFile, type KeyShape } from "./credentials.ts";
import { asRefusal, num, unreachable, venueSaidNo, type Http, type LiveBalance, type LiveSource } from "./types.ts";

export const KALSHI_KEY: KeyShape = { required: ["keyId"], optional: ["privateKeyFile", "privateKey", "demo"], example: '{"keyId": "…", "privateKeyFile": "credentials/kalshi/private-key.pem"} (the .pem is the file Kalshi gives you when the key is made)' };

const PROD = "https://external-api.kalshi.com";
const DEMO = "https://external-api.demo.kalshi.co";
const PREFIX = "/trade-api/v2";

/** the signature Kalshi expects for one request, base64 */
export function kalshiSign(key: KeyObject, timestampMs: number, method: string, path: string): string {
  const text = Buffer.from(`${timestampMs}${method.toUpperCase()}${path.split("?")[0]}`);
  return key.asymmetricKeyType === "ed25519" ? cryptoSign(null, text, key).toString("base64") : cryptoSign("sha256", text, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }).toString("base64");
}

export async function kalshiSource(req: { venue: string; label: string; reference: string; key: KeyFile; home: string; http: Http; clock: () => number }): Promise<{ source: LiveSource; first: LiveBalance[] } | Refusal> {
  const demo = req.key.demo === "true";
  const base = demo ? DEMO : PROD;
  const name = `${req.label || "Kalshi"}${demo && !/demo/i.test(req.label) ? " · demo" : ""}`;
  let pem = req.key.privateKey;
  if (!pem) {
    const file = readSecretFile(req.home, req.key.privateKeyFile ?? `credentials/${req.venue}/private-key.pem`, req.venue, "It is the private key Kalshi gives you when the API key is made; chmod 600 on it");
    if ("ok" in file) return file;
    pem = file.text;
  }
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    return no("E_ACCOUNT_CREDENTIAL", { venue: req.venue, message: "Kalshi's private key is not a PEM private key this machine can read" });
  }
  if (key.asymmetricKeyType !== "rsa" && key.asymmetricKeyType !== "ed25519") return no("E_ACCOUNT_CREDENTIAL", { venue: req.venue, message: `Kalshi signs with an RSA or an Ed25519 key; this one is ${key.asymmetricKeyType ?? "something else"}` });
  const secrets = [pem];

  const get = async (path: string): Promise<Record<string, unknown>> => {
    const ts = req.clock();
    let r;
    try {
      r = await req.http(`${base}${PREFIX}${path}`, { headers: { "KALSHI-ACCESS-KEY": req.key.keyId!, "KALSHI-ACCESS-TIMESTAMP": String(ts), "KALSHI-ACCESS-SIGNATURE": kalshiSign(key, ts, "GET", `${PREFIX}${path}`), accept: "application/json" } });
    } catch (err) {
      throw unreachable(req.venue, name, err, secrets);
    }
    if (r.status !== 200 || !r.body || typeof r.body !== "object") throw venueSaidNo(req.venue, name, r.status, r.text, secrets);
    return r.body as Record<string, unknown>;
  };
  const read = async (): Promise<LiveBalance[]> => {
    const balance = await get("/portfolio/balance");
    const out: LiveBalance[] = [{ asset: "USD", amount: num(balance.balance) / 100, usd: num(balance.balance) / 100, where: "cash", class: "cash" }];
    let cursor = "";
    // a page at a time, and not for ever: five pages is a thousand positions
    for (let page = 0; page < 5; page++) {
      const body = await get(`/portfolio/positions?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      for (const p of (Array.isArray(body.market_positions) ? body.market_positions : []) as Array<Record<string, unknown>>) {
        const n = num(p.position_fp);
        // what Kalshi reports per position is what it cost, not what it is worth now: said as that
        if (n !== 0) out.push({ asset: `${String(p.ticker ?? "?")}:${n > 0 ? "YES" : "NO"}`, amount: Math.abs(n), usd: num(p.market_exposure_dollars), where: "at cost", class: "event" });
      }
      cursor = typeof body.cursor === "string" ? body.cursor : "";
      if (!cursor) break;
    }
    return out;
  };
  try {
    const first = await read();
    const source: LiveSource = { name, kind: "prediction", reference: req.reference, via: `Kalshi trade API${demo ? " · demo" : ""}`, probe: { can: [], note: "a Kalshi key carries the scopes it was made with (a `read` key is all this connection uses); positions are shown at what they cost, which is what Kalshi reports", native: { calls: ["GET /trade-api/v2/portfolio/balance", "GET /trade-api/v2/portfolio/positions"], signed: key.asymmetricKeyType === "ed25519" ? "Ed25519" : "RSA-PSS SHA-256", demo } }, read, readOnlyBecause: "Kalshi's API moves no money: deposits and withdrawals are made at Kalshi" };
    return { source, first };
  } catch (err) {
    return asRefusal(req.venue, name, err, secrets);
  }
}
