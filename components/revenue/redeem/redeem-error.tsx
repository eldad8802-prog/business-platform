"use client";

import { TOKEN } from "@/lib/design/tokens";
import { useI18n } from "@/components/i18n/I18nProvider";

type Props = {
  message: string;
  onRetry: () => void;
};

export default function RedeemError({ message, onRetry }: Props) {
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
          marginBottom: 10,
          color: "var(--dz-danger)",
        }}
      >
        {t("billing.redeem.errorTitle")}
      </div>

      <div
        style={{
          marginBottom: 16,
          color: "var(--dz-text-secondary)",
          lineHeight: 1.5,
        }}
      >
        {message}
      </div>

      <button
        type="button"
        onClick={onRetry}
        style={{
          padding: "12px 16px",
          borderRadius: 12,
          border: "none",
          background: TOKEN.action.primary.background,
          color: "var(--dz-text-on-brand)",
          fontWeight: 700,
          cursor: "pointer",
        }}
      >
        {t("billing.redeem.tryAgain")}
      </button>
    </div>
  );
}