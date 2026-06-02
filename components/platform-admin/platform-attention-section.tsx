"use client";

import type { PlatformAdminAttentionResponse } from "@/lib/services/platform-admin/types";
import {
  categoryLabel,
  PA,
  severityColors,
} from "./platform-admin-styles";
import { PlatformAdminEmptyState } from "./platform-admin-empty-state";
import { PlatformAdminInlineError } from "./platform-admin-inline-error";

type PlatformAttentionSectionProps = {
  attention: PlatformAdminAttentionResponse | null;
  error: string | null;
  onRetry: () => void;
};

export function PlatformAttentionSection({
  attention,
  error,
  onRetry,
}: PlatformAttentionSectionProps) {
  return (
    <section aria-labelledby="pa-attention-heading">
      <h2
        id="pa-attention-heading"
        style={{
          margin: "0 0 12px",
          fontSize: 15,
          fontWeight: 600,
          color: PA.ink,
        }}
      >
        דורש תשומת לב
      </h2>
      {error ? (
        <PlatformAdminInlineError message={error} onRetry={onRetry} />
      ) : attention ? (
        attention.items.length === 0 ? (
          <PlatformAdminEmptyState
            title="אין פריטים שדורשים תשומת לב כרגע"
            detail="המערכת שקטה מבחינה תפעולית."
          />
        ) : (
          <ul
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            {attention.items.map((item) => {
              const colors = severityColors(item.severity);
              return (
                <li
                  key={item.id}
                  style={{
                    display: "flex",
                    gap: 12,
                    padding: "12px 14px",
                    borderRadius: PA.radius,
                    border: `1px solid ${PA.border}`,
                    background: PA.cardBg,
                    borderRightWidth: 4,
                    borderRightColor: colors.accent,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        display: "flex",
                        flexWrap: "wrap",
                        gap: 8,
                        alignItems: "center",
                        marginBottom: 4,
                      }}
                    >
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 600,
                          color: colors.ink,
                          background: colors.bgSoft,
                          border: `1px solid ${colors.border}`,
                          borderRadius: 6,
                          padding: "2px 8px",
                        }}
                      >
                        {categoryLabel(item.category)}
                      </span>
                      {item.businessName ? (
                        <span style={{ fontSize: 12, color: PA.inkMuted }}>
                          {item.businessName}
                        </span>
                      ) : null}
                    </div>
                    <div
                      style={{
                        fontSize: 14,
                        fontWeight: 600,
                        color: PA.ink,
                      }}
                    >
                      {item.title}
                    </div>
                    {item.detail ? (
                      <div
                        style={{
                          marginTop: 4,
                          fontSize: 13,
                          color: PA.inkSecondary,
                        }}
                      >
                        {item.detail}
                      </div>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )
      ) : null}
    </section>
  );
}
