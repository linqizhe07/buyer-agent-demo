# Account Cookbook

README 的「Account：资金的机场」讲这一层**是什么**，这里讲**怎么做**。每条做法写的是：想做什么、怎么做、会看到什么、什么会被拒。

分两半。**上半是你真实的账户**：`npm run account` 起的服务，一个桌面钱包页面（`/`），叫 Account：左边一条 rail，三个屏 Portfolio（你有什么）· Markets（有什么可以交易）· Trade（交易），上面只有你经各家自己的接口接进来的账户和不带钥匙读来的真实公开行情，没有一样是模拟的。**下半是模拟账户里的规则**：场所之间的路由、float、替 agent 付 API（x402、MPP、AP2）、地址簿、Unified、可插的模拟场所。这些只跑在进程里（`examples/account/headless.ts` 从头走一遍，`npm run account:demo` 的十四个 beat 带断言，外加测试）；只认真实账户的服务器对这类指令一律回 `this account holds real accounts only`。模拟里的钥匙从源码里的标签派生，是公开的。

## 三个角色，一个入口

- **owner**：钱的主人。页面上是浏览器里一把导不出来的设备钥匙。脚本和测试里是一把从标签派生的钱包钥匙。
- **agent**：一把钥匙。owner 放它进来、给了额度之后，它能在你真实的账户上下单（还可以请求在账户之间挪钱，要另一份额度）。Conservative 下每一单都等你签；Aggressive 下额度内直接下。别的都不能。
- **account**：跑着的服务。它验签、查额度，替你向场所要目的地址和手续费。agent 拿不到任何场所的凭据。

所有改动走同一个入口：一条签了名的指令，`POST /api/exchange`。回答只有四种：

| 状态 | 意思 |
|---|---|
| `200` | 做了。下单返回订单（可能还挂着），动钱返回一张付款单（可能还在途） |
| `202` | 先问 owner：页面上出现一张卡 |
| `401` | 这把钥匙不是签名人（没授权、过期、被撤销） |
| `409` | 拒绝，带一个说明越了哪条线的码（文末有速查） |

页面上 owner 的每个按钮都是同一个三步：`POST /api/account/prepare` 把你要的写成要签的确切动作、浏览器的设备钥匙签、`POST /api/exchange` 送进门（第 11b 条）。读都是 `GET`，从不签名。

# 上半 · 你真实的账户

## 0 · 怎么跑

| 想要 | 命令 |
|---|---|
| 接你真实的账户，下单、动钱（终端打印配对码） | `npm run account`，打开 <http://127.0.0.1:4820>（`npm run portfolio` 同） |
| 每一单、每一笔最多 $5 | `npm run account -- --live-cap 5`（默认 $100） |
| 只读：不下单、不动钱 | `npm run account -- --read-only` |
| 随时在线：开机自启、挂了自动拉起（macOS） | `npm run account:service -- install --live-cap 20`（第 10 条） |
| 从零开始，不接着以前的运行 | `npm run account -- --fresh` |
| 扮演一个 agent，对跑着的服务发请求 | `npx tsx examples/account/agent-seat.ts whoami` |
| 让 Claude Code、Codex 这类 agent 来当 agent | 页面顶栏 "Copy agent setup command" 复制的那一行：`claude mcp add portfolio -e PORTFOLIO_URL=http://127.0.0.1:4820 -- npx tsx <仓库的绝对路径>/src/portfolio/mcp.ts`（第 11 条） |
| 让 DeepSeek Harness 来当 agent | 第 11 条的配置 |
| 在一个不联网、不动钱的账户上把页面点一遍 | `npx tsx test/standin/ui-standin.ts --port 4821`（第 11c 条） |
| 模拟账户里的规则，一个脚本从头走到尾，不起服务 | `npx tsx examples/account/headless.ts` |
| 十四个 beat 的断言脚本 | `npm run account:demo` |

`npm run account -- --port 4821 --home /tmp/x` 另起一个互不相干的实例。`--classic` 是原来的模拟对账单，不挂这一层。

页面是一个桌面钱包：

- **左边的 rail**：顶上 "Trade"（打开下单票）；三个屏 Portfolio · Markets · Trade（Portfolio 旁边的数是等你批的卡加 agent 的请求，浏览器标签页的标题也带着，比如 "(2) Account"）；底下 Background（Cream / Black，记在这个浏览器里）、Mode（Conservative / Aggressive）、"Agents"（数是敲门等放行的 agent）、"Settings"，最下面 "Trading on · up to $100 an order" 或 "Read-only"。
- **顶栏**：Lens（All accounts / 一个场所 / 一个 agent，三屏的表都按它筛）、搜索（按 `/`，打字就去 Markets 搜）、时钟图标（Statement）、"Copy agent setup command"、Menu（Connect an account、Agents、Settings、Statement、余额 CSV、背景和模式）。按 `t` 打开下单票。重启过的，顶栏下面一行写着接回了什么。
- **三个屏**：Portfolio（第 2b 条）、Markets（第 2c 条）、Trade（第 5 条）。
- **弹层**：Statement（第 5 条）、Settings（模式、交易开没开、agent 的会话和杠杆上限、背景、Devices）、Agents（第 3 条）；右边的抽屉是一个资产、一个市场、一个账户的 Details。要你确认的都是页面自己的小问话框，没有浏览器的 `prompt` / `confirm`。

`seat` 是这个别名：

```bash
alias seat='npx tsx examples/account/agent-seat.ts'
```

## 1 · 成为 owner

能交易的服务（默认）在终端打印一个配对码：打开页面，顶栏下面那一栏写着 "Enter the pairing code shown in the terminal."，输入它，点 "Pair"，这个浏览器才成为 owner。`--read-only` 起的服务，第一个打开页面的浏览器就是 owner。Settings（或 Agents）弹层的 Devices 里那一行写着 "This browser"。

- 不是 owner 时，那一栏写着 "This browser can look but not sign. Add it under Devices from your other browser."，要签的按钮都是灰的。让 owner 的浏览器在 Devices 里点 "Let it sign"；点 "Require both" 则变成两个都签才算数。另一个浏览器放它进来以后，这一页不用刷新就成了 owner。
- 配对码输错五次就不再收，重启服务换一个新码。
- 服务重启后**还是这个浏览器当 owner**，不用再配对（第 10 条）。新浏览器要在 Devices 里被加进来。想干净地重来，`--fresh`，或换一个 `--port` 和 `--home`。
- 这个浏览器的数据被清掉了（换了浏览器、清了站点数据），它就不再是 owner，也没有别的 owner 能把新浏览器加进来：用 `npm run account -- --fresh` 重来一次（以前签的授权不会带过来，账本和钥匙文件都还在）。

## 2 · 接你真的账户

"Connect an account" 打开一组卡片，按 Exchanges · Brokers · Wallets · Markets and tokens 分组（服务能接、上面没列的，放在 "More" 里）。它在这几处：一个都没接时 Portfolio 的三步清单第一步；Portfolio › Accounts 下面；Menu；Markets › Venues 板。点哪张就是哪个的接法，已经接上的写着 "Connected · add another"。银行和卡不在里面：它们没有给个人的接口。Markets 里没接的场所的行写着 "Connect to trade"，点了直接是那家的连接表单（第 2c 条）。

**交易所**（OKX、Kraken、Coinbase、Bybit、Binance，或 "Another exchange" 从统一接口库的一百来家里挑）：

1. 点卡片，弹窗里三步。第一步 "open its API page" 打开交易所自己建 key 的页面，建一把**能交易、不能提币**的 key。下面一行用这家自己的话写要勾什么，例如 OKX：Read 和 Trade（要在资金和交易账户之间划转再勾 Transfer），Withdraw 不勾，绑本机 IP（不绑 IP 的交易 key 闲置 14 天会被删）；Coinbase：签名算法选 ECDSA，权限 View 和 Trade；Binance：系统生成的 key 不绑 IP 只能读，要交易就绑 IP，或者用自己生成的 Ed25519 key。
2. 第二步给出它要的文件路径（默认 `~/.buyer-agent-demo/credentials/okx/api-key.json`）和字段（`apiKey`、`secret`，OKX、KuCoin、Bitget 还要建 key 时设的 `password`）。"Copy" 复制路径；"Copy setup command" 复制一条命令：建目录、写一个空模板（文件已经在就不动它）、`chmod 600`、用 `nano` 打开，你把值填进去存盘。
3. 第三步每两秒自己检查一次，只看字段名，不读值：`Waiting for the file…` → `Missing: password.` → `Others on this machine can read it.`（旁边 "Copy fix" 复制 `chmod 600`）→ `Ready.`
4. 点 "Connect"。

```
OKX connected live · $1,000.00 there now · the venue says this credential can read, trade · bound to an IP list · it can do more than read (trade) · real money moves only when you sign it, at most $100.00 a movement
```

页面上这一句缩成 "OKX connected · $1,000.00"，后面 "details" 展开是全文。Portfolio › Accounts 多一行：余额是 OKX 自己报的，半分钟读一次；状态是一个小标签（Trades / Can move / Read-only key / Watched / Read failed）；"Details" 打开右边的抽屉：持仓、它交易什么、场所对这把钥匙的说法。钥匙没开交易的，标签是 "Read-only key"，Details 里写着这家要勾什么；Markets › Venues 板上这一行有 "Connect a new key"：先拔掉，再用同一个名字按这家自己的连接重新接。

**钱包**（OKX Wallet、Binance Wallet、MetaMask 扩展等）：在装了钱包的浏览器里点 "Browser wallet"，再点你的钱包。钱包先给地址，再签一句话（不是交易，什么都不批准），这个地址就是你的，从它可以换币（下面第 5 条）。"Watch an address" 只粘贴地址：能看，既不交易也不收发。

**Robinhood**：
- 投资账户：卡片 "Robinhood" → "Sign in at Robinhood…"，在 Robinhood 自己的页面登录、批准，回来点 "Connect"。读各账户的现金和股票持仓；下单只在 Robinhood 的 Agentic 账户里，整股。令牌只在服务的内存里，重启要重新登录。
- Crypto：在 Robinhood 网页版的 crypto 账户设置里建 API 凭据（你自己生成 Ed25519 密钥对，把公钥交给 Robinhood，勾上读和下单）。卡片 "Robinhood Crypto" 走和交易所一样的三步，字段是 `apiKey`、`privateKey`（base64 私钥）。
- Stock Tokens：接任何钱包（包括 "Watch an address" 粘贴 Robinhood Wallet 的地址）都会一起读 Robinhood Chain 上的 Stock Tokens。

**其他**：Alpaca 是钥匙文件（它的 key 没有权限可选，任何 key 都能下单，都不能动现金；先用 Paper 账户的 key 试）；Kalshi 是 `keyId` 加它给的私钥 `.pem` 的路径 `privateKeyFile`（有权限可选时选 `read` 和 `write::trade`）；MetaMask Agent Wallet 走本机的 `mm` 命令行（先确认 `mm wallet show` 能用）；Polymarket 要交易用账户钱包的钥匙文件，先问 Polymarket 自己这个地区让不让用；Hyperliquid、Ondo 只填地址、只读。

