/**
 * Run: npx tsx lib/services/payments/payment-core-safety.test.ts
 *
 * Production Safety & Shared Payment Core — the guards that are not about any
 * single provider:
 *
 *   - a TEST/SANDBOX account cannot turn into fiscal truth in Production;
 *   - a provider that issued its own document never gets a second one from us;
 *   - a connection open money depends on cannot be switched off or repointed;
 *   - one debt cannot carry two open links that could both be paid;
 *   - a callback's claimed amount is compared as money, not as text;
 *   - the attention list is durable, complete and tenant-scoped.
 */

import { runWithTenantContext } from "@/lib/tenant/context";
import { createInMemoryPaymentStore } from "./payment-store.memory";
import { resolvePaymentAuthoritatively } from "./payment-verification.service";
import { connectPaymentProvider, parseDocumentIssuer } from "./payment-connection.service";
import {
  AmbiguousPaymentProviderError,
  createPaymentRequest,
  selectPaymentProvider,
} from "./payment-request.service";
import { processPaymentWebhook } from "./payment-webhook.service";
import { listPaymentAttention } from "./payment-attention.service";
import { readPaymentMethod, readVerifiedEvidence } from "./payment-evidence";
import { receiptMethodFor } from "@/lib/services/billing/settlement/payment-accounting-settlement.service";
import { isEnvironmentAllowedForBusiness } from "./payment-environment";
import { COLLECTION_QA_BUSINESS_ID } from "./qa-webhook-suppression";
import type {
  PaymentProviderAdapter,
  ProviderPaymentStatus,
} from "./providers/payment-provider.types";

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
async function rejects(name: string, fn: () => Promise<unknown>, match: RegExp) {
  try {
    await fn();
    ok(name, false, "resolved instead of throwing");
  } catch (e) {
    ok(name, match.test(String(e instanceof Error ? e.message : e)), String(e));
  }
}

const PROD = { VERCEL_ENV: "production" };
const PREVIEW = { VERCEL_ENV: "preview" };

/** A CardCom-shaped adapter whose status answer and environment are chosen by the test. */
function adapter(
  status: Partial<ProviderPaymentStatus>,
  env: "TEST" | "LIVE" | "UNKNOWN" = "LIVE"
): PaymentProviderAdapter {
  return {
    provider: "CARDCOM",
    supportedCurrencies: ["ILS"],
    classifyEnvironment: () => env,
    async createPaymentLink(input) {
      return { paymentUrl: `https://pay.example/${input.paymentRequestId}`, providerRequestId: `lp-${input.paymentRequestId}` };
    },
    async verifyWebhook() {
      return { ok: true as const };
    },
    parseWebhook(input) {
      const body = (input.parsedBody ?? {}) as Record<string, unknown>;
      return {
        providerEventId: String(body.event ?? "e1"),
        eventType: "test",
        providerRequestId: String(body.lp ?? ""),
        providerTransactionId: null,
        outcome: "PENDING",
        amount: body.amount == null ? null : String(body.amount),
        currency: body.currency == null ? null : String(body.currency),
      };
    },
    async getPaymentStatus() {
      return {
        outcome: "PAID",
        providerTransactionId: "tx-1",
        verifiedAmount: "100.00",
        verifiedCurrency: "ILS",
        ...status,
      };
    },
  };
}

async function paidRequest(businessId: number, merchantId = "172012") {
  const store = createInMemoryPaymentStore();
  store.seedConnection({ businessId, provider: "CARDCOM", isActive: true, merchantId });
  const request = await store.createPaymentRequest({
    businessId,
    customerId: null,
    billingDocumentId: null,
    provider: "CARDCOM",
    amount: "100.00",
    currency: "ILS",
    description: null,
    status: "PENDING",
    expiresAt: null,
  });
  await store.updatePaymentRequest(request.id, { paymentUrl: "https://pay.example/x", providerRequestId: "lp-x" });
  return { store, request: (await store.findPaymentRequestById(request.id))! };
}

