import { describe, expect, it } from "vitest";
import { LABEL, plan } from "../../src/portfolio/account-service.ts";

/** The LaunchAgent that keeps the account up for agents: what launchd is told to run, and what it is not given */
describe("the account as a background service", () => {
  const p = plan(["--live-cap", "20", "--port", "4820"], { node: "/opt/homebrew/bin/node", root: "/Users/me/demo", home: "/Users/me/.buyer-agent-demo", env: { PATH: "/Users/me/demo/node_modules/.bin:/opt/homebrew/lib/node_modules/npm/node_modules/@npmcli/run-script/lib/node-gyp-bin:/opt/homebrew/bin:/usr/bin", HOME: "/Users/me", PORTFOLIO_RPC_BASE: "https://rpc.example", SECRET_TOKEN: "x" } });

  it("runs this folder's server under node and tsx by their full paths, with the options given", () => {
    expect(p.args).toEqual(["/opt/homebrew/bin/node", "/Users/me/demo/node_modules/tsx/dist/cli.mjs", "/Users/me/demo/src/portfolio/server.ts", "--live-cap", "20", "--port", "4820"]);
    expect(p.plist).toContain(`<key>Label</key><string>${LABEL}</string>`);
    expect(p.plist).toContain("<key>WorkingDirectory</key><string>/Users/me/demo</string>");
  });

  it("starts at login, starts again only after an exit by accident, and logs where only the user can read", () => {
    expect(p.plist).toMatch(/<key>RunAtLoad<\/key><true\/>/);
    expect(p.plist).toMatch(/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key><false\/>/);
    expect(p.plist).toContain("<key>Umask</key><integer>63</integer>");
    expect([p.log, p.errLog]).toEqual(["/Users/me/.buyer-agent-demo/logs/account.log", "/Users/me/.buyer-agent-demo/logs/account.err.log"]);
  });

  it("keeps the user's PATH, HOME and RPC settings — not npm's own folders, and nothing else from the environment", () => {
    expect(p.plist).toContain("<key>PATH</key><string>/opt/homebrew/bin:/usr/bin</string>");
    expect(p.plist).toContain("<key>PORTFOLIO_RPC_BASE</key><string>https://rpc.example</string>");
    expect(p.plist).not.toContain("SECRET_TOKEN");
    expect(p.plist).not.toContain("node_modules/.bin");
  });

  it("writes what it is given as XML text", () => {
    expect(plan(["--home", "/tmp/a&b<c>"], { node: "/n", root: "/r", home: "/h", env: {} }).plist).toContain("<string>/tmp/a&amp;b&lt;c&gt;</string>");
  });
});
