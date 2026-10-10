import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ccxt from "ccxt";
import { getAddress, keccak256, recoverTypedDataAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, describe, expect, it } from "vitest";
import { isRefusal, type Refusal } from "../../src/core/errors.ts";
import { cloidOf, hlPriceInside, hlPriceOk, hlPriceStep, hyperliquidTradeSource, openHyperliquid, type HyperliquidClient, type OpenHyperliquid } from "../../src/portfolio/live/hyperliquid-trade.ts";
import { KEY_SHAPES, keyFileStatus, liveOptions, openLive, type LiveDeps } from "../../src/portfolio/live/index.ts";
import { heldTo, HL_CLOSED, HL_TERMS, HYPERLIQUID_RULE, locator, PLACE_MS } from "../../src/portfolio/live/location.ts";
import type { LiveTrader, Market, OrderRequest, OrderState, Position } from "../../src/portfolio/live/trade.ts";
import type { Http, HttpReply, LiveBalance, LiveSource } from "../../src/portfolio/live/types.ts";

/** TRADING at Hyperliquid through an API wallet — the trade-only key: it signs orders for the account and can never withdraw.
 *
 * The client is the REAL installed library's Hyperliquid client, opened by the connector's own opener (disarmed: no builder fee, no
 * referrer), with its network call replaced: every request it builds is recorded, and the library still reads each answer with its own
 * error handling. Hyperliquid's info answers below were read from this machine on 2026-10-08 (keyless reads; trimmed to a few markets, the
 * addresses in them replaced by made-up ones, an account's figures made up in the live shape where marked). Nothing here may place an order
 * at Hyperliquid, so the exchange endpoint's answers are the ones Hyperliquid's docs show (exchange endpoint, read 2026-10-08). Polymarket's
 * location check is a stand-in too. Nothing leaves the process, and the API wallet's key is generated here and thrown away. */
const NOW = 1791484300000; // 2026-10-08T18:31:40Z
const DAY = 86_400_000;
const CLIENT = "0123456789abcdef0123456789abcdef";
const ACCOUNT = "0x0000000000000000000000000000000000a11ce5";
const OTHER = "0x000000000000000000000000000000000000b0b0";
const PK = generatePrivateKey();
const AGENT = privateKeyToAccount(PK).address;
const KEY = { walletAddress: ACCOUNT, privateKey: PK };
const GEO = "https://polymarket.com/api/geoblock";

type Dict = Record<string, unknown>;

// ---- what Hyperliquid answered, 2026-10-08 (trimmed) ---------------------------------------------------------------

/** spotMeta: seven of its 503 tokens */
const SPOT_TOKENS = [
  { name: "USDC", szDecimals: 8, weiDecimals: 8, index: 0, tokenId: "0x6d1e7cde53ba9467b783cb7c530ce054", isCanonical: true, fullName: null },
  { name: "PURR", szDecimals: 0, weiDecimals: 5, index: 1, tokenId: "0xc1fb593aeffbeb02f85e0308e9956a90", isCanonical: true, fullName: null },
  { name: "HYPE", szDecimals: 2, weiDecimals: 8, index: 150, tokenId: "0x0d01dc56dcaaca66ad901c959b4011ec", isCanonical: false, fullName: "Hyperliquid" },
  { name: "UBTC", szDecimals: 5, weiDecimals: 10, index: 197, tokenId: "0x8f254b963e8468305d409b33aa137c67", isCanonical: false, fullName: "Unit Bitcoin" },
  { name: "USDE", szDecimals: 2, weiDecimals: 8, index: 235, tokenId: "0x2e6d84f2d7ca82e6581e03523e4389f7", isCanonical: false, fullName: "USDe" },
  { name: "USDT0", szDecimals: 2, weiDecimals: 8, index: 268, tokenId: "0x25faedc3f054130dbb4e4203aca63567", isCanonical: false, fullName: "USDT0" },
  { name: "USDH", szDecimals: 2, weiDecimals: 8, index: 360, tokenId: "0x54e00a5988577cb0b0c9ab0cb6ef7f4b", isCanonical: false, fullName: "USDH" },
];
/** four of its 330 spot pairs, with their contexts (spotMetaAndAssetCtxs keeps a context at the pair's index, and a token at its own) */
const SPOT_PAIRS = [
  { tokens: [1, 0], name: "PURR/USDC", index: 0, isCanonical: true },
  { tokens: [150, 0], name: "@107", index: 107, isCanonical: false },
  { tokens: [197, 0], name: "@142", index: 142, isCanonical: false },
  { tokens: [268, 0], name: "@166", index: 166, isCanonical: false },
];
const SPOT_CTX: Record<number, Dict> = {
  0: { prevDayPx: "0.12323", dayNtlVlm: "2473138.0567500014", markPx: "0.11257", midPx: "0.112555", coin: "PURR/USDC", dayBaseVlm: "20663936.0" },
  107: { prevDayPx: "87.421", dayNtlVlm: "112423831.1963099241", markPx: "83.847", midPx: "83.8475", coin: "@107", dayBaseVlm: "1312213.3199999991" },
  142: { prevDayPx: "83346.0", dayNtlVlm: "42305874.1095200107", markPx: "81339.0", midPx: "81338.5", coin: "@142", dayBaseVlm: "515.80257" },
  166: { prevDayPx: "0.99962", dayNtlVlm: "1252135.0506194995", markPx: "0.99946", midPx: "0.99943", coin: "@166", dayBaseVlm: "1252685.3100000005" },
};
const positional = <T>(at: Record<number, T>, length: number, empty: T | null): Array<T | null> => Array.from({ length }, (_, i) => at[i] ?? empty);
const SPOT_META_AND_CTXS = [{ universe: SPOT_PAIRS, tokens: positional(Object.fromEntries(SPOT_TOKENS.map((t) => [t.index, t])), 361, null) }, positional(SPOT_CTX, 167, {})];

/** metaAndAssetCtxs: the first six of the main DEX's 234 perpetuals, in their places (an asset id is the place) */
const MAIN = [
  {
    universe: [
      { szDecimals: 5, name: "BTC", maxLeverage: 40, marginTableId: 56 },
      { szDecimals: 4, name: "ETH", maxLeverage: 25, marginTableId: 55 },
      { szDecimals: 2, name: "ATOM", maxLeverage: 5, marginTableId: 5 },
      { szDecimals: 1, name: "MATIC", maxLeverage: 20, marginTableId: 20, isDelisted: true },
      { szDecimals: 1, name: "DYDX", maxLeverage: 5, marginTableId: 5 },
      { szDecimals: 2, name: "SOL", maxLeverage: 20, marginTableId: 54 },
    ],
  },
  [
    { funding: "0.0000125", openInterest: "39982.91944", prevDayPx: "83341.0", dayNtlVlm: "3341631875.3607401848", premium: "0.0002234102", oraclePx: "81016.9", markPx: "80992.0", midPx: "81035.5", impactPxs: ["81035.0", "81036.0"], dayBaseVlm: "40698.28502" },
    { funding: "0.000010176", openInterest: "1141235.5083999999", prevDayPx: "2558.5", dayNtlVlm: "1797658280.1419503689", premium: "-0.0000494621", oraclePx: "2426.1", markPx: "2425.1", midPx: "2425.75", impactPxs: ["2425.7", "2425.98"], dayBaseVlm: "720638.9565999999" },
    { funding: "0.0000067681", openInterest: "1423796.9399999999", prevDayPx: "1.7077", dayNtlVlm: "1571290.4527029996", premium: "0.0", oraclePx: "1.6617", markPx: "1.6601", midPx: "1.6605", impactPxs: ["1.6592", "1.6617"], dayBaseVlm: "895242.63" },
    { funding: "0.0", openInterest: "0.0", prevDayPx: "0.37621", dayNtlVlm: "0.0", premium: null, oraclePx: "0.3754", markPx: "0.37621", midPx: null, impactPxs: null, dayBaseVlm: "0.0" },
    { funding: "0.0000125", openInterest: "16630310.4000000004", prevDayPx: "0.13406", dayNtlVlm: "501998.140792", premium: "0.0", oraclePx: "0.12789", markPx: "0.12788", midPx: "0.12792", impactPxs: ["0.12765", "0.12802"], dayBaseVlm: "3809975.7000000002" },
    { funding: "0.0000051593", openInterest: "5792734.2199999997", prevDayPx: "116.58", dayNtlVlm: "390079554.030600071", premium: "0.0", oraclePx: "106.96", markPx: "106.9075", midPx: "106.945", impactPxs: ["106.94", "106.9624"], dayBaseVlm: "3491059.9500000002" },
  ],
];
/** perpDexs: its ten HIP-3 DEXs in their places (a DEX's place is in its markets' asset ids), each trimmed to its names — xyz is margined
 * in USDC (token 0), Felix Exchange in USDH (token 360), EntropyIO in USDC; the other seven are read with no markets here */
