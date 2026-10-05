/** The live connections this service can make, as one table: what each needs (a key file or an address), which venues already on the
 * account it is the real side of, and how it is opened. Adding a venue with an interface is adding a row here and a source next to it.
 *
 *   live:exchange:<id>   any exchange the unified library covers (binance, okx, bybit, kraken …)      a key file
 *   live:alpaca          a brokerage account                                                          a key file
 *   live:kalshi          a prediction-market account                                                  a key file
 *   live:hyperliquid     a perp DEX account                                                           an address
 *   live:polymarket      a prediction-market wallet                                                   an address
 *   live:wallet          any EVM wallet: an exchange's own wallet, a browser wallet, a hardware one   an address
 *   live:ondo            a tokenised-fund position                                                    an address
 *
 * Every one of them reads and none of them writes.
 */
import { isRefusal, type Refusal } from "../../core/errors.ts";
import { no } from "../refuse.ts";
import type { LiveOption, LiveOptions } from "../account/exchange.ts";
import { hyperliquidSource, ondoSource, polymarketSource, walletSource, type AddressRequest } from "./address.ts";
import { ALPACA_KEY, alpacaSource } from "./alpaca.ts";
import type { ChainReader } from "./chain.ts";
import { defaultKeyRef, loadKeyFile } from "./credentials.ts";
import { EXCHANGE_KEY, exchangeSource, type OpenExchange } from "./exchange.ts";
import { KALSHI_KEY, kalshiSource } from "./kalshi.ts";
import { metamaskSource, type RunMm } from "./metamask.ts";
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
    const opened = await alpacaSource({ venue: req.venue, label: req.label, reference: req.reference || defaultKeyRef(req.venue), key, http: deps.http });
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

const wallet = byAddress("wallet", "Wallet · any EVM wallet, by its address", "Connect a browser wallet (OKX Wallet, Binance Wallet, MetaMask …) and it signs one sentence to show the address is yours; or paste an address to watch it.", ["metamask", "okx-wallet"], walletSource, true);
const hyperliquid = byAddress("hyperliquid", "Hyperliquid · by the account's address", "The address of the Hyperliquid account itself (the master account, not an API wallet).", ["hyperliquid"], hyperliquidSource, true);
const polymarket = byAddress("polymarket", "Polymarket · by the account wallet's address", "The account wallet Polymarket shows in the profile menu (the deposit or proxy wallet), not the key that signs for it.", ["polymarket"], polymarketSource, false);
const ondo = byAddress("ondo", "Ondo · OUSG at an address", "The Ethereum address that holds the OUSG.", ["ondo"], ondoSource, false);

const metamask: Connector = {
  kind: "metamask",
  label: "MetaMask Agent Wallet · the mm command line on this machine",
  needs: "cli",
  example: "Reads through MetaMask's own mm command line, signed in on this machine: nothing to paste. Check that mm wallet show works in a terminal first.",
  venues: ["metamask"],
  async open(req, deps) {
    const opened = await metamaskSource({ venue: req.venue, label: req.label, run: deps.mm });
    return isRefusal(opened) ? opened : { ...opened, summary: opened.source.probe.note };
  },
};

export const CONNECTORS: Connector[] = [exchange, alpaca, kalshi, metamask, wallet, hyperliquid, polymarket, ondo];

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

export async function openLive(req: LiveRequest, deps: LiveDeps): Promise<LiveOpened | Refusal> {
  const parsed = parseConnector(req.connector);
  const c = parsed ? CONNECTORS.find((x) => x.kind === parsed.kind) : undefined;
  if (!parsed || !c) return no("E_WALLET_UNKNOWN_VENUE", { venue: req.venue, message: `there is no live connection called "${req.connector}"; there are: ${CONNECTORS.map((x) => `live:${x.kind}`).join(", ")}`, detail: { connectors: CONNECTORS.map((x) => `live:${x.kind}`) } });
  return c.open({ ...req, variant: parsed.variant }, deps);
}
