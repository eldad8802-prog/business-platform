import type { DocumentNeedsReviewRaw } from "../loaders";
import type { BusinessStatusItemBuild } from "../types";

/**
 * The review BACKLOG as one fact.
 *
 * NOT PART OF THE ATTENTION SNAPSHOT. `getBusinessStatusSnapshot` does not call
 * this and must not: Attention already speaks about the backlog through the
 * paperwork insight, and a second card saying the same thing in different words
 * is how one surface starts contradicting another. This exists so the
 * notification layer can reuse the domain's vocabulary — the same category, the
 * same severity language, the same shape the policy already understands —
 * instead of inventing a parallel one.
 *
 * WHY THE QUEUE AND NOT EACH DOCUMENT
 *
 * `needs_review` is the normal terminal state of a successful ingestion, not an
 * exception, and six of the seven production paths that create it are started
 * by the owner. Telling them once per document would mean a twenty-file import
 * filling the whole notification centre with an account of what they had just
 * done. What they cannot see for themselves is the SIZE of the backlog, and
 * that a document arrived from WhatsApp while they were away. One line answers
 * both.
 *
 * The identity is therefore the business's queue, not any document in it: one
 * row, however many documents are waiting.
 */
export function translateDocumentsReviewQueue(input: {
  businessId: number;
  pendingCount: number;
  href: string;
  now: Date;
}): BusinessStatusItemBuild {
  return {
    itemId: `documents:review_queue:${input.businessId}`,
    domain: "documents",
    semanticCategory: "ACTION_REQUIRED",
    title: `${input.pendingCount} מסמכים ממתינים לבדיקה`,
    // Trust contract (F-22A), same as the per-document card below: the
    // extraction is a proposal the system has NOT verified, so the summary says
    // what the owner has to do, never what we think the documents say.
    summary: "חילוץ ראשוני בוצע — צריך אישור שלך כדי שייכנסו לדוחות",
    severity: "MEDIUM",
    entityRef: { type: "documents_review_queue", id: input.businessId },
    state: "open",
    createdAt: input.now.toISOString(),
    primaryAction: {
      kind: "navigate",
      label: "הצג מסמכים ממתינים",
      href: input.href,
    },
    sourceEngine: "documents-review-queue",
    blocking: false,
    // A standing backlog has no single moment it began, and the only consumer
    // of this item is the notification writer, which reads the identity and the
    // render payload and never the priority score. Attention's sort — the one
    // thing that score is for — never sees this item.
    priorityReferenceDate: input.now,
  };
}

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
