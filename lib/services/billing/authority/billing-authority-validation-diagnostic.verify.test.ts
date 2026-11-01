/**
 * Sanitized diagnostics for documented 400 validation rejections (#36423501). Run manually:
 *   npx tsx lib/services/billing/authority/billing-authority-validation-diagnostic.verify.test.ts
 *
 * Run 2 (2026-11-01) was rejected with ITA_432 and only the first code survived; this keeps the
 * bounded error list (code / param / location / short message) plus the gateway transaction id in
 * the rejection audit — never tokens, dealer / id numbers, emails or raw bodies.
 */
import { BillingAuthorityEnvironment, BillingAuthoritySubmissionStatus, BillingDocumentStatus } from "@prisma/client";
import { sendInvoiceApproval } from "@/lib/services/billing/authority/billing-authority-approval-client";
import { requestInvoiceApproval, type ApprovalDomainResult } from "@/lib/services/billing/authority/billing-authority-approval-orchestrator";
import type { InvoiceApprovalRequest } from "@/lib/services/billing/authority/billing-authority-approval.types";
import {
  PROVIDER_VALIDATION_ERRORS_MAX,
  providerValidationMetadata,
  sanitizeProviderMessage,
  sanitizeProviderValidationErrors,
} from "@/lib/services/billing/authority/billing-authority-provider-diagnostic";
import {
  executeAuthorityApproval,
  type LoadedDocumentSubmission,
  type SubmissionExecutionDeps,
} from "@/lib/services/billing/authority/billing-authority-submission-execution.service";
import type { RecordAuthorityRejectedTxInput } from "@/lib/services/billing/authority/billing-authority-transition.service";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    console.log(`OK: ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL: ${name}`, extra ?? "");
  }
}

const ACCESS_TOKEN = "AAPK" + "y".repeat(150);
const CONFIG = { apiBaseUrl: "https://ita-api.taxes.gov.il/shaam/tsandbox", apiVersion: "v2", timeoutMs: 1000, scope: "" };
const PAYLOAD: InvoiceApprovalRequest = {
  invoice_id: "2", invoice_type: 305, vat_number: 777777715, invoice_reference_number: "000002",
  customer_vat_number: 777777715, invoice_date: "2026-11-01", invoice_issuance_date: "2026-11-01",
  accounting_software_number: 270901, amount_before_discount: 5000, discount: 0, payment_amount: 5000,
  vat_amount: 900, payment_amount_including_vat: 5900,
};
// Shape of the official v1.0 (2023-07) example for code 432.
const BODY_400 = {
  status: 400,
  message: { errors: [{ code: 432, message: "Customer VAT Number is incorrect", param: "customer_vat_number", location: "validation" }] },
  confirmation_number: "0",
  approved: false,
};

function fetch400(body: unknown, headers: Record<string, string> = { "content-type": "application/json", "x-global-transaction-id": "tx-400-abc123" }): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status: 400, headers })) as typeof fetch;
}

async function clientAndOrchestrator() {
  const r = await sendInvoiceApproval({ accessToken: ACCESS_TOKEN, payload: PAYLOAD, config: CONFIG, fetchImpl: fetch400(BODY_400) });
  ok("client: 400 stays validation_error", r.kind === "validation_error", r.kind);
  ok("client: error list parsed", r.kind === "validation_error" && r.response.message.errors[0]?.code === 432 && r.response.message.errors[0]?.param === "customer_vat_number");
  ok("client: gateway transaction id attached", r.kind === "validation_error" && r.providerDiagnostic?.transactionId === "tx-400-abc123", r);
  ok("client: result never contains the access token", !JSON.stringify(r).includes(ACCESS_TOKEN.slice(0, 20)));

  const d = await requestInvoiceApproval(
    { snapshot: {} as never, customerTaxId: "777777715", accountingSoftwareNumber: 270901, operatorUserName: "2", accessToken: ACCESS_TOKEN, config: CONFIG },
    { buildPayload: () => ({ ok: true, payload: PAYLOAD }), sendApproval: (input) => sendInvoiceApproval({ ...input, fetchImpl: fetch400(BODY_400) }) },
  );
  ok("orchestrator: authority_validation_failed with errors + transaction id",
    d.outcome === "authority_validation_failed" && d.errors.length === 1 && d.providerTransactionId === "tx-400-abc123", d);

  const noHeader = await sendInvoiceApproval({ accessToken: ACCESS_TOKEN, payload: PAYLOAD, config: CONFIG, fetchImpl: fetch400(BODY_400, { "content-type": "application/json" }) });
  ok("client: no headers → no diagnostic, still validation_error", noHeader.kind === "validation_error" && (noHeader.providerDiagnostic ?? null) === null);
}

