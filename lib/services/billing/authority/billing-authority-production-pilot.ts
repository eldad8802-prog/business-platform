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
 * Operations switch: BILLING_AUTHORITY_PRODUCTION_PILOT_OPERATIONS, independent
 * of the lists, decides WHAT an admitted business may do in PRODUCTION. Compared
 * exactly (no trimming, case-sensitive), as a comma-separated set:
 *   - "oauth"             → OAUTH_ONLY (explicit): no operation beyond OAuth.
 *   - "oauth,submissions" → SUBMISSIONS (explicit): all five operations.
 *   - "oauth" plus any of "refresh", "validation", "approval", "decision",
 *     "probe" (any order, each once) → SELECTED: exactly those operations,
 *     e.g. "oauth,refresh,approval".
 *   - unset / ""          → OAUTH_ONLY (closed default).
 *   - anything else       → OAUTH_ONLY (fail closed; reported as invalid) —
 *     an unknown or repeated token, a missing "oauth", whitespace, or
 *     "submissions" combined with another token.
 * OAuth start + callback (the authorization-code token exchange) are allowed in
 * every stage. Any operation not in the set — token refresh, validation,
 * Approval (incl. the automatic one after issuing), Decision, the platform
 * network probe — is refused before any state change, token work or network I/O.
 * Note: Approval and Decision refresh an expiring token first; without "refresh"
 * that refresh is refused and the request is not sent (fail closed).
 *
 * Refusal codes (internal — logs, audit, results; never shown to the user):
 *   - AUTHORITY_PRODUCTION_PILOT_NOT_ENABLED     — an allowlist refused it.
 *   - AUTHORITY_PRODUCTION_PILOT_STAGE_OAUTH_ONLY — the lists admit it, the
 *     OAUTH_ONLY stage refuses it (no operation is enabled).
 *   - AUTHORITY_PRODUCTION_PILOT_OPERATION_NOT_ENABLED — the lists admit it,
 *     some operations are enabled, but not this one.
 * Both take exactly the same provably-not-sent, non-retryable-as-sent path;
 * match them with isAuthorityProductionPilotRefusalCode. The user-facing
 * answer stays uniform (PRODUCTION_PILOT_NOT_ENABLED).
 *
 * Services check resolveAuthorityProductionOperationRefusal(..., operation); the
 * egress transport enforces the same set per scope: a "business" scope names its
 * operation, and only an enabled one (or the "business-oauth" code exchange)
 * reaches the network.
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

/** The value that opens every PRODUCTION operation. Compared exactly. */
export const AUTHORITY_PRODUCTION_PILOT_SUBMISSIONS_VALUE = "oauth,submissions" as const;

/** Every PRODUCTION authority operation beyond OAuth, each separately enabled. */
export const AUTHORITY_PILOT_OPERATIONS = ["refresh", "validation", "approval", "decision", "probe"] as const;

export type AuthorityPilotOperation = (typeof AUTHORITY_PILOT_OPERATIONS)[number];

/** Operations that run for a business (the probe is platform-level). */
export type AuthorityPilotBusinessOperation = Exclude<AuthorityPilotOperation, "probe">;

/**
 * OAUTH_ONLY: no operation enabled. SUBMISSIONS: all of them. SELECTED: an
 * explicit subset (e.g. "oauth,refresh,approval").
 */
export type AuthorityProductionPilotStage = "OAUTH_ONLY" | "SUBMISSIONS" | "SELECTED";

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

/** Admitted by the lists; some operations are enabled, but not this one. */
export const AUTHORITY_PRODUCTION_PILOT_OPERATION_NOT_ENABLED =
  "AUTHORITY_PRODUCTION_PILOT_OPERATION_NOT_ENABLED" as const;

export type AuthorityProductionPilotRefusalCode =
  | typeof AUTHORITY_PRODUCTION_PILOT_NOT_ENABLED
  | typeof AUTHORITY_PRODUCTION_PILOT_STAGE_OAUTH_ONLY
  | typeof AUTHORITY_PRODUCTION_PILOT_OPERATION_NOT_ENABLED;

/** Every pilot refusal code; all of them are provably not sent. */
export const AUTHORITY_PRODUCTION_PILOT_REFUSAL_CODES: readonly AuthorityProductionPilotRefusalCode[] = [
  AUTHORITY_PRODUCTION_PILOT_NOT_ENABLED,
  AUTHORITY_PRODUCTION_PILOT_STAGE_OAUTH_ONLY,
  AUTHORITY_PRODUCTION_PILOT_OPERATION_NOT_ENABLED,
];

export function isAuthorityProductionPilotRefusalCode(
  code: unknown
): code is AuthorityProductionPilotRefusalCode {
  return (AUTHORITY_PRODUCTION_PILOT_REFUSAL_CODES as readonly unknown[]).includes(code);
}

export const AUTHORITY_PRODUCTION_PILOT_MAX_BUSINESSES = 20;

