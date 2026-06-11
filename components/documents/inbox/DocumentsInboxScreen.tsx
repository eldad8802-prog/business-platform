"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useDocumentsInbox } from "@/hooks/useDocumentsInbox";
import type { InboxListItem } from "@/lib/documents/inbox-types";
import DocumentCard from "./DocumentCard";
import InboxEmptyState from "./InboxEmptyState";
import InboxSkeleton from "./InboxSkeleton";
import MonthSection from "./MonthSection";

type TabKey = "pending" | "approved";

function filterByTab(items: InboxListItem[], tab: TabKey): InboxListItem[] {
  if (tab === "pending") return items.filter((i) => i.status === "needs_review");
  return items.filter((i) => i.status === "approved");
}

function groupByMonthDescending(items: InboxListItem[]): string[] {
  const keys = new Set(items.map((i) => i.groupMonth));
  return Array.from(keys).sort().reverse();
}

function QueueStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "warning" | "success";
}) {
  return (
    <div
      style={{
        border: "1px solid #dfe7f3",
        borderRadius: 12,
        background: "#ffffff",
        padding: 12,
        textAlign: "center",
      }}
    >
      <div style={{ color: "#64748b", fontSize: 12, fontWeight: 850 }}>
        {label}
      </div>
      <div
        style={{
          color: tone === "warning" ? "#d97706" : "#16a34a",
          fontSize: 24,
          fontWeight: 950,
          marginTop: 4,
          lineHeight: 1.1,
        }}
      >
        {value.toLocaleString("he-IL")}
      </div>
    </div>
  );
}