const DEXS = [
  null,
  { name: "xyz", fullName: "XYZ", deployer: "0x88806a71d74ad0a510b350545c9ae490912f0888", oracleUpdater: null, feeRecipient: "0x83ffcfb1f2ad843c474b2e28df86c721cb869d3a" },
  { name: "flx", fullName: "Felix Exchange", deployer: "0x2fab552502a6d45920d5741a2f3ebf4c35536352", oracleUpdater: "0x94757f8dcb4bf73b850195660e959d1105cfedd5", feeRecipient: "0xe2872b5ae7dcbba40cc4510d08c8bbea95b42d43" },
  { name: "vntl", fullName: "Ventuals" },
  { name: "hyna", fullName: "HyENA" },
  { name: "km", fullName: "Markets by Kinetiq" },
  { name: "abcd", fullName: "ABCDEx" },
  { name: "cash", fullName: "dreamcash" },
  { name: "para", fullName: "Paragon" },
  { name: "mkts", fullName: "Markets By Kinetiq" },
  { name: "io", fullName: "EntropyIO" },
];
/** metaAndAssetCtxs {dex: "io"}: its first two markets, the pre-IPO perpetuals on OpenAI and Anthropic, isolated margin only */
const IO = [
  {
    universe: [
      { szDecimals: 3, name: "io:OAI", maxLeverage: 6, marginTableId: 6, onlyIsolated: true, marginMode: "noCross" },
      { szDecimals: 3, name: "io:ANTH", maxLeverage: 6, marginTableId: 6, onlyIsolated: true, marginMode: "strictIsolated" },
    ],
    collateralToken: 0,
  },
  [
    { funding: "0.0000476663", openInterest: "3140.682", prevDayPx: "1731.7", dayNtlVlm: "5881295.7658000011", premium: "0.0037994643", oraclePx: "1642.6", markPx: "1645.4", midPx: "1647.35", impactPxs: ["1645.914", "1651.768"], dayBaseVlm: "3444.81" },
    { funding: "0.0000234156", openInterest: "19493.104", prevDayPx: "2122.7", dayNtlVlm: "11747926.1107999962", premium: "0.0038635474", oraclePx: "2043.2", markPx: "2046.3", midPx: "2050.95", impactPxs: ["2050.616", "2051.572"], dayBaseVlm: "5603.012" },
  ],
];
const NO_MARKETS = [{ universe: [], collateralToken: 0 }, []];
/** perpCategories ([[coin, category], …], 219 of them): the ones of the markets above */
const CATEGORIES = [["xyz:XYZ100", "indices"], ["xyz:TSLA", "stocks"], ["xyz:NVDA", "stocks"], ["xyz:GOLD", "commodities"], ["xyz:HOOD", "stocks"], ["flx:TSLA", "stocks"], ["io:OAI", "preipo"], ["io:ANTH", "preipo"]];
/** metaAndAssetCtxs {dex: "xyz"}: its first five markets; HOOD takes isolated margin only (marginMode noCross) */
const XYZ = [
  {
    universe: [
      { szDecimals: 4, name: "xyz:XYZ100", maxLeverage: 30, marginTableId: 30 },
      { szDecimals: 3, name: "xyz:TSLA", maxLeverage: 20, marginTableId: 20 },
      { szDecimals: 3, name: "xyz:NVDA", maxLeverage: 20, marginTableId: 20 },
      { szDecimals: 4, name: "xyz:GOLD", maxLeverage: 25, marginTableId: 25 },
      { szDecimals: 3, name: "xyz:HOOD", maxLeverage: 10, marginTableId: 10, onlyIsolated: true, marginMode: "noCross" },
    ],
    collateralToken: 0,
  },
  [
    { funding: "0.00000625", openInterest: "6500.0448", prevDayPx: "31140.0", dayNtlVlm: "462835524.9645000696", premium: "-0.0001735524", oraclePx: "30740.0", markPx: "30735.0", midPx: "30734.5", impactPxs: ["30734.0", "30735.33"], dayBaseVlm: "14987.7352" },
    { funding: "0.00000625", openInterest: "120666.708", prevDayPx: "376.46", dayNtlVlm: "16043114.2664300036", premium: "0.0001264631", oraclePx: "371.65", markPx: "371.7", midPx: "371.7", impactPxs: ["371.664", "371.73"], dayBaseVlm: "42827.117" },
    { funding: "0.00000625", openInterest: "456919.694", prevDayPx: "236.98", dayNtlVlm: "161899634.745080024", premium: "-0.0001514299", oraclePx: "231.13", markPx: "231.11", midPx: "231.095", impactPxs: ["231.09", "231.1"], dayBaseVlm: "690246.7230000001" },
    { funding: "0.00000625", openInterest: "72769.1998", prevDayPx: "4113.2", dayNtlVlm: "79727316.4968899935", premium: "0.0001090539", oraclePx: "4126.4", markPx: "4126.8", midPx: "4126.85", impactPxs: ["4126.8", "4126.9"], dayBaseVlm: "19329.2287" },
    { funding: "0.0000131602", openInterest: "258512.738", prevDayPx: "109.42", dayNtlVlm: "12065693.4508499987", premium: "0.0002947782", oraclePx: "106.86", markPx: "106.92", midPx: "106.895", impactPxs: ["106.883", "106.9"], dayBaseVlm: "111648.985" },
  ],
];
/** metaAndAssetCtxs {dex: "flx"}: its first market, delisted, margined in USDH */
const FLX = [{ universe: [{ szDecimals: 2, name: "flx:TSLA", maxLeverage: 10, marginTableId: 10, isDelisted: true }], collateralToken: 360 }, [{ funding: "0.0", openInterest: "0.0", prevDayPx: "395.5", dayNtlVlm: "0.0", premium: null, oraclePx: "400.53", markPx: "395.5", midPx: null, impactPxs: null, dayBaseVlm: "0.0" }]];
/** l2Book, the top two levels of each side */
const BOOKS: Record<string, Dict> = {
  BTC: { coin: "BTC", time: 1791484273621, levels: [[{ px: "81359.0", sz: "3.12577", n: 16 }, { px: "81358.0", sz: "0.00245", n: 1 }], [{ px: "81360.0", sz: "9.84013", n: 33 }, { px: "81361.0", sz: "1.03348", n: 5 }]] },
  "xyz:NVDA": { coin: "xyz:NVDA", time: 1791484273621, levels: [[{ px: "231.03", sz: "117.059", n: 6 }, { px: "231.02", sz: "109.062", n: 4 }], [{ px: "231.05", sz: "1.052", n: 2 }, { px: "231.06", sz: "46.662", n: 1 }]] },
  "@107": { coin: "@107", time: 1791484273621, levels: [[{ px: "83.847", sz: "206.65", n: 4 }, { px: "83.84", sz: "25.23", n: 1 }], [{ px: "83.848", sz: "40.72", n: 3 }, { px: "83.85", sz: "48.1", n: 2 }]] },
  // made up in the same shape
  ETH: { coin: "ETH", time: 1791484273621, levels: [[{ px: "2444.3", sz: "12.1", n: 3 }], [{ px: "2444.4", sz: "8.0", n: 2 }]] },
  "io:ANTH": { coin: "io:ANTH", time: 1791484273621, levels: [[{ px: "2050.6", sz: "1.2", n: 1 }], [{ px: "2051.5", sz: "0.8", n: 1 }]] },
};
/** allMids, five of its 1239 */
const MIDS = { BTC: "81532.5", ETH: "2444.35", "@107": "84.0805", "@142": "81507.5", "PURR/USDC": "0.113095" };
/** clearinghouseState of a live account (its default abstraction), trimmed to two of its positions: BTC in cross margin, SOL isolated */
const CH = {
  marginSummary: { accountValue: "3656.784576", totalNtlPos: "11376.289024", totalRawUsd: "-7719.504448", totalMarginUsed: "3555.445046" },
  crossMarginSummary: { accountValue: "3264.18285", totalNtlPos: "9983.071024", totalRawUsd: "-6718.888174", totalMarginUsed: "3162.84332" },
  crossMaintenanceMarginUsed: "472.116368",
  withdrawable: "1.723197",
  assetPositions: [
    { type: "oneWay", position: { coin: "BTC", szi: "0.03973", leverage: { type: "cross", value: 3 }, entryPx: "82980.4", positionValue: "3215.30917", unrealizedPnl: "-81.5029", returnOnEquity: "-0.074165192", liquidationPx: null, marginUsed: "1071.769723", maxLeverage: 40, cumFunding: { allTime: "21.839002", sinceOpen: "2.600843", sinceChange: "0.0" } } },
    { type: "oneWay", position: { coin: "SOL", szi: "13.05", leverage: { type: "isolated", value: 3, rawUsd: "-1000.616274" }, entryPx: "114.8627", positionValue: "1393.218", unrealizedPnl: "-105.7408", returnOnEquity: "-0.2116284984", liquidationPx: "78.6416169761", marginUsed: "392.601726", maxLeverage: 20, cumFunding: { allTime: "5.169661", sinceOpen: "1.029456", sinceChange: "0.0" } } },
  ],
  time: 1791483593623,
};
/** an empty HIP-3 DEX account, as every one of a live account's answered */
const CH_EMPTY = { marginSummary: { accountValue: "0.0", totalNtlPos: "0.0", totalRawUsd: "0.0", totalMarginUsed: "0.0" }, crossMarginSummary: { accountValue: "0.0", totalNtlPos: "0.0", totalRawUsd: "0.0", totalMarginUsed: "0.0" }, crossMaintenanceMarginUsed: "0.0", withdrawable: "0.0", assetPositions: [], time: 1791483593779 };
/** the xyz DEX account: made up in the live shape — an NVDA short, isolated */
const CH_XYZ = { ...CH_EMPTY, marginSummary: { accountValue: "250.0", totalNtlPos: "231.11", totalRawUsd: "481.11", totalMarginUsed: "46.22" }, withdrawable: "200.0", assetPositions: [{ type: "oneWay", position: { coin: "xyz:NVDA", szi: "-1.0", leverage: { type: "isolated", value: 5, rawUsd: "281.11" }, entryPx: "235.0", positionValue: "231.11", unrealizedPnl: "3.89", returnOnEquity: "0.0827659574", liquidationPx: "270.5", marginUsed: "50.0", maxLeverage: 20, cumFunding: { allTime: "0.01", sinceOpen: "0.01", sinceChange: "0.0" } } }] };
/** spotClearinghouseState: made up in the live shape */
const SPOT_CH = { balances: [{ coin: "USDC", token: 0, total: "500.25", hold: "0.0", entryNtl: "0.0" }, { coin: "HYPE", token: 150, total: "2.5", hold: "0.0", entryNtl: "212.5" }, { coin: "UBTC", token: 197, total: "0.01", hold: "0.0", entryNtl: "830.0" }, { coin: "USDT0", token: 268, total: "0.0", hold: "0.0", entryNtl: "0.0" }] };
/** a live unified account's spot balances: its whole account (the perps margin is the USDC held) */
const SPOT_UNIFIED = { balances: [{ coin: "USDC", token: 0, total: "9685.51736653", hold: "3656.057542", entryNtl: "0.0" }, { coin: "HYPE", token: 150, total: "0.00836466", hold: "0.0", entryNtl: "0.34979335" }, { coin: "USDE", token: 235, total: "0.0", hold: "0.0", entryNtl: "0.0" }], tokenToAvailableAfterMaintenance: [[0, "8820.79927253"], [360, "0.0"]] };
/** an order's status, in the shape of a live filled order's (orderStatus) */
const status = (oid: number, word: string, o: Dict = {}) => ({ status: "order", order: { order: { coin: "BTC", side: "B", limitPx: "80000.0", sz: "0.001", oid, timestamp: NOW, triggerCondition: "N/A", isTrigger: false, triggerPx: "0.0", children: [], isPositionTpsl: false, reduceOnly: false, orderType: "Limit", origSz: "0.001", tif: "Gtc", cloid: `0x${CLIENT}`, ...o }, status: word, statusTimestamp: NOW } });
/** userFillsByTime, in the shape of a live fill */
const fill = (oid: number, coin: string, px: string, sz: string, fee: string, side = "B") => ({ coin, px, sz, side, time: NOW, startPosition: "0.0", dir: side === "B" ? "Open Long" : "Open Short", closedPnl: "0.0", hash: "0xb275c92c77c3195db3ef044620c0c6020c56001212c6382f563e747f36c6f348", oid, crossed: true, fee, tid: 970803020436936, feeToken: "USDC", twapId: null });
/** candleSnapshot: four BTC hours */
const CANDLES = [
  { t: 1791471600000, T: 1791475199999, s: "BTC", i: "1h", o: "82677.0", c: "81009.0", h: "82678.0", l: "80909.0", v: "8364.5566", n: 62800 },
  { t: 1791475200000, T: 1791478799999, s: "BTC", i: "1h", o: "81007.0", c: "80929.0", h: "81416.0", l: "80784.0", v: "4888.26485", n: 34401 },
  { t: 1791478800000, T: 1791482399999, s: "BTC", i: "1h", o: "80922.0", c: "80720.0", h: "80984.0", l: "80351.0", v: "4023.54386", n: 31912 },
  { t: 1791482400000, T: 1791485999999, s: "BTC", i: "1h", o: "80720.0", c: "81522.0", h: "81535.0", l: "80514.0", v: "1706.04515", n: 16233 },
];

