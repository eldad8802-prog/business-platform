/**
 * Collection workspace totals never add currencies together (audit B3).
 * Run: npx tsx lib/services/payments/collection-workspace-per-currency.test.ts
 *
 * Pure: the in-memory payment store, and the Prisma store's `sumPaidBetween` over a stubbed
 * `prisma.paymentRequest` (outside a tenant context the store calls the client directly — no DB).
 *
 *   1. COMPATIBILITY  all-ILS → `summary.{pending,collectedThisMonth,expired}.{amount,count}` and the
 *                     Prisma `sumPaidBetween` `{amount,count}` are byte-identical to main 06f425ea
 *                     (fixture captured on main), including the Prisma "0" / Decimal-string form.
 *   2. MIXED          ILS + USD + EUR → `amount` is ILS only, `count` is every request, each currency
 *                     on its own line, `isMixedCurrency` set.
 */
import assert from "node:assert/strict";

import { prisma } from "@/lib/prisma";
import { D, legacyDiff, mainFixture } from "@/lib/services/__fixtures__/per-currency-scenarios";

import { getCollectionWorkspace } from "./collection-workspace.service";
import { createInMemoryPaymentStore } from "./payment-store.memory";
import { createPaymentPrismaStore } from "./payment-store.prisma";
import type { PaymentRequestStatus } from "./payments.types";

let checks = 0;
function eq<T>(label: string, actual: T, expected: T) {
  assert.deepEqual(actual, expected, label);
  checks += 1;
}
const json = (v: unknown) => JSON.parse(JSON.stringify(v));

const NOW = new Date(2026, 5, 15, 12, 0, 0);

async function workspace(rows: [PaymentRequestStatus, string, string, { expiresAt?: Date; paidAt?: Date }?][]) {
  const store = createInMemoryPaymentStore();
  for (const [status, amount, currency, o = {}] of rows) {
    const r = await store.createPaymentRequest({
      businessId: 1,
      customerId: null,
      billingDocumentId: null,
      provider: "CARDCOM",
      amount,
      currency,
      description: null,
      status,
      expiresAt: o.expiresAt ?? null,
    });
    if (o.paidAt) await store.updatePaymentRequest(r.id, { paidAt: o.paidAt });
  }
  return json((await getCollectionWorkspace(store, { businessId: 1, now: NOW })).summary);
}

/** The exact rows of the main capture. */
const MAIN_ROWS: [PaymentRequestStatus, string, string, { expiresAt?: Date; paidAt?: Date }?][] = [
  ["PENDING", "900.10", "ILS"],
  ["PENDING", "0.20", "ILS"],
  ["PENDING", "0.10", "ILS", { expiresAt: new Date(2026, 5, 20) }],
  ["PENDING", "350.33", "ILS", { expiresAt: new Date(2026, 5, 10) }],
  ["PENDING", "0.07", "ILS", { expiresAt: new Date(2026, 5, 9) }],
  ["FAILED", "200.00", "ILS"],
  ["PAID", "800.15", "ILS", { paidAt: new Date(2026, 5, 10) }],
  ["PAID", "0.15", "ILS", { paidAt: new Date(2026, 5, 11) }],
  ["PAID", "5000.00", "ILS", { paidAt: new Date(2026, 4, 30) }],
];

function stubRequests(rows: [string, string][]) {
  const sum = (rs: [string, string][]) => rs.reduce((s, r) => s.plus(r[0]), D("0"));
  (prisma as unknown as { paymentRequest: unknown }).paymentRequest = {
    aggregate: async () => ({ _sum: { amount: rows.length ? sum(rows) : null }, _count: { _all: rows.length } }),
    groupBy: async ({ by }: { by: string[] }) => {
      assert.deepEqual(by, ["currency"], "sumPaidBetween groups by currency");
      const groups = new Map<string, [string, string][]>();
      for (const r of rows) groups.set(r[1], [...(groups.get(r[1]) ?? []), r]);
      return [...groups].map(([currency, rs]) => ({ currency, _sum: { amount: sum(rs) }, _count: { _all: rs.length } }));
    },
  };
}

