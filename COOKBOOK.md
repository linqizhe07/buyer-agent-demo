# Account Cookbook

README 的「Account：资金的机场」讲这一层**是什么**，这里讲**怎么做**。每条做法写的是：想做什么、怎么做、会看到什么、什么会被拒。

分两半。**上半是你真实的账户**：`npm run account` 起的服务，一个页面（`/`），叫 Account，上面只有你经各家自己的接口接进来的账户，没有一样是模拟的。**下半是模拟账户里的规则**：场所之间的路由、float、替 agent 付 API（x402、MPP、AP2）、地址簿、Unified、可插的模拟场所。这些只跑在进程里（`examples/account/headless.ts` 从头走一遍，`npm run account:demo` 的十四个 beat 带断言，外加测试）；只认真实账户的服务器对这类指令一律回 `this account holds real accounts only`。模拟里的钥匙从源码里的标签派生，是公开的。

## 三个角色，一个入口

- **owner**：钱的主人。页面上是浏览器里一把导不出来的设备钥匙。脚本和测试里是一把从标签派生的钱包钥匙。
- **agent**：一把钥匙。owner 放它进来、给了额度之后，它能请求在你真实的账户之间动钱。Conservative 下每一笔都等你签；Aggressive 下额度内直接动。别的都不能。
- **account**：跑着的服务。它验签、查额度，替你向场所要目的地址和手续费。agent 拿不到任何场所的凭据。

所有改动走同一个入口：一条签了名的指令，`POST /api/exchange`。回答只有四种：

| 状态 | 意思 |
|---|---|
| `200` | 做了。动钱返回一张付款单，可能还在途 |
| `202` | 先问 owner：页面上出现一张卡 |
| `401` | 这把钥匙不是签名人（没授权、过期、被撤销） |
| `409` | 拒绝，带一个说明越了哪条线的码（文末有速查） |

# 上半 · 你真实的账户

## 0 · 怎么跑

| 想要 | 命令 |
|---|---|
| 接你真实的账户，自己点 | `npm run account`，打开 <http://127.0.0.1:4820>（`npm run portfolio` 同） |
| 允许动真钱（终端打印配对码，每笔最多 $5） | `npm run account -- --live-writes --live-cap 5` |
| 扮演一个 agent，对跑着的服务发请求 | `npx tsx examples/account/agent-seat.ts whoami` |
| 让 Claude Code、Codex 这类 agent 来当 agent | `claude mcp add portfolio -- npx tsx src/portfolio/mcp.ts` |
| 模拟账户里的规则，一个脚本从头走到尾，不起服务 | `npx tsx examples/account/headless.ts` |
| 十四个 beat 的断言脚本 | `npm run account:demo` |

`npm run account -- --port 4821 --home /tmp/x` 另起一个互不相干的实例。`--classic` 是原来的模拟对账单，不挂这一层。

页面从上到下：头部（Account、Conservative / Aggressive、真钱开关）· 净值和配置条 · 等你批的卡 · Accounts · Activity · Agents · Devices。`seat` 是这个别名：

```bash
alias seat='npx tsx examples/account/agent-seat.ts'
```

## 1 · 成为 owner

用 `--live-writes` 起的服务在终端打印一个配对码：打开页面，在顶上那一栏输入它，点 "Pair"，这个浏览器才成为 owner。没开真钱写入的服务，第一个打开页面的浏览器就是 owner。Devices 里那一行写着 "This browser"。

- 不是 owner 时，页面顶上有一行 "This browser can look but not sign."，按钮都是灰的。让 owner 的浏览器在 Devices 里点 "Let it sign"。点 "Require both" 则变成两个都签才算数。
- 配对码输错五次就不再收，重启服务换一个新码。
- 服务重启后账户又没有 owner，连接也要重新接。想干净地重来，换一个 `--port` 和 `--home`。

## 2 · 接你真的账户

什么都没接时，Accounts 就是一排卡片，按 Exchanges · Brokers · Wallets · Markets and tokens 分组。接上以后，右上 "Connect an account" 打开同一组卡片。点哪张就是哪个的接法，已经接上的写着 "Connected · add another"。银行和卡不在里面：它们没有给个人的接口。

**交易所**（OKX、Kraken、Coinbase、Bybit、Binance，或 "Another exchange" 从统一接口库的一百来家里挑）：

