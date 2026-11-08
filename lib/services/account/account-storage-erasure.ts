/**
 * Account deletion — the post-commit object stage. SERVER-ONLY.
 *
 * Stored objects (bytes in object storage) are not transactional with PostgreSQL. A module whose objects must go with
 * the account follows ONE pattern, so that a failure anywhere loses nothing and a retry is always safe:
 *
 *   1. DURABLE JOB, IN THE PURGE TRANSACTION. The module's SECURITY DEFINER erase function, called by the adapter in
 *      the same transaction as the rest of the purge, records the job and keeps every object key it will need
 *      (business documents: business_documents_erase() — the job row, and every file DELETING with its key). If the
 *      purge rolls back, so does the job; nothing was deleted from storage.
 *   2. OBJECTS ONLY AFTER COMMIT. This stage runs once the purge (and the terminal transition) committed. It deletes the
 *      objects and closes the job only when storage confirms it. It never throws: a module that cannot finish now
 *      keeps its job open, and the account deletion still reports success — the database erasure is done, and what is
 *      left is a durable, tracked job.
 *   3. RESUME. `sweepAccountStorageErasures` runs the same stage for every business being or already deleted, until
 *      each module's job is done. Every module's `resume` is idempotent and safe to run concurrently with itself.
 *      NOT SCHEDULED YET: the route that would run it on a cron needs the shared cron authority, whose caller registry
 *      sits under the protected billing paths — that is the owner's decision. Until then an open job stays open (its
 *      keys durable, nothing lost) and the sweep can be run deliberately.
 *
 * New uploads while the account is being deleted are refused by each module's own database guard (business documents:
 * any insert or commit once Business.deletionRequestedAt / deletedAt is set or a job exists); an upload already in
 * flight is closed by the fence (its object is deleted, or its late create-once put is refused by the marker).
 *
 * A module joins by adding one entry to ACCOUNT_STORAGE_ERASURES (Service Desk 1.3-0's ServiceStorageErasure is
 * designed for the same stage — service_desk_ui_erase_business() in the purge transaction, objects after commit).
 */
import { prisma } from "@/lib/prisma";
import { continueBusinessDocumentsErasure } from "@/lib/services/business-documents/erasure/business-docs-erasure";

export type StorageErasureModule = {
  module: string;
  /** Idempotent; never creates the module's job (only the purge transaction does). */
  resume: (businessId: number) => Promise<{ done: boolean }>;
};

export const ACCOUNT_STORAGE_ERASURES: readonly StorageErasureModule[] = [
  { module: "business-documents", resume: (businessId) => continueBusinessDocumentsErasure(businessId) },
];

export type StorageErasureOutcome = { module: string; done: boolean; error?: string };

/** Run every module's object stage for one business. Never throws; a failure is an outcome with done=false. */
export async function runAccountStorageErasure(
  businessId: number,
  modules: readonly StorageErasureModule[] = ACCOUNT_STORAGE_ERASURES
): Promise<StorageErasureOutcome[]> {
  const out: StorageErasureOutcome[] = [];
  for (const m of modules) {
    try {
      const r = await m.resume(businessId);
      out.push({ module: m.module, done: r.done === true });
    } catch (error) {
      const name = error instanceof Error ? error.name : "unknown";
      console.error("[account-storage-erasure] module failed", { module: m.module, businessId, error: name });
      out.push({ module: m.module, done: false, error: name });
    }
  }
  return out;
}

export type StorageErasureSweepSummary = { businesses: number; open: number; errors: number; notReached: number };

/**
 * Resume the object stage for every business being or already deleted. `Business` carries no RLS; each module enters
 * the business's own tenant context itself. Bounded by a time budget: businesses not reached are counted and come
 * first next time only by id order, which is fine at this volume (deleted businesses are few).
 */
export async function sweepAccountStorageErasures(options: {
  budgetMs?: number;
  clock?: () => number;
  modules?: readonly StorageErasureModule[];
} = {}): Promise<StorageErasureSweepSummary> {
  const clock = options.clock ?? Date.now;
  const deadline = clock() + (options.budgetMs ?? 45_000);
  const businesses = await prisma.business.findMany({
    where: { OR: [{ deletionRequestedAt: { not: null } }, { deletedAt: { not: null } }] },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  const summary: StorageErasureSweepSummary = { businesses: businesses.length, open: 0, errors: 0, notReached: 0 };
  for (const [i, { id }] of businesses.entries()) {
    if (clock() >= deadline) {
      summary.notReached = businesses.length - i;
      break;
    }
    const outcomes = await runAccountStorageErasure(id, options.modules);
    if (outcomes.some((o) => !o.done)) summary.open++;
    if (outcomes.some((o) => o.error)) summary.errors++;
  }
  return summary;
}
