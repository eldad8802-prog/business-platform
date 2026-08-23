/**
 * Account deletion — pure orchestrator (Wave 1B). Server-only, tenant-safe, fail-closed,
 * idempotent. Enforces the ratified rules (docs/privacy-account-deletion-erasure-design-v1.md):
 *   - SOLE-ACTIVE-USER gate (v1): a business is deletable only when it has exactly one
 *     active user AND that user is the authenticated requester.
 *   - idempotent: re-requesting on an already-deleted business is a no-op success.
 *   - ORDER: revoke integrations → anonymize/purge operational PII → mark business
 *     deleted → write erasure audit. Legally-retained fiscal/evidence records untouched.
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

export interface AccountDeletionStore {
  /** Tenant-scoped read; null if the business doesn't exist. */
  getBusiness(businessId: number): Promise<{ id: number; deletedAt: Date | null } | null>;
  /** Active (non-deleted) user ids for the business. */
  listActiveUserIds(businessId: number): Promise<number[]>;
  /** Revoke + clear all integration credentials (bucket C). Best-effort provider revoke. */
  revokeIntegrations(businessId: number): Promise<void>;
  /** Anonymize (bucket B.1) + delete (bucket B.2) operational PII. Retains bucket A. */
  anonymizeAndPurgeOperationalData(businessId: number): Promise<void>;
  /** Mark the tenant closed: deletedAt/archivedAt/archivedByUserId. */
  markBusinessDeleted(businessId: number, actorUserId: number, now: Date): Promise<void>;
  /** Append-only erasure audit entry (categories/when/by whom — never erased content). */
  writeErasureAudit(businessId: number, actorUserId: number, now: Date): Promise<void>;
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
  // Idempotent: already closed → no-op success (safe to retry).
  if (business.deletedAt) {
    return { status: "already_deleted" };
  }

  // Sole-active-user gate (v1). Fail closed if more than one active user, or if the
  // requester is not that single user.
  const activeUsers = await store.listActiveUserIds(businessId);
  if (activeUsers.length !== 1 || activeUsers[0] !== actorUserId) {
    throw new AccountDeletionError(
      "not_sole_user",
      "account deletion requires being the sole active user of the business"
    );
  }

  // Ordered erasure. Retained fiscal/evidence records are never touched.
  await store.revokeIntegrations(businessId);
  await store.anonymizeAndPurgeOperationalData(businessId);
  await store.markBusinessDeleted(businessId, actorUserId, now);
  await store.writeErasureAudit(businessId, actorUserId, now);

  return { status: "deleted" };
}
