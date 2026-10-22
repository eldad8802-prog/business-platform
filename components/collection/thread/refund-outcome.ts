import type { RefundPaymentRequestResult } from "@/lib/services/payments/payment-refund.service";
import { moneyHe } from "@/lib/i18n/messages/areas/money";
import type { Translator } from "@/lib/i18n/translate";

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
  REFUNDED: moneyHe.collection.refund.REFUNDED,
  UNKNOWN: moneyHe.collection.refund.UNKNOWN,
};

export const UNRECOGNISED_REFUND_OUTCOME_NOTICE: string = moneyHe.collection.refund.unrecognised;

/** Hebrew by default (as before); pass the active translator for the interface language. */
export function refundOutcomeNotice(outcome: string | null | undefined, t?: Translator): string {
  if (outcome != null && Object.prototype.hasOwnProperty.call(NOTICE, outcome)) {
    return t ? t(`money.collection.refund.${outcome as RefundApiOutcome}`) : NOTICE[outcome as RefundApiOutcome];
  }
  return t ? t("money.collection.refund.unrecognised") : UNRECOGNISED_REFUND_OUTCOME_NOTICE;
}