拔掉点那一行的 "Disconnect"（Portfolio › Accounts 或 Venues 板），先确认一次，再是一次签名。还有没完成的单时拔不掉，先撤单。场所那边的钥匙不动，要删去那边删。Menu 里 "Download balances (CSV)" 下载每个账户的持仓。

会被拒：钥匙文件不在、权限不是 600、缺字段 `E_ACCOUNT_CREDENTIAL` · 交易所不认这把钥匙 `E_VENUE_UNAUTHORIZED` · 场所不服务这个地区 `E_VENUE_GEOBLOCKED`（Binance、Bybit 从这台机器就是这样，那是它们的规矩）· 没应答 `E_VENUE_UNREACHABLE` · 已经接过同一个 `E_ACCOUNT_BAD_ACTION`（第二个账户在弹窗的 "More options" 里换一个 "Shown as"）· 还有没完成的单 `E_ACCOUNT_BAD_ACTION`。

## 2b · Portfolio：你有什么，在哪

rail 上点 "Portfolio"。从上到下，都按顶栏的 Lens 筛：

1. **Waiting for you**：agent 的卡和请求，按 agent 分组（第 8、8b 条）。
2. **净值**和今天的涨跌。涨跌是每个持仓按它市场自己报的 24 小时涨跌算的；有持仓没有场所报，就写明覆盖了多少，不估。
3. **曲线**：1D / 1W / 1M / All。账户每五分钟记一个点（接上、拔掉一个场所时也记一个，标在曲线上），从第一个点开始，不到两个点不画，短的时候写 "since <日期>"。Lens 是一个场所或一个 agent 时换成 "Show all accounts"：曲线是整个账户的。
4. 快捷操作：Trade · Move · Receive · Hand to agent，做不了的不出现。
5. 侧栏：**Cash ready**（现金和稳定币：能在原地交易的、能在你的账户之间挪的、只能留在场所的）、配置条、Agent activity（✓ 做了、▣ 等你、✗ 被拒、› 回报）。
6. 三段：**Assets**（每个资产一行，下面每个场所一行：交易所的 BTC、Arbitrum 钱包里的 WBTC、券商的 BTC 是同一行；价格、24h、价值、"Since bought"）· **Positions**（所有场所的持仓，"Close"；有 earn 的场所多一张 Earning）· **Accounts**（第 2 条）。

点一个资产打开右边的 **Asset 抽屉**：它那一行、每个场所的价格、K 线（5m / 1h / 1d）、持仓和 "Close"、挂单和 "Cancel"、成本价、流水里相关的行，底下 "Buy" / "Sell"（打开 Trade 的下单票，场所和市场已经填好）/ "Hand to agent"。

**Receive**：选账户、币、网络，页面问那个场所要地址：交易所自己的充值地址（要 memo 的带上 memo），或证明过的钱包、agent 钱包自己的地址；"Copy"。只看的地址、不收钱的场所给不出地址，写它的原话。它只说往哪打，打不打是你的事。

几条要知道的：

- **成本价**只来自两处：账户自己下过的单（每一次运行的账本都算），和场所自己报的入场价（券商、预测市场、永续）。账户之前就有的、从别处转进来的币，成本账户没见过，所以 Assets 下面写 "Cost known for 1 of 3"：三个资产里只有一个的成本是全知道的。没价格的成交不算进去，场所没报的手续费不猜。
- **净值的变化不是收益**：接上一个场所不是赚，拔掉不是亏（按两个点之间都在的场所算）；agent 从 agent 钱包付出去的钱加回来；但你在场所自己网站上的充值提现账户看不见，算在变化里。第一个点之前的历史不知道，也不补。点在 `<home>/portfolio/networth.jsonl`（只有你能读），是派生数据，丢了只丢一条曲线。
- Earn 里的钱是 Assets 里单独的一行（"earning 5.2% at OKX"），算在净值里，不算 Cash ready；同一笔钱不会在场所的余额里再算一次（第 7c 条）。

agent 读同样的东西：`portfolio_holdings {cost}`、`portfolio_history {range}`、`portfolio_asset {key}`、`portfolio_receive {venue, asset, network}`。

## 2c · Markets：有什么可以交易

rail 上点 "Markets"，或在顶栏搜索里打几个字母。一张表里两样东西：

- **你接上的场所**列的市场；
- **你没接的场所**不带钥匙读来的真实公开行情：Kraken、Coinbase、OKX、Binance 的公开 ticker，Kalshi 和 Polymarket 公开的市场，Robinhood 的 Stock Token 清单。这些行写 **"Connect to trade"**，点了就是那家的连接表单；接上以后，开着的下单票自动换成它。

同一个东西是一行（BTC/USDT、BTC-USD、WBTC 都是 BTC；一个问题的 YES 和 NO 是一张卡），后面列着在哪些场所有。数字只用场所自己报的：Kraken 不报 24 小时涨跌，就不显示；Kalshi 的成交量是合约数，不换成美元。离别家价格超过 10% 的当作同名的另一种东西，排除，在下面写明。没应答、或不服务这个地区的场所（从这台机器看 Binance 是 451、Bybit 是 403），写成一行安静的字，用它自己的话，不找别的路。

- **Tab**：Now · Crypto · Stocks · RWAs · Predictions · Perps · Macro · Sports，没有东西的不显示；搜索时多一个 "All results"；还有 "Watching" 和 "Venues"。
- **Now**：**Closing soon**（一天内收盘的事件，Yes / No 的价格用 ¢，倒计时；看得见的卡、在接上的场所的，每 5 秒问一次价）· **Movers**（24 小时涨跌，成交额至少 $1M）· **Most traded**。
- **★**：关注一个市场，是一次签名（`setWatch`，最多 50 个）；agent 读得到你关注什么（第 8b 条）。"Watching" tab 是你关注的全部。
- 点一行打开 **Market 抽屉**：价格、买卖价、24h、成交量；永续的资金费率和杠杆；事件的倒计时和每个结果（各有 "Buy"）；K 线（接上的场所用它自己的，没接的用公开数据）；每个场所的价格；你持有多少、成本多少；agent 在这里的卡、挂单和你的意图；代币化股票的 Issuer。底下 "Buy" / "Sell" / "Hand to agent" / ★。

**Venues 板**（"Venues" tab）：每个接上的场所一行，写它的健康（最近一次答了、最近一次失败和它的话）和地区规矩（场所的原话）。**"Open to agents"**：关掉不用签名，agent 在这家只剩读（`POST /api/revoke`）；重新打开放宽了它能做的，所以是一次签名（`setPolicy restore`）。还有 "Trade"、"Move"、"Disconnect"，钥匙不能交易的有 "Connect a new key"。下面是 "Your agents asked"（agent 请求你接的场所，"Connect" 或 "Decline…"）、这里够不着的场所、可以接的目录。

agent 读同样的东西：`portfolio_explore {tab, q, sort, limit}`、`portfolio_candles {venue, symbol, interval}`。

## 3 · 让一个 agent 进来，给它交易额度

agent 先敲门：

```bash
seat whoami
```

```
seat "example-seat" · key 0xec4c4c61959f9f09b12683ea8077d10b223816c1
401 ✗ E_ACCOUNT_UNKNOWN_SIGNER · this key is not authorised on the account: the owner lets it in under Agents
```

MCP 席位第一次被拒时会以它客户端的名字敲一次门（`agentAsk {kind: "letIn"}`），所以这一行带着名字。rail 上 "Agents" 旁边多一个数，Portfolio 的 Waiting for you 里也有它。打开 Agents 弹层（rail 上的 "Agents"，或 Menu → Agents），那一行写着 "asked to be let in"。点 "Let in…"，钥匙地址进了下面的表单。填名字，在 "May trade at" 里勾上它可以下单的账户，填 Per order（每单最多值多少）和 Budget（一共能下多少单的钱），选期限，点 "Save"。要它也能在你的账户之间挪钱，再勾 "and move money between my accounts"。每一样是一个签名：放钥匙进来、交易额度、（勾了的话）挪钱额度。

```
trading limit: every venue on the account now · up to $25 an order · $100 of orders in all · until Mon 12 Oct
```

- 不填 Budget 只放钥匙进来：没有额度，它什么都做不了。
- 改额度：那一行 "Change limit"，表单换成这个 agent，填新的数存下，新的替换旧的。去掉 "move money" 的勾，挪钱额度就收回。
- 每单上限、总额、到期，三样都算。拆成许多小单也过不了总额。等批的卡占着它那份额度；没成交就撤掉的单，那份额度退回来。
- 全勾上等于「所有账户」，指签字那一刻接上的账户。之后接上的不算，要再存一次点它的名。
- 交易额度和挪钱额度是两样：有交易额度的 agent 不能把钱挪出场所，有挪钱额度的不能下单。
- **付钱给别人**是第三样额度：表单里 "Payments from an agent wallet"，"May pay" 填可以付的域名（逗号隔开），或勾 "any payee"；Per payment、Budget 是它自己的。钱从 agent 钱包出（第 7b 条）。
- **"Everything"**：一键勾上所有能交易的账户、账户之间挪钱、任何收款方。金额还是你填，每一样还是一次签名。
- **Earn 额度**是第四样（`approveSpend` 的 `earn` 范围）：点名场所或一个场所的一个产品，从不是「所有账户」。从 Trade › Hand to agent 交一件 earn 的事时附上（第 5 条），或者回应 agent 要额度的请求时给；Agents 弹层里列着，"End earn limit" 只收回这一份。
- **每个 agent 每一样只有一份**：新签的替换旧的（Hand to agent 附的额度也一样，签之前页面会说）。
- agent 请求更大的额度（`portfolio_ask {kind: "limit"}`）时，Waiting for you 里那条请求的 "Grant…" 打开一张 "Give a limit"：从它现在那份额度和它问到的场所勾起，从不自己扩到所有账户（它问的场所做不了这件事时什么都不多勾，并写明）；签了，那条请求自己关掉。

**agent 的钥匙是它自己的**：席位第一次运行时在 `~/.buyer-agent-demo/seats/<名字>.json` 生成一把，权限 600，以后一直用这把。不再从名字推出来，所以知道名字的人拿不到它（`PORTFOLIO_SEAT_KEYS=sim` 才回到从名字推，只给测试和演示用）。MCP 席位同理（`PORTFOLIO_AGENT` 定名字），工具 `portfolio_account` 返回它的地址、有没有被授权、额度还剩多少。

会被拒：没点名 `E_MANDATE_RECIPIENT` · 超每单 `E_MANDATE_PER_ORDER_CAP` · 超总额 `E_MANDATE_BUDGET` · 到期 `E_MANDATE_EXPIRED` · 没有额度 `E_MANDATE_NONE`。

## 4 · 选模式：保守还是激进

rail 底下（或 Settings 弹层）两档：

| 模式 | agent 下单时 | 怎么切 |
|---|---|---|
| Conservative（保守，真实账户的默认） | 每一单都变成一张卡，卡上是数量、价格和价值，你签了才下 | 点一下，不用签名 |
| Aggressive（激进） | 额度内直接下，不再问你；超出额度就拒 | 点一下，是 owner 的一次签名 |

