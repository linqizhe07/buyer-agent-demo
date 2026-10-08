/** The live connections this service can make, as one table: what each needs (a key file or an address), which venues already on the
 * account it is the real side of, and how it is opened. Adding a venue with an interface is adding a row here and a source next to it.
 *
 *   live:exchange:<id>   any exchange the unified library covers (binance, okx, bybit, kraken …)      a key file
 *   live:alpaca          a brokerage account                                                          a key file
 *   live:robinhood       Robinhood's investing accounts, through Robinhood's MCP server               Robinhood's own sign-in
 *   live:robinhood-crypto  a Robinhood crypto account                                                 a key file
 *   live:kalshi          a prediction-market account                                                  a key file
 *   live:hyperliquid     a perp DEX account                                                           an address
 *   live:hyperliquid-trade  the same account, traded through an API wallet that cannot withdraw;     a key file
 *                        Hyperliquid's own line (its Terms of Use §1.6) is held to where the user is first
 *   live:polymarket      a prediction-market wallet                                                   an address
 *   live:polymarket-trade  the same wallet, traded on Polymarket's CLOB                              a key file
 *   live:wallet          any EVM wallet: an exchange's own wallet, a browser wallet, a hardware one,  an address
 *                        a Robinhood Wallet (its Stock Tokens on Robinhood Chain are read too)
 *   live:ondo            a tokenised-fund position                                                    an address
 *
 * Every one of them reads; what some of them can also be asked to move, on the owner's signature, is in writes.ts.
 */
import { isRefusal, type Refusal } from "../../core/errors.ts";
import { no } from "../refuse.ts";
import type { LiveOption, LiveOptions } from "../account/exchange.ts";
import { hyperliquidSource, ondoSource, polymarketSource, walletSource, type AddressRequest } from "./address.ts";
import { ALPACA_KEY, alpacaSource } from "./alpaca.ts";
import type { ChainReader, ChainSender } from "./chain.ts";
import { defaultKeyRef, loadKeyFile, type KeyShape } from "./credentials.ts";
import { EXCHANGE_KEY, exchangeSource, type OpenExchange } from "./exchange.ts";
import { HYPERLIQUID_TRADE_KEY, hyperliquidTradeSource, type OpenHyperliquid } from "./hyperliquid-trade.ts";
import { KALSHI_KEY, kalshiSource } from "./kalshi.ts";
import { locator } from "./location.ts";
import { metamaskSource, type RunMm } from "./metamask.ts";
import { POLYMARKET_TRADE_KEY, polymarketTradeSource } from "./polymarket-clob.ts";
import { ROBINHOOD_CRYPTO_KEY, realMcp, robinhoodCryptoSource, robinhoodStocksSource, type OpenMcp } from "./robinhood.ts";
import type { OAuthSignIn } from "./signin.ts";
import type { Price } from "./prices.ts";
import type { WalletProofs } from "./proof.ts";
import type { Http, LiveBalance, LiveSource } from "./types.ts";

export interface LiveDeps {
  /** where key files live */
  home: string;
  http: Http;
  /** the real clock */
  clock: () => number;
  proofs: WalletProofs;
  /** reads addresses from the chains */
  chain: ChainReader;
  /** a dollar price for what a source cannot price itself */
  price: Price;
  /** the mm command line (MetaMask Agent Wallet) */
  mm: RunMm;
  /** a stand-in for the exchange library (tests) */
  openExchange?: OpenExchange | undefined;
  /** the exchange library's Hyperliquid client with a stand-in network (tests) */
  openHyperliquid?: OpenHyperliquid | undefined;
  /** the sign-in at a venue that speaks OAuth to MCP clients, by connector kind (Robinhood) */
  signIn?: ((kind: string) => OAuthSignIn | undefined) | undefined;
  /** an MCP client to a venue's own server; a stand-in in tests */
  openMcp?: OpenMcp | undefined;
  /** what sends a transfer from an agent wallet the account holds the key of (chain.ts publicSender); a stand-in in tests */
  sender?: ChainSender | undefined;
}

export interface LiveRequest {
  venue: string;
  /** `live:<kind>[:<variant>]` */
  connector: string;
  label: string;
  /** a key file's path inside the home directory, or an address */
  reference: string;
}

