"use client";

import { CATEGORY_MAP } from "@/lib/constants/categories";
import type {
  EditableField,
  ExtractionConfidenceMeta,
  ReviewDraft,
  ReviewMode,
} from "@/lib/documents/review/types";
import { formatAmountDisplay, formatDateShort } from "@/lib/documents/review/format";
import { TOKEN } from "@/lib/design/tokens";
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

  return (
    <section style={{ ...reviewCard, maxWidth: 780, width: "100%", margin: "0 auto" }}>
      <div style={{ fontWeight: 950, color: TOKEN.ink.primary, fontSize: 24, marginBottom: 8 }}>
        {isFinancial ? "אישור רשומה פיננסית" : "שמירה כמסמך מידע"}
      </div>
      <p style={{ margin: "0 0 16px", color: TOKEN.ink.muted, fontSize: 15, lineHeight: 1.65 }}>
        {isFinancial
          ? `${aiSummaryBody} ${approvalImpact}`
          : `${aiSummaryBody} האישור ישמור את המסמך לתיעוד, בלי ליצור רשומה פיננסית.`}
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <ReviewFieldRow
          label="סכום"
          missing={!isValidPositiveAmount(draft.amount)}
          displayValue={
            typeof draft.amount === "number" ? formatAmountDisplay(draft.amount) : ""
          }
          level={trafficForAmount(extractionMeta, draft)}
          onPrimary={() => onEditField("amount")}
        />
        <ReviewFieldRow
          label="ספק"
          missing={!hasNonEmptyText(draft.vendorName)}
          displayValue={draft.vendorName}
          level={trafficForVendor(extractionMeta, draft)}
          onPrimary={() => onEditField("vendorName")}
        />
        <ReviewFieldRow
          label="תאריך"
          missing={!draft.date || !formatDateShort(draft.date)}
          displayValue={formatDateShort(draft.date)}
          level={trafficForDate(extractionMeta, draft)}
          onPrimary={() => onEditField("date")}
        />
        <ReviewFieldRow
          label="כיוון"
          missing={draft.direction === "unknown"}
          displayValue={
            draft.direction === "expense"
              ? "הוצאה"
              : draft.direction === "income"
                ? "הכנסה"
                : ""
          }
          level={trafficForDirection(draft)}
          onPrimary={() => onEditField("direction")}
        />
        <ReviewFieldRow
          label="קטגוריה"
          missing={!hasNonEmptyText(draft.category)}
          displayValue={CATEGORY_MAP[draft.category] || draft.category}
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
          fontWeight: 800,
          lineHeight: 1.6,
        }}
      >
        {isFinancial
          ? "אחרי האישור: המסמך ייכנס לרשומות המאושרות, יהיה זמין בחיפוש וייכלל בחומר לרו״ח כשזה רלוונטי."
          : "המסמך יישמר לתיעוד בלבד ולא ייצור רשומה פיננסית מאושרת."}
      </div>

      <div style={{ marginTop: 18 }}>
        <button
          type="button"
          disabled={loading}
          style={primaryDarkButton(loading)}
          onClick={isFinancial ? onApproveFinancial : onApproveDocumentOnly}
        >
          {(() => {
            if (loading) return "שומר...";
            if (isFinancial && firstMissingFinancialField(draft)) return "השלם שדה נדרש";
            return isFinancial ? "אשר ושמור" : "שמור כמסמך מידע";
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
            ? "שמור כמסמך מידע במקום"
            : isUnknown
              ? "זה מסמך פיננסי"
              : "שמור כרשומה פיננסית"}
        </button>
      </div>
    </section>
  );
}