// ---- the exchange endpoint's answers, as Hyperliquid's docs show them ----------------------------------------------------

const RESTING = { status: "ok", response: { type: "order", data: { statuses: [{ resting: { oid: 77738308 } }] } } };
const FILLED = (totalSz: string, avgPx: string, oid = 77747314) => ({ status: "ok", response: { type: "order", data: { statuses: [{ filled: { totalSz, avgPx, oid } }] } } });
const ORDER_NO = (error: string) => ({ status: "ok", response: { type: "order", data: { statuses: [{ error }] } } });
const CANCELED = { status: "ok", response: { type: "cancel", data: { statuses: ["success"] } } };
const CANCEL_NO = { status: "ok", response: { type: "cancel", data: { statuses: [{ error: "Order was never placed, already canceled, or filled. asset=0" }] } } };
const DEFAULT = { status: "ok", response: { type: "default" } };

// ---- the stand-ins ---------------------------------------------------------------------------------------------------------

type Answer = unknown;
interface Net {
  /** every request, in order: Polymarket's location check, or the library's POST to /info or /exchange with its body */
  seen: Array<{ to: "geo" | "info" | "exchange"; body: Dict }>;
  info: Record<string, Answer>;
  exchange: Answer[] | ((body: Dict) => Answer);
  geo: Answer;
}
/** what the tests use of a library instance beyond what the connection uses */
interface Lib extends HyperliquidClient {
  nonce: () => number;
  fetch: (url: string, method?: string, headers?: Record<string, string>, body?: string) => Promise<unknown>;
  handleErrors(code: number, reason: string, url: string, method: string, headers: Dict, body: string, response: unknown, requestHeaders: unknown, requestBody: unknown): unknown;
  handleHttpStatusCode(code: number, reason: string, url: string, method: string, body: string): unknown;
  markets: Record<string, Dict>;
}
const geo = (country: string, region: string, blocked = false): HttpReply => {
  const body = { blocked, ip: "203.0.113.7", country, region };
  return { status: 200, body, text: JSON.stringify(body) };
};
const IN_IE = geo("IE", "L");

const INFO: Record<string, Answer> = {
  spotMeta: { tokens: SPOT_TOKENS, universe: SPOT_PAIRS },
  spotMetaAndAssetCtxs: SPOT_META_AND_CTXS,
  metaAndAssetCtxs: (b: Dict) => (b.dex === "xyz" ? XYZ : b.dex === "flx" ? FLX : b.dex === "io" ? IO : b.dex ? NO_MARKETS : MAIN),
  perpDexs: DEXS,
  perpCategories: CATEGORIES,
  extraAgents: [{ name: "agent-account", address: AGENT.toLowerCase(), validUntil: NOW + 90 * DAY }],
  userRole: (b: Dict) => (String(b.user).toLowerCase() === AGENT.toLowerCase() ? { role: "agent", data: { user: ACCOUNT } } : { role: "user" }),
  userAbstraction: "default",
  clearinghouseState: (b: Dict) => (b.dex === "xyz" ? CH_XYZ : b.dex ? CH_EMPTY : CH),
  spotClearinghouseState: SPOT_CH,
  allMids: MIDS,
  l2Book: (b: Dict) => BOOKS[String(b.coin)],
  orderStatus: { status: "unknownOid" },
  userFillsByTime: [],
  activeAssetData: (b: Dict) => ({ user: ACCOUNT, coin: b.coin, leverage: { type: "cross", value: 3 }, maxTradeSzs: ["170.25", "194.64"], availableToTrade: ["6125.595", "7003.1472"], markPx: "107.94" }),
  candleSnapshot: CANDLES,
};

/** the library's client with its network call replaced: the answer by the body's `type` (or, at /exchange, in turn); the library reads it
 * as its own fetch does (base/Exchange.js handleRestResponse: only an object or a list is parsed, a bare JSON string comes back as text) */
function wire(c: Lib, net: Net): Lib {
  c.enableRateLimit = false;
  c.nonce = () => NOW;
  c.fetch = async (url, method = "GET", headers = {}, body = undefined) => {
    const parsed = body ? (JSON.parse(body) as Dict) : {};
    const to = url.endsWith("/exchange") ? "exchange" : "info";
    net.seen.push({ to, body: parsed });
    let a = to === "info" ? net.info[String(parsed.type)] : Array.isArray(net.exchange) ? net.exchange.shift() : net.exchange(parsed);
    if (typeof a === "function") a = (a as (b: Dict) => Answer)(parsed);
    if (a === undefined) throw new Error(`not set up in this test: ${to} ${body}`);
    if (a instanceof Error) throw a;
    const text = typeof a === "string" ? JSON.stringify(a) : JSON.stringify(a);
    const reply = a !== null && typeof a === "object" ? a : undefined;
    if (c.handleErrors(200, "", url, method, {}, text, reply, headers, body) === undefined) c.handleHttpStatusCode(200, "", url, method, text);
    return reply ?? text;
  };
  return c;
}
const opener = (net: Net): OpenHyperliquid => async (key) => wire((await openHyperliquid(key)) as Lib, net);
const geoHttp = (net: Net): Http => async (url) => {
  if (url !== GEO) throw new Error(`not set up in this test: ${url}`);
  net.seen.push({ to: "geo", body: {} });
  const a = typeof net.geo === "function" ? (net.geo as () => Answer)() : net.geo;
  if (a instanceof Error) throw a;
  return a as HttpReply;
};
const network = (over: Partial<Pick<Net, "info" | "exchange" | "geo">> = {}): Net => ({ seen: [], info: { ...INFO, ...(over.info ?? {}) }, exchange: over.exchange ?? [], geo: over.geo ?? IN_IE });

