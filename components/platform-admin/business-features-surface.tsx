"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { PlatformAdminSessionResponse } from "@/lib/services/platform-admin/types";
import type { PlatformAdminBusinessFeaturesResponse } from "@/lib/services/feature-access/feature-access.types";
import type { FeatureAccessDisplayState } from "@/lib/services/feature-access/feature-access-display";
import {
  PlatformAdminFetchError,
  fetchPlatformAdminBusinessFeatures,
} from "@/lib/platform-admin/fetch-platform-admin";
import { PA } from "./platform-admin-styles";
import { PlatformAdminNav } from "./platform-admin-nav";
import { PlatformAdminSkeleton } from "./platform-admin-skeleton";
import { PlatformAdminInlineError } from "./platform-admin-inline-error";
import { PlatformAdminEmptyState } from "./platform-admin-empty-state";
import { formatRelativeTime } from "./platform-usage-labels";
import { BusinessFeatureEditPanel } from "./business-feature-edit-panel";

type BusinessFeaturesSurfaceProps = {
  session: PlatformAdminSessionResponse;
  businessId: number;
};

function displayStateAccent(state: FeatureAccessDisplayState): string {
  switch (state) {
    case "emergency":
      return PA.urgent.accent;
    case "disabled":
      return PA.attention.accent;
    case "enabled":
      return PA.success.accent;
    case "inherited":
      return PA.inkMuted;
    case "immutable":
      return PA.info.accent;
  }
}

function SummaryTile({ label, value }: { label: string; value: number }) {
  return (
    <div
      style={{
        padding: "12px 14px",
        border: `1px solid ${PA.border}`,
        borderRadius: PA.radius,
        background: PA.cardBg,
      }}
    >
      <div style={{ fontSize: 12, color: PA.inkMuted, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600, color: PA.ink }}>{value}</div>
    </div>
  );
}

