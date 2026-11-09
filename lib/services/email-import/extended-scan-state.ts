// Pure, frontend-safe state of the extended Gmail scan on the email screen (2026-11-09 B3-b).
//
// The server (/api/integrations/gmail/scan) does the scanning, paging, retries and quota; this
// module only keeps what the screen has been told, so it can be unit-tested without a browser:
//
//   - pages are merged by the stable key (messageId + partId): a retried or repeated page never
//     shows an attachment twice, and an attachment already listed keeps its place;
//   - an answer that is not a complete page NEVER clears what was already found;
//   - `completion` says honestly how far the scan got — "all scanned" only when the server said
//     a complete page had nothing after it;
//   - the next request is decided here: the server's next cursor, or its retry cursor for the
//     SAME page, or nothing (a new scan is needed).
//
// Import statuses are NOT here: they live on the screen, keyed by the same stable key, so a new
// scan, a period change or an error never loses them.

import { gmailAttachmentKey } from "./attachment-key";
import { REJECTED_TYPE_GROUPS, emptyRejectedTypeCounts, type RejectedTypeCounts } from "./rejected-types";
import type { GmailScanWindow } from "./scan-window";
import type { GmailDiscoveryAttachment } from "./scoring";
import type { ScanAnswer } from "./scan-response";

export type ScanCompletion =
  /** Nothing scanned yet. */
  | "none"
  /** A complete page, and the window holds more messages not yet scanned. */
  | "has_more"
  /** Every message in the window was scanned. */
  | "complete"
  /** The 500-message cap: the window may hold more that were NOT checked. */
  | "cap_reached"
  /** The last page was only partly read; the same page can be retried. */
  | "incomplete"
  /** The same page failed repeatedly; the scan stopped unfinished. */
  | "stopped"
  /** Gmail quota budget / page ceiling: continue after a wait. */
  | "budget"
  /** The extended scan is temporarily unavailable (limiter or budget store down). */
  | "unavailable"
  /** The cursor expired (30 minutes) or no longer matches: a new scan is needed. */
  | "expired"
  /** Gmail disconnected: reconnect needed. */
  | "reconnect"
  /** The fallback basic scan (legacy /sync, latest 30 messages only): never "all scanned". */
  | "basic"
  /** Any other failure. */
  | "error";

export type ExtendedScanState = {
  /** The window and account the CURRENT results belong to (null before the first scan). */
  window: GmailScanWindow | null;
  connectionId: number | null;
  items: GmailDiscoveryAttachment[];
  scannedTotal: number;
  pagesComplete: number;
  completion: ScanCompletion;
  /** Continue with this cursor: the next page, or the same page again. Null = a new scan. */
  continueCursor: string | null;
  /** True when continueCursor points at the SAME page (a retry), false for the next page. */
  continueIsRetry: boolean;
  retryAfterSeconds: number | null;
  /** Totals over COMPLETE pages only, so a retried page is never counted twice. */
  attachmentParts: number;
  unsupportedType: number;
  rejectedByType: RejectedTypeCounts;
  serverMessage: string | null;
};

export function initialScanState(): ExtendedScanState {
  return {
    window: null,
    connectionId: null,
    items: [],
    scannedTotal: 0,
    pagesComplete: 0,
    completion: "none",
    continueCursor: null,
    continueIsRetry: false,
    retryAfterSeconds: null,
    attachmentParts: 0,
    unsupportedType: 0,
    rejectedByType: emptyRejectedTypeCounts(),
    serverMessage: null,
  };
}

/** A brand-new scan (first page of `window` on `connectionId`): the list starts empty. */
export function startScan(window: GmailScanWindow, connectionId: number | null): ExtendedScanState {
  return { ...initialScanState(), window, connectionId };
}