1. 点卡片，弹窗里三步。第一步 "open its API page" 打开交易所自己建 key 的页面，建一把**只读**的 key。
2. 第二步给出它要的文件路径（默认 `~/.buyer-agent-demo/credentials/okx/api-key.json`）和字段（`apiKey`、`secret`，OKX、KuCoin、Bitget 还要建 key 时设的 `password`）。"Copy" 复制路径；"Copy setup command" 复制一条命令：建目录、写一个空模板（文件已经在就不动它）、`chmod 600`、用 `nano` 打开，你把值填进去存盘。
3. 第三步每两秒自己检查一次，只看字段名，不读值：`Waiting for the file…` → `Missing: password.` → `Others on this machine can read it.`（旁边 "Copy fix" 复制 `chmod 600`）→ `Ready.`
4. 点 "Connect"。

```
OKX connected live · $1,000.00 there now · the venue says this credential can read · not bound to an IP · a read-only key · read only: this server was started without real-money writes
```

页面上这一句缩成 "OKX connected · $1,000.00"，后面 "details" 展开是全文。Accounts 多一行：余额是 OKX 自己报的，半分钟读一次；状态是一个小标签（Can move / Read-only / Watched / Read failed）；Details 里是持仓和场所对这把钥匙的说法。

**钱包**（OKX Wallet、Binance Wallet、MetaMask 扩展等）：在装了钱包的浏览器里点 "Browser wallet"，再点你的钱包。钱包先给地址，再签一句话（不是交易，什么都不批准），这个地址就是你的。"Watch an address" 只粘贴地址：能看，既不收也不发真钱。

**Robinhood**：
- 投资账户：卡片 "Robinhood" → "Sign in at Robinhood…"，在 Robinhood 自己的页面登录、批准，回来点 "Connect"。读各账户的现金和股票持仓；令牌只在服务的内存里，重启要重新登录。
- Crypto：在 Robinhood 网页版的 crypto 账户设置里建 API 凭据（你自己生成 Ed25519 密钥对，把公钥交给 Robinhood）。卡片 "Robinhood Crypto" 走和交易所一样的三步，字段是 `apiKey`、`privateKey`（base64 私钥）。
- Stock Tokens：接任何钱包（包括 "Watch an address" 粘贴 Robinhood Wallet 的地址）都会一起读 Robinhood Chain 上的 Stock Tokens。

**其他**：MetaMask Agent Wallet 走本机的 `mm` 命令行（先确认 `mm wallet show` 能用）；Alpaca 和 Kalshi 是钥匙文件（Kalshi 是 `keyId` 加它给的私钥 `.pem` 的路径 `privateKeyFile`）；Hyperliquid、Polymarket、Ondo 填地址。

拔掉点那一行的 "Disconnect"。场所那边的钥匙不动，要删去那边删。Accounts 右上 "Download CSV" 下载每个账户的持仓。

会被拒：钥匙文件不在、权限不是 600、缺字段 `E_ACCOUNT_CREDENTIAL` · 交易所不认这把钥匙 `E_VENUE_UNAUTHORIZED` · 场所不服务这个地区 `E_VENUE_GEOBLOCKED`（Binance、Bybit 从这台机器就是这样，那是它们的规矩）· 没应答 `E_VENUE_UNREACHABLE` · 已经接过同一个 `E_ACCOUNT_BAD_ACTION`（第二个账户在弹窗的 "More options" 里换一个 "Shown as"）。

## 3 · 让一个 agent 进来，给它额度

agent 先敲门：

```bash
seat whoami
```

```
seat "example-seat" · key 0xec4c4c61959f9f09b12683ea8077d10b223816c1
401 ✗ E_ACCOUNT_UNKNOWN_SIGNER · this key is not authorised on the account: the owner lets it in under Agents
```

页面 Agents 里出现一行 "asked to be let in"。点 "Let in…"，钥匙地址进了下面的表单。填名字，勾上它可以在哪几个账户之间动钱，填 Per move、Budget，选期限，点 "Save"。这是两个签名：先放钥匙进来，再给它额度。

```
spending approval: venues every venue on the account now · up to $5 a payment · $20 in all · until Mon 12 Oct
```

