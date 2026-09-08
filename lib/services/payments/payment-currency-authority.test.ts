/**
 * Run: npx tsx lib/services/payments/payment-currency-authority.test.ts
 *
 * SEC-05 — a currency an adapter cannot encode must be REFUSED, never coerced.
 *
 * The defect: CardCom's adapter resolved `ISO_COIN_ID[currency] ?? ISO_COIN_ID.ILS`.
 * A request in a currency with no coin id was charged in SHEKELS while the
 * PaymentRequest, the audit event, the verification result and the downstream
 * FinancialEvent all recorded the currency the caller asked for. Nothing could
 * catch it downstream — the webhook's coherence gate compares the callback to
 * the stored request, and a request built from a coerced currency is internally
 * consistent and wrong.
 *
 * Two layers are proven here, independently, because either alone is a defect
 * waiting to be reintroduced:
 *   1. the SERVICE refuses before a PaymentRequest row exists and before the
 *      provider is called at all;
 *   2. the ADAPTER refuses on its own, so a future caller that reaches it by
 *      another route still cannot produce a silent substitution.
 *
 * No DB, no network, no provider credentials.
 */
import assert from "node:assert/strict";
import { createPaymentRequest } from "./payment-request.service";
import { createInMemoryPaymentStore } from "./payment-store.memory";
import { createStubProvider } from "./providers/stub/stub.provider";
import {
  CARDCOM_SUPPORTED_CURRENCIES,
  createCardComProvider,
  type CardComHttpClient,
} from "./providers/cardcom/cardcom.provider";
import { tranzilaProvider } from "./providers/tranzila/tranzila.provider";
import { payPalProvider } from "./providers/paypal/paypal.provider";
import type { PaymentProviderAdapter } from "./providers/payment-provider.types";

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

function depsWith(
  store: ReturnType<typeof createInMemoryPaymentStore>,
  adapter: PaymentProviderAdapter
) {
  return {
    store,
    resolveProvider: () => adapter,
    decryptConnectionCredential: () => "credential",
  };
}

