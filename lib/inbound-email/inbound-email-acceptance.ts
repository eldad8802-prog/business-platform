/**
 * What inbound email accepts — expressed ENTIRELY by delegation.
 *
 * # This file defines no rules of its own, and that is the whole point
 *
 * Every acceptance decision below is imported from the canonical Documents
 * modules. Nothing here says "PDF, JPEG and PNG", nothing here says "15MB",
 * and nothing here re-checks magic bytes. If Documents changes what it
 * accepts, this changes with it, because there is no second copy to forget.
 *
 * The comment at the top of `document-ingestion.service.ts` explains why the
 * acceptance rules were exported from that module rather than the upload
 * route: so a second caller "cannot quietly accept a file the first one would
 * have refused". Inbound email is precisely that second caller. This file
 * exists to make the delegation explicit and testable, not to add policy.
 *
 * Pure. No database, no network, no `process.env`.
 */
import {
  DOCUMENT_MAX_UPLOAD_BYTES,
  isAllowedDocumentMime,
  isHeicMimeType,
} from "@/lib/services/documents/document-ingestion.service";
import {
  signatureRejectionMessage,
  verifyFileSignature,
} from "@/lib/services/documents/file-signature";
import type { InboundEmailAddressStatus } from "@prisma/client";

/** Re-exported so callers read the canonical values, never a local copy. */
export { DOCUMENT_MAX_UPLOAD_BYTES };

export type AddressAcceptance =
  | { ok: true }
  | { ok: false; reason: "UNKNOWN_ADDRESS" | "REVOKED_ADDRESS" };

/**
 * May a message addressed to this row be accepted?
 *
 * An unknown address and a revoked one are refused the same way on the wire,
 * with the same silence. Distinguishing them in a response would turn the
 * endpoint into an oracle that confirms which addresses exist.
 */
export function acceptAddress(
  row: { status: InboundEmailAddressStatus } | null | undefined
): AddressAcceptance {
  if (!row) return { ok: false, reason: "UNKNOWN_ADDRESS" };
  if (row.status !== "ACTIVE") return { ok: false, reason: "REVOKED_ADDRESS" };
  return { ok: true };
}

export type AttachmentAcceptance =
  | { ok: true }
  | { ok: false; reason: string; message: string };

/**
 * May this attachment become a Document?
 *
 * Order matters and is the same order the upload path uses: declared type
 * first, then size, then the bytes themselves. Checking the bytes first would
 * mean reading a 40MB attachment we were always going to refuse.
 */
export function acceptAttachment(input: {
  mimeType: string;
  sizeBytes: number;
  buffer: Buffer;
}): AttachmentAcceptance {
  if (isHeicMimeType(input.mimeType)) {
    return {
      ok: false,
      reason: "HEIC_UNSUPPORTED",
      message:
        "הקובץ שהתקבל בפורמט HEIC, ואנחנו לא יכולים לקרוא אותו. בקשי מהספק לשלוח PDF או תמונה רגילה.",
    };
  }

  if (!isAllowedDocumentMime(input.mimeType)) {
    return {
      ok: false,
      reason: "UNSUPPORTED_TYPE",
      message: "הקובץ שהתקבל אינו בפורמט שאנחנו קוראים. אנחנו מקבלים PDF, JPEG ו-PNG.",
    };
  }

  if (!Number.isFinite(input.sizeBytes) || input.sizeBytes <= 0) {
    return {
      ok: false,
      reason: "EMPTY_FILE",
      message: "הקובץ שהתקבל ריק.",
    };
  }

  if (input.sizeBytes > DOCUMENT_MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      reason: "TOO_LARGE",
      message: "הקובץ שהתקבל גדול מדי.",
    };
  }

  const signature = verifyFileSignature(input.buffer, input.mimeType);
  if (!signature.ok) {
    return {
      ok: false,
      reason: `SIGNATURE_${signature.reason}`,
      message: signatureRejectionMessage(signature.reason),
    };
  }

  return { ok: true };
}

/**
 * Does a scan verdict mean "do not store this at all"?
 *
 * Only a positive malware verdict stops a message. Spam and the sender-
 * authentication verdicts are recorded as evidence for the reviewer and never
 * block, because in a forwarding architecture SPF failure is the normal case
 * rather than the exceptional one. Blocking on it would reject the product's
 * main use case.
 */
export function isMalwareVerdict(virusVerdict: string | null | undefined): boolean {
  return String(virusVerdict ?? "").trim().toUpperCase() === "FAIL";
}
