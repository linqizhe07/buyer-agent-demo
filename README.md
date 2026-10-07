# buyer-agent-demo · 通用投资助手（买方 agent）演示

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

这一节是原来的模拟演示。它的对账单和 Account 功能重叠，已经并进下一节的 Account：真实账户、净值、配置条、等你批的卡都在那里。这一页只在 `--classic` 下。

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

## Account：资金的机场（账户与收付款）

```bash
npm run account                           # http://127.0.0.1:4820：一个桌面钱包页面，只认你真实的账户；能下单、能动钱（配对码在终端）
npm run account -- --live-cap 50          # 每一单、每一笔最多 $50（默认 $100）
npm run account -- --read-only            # 只读：不下单、不动钱
npm run account -- --fresh                # 从零开始：不接着以前的运行（默认会接着，见下）
npm run account:service -- install --live-cap 20   # macOS：装成登录自启、挂了自动拉起的后台服务（status · restart · logs · code · uninstall）
npm run account:demo                      # 无头：十四个 beat，每个 beat 放行一件事、拒绝一件事；同一个 home 连跑两次，输出逐字节相同
npm run portfolio:mcp                     # agent 的席位持一把 agent 钥匙，每次写都签名
npx tsx examples/account/headless.ts      # 一个脚本从头走到尾：owner 签、agent 签、时间流逝，不起服务不开浏览器
npx tsx examples/account/agent-seat.ts whoami   # 扮演一个 agent，对跑着的服务发签名指令
npx tsx test/standin/ui-standin.ts --port 4821   # 替身账户：同一个页面和门，替身场所，种好了数据，能点到底（下面「替身账户」）
```

做法手册在 [COOKBOOK.md](COOKBOOK.md)：每件事怎么做、会看到什么、什么会被拒，配两个能直接跑的示例（`examples/account/`）；给做 Agent 模块的团队的接口在它的「Agent 模块接口」一节。

对账单和 Account 原来是两个页面，功能重叠，现在合成一个，就叫 Account。它回答两件事：你有多少钱、在哪里；**钱怎么进出每个场所，以及谁有权让它动**。它是 trading agent 和资金之间的机场：功能照 Hyperliquid 自己的账户页一项一项移过来，但门开在八个场所上（比原来多一个股票券商 Alpaca 和 Hyperliquid 自己），再加上买方账户需要、单个场所不需要的三样：支出授权，替 agent 回答对外付款协议，以及把用户已有的交易所钱包**即插即用**地接进来。界面是英文。

**随时能被 agent 调用，动作空间开到最大。** 这一版补的是两件事：
- **随时**：账户重启不丢。每次运行的账本第一行写明接着哪个文件，启动时顺着这条链重建：owner 的浏览器（不用再配对）、每一条你签过的长期指令（逐条重新验签后按原时间重放）、每份额度的用量、接过的账户（用当初签的同一个凭据引用重新接上）、没完成的单和在途的钱（只问不重发）、编号接着排。可以装成 launchd 后台服务。agent 的席位用自己生成、存在本机的钥匙，不再从名字推出来。`portfolio_wait` 等一张卡、一单、一笔钱变化，不用反复问。
- **最大**：各场所接口支持的动作都开给 agent：市价、限价、止损、止损限价，有效期（GTC / IOC / FOK / DAY），只做 maker、只减仓，原地改单，持仓与平仓，永续杠杆（agent 不超过你签的倍数）；**付钱给别人**：agent 钱包（账户替它生成、钥匙在本机、agent 拿不到），按 x402 V1/V2 和 MPP charge 用 USDC 付，付没付成以链上为准；一个 agent 可以同时拿交易、挪钱、付款三份额度（钱包这一轮又加了第四份 earn），页面上 "Everything" 一键勾满前三份。守住的线不变：额度是你签的、`--live-cap`、随时撤销、钱只去你自己的地方（付款只付额度里的收款方）、各场所自己的地区规则不绕。

**页面上只有真的。** `npm run account` 起的服务里只有你经各家自己的接口接进来的账户：没有一个模拟场所，也没有模拟的插件、收款方和时钟。一开始账户是空的：Portfolio 是三步清单（Connect an account → Connect an agent → Give it a limit），连接的目录是一排可以接的场所（交易所、券商、钱包、预测市场与代币），点哪个就是哪个的接法；Markets 里已经有不带钥匙读来的公开行情。只动模拟钱的指令（场所间的模拟路由、swap、float、地址簿、对外付款、Unified、应用抽成）在门口就拒，回答里写明真钱走 `liveMove`（owner）或 `agentLiveMove`（agent）。银行和卡删掉了：银行要聚合商的生产资格，卡没有给个人的接口，没有接口的就不放进来。下面讲的路由、在途、float、收款方和十四个 beat，是终端 demo 与测试里那套模拟账户上的规则。

**一个桌面钱包：Portfolio · Markets · Trade，agent-native。** 页面从一条长滚动改成三根并列的支柱，蓝本是 MetaMask 移动端的 Home / Explore / Trade，区别是这里的主要行动者是 agent：人看、引导（意图、关注、额度、模式）、批。**Portfolio** 是你有什么，和对手里的钱做的事（跨场所按资产汇总、净值曲线、成本价、等你批的事、agent 在做什么；Move、Receive、Earn、Sell many 都从这里开）；**Markets** 是有什么可以交易（接上的场所，加上没接的场所不带钥匙读来的真实公开行情，标 "Connect to trade"）；**Trade** 是在一个市场里建一个仓位：一张下单票，按市场的种类分六面——Crypto · Stocks · RWAs · Perps · Pre-IPO · Predictions，和 Markets 的 tab 同样的词、同样的顺序——加上 Under way。一样功能只有一个家，同一件事不在两处出现。agent 的管理归另一个团队的 Agent 模块，它从 `ui/agents-mount.js` 的 `openAgents()` 挂进来；在那之前原来的 Agents、Agent wallets 两段原样放在 Agents 弹层里（Devices 搬进了 Settings）。规矩照旧：每个控件都经真的门做真的事，没有占位、没有样例数据；没有接口的就不画。agent 面也一样：真实账户上 `/api/markets`、`/api/quote` 回一条拒绝（样例的事件目录和模拟路由不在这个账户上），`/api/overview` 的流动性是每个场所对自己钥匙或钱包的说法，不带模拟的阶梯和拨盘。先做了桌面版，窄屏的手机式布局（底栏、底部弹层）放在后面一期。

### 从 Hyperliquid 移过来的功能

| Hyperliquid 的按钮，和它今天实际发的动作 | `/account` 上的对应 | 谁能签 |
|---|---|---|
| Deposit（CCTP，0.2 USDC，最低 5） | **Deposit**：把钱送进一个场所；先给路线、费用、最低额、到账时间 | owner；agent 只能当作自家场所之间的划转来做 |
| Withdraw（`sendToEvmWithData`） | **Withdraw**：回到自己的链上钱包或另一家交易所 | 只有 owner |
| Send（`sendAsset` 给别人） | **Send**：付给第三方；地址先进地址簿（绑定链），加入 24 小时后才能用 | 只有 owner |
| Perps ⇄ Spot、EVM ⇄ Core、子账户充值（都是 `sendAsset`；API wallet 只能发目的地等于来源的 `agentSendAsset`） | **Transfer**：在自己的场所和子账本之间挪 | owner；agent 在支出授权之内 |
| Swap Stablecoins | **Swap**：USD / USDC / USDT 互换；路线里需要换币时自动插一腿 | owner；agent 在授权之内 |
| Account Type（`userSetAbstraction`） | **Separate / Unified**：Unified 时 agent 可以不指定来源，由账户在授权点名的场所里挑最快到的 | owner |
| Sub-Accounts | **Sub-accounts**：每个 agent 一个 float，对外付款从这里出 | owner |
| API（`approveAgent`） | **Agent keys**：授权、到期、撤销；撤销过的钥匙不能再授权 | owner |
| Builder Codes（`approveBuilderFee`） | **Approvals**：费率授权，加支出授权（场所之间 / 对外收款方） | owner |
| Multi-Sig | **Signers**：设备钥匙、共同签名人、门槛 | owner |
| Deposits and Withdrawals 页签 | **Payments**：每一笔的每一腿、状态、到账时间 | |

没有移的：Link Staking、Earn、Vaults、Staking、Referrals、Outcomes、Portfolio Margin、法币入金小部件。（这里另有一个 Earn，但不是 Hyperliquid 的：它走 MetaMask Agent Wallet 的 `mm earn`、OKX Simple Earn、Kraken Earn 和 KuCoin Earn，见 B 层的「Earn」。）**故意没抄的**：到期时间塞在 agent 名字里（这里是显式字段）；撤销后清掉 nonce 记录（这里不清，所以撤销过的钥匙不能复活）；Send 发往任何地址且没有地址簿；多签只验领签人的 nonce；低于最低额的入金直接丢失（这里在钱离开之前就拒绝）。

### 三层协议

**A · 账户自己的指令协议**（`account/sign.ts`、`exchange.ts`）。形状是 Hyperliquid 的：信封 `{action, nonce, signature}`，EIP-712 类型化数据，真的签名（viem）。两类签名和它一样分开：owner 的动作是逐字段可读的类型化数据，一种动作一个类型；agent 的请求只有一个类型 `Agent(source, actionHash, nonce)`，由 owner 授权过的 agent 钥匙签。类型不重叠，所以 agent 钥匙签不出 owner 的动作。域名是这里自己的（`AgentAccountSignTransaction`，chainId 424242），在这里签的东西在 Hyperliquid 上无效；同一个编码器能恢复出 Hyperliquid 官方 SDK 测试用例里的签名人（一致性测试，只用公开的签名和地址）。nonce 用它的规则（每个签名人保留最高的 100 个；窗口前 2 天、后 1 天），另加几条：确认签名人有权之后才消耗 nonce，而且一条指令上每个算数的签名人的 nonce 都消耗；资金指令只在它自己标注的时刻前后十分钟内有效（不能签好留着以后用）；同一条指令重发返回第一次的结果，只执行一次（两位 owner 换个位置签，不是一条新指令）；进程重启后从账本里读回收过的指令，不收第二次；动作的字段必须恰好是签名覆盖的那些；指令**逐条进门**，一条跑完才收下一条，所以同时到的两条不会各自看到对方花钱之前的预算。owner 在页面上是浏览器里一把不可导出的 P-256 设备钥匙（WebCrypto，服务器只有公钥），在终端 demo 和测试里是一把 EOA。

owner 签的不只是意图：一笔划转的签名里带着**路线的哈希、最高费用、最晚到账时间**，执行时任何一项变了就拒绝，要求重签。人的批准也是一次签名：`approveCard` 同时写明卡号和这张卡将要放行的内容的哈希；放行时所有检查重跑；卡三十分钟过期（到点没人答，账户自己关掉它、放回它占的预算，迟到的批准收到 `E_ACCOUNT_CARD_EXPIRED`）；等批的卡占着它那份预算。放宽（切到 Beast、恢复账户、调时钟、跟页面 agent 说话）要 owner 签，收紧（切回 Guard、关账户）不用。

**B · 场所对接：每个场所一扇门**（`account/doors.ts`、`payments.ts`、`calendar.ts`）。一条指令被拆成几腿，每一腿翻译成该场所自己的请求（记在账本那一行的 `native` 里），链上的路一律经过链上钱包这个枢纽。每条跑道写明谁能发起：`agent` · `owner`（只认 owner 自己的签名）· `venue`（只能在场所自己的页面上发起，账户只能看着它到账）· `closed`。原生请求里**真的签了的**：交易所的 REST 调用（按各家的规则算 HMAC，密钥是模拟的）。**只构造、不签名的**：Hyperliquid 自己的动作和 CCTP 的 burn，前者要 Hyperliquid 账户所有者的钥匙，后者要链上钱包的钥匙，账户层两把都没有。

| 场所 | 钱进来 | 钱出去 | agent 的钥匙在那里是什么 |
|---|---|---|---|
| Alpaca（股市） | 只能在券商那边，用你自己的银行发起 ACH | 同左，只能提已结算的现金 | 交易钥匙，动不了现金 |
| Binance | 充值地址 | 只能在交易所自己那边发起：这把钥匙没有提币权限 | API key：读和现货交易 |
| OKX | 充值地址 | `asset/withdrawal`，只到白名单里自己的地址 | API key：读、交易、提币分开 |
| Hyperliquid | CCTP 进 CctpForwarder，0.2 USDC，最低 5 | `sendToEvmWithData`，只有 owner | `approveAgent`：能在自己的余额之间挪，不能提现 |
| MetaMask Agent Wallet（枢纽） | 链上转账、CCTP 铸币 | 转账、桥；受它自己的 Guard 约束 | 会话加策略 |
| Polymarket / Kalshi | 桥到 deposit wallet / ACH | 提回再桥 / ACH | CLOB key / RSA key |
| Ondo OUSG | USDC 到 KYC 地址 | 赎回 T+1，只转白名单地址 | 钱包委托 |

钱离开一处、还没到下一处的时候是**在途**：不在任何余额里，谁也花不了。链上的一腿几秒到几分钟，交易所提币几分钟。走 ACH 的场所（券商、Kalshi）只能在场所那边用你自己的银行进出，账户不经手，路由到它们一律拒绝并写明要在哪里做。多腿路线中途被拒是 `stranded`：钱在枢纽钱包里，付款单写明在哪、怎么挪回来。