async function main() {
  // ── 1. SERVICE LAYER ────────────────────────────────────────────────────

  // A supported currency goes through untouched.
  {
    const store = createInMemoryPaymentStore();
    store.seedConnection({ businessId: 1, provider: "CARDCOM", isActive: true });
    const res = await createPaymentRequest(
      { businessId: 1, amount: 100, currency: "ILS" },
      depsWith(store, createStubProvider({ supportedCurrencies: ["ILS", "USD"] }))
    );
    ok("ILS is accepted", res.paymentRequest.currency === "ILS");
  }

  // A supported NON-default currency is equally accepted — the gate is a
  // membership test, not "ILS only".
  {
    const store = createInMemoryPaymentStore();
    store.seedConnection({ businessId: 1, provider: "CARDCOM", isActive: true });
    const res = await createPaymentRequest(
      { businessId: 1, amount: 100, currency: "USD" },
      depsWith(store, createStubProvider({ supportedCurrencies: ["ILS", "USD"] }))
    );
    ok(
      "a supported non-ILS currency is accepted and persisted as itself",
      res.paymentRequest.currency === "USD"
    );
  }

  // The unsupported case: hard refusal, no row, no provider call.
  {
    const store = createInMemoryPaymentStore();
    store.seedConnection({ businessId: 1, provider: "CARDCOM", isActive: true });
    let providerCalled = false;
    const adapter = createStubProvider({ supportedCurrencies: ["ILS", "USD"] });
    const watched: PaymentProviderAdapter = {
      ...adapter,
      createPaymentLink: async (input) => {
        providerCalled = true;
        return adapter.createPaymentLink(input);
      },
    };

    await assert.rejects(
      () =>
        createPaymentRequest(
          { businessId: 1, amount: 150, currency: "GBP" },
          depsWith(store, watched)
        ),
      /cannot be charged in GBP/
    );
    ok("GBP is refused with a typed, explicit error", true);
    ok("the provider was never called", providerCalled === false);
    ok(
      "no PaymentRequest row was created — no false-success state",
      store.requests.length === 0
    );
    ok("no audit event was written either", store.auditEvents.length === 0);
  }

  // Lower case reaches the gate normalised, so it cannot slip past by casing.
  {
    const store = createInMemoryPaymentStore();
    store.seedConnection({ businessId: 1, provider: "CARDCOM", isActive: true });
    await assert.rejects(
      () =>
        createPaymentRequest(
          { businessId: 1, amount: 10, currency: "gbp" },
          depsWith(store, createStubProvider({ supportedCurrencies: ["ILS"] }))
        ),
      /cannot be charged in GBP/
    );
    ok("lower-case input is normalised before the gate, not around it", true);
  }

  // A pass-through adapter declares null and is not gated locally — it has no
  // translation table to fall out of, so the provider decides.
  {
    const store = createInMemoryPaymentStore();
    store.seedConnection({ businessId: 1, provider: "CARDCOM", isActive: true });
    const res = await createPaymentRequest(
      { businessId: 1, amount: 10, currency: "GBP" },
      depsWith(store, createStubProvider({ supportedCurrencies: null }))
    );
    ok(
      "a pass-through adapter (supportedCurrencies=null) is not locally gated",
      res.paymentRequest.currency === "GBP"
    );
  }

  // ── 2. ADAPTER LAYER — CardCom ──────────────────────────────────────────
  {
    let httpCalls = 0;
    const fetchImpl: CardComHttpClient = async () => {
      httpCalls++;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ResponseCode: 0,
          Url: "https://cardcom.example/pay",
          LowProfileId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        }),
      };
    };
    const provider = createCardComProvider({
      fetchImpl,
      publicBaseUrl: "https://app.example",
    });
    const base = {
      businessId: 1,
      paymentRequestId: 1,
      amount: "100.00",
      description: null,
      merchantId: "1000",
      credential: JSON.stringify({ apiName: "api", apiPassword: "pw" }),
    };

    ok(
      "CardCom declares exactly the currencies its coin table holds",
      [...CARDCOM_SUPPORTED_CURRENCIES].sort().join(",") === "EUR,ILS,USD"
    );

    await assert.rejects(
      () => provider.createPaymentLink({ ...base, currency: "GBP" }),
      /CardCom cannot be charged in GBP/
    );
    ok("CardCom adapter refuses an unmapped currency", true);
    ok("CardCom adapter issued no HTTP request for it", httpCalls === 0);

    const okResult = await provider.createPaymentLink({ ...base, currency: "EUR" });
    ok(
      "CardCom adapter still builds a link for a mapped currency",
      okResult.paymentUrl === "https://cardcom.example/pay" && httpCalls === 1
    );
  }

  // ── 3. ADAPTER LAYER — Tranzila (the same latent defect) ────────────────
  {
    await assert.rejects(
      () =>
        tranzilaProvider.createPaymentLink({
          businessId: 1,
          paymentRequestId: 1,
          amount: "100.00",
          currency: "GBP",
          description: null,
          merchantId: "term",
          credential: null,
        }),
      /Tranzila cannot be charged in GBP/
    );
    ok("Tranzila adapter refuses an unmapped currency rather than sending ILS", true);

    const link = await tranzilaProvider.createPaymentLink({
      businessId: 1,
      paymentRequestId: 1,
      amount: "100.00",
      currency: "USD",
      description: null,
      merchantId: "term",
      credential: null,
    });
    ok(
      "Tranzila still encodes a mapped currency correctly (USD -> 2)",
      link.paymentUrl.includes("currency=2")
    );
  }

  // ── 4. DECLARATION CONSISTENCY ──────────────────────────────────────────
  {
    ok(
      "PayPal declares null — it forwards the ISO code and translates nothing",
      payPalProvider.supportedCurrencies === null
    );
    ok(
      "every registered adapter declares its currency support explicitly",
      [tranzilaProvider, payPalProvider].every(
        (a) => a.supportedCurrencies === null || Array.isArray(a.supportedCurrencies)
      )
    );
  }

  console.log(
    `\npayment-currency-authority: ${pass} passed, ${failures.length} failed`
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
