"use client";

/**
 * ר3 — "מסמכים של הלקוח": every billing document of one customer, newest first,
 * grouped by month, each linking to its EXISTING screen (/billing/[id]).
 *
 * Read only. Nothing here changes a document, computes a balance or keeps a copy:
 * the list is the existing billing list route filtered by customer, page by page.
 * Behind the business_documents feature (off by default).
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useFeatureState } from "@/lib/ui/use-feature-enabled";

import { DocsApiError, getCustomerName, listCustomerDocuments } from "./business-documents-client";
import { buildTimeline, errorText, mergePages, type BillingListRow } from "./customer-documents-model";
import { Empty, FeatureOff, Loading, LoadError, ScreenHead } from "./ui";
import s from "./docs.module.css";

export function CustomerDocumentsScreen({ customerId }: { customerId: number }) {
  const on = useFeatureState("business_documents");
  const [rows, setRows] = useState<BillingListRow[] | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (on !== true) return;
    let live = true;
    Promise.all([listCustomerDocuments(customerId, null), getCustomerName(customerId).catch(() => "")])
      .then(([page, customerName]) => {
        if (!live) return;
        setRows(page.documents);
        setCursor(page.nextCursor);
        setName(customerName);
      })
      .catch((e) => live && setError(errorText(e instanceof DocsApiError ? e.status : null)));
    return () => {
      live = false;
    };
  }, [customerId, on, tick]);

  const more = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await listCustomerDocuments(customerId, cursor);
      setRows((cur) => mergePages(cur ?? [], page.documents));
      setCursor(page.nextCursor);
    } catch (e) {
      setError(errorText(e instanceof DocsApiError ? e.status : null));
    } finally {
      setLoadingMore(false);
    }
  }, [customerId, cursor, loadingMore]);

  const groups = useMemo(() => buildTimeline(rows ?? []), [rows]);

  return (
    <main className={s.screen} data-page-intent="content">
      <div className={s.narrow}>
        <ScreenHead
          title="מסמכים של הלקוח"
          subtitle={name || undefined}
          fallback={`/customers/${customerId}`}
          fallbackLabel="לכרטיס הלקוח"
        />
        {on === false ? (
          <FeatureOff />
        ) : on === null || (rows === null && !error) ? (
          <Loading />
        ) : error && rows === null ? (
          <LoadError text={error} onRetry={() => { setRows(null); setError(null); setTick((t) => t + 1); }} />
        ) : groups.length === 0 ? (
          <Empty title="אין עדיין מסמכים ללקוח הזה" />
        ) : (
          <>
            <p className={s.note}>הרשימה מציגה את המסמכים כפי שהם במסך החשבוניות. לפתיחת מסמך — לחיצה עליו.</p>
            {groups.map((g) => (
              <section key={g.key} className={s.section} aria-label={g.label}>
                <h2 className={s.sectionTitle}>{g.label}</h2>
                <ul className={s.list}>
                  {g.items.map((it) => (
                    <li key={it.id}>
                      <Link className={s.row} href={it.href}>
                        <span className={s.rowText}>
                          <span className={s.rowTitle}><bdi>{it.title}</bdi></span>
                          <span className={s.rowSub}>
                            <span className={`${s.tag} ${it.statusTone === "ok" ? s.tagOk : it.statusTone === "warn" ? s.tagWarn : ""}`}>{it.statusLabel}</span>
                            <span>{it.dateLabel}</span>
                          </span>
                        </span>
                        <span className={s.rowEnd}><bdi>{it.amountLabel}</bdi></span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            {error ? <LoadError text={error} onRetry={more} /> : null}
            {cursor ? (
              <div className={s.actions}>
                <button type="button" className={s.button} onClick={more} disabled={loadingMore}>
                  {loadingMore ? "טוען…" : "להציג עוד"}
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </main>
  );
}
