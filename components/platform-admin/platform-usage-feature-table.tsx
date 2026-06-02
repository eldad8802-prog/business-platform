"use client";

import type { PlatformUsageOverviewResponse } from "@/lib/services/platform-admin/platform-usage-overview.service";
import {
  featureKeyLabel,
  formatCompletionRate,
} from "./platform-usage-labels";
import { PA } from "./platform-admin-styles";

type PlatformUsageFeatureTableProps = {
  featureRates: PlatformUsageOverviewResponse["featureRates"];
};

export function PlatformUsageFeatureTable({
  featureRates,
}: PlatformUsageFeatureTableProps) {
  if (featureRates.length === 0) {
    return (
      <p style={{ margin: 0, fontSize: 13, color: PA.inkMuted }}>
        אין עדיין נתוני פיצ׳רים בחלון הזמן.
      </p>
    );
  }

  const rows = [...featureRates].sort(
    (a, b) => b.opened + b.completed - (a.opened + a.completed)
  );

  return (
    <div
      style={{
        overflowX: "auto",
        WebkitOverflowScrolling: "touch",
        border: `1px solid ${PA.border}`,
        borderRadius: PA.radius,
        background: PA.cardBg,
      }}
    >
      <table
        style={{
          width: "100%",
          minWidth: 520,
          borderCollapse: "collapse",
          fontSize: 13,
        }}
      >
        <thead>
          <tr style={{ background: PA.pageBg }}>
            {["פיצ׳ר", "נפתח", "הושלם", "נכשל", "השלמה"].map((label) => (
              <th
                key={label}
                style={{
                  textAlign: "right",
                  padding: "10px 12px",
                  fontWeight: 600,
                  color: PA.inkSecondary,
                  borderBottom: `1px solid ${PA.border}`,
                }}
              >
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.featureKey}>
              <td
                style={{
                  padding: "10px 12px",
                  borderBottom: `1px solid ${PA.border}`,
                  fontWeight: 600,
                  color: PA.ink,
                }}
              >
                {featureKeyLabel(row.featureKey)}
              </td>
              <td style={{ padding: "10px 12px", borderBottom: `1px solid ${PA.border}` }}>
                {row.opened}
              </td>
              <td style={{ padding: "10px 12px", borderBottom: `1px solid ${PA.border}` }}>
                {row.completed}
              </td>
              <td style={{ padding: "10px 12px", borderBottom: `1px solid ${PA.border}` }}>
                {row.failed}
              </td>
              <td style={{ padding: "10px 12px", borderBottom: `1px solid ${PA.border}` }}>
                {formatCompletionRate(row.completionRate)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
