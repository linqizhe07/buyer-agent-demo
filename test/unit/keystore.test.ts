import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isRefusal } from "../../src/core/errors.ts";
import { agentWalletKey, seatKey, seatKeyPath } from "../../src/portfolio/account/keystore.ts";
import { signAgent, signerOf, simKey } from "../../src/portfolio/account/sign.ts";

/** A seat's key is its own: made once, kept where only the user can read it, the same ever after — and nothing anyone could work out from
 * the seat's name. */
const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));
const home = () => {
  const h = mkdtempSync(join(tmpdir(), "keystore-"));
  homes.push(h);
  return h;
};

describe("the keys this machine keeps", () => {
  it("makes a seat's key once, readable by the user alone, and gives the same one back", async () => {
    const h = home();
    const k = seatKey(h, "Claude Code");
    if (isRefusal(k)) throw new Error(k.message);
    const path = seatKeyPath(h, "Claude Code");
    expect(path).toBe(join(h, "seats", "claude-code.json"));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(h, "seats")).mode & 0o777).toBe(0o700);
    const again = seatKey(h, "claude code");
    expect(!isRefusal(again) && again.address).toBe(k.address);
    // not the key the seat's name would give: nobody who knows the name holds it
    expect(k.address).not.toBe(simKey("agent:claude-code").address);
    // it signs what the account checks
    const env = await signAgent(k, { type: "agentLiveCancel", venue: "ex", order: "ord-0001", nonce: 1 });
    expect(await signerOf(env.action, env.signature)).toBe(k.address);
    // two homes, two keys
    const other = seatKey(home(), "Claude Code");
    expect(!isRefusal(other) && other.address).not.toBe(k.address);
  });

  it("does not sign with a key file others can read, or one it did not write — and does not quietly replace it either", () => {
    const h = home();
    const k = agentWalletKey(h, "research");
    if (isRefusal(k)) throw new Error(k.message);
    const path = join(h, "agent-wallets", "research.json");
    chmodSync(path, 0o644);
    const loose = agentWalletKey(h, "research");
    expect(isRefusal(loose) && loose.code).toBe("E_ACCOUNT_CREDENTIAL");
    chmodSync(path, 0o600);
    const before = readFileSync(path, "utf8");
    writeFileSync(path, "{\"v\":1}", { mode: 0o600 });
    const broken = agentWalletKey(h, "research");
    expect(isRefusal(broken) && broken.message).toContain("is not a key file this account wrote");
    // the broken file is still there: the account made no new key over it
    expect(readFileSync(path, "utf8")).toBe("{\"v\":1}");
    expect(before).toContain("\"kind\": \"agent-wallet\"");
  });
});
