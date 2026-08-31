/**
 * Run: npx tsx lib/services/payments/providers/paypal/paypal.provider.test.ts
 *
 * PayPal provider with mocked HTTP — no real network, no real credentials.
 * Covers createPaymentLink (Orders create), getPaymentStatus authority
 * (GET + capture → COMPLETED = PAID), webhook parsing (signal only), the rule
 * that a webhook alone can never PAID without verification, idempotency, and
 * Collection Workspace visibility of a verified payment.
 */
import assert from "node:assert/strict";
import {
  createPayPalProvider,
  extractPayPalWebhookFields,
  interpretOrder,
  type PayPalHttpClient,
} from "./paypal.provider";
import {
  processPaymentWebhook,
  type ProcessWebhookDeps,
} from "../../payment-webhook.service";
import { createInMemoryPaymentStore } from "../../payment-store.memory";
import { getCollectionWorkspace } from "../../collection-workspace.service";

type Responder = (
  url: string,
  init: { method: string; body?: string }
) => { status?: number; json?: unknown } | undefined;

function mockHttp(responder: Responder) {
  const calls: { url: string; method: string; body: string | null }[] = [];
  const fetchImpl: PayPalHttpClient = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body ?? null });
    const r = responder(url, init) ?? {};
    return {
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      json: async () => r.json ?? {},
    };
  };
  return { fetchImpl, calls };
}

function provider(fetchImpl: PayPalHttpClient) {
  return createPayPalProvider({
    fetchImpl,
    baseUrl: "https://test.paypal",
    publicBaseUrl: "https://app.example",
    clientId: "cid",
    clientSecret: "sec",
  });
}

const TOKEN_JSON = { access_token: "test-token", token_type: "Bearer" };
const isToken = (u: string) => u.includes("/v1/oauth2/token");
const isCapture = (u: string) => u.includes("/capture");
const isOrderGet = (u: string, m: string) =>
  m === "GET" && /\/v2\/checkout\/orders\/[^/]+$/.test(u);
const isCreate = (u: string, m: string) => m === "POST" && u.endsWith("/v2/checkout/orders");

const COMPLETED_ORDER = {
  id: "ORDER-1",
  status: "COMPLETED",
  purchase_units: [{ payments: { captures: [{ id: "CAP-1", status: "COMPLETED" }] } }],
};

