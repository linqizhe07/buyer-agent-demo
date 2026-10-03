/** A tiny JSON HTTP client for the plugin children (fetch is global on Node ≥18). */
export interface HttpResult {
  status: number;
  headers: Headers;
  /** parsed JSON body, or the raw text when the body is not JSON */
  body: unknown;
}

export interface HttpInit {
  method?: "GET" | "POST" | "DELETE" | "PUT" | undefined;
  headers?: Record<string, string> | undefined;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined> | undefined;
}

export async function http(url: string, init: HttpInit = {}): Promise<HttpResult> {
  const target = new URL(url);
  for (const [k, v] of Object.entries(init.query ?? {})) {
    if (v !== undefined) target.searchParams.set(k, String(v));
  }
  const headers: Record<string, string> = { accept: "application/json", ...(init.headers ?? {}) };
  const request: RequestInit = { method: init.method ?? "GET", headers };
  if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    request.body = JSON.stringify(init.body);
  }
  const res = await fetch(target, request);
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text.length ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, headers: res.headers, body: parsed };
}
