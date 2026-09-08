/**
 * Run: npx tsx lib/services/payments/payment-provider-seam.test.ts
 *
 * MULTI-PROVIDER REQUEST SEAM.
 *
 * The defect: the schema allows a business N provider connections
 * (`@@unique([businessId, provider])` is unique per PAIR, not per business), but
 * `createPaymentRequest` only selected a provider when exactly one connection
 * was active, and `POST /api/payments/requests` never read a `provider` field.
 * A business that connected a second acquirer therefore lost the ability to
 * create ANY payment request — the failure a second provider would have caused
 * on day one.
 *
 * The policy proven here has three modes and one refusal:
 *   A. provider named        -> must be known, enabled, and connected
 *   B. none named, one active -> use it (unchanged behaviour)
 *   C. none named, several    -> refuse, and name the candidates
 *
 * Mode C stays a refusal on purpose. Choosing one of a merchant's acquirers on
 * their behalf is not this layer's decision, and no default-provider column was
 * added to avoid it: introducing a stored preference to resolve an ambiguity the
 * UI can resolve directly would create a source of truth before anything needs
 * one.
 *
 * No DB, no network.
 */
import assert from "node:assert/strict";
import {
  AmbiguousPaymentProviderError,
  createPaymentRequest,
  selectPaymentProvider,
} from "./payment-request.service";
import { createInMemoryPaymentStore } from "./payment-store.memory";
import { createStubProvider } from "./providers/stub/stub.provider";
import { DISABLED_PAYMENT_PROVIDERS } from "./providers/provider-availability";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`OK: ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL: ${name}${detail ? " — " + detail : ""}`);
  }
}

function deps(store: ReturnType<typeof createInMemoryPaymentStore>) {
  return {
    store,
    resolveProvider: () => createStubProvider({ supportedCurrencies: ["ILS"] }),
    decryptConnectionCredential: () => "credential",
  };
}