/** Append attachments not already listed (by stable key); existing ones keep their place. */
export function mergeAttachments(
  current: GmailDiscoveryAttachment[],
  incoming: GmailDiscoveryAttachment[]
): GmailDiscoveryAttachment[] {
  const seen = new Set(current.map((a) => gmailAttachmentKey(a)));
  const out = current.slice();
  for (const a of incoming) {
    const key = gmailAttachmentKey(a);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

/** Fold one server answer into the state. Results already found are never removed here. */
export function applyScanAnswer(state: ExtendedScanState, answer: ScanAnswer): ExtendedScanState {
  const base = { ...state, retryAfterSeconds: null, serverMessage: answer.message };
  switch (answer.kind) {
    case "page": {
      const items = mergeAttachments(state.items, answer.attachments);
      if (answer.status === "complete") {
        const rejectedByType = { ...state.rejectedByType };
        if (answer.rejectedByType) for (const g of REJECTED_TYPE_GROUPS) rejectedByType[g] += answer.rejectedByType[g];
        const completion: ScanCompletion = answer.capReached
          ? "cap_reached"
          : answer.nextCursor
            ? "has_more"
            : answer.hasMore
              ? "error" // "more" with no way to continue: never shown as finished
              : "complete";
        return {
          ...base,
          items,
          scannedTotal: Math.max(state.scannedTotal, answer.scannedTotal),
          pagesComplete: state.pagesComplete + 1,
          completion,
          continueCursor: completion === "has_more" ? answer.nextCursor : null,
          continueIsRetry: false,
          attachmentParts: state.attachmentParts + answer.attachmentParts,
          unsupportedType: state.unsupportedType + answer.unsupportedType,
          rejectedByType,
        };
      }
      // Partial page: keep what arrived (deduplicated), do not count it, retry the SAME page.
      const stopped = answer.status === "stopped_unfinished" || !answer.retryCursor;
      return {
        ...base,
        items,
        completion: stopped ? "stopped" : "incomplete",
        continueCursor: stopped ? null : answer.retryCursor,
        continueIsRetry: !stopped,
      };
    }
    case "list_failed": {
      const stopped = answer.status === "stopped_unfinished" || !answer.retryCursor;
      return {
        ...base,
        completion: stopped ? "stopped" : "incomplete",
        continueCursor: stopped ? null : answer.retryCursor,
        continueIsRetry: !stopped,
      };
    }
    case "budget":
      // The same page later: the server's cursor when it sent one, else whatever we were about to send.
      return {
        ...base,
        completion: "budget",
        continueCursor: answer.retryCursor ?? state.continueCursor,
        continueIsRetry: answer.retryCursor ? true : state.continueIsRetry,
        retryAfterSeconds: answer.retryAfterSeconds,
      };
    case "unavailable":
      return { ...base, completion: "unavailable", continueCursor: answer.retryCursor ?? state.continueCursor };
    case "cursor_invalid":
      return { ...base, completion: "expired", continueCursor: null, continueIsRetry: false };
    case "reconnect":
      return { ...base, completion: "reconnect", continueCursor: null, continueIsRetry: false };
    case "error":
    default:
      return { ...base, completion: "error" };
  }
}

/**
 * The fallback basic scan (legacy /sync, offered only while the extended scan is unavailable):
 * merged like any page, but it covers only the latest messages, so it is never "complete" and
 * offers no continuation.
 */
export function applyBasicScan(
  state: ExtendedScanState,
  result: { scannedMessages: number; attachmentParts: number; unsupportedType: number; attachments: GmailDiscoveryAttachment[] }
): ExtendedScanState {
  return {
    ...state,
    items: mergeAttachments(state.items, result.attachments),
    scannedTotal: Math.max(state.scannedTotal, result.scannedMessages),
    attachmentParts: Math.max(state.attachmentParts, result.attachmentParts),
    unsupportedType: Math.max(state.unsupportedType, result.unsupportedType),
    completion: "basic",
    continueCursor: null,
    continueIsRetry: false,
    retryAfterSeconds: null,
    serverMessage: null,
  };
}

/** A network failure (no answer at all): keep everything, allow trying the same request again. */
export function applyNetworkFailure(state: ExtendedScanState): ExtendedScanState {
  return { ...state, completion: "error", retryAfterSeconds: null, serverMessage: null };
}

/** True only when the server confirmed every message in the window was scanned. */
export function isScanFinished(state: ExtendedScanState): boolean {
  return state.completion === "complete";
}

/**
 * What the screen may offer next. `importing` blocks everything that would change the list
 * (owner decision 2026-11-09: no load-more, rescan, period or account change during an import).
 */
export function scanActions(state: ExtendedScanState, importing: boolean): {
  canLoadMore: boolean;
  canRetrySamePage: boolean;
  canStartNew: boolean;
  canOfferBasicScan: boolean;
} {
  const resumable = state.continueCursor !== null;
  return {
    canLoadMore: !importing && state.completion === "has_more" && resumable,
    canRetrySamePage:
      !importing &&
      resumable &&
      (state.completion === "incomplete" || state.completion === "budget" || state.completion === "unavailable" || state.completion === "error"),
    canStartNew: !importing,
    canOfferBasicScan: !importing && state.completion === "unavailable",
  };
}

/** A new scan with these settings would clear a long list: ask first (more than 50 attachments). */
export const CONFIRM_CLEAR_ABOVE = 50;
export function needsClearConfirmation(state: ExtendedScanState): boolean {
  return state.items.length > CONFIRM_CLEAR_ABOVE;
}

/** The results on screen belong to another window or account than the one now selected. */
export function resultsAreStale(
  state: ExtendedScanState,
  selected: { window: GmailScanWindow; connectionId: number | null }
): boolean {
  if (state.window === null) return false;
  return state.window !== selected.window || (state.connectionId ?? null) !== (selected.connectionId ?? null);
}