async function compatibility() {
  const before = mainFixture();
  for (const [key, rows] of [["workspaceSummary", MAIN_ROWS], ["workspaceEmpty", []]] as const) {
    const after = await workspace([...rows]);
    const { diffs, leaves } = legacyDiff(before[key], after, key);
    eq(`${key}: every field main produced is unchanged (${leaves} values)`, diffs, []);
    eq(`${key}: not mixed`, [after.pending.isMixedCurrency, after.collectedThisMonth.isMixedCurrency, after.expired.isMixedCurrency], [false, false, false]);
    eq(`${key}: currency`, after.pending.currency, "ILS");
  }

  for (const [variant, rows] of [["some", [["150.50", "ILS"], ["49.50", "ILS"], ["0.01", "ILS"]]], ["none", []]] as const) {
    stubRequests(rows.map((r) => [...r] as [string, string]));
    const after = json(await createPaymentPrismaStore().sumPaidBetween(1, new Date(0), new Date()));
    const { diffs } = legacyDiff(before[`prismaSumPaid_${variant}`], after, `prismaSumPaid_${variant}`);
    eq(`prisma sumPaidBetween (${variant}): amount/count unchanged`, diffs, []);
  }
}

async function mixed() {
  const s = await workspace([
    ...MAIN_ROWS,
    ["PENDING", "100.00", "USD"],
    ["PENDING", "40.00", "EUR"],
    ["PENDING", "30.00", "USD", { expiresAt: new Date(2026, 5, 10) }],
    ["PAID", "250.00", "USD", { paidAt: new Date(2026, 5, 12) }],
  ]);
  const before = mainFixture().workspaceSummary as Record<string, { amount: string; count: number }>;
  eq("mixed pending: ₪ amount excludes USD/EUR", s.pending.amount, before.pending.amount);
  eq("mixed pending: count is every request", s.pending.count, before.pending.count + 2);
  eq("mixed pending: lines, ILS first", s.pending.totalsByCurrency, [
    { currency: "ILS", amount: "900.40", count: 3 },
    { currency: "EUR", amount: "40.00", count: 1 },
    { currency: "USD", amount: "100.00", count: 1 },
  ]);
  eq("mixed pending: flagged", s.pending.isMixedCurrency, true);
  eq("mixed expired: ₪ amount excludes USD", s.expired.amount, before.expired.amount);
  eq("mixed expired: USD line", s.expired.totalsByCurrency.map((t: { currency: string; amount: string }) => [t.currency, t.amount]), [["ILS", "350.40"], ["USD", "30.00"]]);
  eq("mixed collected: ₪ amount excludes USD", s.collectedThisMonth.amount, before.collectedThisMonth.amount);
  eq("mixed collected: count is every PAID request", s.collectedThisMonth.count, before.collectedThisMonth.count + 1);
  eq("mixed collected: USD line", s.collectedThisMonth.totalsByCurrency.map((t: { currency: string; amount: string }) => [t.currency, t.amount]), [["ILS", "800.30"], ["USD", "250.00"]]);
  eq("mixed collected: flagged", s.collectedThisMonth.isMixedCurrency, true);

  const onlyUsd = await workspace([["PENDING", "100.00", "USD"]]);
  eq("USD only: ₪ amount is 0.00, never $100 drawn as ₪", onlyUsd.pending.amount, "0.00");
  eq("USD only: flagged", onlyUsd.pending.isMixedCurrency, true);

  stubRequests([["150.50", "ILS"], ["99.99", "USD"], ["0.50", "ILS"]]);
  const p = json(await createPaymentPrismaStore().sumPaidBetween(1, new Date(0), new Date()));
  eq("prisma mixed: amount is the ILS group only", p.amount, "151");
  eq("prisma mixed: count is every request", p.count, 3);
  eq("prisma mixed: lines", p.byCurrency, [
    { currency: "ILS", amount: "151", count: 2 },
    { currency: "USD", amount: "99.99", count: 1 },
  ]);
}

async function main() {
  await compatibility();
  await mixed();
  console.log(`collection-workspace-per-currency: PASS (${checks} checks)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