两档都一样的：每单不超过 `--live-cap`；市价单带着最差价格去场所（买最多比卖一高 2%，卖最少比买一低 2%）；撤单从不出卡；场所自己的规矩照旧。agent 挪钱也是这两档。Statement 里写着每一笔是 "approved by you" 还是 "inside its limit"。

## 5 · 自己下单：Trade 屏

rail 上点 "Trade"（或 rail 顶上的 "Trade" 按钮、按 `t`、Market 和 Asset 抽屉里的 "Buy" / "Sell"、Portfolio › Accounts 那一行的 "Trade…"）。屏顶是**宫格**：Buy & sell · Swap · Perps · Predictions · Sell many · Move · Earn，只画接上的场所真做得了的（按场所的交易者说它交易什么，`venues[].trade.kinds`）；只读的服务上一个都没有；做得了的场所都拒绝时画成虚线，写场所的话和怎么修。上面一个开关 "Do it myself | Hand to agent"（交给 agent 见第 8b 条）。

下单票在右边那块面板里，刷新不会把它重画掉。**先选市场，再选在哪**：

1. Market 里打几个字母（BTC、AAPL、FED）：搜的是 Markets 那张表，接上没接的场所都在。选一个，下面马上是它的价格和买一卖一；收盘了会写 "Closed now"。
2. **Where**：交易这个东西的、你接上的场所，按这一单在那里会成交的价格排（买看卖一，卖看买一；同一个东西在别处叫 XBT、WBTC、cbBTC 也算），最好的在最上面、默认选它，可以换。不能在那里下的写场所的话和怎么修；没接的写 "Connect to trade"，点了接上以后票自动换到它。场所的地区规矩照它的原话写。
3. Buy / Sell，数量按美元（Dollars）或按单位（币、股、合约）。Type 里只有这个市场接受的：Market、Limit、Stop（价格到了 Stop price 按市价成交）、Stop limit（到了按 Limit price 挂限价）。市场支持的话，下面还有 Time in force（Until canceled / Fill now, rest canceled / All now or nothing / Today only）、Post-only（只做 maker）、Reduce-only（只减仓）。
4. 预览：确切数量（按美元下的单向下取整到这个市场的步长）、按什么价格估的值、市价买单最多花多少。"What you sign" 展开是要签的每个字段；十分钟的有效期在倒数，到了自动重新准备。
5. 点 "Sign and place"。从钱包换币的，钱包会请你确认（要先授权的，先确认授权、等它上链，再确认换币）。

没签完的票存在这个浏览器里一天：刷新以后，场所还接着、还能交易、市场还在，就原样放回来（不抢焦点），否则丢掉。

Trade 屏下面三块，都按 Lens 筛：

- **Under way**：agent 等你批的卡（"Approve" / "Reject"）；挂着的单每十秒问一次场所，有 "Cancel"，场所能改单的（Alpaca、Kalshi、一部分交易所）还有 "Change…"：改数量、限价、触发价，账户按现在的价格重新估值，签了就改；改成比原来更值钱的，算一笔差额的新单（agent 也一样：激进下额度内直接改，保守下出卡）；在途的钱和 earn；两单以上有 "Cancel all"（先确认）。成交、撤掉之后它落进 Statement。
- **Positions**：能列持仓的场所（永续、股票、事件合约）每个持仓一行：方向、数量、开仓价、标记价、强平价、浮盈亏，右边 "Close"。Close 在哪里点（这里、Portfolio、Asset 抽屉）都是同一个对话框：全部或一部分，写明现在值多少、最差成交价；超过服务的单笔上限时，账户自己的拒绝写在 "Sign and close" 上方，按钮不让按，下面给一个按市场步长取整、刚好在上限以内的数量。你点的 Close 是你自己签名，直接执行。agent 平仓不占额度（它只会减少持有），但持仓可能是你自己的，所以和下单一样看模式：保守模式出卡等你批；激进模式在它的每单上限以内直接平，超过也出卡。场所有自己的平仓接口就用它，没有就发一张 reduce-only 市价单；市场不接受 reduce-only 的，不发（免得反向开仓）。
- **Recent fills**：最近的成交。

**Statement**（顶栏的时钟图标，或 Menu → Statement）是银行流水的样子：最上面是 Under way，下面一行一笔交易（成交、提现、划转、跨链、换币、Earn），日期、说明、账户、金额（买入 −、卖出 +，挪钱和 earn 照原数）、状态，下一行小字是谁做的、手续费、场所的编号或交易哈希。四个下拉按月份、账户、类型（有 earn 时多一个 Earn）、Who（你，或哪个 agent，按钥匙认）筛；最后一行是这一屏的合计（买了多少、卖了多少、挪了多少、into earn / out of earn、手续费；被拒的不算）。"Download CSV" 下载这一屏（带 agent 一列），"Print" 只打印流水。流水从账本文件读，重启以后还在。

几条规矩：只交易美元计价的市场（USD、USDC、USDT、USDG 这类）；每单不超过 `--live-cap`；签名十分钟内有效；下单前再问一次价格，买单涨过你签的价值、市价卖单跌了 2% 以上就不下；撤单要等场所说撤掉了才算，期间成交的照算。

会被拒：服务是只读的 `E_WALLET_LIVE_WRITES_OFF` · 超上限 `E_ACCOUNT_LIMIT`（平仓也一样，签之前就写在对话框里）· 不到最小单、不在步长上 `E_VENUE_ORDER_INVALID` · 收盘了 `E_VENUE_MARKET_CLOSED` · 没有美元价格 `E_ACCOUNT_UNPRICED` · 价格动了 `E_ACCOUNT_REQUOTE` · 签名过期 `E_ACCOUNT_EXPIRED` · 钥匙不许交易 `E_VENUE_PERMISSION` · 余额不够 `E_VENUE_INSUFFICIENT`。

**先小后大**：第一次用 `--live-cap 5` 下一单几美元的；Alpaca 先用 Paper 账户，Kalshi 先用 demo。

## 5b · 预测、永续、Swap、Sell many、代币化股票

都在 Trade 屏的宫格里，各是下单票的一个样子，签的还是同样那几种动作：

- **Predictions**：Yes / No 两个按钮，价格用 ¢，也就是市场认为的概率；写着这一单到期最多赔多少（每份兑 $1 或 $0）。限价按 ¢ 填（62 就是 $0.62）。
- **Perps**：Long / Short，资金费率和下次支付的时间，最大杠杆，你在这个市场的持仓和强平价。Leverage 一行填倍数、Margin 选 Cross / Isolated，点 "Set leverage…"，是下单之前单独的一次签名（`liveLeverage`）；agent 设杠杆不超过你在 Settings 里签的倍数（默认 1 倍，即不让加杠杆）。Hyperliquid 的永续经 MetaMask Agent Wallet 的 `mm perps` 下（市场写 `BTC-PERP`）：每一单、每次平仓、每次改杠杆之前，账户先用 `mm predict geoblock` 问这台机器在哪，按 Hyperliquid 使用条款 §1.6（美国、安大略、受制裁地区不服务）判；在里面、或者说不出在哪，什么都不发。写操作还要 `PORTFOLIO_MM_WRITES=1`。
- **Swap**：选卖什么、买什么、多少。稳定币换稳定币是在一个交易所里的一笔 `liveMove swap`；美元和币之间是一单 `liveOrder`；**币换币是两腿**：先把 A 卖成两个市场共有的那种美元（钱包的话在同一条链上），等它成交，按实际到手的钱（扣掉手续费）再准备买 B 的那一腿，给你看过以后是第二次签名。卖出一分半钟里没成交，买入就等着：卖单在 Under way 里，成交以后再 Swap 一次。
- **Sell many**：列出你持有的、不是美元的东西（`/api/account/sellable`），最多勾 10 个，各填卖多少；"Review" 先列出每一条要签什么，再一条一条签（永续是平仓），每条有自己的结果，一条被拒不影响下一条。没有新的签名类型：每条照样过上限、额度和模式。
- **代币化股票**（RWAs tab 里的行）：从接上的浏览器钱包买卖，是钱包的两笔交易（授权、swap）。Robinhood 的 Stock Tokens 在 Robinhood Chain 上对 USDG（`NVDA/USDG@Robinhood Chain`），Ondo Stocks（`NVDAon`）和 xStocks（`NVDAx`）在以太坊等链上对 USDC。每一单之前账户先问发行方：Robinhood 的清单、Ondo 链上的接受与暂停开关、xStocks 的公开接口。行下面一行小字是发行方，票在 Where 上面把发行方的资格原话说一次（这些发行方都排除美国人和别的一些地方，账户不知道你住在哪，判断是你的）；发行方关了或限制的，原话写在签名按钮上方，按钮不让按。OUSG、BUIDL 只显示：它们只在发行方批准过的钱包之间转，swap 送不到（`E_VENUE_TRANSFER_RESTRICTED`）。钱包还不认识 Robinhood Chain 时，页面提出替你加上这条链（`0x1237`）。往 Robinhood Chain 打 USDG、从那里桥回来，都用 "Move…" → "Across chains"。
- **Earn** 见第 7c 条，**Move** 见第 7 条。

会被拒：发行方暂停了 `E_VENUE_MARKET_CLOSED` · 发行方不认这个代币、不在这条链上发、清单没应答，或者 mm 说不出这台机器在哪 `E_VENUE_REJECTED` · 只在白名单钱包之间转 `E_VENUE_TRANSFER_RESTRICTED` · 场所不服务这个地区 `E_VENUE_GEOBLOCKED` · MetaMask 自己的开关没开 `E_WALLET_LIVE_WRITES_OFF`。

## 6 · agent 下单

```bash
seat markets okx BTC
seat order okx buy BTC/USDT '$5'
seat order okx sell BTC/USDT 0.0001 70000
seat cancel okx ord-0001
```

MCP 里是 `portfolio_live_markets {venue, query | symbol}`、`portfolio_live_order {venue, symbol, side, orderType, qty | usd, limitPrice, stopPrice, tif, postOnly, reduceOnly}`、`portfolio_live_cancel {venue, order}`、`portfolio_live_amend {venue, order, qty, limitPrice, stopPrice}`、`portfolio_live_positions {venue}`、`portfolio_live_close {venue, symbol, qty}`、`portfolio_live_leverage {venue, symbol, leverage, marginMode}`。等结果用 `portfolio_wait {card | order | payment}`：变了马上回，最多等 55 秒，不用自己反复查。流水用 `portfolio_statement {mine}`（按这把钥匙认，你给它起什么名字都一样）。

下单之前先问一句：`portfolio_live_preview {order}`（或 `{move}`）按账户真会用的价格、步长、最多值多少把这一单算出来，告诉 agent 额度还剩多少（`leftUsd`、`perOrderUsd`），以及现在下会是什么：`card`（Conservative）、`at once`（Aggressive，额度内）还是 `refused`（没被放进来、没额度、额度没点这家、超每单、超剩余、超服务的上限）。它什么都不下。一次卖很多样用 `portfolio_live_batch {legs}`：最多 10 腿，每腿就是一个 `portfolio_live_order`，各签各的、各判各的、各答各的，一腿被拒不影响下一腿，不合并、不拆分。

