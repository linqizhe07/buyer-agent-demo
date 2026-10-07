# 更早的模拟演示

这是仓库最早的几个演示，原样留着：十一个场景（agent 走进四个模拟市场）、插件合同、智能 agent 钱包骨架、原来的模拟对账单，以及整个仓库的诚实边界、回灌 Kairos 的对照和目录。Account 见 [README](../README.md) 与 [account.md](account.md)。

一个 AI agent 像人类投资者一样走进四个市场：Alpaca paper（NYSE 一侧的券商）、Hyperliquid（链上永续 DEX）、Binance（CEX，经第三方 ccxt 形状的 MCP server）、Solana（一条链，经策略签名器）。人进一个市场要带五样东西：**身份、钱包、席位、账本、授权书**。这个 demo 把五样拆开：agent 只拿到席位和"意图"工具，密钥它读不到，签名它做不了，每一次写操作都停在一张要人点的卡上，每一笔都记进一本能和四家市场对账的账本。

**四家市场全部是本地模拟器**（接口形状对齐真实 API，行为不保证）；agent 由确定性脚本驱动。十一个场景里有四次成交、十一次拒绝、损失为零——拒绝的那十一次才是产品。

## 跑起来

```bash
npm install
npm run demo                    # 无头：替身答卡，✓/✗/FAIL，exit 0 当且仅当没有断言失败
npm run demo -- --live --hold   # 现场：打开 http://127.0.0.1:4800，每张卡等你点；跑完保持页面
npm run demo -- --room          # 无头但开着控制台看替身答卡
npm run demo -- --only binance  # 只跑一个场景（席位在 setup 里已经挂好）
npm run demo -- --from solana   # 从某个场景续跑
npm run wallet                  # 智能 agent 钱包骨架：http://127.0.0.1:4810
npm run account                 # Account（英文界面）：http://127.0.0.1:4820，你真实的账户在一个页面上（npm run portfolio 同）
npm run account -- --classic    # 原来的模拟对账单：组合钱包、关键词 agent、拆单（再加 --mm 读真 MetaMask / Polymarket）
npm run portfolio:demo          # 组合钱包十个 beat，无头，exit 0 当且仅当没有断言失败
npm run account:demo            # Account（资金的机场）十四个 beat，无头，exit 0 当且仅当没有断言失败
#   两个终端 demo 每次各用一个新的临时 home（只有 `--home` 能指定；`$BUYER_HOME` 是 Account 自己的 home，demo 不读它），不碰正在跑的 Account 的 home
npx tsx test/standin/ui-standin.ts --port 4821   # 替身账户：真的 Account 页面、服务和门，场所全是替身，不联网、不动钱（终端打印配对码；拒绝 4820）
npm run demo -- --fresh         # 擦掉默认 home 重新种子
npm run control-room -- --replay ~/.buyer-agent-demo/runs/last.jsonl   # 不开 runner，回放上一次
npm test                        # 单测 + e2e（spawn 一次完整 demo，断言 exit 0 与关键行）
```

Node ≥ 22。端口：场所 4701–4704、签名器 4705、钱包 4706、控制台 4800、Account 4820（替身账户另选一个空闲端口，从不用 4820）。`$BUYER_HOME`（默认 `~/.buyer-agent-demo/`）是 home：凭据、授权书、账本、签名器策略、钱包状态都在那里，不在仓库里；授权书、账本、钱包余额每次运行从 `fixtures/home` 重新种子。

终端行的意思：`✓ [层] …` 通过的检查；`✗ E_<层>_<原因> · …` 一次**拒绝**（设计，不是故障）；`FAIL …` 断言失败。错误码前缀就是拒绝的层：`E_MOUNT_` 清单审计、`E_MANDATE_` 授权书、`E_CARD_` 人、`E_WALLET_` 主钱包、`E_SIGNER_` 策略签名器、`E_VENUE_` 场所自己。

## 十一个场景

