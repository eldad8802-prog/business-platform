import { isPublicSignupEnabled } from "@/lib/auth/signup-gate";
import LoginForm from "./login-form";

/**
 * Login is NEVER gated — existing users must always be able to sign in, session
 * and all features intact. The server only resolves whether the "no account
 * yet? register" affordance should be shown, and passes it down as a prop, so
 * the flag stays server-side and can't be read or forged from the browser.
 */
export const dynamic = "force-dynamic";

export default function LoginPage() {
  return <LoginForm signupEnabled={isPublicSignupEnabled()} />;
}
