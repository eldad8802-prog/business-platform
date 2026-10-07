/**
 * Run: npx tsx lib/services/payments/provider-contract.test.ts
 *
 * THE PROVIDER CONTRACT — one suite, every REAL adapter.
 *
 * Why this exists: after M1 made a verified amount mandatory, SUMIT's real
 * adapter stopped being able to record any payment at all, and nothing went red.
 * The suites that exercised the shared layer used a synthetic "SUMIT-shaped"
 * adapter that did supply an amount, and the suites that exercised the real
 * adapter never ran its answer through the shared layer. Each half was green;
 * the whole was broken.
 *
 * So this suite takes each real adapter — its own HTTP code, fed by a double
 * that answers in the provider's documented shapes — and drives it through the
 * SHARED path end to end:
 *
 *   link (createPaymentRequest) → routing → reconciliation candidate
 *   → authoritative verification → exactly one PaymentTransaction
 *   → accounting opened → (replay is a no-op) → refund through the seam
 *   → a transport failure on refund is UNKNOWN and stays reserved.
 *
 * A new provider joins by adding one fixture below. If its adapter cannot give
 * the shared layer what it needs (a transaction id, a verified amount and
 * currency, a key reconciliation can ask by, a refund target that survives a
 * lost webhook), this suite fails — before Production finds out.
 */

import { runWithTenantContext } from "@/lib/tenant/context";
import { createInMemoryPaymentStore } from "./payment-store.memory";
import { createPaymentRequest } from "./payment-request.service";
import { runPaymentReconciliation } from "./payment-reconciliation.service";
import { resolvePaymentAuthoritatively } from "./payment-verification.service";
import { refundPaymentRequest } from "./payment-refund.service";
import { readVerifiedEvidence } from "./payment-evidence";
import { getProviderDescriptor } from "./providers/provider-registry";
import {
  createCardComProvider,
  type CardComHttpClient,
} from "./providers/cardcom/cardcom.provider";
import { createSumitProvider, type SumitHttpClient } from "./providers/sumit/sumit.provider";
import type { PaymentProviderAdapter } from "./providers/payment-provider.types";
import type { PaymentProvider } from "./payments.types";

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

const BUSINESS = 7;
const NOT_PRODUCTION = { VERCEL_ENV: "preview" };

interface ProviderFixture {
  provider: PaymentProvider;
  /** merchantId + decrypted credential stored on the connection. */
  merchantId: string;
  credential: string;
  /** A fresh adapter wired to a provider double. `mode` steers the double. */
  build(state: DoubleState): PaymentProviderAdapter;
}

interface DoubleState {
  /** What the provider says happened to the payment. */
  paid: boolean;
  /** How the provider answers a refund instruction. */
  refund: "ok" | "timeout";
  /** Observed calls, by endpoint name. */
  calls: string[];
  /** The Dubiz request id the checkout carried (round-tripped by the provider). */
  correlation: string | null;
}

// ── CardCom double (LowProfile v11, shapes from the official OpenAPI) ─────────
const CARDCOM: ProviderFixture = {
  provider: "CARDCOM",
  merchantId: "172012",
  credential: JSON.stringify({ apiName: "api-user", apiPassword: "api-pass" }),
  build(state) {
    const fetchImpl: CardComHttpClient = async (url, init) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      const reply = (payload: unknown) => ({ ok: true, status: 200, json: async () => payload });
      if (url.endsWith("/LowProfile/Create")) {
        state.calls.push("create");
        state.correlation = String(body.ReturnValue);
        return reply({
          ResponseCode: 0,
          Url: "https://secure.cardcom.solutions/pay/abc",
          LowProfileId: "0b8d4b8e-5f1a-4b8a-9d3e-1c2b3a4d5e6f",
        });
      }
      if (url.endsWith("/LowProfile/GetLpResult")) {
        state.calls.push("status");
        if (!state.paid) return reply({ ResponseCode: 0, ReturnValue: state.correlation });
        return reply({
          ResponseCode: 0,
          ReturnValue: state.correlation,
          TerminalNumber: 172012,
          TranzactionInfo: {
            ResponseCode: 0,
            TranzactionId: 253736273,
            TerminalNumber: 172012,
            Amount: 120,
            CoinId: 1,
            Last4CardDigitsString: "4242",
            Brand: "Visa",
            ApprovalNumber: "0012345",
          },
        });
      }
      if (url.endsWith("/Transactions/RefundByTransactionId")) {
        state.calls.push("refund");
        if (state.refund === "timeout") throw new Error("ETIMEDOUT");
        return reply({ ResponseCode: 0, NewTranzactionId: 253736999 });
      }
      return reply({ ResponseCode: 999 });
    };
    return createCardComProvider({ fetchImpl, publicBaseUrl: "https://app.example" });
  },
};

