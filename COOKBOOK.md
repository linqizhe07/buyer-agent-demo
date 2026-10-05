# Account Cookbook

README 的「Account：资金的机场」讲这一层**是什么**，这里讲**怎么做**。每条做法写的是：想做什么、怎么做、会看到什么、什么会被拒。命令可以直接跑；贴出来的输出是 2026-10-05 实际跑出来的。

场所、收款方、钥匙全部是本地模拟，没有一步联系真的对方。钥匙从源码里的标签派生，是公开的。

## 三个角色，一个入口

- **owner**：钱的主人。页面上是浏览器里一把导不出来的设备钥匙，第一个打开 `/account` 的浏览器就是 owner。脚本和测试里是一把从标签派生的钱包钥匙。
- **agent**：一把钥匙。owner 授权之后，它能在 owner 自己的场所之间挪钱、换稳定币、在额度内替 owner 付款。别的都不能。
- **account**：跑着的服务。它验签、查额度、规划路线，并且替 agent 去跟收款方说话。agent 拿不到任何场所的凭据，也拿不到 float 的钥匙。

所有改动走同一个入口：一条签了名的指令，`POST /api/exchange`。回答只有四种：

| 状态 | 意思 |
|---|---|
| `200` | 做了。划转和付款返回一张付款单，可能还在途 |
| `202` | 先问 owner：页面顶上出现一张卡 |
| `401` | 这把钥匙不是签名人（没授权、过期、被撤销） |
| `409` | 拒绝，带一个说明越了哪条线的码（文末有速查） |

## 0 · 怎么跑

| 想要 | 命令 |
|---|---|
| 看页面，自己点 | `npm run portfolio`，打开 <http://127.0.0.1:4820/account> |
| 一个脚本从头走到尾，不起服务、不开浏览器 | `npx tsx examples/account/headless.ts` |
| 扮演一个 agent，对跑着的服务发指令 | `npx tsx examples/account/agent-seat.ts whoami` |
| 让 Claude Code、Codex 这类 agent 来当 agent | `claude mcp add portfolio -- npx tsx src/portfolio/mcp.ts` |
| 十四个 beat 的断言脚本 | `npm run account:demo` |

`npm run portfolio -- --port 4821 --home /tmp/x` 另起一个互不相干的实例。`--classic` 回到原来的八个账户，不挂这一层。

下面默认 `npm run portfolio` 在跑。「页面」指 `/account`。`seat` 是这个别名：

```bash
alias seat='npx tsx examples/account/agent-seat.ts'
```

## 1 · 成为 owner

打开页面就是了：第一个打开 `/account` 的浏览器成为 owner，Signers 页签里那一行写着 "Device key · this browser"。

- 不是 owner 时，页面顶上有一行 "This browser is not a signer of this account yet."，按钮都是灰的。让 owner 的浏览器在 Signers 页签点 "Let it sign too"。点 "Require both" 则变成两个都签才算数。
- 服务重启后账户又没有 owner，下一个来问的页面（包括任何一个还开着的旧标签页）成为 owner。想干净地重来，换一个 `--port` 和 `--home`。

## 2 · 把一个交易所钱包插进来

Balances 页签底部 "Plug one in…"，选场所，点 "Plug in"。一次签名，不改代码。

```
Kraken plugged in · the venue says this credential can read, trade, withdraw · withdrawals only to its verified addresses (metamask) · money in: an agent's key may; money out: an agent's key may
```

Balances 多一行，Runways 多一组跑道。门是照这把钥匙的权限生成的：

| 目录里的 | 连接器 | 钥匙能做什么 | 钱出去那扇门 |
|---|---|---|---|
| Bybit | `unified` | 读、交易 | At Bybit：只能在交易所那边发起 |
| Kraken | `unified` | 读、交易、提币，白名单里只有自己的链上钱包 | agent 可用 |
| OKX · second account | `okx` | 只读 | At the venue；换币关着 |
| OKX Wallet | `wallet`（按地址，不交钥匙） | 读 | Yours to sign：在那个钱包里签 |

**加一个你自己的，不写代码**：往 `fixtures/home/portfolio/connectable.json` 加一项，重启服务，它就出现在 "Plug one in…" 里。

