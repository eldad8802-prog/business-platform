/**
 * Authority readiness + threshold evaluation (run manually):
 *   npx tsx lib/services/billing/authority/billing-authority-readiness.test.ts
 */
import {
  BillingAuthoritySubmissionStatus,
  BillingDocumentType,
  CustomerTaxIdType,
  Prisma,
} from "@prisma/client";
import { evaluateAuthorityReadinessAtIssue } from "@/lib/services/billing/authority/billing-authority-readiness";
import {
  AUTHORITY_THRESHOLD_2024_AND_EARLIER_ILS,
  AUTHORITY_THRESHOLD_2025_ILS,
  AUTHORITY_THRESHOLD_2026_H1_ILS,
  AUTHORITY_THRESHOLD_2026_H2_AND_LATER_ILS,
  getAuthorityAllocationThresholdIls,
} from "@/lib/services/billing/authority/billing-authority-threshold";

let failed = 0;

function ok(name: string, condition: boolean) {
  if (!condition) {
    console.error("FAIL:", name);
    failed += 1;
    return;
  }
  console.log("OK:", name);
}

const dec = (value: string) => new Prisma.Decimal(value);

/** Midday UTC keeps the Jerusalem calendar date stable across DST. */
const invoiceDate = (ymd: string) => new Date(`${ymd}T10:00:00.000Z`);

const licensedDealerBase = {
  documentType: BillingDocumentType.TAX_INVOICE,
  vatAmount: dec("1700"),
  currency: "ILS" as const,
  customerTaxIdType: CustomerTaxIdType.AUTHORIZED_DEALER,
  customerTaxId: "514111111",
};

ok(
  "threshold helper: 25K through 2024-12-31",
  getAuthorityAllocationThresholdIls(invoiceDate("2024-12-31")) ===
    AUTHORITY_THRESHOLD_2024_AND_EARLIER_ILS
);

ok(
  "threshold helper: 20K from 2025-01-01",
  getAuthorityAllocationThresholdIls(invoiceDate("2025-01-01")) ===
    AUTHORITY_THRESHOLD_2025_ILS
);

ok(
  "threshold helper: 10K in early 2026",
  getAuthorityAllocationThresholdIls(invoiceDate("2026-03-15")) ===
    AUTHORITY_THRESHOLD_2026_H1_ILS
);

ok(
  "threshold helper: 5K from 2026-06-01",
  getAuthorityAllocationThresholdIls(invoiceDate("2026-06-01")) ===
    AUTHORITY_THRESHOLD_2026_H2_AND_LATER_ILS
);

ok(
  "CREDIT_NOTE is NOT_REQUIRED",
  evaluateAuthorityReadinessAtIssue({
    ...licensedDealerBase,
    documentType: BillingDocumentType.CREDIT_NOTE,
    invoiceDate: invoiceDate("2024-12-15"),
    subtotalAmount: dec("30000"),
  }) === BillingAuthoritySubmissionStatus.NOT_REQUIRED
);

ok(
  "TAX_INVOICE at 25K subtotal in 2024 is READY",
  evaluateAuthorityReadinessAtIssue({
    ...licensedDealerBase,
    invoiceDate: invoiceDate("2024-12-15"),
    subtotalAmount: dec("25000"),
  }) === BillingAuthoritySubmissionStatus.READY
);

ok(
  "TAX_INVOICE at 20K subtotal in 2025 is READY",
  evaluateAuthorityReadinessAtIssue({
    ...licensedDealerBase,
    invoiceDate: invoiceDate("2025-06-15"),
    subtotalAmount: dec("20000"),
  }) === BillingAuthoritySubmissionStatus.READY
);

ok(
  "TAX_INVOICE at 10K subtotal in early 2026 is READY",
  evaluateAuthorityReadinessAtIssue({
    ...licensedDealerBase,
    invoiceDate: invoiceDate("2026-03-15"),
    subtotalAmount: dec("10000"),
  }) === BillingAuthoritySubmissionStatus.READY
);

ok(
  "TAX_INVOICE at 5K subtotal from June 2026 is READY",
  evaluateAuthorityReadinessAtIssue({
    ...licensedDealerBase,
    invoiceDate: invoiceDate("2026-06-15"),
    subtotalAmount: dec("5000"),
  }) === BillingAuthoritySubmissionStatus.READY
);

ok(
  "total above threshold but subtotal below stays NOT_REQUIRED",
  evaluateAuthorityReadinessAtIssue({
    ...licensedDealerBase,
    invoiceDate: invoiceDate("2024-12-15"),
    subtotalAmount: dec("24000"),
    vatAmount: dec("6000"),
  }) === BillingAuthoritySubmissionStatus.NOT_REQUIRED
);

ok(
  "TAX_INVOICE without licensed dealer customer is NOT_REQUIRED",
  evaluateAuthorityReadinessAtIssue({
    ...licensedDealerBase,
    invoiceDate: invoiceDate("2024-12-15"),
    subtotalAmount: dec("30000"),
    customerTaxIdType: CustomerTaxIdType.PRIVATE_ID,
    customerTaxId: "123456789",
  }) === BillingAuthoritySubmissionStatus.NOT_REQUIRED
);

ok(
  "TAX_INVOICE below threshold stays NOT_REQUIRED",
  evaluateAuthorityReadinessAtIssue({
    ...licensedDealerBase,
    invoiceDate: invoiceDate("2024-12-15"),
    subtotalAmount: dec("1000"),
    vatAmount: dec("17"),
  }) === BillingAuthoritySubmissionStatus.NOT_REQUIRED
);

ok(
  "TAX_INVOICE without VAT stays NOT_REQUIRED",
  evaluateAuthorityReadinessAtIssue({
    ...licensedDealerBase,
    invoiceDate: invoiceDate("2024-12-15"),
    subtotalAmount: dec("30000"),
    vatAmount: dec("0"),
  }) === BillingAuthoritySubmissionStatus.NOT_REQUIRED
);

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}

console.log("\nAll billing authority readiness checks passed.");
