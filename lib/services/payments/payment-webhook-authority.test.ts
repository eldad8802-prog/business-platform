/**
 * Run: npx tsx lib/services/payments/payment-webhook-authority.test.ts
 *
 * Authority orchestration (I2): webhook is a signal; provider verification is
 * authority; only a verified payment may transition to PAID. No DB, no real
 * provider — in-memory store + synthetic adapters + the real registry for the
 * CardCom stub.
 */
import assert from "node:assert/strict";
import {
  processPaymentWebhook,
  type ProcessWebhookDeps,
} from "./payment-webhook.service";
import { createInMemoryPaymentStore } from "./payment-store.memory";
import { resolvePaymentProvider } from "./providers/provider-registry";
import type {
  PaymentProviderAdapter,
  ProviderPaymentStatus,
} from "./providers/payment-provider.types";

const REQUEST_ID = "req-1";

/** A verification-capable adapter whose webhook always CLAIMS PAID. */
function capableProvider(
  getStatus: () => Promise<ProviderPaymentStatus>,
  opts: { verifyOk?: boolean; eventId?: string } = {}
): PaymentProviderAdapter {
  return {
    provider: "TRANZILA",
    async createPaymentLink() {
      throw new Error("unused in webhook tests");
    },
    verifyWebhook: () =>
      opts.verifyOk === false ? { ok: false, reason: "bad" } : { ok: true },
    parseWebhook: () => ({
      providerEventId: opts.eventId ?? "evt-1",
      eventType: "payment",
      providerRequestId: REQUEST_ID,
      providerTransactionId: null,
      outcome: "PAID", // the webhook *claims* PAID — only a signal
      amount: "100.00",
      currency: "ILS",
    }),
    getPaymentStatus: getStatus,
  };
}

async function seedPending(
  store: ReturnType<typeof createInMemoryPaymentStore>,
  provider: "TRANZILA" | "CARDCOM" = "TRANZILA",
  withConnection = true
) {
  if (withConnection) {
    store.seedConnection({ businessId: 1, provider, isActive: true, merchantId: "m1" });
  }
  const created = await store.createPaymentRequest({
    businessId: 1,
    customerId: null,
    billingDocumentId: null,
    provider,
    amount: "100.00",
    currency: "ILS",
    description: null,
    status: "PENDING",
    expiresAt: null,
  });
  await store.updatePaymentRequest(created.id, { providerRequestId: REQUEST_ID });
  return created;
}

function depsFor(
  store: ReturnType<typeof createInMemoryPaymentStore>,
  provider: PaymentProviderAdapter
): ProcessWebhookDeps {
  return {
    store,
    resolveProvider: () => provider,
    decryptConnectionCredential: () => "cred",
  };
}

const body = JSON.stringify({ any: "thing" });

