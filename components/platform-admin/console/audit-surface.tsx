"use client";

/**
 * Admin action log (A1). Every admin change, every sensitive view and every
 * factor proof, newest first. The default view is CHANGES — the rows that
 * altered something — so page views do not bury them; one tap shows the rest.
 * A change row shows what it changed from and to, and the reason given.
 */
import Link from "next/link";
import { useEntryState } from "@/hooks/useEntryState";
import type { PlatformAdminAuditResponse } from "@/lib/services/platform-admin/platform-audit-list.types";
import {
  fetchPlatformAdminAudit,
  type PlatformAdminAuditKind,
} from "@/lib/platform-admin/fetch-platform-admin";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "./console-states";
import { useAdminLoad } from "./use-admin-load";
import styles from "./admin-console.module.css";

const KINDS: Array<{ key: PlatformAdminAuditKind; label: string }> = [
  { key: "changes", label: "שינויים" },
  { key: "security", label: "אבטחה" },
  { key: "views", label: "צפיות" },
  { key: "all", label: "הכול" },
];

const PAGE_SIZE = 30;

const timeFmt = new Intl.DateTimeFormat("he-IL", { dateStyle: "short", timeStyle: "short" });

export function AuditSurface({ businessId }: { businessId?: number }) {
  // Embedded in a business card, the keys are namespaced so they never collide
  // with that screen's own list state.
  const ns = businessId ? "bizAudit." : "";
  const [kind, setKind] = useEntryState<PlatformAdminAuditKind>(`${ns}kind`, "changes");
  const [page, setPage] = useEntryState(`${ns}page`, 1);
  const state = useAdminLoad<PlatformAdminAuditResponse>(
    `audit:${kind}:${page}:${businessId ?? ""}`,
    () => fetchPlatformAdminAudit(page, PAGE_SIZE, { kind, businessId })
  );
  // Keep the previous page on screen while the next one loads.
  const data = state.data ?? (state.loading ? state.previous : null);

  return (
    <>
      {businessId ? null : (
        <div className={styles.pageHead}>
          <div>
            <h1>יומן פעולות</h1>
            <p>
              {data
                ? `${data.summary.events24h.toLocaleString("he-IL")} אירועים ב־24 השעות האחרונות · ${data.summary.uniqueAdmins7d} מנהלים פעילים השבוע`
                : "טוען…"}
            </p>
          </div>
        </div>
      )}

      <div className={styles.chips} role="group" aria-label="סוג אירוע">
        {KINDS.map((k) => (
          <button
            key={k.key}
            type="button"
            className={styles.chip}
            aria-pressed={kind === k.key}
            onClick={() => {
              setKind(k.key);
              setPage(1);
            }}
          >
            {k.label}
          </button>
        ))}
      </div>

      {state.loading && !data ? (
        <LoadingBlock height={240} label="טוען יומן" />
      ) : state.error ? (
        <ErrorBlock error={state.error} onRetry={state.reload} />
      ) : !data || data.items.length === 0 ? (
        <EmptyBlock title="אין אירועים בתצוגה הזו">
          {kind === "changes" ? "עדיין לא בוצעו שינויים. אפשר לעבור ל״הכול״ כדי לראות גם צפיות." : undefined}
        </EmptyBlock>
      ) : (
        <section className={businessId ? undefined : styles.card} aria-busy={state.loading} aria-label="אירועי יומן">
          <div className={styles.list}>
            {data.items.map((item) => (
              <div key={item.id} className={styles.row}>
                <i
                  className={`${styles.stripe} ${
                    item.tone === "warning" ? styles.stripeHigh : item.tone === "sensitive" ? styles.stripeMedium : ""
                  }`}
                  aria-hidden="true"
                />
                <span>
                  <span className={styles.rowTitle}>{item.actionLabel}</span>
                  <span className={styles.rowSub}>
                    {[
                      item.actor.display,
                      item.target.type === "BUSINESS" && item.target.id ? null : item.target.display,
                      item.detail,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  {item.target.type === "BUSINESS" && item.target.id ? (
                    <Link href={`/admin/businesses/${item.target.id}`} className={styles.linkBtn}>
                      {item.target.display}
                    </Link>
                  ) : null}
                </span>
                <time className={styles.muted} dateTime={item.timestamp}>
                  {timeFmt.format(new Date(item.timestamp))}
                </time>
              </div>
            ))}
          </div>
          {data.pagination.totalPages > 1 ? (
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
