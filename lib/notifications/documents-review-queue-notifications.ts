/**
 * The third notification consumer: the document review backlog.
 *
 * Same three layers as the two before it — truth from the domain, the decision
 * from the existing policy, memory in the existing writer — and, like them, it
 * contributes no rule of its own. What is different is the shape of the fact.
 *
 * ONE NOTIFICATION PER BUSINESS, NOT PER DOCUMENT
 *
 * `needs_review` is where a successful ingestion ENDS. It is the working queue,
 * not an exception, and six of the seven production paths that fill it are
 * started by the owner. A per-document identity would mean a twenty-file import
 * producing twenty notifications about an action the owner had just taken, and
 * a cooldown cannot help because each document is a different fact.
 *
 * So the identity is the queue: `documents_review_queue` keyed on the business.
 * Fifty pending documents are one row. Every path — manual upload, bulk import,
 * Gmail, the WhatsApp webhook, a retry, an approval — converges on it.
 *
 * WHY A THRESHOLD, AND WHY THIS ONE
 *
 * A single document the owner uploaded a moment ago is not news to them. A
 * backlog is. The line between the two already exists in this product:
 * `PAPERWORK_PENDING_MIN`, the threshold the Attention paperwork insight uses
 * to decide the same question. It is imported rather than restated, because two
 * numbers meaning "enough paperwork to mention" would eventually be two
 * different numbers.
 *
 * IMMUNE TO THE CAP DEFECT BY CONSTRUCTION
 *
 * The count comes from `countPendingReviewAllTime`, which has no cap, no
 * ranking and no window. There is no partial snapshot to reason from and no
 * absence to misread, which is why this consumer never touches
 * `resolveAbsentNotifications`: it knows the number, so it can simply say
 * whether the condition holds.
 *
 * WHY IT NEVER THROWS
 *
 * The document is committed before this runs. Failing an ingestion or an
 * approval afterwards because a notification could not be written would report
 * a lie to the caller, and on the WhatsApp path would invite Meta to redeliver
 * a document we already stored. Every failure is swallowed and returned as
 * data. Nothing here sends anything: the documents rule grants IN_APP only.
 */
import { PAPERWORK_PENDING_MIN } from "@/lib/business-status/paperwork-insight";
import { finalizeBusinessStatusItem } from "@/lib/business-status/priority";
import { translateDocumentsReviewQueue } from "@/lib/business-status/translators/documents";
import {
  countPendingReviewAllTime,
  listPendingReviewMonths,
  pendingReviewInboxHref,
} from "@/lib/documents/pending-review";

import { buildDedupeKey } from "./notification-policy";
import {
  persistSnapshotNotifications,
  resolveNotificationByDedupeKey,
  type WriteOutcome,
} from "./notification-writer";

/**
 * The one entity type this consumer owns. Documents also produce a per-document
 * fact in Attention (`entityType: "document"`), which this must never touch —
 * different question, different identity, and no producer.
 */
export const DOCUMENTS_REVIEW_QUEUE_SCOPE = {
  domain: "documents",
  entityTypes: ["documents_review_queue"],
} as const;

export type DocumentsQueueSync = {
  ok: boolean;
  /** How many documents are waiting right now. Zero when the sync failed. */
  pendingCount: number;
  /** Written or refreshed, when the backlog is at or above the threshold. */
  written: WriteOutcome[];
  /** 1 when this pass closed the queue notification, otherwise 0. */
  resolved: number;
  /** Present only when the sync failed; the document is unaffected either way. */
  error?: string;
};

/** The queue's identity. Built from the policy so it can only ever be one row. */
function queueDedupeKey(businessId: number): string {
  return buildDedupeKey(businessId, {
    domain: "documents",
    semanticCategory: "ACTION_REQUIRED",
    entityRef: { type: "documents_review_queue", id: businessId },
  });
}

/**
 * Reconcile the review-queue notification with the current backlog.
 *
 * Call AFTER the document transaction has committed, inside a tenant context.
 * It recounts rather than reacting to a delta, so the same call serves an
 * ingestion, an approval, a retry and a failure — the caller does not have to
 * work out which direction the queue moved, or by how much.
 *
 * Safe to call when nothing changed. Above the threshold the writer dedupes on
 * the queue's identity and the cooldown decides whether anything is surfaced
 * again; below it, closing an already-closed notification writes nothing.
 */
export async function syncDocumentsReviewQueueNotification(
  businessId: number,
  now: Date,
): Promise<DocumentsQueueSync> {
  try {
    // The canonical, uncapped selector — the same one the Attention insight and
    // the inbox's own total already agree on.
    const pendingCount = await countPendingReviewAllTime(businessId);

    if (pendingCount < PAPERWORK_PENDING_MIN) {
      // Positive evidence that the backlog is no longer worth mentioning. Note
      // this is a threshold, not zero: the notification says "you have a pile",
      // and four documents is not a pile.
      const closed = await resolveNotificationByDedupeKey(
        businessId,
        queueDedupeKey(businessId),
        now,
      );
      return { ok: true, pendingCount, written: [], resolved: closed ? 1 : 0 };
    }

    // The link has to land where the work actually is: the inbox is
    // month-scoped, so the destination is the newest month still holding
    // pending documents.
    const months = await listPendingReviewMonths(businessId);
    const item = finalizeBusinessStatusItem(
      translateDocumentsReviewQueue({
        businessId,
        pendingCount,
        href: pendingReviewInboxHref(months),
        now,
      }),
    );

    const written = await persistSnapshotNotifications(businessId, [item], now);
    return { ok: true, pendingCount, written, resolved: 0 };
  } catch (error) {
    // Deliberately terminal. The document is committed and correct; the owner's
    // notification is not, and that is the lesser failure to absorb.
    console.error("[notifications] documents review queue sync failed", error);
    return {
      ok: false,
      pendingCount: 0,
      written: [],
      resolved: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