export function BusinessFeaturesSurface({
  session,
  businessId,
}: BusinessFeaturesSurfaceProps) {
  const [data, setData] = useState<PlatformAdminBusinessFeaturesResponse | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingFeatureKey, setEditingFeatureKey] = useState<string | null>(
    null
  );

  const load = useCallback(async () => {
    if (!businessId || Number.isNaN(businessId)) {
      setError("מזהה עסק לא תקין");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await fetchPlatformAdminBusinessFeatures(businessId);
      setData(result);
    } catch (e) {
      setData(null);
      setError(
        e instanceof PlatformAdminFetchError
          ? e.message
          : "לא ניתן לטעון גישת פיצ׳רים"
      );
    } finally {
      setLoading(false);
    }
  }, [businessId]);

  const handleSaved = useCallback(() => {
    setEditingFeatureKey(null);
    void load();
  }, [load]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !data) {
    return (
      <main
        style={{
          maxWidth: PA.maxWidth,
          margin: "0 auto",
          padding: "24px 20px 48px",
        }}
      >
        <PlatformAdminSkeleton />
      </main>
    );
  }

  return (
    <main
      style={{
        maxWidth: PA.maxWidth,
        margin: "0 auto",
        padding: "24px 20px 48px",
      }}
    >
      <PlatformAdminNav />

      <header
        style={{
          marginBottom: 24,
          paddingBottom: 16,
          borderBottom: `1px solid ${PA.border}`,
        }}
      >
        <Link
          href={`/admin/businesses/${businessId}`}
          style={{
            fontSize: 13,
            color: PA.inkMuted,
            textDecoration: "none",
            display: "inline-block",
            marginBottom: 8,
          }}
        >
          ← פרטי עסק
        </Link>
        {error ? (
          <PlatformAdminInlineError message={error} onRetry={() => void load()} />
        ) : data ? (
          <>
            <h1
              style={{
                margin: "0 0 6px",
                fontSize: 22,
                fontWeight: 700,
                color: PA.ink,
              }}
            >
              גישת פיצ׳רים · {data.business.name}
            </h1>
            <p style={{ margin: 0, fontSize: 13, color: PA.inkMuted }}>
              עסק #{data.business.id}
            </p>
          </>
        ) : null}
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          style={{
            marginTop: 12,
            border: `1px solid ${PA.border}`,
            background: PA.cardBg,
            borderRadius: 8,
            padding: "8px 14px",
            fontSize: 13,
            cursor: loading ? "wait" : "pointer",
          }}
        >
          רענון
        </button>
      </header>

      {data ? (
        <>
          <section aria-labelledby="bf-summary" style={{ marginBottom: 28 }}>
            <h2
              id="bf-summary"
              style={{
                margin: "0 0 12px",
                fontSize: 15,
                fontWeight: 600,
                color: PA.ink,
              }}
            >
              סיכום
            </h2>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))",
                gap: 12,
              }}
            >
              <SummaryTile label="פתוחים" value={data.summary.enabledCount} />
              <SummaryTile label="סגורים" value={data.summary.disabledCount} />
              <SummaryTile
                label="עם הגדרה מיוחדת"
                value={data.summary.overriddenCount}
              />
              <SummaryTile label="סה״כ" value={data.summary.total} />
            </div>
          </section>

          {data.groups.length === 0 ? (
            <PlatformAdminEmptyState title="אין פיצ׳רים להצגה" />
          ) : (
            data.groups.map((group) => (
              <section
                key={group.groupKey}
                aria-labelledby={`bf-group-${group.groupKey}`}
                style={{ marginBottom: 28 }}
              >
                <h2
                  id={`bf-group-${group.groupKey}`}
                  style={{
                    margin: "0 0 12px",
                    fontSize: 15,
                    fontWeight: 600,
                    color: PA.ink,
                  }}
                >
                  {group.groupLabel}
                  <span
                    style={{
                      marginRight: 8,
                      fontSize: 12,
                      fontWeight: 400,
                      color: PA.inkMuted,
                    }}
                  >
                    ({group.features.length})
                  </span>
                </h2>
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
                  {group.features.map((feature) => (
                    <li
                      key={feature.featureKey}
                      style={{
                        padding: "12px 14px",
                        border: `1px solid ${PA.border}`,
                        borderRight: `3px solid ${displayStateAccent(feature.displayState)}`,
                        borderRadius: PA.radius,
                        background: PA.cardBg,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          flexWrap: "wrap",
                          justifyContent: "space-between",
                          gap: 8,
                          marginBottom: 6,
                        }}
                      >
                        <div>
                          <div
                            style={{
                              fontWeight: 600,
                              fontSize: 14,
                              color: PA.ink,
                            }}
                          >
                            {feature.displayName}
                          </div>
                          <div
                            style={{
                              fontSize: 12,
                              color: PA.inkMuted,
                              fontFamily: "ui-monospace, monospace",
                            }}
                          >
                            {feature.featureKey} · {feature.categoryLabel}
                          </div>
                        </div>
                        <div style={{ textAlign: "left" }}>
                          <span
                            style={{
                              fontSize: 13,
                              fontWeight: 600,
                              color: feature.allowed
                                ? PA.success.accent
                                : PA.attention.accent,
                            }}
                          >
                            {feature.effectiveLabel}
                          </span>
                          <div
                            style={{
                              fontSize: 11,
                              color: PA.inkMeta,
                              marginTop: 2,
                            }}
                          >
                            {feature.displayStateLabel}
                          </div>
                        </div>
                      </div>
                      <p
                        style={{
                          margin: "0 0 8px",
                          fontSize: 12,
                          color: PA.inkSecondary,
                        }}
                      >
                        {feature.description}
                      </p>
                      <div
                        style={{
                          display: "flex",
                          flexWrap: "wrap",
                          gap: "8px 16px",
                          fontSize: 11,
                          color: PA.inkMuted,
                        }}
                      >
                        <span>{feature.sourceLabel}</span>
                        <span>{feature.reasonLabel}</span>
                        <span>
                          ברירת מחדל של המערכת:{" "}
                          {feature.globalEnabled ? "פתוח" : "סגור"}
                        </span>
                        {feature.emergencyDisabled ? (
                          <span>כבוי זמנית לכל העסקים</span>
                        ) : null}
                        <span>{feature.overrideLabel}</span>
                        <span>{feature.mutableLabel}</span>
                      </div>

                      {feature.mutable ? (
                        editingFeatureKey === feature.featureKey ? (
                          <BusinessFeatureEditPanel
                            businessId={businessId}
                            feature={feature}
                            onCancel={() => setEditingFeatureKey(null)}
                            onSaved={handleSaved}
                          />
                        ) : (
                          <button
                            type="button"
                            onClick={() =>
                              setEditingFeatureKey(feature.featureKey)
                            }
                            style={{
                              marginTop: 10,
                              border: `1px solid ${PA.border}`,
                              background: PA.cardBg,
                              borderRadius: 8,
                              padding: "6px 12px",
                              fontSize: 12,
                              color: PA.ink,
                              cursor: "pointer",
                            }}
                          >
                            שינוי גישה
                          </button>
                        )
                      ) : (
                        <div
                          style={{
                            marginTop: 10,
                            fontSize: 11,
                            color: PA.inkMeta,
                          }}
                        >
                          פיצ׳ר בסיסי שלא ניתן לשינוי
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}

          <p style={{ fontSize: 11, color: PA.inkMeta }}>
            כל שינוי מתועד באודיט · {session.admin.email} · עודכן{" "}
            {formatRelativeTime(data.generatedAt)}
          </p>
        </>
      ) : null}
    </main>
  );
}
