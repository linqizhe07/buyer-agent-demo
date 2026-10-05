import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isRefusal } from "../../src/core/errors.ts";
import { binanceSign, cctpForwardHook, CCTP_DOMAIN, doorOf, nativeRequest, okxSign, plan, routeHash, type Route, type VenueView } from "../../src/portfolio/account/doors.ts";
import { etDate } from "../../src/portfolio/account/calendar.ts";
import { alpacaAccount } from "../../src/portfolio/adapters/alpaca.ts";
import { bankAccount } from "../../src/portfolio/adapters/bank.ts";
import { hyperliquidAccount } from "../../src/portfolio/adapters/hyperliquid.ts";
import { okxAccount } from "../../src/portfolio/adapters/okx.ts";
import { loadSeeds, PortfolioService } from "../../src/portfolio/service.ts";

const NOW = "2026-10-03T09:30:00.000Z";
const nowMs = Date.parse(NOW);
const clock = () => NOW;
const home = mkdtempSync(join(tmpdir(), "account-doors-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const svc = await PortfolioService.create({ home, now: clock, venues: "frontline" });
const venues: VenueView[] = await svc.views();
const route = (r: Route | ReturnType<typeof plan>): Route => {
  if (isRefusal(r)) throw new Error(`expected a route, got ${r.code}: ${r.message}`);
  return r;
};
const steps = (r: Route) => r.legs.map((l) => `${l.step}:${l.venue}${l.chain ? `@${l.chain}` : ""}`);

describe("the front line", () => {
  it("is ten venues: the eight the demo had, a stock broker and Hyperliquid", () => {
    expect(svc.accounts().map((a) => a.id)).toEqual(["alpaca", "binance", "okx", "hyperliquid", "metamask", "kalshi", "polymarket", "ondo", "mastercard", "chase"]);
    expect(venues.map((v) => doorOf(v).frontLine)).toEqual(["Stocks", "Exchange", "Exchange", "Exchange", "On-chain", "Prediction", "Prediction", "RWA", "Card", "Bank"]);
  });

  it("leaves the original eight untouched when nobody asks for it", async () => {
    const classic = await PortfolioService.create({ home: mkdtempSync(join(tmpdir(), "account-classic-")), now: clock });
    expect(classic.accounts().map((a) => a.id)).toEqual(["binance", "okx", "metamask", "kalshi", "polymarket", "ondo", "mastercard", "chase"]);
    expect(loadSeeds().okx.permissions).toEqual(["read", "trade"]);
    expect(loadSeeds("frontline").okx.permissions).toEqual(["read", "trade", "withdraw"]);
  });
});

describe("each venue's doors, read off its credential", () => {
  const door = (id: string) => doorOf(venues.find((v) => v.id === id)!);

  it("the broker: cash moves by ACH, and only the account holder starts it there", () => {
    const d = door("alpaca");
    expect([d.in[0]!.access, d.out[0]!.access]).toEqual(["venue", "venue"]);
    expect(d.in[0]!.opens).toContain("broker-partner");
    expect(d.in[0]!.final).toBe(false);
    expect(d.in[0]!.returnDays).toBe(60);
    expect(d.agentKey.cannot).toContain("move cash");
  });

  it("Hyperliquid: an agent may bring money in and move it inside; only the owner takes it out", () => {
    const d = door("hyperliquid");
    expect([d.in[0]!.access, d.in[0]!.minUsd, d.out[0]!.access]).toEqual(["agent", 5, "owner"]);
    expect(d.out[0]!.protocol).toContain("sendToEvmWithData");
    expect(d.inside.map((x) => `${x.from}→${x.to}:${x.access}`)).toEqual(["perps→spot:agent", "spot→perps:agent"]);
    expect(d.agentKey.cannot).toContain("withdraw");
  });

  it("an exchange's way out depends on the key: Binance's cannot withdraw, the front-line OKX key can, to verified addresses", () => {
    expect(door("binance").out[0]!.access).toBe("venue");
    expect(door("binance").out[0]!.why).toBe("this key has no withdraw permission");
    expect(door("okx").out[0]!.access).toBe("agent");
    expect(door("okx").out[0]!.why).toContain("verified");
    // the same adapter with the original key: the door is the venue's
    expect(doorOf(okxAccount(loadSeeds().okx).account).out[0]!.access).toBe("venue");
  });

  it("the bank and the card: nothing an agent can start", () => {
    expect(door("chase").out[0]!.access).toBe("venue");
    expect(door("chase").out[0]!.opens).toContain("payment-initiation");
    expect(door("mastercard").in).toEqual([]);
    expect(door("mastercard").out).toEqual([]);
  });

  it("a venue that does not serve the customer's region has every door closed, and no region is named", () => {
    const seeds = loadSeeds("frontline");
    const blocked = hyperliquidAccount({ ...seeds.hyperliquid!, geoblock: { blocked: true } }, clock);
    const d = doorOf(blocked.account);
    expect(d.restricted).toBe("Not available in your region");
    expect([...d.in, ...d.out].every((r) => r.access === "closed" && r.why === "the venue does not serve this region")).toBe(true);
    expect(d.inside.every((x) => x.access === "closed")).toBe(true);
    expect(JSON.stringify(seeds)).not.toMatch(/"country"|"region"\s*:/);
  });
});

describe("a movement is legs through the hub", () => {
  it("wallet → Hyperliquid: the wallet's burn, then CCTP's mint; 0.2 USDC forwarding fee; about a minute", () => {
    const r = route(plan({ from: "metamask", to: "hyperliquid", amountUsd: 500 }, venues, nowMs));
    expect(steps(r)).toEqual(["out:metamask@Arbitrum", "in:hyperliquid@Arbitrum"]);
    expect(r.legs[1]!.protocol).toContain("depositForBurnWithHook");
    expect([r.feeUsd, r.receiveUsd, r.access]).toEqual([0.22, 499.78, "agent"]);
    expect(r.arrivalMs - nowMs).toBe(75_000);
    expect(r.blocker).toBeUndefined();
  });

  it("refuses a deposit under the 5 USDC minimum of Hyperliquid's interface, before anything leaves", () => {
    const tiny = plan({ from: "metamask", to: "hyperliquid", amountUsd: 4 }, venues, nowMs);
    expect(isRefusal(tiny) && tiny.code).toBe("E_VENUE_MIN_DEPOSIT");
    // $5.10 leaves, $4.88 would arrive: still under the venue's minimum
    const short = plan({ from: "metamask", to: "hyperliquid", amountUsd: 5.1 }, venues, nowMs);
    expect(isRefusal(short) && short.code).toBe("E_VENUE_MIN_DEPOSIT");
    expect(isRefusal(short) && short.detail).toMatchObject({ minUsd: 5, wouldArriveUsd: 4.88 });
    expect(isRefusal(plan({ from: "metamask", to: "hyperliquid", amountUsd: 5.3 }, venues, nowMs))).toBe(false);
  });

  it("OKX → Hyperliquid: swap to the margin currency there, withdraw to the verified wallet, then in", () => {
    const r = route(plan({ from: "okx", to: "hyperliquid", amountUsd: 500 }, venues, nowMs));
    expect(steps(r)).toEqual(["swap:okx", "out:okx@Arbitrum", "out:metamask@Arbitrum", "in:hyperliquid@Arbitrum"]);
    expect([r.sourceToken, r.token]).toEqual(["USDT", "USDC"]);
    expect(r.feeUsd).toBe(1.07);
    expect(r.access).toBe("agent");
    expect(r.arrivalMs - nowMs).toBe((300 + 15 + 60) * 1000);
  });

  it("Binance → anywhere: the key cannot withdraw, so the route says whose move it is and what would open it", () => {
    const r = route(plan({ from: "binance", to: "hyperliquid", amountUsd: 500 }, venues, nowMs));
    expect(r.access).toBe("venue");
    expect(r.blocker).toMatchObject({ venue: "binance", step: "out", why: "this key has no withdraw permission" });
    expect(r.blocker!.opens).toContain("whitelist");
  });

  it("Hyperliquid → wallet: one leg, and it is the owner's signature", () => {
    const r = route(plan({ from: "hyperliquid", to: "metamask", amountUsd: 200 }, venues, nowMs));
    expect(steps(r)).toEqual(["out:hyperliquid@Arbitrum"]);
    expect(r.access).toBe("owner");
    expect(r.blocker!.why).toBe("only the master account's signature can withdraw");
    expect(r.feeUsd).toBe(0.23);
  });

  it("bank → broker: one leg on the bank's clock, started at the broker. Sent on a Saturday, it lands Tuesday", () => {
    const r = route(plan({ from: "chase", to: "alpaca", amountUsd: 2000 }, venues, nowMs));
    expect(steps(r)).toEqual(["venue:alpaca"]);
    expect([r.access, r.token, r.feeUsd]).toEqual(["venue", "USD", 0]);
    expect(etDate(r.arrivalMs)).toBe("Tue 6 Oct");
    const back = route(plan({ from: "alpaca", to: "chase", amountUsd: 1000 }, venues, nowMs));
    expect(steps(back)).toEqual(["venue:alpaca"]);
    expect(back.legs[0]!.protocol).toBe("ACH to the linked bank");
  });

  it("broker → Hyperliquid: no shared rail, said plainly", () => {
    const r = plan({ from: "alpaca", to: "hyperliquid", amountUsd: 500 }, venues, nowMs);
    expect(isRefusal(r) && r.code).toBe("E_VENUE_CURRENCY");
    expect(isRefusal(r) && r.message).toContain("do not share a rail");
  });

  it("wallet → the RWA issuer: the money is on Base, the issuer is on Ethereum, so the wallet bridges", () => {
    const r = route(plan({ from: "metamask", to: "ondo", amountUsd: 1000 }, venues, nowMs));
    expect(steps(r)).toEqual(["bridge:metamask@Ethereum", "out:metamask@Ethereum", "in:ondo@Ethereum"]);
    expect(r.legs[0]!.protocol).toBe("liquidity bridge: Base → Ethereum");
    expect(r.feeUsd).toBe(2.4);
  });

  it("inside one venue: perps to spot at Hyperliquid, an agent's to do, free and at once", () => {
    const r = route(plan({ from: "hyperliquid", to: "hyperliquid", fromLedger: "perps", toLedger: "spot", amountUsd: 100 }, venues, nowMs));
    expect(steps(r)).toEqual(["shift:hyperliquid"]);
    expect([r.access, r.feeUsd, r.arrivalMs]).toEqual(["agent", 0, nowMs]);
    expect(isRefusal(plan({ from: "alpaca", to: "alpaca", fromLedger: "a", toLedger: "b", amountUsd: 1 }, venues, nowMs))).toBe(true);
  });

  it("to someone else: the last leg is the wallet's, and it is the owner's to sign whatever came before", () => {
    const r = route(plan({ from: "metamask", to: "contractor", amountUsd: 300, external: { address: "0x7a11000000000000000000000000000000000001", chain: "Base" } }, venues, nowMs));
    expect(steps(r)).toEqual(["out:metamask@Base"]);
    expect(r.access).toBe("owner");
    expect(r.blocker!.why).toBe("sending to someone else is the owner's to sign");
    const viaOkx = route(plan({ from: "okx", to: "contractor", amountUsd: 300, external: { address: "0x7a11000000000000000000000000000000000001", chain: "Base" } }, venues, nowMs));
    expect(steps(viaOkx)).toEqual(["swap:okx", "out:okx@Base", "out:metamask@Base"]);
    expect(viaOkx.access).toBe("owner");
  });

  it("the route has one hash, and a different route has a different one: that is what the owner signs", () => {
    const a = route(plan({ from: "metamask", to: "hyperliquid", amountUsd: 500 }, venues, nowMs));
    const b = route(plan({ from: "metamask", to: "hyperliquid", amountUsd: 600 }, venues, nowMs));
    const c = route(plan({ from: "okx", to: "hyperliquid", amountUsd: 500 }, venues, nowMs));
    expect(a.hash).toBe(b.hash);
    expect(a.hash).not.toBe(c.hash);
    expect(routeHash({ ...a, legs: [...a.legs].reverse() })).not.toBe(a.hash);
  });

  it("an unknown venue, a zero amount and a card are refused", () => {
    expect(isRefusal(plan({ from: "nowhere", to: "okx", amountUsd: 1 }, venues, nowMs))).toBe(true);
    expect(isRefusal(plan({ from: "okx", to: "metamask", amountUsd: 0 }, venues, nowMs))).toBe(true);
    const card = plan({ from: "mastercard", to: "okx", amountUsd: 10 }, venues, nowMs);
    expect(isRefusal(card) && card.code).toBe("E_VENUE_RAIL_CLOSED");
  });
});

describe("each leg in the venue's own words", () => {
  it("Binance's HMAC, checked against the example in its own documentation", () => {
    // developers.binance.com, "request security": this secret and payload are the documented example, not a credential
    const documentedSecret = "NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j";
    expect(binanceSign(documentedSecret, "symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559")).toBe("c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71");
  });

  it("OKX: the prehash is timestamp + METHOD + path + body, and the signature is base64", () => {
    const sig = okxSign("s", "2020-12-08T09:08:57.715Z", "post", "/api/v5/asset/withdrawal", '{"ccy":"USDT"}');
    expect(Buffer.from(sig, "base64").length).toBe(32);
    expect(okxSign("s", "2020-12-08T09:08:57.715Z", "POST", "/api/v5/asset/withdrawal", '{"ccy":"USDT"}')).toBe(sig);
    expect(okxSign("s", "2020-12-08T09:08:57.716Z", "POST", "/api/v5/asset/withdrawal", '{"ccy":"USDT"}')).not.toBe(sig);
  });

  it("a deposit into Hyperliquid is a CCTP burn whose recipient AND caller are the forwarder", () => {
    const r = route(plan({ from: "metamask", to: "hyperliquid", amountUsd: 500 }, venues, nowMs));
    const n = nativeRequest(r.legs[1]!, { amount: "500", to: "0x00000000000000000000000000000000000000aa", nowMs }) as { function: string; args: Record<string, unknown> };
    expect(n.function).toBe("depositForBurnWithHook");
    expect(n.args.destinationDomain).toBe(CCTP_DOMAIN.HyperEVM);
    expect(n.args.mintRecipient).toBe(n.args.destinationCaller);
    expect(String(n.args.mintRecipient)).toMatch(/b21d281dedb17ae5b501f6aa8256fe38c4e45757$/i);
    expect([n.args.amount, n.args.minFinalityThreshold]).toEqual(["500000000", 1000]);
    // hook data: "cctp-forward" in 24 bytes, version 0, length 24, the recipient, the dex (0 = perps)
    const hook = Buffer.from(cctpForwardHook("0x00000000000000000000000000000000000000aa").slice(2), "hex");
    expect(hook.length).toBe(56);
    expect(hook.subarray(0, 12).toString()).toBe("cctp-forward");
    expect([hook.readUInt32BE(24), hook.readUInt32BE(28), hook.readUInt32BE(52)]).toEqual([0, 24, 0]);
    expect(Buffer.from(cctpForwardHook("0xaa", true).slice(2), "hex").readUInt32BE(52)).toBe(0xffffffff);
  });

  it("a withdrawal from Hyperliquid is its user-signed action; an exchange's is a signed REST call", () => {
    const out = route(plan({ from: "hyperliquid", to: "metamask", amountUsd: 200 }, venues, nowMs));
    expect(nativeRequest(out.legs[0]!, { amount: "200", to: "0xabc", nowMs })).toMatchObject({ type: "sendToEvmWithData", token: "USDC", destinationChainId: 3, addressEncoding: "hex", nonce: nowMs });
    const okx = route(plan({ from: "okx", to: "metamask", amountUsd: 200 }, venues, nowMs));
    const wd = nativeRequest(okx.legs.find((l) => l.step === "out")!, { amount: "200", to: "0xabc", nowMs }) as { path: string; before: { body: { from: string; to: string } }; body: { dest: string }; headers: Record<string, string> };
    expect([wd.path, wd.body.dest]).toEqual(["/api/v5/asset/withdrawal", "4"]);
    // OKX withdraws from the funding account only: the transfer 18 → 6 comes first
    expect([wd.before.body.from, wd.before.body.to]).toEqual(["18", "6"]);
    expect(wd.headers["OK-ACCESS-SIGN"]).toBeTruthy();
  });
});

describe("the venues themselves", () => {
  const seeds = loadSeeds("frontline");

  it("the broker: unsettled cash is not withdrawable, and an ACH started there lands on a bank day", async () => {
    const a = alpacaAccount(seeds.alpaca!, clock);
    const rows = await a.read();
    expect(rows.map((h) => [h.asset, h.usd, h.class, h.inTransit ?? false])).toEqual([["USD", 5500, "cash", false], ["USD (unsettled)", 2500, "cash", true], ["SPY", 6000, "equity", false], ["NVDA", 3000, "equity", false]]);
    // the sale was on Friday: it settles Monday
    expect(rows[1]!.note).toBe("tradable now · withdrawable Mon 5 Oct");
    const tooMuch = a.debit!("USD", 6000);
    expect(isRefusal(tooMuch) && tooMuch.code).toBe("E_VENUE_UNSETTLED");
    const wayTooMuch = a.debit!("USD", 9000);
    expect(isRefusal(wayTooMuch) && wayTooMuch.code).toBe("E_VENUE_INSUFFICIENT");
    // the agent's key cannot move cash at all
    const viaKey = await a.execute({ kind: "move", asset: "USD", amount: 100, to: "chase" });
    expect(isRefusal(viaKey) && viaKey.code).toBe("E_VENUE_PERMISSION");
    const started = a.startAtVenue!("in", "USD", 2000);
    expect(started.ok === true && started.settlesAt).toBe("2026-10-06T13:00:00.000Z");
    expect(a.statement!().map((l) => [l.direction, l.amount, l.status])).toEqual([["in", 2000, "pending"]]);
  });

  it("the broker: on Monday morning the sale has settled and the cash can leave", async () => {
    let t = NOW;
    const a = alpacaAccount(seeds.alpaca!, () => t);
    t = "2026-10-05T13:00:00.000Z";
    expect((await a.read())[0]).toMatchObject({ asset: "USD", usd: 8000 });
    expect(a.debit!("USD", 6000).ok).toBe(true);
  });

  it("Hyperliquid: an API wallet cannot withdraw; the owner's withdrawal leaves the margin behind", async () => {
    const h = hyperliquidAccount(seeds.hyperliquid!, clock);
    const viaKey = await h.execute({ kind: "move", asset: "USDC", amount: 100, to: "0xabc" });
    expect(isRefusal(viaKey) && viaKey.code).toBe("E_VENUE_AGENT_NO_WITHDRAW");
    const intoMargin = h.debit!("USDC", 1300);
    expect(isRefusal(intoMargin) && intoMargin.message).toContain("$1200 is withdrawable");
    expect(h.debit!("USDC", 1200).ok).toBe(true);
    expect((await h.read()).map((r) => [r.asset, r.usd, r.note])).toEqual([["USDC", 300, "perps · $0 withdrawable, $300 is margin"], ["USDC", 500, "spot"]]);
  });

  it("Hyperliquid: collateral moves between its own balances, and stablecoins swap from 10 up", async () => {
    const h = hyperliquidAccount(seeds.hyperliquid!, clock);
    expect(h.shift!("USDC", 200, "perps", "spot").ok).toBe(true);
    expect(isRefusal(h.shift!("USDC", 5000, "perps", "spot"))).toBe(true);
    const small = h.convert!("USDC", "USDT", 9);
    expect(isRefusal(small) && small.code).toBe("E_VENUE_MIN_DEPOSIT");
    const swap = h.convert!("USDC", "USDT", 500);
    expect(swap.ok === true && [swap.received, swap.feeUsd]).toEqual([499.93, 0.07]);
    h.credit!("USDC", 100);
    expect(h.statement!().map((l) => l.direction)).toEqual(["in"]);
  });

  it("OKX with a withdraw key: only to a verified address (58207 otherwise)", async () => {
    const o = okxAccount(seeds.okx);
    const stranger = await o.execute({ kind: "move", asset: "USDT", amount: 100, to: "0x7a11…stranger" });
    expect(isRefusal(stranger) && [stranger.code, (stranger.native as { code: string }).code]).toEqual(["E_VENUE_WITHDRAW_WHITELIST", "58207"]);
    expect((await o.execute({ kind: "move", asset: "USDT", amount: 100, to: "metamask" })).ok).toBe(true);
    const cv = o.convert!("USDT", "USDC", 1000);
    expect(cv.ok === true && cv.received).toBe(999.9);
  });

  it("the bank: an ACH debit without the money comes back R01", () => {
    const b = bankAccount(seeds.chase);
    expect(b.debit!("USD", 1000).ok).toBe(true);
    const nsf = b.debit!("USD", 1_000_000);
    expect(isRefusal(nsf) && [nsf.code, (nsf.native as { return_code: string }).return_code]).toEqual(["E_VENUE_RETURNED", "R01"]);
    // the original seed object is not what holds the balance
    expect(seeds.chase.balances.USD).toBe(12400);
  });
});
