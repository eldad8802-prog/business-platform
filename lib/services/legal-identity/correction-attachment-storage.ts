/**
 * Supporting documents of a legal identity correction request (owner decision 2026-11-13). SERVER-ONLY.
 *
 * The same discipline as the trust documents (lib/services/trust/trust-document-storage.ts), in the private,
 * create-once "legal-identity" storage domain:
 *   - PDF, JPEG or PNG only, ≤ 10 MB, checked on the REAL bytes (lib/services/documents/file-signature.ts);
 *   - a server-built key  biz/{businessId}/legal-identity/{requestId}/doc-{time}-{random}.{ext}  — no user input
 *     reaches it; never a public URL; the sha256 is computed here;
 *   - stored with putObjectIfAbsent (the domain refuses a plain put), THEN recorded by the database
 *     (legal_identity_correction_attach: the requester, a PENDING request, ≤ 5 per request). If the database refuses,
 *     the just-stored object is deleted and the database's error is rethrown; a failed cleanup is logged, never hidden
 *     (and the account-erasure prefix sweep would still remove it).
 * Keys and bytes never reach a log or a client error.
 */

import { createHash, randomBytes } from "node:crypto";

import { containerForDeclaredMime, verifyFileSignature, signatureRejectionMessage } from "@/lib/services/documents/file-signature";
import { getStorageService, type StorageService } from "@/lib/storage";
import { assertSafeStorageKey } from "@/lib/storage/key-validation";

export const MAX_CORRECTION_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB — the database CHECK's bound
export const MAX_ATTACHMENTS_PER_REQUEST = 5; // the database refuses the sixth (DZC08)

const EXT: Record<string, string> = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png" };
export const CORRECTION_ATTACHMENT_MIME_TYPES = Object.keys(EXT);

export class AttachmentInputError extends Error {
  readonly code: "UNSUPPORTED_TYPE" | "EMPTY" | "TOO_LARGE" | "CONTENT_MISMATCH";
  constructor(code: AttachmentInputError["code"], message: string) {
    super(message);
    this.name = "AttachmentInputError";
    this.code = code;
  }
}

export function legalIdentityBusinessPrefix(businessId: number): string {
  if (!Number.isInteger(businessId) || businessId <= 0) throw new AttachmentInputError("UNSUPPORTED_TYPE", "Invalid business");
  return `biz/${businessId}/legal-identity/`;
}

/** Validate the real bytes and build the server-side key. */
export function prepareCorrectionAttachment(input: { businessId: number; requestId: number; mimeType: unknown; body: Buffer }) {
  if (!Number.isInteger(input.requestId) || input.requestId <= 0) throw new AttachmentInputError("UNSUPPORTED_TYPE", "Invalid request");
  const mime = typeof input.mimeType === "string" ? input.mimeType.toLowerCase().trim() : "";
  const ext = EXT[mime];
  if (!ext || containerForDeclaredMime(mime) === null) {
    throw new AttachmentInputError("UNSUPPORTED_TYPE", "אפשר לצרף קובץ PDF, JPG או PNG בלבד.");
  }
  if (input.body.length === 0) throw new AttachmentInputError("EMPTY", "הקובץ ריק.");
  if (input.body.length > MAX_CORRECTION_ATTACHMENT_BYTES) {
    throw new AttachmentInputError("TOO_LARGE", "הקובץ גדול מדי (עד 10MB).");
  }
  const verdict = verifyFileSignature(input.body, mime);
  if (!verdict.ok) throw new AttachmentInputError("CONTENT_MISMATCH", signatureRejectionMessage(verdict.reason));
  const storageKey = assertSafeStorageKey(
    `${legalIdentityBusinessPrefix(input.businessId)}${input.requestId}/doc-${Date.now()}-${randomBytes(8).toString("hex")}.${ext}`
  );
  return { storageKey, mimeType: mime, sizeBytes: input.body.length, sha256: createHash("sha256").update(input.body).digest("hex") };
}

export type CorrectionAttachmentStorage = Pick<StorageService, "putObjectIfAbsent" | "getObject" | "deleteObject">;

/** Only a key under THIS business's prefix is ever read or deleted. */
function ownKey(businessId: number, storageKey: string): string {
  if (typeof storageKey !== "string" || !storageKey.startsWith(legalIdentityBusinessPrefix(businessId))) {
    throw new AttachmentInputError("UNSUPPORTED_TYPE", "Invalid document");
  }
  return assertSafeStorageKey(storageKey);
}

export type AttachmentLeak = {
  event: "legal_identity_attachment_cleanup_failed";
  businessId: number;
  requestId: number;
  error: string;
};

/**
 * validate → store (create-once) → record in the database.
 *   the database refuses → delete the object, rethrow the database's error (a cleanup failure is reported).
 */
export async function storeCorrectionAttachment<R>(
  input: { businessId: number; requestId: number; mimeType: unknown; body: Buffer },
  deps: {
    attach: (doc: { storageKey: string; mimeType: string; sizeBytes: number; sha256: string }) => Promise<R>;
    storage?: CorrectionAttachmentStorage;
    onLeak?: (leak: AttachmentLeak) => void;
  }
): Promise<R> {
  const storage = deps.storage ?? getStorageService();
  const doc = prepareCorrectionAttachment(input);
  const put = await storage.putObjectIfAbsent({
    key: doc.storageKey,
    body: input.body,
    contentType: doc.mimeType,
    metadata: { businessId: input.businessId, domain: "legal-identity", visibility: "private" },
  });
  if (put.status !== "CREATED") throw new Error("legal_identity_attachment_key_exists");
  try {
    return await deps.attach(doc);
  } catch (attachError) {
    try {
      await storage.deleteObject(ownKey(input.businessId, doc.storageKey));
    } catch (cleanupError) {
      (deps.onLeak ?? ((l) => console.error(JSON.stringify(l))))({
        event: "legal_identity_attachment_cleanup_failed",
        businessId: input.businessId,
        requestId: input.requestId,
        error: cleanupError instanceof Error ? cleanupError.name : "unknown",
      });
    }
    throw attachError;
  }
}

export async function readCorrectionAttachment(
  input: { businessId: number; storageKey: string },
  storage: Pick<StorageService, "getObject"> = getStorageService()
): Promise<{ body: Buffer; contentType: string }> {
  const r = await storage.getObject(ownKey(input.businessId, input.storageKey));
  return { body: r.body, contentType: r.metadata.contentType };
}
