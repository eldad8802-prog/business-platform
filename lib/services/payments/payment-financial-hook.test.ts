/**
 * Run: npx tsx lib/services/payments/payment-financial-hook.test.ts
 *
 * Financial Control integration: the webhook fires `onVerifiedPaid` ONLY on a
 * verified PAID settlement, after the PaymentTransaction exists, keyed on the
 * transaction id. No event from a signal-only webhook or a non-PAID outcome, and
 * a throwing hook never breaks the payment flow.
 */
import assert from "node:assert/strict";
import {
  processPaymentWebhook,
  type ProcessWebhookDeps,
  type VerifiedPaidEvent,
} from "./payment-webhook.service";
import { createInMemoryPaymentStore } from "./payment-store.memory";
import { createStubProvider } from "./providers/stub/stub.provider";
import type { ProviderPaymentStatus } from "./providers/payment-provider.types";

async function seedPending(store: ReturnType<typeof createInMemoryPaymentStore>) {
  store.seedConnection({ businessId: 1, provider: "TRANZILA", isActive: true });
  const req = await store.createPaymentRequest({
    businessId: 1, customerId: null, billingDocumentId: null,
    provider: "TRANZILA", amount: "100.00", currency: "ILS",
    description: null, status: "PENDING", expiresAt: null,
  });
  await store.updatePaymentRequest(req.id, { providerRequestId: "r1" });
  return req;
}

function body(outcome: string) {
  return JSON.stringify({
    eventId: `e-${outcome}`,
    providerRequestId: "r1",
    providerTransactionId: "tx1",
    outcome,
    amount: "100.00",
    currency: "ILS",
  });
}

function depsWith(
  store: ReturnType<typeof createInMemoryPaymentStore>,
  verifiedStatus: ProviderPaymentStatus | undefined,
  onVerifiedPaid?: ProcessWebhookDeps["onVerifiedPaid"]
): ProcessWebhookDeps {
  return {
    store,
    resolveProvider: () => createStubProvider(verifiedStatus ? { verifiedStatus } : {}),
    decryptConnectionCredential: () => "cred",
    onVerifiedPaid,
  };
}

async function main() {
  // --- verified PAID => hook fires once, keyed on the transaction id ---
  {
    const store = createInMemoryPaymentStore();
    const req = await seedPending(store);
    const calls: VerifiedPaidEvent[] = [];
    await processPaymentWebhook(
      { provider: "TRANZILA", rawBody: body("PAID") },
      depsWith(store, { outcome: "PAID", providerTransactionId: null }, async (e) => {
        calls.push(e);
      })
    );
    assert.equal(store.requests[0]?.status, "PAID");
    assert.equal(store.transactions.length, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.transactionId, store.transactions[0]?.id); // settlement-fact key
    assert.equal(calls[0]?.paymentRequestId, req.id);
    assert.equal(calls[0]?.businessId, 1);
    assert.equal(calls[0]?.amount, "100.00");
    assert.equal(calls[0]?.currency, "ILS");
  }

  // --- signal-only provider (no verification) => NO hook, no event ---
  {
    const store = createInMemoryPaymentStore();
    await seedPending(store);
    const calls: VerifiedPaidEvent[] = [];
    await processPaymentWebhook(
      { provider: "TRANZILA", rawBody: body("PAID") },
      depsWith(store, undefined, async (e) => {
        calls.push(e);
      })
    );
    assert.equal(store.requests[0]?.status, "PENDING");
    assert.equal(calls.length, 0); // a webhook signal alone never projects money-in
  }

  // --- verified FAILED => NO hook (only PAID is money received) ---
  {
    const store = createInMemoryPaymentStore();
    await seedPending(store);
    const calls: VerifiedPaidEvent[] = [];
    await processPaymentWebhook(
      { provider: "TRANZILA", rawBody: body("FAILED") },
      depsWith(store, { outcome: "FAILED", providerTransactionId: null }, async (e) => {
        calls.push(e);
      })
    );
    assert.equal(store.requests[0]?.status, "FAILED");
    assert.equal(calls.length, 0);
  }

  // --- best-effort: a throwing hook never breaks the PAID flow ---
  {
    const store = createInMemoryPaymentStore();
    await seedPending(store);
    const res = await processPaymentWebhook(
      { provider: "TRANZILA", rawBody: body("PAID") },
      depsWith(store, { outcome: "PAID", providerTransactionId: null }, async () => {
        throw new Error("financial-event store down");
      })
    );
    assert.equal(res.ok, true);
    assert.equal(res.paymentRequestStatus, "PAID");
    assert.equal(store.requests[0]?.status, "PAID");
    assert.equal(store.transactions.length, 1);
  }

  console.log("payment-financial-hook tests: OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