async function main() {
  // ── TEST account in Production: recorded, never receipted ──────────────
  {
    const { store, request } = await paidRequest(1, "1000");
    await runWithTenantContext({ businessId: 1 }, () =>
      resolvePaymentAuthoritatively(
        { request, adapter: adapter({}, "TEST"), source: "RECONCILIATION" },
        { store, runtimeEnv: PROD }
      )
    );
    const row = store.accountingSettlements[0];
    ok("a test-account payment in Production is still RECORDED (it is what the provider said)", store.transactions.length === 1);
    ok("but its accounting opens PAUSED, not pending a receipt", row?.status === "REQUIRES_ATTENTION");
    ok("on TEST_ENVIRONMENT_PAYMENT", row?.attentionReason === "TEST_ENVIRONMENT_PAYMENT");
  }
  {
    const { store, request } = await paidRequest(1, "1000");
    await runWithTenantContext({ businessId: 1 }, () =>
      resolvePaymentAuthoritatively(
        { request, adapter: adapter({}, "TEST"), source: "RECONCILIATION" },
        { store, runtimeEnv: PREVIEW }
      )
    );
    ok("outside Production a test account settles normally", store.accountingSettlements[0]?.status === "PENDING");
  }
  {
    ok(
      "the pinned Production QA tenant keeps its test-terminal proofs",
      isEnvironmentAllowedForBusiness("TEST", COLLECTION_QA_BUSINESS_ID, PROD)
    );
    ok("UNKNOWN is not live in Production", !isEnvironmentAllowedForBusiness("UNKNOWN", 1, PROD));
    ok("LIVE is live in Production", isEnvironmentAllowedForBusiness("LIVE", 1, PROD));
  }

  // ── a provider-issued document: never a second one from Dubiz ─────────
  {
    const { store, request } = await paidRequest(1);
    await runWithTenantContext({ businessId: 1 }, () =>
      resolvePaymentAuthoritatively(
        { request, adapter: adapter({ providerDocumentIssued: true }), source: "WEBHOOK", rawPayload: { cb: 1 } },
        { store, runtimeEnv: PROD }
      )
    );
    const row = store.accountingSettlements[0];
    ok("a provider that issued its own document pauses our receipt", row?.attentionReason === "PROVIDER_ISSUED_DOCUMENT");
    const audit = await store.listAuditEvents(1, { eventType: "PAYMENT_ACCOUNTING_HELD" });
    ok("and the hold is on the audit trail", audit.length === 1);
  }

  // ── evidence envelope + payment method → receipt line ─────────────────
  {
    const { store, request } = await paidRequest(1);
    await runWithTenantContext({ businessId: 1 }, () =>
      resolvePaymentAuthoritatively(
        {
          request,
          adapter: adapter({
            paymentMethod: "CARD",
            evidence: { instrumentBrand: "Visa", instrumentLast4: "4242", apiPassword: "never" },
          }),
          source: "RECONCILIATION",
        },
        { store, runtimeEnv: PROD }
      )
    );
    const raw = store.transactions[0]!.rawPayload;
    ok("the method the provider stated is recorded with the money", readPaymentMethod(raw) === "CARD");
    ok("a secret-shaped evidence key is never kept", !("apiPassword" in readVerifiedEvidence(raw)));
    const line = receiptMethodFor("CARD", readVerifiedEvidence(raw));
    ok("a stated card with brand + last4 becomes a CREDIT_CARD receipt line", line.method === "CREDIT_CARD");
    ok("a card without the stated facts stays OTHER (never invented)", receiptMethodFor("CARD", {}).method === "OTHER");
    ok("an unknown method stays OTHER", receiptMethodFor("UNKNOWN", {}).method === "OTHER");
    ok("BIT maps to BIT", receiptMethodFor("BIT", {}).method === "BIT");
  }

  // ── connections: test accounts and open obligations ───────────────────
  {
    const store = createInMemoryPaymentStore();
    const encryptCredential = () => ({
      credentialEncrypted: "e",
      credentialIv: "i",
      credentialTag: "t",
      encryptionKeyId: "k",
    });
    await rejects(
      "Production refuses connecting CardCom's public test terminal",
      () =>
        connectPaymentProvider(
          { businessId: 1, provider: "CARDCOM", merchantId: "1000", credential: "{}" },
          { store, encryptCredential, runtimeEnv: PROD }
        ),
      /בדיקה/
    );
    await connectPaymentProvider(
      { businessId: COLLECTION_QA_BUSINESS_ID, provider: "CARDCOM", merchantId: "1000", credential: "{}" },
      { store, encryptCredential, runtimeEnv: PROD }
    );
    ok("the pinned QA tenant may still connect the test terminal", (await store.listConnections(COLLECTION_QA_BUSINESS_ID)).length === 1);

    await connectPaymentProvider(
      { businessId: 1, provider: "CARDCOM", merchantId: "172012", credential: "{}" },
      { store, encryptCredential, runtimeEnv: PROD }
    );
    const req = await store.createPaymentRequest({
      businessId: 1, customerId: null, billingDocumentId: null, provider: "CARDCOM",
      amount: "10.00", currency: "ILS", description: null, status: "PENDING", expiresAt: null,
    });
    await store.updatePaymentRequest(req.id, { paymentUrl: "https://pay.example/1", providerRequestId: "lp-1" });

    await rejects(
      "an open payable link blocks DISCONNECTING the account that would take its money",
      () =>
        connectPaymentProvider(
          { businessId: 1, provider: "CARDCOM", merchantId: "172012", credential: "{}", isActive: false },
          { store, encryptCredential, runtimeEnv: PROD }
        ),
      /אי אפשר לנתק/
    );
    await rejects(
      "and blocks REPOINTING the connection at a different terminal",
      () =>
        connectPaymentProvider(
          { businessId: 1, provider: "CARDCOM", merchantId: "999999", credential: "{}" },
          { store, encryptCredential, runtimeEnv: PROD }
        ),
      /אי אפשר לנתק/
    );
    const rotated = await connectPaymentProvider(
      { businessId: 1, provider: "CARDCOM", merchantId: "172012", credential: '{"apiName":"new"}' },
      { store, encryptCredential, runtimeEnv: PROD }
    );
    ok("rotating the password of the SAME account is always allowed", rotated.isActive === true);
    const refused = await store.listAuditEvents(1, { eventType: "PAYMENT_CONNECTION_CHANGE_REFUSED" });
    ok("each refused change is audited", refused.length === 2);
  }

  // ── one open ask per debt ──────────────────────────────────────────────
  {
    const store = createInMemoryPaymentStore();
    store.seedConnection({ businessId: 1, provider: "CARDCOM", isActive: true, merchantId: "172012" });
    store.seedDocument({ id: 50, businessId: 1, outstandingAmount: "100.00", currency: "ILS" });
    const deps = {
      store,
      resolveProvider: () => adapter({}),
      decryptConnectionCredential: () => "{}",
      runtimeEnv: PREVIEW,
    };
    await createPaymentRequest({ businessId: 1, amount: "100.00", billingDocumentId: 50, provider: "CARDCOM" }, deps);
    await rejects(
      "a second open link for the same invoice is refused (both could be paid)",
      () => createPaymentRequest({ businessId: 1, amount: "100.00", billingDocumentId: 50, provider: "CARDCOM" }, deps),
      /כבר נשלחה בקשת תשלום/
    );
  }
  {
    const store = createInMemoryPaymentStore();
    store.seedConnection({ businessId: 1, provider: "CARDCOM", isActive: true, merchantId: "1000" });
    await rejects(
      "Production issues no link through a test account",
      () =>
        createPaymentRequest(
          { businessId: 1, amount: "10.00", provider: "CARDCOM" },
          { store, resolveProvider: () => adapter({}, "TEST"), decryptConnectionCredential: () => "{}", runtimeEnv: PROD }
        ),
      /בדיקה/
    );
    ok("and no request row is left behind", store.requests.length === 0);
  }

  // ── a callback's claimed amount is compared as MONEY ──────────────────
  {
    const { store, request } = await paidRequest(1);
    store.seedConnection({ businessId: 1, provider: "CARDCOM", isActive: true, merchantId: "172012" });
    const accepted = await processPaymentWebhook(
      { provider: "CARDCOM", rawBody: "{}", parsedBody: { lp: "lp-x", amount: 100, currency: " ils " } },
      { store, resolveProvider: () => adapter({}), runtimeEnv: PROD } as never
    );
    ok("a numeric 100 for a request of 100.00 is coherent", accepted.reason !== "amount_mismatch", String(accepted.reason));
    const refused = await processPaymentWebhook(
      { provider: "CARDCOM", rawBody: "{}", parsedBody: { lp: "lp-x", amount: "99.99", event: "e2" } },
      { store, resolveProvider: () => adapter({}) }
    );
    ok("a different amount is still refused", refused.reason === "amount_mismatch");
    const garbage = await processPaymentWebhook(
      { provider: "CARDCOM", rawBody: "{}", parsedBody: { lp: "lp-x", amount: "abc", event: "e3" } },
      { store, resolveProvider: () => adapter({}) }
    );
    ok("an unreadable amount is refused, not ignored", garbage.reason === "amount_mismatch");
    void request;
  }

  // ── attention: durable, complete, tenant-scoped ───────────────────────
  {
    const { store, request } = await paidRequest(1, "1000");
    await runWithTenantContext({ businessId: 1 }, () =>
      resolvePaymentAuthoritatively(
        { request, adapter: adapter({}, "TEST"), source: "RECONCILIATION" },
        { store, runtimeEnv: PROD }
      )
    );
    // an unresolved reversal
    await store.createTransaction({
      paymentRequestId: request.id, provider: "CARDCOM", providerTransactionId: null,
      amount: "-10.00", currency: "ILS", status: "PENDING", rawPayload: { kind: "refund_reservation" },
    });
    // an open link on a disabled provider
    const old = await store.createPaymentRequest({
      businessId: 1, customerId: null, billingDocumentId: null, provider: "SUMIT",
      amount: "5.00", currency: "ILS", description: null, status: "PENDING", expiresAt: null,
    });
    await store.updatePaymentRequest(old.id, { paymentUrl: "https://pay.sumit.example/1" });

    const mine = await listPaymentAttention(1, { store });
    ok("paused accounting is listed", mine.counts.ACCOUNTING === 1);
    ok("an unconfirmed refund is listed", mine.counts.REFUND_UNRESOLVED === 1);
    ok("an open link on a disabled provider is listed", mine.counts.DISABLED_PROVIDER_OPEN === 1);

    const theirs = await listPaymentAttention(2, { store });
    ok(
      "another business sees none of it",
      theirs.items.length === 0,
      JSON.stringify(theirs.counts)
    );
  }

  // ── PR-B: the configured document issuer ──────────────────────────────
  {
    const { store, request } = await paidRequest(1);
    // The connection as the store returns it, configured PROVIDER_ISSUES.
    await runWithTenantContext({ businessId: 1 }, () =>
      resolvePaymentAuthoritatively(
        {
          request,
          adapter: adapter({}),
          source: "RECONCILIATION",
        },
        {
          store: {
            ...store,
            findActiveConnection: async (b: number, p: "CARDCOM") => {
              const c = await store.findActiveConnection(b, p);
              return c ? { ...c, documentIssuer: "PROVIDER_ISSUES" as const } : null;
            },
          } as typeof store,
          runtimeEnv: PROD,
        }
      )
    );
    ok(
      "a connection configured PROVIDER_ISSUES never gets an automatic Dubiz receipt",
      store.accountingSettlements[0]?.attentionReason === "PROVIDER_IS_DOCUMENT_ISSUER",
      JSON.stringify(store.accountingSettlements[0])
    );
  }
  {
    await rejects(
      "an unknown document issuer is refused",
      async () => parseDocumentIssuer("BOTH"),
      /documentIssuer must be one of/
    );
    ok("an omitted document issuer means unchanged", parseDocumentIssuer(undefined) === undefined);
  }

  // ── PR-B: the default connection ───────────────────────────────────────
  {
    const store = createInMemoryPaymentStore();
    const encryptCredential = () => ({ credentialEncrypted: "e", credentialIv: "i", credentialTag: "t", encryptionKeyId: "k" });
    await connectPaymentProvider(
      { businessId: 1, provider: "CARDCOM", merchantId: "172012", credential: "{}", isDefault: true },
      { store, encryptCredential, runtimeEnv: PREVIEW }
    );
    store.seedConnection({ businessId: 1, provider: "SUMIT", isActive: true, merchantId: "9" });
    const allEnabled = () => true;
    ok(
      "with two usable providers, the business default decides",
      (await selectPaymentProvider({ businessId: 1, requested: null }, store, allEnabled)) === "CARDCOM"
    );
    await connectPaymentProvider(
      { businessId: 1, provider: "SUMIT", merchantId: "9", credential: "{}", isDefault: true },
      { store, encryptCredential, runtimeEnv: PREVIEW }
    );
    const defaults = (await store.listConnections(1)).filter((c) => c.isDefault);
    ok(
      "making another connection default leaves exactly one default",
      defaults.length === 1 && defaults[0]!.provider === "SUMIT"
    );
    const deactivated = await connectPaymentProvider(
      { businessId: 1, provider: "SUMIT", merchantId: "9", credential: "{}", isActive: false, isDefault: true },
      { store, encryptCredential, runtimeEnv: PREVIEW }
    );
    ok("an inactive connection is never the default", deactivated.isDefault === false);
    const noDefault = createInMemoryPaymentStore();
    noDefault.seedConnection({ businessId: 1, provider: "CARDCOM", isActive: true });
    noDefault.seedConnection({ businessId: 1, provider: "SUMIT", isActive: true });
    let ambiguous = false;
    try {
      await selectPaymentProvider({ businessId: 1, requested: null }, noDefault, allEnabled);
    } catch (e) {
      ambiguous = e instanceof AmbiguousPaymentProviderError;
    }
    ok("with no default, two usable providers are still refused as ambiguous", ambiguous);
  }

  console.log(`\npayment-core-safety: ${pass} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
