import type { DocumentNeedsReviewRaw } from "../loaders";
import type { BusinessStatusItemBuild } from "../types";

export function translateDocumentsNeedsReview(
  rows: DocumentNeedsReviewRaw[]
): BusinessStatusItemBuild[] {
  return rows.map((d) => {
    const vendor = d.vendorName?.trim() || null;
    const summaryParts = [
      vendor ? `ספק: ${vendor}` : null,
      d.amount != null && Number.isFinite(d.amount)
        ? `סכום: ${d.amount}`
        : null,
      d.confidenceScore != null
        ? `ביטחון חילוץ: ${Math.round(d.confidenceScore * 100) / 100}`
        : null,
    ].filter(Boolean);

    return {
      itemId: `documents:needs_review:${d.id}`,
      domain: "documents",
      semanticCategory: "ACTION_REQUIRED",
      title: "מסמך ממתין לביקורת",
      summary: summaryParts.length > 0 ? summaryParts.join(" · ") : null,
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
