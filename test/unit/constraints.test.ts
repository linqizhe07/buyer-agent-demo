import { describe, expect, it } from "vitest";
import { applyConstraints, classifyVenueError } from "../../src/contract/constraints.ts";
import { loadManifest } from "../../src/contract/manifest.ts";
import { fileURLToPath } from "node:url";

const alpaca = loadManifest(fileURLToPath(new URL("../../manifests/alpaca.json", import.meta.url)));

describe("applyConstraints (alpaca crypto tif)", () => {
  it("rewrites day → gtc for a crypto symbol when absorbing", () => {
    const r = applyConstraints(alpaca, "place_order", { symbol: "BTC/USD", time_in_force: "day", qty: 1 }, { absorb: true });
    expect(r.args.time_in_force).toBe("gtc");
    expect(r.rewrites).toEqual([{ id: "alpaca-crypto-tif", arg: "time_in_force", from: "day", to: "gtc" }]);
  });
  it("leaves the order alone when not absorbing, but names the pending constraint", () => {
    const r = applyConstraints(alpaca, "place_order", { symbol: "BTC/USD", time_in_force: "day" }, { absorb: false });
    expect(r.args.time_in_force).toBe("day");
    expect(r.rewrites).toEqual([]);
    expect(r.pending.map((c) => c.id)).toEqual(["alpaca-crypto-tif"]);
  });
  it("does not touch equities or an already-valid tif", () => {
    expect(applyConstraints(alpaca, "place_order", { symbol: "AAPL", time_in_force: "day" }, { absorb: true }).rewrites).toEqual([]);
    expect(applyConstraints(alpaca, "place_order", { symbol: "ETH/USD", time_in_force: "ioc" }, { absorb: true }).rewrites).toEqual([]);
  });
});

describe("classifyVenueError", () => {
  it("maps the declared venue error to the declared refusal code", () => {
    const r = classifyVenueError(alpaca, "place_order", { status: 422, code: 42210000, message: "time_in_force must be gtc or ioc for crypto orders" });
    expect(r.code).toBe("E_VENUE_INVALID_TIF");
    expect(r.native).toEqual({ status: 422, code: 42210000, message: "time_in_force must be gtc or ioc for crypto orders" });
  });
  it("keeps the venue's words for anything else", () => {
    const r = classifyVenueError(alpaca, "place_order", { status: 422, code: 42210000, message: "insufficient buying power" });
    expect(r.code).toBe("E_VENUE_REJECTED");
    expect(r.message).toContain("insufficient buying power");
  });
});