```json
"gate":   { "name": "Gate", "connector": "unified", "balances": { "USDT": 500 }, "key": { "permissions": ["read", "trade"] } },
"ledger": { "name": "Ledger Nano", "connector": "wallet", "address": "0x1ed6…nano", "holdings": [{ "asset": "USDC", "amount": 300, "chain": "Base" }] }
```

这份文件是模拟里「场所那一侧」：它有多少钱，它说这把钥匙能做什么。`permissions` 里有没有 `withdraw`、有没有 `whitelist`，决定出金那扇门开给谁。

注意三件事：

- 新插上的场所**不在任何旧授权里**。要 agent 能用它，在一份授权里点它的名（第 4 条）。
- 拔掉点那一行的 "Unplug"。有钱在途时拔不掉：`Kraken has a payment in flight (pay-0001): it can be unplugged when that has landed`。
- 页面收的是凭据**放在哪**，不收凭据本身。

会被拒：已经在账户上 `E_ACCOUNT_BAD_ACTION` · 目录里没有 `E_WALLET_ACCOUNT_UNKNOWN` · 连接器不对 `E_VENUE_REJECTED`。

## 3 · 让一个 agent 进来

agent 先敲门，owner 再开门。

```bash
seat whoami
```

```
seat "example-seat" · key 0xec4c4c61959f9f09b12683ea8077d10b223816c1
401 ✗ E_ACCOUNT_UNKNOWN_SIGNER · this key is not authorised on the account: the owner authorises it under Agent keys
```

页面的 Agent keys 页签出现一行 "Asking to be let in"。点 "Authorize…"，填名字，选有效期，点 "Authorize key"。再问一次：

```
authorised as "Example seat" until 2026-11-04T04:13:38.567Z
```

授权钥匙只是让它进门。没有额度，它一分钱也动不了。

MCP 席位同理：它的钥匙由 MCP 客户端的名字派生（环境变量 `PORTFOLIO_AGENT` 可以改名），工具 `portfolio_account` 返回它的地址和有没有被授权。

## 4 · 给它额度

Approvals 页签的表单：Agent · May · Where · Per payment · Budget · Refill every · For，点 "Approve"。

| May | Where 写什么 | 管的是 |
|---|---|---|
| move between venues | 场所的 id：`okx, hyperliquid, metamask` | 在你自己的场所之间挪钱、换币 |
| pay | 收款方的 host：`data.sim, infer.sim, shop.sim` | 对外付款 |

```
spending approval: venues okx,hyperliquid,metamask · up to $500 a payment · $2000 in all · until Mon 12 Oct
```

- 单笔上限、总预算、到期，三样都算。拆成许多小笔也过不了总预算。
- 等批的卡和 session 的押金占着预算，表里那行 "set aside" 就是它们。
- 同一个范围再签一份，新的替换旧的。"Revoke" 就是把预算签成 0。
- Where 写 `*` 是「所有场所」，指签字那一刻有的场所。之后插上的不算。

会被拒：没点名 `E_MANDATE_RECIPIENT` · 超单笔 `E_MANDATE_PER_ORDER_CAP` · 超预算 `E_MANDATE_BUDGET` · 太频繁 `E_MANDATE_RATE` · 到期 `E_MANDATE_EXPIRED` · 没有授权 `E_MANDATE_NONE`。

## 5 · 给它一个 float

Sub-accounts 页签：Name · Agent · Float up to，点 "Create"。然后 "Top up…" 从链上钱包充进去。

float 是 agent 对外付款用的那笔钱，也是一次出错最多能丢的钱。

- 只能从链上钱包（MetaMask Agent Wallet）充，也只能回到那里。
- 充不过上限，在途的补给也算：`E_WALLET_FLOAT_CAP`。
- 收回点 "Bring back…"。只有 owner 能收回：agent 的钥匙被撤销之后，float 里的钱就靠这个按钮拿回来。

## 6 · owner 挪钱：Deposit、Withdraw、Transfer

右上的按钮。选 From 和 To，填金额，先看到路线、费用、到账时间，再签。你签的不只是「挪多少」，还有这条路线的哈希、最高费用、最晚到账：报价变了就要重签（`E_ACCOUNT_REQUOTE`）。

