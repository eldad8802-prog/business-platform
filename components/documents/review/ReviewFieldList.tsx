"use client";

import { useI18n } from "@/components/i18n/I18nProvider";
import { categoryLabel } from "@/lib/documents/category-label";
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
  const { t, locale } = useI18n();
  return (
    <div style={fieldsCardStyle}>
      <div style={fieldsTitleStyle}>{t("documents.review.fields.details")}</div>
      <div style={{ display: "grid", gap: 10 }}>
        <ReviewFieldRow
          label={t("documents.review.fields.amount")}
          missing={!isValidPositiveAmount(draft.amount)}
          displayValue={
            typeof draft.amount === "number" ? formatAmountDisplay(draft.amount, locale) : ""
          }
          level={amountLevel}
          onPrimary={() => onEditField("amount", editReturnTarget)}
        />
        <ReviewFieldRow
          label={t("documents.review.fields.vendor")}
          missing={!hasNonEmptyText(draft.vendorName)}
          displayValue={draft.vendorName}
          level={vendorLevel}
          onPrimary={() => onEditField("vendorName", editReturnTarget)}
        />
        <ReviewFieldRow
          label={t("documents.review.fields.date")}
          missing={!draft.date || !formatDateShort(draft.date)}
          displayValue={formatDateShort(draft.date, locale)}
          level={dateLevel}
          onPrimary={() => onEditField("date", editReturnTarget)}
        />
        <ReviewFieldRow
          label={t("documents.review.fields.category")}
          missing={!hasNonEmptyText(draft.category)}
          displayValue={categoryLabel(t, draft.category)}
          level={categoryLevel}
          onPrimary={() => onEditField("category", editReturnTarget)}
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
