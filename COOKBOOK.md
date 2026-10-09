# Account Cookbook

[README](README.md) 是一页的总览，[docs/account.md](docs/account.md) 讲这一层**是什么**的全部细节，这里讲**怎么做**。每条做法写的是：想做什么、怎么做、会看到什么、什么会被拒。

分两半。**上半是你真实的账户**：`npm run account` 起的服务，一个桌面钱包页面（`/`），叫 Account，样子是 Demo v2 画布第七轮的：左边一条 rail（Markets · Trade · Agents），rail 最下面的 Account 钱包打开三页 Portfolio（你有什么）· Venues（接上的账户）· Memory（agent 记得什么）。**下半是模拟账户里的规则**：场所之间的路由、float、替 agent 付 API（x402、MPP、AP2）、地址簿、Unified、可插的模拟场所。这些只跑在进程里（`examples/account/headless.ts` 从头走一遍，`npm run account:demo` 的十四个 beat 带断言，外加测试）；只认真实账户的服务器对这类指令一律回 `this account holds real accounts only`。模拟里的钥匙从源码里的标签派生，是公开的。

## 三个角色，一个入口

- **owner**：钱的主人。页面上是浏览器里一把导不出来的设备钥匙。脚本和测试里是一把从标签派生的钱包钥匙。
- **agent**：一把钥匙。owner 放它进来、给了额度之后，它能在你真实的账户上下单（还可以请求在账户之间挪钱，要另一份额度）。Guard 下每一单都等你签；Beast 下额度内直接下。别的都不能。
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
| 让 Claude Code、Codex 这类 agent 来当 agent | Agents 弹层里 "Copy agent setup command" 复制的那一行（Portfolio 的三步清单里是 "Copy setup command"）：`claude mcp add portfolio -e PORTFOLIO_URL=http://127.0.0.1:4820 -- npx tsx <仓库的绝对路径>/src/portfolio/mcp.ts`（第 11 条） |
| 让 DeepSeek Harness 来当 agent | 第 11 条的配置 |
| 在一个不联网、不动钱的账户上把页面点一遍 | `npx tsx test/standin/ui-standin.ts --port 4821`（第 11c 条） |
| 模拟账户里的规则，一个脚本从头走到尾，不起服务 | `npx tsx examples/account/headless.ts` |
| 十四个 beat 的断言脚本 | `npm run account:demo` |
| 从这台机器能接哪些场所（每家用自己的话；不含 IP、地方、钥匙，可以贴给别人） | `npm run account:check`；`-- --keys` 再只读地打开 home 里有钥匙文件的连接 |

`npm run account -- --port 4821 --home /tmp/x` 另起一个互不相干的实例。`--classic` 是原来的模拟对账单，不挂这一层。

页面是一个桌面钱包：

- **左边的 rail**（第七轮 F1 / F5 的样子）：圆的 "A" 和名字；Markets · Trade；"Agents"（数是敲门等放行的 agent）；最下面纽约时间的钟（账户不应答时一枚 "Not answering since HH:MM"），和 **Account** 钱包按钮：净值 · 模式（"$12,480 · Guard"），旁边的数是等你批的卡加 agent 的请求（浏览器标签页的标题也带着，比如 "(2) Account"）。手机宽度上 rail 变成顶上一条：第一行圆标和 Account，第二行 Markets · Trade · Agents。
- **Account 的头**（Portfolio · Venues · Memory 三页上）：Account · Lens（All accounts / 一个场所 / 一个 agent，表都按它筛）；右边 Mode（Guard | Beast 两个按钮，ⓘ 打开 "What changes"，第 4 条）· "Trading on · $250 a move"（或 "Read-only"）· "Settings" · 时钟图标（Statement）；下面一行三页的切换，和这一档模式的一句说明。
- **Markets 和 Trade 的顶栏**：Lens、搜索（按 `/`，打字就去 Markets 搜；在 Account 的三页上按 `/` 先去 Markets）、时钟图标。按 `t` 打开下单票。重启过的，顶栏下面一行写着接回了什么。没有 Menu。
- **几页**：Portfolio（第 2b 条）、Venues（第 2 条）、Memory（第 8c 条）、Markets（第 2c 条）、Trade（第 5 条）。
- **弹层**：Statement（第 5 条）、Mode（第 4 条）、Settings（交易开没开和单笔上限、agent 的会话和杠杆上限、背景 Cream / Black、Devices）、Agents（第 3 条）、Receive（第 2b 条）、Move（第 7 条）、Earn（第 7c 条）、Sell many（第 5b 条）；右边的抽屉是一个市场（Portfolio 的资产行打开的也是它）或一个账户的 Details。要你确认的都是页面自己的小问话框，没有浏览器的 `prompt` / `confirm`。

`seat` 是这个别名：

```bash
alias seat='npx tsx examples/account/agent-seat.ts'
```

## 1 · 成为 owner

能交易的服务（默认）在终端打印一个配对码：打开页面，顶栏下面那一栏写着 "Enter the pairing code shown in the terminal."，输入它，点 "Pair"，这个浏览器才成为 owner。`--read-only` 起的服务，第一个打开页面的浏览器就是 owner。Settings 弹层的 Devices 里那一行写着 "This browser"。

- 不是 owner 时，那一栏写着 "This browser can look but not sign. Add it under Devices from your other browser."，要签的按钮都是灰的。每个打开过页面的浏览器都在 owner 的 Devices 里以 "A browser asked to sign" 出现（最多 10 个在等；没有清理，重启才清空），让 owner 的浏览器点它那一行的 "Let it sign"。放进来的设备各签各的，一个签名就够；"Require both" 撤掉了，等账户有了给第二个签名的流程再回来（Devices 下面那行字说的就是这个）。另一个浏览器放它进来以后，这一页不用刷新就成了 owner。
- 配对码输错五次就不再收，重启服务换一个新码。
- 服务重启后**还是这个浏览器当 owner**，不用再配对（第 10 条）。新浏览器要在 Devices 里被加进来。想干净地重来，`--fresh`，或换一个 `--port` 和 `--home`。
- 这个浏览器的数据被清掉了（换了浏览器、清了站点数据），它就不再是 owner，也没有别的 owner 能把新浏览器加进来：用 `npm run account -- --fresh` 重来一次（以前签的授权不会带过来，账本和钥匙文件都还在）。

## 2 · 接你真的账户

"Connect an account" 打开一组卡片，按 Exchanges · Brokers · Wallets · Markets and tokens 分组（服务能接、上面没列的，放在 "More" 里）。它在这几处：Portfolio 的三步清单第一步；Account › Venues 右上的 "Connect an account"；一个都没接时 Trade 屏的 "Connect an account"。agent 请求你接一个场所时，Waiting for you 里那条请求的 "Connect" 直接是那家的表单。点哪张就是哪个的接法，已经接上的写着 "Connected · add another"。银行和卡不在里面：它们没有给个人的接口。

卡片上已经写着每家对**你**怎么样：账户启动后几秒、之后每 30 分钟，自动替每个场所问一遍它在建 key 之前的那个问题（不带任何钥匙、令牌或地址：交易所的公开时钟、Alpaca 和 Robinhood Crypto 不带 key 的一次 GET、Kalshi 的公开状态、Polymarket US 公开 gateway 的一次市场列表、Polymarket 自己的地区检查、Robinhood 登录的两份公开元数据、本机 `mm auth status`、Hyperliquid 条款 §1.6 对你此刻所在地方的规定），再把场所公布的居住地规矩对上这台机器此刻所在的地方（`GET /api/account/venues`，开发者文档「地区」一节）。场所说不服务这个网络的，卡片写 "Not served here"（悬停是它的原话），点进去是它的原话和问的时间、"Check again"，建 key 的步骤收起来、Connect 按不了；Polymarket 和 Hyperliquid 的还给一个 "Watch … by its address instead"，那是只看、不交易。场所只让你那里平仓的（Polymarket 对美国），卡片写 "Close only here"，照样能接：读得到持仓，能卖、能撤单，买入会被它的原话拒掉。连不了的场所如果有给你那里的另一个版本（Binance → Binance.US、OKX → OKX US、Polymarket → Polymarket US：另一家公司、自己的账户和钥匙），而且那个版本从你的网络能接、它自己的话说它是为你那里做的，表单里就有 "Connect Polymarket US instead"（没有自己卡片的版本，旁边多一张它的卡）。它的条款排除你所在地方的，卡片写 "Its terms exclude where you are"，点进去是它条款的原话、链接和读的日期——**只提示、不拦**，开户时的居住地审核是场所的事。mm 没装或没登录的写 "Set up first" 和要跑的命令。一个都没答的不标，Connect 时照样再问。所在的地方只在内存里用于这个判断，不保存、不返回。从开发者那台机器（美国，2026-10-08）：Binance、Bybit 和 Hyperliquid 的交易连接不服务那里，Polymarket 的交易连接只能平仓，其余的都答；这只是美国网络看到的，别处照各自的网络算。

**交易所**（OKX、Kraken、Coinbase、Bybit、Binance，或 "Another exchange" 从统一接口库用 API 钥匙接的 93 家里挑；Binance.US、OKX US 也在里面，连不了的那家旁边会直接多一张它的卡）：

1. 点卡片，弹窗里三步。第一步 "open its API page" 打开交易所自己建 key 的页面，建一把**能交易、不能提币**的 key。下面一行用这家自己的话写要勾什么，例如 OKX：Read 和 Trade（要在资金和交易账户之间划转再勾 Transfer），Withdraw 不勾，绑本机 IP（不绑 IP 的交易 key 闲置 14 天会被删）；Coinbase：签名算法选 ECDSA，权限 View 和 Trade；Binance：系统生成的 key 不绑 IP 只能读，要交易就绑 IP，或者用自己生成的 Ed25519 key。
2. 第二步给出它要的文件路径（默认 `~/.buyer-agent-demo/credentials/okx/api-key.json`）和字段（`apiKey`、`secret`，OKX（含 OKX US）、KuCoin、Bitget 还要建 key 时设的 `password`）。"Copy" 复制路径；"Copy setup command" 复制一条命令：建目录、写一个空模板（文件已经在就不动它）、`chmod 600`、用 `nano` 打开，你把值填进去存盘。
3. 第三步每两秒自己检查一次，只看字段名，不读值：`Waiting for the file…` → `Missing: password.` → `Others on this machine can read it.`（旁边 "Copy fix" 复制 `chmod 600`）→ `Ready.`
4. 点 "Connect"。

```
OKX connected live · $1,000.00 there now · the venue says this credential can read, trade · bound to an IP list · it can do more than read (trade) · real money moves only when you sign it, at most $100.00 a movement
```

页面上这一句缩成 "OKX connected · $1,000.00"，后面 "details" 展开是全文。Account › Venues 多一行：价值是 OKX 自己报的，半分钟读一次；状态是几枚标签，第一枚是健康（✓ Answers；✗ Not answering，悬停看它最近一次的原话；Not read yet），后面是它从这里能做什么（Trades、Moves money、Receives、Earns、Watched）；"Open to agents" 开关（第 9 条）；"Details" 打开右边的 Account 抽屉：价值和标签，"Trade…" · "Move…" · "Receive" · "Show only this"，它持有什么（Holds），从这里能做什么和为什么不能（From here：它交易什么、场所对这把钥匙的说法、最近一次答了还是失败了），最下面 "Disconnect…"。钥匙没开交易的，那枚标签写场所自己的话（没有就是 "Key can't trade"），Details 里写着这家要勾什么，还有 "Connect a new key"：先确认，签一次拔掉，再用同一个名字、同一个钥匙文件按这家自己的连接重新接。

**钱包**（OKX Wallet、Binance Wallet、MetaMask 扩展等）：在装了钱包的浏览器里点 "Browser wallet"，再点你的钱包。钱包先给地址，再签一句话（不是交易，什么都不批准），这个地址就是你的，从它可以换币（下面第 5 条）。"Watch an address" 只粘贴地址：能看，既不交易也不收发。

**Hyperliquid**：卡片 "Hyperliquid" 是 API 钱包连接：在 app.hyperliquid.xyz → More → API 里起个名、Generate、Authorize API Wallet（最长 180 天），把它的私钥放进 `privateKey`、你账户自己的地址放进 `walletAddress`（`credentials/hyperliquid-trade/api-key.json`）。API 钱包只能下单、不能提币；账户自己的私钥拒收。接上以后永续、现货、HIP-3（含 io:ANTH 这类 pre-IPO）都在 Trade 里下，每一单、每次改杠杆之前按它条款 §1.6 查你此刻所在的地方。只想看，用 "Hyperliquid · by address"。

**Robinhood**：
- 投资账户：卡片 "Robinhood" → "Sign in at Robinhood…"，在 Robinhood 自己的页面登录、批准，回来点 "Connect"。读各账户的现金和股票持仓；下单只在 Robinhood 的 Agentic 账户里，整股。令牌只在服务的内存里，重启要重新登录。
- Crypto：在 Robinhood 网页版的 crypto 账户设置里建 API 凭据（你自己生成 Ed25519 密钥对，把公钥交给 Robinhood，勾上读和下单）。卡片 "Robinhood Crypto" 走和交易所一样的三步，字段是 `apiKey`、`privateKey`（base64 私钥）。
- Stock Tokens：接任何钱包（包括 "Watch an address" 粘贴 Robinhood Wallet 的地址）都会一起读 Robinhood Chain 上的 Stock Tokens。

**其他**：Alpaca 是钥匙文件（它的 key 没有权限可选，任何 key 都能下单；现金只能在 Alpaca 那边用 ACH 动；接入时问一次 `GET /v2/wallets`，Alpaca 给这个账户开了 Crypto Wallets API 的，Receive 能给出它在 Ethereum、Arbitrum 上的充值地址，提币不从这里走——Alpaca 已把 Trading API 的加密提币下线（2026-10-09 日落），加密在它的 app 里提到那边白名单过的地址；没开的，Details 里是 Alpaca 自己的答复；先用 Paper 账户的 key 试）；Kalshi 是 `keyId` 加它给的私钥 `.pem` 的路径 `privateKeyFile`（有权限可选时选 `read` 和 `write::trade`）；Polymarket US 是 `keyId` 加 `secretKey`（在它的 app 里做完身份验证，用同一种登录方式去 polymarket.us/developer 生成；Secret Key 只显示一次；它的 API 不动钱）；MetaMask Agent Wallet 走本机的 `mm` 命令行（先确认 `mm wallet show` 能用）；Polymarket 要交易用账户钱包的钥匙文件，先问 Polymarket 自己这个地区让不让用，按它文档里的三档：完全封锁的（受制裁地区）不接；只能平仓的（美国在内）照样接，能卖、能撤单，买入被它的原话拒掉；只限网页的照常（在美国开新仓用上面的 Polymarket US）（用钥匙接上的，Receive 给出下单钱包的地址收 Polygon 上的 pUSD，别的 EVM 链给 Polymarket 的桥为这个钱包生成的专属充值地址，带它的最低额；只填地址看的给不出地址）；Hyperliquid、Ondo 只填地址、只读（Hyperliquid 只认账户自己钥匙的签名：按地址接的只读，不写）。

