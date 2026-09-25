import type { RefundPaymentRequestResult } from "@/lib/services/payments/payment-refund.service";

/**
 * What the owner is told after asking for a refund.
 *
 * The screen used to compare the answer against "SETTLED" — a word the refund
 * API never returns. A refund CardCom completed came back as "REFUNDED", fell
 * through to the last branch, and was announced as a refusal. An owner told
 * that money did not go back may send it again.
 *
 * Two rules keep that from recurring:
 *   - the outcome is typed from the API's own result, so renaming or adding an
 *     outcome there fails the build here instead of drifting silently;
 *   - an outcome this screen does not recognise is NEVER presented as a
 *     refusal. A definite refusal is not an outcome at all: the API raises it
 *     as an error, which the screen shows through its error path.
 */
export type RefundApiOutcome = RefundPaymentRequestResult["outcome"];

const NOTICE: Record<RefundApiOutcome, string> = {
  REFUNDED: "ההחזר בוצע.",
  UNKNOWN: "ההחזר נשלח לחברת הסליקה, והתוצאה עוד לא ידועה. נעדכן כשתתקבל.",
};

export const UNRECOGNISED_REFUND_OUTCOME_NOTICE =
  "לא הצלחנו לקבוע את תוצאת ההחזר. בדקו את מצב התשלום לפני שמנסים שוב.";

export function refundOutcomeNotice(outcome: string | null | undefined): string {
  if (outcome != null && Object.prototype.hasOwnProperty.call(NOTICE, outcome)) {
    return NOTICE[outcome as RefundApiOutcome];
  }
  return UNRECOGNISED_REFUND_OUTCOME_NOTICE;
}