**即插即用：把你已有的交易所钱包接进来**（`adapters/exchange.ts`、`doors.ts` 的 `EXCHANGES`、`fixtures/home/portfolio/connectable.json`）。owner 签一条 `connectVenue {venue, connector, label, credentialRef}`，一个新场所就出现在账户里：余额、跑道、agent 的权限一起出现，不改一行代码。`disconnectVenue` 拔掉。

- **连接器**是"怎么跟它说话"的一份声明，四种：`binance`、`okx`（各自的 REST）；`unified`（统一接口库 ccxt 覆盖的任何交易所：请求是库的调用，由库去写交易所自己的请求）；`wallet`（自托管钱包，比如交易所发的钱包 app 或硬件钱包：按地址接入，不交任何钥匙）。
- **门是编译出来的，不是写死的**：接入时问场所这把钥匙能做什么（读、交易、提币，提币白名单），门照答案生成。没有提币权限的钥匙，出金写的是"在交易所那边发起"；能提到自己验证过的地址的，agent 可以用；自托管钱包进钱 agent 可以做，出钱只有 owner 在那个钱包里签。
- 页面收的是**凭据放在哪**，不收凭据本身。
- 新插上的场所**不在任何已有的支出授权里**：授权里的"所有场所"指签字那一刻的场所，之后插上的要 owner 再点名。
- 有钱在途的时候不能拔；开户时就有的场所不能拔；拔掉不动交易所那边的凭据。
- 接入的范围是**钱包**：余额、进出、稳定币互换。不含下单路由。

终端 demo 里可插的四个（模拟的，只在 demo 和测试里；只认真实账户的服务器拒绝模拟连接器）：Bybit（`unified`，读和交易）、Kraken（`unified`，读、交易、提币，白名单里只有自己的链上钱包）、OKX 的第二个账户（`okx`，只读）、OKX Wallet（`wallet`，按地址）。

**真实连接：你真的场所**（`src/portfolio/live/`、`account/live-moves.ts`、`account/live-orders.ts`、`adapters/live.ts`）。上面那四个是演示用的；这里接的是用户真实的账户。每个有接口的场所一种连接，Portfolio › Accounts 里一行：

| 场所 | 怎么接 | 读 | 下单 | 动钱 |
|---|---|---|---|---|
| 交易所：OKX、Kraken、Coinbase、Binance、Bybit 等，统一接口库覆盖的一百来家 | 本机 home 目录里的钥匙文件（能交易、不能提币的 key） | 余额（交易与资金两个账本）、钥匙权限（OKX、Binance、Bybit、Coinbase 有接口说）、24 小时涨跌与成交额（OKX、Binance、Bybit、Coinbase、Kraken、KuCoin 按各家文档读它自己的字段；别家用统一接口库的统一读数，并标明是库的读法）、K 线、资金费率；OKX Simple Earn、Kraken Earn、KuCoin Earn 里的钱 | 现货和 U 本位永续；市价单按最差价格发成成交不了立即撤的限价单 | 提到你自己的地方、账本之间划转、稳定币互换；充值地址由交易所给，要先生成的（Kraken、KuCoin、Coinbase）账户替你调它的生成接口再读一次；放进 / 取出 OKX Simple Earn Flexible、Kraken Earn、KuCoin Earn（下面「Earn」） |
| Alpaca | 钥匙文件（key 没有权限可选；先用 Paper） | 现金、持仓 | 美股、ETF、加密；市价单按最差价格发成限价单，收盘时只接限价单 | 现金只能在 Alpaca 用 ACH；加密：Alpaca 给这个账户开了 Crypto Wallets API 的（接入时问一次 `GET /v2/wallets`），Receive 给出它在 Ethereum、Arbitrum 上的充值地址（没有就当场生成）；提币不从这里走——Alpaca 已把 Trading API 的加密提币接口下线（2026-10-09 日落），加密在 Alpaca 的 app 里提到那边白名单过的地址 |
| Robinhood 投资账户 | Robinhood 自己的登录页（它的 Trading MCP 服务器，OAuth：动态注册、PKCE），令牌只在内存里 | 各账户的现金和股票持仓 | 只在 Agentic 账户里、整股；市价单按最差价格发成限价单 | 无：钱只在 Robinhood 自己的 app 里进出 |
| Robinhood Crypto | 钥匙文件：API key 加你自己生成的 Ed25519 私钥 | 购买力、持仓，按 Robinhood 自己的中间价 | 加密；市价单按最差价格发成限价单 | 无：它的 API 不动钱 |
| Kalshi | 钥匙 id 加私钥文件（RSA-PSS 或 Ed25519 签名；权限 `read` + `write::trade`） | 现金、持仓（按它市场此刻的价格，已裁决的按 $1 或 $0；Kalshi 只报成本，成本写在旁边） | 事件合约，走 2026 年的 V2 下单接口（YES 腿上的买卖；它已经没有市价单，账户的"市价"是成交不了立即撤的限价单） | 无：它的 API 不动钱 |
| Polymarket | 账户钱包的钥匙文件（Polymarket 钱包的还要 `funderAddress` 和 `signatureType`），或者只填地址看 | 持仓与 pUSD | 事件合约，CLOB V2 的签名订单；每接一次、每下一单之前先问 Polymarket 自己的地区检查，不服务就拒，不找别的路 | 用钥匙接的：Receive 给出下单钱包的地址收 Polygon 上的 pUSD；从别的 EVM 链打 USDC / USDT，给 Polymarket 的桥为这个钱包生成的专属充值地址（先问它的 `/supported-assets` 这条链收不收这个币、最低收多少——低于最低额它不处理；答案留 10 分钟）；出金仍在 Polymarket 那边：CLOB 没有提币接口，桥的提币是 Polymarket 钱包自己发的一笔 pUSD 转账。只填地址看的：不给地址 |
| 浏览器钱包：OKX Wallet、Binance Wallet、MetaMask 等 | EIP-6963 发现，钱包签一句话证明地址是你的 | 六条 EVM 链上的 USDC、USDT 和链上原生币；Robinhood Chain 上的 USDG 和 Stock Tokens；最常见的 Ondo Stocks 与 xStocks | 七条链上换币（六条对 USDC，Robinhood Chain 对 USDG）：LI.FI 找路线，钱包自己签、自己发；买入时先授权到这一单最多花的钱；**代币化股票**也在这里买卖（下面「RWA」） | 同链发送；**跨链**（下面） |
| MetaMask Agent Wallet | 本机已登录的 `mm` 命令行 | 余额、Guard 策略、`mm earn` 金库里的钱 | `mm swap`、`mm predict`，和 Hyperliquid 永续 `mm perps`（先过它自己的地区线，下面「永续」），都还要 MetaMask 自己的开关 `PORTFOLIO_MM_WRITES=1`；从不传 `--yes` | `mm transfer`、`mm earn supply / withdraw`，同样要那个开关 |
| Robinhood Wallet（自托管） | 地址（手机钱包，没有浏览器扩展。WalletConnect 能让它签名，但要一个在 Reown Cloud 注册的 project id，这里没做；所以只能看，不能证明） | 同浏览器钱包，含 Stock Tokens | 无 | 无 |
| Hyperliquid | 地址 | 永续与现货账本 | 无：Hyperliquid 只认账户自己钥匙的签名，按地址接的这条只读、不写（"connected by its address, it is read, never written"；不再断言它服不服务这个地区）。永续经 MetaMask Agent Wallet 的 `mm perps` 下（下面「永续」），每一单先按它自己的使用条款 §1.6 查这台机器在哪，不服务的地区就停下，不找别的路 | 无 |
| Ondo（OUSG、rOUSG、USDY） | 地址 | 代币数量，按 Ondo 自己链上预言机的价格 | 无：申购赎回在 Ondo 那边 | 无：只能在 Ondo 白名单地址之间转 |

**跨链**（`live/bridge.ts`、`live/wallet-bridge.ts`）：从你证明过的钱包，把美元稳定币挪到另一条链上：同一个钱包在那条链上、另一个证明过的钱包，或者你交易所在那条链上的充值地址。LI.FI 找路线（Across、Stargate、Circle 的 CCTP），每条路线在给钱包看之前，都对着它自己的 calldata 查一遍：付给的就是那个地址（LI.FI 的记录和桥合约自己的收款字段都要对上）、在链上合约算出的最少到账不低于 97%、不带目的链上的调用、带的原生币只是桥费。账户签的是最便宜的那条，执行前再问一次，手续费涨过签的就不发；钱包发出后，交易哈希对着构造的那笔核对（发送人、合约、调用、币、链），对不上不跟；到账以 LI.FI 和链说的为准（到了、换成另一种稳定币到了、退回、还在路上）。"Move…" 里的 "Across chains" 列出各条路线的费用、最少到账和大约多久；交易所提币时 "Fees on every network" 把每条链的手续费并排列出，点哪个就用哪条链。Robinhood Chain（4663）上的美元是 Paxos 的 USDG，不是 USDC：往那里桥的是 USDG，走 Across（LI.FI 在这条链上只给这一座桥），而且 LI.FI 在那条链上的合约和别的链不是同一个地址，每一项检查都认钱离开的那条链的合约；没有桥能送的，LI.FI 自己的理由就是拒绝。桥进、桥出 Robinhood Chain 都走同一扇门：桥按它自己的链表（`BRIDGE_CHAINS`，含 Robinhood Chain）放行，直接发送和提币仍只在付美元的那六条链上。

**比价**（`live/compare.ts`）：同一个币或同一只股票，在你接上的每个场所按这一单会成交的价格排（买看卖一，卖看买一）：BTC、XBT、WBTC、cbBTC 都算 BTC。四秒内没答的场所列在后面，离其他场所价格太远（超过 10%）的标出来让你核对，可能是同名的另一种代币。一个名字既是币又是股票时（BTC、ETH 也是两只美国上市信托的代码），`asset`（`stock` | `crypto`）说比哪一个：知名币的名字默认比币；别的名字比多数场所列的那一边，另一边写进 `missing`，并说怎么问。下单票的 Where 就按它排：你接上的场所按这一单的成交价排，最好的在前、默认选它；只在 Crypto、Stocks、RWAs 三面比（Stocks 问 `asset=stock`），每一面只留自己种类的行（行上的 `category` 分得出发行方站在背后的代币和币，一只股票的 Where 里不混进同名的代币）；永续和 Pre-IPO 不比价（Pre-IPO 各家的单位不同，Where 每家写它自己的隐含估值）。agent 用 `portfolio_live_compare`（可带 `asset`）。手续费不猜。

钥匙文件放在 home 目录里（默认 `~/.buyer-agent-demo/credentials/<场所>/api-key.json`），必须只有本人可读（`chmod 600`），页面只传文件在哪，值不进页面、账本和任何返回。接入时先问场所的公开时钟（不带钥匙），场所不服务这个地区就在这一步停下，钥匙不发出去；统一接口库对 Kraken Futures、Phemex 没有时钟调用（它的基类回 NotSupported），这一步就跳过，地区和钥匙的规矩由接下来的权限读或余额读来碰——以前这一步把这两家整个挡在外面。对账单页上，真实场所顶替同名的模拟场所，拔掉后模拟的回来；读数缓存半分钟，读失败时保留上一次的数并写明时间和原因。没应答的场所整个被搁 20 秒不再问，说不服务这个地区的搁 10 分钟；连接器抛了异常算场所没答（`E_VENUE_UNREACHABLE`："answered in a way the account could not read"），异常文字只进服务器的日志，不上线。

**下单（真钱）**（`account/live-orders.ts`、`live/trade.ts`）。机场要能起降：接上的账户上，owner 和 agent 都能真的下单。默认打开，`--read-only` 关掉，`--live-cap 50` 改单笔上限（默认 $100，一单和一笔转账都按它算）。每个场所说它自己的话（交易所的统一接口库、券商的 REST、预测市场的签名订单、DEX 聚合器给钱包构造的交易），账户只看一个形状：这个场所交易哪些市场、一个市场此刻的价格和最小单位、下一单、撤一单、它后来怎么样了。一单要过这几道：

- 市场以美元计价（USD 或美元稳定币），这样上限和额度才是美元；开着；场所接受这样写的单（最小数量、数量步长、价格步长、它收的单子类型）。不合格的在场所看到之前就拒（`E_VENUE_ORDER_INVALID`）。
- 按场所此刻的价格估值，不超过服务器的单笔上限；市价买单按卖一价算，再留 2% 给价格变动。
- owner 下单：签的是确切的数量、限价（市价单为空）、这一单最多值多少美元、十分钟有效期。执行前再问一次价格，涨过签的上限就不下（`E_ACCOUNT_REQUOTE`）。签名里的链名是 "Live · real money"。
- agent 下单（`agentLiveOrder`，MCP 的 `portfolio_live_order`）：要在 owner 给它签的**交易额度**里（`approveSpend` 的 `trade` 范围：哪些场所、每单多少、一共多少、到什么时候）。Guard 下每一单都是一张卡，卡上是数量、价格和价值，owner 签了才下；Beast 下额度内直接下。挪钱的额度（`venues`）不等于交易额度，反过来也一样。额度上的窗口（`windowHours`）是每个场所每个窗口一单（改一张已挂的单不算第二单，超了是 `E_MANDATE_RATE`）；随一个意图签的额度带着意图的 id（`approveSpend.intent`），摘要里写 " · for intent-0003"。
- 撤单从不出卡：agent 能撤自己下的单，owner 能撤任何单（撤 agent 的单时页面先问一次）。没成交的部分退回 agent 的额度。owner 把 agent 的单改大到超过它的额度，账户拒绝："give it a bigger limit under Agents, or grow the order by less"。
- 平仓：卖掉现货持有的平仓就是一张卖单，按每单、总额、窗口算进交易额度（Guard 出卡，超了拒绝）；只减仓的衍生品平仓不算预算，但仍按模式出卡。agent 改一个有持仓（谁的都算）的市场的杠杆：Guard 出卡，Beast 在每单额度内直接改、超了出卡。
- 场所自己的规矩照旧：钥匙权限（比如交易所钥匙没开交易）、余额、风控、地区。它的拒绝就是答复。
- 下单只在一个场所之内换手（美元换成 BTC、股票换成现金），钱不会因为一单离开场所。

