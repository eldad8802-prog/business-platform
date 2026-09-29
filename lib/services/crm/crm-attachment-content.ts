/**
 * CRM attachment CONTENT verification (L-13).
 *
 * validateAttachmentUpload checks the declared MIME against an allowlist and
 * the filename extension — both are client claims. This checks the BYTES:
 *
 *   application/pdf           `%PDF-`
 *   image/jpeg|png            documents signature detector (shared)
 *   image/webp|gif            RIFF/WEBP, GIF87a/89a
 *   image/heic|heif           ISO-BMFF `ftyp` with a HEIF brand
 *   docx / xlsx / pptx        a real ZIP whose central directory holds
 *                             `[Content_Types].xml` AND the format's main part
 *                             (word/document.xml, xl/workbook.xml,
 *                             ppt/presentation.xml); a VBA project is refused
 *                             (a macro-enabled file under a macro-free type)
 *   text/plain|csv            valid UTF-8 (BOM allowed), no NUL byte
 *
 * It is NOT malware scanning — see lib/security/malware-scan.ts.
 */

import { detectFileSignature } from "@/lib/services/documents/file-signature";
import { detectPublicAssetContainer } from "@/lib/services/storage/public-asset-validation";
import {
  looksLikeZip,
  readZipCentralDirectory,
  ZipInspectError,
} from "@/lib/security/zip-inspect";

export type AttachmentContentRejection =
  | "CONTENT_MISMATCH"
  | "OOXML_STRUCTURE"
  | "OOXML_MACROS"
  | "TEXT_NOT_UTF8"
  | "TEXT_HAS_NUL";

export type AttachmentContentVerdict =
  | { ok: true }
  | { ok: false; reason: AttachmentContentRejection };

const OOXML_MAIN_PART: Record<string, string> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "word/document.xml",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xl/workbook.xml",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "ppt/presentation.xml",
};

const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "mif1", "msf1", "heim", "heis"]);

function fail(reason: AttachmentContentRejection): AttachmentContentVerdict {
  return { ok: false, reason };
}

function verifyOoxml(buffer: Buffer, mainPart: string): AttachmentContentVerdict {
  if (!looksLikeZip(buffer)) return fail("CONTENT_MISMATCH");
  let names: string[];
  try {
    names = readZipCentralDirectory(buffer, { maxEntries: 5_000 }).map((e) => e.name);
  } catch (error) {
    if (error instanceof ZipInspectError) return fail("OOXML_STRUCTURE");
    throw error;
  }
  const set = new Set(names);
  if (!set.has("[Content_Types].xml") || !set.has(mainPart)) {
    return fail("OOXML_STRUCTURE");
  }
  if (names.some((n) => /(^|\/)vbaProject\.bin$/i.test(n))) {
    return fail("OOXML_MACROS");
  }
  return { ok: true };
}

function verifyUtf8Text(buffer: Buffer): AttachmentContentVerdict {
  if (buffer.includes(0x00)) return fail("TEXT_HAS_NUL");
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return fail("TEXT_NOT_UTF8");
  }
  return { ok: true };
}

/** Verify the bytes of an attachment against its (already allowlisted) MIME. */
export function verifyAttachmentContent(
  buffer: Buffer,
  mimeType: string
): AttachmentContentVerdict {
  const mime = mimeType.toLowerCase().trim();

  switch (mime) {
    case "application/pdf":
      return detectFileSignature(buffer) === "pdf" ? { ok: true } : fail("CONTENT_MISMATCH");
    case "image/jpeg":
      return detectFileSignature(buffer) === "jpeg" ? { ok: true } : fail("CONTENT_MISMATCH");
    case "image/png":
      return detectFileSignature(buffer) === "png" ? { ok: true } : fail("CONTENT_MISMATCH");
    case "image/webp":
      return detectPublicAssetContainer(buffer) === "webp" ? { ok: true } : fail("CONTENT_MISMATCH");
    case "image/gif":
      return detectPublicAssetContainer(buffer) === "gif" ? { ok: true } : fail("CONTENT_MISMATCH");
    case "image/heic":
    case "image/heif": {
      const isFtyp = buffer.length >= 12 && buffer.toString("latin1", 4, 8) === "ftyp";
      return isFtyp && HEIF_BRANDS.has(buffer.toString("latin1", 8, 12))
        ? { ok: true }
        : fail("CONTENT_MISMATCH");
    }
    case "text/plain":
    case "text/csv":
      return verifyUtf8Text(buffer);
    default: {
      const mainPart = OOXML_MAIN_PART[mime];
      if (mainPart) return verifyOoxml(buffer, mainPart);
      // Not in the allowlist this module knows: never accept by default.
      return fail("CONTENT_MISMATCH");
    }
  }
}

export function attachmentContentRejectionMessage(reason: AttachmentContentRejection): string {
  switch (reason) {
    case "OOXML_MACROS":
      return "קבצים עם מאקרו אינם נתמכים";
    case "TEXT_NOT_UTF8":
      return "קובץ הטקסט אינו בקידוד UTF-8";
    case "TEXT_HAS_NUL":
      return "קובץ הטקסט מכיל תוכן בינארי";
    default:
      return "תוכן הקובץ אינו תואם לסוג הקובץ";
  }
}