function sanitizerTests() {
  const [e] = sanitizeProviderValidationErrors(BODY_400.message.errors);
  ok("keeps code / param / location / message", e.code === 432 && e.param === "customer_vat_number" && e.location === "validation" && e.message === "Customer VAT Number is incorrect", e);
  ok("Hebrew message kept", sanitizeProviderMessage("מספר עוסק של הלקוח שגוי") === "מספר עוסק של הלקוח שגוי");
  ok("dealer / id digits masked", sanitizeProviderMessage("Customer 777777715 is not a dealer, ref 2026") === "Customer # is not a dealer, ref 2026");
  ok("token-like run dropped", sanitizeProviderMessage(`Bearer ${ACCESS_TOKEN}`) === null);
  ok("email dropped (no @ allowed)", sanitizeProviderMessage("contact someone@example.com") === null);
  ok("quotes / markup dropped", sanitizeProviderMessage('bad "x" <b>') === null);
  ok("message bounded to 160", (sanitizeProviderMessage("א ".repeat(200)) ?? "").length <= 160);
  const odd = sanitizeProviderValidationErrors([{ code: "432", param: "a b", location: "VALIDATION", message: 5 }, { code: -1 }, { code: 1e9 }, null, "x"]);
  ok("non-integer / out-of-range codes → null", odd[0].code === null && odd[1].code === null && odd[2].code === null);
  ok("unsafe param → null, location lower-cased", odd[0].param === null && odd[0].location === "validation");
  ok("non-object entries → all-null entry", odd[3].code === null && odd[4].message === null);
  ok("non-array → []", sanitizeProviderValidationErrors({ errors: [] }).length === 0 && sanitizeProviderValidationErrors(undefined).length === 0);
  const many = Array.from({ length: 25 }, (_, i) => ({ code: 400 + i, param: "p", location: "request", message: "m" }));
  const meta = providerValidationMetadata(many, "tx-1");
  ok(`list bounded to ${PROVIDER_VALIDATION_ERRORS_MAX}, count reports the total`,
    (meta.providerValidationErrors as unknown[]).length === PROVIDER_VALIDATION_ERRORS_MAX && meta.providerValidationErrorCount === 25 && meta.providerTransactionId === "tx-1");
  const leak = providerValidationMetadata([{ code: 432, param: ACCESS_TOKEN, location: "validation", message: `token ${ACCESS_TOKEN}` }], `Bearer ${ACCESS_TOKEN}`);
  ok("metadata never contains token material", !JSON.stringify(leak).includes("yyyyyyyyyy") && leak.providerTransactionId === null, leak);
  ok("metadata never contains a dealer number", !JSON.stringify(providerValidationMetadata([{ code: 432, message: "777777715 incorrect" }], null)).includes("777777715"));
}

