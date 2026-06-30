/**
 * Run: npx tsx lib/services/payments/payment-routes.test.ts
 *
 * Exercises the route-facing seams (connection service, webhook handler, list
 * filtering) with the in-memory store + stub provider — no DB, no real
 * provider, no crypto key. Routes themselves are thin wrappers over these.
 */
import assert from "node:assert/strict";
import {
  connectPaymentProvider,
  listPaymentConnections,
  type PaymentConnectionDeps,
} from "./payment-connection.service";
import { createPaymentRequest } from "./payment-request.service";
import { handleProviderWebhook } from "./payment-webhook-handler";
import { createInMemoryPaymentStore } from "./payment-store.memory";
import { createStubProvider } from "./providers/stub/stub.provider";
import type { ProcessWebhookDeps } from "./payment-webhook.service";
import type { EncryptedCredentialMaterial } from "./payment-crypto.service";

const fakeEncrypt = (
  plaintext: string
): EncryptedCredentialMaterial => ({
  credentialEncrypted: `ENC(${plaintext})`,
  credentialIv: "IV",
  credentialTag: "TAG",
  encryptionKeyId: "k1",
});

async function main() {
  // --- connect: stores encrypted credential, returns NO secret ---
  {
    const store = createInMemoryPaymentStore();
    const deps: PaymentConnectionDeps = { store, encryptCredential: fakeEncrypt };
    const conn = await connectPaymentProvider(
      { businessId: 1, merchantId: "term-123", credential: "super-secret" },
      deps
    );
    assert.equal(conn.merchantId, "term-123");
    assert.equal(conn.isActive, true);
    assert.equal(conn.hasCredential, true);
    // The public shape must not carry credential material at all.
    const json = JSON.stringify(conn);
    assert.ok(!json.includes("super-secret"));
    assert.ok(!json.includes("ENC("));
    assert.ok(!("credentialEncrypted" in conn));
  }

  // --- connect then create request works against the same store ---
  {
    const store = createInMemoryPaymentStore();
    await connectPaymentProvider(
      { businessId: 1, merchantId: "term-123", credential: "secret" },
      { store, encryptCredential: fakeEncrypt }
    );
    const result = await createPaymentRequest(
      { businessId: 1, amount: 200 },
      {
        store,
        resolveProvider: () => createStubProvider(),
        decryptConnectionCredential: () => "secret",
      }
    );
    assert.ok(result.paymentUrl.startsWith("https://stub.local/"));
    assert.equal(result.paymentRequest.status, "PENDING");
  }

  // --- create request with no connection => rejects (route -> 400) ---
  {
    const store = createInMemoryPaymentStore();
    await assert.rejects(
      () =>
        createPaymentRequest(
          { businessId: 1, amount: 100 },
          {
            store,
            resolveProvider: () => createStubProvider(),
            decryptConnectionCredential: () => null,
          }
        ),
      /No active payment connection/
    );
  }

  // --- list connections never leaks secrets ---
  {
    const store = createInMemoryPaymentStore();
    const deps: PaymentConnectionDeps = { store, encryptCredential: fakeEncrypt };
    await connectPaymentProvider(
      { businessId: 1, merchantId: "m1", credential: "secret-1" },
      deps
    );
    const list = await listPaymentConnections(1, deps);
    assert.equal(list.length, 1);
    const json = JSON.stringify(list);
    assert.ok(!json.includes("secret-1"));
    assert.ok(!json.includes("ENC("));
    assert.equal(list[0]?.hasCredential, true);
  }

  // --- list requests filters by businessId and customerId ---
  {
    const store = createInMemoryPaymentStore();
    const baseRow = {
      provider: "TRANZILA" as const,
      amount: "10.00",
      currency: "ILS",
      description: null,
      status: "PENDING" as const,
      expiresAt: null,
      billingDocumentId: null,
    };
    await store.createPaymentRequest({ businessId: 1, customerId: 7, ...baseRow });
    await store.createPaymentRequest({ businessId: 1, customerId: 8, ...baseRow });
    await store.createPaymentRequest({ businessId: 2, customerId: 7, ...baseRow });

    const forBiz1 = await store.listPaymentRequests(1);
    assert.equal(forBiz1.length, 2);
    assert.ok(forBiz1.every((r) => r.businessId === 1));

    const biz1Cust7 = await store.listPaymentRequests(1, { customerId: 7 });
    assert.equal(biz1Cust7.length, 1);
    assert.equal(biz1Cust7[0]?.customerId, 7);
  }

  // --- webhook handler always 200 { ok: true } ---
  {
    const store = createInMemoryPaymentStore();
    store.seedConnection({ businessId: 1, provider: "TRANZILA", isActive: true });
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
    await store.updatePaymentRequest(created.id, { providerRequestId: "req-1" });

    const deps: ProcessWebhookDeps = {
      store,
      resolveProvider: () =>
        createStubProvider({
          verifiedStatus: { outcome: "PAID", providerTransactionId: null },
        }),
    };

    const paid = await handleProviderWebhook(
      {
        provider: "TRANZILA",
        rawBody: JSON.stringify({
          eventId: "e1",
          providerRequestId: "req-1",
          providerTransactionId: "t1",
          outcome: "PAID",
        }),
      },
      deps
    );
    assert.equal(paid.status, 200);
    assert.deepEqual(paid.body, { ok: true });
    assert.equal(store.requests[0]?.status, "PAID");

    // unmatched
    const unmatched = await handleProviderWebhook(
      {
        provider: "TRANZILA",
        rawBody: JSON.stringify({ eventId: "e2", providerRequestId: "nope", outcome: "PAID" }),
      },
      deps
    );
    assert.equal(unmatched.status, 200);
    assert.deepEqual(unmatched.body, { ok: true });

    // garbage body
    const garbage = await handleProviderWebhook(
      { provider: "TRANZILA", rawBody: "not-json" },
      deps
    );
    assert.equal(garbage.status, 200);
    assert.deepEqual(garbage.body, { ok: true });
  }

  // --- webhook handler swallows store errors and still returns 200 ---
  {
    const throwingDeps: ProcessWebhookDeps = {
      store: {
        async insertWebhookEventIfNew() {
          throw new Error("db down");
        },
      } as unknown as ProcessWebhookDeps["store"],
      resolveProvider: () => createStubProvider(),
    };
    const res = await handleProviderWebhook(
      { provider: "TRANZILA", rawBody: JSON.stringify({ eventId: "e", outcome: "PAID" }) },
      throwingDeps
    );
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
  }

  console.log("payment-routes tests: OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
