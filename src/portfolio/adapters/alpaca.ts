/** A stock-market account at a broker (Alpaca), in-memory — the front line the
 * account could not reach before.
 *
 * What the account layer has to know about a broker is not how to trade there
 * (orders go through the venue's own seat) but how CASH gets in and out, and
 * the answer is the honest one: through this credential, it does not. Alpaca's
 * Trading API has no funding endpoint ("users cannot programmatically schedule
 * deposits or withdraw funds") and its OAuth scopes are `account:write`,
 * `trading` and `data` — none moves money. ACH relationships, transfers and
 * journals belong to the Broker API, which only a broker partner may call. So
 * a deposit or a withdrawal is an ACH with the holder's own bank, STARTED AT
 * THE BROKER by the account holder; nothing of it goes through the account.
 *
 * Cash from a sale is `cash` at once but `cash_withdrawable` only when the
 * trade settles, the next settlement day. Prices are a fixed illustrative
 * table, not market data.
 */
import { no } from "../refuse.ts";
import { r2, type Account, type AccountAdapter, type Holding, type Intent } from "../accounts.ts";
import { DAY, etDate, fromEt, et, isBankDay, isMarketDay } from "../account/calendar.ts";

export interface AlpacaSeed {
  accountNumber: string;
  /** settled cash */
  cash: number;
  /** proceeds of a sale on the last market day: tradable now, withdrawable when the trade settles */
  unsettledUsd: number;
  positions: Array<{ symbol: string; qty: number; price: number }>;
  /** what the venue says about this customer's region; the venue's own list, never ours */
  geoblock?: { blocked: boolean } | undefined;
}

/** the settlement day of a sale made on the last market day on or before `ms`: the next bank day, 9:00am New York */
function saleSettles(ms: number): number {
  let trade = ms;
  while (!isMarketDay(trade)) trade -= DAY;
  let at = trade;
  do {
    at += DAY;
  } while (!isBankDay(at));
  const d = et(at);
  return fromEt(d.y, d.m, d.d, 9);
}

export function alpacaAccount(seed: AlpacaSeed, now: () => string): AccountAdapter {
  let cash = seed.cash;
  const start = Date.parse(now());
  const unsettled = seed.unsettledUsd > 0 ? [{ usd: seed.unsettledUsd, settlesAt: saleSettles(start) }] : [];
  const blocked = seed.geoblock?.blocked === true;
  const account: Account = {
    id: "alpaca",
    name: "Alpaca",
    kind: "broker",
    provider: "Alpaca (broker-dealer)",
    credentialRef: "home/credentials/alpaca/trading-key.json",
    credentialKind: "trading API key (APCA-API-KEY-ID + secret)",
    scope: {
      can: ["read"],
      limits: ["this key reads and places orders (through the venue's own seat); no key scope and no OAuth scope moves cash", "deposits and withdrawals are started at Alpaca by the account holder: ACH with the holder's own bank", "cash from a sale is withdrawable when the trade settles, the next settlement day"],
      enforcedBy: "venue",
    },
    settlement: "trades settle the next settlement day · ACH moves on bank days",
    live: false,
    ...(blocked ? { restricted: "Not available in your region" } : {}),
  };
  /** unsettled proceeds that have reached their settlement day become ordinary cash */
  const mature = () => {
    const t = Date.parse(now());
    for (let i = unsettled.length - 1; i >= 0; i--) {
      if (t >= unsettled[i]!.settlesAt) {
        cash = r2(cash + unsettled[i]!.usd);
        unsettled.splice(i, 1);
      }
    }
  };
  const noFunding = (i: Intent) =>
    no("E_VENUE_PERMISSION", { venue: "alpaca", message: `Alpaca: no API scope moves cash, so "${i.kind}" cannot start here; the account holder starts an ACH at Alpaca`, native: { code: 40110000, message: "request is not authorized" } });
  return {
    account,
    async read(): Promise<Holding[]> {
      mature();
      const rows: Holding[] = [];
      if (cash > 0) rows.push({ account: account.id, asset: "USD", amount: cash, usd: cash, class: "cash", note: "withdrawable" });
      for (const u of unsettled) rows.push({ account: account.id, asset: "USD (unsettled)", amount: u.usd, usd: u.usd, class: "cash", note: `tradable now · withdrawable ${etDate(u.settlesAt)}`, inTransit: true });
      for (const p of seed.positions) rows.push({ account: account.id, asset: p.symbol, amount: p.qty, usd: r2(p.qty * p.price), class: "equity", note: `@ $${p.price}` });
      return rows;
    },
    async execute(i: Intent) {
      if (i.kind === "trade") return no("E_VENUE_REJECTED", { venue: "alpaca", message: "orders at a broker go through the venue's own seat, not through the account", native: { code: 40010001, message: "unsupported here" } });
      return noFunding(i);
    },
    credit(asset, amount) {
      if (asset === "USD") cash = r2(cash + amount);
    },
  };
}