**动钱**（`account/live-moves.ts`）也是同一个开关：

- 服务在终端打印一个配对码，第一个浏览器要输入这个码才成为 owner（不再是"谁先打开谁就是"）。
- 每一笔都是 owner 的一次签名，签的是**账户替你向目的地场所要来的那个地址**、场所报的手续费上限、十分钟的有效期；执行前再问一次场所，地址或手续费变了就不执行。签名里的链名是 "Live · real money"。
- 钱只去你自己的地方：交易所自己给的充值地址，或签过那句话的钱包。粘贴进来的地址只能看，不能收钱。
- agent 请求（`agentLiveMove`、MCP 的 `portfolio_live_move`）：Guard 下每一次都变成一张卡，卡上是地址和手续费，owner 签了才走；Beast 下额度内直接执行，目的地照样只能是你自己的地方，单笔上限照旧；它的支出授权都要覆盖两端。
- 场所自己的规矩照旧：钥匙权限、提币白名单（第一次提到新地址，多数交易所要你先在那边加白名单）、它自己的风控。它的拒绝就是答复。
- 不跟模拟的钱混：账户上只有真实场所，真钱在它们之间一步走完，不经过任何模拟的枢纽。

从这台机器不带钥匙问过一次（2026-10-05）：Binance 回 451、Bybit 回 403，都写明按地区拒绝；OKX、Kraken、Coinbase、Binance.US 正常应答。各家的下单接口在 2026-10-05 按它们自己的文档和官方 SDK 核对过（Kalshi 今年把下单换成了 V2、去掉了市价单；Polymarket 4 月 28 日换成 CLOB V2；mm 7.0.0 的 `swap quote --yes` 会直接执行），每家一份规格，测试对着替身逐字段断言请求。

Robinhood 的三条线都是它自己发布的接口（2026-10-05 读）：股票走 5 月 27 日开放的 Trading MCP（`agent.robinhood.com/mcp/trading`，它的授权元数据写明支持动态注册、PKCE、刷新令牌，所以账户层能像 Claude Code 一样自己接上去）；加密走 Crypto Trading API（签名与官方文档的示例逐字节一致，见测试）；Stock Tokens 的清单和报价在 `api.robinhood.com/rhj/` 下，不要钥匙。Robinhood 的 MCP 工具返回什么格式没有公开，股票这条线按它自家 API 常用的字段名读，读不出来时直说读不出来，不当作零。

**Earn（真钱）**（`live/earn.ts`、`account/live-earn.ts`）。四家有接口，每家说自己的话；交易所的理财没有统一接口，所以一家一家接：OKX、Kraken、KuCoin 做了，Binance 的 Simple Earn 有接口但不做——它对这台机器回 451：

| 场所 | 产品 | 它自己的规矩 |
|---|---|---|
| MetaMask Agent Wallet | DeFi 金库，经 `mm earn`（LI.FI 的 earn 接口），id 是 `<链 id>:<金库地址>` | 从钱包出、回到钱包、在金库自己的链上；锁仓不到 $1,000,000（或说不出）的金库只能取、不能放 |
| OKX | Simple Earn Flexible，id 是 `savings:<币>` | 只有资金账户的钱放得进去，取出也回资金账户；读要 Read，放、取要 Trade |
| Kraken | Kraken Earn 的策略（Kraken 自己的 id） | 放、取要 Earn Funds，是异步的，它的状态接口说做完了才算；要 Intermediate 认证；全账户自动的策略（Kraken Rewards）不能分配；只有它自己的 `EEarnings:` 才算拒绝，忙、nonce 这类答复让请求留在途中、额度照占着 |
| KuCoin | KuCoin Earn 的产品（活期 DEMAND 随时取，定期 TIME 到期取；id 是它自己的） | 从交易账户放进、取回交易账户；读产品和持有要钥匙的 General 权限，放、取要 Earn 权限；取出是 PENDING，KuCoin 交付了才算完，`hold-assets` 看得见；取之前先 `redeem-preview`：提前赎回要没收利息的，账户不替你确认，把 KuCoin 报的数写进拒绝 |

- owner 签 `liveEarn {venue, kind, product, asset, amount, maxUsd, lands, deadline}`：放入（`supply`）或取出（`withdraw`）、确切数量、这一笔最多值多少美元、取出落在哪（永远是它来的那个场所，没有一个调用带目的地）、十分钟有效。签名里的链名是 "Live · real money"。
- agent 签 `agentLiveEarn {venue, kind, product, asset, amount}`（取出可以写 `"all"`），要在 owner 给它签的 **earn 额度**里：`approveSpend` 的 `earn` 范围，点名场所（`okx`）或一个场所的一个产品（`okx:savings:USDT`），从不是「所有账户」（`*` 在 prepare 和门口都拒）。Guard 下每一次是一张卡；Beast 下额度内的放入直接走，取出在每笔上限以内直接走，超了出卡。放入算额度，取出不算（钱只是回来）。
- 两样都过：服务的写开关和 `--live-cap`；产品此刻开着、收这个币、够最小额；取出不超过持有的；场所自己的钥匙权限、等级、地区。MetaMask Agent Wallet 还要它自己的开关 `PORTFOLIO_MM_WRITES=1`，和它的换币、下单一样。
- 每一笔是一条 earn 记录（`earn-0001`）、Statement 里一行（类型 Earn）、账本一行；重启后没做完的接着问，不重发。
- **只算一次**：持有里多一类 `earn`（`earn:<场所>:<产品>`，"earning 5.2% at OKX"），算在总数里，不算现成可用的钱。同一笔钱在场所余额里另有一行的，那一行去掉：Kraken 把分配出去的钱在余额里记成 `<币>.B/.F/.S/.M/.P`；钱包里金库的份额代币（按链上读来的符号认，认不出时按名字加价值）；OKX 的 Simple Earn 本来就不在资金余额里，什么都不去。earn 和余额一起重读，读失败时保留上一次的数、标 stale，不会掉成零。
- 页面上：Earn 是 Portfolio 的一个弹层（`ui/earn.js` 的 `openEarn`），从右边 Cash ready 的 "Earn…" 打开（接上的场所里有做 earn 的才有这个按钮）：Put in / Take out，每个产品一行（APY 或 APR、锁定天数、取出落在哪、里面有多少；此刻不收钱的标 "Closed" 和它的理由），数量和 "Max"，Take out 还有 "All of it"（签进去的是 `"all"`）；签完弹层原地重画。Assets 里 earn 行下面的 "Withdraw…" 打开同一个弹层的 Take out，产品已经选好；弹层里的 "Hand to agent" 交一件 earn 的事。Statement 的 Earn 类型和 "into earn / out of earn" 合计。agent 用 `portfolio_earn`（读）和 `portfolio_live_earn`（写）。

**RWA：发行方站在背后的代币**（`live/dex.ts`、`live/address.ts`、`live/explore.ts`）。代币化股票是钱包 DEX 交易者里真的市场：下单门把一单建成钱包的两笔交易（授权、swap），每一单建之前先问发行方一次（答案留一分钟）。符号证明不了什么（LI.FI 在 Robinhood Chain 上的清单里就有不是 Robinhood 的 "NET" 和 "BULL"），所以每一种按地址认，按发行方自己公布的认：

| 发行方 | 在哪 | 怎么认、下单前怎么再确认 |
|---|---|---|
| Robinhood Stock Tokens | Robinhood Chain，对 USDG（`NVDA/USDG@Robinhood Chain`） | 地址在 Robinhood 自己的清单上（`/rhj/assets`），LI.FI 的清单有没有都行；清单没应答就拒 |
| Ondo Stocks | Ethereum、BNB Chain，对 USDC | Ondo 清单上最常见的，加上 LI.FI 认证过的 `<TICKER>on`；读链上 Ondo 的 `gmTokenAccepted` 和这个代币的 `isTokenPaused`：暂停了是 `E_VENUE_MARKET_CLOSED`，不认是 `E_VENUE_REJECTED` |
| xStocks | Ethereum、BNB Chain、Arbitrum、Optimism，对 USDC | xStocks 清单上最常见的，加上 LI.FI 认证过的；问 xStocks 不带钥匙的公开接口 |
| OUSG、BUIDL | 显示，从不 swap | 合约只在发行方批准过的钱包之间转，swap 送不到：`E_VENUE_TRANSFER_RESTRICTED`，带发行方的原话 |

每个市场带着 `issuer` 和发行方自己的资格原话（`eligibility`：Ondo 说美国人和它禁止的辖区里的人不能申购、取得、赎回；xStocks 说不面向美国和美国人）。这些发行方都排除美国人和别的一些地方；账户不知道它的主人住在哪，所以原话跟着每个市场走：Markets 的行下面一行小字、市场抽屉里的 Issuer 一栏、下单票 RWAs 一面在 Where 下面的发行方框里说一次；发行方关了或限制的，原话写在签名按钮上方，按钮不让按。发行方合约的拒绝（制裁名单、黑名单、暂停）按发行方自己的规矩报。Solana 上的 Ondo 和 xStocks 不提供：这里的钱包是 EVM 地址。钱包还不认识 Robinhood Chain（回 4902）时，页面提出替你加上链 `0x1237`。钱包接上以后也读 Robinhood Chain 上的 USDG（算美元）和上面这些代币（算 RWA，按 LI.FI 的价）。

**永续：Hyperliquid，经 mm，先过它自己的地区线**（`live/metamask.ts`）。市场写成 `<COIN>-PERP`（`BTC-PERP`），经 `mm perps`：`markets` 读标记价、资金费率、最大杠杆；`open --type market|limit --leverage`（市价单是 Hyperliquid 的 IOC，限在最差价以内；限价单 GTC 挂着）、`orders`、`cancel`、`positions`、`close`（它自己的 reduce-only IOC）、`modify --leverage`。mm 7.0.0 没有永续的地区检查，所以每一单、每次平仓、每次改杠杆之前，账户先用 `mm predict geoblock` 问这台机器在哪（只留国家和地区），按 Hyperliquid 使用条款 §1.6 判：美国、安大略和受制裁地区它不服务。条款没写受制裁地区是哪些，这里按古巴、伊朗、朝鲜、叙利亚和乌克兰被占领地区算，是这边的读法。在里面就是 `E_VENUE_GEOBLOCKED`，mm 说不出在哪就是 `E_VENUE_REJECTED`，两种都什么都不发，也不提供任何绕过的办法。写操作同样要 `PORTFOLIO_MM_WRITES=1`。页面上是 Trade 的 Perps 一面：Long / Short、标记价、资金费率和下次支付、这里最多几倍、保证金约等于名义除以杠杆、你在这里的持仓（方向、倍数、强平价、开仓价）；Leverage 一行一直摆在票上（它是永续的主控件）：场所能从这里设的，杠杆是下单前单独一次签名（`liveLeverage`），不能的写 "As set at the venue" 和你持仓的倍数；agent 不超过你签的倍数。

**Pre-IPO：一家还没上市的公司的估值上的永续**（`live/preipo.ts`、`live/public-markets.ts`、`live/explore.ts`、`live/exchange-trade.ts`）。这是合约，不是股份：场所把一家私有公司的估值缩小成一个价格，一份合约约等于公司估值的十亿分之一（Bybit 2026-07-13 上线 ANTHROPICUSDT 时自己这么说），所以 2,080 的价格就是约 $2.08 万亿的隐含估值；不换手任何股份（OKX 明说持有人没有股权）。

