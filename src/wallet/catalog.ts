/** The connector catalog: every CEX, DEX, prediction market, RWA issuer and
 * broker the smart wallet knows how to reach, in ONE shape.
 *
 * Blueprint: the MetaMask Agent Wallet (self-custodial; the agent gets a
 * delegation with caveats — asset, amount per period, protocol allowlist,
 * time window — enforced on-chain and revocable at any time). On an EVM
 * chain that IS the key model (`delegation`). Off-chain venues cannot hold a
 * delegation, so the same policy is compiled into whatever they do have: an
 * API-key permission set (CEX), a venue-issued agent key (perp DEX), an RSA
 * key (regulated prediction market), a policy signer (Solana).
 *
 * "In the catalog" is not "connected". From the wallet's point of view a venue
 * is connected when the wallet has a funding RAIL and a FLOAT cap for it; it
 * has a SEAT when this repo mounts a plugin (and runs a simulator) for it. The
 * two are independent and the UI shows both, so "可接入" never reads as "已接入".
 */
export type ConnectorKind = "cex" | "dex-perp" | "dex-spot" | "prediction" | "rwa" | "broker";
export type Rail = "cex-deposit" | "dex-bridge" | "onchain" | "fiat";
export type KeyModel = "delegation" | "clob-key+delegation" | "api-key-permissions" | "agent-key" | "policy-signer" | "api-key-rsa" | "broker-key";
export type SeatShape = "ccxt-mcp" | "native-mcp" | "signer-mcp" | "clob-mcp" | "issuer-mcp" | "broker-mcp";

export interface Connector {
  id: string;
  name: string;
  kind: ConnectorKind;
  /** what the agent trades there */
  instrument: string;
  /** which MCP server form the seat takes */
  seat: SeatShape;
  keyModel: KeyModel;
  /** how the wallet moves money in; a `fiat` rail never passes through the wallet */
  rail: Rail;
  asset: string;
  chain?: string;
  /** the protocol allowlist a delegation's caveats name (on-chain venues) */
  targets?: string[];
  /** this repo mounts a plugin and runs a simulator for it */
  seatMounted: boolean;
  /** the venue's own agent-key semantics, one line */
  native: string;
}

export const KIND_LABEL: Record<ConnectorKind, string> = {
  cex: "CEX",
  "dex-perp": "DEX · 永续",
  "dex-spot": "DEX · 现货",
  prediction: "预测市场",
  rwa: "RWA · 真实世界资产",
  broker: "券商",
};

export const KEY_LABEL: Record<KeyModel, string> = {
  delegation: "EIP-7702 账户 + ERC-7710 委托（caveats）",
  "clob-key+delegation": "CLOB key + 链上委托",
  "api-key-permissions": "API key 分权限",
  "agent-key": "场所签发的 agent key",
  "policy-signer": "策略签名器",
  "api-key-rsa": "RSA 签名 API key",
  "broker-key": "券商 paper key",
};

export const RAIL_LABEL: Record<Rail, string> = {
  "cex-deposit": "充值地址",
  "dex-bridge": "bridge",
  onchain: "链上转账",
  fiat: "法币 ACH（不经钱包）",
};

export const SEAT_LABEL: Record<SeatShape, string> = {
  "ccxt-mcp": "ccxt 形状的 MCP 席位（一个形状接所有 CEX）",
  "native-mcp": "场所原生 MCP 席位",
  "signer-mcp": "签名器 MCP 席位（席位不持钥）",
  "clob-mcp": "CLOB 客户端形状的 MCP 席位",
  "issuer-mcp": "发行方申赎 + DEX router 的 MCP 席位",
  "broker-mcp": "券商 MCP 席位",
};

export const KIND_ORDER: ConnectorKind[] = ["cex", "dex-perp", "dex-spot", "prediction", "rwa", "broker"];

