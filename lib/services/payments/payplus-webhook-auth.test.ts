/**
 * Run: npx tsx lib/services/payments/payplus-webhook-auth.test.ts
 *
 * GAP A — MERCHANT-SCOPED WEBHOOK AUTHENTICATION.
 *
 * CardCom's callback carries no signature at all, so the system authenticated
 * with a structural gate at step A, before anything was correlated. PayPlus
 * signs with the MERCHANT's own secret key, and until a callback is correlated
 * to a stored PaymentRequest the system does not know whose key to check. The
 * candidate key can therefore only be chosen after correlation.
 *
 * THE SECURITY ARGUMENT, and what this file exists to prove:
 *
 *   Correlation is a READ, and a read is not authorization.
 *
 * An unauthenticated caller may cause the system to look up a candidate secret.
 * It may not cause one byte of state to change. Everything below tests one of
 * the two halves of that sentence: that a bad signature is refused, and that a
 * refused callback leaves nothing behind.
 *
 * Explicitly NOT how this is solved, and asserted as such:
 *   - no trying keys until one matches (exactly one candidate, ever);
 *   - no taking the tenant from the payload;
 *   - no skipping verification when a key is unavailable;
 *   - no provider-wide shared secret, which PayPlus does not have;
 *   - no change to CardCom's behaviour.
 *
 * No DB, no network.
 */
import { createHmac } from "node:crypto";

import {
  processPaymentWebhook,
  type ProcessWebhookDeps,
} from "./payment-webhook.service";
import { createInMemoryPaymentStore } from "./payment-store.memory";
import { createPayPlusProvider } from "./providers/payplus/payplus.provider";
import { createStubProvider } from "./providers/stub/stub.provider";
import type {
  PaymentProviderAdapter,
  ProviderPaymentStatus,
} from "./providers/payment-provider.types";

const SECRET_A = "merchant-a-secret-key";
const SECRET_B = "merchant-b-secret-key";
const BIZ_A = 1;
const BIZ_B = 2;

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

function credentialFor(secretKey: string): string {
  return JSON.stringify({ apiKey: "api-key-value", secretKey });
}

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("base64");
}

/**
 * Two businesses, each with its own PayPlus connection and its own secret, each
 * with one PENDING request. This is the shape that makes cross-merchant
 * confusion testable at all.
 */
async function twoMerchants(options: { aActive?: boolean } = {}) {
  const store = createInMemoryPaymentStore();
  store.seedConnection({
    businessId: BIZ_A,
    provider: "PAYPLUS",
    merchantId: "page-a",
    credentialEncrypted: credentialFor(SECRET_A),
    isActive: options.aActive ?? true,
  });
  store.seedConnection({
    businessId: BIZ_B,
    provider: "PAYPLUS",
    merchantId: "page-b",
    credentialEncrypted: credentialFor(SECRET_B),
    isActive: true,
  });

  const made: Record<number, number> = {};
  for (const [biz, uid] of [
    [BIZ_A, "PRQ-A"],
    [BIZ_B, "PRQ-B"],
  ] as const) {
    const r = await store.createPaymentRequest({
      businessId: biz,
      customerId: null,
      billingDocumentId: null,
      provider: "PAYPLUS",
      amount: "100.00",
      currency: "ILS",
      description: null,
      status: "PENDING",
      expiresAt: null,
    });
    await store.updatePaymentRequest(r.id, { providerRequestId: uid });
    await store.upsertProviderRouting({
      provider: "PAYPLUS",
      providerRequestId: uid,
      paymentRequestId: r.id,
      businessId: biz,
    });
    made[biz] = r.id;
  }
  return { store, requestIdA: made[BIZ_A]!, requestIdB: made[BIZ_B]! };
}

const VERIFIED_PAID: ProviderPaymentStatus = {
  outcome: "PAID",
  providerTransactionId: "TXN-1",
};

/**
 * The real PayPlus adapter, with only its HTTP client replaced. Signature
 * verification, parsing and the status query are the shipped code.
 */
