"use client";

import { TOKEN } from "@/lib/design/tokens";
import { useI18n } from "@/components/i18n/I18nProvider";

type Props = {
  result: any;
  onReset: () => void;
};

export default function RedeemSuccess({ result, onReset }: Props) {
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
          fontSize: 20,
          fontWeight: 700,
          marginBottom: 10,
        }}
      >
        {t("billing.redeem.redeemedSuccess")}
      </div>

      <div style={{ marginBottom: 16 }}>
        {result?.coupon?.offer?.title || ""}
      </div>

      <button
        onClick={onReset}
        style={{
          padding: "12px 16px",
          borderRadius: 12,
          background: TOKEN.action.primary.background,
          color: "var(--dz-text-on-brand)",
          cursor: "pointer",
        }}
      >
        {t("billing.redeem.redeemAnother")}
      </button>
    </div>
  );
}