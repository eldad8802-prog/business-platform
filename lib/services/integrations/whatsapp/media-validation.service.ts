/**
 * WhatsApp inbound media — acceptance, on the canonical Documents rules.
 *
 * # What changed and why
 *
 * This used to keep its own answer to "which files may become a Document":
 * `application/pdf` or any `image/*`, with no look at the bytes. That was the
 * same private allowlist the upload route carried before I-7C.1, so an inbound
 * message could land a file in Documents that the upload screen would refuse.
 * The rules now come from the Documents service, so all four intake paths —
 * upload, import centre, Gmail, WhatsApp — accept exactly one set of files.
 *
 * # The fabricated type, removed
 *
 * When Meta's metadata carried no `mime_type`, the fetch layer used to invent
 * one: `application/pdf` for a document, `image/jpeg` for an image. That turned
 * "we do not know what this is" into a confident claim, and the claim was then
 * used to store the object, to drive OCR, and to fill the Document row.
 *
 * A missing type is now resolved from the BYTES instead — the one authority in
 * this flow that nobody outside can assert. If the bytes match no container we
 * support, the media is refused. Nothing is invented in either direction.
 */

import {
  canonicalMimeForContainer,
  detectFileSignature,
  normalizeDeclaredMime,
  verifyFileSignature,
} from "@/lib/services/documents/file-signature";
import {
  DOCUMENT_MAX_UPLOAD_BYTES,
  isAllowedDocumentMime,
} from "@/lib/services/documents/document-ingestion.service";

/**
 * The size ceiling, taken from the Documents rule rather than restated.
 *
 * It was a separate constant that happened to hold the same number. Two numbers
 * that must agree, with nothing making them agree, is a drift waiting to happen.
 */
export const WHATSAPP_MEDIA_MAX_BYTES = DOCUMENT_MAX_UPLOAD_BYTES;

export type MediaValidationFailureReason =
  | "unsupported_mime"
  | "file_too_large"
  /** A recognised container, but not the one the provider's metadata claimed. */
  | "content_mismatch";

export function isAllowedWhatsAppMediaMime(mimeType: string): boolean {
  return isAllowedDocumentMime(mimeType);
}

/**
 * Decide whether inbound media may become a Document, and under which type.
 *
 * The returned `mimeType` is the one every later step must use: either the
 * provider's declared type once the bytes confirmed it, or the type read from
 * the bytes when the provider declared none.
 */
export function validateWhatsAppMediaContent(params: {
  buffer: Buffer;
  mimeType: string | null;
}):
  | { ok: true; mimeType: string; sizeBytes: number }
  | { ok: false; reason: MediaValidationFailureReason } {
  const declared = normalizeDeclaredMime(params.mimeType ?? "");

  // Declared-type check first when there is one, so an unsupported type is
  // reported as such rather than as a size or content problem.
  if (declared && !isAllowedDocumentMime(declared)) {
    return { ok: false, reason: "unsupported_mime" };
  }

  const sizeBytes = params.buffer.length;
  if (sizeBytes > WHATSAPP_MEDIA_MAX_BYTES) {
    return { ok: false, reason: "file_too_large" };
  }
  if (sizeBytes === 0) {
    return { ok: false, reason: "unsupported_mime" };
  }

  if (!declared) {
    // No claim to check, so read the container off the bytes. This is the ONLY
    // place a type is derived rather than verified, and it is derived from the
    // file itself — never from routing hints or the shape of the message.
    const detected = detectFileSignature(params.buffer);
    if (detected === null) return { ok: false, reason: "unsupported_mime" };
    return {
      ok: true,
      mimeType: canonicalMimeForContainer(detected),
      sizeBytes,
    };
  }

  const verdict = verifyFileSignature(params.buffer, declared);
  if (!verdict.ok) {
    return { ok: false, reason: "content_mismatch" };
  }

  return { ok: true, mimeType: declared, sizeBytes };
}
