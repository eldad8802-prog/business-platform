"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { useDocumentsInbox } from "@/hooks/useDocumentsInbox";
import type { InboxListItem } from "@/lib/documents/inbox-types";
import { CATEGORY_MAP } from "@/lib/constants/categories";
import { TOKEN } from "@/lib/design/documents-theme";
import { glassActionStyle } from "@/lib/design/documents-theme";
import { getCurrentYearMonthJerusalem } from "@/lib/utils/jerusalem-month-range";
import {
  buildMonthOptions,
  computeOlderBacklog,
  pickBacklogCtaMonth,
} from "@/lib/documents/backlog-view";
import BackButton from "@/components/ui/back-button";
import { PageContainer } from "@/components/ui/page-container";
import BacklogBanner from "./BacklogBanner";
import DocumentCard from "./DocumentCard";
import DocumentsInboxTable from "./DocumentsInboxTable";
import InboxEmptyState from "./InboxEmptyState";
import InboxSkeleton from "./InboxSkeleton";
import MonthSection from "./MonthSection";

/**
 * Artifact C — single authoritative responsive boundary for the inbox surfaces.
 * Base (below 1024) shows the existing mobile cards; at/above 1024 (the shell's
 * desktop/sidebar tier, the same step the workspace primitives use) the dense
 * review table shows instead. One `min-width` boundary, no `max-width` arm → no
 * fractional dead zone (Artifact B lesson). No JS viewport detection.
 */
