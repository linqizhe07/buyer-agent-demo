/** The Account as a background service on this Mac, so that an agent can call it at any time: started when the user logs in, started again if
 * it stops by accident, its log where only the user can read it. macOS's own launchd runs it (a LaunchAgent in ~/Library/LaunchAgents),
 * and nothing about it needs an administrator.
 *
 *   npm run account:service -- install --live-cap 20     run `npm run account -- --live-cap 20` in the background, from now on
 *   npm run account:service -- status                    is it running, and does it answer
 *   npm run account:service -- restart                   start it again (after an update, or to pick up new code)
 *   npm run account:service -- logs                      the last lines it wrote
 *   npm run account:service -- code                      the pairing code, when the account has no owner yet
 *   npm run account:service -- uninstall                 stop it and take it out of launchd
 *
 * What it runs is the code in this folder: a change here reaches it on the next restart. Its state is the account's own (the ledgers in the
 * home, account/restore.ts): a restart brings back the owner's browser, the venues, the agents and their limits.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultHome } from "./home.ts";

export const LABEL = "com.buyer-agent-demo.account";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface ServicePlan {
  plist: string;
  path: string;
  log: string;
  errLog: string;
  args: string[];
}

const d0 = (f: string): boolean => {
  try {
    return existsSync(f) && !f.includes("/node_modules/");
  } catch {
    return false;
  }
};
const xml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** the LaunchAgent for `npm run account -- <serverArgs>`: node and tsx by their full paths (launchd has no shell to find them), this
 * folder as the working directory, restarted when it exits by accident, a log only the user can read (umask 077) */
export function plan(serverArgs: string[], o: { node?: string; root?: string; home?: string; env?: Record<string, string | undefined> } = {}): ServicePlan {
  const env = o.env ?? process.env;
  // node as the PATH finds it (Homebrew's /opt/homebrew/bin/node), not the versioned folder it resolves to: an upgrade does not break it
  const node = o.node ?? (env.PATH ?? "").split(":").map((d) => join(d, "node")).find((f) => d0(f)) ?? process.execPath;
  const root = o.root ?? ROOT;
  const home = o.home ?? defaultHome();
  const logs = join(home, "logs");
  const log = join(logs, "account.log");
  const errLog = join(logs, "account.err.log");
  const args = [node, join(root, "node_modules", "tsx", "dist", "cli.mjs"), join(root, "src", "portfolio", "server.ts"), ...serverArgs];
  // the commands the account itself runs (mm for the MetaMask Agent Wallet) are found on the user's own PATH; the home, if moved, moves too
  // (without the folders npm puts first on PATH while it runs this script: they are npm's, not the user's)
  const path = (env.PATH ?? "").split(":").filter((d) => d !== "" && !d.includes("/node_modules/")).join(":");
  const keep = Object.fromEntries(Object.entries({ PATH: path, HOME: env.HOME ?? homedir(), BUYER_HOME: env.BUYER_HOME, ...Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith("PORTFOLIO_RPC_"))) }).filter(([, v]) => typeof v === "string" && v !== "")) as Record<string, string>;
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key><string>${xml(root)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(keep).map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`).join("\n")}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(errLog)}</string>
  <key>ProcessType</key><string>Standard</string>
</dict>
</plist>
`;
  return { plist, path: join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`), log, errLog, args };
}

const domain = (): string => `gui/${userInfo().uid}`;
const launchctl = (args: string[], quiet = false): string => {
  try {
    return execFileSync("launchctl", args, { encoding: "utf8", stdio: quiet ? ["ignore", "pipe", "ignore"] : ["ignore", "pipe", "pipe"] });
  } catch (err) {
    if (quiet) return "";
    throw err;
  }
};

/** the port the service listens on, as its arguments say (4820 unless --port) */
const portOf = (args: string[]): number => {
  const i = args.indexOf("--port");
  return i >= 0 ? Number(args[i + 1]) : 4820;
};

async function answers(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/now`, { signal: AbortSignal.timeout(2_000) });
    return r.ok;
  } catch {
    return false;
  }
}