async function main() {
  // ── 0 active providers ──────────────────────────────────────────────────
  {
    const store = createInMemoryPaymentStore();
    await assert.rejects(
      () => createPaymentRequest({ businessId: 1, amount: 100 }, deps(store)),
      /No active payment connection/
    );
    ok("no connection: refused with an actionable message", true);
  }

  // ── mode B: 1 active, none named ────────────────────────────────────────
  {
    const store = createInMemoryPaymentStore();
    store.seedConnection({ businessId: 1, provider: "CARDCOM", isActive: true });
    const res = await createPaymentRequest({ businessId: 1, amount: 100 }, deps(store));
    ok(
      "one active provider, none named: selected automatically (unchanged)",
      res.paymentRequest.provider === "CARDCOM"
    );
  }

  // An INACTIVE connection does not count as a candidate.
  {
    const store = createInMemoryPaymentStore();
    store.seedConnection({ businessId: 1, provider: "CARDCOM", isActive: false });
    await assert.rejects(
      () => createPaymentRequest({ businessId: 1, amount: 100 }, deps(store)),
      /No active payment connection/
    );
    ok("an inactive connection is not a candidate", true);
  }

  // ── mode C: several active, none named ──────────────────────────────────
  //
  // Two ENABLED providers are needed to exercise the ambiguity honestly. Only
  // CardCom is enabled today, so this drives `selectPaymentProvider` directly
  // with a store that reports two active connections — the shape a second live
  // provider will create.
  {
    const twoActive = {
      listConnections: async () => [
        {
          id: 1,
          businessId: 1,
          provider: "CARDCOM" as const,
          merchantId: "m1",
          credentialEncrypted: null,
          credentialIv: null,
          credentialTag: null,
          encryptionKeyId: null,
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: 2,
          businessId: 1,
          provider: "PAYPAL" as const,
          merchantId: "m2",
          credentialEncrypted: null,
          credentialIv: null,
          credentialTag: null,
          encryptionKeyId: null,
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    };

    let caught: unknown;
    try {
      await selectPaymentProvider({ businessId: 1, requested: null }, twoActive);
    } catch (e) {
      caught = e;
    }
    ok(
      "two active providers, none named: a typed ambiguity error",
      caught instanceof AmbiguousPaymentProviderError
    );
    const err = caught as AmbiguousPaymentProviderError;
    ok(
      "the error names the candidates so a caller can present a choice",
      err.candidates.includes("CARDCOM") && err.candidates.includes("PAYPAL")
    );
    ok(
      "and carries a stable machine-readable code",
      err.code === "PAYMENT_PROVIDER_REQUIRED"
    );
    ok("it is a 400, not a 500", err.statusCode === 400);

    // Mode A resolves that same ambiguity deterministically.
    const chosen = await selectPaymentProvider(
      { businessId: 1, requested: "CARDCOM" },
      twoActive
    );
    ok("naming one of the two resolves it deterministically", chosen === "CARDCOM");
  }

  // ── mode A validation: known / enabled / connected, each independently ──
  {
    const store = createInMemoryPaymentStore();
    store.seedConnection({ businessId: 1, provider: "CARDCOM", isActive: true });

    await assert.rejects(
      () =>
        selectPaymentProvider(
          { businessId: 1, requested: "STRIPE" as never },
          store
        ),
      /Unknown payment provider/
    );
    ok("an unregistered provider name is refused", true);

    await assert.rejects(
      () =>
        selectPaymentProvider({ businessId: 1, requested: "PAYPAL" }, store),
      /not available: PAYPAL/
    );
    ok("a globally disabled provider is refused even when named explicitly", true);
  }

  // Registered + enabled, but this business has no connection to it.
  {
    const store = createInMemoryPaymentStore();
    store.seedConnection({ businessId: 1, provider: "CARDCOM", isActive: true });
    await assert.rejects(
      () =>
        selectPaymentProvider(
          { businessId: 2, requested: "CARDCOM" },
          store
        ),
      /No active CARDCOM connection/
    );
    ok("a provider this business has not connected is refused", true);
  }

  // A connection that exists but is switched off is not usable either.
  {
    const store = createInMemoryPaymentStore();
    store.seedConnection({ businessId: 1, provider: "CARDCOM", isActive: false });
    await assert.rejects(
      () =>
        selectPaymentProvider({ businessId: 1, requested: "CARDCOM" }, store),
      /No active CARDCOM connection/
    );
    ok("an explicitly named but INACTIVE connection is refused", true);
  }

  // ── tenant scoping of the selection itself ──────────────────────────────
  //
  // Selection reads connections for the ACTING business only, so one tenant can
  // never be routed through another tenant's acquirer.
  {
    const store = createInMemoryPaymentStore();
    store.seedConnection({ businessId: 1, provider: "CARDCOM", isActive: true });
    await assert.rejects(
      () => createPaymentRequest({ businessId: 2, amount: 100 }, deps(store)),
      /No active payment connection/
    );
    ok("a business cannot select another business's connection", true);
  }

  // ── the disabled set is what the gate reads ─────────────────────────────
  {
    ok(
      "the enablement gate reads the same disabled set as the rest of the system",
      DISABLED_PAYMENT_PROVIDERS.includes("PAYPAL") &&
        DISABLED_PAYMENT_PROVIDERS.includes("TRANZILA") &&
        !DISABLED_PAYMENT_PROVIDERS.includes("CARDCOM")
    );
  }

  // ── backward compatibility of the request shape ─────────────────────────
  {
    const store = createInMemoryPaymentStore();
    store.seedConnection({ businessId: 1, provider: "CARDCOM", isActive: true });
    const withoutProvider = await createPaymentRequest(
      { businessId: 1, amount: 100 },
      deps(store)
    );
    const withProvider = await createPaymentRequest(
      { businessId: 1, amount: 100, provider: "CARDCOM" },
      deps(store)
    );
    ok(
      "omitting and naming the provider reach the same result",
      withoutProvider.paymentRequest.provider ===
        withProvider.paymentRequest.provider
    );
  }

  console.log(`\npayment-provider-seam: ${pass} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.log("FAILURES:\n - " + failures.join("\n - "));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
