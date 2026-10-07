import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext, Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { KALSHI_SERIES } from "../../src/portfolio/live/categories.ts";
import { kalshiPublic, polymarketPublic, type Listing } from "../../src/portfolio/live/public-markets.ts";
import type { Http, HttpReply } from "../../src/portfolio/live/types.ts";

/** Review round 2, lens "public" (the keyless path with nothing connected): three findings against stand-ins, each written as the
 * behaviour the product promises, so the test FAILS on the current code and passes once the finding is fixed.
 *
 *   1. Kalshi "busiest first" read only the first page of GET /markets (Kalshi's own order: newest created first, 1000 a page), so a
 *      market that trades 150k contracts a day further down was not listed while a 5k-contract weather market on page 1 was. Live on
 *      2026-10-06: page 1's busiest was 5,666 contracts; KXFEDDECISION-26OCT-H0 151,820 was not in the listing. Fixed by reading a few
 *      busy SERIES (categories.ts KALSHI_SERIES) with GET /events?series_ticker=&with_nested_markets=true each, and never GET /markets
 *      as a whole: the Fed decision is one small answer, and the Predictions tab is a few hot markets, as the owner asked.
 *   2. mkLabel re-cases a short all-caps outcome name: Polymarket's "FURIA" (the team) is shown as "Furia", "USA" would be "Usa"
 *      (ui/markets.js:57).
 *   3. A Polymarket market whose endDate has passed but that Polymarket still lists as active, not closed and accepting orders (Gamma's own
 *      flags; "Will Lula win…" traded all day on 2026-10-06 with an endDate of 2026-10-05) is drawn with the countdown "Closed" while its
 *      venue line says open: the page's own inference contradicts the venue's words (ui/markets.js:47-48, :258-260).
 */

const NOW = Date.parse("2026-10-06T17:00:00.000Z");
const json = (body: unknown, status = 200): HttpReply => ({ status, body, text: JSON.stringify(body) });
const query = (url: string): Record<string, string> => Object.fromEntries(new URL(url).searchParams.entries());

function network(routes: Array<[string, HttpReply | ((url: string) => HttpReply)]>) {
  const sent: string[] = [];
  const http: Http = async (url) => {
    sent.push(url);
    const hit = routes.find(([k]) => url.includes(k));
    if (!hit) return json({ error: "not found" }, 404);
    return typeof hit[1] === "function" ? hit[1](url) : hit[1];
  };
  return { http, sent };
}

const kalshiMarket = (ticker: string, event: string, vol24h: number, title: string) => ({
  ticker,
  event_ticker: event,
  status: "active",
  title,
  yes_bid_dollars: "0.50",
  yes_ask_dollars: "0.52",
  no_bid_dollars: "0.48",
  no_ask_dollars: "0.50",
  last_price_dollars: "0.51",
  previous_price_dollars: "0.45",
  volume_24h_fp: String(vol24h),
  volume_fp: String(vol24h * 3),
  close_time: "2026-10-07T08:00:00Z",
});