const responsiveCss = `
.docs-inbox-desktop { display: none; }
.docs-inbox-mobile { display: flex; flex-direction: column; gap: 8px; }
.docs-inbox-inspector { display: none; }
@media (min-width: 1024px) {
  .docs-inbox-desktop { display: block; }
  .docs-inbox-mobile { display: none; }
}
@media (min-width: 1200px) {
  .docs-inbox-page { max-width: none !important; }
  .docs-inbox-desk {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(280px, 360px);
    gap: 16px;
    align-items: start;
  }
  .docs-inbox-inspector {
    display: block;
    position: sticky;
    top: 16px;
    background: #fff;
    border: 1px solid rgba(120, 98, 64, 0.16);
    border-radius: 16px;
    padding: 16px;
  }
  .docs-inbox-inspector h2 { margin: 0 0 8px; font-size: 18px; }
  .docs-inbox-inspector p { margin: 0; color: #6f685c; line-height: 1.5; }
  .docs-inbox-inspector dl { margin: 12px 0 0; display: grid; grid-template-columns: auto 1fr; gap: 8px 12px; }
  .docs-inbox-inspector dt { color: #8a8478; }
  .docs-inbox-inspector a {
    display: flex; align-items: center; justify-content: center;
    margin-top: 16px; height: 44px; border-radius: 12px;
    background: #246966; color: #fff; text-decoration: none; font-weight: 600;
  }
}
@media (min-width: 1600px) {
  .docs-inbox-desk { grid-template-columns: minmax(0, 1fr) minmax(320px, 400px); }
}
`;

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
  // Seed the viewed month from the URL (?month=YYYY-MM) so refresh/back keep it.
  const initialMonth = useMemo(() => readMonthFromUrl(), []);

  const {
    scope,
    selectedMonth,
    pendingMonths,
    financialPulse,
    items,
    pagination,
    loading,
    loadingMore,
    error,
    refetch,
    setMonth,
    loadMore,
  } = useDocumentsInbox(authToken, { initialMonth });

  const handleMonthChange = useCallback(
    (next: string | null) => {
      writeMonthToUrl(next);
      setMonth(next);
    },
    [setMonth]
  );

  const pendingItems = useMemo(
    () => items.filter((item) => item.status === "needs_review"),
    [items]
  );
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const selected = pendingItems.find((item) => item.documentId === selectedId) ?? null;
  const monthKeys = useMemo(
    () => groupByMonthDescending(pendingItems),
    [pendingItems]
  );

  const currentMonth = getCurrentYearMonthJerusalem();
  const viewedMonth = selectedMonth ?? scope?.month ?? currentMonth;
  const viewedMonthName = monthLabel(viewedMonth);

  // Month options: current month is always reachable, plus every month that
  // holds a backlog, plus whatever is currently selected (so the control always
  // shows its own value).
  const monthOptions = useMemo(
    () =>
      buildMonthOptions(
        currentMonth,
        [selectedMonth, ...pendingMonths].filter(
          (m): m is string => typeof m === "string" && m.length > 0
        )
      ),
    [currentMonth, selectedMonth, pendingMonths]
  );

  // Authoritative month count (server), not just what's loaded on this page.
  const counts = financialPulse?.inboxDocumentCounts;
  const monthPending = counts?.pendingReview ?? pendingItems.length;
  const totalPending = counts?.totalPendingReview ?? monthPending;
  const older = computeOlderBacklog({
    totalPending,
    monthPending,
  });
  const ctaMonth = pickBacklogCtaMonth(pendingMonths, viewedMonth);

  const displayError = error === "Server error" ? "שגיאת שרת" : error;

  return (
    <div dir="rtl" style={pageStyle}>
      <style>{responsiveCss}</style>
      {/* Pilot: data intent (Spec v1 §20) — the desktop DataTable finally gets
          the width it was built for instead of a 760px column. */}
      <PageContainer intent="data" as="main" className="docs-inbox-page" style={{ paddingBlock: "14px 40px" }}>
        <header style={headStyle}>
          <BackButton href="/documents" />
          <div style={{ minWidth: 0, textAlign: "center" }}>
            <h1 style={titleStyle}>תור אימות</h1>
            <div style={subtitleStyle}>{viewedMonthName}</div>
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
          <div className="docs-inbox-desk">
          <div>
            {monthOptions.length > 1 ? (
              <div style={selectorRowStyle}>
                <label htmlFor="inbox-month" style={selectorLabelStyle}>
                  חודש
                </label>
                <select
                  id="inbox-month"
                  value={viewedMonth}
                  onChange={(e) => handleMonthChange(e.target.value)}
                  style={selectStyle}
                >
                  {monthOptions.map((m) => (
                    <option key={m} value={m}>
                      {monthLabel(m)}
                      {m === currentMonth ? " (החודש)" : ""}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            <section style={bandStyle} aria-live="polite">
              <WarningIcon />
              <span>{monthPending.toLocaleString("he-IL")}</span>
              <span>מסמכים ממתינים לאימות ב{viewedMonthName}</span>
            </section>

            {older.show ? (
              <BacklogBanner
                olderCount={older.olderCount}
                ctaMonthName={ctaMonth ? monthLabel(ctaMonth) : null}
                onShowOlder={() => ctaMonth && handleMonthChange(ctaMonth)}
              />
            ) : null}

            {pendingItems.length === 0 ? (
              <InboxEmptyState
                variant={items.length === 0 ? "no_documents_month" : "no_pending"}
                monthName={viewedMonthName}
              />
            ) : (
              <section style={listStyle}>
                {monthKeys.map((monthKey) => {
                  const monthItems = pendingItems.filter(
                    (item) => item.groupMonth === monthKey
                  );
                  return (
                    <MonthSection key={monthKey} monthKey={monthKey}>
                      {/* Desktop (≥1024): dense review table. Mobile (<1024): the
                          existing cards. Same data, CSS-toggled — no duplicate
                          fetch, no viewport hook, grouping stays here. */}
                      <div className="docs-inbox-desktop">
                        <DocumentsInboxTable
                          items={monthItems}
                          ariaLabel={`מסמכים לאימות — ${monthKey}`}
                          selectedId={selectedId}
                          onRowActivate={(item) => setSelectedId(item.documentId)}
                        />
                      </div>
                      <div className="docs-inbox-mobile">
                        {monthItems.map((item) => (
                          <DocumentCard key={item.documentId} item={item} />
                        ))}
                      </div>
                    </MonthSection>
                  );
                })}
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
          </div>
          <aside className="docs-inbox-inspector" aria-label="המסמך שנבחר בתור">
            {selected ? (
              <InboxInspector item={selected} />
            ) : (
              <p>
                {pendingItems.length === 0
                  ? `אין מסמכים ממתינים ב${viewedMonthName}.`
                  : `${monthPending.toLocaleString("he-IL")} ממתינים. בחרו שורה כדי לראות את החילוץ, ואז פתחו לאימות — האישור נשאר במסך הבדיקה.`}
              </p>
            )}
          </aside>
          </div>
        ) : null}
      </PageContainer>
    </div>
  );
}

function InboxInspector({ item }: { item: InboxListItem }) {
  const vendor = item.financial?.vendorName ?? item.extracted?.vendorName ?? "לא צוין";
  const amountRaw = item.financial?.amount ?? item.extracted?.amount ?? null;
  const dateIso = item.financial?.date ?? item.extracted?.date ?? item.createdAt;
  const categoryRaw = item.financial?.category ?? item.extracted?.category ?? "";
  const category = categoryRaw ? CATEGORY_MAP[categoryRaw] ?? categoryRaw : "כללי";
  const date = dateIso
    ? new Date(dateIso).toLocaleDateString("he-IL", { day: "2-digit", month: "2-digit", year: "numeric" })
    : "—";
  return (
    <>
      <h2>{vendor}</h2>
      <dl>
        <dt>תאריך</dt>
        <dd>{date}</dd>
        <dt>קטגוריה</dt>
        <dd>{category}</dd>
        <dt>סכום</dt>
        <dd>
          {amountRaw != null && Number.isFinite(amountRaw)
            ? `₪${amountRaw.toLocaleString("he-IL")}`
            : "—"}
        </dd>
        <dt>מקור</dt>
        <dd>{item.source || "—"}</dd>
        <dt>אישור מהיר</dt>
        <dd>{item.quickApproveEligible ? "זמין אחרי בדיקה" : "דורש בדיקה"}</dd>
      </dl>
      <Link href={`/documents/review/${item.documentId}`}>פתח לאימות</Link>
    </>
  );
}

/** Read a valid ?month=YYYY-MM from the URL, else null (server default). */
function readMonthFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const m = new URLSearchParams(window.location.search).get("month");
  return m && /^\d{4}-\d{2}$/.test(m) ? m : null;
}

/** Persist the viewed month in the URL without adding history noise. */
function writeMonthToUrl(next: string | null): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (next) url.searchParams.set("month", next);
  else url.searchParams.delete("month");
  window.history.replaceState(window.history.state, "", url.toString());
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

const headStyle = {
  display: "grid",
  gridTemplateColumns: "auto 1fr 52px",
  alignItems: "center",
  gap: 10,
  marginBottom: 14,
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

const selectorRowStyle = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  marginBottom: 12,
} as const;

const selectorLabelStyle = {
  color: TOKEN.ink.muted,
  fontSize: TOKEN.font.meta,
  fontWeight: TOKEN.weight.semibold,
} as const;

const selectStyle = {
  flex: "0 1 auto",
  minHeight: 40,
  padding: "8px 12px",
  borderRadius: TOKEN.radius.card,
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  background: TOKEN.surface.card,
  color: TOKEN.ink.primary,
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.semibold,
  fontFamily: "inherit",
  cursor: "pointer",
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