export default function DocumentsInboxScreen({
  authToken,
}: {
  authToken: string | null;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<TabKey>("pending");

  const {
    financialPulse,
    items,
    pagination,
    loading,
    loadingMore,
    error,
    loadMore,
    refetch,
  } = useDocumentsInbox(authToken);

  const pendingCount = useMemo(
    () => items.filter((i) => i.status === "needs_review").length,
    [items]
  );
  const approvedCount = useMemo(
    () => items.filter((i) => i.status === "approved").length,
    [items]
  );
  const filtered = useMemo(() => filterByTab(items, tab), [items, tab]);
  const monthKeys = useMemo(() => groupByMonthDescending(filtered), [filtered]);
  const nextPending = useMemo(
    () => items.find((i) => i.status === "needs_review") ?? null,
    [items]
  );

  const emptyVariant = useMemo(() => {
    if (loading || error || items.length > 0) return null;
    return "no_documents_month" as const;
  }, [loading, error, items.length]);

  const tabEmptyVariant = useMemo(() => {
    if (loading || error || items.length === 0 || filtered.length > 0) return null;
    if (tab === "pending") return "no_pending" as const;
    return "no_approved" as const;
  }, [loading, error, items.length, filtered.length, tab]);

  const pulsePendingCount = financialPulse?.inboxDocumentCounts.pendingReview ?? pendingCount;
  const pulseApprovedCount =
    financialPulse?.inboxDocumentCounts.approvedDocuments ?? approvedCount;

  return (
    <div dir="rtl" style={{ minHeight: "100vh", background: "#f3f7ff" }}>
      {/* Main content */}
      <div
        style={{
          padding: "14px 14px 40px",
          maxWidth: 760,
          margin: "0 auto",
          boxSizing: "border-box",
        }}
      >
        {/* Error state */}
        {error ? (
          <div
            style={{
              background: "#fff1f2",
              border: "1px solid rgba(220, 38, 38, 0.2)",
              borderRadius: 16,
              padding: "20px 16px",
              textAlign: "center",
              marginBottom: 16,
            }}
          >
            <div
              style={{
                fontSize: 14,
                color: "#991b1b",
                fontWeight: 700,
                marginBottom: 12,
              }}
            >
              {error}
            </div>
            <button
              type="button"
              onClick={() => refetch()}
              style={{
                background: "#dc2626",
                color: "#ffffff",
                border: "none",
                borderRadius: 12,
                padding: "10px 20px",
                fontSize: 14,
                fontWeight: 800,
                cursor: "pointer",
              }}
            >
              נסה שוב
            </button>
          </div>
        ) : null}

        {/* Skeleton */}
        {loading && items.length === 0 ? <InboxSkeleton /> : null}

        {/* Global empty */}
        {!loading && !error && emptyVariant ? (
          <InboxEmptyState variant={emptyVariant} />
        ) : null}

        {!error && items.length > 0 ? (
          <>
            <section
              style={{
                background: "#ffffff",
                border: "1px solid #dfe7f3",
                borderRadius: 18,
                padding: 16,
                boxShadow: "0 10px 28px rgba(15, 23, 42, 0.06)",
                marginBottom: 14,
              }}
            >
              <div style={{ color: "#0f172a", fontSize: 16, fontWeight: 950 }}>
                מצב התור
              </div>
              <p
                style={{
                  margin: "6px 0 0",
                  color: "#64748b",
                  fontSize: 13,
                  lineHeight: 1.6,
                  fontWeight: 800,
                }}
              >
                כאן מטפלים במסמכים שמחכים להחלטה. דוחות, חיפוש וחבילה לרו״ח
                מתעדכנים אחרי אישור.
              </p>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                  gap: 10,
                  marginTop: 12,
                }}
              >
                <QueueStat label="ממתינים" value={pulsePendingCount} tone="warning" />
                <QueueStat label="טופלו" value={pulseApprovedCount} tone="success" />
              </div>
              {nextPending ? (
                <button
                  type="button"
                  onClick={() => router.push(`/documents/review/${nextPending.documentId}`)}
                  style={{
                    width: "100%",
                    minHeight: 48,
                    border: "none",
                    borderRadius: 9,
                    background: "linear-gradient(180deg, #176bff 0%, #0050e6 100%)",
                    color: "#ffffff",
                    fontSize: 15,
                    fontWeight: 950,
                    cursor: "pointer",
                    marginTop: 12,
                  }}
                >
                  בדוק את המסמך הבא <span style={{ marginInlineStart: 10 }}>←</span>
                </button>
              ) : null}
            </section>

            {/* Tab row */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                gap: 8,
                marginBottom: 16,
                background: "#ffffff",
                border: "1px solid #dfe7f3",
                borderRadius: 14,
                padding: 6,
              }}
            >
              {(
                [
                  { key: "pending" as const, label: "ממתינים", count: pendingCount },
                  { key: "approved" as const, label: "מאושרים", count: approvedCount },
                ] as const
              ).map(({ key, label, count }) => {
                const active = tab === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setTab(key)}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 7,
                      padding: "10px 12px",
                      borderRadius: 10,
                      border: active ? "1px solid #0050e6" : "1px solid transparent",
                      background: active
                        ? "linear-gradient(180deg, #176bff 0%, #0050e6 100%)"
                        : "#ffffff",
                      color: active ? "#ffffff" : "#475569",
                      fontSize: 14,
                      fontWeight: 950,
                      cursor: "pointer",
                      boxShadow: active ? "0 6px 14px rgba(7, 91, 255, 0.18)" : "none",
                    }}
                  >
                    {label}
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        minWidth: 20,
                        height: 20,
                        borderRadius: 999,
                        background: active
                          ? "rgba(255,255,255,0.18)"
                          : "rgba(15, 23, 42, 0.07)",
                        fontSize: 11,
                        fontWeight: 900,
                        padding: "0 5px",
                      }}
                    >
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Tab-empty state */}
            {tabEmptyVariant ? (
              <InboxEmptyState variant={tabEmptyVariant} />
            ) : (
              <div
                style={{
                  background: "#ffffff",
                  border: "1px solid #dfe7f3",
                  borderRadius: 18,
                  padding: 14,
                  display: "flex",
                  flexDirection: "column",
                  gap: 16,
                }}
              >
                {monthKeys.map((mk) => (
                  <MonthSection key={mk} monthKey={mk}>
                    {filtered
                      .filter((i) => i.groupMonth === mk)
                      .map((item) => (
                        <DocumentCard key={item.documentId} item={item} />
                      ))}
                  </MonthSection>
                ))}
              </div>
            )}

            {/* Load more */}
            {pagination?.hasMore ? (
              <div style={{ marginTop: 20, textAlign: "center" }}>
                <button
                  type="button"
                  disabled={loadingMore}
                  onClick={() => void loadMore()}
                  style={{
                    background: "#ffffff",
                    border: "1px solid #dfe7f3",
                    borderRadius: 10,
                    padding: "12px 28px",
                    fontSize: 14,
                    fontWeight: 800,
                    color: "#002b6b",
                    cursor: loadingMore ? "not-allowed" : "pointer",
                    opacity: loadingMore ? 0.6 : 1,
                    boxShadow: "0 1px 4px rgba(15, 23, 42, 0.06)",
                  }}
                >
                  {loadingMore ? "טוען…" : "טען עוד"}
                </button>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
