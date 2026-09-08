/**
 * Run: npx tsx lib/services/payments/provider-authority.test.ts
 *
 * STATUS AUTHORITY CONTRACT — the invariant, and where it is enforced.
 *
 * THE INVARIANT (verified against the code, not assumed):
 * `processPaymentWebhook` will move a request to a terminal state only from an
 * outcome `adapter.getPaymentStatus` established. An adapter without that
 * method takes the `signal_only_no_verification` branch, which audits the
 * signal and settles nothing — for ever. Such a provider can therefore never
 * complete a payment, which makes it unusable as a live capability rather than
 * merely limited.
 *
 * WHY THE METHOD IS STILL OPTIONAL IN THE TYPE.
 * Making it required would force every registered adapter to supply one, and
 * TRANZILA genuinely cannot: it is a dormant capability with no documented
 * verification path, retained only so historical records stay interpretable.
 * Giving it a `getPaymentStatus` that throws, or that returns UNKNOWN for ever,
 * would make the type look uniform while stating something untrue about the
 * provider — the "false abstraction" outcome worth avoiding more than an
 * optional method is.
 *
 * WHERE IT IS ENFORCED INSTEAD. At the capability boundary, which is where the
 * invariant is actually true: a provider may be an ENABLED capability only if
 * its adapter can establish authority. That is a real, checkable rule covering
 * every provider a business can reach, and it is what this file locks. A new
 * provider added without `getPaymentStatus` and switched on fails here.
 *
 * No DB, no network.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  processPaymentWebhook,
  type ProcessWebhookDeps,
} from "./payment-webhook.service";
import { createInMemoryPaymentStore } from "./payment-store.memory";
import { createStubProvider } from "./providers/stub/stub.provider";
import {
  listAllProviderDescriptors,
  resolvePaymentProvider,
} from "./providers/provider-registry";
import { isPaymentProviderEnabled } from "./providers/provider-availability";

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

async function scenario(provider: "CARDCOM" | "TRANZILA") {
  const store = createInMemoryPaymentStore();
  store.seedConnection({ businessId: 1, provider, isActive: true });
  const request = await store.createPaymentRequest({
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
  await store.updatePaymentRequest(request.id, { providerRequestId: "PRQ-1" });
  await store.upsertProviderRouting({
    provider,
    providerRequestId: "PRQ-1",
    paymentRequestId: request.id,
    businessId: 1,
  });
  return store;
}

async function main() {
  // ── 1. THE CAPABILITY RULE — every ENABLED provider can establish authority
  {
    const enabled = listAllProviderDescriptors().filter((d) =>
      isPaymentProviderEnabled(d.key)
    );
    ok("at least one provider is enabled", enabled.length > 0);

    for (const descriptor of enabled) {
      const adapter = resolvePaymentProvider(descriptor.key);
      ok(
        `${descriptor.key} (ENABLED) implements getPaymentStatus`,
        typeof adapter.getPaymentStatus === "function"
      );
      ok(
        `${descriptor.key} declares capabilities.verification = true, matching its adapter`,
        descriptor.capabilities.verification === true
      );
    }
  }

  // ── 2. the declaration cannot drift from the implementation ─────────────
  {
    for (const descriptor of listAllProviderDescriptors()) {
      const adapter = resolvePaymentProvider(descriptor.key);
      const implemented = typeof adapter.getPaymentStatus === "function";
      ok(
        `${descriptor.key}: declared verification matches the adapter (${String(implemented)})`,
        descriptor.capabilities.verification === implemented
      );
    }
  }

  // ── 3. a provider WITHOUT authority settles nothing — the reason the rule
  //      exists at all. Proven behaviourally, not by inspection.
  {
    const store = await scenario("CARDCOM");
    const deps: ProcessWebhookDeps = {
      store,
      // No verifiedStatus => the stub has no getPaymentStatus at all.
      resolveProvider: () => createStubProvider(),
      decryptConnectionCredential: () => "credential",
    };
    const payload = { eventId: "e1", providerRequestId: "PRQ-1", outcome: "PAID" };
    const res = await processPaymentWebhook(
      {
        provider: "CARDCOM",
        rawBody: JSON.stringify(payload),
        parsedBody: payload,
        headers: {},
      },
      deps
    );
    ok(
      "an adapter without getPaymentStatus takes the signal-only branch",
      res.reason === "signal_only_no_verification"
    );
    ok("it reports verified = false, never null or true", res.verified === false);
    ok("it creates no transaction", store.transactions.length === 0);
    ok(
      "and the request stays PENDING no matter what the payload claimed",
      store.requests[0]?.status === "PENDING"
    );
    ok(
      "the signal is still audited under the stored tenant",
      store.auditEvents.some(
        (e) => e.eventType === "PAYMENT_SIGNAL_ONLY_NO_VERIFICATION"
      )
    );
  }

  // ── 4. with authority, the same payload settles ─────────────────────────
  {
    const store = await scenario("CARDCOM");
    const deps: ProcessWebhookDeps = {
      store,
      resolveProvider: () =>
        createStubProvider({
          verifiedStatus: { outcome: "PAID", providerTransactionId: "TXN-9" },
        }),
      decryptConnectionCredential: () => "credential",
    };
    const payload = { eventId: "e1", providerRequestId: "PRQ-1", outcome: "PAID" };
    const res = await processPaymentWebhook(
      {
        provider: "CARDCOM",
        rawBody: JSON.stringify(payload),
        parsedBody: payload,
        headers: {},
      },
      deps
    );
    ok(
      "with getPaymentStatus present, the same webhook settles",
      res.verified === true && res.paymentRequestStatus === "PAID"
    );
  }

  // ── 5. the contract stays honest about being optional ───────────────────
  //
  // Structural, so that a future change making the method REQUIRED has to
  // revisit this file and the reasoning in it, rather than leaving a comment
  // that quietly stops being true.
  {
    const contract = readFileSync(
      join(process.cwd(), "lib/services/payments/providers/payment-provider.types.ts"),
      "utf8"
    );
    ok(
      "getPaymentStatus is still declared optional, and says why",
      contract.includes("getPaymentStatus?(") &&
        contract.includes("mandatory in PRACTICE")
    );
    const availability = readFileSync(
      join(process.cwd(), "lib/services/payments/providers/provider-availability.ts"),
      "utf8"
    );
    ok(
      "the availability module carries the capability invariant this file locks",
      availability.includes("getPaymentStatus")
    );
  }

  // ── 6. the disabled provider that motivates the exception ───────────────
  {
    const tranzila = resolvePaymentProvider("TRANZILA");
    ok(
      "TRANZILA has no getPaymentStatus — the honest reason the type stays optional",
      typeof tranzila.getPaymentStatus !== "function"
    );
    ok(
      "and it is not an enabled capability, so the invariant still holds system-wide",
      isPaymentProviderEnabled("TRANZILA") === false
    );
  }

  console.log(`\nprovider-authority: ${pass} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.log("FAILURES:\n - " + failures.join("\n - "));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
