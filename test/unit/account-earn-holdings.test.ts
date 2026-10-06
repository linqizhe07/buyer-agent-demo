/** Money in an earn product beside a venue's balances (account/holdings.ts withEarn, byAsset, change24h): a row of its own, class earn, in
 * the venue's total — and never counted twice where the venue's balance read already carries the same money: Kraken's `<ASSET>.B` lines,
 * a vault's shares in a wallet. OKX's Simple Earn leaves the funding account when it goes in, so nothing is left out there. And an RWA
 * market's orders join the wallet's RWA row (marketKey). Pure functions: nothing is asked of anyone. */
import { describe, expect, it } from "vitest";
import { byAsset, change24h, earnKey, marketClass, marketKey, withEarn, type EarnHeld } from "../../src/portfolio/account/holdings.ts";
import type { AccountPage } from "../../src/portfolio/account/exchange.ts";

type V = AccountPage["venues"][number];
const venue = (id: string, name: string, holdings: Array<Partial<V["holdings"][number]> & { asset: string; amount: number; usd: number }>): Pick<V, "id" | "name" | "holdings"> => ({ id, name, holdings: holdings.map((h) => ({ class: "crypto", inTransit: false, ...h })) as V["holdings"] });
const sum = (hs: V["holdings"]) => Number(hs.reduce((t, h) => t + h.usd, 0).toFixed(2));

describe("withEarn: an earn product's money added to a venue, the same money in its balance left out", () => {
  it("Kraken: an allocation is also in the balance as <ASSET>.B (unpriced there) — that line goes, the allocation counts once", () => {
    const kraken = venue("kraken", "Kraken", [
      { asset: "USDC", amount: 100, usd: 100, class: "stable" },
      { asset: "USDC.B", amount: 500, usd: 0, note: "no price" },
      { asset: "BTC.F", amount: 0.01, usd: 0, note: "no price" },
      // staked under the old programme, with no allocation the earn read lists: kept as the venue gives it
      { asset: "DOT.S", amount: 20, usd: 0, note: "no price" },
    ]);
    const held: EarnHeld[] = [
      { product: "ESRFUO3-Q62XD-WIOIL7", asset: "USDC", amount: 500, usd: 500, apy: 0.055, name: "USDC · Kraken Earn" },
      { product: "EFLEX-BTC-0000001", asset: "BTC", amount: 0.01, usd: 625 },
    ];
    const out = withEarn(kraken, held);
    expect(out.dropped.map((h) => h.asset).sort()).toEqual(["BTC.F", "USDC.B"]);
    expect(out.holdings.map((h) => h.asset)).toEqual(["USDC", "DOT.S", "USDC", "BTC"]);
    expect(out.holdings.filter((h) => h.class === "earn")).toEqual([
      { asset: "USDC", amount: 500, usd: 500, class: "earn", note: "earning 5.5% at Kraken · USDC · Kraken Earn", inTransit: false, earn: { product: "ESRFUO3-Q62XD-WIOIL7", asset: "USDC", name: "USDC · Kraken Earn", apy: 0.055 } },
      { asset: "BTC", amount: 0.01, usd: 625, class: "earn", note: "earning at Kraken", inTransit: false, earn: { product: "EFLEX-BTC-0000001", asset: "BTC" } },
    ]);
    // 100 ready + 500 + 625 in earn: not 1,225 + the 500 again
    expect(sum(out.holdings)).toBe(1_225);
  });

  it("OKX: Simple Earn is not in the funding or trading balance, so both stand: the USDT that is ready and the USDT lent out", () => {
    const okx = venue("okx", "OKX", [{ asset: "USDT", amount: 300, usd: 300, class: "stable", note: "funding" }]);
    const out = withEarn(okx, [{ product: "savings:USDT", asset: "USDT", amount: 1_000, usd: 1_000 }]);
    expect(out.dropped).toEqual([]);
    expect(sum(out.holdings)).toBe(1_300);
  });

  it("a wallet: a vault's shares on its chain, by the symbol its chain gave, are the position — that line goes; the underlying stays", () => {
    const wallet = venue("metamask", "MetaMask Agent Wallet", [
      { asset: "USDC", amount: 80, usd: 80, class: "stable", note: "Base" },
      { asset: "steakUSDC", amount: 290, usd: 301.2, note: "Base" },
      { asset: "steakUSDC", amount: 10, usd: 10.4, note: "Ethereum" },
    ]);
    const held: EarnHeld[] = [{ product: "8453:0x7bfa7c4f149e7415b73bdedfe609237e29cbf34a", asset: "USDC", amount: 301.2, usd: 301.2, chain: "Base" }];
    const out = withEarn(wallet, held, { shares: new Map([["8453:0x7bfa7c4f149e7415b73bdedfe609237e29cbf34a", "steakUSDC"]]) });
    expect(out.dropped).toEqual([expect.objectContaining({ asset: "steakUSDC", note: "Base" })]);
    expect(out.holdings.map((h) => `${h.asset}@${h.note?.split(" · ")[0]}`)).toEqual(["USDC@Base", "steakUSDC@Ethereum", "USDC@earning at MetaMask Agent Wallet"]);
    expect(sum(out.holdings)).toBe(391.6);
  });

  it("a wallet, the share symbol unknown: a line on the vault's chain carrying the asset's name and worth what the position is goes — nothing else", () => {
    const wallet = venue("metamask", "MetaMask Agent Wallet", [
      { asset: "USDC", amount: 500, usd: 500, class: "stable", note: "Base" },
      // a dollar stablecoin is never a vault's shares
      { asset: "USDC.e", amount: 500, usd: 500, class: "stable", note: "Base" },
      { asset: "aBasUSDC", amount: 499.9, usd: 499.9, note: "Base Mainnet" },
      // the right name, the wrong worth: another holding
      { asset: "gtUSDCp", amount: 50, usd: 50, note: "Base" },
    ]);
    const out = withEarn(wallet, [{ product: "8453:0x4e65fe4dba92790696d040ac24aa414708f5c0ab", asset: "USDC", amount: 500, usd: 500, chain: "Base" }]);
    expect(out.dropped.map((h) => h.asset)).toEqual(["aBasUSDC"]);
    expect(sum(out.holdings)).toBe(1_550);
  });

  it("no positions: the holdings as they were; a last good read is marked as such", () => {
    const v = venue("okx", "OKX", [{ asset: "USDT", amount: 10, usd: 10, class: "stable" }]);
    expect(withEarn(v, []).holdings).toEqual(v.holdings);
    const stale = withEarn(v, [{ product: "savings:USDT", asset: "USDT", amount: 5 }], { stale: true }).holdings.at(-1)!;
    // a dollar without the venue's dollars is still a dollar
    expect(stale).toMatchObject({ usd: 5, note: "earning at OKX · the venue's last read", earn: { stale: true } });
    const unpriced = withEarn(v, [{ product: "x:ABC", asset: "ABC", amount: 5 }]).holdings.at(-1)!;
    expect([unpriced.usd, unpriced.note]).toEqual([0, "earning at OKX · no price"]);
  });
});

