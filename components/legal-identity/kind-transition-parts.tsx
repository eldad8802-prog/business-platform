"use client";

/**
 * Shared pieces of "מעבר לעוסק מורשה" (owner-approved design): the stroke icons and the "שם או מספר שגוי?" sheet.
 * The sheet is a real modal dialog: focus moves into it, Escape closes it, and focus returns to the opener.
 */
import { useEffect, useRef, type ReactNode } from "react";

import s from "@/app/business/legal-identity/kind-transition/kind-transition.module.css";

type IconProps = { size?: number; className?: string; strokeWidth?: number };
const base = (size: number, strokeWidth: number, className?: string) => ({
  width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth,
  strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true, className,
});

export const IconBack = ({ size = 22, className }: IconProps) => <svg {...base(size, 2, className)}><path d="M9 6l6 6-6 6" /></svg>;
export const IconChevronStart = ({ size = 20, className }: IconProps) => <svg {...base(size, 2, className)}><path d="M15 6l-6 6 6 6" /></svg>;
export const IconArrowStart = ({ size = 22, className }: IconProps) => <svg {...base(size, 2, className)}><path d="M4 12h12" /><path d="M12 6l6 6-6 6" /></svg>;
export const IconCheck = ({ size = 20, className, strokeWidth = 2.2 }: IconProps) => <svg {...base(size, strokeWidth, className)}><path d="M20 6L9 17l-5-5" /></svg>;
export const IconDoc = ({ size = 20, className }: IconProps) => <svg {...base(size, 2, className)}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></svg>;
export const IconPlus = ({ size = 20, className }: IconProps) => <svg {...base(size, 2, className)}><path d="M12 5v14" /><path d="M5 12h14" /></svg>;
export const IconPercent = ({ size = 20, className }: IconProps) => <svg {...base(size, 2, className)}><path d="M19 5L5 19" /><circle cx="7" cy="7" r="2" /><circle cx="17" cy="17" r="2" /></svg>;
export const IconLock = ({ size = 20, className }: IconProps) => <svg {...base(size, 2, className)}><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>;
export const IconInfo = ({ size = 18, className }: IconProps) => <svg {...base(size, 2, className)}><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 8h.01" /></svg>;
export const IconAlert = ({ size = 16, className }: IconProps) => <svg {...base(size, 2, className)}><circle cx="12" cy="12" r="9" /><path d="M12 8v5" /><path d="M12 16h.01" /></svg>;
export const IconWarn = ({ size = 18, className }: IconProps) => <svg {...base(size, 2, className)}><path d="M12 3l9 16H3z" /><path d="M12 10v4" /><path d="M12 17h.01" /></svg>;
export const IconSpinner = ({ size = 18, className }: IconProps) => <svg {...base(size, 2.2, className)}><path d="M21 12a9 9 0 1 1-6.2-8.6" /></svg>;
export const GoogleMark = () => (
  <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.4 30.2 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.8 6C12.4 13.6 17.7 9.5 24 9.5z" />
    <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4.1 7.1-10.1 7.1-17.5z" />
    <path fill="#FBBC05" d="M10.5 28.7c-.5-1.4-.8-3-.8-4.7s.3-3.3.8-4.7l-7.8-6C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l7.8-6z" />
    <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.5-5.8c-2.1 1.4-4.9 2.3-8.4 2.3-6.3 0-11.6-4.2-13.5-9.9l-7.8 6C6.6 42.6 14.6 48 24 48z" />
  </svg>
);

export function Note({ tone, children, column = false, role }: { tone: "info" | "warn" | "err" | "ok"; children: ReactNode; column?: boolean; role?: "alert" | "status" }) {
  const toneClass = { info: s.noteInfo, warn: s.noteWarn, err: s.noteErr, ok: s.noteOk }[tone];
  return <div className={`${s.note} ${toneClass} ${column ? s.noteColumn : ""}`} role={role}>{children}</div>;
}

/** "שם או מספר שגוי?" — Path B: a new business file; the current one stays as it is. */
export function NewFileSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement;
    dialogRef.current?.focus();
    return () => {
      const el = openerRef.current as HTMLElement | null;
      el?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className={s.scrim} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={dialogRef}
        className={s.sheet}
        role="dialog"
        aria-modal="true"
        aria-labelledby="kt-sheet-title"
        tabIndex={-1}
        onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}
        data-testid="kt-new-file-sheet"
      >
        <span className={s.grab} aria-hidden="true" />
        <h2 id="kt-sheet-title" className={s.sheetTitle}>שם או מספר שגוי?</h2>
        <p className={s.sheetText}>השם המשפטי ומספר העוסק לא משתנים בתיק קיים — גם לא כדי לתקן טעות הקלדה. כך כל מסמך שהופק נשאר נכון ועקבי.</p>
        <p className={s.sheetText}>כדי לעבוד עם פרטים אחרים, פותחים <strong>תיק עסק חדש</strong>. התיק הנוכחי נשאר, עם כל המסמכים שלו, ואפשר להמשיך להיכנס אליו.</p>
        <Note tone="info"><IconInfo /><span>כרגע פותחים תיק חדש בהרשמה נפרדת, עם כתובת מייל אחרת.</span></Note>
        <button type="button" className={s.btnPrimary} onClick={onClose}>הבנתי</button>
      </div>
    </div>
  );
}
