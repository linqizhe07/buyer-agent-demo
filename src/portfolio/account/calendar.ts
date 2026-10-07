/** The clocks of the rails.
 *
 * Money has business hours. An ACH moves on bank days and is cut off in the
 * evening; an RWA redemption is cut off at 4pm; a stock settles the next
 * settlement day; a chain, an exchange and a card authorisation never close.
 * These rails keep New York time, so everything here is computed in ET from a
 * UTC instant — never from the machine's own time zone.
 *
 * Holidays are computed by rule, not listed: the Federal Reserve's (a holiday
 * on a Sunday is observed on Monday; one on a Saturday is NOT observed on
 * Friday) and the stock market's (which closes the Friday before a Saturday
 * holiday, closes on Good Friday, and stays open on Columbus Day and Veterans
 * Day). The cut-off and settlement times are the ones the rails publish
 * (same-day ACH 3:00pm, standard ACH 8:30pm, NAV 4:00pm); they are quotes of
 * the rule, not measurements.
 */
const NY = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" });
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export interface EtTime {
  y: number;
  m: number;
  d: number;
  /** 0 Sunday … 6 Saturday */
  dow: number;
  /** minutes since midnight, New York */
  minutes: number;
}

export function et(ms: number): EtTime {
  const p = Object.fromEntries(NY.formatToParts(new Date(ms)).map((x) => [x.type, x.value])) as Record<string, string>;
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), dow: DOW.indexOf(p.weekday!), minutes: Number(p.hour) * 60 + Number(p.minute) };
}

/** the UTC instant of a New York wall-clock time on a New York date */
export function fromEt(y: number, m: number, d: number, hour = 0, minute = 0): number {
  const noon = Date.UTC(y, m - 1, d, 12);
  const offset = 12 - Math.floor(et(noon).minutes / 60);
  return Date.UTC(y, m - 1, d, hour + offset, minute);
}

const dowOf = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();
const nthDow = (y: number, m: number, dow: number, n: number) => 1 + ((7 + dow - dowOf(y, m, 1)) % 7) + 7 * (n - 1);
const lastDow = (y: number, m: number, dow: number) => {
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return last - ((7 + dowOf(y, m, last) - dow) % 7);
};

/** Easter Sunday (anonymous Gregorian algorithm): Good Friday is two days before */
function easter(y: number): { m: number; d: number } {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, mm = Math.floor((a + 11 * h + 22 * l) / 451);
  return { m: Math.floor((h + l - 7 * mm + 114) / 31), d: ((h + l - 7 * mm + 114) % 31) + 1 };
}

const key = (m: number, d: number) => m * 100 + d;

function holidays(y: number, market: boolean): Set<number> {
  const out = new Set<number>();
  // a fixed-date holiday: the bank observes a Sunday on Monday and ignores a Saturday; the market also closes the Friday before a Saturday
  const fixed = (m: number, d: number, fridayBefore = market) => {
    const dow = dowOf(y, m, d);
    if (dow === 0) out.add(key(m, d + 1));
    else if (dow === 6) {
      if (fridayBefore) out.add(key(m, d - 1));
    } else out.add(key(m, d));
  };
  // New Year's Day on a Saturday is observed by neither (the market does not close 31 December)
  fixed(1, 1, false);
  out.add(key(1, nthDow(y, 1, 1, 3)));
  out.add(key(2, nthDow(y, 2, 1, 3)));
  out.add(key(5, lastDow(y, 5, 1)));
  fixed(6, 19);
  fixed(7, 4);
  out.add(key(9, nthDow(y, 9, 1, 1)));
  out.add(key(11, nthDow(y, 11, 4, 4)));
  fixed(12, 25);
  if (market) {
    const e = easter(y);
    const good = new Date(Date.UTC(y, e.m - 1, e.d - 2));
    out.add(key(good.getUTCMonth() + 1, good.getUTCDate()));
  } else {
    out.add(key(10, nthDow(y, 10, 1, 2)));
    fixed(11, 11);
  }
  return out;
}

const cache = new Map<string, Set<number>>();
const holidaySet = (y: number, market: boolean) => {
  const k = `${y}:${market}`;
  if (!cache.has(k)) cache.set(k, holidays(y, market));
  return cache.get(k)!;
};

/** a day the banks settle: Monday to Friday, not a Federal Reserve holiday */
export function isBankDay(ms: number): boolean {
  const t = et(ms);
  return t.dow >= 1 && t.dow <= 5 && !holidaySet(t.y, false).has(key(t.m, t.d));
}

/** a day the stock market trades its regular session */
export function isMarketDay(ms: number): boolean {
  const t = et(ms);
  return t.dow >= 1 && t.dow <= 5 && !holidaySet(t.y, true).has(key(t.m, t.d));
}

/** the UTC instant of `hour:minute` New York time, `n` bank days after the New York date of `ms` (n = 0: that date itself, which must then be a bank day) */
function bankDayAt(ms: number, n: number, hour: number, minute = 0): number {
  const t = et(ms);
  let at = fromEt(t.y, t.m, t.d, hour, minute);
  let left = n;
  while (left > 0) {
    at += DAY;
    const x = et(at);
    at = fromEt(x.y, x.m, x.d, hour, minute);
    if (isBankDay(at)) left--;
  }
  return at;
}

/** the first bank day that is not before `ms` (its New York date), at `hour:minute` */
function firstBankDay(ms: number, hour: number, minute = 0): number {
  const t = et(ms);
  let at = fromEt(t.y, t.m, t.d, hour, minute);
  while (!isBankDay(at)) {
    at += DAY;
    const x = et(at);
    at = fromEt(x.y, x.m, x.d, hour, minute);
  }
  return at;
}