- **哪些场所、怎么认**：六家不带钥匙就能读（2026-10-06 从这台机器读过）：OKX、Gate、Kraken Futures、Deribit、KuCoin Futures、MEXC。每家按**它自己记录上的标记**认，不按名字猜：OKX 的 `ruleType: "pre_market"`；Gate 的 `is_pre_market` 加上 `contract_type: "stocks"`（它的 B200、H100 GPU 价格指数和 BP 代币也是 pre-market，不是公司）；Kraken Futures 的 `category: "Pre-IPO"`；Deribit 的 `underlying_type: "preipo"`；KuCoin Futures 的 `marketStage: "PRE_MARKET"` 加上 `assetClass: "STOCK"`；MEXC 的 `conceptPlate` 里有 `mc-trade-zone-preipo`。每家的清单十分钟读一次，再每个合约一个小的价格请求（几百字节，KuCoin 的约 2 KB；留 90 秒）；Gate 的服务器不压缩，所以按公司名一家一家问。一家公司在各家叫不同的名字（ANTHROPIC、Deribit 的 ANTH、Kraken 的 ANTHROPICx、MEXC 的 KIMISTOCK 是 Moonshot AI），`PRE_IPO_COMPANIES` 认得 Anthropic、OpenAI、Anduril、Neuralink、Figure AI、Kalshi、Polymarket、Oura、Moonshot AI (Kimi)、YMTC；场所标了、表里没有的，按场所自己的名字列。SpaceX 永远不算：它 2026-06-12 已在 Nasdaq 上市（SPCX）。
- **单位按合约算，不按场所**：各家都是 $1 的价格对 $1,000,000,000 的估值，只有 OKX 的 ANTHROPIC-USDT-SWAP 和 OPENAI-USDT-SWAP 在 2026-06-30 做了 10:1 的 rebase，是 $1 对 $10,000,000,000（2026-10-06 读到 OKX 的 ANTHROPIC 214.51，别家 2,074–2,140；它八、九月才上的 MOONSHOT、OURA 和别家一样是 $10 亿的单位）。场所的每个合约（一个 `Market`，`portfolio_live_markets` 读到的也是它）带 `implied {perPoint, unit, usd}`：$1 代表多少、单位的那句话、这个价格隐含的估值；Markets 的行和行里每个场所那一条带 `implied {usd, unit}`。
- **一家公司一行**：Markets 的 Pre-IPO tab 里每家公司一行（`group.id` 是 `preipo:<slug>`），每个场所一条，各写它自己的合约价和按它自己单位算的隐含估值；离群检查（离中位数超过 10% 的排除）对隐含估值做，不对合约价做，不然 OKX 的 ×10 会被当成另一种东西；这一行的 `implied.usd` 是各家的中位数，`price` 是这个中位数按 $1 对 $10 亿写的。Perps tab 不列它们。
- **谁能交易、会变成什么**：各家自己定，接上钥匙时用它自己的话说，它的拒绝就是答复（都不对美国人开放；Kraken 还排除 EEA、加拿大、澳大利亚、新西兰，在英国只对专业客户）；账户里没有一张各家资格原话的表。各家都承诺：申报文件公布股数以后按每股重新定价，上市那天转成股票永续。
- **公司自己的话**：Anthropic 和 OpenAI 都说过，没经它们同意的股票转让无效（Anthropic，2026-06-29：没有董事会批准的出售或转让，包括股票里的任何权益，一律无效、不记入它的账；OpenAI：没有它的书面同意，股权不能直接或间接转让，代币化的权益和持有它股权的 SPV 也算在内）。原话在 `PRE_IPO_ISSUERS`，跟着它们的行走：Markets 行下的小字、抽屉的 Issuer 一栏、下单票 Pre-IPO 面的公司框。
- **怎么交易**：接上这几家之一的钥匙（统一接口库：OKX、Gate、MEXC、KuCoin Futures、Deribit、Kraken Futures），它的 pre-IPO 永续就是一个普通的 U 本位永续，按它自己的标记打上 category、公司、单位和发行方的话，排在这把钥匙起始清单的后面；Markets 把它和公开的几家并进同一家公司那一行，接上的那一家不再读它的公开源。Bitget、Phemex、Binance、Bybit 的钥匙没有这里读的标记，按公司名整词认。下单、改杠杆、平仓都是永续那几扇门（`liveOrder`、`liveLeverage`、`liveClose`），agent 用同样的工具。连接表单 "Another exchange" 的目录把 Kraken Futures、KuCoin Futures、Deribit、Phemex 排进了前面那一排，各在它的现货兄弟旁边。
- **IPO 的问题在 Predictions**：Kalshi 的 KXIPOANTHROPIC、KXIPOOPENAI 两个 series（各取最忙的那个市场；卡上的分类是 Kalshi 自己给 series 的标签 "IPOs"），Polymarket 按它的 `ipo` 标签读 5 个最忙的、列 3 个（分类 "IPO"）。它们是 Predictions 的行，不管成交量都排在最热的那几张旁边；Pre-IPO 一家公司的抽屉里 "IPO markets" 一段列出名字里带这家公司的那些，Yes / No 打开 Predictions 的票。
- **读多少**：pre-IPO 和 IPO 问题加起来，一轮（90 秒）在线上约 110 KB（2026-10-06 量的：各家清单十分钟一次摊下来、每个合约的价格、两家 IPO 的读）。
- **没做的，和为什么**（2026-10-06 的调研）：PreStocks（Solana 上 SPV 背书的代币）：要一个 Solana 钱包，账户里没有，而且 Anthropic 和 OpenAI 都说转给 SPV 的无效；Hyperliquid HIP-3 的 io:ANTH、io:OAI：是真的，但下单经 Hyperliquid，从这台机器被它自己的地区线挡住，这里只读它自己那一组永续，不读 HIP-3；Lighter：要一种新的钥匙连接器（它自己的签名库，不是统一接口库）；Aster：太薄；Binance、Bybit：也上了，但对这台机器回 451、403（按地区拒绝），Markets 底下照它们的原话写；Bitget、Phemex：这里没有读它们的标记，接上的钥匙按公司名认；Forge、EquityZen、Clarity（原 Hiive）、Jarsy、Republic、Robinhood 的 OpenAI 代币：没有能接的接口；Coinbase International Exchange：2026-10-01 起只读，它的 pre-IPO 永续接到了 Deribit；SpaceX：已经上市。没接的场所的 pre-IPO 永续还没有 K 线：这六个公开源不给历史，抽屉的图那里写一行；接上钥匙以后，K 线由统一接口库读它自己的。

**C · agent 对外付款：agent 不付钱，账户替它付**（`account/protocols.ts`、`payees.ts`）。agent 只签一句"为这个 URL 付钱，最多这么多，从这个 float 出"（`agentPay`）；账户自己去问收款方，从收款方自己的质询里读出价格和收款地址，说收款方说的那种协议，用 agent 从来拿不到的钥匙签付款。检查顺序：

1. 授权：这个 agent、这个 host。在给这个 host 发出第一个字节之前。
2. 来源：属于这个 agent 的 float。
3. 收款方的要价：不超过 `maxAmount`；收款地址等于已经钉住的那个。
4. 额度：单笔、预算、拨盘（会话、Guard 的日上限）、float 余额、应用抽成不超过 owner 给它批的费率。
5. owner：**第一次付给一个收款方出一张卡**，卡上是付给谁、哪个地址、多少钱；owner 的签名覆盖这些字段，批准即把这个地址钉住。之后地址变了是拒绝，不是再问一次。
6. 付款，然后把回执对着记账的那本账核对，不听收款方一面之词。

| 协议 | 搭了什么 | 模拟的收款方 |
|---|---|---|
| x402 V2 `exact` | 402 与 `PAYMENT-REQUIRED`；float 的钥匙签 EIP-3009 `TransferWithAuthorization`；facilitator 的 verify 与 settle；`PAYMENT-RESPONSE` | `data.sim`，行情接口，每次 $0.01 |
| MPP `charge` | `WWW-Authenticate: Payment` 质询（id 是对自身参数的 HMAC，对上了规范的测试向量）；`Authorization: Payment` 凭证，EIP-3009 的 nonce 是质询的哈希；`Payment-Receipt` | `infer.sim`，每次 $0.02 |
| MPP `session` | 托管合约：签一笔 EIP-1559 的 `open` 交易存一次押金，之后每次调用签一张累计凭单（EIP-712 `Voucher`），关闭时收款方按最后一张凭单取走、其余退回；收款方不理时向托管合约申请退出，宽限期后取回 | `infer.sim`，每次 $0.01 |
| AP2 v0.2 | 商户签结账 JWT；账户把 owner 的支出授权写成两份**开放式** mandate（SD-JWT，`cnf` 绑定 agent 的钥匙）；agent 用自己的钥匙签两份**封闭式** mandate（绑定开放式 mandate、校验方和这一次交换）；商户和账户（作为凭据提供方）各自验链；商户和它的处理方各签一张回执 | `shop.sim`，从 float 付 |

一个协议配一个模拟收款方是这个 demo 的安排（每个协议演一次），协议本身没有这个要求。卡支付（ACP、Visa 的 Trusted Agent Protocol）没搭：卡没有给个人的接口。只认真实账户的服务器上没有这些模拟收款方：`agentPay` 只从 agent 钱包付真钱（x402 V1/V2、MPP charge，USDC，见上面「随时能被 agent 调用」），MPP session 和 AP2 在真钱上不做。

### 页面和 agent 面

`/`（`/account` 也跳到这里）就是 Account：一个桌面钱包，左边一条 rail，右边是当前的那一屏。

**外壳**（`public/account.html`、`ui/shell.js`、`ui/core.js`）

- **Rail**：三个屏 Portfolio · Markets · Trade（Portfolio 旁边的数是等你批的卡加 agent 的请求，浏览器标签页的标题也带着，比如 "(2) Account"）；**Mode**：Guard | Beast 两个按钮，下面一行说这一档的意思（"What agents ask for waits for you on a card." 或 "Inside their limits, agents act at once."），再下面 "What changes ›" 打开 Mode 弹层（只有这里打开它）；"Agents"（数是敲门等放行的 agent）、"Settings"；最下面一枚 "Trading on" 或 "Read-only"，账户不应答时多一枚 "Not answering since HH:MM"（恢复就撤），和纽约时间的钟。单笔上限不挂在 rail 上：Settings 的 Trading 一句写它，超了的时候拒绝说它。没有 "+ Trade" 按钮；Background 在 Settings 里。
- **顶栏**：**Lens**（All accounts / 一个场所 / 一个 agent：三屏的每张表都按它筛；它指的场所或 agent 不在了就回到 All）· 搜索（`/` 聚焦，打字就去 Markets 搜；20 秒一次的刷新既不冻住也不清掉它）· 时钟图标打开 **Statement**。没有 Menu，它的每一项都有一个家：Connect an account 和余额 CSV 在 Portfolio › Accounts，复制 agent 命令在 Agents 弹层，背景在 Settings，模式在 rail。键盘 `t` 打开下单票，Esc 关掉 lens 菜单或抽屉。
- **弹层**：一个 sheet（`dialog#modal`）、右边一个不挡页面的抽屉（一个市场，Portfolio 的资产行打开的也是它；或一个账户的 Details）、一个叠在上面的小问话框（`confirmSheet` / `pickSheet`：页面上没有一个 `prompt()` 或 `confirm()`）；结果是 toast，拒绝用场所或账户自己的话。**"What you sign"** 照旧：签之前把要签的每个字段原样摆出来，它是信任的核心。
- **Mode 弹层**（`ui/agents-mount.js` 的 `openMode()`）：最上面还是那两个按钮（Guard 是一次免签的 `POST /api/mode {mode: "guard"}`，Beast 是 owner 的一次签名 `setPolicy mode open`）和一句 "Guard: what agents ask for waits for you on a card. Beast: inside the limits you signed, it goes at once. Guard is one click; Beast is signed."；下面一张表，三列 "An agent, inside its limit" · Guard · Beast，现在这一档那一列高亮、列头带 "Now"；最后一行是两档都一样的："In both modes: anything over a limit is refused · your own actions are yours to sign, up to $100.00 each · a card nobody answers in 30 minutes expires."（金额是这个服务的 `--live-cap`）。表的十行来自服务器，是 `GET /api/account` 的 `modeRules.rows`（`account/mode-rules.ts`，每一行照那扇门自己的代码写）：下单或改大一单、平掉现货 / 股票 / 合约的持有、平衍生品、有持仓时改杠杆、在你的账户之间挪钱、放进 earn、从 earn 取出、从 agent 钱包付钱、撤自己的单、没有持仓时设杠杆；30 是 `modeRules.cardMinutes`，和卡过期用的是同一个常数（`CARD_TTL_MS`）。页面不自己写这张表，所以不会和门对不上；agent 在 `portfolio_account` 里读同一张。真实账户启动时是 Guard。Guard、Beast 是给人读的词；线上的值没变，`/api/account`、`/api/account/agents` 和 MCP 里仍是 `guard` | `open`（签过的行和旧账本按它读）。
- **Statement 弹层**：一行一笔：成交、提现、划转、跨链、换币、Earn。按月份、账户、类型、Who（你，或哪个 agent，按钥匙认）筛；最后一行是这一屏的合计（买、卖、挪、into earn / out of earn、手续费；被拒的不算）；"Download CSV" 带 agent 一列；"Print" 只打印流水。还没完的单不在这里，在 Trade 的 Under way。流水从账本文件读，重启以后还在。
- **Settings 弹层**：Trading（开着、单笔上限多少，启动时定的；或只读）、Agents' session（"Start a new one" 或 "Renew for 30 days"，一次签名）、Their leverage（agent 能设的最大杠杆，一次签名；有接上的场所能从这里设杠杆时才有）、Background（**Cream / Black**，米白或黑，记在这个浏览器里，第一次绘制之前就生效）、Devices（"Let it sign"；每个打开过页面的浏览器都以 "A browser asked to sign" 出现，最多 10 个在等、没有清理、重启才清空；"Require both" 撤掉了，等有了给第二个签名的流程再回来）。
- **Agents 弹层**（`ui/agents-mount.js` 的 `openAgents()`：另一个团队的 Agent 模块从这里挂进来）：放 agent 进来、交易 / 挪钱 / 付款三种额度和 earn 额度（"End earn limit" 只收回 earn 那一份）、"Everything"、撤销；Agent wallets（"Make it"、"Top up…"、"Take back…"；agent 钱包没有 Disconnect，账户握着它的钥匙和钱，清空用 "Take back…"）；最下面 "Add an agent" 一行的 "Copy agent setup command"（复制 `/api/account` 给的 `agentSetup.command`：`claude mcp add portfolio -e PORTFOLIO_URL=<这个服务> -- npx tsx <仓库的绝对路径>/src/portfolio/mcp.ts`，在哪个目录跑都行）。行为和原来一样，等对方的模块来替换。
- 每 20 秒读一次，只重画看得见的那一屏；有弹层开着、正在签名、或者正在表单里打字时不刷新；标签页藏起来时停。

