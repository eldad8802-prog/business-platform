/**
 * Canonical storage helper for CRM attachments.
 *
 * Owns: MIME allowlist, MIME→extension, server-generated storage key (never the
 * user's filename), key validation, and read/delete through the shared
 * StorageService. Objects live in the private "crm" storage domain.
 *
 * Key shape (server-built only):
 *   biz/{businessId}/crm/{subjectType}/{subjectId}/att-{timestamp}-{random}.{ext}
 */

import { getStorageService } from "@/lib/storage";
import { assertSafeStorageKey } from "@/lib/storage/key-validation";
import { ValidationError } from "@/lib/errors";
import type { CrmSubjectType } from "@/lib/services/crm/crm-subject.resolver";

/** Hard ceiling — checked server-side against the real byte length. */
export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024; // 15MB

/**
 * Closed allowlist. `ext` = canonical extension used for the stored object;
 * `origExts` = original-filename extensions we accept as consistent with the MIME.
 */
const ALLOWED_MIME: Record<string, { ext: string; origExts: string[] }> = {
  "application/pdf": { ext: "pdf", origExts: ["pdf"] },
  "image/jpeg": { ext: "jpg", origExts: ["jpg", "jpeg"] },
  "image/png": { ext: "png", origExts: ["png"] },
  "image/webp": { ext: "webp", origExts: ["webp"] },
  "image/gif": { ext: "gif", origExts: ["gif"] },
  "image/heic": { ext: "heic", origExts: ["heic"] },
  "image/heif": { ext: "heif", origExts: ["heif"] },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
    ext: "docx",
    origExts: ["docx"],
  },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
    ext: "xlsx",
    origExts: ["xlsx"],
  },
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": {
    ext: "pptx",
    origExts: ["pptx"],
  },
  "text/plain": { ext: "txt", origExts: ["txt"] },
  "text/csv": { ext: "csv", origExts: ["csv"] },
};

export const ALLOWED_MIME_TYPES = Object.keys(ALLOWED_MIME);

export function normalizeMime(mime: unknown): string {
  return typeof mime === "string" ? mime.toLowerCase().trim() : "";
}

function isAllowedMime(mime: string): boolean {
  return Object.prototype.hasOwnProperty.call(ALLOWED_MIME, mime);
}

function originalExtension(fileName: string): string | null {
  const base = fileName.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return null;
  return base.slice(dot + 1).toLowerCase();
}

/** Remove ASCII control characters (codes < 32 and 127) without regex escapes. */
function stripControlChars(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code >= 32 && code !== 127) out += ch;
  }
  return out;
}

/**
 * Display-only filename: strip any path, control chars, and cap length. NEVER
 * used to build the storage key — purely what we show/return for download.
 */
export function sanitizeDisplayFileName(raw: unknown): string {
  const base = (typeof raw === "string" ? raw : "").split(/[\\/]/).pop() ?? "";
  const cleaned = stripControlChars(base).trim();
  const safe = cleaned.length > 0 ? cleaned : "file";
  return safe.slice(0, 255);
}

export type ValidatedUpload = {
  mimeType: string;
  storageExt: string;
  displayFileName: string;
};

/**
 * Validates a candidate upload. Throws ValidationError on: empty/blocked MIME,
 * disallowed MIME, oversize, or an original extension inconsistent with the MIME.
 * Does NOT trust the client-provided size — the caller passes the real byte length.
 */
export function validateAttachmentUpload(input: {
  mimeType: unknown;
  originalFileName: unknown;
  sizeBytes: number;
}): ValidatedUpload {
  const mime = normalizeMime(input.mimeType);
  if (!mime) {
    throw new ValidationError("סוג הקובץ חסר");
  }
  if (!isAllowedMime(mime)) {
    throw new ValidationError("סוג קובץ לא נתמך");
  }

  if (!Number.isInteger(input.sizeBytes) || input.sizeBytes <= 0) {
    throw new ValidationError("קובץ ריק או גודל לא תקין");
  }
  if (input.sizeBytes > MAX_ATTACHMENT_BYTES) {
    throw new ValidationError("הקובץ גדול מדי (עד 15MB)");
  }

  const displayFileName = sanitizeDisplayFileName(input.originalFileName);
  const origExt = originalExtension(displayFileName);
  if (origExt && !ALLOWED_MIME[mime].origExts.includes(origExt)) {
    throw new ValidationError("סיומת הקובץ אינה תואמת לסוג הקובץ");
  }

  return { mimeType: mime, storageExt: ALLOWED_MIME[mime].ext, displayFileName };
}

/**
 * Server-generated storage key. subjectType/subjectId come from the validated
 * resolver; the basename is random; the extension comes from the validated MIME —
 * so no user input ever reaches the key.
 */
export function buildAttachmentStorageKey(input: {
  businessId: number;
  subjectType: CrmSubjectType;
  subjectId: number;
  storageExt: string;
}): string {
  if (!Number.isInteger(input.businessId) || input.businessId <= 0) {
    throw new ValidationError("Invalid business id for storage key");
  }
  if (!Number.isInteger(input.subjectId) || input.subjectId <= 0) {
    throw new ValidationError("Invalid subject id for storage key");
  }
  const random = Math.random().toString(16).slice(2, 10);
  const basename = `att-${Date.now()}-${random}.${input.storageExt}`;
  const key = `biz/${input.businessId}/crm/${input.subjectType}/${input.subjectId}/${basename}`;
  // Defense-in-depth: run the same safety validation storage will apply.
  return assertSafeStorageKey(key);
}

export async function putAttachmentObject(input: {
  businessId: number;
  key: string;
  body: Buffer;
  contentType: string;
}): Promise<void> {
  await getStorageService().putObject({
    key: assertSafeStorageKey(input.key),
    body: input.body,
    contentType: input.contentType,
    metadata: { businessId: input.businessId, domain: "crm", visibility: "private" },
  });
}

export async function readAttachmentObject(
  key: string
): Promise<{ body: Buffer; contentType: string }> {
  const result = await getStorageService().getObject(assertSafeStorageKey(key));
  return { body: result.body, contentType: result.metadata.contentType };
}

export async function deleteAttachmentObject(key: string): Promise<void> {
  await getStorageService().deleteObject(assertSafeStorageKey(key));
}
