"use client";

import { useI18n } from "@/components/i18n/I18nProvider";
import { categoryLabel } from "@/lib/documents/category-label";
import type {
  EditableField,
  ExtractionConfidenceMeta,
  ReviewDraft,
  ReviewMode,
} from "@/lib/documents/review/types";
import { formatAmountDisplay, formatDateShort } from "@/lib/documents/review/format";
import { TOKEN } from "@/lib/design/documents-theme";
import {
  firstMissingFinancialField,
  hasNonEmptyText,
  isValidPositiveAmount,
} from "@/lib/documents/review/validation";
import {
  trafficForAmount,
  trafficForCategory,
  trafficForDate,
  trafficForDirection,
  trafficForVendor,
} from "@/lib/documents/review/traffic";
import ReviewFieldRow from "./ReviewFieldRow";
import { primaryDarkButton, reviewCard, reviewSoftPanel, secondaryButton } from "./review-ui";

export type ReviewSummarySectionProps = {
  reviewMode: ReviewMode;
  isUnknown: boolean;
  loading: boolean;
  draft: ReviewDraft;
  extractionMeta: ExtractionConfidenceMeta | null;
  aiSummaryBody: string;
  approvalImpact: string;
  onEditField: (field: EditableField) => void;
  onSetReviewMode: (mode: ReviewMode) => void;
  onApproveFinancial: () => void;
  onApproveDocumentOnly: () => void;
};

export default function ReviewSummarySection({
  reviewMode,
  isUnknown,
  loading,
  draft,
  extractionMeta,
  aiSummaryBody,
  approvalImpact,
  onEditField,
  onSetReviewMode,
  onApproveFinancial,
  onApproveDocumentOnly,
}: ReviewSummarySectionProps) {
  const isFinancial = reviewMode === "financial";
  const { t, locale } = useI18n();

  return (
    <section style={{ ...reviewCard, maxWidth: 780, width: "100%", margin: "0 auto" }}>
      <div style={{ fontWeight: 950, color: TOKEN.ink.primary, fontSize: 24, marginBottom: 8 }}>
        {isFinancial ? t("documents.review.summary.titleFinancial") : t("documents.review.summary.titleDocument")}
      </div>
      <p style={{ margin: "0 0 16px", color: TOKEN.ink.muted, fontSize: 15, lineHeight: 1.65 }}>
        {isFinancial
          ? `${aiSummaryBody} ${approvalImpact}`
          : t("documents.review.summary.documentSuffix", { summary: aiSummaryBody })}
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <ReviewFieldRow
          label={t("documents.review.fields.amount")}
          missing={!isValidPositiveAmount(draft.amount)}
          displayValue={
            typeof draft.amount === "number" ? formatAmountDisplay(draft.amount, locale) : ""
          }
          level={trafficForAmount(extractionMeta, draft)}
          onPrimary={() => onEditField("amount")}
        />
        <ReviewFieldRow
          label={t("documents.review.fields.vendor")}
          missing={!hasNonEmptyText(draft.vendorName)}
          displayValue={draft.vendorName}
          level={trafficForVendor(extractionMeta, draft)}
          onPrimary={() => onEditField("vendorName")}
        />
        <ReviewFieldRow
          label={t("documents.review.fields.date")}
          missing={!draft.date || !formatDateShort(draft.date)}
          displayValue={formatDateShort(draft.date, locale)}
          level={trafficForDate(extractionMeta, draft)}
          onPrimary={() => onEditField("date")}
        />
        <ReviewFieldRow
          label={t("documents.review.fields.direction")}
          missing={draft.direction === "unknown"}
          displayValue={
            draft.direction === "expense"
              ? t("documents.common.expense")
              : draft.direction === "income"
                ? t("documents.common.income")
                : ""
          }
          level={trafficForDirection(draft)}
          onPrimary={() => onEditField("direction")}
        />
        <ReviewFieldRow
          label={t("documents.review.fields.category")}
          missing={!hasNonEmptyText(draft.category)}
          displayValue={categoryLabel(t, draft.category)}
          level={trafficForCategory(extractionMeta, draft)}
          onPrimary={() => onEditField("category")}
        />
      </div>

      <div
        style={{
          ...reviewSoftPanel,
          marginTop: 16,
          color: isFinancial ? TOKEN.semantic.success.ink : TOKEN.ink.secondary,
          background: isFinancial ? TOKEN.semantic.success.bgSoft : TOKEN.surface.inset,
          borderColor: isFinancial ? TOKEN.semantic.success.border : TOKEN.border.DEFAULT,
          fontSize: 14,
          fontWeight: 600,
          lineHeight: 1.6,
        }}
      >
        {isFinancial
          ? t("documents.review.summary.afterFinancial")
          : t("documents.review.summary.afterDocument")}
      </div>

      <div style={{ marginTop: 18 }}>
        <button
          type="button"
          disabled={loading}
          style={primaryDarkButton(loading)}
          onClick={isFinancial ? onApproveFinancial : onApproveDocumentOnly}
        >
          {(() => {
            if (loading) return t("documents.review.actions.saving");
            if (isFinancial && firstMissingFinancialField(draft)) return t("documents.review.summary.completeRequired");
            return isFinancial ? t("documents.review.summary.approveAndSave") : t("documents.review.actions.saveAsDocument");
          })()}
        </button>
      </div>

      <div style={{ marginTop: 10 }}>
        <button
          type="button"
          disabled={loading}
          style={secondaryButton(loading)}
          onClick={() => onSetReviewMode(isFinancial ? "document" : "financial")}
        >
          {isFinancial
            ? t("documents.review.summary.saveAsDocumentInstead")
            : isUnknown
              ? t("documents.review.summary.itIsFinancial")
              : t("documents.review.summary.saveAsFinancial")}
        </button>
      </div>
    </section>
  );
}
