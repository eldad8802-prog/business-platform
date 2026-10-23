"use client";

import { useI18n } from "@/components/i18n/I18nProvider";

export default function IssueHeader() {
  const { t } = useI18n();
  return (
    <div style={{ marginBottom: 24 }}>
      <div
        style={{
          fontSize: 14,
          fontWeight: 700,
          color: "var(--dz-text-muted)",
          marginBottom: 8,
        }}
      >
        Revenue Activation
      </div>

      <h1
        style={{
          margin: 0,
          fontSize: 32,
          lineHeight: 1.1,
          color: "var(--dz-text-primary)",
        }}
      >
        {t("billing.couponIssue.title")}
      </h1>

      <p
        style={{
          marginTop: 12,
          marginBottom: 0,
          fontSize: 16,
          lineHeight: 1.6,
          color: "var(--dz-text-secondary)",
        }}
      >
        {t("billing.couponIssue.subtitle")}
      </p>
    </div>
  );
}