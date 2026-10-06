import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recoverTypedDataAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, describe, expect, it } from "vitest";
import { isRefusal, type Refusal } from "../../src/core/errors.ts";
import type { ChainReader } from "../../src/portfolio/live/chain.ts";
import { KEY_SHAPES, keyFileStatus, liveOptions, openLive, type LiveDeps } from "../../src/portfolio/live/index.ts";
import { polyHmac, polymarketTradeSource } from "../../src/portfolio/live/polymarket-clob.ts";
import { inDollars, type LiveTrader, type OrderRequest, type OrderState } from "../../src/portfolio/live/trade.ts";
import type { Http, HttpReply, LiveBalance, LiveSource } from "../../src/portfolio/live/types.ts";

/** TRADING at Polymarket's CLOB, against stand-ins for the CLOB, Gamma, the Data API and polymarket.com's location check that record every
 * request and answer what each test says. Nothing leaves the process.
 *
 * The signing tests use Hardhat's published test account #0 — the key the spec's vectors were computed with (it ships with every Hardhat and
 * Foundry install and is no one's account) — so that the signatures and HMACs can be matched byte for byte. Everything else uses a key
 * generated in the test. The CLOB credentials are made up. */
const HARDHAT_0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const EOA = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
/** the docs' example wallet address, used here only as a value */
const WALLET = "0x2e234DAe75C793f67A35089C9d99245E1C58470b";
const TS_MS = 1791225442000;
const SALT = 479249096354;
const API_KEY = "7b1e2d60-6f9a-4dd7-8f3e-21b8f94c77a2";
const SECRET = "ABEiM0RVZneImaq7zN3u_wARIjNEVWZ3iJmqu8zd7v8=";
const PASSPHRASE = "made-up-passphrase-0001";
const CLIENT_ID = "0123456789abcdef0123456789abcdef";

/** the spec's vectors (trade-specs/pm-src/vectors.json), computed offline with viem from Hardhat key #0 and checked against clob-client-v2 */
const V = {
  clobAuthSig: "0x8b138927a3ad1f4b5881549434577426f2ab502d71f7b9fc09a50eebaf18c85d6d9bc931917ae62ea4d9dcb607eea5596ad60adc3a079d8107df837ba6c13eb31b",
  eoaOrderHash: "0x9479dacaa27feff18ace32f36675f69181fa3712044de73df1f9978c23a5c2f5",
  eoaOrderSig: "0x86df27f9964d504233714a6c8c2d995e6e178fe797793efd6b0bee517dc29a912148f6842f90ac978f63e7068cbc6a213a231777183163bc78f212659bb8ad901c",
  negRiskOrderSig: "0x99b07916e86fd4447c17b910d47db1dd04bb04f2265b3ae51995ea4c7e61c00f5629144e01ec756e4298218a7df6f8c38c82a19fef8eb150c50a52804a10039e1b",
  sellOrderSig: "0xff6c9400f021f66d4769687d2dd2daab5046c27829189d241ef7ff4dae51edfa46d2fd1814848143f27d4a0c11a2acfdd65c201fc28ac47452ca81cd17de6bed1c",
  proxyOrderSig: "0xfcee38093eb9cd7fc4cafb9777741c8668cc21355704decd7dc8cbf75abdab901970a76f4eec0d392260695c3a86d05b5137904c19507782c6170d4e49ab2f4d1b",
  dwWrappedSig:
    "0x4d66bc08327376c38027ea4005e2bc481381cdbb16919b9a55bf21b4296db4b42cf9ceee83f6e25f98f68d9e8989e864565bd7faf1620e3a04cd340873789a1a1b3264e159346253e26a64e00b69032db0e7d32f94628de3e6eecb50304d7af3d2da4702f070c3c2b32289411e26ee4f564dec4670e619ccef4fa3271fb11eefbc4f726465722875696e743235362073616c742c61646472657373206d616b65722c61646472657373207369676e65722c75696e7432353620746f6b656e49642c75696e74323536206d616b6572416d6f756e742c75696e743235362074616b6572416d6f756e742c75696e743820736964652c75696e7438207369676e6174757265547970652c75696e743235362074696d657374616d702c62797465733332206d657461646174612c62797465733332206275696c6465722900ba",
  postOrderBody:
    '{"deferExec":false,"order":{"builder":"0x0000000000000000000000000000000000000000000000000000000000000000","expiration":"0","maker":"0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266","makerAmount":"5200000","metadata":"0x0000000000000000000000000000000000000000000000000000000000000000","salt":479249096354,"side":"BUY","signature":"0x86df27f9964d504233714a6c8c2d995e6e178fe797793efd6b0bee517dc29a912148f6842f90ac978f63e7068cbc6a213a231777183163bc78f212659bb8ad901c","signatureType":0,"signer":"0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266","takerAmount":"10000000","timestamp":"1791225442000","tokenId":"55115078421062885512539156303747803058407616201213034911037320915726138659123"},"orderType":"GTC","owner":"7b1e2d60-6f9a-4dd7-8f3e-21b8f94c77a2"}',
  postOrderHmac: "RIMeq20xuHNV1Vy2UGbR0yvHH5E0FgtWiAp6cr2_Myc=",
  deleteHmac: "GXqo0rX-kWFwUv-8dzk73B9tyNHAZECWQT8neER6F8U=",
  getOrderHmac: "rYTi8r4H5xHz98_etxuR3cYMTu82mNxi3tiyqAjcJmc=",
  getOpenOrdersHmac: "3Z0GsRW2AzErviOmHXlFSIOLHNxChIilUPXUYjOUlb4=",
  cancelAllHmac: "pgz5SV03UN7JXGGlXQodr6CWhvIPw8Tsj6a_unUAwoo=",
  balanceUpdateHmac: "lmBXs_47d_x-5fM3qn094V6JxujMraWMlc4hhuTk_pU=",
};

const CLOB = "https://clob.polymarket.com";
const GAMMA = "https://gamma-api.polymarket.com";
const GEO = "https://polymarket.com/api/geoblock";
const GEO_WORDS = "Polymarket does not serve this location: that is its own rule, and the account does not look for a way around it";
const ZERO32: Hex = `0x${"00".repeat(32)}`;
const ORDER_TYPES = {
  Order: [
    { name: "salt", type: "uint256" },
    { name: "maker", type: "address" },
    { name: "signer", type: "address" },
    { name: "tokenId", type: "uint256" },
    { name: "makerAmount", type: "uint256" },
    { name: "takerAmount", type: "uint256" },
    { name: "side", type: "uint8" },
    { name: "signatureType", type: "uint8" },
    { name: "timestamp", type: "uint256" },
    { name: "metadata", type: "bytes32" },
    { name: "builder", type: "bytes32" },
  ],
} as const;
const domain = (version: "2" | "3", verifyingContract: Hex) => ({ name: "Polymarket CTF Exchange", version, chainId: 137, verifyingContract });
const STANDARD: Hex = "0xE111180000d2663C0091e4f400237545B87B996B";
const NEG_RISK: Hex = "0xe2222d279d744050d28e00520010520000310F59";
const EXCHANGE_V3: Hex = "0xe3333700cA9d93003F00f0F71f8515005F6c00Aa";

// ---- what the venue answers, shaped like its docs and the live answers in the spec ------------------------

const IRAN_SLUG = "will-the-us-invade-iran-before-2027";
const IRAN_CID = "0x5db999fad322cea2914535aae5517060c3f80ad6d8c0231cde2124a434d16846";
const YES = "55115078421062885512539156303747803058407616201213034911037320915726138659123";
const NO = "1910830010387565971650098373488592514702818137344973088263643820608151819241";
const IRAN = { id: "665374", version: "v1", slug: IRAN_SLUG, question: "Will the U.S. invade Iran before 2027?", conditionId: IRAN_CID, outcomes: '["Yes", "No"]', outcomePrices: '["0.155", "0.845"]', clobTokenIds: `["${YES}", "${NO}"]`, positionIds: ["798559951534518479645224261511384773234863312866932338530531601041078616064", "798559951534518479645224261511384773234863312866932338530531601041078616065"], active: true, closed: false, acceptingOrders: true, enableOrderBook: true, negRisk: false, restricted: true, archived: false, orderPriceMinTickSize: 0.01, orderMinSize: 5, feesEnabled: false, feeSchedule: null, secondsDelay: null, bestBid: 0.15, bestAsk: 0.16, volume24hr: 349164.43 };
/** a live book's order: bids rising, asks falling, the best of each last */
const IRAN_BOOK = { market: IRAN_CID, asset_id: YES, timestamp: "1791225473904", hash: "548e1d0a0723c2af4a1387a2072b891987148339", bids: [{ price: "0.01", size: "2254498.9" }, { price: "0.14", size: "763785.07" }, { price: "0.15", size: "340465.51" }], asks: [{ price: "0.99", size: "69436.84" }, { price: "0.17", size: "283192.59" }, { price: "0.16", size: "77813.8" }], min_order_size: "5", tick_size: "0.01", neg_risk: false, last_trade_price: "0.160" };

const FED_SLUG = "will-there-be-no-change-in-fed-interest-rates-after-the-october-2026-meeting-20260617190324031";
const FED_CID = "0xdf9bf27ee5757c55b44b8b9826ddc9ec3a8809aa3278634c45edbb7fc8f1a3e3";
const FED_YES = "111061902544814266207267295505639408607400625795891618462682726460921782993748";
const FED_NO = "222061902544814266207267295505639408607400625795891618462682726460921782993749";
const FED = { ...IRAN, id: "700001", slug: FED_SLUG, question: "Will there be no change in Fed interest rates after the October 2026 meeting?", conditionId: FED_CID, outcomePrices: '["0.52", "0.48"]', clobTokenIds: `["${FED_YES}", "${FED_NO}"]`, negRisk: true, restricted: false, orderPriceMinTickSize: 0.001, feesEnabled: true, feeSchedule: { exponent: 1, rate: 0.04, takerOnly: true, rebateRate: 0.25 }, secondsDelay: 3, volume24hr: 2862125.26 };
const FED_BOOK = { ...IRAN_BOOK, market: FED_CID, asset_id: FED_YES, bids: [{ price: "0.517", size: "5000" }, { price: "0.519", size: "800" }], asks: [{ price: "0.524", size: "9000" }, { price: "0.523", size: "4000" }], tick_size: "0.001", neg_risk: true };

