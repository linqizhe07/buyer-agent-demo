/** Signing in at a venue that speaks OAuth 2.1 to MCP clients — Robinhood's Trading MCP server, read 2026-10-05. The account is the client;
 * the user signs in on the venue's own page; what comes back is a bearer token that never leaves this process.
 *
 *   discovery     GET <server origin>/.well-known/oauth-protected-resource<server path>        → its authorization server
 *                 GET <issuer origin>/.well-known/oauth-authorization-server<issuer path>       → the endpoints (RFC 8414)
 *   registration  POST registration_endpoint (RFC 7591): a public client, no secret, this server's own loopback callback
 *   sign-in       the venue's authorization page, with PKCE (S256), a state, and the server's URL as `resource` (RFC 8707)
 *   callback      the state must be one this process made; the `iss` the venue adds must be its issuer (RFC 9207)
 *   token         POST token_endpoint with the code and the verifier; later, the refresh token
 *
 * The password, the second factor and the approval all happen on the venue's page. This process sees a code once and a token after it,
 * keeps the token in memory only, and forgets it when the server stops.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Refusal } from "../../core/errors.ts";
import { no } from "../refuse.ts";
import { redact, type Http, type HttpReply } from "./types.ts";

interface Endpoints {
  issuer: string;
  authorization: string;
  token: string;
  registration?: string | undefined;
  scope?: string | undefined;
  /** the venue adds `iss` to its answer, so an answer without it is not the venue's (RFC 9207) */
  issOnReturn: boolean;
}

interface Session {
  state: string;
  verifier: string;
  redirectUri: string;
  clientId: string;
  createdAt: number;
  status: "waiting" | "ready" | "failed";
  error?: string | undefined;
  access?: string | undefined;
  refresh?: string | undefined;
  expiresAt?: number | undefined;
}

export type SignInStatus = Session["status"] | "unknown";

/** a sign-in nobody finished is dropped after a quarter of an hour */
const UNFINISHED_MS = 15 * 60_000;

const https = (v: unknown): string | undefined => (typeof v === "string" && /^https:\/\/[^\s]+$/.test(v) ? v : undefined);

/** RFC 8414 / 9728: the well-known name goes between the origin and the path */
const wellKnown = (url: string, name: string): string => {
  const u = new URL(url);
  const path = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
  return `${u.origin}/.well-known/${name}${path}`;
};