| # | 场景 | 看到什么 |
|---|---|---|
| 1 | 挂载四个席位 | 每个插件先交 manifest（read / write / deny），boot audit 再放行；子进程环境里没有任何 KEY/SECRET/TOKEN，只有一条凭据引用 |
| 2 | 第五个插件 | server 上多了一个清单没写的 `sweepToColdWallet`（还自称只读）→ 整包拒绝挂载，进程被杀 |
| 3 | 跨场所读 | 四家余额与行情，没有一张卡 |
| 4 | 钱包接入 CEX/DEX | agent 用进程内工具申请注资 → 授权书 → 卡 → 主钱包向 Binance 存入 $2000、向 Hyperliquid 桥入 $2000；第三笔超过 float 上限，钱包拒 |
| 5 | Alpaca 加密单 | 卡批准 → 场所 422（加密单只认 gtc/ioc）→ 合同改写 tif → 改过的单子**再问一次** → 成交 |
| 6 | Hyperliquid agent key | 主账户签发 60s 到期的 agent key → 成交 → 旁路（偷 key 直接提币）被场所拒 → 跳钟 61s → 场所拒：key 已过期 |
| 7 | Binance 第三方 server | 一行代码没改，只配清单：createOrder 过卡成交；withdraw 不在挂载面；偷 key 换 IP 提币，交易所 -2015 |
| 8 | Solana 策略签名器 | 0.1 SOL 在策略内签了；0.5 SOL 人点了批准，签名器按单笔上限拒签 |
| 9 | 注入 | 带毒新闻让 agent 决定把全部 SOL 转给陌生地址：授权书在卡之前拦住，人没被打扰；直接递给签名器也拒 |
| 10 | 提回与对账 | 提币到非白名单地址被场所拒；float 提回主钱包；账本 ↔ 四家对账单 ↔ 钱包流水全部对上 |
| 11 | 总结 | 证明了什么、没证明什么、去 mainnet 的顺序 |

## 一笔写操作走的路

```
intent → 清单分类(manifest) → 授权书(mandate) → 审批卡(人) → 签名/密钥(席位 / 签名器 / 钱包) → 场所 → 账本
```

`src/agent/agent.ts` 的 `execute()` 是这条路的全部：每个拒绝都是结构化的 `{ok:false, code, layer, message, native}`，从不向 agent 抛异常；场所的原文错误（Alpaca 42210000、Binance -2015、Hyperliquid 的那句话）原样放进 `native` 和账本行。

## 插件合同（manifest）

每个席位一份 `manifests/<venue>.json`：席位（怎么 spawn）、身份（凭据**引用**，值只在 home）、签名权（in-plugin / 外部策略签名器 / 无）、工具分类（read / write / deny）、卡上显示哪些字段、怎么把意图算成名义金额（sizing）、场所约束（例如加密单的 tif）、场所错误到 `E_VENUE_*` 的映射。`src/contract/audit.ts` 在 `listTools()` 之后、注册之前审计：未分类 → 整包拒绝；清单漂移 → 拒绝；read 工具的 server 注解自称会写 → 拒绝；write 工具的全名进审批门的 allow-list。

## 智能 agent 钱包（骨架）

```bash
npm run wallet          # http://127.0.0.1:4810 · 一页 UI + 内存里的钱包服务
```

蓝本是 MetaMask Agent Wallet：钱在用户的智能账户里（EIP-7702 升级的 EOA，非托管），agent 只有一把会话钥匙和一份带 caveats 的委托（资产、每期额度、协议 allowlist、时窗），链上强制、随时撤销。链下场所拿不到委托，所以同一份策略被**编译**成各家自己有的东西：

