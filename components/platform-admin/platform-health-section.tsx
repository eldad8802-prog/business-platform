"use client";

import type { PlatformAdminOverviewResponse } from "@/lib/services/platform-admin/types";
import { PA } from "./platform-admin-styles";
import { PlatformAdminInlineError } from "./platform-admin-inline-error";

type PlatformHealthSectionProps = {
  overview: PlatformAdminOverviewResponse | null;
  error: string | null;
  onRetry: () => void;
};

type MetricDef = {
  key: string;
  label: string;
  value: number;
  alert?: boolean;
};

function buildMetrics(overview: PlatformAdminOverviewResponse): MetricDef[] {
  return [
    { key: "businesses", label: "עסקים", value: overview.totals.businesses },
    { key: "users", label: "משתמשים", value: overview.totals.users },
    {
      key: "open-conversations",
      label: "שיחות פתוחות",
      value: overview.conversations.open,
    },
    {
      key: "pdf-failed",
      label: "כשלי PDF",
      value: overview.billing.pdfRenderFailed,
      alert: overview.billing.pdfRenderFailed > 0,
    },
    {
      key: "docs-review",
      label: "מסמכים לבדיקה",
      value: overview.documents.needsReview,
      alert: overview.documents.needsReview > 0,
    },
    {
      key: "content-failed",
      label: "ריצות תוכן שנכשלו (7 ימים)",
      value: overview.content.runsFailedLast7d,
      alert: overview.content.runsFailedLast7d > 0,
    },
  ];
}

export function PlatformHealthSection({
  overview,
  error,
  onRetry,
}: PlatformHealthSectionProps) {
  return (
    <section aria-labelledby="pa-health-heading">
      <h2
        id="pa-health-heading"
        style={{
          margin: "0 0 12px",
          fontSize: 15,
          fontWeight: 600,
          color: PA.ink,
        }}
      >
        מצב מערכת
      </h2>
      {error ? (
        <PlatformAdminInlineError message={error} onRetry={onRetry} />
      ) : overview ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
            gap: 12,
          }}
        >
          {buildMetrics(overview).map((metric) => (
            <div
              key={metric.key}
              style={{
                padding: "14px 12px",
                borderRadius: PA.radius,
                border: `1px solid ${metric.alert ? PA.urgent.border : PA.border}`,
                background: PA.cardBg,
              }}
            >
              <div
                style={{
                  fontSize: 26,
                  fontWeight: 700,
                  color: metric.alert ? PA.urgent.ink : PA.ink,
                  lineHeight: 1.1,
                }}
              >
                {metric.value.toLocaleString("he-IL")}
              </div>
              <div
                style={{
                  marginTop: 6,
                  fontSize: 12,
                  color: PA.inkMuted,
                  lineHeight: 1.3,
                }}
              >
                {metric.label}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
