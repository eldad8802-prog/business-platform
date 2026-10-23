"use client";

import { useEffect, useRef, useState } from "react";

import { AuthCard, authCardStyles as s } from "@/components/auth/auth-card";
import { PrimaryCta } from "@/components/ui/primary-cta";
import { useI18n } from "@/components/i18n/I18nProvider";

type Phase = { kind: "working" } | { kind: "verified"; message: string } | { kind: "failed"; message: string };

/**
 * Opened from the verification email. The link is the proof — no session is needed, so it works on
 * any device. The token is read from the fragment and dropped from the address bar at once.
 */
export default function VerifyEmailPage() {
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>({ kind: "working" });
  const once = useRef(false);

  useEffect(() => {
    if (once.current) return; // a link is spent once; StrictMode must not post it twice
    once.current = true;
    const match = /(?:^|[#&])t=([^&]+)/.exec(window.location.hash);
    if (match) window.history.replaceState(null, "", window.location.pathname);
    if (!match) {
      // After this effect, not inside it (no synchronous cascade).
      queueMicrotask(() => setPhase({ kind: "failed", message: t("account.auth.verify.linkIncomplete") }));
      return;
    }
    fetch("/api/auth/email/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: decodeURIComponent(match[1]) }),
    })
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (ok) setPhase({ kind: "verified", message: d?.message ?? t("account.auth.verify.verifiedFallback") });
        else setPhase({ kind: "failed", message: d?.error ?? t("account.auth.verify.linkInvalid") });
      })
      .catch(() => setPhase({ kind: "failed", message: t("account.auth.verify.offline") }));
  }, [t]);

  if (phase.kind === "working") {
    return (
      <AuthCard title={t("account.auth.verify.title")}>
        <p className={s.info} role="status"><span className={s.spinner} aria-hidden="true" />{t("account.auth.verify.working")}</p>
      </AuthCard>
    );
  }
  if (phase.kind === "verified") {
    return (
      <AuthCard title={t("account.auth.verify.verifiedTitle")} lede={phase.message}>
        <p className={s.success} role="status" data-testid="verify-done">{t("account.auth.verify.verifiedBody")}</p>
        <PrimaryCta href="/app" block>{t("account.auth.verify.enterApp")}</PrimaryCta>
      </AuthCard>
    );
  }
  return (
    <AuthCard title={t("account.auth.verify.failedTitle")}>
      <div className={s.alert} role="alert" data-testid="verify-failed">{phase.message}</div>
      <p className={s.info}>{t("account.auth.verify.failedBody")}</p>
      <PrimaryCta href="/app" block>{t("account.auth.verify.enterApp")}</PrimaryCta>
    </AuthCard>
  );
}