async function open(net: Net, opts: { key?: Record<string, string>; clock?: () => number } = {}) {
  const clock = opts.clock ?? (() => NOW);
  return hyperliquidTradeSource({ venue: "hyperliquid-trade", label: "", reference: "credentials/hyperliquid-trade/api-key.json", key: opts.key ?? KEY, where: locator({ http: geoHttp(net), clock }), clock, open: opener(net) });
}
async function connected(over: Partial<Pick<Net, "info" | "exchange" | "geo">> = {}, opts: { clock?: () => number } = {}): Promise<{ t: LiveTrader; source: LiveSource; first: LiveBalance[]; net: Net; connect: Net["seen"] }> {
  const net = network(over);
  const opened = await open(net, opts);
  if (isRefusal(opened)) throw new Error(`${opened.code}: ${opened.message}`);
  const connect = net.seen.splice(0);
  return { t: opened.source.trader!, source: opened.source, first: opened.first, net, connect };
}

const SECRETS = [PK, PK.slice(2)];
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
/** nothing of the place the oracle named, nor its address, in anything */
const PLACE = /203\.0\.113\.7|"(US|PA|CA|ON|IR|UA|43|IE|L|BC)"/;
const refusal = (x: unknown): Refusal => {
  if (!isRefusal(x)) throw new Error(`expected a refusal, got ${JSON.stringify(x)}`);
  for (const s of SECRETS) expect(JSON.stringify(x)).not.toContain(s);
  expect(JSON.stringify(x)).not.toMatch(PLACE);
  return x;
};
const ok = <T>(x: T | Refusal): T => {
  if (isRefusal(x)) throw new Error(`expected an answer, got ${x.code}: ${x.message}`);
  return x;
};
const types = (seen: Net["seen"]) => seen.map((s) => (s.to === "info" ? `info ${String(s.body.type)}${s.body.dex ? ` ${String(s.body.dex)}` : ""}` : s.to === "exchange" ? `exchange ${String(obj(s.body.action).type)}` : "geo"));
const obj = (v: unknown): Dict => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Dict) : {});
const posted = (seen: Net["seen"]) => seen.filter((s) => s.to === "exchange").map((s) => s.body as { action: Dict; nonce: number; signature: { r: string; s: string; v: number }; vaultAddress?: string });
const order = (o: Partial<OrderRequest> = {}): OrderRequest => ({ symbol: "BTC/USDC:USDC", side: "buy", type: "limit", qty: 0.001, limitPrice: 80000, clientId: CLIENT, ...o });

// ---- Hyperliquid's signature, worked out here without the library -------------------------------------------------------------

/** msgpack, as Hyperliquid's own SDK packs an action: maps in their keys' order, the smallest form of each integer, str for strings */
function msgpack(v: unknown): number[] {
  const be = (x: number | bigint, bytes: number): number[] => {
    let n = BigInt(x);
    const out: number[] = [];
    for (let i = 0; i < bytes; i++) {
      out.unshift(Number(n & 0xffn));
      n >>= 8n;
    }
    return out;
  };
  if (v === null || v === undefined) return [0xc0];
  if (v === true) return [0xc3];
  if (v === false) return [0xc2];
  if (typeof v === "number") {
    if (!Number.isInteger(v) || v < 0) throw new Error(`no such number in an action: ${v}`);
    return v < 0x80 ? [v] : v < 0x100 ? [0xcc, v] : v < 0x10000 ? [0xcd, ...be(v, 2)] : v < 0x100000000 ? [0xce, ...be(v, 4)] : [0xcf, ...be(v, 8)];
  }
  if (typeof v === "string") {
    const b = [...new TextEncoder().encode(v)];
    return [...(b.length < 32 ? [0xa0 | b.length] : b.length < 0x100 ? [0xd9, b.length] : [0xda, ...be(b.length, 2)]), ...b];
  }
  if (Array.isArray(v)) return [...(v.length < 16 ? [0x90 | v.length] : [0xdc, ...be(v.length, 2)]), ...v.flatMap(msgpack)];
  const entries = Object.entries(v as Dict);
  return [...(entries.length < 16 ? [0x80 | entries.length] : [0xde, ...be(entries.length, 2)]), ...entries.flatMap(([k, x]) => [...msgpack(k), ...msgpack(x)])];
}
/** who signed a posted action: msgpack(action) ‖ nonce (8 bytes) ‖ 0x00 (no vault), keccak-256, as the connectionId of the phantom agent
 * {source: "a"} in the domain Exchange · 1 · 1337 · the zero address */
async function signerOf(p: { action: Dict; nonce: number; signature: { r: string; s: string; v: number } }): Promise<string> {
  const n = BigInt(p.nonce);
  const nonce = Array.from({ length: 8 }, (_, i) => Number((n >> BigInt(8 * (7 - i))) & 0xffn));
  const connectionId = keccak256(new Uint8Array([...msgpack(p.action), ...nonce, 0x00]));
  const signature = `0x${p.signature.r.replace(/^0x/, "").padStart(64, "0")}${p.signature.s.replace(/^0x/, "").padStart(64, "0")}${p.signature.v.toString(16)}` as Hex;
  return recoverTypedDataAddress({ domain: { name: "Exchange", version: "1", chainId: 1337, verifyingContract: "0x0000000000000000000000000000000000000000" }, types: { Agent: [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }] }, primaryType: "Agent", message: { source: "a", connectionId }, signature });
}

// ---- Hyperliquid's own line, for this user where they are now ---------------------------------------------------------------------

describe("Hyperliquid's own line (its Terms of Use §1.6), held to where this user is now", () => {
  it("the United States, Ontario and a sanctioned territory are closed; elsewhere is served; a place not known is not served — and Polymarket's own verdict is not the rule", async () => {
    const verdict = async (a: Answer) => locator({ http: geoHttp(network({ geo: a })), clock: () => NOW }).verdict(HYPERLIQUID_RULE);
    expect(await verdict(geo("US", "PA", true))).toBe("closed");
    expect(await verdict(geo("CA", "ON"))).toBe("closed");
    expect(await verdict(geo("CA", "BC"))).toBe("served");
    expect(await verdict(geo("IR", ""))).toBe("closed");
    expect(await verdict(geo("UA", "43"))).toBe("closed");
    expect(await verdict(geo("UA", "30"))).toBe("served");
    // blocked by Polymarket in Ireland: Polymarket's rule, not Hyperliquid's
    expect(await verdict(geo("IE", "L", true))).toBe("served");
    for (const unknown of [{ status: 200, body: { blocked: false }, text: '{"blocked":false}' }, { status: 502, body: undefined, text: "bad gateway" }, new Error("ETIMEDOUT"), { status: 200, body: { country: "USA" }, text: "" }]) expect(await verdict(unknown)).toBe("unknown");
    // the lists are one rule, shared with the mm perps path (metamask.ts)
    expect([...HL_CLOSED.countries]).toEqual(["US", "AS", "GU", "MP", "PR", "UM", "VI", "CU", "IR", "KP", "SY"]);
    // a US territory is the United States here however a source spells it
    expect([await verdict(geo("PR", "")), await verdict(geo("US", "PR")), await verdict(geo("US", "US-GU"))]).toEqual(["closed", "closed", "closed"]);
    expect(HL_TERMS).toContain("Terms of Use §1.6");
  });

  it("refused in Hyperliquid's terms' words, before anything about the account is asked; the place, the country and the address never leave", async () => {
    for (const place of [geo("US", "PA", true), geo("CA", "ON"), geo("IR", "")]) {
      const net = network({ geo: place });
      const r = refusal(await open(net));
      expect(r.code).toBe("E_VENUE_GEOBLOCKED");
      expect(r.message).toBe("Hyperliquid does not serve this location: its Terms of Use (§1.6) make its Interface unavailable to persons located in the United States of America or Ontario, Canada, or in a territory under economic sanctions. That is its own rule, and the account does not look for a way around it. Nothing was connected");
      expect(r.native).toEqual({ rule: HL_TERMS });
      expect(types(net.seen)).toEqual(["geo"]);
    }
    const net = network({ geo: new Error("ETIMEDOUT") });
    const r = refusal(await open(net));
    expect(r.code).toBe("E_VENUE_UNREACHABLE");
    expect(r.message).toContain("could not be held to it: nothing was connected");
    expect(types(net.seen)).toEqual(["geo"]);
  });

  it("every order and leverage change asks first; taking an order off does not; a write asks the place again (one asked in the last few seconds is used — ip-audit-c covers a move inside the ten minutes)", async () => {
    let now = NOW;
    const { t, net } = await connected({ exchange: [RESTING, RESTING, CANCELED, DEFAULT, RESTING] }, { clock: () => now });
    // the connection asked a moment ago: the place is used
    ok(await t.place(order()));
    expect(types(net.seen).filter((x) => x === "geo")).toEqual([]);
    now += PLACE_MS + 1;
    net.seen.splice(0);
    ok(await t.place(order({ clientId: "1".repeat(32) })));
    // ten minutes on, the market list is read again too; the place is asked before the order is signed
    expect(types(net.seen)).toContain("geo");
    expect(types(net.seen).indexOf("geo")).toBeLessThan(types(net.seen).indexOf("exchange order"));
    net.seen.splice(0);
    await t.cancel("77738308", "BTC/USDC:USDC");
    expect(types(net.seen)).not.toContain("geo");
    // moved since: closed now, so nothing is signed — neither an order nor a leverage change; a cancel still goes
    now += PLACE_MS + 1;
    net.geo = geo("US", "NY", true);
    net.seen.splice(0);
    const no = refusal(await t.place(order({ clientId: "2".repeat(32) })));
    expect([no.code, no.message]).toEqual(["E_VENUE_GEOBLOCKED", `${HYPERLIQUID_RULE.closedWords}. Nothing was sent to Hyperliquid (buy 0.001 BTC/USDC:USDC)`]);
    expect(refusal(await t.setLeverage!("BTC/USDC:USDC", 2, "cross")).code).toBe("E_VENUE_GEOBLOCKED");
    expect(posted(net.seen)).toEqual([]);
    // where the place cannot be learned, nothing is sent either
    now += PLACE_MS + 1;
    net.geo = { status: 503, body: undefined, text: "" };
    expect(refusal(await t.place(order({ clientId: "3".repeat(32) }))).code).toBe("E_VENUE_UNREACHABLE");
    expect(posted(net.seen)).toEqual([]);
  });

  it("heldTo says what was not sent, and nothing of the place", async () => {
    const where = locator({ http: geoHttp(network({ geo: geo("CA", "ON") })), clock: () => NOW });
    const r = refusal(await heldTo(HYPERLIQUID_RULE, where, "hyperliquid-trade", "sell 1 ETH/USDC:USDC"));
    expect(r.message.endsWith("Nothing was sent to Hyperliquid (sell 1 ETH/USDC:USDC)")).toBe(true);
    expect(await heldTo(HYPERLIQUID_RULE, locator({ http: geoHttp(network()), clock: () => NOW }), "hyperliquid-trade", "x")).toBeUndefined();
  });
});

