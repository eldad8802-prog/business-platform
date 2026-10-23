"use client";

import { TOKEN } from "@/lib/design/tokens";
import { useI18n } from "@/components/i18n/I18nProvider";

type Props = {
  value: string;
  onChange: (val: string) => void;
  onSubmit: () => void;
};

export default function RedeemInput({
  value,
  onChange,
  onSubmit,
}: Props) {
  const { t } = useI18n();
  return (
    <div
      style={{
        background: "var(--dz-surface)",
        padding: 20,
        borderRadius: 20,
        border: "1px solid var(--dz-border)",
      }}
    >
      <div
        style={{
          fontSize: 20,
          fontWeight: 700,
          marginBottom: 12,
        }}
      >
        {t("billing.redeem.title")}
      </div>

      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t("billing.redeem.enterCodePlaceholder")}
        style={{
          width: "100%",
          padding: "14px",
          borderRadius: 12,
          border: "1px solid var(--dz-border-strong)",
          marginBottom: 12,
          outline: "none",
          fontSize: 16,
          boxSizing: "border-box",
        }}
      />

      <button
        type="button"
        onClick={onSubmit}
        style={{
          width: "100%",
          padding: "14px",
          borderRadius: 12,
          border: "none",
          background: TOKEN.action.primary.background,
          color: "var(--dz-text-on-brand)",
          fontWeight: 700,
          fontSize: 16,
          cursor: "pointer",
        }}
      >
        {t("billing.redeem.checkCoupon")}
      </button>
    </div>
  );
}