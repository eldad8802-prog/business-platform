/**
 * Account deletion — pure orchestrator. Server-only, tenant-safe, fail-closed,
 * idempotent. Enforces the ratified rules (docs/privacy-account-deletion-erasure-design-v1.md):
 *   - SOLE-ACTIVE-USER gate (v1): a business is deletable only when it has exactly one
 *     active user AND that user is the authenticated requester.
 *   - idempotent: re-requesting on an already-deleted business is a no-op success.
 *
 * ORDER (D2/AD-2A — quarantine first, and this ordering IS the security property):
 *
 *   1. QUARANTINE   mark DELETION_REQUESTED and destroy integration credentials at
 *                   rest, in ONE transaction. The instant it commits, the business
 *                   stops accepting normal writes everywhere: sessions die
 *                   (getCurrentUser), background jobs are refused (runTenantJob) and
 *                   provider webhooks are refused at their tenant boundary. Nothing
 *                   destructive has happened yet, so a failure here leaves an ACTIVE
 *                   business and the request can simply be retried.
 *   2. PURGE        anonymize + delete operational PII, under an explicit tenant
 *                   context so the FORCE-RLS'd tables are actually reachable.
 *   3. FINALIZE     mark PURGED and append the erasure evidence, atomically.
 *
 * The previous order did the destructive work FIRST and marked the business LAST,
 * which left the entire erasure window fully authenticated and open to provider and
 * background resurrection.
 *
 * Legally-retained fiscal/evidence records are never touched at any stage.
 *
 * The concrete Prisma work lives behind `AccountDeletionStore` (adapter). This module is
 * DB-free so the gate/idempotency/order are unit-testable without a database.
 */
import { assertManifestSafe } from "@/lib/services/account/account-erasure-manifest";

export type AccountDeletionErrorCode =
  | "business_not_found"
  | "not_sole_user" // more than one active user (or requester isn't the sole user)
  | "invalid_input";

export class AccountDeletionError extends Error {
  readonly code: AccountDeletionErrorCode;
  constructor(code: AccountDeletionErrorCode, message: string) {
    super(message);
    this.name = "AccountDeletionError";
    this.code = code;
  }
}

/** The lifecycle a deletion moves through. See lib/tenant/business-lifecycle.ts. */
export type BusinessDeletionState = "ACTIVE" | "DELETION_REQUESTED" | "PURGED";

export interface AccountDeletionStore {
  /** Tenant-scoped read; null if the business doesn't exist. */
  getBusiness(
    businessId: number
  ): Promise<{ id: number; state: BusinessDeletionState } | null>;
  /** Active (non-deleted) user ids for the business. */
  listActiveUserIds(businessId: number): Promise<number[]>;
  /**
   * STAGE 1 — atomically enter DELETION_REQUESTED and destroy integration
   * credentials at rest (bucket C). Conditional on the business still being ACTIVE,
   * so two concurrent requests cannot both believe they started the deletion.
   * Returns false when another request won the race. Contains NO network call.
   */
  quarantineAndRevokeIntegrations(businessId: number, now: Date): Promise<boolean>;
  /**
   * STAGE 2 — anonymize (bucket B.1) + delete (bucket B.2) operational PII under an
   * explicit tenant context. Retains bucket A. Idempotent: safe to re-run after a
   * partial failure, because every operation is a state-convergent overwrite.
   */
  purgeOperationalData(businessId: number): Promise<void>;
  /**
   * STAGE 3 — mark PURGED and append the erasure evidence in ONE transaction. If the
   * evidence cannot be written the transition must not commit: a deletion that
   * reports success without durable evidence is worse than one that fails.
   */
  finalizeAndAudit(businessId: number, actorUserId: number, now: Date): Promise<void>;
}

export type DeletionResult = { status: "deleted" | "already_deleted" };

/**
 * Delete the authenticated user's own business account. `actorUserId` and `businessId`
 * MUST come from the verified session (the caller is responsible for authn); this
 * function additionally enforces the sole-user authorization gate and tenant coherence.
 */
export async function deleteOwnBusinessAccount(
  store: AccountDeletionStore,
  args: { businessId: number; actorUserId: number; now?: Date }
): Promise<DeletionResult> {
  const { businessId, actorUserId } = args;
  const now = args.now ?? new Date();
  if (!Number.isInteger(businessId) || businessId <= 0) {
    throw new AccountDeletionError("invalid_input", "invalid businessId");
  }
  if (!Number.isInteger(actorUserId) || actorUserId <= 0) {
    throw new AccountDeletionError("invalid_input", "invalid actorUserId");
  }
  // Fail closed at startup if the manifest were ever mis-edited to purge a retained model.
  assertManifestSafe();

  const business = await store.getBusiness(businessId);
  if (!business) {
    throw new AccountDeletionError("business_not_found", "business not found for this session");
  }
  // Idempotent: already finished → no-op success (safe to retry).
  if (business.state === "PURGED") {
    return { status: "already_deleted" };
  }

  // Sole-active-user gate (v1). Fail closed if more than one active user, or if the
  // requester is not that single user. Evaluated only while the business is still
  // ACTIVE: once quarantined the session is dead by design, so a resumed purge must
  // not be blocked by re-checking an authorization that can no longer be satisfied.
  if (business.state === "ACTIVE") {
    const activeUsers = await store.listActiveUserIds(businessId);
    if (activeUsers.length !== 1 || activeUsers[0] !== actorUserId) {
      throw new AccountDeletionError(
        "not_sole_user",
        "account deletion requires being the sole active user of the business"
      );
    }

    // STAGE 1. Quarantine before anything destructive.
    await store.quarantineAndRevokeIntegrations(businessId, now);
  }

  // STAGE 2 + 3. Reaching here with an already-quarantined business means a previous
  // attempt failed mid-purge; both stages are safe to repeat.
  await store.purgeOperationalData(businessId);
  await store.finalizeAndAudit(businessId, actorUserId, now);

  return { status: "deleted" };
}