agent 设杠杆有一条你签的上限：Settings 弹层里 "Their leverage"，默认 1 倍（即不让加杠杆），改大是一次签名。Conservative 下回答是 `202` 和一张卡；你签了才下，MCP 的 `portfolio_approval` 告诉 agent 结果。Aggressive 下额度内回答直接是 `200` 和订单：

```
202 ▣ card-0001 waits for the owner · Example seat asks to buy 0.00008 BTC at OKX · market · about $5.00
200 ✓ ord-0001 · buy 0.00008 BTC/USDT at OKX · filled · filled at 62500
```

agent 只能撤自己下的单；你能撤任何单。在模拟账户里才有的指令（`agentOrder`、`agentExecute`、`agentSendAsset`、`agentSwap`）在这里回 `E_ACCOUNT_BAD_ACTION · this account holds real accounts only`；`agentPay` 只在服务能从 agent 钱包付真钱时收（第 7b 条）。

## 7 · 动钱

Trade 屏的 "Move" 宫格、Portfolio 的快捷操作 "Move"，或 Portfolio › Accounts 那一行的 "Move…"：提到你自己的地方、账本之间划转、稳定币互换，或者从钱包发。预览里是**账户替你向目的地要来的地址**、手续费上限、网络，点 "Sign and send"。Statement 里有这一笔，场所或链说到了才算到账。要知道往哪打钱，用 Portfolio 的 "Receive"（第 2b 条）。

agent 请求挪钱（要有挪钱额度）：

```bash
seat move withdraw okx wallet 5 USDC Arbitrum
seat move transfer okx okx 5 USDT funding trading
```

MCP 里是 `portfolio_live_move`。规矩：钱只去交易所自己的充值地址或签过那句话的钱包；第一次提到新地址，多数交易所要你先在它那边加白名单；钥匙不许提币的交易所，从它那里提不了，但能收钱；MetaMask Agent Wallet 发钱还要它自己的开关 `PORTFOLIO_MM_WRITES=1`。

**跨链**：钱包那一行 "Move…" → "Across chains"。选落到哪里（这个钱包在另一条链上、你另一个钱包、你交易所在那条链上的充值地址）、从哪条链到哪条链、发什么到什么、多少。预览里是账户签的那条路线（最便宜的）、最少到账多少、大约多久、钱包要付的网络费，下面一行是其他路线。签了以后钱包先确认授权（要的话），再确认转账；Statement 里这一笔是 "On the way"，桥送到了才变成 "Done"。交易所提币时点 "Fees on every network"，每条链的手续费并排出来，点一个就换成那条链。Robinhood Chain 上的美元是 USDG：桥进去、桥出来都是 USDG（走 Across）；在那条链上不做直接发送或提币，只过桥。

```bash
seat move bridge wallet wallet 25 USDC Arbitrum Base   # agent 请求（MCP 的 portfolio_live_move 带 toNetwork）
```

会被拒：目的地不是你的 `E_ACCOUNT_DESTINATION` · 地址或手续费变了 `E_ACCOUNT_REQUOTE` · 钥匙不许提币 `E_VENUE_PERMISSION` · 地址不在交易所白名单 `E_VENUE_WITHDRAW_WHITELIST` · 同一条链、只看的钱包、没有桥能送 `E_ACCOUNT_BAD_ACTION` / `E_VENUE_RAIL_CLOSED` · 钱包报来的哈希不是构造的那笔 `E_VENUE_REJECTED`。

**比价**：下单票的 Where 就是比价（第 5 条）：同一个东西在你每个接上的场所按这一单会成交的价格排，最好的在最上面。agent 用 `portfolio_live_compare {base, side, usd}`。

## 7b · agent 付钱给别人：agent 钱包

agent 付 API 调用、按次计费的服务，用的是一个 **agent 钱包**：账户在本机替它生成一个钱包（钥匙在 `~/.buyer-agent-demo/agent-wallets/<名字>.json`，600，agent 拿不到），你往里放一笔备用金，agent 在你签的付款额度内自己付。最坏情况损失的是这笔备用金。

1. **建**：Agents 弹层的 Agent wallets 里填 Name、选 For agent、Keep up to（打算放多少），点 "Make it"（一次签名）；agent 请求充值（`portfolio_ask {kind: "topup"}`）时，Waiting for you 里那条请求的 "Grant…"：它还没有钱包就打开建钱包的表，有了就打开充值。它出现在 Portfolio › Accounts 里，"Agent wallet · research"，余额从链上读。
2. **充值**："Top up…"，选从哪个账户出（交易所提币或钱包发），目的地就是这个 agent 钱包。或者直接往它的地址打 USDC（Base、Arbitrum、Optimism、Polygon、Ethereum 都行）。
3. **给额度**：Agents 弹层里 "Payments from an agent wallet"（第 3 条）。
4. **agent 付**：`portfolio_pay {url, maxAmount, from: "research", method?, body?}`。账户先问收款方，从它自己的回答里读价格、收款地址、哪条链；只付 Circle 在那条链上的 USDC。说得通的协议：x402 V2（`PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE`）、x402 V1（402 JSON / `X-PAYMENT`）、MPP charge（`WWW-Authenticate: Payment`，EVM 方法）。签的是一张一分钟内有效的 EIP-3009 授权，不用 gas。
   - 保守：每一笔都是一张卡，卡上写着付给谁、哪个地址、多少、哪条链、什么协议。
   - 激进：付过的收款方直接付；第一次付一个新域名还是卡（批了就钉住它的地址），除非你签的是 "any payee"。
   - 付没付成看链：USDC 合约自己记的授权用没用掉、收款方回执里那笔转账的发送方、收款方、金额对不对。收款方先给了数据没结算的，那笔钱先压着（`{paid: "not yet"}`），链上看到用掉了再记账，过期了就放回额度。
5. **取回**："Take back…"：从 agent 钱包发回你自己的交易所或钱包。这是一笔链上转账，agent 钱包自己付 gas，所以那条链上要有一点它的原生币（Base 上几分钱的 ETH 就够）；没有就拒，不签。

会被拒：没点这个域名 `E_MANDATE_RECIPIENT`（请求根本不发出去）· 要价超过 maxAmount `E_PAYEE_OVERCHARGE` · 收款地址和钉住的不一样 `E_PAYEE_CHANGED`（像攻击，告诉用户）· 不是 USDC、不是认识的链 `E_PAYEE_UNSUPPORTED` · 钱包里不够 `E_WALLET_INSUFFICIENT` · MPP session、AP2 在真钱上不付 `E_PAYEE_UNSUPPORTED` · 地址是本机或内网的 URL：不发。

## 7c · Earn：让闲着的钱生息

三家有接口：MetaMask Agent Wallet 的 DeFi 金库（经 `mm earn`）、OKX 的 Simple Earn Flexible、Kraken Earn。Trade 屏的 "Earn" 宫格只在接上的场所里有这三家之一时出现。

1. 点 "Earn"，选 Put in 或 Take out。列表是场所此刻提供的产品：币、年化（APY 或 APR，区间的写上限）、取出要等几天（0 是马上）、最小额、取出落在哪（永远是钱来的那个场所）、你在里面有多少。放不进去的排在后面，写场所的理由（例如 mm 的金库锁仓不到 $1,000,000）。
2. 填数量。预览写这一笔值多少、上限多少。
3. "Sign and put in" / "Sign and take out"（`liveEarn`，签的是场所、产品、确切数量、最多值多少美元、落在哪、十分钟）。

放进去以后，Portfolio › Assets 多一行 "earning 5.2% at OKX"，算在净值里，不算 Cash ready；那一行下面 "Withdraw…" 取出。Statement 里是类型 Earn 的一行，合计里有 "into earn" / "out of earn"。Kraken 的放、取是异步的，它说做完了才变成 Done；重启时没做完的接着问，不重发。

每家自己的规矩照旧：OKX 只收资金账户里的钱、取出也回资金账户，放和取要钥匙的 Trade 权限；Kraken 要 Earn Funds 权限和它的 Intermediate 认证，全账户自动的策略（Kraken Rewards）不能分配；mm 从钱包出、回钱包，在金库自己的链上，还要 MetaMask 自己的开关 `PORTFOLIO_MM_WRITES=1`。

**agent 做 earn**：

1. 你先给它一份 earn 额度：点名场所（`okx`）或一个场所的一个产品（`okx:savings:USDT`），每笔多少、一共多少、到什么时候。从 Hand to agent 交一件 earn 的事时附上，或者回应它的请求。不能写「所有账户」。
2. agent 读 `portfolio_earn {venue?, asset?}`，再 `portfolio_live_earn {venue, kind: "supply" | "withdraw", product, asset, amount}`（取出可以写 `"all"`）。
3. Conservative：每一次是一张卡（产品、年化、数量、值多少、落在哪），你签了才走。Aggressive：额度内的放入直接走；取出在每笔上限以内直接走，超了出卡。放入算额度，取出不算。

会被拒：没有 earn 额度 `E_MANDATE_NONE` · 额度没点这家或这个产品 `E_MANDATE_RECIPIENT` · 超每笔、超总额 `E_MANDATE_PER_ORDER_CAP` / `E_MANDATE_BUDGET` · earn 额度写了「所有账户」`E_ACCOUNT_BAD_ACTION` · 超 `--live-cap` `E_ACCOUNT_LIMIT` · 没有价格 `E_ACCOUNT_UNPRICED` · 场所自己的话（权限、等级、余额、地区、此刻收不收）`E_VENUE_*` · 只读服务或 MetaMask 的开关没开 `E_WALLET_LIVE_WRITES_OFF`。

## 8 · 批卡、拒卡

Portfolio 最上面的 **Waiting for you**（Trade 屏的 Under way 里也有）：卡按 agent 分组，每张写着它要做什么、值多少、几点前要答；rail 上 Portfolio 旁边的数和浏览器标签页的标题带着等你的张数，比如 "(1) Account"。Lens 选一个 agent 就只看它的。

- "What it asks" 展开是你将要签的每个字段：市场、数量、价格、价值；挪钱的是目的地址和网络。
- "Approve all"：先确认一次（写明这个 agent 一共几张、一共多少钱），然后每张卡还是一次签名，和单独批一样；一张被拒就停在那里。
- 批准是 owner 的一次签名，写明卡号和这张卡将放行的内容的哈希。批了下的就是卡上那一单：同一个市场、同样的数量；价格动过了头就不下。agent 的额度、签名、模式也都重查一遍：卡还在等的时候你收回了额度，批了也不下。
- 卡 30 分钟过期（`E_ACCOUNT_CARD_EXPIRED`）。
- agent 批不了自己的卡（`E_ACCOUNT_OWNER_ONLY`）。

## 8b · 引导 agent：关注、意图、回报、请求

你可以告诉 agent 你想要什么，agent 可以回报、可以向你要东西。这些都是签了名的话，**没有一句授予任何权限**：agent 能做的仍然只是它的额度、你的卡和 `--live-cap`。它们不在动钱的指令里，额度一样都不读。

