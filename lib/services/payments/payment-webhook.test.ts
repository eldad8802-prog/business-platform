/**
 * Run: npx tsx lib/services/payments/payment-webhook.test.ts
 *
 * No DB, no real provider. Uses the in-memory store + stub provider.
 * Covers: PAID transition, duplicate-by-eventId idempotency, duplicate-by
 * transactionId idempotency, unmatched event, and bad signature — none of
 * which may throw.
 */
import assert from "node:assert/strict";
import {
  processPaymentWebhook,
  type ProcessWebhookDeps,
} from "./payment-webhook.service";
import { createInMemoryPaymentStore } from "./payment-store.memory";
import { createStubProvider } from "./providers/stub/stub.provider";

function setup(secret?: string) {
  const store = createInMemoryPaymentStore();
  store.seedConnection({ businessId: 1, provider: "TRANZILA", isActive: true });
  const provider = createStubProvider(secret ? { requiredSecret: secret } : {});
  const deps: ProcessWebhookDeps = {
    store,
    resolveProvider: () => provider,
    resolveWebhookSecret: secret ? () => secret : undefined,
  };
  return { store, deps };
}

async function seedPendingRequest(store: ReturnType<typeof createInMemoryPaymentStore>) {
  const created = await store.createPaymentRequest({
    businessId: 1,
    customerId: null,
    billingDocumentId: null,
    provider: "TRANZILA",
    amount: "100.00",
    currency: "ILS",
    description: null,
    status: "PENDING",
    expiresAt: null,
  });
  await store.updatePaymentRequest(created.id, {
    providerRequestId: "req-abc",
  });
  return created;
}

function paidBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    eventId: "evt-1",
    eventType: "payment.completed",
    providerRequestId: "req-abc",
    providerTransactionId: "txn-1",
    outcome: "PAID",
    amount: "100.00",
    currency: "ILS",
    ...overrides,
  });
}

async function main() {
// --- 1. PAID webhook => request PAID + transaction created ---
{
  const { store, deps } = setup();
  await seedPendingRequest(store);
  const res = await processPaymentWebhook(
    { provider: "TRANZILA", rawBody: paidBody() },
    deps
  );
  assert.equal(res.ok, true);
  assert.equal(res.processingStatus, "PROCESSED");
  assert.equal(res.paymentRequestStatus, "PAID");
  assert.equal(store.transactions.length, 1);
  assert.equal(store.requests[0]?.status, "PAID");
  assert.ok(store.requests[0]?.paidAt);
}

// --- 2. duplicate by same providerEventId => idempotent ---
{
  const { store, deps } = setup();
  await seedPendingRequest(store);
  await processPaymentWebhook({ provider: "TRANZILA", rawBody: paidBody() }, deps);
  const dup = await processPaymentWebhook(
    { provider: "TRANZILA", rawBody: paidBody() },
    deps
  );
  assert.equal(dup.duplicate, true);
  assert.equal(dup.ok, true);
  assert.equal(store.transactions.length, 1); // no second charge
  assert.equal(store.webhookEvents.length, 1); // not re-ingested
  assert.equal(store.requests[0]?.status, "PAID");
}

// --- 3. duplicate by same providerTransactionId, different eventId ---
{
  const { store, deps } = setup();
  await seedPendingRequest(store);
  await processPaymentWebhook({ provider: "TRANZILA", rawBody: paidBody() }, deps);
  const dup = await processPaymentWebhook(
    { provider: "TRANZILA", rawBody: paidBody({ eventId: "evt-2" }) },
    deps
  );
  assert.equal(dup.duplicate, true);
  assert.equal(store.transactions.length, 1); // still no double tx
  assert.equal(store.webhookEvents.length, 2); // both events stored
  assert.equal(store.requests[0]?.status, "PAID");
}

// --- 4. unrecognized event (no matching request) => UNMATCHED, no throw ---
{
  const { store, deps } = setup();
  const res = await processPaymentWebhook(
    {
      provider: "TRANZILA",
      rawBody: paidBody({ providerRequestId: "does-not-exist", eventId: "evt-x" }),
    },
    deps
  );
  assert.equal(res.ok, false);
  assert.equal(res.processingStatus, "UNMATCHED");
  assert.equal(store.transactions.length, 0);
}

// --- 5. garbage body => stored, UNMATCHED, no throw ---
{
  const { store, deps } = setup();
  const res = await processPaymentWebhook(
    { provider: "TRANZILA", rawBody: "not json at all" },
    deps
  );
  assert.equal(res.ok, false);
  assert.equal(store.webhookEvents.length, 1);
  assert.equal(store.transactions.length, 0);
}

// --- 6. bad signature => FAILED, no throw, no transaction ---
{
  const { store, deps } = setup("the-secret");
  await seedPendingRequest(store);
  const res = await processPaymentWebhook(
    {
      provider: "TRANZILA",
      rawBody: paidBody({ eventId: "evt-sig" }),
      headers: { "x-webhook-secret": "wrong" },
    },
    deps
  );
  assert.equal(res.ok, false);
  assert.equal(res.processingStatus, "FAILED");
  assert.equal(store.transactions.length, 0);
  assert.equal(store.requests[0]?.status, "PENDING"); // untouched
}

// --- 7. FAILED outcome => request FAILED ---
{
  const { store, deps } = setup();
  await seedPendingRequest(store);
  const res = await processPaymentWebhook(
    {
      provider: "TRANZILA",
      rawBody: paidBody({ outcome: "FAILED", eventId: "evt-f", providerTransactionId: "txn-f" }),
    },
    deps
  );
  assert.equal(res.ok, true);
  assert.equal(res.paymentRequestStatus, "FAILED");
  assert.equal(store.requests[0]?.status, "FAILED");
}

  console.log("payment-webhook tests: OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