拔掉在那一行的 Details 抽屉里点 "Disconnect…"，先确认一次，再是一次签名。还有没完成的单时拔不掉，先撤单。场所那边的钥匙不动，要删去那边删。agent 钱包没有 "Disconnect"：账户握着它的钥匙和里面的钱，要收走用 Agents 弹层里的 "Take back…"，它随 agent 的子账户留在账户上。Accounts 段头的 "CSV" 下载每个账户的持有。

会被拒：钥匙文件不在、权限不是 600、缺字段 `E_ACCOUNT_CREDENTIAL` · 交易所不认这把钥匙 `E_VENUE_UNAUTHORIZED` · 钥匙绑的 IP 里没有这台机器现在的地址 `E_VENUE_PERMISSION`（拒绝里写明，去交易所把地址加进钥匙的 IP 名单）· 场所不服务这个地区 `E_VENUE_GEOBLOCKED`（Binance、Bybit 从这台机器就是这样，那是它们的规矩；卡片在建 key 之前就会写出来）· 没应答，或连接器抛了异常、答得账户读不懂 `E_VENUE_UNREACHABLE` · 统一接口库不认识这个交易所 id、或连接器名字不对 `E_WALLET_UNKNOWN_VENUE` · 已经接过同一个 `E_ACCOUNT_BAD_ACTION`（第二个账户在弹窗的 "More options" 里换一个 "Shown as"）· 还有没完成的单 `E_ACCOUNT_BAD_ACTION`。

## 2b · Portfolio：你有什么，在哪

rail 最下面点 Account（钱包按钮），落在 Portfolio。都按 Account 头上的 Lens 筛。左边一栏从上到下：

1. **Next steps**：三步（Connect an account → Connect an agent → Give it a limit）没做完时在最上面，写着做到第几步；一个都没接时它就是整页（"Get started"）。
2. **Net worth**：一个数，下面一行变化，跟着右边的范围走：1D 是今天，每个持仓按它市场自己报的 24 小时涨跌算；1W / 1M / All 按曲线算，比第一个点还早的写 "since <日期>"。脚注都收在旁边的 ⓘ 里：24 小时变化覆盖了多少（有持仓没有场所报，就写明，不估）、在途的钱算在数里、agent 付出去的不算亏、接拔不算变化、某个场所用的是上一次的好数。
3. **曲线**：1D / 1W / 1M / All。账户每五分钟记一个点（接上、拔掉一个场所时也记一个，标在曲线上），从第一个点开始，不到两个点不画；指针放上去读出那一点。Lens 是一个场所或一个 agent 时换成 "Show all accounts"：曲线是整个账户的。
4. 快捷操作：Trade · Move · Receive · Hand to agent，做不了的不出现。
5. 两段 **Assets | Positions**，段头右边是这一段的工具（`#/portfolio?view=positions` 直接打开那一段）；原来的第三段 Accounts 现在是 Account 的 Venues 一页（`#/venues`，旧的 `?view=accounts` 链接落到那里）：
   - **Assets**：每个资产一行（交易所的 BTC、Arbitrum 钱包里的 WBTC、券商的 BTC 是同一行，名字下面是在哪些场所）：Amount · Price · 24h · Value；earn 的钱是自己的一行，下面 "Withdraw…"（第 7c 条）。工具："Sell many…"（第 5b 条）。
   - **Positions**：所有场所的持仓：Position · Value · Entry · Mark · Liquidation · P&L，右边 "Close…"（币、股票、合约这样的持有是 "Sell…"，第 5 条）。

右边一栏：

6. **Waiting for you**：agent 的卡和请求，按 agent 分组（第 8、8b 条）。回答是第七轮的圆键：32 的圆形图标，蓝的 ✓ 是 Approve（一次签名）、✗ 是 Reject；请求的 ✓ 是 Grant（打开你签的那张表）、插头是 Connect、✗ 是 Decline；敲门的 ✓ 是 Let in。每个键给读屏器和悬停都有它的字。
7. **Agents at work**：你开着的意图，带每个 agent 最新的回报（"Change words" / "Withdraw"，第 8b 条）；下面是 agent 最近的五件事，✓ 做了、✗ 被拒；"Statement" 打开流水。
8. **Cash ready**：现金和美元稳定币一个数，一行写其中多少能在你的账户之间挪；有接上的场所做 earn 时右上 "Earn…"（第 7c 条）。
9. **Allocation**：一条配置条和图例。

点 Assets 的一个资产打开右边的**那一个抽屉**，和 Markets 里点一行开的是同一个（第 2c 条）：价格、每个场所的价格、K 线（5m / 1h / 1d）、你持有的、持仓和 "Close…"、挂单和 "Cancel"、成本价、流水里相关的行；"Buy" / "Sell"（打开 Trade 的下单票，种类、场所和市场已经填好）/ "Hand to agent"。

**Receive**（快捷操作 "Receive"，或 Details 抽屉的 "Receive"）：一张平的清单，蓝本是 MetaMask 的 Receive。最上面一个搜索框和一行警告："Send only the asset on the network the row names: anything else may not arrive."。下面一行一个"账户 × 网络"：

- 钱包（agent 钱包、证明过的钱包）只有一行，写 "All EVM networks: Base, Arbitrum, Optimism, Polygon, Ethereum…"：同一个地址在每条链上都一样；按地址接、证明过的 Polymarket 钱包一行 Polygon · pUSD。
- 交易所每条网络一行，带一个资产选择（钱包那一行没有）：交易所每种资产给不同的地址，默认是它持有最多的那种美元，换一种那一行就再问一次。Kraken、KuCoin、Coinbase 这类要先生成的，账户替你调它的生成接口再读一次；开了 Crypto Wallets 的 Alpaca 给它在 Ethereum、Arbitrum 上的钱包地址。用钥匙接的 Polymarket 也是每条网络一行：Polygon 上是下单钱包的地址，收 pUSD；别的 EVM 链是它的桥为这个钱包生成的专属地址（先问桥这条链收不收这个币、最低多少）。
- 地址在那一行滚到眼前时才去问（同一个场所的一个接一个），完整显示，"Copy"；要 memo 的多一行 "Memo / tag — needed with it" 和它自己的 "Copy"；下面一行是场所的话。
- 给不出地址的账户（只看的地址、只读的钥匙、不收钱的场所）在最底下各一行，写它的原话。

快捷操作的 Receive 列全部；Details 抽屉的只列那个账户，"All accounts" 回到全部。它只说往哪打，打不打是你的事。

几条要知道的：

- **成本价**只来自两处：账户自己下过的单（每一次运行的账本都算），和场所自己报的入场价（券商、预测市场、永续）。账户之前就有的、从别处转进来的币，成本账户没见过，所以 Assets 下面写 "Cost known for 1 of 3"：三个资产里只有一个的成本是全知道的。没价格的成交不算进去，场所没报的手续费不猜。
- **净值的变化不是收益**：接上一个场所不是赚，拔掉不是亏（按两个点之间都在的场所算）；agent 从 agent 钱包付出去的钱加回来；但你在场所自己网站上的充值提现账户看不见，算在变化里。第一个点之前的历史不知道，也不补。点在 `<home>/portfolio/networth.jsonl`（只有你能读），是派生数据，丢了只丢一条曲线。
- Earn 里的钱是 Assets 里单独的一行（"earning 5.2% at OKX"），算在净值里，不算 Cash ready；同一笔钱不会在场所的余额里再算一次（第 7c 条）。

agent 读同样的东西：`portfolio_holdings {cost}`、`portfolio_history {range}`、`portfolio_asset {key}`、`portfolio_receive {venue, asset, network}`。

## 2c · Markets：有什么可以交易

rail 上点 "Markets"，或在顶栏搜索里打几个字母。一张表里两样东西：

- **你接上的场所**列的市场；
- **你没接的场所**不带钥匙读来的真实公开行情：Kraken、Coinbase、OKX、Binance、Bybit 的公开 ticker，Hyperliquid 的永续（"Connect to trade" 接的是 Hyperliquid 的 API 钱包连接；MetaMask Agent Wallet 的 `mm perps` 也能下），Kalshi 名单上 12 个 series 的市场、Polymarket 按 24 小时成交额最忙的事件和 Polymarket US 六个分类里最热的市场（下面 **Predictions**），Robinhood 的 Stock Token 清单，九个源的 pre-IPO 永续（下面 **Pre-IPO**）。这些行写 **"Connect to trade"**，点了就是那家的连接表单；接上以后，开着的下单票自动换成它。

Markets 只管看和挑，不管账户：接上、拔掉、对 agent 开关、换钥匙都在 Account › Venues（第 2 条）。

同一个东西是一行（BTC/USDT、BTC-USD、WBTC 都是 BTC；一个问题的 YES 和 NO 是一张卡；一家 pre-IPO 公司是一行），后面列着在哪些场所有。数字只用场所自己报的：Kraken 不报 24 小时涨跌，就不显示；Kalshi 的成交量是合约数，不换成美元；公开行也列买一卖一（Bid / Ask）；Kalshi 标题里的 markdown 星号去掉。离别家价格超过 10% 的当作同名的另一种东西，排除，在下面写明。没应答、或不服务这个地区的场所（从这台机器看 Binance 是 451、Bybit 是 403），写进列表底下那一行，用它自己的话，不找别的路；没应答的搁 20 秒不再问，说不服务这个地区的搁 10 分钟。

- **Tab**：All · Crypto · Stocks · RWAs · Perps · Pre-IPO · Predictions，没有东西的不显示，和 Trade 的六种同样的词、同样的顺序；搜索时多一个 "All results"；关注了东西时还有 "Watching"。没有 Sports（Macro 并进了 Predictions，卡上的分类词是场所自己的："Economics"、"Fed Rates"、"IPO"）。**All** 是一张表，每一行都在里面，事件也是一行（问题、倒计时、领头那个结果的 ¢）；别的 tab 里事件是卡（Yes / No 的价格用 ¢，倒计时每秒走），其余是表。每个列表上面可以排：Most traded · Biggest moves · Closing soonest（有会收盘的东西时才有）。看得见的行和卡、在接上的场所的，每 5 秒问一次价。Perps 里没有 pre-IPO 永续：它们只在 Pre-IPO。
- **每一行**：★ · Market · Where · Price · 24h · Volume，和**一个**按钮：能下单的 "Trade"（打开 Trade 的票，种类跟着这一行），只有公开行情的 "Connect to trade"，都不行的 "Can't trade here · why"（抽屉里说全）。"Hand to agent" 在抽屉里。
- 列表底下**一行**折起来的 "Why these, and what's not shown ⓘ"：展开是每个源怎么选的（`notes`）、没答或不服务这里的场所（它们自己的话）、只读服务的那一句；折着还是开着，按你上次留的样子。
- **Predictions**：精选的几个最热的，不是三家的全部赌局。Kalshi 按一张短名单里的 10 个 series（Fed decision、CPI、CPI YoY、GDP、jobs、bitcoin、S&P 500、Nasdaq-100、2028 Dem nominee、Trump approval，在 `live/categories.ts`）各出最忙事件里最忙的一个市场；Polymarket 按 24 小时成交额取前 20 个事件，去掉体育、电竞、天气、娱乐、名人、"will X say" 这类词下的和一小时以内的 "Up or Down"，留 10 个；Polymarket US（另一家交易所，不是 polymarket.com）按政治、金融、加密、宏观、地缘、科技六个分类各读最热的，轮流排（它的列表不给成交额，所以不写成交额）；三家轮流各出最忙的，最多 12 张卡，Closing soonest 也只排这几张。IPO 的问题另读：Kalshi 的两个 IPO series（KXIPOANTHROPIC、KXIPOOPENAI）各出最忙的市场，Polymarket 按它的 IPO 标签读 5 个、留 3 个，不管成交量都排在那 12 张旁边。这条排除规则对你自己连上的场所一样生效：连着 Kalshi 的 key，它列的体育事件也不进默认列表（搜索能找到，持仓照常在 Positions 里）。搜索不受这个限制：搜的是每个场所读进来的每一个市场。列表底下的 `notes` 写明每个源是怎么选的（"Kalshi: the busiest market in each of 10 series — …"、"Kalshi: and Anthropic IPO, OpenAI IPO — the busiest market of each."、"Polymarket: its 10 busiest events by 24-hour volume, without sports, esports, weather, entertainment, awards and mentions."、"Polymarket: and its 3 busiest IPO questions (its tag IPO)."、"Polymarket US: the most traded open markets of politics, finance, crypto, macro, geopolitics and technology, in turn (its lists give no volume figure)."、"Predictions: at most 12 rows, each venue's busiest in turn, without sports, weather and entertainment; a search reaches everything the venues' listings loaded."、"Predictions: and the IPO questions at Kalshi and Polymarket, beside the busiest few."）。收盘了的卡用场所自己的话（Kalshi 过了 `close_time` 的腿算关闭；场所没话就是 "the market is closed now"）；Polymarket 过了 Gamma 估的结束日还在交易的写 "Past its end date · still trading"。一次公开行情读多少：Kalshi 每个 series 15 KB 到 600 KB（bitcoin 的最大），Polymarket 一次约 2.9 MB，Polymarket US 六个分类各 13–32 KB，加交易所的公开 ticker 和 Stock Token 清单；答案留 90 秒（Stock Token 清单 10 分钟），页面每几秒问一次也不会每次去场所。
- **Pre-IPO**：一家还没上市的公司的估值上的永续，是合约，不是股份：一份合约约等于公司估值的十亿分之一，价格 2,080 就是约 $2.08 万亿的隐含估值。九个公开源不带钥匙读：OKX、Gate、Kraken Futures、Deribit、KuCoin Futures、MEXC、Binance、Bybit、Hyperliquid HIP-3（不服务你的地方，那几家用它们的原话写在列表底下），每家按它自己记录上的标记认（[docs/account.md](docs/account.md) 的「Pre-IPO」列了每家的字段）。每家公司一行，Price 一栏先写隐含估值（标 "implied"），下面一行小字是合约价；抽屉的 Across venues 里每家写它自己的合约价和单位：各家都是 $1 对 $10 亿，只有 OKX 的 ANTHROPIC、OPENAI 两个合约从 2026-06-30 起是 $1 对 $100 亿，所以 OKX 那条的合约价只有别家的十分之一，隐含估值一样；Oura 的合约各家都是一份一股，按它的股数算估值。Anthropic 和 OpenAI 自己说过没经它们同意的转让无效，它们的原话跟着它们的行、抽屉和票。各家都不对美国人开放，谁能交易各家在你接上钥匙时自己说；各家都承诺公布股数以后按每股重新定价、上市那天转成股票永续。要交易，接上这几家之一的钥匙（"Connect to trade"），它的 pre-IPO 永续就出现在同一行里，下单走 Trade 的 Pre-IPO 一面（第 5b 条）。一家公司的抽屉里还有 "IPO markets"：名字里带这家公司的预测市场（Kalshi 的 Anthropic IPO、OpenAI IPO，Polymarket 的 IPO 问题），Yes / No 打开 Predictions 的票。没接的场所的 pre-IPO 除了 Hyperliquid HIP-3 的，还没有 K 线。没做的（PreStocks、Lighter、Aster、Forge 和 EquityZen 这类没有接口的二级市场、已经上市的 SpaceX）和为什么，见 [docs/account.md](docs/account.md) 的「Pre-IPO」。
- **★**：关注一个市场，是一次签名（`setWatch`，最多 50 个）；agent 读得到你关注什么（第 8b 条）。"Watching" tab 是你关注的全部，★ 悬停写 "Watching since <日期>"。
- 点一行打开**那一个抽屉**（Portfolio 的资产行打开的也是它）：价格（pre-IPO 是隐含估值）、24h（只说一次）、买卖价、成交量；永续的资金费率和杠杆；事件的倒计时和每个结果（各有 "Buy Yes" 这样的按钮）；代币化股票和 pre-IPO 的 Issuer 一栏；"Buy" / "Sell" / "Hand to agent" / ★。下面几段：K 线（接上的场所用它自己的，没接的用公开数据，5m / 1h / 1d）· Across venues（每个场所的价格，能下的有 "Trade"，只有公开行情的有 "Connect to trade"）· IPO markets（只在 pre-IPO 公司里）· You hold（你在各场所持有多少、持仓和 "Close…"、挂单和 "Cancel"、平均成本）· Agents on it（agent 在这里的卡和 "Review"、它们的单、你的意图）· On the statement（流水里相关的最近八行，"Open the Statement →"）。

