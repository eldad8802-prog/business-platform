/**
 * Run: npx tsx lib/services/payments/payment-provider-selection.test.ts
 *
 * I4: CardCom connection (service level) + provider selection in
 * createPaymentRequest. No DB, no real provider, no network.
 */
import assert from "node:assert/strict";
import {
  connectPaymentProvider,
  type PaymentConnectionDeps,
} from "./payment-connection.service";
import {
  createPaymentRequest,
  type CreatePaymentRequestDeps,
} from "./payment-request.service";
import { createInMemoryPaymentStore } from "./payment-store.memory";
import type { EncryptedCredentialMaterial } from "./payment-crypto.service";
import type { PaymentProviderAdapter } from "./providers/payment-provider.types";

const fakeEncrypt = (plaintext: string): EncryptedCredentialMaterial => ({
  credentialEncrypted: `ENC(${plaintext})`,
  credentialIv: "IV",
  credentialTag: "TAG",
  encryptionKeyId: "k1",
});

const fakeProvider: PaymentProviderAdapter = {
  provider: "CARDCOM",
  supportedCurrencies: ["ILS", "USD"],
  async createPaymentLink(input) {
    return {
      paymentUrl: `https://fake/${input.businessId}-${input.paymentRequestId}`,
      providerRequestId: `fake-${input.paymentRequestId}`,
      expiresAt: null,
    };
  },
  verifyWebhook: async () => ({ ok: true }),
  parseWebhook: () => ({
    providerEventId: null,
    eventType: null,
    providerRequestId: null,
    providerTransactionId: null,
    outcome: "UNKNOWN",
    amount: null,
    currency: null,
  }),
};

function requestDeps(
  store: ReturnType<typeof createInMemoryPaymentStore>
): CreatePaymentRequestDeps {
  return {
    store,
    resolveProvider: () => fakeProvider,
    decryptConnectionCredential: () => "x",
  };
}

async function main() {
  // --- 1. CardCom connect: provider CARDCOM, encrypted, no secret returned ---
  {
    const store = createInMemoryPaymentStore();
    const deps: PaymentConnectionDeps = { store, encryptCredential: fakeEncrypt };
    const credential = JSON.stringify({ apiName: "myapi", apiPassword: "secretpass" });
    const conn = await connectPaymentProvider(
      { businessId: 1, provider: "CARDCOM", merchantId: "1000", credential },
      deps
    );
    assert.equal(conn.provider, "CARDCOM");
    assert.equal(conn.merchantId, "1000");
    assert.equal(conn.hasCredential, true);
    const json = JSON.stringify(conn);
    assert.ok(!json.includes("secretpass"));
    assert.ok(!json.includes("ENC("));
    assert.ok(!("credentialEncrypted" in conn));

    // stored connection is encrypted and resolvable as active
    const active = await store.findActiveConnection(1, "CARDCOM");
    assert.ok(active);
    assert.equal(active?.credentialEncrypted, "ENC(" + credential + ")");
  }

  // --- 2. single active CardCom => request resolves to CARDCOM ---
  {
    const store = createInMemoryPaymentStore();
    store.seedConnection({ businessId: 1, provider: "CARDCOM", isActive: true });
    const res = await createPaymentRequest({ businessId: 1, amount: 100 }, requestDeps(store));
    assert.equal(res.paymentRequest.provider, "CARDCOM");
    assert.equal(res.paymentRequest.status, "PENDING");
  }

  // --- 3. a surviving connection to a DISABLED provider is refused ---
  //
  // This case previously asserted the opposite — "single active Tranzila =>
  // resolves to TRANZILA (backward compat)" — and that expectation is now a
  // known defect rather than a contract. CASA Wave E disabled Tranzila
  // everywhere it could create or process state (connect route, webhook,
  // catalogue) but left request creation ungated, and it left existing
  // connection rows in place on purpose. A business holding a pre-Wave-E active
  // Tranzila connection could therefore still mint a Tranzila payment link,
  // send a customer to a real checkout and take a real payment — whose callback
  // the webhook handler answers with 404. Money taken, never confirmed, which
  // is exactly the outcome the Wave E memo says the closure existed to prevent.
  {
    const store = createInMemoryPaymentStore();
    store.seedConnection({ businessId: 1, provider: "TRANZILA", isActive: true });
    await assert.rejects(
      () => createPaymentRequest({ businessId: 1, amount: 100 }, requestDeps(store)),
      /not available: TRANZILA/
    );
    assert.equal(store.requests.length, 0, "no PaymentRequest row is created");
  }

  // --- 3b. naming the disabled provider explicitly is refused identically ---
  {
    const store = createInMemoryPaymentStore();
    store.seedConnection({ businessId: 1, provider: "TRANZILA", isActive: true });
    await assert.rejects(
      () =>
        createPaymentRequest(
          { businessId: 1, amount: 100, provider: "TRANZILA" },
          requestDeps(store)
        ),
      /not available: TRANZILA/
    );
  }

  // --- 4. multiple active providers => must specify explicitly ---
  {
    const store = createInMemoryPaymentStore();
    store.seedConnection({ businessId: 1, provider: "TRANZILA", isActive: true });
    store.seedConnection({ businessId: 1, provider: "CARDCOM", isActive: true });
    await assert.rejects(
      () => createPaymentRequest({ businessId: 1, amount: 100 }, requestDeps(store)),
      /more than one active payment provider/
    );
  }

  // --- 5. explicit provider chosen even when multiple are active ---
  {
    const store = createInMemoryPaymentStore();
    store.seedConnection({ businessId: 1, provider: "TRANZILA", isActive: true });
    store.seedConnection({ businessId: 1, provider: "CARDCOM", isActive: true });
    const res = await createPaymentRequest(
      { businessId: 1, amount: 100, provider: "CARDCOM" },
      requestDeps(store)
    );
    assert.equal(res.paymentRequest.provider, "CARDCOM");
  }

  // --- 6. no active connection => clear error (unchanged) ---
  {
    const store = createInMemoryPaymentStore();
    await assert.rejects(
      () => createPaymentRequest({ businessId: 1, amount: 100 }, requestDeps(store)),
      /No active payment connection/
    );
  }

  console.log("payment-provider-selection tests: OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
