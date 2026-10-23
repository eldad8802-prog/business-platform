"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { AuthCard, authCardStyles as s } from "@/components/auth/auth-card";
import { PrimaryCta } from "@/components/ui/primary-cta";
import { useI18n } from "@/components/i18n/I18nProvider";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/signup-identity";
import { clearClientSession } from "@/lib/client-session";

type Phase =
  | { kind: "checking" }
  | { kind: "unusable"; message: string }
  | { kind: "form" }
  | { kind: "done" };

/** Reads `#t=<token>` and drops it from the address bar at once, so it is not left in history. */
function takeToken(): string | null {
  const match = /(?:^|[#&])t=([^&]+)/.exec(window.location.hash);
  if (match) window.history.replaceState(null, "", window.location.pathname);
  return match ? decodeURIComponent(match[1]) : null;
}

export default function ResetPasswordPage() {
  const { t } = useI18n();
  const [token, setToken] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "checking" });
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [fieldError, setFieldError] = useState<{ password?: string; confirm?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const linkToken = takeToken();
    if (!linkToken) {
      // After this effect, not inside it (no synchronous cascade).
      queueMicrotask(() =>
        setPhase({ kind: "unusable", message: t("account.auth.reset.linkIncomplete") })
      );
      return;
    }
    queueMicrotask(() => setToken(linkToken));
    fetch("/api/auth/password/reset/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: linkToken }),
    })
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (ok && d?.status === "VALID") setPhase({ kind: "form" });
        else setPhase({ kind: "unusable", message: d?.error ?? t("account.auth.reset.linkInvalid") });
      })
      .catch(() => setPhase({ kind: "form" })); // the submit re-checks everything anyway
  }, [t]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    const next: { password?: string; confirm?: string } = {};
    if (password.length < MIN_PASSWORD_LENGTH) next.password = t("account.auth.common.passwordTooShort", { count: MIN_PASSWORD_LENGTH });
    if (confirm !== password) next.confirm = t("account.auth.reset.mismatch");
    setFieldError(next);
    if (Object.keys(next).length > 0 || !token) return;
    setLoading(true);
    try {
      const res = await fetch("/api/auth/password/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        // Every session of the account was just revoked — this browser's included.
        clearClientSession();
        setPhase({ kind: "done" });
      } else if (data?.field === "password") {
        setFieldError({ password: data.error });
      } else if (typeof data?.code === "string" && data.code.startsWith("TOKEN_")) {
        setPhase({ kind: "unusable", message: data.error });
      } else {
        setFormError(data?.error ?? t("account.auth.common.serverError"));
      }
    } catch {
      setFormError(t("account.auth.common.offline"));
    } finally {
      setLoading(false);
    }
  }

  if (phase.kind === "checking") {
    return (
      <AuthCard title={t("account.auth.reset.title")}>
        <p className={s.info} role="status"><span className={s.spinner} aria-hidden="true" />{t("account.auth.reset.checking")}</p>
      </AuthCard>
    );
  }

  if (phase.kind === "unusable") {
    return (
      <AuthCard title={t("account.auth.reset.unusableTitle")}>
        <div className={s.alert} role="alert" data-testid="reset-unusable">{phase.message}</div>
        <PrimaryCta href="/forgot-password" block>{t("account.auth.reset.requestNew")}</PrimaryCta>
        <p className={s.footer}><Link href="/login" className={s.link}>{t("account.auth.common.backToLogin")}</Link></p>
      </AuthCard>
    );
  }

  if (phase.kind === "done") {
    return (
      <AuthCard title={t("account.auth.reset.doneTitle")} lede={t("account.auth.reset.doneLede")}>
        <p className={s.success} role="status" data-testid="reset-done">
          {t("account.auth.reset.doneBody")}
        </p>
        <PrimaryCta href="/login?reset=done" block>{t("account.auth.reset.toLogin")}</PrimaryCta>
      </AuthCard>
    );
  }

  return (
    <AuthCard title={t("account.auth.reset.title")} lede={t("account.auth.reset.lede")}>
      <form onSubmit={submit} noValidate style={{ display: "contents" }}>
        <div className={s.field}>
          <label className={s.label} htmlFor="reset-password">{t("account.auth.reset.newPasswordLabel")}</label>
          <div className={s.inputShell}>
            <input
              id="reset-password"
              type={show ? "text" : "password"}
              className={`${s.input} ${s.inputWithToggle} ${fieldError.password ? s.inputBad : ""}`}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              autoFocus
              aria-invalid={!!fieldError.password}
              aria-describedby="reset-password-msg"
              dir="ltr"
            />
            <button type="button" className={s.toggle} onClick={() => setShow((v) => !v)} aria-pressed={show} aria-controls="reset-password" aria-label={show ? t("account.auth.reset.hidePasswordAria") : t("account.auth.reset.showPasswordAria")}>
              {show ? t("account.auth.common.hide") : t("account.auth.common.show")}
            </button>
          </div>
          {fieldError.password ? (
            <p id="reset-password-msg" role="alert" className={s.fieldError}>{fieldError.password}</p>
          ) : (
            <p id="reset-password-msg" className={s.helper}>{t("account.auth.reset.minLengthHelp", { count: MIN_PASSWORD_LENGTH })}</p>
          )}
        </div>
        <div className={s.field}>
          <label className={s.label} htmlFor="reset-confirm">{t("account.auth.reset.confirmLabel")}</label>
          <input
            id="reset-confirm"
            type={show ? "text" : "password"}
            className={`${s.input} ${fieldError.confirm ? s.inputBad : ""}`}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            aria-invalid={!!fieldError.confirm}
            aria-describedby="reset-confirm-msg"
            dir="ltr"
          />
          {fieldError.confirm ? <p id="reset-confirm-msg" role="alert" className={s.fieldError}>{fieldError.confirm}</p> : null}
        </div>
        {formError ? <div role="alert" aria-live="assertive" className={s.alert}>{formError}</div> : null}
        <PrimaryCta type="submit" block disabled={loading}>
          {loading ? <><span className={s.spinner} aria-hidden="true" />{t("account.auth.reset.saving")}</> : t("account.auth.reset.submit")}
        </PrimaryCta>
      </form>
    </AuthCard>
  );
}
