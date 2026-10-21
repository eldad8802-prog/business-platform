import { DEFAULT_LOCALE, type Locale } from "@/lib/i18n/config";
import { createTranslator, type Translator } from "@/lib/i18n/translate";
import { he } from "@/lib/i18n/messages/he";
import { categoryLabel } from "@/lib/documents/category-label";
import { formatAmountDisplay, formatDateShort } from "./format";
import type {
  ExtractionConfidenceMeta,
  ReviewDraft,
  ReviewMode,
  TrustLevel,
} from "./types";
import { hasNonEmptyText, isValidPositiveAmount } from "./validation";
import {
  trafficForAmount,
  trafficForCategory,
  trafficForDate,
  trafficForDirection,
  trafficForVendor,
} from "./traffic";

export type TrustContext = {
  trustLevel: TrustLevel;
  trustTitle: string;
  trustSummary: string;
  trustReasons: string[];
  approvalImpact: string;
  aiSummaryBody: string;
  amountDisplay: string;
  vendorDisplay: string;
  dateDisplay: string;
  categoryDisplay: string;
  directionDisplay: string;
};

export function computeTrustContext(input: {
  draft: ReviewDraft;
  extractionMeta: ExtractionConfidenceMeta | null;
  reviewMode: ReviewMode;
  profileId: string;
  /** Interface translator; defaults to Hebrew (the pre-i18n output). */
  t?: Translator;
  locale?: Locale;
}): TrustContext {
  const { draft, extractionMeta, reviewMode } = input;
  const t = input.t ?? createTranslator(he);
  const locale = input.locale ?? DEFAULT_LOCALE;
  const pid = input.profileId;

  const amountLevel = trafficForAmount(extractionMeta, draft);
  const vendorLevel = trafficForVendor(extractionMeta, draft);
  const dateLevel = trafficForDate(extractionMeta, draft);
  const categoryLevel = trafficForCategory(extractionMeta, draft);
  const directionLevel = trafficForDirection(draft);

  const amountDisplay =
    typeof draft.amount === "number" && Number.isFinite(draft.amount)
      ? formatAmountDisplay(draft.amount, locale)
      : t("documents.review.trust.amountMissing");
  const vendorDisplay = hasNonEmptyText(draft.vendorName)
    ? draft.vendorName
    : t("documents.review.trust.vendorMissing");
  const dateDisplay = formatDateShort(draft.date, locale) || t("documents.review.trust.dateMissing");
  const categoryDisplay = categoryLabel(t, draft.category) || t("documents.review.trust.categoryFallback");

  const directionDisplay =
    draft.direction === "income"
      ? t("documents.common.income")
      : draft.direction === "expense"
        ? t("documents.common.expense")
        : t("documents.review.trust.directionUnclassified");

  const aiSummaryBody =
    reviewMode === "financial"
      ? t("documents.review.trust.aiSummaryFinancial", {
          direction: directionDisplay,
          amount: amountDisplay,
          date: dateDisplay,
          category: categoryDisplay,
        })
      : t("documents.review.trust.aiSummaryDocument");

  const trustReasons = [
    reviewMode === "financial" && !isValidPositiveAmount(draft.amount)
      ? t("documents.review.trust.reasonAmountInvalid")
      : reviewMode === "financial" && amountLevel !== "high"
        ? t("documents.review.trust.reasonAmountVerify")
        : null,
    reviewMode === "financial" && !hasNonEmptyText(draft.vendorName)
      ? t("documents.review.trust.reasonVendorMissing")
      : vendorLevel === "low"
        ? t("documents.review.trust.reasonVendorLow")
        : vendorLevel === "medium"
          ? t("documents.review.trust.reasonVendorMedium")
          : null,
    reviewMode === "financial" && (!draft.date || !formatDateShort(draft.date))
      ? t("documents.review.trust.reasonDateMissing")
      : dateLevel === "low"
        ? t("documents.review.trust.reasonDateLow")
        : dateLevel === "medium"
          ? t("documents.review.trust.reasonDateMedium")
          : null,
    reviewMode === "financial" && directionLevel === "low"
      ? t("documents.review.trust.reasonDirectionLow")
      : null,
    categoryLevel === "low"
      ? t("documents.review.trust.reasonCategoryLow")
      : categoryLevel === "medium"
        ? t("documents.review.trust.reasonCategoryMedium")
        : null,
    pid === "unknown_review"
      ? t("documents.review.trust.reasonUnknownProfile")
      : null,
    pid === "non_financial"
      ? t("documents.review.trust.reasonNonFinancial")
      : null,
    pid === "tax_or_pension_document"
      ? t("documents.review.trust.reasonTaxOrPension")
      : null,
    pid === "quote_or_order"
      ? t("documents.review.trust.reasonQuoteOrOrder")
      : null,
  ].filter((reason): reason is string => Boolean(reason));

  const trustLevel: TrustLevel =
    reviewMode !== "financial" || pid !== "financial_transaction"
      ? "ambiguous"
      : trustReasons.length === 0
        ? "high"
        : trustReasons.length <= 2
          ? "medium"
          : "low";

  const trustTitle =
    trustLevel === "high"
      ? t("documents.review.trust.titleHigh")
      : trustLevel === "medium"
        ? t("documents.review.trust.titleMedium")
        : trustLevel === "low"
          ? t("documents.review.trust.titleLow")
          : t("documents.review.trust.titleAmbiguous");

  const trustSummary =
    trustReasons.length === 0
      ? t("documents.review.trust.summaryAllGood")
      : trustReasons[0];

  const approvalImpact =
    reviewMode === "financial"
      ? t("documents.review.trust.impactFinancial")
      : t("documents.review.trust.impactDocument");

  return {
    trustLevel,
    trustTitle,
    trustSummary,
    trustReasons,
    approvalImpact,
    aiSummaryBody,
    amountDisplay,
    vendorDisplay,
    dateDisplay,
    categoryDisplay,
    directionDisplay,
  };
}

export function trafficLevelsForDraft(
  extractionMeta: ExtractionConfidenceMeta | null,
  draft: ReviewDraft
) {
  return {
    amountLevel: trafficForAmount(extractionMeta, draft),
    vendorLevel: trafficForVendor(extractionMeta, draft),
    dateLevel: trafficForDate(extractionMeta, draft),
    categoryLevel: trafficForCategory(extractionMeta, draft),
    directionLevel: trafficForDirection(draft),
  };
}
