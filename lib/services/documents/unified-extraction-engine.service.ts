import { cleanOCRText } from "./text-cleaner.service";
import type { DocumentStructure } from "./document-structure.service";
import { parseDocumentStructure } from "./document-structure.service";
import { extractDocumentEntities } from "./entities/entity-extraction.service";
import { classifyUnderstandingAmountsForEligibility } from "./amount-eligibility.service";
import { buildAmountPublishDecisionLog } from "./amount-publish-decision.service";
import { decideDocumentExtraction } from "./entities/document-decision.service";
import { decideCategory } from "./category-decision.service";
import { normalizeFinancialDocument } from "./financial-normalization.service";
import {
  detectDocumentType,
  type DocumentType,
} from "./document-type.service";
import {
  evaluateDocumentGuardrail,
  type DocumentGuardrailResult,
  type DocumentGuardrailRoute,
} from "./document-guardrail.service";
import resolveFinalEntities from "./decision/resolve-final-entities.service";
import {
  buildDocumentOutputProfile,
  type DocumentOutputProfile,
} from "./document-output-profile.service";
import type {
  DocumentEntities,
  DocumentExtractionDecision,
} from "./entities/document-entities.types";
import type { ResolvedFinalEntities } from "./decision/resolve-final-entities.service";

type ConfidenceLabel = "high" | "medium" | "low";
type Direction = "income" | "expense" | "unknown";

type ShadowLogRecommendation =
  | "keep_current"
  | "inspect_amount"
  | "reject_merged_vendor";

function normalizeShadowText(value: string | null | undefined): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function shadowDatesEqual(
  a: Date | null,
  b: Date | string | null | undefined
): boolean {
  if (a == null && (b == null || b === undefined)) return true;
  if (a == null || b == null || b === undefined) return false;

  const ta = a instanceof Date ? a.getTime() : new Date(a).getTime();
  const tb = b instanceof Date ? b.getTime() : new Date(b as string).getTime();

  return Number.isFinite(ta) && Number.isFinite(tb) && ta === tb;
}

/** Heuristic: current pipeline often uses explicit Israeli company markers when correct. */
function hasBusinessEntityMarker(name: string): boolean {
  const lower = name.toLowerCase();

  return (
    name.includes('בע"מ') ||
    name.includes("בע״מ") ||
    name.includes("בעיימ") ||
    name.includes("בעימ") ||
    lower.includes(" ltd") ||
    lower.includes("limited") ||
    lower.includes(" inc") ||
    lower.includes("חברת ")
  );
}

function amountRelativeMaxDiff(a: number, b: number | null): number {
  if (b === null || !Number.isFinite(a) || !Number.isFinite(b)) {
    return Number.isFinite(a) && a === 0 && b === null ? 0 : Infinity;
  }

  const m = Math.max(Math.abs(a), Math.abs(b), 1e-9);

  return Math.abs(a - b) / m;
}

function computeShadowRecommendation(input: {
  vendorChanged: boolean;
  amountChanged: boolean;
  decisionVendorName: string;
  mergedVendorName: string | null;
  vendorConfidence: ConfidenceLabel;
  amountConfidence: ConfidenceLabel;
  amountRelativeDiff: number;
}): ShadowLogRecommendation {
  const mergedV = normalizeShadowText(input.mergedVendorName);
  const currentV = normalizeShadowText(input.decisionVendorName);

  if (
    input.vendorChanged &&
    mergedV.length > 0 &&
    hasBusinessEntityMarker(currentV) &&
    !hasBusinessEntityMarker(mergedV) &&
    input.vendorConfidence === "high"
  ) {
    return "reject_merged_vendor";
  }

  if (
    input.amountChanged &&
    (input.amountConfidence === "low" || input.amountRelativeDiff > 0.15)
  ) {
    return "inspect_amount";
  }

  return "keep_current";
}

