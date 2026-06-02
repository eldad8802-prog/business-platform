"use client";

import type { PlatformUsageOverviewResponse } from "@/lib/services/platform-admin/platform-usage-overview.service";
import {
  featureKeyLabel,
  formatCompletionRate,
  frictionReasonLabel,
} from "./platform-usage-labels";
import { PA, severityColors } from "./platform-admin-styles";

type PlatformUsageFrictionListProps = {
  items: PlatformUsageOverviewResponse["frictionCandidates"];
};

export function PlatformUsageFrictionList({
  items,
}: PlatformUsageFrictionListProps) {
  if (items.length === 0) {
    return (
      <p style={{ margin: 0, fontSize: 13, color: PA.inkMuted }}>
        לא זוהו אותות חיכוך משמעותיים בחלון הנוכחי.
      </p>
    );
  }

  return (
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
      {items.map((item) => {
        const colors = severityColors(
          item.reason === "high_failure_rate" ? "high" : "medium"
        );
        return (
          <li
            key={item.featureKey}
            style={{
              padding: "12px 14px",
              borderRadius: PA.radius,
              border: `1px solid ${PA.border}`,
              background: PA.cardBg,
              borderRightWidth: 4,
              borderRightColor: colors.accent,
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 600, color: PA.ink }}>
              {featureKeyLabel(item.featureKey)}
            </div>
            <div style={{ marginTop: 4, fontSize: 13, color: PA.inkSecondary }}>
              {frictionReasonLabel(item.reason)} · השלמה{" "}
              {formatCompletionRate(item.completionRate)} · נפתח {item.opened} · נכשל{" "}
              {item.failed}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
