"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { PlatformAdminSessionResponse } from "@/lib/services/platform-admin/types";
import type {
  BusinessOperationalStatus,
  PlatformAdminBusinessDetailResponse,
} from "@/lib/services/platform-admin/platform-business-detail.types";
import {
  PlatformAdminFetchError,
  fetchPlatformAdminBusinessDetail,
} from "@/lib/platform-admin/fetch-platform-admin";
import {
  categoryLabel,
  PA,
  severityColors,
} from "./platform-admin-styles";
import { PlatformAdminSkeleton } from "./platform-admin-skeleton";
import { PlatformAdminInlineError } from "./platform-admin-inline-error";
import { PlatformAdminEmptyState } from "./platform-admin-empty-state";
import {
  featureKeyLabel,
  formatRelativeTime,
} from "./platform-usage-labels";

type BusinessDetailSurfaceProps = {
  session: PlatformAdminSessionResponse;
  businessId: number;
};

function operationalStatusColor(status: BusinessOperationalStatus): string {
  switch (status) {
    case "healthy":
      return PA.success.accent;
    case "attention_needed":
      return PA.info.accent;
    case "struggling":
      return PA.attention.accent;
    case "inactive":
      return PA.inkMuted;
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("he-IL", {
      dateStyle: "short",
      timeStyle: "short",
    });
  } catch {
    return iso;
  }
}

function MetricTile({
  label,
  value,
  alert,
}: {
  label: string;
  value: string | number;
  alert?: boolean;
}) {
  return (
    <div
      style={{
        padding: "12px 14px",
        border: `1px solid ${PA.border}`,
        borderRadius: PA.radius,
        background: PA.cardBg,
      }}
    >
      <div style={{ fontSize: 12, color: PA.inkMuted, marginBottom: 4 }}>
        {label}
      </div>
      <div
        style={{
          fontSize: 20,
          fontWeight: 600,
          color: alert ? PA.attention.accent : PA.ink,
        }}
      >
        {value}
      </div>
    </div>
  );
}

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} style={{ marginBottom: 24 }}>
      <h2
        id={id}
        style={{
          margin: "0 0 12px",
          fontSize: 15,
          fontWeight: 600,
          color: PA.ink,
        }}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

