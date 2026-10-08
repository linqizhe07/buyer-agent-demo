# buyer-agent-demo

给 AI agent 用的资金账户（**Account**）：你真实的交易所、券商、钱包和预测市场账户在一个页面上；agent 在你签的额度里交易、挪钱、付款，你看、引导、批准。仓库里还留着更早的几个模拟演示（[docs/earlier-demos.md](docs/earlier-demos.md)）。

## 跑起来

```bash
npm install
npm run account                                    # http://127.0.0.1:4820，配对码打印在终端
npm run account:service -- install --live-cap 20   # macOS 后台常驻；之后 status · restart · logs · code · uninstall
npx tsx test/standin/ui-standin.ts --port 4821     # 替身账户：同一个页面和门，场所是假的，不联网、不动钱
npm run account:demo                               # 无头跑十四个 beat
npm test
```

Node ≥ 22。常用开关：`--live-cap 50`（单笔上限，默认 $100）、`--read-only`（不下单、不动钱）、`--fresh`（不接着以前的运行）。钥匙文件和账本在 home（`$BUYER_HOME`，默认 `~/.buyer-agent-demo/`），钥匙文件 `chmod 600`；页面只传文件在哪，值不进页面和账本。

## 页面：三屏

- **Portfolio**：你有什么。净值曲线、跨场所按资产汇总、持仓、账户（健康、对 agent 的开关、Details）；右栏是等你批的卡和 agent 的请求、agent 在做什么、现成的钱、配置条。Move · Receive · Earn · Sell many 都从这里开。
- **Markets**：有什么可以交易。接上的场所，加上没接的场所不带钥匙读来的公开行情（标 "Connect to trade"）。tab：All · Crypto · Stocks · RWAs · Perps · Pre-IPO · Predictions · Watching；一个市场一个抽屉。
- **Trade**：在一个市场里建仓位。一张下单票，按种类六面（Crypto · Stocks · RWAs · Perps · Pre-IPO · Predictions，和 Markets 同样的词），加 Under way。

页面上只有真的：没有模拟场所、没有样例数据，没有接口的就不画。界面英文，背景可选 Cream / Black。

## 谁能让钱动

- **owner**：浏览器里一把不可导出的设备钥匙（第一次输终端的配对码）。每一笔真钱是一次签名，签之前 "What you sign" 把字段摆出来；执行前再问一次价格或地址，变了就不做。
- **agent**：自己的钥匙（MCP 席位在本机生成），加 owner 签的额度：交易、挪钱、付款、earn，各有单笔、总额和到期。
- **模式**：

  | agent 在额度内 | Guard | Beast |
  |---|---|---|
  | 下单、挪钱、放进 earn | 出一张卡，等你批 | 直接做 |
  | 撤自己的单 | 直接做 | 直接做 |
  | 超出额度 | 拒绝 | 拒绝 |

  切到 Guard 一键，切到 Beast 要签名；卡 30 分钟没人答自动过期。十扇门的完整对照在页面的 Mode 弹层（服务器给的 `modeRules`）。接口上的值仍是 `guard` | `open`。
- **不变的线**：`--live-cap` 单笔上限；钱只去你自己的地方；随时撤销；场所自己的地区规则不绕。

## 能接什么

| 类 | 场所 | 能做 |
|---|---|---|
| 交易所 | OKX、Kraken、Coinbase、Binance、Bybit、KuCoin 等统一接口库（ccxt）覆盖的一百来家；钥匙文件 | 读；现货和 U 本位永续；提到自己的地方、划转、稳定币互换；OKX、Kraken、KuCoin 的 earn |
| 券商 | Alpaca（钥匙文件）、Robinhood（它的 Trading MCP，OAuth 登录）、Robinhood Crypto | 读、下单；现金只在券商自己那边进出 |
| 预测市场 | Kalshi（钥匙文件）、Polymarket（钥匙文件，或只填地址看） | 读、事件合约下单 |
| 钱包 | 浏览器钱包（OKX Wallet、MetaMask 等，签一句话证明地址）、MetaMask Agent Wallet（本机 `mm`） | 换币、跨链、代币化股票（RWA）；`mm` 还有永续、预测、earn，写操作要 `PORTFOLIO_MM_WRITES=1` |
| 只看 | Hyperliquid、Ondo、Robinhood Wallet（按地址） | 读 |

打开 Connect an account 时，账户先替每个要钥匙的连接问一遍它的场所（不带钥匙）：不服务你这个地区的，卡片上直接写 "Not served here" 和它的原话，不用先建 key 再被拒。