function buildShadowComparisonLog(input: {
  decision: DocumentExtractionDecision;
  shadowResolved: ResolvedFinalEntities;
  entities: DocumentEntities;
}) {
  const { decision, shadowResolved, entities } = input;

  const mergedAmt = shadowResolved.amount;
  const currentAmt = decision.amount;

  const amountChanged =
    mergedAmt === null
      ? Number.isFinite(currentAmt) && currentAmt !== 0
      : currentAmt !== mergedAmt;

  const vendorChanged =
    normalizeShadowText(decision.vendorName) !==
    normalizeShadowText(shadowResolved.vendorName ?? "");

  const dateChanged = !shadowDatesEqual(decision.date, shadowResolved.date);

  const amountRelativeDiff = amountRelativeMaxDiff(currentAmt, mergedAmt);

  const recommendation = computeShadowRecommendation({
    vendorChanged,
    amountChanged,
    decisionVendorName: decision.vendorName,
    mergedVendorName: shadowResolved.vendorName,
    vendorConfidence: decision.vendorConfidence,
    amountConfidence: decision.amountConfidence,
    amountRelativeDiff,
  });

  return {
    amountChanged,
    vendorChanged,
    dateChanged,
    currentAmountConfidence: decision.amountConfidence,
    currentNeedsReview: decision.needsReview,
    mergedNeedsReview: shadowResolved.needsReview,
    recommendation,
    current: {
      amount: decision.amount,
      amountConfidence: decision.amountConfidence,
      vendorName: decision.vendorName,
      vendorConfidence: decision.vendorConfidence,
      date: decision.date,
      dateConfidence: decision.dateConfidence,
      needsReview: decision.needsReview,
    },
    merged: {
      amount: shadowResolved.amount,
      vendorName: shadowResolved.vendorName,
      date: shadowResolved.date,
      confidence: shadowResolved.confidence,
      needsReview: shadowResolved.needsReview,
    },
    currentEntities: {
      amount: {
        value: entities.amount.value,
        raw: entities.amount.raw,
        confidence: entities.amount.confidence,
        source: entities.amount.source,
        reason: entities.amount.reason,
      },
      vendor: {
        name: entities.vendor.name,
        confidence: entities.vendor.confidence,
        source: entities.vendor.source,
        reason: entities.vendor.reason,
      },
      date: {
        value: entities.date.value,
        confidence: entities.date.confidence,
        source: entities.date.source,
        reason: entities.date.reason,
      },
    },
  };
}

export type FinancialEvidenceLevel =
  | "strong"
  | "weak"
  | "negative"
  | "uncertain";

/** Narrow weak cases for explanations only; does not affect level/eligibility. */
export type WeakResolutionReason =
  | "demand_or_fine_without_completion"
  | "numeric_noise_without_payment_context"
  | "financial_document_missing_completion"
  | "bank_transfer_missing_confirmation"
  | "missing_currency_or_structured_payment"
  | "unknown_weak_reason";

export type UnifiedDocumentIntelligenceResult = {
  amount: number | null;
  vendorName: string;
  date: Date | null;
  category: string;
  direction: Direction;
  confidence: number;
  needsReview: boolean;
  amountConfidence: ConfidenceLabel;
  vendorConfidence: ConfidenceLabel;
  dateConfidence: ConfidenceLabel;
  categoryConfidence: ConfidenceLabel;
  documentType: DocumentType;
  isFinancial: boolean;
  guardrailRoute: DocumentGuardrailRoute;
  searchableText: string;
  financialEvidenceLevel: FinancialEvidenceLevel;
  amountEligible: boolean;
  evidenceReasons: string[];
  /** Set only when `financialEvidenceLevel === "weak"`; otherwise `null`. */
  weakResolutionReason: WeakResolutionReason | null;
  outputProfile: DocumentOutputProfile;
};

/** Fine / demand / collection — never strong without explicit payment completion. */
function textHasDemandOrFineContext(text: string): boolean {
  const lower = text.toLowerCase();

  return (
    lower.includes("קנס") ||
    lower.includes("דרישת תשלום") ||
    lower.includes("דרישת חוב") ||
    lower.includes("גבייה") ||
    lower.includes("חובך")
  );
}

