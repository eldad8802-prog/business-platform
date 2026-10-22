/**
 * Verify — Home income never adds currencies together (audit B2).
 * Run: npx tsx lib/services/home/home-per-currency.verify.test.ts
 *
 * Pure: `prisma.$transaction` is replaced by an in-memory transaction (no DB, no network).
 *
 *   1. COMPATIBILITY  all-ILS data → every field main (06f425ea) produced for /api/home/day and
 *                     /api/home/collection is byte-identical (fixture captured on main); only the
 *                     additive fields appear; the pre-change bucketing / cumulate functions, kept
 *                     verbatim below, agree with the new ones on ILS rows.
 *   2. MIXED          ILS + USD → the ₪ figures (hours, points, totals, month, comparisons) carry
 *                     the ILS rows only; USD is reported on its own line; the flags are set.
 */
import assert from "node:assert/strict";

import { Prisma } from "@prisma/client";

import {
  D,
  NOW,
  ilsRows,
  legacyDiff,
  mainFixture,
  stubTx,
  type StubRow,
} from "@/lib/services/__fixtures__/per-currency-scenarios";
import { bucketByJerusalemHour, loadHomeDay } from "@/lib/services/home/home-day.service";
import { cumulate, loadHomeCollection } from "@/lib/services/home/home-collection.service";
import { jerusalemHour } from "@/lib/utils/jerusalem-day";
import { buildDaySeries, buildWeekSeries, formatOtherCurrencies, otherCurrenciesOf } from "@/features/home/v3/home-v3-model";

let checks = 0;
function eq<T>(label: string, actual: T, expected: T) {
  assert.deepEqual(actual, expected, label);
  checks += 1;
}
const json = (v: unknown) => JSON.parse(JSON.stringify(v));

// ── The pre-change functions, verbatim from main 06f425ea ────────────────────────────────────
const ZERO = new Prisma.Decimal(0);
function legacyBucketByJerusalemHour(rows: { amount: Prisma.Decimal | number | string; createdAt: Date }[]) {
  const buckets = Array.from({ length: 24 }, () => ZERO);
  let total = ZERO;
  for (const row of rows) {
    const hour = jerusalemHour(row.createdAt);
    buckets[hour] = buckets[hour].plus(row.amount);
    total = total.plus(row.amount);
  }
  return { hours: buckets.map((b) => b.toFixed(2)), total: total.toFixed(2), count: rows.length, complete: true };
}
function legacyCumulate(rows: { amount: Prisma.Decimal; createdAt: Date }[], bucketOf: (row: { amount: Prisma.Decimal; createdAt: Date }) => number, length: number) {
  const perBucket = Array.from({ length }, () => ZERO);
  for (const row of rows) {
    const index = bucketOf(row);
    if (index >= 0 && index < length) perBucket[index] = perBucket[index].plus(row.amount);
  }
  let running = ZERO;
  const points = perBucket.map((value) => {
    running = running.plus(value);
    return running.toFixed(2);
  });
  return { points, total: running, count: rows.length };
}

/** Same scenarios as the main capture. */
async function scenarios() {
  const out: Record<string, unknown> = {};
  out.dayFull = await loadHomeDay(7, { now: NOW });
  out.dayYesterday = await loadHomeDay(7, { now: NOW, date: "2026-10-13", scope: "day" });
  for (const p of ["today", "yesterday", "week"]) out[`collection_${p}`] = await loadHomeCollection(7, { period: p, now: NOW });
  out.bucket = bucketByJerusalemHour(ilsRows().slice(0, 4));
  out.cumulate = cumulate(ilsRows().slice(0, 6), (r) => jerusalemHour(r.createdAt), 24);
  return json(out);
}

