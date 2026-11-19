/**
 * Legal identity correction attachments — the object stage of an account erasure. SERVER-ONLY.
 *
 * Joins the shared post-commit stage (lib/services/account/account-storage-erasure.ts) as module "legal-identity":
 *
 *   1. IN THE PURGE TRANSACTION (account-deletion.prisma-store.ts): legal_identity_correction_erase() clears the
 *      attachment rows' key and hash in place and closes every open request — so no further attach() can succeed.
 *   2. AFTER COMMIT (this module), for a business being or already deleted only:
 *        a. DELETE — list biz/{id}/legal-identity/ (trailing slash: never another business) and delete every object;
 *        b. VERIFY — list the prefix AGAIN; `remaining` is that fresh count, never this pass's own arithmetic.
 *      No key from the database is needed: the prefix is the business's, and the domain holds nothing else.
 *   3. RESUME. Idempotent and safe to run concurrently with itself (deletes are idempotent in both adapters). The
 *      sweep re-runs it for every deleting business, so an upload in flight at quarantine — refused by the database,
 *      its orphan deleted by the uploader or, failing that, listed here — is caught by a later pass.
 *
 * PRIVACY: errors are FIXED codes; never an exception message, a key or a path.
 */

import { prisma } from "@/lib/prisma";
import { getStorageService, type StorageService } from "@/lib/storage";

import { legalIdentityBusinessPrefix } from "./correction-attachment-storage";

export const LEGAL_IDENTITY_ERASURE_ERROR_CODES = ["LIST_FAILED", "DELETE_FAILED", "VERIFY_FAILED", "FOREIGN_KEY_LISTED"] as const;
export type LegalIdentityErasureErrorCode = (typeof LEGAL_IDENTITY_ERASURE_ERROR_CODES)[number];

export type LegalIdentityErasureProgress = {
  /** NOT_DELETING: the business is live — nothing is touched. */
  state: "NOT_DELETING" | "PASS";
  deleted: number;
  remaining: number;
  error: LegalIdentityErasureErrorCode | null;
  done: boolean;
};

export type LegalIdentityErasureDeps = {
  storage?: Pick<StorageService, "listObjects" | "deleteObject">;
  /** Whether the business is being or already deleted (Business carries no RLS). */
  isDeleting?: (businessId: number) => Promise<boolean>;
};

async function businessIsDeleting(businessId: number): Promise<boolean> {
  const b = await prisma.business.findUnique({ where: { id: businessId }, select: { deletionRequestedAt: true, deletedAt: true } });
  return !!b && (b.deletionRequestedAt !== null || b.deletedAt !== null);
}

export async function continueLegalIdentityStorageErasure(
  businessId: number,
  deps: LegalIdentityErasureDeps = {}
): Promise<LegalIdentityErasureProgress> {
  const isDeleting = deps.isDeleting ?? businessIsDeleting;
  if (!(await isDeleting(businessId))) {
    return { state: "NOT_DELETING", deleted: 0, remaining: 0, error: null, done: true };
  }
  const storage = deps.storage ?? getStorageService();
  const prefix = legalIdentityBusinessPrefix(businessId);

  let listed: { key: string }[];
  try {
    listed = await storage.listObjects(prefix);
  } catch {
    return { state: "PASS", deleted: 0, remaining: 0, error: "LIST_FAILED", done: false };
  }
  let deleted = 0;
  let error: LegalIdentityErasureErrorCode | null = null;
  for (const object of listed) {
    if (!object.key.startsWith(prefix)) {
      error = "FOREIGN_KEY_LISTED"; // never delete outside this business's prefix
      continue;
    }
    try {
      await storage.deleteObject(object.key);
      deleted++;
    } catch {
      error = error ?? "DELETE_FAILED";
    }
  }
  let remaining: number;
  try {
    remaining = (await storage.listObjects(prefix)).length;
  } catch {
    remaining = Math.max(listed.length - deleted, 0);
    error = error ?? "VERIFY_FAILED";
  }
  return { state: "PASS", deleted, remaining, error, done: remaining === 0 && error === null };
}
