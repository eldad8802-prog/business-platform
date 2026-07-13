/**
 * Unit tests for the ITA allocation orchestrator (run manually):
 *   npx tsx lib/services/billing/authority/billing-authority-approval-orchestrator.test.ts
 *
 * Fully injected: no network, no DB. Deterministic.
 */
import type { BillingIssuedSnapshotV1 } from "@/lib/services/billing/pdf/billing-pdf-template";
import type { InvoiceApprovalRequest } from "@/lib/services/billing/authority/billing-authority-approval.types";
import type { ApprovalPayloadBuildResult } from "@/lib/services/billing/authority/billing-authority-approval-payload";
import { buildInvoiceApprovalPayload } from "@/lib/services/billing/authority/billing-authority-approval-payload";
import type {
  ApprovalClientResult,
} from "@/lib/services/billing/authority/billing-authority-approval-client.types";
import {
  requestInvoiceApproval,
  type ApprovalOrchestratorDeps,
} from "@/lib/services/billing/authority/billing-authority-approval-orchestrator";
import type { AuthorityApprovalConfig } from "@/lib/services/billing/authority/billing-authority-approval-client.config";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`OK: ${name}`);
  else { failed += 1; console.error(`FAIL: ${name}`, extra ?? ""); }
}

const CONFIG: AuthorityApprovalConfig = {
  apiBaseUrl: "https://t-ita-api.taxes.gov.il/shaam/tsandbox",
  apiVersion: "v2",
  timeoutMs: 15000,
  scope: "invoices_scope",
};

const VALID_PAYLOAD: InvoiceApprovalRequest = {
  invoice_id: "42", invoice_type: 305, vat_number: 515000123, invoice_reference_number: "000007",
  customer_vat_number: 514000000, invoice_date: "2026-06-15", invoice_issuance_date: "2026-06-15",
  accounting_software_number: 12345678, amount_before_discount: 100, discount: 0, payment_amount: 100,
  vat_amount: 17, payment_amount_including_vat: 117,
};

function baseInput(snapshot?: BillingIssuedSnapshotV1) {
  return {
    snapshot: snapshot ?? ({} as BillingIssuedSnapshotV1),
    customerTaxId: "514000000",
    accountingSoftwareNumber: 12345678,
    accessToken: "test-token",
    config: CONFIG,
  };
}

function spyBuilder(result: ApprovalPayloadBuildResult) {
  const calls: { n: number } = { n: 0 };
  const fn = (): ApprovalPayloadBuildResult => {
    calls.n += 1;
    return result;
  };
  return { fn, calls };
}

function spySend(resultOrError: ApprovalClientResult | Error) {
  const calls: { n: number } = { n: 0 };
  const fn = async (): Promise<ApprovalClientResult> => {
    calls.n += 1;
    if (resultOrError instanceof Error) throw resultOrError;
    return resultOrError;
  };
  return { fn, calls };
}

const success = (approved: boolean): ApprovalClientResult => ({
  kind: "success", httpStatus: 200,
  response: { status: 200, message: "Invoice approved", confirmation_number: "20240718181618323199093572", approved },
});
const validation400: ApprovalClientResult = {
  kind: "validation_error", httpStatus: 400, classification: "BUSINESS_VALIDATION",
  response: { status: 400, message: { errors: [{ code: 434, message: "old", param: "invoice_date", location: "request" }] }, confirmation_number: "0", approved: false },
};
const notAcceptable406: ApprovalClientResult = {
  kind: "not_acceptable", httpStatus: 406, classification: "BUSINESS_VALIDATION",
  response: { status: 406, message: "Not Acceptable", error_id: "id-1" },
};
const infraNetwork: ApprovalClientResult = {
  kind: "infrastructure_error", httpStatus: null, classification: "NETWORK", message: "Approval request failed to reach the authority", errorId: null,
};
const parseFailure: ApprovalClientResult = {
  kind: "infrastructure_error", httpStatus: 200, classification: "UNKNOWN", message: "Response body was not valid JSON", errorId: null,
};

function validSnapshot(): BillingIssuedSnapshotV1 {
  return {
    schemaVersion: 1, issuedAt: "2026-06-15T10:00:00.000Z",
    document: { id: 42, type: "TAX_INVOICE", status: "ISSUED", number: 7, numberFormatted: "000007", currency: "ILS", allocationNumber: null, referenceDocumentId: null },
    issuer: { id: 3, name: "דוביז", legalName: "דוביז", taxId: "515000123", vatRegistration: "515000123", address: null, phone: null, email: null, logoUrl: null, bankDetails: null },
    customer: { id: 7, name: "לקוח", legalName: null, taxId: null, phone: null, email: null, city: "תל אביב", address: null },
    lines: [{ lineIndex: 0, description: "שירות", quantity: "1.0000", unitPrice: "100.0000", vatRatePercent: "17.00", lineSubtotal: "100.00", vatAmount: "17.00", lineTotal: "117.00" }],
    totals: { subtotal: "100.00", vat: "17.00", total: "117.00" },
    tax: { currency: "ILS", defaultVatRate: null, vatMode: "EXCLUSIVE" },
    metadata: { locale: "he-IL", timezone: "Asia/Jerusalem", actorUserId: 1, source: "manual" },
    pdfTemplateStyle: "CLASSIC", extensions: {},
  };
}