async function compatibility() {
  const { calls } = stubTx(ilsRows());
  const after = await scenarios();
  const before = mainFixture();
  for (const key of ["dayFull", "dayYesterday", "collection_today", "collection_yesterday", "collection_week", "bucket", "cumulate"]) {
    const { diffs, leaves } = legacyDiff(before[key], after[key], key);
    eq(`${key}: every field main produced is unchanged (${leaves} values)`, diffs, []);
    if (leaves < 3) throw new Error(`${key}: fixture too small to prove anything`);
  }
  eq("no aggregate across currencies is issued any more", calls.includes("aggregate"), false);
  eq("month reads are grouped by currency", calls.filter((c) => c === "groupBy:currency").length, 2 + 2 * 3); // day (full) + three collection periods

  // Additive fields on all-ILS data: one ILS line, never mixed.
  const day = after.dayFull as { day: Record<string, unknown>; month: Record<string, unknown> };
  eq("day: currency", day.day.currency, "ILS");
  eq("day: one ILS line", day.day.totalsByCurrency, [{ currency: "ILS", total: "1200.59", count: 4 }]);
  eq("day: not mixed", day.day.isMixedCurrency, false);
  eq("month: not mixed", day.month.isMixedCurrency, false);
  const week = after.collection_week as { isMixedCurrency: boolean; current: { totalsByCurrency: unknown[] } };
  eq("week: not mixed", week.isMixedCurrency, false);
  eq("week: one line", week.current.totalsByCurrency.length, 1);

  // The pre-change pure functions agree on random ILS rows.
  for (let seed = 1; seed <= 25; seed++) {
    const rows = Array.from({ length: (seed * 7) % 13 }, (_, i) => ({
      amount: D(((seed * 977 + i * 131) % 100000 / 100).toFixed(2)),
      createdAt: new Date(Date.UTC(2026, 9, 14, 0, (seed * 37 + i * 53) % 1440)),
    }));
    const now = bucketByJerusalemHour(rows);
    const legacyShape = { hours: now.hours, total: now.total, count: now.count, complete: now.complete };
    eq(`bucketByJerusalemHour matches main on ILS rows (seed ${seed})`, legacyShape, legacyBucketByJerusalemHour(rows));
    const c = cumulate(rows, (r) => jerusalemHour(r.createdAt), 24);
    const l = legacyCumulate(rows, (r) => jerusalemHour(r.createdAt), 24);
    eq(`cumulate matches main on ILS rows (seed ${seed})`, [c.points, c.total.toFixed(2), c.count], [l.points, l.total.toFixed(2), l.count]);
  }
}

type Series = { points: string[]; total: string; totalsByCurrency: { currency: string; total: string; count: number }[] };
type Collection = {
  current: Series;
  previous: Series;
  previousAtSamePoint: string;
  changePct: number | null;
  month: { amount: string };
  isMixedCurrency: boolean;
};

async function mixed() {
  const usd = (iso: string, a: string): StubRow => ({ amount: D(a), currency: "USD", createdAt: new Date(iso), status: "PAID" });
  const eur = (iso: string, a: string): StubRow => ({ amount: D(a), currency: "EUR", createdAt: new Date(iso), status: "PAID" });
  const ils = ilsRows();
  stubTx([...ils, usd("2026-10-14T06:30:00Z", "500.00"), usd("2026-10-13T07:30:00Z", "70.00"), eur("2026-09-21T09:00:00Z", "40.00")]);
  const after = await scenarios();
  const before = mainFixture();

  const day = after.dayFull as { day: Record<string, unknown>; month: Record<string, unknown> };
  const beforeDay = before.dayFull as { day: Record<string, unknown>; month: Record<string, unknown> };
  eq("mixed day: the ₪ hours are the ILS hours only", day.day.hours, beforeDay.day.hours);
  eq("mixed day: the ₪ total excludes USD", day.day.total, beforeDay.day.total);
  eq("mixed day: the count is every payment", day.day.count, (beforeDay.day.count as number) + 1);
  eq("mixed day: per-currency lines", day.day.totalsByCurrency, [
    { currency: "ILS", total: "1200.59", count: 4 },
    { currency: "USD", total: "500.00", count: 1 },
  ]);
  eq("mixed day: flagged", day.day.isMixedCurrency, true);
  eq("mixed month: ₪ amount excludes USD", day.month.amount, beforeDay.month.amount);
  eq("mixed month: previous ₪ amount excludes EUR", day.month.previousAmount, beforeDay.month.previousAmount);
  eq("mixed month: the change compares ILS with ILS", day.month.changePct, beforeDay.month.changePct);
  eq("mixed month: USD on its own line", (day.month.totalsByCurrency as { currency: string; total: string }[]).map((t) => [t.currency, t.total]), [["ILS", "6668.08"], ["USD", "570.00"]]);
  eq("mixed month: EUR on the previous month's own line", (day.month.previousTotalsByCurrency as { currency: string; total: string }[]).map((t) => [t.currency, t.total]), [["ILS", "2500.25"], ["EUR", "40.00"]]);
  eq("mixed month: flagged", day.month.isMixedCurrency, true);

  for (const p of ["today", "yesterday", "week"]) {
    const a = after[`collection_${p}`] as Collection;
    const b = before[`collection_${p}`] as Collection;
    eq(`mixed ${p}: ₪ points unchanged by USD`, a.current.points, b.current.points);
    eq(`mixed ${p}: ₪ total unchanged by USD`, a.current.total, b.current.total);
    eq(`mixed ${p}: previous ₪ points unchanged`, a.previous.points, b.previous.points);
    eq(`mixed ${p}: same-point comparison in ILS only`, a.previousAtSamePoint, b.previousAtSamePoint);
    eq(`mixed ${p}: change % unchanged`, a.changePct, b.changePct);
    eq(`mixed ${p}: month ₪ unchanged`, a.month.amount, b.month.amount);
    eq(`mixed ${p}: flagged`, a.isMixedCurrency, true);
  }
  const today = after.collection_today as Collection;
  eq("mixed today: USD line for today", today.current.totalsByCurrency, [
    { currency: "ILS", total: "1200.59", count: 4 },
    { currency: "USD", total: "500.00", count: 1 },
  ]);
  eq("mixed today: yesterday's USD on its own line", today.previous.totalsByCurrency.map((t: { currency: string }) => t.currency), ["ILS", "USD"]);

  // Only foreign money: the ₪ figure is zero (nothing in ILS), and the screen is told why.
  stubTx([usd("2026-10-14T06:30:00Z", "500.00")]);
  const onlyUsd = json(await loadHomeDay(7, { now: NOW }));
  eq("USD only: ₪ total is 0.00, never $500 drawn as ₪", onlyUsd.day.total, "0.00");
  eq("USD only: flagged", onlyUsd.day.isMixedCurrency, true);
  eq("USD only: its line", onlyUsd.day.totalsByCurrency, [{ currency: "USD", total: "500.00", count: 1 }]);
}

