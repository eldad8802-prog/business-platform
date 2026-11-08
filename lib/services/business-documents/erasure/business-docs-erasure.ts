/**
 * Business documents — account erasure of the business-documents tables and their stored objects. SERVER-ONLY.
 *
 * Connected to account deletion (lib/services/account/account-deletion.prisma-store.ts + account-storage-erasure.ts):
 *
 *   1. business_documents_erase() — called by the account-deletion adapter INSIDE the purge transaction, in the erased
 *      business's tenant context (the function checks the context and that the business is being deleted): writes the
 *      durable job row, marks every file DELETING (the rows keep the object keys — the only place they exist), deletes
 *      every record. A failed purge rolls all of it back: no job, no lost key, no object touched.
 *   2. continueBusinessDocumentsErasure() — only AFTER that transaction committed (the post-commit object stage, and
 *      the sweep that resumes it): fence every DELETING file (delete + create-once marker; a late upload can then
 *      never land), then business_documents_erasure_complete() — true only when every file is FENCED; then the file
 *      rows go and the job is DONE. Until then the job stays open for the next run. Safe to repeat and to run twice at
 *      once.
 *
 * runBusinessDocumentsErasure() — steps 1 + 2 in one call — is kept for the labs that exercise the runner directly.
 */
import { getStorageService, type StorageService } from "@/lib/storage";

import { bdTx } from "../bd-tx";
import { fenceAllDeleting, reapExpiredPending } from "../files/business-docs-files";

export type ErasureRun = { markedFiles: number; fenced: number; pending: number; done: boolean };

export async function runBusinessDocumentsErasure(businessId: number, storage: StorageService = getStorageService()): Promise<ErasureRun> {
  const marked = await bdTx(businessId, async (tx) => {
    const open = await tx.businessDocumentErasure.findUnique({ where: { businessId }, select: { state: true } });
    if (open?.state === "DONE") return -1;
    if (open) return 0;
    const r = await tx.$queryRaw<{ n: number }[]>`SELECT public.business_documents_erase() AS n`;
    return Number(r[0]?.n ?? 0);
  });
  if (marked < 0) return { markedFiles: 0, fenced: 0, pending: 0, done: true };
  await reapExpiredPending(businessId);
  const { fenced, pending } = await fenceAllDeleting(businessId, storage);
  const done = await bdTx(businessId, async (tx) => {
    const r = await tx.$queryRaw<{ done: boolean }[]>`SELECT public.business_documents_erasure_complete() AS done`;
    return r[0]?.done === true;
  });
  return { markedFiles: marked, fenced, pending, done };
}

export type ErasureProgress = {
  /** NO_JOB: the purge transaction has not committed for this business (or it was erased before this was wired). */
  state: "NO_JOB" | "PURGING_OBJECTS" | "DONE";
  fenced: number;
  pending: number;
  /** Nothing of this module is left to do for the business (now). */
  done: boolean;
};

/**
 * The object stage of an erasure whose purge transaction has committed. Never creates the job: only the purge
 * transaction does that, so this can never run ahead of the database. Storage failures leave files DELETING (the
 * job open) and return done=false; database failures throw — the caller records them and the sweep retries.
 */
export async function continueBusinessDocumentsErasure(businessId: number, storage: StorageService = getStorageService()): Promise<ErasureProgress> {
  const state = await bdTx(businessId, async (tx) =>
    (await tx.businessDocumentErasure.findUnique({ where: { businessId }, select: { state: true } }))?.state ?? null
  );
  if (state !== "PURGING_OBJECTS") return { state: state ?? "NO_JOB", fenced: 0, pending: 0, done: true };
  const { fenced, pending } = await fenceAllDeleting(businessId, storage);
  // Always try to complete, whatever this run's own count says: with two runs at once (the post-commit stage and a
  // sweep), each finds some files already fenced by the other and counts them as not its own — trusting that count
  // would leave a fully fenced job open. The completion itself refuses (false) while any file is not FENCED, and the
  // erasure's advisory lock makes the second run wait and then find the job DONE instead of failing on it.
  const done = await bdTx(businessId, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('business_documents_erasure'), ${businessId}::int)`;
    const job = await tx.businessDocumentErasure.findUnique({ where: { businessId }, select: { state: true } });
    if (job?.state !== "PURGING_OBJECTS") return job?.state === "DONE";
    const r = await tx.$queryRaw<{ done: boolean }[]>`SELECT public.business_documents_erasure_complete() AS done`;
    return r[0]?.done === true;
  });
  return { state: done ? "DONE" : "PURGING_OBJECTS", fenced, pending: done ? 0 : pending, done };
}