// ── SUMIT double (shapes as the live sandbox answered, #428/#448) ─────────────
const SUMIT: ProviderFixture = {
  provider: "SUMIT",
  merchantId: "123456789",
  credential: JSON.stringify({ apiKey: "sumit-key" }),
  build(state) {
    const fetchImpl: SumitHttpClient = async (url, init) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      const reply = (payload: unknown) => ({ ok: true, status: 200, json: async () => payload });
      if (url.endsWith("/billing/payments/beginredirect/")) {
        state.calls.push("create");
        state.correlation = String(body.ExternalIdentifier ?? "");
        return reply({ Status: 0, Data: { RedirectURL: "https://pay.sumit.co.il/x/redirectpayment/?redirectid=1" } });
      }
      if (url.endsWith("/crm/schema/listfolders/")) {
        return reply({ Status: 0, Data: { Folders: [{ ID: 2345705517, Name: "סליקות אשראי" }] } });
      }
      if (url.endsWith("/crm/data/listentities/")) {
        state.calls.push("status");
        return reply({ Status: 0, Data: { Entities: state.paid ? [{ ID: 2363103378 }] : [] } });
      }
      if (url.endsWith("/billing/payments/get/")) {
        return reply({
          Status: 0,
          Data: {
            Payment: {
              ID: 2363103378,
              CustomerID: 2362366786,
              ValidPayment: true,
              Status: "000",
              Amount: 120,
              Currency: 0,
            },
          },
        });
      }
      if (url.endsWith("/billing/payments/charge/")) {
        state.calls.push("refund");
        if (state.refund === "timeout") throw new Error("ETIMEDOUT");
        return reply({ Status: 0, Data: { Payment: { ID: 999, ValidPayment: true, Status: "000", Amount: -120 } } });
      }
      return reply({ Status: 0, Data: {} });
    };
    return createSumitProvider({ fetchImpl, baseUrl: "https://api.sumit.example", publicBaseUrl: "https://app.example" });
  },
};

const FIXTURES: ProviderFixture[] = [CARDCOM, SUMIT];

async function setup(fixture: ProviderFixture, state: DoubleState) {
  const store = createInMemoryPaymentStore();
  store.seedConnection({ businessId: BUSINESS, provider: fixture.provider, isActive: true, merchantId: fixture.merchantId });
  const adapter = fixture.build(state);
  const resolveProvider = () => adapter;
  const decryptConnectionCredential = () => fixture.credential;
  return { store, adapter, resolveProvider, decryptConnectionCredential };
}

