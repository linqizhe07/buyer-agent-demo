/** The refusal vocabulary.
 *
 * Every refusal in the demo is a structured value, never a bare throw to the
 * driver, and its code names the LAYER that refused: `E_<LAYER>_<REASON>`.
 * The layer is what the audience reads ("who said no"); the venue's own error
 * (Alpaca's 42210000, Binance's -2015, Hyperliquid's sentence) travels in
 * `native` and lands on the ledger row unchanged.
 */
export type Layer = "MOUNT" | "MANDATE" | "CARD" | "GATE" | "SIGNER" | "WALLET" | "VENUE" | "ACCOUNT" | "PAYEE";

export const CODES = {
  // mount audit — the plugin contract
  E_MOUNT_UNCLASSIFIED: { layer: "MOUNT", zh: "工具未分类，整包拒绝挂载" },
  E_MOUNT_MISSING_TOOL: { layer: "MOUNT", zh: "manifest 声明的工具在 server 上不存在" },
  E_MOUNT_READONLY_MISMATCH: { layer: "MOUNT", zh: "server 自认会写，manifest 却标为 read" },
  E_MOUNT_TOOL_NOT_MOUNTED: { layer: "MOUNT", zh: "工具不在挂载面" },
  E_MOUNT_SPAWN_FAILED: { layer: "MOUNT", zh: "插件进程没有起来" },
  // mandate — the authorization letter, checked BEFORE any card
  E_MANDATE_NONE: { layer: "MANDATE", zh: "没有覆盖该场所的授权书" },
  E_MANDATE_EXPIRED: { layer: "MANDATE", zh: "授权书已过期" },
  E_MANDATE_SYMBOL: { layer: "MANDATE", zh: "标的不在授权书" },
  E_MANDATE_RECIPIENT: { layer: "MANDATE", zh: "收款地址不在授权书 allow-list" },
  E_MANDATE_PER_ORDER_CAP: { layer: "MANDATE", zh: "超过单笔上限" },
  E_MANDATE_RATE: { layer: "MANDATE", zh: "超过授权书的频率上限" },
  E_MANDATE_BUDGET: { layer: "MANDATE", zh: "授权书余额不足" },
  E_MANDATE_INVALID: { layer: "MANDATE", zh: "mandate 链验不过：封闭式 mandate 和开放式 mandate 或这笔结账对不上" },
  // card — the human
  E_CARD_REJECTED: { layer: "CARD", zh: "人拒绝了这张卡，agent 收到干净错误，不重试" },
  E_CARD_NOT_GRANTED: { layer: "CARD", zh: "没有本次调用的一次性授权记录" },
  E_CARD_NO_ANSWERER: { layer: "CARD", zh: "没有人可以回答这张卡" },
  // policy signer — the key the agent cannot read
  E_SIGNER_TX_CAP: { layer: "SIGNER", zh: "超过单笔上限，拒签" },
  E_SIGNER_DAILY_CAP: { layer: "SIGNER", zh: "超过当日上限，拒签" },
  E_SIGNER_RECIPIENT: { layer: "SIGNER", zh: "收款地址不在签名器 allow-list，拒签" },
  E_SIGNER_PROGRAM: { layer: "SIGNER", zh: "程序不在签名器 allow-list，拒签" },
  E_SIGNER_TOKEN: { layer: "SIGNER", zh: "代币不在签名器 allow-list，拒签" },
  E_SIGNER_EXPIRED: { layer: "SIGNER", zh: "签名会话已过期，拒签" },
  E_SIGNER_UNAVAILABLE: { layer: "SIGNER", zh: "签名器不可达" },
  // the main wallet — the user's, outside the agent; funds venues up to a float
  E_WALLET_FLOAT_CAP: { layer: "WALLET", zh: "超过该场所的 float 上限，钱包拒绝注资" },
  E_WALLET_INSUFFICIENT: { layer: "WALLET", zh: "钱包余额不足" },
  E_WALLET_UNKNOWN_VENUE: { layer: "WALLET", zh: "钱包不认识这个场所" },
  E_WALLET_NOT_CONNECTED: { layer: "WALLET", zh: "场所在连接器目录里，但钱包没有它的注资轨道或 float" },
  E_WALLET_EXPOSURE_CAP: { layer: "WALLET", zh: "超过钱包的总敞口上限" },
  E_WALLET_SESSION_EXPIRED: { layer: "WALLET", zh: "钱包会话已到期或已撤销，注资与提回都停" },
  E_WALLET_FLOAT_SHORT: { layer: "WALLET", zh: "场所里的 float 不够提回这么多" },
  E_WALLET_BAD_AMOUNT: { layer: "WALLET", zh: "金额必须大于 0" },
  E_WALLET_GRANT_REVOKED: { layer: "WALLET", zh: "该场所的授权已撤销：不再注资，仍可提回" },
  E_WALLET_DAILY_CAP: { layer: "WALLET", zh: "超过钱包的 24 小时出金上限" },
  // the agent portfolio manager — the user's existing accounts, opened to the agent up to each credential's edge
  E_WALLET_ACCOUNT_UNKNOWN: { layer: "WALLET", zh: "组合钱包不认识这个账户" },
  E_WALLET_ACCOUNT_REVOKED: { layer: "WALLET", zh: "该账户对 agent 的开放已撤销：只剩只读" },
  E_WALLET_SCOPE: { layer: "WALLET", zh: "凭据本身没有这个权限：钱包再开放也开不出来，场所那边也不会放行" },
  E_WALLET_REACH: { layer: "WALLET", zh: "用户没有把这个动作开放给 agent" },
  E_WALLET_BLOCKLIST: { layer: "WALLET", zh: "目标在用户的黑名单里" },
  E_WALLET_LIVE_WRITES_OFF: { layer: "WALLET", zh: "真钱写操作在本构建里关着：只打印会执行的命令" },
  // venue — the market's own second line
  E_VENUE_INVALID_TIF: { layer: "VENUE", zh: "加密订单不支持 day，仅 gtc/ioc" },
  E_VENUE_AGENT_NO_WITHDRAW: { layer: "VENUE", zh: "agent key 无提现权限" },
  E_VENUE_AGENT_EXPIRED: { layer: "VENUE", zh: "agent key 已失效" },
  E_VENUE_UNKNOWN_AGENT: { layer: "VENUE", zh: "场所不认识这把 agent key" },
  E_VENUE_BAD_NONCE: { layer: "VENUE", zh: "nonce 不递增" },
  E_VENUE_PERMISSION: { layer: "VENUE", zh: "API key 无此权限或 IP 不在白名单" },
  E_VENUE_BAD_SIGNATURE: { layer: "VENUE", zh: "签名无效" },
  E_VENUE_BAD_SIGNER: { layer: "VENUE", zh: "交易不是账户持有人签的" },
  E_VENUE_UNAUTHORIZED: { layer: "VENUE", zh: "场所不认这把 key" },
  E_VENUE_WITHDRAW_WHITELIST: { layer: "VENUE", zh: "提币地址不在场所白名单，只能提回主钱包" },
  E_VENUE_REJECTED: { layer: "VENUE", zh: "场所拒绝了这笔操作" },
  E_VENUE_CARD_DECLINED: { layer: "VENUE", zh: "发卡行 / 卡组织拒绝了这笔授权" },
  E_VENUE_TRANSFER_RESTRICTED: { layer: "VENUE", zh: "发行方转让限制：收款地址不在 KYC 白名单，合约 revert" },
  E_VENUE_INSUFFICIENT: { layer: "VENUE", zh: "场所账户余额不足" },
  E_VENUE_GEOBLOCKED: { layer: "VENUE", zh: "场所不接这个地区的单" },
  E_VENUE_MARKET_CLOSED: { layer: "VENUE", zh: "市场已截止或已结算，不再接单" },
  E_VENUE_MIN_DEPOSIT: { layer: "VENUE", zh: "低于场所的最低入金额：发出去场所不入账，所以不发" },
  E_VENUE_RAIL_CLOSED: { layer: "VENUE", zh: "这条跑道关着" },
  E_VENUE_CURRENCY: { layer: "VENUE", zh: "这个场所不收这种币，要先换" },
  E_VENUE_UNSETTLED: { layer: "VENUE", zh: "未结算的现金还不能提" },
  E_VENUE_RETURNED: { layer: "VENUE", zh: "这笔 ACH 被银行退回了" },
  // the account — the airport itself: who signed, with which key, and whether that key may ask for this
  E_ACCOUNT_BAD_SIGNATURE: { layer: "ACCOUNT", zh: "签名和指令对不上" },
  E_ACCOUNT_UNKNOWN_SIGNER: { layer: "ACCOUNT", zh: "账户不认识这把钥匙" },
  E_ACCOUNT_AGENT_EXPIRED: { layer: "ACCOUNT", zh: "agent 钥匙已过期" },
  E_ACCOUNT_AGENT_REVOKED: { layer: "ACCOUNT", zh: "agent 钥匙已被撤销" },
  E_ACCOUNT_OWNER_ONLY: { layer: "ACCOUNT", zh: "这个动作只有 owner 的钥匙能签" },
  E_ACCOUNT_OWNER_SURFACE: { layer: "ACCOUNT", zh: "这个操作必须来自 owner 的设备" },
  E_ACCOUNT_NOT_HOME: { layer: "ACCOUNT", zh: "agent 钥匙只能在用户自己的场所之间挪钱" },
  E_ACCOUNT_NONCE: { layer: "ACCOUNT", zh: "nonce 用过，或者不在时间窗口内" },
  E_ACCOUNT_EXPIRED: { layer: "ACCOUNT", zh: "指令已过期：资金指令签完只有几分钟有效" },
  E_ACCOUNT_THRESHOLD: { layer: "ACCOUNT", zh: "签名人数没到门槛" },
  E_ACCOUNT_FEE_CAP: { layer: "ACCOUNT", zh: "费率高于 owner 给这个应用批的上限" },
  E_ACCOUNT_LIMIT: { layer: "ACCOUNT", zh: "超过账户的数量或期限上限" },
  E_ACCOUNT_DESTINATION: { layer: "ACCOUNT", zh: "收款地址不在这条链的地址簿里" },
  E_ACCOUNT_DEST_COOLING: { layer: "ACCOUNT", zh: "新加的收款地址还在 24 小时冷静期" },
  E_ACCOUNT_SOURCE: { layer: "ACCOUNT", zh: "没有指明来源，或者没有开放的来源" },
  E_ACCOUNT_REQUOTE: { layer: "ACCOUNT", zh: "路线、费用或到账时间在签名之后变了，需要重签" },
  E_ACCOUNT_CARD_EXPIRED: { layer: "ACCOUNT", zh: "这张卡已过期" },
  E_ACCOUNT_BAD_ACTION: { layer: "ACCOUNT", zh: "指令格式不对" },
  E_ACCOUNT_UNPRICED: { layer: "ACCOUNT", zh: "这个资产在这里没有价格，无法判断额度，拒绝" },
  // the payee — the other side of a payment the agent makes
  E_PAYEE_CHANGED: { layer: "PAYEE", zh: "收款地址和这个 host 钉住的不一样" },
  E_PAYEE_OVERCHARGE: { layer: "PAYEE", zh: "收款方要的比授权的多" },
  E_PAYEE_REJECTED: { layer: "PAYEE", zh: "收款方拒绝了这张付款凭证" },
  E_PAYEE_UNVERIFIED: { layer: "PAYEE", zh: "收款方的质询或回执验不过" },
  E_PAYEE_UNSUPPORTED: { layer: "PAYEE", zh: "收款方给的付款方式这个账户都不支持" },
  E_PAYEE_REDIRECT: { layer: "PAYEE", zh: "收款方把请求转去了别处，不跟" },
} as const satisfies Record<`E_${Layer}_${string}`, { layer: Layer; zh: string }>;