/** a Protocol V2 market (none was live when the spec was written): its trading id is the position id, and its book says v2 */
const V2_SLUG = "made-up-protocol-v2-market";
const V2_CID = "0x02aa000000000000000000000000000000000000000000000000000000000001";
const V2_YES = "901234567890123456789012345678901234567890123456789012345678901234567890";
const V2 = { ...IRAN, id: "800001", version: "v2", slug: V2_SLUG, question: "A made-up Protocol V2 market?", conditionId: V2_CID, clobTokenIds: `["111", "222"]`, positionIds: [V2_YES, "901234567890123456789012345678901234567890123456789012345678901234567891"], restricted: false };
const V2_BOOK = { ...IRAN_BOOK, market: V2_CID, asset_id: V2_YES, version: "v2" };

const ORDER = (over: Record<string, unknown> = {}) => ({ id: V.eoaOrderHash, market: IRAN_CID, asset_id: YES, owner: API_KEY, maker_address: EOA, side: "BUY", price: "0.52", original_size: "10", size_matched: "0", outcome: "Yes", order_type: "GTC", status: "LIVE", associate_trades: [], created_at: 1791225442, expiration: "0", ...over });

// ---- the stand-in -------------------------------------------------------------------------------------

interface Req {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}
type Answer = HttpReply | ((r: Req) => HttpReply) | Error;
const json = (body: unknown, status = 200): HttpReply => ({ status, body, text: JSON.stringify(body) });

const chain = (pusd: number): ChainReader => ({
  tokens: async (_holder, refs) => ({ rows: refs.map((r) => ({ chain: r.chain, asset: r.asset, amount: pusd })), failed: [] }),
  native: async () => ({ rows: [], failed: [] }),
  uint: async () => undefined,
  decimals: async () => 6,
  receipt: async () => undefined,
});

interface Opts {
  key?: Record<string, string>;
  answers?: Record<string, Answer | Answer[]>;
  geo?: Answer | Answer[];
  derive?: Answer | Answer[];
  clock?: () => number;
}

const DATA = "https://data-api.polymarket.com/v2";
/** the Data API's positions when a test sets up none: one holding, in the fields the address connection reads */
const SOME_POSITIONS = { data: [{ title: "Will the U.S. invade Iran before 2027?", outcome: "Yes", current_size: 40, current_value: 6.4 }], pagination: { next_cursor: null } };

/** Polymarket as a stand-in: an answer by "METHOD url" (a list is answered in turn, its last one from then on); anything not set up is a 404,
 * except the Data API's positions, which answer SOME_POSITIONS unless a test sets them up */
function stand(opts: Opts, seen: Req[]): Http {
  const answers: Record<string, Answer | Answer[]> = {
    [`GET ${GEO}`]: opts.geo ?? json({ blocked: false, ip: "203.0.113.7", country: "IE", region: "L" }),
    [`GET ${CLOB}/auth/derive-api-key`]: opts.derive ?? json({ apiKey: API_KEY, secret: SECRET, passphrase: PASSPHRASE }),
    ...(opts.answers ?? {}),
  };
  return async (url, init = {}) => {
    const req: Req = { method: init.method ?? "GET", url, headers: { ...(init.headers ?? {}) }, ...(init.body !== undefined ? { body: init.body } : {}) };
    seen.push(req);
    const a = answers[`${req.method} ${url}`] ?? (url.startsWith(`${DATA}/positions`) ? json(SOME_POSITIONS) : undefined);
    const next = Array.isArray(a) ? (a.length > 1 ? a.shift() : a[0]) : a;
    if (next === undefined) return json({ error: `not set up in this test: ${req.method} ${url}` }, 404);
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(req) : next;
  };
}

async function pm(opts: Opts = {}): Promise<{ t: LiveTrader; seen: Req[]; connect: Req[]; source: LiveSource; first: LiveBalance[] }> {
  const seen: Req[] = [];
  const opened = await polymarketTradeSource({ venue: "polymarket-trade", label: "", reference: "credentials/polymarket-trade/api-key.json", key: opts.key ?? { privateKey: HARDHAT_0 }, http: stand(opts, seen), chain: chain(150.5), clock: opts.clock ?? (() => TS_MS), salt: () => SALT });
  if (isRefusal(opened)) throw new Error(`${opened.code}: ${opened.message}`);
  const connect = seen.splice(0);
  return { t: opened.source.trader!, seen, connect, source: opened.source, first: opened.first };
}

const MARKET_ANSWERS: Record<string, Answer | Answer[]> = {
  [`GET ${GAMMA}/markets/slug/${IRAN_SLUG}`]: json(IRAN),
  [`GET ${CLOB}/book?token_id=${YES}`]: json(IRAN_BOOK),
  [`GET ${GAMMA}/markets/slug/${FED_SLUG}`]: json(FED),
  [`GET ${CLOB}/book?token_id=${FED_YES}`]: json(FED_BOOK),
  [`GET ${GAMMA}/markets/slug/${V2_SLUG}`]: json(V2),
  [`GET ${CLOB}/book?token_id=${V2_YES}`]: json(V2_BOOK),
};
const LIVE = (id = V.eoaOrderHash) => json({ success: true, errorMsg: "", orderID: id, status: "live", makingAmount: "", takingAmount: "", transactionsHashes: [], tradeIDs: [] });
const withPost = (answer: Answer | Answer[] = LIVE(), more: Record<string, Answer | Answer[]> = {}): Record<string, Answer | Answer[]> => ({ ...MARKET_ANSWERS, [`POST ${CLOB}/order`]: answer, ...more });

const SECRETS = [SECRET, PASSPHRASE, API_KEY, HARDHAT_0, HARDHAT_0.slice(2)];
const refusal = (x: unknown): Refusal => {
  if (!isRefusal(x)) throw new Error(`expected a refusal, got ${JSON.stringify(x)}`);
  for (const s of SECRETS) expect(JSON.stringify(x)).not.toContain(s);
  return x;
};
const ok = <T>(x: T | Refusal): T => {
  if (isRefusal(x)) throw new Error(`expected an answer, got ${x.code}: ${x.message}`);
  return x;
};
const calls = (seen: Req[]) => seen.map((r) => `${r.method} ${r.url}`);
const posted = (seen: Req[]) => {
  const p = seen.filter((r) => r.method === "POST" && r.url === `${CLOB}/order`);
  expect(p).toHaveLength(1);
  return { req: p[0]!, body: JSON.parse(p[0]!.body!) as { order: Record<string, string | number>; orderType: string; owner: string; deferExec: boolean; postOnly?: boolean } };
};
const order = (over: Partial<OrderRequest> = {}): OrderRequest => ({ symbol: `${IRAN_SLUG}:Yes`, side: "buy", type: "limit", qty: 10, limitPrice: 0.52, clientId: CLIENT_ID, ...over });
/** the signed message, read back from the body as the CLOB would */
const messageOf = (o: Record<string, string | number>) => ({ salt: BigInt(o.salt!), maker: o.maker as Hex, signer: o.signer as Hex, tokenId: BigInt(o.tokenId!), makerAmount: BigInt(o.makerAmount!), takerAmount: BigInt(o.takerAmount!), side: o.side === "BUY" ? 0 : 1, signatureType: Number(o.signatureType), timestamp: BigInt(o.timestamp!), metadata: o.metadata as Hex, builder: o.builder as Hex });

// ---- the connection --------------------------------------------------------------------------------------

