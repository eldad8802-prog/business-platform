// Pure, frontend-safe summary of one Gmail scan — the same numbers on the
// email screen and in the server log, defined once (diagnostics, 2026-11-08).
//
// Every attachment part the scan saw lands in exactly one bucket:
//   attachmentParts = unsupportedType + hidden + possible + recommended
// The buckets come from the unchanged screen scoring (scoring.ts); nothing here
// decides what is shown or importable.

import { scoreAttachment, type GmailDiscoveryAttachment } from "./scoring";

export type GmailScanDiagnostics = {
  /** Messages Gmail returned for the query. */
  scannedMessages: number;
  /** Parts in those messages carrying an attachment id. */
  attachmentParts: number;
  /** Refused by the Documents type allowlist (never sent to the screen). */
  unsupportedType: number;
  /** Score below 20 — returned, not shown. */
  hidden: number;
  /** Score 20–44. */
  possible: number;
  /** Score 45 and above. */
  recommended: number;
};

export type GmailScanOutcome =
  | "no_messages"
  | "no_attachments"
  | "all_filtered"
  | "has_visible";

export function summarizeGmailScan(input: {
  scannedMessages: number;
  attachmentParts: number;
  unsupportedType: number;
  attachments: GmailDiscoveryAttachment[];
}): GmailScanDiagnostics {
  let hidden = 0;
  let possible = 0;
  let recommended = 0;
  for (const attachment of input.attachments) {
    const { bucket } = scoreAttachment(attachment);
    if (bucket === "recommended") recommended += 1;
    else if (bucket === "possible") possible += 1;
    else hidden += 1;
  }
  return {
    scannedMessages: input.scannedMessages,
    attachmentParts: input.attachmentParts,
    unsupportedType: input.unsupportedType,
    hidden,
    possible,
    recommended,
  };
}

export function gmailScanOutcome(d: GmailScanDiagnostics): GmailScanOutcome {
  if (d.scannedMessages === 0) return "no_messages";
  if (d.attachmentParts === 0) return "no_attachments";
  if (d.possible + d.recommended === 0) return "all_filtered";
  return "has_visible";
}
