/**
 * D2 / ACCOUNT-DELETION-2A.1 — the late-webhook proof.
 *
 *   npx tsx lib/services/payments/payment-webhook-quarantine.test.ts
 *
 * The threat this closes is timing, not authorization. A provider webhook resolves its
 * tenant from the STORED PaymentRequest, which keeps resolving perfectly well after
 * the business has asked to be erased — so without a gate, a callback that arrives
 * during or after the erasure would happily create a PaymentTransaction and a
 * FinancialEvent for a tenant that is being deleted. That is resurrection.
 *
 * Everything here drives the REAL `processPaymentWebhook` through the in-memory store,
 * so what is proven is the actual code path and not a description of it:
 *
 *   1. ACTIVE            → settles exactly as before (the gate changes nothing normal)
 *   2. DELETION_REQUESTED→ refused: no transaction, no status change, no financial hook
 *   3. PURGED            → same refusal
 *   4. business gone     → refused (fail-closed on an unknown tenant)
 *   5. the refusal is TERMINAL and recorded, so the provider is answered and stops
 *      retrying instead of hammering a deleted tenant forever
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

const VERIFIED_PAID: ProviderPaymentStatus = {
  outcome: "PAID",
  providerTransactionId: null,
};

type Lifecycle = "ACTIVE" | "DELETION_REQUESTED" | "PURGED" | null;

function setup(lifecycle: Lifecycle) {
  const store = createInMemoryPaymentStore();
  store.seedConnection({ businessId: 1, provider: "TRANZILA", isActive: true });
  // Override the store's lifecycle answer — this is the seam the webhook consults.
  (store as unknown as {
    getBusinessLifecycle: (businessId: number) => Promise<Lifecycle>;
  }).getBusinessLifecycle = async () => lifecycle;

  const financialHookCalls: VerifiedPaidEvent[] = [];
  const deps: ProcessWebhookDeps = {
    store,
    resolveProvider: () => createStubProvider({ verifiedStatus: VERIFIED_PAID }),
    onVerifiedPaid: async (e) => {
      financialHookCalls.push(e);
    },
  };
  return { store, deps, financialHookCalls };
}

async function seedPendingRequest(store: ReturnType<typeof createInMemoryPaymentStore>) {
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
  await store.updatePaymentRequest(created.id, { providerRequestId: "req-abc" });
  return created;
}

function paidBody(eventId = "evt-1"): string {
  return JSON.stringify({
    eventId,
    eventType: "payment.completed",
    providerRequestId: "req-abc",
    providerTransactionId: "txn-1",
    outcome: "PAID",
    amount: "100.00",
    currency: "ILS",
  });
}

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`  [PASS] ${name}`);
  } else {
    fail++;
    console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`);
  }
}

async function main() {
  // --- 1. control: an ACTIVE business still settles ------------------------
  {
    const { store, deps, financialHookCalls } = setup("ACTIVE");
    await seedPendingRequest(store);
    const res = await processPaymentWebhook({ provider: "TRANZILA", rawBody: paidBody() }, deps);
    ok("ACTIVE: the webhook still settles (the gate changes nothing normal)", res.ok === true);
    ok("ACTIVE: request reaches PAID", store.requests[0]?.status === "PAID");
    ok("ACTIVE: a PaymentTransaction is recorded", store.transactions.length === 1);
    ok("ACTIVE: the financial hook fires", financialHookCalls.length === 1);
  }

  // --- 2/3/4. every non-ACTIVE lifecycle refuses ---------------------------
  for (const lifecycle of ["DELETION_REQUESTED", "PURGED", null] as const) {
    const label = lifecycle ?? "MISSING BUSINESS";
    const { store, deps, financialHookCalls } = setup(lifecycle);
    const req = await seedPendingRequest(store);
    const res = await processPaymentWebhook({ provider: "TRANZILA", rawBody: paidBody() }, deps);

    ok(`${label}: the webhook is refused`, res.ok === false, JSON.stringify(res.reason));
    ok(
      `${label}: the reason names the quarantine`,
      typeof res.reason === "string" && res.reason.startsWith("business_quarantined"),
      String(res.reason)
    );
    ok(`${label}: NO PaymentTransaction is created`, store.transactions.length === 0);
    ok(`${label}: NO FinancialEvent hook fires`, financialHookCalls.length === 0);
    ok(
      `${label}: the PaymentRequest is left untouched`,
      store.requests.find((r) => r.id === req.id)?.status === "PENDING"
    );
    ok(
      `${label}: the event is recorded terminally so the provider stops retrying`,
      store.webhookEvents.length === 1 &&
        store.webhookEvents[0]?.processingStatus === "FAILED",
      JSON.stringify(store.webhookEvents[0]?.processingStatus)
    );
  }

  // --- 5. the bootstrap ledger still works while the tenant is closed ------
  {
    const { store, deps } = setup("PURGED");
    await seedPendingRequest(store);
    await processPaymentWebhook({ provider: "TRANZILA", rawBody: paidBody("evt-a") }, deps);
    await processPaymentWebhook({ provider: "TRANZILA", rawBody: paidBody("evt-b") }, deps);
    ok(
      "a quarantined tenant still gets its events LEDGERED (refusing to record would cause retry storms)",
      store.webhookEvents.length === 2
    );
    ok("and still creates nothing operational", store.transactions.length === 0);
  }

  console.log(`\n[webhook-quarantine] PASS=${pass} FAIL=${fail}`);
  if (fail > 0) {
    process.exit(1);
  }
  console.log("ALL CHECKS PASS");
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
