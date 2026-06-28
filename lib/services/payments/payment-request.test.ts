/**
 * Run: npx tsx lib/services/payments/payment-request.test.ts
 *
 * No DB, no real provider. Uses the in-memory store + stub provider.
 */
import assert from "node:assert/strict";
import {
  createPaymentRequest,
  type CreatePaymentRequestDeps,
} from "./payment-request.service";
import { createInMemoryPaymentStore } from "./payment-store.memory";
import { createStubProvider } from "./providers/stub/stub.provider";
import type { PaymentProviderAdapter } from "./providers/payment-provider.types";

function depsWith(
  store = createInMemoryPaymentStore(),
  provider: PaymentProviderAdapter = createStubProvider()
): { store: ReturnType<typeof createInMemoryPaymentStore>; deps: CreatePaymentRequestDeps } {
  return {
    store,
    deps: {
      store,
      resolveProvider: () => provider,
      decryptConnectionCredential: () => "decrypted-secret",
    },
  };
}

async function main() {
// --- 1. no active connection => fails nicely ---
{
  const { deps } = depsWith();
  await assert.rejects(
    () => createPaymentRequest({ businessId: 1, amount: 100 }, deps),
    /No active payment connection/
  );
}

// --- 2. inactive connection => still fails ---
{
  const { store, deps } = depsWith();
  store.seedConnection({ businessId: 1, provider: "TRANZILA", isActive: false });
  await assert.rejects(
    () => createPaymentRequest({ businessId: 1, amount: 100 }, deps),
    /No active payment connection/
  );
}

// --- 3. active connection + stub provider => returns paymentUrl ---
{
  const { store, deps } = depsWith();
  store.seedConnection({ businessId: 1, provider: "TRANZILA", isActive: true });
  const result = await createPaymentRequest(
    { businessId: 1, amount: 100, description: "Invoice #5", billingDocumentId: 5 },
    deps
  );
  assert.ok(result.paymentUrl.startsWith("https://stub.local/checkout/"));
  assert.equal(result.paymentRequest.status, "PENDING");
  assert.equal(result.paymentRequest.amount, "100.00");
  assert.equal(result.paymentRequest.currency, "ILS");
  assert.equal(result.paymentRequest.billingDocumentId, 5);
  assert.ok(result.paymentRequest.providerRequestId);
  assert.equal(result.paymentRequest.paymentUrl, result.paymentUrl);
}

// --- 4. provider failure => request marked FAILED + throws ---
{
  const { store, deps } = depsWith(
    createInMemoryPaymentStore(),
    {
      provider: "TRANZILA",
      async createPaymentLink() {
        throw new Error("provider down");
      },
      verifyWebhook: () => ({ ok: true }),
      parseWebhook: () => ({
        providerEventId: null,
        eventType: null,
        providerRequestId: null,
        providerTransactionId: null,
        outcome: "UNKNOWN",
        amount: null,
        currency: null,
      }),
    }
  );
  store.seedConnection({ businessId: 1, provider: "TRANZILA", isActive: true });
  await assert.rejects(
    () => createPaymentRequest({ businessId: 1, amount: 50 }, deps),
    /Failed to create payment link/
  );
  assert.equal(store.requests.length, 1);
  assert.equal(store.requests[0]?.status, "FAILED");
}

// --- 5. invalid amount => validation error ---
{
  const { store, deps } = depsWith();
  store.seedConnection({ businessId: 1, provider: "TRANZILA", isActive: true });
  await assert.rejects(
    () => createPaymentRequest({ businessId: 1, amount: -5 }, deps),
    /amount must be a positive number/
  );
}

  console.log("payment-request tests: OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