**Portfolio：你有什么**（`ui/portfolio.js`、`ui/earn.js`、`ui/money.js`；读 `/holdings?cost=1`、`/history`、`/positions`、`/agents`、`/earn`、`/sellable`、`/receive`）

- 一个账户都没接时，整页是 "Get started" 三步：Connect an account → Connect an agent（"Copy setup command"，有 agent 在敲门时 "Let it in…"）→ Give it a limit；接上以后三步没做完之前，它缩成左栏最上面的 "Next steps · n of 3"。
- **Net worth**：一个数，下面**一行**变化，跟着右边的范围（1D / 1W / 1M / All）走：1D 是今天，按每个持仓自己市场报的 24 小时涨跌算；别的按曲线的历史算，比第一个点还早的写 "since <日期>"。脚注收在旁边一个 ⓘ 里：24 小时变化覆盖了多少（有持仓没有场所报的就写明，不估）、在途的钱算在数里、agent 付出去的不算亏、接拔不算变化、某个场所用的是上一次的好数。**曲线**从第一个快照开始，不到两个点不画，指针下面读出那一点；lens 是一个场所或一个 agent 时数字是那一部分的，曲线换成 "Show all accounts"（曲线是整个账户的）。
- 快捷操作 Trade · Move · Receive · Hand to agent，只在有账户（或 agent）做得了时出现。
- 三段，段头右边是这一段的工具：**Assets**（跨场所按资产汇总：交易所的 BTC、Arbitrum 钱包里的 WBTC、券商的 BTC 是一行，名字下面是在哪些场所；Amount · Price · 24h · Value；earn 的钱是自己的一行，写在哪、年化多少，下面 "Withdraw…"；点一行打开**那一个抽屉**，和 Markets 的是同一个；工具 "Sell many…"）· **Positions**（Position · Value · Entry · Mark · Liquidation · P&L，右边 "Close…"，币、股票、合约这些持有是 "Sell…"）· **Accounts**（Account · Value · Status：第一枚是健康，✓ Answers / ✗ Not answering（悬停看场所最近一次的原话）/ Not read yet，后面是 Trades、Moves money、Receives、Earns、Watched，钥匙不能交易的那枚写场所自己的话；**Open to agents** 开关：关掉免签（`POST /api/revoke`，agent 在那里只剩读），重新打开放宽了它能做的，是签名的 `setPolicy restore`；"Details"；工具 "Connect an account" 和 "CSV"（每个账户的持有））。`#/portfolio?view=positions` 直接打开那一段。
- **Account 抽屉**（"Details"）：价值和状态；"Trade…" · "Move…" · "Receive"（只列这个账户）· "Show only this"（lens 换成它）· 钥匙不能交易时 "Connect a new key"（先确认，签 `disconnectVenue`，再按这家自己的连接、用同一个名字和同一个钥匙文件重新接）；Holds（它持有的）、From here（它从这里交易什么、能怎么动钱、为什么不能，最近一次答了还是失败了）；最下面 "Disconnect…"（确认后签 `disconnectVenue`）。agent 钱包没有它：账户握着它的钥匙和钱，清空用 Agents 里的 "Take back…"。
- 右栏：**Waiting for you**（卡按 agent 分组：每张一句它要做什么、值多少、"answer by HH:MM"（时间一张卡只说一次），"What it asks" 展开是要签的字段，"Reject" / "Approve"，同一个 agent 两张以上有 "Approve all N"：先确认一次，再每张卡一次 `approveCard` 签名，一张被拒就停；agent 的请求每条有 "Grant…"（打开 owner 自己的那张表：额度是 `approveSpend`，钱包是 `createSubAccount` 或一笔充值，会话、杠杆、模式是 `setPolicy`，放进来是 `approveAgent`）或要接场所的 "Connect"（那家自己的连接表单），和 "Decline…"（一次 `answerAsk` 签名）；敲门的 agent 有 "Let in…"）· **Agents at work**（你开着的意图和每个 agent 最新的回报，"Change words" / "Withdraw"；下面是 agent 最近的五件事，✓ 做了、✗ 被拒；"Statement" 打开流水）· **Cash ready**（一个数，一行 "$x can move between your accounts."；有做 earn 的场所时右上 "Earn…"）· **Allocation**（一条配置条和图例）。
- `#/portfolio?card=<id>`：别处的 "Review"（Trade 的 Under way、市场抽屉的 Agents on it）带人到这里，那张卡滚进视野、描一圈边，过一会儿退掉（系统要求减少动画时只跳不滑）；没有这张卡就只是打开 Portfolio。
- **Sell many**（Assets 的工具 "Sell many…"，`ui/earn.js` 的 `openSellMany`）：`/sellable` 列出不是美元的持有（这一刻卖不了的不列，只写一行有几个），最多勾 10 个、各填数量，"Review" 先列出每条要签什么，再 "Sign and sell N" 逐条签名（永续和期货是 `liveClose`），每条各有各的结果，一条被拒不影响下一条；签的过程中弹层不重画；钱包 DEX 的那条交给钱包发。不新增签名类型，每条照样过上限和额度。Earn 弹层见 B 层的「Earn」。
- **Receive**（`openReceive`，读 `/api/account/receive`）：一张平的清单，蓝本是 MetaMask 的 Receive。最上面一个搜索框和一行警告（"Send only the asset on the network the row names: anything else may not arrive."），下面一行一个"账户 × 网络"：钱包（agent 钱包、证明过的钱包）只有一行，写 "All EVM networks: Base, Arbitrum, Optimism, Polygon, Ethereum…"，因为同一个地址在每条链上都一样；按地址接、证明过的 Polymarket 钱包一行 Polygon · pUSD；交易所每条网络一行，带一个资产选择（交易所每种资产给不同的地址），默认是它持有最多的那种美元；用钥匙接的 Polymarket 也是每条网络一行（Polygon 上是下单钱包的地址，别的 EVM 链是它的桥给这个钱包的专属地址）。地址在那一行滚到眼前时才去问（同一个场所的一个接一个），完整显示，"Copy"，要 memo 的带 memo 和它自己的 "Copy"，下面一行是场所的话：交易所自己的充值地址（交易所要先生成的，账户替你生成再读）、开了 Crypto Wallets 的 Alpaca 的钱包地址、证明过的钱包和 agent 钱包自己的地址。给不出地址的账户（只看的地址、只读的钥匙、不收钱的场所）在最底下各一行，用它自己的话。快捷操作的 Receive 列全部，Account 抽屉的只列那个账户（"All accounts" 回到全部）。它只说往哪打，打钱仍是一次签名。
- **净值历史**（`account/networth.ts`）：每五分钟一个点，接上或拔掉一个场所时一个点，重启接回场所后一个点，写在 `<home>/portfolio/networth.jsonl`（0600）；值没变、上一个点又不到一小时就不写；有场所的数是上一次的，这个点标 partial。它是派生数据：不进哈希链账本，什么都不从它恢复、不由它决定，丢了只丢一条曲线。接上不是赚、拔掉不是亏：变化按两点之间都在的场所算，接拔另记成事件标在曲线上；账户自己付给收款方的钱加回来，并写明；你在场所自己网站上的充值和提现，账户看不见，算在变化里，所以它是"变化"，不是"收益"。第一个快照之前的不知道，也不补。
- **成本价**（`account/costbasis.ts`）：只用两样，账户自己下过的单（每一次运行的账本里，一单每变一次记一整行，按一笔一笔的成交算）和场所自己报的入场价（券商、预测市场、永续）；场所报了的，以场所的为准。币跨场所是一堆（在一家买、在另一家卖的是同一个 BTC）。不知道的就写不知道：没价格的成交不算、场所没报的手续费不猜，账户之前就有的、从别处转进来的币，成本账户没见过，所以每一行写着覆盖了多少。

**Markets：有什么可以交易**（`ui/markets.js`、`ui/asset.js`；读 `/explore`、`/quotes`、`/candles`、`/compare`、`/asset`）

- 一张表把**接上的场所**和**没接的场所的公开行情**合在一起（`live/explore.ts`、`live/public-markets.ts`）。公开源不带钥匙、只读：Kraken、Coinbase、OKX、Binance（Bybit 问到才问）的公开 ticker；Hyperliquid 的永续（一个固定的 `metaAndAssetCtxs` POST，每个写成 `<COIN>-PERP`，接上 MetaMask Agent Wallet 以后经 `mm perps` 在那里下）；Kalshi 按一张短名单里的 12 个 series 各读一次 `/events?series_ticker=`（10 个忙的，加两个 IPO 的；不再读 `/markets?limit=1000`：它只给最新的一千个市场，联储决议那个从来不在里面）；Polymarket Gamma 的 `/events` 按 24 小时成交额取前 20 个事件、让 Gamma 去掉 Sports 标签，再一次 `tag_slug=ipo` 读最忙的 5 个 IPO 问题；Robinhood Stock Tokens 的 `/rhj/`；六家的 pre-IPO 永续（B 层的「Pre-IPO」）。每个源一共四秒，没答完的写进 missing，用场所自己的话（Binance 对这台机器回 451、Bybit 回 403，就写成那样；没答的那家搁 20 秒不再问，说不服务这个地区的搁 10 分钟）。没接的那一家的行标 **"Connect to trade"**，点了就是那家的连接表单，接上以后下单票自动挑它。同一个东西是一行：币按统一名（BTC/USDT、BTC-USD、WBTC 是一个 BTC），事件按问题（YES、NO 收进一行），pre-IPO 按公司，离其他场所中位价超过 10% 的当作同名的另一种东西排除（pre-IPO 比的是隐含估值）。数字只用场所自己报的：Kraken 不给 24 小时涨跌就不显示，Kalshi 的成交量是合约数（`contracts24h`），不换成美元；公开行也列买一卖一；Kalshi 标题里的 markdown 星号去掉。
- 分类 tab 只显示有东西的：**All · Crypto · Stocks · RWAs · Perps · Pre-IPO · Predictions**，和 Trade 的六面同样的词、同样的顺序；另有 "Watching"（关注了东西才有），搜索时多一个 "All results"。没有 Sports tab，Macro 并进了 Predictions；没有 Now，也没有 Venues（`?tab=now`、`?tab=venues` 的旧链接落到 All；接上、拔掉、对 agent 开关都在 Portfolio › Accounts）。**All** 是一张表，每一行都在里面，事件也是一行（问题、倒计时、领头那个结果的 ¢）；别的 tab 里事件是卡，其余是表。每个列表上面可以排：Most traded · Biggest moves · Closing soonest（有会收盘的东西时才有），在页面上排，不再问账户。Perps 不列 pre-IPO 永续，它们只在 Pre-IPO。场所自己的分类词只在 `live/categories.ts` 一张表里读：哪些词显示在卡上（"Economics"、"Fed Rates"、"IPO"、"IPOs"），哪些词的事件整个不列（体育、电竞、天气、娱乐、名人、"will X say"——用户不想看的赌局角落），哪些是场所的内务标签。
- 表的列：★ · Market · Where · Price · 24h · Volume，和**一个**按钮：能下单的是 "Trade"（打开 Trade 的票，种类跟着这一行），只有公开行情的是 "Connect to trade"，都不行的是 "Can't trade here · why"（打开抽屉说全）。"Hand to agent" 在抽屉里。pre-IPO 的行 Price 一栏先写隐含估值（标 "implied"），合约价在下面一行小字。看得见的行和卡，在接上的场所的，页面看得见时每 5 秒问一次价（`/quotes`，一次最多 12 个），数字在原地改；Trade 屏选市场的那几行也由这个轮询报价。
- 列表底下**一行** "Why these, and what's not shown ⓘ"，折着：展开是每个源怎么选的（`notes`）、没答或不服务这里的场所（用它们自己的话）、只读服务的那一句；折着还是开着，留着你上次的样子。
- **Predictions 是精选的几个最热的**，不是场所的全部：Kalshi 按名单上的 10 个 series（Fed decision、CPI、CPI YoY、GDP、jobs、bitcoin、S&P 500、Nasdaq-100、2028 Dem nominee、Trump approval）各取最忙事件里最忙的一个市场，Polymarket 按 24 小时成交额的前 20 个事件去掉被排除的词和一小时以内的 "Up or Down" 后留 10 个，两家轮流各出最忙的，一共最多 12 张卡；IPO 的问题（Kalshi 的 Anthropic IPO、OpenAI IPO，Polymarket 最忙的 3 个）不管成交量都排在旁边；Closing soonest 也只排这几张；搜索时不受限，搜的是读进来的每一个市场。列表底下的 `notes` 写明每个源怎么选的（"Kalshi: the busiest market in each of 10 series — …"、"Kalshi: and Anthropic IPO, OpenAI IPO — the busiest market of each."、"Polymarket: its 10 busiest events by 24-hour volume, without sports, esports, weather, entertainment, awards and mentions."、"Polymarket: and its 3 busiest IPO questions (its tag IPO)."、"Predictions: at most 12 rows, each venue's busiest in turn, without sports, weather and entertainment; a search reaches everything the venues' listings loaded."、"Predictions: and the IPO questions at Kalshi and Polymarket, beside the busiest few."）。倒计时每秒走，只改那几个字；收盘了就重读，十五分钟一轮的市场接到下一轮。Kalshi 过了 `close_time` 的腿按关闭算，卡上用场所自己的话（没有就是 "the market is closed now"）；Polymarket 过了 Gamma 估的 `endDate` 还在交易的，卡上写 "Past its end date · still trading"。一次公开行情读多少：Kalshi 每个 series 15 KB 到 600 KB（bitcoin 的最大），Polymarket 一次约 2.9 MB，加交易所的公开 ticker 和 Stock Token 清单；答案留 90 秒（Stock Token 清单 10 分钟），页面每几秒问一次也不会每次去场所。
- agent 读到的 `/explore` 里仍有 `movers`（24 小时涨跌，成交额至少 $1M、永续至少 $10M，一个资产一枚，现货优先于同名的永续）、`closing`、`mostTraded`；页面上它们是排序。
- ★ 是一次 `setWatch` 签名；只在公开行情里看到的市场，按接上以后会是的那个场所记。Watching 列你关注的全部，★ 悬停写 "Watching since <日期>"。
- **那一个抽屉**（`openMarket`；Portfolio 的资产行经 `openAsset(key)` 打开的也是它，没有单独的 Asset 抽屉）：头上是名字、倒计时、价格和 24h（只说一次，写是哪家的 24h）、Bid / Ask / Volume 24h / Funding / Leverage / Closes、RWA 和 pre-IPO 的 Issuer 一栏、事件的每个结果（各有 "Buy Yes" 这样的按钮）、"Buy" · "Sell" · "Hand to agent" · ★（"Watch" / "Watching"），做不了时一块 "Can't trade it here" 写为什么；然后是**图**（`/api/account/candles`：接上的场所用它自己的，没接的用公开数据，5m / 1h / 1d；读不到时一行安静的字，用场所的话）· **Across venues**（每个场所的价格，接上的按 `/compare` 排，能下的有 "Trade"，只有公开行情的有 "Connect to trade"；pre-IPO 每家写它自己的合约价、隐含估值和单位）· **IPO markets**（只在 pre-IPO 公司的抽屉里：名字里带这家公司的预测市场，Yes / No 打开 Predictions 的票）· **You hold**（每个场所持有多少、持仓和 "Close…" / "Sell…"、挂单和 "Cancel"，平均成本只说一次）· **Agents on it**（agent 等你批的卡和 "Review"（去 Portfolio 那张卡）、它们的单、你的意图和最新的回报）· **On the statement**（最近八行，"Open the Statement →"）。每一部分单独重画。