async function main() {
  // --- 1. createPaymentLink: OAuth → order → approve link + custom_id --------
  {
    const { fetchImpl, calls } = mockHttp((url, init) => {
      if (isToken(url)) return { json: TOKEN_JSON };
      if (isCreate(url, init.method))
        return {
          json: {
            id: "ORDER-1",
            status: "CREATED",
            links: [
              { rel: "self", href: "https://x/self" },
              { rel: "approve", href: "https://pp/approve/ORDER-1" },
            ],
          },
        };
      return undefined;
    });
    const r = await provider(fetchImpl).createPaymentLink({
      businessId: 1,
      paymentRequestId: 42,
      amount: "100.00",
      currency: "USD",
      description: "Consulting",
      merchantId: null,
      credential: null,
    });
    assert.equal(r.paymentUrl, "https://pp/approve/ORDER-1");
    assert.equal(r.providerRequestId, "ORDER-1");

    // create body: correlation + amount + return urls, no card data
    const createCall = calls.find((c) => isCreate(c.url, c.method))!;
    const body = JSON.parse(createCall.body!);
    assert.equal(body.intent, "CAPTURE");
    assert.equal(body.purchase_units[0].custom_id, "42"); // PaymentRequest id round-trips
    assert.equal(body.purchase_units[0].amount.value, "100.00");
    assert.equal(body.purchase_units[0].amount.currency_code, "USD");
    assert.equal(body.application_context.return_url, "https://app.example/?payment=success");
    assert.ok(!/cardnumber|"cvv"|"pan"/i.test(createCall.body!));
    // secret never leaks into any request body / returned object
    assert.ok(!JSON.stringify(r).includes("sec"));
  }

  // --- 2. getPaymentStatus: order already COMPLETED => PAID -------------------
  {
    const { fetchImpl } = mockHttp((url, init) => {
      if (isToken(url)) return { json: TOKEN_JSON };
      if (isOrderGet(url, init.method)) return { json: COMPLETED_ORDER };
      return undefined;
    });
    const status = await provider(fetchImpl).getPaymentStatus!({
      providerRequestId: "ORDER-1",
      merchantId: null,
      credential: null,
    });
    assert.equal(status.outcome, "PAID");
    assert.equal(status.providerTransactionId, "CAP-1");
  }

  // --- 3. getPaymentStatus: APPROVED => capture => COMPLETED = PAID -----------
  {
    const { fetchImpl, calls } = mockHttp((url, init) => {
      if (isToken(url)) return { json: TOKEN_JSON };
      if (isCapture(url))
        return {
          json: {
            id: "ORDER-1",
            status: "COMPLETED",
            purchase_units: [{ payments: { captures: [{ id: "CAP-2", status: "COMPLETED" }] } }],
          },
        };
      if (isOrderGet(url, init.method)) return { json: { id: "ORDER-1", status: "APPROVED" } };
      return undefined;
    });
    const status = await provider(fetchImpl).getPaymentStatus!({
      providerRequestId: "ORDER-1",
      merchantId: null,
      credential: null,
    });
    assert.equal(status.outcome, "PAID");
    assert.equal(status.providerTransactionId, "CAP-2");
    assert.ok(calls.some((c) => isCapture(c.url)), "should have attempted capture");
  }

  // --- 4. getPaymentStatus: not-approved => UNKNOWN; VOIDED => CANCELLED ------
  {
    assert.equal(interpretOrder({ status: "CREATED" }).outcome, "UNKNOWN");
    assert.equal(interpretOrder({ status: "APPROVED" }).outcome, "UNKNOWN"); // no capture yet
    assert.equal(interpretOrder({ status: "VOIDED" }).outcome, "CANCELLED");
    assert.equal(
      interpretOrder({
        status: "COMPLETED",
        purchase_units: [{ payments: { captures: [{ id: "C", status: "DECLINED" }] } }],
      }).outcome,
      "FAILED"
    );
  }

  // --- 5. parseWebhook: extracts order id from both event kinds; never throws -
  {
    const p = provider((() => {
      throw new Error("parse must not call the network");
    }) as unknown as PayPalHttpClient);

    const approved = p.parseWebhook({
      rawBody: JSON.stringify({
        id: "EV-1",
        event_type: "CHECKOUT.ORDER.APPROVED",
        resource: { id: "ORDER-1" },
      }),
    });
    assert.equal(approved.providerRequestId, "ORDER-1");
    assert.equal(approved.outcome, "PENDING"); // signal only, never PAID

    const captured = p.parseWebhook({
      rawBody: JSON.stringify({
        id: "EV-2",
        event_type: "PAYMENT.CAPTURE.COMPLETED",
        resource: {
          id: "CAP-1",
          amount: { value: "50.00", currency_code: "USD" },
          supplementary_data: { related_ids: { order_id: "ORDER-1" } },
        },
      }),
    });
    assert.equal(captured.providerRequestId, "ORDER-1");
    assert.equal(captured.providerTransactionId, "CAP-1");
    assert.equal(captured.outcome, "PENDING");

    const garbage = p.parseWebhook({ rawBody: "not json at all" });
    assert.equal(garbage.outcome, "UNKNOWN");
    assert.equal(garbage.providerRequestId, null);

    const fields = extractPayPalWebhookFields({
      rawBody: JSON.stringify({
        id: "EV-3",
        event_type: "PAYMENT.CAPTURE.COMPLETED",
        resource: { id: "CAP-9", supplementary_data: { related_ids: { order_id: "ORDER-9" } } },
      }),
    });
    assert.equal(fields.orderId, "ORDER-9");
    assert.equal(fields.captureId, "CAP-9");
  }

  // --- 6. E2E: webhook alone cannot PAID; authority verifies; idempotent;
  //        Collection Workspace shows the verified payment ---------------------
  {
    const store = createInMemoryPaymentStore();
    store.seedConnection({ businessId: 1, provider: "PAYPAL", isActive: true });
    const created = await store.createPaymentRequest({
      businessId: 1,
      customerId: null,
      billingDocumentId: null,
      provider: "PAYPAL",
      amount: "50.00",
      currency: "USD",
      description: "Design work",
      status: "PENDING",
      expiresAt: null,
    });
    await store.updatePaymentRequest(created.id, { providerRequestId: "ORDER-1" });

    // Authority (GET order) returns COMPLETED with a COMPLETED capture.
    const { fetchImpl } = mockHttp((url, init) => {
      if (isToken(url)) return { json: TOKEN_JSON };
      if (isOrderGet(url, init.method)) return { json: COMPLETED_ORDER };
      return undefined;
    });
    const deps: ProcessWebhookDeps = {
      store,
      resolveProvider: () => provider(fetchImpl),
      decryptConnectionCredential: () => null, // creds from env in prod; injected in tests
      // Wave D: PayPal now fails CLOSED when unconfigured, so exercising the
      // settlement path requires a configured secret. PayPal is dormant in every
      // real environment; if it is ever activated, the real control is PayPal's
      // verify-webhook-signature API, not this header convention.
      resolveWebhookSecret: () => "paypal-test-secret",
    };
    const webhookBody = JSON.stringify({
      id: "EV-100",
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: {
        id: "CAP-1",
        supplementary_data: { related_ids: { order_id: "ORDER-1" } },
      },
    });

    const res = await processPaymentWebhook(
      { provider: "PAYPAL", rawBody: webhookBody, headers: { "x-webhook-secret": "paypal-test-secret" } },
      deps
    );
    assert.equal(res.verified, true);
    assert.equal(res.paymentRequestStatus, "PAID");
    assert.equal(store.requests[0]?.status, "PAID");
    assert.equal(store.transactions.length, 1);
    assert.equal(store.transactions[0]?.providerTransactionId, "CAP-1");

    // idempotency: a duplicate webhook does not settle twice.
    const dup = await processPaymentWebhook(
      {
        provider: "PAYPAL",
        rawBody: webhookBody.replace("EV-100", "EV-101"),
        headers: { "x-webhook-secret": "paypal-test-secret" },
      },
      deps
    );
    assert.equal(dup.paymentRequestStatus, "PAID");
    assert.equal(store.transactions.length, 1, "no second transaction");

    // Collection Workspace shows the verified payment (state "verified" in history),
    // via the same read-model the screen consumes — no PayPal-specific UI coupling.
    const ws = await getCollectionWorkspace(store, { businessId: 1, now: new Date() });
    const item = ws.history.find((i) => i.id === created.id);
    assert.ok(item, "verified payment should appear in workspace history");
    assert.equal(item!.state, "verified");
    assert.equal(ws.active.length, 0);
    assert.equal(ws.attention.length, 0);
  }

  console.log("paypal.provider tests: OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
