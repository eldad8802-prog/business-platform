/**
 * Run: npx tsx lib/services/payments/payment-currency-offer.test.ts
 *
 * A payment request may be raised in ILS, USD or EUR — and only in those the
 * selected provider can actually be charged in. ILS stays the default and an
 * ILS request behaves exactly as before. An invoice-backed request is always in
 * the invoice's currency.
 *
 * All of that sits behind the foreign-currency KILL SWITCH
 * (DUBIZ_FX_COLLECTION_ENABLED, fail-closed). Section 0 proves the switch OFF,
 * the default: ILS alone is offered, any other currency is refused before a
 * row, an audit event or a provider call, and ILS is identical to ON. Sections
 * 1–6 run with the switch ON and prove the provider-limited behaviour, on a
 * CardCom connection where CardCom issues the documents (PROVIDER_ISSUES) — the
 * only collector a foreign currency is allowed for; every other collector is
 * proven ILS-only in fx-provider-documents.test.ts.
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
  assertForeignCurrencyCollectionAllowed,
  offerableCurrencies,
  PaymentCurrencyNotOfferableError,
  paymentCurrencyRefusalBody,
} from "./payment-currency-offer";
import { loadCollectionProviderReadiness } from "@/lib/services/billing/collection/collection-readiness.service";
import { createTranslator } from "@/lib/i18n/translate";
import { he } from "@/lib/i18n/messages/he";
import { en } from "@/lib/i18n/messages/en";
import { FX_COLLECTION_FLAG, isForeignCurrencyCollectionEnabled } from "./fx-collection-flag";

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
  store.seedConnection({ businessId: 1, provider, isActive: true, documentIssuer: "PROVIDER_ISSUES" });
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

/** An adapter that counts every provider call, so "no provider call" is observed, not assumed. */
function counted(adapter: PaymentProviderAdapter) {
  const calls = { createPaymentLink: 0 };
  const wrapped: PaymentProviderAdapter = {
    ...adapter,
    async createPaymentLink(input) {
      calls.createPaymentLink++;
      return adapter.createPaymentLink(input);
    },
  };
  return { adapter: wrapped, calls };
}

function setFlag(value: string | undefined) {
  if (value === undefined) delete process.env[FX_COLLECTION_FLAG];
  else process.env[FX_COLLECTION_FLAG] = value;
}

/** An ILS request's observable output, timestamps removed — for the OFF vs ON comparison. */
async function ilsFootprint(input: { amount: number; currency?: string; billingDocumentId?: number }) {
  const store = seeded();
  store.seedDocument({ id: 9, businessId: 1, totalAmount: "500.00", outstandingAmount: "500.00" });
  const { adapter, calls } = counted(createStubProvider({ supportedCurrencies: CARDCOM_SUPPORTED_CURRENCIES }));
  const res = await createPaymentRequest(
    { businessId: 1, ...input },
    { ...depsWith(store, adapter), now: () => new Date("2026-01-01T00:00:00Z") }
  );
  const request = { ...(res.paymentRequest as unknown as Record<string, unknown>) };
  delete request.createdAt;
  delete request.updatedAt;
  return JSON.stringify({
    request,
    paymentUrl: res.paymentUrl,
    audit: store.auditEvents.map((e) => ({ eventType: e.eventType, summary: e.summary, metadata: e.metadata })),
    providerCalls: calls.createPaymentLink,
  });
}

