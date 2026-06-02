"use client";

import { PA } from "./platform-admin-styles";

type PlatformAdminEmptyStateProps = {
  title: string;
  detail?: string;
};

export function PlatformAdminEmptyState({
  title,
  detail,
}: PlatformAdminEmptyStateProps) {
  return (
    <div
      style={{
        padding: "20px 16px",
        borderRadius: PA.radius,
        border: `1px dashed ${PA.border}`,
        background: PA.cardBg,
        textAlign: "center",
      }}
    >
      <p style={{ margin: 0, fontSize: 15, fontWeight: 600, color: PA.ink }}>
        {title}
      </p>
      {detail ? (
        <p style={{ margin: "8px 0 0", fontSize: 13, color: PA.inkMuted }}>
          {detail}
        </p>
      ) : null}
    </div>
  );
}
