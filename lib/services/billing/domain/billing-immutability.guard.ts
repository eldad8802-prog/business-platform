import { BillingDocumentStatus } from "@prisma/client";
import { ForbiddenError } from "@/lib/errors";

/**
 * Legal fields — frozen when status is ISSUED.
 * Source of truth for content: issuedSnapshot (not live profile/lines).
 */
export const ISSUED_LEGAL_FIELD_NAMES = [
  "status",
  "documentType",
  "documentNumber",
  "documentNumberFormatted",
  "issuedAt",
  "issuedByUserId",
  "issuedSnapshot",
  "lockedAt",
  "legalSnapshotHash",
  "referenceDocumentId",
  "customerId",
  "customerNameSnapshot",
  "subtotalAmount",
  "vatAmount",
  "totalAmount",
  "currency",
  "validUntil",
  "convertedToInvoiceId",
] as const;

/** Mutable on ISSUED documents — PDF pipeline and future authority rows (separate table). */
export const ISSUED_OPERATIONAL_FIELD_NAMES = [
  "pdfRenderStatus",
  "pdfTemplateVersion",
  "pdfStorageKey",
  "pdfHash",
  "pdfRenderedAt",
  "pdfRenderError",
] as const;

/** Editable only before ISSUED (draft / pending review). */
export const PRE_ISSUE_EDITABLE_FIELD_NAMES = [
  "customerId",
  "customerNameSnapshot",
  "validUntil",
  "subtotalAmount",
  "vatAmount",
  "totalAmount",
  "status",
] as const;

/** Issue transition: pre-issue → ISSUED (one-way). */
export const ISSUE_TRANSITION_FIELD_NAMES = [
  ...ISSUED_LEGAL_FIELD_NAMES,
  ...ISSUED_OPERATIONAL_FIELD_NAMES,
] as const;

export const QUOTE_NUMBER_FIELD_NAMES = [
  "documentNumber",
  "documentNumberFormatted",
] as const;

export const QUOTE_CONVERSION_FIELD_NAMES = ["convertedToInvoiceId"] as const;

export type IssuedLegalFieldName = (typeof ISSUED_LEGAL_FIELD_NAMES)[number];
export type IssuedOperationalFieldName =
  (typeof ISSUED_OPERATIONAL_FIELD_NAMES)[number];

export function getUpdateDataFieldKeys(
  data: Record<string, unknown>
): string[] {
  return Object.keys(data).filter(
    (key) => data[key] !== undefined
  );
}

export function assertCanMutateBillingLegalFields(
  status: BillingDocumentStatus
): void {
  if (status === BillingDocumentStatus.ISSUED) {
    throw new ForbiddenError("Issued billing documents are immutable");
  }
}

export function assertBillingDocumentLinesMutable(
  status: BillingDocumentStatus
): void {
  assertCanMutateBillingLegalFields(status);
}

export function assertIssuedMutationIsOperationalOnly(
  fields: Iterable<string>
): void {
  const allowed = new Set<string>(ISSUED_OPERATIONAL_FIELD_NAMES);
  const illegal = [...fields].filter((field) => !allowed.has(field));
  if (illegal.length > 0) {
    throw new ForbiddenError(
      `Issued billing documents only allow operational updates (${illegal.join(", ")})`
    );
  }
}

function assertOnlyAllowedFields(
  fields: Iterable<string>,
  allowed: readonly string[],
  context: string
): void {
  const allowedSet = new Set<string>(allowed);
  const illegal = [...fields].filter((field) => !allowedSet.has(field));
  if (illegal.length > 0) {
    throw new ForbiddenError(
      `${context}: disallowed field(s) ${illegal.join(", ")}`
    );
  }
}

export function assertPreIssueEditFields(fields: Iterable<string>): void {
  assertOnlyAllowedFields(
    fields,
    PRE_ISSUE_EDITABLE_FIELD_NAMES,
    "Pre-issue billing document edit"
  );
}

export function assertIssueTransitionFields(fields: Iterable<string>): void {
  assertOnlyAllowedFields(
    fields,
    ISSUE_TRANSITION_FIELD_NAMES,
    "Issue transition"
  );
}

export function assertQuoteNumberFields(fields: Iterable<string>): void {
  assertOnlyAllowedFields(
    fields,
    QUOTE_NUMBER_FIELD_NAMES,
    "Quote number allocation"
  );
}

export function assertQuoteConversionFields(fields: Iterable<string>): void {
  assertOnlyAllowedFields(
    fields,
    QUOTE_CONVERSION_FIELD_NAMES,
    "Quote conversion"
  );
}
