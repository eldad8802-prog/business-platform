import PostalMime, { type Attachment } from "postal-mime";

import { acceptAttachment } from "@/lib/inbound-email/inbound-email-acceptance";
import { detectFileSignature } from "@/lib/services/documents/file-signature";
import { sha256Hex } from "@/lib/services/integrations/gmail/sha256.service";

import {
  MAX_ATTACHMENTS,
  MAX_DECODED_BYTES,
  MAX_MIME_DEPTH,
  MAX_RAW_MESSAGE_BYTES,
  MAX_SUBJECT_LENGTH,
  type InboundMimeAttachmentRejectionCode,
  type InboundMimeResult,
  type ParsedInboundAttachment,
  type RejectedInboundAttachment,
} from "./inbound-mime-contract";
import { sanitizeAttachmentFilename } from "./inbound-mime-filename";
import { prescanMimeStructure } from "./inbound-mime-prescan";

/**
 * Turn raw RFC822 bytes into the small, checked shape the rest of inbound email
 * will eventually build on.
 *
 * # This function does nothing but read its argument
 *
 * No database, no network, no filesystem, no object storage, no clock-dependent
 * behaviour, no logging of anything the sender wrote. Given the same bytes it
 * returns the same answer, which is what makes it testable against hostile input
 * and what lets the adversarial suite below it mean something.
 *
 * # It parses syntax; it does not authenticate anybody
 *
 * Every header it reads is attacker-controlled. `from` is returned because a
 * human reviewing a queue needs to see a claim of origin, not because the claim
 * is believed. Nothing here may be promoted to authorisation: that is a database
 * decision against the authorised-sender list, taken per message, elsewhere.
 *
 * # Order of checks, and why it is this order
 *
 * Size, then structure, then parse, then per-attachment. Each step is cheaper
 * than the one after it, so a message built to be expensive is refused by the
 * cheap check rather than after the expensive one has already run.
 */
export async function parseInboundMime(raw: Buffer): Promise<InboundMimeResult> {
  // 1. Size, measured in BYTES, before anything reads the content. A string
  //    length here would be a limit the sender chooses the encoding for.
  if (raw.length === 0) return { ok: false, code: "RAW_MESSAGE_EMPTY" };
  if (raw.length > MAX_RAW_MESSAGE_BYTES) {
    return { ok: false, code: "RAW_MESSAGE_TOO_LARGE" };
  }

  // 2. Part count, which the parser cannot report. See the pre-scan module for
  //    exactly what this measurement does and does not promise.
  const structure = prescanMimeStructure(raw);
  if (!structure.ok) return { ok: false, code: structure.code };

  // 3. The parse itself. Depth is the parser's own check, applied during its
  //    descent, which is stronger than anything that could be measured from
  //    outside it. Without the option it will happily descend thirty levels.
  let email;
  try {
    email = await PostalMime.parse(raw, {
      maxNestingDepth: MAX_MIME_DEPTH,
      maxRfc822NestingDepth: MAX_MIME_DEPTH,
      attachmentEncoding: "arraybuffer",
      // A forwarded message becomes an ATTACHMENT rather than being merged into
      // the outer message's parts. That keeps "this message contained another
      // one" visible and countable, instead of an inner invoice silently
      // appearing as though the forwarder had attached it. Whether a nested
      // message's files should become Documents is a product decision nobody has
      // taken; this function only makes the nesting legible.
      rfc822Attachments: true,
    });
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (/nesting depth/i.test(text)) return { ok: false, code: "MIME_TOO_DEEP" };
    return { ok: false, code: "MIME_MALFORMED" };
  }

  const accepted: ParsedInboundAttachment[] = [];
  const rejected: RejectedInboundAttachment[] = [];
  let decodedTotal = 0;
  let nestedMessageCount = 0;

  for (const part of email.attachments) {
    const declaredContentType = normalizeDeclared(part.mimeType);
    const filename = sanitizeAttachmentFilename(part.filename);

    if (declaredContentType === "message/rfc822") {
      nestedMessageCount += 1;
      reject(rejected, accepted, filename, declaredContentType, "NOT_AN_ATTACHMENT_CANDIDATE");
      continue;
    }

    if (!isCandidate(part)) {
      reject(rejected, accepted, filename, declaredContentType, "NOT_AN_ATTACHMENT_CANDIDATE");
      continue;
    }

    const content = toBuffer(part.content);

    // Cumulative BEFORE per-file checks: the cost of a message is the sum of
    // what it decoded, and ten files just under a per-file ceiling is the same
    // memory as one file far over it.
    decodedTotal += content.length;
    if (decodedTotal > MAX_DECODED_BYTES) {
      reject(rejected, accepted, filename, declaredContentType, "DECODED_BYTES_TOO_LARGE");
      continue;
    }

    if (accepted.length >= MAX_ATTACHMENTS) {
      reject(rejected, accepted, filename, declaredContentType, "TOO_MANY_ATTACHMENTS");
      continue;
    }

    // The canonical acceptance rules, reused rather than restated. This is the
    // same function the upload path and the import centre answer to, so an
    // emailed file and an uploaded one are refused for the same reasons in the
    // same words. A second magic-byte implementation here would be a second
    // opinion about what a PDF is.
    const verdict = acceptAttachment({
      mimeType: declaredContentType ?? "",
      sizeBytes: content.length,
      buffer: content,
    });
    if (!verdict.ok) {
      reject(
        rejected,
        accepted,
        filename,
        declaredContentType,
        verdict.reason as InboundMimeAttachmentRejectionCode
      );
      continue;
    }

    // Re-derived from the bytes rather than taken from the declaration. By this
    // point the two are known to agree, and taking it from the bytes means the
    // value downstream cannot have come from the sender.
    const verifiedContainer = detectFileSignature(content);
    if (verifiedContainer === null) {
      reject(rejected, accepted, filename, declaredContentType, "SIGNATURE_UNRECOGNISED");
      continue;
    }

    accepted.push({
      index: accepted.length,
      filename,
      declaredContentType,
      verifiedContainer,
      content,
      decodedSize: content.length,
      contentHashSha256: sha256Hex(content),
    });
  }

  return {
    ok: true,
    message: {
      messageIdHeader: bounded(email.messageId, 998),
      subject: bounded(email.subject, MAX_SUBJECT_LENGTH),
      fromAddress: addressOf(email.from),
      fromName: nameOf(email.from),
      date: typeof email.date === "string" ? email.date : null,
      attachments: accepted,
      rejected,
      nestedMessageCount,
    },
  };
}

