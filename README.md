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
npm run demo -- --fresh         # 擦掉默认 home 重新种子
npm run control-room -- --replay ~/.buyer-agent-demo/runs/last.jsonl   # 不开 runner，回放上一次
npm test                        # 单测 + e2e（spawn 一次完整 demo，断言 exit 0 与关键行）
```

Node ≥ 22。端口：场所 4701–4704、签名器 4705、钱包 4706、控制台 4800、Account 4820。`$BUYER_HOME`（默认 `~/.buyer-agent-demo/`）是 home：凭据、授权书、账本、签名器策略、钱包状态都在那里，不在仓库里；授权书、账本、钱包余额每次运行从 `fixtures/home` 重新种子。

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
npm run account                           # http://127.0.0.1:4820：一个页面，只认你真实的账户；能下单、能动钱（配对码在终端）
npm run account -- --live-cap 50          # 每一单、每一笔最多 $50（默认 $100）
npm run account -- --read-only            # 只读：不下单、不动钱
npm run account:demo                      # 无头：十四个 beat，每个 beat 放行一件事、拒绝一件事；同一个 home 连跑两次，输出逐字节相同
npm run portfolio:mcp                     # agent 的席位持一把 agent 钥匙，每次写都签名
npx tsx examples/account/headless.ts      # 一个脚本从头走到尾：owner 签、agent 签、时间流逝，不起服务不开浏览器
npx tsx examples/account/agent-seat.ts whoami   # 扮演一个 agent，对跑着的服务发签名指令
```

做法手册在 [COOKBOOK.md](COOKBOOK.md)：每件事怎么做、会看到什么、什么会被拒，配两个能直接跑的示例（`examples/account/`）。

对账单和 Account 原来是两个页面，功能重叠，现在合成一个，就叫 Account。它回答两件事：你有多少钱、在哪里；**钱怎么进出每个场所，以及谁有权让它动**。它是 trading agent 和资金之间的机场：功能照 Hyperliquid 自己的账户页一项一项移过来，但门开在八个场所上（比原来多一个股票券商 Alpaca 和 Hyperliquid 自己），再加上买方账户需要、单个场所不需要的三样：支出授权，替 agent 回答对外付款协议，以及把用户已有的交易所钱包**即插即用**地接进来。界面是英文。

**页面上只有真的。** `npm run account` 起的服务里只有你经各家自己的接口接进来的账户：没有一个模拟场所，也没有模拟的插件、收款方和时钟。一开始账户是空的，页面就是一排可以接的场所（交易所、券商、钱包、预测市场与代币），点哪个就是哪个的接法。只动模拟钱的指令（场所间的模拟路由、swap、float、地址簿、对外付款、Unified、应用抽成）在门口就拒，回答里写明真钱走 `liveMove`（owner）或 `agentLiveMove`（agent）。银行和卡删掉了：银行要聚合商的生产资格，卡没有给个人的接口，没有接口的就不放进来。下面讲的路由、在途、float、收款方和十四个 beat，是终端 demo 与测试里那套模拟账户上的规则。

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

没有移的：Link Staking、Earn、Vaults、Staking、Referrals、Outcomes、Portfolio Margin、法币入金小部件。**故意没抄的**：到期时间塞在 agent 名字里（这里是显式字段）；撤销后清掉 nonce 记录（这里不清，所以撤销过的钥匙不能复活）；Send 发往任何地址且没有地址簿；多签只验领签人的 nonce；低于最低额的入金直接丢失（这里在钱离开之前就拒绝）。

### 三层协议

**A · 账户自己的指令协议**（`account/sign.ts`、`exchange.ts`）。形状是 Hyperliquid 的：信封 `{action, nonce, signature}`，EIP-712 类型化数据，真的签名（viem）。两类签名和它一样分开：owner 的动作是逐字段可读的类型化数据，一种动作一个类型；agent 的请求只有一个类型 `Agent(source, actionHash, nonce)`，由 owner 授权过的 agent 钥匙签。类型不重叠，所以 agent 钥匙签不出 owner 的动作。域名是这里自己的（`AgentAccountSignTransaction`，chainId 424242），在这里签的东西在 Hyperliquid 上无效；同一个编码器能恢复出 Hyperliquid 官方 SDK 测试用例里的签名人（一致性测试，只用公开的签名和地址）。nonce 用它的规则（每个签名人保留最高的 100 个；窗口前 2 天、后 1 天），另加几条：确认签名人有权之后才消耗 nonce，而且一条指令上每个算数的签名人的 nonce 都消耗；资金指令只在它自己标注的时刻前后十分钟内有效（不能签好留着以后用）；同一条指令重发返回第一次的结果，只执行一次（两位 owner 换个位置签，不是一条新指令）；进程重启后从账本里读回收过的指令，不收第二次；动作的字段必须恰好是签名覆盖的那些；指令**逐条进门**，一条跑完才收下一条，所以同时到的两条不会各自看到对方花钱之前的预算。owner 在页面上是浏览器里一把不可导出的 P-256 设备钥匙（WebCrypto，服务器只有公钥），在终端 demo 和测试里是一把 EOA。

