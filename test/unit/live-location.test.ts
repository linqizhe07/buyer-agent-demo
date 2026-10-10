import { describe, expect, it } from "vitest";
import { HYPERLIQUID_RULE, heldTo, locator, SUBDIVISION, TRACE } from "../../src/portfolio/live/location.ts";
import type { Http, HttpReply } from "../../src/portfolio/live/types.ts";

/** Where this user is (live/location.ts), from more than one source: in a country whose networks block Polymarket itself, the users a venue
 * does serve must not be refused for that. Cloudflare's public trace (its shape checked live 2026-10-08: fl, h, ip, ts, visit_scheme, uag,
 * colo, sliver, http, loc, tls, sni, warp, gateway, rbi, kex) is asked when Polymarket gives no place; only `loc` is read */
const reply = (status: number, body: unknown, text = typeof body === "string" ? body : JSON.stringify(body)): HttpReply => ({ status, body, text });
const trace = (loc: string) => reply(200, undefined, `fl=1f1\nh=www.cloudflare.com\nip=203.0.113.7\nts=1791500000.1\nvisit_scheme=https\ncolo=EWR\nhttp=http/2\nloc=${loc}\ntls=TLSv1.3\nwarp=off\n`);

function net(answers: Record<string, HttpReply | Error>) {
  const asked: string[] = [];
  const http: Http = async (url) => {
    asked.push(url);
    const a = answers[url];
    if (a instanceof Error) throw a;
    return a ?? reply(404, "");
  };
  return { http, asked, clock: () => Date.parse("2026-10-08T15:00:00Z") };
}
const PM = "https://polymarket.com/api/geoblock";

describe("where this user is, from more than one source", () => {
  it("Polymarket gives the place: Cloudflare is not asked", async () => {
    const n = net({ [PM]: reply(200, { blocked: false, ip: "203.0.113.7", country: "SG", region: "01" }) });
    expect(await locator(n).verdict(HYPERLIQUID_RULE)).toBe("served");
    expect(n.asked).toEqual([PM]);
  });

  it("Polymarket does not answer (its domain blocked where the user is): Cloudflare's trace gives the country, and a served user is served", async () => {
    const n = net({ [PM]: new Error("ECONNRESET"), [TRACE[0]!]: trace("SG") });
    expect(await locator(n).verdict(HYPERLIQUID_RULE)).toBe("served");
    expect(n.asked).toEqual([PM, TRACE[0]]);
    // the first trace host down too: the second
    const m = net({ [PM]: reply(403, "Forbidden"), [TRACE[0]!]: new Error("ETIMEDOUT"), [TRACE[1]!]: trace("FR") });
    expect(await locator(m).verdict(HYPERLIQUID_RULE)).toBe("served");
    expect(m.asked).toEqual([PM, TRACE[0], TRACE[1]]);
  });

  it("a country the rule closes whole is closed from the trace alone; one it closes in part (Canada: Ontario) cannot be judged without the subdivision", async () => {
    expect(await locator(net({ [PM]: new Error("x"), [TRACE[0]!]: trace("US") })).verdict(HYPERLIQUID_RULE)).toBe("closed");
    expect(await locator(net({ [PM]: new Error("x"), [TRACE[0]!]: trace("CA") })).verdict(HYPERLIQUID_RULE)).toBe("unknown");
    expect(await locator(net({ [PM]: new Error("x"), [TRACE[0]!]: trace("UA") })).verdict(HYPERLIQUID_RULE)).toBe("unknown");
    // with Polymarket's subdivision, Canada outside Ontario is served and Ontario is closed
    expect(await locator(net({ [PM]: reply(200, { blocked: false, country: "CA", region: "BC" }) })).verdict(HYPERLIQUID_RULE)).toBe("served");
    expect(await locator(net({ [PM]: reply(200, { blocked: true, country: "CA", region: "ON" }) })).verdict(HYPERLIQUID_RULE)).toBe("closed");
  });

  it("a country the rule closes in part, from the trace alone (Ukraine blocks polymarket.com): the part is asked of one more source, and a user Hyperliquid serves is served", async () => {
    const at = (region: unknown, country: unknown = "UA") => net({ [PM]: new Error("ECONNRESET"), [TRACE[0]!]: trace("UA"), [SUBDIVISION]: reply(200, { ip: "203.0.113.7", country_code: country, region_code: region, city: "made-up" }) });
    // Kyiv: served; Crimea: closed
    const kyiv = at("30");
    expect(await locator(kyiv).verdict(HYPERLIQUID_RULE)).toBe("served");
    expect(kyiv.asked).toEqual([PM, TRACE[0], SUBDIVISION]);
    expect(await locator(at("43")).verdict(HYPERLIQUID_RULE)).toBe("closed");
    // the other source names another country, or no part, or does not answer: not known, not served
    expect(await locator(at("30", "PL")).verdict(HYPERLIQUID_RULE)).toBe("unknown");
    expect(await locator(at("")).verdict(HYPERLIQUID_RULE)).toBe("unknown");
    expect(await locator(net({ [PM]: new Error("x"), [TRACE[0]!]: trace("UA"), [SUBDIVISION]: new Error("x") })).verdict(HYPERLIQUID_RULE)).toBe("unknown");
    // asked once: the part is kept with the place
    const w = locator(kyiv);
    await w.verdict(HYPERLIQUID_RULE);
    await w.verdict(HYPERLIQUID_RULE);
    expect(kyiv.asked.filter((u) => u === SUBDIVISION)).toHaveLength(2);
    // a country the rule does not split is never asked about its part
    const sg = net({ [PM]: new Error("x"), [TRACE[0]!]: trace("SG") });
    await locator(sg).verdict(HYPERLIQUID_RULE);
    expect(sg.asked).not.toContain(SUBDIVISION);
  });

  it("the place itself, for the account's own matching of the venues' published terms: from Polymarket's check, else Cloudflare's country alone, else not known", async () => {
    expect(await locator(net({ [PM]: reply(200, { blocked: true, ip: "203.0.113.7", country: "us", region: "pa" }) })).place()).toEqual({ country: "US", region: "PA" });
    expect(await locator(net({ [PM]: new Error("x"), [TRACE[0]!]: trace("DE") })).place()).toEqual({ country: "DE", region: "" });
    expect(await locator(net({})).place()).toBeUndefined();
  });

  it("no source gives a place (or Cloudflare says XX / T1): not known, so not served — and nothing about the place is in any refusal", async () => {
    expect(await locator(net({})).verdict(HYPERLIQUID_RULE)).toBe("unknown");
    expect(await locator(net({ [PM]: new Error("x"), [TRACE[0]!]: trace("XX"), [TRACE[1]!]: trace("T1") })).verdict(HYPERLIQUID_RULE)).toBe("unknown");
    const closed = await heldTo(HYPERLIQUID_RULE, locator(net({ [PM]: new Error("x"), [TRACE[0]!]: trace("US") })), "hyperliquid-trade", "buy 0.001 BTC");
    const unknown = await heldTo(HYPERLIQUID_RULE, locator(net({})), "hyperliquid-trade", "");
    expect(closed?.code).toBe("E_VENUE_GEOBLOCKED");
    expect(unknown?.code).toBe("E_VENUE_UNREACHABLE");
    expect(unknown?.message).toContain("where this machine is could not be learned just now");
    for (const r of [closed, unknown]) expect(JSON.stringify(r)).not.toMatch(/203\.0\.113\.7|"US"|\bloc=|EWR/);
  });
});
