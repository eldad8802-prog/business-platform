import { isPublicSignupEnabled } from "@/lib/auth/signup-gate";
import { isPasswordResetEnabled } from "@/lib/auth/account-recovery-config";
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
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { reset } = await searchParams;
  return (
    <LoginForm
      signupEnabled={isPublicSignupEnabled()}
      passwordResetEnabled={isPasswordResetEnabled()}
      notice={reset === "done" ? "reset-done" : null}
    />
  );
}