async function main() {
  // --- 1. verification confirms PAID => request PAID, tx recorded, verified ---
  {
    const store = createInMemoryPaymentStore();
    await seedPending(store);
    const deps = depsFor(
      store,
      capableProvider(async () => ({ outcome: "PAID", providerTransactionId: "txn-1" }))
    );
    const res = await processPaymentWebhook({ provider: "TRANZILA", rawBody: body }, deps);
    assert.equal(res.ok, true);
    assert.equal(res.verified, true);
    assert.equal(res.paymentRequestStatus, "PAID");
    assert.equal(store.requests[0]?.status, "PAID");
    assert.equal(store.transactions.length, 1);
    assert.equal(store.transactions[0]?.providerTransactionId, "txn-1");
  }

  // --- 2. webhook CLAIMS PAID but verification says FAILED => never PAID ---
  {
    const store = createInMemoryPaymentStore();
    await seedPending(store);
    const deps = depsFor(
      store,
      capableProvider(async () => ({ outcome: "FAILED", providerTransactionId: "txn-2" }))
    );
    const res = await processPaymentWebhook({ provider: "TRANZILA", rawBody: body }, deps);
    assert.equal(res.verified, true);
    assert.notEqual(res.paymentRequestStatus, "PAID");
    assert.equal(store.requests[0]?.status, "FAILED");
  }

  // --- 3. verification throws => fail safe, no PAID, no transaction ---
  {
    const store = createInMemoryPaymentStore();
    await seedPending(store);
    const deps = depsFor(
      store,
      capableProvider(async () => {
        throw new Error("verification endpoint down");
      })
    );
    const res = await processPaymentWebhook({ provider: "TRANZILA", rawBody: body }, deps);
    assert.equal(res.ok, false);
    assert.equal(res.processingStatus, "FAILED");
    assert.equal(res.reason, "verification_error");
    assert.equal(store.requests[0]?.status, "PENDING"); // untouched
    assert.equal(store.transactions.length, 0);
  }

  // --- 4. verification-capable but no active connection => cannot verify ---
  {
    const store = createInMemoryPaymentStore();
    await seedPending(store, "TRANZILA", /* withConnection */ false);
    const deps = depsFor(
      store,
      capableProvider(async () => ({ outcome: "PAID", providerTransactionId: "txn-x" }))
    );
    const res = await processPaymentWebhook({ provider: "TRANZILA", rawBody: body }, deps);
    assert.equal(res.ok, false);
    assert.equal(res.reason, "verification_unavailable_no_active_connection");
    assert.equal(store.requests[0]?.status, "PENDING");
    assert.equal(store.transactions.length, 0);
  }

  // --- 5. provider WITHOUT verification (no getPaymentStatus) => signal only:
  //        a webhook that CLAIMS PAID never settles. Request stays PENDING, no
  //        transaction. The Authority Principle, enforced uniformly (Stage 0). ---
  const signalOnlyProvider = (eventId: string): PaymentProviderAdapter => ({
    provider: "TRANZILA",
    async createPaymentLink() {
      throw new Error("unused");
    },
    verifyWebhook: () => ({ ok: true }),
    parseWebhook: () => ({
      providerEventId: eventId,
      eventType: "payment",
      providerRequestId: REQUEST_ID,
      providerTransactionId: `txn-${eventId}`,
      outcome: "PAID", // the webhook CLAIMS PAID — but it is only a signal
      amount: "100.00",
      currency: "ILS",
    }),
    // no getPaymentStatus => no authority => can never settle to PAID
  });
  {
    const store = createInMemoryPaymentStore();
    await seedPending(store);
    const res = await processPaymentWebhook(
      { provider: "TRANZILA", rawBody: body },
      depsFor(store, signalOnlyProvider("evt-signal"))
    );
    assert.equal(res.ok, true);
    assert.equal(res.verified, false); // explicit: signal-only, not authority
    assert.equal(res.reason, "signal_only_no_verification");
    assert.notEqual(res.paymentRequestStatus, "PAID");
    assert.equal(store.requests[0]?.status, "PENDING");
    assert.equal(store.transactions.length, 0);
  }

  // --- 6. CARDCOM stub (real registry) can NEVER produce PAID ---
  {
    const store = createInMemoryPaymentStore();
    await seedPending(store, "CARDCOM");
    const deps: ProcessWebhookDeps = {
      store,
      resolveProvider: resolvePaymentProvider, // real registry => CardCom stub
      decryptConnectionCredential: () => "cred",
    };
    const res = await processPaymentWebhook(
      { provider: "CARDCOM", rawBody: body },
      deps
    );
    assert.equal(res.ok, false);
    assert.notEqual(res.paymentRequestStatus, "PAID");
    assert.equal(store.requests[0]?.status, "PENDING");
    assert.equal(store.transactions.length, 0);
  }

  // --- 7. AC8: a signal-only provider can fire the webhook repeatedly and a
  //        PAID is NEVER produced — a webhook alone is insufficient for PAID. ---
  {
    const store = createInMemoryPaymentStore();
    await seedPending(store);
    await processPaymentWebhook(
      { provider: "TRANZILA", rawBody: body },
      depsFor(store, signalOnlyProvider("evt-a"))
    );
    await processPaymentWebhook(
      { provider: "TRANZILA", rawBody: body },
      depsFor(store, signalOnlyProvider("evt-b"))
    );
    assert.equal(store.requests[0]?.status, "PENDING");
    assert.equal(store.transactions.length, 0);
  }

  console.log("payment-webhook-authority tests: OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
