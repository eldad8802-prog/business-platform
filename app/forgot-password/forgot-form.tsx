"use client";

import Link from "next/link";
import { useState } from "react";

import { AuthCard, authCardStyles as s } from "@/components/auth/auth-card";
import { PrimaryCta } from "@/components/ui/primary-cta";
import { useI18n } from "@/components/i18n/I18nProvider";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Ask for a reset link. Whatever the address, the answer on screen is the same — the server never
 * says whether an account exists, and neither does this page.
 */
export default function ForgotForm() {
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [sentMessage, setSentMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!EMAIL.test(email.trim())) {
      setFieldError(t("account.auth.common.emailInvalid"));
      return;
    }
    setFieldError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/password/forgot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setSentMessage(data?.message ?? t("account.auth.forgot.sentFallback"));
      } else if (data?.field === "email") {
        setFieldError(data.error);
      } else {
        setFormError(data?.error ?? t("account.auth.common.serverError"));
      }
    } catch {
      setFormError(t("account.auth.common.offline"));
    } finally {
      setLoading(false);
    }
  }

  if (sentMessage) {
    return (
      <AuthCard title={t("account.auth.forgot.sent.title")} lede={sentMessage}>
        <p className={s.info} role="status" data-testid="forgot-sent">
          {t("account.auth.forgot.sent.body")}
        </p>
        <p className={s.footer}>
          <Link href="/login" className={s.link}>{t("account.auth.common.backToLogin")}</Link>
        </p>
      </AuthCard>
    );
  }

  return (
    <AuthCard title={t("account.auth.forgot.title")} lede={t("account.auth.forgot.lede")}>
      <form onSubmit={submit} noValidate style={{ display: "contents" }}>
        <div className={s.field}>
          <label className={s.label} htmlFor="forgot-email">{t("account.auth.common.emailLabel")}</label>
          <input
            id="forgot-email"
            type="email"
            className={`${s.input} ${fieldError ? s.inputBad : ""}`}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            spellCheck={false}
            autoFocus
            placeholder="name@example.com"
            aria-invalid={!!fieldError}
            aria-describedby="forgot-email-msg"
            dir="ltr"
          />
          {fieldError ? (
            <p id="forgot-email-msg" role="alert" className={s.fieldError}>{fieldError}</p>
          ) : (
            <p id="forgot-email-msg" className={s.helper}>{t("account.auth.forgot.emailHelp")}</p>
          )}
        </div>
        {formError ? <div role="alert" aria-live="assertive" className={s.alert}>{formError}</div> : null}
        <PrimaryCta type="submit" block disabled={loading}>
          {loading ? <><span className={s.spinner} aria-hidden="true" />{t("account.auth.common.sending")}</> : t("account.auth.forgot.submit")}
        </PrimaryCta>
        <p className={s.footer}>
          {t("account.auth.forgot.remembered")} <Link href="/login" className={s.link}>{t("account.auth.common.backToLogin")}</Link>
        </p>
      </form>
    </AuthCard>
  );
}
