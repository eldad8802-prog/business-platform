/**
 * Pure mapping from a document's stored allocation state (the document API's
 * `authorityState`) to what the document screen shows — on every load, not only
 * in the moment after issuing.
 *
 * Rules the wording keeps:
 *   - "ready to share" only when the delivery rule says the final PDF may be delivered;
 *   - "allocation received" only when a number is stored;
 *   - "sent to the authority" only when a request was actually sent (SUBMITTED or later);
 *   - never "try again": the product has no retry path for an allocation request.
 *
 * No I/O, no Prisma import (it runs in the browser). The state's codes come from
 * lib/services/billing/authority/billing-authority-document-state.ts.
 */

/** Client copy of the serialized server state — strings only. */
export type AuthorityDocumentStateView = {
  submissionStatus: string | null;
  deliverable: boolean;
  reason: string;
  outcomeUncertain: boolean;
  failedNotSent: boolean;
  heldDecisionType: string | null;
  heldDecisionReported: boolean;
  allocationNumber: string | null;
};

export type AuthorityDocumentStateDisplay = {
  /** False when there is nothing to say (no allocation involved, deliverable). */
  show: boolean;
  deliverable: boolean;
  tone: "success" | "info" | "warning" | "danger";
  title: string;
  detail: string;
};

const BLOCKED_TAIL = "לכן לא ניתן כעת למסור, לשתף או להוריד את החשבונית הסופית.";

/**
 * `state` null/undefined (a draft, or an API without the field) → nothing shown and
 * deliverable stays as the caller already treats it.
 */
export function describeAuthorityDocumentState(
  state: AuthorityDocumentStateView | null | undefined
): AuthorityDocumentStateDisplay {
  const hidden: AuthorityDocumentStateDisplay = { show: false, deliverable: true, tone: "info", title: "", detail: "" };
  if (!state) return hidden;

  const blocked = (tone: AuthorityDocumentStateDisplay["tone"], title: string, detail: string): AuthorityDocumentStateDisplay => ({
    show: true,
    deliverable: false,
    tone,
    title,
    detail: `${detail} ${BLOCKED_TAIL}`,
  });

  switch (state.submissionStatus) {
    case null:
    case "NOT_REQUIRED":
      return state.deliverable
        ? hidden
        : blocked("danger", "החשבונית הונפקה — מצב ההקצאה חסר", "לחשבונית שחייבת מספר הקצאה לא נמצא רישום של בקשת הקצאה.");
    case "APPROVED":
      return state.deliverable && state.allocationNumber
        ? { show: true, deliverable: true, tone: "success", title: "התקבל מספר הקצאה", detail: `מספר הקצאה: ${state.allocationNumber}` }
        : blocked("danger", "החשבונית הונפקה — מספר ההקצאה חסר", "הבקשה אושרה, אך מספר הקצאה תקין לא נשמר בחשבונית.");
    case "READY":
      return blocked("warning", "החשבונית הונפקה — בקשת ההקצאה לא נשלחה", "החשבונית חייבת מספר הקצאה מרשות המסים, והבקשה לא נשלחה.");
    case "PENDING":
    case "SUBMITTED":
      return state.outcomeUncertain
        ? blocked("danger", "החשבונית הונפקה — תוצאת בקשת ההקצאה אינה ידועה", "ייתכן שהבקשה הגיעה לרשות המסים. היא לא תישלח שוב אוטומטית, ולא התקבל מספר.")
        : blocked("info", "החשבונית הונפקה — בקשת ההקצאה נשלחה", "הבקשה נשלחה לרשות המסים וממתינה לתשובה.");
    case "FAILED":
      return state.failedNotSent
        ? blocked("danger", "החשבונית הונפקה — בקשת ההקצאה לא נשלחה", "שליחת הבקשה נכשלה לפני שהגיעה לרשות המסים.")
        : blocked("danger", "החשבונית הונפקה — בקשת ההקצאה נכשלה", "לא ידוע אם הבקשה הגיעה לרשות המסים, ולא התקבל מספר.");
    case "HELD":
      return state.deliverable
        ? { show: true, deliverable: true, tone: "info", title: "החשבונית הונפקה ללא מספר הקצאה", detail: "דווחה לרשות המסים החלטה להמשיך ללא מספר הקצאה." }
        : blocked("warning", "החשבונית הונפקה — נדרשת החלטה", "רשות המסים לא הקצתה מספר, ונדרשת החלטה כיצד להמשיך.");
    case "REJECTED":
      return blocked("danger", "החשבונית הונפקה — בקשת ההקצאה נדחתה", "רשות המסים דחתה את בקשת ההקצאה, ולא התקבל מספר.");
    default:
      return state.deliverable ? hidden : blocked("danger", "החשבונית הונפקה — מצב ההקצאה אינו מוכר", "מצב בקשת ההקצאה אינו מוכר.");
  }
}

/**
 * Whether the screen may offer delivery actions (view / download / share) for an
 * issued document. A missing state keeps today's behaviour (true).
 */
export function isDocumentDeliverable(state: AuthorityDocumentStateView | null | undefined): boolean {
  return state ? state.deliverable : true;
}