| 场所类型 | 钥匙形态 | 谁强制 |
|---|---|---|
| EVM 链上（Uniswap、GMX、Polymarket 的链上部分、Ondo 等 RWA 发行方） | ERC-7710 委托 + caveats（allowedTargets · spendLimit · expiry） | 链（DelegationManager） |
| CEX（Binance、OKX、Bybit、Coinbase、Kraken，一把 ccxt 形状的席位） | API key 分权限：SPOT only、无 WITHDRAW、IP 白名单、提币地址白名单 | 场所 |
| perp DEX（Hyperliquid、dYdX） | 场所签发的 trade-only agent key，valid_until | 场所 |
| Solana（Jupiter、Raydium、xStocks 二级） | 策略签名器 allowlist、单笔 / 日上限 | 签名器 |
| 预测市场（Polymarket、Kalshi） | CLOB key 只下单 + 链上委托；Kalshi 是 RSA key，出入金 ACH 不经钱包 | 链 / 场所 |
| RWA（Ondo、xStocks、BUIDL、Robinhood 代币化股票、Centrifuge） | 委托只放行申赎与 router；代币转让限制（allowlist / ERC-3643）、发行方冻结、赎回 T+1 | 发行方 |
| 券商（Alpaca） | paper key 钉在 paper host，法币 ACH 不经钱包 | 席位 |

钱包只留场所做不到的：每家的 float 上限、总敞口、24 小时出金、提币白名单、session、按场所撤销。注资判定顺序：session → 金额 → 认识 → 接入 → 撤销 → float → 总敞口 → 日上限 → 余额；提回永远不被撤销挡住。目录里 19 个连接器，"已接入"只说明钱包这一侧有轨道与 float；"席位"另有标记，本仓库只挂了四个。

骨架的边界：轨道是桩（注资是一行流水，不会记进场所模拟器；demo runner 里的 `src/venues/wallet.ts` 才会）；没有链，EIP-7702 / ERC-7710 只是编译表里的文字；Guard / Beast 只是显示；无赔付。代码在 `src/wallet/`（`catalog.ts` 目录、`policy.ts` 编译与两个判定、`overview.ts` 视图、`server.ts` 服务与页面），单测 `test/unit/wallet.test.ts`。

## agent 组合钱包（Agent Portfolio Manager，模拟）

这一节是原来的模拟演示。它的对账单和 Account 功能重叠，已经并进 Account（[account.md](account.md)）：真实账户、净值、配置条、等你批的卡都在那里。这一页只在 `--classic` 下。

```bash
npm run account -- --classic                    # http://127.0.0.1:4820 · 一张模拟对账单（英文界面）：看 · 说 · 批；六个账户，不带签名层
npm run account -- --classic --mm               # MetaMask 账户和它的 Polymarket deposit wallet 读真的（mm CLI，只读）
npm run portfolio:demo                          # 无头：十个 beat，✓/✗/FAIL，exit 0 当且仅当没有断言失败；每次从空账本开始，可重复跑
npm run portfolio:demo -- --mm --serve --hold   # 现场：live MetaMask / Polymarket + 页面保持
npm run portfolio:mcp                           # stdio MCP：agent 面（portfolio_overview / read / markets / quote / execute / order / approval / openness，带 Account 层时再加 account / transfer / pay）
```

**界面语言是英文。** 页面、航班里的每一句话、拒绝与卡片的原因、MCP 返回给 agent 的文字，全部是英文（`words.ts`、`router.ts`、`refuse.ts`）；输入框中英文都听得懂。终端 demo 的输出也是英文。本文档和仓库里其余的 demo（十一个场景、控制台、钱包骨架）仍是中文。

**这一页是一张模拟对账单，用户只做三件事**：看（净值、配置、六个账户）· 说（跟 agent 一句话，或点一个预设：`Subscribe $5,000 OUSG` / `Sell 3 ETH` / `Buy 1,000 YES · Fed hike` / `Rebalance` / `Withdraw to cold wallet` / `Send to a new address`，或直接说 "sell 1 ETH"、"buy 0.4 ETH"、"fund Polymarket with 300"、"redeem winnings"）· 批（agent 停下来问的那张卡，Approve / Reject）；外加一个 Open / Guard 开关和每个账户的 On / Off。一笔被拆开的单在航班里是一条比例条加每片一行。agent 的回话是白话，没有错误码；页面上的 agent 是关键词脚本（`agent.ts`），不是 LLM。三层、绕过、哈希链这些内部机制只在终端 demo 与账本里。