export const CATALOG: Connector[] = [
  // ---- CEX: one ccxt-shaped seat, one API-key permission model, N exchanges
  { id: "binance", name: "Binance", kind: "cex", instrument: "现货", seat: "ccxt-mcp", keyModel: "api-key-permissions", rail: "cex-deposit", asset: "USDT", seatMounted: true,
    native: "API key 分权限（SPOT，无 WITHDRAW）· IP 白名单 · 提币地址白名单 = 主钱包" },
  { id: "okx", name: "OKX", kind: "cex", instrument: "现货 / 永续", seat: "ccxt-mcp", keyModel: "api-key-permissions", rail: "cex-deposit", asset: "USDT", seatMounted: false,
    native: "API key 权限 read / trade / withdraw 分开 · IP 绑定 · passphrase" },
  { id: "bybit", name: "Bybit", kind: "cex", instrument: "现货 / 永续", seat: "ccxt-mcp", keyModel: "api-key-permissions", rail: "cex-deposit", asset: "USDT", seatMounted: false,
    native: "API key 权限分组（Trade / Wallet 分开）· IP 白名单 · 90 天到期" },
  { id: "coinbase", name: "Coinbase Exchange", kind: "cex", instrument: "现货", seat: "ccxt-mcp", keyModel: "api-key-permissions", rail: "cex-deposit", asset: "USDC", seatMounted: false,
    native: "CDP key 权限 view / trade / transfer 分开 · IP 允许列表" },
  { id: "kraken", name: "Kraken", kind: "cex", instrument: "现货", seat: "ccxt-mcp", keyModel: "api-key-permissions", rail: "cex-deposit", asset: "USDT", seatMounted: false,
    native: "API key 权限（query / trade / withdraw 分开）· 提币地址需预先登记" },
  // ---- DEX perps: the venue itself issues a trade-only, expiring agent key — or takes a delegation
  { id: "hyperliquid", name: "Hyperliquid", kind: "dex-perp", instrument: "永续", seat: "native-mcp", keyModel: "agent-key", rail: "dex-bridge", asset: "USDC", chain: "Hyperliquid L1（Arbitrum bridge）", seatMounted: true,
    native: "approveAgent：能下单撤单，不能提币 / 转账 / 再授权，valid_until 场所侧强制" },
  { id: "dydx", name: "dYdX", kind: "dex-perp", instrument: "永续", seat: "native-mcp", keyModel: "agent-key", rail: "dex-bridge", asset: "USDC", chain: "dYdX Chain", seatMounted: false,
    native: "permissioned keys：限定消息类型（下单 / 撤单），不可转账" },
  { id: "gmx", name: "GMX", kind: "dex-perp", instrument: "永续", seat: "signer-mcp", keyModel: "delegation", rail: "onchain", asset: "USDC", chain: "Arbitrum", targets: ["GMX ExchangeRouter"], seatMounted: false,
    native: "委托 caveats：allowedTargets = GMX router，spendLimit = float，expiry = session" },
  // ---- DEX spot: an EVM chain takes a delegation; Solana has no native one, so the signer is the policy
  { id: "uniswap", name: "Uniswap（Base）", kind: "dex-spot", instrument: "链上 swap", seat: "signer-mcp", keyModel: "delegation", rail: "onchain", asset: "USDC", chain: "Base", targets: ["Universal Router", "Permit2"], seatMounted: false,
    native: "委托 caveats：allowedTargets = router + Permit2，spendLimit 按日，expiry = session" },
  { id: "solana", name: "Solana · Jupiter", kind: "dex-spot", instrument: "链上 swap / transfer", seat: "signer-mcp", keyModel: "policy-signer", rail: "onchain", asset: "SOL", chain: "Solana", seatMounted: true,
    native: "策略签名器：programs / tokens / recipients allowlist · 单笔 0.2 SOL · 日上限 · 会话到期" },
  { id: "raydium", name: "Raydium", kind: "dex-spot", instrument: "链上 swap", seat: "signer-mcp", keyModel: "policy-signer", rail: "onchain", asset: "SOL", chain: "Solana", seatMounted: false,
    native: "与 Jupiter 同一把策略签名器：program allowlist 多一个 Raydium AMM" },
  // ---- prediction markets: an order book on top of on-chain (or regulated fiat) settlement
  { id: "polymarket", name: "Polymarket", kind: "prediction", instrument: "YES / NO 份额（CLOB）", seat: "clob-mcp", keyModel: "clob-key+delegation", rail: "onchain", asset: "USDC.e", chain: "Polygon", targets: ["CTF Exchange", "USDC approve"], seatMounted: false,
    native: "CLOB API key 由钱包签名派生，只下单 / 撤单；钱只经链上委托移动，caveats 只放行 CTF Exchange 与 USDC approve" },
  { id: "kalshi", name: "Kalshi", kind: "prediction", instrument: "YES / NO 合约（CFTC 监管）", seat: "native-mcp", keyModel: "api-key-rsa", rail: "fiat", asset: "USD", seatMounted: false,
    native: "RSA 私钥签每个请求，trade / read；出入金 ACH 经 web，不经钱包" },
  // ---- RWA: compliance-gated by design — allowlists, identity-to-address binding, issuer freeze
  { id: "ondo", name: "Ondo · Global Markets / OUSG", kind: "rwa", instrument: "代币化美股 / ETF · 代币化美债", seat: "issuer-mcp", keyModel: "delegation", rail: "onchain", asset: "USDC", chain: "Ethereum（BNB · Solana 跟进）", targets: ["Ondo subscribe / redeem", "DEX router"], seatMounted: false,
    native: "代币转让限制（allowlist）：agent 的智能账户先过 KYC 白名单；issuer 可冻结；赎回 T+1" },
  { id: "xstocks", name: "xStocks（Backed · Kraken）", kind: "rwa", instrument: "代币化美股（DEX 可交易）", seat: "signer-mcp", keyModel: "policy-signer", rail: "onchain", asset: "USDC", chain: "Solana / Ethereum", seatMounted: false,
    native: "二级市场在 DEX（Jupiter）自由交易；一级申赎只对 KYC 白名单；签名器只放行 swap 程序" },
  { id: "buidl", name: "BlackRock BUIDL（Securitize）", kind: "rwa", instrument: "代币化货币基金", seat: "issuer-mcp", keyModel: "delegation", rail: "onchain", asset: "USDC", chain: "Ethereum", targets: ["Securitize subscribe / redeem"], seatMounted: false,
    native: "只有 Securitize 白名单钱包能持有；转让限制合约强制；合格投资者" },
  { id: "robinhood-stocks", name: "Robinhood 代币化股票", kind: "rwa", instrument: "代币化美股（EU）", seat: "issuer-mcp", keyModel: "delegation", rail: "onchain", asset: "USDC", chain: "Arbitrum", targets: ["Robinhood issuer"], seatMounted: false,
    native: "发行方合约限制转让；仅 EU 客户的 KYC 钱包" },
  { id: "centrifuge", name: "Centrifuge", kind: "rwa", instrument: "私募信贷池", seat: "issuer-mcp", keyModel: "delegation", rail: "onchain", asset: "USDC", chain: "Ethereum / Base", targets: ["Centrifuge pool"], seatMounted: false,
    native: "池子白名单（KYC）· 赎回有锁定期" },
  // ---- broker: fiat rails never pass through the wallet
  { id: "alpaca", name: "Alpaca（纽交所侧，paper）", kind: "broker", instrument: "美股 / 加密现货", seat: "broker-mcp", keyModel: "broker-key", rail: "fiat", asset: "USD", seatMounted: true,
    native: "paper key 钉在 paper host；加密单 tif 只接受 gtc / ioc" },
];

export function connectorOf(id: string, catalog: Connector[] = CATALOG): Connector | undefined {
  return catalog.find((c) => c.id === id);
}
