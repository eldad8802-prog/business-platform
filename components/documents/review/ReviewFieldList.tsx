"use client";

import { CATEGORY_MAP } from "@/lib/constants/categories";
import type {
  EditableField,
  ExtractionConfidenceMeta,
  ReviewDraft,
  TrafficLevel,
} from "@/lib/documents/review/types";
import { formatAmountDisplay, formatDateShort } from "@/lib/documents/review/format";
import { hasNonEmptyText, isValidPositiveAmount } from "@/lib/documents/review/validation";
import ReviewFieldRow from "./ReviewFieldRow";
import { secondaryButton } from "./review-ui";

export type ReviewFieldListProps = {
  showFieldDetails: boolean;
  onToggleFieldDetails: () => void;
  loading: boolean;
  draft: ReviewDraft;
  extractionMeta: ExtractionConfidenceMeta | null;
  amountLevel: TrafficLevel;
  vendorLevel: TrafficLevel;
  dateLevel: TrafficLevel;
  categoryLevel: TrafficLevel;
  directionLevel: TrafficLevel;
  editReturnTarget: "decision" | "summary";
  onEditField: (field: EditableField, returnTarget: "decision" | "summary") => void;
};

export default function ReviewFieldList({
  showFieldDetails,
  onToggleFieldDetails,
  loading,
  draft,
  amountLevel,
  vendorLevel,
  dateLevel,
  categoryLevel,
  directionLevel,
  editReturnTarget,
  onEditField,
}: ReviewFieldListProps) {
  return (
    <>
      <div style={{ marginTop: 12 }}>
        <button
          type="button"
          style={secondaryButton(loading)}
          disabled={loading}
          onClick={onToggleFieldDetails}
        >
          {showFieldDetails ? "הסתר פרטים ועריכה" : "הצג פרטים ועריכה"}
        </button>
      </div>

      {showFieldDetails ? (
        <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
          <ReviewFieldRow
            label="סכום"
            missing={!isValidPositiveAmount(draft.amount)}
            displayValue={
              typeof draft.amount === "number" ? formatAmountDisplay(draft.amount) : ""
            }
            level={amountLevel}
            onPrimary={() => onEditField("amount", editReturnTarget)}
          />
          <ReviewFieldRow
            label="ספק"
            missing={!hasNonEmptyText(draft.vendorName)}
            displayValue={draft.vendorName}
            level={vendorLevel}
            onPrimary={() => onEditField("vendorName", editReturnTarget)}
          />
          <ReviewFieldRow
            label="תאריך"
            missing={!draft.date || !formatDateShort(draft.date)}
            displayValue={formatDateShort(draft.date)}
            level={dateLevel}
            onPrimary={() => onEditField("date", editReturnTarget)}
          />
          <ReviewFieldRow
            label="קטגוריה"
            missing={!hasNonEmptyText(draft.category)}
            displayValue={CATEGORY_MAP[draft.category] || draft.category}
            level={categoryLevel}
            onPrimary={() => onEditField("category", editReturnTarget)}
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
            level={directionLevel}
            onPrimary={() => onEditField("direction", editReturnTarget)}
          />
        </div>
      ) : null}
    </>
  );
}