owner 签的不只是意图：一笔划转的签名里带着**路线的哈希、最高费用、最晚到账时间**，执行时任何一项变了就拒绝，要求重签。人的批准也是一次签名：`approveCard` 同时写明卡号和这张卡将要放行的内容的哈希；放行时所有检查重跑；卡三十分钟过期；等批的卡占着它那份预算。放宽（开到 Open、恢复账户、调时钟、跟页面 agent 说话）要 owner 签，收紧（Guard、关账户）不用。

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

**真实连接：你真的场所**（`src/portfolio/live/`、`account/live-moves.ts`、`adapters/live.ts`）。上面那四个是演示用的；这里接的是用户真实的账户。每个有接口的场所一种连接，页面 Balances 页签上一张卡片：

| 场所 | 怎么接 | 读 | 写（真钱） |
|---|---|---|---|
| 交易所：OKX、Kraken、Coinbase 等，统一接口库覆盖的一百来家 | 本机 home 目录里的钥匙文件 | 余额（交易与资金两个账本）、钥匙权限（Binance、OKX 有接口说） | 提到你自己的地方、账本之间划转、稳定币互换 |
| MetaMask Agent Wallet | 本机已登录的 `mm` 命令行 | 余额、Guard 策略 | `mm transfer`，还要 MetaMask 自己的开关 `PORTFOLIO_MM_WRITES=1` |
| 浏览器钱包：OKX Wallet、Binance Wallet、MetaMask 等 | EIP-6963 发现，钱包签一句话证明地址是你的 | 六条 EVM 链上的 USDC、USDT 和链上原生币；Robinhood Chain 上的 Robinhood Stock Tokens | 账户构造交易，钱包自己签、自己发；账户在链上核对是不是那一笔 |
| Alpaca | 钥匙文件 | 现金、持仓 | 无：它的 API 不动现金 |
| Robinhood 投资账户 | Robinhood 自己的登录页（它的 Trading MCP 服务器，OAuth：动态注册、PKCE），令牌只在内存里 | 各账户的现金和股票持仓（只调 `get_accounts`、`get_portfolio`、`get_equity_positions`） | 无：钱只在 Robinhood 自己的 app 里进出；这把令牌能在 Agentic 账户里下单，账户层从不调用下单、撤单的工具 |
| Robinhood Crypto | 钥匙文件：API key 加你自己生成的 Ed25519 私钥 | 购买力、持仓，按 Robinhood 自己的中间价 | 无：它的 API 只读和交易，不动钱 |
| Robinhood Wallet（自托管） | 地址（手机钱包，没有浏览器扩展，所以只能看，不能证明） | 同浏览器钱包，含 Stock Tokens | 无 |
| Kalshi | 钥匙 id 加私钥文件（RSA-PSS 或 Ed25519 签名） | 现金、持仓（按成本） | 无：它的 API 不动钱 |
| Hyperliquid、Polymarket | 地址 | 永续与现货账本；持仓与 pUSD | 无：这两家不服务这台机器所在的地区，按它们的规矩只读 |
| Ondo（OUSG、rOUSG、USDY） | 地址 | 代币数量，按 Ondo 自己链上预言机的价格 | 无：只能在 Ondo 白名单地址之间转 |

钥匙文件放在 home 目录里（默认 `~/.buyer-agent-demo/credentials/<场所>/api-key.json`），必须只有本人可读（`chmod 600`），页面只传文件在哪，值不进页面、账本和任何返回。接入时先问场所的公开时钟（不带钥匙），场所不服务这个地区就在这一步停下，钥匙不发出去。对账单页上，真实场所顶替同名的模拟场所，拔掉后模拟的回来；读数缓存半分钟，读失败时保留上一次的数并写明时间和原因。

**下单（真钱）**（`account/live-orders.ts`、`live/trade.ts`）。机场要能起降：接上的账户上，owner 和 agent 都能真的下单。默认打开，`--read-only` 关掉，`--live-cap 50` 改单笔上限（默认 $100，一单和一笔转账都按它算）。每个场所说它自己的话（交易所的统一接口库、券商的 REST、预测市场的签名订单、DEX 聚合器给钱包构造的交易），账户只看一个形状：这个场所交易哪些市场、一个市场此刻的价格和最小单位、下一单、撤一单、它后来怎么样了。一单要过这几道：

