/**
 * The inbound MIME parsing contract: what may arrive, what may come back, and
 * the exact vocabulary for refusing.
 *
 * # Every value here is a security boundary
 *
 * These are not UI hints and not tuning knobs. A MIME message is attacker-chosen
 * input that reaches us before any authentication has happened — possessing an
 * inbound address is not identity, and anybody who learns one can send. So the
 * limits exist to bound what a stranger can make this process do, and each one
 * is enforced in code that a test can point at.
 *
 * # Syntax, never identity
 *
 * Parsing answers "what is in these bytes". It never answers "who sent this".
 * `From`, `Reply-To`, `Return-Path`, `Message-ID` and every other header are
 * sender-controlled and trivially forged; they are provenance for a human
 * reviewer and may never become authorisation. That decision belongs to the
 * authorised-sender list in the database, evaluated per message, and nothing in
 * this module may be read as having made it.
 */

/**
 * The largest raw RFC822 message accepted, in BYTES.
 *
 * Matched to what AWS SES will write to object storage for an inbound message,
 * so the parser refuses exactly what the transport would have refused rather
 * than inventing a second, quieter ceiling. Checked against a byte length, never
 * a string length: one emoji in a subject is four bytes and one character, and a
 * limit that counts characters is a limit an attacker picks the encoding for.
 */
export const MAX_RAW_MESSAGE_BYTES = 40 * 1024 * 1024;

/**
 * The most MIME parts a message may declare.
 *
 * A message with thousands of empty parts costs nothing to write and a great
 * deal to walk. See `inbound-mime-prescan.ts` for what this is measured against
 * and, importantly, what that measurement can and cannot promise.
 */
export const MAX_MIME_PARTS = 200;

/**
 * The deepest multipart nesting accepted.
 *
 * Enforced by the parser itself rather than by anything here: postal-mime takes
 * `maxNestingDepth` and throws when the input exceeds it. That matters, because
 * a limit the real parser applies during its own descent cannot be walked around
 * by a structure a pre-scan failed to model.
 */
export const MAX_MIME_DEPTH = 10;

/** The most attachment candidates one message may yield. */
export const MAX_ATTACHMENTS = 10;

/**
 * The most DECODED attachment bytes one message may produce, summed.
 *
 * Separate from the raw limit because base64 is not the only encoding and a
 * message can decode to more than it weighed. Cumulative rather than per-file,
 * because ten files just under a per-file ceiling is the same memory as one file
 * far over it.
 */
export const MAX_DECODED_BYTES = 40 * 1024 * 1024;

/** The longest filename retained, in UTF-16 code units, after sanitising. */
export const MAX_FILENAME_LENGTH = 255;

/**
 * The longest subject retained.
 *
 * Subject is optional provenance under the accepted contract, so it is bounded
 * rather than refused: a 2MB subject line is not a reason to drop an invoice,
 * and it is not a reason to carry 2MB of attacker text either.
 */
export const MAX_SUBJECT_LENGTH = 512;

/**
 * Why a whole message was refused.
 *
 * Fatal codes mean no attachment from this message may be used, because the
 * thing that failed is a property of the message rather than of one file.
 */
export type InboundMimeFatalCode =
  | "RAW_MESSAGE_TOO_LARGE"
  | "RAW_MESSAGE_EMPTY"
  | "MIME_TOO_MANY_PARTS"
  | "MIME_TOO_DEEP"
  | "MIME_MALFORMED";

/**
 * Why one attachment candidate was refused while the message stood.
 *
 * Deliberately per-attachment. A supplier's invoice arriving beside a corporate
 * signature image, a tracking pixel and an unsupported calendar invite is the
 * normal shape of real mail, and refusing the message would refuse the product's
 * main use case in order to avoid a file nobody asked for.
 *
 * The signature codes are prefixed rather than flattened so the reason a file
 * was refused on its CONTENTS stays distinguishable from the reason it was
 * refused on its size or its count.
 */
export type InboundMimeAttachmentRejectionCode =
  | "TOO_MANY_ATTACHMENTS"
  | "DECODED_BYTES_TOO_LARGE"
  | "NOT_AN_ATTACHMENT_CANDIDATE"
  | "EMPTY_FILE"
  | "TOO_LARGE"
  | "UNSUPPORTED_TYPE"
  | "HEIC_UNSUPPORTED"
  | "SIGNATURE_EMPTY"
  | "SIGNATURE_UNRECOGNISED"
  | "SIGNATURE_MISMATCH";

/** One attachment that survived every check, with the bytes it survived on. */
export type ParsedInboundAttachment = {
  /** Position among the accepted candidates, zero-based and stable. */
  index: number;
  /**
   * The sender's filename after sanitising, or null when nothing usable
   * survived. PROVENANCE ONLY. It is displayed and recorded; it never becomes a
   * path, an object key or any part of one.
   */
  filename: string | null;
  /** What the part CLAIMED to be. Kept only so a mismatch can be explained. */
  declaredContentType: string | null;
  /** What the BYTES actually are. This is the answer that counts. */
  verifiedContainer: "pdf" | "jpeg" | "png";
  /** The decoded bytes. */
  content: Buffer;
  decodedSize: number;
  /** SHA-256, lowercase hex, over `content` and nothing else. */
  contentHashSha256: string;
};

/** One candidate that was refused, described without carrying its content. */
export type RejectedInboundAttachment = {
  index: number;
  filename: string | null;
  declaredContentType: string | null;
  reason: InboundMimeAttachmentRejectionCode;
};

/**
 * The normalized result.
 *
 * # What is NOT here, and why
 *
 * No body text, no HTML, no header map, no Reply-To, no Return-Path, no
 * Received chain. The product of this pipeline is a DOCUMENT; Dubiz is not
 * becoming a mailbox, and every field carried here is personal data that some
 * later erasure has to answer for. The parser reads the body internally — it has
 * to, to find the parts — and then does not hand it on.
 *
 * `nestedMessageCount` is a COUNT, not content: forwarded mail is the product's
 * main use case, so knowing a message contained another one is useful, while
 * automatically promoting the inner message's files to Documents is a decision
 * nobody has made yet.
 */
export type ParsedInboundMime = {
  messageIdHeader: string | null;
  subject: string | null;
  fromAddress: string | null;
  fromName: string | null;
  date: string | null;
  attachments: ParsedInboundAttachment[];
  rejected: RejectedInboundAttachment[];
  nestedMessageCount: number;
};

export type InboundMimeResult =
  | { ok: true; message: ParsedInboundMime }
  | { ok: false; code: InboundMimeFatalCode };