agent 读同样的东西：`portfolio_explore {tab, q, sort, limit}`（`tab` 是 all · crypto · stocks · rwas · perps · preipo · predictions；pre-IPO 的行带 `implied`）、`portfolio_candles {venue, symbol, interval}`。

## 3 · 让一个 agent 进来，给它交易额度

agent 先敲门：

```bash
seat whoami
```

```
seat "example-seat" · key 0xec4c4c61959f9f09b12683ea8077d10b223816c1
401 ✗ E_ACCOUNT_UNKNOWN_SIGNER · this key is not authorised on the account: the owner lets it in under Agents
```

MCP 席位第一次被拒时会以它客户端的名字敲一次门（`agentAsk {kind: "letIn"}`），所以这一行带着名字。rail 上 "Agents" 旁边多一个数，Portfolio 的 Waiting for you 里也有它。打开 Agents 弹层（rail 上的 "Agents"），那一行写着 "asked to be let in"。点 "Let in…"，钥匙地址进了下面的表单。填名字，在 "May trade at" 里勾上它可以下单的账户，填 Per order（每单最多值多少）和 Budget（一共能下多少单的钱），选期限，点 "Save"。要它也能在你的账户之间挪钱，再勾 "and move money between my accounts"。每一样是一个签名：放钥匙进来、交易额度、（勾了的话）挪钱额度。

```
trading limit: every venue on the account now · up to $25 an order · $100 of orders in all (a close that sells a holding counts like an order; a derivative position closed reduce-only does not) · until Mon 12 Oct
```

- 不填 Budget 只放钥匙进来：没有额度，它什么都做不了。
- 改额度：那一行 "Change limit"，表单换成这个 agent，填新的数存下，新的替换旧的。去掉 "move money" 的勾，挪钱额度就收回。
- 每单上限、总额、到期，三样都算。拆成许多小单也过不了总额。等批的卡占着它那份额度；没成交就撤掉的单，那份额度退回来。
- 表单里的**窗口**（`windowHours`）在交易额度上是真的：每个场所每个窗口只放一单（改一张已挂的单不算第二单），超了是 `E_MANDATE_RATE`："an order was placed at "okx" 12 min ago; the trading limit allows one order every 24 h at each venue"。
- 额度摘要（Agents 列表、Statement）写全它算什么："trading limit: okx · up to $25 an order · $100 of orders in all (a close that sells a holding counts like an order; a derivative position closed reduce-only does not) · one order every 24 h at each venue · until Mon 12 Oct · for intent-0003"——窗口那段只在填了窗口时有，最后一段只在额度是随一个意图签的时候有（第 8b 条）。
- 全勾上等于「所有账户」，指签字那一刻接上的账户。之后接上的不算，要再存一次点它的名。
- 交易额度和挪钱额度是两样：有交易额度的 agent 不能把钱挪出场所，有挪钱额度的不能下单。
- **付钱给别人**是第三样额度：表单里 "Payments from an agent wallet"，"May pay" 填可以付的域名（逗号隔开），或勾 "any payee"；Per payment、Budget 是它自己的。钱从 agent 钱包出（第 7b 条）。
- **"Everything"**：一键勾上所有能交易的账户、账户之间挪钱、任何收款方。金额还是你填，每一样还是一次签名。
- **Earn 额度**是第四样（`approveSpend` 的 `earn` 范围）：点名场所或一个场所的一个产品，从不是「所有账户」。从 Earn 弹层的 "Hand to agent" 交一件 earn 的事时附上（第 7c 条），或者回应 agent 要额度的请求时给；Agents 弹层里列着，"End earn limit" 只收回这一份。
- **每个 agent 每一样只有一份**：新签的替换旧的（Hand to agent 附的额度也一样，签之前页面会说）。
- agent 请求更大的额度（`portfolio_ask {kind: "limit"}`）时，Waiting for you 里那条请求的 "Grant…" 打开一张 "Give a limit"：从它现在那份额度和它问到的场所勾起，从不自己扩到所有账户（它问的场所做不了这件事时什么都不多勾，并写明）；签了，那条请求自己关掉。

**agent 的钥匙是它自己的**：席位第一次运行时在 `~/.buyer-agent-demo/seats/<名字>.json` 生成一把，权限 600，以后一直用这把。不再从名字推出来，所以知道名字的人拿不到它（`PORTFOLIO_SEAT_KEYS=sim` 才回到从名字推，只给测试和演示用）。MCP 席位同理（`PORTFOLIO_AGENT` 定名字），工具 `portfolio_account` 返回它的地址、有没有被授权、额度还剩多少。

会被拒：没点名 `E_MANDATE_RECIPIENT` · 超每单 `E_MANDATE_PER_ORDER_CAP` · 超总额 `E_MANDATE_BUDGET` · 窗口内的第二单 `E_MANDATE_RATE` · 到期 `E_MANDATE_EXPIRED` · 没有额度 `E_MANDATE_NONE` · 额度写了一个不存在、已过期或不是给这个 agent 的意图 `E_ACCOUNT_BAD_ACTION`。

## 4 · 选模式：Guard 还是 Beast

Account 的头上（rail 最下面的 Account 打开的三页）：Guard | Beast 两个按钮，旁边的 ⓘ 打开 **Mode 弹层**；三页切换那一行的右边一句说这一档的意思（Guard："What agents ask for waits for you on a card."；Beast："Inside their limits, agents act at once."）。rail 最下面的 Account 按钮上也写着现在是哪一档。Settings 里没有模式。

| 模式 | agent 下单时 | 怎么切 |
|---|---|---|
| Guard（真实账户的默认） | 每一单都变成一张卡，卡上是数量、价格和价值，你签了才下 | 点一下，不用签名（`POST /api/mode {mode: "guard"}`） |
| Beast | 额度内直接下，不再问你；超出额度就拒 | 点一下，是 owner 的一次签名（`setPolicy mode open`） |

线上的值没改：`/api/account`、`/api/account/agents` 和 MCP 里 `mode` 仍是 `guard`（Guard）或 `open`（Beast），签过的行和旧账本都按它读。

**Mode 弹层**把两档的差别摆成一张表。最上面还是那两个按钮和一句 "Guard: what agents ask for waits for you on a card. Beast: inside the limits you signed, it goes at once. Guard is one click; Beast is signed."；下面三列，现在这一档那一列高亮、列头带 "Now"。每一行来自服务器（`GET /api/account` 的 `modeRules.rows`，`account/mode-rules.ts` 照每扇门自己的代码写），页面不自己写，所以不会和门对不上：

| An agent, inside its limit | Guard | Beast |
|---|---|---|
| Place or enlarge an order | Waits on a card | At once |
| Close a spot, stock or contract holding | Waits on a card | At once; counts against its trading limit, like a sell |
| Close a derivative position | Waits on a card | At once inside its per-order line; a card above it |
| Change leverage with a position open | Waits on a card | At once if the position is inside its per-order line; else a card |
| Move money between your accounts | Waits on a card | At once |
| Put money into earn | Waits on a card | At once |
| Take money out of earn | Waits on a card | At once inside its per-supply line; a card above it |
| Pay from its agent wallet | Waits on a card | At once for a payee it paid before; the first payment to a payee still waits on a card, unless its limit says any payee |
| Cancel its own order | At once, never a card | At once, never a card |
| Set leverage with no position open | At once | At once |

表下面一行是两档都一样的："In both modes: anything over a limit is refused · your own actions are yours to sign, up to $100.00 each · a card nobody answers in 30 minutes expires."。$100.00 是服务的 `--live-cap`，30 是 `modeRules.cardMinutes`，和卡过期用的是同一个常数（第 8 条）。agent 读同一张表：`portfolio_account` 的 `mode` 和 `modeRules`（第 11 条）。

两档都一样的：每单不超过 `--live-cap`；市价单带着最差价格去场所（买最多比卖一高 2%，卖最少比买一低 2%）；撤单从不出卡；场所自己的规矩照旧。agent 挪钱也是这两档。agent 平仓和改杠杆也看模式：卖掉现货持有的平仓就是一张卖单，按每单、总额、窗口算进交易额度，Guard 出卡，超额度拒绝；只减仓的衍生品平仓不算预算，但 Guard 仍出卡，Beast 在它每单额度内直接平、超了出卡；agent 改一个有持仓（谁的都算）的市场的杠杆，Guard 出卡，Beast 持仓在它每单额度内直接改、超了出卡，没有持仓的市场直接改。Statement 里写着每一笔是 "approved by you" 还是 "inside its limit"。

## 5 · 自己下单：Trade 屏

rail 上点 "Trade"（或按 `t`、Markets 一行的 "Trade"、市场抽屉里的 "Buy" / "Sell"、Portfolio 的快捷操作 "Trade"、Account 抽屉里的 "Trade…"）。Trade 只做一件事：在一个市场里建一个仓位。手里的钱的事都在 Portfolio：Move 和 Receive 是快捷操作（第 7、2b 条），Earn 从 Cash ready（第 7c 条），Sell many 从 Assets（第 5b 条）。

屏顶一排是**市场的种类**：Crypto · Stocks · RWAs · Perps · Pre-IPO · Predictions，和 Markets 的 tab 同样的词、同样的顺序。一种只在有东西时出现：你接上的场所交易这一种，或者公开行情里有这一种（那些行写 "Connect to trade"）。地址栏是 `#/trade?kind=perps` 这样，再带 `venue`、`symbol`、`side`、`outcome` 就直接打开那张票。种类下面是这一种的**选市场**：一个只搜这一种的搜索框，下面三组：**You hold**（这一种你持有的；永续和 Pre-IPO 是你的持仓）、**Recent**（这个浏览器里最近挑过的，每种最多 12 个）、**Most traded**（这一种最忙的 6 个；Pre-IPO 每家公司一行，先写隐含估值）。价格在原地跳。点一个，右边就是它的票。

下单票在右边那块面板里，刷新不会把它重画掉；一张票，六面，头上是这一面的标签。**先选市场，再选在哪**：

1. 在票的 Market 里打几个字母（BTC、AAPL、FED）：搜的是这一种在 Markets 那张表里的行，接上没接的场所都在。选一个，下面马上是它的价格；挑到另一种的市场，票和屏顶的种类跟着它换。
2. **Where**：交易这个东西的、你接上的场所，按这一单在那里会成交的价格排（买看卖一，卖看买一；同一个东西在别处叫 XBT、WBTC、cbBTC 也算），最好的标 "Best"、默认选它，可以换。只在 Crypto、Stocks、RWAs 三面比价，每面只列自己种类的场所（一只股票的 Where 里不会混进同名的代币）；Pre-IPO 每家写它自己的隐含估值和单位。不能在那里下的写场所的话和怎么修；没接的写 "Public"，只有你哪个账户都不交易它时才给 "Connect to trade"，点了接上以后票自动换到它。场所的地区规矩照它的原话写。
3. Where 下面是**这一面的说明块**：这种市场下单之前该知道的（第 5b 条）。
4. Buy / Sell（Perps、Pre-IPO 是 Long / Short；Predictions 先选结果），数量按美元（Dollars）或按单位（币、股、合约；只做整股的写 "Shares (whole)"）。Crypto 的买单有得选时多一行 **Pay with**（第 5b 条）。Order 里只有这个市场接受的：Market、Limit、Stop（价格到了 Stop price 按市价成交）、Stop limit（到了按 Limit price 挂限价）。永续多一行 Leverage（第 5b 条）。**Advanced ▸** 折着，里面是这个市场接受的 Time in force（Until canceled / Fill now, rest canceled / All now or nothing / Today only）、Post-only（只做 maker）、Reduce-only（只减仓）；折着时摘要一行写已经设了什么，没设就写这个场所对这种单的规矩（例如 Kalshi 的市价单："A market order here fills now or is cancelled (ioc/fok)"）；一样都不接受的市场没有 Advanced。
5. 预览：确切数量（按美元下的单向下取整到这个市场的步长）、按什么价格估的值、市价买单最多花多少。"What you sign" 展开是要签的每个字段（预测市场的限价旁写成 "limit 62¢ ($0.62 a contract)"）；十分钟的有效期在倒数，到了自动重新准备。
6. 点 "Sign and place"。从钱包换币的，钱包会请你确认（要先授权的，先确认授权、等它上链，再确认换币）。不想自己下："Hand to agent instead" 把这张票的种类、场所、市场、方向、结果和美元数带进交给 agent 的那张表（第 8b 条）。

没签完的票存在这个浏览器里一天：刷新以后，场所还接着、还能交易、市场还在，就原样放回来（不抢焦点），否则丢掉。

