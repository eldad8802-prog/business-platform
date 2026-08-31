"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Self-service account deletion (Wave 1B). Discoverable in-app entry that satisfies
 * the app-store requirement (Apple 5.1.1(v) / Google Play). Explains what is deleted
 * vs legally retained, requires an explicit typed confirmation (no one-click), and
 * calls DELETE /api/account. On success the session is cleared and the user is sent
 * to /login (the account is closed → auth fails closed).
 */
const CONFIRM_WORD = "מחיקה";

function authToken(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem("token") || "";
}

export function DeleteAccountSection() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function handleDelete() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/account", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${authToken()}` },
      });
      if (res.ok) {
        setDone(true);
        try { localStorage.removeItem("token"); } catch { /* ignore */ }
        setTimeout(() => router.replace("/login"), 1800);
        return;
      }
      if (res.status === 409) {
        setError("לא ניתן למחוק את החשבון אוטומטית כאשר יש יותר ממשתמש אחד בעסק. לפנייה בנושא זה יש ליצור קשר עם התמיכה.");
      } else if (res.status === 401) {
        setError("החיבור פג. יש להתחבר מחדש ולנסות שוב.");
      } else {
        setError("מחיקת החשבון נכשלה. נסו שוב מאוחר יותר.");
      }
    } catch {
      setError("מחיקת החשבון נכשלה. נסו שוב מאוחר יותר.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div role="status" aria-live="polite" className="rounded-2xl bg-[var(--dz-surface)] p-4 text-sm text-[var(--dz-text-secondary)] shadow-sm">
        בקשת מחיקת החשבון התקבלה והחשבון נסגר. מעבירים אתכם למסך ההתחברות…
      </div>
    );
  }

  return (
    <section className="rounded-2xl bg-[var(--dz-surface)] p-4 shadow-sm" dir="rtl">
      <h2 className="mb-1 text-base font-bold text-[var(--dz-text-primary)]">מחיקת חשבון</h2>
      <p className="mb-3 text-sm leading-6 text-[var(--dz-text-muted)]">
        מחיקת החשבון תסיר את פרטי המשתמש והמידע התפעולי (לקוחות, שיחות, קבצים והחיבורים
        החיצוניים) ותנתק את השירותים המחוברים. מסמכים ורשומות שהחוק מחייב לשמור — כמו
        חשבוניות וקבלות ורשומות הנהלת חשבונות — עשויים להישמר לתקופת השמירה הקבועה בדין,
        ולא ישמשו להפעלת חשבון פעיל. <span className="font-semibold text-[var(--dz-text-primary)]">הפעולה בלתי הפיכה.</span>
      </p>

      {!open ? (
        <button
          type="button"
          onClick={() => { setOpen(true); setError(null); }}
          className="inline-flex min-h-[44px] items-center justify-center rounded-2xl border border-[var(--dz-danger-border)] bg-[var(--dz-surface)] px-4 text-sm font-semibold text-[var(--dz-danger)] hover:bg-[var(--dz-danger-bg-soft)]"
        >
          מחיקת החשבון שלי
        </button>
      ) : (
        <div className="rounded-xl border border-[var(--dz-danger-border)] bg-[var(--dz-danger-bg-soft)] p-3">
          <label htmlFor="delete-confirm" className="mb-1 block text-sm font-medium text-[var(--dz-text-primary)]">
            לאישור, הקלידו את המילה “{CONFIRM_WORD}”
          </label>
          <input
            id="delete-confirm"
            type="text"
            autoComplete="off"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            className="mb-3 w-full rounded-xl border border-[var(--dz-border-strong)] px-3 py-2 text-sm"
            aria-describedby={error ? "delete-error" : undefined}
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy || confirmText.trim() !== CONFIRM_WORD}
              onClick={handleDelete}
              className="inline-flex min-h-[44px] items-center justify-center rounded-2xl bg-[var(--dz-danger-accent)] px-4 text-sm font-semibold text-[var(--dz-text-on-brand)] disabled:opacity-50"
            >
              {busy ? "מוחק…" : "מחיקה סופית"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => { setOpen(false); setConfirmText(""); setError(null); }}
              className="inline-flex min-h-[44px] items-center justify-center rounded-2xl border border-[var(--dz-border-strong)] bg-[var(--dz-surface)] px-4 text-sm font-semibold text-[var(--dz-text-secondary)]"
            >
              ביטול
            </button>
          </div>
        </div>
      )}

      {error ? (
        <p id="delete-error" role="alert" aria-live="assertive" className="mt-3 text-sm text-[var(--dz-danger)]">
          {error}
        </p>
      ) : null}
    </section>
  );
}
