import { describe, expect, it } from "vitest";
import { companyOf, impliedUsd, isPreIpoMarket, NEVER_PRE_IPO, OKX_REBASED_PER_POINT, PRE_IPO_CATEGORY, PRE_IPO_COMPANIES, PRE_IPO_ISSUERS, PRE_IPO_NAMES, PRE_IPO_PER_POINT, preIpoFlag, preIpoOf, unitOf } from "../../src/portfolio/live/preipo.ts";

/** The one table of pre-IPO perpetuals: the venues' own flags on their records (as answered live on 2026-10-06), the unit per venue and
 * instrument, the companies under the venues' names, and the issuers' words. No network, no key. */

describe("the unit a venue prices a pre-IPO contract in", () => {
  it("is $1 of price for $1,000,000,000 of implied valuation everywhere but OKX's two swaps rebased 10:1 on 30 June 2026", () => {
    expect(unitOf("okx", "ANTHROPIC-USDT-SWAP")).toEqual({ perPoint: OKX_REBASED_PER_POINT, unit: "OKX: a price of $1 stands for $10,000,000,000 of implied company valuation since its 10:1 rebase of 30 June 2026" });
    expect(unitOf("okx", "OPENAI-USDT-SWAP").perPoint).toBe(10_000_000_000);
    // OKX's later listings are in the unit everyone else uses: its MOONSHOT and OURA equal Kraken's and MEXC's
    expect(unitOf("okx", "MOONSHOT-USDT-SWAP")).toEqual({ perPoint: PRE_IPO_PER_POINT, unit: "a price of $1 stands for $1,000,000,000 of implied company valuation (one contract ≈ one-billionth of the company)" });
    expect(unitOf("myokx", "anthropic-usdt-swap").perPoint).toBe(10_000_000_000);
    for (const [venue, inst] of [["gate", "ANTHROPIC_USDT"], ["krakenfutures", "PF_ANTHROPICXUSD"], ["deribit", "ANTH_USDC-PERPETUAL"], ["kucoinfutures", "ANTHROPICUSDTM"], ["mexc", "ANTHROPIC_USDT"], ["bybit", "ANTHROPICUSDT"]]) expect(unitOf(venue!, inst!).perPoint).toBe(1_000_000_000);
    expect(impliedUsd(214.51, 1e10)).toBe(2_145_100_000_000);
    expect(impliedUsd(2078.34, 1e9)).toBe(2_078_340_000_000);
  });
});

describe("a company under the venues' names", () => {
  it("is one company whatever a venue calls its contract: ANTHROPIC, Deribit's ANTH, Kraken's ANTHROPICx, MEXC's KIMISTOCK and OURASTOCK", () => {
    expect(companyOf("ANTHROPIC")).toEqual({ slug: "anthropic", name: "Anthropic", known: true });
    expect(companyOf("ANTH")).toEqual({ slug: "anthropic", name: "Anthropic", known: true });
    expect(companyOf("ANTHROPICx")).toEqual({ slug: "anthropic", name: "Anthropic", known: true });
    expect(companyOf("OURAx")).toMatchObject({ slug: "oura", name: "Oura" });
    expect(companyOf("OURASTOCK")).toMatchObject({ slug: "oura" });
    expect(companyOf("KIMISTOCK")).toEqual({ slug: "moonshot", name: "Moonshot AI (Kimi)", known: true });
    expect(companyOf("MOONSHOT")).toMatchObject({ slug: "moonshot" });
    expect(companyOf("POLYMARKETSTOCK")).toMatchObject({ slug: "polymarket", name: "Polymarket" });
    expect(companyOf("YMTCSTOCK")).toMatchObject({ slug: "ymtc" });
    expect(companyOf("OAI")).toMatchObject({ slug: "openai", name: "OpenAI" });
    // a name the table does not know is the venue's own, shown as the venue writes it (Gate's KIMI and QNTX on 2026-10-06)
    expect(companyOf("QNTX")).toEqual({ slug: "qntx", name: "QNTX", known: false });
    expect(companyOf("KIMI")).toEqual({ slug: "kimi", name: "KIMI", known: false });
    // SpaceX is public: never a pre-IPO company, under any spelling
    expect(companyOf("SPACEX")).toBeUndefined();
    expect(companyOf("SPCX")).toBeUndefined();
    expect(companyOf("SPACEXx")).toBeUndefined();
    expect(companyOf("  ")).toBeUndefined();
    expect([...NEVER_PRE_IPO]).toEqual(["SPACEX", "SPCX"]);
    // the names Gate is asked about are each company's first alias
    expect(PRE_IPO_NAMES).toEqual(PRE_IPO_COMPANIES.map((c) => c.aliases[0]));
    expect(PRE_IPO_NAMES).toContain("ANTHROPIC");
    expect(PRE_IPO_NAMES).not.toContain("SPACEX");
  });
});

