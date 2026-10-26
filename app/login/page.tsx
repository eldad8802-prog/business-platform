import { isPublicSignupEnabled } from "@/lib/auth/signup-gate";
import { isPasswordResetEnabled } from "@/lib/auth/account-recovery-config";
import { googleNoticeFor } from "@/lib/auth/google-notices";
import { googleButtonVisible, readGoogleLoginConfig } from "@/lib/auth/google-oauth";
import LoginForm from "./login-form";

/**
 * Login is NEVER gated — existing users must always be able to sign in, session
 * and all features intact. The server only resolves whether the "no account
 * yet? register" affordance should be shown, and passes it down as a prop, so
 * the flag stays server-side and can't be read or forged from the browser.
 */
export const dynamic = "force-dynamic";

/**
 * The same server-side resolution for "forgot password": the link is rendered only when the reset flow
 * can actually deliver its email (AUTH_PASSWORD_RESET_ENABLED + a ready mail path). `?reset=done` is
 * where the reset page sends the owner afterwards — a notice, nothing more.
 *
 * And for "Continue with Google": the button is rendered only when AUTH_GOOGLE_LOGIN_ENABLED and a complete
 * client config are present (the routes answer 404 otherwise). `?google=<reason>` is where a Google round
 * trip that did not sign anyone in comes back to — a known reason or nothing. During the pilot the button is
 * shown only on `?google=pilot` (googleButtonVisible); who may actually sign in is decided on the server.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { reset, google } = await searchParams;
  return (
    <LoginForm
      signupEnabled={isPublicSignupEnabled()}
      passwordResetEnabled={isPasswordResetEnabled()}
      notice={reset === "done" ? "reset-done" : null}
      googleEnabled={googleButtonVisible(readGoogleLoginConfig(), google)}
      googleNotice={googleNoticeFor(google)}
    />
  );
}