// ---- the connection --------------------------------------------------------------------------------------------------------------

describe("Hyperliquid's trading connection: an API wallet for the account", () => {
  it("asks in order — the location, the API wallet's approval (extraAgents), the account's own balances — and signs nothing", async () => {
    const { source, first, connect } = await connected();
    const asked = types(connect);
    expect(asked.slice(0, 3)).toEqual(["geo", "info extraAgents", "info userAbstraction"]);
    expect(asked).toEqual(expect.arrayContaining(["info clearinghouseState", "info spotClearinghouseState", "info allMids", "info clearinghouseState xyz", "info clearinghouseState flx"]));
    expect(asked.filter((x) => x.startsWith("exchange"))).toEqual([]);
    // every read names the account's own address, never the API wallet's
    for (const s of connect.filter((x) => x.to === "info" && x.body.user !== undefined)) expect(s.body.user).toBe(ACCOUNT.toLowerCase());
    expect(first).toEqual<LiveBalance[]>([
      { asset: "USDC", amount: 3656.784576, usd: 3656.784576, where: "perps · 1.72 withdrawable", class: "stable" },
      { asset: "USDC", amount: 500.25, usd: 500.25, where: "spot", class: "stable" },
      { asset: "HYPE", amount: 2.5, usd: 210.20125, where: "spot" },
      { asset: "BTC", amount: 0.01, usd: 815.075, where: "spot · UBTC on Hyperliquid" },
      { asset: "USDC", amount: 250, usd: 250, where: "perps · XYZ (HIP-3) · 200.00 withdrawable", class: "stable" },
    ]);
    expect(source.kind).toBe("perp");
    // the account is the owner's because it approved this API wallet: no watched address goes with it
    expect(source.address).toBeUndefined();
    expect(source.probe.can).toEqual(["trade"]);
    expect(source.probe.note).toContain(`an API wallet (“agent-account”) approved for ${getAddress(ACCOUNT)}, until 2027-01-06: it signs orders, cancels and leverage changes for the account, and Hyperliquid takes no withdrawal or transfer signed by it`);
    expect(source.writer).toBeUndefined();
    expect(source.readOnlyBecause).toContain("only on the account's own signature");
    expect([source.trader!.can, source.trader!.what, source.trader!.kinds]).toEqual([true, "spot and perpetuals", ["spot", "perp"]]);
    expect(JSON.stringify({ source, first })).not.toContain(PK.slice(2));
    expect(JSON.stringify({ source, first })).not.toMatch(PLACE);
  });

  it("a unified account: its spot balances are the whole account, and no perps or HIP-3 figure is added to them", async () => {
    const { first, connect } = await connected({ info: { userAbstraction: "unifiedAccount", spotClearinghouseState: SPOT_UNIFIED } });
    expect(first).toEqual([
      { asset: "USDC", amount: 9685.51736653, usd: 9685.51736653, where: "spot and perps · unified account", class: "stable" },
      { asset: "HYPE", amount: 0.00836466, usd: 0.7033048, where: "spot and perps · unified account" },
    ]);
    expect(types(connect)).not.toContain("info clearinghouseState xyz");
  });

  it("the API wallet: approved and named (with its end); not approved, said with how to approve one; past its end; unnamed (userRole answers for it); approved for another account", async () => {
    const missing = network({ info: { extraAgents: [{ name: "bot", address: OTHER, validUntil: NOW + DAY }], userRole: { role: "user" } } });
    const no = refusal(await open(missing));
    expect(no.code).toBe("E_VENUE_UNAUTHORIZED");
    expect(no.message).toContain(`Hyperliquid has not approved this API wallet (${short(AGENT)}) for ${short(getAddress(ACCOUNT))}`);
    expect(no.message).toContain("its API wallets are “bot”");
    expect(no.message).toContain("More → API): name an API wallet, Generate, then Authorize API Wallet");
    expect(no.message).toContain("at most 180 days");
    expect(types(missing.seen).filter((x) => x.startsWith("info clearinghouse"))).toEqual([]);
    const expired = refusal(await open(network({ info: { extraAgents: [{ name: "old", address: AGENT.toLowerCase(), validUntil: NOW - DAY }] } })));
    expect(expired.code).toBe("E_VENUE_UNAUTHORIZED");
    expect(expired.message).toContain("Hyperliquid's approval of this API wallet (“old”) ended on 2026-10-07: an API wallet is approved for at most 180 days. Make one at https://app.hyperliquid.xyz/API");
    // not among the named: Hyperliquid says whose agent it is
    const unnamed = await connected({ info: { extraAgents: [] } });
    expect(unnamed.source.probe.note).toContain("unnamed: Hyperliquid reports no end for it");
    expect(types(unnamed.connect).slice(0, 3)).toEqual(["geo", "info extraAgents", "info userRole"]);
    expect(unnamed.connect[2]!.body.user).toBe(AGENT.toLowerCase());
    const elsewhere = refusal(await open(network({ info: { extraAgents: [], userRole: { role: "agent", data: { user: OTHER } } } })));
    expect([elsewhere.code, elsewhere.message]).toEqual(["E_VENUE_UNAUTHORIZED", expect.stringContaining("is approved for another Hyperliquid account (0x0000…b0b0)")]);
    // the account's address is an API wallet's own
    const wrong = refusal(await open(network({ info: { extraAgents: [], userRole: (b: Dict) => (b.user === ACCOUNT.toLowerCase() ? { role: "agent", data: { user: OTHER } } : { role: "missing" }) } })));
    expect([wrong.code, wrong.detail]).toEqual(["E_ACCOUNT_CREDENTIAL", { field: "walletAddress" }]);
    // the read Hyperliquid's app uses not answering is not a no: userRole still says
    expect((await connected({ info: { extraAgents: new ccxt.ExchangeError('hyperliquid {"status":"err","response":"Failed to deserialize"}') } })).source.probe.can).toEqual(["trade"]);
  });

  it("the key file: an address and an API wallet's key — never the account's own key; field names said, never a value", async () => {
    const bad = async (key: Record<string, string>) => refusal(await open(network(), { key }));
    const notAddress = await bad({ walletAddress: "0x1234", privateKey: PK });
    expect([notAddress.code, notAddress.detail]).toEqual(["E_ACCOUNT_CREDENTIAL", { field: "walletAddress" }]);
    const notKey = await bad({ walletAddress: ACCOUNT, privateKey: "0xnot-a-key-at-all-but-long-enough-to-be-one" });
    expect([notKey.code, notKey.detail]).toEqual(["E_ACCOUNT_CREDENTIAL", { field: "privateKey" }]);
    expect(notKey.message).not.toContain("not-a-key");
    // the account's own key could withdraw: refused before anything is asked
    const own = generatePrivateKey();
    const net = network();
    const self = refusal(await open(net, { key: { walletAddress: privateKeyToAccount(own).address, privateKey: own } }));
    expect(self.code).toBe("E_ACCOUNT_CREDENTIAL");
    expect(self.message).toContain("the key file holds the account's own private key, which could withdraw: this connection takes only an API wallet's key, which cannot");
    expect(JSON.stringify(self)).not.toContain(own.slice(2));
    expect(net.seen).toEqual([]);
  });

  const home = mkdtempSync(join(tmpdir(), "hl-trade-"));
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it("through the account's own connector table: live:hyperliquid-trade reads credentials/hyperliquid-trade/api-key.json and carries a trader", async () => {
    mkdirSync(join(home, "credentials/hyperliquid-trade"), { recursive: true });
    const file = join(home, "credentials/hyperliquid-trade/api-key.json");
    writeFileSync(file, JSON.stringify(KEY));
    chmodSync(file, 0o600);
    expect(KEY_SHAPES["hyperliquid-trade"]!.required).toEqual(["walletAddress", "privateKey"]);
    expect(keyFileStatus(home, "hyperliquid-trade", "hyperliquid-trade", "")).toMatchObject({ ready: true, fields: ["walletAddress", "privateKey"] });
    // what the page and an agent are offered to connect (portfolio_account `connectable`)
    expect(liveOptions(home).options.find((o) => o.kind === "hyperliquid-trade")).toMatchObject({ connector: "live:hyperliquid-trade", label: "Hyperliquid · trading, with an API wallet that cannot withdraw", needs: "key-file", venues: ["hyperliquid"] });
    const net = network();
    const deps = { home, http: geoHttp(net), clock: () => NOW, openHyperliquid: opener(net), proofs: {}, price: async () => undefined, mm: async () => ({}) } as unknown as LiveDeps;
    const opened = await openLive({ venue: "hyperliquid-trade", connector: "live:hyperliquid-trade", label: "", reference: "" }, deps);
    if (isRefusal(opened)) throw new Error(opened.message);
    expect(opened.summary).toContain("the venue says this credential can trade");
    expect(opened.source.reference).toBe("credentials/hyperliquid-trade/api-key.json");
    expect(opened.price).toBeDefined();
    expect(types(net.seen)[0]).toBe("geo");
    expect(JSON.stringify(opened.source)).not.toContain(PK.slice(2));
  });
});

