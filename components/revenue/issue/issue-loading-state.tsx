"use client";

import { useI18n } from "@/components/i18n/I18nProvider";

export default function IssueLoadingState() {
  const { t } = useI18n();
  return (
    <div
      style={{
        background: "var(--dz-surface)",
        borderRadius: 24,
        border: "1px solid var(--dz-border)",
        padding: 24,
        textAlign: "center",
      }}
    >
      <div
        style={{
          fontSize: 18,
          fontWeight: 700,
          color: "var(--dz-text-primary)",
          marginBottom: 10,
        }}
      >
        {t("billing.couponIssue.creating")}
      </div>

      <div
        style={{
          fontSize: 15,
          color: "var(--dz-text-muted)",
        }}
      >
        {t("billing.couponIssue.creatingHelp")}
      </div>
    </div>
  );
}