**机场、航班号、流动性图**——这个子系统是供 agent 起降的机场：跑道是六条接入轨道，海关是凭据原生权限，塔台是 Open / Guard 与那张卡，廊桥是 stdio MCP，黑匣子是账本。每个 agent 的一次请求是一班，航班号 = agent 代码 + 序号（`PM-0001` 页面脚本、`CC-0004` Claude Code 经 MCP、`TD-0008` 终端 demo），一班分几段（钱碰到的每个账户一段），每条账本行都写着航班与 agent。

核心卖点是跨链与流动性，两种流动性都做了，三类场所（CEX、DEX、预测市场）走同一个路由器：

- **钱的可调动性 = 金额 × 时间 × 成本**（`rails.ts`）。页面配置条下面是一张**流动性阶梯**：每笔稳定币 / 现金 / RWA 按"多久能到 Ethereum（RWA 结算链）"分档——Now（Ondo 地址上的 USDC）· Minutes（MetaMask 在 Base 的 USDC 过桥；Polymarket 的 pUSD 先提回再过桥）· T+1（OUSG 赎回）· Closed（Binance / OKX 的 key 没开提币、Kalshi 出金只走 ACH），每档带成本；关着的跑道也保留报价（给 Binance 的 key 开提币：~10 min · $9.50 就能把 $5,000 运过来）。
- **跨链带报价与选路**。`Subscribe $5,000 OUSG` 由路由器飞：Ondo 的 $3,000 先用；MetaMask 的 $1,200 要跨链，三座桥（liquidity bridge 5 bps + $0.40 · ~2 min；CCTP $1.20 · ~15 min；canonical bridge $2.50 · 7 days）加两条经 CEX 中转的路（关着）比过，取最便宜的那条开着的；桥费从到账里扣（到 $1,199），还差 $801，并报出补上它的价钱；停在 Polymarket 的 $600 pUSD 它点名但不动（那是下注用的钱）。金额大了答案会变（$50,000 时 CCTP 更便宜；要最快则还是 liquidity bridge）。`--mm` 且真钱包有钱时改读 `mm swap quote --all-quotes` 的真实报价（只读；钱包是空的时 MetaMask 回 `INSUFFICIENT_FUNDS`，退回模拟报价并在航班里说明——真报价的成功路径尚未实测）；执行命令是 `mm swap execute …`，默认只打印不跑。桥到的钱按地址落到目标账户（`credit`）。
- **成交流动性：CEX 订单簿 + DEX 池子**（`venues.ts`）。CEX 是订单簿：中间价（场所之间差几个 bp）、点差、深度冲击、taker 费。DEX 是链上的恒定乘积池子（Ethereum 上的 Uniswap v3 0.05% / 0.3%，Base 上的 Aerodrome 与 Uniswap v3），经链上钱包的 swap 到达：一条链上的一次 swap 是一个场所（`DEX (Base)`），里面按边际价格在这条链的几个池子之间分水、各付各的 LP 费、gas 只付一次（Ethereum $4，Base $0.05）。适配器用同一个函数成交，所以比过的报价就是成交价。`Sell 1 ETH` 四处比过：OKX 净得 $2,439.02，DEX (Base) $2,438.67，Binance $2,437.44，DEX (Ethereum) 只有 0.15 ETH——卖在 OKX，不用拆；`buy 0.4 ETH` 反过来是 DEX (Base) 赢（5 bp 的池子加 5 美分 gas，比 10 bp 的 taker 费便宜）；`Sell 0.05 BTC` 只有 Binance 有货，其他场所如实说没有。
- **拆单**（`venues.ts` 的 `splitOrder`、`router.ts`）。`Sell 3 ETH` 没有一个场所接得下（Binance 2 · OKX 1.5 · 链上 Base 1 · Ethereum 0.15），路由器一手一手地分：每一手去边际净价最好、且还有库存的场所，所有场所组合都试一遍——固定成本（gas）只在挣得回来的地方付，多飞一段至少要多挣 $1。结果是 OKX 1.5 · DEX (Base) 1 · Binance 0.5，净得 $7,315.91；DEX 那片的路由（`Route: Aerodrome · gas $0.05`）写在它那一行下面；Ethereum 上的 0.15 ETH 没动（一笔 swap 的 gas $4，用上它反而少 $3.83）。卖在哪里还决定钱之后能不能动：CEX 两片的 USDT 困在交易所（key 提不出来），DEX 那片的 USDC 留在 Base 上，流动性阶梯的 Minutes 随即多出 $2,439。同一套算法在大单上才见钱：400 ETH（忽略库存）拆到两个订单簿和两条链的池子，比最好的单一场所多净得 $415.66。
- **预测市场**（`events.ts`、`adapters/polymarket.ts`、`adapters/kalshi.ts`）。事件合约（`FED-DEC-HIKE25:YES`）是第三类场所：一个问题、一个截止日，每份到期兑 $1 或 $0，所以价格在 0 到 1 之间。同一个问题同时挂在 Polymarket（Polygon 上的 CLOB，资金是 pUSD，经 MetaMask 的 `mm predict` 到达）和 Kalshi（CFTC 监管的交易所，资金是 USD，出入金走 ACH），各有各的盘口、费率（Polymarket 5% × p × (1 − p)；Kalshi 7% × p × (1 − p)，向上取整到分）和现金。`Buy 1,000 YES · Fed hike`：两边的钱都不够（Kalshi $500 · Polymarket $600），同一个路由器把它拆成 Kalshi 400 @ 0.73（$297.52）+ Polymarket 600 @ 0.74（$449.77），共付 $747.29；agent 接着说清两件事——每份到期兑 $1，以及两家按各自的规则结算，同一个问题可能结出不同的结果。给 Polymarket 充值是一条跨链航线：`Fund Polymarket with 300` 把 MetaMask 在 Base 的 USDC 直接桥进 Polygon 上的 deposit wallet（费 $0.55，到 $299.45）。已结算的市场用 `Redeem winnings` 按 $1 兑付。头寸是和别的一样的持仓，按参考价计入净值（配置条上的 Predictions）。
- **一单一卡，路由是塔台的服务**（`service.ts`）。拆出来的各片作为一单飞（`flyBatch`）：钱包按整单判免审额度与日上限——拆小了也躲不过——Guard 下只出一张卡，批准后各片一起成交，拒绝则一片不动。路由不是页面 agent 的私货：`quote` / `order` 在服务层，HTTP 是 `GET /api/markets`、`GET /api/quote`、`POST /api/order`，MCP 是 `portfolio_markets`（事件合约目录、状态与两边的盘口）、`portfolio_quote`（只读：每个场所的报价、切片、DEX 路由、没用上的场所与原因）与 `portfolio_order`（按路由执行，航班记在调用它的 agent 名下，如 `CC-0004`）；`base` 既可以是资产（`ETH`），也可以是事件合约（`FED-DEC-HIKE25:YES`）。

