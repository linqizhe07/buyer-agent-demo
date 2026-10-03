import { describe, expect, it } from "vitest";
import { mandateRejection, type Mandate } from "../../src/agent/mandates.ts";

const m: Mandate = {
  id: "m1",
  venue: "alpaca",
  purpose: "test",
  notionalLimitUsd: 1000,
  perOrderCapUsd: 400,
  symbols: ["BTC/USD"],
  recipients: ["ALLOWED"],
  maxOrdersPerMinute: 2,
  validFrom: "2026-10-01T00:00:00Z",
  validUntil: "2026-10-09T00:00:00Z",
  spentUsd: 700,
  status: "signed",
  approvedBy: "operator",
  approvedAt: "2026-10-01T00:00:00Z",
};
const now = Date.parse("2026-10-02T14:30:00Z");
const order = (notionalUsd: number, symbol = "BTC/USD") => ({ kind: "order" as const, venue: "alpaca", symbol, notionalUsd });

describe("mandateRejection", () => {
  it("admits an order inside every bound", () => {
    expect(mandateRejection(m, order(300), now, 0)).toBeUndefined();
  });
  it("expired or not yet valid", () => {
    expect(mandateRejection(m, order(1), Date.parse("2026-10-10T00:00:00Z"), 0)?.code).toBe("E_MANDATE_EXPIRED");
    expect(mandateRejection(m, order(1), Date.parse("2026-09-30T00:00:00Z"), 0)?.code).toBe("E_MANDATE_EXPIRED");
  });
  it("symbol, recipient, per-order cap, rate, budget — in that order", () => {
    expect(mandateRejection(m, order(1, "DOGE/USD"), now, 0)?.code).toBe("E_MANDATE_SYMBOL");
    expect(mandateRejection(m, { kind: "transfer", venue: "alpaca", recipient: "9xK", notionalUsd: 1 }, now, 0)?.code).toBe("E_MANDATE_RECIPIENT");
    expect(mandateRejection(m, { kind: "transfer", venue: "alpaca", recipient: "ALLOWED", notionalUsd: 1 }, now, 0)).toBeUndefined();
    expect(mandateRejection(m, order(401), now, 0)?.code).toBe("E_MANDATE_PER_ORDER_CAP");
    expect(mandateRejection(m, order(10), now, 2)?.code).toBe("E_MANDATE_RATE");
    expect(mandateRejection(m, order(301), now, 0)?.code).toBe("E_MANDATE_BUDGET");
  });
  it("a disabled mandate admits nothing", () => {
    expect(mandateRejection({ ...m, status: "disabled" }, order(1), now, 0)?.code).toBe("E_MANDATE_NONE");
  });
});