| 例子 | 预览里写的 | 按钮 |
|---|---|---|
| MetaMask → Hyperliquid · perps，$500 | Arrives $499.78 · fee $0.22 · lands ~1 min | Deposit |
| OKX → Hyperliquid · perps，$400 | Arrives $398.94 · fee $1.06 · lands ~6 min · swap at OKX → out of OKX → out of MetaMask Agent Wallet → into Hyperliquid | Transfer |
| Hyperliquid perps → spot，$100 | Arrives $100.00 · fee $0.00 · lands now · inside Hyperliquid | Transfer |
| Hyperliquid → MetaMask，$200 | Arrives $199.77 · fee $0.23 · lands ~5 min | Withdraw |
| Chase → Alpaca，$1,000 | lands Tue 6 Oct · Only you can start this, at Alpaca · An ACH is not final: the bank can still return it | Start at Alpaca |
| OKX Wallet → Hyperliquid，$200 | OKX Wallet keeps its own key: you sign this one in that wallet | Sign in OKX Wallet |
| MetaMask → Hyperliquid，$3 | Hyperliquid takes no deposit under $5: $2.78 would arrive after $0.22 in fees, so nothing is sent | 灰的 |
| Bybit → MetaMask | Bybit: this key has no withdraw permission，下面写着怎么开这扇门 | 灰的 |

**在途**：钱离开一处、还没到下一处时，Payments 页签写 "In flight · lands 10:07"。这笔钱不在任何余额里，谁也花不了。

**时钟**：页脚 "simulated clock +1 hour · +1 day · +3 days" 快进，看在途的钱到账。到了账的 ACH 那一行有 "simulate the bank returning it"，点了看它被退回、冲账。

## 7 · agent 自己挪钱

```bash
seat transfer okx hyperliquid 300
seat swap okx USDT USDC 200
```

```
200 ✓ pay-0002 · transfer okx → hyperliquid · $300 · pending
200 ✓ pay-0003 · swap okx → okx · $200 · settled
```

MCP 里是 `portfolio_transfer {from, to, amount}`。`from` 和 `to` 只能是你自己的场所：`okx`、`hyperliquid:perps`、`metamask`、`sub:research`。

会被拒，都是设计好的：

```
seat transfer hyperliquid metamask 50
409 ✗ E_ACCOUNT_OWNER_ONLY · Hyperliquid: only the master account's signature can withdraw

seat transfer binance metamask 50
409 ✗ E_VENUE_RAIL_CLOSED · Binance: this key has no withdraw permission
```

往外面的地址转是 `E_ACCOUNT_NOT_HOME`：agent 的钥匙只能让钱回家。

## 8 · agent 付一个 API（x402）

```bash
seat pay "https://data.sim/v1/quote?symbol=NVDA" 0.05 research
```

三个参数：付什么、这一次最多花多少、从哪个 float 出。agent 不知道也不用知道对方说哪种协议，那是账户的事。

**第一次**付给一个收款方，先问 owner：

```
202 ▣ card-0001 waits for the owner · a first payment to data.sim: $0.01 to 0xe0077e…d421 over x402 · EIP-3009 (Base Sepolia). Approving it pins that address for data.sim
```

页面顶上出现这张卡。展开 "What this approval covers" 是你将要签的每个字段，点 "Approve"。批准之后这个地址就钉住了，同一个收款方以后不再问：

```
200 ✓ pay-0008 · pay sub:research → data.sim · $0.01 · settled · bought: {"symbol":"NVDA","price":150.12,"currency":"USD","delayedMin":15}
```

会被拒：

| 码 | 发生了什么 |
|---|---|
| `E_MANDATE_RECIPIENT` | 这个 host 不在授权里。连一个字节都不会发给它 |
| `E_PAYEE_OVERCHARGE` | 对方要价高于你说的「最多」 |
| `E_PAYEE_CHANGED` | 对方的收款地址和钉住的不一样。这就是攻击的样子，告诉用户 |
| `E_PAYEE_REDIRECT` | 对方想把请求引到别处，不跟 |
| `E_PAYEE_UNVERIFIED` | 对方的质询或回执验不过 |
| `E_WALLET_INSUFFICIENT` | float 不够 |

## 9 · 按次计费的服务（MPP）