- 不填 Budget 只放钥匙进来：没有额度，它一分钱也动不了。
- 改额度：那一行 "Change limit"，表单换成这个 agent，填新的数存下，新的替换旧的。
- 单笔上限、总预算、到期，三样都算。拆成许多小笔也过不了总预算。等批的卡占着它那份预算。
- 全勾上等于「所有账户」，指签字那一刻接上的账户。之后接上的不算，要再存一次点它的名。

MCP 席位同理：它的钥匙由 MCP 客户端的名字派生（环境变量 `PORTFOLIO_AGENT` 可以改名），工具 `portfolio_account` 返回它的地址和有没有被授权。

会被拒：没点名 `E_MANDATE_RECIPIENT` · 超单笔 `E_MANDATE_PER_ORDER_CAP` · 超预算 `E_MANDATE_BUDGET` · 到期 `E_MANDATE_EXPIRED` · 没有额度 `E_MANDATE_NONE`。

## 4 · 选模式：保守还是激进

头部右上两档：

| 模式 | agent 请求动钱时 | 怎么切 |
|---|---|---|
| Conservative（保守，真实账户的默认） | 每一笔都变成一张卡，你签了才走 | 点一下，不用签名 |
| Aggressive（激进） | 额度内直接动，不再问你；超出额度就拒 | 点一下，是 owner 的一次签名 |

两档都一样的：钱只去你自己的地方，每笔不超过 `--live-cap`，场所自己的规矩照旧。Activity 里写着每一笔是 "approved by you" 还是 "inside its limit"。

## 5 · 用真钱

默认关。要打开，用这条命令起服务，终端会打印一个配对码：

```bash
npm run account -- --live-writes --live-cap 5
```

头部右上出现橙色的 "Real money on · $5.00 a move"；没开时那里写 "Read-only"。

1. 输入配对码成为 owner（第 1 条），接上要用的账户（第 2 条）。钱包要从钱包本身接，才能收钱。
2. 账户那一行点 "Move…"：提到你自己的地方、账本之间划转、稳定币互换，或者从钱包发。
3. 填好金额，预览里是**账户替你向目的地要来的地址**、手续费上限、网络。确认没错，点 "Sign and send"。从钱包发的，钱包会再请你确认一次。
4. Activity 里有这一笔，场所或链说到了才算到账。右上 "Download CSV" 下载全部。

标着 "Read-only" 的那一行没有 "Move…"：钥匙只读的交易所，从它那里动不了钱，但它可以收你钱包发来的钱；"Watched" 的钱包只看，既不收也不发。

几条规矩：每笔不超过 `--live-cap`；签名十分钟内有效；执行前再问一次场所，地址或手续费变了就不执行；钱只去交易所自己的充值地址或签过那句话的钱包；第一次提到新地址，多数交易所要你先在它那边加白名单。MetaMask Agent Wallet 发钱还要它自己的开关 `PORTFOLIO_MM_WRITES=1`。

会被拒：服务没开写入 `E_WALLET_LIVE_WRITES_OFF` · 超上限 `E_ACCOUNT_LIMIT` · 目的地不是你的 `E_ACCOUNT_DESTINATION` · 地址或手续费变了 `E_ACCOUNT_REQUOTE` · 签名过期 `E_ACCOUNT_EXPIRED` · 钥匙不许提币 `E_VENUE_PERMISSION` · 地址不在交易所白名单 `E_VENUE_WITHDRAW_WHITELIST`。

**先小后大**：第一次用只读钥匙；要写，先 `--live-cap 5` 走一笔几美元的。

## 6 · agent 请求动真钱

```bash
seat move withdraw okx wallet 5 USDC Arbitrum
seat move transfer okx okx 5 USDT funding trading
seat move swap okx okx 5 USDT USDC
```

MCP 里是 `portfolio_live_move {kind, from, to, asset, network, amount}`。Conservative 下回答是 `202` 和一张卡：卡上是哪个 agent 要动、从哪到哪、多少，展开是账户向目的地要来的地址和场所报的手续费；你签了才走，MCP 的 `portfolio_approval` 告诉 agent 结果。Aggressive 下额度内回答直接是 `200` 和付款单：

```
202 ▣ card-0001 waits for the owner · Example seat asks to move 3 USDT at OKX from trading to funding
200 ✓ pay-0001 · transfer okx → okx · $5 · settled · done at OKX
```