function reject(
  rejected: RejectedInboundAttachment[],
  accepted: ParsedInboundAttachment[],
  filename: string | null,
  declaredContentType: string | null,
  reason: InboundMimeAttachmentRejectionCode
): void {
  rejected.push({ index: accepted.length + rejected.length, filename, declaredContentType, reason });
}

/**
 * Is this part a file somebody meant to send, or furniture?
 *
 * A logo in a signature and a tracking pixel are `inline` parts with a
 * Content-ID, and neither is an invoice. Requiring an explicit `attachment`
 * disposition, or an inline part that at least carries a filename and no
 * Content-ID, keeps the review queue about documents.
 *
 * Note what this does NOT do: it never decides on the filename's EXTENSION. The
 * extension is sender-controlled text and decides nothing here or later.
 */
function isCandidate(part: Attachment): boolean {
  if (part.disposition === "attachment") return true;
  if (part.disposition === "inline") return part.filename != null && part.contentId == null;
  // No disposition at all: accept only when it was named, which is what a mail
  // client does for a genuine attachment it forgot to label.
  return part.disposition == null && part.filename != null;
}

function toBuffer(content: ArrayBuffer | Uint8Array | string): Buffer {
  if (typeof content === "string") return Buffer.from(content, "binary");
  if (content instanceof Uint8Array) return Buffer.from(content);
  return Buffer.from(new Uint8Array(content));
}

/** Lowercased type without parameters, or null. */
function normalizeDeclared(value: string | null | undefined): string | null {
  if (!value) return null;
  const base = value.split(";")[0]?.trim().toLowerCase();
  return base && base.length > 0 ? base : null;
}

/** Trim to a ceiling and drop control characters; never throws on odd input. */
function bounded(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  const clean = String(value)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .trim();
  if (clean.length === 0) return null;
  return clean.length > max ? clean.slice(0, max) : clean;
}

type MaybeAddress = { address?: string; name?: string } | undefined;

function addressOf(from: MaybeAddress): string | null {
  return bounded(from?.address, 320);
}

function nameOf(from: MaybeAddress): string | null {
  return bounded(from?.name, 255);
}
