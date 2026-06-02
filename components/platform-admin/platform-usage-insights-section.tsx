"use client";

import type { PlatformUsageOverviewResponse } from "@/lib/services/platform-admin/platform-usage-overview.service";
import { PlatformAdminEmptyState } from "./platform-admin-empty-state";
import { PlatformAdminInlineError } from "./platform-admin-inline-error";
import { PlatformUsageLoginSummary } from "./platform-usage-login-summary";
import { PlatformUsageFeatureTable } from "./platform-usage-feature-table";
import { PlatformUsageFrictionList } from "./platform-usage-friction-list";
import { PA } from "./platform-admin-styles";

type PlatformUsageInsightsSectionProps = {
  usage: PlatformUsageOverviewResponse | null;
  error: string | null;
  loading: boolean;
  onRetry: () => void;
};

function UsageSkeleton() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))",
          gap: 10,
        }}
      >
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            style={{
              height: 64,
              borderRadius: PA.radius,
              background: PA.pageBg,
              animation: "pa-pulse 1.4s ease-in-out infinite",
            }}
          />
        ))}
      </div>
      <div
        style={{
          height: 120,
          borderRadius: PA.radius,
          background: PA.pageBg,
          animation: "pa-pulse 1.4s ease-in-out infinite",
        }}
      />
    </div>
  );
}

export function PlatformUsageInsightsSection({
  usage,
  error,
  loading,
  onRetry,
}: PlatformUsageInsightsSectionProps) {
  return (
    <section aria-labelledby="pa-usage-heading">
      <div style={{ marginBottom: 12 }}>
        <h2
          id="pa-usage-heading"
          style={{
            margin: "0 0 4px",
            fontSize: 15,
            fontWeight: 600,
            color: PA.ink,
          }}
        >
          Usage Insights
        </h2>
        <p style={{ margin: 0, fontSize: 12, color: PA.inkMeta }}>
          חלון {usage?.windowDays ?? 7} ימים · נתונים מהשרת בלבד
        </p>
      </div>

      {error ? (
        <PlatformAdminInlineError message={error} onRetry={onRetry} />
      ) : loading && !usage ? (
        <UsageSkeleton />
      ) : usage && !usage.hasInsights ? (
        <PlatformAdminEmptyState
          title="עדיין אין מספיק נתוני שימוש להצגת תובנות"
          detail="כשיתחילו התחברויות ופעילות בפיצ׳רים, התובנות יופיעו כאן."
        />
      ) : usage ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <div>
            <h3
              style={{
                margin: "0 0 10px",
                fontSize: 13,
                fontWeight: 600,
                color: PA.inkSecondary,
              }}
            >
              Login Activity
            </h3>
            <PlatformUsageLoginSummary usage={usage} />
          </div>

          <div>
            <h3
              style={{
                margin: "0 0 10px",
                fontSize: 13,
                fontWeight: 600,
                color: PA.inkSecondary,
              }}
            >
              Top Features
            </h3>
            <PlatformUsageFeatureTable featureRates={usage.featureRates} />
          </div>

          <div>
            <h3
              style={{
                margin: "0 0 10px",
                fontSize: 13,
                fontWeight: 600,
                color: PA.inkSecondary,
              }}
            >
              Friction Signals
            </h3>
            <PlatformUsageFrictionList items={usage.frictionCandidates} />
          </div>
        </div>
      ) : null}
    </section>
  );
}
