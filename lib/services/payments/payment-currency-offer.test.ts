/**
 * Run: npx tsx lib/services/payments/payment-currency-offer.test.ts
 *
 * A payment request may be raised in ILS, USD or EUR — and only in those the
 * selected provider can actually be charged in. ILS stays the default and an
 * ILS request behaves exactly as before. An invoice-backed request is always in
 * the invoice's currency.
 *
 * Pure: in-memory store, stub provider carrying each REAL adapter's declared
 * currency set, no DB, no network, no credentials.
 */
import assert from "node:assert/strict";
import { createPaymentRequest } from "./payment-request.service";
import { createInMemoryPaymentStore } from "./payment-store.memory";
import { createStubProvider } from "./providers/stub/stub.provider";
import { resolvePaymentProvider } from "./providers/provider-registry";
import { CARDCOM_SUPPORTED_CURRENCIES } from "./providers/cardcom/cardcom.provider";
import { SUMIT_SUPPORTED_CURRENCIES } from "./providers/sumit/sumit.provider";
import { TRANZILA_SUPPORTED_CURRENCIES } from "./providers/tranzila/tranzila.provider";
import { payPalProvider } from "./providers/paypal/paypal.provider";
import type { PaymentProviderAdapter } from "./providers/payment-provider.types";
import type { PaymentProvider } from "./payments.types";
import {
  assertCurrencyOfferable,
  offerableCurrencies,
  PaymentCurrencyNotOfferableError,
  paymentCurrencyRefusalBody,
} from "./payment-currency-offer";
import { loadCollectionProviderReadiness } from "@/lib/services/billing/collection/collection-readiness.service";
import { createTranslator } from "@/lib/i18n/translate";
import { he } from "@/lib/i18n/messages/he";
import { en } from "@/lib/i18n/messages/en";

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

const same = (a: readonly string[], b: readonly string[]) => JSON.stringify(a) === JSON.stringify(b);

function depsWith(store: ReturnType<typeof createInMemoryPaymentStore>, adapter: PaymentProviderAdapter) {
  return { store, resolveProvider: () => adapter, decryptConnectionCredential: () => "credential" };
}

function seeded(provider: PaymentProvider = "CARDCOM") {
  const store = createInMemoryPaymentStore();
  store.seedConnection({ businessId: 1, provider, isActive: true });
  return store;
}

async function refusal(fn: () => Promise<unknown>): Promise<PaymentCurrencyNotOfferableError | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e instanceof PaymentCurrencyNotOfferableError ? e : null;
  }
}