会被拒：钥匙没授权 `401` · 没有额度、没点名、超额 `E_MANDATE_*` · 服务没开写入 `E_WALLET_LIVE_WRITES_OFF` · 场所自己不许 `E_VENUE_*`。在模拟账户里才有的指令（`agentSendAsset`、`agentSwap`、`agentPay`，MCP 的 `portfolio_transfer`、`portfolio_pay`）在这里回 `E_ACCOUNT_BAD_ACTION · this account holds real accounts only`。

## 7 · 批卡、拒卡

净值下面橙色边框的那一行；浏览器标签页的标题带着等你批的张数，比如 "(1) Account"。

- "Details" 展开是你将要签的每个字段，包括目的地址和网络。
- 批准是 owner 的一次签名，写明卡号和这张卡将放行的内容的哈希。放行时所有检查重跑：预算、上限、场所的报价有没有变。
- 卡 30 分钟过期（`E_ACCOUNT_CARD_EXPIRED`）。
- agent 批不了自己的卡（`E_ACCOUNT_OWNER_ONLY`）。

## 8 · 把 agent 停下来

从轻到重：

| 想做的 | 怎么做 |
|---|---|
| 只停这一笔 | 那张卡点 "Reject" |
| 以后每一笔都先问你 | 头部切到 "Conservative"，不用签名 |
| 收紧或收回它的额度 | Agents 里那一行 "Change limit" |
| 停掉这把钥匙 | Agents 里那一行 "Revoke" |

钥匙撤销之后：

```
seat move withdraw okx wallet 5 USDC Arbitrum
401 ✗ E_ACCOUNT_AGENT_REVOKED · the agent key was revoked
```

撤销过的钥匙不能再授权，要换一把新的。

## 9 · 账本当证据

每条被接受的指令连同它的签名信封写进账本，账本是一条哈希链。

```bash
curl -s http://127.0.0.1:4820/api/overview | python3 -c "import json,sys; o=json.load(sys.stdin); print(o['chain'], o['ledgerPath'])"
```

```
{'ok': True, 'rows': 10} /Users/you/.buyer-agent-demo/portfolio/ledger-2026-10-05T03-45-22-552Z.jsonl
```

- 文件在 `$BUYER_HOME/portfolio/`（默认 `~/.buyer-agent-demo`），每次启动一个新文件。
- 账户的状态在内存里：重启之后账户是空的，要重新接，Robinhood 要重新登录。账本文件留着：以前收过的指令，重启之后不会再收第二次。

# 下半 · 模拟账户里的规则

页面上没有下面这些。它们跑在进程里的模拟账户上：八个模拟场所（Alpaca、Binance、OKX、Hyperliquid、MetaMask Agent Wallet、Kalshi、Polymarket、Ondo）、三个模拟收款方（`data.sim`、`infer.sim`、`shop.sim`）和一个可以快进的时钟。`examples/account/headless.ts` 把 owner 和 agent 的指令从头走了一遍；`npm run account:demo` 的十四个 beat 每个放行一件事、拒绝一件事。每条写的是签哪条动作、模拟账户怎么答。

## 10 · 插一个模拟的交易所钱包

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

## 11 · 给 agent 一个 float

owner 签 `createSubAccount {name, agent, float}`，再从链上钱包充进去（`sendAsset` 到 `sub:<name>`）。

float 是 agent 对外付款用的那笔钱，也是一次出错最多能丢的钱。

- 只能从链上钱包（MetaMask Agent Wallet）充，也只能回到那里。
- 充不过上限，在途的补给也算：`E_WALLET_FLOAT_CAP`。
- 只有 owner 能收回（`sendAsset` 从 `sub:<name>` 回 `metamask`）：agent 的钥匙被撤销之后，float 里的钱靠这个拿回来。

## 12 · owner 在模拟场所之间挪钱

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

## 13 · agent 在模拟场所之间挪钱

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

## 14 · agent 付一个 API（x402）

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

## 15 · 按次计费的服务（MPP）

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

## 16 · agent 买东西（AP2）

从 float 付 `https://shop.sim/items/desk-feed-pro`。第一次同样出卡；批准之后商户要 agent 用自己的钥匙签两份 mandate：「这次结账」和「这笔付款」。agent 先拿回商户签过的结账单，核对总价不超过「最多」才签，再发一次：

