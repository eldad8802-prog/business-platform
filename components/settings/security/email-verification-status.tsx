"use client";

/**
 * Settings → Security → email address. Whether the account's address is verified and, while it is not, the
 * way to ask for the link again. This is the ONLY place a signed-in owner meets verification: the shell-wide
 * banner was removed (2026-11-10) — it showed on every screen, could not be closed, and read like a sign-in step.
 *
 * Rendered for an account that was opened with verification (or is already verified); an account never asked to
 * verify, or verification turned off here, sees nothing. The state is read again whenever the screen comes back
 * into view, so verifying from the email in Chrome and returning to the app updates it without a reload.
 * Never blocks anything.
 */

import { useCallback, useEffect, useState } from "react";

import { useI18n } from "@/components/i18n/I18nProvider";
import { buildClientAuthHeaders, redirectToLogin } from "@/lib/client-session";
import {
  fetchEmailVerificationView,
  requestVerificationLink,
  watchReturnToScreen,
  type EmailVerificationView,
} from "@/lib/auth/email-verification-client";

type Note = { tone: "error" | "ok"; text: string };

export function EmailVerificationStatus() {
  const { t } = useI18n();
  const [view, setView] = useState<EmailVerificationView | null>(null);
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<Note | null>(null);

  const apply = useCallback((next: EmailVerificationView) => {
    if (next.kind === "signedOut") {
      redirectToLogin();
      return;
    }
    // A failed re-read keeps what is already shown rather than replacing it with an error.
    setView((prev) => (next.kind === "error" && prev && prev.kind !== "error" ? prev : next));
    if (next.kind === "verified") setNote(null);
  }, []);

  useEffect(() => {
    let alive = true;
    void fetchEmailVerificationView(fetch, buildClientAuthHeaders()).then((next) => {
      if (alive) apply(next);
    });
    return () => {
      alive = false;
    };
  }, [apply]);

  // Back from Chrome (or another tab) after opening the link: read the state again — until it is verified.
  const settled = view?.kind === "verified" || view?.kind === "hidden";
  useEffect(() => {
    if (settled) return;
    let alive = true;
    const stop = watchReturnToScreen({ document, window }, () => {
      void fetchEmailVerificationView(fetch, buildClientAuthHeaders()).then((next) => {
        if (alive) apply(next);
      });
    });
    return () => {
      alive = false;
      stop();
    };
  }, [settled, apply]);

  const resend = async () => {
    setSending(true);
    setNote(null);
    const r = await requestVerificationLink(fetch, buildClientAuthHeaders());
    setSending(false);
    switch (r.kind) {
      case "sent":
        setNote({ tone: "ok", text: r.message ?? t("account.auth.emailStatus.sent") });
        return;
      case "alreadyVerified":
        setView({ kind: "verified" });
        return;
      case "notRequired":
        setView({ kind: "hidden" });
        return;
      case "signedOut":
        redirectToLogin();
        return;
      case "rateLimited":
        setNote({ tone: "error", text: r.message ?? t("account.auth.emailStatus.rateLimited") });
        return;
      case "unavailable":
        setNote({ tone: "error", text: r.message ?? t("account.auth.emailStatus.unavailable") });
        return;
      case "failed":
        setNote({ tone: "error", text: r.message ?? t("account.auth.emailStatus.error") });
        return;
      case "offline":
        setNote({ tone: "error", text: t("account.auth.emailStatus.offline") });
        return;
    }
  };

  if (!view || view.kind === "hidden" || view.kind === "signedOut") return null;

  return (
    <section className="flex flex-col gap-3" aria-labelledby="email-verification-title" data-testid="email-verification-status">
      <h2 id="email-verification-title" className="px-1 text-base font-bold text-[var(--dz-text-primary)]">
        {t("account.auth.emailStatus.title")}
      </h2>
      <div className="rounded-3xl dz-mist px-4 py-4 shadow-sm">
        {view.kind === "error" ? (
          <p className="text-sm text-[var(--dz-text-secondary)]" data-testid="email-verification-state">
            {t("account.auth.emailStatus.loadError")}
          </p>
        ) : view.kind === "verified" ? (
          <p className="text-sm font-bold text-[var(--dz-text-primary)]" data-testid="email-verification-state" data-state="verified">
            {t("account.auth.emailStatus.verified")}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="min-w-0">
              <p className="text-sm font-bold text-[var(--dz-text-primary)]" data-testid="email-verification-state" data-state="unverified">
                {t("account.auth.emailStatus.unverified")}
              </p>
              <p className="mt-1 text-xs text-[var(--dz-text-secondary)]">{t("account.auth.emailStatus.unverifiedHint")}</p>
            </div>
            <button
              type="button"
              onClick={resend}
              disabled={sending}
              className="min-h-11 self-start rounded-2xl border border-[var(--dz-border-subtle)] px-4 text-sm font-bold text-[var(--dz-text-primary)] disabled:opacity-70"
              data-testid="email-verification-resend"
            >
              {sending ? t("account.auth.common.sending") : t("account.auth.emailStatus.resend")}
            </button>
          </div>
        )}
        {note ? (
          <p
            role={note.tone === "error" ? "alert" : "status"}
            className={`mt-3 text-sm ${note.tone === "error" ? "text-[var(--dz-danger,#9c3232)]" : "text-[var(--dz-app-chrome)]"}`}
            data-testid="email-verification-message"
          >
            {note.text}
          </p>
        ) : null}
      </div>
    </section>
  );
}
