import { describe, expect, it } from "vitest";
import { achArrival, et, etDate, fromEt, isBankDay, isMarketDay, marketSession, navArrival, sameDayAchArrival, settlementArrival, whenLabel } from "../../src/portfolio/account/calendar.ts";

const at = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString();

describe("New York time, from a UTC instant", () => {
  it("knows which New York day an instant belongs to", () => {
    // the demo's clock: Saturday 3 October 2026, 5:00am in New York
    expect(et(at("2026-10-03T09:00:00Z"))).toEqual({ y: 2026, m: 10, d: 3, dow: 6, minutes: 300 });
    // 03:30 UTC on Saturday is still Friday evening in New York
    expect(et(at("2026-10-10T03:30:00Z"))).toMatchObject({ d: 9, dow: 5, minutes: 23 * 60 + 30 });
    // winter time: New York is five hours behind
    expect(et(at("2026-12-01T14:00:00Z"))).toMatchObject({ m: 12, d: 1, minutes: 9 * 60 });
  });

  it("goes back from a New York wall time to the instant, across the clock change", () => {
    expect(iso(fromEt(2026, 10, 6, 9))).toBe("2026-10-06T13:00:00.000Z");
    expect(iso(fromEt(2026, 12, 1, 9))).toBe("2026-12-01T14:00:00.000Z");
    // 1 November 2026 is the day the clocks go back
    expect(iso(fromEt(2026, 11, 2, 9))).toBe("2026-11-02T14:00:00.000Z");
  });
});

describe("bank days and market days are not the same days", () => {
  it("Columbus Day and Veterans Day: the banks rest, the market trades", () => {
    for (const day of ["2026-10-12T15:00:00Z", "2026-11-11T15:00:00Z"]) {
      expect(isBankDay(at(day))).toBe(false);
      expect(isMarketDay(at(day))).toBe(true);
    }
  });

  it("Good Friday: the market rests, the banks settle", () => {
    expect(isMarketDay(at("2026-04-03T15:00:00Z"))).toBe(false);
    expect(isBankDay(at("2026-04-03T15:00:00Z"))).toBe(true);
  });

  it("a holiday on a Saturday closes the market on Friday and the banks not at all", () => {
    // 4 July 2026 is a Saturday
    expect(isMarketDay(at("2026-07-03T15:00:00Z"))).toBe(false);
    expect(isBankDay(at("2026-07-03T15:00:00Z"))).toBe(true);
  });

  it("the usual ones close both, and a weekend is never a day", () => {
    for (const day of ["2026-01-01T15:00:00Z", "2026-01-19T15:00:00Z", "2026-02-16T15:00:00Z", "2026-05-25T15:00:00Z", "2026-06-19T15:00:00Z", "2026-09-07T15:00:00Z", "2026-11-26T15:00:00Z", "2026-12-25T15:00:00Z"]) {
      expect([day, isBankDay(at(day)), isMarketDay(at(day))]).toEqual([day, false, false]);
    }
    expect(isBankDay(at("2026-10-03T15:00:00Z"))).toBe(false);
    expect(isBankDay(at("2026-10-04T15:00:00Z"))).toBe(false);
    expect(isBankDay(at("2026-10-05T15:00:00Z"))).toBe(true);
  });
});

