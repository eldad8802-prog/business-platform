"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { DubizLogo } from "@/components/ui/dubiz-logo";
import { PrimaryCta } from "@/components/ui/primary-cta";
import { AccessibilityTrigger } from "@/components/ui/accessibility/accessibility-trigger";
import { useI18n } from "@/components/i18n/I18nProvider";
import { GoogleNotice, GoogleSignInButton } from "@/components/auth/google-sign-in";

const LOGIN_A11Y_STYLE: React.CSSProperties = {
  position: "absolute",
  top: "calc(16px + env(safe-area-inset-top, 0px))",
  insetInlineEnd: 16,
  width: 44,
  height: 44,
  borderRadius: 12,
  border: "1px solid var(--dz-border)",
  background: "var(--dz-surface-flat)",
  color: "var(--dz-text-primary)",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
  padding: 0,
  zIndex: 2,
};

type LoginErrors = {
  email?: string;
  password?: string;
  form?: string;
};

export default function LoginForm({
  signupEnabled,
  passwordResetEnabled = false,
  notice = null,
  googleEnabled = false,
  googleNotice = null,
}: {
  signupEnabled: boolean;
  passwordResetEnabled?: boolean;
  notice?: "reset-done" | null;
  googleEnabled?: boolean;
  googleNotice?: string | null;
}) {
  const router = useRouter();
  const { t } = useI18n();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [showPassword, setShowPassword] = useState(false);

  const [loading, setLoading] = useState(false);
  const [bootLoading, setBootLoading] = useState(true);

  const [errors, setErrors] = useState<LoginErrors>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let isMounted = true;

    const boot = async () => {
      try {
        if (typeof window === "undefined") {
          return;
        }

        const token = window.localStorage.getItem("token");

        if (!token) {
          if (isMounted) setBootLoading(false);
          return;
        }

        // Token presence is not proof of an authenticated session. Validate it
        // before redirecting, otherwise a stale/expired token traps the user
        // away from the login form (it bounces to "/" → rewritten to /home).
        let status = 0;
        try {
          const res = await fetch("/api/auth/me", {
            headers: { authorization: `Bearer ${token}` },
          });
          status = res.status;
        } catch {
          status = 0;
        }

        if (status === 200) {
          window.location.replace(`${window.location.origin}/app`);
          return; // keep the boot loader visible while navigating away
        }

        // Definitively unauthorized → clear the stale credentials.
        if (status === 401 || status === 403) {
          window.localStorage.removeItem("token");
          window.localStorage.removeItem("sessionId");
          window.localStorage.removeItem("user");
        }

        // Any non-200 (incl. transient network/5xx): show the form so the user
        // is never trapped away from logging in.
        if (isMounted) setBootLoading(false);
      } catch (error) {
        console.error("login boot error:", error);
        if (isMounted) setBootLoading(false);
      }
    };

    void boot();

    return () => {
      isMounted = false;
    };
  }, [router]);

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function validateField(field: "email" | "password", value: string) {
    if (field === "email") {
      if (!value.trim()) return t("account.auth.login.errors.emailRequired");
      if (!emailRegex.test(value.trim())) return t("account.auth.login.errors.emailInvalid");
      return "";
    }

    if (field === "password") {
      // Required, nothing more: the server decides whether a password is right, and an
      // account created under an older rule must never be refused here before it is asked.
      if (!value) return t("account.auth.login.errors.passwordRequired");
      return "";
    }

    return "";
  }

  function validateForm() {
    const nextErrors: LoginErrors = {};

    const emailError = validateField("email", email);
    const passwordError = validateField("password", password);

    if (emailError) nextErrors.email = emailError;
    if (passwordError) nextErrors.password = passwordError;

    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  }

  function handleBlur(field: "email" | "password") {
    setTouched((prev) => ({ ...prev, [field]: true }));

    const value = field === "email" ? email : password;
    const fieldError = validateField(field, value);

    setErrors((prev) => ({
      ...prev,
      [field]: fieldError || undefined,
    }));
  }

  // The server's word on failed attempts: a warning before the lock, and the lock's end time. The
  // count lives on the server (a refresh changes nothing); this only shows it.
  const [warning, setWarning] = useState<string | null>(null);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (lockedUntil === null) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setNowMs(now);
      if (now >= lockedUntil) {
        setLockedUntil(null);
        setErrors((prev) => ({ ...prev, form: undefined }));
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [lockedUntil]);

  const lockLeftMs = lockedUntil === null ? 0 : Math.max(0, lockedUntil - nowMs);
  const lockLeftLabel = `${Math.floor(lockLeftMs / 60_000)}:${String(Math.floor((lockLeftMs % 60_000) / 1000)).padStart(2, "0")}`;

  const isSubmitDisabled = useMemo(() => {
    return loading || lockedUntil !== null || !email.trim() || !password.trim();
  }, [loading, lockedUntil, email, password]);

  const handleLogin = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    setTouched({
      email: true,
      password: true,
    });

    if (!validateForm()) {
      return;
    }

    try {
      setLoading(true);
      setErrors((prev) => ({
        ...prev,
        form: undefined,
      }));

      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: email.trim(),
          password,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        if (data?.code === "LOGIN_LOCKED" && typeof data?.retryAfterSeconds === "number") {
          const until = Date.now() + data.retryAfterSeconds * 1000;
          setNowMs(Date.now());
          setLockedUntil(until);
          setWarning(null);
        } else {
          setWarning(typeof data?.warning === "string" ? data.warning : null);
        }
        throw new Error(data?.error || t("account.auth.login.errors.loginFailed"));
      }
      setWarning(null);

      if (!data?.token) {
        throw new Error(t("account.auth.login.errors.noToken"));
      }

      window.localStorage.setItem("token", data.token);

      if (data.sessionId) {
        window.localStorage.setItem("sessionId", data.sessionId);
      }

      if (data.user) {
        window.localStorage.setItem("user", JSON.stringify(data.user));
      } else {
        window.localStorage.removeItem("user");
      }

      /* Full navigation: guarantees home reads the same tab’s localStorage (mobile-safe vs client router transition). */
      window.location.replace(`${window.location.origin}/app`);
    } catch (err) {
      console.error("login error:", err);
      setErrors({
        form: err instanceof Error ? err.message : t("account.auth.login.errors.loginFailed"),
      });
    } finally {
      setLoading(false);
    }
  };

  const pageStyle: React.CSSProperties = {
    minHeight: "100vh",
    background:
      "radial-gradient(circle at top right, rgba(30, 106, 74,0.10), transparent 28%), linear-gradient(135deg, var(--dz-surface-muted) 0%, var(--dz-brand-soft) 45%, var(--dz-surface-flat) 100%)",
    padding: "24px 16px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  };

  const cardStyle: React.CSSProperties = {
    width: "100%",
    maxWidth: 480,
    background: "rgba(255,255,255,0.96)",
    border: "1px solid var(--dz-border)",
    borderRadius: 28,
    boxShadow: "0 20px 60px rgba(52, 60, 50, 0.12)",
    overflow: "hidden",
    backdropFilter: "blur(8px)",
  };

  const headerStyle: React.CSSProperties = {
    padding: "32px 28px 20px",
    background:
      "linear-gradient(135deg, var(--dz-surface-flat) 0%, var(--dz-surface-muted) 55%, var(--dz-success-bg-soft) 100%)",
    borderBottom: "1px solid var(--dz-border)",
  };

  const badgeStyle: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 12px",
    borderRadius: 999,
    background: "var(--dz-success-bg-soft)",
    border: "1px solid var(--dz-success-border)",
    color: "var(--dz-success)",
    fontWeight: 700,
    fontSize: 13,
    marginBottom: 18,
  };

  const titleStyle: React.CSSProperties = {
    margin: "0 0 10px 0",
    fontSize: 32,
    lineHeight: 1.1,
    color: "var(--dz-text-primary)",
    letterSpacing: "-0.02em",
  };

  const subtitleStyle: React.CSSProperties = {
    margin: 0,
    color: "var(--dz-text-secondary)",
    lineHeight: 1.7,
    fontSize: 15,
  };

  const bodyStyle: React.CSSProperties = {
    padding: 28,
  };

  const fieldWrapStyle: React.CSSProperties = {
    marginBottom: 18,
  };

  const labelStyle: React.CSSProperties = {
    display: "block",
    marginBottom: 8,
    fontWeight: 700,
    color: "var(--dz-text-primary)",
    fontSize: 14,
  };

  const inputShellStyle: React.CSSProperties = {
    position: "relative",
    width: "100%",
  };

  const baseInputStyle: React.CSSProperties = {
    width: "100%",
    padding: "14px 16px",
    border: "1px solid var(--dz-border-strong)",
    borderRadius: 14,
    outline: "none",
    fontSize: 16,
    lineHeight: 1.4,
    background: "var(--dz-surface)",
    color: "var(--dz-text-primary)",
    caretColor: "var(--dz-text-primary)",
    boxSizing: "border-box",
    fontFamily: "inherit",
    WebkitAppearance: "none",
    appearance: "none",
    boxShadow: "0 1px 2px rgba(52, 60, 50, 0.04)",
  };

  const passwordInputStyle: React.CSSProperties = {
    ...baseInputStyle,
    paddingInlineEnd: 84,
  };

  const passwordToggleStyle: React.CSSProperties = {
    position: "absolute",
    insetInlineEnd: 10,
    top: "50%",
    transform: "translateY(-50%)",
    border: "none",
    background: "transparent",
    color: "var(--dz-text-secondary)",
    fontWeight: 700,
    fontSize: 13,
    cursor: "pointer",
    padding: "6px 8px",
    borderRadius: 10,
  };

  const helperTextStyle: React.CSSProperties = {
    marginTop: 8,
    marginBottom: 0,
    color: "var(--dz-text-muted)",
    fontSize: 13,
    lineHeight: 1.5,
  };

  const fieldErrorStyle: React.CSSProperties = {
    marginTop: 8,
    marginBottom: 0,
    color: "var(--dz-danger)",
    fontSize: 13,
    lineHeight: 1.5,
    fontWeight: 600,
  };

  const formErrorStyle: React.CSSProperties = {
    marginBottom: 16,
    padding: 12,
    borderRadius: 14,
    background: "var(--dz-danger-bg-soft)",
    border: "1px solid var(--dz-danger-border)",
    color: "var(--dz-danger)",
    fontSize: 14,
    lineHeight: 1.6,
  };

  const dividerStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 12,
    marginTop: 22,
    marginBottom: 18,
    color: "var(--dz-text-muted)",
    fontSize: 13,
  };

  const lineStyle: React.CSSProperties = {
    flex: 1,
    height: 1,
    background: "var(--dz-surface-muted)",
  };

  const warningStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
    borderRadius: 14,
    padding: "12px 14px",
    background: "var(--dz-warning-bg)",
    border: "1px solid var(--dz-warning-accent)",
    color: "var(--dz-warning)",
    fontSize: 14,
    fontWeight: 700,
    lineHeight: 1.6,
    marginBottom: 14,
  };

  const lockStyle: React.CSSProperties = {
    borderRadius: 14,
    padding: "12px 14px",
    background: "var(--dz-danger-bg-soft)",
    border: "1px solid var(--dz-danger-border)",
    color: "var(--dz-text-primary)",
    fontSize: 14,
    lineHeight: 1.7,
    marginBottom: 14,
  };

  const noticeStyle: React.CSSProperties = {
    borderRadius: 14,
    padding: "12px 14px",
    background: "var(--dz-success-bg-soft)",
    border: "1px solid var(--dz-success-border)",
    color: "var(--dz-text-primary)",
    fontSize: 14,
    lineHeight: 1.6,
    marginBottom: 14,
  };

  const footerTextStyle: React.CSSProperties = {
    marginTop: 0,
    marginBottom: 0,
    color: "var(--dz-text-muted)",
    textAlign: "center",
    lineHeight: 1.8,
    fontSize: 14,
  };

  const linkButtonStyle: React.CSSProperties = {
    border: "none",
    background: "transparent",
    color: "var(--dz-text-primary)",
    cursor: "pointer",
    fontWeight: 800,
    textDecoration: "underline",
    fontSize: 14,
    padding: 0,
    fontFamily: "inherit",
  };

  // Boot check (validating an existing session before redirecting to /app).
  // Render a plain cream ground — no card, no "טוען..." — while a logged-in
  // entry is validated and sent on to /app.
  if (bootLoading) {
    return (
      <div
        aria-hidden="true"
        style={{
          minHeight: "100dvh",
          background:
            "radial-gradient(circle at 50% 38%, var(--dz-surface-flat) 0%, var(--dz-surface-muted) 58%, var(--dz-surface-muted) 100%)",
        }}
      />
    );
  }

  return (
    <div style={pageStyle}>
      {/* The accessibility entry has a fixed place here, so the floating button stands down. */}
      <AccessibilityTrigger label={t("account.auth.login.a11ySettings")} style={LOGIN_A11Y_STYLE} />
      <div style={cardStyle}>
        <div style={headerStyle}>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 4 }}>
            <DubizLogo height={38} priority />
          </div>

          <div style={badgeStyle}>
            <span>🔐</span>
            <span>{t("account.auth.login.badge")}</span>
          </div>

          <h1 style={titleStyle}>{t("account.auth.login.title")}</h1>

          <p style={subtitleStyle}>{t("account.auth.login.subtitle")}</p>
        </div>

        <form style={bodyStyle} onSubmit={handleLogin} noValidate>
          <GoogleNotice notice={googleNotice} />
          <GoogleSignInButton enabled={googleEnabled} from="login" />

          <div style={fieldWrapStyle}>
            <label style={labelStyle} htmlFor="login-email">{t("account.auth.login.emailLabel")}</label>
            <div style={inputShellStyle}>
              <input
                type="email"
                id="login-email"
                aria-invalid={touched.email && !!errors.email}
                aria-describedby="login-email-msg"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (touched.email) {
                    setErrors((prev) => ({
                      ...prev,
                      email: validateField("email", e.target.value) || undefined,
                    }));
                  }
                }}
                onBlur={() => handleBlur("email")}
                style={{
                  ...baseInputStyle,
                  borderColor:
                    touched.email && errors.email ? "var(--dz-danger-border)" : "var(--dz-border-strong)",
                  boxShadow:
                    touched.email && errors.email
                      ? "0 0 0 3px rgba(155, 70, 52,0.10)"
                      : "0 1px 2px rgba(52, 60, 50, 0.04)",
                }}
                placeholder="name@example.com"
                autoComplete="email"
                spellCheck={false}
                autoFocus
              />
            </div>

            {touched.email && errors.email ? (
              <p id="login-email-msg" role="alert" style={fieldErrorStyle}>{errors.email}</p>
            ) : (
              <p id="login-email-msg" style={helperTextStyle}>
                {t("account.auth.login.emailHelp")}
              </p>
            )}
          </div>

          <div style={fieldWrapStyle}>
            <label style={labelStyle} htmlFor="login-password">{t("account.auth.login.passwordLabel")}</label>
            <div style={inputShellStyle}>
              <input
                type={showPassword ? "text" : "password"}
                id="login-password"
                aria-invalid={touched.password && !!errors.password}
                aria-describedby="login-password-msg"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (touched.password) {
                    setErrors((prev) => ({
                      ...prev,
                      password:
                        validateField("password", e.target.value) || undefined,
                    }));
                  }
                }}
                onBlur={() => handleBlur("password")}
                style={{
                  ...passwordInputStyle,
                  borderColor:
                    touched.password && errors.password ? "var(--dz-danger-border)" : "var(--dz-border-strong)",
                  boxShadow:
                    touched.password && errors.password
                      ? "0 0 0 3px rgba(155, 70, 52,0.10)"
                      : "0 1px 2px rgba(52, 60, 50, 0.04)",
                }}
                placeholder={t("account.auth.login.passwordPlaceholder")}
                autoComplete="current-password"
                spellCheck={false}
              />
              <button
                type="button"
                onClick={() => setShowPassword((prev) => !prev)}
                style={passwordToggleStyle}
                aria-label={showPassword ? t("account.auth.login.hidePasswordAria") : t("account.auth.login.showPasswordAria")}
                aria-pressed={showPassword}
                aria-controls="login-password"
              >
                {showPassword ? t("account.auth.login.hidePassword") : t("account.auth.login.showPassword")}
              </button>
            </div>

            {touched.password && errors.password ? (
              <p id="login-password-msg" role="alert" style={fieldErrorStyle}>{errors.password}</p>
            ) : (
              <p id="login-password-msg" style={helperTextStyle}>{t("account.auth.login.passwordHelp")}</p>
            )}
            {passwordResetEnabled ? (
              <p style={{ ...helperTextStyle, marginTop: 6 }}>
                <a href="/forgot-password" style={{ ...linkButtonStyle, fontSize: "inherit" }} data-testid="forgot-password-link">
                  {t("account.auth.login.forgotPassword")}
                </a>
              </p>
            ) : null}
          </div>

          {notice === "reset-done" && !errors.form ? (
            <div role="status" aria-live="polite" style={noticeStyle} data-testid="reset-done-notice">
              {t("account.auth.login.resetDoneNotice")}
            </div>
          ) : null}

          {lockedUntil !== null ? (
            <div role="alert" aria-live="assertive" style={lockStyle} data-testid="login-locked">
              <strong style={{ display: "block", marginBottom: 4 }}>{t("account.auth.login.lockedTitle")}</strong>
              {/* The server's sentence carries a fixed number of minutes; the live countdown below replaces it. */}
              {t("account.auth.login.lockedBody")}
              <span style={{ display: "block", marginTop: 8, fontWeight: 700 }} aria-live="off">
                {t("account.auth.login.lockedRetryIn")}{" "}<span dir="ltr" data-testid="login-lock-countdown">{lockLeftLabel}</span>
              </span>
            </div>
          ) : errors.form ? (
            <div role="alert" aria-live="assertive" style={formErrorStyle}>{errors.form}</div>
          ) : null}

          {warning && lockedUntil === null ? (
            <div role="alert" style={warningStyle} data-testid="login-warning">
              <span aria-hidden="true" style={{ fontSize: 18, lineHeight: 1 }}>⚠️</span>
              <span>{warning}</span>
            </div>
          ) : null}

          <PrimaryCta type="submit" block disabled={isSubmitDisabled}>
            {loading ? t("account.auth.login.submitting") : t("account.auth.login.submit")}
          </PrimaryCta>

          <div style={dividerStyle}>
            <div style={lineStyle} />
            <span>{t("account.auth.login.divider")}</span>
            <div style={lineStyle} />
          </div>

          {signupEnabled ? (
            <p style={footerTextStyle}>
              {t("account.auth.login.noAccount")}{" "}
              <button
                type="button"
                style={linkButtonStyle}
                onClick={() => router.push("/register")}
              >
                {t("account.auth.login.toRegister")}
              </button>
            </p>
          ) : (
            <p style={footerTextStyle}>
              {t("account.auth.login.signupClosed")}
            </p>
          )}
        </form>
      </div>
    </div>
  );
}