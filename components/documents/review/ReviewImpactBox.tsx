"use client";

import ReviewTrustChecklistItem from "./ReviewTrustChecklistItem";
import { TOKEN } from "@/lib/design/documents-theme";
import { useI18n } from "@/components/i18n/I18nProvider";

export default function ReviewImpactBox({ approvalImpact }: { approvalImpact: string }) {
  const { t } = useI18n();
  return (
    <div
      style={{
        border: `1px solid ${TOKEN.border.DEFAULT}`,
        background: TOKEN.surface.inset,
        borderRadius: TOKEN.radius.card,
        padding: 16,
      }}
    >
      <div style={{ color: TOKEN.ink.primary, fontSize: 16, fontWeight: 950, marginBottom: 10 }}>
        {t("documents.review.impact.title")}
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        <ReviewTrustChecklistItem>{t("documents.review.impact.saved")}</ReviewTrustChecklistItem>
        <ReviewTrustChecklistItem>{t("documents.review.impact.searchable")}</ReviewTrustChecklistItem>
        <ReviewTrustChecklistItem>{t("documents.review.impact.accountant")}</ReviewTrustChecklistItem>
        <ReviewTrustChecklistItem>{approvalImpact}</ReviewTrustChecklistItem>
      </div>
    </div>
  );
}
