// Pure, frontend-safe breakdown of the attachments a Gmail scan refused by
// type (diagnostics, 2026-11-08 B1).
//
// Counting only. The keep/drop decision stays with the Documents allowlist
// (isAllowedDocumentMime); nothing here decides what is shown, scored or
// importable, and a group is a description of what Gmail declared — never a
// claim about what the file really is. "pdf_mislabeled" in particular means
// "named or typed like a PDF but not declared application/pdf"; the bytes were
// never read.

export const REJECTED_TYPE_GROUPS = [
  "pdf_mislabeled",
  "office",
  "zip",
  "calendar",
  "image_other",
  "other",
] as const;

export type RejectedTypeGroup = (typeof REJECTED_TYPE_GROUPS)[number];
export type RejectedTypeCounts = Record<RejectedTypeGroup, number>;

const OFFICE_EXT = new Set(["doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "rtf"]);
const ZIP_EXT = new Set(["zip", "rar", "7z", "gz", "tgz", "tar"]);
const CALENDAR_EXT = new Set(["ics", "vcs"]);
const IMAGE_EXT = new Set(["heic", "heif", "webp", "gif", "tif", "tiff", "bmp", "svg", "avif"]);

const ZIP_MIME = new Set([
  "application/zip",
  "application/x-zip-compressed",
  "application/x-zip",
  "application/x-rar-compressed",
  "application/vnd.rar",
  "application/x-7z-compressed",
  "application/gzip",
  "application/x-gzip",
  "application/x-tar",
]);

function extensionOf(filename: string | null | undefined): string {
  const name = String(filename || "").trim().toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1) : "";
}

function baseMime(mimeType: string | null | undefined): string {
  return String(mimeType || "").split(";")[0].trim().toLowerCase();
}

/**
 * The group a REFUSED attachment is counted under. First match wins, in the
 * order of REJECTED_TYPE_GROUPS. Only the last extension counts, so
 * "invoice.pdf.zip" is a zip and "report.pdf.exe" is other.
 */
export function rejectedTypeGroup(
  mimeType: string | null | undefined,
  filename: string | null | undefined
): RejectedTypeGroup {
  const mime = baseMime(mimeType);
  const ext = extensionOf(filename);

  if (ext === "pdf" || mime.endsWith("/pdf") || mime.endsWith("/x-pdf")) return "pdf_mislabeled";
  if (
    OFFICE_EXT.has(ext) ||
    mime === "application/msword" ||
    mime === "application/rtf" ||
    mime.startsWith("application/vnd.openxmlformats-officedocument.") ||
    mime.startsWith("application/vnd.ms-excel") ||
    mime.startsWith("application/vnd.ms-powerpoint") ||
    mime.startsWith("application/vnd.ms-word") ||
    mime.startsWith("application/vnd.oasis.opendocument.")
  ) {
    return "office";
  }
  if (ZIP_EXT.has(ext) || ZIP_MIME.has(mime)) return "zip";
  if (CALENDAR_EXT.has(ext) || mime === "text/calendar" || mime === "application/ics") return "calendar";
  if (IMAGE_EXT.has(ext) || mime.startsWith("image/")) return "image_other";
  return "other";
}

export function emptyRejectedTypeCounts(): RejectedTypeCounts {
  return { pdf_mislabeled: 0, office: 0, zip: 0, calendar: 0, image_other: 0, other: 0 };
}

/**
 * Counts from an untrusted source (a server response, possibly from an older
 * deployment) → the fixed six keys with whole non-negative numbers, or null
 * when absent or malformed. Unknown keys are dropped, never echoed.
 */
export function parseRejectedTypeCounts(value: unknown): RejectedTypeCounts | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const out = emptyRejectedTypeCounts();
  for (const group of REJECTED_TYPE_GROUPS) {
    const n = source[group];
    if (n === undefined) continue;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) return null;
    out[group] = n;
  }
  return out;
}