describe("Polymarket's trading connection", () => {
  it("asks Polymarket's location check first, reads the wallet's positions and cash, then derives the key's CLOB credentials (L1, the spec's vector)", async () => {
    const { source, connect, first } = await pm();
    expect([source.trader!.can, source.trader!.what]).toEqual([true, "event contracts"]);
    expect(source.kind).toBe("prediction");
    expect(source.address).toBeUndefined();
    expect(calls(connect)).toEqual([`GET ${GEO}`, `GET https://data-api.polymarket.com/v2/positions?user=${EOA}&limit=200`, `GET ${CLOB}/auth/derive-api-key`]);
    const l1 = connect[2]!;
    expect(l1.headers).toMatchObject({ POLY_ADDRESS: EOA, POLY_SIGNATURE: V.clobAuthSig, POLY_TIMESTAMP: "1791225442", POLY_NONCE: "0" });
    expect(l1.body).toBeUndefined();
    const signer = await recoverTypedDataAddress({ domain: { name: "ClobAuthDomain", version: "1", chainId: 137 }, types: { ClobAuth: [{ name: "address", type: "address" }, { name: "timestamp", type: "string" }, { name: "nonce", type: "uint256" }, { name: "message", type: "string" }] }, primaryType: "ClobAuth", message: { address: EOA, timestamp: "1791225442", nonce: 0n, message: "This message attests that I control the given wallet" }, signature: V.clobAuthSig as Hex });
    expect(signer).toBe(EOA);
    expect(first.map((b) => [b.asset, b.amount, b.usd])).toEqual([["Will the U.S. invade Iran before 2027? · Yes", 40, 6.4], ["pUSD", 150.5, 150.5]]);
    expect(source.probe.can).toEqual(["trade"]);
    expect(JSON.stringify(source)).not.toContain(SECRET);
  });

  it("no credentials yet: the derive's 400 is followed by POST /auth/api-key; a signature Polymarket does not accept is its no", async () => {
    const { connect } = await pm({ derive: json({ error: "Could not derive api key!" }, 400), answers: { [`POST ${CLOB}/auth/api-key`]: json({ apiKey: API_KEY, secret: SECRET, passphrase: PASSPHRASE }) } });
    expect(calls(connect).slice(-2)).toEqual([`GET ${CLOB}/auth/derive-api-key`, `POST ${CLOB}/auth/api-key`]);
    expect(connect.at(-1)!.headers).toMatchObject({ POLY_ADDRESS: EOA, POLY_SIGNATURE: V.clobAuthSig, POLY_NONCE: "0" });

    const seen: Req[] = [];
    const bad = refusal(await polymarketTradeSource({ venue: "polymarket-trade", label: "", reference: "", key: { privateKey: HARDHAT_0 }, http: stand({ derive: json({ error: "Invalid L1 Request headers" }, 401) }, seen), chain: chain(0), clock: () => TS_MS }));
    expect([bad.code, bad.message]).toEqual(["E_VENUE_UNAUTHORIZED", "Polymarket does not accept this key's credentials: Invalid L1 Request headers"]);
  });

  it("Polymarket's location check says blocked: that is its rule, said in its words, and nothing else is asked or offered", async () => {
    const seen: Req[] = [];
    const geo = refusal(await polymarketTradeSource({ venue: "polymarket-trade", label: "", reference: "", key: { privateKey: HARDHAT_0 }, http: stand({ geo: json({ blocked: true, ip: "203.0.113.7", country: "US", region: "PA" }) }, seen), chain: chain(0), clock: () => TS_MS }));
    expect([geo.code, geo.message]).toEqual(["E_VENUE_GEOBLOCKED", GEO_WORDS]);
    expect(geo.native).toEqual({ blocked: true, country: "US", region: "PA" });
    expect(JSON.stringify(geo)).not.toContain("203.0.113.7");
    expect(calls(seen)).toEqual([`GET ${GEO}`]);
    // a check that does not answer is not a yes
    const quiet: Req[] = [];
    const down = refusal(await polymarketTradeSource({ venue: "polymarket-trade", label: "", reference: "", key: { privateKey: HARDHAT_0 }, http: stand({ geo: json({ error: "bad gateway" }, 502) }, quiet), chain: chain(0), clock: () => TS_MS }));
    expect(down.code).toBe("E_VENUE_UNREACHABLE");
    expect(calls(quiet)).toEqual([`GET ${GEO}`]);
  });

  it("the key file: a wallet named without its kind, a kind without its wallet, a key that is not one — field names said, no value", async () => {
    const open = (key: Record<string, string>) => polymarketTradeSource({ venue: "polymarket-trade", label: "", reference: "", key, http: stand({}, []), chain: chain(0), clock: () => TS_MS });
    const noKind = refusal(await open({ privateKey: HARDHAT_0, funderAddress: WALLET }));
    expect([noKind.code, noKind.detail]).toEqual(["E_ACCOUNT_CREDENTIAL", { missing: ["signatureType"] }]);
    const noWallet = refusal(await open({ privateKey: HARDHAT_0, signatureType: "2" }));
    expect([noWallet.code, noWallet.detail]).toEqual(["E_ACCOUNT_CREDENTIAL", { missing: ["funderAddress"] }]);
    const notKey = refusal(await open({ privateKey: "0xnot-a-key-at-all-but-long-enough" }));
    expect(notKey.code).toBe("E_ACCOUNT_CREDENTIAL");
    expect(notKey.message).not.toContain("not-a-key-at-all");
    expect(refusal(await open({ privateKey: HARDHAT_0, signatureType: "7" })).code).toBe("E_ACCOUNT_CREDENTIAL");
    expect(refusal(await open({ privateKey: HARDHAT_0, funderAddress: WALLET, signatureType: "constructor" })).code).toBe("E_ACCOUNT_CREDENTIAL");
    expect(refusal(await open({ privateKey: HARDHAT_0, funderAddress: WALLET, signatureType: "0" })).code).toBe("E_ACCOUNT_CREDENTIAL");
  });

  const home = mkdtempSync(join(tmpdir(), "pm-trade-"));
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it("through the account's own connector table: live:polymarket-trade reads a key file and carries a trader", async () => {
    const pk = generatePrivateKey();
    mkdirSync(join(home, "credentials/polymarket-trade"), { recursive: true });
    const file = join(home, "credentials/polymarket-trade/api-key.json");
    writeFileSync(file, JSON.stringify({ privateKey: pk }));
    chmodSync(file, 0o600);
    expect(KEY_SHAPES["polymarket-trade"]!.required).toEqual(["privateKey"]);
    expect(keyFileStatus(home, "polymarket-trade", "polymarket-trade", "").ready).toBe(true);
    expect(liveOptions(home).options.find((o) => o.kind === "polymarket-trade")).toMatchObject({ connector: "live:polymarket-trade", label: "Polymarket · trading, with the account wallet's key", needs: "key-file" });
    const seen: Req[] = [];
    const deps = { home, http: stand({}, seen), clock: () => TS_MS, chain: chain(12), proofs: {}, price: async () => undefined, mm: async () => ({}) } as unknown as LiveDeps;
    const opened = await openLive({ venue: "polymarket-trade", connector: "live:polymarket-trade", label: "", reference: "" }, deps);
    if (isRefusal(opened)) throw new Error(opened.message);
    expect([opened.source.trader!.can, opened.source.trader!.what]).toEqual([true, "event contracts"]);
    expect(opened.summary).toContain("the venue says this credential can trade");
    expect(opened.source.reference).toBe("credentials/polymarket-trade/api-key.json");
    const me = privateKeyToAccount(pk).address;
    expect(calls(seen)).toEqual([`GET ${GEO}`, `GET https://data-api.polymarket.com/v2/positions?user=${me}&limit=200`, `GET ${CLOB}/auth/derive-api-key`]);
    expect(JSON.stringify(opened.source)).not.toContain(pk.slice(2));
  });
});

// ---- markets -------------------------------------------------------------------------------------------

describe("one market, with a fresh price", () => {
  it("<slug>:<outcome>: Gamma for what it is, the book for its price — the best bid and ask computed, not read off the ends", async () => {
    const { t, seen } = await pm({ answers: MARKET_ANSWERS });
    const m = ok(await t.market(`${IRAN_SLUG}:yes`));
    expect(m).toEqual({ symbol: `${IRAN_SLUG}:Yes`, name: "Will the U.S. invade Iran before 2027? · Yes", kind: "event", base: "Yes", quote: "pUSD", price: 0.155, bid: 0.15, ask: 0.16, minQty: 5, qtyStep: 0.01, priceStep: 0.01, open: true, note: "Polymarket restricts this market in some places", types: ["market", "limit"], tifs: ["gtc", "ioc", "fok"], postOnly: true, sellsReduce: true });
    expect(calls(seen)).toEqual([`GET ${GAMMA}/markets/slug/${IRAN_SLUG}`, `GET ${CLOB}/book?token_id=${YES}`]);
  });

  it("declares what the CLOB takes and nothing else: limit and market orders, gtc, ioc and fok, post-only — no stop, reduce-only or leverage, and no amend, close or leverage call", async () => {
    const { t } = await pm({ answers: MARKET_ANSWERS });
    for (const s of [`${IRAN_SLUG}:Yes`, `${FED_SLUG}:Yes`, `${V2_SLUG}:Yes`]) {
      const m = ok(await t.market(s));
      expect([m.types, m.tifs, m.postOnly]).toEqual([["market", "limit"], ["gtc", "ioc", "fok"], true]);
      expect(Object.keys(m).filter((k) => ["reduceOnly", "maxLeverage", "contractSize"].includes(k))).toEqual([]);
    }
    expect([t.amend, t.close, t.setLeverage]).toEqual([undefined, undefined, undefined]);
    expect(typeof t.positions).toBe("function");
  });

  it("an outcome's token id: the book first, then its market by condition id; the token stays the symbol", async () => {
    const { t, seen } = await pm({ answers: { [`GET ${CLOB}/book?token_id=${YES}`]: json(IRAN_BOOK), [`GET ${GAMMA}/markets/keyset?condition_ids=${IRAN_CID}&limit=5`]: json({ markets: [IRAN], next_cursor: null }) } });
    const m = ok(await t.market(YES));
    expect([m.symbol, m.name, m.bid, m.ask, m.open]).toEqual([YES, "Will the U.S. invade Iran before 2027? · Yes", 0.15, 0.16, true]);
    expect(calls(seen)).toEqual([`GET ${CLOB}/book?token_id=${YES}`, `GET ${GAMMA}/markets/keyset?condition_ids=${IRAN_CID}&limit=5`]);
    const none = refusal(await t.market("123456789012345"));
    expect([none.code, none.message]).toEqual(["E_VENUE_REJECTED", "Polymarket has no order book for the token 123456789012…: it is not one Polymarket trades, or its market is closed"]);
  });

  it("a fee market with a matching delay, a neg-risk market at tick 0.001: the owner is told; the minimum, tick and steps are the book's", async () => {
    const { t } = await pm({ answers: MARKET_ANSWERS });
    const m = ok(await t.market(`${FED_SLUG}:Yes`));
    expect([m.bid, m.ask, m.priceStep, m.minQty, m.open]).toEqual([0.519, 0.523, 0.001, 5, true]);
    expect(m.note).toBe("a taker pays 0.04 × p × (1 − p) a share in fees when it matches · Polymarket holds an order that would match for 3 s before matching it, and it cannot be canceled meanwhile");
  });

  it("open only while Polymarket takes orders in it: not accepting, closed, or no book — and nothing it cannot name", async () => {
    const { t, seen } = await pm({ answers: { [`GET ${GAMMA}/markets/slug/${IRAN_SLUG}`]: [json({ ...IRAN, acceptingOrders: false }), json({ ...IRAN, closed: true }), json(IRAN)], [`GET ${CLOB}/book?token_id=${YES}`]: json({ error: "No orderbook exists for the requested token id" }, 404), [`GET ${GAMMA}/markets/slug/nope`]: json({ type: "not found error", error: "slug not found" }, 404) } });
    const paused = ok(await t.market(`${IRAN_SLUG}:Yes`));
    expect([paused.open, paused.note]).toEqual([false, "Polymarket is not taking orders in it now"]);
    expect(calls(seen)).toEqual([`GET ${GAMMA}/markets/slug/${IRAN_SLUG}`]);
    expect(ok(await t.market(`${IRAN_SLUG}:Yes`)).note).toBe("the market is closed");
    expect(ok(await t.market(`${IRAN_SLUG}:Yes`))).toMatchObject({ open: false, note: "it has no order book now" });
    const outcome = refusal(await t.market(`${IRAN_SLUG}:Maybe`));
    expect([outcome.code, outcome.message]).toEqual(["E_VENUE_REJECTED", `Polymarket's ${IRAN_SLUG} has the outcomes Yes and No, not "Maybe"`]);
    expect(refusal(await t.market("nope:Yes")).message).toBe("Polymarket lists no market nope");
    expect(refusal(await t.market("just words")).code).toBe("E_VENUE_REJECTED");
  });
});

