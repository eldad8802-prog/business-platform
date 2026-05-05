import type { DocumentType } from "./document-type.service";

export type DocumentOutputProfileId =
  | "financial_transaction"
  | "tax_or_pension_document"
  | "quote_or_order"
  | "non_financial"
  | "unknown_review";

export type OutputReviewMode =
  | "full_financial"
  | "structured_document"
  | "quote_flow"
  | "non_financial"
  | "unknown";

export type DocumentOutputProfile = {
  profileId: DocumentOutputProfileId;
  primaryFields: string[];
  secondaryFields: string[];
  hiddenFields: string[];
  reviewMode: OutputReviewMode;
};

const TAX_PENSION_TEXT_MARKERS = [
  "אישור מס",
  "הצהרת הון",
  "קרן פנסיה",
  "פנסיה מקיפה",
  "הפקדה לקצבה",
  "פקודת מס הכנסה",
  "תיק ניכויים",
  "ניכוי מס במקור",
  "אישור מס על",
  "שנת המס",
];

const QUOTE_TEXT_MARKERS = ["הצעת מחיר", "הזמנת מחיר", "הצעה מחיר"];

function normalizeForScan(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function hasAnyMarker(text: string, markers: string[]): boolean {
  const lower = normalizeForScan(text);
  return markers.some((m) => lower.includes(m.toLowerCase()));
}

function isQuoteLike(
  documentType: DocumentType,
  text: string
): boolean {
  if (documentType === "quote") return true;
  return hasAnyMarker(text, QUOTE_TEXT_MARKERS);
}

function isTaxOrPensionLike(text: string): boolean {
  return hasAnyMarker(text, TAX_PENSION_TEXT_MARKERS);
}

function isRetailFinancialDocTypes(t: DocumentType): boolean {
  return (
    t === "receipt" ||
    t === "invoice" ||
    t === "donation_receipt" ||
    t === "bank_transfer"
  );
}

const PROFILE_LAYOUT: Record<
  DocumentOutputProfileId,
  Omit<DocumentOutputProfile, "profileId">
> = {
  financial_transaction: {
    primaryFields: [
      "amount",
      "vendorName",
      "date",
      "category",
      "direction",
      "documentType",
      "needsReview",
    ],
    secondaryFields: [
      "amountConfidence",
      "vendorConfidence",
      "dateConfidence",
      "categoryConfidence",
      "confidence",
      "financialEvidenceLevel",
      "amountEligible",
      "evidenceReasons",
      "guardrailRoute",
      "isFinancial",
    ],
    hiddenFields: [],
    reviewMode: "full_financial",
  },
  tax_or_pension_document: {
    primaryFields: [
      "documentType",
      "category",
      "vendorName",
      "needsReview",
      "date",
    ],
    secondaryFields: [
      "confidence",
      "categoryConfidence",
      "financialEvidenceLevel",
      "evidenceReasons",
      "guardrailRoute",
      "isFinancial",
    ],
    hiddenFields: ["direction", "amount"],
    reviewMode: "structured_document",
  },
  quote_or_order: {
    primaryFields: [
      "amount",
      "vendorName",
      "date",
      "category",
      "documentType",
      "needsReview",
    ],
    secondaryFields: [
      "direction",
      "amountConfidence",
      "vendorConfidence",
      "dateConfidence",
      "categoryConfidence",
      "confidence",
      "financialEvidenceLevel",
      "amountEligible",
      "evidenceReasons",
    ],
    hiddenFields: [],
    reviewMode: "quote_flow",
  },
  non_financial: {
    primaryFields: ["documentType", "needsReview", "category"],
    secondaryFields: ["confidence", "guardrailRoute"],
    hiddenFields: [
      "amount",
      "vendorName",
      "date",
      "direction",
      "amountEligible",
      "financialEvidenceLevel",
    ],
    reviewMode: "non_financial",
  },
  unknown_review: {
    primaryFields: [
      "documentType",
      "needsReview",
      "category",
      "vendorName",
      "confidence",
    ],
    secondaryFields: [
      "amount",
      "date",
      "direction",
      "financialEvidenceLevel",
      "amountEligible",
      "evidenceReasons",
      "guardrailRoute",
      "isFinancial",
      "amountConfidence",
      "vendorConfidence",
      "dateConfidence",
      "categoryConfidence",
    ],
    hiddenFields: [],
    reviewMode: "unknown",
  },
};

/** Subset of unified intelligence — avoids circular imports with unified-extraction-engine. */
export type DocumentOutputProfileSource = {
  documentType: DocumentType;
  isFinancial: boolean;
  guardrailRoute: string;
  searchableText: string;
  needsReview: boolean;
  confidence: number;
  financialEvidenceLevel:
    | "strong"
    | "weak"
    | "negative"
    | "uncertain";
};

function resolveProfileId(source: DocumentOutputProfileSource): DocumentOutputProfileId {
  const { documentType, isFinancial, searchableText } = source;

  if (!isFinancial || documentType === "non_financial") {
    return "non_financial";
  }

  if (isTaxOrPensionLike(searchableText)) {
    if (
      source.needsReview &&
      source.confidence < 0.25 &&
      source.financialEvidenceLevel !== "strong"
    ) {
      return "unknown_review";
    }
    return "tax_or_pension_document";
  }

  if (isQuoteLike(documentType, searchableText)) {
    return "quote_or_order";
  }

  if (
    source.guardrailRoute === "financial_transaction" &&
    isRetailFinancialDocTypes(documentType)
  ) {
    return "financial_transaction";
  }

  return "unknown_review";
}

export function buildDocumentOutputProfile(
  source: DocumentOutputProfileSource
): DocumentOutputProfile {
  const profileId = resolveProfileId(source);
  const layout = PROFILE_LAYOUT[profileId];

  return {
    profileId,
    primaryFields: [...layout.primaryFields],
    secondaryFields: [...layout.secondaryFields],
    hiddenFields: [...layout.hiddenFields],
    reviewMode: layout.reviewMode,
  };
}
