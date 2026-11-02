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
 * the lists, decides WHAT an admitted business may do in PRODUCTION. Values are
 * compared exactly (no trimming, case-sensitive):
 *   - "oauth"             → OAUTH_ONLY (explicit).
 *   - "oauth,submissions" → SUBMISSIONS (explicit).
 *   - unset / ""          → OAUTH_ONLY (closed default).
 *   - anything else       → OAUTH_ONLY (fail closed; reported as invalid).
 * In OAUTH_ONLY only OAuth start + callback (the authorization-code token
 * exchange) are allowed. Token refresh, validation, Approval (incl. the
 * automatic one after issuing), Decision and the platform network probe are
 * refused before any state change, token work or network I/O.
 *
 * Refusal codes (internal — logs, audit, results; never shown to the user):
 *   - AUTHORITY_PRODUCTION_PILOT_NOT_ENABLED     — an allowlist refused it.
 *   - AUTHORITY_PRODUCTION_PILOT_STAGE_OAUTH_ONLY — the lists admit it, the
 *     OAUTH_ONLY stage refuses it.
 * Both take exactly the same provably-not-sent, non-retryable-as-sent path;
 * match them with isAuthorityProductionPilotRefusalCode. The user-facing
 * answer stays uniform (PRODUCTION_PILOT_NOT_ENABLED).
 *
 * Services check resolveAuthorityProductionOperationRefusal; the egress
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

/** Explicit OAuth-only value. Compared exactly. */
export const AUTHORITY_PRODUCTION_PILOT_OAUTH_VALUE = "oauth" as const;

/** The one value that opens PRODUCTION submissions. Compared exactly. */
export const AUTHORITY_PRODUCTION_PILOT_SUBMISSIONS_VALUE = "oauth,submissions" as const;

export type AuthorityProductionPilotStage = "OAUTH_ONLY" | "SUBMISSIONS";

/** Whether the stage switch value was recognised (diagnostics only). */
export type AuthorityPilotOperationsValueStatus = "explicit" | "unset" | "invalid";

/** Parse status of an id allowlist (diagnostics only — never the raw value). */
export type AuthorityPilotListStatus = "unset" | "ok" | "invalid";

/** Refused by an allowlist (business / user / pilot disabled). */
export const AUTHORITY_PRODUCTION_PILOT_NOT_ENABLED =
  "AUTHORITY_PRODUCTION_PILOT_NOT_ENABLED" as const;

/** Admitted by the lists, refused by the OAUTH_ONLY stage. */
export const AUTHORITY_PRODUCTION_PILOT_STAGE_OAUTH_ONLY =
  "AUTHORITY_PRODUCTION_PILOT_STAGE_OAUTH_ONLY" as const;

export type AuthorityProductionPilotRefusalCode =
  | typeof AUTHORITY_PRODUCTION_PILOT_NOT_ENABLED
  | typeof AUTHORITY_PRODUCTION_PILOT_STAGE_OAUTH_ONLY;

/** Every pilot refusal code; all of them are provably not sent. */
export const AUTHORITY_PRODUCTION_PILOT_REFUSAL_CODES: readonly AuthorityProductionPilotRefusalCode[] = [
  AUTHORITY_PRODUCTION_PILOT_NOT_ENABLED,
  AUTHORITY_PRODUCTION_PILOT_STAGE_OAUTH_ONLY,
];

export function isAuthorityProductionPilotRefusalCode(
  code: unknown
): code is AuthorityProductionPilotRefusalCode {
  return (
    code === AUTHORITY_PRODUCTION_PILOT_NOT_ENABLED ||
    code === AUTHORITY_PRODUCTION_PILOT_STAGE_OAUTH_ONLY
  );
}

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
 * Parses an id allowlist with its status. `ids` is empty unless the status is
 * "ok" — never a partial list.
 */
export function parseProductionPilotIdList(raw: string | undefined): {
  status: AuthorityPilotListStatus;
  ids: ReadonlySet<number>;
} {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (trimmed.length === 0) return { status: "unset", ids: new Set() };

  const parts = trimmed.split(",").map((part) => part.trim());
  if (parts.length > AUTHORITY_PRODUCTION_PILOT_MAX_BUSINESSES) {
    return { status: "invalid", ids: new Set() };
  }

  const ids = new Set<number>();
  for (const part of parts) {
    if (!BUSINESS_ID.test(part)) return { status: "invalid", ids: new Set() };
    const id = Number(part);
    if (!Number.isSafeInteger(id)) return { status: "invalid", ids: new Set() };
    ids.add(id);
  }
  return { status: "ok", ids };
}

/**
 * Parses the allowlist. Returns an empty set when unset, empty, malformed, or
 * longer than the maximum — never a partial list.
 */
export function parseProductionPilotBusinessIds(
  raw: string | undefined
): ReadonlySet<number> {
  return parseProductionPilotIdList(raw).ids;
}

/**
 * Parses the user allowlist with the same rules as the business allowlist
 * (empty set when unset, empty, malformed, or over the maximum).
 */