const ACH_CUTOFF = 20 * 60 + 30;
const SAME_DAY_CUTOFF = 15 * 60;
const NAV_CUTOFF = 16 * 60;

/** A standard ACH: handed to the network on the first bank day whose 8:30pm cut-off has not passed, settled at 9:00am the bank day after. */
export function achArrival(nowMs: number): number {
  const t = et(nowMs);
  const today = isBankDay(nowMs) && t.minutes < ACH_CUTOFF;
  const processed = today ? nowMs : firstBankDay(nowMs + (isBankDay(nowMs) ? DAY : 0), 0);
  return bankDayAt(processed, 1, 9);
}

/** A same-day ACH: before 3:00pm on a bank day it settles that evening; after that it goes out as a standard one. */
export function sameDayAchArrival(nowMs: number): number {
  const t = et(nowMs);
  return isBankDay(nowMs) && t.minutes < SAME_DAY_CUTOFF ? fromEt(t.y, t.m, t.d, 17) : achArrival(nowMs);
}

/** An instruction that needs the fund's daily price (a non-instant redemption): in before 4:00pm on a business day, paid the next business day; otherwise the one after. */
export function navArrival(nowMs: number): number {
  const t = et(nowMs);
  const today = isBankDay(nowMs) && t.minutes < NAV_CUTOFF;
  const accepted = today ? nowMs : firstBankDay(nowMs + (isBankDay(nowMs) ? DAY : 0), 0);
  return bankDayAt(accepted, 1, 17);
}

/** Cash from a sale is withdrawable when the trade settles: the settlement day after its TRADE DATE. A fill in the overnight session (from
 * 8pm) carries the next trading day's date, so Monday 9pm is a Tuesday trade and settles Wednesday. */
export function settlementArrival(nowMs: number): number {
  const t = et(nowMs);
  let trade = fromEt(t.y, t.m, t.d, 12);
  if (t.minutes >= 20 * 60 || !isMarketDay(trade)) {
    do trade += DAY;
    while (!isMarketDay(trade));
  }
  return bankDayAt(trade, 1, 9);
}

export type Session = "overnight" | "pre-market" | "regular" | "after-hours" | "closed";

/** Alpaca's sessions: overnight 8pm–4am from Sunday evening to Friday morning, pre-market 4:00–9:30, regular 9:30–4:00, after-hours 4:00–8:00 */
export function marketSession(ms: number): Session {
  const t = et(ms);
  const open = isMarketDay(ms);
  if (open && t.minutes >= 4 * 60 && t.minutes < 9 * 60 + 30) return "pre-market";
  if (open && t.minutes >= 9 * 60 + 30 && t.minutes < 16 * 60) return "regular";
  if (open && t.minutes >= 16 * 60 && t.minutes < 20 * 60) return "after-hours";
  // the overnight session belongs to the NEXT trading day: Sunday to Thursday evening before a market day, and until 4am on one
  if (t.minutes >= 20 * 60 && t.dow <= 4 && isMarketDay(ms + DAY)) return "overnight";
  if (t.minutes < 4 * 60 && open) return "overnight";
  return "closed";
}

/** The REGULAR SESSION (9:30 to 16:00 New York, on a market day) under way at `ms`, or else the next one: whether it is under way, and the
 * instants it opens and closes. A market day is isMarketDay's, so the market's holidays are closed days. The market's early closes (13:00 on
 * the day after Thanksgiving, and on some days before a holiday) are not known here: every session here closes at 16:00 */
export function nextRegularSession(ms: number): { open: boolean; opensAt: number; closesAt: number } {
  const t = et(ms);
  // the New York dates from this one on, counted in UTC so that no daylight-saving change skips or repeats one; a market day is never more
  // than four days away (a weekend beside a holiday)
  for (let i = 0; i < 10; i++) {
    const day = new Date(Date.UTC(t.y, t.m - 1, t.d + i));
    const y = day.getUTCFullYear();
    const m = day.getUTCMonth() + 1;
    const d = day.getUTCDate();
    const closesAt = fromEt(y, m, d, 16);
    if (ms >= closesAt || !isMarketDay(closesAt)) continue;
    const opensAt = fromEt(y, m, d, 9, 30);
    return { open: ms >= opensAt, opensAt, closesAt };
  }
  throw new Error(`no market day within ten days of ${new Date(ms).toISOString()}`);
}

/** The regular session as a market carries it (live/trade.ts Market.session), from this calendar: in session now (marketSession says
 * "regular") and, ISO, when it closes while it is open, or when it next opens while it is not. This is the session of a venue that sends
 * every stock order for the regular session (Robinhood's market_hours "regular_hours") */
export function regularSession(ms: number): { open: boolean; opensAt?: string; closesAt?: string } {
  const s = nextRegularSession(ms);
  return marketSession(ms) === "regular" ? { open: true, closesAt: new Date(s.closesAt).toISOString() } : { open: false, opensAt: new Date(s.opensAt).toISOString() };
}

/** `Tue 6 Oct` — a New York date as a person reads it */
export function etDate(ms: number): string {
  const t = et(ms);
  return `${DOW[t.dow]} ${t.d} ${MONTH[t.m - 1]}`;
}

/** how long until money lands, in the page's words: `now` · `~2 min` · `~3 h` · `Tue 6 Oct` */
export function whenLabel(nowMs: number, arrivalMs: number): string {
  const wait = arrivalMs - nowMs;
  if (wait <= 60_000) return "now";
  if (wait < HOUR) return `~${Math.round(wait / 60_000)} min`;
  const a = et(nowMs), b = et(arrivalMs);
  if (a.y === b.y && a.m === b.m && a.d === b.d) return `~${Math.round(wait / HOUR)} h`;
  return etDate(arrivalMs);
}
