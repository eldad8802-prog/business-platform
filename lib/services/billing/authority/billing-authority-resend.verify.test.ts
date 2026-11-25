/**
 * Gap A — resend eligibility (pure; no DB, no network). The rule admits only a
 * request that PROVABLY never reached the authority.
 *
 * Run: npx tsx lib/services/billing/authority/billing-authority-resend.verify.test.ts
 */
import { BillingAuthoritySubmissionStatus as S, BillingDocumentStatus } from "@prisma/client";
import {
  AUTHORITY_RESEND_NOT_ELIGIBLE_CODE,
  evaluateAuthorityResendEligibility,
  resendAuthorityApproval,
} from "@/lib/services/billing/authority/billing-authority-resend.service";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`OK: ${name}`);
  else {
    failed += 1;
    console.error(`FAIL: ${name}`, extra ?? "");
  }
}

type Sub = { id: number; status: S; authorityPayloadHash: string | null; errorCode: string | null; lastAttemptAt: Date | null };
const sub = (status: S, o: Partial<Sub> = {}): Sub => ({ id: 1, status, authorityPayloadHash: null, errorCode: null, lastAttemptAt: null, ...o });
const issued = (s: Sub | null) => ({ status: BillingDocumentStatus.ISSUED, submission: s });
const e = (s: Sub | null, status: BillingDocumentStatus = BillingDocumentStatus.ISSUED) => evaluateAuthorityResendEligibility({ status, submission: s });

// eligible
ok("READY never reserved → eligible (READY_NEVER_SENT)", (() => { const r = e(sub(S.READY)); return r.eligible && r.basis === "READY_NEVER_SENT"; })());
for (const code of ["AUTHORITY_NOT_SENT_CONFIGURATION", "AUTHORITY_NOT_SENT_NETWORK", "AUTHORITY_NOT_SENT_LOCAL_VALIDATION"]) {
  ok(`FAILED ${code} → eligible (FAILED_NOT_SENT)`, (() => { const r = e(sub(S.FAILED, { errorCode: code, authorityPayloadHash: "h", lastAttemptAt: new Date() })); return r.eligible && r.basis === "FAILED_NOT_SENT"; })());
}
// never eligible
const refused = (name: string, s: Sub | null, reason: string, docStatus: BillingDocumentStatus = BillingDocumentStatus.ISSUED) =>
  ok(name, (() => { const r = e(s, docStatus); return !r.eligible && r.reason === reason; })(), e(s, docStatus));
refused("READY with a payload hash (a reserve's trace) → INCONSISTENT_READY", sub(S.READY, { authorityPayloadHash: "h" }), "INCONSISTENT_READY");
refused("READY with an attempt time → INCONSISTENT_READY", sub(S.READY, { lastAttemptAt: new Date() }), "INCONSISTENT_READY");
refused("SUBMITTED (in flight) → refused", sub(S.SUBMITTED, { lastAttemptAt: new Date() }), "IN_FLIGHT_OR_UNCERTAIN");
refused("SUBMITTED + uncertain marker → refused", sub(S.SUBMITTED, { errorCode: "AUTHORITY_OUTCOME_UNCERTAIN_TIMEOUT" }), "IN_FLIGHT_OR_UNCERTAIN");
refused("PENDING → refused", sub(S.PENDING), "IN_FLIGHT_OR_UNCERTAIN");
refused("HELD → refused", sub(S.HELD), "HELD");
refused("REJECTED → refused", sub(S.REJECTED), "REJECTED");
refused("APPROVED → refused", sub(S.APPROVED), "APPROVED");
refused("NOT_REQUIRED → refused", sub(S.NOT_REQUIRED), "NOT_REQUIRED");
refused("FAILED with another code → refused", sub(S.FAILED, { errorCode: "LEGACY" }), "NOT_PROVABLY_UNSENT");
refused("FAILED with no code → refused", sub(S.FAILED), "NOT_PROVABLY_UNSENT");
refused("FAILED with an uncertain code → refused", sub(S.FAILED, { errorCode: "AUTHORITY_OUTCOME_UNCERTAIN_SERVER" }), "NOT_PROVABLY_UNSENT");
refused("no submission → refused", null, "NO_SUBMISSION");
refused("a draft → refused", sub(S.READY), "DOCUMENT_NOT_ISSUED", BillingDocumentStatus.DRAFT);

// the service refuses before executing anything
async function service(): Promise<void> {
  let executed = 0;
  const deps = (s: Sub | null) => ({
    loadDocumentWithSubmission: async () => ({ id: 7, businessId: 1, lockedAt: new Date(), legalSnapshotHash: "x", issuedSnapshot: null, ...issued(s) }) as never,
    executeApproval: async () => { executed++; return { outcome: "completed_approved", billingDocumentId: 7, submissionId: 1, allocationNumber: "202611240000000000000001", safeToRetry: false } as never; },
  });
  for (const [name, s] of [["uncertain", sub(S.SUBMITTED, { errorCode: "AUTHORITY_OUTCOME_UNCERTAIN_TIMEOUT" })], ["HELD", sub(S.HELD)], ["APPROVED", sub(S.APPROVED)]] as const) {
    const before = executed;
    let code: string | null = null;
    try { await resendAuthorityApproval({ businessId: 1, billingDocumentId: 7, actorUserId: 3 }, deps(s)); } catch (err) { code = (err as { code?: string }).code ?? null; }
    ok(`service: ${name} → 409 ${AUTHORITY_RESEND_NOT_ELIGIBLE_CODE}, execution never called`, code === AUTHORITY_RESEND_NOT_ELIGIBLE_CODE && executed === before);
  }
  const r = await resendAuthorityApproval({ businessId: 1, billingDocumentId: 7, actorUserId: 3 }, deps(sub(S.READY)));
  ok("service: READY never sent → executes once and maps the outcome", executed === 1 && r.basis === "READY_NEVER_SENT" && r.authority.status === "approved");
  let missing: string | null = null;
  try { await resendAuthorityApproval({ businessId: 1, billingDocumentId: 7, actorUserId: 3 }, { ...deps(null), loadDocumentWithSubmission: async () => null }); } catch (err) { missing = (err as Error).name; }
  ok("service: a document not found under the caller's tenant → NotFoundError, nothing executed", missing === "NotFoundError" && executed === 1);
  let bad: string | null = null;
  try { await resendAuthorityApproval({ businessId: 1, billingDocumentId: 0, actorUserId: 3 }, deps(sub(S.READY))); } catch (err) { bad = (err as Error).name; }
  ok("service: invalid id → ValidationError, nothing executed", bad === "ValidationError" && executed === 1);
}

service()
  .then(() => {
    console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