**Trade：在一个市场里建一个仓位**（`ui/trade.js`、`ui/intent.js`）

- 一张下单票，按市场的种类分六面：**Crypto · Stocks · RWAs · Perps · Pre-IPO · Predictions**（和 Markets 的 tab 同样的词、同样的顺序，id 就是服务器的 tab id），屏顶一排按钮切。一种只在有东西时出现：接上的场所（lens 里的）说它交易这一种，或者这一种的读有行（公开行情也算，那些行写 "Connect to trade"）；只读的服务上价格照样有，签名按钮写只读的那句话。屏顶一行状态（"OKX, Kraken trade from here"、"Read-only: prices show, nothing is placed from here" 或 "No account trades from here yet"），一个都没接时一块 "Connect an account that trades"。路由 `#/trade?kind=perps`，再带 `venue`、`symbol`、`side`、`outcome` 就直接打开那张票（一次）；旧的 `?tile=` 也认（`trade`、`swap` 落到 Crypto，`perps`、`predictions` 落到同名的一面，`earn`、`sellmany` 打开 Portfolio 的那两个弹层）。Trade 里没有 Swap、Earn、Sell many、Move、"Do it myself | Hand to agent" 开关、Positions 和 Recent fills：手里的钱的事在 Portfolio，持仓在 Portfolio › Positions 和抽屉里，成交在 Statement。
- **选市场**（浏览在 Markets，这里只是挑）：这一种自己的搜索框（`/explore?tab=<种类>`），下面三组：**You hold**（这一种你持有的，跨场所合起来；永续和 Pre-IPO 是持仓）· **Recent**（这个浏览器里最近在这一种上挑过的，每种最多 12 个）· **Most traded**（这一种最忙的 6 个；Pre-IPO 每家公司一行，先写隐含估值）。价格在原地跳；场所的拒绝写成一行它的原话。换种类时三组淡出淡入（系统要求减少动画时不动）。点一行，右边就是它的票。
- **一张票**（`openTicket({kind, venue, symbol, side, outcome, …})`，在右边那块不随刷新重画的面板里），头上是这一面的标签。从上到下：Market（这一种的搜索）→ 选中的市场和 "Change" → 事件的结果 → **Where**（你的场所按 `/compare` 的成交价排，最好的标 "Best"、默认用它，可以换；比价只在 Crypto、Stocks、RWAs 三面，每面只留自己种类的行；不能交易的场所写它的话和怎么修；没接的写 "Public"，只有你哪个账户都不交易它时才给 "Connect to trade"）→ **这一面的说明块** → Buy | Sell（Perps、Pre-IPO 是 Long | Short）→ Amount 和 In（Dollars，或这个市场的单位：币、"Shares (whole)"、Contracts）→ **Pay with**（只在 Crypto 的买单、有得选时）→ Order（只列这个市场接受的：Market、Limit、Stop、Stop limit；预测市场的价格按 ¢ 填）→ Leverage（Perps、Pre-IPO）→ **Advanced ▸**（折着：Time in force、Post-only、Reduce-only，这个市场接受的才有；摘要一行写已经设了什么，没设就写这个场所对这种单的规矩，例如 Kalshi 的市价单 "A market order here fills now or is cancelled (ioc/fok)"；一样都不接受的市场没有 Advanced）→ 报价 → "What you sign" → "Sign and place"，最下面 "Hand to agent instead"。挑到另一种的市场，票和屏顶的种类跟着它换。没签完的票存在这个浏览器里 24 小时（种类、场所、市场、方向、数量、Pay with、单型和价格，从不存签过的东西），重开时场所还接着、还能交易、市场还在才放回来，否则默默丢掉。
- **每一面的说明块**（在 Where 下面，这一种市场买之前该知道的）：
  - **Crypto**：买一卖一和 24h；从钱包换的，路线、滑点和 gas 用钱包那边的话；在交易所就不多说。
  - **Stocks**："Open now" 或 "Closed"，后面是场所的原话（Alpaca 收盘时写什么时候开、为什么这时不下市价单）；只做整股的写 "Whole shares only here."；同一只股票有代币时一行 "Also as a token: … → RWAs"。
  - **RWAs**：发行方框（谁发的、它的资格原话，只说这一次）、"Paid in USDC" 或 USDG，钱包在几条链上都有它时一个 Chain 选择，路线自己的那句话；同一只股票在券商有时一行 "Also as shares: … → Stocks"。
  - **Perps**：标记价和 24h、资金费率和下次支付、"up to Nx here"、填了数量和杠杆时保证金约多少（"Margin ≈ $X for $Y at Nx."）、你在这里的持仓（方向、倍数、强平价、开仓价）。Leverage 一行一直在：场所能从这里设的，填倍数和（场所列了的）Margin，"Set leverage…" 是下单前单独一次签名（`liveLeverage`）；不能的写 "As set at the venue" 和持仓的倍数。
  - **Pre-IPO**：永续那一套，前面加 "Implied valuation ≈ $2.1T" 和一份合约多少钱、单位那句话、"Becomes a stock perpetual at the IPO; the venue rebases when the share count is public."，后面是公司自己的话和最后一句 "This is a contract on a valuation, not a share."；没接钥匙、没有市场可挑时，这一块从 Markets 的那一行说。Where 每家写它自己的隐含估值和单位，不比价。
  - **Predictions**：先选结果（Yes / No，或场所列的几个），再 Buy | Sell；"N contracts pay $N if Yes · cost ≈ $X · the market gives it 62%"（还没填数量时说一份多少 ¢、到期兑 $1 或 $0）、离收盘多久（每秒走）和纽约时间、只卖得了持有的场所写 "Sells only what you hold · N held"。
- **Pay with**（Crypto，买）：先是这个币在这个场所对的几种美元（换一种美元就是换到那个市场），再是你在那里持有的别的币。挑一个币就是**两步、两次签名**：先把它卖成两个市场共有的那种美元（钱包的话在同一条链上），等成交（每两秒问一次，最多一分半钟），按实际到手的钱（扣掉手续费）准备买的那一腿，给你看过以后第二次签名，按钮先是 "Sign the sale (1 of 2)"，再是 "Sign the buy (2 of 2)"；一分半钟里没成交，买的那一腿就等着，卖单在 Under way 里。一种美元换另一种美元不是交易：Move 的 "Swap stablecoins"（Portfolio）。
- **Under way**：一张表给所有种类（Order · Status · 动作），按 lens 筛：挂着的单（"Change"、"Cancel"；钱包要发的单 "Send from wallet…"）、在途的钱（钱包要发的 "Send from wallet…"）、放进或取出 earn 的、agent 等你批的卡（一行 "Waiting for you"，唯一的按钮是 **"Review"**，去 Portfolio 那张卡）；两单以上有 "Cancel all N"（先确认，每单一次签名）。
- **Close**（`openClose`）：在哪里点（Portfolio › Positions、市场抽屉）都是同一个对话框：`quote.close` 给出值多少、最差价；超过服务的单笔上限时，后端自己的拒绝写在签名按钮上方、按钮不让按，再给一个按市场步长取整、刚好在上限以内的数量。
- **Hand to agent**（`openHandToAgent`）：在 Trade 屏上它占右边的面板，头上是这一面的标签（只是页面上的，签的东西里没有它），"Do it myself instead" 回到票；别处是一个弹层。票上的 "Hand to agent instead" 把种类、场所、市场、方向、结果和美元数带过去。给哪个 agent（或所有 agent）、在哪、什么市场、哪个方向、大约多少、你的话（最多 200 字）、到什么时候；可以附一份额度（`approveSpend` 的 `trade`，交的是 earn 时是 `earn`），并写明它会**替换**这个 agent 现在那一份（后端每个 agent 每种范围只留一份）。话和额度是两段 "What you sign"：先签话、拿到它的 id，再签带着这个 id 的额度（`approveSpend.intent`），Agents 列表和额度摘要里写 " · for intent-0003"。开着的意图列在 Portfolio 的 Agents at work，带每个 agent 最新的回报，可以 "Change words"，可以 "Withdraw"：收回话的同时收回随它给的额度（按额度上的 `intent` 认；老的没带 id 的额度按同一个结束时间认）。

**引导 agent，不授权**（`account/sign.ts` 的 `STEER_TYPES`、`state.ts`、`exchange.ts`）。五种签了名的话，都不在 `MONEY_TYPES` 里，额度（`covers`、`spendFor`）一样都不读：

- `setWatch {venue, symbol, on}`（owner）：关注一个市场，接没接的场所都行；最多 50 个。
- `setIntent {id, agent | "*", venue, symbol, side, usd, text, validUntil}`（owner）：给一个 agent 或所有 agent 的话；`usd` 只是引导，什么都不限；最多同时开 20 个，话最多 200 字，最长 180 天，`validUntil` 为 0 是收回。
- `agentReport {intent, status, note, refs}`（agent）：`taking` / `done` / `cannot` / `note`；`refs` 只能是它自己的单和付款；一个 agent 在一个意图上最多 50 条，不会盖掉别的 agent 的。
- `agentAsk {kind, venue, usd, text}`（agent）：`letIn` · `limit` · `venue` · `topup` · `session` · `leverage` · `mode`。只在内存里、一天过期；同类同场所的再问替换旧的；一共最多 20 条、每个 agent 最多 5 条、每把钥匙一小时 5 条。陌生钥匙的 `letIn` 把它报的名字带进敲门列表（不能是、也不能像账户上某把钥匙的名字）。owner 做了对应的签名动作（`approveAgent`、`approveSpend`、`createSubAccount` 或一笔充值、`connectVenue`、`setPolicy`），那条请求自己关掉。
- `answerAsk {ask, decision: "decline"}`（owner）：不给，只关掉；拒掉的在 `declinedAsks` 里留一天（内存里），agent 的 `portfolio_watchlist` 看得见 `declined: true`。
- 重启后关注和意图接回来（逐条重新验签），请求和拒掉的请求不接。agent 写的字一律转义、限长、去掉看不见的字符；工具描述里写明意图什么都不授予：权限仍然只来自额度、卡和 `--live-cap`。

**新的读接口**（都只读，`server.ts`；同一个 Origin / Host 守卫）：