一次一付：

```bash
seat pay https://infer.sim/v1/answers 0.05 research
```

会话：存一次押金，之后每次调用签一张累计凭单。第一次的卡上写明押金：

```bash
seat pay https://infer.sim/v1/stream 0.05 research
```

```
202 ▣ card-0003 waits for the owner · a first payment to infer.sim: $0.01 a call, from a deposit of up to $0.50 locked in escrow 0x4157b8…9bae, to 0x30f67e…4378 over MPP session · escrow + vouchers (Base Sepolia). Approving it pins that address for infer.sim
```

批准之后每调一次：

```
200 ✓ pay-0006 · pay sub:research → infer.sim · $0.5 · pending · 2 calls · $0.02 of a $0.50 deposit used · bought: {"chunk":"answer 2","model":"sim-1"}
```

用完了关掉，没花的押金回 float：

```bash
seat pay https://infer.sim/v1/stream 0.05 research close
```

```
200 ✓ pay-0006 · pay sub:research → infer.sim · $0.02 · settled · session closed: $0.02 paid for 2 calls, $0.48 back in float "research"
```

- owner 也能关：Approvals 页签 → Payment sessions → "Close"。agent 的钥匙被撤销之后只有这条路。
- 押金在托管合约里时，页面顶上写 "held in a session's escrow"，它占着预算。
- 收款方不理：账户直接向托管合约申请退出，宽限期（15 分钟）过后钱自己回来。

## 10 · agent 买东西

走卡（ACP）：

```bash
seat pay https://shop.sim/items/desk-feed-pro 30 card
```

```
202 ▣ card-0004 waits for the owner · a first payment to shop.sim: $29.00 to merchant_shop_sim via psp.sim over ACP · delegated card token (card). Approving it pins that merchant and processor for shop.sim
```

批准之后：`pay-0009 · mastercard → shop.sim · $29 · settled`。商户拿到的是一枚只对这次结账、这个金额、一次有效的令牌，看不到卡。

从 float 付（AP2）：

```bash
seat pay https://shop.sim/items/desk-feed-pro 30 research
```

第一次同样出卡。float 和卡各钉各的收款方，所以走过卡也还要再批一次。批准之后**同一条命令再跑一次**：

```
the merchant asks for mandates on checkout co_000002 (29 USD): signing with the seat's key
200 ✓ pay-0010 · pay sub:research → shop.sim · $29 · settled · bought: {"order":{"id":"order_000002", …
```

AP2 要 agent 用自己的钥匙签两份 mandate：「这次结账」和「这笔付款」。席位先拿回商户签过的结账单，核对总价不超过「最多」才签。以后再买，一条命令里两步连着做完。

## 11 · 批卡、拒卡

页面顶上橙色边框的那一行。

- "What this approval covers" 展开是你将要签的每个字段，包括收款地址和链。
- 批准是 owner 的一次签名，写明卡号和这张卡将放行的内容的哈希。放行时所有检查重跑：预算、频率、报价有没有变。
- 卡 30 分钟过期（`E_ACCOUNT_CARD_EXPIRED`）。
- agent 批不了自己的卡（`E_ACCOUNT_OWNER_ONLY`）。

脚本里是 `approveCard {card, action: cardHash(card), decision}`，见 `examples/account/headless.ts` 的 `approve`。

## 12 · 付给别人（Send）

1. Signers 页签 → Address book：Recipient · Address · Chain · Token，点 "Add recipient"。
2. 等一天。表里写着 "From 〈日期〉"。演示时点页脚的 "+1 day"。
3. 右上 "Send"：To · From · Amount。

只有 owner 能签，发出去撤不回。

会被拒：不在地址簿里，或者地址对但链不对 `E_ACCOUNT_DESTINATION` · 还在一天冷静期里 `E_ACCOUNT_DEST_COOLING` · 在黑名单上 `E_WALLET_BLOCKLIST`。

## 13 · Unified：让账户挑来源

页面上 "Separate | Unified" 切到 Unified。之后 agent 可以不写来源，账户在授权点名的场所里挑最快到的：

```bash
seat transfer "" hyperliquid 100
```

```
200 ✓ pay-0011 · deposit metamask → hyperliquid · $100 · pending
```

