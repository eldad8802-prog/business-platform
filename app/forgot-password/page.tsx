import Link from "next/link";

import { AuthCard, authCardStyles as s } from "@/components/auth/auth-card";
import { SUPPORT_EMAIL } from "@/components/settings/settings-hub";
import { isPasswordResetEnabled } from "@/lib/auth/account-recovery-config";
import { getServerI18n } from "@/lib/i18n/server";

import ForgotForm from "./forgot-form";

/**
 * "Forgot password". Resolved on the server: while the reset flow cannot deliver its email
 * (AUTH_PASSWORD_RESET_ENABLED off, or the mail path not ready) the form is not sent at all.
 */
export const dynamic = "force-dynamic";

export default async function ForgotPasswordPage() {
  if (!isPasswordResetEnabled()) {
    const { t } = await getServerI18n();
    return (
      <AuthCard title={t("account.auth.forgot.unavailable.title")} lede={t("account.auth.forgot.unavailable.lede")}>
        <p className={s.info}>
          {t("account.auth.forgot.unavailable.supportBefore")}<a className={s.link} href={`mailto:${SUPPORT_EMAIL}`} dir="ltr">{SUPPORT_EMAIL}</a>{t("account.auth.forgot.unavailable.supportAfter")}
        </p>
        <p className={s.footer}>
          <Link href="/login" className={s.link}>{t("account.auth.common.backToLogin")}</Link>
        </p>
      </AuthCard>
    );
  }
  return <ForgotForm />;
}