**你说**

- **关注**：Markets 里点 ★（`setWatch`）。最多 50 个，没接的场所的市场也能关注。
- **意图**：Trade 屏顶上切到 "Hand to agent"，或任何地方的 "Hand to agent" 按钮（Markets 的行、Market 和 Asset 抽屉、Portfolio 的快捷操作）。填给哪个 agent（或 "Every agent"）、在哪、什么市场、哪个方向、大约多少美元、你的话（最多 200 字）、到什么时候，点 "Sign and hand over"（`setIntent`）。美元只是引导，什么都不限。最多同时开 20 个，最长 180 天。
- **附一份额度**：同一张表里可以勾上，给这个 agent 一份交易额度（交 earn 的事时是 earn 额度），每单、总额、期限和意图一样长。它会**替换**这个 agent 现在那一份（每个 agent 每一样只有一份），表上写着现在那份是多少。话和额度是两段 "What you sign"、两次签名。
- 开着的意图列在下面，带每个 agent 最新的回报。"Change words" 改话（结束时间跟着它的额度不变）；"Withdraw" 收回：先确认，再签两样，话（`validUntil` 为 0）和随它给的额度（预算 0）。页面按"同一个 agent、同一个结束时间"认出是哪份额度；第二个签名被拒时，话没了、额度还在，页面把拒绝摆出来。

**agent 说**

```bash
# 在 MCP 里
portfolio_watchlist                                     # 你关注什么、给它（或给所有 agent）的意图和每个 agent 最新的回报、它自己的请求
portfolio_report {intent, status: "taking", note, refs} # taking · done · cannot · note；refs 只能是它自己的 ord-… / pay-… 或交易哈希
portfolio_ask {kind: "limit", venue, usd, text}         # letIn · limit · venue · topup · session · leverage · mode
```

- 回报出现在意图下面和 Portfolio 的 Agent activity 里。一个 agent 在一个意图上最多 50 条，不会盖掉别的 agent 的；给所有 agent 的意图上，别的 agent 的回报对它只是别人的话，不是你的指令。
- 请求出现在 Waiting for you，和它的卡在一组。"Grant…" 打开你自己做这件事的那张表（额度、建钱包或充值、连接那个场所、会话、杠杆上限、模式、放它进来），签了请求自己关掉；"Decline…" 是一次签名（`answerAsk {ask, decision: "decline"}`），只关掉、什么都不给，agent 在 `portfolio_watchlist` 里一天之内看得见 `declined: true`。agent 要你接一个场所的，Markets › Venues 板的 "Your agents asked" 里也有。
- 请求只在内存里、一天过期：同类同场所的再问替换旧的；一共最多 20 条、每个 agent 最多 5 条、每把钥匙一小时 5 条。没被放进来的钥匙也能请求放它进来（`letIn`），报的名字会洗干净，而且不能是、也不能像账户上某把钥匙的名字（放它进来会顶掉那把钥匙）。
- 重启以后关注和意图回来（每一条重新验签），请求和拒掉的请求不回来。
- agent 写的字页面一律转义、限长、去掉看不见的字符。工具说明里写着：意图是你的请求，不是许可。

会被拒：agent 的钥匙签关注、意图或 `answerAsk` `E_ACCOUNT_OWNER_ONLY` · 没被放进来的钥匙签 `E_ACCOUNT_UNKNOWN_SIGNER` · 关注、意图、请求、回报超过上面的数 `E_ACCOUNT_LIMIT` · 回报一条给别的 agent 的意图、回报里认领别人的单、拒一条已经没了的请求（答过了、过期了、或者服务重启过）`E_ACCOUNT_BAD_ACTION`。

## 9 · 把 agent 停下来

从轻到重：

| 想做的 | 怎么做 |
|---|---|
| 只停这一单 | 那张卡点 "Reject"；已经下了的，Trade 屏或 Statement 的 Under way 里 "Cancel" |
| 收回一句话 | Trade 屏 "Hand to agent" 下面那条意图的 "Withdraw"（连同随它给的额度） |
| 以后每一单都先问你 | rail 上切到 "Conservative"，不用签名 |
| 这个场所不让 agent 碰 | Markets › Venues 板那一行关掉 "Open to agents"，不用签名（重新打开要签） |
| 收紧或收回它的额度 | Agents 弹层里那一行 "Change limit"；只收回 earn 的用 "End earn limit" |
| 停掉这把钥匙 | Agents 弹层里那一行 "Revoke" |
| 撤掉所有挂着的单 | Under way 右上 "Cancel all N open" |

钥匙撤销之后：

```
seat order okx buy BTC/USDT '$5'
401 ✗ E_ACCOUNT_AGENT_REVOKED · the agent key was revoked
```

撤销过的钥匙不能再授权，要换一把新的。

**账本当证据**：每条被接受的指令连同它的签名信封、每一单的下单、成交、撤单都写进账本，账本是一条哈希链。

```bash
curl -s http://127.0.0.1:4820/api/overview | python3 -c "import json,sys; o=json.load(sys.stdin); print(o['chain'], o['ledgerPath'])"
```

- 文件在 `$BUYER_HOME/portfolio/`（默认 `~/.buyer-agent-demo`），每次启动一个新文件，第一行写着它接着哪个文件。
- 重启以后账户从这条账本链重建（第 10 条）。以前收过的指令不会再收第二次；发给场所的客户端编号每次启动都不同，不会撞上以前的单。

## 10 · 随时在线：后台服务，重启不丢

**重启不丢**：每次运行的账本第一行写着它接着上一次的哪个文件，这条链就是账户。启动时从最早一个文件读起，重建：
- owner 的浏览器（配对那一行记着设备的公钥，以及它输过配对码）：重启后不用再配对。只读模式也要配对码；没输过码就进来的 owner，在要码的那次运行里不算数，要重新配对；
- 加进来的设备（申请加入那一行记着它的公钥）：你签名让它成为签名人的那一步，重启后照样成立，之后它签的也照样算；
- 你签过的每一条长期指令（放 agent 进来、撤销、各种额度含 earn 额度、地址簿、签名人、接上和拔掉的账户、切到激进、agent 的会话和杠杆上限、关注、意图）：每一条都**重新验签**，按当时的时间重放；验不过的跳过，并写明；
- 每份额度用了多少、钉住的收款地址；某条指令被跳过时，后面的额度编号不会错位；
- 收款方还拿着、没兑现的付款授权：继续占着额度，兑现了照记，过期了才放；
- 账户重新接上：用你当初签的同一个凭据引用（钥匙文件、地址、本机的 mm）；钱包的证明是它当初签的那句话，再验一次；agent 钱包从它的钥匙文件；
- 没完成的单和在途的钱接着跟（只问，不重发）；编号接着往下排，ord-0007 永远是同一单。

页面顶栏下面一行写着接回了什么（"Continued after a restart: …"），没接上的在 details 里（例如 Robinhood 的登录令牌只在内存里，要重新登录）。被撤销的钥匙、你结束的会话，重启后照样是关的（Settings 弹层里 "Start a new one" 重开会话，一次签名）；重启也不会把会话延长。你签的关注和意图也逐条重新验签接回来；agent 的请求只在内存里，重启就没了。净值曲线接着同一个文件画。每条签过名的指令只收一次，重启以后同一个信封再来也不收（真钱转账在十分钟有效期里重启，也不会转第二次）。最新的一次运行看运行序号，不看文件名，电脑时钟被往回调过也不会漏掉后面的运行。

不会被带回的：`--fresh` 启动；旧版本写的、没有那一行的账本；哈希链断了的文件（只读到断点，之后的不信）。有人往账本里加一行伪造的授权，签名验不过，不会生效；把一条真签名的行再抄一遍，只算一次；没签名的行（例如一条把 agent 杠杆上限写成 50 倍的设置记录）放不宽你没签过的东西。

防不住的：一个以你本人身份在这台电脑上运行、能改文件的程序。它能改账本里没签名的行（比如把某份额度的已用金额改回 0），也能直接读 agent 钱包和交易所钥匙文件。哈希链防的是意外损坏，不是这种程序；钥匙文件只让你本人可读（0600），挡的是这台电脑上的其他用户。

**后台服务**（macOS 的 launchd，不要管理员权限）：

```bash
npm run account:service -- install --live-cap 20
```

| 命令 | 做什么 |
|---|---|
| `npm run account:service -- install <参数>` | 登录后自动跑 `npm run account -- <参数>`，进程意外退出 30 秒后拉起；日志在 `~/.buyer-agent-demo/logs/`，只有你能读 |
| `npm run account:service -- status` | 在不在跑，有没有应答 |
| `npm run account:service -- restart` | 重启（改了代码之后），状态接着来 |
| `npm run account:service -- logs` | 最后几十行日志 |
| `npm run account:service -- code` | 还没有 owner 时的配对码 |
| `npm run account:service -- uninstall` | 停掉并移出 launchd，账本和钥匙不动 |

它跑的是这个目录里的代码：改了代码，`restart` 以后生效。装之前先停掉终端里跑着的那个（同一个端口只能有一个）。

## 11 · 让各种 agent 接进来

所有 agent 走同一个 MCP 席位（`src/portfolio/mcp.ts`，stdio），钥匙是它自己的（第 3 条）。

- Claude Code：页面顶栏 "Copy agent setup command"（Menu 里和 Portfolio 的三步清单里也有）复制的那一行，`/api/account` 的 `agentSetup.command`：`claude mcp add portfolio -e PORTFOLIO_URL=http://127.0.0.1:4820 -- npx tsx <仓库的绝对路径>/src/portfolio/mcp.ts`。带着这个服务的地址和 `mcp.ts` 的绝对路径，在哪个目录跑都行。在这个目录里，短的 `claude mcp add portfolio -- npx tsx src/portfolio/mcp.ts` 也一样。
- DeepSeek Harness（`dsh`）：在 `$DSH_HOME/profiles/<名字>/cordis.patch.yml` 里加一条（或启动时 `--patch` 这个文件），工具名是 `mcp__account__portfolio_live_order` 这样：

```yaml
- insert:
    - id: mcp-account
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: account
        transport: stdio
        command: npx
        args: ['tsx', 'src/portfolio/mcp.ts']
        cwd: /Users/<你>/demo
        env:
          PORTFOLIO_AGENT: deepseek-harness
```

dsh 启动 stdio 子进程时会去掉名字里带 KEY、SECRET、TOKEN、PASSWORD 的环境变量，要传的写进 `env`。它的单次工具调用默认 60 秒超时，`portfolio_wait` 最多等 55 秒，刚好在里面。

- 别的 agent：照 `examples/account/agent-seat.ts`，自己的钥匙签一条指令，`POST /api/exchange`。

agent 进来以后常用的一圈：`portfolio_account`（我是谁、能做什么）→ `portfolio_watchlist`（owner 想要什么）→ `portfolio_explore` / `portfolio_holdings`（有什么、我手里有什么）→ `portfolio_live_preview`（这一单会怎样）→ `portfolio_live_order`（Conservative 下是一张卡）→ `portfolio_wait` → `portfolio_report`（告诉 owner 做了）。缺额度、缺场所时 `portfolio_ask`，然后接着做手里能做的，不要原地等。

