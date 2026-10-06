/**
 * Unit tests for the Submission Execution Service (run manually):
 *   npx tsx lib/services/billing/authority/billing-authority-submission-execution.service.test.ts
 *
 * Fully injected: no DB, no network, no env. Deterministic.
 */
import {
  BillingAuthorityEnvironment,
  BillingAuthoritySubmissionStatus,
  BillingDocumentStatus,
} from "@prisma/client";
import { AuthorityConditionalUpdateMissedError } from "@/lib/services/billing/authority/billing-authority-transition.service";
import type { ApprovalDomainResult } from "@/lib/services/billing/authority/billing-authority-approval-orchestrator";
import type { ApprovalPayloadBuildResult } from "@/lib/services/billing/authority/billing-authority-approval-payload";
import type { RuntimeContextResult } from "@/lib/services/billing/authority/billing-authority-approval-runtime-context.provider";
import type { InvoiceApprovalRequest } from "@/lib/services/billing/authority/billing-authority-approval.types";
import {
  executeAuthorityApproval,
  type ExecutionResult,
  type LoadedDocumentSubmission,
  type SubmissionExecutionDeps,
} from "@/lib/services/billing/authority/billing-authority-submission-execution.service";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`OK: ${name}`);
  else { failed += 1; console.error(`FAIL: ${name}`, extra ?? ""); }
}

const ENV = BillingAuthorityEnvironment.SANDBOX;
const IN = { businessId: 3, billingDocumentId: 42, actorUserId: 1 };

function snapshot() {
  return {
    schemaVersion: 1, issuedAt: "2026-06-15T10:00:00.000Z",
    document: { id: 42, type: "TAX_INVOICE", status: "ISSUED", number: 7, numberFormatted: "000007", currency: "ILS", allocationNumber: null, referenceDocumentId: null },
    issuer: { id: 3, name: "דוביז", legalName: "דוביז", taxId: "515000123", vatRegistration: "515000123", address: null, phone: null, email: null, logoUrl: null, bankDetails: null },
    customer: { id: 7, name: "לקוח", legalName: null, taxId: "514000000", phone: null, email: null, city: "תל אביב", address: null },
    lines: [{ lineIndex: 0, description: "שירות", quantity: "1.0000", unitPrice: "100.0000", vatRatePercent: "17.00", lineSubtotal: "100.00", vatAmount: "17.00", lineTotal: "117.00" }],
    totals: { subtotal: "100.00", vat: "17.00", total: "117.00" },
    tax: { currency: "ILS", defaultVatRate: null, vatMode: "EXCLUSIVE" },
    metadata: { locale: "he-IL", timezone: "Asia/Jerusalem", actorUserId: 1, source: "manual" },
    pdfTemplateStyle: "CLASSIC", extensions: {},
  };
}

function loaded(over: { status?: BillingAuthoritySubmissionStatus; payloadHash?: string | null; docStatus?: BillingDocumentStatus; lockedAt?: Date | null; legalHash?: string | null; submission?: null; errorCode?: string | null } = {}): LoadedDocumentSubmission {
  return {
    id: 42, businessId: 3,
    status: over.docStatus ?? BillingDocumentStatus.ISSUED,
    lockedAt: over.lockedAt === undefined ? new Date("2026-06-15T10:00:00Z") : over.lockedAt,
    legalSnapshotHash: over.legalHash === undefined ? "legal-hash" : over.legalHash,
    issuedSnapshot: snapshot() as unknown as LoadedDocumentSubmission["issuedSnapshot"],
    submission: over.submission === null ? null : { id: 55, status: over.status ?? BillingAuthoritySubmissionStatus.READY, authorityPayloadHash: over.payloadHash ?? null, errorCode: over.errorCode ?? null, lastAttemptAt: null },
  };
}

const VALID_PAYLOAD: InvoiceApprovalRequest = {
  invoice_id: "42", invoice_type: 305, vat_number: 515000123, invoice_reference_number: "000007",
  customer_vat_number: 514000000, invoice_date: "2026-06-15", invoice_issuance_date: "2026-06-15",
  accounting_software_number: 12345678, amount_before_discount: 100, discount: 0, payment_amount: 100,
  vat_amount: 17, payment_amount_including_vat: 117,
};