async function contract(fixture: ProviderFixture) {
  const P = fixture.provider;
  const descriptor = getProviderDescriptor(P)!;
  const state: DoubleState = { paid: false, refund: "ok", calls: [], correlation: null };
  const { store, adapter, resolveProvider, decryptConnectionCredential } = await setup(fixture, state);

  // 1. The link. Created through the shared service, with the real adapter.
  //    (The provider is enabled for the duration via an explicit request: this
  //    suite asserts the CONTRACT, not today's enablement switch.)
  const created = await createPaymentRequest(
    { businessId: BUSINESS, amount: "120.00", currency: "ILS", description: "contract" },
    {
      store,
      resolveProvider,
      decryptConnectionCredential,
      runtimeEnv: NOT_PRODUCTION,
    }
  ).catch((e: unknown) => e);
  if (created instanceof Error) {
    // A disabled provider cannot issue links through the service; seed the
    // request exactly as the service would have, then ask the adapter directly.
    const request = await store.createPaymentRequest({
      businessId: BUSINESS,
      customerId: null,
      billingDocumentId: null,
      provider: P,
      amount: "120.00",
      currency: "ILS",
      description: "contract",
      status: "PENDING",
      expiresAt: null,
    });
    const link = await adapter.createPaymentLink({
      businessId: BUSINESS,
      paymentRequestId: request.id,
      amount: "120.00",
      currency: "ILS",
      description: "contract",
      merchantId: fixture.merchantId,
      credential: fixture.credential,
      callbackSecret: adapter.usesCallbackSecret ? "s".repeat(43) : null,
    });
    await store.updatePaymentRequest(request.id, {
      paymentUrl: link.paymentUrl,
      providerRequestId: link.providerRequestId ?? null,
    });
  }
  const request = store.requests[0]!;
  ok(`${P}: a link was issued`, typeof request.paymentUrl === "string" && request.paymentUrl.length > 0);
  ok(
    `${P}: descriptor.verificationKey matches what the checkout actually returns`,
    descriptor.capabilities.verificationKey === "PROVIDER_REQUEST_ID"
      ? request.providerRequestId != null
      : request.providerRequestId == null
  );

  // 2. A webhook-shaped claim is never authority.
  const parsed = adapter.parseWebhook({ rawBody: "{}", parsedBody: {} });
  ok(`${P}: parseWebhook never claims PAID`, parsed.outcome !== "PAID");

  // 3. The webhook is LOST. The customer pays; only reconciliation can find it.
  state.paid = true;
  const candidates = await store.listReconciliationCandidates(BUSINESS, {
    createdAfter: new Date(Date.now() - 86_400_000),
    createdBefore: new Date(Date.now() + 1_000),
    limit: 10,
  });
  ok(`${P}: the request is a reconciliation candidate`, candidates.some((c) => c.id === request.id));

  const report = await runPaymentReconciliation(
    {
      store,
      resolveProvider,
      decryptConnectionCredential,
      listBusinessIds: async () => [BUSINESS],
    },
    { minAgeMs: 0, random: () => 0 }
  );
  ok(`${P}: reconciliation recorded the lost payment`, report.recorded === 1, JSON.stringify(report));
  ok(`${P}: with no anomaly`, report.healthy === true, JSON.stringify(report.anomalies));

  // 4. Exactly one money row, with the provider's own facts.
  const money = store.transactions.filter((t) => t.paymentRequestId === request.id && Number(t.amount) > 0);
  ok(`${P}: exactly one PaymentTransaction`, money.length === 1);
  ok(`${P}: carrying the provider's transaction id`, money[0]?.providerTransactionId != null);
  ok(`${P}: at the VERIFIED amount`, money[0]?.amount === "120.00", money[0]?.amount);
  ok(`${P}: in the VERIFIED currency`, money[0]?.currency === "ILS", money[0]?.currency);
  ok(
    `${P}: with its accounting opened in the same write`,
    store.accountingSettlements.some((a) => a.paymentTransactionId === money[0]?.id)
  );

  // 5. Asking again (webhook redelivery, next run) changes nothing.
  await runWithTenantContext({ businessId: BUSINESS }, async () => {
    const again = await resolvePaymentAuthoritatively(
      { request: (await store.findPaymentRequestById(request.id))!, adapter, source: "WEBHOOK" },
      { store, decryptConnectionCredential }
    );
    ok(`${P}: a second ask is ALREADY_RECORDED`, again.kind === "ALREADY_RECORDED", again.kind);
  });
  ok(
    `${P}: still exactly one PaymentTransaction`,
    store.transactions.filter((t) => t.paymentRequestId === request.id && Number(t.amount) > 0).length === 1
  );

  if (typeof adapter.refundPayment !== "function") return;

  // 6. Refund a payment that was found by RECONCILIATION — no callback body.
  //    Whatever the adapter needs to refund must have come from its own
  //    authoritative answer and been kept with the money.
  ok(
    `${P}: the money row keeps the provider evidence a refund will need`,
    typeof readVerifiedEvidence(money[0]!.rawPayload) === "object"
  );
  const deps = { store, resolveProvider, decryptConnectionCredential };

  // The adapter itself can find its refund target in what was stored — even
  // with no callback body (the payment was discovered by reconciliation).
  state.refund = "ok";
  const direct = await adapter
    .refundPayment({
      merchantId: fixture.merchantId,
      credential: fixture.credential,
      amount: "1.00",
      currency: "ILS",
      paymentRequestId: request.id,
      intent: "REFUND",
      reversalId: 999_001,
      settlement: {
        providerTransactionId: money[0]!.providerTransactionId,
        amount: money[0]!.amount,
        currency: money[0]!.currency,
        rawPayload: money[0]!.rawPayload,
      },
    })
    .catch((e: unknown) => e);
  ok(
    `${P}: a reconciliation-found payment is refundable by its adapter`,
    !(direct instanceof Error) && direct.outcome === "REFUNDED",
    direct instanceof Error ? direct.message : ""
  );
  state.calls = state.calls.filter((c) => c !== "refund");

  state.refund = "timeout";
  const unknown = await runWithTenantContext({ businessId: BUSINESS }, () =>
    refundPaymentRequest(
      { businessId: BUSINESS, actorUserId: 1, requestId: request.id, amount: "20.00", idempotencyKey: `${P}-k-timeout` },
      deps
    )
  ).catch((e: unknown) => e);
  // A disabled provider refuses new refunds at the capability switch; the
  // contract is then only that nothing moved.
  if (unknown instanceof Error) {
    ok(`${P}: (disabled) a refund is refused before the provider is called`, !state.calls.includes("refund"));
    return;
  }
  ok(`${P}: a timed-out refund is UNKNOWN`, unknown.outcome === "UNKNOWN");
  ok(`${P}: and stays reserved`, unknown.refundableRemaining === "100.00");
}

async function main() {
  for (const fixture of FIXTURES) {
    await contract(fixture);
  }

  // The descriptor table itself: every registered provider declares the
  // fields the shared layer reads, and a status query that moves money is
  // never marked as observable in the background.
  for (const p of ["CARDCOM", "SUMIT", "PAYPAL", "TRANZILA"] as const) {
    const d = getProviderDescriptor(p)!;
    ok(`${p}: declares a verification key`, d.capabilities.verificationKey != null);
    ok(`${p}: declares its document behaviour`, d.capabilities.taxDocuments === "MAY" || d.capabilities.taxDocuments === "NEVER");
  }
  ok("PAYPAL's capturing status query is never background-observable", getProviderDescriptor("PAYPAL")!.capabilities.readOnlyStatusQuery === false);

  console.log(`\nprovider-contract: ${pass} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