Separate 下同一条命令是 `E_ACCOUNT_SOURCE`。

## 14 · 把 agent 停下来

从轻到重：

| 想做的 | 怎么做 |
|---|---|
| 只停这一笔 | 那张卡点 "Reject" |
| 收回它的额度 | Approvals 页签，那一行 "Revoke" |
| 关掉开着的会话 | Approvals 页签 → Payment sessions → "Close" |
| 把 float 拿回来 | Sub-accounts 页签 → "Bring back…" |
| 停掉这把钥匙 | Agent keys 页签 → "Revoke" |
| 全部收紧 | 右上切到 "Guard"。收紧不用签名，放宽才要 |

钥匙撤销之后：

```
seat transfer okx hyperliquid 10
401 ✗ E_ACCOUNT_AGENT_REVOKED · the agent key was revoked
```

撤销过的钥匙不能再授权，要换一把新的。

## 15 · 账本当证据

每条被接受的指令连同它的签名信封写进账本，账本是一条哈希链。

```bash
curl -s http://127.0.0.1:4820/api/overview | python3 -c "import json,sys; o=json.load(sys.stdin); print(o['chain'], o['ledgerPath'])"
```

```
{'ok': True, 'rows': 10} /Users/you/.buyer-agent-demo/portfolio/ledger-2026-10-05T03-45-22-552Z.jsonl
```

- 文件在 `$BUYER_HOME/portfolio/`（默认 `~/.buyer-agent-demo`），每次启动一个新文件。
- 账户的状态在内存里，重启后从种子重来。账本文件留着：以前收过的指令，重启之后不会再收第二次。
- `npm run account:demo` 的第 14 个 beat 演示了三件事：从文件里恢复出每一行的签名人；改掉一行，链在那一行断开；账户的付款单和场所自己的流水对账，对不上的写成一行差异。

## 16 · 写你自己的 agent 席位

`examples/account/agent-seat.ts` 就是一个完整的席位，不到八十行。要点四个：

1. **一把钥匙**。示例里从名字派生，所以是公开的；真的席位自己生成，放进操作系统的钥匙串。
2. **一个动作**：`agentSendAsset`（挪钱）· `agentSwap`（换币）· `agentPay`（付款）。字段必须恰好是类型里那几个，多一个少一个都是 `E_ACCOUNT_BAD_ACTION`。
3. **nonce 取账户的时钟**：`GET /api/now`，不要取本机时间。模拟时钟被快进之后两者不一样，而资金指令只在它标注的时刻前后十分钟内有效（`E_ACCOUNT_EXPIRED`）。
4. **签名，发出去**：`signAgent(key, action)` 得到 `{action, nonce, signature}`，`POST /api/exchange`。

别的语言要自己实现签名，定义在 `src/portfolio/account/sign.ts`：`AGENT_DOMAIN`、`AGENT_TYPE`、`agentActionHash`。

不想起服务，就在进程里直接调：`examples/account/headless.ts` 用 `svc.exchange(envelope)` 把 owner 和 agent 的指令从头走了一遍。

## 17 · 加一种连接器

统一接口库覆盖的交易所不用加：在目录里写 `"connector": "unified"`（第 2 条）。

一家交易所有自己的请求格式、想让账本里记下它原生的请求时，才加一份声明：

1. `src/portfolio/account/doors.ts` 的 `EXCHANGES` 加一项：`label`、`credential`、`probe`（问钥匙权限的那个调用）、`deposit`、`withdraw`、`convert`、`inside`（它内部的账本之间怎么挪）。
2. 同一个文件的 `nativeRequest` 里加一个分支，把一腿写成它自己的请求。
3. `test/unit/account-connect.test.ts` 里照着已有的加一条。

## 18 · 攻击它

```bash
npx vitest run test/attack
```

二十个文件，每个是一次真实跑通过的攻击，写成 `it.fails`：测试断言「攻击成功」，并被期望失败。哪天攻击又能成功，这个测试就报错。

找到新洞时照这个顺序：先写成一个普通测试，让它通过，证明洞是真的；修；把 `it` 改成 `it.fails`；再在 `test/unit/` 里加一条正面的回归测试。

## 19 · 接你真的账户

