"use client";

import { useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { useDocumentsInbox } from "@/hooks/useDocumentsInbox";
import type { InboxListItem } from "@/lib/documents/inbox-types";
import { TOKEN } from "@/lib/design/tokens";
import { glassActionStyle } from "@/lib/design/action-styles";
import DocumentCard from "./DocumentCard";
import ProcessingCard from "./ProcessingCard";
import InboxEmptyState from "./InboxEmptyState";
import InboxSkeleton from "./InboxSkeleton";
import MonthSection from "./MonthSection";

function groupByMonthDescending(items: InboxListItem[]): string[] {
  const keys = new Set(items.map((i) => i.groupMonth));
  return Array.from(keys).sort().reverse();
}

function monthLabel(month: string | null | undefined): string {
  if (!month) return "";
  const [year, monthIndex] = month.split("-").map(Number);
  if (!Number.isFinite(year) || !Number.isFinite(monthIndex)) return month;
  return new Date(year, monthIndex - 1, 1).toLocaleDateString("he-IL", {
    month: "long",
    year: "numeric",
  });
}

export default function DocumentsInboxScreen({
  authToken,
}: {
  authToken: string | null;
}) {
  const router = useRouter();
  const {
    scope,
    items,
    pagination,
    loading,
    loadingMore,
    error,
    refetch,
    refetchQuiet,
    loadMore,
  } = useDocumentsInbox(authToken);

  const pendingItems = useMemo(
    () => items.filter((item) => item.status === "needs_review"),
    [items]
  );
  // In-flight uploads (two-phase): appear immediately after Phase 1, before OCR
  // finishes. Newest first, above the verification queue.
  const processingItems = useMemo(
    () =>
      items
        .filter(
          (item) => item.status === "processing" || item.status === "failed"
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [items]
  );
  const monthKeys = useMemo(
    () => groupByMonthDescending(pendingItems),
    [pendingItems]
  );

  // Poll while any document is still processing so it flips to "ready" on its
  // own. Quiet refetch = no skeleton flash. Stops once nothing is in-flight.
  const hasProcessing = useMemo(
    () => processingItems.some((item) => item.status === "processing"),
    [processingItems]
  );
  useEffect(() => {
    if (!hasProcessing) return;
    const timer = setInterval(() => {
      void refetchQuiet();
    }, 3000);
    return () => clearInterval(timer);
  }, [hasProcessing, refetchQuiet]);

  const displayError = error === "Server error" ? "שגיאת שרת" : error;

  return (
    <div dir="rtl" style={pageStyle}>
      <style>{`@keyframes documents-processing-spin{to{transform:rotate(360deg)}}`}</style>
      <main style={mainStyle}>
        <header style={headStyle}>
          <button
            type="button"
            onClick={() => router.push("/documents")}
            style={backButtonStyle}
            aria-label="חזרה למסמכים"
          >
            <BackChevronIcon />
            חזרה
          </button>
          <div style={{ minWidth: 0, textAlign: "center" }}>
            <h1 style={titleStyle}>תור אימות</h1>
            <div style={subtitleStyle}>{monthLabel(scope?.month)}</div>
          </div>
          <div aria-hidden style={{ width: 52 }} />
        </header>

        {error ? (
          <section style={errorStyle}>
            <div style={{ fontWeight: TOKEN.weight.bold }}>{displayError}</div>
            <p style={errorCopyStyle}>
              לא הצלחנו לטעון את תור המסמכים כרגע.
            </p>
            <button type="button" onClick={() => refetch()} style={retryButtonStyle}>
              נסה שוב
            </button>
          </section>
        ) : null}

        {loading && items.length === 0 ? <InboxSkeleton /> : null}

        {!loading && !error ? (
          <>
            {processingItems.length > 0 ? (
              <section style={processingSectionStyle}>
                <div style={processingHeadingStyle}>בהעלאה</div>
                {processingItems.map((item) => (
                  <ProcessingCard
                    key={item.documentId}
                    item={item}
                    authToken={authToken}
                    onRetried={() => void refetchQuiet()}
                  />
                ))}
              </section>
            ) : null}

            <section style={bandStyle}>
              <WarningIcon />
              <span>{pendingItems.length.toLocaleString("he-IL")}</span>
              <span>מסמכים ממתינים לאימות</span>
            </section>

            {pendingItems.length === 0 ? (
              <InboxEmptyState variant={items.length === 0 ? "no_documents_month" : "no_pending"} />
            ) : (
              <section style={listStyle}>
                {monthKeys.map((monthKey) => (
                  <MonthSection key={monthKey} monthKey={monthKey}>
                    {pendingItems
                      .filter((item) => item.groupMonth === monthKey)
                      .map((item) => (
                        <DocumentCard key={item.documentId} item={item} />
                      ))}
                  </MonthSection>
                ))}
              </section>
            )}

            {pagination?.hasMore ? (
              <button
                type="button"
                disabled={loadingMore}
                onClick={() => void loadMore()}
                style={{
                  ...loadMoreButtonStyle,
                  opacity: loadingMore ? 0.6 : 1,
                  cursor: loadingMore ? "not-allowed" : "pointer",
                }}
              >
                {loadingMore ? "טוען..." : "טען עוד"}
              </button>
            ) : null}
          </>
        ) : null}
      </main>
    </div>
  );
}

function BackChevronIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="m9 6 6 6-6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function WarningIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M12 9v4m0 4h.01M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const pageStyle = {
  minHeight: "100vh",
  background: TOKEN.surface.page,
  color: TOKEN.ink.primary,
} as const;

const mainStyle = {
  width: "100%",
  maxWidth: 760,
  margin: "0 auto",
  padding: "14px 14px 40px",
  boxSizing: "border-box",
} as const;

const headStyle = {
  display: "grid",
  gridTemplateColumns: "52px 1fr 52px",
  alignItems: "center",
  gap: 10,
  marginBottom: 14,
} as const;

const backButtonStyle = {
  ...glassActionStyle({ height: 40 }),
  width: 40,
  height: 40,
  fontSize: 0,
  padding: 0,
} as const;

const titleStyle = {
  margin: 0,
  fontSize: TOKEN.font.display,
  lineHeight: 1.25,
  fontWeight: TOKEN.weight.bold,
  color: TOKEN.ink.primary,
} as const;

const subtitleStyle = {
  marginTop: 4,
  color: TOKEN.ink.muted,
  fontSize: TOKEN.font.meta,
  fontWeight: TOKEN.weight.semibold,
} as const;

const bandStyle = {
  minHeight: 54,
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  borderRadius: TOKEN.radius.card,
  background: TOKEN.surface.card,
  boxShadow: TOKEN.shadow.elevated,
  padding: "0 16px",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  color: TOKEN.ink.primary,
  fontSize: TOKEN.font.title,
  fontWeight: TOKEN.weight.bold,
  marginBottom: 18,
} as const;

const listStyle = {
  display: "flex",
  flexDirection: "column",
  gap: 18,
} as const;

const processingSectionStyle = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
  marginBottom: 18,
} as const;

const processingHeadingStyle = {
  color: TOKEN.ink.secondary,
  fontSize: TOKEN.font.meta,
  fontWeight: TOKEN.weight.bold,
} as const;

const errorStyle = {
  border: `1px solid ${TOKEN.semantic.urgent.border}`,
  borderRadius: TOKEN.radius.card,
  background: TOKEN.semantic.urgent.bgSoft,
  color: TOKEN.semantic.urgent.ink,
  padding: TOKEN.space.lg,
  textAlign: "center",
  marginBottom: 14,
} as const;

const errorCopyStyle = {
  margin: "8px 0 12px",
  color: TOKEN.ink.muted,
  fontSize: TOKEN.font.body,
  lineHeight: 1.6,
} as const;

const retryButtonStyle = {
  ...glassActionStyle({ height: 40 }),
  minHeight: 40,
  padding: "0 18px",
  fontSize: TOKEN.font.body,
} as const;

const loadMoreButtonStyle = {
  ...glassActionStyle({ fullWidth: true, height: 48 }),
  width: "100%",
  minHeight: 48,
  marginTop: 18,
  fontSize: TOKEN.font.body,
} as const;
