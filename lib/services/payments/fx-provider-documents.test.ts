/**
 * Run: npx tsx lib/services/payments/fx-provider-documents.test.ts
 *
 * USD / EUR collection with CardCom-issued documents.
 *
 *   A. GATING — a foreign currency is offered and accepted ONLY when the switch
 *      is ON, the selected provider is CardCom, the adapter supports the
 *      currency and the business's CardCom connection says CardCom issues the
 *      documents (PROVIDER_ISSUES). Everything else is ILS only, refused
 *      before a PaymentRequest row, an audit event or a provider call. ILS is
 *      unchanged. CardCom refusing the currency when the page is created fails
 *      the request cleanly (no charge, the existing failure handling).
 *   B. DOCUMENT VERIFICATION — after a foreign-currency payment the money is
 *      recorded exactly as before, and "CardCom issued a document" is decided
 *      ONLY from CardCom's authoritative GetLpResult answer (never the webhook
 *      body, never payment success alone): a real DocumentNumber + DocumentType
 *      (+ DocumentUrl on CardCom's own host). Present → PROVIDER_IS_DOCUMENT_ISSUER
 *      with the document kept on the money row. Missing → PROVIDER_DOCUMENT_MISSING
 *      (non-retryable). Never a Dubiz receipt. ILS decided and stored exactly
 *      as before.
 *   C. DISPLAY — the serialized document (payment detail API), the owner's
 *      words in Hebrew and English, and the rendered link.
 *
 * Pure: in-memory store, the REAL CardCom adapter with its HTTP answered
 * in-process, no DB, no network, no credentials.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { runWithTenantContext } from "@/lib/tenant/context";
import { createTranslator } from "@/lib/i18n/translate";
import { he } from "@/lib/i18n/messages/he";
import { en } from "@/lib/i18n/messages/en";
import { moneyHe } from "@/lib/i18n/messages/areas/money";
import { moneyEn } from "@/lib/i18n/messages/areas/money.en";
import { createPaymentRequest } from "./payment-request.service";
import { createInMemoryPaymentStore, type InMemoryPaymentStore } from "./payment-store.memory";
import { createStubProvider } from "./providers/stub/stub.provider";
import {
  CARDCOM_SUPPORTED_CURRENCIES,
  cardComDocumentUrl,
  cardComIssuedDocument,
  createCardComProvider,
} from "./providers/cardcom/cardcom.provider";
import type { PaymentProviderAdapter, RefundPaymentInput } from "./providers/payment-provider.types";
import type { PaymentProvider } from "./payments.types";
import {
  assertForeignCurrencyCollectionAllowed,
  foreignCurrencyCollectionRefusal,
  isForeignCurrencyAllowedFor,
  offerableCurrencies,
  PaymentCurrencyNotOfferableError,
  paymentCurrencyRefusalBody,
} from "./payment-currency-offer";
import { loadCollectionProviderReadiness } from "@/lib/services/billing/collection/collection-readiness.service";
import { FX_COLLECTION_FLAG } from "./fx-collection-flag";
import { resolvePaymentAuthoritatively } from "./payment-verification.service";
import { readProviderDocument, verifiedProviderDocument } from "./payment-evidence";
import { toPaymentTransactionApi } from "./payment-api.serializer";
import { refundPaymentRequest } from "./payment-refund.service";
import { NON_RETRYABLE_ATTENTION_REASONS } from "@/lib/services/billing/settlement/payment-accounting-settlement.service";
import { ATTENTION_REASON_TEXT, attentionText } from "@/components/collection/collection-client";
import { ProviderDocumentNote, providerDocumentText } from "@/components/collection/provider-document";

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

const PROD = { VERCEL_ENV: "production" };
const ISSUERS = ["NOT_CONFIGURED", "DUBIZ_ISSUES", "PROVIDER_ISSUES"] as const;
type Issuer = (typeof ISSUERS)[number];
const LIVE_TERMINAL = "172012";
const CREDENTIAL = JSON.stringify({ apiName: "fx-synthetic", apiPassword: "fx-synthetic" });

function setFlag(value: string | undefined) {
  if (value === undefined) delete process.env[FX_COLLECTION_FLAG];
  else process.env[FX_COLLECTION_FLAG] = value;
}

function seeded(documentIssuer: Issuer, provider: PaymentProvider = "CARDCOM", businessId = 1) {
  const store = createInMemoryPaymentStore();
  store.seedConnection({ businessId, provider, isActive: true, merchantId: LIVE_TERMINAL, documentIssuer });
  return store;
}

/** An adapter that counts every provider call, so "no provider call" is observed. */
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

async function attempt(fn: () => Promise<unknown>): Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error };
  }
}