- 市场以美元计价（USD 或美元稳定币），这样上限和额度才是美元；开着；场所接受这样写的单（最小数量、数量步长、价格步长、它收的单子类型）。不合格的在场所看到之前就拒（`E_VENUE_ORDER_INVALID`）。
- 按场所此刻的价格估值，不超过服务器的单笔上限；市价买单按卖一价算，再留 2% 给价格变动。
- owner 下单：签的是确切的数量、限价（市价单为空）、这一单最多值多少美元、十分钟有效期。执行前再问一次价格，涨过签的上限就不下（`E_ACCOUNT_REQUOTE`）。签名里的链名是 "Live · real money"。
- agent 下单（`agentLiveOrder`，MCP 的 `portfolio_live_order`）：要在 owner 给它签的**交易额度**里（`approveSpend` 的 `trade` 范围：哪些场所、每单多少、一共多少、到什么时候）。Conservative 下每一单都是一张卡，卡上是数量、价格和价值，owner 签了才下；Aggressive 下额度内直接下。挪钱的额度（`venues`）不等于交易额度，反过来也一样。
- 撤单从不出卡：agent 能撤自己下的单，owner 能撤任何单。没成交的部分退回 agent 的额度。
- 场所自己的规矩照旧：钥匙权限（比如交易所钥匙没开交易）、余额、风控、地区。它的拒绝就是答复。
- 下单只在一个场所之内换手（美元换成 BTC、股票换成现金），钱不会因为一单离开场所。

**动钱**（`account/live-moves.ts`）也是同一个开关：

- 服务在终端打印一个配对码，第一个浏览器要输入这个码才成为 owner（不再是"谁先打开谁就是"）。
- 每一笔都是 owner 的一次签名，签的是**账户替你向目的地场所要来的那个地址**、场所报的手续费上限、十分钟的有效期；执行前再问一次场所，地址或手续费变了就不执行。签名里的链名是 "Live · real money"。
- 钱只去你自己的地方：交易所自己给的充值地址，或签过那句话的钱包。粘贴进来的地址只能看，不能收钱。
- agent 请求（`agentLiveMove`、MCP 的 `portfolio_live_move`）：Conservative 下每一次都变成一张卡，卡上是地址和手续费，owner 签了才走；Aggressive 下额度内直接执行，目的地照样只能是你自己的地方，单笔上限照旧；它的支出授权都要覆盖两端。
- 场所自己的规矩照旧：钥匙权限、提币白名单（第一次提到新地址，多数交易所要你先在那边加白名单）、它自己的风控。它的拒绝就是答复。
- 不跟模拟的钱混：账户上只有真实场所，真钱在它们之间一步走完，不经过任何模拟的枢纽。

从这台机器不带钥匙问过一次（2026-10-05）：Binance 回 451、Bybit 回 403，都写明按地区拒绝；OKX、Kraken、Coinbase、Binance.US 正常应答。

Robinhood 的三条线都是它自己发布的接口（2026-10-05 读）：股票走 5 月 27 日开放的 Trading MCP（`agent.robinhood.com/mcp/trading`，它的授权元数据写明支持动态注册、PKCE、刷新令牌，所以账户层能像 Claude Code 一样自己接上去）；加密走 Crypto Trading API（签名与官方文档的示例逐字节一致，见测试）；Stock Tokens 的清单和报价在 `api.robinhood.com/rhj/` 下，不要钥匙。Robinhood 的 MCP 工具返回什么格式没有公开，股票这条线按它自家 API 常用的字段名读，读不出来时直说读不出来，不当作零。

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

一个协议配一个模拟收款方是这个 demo 的安排（每个协议演一次），协议本身没有这个要求。卡支付（ACP、Visa 的 Trusted Agent Protocol）没搭：卡没有给个人的接口。只认真实账户的服务器上没有收款方，`agentPay` 一律拒绝；真实收款方还没接。

### 页面和 agent 面

`/`（`/account` 也跳到这里）就是 Account，一个页面，从上到下：