/** Paid / captured / card charge / approved payment — not "לתשלום" or generic demand wording. */
function hasExplicitPaymentCompletionEvidence(text: string): boolean {
  const lower = text.toLowerCase();

  if (lower.includes("שולם") || lower.includes("שולמה")) return true;
  if (
    lower.includes("חיוב בכרטיס") ||
    lower.includes("חויב בכרטיס") ||
    lower.includes("שולם בכרטיס") ||
    lower.includes("התקבל בכרטיס")
  ) {
    return true;
  }
  if (lower.includes("סכום עסקה")) return true;
  if (/\bpayment approved\b/i.test(lower)) return true;
  if (/\bpaid\b/i.test(lower)) return true;

  return false;
}

function hasCurrencyNextToAmountInLine(line: string): boolean {
  const lower = line.toLowerCase();
  const hasSymbol =
    line.includes("₪") ||
    lower.includes('ש"ח') ||
    lower.includes("ש״ח") ||
    /\bnis\b/i.test(lower);

  if (!hasSymbol) return false;

  return /\d/.test(line);
}

function docTypeSupportsReceiptInvoiceAmountPath(t: DocumentType): boolean {
  return t === "receipt" || t === "invoice" || t === "donation_receipt";
}

function hasCurrencyAmountInFullText(text: string): boolean {
  if (!/\d/.test(text)) return false;

  const lower = text.toLowerCase();

  if (text.includes("₪")) return true;
  if (lower.includes('ש"ח') || lower.includes("ש״ח")) return true;
  if (/\bnis\b/i.test(lower)) return true;

  return false;
}

/** Strong line signal for non–demand-only docs: completion and/or currency+amount on same line. */
function lineSupportsStrongPaymentEvidence(line: string): boolean {
  if (hasExplicitPaymentCompletionEvidence(line)) return true;
  if (hasCurrencyNextToAmountInLine(line)) return true;

  return false;
}

function hasStructuredStrongPaymentEvidence(structure: DocumentStructure): boolean {
  const lines = [...structure.paymentLines, ...structure.totalLines];

  return lines.some((line) => lineSupportsStrongPaymentEvidence(line));
}

function hasStrongPaymentEvidenceOverall(input: {
  text: string;
  documentType: DocumentType;
  structure: DocumentStructure;
}): boolean {
  const { text, documentType, structure } = input;

  const demandOrFine = textHasDemandOrFineContext(text);
  const completion = hasExplicitPaymentCompletionEvidence(text);

  if (demandOrFine) {
    return completion;
  }

  if (completion) return true;
  if (hasStructuredStrongPaymentEvidence(structure)) return true;

  if (
    docTypeSupportsReceiptInvoiceAmountPath(documentType) &&
    hasCurrencyAmountInFullText(text)
  ) {
    return true;
  }

  return false;
}

/**
 * Single decisive explanation for financialEvidenceLevel, matching branch order:
 * negative → uncertain → strong → weak.
 */
function resolutionRuleForFinancialEvidence(input: {
  financialEvidenceLevel: FinancialEvidenceLevel;
  guardrail: DocumentGuardrailResult;
  typeDetection: ReturnType<typeof detectDocumentType>;
  explicitCompletion: boolean;
  structuredStrong: boolean;
  receiptInvoiceCurrencyPath: boolean;
}): string {
  const {
    financialEvidenceLevel,
    guardrail,
    typeDetection,
    explicitCompletion,
    structuredStrong,
    receiptInvoiceCurrencyPath,
  } = input;

  if (financialEvidenceLevel === "negative") {
    if (guardrail.route === "non_transaction") {
      return "resolution_rule:guardrail_negative";
    }
    return "resolution_rule:is_financial_overrides_guardrail";
  }

  if (financialEvidenceLevel === "uncertain") {
    if (guardrail.forceReview === true) {
      return "resolution_rule:guardrail_force_review";
    }
    return "resolution_rule:guardrail_uncertain";
  }

  if (financialEvidenceLevel === "strong") {
    if (explicitCompletion) {
      return "resolution_rule:explicit_payment_completion";
    }
    if (structuredStrong) {
      return "resolution_rule:structured_payment_evidence";
    }
    if (receiptInvoiceCurrencyPath) {
      return "resolution_rule:receipt_invoice_currency_path";
    }
    return "resolution_rule:explicit_payment_completion";
  }

  return "resolution_rule:weak_due_to_missing_strong_signals";
}