export class OAuthSignIn {
  private endpoints: Endpoints | undefined;
  /** one registration per callback address: the page may be open as 127.0.0.1 or as localhost */
  private readonly clients = new Map<string, string>();
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly o: { resource: string; name: string; venue: string; http: Http; clock: () => number; clientName?: string }) {}

  /** where the owner's browser goes to sign in, and the state that names this sign-in until it is connected */
  async start(redirectUri: string): Promise<{ url: string; state: string } | Refusal> {
    const now = this.o.clock();
    for (const [k, s] of this.sessions) if (s.status !== "ready" && now - s.createdAt > UNFINISHED_MS) this.sessions.delete(k);
    const e = await this.discover();
    if ("ok" in e) return e;
    let clientId = this.clients.get(redirectUri);
    if (!clientId) {
      if (!e.registration) return no("E_VENUE_REJECTED", { venue: this.o.venue, message: `${this.o.name} does not let a new client register itself, so this account cannot sign in there` });
      const body = { client_name: this.o.clientName ?? "Agent account on this machine", redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", ...(e.scope ? { scope: e.scope } : {}) };
      const r = await this.post(e.registration, JSON.stringify(body), "application/json");
      if ("ok" in r) return r;
      const id = (r.body as { client_id?: unknown } | undefined)?.client_id;
      if (r.status < 200 || r.status >= 300 || typeof id !== "string" || !id) return this.said("registering this account as a client", r);
      clientId = id;
      this.clients.set(redirectUri, clientId);
    }
    const verifier = randomBytes(32).toString("base64url");
    const state = randomBytes(24).toString("base64url");
    const url = new URL(e.authorization);
    const q: Record<string, string> = { response_type: "code", client_id: clientId, redirect_uri: redirectUri, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", state, resource: this.o.resource, ...(e.scope ? { scope: e.scope } : {}) };
    for (const [k, v] of Object.entries(q)) url.searchParams.set(k, v);
    this.sessions.set(state, { state, verifier, redirectUri, clientId, createdAt: now, status: "waiting" });
    return { url: url.toString(), state };
  }

  has(state: string): boolean {
    return this.sessions.has(state);
  }

  status(state: string): { status: SignInStatus; error?: string } {
    const s = this.sessions.get(state);
    return s ? { status: s.status, ...(s.error ? { error: s.error } : {}) } : { status: "unknown" };
  }

  /** the venue sent the browser back: the code is traded for a token, once */
  async finish(q: { state?: string | undefined; code?: string | undefined; error?: string | undefined; error_description?: string | undefined; iss?: string | undefined }): Promise<{ ok: true } | Refusal> {
    const s = q.state ? this.sessions.get(q.state) : undefined;
    if (!s) return no("E_ACCOUNT_BAD_ACTION", { venue: this.o.venue, message: "this sign-in is not one this server started, or it ran out: start it again from the account page" });
    if (s.status !== "waiting") return no("E_ACCOUNT_BAD_ACTION", { venue: this.o.venue, message: "this sign-in has already come back" });
    const fail = (message: string): Refusal => {
      s.status = "failed";
      s.error = message;
      return no("E_VENUE_REJECTED", { venue: this.o.venue, message });
    };
    if (q.error) return fail(`${this.o.name} said no: ${redact(`${q.error}${q.error_description ? ` (${q.error_description})` : ""}`, [q.code]).slice(0, 200)}`);
    const e = this.endpoints!;
    if (q.iss !== undefined ? q.iss !== e.issuer : e.issOnReturn) return fail(`the answer did not come from ${this.o.name}'s own sign-in (its issuer is ${e.issuer})`);
    if (!q.code) return fail(`${this.o.name} came back without a code`);
    const r = await this.post(e.token, new URLSearchParams({ grant_type: "authorization_code", code: q.code, redirect_uri: s.redirectUri, client_id: s.clientId, code_verifier: s.verifier, resource: this.o.resource }).toString(), "application/x-www-form-urlencoded", [q.code, s.verifier]);
    if ("ok" in r) return fail(r.message);
    const took = this.took(s, r);
    return took === true ? { ok: true } : fail(took);
  }

  /** a token for a finished sign-in, refreshed when it has run out */
  async token(state: string): Promise<string | Refusal> {
    const s = this.sessions.get(state);
    if (!s || s.status !== "ready" || !s.access) return no("E_ACCOUNT_CREDENTIAL", { venue: this.o.venue, message: `${this.o.name}: nobody has signed in for this connection yet — sign in from the account page first` });
    if (s.expiresAt === undefined || this.o.clock() < s.expiresAt - 30_000) return s.access;
    if (!s.refresh) return no("E_ACCOUNT_CREDENTIAL", { venue: this.o.venue, message: `${this.o.name}'s sign-in ran out: sign in again from the account page` });
    const r = await this.post(this.endpoints!.token, new URLSearchParams({ grant_type: "refresh_token", refresh_token: s.refresh, client_id: s.clientId, resource: this.o.resource }).toString(), "application/x-www-form-urlencoded", [s.refresh]);
    if ("ok" in r) return r;
    const took = this.took(s, r);
    return took === true ? s.access! : no("E_ACCOUNT_CREDENTIAL", { venue: this.o.venue, message: `${this.o.name}'s sign-in ran out and could not be renewed: sign in again from the account page` });
  }

  /** the venue's token answer, kept in memory; anything else is said in the venue's words, with the secrets taken out */
  private took(s: Session, r: HttpReply): true | string {
    const b = (r.body ?? {}) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
    if (r.status !== 200 || typeof b.access_token !== "string" || !b.access_token) return this.said("trading the code for a token", r).message;
    s.access = b.access_token;
    if (typeof b.refresh_token === "string" && b.refresh_token) s.refresh = b.refresh_token;
    s.expiresAt = typeof b.expires_in === "number" && b.expires_in > 0 ? this.o.clock() + b.expires_in * 1000 : undefined;
    s.status = "ready";
    s.error = undefined;
    return true;
  }

  private async discover(): Promise<Endpoints | Refusal> {
    if (this.endpoints) return this.endpoints;
    const pr = await this.get(wellKnown(this.o.resource, "oauth-protected-resource"));
    if ("ok" in pr) return pr;
    const issuer = https((pr.body as { authorization_servers?: unknown[] } | undefined)?.authorization_servers?.[0]);
    if (pr.status !== 200 || !issuer) return this.said("finding where it signs people in", pr);
    const as = await this.get(wellKnown(issuer, "oauth-authorization-server"));
    if ("ok" in as) return as;
    const m = (as.body ?? {}) as Record<string, unknown>;
    const authorization = https(m.authorization_endpoint);
    const token = https(m.token_endpoint);
    if (as.status !== 200 || m.issuer !== issuer || !authorization || !token) return this.said("reading its sign-in endpoints", as);
    if (!(Array.isArray(m.code_challenge_methods_supported) && m.code_challenge_methods_supported.includes("S256"))) return no("E_VENUE_REJECTED", { venue: this.o.venue, message: `${this.o.name}'s sign-in does not take PKCE (S256), so this account will not use it` });
    const scopes = Array.isArray(m.scopes_supported) ? m.scopes_supported.filter((x): x is string => typeof x === "string") : [];
    this.endpoints = { issuer, authorization, token, registration: https(m.registration_endpoint), scope: scopes.length ? scopes.join(" ") : undefined, issOnReturn: m.authorization_response_iss_parameter_supported === true };
    return this.endpoints;
  }

  private async get(url: string): Promise<HttpReply | Refusal> {
    try {
      return await this.o.http(url, { headers: { accept: "application/json" } });
    } catch (err) {
      return no("E_VENUE_UNREACHABLE", { venue: this.o.venue, message: `${this.o.name}'s sign-in could not be reached`, native: { error: String((err as Error)?.message ?? err).slice(0, 200) } });
    }
  }

  private async post(url: string, body: string, type: string, secrets: Array<string | undefined> = []): Promise<HttpReply | Refusal> {
    try {
      return await this.o.http(url, { method: "POST", headers: { "content-type": type, accept: "application/json" }, body });
    } catch (err) {
      return no("E_VENUE_UNREACHABLE", { venue: this.o.venue, message: `${this.o.name}'s sign-in could not be reached`, native: { error: redact(String((err as Error)?.message ?? err).slice(0, 200), secrets) } });
    }
  }

  private said(doing: string, r: HttpReply): Refusal {
    const words = (r.body as { error_description?: unknown; error?: unknown } | undefined) ?? {};
    const what = typeof words.error_description === "string" ? words.error_description : typeof words.error === "string" ? words.error : `HTTP ${r.status}`;
    return no("E_VENUE_REJECTED", { venue: this.o.venue, message: `${this.o.name} refused ${doing}: ${what.slice(0, 160)}`, native: { status: r.status } });
  }
}
