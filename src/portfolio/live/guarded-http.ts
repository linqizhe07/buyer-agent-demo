/** The account asking a PAYEE: an https request to a URL an agent named, and nothing else.
 *
 * An agent names the URL of what it wants paid for, so the account fetches a URL it did not choose. That request goes out only if:
 *
 *   - it is https, to a plain host (no user:password@), on the default port or another the host serves https on;
 *   - every address the host resolves to is a public one: never this machine (127.0.0.0/8, ::1), the local network (10/8, 172.16/12,
 *     192.168/16, fc00::/7), link-local (169.254/16 — where cloud metadata lives — and fe80::/10), carrier-grade NAT, multicast or
 *     reserved space. The address checked is the address connected to (the check is the socket's own lookup), so a name that answers
 *     public to the check and private to the connection cannot get through;
 *   - it does not follow a redirect (a payment never does: the payee answers where it was asked);
 *   - it is answered within fifteen seconds, in at most two megabytes.
 *
 * What comes back is the status, the headers (lower-cased) and the body, parsed as JSON when it is JSON.
 */
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request } from "node:https";
import { isIP, type LookupFunction } from "node:net";

export interface PayRequest {
  method: "GET" | "POST";
  url: string;
  headers?: Record<string, string> | undefined;
  body?: string | undefined;
}

export interface PayResponse {
  /** 0: the host did not answer, or was refused before it was asked */
  status: number;
  headers: Record<string, string>;
  body: unknown;
  /** why it was not asked, or did not answer */
  error?: string | undefined;
}

export type PayHttp = (req: PayRequest) => Promise<PayResponse>;

const TIMEOUT_MS = 15_000;
const MAX_BYTES = 2_000_000;

/** an IPv4 or IPv6 address that is not on the public internet */
export function privateAddress(address: string): boolean {
  const v = isIP(address);
  if (v === 4) {
    const [a, b] = address.split(".").map(Number) as [number, number, number, number];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (v === 6) {
    const h = hextets(address.toLowerCase().replace(/%.*$/, ""));
    if (!h) return true;
    // Only global unicast (2000::/3) reaches the internet. Everything else is not a public address, whatever its spelling: loopback,
    // unspecified, an IPv4 address written as IPv6 in any form (::ffff:127.0.0.1 and the ::ffff:7f00:1 a URL turns it into), NAT64,
    // unique-local, link-local, multicast. Inside 2000::/3: Teredo, benchmarking, ORCHID and documentation are not either, and 6to4
    // (2002::/16) is judged by the IPv4 address it carries
    if ((h[0]! & 0xe000) !== 0x2000) return true;
    if (h[0] === 0x2001 && (h[1] === 0 || h[1] === 0x0db8 || (h[1] === 0x0002 && h[2] === 0) || (h[1]! & 0xffe0) === 0x0020 || (h[1]! & 0xfff0) === 0x0010)) return true;
    if (h[0] === 0x2002) return privateAddress(`${h[1]! >> 8}.${h[1]! & 255}.${h[2]! >> 8}.${h[2]! & 255}`);
    return false;
  }
  return true;
}

/** an IPv6 address as its eight 16-bit groups ("::" filled in, a dotted IPv4 tail read as two groups), or undefined if it is not one */
function hextets(x: string): number[] | undefined {
  let s = x;
  const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number) as [number, number, number, number];
    s = `${s.slice(0, -tail[0].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const parts = s.split("::");
  if (parts.length > 2) return undefined;
  const head = parts[0] ? parts[0].split(":") : [];
  const rest = parts.length === 2 ? (parts[1] ? parts[1].split(":") : []) : undefined;
  const all = rest === undefined ? head : [...head, ...Array<string>(8 - head.length - rest.length).fill("0"), ...rest];
  if (all.length !== 8 || !all.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return undefined;
  return all.map((g) => parseInt(g, 16));
}

/** the socket's own lookup, refusing any private address: what is checked is what is connected to */
const publicOnly: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "", 4);
    const list = (Array.isArray(addresses) ? addresses : [addresses]) as LookupAddress[];
    const bad = list.find((a) => privateAddress(a.address));
    if (!list.length || bad) return callback(Object.assign(new Error(`${hostname} resolves to ${bad?.address ?? "nothing"}, which is not a public address`), { code: "E_PRIVATE_ADDRESS" }), "", 4);
    if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
    callback(null, list[0]!.address, list[0]!.family);
  });
};

/** the real network, guarded as above */
export const guardedHttp: PayHttp = (req) =>
  new Promise((resolve) => {
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      return resolve({ status: 0, headers: {}, body: undefined, error: "not a URL" });
    }
    if (url.protocol !== "https:" || url.username || url.password) return resolve({ status: 0, headers: {}, body: undefined, error: "a payee is asked over https, at a plain host" });
    // a host written as an address is judged as that address
    const literal = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(literal) && privateAddress(literal)) return resolve({ status: 0, headers: {}, body: undefined, error: `${literal} is not a public address` });
    const body = req.body !== undefined ? Buffer.from(req.body) : undefined;
    const r = request(url, { method: req.method, headers: { accept: "application/json, */*", "user-agent": "agent-account/1", ...(req.headers ?? {}), ...(body ? { "content-length": String(body.length) } : {}) }, lookup: publicOnly, timeout: TIMEOUT_MS }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BYTES) {
          res.destroy();
          resolve({ status: 0, headers: {}, body: undefined, error: "the answer was larger than two megabytes" });
        } else chunks.push(c);
      });
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
        let parsed: unknown = text;
        if ((headers["content-type"] ?? "").includes("json") || /^\s*[[{]/.test(text)) {
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = text;
          }
        }
        resolve({ status: res.statusCode ?? 0, headers, body: parsed });
      });
      res.on("error", (e) => resolve({ status: 0, headers: {}, body: undefined, error: e.message }));
    });
    r.on("timeout", () => r.destroy(new Error("no answer in fifteen seconds")));
    r.on("error", (e) => resolve({ status: 0, headers: {}, body: undefined, error: e.message }));
    if (body) r.write(body);
    r.end();
  });