| 路由 | 一句话 |
|---|---|
| `GET /api/account` | 原来那份，加上 `agentSetup`（加这个 MCP 席位的那一行命令）、`health`（每个场所最近怎么答的）、`dial`（会话、关给 agent 的场所、最大杠杆）、`watch`、`intents`、`asks`、`declinedAsks`、`earns`、`modeRules`（Mode 弹层那张表：`rows` 是每扇门 Guard 和 Beast 各怎么做，`cardMinutes` 是一张卡等多久）；卡和流水行带 `agent` / `agentName`；`venues[]` 带 `connector`、`trade.kinds`、`earn`；`spend[]` 带 `intent`（随哪个意图签的，有才带）；门收的三张表 `dollars`、`networks`、`bridgeChains`（账户认的美元稳定币、它们所在的链、桥能到的链）和 `real: true`。真实账户上每个场所**不带** `runways` / `agentKey` / `in` / `out` / `swaps` / `fiat` / `ledgers`，顶层不带 `destinations`——那些是模拟门的词 |
| `GET /api/account/explore?tab=&q=&sort=&limit=` | Markets：接上的和没接的场所合成一张表，加 tab 计数（`tab` 是 all · crypto · stocks · rwas · perps · preipo · predictions，不带是全部）、movers、closing、mostTraded、missing、notes；pre-IPO 的行和它每个 `at` 带 `implied`；`limit` 只收 1–200 的数字；留 30 秒 |
| `GET /api/account/statement` | 流水：真实场所上的每一笔，跨这个账户的各次运行，最新的在前；只读账户自己的运行链和带运行标记的账本 |
| `GET /api/account/compare?base=&side=&usd=&asset=` | 比价：同一个币或股票在接上的每个场所按这一单会成交的价格排；`asset`（`stock` 或 `crypto`）说一个既是币又是股票的名字指哪一个，别的值不理 |
| `GET /api/account/markets?venue=&q=` · `GET /api/account/market?venue=&symbol=` | 一个接上的场所交易什么；一个市场此刻的价格、最小单、步长、开没开 |
| `GET /api/account/exchanges` · `GET /api/account/keyfile?kind=&venue=&ref=` | 统一接口库覆盖的交易所（连接表单用）；一个钥匙文件在不在、权限对不对、缺哪些字段（只看字段名，不读值） |
| `GET /api/account/signin/status?state=` | Robinhood 的 OAuth 登录走到哪一步 |
| `GET /api/account/holdings?cost=1` | Portfolio：按资产跨场所汇总、现成可用的钱、24 小时变化和它的覆盖；`cost=1` 加成本价和持仓 |
| `GET /api/account/history?range=1d\|1w\|1m\|all` | 净值曲线：点、接拔事件、`changeUsd`、`paidOutUsd` |
| `GET /api/account/receive?venue=&asset=&network=` | 往哪里打钱能落到这个场所 |
| `GET /api/account/asset?key=&interval=` | 一个资产：它那一行、各场所价格、K 线、持仓、挂单、流水、成本 |
| `GET /api/account/quotes?pairs=venue\|symbol,…` | 最多 12 个市场的新价格；多了是 409，账户自己的拒绝 |
| `GET /api/account/sellable` | 不是美元的持有，各自卖掉要签什么 |
| `GET /api/account/agents` | 一个 agent 一项：钥匙、额度（用了、占着、剩下）、卡、单、付款、earn、钱包、意图、请求、航班 |
| `GET /api/account/candles?venue=&symbol=&interval=` | 一个市场的 K 线（5m · 1h · 1d）：接上的用它自己的，没接的不带钥匙读公开数据；venue 只能是账户认识的 id，symbol 只是文字，碰不到固定以外的 host；留一分钟 |
| `GET /api/account/earn?venue=&asset=` | Earn：各场所的产品、里面有什么、读不到的场所 |
| `GET /api/account/positions?venue=` | 一个场所的持仓；不带 venue：所有能列持仓的场所，读不到的在 missing |
| `GET /ui/<name>.js\|css` | 页面自己的脚本和样式：只认 `ui/` 下一个简单的名字，带目录、多一个点或百分号编码的一律 404 |
| `GET /fonts/<name>.woff2` | 页面自己的字体（SIL Open Font License，`public/fonts/OFL.txt`）：只认一个简单的名字和 `.woff2`，留一年；页面不再从别的 host 拿字体 |

同一个查询参数给两次是 400（"given more than once"）。页面自己的 POST（不是读）：`/api/account/wallet/challenge`、`/wallet/prove`（钱包证明地址）、`/signin/start`（Robinhood 的登录）、`/bridge-routes`（一笔跨链能走的路线）、`/live/order-sent`、`/live/order-requote`、`/live/sent`（钱包发出了哪笔交易），和 Robinhood 把浏览器送回来的 `GET /api/account/signin/callback`。`/api/` 下的答复浏览器不缓存（`no-store`）。页面自己的文件每个进程只从磁盘读一次，按浏览器要的压缩（brotli 或 gzip）发出，带内容的弱 ETag：页面本身每次重验（`no-cache`），它引用的每个脚本和样式都带内容的哈希（`?v=`），这样问的留一年（`immutable`），不带或带旧哈希的重验；字体（`public/fonts`，名字里带版本）留一年。服务内部出错回 500，正文永远是同一句 "The account hit an error answering this; it was recorded."，异常文字只进日志。

**MCP 工具**（`src/portfolio/mcp.ts`，stdio；席位持一把自己的 agent 钥匙，每次写都签名）。真实账户上：

| 工具 | 一句话 |
|---|---|
| `portfolio_account` | 这个席位看到的账户：钥匙放进来没有、四种额度（`trade` · `venues` · `payees` · `earn`）和各剩多少、每个场所它能交易什么、账户上的单（自己的标 `mine`）、付款（`mine`）、按资产的持有（`assets`）、现成可用的钱（`readyCashUsd`）、**自己的**卡（`waitingForOwner`；别人的只给个数 `othersWaiting`）、可以接的场所（`connectable`）、owner 的模式（`mode`：`guard` 是 Guard，`open` 是 Beast）和 `modeRules`（Mode 弹层那张表：每扇门两档各怎么做，一张卡等几分钟）。钥匙没被放进来时，以客户端的名字敲一次门 |
| `portfolio_overview` | 整个账户：总额、按类、按账户、流动性（真实账户上是每个场所对自己钥匙 / 钱包的说法，不按类型猜）、自己的卡、自己的航班；真实账户上不带模拟的阶梯和日上限，按资产的数看 `portfolio_holdings` |
| `portfolio_explore` | Markets 那张表；`tab` 是 all · crypto · stocks · rwas · perps · preipo · predictions；pre-IPO 每家公司一行，行和每个场所的 `at` 带 `implied {usd, unit}`（价格隐含的估值和单位的那句话；行的是各家的中位数，`price` 按 $1 对 $10 亿写）；IPO 的问题是普通的 predictions 行 |
| `portfolio_holdings` | Portfolio 的持有；`cost: true` 加成本价和持仓 |
| `portfolio_history` | 净值曲线 |
| `portfolio_asset` | 一个资产的全部 |
| `portfolio_candles` | 一个市场的 K 线，接没接的场所都行 |
| `portfolio_receive` | 往哪里打钱：场所自己给的地址，agent 改不了；只看的地址、不收钱的场所不给 |
| `portfolio_watchlist` | owner 的关注、给这个席位（或所有 agent）的意图和每个 agent 最新的回报、自己的请求（含一天内被拒的，`declined: true`） |
| `portfolio_earn` | Earn 的产品和持有 |
| `portfolio_live_markets` · `portfolio_live_compare` · `portfolio_live_positions` | 一个场所的市场、跨场所比价（可带 `asset`：`stock` 或 `crypto`，一个名字既是币又是股票时说比哪一个）、持仓（不带 venue 是所有能列持仓的场所，读不到的在 `missing`） |
| `portfolio_live_preview` | 一单或一笔挪钱现在会是什么、额度还剩多少、会出卡还是直接下还是被拒；什么都不下 |
| `portfolio_live_order` · `portfolio_live_amend` · `portfolio_live_cancel` · `portfolio_live_close` · `portfolio_live_leverage` | 下单、改单、撤单、平仓、设杠杆 |
| `portfolio_live_batch` | 最多 10 腿，每腿就是一个 `portfolio_live_order`：各签各的、各判各的、各答各的 |
| `portfolio_live_move` | 请求挪真钱（在 `venues` 额度里）；币是账户认的每一种美元稳定币（`STABLES`），桥的目的链含 Robinhood Chain |
| `portfolio_live_earn` | 放进或取出 earn 产品（在 `earn` 额度里） |
| `portfolio_pay` | 从 agent 钱包付钱（x402 / MPP charge） |
| `portfolio_report` · `portfolio_ask` | 给 owner 的话：回报一个意图、请求只有 owner 能签的东西；什么都不授予 |
| `portfolio_approval` · `portfolio_wait` · `portfolio_statement` | 卡的结果、等一张卡 / 一单 / 一笔钱变化（最多 55 秒；到了终态——卡答了、单完了、钱到了 / 失败 / 搁浅 `stranded`——直接回 `done`）、流水（`mine: true` 按这把钥匙认；账本行还没记钥匙的那段老记录退回按席位自己的名字认） |

真实账户上席位只注册上面这些。模拟对账单（`--classic`）和测试里的分层模拟上另有 `portfolio_read`、`portfolio_markets`、`portfolio_quote`、`portfolio_openness`、`portfolio_execute`、`portfolio_order`——样例场所、目录和路由器；分层模拟还多一个 `portfolio_transfer`（在门口签一笔模拟场所之间的划转）。它们只在账户**不是**真实账户时注册：席位启动时读一次 `/api/account` 来判断（读不到的当作真实账户），所以真实账户上的 agent 看不到这些工具，而不是看到了再被拒。原来的 `portfolio_execute` / `portfolio_order` 也改成签名后从同一个入口进；挂了这一层之后，HTTP 上未签名的写一律被拒绝。真钱走 `portfolio_live_move`：Guard 下它回一张卡，Beast 下额度内直接回付款单。

**一个席位看到的是它自己的，但席位之间不隔离。** 卡、卡放行了什么、可等的单和付款，工具只给这个席位自己的：这是 MCP 进程选择给它看什么，不是墙。服务只听 127.0.0.1，`/api/account`、`/api/account/agents` 这些读接口对这台机器上的任何进程都答；所有席位以同一个系统用户运行，读得到彼此的钥匙文件。席位能**做**什么从不靠它看到什么：每次写都用它自己的钥匙签名，过它自己的额度和 owner 的卡。

**替身账户**（`test/standin/`）：`npx tsx test/standin/ui-standin.ts --port 4821`（或 `.claude/launch.json` 里的 `ui-standin`；`--cap 250` 改单笔上限，`--tick 3000` 改价格多久动一次）。它和 `npm run account` 起的是同一个服务、同一个页面、同一扇门，只是每个真实连接够得着的东西都换成了替身：场所、公开行情、网络（每个请求都答"没有网络"）、链、收款方、`mm`，什么都不出进程。它在一个新的临时 home 里经门种好数据：三个场所（Stand-in Exchange：现货、永续、一个已有的 BTC 多头、两个 earn 产品，和一个 pre-IPO 永续 `ANTHROPIC/USDT:USDT`，Anthropic 的隐含估值，约 2,100，按 $1 对 $10 亿；Stand-in Predictions：几分钟到几天后收盘的事件，加一个十五分钟一轮的 "Bitcoin up or down"，和一个 IPO 问题 "Will Anthropic IPO before January 1, 2027?"；Stand-in Wallet：代币，其中一个 RWA），owner 自己的单和挪钱，一个叫 "Claude Code" 的 agent（放进来、额度、agent 钱包、额度内的一单、一张等你批的卡），两个意图、一条回报、两个请求、三个关注，以及七天的净值点。Markets 打开是 All；Pre-IPO 里一行 Anthropic：Stand-in Exchange 那条能 "Trade"，同一个合约在没接的 Stand-in Perp Exchange 上是 "Public"；它的抽屉在 "IPO markets" 里列出那个 IPO 问题。替身上没有券商，所以 Trade 没有 Stocks 那一面。跑着的时候价格在动、挂单会成交、止损会触发，agent 的卡没人答过期了会再问一次。终端打印页面地址、配对码和临时 home（停了也留着）；浏览器输入配对码后，替身的种子钥匙签一条 `convertToMultiSigUser` 把这个浏览器加成 owner。拒绝 4820。测试是 `test/unit/ui-standin.test.ts`。

### 十四个 beat

机场（八个场所的门）→ 钥匙（未授权、到期、撤销、撤销后不能复活；Hyperliquid 一致性）→ 一条指令只执行一次（重放、nonce、过期、被改过的信封）→ 在途（钱离开了，还没到）→ 只能回家（agent 钥匙出不去的几种情况；owner 用自己的签名从 Hyperliquid 提现）→ 股市（券商的现金只在券商那边动，owner 和 agent 都路由不进去）→ 额度（拆小了也过不去）→ 卡（agent 批不了自己的卡、批准时重查、过期）→ 地址簿（绑定链、冷静期、黑名单）→ float 与 Unified → 付 API（x402、MPP charge、MPP session；地址被换、加价、重定向、陌生的托管合约、收款方失联）→ 买东西（AP2 带 mandate，从 float 付）→ 插入一个交易所钱包（一条签名、不改代码；门由钥匙的权限编译；不在旧授权里；自托管钱包按地址）→ 账本当证据（签名能从文件里恢复、改一行断链、和场所流水对账）。

### 对抗审阅之后改掉的

写完之后请了两路独立审阅：一路对着跑起来的服务找洞，一路逐条核对协议原文。找到的问题都修了，每条留了测试；攻击那一路的复现原样留在 `test/attack/`，每个都写成"这次攻击必须失败"（现在一共三十个文件，后来几轮加的在本节最后）。主要的几条：

