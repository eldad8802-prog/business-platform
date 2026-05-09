"use client";

import type { CSSProperties } from "react";
import { useMemo, useState } from "react";
import DocumentsHeader from "@/components/documents/DocumentsHeader";
import { useDocumentsInbox } from "@/hooks/useDocumentsInbox";
import type { InboxListItem } from "@/lib/documents/inbox-types";
import {
  alertError,
  pageMain,
  primaryBtn,
  secondaryBtn,
} from "@/app/documents/ui";
import AttentionBand from "./AttentionBand";
import DocumentCard from "./DocumentCard";
import FinancialPulse from "./FinancialPulse";
import InboxEmptyState from "./InboxEmptyState";
import InboxSkeleton from "./InboxSkeleton";
import MonthSection from "./MonthSection";

type TabKey = "pending" | "approved";

const TAB_ROW: CSSProperties = {
  display: "flex",
  gap: 8,
  marginBottom: 12,
  flexWrap: "wrap",
};

const TAB_BTN = (active: boolean) =>
  ({
    padding: "10px 16px",
    borderRadius: 999,
    border: active ? "1px solid #111827" : "1px solid #e5e7eb",
    background: active ? "#111827" : "#ffffff",
    color: active ? "#ffffff" : "#111827",
    fontSize: 14,
    fontWeight: 900,
    cursor: "pointer",
  }) as const;

const SCROLL_MAIN: CSSProperties = {
  ...pageMain,
  flex: 1,
  minHeight: 0,
  paddingBottom: 28,
};

function filterByTab(items: InboxListItem[], tab: TabKey): InboxListItem[] {
  if (tab === "pending") {
    return items.filter((i) => i.status === "needs_review");
  }
  return items.filter((i) => i.status === "approved");
}

function groupByMonthDescending(items: InboxListItem[]): string[] {
  const keys = new Set(items.map((i) => i.groupMonth));
  return Array.from(keys).sort().reverse();
}

export default function DocumentsInboxScreen({
  authToken,
}: {
  authToken: string | null;
}) {
  const [tab, setTab] = useState<TabKey>("pending");

  const {
    scope,
    financialPulse,
    items,
    pagination,
    loading,
    loadingMore,
    error,
    refetch,
    loadMore,
  } = useDocumentsInbox(authToken);

  const filtered = useMemo(() => filterByTab(items, tab), [items, tab]);

  const monthKeys = useMemo(
    () => groupByMonthDescending(filtered),
    [filtered]
  );

  const emptyVariant = useMemo(() => {
    if (loading || error || items.length > 0) return null;
    return "no_documents_month" as const;
  }, [loading, error, items.length]);

  const tabEmptyVariant = useMemo(() => {
    if (loading || error || items.length === 0 || filtered.length > 0) {
      return null;
    }
    if (tab === "pending") return "no_pending" as const;
    return "no_approved" as const;
  }, [loading, error, items.length, filtered.length, tab]);

  const showAttention =
    financialPulse != null &&
    financialPulse.inboxDocumentCounts.pendingReview > 0;

  return (
    <div dir="rtl" style={{ minHeight: "100vh", background: "#f8fafc" }}>
      <DocumentsHeader title="תיבת מסמכים" />

      <main style={SCROLL_MAIN}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
            marginBottom: 12,
            flexWrap: "wrap",
          }}
        >
          <div style={{ fontSize: 13, color: "#6b7280", fontWeight: 800 }}>
            {scope ? `חודש: ${scope.month}` : null}
          </div>
          <button
            type="button"
            style={{ ...secondaryBtn, width: "auto", marginTop: 0, minHeight: 44 }}
            onClick={() => refetch()}
            disabled={loading}
          >
            רענון
          </button>
        </div>

        {!error && !(loading && items.length === 0) ? (
          <FinancialPulse pulse={financialPulse} />
        ) : null}

        {error ? (
          <div style={alertError}>
            <div style={{ marginBottom: 10 }}>{error}</div>
            <button
              type="button"
              style={{ ...primaryBtn, marginTop: 0 }}
              onClick={() => refetch()}
            >
              נסה שוב
            </button>
          </div>
        ) : null}

        {loading && items.length === 0 ? <InboxSkeleton /> : null}

        {!loading && !error && emptyVariant ? (
          <InboxEmptyState variant={emptyVariant} />
        ) : null}

        {!error && items.length > 0 ? (
          <>
            {showAttention ? (
              <AttentionBand
                pendingCount={financialPulse!.inboxDocumentCounts.pendingReview}
              />
            ) : null}

            <div style={TAB_ROW}>
              <button
                type="button"
                style={TAB_BTN(tab === "pending")}
                onClick={() => setTab("pending")}
              >
                ממתינים
              </button>
              <button
                type="button"
                style={TAB_BTN(tab === "approved")}
                onClick={() => setTab("approved")}
              >
                מאושרים
              </button>
            </div>

            {tabEmptyVariant ? (
              <InboxEmptyState variant={tabEmptyVariant} />
            ) : (
              monthKeys.map((mk) => (
                <MonthSection key={mk} monthKey={mk}>
                  {filtered
                    .filter((i) => i.groupMonth === mk)
                    .map((item) => (
                      <DocumentCard key={item.documentId} item={item} />
                    ))}
                </MonthSection>
              ))
            )}

            {pagination?.hasMore ? (
              <button
                type="button"
                style={{
                  ...secondaryBtn,
                  marginTop: 16,
                }}
                disabled={loadingMore}
                onClick={() => void loadMore()}
              >
                {loadingMore ? "טוען…" : "טען עוד"}
              </button>
            ) : null}
          </>
        ) : null}
      </main>
    </div>
  );
}