前面 18 条都是模拟的钱。这一条接你真的场所，默认只读。

**交易所账户**（OKX、Kraken、Coinbase 等）：

1. 在交易所建一把**只读**的 API key。
2. 存成 `~/.buyer-agent-demo/credentials/okx/api-key.json`：`{"apiKey": "…", "secret": "…", "password": "…"}`。`password` 是 OKX、KuCoin、Bitget 建 key 时设的口令，别家不用。
3. `chmod 600` 这个文件。
4. 页面 Balances 页签，OKX 那一行点 "Connect"，点 "Connect, read-only"。

```
OKX connected live · $1,000.00 there now · the venue says this credential can read · not bound to an IP · a read-only key · read only: this server was started without real-money writes · it stands in for the simulated one until it is unplugged
```

那一行出现 LIVE，余额是 OKX 自己报的，半分钟读一次。"Disconnect" 拔掉后模拟的 OKX 回来。不在表里的交易所，点底下的 "Connect a real venue…"，从列表里挑。

**钱包**（OKX Wallet、Binance Wallet、MetaMask 扩展等）：在装了钱包的浏览器里打开页面，"Connect a real venue…" → Wallet，点你的钱包。钱包先给地址，再签一句话（不是交易，什么都不批准），这个地址就是"proven yours"。只粘贴地址的是"watched"：能看，不能收真钱。

**其他**：MetaMask Agent Wallet 走本机的 `mm` 命令行（先确认 `mm wallet show` 能用）；Alpaca 和 Kalshi 用钥匙文件（Kalshi 是 key id 加它给的私钥 `.pem`）；Hyperliquid、Polymarket、Ondo 填地址。

会被拒：钥匙文件不在、权限不是 600、缺字段 `E_ACCOUNT_CREDENTIAL` · 交易所不认这把钥匙 `E_VENUE_UNAUTHORIZED` · 场所不服务这个地区 `E_VENUE_GEOBLOCKED`（Binance、Bybit 从这台机器就是这样，那是它们的规矩）· 没应答 `E_VENUE_UNREACHABLE`。

## 20 · 用真钱

默认关。要打开，用这条命令起服务，终端会打印一个配对码：

```bash
npm run portfolio -- --live-writes --live-cap 50
```

1. 打开页面，输入终端里的配对码，这个浏览器才成为 owner。
2. 接上要用的场所（第 19 条）。钱包要从钱包本身接，才能收钱。
3. 场所那一行点 "Move…"：提到你自己的地方、账本之间划转、稳定币互换，或者从钱包发。
4. 填好金额，预览里是**账户替你向目的地要来的地址**、手续费上限、网络。确认没错，点 "Sign and send"。从钱包发的，钱包会再请你确认一次。
5. Payments 页签里这一笔标着 LIVE，场所或链说到了才算到账。

几条规矩：每笔不超过 `--live-cap`；签名十分钟内有效；执行前再问一次场所，地址或手续费变了就不执行；钱只去交易所自己的充值地址或签过那句话的钱包；第一次提到新地址，多数交易所要你先在它那边加白名单。

agent 只能请求：MCP 的 `portfolio_live_move`，每次都是一张卡，卡上是地址和手续费，你签了才走。MetaMask Agent Wallet 发钱还要它自己的开关 `PORTFOLIO_MM_WRITES=1`。

会被拒：服务没开写入 `E_WALLET_LIVE_WRITES_OFF` · 超上限 `E_ACCOUNT_LIMIT` · 目的地不是你的 `E_ACCOUNT_DESTINATION` · 地址或手续费变了 `E_ACCOUNT_REQUOTE` · 签名过期 `E_ACCOUNT_EXPIRED` · 钥匙不许提币 `E_VENUE_PERMISSION` · 地址不在交易所白名单 `E_VENUE_WITHDRAW_WHITELIST`。

**先小后大**：第一次用只读钥匙；要写，先 `--live-cap 5` 走一笔几美元的。

## 出了状况先看这里