// ---- markets ---------------------------------------------------------------------------------------------------------------------

describe("the markets, as the library loads them", () => {
  it("perpetuals of the main DEX and of HIP-3 DEXs margined in dollars, and spot quoted in dollars, busiest first; a USDH DEX and a delisted market are not offered", async () => {
    const { t } = await connected();
    const list = ok(await t.markets(""));
    expect(list.map((m) => m.symbol)).toEqual(["BTC/USDC:USDC", "ETH/USDC:USDC", "XYZ-XYZ100/USDC:USDC", "SOL/USDC:USDC", "XYZ-NVDA/USDC:USDC", "XYZ-GOLD/USDC:USDC", "XYZ-TSLA/USDC:USDC", "XYZ-HOOD/USDC:USDC", "IO-ANTH/USDC:USDC", "IO-OAI/USDC:USDC", "ATOM/USDC:USDC", "DYDX/USDC:USDC", "HYPE/USDC", "BTC/USDC", "PURR/USDC", "USDT/USDC"]);
    const nvda = list.find((m) => m.symbol === "XYZ-NVDA/USDC:USDC")!;
    expect(nvda).toMatchObject({ name: "NVDA perpetual on XYZ (HIP-3, xyz:NVDA)", kind: "perp", base: "NVDA", quote: "USDC", qtyStep: 0.001, priceStep: 0.01, minNotional: 10, contractSize: 1, open: true, types: ["market", "limit"], tifs: ["gtc", "ioc"], tifsByType: { market: ["ioc"] }, postOnly: true, reduceOnly: true, maxLeverage: 20, marginModes: ["cross", "isolated"] });
    expect(nvda.note).toContain("margined in USDC in that DEX's own perps balance");
    expect(list.find((m) => m.symbol === "XYZ-HOOD/USDC:USDC")!.marginModes).toEqual(["isolated"]);
    const btc = list.find((m) => m.symbol === "BTC/USDC")!;
    expect(btc).toMatchObject({ name: "BTC/USDC spot (UBTC)", kind: "spot", base: "BTC", sellsReduce: true, qtyStep: 0.00001, priceStep: 1 });
    expect(btc.reduceOnly).toBeUndefined();
    expect(btc.note).toContain("UBTC is the token Hyperliquid trades as BTC");
    // a HIP-3 pre-IPO perpetual (Hyperliquid files io:ANTH under "preipo", and Anthropic is a company live/preipo.ts knows): grouped with the
    // other venues' Anthropic contracts; a stock filed under "stocks" is not one
    const anth = list.find((m) => m.symbol === "IO-ANTH/USDC:USDC")!;
    expect(anth).toMatchObject({ name: "ANTH perpetual on EntropyIO (HIP-3, io:ANTH)", base: "ANTH", category: "Pre-IPO", group: { id: "preipo:anthropic", title: "Anthropic" }, implied: { perPoint: 1_000_000_000 }, marginModes: ["isolated"], maxLeverage: 6 });
    expect(nvda.category).toBeUndefined();
    // a search, and Hyperliquid's own names for a market
    expect(ok(await t.markets("nvda")).map((m) => m.symbol)).toEqual(["XYZ-NVDA/USDC:USDC"]);
    expect(ok(await t.markets("io:ANTH-PERP"))[0]!.symbol).toBe("IO-ANTH/USDC:USDC");
    expect(ok(await t.markets("xyz:GOLD"))[0]!.symbol).toBe("XYZ-GOLD/USDC:USDC");
    expect(ok(await t.markets("@107"))[0]!.symbol).toBe("HYPE/USDC");
    expect(ok(await t.markets("BTC-PERP"))[0]!.symbol).toBe("BTC/USDC:USDC");
    // what is not traded here, and why
    expect(refusal(await t.market("FLX-TSLA/USDH:USDH")).code).toBe("E_ACCOUNT_UNPRICED");
    expect(refusal(await t.market("DOGE/USDC:USDC")).code).toBe("E_VENUE_REJECTED");
    expect(refusal(await t.place(order({ symbol: "MATIC/USDC:USDC", qty: 100, limitPrice: 0.4 }))).code).toBe("E_VENUE_MARKET_CLOSED");
  });

  it("one market: the best bid and ask from Hyperliquid's book, the day and the hourly funding from its asset context, the price grid from the price now", async () => {
    const { t, net } = await connected();
    net.seen.splice(0);
    const m = ok(await t.market("BTC-PERP"));
    expect(m).toMatchObject<Partial<Market>>({ symbol: "BTC/USDC:USDC", name: "BTC/USDC perpetual", bid: 81359, ask: 81360, price: 81359.5, priceStep: 1, changePct24h: -2.3776, change24h: -1981.5, volumeUsd24h: 3341631875.3607402, fundingRate: 0.0000125, nextFundingAt: "2026-10-08T19:00:00.000Z", maxLeverage: 40, minNotional: 10 });
    expect(types(net.seen)).toEqual(["info l2Book", "info metaAndAssetCtxs"]);
    expect(net.seen[0]!.body.coin).toBe("BTC");
    // a pre-IPO perpetual carries the valuation its price implies now, in its venue's unit
    expect(ok(await t.market("io:ANTH-PERP"))).toMatchObject({ symbol: "IO-ANTH/USDC:USDC", price: 2051.05, implied: { perPoint: 1_000_000_000, usd: 2_051_050_000_000 } });
    const hype = ok(await t.market("HYPE/USDC"));
    expect(hype).toMatchObject({ bid: 83.847, ask: 83.848, price: 83.8475, priceStep: 0.001 });
    expect(hype.fundingRate).toBeUndefined();
    expect(net.seen.find((s) => s.body.type === "l2Book" && s.body.coin === "@107")).toBeDefined();
    // the asset contexts are kept fifteen seconds: a second look at the same DEX asks only its book
    net.seen.splice(0);
    expect(ok(await t.market("ETH/USDC:USDC"))).toMatchObject({ price: 2444.35, priceStep: 0.1, fundingRate: 0.000010176 });
    expect(types(net.seen)).toEqual(["info l2Book"]);
  });
});

// ---- an order, signed by the API wallet --------------------------------------------------------------------------------------------

