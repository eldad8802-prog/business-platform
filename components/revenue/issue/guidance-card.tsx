"use client";

import { useI18n } from "@/components/i18n/I18nProvider";

type Guidance = {
  why: string;
  tip: string;
  example: string;
  caution: string;
};

export default function GuidanceCard({ guidance }: { guidance: Guidance }) {
  const { t } = useI18n();
  return (
    <div
      style={{
        background: "var(--dz-surface)",
        borderRadius: 24,
        border: "1px solid var(--dz-border)",
        padding: 20,
        marginBottom: 16,
      }}
    >
      <div
        style={{
          fontSize: 16,
          fontWeight: 700,
          marginBottom: 12,
          color: "var(--dz-text-primary)",
        }}
      >
        {t("billing.couponIssue.guidanceTitle")}
      </div>

      <div style={{ display: "grid", gap: 10, fontSize: 14, lineHeight: 1.6 }}>
        <div>
          <strong>{t("billing.couponIssue.guidanceWhy")}</strong>
          <div style={{ color: "var(--dz-text-secondary)" }}>{guidance.why}</div>
        </div>

        <div>
          <strong>{t("billing.couponIssue.guidanceTip")}</strong>
          <div style={{ color: "var(--dz-text-secondary)" }}>{guidance.tip}</div>
        </div>

        <div>
          <strong>{t("billing.couponIssue.guidanceExample")}</strong>
          <div style={{ color: "var(--dz-text-secondary)" }}>{guidance.example}</div>
        </div>

        <div>
          <strong>{t("billing.couponIssue.guidanceCaution")}</strong>
          <div style={{ color: "var(--dz-danger)" }}>{guidance.caution}</div>
        </div>
      </div>
    </div>
  );
}