Trade 屏下面是 **Under way**，按 Lens 筛，一张表给所有种类（Order · Status · 动作）：

- 挂着的单每十秒最多问一次场所，有 "Cancel"（撤 agent 的单先问你一次："Cancel an agent's order"；撤自己的一下就撤），场所能改单的（Alpaca、Kalshi、一部分交易所）还有 "Change"：改数量、限价、触发价，账户按现在的价格重新估值，签了就改；改成比原来更值钱的，算一笔差额的新单（agent 也一样：Beast 下额度内直接改，Guard 下出卡；你把 agent 的单改大到超过它的额度，账户拒绝并说 "give it a bigger limit under Agents, or grow the order by less"）。钱包要发的单是 "Send from wallet…"。
- 在途的钱，和放进 / 取出 earn 还没完的。
- agent 等你批的卡是一行 "Waiting for you"，唯一的按钮是 **"Review"**：去 Portfolio，那张卡滚到眼前、描一圈边（第 8 条）。批只在那一处。
- 两单以上有 "Cancel all N"（先确认，每单一次签名）。成交、撤掉之后它落进 Statement。

Trade 屏没有 Positions 和 Recent fills：持仓在 Portfolio › Positions 和市场抽屉里，成交在 Statement。**Close** 在哪里点（Portfolio › Positions、市场抽屉的 You hold）都是同一个对话框：全部或一部分，写明现在值多少、最差成交价；超过服务的单笔上限时，账户自己的拒绝写在 "Sign and close"（卖掉持有的是 "Sign and sell"）上方，按钮不让按，下面给一个按市场步长取整、刚好在上限以内的数量。你点的 Close 是你自己签名，直接执行。agent 平仓：卖掉现货持有（币、股票、事件合约）的平仓就是一张卖单，按每单、总额、窗口算进它的交易额度，超了拒绝并说 "A close that sells a holding is a sell order, and counts against the trading limit like one"，Guard 出卡；只减仓的衍生品平仓不占预算（它只会减少持有），但持仓可能是你自己的，所以仍看模式：Guard 出卡等你批，Beast 在它的每单上限以内直接平，超过也出卡。场所有自己的平仓接口就用它，没有就发一张 reduce-only 市价单；市场不接受 reduce-only 的，不发（免得反向开仓）。

**Statement**（顶栏的时钟图标；Portfolio 的 Agents at work 也有一个 "Statement"）是银行流水的样子：一行一笔交易（成交、提现、划转、跨链、换币、Earn），日期、说明、账户、金额（买入 −、卖出 +，挪钱和 earn 照原数）、状态，下一行小字是谁做的、手续费、场所的编号或交易哈希。还没完的单不在这里，在 Trade 的 Under way。四个下拉按月份、账户、类型（有 earn 时多一个 Earn）、Who（你，或哪个 agent，按钥匙认）筛；最后一行是这一屏的合计（买了多少、卖了多少、挪了多少、into earn / out of earn、手续费；被拒的不算）。"Download CSV" 下载这一屏（带 agent 一列），"Print" 只打印流水。流水从账本文件读，重启以后还在。

几条规矩：只交易美元计价的市场（USD、USDC、USDT、USDG 这类）；每单不超过 `--live-cap`；签名十分钟内有效；下单前再问一次价格，买单涨过你签的价值、市价卖单跌了 2% 以上就不下；撤单要等场所说撤掉了才算，期间成交的照算。

会被拒：服务是只读的 `E_WALLET_LIVE_WRITES_OFF` · 超上限 `E_ACCOUNT_LIMIT`（平仓也一样，签之前就写在对话框里）· 不到最小单、不在步长上 `E_VENUE_ORDER_INVALID` · 收盘了 `E_VENUE_MARKET_CLOSED` · 没有美元价格 `E_ACCOUNT_UNPRICED` · 价格动了 `E_ACCOUNT_REQUOTE` · 签名过期 `E_ACCOUNT_EXPIRED` · 钥匙不许交易 `E_VENUE_PERMISSION` · 余额不够 `E_VENUE_INSUFFICIENT`。

**先小后大**：第一次用 `--live-cap 5` 下一单几美元的；Alpaca 先用 Paper 账户，Kalshi 先用 demo。

## 5b · 六面各说什么：预测、永续、Pre-IPO、股票、代币化股票，Pay with 和 Sell many

每一面是同一张票，签的还是同样那几种动作；不同的是 Where 下面那一块说明，和几行只在这一面有的字段：

- **Crypto**：买一卖一和 24h；从钱包换的，路线、滑点和 gas 用钱包那边的话；在交易所不多说。**Pay with**（只在买单、有得选时出现）：先是这个币在这个场所对的几种美元（换一种美元就是换到那个市场），再是你在那里持有的别的币。挑一个币是**两步、两次签名**：先把它卖成两个市场共有的那种美元（钱包的话在同一条链上），等它成交（每两秒问一次，最多一分半钟），按实际到手的钱（扣掉手续费）准备买的那一腿，给你看过以后第二次签名；按钮先是 "Sign the sale (1 of 2)"，再是 "Sign the buy (2 of 2)"。一分半钟里没成交，买就等着：卖单在 Under way 里，成交以后再买一次。一种美元换另一种美元不是交易：Move 的 "Swap stablecoins"（第 7 条）。
- **Stocks**：第一行是交易时段，场所报了才有（市场的 `session`：Alpaca 按它自己的时钟 `/v2/clock`；Robinhood 的单子都送常规时段，按市场日历，节假日算休市）："Open now · closes 16:00 New York"，或 "Closed · opens Wed 7 Oct, 09:30 New York"；后面是场所的原话（Alpaca 收盘时写它把单子留到开盘、为什么这时不下市价单：会按开盘价成交，可能离现在很远；限价、止损单等开盘）。场所没报时段就只有原话，不写 Open / Closed；这只股票此刻根本不收单（停牌、不可交易）时写 "Closed now." 和场所的话。只做整股的场所（Robinhood）写 "Whole shares only here."，单位是 "Shares (whole)"；同一只股票也有代币（RWAs 里有同名的行）时一行 "Also as a token: … → RWAs"。Where 里只有券商，不混进同名的代币。
- **Predictions**：先选结果（Yes / No，或场所列的几个），价格用 ¢，也就是市场认为的概率，再 Buy / Sell。说明块写这一单到期最多赔多少："N contracts pay $N if Yes · cost ≈ $X · the market gives it 62%"（还没填数量时说一份多少 ¢，每份到期兑 $1 或 $0）、离收盘多久（每秒走）和纽约时间；只卖得了持有的场所写 "Sells only what you hold · N held"。场所只让你那里平仓的（Polymarket 对美国），卖持有的照常，买会被它的原话拒掉。限价按 ¢ 填（62 就是 $0.62；到小数点后一位，62.5¢；0 到 100 以外的不是价格，票上会说），"What you sign" 里写成 "limit 62¢ ($0.62 a contract)"；页面上事件的价格到处都是一位小数的 ¢。
- **Perps**：Long / Short，标记价、资金费率和下次支付的时间、"up to Nx here"，填了数量和杠杆时 "Margin ≈ $X for $Y at Nx."，你在这个市场的持仓（方向、倍数、强平价、开仓价）。Leverage 一行一直在票上（它是永续的主控件，不折进 Advanced）：场所能从这里设的，填倍数（场所说了上限就提示 "up to 50"，没说就是 "a whole number"），Margin 只在这个市场列出保证金模式时出现（市场的 `marginModes`：OKX 只有 Cross，Binance 有 Cross / Isolated，Bybit 统一账户是整个账户的、不列，经典账户两种；mm 的 Hyperliquid 永续按 Hyperliquid 自己的来，不画），点 "Set leverage…"，是下单之前单独的一次签名（`liveLeverage`，和动钱的指令一样只在签名后十分钟内有效）；场所不让从这里设的，这一行写 "As set at the venue" 和你持仓的倍数。agent 设杠杆不超过你在 Settings 里签的倍数（默认 1 倍，即不让加杠杆）。Hyperliquid 的永续有两条路：Hyperliquid 的 API 钱包连接（第 2 条）直接下；或经 MetaMask Agent Wallet 的 `mm perps`（市场写 `BTC-PERP`，写操作还要 `PORTFOLIO_MM_WRITES=1`）。两条路每一单、每次平仓、每次改杠杆之前，都先查这台机器此刻在哪，按 Hyperliquid 使用条款 §1.6（美国、安大略、受制裁地区不服务）判：位置来自 Polymarket 的公开位置查询（mm 那条路先用 `mm predict geoblock`），它不答时用 Cloudflare 的 trace；一个只关一部分的国家（加拿大、乌克兰）不知道省份时，再问一次 ipapi.co。在里面、或者哪处都说不出在哪，什么都不发。
- **Pre-IPO**：永续那一套（Long / Short、Leverage 一行、资金费率、保证金、持仓），说明块前面多几句：第一行 "Implied valuation ≈ $2.1T" 和一份合约多少钱；单位那句话（多数场所 $1 对 $10 亿，OKX 的 ANTHROPIC、OPENAI 两个合约 $1 对 $100 亿，Oura 一份一股）；"Becomes a stock perpetual at the IPO; the venue rebases when the share count is public."；公司自己的话（Anthropic、OpenAI）；最后一句 "This is a contract on a valuation, not a share."。Where 每家写它自己的隐含估值和单位，不比价（单位不同）。你还没接上任何一家时没有市场可挑，这一块从 Markets 的那一行说，Where 只有 "Public" 的行和 "Connect to trade"。谁能交易由场所自己说：它的拒绝就是答复。
- **RWAs**（代币化股票和基金）：从接上的浏览器钱包买卖，是钱包的两笔交易（授权、swap）。Robinhood 的 Stock Tokens 在 Robinhood Chain 上对 USDG（`NVDA/USDG@Robinhood Chain`），Ondo Stocks（`NVDAon`）和 xStocks（`NVDAx`）在以太坊等链上对 USDC。每一单之前账户先问发行方：Robinhood 的清单、Ondo 链上的接受与暂停开关、xStocks 的公开接口。Markets 的行下面一行小字是发行方，票在 Where 下面的发行方框里把发行方的资格原话说一次（这些发行方都排除美国人和别的一些地方，账户不知道你住在哪，判断是你的）；说明块还写付的是什么（"Paid in USDC"，Robinhood Chain 上是 USDG），钱包在几条链上都有这个代币时一个 Chain 选择；同一只股票在券商有时一行 "Also as shares: … → Stocks"。发行方关了或限制的，原话写在签名按钮上方，按钮不让按。OUSG、BUIDL 只显示：它们只在发行方批准过的钱包之间转，swap 送不到（`E_VENUE_TRANSFER_RESTRICTED`）。钱包还不认识 Robinhood Chain 时，页面提出替你加上这条链（`0x1237`，RPC `rpc.mainnet.chain.robinhood.com`，区块浏览器 `robinhoodchain.blockscout.com`——Robinhood 自己公布的那个）。往 Robinhood Chain 打 USDG、从那里桥回来，都用 "Move…" → "Across chains"。
- **Sell many**：在 Portfolio › Assets 段头的 "Sell many…"，不在 Trade 里。列出你持有的、不是美元的东西（`/api/account/sellable`；此刻卖不了的不列，写一行有几个），最多勾 10 个，各填卖多少；"Review" 先列出每一条要签什么，再 "Sign and sell N" 一条一条签（永续是平仓），每条有自己的结果，一条被拒不影响下一条；签的时候弹层不重画。没有新的签名类型：每条照样过上限、额度和模式。
- **Earn** 见第 7c 条，**Move**（含 "Swap stablecoins"）见第 7 条：都在 Portfolio。

会被拒：发行方暂停了 `E_VENUE_MARKET_CLOSED` · 发行方不认这个代币、不在这条链上发、清单没应答，或者 mm 和账户自己的来源都说不出这台机器在哪 `E_VENUE_REJECTED` · 只在白名单钱包之间转 `E_VENUE_TRANSFER_RESTRICTED` · 场所不服务这个地区（只能平仓的地方买入也是）`E_VENUE_GEOBLOCKED` · MetaMask 自己的开关没开 `E_WALLET_LIVE_WRITES_OFF`。

## 6 · agent 下单

```bash
seat markets okx BTC
seat order okx buy BTC/USDT '$5'
seat order okx sell BTC/USDT 0.0001 70000
seat cancel okx ord-0001
```

MCP 里是 `portfolio_live_markets {venue, query | symbol}`、`portfolio_live_order {venue, symbol, side, orderType, qty | usd, limitPrice, stopPrice, tif, postOnly, reduceOnly}`、`portfolio_live_cancel {venue, order}`、`portfolio_live_amend {venue, order, qty, limitPrice, stopPrice}`、`portfolio_live_positions {venue?}`（不带 venue 是所有能列持仓的场所，读不到的在 `missing`）、`portfolio_live_close {venue, symbol, qty}`、`portfolio_live_leverage {venue, symbol, leverage, marginMode}`。等结果用 `portfolio_wait {card | order | payment}`：变了马上回，最多等 55 秒，不用自己反复查；已经到终态的（卡答了、单完了、钱到了 / 失败 / 搁浅 `stranded`）直接回 `done: true`。流水用 `portfolio_statement {mine}`（按这把钥匙认，你给它起什么名字都一样；账本行还没记钥匙的那段老记录退回按席位自己的名字认）。

下单之前先问一句：`portfolio_live_preview {order}`（或 `{move}`）按账户真会用的价格、步长、最多值多少把这一单算出来，告诉 agent 额度还剩多少（`leftUsd`、`perOrderUsd`），以及现在下会是什么：`card`（Guard）、`at once`（Beast，额度内）还是 `refused`（没被放进来、没额度、额度没点这家、超每单、超剩余、超服务的上限）。它什么都不下。一次卖很多样用 `portfolio_live_batch {legs}`：最多 10 腿，每腿就是一个 `portfolio_live_order`，各签各的、各判各的、各答各的，一腿被拒不影响下一腿，不合并、不拆分。

agent 设杠杆有一条你签的上限：Settings 弹层里 "Their leverage"，默认 1 倍（即不让加杠杆），改大是一次签名。那个市场有持仓时（谁的都算）改杠杆和下单一样看模式：Guard 出卡（卡上写着 "a position of 0.5 ETH is open there"），Beast 持仓在它每单额度内直接改、超了出卡；没有持仓的市场直接改。杠杆指令和动钱的一样只在签名后十分钟内有效。下单：Guard 下回答是 `202` 和一张卡；你签了才下，MCP 的 `portfolio_approval` 告诉 agent 结果。Beast 下额度内回答直接是 `200` 和订单：

