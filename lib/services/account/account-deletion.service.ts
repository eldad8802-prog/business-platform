/**
 * Account deletion — pure orchestrator. Server-only, tenant-safe, fail-closed,
 * idempotent. Enforces the ratified rules (docs/privacy-account-deletion-erasure-design-v1.md):
 *   - SOLE-ACTIVE-USER gate (v1): a business is deletable only when it has exactly one
 *     active user AND that user is the authenticated requester.
 *   - idempotent: re-requesting on an already-deleted business is a no-op success.
 *
 * ORDER (D2/AD-2A — quarantine first, and this ordering IS the security property):
 *
 *   1. QUARANTINE   mark DELETION_REQUESTED. The instant it commits, the business stops
 *                   accepting normal writes everywhere: sessions die (getCurrentUser),
 *                   background jobs are refused (runTenantJob), provider webhooks are
 *                   refused at their tenant boundary, and (SEC-E) every tenant
 *                   transaction refuses it (withTenantTransaction). Nothing destructive
 *                   has happened yet, so a failure here leaves an ACTIVE business and
 *                   the request can simply be retried.
 *   2. THE ERASURE  lib/services/account/erasure-job.ts — durable, resumable stages
 *                   recorded in the erasure ledger: authority revoke, purge, session
 *                   erase, provider revoke, credential destroy, verify, finalize.
 *
 * SEC-E / H-5. Stage 2 used to run inline with no record of progress, and a failure
 * after the quarantine became an HTTP 500 that the owner could never retry (their
 * session died with the quarantine). Now every attempt is claimed and recorded, and a
 * sweeper resumes it. `deleteOwnBusinessAccount` keeps its historical contract — it
 * throws when the erasure did not finish, and calling it again resumes — while
 * `requestAccountDeletion` is what the route uses: a failure after the quarantine is
 * reported as ACCEPTED (202), because the erasure is now owed durably and will finish.
 *
 * Legally-retained fiscal/evidence records are never touched at any stage.
 *
 * The concrete Prisma work lives behind `AccountDeletionStore` (adapter). This module is
 * DB-free so the gate/idempotency/order are unit-testable without a database.
 */
import { assertManifestSafe } from "@/lib/services/account/account-erasure-manifest";
import {
  runAccountErasure,
  type ErasureLedger,
  type ErasureRunResult,
  type ErasureStage,
  type ProviderRevokers,
} from "@/lib/services/account/erasure-job";

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

/**
 * The business IS quarantined and the erasure is durably owed, but this attempt did not
 * finish it (a stage failed, or another worker holds the attempt). Carries no tenant
 * content: the stage and a PII-free error class only.
 */
export class AccountErasureIncompleteError extends Error {
  readonly businessId: number;
  readonly run: ErasureRunResult;
  constructor(businessId: number, run: ErasureRunResult) {
    super(
      `account erasure for business ${businessId} is in progress (${run.status}` +
        ("stage" in run ? ` at ${run.stage}` : "") +
        ")"
    );
    this.name = "AccountErasureIncompleteError";
    this.businessId = businessId;
    this.run = run;
  }
}

/** The lifecycle a deletion moves through. See lib/tenant/business-lifecycle.ts. */
export type BusinessDeletionState = "ACTIVE" | "DELETION_REQUESTED" | "PURGED";

/** A provider credential whose revoke must be attempted before its ciphertext is destroyed. */
export type ProviderGrant = {
  provider: "google" | "meta" | "ita" | "payment";
  action: string;
  connectionId: number;
  /** Plaintext, in memory only; null when absent or undecryptable. */
  token: string | null;
  wabaId: string | null;
};

