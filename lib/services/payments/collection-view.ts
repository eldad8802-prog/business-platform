/**
 * Pure derivation of a collection's business-facing view state + workspace
 * bucket, from a PaymentRequest using ONLY objective data.
 *
 * v1 truth model (locked):
 *  - Two settlement truths: waiting · verified. Lifecycle labels (failed /
 *    expired / cancelled) are honest states, NOT a third settlement truth.
 *  - "expired" is DERIVED from `expiresAt < now` (there is no expiry sweep and
 *    no due-date). There is NO partial / aging / overdue — those are not
 *    Payments concepts in v1 (partial = Billing per-invoice; aging = Collections).
 */

import type { PaymentRequestRecord } from "./payments.types";

export type CollectionViewState =
  | "waiting"
  | "verified"
  | "failed"
  | "expired"
  | "cancelled";

export type CollectionBucket = "attention" | "active" | "history";

export interface CollectionView {
  state: CollectionViewState;
  bucket: CollectionBucket;
}

/** Statuses that make up the open working set (before derivation). */
export const WORKING_STATUSES = ["PENDING", "FAILED", "EXPIRED"] as const;
/** Statuses that make up the closed history. */
export const HISTORY_STATUSES = ["PAID", "CANCELLED"] as const;

export function deriveCollectionView(
  request: Pick<PaymentRequestRecord, "status" | "expiresAt">,
  now: Date
): CollectionView {
  switch (request.status) {
    case "PAID":
      return { state: "verified", bucket: "history" };
    case "CANCELLED":
      return { state: "cancelled", bucket: "history" };
    case "FAILED":
      return { state: "failed", bucket: "attention" };
    case "EXPIRED":
      return { state: "expired", bucket: "attention" };
    case "PENDING":
    default:
      if (
        request.expiresAt != null &&
        request.expiresAt.getTime() < now.getTime()
      ) {
        // Derived expiry — the link's lifetime has passed. Needs a decision.
        return { state: "expired", bucket: "attention" };
      }
      return { state: "waiting", bucket: "active" };
  }
}