**Pre-IPO**：交易所上按一家未上市公司的估值定价的永续合约，不是股份。六家不带钥匙读得到（OKX、Gate、Kraken Futures、Deribit、KuCoin Futures、MEXC），一家公司一行，写各家隐含估值的中位数；接上其中一家的钥匙，就在同一行下单。Anthropic、OpenAI 都说未经同意的股权转让无效，原话跟着它们那一行走。

## 给 agent 的接口

- **MCP**：`npm run portfolio:mcp`（stdio；席位持自己的钥匙，每次写都签名）。接 Claude Code：页面 Agents 弹层的 "Copy agent setup command"。真实账户上的工具：
  - 读：`portfolio_account` · `portfolio_venues`（从用户所在的网络自动判断哪些场所能接，各用场所自己的话）· `portfolio_overview` · `portfolio_holdings` · `portfolio_history` · `portfolio_asset` · `portfolio_candles` · `portfolio_explore` · `portfolio_receive` · `portfolio_earn` · `portfolio_watchlist` · `portfolio_statement`
  - 下单和动钱：`portfolio_live_markets` · `portfolio_live_compare` · `portfolio_live_positions` · `portfolio_live_preview` · `portfolio_live_order` · `portfolio_live_batch` · `portfolio_live_amend` · `portfolio_live_cancel` · `portfolio_live_close` · `portfolio_live_leverage` · `portfolio_live_move` · `portfolio_live_earn` · `portfolio_pay`
  - 和 owner 说话、等结果：`portfolio_report` · `portfolio_ask` · `portfolio_approval` · `portfolio_wait`
  - 只在模拟对账单（`--classic`）和测试里：`portfolio_read` · `portfolio_markets` · `portfolio_quote` · `portfolio_openness` · `portfolio_execute` · `portfolio_order` · `portfolio_transfer`
- **HTTP**：只读接口 `GET /api/account/...`，只听 127.0.0.1；表在 [docs/account.md](docs/account.md)。
- **给做 Agent 模块的团队**：[COOKBOOK](COOKBOOK.md) 的「11b · Agent 模块接口」。

## 诚实边界

- Account 的真实连接和真钱写入只对着替身测过：这里没有用过一把真钥匙、一个真钱包。接你自己的账户之前先用只读钥匙；要写，先用小上限、小金额。
- 真的读过的，是不带钥匙的公开数据：交易所行情、Kalshi、Polymarket、pre-IPO 价格、LI.FI 报价。
- Pre-IPO 是估值合约，不是股份；各家谁能交易由它们自己定，账户只转述。
- 本机文件系统是信任边界：能写 home 的人能改账本和钥匙文件；同一系统用户下的 agent 席位之间不隔离。
- 场所的地区规则是场所的，这里只表现为一扇关着的门，不提供绕过的办法。
- 托管、牌照、出了错谁赔，不是软件，这里没有。

## 更早的模拟演示

| 命令 | 是什么 |
|---|---|
| `npm run demo` | 十一个场景：agent 走进四个模拟市场，每笔写都停在一张卡上（`--live --hold` 打开控制台 :4800） |
| `npm run wallet` | 智能 agent 钱包骨架（:4810） |
| `npm run account -- --classic` | 原来的模拟对账单：拆单、跨链报价、预测市场；`npm run portfolio:demo` 无头跑它的十个 beat |

## 文档

- [COOKBOOK.md](COOKBOOK.md)：每件事怎么做、会看到什么、什么会被拒；能直接跑的示例在 `examples/account/`。
- [docs/account.md](docs/account.md)：Account 的全部细节：三层协议、每个场所的接法、下单动钱 Earn 的规矩、RWA、永续、Pre-IPO、页面和接口表、MCP 工具表、审阅留下的、这一层的诚实边界、代码地图。
- [docs/earlier-demos.md](docs/earlier-demos.md)：十一个场景、插件合同、钱包骨架、模拟对账单、整个仓库的诚实边界、回灌 Kairos、目录。

## 目录

```
src/portfolio/    Account（:4820）：account/ 签名的门与账本 · live/ 真实连接 · public/ 页面 · mcp.ts agent 面
src/wallet/       智能 agent 钱包骨架（:4810）
src/agent/ src/contract/ src/venues/ src/plugins/ src/runner/ src/control-room/   十一个场景的演示
test/             unit · attack（攻击复现，必须失败）· standin（替身账户）· e2e
docs/             细节
```
