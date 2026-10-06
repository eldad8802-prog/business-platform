"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AccessibilityTrigger } from "@/components/ui/accessibility/accessibility-trigger";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/signup-identity";

import styles from "./register.module.css";

const TERMS_HREF = "/terms";
const PRIVACY_HREF = "/privacy";

type RegisterErrors = {
  name?: string;
  businessName?: string;
  email?: string;
  password?: string;
  acceptTerms?: string;
  form?: string;
};

export default function RegisterForm() {
  const router = useRouter();

  const [name, setName] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [acceptTerms, setAcceptTerms] = useState(false);

  const [showPassword, setShowPassword] = useState(false);

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

  /** 0–4 filled segments and a short word. Below the minimum it never reads as "good". */
  function getPasswordStrength(value: string): { segments: number; text: string } {
    if (!value) return { segments: 0, text: `לפחות ${MIN_PASSWORD_LENGTH} תווים` };
    if (value.length < MIN_PASSWORD_LENGTH) {
      return { segments: 1, text: `עוד ${MIN_PASSWORD_LENGTH - value.length} תווים לפחות` };
    }
    let score = 1;
    if (value.length >= 12) score += 1;
    if (/[0-9]/.test(value) && /[A-Za-z\u05D0-\u05EA]/.test(value)) score += 1;
    if (/[^A-Za-z0-9\u0590-\u05FF]/.test(value)) score += 1;
    return { segments: score, text: ["", "סיסמה סבירה", "סיסמה טובה", "סיסמה חזקה", "סיסמה חזקה מאוד"][score] };
  }

  const passwordStrength = useMemo(
    () => getPasswordStrength(password),
    [password]
  );

  function validateField(
    field: "name" | "businessName" | "email" | "password",
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
      if (value.length < MIN_PASSWORD_LENGTH)
        return `הסיסמה חייבת להכיל לפחות ${MIN_PASSWORD_LENGTH} תווים`;
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

    if (nameError) nextErrors.name = nameError;
    if (businessNameError) nextErrors.businessName = businessNameError;
    if (emailError) nextErrors.email = emailError;
    if (passwordError) nextErrors.password = passwordError;
    if (!acceptTerms) nextErrors.acceptTerms = "יש לאשר את תנאי השימוש ומדיניות הפרטיות";

    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  }

  function handleBlur(
    field: "name" | "businessName" | "email" | "password"
  ) {
    setTouched((prev) => ({ ...prev, [field]: true }));

    const valueMap = {
      name,
      businessName,
      email,
      password,
    };

    const fieldError = validateField(field, valueMap[field]);

    setErrors((prev) => ({
      ...prev,
      [field]: fieldError || undefined,
    }));
  }

  // The button stays live: pressing it is how the owner finds out what is still
  // missing, the terms included. Only an in-flight request disables it.
  const isSubmitDisabled = loading;

  /**
   * Campaign labels from the landing page, read at submit. The server keeps only
   * a sanitised allowlist (utm_* and the referrer host) — see signup-identity.ts.
   */
  function readAttribution(): Record<string, string> | null {
    const params = new URLSearchParams(window.location.search);
    const found: Record<string, string> = {};
    for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"]) {
      const v = params.get(key);
      if (v) found[key] = v;
    }
    if (document.referrer) found.referrer = document.referrer;
    return Object.keys(found).length > 0 ? found : null;
  }

  const handleRegister = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    setTouched({
      name: true,
      businessName: true,
      email: true,
      password: true,
      acceptTerms: true,
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
          acceptTerms,
          attribution: readAttribution(),
        }),
      });

      const registerData = await registerRes.json();

      if (!registerRes.ok) {
        // Registration closed (the public-signup gate). Show the server's own
        // Hebrew message rather than a generic signup error — this is a
        // deliberate product state, not a failure the visitor can retry away.
        if (registerData?.code === "SIGNUP_DISABLED") {
          setErrors({ form: registerData.message || registerData.error });
          return;
        }

        // A duplicate address is not a system error — it is a fact about this
        // one field, so it is shown on that field rather than as a red banner
        // the person can only re-read.
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

      // Stored exactly as login stores it; the refresh credential arrived as an
      // httpOnly cookie on this same response and never touches JavaScript.
      localStorage.setItem("token", registerData.token);

      if (registerData.sessionId) {
        localStorage.setItem("sessionId", registerData.sessionId);
      }

      if (registerData.user) {
        localStorage.setItem("user", JSON.stringify(registerData.user));
      } else {
        localStorage.removeItem("user");
      }

      // A new business starts with one short, skippable screen about itself.
      router.replace("/setup");
    } catch (err) {
      console.error("register error:", err);
      setErrors({
        form: err instanceof Error ? err.message : "שגיאה בהרשמה",
      });
    } finally {
      setLoading(false);
    }
  };

  const fieldError = (field: keyof RegisterErrors) => (touched[field] ? errors[field] : undefined);

  if (bootLoading) {
    return <div className={styles.page} aria-busy="true" />;
  }

  const termsError = fieldError("acceptTerms");
  const termsClass = [styles.terms, termsError ? styles.termsBad : acceptTerms ? styles.termsOn : ""].join(" ");

  return (
    <div className={styles.page}>
      <aside className={styles.brand} aria-label="Dubiz">
        <div className={styles.brandInner}>
          <div className={styles.brandHead}>
            <div className={styles.logo}>
              <span className={styles.logoMark} aria-hidden="true">d</span>
              <span className={styles.logoWord} dir="ltr">dubiz</span>
            </div>
            <AccessibilityTrigger className={`${styles.a11yBtn} ${styles.brandA11y}`} label="הגדרות נגישות" />
          </div>
          <p className={styles.brandTitle}>העסק שלכם, במקום אחד.</p>
          <ol className={styles.steps}>
            <li className={styles.step}>
              <span className={`${styles.stepNum} ${styles.stepNumOn}`}>1</span>
              <span className={styles.stepText}>
                <span className={styles.stepTitle}>פותחים חשבון</span>
                <span className={styles.stepSub}>שם, שם העסק, אימייל וסיסמה.</span>
              </span>
            </li>
            <li className={styles.step}>
              <span className={styles.stepNum}>2</span>
              <span className={styles.stepText}>
                <span className={styles.stepTitle}>מספרים קצת על העסק</span>
                <span className={styles.stepSub}>כמה מילים. אפשר גם אחר כך.</span>
              </span>
            </li>
            <li className={styles.step}>
              <span className={styles.stepNum}>3</span>
              <span className={styles.stepText}>
                <span className={styles.stepTitle}>עובדים כרגיל</span>
                <span className={styles.stepSub}>Dubiz לומד את העסק מהעבודה עצמה.</span>
              </span>
            </li>
          </ol>
          <p className={styles.brandFoot}>מסמכים · גבייה · לקוחות · פניות · תוכן</p>
        </div>
      </aside>

      <div className={styles.formSide}>
        <div className={styles.topBar}>
          <div className={styles.topLogo}>
            <span className={styles.logoMark} aria-hidden="true">d</span>
            <span className={styles.logoWord} dir="ltr">dubiz</span>
          </div>
          <AccessibilityTrigger className={styles.a11yBtn} label="הגדרות נגישות" />
        </div>

        <form className={styles.form} onSubmit={handleRegister} noValidate>
          <div className={styles.head}>
            <h1 className={styles.title}>פתיחת חשבון</h1>
            <p className={styles.loginLine}>
              כבר יש לך חשבון?{" "}
              <Link href="/login" className={styles.link}>
                להתחברות
              </Link>
            </p>
          </div>

          <div className={styles.grid}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="reg-name">שם מלא</label>
              <input
                id="reg-name"
                className={`${styles.input} ${fieldError("name") ? styles.invalid : ""}`}
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => handleBlur("name")}
                aria-invalid={!!fieldError("name")}
                aria-describedby={fieldError("name") ? "reg-name-msg" : undefined}
              />
              {fieldError("name") ? <p id="reg-name-msg" role="alert" className={styles.error}>{fieldError("name")}</p> : null}
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="reg-business">שם העסק</label>
              <input
                id="reg-business"
                className={`${styles.input} ${fieldError("businessName") ? styles.invalid : ""}`}
                autoComplete="organization"
                value={businessName}
                onChange={(e) => setBusinessName(e.target.value)}
                onBlur={() => handleBlur("businessName")}
                aria-invalid={!!fieldError("businessName")}
                aria-describedby={fieldError("businessName") ? "reg-business-msg" : undefined}
              />
              {fieldError("businessName") ? (
                <p id="reg-business-msg" role="alert" className={styles.error}>{fieldError("businessName")}</p>
              ) : null}
            </div>

            <div className={`${styles.field} ${styles.gridWide}`}>
              <label className={styles.label} htmlFor="reg-email">אימייל</label>
              <input
                id="reg-email"
                type="email"
                dir="ltr"
                inputMode="email"
                autoComplete="email"
                placeholder="name@example.com"
                className={`${styles.input} ${styles.ltr} ${fieldError("email") ? styles.invalid : ""}`}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onBlur={() => handleBlur("email")}
                aria-invalid={!!fieldError("email")}
                aria-describedby={fieldError("email") ? "reg-email-msg" : undefined}
              />
              {fieldError("email") ? <p id="reg-email-msg" role="alert" className={styles.error}>{fieldError("email")}</p> : null}
            </div>

            <div className={`${styles.field} ${styles.gridWide}`}>
              <label className={styles.label} htmlFor="reg-password">סיסמה</label>
              <div className={styles.pw}>
                <input
                  id="reg-password"
                  type={showPassword ? "text" : "password"}
                  dir="ltr"
                  autoComplete="new-password"
                  className={`${styles.input} ${styles.ltr} ${fieldError("password") ? styles.invalid : ""}`}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onBlur={() => handleBlur("password")}
                  aria-invalid={!!fieldError("password")}
                  aria-describedby="reg-password-msg"
                />
                <button
                  type="button"
                  className={styles.toggle}
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "הסתר סיסמה" : "הצג סיסמה"}
                  aria-pressed={showPassword}
                >
                  {showPassword ? "הסתר" : "הצג"}
                </button>
              </div>
              <div className={styles.meterRow}>
                {fieldError("password") ? (
                  <p id="reg-password-msg" role="alert" className={styles.error}>{fieldError("password")}</p>
                ) : (
                  <span id="reg-password-msg">{passwordStrength.text}</span>
                )}
                <span className={styles.meter} aria-hidden="true">
                  {[0, 1, 2, 3].map((i) => (
                    <span key={i} className={`${styles.seg} ${i < passwordStrength.segments ? styles.segOn : ""}`} />
                  ))}
                </span>
              </div>
            </div>
          </div>

          <label className={termsClass} htmlFor="reg-terms">
            <input
              id="reg-terms"
              type="checkbox"
              checked={acceptTerms}
              aria-invalid={!!termsError}
              aria-describedby={termsError ? "reg-terms-msg" : undefined}
              onChange={(e) => {
                setAcceptTerms(e.target.checked);
                if (e.target.checked) setErrors((prev) => ({ ...prev, acceptTerms: undefined }));
              }}
            />
            <span className={styles.termsText}>
              <span>
                אני מאשר/ת את{" "}
                <Link href={TERMS_HREF} target="_blank" rel="noopener noreferrer">
                  תנאי השימוש
                </Link>{" "}
                ואת{" "}
                <Link href={PRIVACY_HREF} target="_blank" rel="noopener noreferrer">
                  מדיניות הפרטיות
                </Link>
              </span>
              {termsError ? (
                <span id="reg-terms-msg" role="alert" className={styles.termsError}>
                  כדי לפתוח חשבון צריך לאשר את התנאים.
                </span>
              ) : null}
            </span>
          </label>

          {errors.form ? (
            <p role="alert" aria-live="assertive" className={styles.formError}>
              {errors.form}
            </p>
          ) : null}

          <div className={styles.actions}>
            <button type="submit" className={styles.submit} disabled={isSubmitDisabled}>
              {loading ? "פותחים את החשבון…" : "פתיחת חשבון"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
