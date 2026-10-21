/**
 * Verify — multi-currency SCENARIOS on the money engine (base / transaction / display separation).
 * Run: npx tsx lib/money/scenarios.verify.test.ts
 *
 * Each scenario keeps the three layers apart:
 *   transaction currency — the amount as recorded (never altered)
 *   base currency        — the business's reporting total (explicit, sourced rate only)
 *   display currency     — what the owner chose to look at (marked approximate when indicative)
 */
import assert from "node:assert/strict";

import { sumByCurrency, totalIn } from "@/lib/money/aggregate";
import { accountingPolicy, convert, displayPolicy, type FxRate } from "@/lib/money/fx";
import { add, moneyFromDecimal, negate, subtract, toDecimalString, type Money } from "@/lib/money/money";

let checks = 0;
function eq<T>(label: string, actual: T, expected: T) {
  assert.deepEqual(actual, expected, label);
  checks++;
}
function ok(label: string, cond: boolean) {
  assert.ok(cond, label);
  checks++;
}
const m = (s: string, c: string) => moneyFromDecimal(s, c);
const s = (x: Money) => `${x.currency} ${toDecimalString(x)}`;
const rate = (base: "USD" | "EUR", r: string, rateDate: string, extra: Partial<FxRate> = {}): FxRate => ({
  base, quote: "ILS", rate: r, kind: "REPRESENTATIVE", source: "BANK_OF_ISRAEL", rateDate,
  fetchedAt: `${rateDate}T12:00:00Z`, verification: "VERIFIED", ...extra,
});
const inILS = (x: Money, r: FxRate, asOf: string) => {
  const c = convert(x, "ILS", r, accountingPolicy(asOf));
  if (!c.ok) throw new Error(c.reason);
  return c.money;
};

// ── S1 · ILS business, USD invoice, two partial payments in USD ─────────────────────────────────
{
  const invoice = m("1000.00", "USD");
  const p1 = m("400.00", "USD");
  const p2 = m("250.00", "USD");
  const remaining = subtract(subtract(invoice, p1), p2);
  eq("S1 remaining is in the TRANSACTION currency", s(remaining), "USD 350.00");
  eq("S1 the invoice amount itself never changes", s(invoice), "USD 1000.00");
  // Reporting the remaining balance in the base currency needs a sourced rate for a date.
  eq("S1 remaining in base (rate 3.7250 on 2026-10-20)", s(inILS(remaining, rate("USD", "3.7250", "2026-10-20"), "2026-10-21")), "ILS 1303.75");
}

// ── S2 · exchange difference: invoiced at one rate, paid at another ─────────────────────────────
{
  const invoice = m("100.00", "USD");
  const atInvoice = inILS(invoice, rate("USD", "3.7000", "2026-09-01"), "2026-09-01");
  const atPayment = inILS(invoice, rate("USD", "3.7500", "2026-10-01"), "2026-10-01");
  eq("S2 base value at invoice date", s(atInvoice), "ILS 370.00");
  eq("S2 base value at payment date", s(atPayment), "ILS 375.00");
  eq("S2 exchange difference is a SEPARATE amount", s(subtract(atPayment, atInvoice)), "ILS 5.00");
  eq("S2 the USD invoice is untouched by either rate", s(invoice), "USD 100.00");
}

// ── S3 · refund and credit note in the original currency ────────────────────────────────────────
{
  const charge = m("80.00", "EUR");
  const refund = negate(m("30.00", "EUR"));
  const credit = negate(m("10.00", "EUR"));
  const net = sumByCurrency([charge, refund, credit]);
  eq("S3 refund + credit net in EUR", s(net.get("EUR")!), "EUR 40.00");
  ok("S3 a refund cannot be booked in another currency by accident", (() => {
    try { add(charge, negate(m("30.00", "ILS"))); return false; } catch { return true; }
  })());
}