```
the merchant asks for mandates on checkout co_000002 (29 USD): signing with the seat's key
✓ pay-0010 · pay sub:research → shop.sim · $29 · settled · bought: {"order":{"id":"order_000002", …
```

不写 float 的付款是 `E_PAYEE_UNSUPPORTED · shop.sim is paid in USDC: name the float that pays`：账户上没有卡，卡支付（ACP）没有搭。

## 17 · 付给别人（Send）

1. owner 签 `setDestination {label, address, chain, token}`，把收款人放进地址簿。
2. 等一天（`svc.advance(DAY)`）。
3. owner 签 `sendAsset`，`destination` 是那个地址，`destinationDex` 是它的链。

只有 owner 能签，发出去撤不回。

会被拒：不在地址簿里，或者地址对但链不对 `E_ACCOUNT_DESTINATION` · 还在一天冷静期里 `E_ACCOUNT_DEST_COOLING` · 在黑名单上 `E_WALLET_BLOCKLIST`。

## 18 · Unified：让账户挑来源

owner 签 `userSetAbstraction {abstraction: "unifiedAccount"}`。之后 agent 的 `agentSendAsset` 可以不写来源，账户在授权点名的场所里挑最快到的：

```
✓ pay-0011 · deposit metamask → hyperliquid · $100 · pending
```

Separate 下同一条指令是 `E_ACCOUNT_SOURCE`。

## 19 · 写你自己的 agent 席位

`examples/account/agent-seat.ts` 就是一个完整的席位。要点四个：

1. **一把钥匙**。示例里从名字派生，所以是公开的；真的席位自己生成，放进操作系统的钥匙串。
2. **一个动作**：对真实账户是 `agentLiveMove`；在模拟账户里还有 `agentSendAsset`（挪钱）· `agentSwap`（换币）· `agentPay`（付款）。字段必须恰好是类型里那几个，多一个少一个都是 `E_ACCOUNT_BAD_ACTION`。
3. **nonce 取账户的时钟**：`GET /api/now`，不要取本机时间。资金指令只在它标注的时刻前后十分钟内有效（`E_ACCOUNT_EXPIRED`）。
4. **签名，发出去**：`signAgent(key, action)` 得到 `{action, nonce, signature}`，`POST /api/exchange`。

别的语言要自己实现签名，定义在 `src/portfolio/account/sign.ts`：`AGENT_DOMAIN`、`AGENT_TYPE`、`agentActionHash`。不想起服务，就像 `examples/account/headless.ts` 那样在进程里直接调 `svc.exchange(envelope)`。

## 20 · 加一种连接器

真实连接在 `src/portfolio/live/index.ts` 里一种一个（交易所走统一接口库，其他各有各的）。模拟的连接器，统一接口库覆盖的交易所不用加：在目录里写 `"connector": "unified"`（第 10 条）。一家交易所有自己的请求格式、想让账本里记下它原生的请求时，才加一份声明：

1. `src/portfolio/account/doors.ts` 的 `EXCHANGES` 加一项：`label`、`credential`、`probe`（问钥匙权限的那个调用）、`deposit`、`withdraw`、`convert`、`inside`（它内部的账本之间怎么挪）。
2. 同一个文件的 `nativeRequest` 里加一个分支，把一腿写成它自己的请求。
3. `test/unit/account-connect.test.ts` 里照着已有的加一条。

## 21 · 攻击它

```bash
npx vitest run test/attack
```

十九个文件，每个是一次真实跑通过的攻击，写成 `it.fails`：测试断言「攻击成功」，并被期望失败。哪天攻击又能成功，这个测试就报错。

找到新洞时照这个顺序：先写成一个普通测试，让它通过，证明洞是真的；修；把 `it` 改成 `it.fails`；再在 `test/unit/` 里加一条正面的回归测试。

## 出了状况先看这里

