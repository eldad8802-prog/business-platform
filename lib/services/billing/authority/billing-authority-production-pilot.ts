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
 *   - The env vars are read on every check — there is no cache to go stale.
 *
 * Actor gate: STARTING (and completing) a PRODUCTION OAuth connection is a
 * user action, so it additionally requires the acting user to be listed in
 * BILLING_AUTHORITY_PRODUCTION_PILOT_USER_IDS (see
 * isAuthorityProductionAllowedForActor). Same rules: off by default, fail
 * closed, SANDBOX not affected. Work that runs for the business without a
 * user in the loop (egress, refresh, validation, Approval, Decision) does not
 * look at the user list.
 *
 * Value format (both lists): comma-separated positive integer ids, e.g. "42" or
 * "42,57". At most AUTHORITY_PRODUCTION_PILOT_MAX_BUSINESSES entries.
 *
 * Stage switch: BILLING_AUTHORITY_PRODUCTION_PILOT_OPERATIONS, independent of
 * the lists, decides WHAT an admitted business may do in PRODUCTION:
 *   - OAUTH_ONLY (default): only OAuth start + callback (the authorization-code
 *     token exchange). Token refresh, validation, Approval (incl. the automatic
 *     one after issuing), Decision and the platform network probe are refused
 *     before any state change, token work or network I/O, with the same
 *     AUTHORITY_PRODUCTION_PILOT_NOT_ENABLED code a non-pilot business gets —
 *     so they take the same provably-not-sent path.
 *   - SUBMISSIONS: only when the value is EXACTLY "oauth,submissions" (no
 *     trimming, case-sensitive). Anything else — unset, empty, "oauth",
 *     "OAUTH,SUBMISSIONS", " oauth,submissions" — is OAUTH_ONLY.
 * Services check isAuthorityProductionOperationAllowedForBusiness; the egress
 * transport enforces the stage too — in OAUTH_ONLY only the "business-oauth"
 * scope (used by the code exchange alone) reaches the network.
 */

import type { BillingAuthorityEnvironment } from "@prisma/client";

export const AUTHORITY_PRODUCTION_PILOT_ENV_VAR =
  "BILLING_AUTHORITY_PRODUCTION_PILOT_BUSINESS_IDS" as const;

export const AUTHORITY_PRODUCTION_PILOT_USER_ENV_VAR =
  "BILLING_AUTHORITY_PRODUCTION_PILOT_USER_IDS" as const;

export const AUTHORITY_PRODUCTION_PILOT_OPERATIONS_ENV_VAR =
  "BILLING_AUTHORITY_PRODUCTION_PILOT_OPERATIONS" as const;

/** The one value that opens PRODUCTION submissions. Compared exactly. */
export const AUTHORITY_PRODUCTION_PILOT_SUBMISSIONS_VALUE = "oauth,submissions" as const;

export type AuthorityProductionPilotStage = "OAUTH_ONLY" | "SUBMISSIONS";

export const AUTHORITY_PRODUCTION_PILOT_NOT_ENABLED =
  "AUTHORITY_PRODUCTION_PILOT_NOT_ENABLED" as const;

export const AUTHORITY_PRODUCTION_PILOT_MAX_BUSINESSES = 20;

/** Who a PRODUCTION authority request is made for. */
export type AuthorityPilotScope =
  /**
   * Business work after connecting (refresh, validation, Approval, Decision).
   * In PRODUCTION: admitted business AND SUBMISSIONS stage.
   */
  | { kind: "business"; businessId: number }
  /**
   * The OAuth authorization-code token exchange ONLY. In PRODUCTION: admitted
   * business, in any stage (OAUTH_ONLY exists to allow exactly this).
   */
  | { kind: "business-oauth"; businessId: number }
  /**
   * The admin-only, credential-less network probe: no business, no token, no
   * business data. Allowed in PRODUCTION only while the pilot is enabled AND
   * the stage is SUBMISSIONS.
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
  const submissions = resolveAuthorityProductionPilotStage(env) === "SUBMISSIONS";
  if (scope.kind === "platform-diagnostic") return allowed.size > 0 && submissions;
  const admitted = Number.isSafeInteger(scope.businessId) && allowed.has(scope.businessId);
  if (scope.kind === "business-oauth") return admitted;
  return admitted && submissions;
}

/**
 * Business allowlist only (no stage). Used by the OAuth start + callback, which
 * OAUTH_ONLY admits; every other operation uses
 * isAuthorityProductionOperationAllowedForBusiness.
 */
export function isAuthorityProductionAllowedForBusiness(
  businessId: number,
  environment: BillingAuthorityEnvironment,
  env: EnvSource = process.env
): boolean {
  return isAuthorityPilotScopeAllowed({ kind: "business-oauth", businessId }, environment, env);
}

/**
 * Parses the user allowlist with the same rules as the business allowlist
 * (empty set when unset, empty, malformed, or over the maximum).
 */
export function parseProductionPilotUserIds(
  raw: string | undefined
): ReadonlySet<number> {
  return parseProductionPilotBusinessIds(raw);
}

/**
 * Actor-scoped check for user-initiated PRODUCTION OAuth (start + callback):
 * the business AND the acting user must both be admitted. SANDBOX is never
 * gated.
 */
export function isAuthorityProductionAllowedForActor(
  businessId: number,
  userId: number,
  environment: BillingAuthorityEnvironment,
  env: EnvSource = process.env
): boolean {
  if (environment !== "PRODUCTION") return true;
  if (!isAuthorityProductionAllowedForBusiness(businessId, environment, env)) return false;
  const users = parseProductionPilotUserIds(env[AUTHORITY_PRODUCTION_PILOT_USER_ENV_VAR]);
  return Number.isSafeInteger(userId) && users.has(userId);
}

/** OAUTH_ONLY unless the switch is exactly the enabling value. */
export function resolveAuthorityProductionPilotStage(
  env: EnvSource = process.env
): AuthorityProductionPilotStage {
  return env[AUTHORITY_PRODUCTION_PILOT_OPERATIONS_ENV_VAR] ===
    AUTHORITY_PRODUCTION_PILOT_SUBMISSIONS_VALUE
    ? "SUBMISSIONS"
    : "OAUTH_ONLY";
}

/**
 * Gate for every PRODUCTION authority operation other than the OAuth flow
 * (token refresh, validation, Approval, Decision): the business must be
 * admitted AND the stage must be SUBMISSIONS. SANDBOX is never gated.
 */
export function isAuthorityProductionOperationAllowedForBusiness(
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