function payplusAdapter(statusJson: unknown): PaymentProviderAdapter {
  return createPayPlusProvider({
    baseUrl: "https://restapidev.payplus.co.il/api/v1.0",
    publicBaseUrl: "https://preview.example",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => statusJson,
    }),
  });
}

const PAID_VIEW = {
  results: { status: "success" },
  data: [{ uid: "TXN-1", status_code: "000", transaction_is_cancelled: false }],
};

function deps(
  store: ReturnType<typeof createInMemoryPaymentStore>,
  adapter: PaymentProviderAdapter
): ProcessWebhookDeps {
  return {
    store,
    resolveProvider: () => adapter,
    // The credential arrives already decrypted in production; the fake returns
    // whatever the seeded connection holds.
    decryptConnectionCredential: (c) => c.credentialEncrypted,
  };
}

function callbackBody(requestId: number, pageUid: string) {
  return JSON.stringify({
    transaction_type: "Charge",
    transaction: {
      uid: "TXN-1",
      payment_request_uid: pageUid,
      status_code: "000",
      amount: "100.00",
      currency: "ILS",
      more_info: String(requestId),
    },
  });
}

function call(
  store: ReturnType<typeof createInMemoryPaymentStore>,
  adapter: PaymentProviderAdapter,
  rawBody: string,
  headers: Record<string, string | null | undefined>
) {
  return processPaymentWebhook(
    { provider: "PAYPLUS", rawBody, headers },
    deps(store, adapter)
  );
}

/** Nothing written at all: no event row, no transaction, no status movement. */
function untouched(
  store: ReturnType<typeof createInMemoryPaymentStore>
): boolean {
  return (
    store.webhookEvents.length === 0 &&
    store.transactions.length === 0 &&
    store.requests.every((r) => r.status === "PENDING" && r.paidAt === null)
  );
}

