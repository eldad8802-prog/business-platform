/**
 * Switches for the two account-link flows. Both are OFF unless explicitly turned on, and each is only
 * ever ON when the email it depends on can actually be delivered — so turning a flag on before the mail
 * path is ready changes nothing a user can see (fail closed):
 *
 *   AUTH_EMAIL_VERIFICATION_ENABLED = "true"  — signup issues a verification link; unverified owners see
 *                                               a quiet banner with "send again". Never a lock-out.
 *   AUTH_PASSWORD_RESET_ENABLED     = "true"  — "שכחתי סיסמה" on the login screen and the reset request.
 *
 * Effective only together with:
 *   - transactional email ON and fully configured (TRANSACTIONAL_EMAIL_ENABLED + key / sender / base URL);
 *   - the auth plane active (AUTH_PLANE_ENABLED = "true"): only app_auth may run the token functions.
 *
 * Consuming a link that was already sent does NOT depend on these switches: a link is its own
 * authority, checked in the database. Turning a flag off stops new links; it never strands a person
 * holding one.
 */

import { readTransactionalEmailConfig, type TransactionalEmailEnv } from "@/lib/email/transactional/config";

function mailPathReady(env: TransactionalEmailEnv): boolean {
  const config = readTransactionalEmailConfig(env);
  return config.enabled && config.ok && env.AUTH_PLANE_ENABLED?.trim().toLowerCase() === "true";
}

export function isEmailVerificationEnabled(env: TransactionalEmailEnv = process.env): boolean {
  return env.AUTH_EMAIL_VERIFICATION_ENABLED?.trim() === "true" && mailPathReady(env);
}

export function isPasswordResetEnabled(env: TransactionalEmailEnv = process.env): boolean {
  return env.AUTH_PASSWORD_RESET_ENABLED?.trim() === "true" && mailPathReady(env);
}
