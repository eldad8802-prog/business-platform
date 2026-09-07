/**
 * What Gmail says an attachment IS — asked of Gmail, not of the browser.
 *
 * # The gap this closes
 *
 * The import endpoint used to take the attachment's media type from the request
 * body. That is the browser's claim, and the browser is not a source of truth
 * about someone else's mailbox: changing one field in a request would change
 * how the file was stored, which parser it was handed to, and what the Document
 * row said it was.
 *
 * Gmail already knows. The same message structure that yields an `attachmentId`
 * yields that part's `mimeType`, from Google's servers, over the tenant's own
 * authorised token. So the type is resolved here, server-side, from the id the
 * client asked for.
 *
 * # The trust order this establishes
 *
 *   1. the actual bytes            checked by the canonical signature validator
 *   2. Gmail's part metadata       resolved here
 *   3. anything the client sent    no authority whatsoever
 *
 * Gmail's declared type is a claim too, just a far better sourced one — so it
 * still has to survive the byte check. If Gmail says PDF and the bytes are a
 * JPEG, the import is refused rather than quietly re-typed: silently believing
 * the bytes over the mailbox would hide a real inconsistency.
 */

import { findAttachmentPart, type GmailMessageResponse } from "./gmail-message-parts";

export type GmailAttachmentDescriptor = {
  /** Gmail's declared media type for this part. Never a client value. */
  mimeType: string;
  /** Gmail's filename for the part, when it has one. Display only. */
  filename: string | null;
  /** Gmail's declared size, when present. */
  sizeBytes: number | null;
};

export type GmailAttachmentLookup =
  | { ok: true; descriptor: GmailAttachmentDescriptor }
  /** The message exists but carries no such attachment, or carries it twice. */
  | { ok: false; reason: "ATTACHMENT_NOT_IN_MESSAGE" };

async function gmailFetchJson<T>(url: string, accessToken: string): Promise<T> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Gmail API failed (${res.status}): ${text || res.statusText}`);
  }
  return (await res.json()) as T;
}

/**
 * Resolve `messageId + attachmentId` to Gmail's own description of that part.
 *
 * `format=full` is required: the metadata-only projection omits the part bodies
 * that carry the attachment ids, so there would be nothing to match against.
 *
 * An attachment id that belongs to a different message simply will not be found
 * in this message's tree, which is the same refusal as one that never existed —
 * the client cannot use an id from elsewhere to smuggle in another type.
 */
export async function fetchGmailAttachmentDescriptor(params: {
  accessToken: string;
  messageId: string;
  attachmentId: string;
}): Promise<GmailAttachmentLookup> {
  const url = new URL(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(
      params.messageId
    )}`
  );
  url.searchParams.set("format", "full");

  const message = await gmailFetchJson<GmailMessageResponse>(
    url.toString(),
    params.accessToken
  );

  const part = findAttachmentPart(message.payload, params.attachmentId);
  if (!part) return { ok: false, reason: "ATTACHMENT_NOT_IN_MESSAGE" };

  return {
    ok: true,
    descriptor: {
      // No fallback to a default type. An absent mimeType means Gmail did not
      // say, and inventing one here would recreate the very defect this module
      // exists to remove — it simply fails the allowlist instead.
      mimeType: String(part.mimeType || ""),
      filename: part.filename ? String(part.filename) : null,
      sizeBytes: typeof part.body?.size === "number" ? part.body.size : null,
    },
  };
}
