"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { PrimaryCta } from "@/components/ui/primary-cta";

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
      router.replace("/app");
      return;
    }

    setBootLoading(false);
  }, [router]);

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function getPasswordStrengthLabel(value: string) {
    if (!value) {
      return {
        text: "עדיין לא הוזנה סיסמה",
        color: "var(--dz-text-muted)",
        bg: "var(--dz-surface-muted)",
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
        color: "var(--dz-danger)",
        bg: "var(--dz-danger-bg)",
        level: 1,
      };
    }

    if (score <= 4) {
      return {
        text: "סיסמה טובה",
        color: "var(--dz-warning)",
        bg: "var(--dz-warning-bg)",
        level: 2,
      };
    }

    return {
      text: "סיסמה חזקה",
      color: "var(--dz-success)",
      bg: "var(--dz-success-bg)",
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
        // A duplicate address is not a system error — it is a fact about this
        // one field, so it is shown on that field with a way forward, rather
        // than as a red banner the person can only re-read.
        if (registerData?.code === "EMAIL_ALREADY_REGISTERED") {
          setErrors({ email: registerData.error });
          setTouched((prev) => ({ ...prev, email: true }));
          return;
        }

        // The server names the offending field when it can; honour that so the
        // error lands where the correction has to be made.
        if (typeof registerData?.field === "string") {
          setErrors({ [registerData.field]: registerData.error });
          setTouched((prev) => ({ ...prev, [registerData.field]: true }));
          return;
        }

        throw new Error(registerData?.error || "שגיאה בהרשמה");
      }

      // Signup now returns the session itself. There is no second login call to
      // fail, so a created account can no longer strand its owner.
      if (!registerData?.token) {
        throw new Error("לא התקבל token מהשרת");
      }

      localStorage.setItem("token", registerData.token);

      if (registerData.user) {
        localStorage.setItem("user", JSON.stringify(registerData.user));
      }

      router.replace("/app");
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
      "radial-gradient(circle at top right, rgba(30, 106, 74,0.10), transparent 28%), linear-gradient(135deg, var(--dz-surface-muted) 0%, var(--dz-brand-soft) 45%, var(--dz-surface-flat) 100%)",
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
        : "rgba(102, 111, 101,0.20)",
  });


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

  if (bootLoading) {
    return (
      <div style={pageStyle}>
        <div style={cardStyle}>
          <div style={{ padding: 28, textAlign: "center", color: "var(--dz-text-primary)" }}>
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
            <label style={labelStyle} htmlFor="reg-name">שם מלא</label>
            <div style={inputShellStyle}>
              <input
                id="reg-name"
                aria-invalid={touched.name && !!errors.name}
                aria-describedby="reg-name-msg"
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
                    touched.name && errors.name ? "var(--dz-danger-border)" : "var(--dz-border-strong)",
                  boxShadow:
                    touched.name && errors.name
                      ? "0 0 0 3px rgba(155, 70, 52,0.10)"
                      : "0 1px 2px rgba(52, 60, 50, 0.04)",
                }}
                placeholder="הכנס שם מלא"
                autoFocus
              />
            </div>

            {touched.name && errors.name ? (
              <p id="reg-name-msg" role="alert" style={fieldErrorStyle}>{errors.name}</p>
            ) : (
              <p id="reg-name-msg" style={helperTextStyle}>השם שלך כפי שתרצה שיופיע במערכת.</p>
            )}
          </div>

          <div style={fieldWrapStyle}>
            <label style={labelStyle} htmlFor="reg-business">שם העסק</label>
            <div style={inputShellStyle}>
              <input
                id="reg-business"
                aria-invalid={touched.businessName && !!errors.businessName}
                aria-describedby="reg-business-msg"
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
                      ? "var(--dz-danger-border)"
                      : "var(--dz-border-strong)",
                  boxShadow:
                    touched.businessName && errors.businessName
                      ? "0 0 0 3px rgba(155, 70, 52,0.10)"
                      : "0 1px 2px rgba(52, 60, 50, 0.04)",
                }}
                placeholder="הכנס את שם העסק"
              />
            </div>

            {touched.businessName && errors.businessName ? (
              <p id="reg-business-msg" role="alert" style={fieldErrorStyle}>{errors.businessName}</p>
            ) : (
              <p id="reg-business-msg" style={helperTextStyle}>
                זהו השם הראשוני של העסק שלך במערכת. בהמשך תוכל לעדכן פרטים נוספים.
              </p>
            )}
          </div>

          <div style={fieldWrapStyle}>
            <label style={labelStyle} htmlFor="reg-email">אימייל</label>
            <div style={inputShellStyle}>
              <input
                type="email"
                id="reg-email"
                aria-invalid={touched.email && !!errors.email}
                aria-describedby="reg-email-msg"
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
              />
            </div>

            {touched.email && errors.email ? (
              <p id="reg-email-msg" role="alert" style={fieldErrorStyle}>{errors.email}</p>
            ) : (
              <p id="reg-email-msg" style={helperTextStyle}>
                השתמש באימייל פעיל שיהיה שייך לחשבון שלך.
              </p>
            )}
          </div>

          <div style={fieldWrapStyle}>
            <label style={labelStyle} htmlFor="reg-password">סיסמה</label>
            <div style={inputShellStyle}>
              <input
                type={showPassword ? "text" : "password"}
                id="reg-password"
                aria-invalid={touched.password && !!errors.password}
                aria-describedby="reg-password-msg"
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
                    touched.password && errors.password ? "var(--dz-danger-border)" : "var(--dz-border-strong)",
                  boxShadow:
                    touched.password && errors.password
                      ? "0 0 0 3px rgba(155, 70, 52,0.10)"
                      : "0 1px 2px rgba(52, 60, 50, 0.04)",
                }}
                placeholder="הכנס סיסמה"
                autoComplete="new-password"
                spellCheck={false}
              />
              <button
                type="button"
                onClick={() => setShowPassword((prev) => !prev)}
                style={passwordToggleStyle}
                aria-label={showPassword ? "הסתר סיסמה" : "הצג סיסמה"}
                aria-pressed={showPassword}
                aria-controls="reg-password"
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
              <p id="reg-password-msg" role="alert" style={fieldErrorStyle}>{errors.password}</p>
            ) : (
              <p id="reg-password-msg" style={helperTextStyle}>
                מומלץ להשתמש בשילוב של אותיות, מספרים ותווים מיוחדים.
              </p>
            )}
          </div>

          <div style={fieldWrapStyle}>
            <label style={labelStyle} htmlFor="reg-confirm">אימות סיסמה</label>
            <div style={inputShellStyle}>
              <input
                type={showConfirmPassword ? "text" : "password"}
                id="reg-confirm"
                aria-invalid={touched.confirmPassword && !!errors.confirmPassword}
                aria-describedby="reg-confirm-msg"
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
                      ? "var(--dz-danger-border)"
                      : "var(--dz-border-strong)",
                  boxShadow:
                    touched.confirmPassword && errors.confirmPassword
                      ? "0 0 0 3px rgba(155, 70, 52,0.10)"
                      : "0 1px 2px rgba(52, 60, 50, 0.04)",
                }}
                placeholder="הכנס שוב את הסיסמה"
                autoComplete="new-password"
                spellCheck={false}
              />
              <button
                type="button"
                onClick={() => setShowConfirmPassword((prev) => !prev)}
                style={passwordToggleStyle}
                aria-label={showConfirmPassword ? "הסתר סיסמה" : "הצג סיסמה"}
                aria-pressed={showConfirmPassword}
                aria-controls="reg-confirm"
              >
                {showConfirmPassword ? "הסתר" : "הצג"}
              </button>
            </div>

            {touched.confirmPassword && errors.confirmPassword ? (
              <p id="reg-confirm-msg" role="alert" style={fieldErrorStyle}>{errors.confirmPassword}</p>
            ) : (
              <p id="reg-confirm-msg" style={helperTextStyle}>
                כדי לוודא שלא נפלה טעות בהקלדה, הזן שוב את הסיסמה.
              </p>
            )}
          </div>

          {errors.form && (
            <div role="alert" aria-live="assertive" style={formErrorStyle}>{errors.form}</div>
          )}

          <PrimaryCta type="submit" block disabled={isSubmitDisabled}>
            {loading ? "יוצר חשבון..." : "צור חשבון"}
          </PrimaryCta>

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