function textHasNumericNoiseWithoutStructure(text: string): boolean {
  const nums = text.match(/\b\d{2,}(?:[,.]\d{1,2})?\b/g) ?? [];
  const meaningful = nums.filter((raw) => {
    const n = Number(raw.replace(/,/g, ""));
    if (!Number.isFinite(n)) return false;
    if (n >= 1900 && n <= 2099) return false;
    return true;
  });

  return meaningful.length >= 4;
}

function isReceiptLikeDocumentType(t: DocumentType): boolean {
  return t === "receipt" || t === "invoice" || t === "donation_receipt";
}

/**
 * Refines weak-only explanations from existing flags (does not change weak vs strong).
 */
function weakResolutionReasonFor(input: {
  financialEvidenceLevel: FinancialEvidenceLevel;
  documentType: DocumentType;
  text: string;
  demandOrFine: boolean;
  explicitCompletion: boolean;
  structuredStrong: boolean;
  receiptInvoiceCurrencyPath: boolean;
  hasPaymentLines: boolean;
  hasTotalLines: boolean;
}): WeakResolutionReason | null {
  if (input.financialEvidenceLevel !== "weak") {
    return null;
  }

  const {
    documentType,
    text,
    demandOrFine,
    explicitCompletion,
    structuredStrong,
    receiptInvoiceCurrencyPath,
    hasPaymentLines,
    hasTotalLines,
  } = input;

  if (demandOrFine && !explicitCompletion) {
    return "demand_or_fine_without_completion";
  }

  if (documentType === "bank_transfer") {
    return "bank_transfer_missing_confirmation";
  }

  if (
    isReceiptLikeDocumentType(documentType) &&
    !explicitCompletion &&
    !demandOrFine &&
    (hasPaymentLines || hasTotalLines)
  ) {
    return "financial_document_missing_completion";
  }

  if (
    isReceiptLikeDocumentType(documentType) &&
    !structuredStrong &&
    !receiptInvoiceCurrencyPath
  ) {
    return "missing_currency_or_structured_payment";
  }

  if (
    !hasPaymentLines &&
    !hasTotalLines &&
    textHasNumericNoiseWithoutStructure(text)
  ) {
    return "numeric_noise_without_payment_context";
  }

  return "unknown_weak_reason";
}

function computeFinancialEvidenceV1(input: {
  text: string;
  typeDetection: ReturnType<typeof detectDocumentType>;
  guardrail: DocumentGuardrailResult;
  structure: DocumentStructure;
}): {
  financialEvidenceLevel: FinancialEvidenceLevel;
  amountEligible: boolean;
  evidenceReasons: string[];
  weakResolutionReason: WeakResolutionReason | null;
} {
  const { text, typeDetection, guardrail, structure } = input;

  const hasPaymentLines = structure.paymentLines.length > 0;
  const hasTotalLines = structure.totalLines.length > 0;
  const demandOrFine = textHasDemandOrFineContext(text);
  const explicitCompletion = hasExplicitPaymentCompletionEvidence(text);
  const structuredStrong = hasStructuredStrongPaymentEvidence(structure);
  const receiptInvoiceCurrencyPath =
    docTypeSupportsReceiptInvoiceAmountPath(typeDetection.documentType) &&
    hasCurrencyAmountInFullText(text);
  const strongPaymentEvidence = hasStrongPaymentEvidenceOverall({
    text,
    documentType: typeDetection.documentType,
    structure,
  });

  let financialEvidenceLevel: FinancialEvidenceLevel;

  if (
    guardrail.route === "non_transaction" ||
    typeDetection.isFinancial === false
  ) {
    financialEvidenceLevel = "negative";
  } else if (
    guardrail.route === "uncertain" ||
    guardrail.forceReview === true
  ) {
    financialEvidenceLevel = "uncertain";
  } else if (
    guardrail.route === "financial_transaction" &&
    guardrail.forceReview === false &&
    typeDetection.isFinancial === true &&
    strongPaymentEvidence
  ) {
    financialEvidenceLevel = "strong";
  } else {
    financialEvidenceLevel = "weak";
  }

  const amountEligible = financialEvidenceLevel === "strong";

  const resolutionRule = resolutionRuleForFinancialEvidence({
    financialEvidenceLevel,
    guardrail,
    typeDetection,
    explicitCompletion,
    structuredStrong,
    receiptInvoiceCurrencyPath,
  });

  const weakResolutionReason = weakResolutionReasonFor({
    financialEvidenceLevel,
    documentType: typeDetection.documentType,
    text,
    demandOrFine,
    explicitCompletion,
    structuredStrong,
    receiptInvoiceCurrencyPath,
    hasPaymentLines,
    hasTotalLines,
  });

  const evidenceReasons = [
    `document_type:${typeDetection.documentType}`,
    `is_financial:${typeDetection.isFinancial}`,
    `guardrail_route:${guardrail.route}`,
    `guardrail_force_review:${guardrail.forceReview}`,
    `has_payment_lines:${hasPaymentLines}`,
    `has_total_lines:${hasTotalLines}`,
    `demand_or_fine_context:${demandOrFine}`,
    `explicit_payment_completion:${explicitCompletion}`,
    `structured_strong_payment_line:${structuredStrong}`,
    `receipt_invoice_currency_path:${receiptInvoiceCurrencyPath}`,
    `strong_payment_evidence:${strongPaymentEvidence}`,
    `amount_eligible:${amountEligible}`,
    resolutionRule,
    ...(weakResolutionReason !== null
      ? [`weak_resolution_rule:${weakResolutionReason}`]
      : []),
  ];

  return {
    financialEvidenceLevel,
    amountEligible,
    evidenceReasons,
    weakResolutionReason,
  };
}

