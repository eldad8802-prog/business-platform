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
 */
export function buildStoredDocumentFileName(mimeType: string): string {
  const ext = safeExtFromMime(mimeType).replace(/^\./, "") || "bin";
  const random = Math.random().toString(16).slice(2, 10);
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
