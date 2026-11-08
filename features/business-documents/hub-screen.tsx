"use client";

/**
 * "מסמכים נוספים" — the entry to the additions approved for business documents.
 * Letters, and the follow-up of regular quotes (a stored share copy + the owner's manual record); the existing
 * invoices, receipts, credit notes and quotes themselves stay in the invoices screen. Behind business_documents
 * (off by default).
 */
import Link from "next/link";
import { useEffect, useState } from "react";

import { useFeatureState } from "@/lib/ui/use-feature-enabled";

import { listShareableQuotes, type ShareableQuote, type ShareEventKindWire } from "./business-documents-client";
import { FeatureOff, Loading, ScreenHead } from "./ui";
import s from "./docs.module.css";

const LAST: Partial<Record<ShareEventKindWire, string>> = {
  MARKED_SENT: "סימנת שנשלחה",
  RESPONSE_ACCEPTED: "רשמת: אושרה",
  RESPONSE_DECLINED: "רשמת: נדחתה",
  DOWNLOADED: "הורד עותק",
  SHARE_SHEET_OPENED: "נפתח שיתוף",
  NOTE: "יש הערה",
};

export function BusinessDocumentsHub() {
  const on = useFeatureState("business_documents");
  const [quotes, setQuotes] = useState<ShareableQuote[] | null>(null);
  const [quotesFailed, setQuotesFailed] = useState(false);

  useEffect(() => {
    if (!on) return;
    let live = true;
    listShareableQuotes().then((q) => live && setQuotes(q), () => live && setQuotesFailed(true));
    return () => {
      live = false;
    };
  }, [on]);

  return (
    <main className={s.screen} data-page-intent="content">
      <div className={s.narrow}>
        <ScreenHead title="מסמכים נוספים" subtitle="מכתבים ומעקב — בלי לשנות חשבוניות" fallback="/billing" fallbackLabel="לחשבוניות" />
        {on === false ? (
          <FeatureOff />
        ) : on === null ? (
          <Loading />
        ) : (
          <>
            <ul className={s.list}>
              <li>
                <Link className={s.row} href="/business-documents/letters/new">
                  <span className={s.rowText}>
                    <span className={s.rowTitle}>מכתב חדש</span>
                    <span className={s.rowSub}>מכתב על נייר המכתבים של העסק — תצוגה מקדימה, PDF ושיתוף</span>
                  </span>
                </Link>
              </li>
            </ul>
            <section className={s.section}>
              <h2 className={s.sectionTitle}>מעקב הצעות מחיר</h2>
              <p className={s.hint}>עותק לשיתוף ורישום ידני שלך: הורדה, שיתוף, סימון כנשלח ותגובה.</p>
              {quotesFailed ? (
                <p className={s.error} role="alert">לא הצלחנו לטעון את ההצעות.</p>
              ) : quotes === null ? (
                <Loading />
              ) : quotes.length === 0 ? (
                <p className={s.note}>אין עדיין הצעות מחיר.</p>
              ) : (
                <ul className={s.list}>
                  {quotes.map((q) => (
                    <li key={q.id}>
                      <Link className={s.row} href={`/business-documents/quotes/${q.id}`}>
                        <span className={s.rowText}>
                          <span className={s.rowTitle}>{q.number ? `הצעה ${q.number}` : "הצעה ללא מספר"} · {q.customerName ?? "ללא שם"}</span>
                          <span className={s.rowSub}>{q.convertedToInvoice ? "הומרה לחשבונית" : q.lastEvent ? LAST[q.lastEvent] ?? "" : "אין רישומים"}</span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </main>
  );
}