function okCtx(accounting = "12345678", apiBaseUrl = "https://x/shaam/tsandbox"): RuntimeContextResult {
  return { ok: true, context: { accessToken: "SECRET_TOKEN", approvalConfig: { apiBaseUrl, apiVersion: "v2", timeoutMs: 15000 }, accountingSoftwareNumber: accounting, connectionId: 5, environment: ENV } };
}

type Spies = { load: number; ctx: number; forceRefresh: number; build: number; approve: number; recordAttempt: number; recordApproved: number; recordRejected: number; recordFailed: number; recordHeld: number; recordUncertain: number; safetyEvents: number };
type Cfg = {
  loaded?: LoadedDocumentSubmission | null;
  reloaded?: LoadedDocumentSubmission | null;
  context?: RuntimeContextResult;
  context2?: RuntimeContextResult;
  build?: ApprovalPayloadBuildResult;
  approvals?: ApprovalDomainResult[];
  attemptThrows?: Error;
  approvedThrows?: Error;
  env?: () => BillingAuthorityEnvironment;
};
function makeDeps(cfg: Cfg): { deps: SubmissionExecutionDeps; spies: Spies } {
  const spies: Spies = { load: 0, ctx: 0, forceRefresh: 0, build: 0, approve: 0, recordAttempt: 0, recordApproved: 0, recordRejected: 0, recordFailed: 0, recordHeld: 0, recordUncertain: 0, safetyEvents: 0 };
  const approvals = cfg.approvals ?? [{ outcome: "approved", confirmationNumber: "20240718181618323199093572" }];
  const deps: SubmissionExecutionDeps = {
    loadDocumentWithSubmission: async () => { spies.load += 1; return spies.load === 1 ? (cfg.loaded === undefined ? loaded() : cfg.loaded) : (cfg.reloaded === undefined ? (cfg.loaded === undefined ? loaded() : cfg.loaded) : cfg.reloaded); },
    resolveEnvironment: cfg.env ?? (() => ENV),
    resolveRuntimeContext: async (input) => { spies.ctx += 1; if (input.forceRefresh) { spies.forceRefresh += 1; return cfg.context2 ?? okCtx(); } return cfg.context ?? okCtx(); },
    buildPayload: () => { spies.build += 1; return cfg.build ?? { ok: true, payload: VALID_PAYLOAD }; },
    requestApproval: async () => { spies.approve += 1; return approvals[Math.min(spies.approve - 1, approvals.length - 1)]; },
    hashPayload: () => "HASH",
    now: () => new Date("2026-06-15T10:00:00.000Z"),
    // W4E-B-2: the port now carries the trusted tenant, so the double takes
    // (businessId, fn) — the businessId is unused here because there is no DB.
    runInTransaction: (_businessId: number, fn: (tx: never) => unknown) =>
      fn({} as never),
    recordAttempt: async () => { spies.recordAttempt += 1; if (cfg.attemptThrows) throw cfg.attemptThrows; return { submission: { id: 55 } }; },
    recordApproved: async () => { spies.recordApproved += 1; if (cfg.approvedThrows) throw cfg.approvedThrows; return {}; },
    recordRejected: async () => { spies.recordRejected += 1; return {}; },
    recordFailed: async () => { spies.recordFailed += 1; return {}; },
    recordHeld: async () => { spies.recordHeld += 1; return {}; },
    recordOutcomeUncertain: async () => { spies.recordUncertain += 1; return {}; },
    reportSafetyEvent: () => { spies.safetyEvents += 1; },
  };
  return { deps, spies };
}

function noToken(r: ExecutionResult): boolean {
  return !JSON.stringify(r).includes("SECRET_TOKEN");
}

