import {
  BillingAuthoritySubmissionStatus,
  BillingDocumentType,
  CustomerTaxIdType,
  Prisma,
} from "@prisma/client";
import { getAuthorityAllocationThresholdIls } from "@/lib/services/billing/authority/billing-authority-threshold";
import { AUTHORITY_ALLOCATION_REQUIREMENT } from "@/lib/services/billing/authority/billing-authority.types";

export type AuthorityReadinessInput = {
  documentType: BillingDocumentType;
  invoiceDate: Date;
  vatAmount: Prisma.Decimal;
  subtotalAmount: Prisma.Decimal;
  currency: string;
  customerTaxIdType: CustomerTaxIdType | string | null;
  customerTaxId: string | null;
};

function isLicensedDealerCustomer(input: AuthorityReadinessInput): boolean {
  const taxId = (input.customerTaxId ?? "").trim();
  if (taxId.length === 0) {
    return false;
  }
  return (
    input.customerTaxIdType === CustomerTaxIdType.AUTHORIZED_DEALER ||
    input.customerTaxIdType === CustomerTaxIdType.LTD_COMPANY
  );
}

/**
 * Pure issue-time readiness evaluation.
 * READY when all three knowable §1.2-style conditions are satisfied at issue.
 */
export function evaluateAuthorityReadinessAtIssue(
  input: AuthorityReadinessInput
): BillingAuthoritySubmissionStatus {
  // Single source of truth: only document types the official Table 2.5 marks as
  // requiring an allocation number ("CONDITIONAL") can ever be READY. Everything
  // else (CREDIT_NOTE 330, RECEIPT, QUOTE, …) is NOT_REQUIRED. This covers both
  // TAX_INVOICE (305) and TAX_INVOICE_RECEIPT (320) with identical conditions.
  const documentType = input.documentType as BillingDocumentType;
  if (AUTHORITY_ALLOCATION_REQUIREMENT[documentType] !== "CONDITIONAL") {
    return BillingAuthoritySubmissionStatus.NOT_REQUIRED;
  }

  const hasVat = input.vatAmount.greaterThan(0);
  const thresholdIls = getAuthorityAllocationThresholdIls(input.invoiceDate);
  const meetsThreshold =
    input.currency === "ILS" &&
    input.subtotalAmount.greaterThanOrEqualTo(new Prisma.Decimal(thresholdIls));
  const licensedDealerCustomer = isLicensedDealerCustomer(input);

  if (hasVat && meetsThreshold && licensedDealerCustomer) {
    return BillingAuthoritySubmissionStatus.READY;
  }

  return BillingAuthoritySubmissionStatus.NOT_REQUIRED;
}