export function parseProductionPilotUserIds(
  raw: string | undefined
): ReadonlySet<number> {
  return parseProductionPilotIdList(raw).ids;
}

export function isAuthorityProductionPilotEnabled(
  env: EnvSource = process.env
): boolean {
  return parseProductionPilotBusinessIds(env[AUTHORITY_PRODUCTION_PILOT_ENV_VAR]).size > 0;
}

/** Stage + whether the value was recognised. Unrecognised → OAUTH_ONLY. */
export function parseAuthorityProductionPilotOperations(raw: string | undefined): {
  stage: AuthorityProductionPilotStage;
  valueStatus: AuthorityPilotOperationsValueStatus;
} {
  if (raw === undefined || raw === "") return { stage: "OAUTH_ONLY", valueStatus: "unset" };
  if (raw === AUTHORITY_PRODUCTION_PILOT_SUBMISSIONS_VALUE) {
    return { stage: "SUBMISSIONS", valueStatus: "explicit" };
  }
  if (raw === AUTHORITY_PRODUCTION_PILOT_OAUTH_VALUE) {
    return { stage: "OAUTH_ONLY", valueStatus: "explicit" };
  }
  return { stage: "OAUTH_ONLY", valueStatus: "invalid" };
}

/** OAUTH_ONLY unless the switch is exactly the enabling value. */
export function resolveAuthorityProductionPilotStage(
  env: EnvSource = process.env
): AuthorityProductionPilotStage {
  return parseAuthorityProductionPilotOperations(env[AUTHORITY_PRODUCTION_PILOT_OPERATIONS_ENV_VAR]).stage;
}

/**
 * Why a scope is refused in this environment, or null when allowed. The
 * allowlist is checked first, so a non-admitted business always reads
 * NOT_ENABLED whatever the stage.
 */
export function resolveAuthorityPilotScopeRefusal(
  scope: AuthorityPilotScope,
  environment: BillingAuthorityEnvironment,
  env: EnvSource = process.env
): AuthorityProductionPilotRefusalCode | null {
  if (environment !== "PRODUCTION") return null;
  const allowed = parseProductionPilotBusinessIds(env[AUTHORITY_PRODUCTION_PILOT_ENV_VAR]);
  const listed =
    scope.kind === "platform-diagnostic"
      ? allowed.size > 0
      : Number.isSafeInteger(scope.businessId) && allowed.has(scope.businessId);
  if (!listed) return AUTHORITY_PRODUCTION_PILOT_NOT_ENABLED;
  if (scope.kind === "business-oauth") return null;
  return resolveAuthorityProductionPilotStage(env) === "SUBMISSIONS"
    ? null
    : AUTHORITY_PRODUCTION_PILOT_STAGE_OAUTH_ONLY;
}

/** True when the scope may make authority requests in this environment. */
export function isAuthorityPilotScopeAllowed(
  scope: AuthorityPilotScope,
  environment: BillingAuthorityEnvironment,
  env: EnvSource = process.env
): boolean {
  return resolveAuthorityPilotScopeRefusal(scope, environment, env) === null;
}

/**
 * Business allowlist only (no stage). Used by the OAuth start + callback, which
 * OAUTH_ONLY admits; every other operation uses
 * resolveAuthorityProductionOperationRefusal.
 */
export function isAuthorityProductionAllowedForBusiness(
  businessId: number,
  environment: BillingAuthorityEnvironment,
  env: EnvSource = process.env
): boolean {
  return isAuthorityPilotScopeAllowed({ kind: "business-oauth", businessId }, environment, env);
}

/**
 * Actor-scoped check for user-initiated PRODUCTION OAuth (start + callback):
 * the business AND the acting user must both be admitted. SANDBOX is never
 * gated. A refusal here is always an allowlist refusal (NOT_ENABLED).
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

/**
 * Gate for every PRODUCTION authority operation other than the OAuth flow
 * (token refresh, validation, Approval, Decision): null when allowed, else the
 * internal refusal code (allowlist vs OAUTH_ONLY stage). SANDBOX is never gated.
 */
export function resolveAuthorityProductionOperationRefusal(
  businessId: number,
  environment: BillingAuthorityEnvironment,
  env: EnvSource = process.env
): AuthorityProductionPilotRefusalCode | null {
  return resolveAuthorityPilotScopeRefusal({ kind: "business", businessId }, environment, env);
}

export function isAuthorityProductionOperationAllowedForBusiness(
  businessId: number,
  environment: BillingAuthorityEnvironment,
  env: EnvSource = process.env
): boolean {
  return resolveAuthorityProductionOperationRefusal(businessId, environment, env) === null;
}

/** Internal refusal message for a code (no ids, no env values). */
export function describeAuthorityProductionPilotRefusal(
  code: AuthorityProductionPilotRefusalCode
): string {
  return code === AUTHORITY_PRODUCTION_PILOT_STAGE_OAUTH_ONLY
    ? "Authority production pilot is in the OAuth-only stage"
    : "Authority production pilot is not enabled for this business";
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
