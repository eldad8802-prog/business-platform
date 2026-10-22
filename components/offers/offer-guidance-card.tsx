"use client";

import { useI18n } from "@/components/i18n/I18nProvider";

type Guidance = {
  tip: string;
  example: string;
  insight: string;
};

export default function OfferGuidanceCard({
  guidance,
}: {
  guidance: Guidance;
}) {
  const { t } = useI18n();
  return (
    <div
      style={{
        background: "var(--dz-surface)",
        borderRadius: 20,
        padding: 18,
        border: "1px solid var(--dz-border)",
        marginBottom: 16,
      }}
    >
      <div
        style={{
          fontWeight: 800,
          marginBottom: 12,
          fontSize: 16,
          color: "var(--dz-text-primary)",
        }}
      >
        {t("content.commerce.offers.guidance.title")}
      </div>

      <div style={{ marginBottom: 12 }}>
        <strong>{t("content.commerce.offers.guidance.tip")}</strong>
        <div
          style={{
            marginTop: 4,
            color: "var(--dz-text-secondary)",
            lineHeight: 1.6,
            fontSize: 14,
          }}
        >
          {guidance.tip}
        </div>
      </div>

      <div style={{ marginBottom: 12 }}>
        <strong>{t("content.commerce.offers.guidance.example")}</strong>
        <div
          style={{
            marginTop: 4,
            color: "var(--dz-text-secondary)",
            lineHeight: 1.6,
            fontSize: 14,
          }}
        >
          {guidance.example}
        </div>
      </div>

      <div style={{ marginBottom: 0 }}>
        <strong>{t("content.commerce.offers.guidance.insight")}</strong>
        <div
          style={{
            marginTop: 4,
            color: "var(--dz-text-secondary)",
            lineHeight: 1.6,
            fontSize: 14,
          }}
        >
          {guidance.insight}
        </div>
      </div>
    </div>
  );
}