## 11b · Agent 模块接口（给做 Agent 模块的团队）

Agent 的管理（放谁进来、给多少额度、它们在做什么、它们要什么）归你们的模块。账户这边把读接口、要签的动作、签名的方式和挂载位做干净，你们照这些接，不用改账户的门。

**挂在哪**

- 页面是 `public/ui/` 下几个普通脚本，共享一个全局作用域，按 `account.html` 里的顺序跑：`owner.js`（设备钥匙）先跑，然后 `core` · `connect` · `money` · `asset` · `intent` · `portfolio` · `markets` · `trade` · `statement` · **`agents-mount`** · `shell`。约定写在 `ui/core.js` 顶上的注释里。
- 挂载位是 `ui/agents-mount.js` 的 **`openAgents()`**：rail 上的 "Agents"、Menu → Agents 都调它（rail 上 "Agents" 旁边的数是敲门等放行的钥匙个数）。保留这个名字，换掉它的内容就是接管。现在的内容（agent 表和表单、Agent wallets、Devices）是原来那三段，原样能用，你们的模块到之前不动。
- 规矩：每个顶层名字在所有脚本里只声明一次（`test/unit/page-scripts.test.ts` 会把它们按 HTML 顺序拼起来编译、抓重名）；新文件放 `ui/<名字>.js|css`（服务只认 `ui/` 下一个简单名字），加进 `account.html`，样式加进那个测试的清单；颜色只用 `ui/tokens.css` 里的，Cream 和 Black 一起对。没有构建步骤。
- 别的屏也会把人送到 agent 的事上，这几处你们接管时要一起看：Portfolio 的 Waiting for you（卡、请求的 "Grant…" / "Decline…"，`portfolio.js` 的 `declineAsk(ask)` 和各个 Grant 表）、Trade 的 Hand to agent（`intent.js` 的 `openHandToAgent(preset)`）、Settings 里的会话和杠杆上限（`agents-mount.js` 的 `renderDial`）、Statement 的 Who 筛选。
- 能直接用的工具（都在 `core.js`）：`A`（上一次 `GET /api/account` 的结果）、`load()`、`own(draft, then)`、`api(path, {ttl})`、`openSheet` / `openDrawer` / `confirmSheet` / `pickSheet` / `quoteDialog`、`whatYouSign(prepared)`、`toast`、`esc` 和画表的 `table`、`seg`、`field`。从别的脚本里调一个打开函数之前先问 `typeof openX === "function"`。

**读**（都是 `GET`，不签名）

`GET /api/account` 里和 agent 有关的字段：

| 字段 | 是什么 |
|---|---|
| `keys[]` | 被放进来过的 agent 钥匙：`address`、`name`、`code`（航班号前缀）、`validUntil`、`approvedAt`、`status`（`ok` · `expired` · `revoked`）。同一把钥匙到期后再放进来会出现两次，以后一次为准 |
| `requests[]` | 敲门、还没被放进来的钥匙：`address`、`name`（它自己报的，洗过；和账户上的钥匙重名或形近时是空的）、`at`。最多留 8 个 |
| `spend[]` | 额度，一份一行：`id`、`agent`、`agentName`、`scope`（`trade` · `venues` · `payees` · `earn`）、`allow`、`perPaymentUsd`、`budgetUsd`、`spentUsd`、`reservedUsd`（等批的卡和没兑现的付款占着的）、`windowHours`、`validUntil`、`expired`、`payTo`（钉住的收款地址） |
| `subAccounts[]` | agent 钱包：`id`、`name`、`agent`、`agentName`、`address`、`capUsd`、`balanceUsd`；它在 `venues[]` 里是 `agent-<名字>` |
| `cards[]` | 等 owner 批的卡：`id`、`flight`、`usd`、`reason`、`hash`（批的时候要签进去）、`kind`（agent 的指令类型）、`agent`、`agentName`、`expiresAt`、`shown`（卡上要签的字段） |
| `asks[]` | agent 的请求：`id`、`agent`、`agentName`、`kind`、`venue`、`usd`、`text`、`at`、`expiresAt`。只在内存里 |
| `declinedAsks[]` | 一天内拒掉的请求，多一个 `declinedAt` |
| `intents[]` | owner 开着的意图：`id`、`agent`（地址或 `*`）、`agentName`、`venue`、`symbol`、`side`、`usd`、`text`、`validUntil`、`at`、`reports`、`report`（最新一条）、`byAgent`（每个 agent 最新一条） |
| `watch[]` | owner 关注的市场 |
| `orders[]` · `payments[]` · `earns[]` | 每一条都带 `agent`（下它的钥匙；owner 下的没有） |
| `mode` · `dial` | `guard`（Conservative）或 `open`（Aggressive）；`dial` 是 agent 的会话到哪天、是否已结束、关给 agent 的场所（`revoked`）、最大杠杆 |
| `connectLive.writes` | 服务能不能交易（`on`）、单笔上限（`capUsd`） |
| `agentSetup` | 加这个 MCP 席位的那一行命令（`command`）和服务地址（`url`） |

`GET /api/account/agents` 是同样的东西按 agent 摊开：`{asOf, mode, requests, agents: [{address, name, code, status, validUntil, approvedAt, limits: [{id, scope, allow, perPaymentUsd, budgetUsd, spentUsd, reservedUsd, leftUsd, windowHours, validUntil, expired}], cards, orders, payments, earns, wallets, intents, asks, declinedAsks, flights}]}`。`GET /api/account/statement` 的每一行也带 `agent` / `agentName`。

**要签的动作**（owner 的，都从 `POST /api/exchange` 进；字段必须恰好是这些）

| 动作 | 字段 | 要知道的 |
|---|---|---|
| `approveAgent` | `agentAddress, agentName, validUntil` | 放一把钥匙进来，最长 180 天，同时最多 4 把。撤销是 `agentAddress` 写零地址、`agentName` 写它的名字、`validUntil` 0；撤销过的不能再放进来 |
| `approveSpend` | `agent, scope, allow, perPayment, budget, windowHours, validUntil` | `scope` 是 `trade`（下单）· `venues`（在你自己的账户之间挪钱）· `payees`（从 agent 钱包付给别人）· `earn`（放进 earn 产品）。`allow` 逗号隔开：场所 id，`payees` 是域名；`trade` / `venues` 的 `*` 在签的那一刻写成当时的全部场所，之后接的不算；`payees` 的 `*` 只在勾了 "any payee" 时；`earn` 从不收 `*`，写场所或 `场所:产品`。每个 agent 每个 scope 只留一份，新的替换旧的；`budget` "0" 是收回 |
| `createSubAccount` | `name, agent, float` | 在真实账户上是建一个 agent 钱包：钥匙在本机生成（`<home>/agent-wallets/`），agent 拿不到 |
| `setIntent` | `id, agent, venue, symbol, side, usd, text, validUntil` | `id` 空是新的；`agent` 是地址或 `*`；`validUntil` 0 是收回。什么都不授予 |
| `answerAsk` | `ask, decision` | `decision` 只能是 `"decline"`。答应一个请求就是去做它要的那件事（上面这些动作），做完请求自己关掉 |
| `approveCard` | `card, action, decision` | `action` 是那张卡的 `hash`，`decision` 是 `approve` 或 `reject`；放行时所有检查重跑 |
| `setPolicy` | `change, value` | `mode` / `open`（切到 Aggressive）、`session` / `30d`（重开或续会话）、`maxLeverage` / 倍数、`restore` / 场所（对 agent 重新打开）。收紧（切回 Conservative、对 agent 关掉一个场所）不用签：`POST /api/mode {mode: "guard"}`、`POST /api/revoke {account}` |
| `convertToMultiSigUser` | `signers` | Devices：让另一个浏览器也能签，或者要两个都签 |

**在浏览器里怎么签**（`public/owner.js`）

1. `Owner.prepare(draft)`：`POST /api/account/prepare {draft}`，`draft` 是上表里的字段，不带 `nonce`。账户把它写成要签的确切动作：补上 `nonce`，动钱的补上路线、手续费上限、最晚到账，下单的补上确切数量和最多值多少。回答是 `{action, primaryType, domain, accountChain, shown, quote?}`；拒绝是 `409` 和 `{refusal}`，签之前就看得到。
2. 把 `shown` 摆给人看：`whatYouSign(prepared)`。这就是要签的全部。
3. `Owner.submit(prepared)`：浏览器从 `shown` 自己拼出签名输入（`{domain, primaryType, message}` 的规范 JSON，`message` 是 `accountChain` 加 `shown` 里的每个字段，不拿服务器给的现成字符串），用这个浏览器里导不出来的 P-256 设备钥匙签，送 `POST /api/exchange {action, nonce, signature: {kid, es256}}`。服务器用它存的公钥按同样的规则验。
4. 回答：`200` 做了 · `202` 出了一张卡 · `401` 不是签名人 · `409` 拒绝（`refusal.code` 和场所或账户的原话）。

`Owner.act(draft)` 是 1 和 3 合在一起；`own(draft, then)` 再加上忙碌状态、把结果或拒绝变成 toast、做完 `load()`。只有配对过的设备签的才算 owner；账户设了两人都签时，一个签名不够（`E_ACCOUNT_THRESHOLD`）。

**没有隔离的地方**

- 服务只听 127.0.0.1，读接口（`/api/account`、`/api/account/agents`、流水）对这台机器上的任何进程都答，不问是谁。
- 所有 agent 席位以同一个系统用户运行：每个席位的钥匙文件（`<home>/seats/<名字>.json`）、agent 钱包的钥匙（`<home>/agent-wallets/`），那个用户都读得到。MCP 席位只给 agent 看它自己的卡和单，那是显示上的选择，不是墙。
- 挡住一个 agent 的，只有它自己的钥匙签名、它自己的额度、owner 的卡和 `--live-cap`。真要把 agent 互相隔开，得让它们跑在不同的系统用户或机器上，这里没做。

## 11c · 替身账户：在不联网、不动钱的页面上点一遍

```bash
npx tsx test/standin/ui-standin.ts --port 4821          # 或 .claude/launch.json 里的 ui-standin
npx tsx test/standin/ui-standin.ts --port 4822 --cap 250 --tick 3000   # 单笔上限 $250，价格每 3 秒动一次
```

它起的就是 `npm run account` 那个服务、那个页面、那扇门，只是真实连接够得着的东西全换成替身：场所、公开行情、网络（每个请求都答"没有网络"）、链、收款方、`mm`。什么都不出这个进程，从不用 4820。

终端打印页面地址、配对码、临时 home（停了也留着，要删自己删）和种了什么。打开页面，输入配对码，这个浏览器就是 owner（替身的种子钥匙签一条 `convertToMultiSigUser` 把你加进来，它自己也留着，因为它签过的额度每次用都要对着现在的 owner 再查一遍）。

