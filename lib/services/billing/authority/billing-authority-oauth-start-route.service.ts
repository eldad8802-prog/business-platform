/**
 * Authority OAuth START HTTP-route orchestration (E2).
 *
 * Pure, framework-agnostic glue between the Next.js connect route and
 * `startAuthorityOAuth`. Resolves the acting user + target business, enforces
 * tenant access, picks the environment (sandbox-first), and returns the ITA
 * authorize URL plus the OAuth cookie specs for the route layer to set.
 *
 * It never returns or logs the client secret, tokens, or sensitive config. The
 * authorize URL it returns is a standard public OAuth URL (client_id +
 * redirect_uri + scope + state only).
 */

import { BillingAuthorityEnvironment, UserRole } from "@prisma/client";
import {
  startAuthorityOAuth,
  type AuthorityOAuthCookieSpec,
} from "@/lib/services/billing/authority/billing-authority-oauth-start.service";

export type AuthorityStartActor = {
  id: number;
  businessId: number;
  role: UserRole;
};

export type ResolveAuthorityStartInput = {
  /** Null when the request carries no authenticated Dubiz user. */
  user: AuthorityStartActor | null;
  /**
   * CASA 3.3.1: whether this request carries a valid platform-admin MFA
   * elevation. Required for the cross-tenant admin branch below — that branch is
   * an administrative capability living on a TENANT route, so it cannot go
   * through the admin guard and must assert the second factor itself.
   * Optional and defaulting to false, so a caller that forgets it gets the SAFE
   * answer (no cross-tenant targeting) rather than the permissive one.
   */
  adminElevated?: boolean;
  /** Optional `?businessId` override; defaults to the actor's own business. */
  requestedBusinessId?: string | number | null;
  /** Optional `?environment`; defaults to SANDBOX (sandbox-first). */
  environment?: string | null;
  redirectBaseUrl: string;
  secureCookies?: boolean;
};

export type AuthorityStartOutcome =
  | {
      ok: true;
      authorizationUrl: string;
      cookies: AuthorityOAuthCookieSpec[];
      businessId: number;
      environment: BillingAuthorityEnvironment;
    }
  | {
      ok: false;
      status: "unauthenticated" | "forbidden" | "error";
      reason: string;
    };

export type ResolveAuthorityStartDeps = {
  startOAuth?: typeof startAuthorityOAuth;
};

export const AUTHORITY_START_REASONS = {
  UNAUTHENTICATED: "UNAUTHENTICATED",
  INVALID_BUSINESS: "INVALID_BUSINESS",
  MISSING_BUSINESS: "MISSING_BUSINESS",
  BUSINESS_FORBIDDEN: "BUSINESS_FORBIDDEN",
  INVALID_ENVIRONMENT: "INVALID_ENVIRONMENT",
} as const;

function parsePositiveInt(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  const num = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isInteger(num) || num <= 0) return null;
  return num;
}

/** Sandbox-first: empty/absent -> SANDBOX. Unknown value -> null (rejected). */
export function parseStartEnvironment(
  raw: string | null | undefined
): BillingAuthorityEnvironment | null {
  const normalized = (raw ?? "").trim().toUpperCase();
  if (normalized === "" || normalized === "SANDBOX") {
    return BillingAuthorityEnvironment.SANDBOX;
  }
  if (normalized === "PRODUCTION") {
    return BillingAuthorityEnvironment.PRODUCTION;
  }
  return null;
}

/**
 * Resolves a START request into an authorize redirect + cookies, or a typed
 * refusal. Tenant rule: a non-admin user may only start OAuth for their own
 * business; PLATFORM_ADMIN may target any business via `?businessId`.
 */
export async function resolveAuthorityOAuthStart(
  input: ResolveAuthorityStartInput,
  deps: ResolveAuthorityStartDeps = {}
): Promise<AuthorityStartOutcome> {
  const start = deps.startOAuth ?? startAuthorityOAuth;

  if (!input.user) {
    return {
      ok: false,
      status: "unauthenticated",
      reason: AUTHORITY_START_REASONS.UNAUTHENTICATED,
    };
  }

  const environment = parseStartEnvironment(input.environment);
  if (environment == null) {
    return {
      ok: false,
      status: "error",
      reason: AUTHORITY_START_REASONS.INVALID_ENVIRONMENT,
    };
  }

  const actorBusinessId = parsePositiveInt(input.user.businessId);
  if (actorBusinessId == null) {
    return {
      ok: false,
      status: "error",
      reason: AUTHORITY_START_REASONS.MISSING_BUSINESS,
    };
  }

  // When an explicit businessId is supplied it must be valid and, for
  // non-admins, must match the actor's own business.
  let targetBusinessId = actorBusinessId;
  if (input.requestedBusinessId != null && String(input.requestedBusinessId).trim() !== "") {
    const requested = parsePositiveInt(input.requestedBusinessId);
    if (requested == null) {
      return {
        ok: false,
        status: "error",
        reason: AUTHORITY_START_REASONS.INVALID_BUSINESS,
      };
    }
    // Cross-tenant targeting is an ADMIN capability. It requires the role AND,
    // when MFA enforcement is on, a proven second factor — otherwise a stolen
    // admin session alone could pivot into any tenant from a non-admin route.
    const isAdmin =
      input.user.role === UserRole.PLATFORM_ADMIN && input.adminElevated === true;
    if (requested !== actorBusinessId && !isAdmin) {
      return {
        ok: false,
        status: "forbidden",
        reason: AUTHORITY_START_REASONS.BUSINESS_FORBIDDEN,
      };
    }
    targetBusinessId = requested;
  }

  const result = await start({
    businessId: targetBusinessId,
    actorUserId: input.user.id,
    environment,
    redirectBaseUrl: input.redirectBaseUrl,
    secureCookies: input.secureCookies,
  });

  return {
    ok: true,
    authorizationUrl: result.authorizationUrl,
    cookies: result.cookies,
    businessId: targetBusinessId,
    environment,
  };
}
