/** The account asking a PAYEE: an https request to a URL an agent named, and nothing else.
 *
 * An agent names the URL of what it wants paid for, so the account fetches a URL it did not choose. That request goes out only if:
 *
 *   - it is https, to a plain host (no user:password@), on the default port or another the host serves https on;
 *   - every address the host resolves to is a public one: never this machine (127.0.0.0/8, ::1), the local network (10/8, 172.16/12,
 *     192.168/16, fc00::/7), link-local (169.254/16 — where cloud metadata lives — and fe80::/10), carrier-grade NAT, multicast or
 *     reserved space (a NAT64 address is judged by the IPv4 address it carries). The address checked is the address connected to (the
 *     check is the socket's own lookup), so a name that answers public to the check and private to the connection cannot get through;
 *   - it does not follow a redirect (a payment never does: the payee answers where it was asked);
 *   - it is answered within fifteen seconds, in at most two megabytes.
 *
 * What comes back is the status, the headers (lower-cased) and the body, parsed as JSON when it is JSON. A request that went nowhere says
 * why in a fixed sentence of its kind, never in the network's own words: a filter's sinkhole address, or the names on a certificate that an
 * interceptor answered with, would tell an agent — and the ledger — where the user is.
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

/** why a request went nowhere: the name resolved to a local or reserved address on this network (a filter's sinkhole answers that way), the
 * certificate that answered is not the host's, no answer in time, the connection refused or cut, the name not found, too large, not a URL
 * a payee is asked at (https, a plain host, not a private address written as one), or another failure of the connection */
export type PayFailure = "filtered-address" | "certificate" | "timeout" | "refused" | "unresolved" | "too-large" | "not-https" | "failed";

export interface PayResponse {
  /** 0: the host did not answer, or was refused before it was asked */
  status: number;
  headers: Record<string, string>;
  body: unknown;
  /** why it was not asked, or did not answer: a fixed sentence of its kind, with no address or certificate name in it */
  error?: string | undefined;
  kind?: PayFailure | undefined;
}

export type PayHttp = (req: PayRequest) => Promise<PayResponse>;

const TIMEOUT_MS = 15_000;
const MAX_BYTES = 2_000_000;

/** the sentence for each kind of failure */
const FAILED: Record<PayFailure, string> = {
  "filtered-address": "on this network the name resolves to a local or reserved address, so the payee was not asked",
  certificate: "the certificate that answered is not the payee's: something on this network may be answering in its place",
  timeout: "no answer in fifteen seconds",
  refused: "the connection was refused or cut",
  unresolved: "the name does not resolve from this network",
  "too-large": "the answer was larger than two megabytes",
  "not-https": "a payee is asked over https, at a plain host",
  failed: "the connection failed",
};
const failed = (kind: PayFailure, code?: string): PayResponse => ({ status: 0, headers: {}, body: undefined, error: kind === "failed" && code ? `${FAILED.failed} (${code})` : FAILED[kind], kind });

/** a socket's failure as its kind, by its code — never by its message, which names the address connected to, or a certificate's hosts */
function kindOf(err: unknown): { kind: PayFailure; code?: string | undefined } {
  const code = String((err as { code?: unknown } | undefined)?.code ?? "");
  if (code === "E_PRIVATE_ADDRESS") return { kind: "filtered-address" };
  if (code === "E_TIMEOUT") return { kind: "timeout" };
  if (/^(?:ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|SELF_SIGNED_|DEPTH_ZERO_|EPROTO$|HOSTNAME_MISMATCH$)/.test(code)) return { kind: "certificate" };
  if (/^(?:ECONNREFUSED|ECONNRESET|EPIPE|ECONNABORTED|EHOSTUNREACH|ENETUNREACH)$/.test(code)) return { kind: "refused" };
  if (/^(?:ENOTFOUND|EAI_AGAIN|ENODATA)$/.test(code)) return { kind: "unresolved" };
  return { kind: "failed", ...(/^[A-Z][A-Z0-9_]{1,40}$/.test(code) ? { code } : {}) };
}

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
    // NAT64 (64:ff9b::/96, RFC 6052, and the local-use 64:ff9b:1::/48 of RFC 8215 written the same way): what an IPv6-only network's
    // DNS64 answers for a host that has only an IPv4 address. It is judged by the IPv4 address it carries — 64:ff9b::7f00:1 is still this
    // machine — so a payee that is IPv4-only is not refused on such a network. Any other form of the local-use prefix is not public
    if (h[0] === 0x0064 && h[1] === 0xff9b && (h[2] === 0 || h[2] === 1)) {
      return h[3] === 0 && h[4] === 0 && h[5] === 0 ? privateAddress(`${h[6]! >> 8}.${h[6]! & 255}.${h[7]! >> 8}.${h[7]! & 255}`) : true;
    }
    // Only global unicast (2000::/3) reaches the internet. Everything else is not a public address, whatever its spelling: loopback,
    // unspecified, an IPv4 address written as IPv6 in any form (::ffff:127.0.0.1 and the ::ffff:7f00:1 a URL turns it into), unique-local,
    // link-local, multicast. Inside 2000::/3: Teredo, benchmarking, ORCHID and documentation are not either, and 6to4 (2002::/16) is judged
    // by the IPv4 address it carries
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
    // the address itself is not said: on a filtering network it is the filter's sinkhole, and a well-known one names the country
    if (!list.length || bad) return callback(Object.assign(new Error(FAILED["filtered-address"]), { code: "E_PRIVATE_ADDRESS" }), "", 4);
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
      return resolve({ status: 0, headers: {}, body: undefined, error: "not a URL", kind: "not-https" });
    }
    if (url.protocol !== "https:" || url.username || url.password) return resolve(failed("not-https"));
    // a host written as an address is judged as that address
    const literal = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(literal) && privateAddress(literal)) return resolve({ status: 0, headers: {}, body: undefined, error: `${literal} is not a public address`, kind: "not-https" });
    const body = req.body !== undefined ? Buffer.from(req.body) : undefined;
    const r = request(url, { method: req.method, headers: { accept: "application/json, */*", "user-agent": "agent-account/1", ...(req.headers ?? {}), ...(body ? { "content-length": String(body.length) } : {}) }, lookup: publicOnly, timeout: TIMEOUT_MS }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BYTES) {
          res.destroy();
          resolve(failed("too-large"));
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
      res.on("error", (e) => {
        const k = kindOf(e);
        resolve(failed(k.kind, k.code));
      });
    });
    r.on("timeout", () => r.destroy(Object.assign(new Error(FAILED.timeout), { code: "E_TIMEOUT" })));
    r.on("error", (e) => {
      const k = kindOf(e);
      resolve(failed(k.kind, k.code));
    });
    if (body) r.write(body);
    r.end();
  });
