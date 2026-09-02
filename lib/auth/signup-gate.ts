/**
 * Public-signup gate — "Closed Registration / Existing Users Only".
 *
 * ONE server-side switch decides whether Dubiz accepts NEW registrations.
 * It never touches authentication: existing users always log in, keep their
 * session, and use every feature exactly as before. The gate only guards the
 * creation of a NEW User + Business pair.
 *
 * Flag: `PUBLIC_SIGNUP_ENABLED`
 *   - `"true"`  -> public registration OPEN (normal behaviour, no code change)
 *   - anything else, including unset -> public registration CLOSED
 *
 * The default is CLOSED on purpose (same fail-closed convention as the other
 * flags in this repo, e.g. `BOT_LLM_DRAFTS_ENABLED`): a missing or mistyped
 * env var must never silently re-open public registration.
 *
 * NOTE ON THE NAME: "PUBLIC" here means *public registration*, not "exposed to
 * the browser". There is deliberately no `NEXT_PUBLIC_` prefix — the flag is
 * read on the server only, so it cannot be spoofed from the client. Server
 * Components read it directly and pass the resolved boolean down as a prop.
 */

/** Machine-readable error code returned by every blocked signup path. */
export const SIGNUP_DISABLED_CODE = "SIGNUP_DISABLED" as const;

/** HTTP status for a blocked signup attempt. Never a 500. */
export const SIGNUP_DISABLED_STATUS = 403 as const;

/** User-facing Hebrew copy, shared by the API response and the UI. */
export const SIGNUP_DISABLED_TITLE_HE = "ההרשמה סגורה כרגע";

export const SIGNUP_DISABLED_MESSAGE_HE =
  "ההרשמה למערכת סגורה זמנית ואיננו מקבלים חשבונות חדשים כרגע. משתמשים קיימים יכולים להתחבר ולעבוד כרגיל.";

/** True only when public registration is explicitly opened. */
export function isPublicSignupEnabled(): boolean {
  return process.env.PUBLIC_SIGNUP_ENABLED === "true";
}

export type PublicSignupDiagnostics = {
  flagRaw: string | undefined;
  enabled: boolean;
  reasonIfDisabled: string;
};

/** Non-secret diagnostics — safe to log, never returned to the client. */
export function getPublicSignupDiagnostics(): PublicSignupDiagnostics {
  const raw = process.env.PUBLIC_SIGNUP_ENABLED;
  const enabled = raw === "true";
  return {
    flagRaw: raw,
    enabled,
    reasonIfDisabled: enabled
      ? "ok"
      : `PUBLIC_SIGNUP_ENABLED is not "true" (got: ${
          raw === undefined ? "undefined" : JSON.stringify(raw)
        })`,
  };
}

/** Canonical JSON body for a blocked signup attempt. */
export function signupDisabledBody(): {
  error: string;
  code: typeof SIGNUP_DISABLED_CODE;
  message: string;
} {
  return {
    error: SIGNUP_DISABLED_CODE,
    code: SIGNUP_DISABLED_CODE,
    message: SIGNUP_DISABLED_MESSAGE_HE,
  };
}