种好的：Stand-in Exchange（现货、永续、一个已有的 BTC 多头、两个 earn 产品）、Stand-in Predictions（几分钟到几天后收盘的事件，加一个十五分钟一轮的 "Bitcoin up or down"）、Stand-in Wallet（代币，其中一个 RWA）；你自己的几单和几笔挪钱；一个叫 "Claude Code" 的 agent，有额度、有钱包、下过一单、还有一张卡等你批；两个意图、一条回报、两个请求、三个关注；七天的净值点。跑着的时候价格在动，挂单会成交，止损会触发，"Claude Code" 的卡没人答过期了会再问一次。Markets 里还有几个只在公开行情里有的币和一家不服务这个地区的交易所，"Connect to trade" 能真的接上替身的公开场所。

它的 agent 钱包是本机真生成的钥匙，地址在每条 EVM 链上都是真地址：往里打真钱就是真钱，别打。

# 下半 · 模拟账户里的规则

页面上没有下面这些。它们跑在进程里的模拟账户上：八个模拟场所（Alpaca、Binance、OKX、Hyperliquid、MetaMask Agent Wallet、Kalshi、Polymarket、Ondo）、三个模拟收款方（`data.sim`、`infer.sim`、`shop.sim`）和一个可以快进的时钟。`examples/account/headless.ts` 把 owner 和 agent 的指令从头走了一遍；`npm run account:demo` 的十四个 beat 每个放行一件事、拒绝一件事。每条写的是签哪条动作、模拟账户怎么答。

## 12 · 插一个模拟的交易所钱包

owner 签 `connectVenue {venue, connector, label, credentialRef}`，一个新场所就出现在账户里：余额、跑道、agent 的权限一起出现，不改一行代码。

```
Kraken plugged in · the venue says this credential can read, trade, withdraw · withdrawals only to its verified addresses (metamask) · money in: an agent's key may; money out: an agent's key may
```

门是照这把钥匙的权限生成的：

| 目录里的 | 连接器 | 钥匙能做什么 | 钱出去那扇门 |
|---|---|---|---|
| Bybit | `unified` | 读、交易 | At Bybit：只能在交易所那边发起 |
| Kraken | `unified` | 读、交易、提币，白名单里只有自己的链上钱包 | agent 可用 |
| OKX · second account | `okx` | 只读 | At the venue；换币关着 |
| OKX Wallet | `wallet`（按地址，不交钥匙） | 读 | Yours to sign：在那个钱包里签 |

**加一个你自己的，不写代码**：往 `fixtures/home/portfolio/connectable.json` 加一项。

```json
"gate":   { "name": "Gate", "connector": "unified", "balances": { "USDT": 500 }, "key": { "permissions": ["read", "trade"] } },
"ledger": { "name": "Ledger Nano", "connector": "wallet", "address": "0x1ed6…nano", "holdings": [{ "asset": "USDC", "amount": 300, "chain": "Base" }] }
```

这份文件是模拟里「场所那一侧」：它有多少钱，它说这把钥匙能做什么。`permissions` 里有没有 `withdraw`、有没有 `whitelist`，决定出金那扇门开给谁。

- 新插上的场所**不在任何旧授权里**。要 agent 能用它，在一份授权里点它的名。
- `disconnectVenue` 拔掉。有钱在途时拔不掉：`Kraken has a payment in flight (pay-0001): it can be unplugged when that has landed`。

会被拒：已经在账户上 `E_ACCOUNT_BAD_ACTION` · 目录里没有 `E_WALLET_ACCOUNT_UNKNOWN` · 连接器不对 `E_VENUE_REJECTED`。只认真实账户的服务器拒绝所有模拟连接器。

## 13 · 给 agent 一个 float

owner 签 `createSubAccount {name, agent, float}`，再从链上钱包充进去（`sendAsset` 到 `sub:<name>`）。

float 是 agent 对外付款用的那笔钱，也是一次出错最多能丢的钱。

- 只能从链上钱包（MetaMask Agent Wallet）充，也只能回到那里。
- 充不过上限，在途的补给也算：`E_WALLET_FLOAT_CAP`。
- 只有 owner 能收回（`sendAsset` 从 `sub:<name>` 回 `metamask`）：agent 的钥匙被撤销之后，float 里的钱靠这个拿回来。

## 14 · owner 在模拟场所之间挪钱

owner 先问路线（`account.resolve(…)`），再签 `sendAsset`：签的不只是「挪多少」，还有这条路线的哈希、最高费用、最晚到账，报价变了就要重签（`E_ACCOUNT_REQUOTE`）。

| 例子 | 路线 |
|---|---|
| MetaMask → Hyperliquid · perps，$500 | Arrives $499.78 · fee $0.22 · lands ~1 min |
| OKX → Hyperliquid · perps，$400 | Arrives $398.94 · fee $1.06 · lands ~6 min · swap at OKX → out of OKX → out of MetaMask Agent Wallet → into Hyperliquid |
| Hyperliquid perps → spot，$100 | Arrives $100.00 · fee $0.00 · lands now · inside Hyperliquid |
| Hyperliquid → MetaMask，$200 | Arrives $199.77 · fee $0.23 · lands ~5 min |
| MetaMask → Alpaca | `E_VENUE_RAIL_CLOSED` · Alpaca moves dollars only by ACH with your own bank, started at Alpaca |
| OKX Wallet → Hyperliquid，$200 | OKX Wallet keeps its own key: you sign this one in that wallet |
| MetaMask → Hyperliquid，$3 | Hyperliquid takes no deposit under $5: $2.78 would arrive after $0.22 in fees, so nothing is sent |
| Bybit → MetaMask | Bybit: this key has no withdraw permission，并写明怎么开这扇门 |

**在途**：钱离开一处、还没到下一处时，付款单是 `pending`，写明哪一腿在飞、什么时候到。这笔钱不在任何余额里，谁也花不了。模拟时钟用 `svc.advance(ms)` 快进。

## 15 · agent 在模拟场所之间挪钱

agent 签 `agentSendAsset`（挪钱）或 `agentSwap`（换币）：

```
✓ pay-0002 · transfer okx → hyperliquid · $300 · pending
✓ pay-0003 · swap okx → okx · $200 · settled
```

`from` 和 `to` 只能是你自己的场所：`okx`、`hyperliquid:perps`、`metamask`、`sub:research`。会被拒，都是设计好的：

```
✗ E_ACCOUNT_OWNER_ONLY · Hyperliquid: only the master account's signature can withdraw
✗ E_VENUE_RAIL_CLOSED · Binance: this key has no withdraw permission
```

往外面的地址转是 `E_ACCOUNT_NOT_HOME`：agent 的钥匙只能让钱回家。

## 16 · agent 付一个 API（x402）

agent 签 `agentPay {url, maxAmount, fromSubAccount}`：付什么、这一次最多花多少、从哪个 float 出。agent 不知道也不用知道对方说哪种协议，那是账户的事。owner 先签一份 `approveSpend`，`scope: "payees"`，`allow` 写收款方的 host。

**第一次**付给一个收款方，先问 owner：

```
▣ card-0001 waits for the owner · a first payment to data.sim: $0.01 to 0xe0077e…d421 over x402 · EIP-3009 (Base Sepolia). Approving it pins that address for data.sim
```

批准之后这个地址就钉住了，同一个收款方以后不再问：

```
✓ pay-0008 · pay sub:research → data.sim · $0.01 · settled · bought: {"symbol":"NVDA","price":150.12,"currency":"USD","delayedMin":15}
```

会被拒：

| 码 | 发生了什么 |
|---|---|
| `E_MANDATE_RECIPIENT` | 这个 host 不在授权里。连一个字节都不会发给它 |
| `E_PAYEE_OVERCHARGE` | 对方要价高于 agent 说的「最多」 |
| `E_PAYEE_CHANGED` | 对方的收款地址和钉住的不一样。这就是攻击的样子 |
| `E_PAYEE_REDIRECT` | 对方想把请求引到别处，不跟 |
| `E_PAYEE_UNVERIFIED` | 对方的质询或回执验不过 |
| `E_WALLET_INSUFFICIENT` | float 不够 |

## 17 · 按次计费的服务（MPP）

一次一付是 `https://infer.sim/v1/answers`。会话是 `https://infer.sim/v1/stream`：存一次押金，之后每次调用签一张累计凭单。第一次的卡上写明押金：

```
▣ card-0003 waits for the owner · a first payment to infer.sim: $0.01 a call, from a deposit of up to $0.50 locked in escrow 0x4157b8…9bae, to 0x30f67e…4378 over MPP session · escrow + vouchers (Base Sepolia). Approving it pins that address for infer.sim
```

批准之后每调一次：

```
✓ pay-0006 · pay sub:research → infer.sim · $0.5 · pending · 2 calls · $0.02 of a $0.50 deposit used · bought: {"chunk":"answer 2","model":"sim-1"}
```

用完了关掉（`agentPay` 带 `close: true`），没花的押金回 float：

```
✓ pay-0006 · pay sub:research → infer.sim · $0.02 · settled · session closed: $0.02 paid for 2 calls, $0.48 back in float "research"
```

- owner 也能关：`setPolicy {change: "close-session", value: <channel id 或 host>}`。agent 的钥匙被撤销之后只有这条路。
- 押金在托管合约里时占着预算。
- 收款方不理：账户直接向托管合约申请退出，宽限期（15 分钟）过后钱自己回来。

## 18 · agent 买东西（AP2）

从 float 付 `https://shop.sim/items/desk-feed-pro`。第一次同样出卡；批准之后商户要 agent 用自己的钥匙签两份 mandate：「这次结账」和「这笔付款」。agent 先拿回商户签过的结账单，核对总价不超过「最多」才签，再发一次：

```
the merchant asks for mandates on checkout co_000002 (29 USD): signing with the seat's key
✓ pay-0010 · pay sub:research → shop.sim · $29 · settled · bought: {"order":{"id":"order_000002", …
```

不写 float 的付款是 `E_PAYEE_UNSUPPORTED · shop.sim is paid in USDC: name the float that pays`：账户上没有卡，卡支付（ACP）没有搭。

## 19 · 付给别人（Send）

1. owner 签 `setDestination {label, address, chain, token}`，把收款人放进地址簿。
2. 等一天（`svc.advance(DAY)`）。
3. owner 签 `sendAsset`，`destination` 是那个地址，`destinationDex` 是它的链。

只有 owner 能签，发出去撤不回。

会被拒：不在地址簿里，或者地址对但链不对 `E_ACCOUNT_DESTINATION` · 还在一天冷静期里 `E_ACCOUNT_DEST_COOLING` · 在黑名单上 `E_WALLET_BLOCKLIST`。

## 20 · Unified：让账户挑来源

owner 签 `userSetAbstraction {abstraction: "unifiedAccount"}`。之后 agent 的 `agentSendAsset` 可以不写来源，账户在授权点名的场所里挑最快到的：

```
✓ pay-0011 · deposit metamask → hyperliquid · $100 · pending
```

Separate 下同一条指令是 `E_ACCOUNT_SOURCE`。

## 21 · 写你自己的 agent 席位

