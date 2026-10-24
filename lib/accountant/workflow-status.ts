/**
 * The monthly workflow's status rules — pure.
 *
 * PERIOD STATUS (what the owner sees)
 *   NEEDS_ATTENTION      the package exists or could exist, but something is open (D2: it may still be sent
 *                        after an explicit "send anyway").
 *   PREPARING            first evaluation in progress (only before anything was ever built).
 *   PREPARATION_FAILED   the current data could not be packaged (a build failed).
 *   READY_FOR_REVIEW     a package of the current data exists and nothing is open — waiting for the owner.
 *   SENDING              an approved send is waiting or in progress.
 *   SENT                 the email provider ACCEPTED the message (D5: accepted is not delivered — the
 *                        delivery row carries DELIVERED / BOUNCED separately). Ordinary reminders stop.
 *   SEND_FAILED          the last approved send failed or bounced and nothing newer was sent.
 *   COMPLETED_MANUALLY   the owner said they sent it outside Dubiz (owner-reported, labelled as such).
 *
 * CHANGED SINCE SENT
 *   After a send (or a manual completion), the period keeps its status and `changedSinceSent` turns on
 *   when the current content fingerprint differs from the one that was sent. A revised version is then
 *   built for review; nothing is ever re-sent without a fresh approval.
 */

export type PeriodStatus =
  | "NEEDS_ATTENTION"
  | "PREPARING"
  | "PREPARATION_FAILED"
  | "READY_FOR_REVIEW"
  | "SENDING"
  | "SENT"
  | "SEND_FAILED"
  | "COMPLETED_MANUALLY";

export type DeliveryStatus = "APPROVED" | "SENDING" | "ACCEPTED" | "DELIVERED" | "FAILED" | "BOUNCED" | "CANCELED";

export const IN_FLIGHT_DELIVERY: ReadonlySet<DeliveryStatus> = new Set(["APPROVED", "SENDING"]);
export const SUCCESSFUL_DELIVERY: ReadonlySet<DeliveryStatus> = new Set(["ACCEPTED", "DELIVERED"]);
export const FAILED_DELIVERY: ReadonlySet<DeliveryStatus> = new Set(["FAILED", "BOUNCED"]);

export type StatusInputs = {
  readiness: "READY" | "NEEDS_ATTENTION";
  /** The newest build attempt for the current fingerprint failed and no READY package matches it. */
  currentBuildFailed: boolean;
  /** A READY package exists for the current fingerprint. */
  currentPackageReady: boolean;
  /** The newest delivery that was not CANCELED, if any. */
  latestDelivery: { status: DeliveryStatus } | null;
  completedManually: boolean;
};

export function derivePeriodStatus(i: StatusInputs): PeriodStatus {
  const d = i.latestDelivery?.status ?? null;
  if (d && IN_FLIGHT_DELIVERY.has(d)) return "SENDING";
  if (d && SUCCESSFUL_DELIVERY.has(d)) return "SENT";
  if (i.completedManually) return "COMPLETED_MANUALLY";
  if (d && FAILED_DELIVERY.has(d)) return "SEND_FAILED";
  if (i.currentBuildFailed) return "PREPARATION_FAILED";
  if (!i.currentPackageReady) return "PREPARING";
  return i.readiness === "READY" ? "READY_FOR_REVIEW" : "NEEDS_ATTENTION";
}

/** Statuses in which the owner still has to act (the reminder policy applies to these only). */
export const OWNER_ACTION_STATUSES: ReadonlySet<PeriodStatus> = new Set([
  "NEEDS_ATTENTION",
  "READY_FOR_REVIEW",
  "PREPARATION_FAILED",
  "SEND_FAILED",
]);

export function isCompleted(status: PeriodStatus): boolean {
  return status === "SENT" || status === "COMPLETED_MANUALLY";
}

/** Hebrew label of a period status for the owner's screens. */
export function periodStatusLabelHe(status: PeriodStatus, changedSinceSent: boolean): string {
  if (isCompleted(status) && changedSinceSent) return "עודכן אחרי השליחה — יש גרסה חדשה לבדיקה";
  switch (status) {
    case "NEEDS_ATTENTION":
      return "יש פריטים פתוחים";
    case "PREPARING":
      return "בהכנה";
    case "PREPARATION_FAILED":
      return "ההכנה נכשלה";
    case "READY_FOR_REVIEW":
      return "מוכן לבדיקה ולשליחה";
    case "SENDING":
      return "בשליחה";
    case "SENT":
      return "נשלח";
    case "SEND_FAILED":
      return "השליחה נכשלה";
    case "COMPLETED_MANUALLY":
      return "סומן כנשלח על ידך";
  }
}