describe("when an ACH lands", () => {
  it("sent on a Saturday, it goes out Monday and lands Tuesday", () => {
    const lands = achArrival(at("2026-10-03T09:00:00Z"));
    expect(iso(lands)).toBe("2026-10-06T13:00:00.000Z");
    expect(etDate(lands)).toBe("Tue 6 Oct");
  });

  it("sent on a Friday before a Monday bank holiday, it lands Tuesday", () => {
    // Friday 9 October, 5:00pm New York; Monday 12 October is Columbus Day
    expect(etDate(achArrival(at("2026-10-09T21:00:00Z")))).toBe("Tue 13 Oct");
  });

  it("the 8:30pm cut-off moves it a day", () => {
    // Monday 5 October: 8:29pm is still Monday's file, 8:31pm is Tuesday's
    expect(etDate(achArrival(at("2026-10-06T00:29:00Z")))).toBe("Tue 6 Oct");
    expect(etDate(achArrival(at("2026-10-06T00:31:00Z")))).toBe("Wed 7 Oct");
  });

  it("same-day ACH before 3:00pm lands that evening; after it, it is a standard one", () => {
    expect(iso(sameDayAchArrival(at("2026-10-05T18:00:00Z")))).toBe("2026-10-05T21:00:00.000Z");
    expect(etDate(sameDayAchArrival(at("2026-10-05T19:30:00Z")))).toBe("Tue 6 Oct");
    expect(etDate(sameDayAchArrival(at("2026-10-03T09:00:00Z")))).toBe("Tue 6 Oct");
  });
});

describe("the fund's price and the trade's settlement", () => {
  it("a redemption in before 4:00pm is paid the next business day; after it, the one after", () => {
    expect(etDate(navArrival(at("2026-10-05T19:59:00Z")))).toBe("Tue 6 Oct");
    expect(etDate(navArrival(at("2026-10-05T20:01:00Z")))).toBe("Wed 7 Oct");
    // on a Saturday it is taken on Monday and paid on Tuesday
    expect(etDate(navArrival(at("2026-10-03T09:00:00Z")))).toBe("Tue 6 Oct");
  });

  it("cash from a sale can leave the broker the next settlement day", () => {
    expect(etDate(settlementArrival(at("2026-10-05T15:00:00Z")))).toBe("Tue 6 Oct");
    expect(etDate(settlementArrival(at("2026-10-09T15:00:00Z")))).toBe("Tue 13 Oct");
    // a fill at 9pm on Monday is in the overnight session: a Tuesday trade, settled Wednesday
    expect(etDate(settlementArrival(at("2026-10-06T01:00:00Z")))).toBe("Wed 7 Oct");
    // Columbus Day: the market trades, the banks do not settle
    expect(etDate(settlementArrival(at("2026-10-12T15:00:00Z")))).toBe("Tue 13 Oct");
  });
});

describe("the stock market's sessions", () => {
  it("is closed from Friday 8pm to Sunday 8pm", () => {
    expect(marketSession(at("2026-10-03T09:00:00Z"))).toBe("closed");
    expect(marketSession(at("2026-10-10T00:30:00Z"))).toBe("closed");
    expect(marketSession(at("2026-10-04T23:00:00Z"))).toBe("closed");
  });

  it("runs overnight, pre-market, regular and after-hours on a market day", () => {
    expect(marketSession(at("2026-10-05T00:30:00Z"))).toBe("overnight");
    expect(marketSession(at("2026-10-05T07:00:00Z"))).toBe("overnight");
    expect(marketSession(at("2026-10-05T09:00:00Z"))).toBe("pre-market");
    expect(marketSession(at("2026-10-05T14:00:00Z"))).toBe("regular");
    expect(marketSession(at("2026-10-05T21:00:00Z"))).toBe("after-hours");
    expect(marketSession(at("2026-10-06T01:00:00Z"))).toBe("overnight");
  });

  it("trades on a bank holiday that is not its own", () => {
    expect(marketSession(at("2026-10-12T15:00:00Z"))).toBe("regular");
  });
});

describe("how the page says when", () => {
  it("now, minutes, hours, or a New York date", () => {
    const now = at("2026-10-03T09:00:00Z");
    expect(whenLabel(now, now)).toBe("now");
    expect(whenLabel(now, now + 120_000)).toBe("~2 min");
    expect(whenLabel(now, now + 3 * 3_600_000)).toBe("~3 h");
    expect(whenLabel(now, achArrival(now))).toBe("Tue 6 Oct");
  });
});
