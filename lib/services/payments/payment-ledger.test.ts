/**
 * Run: npx tsx lib/services/payments/payment-ledger.test.ts
 *
 * M4 — Transactions Ledger (Stage 2, Option A: request-centric detail).
 * Verifies: detail composes request + transactions + audit; business scoping;
 * cross-business non-leak; rawPayload never exposed.
 */
import assert from "node:assert/strict";
import { getPaymentRequestDetail } from "./payment-ledger.service";
import { toPaymentRequestDetailApi } from "./payment-api.serializer";
import { recordPaymentAuditEvent } from "./payment-audit.service";
import { createInMemoryPaymentStore } from "./payment-store.memory";

function statusCodeOf(error: unknown): number | undefined {
  return (error as { statusCode?: number })?.statusCode;
}

async function seedRequest(
  store: ReturnType<typeof createInMemoryPaymentStore>,
  businessId: number
) {
  const req = await store.createPaymentRequest({
    businessId,
    customerId: null,
    billingDocumentId: null,
    provider: "TRANZILA",
    amount: "100.00",
    currency: "ILS",
    description: null,
    status: "PENDING",
    expiresAt: null,
  });
  await store.updatePaymentRequest(req.id, { providerRequestId: `r-${req.id}` });
  return req;
}

async function main() {
  // === detail composes request + transactions + audit ======================
  {
    const store = createInMemoryPaymentStore();
    const req = await seedRequest(store, 1);

    await store.createTransaction({
      paymentRequestId: req.id,
      provider: "TRANZILA",
      providerTransactionId: "t1",
      amount: "100.00",
      currency: "ILS",
      status: "PAID",
      rawPayload: { secret_provider_field: "SHOULD-NOT-LEAK" },
    });
    await recordPaymentAuditEvent(store, {
      businessId: 1,
      paymentRequestId: req.id,
      eventType: "PAYMENT_VERIFIED_PAID",
      source: "PROVIDER",
      summary: "verified paid",
    });

    const detail = await getPaymentRequestDetail(store, {
      businessId: 1,
      requestId: req.id,
    });
    assert.equal(detail.request.id, req.id);
    assert.equal(detail.transactions.length, 1); // transactions readable now
    assert.equal(detail.audit.length, 1); // tied to M7 audit
    assert.equal(detail.audit[0]?.eventType, "PAYMENT_VERIFIED_PAID");

    // === rawPayload is NEVER exposed through the API shape ===
    const api = toPaymentRequestDetailApi(detail);
    const json = JSON.stringify(api);
    assert.ok(!json.includes("SHOULD-NOT-LEAK"), "rawPayload must not be exposed");
    assert.ok(!("rawPayload" in api.transactions[0]!), "no rawPayload field");
    assert.equal(api.transactions[0]?.status, "PAID");
    assert.equal(api.request.id, req.id);
  }

  // === business scoping: cross-business request is reported not-found =======
  {
    const store = createInMemoryPaymentStore();
    const req = await seedRequest(store, 1); // owned by business 1
    await assert.rejects(
      () => getPaymentRequestDetail(store, { businessId: 2, requestId: req.id }),
      (e) => statusCodeOf(e) === 404
    );
  }

  // === unknown id => not-found =============================================
  {
    const store = createInMemoryPaymentStore();
    await assert.rejects(
      () => getPaymentRequestDetail(store, { businessId: 1, requestId: 9999 }),
      (e) => statusCodeOf(e) === 404
    );
  }

  // === only this request's transactions appear (no bleed across requests) ==
  {
    const store = createInMemoryPaymentStore();
    const a = await seedRequest(store, 1);
    const b = await seedRequest(store, 1);
    await store.createTransaction({
      paymentRequestId: a.id, provider: "TRANZILA", providerTransactionId: "ta",
      amount: "1.00", currency: "ILS", status: "PAID", rawPayload: null,
    });
    await store.createTransaction({
      paymentRequestId: b.id, provider: "TRANZILA", providerTransactionId: "tb",
      amount: "2.00", currency: "ILS", status: "PAID", rawPayload: null,
    });
    const detailA = await getPaymentRequestDetail(store, { businessId: 1, requestId: a.id });
    assert.equal(detailA.transactions.length, 1);
    assert.equal(detailA.transactions[0]?.providerTransactionId, "ta");
  }

  console.log("payment-ledger tests: OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