/** Who a PRODUCTION authority request is made for. */
export type AuthorityPilotScope =
  /**
   * Business work after connecting, naming the operation (refresh, validation,
   * Approval, Decision). In PRODUCTION: admitted business AND that operation
   * enabled.
   */
  | { kind: "business"; businessId: number; operation: AuthorityPilotBusinessOperation }
  /**
   * The OAuth authorization-code token exchange ONLY. In PRODUCTION: admitted
   * business, in any stage (OAUTH_ONLY exists to allow exactly this).
   */
  | { kind: "business-oauth"; businessId: number }
  /**
   * The admin-only, credential-less network probe: no business, no token, no
   * business data. Allowed in PRODUCTION only while the pilot is enabled AND
   * the "probe" operation is enabled.
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

const NO_OPERATIONS: ReadonlySet<AuthorityPilotOperation> = new Set();

/**
 * Stage, enabled operations and whether the value was recognised. Anything
 * unrecognised enables nothing (OAUTH_ONLY) — never a partial set.
 */
export function parseAuthorityProductionPilotOperations(raw: string | undefined): {
  stage: AuthorityProductionPilotStage;
  valueStatus: AuthorityPilotOperationsValueStatus;
  operations: ReadonlySet<AuthorityPilotOperation>;
} {
  const closed = (valueStatus: AuthorityPilotOperationsValueStatus) =>
    ({ stage: "OAUTH_ONLY" as const, valueStatus, operations: NO_OPERATIONS });
  if (raw === undefined || raw === "") return closed("unset");
  if (raw === AUTHORITY_PRODUCTION_PILOT_SUBMISSIONS_VALUE) {
    return { stage: "SUBMISSIONS", valueStatus: "explicit", operations: new Set(AUTHORITY_PILOT_OPERATIONS) };
  }
  if (raw === AUTHORITY_PRODUCTION_PILOT_OAUTH_VALUE) return closed("explicit");
  const tokens = raw.split(",");
  if (!tokens.includes(AUTHORITY_PRODUCTION_PILOT_OAUTH_VALUE)) return closed("invalid");
  if (new Set(tokens).size !== tokens.length) return closed("invalid");
  const operations = new Set<AuthorityPilotOperation>();
  for (const token of tokens) {
    if (token === AUTHORITY_PRODUCTION_PILOT_OAUTH_VALUE) continue;
    if (!(AUTHORITY_PILOT_OPERATIONS as readonly string[]).includes(token)) return closed("invalid");
    operations.add(token as AuthorityPilotOperation);
  }
  const stage = operations.size === AUTHORITY_PILOT_OPERATIONS.length ? "SUBMISSIONS" : "SELECTED";
  return { stage, valueStatus: "explicit", operations };
}

/** OAUTH_ONLY unless the switch is a recognised value that enables operations. */
export function resolveAuthorityProductionPilotStage(
  env: EnvSource = process.env
): AuthorityProductionPilotStage {
  return parseAuthorityProductionPilotOperations(env[AUTHORITY_PRODUCTION_PILOT_OPERATIONS_ENV_VAR]).stage;
}

/** The operations the switch enables (empty when OAUTH_ONLY / unset / invalid). */
export function resolveAuthorityProductionPilotOperations(
  env: EnvSource = process.env
): ReadonlySet<AuthorityPilotOperation> {
  return parseAuthorityProductionPilotOperations(env[AUTHORITY_PRODUCTION_PILOT_OPERATIONS_ENV_VAR]).operations;
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
  const operation: AuthorityPilotOperation =
    scope.kind === "platform-diagnostic" ? "probe" : scope.operation;
  const enabled = resolveAuthorityProductionPilotOperations(env);
  if (enabled.has(operation)) return null;
  return enabled.size === 0
    ? AUTHORITY_PRODUCTION_PILOT_STAGE_OAUTH_ONLY
    : AUTHORITY_PRODUCTION_PILOT_OPERATION_NOT_ENABLED;
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
 * Gate for one PRODUCTION authority operation other than the OAuth flow (token
 * refresh, validation, Approval, Decision): null when allowed, else the internal
 * refusal code (allowlist / OAUTH_ONLY stage / operation not enabled). The
 * operation is required — every caller names what it is about to do. SANDBOX is
 * never gated.
 */
export function resolveAuthorityProductionOperationRefusal(
  businessId: number,
  environment: BillingAuthorityEnvironment,
  operation: AuthorityPilotBusinessOperation,
  env: EnvSource = process.env
): AuthorityProductionPilotRefusalCode | null {
  return resolveAuthorityPilotScopeRefusal({ kind: "business", businessId, operation }, environment, env);
}

export function isAuthorityProductionOperationAllowedForBusiness(
  businessId: number,
  environment: BillingAuthorityEnvironment,
  operation: AuthorityPilotBusinessOperation,
  env: EnvSource = process.env
): boolean {
  return resolveAuthorityProductionOperationRefusal(businessId, environment, operation, env) === null;
}

/** Internal refusal message for a code (no ids, no env values). */
export function describeAuthorityProductionPilotRefusal(
  code: AuthorityProductionPilotRefusalCode
): string {
  if (code === AUTHORITY_PRODUCTION_PILOT_STAGE_OAUTH_ONLY) return "Authority production pilot is in the OAuth-only stage";
  if (code === AUTHORITY_PRODUCTION_PILOT_OPERATION_NOT_ENABLED) {
    return "Authority production pilot does not enable this operation";
  }
  return "Authority production pilot is not enabled for this business";
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
