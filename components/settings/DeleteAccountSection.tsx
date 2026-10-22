"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { useI18n } from "@/components/i18n/I18nProvider";

/**
 * Self-service account deletion (Wave 1B). Discoverable in-app entry that satisfies
 * the app-store requirement (Apple 5.1.1(v) / Google Play). Explains what is deleted
 * vs legally retained, requires an explicit typed confirmation (no one-click), and
 * calls DELETE /api/account. On success the session is cleared and the user is sent
 * to /login (the account is closed → auth fails closed).
 */
// The word to type ("מחיקה" in Hebrew) is the dictionary's, per language.

function authToken(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem("token") || "";
}

export function DeleteAccountSection() {
  const router = useRouter();
  const { t } = useI18n();
  const CONFIRM_WORD = t("account.settings.deleteAccount.confirmWord");
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
        setError(t("account.settings.deleteAccount.errorMultiUser"));
      } else if (res.status === 401) {
        setError(t("account.settings.deleteAccount.errorSession"));
      } else {
        setError(t("account.settings.deleteAccount.errorFailed"));
      }
    } catch {
      setError(t("account.settings.deleteAccount.errorFailed"));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div role="status" aria-live="polite" className="rounded-2xl dz-mist p-4 text-sm text-[var(--dz-text-secondary)] shadow-sm">
        {t("account.settings.deleteAccount.done")}
      </div>
    );
  }

  return (
    <section className="rounded-2xl dz-mist p-4 shadow-sm">
      <h2 className="mb-1 text-base font-bold text-[var(--dz-text-primary)]">{t("account.settings.deleteAccount.title")}</h2>
      <p className="mb-3 text-sm leading-6 text-[var(--dz-text-muted)]">
        {t("account.settings.deleteAccount.body")}{" "}<span className="font-semibold text-[var(--dz-text-primary)]">{t("account.settings.deleteAccount.irreversible")}</span>
      </p>

      {!open ? (
        <button
          type="button"
          onClick={() => { setOpen(true); setError(null); }}
          data-dz-action="danger"
          className="inline-flex min-h-[44px] items-center justify-center rounded-2xl border border-[var(--dz-danger-border)] bg-[var(--dz-surface-flat)] px-4 text-sm font-semibold text-[var(--dz-danger)] hover:bg-[var(--dz-danger-bg-soft)]"
        >
          {t("account.settings.deleteAccount.open")}
        </button>
      ) : (
        <div className="rounded-xl border border-[var(--dz-danger-border)] bg-[var(--dz-danger-bg-soft)] p-3">
          <label htmlFor="delete-confirm" className="mb-1 block text-sm font-medium text-[var(--dz-text-primary)]">
            {t("account.settings.deleteAccount.confirmLabel", { word: CONFIRM_WORD })}
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
              {busy ? t("account.settings.deleteAccount.deleting") : t("account.settings.deleteAccount.confirm")}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => { setOpen(false); setConfirmText(""); setError(null); }}
              className="inline-flex min-h-[44px] items-center justify-center rounded-2xl border border-[var(--dz-border-strong)] dz-mist px-4 text-sm font-semibold text-[var(--dz-text-secondary)]"
            >
              {t("common.cancel")}
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