```
202 ▣ card-0001 waits for the owner · Example seat asks to buy 0.00008 BTC at OKX · market · about $5.00
200 ✓ ord-0001 · buy 0.00008 BTC/USDT at OKX · filled · filled at 62500
```

agent 只能撤自己下的单；你能撤任何单（撤单从不出卡；你撤 agent 的单时页面先问一次）。重启后场所没接回来的单，账户不再跟（Statement 里 "not followed since a restart"）：agent 或你撤它只是把它那份额度放回来，单要在场所那边撤，账户既撤不了也看不到成交。在模拟账户里才有的指令（`agentOrder`、`agentExecute`、`agentSendAsset`、`agentSwap`）在这里回 `E_ACCOUNT_BAD_ACTION · this account holds real accounts only`；`agentPay` 只在服务能从 agent 钱包付真钱时收（第 7b 条）。

## 7 · 动钱

Portfolio 的快捷操作 "Move"（不止一个账户能动钱时先问从哪个），或 Account 抽屉（Accounts 那一行的 "Details"）里的 "Move…"。"What" 里只有这个账户做得了的：Withdraw to another account of yours（提到你自己的地方）、Between its own ledgers（账本之间划转）、Swap stablecoins（稳定币互换；下单票的 Pay with 不做这件事，它在这里）、Send from this wallet（从钱包发）、Across chains（跨链，下面）。预览里是**账户替你向目的地要来的地址**、手续费上限、网络，点 "Sign and send"。币、网络、桥的目的链三个下拉来自账户公布的 `dollars` / `networks` / `bridgeChains`（账户认的每一种美元稳定币、它们所在的链、桥能到的链），不是页面写死的表；往一个 agent 钱包挪钱，网络默认是那个钱包有钱的那条链。Statement 里有这一笔，场所或链说到了才算到账。要知道往哪打钱，用 Portfolio 的 "Receive"（第 2b 条）。

agent 请求挪钱（要有挪钱额度）：

```bash
seat move withdraw okx wallet 5 USDC Arbitrum
seat move transfer okx okx 5 USDT funding trading
```

MCP 里是 `portfolio_live_move`。规矩：钱只去交易所自己的充值地址或签过那句话的钱包；第一次提到新地址，多数交易所要你先在它那边加白名单；钥匙不许提币的交易所，从它那里提不了，但能收钱；MetaMask Agent Wallet 发钱还要它自己的开关 `PORTFOLIO_MM_WRITES=1`。

**跨链**：钱包的 Details 抽屉 "Move…" → "Across chains"。选落到哪里（这个钱包在另一条链上、你另一个钱包、你交易所在那条链上的充值地址）、从哪条链到哪条链、发什么到什么、多少。预览里是账户签的那条路线（最便宜的）、最少到账多少、大约多久、钱包要付的网络费，下面一行是其他路线。签了以后钱包先确认授权（要的话），再确认转账；Statement 里这一笔是 "On the way"，桥送到了才变成 "Done"。交易所提币时点 "Fees on every network"，每条链的手续费并排出来，点一个就换成那条链。Robinhood Chain 上的美元是 USDG：桥进去、桥出来都是 USDG（走 Across）；在那条链上不做直接发送或提币，只过桥。

```bash
seat move bridge wallet wallet 25 USDC Arbitrum Base   # agent 请求（MCP 的 portfolio_live_move 带 toNetwork）
```

会被拒：目的地不是你的 `E_ACCOUNT_DESTINATION` · 地址或手续费变了 `E_ACCOUNT_REQUOTE` · 钥匙不许提币 `E_VENUE_PERMISSION` · 地址不在交易所白名单 `E_VENUE_WITHDRAW_WHITELIST` · 同一条链、只看的钱包、没有桥能送 `E_ACCOUNT_BAD_ACTION` / `E_VENUE_RAIL_CLOSED` · 钱包报来的哈希不是构造的那笔 `E_VENUE_REJECTED` · 来源不是接上的场所 `E_WALLET_ACCOUNT_UNKNOWN` · 场所不换这两种币，或这条链上账户不认识这个币 `E_VENUE_CURRENCY`。

**比价**：下单票的 Where 就是比价（第 5 条）：同一个东西在你每个接上的场所按这一单会成交的价格排，最好的在最上面。agent 用 `portfolio_live_compare {base, side, usd}`。

## 7b · agent 付钱给别人：agent 钱包

agent 付 API 调用、按次计费的服务，用的是一个 **agent 钱包**：账户在本机替它生成一个钱包（钥匙在 `~/.buyer-agent-demo/agent-wallets/<名字>.json`，600，agent 拿不到），你往里放一笔备用金，agent 在你签的付款额度内自己付。最坏情况损失的是这笔备用金。

1. **建**：Agents 弹层的 Agent wallets 里填 Name、选 For agent、Keep up to（打算放多少），点 "Make it"（一次签名）；agent 请求充值（`portfolio_ask {kind: "topup"}`）时，Waiting for you 里那条请求的 "Grant…"：它还没有钱包就打开建钱包的表，有了就打开充值。它出现在 Portfolio › Accounts 里，"Agent wallet · research"，余额从链上读（`/api/account` 的 `subAccounts[].balanceUsd` 就是这个数）。它没有 "Disconnect"：账户握着它的钥匙和钱，要收走用第 5 步的 "Take back…"。
2. **充值**："Top up…"，选从哪个账户出（交易所提币或钱包发），目的地就是这个 agent 钱包。或者直接往它的地址打 USDC（账户公布的 `networks` 里的任何一条链）。
3. **给额度**：Agents 弹层里 "Payments from an agent wallet"（第 3 条）。
4. **agent 付**：`portfolio_pay {url, maxAmount, from: "research", method?, body?}`。账户先问收款方，从它自己的回答里读价格、收款地址、哪条链；只付 Circle 在那条链上的 USDC。说得通的协议：x402 V2（`PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE`）、x402 V1（402 JSON / `X-PAYMENT`）、MPP charge（`WWW-Authenticate: Payment`，EVM 方法）。签的是一张一分钟内有效的 EIP-3009 授权，不用 gas。
   - Guard：每一笔都是一张卡，卡上写着付给谁、哪个地址、多少、哪条链、什么协议。
   - Beast：付过的收款方直接付；第一次付一个新域名还是卡（批了就钉住它的地址），除非你签的是 "any payee"。
   - 付没付成看链：USDC 合约自己记的授权用没用掉、收款方回执里那笔转账的发送方、收款方、金额对不对。收款方先给了数据没结算的，那笔钱先压着（`{paid: "not yet"}`），链上看到用掉了再记账，过期了就放回额度。
5. **取回**："Take back…"：从 agent 钱包发回你自己的交易所或钱包。这是一笔链上转账，agent 钱包自己付 gas，所以那条链上要有一点它的原生币（Base 上几分钱的 ETH 就够）；没有就拒，不签。

会被拒：没点这个域名 `E_MANDATE_RECIPIENT`（请求根本不发出去）· 要价超过 maxAmount `E_PAYEE_OVERCHARGE` · 收款地址和钉住的不一样 `E_PAYEE_CHANGED`（像攻击，告诉用户）· 不是 USDC、不是认识的链 `E_PAYEE_UNSUPPORTED` · 钱包里不够 `E_WALLET_INSUFFICIENT` · MPP session、AP2 在真钱上不付 `E_PAYEE_UNSUPPORTED` · 地址是本机或内网的 URL：不发。

## 7c · Earn：让闲着的钱生息

五家有接口：MetaMask Agent Wallet 的 DeFi 金库（经 `mm earn`）、OKX 的 Simple Earn Flexible、Kraken Earn、KuCoin Earn、Binance 的 Simple Earn Flexible（从现货账户放进、取回现货；Binance 的自动申购开关账户从不替你打开；开发者那台机器读不到 Binance，这一家照它的文档写、对着替身测过）。Portfolio 右边 Cash ready 的 "Earn…" 只在接上的场所里有这五家之一时出现，打开 Earn 弹层。接 OKX US、Binance.US 的不出现：OKX US 没公布 earn 接口，Binance.US 的质押接口还没接进来。

1. 点 "Earn…"，弹层顶上选 Put in 或 Take out。列表是场所此刻提供的产品（Take out 只列你在里面有钱的）：币、年化（APY 或 APR，区间的写上限）、取出要等几天（0 是马上）、最小额、取出落在哪（永远是钱来的那个场所）、你在里面有多少。放不进去的排在后面，写场所的理由（例如 mm 的金库锁仓不到 $1,000,000）。
2. 填数量（"Max" 填你在那里有的；Take out 还有 "All of it"，签进去的是 `"all"`，场所把里面的全部取出）。预览写这一笔值多少、上限多少。
3. "Sign and put in" / "Sign and take out"（`liveEarn`，签的是场所、产品、确切数量、最多值多少美元、落在哪、十分钟）。签完弹层原地重画，Assets 和净值跟着重读。

放进去以后，Portfolio › Assets 多一行 "earning 5.2% at OKX"，算在净值里，不算 Cash ready；那一行下面的 "Withdraw…" 打开同一个弹层的 Take out，产品已经选好。Statement 里是类型 Earn 的一行，合计里有 "into earn" / "out of earn"。Kraken 的放、取是异步的，它说做完了才变成 Done；重启时没做完的接着问，不重发。

每家自己的规矩照旧：OKX 只收资金账户里的钱、取出也回资金账户，放和取要钥匙的 Trade 权限；Kraken 要 Earn Funds 权限和它的 Intermediate 认证，全账户自动的策略（Kraken Rewards）不能分配；KuCoin 从交易账户放进、取回交易账户，读要 General 权限、放取要 Earn 权限，取出是 PENDING、KuCoin 交付了才算完，提前赎回要没收利息的账户不替你确认、把 KuCoin 报的数写进拒绝；mm 从钱包出、回钱包，在金库自己的链上，还要 MetaMask 自己的开关 `PORTFOLIO_MM_WRITES=1`。

**agent 做 earn**：

1. 你先给它一份 earn 额度：点名场所（`okx`）或一个场所的一个产品（`okx:savings:USDT`），每笔多少、一共多少、到什么时候。从 Earn 弹层的 "Hand to agent" 交一件 earn 的事时附上，或者回应它的请求。不能写「所有账户」。
2. agent 读 `portfolio_earn {venue?, asset?}`，再 `portfolio_live_earn {venue, kind: "supply" | "withdraw", product, asset, amount}`（取出可以写 `"all"`）。
3. Guard：每一次是一张卡（产品、年化、数量、值多少、落在哪），你签了才走。Beast：额度内的放入直接走；取出在每笔上限以内直接走，超了出卡。放入算额度，取出不算。

会被拒：没有 earn 额度 `E_MANDATE_NONE` · 额度没点这家或这个产品 `E_MANDATE_RECIPIENT` · 超每笔、超总额 `E_MANDATE_PER_ORDER_CAP` / `E_MANDATE_BUDGET` · earn 额度写了「所有账户」`E_ACCOUNT_BAD_ACTION` · 超 `--live-cap` `E_ACCOUNT_LIMIT` · 没有价格 `E_ACCOUNT_UNPRICED` · 场所自己的话（权限、等级、余额、地区、此刻收不收）`E_VENUE_*` · 只读服务或 MetaMask 的开关没开 `E_WALLET_LIVE_WRITES_OFF`。

## 8 · 批卡、拒卡

Portfolio 右边一栏最上面的 **Waiting for you**：卡按 agent 分组，每张写着它要做什么、值多少、几点前要答（"answer by 16:42"，一张卡只说一次）；Trade 屏的 Under way 和市场抽屉的 Agents on it 里，agent 的卡也是一行，按钮只有 "Review"：带你回到这里，那张卡滚到眼前、描一圈边（`#/portfolio?card=<id>`）。批只在这一处。rail 最下面 Account 旁边的数和浏览器标签页的标题带着等你的张数，比如 "(1) Account"。Lens 选一个 agent 就只看它的。

- 两个圆键（第七轮的）：✗ 是 Reject，蓝的 ✓ 是 Approve；悬停和读屏器都说它的字。
- "What it asks" 展开是你将要签的每个字段：市场、数量、价格、价值；挪钱的是目的地址和网络。
- "Approve all N"（同一个 agent 两张以上才有）：先确认一次（写明这个 agent 一共几张、一共多少钱），然后每张卡还是一次签名，和单独批一样；一张被拒就停在那里。
- 批准是 owner 的一次签名，写明卡号和这张卡将放行的内容的哈希。批了下的就是卡上那一单：同一个市场、同样的数量；价格动过了头就不下。agent 的额度、签名、模式也都重查一遍：卡还在等的时候你收回了额度，批了也不下。
- 卡 30 分钟过期（Mode 弹层和 `modeRules.cardMinutes` 说的就是这个数）：到点没人答，账户自己关掉它、放回它占的额度（"The card expired before it was answered; nothing moved"），之后再批是 `E_ACCOUNT_CARD_EXPIRED`。
- agent 批不了自己的卡（`E_ACCOUNT_OWNER_ONLY`）。

## 8b · 引导 agent：关注、意图、回报、请求

你可以告诉 agent 你想要什么，agent 可以回报、可以向你要东西。这些都是签了名的话，**没有一句授予任何权限**：agent 能做的仍然只是它的额度、你的卡和 `--live-cap`。它们不在动钱的指令里，额度一样都不读。

**你说**

- **关注**：Markets 里点 ★（`setWatch`）。最多 50 个，没接的场所的市场也能关注。
- **意图**：Portfolio 的快捷操作 "Hand to agent"、下单票的 "Hand to agent instead"（带着这张票的种类、场所、市场、方向、结果和美元数）、市场抽屉的 "Hand to agent"、Earn 弹层的 "Hand to agent"。在 Trade 屏上这张表占右边的面板，顶上是这一面的标签（只是页面上的，签的东西里没有它），"Do it myself instead" 回到票；别处是一个弹层。填给哪个 agent（或 "Every agent"）、在哪、什么市场、哪个方向、大约多少美元、你的话（最多 200 字）、到什么时候，点 "Sign and hand over"（`setIntent`）。美元只是引导，什么都不限。最多同时开 20 个，最长 180 天。
- **附一份额度**：同一张表里可以勾上，给这个 agent 一份交易额度（交 earn 的事时是 earn 额度），每单、总额、期限和意图一样长。它会**替换**这个 agent 现在那一份（每个 agent 每一样只有一份），表上写着现在那份是多少。话和额度是两段 "What you sign"、两次签名：先签话、拿到它的 id（`intent-0003`），再签带着这个 id 的额度（`approveSpend.intent`）；Agents 列表和额度摘要里写 " · for intent-0003"。
- 开着的意图列在 Portfolio 的 **Agents at work**，带每个 agent 最新的回报。"Change words" 改话（结束时间跟着它的额度不变）；"Withdraw" 收回：先确认，再签两样，话（`validUntil` 为 0）和随它给的额度（预算 0）。页面按额度上的 `intent` 认出是哪份额度（老的没带 id 的，按同一个 agent、同一个结束时间）；第二个签名被拒时，话没了、额度还在，页面把拒绝摆出来。