export function BusinessDetailSurface({
  session,
  businessId,
}: BusinessDetailSurfaceProps) {
  const [detail, setDetail] =
    useState<PlatformAdminBusinessDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!businessId || Number.isNaN(businessId)) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    setNotFound(false);
    try {
      const data = await fetchPlatformAdminBusinessDetail(businessId);
      setDetail(data);
    } catch (e) {
      setDetail(null);
      if (e instanceof PlatformAdminFetchError && e.status === 404) {
        setNotFound(true);
      } else if (e instanceof PlatformAdminFetchError) {
        setError(e.message);
      } else {
        setError("שגיאה בטעינת פרטי העסק");
      }
    } finally {
      setLoading(false);
    }
  }, [businessId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !detail) {
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

  if (notFound) {
    return (
      <main
        style={{
          maxWidth: PA.maxWidth,
          margin: "0 auto",
          padding: "24px 20px 48px",
        }}
      >
        <PlatformAdminEmptyState
          title="עסק לא נמצא"
          detail="ייתכן שהמזהה שגוי או שמדובר בעסק מערכת."
        />
        <p style={{ marginTop: 16 }}>
          <Link href="/admin" style={{ color: PA.info.accent, fontSize: 14 }}>
            חזרה ללוח בקרה
          </Link>
        </p>
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
      <header
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 28,
          paddingBottom: 16,
          borderBottom: `1px solid ${PA.border}`,
        }}
      >
        <div>
          <Link
            href="/admin"
            style={{
              fontSize: 13,
              color: PA.inkMuted,
              textDecoration: "none",
              display: "inline-block",
              marginBottom: 8,
            }}
          >
            ← לוח בקרה
          </Link>
          {error ? (
            <PlatformAdminInlineError message={error} onRetry={() => void load()} />
          ) : detail ? (
            <>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  gap: 10,
                }}
              >
                <h1
                  style={{
                    margin: 0,
                    fontSize: 22,
                    fontWeight: 700,
                    color: PA.ink,
                  }}
                >
                  {detail.business.name}
                </h1>
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 12,
                    padding: "4px 10px",
                    borderRadius: 999,
                    border: `1px solid ${PA.border}`,
                    background: PA.cardBg,
                    color: operationalStatusColor(
                      detail.business.operationalStatus
                    ),
                  }}
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      background: operationalStatusColor(
                        detail.business.operationalStatus
                      ),
                    }}
                  />
                  {detail.business.operationalStatusLabel}
                </span>
              </div>
              <p style={{ margin: "8px 0 0", fontSize: 13, color: PA.inkMuted }}>
                מזהה {detail.business.id} · נוצר{" "}
                {formatDate(detail.business.createdAt)} · פעילות אחרונה{" "}
                {detail.business.lastActivityAt
                  ? formatRelativeTime(detail.business.lastActivityAt)
                  : "—"}{" "}
                · {detail.business.usersCount} משתמשים ·{" "}
                <Link
                  href={`/admin/businesses/${detail.business.id}/features`}
                  style={{ color: PA.info.accent }}
                >
                  גישת פיצ׳רים
                </Link>
              </p>
            </>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          style={{
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

      {detail ? (
        <>
          <Section id="bd-usage" title="שימוש (7 ימים)">
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))",
                gap: 12,
              }}
            >
              <MetricTile label="התחברויות" value={detail.usage.logins7d} />
              <MetricTile
                label="משתמשים פעילים"
                value={detail.usage.activeUsers7d}
              />
              <MetricTile
                label="פיצ׳ר מוביל"
                value={
                  detail.usage.topFeature
                    ? featureKeyLabel(detail.usage.topFeature.featureKey)
                    : "—"
                }
              />
              <MetricTile
                label="חיכוך"
                value={
                  detail.usage.frictionFeature
                    ? featureKeyLabel(detail.usage.frictionFeature.featureKey)
                    : "—"
                }
                alert={Boolean(detail.usage.frictionFeature)}
              />
            </div>
          </Section>

          <Section id="bd-documents" title="מסמכים">
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))",
                gap: 12,
                marginBottom: detail.documents.recentUploads.length ? 12 : 0,
              }}
            >
              <MetricTile label="סה״כ" value={detail.documents.total} />
              <MetricTile
                label="לבדיקה"
                value={detail.documents.needsReview}
                alert={detail.documents.needsReview > 0}
              />
              <MetricTile
                label="תקועים"
                value={detail.documents.stuckNeedsReview}
                alert={detail.documents.stuckNeedsReview > 0}
              />
            </div>
            {detail.documents.recentUploads.length > 0 ? (
              <ul
                style={{
                  listStyle: "none",
                  margin: 0,
                  padding: 0,
                  fontSize: 13,
                  border: `1px solid ${PA.border}`,
                  borderRadius: PA.radius,
                  overflow: "hidden",
                }}
              >
                {detail.documents.recentUploads.map((doc) => (
                  <li
                    key={doc.id}
                    style={{
                      padding: "8px 12px",
                      borderBottom: `1px solid ${PA.border}`,
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 8,
                    }}
                  >
                    <span style={{ color: PA.inkMuted }}>
                      #{doc.id} · {doc.source}
                    </span>
                    <span>
                      {doc.status} · {formatRelativeTime(doc.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p style={{ margin: 0, fontSize: 13, color: PA.inkMuted }}>
                אין העלאות אחרונות
              </p>
            )}
          </Section>

          <Section id="bd-billing" title="חשבוניות">
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))",
                gap: 12,
              }}
            >
              <MetricTile label="טיוטות" value={detail.billing.drafts} />
              <MetricTile
                label="ממתין לבדיקה"
                value={detail.billing.pendingReview}
                alert={detail.billing.pendingReview > 0}
              />
              <MetricTile label="הופקו" value={detail.billing.issued} />
              <MetricTile
                label="כשלי PDF"
                value={detail.billing.pdfFailures}
                alert={detail.billing.pdfFailures > 0}
              />
            </div>
          </Section>

          <Section id="bd-inbox" title="שיחות / תיבה">
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
                gap: 12,
              }}
            >
              <MetricTile label="שיחות פתוחות" value={detail.conversations.open} />
              <MetricTile
                label="ממתין לתשובה"
                value={detail.conversations.waitingForReply}
                alert={detail.conversations.waitingForReply > 0}
              />
              <MetricTile
                label="הודעה אחרונה"
                value={
                  detail.conversations.lastMessageAt
                    ? formatRelativeTime(detail.conversations.lastMessageAt)
                    : "—"
                }
              />
            </div>
          </Section>

          <Section id="bd-integrations" title="אינטגרציות">
            <div
              style={{
                fontSize: 13,
                lineHeight: 1.7,
                padding: "12px 14px",
                border: `1px solid ${PA.border}`,
                borderRadius: PA.radius,
                background: PA.cardBg,
              }}
            >
              <div>
                Gmail:{" "}
                {detail.integrations.gmailConnected
                  ? `מחובר (${detail.integrations.gmailEmail ?? "—"})`
                  : "לא מחובר"}
              </div>
              {detail.integrations.gmailLastSyncedAt ? (
                <div style={{ color: PA.inkMuted }}>
                  סנכרון אחרון:{" "}
                  {formatRelativeTime(detail.integrations.gmailLastSyncedAt)}
                </div>
              ) : null}
              <div
                style={{
                  color:
                    detail.integrations.whatsappImportFailures > 0
                      ? PA.attention.accent
                      : PA.ink,
                }}
              >
                כשלי ייבוא WhatsApp:{" "}
                {detail.integrations.whatsappImportFailures}
              </div>
            </div>
          </Section>

          <Section id="bd-attention" title="אותות תשומת לב">
            {detail.attentionSignals.length === 0 ? (
              <PlatformAdminEmptyState
                title="אין אותות מיוחדים"
                detail="העסק נראה שקט תפעולית."
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
                {detail.attentionSignals.map((item) => {
                  const colors = severityColors(item.severity);
                  return (
                    <li
                      key={item.id}
                      style={{
                        padding: "10px 12px",
                        borderRadius: PA.radius,
                        border: `1px solid ${PA.border}`,
                        borderRight: `3px solid ${typeof colors === "string" ? colors : colors.accent}`,
                        background: PA.cardBg,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          flexWrap: "wrap",
                          gap: 8,
                          alignItems: "baseline",
                        }}
                      >
                        <span style={{ fontWeight: 600, fontSize: 13 }}>
                          {item.title}
                        </span>
                        <span style={{ fontSize: 12, color: PA.inkMuted }}>
                          {categoryLabel(item.category)}
                        </span>
                      </div>
                      {item.detail ? (
                        <p
                          style={{
                            margin: "4px 0 0",
                            fontSize: 12,
                            color: PA.inkMuted,
                          }}
                        >
                          {item.detail}
                        </p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>

          <p style={{ fontSize: 11, color: PA.inkMeta, marginTop: 8 }}>
            מנהל: {session.admin.email} · נוצר{" "}
            {formatRelativeTime(detail.generatedAt)}
          </p>
        </>
      ) : null}
    </main>
  );
}