describe("the markets to choose from", () => {
  const many = Array.from({ length: 14 }, (_, i) => ({ ...IRAN, id: String(900 + i), slug: `made-up-market-${i}`, question: `Made-up question ${i}?`, conditionId: `0x${String(i).padStart(64, "0")}`, clobTokenIds: `["${10_000_000_000 + i}1", "${10_000_000_000 + i}2"]`, volume24hr: 1000 - i }));
  const page = { markets: [FED, IRAN, { ...IRAN, slug: "paused-market", acceptingOrders: false }, { ...IRAN, slug: "no-book-market", enableOrderBook: false }, { ...IRAN, slug: "unknown-version-market", version: "v9" }, { ...IRAN, slug: "no-ids-market", clobTokenIds: "[]" }, ...many], next_cursor: null };
  const URL = `${GAMMA}/markets/keyset?closed=false&limit=100&order=volume24hr&ascending=false`;

  it("Gamma's busiest open order-book markets, every outcome a market, all in pUSD; at most twenty; the list kept five minutes", async () => {
    let now = TS_MS;
    const { t, seen } = await pm({ answers: { [`GET ${URL}`]: json(page) }, clock: () => now });
    const first = ok(await t.markets(""));
    expect(first).toHaveLength(20);
    expect(first.slice(0, 4).map((m) => m.symbol)).toEqual([`${FED_SLUG}:Yes`, `${FED_SLUG}:No`, `${IRAN_SLUG}:Yes`, `${IRAN_SLUG}:No`]);
    expect(first.every((m) => m.quote === "pUSD" && inDollars(m.quote) && m.open && m.kind === "event")).toBe(true);
    expect(first.every((m) => m.tifs?.join() === "gtc,ioc,fok" && m.postOnly === true && !("reduceOnly" in m) && !("maxLeverage" in m))).toBe(true);
    expect(first.some((m) => /paused-market|no-book-market|unknown-version-market|no-ids-market/.test(m.symbol))).toBe(false);
    expect(first[2]).toMatchObject({ name: "Will the U.S. invade Iran before 2027? · Yes", price: 0.155, minQty: 5, priceStep: 0.01, qtyStep: 0.01 });
    expect(ok(await t.markets("iran")).map((m) => m.symbol)).toEqual([`${IRAN_SLUG}:Yes`, `${IRAN_SLUG}:No`]);
    expect(ok(await t.markets("fed")).map((m) => m.symbol)).toEqual([`${FED_SLUG}:Yes`, `${FED_SLUG}:No`]);
    expect(calls(seen)).toEqual([`GET ${URL}`]);
    now += 5 * 60_000 + 1;
    await t.markets("");
    expect(calls(seen)).toEqual([`GET ${URL}`, `GET ${URL}`]);
  });
});

// ---- orders ------------------------------------------------------------------------------------------