/** The Home screen model: all-ILS wires produce exactly the old series; others are carried, not added. */
function screenModel() {
  const hours = Array.from({ length: 24 }, (_, h) => (h === 9 ? "120.00" : "0.00"));
  const now = new Date("2026-10-14T09:00:00Z");
  const plain = buildDaySeries({ hours, incomeTotal: "120.00", expenseToday: "10.00", now });
  const ilsOnly = buildDaySeries({ hours, incomeTotal: "120.00", expenseToday: "10.00", now, incomeOtherCurrencies: otherCurrenciesOf([{ currency: "ILS", total: "120.00", count: 1 }]) });
  eq("screen: an all-ILS wire gives the identical day series", ilsOnly, plain);
  eq("screen: no extra key on all-ILS data", "incomeOtherCurrencies" in ilsOnly, false);
  const others = otherCurrenciesOf([{ currency: "ILS", total: "120.00", count: 1 }, { currency: "USD", total: "500.00", count: 1 }]);
  eq("screen: only the non-ILS lines are carried", others, [{ currency: "USD", total: "500.00" }]);
  const withUsd = buildDaySeries({ hours, incomeTotal: "120.00", expenseToday: "10.00", now, incomeOtherCurrencies: others });
  eq("screen: ₪ income is still the ILS total", withUsd.income, plain.income);
  eq("screen: USD carried beside it", withUsd.incomeOtherCurrencies, others);
  eq("screen: workspace wire (amount) is read too", otherCurrenciesOf([{ currency: "EUR", amount: "4.00", count: 1 }]), [{ currency: "EUR", total: "4.00" }]);
  eq("screen: malformed wire is ignored", otherCurrenciesOf("x"), []);
  eq("screen: the mark text (en)", formatOtherCurrencies(others, "en"), "$500");
  const keys = Array.from({ length: 7 }, (_, i) => `2026-10-0${i + 1}`);
  const wk = (o?: typeof others) => buildWeekSeries({ cumulativeIncome: ["1", "2", "3", "4", "5", "6", "7"], incomeTotal: "7", dayKeys: keys, expenses: ["0", "0", "0", "0", "0", "0", "0"], incomeOtherCurrencies: o });
  eq("screen: an all-ILS week is identical", wk([]), wk());
}

async function main() {
  await compatibility();
  await mixed();
  screenModel();
  console.log(`home-per-currency.verify: PASS (${checks} checks)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
