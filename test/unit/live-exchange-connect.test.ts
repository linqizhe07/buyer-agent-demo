import { describe, expect, it } from "vitest";
import { isRefusal } from "../../src/core/errors.ts";
import { exchangeList, exchangeSource, type ExchangeClient } from "../../src/portfolio/live/exchange.ts";

/** Connecting an exchange through the unified library: the catalogue of exchanges the connector opens, and the clock step for an exchange
 * whose library class has no clock call. Stand-in clients; the real library is loaded only to list what it covers (no network). */

/** an exchange client as the library shapes one: `has` as the library fills it, a clock that answers or throws what `clock` says */
function client(id: string, o: { has?: Record<string, unknown>; clock?: "ok" | "unsupported" | "blocked" | "network" } = {}): ExchangeClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    id,
    name: id,
    requiredCredentials: { apiKey: true, secret: true },
    markets: {},
    has: o.has ?? {},
    calls,
    async loadMarkets() {},
    async fetchTime() {
      calls.push("fetchTime");
      if (o.clock === "unsupported") throw Object.assign(new Error(`${id} fetchTime() is not supported yet`), { name: "NotSupported" });
      if (o.clock === "blocked") throw Object.assign(new Error(`${id} GET https://example.test/time 451 {"msg":"Service unavailable from a restricted location"}`), { name: "ExchangeNotAvailable" });
      if (o.clock === "network") throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { name: "NetworkError" });
      return 1;
    },
    async fetchBalance() {
      calls.push("fetchBalance");
      return { total: { USDT: 25 } };
    },
  } as ExchangeClient & { calls: string[] };
}
const connect = (c: ExchangeClient) => exchangeSource({ venue: c.id, exchangeId: c.id, label: "", reference: `credentials/${c.id}/api-key.json`, key: { apiKey: "made-up-key-0003", secret: "made-up-secret-0003" }, open: async () => c });

describe("the catalogue", () => {
  it("lists the futures venues with pre-IPO perpetuals among the well-known exchanges, each with what its key needs", async () => {
    const list = await exchangeList();
    const ids = list.map((x) => x.id);
    for (const id of ["krakenfutures", "kucoinfutures", "deribit", "phemex", "okx", "gate", "mexc", "bitget", "kucoin"]) expect(ids).toContain(id);
    // the well-known ones come first, in the catalogue's order
    expect(ids.slice(0, 13)).toEqual(["binance", "okx", "bybit", "kraken", "krakenfutures", "coinbase", "kucoin", "kucoinfutures", "gate", "bitget", "mexc", "deribit", "phemex"]);
    expect(list.find((x) => x.id === "kucoinfutures")?.needs).toEqual(["apiKey", "secret", "password"]);
    expect(list.find((x) => x.id === "krakenfutures")?.needs).toEqual(["apiKey", "secret"]);
    expect(list.find((x) => x.id === "deribit")?.needs).toEqual(["apiKey", "secret"]);
    expect(list.find((x) => x.id === "phemex")?.needs).toEqual(["apiKey", "secret"]);
  }, 60_000);
});

describe("the clock step", () => {
  it("skips an exchange whose library class has no clock call (NotSupported is the library's word, not the exchange's refusal), and the key's permissions and balances follow", async () => {
    const kf = client("krakenfutures", { has: { swap: true }, clock: "unsupported" });
    const r = await connect(kf);
    expect(isRefusal(r)).toBe(false);
    expect(kf.calls).toEqual(["fetchTime", "fetchBalance"]);
    expect(!isRefusal(r) && r.first).toEqual([{ asset: "USDT", amount: 25 }]);
  });

  it("asks the clock where the library has it, and is not asked where the library says it has none", async () => {
    const ok = client("deribit", { has: { fetchTime: true }, clock: "ok" });
    expect(isRefusal(await connect(ok))).toBe(false);
    expect(ok.calls).toEqual(["fetchTime", "fetchBalance"]);
    const none = client("phemex", { has: { fetchTime: false }, clock: "ok" });
    expect(isRefusal(await connect(none))).toBe(false);
    expect(none.calls).toEqual(["fetchBalance"]);
  });

  it("still stops at the clock when the exchange refuses the place or cannot be reached: the key is shown to no one", async () => {
    const blocked = client("binance", { has: { fetchTime: true }, clock: "blocked" });
    expect(await connect(blocked)).toMatchObject({ code: "E_VENUE_GEOBLOCKED" });
    expect(blocked.calls).toEqual(["fetchTime"]);
    const down = client("okx", { has: { fetchTime: true }, clock: "network" });
    expect(await connect(down)).toMatchObject({ code: "E_VENUE_UNREACHABLE" });
    expect(down.calls).toEqual(["fetchTime"]);
  });
});