/** how many owners the running account has (its signers), or undefined when it does not answer */
async function ownerCount(port: number): Promise<number | undefined> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/account`, { signal: AbortSignal.timeout(3_000) });
    if (!r.ok) return undefined;
    const a = (await r.json()) as { signers?: { owners?: unknown[] } };
    return Array.isArray(a.signers?.owners) ? a.signers.owners.length : undefined;
  } catch {
    return undefined;
  }
}

/** the server's own options in the installed LaunchAgent (what follows server.ts in its ProgramArguments) */
function installed(): { args: string[] } | undefined {
  const p = plan([]).path;
  if (!existsSync(p)) return undefined;
  const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(readFileSync(p, "utf8"))?.[1] ?? "";
  const strings = [...block.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]!.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
  const i = strings.findIndex((s) => s.endsWith("/src/portfolio/server.ts"));
  return { args: i >= 0 ? strings.slice(i + 1) : [] };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [cmd = "status", ...rest] = process.argv.slice(2);
  const p = plan(rest);
  if (cmd === "install") {
    if (process.platform !== "darwin") throw new Error("this installs a macOS LaunchAgent: on another system run `npm run account` under its own service manager");
    mkdirSync(dirname(p.log), { recursive: true, mode: 0o700 });
    mkdirSync(dirname(p.path), { recursive: true });
    // a running copy of an earlier install is taken out first: one service, one port
    launchctl(["bootout", `${domain()}/${LABEL}`], true);
    writeFileSync(p.path, p.plist, { mode: 0o644 });
    launchctl(["bootstrap", domain(), p.path]);
    launchctl(["enable", `${domain()}/${LABEL}`], true);
    console.log(`installed: ${p.path}\n  runs: npm run account -- ${rest.join(" ") || "(no options)"} — at login, and again if it stops by accident\n  log: ${p.log} (only you can read it)\n  the account is at http://127.0.0.1:${portOf(rest)} · npm run account:service -- status`);
  } else if (cmd === "uninstall") {
    launchctl(["bootout", `${domain()}/${LABEL}`], true);
    rmSync(p.path, { force: true });
    console.log(`uninstalled: the account no longer runs in the background (its ledgers and keys are untouched in ${defaultHome()})`);
  } else if (cmd === "restart") {
    launchctl(["kickstart", "-k", `${domain()}/${LABEL}`]);
    console.log("restarted: it continues the account from its ledgers (owner, venues, agents and limits come back)");
  } else if (cmd === "logs") {
    for (const f of [p.log, p.errLog]) if (existsSync(f)) console.log(`== ${f}\n${readFileSync(f, "utf8").split("\n").slice(-40).join("\n")}`);
  } else if (cmd === "code") {
    // the code of the run that is up now, and only while no browser owns the account: a code already used, or an earlier run's, is not shown
    const port = portOf(installed()?.args ?? rest);
    const owners = await ownerCount(port);
    if (owners === undefined) console.log(`the account is not answering on ${port} yet: give it a few seconds (npm run account:service -- status)`);
    else if (owners > 0) console.log("no pairing code is needed: the account already has its owner's browser");
    else {
      const lines = existsSync(p.log) ? readFileSync(p.log, "utf8").split("\n") : [];
      const start = lines.map((l) => l.startsWith("TRADING IS ON") || l.startsWith("read-only:")).lastIndexOf(true);
      const line = start >= 0 ? lines.slice(start + 1).find((l) => l.includes("pairing code:")) : undefined;
      console.log(line ? line.trim() : "no pairing code in this run's log: npm run account:service -- logs");
    }
  } else {
    const info = launchctl(["print", `${domain()}/${LABEL}`], true);
    const state = /state = (\w+)/.exec(info)?.[1];
    const pid = /pid = (\d+)/.exec(info)?.[1];
    const args = installed()?.args ?? rest;
    const port = portOf(args);
    console.log(info ? `${LABEL}: ${state ?? "loaded"}${pid ? ` (pid ${pid})` : ""} · ${(await answers(port)) ? `answering at http://127.0.0.1:${port}` : `not answering on ${port} yet`}` : `${LABEL}: not installed (npm run account:service -- install --live-cap 20)`);
  }
}
