"use client";

import type { PlatformUsageOverviewResponse } from "@/lib/services/platform-admin/platform-usage-overview.service";
import { formatRelativeTime } from "./platform-usage-labels";
import { PA } from "./platform-admin-styles";

type PlatformUsageLoginSummaryProps = {
  usage: PlatformUsageOverviewResponse;
};

function MetricTile({ label, value }: { label: string; value: string | number }) {
  return (
    <div
      style={{
        padding: "12px 14px",
        borderRadius: PA.radius,
        border: `1px solid ${PA.border}`,
        background: PA.cardBg,
      }}
    >
      <div style={{ fontSize: 22, fontWeight: 700, color: PA.ink }}>{value}</div>
      <div style={{ marginTop: 4, fontSize: 12, color: PA.inkMuted }}>{label}</div>
    </div>
  );
}

export function PlatformUsageLoginSummary({ usage }: PlatformUsageLoginSummaryProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))",
          gap: 10,
        }}
      >
        <MetricTile label="משתמשים פעילים (7 ימים)" value={usage.activity.activeUsers} />
        <MetricTile
          label="עסקים פעילים (7 ימים)"
          value={usage.activity.activeBusinesses}
        />
        <MetricTile label="התחברויות מוצלחות (7 ימים)" value={usage.logins.successCount} />
        <MetricTile label="כשלי התחברות (7 ימים)" value={usage.logins.failureCount} />
      </div>

      {usage.lastLoginActivity.length > 0 ? (
        <div
          style={{
            borderRadius: PA.radius,
            border: `1px solid ${PA.border}`,
            background: PA.cardBg,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              padding: "10px 12px",
              fontSize: 12,
              fontWeight: 600,
              color: PA.inkSecondary,
              borderBottom: `1px solid ${PA.border}`,
              background: PA.pageBg,
            }}
          >
            התחברויות אחרונות
          </div>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {usage.lastLoginActivity.map((row) => (
              <li
                key={row.userId}
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  justifyContent: "space-between",
                  gap: 8,
                  padding: "10px 12px",
                  borderBottom: `1px solid ${PA.border}`,
                  fontSize: 13,
                }}
              >
                <span style={{ color: PA.ink }}>
                  {row.email}
                  <span style={{ color: PA.inkMeta, marginRight: 6 }}>
                    {" "}
                    · {row.businessName}
                  </span>
                </span>
                <span style={{ color: PA.inkMuted }}>
                  {formatRelativeTime(row.lastLoginAt)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p style={{ margin: 0, fontSize: 13, color: PA.inkMuted }}>
          אין עדיין רישום התחברות אחרונה.
        </p>
      )}
    </div>
  );
}
