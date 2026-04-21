"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type LoginErrors = {
  email?: string;
  password?: string;
  form?: string;
};

export default function LoginPage() {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [showPassword, setShowPassword] = useState(false);

  const [loading, setLoading] = useState(false);
  const [bootLoading, setBootLoading] = useState(true);

  const [errors, setErrors] = useState<LoginErrors>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  useEffect(() => {
    console.log("🔥 LOGIN RENDER");
    let isMounted = true;

    const boot = () => {
      try {
        if (typeof window === "undefined") {
          return;
        }

        const token = window.localStorage.getItem("token");

        if (token) {
          router.replace("/");
          return;
        }
      } catch (error) {
        console.error("login boot error:", error);
      } finally {
        if (isMounted) {
          setBootLoading(false);
        }
      }
    };

    boot();

    return () => {
      isMounted = false;
    };
  }, [router]);

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  console.log("🔥 LOGIN RENDER");

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

      if (data.user) {
        window.localStorage.setItem("user", JSON.stringify(data.user));
      } else {
        window.localStorage.removeItem("user");
      }

      router.replace("/");
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
      "radial-gradient(circle at top right, rgba(34,197,94,0.10), transparent 28%), linear-gradient(135deg, #f8fafc 0%, #eef2ff 45%, #ffffff 100%)",
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
    border: "1px solid #e5e7eb",
    borderRadius: 28,
    boxShadow: "0 20px 60px rgba(15, 23, 42, 0.12)",
    overflow: "hidden",
    backdropFilter: "blur(8px)",
  };

  const headerStyle: React.CSSProperties = {
    padding: "32px 28px 20px",
    background:
      "linear-gradient(135deg, #ffffff 0%, #f8fafc 55%, #ecfdf5 100%)",
    borderBottom: "1px solid #eef2f7",
  };

  const badgeStyle: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 12px",
    borderRadius: 999,
    background: "#f0fdf4",
    border: "1px solid #bbf7d0",
    color: "#166534",
    fontWeight: 700,
    fontSize: 13,
    marginBottom: 18,
  };

  const titleStyle: React.CSSProperties = {
    margin: "0 0 10px 0",
    fontSize: 32,
    lineHeight: 1.1,
    color: "#111827",
    letterSpacing: "-0.02em",
  };

  const subtitleStyle: React.CSSProperties = {
    margin: 0,
    color: "#4b5563",
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
    color: "#111827",
    fontSize: 14,
  };

  const inputShellStyle: React.CSSProperties = {
    position: "relative",
    width: "100%",
  };

  const baseInputStyle: React.CSSProperties = {
    width: "100%",
    padding: "14px 16px",
    border: "1px solid #d1d5db",
    borderRadius: 14,
    outline: "none",
    fontSize: 16,
    lineHeight: 1.4,
    background: "#ffffff",
    color: "#111827",
    caretColor: "#111827",
    boxSizing: "border-box",
    fontFamily: "inherit",
    WebkitAppearance: "none",
    appearance: "none",
    boxShadow: "0 1px 2px rgba(15, 23, 42, 0.04)",
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
    color: "#374151",
    fontWeight: 700,
    fontSize: 13,
    cursor: "pointer",
    padding: "6px 8px",
    borderRadius: 10,
  };

  const helperTextStyle: React.CSSProperties = {
    marginTop: 8,
    marginBottom: 0,
    color: "#6b7280",
    fontSize: 13,
    lineHeight: 1.5,
  };

  const fieldErrorStyle: React.CSSProperties = {
    marginTop: 8,
    marginBottom: 0,
    color: "#b91c1c",
    fontSize: 13,
    lineHeight: 1.5,
    fontWeight: 600,
  };

  const primaryButtonStyle: React.CSSProperties = {
    width: "100%",
    padding: "14px 16px",
    borderRadius: 14,
    border: "1px solid #111827",
    background: loading
      ? "linear-gradient(135deg, #374151 0%, #1f2937 100%)"
      : "linear-gradient(135deg, #111827 0%, #1f2937 100%)",
    color: "#ffffff",
    cursor: loading ? "not-allowed" : "pointer",
    fontWeight: 800,
    fontSize: 15,
    boxShadow: "0 12px 30px rgba(17, 24, 39, 0.18)",
    opacity: isSubmitDisabled ? 0.85 : 1,
  };

  const formErrorStyle: React.CSSProperties = {
    marginBottom: 16,
    padding: 12,
    borderRadius: 14,
    background: "#fef2f2",
    border: "1px solid #fecaca",
    color: "#991b1b",
    fontSize: 14,
    lineHeight: 1.6,
  };

  const dividerStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 12,
    marginTop: 22,
    marginBottom: 18,
    color: "#9ca3af",
    fontSize: 13,
  };

  const lineStyle: React.CSSProperties = {
    flex: 1,
    height: 1,
    background: "#e5e7eb",
  };

  const footerTextStyle: React.CSSProperties = {
    marginTop: 0,
    marginBottom: 0,
    color: "#6b7280",
    textAlign: "center",
    lineHeight: 1.8,
    fontSize: 14,
  };

  const linkButtonStyle: React.CSSProperties = {
    border: "none",
    background: "transparent",
    color: "#111827",
    cursor: "pointer",
    fontWeight: 800,
    textDecoration: "underline",
    fontSize: 14,
    padding: 0,
    fontFamily: "inherit",
  };

  if (bootLoading) {
    return (
      <div style={pageStyle}>
        <div style={cardStyle}>
          <div style={{ padding: 28, textAlign: "center", color: "#111827" }}>
            טוען...
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={pageStyle}>
      <div style={cardStyle}>
        <div style={headerStyle}>
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
            <label style={labelStyle}>אימייל</label>
            <div style={inputShellStyle}>
              <input
                type="email"
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
                    touched.email && errors.email ? "#fca5a5" : "#d1d5db",
                  boxShadow:
                    touched.email && errors.email
                      ? "0 0 0 3px rgba(239,68,68,0.10)"
                      : "0 1px 2px rgba(15, 23, 42, 0.04)",
                }}
                placeholder="name@example.com"
                autoComplete="email"
                spellCheck={false}
                autoFocus
              />
            </div>

            {touched.email && errors.email ? (
              <p style={fieldErrorStyle}>{errors.email}</p>
            ) : (
              <p style={helperTextStyle}>
                השתמש באימייל שאיתו נרשמת למערכת.
              </p>
            )}
          </div>

          <div style={fieldWrapStyle}>
            <label style={labelStyle}>סיסמה</label>
            <div style={inputShellStyle}>
              <input
                type={showPassword ? "text" : "password"}
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
                    touched.password && errors.password ? "#fca5a5" : "#d1d5db",
                  boxShadow:
                    touched.password && errors.password
                      ? "0 0 0 3px rgba(239,68,68,0.10)"
                      : "0 1px 2px rgba(15, 23, 42, 0.04)",
                }}
                placeholder="הכנס סיסמה"
                autoComplete="current-password"
                spellCheck={false}
              />
              <button
                type="button"
                onClick={() => setShowPassword((prev) => !prev)}
                style={passwordToggleStyle}
              >
                {showPassword ? "הסתר" : "הצג"}
              </button>
            </div>

            {touched.password && errors.password ? (
              <p style={fieldErrorStyle}>{errors.password}</p>
            ) : (
              <p style={helperTextStyle}>הסיסמה חייבת להכיל לפחות 6 תווים.</p>
            )}
          </div>

          {errors.form && <div style={formErrorStyle}>{errors.form}</div>}

          <button
            type="submit"
            disabled={isSubmitDisabled}
            style={primaryButtonStyle}
          >
            {loading ? "מתחבר..." : "התחבר למערכת"}
          </button>

          <div style={dividerStyle}>
            <div style={lineStyle} />
            <span>כניסה מהירה ונקייה</span>
            <div style={lineStyle} />
          </div>

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
        </form>
      </div>
    </div>
  );
}