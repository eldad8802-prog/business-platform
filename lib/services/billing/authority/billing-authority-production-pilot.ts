/**
 * Production pilot gate for the Israel Tax Authority (ITA) integration.
 *
 * PRODUCTION authority work (OAuth start + callback, token refresh, validation,
 * Approval, Decision, and the platform network probe) is allowed ONLY for the
 * businesses listed in BILLING_AUTHORITY_PRODUCTION_PILOT_BUSINESS_IDS.
 *
 * Rules:
 *   - Off by default: unset / empty → no business is allowed.
 *   - Fail closed: any malformed entry closes the gate for EVERYONE (a typo can
 *     never widen access).
 *   - SANDBOX is not affected.
 *   - Enforced twice: by each service before any state change (clear refusal),
 *     and by the egress transport before any network I/O (so a path that forgets
 *     the service check is still refused). See billing-authority-egress.ts.
 *   - The env var is read on every check — there is no cache to go stale.
 *
 * Value format: comma-separated positive integer business ids, e.g. "42" or
 * "42,57". At most AUTHORITY_PRODUCTION_PILOT_MAX_BUSINESSES entries.
 */

import type { BillingAuthorityEnvironment } from "@prisma/client";

export const AUTHORITY_PRODUCTION_PILOT_ENV_VAR =
  "BILLING_AUTHORITY_PRODUCTION_PILOT_BUSINESS_IDS" as const;

export const AUTHORITY_PRODUCTION_PILOT_NOT_ENABLED =
  "AUTHORITY_PRODUCTION_PILOT_NOT_ENABLED" as const;

export const AUTHORITY_PRODUCTION_PILOT_MAX_BUSINESSES = 20;

/** Who a PRODUCTION authority request is made for. */
export type AuthorityPilotScope =
  | { kind: "business"; businessId: number }
  /**
   * The admin-only, credential-less network probe: no business, no token, no
   * business data. Allowed in PRODUCTION only while the pilot is enabled.
   */
  | { kind: "platform-diagnostic" };

type EnvSource = Readonly<Record<string, string | undefined>>;

const BUSINESS_ID = /^[1-9]\d{0,9}$/;

/**
 * Parses the allowlist. Returns an empty set when unset, empty, malformed, or
 * longer than the maximum — never a partial list.
 */
export function parseProductionPilotBusinessIds(
  raw: string | undefined
): ReadonlySet<number> {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (trimmed.length === 0) return new Set();

  const parts = trimmed.split(",").map((part) => part.trim());
  if (parts.length > AUTHORITY_PRODUCTION_PILOT_MAX_BUSINESSES) return new Set();

  const ids = new Set<number>();
  for (const part of parts) {
    if (!BUSINESS_ID.test(part)) return new Set();
    const id = Number(part);
    if (!Number.isSafeInteger(id)) return new Set();
    ids.add(id);
  }
  return ids;
}

export function isAuthorityProductionPilotEnabled(
  env: EnvSource = process.env
): boolean {
  return parseProductionPilotBusinessIds(env[AUTHORITY_PRODUCTION_PILOT_ENV_VAR]).size > 0;
}

/** True when the scope may make authority requests in this environment. */
export function isAuthorityPilotScopeAllowed(
  scope: AuthorityPilotScope,
  environment: BillingAuthorityEnvironment,
  env: EnvSource = process.env
): boolean {
  if (environment !== "PRODUCTION") return true;
  const allowed = parseProductionPilotBusinessIds(env[AUTHORITY_PRODUCTION_PILOT_ENV_VAR]);
  if (scope.kind === "platform-diagnostic") return allowed.size > 0;
  return Number.isSafeInteger(scope.businessId) && allowed.has(scope.businessId);
}

/** Business-scoped shorthand used by the services. */
export function isAuthorityProductionAllowedForBusiness(
  businessId: number,
  environment: BillingAuthorityEnvironment,
  env: EnvSource = process.env
): boolean {
  return isAuthorityPilotScopeAllowed({ kind: "business", businessId }, environment, env);
}

/**
 * Thrown by services that signal refusal by exception. The message is the code
 * only — it never names the business or echoes the allowlist.
 */
export class AuthorityProductionPilotError extends Error {
  readonly code = AUTHORITY_PRODUCTION_PILOT_NOT_ENABLED;

  constructor() {
    super(AUTHORITY_PRODUCTION_PILOT_NOT_ENABLED);
    this.name = "AuthorityProductionPilotError";
  }
}

export function assertAuthorityProductionAllowedForBusiness(
  businessId: number,
  environment: BillingAuthorityEnvironment,
  env: EnvSource = process.env
): void {
  if (!isAuthorityProductionAllowedForBusiness(businessId, environment, env)) {
    throw new AuthorityProductionPilotError();
  }
}