**agent 说**

```bash
# 在 MCP 里
portfolio_watchlist                                     # 你关注什么、给它（或给所有 agent）的意图和每个 agent 最新的回报、它自己的请求
portfolio_report {intent, status: "taking", note, refs} # taking · done · cannot · note；refs 只能是它自己的 ord-… / pay-… 或交易哈希
portfolio_ask {kind: "limit", venue, usd, text}         # letIn · limit · venue · topup · session · leverage · mode
```

- 请主人接一个场所之前，先读 `portfolio_venues`：每家对这个用户的结论（`connectable` · `not-served` · `close-only` · `terms-exclude` · `setup` · `closed` · `no-answer`）和场所的原话；连不了的还有 `edition`：给用户那里的另一个版本（比如 Binance.US、OKX US、Polymarket US），该请主人接的是它。不服务这个网络、或没有入口的场所（`not-served`、`closed`），`portfolio_ask {kind: "venue"}` 在门口就被拒（`E_VENUE_GEOBLOCKED`，带场所的话；有给用户那里的版本时，拒绝里点名该请哪一家），主人不会收到这张卡；只能平仓的（`close-only`）、条款排除用户所在地方的（`terms-exclude`）照样问到主人，主人在表单里看到场所的原话再决定。门口只用十分钟内问到的答案：更早的可能是另一个网络的（笔记本换了网），照样问到主人。

- 回报出现在 Agents at work 那条意图下面。一个 agent 在一个意图上最多 50 条，不会盖掉别的 agent 的；给所有 agent 的意图上，别的 agent 的回报对它只是别人的话，不是你的指令。
- 请求出现在 Waiting for you，和它的卡在一组。"Grant…" 打开你自己做这件事的那张表（额度、建钱包或充值、连接那个场所、会话、杠杆上限、模式、放它进来），签了请求自己关掉（给一份额度只关掉它问的场所在这份额度里的那些请求，没点场所的请求任何一份额度都关；收回额度——预算 0——什么都不给，不关请求）；"Decline…" 是一次签名（`answerAsk {ask, decision: "decline"}`），只关掉、什么都不给，agent 在 `portfolio_watchlist` 里一天之内看得见 `declined: true`。agent 要你接一个场所的，那条请求的按钮是 "Connect"，直接是那家的连接表单。
- 请求只在内存里、一天过期：同类同场所的再问替换旧的；一共最多 20 条、每个 agent 最多 5 条、每把钥匙一小时 5 条。没被放进来的钥匙也能请求放它进来（`letIn`），报的名字会洗干净，而且不能是、也不能像账户上某把钥匙的名字（放它进来会顶掉那把钥匙）。
- 重启以后关注和意图回来（每一条重新验签），请求和拒掉的请求不回来。
- agent 写的字页面一律转义、限长、去掉看不见的字符。工具说明里写着：意图是你的请求，不是许可。

会被拒：agent 的钥匙签关注、意图或 `answerAsk` `E_ACCOUNT_OWNER_ONLY` · 没被放进来的钥匙签 `E_ACCOUNT_UNKNOWN_SIGNER` · 关注、意图、请求、回报超过上面的数 `E_ACCOUNT_LIMIT` · 回报一条给别的 agent 的意图、回报里认领别人的单、拒一条已经没了的请求（答过了、过期了、或者服务重启过）`E_ACCOUNT_BAD_ACTION`。

## 8c · 记忆：agent 记得什么

账户替每个 agent 记着两样东西，换会话、重启、同一个席位换个程序来接，它都读得回来；你在 rail 最下面的 Account › **Memory** 读得到每一个字，能改、能删（`account/memory.ts`）。

- **对话**：你和这个 agent 之间来往的事，账户在它发生时写下：你给它的意图和收回、放它进来或撤销、给它的额度和钱包、你批或拒的卡、拒掉的请求；它的回报和请求，它签的每一条指令和结果（下了哪张单、出了哪张卡、被拒了和拒绝码）。给所有 agent 的话（给 `*` 的意图、关注、接上的场所、模式）只记一份，每个 agent 从它的钥匙被放进来那一刻起读得到。每个 agent 最多留 500 条，最早的先放掉（页面上写放掉了几条）。没有人签这些：是账户的记录。
- **笔记**：agent 自己要记的：你的偏好、要守的规矩、事实、教训、一件事做到哪了。用它自己的钥匙签（`agentRemember` / `agentForget`），只有它自己和你读得到；每个 agent 最多 100 条，每条 500 字。
- **About you**：你写的笔记，每个 agent 都读（`setMemory` scope `about`），最多 50 条。

**页面上**：Memory 一页左边是对话，照第七轮画 channel 的样子：你的话在右边蓝气泡里，它的话在左边灰气泡里带它的字母，账户给它的拒绝是一条带拒绝码的；日子变了或者隔了半小时有一行时间。每一条旁边一个小 ×（指着它或焦点在它上面时出来，手机上一直在）："Forget" 先确认，再一次签名（`forgetMemory`）。下面是 "What <它> keeps"：每条笔记一个话题标签、它的字、谁最后写的（"its own" 或 "written by you"）和时间，"Edit"（签 `setMemory`）· "Copy to About you" · "Forget"；"Write a note for <它>" 让你往它的笔记里写一条。右边是 About you 和写一条的表（"Sign and keep"），下面一张 "How memory works"。agent 不止一个时，最上面一排药丸挑看谁的；Lens 是一个 agent 时就是它。

**agent 这边**

```bash
# 在 MCP 里
portfolio_memory {limit, before, q}                     # About you、它自己的笔记、它的对话（最新的在最后；before 一个 turn id 翻更早的；q 找字）
portfolio_remember {text, topic, id}                    # 记一条（id 是改它自己的一条）；topic: preference · rule · fact · lesson · progress · other
portfolio_forget {id}                                   # 忘掉它自己的一条
```

`portfolio_account` 多一个 `memory: {aboutYou, myNotes, conversationTurns}`，提醒它会话开始时先读 `portfolio_memory`。

几条要知道的：

- **记忆是话，不是权限**：额度、门、卡都不读它。一条写着 "owner 允许每单 $10,000" 的笔记什么都不允许（有测试钉着）；你要 agent 做的事走意图和额度，你签的。
- **从来不收**：私钥（64 个十六进制字符）、助记词（连着 12 个 BIP-39 单词）、API 钥匙和密钥、密码、签过名的 token、公网 IP。这样的笔记在门口就被拒，拒绝不复述那几个字，账本上也没有；账户自己写的对话里遇到这样的串就换成 "[… not kept]"。用户所在的地方账户自己从不写进记忆。
- **忘了就是没了**：从文件里删掉，不是藏起来。笔记的字从来不进哈希链账本（账本那一行只写谁在什么时候改了哪一条），所以没有别处还留着；账本为它自己的理由本来就留着的（签过的意图、回报）照旧在。
- **文件**：`<home>/memory/about.json` · `everyone.json` · `agent-<地址>.json`，只有这个系统用户读得到（0600），整份写、先写临时文件再换名。home 是信任边界：同一个系统用户下的 agent 席位互相读得到文件，MCP 席位只读它自己的，那是席位的约定，不是墙（和第 11b 条一样）。
- 按钥匙记：一把新钥匙从空的笔记开始（About you 是共享的）；撤销了的钥匙的记忆留到你忘掉它，页面上写 "key gone"。

会被拒：笔记里有钥匙、密码、密钥或 IP `E_ACCOUNT_MEMORY_SECRET` · 笔记满了（agent 100 条、About you 50 条）`E_ACCOUNT_MEMORY_FULL` · 改或忘一条不存在的 `E_ACCOUNT_MEMORY_UNKNOWN` · 一条超过 500 字、一个 agent 一小时改笔记超过 120 次 `E_ACCOUNT_LIMIT` · agent 的钥匙签 About you、别的 agent 的笔记或对话 `E_ACCOUNT_OWNER_ONLY`（agent 只能忘它自己的一条笔记，忘对话 `E_ACCOUNT_BAD_ACTION`）· 没被放进来的钥匙 `E_ACCOUNT_UNKNOWN_SIGNER`。

## 9 · 把 agent 停下来

从轻到重：

| 想做的 | 怎么做 |
|---|---|
| 只停这一单 | 那张卡点 "Reject"；已经下了的，Trade 屏 Under way 里 "Cancel"（agent 的单先问你一次） |
| 收回一句话 | Portfolio › Agents at work 里那条意图的 "Withdraw"（连同随它给的额度） |
| 以后每一单都先问你 | rail 上切到 "Guard"，不用签名 |
| 这个场所不让 agent 碰 | Account › Venues 那一行关掉 "Open to agents"，不用签名（重新打开要签） |
| 收紧或收回它的额度 | Agents 弹层里那一行 "Change limit"；只收回 earn 的用 "End earn limit" |
| 停掉这把钥匙 | Agents 弹层里那一行 "Revoke" |
| 撤掉所有挂着的单 | Trade 屏 Under way 右上 "Cancel all N" |

钥匙撤销之后：

```
seat order okx buy BTC/USDT '$5'
401 ✗ E_ACCOUNT_AGENT_REVOKED · the agent key was revoked
```

撤销过的钥匙不能再授权，要换一把新的。

重启后场所没接回来：它上面没完成的单账户不再跟，Statement 里写 "not followed since a restart"；点 "Cancel" 只是把它那份额度放回 agent，单要在场所那边撤（账户既撤不了也看不到成交）。那个场所可以照常重新接上，不被这张单挡住。

**账本当证据**：每条被接受的指令连同它的签名信封、每一单的下单、成交、撤单都写进账本，账本是一条哈希链。

```bash
curl -s http://127.0.0.1:4820/api/overview | python3 -c "import json,sys; o=json.load(sys.stdin); print(o['chain'], o['ledgerPath'])"
```

- 文件在 `$BUYER_HOME/portfolio/`（默认 `~/.buyer-agent-demo`），每次启动一个新文件，第一行写着它接着哪个文件。Statement 只读账户自己的运行链和带运行标记的账本：demo、测试或别的程序写在同一个 home 里的账本不算（两个终端 demo 每次用一个新的临时 home，`$BUYER_HOME` 它们不读，只认 `--home`）。
- 重启以后账户从这条账本链重建（第 10 条）。以前收过的指令不会再收第二次；发给场所的客户端编号每次启动都不同，不会撞上以前的单。

## 10 · 随时在线：后台服务，重启不丢

**重启不丢**：每次运行的账本第一行写着它接着上一次的哪个文件，这条链就是账户。启动时从最早一个文件读起，重建：
- owner 的浏览器（配对那一行记着设备的公钥，以及它输过配对码）：重启后不用再配对。只读模式也要配对码；没输过码就进来的 owner，在要码的那次运行里不算数，要重新配对；
- 加进来的设备（申请加入那一行记着它的公钥）：你签名让它成为签名人的那一步，重启后照样成立，之后它签的也照样算；
- 你签过的每一条长期指令（放 agent 进来、撤销、各种额度含 earn 额度、地址簿、签名人、接上和拔掉的账户、切到 Beast、agent 的会话和杠杆上限、关注、意图）：每一条都**重新验签**，按当时的时间重放；验不过的跳过，并写明；
- 每份额度用了多少、钉住的收款地址；某条指令被跳过时，后面的额度编号不会错位；
- 收款方还拿着、没兑现的付款授权：继续占着额度，兑现了照记，过期了才放；
- 账户重新接上：用你当初签的同一个凭据引用（钥匙文件、地址、本机的 mm）；钱包的证明是它当初签的那句话，再验一次；agent 钱包从它的钥匙文件；
- 没完成的单和在途的钱接着跟（只问，不重发）；场所没接回来的单标成不再跟（第 9 条）；以前运行里做完的 earn 还是 Done；编号接着往下排，ord-0007 永远是同一单。

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

- Claude Code：Agents 弹层里 "Copy agent setup command"（Portfolio 的三步清单里是 "Copy setup command"）复制的那一行，`/api/account` 的 `agentSetup.command`：`claude mcp add portfolio -e PORTFOLIO_URL=http://127.0.0.1:4820 -- npx tsx <仓库的绝对路径>/src/portfolio/mcp.ts`。带着这个服务的地址和 `mcp.ts` 的绝对路径，在哪个目录跑都行。在这个目录里，短的 `claude mcp add portfolio -- npx tsx src/portfolio/mcp.ts` 也一样。
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

真实账户上席位只注册真实账户的工具（`mcp.ts` 头上那两张表）：`portfolio_read`、`portfolio_markets`、`portfolio_quote`、`portfolio_openness`、`portfolio_execute`、`portfolio_order` 是 `--classic` 和测试里分层模拟的，`portfolio_transfer` 只在分层模拟上；席位启动时读一次 `/api/account` 判断账户是不是真实的（读不到的当作真实），所以真实账户上的 agent 根本看不到它们。`portfolio_overview` 在真实账户上的流动性是每个场所对自己钥匙或钱包的说法，不带模拟的阶梯和日上限；`portfolio_live_positions` 可以不带 venue；`portfolio_wait` 把 `stranded` 当终态；`portfolio_live_move` 的币是账户认的每一种美元稳定币、桥的目的链含 Robinhood Chain；`portfolio_receive` 给的是场所自己给的地址，agent 改不了；`portfolio_account` 带 owner 的模式（`mode`：`guard` 是 Guard，`open` 是 Beast）和 `modeRules`（Mode 弹层那张表，每扇门两档各怎么做，`cardMinutes` 是一张卡等几分钟）；`portfolio_explore` 的 `tab` 是 all · crypto · stocks · rwas · perps · preipo · predictions，pre-IPO 每家公司一行，行和每个场所的 `at` 带 `implied {usd, unit}`（行的是各家隐含估值的中位数；一个场所的合约在 `portfolio_live_markets` 里还带 `perPoint`），IPO 的问题是普通的 predictions 行；`portfolio_live_compare` 可带 `asset`（`stock` 或 `crypto`），一个名字既是币又是股票时说比哪一个。agent 交易 pre-IPO 永续用的就是普通的永续工具，`symbol` 是 `portfolio_explore` 里那一家的写法。

agent 进来以后常用的一圈：`portfolio_account`（我是谁、能做什么）→ `portfolio_venues`（这个用户从他的网络能接哪些场所）→ `portfolio_watchlist`（owner 想要什么）→ `portfolio_explore` / `portfolio_holdings`（有什么、我手里有什么）→ `portfolio_live_preview`（这一单会怎样）→ `portfolio_live_order`（Guard 下是一张卡）→ `portfolio_wait` → `portfolio_report`（告诉 owner 做了）。缺额度、缺场所时 `portfolio_ask`，然后接着做手里能做的，不要原地等。