export interface LiveOpened {
  source: LiveSource;
  /** the balances read while connecting */
  first: LiveBalance[];
  /** what the venue said, for the owner */
  summary: string;
  /** a price for what the source could not price itself */
  price?: ((asset: string) => Promise<number | undefined>) | undefined;
}

type Opener = (req: LiveRequest & { variant: string }, deps: LiveDeps) => Promise<LiveOpened | Refusal>;

interface Connector {
  kind: string;
  label: string;
  needs: LiveOption["needs"];
  example: string;
  /** venues the simulation opens with that this is the real side of */
  venues: string[];
  open: Opener;
}

const said = (source: LiveSource): string => `${source.probe.can.length ? `the venue says this credential can ${source.probe.can.join(", ")}` : "connected"} · ${source.probe.note}`;

const exchange: Connector = {
  kind: "exchange",
  label: "Exchange account · API key",
  needs: "key-file",
  example: EXCHANGE_KEY.example,
  venues: ["binance", "okx", "bybit", "kraken"],
  async open(req, deps) {
    const exchangeId = req.variant || req.venue;
    const key = loadKeyFile(deps.home, req.reference, EXCHANGE_KEY, req.venue);
    if (isRefusal(key)) return key;
    const opened = await exchangeSource({ venue: req.venue, exchangeId, label: req.label, reference: req.reference || defaultKeyRef(req.venue), key, open: deps.openExchange });
    if (isRefusal(opened)) return opened;
    return { source: opened.source, first: opened.first, summary: said(opened.source) };
  },
};

const alpaca: Connector = {
  kind: "alpaca",
  label: "Alpaca · brokerage account, API key",
  needs: "key-file",
  example: ALPACA_KEY.example,
  venues: ["alpaca"],
  async open(req, deps) {
    const key = loadKeyFile(deps.home, req.reference, ALPACA_KEY, req.venue);
    if (isRefusal(key)) return key;
    const opened = await alpacaSource({ venue: req.venue, label: req.label, reference: req.reference || defaultKeyRef(req.venue), key, http: deps.http, clock: deps.clock });
    return isRefusal(opened) ? opened : { ...opened, summary: said(opened.source) };
  },
};

const robinhood: Connector = {
  kind: "robinhood",
  label: "Robinhood · investing accounts, through Robinhood's own sign-in",
  needs: "sign-in",
  example: "Robinhood's own page opens: you sign in there and approve this account. It reads every Robinhood account through Robinhood's MCP server, and trades only in your Agentic account, only on your signature or inside a limit you give an agent.",
  venues: [],
  async open(req, deps) {
    const signIn = deps.signIn?.("robinhood");
    if (!signIn) return no("E_VENUE_UNREACHABLE", { venue: req.venue, message: "this server has no Robinhood sign-in" });
    const opened = await robinhoodStocksSource({ venue: req.venue, label: req.label, token: () => signIn.token(req.reference), open: deps.openMcp ?? realMcp });
    return isRefusal(opened) ? opened : { ...opened, summary: said(opened.source) };
  },
};

const robinhoodCrypto: Connector = {
  kind: "robinhood-crypto",
  label: "Robinhood Crypto · API key",
  needs: "key-file",
  example: ROBINHOOD_CRYPTO_KEY.example,
  venues: [],
  async open(req, deps) {
    const key = loadKeyFile(deps.home, req.reference, ROBINHOOD_CRYPTO_KEY, req.venue);
    if (isRefusal(key)) return key;
    const opened = await robinhoodCryptoSource({ venue: req.venue, label: req.label, reference: req.reference || defaultKeyRef(req.venue), key, http: deps.http, clock: deps.clock });
    return isRefusal(opened) ? opened : { ...opened, summary: said(opened.source) };
  },
};

const kalshi: Connector = {
  kind: "kalshi",
  label: "Kalshi · prediction-market account, API key",
  needs: "key-file",
  example: KALSHI_KEY.example,
  venues: ["kalshi"],
  async open(req, deps) {
    const key = loadKeyFile(deps.home, req.reference, KALSHI_KEY, req.venue);
    if (isRefusal(key)) return key;
    const opened = await kalshiSource({ venue: req.venue, label: req.label, reference: req.reference || defaultKeyRef(req.venue), key, home: deps.home, http: deps.http, clock: deps.clock });
    return isRefusal(opened) ? opened : { ...opened, summary: said(opened.source) };
  },
};