// ── S4 · ILS base, transactions in ILS + USD + EUR, display in EUR ──────────────────────────────
{
  const rows = [m("1000.00", "ILS"), m("200.00", "USD"), m("50.00", "EUR"), negate(m("100.00", "ILS"))];
  const totals = sumByCurrency(rows);
  const eurIls = rate("EUR", "4.0000", "2026-10-20", { kind: "DISPLAY", source: "MANUAL", verification: "UNVERIFIED" });
  const usdIls = rate("USD", "3.7250", "2026-10-20");
  // Display in EUR: ILS→EUR through the EUR/ILS rate (inverse), USD→EUR has no direct rate → refused.
  const display = totalIn(totals, "EUR", (c) => (c === "ILS" ? eurIls : c === "USD" ? usdIls : null), displayPolicy("2026-10-21"));
  ok("S4 display total refused while a currency has no usable pair (USD→EUR)", !display.ok);
  eq("S4 …and the refusal names it", display.ok ? [] : display.unconverted.map((u) => `${u.currency}:${u.reason}`), ["USD:RATE_PAIR_MISMATCH"]);
  // Base total in ILS: verified representative USD rate is fine; the EUR display-kind rate is NOT accepted for reporting.
  const base = totalIn(totals, "ILS", (c) => (c === "USD" ? usdIls : c === "EUR" ? eurIls : null), accountingPolicy("2026-10-21"));
  ok("S4 base total refused: EUR has only an indicative (display) rate", !base.ok);
  // With a verified EUR rate the base total exists and is exact.
  const eurIlsVerified = rate("EUR", "4.0310", "2026-10-20");
  const base2 = totalIn(totals, "ILS", (c) => (c === "USD" ? usdIls : c === "EUR" ? eurIlsVerified : null), accountingPolicy("2026-10-21"));
  // 900 + 200×3.725 (745.00) + 50×4.031 (201.55) = 1846.55
  eq("S4 base total with verified rates", base2.ok ? s(base2.total) : "", "ILS 1846.55");
  ok("S4 base total not approximate (verified representative)", base2.ok && !base2.approximate);
  // Display with an indicative rate is allowed — and marked approximate.
  const disp2 = totalIn(sumByCurrency([m("1000.00", "ILS")]), "EUR", () => eurIls, displayPolicy("2026-10-21"));
  eq("S4 ILS 1000 shown in EUR (indicative 4.0000)", disp2.ok ? s(disp2.total) : "", "EUR 250.00");
  ok("S4 …marked approximate", disp2.ok && disp2.approximate);
}

// ── S5 · a rate update never changes recorded amounts or earlier conversions ────────────────────
{
  const recorded = m("100.00", "USD");
  const before = inILS(recorded, rate("USD", "3.7000", "2026-10-19"), "2026-10-19");
  const after = inILS(recorded, rate("USD", "3.9000", "2026-10-20"), "2026-10-20");
  eq("S5 recorded amount unchanged", s(recorded), "USD 100.00");
  eq("S5 the earlier conversion is a value, not a live link", s(before), "ILS 370.00");
  eq("S5 the new rate yields a new value", s(after), "ILS 390.00");
}

// ── S6 · missing / stale / unverified rate on the reporting path ────────────────────────────────
{
  const x = m("10.00", "USD");
  const refused = (r: FxRate | null, asOf: string) => {
    const c = convert(x, "ILS", r, accountingPolicy(asOf));
    return c.ok ? "OK" : c.reason;
  };
  eq("S6 missing", refused(null, "2026-10-21"), "RATE_MISSING");
  eq("S6 stale (Sunday rate used on Friday+5)", refused(rate("USD", "3.7", "2026-10-11"), "2026-10-21"), "RATE_STALE");
  eq("S6 weekend gap tolerated (Friday rate on Monday)", refused(rate("USD", "3.7", "2026-10-16"), "2026-10-19"), "OK");
  eq("S6 unverified", refused(rate("USD", "3.7", "2026-10-20", { verification: "UNVERIFIED" }), "2026-10-21"), "RATE_UNVERIFIED");
}

console.log(`money scenarios: ${checks} checks passed`);