export interface AccountDeletionStore {
  /** Tenant-scoped read; null if the business doesn't exist. */
  getBusiness(
    businessId: number
  ): Promise<{ id: number; state: BusinessDeletionState } | null>;
  /** Active (non-deleted) user ids for the business. */
  listActiveUserIds(businessId: number): Promise<number[]>;
  /**
   * STAGE 1 — enter DELETION_REQUESTED. Conditional on the business still being
   * ACTIVE, so two concurrent requests cannot both believe they started the deletion.
   * Returns false when another request won the race. Contains NO network call.
   * (The name predates the split of credential destruction into its own stage.)
   */
  quarantineAndRevokeIntegrations(businessId: number, now: Date): Promise<boolean>;
  /** Sessions + token generation of every user, on the auth plane. Idempotent in effect. */
  revokeAccountAuthority(businessId: number, now: Date): Promise<void>;
  /**
   * anonymize (bucket B.1) + delete (bucket B.2) operational PII under an explicit
   * tenant context, objects first. Retains bucket A. Idempotent.
   */
  purgeOperationalData(businessId: number): Promise<void>;
  /** Delete the device-history rows (auth plane). Idempotent. */
  eraseAccountSessions(businessId: number): Promise<void>;
  /** Plaintext provider grants, read BEFORE credential destruction. Read-only. */
  readProviderGrants(businessId: number): Promise<ProviderGrant[]>;
  /** Destroy integration secrets and connection identifiers at rest. Idempotent. */
  destroyIntegrationCredentials(businessId: number, now: Date): Promise<void>;
  /** Post-conditions: residual classes still present (empty = verified). */
  verifyErased(businessId: number): Promise<string[]>;
  /**
   * STAGE 3 — append the erasure evidence, then mark PURGED. If the evidence cannot be
   * written the transition must not commit: a deletion that reports success without
   * durable evidence is worse than one that fails.
   */
  finalizeAndAudit(businessId: number, actorUserId: number, now: Date): Promise<void>;
  /** Businesses whose erasure is owed and not finished (DELETION_REQUESTED), oldest first. */
  listStrandedErasures(limit: number): Promise<number[]>;
  /** The durable record of the erasure (erasure-ledger.prisma.ts). */
  readonly ledger: ErasureLedger;
}

export type DeletionResult = { status: "deleted" | "already_deleted" };

export type DeletionDeps = { providers?: ProviderRevokers; now?: Date };

/**
 * Delete the authenticated user's own business account. `actorUserId` and `businessId`
 * MUST come from the verified session (the caller is responsible for authn); this
 * function additionally enforces the sole-user authorization gate and tenant coherence.
 *
 * Throws `AccountErasureIncompleteError` when the business is quarantined but this
 * attempt did not finish the erasure; calling again resumes (the ledger makes the
 * attempts safe to repeat), and the sweeper resumes it regardless.
 */
export async function deleteOwnBusinessAccount(
  store: AccountDeletionStore,
  args: { businessId: number; actorUserId: number; now?: Date },
  deps: DeletionDeps = {}
): Promise<DeletionResult> {
  const { businessId, actorUserId } = args;
  const now = args.now ?? deps.now ?? new Date();
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

  // REQUEST, recorded durably: who asked. Best-effort — the quarantine above is the
  // durable fact; this only lets a later sweeper attribute the evidence correctly.
  try {
    await store.ledger.recordRequested(businessId, { requestedByUserId: actorUserId, at: now });
  } catch {
    // resolveActor falls back to the business's sole user.
  }

  // STAGE 2. The durable, resumable erasure. A direct call by the requester does not
  // wait out a backoff; the sweeper does.
  const run = await runAccountErasure(store, businessId, {
    trigger: "request",
    now,
    actorUserId,
    providers: deps.providers,
    respectBackoff: false,
  });
  if (run.status === "COMPLETED" || run.status === "ALREADY_PURGED") {
    return { status: "deleted" };
  }
  throw new AccountErasureIncompleteError(businessId, run);
}

export type AccountDeletionRequestResult =
  | { status: "deleted" | "already_deleted" }
  | { status: "accepted"; stage: ErasureStage | null };

/**
 * The route's entry point. Identical to `deleteOwnBusinessAccount`, except that an
 * erasure which is quarantined-and-owed but not yet finished is ACCEPTED rather than
 * thrown: the owner's request has been durably taken, their session is already dead,
 * and the sweeper will complete it. A failure BEFORE the quarantine still throws —
 * then nothing has changed and the owner can retry.
 */
export async function requestAccountDeletion(
  store: AccountDeletionStore,
  args: { businessId: number; actorUserId: number; now?: Date },
  deps: DeletionDeps = {}
): Promise<AccountDeletionRequestResult> {
  try {
    return await deleteOwnBusinessAccount(store, args, deps);
  } catch (error) {
    if (error instanceof AccountErasureIncompleteError) {
      return { status: "accepted", stage: "stage" in error.run ? error.run.stage : null };
    }
    // Anything else after the quarantine committed (the ledger unreachable while
    // claiming, for instance) must not become a 500 either: re-read the lifecycle.
    if (!(error instanceof AccountDeletionError)) {
      const after = await store.getBusiness(args.businessId).catch(() => null);
      if (after && after.state !== "ACTIVE") {
        console.error(
          JSON.stringify({ event: "account_erasure_request_deferred", businessId: args.businessId, error: (error as Error)?.name ?? "Error" })
        );
        return after.state === "PURGED" ? { status: "deleted" } : { status: "accepted", stage: null };
      }
    }
    throw error;
  }
}