骨架钱包是"一个智能账户给场所注资"；组合钱包是它上面一层：用户**已经有的**账户——Binance、OKX（CEX）、MetaMask Agent Wallet（链上，可 live）、Polymarket、Kalshi（预测市场，Polymarket 可 live）、Ondo OUSG（RWA）——一个形状接进来，一次读出一个总数，并"最大程度开放给 agent"。银行和卡不在里面：银行要聚合商的生产资格，卡没有给个人的接口，没有接口的就不放进来。开放多大，由三层决定，钱包只拥有中间那层：

| 层 | 谁定 | 例子 |
|---|---|---|
| 一 · 凭据原生权限 | 场所 / 发行方；钱包改不了，只预检 | Binance key SPOT 无 WITHDRAW · OKX read / trade · Kalshi key 只能交易，出入金走 ACH · Polymarket：受限地区不能下单、最小 5 份 · OUSG 只转白名单地址、赎回 T+1 · MetaMask Guard：24 h 出金、白名单、超线 MFA |
| 二 · 用户的开放度拨盘 | 钱包 | `open`：不加额度、不发卡，agent 触达每个凭据的边缘；只在危险的那一笔上还问人——往从没用过的地址转钱，或在已过截止、尚未裁决的预测市场里下单（MetaMask Beast 的规则：跳过策略，仍拦危险的那一笔）。`guard`：免审额度之上停卡，日上限硬线。按账户收窄（reach）、撤销（只剩读）、黑名单。读在任何设置下都不停 |
| 三 · 场所的第二道线 | 场所 | 绕过钱包拿凭据直打：Binance -2015 · Kalshi 404（没有出金接口）· Polymarket `PREDICT_GEOBLOCKED`、已结算的市场不接单 · OUSG 合约 revert |

