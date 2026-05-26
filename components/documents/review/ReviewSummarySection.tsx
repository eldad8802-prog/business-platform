"use client";

import { CATEGORY_MAP } from "@/lib/constants/categories";
import { card } from "@/app/(shell)/documents/ui";
import type {
  EditableField,
  ExtractionConfidenceMeta,
  ReviewDraft,
  ReviewMode,
} from "@/lib/documents/review/types";
import { formatAmountDisplay, formatDateShort } from "@/lib/documents/review/format";
import { firstMissingFinancialField, hasNonEmptyText, isValidPositiveAmount } from "@/lib/documents/review/validation";
import {
  trafficForAmount,
  trafficForCategory,
  trafficForDate,
  trafficForDirection,
  trafficForVendor,
} from "@/lib/documents/review/traffic";
import ReviewFieldRow from "./ReviewFieldRow";
import { primaryDarkButton, secondaryButton } from "./review-ui";

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
  return (
    <section style={card}>
      {reviewMode === "financial" ? (
        <>
          <div style={{ fontWeight: 950, color: "#111827", fontSize: 18, marginBottom: 8 }}>
            אישור העסקה
          </div>
          <p style={{ margin: "0 0 14px", color: "#6b7280", fontSize: 14, lineHeight: 1.6 }}>
            {aiSummaryBody} {approvalImpact}
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
              marginTop: 14,
              border: "1px solid #bbf7d0",
              background: "#f0fdf4",
              color: "#065f46",
              borderRadius: 16,
              padding: 12,
              fontSize: 13,
              fontWeight: 800,
              lineHeight: 1.5,
            }}
          >
            אחרי האישור: העסקה תיכנס לדוח החודשי, תהיה זמינה בחיפוש ותיכלל בחבילה לרו״ח.
          </div>

          <div style={{ marginTop: 16 }}>
            <button
              type="button"
              disabled={loading}
              style={primaryDarkButton(loading)}
              onClick={onApproveFinancial}
            >
              {(() => {
                const missing = firstMissingFinancialField(draft);
                if (loading) return "שומר...";
                if (missing) return "השלם שדה נדרש";
                return "אשר והוסף לדוח";
              })()}
            </button>
          </div>

          <div style={{ marginTop: 10 }}>
            <button
              type="button"
              disabled={loading}
              style={secondaryButton(loading)}
              onClick={() => onSetReviewMode("document")}
            >
              שמור כמסמך מידע במקום
            </button>
          </div>
        </>
      ) : (
        <>
          <div style={{ fontWeight: 950, color: "#111827", fontSize: 18, marginBottom: 10 }}>
            שמירה כמסמך מידע
          </div>

          <div style={{ color: "#6b7280", fontSize: 14, lineHeight: 1.6 }}>
            {aiSummaryBody} אפשר לערוך שדות לזיהוי פנימי, אבל האישור לא ייצור עסקה פיננסית.
          </div>

          <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
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
              label="קטגוריה"
              missing={!hasNonEmptyText(draft.category)}
              displayValue={CATEGORY_MAP[draft.category] || draft.category}
              level={trafficForCategory(extractionMeta, draft)}
              onPrimary={() => onEditField("category")}
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
          </div>

          <div
            style={{
              marginTop: 14,
              border: "1px solid #e5e7eb",
              background: "#f9fafb",
              color: "#374151",
              borderRadius: 16,
              padding: 12,
              fontSize: 13,
              fontWeight: 800,
              lineHeight: 1.5,
            }}
          >
            ייקלט כמסמך מידע. לא ייכנס לדוחות, לחיפוש העסקאות או לחבילה לרו״ח.
          </div>

          <div style={{ marginTop: 16 }}>
            <button
              type="button"
              disabled={loading}
              style={primaryDarkButton(loading)}
              onClick={onApproveDocumentOnly}
            >
              {loading ? "שומר..." : "אשר ושמור כמסמך מידע"}
            </button>
          </div>

          {isUnknown ? (
            <div style={{ marginTop: 10 }}>
              <button
                type="button"
                disabled={loading}
                style={secondaryButton(loading)}
                onClick={() => onSetReviewMode("financial")}
              >
                זו בעצם קבלה / עסקה — שמור כעסקה
              </button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
