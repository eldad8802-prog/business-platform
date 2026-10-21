"use client";

import { useI18n } from "@/components/i18n/I18nProvider";

export default function RedeemLoading() {
  const { t } = useI18n();
  return (
    <div
      style={{
        background: "var(--dz-surface)",
        padding: 20,
        borderRadius: 20,
        border: "1px solid var(--dz-border)",
        textAlign: "center",
      }}
    >
      <div
        style={{
          fontSize: 18,
          fontWeight: 700,
          marginBottom: 8,
          color: "var(--dz-text-primary)",
        }}
      >
        {t("billing.redeem.checking")}
      </div>

      <div
        style={{
          fontSize: 14,
          color: "var(--dz-text-muted)",
        }}
      >
        {t("billing.redeem.pleaseWait")}
      </div>
    </div>
  );
}