describe("byAsset and change24h: an earn row of its own", () => {
  const page = [
    { id: "okx", name: "OKX", holdings: withEarn(venue("okx", "OKX", [{ asset: "USDT", amount: 300, usd: 300, class: "stable", note: "funding" }]), [{ product: "savings:USDT", asset: "USDT", amount: 1_000, usd: 1_000, apy: 0.04 }, { product: "savings:ETH", asset: "ETH", amount: 1, usd: 2_500 }]).holdings },
    { id: "kraken", name: "Kraken", holdings: withEarn(venue("kraken", "Kraken", []), [{ product: "S1", asset: "USDT", amount: 200, usd: 200 }]).holdings },
  ];

  it("is earn:<venue>:<product>, class earn, its asset and yield on it; the same asset in two products is two rows; none of it is ready", () => {
    const { rows, money } = byAsset(page, { writes: true });
    expect(rows.map((r) => r.key)).toEqual(["earn:okx:savings:ETH", "earn:okx:savings:USDT", "stable:USDT", "earn:kraken:S1"]);
    expect(rows.find((r) => r.key === earnKey("okx", "savings:USDT"))).toMatchObject({ class: "earn", asset: "USDT", amount: 1_000, usd: 1_000, earn: { venue: "okx", venueName: "OKX", product: "savings:USDT", asset: "USDT", apy: 0.04 } });
    expect(money.readyUsd).toBe(300);
  });

  it("changes in 24 hours as its asset does: a dollar by nothing, a coin as the coin", () => {
    const { rows } = byAsset(page);
    const day = change24h(rows, new Map([["crypto:ETH", { changePct24h: 10 }]]));
    expect(day.missing).toEqual([]);
    expect(day.coveredUsd).toBe(4_000);
    expect(day.usd).toBeCloseTo(2_500 - 2_500 / 1.1, 2);
    expect(change24h(rows, new Map()).missing).toEqual(["earn:okx:savings:ETH"]);
  });
});

describe("marketKey: an RWA market's orders join the wallet's RWA row", () => {
  it("a token market of category RWA is class rwa, keyed by its symbol; the same token without it is a coin", () => {
    expect(marketClass("token", "USDY", "RWA")).toBe("rwa");
    expect(marketKey({ kind: "token", base: "USDY", symbol: "USDY/USDC@Ethereum", category: "RWA" })).toBe("rwa:USDY");
    expect(marketKey({ kind: "token", base: "NVDAon", symbol: "NVDAon/USDC@Ethereum", category: "RWA" })).toBe("rwa:NVDAON");
    expect(marketKey({ kind: "token", base: "USDY", symbol: "USDY/USDC@Ethereum" })).toBe("crypto:USDY");
    // a share is not a token that stands for it, whatever its category
    expect(marketKey({ kind: "stock", base: "NVDA", symbol: "NVDA", category: "RWA" })).toBe("equity:NVDA");
    expect(byAsset([{ id: "w", name: "Wallet", holdings: [{ asset: "USDY", amount: 3, usd: 3.3, class: "rwa", inTransit: false }] }]).rows[0]!.key).toBe("rwa:USDY");
  });
});
