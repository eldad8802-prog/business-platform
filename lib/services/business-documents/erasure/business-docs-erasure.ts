/**
 * Business documents — account erasure of the business-documents tables and their stored objects. SERVER-ONLY.
 *
 * BUILT AND TESTED, NOT CONNECTED: wiring this into the account deletion flow is not approved yet (owner, 2026-11-06).
 * Nothing in the product calls it; the proposed integration is described separately for approval.
 *
 *   1. business_documents_erase() — in the erased business's tenant transaction (the function checks the context and
 *      that the business is being deleted): writes the durable job row, marks every file DELETING, deletes every record.
 *   2. fence every DELETING file (delete + create-once marker; a late upload can then never land).
 *   3. business_documents_erasure_complete() — true only when every file is FENCED; then the file rows go and the job
 *      is DONE. Until then it returns false and the job stays open for the next run.
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