describe("an order, signed by the API wallet", () => {
  it("a limit buy: the order action posted to /exchange — asset, side, price, size, reduce-only, tif, the account's id — signed by the API wallet, the nonce the clock; then what became of it", async () => {
    const { t, net } = await connected({ exchange: [RESTING], info: { orderStatus: (b: Dict) => (b.oid === 77738308 ? status(77738308, "open") : { status: "unknownOid" }) } });
    const s = ok(await t.place(order()));
    const [p] = posted(net.seen);
    expect(p!.action).toEqual({ type: "order", orders: [{ a: 0, b: true, p: "80000", s: "0.001", r: false, t: { limit: { tif: "Gtc" } }, c: `0x${CLIENT}` }], grouping: "na" });
    expect(p!.nonce).toBe(NOW);
    expect(p!.vaultAddress).toBeUndefined();
    expect(await signerOf(p!)).toBe(AGENT);
    expect([s.ref, s.status, s.filledQty]).toEqual(["77738308", "open", 0]);
    expect(s.native).toMatchObject({ oid: "77738308", status: "open", cloid: `0x${CLIENT}`, asset: 0 });
    expect(types(net.seen)).toEqual(["exchange order", "info orderStatus"]);
  });

  it("a market order is Hyperliquid's: an IOC limit at the worst price, moved inside onto Hyperliquid's grid — a buy's down, a sell's up; with none given, 2% past the book", async () => {
    const { t, net } = await connected({ exchange: [FILLED("0.01", "2425.7"), FILLED("0.3", "83.85", 91), FILLED("1.0", "231.04", 92), RESTING], info: { userFillsByTime: [fill(77747314, "ETH", "2425.7", "0.01", "0.010915", "A"), fill(91, "@107", "83.85", "0.3", "0.017609")] } });
    // a sell of ETH, its worst price 2378.123: up to the 0.1 grid
    const sell = ok(await t.place(order({ symbol: "ETH/USDC:USDC", side: "sell", type: "market", qty: 0.01, limitPrice: undefined, worstPrice: 2378.123 })));
    // a buy of HYPE spot with no worst price: the ask 83.848 and 2%, down to the 0.001 grid
    const buy = ok(await t.place(order({ symbol: "HYPE/USDC", type: "market", qty: 0.5, limitPrice: undefined, clientId: "a".repeat(32) })));
    // closing an NVDA short: reduce-only, at its HIP-3 asset id
    ok(await t.place(order({ symbol: "XYZ-NVDA/USDC:USDC", type: "market", qty: 1, limitPrice: undefined, worstPrice: 235.678, reduceOnly: true, clientId: "b".repeat(32) })));
    // post-only: Hyperliquid's Alo
    ok(await t.place(order({ side: "sell", limitPrice: 82000, postOnly: true, clientId: "c".repeat(32) })));
    const orders = posted(net.seen).map((p) => (p.action.orders as Dict[])[0]);
    expect(orders).toEqual([
      { a: 1, b: false, p: "2378.2", s: "0.01", r: false, t: { limit: { tif: "Ioc" } }, c: `0x${CLIENT}` },
      { a: 10107, b: true, p: "85.524", s: "0.5", r: false, t: { limit: { tif: "Ioc" } }, c: `0x${"a".repeat(32)}` },
      { a: 110002, b: true, p: "235.67", s: "1", r: true, t: { limit: { tif: "Ioc" } }, c: `0x${"b".repeat(32)}` },
      { a: 0, b: false, p: "82000", s: "0.001", r: false, t: { limit: { tif: "Alo" } }, c: `0x${"c".repeat(32)}` },
    ]);
    // each signed by the API wallet, each nonce higher than the last
    for (const p of posted(net.seen)) expect(await signerOf(p)).toBe(AGENT);
    expect(posted(net.seen).map((p) => p.nonce)).toEqual([NOW, NOW + 1, NOW + 2, NOW + 3]);
    // filled at once, with Hyperliquid's average and its fee from the order's own fills; an IOC that filled in part is done
    expect([sell.status, sell.filledQty, sell.avgPrice, sell.feeUsd]).toEqual(["filled", 0.01, 2425.7, 0.010915]);
    expect([buy.status, buy.filledQty, buy.avgPrice, buy.feeUsd]).toEqual(["canceled", 0.3, 83.85, 0.017609]);
    expect((buy.native as Dict).sentAs).toContain("a limit order at 85.524 that fills at once (IOC)");
  });

  it("nothing done unasked: the library as shipped approves its own builder fee and sets a referrer on the account the first time it signs; this connection's client sends only the order", async () => {
    const net = network({ exchange: (b: Dict) => (obj(b.action).type === "order" ? RESTING : DEFAULT) });
    const shipped = wire(new (ccxt as unknown as { hyperliquid: new (c: Dict) => Lib }).hyperliquid({ walletAddress: ACCOUNT, privateKey: PK }), net);
    await shipped.createOrder("BTC/USDC:USDC", "limit", "buy", 0.001, 80000);
    const actions = posted(net.seen).map((p) => p.action);
    expect(actions.map((a) => a.type)).toEqual(expect.arrayContaining(["approveBuilderFee", "setReferrer", "order"]));
    expect(actions.find((a) => a.type === "order")!.builder).toBeDefined();
    // the connection's own
    const { t, net: mine } = await connected({ exchange: [RESTING] });
    ok(await t.place(order()));
    const sent = posted(mine.seen).map((p) => p.action);
    expect(sent.map((a) => a.type)).toEqual(["order"]);
    expect(sent[0]!.builder).toBeUndefined();
  });

  it("refused before anything is sent — the location check included: off the size step, six significant figures, under $10, a stop, fill-or-kill, reduce-only on spot, post-only with ioc", async () => {
    const { t, net } = await connected();
    const no = async (o: Partial<OrderRequest>) => refusal(await t.place(order(o)));
    expect((await no({ qty: 0.000015 })).message).toBe("Hyperliquid: a size in BTC/USDC perpetual moves in steps of 0.00001 (its szDecimals is 5)");
    expect((await no({ limitPrice: 81359.5 })).message).toBe("Hyperliquid: a price in BTC/USDC perpetual has at most five significant figures and 1 decimal (a whole number always passes): 81359.5 is not one");
    expect((await no({ qty: 0.0001 })).message).toBe("Hyperliquid: the smallest order Hyperliquid takes is worth $10 (“Order must have minimum value of $10”): 0.0001 at 80000 is $8.00");
    for (const o of [{ type: "stop" as const, stopPrice: 82000, limitPrice: undefined }, { tif: "fok" as const }, { tif: "day" as const }, { symbol: "HYPE/USDC", qty: 1, limitPrice: 80, reduceOnly: true }, { postOnly: true, tif: "ioc" as const }, { type: "market" as const }, { worstPrice: 81000 }]) expect((await no(o)).code).toBe("E_VENUE_ORDER_INVALID");
    expect(net.seen).toEqual([]);
  });

  it("Hyperliquid's answers in its own words: the $10 minimum, not enough margin, an IOC that found nothing, an API wallet it no longer knows", async () => {
    const { t, net } = await connected({
      exchange: [ORDER_NO("Order must have minimum value of $10. asset=0"), ORDER_NO("Insufficient margin to place order. asset=0"), ORDER_NO("Order could not immediately match against any resting orders. asset=0"), { status: "err", response: `User or API Wallet ${AGENT.toLowerCase()} does not exist.` }],
    });
    // a reduce-only close below $10 is Hyperliquid's to judge
    const small = refusal(await t.place(order({ qty: 0.0001, reduceOnly: true })));
    expect([small.code, small.message, (small.native as Dict).said]).toEqual(["E_VENUE_ORDER_INVALID", "Hyperliquid: Order must have minimum value of $10.", "Order must have minimum value of $10. asset=0"]);
    expect(refusal(await t.place(order({ clientId: "1".repeat(32) })))).toMatchObject({ code: "E_VENUE_INSUFFICIENT", message: "Hyperliquid: Insufficient margin to place order." });
    expect(refusal(await t.place(order({ type: "market", limitPrice: undefined, worstPrice: 81400, clientId: "2".repeat(32) })))).toMatchObject({ code: "E_VENUE_REJECTED", message: "Hyperliquid: Order could not immediately match against any resting orders. Nothing was filled" });
    const gone = refusal(await t.place(order({ clientId: "3".repeat(32) })));
    expect(gone.code).toBe("E_VENUE_UNAUTHORIZED");
    expect(gone.message).toContain("does not exist. — the API wallet is not, or is no longer, approved for this account");
    expect(posted(net.seen)).toHaveLength(4);
  });

  it("an order call that does not come back: Hyperliquid is asked for it under the account's id before anything is said — there, or not there", async () => {
    const lost = () => new ccxt.RequestTimeout("hyperliquid POST https://api.hyperliquid.xyz/exchange request timed out (12000 ms)");
    const { t, net } = await connected({ exchange: [lost(), lost()], info: { orderStatus: (b: Dict) => (b.oid === `0x${CLIENT}` ? status(5150, "open") : { status: "unknownOid" }) } });
    const found = ok(await t.place(order()));
    expect([found.ref, found.status, (found.native as Dict).cloid]).toEqual(["5150", "open", `0x${CLIENT}`]);
    expect(net.seen.at(-1)!.body).toMatchObject({ type: "orderStatus", oid: `0x${CLIENT}`, user: ACCOUNT.toLowerCase() });
    const none = refusal(await t.place(order({ clientId: "e".repeat(32) })));
    expect([none.code, none.message]).toEqual(["E_VENUE_UNREACHABLE", `Hyperliquid did not confirm the order, and shows none under the account's id 0x${"e".repeat(32)} now: look at its open orders before placing it again`]);
  });
});

// ---- what became of an order, cancel, positions, leverage --------------------------------------------------------------------------

