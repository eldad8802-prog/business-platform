/**
 * Gmail's message part tree, and how an attachment is found inside it.
 *
 * # Why this is its own module
 *
 * Two callers need the same walk: discovery, which lists what the owner could
 * import, and import, which must resolve the type of the one attachment being
 * imported. A mail message nests — `multipart/mixed` containing
 * `multipart/alternative` containing the parts that actually carry files — so
 * "find the attachment" is a recursion, and two copies of a recursion is two
 * chances to disagree about what an attachment is.
 *
 * # What Gmail actually gives us
 *
 * A part carries its own `mimeType`, its `filename`, and — when it is an
 * attachment rather than inline text — an `attachmentId` under `body`. The id
 * is what the attachment-download endpoint takes, so an id and a declared type
 * arrive together from the SAME server-side structure. That is the whole point:
 * the type does not have to come back through the browser to be known.
 */

import { GMAIL_ROOT_PART_ID } from "@/lib/services/email-import/attachment-key";

export type GmailMessagePart = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { attachmentId?: string; size?: number };
  parts?: GmailMessagePart[];
};

export type GmailMessageResponse = {
  id: string;
  threadId?: string;
  internalDate?: string;
  payload?: GmailMessagePart;
};

/**
 * Every part in the tree that carries a downloadable attachment.
 *
 * Depth-first through `parts`, so a file nested inside two levels of multipart
 * is found exactly like one at the top.
 */
export function collectAttachmentParts(
  part: GmailMessagePart | undefined,
  acc: GmailMessagePart[] = []
): GmailMessagePart[] {
  if (!part) return acc;

  const filename = String(part.filename || "");
  const attachmentId = part.body?.attachmentId;
  const mimeType = String(part.mimeType || "");

  if (attachmentId && (filename.length > 0 || mimeType)) {
    acc.push(part);
  }

  for (const p of part.parts || []) {
    collectAttachmentParts(p, acc);
  }

  return acc;
}

/**
 * The one part carrying this attachment id, or null.
 *
 * Returns null when the id appears more than once. Gmail allocates an
 * attachment id per part, so a repeat would mean the message does not identify
 * the file unambiguously — and guessing which part was meant is exactly the
 * kind of assumption that puts the wrong type on a stored document. Refusing is
 * both rarer and safer than choosing.
 *
 * Two parts sharing a FILENAME is ordinary and fine; they have distinct ids.
 */
export function findAttachmentPart(
  payload: GmailMessagePart | undefined,
  attachmentId: string
): GmailMessagePart | null {
  const matches = collectAttachmentParts(payload).filter(
    (p) => p.body?.attachmentId === attachmentId
  );
  if (matches.length !== 1) return null;
  return matches[0];
}

/** What the owner picked, as discovery reported it. */
export type AttachmentReference = {
  attachmentId: string;
  partId?: string | null;
  filename?: string | null;
  sizeBytes?: number | null;
};

export type AttachmentResolution =
  | {
      ok: true;
      part: GmailMessagePart;
      /** The id from THIS fetch of the message — the one to download with. */
      attachmentId: string;
      matchedBy: "attachment_id" | "part_id" | "root_part";
    }
  | {
      ok: false;
      reason: "no_part_id" | "part_not_found" | "part_unverifiable" | "part_mismatch";
    };

/**
 * Find the attachment the owner picked inside a fresh fetch of its message.
 *
 * 1. By attachment id, exactly as before (findAttachmentPart, unchanged).
 * 2. Only if that finds nothing, by the part's `partId` — its position in the
 *    message tree — and never by position alone: the part must ALSO carry the
 *    filename and the byte size discovery reported. A missing, repeated or
 *    non-attachment partId, or any disagreement, is refused rather than guessed.
 * 3. partId GMAIL_ROOT_PART_ID names the top-level payload itself — by object,
 *    never by string, so it cannot reach a nested part — and only when that
 *    payload carries the attachment. It needs the filename AND the size, both
 *    agreeing (2026-11-09 B3-a).
 *
 * The fallbacks exist because the attachment id discovery saw is not
 * guaranteed to come back identical when import fetches the message again.
 */
export function resolveAttachmentInMessage(
  payload: GmailMessagePart | undefined,
  ref: AttachmentReference
): AttachmentResolution {
  const byId = findAttachmentPart(payload, ref.attachmentId);
  if (byId?.body?.attachmentId) {
    return { ok: true, part: byId, attachmentId: byId.body.attachmentId, matchedBy: "attachment_id" };
  }

  const partId = ref.partId ?? "";
  if (!partId) return { ok: false, reason: "no_part_id" };

  if (partId === GMAIL_ROOT_PART_ID) return resolveRootPart(payload, ref);

  // The top-level payload is never matched by string: it has no path of its own.
  const matches = collectAttachmentParts(payload).filter((p) => p !== payload && p.partId === partId);
  if (matches.length !== 1) return { ok: false, reason: "part_not_found" };
  const part = matches[0];

  const expectedName = ref.filename ?? "";
  const hasName = expectedName.length > 0;
  const hasSize = typeof ref.sizeBytes === "number";
  if (!hasName && !hasSize) return { ok: false, reason: "part_unverifiable" };
  if (hasName && String(part.filename || "") !== expectedName) {
    return { ok: false, reason: "part_mismatch" };
  }
  if (hasSize && part.body?.size !== ref.sizeBytes) {
    return { ok: false, reason: "part_mismatch" };
  }

  // collectAttachmentParts only returns parts that carry an attachment id.
  return { ok: true, part, attachmentId: String(part.body?.attachmentId), matchedBy: "part_id" };
}

/** Step 3 of resolveAttachmentInMessage: the message's own top-level payload. */
function resolveRootPart(
  payload: GmailMessagePart | undefined,
  ref: AttachmentReference
): AttachmentResolution {
  // Not an attachment at the top (the usual multipart message): nothing to name.
  if (!payload || !collectAttachmentParts(payload).includes(payload)) {
    return { ok: false, reason: "part_not_found" };
  }

  const expectedName = ref.filename ?? "";
  if (expectedName.length === 0 || typeof ref.sizeBytes !== "number") {
    return { ok: false, reason: "part_unverifiable" };
  }
  if (String(payload.filename || "") !== expectedName || payload.body?.size !== ref.sizeBytes) {
    return { ok: false, reason: "part_mismatch" };
  }

  return { ok: true, part: payload, attachmentId: String(payload.body?.attachmentId), matchedBy: "root_part" };
}