describe("the venue's own flag", () => {
  it("reads each venue's record: OKX ruleType, Gate is_pre_market with contract_type stocks, Kraken category, Deribit underlying_type, KuCoin marketStage with assetClass STOCK, MEXC conceptPlate; nothing where the venue has none", () => {
    expect(preIpoFlag("okx", { ruleType: "pre_market" })).toBe(true);
    expect(preIpoFlag("okx", { ruleType: "normal" })).toBe(false);
    expect(preIpoFlag("okx", { ruleType: "xperp" })).toBe(false);
    expect(preIpoFlag("okx", { instId: "BTC-USDT" })).toBeUndefined();
    expect(preIpoFlag("gate", { is_pre_market: true, contract_type: "stocks" })).toBe(true);
    // Gate's GPU-price indices and its BP token are pre-market too, and not companies
    expect(preIpoFlag("gate", { is_pre_market: true, contract_type: "indices" })).toBe(false);
    expect(preIpoFlag("gate", { is_pre_market: true, contract_type: "" })).toBe(false);
    expect(preIpoFlag("gate", { is_pre_market: false, contract_type: "stocks" })).toBe(false);
    expect(preIpoFlag("gateio", { is_pre_market: "true", contract_type: "stocks" })).toBe(true);
    expect(preIpoFlag("gate", { name: "BTC_USDT" })).toBeUndefined();
    expect(preIpoFlag("krakenfutures", { category: "Pre-IPO" })).toBe(true);
    expect(preIpoFlag("krakenfutures", { category: "Layer 1" })).toBe(false);
    expect(preIpoFlag("krakenfutures", { category: "" })).toBeUndefined();
    expect(preIpoFlag("deribit", { underlying_type: "preipo" })).toBe(true);
    expect(preIpoFlag("deribit", { underlying_type: "equity" })).toBe(false);
    expect(preIpoFlag("kucoinfutures", { marketStage: "PRE_MARKET", assetClass: "STOCK" })).toBe(true);
    expect(preIpoFlag("kucoinfutures", { marketStage: "PRE_MARKET", assetClass: "CRYPTO" })).toBe(false);
    expect(preIpoFlag("kucoinfutures", { marketStage: "NORMAL", assetClass: "STOCK" })).toBe(false);
    expect(preIpoFlag("mexc", { conceptPlate: ["mc-trade-zone-Stock", "mc-trade-zone-preipo"] })).toBe(true);
    expect(preIpoFlag("mexc", { conceptPlate: ["mc-trade-zone-mainly"] })).toBe(false);
    expect(preIpoFlag("mexc", { symbol: "BTC_USDT" })).toBeUndefined();
    // no flag read for these exchanges
    expect(preIpoFlag("bitget", { symbol: "ANTHROPICUSDT" })).toBeUndefined();
    expect(preIpoFlag("binance", {})).toBeUndefined();
  });
});

