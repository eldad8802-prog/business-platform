// Pure, frontend-safe identity of one Gmail attachment (2026-11-09 B3-a).
//
// Gmail's attachment id is NOT stable: two fetches of the same message can
// return different ids for the same part (proven in Production, #1009). A key
// built on it makes the same file look new on every scan. A message is
// immutable once delivered, and a part's partId is its path in that message's
// MIME tree ("1", "2.0.1"), so messageId + partId names the same part on every
// fetch and two different parts of one message never share it.
//
// The one part with no path of its own is the message's top-level payload:
// Gmail reports its partId as "" (or omits it). When that payload IS the
// attachment — a message that is only a file, as scanners and fax gateways
// send — discovery names it GMAIL_ROOT_PART_ID instead of dropping the path.
// The resolver accepts that name for the top-level payload alone.

/** The partId discovery reports for an attachment that is the message's top-level payload. */
export const GMAIL_ROOT_PART_ID = "root";

/**
 * The key one attachment is known by across scans.
 *
 * messageId + partId when the part has a path (the stable case, root included);
 * otherwise messageId + attachmentId — only for a response from an older server
 * that sent no partId, where nothing more stable exists.
 */
export function gmailAttachmentKey(a: {
  messageId: string;
  attachmentId: string;
  partId?: string | null;
}): string {
  const partId = typeof a.partId === "string" ? a.partId : "";
  if (partId.length > 0) return `${a.messageId}:part:${partId}`;
  return `${a.messageId}:${a.attachmentId}`;
}
