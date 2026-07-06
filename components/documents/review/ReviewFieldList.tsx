"use client";

import { CATEGORY_MAP } from "@/lib/constants/categories";
import type {
  EditableField,
  ExtractionConfidenceMeta,
  ReviewDraft,
  TrafficLevel,
} from "@/lib/documents/review/types";
import { formatAmountDisplay, formatDateShort } from "@/lib/documents/review/format";
import { TOKEN } from "@/lib/design/documents-theme";
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

// The recognized details and their edit controls are a single "פרטים" card:
// each field always shows the value the system recognized, with the existing
// in-row edit (onEditField). No separate read-only card and no disclosure —
// the five fields appear exactly once.
export default function ReviewFieldList({
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
    <div style={fieldsCardStyle}>
      <div style={fieldsTitleStyle}>פרטים</div>
      <div style={{ display: "grid", gap: 10 }}>
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
    </div>
  );
}

const fieldsCardStyle = {
  marginTop: 16,
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  background: TOKEN.surface.card,
  borderRadius: TOKEN.radius.card,
  padding: 16,
  boxShadow: TOKEN.shadow.elevated,
};

const fieldsTitleStyle = {
  color: TOKEN.ink.primary,
  fontSize: TOKEN.font.title,
  fontWeight: TOKEN.weight.bold,
  marginBottom: 12,
};
