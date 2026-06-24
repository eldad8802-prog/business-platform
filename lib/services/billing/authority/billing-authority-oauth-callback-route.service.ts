/**
 * Authority OAuth callback HTTP-route orchestration (E2).
 *
 * Pure, framework-agnostic glue between the Next.js route handler and
 * `handleAuthorityOAuthCallback`. Keeps the route file thin and lets us unit
 * test outcome mapping without spinning up the HTTP layer.
 *
 * Responsibilities:
 *   - Recover the authenticated actor from the OAuth actor cookie (the browser
 *     returns from ITA via a top-level GET with no Authorization header).
 *   - Delegate state validation + token exchange to the callback service.
 *   - Map every service outcome to a safe status + short reason code.
 *
 * It never returns tokens, secrets, free-text error descriptions, or the OAuth
 * `code`/`state` values to the caller.
 */

import {
  buildAuthorityOAuthCookieClearSpecs,
  handleAuthorityOAuthCallback,
  type AuthorityOAuthCookieClearSpec,
} from "@/lib/services/billing/authority/billing-authority-oauth-callback.service";

/** Upper bound on the reason code surfaced to the browser. */
export const AUTHORITY_CALLBACK_REASON_MAX_LENGTH = 64;

/** Reason emitted when the actor cookie is missing/invalid (no session carried). */
export const AUTHORITY_CALLBACK_MISSING_SESSION_REASON = "MISSING_SESSION";

export type AuthorityCallbackRouteQuery = {
  code?: string | null;
  state?: string | null;
  error?: string | null;
  errorDescription?: string | null;
};

export type AuthorityCallbackRouteCookies = {
  state?: string | null;
  businessId?: string | null;
  environment?: string | null;
  actorUserId?: string | null;
};

export type ResolveAuthorityCallbackInput = {
  query: AuthorityCallbackRouteQuery;
  cookies: AuthorityCallbackRouteCookies;
  redirectBaseUrl: string;
  secureCookies?: boolean;
};

export type AuthorityCallbackRouteOutcome = {
  ok: boolean;
  status: "connected" | "error";
  /** Safe, uppercase short code only — never secrets or free text. */
  reason: string | null;
  clearedCookies: AuthorityOAuthCookieClearSpec[];
};

export type ResolveAuthorityCallbackDeps = {
  handleCallback?: typeof handleAuthorityOAuthCallback;
};

function parseActorUserId(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value <= 0) return null;
  return value;
}

/**
 * Coerces an internal error code into a browser-safe reason: uppercase
 * alphanumeric + underscore, length-capped. Strips anything that could carry
 * a token, URL, or human-readable secret.
 */
export function toSafeReason(code: string | null | undefined): string {
  const normalized = (code ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  const trimmed = normalized.slice(0, AUTHORITY_CALLBACK_REASON_MAX_LENGTH);
  return trimmed.length > 0 ? trimmed : "UNKNOWN_ERROR";
}

/**
 * Resolves an ITA OAuth callback into a safe outcome for the route layer.
 * Always returns cookie-clear specs so the route can wipe OAuth cookies on
 * every path, success or failure.
 */
export async function resolveAuthorityOAuthCallback(
  input: ResolveAuthorityCallbackInput,
  deps: ResolveAuthorityCallbackDeps = {}
): Promise<AuthorityCallbackRouteOutcome> {
  const handle = deps.handleCallback ?? handleAuthorityOAuthCallback;
  const actorUserId = parseActorUserId(input.cookies.actorUserId);

  if (actorUserId == null) {
    return {
      ok: false,
      status: "error",
      reason: AUTHORITY_CALLBACK_MISSING_SESSION_REASON,
      clearedCookies: buildAuthorityOAuthCookieClearSpecs({
        secureCookies: input.secureCookies,
      }),
    };
  }

  const result = await handle({
    query: {
      code: input.query.code,
      state: input.query.state,
      error: input.query.error,
      errorDescription: input.query.errorDescription,
    },
    cookies: {
      state: input.cookies.state,
      businessId: input.cookies.businessId,
      environment: input.cookies.environment,
    },
    redirectBaseUrl: input.redirectBaseUrl,
    actorUserId,
    secureCookies: input.secureCookies,
  });

  if (result.ok) {
    return {
      ok: true,
      status: "connected",
      reason: null,
      clearedCookies: result.clearedCookies,
    };
  }

  return {
    ok: false,
    status: "error",
    reason: toSafeReason(result.errorCode),
    clearedCookies: result.clearedCookies,
  };
}