- 两条指令同时到，各自都通过了同一份预算（两笔 $600 过了 $1,000 的预算）。现在指令逐条进门。
- 两位 owner 的签名换个位置，被当成一条新指令又执行一次；重启之后旧信封可以重放。现在一条 owner 指令按内容认，账本里收过的不再收。
- 资金指令可以把时刻标到将来，签好留着以后用。现在只在标注时刻前后十分钟内有效。
- 收款方回答"付款失败"，却留着那张 EIP-3009 授权事后兑现；或者留着开 session 的那笔交易以后再广播。现在授权在过期之前一直占着预算，被兑现就记账；没被接受的开户交易当场作废（它的交易 nonce 被花掉）。
- 收款方收了钱、回一个读不懂的回执。现在先记账再说话。
- 一个不回应的收款方能让整个账户的入口等下去。现在等三秒。
- 授权里写"所有场所"，以后插上的场所自动进了授权。现在冻结在签字那一刻。
- agent 的钥匙被撤销后，它的 float 和它开着的 session 没人能收回。现在 owner 能关 session、能把 float 收回钱包。
- 协议核对那一路：OKX 提币的手续费是在金额之外另收的；CCTP 的 burn 是真的 calldata（带 `maxFee` 上限和转入 Hyperliquid 的 hook）；Hyperliquid 自己的动作只构造、不签（账户没有那把钥匙）；x402 的校验顺序、MPP 开户必须从零累计开始、AP2 遇到不认识的约束类型一律拒绝；股票卖出的结算日按交易日算（晚上八点以后的成交算下一个交易日）。

钱包这一轮（三支柱、引导、Earn、RWA、永续）的攻击是四个新文件，每个测试直接断言攻击不成：`steer-holes`（agent 冒签 owner 的意图或关注、收回的意图被重放回来、请求刷屏、冒用账户上钥匙的名字敲门、意图的美元或要额度的请求放宽了额度、回报互相覆盖或认领别人的单、人看不见而模型读得到的字符）、`earn-holes`（上限、earn 额度、取出夹带目的地、重放、Guard 出卡、mm 写开关、地区线挡住永续）、`seat-reads`（一个席位读另一个席位的卡和它放行的结果；最后一个测试钉住"读接口对本机任何进程都开着"这条边界）、`ask-candles-earn-holes`（只有 owner 能拒请求、K 线的参数碰不到固定以外的 host、earn 的钱只算一次）。代码地图和审阅查出来、已经修掉的：

- Kalshi 的持仓按成本算进净值。现在按市场此刻的价格，成本写在旁边。
- 不同席位能看到彼此等批的卡；`portfolio_statement {mine}` 在 owner 起的名字和席位的名字不一样时返回空。现在卡只给自己的，流水按钥匙认。
- Hand to agent 收回了话，随话给的额度还在。现在 "Withdraw" 一起收回，改话时话和额度的结束时间保持一致。
- Kraken 状态接口的一次抖动把 earn 请求标成被拒、放掉了额度。现在只有 Kraken Earn 自己的 `EEarnings:` 才算拒。
- mm 金库的锁仓下限只筛了列表，按 id 点名一个很薄的金库照样能放。现在产品本身标成不能放，取出不受影响。
- earn 额度写"所有账户"，会把不做 earn 的账户和 agent 钱包也算进去。现在 `*` 在 prepare 和门口都拒。
- 币的抽屉里点 "Sell" 会开出一个永续空单。现在币、股票、代币只从现货持有卖，永续只从它的持仓卖。
- USDG 不算美元，Robinhood Chain 上的单在门口被拒。现在它是美元稳定币。
- Agents 弹层看不见 earn 额度；"Grant…" 对一个做不了这件事的场所也默认全勾；Markets 的倒计时把 Trade 的按钮改成了 "Closed"；下单票自动聚焦让 20 秒刷新停了；"Connect to trade" 接上以后票上不出现新场所。都修了，各有一条测试。

再后来的三个文件：`earn-pair-holes`（earn 里的钱和场所余额只算一次：同名的份额代币不冒认别人的钱，迟到或失败的 earn 读数不和新的余额配对）、`ask-reworded-decline`（agent 改口再问是一条新请求，owner 对旧话签的拒绝不落到新话上）、`review2-account`（第二轮审阅在门、额度和重建上该成立的每一条：重启后场所没回来不锁死、没人答的卡到点自己过期、卖掉持有的平仓算卖单、owner 改大 agent 的单也过额度、撤销额度不关请求、名字是明文、金额不超过 15 位）。

### 这一层的诚实边界

- 终端 demo 和测试里的八个场所、可插的四个和三个收款方全部是本地模拟（只认真实账户的页面上没有它们）。请求按各家自己的格式构造，账户手里有钥匙的都真的签了名（哪些只构造不签，见上面 B 层），但**没有一个发给过真的对方**，所以这里没有任何互通性证明。费用、最低额、到账时间是 2026-10-04 从各家文档读来的报价，不是实测。
- 模拟里的钥匙是从源码里的标签派生的，是公开的：demo 展示的是检查，不是保密。真实账户上 agent 席位和 agent 钱包的钥匙是本机随机生成的文件（600），不是标签派生的；页面上 owner 的钥匙是浏览器不肯导出的真设备钥匙，第一次要输终端里打印的配对码，之后重启也还是它（配对行里记着它的公钥）。能写这台机器上 `~/.buyer-agent-demo` 的人，也能改账本和钥匙文件：本机文件系统是信任边界，和钥匙文件一样。
- agent 钱包是账户手里的一把热钥匙：最坏损失是你放进去的那笔钱。付款只付 USDC、只用 EIP-3009 授权（收款方的 facilitator 代付 gas）；MPP session 和 AP2 在真钱上不做。收款方先拿走授权、过一会儿才结算的，账户在授权过期前把那笔钱压在额度里，链上看到用掉了才记账；重启的那一刻还没过期的授权不会被接着盯（最多一分钟、一笔的钱）。
- 对账单页上的脚本 agent 仍走旧的进程内路径（划转即时到账，陌生地址出卡）；带钥匙签名的入口走这里的新规则。两套规则并存。
- float 仍然是账户手里的一把热钥匙，约束它的只有它的大小。除了 session 的托管合约对押金的上限，这里没有一条规则是由链或场所替账户强制的。
- 券商的现金只能在券商那边用你自己的银行动，账户路由不进去。开这条跑道要的是券商合作方资格，不是代码。
- 插上的交易所显示的是交易所对这把钥匙的说法。经统一接口库没有一个调用能返回钥匙的权限：真的连接器在有专门接口的交易所问它（Binance 的 `apiRestrictions`），没有的只能从第一次被拒学到。自托管钱包只按地址接入：没有做浏览器里"连接钱包"的握手，出金那一步在那个钱包里的签名是模拟的。
- 资金指令的有效期以它自己标注的时刻为准、前后各十分钟：签名人把时刻往后标，最多换来二十分钟。
- 真实连接和真钱写入只对着替身测过：替身交易所、替身链、本地生成又丢掉的测试钱包，外加一次不带钥匙的公开时钟请求。**没有一把真钥匙、一个真钱包在这里用过**。接上你自己的账户之前，先用只读钥匙；要写，先用一个小上限和一个小金额。
- 钱包证明用的是 `personal_sign`。Binance Wallet 和 OKX Wallet 的文档没写它的行为；不支持的钱包只能按地址"看"，不能收钱。合约钱包（Safe 之类）的签名这里验不了，也只能看。
- Kalshi 的持仓按它市场此刻的价格算（Kalshi 只报成本，市场读不到价格时退回成本并写明）；按地址接的 Hyperliquid 永续账本是一个账户价值，不拆开持仓。
- **钱包这一轮里没有一笔是真的。** Earn、RWA、永续、Pay with 的两步、Sell many、净值历史、成本价、K 线、公开行情的合并，都只对着替身跑过：替身场所、替身链、记录下来的公开答复。真的只有不带钥匙的公开读（交易所的公开 ticker、Kalshi、Polymarket Gamma 和 CLOB 的价格历史、Robinhood 的 Stock Token 清单、xStocks 的公开接口、LI.FI 的报价）。没有一次真的 `mm earn`、`mm perps`、OKX 或 Kraken 的 earn 调用，没有一笔钱包在 Robinhood Chain 上发出的交易。
- Earn 只算一次靠的是去重规则：Kraken 余额里的 `<币>.B` 这类行、钱包里金库的份额代币，是按它们的文档和代码写的，真的余额里是不是这样出现没有亲眼见过。Kraken Earn 要它的 Intermediate 认证，OKX Simple Earn 只收资金账户的钱：场所的拒绝就是答复。
- 永续的地区线用的是 `mm predict geoblock` 说的位置（那是 Polymarket 的查询，mm 7.0.0 没有永续自己的），套 Hyperliquid 使用条款 §1.6；"受制裁地区"列了哪几个是这边的读法。说不出位置就不下。
- RWA 的资格是发行方的原话，账户不知道它的主人住在哪、是不是美国人：原话摆在签名之前，判断是人的。Ondo 对每个钱包的制裁名单和黑名单事先读不到（链上读不了会 revert 的查询），只在转账时由代币自己拒绝，表现为 swap 被 revert。BUIDL 在 Ethereum 上的地址出自记忆，名字、符号、精度和合约自己说的一致，而且只显示、从不交易。钱包有没有内置 Robinhood Chain 没有核对过。
- **Pre-IPO 没有一单是真的。** 六家的价格是 2026-10-06 从这台机器不带钥匙读的；接上钥匙以后的下单、改杠杆、平仓走统一接口库那条已有的路，只对着替身跑过（替身交易所上一个 Anthropic 合约）。哪个合约是 pre-IPO 按各家记录上的标记认，标记是 2026-10-06 读到的样子；读不到标记时退回按公司名认，只认 `PRE_IPO_COMPANIES` 里的公司。OKX 那两个合约的 ×10 是对着别家的价格比出来的，写在代码里，OKX 以后再 rebase 要改那一行。Kraken Futures 只给资金费率，多久付一次这里没有核对。各家谁能交易，账户只转述它们的话，不判断。
- 净值历史从第一个快照开始，之前的不知道；你在场所网站上自己的充值提现算在"变化"里，因为没有一个场所说它的哪一笔是钱进钱出。成本价只覆盖账户自己下过的单和场所报了入场价的持有，每一行写着覆盖了多少。
- Hand to agent 里话和额度是一对，是页面按"同一个结束时间"认的，后端没有记哪份额度属于哪个意图；后端每个 agent 每种范围只留一份额度，所以随意图给的额度会替换原来那份（页面签之前说明）。收回时第二个签名被拒，话没了、额度还在，页面把拒绝摆出来。
- 页面只在替身上点过，用的是桌面宽度，Cream 和 Black 都看过但不是每一处都亲眼看；窄屏、打印没看。手机式的布局还没做。
- 席位之间不隔离（见上面「页面和 agent 面」）：同一个系统用户下的进程能读所有席位的钥匙文件和账户的读接口；一个席位只看到自己的，是显示上的选择。
- 卡上那个收款地址之所以可信，只因为 owner 看了一眼；没有任何东西说明它是谁的地址。没有制裁筛查、Travel Rule、对收款方的 KYC。
- 一个人同时持有这八个账户、都在同一个地区可用，是假设。场所自己的地区规则是场所的，这里只表现为一扇关着的门，不提供任何绕过它的办法。
- 托管、牌照、出了错谁赔，不是软件，这里没有。

代码在 `src/portfolio/account/`（`sign.ts` 钥匙、类型化数据、签名恢复、nonce · `state.ts` agent 钥匙、授权、子账户、签名人、地址簿 · `calendar.ts` 银行日与交易时段 · `doors.ts` 每个场所的跑道与原生请求 · `payments.ts` 在途与到账 · `exchange.ts` 入口与页面视图 · `mode-rules.ts` Mode 弹层那张表和卡等多久 · `protocols.ts` 三套协议的编解码 · `payees.ts` 模拟收款方与账户这一侧的付款流程 · `live-orders.ts` / `live-moves.ts` / `live-earn.ts` 真钱的下单、动钱、Earn 三扇门 · `holdings.ts` 按资产汇总（和 earn 去重）· `networth.ts` 净值快照 · `costbasis.ts` 成本价 · `restore.ts` 重启时从账本重建 · `statement.ts` 流水），两个新适配器 `adapters/alpaca.ts`、`adapters/hyperliquid.ts`，即插即用的 `adapters/exchange.ts`，真实连接 `live/`（各场所的交易者，加 `explore.ts` 市场合并、`public-markets.ts` 不带钥匙的公开行情、`categories.ts` 分类表、`preipo.ts` pre-IPO 的标记、单位、公司和发行方的话、`earn.ts` 三家的 earn、`dex.ts` 里的 RWA、`bridge.ts` 跨链），种子 `fixtures/home/portfolio/frontline.json` 与可插场所的目录 `connectable.json`，页面 `public/account.html`、`account.css`、`owner.js`、页面自己的字体 `public/fonts/` 和 `public/ui/`（一个全局作用域里按顺序跑的几个普通脚本：`core` 合约与工具 · `connect` · `money` · `asset` · `intent` · `portfolio` · `earn` · `markets` · `trade` · `statement` · `agents-mount` · `shell`，加 `tokens.css` 与各屏的样式；没有构建步骤），终端 demo `account-demo.ts`，替身账户 `test/standin/`。测试：`test/unit/account-*.test.ts`、`test/unit/live-*.test.ts`、`test/unit/ui-*.test.ts`（页面脚本在一个作用域里跑，签出来的草稿交给后端的校验，再到替身的门上签一遍）、`test/unit/page-scripts.test.ts`（按 HTML 的顺序拼起全部脚本编译一遍、名字不重复、每个资源 200、`/ui/..%2F` 是 404、没有 `prompt` / `confirm`）、`test/account-demo.test.ts`、`test/portfolio-mcp.test.ts`、`test/portfolio-mcp-real.test.ts`、`test/attack/`。

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
