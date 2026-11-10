"use client";

/**
 * "תיקונים ושירות" — the Service Desk home (UI 1.3a, PR 1). For now it leads to the service settings only; the cases list
 * and opening a case arrive in the next step and are not shown before they work. Opened from «ניהול העסק». Every answer
 * comes from the server's Service Desk gate (GET /api/service-desk/access): while service_desk is off, no business sees it.
 */
import Link from "next/link";

import { Chevron, LoadError, Loading, NotOpen, ReadOnlyBanner, ScreenHead } from "./ui";
import { useServiceDeskAccess } from "./use-service-desk-access";
import s from "./sd.module.css";

export function ServiceDeskHome() {
  const { access, retry } = useServiceDeskAccess();

  return (
    <main className={s.screen} data-page-intent="content">
      <div className={s.narrow}>
        <ScreenHead title="תיקונים ושירות" subtitle="קריאות שירות ותיקונים לעסק" fallback="/app" fallbackLabel="לבית" />
        {access.status === "loading" ? (
          <Loading />
        ) : access.status === "error" ? (
          <LoadError text="לא הצלחנו לבדוק אם מערכת השירות פתוחה לעסק." onRetry={retry} />
        ) : access.status === "none" ? (
          <NotOpen />
        ) : (
          <>
            {access.mode === "READ_ONLY" ? <ReadOnlyBanner /> : null}
            <ul className={s.list}>
              <li>
                <Link className={s.row} href="/service-desk/settings">
                  <span className={s.rowText}>
                    <span className={s.rowTitle}>הגדרות שירות</span>
                    <span className={s.rowSub}>טכנאי ברירת מחדל ואחריות לתיקון</span>
                  </span>
                  <Chevron />
                </Link>
              </li>
            </ul>
            <p className={s.note}>רשימת התיקים ופתיחת תיק חדש יתווספו כאן בשלב הבא.</p>
          </>
        )}
      </div>
    </main>
  );
}
