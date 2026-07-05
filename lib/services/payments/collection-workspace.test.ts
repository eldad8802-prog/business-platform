/**
 * Run: npx tsx lib/services/payments/collection-workspace.test.ts
 *
 * Pure derivation + workspace read-model over the in-memory store. No DB, no
 * provider. Asserts the v1 truth model: two truth states (waiting/verified) +
 * honest lifecycle labels, expired DERIVED from expiresAt, and "collected this
 * month" counting only verified (PAID) — never an unverified ask.
 */
import assert from "node:assert/strict";
import { createInMemoryPaymentStore } from "./payment-store.memory";
import { deriveCollectionView } from "./collection-view";
import { getCollectionWorkspace } from "./collection-workspace.service";
import type { PaymentRequestStatus } from "./payments.types";

async function main() {
  const NOW = new Date(2026, 5, 15, 12, 0, 0); // 15 Jun 2026 (local)
  const inMonth = new Date(2026, 5, 10, 9, 0, 0); // 10 Jun
  const beforeMonth = new Date(2026, 4, 30, 9, 0, 0); // 30 May
  const pastExpiry = new Date(2026, 5, 10); // < NOW
  const futureExpiry = new Date(2026, 5, 20); // > NOW

  // --- deriveCollectionView (pure) -----------------------------------------
  assert.equal(deriveCollectionView({ status: "PAID", expiresAt: null }, NOW).state, "verified");
  assert.equal(deriveCollectionView({ status: "FAILED", expiresAt: null }, NOW).state, "failed");
  assert.equal(deriveCollectionView({ status: "CANCELLED", expiresAt: null }, NOW).state, "cancelled");
  assert.equal(deriveCollectionView({ status: "PENDING", expiresAt: null }, NOW).state, "waiting");
  assert.equal(deriveCollectionView({ status: "PENDING", expiresAt: futureExpiry }, NOW).state, "waiting");
  {
    const exp = deriveCollectionView({ status: "PENDING", expiresAt: pastExpiry }, NOW);
    assert.equal(exp.state, "expired"); // derived from expiresAt < now
    assert.equal(exp.bucket, "attention");
  }
  assert.equal(deriveCollectionView({ status: "PENDING", expiresAt: null }, NOW).bucket, "active");
  assert.equal(deriveCollectionView({ status: "PAID", expiresAt: null }, NOW).bucket, "history");

  // --- getCollectionWorkspace (integration over in-memory store) -----------
  const store = createInMemoryPaymentStore();
  const BIZ = 1;
  const OTHER = 2;

  async function seed(
    businessId: number,
    status: PaymentRequestStatus,
    amount: string,
    opts: { expiresAt?: Date; paidAt?: Date } = {}
  ) {
    const r = await store.createPaymentRequest({
      businessId,
      customerId: null,
      billingDocumentId: null,
      provider: "CARDCOM",
      amount,
      currency: "ILS",
      description: null,
      status,
      expiresAt: opts.expiresAt ?? null,
    });
    if (opts.paidAt) await store.updatePaymentRequest(r.id, { paidAt: opts.paidAt });
    return r;
  }

  await seed(BIZ, "PENDING", "900.00"); // waiting → active
  await seed(BIZ, "PENDING", "100.00", { expiresAt: futureExpiry }); // waiting → active
  await seed(BIZ, "PENDING", "350.00", { expiresAt: pastExpiry }); // expired → attention
  await seed(BIZ, "FAILED", "200.00"); // failed → attention
  await seed(BIZ, "PAID", "800.00", { paidAt: inMonth }); // verified, collected this month
  await seed(BIZ, "PAID", "5000.00", { paidAt: beforeMonth }); // verified, NOT this month
  await seed(BIZ, "CANCELLED", "77.00"); // cancelled → history
  await seed(OTHER, "PENDING", "9999.00"); // other business — excluded
  await seed(OTHER, "PAID", "9999.00", { paidAt: inMonth }); // other business — excluded

  const ws = await getCollectionWorkspace(store, { businessId: BIZ, now: NOW });

  // buckets
  assert.equal(ws.active.length, 2);
  assert.ok(ws.active.every((i) => i.state === "waiting"));
  assert.equal(ws.attention.length, 2);
  assert.deepEqual(ws.attention.map((i) => i.state).sort(), ["expired", "failed"]);
  assert.equal(ws.history.length, 3); // 2 verified + 1 cancelled
  assert.ok(ws.history.every((i) => i.state === "verified" || i.state === "cancelled"));

  // summary — pending excludes expired
  assert.equal(ws.summary.pending.amount, "1000.00");
  assert.equal(ws.summary.pending.count, 2);
  assert.equal(ws.summary.expired.amount, "350.00");
  assert.equal(ws.summary.expired.count, 1);

  // month boundary + PAID-only: only the in-month verified counts (800);
  // before-month verified (5000) excluded, pending never counted.
  assert.equal(ws.summary.collectedThisMonth.amount, "800.00");
  assert.equal(ws.summary.collectedThisMonth.count, 1);

  // business scoping — nothing from OTHER leaks in
  const allAmounts = [...ws.active, ...ws.attention, ...ws.history].map((i) => i.amount);
  assert.ok(!allAmounts.includes("9999.00"));

  console.log("collection-workspace tests: OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