describe("what became of an order, and taking it off", () => {
  it("orderStatus in the account's words: open, partly filled, filled (its price and fee from the fills), canceled and rejected of every kind; an id Hyperliquid does not have", async () => {
    const answers: Record<number, Dict> = { 1: status(1, "open"), 2: status(2, "open", { sz: "0.0004" }), 3: status(3, "filled", { sz: "0.0" }), 4: status(4, "marginCanceled", { sz: "0.0007" }), 5: status(5, "perpMarginRejected"), 6: status(6, "triggered") };
    const { t } = await connected({ info: { orderStatus: (b: Dict) => answers[Number(b.oid)] ?? { status: "unknownOid" }, userFillsByTime: [fill(2, "BTC", "79990.0", "0.0006", "0.021597"), fill(3, "BTC", "80000.0", "0.0006", "0.0216"), fill(3, "BTC", "79990.0", "0.0004", "0.014398"), fill(4, "BTC", "80000.0", "0.0003", "0.0108")] } });
    const st = async (ref: string) => ok(await t.status(ref, "BTC/USDC:USDC"));
    expect([(await st("1")).status, (await st("1")).filledQty]).toEqual(["open", 0]);
    expect(await st("2")).toMatchObject<Partial<OrderState>>({ status: "partial", filledQty: 0.0006, avgPrice: 79990, feeUsd: 0.021597 });
    expect(await st("3")).toMatchObject<Partial<OrderState>>({ status: "filled", filledQty: 0.001, avgPrice: 79996, feeUsd: 0.035998 });
    expect(await st("4")).toMatchObject<Partial<OrderState>>({ status: "canceled", filledQty: 0.0003 });
    expect(((await st("4")).native as Dict).status).toBe("marginCanceled");
    expect((await st("5")).status).toBe("rejected");
    expect((await st("6")).status).toBe("open");
    expect(refusal(await t.status("7", "BTC/USDC:USDC")).code).toBe("E_ACCOUNT_ORDER_UNKNOWN");
    expect(refusal(await t.status("0xabc", "BTC/USDC:USDC")).code).toBe("E_ACCOUNT_ORDER_UNKNOWN");
  });

  it("cancel: the cancel action, signed by the API wallet, then the order as it stands; filled already is said as filled; never placed is unknown", async () => {
    let word = "open";
    const { t, net } = await connected({ exchange: [CANCELED, CANCEL_NO, CANCEL_NO], info: { orderStatus: (b: Dict) => (b.oid === 77738308 ? status(77738308, word, word === "filled" ? { sz: "0.0" } : {}) : { status: "unknownOid" }) } });
    word = "canceled";
    const c = ok(await t.cancel("77738308", "BTC/USDC:USDC"));
    const [p] = posted(net.seen);
    expect(p!.action).toEqual({ type: "cancel", cancels: [{ a: 0, o: 77738308 }] });
    expect(await signerOf(p!)).toBe(AGENT);
    expect([c.status, c.filledQty]).toEqual(["canceled", 0]);
    word = "filled";
    expect(ok(await t.cancel("77738308", "BTC/USDC:USDC")).status).toBe("filled");
    expect(refusal(await t.cancel("424242", "BTC/USDC:USDC")).code).toBe("E_ACCOUNT_ORDER_UNKNOWN");
    expect(types(net.seen)).not.toContain("geo");
  });
});

describe("positions and leverage", () => {
  it("positions: the main DEX's and each dollar-margined HIP-3 DEX's clearinghouseState, for the account's own address, in the account's words", async () => {
    const { t, net } = await connected();
    net.seen.splice(0);
    const list = ok(await t.positions!());
    expect(types(net.seen)).toEqual(["info clearinghouseState", "info clearinghouseState xyz", "info clearinghouseState io"]);
    expect(list).toEqual<Position[]>([
      { symbol: "BTC/USDC:USDC", name: "BTC/USDC perpetual", kind: "perp", side: "long", qty: 0.03973, entryPrice: 82980.4, markPrice: 80929, usd: 3215.30917, unrealizedUsd: -81.5029, leverage: 3, marginMode: "cross", liquidationPrice: undefined, native: expect.objectContaining({ coin: "BTC", szi: "0.03973", liquidationPx: null }) as unknown },
      { symbol: "SOL/USDC:USDC", name: "SOL/USDC perpetual", kind: "perp", side: "long", qty: 13.05, entryPrice: 114.8627, markPrice: 106.76, usd: 1393.218, unrealizedUsd: -105.7408, leverage: 3, marginMode: "isolated", liquidationPrice: 78.6416169761, native: expect.objectContaining({ coin: "SOL" }) as unknown },
      { symbol: "XYZ-NVDA/USDC:USDC", name: "NVDA perpetual on XYZ (HIP-3, xyz:NVDA)", kind: "perp", side: "short", qty: 1, entryPrice: 235, markPrice: 231.11, usd: 231.11, unrealizedUsd: 3.89, leverage: 5, marginMode: "isolated", liquidationPrice: 270.5, native: expect.objectContaining({ coin: "xyz:NVDA", szi: "-1.0" }) as unknown },
    ]);
  });

  it("leverage: updateLeverage {asset, isCross, leverage}, signed by the API wallet; the margin mode the account uses there stays when none is asked; isolated-only, the most, spot", async () => {
    const { t, net } = await connected({ exchange: [DEFAULT, DEFAULT, DEFAULT] });
    expect(ok(await t.setLeverage!("BTC/USDC:USDC", 5))).toMatchObject({ leverage: 5, marginMode: "cross" });
    expect(ok(await t.setLeverage!("SOL/USDC:USDC", 3, "isolated"))).toMatchObject({ leverage: 3, marginMode: "isolated" });
    expect(ok(await t.setLeverage!("XYZ-HOOD/USDC:USDC", 2))).toMatchObject({ leverage: 2, marginMode: "isolated" });
    const actions = posted(net.seen);
    expect(actions.map((p) => p.action)).toEqual([
      { type: "updateLeverage", asset: 0, isCross: true, leverage: 5 },
      { type: "updateLeverage", asset: 5, isCross: false, leverage: 3 },
      { type: "updateLeverage", asset: 110004, isCross: false, leverage: 2 },
    ]);
    for (const p of actions) expect(await signerOf(p)).toBe(AGENT);
    expect(net.seen.filter((s) => s.body.type === "activeAssetData").map((s) => s.body.coin)).toEqual(["BTC", "xyz:HOOD"]);
    expect(refusal(await t.setLeverage!("XYZ-HOOD/USDC:USDC", 2, "cross")).message).toContain("takes isolated margin only");
    expect(refusal(await t.setLeverage!("BTC/USDC:USDC", 41)).detail).toEqual({ maxLeverage: 40 });
    expect(refusal(await t.setLeverage!("HYPE/USDC", 2)).code).toBe("E_VENUE_ORDER_INVALID");
    expect(posted(net.seen)).toHaveLength(3);
  });
});

// ---- reading the market -----------------------------------------------------------------------------------------------------------

describe("reading the market", () => {
  it("stats: the day of many markets from one asset-context read per DEX; candles: candleSnapshot by Hyperliquid's own coin", async () => {
    const { t, net } = await connected();
    net.seen.splice(0);
    const s = ok(await t.stats!(["BTC/USDC:USDC", "XYZ-NVDA/USDC:USDC", "HYPE/USDC"]));
    expect(s.get("BTC/USDC:USDC")).toEqual({ price: 81035.5, change24h: -2305.5, changePct24h: -2.7663, volumeUsd24h: 3341631875.3607402 });
    expect(s.get("XYZ-NVDA/USDC:USDC")).toMatchObject({ price: 231.095, volumeUsd24h: 161899634.74508002 });
    expect(s.get("HYPE/USDC")).toMatchObject({ price: 83.8475 });
    expect(types(net.seen)).toEqual(["info metaAndAssetCtxs", "info metaAndAssetCtxs xyz", "info spotMetaAndAssetCtxs"]);
    net.seen.splice(0);
    const bars = ok(await t.candles!("BTC/USDC:USDC", "1h", NOW - 4 * 3_600_000));
    expect(bars.map((b) => [b.t, b.o, b.c, b.v])).toEqual([[1791471600000, 82677, 81009, 8364.5566], [1791475200000, 81007, 80929, 4888.26485], [1791478800000, 80922, 80720, 4023.54386], [1791482400000, 80720, 81522, 1706.04515]]);
    expect(net.seen[0]!.body).toEqual({ type: "candleSnapshot", req: { coin: "BTC", interval: "1h", startTime: NOW - 4 * 3_600_000, endTime: NOW } });
  });
});

// ---- Hyperliquid's price rule and the account's id ---------------------------------------------------------------------------------

describe("Hyperliquid's price rule (Tick and lot size) and the account's id", () => {
  it("the docs' own examples; a worst price moved inside onto the grid; the cloid a 128-bit hex string", () => {
    expect([hlPriceOk(1234.5, 6), hlPriceOk(1234.56, 6)]).toEqual([true, false]);
    expect([hlPriceOk(0.001234, 6), hlPriceOk(0.0012345, 6)]).toEqual([true, false]);
    expect([hlPriceOk(0.01234, 5), hlPriceOk(0.012345, 5)]).toEqual([true, false]);
    expect([hlPriceOk(0.0001234, 8), hlPriceOk(0.0001234, 7), hlPriceOk(0.0001234, 5)]).toEqual([true, true, false]);
    expect(hlPriceOk(123456, 0)).toBe(true);
    expect([hlPriceStep(81359.5, 1), hlPriceStep(2425.75, 2), hlPriceStep(83.8475, 6), hlPriceStep(0.112555, 8), hlPriceStep(123456, 1)]).toEqual([1, 0.1, 0.001, 0.00001, 1]);
    expect([hlPriceInside(82987.62, 1, "down"), hlPriceInside(2378.123, 2, "up"), hlPriceInside(85.52496, 6, "down"), hlPriceInside(9.99996, 6, "up"), hlPriceInside(0.11031, 8, "up")]).toEqual([82987, 2378.2, 85.524, 10, 0.11031]);
    expect(cloidOf(CLIENT)).toBe(`0x${CLIENT}`);
    expect(cloidOf("not-hex")).toMatch(/^0x[0-9a-f]{32}$/);
  });
});