写操作判定顺序：session → 撤销 → 凭据权限（`E_WALLET_SCOPE`）→ 用户开放（`E_WALLET_REACH`）→ 黑名单 → 危险的那一笔（陌生地址、已过截止未裁决的市场）在任何模式下都出卡 → guard：日上限、免审额度（拆单的各片按整单合并计）。十个 beat：接入 → 全视图（一次读，没有卡）→ 流动性阶梯与带报价的跨链（PM-0001：燃油 → 选桥 → 差额与关着的跑道）→ 成交流动性：四个场所报价、一笔单拆到 OKX / DEX / Binance（PM-0002）、库存只在一处的单（PM-0003）、Claude Code 经路由在 DEX 买入（CC-0004）、400 ETH 的深度推演 → 预测市场：一个问题两处报价、拆到 Kalshi 与 Polymarket 买入（PM-0005）、跨链给 Polymarket 充值（PM-0006）、兑付（PM-0007）→ open 模式三笔跨账户写零张卡 → 开放的边缘（钱包预检与场所第二道线画同一条线，绕过两次；已结算的市场场所拒单）→ open 仍然会问的两件事（陌生地址、已过截止的市场，人都拒了）→ guard 一键收紧（卡、拆单一单一卡、撤销、收窄）→ 账本链核对、航班按 agent 统计、证明了什么 / 没证明什么。

**`--mm` 时哪些是真的。** MetaMask 账户读真钱包（地址、Guard 策略 YAML、余额、`mm price spot` 的现价）。Polymarket 账户读真的 `mm predict`：`status` 与 `geoblock` 直接决定这把凭据的权限——deposit wallet 没部署或没跑过 setup 时只剩读；本机 IP 在受限地区时凭据里就没有 `trade`，钱包预检给 `E_WALLET_SCOPE`，绕过钱包则是场所自己的 `PREDICT_GEOBLOCKED`（`E_VENUE_GEOBLOCKED`），订单只会去 Kalshi。这是场所的合规线，这里只如实呈现，不提供任何绕过它的办法。合约背后的真实盘口（`mm predict markets get` 与 `quote`：买一、卖一、这笔单的预估成交）是公开数据，不需要资金、受限地区也读得到，作为一行对照写进航班；场所报价本身仍按固定表。写操作一律关着：`PORTFOLIO_MM_WRITES=1` 才会真跑 `mm transfer` / `mm swap execute` / `mm predict place`，默认只把会执行的命令放进拒绝里。