| 现象 | 原因 |
|---|---|
| `npm run account` 报 `port 4820 is already in use` | 已经有一个在跑了，直接打开页面。要第二个就加 `--port 4821 --home 〈另一个目录〉` |
| 页面按钮全灰，顶上一行 "can look but not sign" | 你不是 owner，见第 1 条 |
| 钥匙文件那一步一直 "Waiting for the file…" | 路径不对，或者文件还没存盘。复制弹窗里的路径或那条命令 |
| 席位一直 `401` | 钥匙没授权、过期或被撤销，见第 3、8 条 |
| `this account holds real accounts only` | 这条指令只动模拟的钱。真钱走 `liveMove` / `agentLiveMove`，见第 5、6 条 |
| `E_ACCOUNT_EXPIRED` | nonce 用了本机时间。取 `GET /api/now` |
| `E_ACCOUNT_NONCE` | 这条指令收过了。同一条重发拿到的是第一次的结果，改了内容要换 nonce |
| 刚接上的账户 agent 用不了 | 它不在旧额度里，见第 3 条 |
| agent 的请求没有出卡就动了 | 模式是 Aggressive，见第 4 条 |
| 重启之后什么都没了 | 状态在内存里，连接要重新接。账本文件还在 |

## 拒绝码速查

| 码 | 意思 |
|---|---|
| `E_ACCOUNT_UNKNOWN_SIGNER` · `E_ACCOUNT_AGENT_EXPIRED` · `E_ACCOUNT_AGENT_REVOKED` | 这把钥匙不是（或不再是）签名人 |
| `E_ACCOUNT_BAD_SIGNATURE` · `E_ACCOUNT_BAD_ACTION` | 签名对不上，或者动作的字段不是签名覆盖的那些；在只认真实账户的服务器上，也是只动模拟钱的指令 |
| `E_ACCOUNT_NONCE` · `E_ACCOUNT_EXPIRED` | 用过的 nonce，或者离标注的时刻超过十分钟 |
| `E_ACCOUNT_OWNER_ONLY` | 这件事只有 owner 能签：提现、Send、授权、批卡、收回 float |
| `E_ACCOUNT_NOT_HOME` | agent 想把钱送到你自己的场所之外 |
| `E_ACCOUNT_SOURCE` | 没写来源而账户是 Separate；或者动了别人的 float |
| `E_ACCOUNT_DESTINATION` · `E_ACCOUNT_DEST_COOLING` | 目的地不是你的、不在地址簿、链不对，或者还在冷静期 |
| `E_ACCOUNT_REQUOTE` · `E_ACCOUNT_CARD_EXPIRED` | 签过之后报价变了；卡过期了 |
| `E_ACCOUNT_FEE_CAP` · `E_ACCOUNT_THRESHOLD` · `E_ACCOUNT_UNPRICED` | 应用抽成高于你批的费率；签名人不够；这个币没有价格，没法判额度 |
| `E_ACCOUNT_LIMIT` · `E_ACCOUNT_OWNER_SURFACE` | 超过账户自己的上限（含 `--live-cap`）；一个没签名的请求打到了只认 owner 设备的接口上，或配对码不对 |
| `E_MANDATE_NONE` · `E_MANDATE_RECIPIENT` · `E_MANDATE_PER_ORDER_CAP` · `E_MANDATE_BUDGET` · `E_MANDATE_RATE` · `E_MANDATE_EXPIRED` | 支出授权的线：没有授权、没点名、超单笔、超预算、太频繁、到期 |
| `E_MANDATE_INVALID` | AP2 的 mandate 验不过 |
| `E_PAYEE_OVERCHARGE` · `E_PAYEE_CHANGED` · `E_PAYEE_REDIRECT` · `E_PAYEE_UNVERIFIED` · `E_PAYEE_REJECTED` · `E_PAYEE_UNSUPPORTED` | 收款方那边的线：加价、换地址、重定向、验不过、不收、说的协议账户不会 |
| `E_VENUE_RAIL_CLOSED` · `E_VENUE_MIN_DEPOSIT` · `E_VENUE_WITHDRAW_WHITELIST` · `E_VENUE_PERMISSION` | 场所自己的线：这扇门不对你开、低于最低额、地址不在白名单、钥匙不许 |
| `E_WALLET_FLOAT_CAP` · `E_WALLET_INSUFFICIENT` · `E_WALLET_BLOCKLIST` | float 满了、不够，或者地址在黑名单上 |
| `E_ACCOUNT_CREDENTIAL` · `E_VENUE_UNREACHABLE` · `E_VENUE_GEOBLOCKED` · `E_VENUE_UNAUTHORIZED` | 真实连接：钥匙文件不能用、场所没应答、场所不服务这个地区、场所不认这把钥匙 |
| `E_WALLET_LIVE_WRITES_OFF` | 这个服务不动真钱（没用 `--live-writes` 起），或者 MetaMask 自己的开关没开 |
