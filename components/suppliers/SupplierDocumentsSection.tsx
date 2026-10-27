"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { getSupplierDocuments, type SupplierDocumentRow } from "@/lib/api/document-supplier-link";
import { isUnauthorizedError, redirectToLogin } from "@/lib/client-session";

const PAGE_SIZE = 20;

const DATE = new Intl.DateTimeFormat("he-IL", { day: "2-digit", month: "2-digit", year: "numeric" });
const MONEY = new Intl.NumberFormat("he-IL", { style: "currency", currency: "ILS", maximumFractionDigits: 2 });

function fmtDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : DATE.format(d);
}

/**
 * "מסמכים" in the supplier file (flag `document_supplier_linking`): the documents the owner linked to this
 * supplier, each a link to the document itself. Hebrew-only (new screen). Nothing is summed and nothing is
 * created here: an amount shows only when the document was approved as financial (its FinancialRecord).
 * Feature OFF (404) ⇒ the section is not rendered at all. Loads independently of the rest of the card.
 */
export function SupplierDocumentsSection({
  supplierId,
  className,
  icon,
}: {
  supplierId: number;
  /** The supplier file's panel class — applied only when the section shows (flag ON), so no empty box remains. */
  className?: string;
  /** A coloured section icon, like the other panels of the file. */
  icon?: ReactNode;
}) {
  const [enabled, setEnabled] = useState(true);
  const [rows, setRows] = useState<SupplierDocumentRow[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const busy = useRef(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const page = await getSupplierDocuments(supplierId, { offset: 0, limit: PAGE_SIZE });
        if (!active) return;
        if (!page) {
          setEnabled(false);
          return;
        }
        setError(false);
        setRows(page.rows);
        setTotal(page.total);
        setHasMore(page.hasMore);
      } catch (e) {
        if (!active) return;
        if (isUnauthorizedError(e)) {
          redirectToLogin();
          return;
        }
        setError(true);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [supplierId, reloadKey]);

  const loadMore = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setLoadingMore(true);
    setMoreError(false);
    try {
      const page = await getSupplierDocuments(supplierId, { offset: rows.length, limit: PAGE_SIZE });
      if (!page) return;
      setRows((prev) => {
        const seen = new Set(prev.map((r) => r.documentId));
        return [...prev, ...page.rows.filter((r) => !seen.has(r.documentId))];
      });
      setTotal(page.total);
      setHasMore(page.hasMore);
    } catch (e) {
      if (isUnauthorizedError(e)) {
        redirectToLogin();
        return;
      }
      // The loaded documents stay on screen; only the next page failed.
      setMoreError(true);
    } finally {
      busy.current = false;
      setLoadingMore(false);
    }
  }, [supplierId, rows.length]);

  if (!enabled) return null;

  return (
    <div className={className ? `crm-section ${className}` : "crm-section"} data-testid="supplier-documents">
      <div className="crm-section__head">
        <h2 className="crm-section__title">
          {icon ? <span className="crm-section__icon cust-tone--mail" aria-hidden>{icon}</span> : null}
          מסמכים
        </h2>
        {!loading && !error ? <span className="crm-section__count">{total}</span> : null}
      </div>

      {loading ? (
        <div className="crm-list" aria-busy="true">
          <div className="crm-skel" style={{ height: 56 }} />
          <div className="crm-skel" style={{ height: 56 }} />
        </div>
      ) : error ? (
        <div className="crm-panel crm-panel--error">
          <p className="crm-panel__body">לא הצלחנו לטעון את המסמכים של הספק.</p>
          <button
            type="button"
            className="crm-btn crm-btn--ghost"
            onClick={() => {
              setLoading(true);
              setReloadKey((k) => k + 1);
            }}
          >
            נסו שוב
          </button>
        </div>
      ) : rows.length === 0 ? (
        <p className="sup-empty">
          אין עדיין מסמכים משויכים. מסמך משויך לספק במסך בדיקת המסמך: בוחרים ספק או מאשרים הצעת שיוך.
        </p>
      ) : (
        <>
          <div className="crm-list">
            {rows.map((r) => (
              <SupplierDocumentItem key={r.documentId} row={r} />
            ))}
          </div>
          <p className="crm-item__meta" style={{ marginTop: 8 }}>
            מוצגים {rows.length} מתוך {total}
          </p>
          {moreError ? (
            <div className="crm-panel crm-panel--error" role="alert" style={{ marginTop: 8 }}>
              <p className="crm-panel__body">טעינת מסמכים נוספים נכשלה. המסמכים שכבר נטענו נשארים.</p>
              <button type="button" className="crm-btn crm-btn--ghost" onClick={() => void loadMore()}>
                נסו שוב
              </button>
            </div>
          ) : hasMore ? (
            <button
              type="button"
              className="crm-btn crm-btn--ghost crm-btn--full"
              style={{ marginTop: 8 }}
              disabled={loadingMore}
              onClick={() => void loadMore()}
            >
              {loadingMore ? "טוען…" : "טען עוד מסמכים"}
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

function SupplierDocumentItem({ row }: { row: SupplierDocumentRow }) {
  const title = row.fileName || row.vendorName || `מסמך #${row.documentId}`;
  const docDate = fmtDate(row.documentDate);
  const meta = [
    docDate ? `תאריך מסמך ${docDate}` : `התקבל ${fmtDate(row.receivedAt) ?? ""}`,
    row.status === "approved" ? "אושר" : "ממתין לבדיקה",
    row.method === "SUGGESTION_ACCEPTED" ? "שויך מהצעה" : "שויך ידנית",
  ].join(" · ");
  return (
    <Link className="crm-item" href={`/documents/review/${row.documentId}`} style={{ textDecoration: "none" }}>
      <div className="crm-item__main">
        <div className="crm-item__title">{title}</div>
        <div className="crm-item__meta">{meta}</div>
      </div>
      {row.approved ? (
        <div className="crm-item__amount" title="סכום מאושר מרשומת ההוצאה של המסמך">
          {MONEY.format(row.approved.amount)}
        </div>
      ) : (
        <span className="crm-badge">ללא סכום מאושר</span>
      )}
    </Link>
  );
}
