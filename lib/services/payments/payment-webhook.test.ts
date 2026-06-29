/**
 * Run: npx tsx lib/services/payments/payment-webhook.test.ts
 *
 * No DB, no real provider. Uses the in-memory store + stub provider.
 * Covers: verified PAID transition, duplicate-by-eventId idempotency,
 * duplicate-by transactionId idempotency, unmatched event, bad signature, and
 * signal-only (no-verification) provider — none of which may throw.
 *
 * Authority Principle (Stage 0): the webhook is only a signal. A settlement
 * (PAID/transaction) happens ONLY through a verification-capable provider. The
 * stub is made verification-capable via `verifiedStatus`; without it the stub
 * is signal-only and can never settle to PAID.
 */
import assert from "node:assert/strict";
import {
  processPaymentWebhook,
  type ProcessWebhookDeps,
} from "./payment-webhook.service";
import { createInMemoryPaymentStore } from "./payment-store.memory";
import { createStubProvider } from "./providers/stub/stub.provider";
import type { ProviderPaymentStatus } from "./providers/payment-provider.types";

/** Verification result that confirms a PAID, transaction id taken from the body. */
const VERIFIED_PAID: ProviderPaymentStatus = {
  outcome: "PAID",
  providerTransactionId: null,
};

function setup(
  opts: { secret?: string; verifiedStatus?: ProviderPaymentStatus } = {}
) {
  const store = createInMemoryPaymentStore();
  store.seedConnection({ businessId: 1, provider: "TRANZILA", isActive: true });
  const provider = createStubProvider({
    requiredSecret: opts.secret,
    verifiedStatus: opts.verifiedStatus,
  });
  const deps: ProcessWebhookDeps = {
    store,
    resolveProvider: () => provider,
    resolveWebhookSecret: opts.secret ? () => opts.secret ?? null : undefined,
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
// --- 1. verified PAID => request PAID + transaction created ---
{
  const { store, deps } = setup({ verifiedStatus: VERIFIED_PAID });
  await seedPendingRequest(store);
  const res = await processPaymentWebhook(
    { provider: "TRANZILA", rawBody: paidBody() },
    deps
  );
  assert.equal(res.ok, true);
  assert.equal(res.verified, true);
  assert.equal(res.processingStatus, "PROCESSED");
  assert.equal(res.paymentRequestStatus, "PAID");
  assert.equal(store.transactions.length, 1);
  assert.equal(store.requests[0]?.status, "PAID");
  assert.ok(store.requests[0]?.paidAt);
}

// --- 2. duplicate by same providerEventId => idempotent ---
{
  const { store, deps } = setup({ verifiedStatus: VERIFIED_PAID });
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
  const { store, deps } = setup({ verifiedStatus: VERIFIED_PAID });
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
  const { store, deps } = setup({ verifiedStatus: VERIFIED_PAID });
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
  const { store, deps } = setup({ verifiedStatus: VERIFIED_PAID });
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
  const { store, deps } = setup({ secret: "the-secret", verifiedStatus: VERIFIED_PAID });
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

// --- 7. verified FAILED outcome => request FAILED ---
{
  const { store, deps } = setup({
    verifiedStatus: { outcome: "FAILED", providerTransactionId: null },
  });
  await seedPendingRequest(store);
  const res = await processPaymentWebhook(
    {
      provider: "TRANZILA",
      rawBody: paidBody({ outcome: "FAILED", eventId: "evt-f", providerTransactionId: "txn-f" }),
    },
    deps
  );
  assert.equal(res.ok, true);
  assert.equal(res.verified, true);
  assert.equal(res.paymentRequestStatus, "FAILED");
  assert.equal(store.requests[0]?.status, "FAILED");
}

// --- 8. Stage 0 / AC8: a SIGNAL-ONLY provider (no verification) with a valid,
//        matching PAID webhook NEVER settles. Webhook alone is insufficient. ---
{
  const { store, deps } = setup(); // stub WITHOUT verifiedStatus => signal only
  await seedPendingRequest(store);
  const res = await processPaymentWebhook(
    { provider: "TRANZILA", rawBody: paidBody() },
    deps
  );
  assert.equal(res.ok, true);
  assert.equal(res.verified, false);
  assert.equal(res.reason, "signal_only_no_verification");
  assert.equal(res.paymentRequestStatus, "PENDING");
  assert.equal(store.requests[0]?.status, "PENDING");
  assert.equal(store.transactions.length, 0);
}

  console.log("payment-webhook tests: OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
