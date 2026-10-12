import Link from "next/link";

import { AuthCard, authCardStyles as s } from "@/components/auth/auth-card";
import { SUPPORT_EMAIL } from "@/components/settings/settings-hub";
import { isPasswordResetEnabled } from "@/lib/auth/account-recovery-config";

import ForgotForm from "./forgot-form";

/**
 * "Forgot password". Resolved on the server: while the reset flow cannot deliver its email
 * (AUTH_PASSWORD_RESET_ENABLED off, or the mail path not ready) the form is not sent at all.
 */
export const dynamic = "force-dynamic";

export default function ForgotPasswordPage() {
  if (!isPasswordResetEnabled()) {
    return (
      <AuthCard title="שחזור סיסמה" lede="האפשרות לבחור סיסמה חדשה דרך המייל עדיין לא זמינה.">
        <p className={s.info}>
          אם אין לך גישה לחשבון, אפשר לכתוב לנו ל־<a className={s.link} href={`mailto:${SUPPORT_EMAIL}`} dir="ltr">{SUPPORT_EMAIL}</a> ונעזור.
        </p>
        <p className={s.footer}>
          <Link href="/login" className={s.link}>חזרה לכניסה</Link>
        </p>
      </AuthCard>
    );
  }
  return <ForgotForm />;
}
