// Pure, frontend-safe reading of /api/integrations/gmail/scan answers (2026-11-09 B3-b).
//
// The response is untrusted input to the screen (another deployment, a proxy,
// a broken body): every field is checked, unknown ones are dropped, and an
// answer that does not fit one of the known shapes becomes { kind: "error" }.
// Nothing here talks to the network; the screen passes in status + body.

import type { GmailDiscoveryAttachment } from "./scoring";
import { parseRejectedTypeCounts, type RejectedTypeCounts } from "./rejected-types";

export type ScanPageStatus = "complete" | "incomplete" | "stopped_unfinished";

export type ScanAnswer =
  | {
      kind: "page";
      status: ScanPageStatus;
      scannedMessages: number;
      scannedTotal: number;
      capReached: boolean;
      hasMore: boolean;
      nextCursor: string | null;
      retryCursor: string | null;
      attachments: GmailDiscoveryAttachment[];
      attachmentParts: number;
      unsupportedType: number;
      rejectedByType: RejectedTypeCounts | null;
      message: string | null;
    }
  /** Gmail's list call failed: nothing on the page was read. */
  | { kind: "list_failed"; status: "incomplete" | "stopped_unfinished"; retryCursor: string | null; message: string | null }
  /** The Gmail quota budget or the page ceiling: wait, then continue. */
  | { kind: "budget"; retryAfterSeconds: number | null; retryCursor: string | null; message: string | null }
  /** The limiter / budget store is down: the extended scan is closed for now. */
  | { kind: "unavailable"; retryCursor: string | null; message: string | null }
  /** The cursor expired or does not match: start a new scan. */
  | { kind: "cursor_invalid"; message: string | null }
  | { kind: "reconnect"; message: string | null }
  | { kind: "error"; message: string | null };

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const nullableStr = (v: unknown): string | null => (typeof v === "string" ? v : null);
const count = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0);
const cursor = (v: unknown): string | null => (typeof v === "string" && v.length > 0 && v.length <= 4096 ? v : null);
const seconds = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.min(Math.ceil(v), 3600) : null;

/** One attachment from the server, or null when it lacks what import needs. */
export function parseScanAttachment(value: unknown): GmailDiscoveryAttachment | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const a = value as Record<string, unknown>;
  const messageId = str(a.messageId);
  const attachmentId = str(a.attachmentId);
  const mimeType = str(a.mimeType);
  if (!messageId || !attachmentId || !mimeType) return null;
  return {
    messageId,
    attachmentId,
    mimeType,
    filename: nullableStr(a.filename),
    sizeBytes: typeof a.sizeBytes === "number" && Number.isFinite(a.sizeBytes) && a.sizeBytes >= 0 ? a.sizeBytes : null,
    fromEmail: nullableStr(a.fromEmail),
    fromName: nullableStr(a.fromName),
    subject: nullableStr(a.subject),
    sentAt: nullableStr(a.sentAt),
    partId: nullableStr(a.partId),
  };
}

export function parseScanAnswer(httpStatus: number, body: unknown): ScanAnswer {
  const b = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const message = str(b.error);
  const code = b.code;

  if (httpStatus === 409 || b.needsReconnect === true) return { kind: "reconnect", message };
  if (httpStatus === 400 && code === "scan_cursor_invalid") return { kind: "cursor_invalid", message };
  if (httpStatus === 503 && code === "scan_unavailable") return { kind: "unavailable", retryCursor: cursor(b.retryCursor), message };
  if (httpStatus === 429) {
    return { kind: "budget", retryAfterSeconds: seconds(b.retryAfterSeconds) ?? (code === "scan_budget_exhausted" ? 60 : null), retryCursor: cursor(b.retryCursor), message };
  }
  if ((httpStatus === 502 || httpStatus === 503) && (code === "gmail_throttled" || code === "gmail_unavailable")) {
    return {
      kind: "list_failed",
      status: b.status === "stopped_unfinished" ? "stopped_unfinished" : "incomplete",
      retryCursor: b.status === "stopped_unfinished" ? null : cursor(b.retryCursor),
      message,
    };
  }

  if (httpStatus === 200 && Array.isArray(b.attachments)) {
    const status: ScanPageStatus | null =
      b.status === "complete" || b.status === "incomplete" || b.status === "stopped_unfinished"
        ? b.status
        : b.pageComplete === true
          ? "complete"
          : b.pageComplete === false
            ? "incomplete"
            : null;
    if (!status) return { kind: "error", message };
    const attachments = b.attachments.map(parseScanAttachment).filter((x): x is GmailDiscoveryAttachment => x !== null);
    return {
      kind: "page",
      status,
      scannedMessages: count(b.scannedMessages),
      scannedTotal: count(b.scannedTotal),
      capReached: b.capReached === true,
      // Only a complete page can claim there is nothing more; anything else keeps "more" true.
      hasMore: status === "complete" ? b.hasMore === true : true,
      nextCursor: status === "complete" ? cursor(b.nextCursor) : null,
      retryCursor: status === "incomplete" ? cursor(b.retryCursor) : null,
      attachments,
      attachmentParts: count(b.attachmentParts),
      unsupportedType: count(b.unsupportedType),
      rejectedByType: parseRejectedTypeCounts(b.rejectedByType),
      message,
    };
  }

  return { kind: "error", message };
}
