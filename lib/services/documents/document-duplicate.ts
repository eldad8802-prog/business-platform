/**
 * "Does this business already hold these exact bytes?" — asked once, for every
 * intake path.
 *
 * # Two identities that are easy to confuse, and must not be
 *
 *   CHANNEL identity   have we already processed this external event?
 *                      A Gmail message+attachment, a WhatsApp wamid. Owned by
 *                      the channel's own import table, and NOT this module's
 *                      business.
 *
 *   CONTENT identity   does this business already have a non-failed Document
 *                      with these exact original bytes? businessId + SHA-256.
 *                      That is what this module answers.
 *
 * Both are needed. Channel identity stops an external event being processed
 * twice; content identity stops the same file becoming two Documents because it
 * arrived through two different doors. Replacing either with the other loses a
 * real protection.
 *
 * # Why a lock, and not a unique index
 *
 * The obvious fix for "two callers both see no duplicate and both insert" is a
 * unique index on (businessId, contentHashSha256). It is not available here:
 * the Import Center deliberately supports an owner-confirmed CREATE_ANYWAY, and
 * a database uniqueness constraint would make that impossible rather than
 * merely discouraged. The override is a product decision the owner is entitled
 * to make.
 *
 * So mutual exclusion is taken explicitly, with the transaction-scoped advisory
 * lock this codebase already uses for the business lifecycle. It needs no table
 * privilege, releases at transaction end, and — crucially — it serialises
 * without forbidding, so an explicit override still creates its second Document
 * while an accidental race cannot.
 *
 * # Why the check must live INSIDE the caller's transaction
 *
 * A check in its own transaction is a snapshot, not a guarantee: two uploads of
 * the same bytes could both read "no duplicate" and both go on to insert. Under
 * this lock, the second caller waits, then reads a world that already contains
 * the first caller's Document.
 */

import { createHash } from "node:crypto";
import type { TenantTx } from "@/lib/tenant/transaction";

/**
 * Advisory namespace for document-content locks.
 *
 * A namespace of its own, so these never serialise against the business
 * lifecycle lock (`ADVISORY_NAMESPACE`, 'AD'), which takes the same two-integer
 * lock space. 'DC' for document content.
 */
export const DOCUMENT_CONTENT_ADVISORY_NAMESPACE = 0x44_43;

/**
 * The lock key for one business's copy of one file.
 *
 * BOTH the tenant and the content go into the key, so two businesses holding
 * the same file never wait on each other. The key is a 32-bit fold of the pair,
 * so distinct pairs can collide — that costs a little serialisation and can
 * never cost correctness, because the query under the lock is still scoped by
 * businessId and hash.
 */
export function documentContentLockKey(
  businessId: number,
  contentHashSha256: string
): number {
  const digest = createHash("sha256")
    .update(`${businessId}:${contentHashSha256}`)
    .digest();
  // Signed 32-bit, which is what pg_advisory_xact_lock(int, int) takes.
  return digest.readInt32BE(0);
}

/** What the owner is told about a file they already have. */
export type DuplicateDocument = {
  documentId: number;
  status: string;
  uploadedAt: string;
  vendorName: string | null;
  amount: number | null;
  date: string | null;
};

/**
 * Take the content lock for this tenant and file, inside the caller's
 * transaction.
 *
 * Every path that may CREATE a Document takes this lock, including one acting
 * on an explicit override — an override means "create a second copy on
 * purpose", not "skip the serialisation that makes counting reliable".
 */
export async function lockDocumentContent(
  tx: TenantTx,
  businessId: number,
  contentHashSha256: string
): Promise<void> {
  const key = documentContentLockKey(businessId, contentHashSha256);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${DOCUMENT_CONTENT_ADVISORY_NAMESPACE}::int, ${key}::int)`;
}

/**
 * The business's existing Document for these bytes, if it has one.
 *
 * `failed` rows are excluded deliberately and consistently with the rest of the
 * product: a document whose processing failed is not evidence that the owner
 * already has this expense, and treating it as one would block a legitimate
 * retry of a file that never landed properly.
 *
 * Tenant-scoped in the predicate and served by the
 * `(businessId, contentHashSha256)` index.
 */
export async function findDuplicateDocumentTx(
  tx: TenantTx,
  businessId: number,
  contentHashSha256: string
): Promise<DuplicateDocument | null> {
  const existing = await tx.document.findFirst({
    where: {
      businessId,
      contentHashSha256,
      status: { not: "failed" },
    },
    orderBy: { id: "desc" },
    select: {
      id: true,
      status: true,
      createdAt: true,
      extractedData: { select: { vendorName: true, amount: true, date: true } },
      financialRecord: { select: { vendorName: true, amount: true, date: true } },
    },
  });
  if (!existing) return null;

  const known = existing.financialRecord ?? existing.extractedData;
  return {
    documentId: existing.id,
    status: existing.status,
    uploadedAt: existing.createdAt.toISOString(),
    vendorName: known?.vendorName ?? null,
    amount: known?.amount ?? null,
    date: known?.date ? known.date.toISOString() : null,
  };
}

/**
 * Lock, then look. The authoritative answer, and the only one a create may act
 * on.
 *
 * Callers may run a cheaper unlocked check first to avoid pointless work — a
 * storage write, an OCR call — but that earlier answer is advisory. This one
 * decides.
 */
export async function lockAndFindDuplicateTx(
  tx: TenantTx,
  businessId: number,
  contentHashSha256: string
): Promise<DuplicateDocument | null> {
  await lockDocumentContent(tx, businessId, contentHashSha256);
  return findDuplicateDocumentTx(tx, businessId, contentHashSha256);
}
