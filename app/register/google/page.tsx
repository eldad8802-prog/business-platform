import { notFound } from "next/navigation";

import { isGoogleLoginEnabled } from "@/lib/auth/google-oauth";
import GoogleSignupForm from "./google-signup-form";

/**
 * "Continue with Google" — the completion of the EXISTING signup for a person Google identified: name,
 * business name, the required consent. Until this form is submitted and the account transaction commits,
 * there is no User, no Business and no session — only the single-use ticket in this browser's cookie.
 * OFF → 404.
 */
export const dynamic = "force-dynamic";

export default function GoogleSignupPage() {
  if (!isGoogleLoginEnabled()) notFound();
  return <GoogleSignupForm />;
}
