"use client";

import { TOKEN } from "@/lib/design/documents-theme";
import { useI18n } from "@/components/i18n/I18nProvider";

export default function ReviewPreviewFallback({
  vendorDisplay,
}: {
  vendorDisplay: string;
  amountDisplay: string;
  dateDisplay: string;
  categoryDisplay: string;
  directionDisplay: string;
}) {
  const { t } = useI18n();
  return (
    <>
      <div style={{ textAlign: "center", fontSize: 24, fontWeight: 950, color: TOKEN.ink.primary }}>
        {vendorDisplay}
      </div>
      <div
        style={{
          textAlign: "center",
          color: TOKEN.ink.muted,
          fontSize: 13,
          fontWeight: 600,
          marginTop: 8,
        }}
      >
        {t("documents.review.preview.source")}
      </div>
      <div
        style={{
          marginTop: 24,
          border: `1px dashed ${TOKEN.border.DEFAULT}`,
          borderRadius: TOKEN.radius.card,
          background: TOKEN.surface.inset,
          padding: 18,
          color: TOKEN.ink.muted,
          fontSize: 14,
          fontWeight: 600,
          lineHeight: 1.6,
        }}
      >
        {t("documents.review.preview.fallbackBody")}
      </div>
    </>
  );
}
