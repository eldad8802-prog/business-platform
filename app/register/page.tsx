"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type RegisterErrors = {
  name?: string;
  businessName?: string;
  email?: string;
  password?: string;
  confirmPassword?: string;
  form?: string;
};

export default function RegisterPage() {
  const router = useRouter();

  const [name, setName] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  const [loading, setLoading] = useState(false);
  const [bootLoading, setBootLoading] = useState(true);
  const [errors, setErrors] = useState<RegisterErrors>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const token = localStorage.getItem("token");

    if (token) {
      router.replace("/");
      return;
    }

    setBootLoading(false);
  }, [router]);

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function getPasswordStrengthLabel(value: string) {
    if (!value) {
      return {
        text: "עדיין לא הוזנה סיסמה",
        color: "#6b7280",
        bg: "#f3f4f6",
        level: 0,
      };
    }

    let score = 0;

    if (value.length >= 6) score += 1;
    if (value.length >= 8) score += 1;
    if (/[A-Z]/.test(value) || /[א-ת]/.test(value)) score += 1;
    if (/[0-9]/.test(value)) score += 1;
    if (/[^A-Za-z0-9\u0590-\u05FF]/.test(value)) score += 1;

    if (score <= 2) {
      return {
        text: "סיסמה חלשה",
        color: "#b91c1c",
        bg: "#fee2e2",
        level: 1,
      };
    }

    if (score <= 4) {
      return {
        text: "סיסמה טובה",
        color: "#a16207",
        bg: "#fef3c7",
        level: 2,
      };
    }

    return {
      text: "סיסמה חזקה",
      color: "#166534",
      bg: "#dcfce7",
      level: 3,
    };
  }

  const passwordStrength = useMemo(
    () => getPasswordStrengthLabel(password),
    [password]
  );

  function validateField(
    field: "name" | "businessName" | "email" | "password" | "confirmPassword",
    value: string
  ) {
    if (field === "name") {
      if (!value.trim()) return "יש להזין שם מלא";
      if (value.trim().length < 2) return "השם חייב להכיל לפחות 2 תווים";
      return "";
    }

    if (field === "businessName") {
      if (!value.trim()) return "יש להזין שם עסק";
      if (value.trim().length < 2) return "שם העסק חייב להכיל לפחות 2 תווים";
      return "";
    }

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

    if (field === "confirmPassword") {
      if (!value.trim()) return "יש לאשר את הסיסמה";
      if (value !== password) return "הסיסמאות אינן תואמות";
      return "";
    }

    return "";
  }

  function validateForm() {
    const nextErrors: RegisterErrors = {};

    const nameError = validateField("name", name);
    const businessNameError = validateField("businessName", businessName);
    const emailError = validateField("email", email);
    const passwordError = validateField("password", password);
    const confirmPasswordError = validateField(
      "confirmPassword",
      confirmPassword
    );

    if (nameError) nextErrors.name = nameError;
    if (businessNameError) nextErrors.businessName = businessNameError;
    if (emailError) nextErrors.email = emailError;
    if (passwordError) nextErrors.password = passwordError;
    if (confirmPasswordError) nextErrors.confirmPassword = confirmPasswordError;

    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  }

  function handleBlur(
    field: "name" | "businessName" | "email" | "password" | "confirmPassword"
  ) {
    setTouched((prev) => ({ ...prev, [field]: true }));

    const valueMap = {
      name,
      businessName,
      email,
      password,
      confirmPassword,
    };

    const fieldError = validateField(field, valueMap[field]);

    setErrors((prev) => ({
      ...prev,
      [field]: fieldError || undefined,
    }));
  }

  const isSubmitDisabled = useMemo(() => {
    return (
      loading ||
      !name.trim() ||
      !businessName.trim() ||
      !email.trim() ||
      !password.trim() ||
      !confirmPassword.trim()
    );
  }, [loading, name, businessName, email, password, confirmPassword]);

  const handleRegister = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    setTouched({
      name: true,
      businessName: true,
      email: true,
      password: true,
      confirmPassword: true,
    });

    if (!validateForm()) {
      return;
    }

    try {
      setLoading(true);
      setErrors({});

      const registerRes = await fetch("/api/auth/register", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: name.trim(),
          businessName: businessName.trim(),
          email: email.trim(),
          password,
        }),
      });

      const registerData = await registerRes.json();

      if (!registerRes.ok) {
        throw new Error(registerData?.error || "שגיאה בהרשמה");
      }

      const loginRes = await fetch("/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: email.trim(),
          password,
        }),
      });

      const loginData = await loginRes.json();

      if (!loginRes.ok) {
        throw new Error(loginData?.error || "שגיאה בהתחברות");
      }

      if (!loginData?.token) {
        throw new Error("לא התקבל token מהשרת");
      }

      localStorage.setItem("token", loginData.token);

      if (loginData.user) {
        localStorage.setItem("user", JSON.stringify(loginData.user));
      }

      router.replace("/");
    } catch (err) {
      console.error("register error:", err);
      setErrors({
        form: err instanceof Error ? err.message : "שגיאה בהרשמה",
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
    maxWidth: 540,
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

  const strengthBoxStyle: React.CSSProperties = {
    marginTop: 10,
    marginBottom: 0,
    padding: "10px 12px",
    borderRadius: 12,
    fontSize: 13,
    fontWeight: 700,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    background: passwordStrength.bg,
    color: passwordStrength.color,
  };

  const strengthBarsWrapStyle: React.CSSProperties = {
    display: "flex",
    gap: 4,
    minWidth: 72,
  };

  const getStrengthBarStyle = (index: number): React.CSSProperties => ({
    flex: 1,
    height: 6,
    borderRadius: 999,
    background:
      passwordStrength.level >= index
        ? passwordStrength.color
        : "rgba(107,114,128,0.20)",
  });

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
            <span>✨</span>
            <span>פתיחת חשבון חדש</span>
          </div>

          <h1 style={titleStyle}>הרשמה למערכת</h1>

          <p style={subtitleStyle}>
            צור חשבון חדש והתחל לעבוד עם מערכת אחת שמרכזת ניהול, שיחות ותמחור
            בצורה חכמה, מסודרת ונוחה.
          </p>
        </div>

        <form style={bodyStyle} onSubmit={handleRegister} noValidate>
          <div style={fieldWrapStyle}>
            <label style={labelStyle}>שם מלא</label>
            <div style={inputShellStyle}>
              <input
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (touched.name) {
                    setErrors((prev) => ({
                      ...prev,
                      name: validateField("name", e.target.value) || undefined,
                    }));
                  }
                }}
                onBlur={() => handleBlur("name")}
                style={{
                  ...baseInputStyle,
                  borderColor:
                    touched.name && errors.name ? "#fca5a5" : "#d1d5db",
                  boxShadow:
                    touched.name && errors.name
                      ? "0 0 0 3px rgba(239,68,68,0.10)"
                      : "0 1px 2px rgba(15, 23, 42, 0.04)",
                }}
                placeholder="הכנס שם מלא"
                autoFocus
              />
            </div>

            {touched.name && errors.name ? (
              <p style={fieldErrorStyle}>{errors.name}</p>
            ) : (
              <p style={helperTextStyle}>השם שלך כפי שתרצה שיופיע במערכת.</p>
            )}
          </div>

          <div style={fieldWrapStyle}>
            <label style={labelStyle}>שם העסק</label>
            <div style={inputShellStyle}>
              <input
                value={businessName}
                onChange={(e) => {
                  setBusinessName(e.target.value);
                  if (touched.businessName) {
                    setErrors((prev) => ({
                      ...prev,
                      businessName:
                        validateField("businessName", e.target.value) ||
                        undefined,
                    }));
                  }
                }}
                onBlur={() => handleBlur("businessName")}
                style={{
                  ...baseInputStyle,
                  borderColor:
                    touched.businessName && errors.businessName
                      ? "#fca5a5"
                      : "#d1d5db",
                  boxShadow:
                    touched.businessName && errors.businessName
                      ? "0 0 0 3px rgba(239,68,68,0.10)"
                      : "0 1px 2px rgba(15, 23, 42, 0.04)",
                }}
                placeholder="הכנס את שם העסק"
              />
            </div>

            {touched.businessName && errors.businessName ? (
              <p style={fieldErrorStyle}>{errors.businessName}</p>
            ) : (
              <p style={helperTextStyle}>
                זהו השם הראשוני של העסק שלך במערכת. בהמשך תוכל לעדכן פרטים נוספים.
              </p>
            )}
          </div>

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
              />
            </div>

            {touched.email && errors.email ? (
              <p style={fieldErrorStyle}>{errors.email}</p>
            ) : (
              <p style={helperTextStyle}>
                השתמש באימייל פעיל שיהיה שייך לחשבון שלך.
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

                  if (touched.confirmPassword) {
                    setErrors((prev) => ({
                      ...prev,
                      confirmPassword:
                        validateField("confirmPassword", confirmPassword) ||
                        undefined,
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
                autoComplete="new-password"
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

            <div style={strengthBoxStyle}>
              <span>{passwordStrength.text}</span>
              <div style={strengthBarsWrapStyle}>
                <div style={getStrengthBarStyle(1)} />
                <div style={getStrengthBarStyle(2)} />
                <div style={getStrengthBarStyle(3)} />
              </div>
            </div>

            {touched.password && errors.password ? (
              <p style={fieldErrorStyle}>{errors.password}</p>
            ) : (
              <p style={helperTextStyle}>
                מומלץ להשתמש בשילוב של אותיות, מספרים ותווים מיוחדים.
              </p>
            )}
          </div>

          <div style={fieldWrapStyle}>
            <label style={labelStyle}>אימות סיסמה</label>
            <div style={inputShellStyle}>
              <input
                type={showConfirmPassword ? "text" : "password"}
                value={confirmPassword}
                onChange={(e) => {
                  setConfirmPassword(e.target.value);
                  if (touched.confirmPassword) {
                    setErrors((prev) => ({
                      ...prev,
                      confirmPassword:
                        validateField("confirmPassword", e.target.value) ||
                        undefined,
                    }));
                  }
                }}
                onBlur={() => handleBlur("confirmPassword")}
                style={{
                  ...passwordInputStyle,
                  borderColor:
                    touched.confirmPassword && errors.confirmPassword
                      ? "#fca5a5"
                      : "#d1d5db",
                  boxShadow:
                    touched.confirmPassword && errors.confirmPassword
                      ? "0 0 0 3px rgba(239,68,68,0.10)"
                      : "0 1px 2px rgba(15, 23, 42, 0.04)",
                }}
                placeholder="הכנס שוב את הסיסמה"
                autoComplete="new-password"
                spellCheck={false}
              />
              <button
                type="button"
                onClick={() => setShowConfirmPassword((prev) => !prev)}
                style={passwordToggleStyle}
              >
                {showConfirmPassword ? "הסתר" : "הצג"}
              </button>
            </div>

            {touched.confirmPassword && errors.confirmPassword ? (
              <p style={fieldErrorStyle}>{errors.confirmPassword}</p>
            ) : (
              <p style={helperTextStyle}>
                כדי לוודא שלא נפלה טעות בהקלדה, הזן שוב את הסיסמה.
              </p>
            )}
          </div>

          {errors.form && <div style={formErrorStyle}>{errors.form}</div>}

          <button
            type="submit"
            disabled={isSubmitDisabled}
            style={primaryButtonStyle}
          >
            {loading ? "יוצר חשבון..." : "צור חשבון"}
          </button>

          <div style={dividerStyle}>
            <div style={lineStyle} />
            <span>תחילת עבודה מהירה</span>
            <div style={lineStyle} />
          </div>

          <p style={footerTextStyle}>
            כבר יש לך חשבון?{" "}
            <button
              type="button"
              style={linkButtonStyle}
              onClick={() => router.push("/login")}
            >
              להתחברות
            </button>
          </p>
        </form>
      </div>
    </div>
  );
}