/** the four that are read by address: the same opening, a different source */
const byAddress = (kind: string, label: string, example: string, venues: string[], source: (r: AddressRequest) => Promise<{ source: LiveSource; first: LiveBalance[] } | Refusal>, priced: boolean): Connector => ({
  kind,
  label,
  needs: "address",
  example,
  venues,
  async open(req, deps) {
    const opened = await source({ venue: req.venue, label: req.label, address: req.reference, proven: deps.proofs.proven(req.reference)?.wallet, http: deps.http, chain: deps.chain });
    return isRefusal(opened) ? opened : { ...opened, summary: opened.source.probe.note, ...(priced ? { price: deps.price } : {}) };
  },
});

const wallet = byAddress("wallet", "Wallet · any EVM wallet, by its address", "Connect a browser wallet (OKX Wallet, Binance Wallet, MetaMask …) and it signs one sentence to show the address is yours; or paste an address to watch it — a Robinhood Wallet's too: its Stock Tokens on Robinhood Chain are read with the rest.", ["metamask", "okx-wallet"], walletSource, true);
const hyperliquid = byAddress("hyperliquid", "Hyperliquid · by the account's address", "The address of the Hyperliquid account itself (the master account, not an API wallet).", ["hyperliquid"], hyperliquidSource, true);
/** Hyperliquid to trade: an API wallet's key, which signs orders for the account and cannot withdraw, in a key file. Hyperliquid's own line
 * (its Terms of Use §1.6), held to where this user is now, comes before anything else — and before every order and leverage change */
const hyperliquidTrade: Connector = {
  kind: "hyperliquid-trade",
  label: "Hyperliquid · trading, with an API wallet that cannot withdraw",
  needs: "key-file",
  example: HYPERLIQUID_TRADE_KEY.example,
  venues: ["hyperliquid"],
  async open(req, deps) {
    const key = loadKeyFile(deps.home, req.reference, HYPERLIQUID_TRADE_KEY, req.venue);
    if (isRefusal(key)) return key;
    const opened = await hyperliquidTradeSource({ venue: req.venue, label: req.label, reference: req.reference || defaultKeyRef(req.venue), key, where: locator({ http: deps.http, clock: deps.clock }), clock: deps.clock, open: deps.openHyperliquid });
    // a spot token Hyperliquid has no dollar market for is priced like any other
    return isRefusal(opened) ? opened : { ...opened, summary: said(opened.source), price: deps.price };
  },
};
const polymarket = byAddress("polymarket", "Polymarket · by the account wallet's address", "The account wallet Polymarket shows in the profile menu (the deposit or proxy wallet), not the key that signs for it.", ["polymarket"], polymarketSource, false);
/** Polymarket to trade: the key that signs for the account wallet, in a key file. Polymarket's location check comes before anything else */
const polymarketTrade: Connector = {
  kind: "polymarket-trade",
  label: "Polymarket · trading, with the account wallet's key",
  needs: "key-file",
  example: POLYMARKET_TRADE_KEY.example,
  venues: ["polymarket"],
  async open(req, deps) {
    const key = loadKeyFile(deps.home, req.reference, POLYMARKET_TRADE_KEY, req.venue);
    if (isRefusal(key)) return key;
    const opened = await polymarketTradeSource({ venue: req.venue, label: req.label, reference: req.reference || defaultKeyRef(req.venue), key, http: deps.http, chain: deps.chain, clock: deps.clock });
    return isRefusal(opened) ? opened : { ...opened, summary: said(opened.source) };
  },
};
const ondo = byAddress("ondo", "Ondo · OUSG at an address", "The Ethereum address that holds the OUSG.", ["ondo"], ondoSource, false);