// ── CardCom's HTTP API, answered in-process ─────────────────────────────────
type LpAnswer = { status?: number; body?: unknown; throws?: boolean };
function cardcomHttp() {
  const created: Record<string, unknown>[] = [];
  let createAnswer: (body: Record<string, unknown>) => unknown = (body) => ({
    ResponseCode: 0,
    Url: `https://secure.cardcom.solutions/pay/${String(body.ReturnValue)}`,
    LowProfileId: `lp-${String(body.ReturnValue)}`,
  });
  let lpAnswer: LpAnswer = { body: {} };
  const fetchImpl = async (url: string, init: { body?: string }) => {
    const body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
    if (url.endsWith("/api/v11/LowProfile/Create")) {
      created.push(body);
      return { ok: true, status: 200, json: async () => createAnswer(body) };
    }
    if (url.endsWith("/api/v11/LowProfile/GetLpResult")) {
      if (lpAnswer.throws) throw new Error("network down");
      const status = lpAnswer.status ?? 200;
      return { ok: status >= 200 && status < 300, status, json: async () => lpAnswer.body };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const adapter = createCardComProvider({
    fetchImpl: fetchImpl as never,
    baseUrl: "https://secure.cardcom.solutions",
    publicBaseUrl: "https://dubiz.fx.test",
  });
  return {
    adapter,
    created,
    onCreate(fn: (body: Record<string, unknown>) => unknown) {
      createAnswer = fn;
    },
    answerLp(a: LpAnswer) {
      lpAnswer = a;
    },
  };
}

const COIN: Record<string, number> = { ILS: 1, USD: 2, EUR: 978 };
const DOC_URL = "https://secure.cardcom.solutions/Interface/ShowDoc.aspx?id=abc";

/** A GetLpResult answer for a paid transaction, with the document shape chosen by the test. */
function lpResult(opts: {
  requestId: number;
  currency: string;
  amount: number;
  tranId?: number;
  terminal?: string;
  documentInfo?: Record<string, unknown> | null;
  tranDocument?: Record<string, unknown>;
}) {
  return {
    ResponseCode: 0,
    ReturnValue: String(opts.requestId),
    TerminalNumber: Number(opts.terminal ?? LIVE_TERMINAL),
    ...(opts.documentInfo !== undefined ? { DocumentInfo: opts.documentInfo } : {}),
    TranzactionInfo: {
      ResponseCode: 0,
      TranzactionId: opts.tranId ?? 900000 + opts.requestId,
      Amount: opts.amount,
      CoinId: COIN[opts.currency],
      TerminalNumber: Number(opts.terminal ?? LIVE_TERMINAL),
      Brand: "Visa",
      Last4CardDigitsString: "4242",
      ...(opts.tranDocument ?? {}),
    },
  };
}

/** A stored, open request (as createPaymentRequest leaves it) on a seeded connection. */
async function openRequest(
  store: InMemoryPaymentStore,
  currency: string,
  businessId = 1,
  amount = "250.00"
) {
  const request = await store.createPaymentRequest({
    businessId,
    customerId: null,
    billingDocumentId: null,
    provider: "CARDCOM",
    amount,
    currency,
    description: null,
    status: "PENDING",
    expiresAt: null,
  });
  await store.updatePaymentRequest(request.id, { paymentUrl: "https://secure.cardcom.solutions/pay/x", providerRequestId: `lp-${request.id}` });
  return (await store.findPaymentRequestById(request.id))!;
}

async function verify(
  store: InMemoryPaymentStore,
  request: Awaited<ReturnType<typeof openRequest>>,
  adapter: PaymentProviderAdapter,
  opts: { source?: "WEBHOOK" | "RECONCILIATION"; callback?: unknown; settled?: number[] } = {}
) {
  return runWithTenantContext({ businessId: request.businessId }, () =>
    resolvePaymentAuthoritatively(
      { request, adapter, source: opts.source ?? "WEBHOOK", rawPayload: opts.callback ?? { LowProfileId: request.providerRequestId } },
      {
        store,
        runtimeEnv: PROD,
        decryptConnectionCredential: () => CREDENTIAL,
        settleAccounting: async (e) => {
          opts.settled?.push(e.paymentTransactionId);
        },
      }
    )
  );
}

async function main() {
  // ══ A. GATING ═══════════════════════════════════════════════════════════
  // A1. The rule itself — every collector, both switch states.
  for (const enabled of [false, true]) {
    for (const provider of ["CARDCOM", "SUMIT", "TRANZILA", "PAYPAL"]) {
      for (const documentIssuer of [...ISSUERS, null]) {
        const refusal = foreignCurrencyCollectionRefusal({ provider, documentIssuer }, enabled);
        const expected = !enabled
          ? "FX_COLLECTION_DISABLED"
          : provider === "CARDCOM" && documentIssuer === "PROVIDER_ISSUES"
            ? null
            : "FX_REQUIRES_PROVIDER_DOCUMENTS";
        ok(`rule: switch ${enabled ? "ON" : "OFF"} · ${provider} · ${documentIssuer} → ${expected ?? "ALLOWED"}`, refusal === expected, String(refusal));
      }
    }
    ok(`rule: switch ${enabled ? "ON" : "OFF"} · no collector → refused`, foreignCurrencyCollectionRefusal(null, enabled) !== null);
  }
  ok("ILS passes the gate whatever the collector or switch", (() => {
    try {
      assertForeignCurrencyCollectionAllowed("ILS", null, false);
      assertForeignCurrencyCollectionAllowed("ILS", { provider: "SUMIT", documentIssuer: "DUBIZ_ISSUES" }, true);
      return true;
    } catch {
      return false;
    }
  })());
  ok("offerableCurrencies is fail-closed without an answer (ILS alone)", JSON.stringify(offerableCurrencies(CARDCOM_SUPPORTED_CURRENCIES)) === '["ILS"]');
  ok("offerableCurrencies with the collector allowed → CardCom's set", JSON.stringify(offerableCurrencies(CARDCOM_SUPPORTED_CURRENCIES, true)) === '["ILS","USD","EUR"]');

  // A2. createPaymentRequest + readiness — the truth table through the real service.
  const ilsFootprints: string[] = [];
  for (const sw of [undefined, "true"] as const) {
    setFlag(sw);
    for (const documentIssuer of ISSUERS) {
      const readiness = await loadCollectionProviderReadiness(1, seeded(documentIssuer));
      const allowed = sw === "true" && documentIssuer === "PROVIDER_ISSUES";
      ok(
        `readiness: switch ${sw ? "ON" : "OFF"} · CardCom ${documentIssuer} → ${allowed ? "ILS, USD, EUR" : "ILS alone"}`,
        JSON.stringify(readiness.offerableCurrencies) === (allowed ? '["ILS","USD","EUR"]' : '["ILS"]') && readiness.blocker === null,
        JSON.stringify(readiness)
      );
      for (const currency of ["ILS", "USD", "EUR", "usd"]) {
        const store = seeded(documentIssuer);
        const { adapter, calls } = counted(createStubProvider({ supportedCurrencies: CARDCOM_SUPPORTED_CURRENCIES }));
        const r = await attempt(() =>
          createPaymentRequest(
            { businessId: 1, amount: 250, currency },
            { store, resolveProvider: () => adapter, decryptConnectionCredential: () => "c", now: () => new Date("2026-10-24T00:00:00Z") }
          )
        );
        const label = `create: switch ${sw ? "ON" : "OFF"} · CardCom ${documentIssuer} · ${currency}`;
        const isIls = currency === "ILS";
        if (isIls || allowed) {
          ok(`${label} → created, one provider call`, r.ok && store.requests.length === 1 && calls.createPaymentLink === 1 && store.requests[0]!.currency === currency.toUpperCase(), r.ok ? "" : String((r as { error: unknown }).error));
          if (isIls) {
            const req = { ...(store.requests[0] as unknown as Record<string, unknown>) };
            delete req.createdAt;
            delete req.updatedAt;
            ilsFootprints.push(JSON.stringify({ req, audit: store.auditEvents.map((e) => [e.eventType, e.summary, e.metadata]) }));
          }
        } else {
          const e = r.ok ? null : (r.error as unknown);
          const code = sw ? "FOREIGN_CURRENCY_REQUIRES_PROVIDER_DOCUMENTS" : "FOREIGN_CURRENCY_COLLECTION_DISABLED";
          ok(
            `${label} → 400 ${code}`,
            e instanceof PaymentCurrencyNotOfferableError && e.code === code && e.statusCode === 400 && JSON.stringify(e.offerable) === '["ILS"]',
            e instanceof Error ? `${(e as PaymentCurrencyNotOfferableError).code} ${e.message}` : "created"
          );
          ok(`${label} → no row, no audit, no provider call`, store.requests.length === 0 && store.auditEvents.length === 0 && calls.createPaymentLink === 0);
        }
      }
    }
  }
  ok(
    "ILS: the created row and audit are identical for every issuer setting and both switch states",
    ilsFootprints.length === 6 && ilsFootprints.every((f) => f === ilsFootprints[0]),
    ilsFootprints.join("\n")
  );

  setFlag("true");
  // An invoice-derived foreign currency is held to the same collector rule.
  {
    const store = seeded("DUBIZ_ISSUES");
    store.seedDocument({ id: 6, businessId: 1, currency: "USD", totalAmount: "100.00", outstandingAmount: "100.00" });
    const { adapter, calls } = counted(createStubProvider({ supportedCurrencies: CARDCOM_SUPPORTED_CURRENCIES }));
    const r = await attempt(() => createPaymentRequest({ businessId: 1, amount: 40, billingDocumentId: 6 }, { store, resolveProvider: () => adapter, decryptConnectionCredential: () => "c" }));
    ok("ON · DUBIZ_ISSUES · a USD invoice (no currency sent) → refused FOREIGN_CURRENCY_REQUIRES_PROVIDER_DOCUMENTS",
      !r.ok && (r.error as PaymentCurrencyNotOfferableError).code === "FOREIGN_CURRENCY_REQUIRES_PROVIDER_DOCUMENTS");
    ok("…no row, no audit, no provider call", store.requests.length === 0 && store.auditEvents.length === 0 && calls.createPaymentLink === 0);
  }
  // The adapter must still support the currency.
  {
    const store = seeded("PROVIDER_ISSUES");
    const { adapter, calls } = counted(createStubProvider({ supportedCurrencies: ["ILS", "USD"] }));
    const r = await attempt(() => createPaymentRequest({ businessId: 1, amount: 40, currency: "EUR" }, { store, resolveProvider: () => adapter, decryptConnectionCredential: () => "c" }));
    ok("ON · PROVIDER_ISSUES · an adapter without EUR → 400 UNSUPPORTED_CURRENCY", !r.ok && (r.error as PaymentCurrencyNotOfferableError).code === "UNSUPPORTED_CURRENCY");
    ok("…no row, no audit, no provider call", store.requests.length === 0 && store.auditEvents.length === 0 && calls.createPaymentLink === 0);
    const readiness = await loadCollectionProviderReadiness(1, seeded("PROVIDER_ISSUES"), () => ({ supportedCurrencies: ["ILS", "USD"] }));
    ok("readiness: PROVIDER_ISSUES with an ILS/USD adapter → ILS, USD", JSON.stringify(readiness.offerableCurrencies) === '["ILS","USD"]');
  }
  // A non-CardCom provider can never carry a foreign currency.
  {
    for (const provider of ["SUMIT", "TRANZILA", "PAYPAL"] as const) {
      ok(`${provider} · PROVIDER_ISSUES → not allowed`, !isForeignCurrencyAllowedFor({ provider, documentIssuer: "PROVIDER_ISSUES" }, true));
      const store = createInMemoryPaymentStore();
      store.seedConnection({ businessId: 1, provider: "CARDCOM", isActive: true, documentIssuer: "PROVIDER_ISSUES" });
      store.seedConnection({ businessId: 1, provider, isActive: true, documentIssuer: "PROVIDER_ISSUES" });
      const { adapter, calls } = counted(createStubProvider({ supportedCurrencies: null }));
      const r = await attempt(() => createPaymentRequest({ businessId: 1, amount: 40, currency: "USD", provider }, { store, resolveProvider: () => adapter, decryptConnectionCredential: () => "c" }));
      ok(`direct POST naming ${provider} with USD → refused, no row/audit/provider call`, !r.ok && store.requests.length === 0 && store.auditEvents.length === 0 && calls.createPaymentLink === 0, r.ok ? "created" : String((r as { error: unknown }).error));
    }
  }
  // The refusal's words, in both languages.
  {
    const e = new PaymentCurrencyNotOfferableError({ currency: "USD", offerable: ["ILS"], reason: "FX_REQUIRES_PROVIDER_DOCUMENTS", message: "x" });
    const heBody = paymentCurrencyRefusalBody(e, createTranslator(he));
    const enBody = paymentCurrencyRefusalBody(e, createTranslator(en));
    ok("he: requires CardCom documents", heBody.error === "גבייה ב-USD אפשרית רק דרך CardCom, כשהמסמכים מופקים ב-CardCom (בהגדרות חיבור CardCom). אפשר לבקש תשלום ב-ILS בלבד.", heBody.error);
    ok("en: requires CardCom documents", enBody.error === "Collecting in USD is available only through CardCom, when CardCom issues the documents (set in the CardCom connection). Payment requests can be made in ILS only.", enBody.error);
    ok("body { error, code: FOREIGN_CURRENCY_REQUIRES_PROVIDER_DOCUMENTS, offerableCurrencies: [ILS] }", heBody.code === "FOREIGN_CURRENCY_REQUIRES_PROVIDER_DOCUMENTS" && JSON.stringify(heBody.offerableCurrencies) === '["ILS"]');
  }

  // A3. Through the REAL CardCom adapter: the coin sent, and CardCom refusing it.
  for (const [currency, coin] of [["USD", 2], ["EUR", 978]] as const) {
    const http = cardcomHttp();
    const store = seeded("PROVIDER_ISSUES");
    const res = await createPaymentRequest({ businessId: 1, amount: 250, currency }, { store, resolveProvider: () => http.adapter, decryptConnectionCredential: () => CREDENTIAL });
    ok(`real CardCom: ${currency} page created with ISOCoinId ${coin}`, http.created.length === 1 && http.created[0]!.ISOCoinId === coin && res.paymentRequest.currency === currency);
    ok(`real CardCom: ${currency} request carries no Document object (terminal default; see PR)`, !("Document" in http.created[0]!));
    // CardCom refuses the currency for this terminal.
    const refusing = cardcomHttp();
    refusing.onCreate(() => ({ ResponseCode: 5018, Description: "Coin not allowed for terminal" }));
    const store2 = seeded("PROVIDER_ISSUES");
    const r = await attempt(() => createPaymentRequest({ businessId: 1, amount: 250, currency }, { store: store2, resolveProvider: () => refusing.adapter, decryptConnectionCredential: () => CREDENTIAL }));
    ok(`real CardCom refuses ${currency} → a clean 400 "Failed to create payment link"`, !r.ok && /Failed to create payment link/.test(String((r.error as Error).message)) && (r.error as { statusCode?: number }).statusCode === 400, r.ok ? "created" : String(r.error));
    ok(`…the request is FAILED, has no link and no money row`, store2.requests.length === 1 && store2.requests[0]!.status === "FAILED" && !store2.requests[0]!.paymentUrl && store2.transactions.length === 0);
    ok(`…no settlement, nothing to collect`, store2.accountingSettlements.length === 0);
  }
  {
    // ILS through the real adapter: coin 1, no Document object — as before.
    const http = cardcomHttp();
    await createPaymentRequest({ businessId: 1, amount: 250, currency: "ILS" }, { store: seeded("PROVIDER_ISSUES"), resolveProvider: () => http.adapter, decryptConnectionCredential: () => CREDENTIAL });
    ok("real CardCom: ILS page created with ISOCoinId 1 and the same body keys as before", http.created[0]!.ISOCoinId === 1 &&
      Object.keys(http.created[0]!).sort().join(",") === "Amount,ApiName,FailedRedirectUrl,ISOCoinId,Operation,ProductName,ReturnValue,SuccessRedirectUrl,TerminalNumber,WebHookUrl",
      Object.keys(http.created[0]!).sort().join(","));
  }

  // ══ B. DOCUMENT VERIFICATION ════════════════════════════════════════════
  // B1. The adapter's reading of GetLpResult.
  {
    const info = { ResponseCode: 0, DocumentType: "TaxInvoiceAndReceipt", DocumentNumber: 12345, DocumentUrl: DOC_URL };
    ok("DocumentInfo with number + type + CardCom url → the document", JSON.stringify(cardComIssuedDocument({ DocumentInfo: info }, null)) === JSON.stringify({ number: "12345", type: "TaxInvoiceAndReceipt", url: DOC_URL }));
    ok("TranzactionInfo DocumentNumber + DocumentType → the document", cardComIssuedDocument({}, { DocumentNumber: "778", DocumentType: "Receipt" })?.number === "778");
    ok("DocumentInfo with a non-zero ResponseCode → NO document (even with a number on the transaction)", cardComIssuedDocument({ DocumentInfo: { ResponseCode: 7, Description: "fail" } }, { DocumentNumber: 5, DocumentType: "Receipt" }) === null);
    ok("a bare DocumentInfo object → no document", cardComIssuedDocument({ DocumentInfo: {} }, null) === null);
    ok("DocumentNumber 0 → no document", cardComIssuedDocument({}, { DocumentNumber: 0, DocumentType: "Receipt" }) === null);
    ok("a number without a type → no document", cardComIssuedDocument({}, { DocumentNumber: 99 }) === null);
    ok("type 'Error' → no document", cardComIssuedDocument({}, { DocumentNumber: 99, DocumentType: "Error" }) === null);
    ok("a numeric type is kept as stated", cardComIssuedDocument({}, { DocumentNumber: 99, DocumentType: 3 })?.type === "3");
    ok("nothing at all → no document", cardComIssuedDocument({}, {}) === null && cardComIssuedDocument(null, null) === null);
    for (const bad of ["https://evil.example/doc", "http://secure.cardcom.solutions/doc", "javascript:alert(1)", "https://cardcom.solutions.evil.example/x", "https://u:p@secure.cardcom.solutions/x", "", 42]) {
      ok(`url ${JSON.stringify(bad)} → not a CardCom link (dropped)`, cardComDocumentUrl(bad) === null);
    }
    ok("https on a cardcom.co.il host is kept", cardComDocumentUrl("https://secure.cardcom.co.il/doc?id=1") === "https://secure.cardcom.co.il/doc?id=1");
    ok("a document with a foreign url keeps its number, loses the link", JSON.stringify(cardComIssuedDocument({}, { DocumentNumber: 5, DocumentType: "Receipt", DocumentUrl: "https://evil.example/x" })) === JSON.stringify({ number: "5", type: "Receipt", url: null }));
    ok("the generic shape check refuses junk", verifiedProviderDocument({ number: "12a", type: "R" }) === null && verifiedProviderDocument({ number: "1", type: "<b>" }) === null && verifiedProviderDocument("x") === null);
    ok("the generic shape check drops a non-https link", verifiedProviderDocument({ number: "1", type: "Receipt", url: "javascript:x" })?.url === null);
  }

  // B2. Through the authoritative path, every currency × issuer.
  type Case = { currency: string; issuer: Issuer; doc: "info" | "tran" | "none" | "infoError" | "bare" };
  const docOf = (c: Case, requestId: number) =>
    lpResult({
      requestId,
      currency: c.currency,
      amount: 250,
      documentInfo:
        c.doc === "info" ? { ResponseCode: 0, DocumentType: "TaxInvoiceAndReceipt", DocumentNumber: 40000 + requestId, DocumentUrl: DOC_URL }
          : c.doc === "infoError" ? { ResponseCode: 3, Description: "no document" }
            : c.doc === "bare" ? {}
              : undefined,
      tranDocument: c.doc === "tran" ? { DocumentNumber: 50000 + requestId, DocumentType: "Receipt", DocumentUrl: DOC_URL } : undefined,
    });

  for (const currency of ["USD", "EUR"]) {
    for (const doc of ["info", "tran"] as const) {
      const http = cardcomHttp();
      const store = seeded("PROVIDER_ISSUES");
      const request = await openRequest(store, currency);
      http.answerLp({ body: docOf({ currency, issuer: "PROVIDER_ISSUES", doc }, request.id) });
      const settled: number[] = [];
      const res = await verify(store, request, http.adapter, { settled });
      const tx = store.transactions[0];
      const s = store.accountingSettlements[0];
      const expectedNumber = String((doc === "info" ? 40000 : 50000) + request.id);
      ok(`${currency} · PROVIDER_ISSUES · document in ${doc} → RECORDED PAID`, res.kind === "RECORDED" && res.outcome === "PAID" && res.requestStatus === "PAID", JSON.stringify(res));
      ok(`${currency} · ${doc} — the money exactly as CardCom verified it`, tx?.status === "PAID" && tx.amount === "250.00" && tx.currency === currency && tx.providerTransactionId === String(900000 + request.id));
      ok(`${currency} · ${doc} — accounting PROVIDER_IS_DOCUMENT_ISSUER (as for ILS today)`, res.kind === "RECORDED" && res.accountingHold === "PROVIDER_IS_DOCUMENT_ISSUER" && s?.status === "REQUIRES_ATTENTION" && s.attentionReason === "PROVIDER_IS_DOCUMENT_ISSUER", JSON.stringify(s));
      const kept = readProviderDocument(tx?.rawPayload);
      ok(`${currency} · ${doc} — CardCom's document kept with the money`, kept?.number === expectedNumber && kept.type === (doc === "info" ? "TaxInvoiceAndReceipt" : "Receipt") && kept.url === DOC_URL, JSON.stringify(kept));
      const held = await store.listAuditEvents(1, { eventType: "PAYMENT_ACCOUNTING_HELD" });
      ok(`${currency} · ${doc} — the hold is audited with the document number`, held.length === 1 && (held[0]!.metadata as Record<string, unknown>).providerDocumentNumber === expectedNumber);
      ok(`${currency} · ${doc} — the settlement hook ran once (it pauses; it never issues)`, settled.length === 1);

      // Redelivery: the same webhook again → nothing new.
      const again = await verify(store, (await store.findPaymentRequestById(request.id))!, http.adapter, { settled });
      ok(`${currency} · ${doc} — a redelivered webhook → ALREADY_RECORDED, one money row, one settlement`, again.kind === "ALREADY_RECORDED" && store.transactions.length === 1 && store.accountingSettlements.length === 1);
      ok(`${currency} · ${doc} — …the kept document is unchanged`, JSON.stringify(readProviderDocument(store.transactions[0]!.rawPayload)) === JSON.stringify(kept));
      const api = toPaymentTransactionApi(store.transactions[0]!);
      ok(`${currency} · ${doc} — payment detail API: the document, never the raw payload`, JSON.stringify(api.providerDocument) === JSON.stringify(kept) && !("rawPayload" in api));
    }
    for (const doc of ["none", "infoError", "bare"] as const) {
      const http = cardcomHttp();
      const store = seeded("PROVIDER_ISSUES");
      const request = await openRequest(store, currency);
      http.answerLp({ body: docOf({ currency, issuer: "PROVIDER_ISSUES", doc }, request.id) });
      const res = await verify(store, request, http.adapter);
      const tx = store.transactions[0];
      const s = store.accountingSettlements[0];
      ok(`${currency} · PROVIDER_ISSUES · ${doc} → the money is still RECORDED PAID`, res.kind === "RECORDED" && res.outcome === "PAID" && tx?.status === "PAID" && tx.currency === currency && tx.amount === "250.00");
      ok(`${currency} · ${doc} → REQUIRES_ATTENTION PROVIDER_DOCUMENT_MISSING`, res.kind === "RECORDED" && res.accountingHold === "PROVIDER_DOCUMENT_MISSING" && s?.status === "REQUIRES_ATTENTION" && s.attentionReason === "PROVIDER_DOCUMENT_MISSING", JSON.stringify(s));
      ok(`${currency} · ${doc} → recorded as checked-and-missing (null)`, readProviderDocument(tx?.rawPayload) === null);
      ok(`${currency} · ${doc} → the payment detail API says so (null)`, toPaymentTransactionApi(tx!).providerDocument === null);
      const audit = await store.listAuditEvents(1, { eventType: "PAYMENT_ACCOUNTING_HELD" });
      ok(`${currency} · ${doc} → audited with no document number`, audit.length === 1 && (audit[0]!.metadata as Record<string, unknown>).accountingHold === "PROVIDER_DOCUMENT_MISSING" && (audit[0]!.metadata as Record<string, unknown>).providerDocumentNumber === null);
    }
  }

  // B3. The webhook body is never the authority on the document.
  {
    const http = cardcomHttp();
    const store = seeded("PROVIDER_ISSUES");
    const request = await openRequest(store, "USD");
    http.answerLp({ body: docOf({ currency: "USD", issuer: "PROVIDER_ISSUES", doc: "none" }, request.id) });
    const forged = { LowProfileId: request.providerRequestId, DocumentInfo: { ResponseCode: 0, DocumentType: "Receipt", DocumentNumber: 999999, DocumentUrl: DOC_URL }, TranzactionInfo: { DocumentNumber: 999999, DocumentType: "Receipt" } };
    await verify(store, request, http.adapter, { callback: forged });
    ok("a webhook body claiming a document, CardCom's answer naming none → PROVIDER_DOCUMENT_MISSING", store.accountingSettlements[0]?.attentionReason === "PROVIDER_DOCUMENT_MISSING");
    ok("…the forged number is nowhere in the recorded document", readProviderDocument(store.transactions[0]!.rawPayload) === null);
  }
  // B4. A failed lookup establishes nothing.
  for (const [label, answer] of [["HTTP 500", { status: 500, body: {} }], ["network error", { throws: true }], ["unparseable", { status: 200, body: "<html>" }]] as const) {
    const http = cardcomHttp();
    const store = seeded("PROVIDER_ISSUES");
    const request = await openRequest(store, "EUR");
    http.answerLp(answer as LpAnswer);
    const res = await verify(store, request, http.adapter);
    ok(`verification ${label} → UNRESOLVED, nothing recorded, no settlement, request still open`,
      res.kind === "UNRESOLVED" && store.transactions.length === 0 && store.accountingSettlements.length === 0 && (await store.findPaymentRequestById(request.id))!.status === "PENDING",
      JSON.stringify(res));
  }
  // B5. A missing document stays missing on redelivery (a person resolves it; never a Dubiz receipt).
  {
    const http = cardcomHttp();
    const store = seeded("PROVIDER_ISSUES");
    const request = await openRequest(store, "USD");
    http.answerLp({ body: docOf({ currency: "USD", issuer: "PROVIDER_ISSUES", doc: "none" }, request.id) });
    await verify(store, request, http.adapter);
    http.answerLp({ body: docOf({ currency: "USD", issuer: "PROVIDER_ISSUES", doc: "info" }, request.id) });
    const again = await verify(store, (await store.findPaymentRequestById(request.id))!, http.adapter);
    ok("missing, then redelivered → ALREADY_RECORDED, no second money row", again.kind === "ALREADY_RECORDED" && store.transactions.length === 1);
    ok("…the settlement stays PROVIDER_DOCUMENT_MISSING (never quietly flipped, never a Dubiz receipt)", store.accountingSettlements.length === 1 && store.accountingSettlements[0]!.attentionReason === "PROVIDER_DOCUMENT_MISSING");
    ok("PROVIDER_DOCUMENT_MISSING is non-retryable", NON_RETRYABLE_ATTENTION_REASONS.has("PROVIDER_DOCUMENT_MISSING"));
  }
  // B6. Precedence: a test terminal in Production is still TEST_ENVIRONMENT_PAYMENT.
  {
    const http = cardcomHttp();
    const store = createInMemoryPaymentStore();
    store.seedConnection({ businessId: 2, provider: "CARDCOM", isActive: true, merchantId: "1000", documentIssuer: "PROVIDER_ISSUES" });
    const request = await openRequest(store, "USD", 2);
    http.answerLp({ body: lpResult({ requestId: request.id, currency: "USD", amount: 250, terminal: "1000" }) });
    await verify(store, request, http.adapter);
    ok("USD · PROVIDER_ISSUES · test terminal in Production → TEST_ENVIRONMENT_PAYMENT (unchanged precedence)", store.accountingSettlements[0]?.attentionReason === "TEST_ENVIRONMENT_PAYMENT");
  }
  // B7. ILS — decided and recorded exactly as before.
  for (const issuer of ISSUERS) {
    for (const doc of ["info", "none"] as const) {
      const http = cardcomHttp();
      const store = seeded(issuer);
      const request = await openRequest(store, "ILS");
      http.answerLp({ body: docOf({ currency: "ILS", issuer, doc }, request.id) });
      const res = await verify(store, request, http.adapter);
      const expected =
        issuer === "PROVIDER_ISSUES" ? "PROVIDER_IS_DOCUMENT_ISSUER"
          : doc === "info" ? "PROVIDER_ISSUED_DOCUMENT"
            : issuer === "NOT_CONFIGURED" ? "DOCUMENT_ISSUER_NOT_CONFIGURED"
              : null;
      const raw = store.transactions[0]?.rawPayload as { verification?: Record<string, unknown> } | undefined;
      ok(`ILS · ${issuer} · document ${doc} → ${expected ?? "no hold"} (as before)`, res.kind === "RECORDED" && res.accountingHold === expected, JSON.stringify(res));
      ok(`ILS · ${issuer} · ${doc} — no providerDocument key on the money row (byte-identical envelope)`, !!raw?.verification && !("providerDocument" in raw.verification) && readProviderDocument(raw) === undefined);
      ok(`ILS · ${issuer} · ${doc} — the payment detail API carries no document key`, !("providerDocument" in toPaymentTransactionApi(store.transactions[0]!)));
    }
  }
  // B8. Defence in depth: a foreign row on DUBIZ_ISSUES / NOT_CONFIGURED (cannot be created after A).
  for (const issuer of ["DUBIZ_ISSUES", "NOT_CONFIGURED"] as const) {
    const http = cardcomHttp();
    const store = seeded(issuer);
    const request = await openRequest(store, "USD");
    http.answerLp({ body: docOf({ currency: "USD", issuer, doc: "none" }, request.id) });
    const res = await verify(store, request, http.adapter);
    ok(`USD · ${issuer} (legacy/defence) → recorded as before (${issuer === "DUBIZ_ISSUES" ? "no recording-time hold; settlement holds it FOREIGN_CURRENCY_DOCUMENT_HELD" : "DOCUMENT_ISSUER_NOT_CONFIGURED"})`,
      res.kind === "RECORDED" && res.accountingHold === (issuer === "DUBIZ_ISSUES" ? null : "DOCUMENT_ISSUER_NOT_CONFIGURED"));
    ok(`USD · ${issuer} — no providerDocument key (not checked)`, readProviderDocument(store.transactions[0]!.rawPayload) === undefined);
  }

  // B9. Refund of a foreign-currency payment — unchanged: original currency, decision pause.
  {
    const http = cardcomHttp();
    const store = seeded("PROVIDER_ISSUES");
    const request = await openRequest(store, "USD");
    http.answerLp({ body: docOf({ currency: "USD", issuer: "PROVIDER_ISSUES", doc: "info" }, request.id) });
    await verify(store, request, http.adapter);
    const seen: RefundPaymentInput[] = [];
    const refunder: PaymentProviderAdapter = {
      ...http.adapter,
      async refundPayment(input: RefundPaymentInput) {
        seen.push(input);
        return { providerRefundId: `refund-${seen.length}`, outcome: "REFUNDED" as const };
      },
    };
    const r = await refundPaymentRequest(
      { businessId: 1, actorUserId: 7, requestId: request.id, amount: "40.00", idempotencyKey: "fx-refund-0001" },
      { store, resolveProvider: () => refunder, decryptConnectionCredential: () => CREDENTIAL }
    );
    ok("USD refund → settled, negative, in USD (the payment's own currency)", r.outcome === "REFUNDED" && r.refund.amount === "-40.00" && r.refund.currency === "USD", JSON.stringify(r.refund));
    ok("…CardCom asked once, in USD", seen.length === 1 && seen[0]!.currency === "USD" && seen[0]!.amount === "40.00", JSON.stringify(seen));
    const row = store.accountingSettlements.find((a) => a.paymentTransactionId === r.refund.id);
    ok("…its accounting pauses on REFUND_ACCOUNTING_DECISION_REQUIRED (unchanged)", row?.status === "REQUIRES_ATTENTION" && row.attentionReason === "REFUND_ACCOUNTING_DECISION_REQUIRED");
    ok("…the original payment's document and hold are untouched", store.accountingSettlements[0]!.attentionReason === "PROVIDER_IS_DOCUMENT_ISSUER" && readProviderDocument(store.transactions[0]!.rawPayload)?.number === String(40000 + request.id));
  }

  // ══ C. WHAT THE OWNER SEES ══════════════════════════════════════════════
  {
    ok("he label (owner order)", moneyHe.collection.attention.PROVIDER_DOCUMENT_MISSING === "התשלום התקבל ונרשם — המסמך מ־CardCom חסר ודורש טיפול");
    ok("en label", moneyEn.collection.attention.PROVIDER_DOCUMENT_MISSING === "The payment arrived and was recorded — the CardCom document is missing and needs attention");
    ok("the collection UI maps the reason to its own text, REVIEW (no retry lead)", ATTENTION_REASON_TEXT.PROVIDER_DOCUMENT_MISSING?.action === "REVIEW" && attentionText("PROVIDER_DOCUMENT_MISSING").title === moneyHe.collection.attention.PROVIDER_DOCUMENT_MISSING);
    ok("attentionText localizes it to English", attentionText("PROVIDER_DOCUMENT_MISSING", createTranslator(en)).title === moneyEn.collection.attention.PROVIDER_DOCUMENT_MISSING);
    const doc = { number: "40017", type: "TaxInvoiceAndReceipt", url: DOC_URL };
    ok("he: document line", providerDocumentText(doc, createTranslator(he)) === "המסמך הופק ב־CardCom: חשבונית מס/קבלה מס׳ 40017", providerDocumentText(doc, createTranslator(he)));
    ok("en: document line", providerDocumentText(doc, createTranslator(en)) === "Document issued by CardCom: Tax invoice/receipt no. 40017", providerDocumentText(doc, createTranslator(en)));
    ok("an unlisted type is shown as CardCom states it", providerDocumentText({ number: "1", type: "DonationReceipt", url: null }, createTranslator(en)) === "Document issued by CardCom: DonationReceipt no. 1");
    const html = renderToStaticMarkup(createElement(ProviderDocumentNote, { doc, t: createTranslator(he) }));
    ok("the link opens CardCom's own URL in a new tab, no opener", html.includes(`href="${DOC_URL.replace(/&/g, "&amp;")}"`) && html.includes('target="_blank"') && html.includes('rel="noopener noreferrer"'), html);
    const noLink = renderToStaticMarkup(createElement(ProviderDocumentNote, { doc: { ...doc, url: null }, t: createTranslator(he) }));
    ok("no url → the number without a link", noLink.includes("40017") && !noLink.includes("<a"), noLink);
    ok("no document → nothing rendered", renderToStaticMarkup(createElement(ProviderDocumentNote, { doc: null, t: createTranslator(he) })) === "" && renderToStaticMarkup(createElement(ProviderDocumentNote, { doc: undefined, t: createTranslator(he) })) === "");
  }

  setFlag(undefined);
  console.log(`\nfx-provider-documents: ${pass} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
