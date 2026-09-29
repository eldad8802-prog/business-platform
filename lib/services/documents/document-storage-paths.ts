import { randomBytes } from "node:crypto";
import path from "path";

/**
 * Canonical stored basename pattern for Document.fileUrl (upload + Gmail import).
 * Must stay in sync with file streaming and ZIP export.
 */
export const STORED_DOCUMENT_FILENAME_REGEX =
  /^doc-\d+-[a-z0-9]+\.(pdf|jpe?g|png|webp|gif|heic|heif|tiff?|bmp|img|bin)$/i;

export function safeExtFromMime(mimeType: string): string {
  const t = mimeType.toLowerCase();
  if (t === "application/pdf") return ".pdf";
  if (t === "image/jpeg") return ".jpg";
  if (t === "image/png") return ".png";
  if (t === "image/webp") return ".webp";
  if (t === "image/gif") return ".gif";
  if (t.startsWith("image/")) return ".img";
  return "";
}

/**
 * Safe stored filename derived ONLY from validated MIME (never user filename).
 *
 * H-4: the random part is 128 bits from the OS CSPRNG (was 32 bits of
 * Math.random). The shape still matches STORED_DOCUMENT_FILENAME_REGEX, so every
 * reader of existing names is unchanged. Unguessability is defence in depth —
 * the private bucket, not the name, is the access control.
 */
export function buildStoredDocumentFileName(mimeType: string): string {
  const ext = safeExtFromMime(mimeType).replace(/^\./, "") || "bin";
  const random = randomBytes(16).toString("hex");
  return `doc-${Date.now()}-${random}.${ext}`;
}

export type ResolveStoredDocumentPathResult =
  | {
      ok: true;
      absolutePath: string;
      storageRoot: string;
    }
  | { ok: false };

/**
 * Resolves storage/documents/<businessId>/<basename> with the same guards as GET file route.
 */
export function resolveStoredDocumentFilePath(
  businessId: number,
  storedBasename: string
): ResolveStoredDocumentPathResult {
  const storedName = String(storedBasename || "").trim();

  if (!STORED_DOCUMENT_FILENAME_REGEX.test(storedName)) {
    return { ok: false };
  }

  const storageRoot = path.resolve(
    process.cwd(),
    "storage",
    "documents",
    String(businessId)
  );
  const filePath = path.resolve(storageRoot, storedName);

  if (
    filePath !== storageRoot &&
    !filePath.startsWith(storageRoot + path.sep)
  ) {
    return { ok: false };
  }

  return { ok: true, absolutePath: filePath, storageRoot };
}