const metamask: Connector = {
  kind: "metamask",
  label: "MetaMask Agent Wallet · the mm command line on this machine",
  needs: "cli",
  example: "Reads through MetaMask's own mm command line, signed in on this machine: nothing to paste. Check that mm wallet show works in a terminal first.",
  venues: ["metamask"],
  async open(req, deps) {
    // the price values an earn vault whose asset is not a dollar stablecoin (without one, only stablecoin vaults are valued)
    const opened = await metamaskSource({ venue: req.venue, label: req.label, run: deps.mm, price: deps.price });
    return isRefusal(opened) ? opened : { ...opened, summary: opened.source.probe.note };
  },
};

export const CONNECTORS: Connector[] = [exchange, alpaca, robinhood, robinhoodCrypto, kalshi, metamask, wallet, hyperliquid, hyperliquidTrade, polymarket, polymarketTrade, ondo];

/** register a connector kind (the other sources add themselves here) */
export function register(c: Connector): void {
  if (!CONNECTORS.some((x) => x.kind === c.kind)) CONNECTORS.push(c);
}

export type { Connector };

export const parseConnector = (connector: string): { kind: string; variant: string } | undefined => {
  const m = /^live:([a-z0-9-]+)(?::([a-z0-9-]+))?$/.exec(connector);
  return m ? { kind: m[1]!, variant: m[2] ?? "" } : undefined;
};

/** what the page offers: every connector, and for each venue on the account the one that is its real side */
export function liveOptions(home: string): LiveOptions {
  const options: LiveOption[] = CONNECTORS.map((c) => ({ connector: `live:${c.kind}`, label: c.label, needs: c.needs, example: c.example, ...(c.needs === "key-file" ? { defaultRef: defaultKeyRef("<venue>") } : {}), venues: c.venues, kind: c.kind }));
  return { home, options };
}

/** the key file each kind of connection reads */
export const KEY_SHAPES: Record<string, KeyShape> = { exchange: EXCHANGE_KEY, alpaca: ALPACA_KEY, kalshi: KALSHI_KEY, "robinhood-crypto": ROBINHOOD_CRYPTO_KEY, "polymarket-trade": POLYMARKET_TRADE_KEY, "hyperliquid-trade": HYPERLIQUID_TRADE_KEY };

/** Is a key file ready for a connection? Where it is, whether only its owner can read it, which fields it is missing — the same checks a
 * connection makes, said before connecting so the page can say what to do next. Field NAMES are said; no value ever leaves this process.
 * `needs`: the fields this particular exchange asks for (OKX's passphrase), from the exchange library. */
export function keyFileStatus(home: string, kind: string, venue: string, ref: string, needs: string[] = []): { ready: boolean; path: string; fields: string[]; message: string; missing?: string[]; mode?: string } {
  const shape = KEY_SHAPES[kind];
  const where = ref.trim() || defaultKeyRef(venue);
  const path = where.startsWith("/") ? where : `${home.replace(/\/$/, "")}/${where}`;
  if (!shape) return { ready: false, path, fields: [], message: `a ${kind} connection does not read a key file` };
  const extra = needs.filter((n) => (shape.optional ?? []).includes(n) && !shape.required.includes(n));
  const fields = [...shape.required, ...extra];
  const r = loadKeyFile(home, where, { ...shape, required: fields }, venue);
  if (!isRefusal(r)) return { ready: true, path, fields, message: "the key file is ready" };
  const d = (r.detail ?? {}) as { missing?: string[]; mode?: string };
  return { ready: false, path, fields, message: r.message, ...(d.missing ? { missing: d.missing } : {}), ...(d.mode ? { mode: d.mode } : {}) };
}

export async function openLive(req: LiveRequest, deps: LiveDeps): Promise<LiveOpened | Refusal> {
  const parsed = parseConnector(req.connector);
  const c = parsed ? CONNECTORS.find((x) => x.kind === parsed.kind) : undefined;
  if (!parsed || !c) return no("E_WALLET_UNKNOWN_VENUE", { venue: req.venue, message: `there is no live connection called "${req.connector}"; there are: ${CONNECTORS.map((x) => `live:${x.kind}`).join(", ")}`, detail: { connectors: CONNECTORS.map((x) => `live:${x.kind}`) } });
  return c.open({ ...req, variant: parsed.variant }, deps);
}