边界：除上面 live 的两个账户外，其余账户在进程内模拟（Binance / OKX 的权限错误码形状真实；Ondo 只模拟白名单转让限制与 T+1；Kalshi 的错误码与 ticker 是示意，费率公式是它公布的）；价格是固定表；桥费、到账时间、提币费、点差、深度、池子的虚拟储备、gas 与预测市场的盘口都是示意的报价表（形状真实，数字不是行情；加息那个市场的 0.73 / 0.74 是构建时真实盘口的镜像），到账时间只是报价、模拟里即时到账；撤销只在钱包这边。DEX 与拆单的边界：订单簿与池子是无状态的（成交不移动价格，没有行情、MEV、滑点保护）；拆出的各片依次成交、不是原子的——一片成了另一片被场所拒了就是部分成交，账本看得见，没有回滚；拆单只在已有库存的场所之间分，不会为了拆单先跨场所搬货；MetaMask 钱包里的 Swaps 报价自带 0.875% 服务费，模拟池子没计这笔费——计上的话 DEX 那片在这个规模上赢不了 CEX，agent wallet 的 `mm swap` 实收多少以 live 报价为准。预测市场的边界：同一个问题在两处按两套规则结算，拆到两边买不是一个头寸，agent 只说明、不对冲；Polymarket 的费率按该市场 `feeSchedule` 的形状写的，精确公式以它的文档为准；它的文档把多数受限地区列为 close-only（只能平掉已有头寸、不能开新仓），这里简化成凭据里整个没有 `trade`；哪些地区受限是场所自己的名单、会变，所以模拟的种子不点名任何地区；Kalshi 没有 live 通道；这只真钱包从没跑过 `mm predict setup`，所以 live 的持仓快照（`mm predict portfolio`）没有实测。live 路径里实测过的：余额、现价、Polymarket 的盘口与下单预估、地区检查；没实测的：桥与 DEX 的真实报价（需要钱包里有钱）。代码在 `src/portfolio/`（`accounts.ts` 账户模型与凭据原生权限 · `adapters/` 各个账户 · `openness.ts` 拨盘与判定 · `portfolio.ts` 聚合与流动性图 · `rails.ts` 轨道报价与流动性阶梯 · `venues.ts` 订单簿、池子、跨场所报价与拆单路由 · `events.ts` 事件合约目录与盘口算术 · `router.ts` 把一笔单写成航班（每片一步、比过什么、钱落在哪）· `service.ts` 航班、一单一卡、路由服务与账本 · `agent.ts` 关键词脚本 agent 与资金路由器（燃油 → 跨链 → 差额）· `words.ts` 白话 · `refuse.ts` 英文的拒绝句子 · `server.ts` API 与对账单页面 · `mcp.ts` agent 面 · `demo.ts` 十个 beat），单测 `test/unit/portfolio.test.ts`，无头 e2e `test/portfolio-demo.test.ts`。

## 诚实边界

- 模拟器 ≠ 真场所：形状对齐，没有延迟、滑点、部分成交、宕机；Hyperliquid 的 EIP-712 与 Solana 交易用 ed25519 替身；Binance 的 HMAC 签名与权限层级是真实形状；`-4026` 这类白名单错误码是示意。
- 门不是围栏：workspace 里的 shell 能读 home 里的文件（R1），demo 自己在第 6 场演了这一点；`POST /approve` 没有鉴权（R3a），真钱之前答卡的要是带外设备。
- 脚本化 agent 不代表 LLM 会做同样决定；没有证明任何 alpha。
- allow-list 之内的乱交易（3Commas 形态）只靠限品种、限额、限频和账本显形，没有完全解决。
- 钱包服务信任同一操作员进程的卡结论（它不验证审批记录）；真实系统里钱包要自己核对。

## 回灌 Kairos

