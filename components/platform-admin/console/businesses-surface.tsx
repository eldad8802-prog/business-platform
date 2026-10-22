"use client";

/**
 * Businesses (A1): find any business in seconds. Search matches the business
 * name, its id, or a user's email; quick filters cover the questions asked
 * most (new this week, not seen for 14 days, onboarding not finished).
 * Desktop shows a table; phones show one card per business. Search, filter and
 * page belong to the history entry, so Back returns to the same list.
 */
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useEntryState } from "@/hooks/useEntryState";
import type {
  PlatformAdminBusinessFilter,
  PlatformAdminBusinessListItem,
  PlatformAdminBusinessesResponse,
} from "@/lib/services/platform-admin/types";
import { fetchPlatformAdminBusinesses } from "@/lib/platform-admin/fetch-platform-admin";
import { formatRelativeTime } from "../platform-usage-labels";
import { ConsoleIcon } from "./console-icons";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "./console-states";
import { useAdminLoad } from "./use-admin-load";
import styles from "./admin-console.module.css";

const FILTERS: Array<{ key: PlatformAdminBusinessFilter; label: string }> = [
  { key: "all", label: "הכול" },
  { key: "new", label: "חדשים השבוע" },
  { key: "inactive", label: "לא נכנסו 14 ימים" },
  { key: "no_onboarding", label: "בלי אונבורדינג" },
];

const PAGE_SIZE = 20;

function isFilter(value: string | null): value is PlatformAdminBusinessFilter {
  return FILTERS.some((f) => f.key === value);
}

function StatePill({ item, now }: { item: PlatformAdminBusinessListItem; now: number }) {
  if (item.lifecycle === "DELETION_REQUESTED") {
    return <span className={`${styles.pill} ${styles.pillBad}`}>ביקש מחיקה</span>;
  }
  if (item.lifecycle === "ARCHIVED") {
    return <span className={`${styles.pill} ${styles.pillNeutral}`}>בארכיון</span>;
  }
  if (!item.lastActiveAt) {
    return <span className={`${styles.pill} ${styles.pillNeutral}`}>לא נכנס</span>;
  }
  const days = (now - new Date(item.lastActiveAt).getTime()) / 86_400_000;
  if (days > 14) return <span className={`${styles.pill} ${styles.pillWarn}`}>לא פעיל</span>;
  return <span className={`${styles.pill} ${styles.pillOk}`}>פעיל</span>;
}

function OnboardingPill({ at }: { at: string | null }) {
  return at ? (
    <span className={`${styles.pill} ${styles.pillOk}`}>הושלם</span>
  ) : (
    <span className={`${styles.pill} ${styles.pillNeutral}`}>לא הושלם</span>
  );
}

const dateFmt = new Intl.DateTimeFormat("he-IL", { day: "2-digit", month: "2-digit", year: "2-digit" });