`examples/account/agent-seat.ts` 就是一个完整的席位。要点四个：

1. **一把钥匙**。示例里从名字派生，所以是公开的；真的席位自己生成，放进操作系统的钥匙串。
2. **一个动作**：对真实账户是 `agentLiveOrder` · `agentLiveCancel` · `agentLiveAmend` · `agentLiveClose` · `agentLiveLeverage`（下单那一组）、`agentLiveMove`（挪钱）、`agentLiveEarn`（earn）、`agentPay`（从 agent 钱包付），加上两句不授权的话 `agentReport` · `agentAsk`；在模拟账户里还有 `agentSendAsset`（挪钱）· `agentSwap`（换币）。字段必须恰好是类型里那几个，多一个少一个都是 `E_ACCOUNT_BAD_ACTION`。
3. **nonce 取账户的时钟**：`GET /api/now`，不要取本机时间。资金指令只在它标注的时刻前后十分钟内有效（`E_ACCOUNT_EXPIRED`）。
4. **签名，发出去**：`signAgent(key, action)` 得到 `{action, nonce, signature}`，`POST /api/exchange`。

别的语言要自己实现签名，定义在 `src/portfolio/account/sign.ts`：`AGENT_DOMAIN`、`AGENT_TYPE`、`agentActionHash`。不想起服务，就像 `examples/account/headless.ts` 那样在进程里直接调 `svc.exchange(envelope)`。

## 22 · 加一种连接器

真实连接在 `src/portfolio/live/index.ts` 里一种一个（交易所走统一接口库，其他各有各的）。模拟的连接器，统一接口库覆盖的交易所不用加：在目录里写 `"connector": "unified"`（第 12 条）。一家交易所有自己的请求格式、想让账本里记下它原生的请求时，才加一份声明：

1. `src/portfolio/account/doors.ts` 的 `EXCHANGES` 加一项：`label`、`credential`、`probe`（问钥匙权限的那个调用）、`deposit`、`withdraw`、`convert`、`inside`（它内部的账本之间怎么挪）。
2. 同一个文件的 `nativeRequest` 里加一个分支，把一腿写成它自己的请求。
3. `test/unit/account-connect.test.ts` 里照着已有的加一条。

## 23 · 攻击它

```bash
npx vitest run test/attack
```

二十六个文件。早的十九个，每个是一次真实跑通过的攻击，写成 `it.fails`：测试断言「攻击成功」，并被期望失败。哪天攻击又能成功，这个测试就报错。后来加的七个（`order-door-holes`、`real-pay-holes`、`restore-holes`、`steer-holes`、`earn-holes`、`seat-reads`、`ask-candles-earn-holes`）一个文件一组攻击，每个测试直接断言攻击不成：真钱的下单门、真钱付款、重启重建、引导（意图、关注、回报、请求）、earn 门和永续的地区线、席位之间看得见什么、拒请求和 K 线的 host 和 earn 只算一次。`seat-reads` 的最后一个测试钉住的是边界本身：读接口对本机任何进程都开着，席位的过滤不是墙。

找到新洞时照这个顺序：先写成一个普通测试，让它通过，证明洞是真的；修；把 `it` 改成 `it.fails`（或者像后来的七个那样，改写成断言攻击不成的测试，修之前它必须是红的）；再在 `test/unit/` 里加一条正面的回归测试。

## 出了状况先看这里

| 现象 | 原因 |
|---|---|
| `npm run account` 报 `port 4820 is already in use` | 已经有一个在跑了，直接打开页面。要第二个就加 `--port 4821 --home 〈另一个目录〉` |
| 页面按钮全灰，顶栏下面一行 "can look but not sign" | 你不是 owner，见第 1 条 |
| 钥匙文件那一步一直 "Waiting for the file…" | 路径不对，或者文件还没存盘。复制弹窗里的路径或那条命令 |
| 席位一直 `401` | 钥匙没授权、过期或被撤销，见第 3、9 条 |
| `this account holds real accounts only` | 这条指令只动模拟的钱。下单走 `liveOrder` / `agentLiveOrder`，动钱走 `liveMove` / `agentLiveMove`，见第 5、6、7 条 |
| Trade 屏上少一个宫格，或下单票的 Where 里这家写着原因 | 服务是 `--read-only` 起的（宫格全没有）；或者钥匙没开交易（标签 "Read-only key"，Details 里写着要勾什么，Venues 板上 "Connect a new key"）；或者这个场所不能从这里下单（按地址接的 Hyperliquid、Ondo、只填了地址的 Polymarket）；没有一家做得了的宫格不画 |
| Markets 的一行写着 "Connect to trade" | 那是没接的场所的公开行情：点它接上那家，见第 2c 条 |
| Markets 下面一行说某个场所没答或不服务这里 | 那是场所自己的话（Binance 451、Bybit 403 是按地区拒绝）；没答的二十秒内不再问 |
| 净值曲线不画，或只写 "since …" | 不到两个点，或历史还短：账户每五分钟记一个点，之前的不知道，见第 2b 条 |
| Assets 写 "Cost known for 1 of 3" | 有的币是账户之前就有的、或从别处转进来的，账户没见过它的成本，见第 2b 条 |
| 代币化股票的签名按钮按不下去 | 发行方关了或限制了它（OUSG、BUIDL 从不 swap），原话写在按钮上方，见第 5b 条 |
| agent 一直要额度 | 它在 `portfolio_ask`。Waiting for you 里 "Grant…" 或 "Decline…"；拒掉的它一天之内看得见，见第 8b 条 |
| 下单回 `E_VENUE_ORDER_INVALID` | 不到这个市场的最小单，或者数量、价格不在步长上：下单票的价格行写着步长 |
| Binance 的 key 下不了单 | 系统生成的 key 不绑 IP 只能读：绑本机 IP，或者用自己生成的 Ed25519 key |
| `E_ACCOUNT_EXPIRED` | nonce 用了本机时间。取 `GET /api/now` |
| `E_ACCOUNT_NONCE` | 这条指令收过了。同一条重发拿到的是第一次的结果，改了内容要换 nonce |
| 刚接上的账户 agent 用不了 | 它不在旧额度里，见第 3 条 |
| agent 的单没有出卡就下了 | 模式是 Aggressive，见第 4 条 |
| 重启之后有的账户没接回来、agent 的请求不见了 | 顶栏下面那一行的 details 写着没接回来的和原因（例如 Robinhood 的登录令牌只在内存里，要重新登录）；请求只在内存里，重启就没了，关注和意图会接回来，见第 10 条。`--fresh` 起的什么都不接 |

## 拒绝码速查

| 码 | 意思 |
|---|---|
| `E_ACCOUNT_UNKNOWN_SIGNER` · `E_ACCOUNT_AGENT_EXPIRED` · `E_ACCOUNT_AGENT_REVOKED` | 这把钥匙不是（或不再是）签名人 |
| `E_ACCOUNT_BAD_SIGNATURE` · `E_ACCOUNT_BAD_ACTION` | 签名对不上，或者动作的字段不是签名覆盖的那些；在只认真实账户的服务器上，也是只动模拟钱的指令 |
| `E_ACCOUNT_NONCE` · `E_ACCOUNT_EXPIRED` | 用过的 nonce，或者离标注的时刻超过十分钟 |
| `E_ACCOUNT_OWNER_ONLY` | 这件事只有 owner 能签：提现、Send、授权、批卡、收回 float、关注、意图、拒一条请求 |
| `E_ACCOUNT_NOT_HOME` | agent 想把钱送到你自己的场所之外 |
| `E_ACCOUNT_SOURCE` | 没写来源而账户是 Separate；或者动了别人的 float |
| `E_ACCOUNT_DESTINATION` · `E_ACCOUNT_DEST_COOLING` | 目的地不是你的、不在地址簿、链不对，或者还在冷静期 |
| `E_ACCOUNT_REQUOTE` · `E_ACCOUNT_CARD_EXPIRED` | 签过之后价格或报价变了；卡过期了 |
| `E_ACCOUNT_ORDER_UNKNOWN` | 账户上没有这张单，或者它不是这把钥匙下的（agent 只能撤自己的单） |
| `E_VENUE_ORDER_INVALID` · `E_VENUE_MARKET_CLOSED` · `E_VENUE_INSUFFICIENT` | 场所不按这样的数量、步长或价格接单；市场收盘了；余额不够 |
| `E_ACCOUNT_FEE_CAP` · `E_ACCOUNT_THRESHOLD` · `E_ACCOUNT_UNPRICED` | 应用抽成高于你批的费率；签名人不够；这个币没有价格，没法判额度 |
| `E_ACCOUNT_LIMIT` · `E_ACCOUNT_OWNER_SURFACE` | 超过账户自己的上限（含 `--live-cap`，平仓和 earn 也算；关注、意图、请求、回报的条数）；一个没签名的请求打到了只认 owner 设备的接口上，或配对码不对 |
| `E_MANDATE_NONE` · `E_MANDATE_RECIPIENT` · `E_MANDATE_PER_ORDER_CAP` · `E_MANDATE_BUDGET` · `E_MANDATE_RATE` · `E_MANDATE_EXPIRED` | 额度的线（交易、挪钱、付款、earn 四种一样）：没有额度、没点名、超单笔、超预算、太频繁、到期 |
| `E_MANDATE_INVALID` | AP2 的 mandate 验不过 |
| `E_PAYEE_OVERCHARGE` · `E_PAYEE_CHANGED` · `E_PAYEE_REDIRECT` · `E_PAYEE_UNVERIFIED` · `E_PAYEE_REJECTED` · `E_PAYEE_UNSUPPORTED` | 收款方那边的线：加价、换地址、重定向、验不过、不收、说的协议账户不会 |
| `E_VENUE_RAIL_CLOSED` · `E_VENUE_MIN_DEPOSIT` · `E_VENUE_WITHDRAW_WHITELIST` · `E_VENUE_PERMISSION` | 场所自己的线：这扇门不对你开、低于最低额、地址不在白名单、钥匙不许 |
| `E_VENUE_TRANSFER_RESTRICTED` · `E_VENUE_REJECTED` | 发行方的线：代币只在它批准过的钱包之间转（OUSG、BUIDL）；场所或发行方不认（发行方不认这个代币、不在这条链上发、清单没应答；mm 说不出这台机器在哪，永续就不下） |
| `E_WALLET_FLOAT_CAP` · `E_WALLET_INSUFFICIENT` · `E_WALLET_BLOCKLIST` | float 满了、不够，或者地址在黑名单上 |
| `E_ACCOUNT_CREDENTIAL` · `E_VENUE_UNREACHABLE` · `E_VENUE_GEOBLOCKED` · `E_VENUE_UNAUTHORIZED` | 真实连接：钥匙文件不能用、场所没应答、场所不服务这个地区、场所不认这把钥匙 |
| `E_WALLET_LIVE_WRITES_OFF` | 这个服务是 `--read-only` 起的，或者 MetaMask 自己的开关没开 |
| `E_WALLET_SESSION_EXPIRED` · `E_WALLET_ACCOUNT_REVOKED` | agent 的会话结束了；这个账户对 agent 关着 |