## 11b · Agent 模块接口（给做 Agent 模块的团队）

Agent 的管理（放谁进来、给多少额度、它们在做什么、它们要什么）归你们的模块。账户这边把读接口、要签的动作、签名的方式和挂载位做干净，你们照这些接，不用改账户的门。

**挂在哪**

- 页面是 `public/ui/` 下几个普通脚本，共享一个全局作用域，按 `account.html` 里的顺序跑：`owner.js`（设备钥匙）先跑，然后 `core` · `connect` · `money` · `asset` · `intent` · `portfolio` · `memory` · `earn` · `markets` · `trade` · `statement` · **`agents-mount`** · `shell`。约定写在 `ui/core.js` 顶上的注释里。
- 挂载位是 `ui/agents-mount.js` 的 **`openAgents()`**：rail 上的 "Agents" 调它（旁边的数是敲门等放行的钥匙个数；第七轮的 rail 上它在 Markets · Trade 下面）。路由是 `#/portfolio` · `#/venues` · `#/memory`（Account 的三页，`ACCOUNT_TABS`）和 `#/markets` · `#/trade`。保留这个名字，换掉它的内容就是接管。现在的内容是 agent 表和表单、Agent wallets，和最下面一行 "Copy agent setup command"，原样能用，你们的模块到之前不动；Devices 搬进了 Settings（owner 自己的设备，不归 agent 模块）。
- 规矩：每个顶层名字在所有脚本里只声明一次（`test/unit/page-scripts.test.ts` 会把它们按 HTML 顺序拼起来编译、抓重名）；新文件放 `ui/<名字>.js|css`（服务只认 `ui/` 下一个简单名字），加进 `account.html`，样式加进那个测试的清单；颜色只用 `ui/tokens.css` 里的，Cream 和 Black 一起对。没有构建步骤。
- 别的屏也会把人送到 agent 的事上，这几处你们接管时要一起看：Portfolio 的 Waiting for you（卡、请求的 "Grant…" / "Decline…"，`portfolio.js` 的 `declineAsk(ask)` 和各个 Grant 表）、各处的 Hand to agent（下单票的 "Hand to agent instead"、市场抽屉、Portfolio 的快捷操作、Earn 弹层，都是 `intent.js` 的 `openHandToAgent(preset)`；在 Trade 屏上它占右边的面板）、Settings 里的会话和杠杆上限（`agents-mount.js` 的 `renderDial`）、Portfolio 的 Agents at work（开着的意图，`intent.js` 的 `htaIntents`；agent 最近做了什么）、Mode 弹层（`agents-mount.js` 的 `openMode()`，画的是 `A.modeRules`）、Statement 的 Who 筛选。
- 能直接用的工具（都在 `core.js`）：`A`（上一次 `GET /api/account` 的结果）、`load()`、`own(draft, then)`、`api(path, {ttl})`、`openSheet` / `openDrawer` / `confirmSheet` / `pickSheet` / `quoteDialog`、`whatYouSign(prepared)`、`toast`、`esc` 和画表的 `table`、`seg`、`field`。从别的脚本里调一个打开函数之前先问 `typeof openX === "function"`。

**读**（都是 `GET`，不签名）

`GET /api/account` 里和 agent 有关的字段：

| 字段 | 是什么 |
|---|---|
| `keys[]` | 被放进来过的 agent 钥匙：`address`、`name`、`code`（航班号前缀）、`validUntil`、`approvedAt`、`status`（`ok` · `expired` · `revoked`）。同一把钥匙到期后再放进来会出现两次，以后一次为准 |
| `requests[]` | 敲门、还没被放进来的钥匙：`address`、`name`（它自己报的，洗过；和账户上的钥匙重名或形近时是空的）、`at`。最多留 8 个 |
| `spend[]` | 额度，一份一行：`id`、`agent`、`agentName`、`scope`（`trade` · `venues` · `payees` · `earn`）、`allow`、`perPaymentUsd`、`budgetUsd`、`spentUsd`、`reservedUsd`（等批的卡和没兑现的付款占着的）、`windowHours`、`validUntil`、`expired`、`payTo`（钉住的收款地址）、`intent`（随哪个意图签的，有才带） |
| `subAccounts[]` | agent 钱包：`id`、`name`、`agent`、`agentName`、`address`、`capUsd`、`balanceUsd`（真实账户上是链上读到的这个钱包的余额）；它在 `venues[]` 里是 `agent-<名字>`，没有 Disconnect |
| `cards[]` | 等 owner 批的卡：`id`、`flight`、`usd`、`reason`、`hash`（批的时候要签进去）、`kind`（agent 的指令类型）、`agent`、`agentName`、`expiresAt`、`shown`（卡上要签的字段） |
| `asks[]` | agent 的请求：`id`、`agent`、`agentName`、`kind`、`venue`、`usd`、`text`、`at`、`expiresAt`。只在内存里 |
| `declinedAsks[]` | 一天内拒掉的请求，多一个 `declinedAt` |
| `intents[]` | owner 开着的意图：`id`、`agent`（地址或 `*`）、`agentName`、`venue`、`symbol`、`side`、`usd`、`text`、`validUntil`、`at`、`reports`、`report`（最新一条）、`byAgent`（每个 agent 最新一条） |
| `watch[]` | owner 关注的市场 |
| `orders[]` · `payments[]` · `earns[]` | 每一条都带 `agent`（下它的钥匙；owner 下的没有） |
| `modeRules` | `{ rows: [{door, guard, beast}], cardMinutes }`：Mode 弹层那张表，每扇门两档各怎么做、一张卡等几分钟（`account/mode-rules.ts`）；页面照它画，不自己写 |
| `mode` · `dial` | `guard`（Guard）或 `open`（Beast）；`dial` 是 agent 的会话到哪天、是否已结束、关给 agent 的场所（`revoked`）、最大杠杆 |
| `connectLive.writes` | 服务能不能交易（`on`）、单笔上限（`capUsd`） |
| `agentSetup` | 加这个 MCP 席位的那一行命令（`command`）和服务地址（`url`） |
| `dollars` · `networks` · `bridgeChains` · `real` | 门收的三张表：账户认的美元稳定币、它们所在的链、桥能到的链；`real: true`。真实账户上每个场所**不带** `runways` / `agentKey` / `in` / `out` / `swaps` / `fiat` / `ledgers`，顶层不带 `destinations`——那些是模拟门的词，别读 |

`GET /api/account/agents` 是同样的东西按 agent 摊开（`mode` 也是 `guard` / `open`，和 `/api/account` 一个词）：`{asOf, mode, requests, agents: [{address, name, code, status, validUntil, approvedAt, limits: [{id, scope, allow, perPaymentUsd, budgetUsd, spentUsd, reservedUsd, leftUsd, windowHours, validUntil, expired}], cards, orders, payments, earns, wallets, intents, asks, declinedAsks, flights, memory: {notes, turns}}]}`。

记忆（第 8c 条）：`GET /api/account/memory?turns=100` 是 owner 读的全部：`{asOf, about, everyone: {turns, total, dropped}, agents: [{address, name, code, status, notes, conversation: {turns, total, more, dropped}}], limits}`（`status` 多一个 `gone`：账户不再列这把钥匙，它的记忆还在）；`GET /api/account/memory/agent?address=&before=&limit=&q=` 是一个 agent 读到的（About you、它自己的笔记、它的对话，最新的在最后）。笔记是 `{id, topic, text, at, updatedAt?, by: agent | owner}`，对话的一条是 `{id, at, who: owner | agent | account, kind, text, ref?, code?}`；给所有 agent 的那几条 id 是 `all-…`。`GET /api/account/statement` 的每一行也带 `agent` / `agentName`。

**要签的动作**（owner 的，都从 `POST /api/exchange` 进；字段必须恰好是这些）

| 动作 | 字段 | 要知道的 |
|---|---|---|
| `approveAgent` | `agentAddress, agentName, validUntil` | 放一把钥匙进来，最长 180 天，同时最多 4 把。撤销是 `agentAddress` 写零地址、`agentName` 写它的名字、`validUntil` 0；撤销过的不能再放进来 |
| `approveSpend` | `agent, scope, allow, perPayment, budget, windowHours, validUntil`，可选 `intent` | `scope` 是 `trade`（下单）· `venues`（在你自己的账户之间挪钱）· `payees`（从 agent 钱包付给别人）· `earn`（放进 earn 产品）。`allow` 逗号隔开：场所 id，`payees` 是域名；`trade` / `venues` 的 `*` 在签的那一刻写成当时的全部场所，之后接的不算；`payees` 的 `*` 只在勾了 "any payee" 时；`earn` 从不收 `*`，写场所或 `场所:产品`。每个 agent 每个 scope 只留一份，新的替换旧的；`budget` "0" 是收回；`windowHours` > 0 是每个场所（`payees` 是每个收款方）每个窗口一笔，改单不算第二笔；`intent` 是这份额度回答的开着的意图的 id（给这个 agent 或给所有 agent 的），带了才签进去，不带就和以前一样 |
| `createSubAccount` | `name, agent, float` | 在真实账户上是建一个 agent 钱包：钥匙在本机生成（`<home>/agent-wallets/`），agent 拿不到 |
| `setIntent` | `id, agent, venue, symbol, side, usd, text, validUntil` | `id` 空是新的；`agent` 是地址或 `*`；`validUntil` 0 是收回。什么都不授予 |
| `answerAsk` | `ask, decision` | `decision` 只能是 `"decline"`。答应一个请求就是去做它要的那件事（上面这些动作），做完请求自己关掉 |
| `approveCard` | `card, action, decision` | `action` 是那张卡的 `hash`，`decision` 是 `approve` 或 `reject`；放行时所有检查重跑 |
| `setPolicy` | `change, value` | `mode` / `open`（切到 Beast）、`session` / `30d`（重开或续会话）、`maxLeverage` / 倍数、`restore` / 场所（对 agent 重新打开）、`reach` / `场所:能力,能力`（对 agent 开放这家的哪些动作）、`say` / 一句话（送给页面的关键词脚本 agent——`--classic` 对账单上的那个；Account 页面上没有它的对话框）；`advance`、`reset` 只在模拟上。收紧（切回 Guard、对 agent 关掉一个场所）不用签：`POST /api/mode {mode: "guard"}`、`POST /api/revoke {account}` |
| `convertToMultiSigUser` | `signers` | Devices：让一个待批的浏览器也能签（页面上只有这个；要两个都签的流程没做） |
| `setMemory` | `scope, id, topic, text` | 记忆（第 8c 条）：`scope` 是 `about`（About you）或一个 agent 的地址（写进它的笔记）；`id` 空是新的一条，写一条的 id 是改它；`topic` 是 preference · rule · fact · lesson · progress · other。字不进账本 |
| `forgetMemory` | `scope, what` | `scope` 是 `about` · `everyone`（给所有 agent 的话）· 一个 agent 的地址；`what` 是一条笔记或一条对话的 id、`notes`、`conversation` 或 `all`。从文件里删掉 |

**在浏览器里怎么签**（`public/owner.js`）

1. `Owner.prepare(draft)`：`POST /api/account/prepare {draft}`，`draft` 是上表里的字段，不带 `nonce`。账户把它写成要签的确切动作：补上 `nonce`，动钱的补上路线、手续费上限、最晚到账，下单的补上确切数量和最多值多少。回答是 `{action, primaryType, domain, accountChain, shown, quote?}`；拒绝是 `409` 和 `{refusal}`，签之前就看得到。
2. 把 `shown` 摆给人看：`whatYouSign(prepared)`。这就是要签的全部。
3. `Owner.submit(prepared)`：浏览器从 `shown` 自己拼出签名输入（`{domain, primaryType, message}` 的规范 JSON，`message` 是 `accountChain` 加 `shown` 里的每个字段，不拿服务器给的现成字符串），用这个浏览器里导不出来的 P-256 设备钥匙签，送 `POST /api/exchange {action, nonce, signature: {kid, es256}}`。服务器用它存的公钥按同样的规则验。
4. 回答：`200` 做了 · `202` 出了一张卡 · `401` 不是签名人 · `409` 拒绝（`refusal.code` 和场所或账户的原话）。

`Owner.act(draft)` 是 1 和 3 合在一起；`own(draft, then)` 再加上忙碌状态、把结果或拒绝变成 toast、做完 `load()`。只有配对过的设备签的才算 owner；账户设了两人都签时，一个签名不够（`E_ACCOUNT_THRESHOLD`）。

**读接口的规矩**：`/api/account/quotes` 最多 12 个市场，多了是 409；同一个查询参数给两次是 400（"given more than once"）；`/api/account/explore` 的 `limit` 只收 1–200 的数字。`/api/` 下的答复浏览器不缓存（`no-store`）；页面本身每次重验（`no-cache`），它引用的 `/ui/` 文件带内容的哈希（`?v=`）、留一年，按浏览器要的压缩（brotli 或 gzip）发出，每个进程只从磁盘读一次。服务内部出错回 500，正文永远是同一句 "The account hit an error answering this; it was recorded."，异常文字只进服务的日志。

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

种好的：Stand-in Exchange（现货、永续、一个已有的 BTC 多头、两个 earn 产品，和一个 pre-IPO 永续 `ANTHROPIC/USDT:USDT`：Anthropic 的隐含估值，约 2,100，按 $1 对 $10 亿）、Stand-in Predictions（几分钟到几天后收盘的事件，加一个十五分钟一轮的 "Bitcoin up or down"，和一个 IPO 问题 "Will Anthropic IPO before January 1, 2027?"）、Stand-in Wallet（代币，其中一个 RWA）；你自己的几单和几笔挪钱；一个叫 "Claude Code" 的 agent，有额度（agent 最多能设 5 倍杠杆）、有钱包、下过一单、还有一张卡等你批；两个意图、一条回报、两个请求、三个关注；七天的净值点。跑着的时候价格在动，挂单会成交，止损会触发，"Claude Code" 的卡没人答过期了会再问一次。Markets 打开是 All，还有几个只在公开行情里有的币和一家不服务这个地区的交易所，"Connect to trade" 能真的接上替身的公开场所。Pre-IPO 里一行 Anthropic：Stand-in Exchange 那条能 "Trade"，同一个合约在没接的 Stand-in Perp Exchange 上是 "Public"；它的抽屉在 "IPO markets" 里列出那个 IPO 问题，Predictions 里也有它。Trade 的种类是 Crypto · Stocks · RWAs · Perps · Pre-IPO · Predictions。Stocks 那一面是 Stand-in Broker：AAPL、NVDA、SPY（AAPL 和 SPY 能买零股，NVDA 只能整股），$2,000 现金，持有 3 股 AAPL、2 股 NVDA（美股开着盘时，其中半股 AAPL 和一股 NVDA 是你经门下的市价单；收了盘不收市价单，它们就是券商里本来就有的），还有你一张挂在市价下面的 SPY 限价买单。它按纽约时间周一到周五 9:30–16:00 开盘：收盘时不收市价单，照 Alpaca 的话说哪天几点开盘，别的单子留到开盘再上簿，日内单到收盘作废；NVDA 和 SPY 与 RWAs 里的同名股票代币互相指过去。

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

