"use client";

import { PA } from "./platform-admin-styles";

type PlatformAdminInlineErrorProps = {
  message: string;
  onRetry?: () => void;
};

export function PlatformAdminInlineError({
  message,
  onRetry,
}: PlatformAdminInlineErrorProps) {
  return (
    <div
      style={{
        padding: "12px 14px",
        borderRadius: PA.radius,
        border: `1px solid ${PA.attention.border}`,
        background: PA.attention.bgSoft,
        color: PA.attention.ink,
        fontSize: 14,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        flexWrap: "wrap",
      }}
    >
      <span>{message}</span>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          style={{
            border: `1px solid ${PA.border}`,
            background: PA.cardBg,
            borderRadius: 8,
            padding: "6px 12px",
            cursor: "pointer",
            fontSize: 13,
            color: PA.ink,
          }}
        >
          נסה שוב
        </button>
      ) : null}
    </div>
  );
}
