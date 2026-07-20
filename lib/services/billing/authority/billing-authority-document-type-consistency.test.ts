/**
 * Single-source-of-truth consistency for authority document-type classification
 * (run manually):
 *   npx tsx lib/services/billing/authority/billing-authority-document-type-consistency.test.ts
 *
 * Guards that the four places a document type is classified for allocation all
 * agree with AUTHORITY_ALLOCATION_REQUIREMENT (Table 2.5, v2.0/7.2024):
 *   1. AUTHORITY_ALLOCATION_REQUIREMENT  (the source of truth)
 *   2. AUTHORITY_ELIGIBLE_DOCUMENT_TYPES (which types create a gated submission)
 *   3. evaluateAuthorityReadinessAtIssue (readiness can be READY only for eligible)
 *   4. APPROVAL_DOCUMENT_TYPE_CODE       (HsbSug code map used to submit)
 */
import {
  BillingAuthoritySubmissionStatus,
  BillingDocumentType,
  CustomerTaxIdType,
  Prisma,
} from "@prisma/client";
import {
  AUTHORITY_ALLOCATION_REQUIREMENT,
  AUTHORITY_ELIGIBLE_DOCUMENT_TYPES,
} from "@/lib/services/billing/authority/billing-authority.types";
import { isAuthorityEligibleDocumentType } from "@/lib/services/billing/authority/billing-authority.service";
import { evaluateAuthorityReadinessAtIssue } from "@/lib/services/billing/authority/billing-authority-readiness";
import { APPROVAL_DOCUMENT_TYPE_CODE } from "@/lib/services/billing/authority/billing-authority-approval-payload";

let failed = 0;
function ok(name: string, cond: boolean): void {
  if (cond) console.log("OK:", name);
  else {
    failed += 1;
    console.error("FAIL:", name);
  }
}

const allTypes = Object.values(BillingDocumentType);
const conditionalTypes = allTypes.filter(
  (t) => AUTHORITY_ALLOCATION_REQUIREMENT[t] === "CONDITIONAL"
);

// ---- 1. The source of truth reflects Table 2.5 exactly -----------------------
ok("305 TAX_INVOICE → CONDITIONAL", AUTHORITY_ALLOCATION_REQUIREMENT.TAX_INVOICE === "CONDITIONAL");
ok("320 TAX_INVOICE_RECEIPT → CONDITIONAL", AUTHORITY_ALLOCATION_REQUIREMENT.TAX_INVOICE_RECEIPT === "CONDITIONAL");
ok("330 CREDIT_NOTE → NOT_REQUIRED", AUTHORITY_ALLOCATION_REQUIREMENT.CREDIT_NOTE === "NOT_REQUIRED");
ok("RECEIPT → NOT_REQUIRED", AUTHORITY_ALLOCATION_REQUIREMENT.RECEIPT === "NOT_REQUIRED");
ok("QUOTE → NOT_REQUIRED", AUTHORITY_ALLOCATION_REQUIREMENT.QUOTE === "NOT_REQUIRED");

// ---- 2. Eligible list == exactly the CONDITIONAL types -----------------------
ok(
  "eligible list == CONDITIONAL types",
  JSON.stringify([...AUTHORITY_ELIGIBLE_DOCUMENT_TYPES].sort()) ===
    JSON.stringify([...conditionalTypes].sort())
);
for (const t of allTypes) {
  ok(
    `isAuthorityEligibleDocumentType(${t}) matches requirement`,
    isAuthorityEligibleDocumentType(t) === (AUTHORITY_ALLOCATION_REQUIREMENT[t] === "CONDITIONAL")
  );
}

// ---- 3. Readiness can be READY ONLY for CONDITIONAL types --------------------
// A fully-qualifying context (VAT, threshold, licensed dealer) → READY iff CONDITIONAL.
for (const t of allTypes) {
  const status = evaluateAuthorityReadinessAtIssue({
    documentType: t,
    invoiceDate: new Date("2026-06-15T10:00:00.000Z"),
    vatAmount: new Prisma.Decimal("1700"),
    subtotalAmount: new Prisma.Decimal("30000"),
    currency: "ILS",
    customerTaxIdType: CustomerTaxIdType.AUTHORIZED_DEALER,
    customerTaxId: "514111111",
  });
  const expectReady = AUTHORITY_ALLOCATION_REQUIREMENT[t] === "CONDITIONAL";
  ok(
    `readiness(${t}) qualifying → ${expectReady ? "READY" : "NOT_REQUIRED"}`,
    status ===
      (expectReady
        ? BillingAuthoritySubmissionStatus.READY
        : BillingAuthoritySubmissionStatus.NOT_REQUIRED)
  );
}

// ---- 4. Approval HsbSug code map covers EXACTLY the CONDITIONAL types --------
const codeMapKeys = Object.keys(APPROVAL_DOCUMENT_TYPE_CODE).sort();
ok(
  "approval code map keys == CONDITIONAL types",
  JSON.stringify(codeMapKeys) === JSON.stringify([...conditionalTypes].sort())
);
ok("CREDIT_NOTE has no approval code (330 = No)", APPROVAL_DOCUMENT_TYPE_CODE.CREDIT_NOTE === undefined);
ok("TAX_INVOICE → 305", APPROVAL_DOCUMENT_TYPE_CODE.TAX_INVOICE === 305);
ok("TAX_INVOICE_RECEIPT → 320", APPROVAL_DOCUMENT_TYPE_CODE.TAX_INVOICE_RECEIPT === 320);

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log("\nAll authority document-type consistency checks passed.");
