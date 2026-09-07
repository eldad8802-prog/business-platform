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