| 这里 | Kairos 的接缝 |
|---|---|
| `manifests/*.json` + `src/agent/mount.ts` | `face/src/akshare.ts` 的 MCP row 模式；manifest 作为 row 的伴生文件 |
| `src/contract/audit.ts` | `face/src/orders.ts` 的 `auditOrderTools` + `boot.ts` 的拒绝启动；把 `ORDER_RAW_NAMES` 常量换成清单的 write 列表 |
| `src/agent/gate.ts` | `orders.ts` 的 decision / `hasApprovalGrant` / guard 三件套，`tools/pre-execute` prepend 监听 |
| `src/agent/mandates.ts` | `budgets.ts` Gate 3 与 agentpay 的 `mandateRejection` |
| `src/contract/env-scrub.ts` + home 凭据引用 | dsh 的 `.credentials.yaml` 与子进程 scrub |
| `src/agent/ledger.ts` | agentpay 的 JSONL 账本 + 哈希链 |
| 十一个场景的 ✓/✗ | `face/README.md` 的 drill：自动半场 + 手动半场 + "证明了什么 / 没证明什么" |
| `src/portfolio/account/sign.ts` + `exchange.ts`：签名信封、nonce、卡的答复是 owner 的签名、放行时重查 | R-W1 / R3a（预算卡和审批卡能从 workspace 里被答掉）：答卡改成带外钥匙的签名，放行时重跑 Gate |
| `account/state.ts` 的支出授权：单笔、预算（含等卡和押金占用的部分）、到期、每次花钱时重验 owner 的签名 | `face/src/budgets.ts` 的 Gate 3 与 agentpay 的 `mandateRejection`：那里的 mandate 是自签的，花钱时不验 |
| `account/payees.ts` 的 `gate()`：先查授权再联系收款方、钉住 `payTo`、第一次付款出卡、回执对账本核对 | agentpay 的付款方（`MandateWallet`）：x402 现在是 402 说付给谁就付给谁 |
| `account/payees.ts` 的子账户 float | R-W2（付款钥匙每个 shell 回合都读得到）和 agentpay README 自己写的那句：mandate 约束的是 agent，不是钥匙 |
| `account/protocols.ts`：MPP、AP2 的编解码 | agentpay 只有 x402 V2；AP2 在那里只有名字 |
| `account/doors.ts`：每个场所声明自己的资金跑道和谁能发起 | 场所插件的 manifest：工具分类之外，再声明资金怎么进出 |
| `adapters/exchange.ts` + `EXCHANGES`：一种场所一份连接器声明，门由钥匙的权限编译，owner 一条签名接入 | 场所插件：接入一个新场所不该要写代码；插件声明怎么说话，权限从场所那边读 |
| 账本行里嵌签名信封，加哈希链 | agentpay 的账本没有哈希链 |

## 目录

```
manifests/        五份插件合同（含故意带未分类工具的 rogue-yield）
fixtures/home/    种子：凭据（假的，仅模拟器）、授权书、签名器策略、钱包策略与余额
src/core/         clock · bus · ids · hash · jsonl · prng · ed25519 · errors（E_<层>_<原因>）
src/contract/     manifest schema · 审计 · 约束 · 环境 scrub
src/agent/        registry · mount(真 stdio MCP) · gate · mandates · ledger · sizing · reconcile · agent.execute
src/venues/       alpaca · hyperliquid · binance · solana-chain · policy-signer · wallet（全部本地模拟）
src/plugins/      五个 stdio MCP 席位；_shared/identity.ts 只有席位能 import（单测钉死）
src/runner/       run-demo · beats/ · operator（操作员动作：签发 agent key、旁路、提回）· setup
src/control-room/ express + SSE 的单页控制台（纸色/墨色/橙/鼠尾草绿）
src/wallet/       智能 agent 钱包骨架：连接器目录 · 策略编译 · 注资/提回判定 · 一页 UI（:4810）
src/portfolio/    Account（英文界面，:4820）与原来的组合钱包：账户模型 · 八个模拟 adapter（原来的六个：CEX · 链上 · 预测市场 · RWA；Account 层加的两个：券商 · perp DEX）与真实连接器（`live/`）· 开放度三层 · 聚合 · 流动性阶梯与轨道报价 · CEX 订单簿 + DEX 池子 + 预测市场盘口的报价与拆单路由 · 航班、一单一卡与账本 · 关键词 agent + 路由器 · API、Account 页面与 `--classic` 的模拟对账单 · stdio MCP · 十个 beat · account/（Account 层：签名指令、每个场所的跑道、在途与到账、三套对外付款协议、真钱的下单 / 动钱 / Earn、持有、净值、成本价）与它的十四个 beat · public/ui/（桌面钱包：Portfolio · Markets · Trade 三屏）
test/             unit（audit · gate · mandates · constraints · ledger · env-scrub · wallet · portfolio · account-* · live-* · ui-*）· attack（独立审阅留下的攻击复现，全部必须失败）· standin（替身账户：真页面、替身场所）· e2e · portfolio-demo · account-demo · portfolio-mcp
```
