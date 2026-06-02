"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PlatformAdminSessionResponse } from "@/lib/services/platform-admin/types";
import type { PlatformAdminAuditResponse } from "@/lib/services/platform-admin/platform-audit-list.types";
import {
  PlatformAdminFetchError,
  fetchPlatformAdminAudit,
} from "@/lib/platform-admin/fetch-platform-admin";
import { PA } from "./platform-admin-styles";
import { PlatformAdminNav } from "./platform-admin-nav";
import { PlatformAdminSkeleton } from "./platform-admin-skeleton";
import { PlatformAdminInlineError } from "./platform-admin-inline-error";
import { PlatformAdminEmptyState } from "./platform-admin-empty-state";
import { formatRelativeTime } from "./platform-usage-labels";

type AuditViewerSurfaceProps = {
  session: PlatformAdminSessionResponse;
};

function toneBorderColor(tone: string): string {
  switch (tone) {
    case "sensitive":
      return PA.attention.border;
    case "warning":
      return PA.info.border;
    default:
      return PA.border;
  }
}

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString("he-IL", {
      dateStyle: "short",
      timeStyle: "medium",
    });
  } catch {
    return iso;
  }
}

function SummaryTile({ label, value }: { label: string; value: string | number }) {
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
      <div style={{ fontSize: 18, fontWeight: 600, color: PA.ink }}>{value}</div>
    </div>
  );
}

export function AuditViewerSurface({ session }: AuditViewerSurfaceProps) {
  const [data, setData] = useState<PlatformAdminAuditResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [pageLoading, setPageLoading] = useState(false);
  const hasLoadedOnce = useRef(false);

  const load = useCallback(async (targetPage: number, options?: { initial?: boolean }) => {
    if (options?.initial) setLoading(true);
    else setPageLoading(true);
    setError(null);
    try {
      const result = await fetchPlatformAdminAudit(targetPage);
      setData(result);
    } catch (e) {
      setData(null);
      setError(
        e instanceof PlatformAdminFetchError
          ? e.message
          : "לא ניתן לטעון יומן ביקורת"
      );
    } finally {
      setLoading(false);
      setPageLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(page, { initial: !hasLoadedOnce.current });
    hasLoadedOnce.current = true;
  }, [page, load]);

  const pagination = data?.pagination;
  const canPrev = pagination ? pagination.page > 1 : false;
  const canNext = pagination
    ? pagination.page < pagination.totalPages
    : false;

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
        <h1
          style={{
            margin: 0,
            fontSize: 22,
            fontWeight: 700,
            color: PA.ink,
          }}
        >
          יומן ביקורת
        </h1>
        <p style={{ margin: "8px 0 0", fontSize: 13, color: PA.inkMuted }}>
          פעילות מנהלי פלטפורמה · {session.admin.email}
        </p>
        <button
          type="button"
          onClick={() => void load(page, { initial: false })}
          disabled={loading || pageLoading}
          style={{
            marginTop: 12,
            border: `1px solid ${PA.border}`,
            background: PA.cardBg,
            borderRadius: 8,
            padding: "8px 14px",
            fontSize: 13,
            cursor: loading || pageLoading ? "wait" : "pointer",
          }}
        >
          רענון
        </button>
      </header>

      {error ? (
        <PlatformAdminInlineError message={error} onRetry={() => void load(page)} />
      ) : data ? (
        <>
          <section aria-labelledby="audit-summary-heading" style={{ marginBottom: 28 }}>
            <h2
              id="audit-summary-heading"
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
                gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
                gap: 12,
              }}
            >
              <SummaryTile
                label="אירועים (24 שעות)"
                value={data.summary.events24h}
              />
              <SummaryTile
                label="מנהלים ייחודיים (7 ימים)"
                value={data.summary.uniqueAdmins7d}
              />
              <SummaryTile
                label="פעולה נפוצה (7 ימים)"
                value={
                  data.summary.mostCommonAction
                    ? data.summary.mostCommonAction.actionLabel
                    : "—"
                }
              />
            </div>
          </section>

          <section aria-labelledby="audit-list-heading">
            <h2
              id="audit-list-heading"
              style={{
                margin: "0 0 12px",
                fontSize: 15,
                fontWeight: 600,
                color: PA.ink,
              }}
            >
              אירועים
            </h2>

            {data.items.length === 0 ? (
              <PlatformAdminEmptyState title="אין אירועי ביקורת" />
            ) : (
              <ul
                style={{
                  listStyle: "none",
                  margin: 0,
                  padding: 0,
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                  opacity: pageLoading ? 0.6 : 1,
                }}
              >
                {data.items.map((item) => (
                  <li
                    key={item.id}
                    style={{
                      padding: "12px 14px",
                      border: `1px solid ${PA.border}`,
                      borderRight: `3px solid ${toneBorderColor(item.tone)}`,
                      borderRadius: PA.radius,
                      background: PA.cardBg,
                      fontSize: 13,
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
                      <span style={{ fontWeight: 600, color: PA.ink }}>
                        {item.actionLabel}
                      </span>
                      <time
                        dateTime={item.timestamp}
                        style={{ color: PA.inkMuted, fontSize: 12 }}
                        title={formatTimestamp(item.timestamp)}
                      >
                        {formatRelativeTime(item.timestamp)}
                      </time>
                    </div>
                    <div style={{ color: PA.inkSecondary, marginBottom: 4 }}>
                      {item.actor.display}
                    </div>
                    {(item.target.display || item.detail) && (
                      <div style={{ color: PA.inkMuted, fontSize: 12 }}>
                        {[item.target.display, item.detail]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    )}
                    {(item.ip || item.userAgentShort) && (
                      <div
                        style={{
                          marginTop: 6,
                          fontSize: 11,
                          color: PA.inkMeta,
                          fontFamily: "ui-monospace, monospace",
                        }}
                      >
                        {[item.ip, item.userAgentShort].filter(Boolean).join(" · ")}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {pagination && pagination.totalPages > 1 ? (
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  marginTop: 16,
                }}
              >
                <span style={{ fontSize: 13, color: PA.inkMuted }}>
                  עמוד {pagination.page} מתוך {pagination.totalPages} ·{" "}
                  {pagination.total} אירועים
                </span>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    type="button"
                    disabled={!canPrev || pageLoading}
                    onClick={() => setPage((p) => p - 1)}
                    style={{
                      border: `1px solid ${PA.border}`,
                      background: PA.cardBg,
                      borderRadius: 8,
                      padding: "6px 12px",
                      fontSize: 13,
                      cursor: canPrev && !pageLoading ? "pointer" : "not-allowed",
                      opacity: canPrev && !pageLoading ? 1 : 0.5,
                    }}
                  >
                    הקודם
                  </button>
                  <button
                    type="button"
                    disabled={!canNext || pageLoading}
                    onClick={() => setPage((p) => p + 1)}
                    style={{
                      border: `1px solid ${PA.border}`,
                      background: PA.cardBg,
                      borderRadius: 8,
                      padding: "6px 12px",
                      fontSize: 13,
                      cursor: canNext && !pageLoading ? "pointer" : "not-allowed",
                      opacity: canNext && !pageLoading ? 1 : 0.5,
                    }}
                  >
                    הבא
                  </button>
                </div>
              </div>
            ) : null}
          </section>

          <p style={{ fontSize: 11, color: PA.inkMeta, marginTop: 20 }}>
            read-only · ללא ייצוא · עודכן{" "}
            {formatRelativeTime(data.generatedAt)}
          </p>
        </>
      ) : null}
    </main>
  );
}