三十个文件。早的二十个是独立审阅那一路留下的复现，其中十八个每个是一次真实跑通过的攻击，写成 `it.fails`：测试断言「攻击成功」，并被期望失败——哪天攻击又能成功，这个测试就报错；两个（`money-instruction-future-nonce`、`rekey-second-account`）直接断言。后来加的十个（`order-door-holes`、`real-pay-holes`、`restore-holes`、`steer-holes`、`earn-holes`、`seat-reads`、`ask-candles-earn-holes`、`earn-pair-holes`、`ask-reworded-decline`、`review2-account`）一个文件一组攻击，每个测试直接断言攻击不成：真钱的下单门、真钱付款、重启重建、引导（意图、关注、回报、请求）、earn 门和永续的地区线、席位之间看得见什么、拒请求和 K 线的 host 和 earn 只算一次、earn 和余额不重复计、改口的请求、第二轮审阅在门和重建上该成立的每一条。`seat-reads` 的最后一个测试钉住的是边界本身：读接口对本机任何进程都开着，席位的过滤不是墙。

找到新洞时照这个顺序：先写成一个普通测试，让它通过，证明洞是真的；修；把 `it` 改成 `it.fails`（或者像后来的十个那样，改写成断言攻击不成的测试，修之前它必须是红的）；再在 `test/unit/` 里加一条正面的回归测试。

## 出了状况先看这里

| 现象 | 原因 |
|---|---|
| `npm run account` 报 `port 4820 is already in use` | 已经有一个在跑了，直接打开页面。要第二个就加 `--port 4821 --home 〈另一个目录〉` |
| 页面按钮全灰，顶栏下面一行 "can look but not sign" | 你不是 owner，见第 1 条 |
| 钥匙文件那一步一直 "Waiting for the file…" | 路径不对，或者文件还没存盘。复制弹窗里的路径或那条命令 |
| 席位一直 `401` | 钥匙没授权、过期或被撤销，见第 3、9 条 |
| `this account holds real accounts only` | 这条指令只动模拟的钱。下单走 `liveOrder` / `agentLiveOrder`，动钱走 `liveMove` / `agentLiveMove`，见第 5、6、7 条 |
| Trade 屏上少一种市场，或下单票的 Where 里这家写着原因 | 没有接上的场所交易这一种，公开行情里也没有：没东西的种类不画（替身上没有 Stocks）；`--read-only` 起的服务价格照样有，签名按钮写只读的那句话；或者钥匙没开交易（Accounts 那一行的标签写场所的话，Details 里写着要勾什么，还有 "Connect a new key"）；或者这个场所不能从这里下单（按地址接的 Hyperliquid、Ondo、只填了地址的 Polymarket） |
| Markets 的 Perps 里找不到 ANTHROPIC、OPENAI | 它们是 pre-IPO 永续，只在 Pre-IPO tab，每家公司一行（第 2c 条） |
| OKX 那条 pre-IPO 的价格只有别家的十分之一 | 它的 ANTHROPIC、OPENAI 两个合约 2026-06-30 做了 10:1 的 rebase：$1 对 $100 亿。隐含估值一样，每家那一条写着它的单位 |
| Markets 的一行写着 "Connect to trade" | 那是没接的场所的公开行情：点它接上那家，见第 2c 条 |
| Polymarket 的卡片写 "Close only here" | Polymarket 让你那里只平仓（美国在内）：照样能接，能卖、能撤单，买会被它的原话拒掉。在美国开新仓用 Polymarket US（另一家交易所，自己的卡；表单里也有 "Connect Polymarket US instead"） |
| 美国账户的 OKX 钥匙，接 OKX 卡片说不认这把钥匙 | OKX 的 API FAQ：美国账户的钥匙只在 OKX US（us.okx.com）能用。接 OKX US：OKX 卡片旁边那张，或表单里的 "Connect OKX US instead"，"Another exchange" 里也有 |
| 接交易所时说 "refuses this key from this machine's address" | 钥匙绑了 IP，这台机器现在的地址不在名单上（家里的宽带换了地址、换了网络，或者钥匙是在别的机器上建的）。去交易所的 API 管理页，把这台机器现在的地址加进钥匙的 IP 名单，或者重建钥匙；钥匙和地区都没问题 |
| 说 "has banned this machine's address for too many requests until …" | 场所因为请求太多封了这个地址（Binance 的 418），封到它说的时间；账户到那时之前不再问它 |
| 说 "refuses this network: the server in front of it answered HTTP 403 … and gave no reason" | 场所前面的服务器拒绝了这个网络，没说为什么（按地方，或者按这个地址的信誉）；那是它的回答，账户不找别的路 |
| Markets 底下 "Why these, and what's not shown ⓘ" 里说某个场所没答或不服务这里，或一行写 "Not served here · why" | 那是场所自己的话（在开发者那台美国的机器上，Binance 451、Bybit 403 是按地区拒绝；别处照各自的网络算）；`npm run account:check` 把每家对这台机器的回答列出来；没答的那家整个搁 20 秒不再问，说不服务这个地区的搁 10 分钟；连接器抛了异常也算没答（`E_VENUE_UNREACHABLE` · "answered in a way the account could not read"），异常文字只进服务器日志 |
| 净值曲线不画，或只写 "since …" | 不到两个点，或历史还短：账户每五分钟记一个点，之前的不知道，见第 2b 条 |
| Assets 写 "Cost known for 1 of 3" | 有的币是账户之前就有的、或从别处转进来的，账户没见过它的成本，见第 2b 条 |
| 代币化股票的签名按钮按不下去 | 发行方关了或限制了它（OUSG、BUIDL 从不 swap），原话写在按钮上方，见第 5b 条 |
| agent 一直要额度 | 它在 `portfolio_ask`。Waiting for you 里 "Grant…" 或 "Decline…"；拒掉的它一天之内看得见，见第 8b 条 |
| 下单回 `E_VENUE_ORDER_INVALID` | 不到这个市场的最小单，或者数量、价格不在步长上：下单票的价格行写着步长 |
| Binance 的 key 下不了单 | 系统生成的 key 不绑 IP 只能读：绑本机 IP，或者用自己生成的 Ed25519 key |
| `E_ACCOUNT_EXPIRED` | nonce 用了本机时间。取 `GET /api/now` |
| `E_ACCOUNT_NONCE` | 这条指令收过了。同一条重发拿到的是第一次的结果，改了内容要换 nonce |
| 刚接上的账户 agent 用不了 | 它不在旧额度里，见第 3 条 |
| agent 的单没有出卡就下了 | 模式是 Beast，见第 4 条 |
| 重启之后有的账户没接回来、agent 的请求不见了 | 顶栏下面那一行的 details 写着没接回来的和原因（例如 Robinhood 的登录令牌只在内存里，要重新登录）；请求只在内存里，重启就没了，关注和意图会接回来，见第 10 条。`--fresh` 起的什么都不接 |
| rail 底下一枚 "Not answering since HH:MM" | 账户进程没应答（挂了、在重启），页面留着上一次读到的，恢复就撤 |
| 回 500，正文 "The account hit an error answering this; it was recorded." | 服务内部出错，细节在服务的日志里，不上线 |
| 批一张卡回 `E_ACCOUNT_CARD_EXPIRED` | 卡 30 分钟没人答，账户自己关了它、放回了它占的额度，见第 8 条 |
| Statement 里一单写 "not followed since a restart" | 重启后它的场所没接回来，账户不再跟它：在场所那边撤，见第 9 条 |

## 拒绝码速查

| 码 | 意思 |
|---|---|
| `E_ACCOUNT_UNKNOWN_SIGNER` · `E_ACCOUNT_AGENT_EXPIRED` · `E_ACCOUNT_AGENT_REVOKED` | 这把钥匙不是（或不再是）签名人 |
| `E_ACCOUNT_BAD_SIGNATURE` · `E_ACCOUNT_BAD_ACTION` | 签名对不上，或者动作的字段不是签名覆盖的那些（名字不是明文或太长：agent 钥匙名 32 字、子账户名 16 字、地址簿标签 32 字；金额的整数部分超过 15 位）；在只认真实账户的服务器上，也是只动模拟钱的指令 |
| `E_ACCOUNT_NONCE` · `E_ACCOUNT_EXPIRED` | 用过的 nonce（同一条信封重发拿第一次的结果；两天前的信封再来已出了窗口，不认），或者离标注的时刻超过十分钟（改杠杆也算资金指令） |
| `E_ACCOUNT_OWNER_ONLY` | 这件事只有 owner 能签：提现、Send、授权、批卡、收回 float、关注、意图、拒一条请求、About you、改或忘 agent 的记忆 |
| `E_ACCOUNT_NOT_HOME` | agent 想把钱送到你自己的场所之外 |
| `E_ACCOUNT_MEMORY_SECRET` · `E_ACCOUNT_MEMORY_FULL` · `E_ACCOUNT_MEMORY_UNKNOWN` | 记忆（第 8c 条）：笔记里有钥匙、密码、密钥、助记词或公网 IP（不收，也不复述）；笔记满了；没有这一条 |
| `E_ACCOUNT_SOURCE` | 没写来源而账户是 Separate；或者动了别人的 float |
| `E_ACCOUNT_DESTINATION` · `E_ACCOUNT_DEST_COOLING` | 目的地不是你的、不在地址簿、链不对，或者还在冷静期 |
| `E_ACCOUNT_REQUOTE` · `E_ACCOUNT_CARD_EXPIRED` | 签过之后价格或报价变了；卡过期了（30 分钟没人答，账户自己关的） |
| `E_CARD_NOT_GRANTED` · `E_CARD_REJECTED` | 批卡：没有这张等批的卡（答过了、过期了、编号不对）；owner 拒了这张卡（agent 在 `portfolio_approval` / `portfolio_wait` 里看到的结果） |
| `E_ACCOUNT_ORDER_UNKNOWN` | 账户上没有这张单，或者它不是这把钥匙下的（agent 只能撤自己的单） |
| `E_VENUE_ORDER_INVALID` · `E_VENUE_MARKET_CLOSED` · `E_VENUE_INSUFFICIENT` | 场所不按这样的数量、步长或价格接单；市场收盘了；余额不够 |
| `E_ACCOUNT_FEE_CAP` · `E_ACCOUNT_THRESHOLD` · `E_ACCOUNT_UNPRICED` | 应用抽成高于你批的费率；签名人不够；这个币没有价格，没法判额度 |
| `E_ACCOUNT_LIMIT` · `E_ACCOUNT_OWNER_SURFACE` | 超过账户自己的上限（含 `--live-cap`，平仓和 earn 也算；关注、意图、请求、回报的条数）；一个没签名的请求打到了只认 owner 设备的接口上，或配对码不对 |
| `E_MANDATE_NONE` · `E_MANDATE_RECIPIENT` · `E_MANDATE_PER_ORDER_CAP` · `E_MANDATE_BUDGET` · `E_MANDATE_RATE` · `E_MANDATE_EXPIRED` | 额度的线（交易、挪钱、付款、earn 四种一样）：没有额度、没点名、超单笔、超预算、太频繁、到期 |
| `E_MANDATE_INVALID` | AP2 的 mandate 验不过 |
| `E_PAYEE_OVERCHARGE` · `E_PAYEE_CHANGED` · `E_PAYEE_REDIRECT` · `E_PAYEE_UNVERIFIED` · `E_PAYEE_REJECTED` · `E_PAYEE_UNSUPPORTED` | 收款方那边的线：加价、换地址、重定向、验不过、不收、说的协议账户不会 |
| `E_VENUE_RAIL_CLOSED` · `E_VENUE_MIN_DEPOSIT` · `E_VENUE_WITHDRAW_WHITELIST` · `E_VENUE_PERMISSION` | 场所自己的线：这扇门不对你开、低于最低额、地址不在白名单、钥匙不许（或钥匙绑的 IP 里没有这台机器现在的地址：`detail.ipList`） |
| `E_VENUE_TRANSFER_RESTRICTED` · `E_VENUE_REJECTED` | 发行方的线：代币只在它批准过的钱包之间转（OUSG、BUIDL）；场所或发行方不认（发行方不认这个代币、不在这条链上发、清单没应答；mm 和账户自己的来源都说不出这台机器在哪，永续就不下） |
| `E_VENUE_CURRENCY` · `E_VENUE_BAD_SIGNER` | 场所不换这两种币，或这条链上账户不认识这个币（Receive、桥）；Polymarket 不认这个签名人：钥匙文件里的 `funderAddress` / `signatureType` 说的谁下单、谁签，和它记的对不上 |
| `E_WALLET_FLOAT_CAP` · `E_WALLET_INSUFFICIENT` · `E_WALLET_BLOCKLIST` | float 满了、不够，或者地址在黑名单上 |
| `E_WALLET_ACCOUNT_UNKNOWN` · `E_WALLET_UNKNOWN_VENUE` | 来源或目的地不是接在账户上的场所（agent 挪真钱只在接上的场所之间），或没有这个子账户；统一接口库不认识这个交易所 id，或连接器名字不对 |
| `E_ACCOUNT_CREDENTIAL` · `E_VENUE_UNREACHABLE` · `E_VENUE_GEOBLOCKED` · `E_VENUE_UNAUTHORIZED` | 真实连接：钥匙文件不能用（席位和 agent 钱包的钥匙文件也一样，拒绝里只说是哪把钥匙，路径在 `detail`）、场所没应答或答得账户读不懂（或因为请求太多封了这个地址，到它说的时间）、场所不服务这个地区（含只能平仓的地方的买入、场所前面的服务器拒绝这个网络）、场所不认这把钥匙 |
| `E_WALLET_LIVE_WRITES_OFF` | 这个服务是 `--read-only` 起的，或者 MetaMask 自己的开关没开 |
| `E_WALLET_SESSION_EXPIRED` · `E_WALLET_ACCOUNT_REVOKED` · `E_WALLET_REACH` | agent 的会话结束了；这个场所对 agent 关着（Account › Venues 的 "Open to agents"）；owner 没对 agent 开放这家的这一类动作（`setPolicy reach`：交易、放进 / 取出 earn） |