async function main() {
  // ── 0. KILL SWITCH OFF (the default) ────────────────────────────────────
  setFlag(undefined);
  ok("switch: unset → OFF", isForeignCurrencyCollectionEnabled() === false);
  for (const v of ["", "1", "TRUE", "True", " true", "true ", "yes", "on", "false"]) {
    setFlag(v);
    ok(`switch: ${JSON.stringify(v)} → OFF (only the exact string "true" turns it on)`, isForeignCurrencyCollectionEnabled() === false);
  }
  setFlag("true");
  ok(`switch: "true" → ON`, isForeignCurrencyCollectionEnabled() === true);
  setFlag(undefined);

  // 0a. Offered: ILS alone, for every provider shape.
  for (const [label, set] of [
    ["CardCom", CARDCOM_SUPPORTED_CURRENCIES],
    ["SUMIT", SUMIT_SUPPORTED_CURRENCIES],
    ["Tranzila", TRANZILA_SUPPORTED_CURRENCIES],
    ["PayPal (pass-through)", null],
  ] as const) {
    ok(`OFF: ${label} → ILS alone`, same(offerableCurrencies(set), ["ILS"]), JSON.stringify(offerableCurrencies(set)));
  }
  for (const p of ["CARDCOM", "SUMIT", "TRANZILA", "PAYPAL"] as const) {
    ok(`OFF: ${p} registry adapter → ILS alone`, same(offerableCurrencies(resolvePaymentProvider(p).supportedCurrencies), ["ILS"]));
  }
  {
    const r = await loadCollectionProviderReadiness(1, seeded("CARDCOM"));
    ok("OFF: readiness with CardCom → ILS alone, no blocker", r.blocker === null && same(r.offerableCurrencies, ["ILS"]), JSON.stringify(r));
    const none = await loadCollectionProviderReadiness(1, createInMemoryPaymentStore());
    ok("OFF: readiness with no provider → ILS alone, blocker kept", none.blocker === "NO_PAYMENT_PROVIDER" && same(none.offerableCurrencies, ["ILS"]));
  }

  // 0b. Refused: every non-ILS currency, every provider shape, before any side effect.
  for (const currency of ["USD", "EUR", "usd", "eur", "GBP"]) {
    for (const [label, set] of [
      ["CardCom", CARDCOM_SUPPORTED_CURRENCIES],
      ["pass-through", null],
    ] as const) {
      const store = seeded();
      const { adapter, calls } = counted(createStubProvider({ supportedCurrencies: set }));
      const e = await refusal(() => createPaymentRequest({ businessId: 1, amount: 120, currency }, depsWith(store, adapter)));
      ok(
        `OFF: ${label} + ${currency} refused FOREIGN_CURRENCY_COLLECTION_DISABLED (400)`,
        e !== null && e.code === "FOREIGN_CURRENCY_COLLECTION_DISABLED" && e.statusCode === 400 && e.reason === "FX_COLLECTION_DISABLED" && same(e.offerable, ["ILS"]),
        e ? `${e.code} ${e.message}` : "no refusal"
      );
      ok(
        `OFF: ${label} + ${currency}: no PaymentRequest row, no audit event, no provider call`,
        store.requests.length === 0 && store.auditEvents.length === 0 && calls.createPaymentLink === 0
      );
    }
  }
  // …including a currency taken from an invoice rather than sent.
  {
    const store = seeded();
    store.seedDocument({ id: 6, businessId: 1, currency: "USD", totalAmount: "100.00", outstandingAmount: "100.00" });
    const { adapter, calls } = counted(createStubProvider({ supportedCurrencies: CARDCOM_SUPPORTED_CURRENCIES }));
    const e = await refusal(() => createPaymentRequest({ businessId: 1, amount: 40, billingDocumentId: 6 }, depsWith(store, adapter)));
    ok("OFF: a (future) USD invoice, no currency sent → refused by the switch", e !== null && e.code === "FOREIGN_CURRENCY_COLLECTION_DISABLED");
    ok("OFF: …no row, no audit, no provider call", store.requests.length === 0 && store.auditEvents.length === 0 && calls.createPaymentLink === 0);
  }
  // An ILS invoice with USD sent keeps its existing mismatch refusal.
  {
    const store = seeded();
    store.seedDocument({ id: 5, businessId: 1, totalAmount: "100.00", outstandingAmount: "100.00" });
    const e = await refusal(() => createPaymentRequest({ businessId: 1, amount: 40, currency: "USD", billingDocumentId: 5 }, depsWith(store, createStubProvider({ supportedCurrencies: CARDCOM_SUPPORTED_CURRENCIES }))));
    ok("OFF: ILS invoice + USD sent → still CURRENCY_MISMATCH, nothing persisted", e !== null && e.code === "CURRENCY_MISMATCH" && store.requests.length === 0);
  }
  // The adapter-level gate agrees with the service.
  {
    let err: unknown = null;
    try {
      assertCurrencyOfferable({ provider: "CARDCOM", supportedCurrencies: CARDCOM_SUPPORTED_CURRENCIES }, "USD");
    } catch (e) {
      err = e;
    }
    ok("OFF: assertCurrencyOfferable(CardCom, USD) → the switch's refusal", err instanceof PaymentCurrencyNotOfferableError && err.code === "FOREIGN_CURRENCY_COLLECTION_DISABLED");
    let ilsErr: unknown = null;
    try {
      assertForeignCurrencyCollectionAllowed("ILS");
      assertCurrencyOfferable({ provider: "CARDCOM", supportedCurrencies: CARDCOM_SUPPORTED_CURRENCIES }, "ILS");
    } catch (e) {
      ilsErr = e;
    }
    ok("OFF: ILS passes both gates", ilsErr === null);
  }

  // 0c. ILS: accepted, and byte-identical with the switch OFF and ON.
  for (const input of [
    { amount: 100 },
    { amount: 100, currency: "ILS" },
    { amount: 100, currency: "ils" },
    { amount: 40, billingDocumentId: 9 },
    { amount: 40, currency: "ILS", billingDocumentId: 9 },
  ]) {
    setFlag(undefined);
    const off = await ilsFootprint(input);
    setFlag("true");
    const on = await ilsFootprint(input);
    setFlag(undefined);
    const parsed = JSON.parse(off) as { request: { currency: string }; providerCalls: number };
    ok(`ILS ${JSON.stringify(input)}: created with the switch OFF, one provider call`, parsed.request.currency === "ILS" && parsed.providerCalls === 1, off);
    ok(`ILS ${JSON.stringify(input)}: OFF output === ON output (row, link, audit, provider call)`, off === on, `${off}\n${on}`);
  }

  // 0d. The refusal's message, in both languages.
  {
    const off = new PaymentCurrencyNotOfferableError({ currency: "USD", offerable: ["ILS"], reason: "FX_COLLECTION_DISABLED", message: "x" });
    const heBody = paymentCurrencyRefusalBody(off, createTranslator(he));
    const enBody = paymentCurrencyRefusalBody(off, createTranslator(en));
    ok("he: switch off", heBody.error === "גבייה ב-USD עדיין לא פתוחה. אפשר לבקש תשלום ב-ILS בלבד.", heBody.error);
    ok("en: switch off", enBody.error === "Collecting in USD isn't available yet. Payment requests can be made in ILS only.", enBody.error);
    ok("body { error, code: FOREIGN_CURRENCY_COLLECTION_DISABLED, offerableCurrencies: [ILS] }", heBody.code === "FOREIGN_CURRENCY_COLLECTION_DISABLED" && same(heBody.offerableCurrencies, ["ILS"]));
  }

  // ── Sections 1–6: the switch ON — the provider-limited behaviour ────────
  setFlag("true");

  // ── 1. The offerable set per provider (Dubiz set ∩ adapter set) ──────────
  // (the second argument: a foreign currency is allowed for this collector)
  ok("CardCom → ILS, USD, EUR", same(offerableCurrencies(CARDCOM_SUPPORTED_CURRENCIES, true), ["ILS", "USD", "EUR"]));
  ok("SUMIT → ILS, USD", same(offerableCurrencies(SUMIT_SUPPORTED_CURRENCIES, true), ["ILS", "USD"]));
  ok("Tranzila → ILS, USD, EUR", same(offerableCurrencies(TRANZILA_SUPPORTED_CURRENCIES, true), ["ILS", "USD", "EUR"]));
  ok("PayPal (null = pass-through) → the whole Dubiz set", payPalProvider.supportedCurrencies === null && same(offerableCurrencies(null, true), ["ILS", "USD", "EUR"]));
  ok("an adapter set wider than Dubiz is narrowed to Dubiz", same(offerableCurrencies(["GBP", "EUR", "ILS"], true), ["ILS", "EUR"]));
  ok("ILS is first whenever offered", offerableCurrencies(["EUR", "USD", "ILS"], true)[0] === "ILS");
  ok("no collector answer → ILS alone even with the switch ON (fail-closed)", same(offerableCurrencies(CARDCOM_SUPPORTED_CURRENCIES), ["ILS"]));
  for (const p of ["CARDCOM", "SUMIT", "TRANZILA", "PAYPAL"] as const) {
    ok(`${p}: registry adapter offers ILS`, offerableCurrencies(resolvePaymentProvider(p).supportedCurrencies).includes("ILS"));
  }

  // ── 2. The gate itself ──────────────────────────────────────────────────
  {
    let err: unknown = null;
    try {
      assertCurrencyOfferable({ provider: "SUMIT", supportedCurrencies: SUMIT_SUPPORTED_CURRENCIES }, "EUR", { provider: "CARDCOM", documentIssuer: "PROVIDER_ISSUES" });
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
    const dubiz = createInMemoryPaymentStore();
    dubiz.seedConnection({ businessId: 1, provider: "CARDCOM", isActive: true, documentIssuer: "DUBIZ_ISSUES" });
    ok("readiness: CardCom with DUBIZ_ISSUES → ILS alone even with the switch ON", same((await loadCollectionProviderReadiness(1, dubiz)).offerableCurrencies, ["ILS"]));
    const sumit = await loadCollectionProviderReadiness(1, seeded("CARDCOM"), () => ({ supportedCurrencies: SUMIT_SUPPORTED_CURRENCIES }));
    ok("readiness: SUMIT-shaped adapter → ILS, USD", same(sumit.offerableCurrencies, ["ILS", "USD"]));
    const ilsOnly = await loadCollectionProviderReadiness(1, seeded("CARDCOM"), () => ({ supportedCurrencies: ["ILS"] }));
    ok("readiness: ILS-only adapter → ILS alone (no picker)", same(ilsOnly.offerableCurrencies, ["ILS"]));
    const none = await loadCollectionProviderReadiness(1, createInMemoryPaymentStore());
    ok("readiness: no provider → blocker kept, ILS alone", none.blocker === "NO_PAYMENT_PROVIDER" && same(none.offerableCurrencies, ["ILS"]));
    const two = createInMemoryPaymentStore();
    two.seedConnection({ businessId: 1, provider: "CARDCOM", isActive: true, documentIssuer: "PROVIDER_ISSUES" });
    two.seedConnection({ businessId: 1, provider: "SUMIT", isActive: true, documentIssuer: "PROVIDER_ISSUES" });
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