async function main(): Promise<void> {
  // 1. Builder fails → local_validation_failed; client NOT called.
  {
    const b = spyBuilder({ ok: false, errors: [{ code: "MISSING_CUSTOMER_VAT_NUMBER", field: "customer_vat_number", message: "x" }] });
    const s = spySend(success(true));
    const deps: ApprovalOrchestratorDeps = { buildPayload: b.fn, sendApproval: s.fn };
    const r = await requestInvoiceApproval(baseInput(), deps);
    ok("builder fail → local_validation_failed", r.outcome === "local_validation_failed");
    ok("client NOT called on builder fail", s.calls.n === 0);
    ok("builder called exactly once (fail path)", b.calls.n === 1);
  }

  // 2. Builder succeeds → client called once; builder called once (not twice).
  {
    const b = spyBuilder({ ok: true, payload: VALID_PAYLOAD });
    const s = spySend(success(true));
    const deps: ApprovalOrchestratorDeps = { buildPayload: b.fn, sendApproval: s.fn };
    const r = await requestInvoiceApproval(baseInput(), deps);
    ok("builder success + 200 approved → approved", r.outcome === "approved" && r.confirmationNumber === "20240718181618323199093572");
    ok("builder called exactly once", b.calls.n === 1);
    ok("client called exactly once", s.calls.n === 1);
  }

  // 3. HTTP 200 approved:false → not_approved.
  {
    const deps: ApprovalOrchestratorDeps = { buildPayload: spyBuilder({ ok: true, payload: VALID_PAYLOAD }).fn, sendApproval: spySend(success(false)).fn };
    const r = await requestInvoiceApproval(baseInput(), deps);
    ok("200 approved:false → not_approved", r.outcome === "not_approved" && r.confirmationNumber === "20240718181618323199093572");
  }

  // 4. HTTP 400 → authority_validation_failed with errors.
  {
    const deps: ApprovalOrchestratorDeps = { buildPayload: spyBuilder({ ok: true, payload: VALID_PAYLOAD }).fn, sendApproval: spySend(validation400).fn };
    const r = await requestInvoiceApproval(baseInput(), deps);
    ok("400 → authority_validation_failed", r.outcome === "authority_validation_failed" && r.errors[0].code === 434 && r.errors[0].param === "invoice_date");
  }

  // 5. HTTP 406 → not_acceptable.
  {
    const deps: ApprovalOrchestratorDeps = { buildPayload: spyBuilder({ ok: true, payload: VALID_PAYLOAD }).fn, sendApproval: spySend(notAcceptable406).fn };
    const r = await requestInvoiceApproval(baseInput(), deps);
    ok("406 → not_acceptable", r.outcome === "not_acceptable" && r.errorId === "id-1");
  }

  // 6. Infrastructure error → infrastructure_failure (classification preserved).
  {
    const deps: ApprovalOrchestratorDeps = { buildPayload: spyBuilder({ ok: true, payload: VALID_PAYLOAD }).fn, sendApproval: spySend(infraNetwork).fn };
    const r = await requestInvoiceApproval(baseInput(), deps);
    ok("infra error → infrastructure_failure/NETWORK", r.outcome === "infrastructure_failure" && r.classification === "NETWORK");
  }

  // 7. Parser failure (client returned infra with UNKNOWN) → infrastructure_failure.
  {
    const deps: ApprovalOrchestratorDeps = { buildPayload: spyBuilder({ ok: true, payload: VALID_PAYLOAD }).fn, sendApproval: spySend(parseFailure).fn };
    const r = await requestInvoiceApproval(baseInput(), deps);
    ok("parser failure → infrastructure_failure/UNKNOWN", r.outcome === "infrastructure_failure" && r.classification === "UNKNOWN");
  }

  // 8. HTTP client throws → infrastructure_failure (defensive catch).
  {
    const deps: ApprovalOrchestratorDeps = { buildPayload: spyBuilder({ ok: true, payload: VALID_PAYLOAD }).fn, sendApproval: spySend(new Error("boom")).fn };
    const r = await requestInvoiceApproval(baseInput(), deps);
    ok("client throws → infrastructure_failure/UNKNOWN", r.outcome === "infrastructure_failure" && r.classification === "UNKNOWN" && r.message === "Approval client threw unexpectedly");
  }

  // 9. Integration: REAL builder + mock client (proves default-deps wiring path).
  {
    const s = spySend(success(true));
    const deps: ApprovalOrchestratorDeps = { buildPayload: buildInvoiceApprovalPayload, sendApproval: s.fn };
    const r = await requestInvoiceApproval(baseInput(validSnapshot()), deps);
    ok("real builder + 200 → approved", r.outcome === "approved");
    ok("real builder produced a payload → client called once", s.calls.n === 1);
  }
}

main()
  .then(() => {
    if (failed > 0) { console.error(`\n${failed} test(s) failed.`); process.exit(1); }
    console.log("\nAll approval orchestrator tests passed.");
  })
  .catch((error) => { console.error(error); process.exit(1); });