- 头部：保守 / 激进两档模式（Conservative：agent 要动的每一笔都等你签；Aggressive：agent 在额度内动钱不再问你。放宽要 owner 签名，收紧不用；真实账户启动时是 Conservative），和真钱开关的状态。
- 净值、按资产类别的配置条、等你批的卡（浏览器标签页的标题带着等你批的张数）。
- Accounts：接上的账户（余额、能动什么、`Move…`、Details 里的持仓）；一个都没接时就是一排可以接的场所，点哪个就是哪个的接法：钥匙文件（路径、一条建文件的命令、每两秒检查一次，只看字段名不看值）、场所自己的登录页（Robinhood）、钱包签一句话或只看地址。可以下载 CSV。
- Activity：真钱的每一笔，谁动的、怎么批的。可以下载 CSV。
- Agents：一张表一份表单。敲门的 agent 一点 "Let in…" 就进了表单，填名字和额度（哪几个账户之间、单笔、预算、期限）一次存好；也在这里改额度、撤销。
- Devices：哪些浏览器能签。

MCP 多了三个工具：`portfolio_account`（这个席位的钥匙有没有被授权、还能花多少）、`portfolio_transfer`（自家场所之间）、`portfolio_pay`（为一个 URL 付钱；AP2 的两份封闭式 mandate 由席位读过商户签的总价之后自己签）。原来的 `portfolio_execute` / `portfolio_order` 也改成签名后从同一个入口进；挂了这一层之后，HTTP 上未签名的写一律被拒绝。只认真实账户的服务器上，`portfolio_transfer` 和 `portfolio_pay` 被拒，真钱走 `portfolio_live_move`：Conservative 下它回一张卡，Aggressive 下额度内直接回付款单。

### 十四个 beat

机场（八个场所的门）→ 钥匙（未授权、到期、撤销、撤销后不能复活；Hyperliquid 一致性）→ 一条指令只执行一次（重放、nonce、过期、被改过的信封）→ 在途（钱离开了，还没到）→ 只能回家（agent 钥匙出不去的几种情况；owner 用自己的签名从 Hyperliquid 提现）→ 股市（券商的现金只在券商那边动，owner 和 agent 都路由不进去）→ 额度（拆小了也过不去）→ 卡（agent 批不了自己的卡、批准时重查、过期）→ 地址簿（绑定链、冷静期、黑名单）→ float 与 Unified → 付 API（x402、MPP charge、MPP session；地址被换、加价、重定向、陌生的托管合约、收款方失联）→ 买东西（AP2 带 mandate，从 float 付）→ 插入一个交易所钱包（一条签名、不改代码；门由钥匙的权限编译；不在旧授权里；自托管钱包按地址）→ 账本当证据（签名能从文件里恢复、改一行断链、和场所流水对账）。

### 对抗审阅之后改掉的

写完之后请了两路独立审阅：一路对着跑起来的服务找洞，一路逐条核对协议原文。找到的问题都修了，每条留了测试；攻击那一路的二十个复现原样留在 `test/attack/`，每个都写成"这次攻击必须失败"。主要的几条：

- 两条指令同时到，各自都通过了同一份预算（两笔 $600 过了 $1,000 的预算）。现在指令逐条进门。
- 两位 owner 的签名换个位置，被当成一条新指令又执行一次；重启之后旧信封可以重放。现在一条 owner 指令按内容认，账本里收过的不再收。
- 资金指令可以把时刻标到将来，签好留着以后用。现在只在标注时刻前后十分钟内有效。
- 收款方回答"付款失败"，却留着那张 EIP-3009 授权事后兑现；或者留着开 session 的那笔交易以后再广播。现在授权在过期之前一直占着预算，被兑现就记账；没被接受的开户交易当场作废（它的交易 nonce 被花掉）。
- 收款方收了钱、回一个读不懂的回执。现在先记账再说话。
- 一个不回应的收款方能让整个账户的入口等下去。现在等三秒。
- 授权里写"所有场所"，以后插上的场所自动进了授权。现在冻结在签字那一刻。
- agent 的钥匙被撤销后，它的 float 和它开着的 session 没人能收回。现在 owner 能关 session、能把 float 收回钱包。
- 协议核对那一路：OKX 提币的手续费是在金额之外另收的；CCTP 的 burn 是真的 calldata（带 `maxFee` 上限和转入 Hyperliquid 的 hook）；Hyperliquid 自己的动作只构造、不签（账户没有那把钥匙）；x402 的校验顺序、MPP 开户必须从零累计开始、AP2 遇到不认识的约束类型一律拒绝；股票卖出的结算日按交易日算（晚上八点以后的成交算下一个交易日）。

### 这一层的诚实边界

