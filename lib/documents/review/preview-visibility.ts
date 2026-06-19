import type { ReviewState } from "./types";

/**
 * Source-file preview gating for the document Review screen.
 *
 * Background (the bug this fixes):
 * The Review page only ever sets `state` to "decision" (initial) or "done"
 * (after approval). The previous gate `state !== "done" && state !== "decision"`
 * was therefore *always false* in practice, so the original file was never
 * fetched and the user always saw the "source not available" fallback while
 * approving OCR-extracted data blindly. The source document backs verification
 * in every interactive state — only the terminal "done" screen has no preview.
 */
export function shouldLoadDocumentPreview(state: ReviewState): boolean {
  return state !== "done";
}

export type PreviewFileStatus = "idle" | "loading" | "ready" | "missing";

export type PreviewKind = "pdf" | "image" | "unsupported";

/** What the preview surface should render right now. */
export type PreviewView = "loading" | "fallback" | "pdf" | "image";

/**
 * Pure decision for the preview surface. Keeps the "loading vs. fallback"
 * distinction explicit so the fallback only appears when the file genuinely
 * could not be shown — never while a fetch is still in flight.
 */
export function resolvePreviewView(input: {
  fileStatus: PreviewFileStatus;
  previewKind: PreviewKind;
  fileBlobUrl: string | null;
  previewFailed: boolean;
}): PreviewView {
  const { fileStatus, previewKind, fileBlobUrl, previewFailed } = input;

  // A render error (iframe/img onError) only fires after a blob was attempted.
  if (previewFailed) return "fallback";

  // No source file on storage for this document.
  if (fileStatus === "missing") return "fallback";

  // Still trying — show the attempt, do not flash the fallback.
  if (fileStatus === "idle" || fileStatus === "loading") return "loading";

  // fileStatus === "ready"
  if (!fileBlobUrl) return "fallback";
  if (previewKind === "pdf") return "pdf";
  if (previewKind === "image") return "image";

  // Loaded but not a renderable type (e.g. unknown mime).
  return "fallback";
}