describe("an order, signed as the official clients sign it", () => {
  it("a limit buy: the location check, then POST /order — the spec's body, signature and HMAC byte for byte", async () => {
    const { t, seen } = await pm({ answers: withPost() });
    const st = ok(await t.place(order()));
    expect(calls(seen)).toEqual([`GET ${GEO}`, `GET ${GAMMA}/markets/slug/${IRAN_SLUG}`, `GET ${CLOB}/book?token_id=${YES}`, `POST ${CLOB}/order`]);
    const { req } = posted(seen);
    expect(req.body).toBe(V.postOrderBody);
    expect(req.headers).toEqual({ accept: "application/json", POLY_ADDRESS: EOA, POLY_SIGNATURE: V.postOrderHmac, POLY_TIMESTAMP: "1791225442", POLY_API_KEY: API_KEY, POLY_PASSPHRASE: PASSPHRASE, "content-type": "application/json" });
    expect(st).toEqual({ ref: V.eoaOrderHash, status: "open", filledQty: 0, native: { clientId: CLIENT_ID, orderHash: V.eoaOrderHash, orderType: "GTC", orderID: V.eoaOrderHash, status: "live", makingAmount: "", takingAmount: "", tradeIDs: [], transactionsHashes: [] } });
    // the signature is the key's, over the spec's domain and types
    const o = JSON.parse(req.body!).order as Record<string, string | number>;
    expect(await recoverTypedDataAddress({ domain: domain("2", STANDARD), types: ORDER_TYPES, primaryType: "Order", message: messageOf(o), signature: o.signature as Hex })).toBe(EOA);
  });

  it("a limit sell, and the same buy on a neg-risk market (its own exchange): the spec's signatures", async () => {
    const { t, seen } = await pm({ answers: withPost() });
    ok(await t.place(order({ side: "sell" })));
    const sell = posted(seen).body.order;
    expect([sell.side, sell.makerAmount, sell.takerAmount, sell.signature]).toEqual(["SELL", "10000000", "5200000", V.sellOrderSig]);
    seen.splice(0);
    ok(await t.place(order({ symbol: `${FED_SLUG}:Yes` })));
    const nr = posted(seen).body.order;
    expect([nr.tokenId, nr.makerAmount, nr.takerAmount, nr.signature]).toEqual([FED_YES, "5200000", "10000000", V.negRiskOrderSig]);
    expect(await recoverTypedDataAddress({ domain: domain("2", NEG_RISK), types: ORDER_TYPES, primaryType: "Order", message: messageOf(nr), signature: nr.signature as Hex })).toBe(EOA);
  });

  it("a Proxy wallet (1) and a Safe (2): the wallet makes the order, the key signs it and authenticates", async () => {
    const proxy = await pm({ key: { privateKey: HARDHAT_0, funderAddress: WALLET.toLowerCase(), signatureType: "1" }, answers: withPost() });
    expect(proxy.connect[1]!.url).toBe(`https://data-api.polymarket.com/v2/positions?user=${WALLET}&limit=200`);
    ok(await proxy.t.place(order()));
    const p = posted(proxy.seen);
    expect([p.body.order.maker, p.body.order.signer, p.body.order.signatureType, p.body.order.signature, p.req.headers.POLY_ADDRESS]).toEqual([WALLET, EOA, 1, V.proxyOrderSig, EOA]);

    const safe = await pm({ key: { privateKey: HARDHAT_0, funderAddress: WALLET, signatureType: "POLY_GNOSIS_SAFE" }, answers: withPost() });
    ok(await safe.t.place(order()));
    const s = posted(safe.seen).body.order;
    expect([s.maker, s.signer, s.signatureType]).toEqual([WALLET, EOA, 2]);
    expect(await recoverTypedDataAddress({ domain: domain("2", STANDARD), types: ORDER_TYPES, primaryType: "Order", message: messageOf(s), signature: s.signature as Hex })).toBe(EOA);
  });

  it("a Deposit Wallet (3): maker and signer are the wallet, the owner signs TypedDataSign, wrapped to 317 bytes — the spec's vector", async () => {
    const { t, seen } = await pm({ key: { privateKey: HARDHAT_0, funderAddress: WALLET, signatureType: "3" }, answers: withPost() });
    ok(await t.place(order()));
    const { req, body } = posted(seen);
    expect([body.order.maker, body.order.signer, body.order.signatureType, req.headers.POLY_ADDRESS]).toEqual([WALLET, WALLET, 3, EOA]);
    expect(body.order.signature).toBe(V.dwWrappedSig);
    expect((String(body.order.signature).length - 2) / 2).toBe(317);
    const inner = String(body.order.signature).slice(0, 132) as Hex;
    const td = { domain: domain("2", STANDARD), types: { ...ORDER_TYPES, TypedDataSign: [{ name: "contents", type: "Order" }, { name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }, { name: "salt", type: "bytes32" }] }, primaryType: "TypedDataSign", message: { contents: messageOf(body.order), name: "DepositWallet", version: "1", chainId: 137n, verifyingContract: WALLET, salt: ZERO32 } } as const;
    expect(await recoverTypedDataAddress({ ...td, signature: inner })).toBe(EOA);
  });

  it("a Protocol V2 market: its position id, signed with domain version 3 for ExchangeV3", async () => {
    const { t, seen } = await pm({ answers: withPost() });
    ok(await t.place(order({ symbol: `${V2_SLUG}:Yes` })));
    const o = posted(seen).body.order;
    expect(o.tokenId).toBe(V2_YES);
    expect(await recoverTypedDataAddress({ domain: domain("3", EXCHANGE_V3), types: ORDER_TYPES, primaryType: "Order", message: messageOf(o), signature: o.signature as Hex })).toBe(EOA);
  });

  it("limit amounts at two ticks: shares times price, exact, in millionths", async () => {
    const { t, seen } = await pm({ answers: withPost() });
    const amounts = async (o: Partial<OrderRequest>) => {
      seen.splice(0);
      ok(await t.place(order(o)));
      const b = posted(seen).body;
      return [b.order.side, b.order.makerAmount, b.order.takerAmount, b.orderType, b.order.expiration];
    };
    expect(await amounts({ qty: 12.34, limitPrice: 0.52 })).toEqual(["BUY", "6416800", "12340000", "GTC", "0"]);
    expect(await amounts({ qty: 12.34, limitPrice: 0.52, side: "sell" })).toEqual(["SELL", "12340000", "6416800", "GTC", "0"]);
    expect(await amounts({ symbol: `${FED_SLUG}:Yes`, qty: 12.34, limitPrice: 0.523 })).toEqual(["BUY", "6453820", "12340000", "GTC", "0"]);
    expect(await amounts({ symbol: `${FED_SLUG}:Yes`, qty: 12.34, limitPrice: 0.523, side: "sell" })).toEqual(["SELL", "12340000", "6453820", "GTC", "0"]);
  });

  it("a market order is fill-and-kill at the worst price the account allows: a sell of the shares, a buy of what they cost on the book now", async () => {
    const deep = (ask: string, more: Record<string, unknown> = {}) => json({ ...IRAN_BOOK, asks: [{ price: "0.99", size: "100000" }, { price: ask, size: "100000" }], ...more });
    const { t, seen } = await pm({ answers: withPost(LIVE(), { [`GET ${CLOB}/book?token_id=${YES}`]: [json(IRAN_BOOK), deep("0.52"), json({ ...IRAN_BOOK, asks: [{ price: "0.53", size: "1000" }, { price: "0.52", size: "10" }] })], [`GET ${CLOB}/book?token_id=${FED_YES}`]: [json(FED_BOOK), json({ ...FED_BOOK, asks: [{ price: "0.523", size: "100000" }] })] }) });
    const sent = async (o: Partial<OrderRequest>) => {
      seen.splice(0);
      ok(await t.place(order({ type: "market", limitPrice: undefined, ...o })));
      const b = posted(seen).body;
      return [b.order.side, b.order.makerAmount, b.order.takerAmount, b.orderType, b.order.expiration];
    };
    // $10.00 at 0.52 asks for at least 19.2308 shares: the docs' example, rounded up so that no fill is dearer than the worst price
    expect(await sent({ qty: 19.24, worstPrice: 0.52 })).toEqual(["BUY", "10000000", "19230800", "FAK", "0"]);
    expect(calls(seen)).toEqual([`GET ${GEO}`, `GET ${GAMMA}/markets/slug/${IRAN_SLUG}`, `GET ${CLOB}/book?token_id=${YES}`, `GET ${CLOB}/book?token_id=${YES}`, `POST ${CLOB}/order`]);
    // a thin best ask: 10 at 0.52 and 9.24 at 0.53 cost $10.0972, sent as $10.09, at least 19.0378 shares at 0.53
    expect(await sent({ qty: 19.24, worstPrice: 0.53 })).toEqual(["BUY", "10090000", "19037800", "FAK", "0"]);
    // tick 0.001: $10.00 at 0.523 asks for 19.12046 shares (clob-client-v2 rounds this one down to 19.12045; the spec's price-protected rule rounds up)
    expect(await sent({ symbol: `${FED_SLUG}:Yes`, qty: 19.13, worstPrice: 0.523 })).toEqual(["BUY", "10000000", "19120460", "FAK", "0"]);
    expect(await sent({ side: "sell", qty: 10, worstPrice: 0.49 })).toEqual(["SELL", "10000000", "4900000", "FAK", "0"]);
    expect(await sent({ symbol: `${FED_SLUG}:Yes`, side: "sell", qty: 12.34, worstPrice: 0.517 })).toEqual(["SELL", "12340000", "6379780", "FAK", "0"]);
    // a worst price between ticks goes onto the tick it cannot loosen: a sell's up
    expect(await sent({ side: "sell", qty: 10, worstPrice: 0.4912 })).toEqual(["SELL", "10000000", "5000000", "FAK", "0"]);
  });

  it("a market buy at an ask of 0.99: its worst price (2% over, past 1) is held at 0.99, the top of the range, and the order goes", async () => {
    const { t, seen } = await pm({ answers: withPost(LIVE(), { [`GET ${CLOB}/book?token_id=${YES}`]: [json(IRAN_BOOK), json({ ...IRAN_BOOK, asks: [{ price: "0.99", size: "100000" }] })] }) });
    ok(await t.place(order({ type: "market", limitPrice: undefined, qty: 10, worstPrice: 1.0098 })));
    const b = posted(seen).body;
    // $9.90 for at least 10 shares: no fill above 0.99
    expect([b.order.side, b.order.makerAmount, b.order.takerAmount, b.orderType]).toEqual(["BUY", "9900000", "10000000", "FAK"]);
  });

  it("an order whose outcome was typed in another case is placed under the market's own name", async () => {
    const { t, seen } = await pm({ answers: withPost() });
    const st = ok(await t.place(order({ symbol: `${IRAN_SLUG}:yes` })));
    expect(st.ref).toBe(V.eoaOrderHash);
    expect(posted(seen).body.order.tokenId).toBe(YES);
  });

  it("a request cut off mid-way (\"context canceled\"): the order is looked up under its hash before anything is said", async () => {
    const { t, seen } = await pm({ answers: withPost(json({ error: "context canceled" }, 400), { [`GET ${CLOB}/data/order/${V.eoaOrderHash}`]: json(ORDER()) }) });
    const st = ok(await t.place(order()));
    expect([st.ref, st.status]).toEqual([V.eoaOrderHash, "open"]);
    expect(calls(seen).slice(-2)).toEqual([`POST ${CLOB}/order`, `GET ${CLOB}/data/order/${V.eoaOrderHash}`]);
  });

  it("the account's id: Polymarket takes no client order id, so it stays with the answer; the signed order carries none", async () => {
    const { t, seen } = await pm({ answers: withPost() });
    const st = ok(await t.place(order()));
    expect(st.native).toMatchObject({ clientId: CLIENT_ID, orderHash: V.eoaOrderHash });
    const { req, body } = posted(seen);
    expect(req.body).not.toContain(CLIENT_ID);
    expect([body.order.metadata, body.order.builder]).toEqual([ZERO32, ZERO32]);
  });

  it("refused before anything is sent: a market order without its worst price, a size off the 0.01 step, a price off the tick or outside it", async () => {
    const { t, seen } = await pm({ answers: withPost() });
    expect(refusal(await t.place(order({ type: "market", limitPrice: undefined })))).toMatchObject({ code: "E_VENUE_ORDER_INVALID" });
    expect(seen).toHaveLength(0);
    expect(refusal(await t.place(order({ qty: 10.555 }))).message).toBe("Polymarket: a size moves in steps of 0.01 shares");
    expect(refusal(await t.place(order({ limitPrice: 0.525 }))).message).toBe("Polymarket: a price in Will the U.S. invade Iran before 2027? · Yes moves in steps of 0.01");
    expect(refusal(await t.place(order({ limitPrice: 0.995 }))).code).toBe("E_VENUE_ORDER_INVALID");
    expect(refusal(await t.place(order({ qty: 4 }))).message).toBe("Polymarket: the smallest order in Will the U.S. invade Iran before 2027? · Yes is 5 shares");
    expect(seen.filter((r) => r.method === "POST")).toHaveLength(0);
  });

  it("matched at once: the order is read back for what filled; delayed and unmatched are taken and followed", async () => {
    const matched = json({ success: true, errorMsg: "", orderID: V.eoaOrderHash, status: "matched", makingAmount: "5.2", takingAmount: "10", transactionsHashes: [], tradeIDs: ["t-1"] });
    const trades = json({ limit: 100, count: 1, next_cursor: "LTE=", data: [{ id: "t-1", taker_order_id: V.eoaOrderHash, market: IRAN_CID, asset_id: YES, side: "BUY", size: "10", price: "0.515", status: "MATCHED", trader_side: "TAKER", maker_orders: [] }] });
    const { t, seen } = await pm({ answers: withPost([matched, json({ ...matched.body as object, status: "delayed" }), json({ ...matched.body as object, status: "unmatched" })], { [`GET ${CLOB}/data/order/${V.eoaOrderHash}`]: json(ORDER({ status: "MATCHED", size_matched: "10", associate_trades: ["t-1"] })), [`GET ${CLOB}/data/trades?market=${IRAN_CID}`]: trades }) });
    const st = ok(await t.place(order()));
    expect([st.ref, st.status, st.filledQty, st.avgPrice]).toEqual([V.eoaOrderHash, "filled", 10, 0.515]);
    expect(calls(seen).slice(-3)).toEqual([`POST ${CLOB}/order`, `GET ${CLOB}/data/order/${V.eoaOrderHash}`, `GET ${CLOB}/data/trades?market=${IRAN_CID}`]);
    expect(ok(await t.place(order())).status).toBe("pending");
    expect(ok(await t.place(order())).status).toBe("pending");
  });

  it("Polymarket did not answer: it is asked for the order under the order's own hash — there, or most likely not placed; never sent twice", async () => {
    const { t, seen } = await pm({ answers: withPost([new Error("socket hang up"), json({ error: "bad gateway" }, 502)], { [`GET ${CLOB}/data/order/${V.eoaOrderHash}`]: [json(ORDER()), json({ error: "Order not found" }, 404)] }) });
    const st = ok(await t.place(order()));
    expect([st.ref, st.status]).toEqual([V.eoaOrderHash, "open"]);
    expect(calls(seen).slice(-2)).toEqual([`POST ${CLOB}/order`, `GET ${CLOB}/data/order/${V.eoaOrderHash}`]);
    const lost = refusal(await t.place(order()));
    expect(lost.code).toBe("E_VENUE_UNREACHABLE");
    expect(lost.message).toContain("most likely nothing was placed");
    expect(lost.detail).toMatchObject({ placed: "unknown", orderHash: V.eoaOrderHash, clientId: CLIENT_ID });
    expect(seen.filter((r) => r.method === "POST")).toHaveLength(2);
  });
});

// ---- times in force and post-only ---------------------------------------------------------------------------