describe("review2 · public (keyless) lens", () => {
  it("F1 · Kalshi's listing is its busiest markets by series, not the busiest of the newest 1000: the Fed decision, far down Kalshi's list, is listed", async () => {
    // Kalshi's GET /markets?status=open lists its newest markets first: on 2026-10-06 the first thousand held a 5,666-contract weather market
    // and nothing of the Fed. The series read asks GET /events?series_ticker= instead, where the Fed decision is one small answer
    const page1 = [kalshiMarket("KXTEMPMIAH-26OCT0613-T88.99", "KXTEMPMIAH-26OCT0613", 5_666, "Will the temp in Miami be above 88.99°?")];
    const fed = { event_ticker: "KXFEDDECISION-26OCT", series_ticker: "KXFEDDECISION", title: "Fed decision in Oct 2026?", category: "Economics", markets: [kalshiMarket("KXFEDDECISION-26OCT-H0", "KXFEDDECISION-26OCT", 151_820, "Will the Federal Reserve Hike rates by 0bps at their October 2026 meeting?")] };
    const net = network([
      ["/trade-api/v2/markets?", json({ markets: page1, cursor: "page2" })],
      ["/trade-api/v2/events?", (url) => json({ events: query(url).series_ticker === "KXFEDDECISION" ? [fed] : [], cursor: "" })],
    ]);
    const got = (await kalshiPublic({ http: net.http, clock: () => NOW }).listings({ limit: 10 })) as Listing[];
    const tickers = [...new Set(got.map((m) => m.symbol.split(":")[0]))];
    // the whole list is never read; each curated series is, once
    expect(net.sent.filter((u) => u.includes("/markets?"))).toEqual([]);
    expect(net.sent.filter((u) => u.includes("/events?series_ticker="))).toHaveLength(KALSHI_SERIES.length);
    expect(KALSHI_SERIES.map((s) => s.ticker)).toContain("KXFEDDECISION");
    // the Fed decision is listed, with its event and category; the weather market is not
    expect(tickers).toEqual(["KXFEDDECISION-26OCT-H0"]);
    expect(got[0]).toMatchObject({ symbol: "KXFEDDECISION-26OCT-H0:YES", category: "Economics", contracts24h: 151_820, event: { id: "KXFEDDECISION-26OCT", title: "Fed decision in Oct 2026?" } });
  });

  /** the Markets pane's scripts in a stand-in browser (the harness ui-markets.test.ts uses, cut to what these two checks need) */
  function page() {
    const PUBLIC = fileURLToPath(new URL("../../src/portfolio/public/", import.meta.url));
    const element = (): Record<string, unknown> => ({ addEventListener() {}, removeAttribute() {}, setAttribute() {}, querySelectorAll: () => [], querySelector: () => null, classList: { add() {}, remove() {}, toggle() {} }, dataset: {}, style: {}, hidden: false, value: "", textContent: "", innerHTML: "", contains: () => false, open: false });
    class FixedDate extends Date {
      constructor(...a: ConstructorParameters<typeof Date>) {
        super(...((a.length ? a : [NOW]) as ConstructorParameters<typeof Date>));
      }
      static override now() {
        return NOW;
      }
    }
    const sandbox: Record<string, unknown> = {
      document: { getElementById: element, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, body: element(), documentElement: { dataset: {} }, hidden: false, activeElement: null },
      location: { hash: "#/markets", origin: "http://127.0.0.1:4820" },
      history: { replaceState() {} },
      Owner: { role: "owner", why: () => "" },
      Event: class {
        constructor(readonly type: string) {}
      },
      addEventListener() {},
      dispatchEvent: () => true,
      fetch: async () => ({ status: 200, statusText: "", json: async () => ({}) }),
      console,
      URLSearchParams,
      Intl,
      Date: FixedDate,
      setTimeout,
      clearTimeout,
      setInterval: () => 0,
      clearInterval() {},
    };
    const ctx = createContext(sandbox);
    sandbox.window = runInContext("globalThis", ctx);
    for (const f of ["ui/core.js", "ui/connect.js", "ui/markets.js"]) new Script(readFileSync(join(PUBLIC, f), "utf8"), { filename: f }).runInContext(ctx);
    return { run: <T = unknown>(code: string) => runInContext(code, ctx) as T };
  }

  it("F2 · an outcome named in capitals keeps its name: FURIA is FURIA and USA is USA (only YES/NO/UP/DOWN are re-cased)", () => {
    const p = page();
    expect(p.run('[mkLabel("YES"), mkLabel("NO"), mkLabel("UP"), mkLabel("DOWN")]')).toEqual(["Yes", "No", "Up", "Down"]);
    expect(p.run('[mkLabel("FURIA"), mkLabel("USA"), mkLabel("BIG"), mkLabel("NAVI")]')).toEqual(["FURIA", "USA", "BIG", "NAVI"]);
  });

  it("F3 · a Polymarket market past its endDate that Polymarket still trades is not drawn as Closed", async () => {
    // Gamma's own answer on 2026-10-06 for the Lula market (endDate 2026-10-05, active, not closed, accepting orders, a live book)
    const gamma = network([
      ["/events?", json([{ id: "45915", title: "Brazil Presidential Election", endDate: "2026-10-05T03:59:00Z", tags: [{ label: "Politics", slug: "politics" }], markets: [{ slug: "lula-2026", conditionId: `0x${"ab".repeat(32)}`, question: "Will Lula win the 2026 Brazilian presidential election?", outcomes: '["Yes","No"]', outcomePrices: '["0.155","0.845"]', bestBid: 0.15, bestAsk: 0.16, oneDayPriceChange: -0.01, volume24hr: 1_185_573, endDate: "2026-10-05T03:59:00Z", active: true, closed: false, archived: false, enableOrderBook: true, acceptingOrders: true }] }])],
    ]);
    const legs = (await polymarketPublic({ http: gamma.http, clock: () => NOW }).listings({ limit: 5 })) as Listing[];
    expect(legs[0]).toMatchObject({ symbol: "lula-2026:Yes", open: true, closeTime: "2026-10-05T03:59:00Z" });
    // the card the pane draws for that row: the venue says open, so the countdown must not say "Closed"
    const p = page();
    p.run(`A = { venues: [], watch: [], cards: [], orders: [], intents: [], asks: [], connectLive: { writes: { on: true }, options: [{ kind: "polymarket-trade", connector: "live:polymarket-trade", needs: "key-file", label: "Polymarket" }] } }`);
    const item = { key: `pm:0x${"ab".repeat(32)}`, kind: "event", name: "Will Lula win the 2026 Brazilian presidential election?", price: 0.155, volumeUsd24h: 1_185_573, category: "Politics", closeTime: "2026-10-05T03:59:00Z", tabs: ["predictions"], outcomes: [{ label: "Yes", price: 0.155, bid: 0.15, ask: 0.16, at: [{ venue: "polymarket", symbol: "lula-2026:Yes" }] }, { label: "No", price: 0.845, at: [{ venue: "polymarket", symbol: "lula-2026:No" }] }], at: [{ venue: "polymarket", venueName: "Polymarket", symbol: "lula-2026:Yes", connected: false, canTrade: false, public: true, price: 0.155, open: true, connectTo: "polymarket", connector: "live:polymarket-trade" }] };
    const html = p.run<string>(`mkCard(${JSON.stringify(item)})`);
    expect(html).not.toContain(">Closed<");
    expect(html).toContain("Yes · ");
  });
});
