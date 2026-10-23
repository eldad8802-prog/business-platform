"use client";

import ReviewExtractedDetailRow from "./ReviewExtractedDetailRow";
import { TOKEN } from "@/lib/design/documents-theme";
import { useI18n } from "@/components/i18n/I18nProvider";

export default function ReviewAiExtractedCard({
  vendorDisplay,
  amountDisplay,
  dateDisplay,
  categoryDisplay,
  directionDisplay,
}: {
  vendorDisplay: string;
  amountDisplay: string;
  dateDisplay: string;
  categoryDisplay: string;
  directionDisplay: string;
}) {
  const { t } = useI18n();
  return (
    <div
      style={{
        border: `1px solid ${TOKEN.border.DEFAULT}`,
        background: TOKEN.surface.card,
        borderRadius: TOKEN.radius.card,
        padding: 16,
        boxShadow: TOKEN.shadow.elevated,
      }}
    >
      <div
        style={{
          color: TOKEN.ink.primary,
          fontSize: TOKEN.font.title,
          fontWeight: TOKEN.weight.bold,
          marginBottom: 10,
        }}
      >
        {t("documents.review.fields.detected")}
      </div>
      <ReviewExtractedDetailRow icon="•" label={t("documents.review.fields.vendor")} value={vendorDisplay} />
      <ReviewExtractedDetailRow icon="•" label={t("documents.review.fields.amount")} value={amountDisplay} />
      <ReviewExtractedDetailRow icon="•" label={t("documents.review.fields.date")} value={dateDisplay} />
      <ReviewExtractedDetailRow icon="•" label={t("documents.review.fields.category")} value={categoryDisplay} />
      <ReviewExtractedDetailRow icon="•" label={t("documents.review.fields.direction")} value={directionDisplay} />
    </div>
  );
}