export function BusinessesSurface() {
  const params = useSearchParams();
  const urlQ = params.get("q") ?? "";
  const urlFilter = params.get("filter");

  const [q, setQ] = useEntryState("q", urlQ);
  const [filter, setFilter] = useEntryState<PlatformAdminBusinessFilter>(
    "filter",
    isFilter(urlFilter) ? urlFilter : "all"
  );
  const [page, setPage] = useEntryState("page", 1);
  const [draft, setDraft] = useState(q);
  // One clock for the render (the activity pill compares against it).
  const [now] = useState(() => Date.now());

  // A new global search (?q=) or a home-tile link (?filter=) replaces the list state.
  const lastUrl = useRef(`${urlQ}|${urlFilter ?? ""}`);
  useEffect(() => {
    const key = `${urlQ}|${urlFilter ?? ""}`;
    if (key === lastUrl.current) return;
    lastUrl.current = key;
    setQ(urlQ);
    setDraft(urlQ);
    setFilter(isFilter(urlFilter) ? urlFilter : "all");
    setPage(1);
  }, [urlQ, urlFilter, setQ, setFilter, setPage]);

  // Debounce typing: one request per pause, not per keystroke.
  useEffect(() => {
    if (draft === q) return;
    const id = window.setTimeout(() => {
      setQ(draft);
      setPage(1);
    }, 350);
    return () => window.clearTimeout(id);
  }, [draft, q, setQ, setPage]);

  const state = useAdminLoad<PlatformAdminBusinessesResponse>(`businesses:${filter}:${page}:${q}`, () =>
    fetchPlatformAdminBusinesses({ page, limit: PAGE_SIZE, q, filter })
  );
  // Keep the previous list on screen while the next one loads.
  const data = state.data ?? (state.loading ? state.previous : null);
  const items = data?.items ?? [];

  return (
    <>
      <div className={styles.pageHead}>
        <div>
          <h1>עסקים ומשתמשים</h1>
          <p>{data ? `${data.pagination.total.toLocaleString("he-IL")} עסקים תואמים` : "טוען…"}</p>
        </div>
      </div>

      <label className={styles.search} style={{ maxWidth: "none" }}>
        <ConsoleIcon name="search" size={16} />
        <input
          id="admin-businesses-search"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="שם עסק, מזהה או מייל של משתמש"
          aria-label="חיפוש עסקים"
          maxLength={120}
          enterKeyHint="search"
        />
      </label>

      <div className={styles.chips} role="group" aria-label="סינון עסקים">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            className={styles.chip}
            aria-pressed={filter === f.key}
            onClick={() => {
              setFilter(f.key);
              setPage(1);
            }}
          >
            {f.label}
          </button>
        ))}
      </div>

      {state.loading && !data ? (
        <LoadingBlock height={320} label="טוען עסקים" />
      ) : state.error ? (
        <ErrorBlock error={state.error} onRetry={state.reload} />
      ) : items.length === 0 ? (
        <EmptyBlock title={q ? `אין עסק שמתאים ל"${q}"` : "אין עסקים בסינון הזה"}>
          {q ? "נסה חלק מהשם, מזהה מספרי או מייל מלא." : "נסה סינון אחר."}
        </EmptyBlock>
      ) : (
        <section className={styles.card} aria-label="רשימת עסקים" aria-busy={state.loading}>
          <div className={`${styles.tableWrap} ${styles.hideOnPhone}`}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">עסק</th>
                  <th scope="col">משתמש</th>
                  <th scope="col">הצטרף</th>
                  <th scope="col">פעילות אחרונה</th>
                  <th scope="col">אונבורדינג</th>
                  <th scope="col">מסמכים לבדיקה</th>
                  <th scope="col">מצב</th>
                </tr>
              </thead>
              <tbody>
                {items.map((b) => (
                  <tr key={b.id}>
                    <td>
                      <Link href={`/admin/businesses/${b.id}`} className={`${styles.rowLink}`}>
                        <span className={styles.rowTitle}>{b.name}</span>
                        <span className={styles.rowSub}>#{b.id}</span>
                      </Link>
                    </td>
                    <td className={styles.muted}>{b.ownerEmail ?? "—"}</td>
                    <td>{dateFmt.format(new Date(b.createdAt))}</td>
                    <td>{b.lastActiveAt ? formatRelativeTime(b.lastActiveAt) : "—"}</td>
                    <td>
                      <OnboardingPill at={b.onboardingCompletedAt} />
                    </td>
                    <td className={styles.num}>{b.counts.documentsNeedsReview}</td>
                    <td>
                      <StatePill item={b} now={now} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className={styles.cards}>
            {items.map((b) => (
              <Link key={b.id} href={`/admin/businesses/${b.id}`} className={styles.mcard}>
                <span className={styles.mcardTop}>
                  <span className={styles.rowTitle}>{b.name}</span>
                  <StatePill item={b} now={now} />
                </span>
                <span className={styles.mcardMeta}>
                  <span>#{b.id}</span>
                  <span>הצטרף {dateFmt.format(new Date(b.createdAt))}</span>
                  <span>{b.lastActiveAt ? `נראה ${formatRelativeTime(b.lastActiveAt)}` : "לא נכנס"}</span>
                  <span>{b.onboardingCompletedAt ? "אונבורדינג הושלם" : "אונבורדינג לא הושלם"}</span>
                </span>
                {b.ownerEmail ? <span className={styles.rowSub}>{b.ownerEmail}</span> : null}
              </Link>
            ))}
          </div>

          {data && data.pagination.totalPages > 1 ? (
            <div className={styles.pager}>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnSmall}`}
                disabled={page <= 1 || state.loading}
                onClick={() => setPage(page - 1)}
              >
                הקודם
              </button>
              <span>
                עמוד {page} מתוך {data.pagination.totalPages}
              </span>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnSmall}`}
                disabled={page >= data.pagination.totalPages || state.loading}
                onClick={() => setPage(page + 1)}
              >
                הבא
              </button>
            </div>
          ) : null}
        </section>
      )}
    </>
  );
}
