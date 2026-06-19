"use client";

import { CATEGORY_MAP } from "@/lib/constants/categories";
import type {
  EditableField,
  ExtractionConfidenceMeta,
  ReviewDraft,
  TrafficLevel,
} from "@/lib/documents/review/types";
import { formatAmountDisplay, formatDateShort } from "@/lib/documents/review/format";
import { TOKEN } from "@/lib/design/tokens";
import { hasNonEmptyText, isValidPositiveAmount } from "@/lib/documents/review/validation";
import ReviewFieldRow from "./ReviewFieldRow";

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
      <div style={fieldDisclosureBoxStyle}>
        <div>
          <div style={fieldDisclosureTitleStyle}>פרטים לעריכה</div>
          <div style={fieldDisclosureTextStyle}>
            פתח רק אם צריך להשלים או לתקן את הנתונים לפני האישור.
          </div>
        </div>
        <button
          type="button"
          style={fieldDisclosureButtonStyle}
          disabled={loading}
          onClick={onToggleFieldDetails}
        >
          {showFieldDetails ? "הסתר פרטים ועריכה" : "בדוק או ערוך פרטים"}
        </button>
      </div>

      {showFieldDetails ? (
        <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
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

const fieldDisclosureBoxStyle = {
  marginTop: 16,
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  background: TOKEN.surface.inset,
  borderRadius: TOKEN.radius.card,
  padding: 14,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  flexWrap: "wrap" as const,
};

const fieldDisclosureTitleStyle = {
  color: TOKEN.ink.primary,
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.bold,
};

const fieldDisclosureTextStyle = {
  marginTop: 4,
  color: TOKEN.ink.muted,
  fontSize: TOKEN.font.meta,
  fontWeight: TOKEN.weight.semibold,
  lineHeight: 1.5,
};

const fieldDisclosureButtonStyle = {
  minHeight: 44,
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  borderRadius: TOKEN.radius.button,
  background: TOKEN.surface.card,
  color: TOKEN.brand.mid,
  padding: "0 14px",
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.bold,
  cursor: "pointer",
};