async function main() {
  // ── 1. The offerable set per provider (Dubiz set ∩ adapter set) ──────────
  ok("CardCom → ILS, USD, EUR", same(offerableCurrencies(CARDCOM_SUPPORTED_CURRENCIES), ["ILS", "USD", "EUR"]));
  ok("SUMIT → ILS, USD", same(offerableCurrencies(SUMIT_SUPPORTED_CURRENCIES), ["ILS", "USD"]));
  ok("Tranzila → ILS, USD, EUR", same(offerableCurrencies(TRANZILA_SUPPORTED_CURRENCIES), ["ILS", "USD", "EUR"]));
  ok("PayPal (null = pass-through) → the whole Dubiz set", payPalProvider.supportedCurrencies === null && same(offerableCurrencies(null), ["ILS", "USD", "EUR"]));
  ok("an adapter set wider than Dubiz is narrowed to Dubiz", same(offerableCurrencies(["GBP", "EUR", "ILS"]), ["ILS", "EUR"]));
  ok("ILS is first whenever offered", offerableCurrencies(["EUR", "USD", "ILS"])[0] === "ILS");
  for (const p of ["CARDCOM", "SUMIT", "TRANZILA", "PAYPAL"] as const) {
    ok(`${p}: registry adapter offers ILS`, offerableCurrencies(resolvePaymentProvider(p).supportedCurrencies).includes("ILS"));
  }

  // ── 2. The gate itself ──────────────────────────────────────────────────
  {
    let err: unknown = null;
    try {
      assertCurrencyOfferable({ provider: "SUMIT", supportedCurrencies: SUMIT_SUPPORTED_CURRENCIES }, "EUR");
    } catch (e) {
      err = e;
    }
    ok("SUMIT + EUR refused with a typed error", err instanceof PaymentCurrencyNotOfferableError);
    const e = err as PaymentCurrencyNotOfferableError;
    ok("…a 400 ValidationError with code UNSUPPORTED_CURRENCY", e.statusCode === 400 && e.code === "UNSUPPORTED_CURRENCY");
    ok("…carrying what IS offerable", same(e.offerable, ["ILS", "USD"]));
  }

  // ── 3. createPaymentRequest, standalone ─────────────────────────────────
  // ILS unchanged: omitted currency → ILS, explicit ILS → ILS, every provider set.
  for (const [label, set] of [
    ["CardCom", CARDCOM_SUPPORTED_CURRENCIES],
    ["SUMIT", SUMIT_SUPPORTED_CURRENCIES],
    ["Tranzila", TRANZILA_SUPPORTED_CURRENCIES],
    ["PayPal", null],
  ] as const) {
    const store = seeded();
    const omitted = await createPaymentRequest({ businessId: 1, amount: 100 }, depsWith(store, createStubProvider({ supportedCurrencies: set })));
    const explicit = await createPaymentRequest({ businessId: 1, amount: 100, currency: "ILS" }, depsWith(store, createStubProvider({ supportedCurrencies: set })));
    ok(`${label}: no currency → ILS, as before`, omitted.paymentRequest.currency === "ILS");
    ok(`${label}: ILS → ILS`, explicit.paymentRequest.currency === "ILS");
  }
  {
    const store = seeded();
    const res = await createPaymentRequest({ businessId: 1, amount: 120, currency: "eur" }, depsWith(store, createStubProvider({ supportedCurrencies: CARDCOM_SUPPORTED_CURRENCIES })));
    ok("CardCom: EUR (lower-case) accepted and stored as EUR", res.paymentRequest.currency === "EUR");
    const usd = await createPaymentRequest({ businessId: 1, amount: 120, currency: "USD" }, depsWith(store, createStubProvider({ supportedCurrencies: CARDCOM_SUPPORTED_CURRENCIES })));
    ok("CardCom: USD accepted", usd.paymentRequest.currency === "USD");
  }
  {
    const store = seeded();
    const e = await refusal(() => createPaymentRequest({ businessId: 1, amount: 120, currency: "EUR" }, depsWith(store, createStubProvider({ supportedCurrencies: SUMIT_SUPPORTED_CURRENCIES }))));
    ok("SUMIT: EUR refused", e !== null && e.code === "UNSUPPORTED_CURRENCY");
    ok("SUMIT: nothing persisted, no audit", store.requests.length === 0 && store.auditEvents.length === 0);
    const usd = await createPaymentRequest({ businessId: 1, amount: 120, currency: "USD" }, depsWith(store, createStubProvider({ supportedCurrencies: SUMIT_SUPPORTED_CURRENCIES })));
    ok("SUMIT: USD accepted", usd.paymentRequest.currency === "USD");
  }
  {
    const store = seeded();
    const e = await refusal(() => createPaymentRequest({ businessId: 1, amount: 120, currency: "GBP" }, depsWith(store, createStubProvider({ supportedCurrencies: null }))));
    ok("pass-through adapter: GBP refused (outside the Dubiz set)", e !== null && same(e.offerable, ["ILS", "USD", "EUR"]));
    const eur = await createPaymentRequest({ businessId: 1, amount: 120, currency: "EUR" }, depsWith(store, createStubProvider({ supportedCurrencies: null })));
    ok("pass-through adapter: EUR accepted", eur.paymentRequest.currency === "EUR");
  }
  {
    const store = seeded();
    await assert.rejects(
      () => createPaymentRequest({ businessId: 1, amount: 120, currency: "EURO" }, depsWith(store, createStubProvider({ supportedCurrencies: null }))),
      /3-letter ISO code/
    );
    ok("a malformed code keeps its existing error", true);
  }

  // ── 4. createPaymentRequest, invoice-backed ─────────────────────────────
  {
    const store = seeded();
    store.seedDocument({ id: 5, businessId: 1, totalAmount: "100.00", outstandingAmount: "100.00" });
    const res = await createPaymentRequest({ businessId: 1, amount: 40, billingDocumentId: 5 }, depsWith(store, createStubProvider({ supportedCurrencies: CARDCOM_SUPPORTED_CURRENCIES })));
    ok("invoice, no currency sent → the invoice's currency (ILS)", res.paymentRequest.currency === "ILS");
    const e = await refusal(() => createPaymentRequest({ businessId: 1, amount: 40, currency: "USD", billingDocumentId: 5 }, depsWith(store, createStubProvider({ supportedCurrencies: CARDCOM_SUPPORTED_CURRENCIES }))));
    ok("invoice in ILS, USD sent → refused even though CardCom supports USD", e !== null && e.code === "CURRENCY_MISMATCH" && e.reason === "INVOICE_CURRENCY");
    ok("…the existing mismatch wording is kept", e !== null && /^Currency mismatch: the document is in ILS/.test(e.message));
    ok("…only the first request exists", store.requests.length === 1);
  }
  {
    const store = seeded();
    store.seedDocument({ id: 6, businessId: 1, currency: "USD", totalAmount: "100.00", outstandingAmount: "100.00" });
    const res = await createPaymentRequest({ businessId: 1, amount: 40, billingDocumentId: 6 }, depsWith(store, createStubProvider({ supportedCurrencies: CARDCOM_SUPPORTED_CURRENCIES })));
    ok("a (future) USD invoice with no currency sent → USD, not ILS", res.paymentRequest.currency === "USD");
    const e = await refusal(() => createPaymentRequest({ businessId: 1, amount: 40, billingDocumentId: 6 }, depsWith(store, createStubProvider({ supportedCurrencies: ["ILS"] }))));
    ok("…and still held to the provider's set", e !== null && e.code === "UNSUPPORTED_CURRENCY");
  }

  // ── 5. Readiness: what the UI may offer ─────────────────────────────────
  {
    const r = await loadCollectionProviderReadiness(1, seeded("CARDCOM"));
    ok("readiness: CardCom → ILS, USD, EUR, no blocker", r.blocker === null && same(r.offerableCurrencies, ["ILS", "USD", "EUR"]));
    const sumit = await loadCollectionProviderReadiness(1, seeded("CARDCOM"), () => ({ supportedCurrencies: SUMIT_SUPPORTED_CURRENCIES }));
    ok("readiness: SUMIT-shaped adapter → ILS, USD", same(sumit.offerableCurrencies, ["ILS", "USD"]));
    const ilsOnly = await loadCollectionProviderReadiness(1, seeded("CARDCOM"), () => ({ supportedCurrencies: ["ILS"] }));
    ok("readiness: ILS-only adapter → ILS alone (no picker)", same(ilsOnly.offerableCurrencies, ["ILS"]));
    const none = await loadCollectionProviderReadiness(1, createInMemoryPaymentStore());
    ok("readiness: no provider → blocker kept, ILS alone", none.blocker === "NO_PAYMENT_PROVIDER" && same(none.offerableCurrencies, ["ILS"]));
    const two = createInMemoryPaymentStore();
    two.seedConnection({ businessId: 1, provider: "CARDCOM", isActive: true });
    two.seedConnection({ businessId: 1, provider: "SUMIT", isActive: true });
    // SUMIT is a disabled capability, so this is still a single usable provider.
    const twoR = await loadCollectionProviderReadiness(1, two);
    ok("readiness: a disabled provider's connection does not narrow or block", twoR.blocker === null && same(twoR.offerableCurrencies, ["ILS", "USD", "EUR"]));
  }

  // ── 6. The route's message, in both languages ───────────────────────────
  {
    const notOffered = new PaymentCurrencyNotOfferableError({ currency: "EUR", offerable: ["ILS", "USD"], reason: "NOT_OFFERABLE", message: "x" });
    const heBody = paymentCurrencyRefusalBody(notOffered, createTranslator(he));
    const enBody = paymentCurrencyRefusalBody(notOffered, createTranslator(en));
    ok("he: not offered", heBody.error === "אי אפשר לבקש תשלום ב-EUR דרך ספק הסליקה המחובר. אפשר לבקש ב: ILS, USD.", heBody.error);
    ok("en: not offered", enBody.error === "A payment can't be requested in EUR through the connected payment provider. Available: ILS, USD.", enBody.error);
    ok("body keeps { error, code } + offerableCurrencies", heBody.code === "UNSUPPORTED_CURRENCY" && same(heBody.offerableCurrencies, ["ILS", "USD"]));
    const mismatch = new PaymentCurrencyNotOfferableError({ currency: "USD", offerable: ["ILS"], reason: "INVOICE_CURRENCY", message: "x" });
    const m = paymentCurrencyRefusalBody(mismatch, createTranslator(he));
    ok("he: invoice currency", m.error === "בקשת תשלום על חשבונית נשלחת במטבע של החשבונית (ILS)." && m.code === "CURRENCY_MISMATCH", m.error);
  }

  console.log(`\npayment-currency-offer: ${pass} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
