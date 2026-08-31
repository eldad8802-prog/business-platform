/**
 * Run: npx tsx lib/services/payments/cardcom-webhook-hardening.test.ts
 *
 * CASA Wave D — adversarial coverage for the CardCom webhook trust model.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * CardCom publishes no webhook signing mechanism: its callback carries a
 * LowProfileId and a ReturnValue, and authenticity is obtained out-of-band by
 * calling LowProfile/GetLpResult with the merchant's own API credentials. The
 * previous implementation invented an `x-cardcom-secret` header and, with no
 * secret configured (the state in every real environment), returned ok — it
 * FAILED OPEN. Anyone who found the URL could post a body and cause a database
 * write plus an outbound provider lookup.
 *
 * Wave D replaced that with a provider-correct, fail-closed chain:
 *
 *   structural gate  → the body must be a well-formed LowProfile callback
 *   correlation      → LowProfileId must resolve to a PaymentRequest WE created
 *   second channel   → ReturnValue must match that request's id
 *   coherence        → any amount/currency the body claims must match the request
 *   ── only now is anything persisted ──
 *   authority        → outcome comes ONLY from an authenticated GetLpResult
 *   idempotency      → duplicate event / duplicate transaction settle once
 *
 * No real network, no real credentials, no card data. Everything is mocked.
 */
import assert from "node:assert/strict";
import {
  processPaymentWebhook,
  type ProcessWebhookDeps,
  type VerifiedPaidEvent,
} from "./payment-webhook.service";
import { createInMemoryPaymentStore } from "./payment-store.memory";
import { createCardComProvider, type CardComHttpClient } from "./providers/cardcom/cardcom.provider";
import { tranzilaProvider } from "./providers/tranzila/tranzila.provider";

// A synthetic — never real — CardCom LowProfileId. Production LowProfileIds are
// canonical GUIDs; the structural gate is calibrated to that shape.
const LPID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OTHER_LPID = "99999999-8888-4777-8666-555555555555";
const CRED = JSON.stringify({ apiName: "api", apiPassword: "pw" });

/** GetLpResult body that means "this transaction really succeeded". */
const GET_RESULT_PAID = {
  ResponseCode: 0,
  TranzactionInfo: { ResponseCode: 0, TranzactionId: 777 },
};
/** GetLpResult body that means "this transaction did NOT succeed". */
const GET_RESULT_DECLINED = {
  ResponseCode: 0,
  TranzactionInfo: { ResponseCode: 5, TranzactionId: 778 },
};

