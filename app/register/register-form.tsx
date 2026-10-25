"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AccessibilityTrigger } from "@/components/ui/accessibility/accessibility-trigger";
import { useI18n } from "@/components/i18n/I18nProvider";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/signup-identity";
import { SIGNUP_HONEYPOT_FIELD } from "@/lib/auth/signup-honeypot";
import { GoogleNotice, GoogleSignInButton } from "@/components/auth/google-sign-in";

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

export default function RegisterForm({
  googleEnabled = false,
  googleNotice = null,
}: {
  googleEnabled?: boolean;
  googleNotice?: string | null;
} = {}) {
  const router = useRouter();
  const { t } = useI18n();

  const [name, setName] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [acceptTerms, setAcceptTerms] = useState(false);
  // The honeypot (lib/auth/signup-honeypot.ts): uncontrolled, read once at submit.
  const honeypotRef = useRef<HTMLInputElement>(null);

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
    if (!value) return { segments: 0, text: t("account.auth.register.strength.minLength", { count: MIN_PASSWORD_LENGTH }) };
    if (value.length < MIN_PASSWORD_LENGTH) {
      const left = MIN_PASSWORD_LENGTH - value.length;
      return { segments: 1, text: t(left === 1 ? "account.auth.register.strength.moreOne" : "account.auth.register.strength.moreMany", { count: left }) };
    }
    let score = 1;
    if (value.length >= 12) score += 1;
    if (/[0-9]/.test(value) && /[A-Za-z\u05D0-\u05EA]/.test(value)) score += 1;
    if (/[^A-Za-z0-9\u0590-\u05FF]/.test(value)) score += 1;
    const words = ["", t("account.auth.register.strength.fair"), t("account.auth.register.strength.good"), t("account.auth.register.strength.strong"), t("account.auth.register.strength.veryStrong")];
    return { segments: score, text: words[score] };
  }

  // Cheap, and it reads the active language: computed on every render.
  const passwordStrength = getPasswordStrength(password);

  function validateField(
    field: "name" | "businessName" | "email" | "password",
    value: string
  ) {
    if (field === "name") {
      if (!value.trim()) return t("account.auth.register.errors.nameRequired");
      if (value.trim().length < 2) return t("account.auth.register.errors.nameTooShort");
      return "";
    }

    if (field === "businessName") {
      if (!value.trim()) return t("account.auth.register.errors.businessRequired");
      if (value.trim().length < 2) return t("account.auth.register.errors.businessTooShort");
      return "";
    }

    if (field === "email") {
      if (!value.trim()) return t("account.auth.common.emailRequired");
      if (!emailRegex.test(value.trim())) return t("account.auth.common.emailInvalid");
      return "";
    }

    if (field === "password") {
      if (!value.trim()) return t("account.auth.common.passwordRequired");
      if (value.length < MIN_PASSWORD_LENGTH)
        return t("account.auth.common.passwordTooShort", { count: MIN_PASSWORD_LENGTH });
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
    if (!acceptTerms) nextErrors.acceptTerms = t("account.auth.register.errors.termsRequired");

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
          [SIGNUP_HONEYPOT_FIELD]: honeypotRef.current?.value ?? "",
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

        throw new Error(registerData?.error || t("account.auth.register.errors.registerFailed"));
      }

      // Signup now returns the session itself. There is no second login call to
      // fail, so a created account can no longer strand its owner.
      if (!registerData?.token) {
        throw new Error(t("account.auth.register.errors.noToken"));
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
        form: err instanceof Error ? err.message : t("account.auth.register.errors.registerFailed"),
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
            <AccessibilityTrigger className={`${styles.a11yBtn} ${styles.brandA11y}`} label={t("account.auth.common.a11ySettings")} />
          </div>
          <p className={styles.brandTitle}>{t("account.auth.register.brand.title")}</p>
          <ol className={styles.steps}>
            <li className={styles.step}>
              <span className={`${styles.stepNum} ${styles.stepNumOn}`}>1</span>
              <span className={styles.stepText}>
                <span className={styles.stepTitle}>{t("account.auth.register.brand.step1Title")}</span>
                <span className={styles.stepSub}>{t("account.auth.register.brand.step1Sub")}</span>
              </span>
            </li>
            <li className={styles.step}>
              <span className={styles.stepNum}>2</span>
              <span className={styles.stepText}>
                <span className={styles.stepTitle}>{t("account.auth.register.brand.step2Title")}</span>
                <span className={styles.stepSub}>{t("account.auth.register.brand.step2Sub")}</span>
              </span>
            </li>
            <li className={styles.step}>
              <span className={styles.stepNum}>3</span>
              <span className={styles.stepText}>
                <span className={styles.stepTitle}>{t("account.auth.register.brand.step3Title")}</span>
                <span className={styles.stepSub}>{t("account.auth.register.brand.step3Sub")}</span>
              </span>
            </li>
          </ol>
          <p className={styles.brandFoot}>{t("account.auth.register.brand.foot")}</p>
        </div>
      </aside>

      <div className={styles.formSide}>
        <div className={styles.topBar}>
          <div className={styles.topLogo}>
            <span className={styles.logoMark} aria-hidden="true">d</span>
            <span className={styles.logoWord} dir="ltr">dubiz</span>
          </div>
          <AccessibilityTrigger className={styles.a11yBtn} label={t("account.auth.common.a11ySettings")} />
        </div>

        <form className={styles.form} onSubmit={handleRegister} noValidate>
          {/* Not for people: clipped to nothing, out of the tab order, hidden from assistive technology. */}
          <div
            aria-hidden="true"
            style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clipPath: "inset(50%)", whiteSpace: "nowrap", opacity: 0, pointerEvents: "none" }}
          >
            <label htmlFor="dz-confirm-field">{t("account.auth.register.honeypotLabel")}</label>
            <input ref={honeypotRef} id="dz-confirm-field" name={SIGNUP_HONEYPOT_FIELD} type="text" tabIndex={-1} autoComplete="off" defaultValue="" />
          </div>
          <div className={styles.head}>
            <h1 className={styles.title}>{t("account.auth.register.title")}</h1>
            <p className={styles.loginLine}>
              {t("account.auth.register.haveAccount")}{" "}
              <Link href="/login" className={styles.link}>
                {t("account.auth.register.toLogin")}
              </Link>
            </p>
          </div>

          <GoogleNotice notice={googleNotice} />
          <GoogleSignInButton enabled={googleEnabled} from="register" />

          <div className={styles.grid}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="reg-name">{t("account.auth.register.nameLabel")}</label>
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
              <label className={styles.label} htmlFor="reg-business">{t("account.auth.register.businessLabel")}</label>
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
              <label className={styles.label} htmlFor="reg-email">{t("account.auth.common.emailLabel")}</label>
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
              <label className={styles.label} htmlFor="reg-password">{t("account.auth.common.passwordLabel")}</label>
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
                  aria-label={showPassword ? t("account.auth.common.hidePasswordAria") : t("account.auth.common.showPasswordAria")}
                  aria-pressed={showPassword}
                >
                  {showPassword ? t("account.auth.common.hide") : t("account.auth.common.show")}
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
                {t("account.auth.register.terms.prefix")}{" "}
                <Link href={TERMS_HREF} target="_blank" rel="noopener noreferrer">
                  {t("account.auth.register.terms.termsLink")}
                </Link>{" "}
                {t("account.auth.register.terms.join")}{" "}
                <Link href={PRIVACY_HREF} target="_blank" rel="noopener noreferrer">
                  {t("account.auth.register.terms.privacyLink")}
                </Link>
              </span>
              {termsError ? (
                <span id="reg-terms-msg" role="alert" className={styles.termsError}>
                  {t("account.auth.register.terms.error")}
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
              {loading ? t("account.auth.register.submitting") : t("account.auth.register.submit")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