export async function runUnifiedDocumentIntelligence(params: {
  businessId: number;
  rawText: string;
}): Promise<UnifiedDocumentIntelligenceResult> {
  const { businessId, rawText } = params;

  const cleanedText = cleanOCRText(rawText);
  const typeDetection = detectDocumentType(cleanedText);
  const guardrail = evaluateDocumentGuardrail({
    text: cleanedText,
    documentType: typeDetection.documentType,
    documentTypeConfidence: typeDetection.confidence,
  });

  const structure = parseDocumentStructure(cleanedText);
  const evidence = computeFinancialEvidenceV1({
    text: cleanedText,
    typeDetection,
    guardrail,
    structure,
  });

  const extracted = extractDocumentEntities(cleanedText, structure);
  const entities = extracted.entities;

  const amountEligibilityLog = classifyUnderstandingAmountsForEligibility({
    documentType: typeDetection.documentType,
    understanding: extracted.understanding,
    structure,
  });

  console.log("DOCUMENT_AMOUNT_ELIGIBILITY:", amountEligibilityLog);

  const decision = decideDocumentExtraction(entities);

  const amountPublishDecisionLog = buildAmountPublishDecisionLog({
    amountEligible: evidence.amountEligible,
    currentAmount: decision.amount,
    eligibility: amountEligibilityLog,
  });

  console.log("DOCUMENT_AMOUNT_PUBLISH_DECISION:", amountPublishDecisionLog);

  const shadowResolved = resolveFinalEntities({
    entities: {
      amount: entities.amount,
      vendor: entities.vendor,
      date: entities.date,
    },
    understanding: {
      amounts: extracted.understanding.amounts,
      vendors: extracted.understanding.vendors,
      dates: extracted.understanding.dates,
    },
    rawText: cleanedText,
    documentType: typeDetection.documentType,
  });

  console.log(
    "DOCUMENT SHADOW COMPARISON:",
    buildShadowComparisonLog({ decision, shadowResolved, entities })
  );

  const categoryResult = await decideCategory(
    businessId,
    decision.vendorName,
    cleanedText
  );

  const normalized = normalizeFinancialDocument({
    amount: decision.amount,
    vendorName: decision.vendorName,
    date: decision.date,
    amountConfidence: decision.amountConfidence,
    vendorConfidence: decision.vendorConfidence,
    dateConfidence: decision.dateConfidence,
    rawText: cleanedText,
    documentType: typeDetection.documentType,
    documentTypeConfidence: typeDetection.confidence,
    guardrailRoute: guardrail.route,
  });

  const direction: Direction = typeDetection.isFinancial
    ? normalized.direction
    : "unknown";

  const needsReview =
    decision.needsReview ||
    normalized.needsReview ||
    !typeDetection.isFinancial ||
    guardrail.forceReview;

  let publishAmountAllowed = amountPublishDecisionLog.publishAmountAllowed;
  let enforcedAmount: number | null = publishAmountAllowed
    ? decision.amount
    : null;
  let enforcedAmountConfidence: ConfidenceLabel = decision.amountConfidence;

  const onlyMismatchBlock =
    amountPublishDecisionLog.blockReasons.length === 1 &&
    amountPublishDecisionLog.blockReasons[0] ===
      "current_amount_not_in_eligible_candidates";

  if (
    !amountPublishDecisionLog.publishAmountAllowed &&
    evidence.amountEligible &&
    amountPublishDecisionLog.eligibleCountDistinct === 1 &&
    onlyMismatchBlock
  ) {
    const sole = amountPublishDecisionLog.distinctEligibleItems[0];
    if (sole !== undefined && Number.isFinite(sole.value)) {
      const correctedAmount = sole.value;
      const amountPublishDecisionLogAfterCorrection =
        buildAmountPublishDecisionLog({
          amountEligible: evidence.amountEligible,
          currentAmount: correctedAmount,
          eligibility: amountEligibilityLog,
        });

      console.log(
        "DOCUMENT_AMOUNT_PUBLISH_DECISION_AFTER_CORRECTION:",
        amountPublishDecisionLogAfterCorrection
      );

      if (amountPublishDecisionLogAfterCorrection.publishAmountAllowed) {
        publishAmountAllowed = true;
        enforcedAmount = correctedAmount;
        console.log("SAFE_AMOUNT_CORRECTION_APPLIED:", {
          originalDecisionAmount: decision.amount,
          correctedAmount,
        });
      }
    }
  }

  const shouldPrefillBlockedAmount =
    !publishAmountAllowed &&
    enforcedAmount === null &&
    Number.isFinite(decision.amount) &&
    decision.amount > 0 &&
    decision.amountConfidence !== "low";

  if (shouldPrefillBlockedAmount) {
    enforcedAmount = decision.amount;
    enforcedAmountConfidence = "low";

    console.log("BLOCKED_AMOUNT_PREFILLED_FOR_REVIEW:", {
      amount: decision.amount,
      originalAmountConfidence: decision.amountConfidence,
      enforcedAmountConfidence,
      blockReasons: amountPublishDecisionLog.blockReasons,
      financialEvidenceLevel: evidence.financialEvidenceLevel,
      amountEligible: evidence.amountEligible,
      publishAmountAllowed,
    });
  }

  const enforcedNeedsReview = !publishAmountAllowed || needsReview;

  const outputProfile = buildDocumentOutputProfile({
    documentType: typeDetection.documentType,
    isFinancial: typeDetection.isFinancial,
    guardrailRoute: guardrail.route,
    searchableText: normalized.searchableText,
    needsReview: enforcedNeedsReview,
    confidence: decision.confidenceScore,
    financialEvidenceLevel: evidence.financialEvidenceLevel,
  });

  return {
    amount: enforcedAmount,
    vendorName: decision.vendorName,
    date: decision.date,
    category: categoryResult.category,
    direction,
    confidence: decision.confidenceScore,
    needsReview: enforcedNeedsReview,
    amountConfidence: enforcedAmountConfidence,
    vendorConfidence: decision.vendorConfidence,
    dateConfidence: decision.dateConfidence,
    categoryConfidence: categoryResult.confidence,
    documentType: typeDetection.documentType,
    isFinancial: typeDetection.isFinancial,
    guardrailRoute: guardrail.route,
    searchableText: normalized.searchableText,
    financialEvidenceLevel: evidence.financialEvidenceLevel,
    amountEligible: evidence.amountEligible,
    evidenceReasons: evidence.evidenceReasons,
    weakResolutionReason: evidence.weakResolutionReason,
    outputProfile,
  };
}
