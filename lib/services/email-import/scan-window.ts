// Pure, frontend-safe search windows for the extended Gmail scan (2026-11-09 B3-a).
//
// The client picks one of three windows; the server alone turns it into a
// Gmail query. No free-text query ever comes from the client, so a request can
// change how far back the scan looks, never what it searches for.

export const GMAIL_SCAN_WINDOWS = [30, 90, 365] as const;
export type GmailScanWindow = (typeof GMAIL_SCAN_WINDOWS)[number];

/** What the legacy scan has always searched. */
export const DEFAULT_GMAIL_SCAN_WINDOW: GmailScanWindow = 30;

/**
 * The window a request asked for. Absent or empty → the default. Anything
 * other than the exact strings "30", "90", "365" is refused ("invalid") —
 * never rounded, clamped or parsed loosely ("30.0", " 90", "0x1e" are all
 * invalid).
 */
export function parseGmailScanWindow(raw: string | null | undefined): GmailScanWindow | "invalid" {
  if (raw == null || raw === "") return DEFAULT_GMAIL_SCAN_WINDOW;
  for (const w of GMAIL_SCAN_WINDOWS) {
    if (raw === String(w)) return w;
  }
  return "invalid";
}

export function isGmailScanWindow(value: unknown): value is GmailScanWindow {
  return GMAIL_SCAN_WINDOWS.some((w) => w === value);
}

/** The only Gmail query the extended scan sends. */
export function gmailScanQuery(window: GmailScanWindow): string {
  return `has:attachment newer_than:${window}d`;
}
