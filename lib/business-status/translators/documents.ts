import type { DocumentNeedsReviewRaw } from "../loaders";
import type { BusinessStatusItemBuild } from "../types";

export function translateDocumentsNeedsReview(
  rows: DocumentNeedsReviewRaw[]
): BusinessStatusItemBuild[] {
  return rows.map((d) => {
    // Trust contract (F-22A): these rows are all `needs_review` — the extraction
    // is a proposal the system has NOT verified. We must not present the
    // extracted fields (vendor/amount) as facts here, nor leak the raw internal
    // aggregate confidence score (an internal review-routing signal, e.g. 0.07)
    // into a business-facing card. The detected values live behind the
    // "ביקורת מסמך" CTA, where the review surface shows per-field uncertainty.
    // So the summary states the state, not unverified values.
    return {
      itemId: `documents:needs_review:${d.id}`,
      domain: "documents",
      semanticCategory: "ACTION_REQUIRED",
      title: "מסמך ממתין לביקורת",
      summary: "חילוץ ראשוני — דורש אימות",
      severity: "MEDIUM",
      entityRef: { type: "document", id: d.id },
      state: "open",
      createdAt: d.createdAt.toISOString(),
      primaryAction: {
        kind: "navigate",
        label: "ביקורת מסמך",
        href: `/documents/review/${d.id}`,
      },
      sourceEngine: "documents-inbox",
      blocking: false,
      confidence:
        d.confidenceScore != null && Number.isFinite(d.confidenceScore)
          ? Math.min(1, Math.max(0, d.confidenceScore))
          : undefined,
      priorityReferenceDate: d.createdAt,
    };
  });
}
