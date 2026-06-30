/**
 * Run: npx tsx lib/services/payments/payment-audit.test.ts
 *
 * M7 — Payments audit. Pure validation/hash + best-effort recorder + emission
 * at the existing payment points (request created, connection upserted, webhook
 * authority decisions). No DB — in-memory store captures the appended events.
 */
import assert from "node:assert/strict";
import {
  buildPaymentAuditRow,
  recordPaymentAuditEvent,
  getPaymentAuditTimeline,
} from "./payment-audit.service";
import { createInMemoryPaymentStore } from "./payment-store.memory";
import { connectPaymentProvider } from "./payment-connection.service";
import { createPaymentRequest } from "./payment-request.service";
import { processPaymentWebhook } from "./payment-webhook.service";
import { createStubProvider } from "./providers/stub/stub.provider";
import type { EncryptedCredentialMaterial } from "./payment-crypto.service";
import type { PaymentProviderAdapter } from "./providers/payment-provider.types";

const fakeEncrypt = (plaintext: string): EncryptedCredentialMaterial => ({
  credentialEncrypted: `ENC(${plaintext})`,
  credentialIv: "IV",
  credentialTag: "TAG",
  encryptionKeyId: "k1",
});

async function main() {
  // === pure validation =====================================================

  // USER source requires an actor.
  assert.throws(
    () =>
      buildPaymentAuditRow({
        businessId: 1,
        eventType: "PAYMENT_REQUEST_CREATED",
        source: "USER",
        summary: "x",
      }),
    /actorUserId is required/
  );

  // SYSTEM / PROVIDER need no actor.
  assert.ok(
    buildPaymentAuditRow({
      businessId: 1,
      eventType: "PAYMENT_SIGNAL_ONLY_NO_VERIFICATION",
      source: "SYSTEM",
      summary: "signal",
    })
  );

  // invalid eventType / source / empty summary are rejected.
  assert.throws(() =>
    buildPaymentAuditRow({
      businessId: 1,
      // @ts-expect-error invalid eventType on purpose
      eventType: "NOPE",
      source: "SYSTEM",
      summary: "x",
    })
  );
  assert.throws(() =>
    buildPaymentAuditRow({
      businessId: 1,
      eventType: "PAYMENT_VERIFICATION_ERROR",
      // @ts-expect-error invalid source on purpose
      source: "ALIEN",
      summary: "x",
    })
  );
  assert.throws(() =>
    buildPaymentAuditRow({
      businessId: 1,
      eventType: "PAYMENT_VERIFICATION_ERROR",
      source: "SYSTEM",
      summary: "   ",
    })
  );

  // === hash determinism ====================================================
  {
    const input = {
      businessId: 1,
      paymentRequestId: 2,
      actorUserId: 3,
      eventType: "PAYMENT_REQUEST_CREATED" as const,
      source: "USER" as const,
      summary: "same",
      occurredAt: new Date("2026-06-29T00:00:00.000Z"),
    };
    const a = buildPaymentAuditRow(input);
    const b = buildPaymentAuditRow(input);
    assert.equal(a.eventHash, b.eventHash); // deterministic
    const c = buildPaymentAuditRow({ ...input, summary: "different" });
    assert.notEqual(a.eventHash, c.eventHash); // content-sensitive
  }

  // === best-effort recorder ================================================
  {
    // A throwing store must NOT propagate — the money path is never broken.
    const throwingStore = {
      async appendAuditEvent() {
        throw new Error("db down");
      },
    } as unknown as Parameters<typeof recordPaymentAuditEvent>[0];
    await recordPaymentAuditEvent(throwingStore, {
      businessId: 1,
      eventType: "PAYMENT_VERIFIED_PAID",
      source: "PROVIDER",
      summary: "ok",
    }); // resolves, does not throw
  }

  // === append-only + timeline ==============================================
  {
    const store = createInMemoryPaymentStore();
    await recordPaymentAuditEvent(store, {
      businessId: 1,
      paymentRequestId: 10,
      eventType: "PAYMENT_SIGNAL_ONLY_NO_VERIFICATION",
      source: "SYSTEM",
      summary: "first",
      occurredAt: new Date("2026-06-29T00:00:01.000Z"),
    });
    await recordPaymentAuditEvent(store, {
      businessId: 1,
      paymentRequestId: 10,
      eventType: "PAYMENT_VERIFIED_PAID",
      source: "PROVIDER",
      summary: "second",
      occurredAt: new Date("2026-06-29T00:00:02.000Z"),
    });
    await recordPaymentAuditEvent(store, {
      businessId: 2, // different business — must not leak
      eventType: "PAYMENT_SIGNAL_ONLY_NO_VERIFICATION",
      source: "SYSTEM",
      summary: "other-biz",
    });

    const timeline = await getPaymentAuditTimeline(store, {
      businessId: 1,
      paymentRequestId: 10,
    });
    assert.equal(timeline.length, 2);
    assert.equal(timeline[0]?.summary, "first"); // oldest-first
    assert.equal(timeline[1]?.summary, "second");
    assert.ok(timeline.every((e) => e.businessId === 1));
    // every persisted row carries an integrity hash
    assert.ok(timeline.every((e) => typeof e.eventHash === "string" && e.eventHash.length > 0));
  }

  // === emission: PAYMENT_REQUEST_CREATED (USER) ============================
  {
    const store = createInMemoryPaymentStore();
    store.seedConnection({ businessId: 1, provider: "TRANZILA", isActive: true });
    await createPaymentRequest(
      { businessId: 1, amount: 150, actorUserId: 42 },
      {
        store,
        resolveProvider: () => createStubProvider(),
        decryptConnectionCredential: () => "secret",
      }
    );
    const created = store.auditEvents.find((e) => e.eventType === "PAYMENT_REQUEST_CREATED");
    assert.ok(created, "expected PAYMENT_REQUEST_CREATED");
    assert.equal(created?.source, "USER");
    assert.equal(created?.actorUserId, 42);
    assert.ok(created?.paymentRequestId);
  }

  // === emission: PAYMENT_CONNECTION_UPSERTED carries NO credential =========
  {
    const store = createInMemoryPaymentStore();
    await connectPaymentProvider(
      { businessId: 1, merchantId: "term-1", credential: "super-secret", actorUserId: 7 },
      { store, encryptCredential: fakeEncrypt }
    );
    const ev = store.auditEvents.find((e) => e.eventType === "PAYMENT_CONNECTION_UPSERTED");
    assert.ok(ev, "expected PAYMENT_CONNECTION_UPSERTED");
    assert.equal(ev?.source, "USER");
    assert.equal(ev?.actorUserId, 7);
    const json = JSON.stringify(ev?.metadata);
    assert.ok(!json.includes("super-secret"), "credential must never be audited");
    assert.ok(!json.includes("ENC("), "encrypted material must never be audited");
  }

  // === emission: webhook signal-only (SYSTEM) =============================
  {
    const store = createInMemoryPaymentStore();
    store.seedConnection({ businessId: 1, provider: "TRANZILA", isActive: true });
    const req = await store.createPaymentRequest({
      businessId: 1, customerId: null, billingDocumentId: null,
      provider: "TRANZILA", amount: "100.00", currency: "ILS",
      description: null, status: "PENDING", expiresAt: null,
    });
    await store.updatePaymentRequest(req.id, { providerRequestId: "r-sig" });
    await processPaymentWebhook(
      {
        provider: "TRANZILA",
        rawBody: JSON.stringify({ eventId: "e1", providerRequestId: "r-sig", outcome: "PAID" }),
      },
      { store, resolveProvider: () => createStubProvider() } // no verifiedStatus => signal-only
    );
    const ev = store.auditEvents.find((e) => e.eventType === "PAYMENT_SIGNAL_ONLY_NO_VERIFICATION");
    assert.ok(ev, "expected PAYMENT_SIGNAL_ONLY_NO_VERIFICATION");
    assert.equal(ev?.source, "SYSTEM");
    assert.equal(ev?.paymentRequestId, req.id);
  }

  // === emission: webhook verified PAID (PROVIDER) =========================
  {
    const store = createInMemoryPaymentStore();
    store.seedConnection({ businessId: 1, provider: "TRANZILA", isActive: true });
    const req = await store.createPaymentRequest({
      businessId: 1, customerId: null, billingDocumentId: null,
      provider: "TRANZILA", amount: "100.00", currency: "ILS",
      description: null, status: "PENDING", expiresAt: null,
    });
    await store.updatePaymentRequest(req.id, { providerRequestId: "r-paid" });
    await processPaymentWebhook(
      {
        provider: "TRANZILA",
        rawBody: JSON.stringify({ eventId: "e1", providerRequestId: "r-paid", providerTransactionId: "t1", outcome: "PAID" }),
      },
      {
        store,
        resolveProvider: () =>
          createStubProvider({ verifiedStatus: { outcome: "PAID", providerTransactionId: null } }),
        decryptConnectionCredential: () => "cred",
      }
    );
    const ev = store.auditEvents.find((e) => e.eventType === "PAYMENT_VERIFIED_PAID");
    assert.ok(ev, "expected PAYMENT_VERIFIED_PAID");
    assert.equal(ev?.source, "PROVIDER");
    assert.equal(store.requests[0]?.status, "PAID");
  }

  // === emission: webhook verification error (SYSTEM) ======================
  {
    const store = createInMemoryPaymentStore();
    store.seedConnection({ businessId: 1, provider: "TRANZILA", isActive: true });
    const req = await store.createPaymentRequest({
      businessId: 1, customerId: null, billingDocumentId: null,
      provider: "TRANZILA", amount: "100.00", currency: "ILS",
      description: null, status: "PENDING", expiresAt: null,
    });
    await store.updatePaymentRequest(req.id, { providerRequestId: "r-err" });
    const throwingVerify: PaymentProviderAdapter = {
      provider: "TRANZILA",
      async createPaymentLink() { throw new Error("unused"); },
      verifyWebhook: () => ({ ok: true }),
      parseWebhook: () => ({
        providerEventId: "e1", eventType: "payment", providerRequestId: "r-err",
        providerTransactionId: null, outcome: "PAID", amount: "100.00", currency: "ILS",
      }),
      async getPaymentStatus() { throw new Error("verification endpoint down"); },
    };
    await processPaymentWebhook(
      { provider: "TRANZILA", rawBody: "{}" },
      { store, resolveProvider: () => throwingVerify, decryptConnectionCredential: () => "cred" }
    );
    const ev = store.auditEvents.find((e) => e.eventType === "PAYMENT_VERIFICATION_ERROR");
    assert.ok(ev, "expected PAYMENT_VERIFICATION_ERROR");
    assert.equal(ev?.source, "SYSTEM");
    assert.equal(store.requests[0]?.status, "PENDING"); // never settled
  }

  console.log("payment-audit tests: OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