describe("the time in force and post-only, as the CLOB takes them", () => {
  /** a book whose best ask is 0.52, deep enough for any order here */
  const DEEP_AT_52 = json({ ...IRAN_BOOK, asks: [{ price: "0.99", size: "100000" }, { price: "0.52", size: "100000" }] });

  it("gtc goes as GTC, ioc as FAK, fok as FOK; with none asked, a limit order is GTC and a market order FAK, as before", async () => {
    const { t, seen } = await pm({ answers: withPost(LIVE(), { [`GET ${CLOB}/book?token_id=${YES}`]: DEEP_AT_52 }) });
    const sent = async (o: Partial<OrderRequest>) => {
      seen.splice(0);
      const st = ok(await t.place(order(o)));
      const { req, body } = posted(seen);
      expect((st.native as { orderType: string }).orderType).toBe(body.orderType);
      expect([body.order.expiration, "postOnly" in body]).toEqual(["0", false]);
      return { req, body };
    };
    // a limit order with no time in force, or gtc: the spec's GTC body, byte for byte
    expect((await sent({})).req.body).toBe(V.postOrderBody);
    expect((await sent({ tif: "gtc" })).req.body).toBe(V.postOrderBody);
    // ioc and fok, where the best ask is the limit: the same signed order (the order type is not signed), sent as FAK and as FOK
    expect((await sent({ tif: "ioc" })).req.body).toBe(V.postOrderBody.replace('"orderType":"GTC"', '"orderType":"FAK"'));
    const fok = await sent({ tif: "fok" });
    expect(fok.req.body).toBe(V.postOrderBody.replace('"orderType":"GTC"', '"orderType":"FOK"'));
    expect(fok.req.headers.POLY_SIGNATURE).toBe(polyHmac(SECRET, 1791225442, "POST", "/order", fok.req.body));
    // a market order: $10.00 at 0.52 for at least 19.2308 shares, whichever way it is killed
    for (const [tif, want] of [[undefined, "FAK"], ["ioc", "FAK"], ["fok", "FOK"]] as const) {
      const { body } = await sent({ type: "market", limitPrice: undefined, qty: 19.24, worstPrice: 0.52, tif });
      expect([body.orderType, body.order.side, body.order.makerAmount, body.order.takerAmount]).toEqual([want, "BUY", "10000000", "19230800"]);
    }
  });

  it("a limit order that is fill-and-kill or fill-or-kill is built as a price-protected market order bounded at its limit: a buy in pUSD to the cent, for what its shares cost now", async () => {
    const THIN = json({ ...IRAN_BOOK, asks: [{ price: "0.53", size: "1000" }, { price: "0.52", size: "10" }] });
    // the first book is market()'s; each buy that fills at once walks the book again
    const { t, seen } = await pm({ answers: withPost(LIVE(), { [`GET ${CLOB}/book?token_id=${YES}`]: [json(IRAN_BOOK), DEEP_AT_52, json(IRAN_BOOK), THIN] }) });
    const sent = async (o: Partial<OrderRequest>) => {
      seen.splice(0);
      ok(await t.place(order(o)));
      const b = posted(seen).body;
      return [b.orderType, b.order.side, b.order.makerAmount, b.order.takerAmount];
    };
    // resting, 12.34 shares at 0.52 is $6.4168 exactly; filling at once, the CLOB is sent $6.41 for at least 12.327 shares at 0.52
    expect(await sent({ qty: 12.34 })).toEqual(["GTC", "BUY", "6416800", "12340000"]);
    expect(await sent({ qty: 12.34, tif: "ioc" })).toEqual(["FAK", "BUY", "6410000", "12327000"]);
    // a limit above the book: what the 10 shares cost now ($1.60 at the 0.16 ask), at no more than 0.17 a share, not $1.70 of shares
    expect(await sent({ limitPrice: 0.17, tif: "ioc" })).toEqual(["FAK", "BUY", "1600000", "9411800"]);
    // a thin best ask, up to the limit: 10 at 0.52 and 9.24 at 0.53 cost $10.0972, sent as $10.09, at least 19.0378 shares at 0.53
    expect(await sent({ qty: 19.24, limitPrice: 0.53, tif: "fok" })).toEqual(["FOK", "BUY", "10090000", "19037800"]);
    // a sell is its shares either way, for at least the limit
    expect(await sent({ side: "sell", limitPrice: 0.49, tif: "ioc" })).toEqual(["FAK", "SELL", "10000000", "4900000"]);
    expect(await sent({ symbol: `${FED_SLUG}:Yes`, side: "sell", qty: 12.34, limitPrice: 0.517, tif: "fok" })).toEqual(["FOK", "SELL", "12340000", "6379780"]);
  });

  it("post-only goes on a GTC limit order as `postOnly: true`, last in the body as the unified client sends it, and outside the signed order", async () => {
    const { t, seen } = await pm({ answers: withPost() });
    const st = ok(await t.place(order({ postOnly: true })));
    const { req, body } = posted(seen);
    expect(req.body).toBe(`${V.postOrderBody.slice(0, -1)},"postOnly":true}`);
    expect(req.headers.POLY_SIGNATURE).toBe(polyHmac(SECRET, 1791225442, "POST", "/order", req.body));
    expect([body.orderType, body.postOnly, body.order.signature]).toEqual(["GTC", true, V.eoaOrderSig]);
    expect(st.native).toMatchObject({ clientId: CLIENT_ID, orderType: "GTC", postOnly: true });
    seen.splice(0);
    ok(await t.place(order({ tif: "gtc", postOnly: true, side: "sell" })));
    expect(posted(seen).body).toMatchObject({ orderType: "GTC", postOnly: true, order: { side: "SELL", signature: V.sellOrderSig } });
    // false is not sent at all
    seen.splice(0);
    ok(await t.place(order({ postOnly: false })));
    expect(posted(seen).req.body).toBe(V.postOrderBody);
  });

  it("what the CLOB does not take is refused before anything is sent, the location check included: post-only that takes, a market order that rests, stops, reduce-only, day", async () => {
    const { t, seen } = await pm({ answers: withPost() });
    const refused = async (o: Partial<OrderRequest>) => {
      const r = refusal(await t.place(order(o)));
      expect(r.code).toBe("E_VENUE_ORDER_INVALID");
      return r.message;
    };
    const market = { type: "market" as const, limitPrice: undefined, worstPrice: 0.17 };
    expect(await refused({ tif: "ioc", postOnly: true })).toBe("Polymarket: post-only is for an order that rests (gtc): a fill-and-kill or fill-or-kill order takes from the book at once");
    expect(await refused({ tif: "fok", postOnly: true })).toBe("Polymarket: post-only is for an order that rests (gtc): a fill-and-kill or fill-or-kill order takes from the book at once");
    expect(await refused({ ...market, postOnly: true })).toBe("Polymarket: a market order takes from the book: only a limit order may be post-only");
    expect(await refused({ ...market, tif: "gtc" })).toBe("Polymarket: a market order here fills at once, fill-and-kill (ioc) or fill-or-kill (fok): an order that rests is a limit order");
    expect(await refused({ tif: "day" })).toBe("Polymarket: an order here is good till canceled (gtc), fill-and-kill (ioc) or fill-or-kill (fok), not day");
    expect(await refused({ tif: "constructor" as never })).toBe("Polymarket: an order here is good till canceled (gtc), fill-and-kill (ioc) or fill-or-kill (fok), not constructor");
    expect(await refused({ type: "stop", limitPrice: undefined, stopPrice: 0.6, worstPrice: 0.62 })).toBe("Polymarket: the CLOB takes limit and market orders, not stop orders: it has no stop or trigger order");
    expect(await refused({ type: "stop_limit", stopPrice: 0.6 })).toBe("Polymarket: the CLOB takes limit and market orders, not stop-limit orders: it has no stop or trigger order");
    expect(await refused({ stopPrice: 0.6 })).toBe("Polymarket: the CLOB has no stop orders, so an order there carries no stop price");
    expect(await refused({ side: "sell", reduceOnly: true })).toBe("Polymarket: the CLOB has no reduce-only flag (a sell there can only be of shares the wallet holds, so it never opens a position)");
    expect(seen).toHaveLength(0);
  });

  it("the CLOB's own no to them: a post-only order that would cross the book, a fill-or-kill it cannot fill, post-only mode after a restart", async () => {
    const placeWith = async (answer: Answer, o: Partial<OrderRequest>) => {
      const { t, seen } = await pm({ answers: withPost(answer, { [`GET ${CLOB}/book?token_id=${YES}`]: DEEP_AT_52 }) });
      return { r: refusal(await t.place(order(o))), seen };
    };
    const cross = await placeWith(json({ error: "invalid post-only order: order crosses book" }, 400), { postOnly: true });
    expect([cross.r.code, cross.r.message]).toEqual(["E_VENUE_ORDER_INVALID", "Polymarket: invalid post-only order: order crosses book"]);
    expect((await placeWith(json({ error: "order couldn't be fully filled. FOK orders are fully filled or killed." }, 400), { tif: "fok" })).r.code).toBe("E_VENUE_REJECTED");
    // the matching engine's 500 for a fill-or-kill is an answer, not silence: the order is not looked up under its hash
    const killed = await placeWith(json({ error: "FOK orders are filled or killed" }, 500), { tif: "fok" });
    expect(killed.r.code).toBe("E_VENUE_REJECTED");
    expect(calls(killed.seen).at(-1)).toBe(`POST ${CLOB}/order`);
    const restart = await placeWith(json({ error: "post-only mode: only post-only orders and cancels are allowed", code: "post_only_mode", retry_after_seconds: 79 }, 503), { tif: "ioc" });
    expect([restart.r.code, restart.r.native]).toEqual(["E_VENUE_UNREACHABLE", { status: 503, said: "post-only mode: only post-only orders and cancels are allowed", code: "post_only_mode", retryAfterSeconds: 79 }]);
  });
});

// ---- what became of it ------------------------------------------------------------------------------------

