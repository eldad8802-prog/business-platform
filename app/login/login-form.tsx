"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { DubizLogo } from "@/components/ui/dubiz-logo";
import { PrimaryCta } from "@/components/ui/primary-cta";

type LoginErrors = {
  email?: string;
  password?: string;
  form?: string;
};

export default function LoginForm({ signupEnabled }: { signupEnabled: boolean }) {
  const router = useRouter();

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
      if (!value.trim()) return "יש להזין אימייל";
      if (!emailRegex.test(value.trim())) return "יש להזין כתובת אימייל תקינה";
      return "";
    }

    if (field === "password") {
      if (!value.trim()) return "יש להזין סיסמה";
      if (value.length < 6) return "הסיסמה חייבת להכיל לפחות 6 תווים";
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

  const isSubmitDisabled = useMemo(() => {
    return loading || !email.trim() || !password.trim();
  }, [loading, email, password]);

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
        throw new Error(data?.error || "שגיאה בהתחברות");
      }

      if (!data?.token) {
        throw new Error("לא התקבל token מהשרת");
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
        form: err instanceof Error ? err.message : "שגיאה בהתחברות",
      });
    } finally {
      setLoading(false);
    }
  };

  const pageStyle: React.CSSProperties = {
    minHeight: "100vh",
    background:
      "radial-gradient(circle at top right, rgba(30, 106, 74,0.10), transparent 28%), linear-gradient(135deg, var(--dz-surface-muted) 0%, var(--dz-brand-soft) 45%, var(--dz-surface-flat) 100%)",
    direction: "rtl",
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
    paddingLeft: 84,
  };

  const passwordToggleStyle: React.CSSProperties = {
    position: "absolute",
    left: 10,
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
  // Render the brand intro's cream ground — no card, no "טוען..." — so a
  // logged-in entry is cream from the first paint and flows seamlessly into the
  // /app bear intro with no separate loading screen.
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
      <div style={cardStyle}>
        <div style={headerStyle}>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 4 }}>
            <DubizLogo height={38} priority />
          </div>

          <div style={badgeStyle}>
            <span>🔐</span>
            <span>כניסה מאובטחת למערכת</span>
          </div>

          <h1 style={titleStyle}>ברוך הבא</h1>

          <p style={subtitleStyle}>
            התחבר כדי להמשיך לניהול העסק שלך, לצפות בשיחות, לבדוק תמחור,
            ולעבוד מתוך מערכת אחת חכמה, מסודרת ומקצועית.
          </p>
        </div>

        <form style={bodyStyle} onSubmit={handleLogin} noValidate>
          <div style={fieldWrapStyle}>
            <label style={labelStyle} htmlFor="login-email">אימייל</label>
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
                השתמש באימייל שאיתו נרשמת למערכת.
              </p>
            )}
          </div>

          <div style={fieldWrapStyle}>
            <label style={labelStyle} htmlFor="login-password">סיסמה</label>
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
                placeholder="הכנס סיסמה"
                autoComplete="current-password"
                spellCheck={false}
              />
              <button
                type="button"
                onClick={() => setShowPassword((prev) => !prev)}
                style={passwordToggleStyle}
                aria-label={showPassword ? "הסתר סיסמה" : "הצג סיסמה"}
                aria-pressed={showPassword}
                aria-controls="login-password"
              >
                {showPassword ? "הסתר" : "הצג"}
              </button>
            </div>

            {touched.password && errors.password ? (
              <p id="login-password-msg" role="alert" style={fieldErrorStyle}>{errors.password}</p>
            ) : (
              <p id="login-password-msg" style={helperTextStyle}>הסיסמה חייבת להכיל לפחות 6 תווים.</p>
            )}
          </div>

          {errors.form && (
            <div role="alert" aria-live="assertive" style={formErrorStyle}>{errors.form}</div>
          )}

          <PrimaryCta type="submit" block disabled={isSubmitDisabled}>
            {loading ? "מתחבר..." : "התחבר למערכת"}
          </PrimaryCta>

          <div style={dividerStyle}>
            <div style={lineStyle} />
            <span>כניסה מהירה ונקייה</span>
            <div style={lineStyle} />
          </div>

          {signupEnabled ? (
            <p style={footerTextStyle}>
              אין לך חשבון?{" "}
              <button
                type="button"
                style={linkButtonStyle}
                onClick={() => router.push("/register")}
              >
                להרשמה
              </button>
            </p>
          ) : (
            <p style={footerTextStyle}>
              ההרשמה למערכת סגורה כרגע. המסך הזה מיועד למשתמשים קיימים.
            </p>
          )}
        </form>
      </div>
    </div>
  );
}