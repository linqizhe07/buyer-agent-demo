import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { startPortfolioServer } from "../../src/portfolio/server.ts";
import { PortfolioService } from "../../src/portfolio/service.ts";

/** Only this machine's own pages and programs talk to the account: another site's request is turned away before any route sees it */
const home = mkdtempSync(join(tmpdir(), "server-guard-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("who the server answers", () => {
  it("its own page and local programs; not another site's script, nor a request the browser marks as cross-site — but a link or a venue's sign-in sending the owner back, yes", async () => {
    const svc = await PortfolioService.create({ home, venues: "frontline", real: true, liveDeps: { http: async () => ({ status: 599, body: undefined, text: "" }), price: async () => undefined } });
    const srv = await startPortfolioServer({ port: 0, service: svc });
    try {
      const get = (path: string, headers: Record<string, string> = {}) => fetch(`${srv.url}${path}`, { headers }).then((r) => r.status);
      expect(await get("/api/account")).toBe(200);
      expect(await get("/api/account", { origin: srv.url })).toBe(200);
      expect(await get("/api/account", { origin: "https://evil.example" })).toBe(403);
      expect(await get("/api/account", { origin: "null" })).toBe(403);
      expect(await get("/api/account", { "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" })).toBe(403);
      expect(await get("/", { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" })).toBe(200);
      expect(await get("/api/account", { "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" })).toBe(200);
    } finally {
      await srv.close();
    }
  });
});