describe("what became of an order", () => {
  it("GET /data/order/{id} with the spec's HMAC; every status Polymarket has, in the account's words; the fill price from the trades", async () => {
    const takerTrade = { id: "t-1", taker_order_id: V.eoaOrderHash, market: IRAN_CID, asset_id: YES, side: "BUY", size: "6", price: "0.51", status: "CONFIRMED", trader_side: "TAKER", maker_orders: [] };
    const makerTrade = { id: "t-2", taker_order_id: "0xother", market: IRAN_CID, asset_id: NO, side: "BUY", size: "4", price: "0.48", status: "MINED", trader_side: "MAKER", maker_orders: [{ order_id: V.eoaOrderHash, matched_amount: "4", price: "0.52", asset_id: YES, outcome: "Yes", side: "BUY" }] };
    const failed = { ...takerTrade, id: "t-3", size: "100", price: "0.99", status: "FAILED" };
    const states = ["LIVE", "LIVE", "MATCHED", "CANCELED", "CANCELED_MARKET_RESOLVED", "INVALID", "ORDER_STATUS_LIVE", "DELAYED", "EXPIRED"];
    const matched = ["0", "4", "10", "3", "0", "0", "0", "0", "0"];
    const { t, seen } = await pm({ answers: { [`GET ${CLOB}/data/order/${V.eoaOrderHash}`]: states.map((s, i) => json(ORDER({ status: s, size_matched: matched[i] }))), [`GET ${CLOB}/data/trades?market=${IRAN_CID}`]: json({ limit: 100, count: 3, next_cursor: "LTE=", data: [takerTrade, makerTrade, failed] }) } });
    const got: OrderState[] = [];
    for (let i = 0; i < states.length; i++) got.push(ok(await t.status(V.eoaOrderHash, `${IRAN_SLUG}:Yes`)));
    expect(got.map((s) => [s.status, s.filledQty])).toEqual([["open", 0], ["partial", 4], ["filled", 10], ["canceled", 3], ["canceled", 0], ["rejected", 0], ["open", 0], ["pending", 0], ["expired", 0]]);
    // (6 × 0.51 + 4 × 0.52) / 10, the failed trade left out
    expect(got[1]!.avgPrice).toBe(0.514);
    expect(got[2]!.avgPrice).toBe(0.514);
    const first = seen[0]!;
    expect([first.method, first.url, first.body]).toEqual(["GET", `${CLOB}/data/order/${V.eoaOrderHash}`, undefined]);
    expect(first.headers).toMatchObject({ POLY_ADDRESS: EOA, POLY_SIGNATURE: V.getOrderHmac, POLY_TIMESTAMP: "1791225442", POLY_API_KEY: API_KEY, POLY_PASSPHRASE: PASSPHRASE });
    expect(JSON.stringify(got)).not.toContain(API_KEY);
    expect(got[0]!.native).toMatchObject({ id: V.eoaOrderHash, status: "LIVE", original_size: "10", price: "0.52" });
  });

  it("an order Polymarket does not have is unknown; an id that cannot be one is not even asked", async () => {
    const { t, seen } = await pm({ answers: { [`GET ${CLOB}/data/order/${V.eoaOrderHash}`]: json({ error: "Order not found" }, 404) } });
    const gone = refusal(await t.status(V.eoaOrderHash, `${IRAN_SLUG}:Yes`));
    expect([gone.code, gone.detail]).toEqual(["E_ACCOUNT_ORDER_UNKNOWN", { order: V.eoaOrderHash }]);
    expect(refusal(await t.status("ord-0001", `${IRAN_SLUG}:Yes`)).code).toBe("E_ACCOUNT_ORDER_UNKNOWN");
    expect(seen).toHaveLength(1);
  });
});

describe("cancelling", () => {
  it("DELETE /order with the order's id as its body (the spec's HMAC); the order is read back as it stands", async () => {
    const { t, seen } = await pm({ answers: { [`DELETE ${CLOB}/order`]: json({ canceled: [V.eoaOrderHash], not_canceled: {} }), [`GET ${CLOB}/data/order/${V.eoaOrderHash}`]: json(ORDER({ status: "CANCELED", size_matched: "2" })), [`GET ${CLOB}/data/trades?market=${IRAN_CID}`]: json({ next_cursor: "LTE=", data: [] }) } });
    const st = ok(await t.cancel(V.eoaOrderHash, `${IRAN_SLUG}:Yes`));
    expect([st.status, st.filledQty]).toEqual(["canceled", 2]);
    const del = seen[0]!;
    expect([del.method, del.url, del.body]).toEqual(["DELETE", `${CLOB}/order`, `{"orderID":"${V.eoaOrderHash}"}`]);
    expect(del.headers).toMatchObject({ POLY_ADDRESS: EOA, POLY_SIGNATURE: V.deleteHmac, POLY_TIMESTAMP: "1791225442", POLY_API_KEY: API_KEY, POLY_PASSPHRASE: PASSPHRASE, "content-type": "application/json" });
  });

  it("not canceled: already matched is read back as filled; not found is unknown; a delay window keeps Polymarket's words", async () => {
    const notCanceled = (why: string) => json({ canceled: [], not_canceled: { [V.eoaOrderHash]: why } });
    const { t } = await pm({ answers: { [`DELETE ${CLOB}/order`]: [notCanceled("order already matched"), notCanceled("Order not found or already canceled"), notCanceled("order is in a matching delay and cannot be canceled")], [`GET ${CLOB}/data/order/${V.eoaOrderHash}`]: [json(ORDER({ status: "MATCHED", size_matched: "10" })), json({ error: "Order not found" }, 404)], [`GET ${CLOB}/data/trades?market=${IRAN_CID}`]: json({ next_cursor: "LTE=", data: [] }) } });
    expect(ok(await t.cancel(V.eoaOrderHash, ""))).toMatchObject({ status: "filled", filledQty: 10 });
    expect(refusal(await t.cancel(V.eoaOrderHash, "")).code).toBe("E_ACCOUNT_ORDER_UNKNOWN");
    const delayed = refusal(await t.cancel(V.eoaOrderHash, ""));
    expect([delayed.code, delayed.message]).toEqual(["E_VENUE_REJECTED", `Polymarket did not cancel ${V.eoaOrderHash}: order is in a matching delay and cannot be canceled`]);
    expect(refusal(await t.cancel("not-an-order", "")).code).toBe("E_ACCOUNT_ORDER_UNKNOWN");
  });
});

// ---- refusals -------------------------------------------------------------------------------------------

describe("Polymarket's refusals, in its own words", () => {
  const placeWith = async (answer: Answer) => {
    const { t, seen } = await pm({ answers: withPost(answer) });
    return { r: await t.place(order()), seen, t };
  };

  it("not enough balance or allowance — as an error, or as an order taken in and not placed", async () => {
    const a = refusal((await placeWith(json({ error: "not enough balance / allowance" }, 400))).r);
    expect([a.code, a.message, a.native]).toEqual(["E_VENUE_INSUFFICIENT", "Polymarket: not enough balance / allowance", { status: 400, said: "not enough balance / allowance" }]);
    const b = refusal((await placeWith(json({ success: false, errorMsg: "not enough balance / allowance", orderID: "", status: "", makingAmount: "", takingAmount: "" }))).r);
    expect(b.code).toBe("E_VENUE_INSUFFICIENT");
  });

  it("a size, a tick or a payload the market does not take", async () => {
    expect(refusal((await placeWith(json({ error: `order ${V.eoaOrderHash} is invalid. Size (1) lower than the minimum: 5` }, 400))).r)).toMatchObject({ code: "E_VENUE_ORDER_INVALID", message: `Polymarket: order ${V.eoaOrderHash} is invalid. Size (1) lower than the minimum: 5` });
    expect(refusal((await placeWith(json({ error: `order ${V.eoaOrderHash} is invalid. Price (0.525) breaks minimum tick size rule: 0.01` }, 400))).r).code).toBe("E_VENUE_ORDER_INVALID");
    expect(refusal((await placeWith(json({ error: "Invalid order payload" }, 400))).r).code).toBe("E_VENUE_ORDER_INVALID");
  });

  it("a key that may not trade here: the order's signer is not the key's, the address is banned or close-only — the key's id never shown", async () => {
    const who = refusal((await placeWith(json({ error: `the order signer address has to be the address of the API KEY ${API_KEY}` }, 400))).r);
    expect(who.code).toBe("E_VENUE_BAD_SIGNER");
    expect(who.message).toContain('the key file\'s "funderAddress" and "signatureType" say who makes the order and who signs it');
    expect(refusal((await placeWith(json({ error: `'${EOA}' address in closed only mode` }, 400))).r).code).toBe("E_VENUE_PERMISSION");
    expect(refusal((await placeWith(json({ error: `'${EOA}' address banned` }, 400))).r).code).toBe("E_VENUE_PERMISSION");
  });

  it("the region: the location check before the order says blocked, so nothing is sent; the CLOB's own region refusal is the same answer", async () => {
    const { t, seen } = await pm({ answers: withPost(), geo: [json({ blocked: false }), json({ blocked: true, ip: "203.0.113.7", country: "US", region: "PA" })] });
    // the connection asked once; the order asks again, and is told no
    const geo = refusal(await t.place(order()));
    expect([geo.code, geo.message]).toEqual(["E_VENUE_GEOBLOCKED", GEO_WORDS]);
    expect(calls(seen)).toEqual([`GET ${GEO}`]);
    const clob = refusal((await placeWith(json({ error: "Trading restricted in your region" }, 403))).r);
    expect([clob.code, clob.message]).toEqual(["E_VENUE_GEOBLOCKED", GEO_WORDS]);
  });

  it("credentials Polymarket no longer takes (asked for again next time), the rate limit, a restart, cancel-only, a fill-and-kill with nothing to match", async () => {
    const { t, seen } = await pm({ answers: withPost([json({ error: "Unauthorized/Invalid api key" }, 401), LIVE()]) });
    expect(refusal(await t.place(order())).code).toBe("E_VENUE_UNAUTHORIZED");
    ok(await t.place(order()));
    expect(calls(seen).filter((c) => c.includes("/auth/"))).toEqual([`GET ${CLOB}/auth/derive-api-key`]);
    expect(refusal((await placeWith(json({ error: "Too Many Requests" }, 429))).r).code).toBe("E_VENUE_UNREACHABLE");
    expect(refusal((await placeWith({ status: 425, body: undefined, text: "" })).r).code).toBe("E_VENUE_UNREACHABLE");
    expect(refusal((await placeWith(json({ error: "Trading is currently cancel-only. New orders are not accepted, but cancels are allowed." }, 503))).r).code).toBe("E_VENUE_MARKET_CLOSED");
    expect(refusal((await placeWith(json({ error: "no orders found to match with FAK order. FAK orders are partially filled or killed if no match is found." }, 400))).r).code).toBe("E_VENUE_REJECTED");
    expect(refusal((await placeWith(json({ error: "something new" }, 400))).r)).toMatchObject({ code: "E_VENUE_REJECTED", message: "Polymarket: something new" });
  });
});

