"use client";

/**
 * The four non-data states every console block shows the same way: loading,
 * error (with what to do about it), no data yet, and no permission. A block
 * that fails never hides the others.
 */
import type { ReactNode } from "react";
import { PlatformAdminFetchError } from "@/lib/platform-admin/fetch-platform-admin";
import { ConsoleIcon } from "./console-icons";
import styles from "./admin-console.module.css";

export function LoadingBlock({ height = 120, label }: { height?: number; label?: string }) {
  return (
    <div
      className={styles.skeleton}
      style={{ height }}
      role="status"
      aria-live="polite"
      aria-label={label ?? "טוען"}
    />
  );
}

/** What the person should know and do, per failure. Never a raw stack. */
export function describeAdminError(error: unknown): { title: string; body: string } {
  if (error instanceof PlatformAdminFetchError) {
    if (error.code === "ADMIN_DATA_PLANE_UNAVAILABLE") {
      return {
        title: "מקור הנתונים של הניהול לא מחובר בסביבה הזו",
        body: "כדי לא להציג מספרים שגויים, הנתונים לא מוצגים עד שחיבור הקריאה של הניהול יוגדר (ADMIN_DATABASE_URL).",
      };
    }
    if (error.code === "ADMIN_MFA_REQUIRED") {
      return {
        title: "נדרש אימות נוסף",
        body: "הנתונים מוגנים. אמת שוב עם אפליקציית האימות או מפתח גישה.",
      };
    }
    if (error.status === 403) {
      return { title: "אין הרשאה למסך הזה", body: "החשבון הזה לא מורשה לצפות בנתונים האלה." };
    }
    if (error.status === 429) {
      return { title: "יותר מדי בקשות", body: "המתן מעט ונסה שוב." };
    }
    if (error.status === 404) {
      return { title: "לא נמצא", body: "הפריט לא קיים או הוסר." };
    }
  }
  return { title: "לא הצלחנו לטעון את הנתונים", body: "נסה שוב. אם זה חוזר, בדוק את מצב המערכת." };
}

export function ErrorBlock({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { title, body } = describeAdminError(error);
  return (
    <div className={`${styles.stateBox} ${styles.stateError}`} role="alert">
      <h2>{title}</h2>
      <p>{body}</p>
      {onRetry ? (
        <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={onRetry}>
          <ConsoleIcon name="refresh" size={16} />
          נסה שוב
        </button>
      ) : null}
    </div>
  );
}

export function EmptyBlock({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className={styles.stateBox}>
      <h2>{title}</h2>
      {children ? <p>{children}</p> : null}
    </div>
  );
}