| 现象 | 原因 |
|---|---|
| `npm run portfolio` 报 `port 4820 is already in use` | 已经有一个在跑了，直接打开页面。要第二个就加 `--port 4821 --home 〈另一个目录〉` |
| 页面按钮全灰，顶上一行 "not a signer" | 你不是 owner，见第 1 条 |
| 席位一直 `401` | 钥匙没授权、过期或被撤销，见第 3、14 条 |
| `E_ACCOUNT_EXPIRED` | nonce 用了本机时间。取 `GET /api/now` |
| `E_ACCOUNT_NONCE` | 这条指令收过了。同一条重发拿到的是第一次的结果，改了内容要换 nonce |
| 钱「不见了」 | 在途。看 Payments 页签，或者快进时钟 |
| 刚插上的场所 agent 用不了 | 它不在旧授权里，见第 4 条 |
| 重启之后什么都没了 | 状态在内存里，每次从种子开始。账本文件还在 |

## 拒绝码速查

| 码 | 意思 |
|---|---|
| `E_ACCOUNT_UNKNOWN_SIGNER` · `E_ACCOUNT_AGENT_EXPIRED` · `E_ACCOUNT_AGENT_REVOKED` | 这把钥匙不是（或不再是）签名人 |
| `E_ACCOUNT_BAD_SIGNATURE` · `E_ACCOUNT_BAD_ACTION` | 签名对不上，或者动作的字段不是签名覆盖的那些 |
| `E_ACCOUNT_NONCE` · `E_ACCOUNT_EXPIRED` | 用过的 nonce，或者离标注的时刻超过十分钟 |
| `E_ACCOUNT_OWNER_ONLY` | 这件事只有 owner 能签：提现、Send、授权、批卡、收回 float |
| `E_ACCOUNT_NOT_HOME` | agent 想把钱送到你自己的场所之外 |
| `E_ACCOUNT_SOURCE` | 没写来源而账户是 Separate；或者动了别人的 float |
| `E_ACCOUNT_DESTINATION` · `E_ACCOUNT_DEST_COOLING` | 收款人不在地址簿、链不对，或者还在冷静期 |
| `E_ACCOUNT_REQUOTE` · `E_ACCOUNT_CARD_EXPIRED` | 签过之后报价变了；卡过期了 |
| `E_ACCOUNT_FEE_CAP` · `E_ACCOUNT_THRESHOLD` · `E_ACCOUNT_UNPRICED` | 应用抽成高于你批的费率；签名人不够；这个币没有价格，没法判额度 |
| `E_ACCOUNT_LIMIT` · `E_ACCOUNT_OWNER_SURFACE` | 超过账户自己的上限；一个没签名的请求打到了只认 owner 设备的接口上 |
| `E_MANDATE_NONE` · `E_MANDATE_RECIPIENT` · `E_MANDATE_PER_ORDER_CAP` · `E_MANDATE_BUDGET` · `E_MANDATE_RATE` · `E_MANDATE_EXPIRED` | 支出授权的线：没有授权、没点名、超单笔、超预算、太频繁、到期 |
| `E_MANDATE_INVALID` | AP2 的 mandate 验不过 |
| `E_PAYEE_OVERCHARGE` · `E_PAYEE_CHANGED` · `E_PAYEE_REDIRECT` · `E_PAYEE_UNVERIFIED` · `E_PAYEE_REJECTED` · `E_PAYEE_UNSUPPORTED` | 收款方那边的线：加价、换地址、重定向、验不过、不收、说的协议账户不会 |
| `E_VENUE_RAIL_CLOSED` · `E_VENUE_MIN_DEPOSIT` · `E_VENUE_WITHDRAW_WHITELIST` · `E_VENUE_UNSETTLED` | 场所自己的线：这扇门不对你开、低于最低额、地址不在白名单、钱还没结算 |
| `E_WALLET_FLOAT_CAP` · `E_WALLET_INSUFFICIENT` · `E_WALLET_BLOCKLIST` | float 满了、不够，或者地址在黑名单上 |
| `E_ACCOUNT_CREDENTIAL` · `E_VENUE_UNREACHABLE` · `E_VENUE_GEOBLOCKED` · `E_VENUE_UNAUTHORIZED` | 真实连接：钥匙文件不能用、场所没应答、场所不服务这个地区、场所不认这把钥匙 |
| `E_WALLET_LIVE_WRITES_OFF` | 这个服务不动真钱（没用 `--live-writes` 起），或者 MetaMask 自己的开关没开 |