// ---- what is held -----------------------------------------------------------------------------------------

/** one row of the Data API's positions, every field its OpenAPI requires (data-api.polymarket.com/v2/openapi.json, Position); values made up */
const ROW = (over: Record<string, unknown> = {}) => ({ proxy_wallet: EOA.toLowerCase(), token_id: YES, condition_id: IRAN_CID, current_size: 40, avg_price: 0.15, entry_cost_usdc: 6, entry_fees_usdc: 0.12, total_cost_usdc: 6.12, current_price: 0.155, current_value: 6.2, total_size: 40, realized_pnl: 0, unrealized_pnl: 0.2, total_pnl: 0.2, percent_pnl: 3.333, percent_realized_pnl: 3.333, status: "OPEN", redeemable: false, mergeable: false, negative_risk: false, archived: false, title: "Will the U.S. invade Iran before 2027?", slug: IRAN_SLUG, icon: "https://example.com/made-up-icon.png", event_id: "16085", event_slug: IRAN_SLUG, outcome: "Yes", outcome_index: 0, opposite_outcome: "No", opposite_token_id: NO, end_date: "2026-12-31", last_event_at: 1791225000, first_entry_at: 1791000000, name: "made-up-profile-name", profile_image: "", verified: false, ...over });
const positionsPage = (data: unknown[], next: string | null = null) => json({ data, pagination: { limit: 200, offset: 0, has_more: next !== null, next_cursor: next } });

describe("what is held", () => {
  const FIRST = `${DATA}/positions?user=${EOA}&limit=200`;

  it("the Data API's positions for the wallet that holds the money, in the account's words: long, in shares, entry and mark, worth and unrealized", async () => {
    const fedNo = ROW({ token_id: FED_NO, condition_id: FED_CID, title: FED.question, slug: FED_SLUG, outcome: "No", outcome_index: 1, current_size: 12.5, avg_price: 0.5, current_price: 0.48, current_value: 6, unrealized_pnl: -0.25, negative_risk: true });
    const lost = ROW({ token_id: "3333333333333333333333", title: "A made-up market that resolved?", slug: "a-made-up-market-that-resolved", outcome: "No", current_size: 10, avg_price: 0.3, current_price: 0, current_value: 0, unrealized_pnl: -3, status: "REDEEMABLE", redeemable: true });
    const exited = ROW({ slug: "a-made-up-market-exited", current_size: 0, current_value: 0, status: "CLOSED" });
    // a row Gamma did not enrich: the token names it, and what the Data API leaves out stays unknown rather than zero
    const unnamed = ROW({ token_id: "4444444444444444444444", title: "", slug: "", outcome: "", current_size: 2, avg_price: 0, current_price: null, current_value: null, unrealized_pnl: null });
    const { t, seen } = await pm({ answers: { [`GET ${FIRST}`]: positionsPage([ROW(), fedNo, lost, exited, unnamed]), ...MARKET_ANSWERS } });
    const held = ok(await t.positions!());
    // a public read: no location check, nothing to the CLOB, nothing signed
    expect(calls(seen)).toEqual([`GET ${FIRST}`]);
    expect(seen[0]!.headers).toEqual({ accept: "application/json" });
    expect(held.map((p) => ({ ...p, native: undefined }))).toEqual([
      { symbol: `${IRAN_SLUG}:Yes`, name: "Will the U.S. invade Iran before 2027? · Yes", kind: "event", side: "long", qty: 40, entryPrice: 0.15, markPrice: 0.155, usd: 6.2, unrealizedUsd: 0.2 },
      { symbol: `${FED_SLUG}:No`, name: `${FED.question} · No`, kind: "event", side: "long", qty: 12.5, entryPrice: 0.5, markPrice: 0.48, usd: 6, unrealizedUsd: -0.25 },
      { symbol: "a-made-up-market-that-resolved:No", name: "A made-up market that resolved? · No", kind: "event", side: "long", qty: 10, entryPrice: 0.3, markPrice: 0, usd: 0, unrealizedUsd: -3 },
      { symbol: "4444444444444444444444", name: "4444444444444444444444 · ?", kind: "event", side: "long", qty: 2, entryPrice: undefined, markPrice: undefined, usd: undefined, unrealizedUsd: undefined },
    ]);
    expect(held[0]!.native).toEqual({ token_id: YES, condition_id: IRAN_CID, slug: IRAN_SLUG, outcome: "Yes", outcome_index: 0, status: "OPEN", redeemable: false, mergeable: false, negative_risk: false, end_date: "2026-12-31", current_size: 40, avg_price: 0.15, current_price: 0.155, current_value: 6.2, entry_cost_usdc: 6, entry_fees_usdc: 0.12, realized_pnl: 0, unrealized_pnl: 0.2 });
    expect(held[2]!.native).toMatchObject({ status: "REDEEMABLE", redeemable: true });
    expect(JSON.stringify(held)).not.toContain("made-up-profile-name");
    // the symbol is one market() takes
    expect(ok(await t.market(held[0]!.symbol)).symbol).toBe(held[0]!.symbol);
  });

  it("page after page by the cursor with the same `user`: the wallet that holds the money (a Proxy wallet here), not the key that signs", async () => {
    const first = `${DATA}/positions?user=${WALLET}&limit=200`;
    const next = `${first}&cursor=${encodeURIComponent("eyJrIjoicG9zIn0=")}`;
    const { t, seen } = await pm({ key: { privateKey: HARDHAT_0, funderAddress: WALLET, signatureType: "1" }, answers: { [`GET ${first}`]: positionsPage([ROW({ proxy_wallet: WALLET.toLowerCase() })], "eyJrIjoicG9zIn0="), [`GET ${next}`]: positionsPage([ROW({ proxy_wallet: WALLET.toLowerCase(), token_id: NO, outcome: "No", outcome_index: 1, current_size: 3, current_price: 0.845, current_value: 2.535 })]) } });
    const held = ok(await t.positions!());
    expect(calls(seen)).toEqual([`GET ${first}`, `GET ${next}`]);
    expect(held.map((p) => [p.symbol, p.qty, p.usd])).toEqual([[`${IRAN_SLUG}:Yes`, 40, 6.2], [`${IRAN_SLUG}:No`, 3, 2.535]]);
  });

  it("nothing held is an empty list; the Data API's no is said in its words: busy, down, a request it will not serve", async () => {
    // the first answer is the connection's own read of the balances
    const { t } = await pm({ answers: { [`GET ${FIRST}`]: [json(SOME_POSITIONS), positionsPage([]), json({ error: "rate limited", code: "rate_limited", retryable: true, trace_id: "t-1" }, 429), json({ error: "request timed out", code: "request_timeout", retryable: true, trace_id: "t-2" }, 503), json({ error: "invalid user", code: "invalid_request", retryable: false, trace_id: "t-3", parameter: "user" }, 400)] } });
    expect(ok(await t.positions!())).toEqual([]);
    expect(refusal(await t.positions!())).toMatchObject({ code: "E_VENUE_UNREACHABLE", message: "Polymarket is rate-limiting this machine: try again in a minute" });
    expect(refusal(await t.positions!())).toMatchObject({ code: "E_VENUE_UNREACHABLE", message: "Polymarket did not answer" });
    expect(refusal(await t.positions!())).toMatchObject({ code: "E_VENUE_REJECTED", message: "Polymarket: invalid user", native: { status: 400, said: "invalid user", code: "invalid_request" } });
  });
});

describe("the L2 HMAC", () => {
  it("matches the spec's vectors: seconds, method, path without its query, the exact body; URL-safe base64 that keeps its padding", () => {
    const ts = 1791225442;
    expect(polyHmac(SECRET, ts, "GET", "/data/orders")).toBe(V.getOpenOrdersHmac);
    expect(polyHmac(SECRET, ts, "DELETE", "/cancel-all")).toBe(V.cancelAllHmac);
    expect(polyHmac(SECRET, ts, "GET", "/balance-allowance/update")).toBe(V.balanceUpdateHmac);
    expect(polyHmac(SECRET, ts, "GET", `/data/order/${V.eoaOrderHash}`)).toBe(V.getOrderHmac);
    expect(polyHmac(SECRET, ts, "DELETE", "/order", `{"orderID":"${V.eoaOrderHash}"}`)).toBe(V.deleteHmac);
    expect(polyHmac(SECRET, ts, "POST", "/order", V.postOrderBody)).toBe(V.postOrderHmac);
    // the secret without its padding, or in plain base64, is the same key
    expect(polyHmac(SECRET.replace(/=+$/, ""), ts, "GET", "/data/orders")).toBe(V.getOpenOrdersHmac);
    expect(polyHmac(SECRET.replace(/-/g, "+").replace(/_/g, "/"), ts, "GET", "/data/orders")).toBe(V.getOpenOrdersHmac);
  });
});