async function executionTests() {
  const snapshot = {
    schemaVersion: 1, issuedAt: "2026-11-01T18:20:47.000Z",
    document: { id: 2, type: "TAX_INVOICE", status: "ISSUED", number: 2, numberFormatted: "000002", currency: "ILS", allocationNumber: null, referenceDocumentId: null },
    issuer: { id: 9, name: "t", legalName: "t", taxId: "777777715", vatRegistration: "777777715", address: null, phone: null, email: null, logoUrl: null, bankDetails: null },
    customer: { id: 4, name: "לקוח בדיקה", legalName: null, taxId: "777777715", phone: null, email: null, city: null, address: null },
    lines: [{ lineIndex: 0, description: "Sandbox test service", quantity: "1.0000", unitPrice: "5000.0000", vatRatePercent: "18.00", lineSubtotal: "5000.00", vatAmount: "900.00", lineTotal: "5900.00" }],
    totals: { subtotal: "5000.00", vat: "900.00", total: "5900.00" },
    tax: { currency: "ILS", defaultVatRate: null, vatMode: "EXCLUSIVE" },
    metadata: { locale: "he-IL", timezone: "Asia/Jerusalem", actorUserId: 2, source: "manual" },
    pdfTemplateStyle: "CLASSIC", extensions: {},
  };
  const loaded: LoadedDocumentSubmission = {
    id: 2, businessId: 9, status: BillingDocumentStatus.ISSUED, lockedAt: new Date("2026-11-01T18:20:47Z"), legalSnapshotHash: "h",
    issuedSnapshot: snapshot as unknown as LoadedDocumentSubmission["issuedSnapshot"],
    submission: { id: 2, status: BillingAuthoritySubmissionStatus.READY, authorityPayloadHash: null, errorCode: null, lastAttemptAt: null },
  };
  let rejected: RecordAuthorityRejectedTxInput | null = null;
  const result: ApprovalDomainResult = { outcome: "authority_validation_failed", errors: BODY_400.message.errors, providerTransactionId: "tx-400-abc123" };
  const deps: SubmissionExecutionDeps = {
    loadDocumentWithSubmission: async () => loaded,
    resolveEnvironment: () => BillingAuthorityEnvironment.SANDBOX,
    resolveRuntimeContext: async () => ({ ok: true, context: { accessToken: ACCESS_TOKEN, approvalConfig: { apiBaseUrl: CONFIG.apiBaseUrl, apiVersion: "v2", timeoutMs: 1000 }, accountingSoftwareNumber: "270901", connectionId: 2, environment: BillingAuthorityEnvironment.SANDBOX } }),
    buildPayload: () => ({ ok: true, payload: PAYLOAD }),
    requestApproval: async () => result,
    hashPayload: () => "HASH",
    now: () => new Date("2026-11-01T18:20:48Z"),
    runInTransaction: (_b: number, fn: (tx: never) => unknown) => fn({} as never),
    recordAttempt: async () => ({ submission: { id: 2 } }),
    recordApproved: async () => ({}),
    recordRejected: async (_tx, input) => { rejected = input; return {}; },
    recordFailed: async () => ({}),
    recordHeld: async () => ({}),
    recordOutcomeUncertain: async () => ({}),
    reportSafetyEvent: () => {},
  } as SubmissionExecutionDeps;
  const r = await executeAuthorityApproval({ businessId: 9, billingDocumentId: 2, actorUserId: 2 } as never, deps);
  const got = rejected as RecordAuthorityRejectedTxInput | null;
  ok("execution: 400 → completed_rejected ITA_432", r.outcome === "completed_rejected" && r.errorCode === "ITA_432", r);
  ok("execution: errorMessage stays our own code (no provider text in the column)", got?.errorMessage === "ITA_432");
  ok("execution: error list + transaction id handed to the audit", got?.providerValidation?.transactionId === "tx-400-abc123" && Array.isArray(got?.providerValidation?.errors) && (got?.providerValidation?.errors as unknown[]).length === 1, got);
  ok("execution: nothing token-like reaches the rejection input", !JSON.stringify(got).includes(ACCESS_TOKEN.slice(0, 20)));
}

(async () => {
  await clientAndOrchestrator();
  sanitizerTests();
  await executionTests();
  if (failed > 0) {
    console.error(`\n${failed} FAILED`);
    process.exit(1);
  }
  console.log("\nALL PASS");
})();