async function main() {
  const adapter = payplusAdapter(PAID_VIEW);

  // ── 1. a correctly signed callback from merchant A is accepted ───────────
  {
    const { store, requestIdA } = await twoMerchants();
    const body = callbackBody(requestIdA, "PRQ-A");
    const res = await call(store, adapter, body, {
      "user-agent": "PayPlus",
      hash: sign(body, SECRET_A),
    });
    ok(
      "merchant A's own signature is accepted and settles",
      res.ok === true && res.paymentRequestStatus === "PAID",
      `reason=${res.reason}`
    );
    ok("exactly one transaction", store.transactions.length === 1);
    ok(
      "and it settled A's request, not B's",
      store.transactions[0]?.paymentRequestId === requestIdA
    );
  }

  // ── 2. THE CROSS-MERCHANT ATTACK ────────────────────────────────────────
  //
  // A payload pointing at merchant A's request, signed with merchant B's key.
  // B is a real merchant with a real connection and a valid key — so this is
  // not a forgery test, it is the "wrong candidate" test. If the system ever
  // tried more than one key, this would pass and must not.
  {
    const { store, requestIdA } = await twoMerchants();
    const body = callbackBody(requestIdA, "PRQ-A");
    const res = await call(store, adapter, body, {
      "user-agent": "PayPlus",
      hash: sign(body, SECRET_B),
    });
    ok(
      "a payload for A signed with B's key is REFUSED",
      res.ok === false && res.reason === "merchant_auth: signature_mismatch",
      `reason=${res.reason}`
    );
    ok("and nothing whatsoever was written", untouched(store));
  }

  // ── 3. an invalid signature ─────────────────────────────────────────────
  {
    const { store, requestIdA } = await twoMerchants();
    const body = callbackBody(requestIdA, "PRQ-A");
    const res = await call(store, adapter, body, {
      "user-agent": "PayPlus",
      hash: sign(body, "not-the-secret"),
    });
    ok(
      "an unknown key is refused",
      res.ok === false && res.reason === "merchant_auth: signature_mismatch"
    );
    ok("nothing written", untouched(store));
  }

  // ── 4. a malformed signature ────────────────────────────────────────────
  {
    const { store, requestIdA } = await twoMerchants();
    const body = callbackBody(requestIdA, "PRQ-A");
    const res = await call(store, adapter, body, {
      "user-agent": "PayPlus",
      hash: "!!!not-base64!!!",
    });
    ok("a malformed signature is refused", res.ok === false);
    ok("nothing written", untouched(store));
  }

  // ── 5. a missing signature ──────────────────────────────────────────────
  {
    const { store, requestIdA } = await twoMerchants();
    const body = callbackBody(requestIdA, "PRQ-A");
    const res = await call(store, adapter, body, { "user-agent": "PayPlus" });
    ok(
      "a callback with no hash header is refused at the structural gate",
      res.ok === false && res.reason === "verify: missing_signature",
      `reason=${res.reason}`
    );
    ok("nothing written", untouched(store));
  }

  // ── 6. a body that is signed correctly but claims a foreign user-agent ──
  {
    const { store, requestIdA } = await twoMerchants();
    const body = callbackBody(requestIdA, "PRQ-A");
    const res = await call(store, adapter, body, {
      "user-agent": "curl/8.0",
      hash: sign(body, SECRET_A),
    });
    ok(
      "a non-PayPlus user-agent is refused",
      res.ok === false && res.reason === "verify: unexpected_user_agent"
    );
    ok("nothing written", untouched(store));
  }

  // ── 7. unknown correlation — refused before a key is even chosen ────────
  {
    const { store } = await twoMerchants();
    const body = callbackBody(999999, "PRQ-DOES-NOT-EXIST");
    const res = await call(store, adapter, body, {
      "user-agent": "PayPlus",
      hash: sign(body, SECRET_A),
    });
    ok(
      "an identifier this system never issued is refused at correlation",
      res.ok === false && res.reason === "no_matching_payment_request"
    );
    ok("nothing written", untouched(store));
  }

  // ── 8. manipulated correlation: real session id, wrong more_info ────────
  {
    const { store, requestIdB } = await twoMerchants();
    // Point at A's session but claim B's request id in more_info.
    const body = callbackBody(requestIdB, "PRQ-A");
    const res = await call(store, adapter, body, {
      "user-agent": "PayPlus",
      hash: sign(body, SECRET_A),
    });
    ok(
      "a mismatched second correlation channel is refused",
      res.ok === false && res.reason === "correlation_value_mismatch",
      `reason=${res.reason}`
    );
    ok("nothing written", untouched(store));
  }

  // ── 9. amount and currency coherence still bind ─────────────────────────
  {
    const { store, requestIdA } = await twoMerchants();
    const body = JSON.stringify({
      transaction: {
        uid: "TXN-1",
        payment_request_uid: "PRQ-A",
        status_code: "000",
        amount: "5.00",
        currency: "ILS",
        more_info: String(requestIdA),
      },
    });
    const res = await call(store, adapter, body, {
      "user-agent": "PayPlus",
      hash: sign(body, SECRET_A),
    });
    ok(
      "a callback claiming a different amount is refused",
      res.ok === false && res.reason === "amount_mismatch"
    );
    ok("nothing written", untouched(store));
  }
  {
    const { store, requestIdA } = await twoMerchants();
    const body = JSON.stringify({
      transaction: {
        uid: "TXN-1",
        payment_request_uid: "PRQ-A",
        status_code: "000",
        amount: "100.00",
        currency: "USD",
        more_info: String(requestIdA),
      },
    });
    const res = await call(store, adapter, body, {
      "user-agent": "PayPlus",
      hash: sign(body, SECRET_A),
    });
    ok(
      "a callback claiming a different currency is refused",
      res.ok === false && res.reason === "currency_mismatch"
    );
    ok("nothing written", untouched(store));
  }

  // ── 10. no connection = no key = refusal, never accept-by-default ───────
  {
    // A's connection is INACTIVE from the start, so its key is unreachable.
    const { store, requestIdA } = await twoMerchants({ aActive: false });
    const body = callbackBody(requestIdA, "PRQ-A");
    const res = await call(store, adapter, body, {
      "user-agent": "PayPlus",
      hash: sign(body, SECRET_A),
    });
    ok(
      "with no active connection the callback is refused, not accepted",
      res.ok === false && res.reason === "merchant_authentication_unavailable",
      `reason=${res.reason}`
    );
    ok("nothing written", untouched(store));
  }

  // ── 11. an adapter that throws during authentication ────────────────────
  {
    const { store, requestIdA } = await twoMerchants();
    const throwing: PaymentProviderAdapter = {
      ...adapter,
      authenticateWebhook: async () => {
        throw new Error("hsm unreachable");
      },
    };
    const body = callbackBody(requestIdA, "PRQ-A");
    const res = await call(store, throwing, body, {
      "user-agent": "PayPlus",
      hash: sign(body, SECRET_A),
    });
    ok(
      "an authentication exception is a refusal, never a pass",
      res.ok === false && res.reason === "merchant_authentication_error"
    );
    ok("nothing written", untouched(store));
  }

  // ── 12. a slow authentication mutates nothing while pending ─────────────
  {
    const { store, requestIdA } = await twoMerchants();
    let released = false;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = () => {
        released = true;
        r();
      };
    });
    const slow: PaymentProviderAdapter = {
      ...adapter,
      authenticateWebhook: async (i) => {
        await gate;
        return adapter.authenticateWebhook!(i);
      },
    };
    const body = callbackBody(requestIdA, "PRQ-A");
    const inFlight = call(store, slow, body, {
      "user-agent": "PayPlus",
      hash: sign(body, SECRET_A),
    });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    ok(
      "nothing is persisted while authentication is still pending",
      untouched(store) && released === false
    );
    release();
    const res = await inFlight;
    ok(
      "and it completes only once authentication resolves",
      released === true && res.paymentRequestStatus === "PAID"
    );
  }

  // ── 13. duplicate valid callback stays idempotent ───────────────────────
  {
    const { store, requestIdA } = await twoMerchants();
    const body = callbackBody(requestIdA, "PRQ-A");
    const headers = { "user-agent": "PayPlus", hash: sign(body, SECRET_A) };
    const first = await call(store, adapter, body, headers);
    const second = await call(store, adapter, body, headers);
    ok(
      "a repeated valid callback is recognised as a duplicate",
      first.ok === true && second.duplicate === true
    );
    ok("and settles only once", store.transactions.length === 1);
  }

  // ── 14. CardCom is untouched by any of this ─────────────────────────────
  //
  // The stub has no `authenticateWebhook`, exactly as CardCom does not, so it
  // proves the new step is skipped entirely for providers that do not sign
  // per-merchant.
  {
    const store = createInMemoryPaymentStore();
    store.seedConnection({ businessId: BIZ_A, provider: "CARDCOM", isActive: true });
    const r = await store.createPaymentRequest({
      businessId: BIZ_A,
      customerId: null,
      billingDocumentId: null,
      provider: "CARDCOM",
      amount: "100.00",
      currency: "ILS",
      description: null,
      status: "PENDING",
      expiresAt: null,
    });
    await store.updatePaymentRequest(r.id, { providerRequestId: "CC-1" });
    await store.upsertProviderRouting({
      provider: "CARDCOM",
      providerRequestId: "CC-1",
      paymentRequestId: r.id,
      businessId: BIZ_A,
    });
    const payload = { eventId: "e1", providerRequestId: "CC-1", outcome: "PAID" };
    const res = await processPaymentWebhook(
      {
        provider: "CARDCOM",
        rawBody: JSON.stringify(payload),
        parsedBody: payload,
        headers: {},
      },
      {
        store,
        resolveProvider: () =>
          createStubProvider({ verifiedStatus: VERIFIED_PAID }),
        decryptConnectionCredential: () => "credential",
      }
    );
    ok(
      "a provider without authenticateWebhook is unaffected — no new gate, no new header",
      res.ok === true && res.paymentRequestStatus === "PAID",
      `reason=${res.reason}`
    );
  }

  console.log(`\npayplus-webhook-auth: ${pass} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.log("FAILURES:\n - " + failures.join("\n - "));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