function cardcom(getResultJson: unknown, onCall?: () => void) {
  const fetchImpl: CardComHttpClient = async (url) => {
    onCall?.();
    if (url.includes("GetLpResult")) {
      return { ok: true, status: 200, json: async () => getResultJson };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  return createCardComProvider({
    fetchImpl,
    baseUrl: "https://test.cardcom",
    publicBaseUrl: "https://app.example",
  });
}

/** A callback body in CardCom's shape. */
function callback(opts: {
  lowProfileId?: string | null;
  returnValue?: string | number | null;
  extra?: Record<string, unknown>;
}) {
  const body: Record<string, unknown> = { ...(opts.extra ?? {}) };
  if (opts.lowProfileId !== null) body.LowProfileId = opts.lowProfileId ?? LPID;
  if (opts.returnValue !== null && opts.returnValue !== undefined) {
    body.ReturnValue = String(opts.returnValue);
  }
  return JSON.stringify(body);
}

async function setup(opts: { getResult?: unknown; businessId?: number } = {}) {
  const businessId = opts.businessId ?? 1;
  const store = createInMemoryPaymentStore();
  store.seedConnection({
    businessId,
    provider: "CARDCOM",
    isActive: true,
    merchantId: "1000",
  });
  const paidEvents: VerifiedPaidEvent[] = [];
  let providerCalls = 0;
  const deps: ProcessWebhookDeps = {
    store,
    resolveProvider: () =>
      cardcom(opts.getResult ?? GET_RESULT_PAID, () => {
        providerCalls += 1;
      }),
    decryptConnectionCredential: () => CRED,
    onVerifiedPaid: async (e) => {
      paidEvents.push(e);
    },
  };
  return {
    store,
    deps,
    paidEvents,
    providerCalls: () => providerCalls,
    async seedRequest(over: { businessId?: number; lowProfileId?: string } = {}) {
      const created = await store.createPaymentRequest({
        businessId: over.businessId ?? businessId,
        customerId: null,
        billingDocumentId: null,
        provider: "CARDCOM",
        amount: "120.00",
        currency: "ILS",
        description: "Wave D fixture",
        status: "PENDING",
        expiresAt: null,
      });
      await store.updatePaymentRequest(created.id, {
        providerRequestId: over.lowProfileId ?? LPID,
      });
      return created;
    },
  };
}

async function main() {
  // --- 1. legitimate callback + authoritative PAID => settles exactly once ---
  {
    const t = await setup();
    const req = await t.seedRequest();
    const res = await processPaymentWebhook(
      { provider: "CARDCOM", rawBody: callback({ returnValue: req.id }) },
      t.deps
    );
    assert.equal(res.ok, true, "legitimate callback must be accepted");
    assert.equal(res.verified, true, "outcome must come from GetLpResult");
    assert.equal(res.paymentRequestStatus, "PAID");
    assert.equal(t.store.transactions.length, 1);
    assert.equal(t.store.transactions[0]?.providerTransactionId, "777");
    assert.equal(t.store.webhookEvents.length, 1);
    assert.equal(t.paidEvents.length, 1, "exactly one money-in projection");
    // The settled amount comes from OUR request, never from the callback body.
    assert.equal(t.store.transactions[0]?.amount, "120.00");
  }

  // --- 2. random identifiers => refused, nothing written, provider never called
  {
    const t = await setup();
    await t.seedRequest();
    const res = await processPaymentWebhook(
      {
        provider: "CARDCOM",
        rawBody: callback({ lowProfileId: OTHER_LPID, returnValue: 12345 }),
      },
      t.deps
    );
    assert.equal(res.ok, false);
    assert.equal(res.reason, "no_matching_payment_request");
    assert.equal(res.eventId, null, "must not persist an uncorrelated callback");
    assert.equal(t.store.webhookEvents.length, 0);
    assert.equal(t.store.transactions.length, 0);
    assert.equal(t.paidEvents.length, 0);
    assert.equal(
      t.providerCalls(),
      0,
      "an uncorrelated callback must not force an outbound provider lookup"
    );
    assert.equal(t.store.requests[0]?.status, "PENDING", "request untouched");
  }

  // --- 3. missing / malformed required fields => refused --------------------
  {
    for (const [label, rawBody] of [
      ["empty body", ""],
      ["not json", "not json at all"],
      ["no LowProfileId", JSON.stringify({ ReturnValue: "1" })],
      ["malformed LowProfileId", callback({ lowProfileId: "lp-1" })],
      ["sql-ish LowProfileId", callback({ lowProfileId: "' OR 1=1 --" })],
    ] as const) {
      const t = await setup();
      await t.seedRequest();
      const res = await processPaymentWebhook(
        { provider: "CARDCOM", rawBody },
        t.deps
      );
      assert.equal(res.ok, false, `${label}: must be refused`);
      assert.equal(res.eventId, null, `${label}: must not persist`);
      assert.equal(t.store.webhookEvents.length, 0, `${label}: no event row`);
      assert.equal(t.store.transactions.length, 0, `${label}: no transaction`);
      assert.equal(t.providerCalls(), 0, `${label}: no provider call`);
    }
  }

  // --- 4. provider verification says NOT paid => never PAID ------------------
  {
    const t = await setup({ getResult: GET_RESULT_DECLINED });
    const req = await t.seedRequest();
    const res = await processPaymentWebhook(
      {
        provider: "CARDCOM",
        // The body loudly claims success. It is ignored.
        rawBody: callback({
          returnValue: req.id,
          extra: { ResponseCode: 0, Status: "PAID", Amount: 999999 },
        }),
      },
      t.deps
    );
    assert.notEqual(
      t.store.requests[0]?.status,
      "PAID",
      "a declined GetLpResult must never yield PAID"
    );
    assert.equal(res.paymentRequestStatus !== "PAID", true);
    assert.equal(t.paidEvents.length, 0, "no money-in projection");
  }

  // --- 5. ReturnValue pointing at a different request => refused ------------
  {
    const t = await setup();
    const req = await t.seedRequest();
    const res = await processPaymentWebhook(
      {
        provider: "CARDCOM",
        // Real LowProfileId, but ReturnValue claims a different request id.
        rawBody: callback({ returnValue: req.id + 4242 }),
      },
      t.deps
    );
    assert.equal(res.ok, false);
    assert.equal(res.reason, "correlation_value_mismatch");
    assert.equal(res.eventId, null);
    assert.equal(t.store.webhookEvents.length, 0);
    assert.equal(t.store.transactions.length, 0);
    assert.equal(t.providerCalls(), 0);
  }

  // --- 6. cross-business attempt: business B's id on business A's flow ------
  {
    const t = await setup({ businessId: 1 });
    const mine = await t.seedRequest({ businessId: 1, lowProfileId: LPID });
    // A second tenant with its own request and its own LowProfileId.
    t.store.seedConnection({ businessId: 2, provider: "CARDCOM", isActive: true, merchantId: "2000" });
    const theirs = await t.seedRequest({ businessId: 2, lowProfileId: OTHER_LPID });
    assert.notEqual(mine.id, theirs.id);

    // Point tenant 1's LowProfileId at tenant 2's request id.
    const res = await processPaymentWebhook(
      { provider: "CARDCOM", rawBody: callback({ lowProfileId: LPID, returnValue: theirs.id }) },
      t.deps
    );
    assert.equal(res.ok, false, "cross-tenant correlation must be refused");
    assert.equal(res.reason, "correlation_value_mismatch");
    assert.equal(t.store.transactions.length, 0);
    assert.equal(t.paidEvents.length, 0);
    // Neither tenant's request moved.
    assert.equal(t.store.requests.find((r) => r.id === mine.id)?.status, "PENDING");
    assert.equal(t.store.requests.find((r) => r.id === theirs.id)?.status, "PENDING");
  }

  // --- 7. duplicate callback => idempotent, one transaction, one projection --
  {
    const t = await setup();
    const req = await t.seedRequest();
    const body = callback({ returnValue: req.id });
    const first = await processPaymentWebhook({ provider: "CARDCOM", rawBody: body }, t.deps);
    const second = await processPaymentWebhook({ provider: "CARDCOM", rawBody: body }, t.deps);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(second.duplicate, true, "an identical callback is a duplicate");
    assert.equal(t.store.transactions.length, 1, "no second transaction");
    assert.equal(t.paidEvents.length, 1, "no second money-in projection");
    assert.equal(t.store.requests[0]?.status, "PAID");
  }

  // --- 8. repeated PAID under a DIFFERENT event id => still settles once -----
  {
    const t = await setup();
    const req = await t.seedRequest();
    // Same LowProfileId and same underlying transaction, but a distinct event
    // envelope — the shape a provider retry or a reordered delivery takes.
    await processPaymentWebhook(
      { provider: "CARDCOM", rawBody: callback({ returnValue: req.id }) },
      t.deps
    );
    const replay = await processPaymentWebhook(
      {
        provider: "CARDCOM",
        rawBody: callback({ returnValue: req.id, extra: { InternalDealNumber: "777" } }),
      },
      t.deps
    );
    assert.equal(t.store.transactions.length, 1, "transaction-id idempotency holds");
    assert.equal(t.paidEvents.length, 1, "no duplicate FinancialEvent projection");
    assert.equal(replay.duplicate, true);
    assert.equal(t.store.requests[0]?.status, "PAID");
  }

  // --- 9. inactive provider with no configuration => fails closed -----------
  {
    const store = createInMemoryPaymentStore();
    store.seedConnection({ businessId: 1, provider: "TRANZILA", isActive: true });
    const created = await store.createPaymentRequest({
      businessId: 1,
      customerId: null,
      billingDocumentId: null,
      provider: "TRANZILA",
      amount: "10.00",
      currency: "ILS",
      description: "dormant",
      status: "PENDING",
      expiresAt: null,
    });
    await store.updatePaymentRequest(created.id, { providerRequestId: "tz-1" });

    const deps: ProcessWebhookDeps = {
      store,
      resolveProvider: () => tranzilaProvider,
      // No resolveWebhookSecret => the provider is unconfigured, as in production.
    };
    const res = await processPaymentWebhook(
      {
        provider: "TRANZILA",
        rawBody: JSON.stringify({ dubiz_request_id: "tz-1", status: "success" }),
      },
      deps
    );
    assert.equal(res.ok, false, "an unconfigured provider must refuse");
    assert.equal(res.reason, "verify: provider_not_configured");
    assert.equal(res.eventId, null, "and must not persist anything");
    assert.equal(store.webhookEvents.length, 0);
    assert.equal(store.transactions.length, 0);
    assert.equal(store.requests[0]?.status, "PENDING");
  }

  console.log("cardcom webhook hardening (Wave D): OK — 9/9 scenarios");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