describe("a perpetual read as a pre-IPO contract", () => {
  it("by the venue's flag where it has one — the flag alone decides there — else by the company's name matched whole; SpaceX never", () => {
    const anthropic = preIpoOf("okx", { ruleType: "pre_market" }, "ANTHROPIC", "ANTHROPIC-USDT-SWAP");
    expect(anthropic).toEqual({ slug: "anthropic", name: "Anthropic", category: PRE_IPO_CATEGORY, group: { id: "preipo:anthropic", title: "Anthropic" }, implied: { perPoint: 10_000_000_000, unit: expect.stringContaining("OKX") }, issuer: "Anthropic", eligibility: PRE_IPO_ISSUERS.anthropic!.eligibility });
    // the flag says no: not one, whatever the name
    expect(preIpoOf("okx", { ruleType: "normal" }, "ANTHROPIC", "ANTHROPIC-USDT-SWAP")).toBeUndefined();
    // the flag says yes for a name the table does not know: shown under the venue's own name
    expect(preIpoOf("gate", { is_pre_market: true, contract_type: "stocks" }, "QNTX", "QNTX_USDT")).toMatchObject({ slug: "qntx", name: "QNTX", group: { id: "preipo:qntx", title: "QNTX" }, implied: { perPoint: 1_000_000_000 } });
    expect(preIpoOf("gate", { is_pre_market: true, contract_type: "stocks" }, "QNTX", "QNTX_USDT")!.issuer).toBeUndefined();
    // no flag at the exchange: the known names, and only those
    expect(preIpoOf("bitget", { symbol: "ANTHROPICUSDT" }, "ANTHROPIC", "ANTHROPICUSDT")).toMatchObject({ slug: "anthropic", implied: { perPoint: 1_000_000_000 } });
    expect(preIpoOf("bitget", { symbol: "XAIUSDT" }, "XAI", "XAIUSDT")).toBeUndefined();
    expect(preIpoOf("bybit", {}, "BTC", "BTCUSDT")).toBeUndefined();
    // SpaceX is public, whatever a record says
    expect(preIpoOf("deribit", { underlying_type: "preipo" }, "SPCX", "SPCX_USDC-PERPETUAL")).toBeUndefined();
    expect(preIpoOf("phemex", undefined, "SPACEX", "SPACEXUSDT")).toBeUndefined();
    // OpenAI's words go with its rows; Oura's row carries none
    expect(preIpoOf("deribit", { underlying_type: "preipo" }, "OPENAI", "OPENAI_USDC-PERPETUAL")).toMatchObject({ slug: "openai", issuer: "OpenAI", eligibility: expect.stringContaining("written consent") });
    expect(preIpoOf("kucoinfutures", { marketStage: "PRE_MARKET", assetClass: "STOCK" }, "OURA", "OURAUSDTM")).toMatchObject({ slug: "oura", name: "Oura" });
    expect(preIpoOf("kucoinfutures", { marketStage: "PRE_MARKET", assetClass: "STOCK" }, "OURA", "OURAUSDTM")!.issuer).toBeUndefined();
  });

  it("the issuers' words are the issuers' own, dated, and a pre-IPO market is told by its category", () => {
    expect(PRE_IPO_ISSUERS.anthropic).toEqual({ issuer: "Anthropic", eligibility: 'Anthropic, 29 June 2026: "Any sale or transfer of Anthropic stock, or any interest in Anthropic stock, that has not been approved by our Board of Directors is void and will not be recognized on our books and records."' });
    expect(PRE_IPO_ISSUERS.openai!.eligibility).toContain('"cannot be directly or indirectly transferred unless the seller first obtains OpenAI\'s written consent"');
    expect(isPreIpoMarket({ kind: "perp", category: PRE_IPO_CATEGORY })).toBe(true);
    expect(isPreIpoMarket({ kind: "perp", category: "Crypto" })).toBe(false);
    expect(isPreIpoMarket({ kind: "spot", category: PRE_IPO_CATEGORY })).toBe(false);
  });
});
