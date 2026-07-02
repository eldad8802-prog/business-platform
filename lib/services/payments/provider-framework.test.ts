/**
 * Run: npx tsx lib/services/payments/provider-framework.test.ts
 *
 * Phase 1 — Provider Framework (descriptor-driven connections). No DB, no real
 * provider: in-memory store + capturing fake encryptor to assert the stored
 * credential shape.
 */
import assert from "node:assert/strict";
import {
  getProviderDescriptor,
  listProviderDescriptors,
  isSupportedProvider,
} from "./providers/provider-registry";
import {
  connectProviderFromDescriptor,
  type PaymentConnectionDeps,
} from "./payment-connection.service";
import { createInMemoryPaymentStore } from "./payment-store.memory";
import type { EncryptedCredentialMaterial } from "./payment-crypto.service";

function capturingDeps() {
  const store = createInMemoryPaymentStore();
  let lastPlaintext: string | null = null;
  const encryptCredential = (plaintext: string): EncryptedCredentialMaterial => {
    lastPlaintext = plaintext;
    return {
      credentialEncrypted: `ENC(${plaintext})`,
      credentialIv: "IV",
      credentialTag: "TAG",
      encryptionKeyId: "k1",
    };
  };
  const deps: PaymentConnectionDeps = { store, encryptCredential };
  return { store, deps, getPlaintext: () => lastPlaintext };
}

async function main() {
  // === catalog / registry ===================================================
  {
    const cat = listProviderDescriptors();
    assert.deepEqual(cat.map((d) => d.key).sort(), ["CARDCOM", "TRANZILA"]);

    const cc = getProviderDescriptor("CARDCOM");
    const tz = getProviderDescriptor("TRANZILA");
    assert.equal(cc?.capabilities.verification, true); // GetLpResult
    assert.equal(tz?.capabilities.verification, false); // signal-only
    assert.equal(getProviderDescriptor("NOPE"), null);
    assert.equal(isSupportedProvider("cardcom".toUpperCase()), true);

    // catalog is metadata only — field definitions carry no `value`.
    for (const d of cat) {
      for (const f of d.credentialFields) {
        assert.ok(f.key && f.label && (f.type === "text" || f.type === "secret"));
        assert.ok(!("value" in (f as Record<string, unknown>)));
      }
    }
  }

  // === CardCom generic connect: credential = JSON {apiName,apiPassword} ======
  {
    const { deps, store, getPlaintext } = capturingDeps();
    const conn = await connectProviderFromDescriptor(
      {
        businessId: 1,
        provider: "CARDCOM",
        fields: { terminalNumber: "999", apiName: "myapi", apiPassword: "pw" },
        actorUserId: 7,
      },
      deps
    );
    assert.equal(conn.provider, "CARDCOM");
    assert.equal(conn.merchantId, "999");
    assert.equal(conn.hasCredential, true);
    assert.equal(getPlaintext(), JSON.stringify({ apiName: "myapi", apiPassword: "pw" }));
    assert.ok(
      store.auditEvents.some((e) => e.eventType === "PAYMENT_CONNECTION_UPSERTED")
    );
  }

  // === Tranzila generic connect: credential = JSON {secret} =================
  {
    const { deps, getPlaintext } = capturingDeps();
    const conn = await connectProviderFromDescriptor(
      { businessId: 1, provider: "TRANZILA", fields: { merchantId: "term1", secret: "s3cr3t" } },
      deps
    );
    assert.equal(conn.merchantId, "term1");
    assert.equal(getPlaintext(), JSON.stringify({ secret: "s3cr3t" }));
  }

  // === merchantId fallback key works (canonical `merchantId`) ================
  {
    const { deps } = capturingDeps();
    const conn = await connectProviderFromDescriptor(
      { businessId: 1, provider: "CARDCOM", fields: { merchantId: "555", apiName: "a", apiPassword: "b" } },
      deps
    );
    assert.equal(conn.merchantId, "555"); // fell back to `merchantId`
  }

  // === validation: missing required credential field ========================
  {
    const { deps } = capturingDeps();
    await assert.rejects(
      () =>
        connectProviderFromDescriptor(
          { businessId: 1, provider: "CARDCOM", fields: { terminalNumber: "999", apiName: "x" } },
          deps
        ),
      /API Password is required/
    );
  }

  // === validation: unknown provider =========================================
  {
    const { deps } = capturingDeps();
    await assert.rejects(
      () =>
        connectProviderFromDescriptor(
          { businessId: 1, provider: "NOPE", fields: { merchantId: "x" } },
          deps
        ),
      /Unknown payment provider/
    );
  }

  // === validation: missing merchant id ======================================
  {
    const { deps } = capturingDeps();
    await assert.rejects(
      () =>
        connectProviderFromDescriptor(
          { businessId: 1, provider: "TRANZILA", fields: { secret: "x" } },
          deps
        ),
      /required/
    );
  }

  console.log("provider-framework tests: OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
