"use client";

/**
 * "מסמכים נוספים" — the entry to the additions approved for business documents.
 * Read-only tools and letters; the existing invoices, receipts and credit notes stay
 * in the invoices screen. Behind business_documents (off by default).
 */
import Link from "next/link";

import { useFeatureState } from "@/lib/ui/use-feature-enabled";

import { FeatureOff, Loading, ScreenHead } from "./ui";
import s from "./docs.module.css";

export function BusinessDocumentsHub() {
  const on = useFeatureState("business_documents");
  return (
    <main className={s.screen} data-page-intent="content">
      <div className={s.narrow}>
        <ScreenHead title="מסמכים נוספים" subtitle="מכתבים ומעקב — בלי לשנות חשבוניות" fallback="/billing" fallbackLabel="לחשבוניות" />
        {on === false ? (
          <FeatureOff />
        ) : on === null ? (
          <Loading />
        ) : (
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
        )}
      </div>
    </main>
  );
}