async function main(): Promise<void> {
  // ---- Happy ----
  {
    const { deps, spies } = makeDeps({});
    const r = await executeAuthorityApproval(IN, deps);
    ok("happy → completed_approved", r.outcome === "completed_approved" && r.outcome === "completed_approved" && r.allocationNumber === "20240718181618323199093572");
    ok("reserve before HTTP + one attempt + approved recorded", spies.recordAttempt === 1 && spies.approve === 1 && spies.recordApproved === 1);
    ok("no token in result", noToken(r));
  }
  { const { deps } = makeDeps({ loaded: loaded({ status: BillingAuthoritySubmissionStatus.FAILED, errorCode: "AUTHORITY_NOT_SENT_NETWORK" }) }); const r = await executeAuthorityApproval(IN, deps); ok("FAILED(not-sent) → approved", r.outcome === "completed_approved"); }
  { const { deps, spies } = makeDeps({ loaded: loaded({ status: BillingAuthoritySubmissionStatus.FAILED, errorCode: "AUTHORITY_NETWORK" }) }); const r = await executeAuthorityApproval(IN, deps); ok("FAILED(legacy possibly-sent) → not executable, no reserve/HTTP", r.outcome === "preflight_failed" && r.errorCode === "SUBMISSION_NOT_PROVABLY_UNSENT" && r.safeToRetry === false && spies.recordAttempt === 0 && spies.approve === 0); }
  { const { deps, spies } = makeDeps({ loaded: loaded({ status: BillingAuthoritySubmissionStatus.SUBMITTED, errorCode: "AUTHORITY_OUTCOME_UNCERTAIN_TIMEOUT" }) }); const r = await executeAuthorityApproval(IN, deps); ok("SUBMITTED(uncertain) → outcome_uncertain, no HTTP", r.outcome === "outcome_uncertain" && r.safeToRetry === false && spies.approve === 0 && spies.recordAttempt === 0); }

  // ---- Statuses (no HTTP) ----
  { const { deps, spies } = makeDeps({ loaded: loaded({ status: BillingAuthoritySubmissionStatus.SUBMITTED }) }); const r = await executeAuthorityApproval(IN, deps); ok("SUBMITTED → in_progress, no HTTP", r.outcome === "in_progress" && spies.approve === 0 && spies.recordAttempt === 0); }
  { const { deps } = makeDeps({ loaded: loaded({ status: BillingAuthoritySubmissionStatus.APPROVED }) }); const r = await executeAuthorityApproval(IN, deps); ok("APPROVED → already_processed", r.outcome === "already_processed"); }
  { const { deps } = makeDeps({ loaded: loaded({ status: BillingAuthoritySubmissionStatus.REJECTED }) }); const r = await executeAuthorityApproval(IN, deps); ok("REJECTED → already_processed", r.outcome === "already_processed"); }
  { const { deps } = makeDeps({ loaded: loaded({ status: BillingAuthoritySubmissionStatus.NOT_REQUIRED }) }); const r = await executeAuthorityApproval(IN, deps); ok("NOT_REQUIRED → preflight_failed", r.outcome === "preflight_failed"); }
  { const { deps } = makeDeps({ loaded: loaded({ submission: null }) }); const r = await executeAuthorityApproval(IN, deps); ok("no submission → preflight_failed", r.outcome === "preflight_failed" && r.outcome === "preflight_failed" && r.errorCode === "SUBMISSION_MISSING"); }
  { const { deps } = makeDeps({ loaded: null }); const r = await executeAuthorityApproval(IN, deps); ok("other business/not found → preflight_failed", r.outcome === "preflight_failed"); }
  { const { deps } = makeDeps({ loaded: loaded({ docStatus: BillingDocumentStatus.DRAFT }) }); const r = await executeAuthorityApproval(IN, deps); ok("not ISSUED → preflight_failed", r.outcome === "preflight_failed"); }
  { const { deps } = makeDeps({ loaded: loaded({ lockedAt: null }) }); const r = await executeAuthorityApproval(IN, deps); ok("not locked → preflight_failed", r.outcome === "preflight_failed"); }

  // ---- Pre-flight (no reserve, no HTTP) ----
  { const { deps } = makeDeps({ loaded: loaded({ legalHash: null }) }); const r = await executeAuthorityApproval(IN, deps); ok("legal hash missing → preflight", r.outcome === "preflight_failed" && r.outcome === "preflight_failed" && r.errorCode === "LEGAL_HASH_MISSING"); }
  { const { deps, spies } = makeDeps({ context: { ok: false, code: "TOKEN_REFRESH_FAILED", message: "x" } }); const r = await executeAuthorityApproval(IN, deps); ok("runtime context fail → preflight, no reserve/HTTP", r.outcome === "preflight_failed" && spies.recordAttempt === 0 && spies.approve === 0); }
  { const { deps, spies } = makeDeps({ build: { ok: false, errors: [{ code: "MISSING_CUSTOMER_VAT_NUMBER", field: "customer_vat_number", message: "x" }] } }); const r = await executeAuthorityApproval(IN, deps); ok("builder fail → local_validation_failed, no reserve/HTTP", r.outcome === "local_validation_failed" && spies.recordAttempt === 0 && spies.approve === 0); }
  { const { deps, spies } = makeDeps({ loaded: loaded({ payloadHash: "OTHER" }) }); const r = await executeAuthorityApproval(IN, deps); ok("payload hash mismatch → preflight, no reserve/HTTP", r.outcome === "preflight_failed" && r.outcome === "preflight_failed" && r.errorCode === "AUTHORITY_PAYLOAD_HASH_MISMATCH" && spies.recordAttempt === 0 && spies.approve === 0); }

  // ---- Authority outcomes ----
  { const { deps, spies } = makeDeps({ approvals: [{ outcome: "authority_validation_failed", errors: [{ code: 434, message: "old", param: "invoice_date", location: "request" }] }] }); const r = await executeAuthorityApproval(IN, deps); ok("400 → completed_rejected", r.outcome === "completed_rejected" && spies.recordRejected === 1); }
  { const { deps, spies } = makeDeps({ approvals: [{ outcome: "not_acceptable", errorId: "id", message: "Not Acceptable" }] }); const r = await executeAuthorityApproval(IN, deps); ok("406 → outcome_uncertain (not FAILED)", r.outcome === "outcome_uncertain" && r.errorCode === "AUTHORITY_OUTCOME_UNCERTAIN_NOT_ACCEPTABLE" && spies.recordUncertain === 1 && spies.recordFailed === 0); }
  { const { deps, spies } = makeDeps({ approvals: [{ outcome: "infrastructure_failure", classification: "NETWORK", message: "x", sendCertainty: "POSSIBLY_SENT", failureKind: "TRANSPORT", providerHttpStatus: null, providerErrorId: null, transportCode: "ECONNRESET" }] }); const r = await executeAuthorityApproval(IN, deps); ok("possibly-sent network → outcome_uncertain, NOT retryable, not FAILED", r.outcome === "outcome_uncertain" && r.safeToRetry === false && spies.recordFailed === 0 && spies.recordUncertain === 1); }
  { const { deps, spies } = makeDeps({ approvals: [{ outcome: "infrastructure_failure", classification: "NETWORK", message: "x", sendCertainty: "NOT_SENT", failureKind: "TRANSPORT", providerHttpStatus: null, providerErrorId: null, transportCode: "ECONNREFUSED" }] }); const r = await executeAuthorityApproval(IN, deps); ok("not-sent network → infrastructure_failed retryable, FAILED", r.outcome === "infrastructure_failed" && r.safeToRetry === true && r.errorCode === "AUTHORITY_NOT_SENT_NETWORK" && spies.recordFailed === 1); }
  { const { deps, spies } = makeDeps({ approvals: [{ outcome: "infrastructure_failure", classification: "TIMEOUT", message: "x", sendCertainty: "POSSIBLY_SENT", failureKind: "TRANSPORT", providerHttpStatus: null, providerErrorId: null, transportCode: null }] }); const r = await executeAuthorityApproval(IN, deps); ok("timeout → outcome_uncertain TIMEOUT", r.outcome === "outcome_uncertain" && r.errorCode === "AUTHORITY_OUTCOME_UNCERTAIN_TIMEOUT" && spies.recordFailed === 0); }
  { const { deps, spies } = makeDeps({ approvedThrows: new Error("db down") }); const r = await executeAuthorityApproval(IN, deps); ok("approved + persist failure → outcome_uncertain APPROVED_PERSIST_FAILED (not FAILED)", r.outcome === "outcome_uncertain" && r.errorCode === "AUTHORITY_OUTCOME_UNCERTAIN_APPROVED_PERSIST_FAILED" && spies.recordUncertain === 1 && spies.recordFailed === 0 && spies.safetyEvents === 1); }
  { const { deps, spies } = makeDeps({ approvals: [{ outcome: "not_approved_unknown", confirmationNumber: "0", message: "m" }] }); const r = await executeAuthorityApproval(IN, deps); ok("not_approved_unknown → outcome_uncertain, not FAILED/HELD", r.outcome === "outcome_uncertain" && r.errorCode === "AUTHORITY_OUTCOME_UNCERTAIN_NOT_APPROVED_AMBIGUOUS" && spies.recordUncertain === 1 && spies.recordFailed === 0 && spies.recordHeld === 0); }
  { const { deps, spies } = makeDeps({ approvals: [{ outcome: "decision_required", code: 460, confirmationNumber: "0", message: "not approved" }] }); const r = await executeAuthorityApproval(IN, deps); ok("460 → decision_required, persisted HELD once (recordHeld=1), no FAILED/REJECTED", r.outcome === "decision_required" && r.outcome === "decision_required" && r.code === 460 && r.errorCode === "AUTHORITY_DECISION_REQUIRED_460" && r.userActionRequired === true && spies.recordHeld === 1 && spies.recordFailed === 0 && spies.recordRejected === 0); }
  { const { deps, spies } = makeDeps({ approvals: [{ outcome: "decision_required", code: 461, confirmationNumber: "0", message: "not approved" }] }); const r = await executeAuthorityApproval(IN, deps); ok("461 → decision_required, persisted HELD once (recordHeld=1)", r.outcome === "decision_required" && r.outcome === "decision_required" && r.code === 461 && spies.recordHeld === 1 && spies.recordFailed === 0); }
  { const { deps, spies } = makeDeps({ approvals: [{ outcome: "decision_already_reported", code: 462, confirmationNumber: "0", message: "already" }] }); const r = await executeAuthorityApproval(IN, deps); ok("462 → decision_already_reported, marked uncertain (no recordHeld/recordFailed)", r.outcome === "decision_already_reported" && spies.recordHeld === 0 && spies.recordFailed === 0 && spies.recordUncertain === 1); }

  // ---- 401: no forced refresh + re-POST (processing not proven) ----
  {
    const { deps, spies } = makeDeps({ approvals: [{ outcome: "infrastructure_failure", classification: "AUTHENTICATION", message: "x", sendCertainty: "POSSIBLY_SENT", failureKind: "HTTP_STATUS", providerHttpStatus: 401, providerErrorId: null, transportCode: null }, { outcome: "approved", confirmationNumber: "20240718181618323199093572" }] });
    const r = await executeAuthorityApproval(IN, deps);
    ok("401 → exactly ONE Approval POST, no forceRefresh, outcome_uncertain AUTHENTICATION", r.outcome === "outcome_uncertain" && r.errorCode === "AUTHORITY_OUTCOME_UNCERTAIN_AUTHENTICATION" && spies.approve === 1 && spies.forceRefresh === 0 && spies.recordFailed === 0);
  }

  // ---- Concurrency ----
  {
    const { deps, spies } = makeDeps({ attemptThrows: new AuthorityConditionalUpdateMissedError(), reloaded: loaded({ status: BillingAuthoritySubmissionStatus.SUBMITTED }) });
    const r = await executeAuthorityApproval(IN, deps);
    ok("reserve loses race → in_progress, no HTTP", r.outcome === "in_progress" && spies.approve === 0);
  }

  // ---- Security ----
  {
    const { deps } = makeDeps({ context: { ok: false, code: "AUTHENTICATION", message: "SECRET_TOKEN should never appear" } });
    const r = await executeAuthorityApproval(IN, deps);
    ok("no token leak even when message contains it (result carries only code)", r.outcome === "preflight_failed" && r.outcome === "preflight_failed" && r.errorCode === "AUTHENTICATION" && noToken(r));
  }
}

main()
  .then(() => { if (failed > 0) { console.error(`\n${failed} test(s) failed.`); process.exit(1); } console.log("\nAll submission execution service tests passed."); })
  .catch((e) => { console.error(e); process.exit(1); });
