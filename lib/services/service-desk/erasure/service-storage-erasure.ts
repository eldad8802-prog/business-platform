/**
 * Service Desk 1.3-0 — the object stage of an account erasure. SERVER-ONLY.
 *
 * Joins the shared post-commit stage (lib/services/account/account-storage-erasure.ts) as module "service-desk":
 *
 *   1. IN THE PURGE TRANSACTION (account-deletion.prisma-store.ts): service_desk_ui_erase_business() scrubs the 1.3-0
 *      rows in place and opens the durable job (ServiceStorageErasure, PENDING_OBJECTS). A rolled-back purge leaves no
 *      job, and nothing here runs without one.
 *   2. AFTER COMMIT (this module), three separate things, in this order:
 *        a. DELETE   — list biz/{id}/service/ (trailing slash: never another business) and delete every object.
 *        b. VERIFY   — list the prefix AGAIN after the pass; `remaining` is that fresh count, never this pass's own sum.
 *        c. RECORD   — service_storage_erasure_record_pass(deleted, remaining, error) in the business's tenant context.
 *                      The database closes the job (DONE, final) only when remaining = 0, there was no error AND the
 *                      deletion was requested at least one hour ago — an upload already in flight at quarantine is
 *                      caught by a later pass. Until then the job stays PENDING_OBJECTS and the sweep comes back.
 *      So the post-commit pass right after deletion deletes the objects but cannot close the job (the hour has not
 *      passed): closing is the sweep's job, by design of the applied migration.
 *
 * Safe to repeat and to run twice at once: deletes are idempotent in both storage adapters, record_pass serialises on
 * the job row (FOR UPDATE) and a DONE job is never reopened. New writes for a business being deleted are refused by
 * the tables' own guards (DZU02) and the domain accepts create-once writes only.
 *
 * PRIVACY: lastError is a FIXED code from SERVICE_ERASURE_ERROR_CODES — never an exception message, a key or a path.
 */
import { getStorageService, type StorageService } from "@/lib/storage";
import { tenantTx } from "@/lib/tenant/tenant-tx";

import { isServiceKeyOfBusiness, serviceBusinessPrefix } from "../storage/service-storage-keys";

/** The only values this module ever writes to ServiceStorageErasure.lastError. */
export const SERVICE_ERASURE_ERROR_CODES = ["LIST_FAILED", "DELETE_FAILED", "VERIFY_FAILED", "FOREIGN_KEY_LISTED"] as const;
export type ServiceErasureErrorCode = (typeof SERVICE_ERASURE_ERROR_CODES)[number];

/** A job still open after this many passes, or this long after it started, is reported as stuck (log only). */
export const SERVICE_ERASURE_STUCK_ATTEMPTS = 24;
export const SERVICE_ERASURE_STUCK_HOURS = 48;

export type ServiceErasureProgress = {
  /** NO_JOB: the purge transaction has not committed for this business (or it was erased before 1.3-0 existed). */
  state: "NO_JOB" | "PENDING_OBJECTS" | "DONE";
  deleted: number;
  remaining: number;
  error: ServiceErasureErrorCode | null;
  /** Nothing of this module is left to do for the business. */
  done: boolean;
};

type JobRow = { state: string; attempts: number; startedAt: Date };

export function isStuck(job: { attempts: number; startedAt: Date }, now: Date): boolean {
  return job.attempts >= SERVICE_ERASURE_STUCK_ATTEMPTS
    || now.getTime() - job.startedAt.getTime() >= SERVICE_ERASURE_STUCK_HOURS * 3_600_000;
}

/**
 * One pass for a business whose purge transaction committed. Never creates the job. Storage failures are recorded as
 * a code on the job (which stays open); database failures throw — the shared stage records them and the sweep retries.
 */
export async function continueServiceStorageErasure(
  businessId: number,
  storage: StorageService = getStorageService(),
  now: () => Date = () => new Date()
): Promise<ServiceErasureProgress> {
  const prefix = serviceBusinessPrefix(businessId);
  const job = await tenantTx(businessId, async (tx) => {
    const rows = await tx.$queryRaw<JobRow[]>`
      SELECT "state"::text AS state, "attempts" AS attempts, "startedAt" AS "startedAt"
        FROM "ServiceStorageErasure" WHERE "businessId" = ${businessId}::int`;
    return rows[0] ?? null;
  });
  if (!job) return { state: "NO_JOB", deleted: 0, remaining: 0, error: null, done: true };
  if (job.state === "DONE") return { state: "DONE", deleted: 0, remaining: 0, error: null, done: true };

  // a. DELETE
  let error: ServiceErasureErrorCode | null = null;
  let deleted = 0;
  let listed: { key: string }[] = [];
  try {
    listed = await storage.listObjects(prefix);
  } catch {
    error = "LIST_FAILED";
  }
  for (const object of listed) {
    if (!isServiceKeyOfBusiness(object.key, businessId)) {
      // Never delete what is not this business's: a listing that returns a foreign key is a storage fault.
      error ??= "FOREIGN_KEY_LISTED";
      continue;
    }
    try {
      await storage.deleteObject(object.key);
      deleted++;
    } catch {
      error ??= "DELETE_FAILED";
    }
  }

  // b. VERIFY — a fresh listing after the pass.
  let remaining: number;
  try {
    remaining = (await storage.listObjects(prefix)).length;
  } catch {
    error ??= "VERIFY_FAILED";
    remaining = Math.max(listed.length - deleted, 0);
  }

  // c. RECORD — the database decides DONE (remaining 0, no error, quarantine ≥ 1 hour).
  const state = await tenantTx(businessId, async (tx) => {
    const rows = await tx.$queryRaw<{ state: string }[]>`
      SELECT public.service_storage_erasure_record_pass(${deleted}::int, ${remaining}::int, ${error}::text) AS state`;
    return rows[0]?.state === "DONE" ? "DONE" : "PENDING_OBJECTS";
  });

  if (state !== "DONE" && isStuck({ attempts: job.attempts + 1, startedAt: job.startedAt }, now())) {
    // Monitoring without a new alert system: one structured line, ids and codes only.
    console.warn("[service-storage-erasure] job still open", { businessId, attempts: job.attempts + 1, remaining, error });
  }
  return { state, deleted, remaining, error, done: state === "DONE" };
}
