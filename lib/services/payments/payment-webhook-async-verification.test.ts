/**
 * Run: npx tsx lib/services/payments/payment-webhook-async-verification.test.ts
 *
 * ASYNC WEBHOOK VERIFICATION CONTRACT.
 *
 * `PaymentProviderAdapter.verifyWebhook` was synchronous. That signature made a
 * whole class of provider inexpressible: one that authenticates a callback
 * through its own API — PayPal's `verify-webhook-signature` being the concrete
 * example named in its own adapter — needs I/O to answer, and could only have
 * been bolted on by verifying somewhere other than the verification step.
 *
 * The contract is now a Promise. The three properties that make the change safe
 * rather than cosmetic are what this file proves:
 *
 *   1. the result is AWAITED — nothing downstream runs until verification has
 *      resolved, so a slow verification cannot let processing race ahead of it;
 *   2. a REJECTED promise is a FAILURE — an adapter that throws must not be
 *      able to authenticate anything;
 *   3. everything already true stays true — refusals still mutate nothing, and
 *      duplicates are still idempotent.
 *
 * A fake adapter is used deliberately: no new provider is introduced to test a
 * contract change.
 *
 * No DB, no network.
 */
import {
  processPaymentWebhook,
  type ProcessWebhookDeps,
} from "./payment-webhook.service";
import { createInMemoryPaymentStore } from "./payment-store.memory";
import { createStubProvider } from "./providers/stub/stub.provider";
import type { ProviderPaymentStatus } from "./providers/payment-provider.types";

const VERIFIED_PAID: ProviderPaymentStatus = {
  outcome: "PAID",
  providerTransactionId: "TXN-1",
};

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

/** A store with one business, one active connection, one PENDING request. */
async function scenario() {
  const store = createInMemoryPaymentStore();
  store.seedConnection({ businessId: 1, provider: "CARDCOM", isActive: true });
  const request = await store.createPaymentRequest({
    businessId: 1,
    customerId: null,
    billingDocumentId: null,
    provider: "CARDCOM",
    amount: "100.00",
    currency: "ILS",
    description: null,
    status: "PENDING",
    expiresAt: null,
  });
  await store.updatePaymentRequest(request.id, { providerRequestId: "PRQ-1" });
  await store.upsertProviderRouting({
    provider: "CARDCOM",
    providerRequestId: "PRQ-1",
    paymentRequestId: request.id,
    businessId: 1,
  });
  return { store, requestId: request.id };
}

function deps(
  store: ReturnType<typeof createInMemoryPaymentStore>,
  options: Parameters<typeof createStubProvider>[0] = {}
): ProcessWebhookDeps {
  return {
    store,
    resolveProvider: () =>
      createStubProvider({ verifiedStatus: VERIFIED_PAID, ...options }),
    decryptConnectionCredential: () => "credential",
  };
}

const body = {
  eventId: "evt-1",
  providerRequestId: "PRQ-1",
  outcome: "PAID",
};

function call(
  store: ReturnType<typeof createInMemoryPaymentStore>,
  options: Parameters<typeof createStubProvider>[0] = {},
  payload: Record<string, unknown> = body
) {
  return processPaymentWebhook(
    {
      provider: "CARDCOM",
      rawBody: JSON.stringify(payload),
      parsedBody: payload,
      headers: {},
    },
    deps(store, options)
  );
}

async function main() {
  // ── 1. a valid webhook still settles ────────────────────────────────────
  {
    const { store, requestId } = await scenario();
    const res = await call(store);
    ok(
      "a valid webhook settles to PAID through an async verifier",
      res.ok === true && res.paymentRequestStatus === "PAID"
    );
    ok("exactly one transaction was recorded", store.transactions.length === 1);
    ok(
      "and it belongs to the right request",
      store.transactions[0]?.paymentRequestId === requestId
    );
  }

  // ── 2. an invalid webhook is refused ────────────────────────────────────
  {
    const { store } = await scenario();
    const res = await call(store, { requiredSecret: "expected-secret" });
    ok(
      "a webhook failing async verification is refused",
      res.ok === false && res.reason?.startsWith("verify:") === true
    );
    ok("no transaction is created", store.transactions.length === 0);
    ok("no webhook event row is persisted", store.webhookEvents.length === 0);
    ok(
      "the request stays PENDING",
      store.requests[0]?.status === "PENDING"
    );
  }

  // ── 3. verification is genuinely AWAITED ────────────────────────────────
  //
  // The gate resolves only after an explicit release. If the service did not
  // await, processing would reach the store before the flag flips and the
  // assertion below would see settlement completed against an unresolved
  // verification.
  {
    const { store } = await scenario();
    let released = false;
    let resolveGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      resolveGate = () => {
        released = true;
        resolve();
      };
    });

    const inFlight = call(store, { verifyGate: gate });

    // Give the microtask queue several turns. Without an await in the service,
    // processing would have run to completion by now.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    ok(
      "nothing is persisted while verification is still pending",
      store.transactions.length === 0 && store.webhookEvents.length === 0
    );
    ok("and the gate really had not been released yet", released === false);

    resolveGate();
    const res = await inFlight;
    ok(
      "processing completes only after verification resolves",
      released === true && res.ok === true && res.paymentRequestStatus === "PAID"
    );
    ok("and it settles exactly once", store.transactions.length === 1);
  }

  // ── 4. a REJECTED verification is a failure, never a pass ───────────────
  {
    const { store } = await scenario();
    const res = await call(store, {
      verifyThrows: new Error("verification service unreachable"),
    });
    ok(
      "an adapter that throws during verification refuses the callback",
      res.ok === false && res.reason === "verify: verification_error"
    );
    ok("no transaction is created", store.transactions.length === 0);
    ok("no webhook event row is persisted", store.webhookEvents.length === 0);
    ok(
      "the request is untouched",
      store.requests[0]?.status === "PENDING" && store.requests[0]?.paidAt === null
    );
    ok(
      "the refusal is recorded as FAILED, not silently swallowed",
      res.processingStatus === "FAILED"
    );
  }

  // ── 5. idempotency survives the contract change ─────────────────────────
  {
    const { store } = await scenario();
    const first = await call(store);
    const second = await call(store);
    ok(
      "a duplicate callback is still recognised as a duplicate",
      first.ok === true && second.duplicate === true
    );
    ok(
      "and produces no second transaction",
      store.transactions.length === 1
    );
  }

  // ── 6. a slow verification does not break duplicate protection ──────────
  //
  // Two callbacks for one settlement, both held behind the same gate and
  // released together — the shape a real provider retry produces when
  // verification is slow.
  {
    const { store } = await scenario();
    let resolveGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    const a = call(store, { verifyGate: gate }, { ...body, eventId: "evt-c1" });
    const b = call(store, { verifyGate: gate }, { ...body, eventId: "evt-c2" });
    resolveGate();
    await Promise.all([a, b]);
    ok(
      "concurrent callbacks behind a slow verifier still settle once",
      store.transactions.length === 1,
      `transactions=${store.transactions.length}`
    );
  }

  console.log(
    `\npayment-webhook-async-verification: ${pass} passed, ${failures.length} failed`
  );
  if (failures.length > 0) {
    console.log("FAILURES:\n - " + failures.join("\n - "));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