export type Code = keyof typeof CODES;

export interface Refusal {
  ok: false;
  code: Code;
  layer: Layer;
  /** one line for the screen, Chinese */
  message: string;
  venue?: string;
  tool?: string;
  /** structured facts the model can act on (never secrets) */
  detail?: Record<string, unknown>;
  /** the venue's own error, verbatim */
  native?: unknown;
}

export function refuse(
  code: Code,
  extra: { venue?: string; tool?: string; detail?: Record<string, unknown>; native?: unknown; message?: string } = {},
): Refusal {
  const entry = CODES[code];
  const refusal: Refusal = { ok: false, code, layer: entry.layer, message: extra.message ?? entry.zh };
  if (extra.venue !== undefined) refusal.venue = extra.venue;
  if (extra.tool !== undefined) refusal.tool = extra.tool;
  if (extra.detail !== undefined) refusal.detail = extra.detail;
  if (extra.native !== undefined) refusal.native = extra.native;
  return refusal;
}

export function isRefusal(value: unknown): value is Refusal {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { ok?: unknown }).ok === false &&
    typeof (value as { code?: unknown }).code === "string" &&
    (value as { code: string }).code in CODES
  );
}

/** A refusal travelling as an exception inside the host; `execute()` turns it
 * back into a value before the driver sees it. */
export class RefusalError extends Error {
  constructor(public readonly refusal: Refusal) {
    super(`${refusal.code}: ${refusal.message}`);
    this.name = "RefusalError";
  }
}

/** `✗ E_VENUE_INVALID_TIF · 加密订单不支持 day，仅 gtc/ioc (alpaca: 422 code 42210000)` */
export function formatRefusal(r: Refusal): string {
  const where = r.venue ? ` [${r.venue}]` : "";
  const native = r.native === undefined ? "" : ` (${renderNative(r.native)})`;
  return `✗ ${r.code}${where} · ${r.message}${native}`;
}

function renderNative(native: unknown): string {
  if (typeof native === "string") return native;
  if (native && typeof native === "object") {
    const n = native as Record<string, unknown>;
    const parts: string[] = [];
    if (n.status !== undefined) parts.push(String(n.status));
    if (n.code !== undefined) parts.push(`code ${String(n.code)}`);
    if (n.message !== undefined) parts.push(String(n.message));
    if (n.msg !== undefined) parts.push(String(n.msg));
    if (typeof n.response === "string") parts.push(n.response);
    if (typeof n.error === "string") parts.push(n.error);
    if (parts.length) return parts.join(" ");
    return JSON.stringify(native);
  }
  return String(native);
}