- 终端 demo 和测试里的八个场所、可插的四个和三个收款方全部是本地模拟（只认真实账户的页面上没有它们）。请求按各家自己的格式构造，账户手里有钥匙的都真的签了名（哪些只构造不签，见上面 B 层），但**没有一个发给过真的对方**，所以这里没有任何互通性证明。费用、最低额、到账时间是 2026-10-04 从各家文档读来的报价，不是实测。
- 钥匙是从源码里的标签派生的，是公开的：demo 展示的是检查，不是保密。页面上 owner 的钥匙是浏览器不肯导出的真设备钥匙，但**第一个打开页面的浏览器就成了 owner**（首次使用即信任），抢在人前面的本机进程可以冒领；服务重启之后账户又没有 owner，下一个来问的页面（包括任何一个还开着的旧标签页）就成了 owner。真产品要带外配对。
- 对账单页上的脚本 agent 仍走旧的进程内路径（划转即时到账，陌生地址出卡）；带钥匙签名的入口走这里的新规则。两套规则并存。
- float 仍然是账户手里的一把热钥匙，约束它的只有它的大小。除了 session 的托管合约对押金的上限，这里没有一条规则是由链或场所替账户强制的。
- 券商的现金只能在券商那边用你自己的银行动，账户路由不进去。开这条跑道要的是券商合作方资格，不是代码。
- 插上的交易所显示的是交易所对这把钥匙的说法。经统一接口库没有一个调用能返回钥匙的权限：真的连接器在有专门接口的交易所问它（Binance 的 `apiRestrictions`），没有的只能从第一次被拒学到。自托管钱包只按地址接入：没有做浏览器里"连接钱包"的握手，出金那一步在那个钱包里的签名是模拟的。
- 资金指令的有效期以它自己标注的时刻为准、前后各十分钟：签名人把时刻往后标，最多换来二十分钟。
- 真实连接和真钱写入只对着替身测过：替身交易所、替身链、本地生成又丢掉的测试钱包，外加一次不带钥匙的公开时钟请求。**没有一把真钥匙、一个真钱包在这里用过**。接上你自己的账户之前，先用只读钥匙；要写，先用一个小上限和一个小金额。
- 钱包证明用的是 `personal_sign`。Binance Wallet 和 OKX Wallet 的文档没写它的行为；不支持的钱包只能按地址"看"，不能收钱。合约钱包（Safe 之类）的签名这里验不了，也只能看。
- Kalshi 的持仓按它报的成本显示，不是市值；Hyperliquid 的永续账本是一个账户价值，不拆开持仓。
- 卡上那个收款地址之所以可信，只因为 owner 看了一眼；没有任何东西说明它是谁的地址。没有制裁筛查、Travel Rule、对收款方的 KYC。
- 一个人同时持有这八个账户、都在同一个地区可用，是假设。场所自己的地区规则是场所的，这里只表现为一扇关着的门，不提供任何绕过它的办法。
- 托管、牌照、出了错谁赔，不是软件，这里没有。

代码在 `src/portfolio/account/`（`sign.ts` 钥匙、类型化数据、签名恢复、nonce · `state.ts` agent 钥匙、授权、子账户、签名人、地址簿 · `calendar.ts` 银行日与交易时段 · `doors.ts` 每个场所的跑道与原生请求 · `payments.ts` 在途与到账 · `exchange.ts` 入口与页面视图 · `protocols.ts` 三套协议的编解码 · `payees.ts` 模拟收款方与账户这一侧的付款流程），两个新适配器 `adapters/alpaca.ts`、`adapters/hyperliquid.ts`，即插即用的 `adapters/exchange.ts`，种子 `fixtures/home/portfolio/frontline.json` 与可插场所的目录 `connectable.json`，页面 `public/account.{html,js,css}` 与 `owner.js`，终端 demo `account-demo.ts`。测试：`test/unit/account-{sign,calendar,doors,exchange,protocols,payees,connect}.test.ts`、`test/account-demo.test.ts`、`test/portfolio-mcp.test.ts`、`test/attack/`。

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
src/portfolio/    Account（英文界面，:4820）与原来的组合钱包：账户模型 · 八个模拟 adapter（原来的六个：CEX · 链上 · 预测市场 · RWA；Account 层加的两个：券商 · perp DEX）与真实连接器（`live/`）· 开放度三层 · 聚合 · 流动性阶梯与轨道报价 · CEX 订单簿 + DEX 池子 + 预测市场盘口的报价与拆单路由 · 航班、一单一卡与账本 · 关键词 agent + 路由器 · API、Account 页面与 `--classic` 的模拟对账单 · stdio MCP · 十个 beat · account/（Account 层：签名指令、每个场所的跑道、在途与到账、三套对外付款协议、真钱的一步）与它的十四个 beat
test/             unit（audit · gate · mandates · constraints · ledger · env-scrub · wallet · portfolio · account-*）· attack（独立审阅留下的攻击复现，全部必须失败）· e2e · portfolio-demo · account-demo · portfolio-mcp
```
